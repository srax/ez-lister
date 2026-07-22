import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalRole,
  availableCapacity,
  cancelAccessRequest,
  hashToken,
  normalizeEmail
} from './organizations.js';

function transactionDb(request, { remainingScope = false, seatReleased = false } = {}) {
  const writes = [];
  const client = {
    async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('begin') || q === 'commit' || q === 'rollback') return { rows: [] };
      if (q.startsWith('select * from organization_access_requests')) {
        return { rows: request ? [{ ...request }] : [] };
      }
      if (q.startsWith('update organization_access_requests')) {
        writes.push('request:canceled');
        return { rows: [{ ...request, status: 'canceled' }] };
      }
      if (q.startsWith('update seat_reservations')) { writes.push('reservations:released'); return { rows: [] }; }
      if (q.startsWith('select id from "member"')) return { rows: [{ id: 'member-1' }] };
      if (q.startsWith('update seat_assignments')) {
        if (seatReleased) writes.push('seat:released');
        return { rows: [], rowCount: seatReleased ? 1 : 0 };
      }
      if (q.startsWith('update member_rooftop_access')) { writes.push('scope:revoked'); return { rows: [] }; }
      if (q.startsWith('select 1 from member_rooftop_access')) {
        return { rows: remainingScope ? [{ '?column?': 1 }] : [] };
      }
      if (q.startsWith('update organization_member_profiles')) { writes.push('profile:removed'); return { rows: [] }; }
      if (q.startsWith('insert into organization_audit_events')) { writes.push('audit'); return { rows: [] }; }
      throw new Error(`unexpected query: ${q}`);
    },
    release() {}
  };
  return { writes, connect: async () => client };
}

test('availableCapacity includes rooftop extras and subtracts live assignments and reservations', () => {
  assert.equal(availableCapacity({ includedSeats: 10, extraSeats: 2, assigned: 7, reserved: 3 }), 2);
  assert.equal(availableCapacity({ includedSeats: 10, extraSeats: 0, assigned: 11, reserved: 0 }), 0);
});

test('invitation helpers normalize email and hash tokens deterministically without storing raw values', () => {
  assert.equal(normalizeEmail('  Sales.Person@Example.COM '), 'sales.person@example.com');
  assert.equal(hashToken('secret'), hashToken('secret'));
  assert.notEqual(hashToken('secret'), 'secret');
});

test('access approval role is owner-controlled while managers remain salesperson-scoped', () => {
  assert.equal(approvalRole('owner', 'salesperson', 'manager'), 'manager');
  assert.equal(approvalRole('owner', 'manager', 'salesperson'), 'salesperson');
  assert.equal(approvalRole('manager', 'salesperson', null), 'salesperson');
  assert.equal(approvalRole('owner', 'manager', null), 'salesperson');
  assert.throws(
    () => approvalRole('manager', 'salesperson', 'manager'),
    (err) => err.reason === 'owner_required'
  );
  assert.throws(
    () => approvalRole('owner', 'salesperson', 'owner'),
    (err) => err.reason === 'invalid_role'
  );
});

test('a user can idempotently cancel their own pending access request', async () => {
  const request = {
    id: 'request-1', user_id: 'user-1', organization_id: 'org-1', dealership_id: 'dealer-1', status: 'pending'
  };
  const db = transactionDb(request);
  const result = await cancelAccessRequest('user-1', 'request-1', db);
  assert.equal(result.request.status, 'canceled');
  assert.equal(result.changed, true);
  assert.deepEqual(db.writes, ['request:canceled', 'reservations:released', 'audit']);
});

test('an active team membership cannot be removed through request cancellation', async () => {
  const db = transactionDb({
    id: 'request-1', user_id: 'user-1', organization_id: 'org-1', dealership_id: 'dealer-1', status: 'approved'
  });
  await assert.rejects(
    cancelAccessRequest('user-1', 'request-1', db),
    (err) => err.reason === 'membership_active'
  );
  assert.deepEqual(db.writes, []);
});

test('canceling an awaiting-capacity request revokes only its provisional team access', async () => {
  const db = transactionDb({
    id: 'request-1', user_id: 'user-1', organization_id: 'org-1', dealership_id: 'dealer-1',
    status: 'approved_awaiting_capacity'
  });
  const result = await cancelAccessRequest('user-1', 'request-1', db);
  assert.equal(result.request.status, 'canceled');
  assert.deepEqual(db.writes, [
    'request:canceled', 'reservations:released', 'scope:revoked', 'profile:removed', 'audit'
  ]);
});

test('canceling one awaiting-capacity rooftop preserves a member profile with another active scope', async () => {
  const db = transactionDb({
    id: 'request-1', user_id: 'user-1', organization_id: 'org-1', dealership_id: 'dealer-1',
    status: 'approved_awaiting_capacity'
  }, { remainingScope: true });
  await cancelAccessRequest('user-1', 'request-1', db);
  assert.deepEqual(db.writes, ['request:canceled', 'reservations:released', 'scope:revoked', 'audit']);
});
