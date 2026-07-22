import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSubscription,
  isEntitled,
  isOperationalRooftopStatus,
  organizationOperationalEntitlement
} from './index.js';

// Decision matrix for isEntitled against a mock db (no real Postgres). Entitled =
// (active/trialing subscription with a future-or-open period OR a live comp grant)
// AND a linked dealership. `sub`: 'none' = no active row, 'open' = active/null period,
// or an ISO string = active with that period end.
function mkDb({ dealership = false, comp = false, sub = 'none' }) {
  return {
    query: async (sql) => {
      if (sql.includes('user_dealerships')) return { rows: dealership ? [{ ok: 1 }] : [] };
      if (sql.includes('comp_grants')) return { rows: comp ? [{ ok: 1 }] : [] };
      if (sub === 'none') return { rows: [] };
      return { rows: [{ periodEnd: sub === 'open' ? null : sub }] };
    }
  };
}
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

test('nothing linked → no_dealership before subscription', async () => {
  assert.deepEqual(await isEntitled('u', mkDb({})), { entitled: false, reason: 'no_dealership', periodEnd: null });
});

test('active sub + dealership → entitled/ok', async () => {
  const r = await isEntitled('u', mkDb({ dealership: true, sub: future() }));
  assert.equal(r.entitled, true);
  assert.equal(r.reason, 'ok');
});

test('active sub, no dealership → no_dealership', async () => {
  const r = await isEntitled('u', mkDb({ dealership: false, sub: future() }));
  assert.equal(r.entitled, false);
  assert.equal(r.reason, 'no_dealership');
});

test('active/trialing row but period already passed → expired', async () => {
  const r = await isEntitled('u', mkDb({ dealership: true, sub: past() }));
  assert.equal(r.entitled, false);
  assert.equal(r.reason, 'expired');
});

test('open-ended sub (null period) + dealership → entitled', async () => {
  const r = await isEntitled('u', mkDb({ dealership: true, sub: 'open' }));
  assert.equal(r.entitled, true);
  assert.equal(r.reason, 'ok');
});

test('comp grant + dealership → entitled/ok', async () => {
  const r = await isEntitled('u', mkDb({ dealership: true, comp: true }));
  assert.equal(r.entitled, true);
  assert.equal(r.reason, 'ok');
});

test('comp grant but no dealership → no_dealership', async () => {
  const r = await isEntitled('u', mkDb({ dealership: false, comp: true }));
  assert.equal(r.entitled, false);
  assert.equal(r.reason, 'no_dealership');
});

// The mock db can't run SQL, so pin the ordering clause itself: the subscription pick MUST be
// liveness-first. `order by "periodEnd" desc nulls last` once picked a stale past-dated 'active'
// row over a live null-periodEnd one and gated a paying user with two subscription rows.
test('subscription query orders by liveness before periodEnd', async () => {
  let subSql = '';
  const db = {
    query: async (sql) => {
      if (sql.includes('"subscription"')) { subSql = sql; return { rows: [] }; }
      return { rows: [] };
    }
  };
  await isEntitled('u', db);
  assert.match(subSql, /order by \("periodEnd" is null or "periodEnd" > now\(\)\) desc/);
  assert.doesNotMatch(subSql, /nulls last/);
});

test('organization subscription lookup is restricted to the dealership plan', async () => {
  let params;
  const db = {
    query: async (_sql, values) => {
      params = values;
      return { rows: [] };
    }
  };
  await activeSubscription('org-1', db, { plan: 'dealership_rooftop' });
  assert.deepEqual(params, ['org-1', 'dealership_rooftop']);
});

test('organization operational state fails closed for provisional, suspended, and archived profiles', () => {
  for (const profileStatus of ['provisional', 'suspended', 'archived']) {
    const result = organizationOperationalEntitlement({
      profileStatus,
      subscriptionActive: true,
      comp: true
    });
    assert.equal(result.paid, false, profileStatus);
    assert.match(result.reason, /claim_approval|required|suspended|archived/);
  }
});

test('past-due organization works only inside grace while active organization needs billing', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  assert.equal(organizationOperationalEntitlement({
    profileStatus: 'past_due', graceEndsAt: '2026-07-19T13:00:00Z', now
  }).paid, true);
  assert.deepEqual(organizationOperationalEntitlement({
    profileStatus: 'past_due', graceEndsAt: '2026-07-19T11:00:00Z', subscriptionActive: true, now
  }), { paid: false, reason: 'past_due_expired' });
  assert.deepEqual(organizationOperationalEntitlement({
    profileStatus: 'active', subscriptionActive: false, hadSubscription: true, now
  }), { paid: false, reason: 'expired' });
});

test('a rooftop pending removal remains operational through its paid period', () => {
  for (const status of ['active', 'past_due', 'pending_removal']) {
    assert.equal(isOperationalRooftopStatus(status), true, status);
  }
  for (const status of ['reserved', 'suspended', 'archived', null]) {
    assert.equal(isOperationalRooftopStatus(status), false, String(status));
  }
});
