import { isProduction } from './env.js';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer, organization } from 'better-auth/plugins';
import { stripe as stripePlugin } from '@better-auth/stripe';
import Stripe from 'stripe';
import { dash } from '@better-auth/infra';
import { pool } from './db.js';
import {
  authorizeBillingReference,
  checkoutExpiry,
  reconcileOrganizationStripeEvent
} from './billing-lifecycle.js';
import { googleProviderConfig } from './google-auth.js';

// Better Auth instance. Google is the only provider in v1; the bearer plugin lets the
// extension authenticate every API call with `Authorization: Bearer <session token>`.

const EXTENSION_ID = process.env.EXTENSION_ID || 'nfpnkiknibofeiicekdehonjmpnonaeh';
const devExtensionIds = (process.env.EXTENSION_IDS_DEV || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Configure Google only when creds are present, so the server still boots (and
// /api/auth/* + the /api/me shell work) before the OAuth client is wired up.
const socialProviders = {};
const googleProvider = googleProviderConfig(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
if (googleProvider) socialProviders.google = googleProvider;

// Stripe billing (billing agent B). Guarded on STRIPE_SECRET_KEY so the server still boots
// (health + auth shell) before billing env is wired. On the shared live account the plugin
// only ever touches customers/subscriptions it created — it ignores webhook events for
// customers it doesn't know — so the main platform's Plus/Pro subscriptions never leak in.
// It serves subscription + `/stripe/webhook` routes under /api/auth/*, and owns the
// `subscription` table (+ user.stripeCustomerId) via migration 004.
const stripeClient = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const billingPlans = [
  process.env.STRIPE_PRICE_ID
    ? { name: 'carxpert', priceId: process.env.STRIPE_PRICE_ID }
    : null,
  process.env.STRIPE_DEALERSHIP_PRICE_ID
    ? {
        name: 'dealership_rooftop',
        priceId: process.env.STRIPE_DEALERSHIP_PRICE_ID,
        prorationBehavior: 'always_invoice'
      }
    : null
].filter(Boolean);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;
const stripePlugins = stripeClient && stripeWebhookSecret
  ? [stripePlugin({
      stripeClient,
      stripeWebhookSecret,
      createCustomerOnSignUp: true,
      organization: { enabled: true },
      // Unlike the plugin's per-subscription callbacks, errors from onEvent propagate to
      // the webhook endpoint. Our reconciliation therefore gets Stripe retries and always
      // reads the latest subscription instead of trusting an out-of-order event payload.
      onEvent: (event) => reconcileOrganizationStripeEvent(event, { stripeClient }),
      subscription: {
        enabled: true,
        requireEmailVerification: true,
        plans: billingPlans,
        authorizeReference: (data) => authorizeBillingReference(data),
        getCheckoutSessionParams: async ({ plan, subscription }) => {
          const params = {
            allow_promotion_codes: true,
            payment_method_collection: 'if_required',
            locale: 'en'
          };
          if (plan.name === 'dealership_rooftop') {
            const target = await organizationCheckoutTargetForHook(subscription.referenceId);
            if (target.reservationExpiresAt) {
              params.expires_at = checkoutExpiry(target.reservationExpiresAt);
            }
          }
          return { params };
        }
      }
    })]
  : [];

async function organizationCheckoutTargetForHook(organizationId) {
  const { rows } = await pool.query(
    `select min(r.reservation_expires_at) filter (
              where r.status='reserved' and r.reservation_expires_at > now()
            ) as expires_at,
            count(*) filter (where
              (r.status='reserved' and r.reservation_expires_at > now()
               and c.status in ('approved','checkout_pending'))
              or (r.status in ('active','past_due','suspended','pending_removal')
                  and c.status='active')
            )::int as eligible_count
       from organization_rooftops r
       join dealership_claims c on c.organization_id=r.organization_id
        and c.dealership_id=r.dealership_id
      where r.organization_id=$1`,
    [organizationId]
  );
  if (!rows[0] || !rows[0].eligible_count) {
    throw new APIError('BAD_REQUEST', { message: 'Approved dealership claim required.' });
  }
  return { reservationExpiresAt: rows[0].expires_at || null };
}

// Better Auth owns organization identity, coarse membership, and invitation records.
// Carxpert owns dealership claims, rooftop scope, listing seats, and operational roles.
// Ordinary clients cannot create/delete organizations directly: an approved dealership
// claim is the only creation path, and organization closure follows our retention policy.
function customOrganizationFlowOnly() {
  throw new APIError('FORBIDDEN', {
    message: 'Use the Carxpert organization workflow for this action.'
  });
}

const organizationPlugins = [organization({
  allowUserToCreateOrganization: false,
  invitationExpiresIn: 7 * 24 * 60 * 60,
  cancelPendingInvitationsOnReInvite: true,
  requireEmailVerificationOnInvitation: true,
  disableOrganizationDeletion: true,
  membershipLimit: 500,
  // Better Auth owns identity records, while Carxpert owns verified claims, rooftop scope,
  // capacity, and user-facing roles. Generic plugin mutations would bypass those invariants;
  // our feature-gated domain routes write the same plugin-owned records transactionally.
  organizationHooks: {
    beforeUpdateOrganization: customOrganizationFlowOnly,
    beforeAddMember: customOrganizationFlowOnly,
    beforeRemoveMember: customOrganizationFlowOnly,
    beforeUpdateMemberRole: customOrganizationFlowOnly,
    beforeCreateInvitation: customOrganizationFlowOnly,
    beforeAcceptInvitation: customOrganizationFlowOnly,
    beforeRejectInvitation: customOrganizationFlowOnly,
    beforeCancelInvitation: customOrganizationFlowOnly
  }
})];

// Better Auth Dash (@better-auth/infra) — lets the hosted dashboard verify ownership of and
// manage this deployment (endpoints served under /api/auth/*). dash() reads the key from
// BETTER_AUTH_API_KEY; guarded so the server still boots without it.
const dashPlugins = process.env.BETTER_AUTH_API_KEY ? [dash()] : [];

export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  // Self-service deletion remains off until the audited flow can reject primary owners and
  // preserve organization attribution. Pin the default explicitly so a dependency upgrade
  // cannot silently expose deletion.
  user: { deleteUser: { enabled: false } },
  trustedOrigins: [
    `chrome-extension://${EXTENSION_ID}`,
    ...(!isProduction()
      ? devExtensionIds.map((id) => `chrome-extension://${id}`)
      : [])
  ],
  // Store email + name only (Better Auth defaults). Google is the only provider in v1.
  socialProviders,
  advanced: {
    ipAddress: {
      ipAddressHeaders: ['x-forwarded-for']
    }
  },
  plugins: [bearer(), ...organizationPlugins, ...dashPlugins, ...stripePlugins]
});

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function billingConfigured() {
  return stripePlugins.length > 0;
}
