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

// DealerOn markers, matched against raw homepage HTML. Key names line up with the aliases
// buildEvidence() picks (fingerprint.js).
export function evidenceFromHtml(html) {
  const h = String(html || '');
  return {
    mentionsDealerOn: /dealeron/i.test(h),
    hasSitemapAspx: /sitemap\.aspx/i.test(h),
    hasSearchNew: /searchnew\.aspx/i.test(h),
    hasSearchUsed: /searchused\.aspx/i.test(h),
    hasInventoryPhotos: /\/inventoryphotos\//i.test(h)
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
