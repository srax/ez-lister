// ENTITLEMENT SEAM — the billing agent (B) implements the real logic; A only consumes it.
// Keep this module's API stable (isEntitled / issueLease / jwksHandler); B replaces the
// internals. Until B lands, no one is entitled and leases can't be issued.

// → { entitled: boolean, reason: 'ok'|'no_subscription'|'expired'|'no_dealership', periodEnd: Date|null }
export async function isEntitled(_userId) {
  return { entitled: false, reason: 'no_subscription', periodEnd: null };
}

// → compact JWS lease string. Throws until B implements signing.
export async function issueLease(_user, _dealership) {
  throw new Error('entitlement/issueLease not implemented yet (billing agent B)');
}

// GET /.well-known/jwks.json — B serves the lease public keys here.
export function jwksHandler(_req, res) {
  res.status(503).json({ ok: false, error: 'jwks not available yet' });
}
