'use strict';

// Keeps a pinned extension ID from carrying credentials and cached entitlement across backend
// environments. Staging and production intentionally share an ID for OAuth, so the compiled
// backend URL, not chrome.storage, is the environment source of truth.
(function attach(root) {
  async function reconcile(storage, { backendUrl, backendToken = '' }) {
    if (!storage || !backendUrl) throw new Error('Runtime configuration is incomplete.');

    const previous = await storage.get(['ezlistBackendUrl']);
    const changed = !!previous.ezlistBackendUrl && previous.ezlistBackendUrl !== backendUrl;
    if (changed) await storage.clear();

    const next = { ezlistBackendUrl: backendUrl };
    if (backendToken) next.ezlistBackendToken = backendToken;
    await storage.set(next);
    if (!backendToken) await storage.remove('ezlistBackendToken');

    return { changed, backendUrl };
  }

  const api = { reconcile };
  root.CarxpertRuntimeConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
