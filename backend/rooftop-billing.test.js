import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeActionUrl } from './rooftop-billing.js';

test('stripeActionUrl prefers the payment-intent redirect and falls back to hosted invoice', () => {
  assert.equal(stripeActionUrl({
    latest_invoice: {
      hosted_invoice_url: 'https://invoice.example/hosted',
      payment_intent: {
        next_action: { redirect_to_url: { url: 'https://payments.example/3ds' } }
      }
    }
  }), 'https://payments.example/3ds');
  assert.equal(stripeActionUrl({
    latest_invoice: { hosted_invoice_url: 'https://invoice.example/hosted' }
  }), 'https://invoice.example/hosted');
  assert.equal(stripeActionUrl({ latest_invoice: 'in_123' }), null);
});
