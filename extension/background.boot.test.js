'use strict';

// Regression guard: execute background.js's top level in a stubbed service-worker context and
// assert it doesn't throw synchronously. `node --check` only validates SYNTAX — it cannot catch a
// temporal-dead-zone bug (e.g. calling a function at boot that reads a `const` defined lower in the
// file), which crashes the real SW on registration ("Status code: 15") and hangs every panel↔worker
// message. This test runs the whole file the way Chrome does, importScripts and all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const EXT = __dirname;

// Recursive stub for `chrome`/fetch: any property access or call returns the same stub; it is both
// awaitable and iterable (empty), so top-level `await chrome.x.y()` / for-of never hang or throw.
// `then` must resolve with a NON-thenable (`inert`), otherwise the promise-resolution chain recurses
// forever (resolve(thenable) re-enters then()) and the event loop never drains — the test would hang.
const makeHandler = (thenable) => ({
  get(t, p) {
    if (Reflect.has(t, p)) return Reflect.get(t, p);
    if (p === 'then') return thenable ? (res) => res(inert) : undefined;
    if (p === 'catch' || p === 'finally') return () => stub;
    if (p === Symbol.iterator) return function* () {};
    if (p === Symbol.toPrimitive) return () => '';
    return stub;
  },
  apply() { return stub; }
});
const stub = new Proxy(function () {}, makeHandler(true));
const inert = new Proxy(function () {}, makeHandler(false)); // await result: same surface, not thenable

test('background.js service worker boots without a synchronous throw', () => {
  const sandbox = {
    chrome: stub, fetch: () => stub, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Promise, Object, Array, Math, JSON, Date, Map, Set, Proxy, Symbol,
    TextEncoder, TextDecoder, btoa, atob, Uint8Array, AbortController
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // Faithful importScripts: load each lib into the SAME context, exactly as the SW does at boot.
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), sandbox, { filename: f });
  };

  const code = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(code, sandbox, { filename: 'background.js' }),
    'background.js threw at load — the service worker will fail to register');
  // Sanity: the imported libs actually populated their globals in this context.
  assert.ok(sandbox.CarxpertPlatforms, 'importScripts did not load lib/platforms.js');
  assert.ok(sandbox.CarxpertInventoryCheck, 'importScripts did not load lib/inventoryCheck.js');
  assert.ok(sandbox.CarxpertRuntimeConfig, 'importScripts did not load lib/runtimeConfig.js');
  assert.ok(sandbox.CarxpertFacebookBridge, 'importScripts did not load lib/facebookBridge.js');
});

test('background refresh activates the single eligible dealership workspace', async () => {
  const event = { addListener() {}, removeListener() {} };
  const personalId = 'personal:user-1';
  const organizationId = 'organization:org-1';
  const personalWorkspace = {
    id: personalId, type: 'personal', status: 'active', member: null, rooftops: []
  };
  const organizationWorkspace = {
    id: organizationId,
    type: 'organization',
    status: 'active',
    organization: { id: 'org-1', name: 'Alexandria Motors' },
    member: { id: 'member-1', status: 'active', role: 'owner' },
    rooftops: [{
      status: 'active',
      hasSeat: true,
      role: 'owner',
      dealership: {
        id: 'alexandria-toyota',
        name: 'Alexandria Toyota',
        domains: ['alexandriatoyota.com', 'www.alexandriatoyota.com']
      }
    }]
  };
  const baseMe = {
    user: { id: 'user-1', email: 'owner@example.com' },
    workspaces: [personalWorkspace, organizationWorkspace],
    features: {}
  };
  const personalMe = {
    ...baseMe,
    entitled: false,
    reason: 'no_dealership',
    activeWorkspace: personalWorkspace,
    activeRooftop: null,
    workspaceAccess: { paid: false, canList: false, reason: 'no_dealership', seat: false }
  };
  const organizationMe = {
    ...baseMe,
    entitled: true,
    reason: 'ok',
    activeWorkspace: organizationWorkspace,
    activeRooftop: organizationWorkspace.rooftops[0],
    workspaceAccess: {
      paid: true, canList: true, reason: 'ok', seat: true, role: 'owner', capabilities: ['list']
    }
  };
  const personalContext = {
    workspaceId: personalId,
    dealershipId: null,
    workspaceType: 'personal',
    organizationId: null
  };
  const store = {
    ezlistBackendUrl: 'http://127.0.0.1:3737',
    ezlistAuthToken: 'test-token',
    ezlistOwnerId: 'user-1',
    ezlistWorkspaceSelection: personalContext,
    ezlistWorkspaceSelectionExplicit: false,
    ezlistActiveContext: personalContext,
    ezlistMe: { ...personalMe, fetchedAt: Date.now() }
  };
  const local = {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]));
      }
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
        key, Object.hasOwn(store, key) ? store[key] : fallback
      ]));
    },
    async set(patch) { Object.assign(store, patch); },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
    },
    async clear() {
      for (const key of Object.keys(store)) delete store[key];
    }
  };
  const meRequests = [];
  let meRequestsInFlight = 0;
  let maxMeRequestsInFlight = 0;
  const fetchStub = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/api/me') {
      meRequestsInFlight += 1;
      maxMeRequestsInFlight = Math.max(maxMeRequestsInFlight, meRequestsInFlight);
      try {
        meRequests.push(url.searchParams.get('workspaceId'));
        await new Promise((resolve) => setTimeout(resolve, 2));
        const data = url.searchParams.get('workspaceId') === organizationId
          ? organizationMe
          : personalMe;
        return { ok: true, status: 200, json: async () => structuredClone(data) };
      } finally {
        meRequestsInFlight -= 1;
      }
    }
    if (url.pathname === '/api/listings') {
      return { ok: true, status: 200, json: async () => ({ listings: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const chrome = new Proxy({
    storage: { local, onChanged: event },
    runtime: new Proxy({
      onInstalled: event,
      onStartup: event,
      onMessage: event,
      getManifest: () => ({ version: '0.3.0' })
    }, makeHandler(true)),
    tabs: new Proxy({ onRemoved: event }, makeHandler(true)),
    action: new Proxy({ onClicked: event }, makeHandler(true)),
    alarms: new Proxy({ onAlarm: event }, makeHandler(true)),
    sidePanel: { setPanelBehavior: async () => {} },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}
    },
    permissions: { contains: async () => true }
  }, makeHandler(true));
  const sandbox = {
    chrome,
    fetch: fetchStub,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Promise, Object, Array, Math, JSON, Date, Map, Set, Proxy, Symbol,
    TextEncoder, TextDecoder, btoa, atob, Uint8Array, AbortController,
    crypto: globalThis.crypto,
    structuredClone
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, { filename: file });
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, {
    filename: 'background.js'
  });
  await Promise.all([
    vm.runInContext("refreshMe({ host: 'www.alexandriatoyota.com' })", sandbox),
    vm.runInContext("refreshMe({ host: 'www.alexandriatoyota.com' })", sandbox)
  ]);

  assert.deepEqual(meRequests, [personalId, organizationId, organizationId]);
  assert.equal(maxMeRequestsInFlight, 1, 'concurrent tabs must not race workspace refreshes');
  assert.equal(store.ezlistWorkspaceSelection.workspaceId, organizationId);
  assert.equal(store.ezlistWorkspaceSelection.dealershipId, 'alexandria-toyota');
  assert.equal(store.ezlistWorkspaceSelectionExplicit, false);
  assert.equal(store.ezlistMe.reason, 'ok');
  assert.equal(store.ezlistMe.entitled, true);

  // A second person on the same shared dealership computer may also belong to this organization.
  // Their valid membership must not inherit the previous person's deliberate workspace choice.
  store.ezlistOwnerId = 'previous-user';
  store.ezlistWorkspaceSelectionExplicit = true;
  personalMe.user = { id: 'user-2', email: 'second@example.com' };
  organizationMe.user = personalMe.user;
  await vm.runInContext("refreshMe({ host: 'www.alexandriatoyota.com' })", sandbox);
  assert.equal(store.ezlistOwnerId, 'user-2');
  assert.equal(store.ezlistWorkspaceSelection.workspaceId, organizationId);
  assert.equal(store.ezlistWorkspaceSelectionExplicit, false);
  assert.equal(store.ezlistMe.selectionExplicit, false);
});

test('sign out revokes both auth sessions and clears account-switch state', async () => {
  const event = { addListener() {}, removeListener() {} };
  const store = {
    ezlistBackendUrl: 'http://127.0.0.1:3737',
    ezlistAuthToken: 'bearer-session',
    ezlistMe: { user: { id: 'user-1', email: 'first@example.com' } },
    ezlistLease: { jws: 'lease' },
    ezlistActiveContext: { workspaceId: 'organization:org-1' },
    ezlistWorkspaceSelection: { workspaceId: 'organization:org-1' },
    ezlistWorkspaceSelectionExplicit: true,
    ezlistDealerSeen: { host: 'www.alexandriatoyota.com', ts: Date.now() },
    ezlistOnboardingIntent: 'organization',
    ezlistTeamOnboarding: true,
    ezlistAccessRequestPending: { id: 'request-1' },
    ezlistCheckoutWatch: { startedAt: Date.now() },
    ezlistMarketplaceFlows: { flow: true },
    // Keep the owner marker so the next successful /me can detect an account change and purge
    // the previous user's listing/draft buckets before exposing the app.
    ezlistOwnerId: 'user-1'
  };
  const local = {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]));
      }
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
        key, Object.hasOwn(store, key) ? store[key] : fallback
      ]));
    },
    async set(patch) { Object.assign(store, patch); },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
    },
    async clear() {
      for (const key of Object.keys(store)) delete store[key];
    }
  };
  const requests = [];
  const flows = [];
  const fetchStub = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const chrome = new Proxy({
    storage: { local, onChanged: event },
    runtime: new Proxy({
      onInstalled: event,
      onStartup: event,
      onMessage: event,
      getManifest: () => ({ version: '0.3.0', host_permissions: [] })
    }, makeHandler(true)),
    tabs: new Proxy({ onRemoved: event }, makeHandler(true)),
    action: new Proxy({ onClicked: event }, makeHandler(true)),
    alarms: new Proxy({ onAlarm: event, clear: async () => true }, makeHandler(true)),
    identity: {
      async launchWebAuthFlow(options) {
        flows.push(options);
        return 'https://nfpnkiknibofeiicekdehonjmpnonaeh.chromiumapp.org/?signed_out=1';
      }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}
    },
    permissions: { contains: async () => true }
  }, makeHandler(true));
  const sandbox = {
    chrome,
    fetch: fetchStub,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Promise, Object, Array, Math, JSON, Date, Map, Set, Proxy, Symbol,
    TextEncoder, TextDecoder, btoa, atob, Uint8Array, AbortController,
    crypto: globalThis.crypto,
    structuredClone
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, { filename: file });
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, {
    filename: 'background.js'
  });
  await vm.runInContext('signOut()', sandbox);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:3737/api/auth/sign-out');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer bearer-session');
  assert.equal(flows.length, 1);
  assert.equal(flows[0].url, 'http://127.0.0.1:3737/api/auth/extension/logout');
  assert.equal(flows[0].interactive, false);
  for (const key of [
    'ezlistAuthToken', 'ezlistMe', 'ezlistLease', 'ezlistActiveContext',
    'ezlistWorkspaceSelection', 'ezlistWorkspaceSelectionExplicit', 'ezlistDealerSeen',
    'ezlistOnboardingIntent', 'ezlistTeamOnboarding', 'ezlistAccessRequestPending', 'ezlistCheckoutWatch',
    'ezlistMarketplaceFlows'
  ]) assert.equal(Object.hasOwn(store, key), false, `${key} should be cleared`);
  assert.equal(store.ezlistOwnerId, 'user-1');
});
