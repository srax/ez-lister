import { Router } from 'express';
import { isProduction } from '../env.js';
import { DESCRIBE_MODEL, TRANSLATE_MODEL } from '../ai.js';

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
    models: { describe: DESCRIBE_MODEL, translate: TRANSLATE_MODEL }
  });
});

// Version + kill switch for old extension builds.
router.get('/api/version', (req, res) => {
  res.json({ api: '1', minExtensionVersion: process.env.MIN_EXTENSION_VERSION || null });
});

// Privacy policy — the Chrome Web Store listing links here. Plain static HTML; keep it in
// sync with what the extension actually does before any store re-submission.
router.get('/privacy', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Carxpert — Privacy Policy</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1c1e12}h1{font-size:1.6em}h2{font-size:1.15em;margin-top:1.6em}</style>
</head><body>
<h1>Carxpert Privacy Policy</h1>
<p>Carxpert is a Chrome extension that helps car dealerships re-post their own inventory to
Facebook Marketplace. This policy describes what the extension and its backend service collect
and why.</p>
<h2>What we collect</h2>
<ul>
<li><b>Account:</b> your Google account email and name, used only to sign you in and manage
your subscription.</li>
<li><b>Listing activity:</b> vehicle data you choose to list (VIN, year/make/model, price,
photos URLs from your dealership website) and listing events (published, marked sold), used to
provide sync, sold-detection, and your stats dashboard.</li>
<li><b>AI requests:</b> when you use AI descriptions or translation, the vehicle description
text is sent to OpenAI to generate the result. It is not used to train models.</li>
<li><b>Billing:</b> handled by Stripe. Card details never touch our servers.</li>
</ul>
<h2>What we never collect</h2>
<ul>
<li>No Facebook credentials, cookies, or session data.</li>
<li>No browsing history. Content scripts run only on your dealership website and
facebook.com's vehicle-listing form.</li>
<li>We do not sell or share your data with third parties beyond the processors named above
(OpenAI, Stripe, our hosting provider).</li>
</ul>
<h2>Storage &amp; deletion</h2>
<p>Data is stored on our hosting provider (Railway) in the United States. To delete your
account and associated data, email us and we will remove it within 30 days.</p>
<h2>Contact</h2>
<p>hasnatrao8@gmail.com</p>
</body></html>`);
});

export default router;
