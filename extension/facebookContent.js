'use strict';

// ezlist — Facebook Marketplace "Vehicle for sale" auto-filler.
// The generic DOM-driving primitives now live in lib/fillkit.js (globalThis.CarxpertFill),
// loaded first per the manifest. This file is Facebook adapter #1: it owns the field list,
// UK-English labels, the "n / 20" photo counter, and publish detection.
//   - dropdowns are <label role="combobox"> that open a portal [role="listbox"] of [role="option"]
//   - text fields are bare <input>/<textarea> wrapped in a <label> (no id/aria)
//   - field name resolves from aria-labelledby (dropdowns) else textContent (text fields)
//   - photos upload via DataTransfer -> input.files -> dispatch('change')

(() => {
  const isFacebook = /(\.|^)facebook\.com$/i.test(location.hostname) || /(\.|^)web\.facebook\.com$/i.test(location.hostname);
  if (!isFacebook) return;
  if (document.getElementById('ezlist-facebook-host')) return;

  // ---------- shared DOM primitives (lib/fillkit.js, loaded first per manifest) ----------
  const {
    sleep, norm, waitUntil, getLabel, waitForLabel, readOptions,
    closeAnyDropdown, settleUi, fillTextField, selectDropdown, fillAutocomplete,
    attachPhotos, waitForCount,
  } = globalThis.CarxpertFill;

  // ---------- dealer term -> Facebook option mapping ----------
  // Facebook's value taxonomy (lib/mappers.fb.js, loaded first per manifest); unit-tested
  // in lib/mappers.fb.test.js. Canonical values are the US composer's options;
  // optionCandidates() expands each to [US, UK] so a UK-locale composer still matches.
  const { mapColor, mapBody, mapFuel, mapTransmission, optionCandidates, judgePublishNav } = globalThis.CarxpertFb;

  // Every FB dropdown fill goes through the locale-candidate expansion (US first, UK second).
  const selectOpt = (name, value) =>
    selectDropdown(name, Array.isArray(value) ? value : optionCandidates(value));

  // ---------- main fill routine ----------
  async function fillForm(draft, onStatus) {
    const log = [];
    const step = async (p) => {
      const r = await p;
      log.push(r);
      if (onStatus) onStatus(`${r.ok ? '✓' : '•'} ${r.name}: ${r.msg}`);
      return r;
    };

    // 1) Vehicle type first — it gates every downstream field (they don't exist in the
    // DOM until it's chosen). US composer says "Car/Truck", UK says "Car/van".
    await step(selectOpt('Vehicle type', draft.vehicleType || 'Car/Truck'));
    await waitForLabel('Year'); // dependent fields render after Vehicle type is chosen

    // 2) the rest
    await step(selectOpt('Year', draft.year));
    await step(selectOpt('Make', draft.make));
    await step(fillTextField('Model', draft.model));
    // Facebook rejects mileage < 300; leave it blank for the user rather than blocking the form.
    await step((typeof draft.mileage === 'number' && draft.mileage < 300)
      ? Promise.resolve({ name: 'Mileage', ok: false, msg: `left blank — FB requires ≥300 mi (dealer shows ${draft.mileage})` })
      : fillTextField('Mileage', draft.mileage));
    // Currency guard: a non-US marketplace region silently re-denominates the amount.
    await step(fillTextField('Price', draft.price, { currencySymbol: '$' }));
    await step(selectOpt('Body style', mapBody(draft.bodyType)));
    // Marketing name first; DealerOn's coarse generic bucket ("Gray") as fallback when
    // the name doesn't map ("Other" maps to blank, so the fallback can't mis-color).
    // Label spelling differs per composer: "color" (US) / "colour" (UK).
    await step(selectOpt(['Exterior color', 'Exterior colour'], mapColor(draft.exteriorColor) || mapColor(draft.exteriorColorGeneric)));
    await step(selectOpt(['Interior color', 'Interior colour'], mapColor(draft.interiorColor)));
    await step(selectOpt('Vehicle condition', draft.condition || 'Excellent'));
    await step(selectOpt('Fuel type', mapFuel(draft.fuelType)));
    await step(selectOpt('Transmission', mapTransmission(draft.transmission)));
    await step(fillTextField('Description', draft.description));

    // 3) Location (autocomplete: type then pick first suggestion).
    // A leftover portal from a failed dropdown must never feed this picker (live case:
    // Location "picked" the vehicle-type option Car/Truck). Start from a clean slate so
    // any options that appear belong to the location autocomplete.
    await closeAnyDropdown();
    if (draft.location) await step(fillAutocomplete('Location', draft.location));

    // 4) Photos (fetched by the background worker to bypass FB CSP/CORS)
    await step(uploadPhotos(draft, onStatus));

    await settleUi();
    return log;
  }

  async function uploadPhotos(draft, onStatus) {
    const hasUrls = Array.isArray(draft.photoUrls) && draft.photoUrls.length;
    if (!hasUrls && !draft.photoBaseUrl) return { name: 'Photos', ok: false, msg: 'none in draft' };
    if (onStatus) onStatus('• Photos: fetching images…');
    const resp = await chrome.runtime.sendMessage(hasUrls
      ? { type: 'EZLIST_FETCH_IMAGES', urls: draft.photoUrls.slice(0, 20) }
      : { type: 'EZLIST_FETCH_IMAGES', baseUrl: draft.photoBaseUrl, ext: draft.photoExt, max: 20 });
    if (!resp || !resp.ok || !resp.images || !resp.images.length) {
      return { name: 'Photos', ok: false, msg: (resp && resp.error) || 'fetch failed' };
    }
    const input = document.querySelector('input[type="file"][accept*="image"]');
    if (!input) return { name: 'Photos', ok: false, msg: 'no file input' };
    const before = currentPhotoCount() || 0;
    const remaining = 20 - before; // FB caps vehicle listings at 20 photos
    if (remaining <= 0) return { name: 'Photos', ok: true, msg: `already has ${before}` };
    const added = attachPhotos(input, resp.images, remaining);
    if (!added) return { name: 'Photos', ok: false, msg: 'no files built' };
    const target = before + added;
    const got = await waitForCount(currentPhotoCount, target, 25000);
    if (got == null) return { name: 'Photos', ok: true, msg: `attached ${added} (count unverified)` };
    const ok = got >= target;
    return { name: 'Photos', ok, msg: `${got} uploaded${ok ? '' : ` of ${target} (some may still be processing)`}` };
  }

  function currentPhotoCount() {
    const el = [...document.querySelectorAll('*')]
      .find((n) => n.children.length === 0 && /^\d+\s*\/\s*20$/.test((n.textContent || '').trim()));
    return el ? parseInt(el.textContent, 10) : null;
  }

  // ---------- controller (no injected UI — the Carxpert side panel drives this) ----------
  let filling = false;
  let lastFilledKey = '';   // VIN/stock/url of the draft we filled — attributed to it on a real publish
  const isCreatePage = () => /\/marketplace\/create\/vehicle/i.test(location.pathname);
  const draftKey = (d) => d ? ((d.vin || '').toUpperCase() || d.stock || d.sourceUrl || '') : '';

  const postStatus = (text, error) =>
    chrome.runtime.sendMessage({ type: 'EZLIST_FILL_STATUS', text, error: !!error }).catch(() => {});

  async function getStored() {
    return chrome.runtime.sendMessage({ type: 'EZLIST_GET_DRAFT' });
  }

  async function doFill(expectedKey) {
    if (filling || !isCreatePage()) return;
    filling = true; // claim synchronously so a near-simultaneous EZLIST_FILL + auto-fill can't double-run
    try {
      // Entitlement guard (belt-and-braces; the panel/dealer path gates first). No host —
      // just "is the user entitled to fill"; lease-first with /api/me fallback in the worker.
      const gate = await chrome.runtime.sendMessage({ type: 'EZLIST_CAN_LIST' }).catch(() => null);
      if (!gate || !gate.ok) {
        postStatus(gate && gate.reason === 'wrong_dealership'
          ? "This car isn't from your linked dealership — CarXprt only lists your own inventory."
          : 'Sign in to CarXprt to fill listings.', true);
        return;
      }
      const resp = await getStored();
      const draft = resp && resp.ezlistDraft;
      if (!draft) { postStatus('No vehicle draft found.', true); return; }
      // Guard the single global draft: if the stored car has changed since this fill
      // was requested (rapid double-List), refuse rather than fill the wrong vehicle.
      if (expectedKey && draftKey(draft) !== expectedKey) {
        postStatus('Vehicle changed — reopen the car and Fill again.', true);
        return;
      }
      lastFilledKey = draftKey(draft);
      postStatus('Filling…');
      await waitForLabel('Vehicle type', 20000);
      const log = await fillForm(draft, (line) => postStatus(line));
      const missed = log.filter((r) => !r.ok).map((r) => r.name);
      // Per-field fill report → sync queue (feeds the backend fill-accuracy metric). C5.
      // variant/lang identify which composer locale this machine got — the first question
      // of every "fields don't fill on HIS machine" report, answered from telemetry.
      const vt = log.find((r) => r.name === 'Vehicle type');
      const variant = vt && /Car\/Truck/i.test(vt.msg) ? 'us'
        : vt && /Car\/van/i.test(vt.msg) ? 'uk' : 'unknown';
      chrome.runtime.sendMessage({
        type: 'EZLIST_ENQUEUE_EVENT',
        event: {
          type: 'fill_completed',
          clientKey: lastFilledKey,
          data: {
            variant,
            lang: document.documentElement.lang || '',
            fields: log.map((r) => ({ name: r.name, ok: r.ok, msg: r.msg }))
          }
        }
      }).catch(() => {});
      postStatus(missed.length ? `Filled ✓ · add manually: ${missed.join(', ')}` : 'Listing filled ✓');
    } catch (e) {
      postStatus(`Error: ${e.message}`, true);
    } finally {
      filling = false;
    }
  }

  // Auto-fill once when the draft was just set by a "List" click (one-shot flag). The flag is
  // platform-tagged ({platform,key}); Facebook only fires on its own tag (or a legacy `true`),
  // so a Craigslist-targeted List never fills an open FB create tab.
  async function maybeAutoFill() {
    if (!isCreatePage()) return;
    const resp = await getStored();
    const af = resp && resp.ezlistAutoFill;
    const forFb = af === true || (af && af.platform === 'fb');
    if (resp && resp.ezlistDraft && forFb && !filling) {
      chrome.storage.local.set({ ezlistAutoFill: false }); // one-shot; manual reloads won't re-fire
      doFill();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'EZLIST_FILL') doFill(msg.key);
    else if (msg.type === 'EZLIST_DRAFT_UPDATED') maybeAutoFill();
  });

  // ---------- publish detection (Option A: green only on a real publish) ----------
  // Conservative: we only mark a VIN "listed" when, AFTER we filled it, the page leaves
  // /marketplace/create/vehicle for a created-listing or your-listings URL. An abandoned
  // form never produces that transition, so we never mark green on a form the user bailed on.
  // ezlistListedVins entries are per-platform: { fb?:{listedAt}, craigslist?:{...} }. Legacy
  // entries were flat { listedAt } (all Facebook) — normalize them so old data reads as { fb }.
  const listedPlatforms = (entry) => {
    if (!entry || typeof entry !== 'object') return {};
    if ('listedAt' in entry) return { fb: { listedAt: entry.listedAt } };
    return entry;
  };

  async function markListed(key) {
    if (!key) return;
    const s = await chrome.storage.local.get(['ezlistListedVins', 'ezlistListings', 'ezlistDraft']);
    const listed = s.ezlistListedVins || {};
    const listings = s.ezlistListings || {};
    const now = new Date().toISOString();
    const entry = listedPlatforms(listed[key]);
    const alreadyGreen = !!entry.fb;
    const alreadyActive = listings[key] && listings[key].status === 'active';
    if (alreadyGreen && alreadyActive) return;

    // ezlistListedVins is the source of truth for the dealer-page green button — per platform.
    // Capture the published URL (we're on /marketplace/item/<id> or /you) for "View listing".
    if (!alreadyGreen) entry.fb = { listedAt: now, url: location.href };
    listed[key] = entry;

    // ezlistListings is the richer, stats-facing record. Capture the vehicle fields
    // from the draft we just filled (keys match unless the user switched cars mid-flow).
    const d = (s.ezlistDraft && draftKey(s.ezlistDraft) === key) ? s.ezlistDraft : null;
    const prev = listings[key] || {};
    listings[key] = {
      key,
      vin: (d && d.vin) || prev.vin || (key.length === 17 ? key : undefined),
      title: (d ? [d.year, d.make, d.model].filter(Boolean).join(' ') : prev.title) || undefined,
      year: (d && d.year) || prev.year,
      make: (d && d.make) || prev.make,
      model: (d && d.model) || prev.model,
      price: (d && Number(d.price)) || prev.price,
      sourceUrl: (d && d.sourceUrl) || prev.sourceUrl,
      platform: 'fb',
      status: 'active',
      listedAt: prev.listedAt || now,
    };
    await chrome.storage.local.set({ ezlistListedVins: listed, ezlistListings: listings });
    // Publish event → sync queue; the ezlistListings write above also triggers the listing sync. C5.
    chrome.runtime.sendMessage({ type: 'EZLIST_ENQUEUE_EVENT', event: { type: 'publish_detected', clientKey: key } }).catch(() => {});
    postStatus('✓ Listed on Marketplace.');
  }

  function installPublishDetection() {
    let lastPath = location.pathname;
    // Post-publish FB lands on the new item, "your listings", or (observed live 2026-07) plain
    // marketplace home. Home is ambiguous — the form's close (X) button produces the same
    // create→home transition — so judgePublishNav accepts it only when a Publish button was
    // clicked moments before. We OBSERVE the user's click (capture phase, works for keyboard
    // activation too); we never click Publish ourselves. A Publish click that does NOT navigate
    // (client-side validation failure) ages out of the window, so a later X-close stays safe.
    let publishClickAt = null;
    document.addEventListener('click', (e) => {
      if (!isCreatePage()) return;
      const btn = e.target && e.target.closest ? e.target.closest('[role="button"], button') : null;
      if (!btn) return;
      const text = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.textContent || '')).trim().toLowerCase();
      if (/^publish$|(^|\s)publish($|\s)/.test(text)) publishClickAt = Date.now();
    }, true);
    const check = () => {
      const path = location.pathname;
      if (path === lastPath) return;
      const left = lastPath;
      lastPath = path;
      if (!lastFilledKey) return;
      const published = judgePublishNav({
        fromCreate: /\/marketplace\/create\/vehicle/.test(left),
        path,
        publishClickMsAgo: publishClickAt == null ? null : Date.now() - publishClickAt
      });
      if (published) {
        markListed(lastFilledKey);
        lastFilledKey = '';
        publishClickAt = null;
      }
    };
    // FB is a SPA; the content script can't hook the page's pushState across worlds,
    // so poll the path (cheap) and also catch back/forward.
    window.addEventListener('popstate', check);
    setInterval(check, 1000);
  }

  maybeAutoFill();
  installPublishDetection();
})();
