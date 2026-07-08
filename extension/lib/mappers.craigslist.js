'use strict';

// Craigslist value taxonomy — maps a dealer's US-English feed terms to the option labels
// Craigslist's vehicle post form exposes in its native <select> auto-attributes. Match is
// by the option's VISIBLE TEXT (see fillSelect in fillkit.js), so these return the exact
// lowercase labels Craigslist renders (e.g. "like new", "SUV", "grey").
//
// Documented CL auto-attribute option sets (2026):
//   auto_bodytype:     bus, convertible, coupe, hatchback, minivan, offroad, pickup,
//                      sedan, truck, SUV, wagon, van, other
//   auto_condition:    new, like new, excellent, good, fair, salvage
//   auto_fuel_type:    gas, diesel, hybrid, electric, other
//   auto_transmission: manual, automatic, other
//   auto_paint:        black, blue, brown, green, grey, orange, purple, red, silver,
//                      white, yellow, custom
//   auto_title_status: clean, salvage, rebuilt, parts only, lien, missing
//
// Depends on the shared core helpers (norm, cleanAttr) — via globalThis.CarxpertCore in the
// browser, via require in node:test. Loaded after mappers.core.js (see manifest), attached
// to globalThis.CarxpertCl. Unknown values return '' so the user picks manually, EXCEPT the
// two fields with a safe dealer default (condition→excellent, title→clean).

(function attach(root) {
  const core = (typeof module !== 'undefined' && module.exports)
    ? require('./mappers.core.js')
    : root.CarxpertCore;
  const { norm, cleanAttr } = core;

  const CL_BODY = {
    suv: 'SUV', 'sport utility': 'SUV', crossover: 'SUV', '4x4': 'SUV',
    sedan: 'sedan', saloon: 'sedan', coupe: 'coupe', 'coupé': 'coupe',
    convertible: 'convertible', hatchback: 'hatchback', wagon: 'wagon', estate: 'wagon',
    minivan: 'minivan', van: 'van', mpv: 'minivan',
    pickup: 'pickup', truck: 'truck', offroad: 'offroad', bus: 'bus',
  };
  const CL_FUEL = {
    gasoline: 'gas', gas: 'gas', petrol: 'gas', diesel: 'diesel',
    electric: 'electric', ev: 'electric',
    hybrid: 'hybrid', 'plug-in hybrid': 'hybrid', phev: 'hybrid',
    flex: 'other', e85: 'other',
  };
  const CL_CONDITION = {
    new: 'new', 'like new': 'like new', excellent: 'excellent',
    good: 'good', fair: 'fair', salvage: 'salvage', used: 'excellent',
  };
  const CL_TITLE = {
    clean: 'clean', salvage: 'salvage', rebuilt: 'rebuilt',
    'parts only': 'parts only', lien: 'lien', missing: 'missing',
  };
  const CL_PAINT = ['black', 'blue', 'brown', 'green', 'grey', 'orange', 'purple', 'red', 'silver', 'white', 'yellow', 'custom'];
  // marketing color -> CL paint keyword fallbacks. CL has no charcoal/beige/tan/gold/burgundy
  // slots, so those fold to the nearest CL colour or 'custom'. Short tokens keep \b guards.
  const CL_COLOR_KEYWORDS = [
    [/silver|alumin/i, 'silver'],
    [/charcoal|grey|gray|magnetic|graphite|gunmetal|cement|lunar rock|\bash\b|slate/i, 'grey'],
    [/black|midnight|ebony|onyx|attitude/i, 'black'],
    [/white|pearl|snow|frost|ice cap|blizzard|super white|alpine/i, 'white'],
    [/celestite|blue|navy|\bsky\b|cavalry|blueprint|sapphire/i, 'blue'],
    [/red|barcelona|ruby|scarlet|crimson|supersonic/i, 'red'],
    [/burgundy|maroon|wine|merlot/i, 'red'],
    [/green|army|cypress/i, 'green'],
    [/brown|mocha|espresso|coffee|smoked|bronze/i, 'brown'],
    [/orange|inferno/i, 'orange'],
    [/yellow/i, 'yellow'],
    [/purple|plum/i, 'purple'],
    [/gold|champagne|beige|sand|almond|dune|macadamia|\btan\b|camel|saddle/i, 'custom'],
  ];
  const MATERIAL_RE = /\b(fabric|leather|leatherette|softex|cloth|vinyl|velour|suede|ultrasuede|trim|upholstery|interior|seats?)\b/gi;

  const mapBody = (raw) => (raw ? (CL_BODY[norm(raw)] || CL_BODY[norm(String(raw).replace(/\d+\s*dr\s*/i, '').trim())] || '') : '');

  const mapFuel = (raw) => {
    if (!raw) return '';
    const k = norm(raw).replace(/\s*fuel$/i, '');
    if (CL_FUEL[k]) return CL_FUEL[k];
    for (const key of Object.keys(CL_FUEL)) if (k.includes(key)) return CL_FUEL[key];
    return '';
  };

  const mapTransmission = (raw) => {
    if (!raw) return '';
    if (/manual/i.test(raw)) return 'manual';
    return 'automatic';
  };

  // Dealer cars are almost always clean-title, excellent/good condition — so these two have a
  // safe default rather than blank, matching how the FB adapter defaults condition.
  const mapCondition = (raw) => CL_CONDITION[norm(raw)] || 'excellent';
  const mapTitleStatus = (raw) => CL_TITLE[norm(raw)] || 'clean';

  const mapColor = (raw) => {
    const cleaned = cleanAttr(raw);
    if (!cleaned) return '';
    const first = cleaned.split(/[\/,&]| and /i)[0]
      .replace(MATERIAL_RE, ' ').replace(/\s+/g, ' ').trim();
    if (!first) return '';
    const exact = CL_PAINT.find((c) => c === norm(first));
    if (exact) return exact;
    for (const [re, cl] of CL_COLOR_KEYWORDS) if (re.test(first)) return cl;
    return ''; // unknown -> leave blank for manual review
  };

  const api = { mapBody, mapFuel, mapTransmission, mapCondition, mapTitleStatus, mapColor };
  root.CarxpertCl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
