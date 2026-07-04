'use strict';

importScripts('lib/lease.js'); // offline ES256 lease verifier (globalThis.CarxpertLease)

const BACKEND_URL = 'http://127.0.0.1:3737';
// Shared secret for the gated production backend (sent as the x-carxpert-token header).
// Empty in dev — the local backend is open; the store build injects the real value.
// See scripts/build-extension.js.
const BACKEND_TOKEN = '';
const MARKETPLACE_VEHICLE_CREATE_URL = 'https://www.facebook.com/marketplace/create/vehicle';
const DEALER_SEEN_TTL_MS = 30 * 60 * 1000;
const CHECKOUT_WATCH_MS = 2 * 60 * 1000;
const CHECKOUT_POLL_MS = 3000;
const CHECKOUT_SYNC_EVERY_MS = 30 * 1000;

// A single pre-warmed FB "create vehicle" tab so the heavy page load happens before the user clicks List.
let prewarmTabId = null;
chrome.tabs.onRemoved.addListener((id) => { if (id === prewarmTabId) prewarmTabId = null; });

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
      chrome.storage.local.set({
        ezlistDraft: message.draft,
        ezlistAutoFill: !!message.autoFill,
        ezlistLastExtractedAt: new Date().toISOString()
      }, () => sendResponse({ ok: true }));
      return true;

    case 'EZLIST_PREWARM':
      prewarm().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'EZLIST_OPEN_FACEBOOK':
      openOrReuseFacebook().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    // Side panel asked to (re)fill the form with the current stored draft.
    case 'EZLIST_FILL_NOW':
      fillFacebook(message.key).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
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

    case 'EZLIST_CONNECT_DEALER':
      connectRecentDealer().then(sendResponse).catch((error) => sendResponse(errorResponse(error)));
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

// ---- pre-warm / reuse the FB create tab ----
async function prewarm() {
  if (prewarmTabId != null) {
    try { await chrome.tabs.get(prewarmTabId); return { ok: true, already: true }; }
    catch { prewarmTabId = null; }
  }
  await chrome.storage.local.set({ ezlistAutoFill: false }); // don't auto-fill a stale draft on prewarm load
  const tab = await chrome.tabs.create({ url: MARKETPLACE_VEHICLE_CREATE_URL, active: false });
  prewarmTabId = tab.id;
  return { ok: true, tabId: tab.id };
}

async function openOrReuseFacebook() {
  if (prewarmTabId != null) {
    try {
      const tab = await chrome.tabs.get(prewarmTabId);
      if (tab && /\/marketplace\/create\/vehicle/.test(tab.url || tab.pendingUrl || '')) {
        await chrome.tabs.update(prewarmTabId, { active: true });
        if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        chrome.tabs.sendMessage(prewarmTabId, { type: 'EZLIST_DRAFT_UPDATED' }).catch(() => {});
        const id = prewarmTabId;
        prewarmTabId = null; // consumed
        return { ok: true, tabId: id, reused: true };
      }
    } catch { /* fall through to new tab */ }
    prewarmTabId = null;
  }
  const tab = await chrome.tabs.create({ url: MARKETPLACE_VEHICLE_CREATE_URL, active: true });
  return { ok: true, tabId: tab.id, reused: false };
}

// Ensure a create/vehicle tab is open and tell it to fill with the latest stored draft.
// A freshly-created tab fills itself on load (via the ezlistAutoFill flag the panel set);
// an already-open tab needs the explicit nudge.
async function fillFacebook(key) {
  const res = await openOrReuseFacebook();
  if (!res || !res.tabId) return { ok: false, error: 'no Facebook tab' };
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

function supportedDealerTabPatterns() {
  const manifest = chrome.runtime.getManifest();
  return (manifest.host_permissions || []).filter((pattern) =>
    /^https:\/\/[^/]+\/\*/i.test(pattern)
      && !/facebook\.com/i.test(pattern)
      && !/railway\.app/i.test(pattern)
      && !/localhost|127\.0\.0\.1/i.test(pattern)
  );
}

async function findSupportedDealerTab() {
  const patterns = supportedDealerTabPatterns();
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

async function resolveSeenDealer() {
  const seen = await recentDealerSeen();
  if (!seen) {
    const err = new Error('Open your dealership inventory page, then tap Detect again.');
    err.reason = 'no_recent_dealer';
    throw err;
  }
  return postBackend('/api/dealerships/resolve', {
    url: seen.url || `https://${seen.host}`,
    fingerprints: { source: 'extension_seen', host: seen.host, platform: seen.platform || null }
  });
}

async function connectRecentDealer() {
  const resolved = await resolveSeenDealer();
  if (!resolved.supported || !resolved.dealership || !resolved.dealership.id) {
    return {
      ok: false,
      reason: 'unsupported_dealer',
      error: 'This dealership is not supported yet. Send a request and we’ll add it.',
      normalizedDomain: resolved.normalizedDomain || null,
      detectedPlatform: resolved.detectedPlatform || null
    };
  }
  await postBackend('/api/dealerships/link', { dealershipId: resolved.dealership.id });
  const auth = await getAuthState({ refresh: true });
  return { ok: true, linked: true, dealership: resolved.dealership, auth };
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
      await chrome.storage.local.remove(['ezlistListings', 'ezlistListedVins', 'ezlistEventQueue']);
    }
    if (prevOwner !== me.user.id) await chrome.storage.local.set({ ezlistOwnerId: me.user.id });
  }
  const patch = { ezlistMe: me };
  if (data.lease) {
    try { patch.ezlistLease = { jws: data.lease, claims: CarxpertLease.decodeJwt(data.lease).payload }; }
    catch { /* malformed lease from server — skip caching it */ }
  }
  await chrome.storage.local.set(patch);
  if (!data.lease) await chrome.storage.local.remove('ezlistLease');
  return me;
}

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

// Map a local ezlistListings entry to the /api/listings/sync contract shape.
function toSyncListing(l) {
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
    soldPrice: l.soldPrice != null ? Number(l.soldPrice) : null
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
    const store = await chrome.storage.local.get(['ezlistListings', 'ezlistEventQueue']);
    const listings = Object.values(store.ezlistListings || {}).map(toSyncListing);
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
