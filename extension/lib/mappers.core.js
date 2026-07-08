'use strict';

// Platform-AGNOSTIC parsing/decoding helpers for the Carxpert content scripts.
// These are the pieces the dealer extractor and EVERY platform adapter share: string
// normalization, feed-value sanitization, price plausibility, and the DealerOn
// data-pricelib decode. No platform taxonomy lives here — per-platform value maps go in
// lib/mappers.<platform>.js (e.g. mappers.fb.js). Loaded before dealerContent.js and every
// *Content.js (see manifest content_scripts order), attached to globalThis.CarxpertCore;
// also exported for node:test. Everything here stays pure + DOM-free.

(function attach(root) {
  const norm = (s) => (s || '').toString().trim().toLowerCase();

  // Dealer feeds sometimes inject raw HTML into data attributes (live-probed: new-car
  // data-extcolor carried a disclaimer link — "Wind Chill Pearl <a role='button'…>").
  // Cut at the first tag and collapse whitespace before any value is used or shown.
  const cleanAttr = (raw) => String(raw == null ? '' : raw).split('<')[0].replace(/\s+/g, ' ').trim();

  // ---- price ----
  const plausiblePrice = (n) => typeof n === 'number' && n >= 1000 && n <= 500000;

  // data-pricelib decodes (base64) to a labelled list: "Internet Price:7495.0;Selling
  // Price:7495.0;reff_Flat Low Price:7495.0;calc_INTERNET PRICE:8490.0". The advertised
  // price is the Selling/Internet entry — NEVER the max: calc_* rows fold in doc fees
  // (taking the max turned a live $7,495 car into $8,490).
  function decodePriceLib(b64) {
    if (!b64) return undefined;
    let txt = '';
    try { txt = atob(b64); } catch { return undefined; }
    const entries = [...txt.matchAll(/([^:;]+):\s*(\d+(?:\.\d+)?)/g)]
      .map((m) => ({ label: m[1].trim().toLowerCase(), value: Math.round(parseFloat(m[2])) }));
    const pick = (re) => {
      const hit = entries.find((e) => re.test(e.label) && plausiblePrice(e.value));
      return hit ? hit.value : undefined;
    };
    return pick(/^selling price$/)
      ?? pick(/^internet price$/)
      ?? pick(/flat low price$/)
      ?? pick(/^msrp$/);
  }

  const api = { norm, cleanAttr, plausiblePrice, decodePriceLib };
  root.CarxpertCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
