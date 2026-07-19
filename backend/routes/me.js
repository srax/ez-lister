import { Router } from 'express';
import { requireUser } from '../mw.js';
import {
  isEntitled,
  issueLease,
  issueWorkspaceLease,
  workspaceEntitlement
} from '../entitlement/index.js';
import { getPendingDealerRequest, getUserDealership } from '../dealerships.js';
import { getWorkspaceContext } from '../workspaces.js';
import { listUserAccessRequests } from '../organizations.js';
import { organizationsEnabled } from '../features.js';

const router = Router();

// Profile + dealership + entitlement + a fresh lease when entitled. The extension gates on
// `entitled`/`reason` (which step to show) and verifies `lease` locally before paid actions.
router.get('/api/me', requireUser, async (req, res, next) => {
  try {
    const [ent, dealership, requestPending, workspaceContext, accessRequests] = await Promise.all([
      isEntitled(req.user.id),
      getUserDealership(req.user.id),
      getPendingDealerRequest(req.user.id),
      getWorkspaceContext(req.user.id, {
        requestedId: req.query.workspaceId || null,
        host: req.query.host || null,
        dealershipId: req.query.dealershipId || null
      }),
      listUserAccessRequests(req.user.id)
    ]);

    const workspaceAccess = await workspaceEntitlement(
      req.user.id,
      workspaceContext.selected,
      workspaceContext.rooftop
    );

    let lease = null;
    if (workspaceContext.selected && workspaceContext.selected.type === 'organization') {
      if (workspaceAccess.canList && workspaceContext.rooftop) {
        try {
          lease = await issueWorkspaceLease(
            { id: req.user.id },
            workspaceContext.selected,
            workspaceContext.rooftop,
            workspaceAccess
          );
        } catch (err) {
          console.error(`/api/me workspace lease issue failed: ${err.message}`);
        }
      }
    } else if (ent.entitled && dealership) {
      // Never let a missing signing key take down /api/me — log and return lease:null so the
      // extension can retry rather than see a hard failure.
      try {
        lease = await issueLease({ id: req.user.id }, dealership);
      } catch (err) {
        console.error(`/api/me lease issue failed: ${err.message}`);
      }
    }

    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
      features: { organizations: organizationsEnabled() },
      dealership,
      requestPending,
      accessRequests,
      workspaces: workspaceContext.workspaces,
      activeWorkspace: workspaceContext.selected,
      activeRooftop: workspaceContext.rooftop,
      workspaceAccess,
      entitled: workspaceContext.selected ? workspaceAccess.entitled : ent.entitled,
      reason: workspaceContext.selected ? workspaceAccess.reason : ent.reason,
      subscription: workspaceAccess.periodEnd ? { periodEnd: workspaceAccess.periodEnd } : null,
      lease
    });
  } catch (err) {
    next(err);
  }
});

export default router;
