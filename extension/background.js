'use strict';

importScripts('lib/lease.js', 'lib/platforms.js', 'lib/inventoryCheck.js'); // lease verifier + platform registry + inventory presence check

const { getPlatform } = globalThis.CarxpertPlatforms;

const BACKEND_URL = 'http://127.0.0.1:3737';
// Shared secret for the gated production backend (sent as the x-carxpert-token header).
// Empty in dev — the local backend is open; the store build injects the real value.
// See scripts/build-extension.js.
const BACKEND_TOKEN = '';
const DEALER_SEEN_TTL_MS = 30 * 60 * 1000;
const CHECKOUT_WATCH_MS = 2 * 60 * 1000;
const CHECKOUT_POLL_MS = 3000;
const CHECKOUT_SYNC_EVERY_MS = 30 * 1000;

// A single pre-warmed "create listing" tab so the heavy page load happens before the user
// clicks List. Tagged with the platform it was opened for, so it's only reused for that
// platform's fill (Facebook today; Craigslist/OfferUp reuse the same slot as they ship).
let prewarmTabId = null;
let prewarmPlatform = null;
chrome.tabs.onRemoved.addListener((id) => {
  if (id === prewarmTabId) { prewarmTabId = null; prewarmPlatform = null; }
});

// Clicking the toolbar icon opens the docked side panel (Chrome 114+).
function enableSidePanelOnActionClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
chrome.runtime.onInstalled.addListener(() => {
  const init = { ezlistBackendUrl: BACKEND_URL };
  if (BACKEND_TOKEN) init.ezlistBackendToken = BACKEND_TOKEN;
  chrome.storage.local.set(init);
  enableSidePanelOnActionClick();
});
chrome.runtime.onStartup.addListener(enableSidePanelOnActionClick);
enableSidePanelOnActionClick();

// Fallback: if setPanelBehavior didn't take (e.g. the service worker didn't run its
// init on a fresh load), the toolbar click still fires onClicked — open the panel
// explicitly. When the native behavior IS set, onClicked doesn't fire, so this never
// double-opens. Clicking always wakes the SW, so this listener is guaranteed to register.
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (tab && tab.windowId != null && chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  });
}

function errorResponse(error) {
  return {
    ok: false,
    error: error && error.message ? error.message : 'Something went wrong.',
    reason: error && error.reason ? error.reason : null,
    status: error && error.status ? error.status : null
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'EZLIST_GET_DRAFT':
      chrome.storage.local.get(['ezlistDraft', 'ezlistLastExtractedAt', 'ezlistAutoFill'], sendResponse);
      return true;

    case 'EZLIST_SAVE_DRAFT':
      // Platform-tagged one-shot: { platform, key } when auto-fill is requested, else false.
      // Each platform's content script only fires on a flag that names it, so an open FB tab
      // never auto-fills a draft meant for Craigslist and vice versa. Dealer/legacy callers
      // send no platform → defaults to 'fb'.
      chrome.storage.local.set({
        ezlistDraft: message.draft,
        ezlistAutoFill: message.autoFill ? { platform: message.platform || 'fb', key: message.key || '' } : false,
        ezlistLastExtractedAt: new Date().toISOString()
      }, () => sendResponse({ ok: true }));
      return true;

    case 'EZLIST_PREWARM':
      prewarm(message.platform).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // Fetch a dealer detail page's HTML in the worker. Content-script fetches don't reliably carry
    // the site's Cloudflare/Akamai session, so the extractors (Dealer Inspire/Dealer.com VDP scrape)
    // delegate here — the worker sends the site's cookies (credentials:'include') under the granted
    // host permission, clearing the bot wall the way the FB photo fetch does.
    case 'EZLIST_FETCH_HTML':
      fetchDealerHtml(message.url).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // Manual trigger for the cross-site inventory-presence check (also runs on the 3h alarm).
    case 'EZLIST_CHECK_INVENTORY':
      runInventoryCheck().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // Same-site path: the dealer content script asks which of THIS host's listed cars are due for
    // a presence check (throttled per host). It then fetches them same-origin (guaranteed to carry
    // the site's bot-wall cookie) and reports back via EZLIST_INV_SAMESITE_REPORT.
    case 'EZLIST_INV_SAMESITE_CARS':
      inventoryCarsForHost(message.host).then(sendResponse).catch(() => sendResponse({ cars: [] }));
      return true;

    case 'EZLIST_INV_SAMESITE_REPORT':
      reportSameSitePresence(message.host, message.reports).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // EZLIST_OPEN_FACEBOOK kept for the FB-only dealer/panel callers; platform defaults to fb.
    case 'EZLIST_OPEN_FACEBOOK':
    case 'EZLIST_OPEN_PLATFORM':
      openOrReusePlatformTab(message.platform).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // Side panel asked to (re)fill the form with the current stored draft.
    case 'EZLIST_FILL_NOW':
      fillPlatform(message.platform, message.key).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_PREFETCH_IMAGES':
      startFetch(message).catch(() => {}); // warm the cache; result awaited later by FETCH_IMAGES
      sendResponse({ ok: true });
      return false;

    case 'EZLIST_FETCH_IMAGES':
      startFetch(message)
        .then(sendResponse)
        .catch((error) => { imageCache.delete(cacheKey(message)); sendResponse({ ok: false, error: error.message }); });
      return true;

    // AI (our backend holds the OpenAI key — users never supply one).
    case 'EZLIST_AI_DESCRIBE':
      aiDescribe(message.vehicle, message.options)
        .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_AI_TRANSLATE':
      aiTranslate(message.text, message.targetLang)
        .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // Optional Firecrawl fallback path for dealers without structured data.
    case 'EZLIST_EXTRACT':
      extractViaBackend(message.payload || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_HEALTH':
      health().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // ---- auth + entitlement (C1/C2) ----
    case 'EZLIST_SIGN_IN':
      signIn().then((auth) => sendResponse({ ok: true, auth })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_SIGN_OUT':
      signOut().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_GET_AUTH':
      getAuthState({ refresh: message.refresh }).then((auth) => sendResponse({ ok: true, auth })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_BILLING_PLAN':
      billingPlan().then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
      return true;

    // Detect (resolve) only — NEVER links. Optional message.url resolves a user-entered site
    // instead of the device's last-seen dealer, so a new account can pick its own dealership.
    case 'EZLIST_DETECT_DEALER':
      detectDealer(message.url, { canProbe: !!message.canProbe }).then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
      return true;

    // Explicit link — only ever called after the user confirms the detected dealership.
    case 'EZLIST_LINK_DEALER':
      linkDealer(message.dealershipId).then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
      return true;

    case 'EZLIST_REQUEST_DEALER':
      requestDealerSupport(message.payload || {}).then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
      return true;

    case 'EZLIST_CAN_LIST':
      canList(message.host).then(sendResponse).catch((error) => sendResponse({ ok: false, reason: 'error', error: error.message }));
      return true;

    case 'EZLIST_CHECKOUT':
      billingUrl('/api/billing/checkout').then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
      return true;

    case 'EZLIST_PORTAL':
      billingUrl('/api/billing/portal').then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
      return true;

    case 'EZLIST_OPEN_PANEL':
      openPanel(sender).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // ---- listings sync (C5) ----
    case 'EZLIST_SYNC':
      syncNow().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_GET_LISTINGS':
      getServerListings().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_ENQUEUE_EVENT':
      enqueueEvent(message.event).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    default:
      return false;
  }
});

// ---- pre-warm / reuse a platform's create tab ----
function clearPrewarm() { prewarmTabId = null; prewarmPlatform = null; }

async function prewarm(platformId) {
  const platform = getPlatform(platformId);
  // Only reuse an existing prewarm tab if it's for the same platform.
  if (prewarmTabId != null && prewarmPlatform === platform.id) {
    try { await chrome.tabs.get(prewarmTabId); return { ok: true, already: true }; }
    catch { clearPrewarm(); }
  }
  await chrome.storage.local.set({ ezlistAutoFill: false }); // don't auto-fill a stale draft on prewarm load
  const tab = await chrome.tabs.create({ url: platform.createUrl, active: false });
  prewarmTabId = tab.id;
  prewarmPlatform = platform.id;
  return { ok: true, tabId: tab.id };
}

async function openOrReusePlatformTab(platformId) {
  const platform = getPlatform(platformId);
  if (prewarmTabId != null && prewarmPlatform === platform.id) {
    try {
      const tab = await chrome.tabs.get(prewarmTabId);
      if (tab && platform.isCreateUrl(tab.url || tab.pendingUrl || '')) {
        await chrome.tabs.update(prewarmTabId, { active: true });
        if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        chrome.tabs.sendMessage(prewarmTabId, { type: 'EZLIST_DRAFT_UPDATED' }).catch(() => {});
        const id = prewarmTabId;
        clearPrewarm(); // consumed
        return { ok: true, tabId: id, reused: true };
      }
    } catch { /* fall through to new tab */ }
    clearPrewarm();
  }
  const tab = await chrome.tabs.create({ url: platform.createUrl, active: true });
  return { ok: true, tabId: tab.id, reused: false };
}

// Ensure the platform's create tab is open and tell it to fill with the latest stored draft.
// A freshly-created tab fills itself on load (via the ezlistAutoFill flag the panel set);
// an already-open tab needs the explicit nudge. The right platform's content script is the
// only one on that tab, so a plain EZLIST_FILL routes correctly without platform branching.
async function fillPlatform(platformId, key) {
  const res = await openOrReusePlatformTab(platformId);
  if (!res || !res.tabId) return { ok: false, error: 'no target tab' };
  try { await chrome.tabs.sendMessage(res.tabId, { type: 'EZLIST_FILL', key }); }
  catch { /* tab still loading — it will auto-fill once the content script boots */ }
  return { ok: true, tabId: res.tabId, reused: res.reused };
}

// ---- image fetching, with a short-lived prefetch cache so downloads overlap the FB page load ----
const imageCache = new Map(); // key -> Promise<{ ok, images, count }>
const IMG_CACHE_MAX = 4;

function cacheKey(msg) {
  if (Array.isArray(msg.urls) && msg.urls.length) return `urls:${msg.urls.length}:${msg.urls[0]}`;
  return `base:${msg.baseUrl || ''}`;
}

function startFetch(msg) {
  const key = cacheKey(msg);
  if (!imageCache.has(key)) {
    imageCache.set(key, fetchImages(msg));
    while (imageCache.size > IMG_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  }
  return imageCache.get(key);
}

// Fetch a dealer detail page's HTML in the worker (credentialed, so it clears Cloudflare/Akamai
// under the granted host permission). Capped at 3MB; https only. Used by the VDP extractors.
async function fetchDealerHtml(url) {
  if (!/^https:\/\/[^/]+/i.test(String(url || ''))) return { ok: false, error: 'bad url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', signal: controller.signal });
    if (!resp || !resp.ok) return { ok: false, status: resp ? resp.status : 0 };
    const html = (await resp.text()).slice(0, 3 * 1024 * 1024);
    return { ok: true, html };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch vehicle photos in the worker: bypasses the Facebook page CSP/CORS that block in-page fetches.
// Bounded concurrency, validates each image, tolerates gaps, and stops a gallery once a batch is empty.
const IMG_CONCURRENCY = 6;
const IMG_MIN_BYTES = 3000;

async function fetchImages({ urls, baseUrl, ext, max = 20, width = 1080 }) {
  const enumerated = !(Array.isArray(urls) && urls.length);
  let targets;
  if (!enumerated) {
    targets = urls.slice(0, max).map((url, i) => ({ n: i + 1, url }));
  } else if (baseUrl) {
    // Gallery extension comes from the dealer page (used cars: ip/*.jpg, new-car stock
    // photos: sp/*.png) — probing the wrong one yields zero images.
    const extname = ext || 'jpg';
    targets = [];
    for (let n = 1; n <= max; n += 1) targets.push({ n, url: `${baseUrl}${n}.${extname}?width=${width}` });
  } else {
    return { ok: false, error: 'no image source provided' };
  }

  const good = [];
  for (let i = 0; i < targets.length; i += IMG_CONCURRENCY) {
    const batch = targets.slice(i, i + IMG_CONCURRENCY);
    const settled = await Promise.all(batch.map((t) =>
      fetchOneImage(t.url).then((img) => ({ n: t.n, ...img }), () => ({ n: t.n, ok: false }))));
    const hits = settled.filter((r) => r.ok);
    good.push(...hits);
    if (enumerated && hits.length === 0 && good.length > 0) break;
  }

  good.sort((a, b) => a.n - b.n);
  const images = good.map((r, i) => ({ dataUrl: r.dataUrl, name: `ezlist-${i + 1}.jpg` }));
  return { ok: true, images, count: images.length, attempted: targets.length };
}

async function fetchOneImage(url, retries = 1) {
  try {
    const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!resp.ok) return { ok: false };
    const blob = await resp.blob();
    if (!/^image\//.test(blob.type)) return { ok: false };
    if (blob.size < IMG_MIN_BYTES) return { ok: false };
    return { ok: true, dataUrl: await blobToDataUrl(blob), size: blob.size };
  } catch (e) {
    if (retries > 0) return fetchOneImage(url, retries - 1);
    return { ok: false };
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

// ---- AI calls (routed through our backend; the key lives there, not in the extension) ----
// Build request headers with the bearer session token (and, during the token→bearer
// transition, the legacy x-carxpert-token). Both are sent so nothing breaks before the A5
// cutover flips the backend to bearer-only.
async function authHeaders(extra) {
  const store = await chrome.storage.local.get(['ezlistAuthToken', 'ezlistBackendToken']);
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (store.ezlistAuthToken) headers.Authorization = `Bearer ${store.ezlistAuthToken}`;
  if (store.ezlistBackendToken) headers['x-carxpert-token'] = store.ezlistBackendToken;
  return headers;
}

async function postBackend(pathname, payload) {
  const backendUrl = await getBackendUrl();
  let resp;
  try {
    resp = await fetch(`${backendUrl}${pathname}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(payload) });
  } catch (e) {
    throw new Error('Backend not reachable — is it running? (npm run dev:backend)');
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401) { await clearAuth(); throw new Error('Please sign in again.'); }
  if (resp.status === 402) {
    const err = new Error(data.error || 'A subscription is required for this.');
    err.status = resp.status;
    err.reason = data.reason || 'no_subscription';
    throw err;
  }
  if (!resp.ok || !data.ok) {
    const err = new Error(data.error || `Backend returned ${resp.status}`);
    err.status = resp.status;
    err.reason = data.reason || null;
    throw err;
  }
  return data;
}

async function aiDescribe(vehicle, options) {
  const data = await postBackend('/api/ai/describe', { vehicle: vehicle || {}, options: options || {} });
  return { ok: true, description: data.description };
}

async function aiTranslate(text, targetLang) {
  const data = await postBackend('/api/ai/translate', { text: text || '', targetLang: targetLang || 'en' });
  return { ok: true, translated: data.translated };
}

async function extractViaBackend(payload) {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/api/listings/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `Backend returned ${response.status}`);
  await chrome.storage.local.set({ ezlistDraft: result.listing, ezlistLastExtractedAt: new Date().toISOString() });
  return result;
}

async function health() {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/health`);
  return response.json();
}

async function billingPlan() {
  const backendUrl = await getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/billing/plan`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || `Backend returned ${resp.status}`);
  return { ok: true, plan: data.plan || null };
}

async function getBackendUrl() {
  const stored = await chrome.storage.local.get(['ezlistBackendUrl']);
  return stored.ezlistBackendUrl || BACKEND_URL;
}

// ==================== dealership onboarding ====================

async function recentDealerSeen() {
  const seen = (await chrome.storage.local.get('ezlistDealerSeen')).ezlistDealerSeen;
  if (seen && seen.host && seen.ts && (Date.now() - Number(seen.ts)) <= DEALER_SEEN_TTL_MS) return seen;
  return findSupportedDealerTab();
}

async function supportedDealerTabPatterns() {
  const manifest = chrome.runtime.getManifest();
  const staticPatterns = (manifest.host_permissions || []).filter((pattern) =>
    /^https:\/\/[^/]+\/\*/i.test(pattern)
      && !/facebook\.com/i.test(pattern)
      && !/craigslist\.org/i.test(pattern)
      && !/railway\.app/i.test(pattern)
      && !/localhost|127\.0\.0\.1/i.test(pattern)
  );
  // Dynamically-registered dealer origins (connected dealerships beyond the static manifest).
  let dynamic = [];
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['cx-dealer-dynamic'] });
    dynamic = scripts.flatMap((s) => s.matches || []);
  } catch { /* scripting unavailable — static only */ }
  return [...new Set([...staticPatterns, ...dynamic])];
}

async function findSupportedDealerTab() {
  const patterns = await supportedDealerTabPatterns();
  for (const pattern of patterns) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: pattern }); } catch { tabs = []; }
    const tab = tabs.find((t) => t.active && t.url) || tabs.find((t) => t.url);
    if (!tab || !tab.url) continue;
    let host = '';
    try { host = new URL(tab.url).hostname.toLowerCase(); } catch { continue; }
    const fallbackSeen = { host, url: tab.url, platform: 'dealeron', ts: Date.now() };
    await chrome.storage.local.set({ ezlistDealerSeen: fallbackSeen });
    return fallbackSeen;
  }
  return null;
}

// Resolve a dealership WITHOUT linking it. With `urlOverride` (user-entered site) that URL is
// resolved; otherwise the device's last-seen / open dealer tab is used as the suggestion. The
// panel shows the result and the user explicitly confirms before EZLIST_LINK_DEALER runs —
// auto-linking the machine's last-seen dealer once bound a new account to the wrong dealership.
// Read platform fingerprints off the LIVE dealer site by injecting a one-shot probe into a tab
// on that host — the only way to detect bot-walled platforms (Dealer.com/Cox front with Akamai,
// which 403s the backend's server-side fetch, so its HTML never reaches us). Needs host access
// (requested from the side panel during the Detect click) + the `scripting` permission. Reuses
// an already-open tab on the host, else opens one in the background and closes it after.
async function probeSiteFingerprints(url, host) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return null;
  const bare = host.replace(/^www\./, '');
  const onHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') === bare; } catch { return false; } };
  if (!(await chrome.permissions.contains({ origins: [`https://${host}/*`] }).catch(() => false))
    && !(await chrome.permissions.contains({ origins: [`https://${bare}/*`] }).catch(() => false))) {
    return null; // no access granted → can't inject
  }
  // Runs IN the page (MAIN world, so window.DDC is reachable). Detects Dealer.com via signals
  // present on EVERY page including the homepage — the DDC JS/CDN assets and any DDC widget/class —
  // not just inventory-page markers. Also carries the DealerOn markers so a manual detect of a
  // DealerOn site works off the live DOM too.
  const probe = () => {
    const q = (s) => !!document.querySelector(s);
    const hasDdcAssets = q('script[src*="dealer.com"], link[href*="dealer.com"], img[src*="pictures.dealer.com"], img[src*="images.dealer.com"]');
    const hasDdcDom = q('.ddc-content, [data-widget-name], [class*="ddc-"], [id*="ddc-"]');
    let hasDdcGlobal = false;
    try { hasDdcGlobal = !!(window.DDC || window.DDCAPI); } catch { /* cross-origin/global guard */ }
    // Universal-onboarding signals: a dealer site on ANY platform (Dealer Inspire, Sincro, …) that
    // exposes schema.org can self-serve as 'generic'. AutoDealer marks a dealership site; Vehicle
    // marks inventory. Inventory links are a weak corroborating hint.
    const ldText = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '').join(' ');
    const hasSchemaAutoDealer = /"@type"\s*:\s*"(?:AutoDealer|AutomotiveBusiness|Car ?dealer)"/i.test(ldText);
    const hasSchemaVehicle = /vehicleIdentificationNumber|"@type"\s*:\s*"(?:Vehicle|Car)"/i.test(ldText);
    const hasInventoryLinks = !!document.querySelector('a[href*="inventory" i], a[href*="/vehicle" i], a[href*="/used-" i], a[href*="/new-" i]');
    // Dealer Inspire (Cars.com): its cards carry data-vehicle JSON and it ships assets from
    // dealerinspire.com / carscommerce.inc.
    const diAssets = !!document.querySelector('[data-vehicle][data-vehicle-vin], img[src*="dealerinspire.com"], img[src*="carscommerce.inc"], script[src*="dealerinspire.com"], link[href*="dealerinspire.com"]');
    const siteName = (() => {
      const og = document.querySelector('meta[property="og:site_name"]');
      if (og && og.content && og.content.trim()) return og.content.trim().slice(0, 80);
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent);
          for (const o of (Array.isArray(d) ? d : [d])) {
            if (o && /AutoDealer/i.test(o['@type'] || '') && o.name) return String(o.name).trim().slice(0, 80);
          }
        } catch { /* ignore malformed ld+json */ }
      }
      return (document.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    })();
    return {
      ddcNamespace: hasDdcAssets || hasDdcDom || hasDdcGlobal,
      vehicleCardUuid: q('li.vehicle-card[data-uuid]'),
      ddcInventoryPath: /\/(?:used|new|all|certified)-inventory\//i.test(location.pathname),
      vehicleInfoVin: q('[data-vehicle-information][data-vin]'),
      dotagging: q('[data-dotagging-item-id],[data-dotagging-element-type]'),
      hasSchemaAutoDealer,
      hasSchemaVehicle,
      hasInventoryLinks,
      diAssets,
      siteName,
      _dbg: { host: location.host, path: location.pathname, hasDdcAssets, hasDdcDom, hasDdcGlobal, schemaDealer: hasSchemaAutoDealer, schemaVehicle: hasSchemaVehicle, title: (document.title || '').slice(0, 60) }
    };
  };
  const runProbe = async (tabId) => {
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probe });
      return (results && results[0] && results[0].result) || null;
    } catch (e) { console.warn('[cx] probe executeScript failed:', e && e.message); return null; }
  };
  const usable = (r) => r && (r.ddcNamespace || r.vehicleInfoVin || r.dotagging || r.hasSchemaAutoDealer || r.hasSchemaVehicle || r.diAssets);

  let tab = (await chrome.tabs.query({}).catch(() => [])).find((t) => t.url && onHost(t.url));
  let opened = false;
  try {
    if (!tab) {
      tab = await chrome.tabs.create({ url, active: false });
      opened = true;
      await waitForTabComplete(tab.id, 15000);
      await sleep(1500); // let the DDC shell/Akamai settle before reading the DOM
    }
    let result = await runProbe(tab.id);
    // A freshly-opened tab can land mid-render or on an Akamai settle — retry once after a beat.
    if (!usable(result) && opened) { await sleep(2000); result = await runProbe(tab.id); }
    console.log('[cx] dealer probe result:', result && result._dbg, '→ ddcNamespace:', result && result.ddcNamespace);
    return result;
  } catch (e) { console.warn('[cx] probe failed:', e && e.message); return null; }
  finally { if (opened && tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {}); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve once a tab reaches 'complete' (or timeout), so an injected probe reads a rendered page.
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(); }).catch(() => {});
    setTimeout(finish, timeoutMs);
  });
}

async function detectDealer(urlOverride, { canProbe = false } = {}) {
  let payload;
  if (urlOverride) {
    let u = String(urlOverride).trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    let host = '';
    try { host = new URL(u).hostname.toLowerCase(); } catch { /* fall through */ }
    if (!host) return { ok: false, error: 'That doesn’t look like a valid website address.' };
    const fingerprints = { source: 'extension_manual', host };
    // Bot-walled platforms are invisible to the backend's fetch — probe the live site for them.
    if (canProbe) {
      const probed = await probeSiteFingerprints(u, host).catch(() => null);
      if (probed) Object.assign(fingerprints, probed);
    }
    payload = { url: u, fingerprints };
  } else {
    const seen = await recentDealerSeen();
    if (!seen) {
      const err = new Error('Open your dealership inventory page, then tap Detect again.');
      err.reason = 'no_recent_dealer';
      throw err;
    }
    payload = {
      url: seen.url || `https://${seen.host}`,
      // Spread the live-DOM fingerprints the content script captured (e.g. Dealer.com's
      // ddcNamespace/vehicleCardUuid) — for Akamai-walled platforms these are the ONLY evidence
      // the backend gets, since its server-side fetch is blocked.
      fingerprints: { source: 'extension_seen', host: seen.host, platform: seen.platform || null, ...(seen.fingerprints || {}) }
    };
  }
  const resolved = await postBackend('/api/dealerships/resolve', payload);
  if (!resolved.supported || !resolved.dealership || !resolved.dealership.id) {
    return {
      ok: false,
      reason: 'unsupported_dealer',
      error: 'This dealership is not supported yet. Send a request and we’ll add it.',
      normalizedDomain: resolved.normalizedDomain || null,
      detectedPlatform: resolved.detectedPlatform || null
    };
  }
  return { ok: true, supported: true, dealership: resolved.dealership };
}

async function linkDealer(dealershipId) {
  if (!dealershipId) return { ok: false, error: 'No dealership selected.' };
  await postBackend('/api/dealerships/link', { dealershipId });
  const auth = await getAuthState({ refresh: true });
  return { ok: true, linked: true, auth };
}

async function requestDealerSupport(payload) {
  const body = {
    url: payload.url || '',
    contactName: payload.contactName || '',
    contactEmail: payload.contactEmail || '',
    contactPhone: payload.contactPhone || '',
    notes: payload.notes || '',
    fingerprints: payload.fingerprints || { source: 'extension_request' }
  };
  const data = await postBackend('/api/dealerships/request', body);
  const auth = await getAuthState({ refresh: true });
  return { ok: true, request: { id: data.id, deduped: !!data.deduped }, auth };
}

// ==================== auth + entitlement (C1/C2) ====================

const AUTH_CODE_RE = /[?&]code=([^&]+)/;

// Sign in via chrome.identity.launchWebAuthFlow → backend start/finish → one-time code →
// exchange for a bearer session token. Only the code ever transits the redirect URL.
async function signIn() {
  const backend = await getBackendUrl();
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: `${backend}/api/auth/extension/start`,
    interactive: true
  });
  const m = String(redirect || '').match(AUTH_CODE_RE);
  if (!m) throw new Error('Sign-in was cancelled.');
  const code = decodeURIComponent(m[1]);
  let resp;
  try {
    resp = await fetch(`${backend}/api/auth/extension/exchange`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
  } catch { throw new Error('Backend not reachable during sign-in.'); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok || !data.token) throw new Error(data.error || 'Sign-in failed.');
  await chrome.storage.local.set({ ezlistAuthToken: data.token });
  await refreshMe();                 // populate profile / entitlement / lease
  // First sign-in: bulk-upload local listings (best effort). syncNow lands in C5.
  if (typeof syncNow === 'function') syncNow().catch(() => {});
  return getAuthState();
}

async function signOut() { await clearAuth(); }

async function clearAuth() {
  await chrome.storage.local.remove(['ezlistAuthToken', 'ezlistMe', 'ezlistLease']);
}

async function getToken() {
  return (await chrome.storage.local.get('ezlistAuthToken')).ezlistAuthToken || '';
}

// Pull /api/me and cache profile + entitlement + (if entitled) a fresh lease. Offline-safe:
// a network failure keeps the existing cache rather than logging the user out.
async function refreshMe() {
  const token = await getToken();
  if (!token) { await chrome.storage.local.remove(['ezlistMe', 'ezlistLease']); return null; }
  const backend = await getBackendUrl();
  let resp;
  try {
    resp = await fetch(`${backend}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return (await chrome.storage.local.get('ezlistMe')).ezlistMe || null; // offline: keep cache
  }
  if (resp.status === 401) { await clearAuth(); return null; }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `me ${resp.status}`);
  const me = {
    user: data.user || null,
    dealership: data.dealership || null,
    requestPending: data.requestPending || null,
    entitled: !!data.entitled,
    reason: data.reason || null,
    subscription: data.subscription || null,
    fetchedAt: Date.now()
  };
  // Local listing history is account-scoped. On a shared dealership computer, a different
  // salesperson signing in must not inherit — or auto-sync — the previous user's listings.
  // No stored owner (pre-auth data on this device) → adopt it; a different owner → purge.
  if (me.user && me.user.id) {
    const prevOwner = (await chrome.storage.local.get('ezlistOwnerId')).ezlistOwnerId;
    if (prevOwner && prevOwner !== me.user.id) {
      // Everything car- or account-scoped goes: history AND the current selection. Leaving
      // ezlistDraft behind handed a new sign-up the previous user's selected vehicle (from a
      // different dealership); a stale ezlistAutoFill could even auto-fill it on the next
      // marketplace tab. ezlistDealerSeen goes too so the connect step doesn't suggest the
      // previous user's dealership.
      await chrome.storage.local.remove([
        'ezlistListings', 'ezlistListedVins', 'ezlistEventQueue',
        'ezlistDraft', 'ezlistAutoFill', 'ezlistLastExtractedAt',
        'ezlistInFlight', 'ezlistClPendingPhotos', 'ezlistDealerSeen'
      ]);
    }
    if (prevOwner !== me.user.id) await chrome.storage.local.set({ ezlistOwnerId: me.user.id });
  }
  // Best-effort: repopulate green-button state from the server (no-op unless local is empty).
  if (me.entitled) restoreListedFromServer().catch(() => {});
  const patch = { ezlistMe: me };
  if (data.lease) {
    try { patch.ezlistLease = { jws: data.lease, claims: CarxpertLease.decodeJwt(data.lease).payload }; }
    catch { /* malformed lease from server — skip caching it */ }
  }
  await chrome.storage.local.set(patch);
  if (!data.lease) await chrome.storage.local.remove('ezlistLease');
  // Keep the dealer content scripts registered for whatever dealership is now linked.
  ensureDealerScripts(me).catch(() => {});
  return me;
}

// ==================== dynamic dealer content scripts ====================
// The dealer scripts (⚡ List buttons + extraction) inject on whatever dealership the user
// connected — any DealerOn site, not just the manifest's static host. The panel requests the
// host permission at Connect (user gesture); here we (re)register one scripting registration
// covering the linked dealership's granted domains. Registration persists across restarts,
// but we re-sync on every /me refresh + startup so a dealership switch swaps the scripts.
const DEALER_SCRIPT_ID = 'cx-dealer-dynamic';

function dealerOriginPatterns(dealership) {
  const domains = (dealership && dealership.domains) || [];
  return [...new Set(domains.map((d) => `https://${String(d).toLowerCase()}/*`))];
}

async function ensureDealerScripts(me) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  const patterns = dealerOriginPatterns(me && me.dealership);
  const granted = [];
  for (const p of patterns) {
    try { if (await chrome.permissions.contains({ origins: [p] })) granted.push(p); }
    catch { /* invalid pattern — skip */ }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DEALER_SCRIPT_ID] }).catch(() => []);
  if (!granted.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DEALER_SCRIPT_ID] }).catch(() => {});
    return;
  }
  const script = {
    id: DEALER_SCRIPT_ID,
    matches: granted,
    js: ['lib/mappers.core.js', 'lib/inventoryCheck.js', 'lib/extractors/schemaorg.js', 'lib/extractors/dealeron.js', 'lib/extractors/dealercom.js', 'lib/extractors/dealerinspire.js', 'lib/extractors/generic.js', 'dealerContent.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]).catch(() => {});
  else await chrome.scripting.registerContentScripts([script]).catch(() => {});
}

// Re-sync on worker boot (covers browser restarts and extension reloads).
(async () => {
  const me = (await chrome.storage.local.get('ezlistMe')).ezlistMe;
  if (me) ensureDealerScripts(me).catch(() => {});
})();

// Cached JWKS; refetch on force (unknown kid → rotation) and cache.
async function getJwks(force) {
  if (!force) {
    const cached = (await chrome.storage.local.get('ezlistJwks')).ezlistJwks;
    if (cached && cached.keys) return cached;
  }
  const backend = await getBackendUrl();
  try {
    const r = await fetch(`${backend}/.well-known/jwks.json`);
    const j = await r.json();
    if (j && j.keys) { await chrome.storage.local.set({ ezlistJwks: j }); return j; }
  } catch { /* fall back to cache */ }
  return (await chrome.storage.local.get('ezlistJwks')).ezlistJwks || null;
}

// Verify the cached lease locally. Refetches JWKS once if the kid is unknown (rotation).
async function verifyCachedLease() {
  const lease = (await chrome.storage.local.get('ezlistLease')).ezlistLease;
  if (!lease || !lease.jws) return { valid: false, reason: 'none', claims: null };
  let jwks = await getJwks();
  let res = jwks ? await CarxpertLease.verifyLeaseJws(lease.jws, jwks) : { valid: false, reason: 'no_jwks', claims: lease.claims };
  if (!res.valid && res.reason === 'unknown_kid') {
    jwks = await getJwks(true);
    if (jwks) res = await CarxpertLease.verifyLeaseJws(lease.jws, jwks);
  }
  return res;
}

// The auth snapshot the panel + content scripts read. `refresh:true` forces a /me pull;
// otherwise it uses cache and refreshes in the background when /me is stale (>5 min).
async function getAuthState(opts) {
  const opt = opts || {};
  const token = await getToken();
  if (token && (opt.refresh || await meIsStale())) {
    try { await refreshMe(); } catch { /* keep cache */ }
  }
  const store = await chrome.storage.local.get(['ezlistAuthToken', 'ezlistMe', 'ezlistLease']);
  const signedIn = !!store.ezlistAuthToken;
  const me = store.ezlistMe || null;
  let leaseValid = false;
  let leaseClaims = (store.ezlistLease && store.ezlistLease.claims) || null;
  if (store.ezlistLease && store.ezlistLease.jws) {
    const res = await verifyCachedLease();
    leaseValid = res.valid;
    if (res.claims) leaseClaims = res.claims;
    if (res.valid) maybeRefreshLease(res.claims);
  }
  return {
    signedIn,
    entitled: me ? me.entitled : false,
    reason: me ? me.reason : (signedIn ? 'unknown' : 'signed_out'),
    user: me ? me.user : null,
    dealership: me ? me.dealership : null,
    requestPending: me ? me.requestPending : null,
    subscription: me ? me.subscription : null,
    leaseValid,
    leaseClaims
  };
}

async function meIsStale() {
  const me = (await chrome.storage.local.get('ezlistMe')).ezlistMe;
  if (!me || !me.fetchedAt) return true;
  return (Date.now() - me.fetchedAt) > 5 * 60 * 1000;
}

// Refresh the lease (via /me) when <10 min remain. Fire-and-forget; guarded against stampede.
let leaseRefreshing = false;
async function maybeRefreshLease(claims) {
  if (leaseRefreshing) return;
  if (CarxpertLease.secondsToExpiry(claims) > 10 * 60) return;
  leaseRefreshing = true;
  try { await refreshMe(); } catch { /* ignore */ } finally { leaseRefreshing = false; }
}

// Gate check for a paid action (List/Fill). Lease-first (offline tolerant — no network in the
// hot path), falling back to a /me pull. Returns { ok, reason }. reason mirrors /api/me so the
// panel can render the right gate step: signed_out | no_dealership | no_subscription | expired.
async function canList(host) {
  const res = await verifyCachedLease();
  if (res.valid && (!host || CarxpertLease.leaseCoversHost(res.claims, host))) {
    maybeRefreshLease(res.claims);
    return { ok: true, reason: 'ok', via: 'lease' };
  }
  let me;
  try { me = await refreshMe(); } catch { me = (await chrome.storage.local.get('ezlistMe')).ezlistMe || null; }
  if (!me) return { ok: false, reason: (await getToken()) ? 'unknown' : 'signed_out' };
  if (!me.entitled) return { ok: false, reason: me.reason || 'not_entitled' };
  return { ok: true, reason: 'ok', via: 'me' };
}

// Stripe checkout / billing-portal: ask the backend for a hosted URL and open it in a tab.
async function billingUrl(pathname) {
  const data = await postBackend(pathname, {});
  if (!data.url) throw new Error('No URL returned.');
  await chrome.tabs.create({ url: data.url, active: true });
  if (pathname === '/api/billing/checkout') startCheckoutWatch().catch(() => {});
  return { ok: true, url: data.url };
}

let checkoutWatchTimer = null;

async function startCheckoutWatch() {
  await chrome.storage.local.set({
    ezlistCheckoutWatch: { startedAt: Date.now(), lastSyncAt: Date.now() - (CHECKOUT_SYNC_EVERY_MS - 8000) }
  });
  chrome.alarms.create('ezlist-checkout-watch', { delayInMinutes: 0.5 });
  scheduleCheckoutWatch(1000);
}

function scheduleCheckoutWatch(delayMs = CHECKOUT_POLL_MS) {
  clearTimeout(checkoutWatchTimer);
  checkoutWatchTimer = setTimeout(() => { pollCheckoutWatch().catch(() => {}); }, delayMs);
}

async function pollCheckoutWatch() {
  const watch = (await chrome.storage.local.get('ezlistCheckoutWatch')).ezlistCheckoutWatch;
  if (!watch || !watch.startedAt) return false;
  const age = Date.now() - Number(watch.startedAt);
  if (age > CHECKOUT_WATCH_MS) {
    await chrome.storage.local.remove('ezlistCheckoutWatch');
    chrome.alarms.clear('ezlist-checkout-watch').catch(() => {});
    return false;
  }

  const me = await refreshMe();
  if (me && me.entitled) {
    await chrome.storage.local.remove('ezlistCheckoutWatch');
    chrome.alarms.clear('ezlist-checkout-watch').catch(() => {});
    syncNow().catch(() => {});
    return false;
  }

  const lastSync = Number(watch.lastSyncAt || 0);
  if (Date.now() - lastSync > CHECKOUT_SYNC_EVERY_MS) {
    await chrome.storage.local.set({
      ezlistCheckoutWatch: { ...watch, lastSyncAt: Date.now() }
    });
    billingSync().catch(() => {});
  }

  scheduleCheckoutWatch();
  return true;
}

async function billingSync() {
  return postBackend('/api/billing/sync', {});
}

// Open the side panel from a content-script request (best effort — needs a window id + gesture).
async function openPanel(sender) {
  const windowId = sender && sender.tab && sender.tab.windowId;
  if (windowId != null && chrome.sidePanel && chrome.sidePanel.open) {
    await chrome.sidePanel.open({ windowId });
  }
}

// ==================== listings sync (C5) ====================

// The per-platform slots for a car (ezlistListedVins entry) → the sync contract's platforms[]
// array. Legacy flat entries ({listedAt}) read as Facebook. Undefined when nothing is recorded,
// so the payload stays clean for cars with no publish state.
function platformsFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  const slots = ('listedAt' in entry) ? { fb: entry } : entry;
  const arr = Object.entries(slots)
    .filter(([, m]) => m && typeof m === 'object')
    .map(([platform, m]) => ({ platform, status: 'listed', listedAt: m.listedAt || null, url: m.url || null }));
  return arr.length ? arr : undefined;
}

// Map a local ezlistListings entry to the /api/listings/sync contract shape. `listedEntry` is
// the car's ezlistListedVins slots — the source of per-platform presence + listing URLs.
function toSyncListing(l, listedEntry) {
  return {
    clientKey: l.key,
    vin: l.vin || null,
    stock: l.stock || null,
    title: l.title || null,
    year: l.year ? Number(l.year) : null,
    make: l.make || null,
    model: l.model || null,
    price: l.price != null ? Number(l.price) : null,
    sourceUrl: l.sourceUrl || null,
    platform: l.platform || 'fb',
    status: l.status === 'sold' ? 'sold' : 'listed', // local 'active' → server 'listed'
    listedAt: l.listedAt || null,
    soldAt: l.soldAt || null,
    soldPrice: l.soldPrice != null ? Number(l.soldPrice) : null,
    soldPlatform: l.soldPlatform || null,
    platforms: platformsFromEntry(listedEntry)
  };
}

// Push tracked listings + queued events to the backend. No-op when signed out. The event
// queue is cleared only for events actually flushed (server dedupes by client uuid), so
// anything enqueued during the request survives.
let syncing = false;
async function syncNow() {
  if (!(await getToken())) return { ok: false, reason: 'signed_out' };
  if (syncing) return { ok: true, skipped: 'in_progress' };
  syncing = true;
  try {
    const store = await chrome.storage.local.get(['ezlistListings', 'ezlistEventQueue', 'ezlistListedVins']);
    const listedMap = store.ezlistListedVins || {};
    const listings = Object.values(store.ezlistListings || {}).map((l) => toSyncListing(l, listedMap[l.key]));
    const events = store.ezlistEventQueue || [];
    if (!listings.length && !events.length) return { ok: true, empty: true };
    const data = await postBackend('/api/listings/sync', { listings, events });
    if (events.length) {
      const flushed = new Set(events.map((e) => e.id));
      const now = (await chrome.storage.local.get('ezlistEventQueue')).ezlistEventQueue || [];
      await chrome.storage.local.set({ ezlistEventQueue: now.filter((e) => !flushed.has(e.id)) });
    }
    return { ok: true, listings: listings.length, events: events.length, server: data };
  } finally {
    syncing = false;
  }
}

// Server-side listings for the stats view (entitled). 402 → not entitled (panel keeps local).
async function getServerListings() {
  const backend = await getBackendUrl();
  let resp;
  try { resp = await fetch(`${backend}/api/listings`, { headers: await authHeaders() }); }
  catch { return { ok: false, reason: 'offline' }; }
  if (resp.status === 401) { await clearAuth(); return { ok: false, reason: 'signed_out' }; }
  if (resp.status === 402) return { ok: false, reason: 'not_entitled' };
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) return { ok: false, reason: `http_${resp.status}` };
  return { ok: true, listings: data.listings || [] };
}

// ---- inventory presence check (Part 1) ----
// Two complementary paths report the same telemetry, both judged by the shared page-gone logic
// (lib/inventoryCheck.js), and both fully platform-agnostic (they only need each car's stored
// detail-page URL + VIN, so they cover DealerOn, Dealer.com/Cox, Dealer Inspire and generic alike):
//
//   • SAME-SITE  (dealerContent.js, when the user is on their dealer site): same-origin fetches
//     always carry the site's Cloudflare/Akamai clearance cookie, so they clear every bot wall.
//     This is the reliable path — a 'present:true' from it CLEARS any false miss the cross-site
//     path might have recorded.
//   • CROSS-SITE (this worker, on the 3h alarm): credentialed fetch under the granted host
//     permission. Covers cars whose dealer site the user hasn't visited recently. A challenged or
//     failed fetch resolves to 'unknown' (never 'gone'), so it can never falsely retire a car.
//
// Both share one per-host 3h throttle so they never double-probe. Telemetry only for now; the
// backend does NOT sell yet (Part 2). Polite: capped per run and spaced out.
const INV_CHECK_MAX = 25;                 // cars checked per run
const INV_CHECK_GAP_MS = 1500;            // spacing between detail-page fetches (per host politeness)
const INV_FETCH_TIMEOUT_MS = 12000;       // per detail-page fetch (a hung request must not stall the run)
const INV_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000; // per-host throttle: at most one check / 3h across both paths
let invChecking = false;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const sameHostName = (a, b) => bareHost(a) === bareHost(b);

// Detail-page fetch with a hard timeout. credentials:'include' sends the dealer's own cookies
// under the granted host permission (cross-site) or same-origin (content script reuses this shape).
function dealerVdpFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INV_FETCH_TIMEOUT_MS);
  return fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function hostGranted(host) {
  if (!chrome.permissions || !host) return false;
  const bare = bareHost(host);
  return (await chrome.permissions.contains({ origins: [`https://${host}/*`] }).catch(() => false))
    || (await chrome.permissions.contains({ origins: [`https://${bare}/*`] }).catch(() => false))
    || (await chrome.permissions.contains({ origins: [`https://www.${bare}/*`] }).catch(() => false));
}

// Per-host throttle map { "<bareHost>": epochMs } — shared by both paths.
async function getInvThrottle() {
  return (await chrome.storage.local.get('ezlistInvCheckAt')).ezlistInvCheckAt || {};
}
async function markHostsChecked(hosts) {
  if (!hosts.length) return;
  const map = await getInvThrottle();
  const now = Date.now();
  for (const h of hosts) map[bareHost(h)] = now;
  await chrome.storage.local.set({ ezlistInvCheckAt: map });
}
function hostDue(map, host) {
  const last = map[bareHost(host)] || 0;
  return Date.now() - last >= INV_MIN_INTERVAL_MS;
}

// Ask the backend for the user's listed cars + detail-page URLs. Returns { cars } or { error }.
async function fetchCarsToCheck() {
  if (!(await getToken())) return { error: 'signed_out' };
  const backend = await getBackendUrl();
  let resp;
  try {
    resp = await fetch(`${backend}/api/inventory/to-check`, { headers: await authHeaders() });
  } catch { return { error: 'backend_unreachable' }; }
  if (resp.status === 401) { await clearAuth(); return { error: 'signed_out' }; }
  if (!resp.ok) return { error: `to-check ${resp.status}` };
  const cars = ((await resp.json().catch(() => ({}))).cars) || [];
  return { cars };
}

// Cross-site sweep (3h alarm): check every listed car whose host is granted AND not checked in the
// last 3h (the same-site path may have covered it already). A missing permission or a challenged
// fetch yields 'unknown', which the backend ignores.
async function runInventoryCheck() {
  if (invChecking) return { ok: false, skipped: 'in_progress' };
  invChecking = true;
  try {
    const res = await fetchCarsToCheck();
    if (res.error) return { ok: false, reason: res.error };
    const cars = res.cars;
    if (!cars.length) return { ok: true, checked: 0 };

    const throttle = await getInvThrottle();
    const due = [];
    for (const car of cars) {
      const host = hostOf(car.sourceUrl);
      if (!host || !hostDue(throttle, host)) continue;      // recently checked (likely same-site) → skip
      if (!(await hostGranted(host))) continue;             // no host permission → can't fetch cross-site
      due.push(car);
    }
    if (!due.length) return { ok: true, checked: 0, skipped: 'none_due_or_granted' };

    const reports = [];
    const touched = new Set();
    const batch = due.slice(0, INV_CHECK_MAX);
    for (let i = 0; i < batch.length; i += 1) {
      const car = batch[i];
      const verdict = await self.CarxpertInventoryCheck.checkOne(dealerVdpFetch, { sourceUrl: car.sourceUrl, vin: car.vin });
      reports.push({ clientKey: car.clientKey, present: verdict.present, checkedAt: new Date().toISOString() });
      touched.add(hostOf(car.sourceUrl));
      if (i < batch.length - 1) await sleep(INV_CHECK_GAP_MS);
    }
    await markHostsChecked([...touched]);
    const server = await postBackend('/api/inventory/presence', { reports }).catch(() => null);
    console.log(`inventory-check (cross-site): ${reports.length} car(s) checked`, server || '');
    return { ok: true, checked: reports.length, server };
  } catch (e) {
    console.warn('inventory-check failed:', (e && e.message) || e);
    return { ok: false, error: (e && e.message) || 'error' };
  } finally {
    invChecking = false;
  }
}

// Same-site path — the dealer content script asks for THIS host's due cars. We optimistically stamp
// the throttle on hand-out so a second content-script instance (or a page reload) doesn't re-probe;
// the 3h alarm is the retry if the run never reports. Returns { cars: [{clientKey, vin, sourceUrl}] }.
async function inventoryCarsForHost(host) {
  if (!host) return { cars: [] };
  const throttle = await getInvThrottle();
  if (!hostDue(throttle, host)) return { cars: [] };
  const res = await fetchCarsToCheck();
  if (res.error) return { cars: [] };
  const mine = res.cars.filter((c) => sameHostName(hostOf(c.sourceUrl), host)).slice(0, INV_CHECK_MAX);
  if (!mine.length) return { cars: [] };
  await markHostsChecked([host]);   // optimistic — prevents duplicate same-site storms
  return { cars: mine };
}

// The content script's same-site verdicts → backend (telemetry only).
async function reportSameSitePresence(host, reports) {
  const list = Array.isArray(reports) ? reports : [];
  if (!list.length) return { ok: true, checked: 0 };
  await markHostsChecked(host ? [host] : []);
  const server = await postBackend('/api/inventory/presence', { reports: list }).catch(() => null);
  console.log(`inventory-check (same-site ${host || '?'}): ${list.length} car(s) reported`, server || '');
  return { ok: true, checked: list.length, server };
}

// Fire every 3h (matches the DealerOn server worker's new cadence). chrome.alarms persists and
// wakes the service worker; creating with the same name is idempotent.
const INV_ALARM = 'cx-inventory-check';
function armInventoryAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create(INV_ALARM, { periodInMinutes: 180, delayInMinutes: 10 });
}
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === INV_ALARM) runInventoryCheck().catch(() => {}); });
}

// Arm the 3h inventory-presence alarm on every worker boot (idempotent). Must run AFTER INV_ALARM
// is initialized above — calling it at the top of the file hits the const's temporal dead zone and
// crashes the whole service worker on registration.
armInventoryAlarm();

// New device / post-purge restore: the server is the source of truth for what's already
// published. When local green-button state is empty, rebuild it from the server so a
// salesperson doesn't accidentally double-list cars they published from another machine.
async function restoreListedFromServer() {
  const local = (await chrome.storage.local.get('ezlistListedVins')).ezlistListedVins || {};
  if (Object.keys(local).length) return;
  const res = await getServerListings();
  if (!res.ok || !res.listings.length) return;
  const listed = {};
  for (const l of res.listings) {
    if (l.status !== 'listed' || !l.client_key) continue;
    // Per-platform shape ({ fb: {...}, craigslist: {...} }): prefer the server's platforms[]
    // (listing_platforms child rows — full multi-platform state incl. View-listing URLs);
    // fall back to the legacy single platform column for pre-migration servers.
    const entry = listed[l.client_key] || {};
    const plats = Array.isArray(l.platforms) ? l.platforms.filter((p) => p && p.platform && p.status !== 'removed') : [];
    if (plats.length) {
      for (const p of plats) {
        entry[p.platform] = { listedAt: p.listedAt || l.listed_at || new Date().toISOString(), url: p.url || undefined, restored: true };
      }
    } else {
      entry[l.platform || 'fb'] = { listedAt: l.listed_at || new Date().toISOString(), restored: true };
    }
    listed[l.client_key] = entry;
  }
  if (Object.keys(listed).length) await chrome.storage.local.set({ ezlistListedVins: listed });
}

// Append an event to the offline queue (client uuid = idempotency key). Deduped by id;
// bounded so a permanently-offline client can't grow storage without limit.
async function enqueueEvent(event) {
  if (!event || !event.type) return;
  const ev = {
    id: event.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: event.type,
    clientKey: event.clientKey || null,
    occurredAt: event.occurredAt || new Date().toISOString(),
    data: event.data || null
  };
  const q = (await chrome.storage.local.get('ezlistEventQueue')).ezlistEventQueue || [];
  if (q.some((e) => e.id === ev.id)) return;
  q.push(ev);
  await chrome.storage.local.set({ ezlistEventQueue: q.slice(-500) });
}

// Auto-sync when tracked listings or the event queue change (publish detection, mark sold,
// enqueued events) — debounced, best-effort, only when signed in.
let syncTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ezlistListings || changes.ezlistEventQueue) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, 4000);
  }
});

// Periodic flush: the debounce timer above dies with the MV3 worker, so a queued event could
// otherwise strand until the next storage change. Alarms survive worker restarts.
chrome.alarms.create('ezlist-sync', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ezlist-sync') syncNow().catch(() => {});
  if (alarm.name === 'ezlist-checkout-watch') {
    pollCheckoutWatch()
      .then((keepWatching) => {
        if (keepWatching) chrome.alarms.create('ezlist-checkout-watch', { delayInMinutes: 0.5 });
      })
      .catch(() => {});
  }
});
