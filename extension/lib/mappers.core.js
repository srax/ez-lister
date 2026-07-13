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

  // ---- listing description (single source of truth) ----
  // The ONE description template, shared by the side panel (what the user sees/edits) and
  // dealerContent's ⚡ List save (what the marketplace fill engine posts). Both MUST render
  // identically — they used to diverge (the panel trimmed by prefs while the auto-fill posted the
  // extractor's raw default). Vehicle details (VIN/stock/colours/engine/fuel) are ALWAYS included —
  // that's the full version dealers want posted; emoji, distance unit and the mileage toggle are
  // the only preferences, and they apply to BOTH sides.
  const formatDistance = (mi, unit) => (unit === 'km'
    ? `${Math.round(mi * 1.60934).toLocaleString('en-US')} km`
    : `${Number(mi).toLocaleString('en-US')} miles`);

  function composeDescription(d, prefs) {
    if (!d) return '';
    const p = { emoji: '', unit: 'mi', mileage: true, ...(prefs || {}) };
    const lines = [];
    const title = [d.year, d.make, d.model].filter(Boolean).join(' ');
    lines.push((p.emoji ? p.emoji + ' ' : '') + title);
    if (p.mileage && typeof d.mileage === 'number') lines.push(`• Mileage: ${formatDistance(d.mileage, p.unit)}`);
    if (d.vin) lines.push(`• VIN: ${d.vin}`);
    if (d.stock) lines.push(`• Stock #: ${d.stock}`);
    if (d.exteriorColor) lines.push(`• Exterior: ${d.exteriorColor}`);
    if (d.interiorColor) lines.push(`• Interior: ${d.interiorColor}`);
    if (d.engine) lines.push(`• Engine: ${d.engine}`);
    if (d.fuelType) lines.push(`• Fuel: ${d.fuelType}`);
    lines.push('');
    lines.push('Message us to schedule a test drive!');
    if (d.sourceUrl) lines.push(d.sourceUrl);
    return lines.join('\n');
  }

  // Convert every "<number> <unit>" distance in free text to the target unit, IN PLACE — all
  // other text stays byte-identical. Powers the mi/km switch on the description box: switching
  // units must never regenerate the template (that resurrected wiped text and clobbered custom
  // edits) — it only rewrites the distance tokens. Users type units many ways, so both families
  // are recognized: mi/ml/mls/mile/miles and km/kms/kilometer(s)/kilometre(s), any case.
  // Values already in the target unit are left completely untouched (no reformatting).
  const MILE_WORDS = /^(?:miles|mile|mls|ml|mi)$/i;
  const DIST_RE = /(\d[\d,]*(?:\.\d+)?)(\s*)(kilometers|kilometres|kilometer|kilometre|kms|km|miles|mile|mls|ml|mi)\b/gi;

  function convertDistances(text, toUnit) {
    if (typeof text !== 'string' || !text) return text || '';
    return text.replace(DIST_RE, (whole, num, gap, unitWord) => {
      const isMiles = MILE_WORDS.test(unitWord);
      if ((toUnit === 'km') === !isMiles) return whole; // already in the target unit — untouched
      const value = parseFloat(num.replace(/,/g, ''));
      if (!Number.isFinite(value)) return whole;
      const converted = toUnit === 'km' ? Math.round(value * 1.60934) : Math.round(value / 1.60934);
      return `${converted.toLocaleString('en-US')}${gap}${toUnit === 'km' ? 'km' : 'miles'}`;
    });
  }

  const api = { norm, cleanAttr, plausiblePrice, decodePriceLib, formatDistance, composeDescription, convertDistances };
  root.CarxpertCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
