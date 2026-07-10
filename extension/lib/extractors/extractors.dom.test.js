'use strict';

// DOM-level regression + ISOLATION tests for the source extractors, run against the real captured
// cards (see _fixtures/). This is the guard that keeps a NEW provider from ever hurting an
// existing one: it proves each provider (a) claims ONLY its own pages — detect() is mutually
// exclusive — and (b) still extracts every field correctly. Add a fixture + a block here whenever
// you add a provider, and DealerOn/Dealer.com stay locked.
//
// jsdom is an OPTIONAL devDependency: if it isn't installed the whole file skips, so the pure
// `npm test` suite still runs everywhere. `npm i` (with devDependencies) enables it in CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* optional — file self-skips below */ }
const maybe = (name, fn) => test(name, JSDOM ? fn : { skip: 'jsdom not installed (npm i to enable DOM tests)' }, JSDOM ? undefined : () => {});

// Load the pure decoders + BOTH extractors onto globalThis (as the manifest does in the browser).
require('../mappers.core.js');
require('./dealeron.js');
require('./dealercom.js');
const EX = globalThis.CarxpertExtractors;

const fixture = (f) => fs.readFileSync(path.join(__dirname, '_fixtures', f), 'utf8');

// Point the content-script globals at a jsdom page, run fn, restore.
async function onPage(html, url, fn) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  const saved = { window: global.window, document: global.document, location: global.location, fetch: global.fetch, AbortController: global.AbortController };
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.AbortController = dom.window.AbortController || global.AbortController;
  try { return await fn(dom); }
  finally { Object.assign(global, saved); }
}

// The dispatcher's provider pick, mirrored (dealerContent.js): most-specific first, DealerOn last.
const pick = () => [EX.dealercom, EX.dealeron].find((p) => p && p.detect()) || EX.dealeron;

// ---------------------------------------------------------------- DealerOn
maybe('DealerOn: detect() claims the page, Dealer.com does NOT (isolation)', async () => {
  await onPage(fixture('dealeron-srp-card.html'), 'https://downtown.chevyman.com/searchall.aspx', () => {
    assert.equal(EX.dealeron.detect(), true);
    assert.equal(EX.dealercom.detect(), false, 'Dealer.com must never claim a DealerOn page');
    assert.equal(pick().id, 'dealeron');
  });
});

maybe('DealerOn: extractVehicle reads every field off the data-* attributes', async () => {
  await onPage(fixture('dealeron-srp-card.html'), 'https://downtown.chevyman.com/searchall.aspx', async () => {
    const cards = EX.dealeron.findCards();
    assert.equal(cards.length, 1);
    const v = await EX.dealeron.extractVehicle(cards[0], EX.dealeron.vdpUrlFor(cards[0]), { location: 'Birmingham, AL' });
    assert.equal(v.vin, '1GNDS13S442354300');
    assert.equal(v.make, 'Chevrolet');
    assert.equal(v.model, 'Trailblazer LS');
    assert.equal(v.year, '2004');
    assert.equal(v.price, 3000); // decodePriceLib → Selling Price
    assert.equal(v.mileage, 161214);
    assert.equal(v.bodyType, 'SUV');
    assert.equal(v.fuelType, 'Gasoline Fuel');
    assert.equal(v.transmission, 'Automatic');
    assert.equal(v.exteriorColor, 'Silverstone Metallic');
    assert.equal(v.stock, '42354300');
    assert.equal(v.condition, 'Excellent');
    assert.equal(v.location, 'Birmingham, AL');
    assert.match(v.photoBaseUrl, /\/inventoryphotos\/23664\/1gnds13s442354300\/ip\/$/i);
  });
});

// ---------------------------------------------------------------- Dealer.com
maybe('Dealer.com: detect() claims the page, DealerOn does NOT (isolation)', async () => {
  await onPage(fixture('dealercom-srp-card.html'), 'https://www.attleborochevrolet.com/used-inventory/index.htm', () => {
    assert.equal(EX.dealercom.detect(), true);
    assert.equal(EX.dealeron.detect(), false, 'DealerOn must never claim a Dealer.com page');
    assert.equal(pick().id, 'dealercom');
  });
});

maybe('Dealer.com: extractVehicle reads rendered text + fetches the gallery', async () => {
  await onPage(fixture('dealercom-srp-card.html'), 'https://www.attleborochevrolet.com/used-inventory/index.htm', async () => {
    // Stub the VDP fetch with a 3-image gallery (one dupes a card image → deduped to 3 total).
    global.fetch = async () => ({ ok: true, async text() {
      return `<img src="https://pictures.dealer.com/c/chevroletbuickgmcofattleboro/1158/b3788316d5c443d71fe80f1581c3b440x.jpg?w=1920">
              <img src="https://pictures.dealer.com/c/chevroletbuickgmcofattleboro/0484/228473358575cfad360f171df0ea721ax.jpg?w=1920">
              <img src="https://pictures.dealer.com/c/chevroletbuickgmcofattleboro/0099/ccc333dddx.jpg?w=1920">`;
    } });
    const cards = EX.dealercom.findCards();
    assert.equal(cards.length, 1);
    const v = await EX.dealercom.extractVehicle(cards[0], null, { location: 'Attleboro, MA' });
    assert.equal(v.vin, 'KL4MMFSL6PB119924');
    assert.equal(v.make, 'Buick');
    assert.equal(v.model, 'Encore GX Essence');
    assert.equal(v.year, '2023');
    assert.equal(v.price, 25585); // clean "Price", not the fee-inclusive "Adjusted Price"
    assert.equal(v.mileage, 25541);
    assert.equal(v.bodyType, 'SUV');
    assert.equal(v.exteriorColor, 'Black Metallic');
    assert.equal(v.transmission, 'Automatic');
    assert.equal(v.stock, '23019B');
    assert.equal(v.photoUrls.length, 3);
    assert.match(v.sourceUrl, /attleborochevrolet\.com\/used\/Buick\//);
  });
});

// ---- Dealer.com SPARSE card (new-car theme: no VIN on the SRP, discount pricing) → the extractor
// must still show a button (cardReady) and enrich from the detail page's JSON-LD. ----
maybe('Dealer.com: sparse new-car card is button-ready and enriched from the VDP', async () => {
  await onPage(fixture('dealercom-srp-card-sparse.html'), 'https://www.cronicchevroletgriffin.com/all-inventory/index.htm', async () => {
    const card = EX.dealercom.findCards()[0];
    assert.ok(card, 'card found');
    // Button appears even though the card has no VIN.
    assert.equal(EX.dealercom.cardReady(card), true, 'sparse card must be button-ready');

    global.fetch = async () => ({ ok: true, async text() { return fixture('dealercom-vdp.html'); } });
    const v = await EX.dealercom.extractVehicle(card, null, { location: 'Griffin, GA' });

    assert.equal(v.vin, '3GCUDGED9SG279350', 'VIN pulled from the VDP JSON-LD (absent on the card)');
    assert.equal(v.make, 'Chevrolet');
    assert.equal(v.model, 'Silverado 1500 Custom');
    assert.equal(v.year, '2026');
    assert.equal(v.price, 43055, 'promoted "Cronic Price", not MSRP $47,055 or the -$4,000 discount');
    assert.equal(v.stock, 'CV29350');
    assert.equal(v.exteriorColor, 'Sterling Gray Metallic');
    assert.equal(v.transmission, 'Automatic');
    assert.equal(v.bodyType, 'Truck');
    assert.equal(v.photoUrls.length, 3, 'full gallery scraped from the VDP');
    assert.match(v.sourceUrl, /cronicchevroletgriffin\.com\/new\/Chevrolet\//);
  });
});
