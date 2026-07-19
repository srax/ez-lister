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
  get(_t, p) {
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
});
