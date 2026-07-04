import { fromNodeHeaders } from 'better-auth/node';
import { auth } from './auth.js';

// Bearer → Better Auth session → req.user. The bearer plugin lets getSession resolve an
// `Authorization: Bearer <session token>` header (what the extension sends on every call).
export async function requireUser(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session || !session.user) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    req.user = session.user;
    req.session = session.session;
    next();
  } catch (err) {
    next(err);
  }
}
