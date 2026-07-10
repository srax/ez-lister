'use strict';

// Dealer.com (Cox Automotive) source extractor. Unlike DealerOn, Dealer.com puts NO vehicle
// data-* attributes on the card — everything is rendered text under `.vehicle-card-description`
// (li.vin / li.stockNumber / li.engine / li.transmission / li.exteriorColor / …), the title
// carries year+model, and the VDP link path carries the make + condition. Photos are opaque
// hashes on pictures.dealer.com with NO sequential numbering, and the SRP carousel lazy-loads
// only the first 1-2 per card — so the full gallery is pulled by fetching the VDP (same-origin,
// so it rides the browser session past Akamai) and scraping every `.../<hash>x.jpg`.
//
// Interface exposed on globalThis.CarxpertExtractors.dealercom mirrors the DealerOn extractor.
// Pure text parsers are also exported via module.exports for node:test (no DOM access at load).

(function attach(root) {
  const M = root.CarxpertCore;

  // ---- pure helpers (unit-tested; string in / value out, no DOM) ----
  const squish = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // "VIN KL4MMFSL6PB119924 " → "KL4MMFSL6PB119924". VINs exclude I/O/Q; take the longest 11-17
  // char run so a stray label word can't win.
  function cleanVin(text) {
    const t = squish(text).replace(/^vin[:\s#]*/i, '');
    const m = t.match(/\b([A-HJ-NPR-Z0-9]{11,17})\b/i);
    return m ? m[1].toUpperCase() : '';
  }

  function parseStockNumber(text) {
    return squish(text).replace(/^stock\s*#?\s*[:]?\s*/i, '').trim();
  }

  // "Black Metallic Exterior" → "Black Metallic"; "EBONY / EBONY ACCENTS Interior" → as-is minus tag.
  function stripColorSuffix(text) {
    return squish(text).replace(/\s*(?:Exterior|Interior)\s*$/i, '').trim();
  }

  // "$25,585" / "25,585" → 25585; junk → undefined.
  function parseMoney(text) {
    const m = squish(text).replace(/[^\d]/g, '');
    return m ? Number(m) : undefined;
  }

  // Title "2023 Buick Encore GX Essence" (+ make hint from the VDP path) → { year, model }.
  // Year is the leading 19xx/20xx token; the make token(s) are dropped so model = the remainder
  // (trim included, matching the DealerOn extractor which also folds trim into model).
  function parseTitleName(title, make) {
    const norm = (s) => String(s).toLowerCase().replace(/-/g, ' ');
    let toks = squish(title).split(' ').filter(Boolean);
    let year = '';
    if (/^(?:19|20)\d{2}$/.test(toks[0] || '')) { year = toks[0]; toks = toks.slice(1); }
    if (make) {
      // Drop the leading make word(s), hyphen-insensitively. A single title token like
      // "Mercedes-Benz" can cover multiple make words ("Mercedes Benz" from the URL path).
      const mk = norm(squish(make)).split(' ').filter(Boolean);
      let mi = 0;
      while (toks.length && mi < mk.length) {
        const parts = norm(toks[0]).split(' ').filter(Boolean);
        if (parts.every((w, i) => mk[mi + i] === w)) { toks = toks.slice(1); mi += parts.length; }
        else break;
      }
    }
    return { year, model: toks.join(' ').trim() };
  }

  // The body style trails the image title/alt: "2023 Buick Encore GX Essence SUV" → "SUV".
  const BODY_WORDS = ['SUV', 'Truck', 'Sedan', 'Coupe', 'Convertible', 'Hatchback', 'Wagon', 'Van', 'Minivan'];
  function bodyFromTitle(title) {
    const toks = squish(title).split(' ');
    for (let i = toks.length - 1; i >= 0; i -= 1) {
      const hit = BODY_WORDS.find((b) => b.toLowerCase() === toks[i].toLowerCase());
      if (hit) return hit;
    }
    return '';
  }

  // VDP path `/used/Buick/2023-Buick-Encore-GX-<uuid>.htm` → make/condition from the path segments.
  function makeFromVdpPath(path) {
    const seg = String(path || '').split('/').filter(Boolean); // [used, Buick, 2023-…htm]
    return seg[1] ? decodeURIComponent(seg[1]).replace(/-/g, ' ').trim() : '';
  }
  function conditionFromVdpPath(path) {
    return /\/new\//i.test(path) ? 'new' : (/\/(?:used|certified|pre-owned)\//i.test(path) ? 'used' : '');
  }

  // Known fuel words can appear as a highlight badge on new cars ("Diesel", "Electric", "Hybrid").
  function fuelFromBadges(badges) {
    const map = { diesel: 'Diesel', electric: 'Electric', hybrid: 'Hybrid', 'plug-in hybrid': 'Plug-in hybrid' };
    for (const b of badges || []) {
      const k = squish(b).toLowerCase();
      if (map[k]) return map[k];
    }
    return '';
  }

  // Collapse a photo URL to its stable base (drop the resize query) then request a clean large
  // render — so duplicate thumb/full URLs of the same shot dedupe to one.
  function normalizePhoto(url) {
    const base = String(url || '').split('?')[0];
    return base ? `${base}?impolicy=downsize_bkpt&w=1200` : '';
  }

  // Every gallery image on a Dealer.com page (SRP card or VDP HTML) is pictures.dealer.com/c/…x.jpg.
  // Match up to `.jpg` (before any ?query), dedupe by base, preserve document order, cap the count.
  function extractPhotoUrlsFromHtml(html, max = 24) {
    const out = [];
    const seen = new Set();
    const re = /https:\/\/pictures\.dealer\.com\/c\/[^\s"'<>\\)]+?\.jpg/gi;
    let m;
    while ((m = re.exec(String(html || ''))) && out.length < max) {
      const base = m[0].split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      out.push(normalizePhoto(base));
    }
    return out;
  }

  // ---- DOM layer (only runs in the content script) ----
  const text = (el) => squish(el && el.textContent);
  const isRealCard = (li) => li
    && !li.classList.contains('placeholder-card')
    && !li.hasAttribute('data-promo-id')
    && !!li.querySelector('.vehicle-card-title');

  function vdpUrlFor(card) {
    const a = card.querySelector('h2.vehicle-card-title a, .vehicle-card-title-container a, a.modern-my-cars-details-label');
    return a ? a.href : '';
  }

  function cardVin(card) {
    return cleanVin(text(card.querySelector('.vehicle-card-description .vin, li.vin')));
  }

  function priceFromCard(card) {
    const ok = (n) => n && (!M || !M.plausiblePrice || M.plausiblePrice(n));
    const money = (sel) => { const n = parseMoney(text(card.querySelector(sel))); return ok(n) ? n : undefined; };
    // Used cars: the clean advertised "Price" (askingPrice), which excludes fees.
    const asking = money('dd.askingPrice .price-value');
    if (asking) return asking;
    // New cars (or themes without askingPrice): the dealer's PROMOTED final price = the last
    // POSITIVE figure in the ladder (MSRP → discount(s) → final, e.g. Cronic's "$43,055" after a
    // "-$4,000" discount). Scope to .pricing-detail so payment estimates don't leak in.
    const dl = card.querySelector('.pricing-detail') || card;
    const positives = [...dl.querySelectorAll('.price-value')]
      .map((el) => ({ t: text(el), n: parseMoney(text(el)) }))
      .filter((o) => ok(o.n) && !/^\s*[-(]|\bsave\b/i.test(o.t)); // skip "-$4,000" / "($4,000)" / "Save $…"
    return positives.length ? positives[positives.length - 1].n : undefined;
  }

  function photosFromCard(card) {
    const urls = [];
    const seen = new Set();
    for (const img of card.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!/pictures\.dealer\.com\/c\//i.test(src)) continue;
      const base = src.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      urls.push(normalizePhoto(base));
    }
    return urls;
  }

  // Pull the VIN out of raw VDP HTML — SRP cards don't always print it (new-car themes omit it),
  // but the detail page always does: the schema.org field first, then a labelled 17-char VIN.
  function vinFromHtml(html) {
    const h = String(html || '');
    const m = h.match(/vehicleIdentificationNumber"\s*:\s*"([A-HJ-NPR-Z0-9]{11,17})"/i)
      || h.match(/\bVIN\b[^A-Za-z0-9]{0,10}([A-HJ-NPR-Z0-9]{17})\b/i);
    return m ? m[1].toUpperCase() : '';
  }

  // One VDP fetch (same-origin → browser session → clears Akamai) yields the VIN, the full photo
  // gallery, and the JSON-LD gap-fill record (via the shared, platform-agnostic schema.org parser).
  // Photos: prefer the pictures.dealer.com scrape (most complete), fall back to the SRP-loaded 1-2,
  // then the JSON-LD image array.
  async function fetchVdp(vdpUrl, photoFallback) {
    const out = { vin: '', photos: photoFallback || [], ld: {} };
    if (!vdpUrl) return out;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(vdpUrl, { credentials: 'same-origin', signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return out;
      const html = await resp.text();
      out.ld = (root.CarxpertSchemaOrg ? root.CarxpertSchemaOrg.vehicleFromHtml(html) : {});
      out.vin = out.ld.vin || vinFromHtml(html);
      const gallery = extractPhotoUrlsFromHtml(html);
      if (gallery.length >= out.photos.length && gallery.length) out.photos = gallery;
      else if (!out.photos.length && out.ld.photos && out.ld.photos.length) out.photos = out.ld.photos.map(normalizePhoto);
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
    if (v.engine) lines.push(`• Engine: ${v.engine}`);
    if (v.fuelType) lines.push(`• Fuel: ${v.fuelType}`);
    lines.push('');
    lines.push('Message us to schedule a test drive!');
    if (v.sourceUrl) lines.push(v.sourceUrl);
    return lines.join('\n');
  }

  async function extractVehicle(scope, sourceUrl, ctx = {}) {
    const card = (scope.matches && scope.matches('.vehicle-card[data-uuid]')) ? scope : (scope.closest && scope.closest('.vehicle-card[data-uuid]')) || scope;
    const vdpUrl = vdpUrlFor(card) || sourceUrl || location.href;
    const vdpPath = (() => { try { return new URL(vdpUrl, location.href).pathname; } catch { return vdpUrl; } })();

    const titleText = text(card.querySelector('.vehicle-card-title a, .vehicle-card-title'));
    const make = makeFromVdpPath(vdpPath);
    const { year, model } = parseTitleName(titleText, make);

    const desc = (sel) => text(card.querySelector(`.vehicle-card-description ${sel}, ${sel}`));
    const badges = [...card.querySelectorAll('.vehicle-card-highlight .highlight-badge')].map(text);
    const mileageBadge = badges.find((b) => /mile/i.test(b));

    const imgTitle = (card.querySelector('.vehicle-card-media img[title], .vehicle-card-media-container img[title]') || {}).title || '';

    // Read whatever the card offers (some themes are sparse — new-car cards omit the VIN, etc.),
    // then fetch the DETAIL PAGE and let it fill every gap. The card wins where it has a value; the
    // VDP's schema.org record supplies the rest, and always the VIN + full photo gallery.
    const cardData = {
      vin: cardVin(card),
      stock: parseStockNumber(desc('.stockNumber')),
      year,
      make,
      model,
      price: priceFromCard(card),
      mileage: mileageBadge ? (Number(String(mileageBadge).replace(/[^\d]/g, '')) || undefined) : undefined,
      fuelType: fuelFromBadges(badges),
      bodyType: bodyFromTitle(imgTitle || titleText),
      engine: squish(desc('.engine') || desc('.normalEngine')).replace(/\s*Engine\s*$/i, '').trim(),
      exteriorColor: stripColorSuffix(desc('.exteriorColor')),
      interiorColor: stripColorSuffix(desc('.interiorColor')),
      transmission: squish(desc('.transmission'))
    };
    const vdp = await fetchVdp(vdpUrl, photosFromCard(card));
    const ld = vdp.ld;
    const fill = (cardVal, ldVal) => (cardVal !== undefined && cardVal !== null && cardVal !== '' ? cardVal : (ldVal || undefined));

    const v = {
      vehicleType: 'Car/Truck',
      vin: cardData.vin || vdp.vin,
      stock: cardData.stock,
      year: fill(cardData.year, ld.year),
      make: fill(cardData.make, ld.make),
      model: fill(cardData.model, ld.model),
      trim: '',
      price: fill(cardData.price, ld.price),
      mileage: cardData.mileage != null ? cardData.mileage : (ld.mileage != null ? ld.mileage : undefined),
      fuelType: fill(cardData.fuelType, ld.fuelType),
      bodyType: fill(cardData.bodyType, ld.bodyType),
      engine: cardData.engine,
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

  root.CarxpertExtractors = root.CarxpertExtractors || {};
  root.CarxpertExtractors.dealercom = {
    id: 'dealercom',
    // DDC content framework markers visible to the isolated world (window.DDC itself is MAIN-world
    // only and unreachable here) — `.ddc-content`/ws-inv widgets and the vehicle-card grid.
    detect() {
      return !!document.querySelector('.vehicle-card[data-uuid], .ddc-content, [data-widget-name^="ws-inv"]')
        || /\/(?:used|new|all|certified)-inventory\//i.test(location.pathname);
    },
    fingerprints() {
      return {
        ddcNamespace: !!document.querySelector('.ddc-content, [data-widget-name^="ws-inv"]'),
        vehicleCardUuid: !!document.querySelector('.vehicle-card[data-uuid]'),
        ddcInventoryPath: /\/(?:used|new|all|certified)-inventory\//i.test(location.pathname)
      };
    },
    // Element-agnostic: DDC themes render the card as <li> or <div>; match the class + data-uuid
    // (not the tag) so buttons appear across themes we haven't captured. isRealCard drops
    // placeholder/promo tiles.
    findCards() { return [...document.querySelectorAll('.vehicle-card[data-uuid]')].filter(isRealCard); },
    cardReady(card) {
      // A List button shows on ANY rendered real card (findCards already filtered to real vehicle
      // cards). We do NOT require rich card data — sparse themes are enriched from the detail page
      // at list time. Only skip skeletons that haven't painted yet.
      return !card.querySelector('[data-testid="details-skeleton"], [data-testid="media-skeleton"], .skeleton-shimmer');
    },
    cardKey(card) { return cardVin(card) || (card.querySelector('.stockNumber') ? parseStockNumber(text(card.querySelector('.stockNumber'))) : '') || card.getAttribute('data-uuid') || ''; },
    vdpUrlFor,
    extractVehicle,
    // Dealer.com VDP-page support (single-vehicle) isn't wired yet — the SRP grid is the flow.
    isVdpPage() { return false; },
    vdpVehicleEl() { return null; },
    vdpKey() { return location.href; }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      cleanVin, parseStockNumber, stripColorSuffix, parseMoney, parseTitleName,
      bodyFromTitle, makeFromVdpPath, conditionFromVdpPath, fuelFromBadges,
      normalizePhoto, extractPhotoUrlsFromHtml, vinFromHtml
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
