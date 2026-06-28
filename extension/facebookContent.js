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
      await sleep(200);
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
  // FB UK body options: Coupé, Van, Saloon, Hatchback, 4x4, Convertible, Estate, MPV/People carrier, Small car, Other
  const FB_BODY = {
    suv: '4x4', 'sport utility': '4x4', crossover: '4x4', '4x4': '4x4', pickup: '4x4', truck: '4x4',
    sedan: 'Saloon', saloon: 'Saloon', coupe: 'Coupé', 'coupé': 'Coupé', convertible: 'Convertible',
    hatchback: 'Hatchback', wagon: 'Estate', estate: 'Estate', minivan: 'MPV/People carrier',
    van: 'Van', mpv: 'MPV/People carrier'
  };
  // FB fuel options: Diesel, Electric, Petrol, Flex, Hybrid, Plug-in hybrid, Other
  const FB_FUEL = {
    gasoline: 'Petrol', gas: 'Petrol', petrol: 'Petrol', diesel: 'Diesel', electric: 'Electric',
    ev: 'Electric', 'plug-in hybrid': 'Plug-in hybrid', phev: 'Plug-in hybrid', hybrid: 'Hybrid',
    flex: 'Flex', e85: 'Flex'
  };
  const FB_COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Off white', 'Tan', 'Beige', 'Burgundy', 'Turquoise'];
  // marketing color -> FB palette keyword fallbacks (covers Toyota names like Celestite, Magnetic Gray, Wind Chill Pearl)
  const COLOR_KEYWORDS = [
    [/charcoal/i, 'Charcoal'], [/silver|alumin/i, 'Silver'], [/grey|gray|magnetic|graphite|gunmetal|cement|lunar rock|ash|slate/i, 'Grey'],
    [/black|midnight|ebony|onyx|attitude/i, 'Black'], [/white|pearl|snow|frost|ice cap|blizzard|super white|alpine/i, 'White'],
    [/celestite|blue|navy|sky|cavalry|blueprint|sapphire/i, 'Blue'], [/red|barcelona|ruby|scarlet|crimson|supersonic/i, 'Red'],
    [/green|army|cypress/i, 'Green'], [/brown|mocha|espresso|coffee|smoked/i, 'Brown'],
    [/burgundy|maroon|wine|merlot/i, 'Burgundy'], [/gold|champagne/i, 'Gold'], [/beige|sand|almond|dune/i, 'Beige'],
    [/tan|camel|saddle/i, 'Tan'], [/orange|inferno/i, 'Orange'], [/yellow/i, 'Yellow'], [/purple|plum/i, 'Purple'],
    [/turquoise|teal/i, 'Turquoise'], [/off.?white|cream|ivory/i, 'Off white']
  ];
  const mapColor = (raw) => {
    if (!raw) return '';
    const first = String(raw).split(/[\/,&]| and /i)[0].trim(); // "Black/Blue" -> "Black"
    const exact = FB_COLORS.find((c) => norm(c) === norm(first));
    if (exact) return exact;
    for (const [re, fb] of COLOR_KEYWORDS) if (re.test(first)) return fb;
    return ''; // unknown -> leave blank for manual review
  };
  const mapBody = (raw) => (raw ? (FB_BODY[norm(raw)] || FB_BODY[norm(String(raw).replace(/\d+\s*dr\s*/i, '').trim())] || '') : '');
  const mapFuel = (raw) => {
    if (!raw) return '';
    const k = norm(raw).replace(/\s*fuel$/i, '');
    if (FB_FUEL[k]) return FB_FUEL[k];
    for (const key of Object.keys(FB_FUEL)) if (k.includes(key)) return FB_FUEL[key];
    return '';
  };
  const mapTransmission = (raw) => (/manual/i.test(raw || '') ? 'Manual transmission' : 'Automatic transmission');

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
    await step(selectDropdown('Exterior colour', mapColor(draft.exteriorColor)));
    await step(selectDropdown('Interior colour', mapColor(draft.interiorColor)));
    await step(selectDropdown('Vehicle condition', draft.condition || 'Excellent'));
    await step(selectDropdown('Fuel type', mapFuel(draft.fuelType)));
    await step(selectDropdown('Transmission', mapTransmission(draft.transmission)));
    await step(fillTextField('Description', draft.description));

    // 3) Location (autocomplete: type then pick first suggestion)
    if (draft.location) await step(setLocation(draft.location));

    // 4) Photos (fetched by the background worker to bypass FB CSP/CORS)
    await step(uploadPhotos(draft, onStatus));

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
      : { type: 'EZLIST_FETCH_IMAGES', baseUrl: draft.photoBaseUrl, max: 20 });
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

  // ---------- panel UI ----------
  const host = document.createElement('div');
  host.id = 'ezlist-facebook-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      .panel { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: min(380px, calc(100vw - 36px));
        box-sizing: border-box; border: 1px solid #d8dee4; border-radius: 10px; background: #fff;
        box-shadow: 0 18px 50px rgba(0,0,0,.22); color: #1f2328; font: 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
      .head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #eaeef2; }
      .brand { font-weight:800; font-size:16px; }
      .muted { color:#57606a; }
      .body { padding:14px; }
      .status { border-radius:6px; background:#f6f8fa; padding:10px; margin-bottom:10px; }
      .summary { font-weight:650; margin-bottom:10px; }
      .actions { display:flex; gap:8px; }
      button { border-radius:6px; border:1px solid transparent; cursor:pointer; font:700 13px/1 system-ui, sans-serif; padding:10px 12px; }
      .primary { background:#1877f2; color:#fff; }
      .primary:disabled { opacity:.55; cursor:not-allowed; }
      .secondary { background:#f6f8fa; border-color:#d8dee4; color:#24292f; }
      .close { border:0; background:transparent; font:700 18px/1 system-ui; cursor:pointer; color:#57606a; }
      ul { margin:10px 0 0; padding-left:18px; max-height:180px; overflow:auto; }
      li { margin:2px 0; }
    </style>
    <section class="panel">
      <div class="head"><div><div class="brand">ezlist</div><div class="muted">Vehicle draft filler</div></div>
        <button class="close" aria-label="Close">×</button></div>
      <div class="body">
        <div class="summary"></div>
        <div class="status">Checking for a saved draft…</div>
        <div class="actions">
          <button class="primary fill" disabled>Fill listing</button>
          <button class="secondary open">Open vehicle form</button>
        </div>
        <ul class="report" hidden></ul>
      </div>
    </section>`;
  document.documentElement.appendChild(host);

  const $ = (s) => shadow.querySelector(s);
  const statusEl = $('.status');
  const summaryEl = $('.summary');
  const reportEl = $('.report');
  const fillBtn = $('.fill');
  $('.close').addEventListener('click', () => host.remove());
  $('.open').addEventListener('click', () => { location.href = 'https://www.facebook.com/marketplace/create/vehicle'; });

  let draft = null;
  let filling = false;
  const isCreatePage = () => /\/marketplace\/create/i.test(location.pathname);

  async function runFill() {
    if (!draft || filling) return;
    filling = true;
    fillBtn.disabled = true;
    reportEl.hidden = false; reportEl.innerHTML = '';
    statusEl.textContent = 'Filling…';
    const onStatus = (line) => {
      statusEl.textContent = line;
      const li = document.createElement('li'); li.textContent = line; reportEl.appendChild(li);
    };
    try {
      await fillForm(draft, onStatus);
      statusEl.textContent = 'Done. Review every field + photos, then press Publish.';
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    } finally {
      filling = false;
      fillBtn.disabled = false;
    }
  }

  async function refresh() {
    const resp = await chrome.runtime.sendMessage({ type: 'EZLIST_GET_DRAFT' });
    draft = resp && resp.ezlistDraft;
    if (!draft) { statusEl.textContent = 'No draft found. Click "⚡ List" on a car at the dealership first.'; return; }
    summaryEl.textContent = `${[draft.year, draft.make, draft.model].filter(Boolean).join(' ')}${draft.price ? ` — $${Number(draft.price).toLocaleString('en-US')}` : ''}`;
    fillBtn.disabled = !isCreatePage();
    if (isCreatePage() && resp.ezlistAutoFill && !filling) {
      // Triggered by clicking "List" at the dealership — fill automatically; user just reviews + Publishes.
      chrome.storage.local.set({ ezlistAutoFill: false }); // one-shot; manual reloads won't re-fire
      statusEl.textContent = 'Auto-filling…';
      await waitForLabel('Vehicle type', 20000);
      runFill();
    } else {
      statusEl.textContent = isCreatePage()
        ? 'Draft ready. Click "Fill listing", review every field, then press Publish yourself.'
        : 'Draft ready. Open the vehicle form to fill it.';
    }
  }

  fillBtn.addEventListener('click', runFill);
  // Pre-warmed tab: background pings us once the draft is set by a List click.
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'EZLIST_DRAFT_UPDATED') refresh(); });
  refresh();
})();
