import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createExtensionAuthRouter } from './routes/auth.js';

async function withServer(router, run) {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function jsonResponse(body, cookie) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { 'Set-Cookie': cookie } : {})
    }
  });
}

test('extension sign-in clears an ambient session before starting Google OAuth', async () => {
  const calls = [];
  const authInstance = {
    api: {
      async signOut() {
        calls.push('signOut');
        return jsonResponse({ success: true }, '__Secure-better-auth.session_token=; Max-Age=0; Path=/');
      },
      async signInSocial() {
        calls.push('signInSocial');
        return jsonResponse(
          { url: 'https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account' },
          'better-auth.state=next-state; Max-Age=600; Path=/'
        );
      }
    }
  };
  const router = createExtensionAuthRouter({
    authInstance,
    isGoogleConfigured: () => true
  });

  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/extension/start`, {
      headers: { Cookie: '__Secure-better-auth.session_token=old-session' },
      redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account');
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.some((cookie) => cookie.includes('session_token=') && cookie.includes('Max-Age=0')), true);
    assert.equal(cookies.some((cookie) => cookie.includes('better-auth.state=next-state')), true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  assert.deepEqual(calls, ['signOut', 'signInSocial']);
});

test('extension logout expires the browser session and returns to chromiumapp', async () => {
  const authInstance = {
    api: {
      async signOut() {
        return jsonResponse({ success: true }, '__Secure-better-auth.session_token=; Max-Age=0; Path=/');
      }
    }
  };
  const router = createExtensionAuthRouter({
    authInstance,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });

  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/extension/logout`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?signed_out=1'
    );
    assert.equal(response.headers.getSetCookie()[0].includes('Max-Age=0'), true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
