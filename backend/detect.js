// Server-side platform detection: fetch a dealer site's homepage ONCE and turn its HTML into
// the evidence table fingerprint.js scores. This fills the `server.*` evidence keys that were
// designed into the rules but never had a fetcher (client fingerprints only exist when our
// content script already runs on the site — i.e. never for a brand-new dealer URL).
//
// The HTML→evidence parser is pure and exported for tests; the fetch wrapper enforces SSRF
// hygiene (isBlockedHost, both before the request and after redirects), a timeout, and a size
// cap. Any failure returns null — detection then falls back to client fingerprints alone.

import { DEALER_UA, isBlockedHost } from './dealer-url.js';

const MAX_HTML_BYTES = 512 * 1024;

// Platform markers, matched against raw homepage HTML. Key names line up with the aliases
// buildEvidence() picks (fingerprint.js). Dealer.com markers usually WON'T fire — those sites
// front with Akamai, which 403s this server-side fetch — so their detection leans on the
// client fingerprints the extension posts from the live DOM; these are the fallback for any
// Dealer.com site that isn't bot-walled.
export function evidenceFromHtml(html) {
  const h = String(html || '');
  return {
    // DealerOn
    mentionsDealerOn: /dealeron/i.test(h),
    hasSitemapAspx: /sitemap\.aspx/i.test(h),
    hasSearchNew: /searchnew\.aspx/i.test(h),
    hasSearchUsed: /searchused\.aspx/i.test(h),
    hasInventoryPhotos: /\/inventoryphotos\//i.test(h),
    // Dealer.com (Cox Automotive)
    mentionsDealerDotCom: /pictures\.dealer\.com|images\.dealer\.com|\bwindow\.DDC\b|ddc-content/i.test(h),
    serverDdcInventoryPath: /\/(?:used|new|all)-inventory\/index\.htm/i.test(h),
    // Dealer Inspire (Cars.com) — usually Cloudflare-walled, so this is a fallback for the rare
    // reachable case; live detection leans on the client probe.
    mentionsDealerInspire: /dealerinspire\.com|carscommerce\.inc|data-vehicle-vin/i.test(h),
    // Carsforsale.com Chassis
    mentionsCarsForSale: /carsforsale\.com|powered\s+by\s+carsforsale/i.test(h),
    hasChassisInventory: /Chassis\.Modules\.Inventory|\/Inventory\/Details\//i.test(h),
    // AutoCorner / stockNum Systems
    mentionsAutoCorner: /(?:js-include|photos)\.autocorner\.com|powered-by["']?\s*[:=]\s*["']?AutoCorner|stockNum Systems/i.test(h),
    hasAutoCornerSrpEndpoint: /\/cgi-bin\/srp_vehicles\.cgi|alpineInventoryHandler/i.test(h)
  };
}

// Human-facing dealership name for an auto-created row: og:site_name, else <title>, else the
// caller's fallback (usually the apex domain).
export function siteNameFromHtml(html, fallback = null) {
  const h = String(html || '');
  const og = h.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
    || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  if (og && og[1].trim()) return og[1].trim().slice(0, 80);
  const t = h.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t && t[1].trim()) return t[1].trim().replace(/\s+/g, ' ').slice(0, 80);
  return fallback;
}

export async function fetchSiteEvidence(host, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!host || isBlockedHost(host)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`https://${host}/`, {
      headers: { 'User-Agent': DEALER_UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!resp || !resp.ok) return null;
    let finalHost = host;
    try { finalHost = new URL(resp.url || `https://${host}/`).hostname.toLowerCase(); } catch { /* keep input host */ }
    if (isBlockedHost(finalHost)) return null; // a redirect must never walk the fetch inward
    const html = (await resp.text()).slice(0, MAX_HTML_BYTES);
    return {
      evidence: evidenceFromHtml(html),
      siteName: siteNameFromHtml(html, null),
      finalHost
    };
  } catch {
    return null; // network error / timeout → caller falls back to client evidence
  } finally {
    clearTimeout(timer);
  }
}
