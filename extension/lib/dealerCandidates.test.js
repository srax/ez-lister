'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWebTab, uniqueSeen, uniqueResolved } = require('./dealerCandidates.js');

test('current dealership discovery reads only the active tab in the focused window', async () => {
  let options = null;
  const candidate = await currentWebTab(async (query) => {
    options = query;
    return [{
      id: 42,
      windowId: 7,
      url: 'https://www.vlautosales.com/cars-for-sale',
      active: true
    }];
  }, { now: 12_345 });

  assert.deepEqual(options, { active: true, lastFocusedWindow: true });
  assert.deepEqual(candidate, {
    tabId: 42,
    windowId: 7,
    host: 'www.vlautosales.com',
    url: 'https://www.vlautosales.com/cars-for-sale',
    active: true,
    ts: 12_345
  });
});

test('current dealership discovery rejects browser-internal and inaccessible tabs', async () => {
  assert.equal(await currentWebTab(async () => [{ id: 1, url: 'chrome://extensions' }]), null);
  assert.equal(await currentWebTab(async () => [{ id: 2 }]), null);
});

test('dealer candidates prefer the active tab and dedupe hosts', () => {
  const now = 10_000;
  const result = uniqueSeen([
    { host: 'www.one.example', url: 'https://www.one.example/used', ts: now - 50 },
    { host: 'www.two.example', url: 'https://www.two.example/used', ts: now - 100, active: true },
    { host: 'www.one.example', url: 'https://www.one.example/new', ts: now - 10 }
  ], { now, ttlMs: 1_000 });
  assert.deepEqual(result.map((item) => item.host), ['www.two.example', 'www.one.example']);
  assert.equal(result[1].url, 'https://www.one.example/new');
});

test('dealer candidates discard stale entries and dedupe resolved aliases', () => {
  assert.deepEqual(uniqueSeen([{ host: 'old.example', ts: 1 }], { now: 10_000, ttlMs: 100 }), []);
  const dealer = { id: 'dealer-1', name: 'Dealer One' };
  const resolved = uniqueResolved([
    { ok: true, dealership: dealer, claimed: false },
    { ok: true, dealership: dealer, claimed: true },
    { ok: false },
    { ok: true, dealership: { id: 'dealer-2' }, claimed: false }
  ]);
  assert.deepEqual(resolved.map((item) => item.dealership.id), ['dealer-1', 'dealer-2']);
});
