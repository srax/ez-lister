'use strict';

// ezlist — dealership side. Injects a "List" button on each vehicle card (and on VDP pages)
// for DealerOn-powered sites (e.g. alexandriatoyota.com), then extracts the vehicle straight
// from the structured data-* attributes — no scraping/regex, no backend round-trip.

(() => {
  const HOST = location.hostname;
  // Only run on the dealership site (Facebook has its own content script).
  if (/facebook\.com$/i.test(HOST)) return;

  // Pure helpers shared with the FB filler (lib/mappers.js, loaded first via manifest).
  const M = globalThis.CarxpertShared;

  const DEALER = {
    // Default Marketplace listing location for this dealer.
    location: 'Alexandria, VA'
  };

  const num = (s) => {
    const m = String(s == null ? '' : s).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Math.round(parseFloat(m[0])) : undefined;
  };
  const attr = (el, names) => {
    for (const n of names) { const v = el.getAttribute && el.getAttribute(n); if (v != null && v !== '') return v; }
    return '';
  };

  // ---- price ----
  // Live-probed: `data-price`/`data-msrp` are often "0" on used cards, and
  // `data-dotagging-item-price` disagrees between SRP and VDP for the same car (31405 vs
  // 995 doc fee — and 16750 on a card whose advertised price was 7495). The labelled
  // pricelib entry is the site's actual advertised price, so it wins outright; the other
  // attrs are fallbacks, and page text is the last resort.
  function extractPrice(el) {
    const labeled = M.decodePriceLib(attr(el, ['data-pricelib']));
    if (M.plausiblePrice(labeled)) return labeled;
    const candidates = [
      num(attr(el, ['data-dotagging-item-price'])),
      num(attr(el, ['data-price']))
    ].filter(M.plausiblePrice);
    if (candidates.length) return Math.max(...candidates);
    // Fallback: largest plausible $ amount shown on the card/page (dealer hides real price in data attrs sometimes).
    const money = [...String(el.innerText || '').matchAll(/\$\s?([\d,]{4,9})/g)]
      .map((m) => Number(m[1].replace(/,/g, '')))
      .filter(M.plausiblePrice);
    return money.length ? Math.max(...money) : undefined;
  }

  // Rendered VDP spec grid (.info__details rows labelled "Mileage", "Exterior Color", …).
  // Cards don't render it; on a VDP only the main vehicle element carries it (verified
  // live), so scoping to `el` keeps "similar vehicles" rails from leaking values in.
  function specFromGrid(el, labelRe) {
    if (!el || !el.querySelectorAll) return '';
    for (const d of el.querySelectorAll('.info__details')) {
      const label = d.querySelector('.info__label');
      if (label && labelRe.test((label.textContent || '').trim())) {
        const val = d.querySelector('.info__value');
        if (val) return (val.getAttribute('title') || val.textContent || '').trim();
      }
    }
    return '';
  }

  // Color source ladder (best first): data attrs → dotagging attrs → VDP spec-grid row →
  // card text. Live probe: the card text is rendered FROM the attrs (never richer) and
  // VDPs never backfill colors the feed lacks — when every rung misses, the color simply
  // doesn't exist on the site and blank is correct. cleanAttr strips the raw HTML the
  // feed injects into new-car color attrs (disclaimer links).
  function extractColors(el) {
    let ext = M.cleanAttr(attr(el, ['data-extcolor', 'data-exteriorcolor', 'data-dotagging-item-color']));
    let int = M.cleanAttr(attr(el, ['data-intcolor', 'data-interiorcolor', 'data-dotagging-item-color-interior']));
    if (!ext) ext = M.cleanAttr(specFromGrid(el, /^exterior colou?r$/i));
    if (!int) int = M.cleanAttr(specFromGrid(el, /^interior colou?r$/i));
    if (!ext || !int) {
      const t = (el.innerText || '').replace(/\s+/g, ' ');
      if (!ext) ext = ((t.match(/Ext\.?:?\s*([^|]+?)\s+Int\.?:/i) || [])[1] || '').trim();
      if (!int) int = ((t.match(/Int\.?:?\s*([A-Za-z0-9/ -]+)/i) || [])[1] || '').trim();
    }
    return { ext, int };
  }

  // Gallery base for this vehicle. Live-probed: real photos are `/inventoryphotos/
  // <code>/<vin>/ip/<n>.jpg` but new-car STOCK photos are `.../sp/<n>.png`, and the
  // <code> segment differs even within one dealer — so both folder and extension must be
  // derived, never assumed. Returns { base, ext } or null.
  const GALLERY_RE = /(https?:\/\/[^"'\s]*\/inventoryphotos\/\d+\/[^/]+\/(?:ip|sp)\/)\d+\.(jpe?g|png)/i;
  const GALLERY_RE_REL = /(\/inventoryphotos\/\d+\/[^/]+\/(?:ip|sp)\/)\d+\.(jpe?g|png)/i;
  function photoSource(el, vin) {
    const fromSrc = (src) => {
      const m = String(src || '').match(GALLERY_RE) || String(src || '').match(GALLERY_RE_REL);
      if (m && (!vin || m[1].toLowerCase().includes(vin.toLowerCase()))) {
        return { base: new URL(m[1], location.href).href, ext: m[2].toLowerCase().replace('jpeg', 'jpg') };
      }
      return null;
    };
    // 1) an actual gallery/thumbnail image for this vehicle
    for (const img of [...el.querySelectorAll('img'), ...document.querySelectorAll('img')]) {
      const hit = fromSrc(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset') || '');
      if (hit) return hit;
    }
    // 2) JSON-LD (SRP ItemList / VDP Vehicle) always carries photo 1 — reliable when the
    //    grid images are lazy-loaded placeholders. fromSrc's VIN check picks OUR car's
    //    URL out of the ItemList (which contains every card's image).
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      for (const m of (s.textContent || '').matchAll(/https?:\/\/[^"'\s\\]*\/inventoryphotos\/\d+\/[^/]+\/(?:ip|sp)\/\d+\.(?:jpe?g|png)/gi)) {
        const hit = fromSrc(m[0]);
        if (hit) return hit;
      }
    }
    // 3) last resort: dealer photo code (from any page image) + VIN, used-car layout
    if (vin) {
      let code = '';
      for (const img of document.querySelectorAll('img')) {
        const s = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
        const m = s.match(/\/inventoryphotos\/(\d+)\//i);
        if (m) { code = m[1]; break; }
      }
      if (code) return { base: `${location.origin}/inventoryphotos/${code}/${vin.toLowerCase()}/ip/`, ext: 'jpg' };
    }
    return null;
  }

  function buildDescription(v) {
    const lines = [];
    lines.push([v.year, v.make, v.model].filter(Boolean).join(' '));
    if (typeof v.mileage === 'number') lines.push(`• Mileage: ${v.mileage.toLocaleString('en-US')} miles`);
    if (v.vin) lines.push(`• VIN: ${v.vin}`);
    if (v.stock) lines.push(`• Stock #: ${v.stock}`);
    if (v.exteriorColor) lines.push(`• Exterior: ${v.exteriorColor}`);
    if (v.interiorColor) lines.push(`• Interior: ${v.interiorColor}`);
    if (v.engine) lines.push(`• Engine: ${v.engine}`);
    if (v.fuelType) lines.push(`• Fuel: ${v.fuelType}`);
    lines.push('');
    lines.push('Message us to schedule a test drive!');
    if (v.sourceUrl) lines.push(v.sourceUrl);
    return lines.join('\n');
  }

  function extractVehicle(scope, sourceUrl) {
    const el = scope.getAttribute && scope.getAttribute('data-vin')
      ? scope
      : scope.querySelector('[data-vin]') || scope;
    const colors = extractColors(el);
    const trim = attr(el, ['data-trim']);
    const model = attr(el, ['data-model', 'data-dotagging-item-model']);
    const vin = attr(el, ['data-vin']);
    // Cards expose data-*-odometer; VDPs don't — fall back to the rendered spec grid there.
    const odo = num(attr(el, ['data-dotagging-item-odometer', 'data-odometer', 'data-mileage']));
    const mileage = odo === undefined ? num(specFromGrid(el, /mileage/i)) : odo;
    const photos = photoSource(el, vin);
    const v = {
      vehicleType: 'Car/van',
      vin,
      stock: attr(el, ['data-stocknum', 'data-stocknumber']),
      year: attr(el, ['data-year', 'data-dotagging-item-year']),
      make: attr(el, ['data-make', 'data-dotagging-item-make']),
      model: [model, trim].filter(Boolean).join(' ').trim(),
      trim,
      price: extractPrice(el),
      mileage,
      fuelType: attr(el, ['data-fueltype', 'data-dotagging-item-fuel-type']),
      bodyType: attr(el, ['data-dotagging-item-body-type', 'data-bodystyle', 'data-dotagging-item-type']),
      engine: attr(el, ['data-engine']),
      exteriorColor: colors.ext,
      interiorColor: colors.int,
      // DealerOn's own coarse bucket ("Gray", "Other") — SRP cards only. The FB filler
      // falls back to it when the marketing name doesn't map ("Other" maps to blank).
      exteriorColorGeneric: M.cleanAttr(attr(el, ['data-dotagging-item-generic-color'])),
      // Feed value ("Automatic", "Variable", CVT strings) — the FB filler maps anything
      // non-/manual/ to Automatic, so manual cars finally list as Manual.
      transmission: attr(el, ['data-trans', 'data-transmission', 'data-dotagging-item-transmission']) || 'Automatic',
      condition: 'Excellent',
      location: DEALER.location,
      sourceUrl: sourceUrl || location.href,
      photoBaseUrl: photos ? photos.base : '',
      photoExt: photos ? photos.ext : 'jpg'
    };
    v.description = buildDescription(v);
    return v;
  }

  // ---- button + click flow ----
  // Pre-warm the FB create tab on first hover (intent signal) so its heavy load overlaps the user's click.
  let prewarmed = false;
  function maybePrewarm() {
    if (prewarmed) return;
    prewarmed = true;
    chrome.runtime.sendMessage({ type: 'EZLIST_PREWARM' }).catch(() => {});
  }

  // ---- listed-state (green "✓ Added") ----
  // A card turns green only once its VIN is confirmed *published* on Facebook — the FB
  // content script writes ezlistListedVins on a real publish (never on an abandoned form).
  // Until then it stays "⚡ List". Clicking a green button still re-runs the flow to re-list.
  let listedKeys = {};
  chrome.storage.local.get(['ezlistListedVins'])
    .then((s) => { listedKeys = s.ezlistListedVins || {}; repaintAll(); })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ezlistListedVins) {
      listedKeys = changes.ezlistListedVins.newValue || {};
      repaintAll();
    }
  });
  function cardKey(card, vdpUrl) {
    const vin = (card.getAttribute('data-vin') || '').toUpperCase();
    if (vin) return vin;
    const stock = card.getAttribute('data-stocknum') || card.getAttribute('data-stocknumber') || '';
    return stock || vdpUrl || '';
  }
  // Inline ink-coloured bolt (the panel's lightning mark); fill:currentColor so it inherits
  // the button's text colour. Set via innerHTML (static markup, no user input).
  const BOLT = (sz) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex:0 0 auto"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z"/></svg>`;
  function paint(btn) {
    if (btn.dataset.busy) return; // mid-click transient text — don't clobber
    const listed = !!(btn.dataset.ezkey && listedKeys[btn.dataset.ezkey]);
    const vdp = btn.classList.contains('ezlist-vdp-btn');
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

  async function onList(scope, btn, sourceUrl) {
    btn.dataset.busy = '1';
    btn.textContent = '…'; btn.disabled = true;
    try {
      const draft = extractVehicle(scope, sourceUrl);
      if (!draft.vin) throw new Error('no VIN found on this card');
      await chrome.runtime.sendMessage({ type: 'EZLIST_SAVE_DRAFT', draft, autoFill: true });
      // Overlap: start downloading photos now, in parallel with the FB tab opening + form fill.
      if (draft.photoBaseUrl) {
        chrome.runtime.sendMessage({ type: 'EZLIST_PREFETCH_IMAGES', baseUrl: draft.photoBaseUrl, ext: draft.photoExt }).catch(() => {});
      }
      await chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_FACEBOOK' });
      btn.textContent = '✓ Opened FB';
      prewarmed = false; // allow warming a fresh tab for the next car
    } catch (e) {
      btn.textContent = 'Error';
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
    if (!card.getAttribute('data-vin')) return;
    if (card.querySelector(':scope > .ezlist-list-btn')) return;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const vdp = [...card.querySelectorAll('a[href]')]
      .map((a) => a.href)
      .find((h) => /\/(used|new)-/i.test(h) && /[A-HJ-NPR-Z0-9]{11,17}$/i.test(h.replace(/[^A-Za-z0-9]/g, '')));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ezlist-list-btn';
    btn.style.cssText = BTN_STYLE;
    btn.dataset.ezkey = cardKey(card, vdp);
    paint(btn);
    btn.addEventListener('mouseenter', maybePrewarm);
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onList(card, btn, vdp); });
    card.appendChild(btn);
  }

  function addVdpButton() {
    if (document.querySelector('.ezlist-vdp-btn')) return;
    const el = vdpVehicleEl();
    if (!el) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ezlist-vdp-btn';
    btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:11px;padding:10px 15px;font:800 13.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.1px;white-space:nowrap;cursor:pointer'; // bg, colour + shadow set by paint()
    btn.dataset.ezkey = (el.getAttribute('data-vin') || '').toUpperCase() || vinFromUrl().toUpperCase() || location.href;
    paint(btn);
    btn.addEventListener('mouseenter', maybePrewarm);
    btn.addEventListener('click', () => onList(el, btn, location.href));
    document.body.appendChild(btn);
  }

  function vinFromUrl() {
    const m = location.pathname.match(/([A-HJ-NPR-Z0-9]{11,17})(?:[/?#]|$)/i);
    return m ? m[1] : '';
  }
  // The vehicle this VDP is actually about. Prefer the main `.vdp[data-vin]` element —
  // live-probed: ~16 OTHER elements also carry data-vin on a VDP (CTA buttons, thumbnails,
  // related-vehicle cards with different VINs), and only .vdp has the full 49-attr dataset.
  function vdpVehicleEl() {
    const vin = vinFromUrl();
    if (vin) {
      const el = document.querySelector(`.vdp[data-vin="${vin}" i]`)
        || document.querySelector(`[data-vin="${vin}"]`)
        || document.querySelector(`[data-vin="${vin.toUpperCase()}"]`);
      if (el) return el;
    }
    return document.querySelector('.vdp[data-vin]') || document.querySelector('[data-vin]');
  }
  function isVdpPage() {
    return /\/(used|new)-/i.test(location.pathname) && !!vinFromUrl() && !!document.querySelector('[data-vin]');
  }

  function scan() {
    // Inventory grid (and any "similar vehicles" rails): a List button per card.
    document.querySelectorAll('[data-vehicle-information][data-vin]').forEach(addCardButton);
    // Detail page: a floating List button for the main vehicle.
    if (isVdpPage()) addVdpButton();
  }

  // Popup-triggered listing of the car on the current detail page.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'EZLIST_LIST_CURRENT') return false;
    if (!isVdpPage()) {
      sendResponse({ ok: false, error: 'Open a specific car page, or click List on the inventory grid.' });
      return false;
    }
    try {
      const draft = extractVehicle(vdpVehicleEl(), location.href);
      if (!draft.vin) { sendResponse({ ok: false, error: 'No vehicle data found on this page.' }); return false; }
      chrome.runtime.sendMessage({ type: 'EZLIST_SAVE_DRAFT', draft }, () => {
        chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_FACEBOOK' });
        sendResponse({ ok: true, draft });
      });
      return true; // async sendResponse
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
      return false;
    }
  });

  let scanTimer = null;
  const debouncedScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300); };
  const start = () => {
    scan();
    new MutationObserver(debouncedScan).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
