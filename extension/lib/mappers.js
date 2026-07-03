'use strict';

// Shared pure mapping/parsing helpers for the Carxpert content scripts.
// Loaded BEFORE dealerContent.js / facebookContent.js (see manifest content_scripts
// order) and attached to globalThis; also exported for node:test (mappers.test.js).
// Everything here must stay pure + DOM-free so it runs identically in both worlds.

(function attach(root) {
  const norm = (s) => (s || '').toString().trim().toLowerCase();

  // Dealer feeds sometimes inject raw HTML into data attributes (live-probed: new-car
  // data-extcolor carried a disclaimer link — "Wind Chill Pearl <a role='button'…>").
  // Cut at the first tag and collapse whitespace before any value is used or shown.
  const cleanAttr = (raw) => String(raw == null ? '' : raw).split('<')[0].replace(/\s+/g, ' ').trim();

  // ---- dealer term -> Facebook option mapping ----
  // FB UK body options: Coupé, Van, Saloon, Hatchback, 4x4, Convertible, Estate, MPV/People carrier, Small car, Other
  const FB_BODY = {
    suv: '4x4', 'sport utility': '4x4', crossover: '4x4', '4x4': '4x4', pickup: '4x4', truck: '4x4',
    sedan: 'Saloon', saloon: 'Saloon', coupe: 'Coupé', 'coupé': 'Coupé', convertible: 'Convertible',
    hatchback: 'Hatchback', wagon: 'Estate', estate: 'Estate', minivan: 'MPV/People carrier',
    van: 'Van', mpv: 'MPV/People carrier'
  };
  // FB fuel options: Diesel, Electric, Petrol, Flex, Hybrid, Plug-in hybrid, Other
  const FB_FUEL = {
    gasoline: 'Petrol', gas: 'Petrol', petrol: 'Petrol', diesel: 'Diesel', electric: 'Electric',
    ev: 'Electric', 'plug-in hybrid': 'Plug-in hybrid', phev: 'Plug-in hybrid', hybrid: 'Hybrid',
    flex: 'Flex', e85: 'Flex'
  };
  const FB_COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Off white', 'Tan', 'Beige', 'Burgundy', 'Turquoise'];
  // marketing color -> FB palette keyword fallbacks (covers Toyota names like Celestite, Magnetic Gray, Wind Chill Pearl)
  const COLOR_KEYWORDS = [
    // Short tokens (ash/sky/tan) need \b guards: /tan/ matched "ocTANe", /ash/ "flASH",
    // /sky/ "whiSKY" — a wrong colour is worse than a blank one.
    [/charcoal/i, 'Charcoal'], [/silver|alumin/i, 'Silver'], [/grey|gray|magnetic|graphite|gunmetal|cement|lunar rock|\bash\b|slate/i, 'Grey'],
    [/black|midnight|ebony|onyx|attitude/i, 'Black'], [/white|pearl|snow|frost|ice cap|blizzard|super white|alpine/i, 'White'],
    [/celestite|blue|navy|\bsky\b|cavalry|blueprint|sapphire/i, 'Blue'], [/red|barcelona|ruby|scarlet|crimson|supersonic/i, 'Red'],
    [/green|army|cypress/i, 'Green'], [/brown|mocha|espresso|coffee|smoked|bronze/i, 'Brown'],
    [/burgundy|maroon|wine|merlot/i, 'Burgundy'], [/gold|champagne/i, 'Gold'], [/beige|sand|almond|dune|macadamia/i, 'Beige'],
    [/\btan\b|camel|saddle/i, 'Tan'], [/orange|inferno/i, 'Orange'], [/yellow/i, 'Yellow'], [/purple|plum/i, 'Purple'],
    [/turquoise|teal/i, 'Turquoise'], [/off.?white|cream|ivory/i, 'Off white']
  ];
  // Upholstery material words are colour noise ("Light Gray Fabric", "Black Leatherette").
  // Paint-finish words (Pearl, Metallic, Mica) are NOT stripped — the keyword tier needs them.
  const MATERIAL_RE = /\b(fabric|leather|leatherette|softex|cloth|vinyl|velour|suede|ultrasuede|trim|upholstery|interior|seats?)\b/gi;

  const mapColor = (raw) => {
    const cleaned = cleanAttr(raw);
    if (!cleaned) return '';
    const first = cleaned.split(/[\/,&]| and /i)[0]        // "Black/Blue" -> "Black"
      .replace(MATERIAL_RE, ' ').replace(/\s+/g, ' ').trim(); // "Light Gray Fabric" -> "Light Gray"
    if (!first) return '';
    const exact = FB_COLORS.find((c) => norm(c) === norm(first));
    if (exact) return exact;
    for (const [re, fb] of COLOR_KEYWORDS) if (re.test(first)) return fb;
    return ''; // unknown -> leave blank for manual review
  };
  const mapBody = (raw) => (raw ? (FB_BODY[norm(raw)] || FB_BODY[norm(String(raw).replace(/\d+\s*dr\s*/i, '').trim())] || '') : '');
  const mapFuel = (raw) => {
    if (!raw) return '';
    const k = norm(raw).replace(/\s*fuel$/i, '');
    if (FB_FUEL[k]) return FB_FUEL[k];
    for (const key of Object.keys(FB_FUEL)) if (k.includes(key)) return FB_FUEL[key];
    return '';
  };
  const mapTransmission = (raw) => (/manual/i.test(raw || '') ? 'Manual transmission' : 'Automatic transmission');

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

  const api = { norm, cleanAttr, mapColor, mapBody, mapFuel, mapTransmission, plausiblePrice, decodePriceLib };
  root.CarxpertShared = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
