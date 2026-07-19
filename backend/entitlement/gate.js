import { isEntitled, workspaceEntitlement } from './index.js';
import { getWorkspaceContext } from '../workspaces.js';

// Express middleware form of the entitlement seam. Routes that require an active
// subscription (or comp grant) use this; it stays correct once billing agent B fills in
// the real isEntitled(). requireUser must run before it (needs req.user).
export async function requireEntitled(req, res, next) {
  try {
    const workspaceId = req.get('x-carxpert-workspace-id')
      || (req.query && req.query.workspaceId)
      || (req.body && req.body.workspaceId);
    const dealershipId = req.get('x-carxpert-dealership-id')
      || (req.query && req.query.dealershipId)
      || (req.body && req.body.dealershipId);
    let ent;
    if (workspaceId) {
      const context = await getWorkspaceContext(req.user.id, {
        requestedId: workspaceId,
        dealershipId: dealershipId || null
      });
      ent = await workspaceEntitlement(req.user.id, context.selected, context.rooftop);
    } else {
      ent = await isEntitled(req.user.id);
    }
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
