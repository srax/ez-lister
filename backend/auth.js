import { isProduction } from './env.js';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { stripe as stripePlugin } from '@better-auth/stripe';
import Stripe from 'stripe';
import { dash } from '@better-auth/infra';
import { pool } from './db.js';

// Better Auth instance. Google is the only provider in v1; the bearer plugin lets the
// extension authenticate every API call with `Authorization: Bearer <session token>`.

const EXTENSION_ID = process.env.EXTENSION_ID || 'ejagngoidhjkjoadbbijjkpdgelklael';
const devExtensionIds = (process.env.EXTENSION_IDS_DEV || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Configure Google only when creds are present, so the server still boots (and
// /api/auth/* + the /api/me shell work) before the OAuth client is wired up.
const socialProviders = {};
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET
  };
}

// Stripe billing (billing agent B). Guarded on STRIPE_SECRET_KEY so the server still boots
// (health + auth shell) before billing env is wired. On the shared live account the plugin
// only ever touches customers/subscriptions it created — it ignores webhook events for
// customers it doesn't know — so the main platform's Plus/Pro subscriptions never leak in.
// It serves subscription + `/stripe/webhook` routes under /api/auth/*, and owns the
// `subscription` table (+ user.stripeCustomerId) via migration 004.
const stripeClient = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const stripePlugins = stripeClient
  ? [stripePlugin({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [{ name: 'carxpert', priceId: process.env.STRIPE_PRICE_ID }]
      }
    })]
  : [];

// Better Auth Dash (@better-auth/infra) — lets the hosted dashboard verify ownership of and
// manage this deployment (endpoints served under /api/auth/*). dash() reads the key from
// BETTER_AUTH_API_KEY; guarded so the server still boots without it.
const dashPlugins = process.env.BETTER_AUTH_API_KEY ? [dash()] : [];

export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    `chrome-extension://${EXTENSION_ID}`,
    ...(!isProduction()
      ? devExtensionIds.map((id) => `chrome-extension://${id}`)
      : [])
  ],
  // Store email + name only (Better Auth defaults). Google is the only provider in v1.
  socialProviders,
  plugins: [bearer(), ...dashPlugins, ...stripePlugins]
});

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function billingConfigured() {
  return Boolean(stripeClient);
}
