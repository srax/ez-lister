'use strict';

// Offline entitlement-lease verifier for the MV3 background worker. Pure WebCrypto — no
// library — verifying the ES256 (P-256) lease the backend signs (see 00-architecture-contract
// "Entitlement lease"). Attaches to globalThis so background.js can importScripts() it.
(function (root) {
  const LEEWAY = 60; // seconds of clock skew allowed, per the contract

  function b64urlToBytes(s) {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64urlToJson(s) {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  }

  // Split a compact JWS into its parts. Throws on a malformed token.
  function decodeJwt(jws) {
    const parts = String(jws || '').split('.');
    if (parts.length !== 3) throw new Error('malformed lease');
    return {
      header: b64urlToJson(parts[0]),
      payload: b64urlToJson(parts[1]),
      signingInput: `${parts[0]}.${parts[1]}`,
      sig: b64urlToBytes(parts[2])
    };
  }

  // Verify an ES256 lease against a JWKS. Returns { valid, reason, claims }.
  // reason ∈ 'ok'|'malformed'|'alg'|'unknown_kid'|'signature'|'expired'
  async function verifyLeaseJws(jws, jwks) {
    let decoded;
    try { decoded = decodeJwt(jws); } catch { return { valid: false, reason: 'malformed', claims: null }; }
    const { header, payload, signingInput, sig } = decoded;
    if (header.alg !== 'ES256') return { valid: false, reason: 'alg', claims: payload };
    const keys = (jwks && jwks.keys) || [];
    // Match by kid; if the lease carries no kid and there's exactly one key, use it.
    const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : (keys.length === 1 ? keys[0] : null);
    if (!jwk) return { valid: false, reason: 'unknown_kid', claims: payload };
    let ok = false;
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      // JWS ES256 signatures are raw r||s (64 bytes) — exactly what WebCrypto ECDSA verify wants.
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(signingInput));
    } catch { return { valid: false, reason: 'signature', claims: payload }; }
    if (!ok) return { valid: false, reason: 'signature', claims: payload };
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now > payload.exp + LEEWAY) return { valid: false, reason: 'expired', claims: payload };
    return { valid: true, reason: 'ok', claims: payload };
  }

  // Does this lease's dealership domain claim (`dom`) cover the given host? Exact host match,
  // or host is a subdomain of a claimed apex (www.x.com covered by x.com), or vice-versa.
  function leaseCoversHost(claims, host) {
    if (!host) return false;
    const h = String(host).toLowerCase().replace(/^www\./, '');
    const doms = (claims && claims.dom) || [];
    return doms.some((d) => {
      const dd = String(d).toLowerCase().replace(/^www\./, '');
      return h === dd || h.endsWith('.' + dd) || dd.endsWith('.' + h);
    });
  }

  // Seconds until the lease expires (negative if already past). For refresh scheduling.
  function secondsToExpiry(claims) {
    if (!claims || typeof claims.exp !== 'number') return 0;
    return claims.exp - Math.floor(Date.now() / 1000);
  }

  root.CarxpertLease = { decodeJwt, verifyLeaseJws, leaseCoversHost, secondsToExpiry };
})(globalThis);
