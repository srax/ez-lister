import express, { Router } from 'express';
import crypto from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, googleConfigured } from '../auth.js';
import { createAuthCode, consumeAuthCode } from '../auth-codes.js';

// The extension auth handshake (see 00-architecture-contract.md "Auth flow"). These three
// endpoints wrap Better Auth's Google OAuth for chrome.identity.launchWebAuthFlow. They are
// registered BEFORE the Better Auth `/api/auth/*` catch-all so they win the route match.

const EXTENSION_ID = process.env.EXTENSION_ID || 'nfpnkiknibofeiicekdehonjmpnonaeh';
const AUTH_ATTEMPT_COOKIE = 'carxpert_extension_auth_attempt';
const AUTH_ATTEMPT_MAX_AGE_SECONDS = 10 * 60;

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

function requestCookie(req, name) {
  const prefix = `${name}=`;
  for (const part of String(req.headers.cookie || '').split(';')) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return '';
}

function authAttemptCookie(req, value, maxAge = AUTH_ATTEMPT_MAX_AGE_SECONDS) {
  const secure = /^https:/i.test(baseUrl(req)) || req.secure;
  return [
    `${AUTH_ATTEMPT_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/api/auth/extension',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Max-Age=${maxAge}`
  ].filter(Boolean).join('; ');
}

function sameAttempt(expected, actual) {
  if (!expected || !actual) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createExtensionAuthRouter({
  authInstance = auth,
  isGoogleConfigured = googleConfigured,
  createCode = createAuthCode,
  consumeCode = consumeAuthCode,
  extensionId = EXTENSION_ID
} = {}) {
  const router = Router();

  // 1) Begin the journey. Bind /finish to this exact OAuth attempt with a short-lived HttpOnly
  // cookie plus a nonce carried inside Better Auth's callback URL. This prevents /finish from
  // minting a bearer code from an ambient older browser session without turning this safe GET
  // endpoint into a cross-site logout primitive.
  router.get('/api/auth/extension/start', async (req, res, next) => {
    try {
      preventAuthCaching(res);
      if (!isGoogleConfigured()) {
        res.status(503).json({ ok: false, error: 'sign-in not configured yet' });
        return;
      }
      const headers = fromNodeHeaders(req.headers);
      const attempt = crypto.randomBytes(32).toString('base64url');
      const callback = new URL(`${baseUrl(req)}/api/auth/extension/finish`);
      callback.searchParams.set('attempt', attempt);
      const r = await authInstance.api.signInSocial({
        // Better Auth's rate limiter resolves the client IP from these forwarded headers.
        // Omitting them collapses every OAuth start into one shared fallback bucket on Railway.
        headers,
        body: { provider: 'google', callbackURL: callback.toString() },
        asResponse: true
      });
      const data = await r.json().catch(() => ({}));
      if (!data.url) {
        res.status(502).json({ ok: false, error: 'no auth url from provider' });
        return;
      }
      const cookies = [authAttemptCookie(req, attempt), ...responseCookies(r)];
      res.setHeader('Set-Cookie', cookies);
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
      const expectedAttempt = requestCookie(req, AUTH_ATTEMPT_COOKIE);
      const actualAttempt = typeof req.query.attempt === 'string' ? req.query.attempt : '';
      res.setHeader('Set-Cookie', authAttemptCookie(req, '', 0));
      if (!sameAttempt(expectedAttempt, actualAttempt)) {
        res.status(401).type('html').send('<p>Sign-in attempt expired. Start again from CarXprt.</p>');
        return;
      }
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
