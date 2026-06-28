'use strict';

const BACKEND_URL = 'http://127.0.0.1:3737';
const MARKETPLACE_VEHICLE_CREATE_URL = 'https://www.facebook.com/marketplace/create/vehicle';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ ezlistBackendUrl: BACKEND_URL });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'EZLIST_GET_DRAFT':
      chrome.storage.local.get(['ezlistDraft', 'ezlistLastExtractedAt'], sendResponse);
      return true;

    case 'EZLIST_SAVE_DRAFT':
      chrome.storage.local.set({
        ezlistDraft: message.draft,
        ezlistLastExtractedAt: new Date().toISOString()
      }, () => sendResponse({ ok: true }));
      return true;

    case 'EZLIST_OPEN_FACEBOOK':
      chrome.tabs.create({ url: MARKETPLACE_VEHICLE_CREATE_URL }, (tab) => sendResponse({ ok: true, tabId: tab && tab.id }));
      return true;

    case 'EZLIST_FETCH_IMAGES':
      fetchImages(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
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

    default:
      return false;
  }
});

// Fetch vehicle photos in the worker: bypasses the Facebook page CSP/CORS that block in-page fetches.
// Accepts an explicit `urls` list, or a `baseUrl` to enumerate `${baseUrl}{n}.jpg`.
// Fetches with bounded concurrency, validates each image, tolerates gaps, and stops a
// gallery enumeration once a whole batch comes back empty.
const IMG_CONCURRENCY = 6;
const IMG_MIN_BYTES = 3000; // skip spacer/placeholder images

async function fetchImages({ urls, baseUrl, max = 20, width = 1080 }) {
  const enumerated = !(Array.isArray(urls) && urls.length);
  let targets;
  if (!enumerated) {
    targets = urls.slice(0, max).map((url, i) => ({ n: i + 1, url }));
  } else if (baseUrl) {
    targets = [];
    for (let n = 1; n <= max; n += 1) targets.push({ n, url: `${baseUrl}${n}.jpg?width=${width}` });
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
    // Enumerated gallery: a fully-empty batch after we already have photos means the gallery ended.
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

async function getBackendUrl() {
  const stored = await chrome.storage.local.get(['ezlistBackendUrl']);
  return stored.ezlistBackendUrl || BACKEND_URL;
}
