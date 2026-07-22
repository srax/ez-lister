'use strict';

// Pure candidate helpers shared by the MV3 worker and Node tests. Detection is intentionally
// device-local: open/recent dealer tabs are suggestions only, and the user confirms one before
// the backend link endpoint is called.
(function attach(root) {
  function normalizeHost(value) {
    try {
      return new URL(String(value || '').includes('://') ? String(value) : `https://${value}`)
        .hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function uniqueSeen(items, { now = Date.now(), ttlMs = 30 * 60 * 1000, limit = 8 } = {}) {
    const byHost = new Map();
    for (const item of items || []) {
      const host = normalizeHost(item && (item.host || item.url));
      const ts = Number(item && item.ts) || now;
      if (!host || now - ts > ttlMs) continue;
      const candidate = { ...item, host, ts };
      const existing = byHost.get(host);
      if (!existing || candidate.active || candidate.ts > existing.ts) byHost.set(host, candidate);
    }
    return [...byHost.values()]
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || b.ts - a.ts)
      .slice(0, Math.max(1, Number(limit) || 8));
  }

  function uniqueResolved(results, limit = 8) {
    const byDealer = new Map();
    for (const result of results || []) {
      if (!result || !result.ok || !result.dealership || !result.dealership.id) continue;
      if (!byDealer.has(result.dealership.id)) byDealer.set(result.dealership.id, result);
    }
    return [...byDealer.values()].slice(0, Math.max(1, Number(limit) || 8));
  }

  // `activeTab` exposes only the tab the user explicitly invoked CarXprt on. Keep that narrow
  // boundary here so onboarding never needs the broad `tabs` / browsing-history permission.
  async function currentWebTab(queryTabs, { now = Date.now() } = {}) {
    if (typeof queryTabs !== 'function') return null;
    try {
      const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      const rawUrl = tab && (tab.url || tab.pendingUrl);
      if (!rawUrl) return null;
      const url = new URL(String(rawUrl));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        host: url.hostname.toLowerCase(),
        url: url.href,
        active: true,
        ts: now
      };
    } catch {
      return null;
    }
  }

  const api = { normalizeHost, currentWebTab, uniqueSeen, uniqueResolved };
  root.CarxpertDealerCandidates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
