'use strict';

// Dealer Inspire (Cars.com) source extractor. The friendliest platform so far: every SRP card
// carries a `data-vehicle` JSON blob with the full structured record (vin/year/make/model/trim/
// price/color/fuel/stock…), so extraction is a JSON parse — no text scraping. Fields the JSON
// omits (mileage, interior colour, transmission, the full photo gallery) come from the VDP's
// schema.org data via the shared parser. Real photos are on di-uploads-*.dealerinspire.com /
// vehicle-images.carscommerce.inc (the chrome /stock-images/ renders are generic stock — skipped).
//
// Interface on globalThis.CarxpertExtractors.dealerinspire (same shape as the other providers).
// Pure helpers exported via module.exports for node:test.

(function attach(root) {
  const M = root.CarxpertCore;
  const S = () => root.CarxpertSchemaOrg;
  const squish = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const money = (s) => { const n = Number(String(s == null ? '' : s).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined; };
  const plausible = (n) => n && (!M || !M.plausiblePrice || M.plausiblePrice(n));

  // ---- pure helpers (unit-tested) ----
  function parseVehicleJson(raw) {
    try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }
  // A photo URL is a REAL Dealer Inspire vehicle photo (not a chrome stock render / placeholder).
  const DI_PHOTO_HOST = /(?:di-uploads[^/"'\s]*\.dealerinspire\.com|vehicle-images\.carscommerce\.inc)/i;
  const DI_PHOTO_SKIP = /stock-images\/chrome|placeholder|no-image|unavailable|logo|sprite|icon/i;
  const isRealPhoto = (u) => DI_PHOTO_HOST.test(u) && !DI_PHOTO_SKIP.test(u) && /\.(?:jpe?g|png|webp)/i.test(u);
  function photosFromHtml(html, max = 24) {
    const out = []; const seen = new Set();
    const re = /https:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp)/gi;
    let m;
    while ((m = re.exec(String(html || ''))) && out.length < max) {
      const u = m[0];
      if (!isRealPhoto(u)) continue;
      const base = u.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base); out.push(base);
    }
    return out;
  }

  // ---- DOM layer ----
  const cardJson = (card) => parseVehicleJson(card.getAttribute && card.getAttribute('data-vehicle'));
  const cardVin = (card) => ((card.getAttribute && card.getAttribute('data-vehicle-vin')) || cardJson(card).vin || '').toUpperCase();
  const isRealCard = (el) => !!(el && el.getAttribute && el.getAttribute('data-vehicle') && (el.getAttribute('data-vehicle-vin') || /"vin"/i.test(el.getAttribute('data-vehicle') || '')));
  function vdpUrlFor(card) {
    const a = card.querySelector && card.querySelector('a.hit-link[href], a[href*="/inventory/"], a[href*="/vehicle/"]');
    return a ? a.href : '';
  }
  function priceFromCard(card, j) {
    const el = card.querySelector && card.querySelector('.price-block .price, .final-price .price, .price-value, .hit-price .price');
    const rendered = el ? money(el.textContent) : undefined;
    if (plausible(rendered)) return rendered;
    const p = money(j.price) || money(j.msrp);
    return plausible(p) ? p : undefined;
  }
  function photosFromCard(card) {
    const out = []; const seen = new Set();
    for (const img of card.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (!isRealPhoto(src)) continue;
      const base = src.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base); out.push(base);
    }
    return out;
  }

  async function fetchVdp(vdpUrl, photoFallback) {
    const out = { photos: photoFallback || [], ld: {} };
    if (!vdpUrl) return out;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(vdpUrl, { credentials: 'same-origin', signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return out;
      const html = await resp.text();
      out.ld = S() ? S().vehicleFromHtml(html) : {};
      const scraped = photosFromHtml(html);
      const ldPhotos = (out.ld.photos || []).filter(isRealPhoto);
      const richest = [scraped, ldPhotos, out.photos].filter((a) => a && a.length).sort((a, b) => b.length - a.length)[0];
      if (richest && richest.length) out.photos = [...new Set(richest)].slice(0, 24);
      return out;
    } catch { return out; }
  }

  function buildDescription(v) {
    const lines = [];
    lines.push([v.year, v.make, v.model].filter(Boolean).join(' '));
    if (typeof v.mileage === 'number') lines.push(`• Mileage: ${v.mileage.toLocaleString('en-US')} miles`);
    if (v.vin) lines.push(`• VIN: ${v.vin}`);
    if (v.stock) lines.push(`• Stock #: ${v.stock}`);
    if (v.exteriorColor) lines.push(`• Exterior: ${v.exteriorColor}`);
    if (v.interiorColor) lines.push(`• Interior: ${v.interiorColor}`);
    if (v.fuelType) lines.push(`• Fuel: ${v.fuelType}`);
    lines.push('');
    lines.push('Message us to schedule a test drive!');
    if (v.sourceUrl) lines.push(v.sourceUrl);
    return lines.join('\n');
  }

  async function extractVehicle(scope, sourceUrl, ctx = {}) {
    const card = (scope.matches && scope.matches('[data-vehicle]')) ? scope
      : (scope.closest && scope.closest('[data-vehicle]')) || scope;
    const j = cardJson(card);
    const vdpUrl = vdpUrlFor(card) || sourceUrl || (typeof location !== 'undefined' ? location.href : '');
    const cardData = {
      vin: cardVin(card),
      stock: squish(j.stock),
      year: squish(j.year),
      make: squish(j.make),
      model: squish([j.model, j.trim].filter(Boolean).join(' ')),
      price: priceFromCard(card, j),
      mileage: money(j.mileage || j.odometer),
      fuelType: squish(j.fueltype || j.fuel_type),
      bodyType: squish(j.bodystyle || j.body_style || j.body),
      exteriorColor: squish(j.exterior_color),
      interiorColor: squish(j.interior_color),
      transmission: squish(j.transmission)
    };
    const vdp = await fetchVdp(vdpUrl, photosFromCard(card));
    const ld = vdp.ld;
    const fill = (c, l) => (c !== undefined && c !== null && c !== '' ? c : (l || undefined));
    const v = {
      vehicleType: 'Car/Truck',
      vin: cardData.vin || ld.vin || '',
      stock: cardData.stock,
      year: fill(cardData.year, ld.year),
      make: fill(cardData.make, ld.make),
      model: fill(cardData.model, ld.model),
      trim: '',
      price: fill(cardData.price, ld.price),
      mileage: cardData.mileage != null ? cardData.mileage : (ld.mileage != null ? ld.mileage : undefined),
      fuelType: fill(cardData.fuelType, ld.fuelType),
      bodyType: fill(cardData.bodyType, ld.bodyType),
      engine: '',
      exteriorColor: fill(cardData.exteriorColor, ld.exteriorColor),
      interiorColor: fill(cardData.interiorColor, ld.interiorColor),
      exteriorColorGeneric: '',
      transmission: fill(cardData.transmission, ld.transmission) || 'Automatic',
      condition: 'Excellent',
      location: ctx.location || '',
      sourceUrl: vdpUrl,
      photoUrls: vdp.photos,
      photoBaseUrl: '',
      photoExt: 'jpg'
    };
    v.description = buildDescription(v);
    return v;
  }

  const hasCards = () => (typeof document !== 'undefined' && !!document.querySelector('[data-vehicle][data-vehicle-vin]'));
  const hasDiAssets = () => (typeof document !== 'undefined'
    && !!document.querySelector('img[src*="dealerinspire.com"], img[src*="carscommerce.inc"], script[src*="dealerinspire.com"], link[href*="dealerinspire.com"]'));

  root.CarxpertExtractors = root.CarxpertExtractors || {};
  root.CarxpertExtractors.dealerinspire = {
    id: 'dealerinspire',
    detect() { return hasCards() || hasDiAssets(); },
    fingerprints() { return { diVehicleData: hasCards(), diAssets: hasDiAssets() }; },
    findCards() { return [...document.querySelectorAll('[data-vehicle][data-vehicle-vin]')].filter(isRealCard); },
    cardReady() { return true; }, // data-vehicle JSON is present immediately — no lazy render
    cardKey(card) { return cardVin(card) || squish(cardJson(card).stock) || vdpUrlFor(card) || ''; },
    vdpUrlFor,
    extractVehicle,
    // DI detail page: schema.org Vehicle with a VIN and NOT the SRP grid.
    isVdpPage() {
      const v = S() ? S().vehicleFromDocument(document) : {};
      return !!(v && v.vin) && !hasCards();
    },
    vdpVehicleEl() { return (typeof document !== 'undefined' && this.isVdpPage()) ? document.body : null; },
    vdpKey() { const v = S() ? S().vehicleFromDocument(document) : {}; return (v && v.vin ? v.vin.toUpperCase() : '') || (typeof location !== 'undefined' ? location.href : ''); }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseVehicleJson, isRealPhoto, photosFromHtml };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
