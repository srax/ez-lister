import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPresence, getCarsToCheck, syncListings } from './listings.js';

// In-memory fake db that applies the presence/outcome UPDATEs so we can assert the resulting
// row state — including the two-confirm interval rule (first_missed must be ≥2h old before a
// second gone report promotes to gone_confirmed_at).
const HOURS = 3600 * 1000;
function fakeDb(initial = []) {
  const rows = initial.map((r) => ({
    first_missed_at: null, last_seen_in_inventory_at: null, gone_confirmed_at: null,
    dealer_outcome: null, dealer_outcome_at: null, ...r
  }));
  const eventIds = new Set();
  const presenceRow = (ownerId, key) => rows.find((r) =>
    r.ownerId === ownerId && r.clientKey === key && r.status === 'listed' && r.dealer_outcome == null);
  return {
    rows,
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (/^select client_key/i.test(q)) {
        const [ownerId] = params;
        return { rows: rows.filter((r) => r.ownerId === ownerId && r.status === 'listed' && r.vin && r.sourceUrl && r.dealer_outcome == null)
          .map((r) => ({ clientKey: r.clientKey, vin: r.vin, sourceUrl: r.sourceUrl })) };
      }
      if (/update listings set last_seen_in_inventory_at/i.test(q)) {
        const [ownerId, key, at] = params;
        const r = presenceRow(ownerId, key);
        if (r) { r.last_seen_in_inventory_at = at; r.first_missed_at = null; r.gone_confirmed_at = null; }
        return { rows: [] };
      }
      if (/update listings set gone_confirmed_at = coalesce/i.test(q)) {
        const [ownerId, key, at] = params;
        const r = presenceRow(ownerId, key);
        // mirror: first_missed_at is not null AND first_missed_at <= at - 2h
        if (r && r.first_missed_at && new Date(r.first_missed_at) <= new Date(new Date(at) - 2 * HOURS)) {
          r.gone_confirmed_at = r.gone_confirmed_at || at;
        }
        return { rows: [] };
      }
      if (/update listings set first_missed_at = coalesce/i.test(q)) {
        const [ownerId, key, at] = params;
        const r = presenceRow(ownerId, key);
        if (r) r.first_missed_at = r.first_missed_at || at;
        return { rows: [] };
      }
      if (/update listings set dealer_outcome = \$4/i.test(q)) {
        const [workspaceId, actorUserId, key, outcome, at] = params;
        const ownerId = actorUserId || String(workspaceId).replace(/^personal:/, '');
        for (const r of rows) if (r.ownerId === ownerId && r.clientKey === key) { r.dealer_outcome = outcome; r.dealer_outcome_at = at; }
        return { rows: [] };
      }
      if (/^insert into usage_events/i.test(q)) {
        const id = params[0];
        if (eventIds.has(id)) return { rows: [] };
        eventIds.add(id);
        return { rows: [{ id }] };
      }
      return { rows: [] }; // usage_events insert etc.
    }
  };
}

const OWNER = 'user-1';
const T0 = '2026-07-11T10:00:00Z';
const plusH = (h) => new Date(new Date(T0).getTime() + h * HOURS).toISOString();

test('recordPresence: present → last_seen set, BOTH miss clocks cleared (auto-revive)', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN1', status: 'listed',
    first_missed_at: '2026-01-01T00:00:00Z', gone_confirmed_at: '2026-01-01T03:00:00Z' }]);
  const c = await recordPresence(OWNER, [{ clientKey: 'VIN1', present: true, checkedAt: T0 }], db);
  assert.deepEqual(c, { present: 1, gone: 0, unknown: 0, total: 1, dropped: 0 });
  const row = db.rows[0];
  assert.equal(row.last_seen_in_inventory_at, new Date(T0).toISOString());
  assert.equal(row.first_missed_at, null);
  assert.equal(row.gone_confirmed_at, null);
});

test('two-confirm: a single gone report NEVER confirms', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN2', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN2', present: false, checkedAt: T0 }], db);
  assert.equal(db.rows[0].first_missed_at, new Date(T0).toISOString());
  assert.equal(db.rows[0].gone_confirmed_at, null, 'one miss must not confirm');
});

test('two-confirm: second gone ≥2h later promotes to gone_confirmed_at', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN3', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN3', present: false, checkedAt: T0 }], db);
  await recordPresence(OWNER, [{ clientKey: 'VIN3', present: false, checkedAt: plusH(3) }], db);
  assert.equal(db.rows[0].gone_confirmed_at, plusH(3));
  // a third gone must not move the confirmation time (coalesce)
  await recordPresence(OWNER, [{ clientKey: 'VIN3', present: false, checkedAt: plusH(6) }], db);
  assert.equal(db.rows[0].gone_confirmed_at, plusH(3));
});

test('two-confirm: second gone too soon (<2h) does NOT confirm', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN4', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN4', present: false, checkedAt: T0 }], db);
  await recordPresence(OWNER, [{ clientKey: 'VIN4', present: false, checkedAt: plusH(1) }], db);
  assert.equal(db.rows[0].gone_confirmed_at, null);
  assert.equal(db.rows[0].first_missed_at, new Date(T0).toISOString(), 'first miss timestamp preserved');
});

test('revive then disappear again: clocks restart from scratch', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN5', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN5', present: false, checkedAt: T0 }], db);
  await recordPresence(OWNER, [{ clientKey: 'VIN5', present: true, checkedAt: plusH(3) }], db);  // back on the lot
  await recordPresence(OWNER, [{ clientKey: 'VIN5', present: false, checkedAt: plusH(6) }], db); // gone again
  assert.equal(db.rows[0].first_missed_at, plusH(6), 'miss clock restarted');
  assert.equal(db.rows[0].gone_confirmed_at, null, 'old miss must not count toward confirmation');
});

test('recordPresence: unknown (null) changes nothing; counts are right', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN6', status: 'listed', first_missed_at: '2026-06-01T00:00:00Z' }]);
  const c = await recordPresence(OWNER, [
    { clientKey: 'VIN6', present: null, checkedAt: T0 },
    { present: true }, // missing clientKey → unknown, skipped
  ], db);
  assert.deepEqual(c, { present: 0, gone: 0, unknown: 2, total: 2, dropped: 0 });
  assert.equal(db.rows[0].first_missed_at, '2026-06-01T00:00:00Z'); // untouched
});

test('recordPresence: only touches listed rows (a sold row is left alone)', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN7', status: 'sold' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN7', present: false, checkedAt: T0 }], db);
  assert.equal(db.rows[0].first_missed_at, null);
});

test('recordPresence: a classified car (dealer_outcome set) is settled — untouched', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN8', status: 'listed', dealer_outcome: 'fb',
    gone_confirmed_at: '2026-07-01T00:00:00Z' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN8', present: true, checkedAt: T0 }], db);
  assert.equal(db.rows[0].gone_confirmed_at, '2026-07-01T00:00:00Z', 'classified row must not be revived');
});

test('recordPresence: bad checkedAt falls back to a valid timestamp', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN9', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN9', present: false, checkedAt: 'not-a-date' }], db);
  assert.ok(!Number.isNaN(new Date(db.rows[0].first_missed_at).getTime()), 'first_missed_at is a valid date');
});

test('getCarsToCheck: only listed cars with a vin + source_url and no outcome yet', async () => {
  const db = fakeDb([
    { ownerId: OWNER, clientKey: 'A', vin: 'A', sourceUrl: 'https://d/a', status: 'listed' },
    { ownerId: OWNER, clientKey: 'B', vin: 'B', sourceUrl: null, status: 'listed' },        // no url → excluded
    { ownerId: OWNER, clientKey: 'C', vin: 'C', sourceUrl: 'https://d/c', status: 'sold' },  // sold → excluded
    { ownerId: 'other', clientKey: 'D', vin: 'D', sourceUrl: 'https://d/d', status: 'listed' }, // other user → excluded
    { ownerId: OWNER, clientKey: 'E', vin: 'E', sourceUrl: 'https://d/e', status: 'listed', dealer_outcome: 'delisted' } // settled → excluded
  ]);
  const cars = await getCarsToCheck(OWNER, db);
  assert.equal(cars.length, 1);
  assert.deepEqual(cars[0], { clientKey: 'A', vin: 'A', sourceUrl: 'https://d/a' });
});

// ---- dealer_outcome event (synced from the panel's Submit) ----

test('dealer_outcome event: sets outcome + timestamp on the listing', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN10', status: 'listed', gone_confirmed_at: T0 }]);
  await syncListings(OWNER, { events: [
    { id: 'ev-1', type: 'dealer_outcome', clientKey: 'VIN10', occurredAt: plusH(4), data: { outcome: 'craigslist' } }
  ] }, db);
  assert.equal(db.rows[0].dealer_outcome, 'craigslist');
  assert.equal(db.rows[0].dealer_outcome_at, plusH(4));
});

test('dealer_outcome event: an invalid outcome value is ignored', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN11', status: 'listed' }]);
  await syncListings(OWNER, { events: [
    { id: 'ev-2', type: 'dealer_outcome', clientKey: 'VIN11', occurredAt: T0, data: { outcome: 'ebay' } }
  ] }, db);
  assert.equal(db.rows[0].dealer_outcome, null);
});

test('usage event replay cannot change side effects after its id was accepted', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN12', status: 'listed' }]);
  await syncListings(OWNER, { events: [
    { id: 'ev-replay', type: 'dealer_outcome', clientKey: 'VIN12', occurredAt: T0, data: { outcome: 'craigslist' } }
  ] }, db);
  await syncListings(OWNER, { events: [
    { id: 'ev-replay', type: 'dealer_outcome', clientKey: 'VIN12', occurredAt: plusH(1), data: { outcome: 'fb' } }
  ] }, db);
  assert.equal(db.rows[0].dealer_outcome, 'craigslist');
  assert.equal(db.rows[0].dealer_outcome_at, new Date(T0).toISOString());
});
