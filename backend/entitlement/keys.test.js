import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { getJwks } from './keys.js';

// Regression: importPKCS8 defaults to a NON-extractable key, and exportJWK on it throws —
// which silently 503'd the JWKS route in staging. Exercise the imported-key → public-JWK path.
test('getJwks derives a public JWK from a PKCS8 private key (extractable path)', async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.LEASE_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
  process.env.LEASE_KID = 'lease-jwks-test';
  const { keys } = await getJwks();
  assert.equal(keys.length, 1);
  const k = keys[0];
  assert.equal(k.kty, 'EC');
  assert.equal(k.crv, 'P-256');
  assert.ok(k.x && k.y);
  assert.equal(k.d, undefined, 'must never leak the private component');
  assert.equal(k.kid, 'lease-jwks-test');
  assert.equal(k.alg, 'ES256');
});

// The env-store newline gotcha: a base64-encoded PEM must load the same as a raw PEM.
test('getJwks accepts a base64-encoded PEM (newline-safe env path)', async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.LEASE_PRIVATE_KEY_PEM = Buffer.from(await exportPKCS8(privateKey)).toString('base64');
  process.env.LEASE_KID = 'lease-b64-test';
  const { keys } = await getJwks();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kid, 'lease-b64-test');
});
