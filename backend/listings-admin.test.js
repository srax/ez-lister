import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionQuality } from './listings-admin.js';

// Fake db that returns canned rows per sub-query, so we test the response SHAPE without Postgres.
function fakeDb() {
  return {
    async query(sql) {
      if (/avg_completeness/.test(sql) && /group by 1, 2/.test(sql)) {
        return { rows: [
          { provider: 'dealercom', host: 'weak.example.com', extractions: 8, avg_completeness: '0.55' },
          { provider: 'dealeron', host: 'good.example.com', extractions: 12, avg_completeness: '0.98' }
        ] };
      }
      if (/jsonb_array_elements_text/.test(sql)) {
        return { rows: [{ field: 'vin', missing_count: 6 }, { field: 'price', missing_count: 2 }] };
      }
      if (/count\(\*\)::int as n/.test(sql)) return { rows: [{ n: 20 }] };
      return { rows: [] };
    }
  };
}

test('extractionQuality returns weakest-dealer-first rows + missing-field tally', async () => {
  const r = await extractionQuality(14, fakeDb());
  assert.equal(r.extractions, 20);
  assert.equal(r.byDealer.length, 2);
  assert.equal(r.byDealer[0].host, 'weak.example.com'); // lowest completeness first
  assert.equal(r.byDealer[0].avg_completeness, '0.55');
  assert.equal(r.missingFields[0].field, 'vin');        // most-missing field first
  assert.equal(r.missingFields[0].missing_count, 6);
});

test('extractionQuality clamps the day window to 1..90', async () => {
  let captured = null;
  const db = { async query(sql, params) { captured = params; return { rows: [{ n: 0 }] }; } };
  await extractionQuality(9999, db);
  assert.equal(captured[0], '90');
  await extractionQuality(0, db);
  assert.equal(captured[0], '1');
});
