import { Router } from 'express';
import { requireUser } from '../mw.js';
import { resolveDealer, linkDealer, recordRequest, normalizeHost } from '../dealerships.js';
import { scorePlatform, buildEvidence } from '../fingerprint.js';

const router = Router();

const hits = new Map();
function rateLimited(userId, bucket, { max = 30, windowMs = 3_600_000 } = {}) {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  const rec = hits.get(key) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count += 1;
  hits.set(key, rec);
  return rec.count > max;
}

// Resolve a URL (+ optional client fingerprints) to a supported dealership, or report the
// detected platform. Misses are always recorded for triage.
router.post('/api/dealerships/resolve', requireUser, async (req, res, next) => {
  try {
    if (rateLimited(req.user.id, 'resolve')) {
      res.status(429).json({ ok: false, error: 'too many dealership checks — try again shortly' });
      return;
    }
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

// Link the user to a supported dealership (one per user). Switching is allowed while the
// account has no live paid subscription; after payment the link is locked (409, admin-only).
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
    if (rateLimited(req.user.id, 'request', { max: 10, windowMs: 3_600_000 })) {
      res.status(429).json({ ok: false, error: 'too many requests — try again shortly' });
      return;
    }
    const { url, fingerprints, contactName, contactEmail, contactPhone, notes } = req.body || {};
    let normalizedDomain = null;
    try { normalizedDomain = normalizeHost(url); } catch { /* free-text input is fine */ }
    const { platform } = scorePlatform(buildEvidence(fingerprints));
    const result = await recordRequest(req.user.id, {
      rawInput: url || '',
      normalizedDomain,
      detectedPlatform: platform,
      fingerprints,
      contactName,
      contactEmail,
      contactPhone,
      notes
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
