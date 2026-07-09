'use strict';

// Facebook Marketplace value taxonomy — maps a dealer's US-English feed terms to FB's
// UK-English "Vehicle for sale" option labels. This is the Facebook adapter's mapper;
// each other platform gets its own lib/mappers.<platform>.js. Depends on the shared core
// helpers (norm, cleanAttr) — via globalThis.CarxpertCore in the browser, via require in
// node:test. Loaded after mappers.core.js (see manifest), attached to globalThis.CarxpertFb.

(function attach(root) {
  const core = (typeof module !== 'undefined' && module.exports)
    ? require('./mappers.core.js')
    : root.CarxpertCore;
  const { norm, cleanAttr } = core;

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

  const api = { mapColor, mapBody, mapFuel, mapTransmission };
  root.CarxpertFb = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
