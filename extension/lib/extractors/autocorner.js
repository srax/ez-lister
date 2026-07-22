'use strict';

// AutoCorner / stockNum Systems source extractor. AutoCorner SRPs render each vehicle twice
// (`.grid_view` and `.list_view`) from Alpine data, while VDPs expose stable `.details_item`
// label/value pairs and photo IDs hosted at photos.autocorner.com. This adapter injects one button
// only into the currently-visible, non-sold card and enriches it from the same-origin VDP.

(function attach(root) {
  const S = () => root.CarxpertSchemaOrg;
  const squish = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  function decodeHtml(value) {
    return String(value || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function money(value) {
    const digits = squish(value).replace(/[^\d.]/g, '');
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }

  function vinFrom(value) {
    const match = String(value || '').match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
    return match ? match[1].toUpperCase() : '';
  }

  function detailsFromHtml(html) {
    const out = {};
    const re = /<span[^>]*class=["'][^"']*details_item_span1[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,600}?<span[^>]*class=["'][^"']*details_item_span2[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = re.exec(String(html || '')))) {
      const label = decodeHtml(match[1]).replace(/:\s*$/, '').toLowerCase();
      const value = decodeHtml(match[2]);
      if (label && value) out[label] = value;
    }
    return out;
  }

  function captionFromHtml(html) {
    const candidates = [];
    const re = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
    let match;
    while ((match = re.exec(String(html || '')))) {
      const value = decodeHtml(match[1]).replace(/\s+-\s+\$[\d,]+.*$/, '').trim();
      if (/^(?:19|20)\d{2}\s+\S+/i.test(value)) candidates.push(value);
    }
    return candidates[0] || '';
  }

  function photoIdsFromHtml(html, max = 24) {
    const raw = String(html || '').replace(/\\\//g, '/');
    const ids = [];
    const seen = new Set();
    const add = (id) => {
      const key = String(id || '').toLowerCase();
      if (!/^[a-f\d]{16,64}$/.test(key) || seen.has(key) || ids.length >= max) return;
      seen.add(key);
      ids.push(key);
    };
    let match;
    const urlRe = /photos\.autocorner\.com\/(?:\d+x\d+|transparent)\/([a-f\d]{16,64})\.(?:jpe?g|png|webp)/gi;
    while ((match = urlRe.exec(raw))) add(match[1]);
    const dataRe = /["']id["']\s*:\s*["']([a-f\d]{16,64})["']/gi;
    while ((match = dataRe.exec(raw))) add(match[1]);
    return ids;
  }

  const photoUrlsFromHtml = (html, max = 24) => photoIdsFromHtml(html, max)
    .map((id) => `https://photos.autocorner.com/1024x768/${id}.jpg`);

  function historyReportUrlFromHtml(html) {
    const raw = String(html || '').replace(/&amp;/gi, '&').replace(/\\\//g, '/');
    const match = raw.match(/href=["'](https?:\/\/(?:www\.)?carfax\.com\/[^"']+)["']/i);
    return match ? match[1] : '';
  }

  function parseVdpHtml(html) {
    const fields = detailsFromHtml(html);
    return {
      vin: vinFrom(fields.vin),
      stock: fields['stock #'] || fields.stock || '',
      year: (fields.year || '').match(/(?:19|20)\d{2}/)?.[0] || '',
      make: fields.make || '',
      model: fields.model || '',
      price: money(fields.price || fields['today\'s price']),
      mileage: money(fields.odometer || fields.miles || fields.mileage),
      exteriorColor: fields['exterior color'] || '',
      interiorColor: fields['interior color'] || '',
      engine: fields.engine || '',
      transmission: fields.transmission || '',
      drivetrain: fields['drive train'] || fields.drivetrain || '',
      bodyType: fields.body || fields['body style'] || '',
      historyReportUrl: historyReportUrlFromHtml(html),
      caption: captionFromHtml(html),
      photos: photoUrlsFromHtml(html)
    };
  }

  const text = (element) => squish(element && element.textContent);

  function domPairs(scope) {
    const out = {};
    for (const item of scope.querySelectorAll('.details_item')) {
      const label = text(item.querySelector('.details_item_span1')).replace(/:\s*$/, '').toLowerCase();
      const value = text(item.querySelector('.details_item_span2'));
      if (label && value) out[label] = value;
    }
    for (const labelNode of scope.querySelectorAll('dt')) {
      const label = text(labelNode).replace(/:\s*$/, '').toLowerCase();
      const value = text(labelNode.nextElementSibling || labelNode.parentElement?.querySelector('dd'));
      if (label && value && !out[label]) out[label] = value;
    }
    return out;
  }

  function vdpUrlFor(card) {
    if (!card || !card.querySelector) return '';
    const link = [...card.querySelectorAll('a[href*="/vehicles/"]')]
      .find((anchor) => !/carfax\.com/i.test(anchor.href));
    return link ? link.href.split('#')[0] : '';
  }

  function cardVin(card) {
    const carfax = card.querySelector('a[href*="carfax.com"][href*="vin="]');
    if (carfax) {
      try { return vinFrom(new URL(carfax.href).searchParams.get('vin')); } catch { /* use text/url fallbacks */ }
    }
    return vinFrom(`${text(card)} ${vdpUrlFor(card)}`);
  }

  function parseCard(card) {
    const pairs = domPairs(card);
    const caption = text(card.querySelector('h3'));
    const stock = text(card.querySelector('h2')).replace(/^\s*#\s*/, '');
    const photos = photoUrlsFromHtml(card.outerHTML || '');
    const historyLink = card.querySelector('a[href*="carfax.com"]');
    return {
      vin: cardVin(card),
      stock,
      caption,
      price: money(pairs.price),
      mileage: money(pairs.miles || pairs.mileage || pairs.odometer),
      bodyType: pairs.body || '',
      engine: pairs.engine || '',
      transmission: pairs.transmission || '',
      drivetrain: pairs.drivetrain || pairs['drive train'] || '',
      historyReportUrl: historyLink ? historyLink.href.replace(/&amp;/gi, '&') : '',
      photos,
      url: vdpUrlFor(card)
    };
  }

  function trimFromCaption(caption, year, make, model) {
    let value = squish(caption).replace(/\s+-\s+\$[\d,]+.*$/, '');
    const stripPrefix = (part) => {
      const p = squish(part);
      if (!p) return;
      const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');
      value = value.replace(re, '').trim();
    };
    stripPrefix(year);
    stripPrefix(make);
    const beforeModel = value;
    stripPrefix(model);
    // AutoCorner captions sometimes use the marketed model ("228i") while Vehicle Information
    // uses the family ("2 Series"). In that case keep the caption remainder as trim, not nothing.
    return value === beforeModel && model ? beforeModel : value;
  }

  function fuelFrom(engine, fallback) {
    if (fallback) return fallback;
    const value = squish(engine);
    if (/plug[- ]?in.*hybrid/i.test(value)) return 'Plug-in hybrid';
    if (/hybrid/i.test(value)) return 'Hybrid';
    if (/diesel/i.test(value)) return 'Diesel';
    if (/electric|\bEV\b/i.test(value)) return 'Electric';
    return '';
  }

  async function fetchVdp(url, fallback = {}) {
    const schema = S();
    if (!schema || !url) return fallback;
    try {
      const html = await schema.fetchHtml(url);
      return html ? parseVdpHtml(html) : fallback;
    } catch {
      return fallback;
    }
  }

  function buildDescription(vehicle) {
    const lines = [[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')];
    if (typeof vehicle.mileage === 'number') lines.push(`• Mileage: ${vehicle.mileage.toLocaleString('en-US')} miles`);
    if (vehicle.vin) lines.push(`• VIN: ${vehicle.vin}`);
    if (vehicle.stock) lines.push(`• Stock #: ${vehicle.stock}`);
    if (vehicle.exteriorColor) lines.push(`• Exterior: ${vehicle.exteriorColor}`);
    if (vehicle.interiorColor) lines.push(`• Interior: ${vehicle.interiorColor}`);
    if (vehicle.engine) lines.push(`• Engine: ${vehicle.engine}`);
    if (vehicle.drivetrain) lines.push(`• Drivetrain: ${vehicle.drivetrain}`);
    if (vehicle.fuelType) lines.push(`• Fuel: ${vehicle.fuelType}`);
    if (vehicle.historyReportUrl) lines.push(`• CARFAX report: ${vehicle.historyReportUrl}`);
    lines.push('', 'Message us to schedule a test drive!');
    if (vehicle.sourceUrl) lines.push(vehicle.sourceUrl);
    return lines.join('\n');
  }

  function isSoldCard(card) {
    const pairs = domPairs(card);
    // Every Alpine card contains the SOLD ribbon node, including active inventory; x-show merely
    // hides it. The rendered price is the reliable status signal (`SOLD` vs a dollar value).
    return /^sold$/i.test(squish(pairs.price));
  }

  function visibleCards() {
    const all = [...document.querySelectorAll('.srp_div')].filter((card) => vdpUrlFor(card) && !isSoldCard(card));
    const visible = all.filter((card) => {
      try {
        const style = getComputedStyle(card);
        return style.display !== 'none' && style.visibility !== 'hidden' && card.getClientRects().length > 0;
      } catch {
        return !card.classList.contains('hidden') && card.style.display !== 'none';
      }
    });
    if (visible.length) return visible;
    const grid = all.filter((card) => card.classList.contains('grid_view'));
    return grid.length ? grid : all;
  }

  function isVdpPage() {
    if (typeof document === 'undefined' || typeof location === 'undefined') return false;
    return /\/vehicles\//i.test(location.pathname)
      && !!document.querySelector('.details_item .details_item_span1, a[href*="carfax.com"][href*="vin="]');
  }

  async function extractVehicle(scope, sourceUrl, ctx = {}) {
    const onVdp = isVdpPage();
    const card = onVdp ? null : ((scope && scope.matches && scope.matches('.srp_div'))
      ? scope : (scope && scope.closest && scope.closest('.srp_div')));
    const cardData = card ? parseCard(card) : {};
    const url = (card && vdpUrlFor(card)) || sourceUrl || (typeof location !== 'undefined' ? location.href : '');
    const detail = onVdp ? parseVdpHtml(document.documentElement.outerHTML) : await fetchVdp(url, cardData);
    const fill = (primary, fallback) => (primary !== undefined && primary !== null && primary !== '' ? primary : fallback);
    const year = fill(detail.year, cardData.year) || '';
    const make = fill(detail.make, cardData.make) || '';
    const baseModel = fill(detail.model, cardData.model) || '';
    const caption = fill(cardData.caption, detail.caption) || '';
    const trim = trimFromCaption(caption, year, make, baseModel);
    const model = [baseModel, trim && !baseModel.toLowerCase().includes(trim.toLowerCase()) ? trim : ''].filter(Boolean).join(' ');
    const photos = (detail.photos && detail.photos.length ? detail.photos : cardData.photos) || [];
    const engine = fill(detail.engine, cardData.engine) || '';
    const vehicle = {
      vehicleType: 'Car/Truck',
      vin: fill(detail.vin, cardData.vin) || '',
      stock: fill(detail.stock, cardData.stock) || '',
      year,
      make,
      model,
      trim,
      price: fill(detail.price, cardData.price),
      mileage: detail.mileage != null ? detail.mileage : cardData.mileage,
      fuelType: fuelFrom(engine, fill(detail.fuelType, cardData.fuelType)),
      bodyType: fill(detail.bodyType, cardData.bodyType) || '',
      drivetrain: fill(detail.drivetrain, cardData.drivetrain) || '',
      engine,
      exteriorColor: fill(detail.exteriorColor, cardData.exteriorColor) || '',
      interiorColor: fill(detail.interiorColor, cardData.interiorColor) || '',
      exteriorColorGeneric: '',
      transmission: fill(detail.transmission, cardData.transmission) || 'Automatic',
      condition: 'Excellent',
      location: ctx.location || '',
      sourceUrl: url,
      historyReportUrl: fill(detail.historyReportUrl, cardData.historyReportUrl) || '',
      photoUrls: [...new Set(photos)].slice(0, 24),
      photoBaseUrl: '',
      photoExt: 'jpg'
    };
    vehicle.description = buildDescription(vehicle);
    return vehicle;
  }

  const hasAssets = () => typeof document !== 'undefined'
    && !!document.querySelector('script[src*="autocorner.com"], link[href*="autocorner.com"]');
  const hasSrp = () => typeof document !== 'undefined'
    && !!document.querySelector('#vehicle_inventory[x-data*="alpineInventoryHandler"], .srp_div a[href*="/vehicles/"]');
  const hasPhotos = () => typeof document !== 'undefined'
    && !!document.querySelector('img[src*="photos.autocorner.com"], source[srcset*="photos.autocorner.com"]');

  root.CarxpertExtractors = root.CarxpertExtractors || {};
  root.CarxpertExtractors.autocorner = {
    id: 'autocorner',
    detect() { return hasAssets() || hasSrp(); },
    fingerprints() {
      return {
        autoCornerAssets: hasAssets(),
        autoCornerSrp: hasSrp(),
        autoCornerPhotos: hasPhotos()
      };
    },
    findCards: visibleCards,
    cardReady(card) { return !!vdpUrlFor(card) && !isSoldCard(card); },
    cardKey(card) {
      const data = parseCard(card);
      return (data.vin || '').toUpperCase() || data.stock || data.url;
    },
    vdpUrlFor,
    extractVehicle,
    isVdpPage,
    vdpVehicleEl() {
      return isVdpPage()
        ? (document.querySelector('[x-data*="number_of_photos"], .details_item')?.closest('div') || document.body)
        : null;
    },
    vdpKey() {
      if (!isVdpPage()) return typeof location !== 'undefined' ? location.href : '';
      const parsed = parseVdpHtml(document.documentElement.outerHTML);
      return (parsed.vin || '').toUpperCase() || (typeof location !== 'undefined' ? location.href : '');
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      decodeHtml, money, vinFrom, detailsFromHtml, captionFromHtml,
      photoIdsFromHtml, photoUrlsFromHtml, historyReportUrlFromHtml, parseVdpHtml, trimFromCaption
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
