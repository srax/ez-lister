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
  if (globalThis.__carxpertFacebookContentLoaded) return;
  globalThis.__carxpertFacebookContentLoaded = true;

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
  let lastFilledContext = null;
  const isCreatePage = () => /\/marketplace\/create\/vehicle/i.test(location.pathname);
  const draftKey = (d) => d ? ((d.vin || '').toUpperCase() || d.stock || d.sourceUrl || '') : '';
  const vinKey = (value) => {
    const candidate = String(value || '').trim().toUpperCase();
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(candidate) ? candidate : '';
  };

  const postStatus = (text, error) =>
    chrome.runtime.sendMessage({ type: 'EZLIST_FILL_STATUS', text, error: !!error }).catch(() => {});

  async function getStored() {
    return chrome.runtime.sendMessage({ type: 'EZLIST_GET_DRAFT' });
  }

  async function doFill(expectedKey, expectedContextKey) {
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
      const draftContextKey = draft._carxpertContext && draft._carxpertContext.key;
      if (expectedContextKey && draftContextKey && draftContextKey !== expectedContextKey) {
        postStatus('Workspace changed — reopen the car and Fill again.', true);
        return;
      }
      lastFilledKey = draftKey(draft);
      lastFilledContext = draft._carxpertContext || (resp && resp.ezlistActiveContext) || null;
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
          context: lastFilledContext,
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
      doFill(af && af.key, af && af.contextKey);
    }
  }

  // Facebook can preserve a draft's visible fields across a page refresh, while this content
  // script's in-memory vehicle key starts over. Recover attribution from the worker's previous
  // stored copy or the same validated VIN. That lets a translation/rewrite replace this one field
  // after a refresh or failed delivery without risking another vehicle.
  async function recoverFilledVehicle(expectedKey, previousDescription) {
    if (lastFilledKey || !expectedKey || !previousDescription || !isCreatePage()) return false;
    await waitForLabel('Description', 3000);
    const label = getLabel('Description');
    const input = label && label.querySelector('input, textarea');
    const comparable = (text) => String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
    if (!input) return false;
    const visibleDescription = comparable(input.value);
    const expectedVin = vinKey(expectedKey);
    const samePriorCopy = visibleDescription === comparable(previousDescription);
    const sameVin = expectedVin && visibleDescription.toUpperCase().includes(expectedVin);
    // A failed AI/translation delivery updates the stored draft before the page, so after an
    // extension reload the two descriptions can legitimately differ. The VIN in the still-open
    // Facebook copy is a stronger vehicle identity check than text equality and lets us recover
    // without ever accepting another vehicle's composer.
    if (!samePriorCopy && !sameVin) return false;
    const resp = await getStored().catch(() => null);
    const draft = resp && resp.ezlistDraft;
    if (!draft || draftKey(draft) !== expectedKey) return false;
    lastFilledKey = expectedKey;
    lastFilledContext = draft._carxpertContext || (resp && resp.ezlistActiveContext) || null;
    return true;
  }

  async function updateDescription(expectedKey, value, previousDescription) {
    if (!isCreatePage()) return { ok: true, updated: false, reason: 'not_vehicle_form' };
    // Let an in-progress full fill finish first. Otherwise its older Description step could land
    // after this edit and overwrite the dealer's newest copy.
    for (let i = 0; filling && i < 300; i += 1) await sleep(100);
    if (!lastFilledKey) await recoverFilledVehicle(expectedKey, previousDescription);
    if (!expectedKey || !lastFilledKey || expectedKey !== lastFilledKey) {
      return { ok: true, updated: false, reason: 'different_vehicle' };
    }
    const result = await fillTextField('Description', String(value == null ? '' : value).slice(0, 1000));
    return { ok: true, updated: !!result.ok, result };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'EZLIST_FILL') doFill(msg.key, msg.contextKey);
    else if (msg.type === 'EZLIST_DRAFT_UPDATED') maybeAutoFill();
    else if (msg.type === 'EZLIST_UPDATE_DESCRIPTION') {
      updateDescription(msg.key, msg.description, msg.previousDescription)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, updated: false, error: error.message }));
      return true;
    }
    return false;
  });

  // ---------- publish detection (Option A: green only on a real publish) ----------
  // Conservative: we only mark a VIN "listed" when, AFTER we filled it, the page leaves
  // /marketplace/create/vehicle for a created-listing or your-listings URL. An abandoned
  // form never produces that transition, so we never mark green on a form the user bailed on.
  async function markListed(key, context) {
    if (!key || !context) return;
    const result = await chrome.runtime.sendMessage({
      type: 'EZLIST_MARK_LISTED',
      payload: { key, context, platform: 'fb', url: location.href }
    }).catch(() => null);
    if (result && result.ok) postStatus('✓ Listed on Marketplace.');
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
        markListed(lastFilledKey, lastFilledContext);
        lastFilledKey = '';
        lastFilledContext = null;
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
