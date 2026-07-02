import { Router } from 'express';
import { requireAdmin } from '../admin.js';
import { fillAccuracy } from '../listings-admin.js';
import {
  listDealerRequests, createDealership, adminLink, adminUnlink, recentScans
} from '../admin-ops.js';

// ADMIN_TOKEN-gated ops (constant-time gate). CLI/curl only — no UI. comp-grant is added by
// billing agent B. Every /api/admin/* route is behind requireAdmin (body parsed globally).
const router = Router();
router.use('/api/admin', requireAdmin);

router.get('/api/admin/fill-accuracy', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({ ok: true, days, ...(await fillAccuracy(days)) });
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

router.get('/api/admin/scans', async (req, res, next) => {
  try {
    res.json({ ok: true, scans: await recentScans(Number(req.query.limit) || 50) });
  } catch (err) { next(err); }
});

export default router;
