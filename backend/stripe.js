import './env.js';
import Stripe from 'stripe';

// Shared Stripe SDK client for the imperative billing routes (checkout / portal / reconcile).
// The webhook → subscription-table sync is owned by @better-auth/stripe at
// /api/auth/stripe/webhook; this client is only for the Checkout/Portal/list calls.
// Null until STRIPE_SECRET_KEY is set, so the server still boots without billing env.
export const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export function stripeConfigured() {
  return Boolean(stripe && process.env.STRIPE_PRICE_ID);
}

export function organizationStripeConfigured() {
  return Boolean(stripe && process.env.STRIPE_DEALERSHIP_PRICE_ID);
}
