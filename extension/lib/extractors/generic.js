'use strict';

// Generic schema.org extractor — the universal fallback for dealers on platforms we haven't coded
// (or a known-platform detail page a specific extractor doesn't handle). It claims ONLY a vehicle
// DETAIL page that exposes schema.org Vehicle/Car JSON-LD with a VIN, and lists straight from that
// structured data. It is registered LAST in the dispatcher, so a recognized platform (DealerOn,
// Dealer.com) always wins first — generic never overrides them. It intentionally finds no SRP cards
// (grid layouts are platform-specific); its scope is the detail page, which every dealer emits
// structured data for.

(function attach(root) {
  const S = () => root.CarxpertSchemaOrg;
  const here = () => (typeof location !== 'undefined' ? location.href : '');

  function currentVehicle() {
    const s = S();
    return s ? s.vehicleFromDocument(typeof document !== 'undefined' ? document : null) : {};
  }
  // A listable detail page = schema.org Vehicle present AND carrying a VIN (distinguishes a real
  // VDP from an SRP's ItemList or an unrelated page).
  function isDetailPage() {
    const v = currentVehicle();
    return !!(v && v.vin);
  }

  function buildDescription(v) {
    const lines = [];
    lines.push([v.year, v.make, v.model].filter(Boolean).join(' '));
    if (typeof v.mileage === 'number') lines.push(`• Mileage: ${v.mileage.toLocaleString('en-US')} miles`);
    if (v.vin) lines.push(`• VIN: ${v.vin}`);
    if (v.exteriorColor) lines.push(`• Exterior: ${v.exteriorColor}`);
    if (v.interiorColor) lines.push(`• Interior: ${v.interiorColor}`);
    if (v.fuelType) lines.push(`• Fuel: ${v.fuelType}`);
    lines.push('');
    lines.push('Message us to schedule a test drive!');
    if (v.sourceUrl) lines.push(v.sourceUrl);
    return lines.join('\n');
  }

  function extractVehicle(scope, sourceUrl, ctx = {}) {
    const v = currentVehicle();
    const draft = {
      vehicleType: 'Car/Truck',
      vin: v.vin || '',
      stock: '',
      year: v.year || '',
      make: v.make || '',
      model: v.model || '',
      trim: '',
      price: v.price,
      mileage: v.mileage,
      fuelType: v.fuelType || '',
      bodyType: v.bodyType || '',
      engine: '',
      exteriorColor: v.exteriorColor || '',
      interiorColor: v.interiorColor || '',
      exteriorColorGeneric: '',
      transmission: v.transmission || 'Automatic',
      condition: 'Excellent',
      location: ctx.location || '',
      sourceUrl: sourceUrl || here(),
      photoUrls: (v.photos || []).slice(0, 24),
      photoBaseUrl: '',
      photoExt: 'jpg'
    };
    draft.description = buildDescription(draft);
    return draft;
  }

  root.CarxpertExtractors = root.CarxpertExtractors || {};
  root.CarxpertExtractors.generic = {
    id: 'generic',
    detect() { return isDetailPage(); },
    fingerprints() { return {}; }, // not a "platform" — never drives onboarding
    findCards() { return []; },    // SRP card-finding is platform-specific; generic is VDP-only
    cardReady() { return false; },
    cardKey() { return (currentVehicle().vin || '').toUpperCase() || here(); },
    vdpUrlFor() { return here(); },
    extractVehicle,
    isVdpPage() { return isDetailPage(); },
    vdpVehicleEl() { return isDetailPage() && typeof document !== 'undefined' ? document.body : null; },
    vdpKey() { return (currentVehicle().vin || '').toUpperCase() || here(); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
