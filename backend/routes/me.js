import { Router } from 'express';
import { requireUser } from '../mw.js';
import { isEntitled } from '../entitlement/index.js';
import { getUserDealership } from '../dealerships.js';

const router = Router();

// Profile + (A2) dealership + (B) subscription/lease. A1 ships the shell: entitlement is
// the stub (never entitled), so lease is always null until the billing agent lands.
router.get('/api/me', requireUser, async (req, res, next) => {
  try {
    const [ent, dealership] = await Promise.all([
      isEntitled(req.user.id),
      getUserDealership(req.user.id)
    ]);
    let lease = null;
    // B: when ent.entitled and a dealership is linked, issueLease(user, dealership).
    void ent;

    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
      dealership,
      subscription: null,
      lease
    });
  } catch (err) {
    next(err);
  }
});

export default router;
