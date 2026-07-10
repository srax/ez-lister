import { Router } from 'express';
import { requireAdmin } from '../admin.js';
import { fillAccuracy, recentFills, extractionQuality } from '../listings-admin.js';
import { runScanCycle } from '../worker/soldScan.js';
import {
  listDealerRequests, createDealership, adminLink, adminUnlink, recentScans, compGrant, compRevoke,
  overview
} from '../admin-ops.js';

// ADMIN_TOKEN-gated ops (constant-time gate). CLI/curl only — no UI. Every /api/admin/*
// route is behind requireAdmin (body parsed globally).
const router = Router();
router.use('/api/admin', requireAdmin);

router.get('/api/admin/overview', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await overview()) });
  } catch (err) { next(err); }
});

router.get('/api/admin/fills', async (req, res, next) => {
  try {
    res.json({ ok: true, fills: await recentFills(Number(req.query.days) || 7) });
  } catch (err) { next(err); }
});

router.get('/api/admin/fill-accuracy', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({ ok: true, days, ...(await fillAccuracy(days)) });
  } catch (err) { next(err); }
});

// Extraction quality per dealer (weakest first) — which dealerships/themes extract poorly, so we
// can fix them without manually testing every dealer on a platform.
router.get('/api/admin/extraction-quality', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({ ok: true, days, ...(await extractionQuality(days)) });
  } catch (err) { next(err); }
});

router.get('/api/admin/dealer-requests', async (req, res, next) => {
  try {
    res.json({ ok: true, requests: await listDealerRequests(Number(req.query.limit) || 100) });
  } catch (err) { next(err); }
});

router.post('/api/admin/dealerships', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await createDealership(req.body || {})) });
  } catch (err) { next(err); }
});

router.post('/api/admin/link', async (req, res, next) => {
  try {
    const { userId, dealershipId } = req.body || {};
    res.json({ ok: true, ...(await adminLink(userId, dealershipId)) });
  } catch (err) { next(err); }
});

router.post('/api/admin/unlink', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await adminUnlink((req.body || {}).userId)) });
  } catch (err) { next(err); }
});

// Fire one scan cycle on demand (ops/debug — e.g. right after a fix, instead of waiting
// for the hourly tick). Same code path as the worker, results returned inline.
router.post('/api/admin/scan-now', async (req, res, next) => {
  try {
    res.json({ ok: true, results: await runScanCycle() });
  } catch (err) { next(err); }
});

router.get('/api/admin/scans', async (req, res, next) => {
  try {
    res.json({ ok: true, scans: await recentScans(Number(req.query.limit) || 50) });
  } catch (err) { next(err); }
});

// Comp grant/revoke by email (billing agent B) — entitlement without Stripe, for friend
// testing. Body: { email, expiresAt?, note?, revoke? }.
router.post('/api/admin/comp', async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json({ ok: true, ...(body.revoke ? await compRevoke(body) : await compGrant(body)) });
  } catch (err) { next(err); }
});

export default router;
