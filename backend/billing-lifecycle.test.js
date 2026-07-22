import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkoutExpiry,
  pruneSubscriptionReconciliationRuns,
  reconcileOrganizationStripeEvent
} from './billing-lifecycle.js';

test('checkoutExpiry never exceeds the claim reservation or Stripe 24-hour window', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  assert.equal(
    checkoutExpiry('2026-07-19T06:00:00Z', now),
    Math.floor(Date.parse('2026-07-19T06:00:00Z') / 1000)
  );
  assert.equal(
    checkoutExpiry('2026-07-22T00:00:00Z', now),
    Math.floor(Date.parse('2026-07-20T00:00:00Z') / 1000)
  );
});

test('organization Stripe event reconciliation propagates source-of-truth lookup failures', async () => {
  const failure = Object.assign(new Error('temporary Stripe outage'), { code: 'api_connection_error' });
  const db = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    reconcileOrganizationStripeEvent({
      id: 'evt_retry_me',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_retry_me' } }
    }, {
      db,
      stripeClient: { subscriptions: { retrieve: async () => { throw failure; } } }
    }),
    (error) => error === failure
  );
});

test('unrelated Stripe events are ignored without requiring Stripe configuration', async () => {
  assert.deepEqual(
    await reconcileOrganizationStripeEvent({ id: 'evt_other', type: 'invoice.paid' }, {
      stripeClient: null,
      db: { query: async () => { throw new Error('database should not be queried'); } }
    }),
    { ignored: true }
  );
});

test('organization Stripe events without an ID fail before Stripe or database access', async () => {
  await assert.rejects(
    reconcileOrganizationStripeEvent({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_missing_event_id' } }
    }, {
      stripeClient: { subscriptions: { retrieve: async () => { throw new Error('should not run'); } } },
      db: { query: async () => { throw new Error('should not run'); } }
    }),
    (error) => error.code === 'stripe_event_id_required'
  );
});

test('reconciliation pruning uses a bounded retention window', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 7 };
    }
  };
  const removed = await pruneSubscriptionReconciliationRuns(db, {
    now: new Date('2026-07-19T00:00:00Z'),
    retentionDays: 180
  });
  assert.equal(removed, 7);
  assert.match(calls[0].sql, /delete from subscription_reconciliation_runs/);
  assert.equal(calls[0].params[0], '2026-01-20T00:00:00.000Z');
});
