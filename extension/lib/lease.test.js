'use strict';

// Proves lease.js verifies the backend's ES256 lease with pure WebCrypto (no library) — the
// same crypto.subtle path the MV3 worker uses. Run: node --test extension/lib/lease.test.js
const test = require('node:test');
const assert = require('node:assert');
require('./lease.js'); // attaches globalThis.CarxpertLease
const { verifyLeaseJws, leaseCoversHost } = globalThis.CarxpertLease;

const enc = new TextEncoder();
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

async function makeKit(kid = 'lease-test') {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = kid; jwk.alg = 'ES256'; jwk.use = 'sig';
  return { privateKey, jwks: { keys: [jwk] }, kid };
}

async function signLease(claims, kid, privateKey) {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid })));
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

test('verifies a valid ES256 lease', async () => {
  const { privateKey, jwks, kid } = await makeKit();
  const jws = await signLease(
    { sub: 'u1', dlr: 'alexandria-toyota', dom: ['www.alexandriatoyota.com'], ent: true, iat: now(), exp: now() + 3600 },
    kid, privateKey);
  const res = await verifyLeaseJws(jws, jwks);
  assert.equal(res.valid, true);
  assert.equal(res.claims.dlr, 'alexandria-toyota');
});

test('rejects an expired lease (beyond 60s leeway)', async () => {
  const { privateKey, jwks, kid } = await makeKit();
  const jws = await signLease({ sub: 'u1', dom: [], exp: now() - 120 }, kid, privateKey);
  const res = await verifyLeaseJws(jws, jwks);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'expired');
});

test('rejects a lease with no exp claim (fail closed, not eternal)', async () => {
  const { privateKey, jwks, kid } = await makeKit();
  const jws = await signLease({ sub: 'u1', dom: [], ent: true }, kid, privateKey);
  const res = await verifyLeaseJws(jws, jwks);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'expired');
});

test('accepts a lease inside the 60s leeway', async () => {
  const { privateKey, jwks, kid } = await makeKit();
  const jws = await signLease({ sub: 'u1', dom: [], exp: now() - 30 }, kid, privateKey);
  const res = await verifyLeaseJws(jws, jwks);
  assert.equal(res.valid, true);
});

test('rejects a tampered signature', async () => {
  const { privateKey, jwks, kid } = await makeKit();
  const jws = await signLease({ sub: 'u1', dom: [], exp: now() + 3600 }, kid, privateKey);
  const parts = jws.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  const res = await verifyLeaseJws(parts.join('.'), jwks);
  assert.equal(res.valid, false);
});

test('rejects an unknown kid', async () => {
  const a = await makeKit('kid-a');
  const b = await makeKit('kid-b');
  const jws = await signLease({ sub: 'u1', dom: [], exp: now() + 3600 }, 'kid-a', a.privateKey);
  const res = await verifyLeaseJws(jws, b.jwks);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'unknown_kid');
});

test('rejects a malformed token', async () => {
  const { jwks } = await makeKit();
  const res = await verifyLeaseJws('not-a-jwt', jwks);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'malformed');
});

test('leaseCoversHost matches apex and www, rejects others', () => {
  const claims = { dom: ['www.alexandriatoyota.com', 'alexandriatoyota.com'] };
  assert.equal(leaseCoversHost(claims, 'www.alexandriatoyota.com'), true);
  assert.equal(leaseCoversHost(claims, 'alexandriatoyota.com'), true);
  assert.equal(leaseCoversHost(claims, 'evil.com'), false);
  assert.equal(leaseCoversHost(claims, ''), false);
});
