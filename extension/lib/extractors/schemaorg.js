'use strict';

// Universal schema.org vehicle parser — the platform-AGNOSTIC backbone of extraction. Every
// franchise dealer emits schema.org Vehicle/Car/Product JSON-LD on its detail pages for Google/SEO,
// regardless of the CMS (DealerOn, Dealer.com, Cox, CDK, or something we've never seen). So this is
// the great equalizer: the per-provider extractors lean on it to FILL fields a sparse/variant card
// lacks, and the `generic` extractor uses it to list from ANY dealer VDP with structured data.
//
// Pure (no DOM at load): vehicleFromHtml(str) for a fetched VDP, vehicleFromDocument(doc) for the
// live page. Both return a normalized vehicle whose keys match the neutral draft. Exported for
// node:test via module.exports.

(function attach(root) {
  const str = (x) => (x && typeof x === 'object' ? (x.name || x.value || x.url || '') : (x == null ? '' : String(x)));
  const digits = (x) => { const n = Number(String(str(x)).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined; };

  // Collapse the first Vehicle/Car/Product node(s) into one normalized record. Standard schema keys
  // with generous fallbacks; every field is optional (callers merge over card data).
  function normalizeVehicle(nodes) {
    const out = { photos: [] };
    for (const n of (nodes || [])) {
      if (!n || typeof n !== 'object' || !/vehicle|car|product/i.test(String(n['@type'] || ''))) continue;
      if (!out.vin && n.vehicleIdentificationNumber) out.vin = String(n.vehicleIdentificationNumber).toUpperCase().trim();
      if (!out.year) { const y = str(n.vehicleModelDate || n.modelDate || n.productionDate).match(/\d{4}/); if (y) out.year = y[0]; }
      if (!out.make) out.make = str(n.brand || n.manufacturer).trim();
      if (!out.model) out.model = str(n.model).trim();
      if (out.mileage == null) out.mileage = digits(n.mileageFromOdometer);
      if (!out.exteriorColor) out.exteriorColor = str(n.color).trim();
      if (!out.interiorColor) out.interiorColor = str(n.vehicleInteriorColor).trim();
      if (!out.transmission) out.transmission = str(n.vehicleTransmission).trim();
      if (!out.fuelType) out.fuelType = str(n.fuelType).trim();
      if (!out.bodyType) out.bodyType = str(n.bodyType).trim();
      if (out.price == null) { const off = Array.isArray(n.offers) ? n.offers[0] : n.offers; if (off) out.price = digits(off.price || off.lowPrice); }
      if (!out.photos.length) { const img = Array.isArray(n.image) ? n.image : (n.image ? [n.image] : []); out.photos = img.map(str).filter((u) => /^https?:/.test(u)); }
      if (!out.name) out.name = str(n.name).trim();
    }
    return out;
  }

  const flatten = (data) => (Array.isArray(data) ? data : (data && data['@graph'] ? data['@graph'] : [data]));

  function nodesFromHtml(html) {
    const nodes = [];
    const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      for (const x of flatten(data)) nodes.push(x);
    }
    return nodes;
  }

  function nodesFromDocument(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.querySelectorAll) return [];
    const nodes = [];
    for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
      let data; try { data = JSON.parse(s.textContent); } catch { continue; }
      for (const x of flatten(data)) nodes.push(x);
    }
    return nodes;
  }

  // Fetch a detail page's HTML for the VDP extractors. Prefer the BACKGROUND worker — a
  // content-script fetch doesn't reliably carry the site's Cloudflare/Akamai session, so a bare
  // fetch can come back empty/challenged (Dealer Inspire's gallery lives only on the VDP, which
  // exposed this). Fall back to a direct same-origin fetch when the worker isn't reachable (and in
  // node:test, where `fetch` is stubbed and `chrome` is absent).
  async function fetchHtml(url) {
    // Direct same-origin fetch FIRST — it's same-site with the dealer page, so it carries the
    // Cloudflare/Akamai session (a background/worker fetch is cross-site and could be challenged,
    // returning a 200 challenge page that masquerades as success).
    try {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (resp && resp.ok) { const t = await resp.text(); if (t) return t; }
    } catch { /* fall through to the worker */ }
    // Fallback: the background worker, for contexts where the in-page fetch is blocked.
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const r = await chrome.runtime.sendMessage({ type: 'EZLIST_FETCH_HTML', url });
        if (r && r.ok && typeof r.html === 'string') return r.html;
      }
    } catch { /* give up */ }
    return '';
  }

  const api = {
    normalizeVehicle,
    nodesFromHtml,
    nodesFromDocument,
    fetchHtml,
    vehicleFromHtml: (html) => normalizeVehicle(nodesFromHtml(html)),
    vehicleFromDocument: (doc) => normalizeVehicle(nodesFromDocument(doc))
  };
  root.CarxpertSchemaOrg = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
