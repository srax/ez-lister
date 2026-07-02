import { Router } from 'express';
import * as ai from '../ai.js';

const router = Router();

// A0 keeps the legacy shared-secret gate + in-memory rate limit so the AI backend behaves
// exactly as the currently-shipped extension expects. A5 replaces both with bearer auth +
// isEntitled + per-user daily limits (ai_usage), and retires the x-carxpert-token gate.
function gateOk(req) {
  const required = process.env.CARXPERT_TOKEN;
  if (!required) return true;
  return req.get('x-carxpert-token') === required;
}

const RATE = { windowMs: 60000, max: Number(process.env.RATE_MAX || 40), hits: new Map() };
function rateLimited(req) {
  // Behind Railway's proxy the socket address is the proxy for everyone, so key on the
  // client IP (Express resolves req.ip from X-Forwarded-For because trust proxy is set).
  const ip = req.ip || 'local';
  const now = Date.now();
  const rec = RATE.hits.get(ip) || { count: 0, reset: now + RATE.windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + RATE.windowMs; }
  rec.count += 1;
  RATE.hits.set(ip, rec);
  return rec.count > RATE.max;
}

router.post('/api/ai/describe', async (req, res, next) => {
  try {
    if (!gateOk(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (rateLimited(req)) { res.status(429).json({ ok: false, error: 'rate limited — slow down' }); return; }
    const body = req.body || {};
    const description = await ai.describe(body.vehicle || {}, body.options || {});
    res.json({ ok: true, description });
  } catch (err) {
    next(err);
  }
});

router.post('/api/ai/translate', async (req, res, next) => {
  try {
    if (!gateOk(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (rateLimited(req)) { res.status(429).json({ ok: false, error: 'rate limited — slow down' }); return; }
    const body = req.body || {};
    const translated = await ai.translate(body.text || '', body.targetLang || 'en');
    res.json({ ok: true, translated });
  } catch (err) {
    next(err);
  }
});

export default router;
