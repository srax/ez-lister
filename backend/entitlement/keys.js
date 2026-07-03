import { isProduction } from '../env.js';
import { importPKCS8, importSPKI, exportJWK } from 'jose';

// ES256 (P-256) lease-signing keys. The private key (PKCS8 PEM) + kid come from env; the
// public side is served at /.well-known/jwks.json so the MV3 service worker can verify a
// lease with plain WebCrypto — no library. Rotation: set LEASE_PUBLIC_KEY_PEM_PREV +
// LEASE_KID_PREV to keep the previous public key in the JWKS for ~2h after a rotate.

const ALG = 'ES256';
let signing = null;

export function leaseConfigured() {
  return Boolean(process.env.LEASE_PRIVATE_KEY_PEM && process.env.LEASE_KID);
}

// Loud once at boot in production — the whole paid flow is dead without signing keys.
export function warnIfLeaseUnconfigured() {
  if (isProduction() && !leaseConfigured()) {
    console.error('CONFIG ERROR: LEASE_PRIVATE_KEY_PEM + LEASE_KID required in production — leases cannot be issued.');
  }
}

export async function getSigningKey() {
  if (signing) return signing;
  if (!leaseConfigured()) { const e = new Error('lease signing key not configured'); e.status = 503; throw e; }
  const privateKey = await importPKCS8(process.env.LEASE_PRIVATE_KEY_PEM, ALG);
  signing = { privateKey, kid: process.env.LEASE_KID };
  return signing;
}

function toPublicJwk(jwk, kid) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: ALG, use: 'sig', kid };
}

export async function getJwks() {
  const keys = [];
  if (leaseConfigured()) {
    const jwk = await exportJWK(await importPKCS8(process.env.LEASE_PRIVATE_KEY_PEM, ALG));
    keys.push(toPublicJwk(jwk, process.env.LEASE_KID));
  }
  if (process.env.LEASE_PUBLIC_KEY_PEM_PREV && process.env.LEASE_KID_PREV) {
    const jwk = await exportJWK(await importSPKI(process.env.LEASE_PUBLIC_KEY_PEM_PREV, ALG));
    keys.push(toPublicJwk(jwk, process.env.LEASE_KID_PREV));
  }
  return { keys };
}

// GET /.well-known/jwks.json
export async function jwksHandler(_req, res) {
  try {
    const jwks = await getJwks();
    if (!jwks.keys.length) { res.status(503).json({ ok: false, error: 'jwks not available yet' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(jwks);
  } catch {
    res.status(503).json({ ok: false, error: 'jwks not available yet' });
  }
}
