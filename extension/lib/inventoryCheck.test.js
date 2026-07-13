'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeVdp, checkOne } = require('./inventoryCheck.js');

const VIN = '5XYPG4A36KG550522';

// ---- judgeVdp (pure) ----
test('judgeVdp: 404/410 → gone', () => {
  assert.equal(judgeVdp({ status: 404, html: '', vin: VIN }), 'gone');
  assert.equal(judgeVdp({ status: 410, html: null, vin: VIN }), 'gone');
});

test('judgeVdp: 200 with the VIN → alive (case-insensitive)', () => {
  assert.equal(judgeVdp({ status: 200, html: `<h1>Used ${VIN} car</h1>`, vin: VIN }), 'alive');
  assert.equal(judgeVdp({ status: 200, html: `vin ${VIN.toLowerCase()} here`, vin: VIN }), 'alive');
});

test('judgeVdp: 200 WITHOUT the VIN → gone (e.g. redirected to the search page)', () => {
  assert.equal(judgeVdp({ status: 200, html: '<h1>Search our inventory</h1>', vin: VIN }), 'gone');
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

test('checkOne: 200 without VIN → present false (gone)', async () => {
  const r = await checkOne(async () => resp(200, 'inventory search page'), { sourceUrl: 'https://d/x', vin: VIN });
  assert.equal(r.present, false);
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
