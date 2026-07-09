import test from 'node:test';
import assert from 'node:assert/strict';
import { linkDealer } from './dealerships.js';

// linkDealer's switch/lock rules against a fake db:
//  - fresh link inserts; re-linking the same dealership is a no-op
//  - switching is allowed while there is NO live subscription (expired/canceled included)
//  - switching is 409 dealership_locked while an active/trialing subscription is live
function fakeDb({ dealershipStatus = 'supported', existingDealerId = null, subRow = null } = {}) {
  const writes = [];
  return {
    writes,
    async query(sql) {
      const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.includes('from dealerships')) return { rows: [{ id: 'd-new', status: dealershipStatus }] };
      if (q.includes('from user_dealerships')) return { rows: existingDealerId ? [{ dealership_id: existingDealerId }] : [] };
      if (q.includes('from "subscription"')) return { rows: subRow ? [subRow] : [] };
      if (q.startsWith('update user_dealerships')) { writes.push('update'); return { rows: [] }; }
      if (q.startsWith('insert into user_dealerships')) { writes.push('insert'); return { rows: [] }; }
      return { rows: [] };
    }
  };
}

test('fresh link inserts', async () => {
  const db = fakeDb();
  const r = await linkDealer('u1', 'd-new', db);
  assert.equal(r.linked, true);
  assert.deepEqual(db.writes, ['insert']);
});

test('re-linking the same dealership is a no-op', async () => {
  const db = fakeDb({ existingDealerId: 'd-new' });
  const r = await linkDealer('u1', 'd-new', db);
  assert.equal(r.linked, true);
  assert.deepEqual(db.writes, []);
});

test('switch allowed with no subscription at all', async () => {
  const db = fakeDb({ existingDealerId: 'd-old' });
  const r = await linkDealer('u1', 'd-new', db);
  assert.equal(r.switched, true);
  assert.deepEqual(db.writes, ['update']);
});

test('switch allowed when the subscription is stale (period already ended)', async () => {
  const db = fakeDb({ existingDealerId: 'd-old', subRow: { periodEnd: '2020-01-01T00:00:00Z' } });
  const r = await linkDealer('u1', 'd-new', db);
  assert.equal(r.switched, true);
});

test('switch LOCKED while a live subscription exists (409 dealership_locked)', async () => {
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  const db = fakeDb({ existingDealerId: 'd-old', subRow: { periodEnd: future } });
  await assert.rejects(() => linkDealer('u1', 'd-new', db), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.reason, 'dealership_locked');
    return true;
  });
  assert.deepEqual(db.writes, []); // nothing was written
});

test('live subscription with no periodEnd also locks', async () => {
  const db = fakeDb({ existingDealerId: 'd-old', subRow: { periodEnd: null } });
  await assert.rejects(() => linkDealer('u1', 'd-new', db), (e) => e.reason === 'dealership_locked');
});
