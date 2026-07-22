import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardRange } from './organization-dashboard.js';

test('dashboardRange defaults to 30 days and caps custom history at 366 days', () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const normal = dashboardRange({}, now);
  assert.equal(normal.to, now.toISOString());
  assert.equal(normal.from, new Date(now.getTime() - 30 * 86400000).toISOString());
  const capped = dashboardRange({ from: '2020-01-01T00:00:00Z' }, now);
  assert.equal(capped.from, new Date(now.getTime() - 366 * 86400000).toISOString());
});

test('dashboardRange rejects inverted or invalid dates', () => {
  assert.throws(() => dashboardRange({ from: 'bad' }), /invalid dashboard date range/);
  assert.throws(() => dashboardRange({ from: '2026-07-20', to: '2026-07-19' }), /invalid dashboard date range/);
});
