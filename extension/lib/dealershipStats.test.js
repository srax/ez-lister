'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDealershipSold, summarize, monthlyActivity } = require('./dealershipStats.js');

const NOW = Date.parse('2026-07-22T12:00:00Z');
const row = (overrides = {}) => ({
  key: 'row-1',
  vin: '1N6ED1FK9PN632529',
  status: 'active',
  listedAt: '2026-07-01T12:00:00Z',
  price: 30000,
  ...overrides
});

test('only scanner-confirmed rows are dealership sales', () => {
  assert.equal(isDealershipSold(row({ status: 'sold', soldSource: 'scan' })), true);
  assert.equal(isDealershipSold(row({ status: 'sold', soldSource: 'manual' })), false);
  assert.equal(isDealershipSold(row({ status: 'sold', soldPlatform: 'fb' })), false);
  assert.equal(isDealershipSold(row({ dealerOutcome: 'fb' })), false);
});

test('summary counts a sold VIN once across users and platforms', () => {
  const rows = [
    row({ key: 'alice-fb', soldSource: 'scan', status: 'sold', soldAt: '2026-07-20T12:00:00Z' }),
    row({ key: 'bob-cl', soldSource: 'scan', status: 'sold', soldAt: '2026-07-20T13:00:00Z' }),
    row({ key: 'legacy-manual', vin: 'JTEAAAAH5RJ171986', soldSource: 'manual', status: 'sold', soldAt: '2026-07-19T12:00:00Z' }),
    row({ key: 'live', vin: 'JF2GUADC0RH224771', price: 24975 })
  ];
  assert.deepEqual(summarize(rows, '30', NOW), {
    activeCount: 1,
    activeValue: 24975,
    listedInRange: 3,
    soldAtDealership: 1,
    avgDays: 19,
    previousSoldCount: 0
  });
});

test('summary uses the selected sale range and never derives revenue', () => {
  const stats = summarize([
    row({ status: 'sold', soldSource: 'scan', soldAt: '2026-07-20T12:00:00Z', soldPrice: 1 }),
    row({ key: 'old', vin: 'JTEAAAAH5RJ171986', status: 'sold', soldSource: 'scan', soldAt: '2026-06-01T12:00:00Z' })
  ], '7', NOW);
  assert.equal(stats.soldAtDealership, 1);
  assert.equal(stats.previousSoldCount, 0);
  assert.equal(Object.hasOwn(stats, 'gross'), false);
});

test('monthly activity includes only scanner-confirmed dealership outcomes', () => {
  const buckets = monthlyActivity([
    row({ status: 'sold', soldSource: 'scan', soldAt: '2026-07-20T12:00:00Z' }),
    row({ key: 'manual', vin: 'JTEAAAAH5RJ171986', status: 'sold', soldSource: 'manual', soldAt: '2026-07-19T12:00:00Z' })
  ], new Date(NOW));
  const july = buckets.at(-1);
  assert.equal(july.listed, 2);
  assert.equal(july.soldAtDealership, 1);
});
