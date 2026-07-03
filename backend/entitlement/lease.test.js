import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';

// Proves a server-signed ES256 lease verifies with PURE WebCrypto (crypto.subtle.verify) —
// i.e. the MV3 service worker can verify entitlement offline with no library. That property
// is the entire reason the lease uses ES256, so it's worth a regression test.
test('issueLease → verifiable by pure WebCrypto', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.LEASE_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
  process.env.LEASE_KID = 'lease-test';

  const { issueLease } = await import('./index.js');
  const jws = await issueLease(
    { id: 'user_abc' },
    { id: 'dlr_alexandria', domains: ['www.alexandriatoyota.com'] }
  );

  const [h, p, s] = jws.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'lease-test');

  // import the public key as a bare JWK and verify with WebCrypto (no jose on the verify side)
  const jwk = await exportJWK(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(s, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`)
  );
  assert.equal(ok, true, 'WebCrypto must verify the ES256 lease signature');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.sub, 'user_abc');
  assert.equal(claims.dlr, 'dlr_alexandria');
  assert.deepEqual(claims.dom, ['www.alexandriatoyota.com']);
  assert.equal(claims.ent, true);
  assert.equal(claims.exp - claims.iat, 90 * 60, 'lease TTL is 90 minutes');
});

test('issueLease refuses to sign without a linked dealership', async () => {
  const { issueLease } = await import('./index.js');
  await assert.rejects(() => issueLease({ id: 'u' }, null), /without a linked dealership/);
});
