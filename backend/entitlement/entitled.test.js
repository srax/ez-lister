import test from 'node:test';
import assert from 'node:assert/strict';
import { isEntitled } from './index.js';

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
