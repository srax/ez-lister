'use strict';

// Carxpert — Craigslist vehicle post auto-filler (adapter #2).
//
// Craigslist is classic server-rendered HTML with jQuery UI selectmenu widgets. Selectors
// Craigslist is classic server-rendered HTML with jQuery UI selectmenu widgets. Selectors
// below were validated against a live "cars & trucks - by dealer" post form. Key facts that
// shape this adapter:
//   • Text/number fields are plain <input>/<textarea> keyed by name.
//   • Dropdowns are a hidden native <select name="…"> PLUS a jQuery UI button span
//     (#<select.id>-button > .ui-selectmenu-text). The native <select> is the form's source
//     of truth at submit, so we set that; we also update the visible button text so the user
//     sees the value when reviewing.
//   • Model year is a <select> (not a text input); condition's select is name="condition"
//     (NOT auto_condition).
//   • Craigslist AUTOFILLS fields from the user's previous post (junk for this car), so we
//     OVERWRITE rather than fill-only. The user reviews before clicking Publish (we never do).
//   • Required "postal" (ZIP) isn't in the neutral draft, so it's flagged for manual entry.
//
// Multi-page flow: the vehicle attribute form and the image uploader are separate pages.
// This script adapts per page — fills the attribute form, then on the "add images" page
// (plupload with a real <input type=file multiple>) attaches the car's photos. A panel/dealer
// "List" arms a platform-tagged autoFill flag that fills the form on arrival; a successful fill
// arms ezlistClPendingPhotos so the images page uploads automatically. Both steps also expose
// an explicit "⚡ …with Carxpert" button, and EZLIST_FILL still triggers a fill directly.

(() => {
  if (!/(^|\.)craigslist\.org$/i.test(location.hostname)) return;
  if (document.getElementById('carxpert-cl-host')) return;

  const { setNativeValue, matchOption, waitForCount } = globalThis.CarxpertFill;
  const clmap = globalThis.CarxpertCl;

  const IMG_FILE_SEL = 'input[type="file"][accept*="image"]';
  const isImagesPage = () => !!(document.querySelector('section.editimage') || document.querySelector('.imgcount') || document.querySelector(IMG_FILE_SEL));

  // ---- validated field selectors (by name) ----
  const SEL = {
    title: '[name="PostingTitle"]',
    geographicArea: '[name="geographic_area"]',
    postal: '[name="postal"]',
    price: '[name="price"]',
    body: '[name="PostingBody"]',
    vin: '[name="auto_vin"]',
    makeModel: '[name="auto_make_model"]',
    miles: '[name="auto_miles"]',
    year: '[name="auto_year"]',            // <select>
    condition: '[name="condition"]',        // <select> — note: NOT auto_condition
    fuel: '[name="auto_fuel_type"]',        // <select>
    transmission: '[name="auto_transmission"]', // <select>
    paint: '[name="auto_paint"]',           // <select>
    titleStatus: '[name="auto_title_status"]',  // <select>
    bodytype: '[name="auto_bodytype"]',     // <select>
  };

  const q = (sel) => document.querySelector(sel);
  // The vehicle form is on screen once its make/model (or posting title) input exists.
  const isVehicleForm = () => !!(q(SEL.makeModel) || q(SEL.title));

  function fillText(sel, value, name) {
    const el = q(sel);
    if (!el) return { name, ok: false, msg: 'field not found' };
    if (value === undefined || value === null || String(value) === '') return { name, ok: false, msg: 'no value' };
    el.focus();
    setNativeValue(el, String(value));
    return { name, ok: true, msg: `"${el.value}"` };
  }

  // Fill a Craigslist dropdown: set the hidden native <select> (form submit source of truth)
  // by matching the option's visible text, then mirror it into the jQuery UI button so the
  // user sees the selection when reviewing.
  function fillSel(sel, value, name) {
    const select = q(sel);
    if (!select) return { name, ok: false, msg: 'field not found' };
    if (value === undefined || value === null || value === '') return { name, ok: false, msg: 'no value' };
    const opts = [...select.options]
      .map((o) => ({ el: o, txt: (o.textContent || '').trim() }))
      .filter((o) => o.txt && o.txt !== '-'); // skip the placeholder
    const hit = matchOption(opts, value);
    if (!hit) return { name, ok: false, msg: `no option matched "${value}"` };
    select.value = hit.el.value;
    hit.el.selected = true;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = select.id ? document.getElementById(`${select.id}-button`) : null;
    if (btn) { const t = btn.querySelector('.ui-selectmenu-text'); if (t) t.textContent = hit.txt; }
    return { name, ok: true, msg: `picked "${hit.txt}"` };
  }

  function fillFields(draft) {
    const log = [];
    const title = [draft.year, draft.make, draft.model, draft.trim].filter(Boolean).join(' ').trim();
    const makeModel = [draft.make, draft.model, draft.trim].filter(Boolean).join(' ').trim();
    log.push(fillText(SEL.title, title, 'Title'));
    log.push(fillText(SEL.makeModel, makeModel, 'Make/model'));
    log.push(fillSel(SEL.year, draft.year != null ? String(draft.year) : '', 'Year'));
    log.push(fillText(SEL.price, draft.price, 'Price'));
    log.push(fillText(SEL.miles, draft.mileage, 'Odometer'));
    log.push(fillText(SEL.vin, draft.vin, 'VIN'));
    log.push(fillSel(SEL.bodytype, clmap.mapBody(draft.bodyType), 'Type'));
    log.push(fillSel(SEL.condition, clmap.mapCondition(draft.condition), 'Condition'));
    log.push(fillSel(SEL.fuel, clmap.mapFuel(draft.fuelType), 'Fuel'));
    log.push(fillSel(SEL.transmission, clmap.mapTransmission(draft.transmission), 'Transmission'));
    log.push(fillSel(SEL.paint, clmap.mapColor(draft.exteriorColor) || clmap.mapColor(draft.exteriorColorGeneric), 'Paint'));
    log.push(fillSel(SEL.titleStatus, clmap.mapTitleStatus(draft.titleStatus), 'Title status'));
    log.push(fillText(SEL.geographicArea, draft.location, 'City/area'));
    log.push(fillText(SEL.body, draft.description, 'Description'));
    // ZIP is required by CL but isn't in the neutral draft (only a city string) — flag it.
    const postalEl = q(SEL.postal);
    if (postalEl && !String(postalEl.value || '').trim()) {
      log.push({ name: 'ZIP code', ok: false, msg: 'enter manually (required)' });
    }
    return log;
  }

  // ---- controller ----
  let filling = false;
  let photosBusy = false;
  let photosAttached = false; // one attach per images-page load — blocks accidental re-upload
  const draftKey = (d) => d ? ((d.vin || '').toUpperCase() || d.stock || d.sourceUrl || '') : '';
  const postStatus = (text, error) =>
    chrome.runtime.sendMessage({ type: 'EZLIST_FILL_STATUS', text, error: !!error }).catch(() => {});

  async function getDraft() {
    const resp = await chrome.runtime.sendMessage({ type: 'EZLIST_GET_DRAFT' }).catch(() => null);
    return resp && resp.ezlistDraft;
  }

  async function doFill() {
    if (filling || !isVehicleForm()) return;
    filling = true;
    try {
      const gate = await chrome.runtime.sendMessage({ type: 'EZLIST_CAN_LIST' }).catch(() => null);
      if (!gate || !gate.ok) { setBtn('Sign in to Carxpert to fill'); postStatus('Sign in to Carxpert to fill listings.', true); return; }
      const draft = await getDraft();
      if (!draft) { setBtn('No car — List one first'); postStatus('No vehicle draft found — List a car first.', true); return; }
      setBtn('Filling…');
      postStatus('Filling Craigslist…');
      const log = fillFields(draft);
      const missed = log.filter((r) => !r.ok).map((r) => r.name);
      log.forEach((r) => postStatus(`${r.ok ? '✓' : '•'} ${r.name}: ${r.msg}`));
      chrome.runtime.sendMessage({
        type: 'EZLIST_ENQUEUE_EVENT',
        event: { type: 'fill_completed', clientKey: draftKey(draft), data: { platform: 'craigslist', fields: log.map((r) => ({ name: r.name, ok: r.ok, msg: r.msg })) } }
      }).catch(() => {});
      // Hand off to the images step: mark that this CL session still wants its photos, so the
      // uploader page (a separate navigation) attaches them automatically when it loads.
      chrome.storage.local.set({ ezlistClPendingPhotos: draftKey(draft) }).catch(() => {});
      setBtn(missed.length ? `Filled ✓ · add: ${missed.join(', ')}` : 'Filled ✓ — continue to photos');
      postStatus(missed.length ? `Filled ✓ · add manually: ${missed.join(', ')}` : 'Craigslist filled ✓');
    } catch (e) {
      setBtn('Error — see console');
      postStatus(`Error: ${e.message}`, true);
    } finally {
      filling = false;
    }
  }

  // ---- photos (Craigslist's separate "add images" page: plupload with a real file input) ----
  const imgCount = () => {
    const el = document.querySelector('.imgcount');
    return el ? (parseInt(el.textContent, 10) || 0) : null;
  };

  // Hand the fetched photos to the MAIN-world bridge (craigslistUpload.js), which drives the
  // page's plupload uploader directly. Private CustomEvent channel (JSON-string detail) so we
  // don't collide with CL's own window 'message' handling. Resolves with { ok, count, error }.
  function driveUpload(images) {
    return new Promise((resolve) => {
      const onResult = (e) => {
        clearTimeout(timer);
        let d; try { d = JSON.parse(e.detail); } catch { d = { ok: false, error: 'bad result' }; }
        resolve({ ok: !!d.ok, count: d.count || 0, error: d.error || '' });
      };
      document.addEventListener('carxpert-cl-upload-result', onResult, { once: true });
      const timer = setTimeout(() => {
        document.removeEventListener('carxpert-cl-upload-result', onResult);
        resolve({ ok: false, count: 0, error: 'no response from page bridge' });
      }, 8000);
      document.dispatchEvent(new CustomEvent('carxpert-cl-upload', {
        detail: JSON.stringify({ images: images.map((i) => ({ name: i.name, dataUrl: i.dataUrl })) }),
      }));
    });
  }

  async function addPhotos() {
    if (photosBusy || photosAttached || !isImagesPage()) return;
    photosBusy = true;
    try {
      // Never duplicate: if the listing already has any images (a prior attach this session, or
      // photos the user added), stop here rather than re-uploading the same set.
      const before = imgCount() || 0;
      if (before > 0) { photosAttached = true; setBtn(`✓ ${before} photo${before === 1 ? '' : 's'} already added`); return; }
      const draft = await getDraft();
      const hasUrls = draft && Array.isArray(draft.photoUrls) && draft.photoUrls.length;
      if (!draft || (!hasUrls && !draft.photoBaseUrl)) { setBtn('No photos in draft'); return; }
      setBtn('Fetching photos…');
      const resp = await chrome.runtime.sendMessage(hasUrls
        ? { type: 'EZLIST_FETCH_IMAGES', urls: draft.photoUrls.slice(0, 24) }
        : { type: 'EZLIST_FETCH_IMAGES', baseUrl: draft.photoBaseUrl, ext: draft.photoExt, max: 24 }).catch(() => null);
      if (!resp || !resp.ok || !resp.images || !resp.images.length) { setBtn('Photo fetch failed'); return; }
      const imgs = resp.images.slice(0, 24); // CL caps at 24 images
      setBtn(`Uploading ${imgs.length} photo${imgs.length === 1 ? '' : 's'}…`);
      postStatus(`Uploading ${imgs.length} photos to Craigslist…`);
      const result = await driveUpload(imgs);
      if (!result.ok) {
        setBtn(`⚠ Upload failed`);
        postStatus(`Photo upload failed: ${result.error}`, true);
        return;
      }
      photosAttached = true; // handed off; don't re-queue on a second click
      const got = await waitForCount(imgCount, result.count, 45000);
      const ok = got != null && got >= result.count;
      setBtn(ok ? `✓ ${got} photos added` : `Uploading ${result.count}…`);
      postStatus(ok ? `✓ ${got} photos on Craigslist` : `Uploading ${result.count} photos (still processing)`);
    } catch (e) {
      setBtn('Photo error — see console');
      postStatus(`Photo error: ${e.message}`, true);
    } finally {
      photosBusy = false;
    }
  }

  // ---- injected trigger button (interim; adapts to the current post step) ----
  let btnEl = null;
  const setBtn = (label) => { if (btnEl) btnEl.textContent = label; };

  function ensureButton(label, onClick) {
    if (btnEl) return;
    const host = document.createElement('div');
    host.id = 'carxpert-cl-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:system-ui,sans-serif;';
    btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.textContent = label;
    btnEl.style.cssText = 'padding:10px 14px;border:0;border-radius:8px;background:#5c2d91;color:#fff;'
      + 'font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    btnEl.addEventListener('click', onClick);
    host.appendChild(btnEl);
    document.body.appendChild(host);
  }

  async function maybeShowButton() {
    if (btnEl) return;
    if (isVehicleForm()) {
      const draft = await getDraft();
      if (draft) {
        const car = [draft.year, draft.make, draft.model].filter(Boolean).join(' ') || 'this listing';
        ensureButton(`⚡ Fill ${car} with Carxpert`, doFill);
      }
    } else if (isImagesPage()) {
      const draft = await getDraft();
      if (draft && (draft.photoBaseUrl || (draft.photoUrls && draft.photoUrls.length))) {
        ensureButton('⚡ Add photos with Carxpert', addPhotos);
      }
    }
  }

  // Auto-fill the vehicle form as soon as it appears with a staged car. We deliberately DON'T
  // gate on the one-shot ezlistAutoFill flag here: Craigslist's post flow is several full-page
  // navigations, and that flag can be consumed/lost along the way, which left the form needing a
  // manual button press. Filling whenever a draft exists is robust and matches intent (the user
  // reached the car-post form on purpose). doFill overwrites (CL pre-fills junk) and the user
  // reviews before publishing. A successful fill arms `ezlistClPendingPhotos` for the images page.
  let autoTried = false;
  async function maybeAuto() {
    if (autoTried) return;
    if (isVehicleForm()) {
      if (filling) return;
      autoTried = true;
      const draft = await getDraft();
      if (draft) {
        chrome.storage.local.set({ ezlistAutoFill: false }).catch(() => {}); // clear the one-shot if set
        doFill();
      }
    } else if (isImagesPage()) {
      if (photosBusy) return;
      // Plupload builds its file <input> asynchronously after the page HTML loads. Wait for it
      // before claiming the attempt / consuming the flag, else we'd bail on a missing input and
      // never retry — which is why auto-upload previously needed a manual button click.
      if (!document.querySelector(IMG_FILE_SEL)) return; // not ready yet — retry next poll tick
      autoTried = true;
      const s = await chrome.storage.local.get(['ezlistClPendingPhotos']);
      if (s.ezlistClPendingPhotos) {
        await chrome.storage.local.set({ ezlistClPendingPhotos: false }); // one-shot
        addPhotos();
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'EZLIST_FILL') doFill();
    else if (msg.type === 'EZLIST_DRAFT_UPDATED') { maybeShowButton(); maybeAuto(); }
  });

  // CL renders each step via full navigations; poll briefly so the right button appears (and any
  // pending auto-fill / auto-photo fires) once the step's fields exist, then stop.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    maybeShowButton();
    maybeAuto();
    if ((btnEl && autoTried) || tries > 60) clearInterval(timer); // ~30s
  }, 500);
  maybeShowButton();
  maybeAuto();
})();
