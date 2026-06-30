'use strict';

// ezlist — dealership side. Injects a "List" button on each vehicle card (and on VDP pages)
// for DealerOn-powered sites (e.g. alexandriatoyota.com), then extracts the vehicle straight
// from the structured data-* attributes — no scraping/regex, no backend round-trip.

(() => {
  const HOST = location.hostname;
  // Only run on the dealership site (Facebook has its own content script).
  if (/facebook\.com$/i.test(HOST)) return;

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

  // ---- price: dealer sites bury the real price among fees/discounts; pick the largest plausible ----
  const plausiblePrice = (n) => typeof n === 'number' && n >= 1000 && n <= 500000;
  function extractPrice(el) {
    const candidates = [
      num(attr(el, ['data-dotagging-item-price'])),
      num(attr(el, ['data-price'])),
      decodePriceLib(attr(el, ['data-pricelib']))
    ].filter(plausiblePrice);
    if (candidates.length) return Math.max(...candidates);
    // Fallback: largest plausible $ amount shown on the card/page (dealer hides real price in data attrs sometimes).
    const money = [...String(el.innerText || '').matchAll(/\$\s?([\d,]{4,9})/g)]
      .map((m) => Number(m[1].replace(/,/g, '')))
      .filter(plausiblePrice);
    return money.length ? Math.max(...money) : undefined;
  }
  function decodePriceLib(b64) {
    if (!b64) return undefined;
    try {
      const txt = atob(b64);
      const prices = [...txt.matchAll(/(\d{4,7})(?:\.\d+)?/g)].map((m) => Number(m[1]));
      return prices.length ? Math.max(...prices) : undefined;
    } catch { return undefined; }
  }

  function extractColors(el) {
    let ext = attr(el, ['data-extcolor', 'data-exteriorcolor', 'data-dotagging-item-color']);
    let int = attr(el, ['data-intcolor', 'data-interiorcolor']);
    if (!ext || !int) {
      const t = (el.innerText || '').replace(/\s+/g, ' ');
      if (!ext) ext = (t.match(/Ext\.?:?\s*([^|]+?)\s+Int\.?:/i) || [])[1] || '';
      if (!int) int = (t.match(/Int\.?:?\s*([A-Za-z0-9/ -]+)/i) || [])[1] || '';
    }
    return { ext: ext.trim(), int: int.trim() };
  }

  function photoBaseUrl(el, vin) {
    // 1) derive from an actual gallery/thumbnail image for this vehicle
    const imgs = [...el.querySelectorAll('img'), ...document.querySelectorAll('img')];
    for (const img of imgs) {
      const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset') || '';
      const m = src.match(/(https?:\/\/[^"'\s]*\/inventoryphotos\/\d+\/[^/]+\/ip\/)\d+\.jpe?g/i)
        || src.match(/(\/inventoryphotos\/\d+\/[^/]+\/ip\/)\d+\.jpe?g/i);
      if (m && (!vin || m[1].toLowerCase().includes(vin.toLowerCase()))) {
        return new URL(m[1], location.href).href;
      }
    }
    // 2) fall back to dealer code (found anywhere on the page) + VIN
    if (vin) {
      let code = '';
      for (const img of document.querySelectorAll('img')) {
        const s = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
        const m = s.match(/\/inventoryphotos\/(\d+)\//i);
        if (m) { code = m[1]; break; }
      }
      if (code) return `${location.origin}/inventoryphotos/${code}/${vin.toLowerCase()}/ip/`;
    }
    return '';
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
    const v = {
      vehicleType: 'Car/van',
      vin,
      stock: attr(el, ['data-stocknum', 'data-stocknumber']),
      year: attr(el, ['data-year', 'data-dotagging-item-year']),
      make: attr(el, ['data-make', 'data-dotagging-item-make']),
      model: [model, trim].filter(Boolean).join(' ').trim(),
      trim,
      price: extractPrice(el),
      mileage: num(attr(el, ['data-dotagging-item-odometer', 'data-odometer', 'data-mileage'])),
      fuelType: attr(el, ['data-fueltype', 'data-dotagging-item-fuel-type']),
      bodyType: attr(el, ['data-dotagging-item-body-type', 'data-bodystyle', 'data-dotagging-item-type']),
      engine: attr(el, ['data-engine']),
      exteriorColor: colors.ext,
      interiorColor: colors.int,
      transmission: 'Automatic', // FB only offers Manual/Automatic; default + user reviews
      condition: 'Excellent',
      location: DEALER.location,
      sourceUrl: sourceUrl || location.href,
      photoBaseUrl: photoBaseUrl(el, vin)
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
  function paint(btn) {
    if (btn.dataset.busy) return; // mid-click transient text — don't clobber
    const listed = !!(btn.dataset.ezkey && listedKeys[btn.dataset.ezkey]);
    const vdp = btn.classList.contains('ezlist-vdp-btn');
    btn.style.background = listed ? '#178a3f' : '#1877f2';
    btn.textContent = listed ? (vdp ? '✓ Added — re-list' : '✓ Added') : (vdp ? '⚡ List on Marketplace' : '⚡ List');
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
        chrome.runtime.sendMessage({ type: 'EZLIST_PREFETCH_IMAGES', baseUrl: draft.photoBaseUrl }).catch(() => {});
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
    'color:#fff', 'border:0', 'border-radius:6px',
    'padding:6px 10px', 'font:700 12px/1 system-ui,-apple-system,Segoe UI,sans-serif',
    'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.25)'
  ].join(';'); // background colour is set by paint() per listed-state

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
    btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;color:#fff;border:0;border-radius:8px;padding:12px 16px;font:700 14px/1 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)';
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
  // The vehicle this VDP is actually about (match the VIN in the URL, not the first "similar vehicle").
  function vdpVehicleEl() {
    const vin = vinFromUrl();
    if (vin) {
      const el = document.querySelector(`[data-vin="${vin}"]`) || document.querySelector(`[data-vin="${vin.toUpperCase()}"]`);
      if (el) return el;
    }
    return document.querySelector('[data-vin]');
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
