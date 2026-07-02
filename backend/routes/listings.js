import { Router } from 'express';
import { requireUser } from '../mw.js';
import { requireEntitled } from '../entitlement/gate.js';
import { syncListings, getListings } from '../listings.js';

const router = Router();

// Sync is AUTH-ONLY (not entitlement) — we always accept the user's data even when their
// subscription lapses. Allow large first batches (first sign-in bulk upload).
router.post('/api/listings/sync', requireUser, async (req, res, next) => {
  try {
    const { listings, events } = req.body || {};
    const result = await syncListings(req.user.id, {
      listings: Array.isArray(listings) ? listings : [],
      events: Array.isArray(events) ? events : []
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Reading listings for the stats view IS entitlement-gated.
router.get('/api/listings', requireUser, requireEntitled, async (req, res, next) => {
  try {
    const listings = await getListings(req.user.id);
    res.json({ ok: true, listings });
  } catch (err) {
    next(err);
  }
});

export default router;
