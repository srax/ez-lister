'use strict';

// DealerOn source extractor — the original ezlist extraction logic, unchanged, now behind the
// shared provider interface (see dealerContent.js dispatcher). Reads each vehicle straight from
// DealerOn's structured data-* attributes (no scraping/regex on visible text); photos come from
// the `/inventoryphotos/<code>/<vin>/(ip|sp)/<n>.<ext>` gallery pattern.
//
// Interface exposed on globalThis.CarxpertExtractors.dealeron:
//   id, detect(), fingerprints(), findCards(), cardReady(card), cardKey(card),
//   vdpUrlFor(card), extractVehicle(scope, sourceUrl, ctx), isVdpPage(), vdpVehicleEl()

(function attach(root) {
  const M = root.CarxpertCore;

  const num = (s) => {
    const m = String(s == null ? '' : s).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Math.round(parseFloat(m[0])) : undefined;
  };
  const attr = (el, names) => {
    for (const n of names) { const v = el.getAttribute && el.getAttribute(n); if (v != null && v !== '') return v; }
    return '';
  };

  // ---- price ----
  // Live-probed: `data-price`/`data-msrp` are often "0" on used cards, and
  // `data-dotagging-item-price` disagrees between SRP and VDP for the same car. The labelled
  // pricelib entry is the site's actual advertised price, so it wins; the other attrs are
  // fallbacks, and page text is the last resort.
  function extractPrice(el) {
    const labeled = M.decodePriceLib(attr(el, ['data-pricelib']));
    if (M.plausiblePrice(labeled)) return labeled;
    const candidates = [
      num(attr(el, ['data-dotagging-item-price'])),
      num(attr(el, ['data-price']))
    ].filter(M.plausiblePrice);
    if (candidates.length) return Math.max(...candidates);
    const money = [...String(el.innerText || '').matchAll(/\$\s?([\d,]{4,9})/g)]
      .map((m) => Number(m[1].replace(/,/g, '')))
      .filter(M.plausiblePrice);
    return money.length ? Math.max(...money) : undefined;
  }

  // Rendered VDP spec grid (.info__details rows labelled "Mileage", "Exterior Color", …).
  function specFromGrid(el, labelRe) {
    if (!el || !el.querySelectorAll) return '';
    for (const d of el.querySelectorAll('.info__details')) {
      const label = d.querySelector('.info__label');
      if (label && labelRe.test((label.textContent || '').trim())) {
        const val = d.querySelector('.info__value');
        if (val) return (val.getAttribute('title') || val.textContent || '').trim();
      }
    }
    return '';
  }

  function extractColors(el) {
    let ext = M.cleanAttr(attr(el, ['data-extcolor', 'data-exteriorcolor', 'data-dotagging-item-color']));
    let int = M.cleanAttr(attr(el, ['data-intcolor', 'data-interiorcolor', 'data-dotagging-item-color-interior']));
    if (!ext) ext = M.cleanAttr(specFromGrid(el, /^exterior colou?r$/i));
    if (!int) int = M.cleanAttr(specFromGrid(el, /^interior colou?r$/i));
    if (!ext || !int) {
      const t = (el.innerText || '').replace(/\s+/g, ' ');
      if (!ext) ext = ((t.match(/Ext\.?:?\s*([^|]+?)\s+Int\.?:/i) || [])[1] || '').trim();
      if (!int) int = ((t.match(/Int\.?:?\s*([A-Za-z0-9/ -]+)/i) || [])[1] || '').trim();
    }
    return { ext, int };
  }

  // Gallery base for this vehicle. Real photos are `/inventoryphotos/<code>/<vin>/ip/<n>.jpg`
  // but new-car STOCK photos are `.../sp/<n>.png`, and the <code> segment differs even within
  // one dealer — so both folder and extension are derived, never assumed. Returns { base, ext }.
  const GALLERY_RE = /(https?:\/\/[^"'\s]*\/inventoryphotos\/\d+\/[^/]+\/(?:ip|sp)\/)\d+\.(jpe?g|png)/i;
  const GALLERY_RE_REL = /(\/inventoryphotos\/\d+\/[^/]+\/(?:ip|sp)\/)\d+\.(jpe?g|png)/i;
  function photoSource(el, vin) {
    const fromSrc = (src) => {
      const m = String(src || '').match(GALLERY_RE) || String(src || '').match(GALLERY_RE_REL);
      if (m && (!vin || m[1].toLowerCase().includes(vin.toLowerCase()))) {
        return { base: new URL(m[1], location.href).href, ext: m[2].toLowerCase().replace('jpeg', 'jpg') };
      }
      return null;
    };
    for (const img of [...el.querySelectorAll('img'), ...document.querySelectorAll('img')]) {
      const hit = fromSrc(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset') || '');
      if (hit) return hit;
    }
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      for (const m of (s.textContent || '').matchAll(/https?:\/\/[^"'\s\\]*\/inventoryphotos\/\d+\/[^/]+\/(?:ip|sp)\/\d+\.(?:jpe?g|png)/gi)) {
        const hit = fromSrc(m[0]);
        if (hit) return hit;
      }
    }
    if (vin) {
      let code = '';
      for (const img of document.querySelectorAll('img')) {
        const s = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
        const m = s.match(/\/inventoryphotos\/(\d+)\//i);
        if (m) { code = m[1]; break; }
      }
      if (code) return { base: `${location.origin}/inventoryphotos/${code}/${vin.toLowerCase()}/ip/`, ext: 'jpg' };
    }
    return null;
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

  function extractVehicle(scope, sourceUrl, ctx = {}) {
    const el = scope.getAttribute && scope.getAttribute('data-vin')
      ? scope
      : scope.querySelector('[data-vin]') || scope;
    const colors = extractColors(el);
    const trim = attr(el, ['data-trim']);
    const model = attr(el, ['data-model', 'data-dotagging-item-model']);
    const vin = attr(el, ['data-vin']);
    const odo = num(attr(el, ['data-dotagging-item-odometer', 'data-odometer', 'data-mileage']));
    const mileage = odo === undefined ? num(specFromGrid(el, /mileage/i)) : odo;
    const photos = photoSource(el, vin);
    const v = {
      vehicleType: 'Car/Truck',
      vin,
      stock: attr(el, ['data-stocknum', 'data-stocknumber']),
      year: attr(el, ['data-year', 'data-dotagging-item-year']),
      make: attr(el, ['data-make', 'data-dotagging-item-make']),
      model: [model, trim].filter(Boolean).join(' ').trim(),
      trim,
      price: extractPrice(el),
      mileage,
      fuelType: attr(el, ['data-fueltype', 'data-dotagging-item-fuel-type']),
      bodyType: attr(el, ['data-dotagging-item-body-type', 'data-bodystyle', 'data-dotagging-item-type']),
      engine: attr(el, ['data-engine']),
      exteriorColor: colors.ext,
      interiorColor: colors.int,
      exteriorColorGeneric: M.cleanAttr(attr(el, ['data-dotagging-item-generic-color'])),
      transmission: attr(el, ['data-trans', 'data-transmission', 'data-dotagging-item-transmission']) || 'Automatic',
      condition: 'Excellent',
      location: ctx.location || '',
      sourceUrl: sourceUrl || location.href,
      photoBaseUrl: photos ? photos.base : '',
      photoExt: photos ? photos.ext : 'jpg'
    };
    v.description = buildDescription(v);
    return v;
  }

  function vinFromUrl() {
    const m = location.pathname.match(/([A-HJ-NPR-Z0-9]{11,17})(?:[/?#]|$)/i);
    return m ? m[1] : '';
  }
  // The vehicle this VDP is actually about. Prefer the main `.vdp[data-vin]` element — ~16 OTHER
  // elements also carry data-vin on a VDP (CTAs, thumbnails, related cars); only .vdp has the
  // full attribute dataset.
  function vdpVehicleEl() {
    const vin = vinFromUrl();
    if (vin) {
      const el = document.querySelector(`.vdp[data-vin="${vin}" i]`)
        || document.querySelector(`[data-vin="${vin}"]`)
        || document.querySelector(`[data-vin="${vin.toUpperCase()}"]`);
      if (el) return el;
    }
    return document.querySelector('.vdp[data-vin]') || document.querySelector('[data-vin]');
  }
  function isVdpPage() {
    return /\/(used|new)-/i.test(location.pathname) && !!vinFromUrl() && !!document.querySelector('[data-vin]');
  }

  function cardKey(card) {
    const vin = (card.getAttribute('data-vin') || '').toUpperCase();
    if (vin) return vin;
    return card.getAttribute('data-stocknum') || card.getAttribute('data-stocknumber') || vdpUrlFor(card) || '';
  }
  function vdpUrlFor(card) {
    return [...card.querySelectorAll('a[href]')]
      .map((a) => a.href)
      .find((h) => /\/(used|new)-/i.test(h) && /[A-HJ-NPR-Z0-9]{11,17}$/i.test(h.replace(/[^A-Za-z0-9]/g, ''))) || '';
  }

  root.CarxpertExtractors = root.CarxpertExtractors || {};
  root.CarxpertExtractors.dealeron = {
    id: 'dealeron',
    detect() {
      return !!document.querySelector('[data-vehicle-information][data-vin], [data-dotagging-item-id], .vdp[data-vin]')
        || /\/search(?:all|new|used)\.aspx/i.test(location.pathname);
    },
    fingerprints() {
      return {
        vehicleInfoVin: !!document.querySelector('[data-vehicle-information][data-vin]'),
        dotagging: !!document.querySelector('[data-dotagging-item-id],[data-dotagging-element-type]')
      };
    },
    findCards() { return [...document.querySelectorAll('[data-vehicle-information][data-vin]')]; },
    cardReady(card) { return !!card.getAttribute('data-vin'); },
    cardKey,
    vdpUrlFor,
    extractVehicle,
    isVdpPage,
    vdpVehicleEl,
    // On a VDP the listed-state key is the URL's VIN.
    vdpKey() { return (vdpVehicleEl()?.getAttribute('data-vin') || '').toUpperCase() || vinFromUrl().toUpperCase() || location.href; }
  };
})(globalThis);
