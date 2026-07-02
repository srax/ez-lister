import crypto from 'node:crypto';

// Constant-time ADMIN_TOKEN gate (header: x-admin-token). No admin route is reachable
// unless ADMIN_TOKEN is configured AND matches. CLI/curl only — no UI.
export function requireAdmin(req, res, next) {
  const required = process.env.ADMIN_TOKEN || '';
  const provided = req.get('x-admin-token') || '';
  if (!required) { res.status(503).json({ ok: false, error: 'admin not configured' }); return; }
  const a = Buffer.from(required);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  next();
}
