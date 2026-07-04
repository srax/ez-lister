import { Router } from 'express';
import { isProduction } from '../env.js';
import { DESCRIBE_MODEL, TRANSLATE_MODEL, TRANSLATE_MODEL_STRONG } from '../ai.js';

const router = Router();

// Liveness — DB-free so the Railway healthcheck passes even mid-migration. Minimal in
// production (no key/model details leaked); verbose in dev for quick sanity.
router.get('/health', (req, res) => {
  if (isProduction()) {
    res.json({ ok: true });
    return;
  }
  res.json({
    ok: true,
    service: 'carxpert-backend',
    ai: Boolean(process.env.OPENAI_API_KEY),
    models: { describe: DESCRIBE_MODEL, translate: TRANSLATE_MODEL, translateStrong: TRANSLATE_MODEL_STRONG }
  });
});

// Version + kill switch for old extension builds.
router.get('/api/version', (req, res) => {
  res.json({ api: '1', minExtensionVersion: process.env.MIN_EXTENSION_VERSION || null });
});

export default router;
