import express, { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, googleConfigured } from '../auth.js';
import { createAuthCode, consumeAuthCode } from '../auth-codes.js';

// The extension auth handshake (see 00-architecture-contract.md "Auth flow"). These three
// endpoints wrap Better Auth's Google OAuth for chrome.identity.launchWebAuthFlow. They are
// registered BEFORE the Better Auth `/api/auth/*` catch-all so they win the route match.

const EXTENSION_ID = process.env.EXTENSION_ID || 'ejagngoidhjkjoadbbijjkpdgelklael';
const router = Router();

function baseUrl(req) {
  return process.env.BETTER_AUTH_URL || `${req.protocol}://${req.get('host')}`;
}

// 1) Begin the journey: kick off Better Auth's Google OAuth and 302 the popup to Google,
//    forwarding the OAuth-state cookie so the callback validates.
router.get('/api/auth/extension/start', async (req, res, next) => {
  try {
    if (!googleConfigured()) {
      res.status(503).json({ ok: false, error: 'sign-in not configured yet' });
      return;
    }
    const r = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: `${baseUrl(req)}/api/auth/extension/finish` },
      asResponse: true
    });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    const data = await r.json().catch(() => ({}));
    if (!data.url) {
      res.status(502).json({ ok: false, error: 'no auth url from provider' });
      return;
    }
    res.redirect(data.url);
  } catch (err) {
    next(err);
  }
});

// 2) Better Auth redirects here after the Google callback set the session cookie. Mint a
//    single-use 60s code and 302 to the extension's chromiumapp URL. Never the token.
router.get('/api/auth/extension/finish', async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session || !session.user) {
      res.status(401).type('html').send('<p>Sign-in failed. You can close this window.</p>');
      return;
    }
    const code = await createAuthCode(session.user.id);
    res.redirect(`https://${EXTENSION_ID}.chromiumapp.org/?code=${encodeURIComponent(code)}`);
  } catch (err) {
    next(err);
  }
});

// 3) Extension exchanges the one-time code for a bearer session token. The atomic DELETE …
//    RETURNING guarantees single-use (only one caller can consume a code) and drops it on use.
router.post('/api/auth/extension/exchange', express.json(), async (req, res, next) => {
  try {
    const code = req.body && req.body.code ? String(req.body.code) : '';
    if (!code) {
      res.status(400).json({ ok: false, error: 'missing code' });
      return;
    }
    const userId = await consumeAuthCode(code);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'invalid or expired code' });
      return;
    }
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(userId, false);
    if (!session || !session.token) {
      res.status(500).json({ ok: false, error: 'could not create session' });
      return;
    }
    res.json({ ok: true, token: session.token });
  } catch (err) {
    next(err);
  }
});

export default router;
