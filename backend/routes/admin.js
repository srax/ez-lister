import { Router } from 'express';
import { requireAdmin } from '../admin.js';
import { fillAccuracy, recentFills, extractionQuality } from '../listings-admin.js';
import { notifyDealerRequest, emailConfigured } from '../email.js';
import { runScanCycle } from '../worker/soldScan.js';
import {
  listDealerRequests, createDealership, adminLink, adminUnlink, recentScans, compGrant, compRevoke,
  overview
} from '../admin-ops.js';
import {
  approveClaim, decideClaim, recordClaimEvidence, restoreClaimHold
} from '../claims.js';
import { pool } from '../db.js';
import { recoverOrganizationOwner } from '../organization-recovery.js';

// ADMIN_TOKEN-gated ops (constant-time gate). CLI/curl only — no UI. Every /api/admin/*
// route is behind requireAdmin (body parsed globally).
const router = Router();
router.use('/api/admin', requireAdmin);

router.get('/api/admin/overview', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await overview()) });
  } catch (err) { next(err); }
});

// Send a sample dealer-request email to EMAIL_TO_ADMIN — verifies the Resend config end-to-end.
// `configured` reports whether RESEND_API_KEY/EMAIL_FROM/EMAIL_TO_ADMIN are all set.
router.post('/api/admin/test-email', async (req, res, next) => {
  try {
    const result = await notifyDealerRequest({
      url: 'https://www.example-dealer.com/',
      normalizedDomain: 'example-dealer.com',
      platform: 'unknown / unsupported',
      contactName: 'Test Requester',
      contactEmail: 'test@example.com',
      contactPhone: '555-0100',
      notes: 'This is a CarXprt test email — the dealer-request notification is working.',
      accountEmail: 'admin-test@carxprt.com',
      at: new Date().toISOString()
    });
    res.json({ ok: true, configured: emailConfigured(), result });
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

router.get('/api/admin/claims', async (req, res, next) => {
  try {
    const statuses = String(req.query.status || 'pending,evidence_requested,approved,checkout_pending,disputed,suspended')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const { rows } = await pool.query(
      `select c.*, d.name as dealership_name, u.email as user_email, u.name as user_name
         from dealership_claims c
         join dealerships d on d.id=c.dealership_id
         join "user" u on u.id=c.user_id
        where c.status=any($1)
        order by c.created_at asc limit $2`,
      [statuses, limit]
    );
    res.json({ ok: true, claims: rows });
  } catch (err) { next(err); }
});

router.post('/api/admin/claims/:id/approve', async (req, res, next) => {
  try {
    const claim = await approveClaim(req.params.id, {
      actor: 'admin:token',
      reason: (req.body || {}).reason,
      includedSeats: (req.body || {}).includedSeats ?? 10
    });
    res.json({ ok: true, claim });
  } catch (err) { next(err); }
});

router.post('/api/admin/claims/:id/decision', async (req, res, next) => {
  try {
    const claim = await decideClaim(req.params.id, {
      status: (req.body || {}).status,
      actor: 'admin:token',
      reason: (req.body || {}).reason
    });
    res.json({ ok: true, claim });
  } catch (err) { next(err); }
});

router.post('/api/admin/claims/:id/evidence', async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, ...(await recordClaimEvidence(req.params.id, {
      type: (req.body || {}).type,
      summary: (req.body || {}).summary,
      actor: 'admin:token'
    })) });
  } catch (err) { next(err); }
});

router.post('/api/admin/claims/:id/restore', async (req, res, next) => {
  try {
    res.json({ ok: true, claim: await restoreClaimHold(req.params.id, {
      actor: 'admin:token',
      reason: (req.body || {}).reason
    }) });
  } catch (err) { next(err); }
});

router.post('/api/admin/organizations/:id/recover-owner', async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json({ ok: true, ...(await recoverOrganizationOwner(req.params.id, {
      targetUserId: body.targetUserId || null,
      targetEmail: body.targetEmail || null,
      actor: 'admin:token',
      reason: body.reason
    })) });
  } catch (err) { next(err); }
});

export default router;
