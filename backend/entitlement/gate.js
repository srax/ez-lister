import { isEntitled } from './index.js';

// Express middleware form of the entitlement seam. Routes that require an active
// subscription (or comp grant) use this; it stays correct once billing agent B fills in
// the real isEntitled(). requireUser must run before it (needs req.user).
export async function requireEntitled(req, res, next) {
  try {
    const ent = await isEntitled(req.user.id);
    if (!ent.entitled) {
      res.status(402).json({ ok: false, error: 'subscription required', reason: ent.reason });
      return;
    }
    req.entitlement = ent;
    next();
  } catch (err) {
    next(err);
  }
}
