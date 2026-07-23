'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'sidepanel.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'sidepanel.js'), 'utf8');

test('stats UI reports dealership outcomes without revenue or personal-sale controls', () => {
  assert.match(html, /Vehicles sold at dealership/);
  assert.match(html, /Dealership activity/);
  assert.match(html, /lib\/dealershipStats\.js/);
  assert.doesNotMatch(html, /gross sales|st-gross|Sold at FB|Sold at Craigslist|Sales overview/i);
  assert.doesNotMatch(js, /function markSold|data-key=.*Mark sold|Sold on \$\{/);
});

test('stats UI retains scanner source and avoids marketplace sale attribution', () => {
  assert.match(js, /soldSource: r\.sold_source/);
  assert.match(js, /DealershipStats\.isDealershipSold/);
  assert.match(js, /sold at dealership/);
  assert.doesNotMatch(js, /soldPlatform === platform/);
  assert.doesNotMatch(js, /member\.soldAtDealership/);
});
