import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPresence, getCarsToCheck } from './listings.js';

// In-memory fake db that applies the presence UPDATEs so we can assert the resulting row state.
function fakeDb(initial = []) {
  const rows = initial.map((r) => ({ first_missed_at: null, last_seen_in_inventory_at: null, ...r }));
  return {
    rows,
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (/^select client_key/i.test(q)) {
        const [ownerId] = params;
        return { rows: rows.filter((r) => r.ownerId === ownerId && r.status === 'listed' && r.vin && r.sourceUrl)
          .map((r) => ({ clientKey: r.clientKey, vin: r.vin, sourceUrl: r.sourceUrl })) };
      }
      if (/update listings set last_seen_in_inventory_at/i.test(q)) {
        const [ownerId, key, at] = params;
        for (const r of rows) if (r.ownerId === ownerId && r.clientKey === key && r.status === 'listed') { r.last_seen_in_inventory_at = at; r.first_missed_at = null; }
        return { rows: [] };
      }
      if (/update listings set first_missed_at = coalesce/i.test(q)) {
        const [ownerId, key, at] = params;
        for (const r of rows) if (r.ownerId === ownerId && r.clientKey === key && r.status === 'listed') { r.first_missed_at = r.first_missed_at || at; }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

const OWNER = 'user-1';

test('recordPresence: present → last_seen set, miss clock cleared', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN1', status: 'listed', first_missed_at: '2026-01-01T00:00:00Z' }]);
  const c = await recordPresence(OWNER, [{ clientKey: 'VIN1', present: true, checkedAt: '2026-07-11T10:00:00Z' }], db);
  assert.deepEqual(c, { present: 1, gone: 0, unknown: 0, total: 1 });
  const row = db.rows[0];
  assert.equal(row.last_seen_in_inventory_at, '2026-07-11T10:00:00.000Z');
  assert.equal(row.first_missed_at, null);
});

test('recordPresence: gone → first_missed set once (coalesce keeps the first)', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN2', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN2', present: false, checkedAt: '2026-07-11T10:00:00Z' }], db);
  assert.equal(db.rows[0].first_missed_at, '2026-07-11T10:00:00.000Z');
  // a later gone must NOT overwrite the first-missed timestamp
  await recordPresence(OWNER, [{ clientKey: 'VIN2', present: false, checkedAt: '2026-07-11T13:00:00Z' }], db);
  assert.equal(db.rows[0].first_missed_at, '2026-07-11T10:00:00.000Z');
});

test('recordPresence: unknown (null) changes nothing; counts are right', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN3', status: 'listed', first_missed_at: '2026-06-01T00:00:00Z' }]);
  const c = await recordPresence(OWNER, [
    { clientKey: 'VIN3', present: null, checkedAt: '2026-07-11T10:00:00Z' },
    { present: true }, // missing clientKey → unknown, skipped
  ], db);
  assert.deepEqual(c, { present: 0, gone: 0, unknown: 2, total: 2 });
  assert.equal(db.rows[0].first_missed_at, '2026-06-01T00:00:00Z'); // untouched
});

test('recordPresence: only touches listed rows (a sold row is left alone)', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN4', status: 'sold', first_missed_at: null }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN4', present: false, checkedAt: '2026-07-11T10:00:00Z' }], db);
  assert.equal(db.rows[0].first_missed_at, null); // sold row not modified
});

test('recordPresence: bad checkedAt falls back to a valid timestamp', async () => {
  const db = fakeDb([{ ownerId: OWNER, clientKey: 'VIN5', status: 'listed' }]);
  await recordPresence(OWNER, [{ clientKey: 'VIN5', present: false, checkedAt: 'not-a-date' }], db);
  assert.ok(!Number.isNaN(new Date(db.rows[0].first_missed_at).getTime()), 'first_missed_at is a valid date');
});

test('getCarsToCheck: only listed cars with a vin + source_url', async () => {
  const db = fakeDb([
    { ownerId: OWNER, clientKey: 'A', vin: 'A', sourceUrl: 'https://d/a', status: 'listed' },
    { ownerId: OWNER, clientKey: 'B', vin: 'B', sourceUrl: null, status: 'listed' },        // no url → excluded
    { ownerId: OWNER, clientKey: 'C', vin: 'C', sourceUrl: 'https://d/c', status: 'sold' },  // sold → excluded
    { ownerId: 'other', clientKey: 'D', vin: 'D', sourceUrl: 'https://d/d', status: 'listed' } // other user → excluded
  ]);
  const cars = await getCarsToCheck(OWNER, db);
  assert.equal(cars.length, 1);
  assert.deepEqual(cars[0], { clientKey: 'A', vin: 'A', sourceUrl: 'https://d/a' });
});
