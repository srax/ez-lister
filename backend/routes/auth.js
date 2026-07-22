import express, { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, googleConfigured } from '../auth.js';
import { createAuthCode, consumeAuthCode } from '../auth-codes.js';

// The extension auth handshake (see 00-architecture-contract.md "Auth flow"). These three
// endpoints wrap Better Auth's Google OAuth for chrome.identity.launchWebAuthFlow. They are
// registered BEFORE the Better Auth `/api/auth/*` catch-all so they win the route match.

const EXTENSION_ID = process.env.EXTENSION_ID || 'nfpnkiknibofeiicekdehonjmpnonaeh';

function baseUrl(req) {
  return process.env.BETTER_AUTH_URL || `${req.protocol}://${req.get('host')}`;
}

function responseCookies(response) {
  return response && response.headers && response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [];
}

function preventAuthCaching(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function createExtensionAuthRouter({
  authInstance = auth,
  isGoogleConfigured = googleConfigured,
  createCode = createAuthCode,
  consumeCode = consumeAuthCode,
  extensionId = EXTENSION_ID
} = {}) {
  const router = Router();

  // 1) Begin the journey. Delete any ambient Better Auth cookie first: /finish must only be
  // able to observe the session created by this OAuth attempt, never a previous account's
  // surviving cookie on a shared computer. Then forward both the deletion and OAuth-state
  // cookies while redirecting to Google.
  router.get('/api/auth/extension/start', async (req, res, next) => {
    try {
      preventAuthCaching(res);
      if (!isGoogleConfigured()) {
        res.status(503).json({ ok: false, error: 'sign-in not configured yet' });
        return;
      }
      const headers = fromNodeHeaders(req.headers);
      const signedOut = await authInstance.api.signOut({ headers, asResponse: true });
      const r = await authInstance.api.signInSocial({
        // Better Auth's rate limiter resolves the client IP from these forwarded headers.
        // Omitting them collapses every OAuth start into one shared fallback bucket on Railway.
        headers,
        body: { provider: 'google', callbackURL: `${baseUrl(req)}/api/auth/extension/finish` },
        asResponse: true
      });
      const cookies = [...responseCookies(signedOut), ...responseCookies(r)];
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

  // Browser-cookie logout is a top-level web-auth navigation so the backend's HttpOnly cookie
  // is actually sent and expired. The extension revokes its separate bearer session first.
  router.get('/api/auth/extension/logout', async (req, res, next) => {
    try {
      preventAuthCaching(res);
      const r = await authInstance.api.signOut({
        headers: fromNodeHeaders(req.headers),
        asResponse: true
      });
      const cookies = responseCookies(r);
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.redirect(`https://${extensionId}.chromiumapp.org/?signed_out=1`);
    } catch (err) {
      next(err);
    }
  });

  // 2) Better Auth redirects here after the Google callback set the new session cookie. Mint a
  // single-use 60s code and 302 to the extension's chromiumapp URL. Never the token.
  router.get('/api/auth/extension/finish', async (req, res, next) => {
    try {
      preventAuthCaching(res);
      const session = await authInstance.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session || !session.user) {
        res.status(401).type('html').send('<p>Sign-in failed. You can close this window.</p>');
        return;
      }
      const code = await createCode(session.user.id);
      res.redirect(`https://${extensionId}.chromiumapp.org/?code=${encodeURIComponent(code)}`);
    } catch (err) {
      next(err);
    }
  });

  // 3) Extension exchanges the one-time code for a bearer session token. The atomic DELETE …
  // RETURNING guarantees single-use (only one caller can consume a code) and drops it on use.
  router.post('/api/auth/extension/exchange', express.json(), async (req, res, next) => {
    try {
      preventAuthCaching(res);
      const code = req.body && req.body.code ? String(req.body.code) : '';
      if (!code) {
        res.status(400).json({ ok: false, error: 'missing code' });
        return;
      }
      const userId = await consumeCode(code);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'invalid or expired code' });
        return;
      }
      const ctx = await authInstance.$context;
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

  return router;
}

export default createExtensionAuthRouter();
