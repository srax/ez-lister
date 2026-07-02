import { Router } from 'express';
import * as ai from '../ai.js';
import { requireUser } from '../mw.js';
import { isEntitled } from '../entitlement/index.js';
import { bumpAiUsage } from '../ai-limits.js';

const router = Router();

// AI auth has two modes, selected by AI_AUTH_MODE (default 'token'):
//   token  — the legacy x-carxpert-token shared-secret gate + in-memory per-IP rate limit.
//            This is what the CURRENTLY-SHIPPED extension uses. Default, so nothing breaks.
//   bearer — Better Auth bearer + isEntitled + per-user daily limits (ai_usage). The final
//            A5 state. Flip to this ONLY once billing agent B's entitlement is live AND the
//            extension ships the sign-in flow (otherwise the stub 402s every call). The
//            'retire x-carxpert-token' step is then just AI_AUTH_MODE=bearer + a CORS edit.
const AUTH_MODE = (process.env.AI_AUTH_MODE || 'token').toLowerCase();

// ---- legacy token gate + in-memory rate limit ----
function gateOk(req) {
  const required = process.env.CARXPERT_TOKEN;
  if (!required) return true;
  return req.get('x-carxpert-token') === required;
}
const RATE = { windowMs: 60000, max: Number(process.env.RATE_MAX || 40), hits: new Map() };
function rateLimited(req) {
  const ip = req.ip || 'local'; // trust proxy set → real client IP behind Railway
  const now = Date.now();
  const rec = RATE.hits.get(ip) || { count: 0, reset: now + RATE.windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + RATE.windowMs; }
  rec.count += 1;
  RATE.hits.set(ip, rec);
  return rec.count > RATE.max;
}

// Build the middleware chain for one AI kind based on the mode.
function guards(kind) {
  if (AUTH_MODE === 'bearer') {
    return [
      requireUser,
      async (req, res, next) => {
        try {
          const ent = await isEntitled(req.user.id);
          if (!ent.entitled) { res.status(402).json({ ok: false, error: 'subscription required', reason: ent.reason }); return; }
          const usage = await bumpAiUsage(req.user.id, kind);
          if (usage.limited) { res.status(429).json({ ok: false, error: `daily ${kind} limit reached` }); return; }
          next();
        } catch (err) { next(err); }
      }
    ];
  }
  // token mode
  return [(req, res, next) => {
    if (!gateOk(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (rateLimited(req)) { res.status(429).json({ ok: false, error: 'rate limited — slow down' }); return; }
    next();
  }];
}

router.post('/api/ai/describe', ...guards('describe'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const description = await ai.describe(body.vehicle || {}, body.options || {});
    res.json({ ok: true, description });
  } catch (err) { next(err); }
});

router.post('/api/ai/translate', ...guards('translate'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const translated = await ai.translate(body.text || '', body.targetLang || 'en');
    res.json({ ok: true, translated });
  } catch (err) { next(err); }
});

export default router;
