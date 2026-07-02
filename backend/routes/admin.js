import { Router } from 'express';
import { requireAdmin } from '../admin.js';
import { fillAccuracy } from '../listings-admin.js';

// ADMIN_TOKEN-gated ops. A3 ships the fill-accuracy eval report; A5 adds dealer-request
// triage, manual link/unlink, comp grants, and recent scans.
const router = Router();

router.get('/api/admin/fill-accuracy', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const report = await fillAccuracy(days);
    res.json({ ok: true, days, ...report });
  } catch (err) {
    next(err);
  }
});

export default router;
