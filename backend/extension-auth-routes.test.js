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

test('extension sign-in binds its callback to a fresh attempt without signing out ambient sessions', async () => {
  const calls = [];
  let callbackURL = '';
  const authInstance = {
    api: {
      async signInSocial(options) {
        calls.push('signInSocial');
        callbackURL = options.body.callbackURL;
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
    assert.equal(cookies.some((cookie) => cookie.startsWith('carxpert_extension_auth_attempt=')), true);
    assert.equal(cookies.some((cookie) => cookie.includes('better-auth.state=next-state')), true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  assert.deepEqual(calls, ['signInSocial']);
  const callback = new URL(callbackURL);
  assert.equal(callback.pathname, '/api/auth/extension/finish');
  assert.match(callback.searchParams.get('attempt'), /^[A-Za-z0-9_-]{40,}$/);
});

test('extension finish rejects a stale ambient session without the matching OAuth attempt', async () => {
  let sessionReads = 0;
  let codes = 0;
  const authInstance = {
    api: {
      async getSession() {
        sessionReads += 1;
        return { user: { id: 'ambient-user' } };
      }
    }
  };
  const router = createExtensionAuthRouter({
    authInstance,
    createCode: async () => { codes += 1; return 'should-not-exist'; }
  });

  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/extension/finish?attempt=attacker-value`, {
      headers: { Cookie: '__Secure-better-auth.session_token=old-session' },
      redirect: 'manual'
    });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /attempt expired/i);
    assert.equal(response.headers.getSetCookie().some((cookie) =>
      cookie.startsWith('carxpert_extension_auth_attempt=') && cookie.includes('Max-Age=0')
    ), true);
  });
  assert.equal(sessionReads, 0);
  assert.equal(codes, 0);
});

test('extension finish mints a code only for the matching OAuth attempt', async () => {
  const authInstance = {
    api: {
      async getSession() { return { user: { id: 'new-user' } }; }
    }
  };
  const router = createExtensionAuthRouter({
    authInstance,
    createCode: async (userId) => userId === 'new-user' ? 'single-use-code' : '' ,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });

  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/extension/finish?attempt=matching-attempt`, {
      headers: { Cookie: 'carxpert_extension_auth_attempt=matching-attempt' },
      redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?code=single-use-code'
    );
  });
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
