'use strict';

// ezlist — Facebook Marketplace "Vehicle for sale" auto-filler.
// All field-interaction logic below was validated live against the real form via CDP:
//  - dropdowns are <label role="combobox"> that open a portal [role="listbox"] of [role="option"]
//  - text fields are bare <input>/<textarea> wrapped in a <label> (no id/aria)
//  - field name resolves from aria-labelledby (dropdowns) else textContent (text fields)
//  - photos upload via DataTransfer -> input.files -> dispatch('change')

(() => {
  const isFacebook = /(\.|^)facebook\.com$/i.test(location.hostname) || /(\.|^)web\.facebook\.com$/i.test(location.hostname);
  if (!isFacebook) return;
  if (document.getElementById('ezlist-facebook-host')) return;

  // ---------- low-level DOM helpers (validated) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').toString().trim().toLowerCase();

  // Poll a predicate; resolve with its first truthy value, or its last value on timeout.
  const waitUntil = async (fn, timeout = 2500, interval = 30) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 >= timeout) return v;
      await sleep(interval);
    }
  };

  const realClick = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };

  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const fieldName = (l) => {
    const lb = l.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((n) => (n.textContent || '').trim()).join(' ').trim();
      if (t) return t;
    }
    const al = (l.getAttribute('aria-label') || '').trim();
    if (al) return al;
    return (l.textContent || '').trim();
  };

  const getLabel = (name) => [...document.querySelectorAll('label')]
    .find((l) => fieldName(l).toLowerCase() === name.toLowerCase());

  const waitForLabel = async (name, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (getLabel(name)) return true;
      await sleep(60);
    }
    return false;
  };

  const readOptions = () => [...document.querySelectorAll('[role="option"]')]
    .map((o) => ({ el: o, txt: (o.getAttribute('aria-label') || o.textContent || '').trim() }))
    .filter((o) => o.txt);

  const matchOption = (opts, value) => {
    const v = norm(value);
    if (!v) return null;
    return opts.find((o) => norm(o.txt) === v)
      || opts.find((o) => norm(o.txt).startsWith(v))
      || opts.find((o) => v.startsWith(norm(o.txt)) && o.txt.length > 2)
      || opts.find((o) => norm(o.txt).includes(v) && v.length > 2);
  };

  const closeAnyDropdown = async () => {
    const h1 = document.querySelector('h1');
    for (let i = 0; i < 3 && document.querySelectorAll('[role="option"]').length; i += 1) {
      if (h1) realClick(h1);
      if (document.activeElement) {
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27 }));
      }
      await sleep(150);
    }
  };

  // After the fill, leave the form looking finished, not mid-edit: dismiss any
  // lingering suggestion portal (esp. the Location autocomplete) and drop the caret.
  const settleUi = async () => {
    await closeAnyDropdown();
    const a = document.activeElement;
    if (a && typeof a.blur === 'function') a.blur();
  };

  async function fillTextField(name, value) {
    if (value === undefined || value === null || value === '') return { name, ok: false, msg: 'no value' };
    const label = getLabel(name);
    if (!label) return { name, ok: false, msg: 'field not found' };
    const input = label.querySelector('input, textarea');
    if (!input) return { name, ok: false, msg: 'no input in field' };
    input.focus();
    setNativeValue(input, String(value));
    await sleep(50); // let FB's controlled-input reformat (e.g. price -> $54,970) settle
    const digits = (s) => String(s).replace(/\D/g, '');
    const ok = norm(input.value) === norm(value) || (!!digits(value) && digits(input.value) === digits(value));
    return { name, ok, msg: ok ? `"${input.value}"` : `got "${input.value}"` };
  }

  async function selectDropdown(name, value) {
    if (value === undefined || value === null || value === '') return { name, ok: false, msg: 'no value' };
    const label = getLabel(name);
    if (!label) return { name, ok: false, msg: 'field not found' };
    realClick(label);
    // wait for the option portal to render, then match
    await waitUntil(() => readOptions().length > 0, 3000);
    let hit = matchOption(readOptions(), value);
    if (!hit) {
      // searchable dropdown (e.g. Make): type to filter, then wait for a match to appear
      const focused = document.activeElement;
      if (focused && focused.tagName === 'INPUT') {
        setNativeValue(focused, String(value));
        hit = await waitUntil(() => matchOption(readOptions(), value), 2500);
      }
    }
    if (!hit) {
      await closeAnyDropdown();
      return { name, ok: false, msg: `no option matched "${value}"` };
    }
    realClick(hit.el);
    // wait for the listbox to close (selection committed) before the next field opens its own
    await waitUntil(() => readOptions().length === 0, 1500);
    return { name, ok: true, msg: `picked "${hit.txt}"` };
  }

  // ---------- dealer term -> Facebook option mapping ----------
  // Shared with dealerContent via lib/mappers.js (loaded first per manifest); unit-tested
  // in lib/mappers.test.js. Includes sanitization: HTML stripped from feed values,
  // upholstery material words dropped before matching, unknown names -> blank for review.
  const { mapColor, mapBody, mapFuel, mapTransmission } = globalThis.CarxpertShared;

  // ---------- main fill routine ----------
  async function fillForm(draft, onStatus) {
    const log = [];
    const step = async (p) => {
      const r = await p;
      log.push(r);
      if (onStatus) onStatus(`${r.ok ? '✓' : '•'} ${r.name}: ${r.msg}`);
      return r;
    };

    // 1) Vehicle type first — it gates every downstream field.
    await step(selectDropdown('Vehicle type', draft.vehicleType || 'Car/van'));
    await waitForLabel('Year'); // dependent fields render after Vehicle type is chosen

    // 2) the rest
    await step(selectDropdown('Year', draft.year));
    await step(selectDropdown('Make', draft.make));
    await step(fillTextField('Model', draft.model));
    // Facebook rejects mileage < 300; leave it blank for the user rather than blocking the form.
    await step((typeof draft.mileage === 'number' && draft.mileage < 300)
      ? Promise.resolve({ name: 'Mileage', ok: false, msg: `left blank — FB requires ≥300 mi (dealer shows ${draft.mileage})` })
      : fillTextField('Mileage', draft.mileage));
    await step(fillTextField('Price', draft.price));
    await step(selectDropdown('Body style', mapBody(draft.bodyType)));
    // Marketing name first; DealerOn's coarse generic bucket ("Gray") as fallback when
    // the name doesn't map ("Other" maps to blank, so the fallback can't mis-color).
    await step(selectDropdown('Exterior colour', mapColor(draft.exteriorColor) || mapColor(draft.exteriorColorGeneric)));
    await step(selectDropdown('Interior colour', mapColor(draft.interiorColor)));
    await step(selectDropdown('Vehicle condition', draft.condition || 'Excellent'));
    await step(selectDropdown('Fuel type', mapFuel(draft.fuelType)));
    await step(selectDropdown('Transmission', mapTransmission(draft.transmission)));
    await step(fillTextField('Description', draft.description));

    // 3) Location (autocomplete: type then pick first suggestion)
    if (draft.location) await step(setLocation(draft.location));

    // 4) Photos (fetched by the background worker to bypass FB CSP/CORS)
    await step(uploadPhotos(draft, onStatus));

    await settleUi();
    return log;
  }

  async function setLocation(value) {
    const label = getLabel('Location');
    if (!label) return { name: 'Location', ok: false, msg: 'not found' };
    const input = label.querySelector('input');
    if (!input) return { name: 'Location', ok: false, msg: 'no input' };
    input.focus();
    setNativeValue(input, '');
    setNativeValue(input, String(value));
    const opt = await waitUntil(() => readOptions()[0], 2500);
    if (opt) {
      realClick(opt.el);
      await waitUntil(() => readOptions().length === 0, 1200);
      return { name: 'Location', ok: true, msg: `picked "${opt.txt}"` };
    }
    return { name: 'Location', ok: false, msg: 'no suggestion (left default)' };
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
    const dt = new DataTransfer();
    for (const img of resp.images.slice(0, remaining)) {
      const file = dataUrlToFile(img.dataUrl, img.name);
      if (file) dt.items.add(file);
    }
    if (!dt.files.length) return { name: 'Photos', ok: false, msg: 'no files built' };
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const target = before + dt.files.length;
    const got = await waitForPhotoCount(target, 25000);
    if (got == null) return { name: 'Photos', ok: true, msg: `attached ${dt.files.length} (count unverified)` };
    const ok = got >= target;
    return { name: 'Photos', ok, msg: `${got} uploaded${ok ? '' : ` of ${target} (some may still be processing)`}` };
  }

  function currentPhotoCount() {
    const el = [...document.querySelectorAll('*')]
      .find((n) => n.children.length === 0 && /^\d+\s*\/\s*20$/.test((n.textContent || '').trim()));
    return el ? parseInt(el.textContent, 10) : null;
  }

  async function waitForPhotoCount(target, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const c = currentPhotoCount();
      if (c != null && c >= target) return c;
      await sleep(500);
    }
    return currentPhotoCount();
  }

  function dataUrlToFile(dataUrl, name) {
    try {
      const [meta, b64] = dataUrl.split(',');
      const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      return new File([arr], name || 'photo.jpg', { type: mime });
    } catch { return null; }
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
      if (!gate || !gate.ok) { postStatus('Sign in to Carxpert to fill listings.', true); return; }
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
      chrome.runtime.sendMessage({
        type: 'EZLIST_ENQUEUE_EVENT',
        event: { type: 'fill_completed', clientKey: lastFilledKey, data: { fields: log.map((r) => ({ name: r.name, ok: r.ok, msg: r.msg })) } }
      }).catch(() => {});
      postStatus(missed.length ? `Filled ✓ · add manually: ${missed.join(', ')}` : 'Listing filled ✓');
    } catch (e) {
      postStatus(`Error: ${e.message}`, true);
    } finally {
      filling = false;
    }
  }

  // Auto-fill once when the draft was just set by a "List" click (one-shot flag).
  async function maybeAutoFill() {
    if (!isCreatePage()) return;
    const resp = await getStored();
    if (resp && resp.ezlistDraft && resp.ezlistAutoFill && !filling) {
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
  async function markListed(key) {
    if (!key) return;
    const s = await chrome.storage.local.get(['ezlistListedVins', 'ezlistListings', 'ezlistDraft']);
    const listed = s.ezlistListedVins || {};
    const listings = s.ezlistListings || {};
    const now = new Date().toISOString();
    const alreadyGreen = !!listed[key];
    const alreadyActive = listings[key] && listings[key].status === 'active';
    if (alreadyGreen && alreadyActive) return;

    // ezlistListedVins stays the source of truth for the dealer-page green button.
    if (!alreadyGreen) listed[key] = { listedAt: now };

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
    const check = () => {
      const path = location.pathname;
      if (path === lastPath) return;
      const left = lastPath;
      lastPath = path;
      if (!lastFilledKey) return;
      const published = /\/marketplace\/item\/\d+/.test(path) || /\/marketplace\/you(\/|$)/.test(path);
      if (published && /\/marketplace\/create\/vehicle/.test(left)) {
        markListed(lastFilledKey);
        lastFilledKey = '';
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
