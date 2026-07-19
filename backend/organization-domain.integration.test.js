import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from './db.js';
import {
  activateOrganizationClaims,
  approveClaim,
  createClaims,
  decideClaim,
  restoreClaimHold
} from './claims.js';
import {
  acceptInvitation,
  assignSeat,
  createAccessRequest,
  createInvitation,
  decideAccessRequest,
  getCapacity,
  listAccessRequests,
  listMembers,
  removeMember,
  setOwnerListingPreference
} from './organizations.js';
import { changeRooftopCapacity, reconcilePendingCapacity } from './capacity-billing.js';
import {
  applyScheduledRooftopRemovals,
  cancelOrganizationRooftopRemoval,
  increaseOrganizationRooftops,
  scheduleOrganizationRooftopRemoval
} from './rooftop-billing.js';
import { linkDealer } from './dealerships.js';
import {
  enforceOrganizationBillingLifecycle,
  organizationCheckoutTarget,
  reconcileOrganizationStripeEvent,
  syncOrganizationSubscription
} from './billing-lifecycle.js';
import { getOrganizationDashboard } from './organization-dashboard.js';
import { acceptOwnershipTransfer, initiateOwnershipTransfer } from './ownership-transfers.js';
import { recoverOrganizationOwner } from './organization-recovery.js';

const skip = process.env.DATABASE_URL ? false : 'no DATABASE_URL - set it to run Postgres integration tests';
const users = {
  owner: { id: 'org-test-owner', name: 'Owner', email: 'owner@example.com', emailVerified: true },
  manager: { id: 'org-test-manager', name: 'Manager', email: 'manager@example.com', emailVerified: true },
  salesperson: { id: 'org-test-sales', name: 'Sales', email: 'sales@example.com', emailVerified: true },
  prepay: { id: 'org-test-prepay', name: 'Prepay Sales', email: 'prepay@example.com', emailVerified: true },
  groupOwner: { id: 'org-test-group-owner', name: 'Group Owner', email: 'group@example.com', emailVerified: true }
};

async function seedUser(user) {
  await pool.query(
    `insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt")
     values ($1,$2,$3,$4,now(),now())`,
    [user.id, user.name, user.email, user.emailVerified]
  );
}

before(async () => {
  if (skip) return;
  await pool.query('truncate table "user", dealerships, "organization", "subscription" cascade');
  for (const user of Object.values(users)) await seedUser(user);
  await pool.query(
    `insert into dealerships (id,name,platform,status,timezone,config) values
      ('org-test-d1','Test Toyota','dealeron','supported','America/New_York','{}'),
      ('org-test-d2','Test Hyundai','dealeron','supported','America/New_York','{}'),
      ('org-test-d3','Test Kia','dealeron','supported','America/New_York','{}'),
      ('org-test-d4','Concurrent Honda','dealeron','supported','America/New_York','{}'),
      ('org-test-d5','Concurrent Mazda','dealeron','supported','America/New_York','{}')`
  );
});

after(async () => {
  if (!skip) await pool.end();
});

test('claim, activation, scoped team access, and serialized seat capacity lifecycle', { skip }, async () => {
  await assert.rejects(
    createClaims(users.owner, {
      dealershipIds: ['org-test-d4'],
      organizationName: 'Invalid Attestation',
      attested: 'true'
    }),
    (error) => error.reason === 'attestation_required'
  );
  const claims = await createClaims(users.owner, {
    dealershipIds: ['org-test-d1', 'org-test-d2'],
    organizationName: 'Test Auto Group',
    attested: true
  });
  assert.equal(claims.length, 2);
  assert.ok(claims.every((claim) => claim.status === 'pending'));
  assert.equal((await pool.query('select count(*)::int as count from organization_rooftops')).rows[0].count, 0);

  const first = await approveClaim(claims[0].id, { actor: 'admin:test', reason: 'verified staff evidence' });
  const second = await approveClaim(claims[1].id, { actor: 'admin:test', reason: 'verified group authority' });
  assert.equal(first.organizationId, second.organizationId);
  const organizationId = first.organizationId;
  assert.equal((await pool.query(
    `select count(*)::int as count from organization_rooftops where organization_id=$1 and status='reserved'`,
    [organizationId]
  )).rows[0].count, 2);
  const checkoutBeforePayment = await organizationCheckoutTarget(users.owner.id, organizationId);
  assert.equal(checkoutBeforePayment.rooftopCount, 2);
  assert.ok(checkoutBeforePayment.reservationExpiresAt instanceof Date);

  // A reserved rooftop is already claimed: employees can queue an access request, but a new
  // personal account cannot claim the same dealership while the organization checks out.
  const prepayRequest = await createAccessRequest(users.prepay, { dealershipId: 'org-test-d1' });
  assert.equal(prepayRequest.status, 'pending');
  await assert.rejects(
    linkDealer(users.prepay.id, 'org-test-d1', pool, { enforceClaims: true }),
    (err) => err.reason === 'dealership_claimed'
  );

  await activateOrganizationClaims(organizationId);
  assert.equal((await pool.query(
    `select count(*)::int as count from organization_rooftops where organization_id=$1 and status='active'`,
    [organizationId]
  )).rows[0].count, 2);
  const checkoutAfterActivation = await organizationCheckoutTarget(users.owner.id, organizationId);
  assert.equal(checkoutAfterActivation.rooftopCount, 2);
  assert.equal(checkoutAfterActivation.reservationExpiresAt, null);

  // Billing recovery can revive a rooftop only while its verified claim remains active.
  await pool.query(
    `update dealership_claims set status='suspended' where id=$1`,
    [claims[1].id]
  );
  await pool.query(
    `update organization_rooftops set status='suspended' where organization_id=$1`,
    [organizationId]
  );
  await activateOrganizationClaims(organizationId);
  const recovered = await pool.query(
    `select dealership_id,status from organization_rooftops where organization_id=$1 order by dealership_id`,
    [organizationId]
  );
  assert.deepEqual(recovered.rows, [
    { dealership_id: 'org-test-d1', status: 'active' },
    { dealership_id: 'org-test-d2', status: 'suspended' }
  ]);
  await pool.query(`update dealership_claims set status='active' where id=$1`, [claims[1].id]);
  await activateOrganizationClaims(organizationId);
  await pool.query(
    `insert into "subscription" (
       id,plan,"referenceId","stripeCustomerId","stripeSubscriptionId",status,"periodStart","periodEnd"
     ) values ($1,'dealership_rooftop',$2,'cus_org_test','sub_org_test','active',now(),now()+interval '1 month')`,
    ['org-test-subscription', organizationId]
  );

  const access = await createAccessRequest(users.salesperson, { dealershipId: 'org-test-d1' });
  const approved = await decideAccessRequest(users.owner.id, organizationId, access.id, { approve: true });
  assert.equal(approved.request.status, 'approved');
  assert.equal((await getCapacity(organizationId, 'org-test-d1')).assigned, 1);

  const managerInvite = await createInvitation(users.owner.id, organizationId, {
    email: users.manager.email,
    role: 'manager',
    dealershipIds: ['org-test-d1'],
    reserveSeat: false
  });
  const managerAccepted = await acceptInvitation(users.manager, managerInvite.token);
  assert.ok(managerAccepted.memberId);

  const d2OnlyUser = {
    id: 'org-test-d2-only',
    name: 'Second Rooftop Sales',
    email: 'd2-only@example.com',
    emailVerified: true
  };
  await seedUser(d2OnlyUser);
  const d2Request = await createAccessRequest(d2OnlyUser, { dealershipId: 'org-test-d2' });
  const d2Approved = await decideAccessRequest(users.owner.id, organizationId, d2Request.id, { approve: true });
  const managerMembers = await listMembers(users.manager.id, organizationId);
  assert.ok(managerMembers.some((member) => member.userId === users.manager.id));
  assert.ok(!managerMembers.some((member) => member.userId === d2OnlyUser.id));
  await pool.query(
    `insert into listings (
       id,owner_id,workspace_id,organization_id,actor_user_id,dealership_id,
       client_key,title,status,sold_source,listed_at,sold_at,views_count,views_observed_at
     ) values
       ($1,$2,$3,$4,$2,'org-test-d1','old-active','Old active','listed',null,
        now()-interval '60 days',null,100,now()),
       ($5,$2,$3,$4,$2,'org-test-d1','old-sold','Old sold','sold','scan',
        now()-interval '60 days',now()-interval '1 day',200,now()),
       ($6,$2,$3,$4,$2,'org-test-d1','new-active','New active','listed',null,
        now()-interval '1 day',null,50,now())`,
    [
      crypto.randomUUID(),
      users.salesperson.id,
      `organization:${organizationId}`,
      organizationId,
      crypto.randomUUID(),
      crypto.randomUUID()
    ]
  );
  const managerDashboard = await getOrganizationDashboard(users.manager.id, organizationId);
  assert.ok(!managerDashboard.members.some((member) => member.memberId === d2Approved.memberId));
  assert.equal(managerDashboard.metrics.listingActions, 1);
  assert.equal(managerDashboard.metrics.currentlyListed, 2);
  assert.equal(managerDashboard.metrics.soldAtDealership, 1);
  assert.equal(managerDashboard.metrics.observedViews, 50);
  assert.equal(managerDashboard.metrics.viewsPerListing, 50);

  const managerCandidate = {
    id: 'org-test-manager-candidate',
    name: 'Manager Candidate',
    email: 'manager-candidate@example.com',
    emailVerified: true
  };
  await seedUser(managerCandidate);
  const managerRequest = await createAccessRequest(managerCandidate, {
    dealershipId: 'org-test-d1',
    requestedRole: 'manager'
  });
  assert.ok((await listAccessRequests(users.owner.id, organizationId)).some((request) => request.id === managerRequest.id));
  assert.ok(!(await listAccessRequests(users.manager.id, organizationId)).some((request) => request.id === managerRequest.id));

  await assert.rejects(
    createInvitation(users.manager.id, organizationId, {
      email: 'another-manager@example.com',
      role: 'manager',
      dealershipIds: ['org-test-d1'],
      reserveSeat: false
    }),
    (err) => err.reason === 'owner_required'
  );
  await assert.rejects(
    createInvitation(users.manager.id, organizationId, {
      email: 'wrong-rooftop@example.com',
      role: 'salesperson',
      dealershipIds: ['org-test-d2'],
      reserveSeat: true
    }),
    (err) => err.reason === 'wrong_rooftop'
  );

  const candidateIds = [];
  for (let i = 0; i < 10; i += 1) {
    const user = {
      id: `org-test-candidate-${i}`,
      name: `Candidate ${i}`,
      email: `candidate-${i}@example.com`,
      emailVerified: true
    };
    await seedUser(user);
    const memberId = crypto.randomUUID();
    candidateIds.push(memberId);
    await pool.query(
      `insert into "member" (id,"organizationId","userId",role,"createdAt") values ($1,$2,$3,'member',now())`,
      [memberId, organizationId, user.id]
    );
    await pool.query(
      `insert into organization_member_profiles
       (member_id,organization_id,user_id,role,status) values ($1,$2,$3,'salesperson','active')`,
      [memberId, organizationId, user.id]
    );
    await pool.query(
      `insert into member_rooftop_access
       (member_id,organization_id,dealership_id,role) values ($1,$2,'org-test-d1','salesperson')`,
      [memberId, organizationId]
    );
  }

  for (const memberId of candidateIds.slice(0, 8)) {
    await assignSeat(users.owner.id, organizationId, 'org-test-d1', memberId);
  }
  assert.equal((await getCapacity(organizationId, 'org-test-d1')).available, 1);
  const race = await Promise.allSettled(candidateIds.slice(8).map((memberId) =>
    assignSeat(users.owner.id, organizationId, 'org-test-d1', memberId)
  ));
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter((result) => result.status === 'rejected' && result.reason.reason === 'no_capacity').length, 1);
  const finalCapacity = await getCapacity(organizationId, 'org-test-d1');
  assert.equal(finalCapacity.assigned, 10);
  assert.equal(finalCapacity.available, 0);

  const waitingUser = {
    id: 'org-test-waiting',
    name: 'Waiting Salesperson',
    email: 'waiting@example.com',
    emailVerified: true
  };
  await seedUser(waitingUser);
  const waitingRequest = await createAccessRequest(waitingUser, { dealershipId: 'org-test-d1' });
  const waitingDecision = await decideAccessRequest(
    users.owner.id,
    organizationId,
    waitingRequest.id,
    { approve: true }
  );
  assert.equal(waitingDecision.request.status, 'approved_awaiting_capacity');

  const stripeCalls = [];
  let extraItem = null;
  let stripePending = false;
  const stripeClient = {
    subscriptions: {
      retrieve: async (id) => {
        stripeCalls.push({ operation: 'retrieve', id });
        return {
          id,
          items: { data: extraItem ? [extraItem] : [] },
          pending_update: stripePending ? { expires_at: Math.floor(Date.now() / 1000) + 3600 } : null
        };
      }
    },
    subscriptionItems: {
      create: async (params) => {
        stripeCalls.push({ operation: 'create', params });
        extraItem = {
          id: 'si_org_test_extra',
          quantity: params.quantity,
          price: { id: params.price }
        };
        return extraItem;
      },
      update: async (id, params) => {
        stripeCalls.push({ operation: 'update', id, params });
        if (!stripePending) extraItem = { ...extraItem, quantity: params.quantity };
        return extraItem;
      },
      del: async () => { throw new Error('unexpected delete'); }
    }
  };
  const capacityChange = await changeRooftopCapacity(
    users.owner.id,
    organizationId,
    'org-test-d1',
    1,
    pool,
    { stripeClient, extraSeatPriceId: 'price_org_test_extra' }
  );
  assert.equal(capacityChange.increased, true);
  assert.equal(capacityChange.pending, false);
  const createCall = stripeCalls.find((call) => call.operation === 'create');
  assert.equal(createCall.params.quantity, 1);
  assert.equal(createCall.params.payment_behavior, 'pending_if_incomplete');
  assert.equal((await pool.query(
    `select status from organization_access_requests where id=$1`,
    [waitingRequest.id]
  )).rows[0].status, 'approved');
  const expandedCapacity = await getCapacity(organizationId, 'org-test-d1');
  assert.equal(expandedCapacity.extraSeats, 1);
  assert.equal(expandedCapacity.assigned, 11);
  assert.equal(expandedCapacity.available, 0);

  const secondWaitingUser = {
    id: 'org-test-waiting-two',
    name: 'Second Waiting Salesperson',
    email: 'waiting-two@example.com',
    emailVerified: true
  };
  await seedUser(secondWaitingUser);
  const secondWaitingRequest = await createAccessRequest(secondWaitingUser, { dealershipId: 'org-test-d1' });
  const secondWaitingDecision = await decideAccessRequest(
    users.owner.id,
    organizationId,
    secondWaitingRequest.id,
    { approve: true }
  );
  assert.equal(secondWaitingDecision.request.status, 'approved_awaiting_capacity');
  await removeMember(users.owner.id, organizationId, candidateIds[0], { reason: 'test removal' });
  assert.equal((await pool.query(
    'select status from organization_access_requests where id=$1',
    [secondWaitingRequest.id]
  )).rows[0].status, 'approved');

  // Removed members retain historical attribution but can be invited back. The new invitation
  // reactivates their existing Better Auth member row instead of creating a duplicate.
  await removeMember(users.owner.id, organizationId, approved.memberId, { reason: 'rehire test' });
  const rehireInvite = await createInvitation(users.owner.id, organizationId, {
    email: users.salesperson.email,
    role: 'salesperson',
    dealershipIds: ['org-test-d1'],
    reserveSeat: true
  });
  const rehire = await acceptInvitation(users.salesperson, rehireInvite.token);
  assert.equal(rehire.memberId, approved.memberId);
  assert.equal((await pool.query(
    'select status from organization_member_profiles where member_id=$1',
    [approved.memberId]
  )).rows[0].status, 'active');
  assert.equal((await pool.query(
    `select count(*)::int as count from seat_assignments
      where member_id=$1 and dealership_id='org-test-d1' and released_at is null`,
    [approved.memberId]
  )).rows[0].count, 1);

  // A failed/incomplete proration remains requested-only. Capacity and waiting users unlock
  // only after a later Stripe subscription payload confirms the aggregate paid quantity.
  stripePending = true;
  const pendingIncrease = await changeRooftopCapacity(
    users.owner.id,
    organizationId,
    'org-test-d1',
    2,
    pool,
    { stripeClient, extraSeatPriceId: 'price_org_test_extra' }
  );
  assert.equal(pendingIncrease.pending, true);
  assert.equal((await getCapacity(organizationId, 'org-test-d1')).extraSeats, 1);
  stripePending = false;
  extraItem = { ...extraItem, quantity: 2 };
  const reconciled = await reconcilePendingCapacity(
    organizationId,
    { id: 'sub_org_test', items: { data: [extraItem] }, pending_update: null },
    pool,
    { extraSeatPriceId: 'price_org_test_extra' }
  );
  assert.equal(reconciled.applied, 1);
  assert.equal((await getCapacity(organizationId, 'org-test-d1')).extraSeats, 2);

  // Claim approval alone never grants another paid rooftop. A webhook carrying the old
  // quantity keeps the new rooftop reserved; only Stripe-confirmed quantity 3 activates it.
  const additionalClaims = await createClaims(users.owner, {
    dealershipIds: ['org-test-d3'],
    organizationId,
    attested: true
  });
  await approveClaim(additionalClaims[0].id, {
    actor: 'admin:test',
    reason: 'verified additional rooftop authority'
  });
  const oldPriceId = process.env.STRIPE_DEALERSHIP_PRICE_ID;
  process.env.STRIPE_DEALERSHIP_PRICE_ID = 'price_org_test_rooftop';
  const stripeSubscription = (quantity, pending = false) => ({
    id: 'sub_org_test',
    pending_update: pending ? { expires_at: Math.floor(Date.now() / 1000) + 3600 } : null,
    latest_invoice: pending ? {
      hosted_invoice_url: 'https://invoice.stripe.test/org-rooftop',
      payment_intent: null
    } : null,
    items: {
      data: [{
        id: 'si_org_test_rooftop',
        quantity,
        price: { id: 'price_org_test_rooftop' }
      }, extraItem]
    }
  });
  const subscriptionRecord = {
    plan: 'dealership_rooftop',
    referenceId: organizationId,
    status: 'active',
    stripeSubscriptionId: 'sub_org_test',
    seats: 2
  };
  let rooftopQuantity = 2;
  let rooftopPending = false;
  const rooftopStripeCalls = [];
  const rooftopStripeClient = {
    subscriptions: {
      retrieve: async () => stripeSubscription(rooftopQuantity, rooftopPending)
    },
    subscriptionItems: {
      update: async (id, params, options) => {
        rooftopStripeCalls.push({ id, params, options });
        rooftopPending = true;
        return { id, quantity: rooftopQuantity, price: { id: 'price_org_test_rooftop' } };
      }
    }
  };
  const rooftopIncrease = await increaseOrganizationRooftops(
    users.owner.id,
    organizationId,
    3,
    pool,
    { stripeClient: rooftopStripeClient, rooftopPriceId: 'price_org_test_rooftop' }
  );
  assert.equal(rooftopIncrease.pending, true);
  assert.equal(rooftopIncrease.url, 'https://invoice.stripe.test/org-rooftop');
  assert.equal(rooftopStripeCalls.length, 1);
  assert.equal(rooftopStripeCalls[0].params.quantity, 3);
  assert.equal(rooftopStripeCalls[0].params.proration_behavior, 'always_invoice');
  assert.equal(rooftopStripeCalls[0].params.payment_behavior, 'pending_if_incomplete');
  assert.match(rooftopStripeCalls[0].options.idempotencyKey, /^carxpert-rooftops-/);
  assert.deepEqual((await pool.query(
    `select c.status as claim_status,r.status as rooftop_status
       from dealership_claims c
       join organization_rooftops r on r.organization_id=c.organization_id
        and r.dealership_id=c.dealership_id
      where c.id=$1`,
    [additionalClaims[0].id]
  )).rows[0], { claim_status: 'checkout_pending', rooftop_status: 'reserved' });

  rooftopQuantity = 3;
  rooftopPending = false;
  await syncOrganizationSubscription({ ...subscriptionRecord, seats: 3 }, {
    stripeSubscription: stripeSubscription(3),
    source: 'stripe:test'
  });
  assert.deepEqual((await pool.query(
    `select c.status as claim_status,r.status as rooftop_status
       from dealership_claims c
       join organization_rooftops r on r.organization_id=c.organization_id
        and r.dealership_id=c.dealership_id
      where c.id=$1`,
    [additionalClaims[0].id]
  )).rows[0], { claim_status: 'active', rooftop_status: 'active' });

  // Better Auth receives webhook snapshots in delivery order, not event creation order. Our
  // top-level onEvent repair must ignore a stale active payload and apply Stripe's current
  // past_due state, then restore the organization when Stripe is active again.
  const stripeEvent = (id) => ({
    id,
    type: 'customer.subscription.updated',
    data: { object: { ...stripeSubscription(3), status: 'active', customer: 'cus_org_test' } }
  });
  await reconcileOrganizationStripeEvent(stripeEvent(`evt_stale_${crypto.randomUUID()}`), {
    db: pool,
    stripeClient: {
      subscriptions: {
        retrieve: async () => ({
          ...stripeSubscription(3),
          status: 'past_due',
          customer: 'cus_org_test'
        })
      }
    }
  });
  assert.equal((await pool.query(
    `select status from organization_profiles where organization_id=$1`,
    [organizationId]
  )).rows[0].status, 'past_due');
  assert.equal((await pool.query(
    `select status from "subscription" where id='org-test-subscription'`
  )).rows[0].status, 'past_due');

  await reconcileOrganizationStripeEvent(stripeEvent(`evt_recovered_${crypto.randomUUID()}`), {
    db: pool,
    stripeClient: {
      subscriptions: {
        retrieve: async () => ({
          ...stripeSubscription(3),
          status: 'active',
          customer: 'cus_org_test'
        })
      }
    }
  });
  assert.equal((await pool.query(
    `select status from organization_profiles where organization_id=$1`,
    [organizationId]
  )).rows[0].status, 'active');
  assert.equal((await pool.query(
    `select status from "subscription" where id='org-test-subscription'`
  )).rows[0].status, 'active');

  // Removing one of several rooftops lowers Stripe's next-renewal quantity immediately with
  // no current-period proration, but the already-paid rooftop remains operational until the
  // subscription period end. The lifecycle worker archives it only after that timestamp.
  let removalQuantity = 3;
  const removalStripeCalls = [];
  const removalStripeClient = {
    subscriptions: {
      retrieve: async () => stripeSubscription(removalQuantity, false)
    },
    subscriptionItems: {
      update: async (id, params, options) => {
        removalStripeCalls.push({ id, params, options });
        removalQuantity = params.quantity;
        return { id, quantity: removalQuantity, price: { id: 'price_org_test_rooftop' } };
      }
    }
  };
  const removal = await scheduleOrganizationRooftopRemoval(
    users.owner.id,
    organizationId,
    'org-test-d3',
    pool,
    { stripeClient: removalStripeClient, rooftopPriceId: 'price_org_test_rooftop' }
  );
  assert.equal(removal.requestedQuantity, 2);
  assert.equal(removalStripeCalls[0].params.proration_behavior, 'none');
  assert.equal((await pool.query(
    `select status from organization_rooftops
      where organization_id=$1 and dealership_id='org-test-d3'`,
    [organizationId]
  )).rows[0].status, 'pending_removal');

  const canceledRemoval = await cancelOrganizationRooftopRemoval(
    users.owner.id,
    organizationId,
    'org-test-d3',
    pool,
    { stripeClient: removalStripeClient, rooftopPriceId: 'price_org_test_rooftop' }
  );
  assert.equal(canceledRemoval.requestedQuantity, 3);
  assert.equal((await pool.query(
    `select status from organization_rooftops
      where organization_id=$1 and dealership_id='org-test-d3'`,
    [organizationId]
  )).rows[0].status, 'active');
  const rescheduledRemoval = await scheduleOrganizationRooftopRemoval(
    users.owner.id,
    organizationId,
    'org-test-d3',
    pool,
    { stripeClient: removalStripeClient, rooftopPriceId: 'price_org_test_rooftop' }
  );

  await syncOrganizationSubscription({ ...subscriptionRecord, seats: 2 }, {
    stripeSubscription: stripeSubscription(2),
    source: 'stripe:test-removal'
  });
  assert.equal((await pool.query(
    `select status from organization_rooftops
      where organization_id=$1 and dealership_id='org-test-d3'`,
    [organizationId]
  )).rows[0].status, 'pending_removal');

  const appliedRemoval = await applyScheduledRooftopRemovals(
    pool,
    new Date(new Date(rescheduledRemoval.effectiveAt).getTime() + 1000)
  );
  assert.equal(appliedRemoval.applied, 1);
  assert.deepEqual((await pool.query(
    `select c.status as claim_status,r.status as rooftop_status
       from dealership_claims c
       join organization_rooftops r on r.organization_id=c.organization_id
        and r.dealership_id=c.dealership_id
      where c.id=$1`,
    [additionalClaims[0].id]
  )).rows[0], { claim_status: 'suspended', rooftop_status: 'archived' });

  // Owners explicitly choose whether they consume included listing seats. The choice persists,
  // applies atomically to every operational rooftop, and can release those seats again without
  // changing Stripe quantity or included capacity.
  const dashboardOnly = await setOwnerListingPreference(users.owner.id, organizationId, { willList: false });
  assert.equal(dashboardOnly.preference, 'dashboard');
  const listingOwner = await setOwnerListingPreference(users.owner.id, organizationId, { willList: true });
  assert.deepEqual(listingOwner.dealershipIds, ['org-test-d1', 'org-test-d2']);
  const repeatedChoice = await setOwnerListingPreference(users.owner.id, organizationId, { willList: true });
  assert.equal(repeatedChoice.changedDealershipIds.length, 0);
  assert.equal((await pool.query(
    `select count(*)::int as count from seat_assignments s
      join "member" m on m.id=s.member_id
     where m."userId"=$1 and s.organization_id=$2 and s.released_at is null`,
    [users.owner.id, organizationId]
  )).rows[0].count, 2);
  const releasedOwner = await setOwnerListingPreference(users.owner.id, organizationId, { willList: false });
  assert.equal(releasedOwner.changedDealershipIds.length, 2);
  assert.equal((await pool.query(
    `select listing_preference from organization_member_profiles
      where organization_id=$1 and user_id=$2`,
    [organizationId, users.owner.id]
  )).rows[0].listing_preference, 'dashboard');

  const ownershipTransfer = await initiateOwnershipTransfer(
    users.owner.id,
    organizationId,
    managerAccepted.memberId,
    { sessionCreatedAt: new Date() }
  );
  const acceptedTransfer = await acceptOwnershipTransfer(users.manager.id, ownershipTransfer.token);
  assert.equal(acceptedTransfer.ownerMemberId, managerAccepted.memberId);
  const ownerProfiles = await pool.query(
    `select mp.member_id,mp.role,mp.all_rooftops,m."userId" as user_id
       from organization_member_profiles mp join "member" m on m.id=mp.member_id
      where mp.organization_id=$1 order by mp.member_id`,
    [organizationId]
  );
  const currentOwner = await pool.query(
    `select primary_owner_member_id from organization_profiles where organization_id=$1`,
    [organizationId]
  );
  assert.equal(currentOwner.rows[0].primary_owner_member_id, managerAccepted.memberId);
  assert.equal((await pool.query(
    `select count(*)::int as count from organization_member_profiles
      where organization_id=$1 and role='owner'`,
    [organizationId]
  )).rows[0].count, 1);
  assert.ok(ownerProfiles.rows.some((profile) => profile.member_id === managerAccepted.memberId && profile.role === 'owner'));
  assert.ok(ownerProfiles.rows.some((profile) =>
    profile.user_id === users.owner.id && profile.role === 'manager' && profile.all_rooftops
  ));
  assert.equal((await pool.query(
    `select listing_preference from organization_member_profiles where member_id=$1`,
    [managerAccepted.memberId]
  )).rows[0].listing_preference, null);

  // A support dispute freezes only the contested rooftop and restores the exact prior state.
  const disputed = await decideClaim(claims[1].id, {
    status: 'disputed',
    actor: 'admin:test',
    reason: 'authority dispute under review'
  });
  assert.equal(disputed.status, 'disputed');
  assert.equal((await pool.query(
    `select status from organization_rooftops
      where organization_id=$1 and dealership_id='org-test-d2'`,
    [organizationId]
  )).rows[0].status, 'suspended');
  const restoredClaim = await restoreClaimHold(claims[1].id, {
    actor: 'admin:test',
    reason: 'dealership authority reverified'
  });
  assert.equal(restoredClaim.status, 'active');
  assert.equal((await pool.query(
    `select status from organization_rooftops
      where organization_id=$1 and dealership_id='org-test-d2'`,
    [organizationId]
  )).rows[0].status, 'active');

  // Break-glass recovery accepts only a verified existing user, suspends the former owner,
  // and resets the recovered owner's listing choice for a fresh explicit decision.
  const recoveredOwner = await recoverOrganizationOwner(organizationId, {
    targetEmail: users.owner.email,
    actor: 'admin:test',
    reason: 'verified recovery after owner account handoff failed'
  });
  assert.equal(recoveredOwner.recovered, true);
  assert.equal(recoveredOwner.ownerUserId, users.owner.id);
  const recoveredProfiles = await pool.query(
    `select user_id,role,status,listing_preference from organization_member_profiles
      where organization_id=$1 and user_id=any($2) order by user_id`,
    [organizationId, [users.owner.id, users.manager.id]]
  );
  assert.ok(recoveredProfiles.rows.some((profile) =>
    profile.user_id === users.owner.id && profile.role === 'owner'
      && profile.status === 'active' && profile.listing_preference === null
  ));
  assert.ok(recoveredProfiles.rows.some((profile) =>
    profile.user_id === users.manager.id && profile.role === 'manager' && profile.status === 'suspended'
  ));

  // End-of-retention archival must release both the rooftop ownership index and the active
  // claim index. Otherwise a future verified organization can never reclaim the dealership.
  await pool.query(
    `update organization_profiles set status='suspended',suspended_at=now()-interval '91 days'
      where organization_id=$1`,
    [organizationId]
  );
  await pool.query(
    `update organization_rooftops set status='pending_removal',removal_effective_at=now()+interval '1 day'
      where organization_id=$1 and dealership_id='org-test-d2'`,
    [organizationId]
  );
  await pool.query(
    `update organization_rooftops set status='suspended'
      where organization_id=$1 and status in ('active','past_due')`,
    [organizationId]
  );
  const archivedLifecycle = await enforceOrganizationBillingLifecycle();
  assert.equal(archivedLifecycle.archived, 1);
  assert.equal((await pool.query(
    `select count(*)::int as count from dealership_claims
      where organization_id=$1 and status in ('approved','checkout_pending','active')`,
    [organizationId]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `select count(*)::int as count from organization_rooftops
      where organization_id=$1 and status<>'archived'`,
    [organizationId]
  )).rows[0].count, 0);

  // Concurrent approvals from one multi-rooftop submission must never mint two separate
  // organizations. The claim-group advisory lock serializes that creation point.
  const concurrentClaims = await createClaims(users.groupOwner, {
    dealershipIds: ['org-test-d4', 'org-test-d5'],
    organizationName: 'Concurrent Auto Group',
    attested: true
  });
  const concurrentApprovals = await Promise.all(concurrentClaims.map((claim) =>
    approveClaim(claim.id, { actor: 'admin:test', reason: 'concurrent verification test' })
  ));
  assert.equal(new Set(concurrentApprovals.map((claim) => claim.organizationId)).size, 1);
  if (oldPriceId == null) delete process.env.STRIPE_DEALERSHIP_PRICE_ID;
  else process.env.STRIPE_DEALERSHIP_PRICE_ID = oldPriceId;
});
