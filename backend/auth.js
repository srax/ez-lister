import './env.js';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { pool } from './db.js';

// Better Auth instance. Google is the only provider in v1; the bearer plugin lets the
// extension authenticate every API call with `Authorization: Bearer <session token>`.
// The billing agent (B) appends the @better-auth/stripe plugin to `plugins` below.

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

export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    `chrome-extension://${EXTENSION_ID}`,
    ...(process.env.NODE_ENV !== 'production'
      ? devExtensionIds.map((id) => `chrome-extension://${id}`)
      : [])
  ],
  // Store email + name only (Better Auth defaults). Google is the only provider in v1.
  socialProviders,
  plugins: [bearer()]
});

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
