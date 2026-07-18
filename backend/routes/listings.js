import { Router } from 'express';
import { requireUser } from '../mw.js';
import { requireEntitled } from '../entitlement/gate.js';
import { syncListings, getListings, getCarsToCheck, recordPresence } from '../listings.js';

const router = Router();

// Sync is AUTH-ONLY (not entitlement) — we always accept the user's data even when their
// subscription lapses. Allow large first batches (first sign-in bulk upload).
router.post('/api/listings/sync', requireUser, async (req, res, next) => {
  try {
    const { listings, events } = req.body || {};
    // Caps: generous for the legit worst case (a first sign-in bulk upload of a whole
    // dealership's inventory is a few hundred rows), tight enough that an abusive payload
    // can't turn one request into tens of thousands of row upserts.
    const result = await syncListings(req.user.id, {
      listings: (Array.isArray(listings) ? listings : []).slice(0, 2000),
      events: (Array.isArray(events) ? events : []).slice(0, 5000)
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

// ---- inventory presence check (Part 1) ----

// What the extension should check: the user's listed cars + their detail-page URLs.
router.get('/api/inventory/to-check', requireUser, async (req, res, next) => {
  try {
    res.json({ ok: true, cars: await getCarsToCheck(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// The extension's per-car verdicts. Body: { reports: [{ clientKey, present: true|false|null, checkedAt }] }.
// Telemetry only for now — updates last_seen / first_missed, never sells.
router.post('/api/inventory/presence', requireUser, async (req, res, next) => {
  try {
    const reports = Array.isArray(req.body && req.body.reports) ? req.body.reports : [];
    const counts = await recordPresence(req.user.id, reports);
    res.json({ ok: true, ...counts });
  } catch (err) {
    next(err);
  }
});

export default router;
