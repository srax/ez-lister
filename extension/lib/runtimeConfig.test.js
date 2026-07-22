'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('./runtimeConfig.js');

function memoryStorage(initial = {}) {
  let state = { ...initial };
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in state).map((key) => [key, state[key]]));
    },
    async set(values) { state = { ...state, ...values }; },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    async clear() { state = {}; },
    snapshot() { return { ...state }; }
  };
}

test('same backend preserves user state and refreshes packaged configuration', async () => {
  const storage = memoryStorage({
    ezlistBackendUrl: 'https://staging.example',
    ezlistAuthToken: 'session',
    ezlistBackendToken: 'old'
  });

  const result = await reconcile(storage, {
    backendUrl: 'https://staging.example',
    backendToken: 'new'
  });

  assert.equal(result.changed, false);
  assert.deepEqual(storage.snapshot(), {
    ezlistBackendUrl: 'https://staging.example',
    ezlistAuthToken: 'session',
    ezlistBackendToken: 'new'
  });
});

test('backend change clears credentials, leases, drafts, and workspace state', async () => {
  const storage = memoryStorage({
    ezlistBackendUrl: 'https://production.example',
    ezlistAuthToken: 'production-session',
    ezlistLease: { jws: 'production-lease' },
    ezlistMe: { entitled: true },
    ezlistDraft: { vin: 'VIN' },
    ezlistWorkspaceStores: { production: {} },
    userPreference: 'also cleared'
  });

  const result = await reconcile(storage, { backendUrl: 'https://staging.example' });

  assert.equal(result.changed, true);
  assert.deepEqual(storage.snapshot(), { ezlistBackendUrl: 'https://staging.example' });
});

test('first install records the packaged backend without reporting an environment switch', async () => {
  const storage = memoryStorage();
  const result = await reconcile(storage, { backendUrl: 'http://127.0.0.1:3737' });

  assert.equal(result.changed, false);
  assert.deepEqual(storage.snapshot(), { ezlistBackendUrl: 'http://127.0.0.1:3737' });
});
