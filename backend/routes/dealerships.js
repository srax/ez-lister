import { Router } from 'express';
import { requireUser } from '../mw.js';
import { resolveDealer, linkDealer, recordRequest, normalizeHost } from '../dealerships.js';
import { scorePlatform, buildEvidence } from '../fingerprint.js';

const router = Router();

// Resolve a URL (+ optional client fingerprints) to a supported dealership, or report the
// detected platform. Misses are always recorded for triage.
router.post('/api/dealerships/resolve', requireUser, async (req, res, next) => {
  try {
    const { url, fingerprints } = req.body || {};
    const result = await resolveDealer({ url, fingerprints });
    if (!result.supported) {
      await recordRequest(req.user.id, {
        rawInput: url || '',
        normalizedDomain: result.normalizedDomain,
        detectedPlatform: result.detectedPlatform,
        fingerprints
      });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Link the user to a supported dealership (one per user; switching is admin-only).
router.post('/api/dealerships/link', requireUser, async (req, res, next) => {
  try {
    const dealershipId = req.body && req.body.dealershipId;
    if (!dealershipId) { res.status(400).json({ ok: false, error: 'dealershipId required' }); return; }
    const result = await linkDealer(req.user.id, dealershipId);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Explicitly record an unsupported-dealership request for triage.
router.post('/api/dealerships/request', requireUser, async (req, res, next) => {
  try {
    const { url, fingerprints } = req.body || {};
    let normalizedDomain = null;
    try { normalizedDomain = normalizeHost(url); } catch { /* free-text input is fine */ }
    const { platform } = scorePlatform(buildEvidence(fingerprints));
    const result = await recordRequest(req.user.id, {
      rawInput: url || '',
      normalizedDomain,
      detectedPlatform: platform,
      fingerprints
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
