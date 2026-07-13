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
  // Markers that a 2xx/3xx page is a bot-wall / interstitial / error shell rather than the real
  // VDP (present or removed). If the VIN is absent AND the body looks like one of these, we must
  // NOT call the car gone — a cross-site fetch that got challenged would otherwise falsely "sell"
  // a live car. Matched case-insensitively. Kept tight so genuine removed/search pages (which are
  // large and carry none of these) still resolve to 'gone'.
  const BLOCK_MARKERS = [
    // Cloudflare
    'just a moment', 'cf-browser-verification', 'cf-chl-', '/cdn-cgi/challenge-platform',
    'checking your browser before', 'attention required! | cloudflare', 'cloudflare ray id',
    // Akamai / Imperva-Incapsula / PerimeterX / DataDome / F5
    'pardon our interruption', 'access denied', 'incapsula incident', '_incapsula_',
    'request unsuccessful. incapsula', 'px-captcha', 'datadome', 'unusual traffic from your',
    // Generic bot / captcha / JS-required shells
    'verifying you are human', 'please enable javascript and cookies', 'enable cookies to continue',
    'g-recaptcha', 'hcaptcha'
  ];

  // A 2xx page with no VIN: is it a genuine removed/search page (→ gone) or a blocked/empty shell
  // (→ unknown)? Empty or suspiciously tiny bodies, and known bot-wall markers, are treated as
  // "can't tell", never gone.
  function looksBlockedOrEmpty(html) {
    const body = typeof html === 'string' ? html : '';
    if (body.trim().length < 512) return true; // truncated / empty / minimal block shell
    const low = body.toLowerCase();
    return BLOCK_MARKERS.some((m) => low.includes(m));
  }

  // Pure verdict from an already-fetched response. Never throws.
  //   'alive'   → 200-range and the body still contains the VIN
  //   'gone'    → 404/410, OR a 2xx/3xx-final page that is a real page but no longer shows the VIN
  //   'unknown' → 5xx / network / unreadable / missing inputs / bot-wall or empty shell — NEVER acted on
  function judgeVdp({ status, html, vin } = {}) {
    if (!vin) return 'unknown';
    if (status === 404 || status === 410) return 'gone';
    if (typeof status !== 'number' || status < 200 || status >= 400) return 'unknown';
    if (typeof html !== 'string') return 'unknown';
    if (html.toUpperCase().includes(String(vin).toUpperCase())) return 'alive';
    // VIN absent — only call it gone if this is a real, substantive page (not a challenge/empty shell).
    return looksBlockedOrEmpty(html) ? 'unknown' : 'gone';
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
      // Cap the string so a pathologically large page can't blow up memory across a whole batch.
      if (typeof status === 'number' && status >= 200 && status < 400 && resp && typeof resp.text === 'function') {
        html = (await resp.text()).slice(0, 3 * 1024 * 1024);
      }
    } catch {
      return { present: null, status: null, verdict: 'error' };
    }
    const verdict = judgeVdp({ status, html, vin });
    return { present: verdict === 'alive' ? true : verdict === 'gone' ? false : null, status, verdict };
  }

  const api = { judgeVdp, checkOne, looksBlockedOrEmpty };
  root.CarxpertInventoryCheck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
