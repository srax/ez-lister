// Platform fingerprinting as a scored evidence table (not a boolean). DealerOn is fully
// verified; other platforms get added here as research lands. A score at/above threshold is
// TRIAGE metadata recorded on dealer_requests — NOT auto-support. The v1 support list stays
// curated by hand via admin.

// Client-side evidence (posted by the extension from the LIVE DOM) beats server fetches when
// sites bot-wall, so it carries the heaviest weights.
const RULES = {
  dealeron: [
    ['client.hasVehicleInfoVin', 3], // [data-vehicle-information][data-vin]
    ['client.hasDotagging', 2], // data-dotagging-* attributes
    ['server.bodyMentionsDealerOn', 3], // "DealerOn" in footer/body
    ['server.hasSitemapAspx', 2], // /sitemap.aspx inventory roster
    ['server.hasSearchNew', 1], // /searchnew.aspx
    ['server.hasSearchUsed', 1], // /searchused.aspx
    ['server.hasInventoryPhotos', 1] // /inventoryphotos/ image paths
  ]
};
const MAX_SCORE = Object.fromEntries(
  Object.entries(RULES).map(([p, rules]) => [p, rules.reduce((sum, [, w]) => sum + w, 0)])
);
const THRESHOLD = 3;

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Map the extension's posted fingerprints (flexible shape) into the evidence structure.
export function buildEvidence(fingerprints = {}) {
  const f = fingerprints || {};
  const pick = (...keys) => keys.some((k) => Boolean(f[k]));
  return {
    client: {
      hasVehicleInfoVin: pick('vehicleInfoVin', 'hasVehicleInfoVin', 'dataVehicleInformation'),
      hasDotagging: pick('dotagging', 'hasDotagging', 'dataDotagging')
    },
    server: {
      bodyMentionsDealerOn: pick('mentionsDealerOn', 'bodyMentionsDealerOn'),
      hasSitemapAspx: pick('hasSitemapAspx', 'sitemapAspx'),
      hasSearchNew: pick('hasSearchNew', 'searchNew'),
      hasSearchUsed: pick('hasSearchUsed', 'searchUsed'),
      hasInventoryPhotos: pick('hasInventoryPhotos', 'inventoryPhotos')
    }
  };
}

// → { platform: 'dealeron'|null, confidence: 0..1, scores: { dealeron: n } }
export function scorePlatform(evidence = {}) {
  const scores = {};
  for (const [platform, rules] of Object.entries(RULES)) {
    let score = 0;
    for (const [path, weight] of rules) if (getPath(evidence, path)) score += weight;
    scores[platform] = score;
  }
  let best = null;
  let bestScore = 0;
  for (const [platform, score] of Object.entries(scores)) {
    if (score > bestScore) { best = platform; bestScore = score; }
  }
  const platform = bestScore >= THRESHOLD ? best : null;
  const confidence = platform ? Number(Math.min(1, bestScore / MAX_SCORE[best]).toFixed(2)) : 0;
  return { platform, confidence, scores };
}
