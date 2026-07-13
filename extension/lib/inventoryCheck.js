'use strict';

// Inventory presence check (Part 1): is a listed car's DETAIL PAGE still up on the dealer site?
// This is the universal, platform-agnostic replacement for the DealerOn-only server worker — it
// runs in the extension (browser session, so it clears Akamai/Cloudflare) and only needs each
// listed car's stored detail-page URL + VIN.
//
// PAGE-GONE ONLY for now: a car is "gone" if its page 404/410s, or loads but no longer contains
// the VIN (e.g. the platform redirected a removed car to the search page). A page that stays up
// with a "SOLD" badge but still shows the VIN is intentionally treated as ALIVE here — sold-but-
// live detection is a future enhancement, deliberately deferred.
//
// Loaded in the classic service worker via importScripts (attaches to `self`); also exported for
// node:test. Pure `judgeVdp` + `checkOne(fetchImpl,…)` so both are testable without a browser.

(function attach(root) {
  // Pure verdict from an already-fetched response. Never throws.
  //   'alive'   → 200-range and the body still contains the VIN
  //   'gone'    → 404/410, OR a 2xx/3xx-final page whose body no longer contains the VIN
  //   'unknown' → 5xx / network / unreadable / missing inputs — callers must NEVER act on this
  function judgeVdp({ status, html, vin } = {}) {
    if (!vin) return 'unknown';
    if (status === 404 || status === 410) return 'gone';
    if (typeof status !== 'number' || status < 200 || status >= 400) return 'unknown';
    if (typeof html !== 'string') return 'unknown';
    return html.toUpperCase().includes(String(vin).toUpperCase()) ? 'alive' : 'gone';
  }

  // Fetch one detail page and judge it. `fetchImpl(url)` must resolve to a Response-like object
  // with `.status` and `.text()` (in the extension this is a credentialed same-session fetch).
  // Returns { present: true|false|null, status, verdict } — present mirrors the verdict.
  async function checkOne(fetchImpl, { sourceUrl, vin } = {}) {
    if (!sourceUrl || !vin) return { present: null, status: null, verdict: 'unknown' };
    let status = null;
    let html = null;
    try {
      const resp = await fetchImpl(sourceUrl);
      status = resp && typeof resp.status === 'number' ? resp.status : null;
      // Only read the body when it could change the verdict (2xx/3xx-final) — no wasted read on 404.
      if (typeof status === 'number' && status >= 200 && status < 400 && resp && typeof resp.text === 'function') {
        html = await resp.text();
      }
    } catch {
      return { present: null, status: null, verdict: 'error' };
    }
    const verdict = judgeVdp({ status, html, vin });
    return { present: verdict === 'alive' ? true : verdict === 'gone' ? false : null, status, verdict };
  }

  const api = { judgeVdp, checkOne };
  root.CarxpertInventoryCheck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
