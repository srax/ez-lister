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
  ],
  // Dealer.com (Cox Automotive). These sites sit behind Akamai, which 403s our server fetch —
  // so server.* rules almost never fire and the CLIENT signals (posted from the live DOM by the
  // content script's dealercom extractor) carry the weight. `hasDdcNamespace` (window.DDC) alone
  // clears THRESHOLD, matching the "client evidence beats server fetch when sites bot-wall" note.
  dealercom: [
    ['client.hasDdcNamespace', 3], // window.DDC present (Dealer.com's JS namespace)
    ['client.hasVehicleCardUuid', 2], // li.vehicle-card[data-uuid] listing cards
    ['client.hasDdcInventoryPath', 1], // /used-inventory/ /new-inventory/ /all-inventory/
    ['server.bodyMentionsDealerDotCom', 3], // "dealer.com" / pictures.dealer.com in HTML
    ['server.hasDdcInventoryPath', 1] // same inventory path seen in server HTML
  ],
  // Dealer Inspire (Cars.com). Cloudflare-walled (not Akamai), so like Dealer.com it leans on the
  // extension's live-DOM probe: DI ships assets from dealerinspire.com and its cards carry the
  // data-vehicle JSON blob.
  dealerinspire: [
    ['client.hasDealerInspire', 3], // dealerinspire.com assets or [data-vehicle][data-vehicle-vin]
    ['server.bodyMentionsDealerInspire', 3] // "dealerinspire.com" / x-cars-signature in HTML
  ],
  // Carsforsale.com dealer websites run the Chassis inventory modules and publish signed vehicle
  // images from cdn*.carsforsale.com. Either the live module/card signal or the server marker is
  // sufficient to identify the source adapter.
  carsforsale: [
    ['client.hasCarsForSale', 3],
    ['server.bodyMentionsCarsForSale', 3],
    ['server.hasChassisInventory', 2]
  ],
  // AutoCorner / stockNum Systems. The strongest browser signal is the vendor asset host; the SRP
  // root corroborates it. Reachable sites also identify themselves in HTML and response assets.
  autocorner: [
    ['client.hasAutoCorner', 3],
    ['client.hasAutoCornerSrp', 2],
    ['server.bodyMentionsAutoCorner', 3],
    ['server.hasAutoCornerSrpEndpoint', 1]
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
      hasDotagging: pick('dotagging', 'hasDotagging', 'dataDotagging'),
      hasDdcNamespace: pick('ddcNamespace', 'hasDdcNamespace'),
      hasVehicleCardUuid: pick('vehicleCardUuid', 'hasVehicleCardUuid'),
      hasDdcInventoryPath: pick('ddcInventoryPath', 'hasDdcInventoryPath'),
      hasDealerInspire: pick('diAssets', 'diVehicleData', 'hasDealerInspire'),
      hasCarsForSale: pick('carsForSaleAssets', 'carsForSaleCards', 'carsForSaleCdn', 'hasCarsForSale'),
      hasAutoCorner: pick('autoCornerAssets', 'autoCornerPhotos', 'hasAutoCorner'),
      hasAutoCornerSrp: pick('autoCornerSrp', 'hasAutoCornerSrp')
    },
    server: {
      bodyMentionsDealerOn: pick('mentionsDealerOn', 'bodyMentionsDealerOn'),
      hasSitemapAspx: pick('hasSitemapAspx', 'sitemapAspx'),
      hasSearchNew: pick('hasSearchNew', 'searchNew'),
      hasSearchUsed: pick('hasSearchUsed', 'searchUsed'),
      hasInventoryPhotos: pick('hasInventoryPhotos', 'inventoryPhotos'),
      bodyMentionsDealerDotCom: pick('mentionsDealerDotCom', 'bodyMentionsDealerDotCom'),
      hasDdcInventoryPath: pick('serverDdcInventoryPath', 'hasServerDdcInventoryPath'),
      bodyMentionsDealerInspire: pick('mentionsDealerInspire', 'bodyMentionsDealerInspire'),
      bodyMentionsCarsForSale: pick('mentionsCarsForSale', 'bodyMentionsCarsForSale'),
      hasChassisInventory: pick('hasChassisInventory', 'serverChassisInventory'),
      bodyMentionsAutoCorner: pick('mentionsAutoCorner', 'bodyMentionsAutoCorner'),
      hasAutoCornerSrpEndpoint: pick('hasAutoCornerSrpEndpoint', 'autoCornerSrpEndpoint')
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
