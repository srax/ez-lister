import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecentAuthentication } from './ownership-transfers.js';

test('hasRecentAuthentication requires a valid session created in the last 15 minutes', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  assert.equal(hasRecentAuthentication('2026-07-19T11:50:00Z', now), true);
  assert.equal(hasRecentAuthentication('2026-07-19T11:44:59Z', now), false);
  assert.equal(hasRecentAuthentication('2026-07-19T12:00:01Z', now), false);
  assert.equal(hasRecentAuthentication('not-a-date', now), false);
});
