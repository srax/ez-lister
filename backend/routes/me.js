import { Router } from 'express';
import { requireUser } from '../mw.js';
import { isEntitled, issueLease } from '../entitlement/index.js';
import { getUserDealership } from '../dealerships.js';

const router = Router();

// Profile + dealership + entitlement + a fresh lease when entitled. The extension gates on
// `entitled`/`reason` (which step to show) and verifies `lease` locally before paid actions.
router.get('/api/me', requireUser, async (req, res, next) => {
  try {
    const [ent, dealership] = await Promise.all([
      isEntitled(req.user.id),
      getUserDealership(req.user.id)
    ]);

    let lease = null;
    if (ent.entitled && dealership) {
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
      dealership,
      entitled: ent.entitled,
      reason: ent.reason,
      subscription: ent.periodEnd ? { periodEnd: ent.periodEnd } : null,
      lease
    });
  } catch (err) {
    next(err);
  }
});

export default router;
