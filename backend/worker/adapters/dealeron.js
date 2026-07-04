import { isValidVin } from '../../vin.js';
import { DEALER_UA } from '../../dealer-url.js';

// Server-side DealerOn adapter — mirrors the extension's client-side DealerOn reader.
// Primary roster source is sitemap.aspx (one page, VIN-bearing inventory roster — verified
// in research.md/DealerOnformat.md: 604/605 17-char tokens pass the VIN check digit; the one
// reject is a content hash). We extract every 17-char token and keep only check-digit-valid
// VINs, so the parse is robust to markup changes. SRP pages are the fallback.

const MIN_GAP_MS = 2000; // per-host politeness: ≥2s between requests
const lastHit = new Map(); // host -> last fetch ms (module-level; in-process worker)

async function politeFetch(url, { headers = {}, timeoutMs = 15000, nowMs } = {}) {
  const host = new URL(url).host;
  const now = typeof nowMs === 'number' ? nowMs : null; // tests inject; prod uses real waits
  const prev = lastHit.get(host) || 0;
  if (now === null) {
    const wait = prev + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(host, Date.now());
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': DEALER_UA, Accept: 'text/html', ...headers }
    });
  } finally {
    clearTimeout(timer);
  }
}

// Extract unique, check-digit-valid VINs from a blob of HTML.
export function extractVins(html) {
  const tokens = html.match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
  const out = new Set();
  for (const t of tokens) if (isValidVin(t)) out.add(t.toUpperCase());
  return [...out];
}

// Fetch the VIN roster. Tier 1: sitemap.aspx. Tier 2: paginate configured SRP inventoryUrls.
// `condState` is an in-memory { etag, lastModified } for conditional GET (304 → reuse prior).
// Returns { ok, vins, source, notModified, error, condState }.
export async function fetchRoster(dealership, { fetchImpl = politeFetch, condState = {} } = {}) {
  const config = dealership.config || {};
  const sitemapUrl = config.sitemapUrl;

  if (sitemapUrl) {
    try {
      const headers = {};
      if (condState.etag) headers['If-None-Match'] = condState.etag;
      if (condState.lastModified) headers['If-Modified-Since'] = condState.lastModified;
      const resp = await fetchImpl(sitemapUrl, { headers });
      if (resp.status === 304) {
        // Unchanged since the last 200 → reuse that scan's roster (cached in condState).
        // vins stays null when there is no cache (fresh process) — the caller must then
        // treat membership as unknowable, never as "all present".
        return { ok: true, vins: condState.vins || null, source: 'sitemap', notModified: true, condState };
      }
      if (resp.ok) {
        const html = await resp.text();
        const vins = extractVins(html);
        const nextCond = {
          etag: resp.headers.get('etag') || null,
          lastModified: resp.headers.get('last-modified') || null,
          vins // roster cache so a later 304 can re-apply real membership
        };
        // A sitemap that parses to almost no VINs is suspect (bot wall / markup change) →
        // let the caller try SRP. Kept low (3, not 10) so small dealers still scan.
        if (vins.length >= 3) {
          return { ok: true, vins, source: 'sitemap', condState: nextCond };
        }
      }
    } catch (err) {
      // fall through to SRP
      void err;
    }
  }

  // Tier 2: SRP fallback — union VINs across the configured inventory pages.
  const inventoryUrls = Array.isArray(config.inventoryUrls) ? config.inventoryUrls : [];
  if (inventoryUrls.length) {
    const all = new Set();
    let anyOk = false;
    let lastError = null;
    for (const url of inventoryUrls) {
      try {
        const resp = await fetchImpl(url, {});
        if (!resp.ok) { lastError = `srp ${resp.status}`; continue; }
        anyOk = true;
        for (const v of extractVins(await resp.text())) all.add(v);
      } catch (err) {
        lastError = err.message;
      }
    }
    if (anyOk) return { ok: true, vins: [...all], source: 'srp', condState };
    return { ok: false, vins: [], source: 'srp', error: lastError || 'all srp fetches failed', condState };
  }

  return { ok: false, vins: [], source: 'sitemap', error: 'no roster source (sitemap parsed too few VINs, no SRP configured)', condState };
}
