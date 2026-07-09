'use strict';

// Shared DOM-driving primitives for the Carxpert platform fill engines.
//
// These are the generic, platform-AGNOSTIC halves of the old facebookContent.js:
// clicking React/SPA controls, setting values a controlled input will accept, resolving
// fields by their visible label, driving custom dropdowns/autocompletes, and attaching
// photos via DataTransfer. Every platform adapter (Facebook, Craigslist, OfferUp, …)
// injects this first (see manifest content_scripts order) and destructures what it needs
// off globalThis.CarxpertFill, so the fragile DOM plumbing lives in exactly one place.
//
// Platform-SPECIFIC bits stay in each *Content.js: which fields exist, their labels/order,
// the value taxonomy (lib/mappers.*), the photo-count read-out, and publish detection.
//
// Pure helpers (norm, matchOption) are also exported for node:test; everything that touches
// the DOM only reads document/window inside a function body, so requiring this in Node is safe.

(function attach(root) {
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

  // Field labels can differ per locale ("Exterior color" US vs "Exterior colour" UK), so
  // lookups take one name or an ordered candidate list (primary spelling first).
  const getLabel = (names) => {
    const list = Array.isArray(names) ? names : [names];
    const labels = [...document.querySelectorAll('label')];
    for (const n of list) {
      const hit = labels.find((l) => fieldName(l).toLowerCase() === n.toLowerCase());
      if (hit) return hit;
    }
    return undefined;
  };
  const displayName = (names) => (Array.isArray(names) ? names[0] : names);

  const waitForLabel = async (names, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (getLabel(names)) return true;
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

  // After a fill, leave the form looking finished, not mid-edit: dismiss any lingering
  // suggestion portal (esp. an autocomplete) and drop the caret.
  const settleUi = async () => {
    await closeAnyDropdown();
    const a = document.activeElement;
    if (a && typeof a.blur === 'function') a.blur();
  };

  async function fillTextField(name, value, opts = {}) {
    const disp = displayName(name);
    if (value === undefined || value === null || value === '') return { name: disp, ok: false, msg: 'no value' };
    const label = getLabel(name);
    if (!label) return { name: disp, ok: false, msg: 'field not found' };
    const input = label.querySelector('input, textarea');
    if (!input) return { name: disp, ok: false, msg: 'no input in field' };
    input.focus();
    setNativeValue(input, String(value));
    await sleep(50); // let a controlled input reformat (e.g. price -> $54,970) settle
    const digits = (s) => String(s).replace(/\D/g, '');
    const ok = norm(input.value) === norm(value) || (!!digits(value) && digits(input.value) === digits(value));
    // Currency guard: a non-matching symbol means the account's marketplace region reformats
    // the amount in local currency (live case: "$35,995" typed on a PK-region account became
    // "Rs35,995" — a $130 car). The digits match, so this is the only tell.
    if (ok && opts.currencySymbol) {
      const symbol = String(input.value).replace(/[\d.,\s]/g, '');
      if (symbol && symbol !== opts.currencySymbol) {
        return { name: disp, ok: false, msg: `entered as "${input.value}" — marketplace region isn't ${opts.currencySymbol === '$' ? 'US' : opts.currencySymbol}, fix the price/currency before publishing` };
      }
    }
    return { name: disp, ok, msg: ok ? `"${input.value}"` : `got "${input.value}"` };
  }

  // `value` may be a single string or an ORDERED candidate list (e.g. a US spelling with its
  // UK fallback) — each is tried in turn, in the portal and in searchable-typing mode.
  async function selectDropdown(name, value) {
    const disp = displayName(name);
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null && v !== '');
    if (!values.length) return { name: disp, ok: false, msg: 'no value' };
    const label = getLabel(name);
    if (!label) return { name: disp, ok: false, msg: 'field not found' };
    realClick(label);
    // wait for the option portal to render, then try each candidate in order
    await waitUntil(() => readOptions().length > 0, 3000);
    let hit = null;
    for (const v of values) {
      hit = matchOption(readOptions(), v);
      if (hit) break;
    }
    if (!hit) {
      // searchable dropdown (e.g. Make): type to filter, then wait for a match to appear
      const focused = document.activeElement;
      if (focused && focused.tagName === 'INPUT') {
        for (const v of values) {
          setNativeValue(focused, String(v));
          hit = await waitUntil(() => matchOption(readOptions(), v), 2500);
          if (hit) break;
        }
      }
    }
    if (!hit) {
      await closeAnyDropdown();
      return { name: disp, ok: false, msg: `no option matched ${values.map((v) => `"${v}"`).join(' / ')}` };
    }
    realClick(hit.el);
    // wait for the listbox to close (selection committed) before the next field opens its own
    await waitUntil(() => readOptions().length === 0, 1500);
    return { name: disp, ok: true, msg: `picked "${hit.txt}"` };
  }

  // Autocomplete field: type the value, then pick the first suggestion that renders.
  // Generalized from Facebook's Location field so any platform's typeahead can reuse it.
  async function fillAutocomplete(name, value) {
    const disp = displayName(name);
    if (value === undefined || value === null || value === '') return { name: disp, ok: false, msg: 'no value' };
    const label = getLabel(name);
    if (!label) return { name: disp, ok: false, msg: 'field not found' };
    const input = label.querySelector('input');
    if (!input) return { name: disp, ok: false, msg: 'no input in field' };
    input.focus();
    setNativeValue(input, '');
    setNativeValue(input, String(value));
    const opt = await waitUntil(() => readOptions()[0], 2500);
    if (opt) {
      realClick(opt.el);
      await waitUntil(() => readOptions().length === 0, 1200);
      return { name: disp, ok: true, msg: `picked "${opt.txt}"` };
    }
    return { name: disp, ok: false, msg: 'no suggestion (left default)' };
  }

  // Native <select> fill (classic server-rendered forms like Craigslist — NOT React portals).
  // Matches by the option's visible text via the same tiered matcher used for portal dropdowns,
  // sets selection, and dispatches input/change. Returns the picked option's text, or null.
  function fillSelect(select, value) {
    if (!select || !select.options || value === undefined || value === null || value === '') return null;
    const opts = [...select.options]
      .map((o) => ({ el: o, txt: (o.textContent || o.value || '').trim() }))
      .filter((o) => o.txt);
    const hit = matchOption(opts, value);
    if (!hit) return null;
    select.value = hit.el.value;
    hit.el.selected = true;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return hit.txt;
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

  // Attach base64 images to a file <input> the way SPAs expect: build a DataTransfer,
  // assign input.files, then dispatch input/change. Returns the number of files attached
  // (0 if none built). `max` caps how many of `images` are used.
  function attachPhotos(input, images, max) {
    const dt = new DataTransfer();
    const list = typeof max === 'number' ? images.slice(0, max) : images;
    for (const img of list) {
      const file = dataUrlToFile(img.dataUrl, img.name);
      if (file) dt.items.add(file);
    }
    if (!dt.files.length) return 0;
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return dt.files.length;
  }

  // Poll `readFn` (returns a number or null) until it reaches `target`. Returns the count
  // once it does, else the last read on timeout — used to confirm a photo upload counter.
  async function waitForCount(readFn, target, timeout, interval = 500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const c = readFn();
      if (c != null && c >= target) return c;
      await sleep(interval);
    }
    return readFn();
  }

  const api = {
    sleep, norm, waitUntil, realClick, setNativeValue,
    fieldName, getLabel, displayName, waitForLabel, readOptions, matchOption,
    closeAnyDropdown, settleUi, fillTextField, selectDropdown, fillAutocomplete, fillSelect,
    dataUrlToFile, attachPhotos, waitForCount,
  };
  root.CarxpertFill = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
