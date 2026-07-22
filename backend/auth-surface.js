const BLOCKED_SUBSCRIPTION_ACTIONS = new Set([
  '/api/auth/subscription/upgrade',
  '/api/auth/subscription/cancel',
  '/api/auth/subscription/restore',
  '/api/auth/subscription/billing-portal'
]);

function normalizedPath(value) {
  const path = String(value || '').toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function isManagedAuthRoute(path) {
  const normalized = normalizedPath(path);
  return normalized === '/api/auth/organization'
    || normalized.startsWith('/api/auth/organization/')
    || BLOCKED_SUBSCRIPTION_ACTIONS.has(normalized);
}

// Better Auth remains the implementation behind our adapters, but its generic HTTP
// organization and billing mutations would bypass Carxprt's rooftop verification, roles,
// audited removal, and server-derived Stripe quantities. Internal auth.api calls do not pass
// through Express, so blocking these public paths keeps the plugin lifecycle without exposing
// a second mutation API.
export function blockManagedAuthRoutes(req, res, next) {
  if (!isManagedAuthRoute(req.path)) {
    next();
    return;
  }
  res.status(404).json({ ok: false, error: 'Not found' });
}
