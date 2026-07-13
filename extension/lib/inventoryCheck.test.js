'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeVdp, checkOne, looksBlockedOrEmpty } = require('./inventoryCheck.js');

const VIN = '5XYPG4A36KG550522';

// A believable "real removed car / search" page: big, substantive, no VIN, no bot-wall markers.
const REMOVED_PAGE = '<html><head><title>Used Inventory</title></head><body>' +
  '<h1>Browse our used inventory</h1>' + '<p>Sorry, that vehicle is no longer available. Here are similar cars.</p>'.repeat(40) +
  '</body></html>';

// ---- judgeVdp (pure) ----
test('judgeVdp: 404/410 → gone', () => {
  assert.equal(judgeVdp({ status: 404, html: '', vin: VIN }), 'gone');
  assert.equal(judgeVdp({ status: 410, html: null, vin: VIN }), 'gone');
});

test('judgeVdp: 200 with the VIN → alive (case-insensitive)', () => {
  assert.equal(judgeVdp({ status: 200, html: `<h1>Used ${VIN} car</h1>`, vin: VIN }), 'alive');
  assert.equal(judgeVdp({ status: 200, html: `vin ${VIN.toLowerCase()} here`, vin: VIN }), 'alive');
});

test('judgeVdp: 200, no VIN, real substantive page → gone (redirected to search)', () => {
  assert.equal(judgeVdp({ status: 200, html: REMOVED_PAGE, vin: VIN }), 'gone');
});

test('judgeVdp: 200 bot-wall / challenge page (no VIN) → unknown, NEVER gone', () => {
  const cf = '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site. <div class="cf-browser-verification"></div> Cloudflare Ray ID: 1234</body></html>'.padEnd(1200, ' ');
  const akamai = ('<html><body><h1>Access Denied</h1><p>You don\'t have permission to access this resource. Reference #18.abc</p></body></html>').padEnd(1200, ' ');
  const incapsula = ('<html><body>Request unsuccessful. Incapsula incident ID: 999-000</body></html>').padEnd(1200, ' ');
  const datadome = ('<html><body>Please enable JavaScript and cookies to continue. datadome</body></html>').padEnd(1200, ' ');
  assert.equal(judgeVdp({ status: 200, html: cf, vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: 200, html: akamai, vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: 200, html: incapsula, vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: 200, html: datadome, vin: VIN }), 'unknown');
});

test('judgeVdp: 200 empty / tiny body (no VIN) → unknown, NEVER gone', () => {
  assert.equal(judgeVdp({ status: 200, html: '', vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: 200, html: '   ', vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: 200, html: '<html><body>Not found</body></html>', vin: VIN }), 'unknown');
});

test('looksBlockedOrEmpty: substantive real page → false; challenge/tiny → true', () => {
  assert.equal(looksBlockedOrEmpty(REMOVED_PAGE), false);
  assert.equal(looksBlockedOrEmpty(''), true);
  assert.equal(looksBlockedOrEmpty('short'), true);
  assert.equal(looksBlockedOrEmpty('just a moment...'.padEnd(1000, ' ')), true);
});

test('judgeVdp: 5xx / 0 / non-number → unknown (never act)', () => {
  assert.equal(judgeVdp({ status: 500, html: 'err', vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: 503, html: null, vin: VIN }), 'unknown');
  assert.equal(judgeVdp({ status: null, html: 'x', vin: VIN }), 'unknown');
});

test('judgeVdp: 200 but unreadable body → unknown', () => {
  assert.equal(judgeVdp({ status: 200, html: null, vin: VIN }), 'unknown');
});

test('judgeVdp: missing vin → unknown', () => {
  assert.equal(judgeVdp({ status: 200, html: 'anything', vin: '' }), 'unknown');
  assert.equal(judgeVdp({}), 'unknown');
});

// ---- checkOne (orchestration, mocked fetch) ----
const resp = (status, body) => ({ status, async text() { return body; } });

test('checkOne: alive → present true', async () => {
  const r = await checkOne(async () => resp(200, `car ${VIN}`), { sourceUrl: 'https://d/x', vin: VIN });
  assert.deepEqual(r, { present: true, status: 200, verdict: 'alive' });
});

test('checkOne: 404 → present false, no body read', async () => {
  let readBody = false;
  const r = await checkOne(async () => ({ status: 404, async text() { readBody = true; return ''; } }), { sourceUrl: 'https://d/x', vin: VIN });
  assert.equal(r.present, false);
  assert.equal(r.verdict, 'gone');
  assert.equal(readBody, false, '404 should not read the body');
});

test('checkOne: 200, real page without VIN → present false (gone)', async () => {
  const r = await checkOne(async () => resp(200, REMOVED_PAGE), { sourceUrl: 'https://d/x', vin: VIN });
  assert.equal(r.present, false);
  assert.equal(r.verdict, 'gone');
});

test('checkOne: 200 bot-wall (no VIN) → present null (unknown), NEVER gone', async () => {
  const wall = ('<html><title>Just a moment...</title>checking your browser before accessing</html>').padEnd(1200, ' ');
  const r = await checkOne(async () => resp(200, wall), { sourceUrl: 'https://d/x', vin: VIN });
  assert.equal(r.present, null);
  assert.equal(r.verdict, 'unknown');
});

test('checkOne: 5xx → present null (unknown)', async () => {
  const r = await checkOne(async () => resp(503, 'busy'), { sourceUrl: 'https://d/x', vin: VIN });
  assert.equal(r.present, null);
  assert.equal(r.verdict, 'unknown');
});

test('checkOne: fetch throws → present null (error), never throws', async () => {
  const r = await checkOne(async () => { throw new Error('network'); }, { sourceUrl: 'https://d/x', vin: VIN });
  assert.equal(r.present, null);
  assert.equal(r.verdict, 'error');
});

test('checkOne: missing url/vin → present null', async () => {
  assert.equal((await checkOne(async () => resp(200, VIN), { sourceUrl: '', vin: VIN })).present, null);
  assert.equal((await checkOne(async () => resp(200, VIN), { sourceUrl: 'https://d/x', vin: '' })).present, null);
});
