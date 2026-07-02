import { Router } from 'express';
import { requireUser } from '../mw.js';
import { isEntitled } from '../entitlement/index.js';

const router = Router();

// Profile + (A2) dealership + (B) subscription/lease. A1 ships the shell: entitlement is
// the stub (never entitled), so lease is always null until the billing agent lands.
router.get('/api/me', requireUser, async (req, res, next) => {
  try {
    const ent = await isEntitled(req.user.id);
    let lease = null;
    // B: when ent.entitled and the user has a linked dealership, issueLease(user, dealership).
    void ent;

    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
      dealership: null,
      subscription: null,
      lease
    });
  } catch (err) {
    next(err);
  }
});

export default router;
