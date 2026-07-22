'use strict';

// Carsforsale.com "Chassis" source extractor. These dealer sites render SRP cards under
// `.p-veh-card`, link details as `/Inventory/Details/<uuid>`, and publish unusually rich JSON-LD:
// one schema.org Car per card plus a 24+ image ImageGallery on each VDP. The SRP data gives us a
// stable VIN immediately; one same-origin VDP fetch supplies stock number and the full signed photo
// URLs. No Carsforsale API credentials or dealer login are involved.

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
    const raw = squish(value).replace(/[^\d.]/g, '');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }

  function urlKey(value) {
    try {
      const path = new URL(value, typeof location !== 'undefined' ? location.href : 'https://dealer.invalid/').pathname;
      // Chassis uses two equivalent public routes for the same record: clickable cards point to
      // `/Inventory/Details/<id>`, while JSON-LD canonical URLs use `/cars-for-sale/Details/<id>`.
      const m = path.match(/\/(?:Inventory|cars-for-sale)\/Details\/([a-f\d-]{20,})/i);
      return m ? m[1].toLowerCase() : path.toLowerCase().replace(/\/+$/, '');
    } catch {
      return String(value || '').toLowerCase();
    }
  }

  const nodeType = (node) => String(node && node['@type'] || '');
  const isVehicleNode = (node) => /^(?:Car|Vehicle|Product)$/i.test(nodeType(node));

  function vehicleNodeForUrl(nodes, value) {
    const cars = (nodes || []).filter(isVehicleNode);
    const key = urlKey(value);
    const match = cars.find((node) => {
      const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
      const urls = [node.url, ...offers.map((offer) => offer && offer.url)].filter(Boolean);
      return urls.some((url) => urlKey(url) === key);
    });
    return match || (cars.length === 1 ? cars[0] : null);
  }

  function imageValue(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.image || value.url || value.contentUrl || '';
  }

  function galleryPhotos(nodes, max = 24) {
    const gallery = (nodes || []).find((node) => /ImageGallery/i.test(nodeType(node)));
    if (!gallery) return [];
    const images = gallery.Image || gallery.image || gallery.associatedMedia || [];
    const values = Array.isArray(images) ? images : [images];
    const seen = new Set();
    const out = [];
    for (const image of values) {
      const url = imageValue(image).replace(/&amp;/gi, '&');
      if (!/^https?:\/\//i.test(url)) continue;
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
      if (out.length >= max) break;
    }
    return out;
  }

  function stockFromHtml(html) {
    const text = decodeHtml(html);
    const match = text.match(/\bStock\s*#\s*([A-Za-z0-9._-]+)(?=\s+VIN\b)/i)
      || text.match(/\bStock\s*#\s*[:]?\s*([A-Za-z0-9._-]+)/i);
    return match ? match[1] : '';
  }

  function engineFromNode(node) {
    const engine = node && node.vehicleEngine;
    if (!engine) return '';
    if (typeof engine === 'string') return squish(engine);
    if (engine.name) return squish(engine.name);
    const displacement = engine.engineDisplacement && (engine.engineDisplacement.value || engine.engineDisplacement.name);
    const power = engine.enginePower && (engine.enginePower.value || engine.enginePower.name);
    return [displacement ? `${displacement}L` : '', power ? `${power}hp` : ''].filter(Boolean).join(' ');
  }

  function friendlyDrivetrain(value) {
    const raw = squish(value && typeof value === 'object'
      ? (value.name || value.value || value['@id'] || value.url || '')
      : value);
    if (/AllWheelDrive|all[- ]wheel|\bAWD\b/i.test(raw)) return 'AWD';
    if (/FourWheelDrive|four[- ]wheel|\b4WD\b|\b4x4\b/i.test(raw)) return '4WD';
    if (/FrontWheelDrive|front[- ]wheel|\bFWD\b/i.test(raw)) return 'FWD';
    if (/RearWheelDrive|rear[- ]wheel|\bRWD\b/i.test(raw)) return 'RWD';
    return raw.replace(/^https?:\/\/schema\.org\//i, '').replace(/Configuration$/i, '');
  }

  function fuelEconomyFromHtml(html) {
    const value = decodeHtml(html);
    const match = value.match(/(\d{1,3})\s*City\s*[-/]\s*(\d{1,3})\s*(?:Hwy|Highway)(?:\s*\/\s*([\d,]+)\s*mi)?/i);
    if (!match) return '';
    const range = match[3] ? ` · ${Number(match[3].replace(/,/g, '')).toLocaleString('en-US')} mi range` : '';
    return `${match[1]} city / ${match[2]} highway MPG${range}`;
  }

  function vehicleDataFromNodes(nodes, value) {
    const schema = S();
    const node = vehicleNodeForUrl(nodes, value);
    if (!schema || !node) return { photos: galleryPhotos(nodes), node: node || null };
    const normalized = schema.normalizeVehicle([node]);
    return {
      ...normalized,
      trim: squish(node.vehicleConfiguration),
      engine: engineFromNode(node),
      drivetrain: friendlyDrivetrain(node.driveWheelConfiguration || node.vehicleDriveWheelConfiguration),
      photos: galleryPhotos(nodes).length ? galleryPhotos(nodes) : (normalized.photos || []),
      node
    };
  }

  const text = (element) => squish(element && element.textContent);

  function cardPairs(card) {
    const out = {};
    for (const row of card.querySelectorAll('.features-list .feature, dt')) {
      const label = row.matches('dt') ? text(row) : text(row.querySelector('.feature-label'));
      const value = row.matches('dt') ? text(row.nextElementSibling) : text(row.querySelector('.feature-value'));
      if (label && value) out[label.replace(/:\s*$/, '').toLowerCase()] = value;
    }
    return out;
  }

  function vdpUrlFor(card) {
    const link = card && card.querySelector && card.querySelector('a[href*="/Inventory/Details/"]');
    return link ? link.href : '';
  }

  function nodesFromCurrentDocument() {
    const schema = S();
    return schema ? schema.nodesFromDocument(typeof document !== 'undefined' ? document : null) : [];
  }

  function cardVehicleData(card) {
    const url = vdpUrlFor(card);
    const ld = vehicleDataFromNodes(nodesFromCurrentDocument(), url);
    const pairs = cardPairs(card);
    const title = text(card.querySelector('.inventory-title .me-1, .inventory-title'));
    const trim = text(card.querySelector('.inventory-trim')) || ld.trim || '';
    const titleYear = (title.match(/\b(?:19|20)\d{2}\b/) || [])[0] || '';
    const photos = [...card.querySelectorAll('img')]
      .map((img) => img.currentSrc || img.getAttribute('src') || '')
      .filter((url) => /^https?:\/\/cdn\d*\.carsforsale\.com/i.test(url));
    return {
      ...ld,
      year: ld.year || titleYear,
      trim,
      price: ld.price || money(text(card.querySelector('.srp-ftc-headline .value, .price-value, [class*="price"]'))),
      mileage: ld.mileage != null ? ld.mileage : money(pairs.mileage),
      engine: pairs.engine || ld.engine || '',
      exteriorColor: pairs['ext. color'] || pairs['exterior color'] || ld.exteriorColor || '',
      transmission: pairs.transmission || ld.transmission || '',
      drivetrain: friendlyDrivetrain(pairs.drivetrain || pairs['drive train'] || ld.drivetrain),
      fuelEconomy: pairs['fuel economy'] || pairs.mpg || ld.fuelEconomy || '',
      photos: photos.length ? [...new Set(photos)] : (ld.photos || []),
      url
    };
  }

  async function fetchVdp(value, fallback = {}) {
    const schema = S();
    if (!schema || !value) return fallback;
    try {
      const html = await schema.fetchHtml(value);
      if (!html) return fallback;
      const nodes = schema.nodesFromHtml(html);
      return {
        ...vehicleDataFromNodes(nodes, value),
        stock: stockFromHtml(html),
        fuelEconomy: fuelEconomyFromHtml(html),
        html
      };
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
    if (vehicle.fuelEconomy) lines.push(`• Fuel economy: ${vehicle.fuelEconomy}`);
    if (vehicle.fuelType) lines.push(`• Fuel: ${vehicle.fuelType}`);
    lines.push('', 'Message us to schedule a test drive!');
    if (vehicle.sourceUrl) lines.push(vehicle.sourceUrl);
    return lines.join('\n');
  }

  function isVdpPage() {
    if (typeof document === 'undefined' || typeof location === 'undefined') return false;
    return /\/Inventory\/Details\//i.test(location.pathname)
      && !!vehicleNodeForUrl(nodesFromCurrentDocument(), location.href);
  }

  async function extractVehicle(scope, sourceUrl, ctx = {}) {
    const onVdp = isVdpPage();
    const card = onVdp ? null : ((scope && scope.matches && scope.matches('.p-veh-card'))
      ? scope : (scope && scope.closest && scope.closest('.p-veh-card')));
    const cardData = card ? cardVehicleData(card) : {};
    const url = (card && vdpUrlFor(card)) || sourceUrl || (typeof location !== 'undefined' ? location.href : '');
    const current = onVdp ? {
      ...vehicleDataFromNodes(nodesFromCurrentDocument(), url),
      stock: stockFromHtml(document.documentElement.outerHTML),
      fuelEconomy: fuelEconomyFromHtml(document.documentElement.outerHTML)
    } : null;
    const detail = current || await fetchVdp(url, cardData);
    const fill = (primary, fallback) => (primary !== undefined && primary !== null && primary !== '' ? primary : fallback);
    const trim = fill(detail.trim, cardData.trim) || '';
    const baseModel = fill(detail.model, cardData.model) || '';
    const model = [baseModel, trim && !baseModel.toLowerCase().includes(trim.toLowerCase()) ? trim : ''].filter(Boolean).join(' ');
    const photos = (detail.photos && detail.photos.length ? detail.photos : cardData.photos) || [];
    const vehicle = {
      vehicleType: 'Car/Truck',
      vin: fill(detail.vin, cardData.vin) || '',
      stock: fill(detail.stock, cardData.stock) || '',
      year: fill(detail.year, cardData.year) || '',
      make: fill(detail.make, cardData.make) || '',
      model,
      trim,
      price: fill(detail.price, cardData.price),
      mileage: detail.mileage != null ? detail.mileage : cardData.mileage,
      fuelType: fill(detail.fuelType, cardData.fuelType) || '',
      bodyType: fill(detail.bodyType, cardData.bodyType) || '',
      drivetrain: fill(detail.drivetrain, cardData.drivetrain) || '',
      fuelEconomy: fill(detail.fuelEconomy, cardData.fuelEconomy) || '',
      engine: fill(cardData.engine, detail.engine) || '',
      exteriorColor: fill(cardData.exteriorColor, detail.exteriorColor) || '',
      interiorColor: fill(detail.interiorColor, cardData.interiorColor) || '',
      exteriorColorGeneric: '',
      transmission: fill(cardData.transmission, detail.transmission) || 'Automatic',
      condition: 'Excellent',
      location: ctx.location || '',
      sourceUrl: url,
      photoUrls: [...new Set(photos)].slice(0, 24),
      photoBaseUrl: '',
      photoExt: 'jpg'
    };
    vehicle.description = buildDescription(vehicle);
    return vehicle;
  }

  const hasChassisAssets = () => typeof document !== 'undefined'
    && !!document.querySelector('script[src*="Chassis.Modules.Inventory"], link[href*="Chassis.Modules.Inventory"]');
  const hasCards = () => typeof document !== 'undefined'
    && !!document.querySelector('.p-veh-card a[href*="/Inventory/Details/"]');
  const hasCarsForSaleCdn = () => typeof document !== 'undefined'
    && !!document.querySelector('img[src*="carsforsale.com"], source[srcset*="carsforsale.com"]');

  root.CarxpertExtractors = root.CarxpertExtractors || {};
  root.CarxpertExtractors.carsforsale = {
    id: 'carsforsale',
    detect() { return hasChassisAssets() || hasCards(); },
    fingerprints() {
      return {
        carsForSaleAssets: hasChassisAssets(),
        carsForSaleCards: hasCards(),
        carsForSaleCdn: hasCarsForSaleCdn()
      };
    },
    findCards() {
      return [...document.querySelectorAll('.p-veh-card')]
        .filter((card) => !!card.querySelector('a[href*="/Inventory/Details/"]'));
    },
    cardReady(card) { return !!vdpUrlFor(card); },
    cardKey(card) {
      const data = cardVehicleData(card);
      return (data.vin || '').toUpperCase() || urlKey(data.url);
    },
    vdpUrlFor,
    extractVehicle,
    isVdpPage,
    vdpVehicleEl() {
      return isVdpPage()
        ? (document.querySelector('.inventorydetails, .page-inventory-details') || document.body)
        : null;
    },
    vdpKey() {
      const data = vehicleDataFromNodes(nodesFromCurrentDocument(), typeof location !== 'undefined' ? location.href : '');
      return (data.vin || '').toUpperCase() || (typeof location !== 'undefined' ? location.href : '');
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      decodeHtml, money, urlKey, vehicleNodeForUrl, galleryPhotos, stockFromHtml,
      friendlyDrivetrain, fuelEconomyFromHtml, vehicleDataFromNodes
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
