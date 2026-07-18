'use strict';

// ezlist — dealership side. Injects a "List" button on each vehicle card (and on VDP pages),
// then extracts the vehicle into the neutral draft the marketplace fill engines consume.
//
// This file is the PROVIDER DISPATCHER: source-specific extraction (which cards exist, how to
// read a vehicle off one, where the photos live) lives in lib/extractors/<provider>.js, each
// registered on globalThis.CarxpertExtractors behind a common interface. Everything here — the
// List buttons, listed-state painting, entitlement gate, click→save→open flow, and the scan
// loop — is provider-agnostic and drives whichever extractor claims the page.

(() => {
  const HOST = location.hostname;
  // Only run on the dealership site (Facebook has its own content script).
  if (/facebook\.com$/i.test(HOST)) return;

  // Pick the extractor for this page. Order matters: the most specific provider wins; DealerOn is
  // the backward-compatible fallback (every host onboarded before the refactor is DealerOn).
  const EX = globalThis.CarxpertExtractors || {};
  // Specific providers first; `generic` (schema.org VDP fallback) is last so a recognized platform
  // always wins and generic only claims detail pages nothing else handled. DealerOn is the final fallback.
  const provider = [EX.dealercom, EX.dealeron, EX.dealerinspire, EX.generic].find((p) => p && p.detect()) || EX.dealeron;
  if (!provider) return; // extractor modules failed to load — do nothing rather than throw

  // Record what we're on so the side panel's Detect/onboard flow can resolve + link this dealer.
  // platform + live-DOM fingerprints drive backend detection (server fetches get bot-walled).
  chrome.storage.local.set({
    ezlistDealerSeen: {
      host: HOST.toLowerCase(),
      url: location.href,
      platform: provider.id,
      fingerprints: (() => { try { return provider.fingerprints(); } catch { return {}; } })(),
      ts: Date.now()
    }
  }).catch(() => {});

  // Per-dealer config comes from the backend dealership row (served in /api/me, cached as
  // ezlistMe). Missing location just leaves the marketplace location field for the user to fill.
  const DEALER = { location: '' };
  const applyDealerConfig = (me) => {
    const cfg = me && me.dealership && me.dealership.config;
    DEALER.location = (cfg && cfg.location) || '';
  };
  chrome.storage.local.get('ezlistMe').then((s) => applyDealerConfig(s.ezlistMe)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ezlistMe) applyDealerConfig(changes.ezlistMe.newValue);
  });

  // ---- button + click flow ----
  // "Where to post" selection (ezlistPrefs.platform, set in the side panel); FB is the default.
  let platform = 'fb';
  // NOTE: we deliberately do NOT prewarm the FB tab on hover. Chrome fires a "phantom" mouseenter
  // when a button is inserted under a stationary cursor — on a dense card grid that opened a blank
  // FB Marketplace tab on mere page refresh, with no click. FB now opens only on an explicit List
  // click (onList → EZLIST_OPEN_PLATFORM), which is the correct, intentional moment.

  // ---- listed-state (green "✓ Added") ----
  // A card turns green only once its VIN is confirmed *published* on Facebook — the FB
  // content script writes ezlistListedVins on a real publish (never on an abandoned form).
  // Until then it stays "⚡ List". Clicking a green button still re-runs the flow to re-list.
  let listedKeys = {};
  // Entitlement gate (C4): List buttons are live only when the user is signed in + subscribed.
  // Otherwise they render a "Sign in" affordance that opens the panel. Cheap cached read; the
  // background verifies the lease (dom-matched to this dealer host) / falls back to /api/me.
  let entitled = false;
  function refreshEntitled() {
    chrome.runtime.sendMessage({ type: 'EZLIST_GET_AUTH' })
      .then((r) => { const next = !!(r && r.ok && r.auth && r.auth.entitled); if (next !== entitled) { entitled = next; repaintAll(); } })
      .catch(() => {});
  }
  chrome.storage.local.get(['ezlistListedVins', 'ezlistPrefs'])
    .then((s) => {
      listedKeys = s.ezlistListedVins || {};
      platform = (s.ezlistPrefs && s.ezlistPrefs.platform) || 'fb';
      repaintAll();
    })
    .catch(() => {});
  refreshEntitled();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ezlistListedVins) {
      listedKeys = changes.ezlistListedVins.newValue || {};
      repaintAll();
    }
    if (changes.ezlistMe || changes.ezlistAuthToken) refreshEntitled();
    if (changes.ezlistPrefs) {
      const next = (changes.ezlistPrefs.newValue && changes.ezlistPrefs.newValue.platform) || 'fb';
      if (next !== platform) { platform = next; repaintAll(); } // re-color cards for the new marketplace
    }
  });

  // Inline ink-coloured bolt (the panel's lightning mark); fill:currentColor so it inherits
  // the button's text colour. Set via innerHTML (static markup, no user input).
  const BOLT = (sz) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex:0 0 auto"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z"/></svg>`;
  // ezlistListedVins entries are per-platform { fb?:{...}, craigslist?:{...} }; legacy flat
  // { listedAt } means Facebook. A card is "Added" only if it's listed on the SELECTED platform.
  const listedOn = (entry, plat) => {
    if (!entry || typeof entry !== 'object') return false;
    if ('listedAt' in entry) return plat === 'fb'; // legacy flat = Facebook
    return !!entry[plat];
  };
  function paint(btn) {
    if (btn.dataset.busy) return; // mid-click transient text — don't clobber
    const vdp = btn.classList.contains('ezlist-vdp-btn');
    if (!entitled) {
      // Locked: neutral chip that routes to sign-in rather than filling.
      btn.style.background = '#eceef3';
      btn.style.color = '#8a8d9b';
      btn.style.boxShadow = 'none';
      btn.innerHTML = `<span>🔒 ${vdp ? 'Sign in to list' : 'Sign in'}</span>`;
      btn.title = 'Sign in to CarXprt to list this vehicle';
      return;
    }
    const listed = !!(btn.dataset.ezkey && listedOn(listedKeys[btn.dataset.ezkey], platform));
    if (listed) {
      btn.style.background = '#178a3f';   // success green — reads clearly as "already listed"
      btn.style.color = '#fff';
      btn.style.boxShadow = vdp ? '0 7px 20px -6px rgba(23,138,63,.5)' : '0 2px 8px rgba(15,18,40,.2)';
      btn.innerHTML = `<span>✓ ${vdp ? 'Added · re-list' : 'Added'}</span>`;
    } else {
      btn.style.background = '#e7f852';    // Carxpert lime
      btn.style.color = '#1c1e12';         // ink — crisp on lime
      btn.style.boxShadow = vdp ? '0 7px 20px -6px rgba(231,248,82,.9)' : '0 2px 9px -1px rgba(231,248,82,.85)';
      btn.innerHTML = BOLT(vdp ? 14 : 12) + `<span>${vdp ? 'List on Marketplace' : 'List'}</span>`;
    }
    btn.title = listed ? 'Listed on Marketplace — click to re-list with changes' : 'List this vehicle on Facebook Marketplace';
  }
  function repaintAll() {
    document.querySelectorAll('.ezlist-list-btn, .ezlist-vdp-btn').forEach(paint);
  }

  // Extraction-quality telemetry: report which fields we managed to pull, per provider + dealer host,
  // so weak dealerships/themes surface in the data automatically — we can't manually test every
  // dealership on a platform. Fire-and-forget; it must NEVER break listing. Reported even when the
  // draft is incomplete (a missing VIN is exactly the signal worth capturing).
  function reportExtraction(draft) {
    try {
      const has = (v) => v !== undefined && v !== null && v !== '';
      const photoCount = Array.isArray(draft.photoUrls) ? draft.photoUrls.length : 0;
      const fields = {
        vin: has(draft.vin), year: has(draft.year), make: has(draft.make), model: has(draft.model),
        price: has(draft.price), mileage: draft.mileage != null, exteriorColor: has(draft.exteriorColor),
        transmission: has(draft.transmission), bodyType: has(draft.bodyType),
        photos: photoCount > 0 || has(draft.photoBaseUrl)
      };
      const keys = Object.keys(fields);
      const present = keys.filter((k) => fields[k]).length;
      chrome.runtime.sendMessage({
        type: 'EZLIST_ENQUEUE_EVENT',
        event: {
          type: 'extraction_completed',
          clientKey: (draft.vin || '').toUpperCase() || draft.stock || undefined,
          data: {
            provider: provider.id,
            host: location.hostname,
            target: platform,
            fields,
            missing: keys.filter((k) => !fields[k]),
            photoCount,
            completeness: Number((present / keys.length).toFixed(2))
          }
        }
      }).catch(() => {});
    } catch { /* telemetry must never break listing */ }
  }

  // Recompose the draft's description via the SHARED template (lib/mappers.core.js) with the
  // user's saved prefs (emoji, unit, mileage toggle) — so the auto-filled marketplace description
  // is exactly what the side panel shows. Without this, the extractor's own default got posted
  // while the panel displayed a different rendering. Best-effort: on any failure the draft keeps
  // the extractor's default (same full details, minor formatting differences at worst).
  async function applyDescriptionPrefs(draft) {
    try {
      const compose = globalThis.CarxpertCore && globalThis.CarxpertCore.composeDescription;
      if (!compose) return;
      const prefs = (await chrome.storage.local.get('ezlistPrefs')).ezlistPrefs || {};
      draft.description = compose(draft, prefs);
    } catch { /* keep the extractor default */ }
  }

  async function onList(scope, btn, sourceUrl) {
    if (!entitled) {
      // Not entitled → open the panel to sign in / subscribe instead of filling.
      chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_PANEL' }).catch(() => {});
      // Re-verify in case the cached flag was stale (e.g. the user just subscribed).
      chrome.runtime.sendMessage({ type: 'EZLIST_CAN_LIST', host: location.hostname })
        .then((r) => { if (r && r.ok) { entitled = true; repaintAll(); } }).catch(() => {});
      return;
    }
    btn.dataset.busy = '1';
    btn.textContent = '…'; btn.disabled = true;
    try {
      // Host gate: List only works on the user's LINKED dealership site (one dealership per
      // user). Entitlement alone isn't enough — static/granted hosts exist on every install,
      // so an entitled user on another dealer's site must be stopped here, not at fill time.
      const gate = await chrome.runtime.sendMessage({ type: 'EZLIST_CAN_LIST', host: location.hostname }).catch(() => null);
      if (gate && !gate.ok && gate.reason === 'wrong_dealership') {
        btn.textContent = 'Not your dealership';
        return; // finally still restores the steady state
      }
      const draft = await provider.extractVehicle(scope, sourceUrl, { location: DEALER.location });
      reportExtraction(draft); // capture quality before the VIN gate — incomplete drafts are the signal
      if (!draft.vin) throw new Error('no VIN found on this card');
      await applyDescriptionPrefs(draft); // saved draft must match what the panel shows (one template)
      await chrome.runtime.sendMessage({ type: 'EZLIST_SAVE_DRAFT', draft, autoFill: true, platform, key: (draft.vin || '').toUpperCase() });
      // Overlap: start downloading photos now, in parallel with the FB tab opening + form fill.
      // (FB uploads photos during the fill; Craigslist adds them on a later step, so skip there.)
      if (platform === 'fb') {
        if (Array.isArray(draft.photoUrls) && draft.photoUrls.length) {
          chrome.runtime.sendMessage({ type: 'EZLIST_PREFETCH_IMAGES', urls: draft.photoUrls.slice(0, 20) }).catch(() => {});
        } else if (draft.photoBaseUrl) {
          chrome.runtime.sendMessage({ type: 'EZLIST_PREFETCH_IMAGES', baseUrl: draft.photoBaseUrl, ext: draft.photoExt }).catch(() => {});
        }
      }
      await chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_PLATFORM', platform });
      btn.textContent = platform === 'fb' ? '✓ Opened FB' : '✓ Opened';
    } catch (e) {
      // "Extension context invalidated" = this tab's content script is stale after an
      // extension reload; a page refresh re-injects a fresh one. Guide the user rather than
      // showing a bare "Error".
      const stale = /context invalidated/i.test((e && e.message) || '');
      btn.textContent = stale ? '↻ Refresh page' : 'Error';
      console.error('[ezlist] list failed:', e);
    } finally {
      // Restore the correct steady state (green if since published, else "⚡ List").
      setTimeout(() => { delete btn.dataset.busy; btn.disabled = false; paint(btn); }, 2500);
    }
  }

  // z-index sits above card content (measured max ~10) but BELOW the dealer's sticky
  // header (1030) and sticky search bar (501), so the button is correctly occluded —
  // never poking over the site chrome — when its card scrolls underneath them.
  const BTN_STYLE = [
    'position:absolute', 'top:8px', 'right:8px', 'z-index:50',
    'display:inline-flex', 'align-items:center', 'gap:5px',
    'border:0', 'border-radius:8px',
    'padding:5px 9px', 'font:800 11.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    'letter-spacing:.1px', 'white-space:nowrap', 'cursor:pointer'
  ].join(';'); // background, text colour + shadow are set by paint() per listed-state

  function addCardButton(card) {
    if (!provider.cardReady(card)) return;
    if (card.querySelector(':scope > .ezlist-list-btn')) return;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ezlist-list-btn';
    btn.style.cssText = BTN_STYLE;
    btn.dataset.ezkey = provider.cardKey(card);
    paint(btn);
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onList(card, btn, provider.vdpUrlFor(card)); });
    card.appendChild(btn);
  }

  function addVdpButton() {
    if (document.querySelector('.ezlist-vdp-btn')) return;
    const el = provider.vdpVehicleEl();
    if (!el) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ezlist-vdp-btn';
    btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:11px;padding:10px 15px;font:800 13.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.1px;white-space:nowrap;cursor:pointer'; // bg, colour + shadow set by paint()
    btn.dataset.ezkey = provider.vdpKey();
    paint(btn);
    btn.addEventListener('click', () => onList(el, btn, location.href));
    document.body.appendChild(btn);
  }

  function scan() {
    // Inventory grid (and any "similar vehicles" rails): a List button per ready card.
    provider.findCards().forEach(addCardButton);
    // Detail page: a floating List button for the main vehicle.
    if (provider.isVdpPage()) addVdpButton();
  }

  // Popup-triggered listing of the car on the current detail page.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'EZLIST_LIST_CURRENT') return false;
    if (!provider.isVdpPage()) {
      sendResponse({ ok: false, error: 'Open a specific car page, or click List on the inventory grid.' });
      return false;
    }
    (async () => {
      try {
        const draft = await provider.extractVehicle(provider.vdpVehicleEl(), location.href, { location: DEALER.location });
        if (!draft.vin) { sendResponse({ ok: false, error: 'No vehicle data found on this page.' }); return; }
        await applyDescriptionPrefs(draft); // same shared template as the panel (see onList)
        await chrome.runtime.sendMessage({ type: 'EZLIST_SAVE_DRAFT', draft, autoFill: true, platform, key: (draft.vin || '').toUpperCase() });
        await chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_PLATFORM', platform });
        sendResponse({ ok: true, draft });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async sendResponse
  });

  // Same-site inventory presence check. Runs while the user is on their own dealer site, so the
  // detail-page fetches are same-origin and always carry the site's Cloudflare/Akamai clearance
  // cookie — the reliable path that clears every bot wall. The background worker gates this to
  // once per host / 3h and returns only THIS host's due cars; we fetch each, judge with the shared
  // page-gone logic, and report the verdicts back. Best-effort and silent — never blocks the UI.
  async function runSameSiteInventoryCheck() {
    try {
      const check = self.CarxpertInventoryCheck;
      if (!check || !chrome.runtime || !chrome.runtime.id) return;
      const res = await chrome.runtime.sendMessage({ type: 'EZLIST_INV_SAMESITE_CARS', host: HOST }).catch(() => null);
      const cars = (res && res.cars) || [];
      if (!cars.length) return;

      const fetchImpl = (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        return fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', signal: controller.signal })
          .finally(() => clearTimeout(timer));
      };
      const reports = [];
      for (let i = 0; i < cars.length; i += 1) {
        const car = cars[i];
        const verdict = await check.checkOne(fetchImpl, { sourceUrl: car.sourceUrl, vin: car.vin });
        reports.push({ clientKey: car.clientKey, present: verdict.present, checkedAt: new Date().toISOString() });
        if (i < cars.length - 1) await new Promise((r) => setTimeout(r, 1500));
      }
      await chrome.runtime.sendMessage({ type: 'EZLIST_INV_SAMESITE_REPORT', host: HOST, reports }).catch(() => {});
    } catch { /* best-effort telemetry — ignore */ }
  }

  let scanTimer = null;
  const debouncedScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300); };
  const start = () => {
    scan();
    new MutationObserver(debouncedScan).observe(document.body, { childList: true, subtree: true });
    // Kick the presence check a little after load so it never competes with page render / extraction.
    setTimeout(() => { runSameSiteInventoryCheck(); }, 8000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
