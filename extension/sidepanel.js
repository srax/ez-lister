'use strict';

// Carxpert side panel — control surface. Shows the current vehicle, lets the user
// tune the listing (description, emoji, unit, toggles), then hands off to the
// Facebook content script to fill the form. The user always reviews + Publishes.

const DEFAULT_PREFS = { emoji: '', unit: 'mi', category: '', mileage: true, lang: 'en', aiDesc: false, platform: 'fb' };

// Where-to-post labels for status copy (must match the #platform <option> values).
const PLATFORM_LABEL = { fb: 'Facebook Marketplace', craigslist: 'Craigslist', offerup: 'OfferUp', cars: 'Cars.com' };
const platformLabel = (p) => PLATFORM_LABEL[p] || 'Facebook Marketplace';
// Dealership-outcome logic (Part 2) — pure module loaded via <script> before this file.
const DO = globalThis.CarxpertDealerOutcome;
// Short badge (abbrev + brand colour) shown per platform on each "Your listings" row.
const PLATFORM_BADGE = { fb: ['FB', '#1877f2'], craigslist: ['CL', '#5c2d91'], offerup: ['OU', '#12b76a'], cars: ['Cars', '#6b7280'] };
// Footer "open the form" button label — follows the Where-to-post selection.
const OPEN_LABEL = { fb: 'Open FB form', craigslist: 'Open Craigslist', offerup: 'Open OfferUp', cars: 'Open Cars.com' };
const updateOpenButton = () => { ui.openfb.textContent = OPEN_LABEL[ui.platform.value] || 'Open form'; };
const platformBadgeHtml = (p) => (PLATFORM_BADGE[p] ? `<span class="lst-badge" style="background:${PLATFORM_BADGE[p][1]}">${esc(PLATFORM_BADGE[p][0])}</span>` : '');

const el = (id) => document.getElementById(id);
const ui = {
  vehicle: el('vehicle'),
  vehTitle: document.querySelector('.veh-title'),
  vehMeta: document.querySelector('.veh-meta'),
  vehVin: document.querySelector('.veh-vin'),
  vehListed: document.querySelector('.veh-listed'),
  vehPhoto: document.querySelector('.veh-photo'),
  platform: el('platform'), howto: el('howto'), category: el('category'), emoji: el('emoji'),
  unitMi: el('unit-mi'), unitKm: el('unit-km'),
  desc: el('desc'), charcount: el('charcount'),
  aiDraft: el('ai-draft'), lang: el('lang'), translate: el('translate'),
  tAi: el('t-ai'), tMileage: el('t-mileage'),
  fill: el('fill'), openfb: el('openfb'), openInv: el('open-inventory'),
  status: el('status'),
  statsBtn: el('stats-btn'), statsBack: el('stats-back'),
  viewLister: el('view-lister'), viewStats: el('view-stats'),
  statsRange: el('stats-range'), statsRangeLabel: el('stats-range-label'),
  stActive: el('st-active'), stSold: el('st-sold'), stGross: el('st-gross'),
  stDays: el('st-days'), stHeroRange: el('st-hero-range'), stDelta: el('st-delta'),
  stListed: el('st-listed'), stListedSub: el('st-listed-sub'), stValue: el('st-value'),
  stPlatforms: el('st-platforms'), stTrend: el('st-trend'), stListings: el('st-listings'),
  statsDot: el('stats-dot'),
  dealerCard: el('st-dealer-card'), dealerFb: el('st-dealer-fb'), dealerCl: el('st-dealer-cl'), dealerDe: el('st-dealer-de'),
  // auth + entitlement gate
  gate: el('gate'), gateIcon: el('gate-icon'), gateTitle: el('gate-title'), gateMsg: el('gate-msg'),
  gateSteps: el('gate-steps'), gateBenefits: el('gate-benefits'),
  gateDealer: el('gate-dealer'), gatePrice: el('gate-price'), gatePriceAmt: el('gate-price-amt'), gatePricePer: el('gate-price-per'),
  gatePrimary: el('gate-primary'), gateSecondary: el('gate-secondary'),
  gateErr: el('gate-err'), gateSignout: el('gate-signout'),
  dealerConnect: el('dealer-connect'), dealerPending: el('dealer-pending'),
  dealerRequestToggle: el('dealer-request-toggle'), dealerRequest: el('dealer-request'),
  dealerSwitchToggle: el('dealer-switch-toggle'), dealerUrlRow: el('dealer-url-row'),
  dealerConnectUrl: el('dealer-connect-url'), dealerConnectDetect: el('dealer-connect-detect'),
  gateChangeDealer: el('gate-change-dealer'), dealerKeep: el('dealer-keep'),
  dealerUrl: el('dealer-url'), dealerName: el('dealer-name'), dealerEmail: el('dealer-email'),
  dealerPhone: el('dealer-phone'), dealerNotes: el('dealer-notes'),
  dealerRequestCancel: el('dealer-request-cancel'), dealerRequestSubmit: el('dealer-request-submit'),
  accountBtn: el('account-btn'), accountMenu: el('account-menu'), accountEmail: el('account-email'),
  accountPlan: el('account-plan'), acctBilling: el('acct-billing'), acctSignout: el('acct-signout'),
};

const state = {
  draft: null,
  prefs: { ...DEFAULT_PREFS },
  listed: {},
  listings: {},
  serverListings: {},
  userEdited: false,
  filling: false,
  auth: null,
  plan: null,
  dealerRequestOpen: false,
  autoDealerConnectTried: false,
  detectedDealer: null,   // resolved-but-NOT-linked dealership awaiting the user's confirmation
  dealerUrlOpen: false,   // "enter your website" row visible
  changingDealer: false,  // pre-payment "change dealership": show the connect step despite a link
  linkFlash: null,
  authResolved: false,     // first /api/me answer landed — until then the gate shows "checking"
  checkoutPending: false,  // Stripe tab is open — show the "finish in checkout" beat
  welcome: false,          // one-time arrival screen after completing onboarding this session
  lastGateScreen: 'checking'
};

init();

async function init() {
  const store = await chrome.storage.local.get(['ezlistDraft', 'ezlistPrefs', 'ezlistListedVins', 'ezlistListings']);
  state.draft = store.ezlistDraft || null;
  state.prefs = { ...DEFAULT_PREFS, ...(store.ezlistPrefs || {}) };
  state.listed = store.ezlistListedVins || {};
  state.listings = store.ezlistListings || {};
  await migrateListings();
  applyPrefsToUI();
  renderVehicle();
  recomposeDesc();
  wireEvents();
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'EZLIST_FILL_STATUS') setStatus(msg.text, msg.error);
  });
  // Re-check entitlement when the panel regains focus (e.g. returning from Stripe checkout).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAuth({ refresh: true }); });
  loadBillingPlan().catch(() => {});
  // Best-effort: pull server listings once on load so the Stats-button attention dot can show
  // before the user ever opens the stats view. Silent on failure / not-entitled / offline.
  loadServerListings().then((ok) => { if (ok) updateNeedsActionDot(); }).catch(() => {});
  await refreshAuth();
}

// ---------- rendering ----------
function keyForDraft(d) {
  if (!d) return '';
  return (d.vin || '').toUpperCase() || d.stock || d.sourceUrl || '';
}

// ezlistListedVins entries are per-platform { fb?, craigslist?, ... }; legacy flat { listedAt }
// means Facebook. "Listed" reflects the currently-selected "Where to post" marketplace.
function listedPlatforms(entry) {
  if (!entry || typeof entry !== 'object') return {};
  if ('listedAt' in entry) return { fb: { listedAt: entry.listedAt } };
  return entry;
}
function isListed(d) {
  const k = keyForDraft(d);
  if (!k) return false;
  const platform = (state.prefs && state.prefs.platform) || 'fb';
  return !!listedPlatforms(state.listed[k])[platform];
}

function renderVehicle() {
  const d = state.draft;
  if (!d) {
    ui.vehicle.classList.add('empty');
    ui.fill.disabled = true;
    setStatus('Pick a car to get started.');
    return;
  }
  ui.vehicle.classList.remove('empty');
  ui.vehTitle.textContent = [d.year, d.make, d.model].filter(Boolean).join(' ') || 'Vehicle';
  const price = d.price ? `$${Number(d.price).toLocaleString('en-US')}` : 'No price';
  const miles = typeof d.mileage === 'number'
    ? ` · ${formatDistance(d.mileage)}` : '';
  ui.vehMeta.innerHTML = `<span class="price">${esc(price)}</span>${esc(miles)}`;
  ui.vehVin.textContent = d.vin ? `VIN ${d.vin}` : (d.stock ? `Stock #${d.stock}` : '');
  ui.vehListed.hidden = !isListed(d);
  setVehiclePhoto(d);
  ui.fill.disabled = state.filling;
  if (!state.filling) {
    setStatus(isListed(d) ? 'Already listed — fill again to re-list with changes.' : 'Ready. Tune the listing, then Fill.');
  }
}

// Show one vehicle photo on the right of the card. DealerOn inventory photos are
// ${photoBaseUrl}<n>.jpg; try the hero shot, fall back through a couple, then hide.
function setVehiclePhoto(d) {
  const img = ui.vehPhoto;
  if (!img) return;
  const base = d && d.photoBaseUrl;
  if (!base) { img.hidden = true; img.removeAttribute('src'); return; }
  const ext = (d && d.photoExt) || 'jpg';
  const candidates = [`${base}1.${ext}`, `${base}0.${ext}`, `${base}2.${ext}`];
  let i = 0;
  img.hidden = true;
  img.onload = () => { img.hidden = false; };
  img.onerror = () => { i += 1; if (i < candidates.length) img.src = candidates[i]; else { img.hidden = true; img.removeAttribute('src'); } };
  img.src = candidates[0];
}

// Description template + distance formatting live in lib/mappers.core.js (CarxpertCore) — the ONE
// template shared with dealerContent's ⚡ List save, so the panel preview and the auto-filled
// marketplace description can never diverge. Vehicle details are always included (the old
// "Add dealership description" trim toggle is gone — the full version is what gets posted).
function formatDistance(mi) {
  return globalThis.CarxpertCore.formatDistance(mi, state.prefs.unit);
}

function recomposeDesc() {
  ui.desc.value = globalThis.CarxpertCore.composeDescription(state.draft, state.prefs).slice(0, 1000);
  state.userEdited = false;
  updateCharCount();
}

function updateCharCount() {
  ui.charcount.textContent = `${ui.desc.value.length} / 1000`;
}

function applyPrefsToUI() {
  ui.emoji.value = state.prefs.emoji;
  ui.category.value = state.prefs.category;
  ui.platform.value = state.prefs.platform || 'fb';
  updateOpenButton();
  ui.lang.value = state.prefs.lang || 'en';
  ui.unitMi.classList.toggle('on', state.prefs.unit === 'mi');
  ui.unitKm.classList.toggle('on', state.prefs.unit === 'km');
  ui.tAi.classList.toggle('on', !!state.prefs.aiDesc);
  ui.tMileage.classList.toggle('on', !!state.prefs.mileage);
  syncSelects();
}

// ---------- custom dropdowns (progressive enhancement over native <select>) ----------
// The native <select> stays in the DOM (hidden) as the value store + change source, so all the
// existing wiring (ui.x.value, addEventListener('change'), savePref) is untouched. We overlay a
// styled, keyboard-accessible listbox that writes back to the select and dispatches 'change'.
const cselRegistry = [];

function platformIcon(value) {
  const map = { fb: ['f', '#1877f2'], craigslist: ['c', '#5c2d91'], offerup: ['o', '#12b76a'] };
  if (value === 'cars') return '<span class="csel-emoji">🚗</span>';
  const m = map[value];
  return m ? `<span class="csel-badge" style="background:${m[1]}">${esc(m[0])}</span>` : '';
}
const CSEL_GLOBE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>';
const optIconHtml = (selId, value) => (selId === 'platform' ? platformIcon(value) : '');
const triggerLeftHtml = (selId, value) => (selId === 'lang' ? CSEL_GLOBE : optIconHtml(selId, value));

function closeAllCsel(except) { cselRegistry.forEach((e) => { if (e !== except) e.close(); }); }
function syncSelects() { cselRegistry.forEach((e) => e.sync()); }

function enhanceSelects() {
  document.querySelectorAll('select.vsl-sel').forEach(enhanceSelect);
  if (!enhanceSelects._bound) {
    document.addEventListener('click', (e) => {
      cselRegistry.forEach((entry) => { if (!entry.root.contains(e.target)) entry.close(); });
    });
    enhanceSelects._bound = true;
  }
}

function enhanceSelect(select) {
  const wrap = select.closest('.select-wrap');
  if (!wrap || wrap.querySelector('.csel')) return;
  const selId = select.id;
  const opts = [...select.options];

  const root = document.createElement('div');
  root.className = 'csel';
  if (select.classList.contains('emoji-sel')) root.classList.add('csel-lg');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'csel-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span class="csel-left"></span><span class="csel-value"></span>'
    + '<svg class="csel-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  const menu = document.createElement('ul');
  menu.className = 'csel-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  opts.forEach((o, i) => {
    const li = document.createElement('li');
    li.className = 'csel-opt';
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    if (o.disabled) li.classList.add('is-disabled');
    const icon = optIconHtml(selId, o.value);
    li.innerHTML = (icon ? `<span class="csel-oicon">${icon}</span>` : '')
      + `<span class="csel-opt-label">${esc(o.textContent.trim())}</span>`
      + '<svg class="csel-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    menu.appendChild(li);
  });

  root.appendChild(trigger);
  root.appendChild(menu);
  wrap.appendChild(root);
  select.classList.add('csel-native');
  wrap.querySelectorAll(':scope > .chev, :scope > .globe').forEach((el) => { el.style.display = 'none'; });

  const items = [...menu.children];
  let activeIdx = -1;
  const setActive = (idx) => {
    if (items[activeIdx]) items[activeIdx].classList.remove('active');
    activeIdx = idx;
    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
  };
  const firstEnabled = () => opts.findIndex((o) => !o.disabled);
  const sync = () => {
    const val = select.value;
    const sel = opts.find((o) => o.value === val) || opts[0];
    const left = triggerLeftHtml(selId, val);
    const leftEl = trigger.querySelector('.csel-left');
    leftEl.innerHTML = left;
    leftEl.style.display = left ? '' : 'none';
    trigger.querySelector('.csel-value').textContent = sel ? sel.textContent.trim() : '';
    items.forEach((li, i) => {
      const on = opts[i].value === val;
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      li.classList.toggle('is-selected', on);
    });
  };
  let closeTimer = null;
  const close = () => {
    if (menu.hidden || menu.classList.contains('closing')) return;
    root.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    setActive(-1);
    // Exit beat: fade out (~90ms, quicker than the entry) before actually hiding.
    menu.classList.add('closing');
    closeTimer = setTimeout(() => { menu.hidden = true; menu.classList.remove('closing'); }, 90);
  };
  const open = () => {
    if (!menu.hidden && !menu.classList.contains('closing')) return;
    clearTimeout(closeTimer); // reopening mid-close retargets cleanly
    menu.classList.remove('closing');
    closeAllCsel(entry);
    menu.hidden = false;
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    const cur = opts.findIndex((o) => o.value === select.value);
    setActive(cur >= 0 && !opts[cur].disabled ? cur : firstEnabled());
  };
  const choose = (idx) => {
    const o = opts[idx];
    if (!o || o.disabled) return;
    if (select.value !== o.value) {
      select.value = o.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
    close();
    trigger.focus();
  };
  const step = (dir) => {
    let i = activeIdx;
    for (let n = 0; n < opts.length; n += 1) {
      i = (i + dir + opts.length) % opts.length;
      if (!opts[i].disabled) { setActive(i); break; }
    }
  };

  const isOpen = () => !menu.hidden && !menu.classList.contains('closing');
  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (!isOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(activeIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { close(); }
  });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('.csel-opt');
    if (li) choose(parseInt(li.dataset.index, 10));
  });
  menu.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.csel-opt');
    if (li && !li.classList.contains('is-disabled')) setActive(parseInt(li.dataset.index, 10));
  });

  const entry = { select, root, sync, close };
  cselRegistry.push(entry);
  sync();
}

function setStatus(text, isError) {
  const t = text || '';
  ui.status.textContent = t;
  ui.status.classList.toggle('err', !!isError);
  // Terminal success lines ("Listing filled ✓", "✓ Listed on Craigslist") turn green; anything
  // trailing an ellipsis or streaming per-field progress ("✓ Price: …", "• Photos: …") shows a
  // small working spinner so a long fill visibly reads as in-progress, not stalled.
  const ok = !isError && /filled ✓|listed on/i.test(t);
  const working = !isError && !ok && (/…$/.test(t) || /^[✓•] /.test(t));
  ui.status.classList.toggle('ok', ok);
  ui.status.classList.toggle('working', working);
}

// ---------- stats view ----------
// Switch between the lister and the Sales-overview screen (the design's two card faces).
function showView(view) {
  const stats = view === 'stats';
  ui.viewLister.hidden = stats;
  ui.viewStats.hidden = !stats;
  if (stats) {
    renderStats(); // paint local immediately…
    loadServerListings().then((ok) => { if (ok) renderStats(); }); // …then refresh from the server
  }
}

// Seed ezlistListings from older ezlistListedVins keys (users who published before the
// richer schema existed). Non-destructive; runs once on load.
async function migrateListings() {
  let changed = false;
  for (const [key, v] of Object.entries(state.listed || {})) {
    const fb = listedPlatforms(v).fb; // ezlistListings is the FB-side stats record (Phase 1)
    if (fb && !state.listings[key]) {
      state.listings[key] = {
        key,
        vin: key.length === 17 ? key : undefined,
        platform: 'fb',
        status: 'active',
        listedAt: fb.listedAt || new Date().toISOString(),
      };
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ ezlistListings: state.listings });
}

// Stats source of truth = server listings (synced from every device) overlaid with the local
// record, so a just-published or just-marked-sold car shows instantly before the sync lands.
const listingsArray = () => {
  const byKey = {};
  for (const l of Object.values(state.serverListings || {})) byKey[l.key] = l;
  for (const l of Object.values(state.listings || {})) {
    const server = byKey[l.key];
    const merged = { ...(server || {}), ...l };
    // Sold wins: a server-side sale (e.g. the sold-scan worker) must not be masked by the
    // stale local 'active' record. A local undo shows sold for a few seconds until its
    // marked_sold_undo event syncs and the next server pull flips the row back to listed.
    if (server && server.status === 'sold' && merged.status !== 'sold') {
      merged.status = 'sold';
      merged.soldAt = server.soldAt;
      if (server.soldPrice != null) merged.soldPrice = server.soldPrice;
    }
    byKey[l.key] = merged;
  }
  return Object.values(byKey);
};

// Map a server row (snake_case, status 'listed'|'sold'|'removed') to the local shape the
// stats renderer expects (status 'active'|'sold').
function fromServerListing(r) {
  return {
    key: r.client_key || r.vin || r.id,
    vin: r.vin || undefined,
    title: r.title || [r.year, r.make, r.model].filter(Boolean).join(' ') || undefined,
    year: r.year, make: r.make, model: r.model,
    price: r.price != null ? Number(r.price) : undefined,
    soldPrice: r.sold_price != null ? Number(r.sold_price) : undefined,
    platform: r.platform || 'fb',
    // Per-platform child rows from the server (listing_platforms) — presence + listing URLs.
    platforms: Array.isArray(r.platforms) ? r.platforms : undefined,
    soldPlatform: r.sold_platform || undefined,
    status: r.status === 'sold' ? 'sold' : 'active',
    listedAt: r.listed_at || undefined,
    soldAt: r.sold_at || undefined,
    sourceUrl: r.source_url || undefined,
    // Part 2 (inventory outcomes) — the backend signals a confirmed-gone car via gone_confirmed_at
    // (or an explicit inventory_gone flag); dealer_outcome/at carry the user's classification once made.
    inventoryGone: !!(r.gone_confirmed_at || r.inventory_gone),
    dealerOutcome: DO && DO.isOutcome(r.dealer_outcome) ? r.dealer_outcome : undefined,
    dealerOutcomeAt: r.dealer_outcome_at || undefined
  };
}

// Pull the server-side listings for the stats view (best effort; leaves local intact on
// failure / not-entitled / offline). Kept in state.serverListings — never written to storage,
// so it can't trigger the sync loop.
async function loadServerListings() {
  const res = await chrome.runtime.sendMessage({ type: 'EZLIST_GET_LISTINGS' }).catch(() => null);
  if (!res || !res.ok || !Array.isArray(res.listings)) return false;
  const next = {};
  for (const r of res.listings) {
    if (r.status === 'removed') continue;
    const m = fromServerListing(r);
    if (m.key) next[m.key] = m;
  }
  state.serverListings = next;
  return true;
}

function withinRange(iso, range) {
  if (!iso) return false;
  if (range === 'all') return true;
  const days = range === '7' ? 7 : range === '90' ? 90 : 30;
  return (Date.now() - new Date(iso).getTime()) <= days * 864e5;
}

// All figures below come from our own publish log + manual "Mark sold" events — no FB
// scraping. Views/leads stay a locked placeholder until the FB sync lands. Everything is
// scoped to the selected range so the hero, tiles and platform rows all tell one story.
function computeStats(range) {
  const all = unifiedListings(); // unique cars across ALL platforms (a car on FB+CL counts once)
  // Sold-by-dealership and delisted cars drop out of Active + active value (they've left inventory);
  // they're tallied only in the yellow "Sold by dealership" card, not the user's personal stats.
  const active = all.filter((l) => DO.isActiveLive(l));
  const soldAll = all.filter((l) => l.status === 'sold' && !DO.hasOutcome(l));
  const soldInRange = soldAll.filter((l) => withinRange(l.soldAt, range));
  const listedInRange = all.filter((l) => withinRange(l.listedAt, range)).length;
  const gross = soldInRange.reduce((sum, l) => sum + (Number(l.soldPrice || l.price) || 0), 0);
  const activeValue = active.reduce((sum, l) => sum + (Number(l.price) || 0), 0);
  const spans = soldInRange
    .filter((l) => l.soldAt && l.listedAt)
    .map((l) => (new Date(l.soldAt) - new Date(l.listedAt)) / 864e5);
  const avgDays = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
  // Same-length window immediately before this one, for the hero delta (n/a on "all").
  let prevSoldCount = null;
  if (range !== 'all') {
    const days = range === '7' ? 7 : range === '90' ? 90 : 30;
    prevSoldCount = soldAll.filter((l) => {
      if (!l.soldAt) return false;
      const age = (Date.now() - new Date(l.soldAt).getTime()) / 864e5;
      return age > days && age <= 2 * days;
    }).length;
  }
  return { activeCount: active.length, activeValue, listedInRange, soldCount: soldInRange.length, gross, avgDays, prevSoldCount };
}

// Listings created + sold per month, last 6 months.
function monthlyActivity() {
  const now = new Date();
  const buckets = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleString('en-US', { month: 'short' }), listed: 0, sold: 0 });
  }
  const bucketFor = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return buckets.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
  };
  for (const l of unifiedListings()) {
    const lb = bucketFor(l.listedAt);
    if (lb) lb.listed += 1;
    if (l.status === 'sold') {
      const sb = bucketFor(l.soldAt);
      if (sb) sb.sold += 1;
    }
  }
  return buckets;
}

// $12,340 under 100k, $142k above — tile numbers must not wrap.
function fmtMoney(v) {
  return v >= 100000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v).toLocaleString('en-US')}`;
}

function renderStats() {
  const range = ui.statsRange ? ui.statsRange.value : '30';
  const s = computeStats(range);
  if (ui.stActive) ui.stActive.textContent = String(s.activeCount);
  if (ui.stSold) ui.stSold.textContent = String(s.soldCount);
  if (ui.stGross) ui.stGross.textContent = '$' + s.gross.toLocaleString('en-US');
  if (ui.stDays) ui.stDays.textContent = s.avgDays == null ? '—' : String(s.avgDays);
  if (ui.stHeroRange) ui.stHeroRange.textContent = rangeShort(range);
  if (ui.stListed) ui.stListed.textContent = String(s.listedInRange);
  if (ui.stListedSub) ui.stListedSub.textContent = rangeShort(range);
  if (ui.stValue) ui.stValue.textContent = fmtMoney(s.activeValue);
  if (ui.stDelta) {
    const show = s.prevSoldCount != null && (s.soldCount > 0 || s.prevSoldCount > 0);
    ui.stDelta.hidden = !show;
    if (show) {
      const diff = s.soldCount - s.prevSoldCount;
      ui.stDelta.textContent = diff > 0 ? `▲ ${diff} vs prev` : diff < 0 ? `▼ ${Math.abs(diff)} vs prev` : '= prev period';
    }
  }
  renderTrend();
  renderPlatforms(range);
  renderDealerCard();
  renderListingList();
  updateNeedsActionDot();
}

// Yellow "Sold by dealership" card: FB / Craigslist / Delisted counts. Hidden until there's at
// least one, so users with none see a clean stats page.
function renderDealerCard() {
  if (!ui.dealerCard) return;
  const c = DO.dealerCounts(unifiedListings());
  ui.dealerCard.hidden = c.total === 0;
  if (ui.dealerFb) ui.dealerFb.textContent = String(c.fb);
  if (ui.dealerCl) ui.dealerCl.textContent = String(c.craigslist);
  if (ui.dealerDe) ui.dealerDe.textContent = String(c.delisted);
}

// Red-orange dot on the Stats button whenever any car needs the user's attention (confirmed gone
// from the dealership, not yet classified, not personally sold). Clears when none remain.
function updateNeedsActionDot() {
  if (!ui.statsDot) return;
  const n = DO.needsActionCount(unifiedListings());
  ui.statsDot.hidden = n === 0;
}

function renderTrend() {
  if (!ui.stTrend) return;
  const buckets = monthlyActivity();
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.listed, b.sold)));
  ui.stTrend.innerHTML = buckets.map((b) => {
    const hL = Math.round((b.listed / max) * 74);
    const hS = Math.round((b.sold / max) * 74);
    return `<div class="trend-col" title="${b.listed} listed · ${b.sold} sold">`
      + `<span class="trend-val">${b.listed}</span>`
      + `<div class="trend-duo"><div class="trend-bar" style="height:${hL}px"></div>`
      + `<div class="trend-bar sold" style="height:${hS}px"></div></div>`
      + `<span class="trend-label">${b.label}</span></div>`;
  }).join('');
}

function renderPlatforms(range) {
  if (!ui.stPlatforms) return;
  const all = unifiedListings();
  // Per platform: "live" = cars listed there and not sold; "sold" = cars whose sale was credited
  // to that platform (soldPlatform attribution). A car sold via FB isn't "live" on CL anymore,
  // and its sale counts only under FB.
  const count = (platform) => {
    let live = 0; let sold = 0;
    for (const l of all) {
      if (!l.platforms.has(platform)) continue;
      if (l.status === 'sold') {
        if (l.soldPlatform === platform && withinRange(l.soldAt, range)) sold += 1;
      } else live += 1;
    }
    return { live, sold };
  };
  const fb = count('fb');
  const cl = count('craigslist');
  const ou = count('offerup');
  ui.stPlatforms.innerHTML = [
    platformRow('FB Marketplace', fb.live, fb.sold, range),
    (cl.live || cl.sold) ? platformRow('Craigslist', cl.live, cl.sold, range) : platformSoon('Craigslist'),
    (ou.live || ou.sold) ? platformRow('OfferUp', ou.live, ou.sold, range) : platformSoon('OfferUp'),
  ].join('');
}

function platformRow(name, live, sold, range) {
  const total = Math.max(1, live + sold);
  const pct = Math.round((live / total) * 100);
  return `<div class="platform-row"><div class="platform-top"><span class="platform-name">${esc(name)}</span>`
    + `<span class="platform-stat">${sold} sold ${rangeShort(range)} · ${live} live</span></div>`
    + `<div class="platform-bar"><div class="platform-fill" style="width:${pct}%"></div></div></div>`;
}

function platformSoon(name) {
  return `<div class="platform-row is-soon"><div class="platform-top"><span class="platform-name">${esc(name)}</span>`
    + `<span class="platform-stat">soon</span></div>`
    + `<div class="platform-bar"><div class="platform-fill" style="width:0%"></div></div></div>`;
}

// One unique row per car, merging the FB/server listings with the per-platform ezlistListedVins
// slots, so each car appears once and carries a badge for every marketplace it's published on.
function unifiedListings() {
  const rows = {};
  for (const l of listingsArray()) {
    // Seed platform presence + View-listing URLs from the server's per-platform rows when
    // available; fall back to the record's single legacy platform field.
    const row = { ...l, platforms: new Set(), urls: {} };
    const serverPlats = Array.isArray(l.platforms) ? l.platforms.filter((p) => p && p.platform && p.status !== 'removed') : [];
    for (const p of serverPlats) {
      row.platforms.add(p.platform);
      if (p.url) row.urls[p.platform] = p.url;
    }
    if (!row.platforms.size) row.platforms.add(l.platform || 'fb');
    rows[l.key] = row;
  }
  for (const [key, entry] of Object.entries(state.listed || {})) {
    const plats = listedPlatforms(entry); // { fb?:{...url}, craigslist?:{...meta,url} }
    let row = rows[key];
    if (!row) {
      row = { key, vin: key.length === 17 ? key : undefined, status: 'active', platforms: new Set(), urls: {} };
      rows[key] = row;
    }
    for (const [p, meta] of Object.entries(plats)) {
      row.platforms.add(p);
      if (meta && meta.url) row.urls[p] = meta.url; // "View listing" target for this platform
      // Backfill display fields from a slot when the FB record didn't provide them (CL-only cars).
      if (!row.listedAt && meta && meta.listedAt) row.listedAt = meta.listedAt;
      if (!row.title && meta && meta.title) row.title = meta.title;
      if (row.price == null && meta && meta.price != null) row.price = meta.price;
      if (!row.vin && meta && meta.vin) row.vin = meta.vin;
      if (!row.year && meta && meta.year) { row.year = meta.year; row.make = meta.make; row.model = meta.model; }
    }
  }
  return Object.values(rows).sort((a, b) => new Date(b.listedAt || 0) - new Date(a.listedAt || 0));
}

function renderListingList() {
  if (!ui.stListings) return;
  const all = unifiedListings();
  if (!all.length) {
    ui.stListings.innerHTML = '<div class="listing-empty">No listings tracked yet. Cars you publish with CarXprt show up here.</div>';
    return;
  }
  const dayCount = (from, to) => Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5));
  ui.stListings.innerHTML = DO.sortForList(all).map((l) => {
    const title = esc(l.title || [l.year, l.make, l.model].filter(Boolean).join(' ') || 'Vehicle');
    const vin = l.vin || (l.key && l.key.length === 17 ? l.key : '');
    const sold = l.status === 'sold';
    const outcome = DO.outcomeOf(l);          // dealership outcome: 'fb' | 'craigslist' | 'delisted' | null
    const needs = DO.needsAction(l);          // gone from the dealership, not yet classified
    const price = l.price || l.soldPrice ? '$' + Number((sold && l.soldPrice) || l.price).toLocaleString('en-US') : '';

    // Status pill: needs-action wins, then a dealership-outcome badge, then the normal Live/Sold.
    let pill;
    if (needs) pill = `<button class="needs-pill" data-action="needs" data-key="${esc(l.key)}">Needs action</button>`;
    else if (outcome) {
      const meta = DO.OUTCOME_META[outcome];
      pill = `<span class="lst-badge ${outcome === 'delisted' ? 'delisted' : 'dealer'}">${esc(meta.badge)}</span>`;
    } else pill = sold ? '<span class="lst-pill sold">Sold</span>' : '<span class="lst-pill live">Live</span>';

    const days = sold
      ? (l.soldAt && l.listedAt ? `sold in ${dayCount(l.listedAt, l.soldAt)}d` : '')
      : (l.listedAt ? `live ${dayCount(l.listedAt, Date.now())}d` : '');
    const badges = [...(l.platforms || [])].map(platformBadgeHtml).join('');
    const row3 = [price, pill, (!needs && !outcome && days) ? `<span class="lst-days">${days}</span>` : '', badges].filter(Boolean).join(' · ');
    const hasUrl = Object.keys(l.urls || {}).length > 0;

    // The personal "Mark sold" button is hidden once the dealership flow owns the row (needs-action
    // or already classified) — the dealership outcome supersedes the personal sale toggle there.
    const soldBtn = (needs || outcome) ? '' : `<button class="lst-sold-btn${sold ? ' undo' : ''}" data-key="${esc(l.key)}">${sold ? 'Undo' : 'Mark sold'}</button>`;
    return `<div class="listing-row${needs ? ' needs' : ''}"><div class="listing-main">`
      + `<div class="listing-title">${title}</div>`
      + (vin ? `<div class="listing-vin"><span class="vin-label">VIN#</span> ${esc(vin)}</div>` : '')
      + `<div class="listing-sub">${row3}</div>`
      + `</div><div class="listing-actions">`
      + soldBtn
      + `<button class="lst-view-btn" data-key="${esc(l.key)}"${hasUrl ? '' : ' disabled title="No saved link yet — publish to capture it"'}>View listing</button>`
      + `</div></div>`;
  }).join('');
}

// Manual sold signal — the reliable MVP source of truth for sale outcomes. `platform` records
// WHICH marketplace the sale came through (attribution); the car itself is sold everywhere.
function markSold(key, platform) {
  let l = state.listings[key];
  if (!l) {
    // Server-only listing (synced from another device) — materialise a local record so the
    // change persists locally and syncs back.
    const s = state.serverListings[key];
    if (s) {
      l = { ...s };
    } else {
      // A car published only on a non-FB platform (e.g. Craigslist) — not in the FB/server
      // listings, so build a record from its per-platform slot metadata.
      const plats = listedPlatforms(state.listed[key]);
      const platform = Object.keys(plats)[0];
      const meta = platform ? plats[platform] : null;
      if (!meta) return;
      l = {
        key, platform, status: 'active', listedAt: meta.listedAt,
        vin: meta.vin || (key.length === 17 ? key : undefined),
        title: meta.title, year: meta.year, make: meta.make, model: meta.model, price: meta.price,
      };
    }
    state.listings[key] = l;
  }
  let type;
  if (l.status === 'sold') {
    l.status = 'active'; delete l.soldAt; delete l.soldPrice; delete l.soldPlatform; type = 'marked_sold_undo';
  } else {
    l.status = 'sold'; l.soldAt = new Date().toISOString(); l.soldPrice = l.price;
    l.soldPlatform = platform || l.platform || 'fb'; // which marketplace the sale is credited to
    type = 'marked_sold';
  }
  chrome.storage.local.set({ ezlistListings: state.listings }); // triggers background auto-sync
  chrome.runtime.sendMessage({
    type: 'EZLIST_ENQUEUE_EVENT',
    event: { type, clientKey: key, occurredAt: new Date().toISOString(), data: type === 'marked_sold' ? { soldPrice: l.soldPrice, soldPlatform: l.soldPlatform } : null }
  }).catch(() => {});
  renderStats();
}

// Open a saved listing URL in a new tab (side-panel context).
function openListingUrl(url) {
  if (!url) return;
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url }).catch(() => window.open(url, '_blank'));
  else window.open(url, '_blank');
}

// ---- Part 2: dealership inventory outcome ----

// Ensure a local listing record exists for `key` (materialising a server-only or slot-only car),
// mirroring markSold's lookup so the outcome persists locally and syncs back.
function ensureLocalListing(key) {
  let l = state.listings[key];
  if (l) return l;
  const s = state.serverListings[key];
  if (s) { l = { ...s }; }
  else {
    const plats = listedPlatforms(state.listed[key]);
    const platform = Object.keys(plats)[0];
    const meta = platform ? plats[platform] : null;
    if (!meta) return null;
    l = {
      key, platform, status: 'active', listedAt: meta.listedAt,
      vin: meta.vin || (key.length === 17 ? key : undefined),
      title: meta.title, year: meta.year, make: meta.make, model: meta.model, price: meta.price
    };
  }
  state.listings[key] = l;
  return l;
}

// Record the user's classification of a removed-from-dealership car. SEPARATE from markSold: it does
// not touch the personal sale status — it only tags the car as a dealership outcome (fb/craigslist/
// delisted), which the stats layer excludes from Active and tallies in the yellow card.
function setDealerOutcome(key, outcome) {
  if (!DO.isOutcome(outcome)) return;
  const l = ensureLocalListing(key);
  if (!l) return;
  l.dealerOutcome = outcome;
  l.dealerOutcomeAt = new Date().toISOString();
  l.inventoryGone = true; // it left the dealership; keep the flag (needsAction is now false)
  chrome.storage.local.set({ ezlistListings: state.listings }); // triggers background auto-sync
  chrome.runtime.sendMessage({
    type: 'EZLIST_ENQUEUE_EVENT',
    event: { type: 'dealer_outcome', clientKey: key, occurredAt: l.dealerOutcomeAt, data: { outcome } }
  }).catch(() => {});
  renderStats();
}

// The select-then-Submit popup. A choice only highlights; nothing commits until Submit — this is the
// guard against a mis-click retiring the wrong car.
function openInventoryActionPopup(key) {
  const row = unifiedListings().find((r) => r.key === key);
  if (!row) return;
  document.getElementById('inv-modal-back')?.remove();
  const title = esc(row.title || [row.year, row.make, row.model].filter(Boolean).join(' ') || 'This vehicle');

  const back = document.createElement('div');
  back.id = 'inv-modal-back';
  back.className = 'inv-modal-back';
  const optHtml = DO.OUTCOMES.map((o) => {
    const meta = DO.OUTCOME_META[o];
    const info = o === 'delisted'
      ? `<span class="info-ico" title="Removed from the dealership for any reason other than a sale — it is NOT counted as a sale."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>`
      : '';
    return `<button type="button" class="inv-opt" data-outcome="${o}"><span class="inv-opt-radio"></span>`
      + `<span class="inv-opt-label">${esc(meta.label)}</span>${info}</button>`;
  }).join('');
  back.innerHTML = `<div class="inv-modal" role="dialog" aria-modal="true">`
    + `<div class="inv-modal-title">Removed from your dealership</div>`
    + `<div class="inv-modal-sub">${title} is no longer on your dealership's site.</div>`
    + `<div class="inv-opts">${optHtml}</div>`
    + `<div class="inv-modal-actions">`
    + `<button type="button" class="inv-btn" data-act="cancel">Cancel</button>`
    + `<button type="button" class="inv-btn primary" data-act="submit" disabled>Submit</button>`
    + `</div></div>`;
  document.body.appendChild(back);

  let selected = null;
  const submitBtn = back.querySelector('[data-act="submit"]');
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  back.addEventListener('click', (e) => {
    if (e.target === back) { close(); return; } // click outside the card
    const opt = e.target.closest('.inv-opt');
    if (opt) {
      // Clicking the (i) info icon must not select the option.
      if (e.target.closest('.info-ico')) return;
      selected = opt.dataset.outcome;
      back.querySelectorAll('.inv-opt').forEach((el) => el.classList.toggle('sel', el === opt));
      submitBtn.disabled = false;
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') { close(); return; }
    if (act === 'submit' && selected) { setDealerOutcome(key, selected); close(); }
  });
}

// ---- DEV: fabricate the "removed from dealership" signal for a demo, until the backend supplies it ----
// From the side-panel devtools console:  cxDevMarkGone()            → flags the newest live car
//                                        cxDevMarkGone('<VIN/key>')  → flags a specific car
//                                        cxDevClearOutcomes()        → clears all Part-2 flags
// It writes the same fields the backend will (inventoryGone), so the whole flow — dot → pill →
// popup → badge → yellow card — runs end-to-end with real tracked listings. No effect in normal use.
function cxDevMarkGone(key) {
  const rows = unifiedListings().filter((r) => DO.isActiveLive(r));
  const target = key ? rows.find((r) => r.key === key || r.vin === key) : DO.sortForList(rows)[0];
  if (!target) { console.warn('[cx-dev] no live listing to flag'); return; }
  const l = ensureLocalListing(target.key);
  if (!l) { console.warn('[cx-dev] could not materialise listing', target.key); return; }
  l.inventoryGone = true;
  delete l.dealerOutcome; delete l.dealerOutcomeAt;
  chrome.storage.local.set({ ezlistListings: state.listings });
  renderStats();
  console.log('[cx-dev] flagged as removed from dealership:', target.title || target.key);
}
function cxDevClearOutcomes() {
  for (const l of Object.values(state.listings)) { delete l.inventoryGone; delete l.dealerOutcome; delete l.dealerOutcomeAt; }
  chrome.storage.local.set({ ezlistListings: state.listings });
  renderStats();
  console.log('[cx-dev] cleared all inventory-outcome flags');
}
if (typeof window !== 'undefined') { window.cxDevMarkGone = cxDevMarkGone; window.cxDevClearOutcomes = cxDevClearOutcomes; }

// Lightweight popover anchored to a button — used to pick a platform (for multi-platform cars)
// when marking sold or choosing which listing to view. Closes on outside click / Escape.
function showListMenu(anchor, items) {
  document.getElementById('lst-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'lst-menu';
  menu.className = 'lst-menu';
  menu.innerHTML = items.map((it, i) => `<button type="button" class="lst-menu-item" data-i="${i}">${esc(it.label)}</button>`).join('');
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.right - 168)}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.lst-menu-item');
    if (!b) return;
    const it = items[parseInt(b.dataset.i, 10)];
    menu.remove();
    if (it && it.onClick) it.onClick();
  });
  const close = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  document.addEventListener('keydown', function esckey(e) { if (e.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', esckey); } });
}

// "Mark sold" click: single-platform → mark directly (attributed to that platform); multi-platform
// (and not already sold) → ask which marketplace the sale came from.
function onSoldClick(btn) {
  const key = btn.dataset.key;
  const row = unifiedListings().find((r) => r.key === key);
  if (!row) return;
  if (row.status === 'sold') { markSold(key, null); return; } // undo
  const plats = [...row.platforms];
  if (plats.length <= 1) { markSold(key, plats[0] || 'fb'); return; }
  showListMenu(btn, plats.map((p) => ({ label: `Sold on ${platformLabel(p)}`, onClick: () => markSold(key, p) })));
}

// "View listing" click: open the saved URL; if the car is on several platforms, offer a chooser.
function onViewClick(btn) {
  const key = btn.dataset.key;
  const row = unifiedListings().find((r) => r.key === key);
  if (!row) return;
  const entries = Object.entries(row.urls || {});
  if (!entries.length) return;
  if (entries.length === 1) { openListingUrl(entries[0][1]); return; }
  showListMenu(btn, entries.map(([p, url]) => ({ label: `View on ${platformLabel(p)}`, onClick: () => openListingUrl(url) })));
}

function rangeShort(v) {
  if (v === '7') return 'last 7 days';
  if (v === '90') return 'last 90 days';
  if (v === 'all') return 'all time';
  return 'last 30 days';
}

function rangeLabel(v) {
  if (v === '7') return 'Last 7 days';
  if (v === '90') return 'Last 90 days';
  if (v === 'all') return 'All time';
  return 'Last 30 days';
}

// ---------- events ----------
function wireEvents() {
  enhanceSelects(); // replace native <select>s with the styled custom dropdown
  ui.statsBtn.addEventListener('click', () => showView('stats'));
  ui.statsBack.addEventListener('click', () => showView('lister'));
  ui.statsRange.addEventListener('change', () => { ui.statsRangeLabel.textContent = rangeLabel(ui.statsRange.value); renderStats(); });
  ui.stListings.addEventListener('click', (e) => {
    const needsBtn = e.target.closest('.needs-pill');
    if (needsBtn && needsBtn.dataset.key) { openInventoryActionPopup(needsBtn.dataset.key); return; }
    const soldBtn = e.target.closest('.lst-sold-btn');
    if (soldBtn && soldBtn.dataset.key) { onSoldClick(soldBtn); return; }
    const viewBtn = e.target.closest('.lst-view-btn');
    if (viewBtn && viewBtn.dataset.key && !viewBtn.disabled) onViewClick(viewBtn);
  });
  ui.openfb.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_PLATFORM', platform: ui.platform.value || 'fb' }));
  ui.platform.addEventListener('change', () => {
    savePref('platform', ui.platform.value, false);
    updateOpenButton(); // footer button names the selected marketplace
    if (state.draft) ui.vehListed.hidden = !isListed(state.draft); // badge follows the selected marketplace
  });
  ui.openInv.addEventListener('click', () => {
    const url = dealerInventoryUrl(state.auth);
    if (url) chrome.tabs.create({ url }).catch(() => window.open(url, '_blank'));
    else setStatus('Connect your dealership to open your inventory.', true);
  });
  ui.fill.addEventListener('click', onFill);
  ui.aiDraft.addEventListener('click', onAiDraft);
  ui.translate.addEventListener('click', onTranslate);
  ui.lang.addEventListener('change', () => savePref('lang', ui.lang.value, false));

  ui.desc.addEventListener('input', () => { state.userEdited = true; updateCharCount(); });

  ui.tAi.addEventListener('click', () => {
    savePref('aiDesc', !state.prefs.aiDesc, false);
    if (state.prefs.aiDesc && state.draft) runAiDraft({ auto: true });
  });
  ui.emoji.addEventListener('change', () => savePref('emoji', ui.emoji.value, true));
  ui.category.addEventListener('change', () => savePref('category', ui.category.value, false));
  ui.unitMi.addEventListener('click', () => switchUnit('mi'));
  ui.unitKm.addEventListener('click', () => switchUnit('km'));
  ui.tMileage.addEventListener('click', () => savePref('mileage', !state.prefs.mileage, true));

  // auth + gate
  ui.gatePrimary.addEventListener('click', () => gateAction(ui.gatePrimary.dataset.action, ui.gatePrimary));
  ui.gateSecondary.addEventListener('click', () => gateAction(ui.gateSecondary.dataset.action, ui.gateSecondary));
  ui.dealerRequestToggle.addEventListener('click', () => { state.dealerRequestOpen = true; renderGate(); });
  ui.dealerRequestCancel.addEventListener('click', () => { state.dealerRequestOpen = false; renderGate(); });
  ui.dealerSwitchToggle.addEventListener('click', () => {
    state.dealerUrlOpen = true;
    state.detectedDealer = null; // user rejected the suggestion — clear it
    renderGate();
    ui.dealerConnectUrl.focus();
  });
  // Subscribe/expired screen → re-enter the connect step to pick a different dealership.
  // Skip the auto-detect suggestion (it would just re-suggest the current dealer) and open
  // the website field directly.
  ui.gateChangeDealer.addEventListener('click', () => {
    state.changingDealer = true;
    state.detectedDealer = null;
    state.dealerUrlOpen = true;
    state.autoDealerConnectTried = true;
    renderGate();
    ui.dealerConnectUrl.focus();
  });
  ui.dealerKeep.addEventListener('click', () => {
    state.changingDealer = false;
    state.detectedDealer = null;
    state.dealerUrlOpen = false;
    renderGate(); // back to the subscribe/renew screen with the current dealership
  });
  ui.dealerConnectDetect.addEventListener('click', () => {
    const v = ui.dealerConnectUrl.value.trim();
    if (v) detectDealership({ url: v });
  });
  ui.dealerConnectUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ui.dealerConnectDetect.click(); }
  });
  ui.dealerRequest.addEventListener('submit', submitDealerRequest);
  ui.gateSignout.addEventListener('click', doSignOut);
  ui.accountBtn.addEventListener('click', (e) => { e.stopPropagation(); ui.accountMenu.hidden = !ui.accountMenu.hidden; });
  ui.acctSignout.addEventListener('click', doSignOut);
  ui.acctBilling.addEventListener('click', openBilling);
  document.addEventListener('click', (e) => {
    if (!ui.accountMenu.hidden && !ui.accountMenu.contains(e.target) && !ui.accountBtn.contains(e.target)) ui.accountMenu.hidden = true;
  });
}

// Update a preference; `recompose` regenerates the description (overwriting manual edits).
// The mi/km switch converts the distances IN PLACE in whatever text is in the box — it never
// regenerates the template (that resurrected cleared text and clobbered custom edits). Handles
// user-typed units too (km/kms/kilometers, mi/ml/mls/mile/miles); everything else stays as typed.
function switchUnit(unit) {
  if (state.prefs.unit === unit) return;
  savePref('unit', unit, false); // pref + seg highlight + vehicle summary; NO recompose
  ui.desc.value = globalThis.CarxpertCore.convertDistances(ui.desc.value, unit).slice(0, 1000);
  updateCharCount();
}

function savePref(key, value, recompose) {
  state.prefs[key] = value;
  chrome.storage.local.set({ ezlistPrefs: state.prefs });
  applyPrefsToUI();
  if (key === 'unit') renderVehicle(); // mileage display in the summary
  if (recompose) recomposeDesc();
}

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes.ezlistMe || changes.ezlistAuthToken) refreshAuth();
  if (changes.ezlistListedVins) {
    state.listed = changes.ezlistListedVins.newValue || {};
    if (state.draft) ui.vehListed.hidden = !isListed(state.draft);
  }
  if (changes.ezlistListings) {
    state.listings = changes.ezlistListings.newValue || {};
    updateNeedsActionDot(); // keep the attention dot live even when the stats view is closed
    if (ui.viewStats && !ui.viewStats.hidden) renderStats();
  }
  if (changes.ezlistDraft) {
    const next = changes.ezlistDraft.newValue || null;
    const changedCar = keyForDraft(next) !== keyForDraft(state.draft);
    state.draft = next;
    renderVehicle();
    if (changedCar) {
      recomposeDesc(); // new car → fresh template description; keep edits if same car
      // Auto A.I.: template shows instantly, then the AI draft replaces it when ready.
      if (state.prefs.aiDesc && state.draft) runAiDraft({ auto: true });
    }
  }
}

// ---------- fill hand-off ----------
async function onFill() {
  if (!state.draft || state.filling) return;
  // Entitlement gate (belt-and-braces: the gate overlay normally covers Fill already).
  const gate = await chrome.runtime.sendMessage({ type: 'EZLIST_CAN_LIST' }).catch(() => null);
  if (!gate || !gate.ok) {
    // wrong_dealership isn't a gate step (the user IS entitled) — refreshing the auth gate
    // would show nothing. Say what's wrong with THIS car instead.
    if (gate && gate.reason === 'wrong_dealership') {
      setStatus("This car isn't from your linked dealership — CarXprt only lists your own inventory.", true);
    } else {
      await refreshAuth({ refresh: true });
    }
    return;
  }
  state.filling = true;
  ui.fill.disabled = true;
  const original = ui.fill.textContent;
  const platform = ui.platform.value || 'fb';
  const name = platformLabel(platform);
  ui.fill.innerHTML = '<span class="btn-spin" aria-hidden="true"></span>Filling…'; // static markup
  setStatus('Saving listing…');
  try {
    const fillDraft = { ...state.draft, description: ui.desc.value };
    if (!state.prefs.mileage) delete fillDraft.mileage;            // "Add mileage" off → leave blank
    if (state.prefs.category) fillDraft.bodyType = state.prefs.category; // category override → mapped by the filler
    const key = keyForDraft(fillDraft);
    await chrome.runtime.sendMessage({ type: 'EZLIST_SAVE_DRAFT', draft: fillDraft, autoFill: true, platform, key });
    // Facebook deep-links straight to the create form so it fills immediately. Craigslist's
    // post flow is multi-page (sign in → area → category), so we open it and the vehicle form
    // auto-fills once the user reaches it (driven by the platform-tagged autoFill flag).
    setStatus(platform === 'craigslist'
      ? 'Opening Craigslist — sign in, pick your area & category, and the vehicle form fills automatically.'
      : `Opening ${name} & filling…`);
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_FILL_NOW', platform, key });
    if (!res || !res.ok) throw new Error((res && res.error) || `Could not reach the ${name} form.`);
    // The content script streams per-field progress and the final result back via
    // EZLIST_FILL_STATUS, so we don't claim completion prematurely here.
  } catch (e) {
    setStatus(e.message || 'Something went wrong.', true);
  } finally {
    state.filling = false;
    ui.fill.disabled = false;
    ui.fill.textContent = original;
  }
}

// ---------- AI (routed through our backend) ----------
async function onAiDraft() { return runAiDraft(); }

// One drafting path for the button and the Auto A.I. toggle. Auto mode fails soft: the
// template description is already in the box, so an unreachable backend costs nothing.
async function runAiDraft({ auto = false } = {}) {
  if (!state.draft) { if (!auto) setStatus('Pick a car first.', true); return; }
  const key = keyForDraft(state.draft);
  ui.aiDraft.disabled = true;
  setStatus(auto ? 'Auto-drafting with A.I.…' : 'Drafting with A.I.…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_AI_DESCRIBE', vehicle: state.draft, options: {} });
    if (!res || !res.ok) throw new Error((res && res.error) || 'A.I. draft failed.');
    if (keyForDraft(state.draft) !== key) return; // user switched cars mid-draft — drop it
    ui.desc.value = (res.description || '').slice(0, 1000);
    state.userEdited = true;
    updateCharCount();
    setStatus('A.I. draft ready — edit if you like, then Fill.');
  } catch (e) {
    setStatus(auto ? 'A.I. unreachable — using the template description.' : e.message, !auto);
  } finally {
    ui.aiDraft.disabled = false;
  }
}

async function onTranslate() {
  const text = ui.desc.value.trim();
  if (!text) { setStatus('Nothing to translate yet.', true); return; }
  const langName = ui.lang.options[ui.lang.selectedIndex].text;
  ui.translate.disabled = true;
  setStatus(`Translating to ${langName}…`);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_AI_TRANSLATE', text, targetLang: ui.lang.value });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Translation failed.');
    ui.desc.value = (res.translated || '').slice(0, 1000);
    state.userEdited = true;
    updateCharCount();
    setStatus('Translated — review and Fill.');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    ui.translate.disabled = false;
  }
}

// ---------- auth + entitlement gate (C3) ----------
// One gate screen per /api/me reason, presented as a guided 3-step journey
// (Sign in · Connect · Subscribe) with orchestrated transitions. The background worker owns
// auth/entitlement; the panel just renders the right step and fires the action.
// Static internal SVG markup (no user input) — innerHTML is safe here.
const GATE_SVG = {
  user: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  store: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.7-5.2A1 1 0 0 1 5.7 3h12.6a1 1 0 0 1 1 .8L21 9"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21v-6h6v6"/><path d="M2.5 9h19"/></svg>',
  card: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
  alert: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};
const GATE = {
  signed_out: { step: 1, benefits: true, title: 'Welcome to CarXprt', msg: 'Sign in with Google to start listing your dealership’s inventory — Facebook Marketplace, Craigslist, and more.', primary: 'Sign in with Google', action: 'signin' },
  no_dealership: { svg: GATE_SVG.store, step: 2, title: 'Connect your dealership', msg: 'Open your dealership’s inventory page in a tab and detect it here — or enter your dealership’s website. You confirm before anything is connected.', primary: 'Detect dealership', action: 'detectDealer' },
  no_subscription: { svg: GATE_SVG.card, step: 3, title: 'Start your subscription', msg: 'Unlimited one-click listings, AI descriptions & translations, and automatic sold tracking.', primary: 'Subscribe', action: 'checkout', price: true },
  expired: { svg: GATE_SVG.card, title: 'Renew your subscription', msg: 'Your subscription has ended. Renew to keep listing your inventory to your marketplaces.', primary: 'Renew', action: 'checkout', price: true },
  unknown: { svg: GATE_SVG.alert, title: 'Couldn’t load your account', msg: 'We couldn’t reach the server. Check your connection and try again.', primary: 'Retry', action: 'recheck' }
};
// Screens that count as "the user is inside onboarding" — finishing from one of these earns
// the one-time welcome beat before the app appears.
const ONBOARDING_SCREENS = ['signed_out', 'no_dealership', 'no_subscription', 'expired', 'checkout_pending', 'linkflash'];

async function loadBillingPlan() {
  const res = await chrome.runtime.sendMessage({ type: 'EZLIST_BILLING_PLAN' }).catch(() => null);
  if (res && res.ok && res.plan) {
    state.plan = res.plan;
    renderPlan();
  }
}

function renderPlan() {
  if (!state.plan || !ui.gatePriceAmt || !ui.gatePricePer) return;
  const amount = Number(state.plan.amount || 0) / 100;
  const currency = String(state.plan.currency || 'usd').toUpperCase();
  ui.gatePriceAmt.textContent = amount
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
    : 'Custom';
  ui.gatePricePer.textContent = amount ? ` / ${state.plan.interval || 'month'} · cancel anytime` : '';
}

async function refreshAuth(opts) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_GET_AUTH', refresh: !!(opts && opts.refresh) });
    state.auth = (res && res.ok) ? res.auth : { signedIn: false, entitled: false, reason: 'unknown' };
  } catch {
    state.auth = { signedIn: false, entitled: false, reason: 'unknown' };
  }
  state.authResolved = true; // the boot "checking" screen can resolve now
  renderGate();
  return state.auth;
}

function gateStateKey(auth) {
  if (!auth || !auth.signedIn) return 'signed_out';
  if (auth.entitled) return null; // entitled → no gate
  if (!auth.dealership) return 'no_dealership';
  if (auth.reason === 'no_dealership') return 'no_dealership';
  if (auth.reason === 'expired') return 'expired';
  if (auth.reason === 'no_subscription') return 'no_subscription';
  return 'unknown';
}

// Which screen the gate should show right now. Pseudo-screens (checking / linkflash /
// welcome / checkout_pending) wrap the /api/me-driven GATE keys; null = entitled, no gate.
function gateScreen(auth) {
  if (!state.authResolved) return 'checking';
  if (state.linkFlash && auth.signedIn) return 'linkflash';
  const key = gateStateKey(auth);
  if (state.welcome && key === null) return 'welcome';
  // Pre-payment "change dealership": re-enter the connect step even though a dealership is
  // linked. Only possible before a live subscription (the backend enforces the same lock).
  if (state.changingDealer && (key === 'no_subscription' || key === 'expired')) return 'no_dealership';
  if (state.checkoutPending && (key === 'no_subscription' || key === 'expired')) return 'checkout_pending';
  return key;
}

// Restart the staggered enter animation — only called when the screen actually changes, so
// routine re-renders (visibilitychange, storage pings) don't re-play it.
function restartGateEnter() {
  const card = ui.gate.querySelector('.gate-card');
  if (!card) return;
  card.classList.remove('gate-enter');
  void card.offsetWidth; // reflow so removing+adding the class re-triggers the CSS animations
  card.classList.add('gate-enter');
}

function renderSteps(n) {
  // n = 1..3 highlights that step, 4 = all done (the welcome completion cue), null = hidden.
  ui.gateSteps.hidden = !n;
  if (!n) return;
  ui.gateSteps.querySelectorAll('.gstep').forEach((s) => {
    const k = Number(s.dataset.n);
    s.classList.toggle('done', k < n);
    s.classList.toggle('active', k === n);
  });
}

function renderGate() {
  const auth = state.auth || { signedIn: false };
  applyAccount(auth);
  let screen = gateScreen(auth);
  // Finished onboarding this session → one welcome beat before the app appears.
  if (!screen && ONBOARDING_SCREENS.includes(state.lastGateScreen)) {
    state.welcome = true;
    state.checkoutPending = false;
    screen = 'welcome';
  }
  const changed = screen !== state.lastGateScreen;
  state.lastGateScreen = screen;
  if (!screen) { state.changingDealer = false; ui.gate.hidden = true; return; } // entitled → mode over
  ui.gate.hidden = false;
  if (changed) restartGateEnter();

  // Reset shared elements; each screen re-shows what it needs.
  ui.gateIcon.innerHTML = '';
  ui.gateIcon.hidden = false;
  ui.gateBenefits.hidden = true;
  ui.gateDealer.hidden = true;
  ui.gateChangeDealer.hidden = true;
  ui.dealerKeep.hidden = true;
  ui.gatePrice.hidden = true;
  ui.gatePrimary.hidden = true;
  ui.gateSecondary.hidden = true;
  ui.dealerConnect.hidden = true;
  ui.gateErr.hidden = true;
  ui.gateSignout.hidden = true;
  renderSteps(null);

  if (screen === 'checking') {
    ui.gateIcon.innerHTML = '<span class="gate-spinner" aria-hidden="true"></span>';
    ui.gateTitle.textContent = 'One moment…';
    ui.gateMsg.textContent = 'Checking your account.';
    return;
  }
  if (screen === 'linkflash') { renderLinkFlash(); return; }
  if (screen === 'welcome') { renderWelcome(auth); return; }
  if (screen === 'checkout_pending') { renderCheckoutPending(); return; }

  const g = GATE[screen];
  if (screen === 'signed_out') { state.checkoutPending = false; state.welcome = false; state.changingDealer = false; }
  renderSteps(g.step || null);
  if (g.svg) ui.gateIcon.innerHTML = `<span class="gate-disc">${g.svg}</span>`;
  else ui.gateIcon.hidden = true;
  ui.gateTitle.textContent = g.title;
  ui.gateMsg.textContent = g.msg;
  ui.gateBenefits.hidden = !g.benefits;
  renderVerifiedDealer(screen, auth);
  ui.gatePrice.hidden = !g.price;
  if (g.price) renderPlan();
  ui.gatePrimary.hidden = false;
  ui.gatePrimary.textContent = g.primary;
  ui.gatePrimary.dataset.action = g.action;
  renderDealerConnect(screen, auth);
  ui.gateSignout.hidden = !auth.signedIn;
}

// The linking moment keeps its own beat (spinner → tick) before the next gate step —
// otherwise a successful auto-connect silently drops the user on the subscribe screen.
function renderLinkFlash() {
  const f = state.linkFlash;
  const name = f.name
    || (state.auth && state.auth.dealership && state.auth.dealership.name)
    || 'Dealership';
  renderSteps(2);
  ui.gateIcon.innerHTML = f.stage === 'linking'
    ? '<span class="gate-spinner" aria-hidden="true"></span>'
    : '<span class="gate-tick" aria-hidden="true">✓</span>';
  ui.gateTitle.textContent = f.stage === 'linking' ? 'Connecting your dealership…' : 'Dealership linked';
  ui.gateMsg.textContent = f.stage === 'linking' ? 'Verifying with CarXprt' : '';
  ui.gateDealer.hidden = f.stage !== 'linked';
  if (f.stage === 'linked') {
    ui.gateDealer.innerHTML = `${esc(name)}<small>Verified by CarXprt backend</small>`;
  }
}

// Stripe checkout opened in a tab — hold a "finish there" beat here instead of a stale
// subscribe screen. visibilitychange + the background checkout-watch flip it automatically.
function renderCheckoutPending() {
  renderSteps(3);
  ui.gateIcon.innerHTML = '<span class="gate-spinner" aria-hidden="true"></span>';
  ui.gateTitle.textContent = 'Finish in the checkout tab';
  ui.gateMsg.textContent = 'Complete your subscription in the Stripe tab that just opened — CarXprt unlocks here automatically.';
  ui.gatePrimary.hidden = false;
  ui.gatePrimary.textContent = 'I’ve subscribed — check again';
  ui.gatePrimary.dataset.action = 'recheck';
  ui.gateSecondary.hidden = false;
  ui.gateSecondary.textContent = 'Back';
  ui.gateSecondary.dataset.action = 'checkoutBack';
}

// One-time arrival screen when onboarding completes this session: all steps done, a clear
// pointer at the first real action. Never blocks — both buttons dismiss it.
function renderWelcome(auth) {
  renderSteps(4);
  ui.gateIcon.innerHTML = '<span class="gate-tick lg" aria-hidden="true">✓</span>';
  ui.gateTitle.textContent = 'You’re all set!';
  ui.gateMsg.textContent = 'Open your inventory and hit ⚡ List on any car — CarXprt fills the listing, you review and publish.';
  const url = dealerInventoryUrl(auth);
  ui.gatePrimary.hidden = false;
  ui.gatePrimary.textContent = url ? 'Open my inventory' : 'Start listing';
  ui.gatePrimary.dataset.action = url ? 'openInventory' : 'dismissWelcome';
  ui.gateSecondary.hidden = !url;
  if (url) { ui.gateSecondary.textContent = 'Not now'; ui.gateSecondary.dataset.action = 'dismissWelcome'; }
}

// The dealership's inventory page, from the /api/me payload (config.inventoryUrls, falling
// back to the first alias domain). Null when the payload has neither.
function dealerInventoryUrl(auth) {
  const d = auth && auth.dealership;
  if (!d) return null;
  const inv = d.config && Array.isArray(d.config.inventoryUrls) && d.config.inventoryUrls[0];
  if (inv) return inv;
  const dom = Array.isArray(d.domains) && d.domains[0];
  return dom ? `https://${dom}` : null;
}

function startLinkFlash(dealer) {
  if (state.linkFlash) return;
  state.linkFlash = { stage: 'linking', name: dealer && dealer.name };
  renderGate();
  setTimeout(() => {
    if (!state.linkFlash) return;
    state.linkFlash.stage = 'linked';
    renderGate();
    setTimeout(() => { state.linkFlash = null; renderGate(); }, 1200);
  }, 800);
}

function renderVerifiedDealer(key, auth) {
  const dealer = auth && auth.dealership;
  const show = !!(dealer && (key === 'no_subscription' || key === 'expired'));
  ui.gateDealer.hidden = !show;
  if (!show) return;
  ui.gateDealer.innerHTML = `${esc(dealer.name || 'Dealership verified')}<small>Verified by CarXprt backend</small>`;
  // Pre-payment only: the wrong dealership is fixable here. After payment this screen never
  // shows, and the backend locks the link anyway (409 dealership_locked).
  ui.gateChangeDealer.hidden = false;
}

function renderDealerConnect(key, auth) {
  const active = key === 'no_dealership';
  ui.dealerConnect.hidden = !active;
  if (!active) {
    state.dealerRequestOpen = false;
    state.autoDealerConnectTried = false;
    state.detectedDealer = null;
    state.dealerUrlOpen = false;
    return;
  }

  const pending = auth && auth.requestPending;
  if (pending) {
    const domain = pending.normalizedDomain || pending.rawInput || 'your dealership';
    ui.dealerPending.textContent = `Request received for ${domain}. We’ll review support and follow up by email.`;
    ui.dealerPending.hidden = false;
  } else {
    ui.dealerPending.hidden = true;
  }

  // A detected dealership is shown for CONFIRMATION — never auto-linked. (Auto-linking the
  // machine's last-seen dealer once bound a brand-new account to the wrong dealership.)
  if (state.detectedDealer) {
    const d = state.detectedDealer;
    const domain = (Array.isArray(d.domains) && d.domains[0]) || '';
    ui.gateDealer.hidden = false;
    ui.gateDealer.innerHTML = `${esc(d.name || 'Dealership')}<small>${domain ? `${esc(domain)} · ` : ''}detected — confirm it’s yours</small>`;
    ui.gatePrimary.textContent = `Connect ${d.name || 'dealership'}`;
    ui.gatePrimary.dataset.action = 'linkDetected';
  }

  ui.dealerUrlRow.hidden = !state.dealerUrlOpen;
  ui.dealerSwitchToggle.hidden = state.dealerUrlOpen;
  ui.dealerSwitchToggle.textContent = state.detectedDealer
    ? 'Not my dealership? Enter your website'
    : 'Enter your dealership’s website';

  // "Change dealership" mode: name the escape hatch back to the current connection, and make
  // the copy say what this step is doing.
  if (state.changingDealer && auth && auth.dealership) {
    ui.dealerKeep.hidden = false;
    ui.dealerKeep.textContent = `Keep ${auth.dealership.name || 'current dealership'}`;
    ui.gateTitle.textContent = 'Change your dealership';
    ui.gateMsg.textContent = 'Detect or enter the right dealership and confirm — your current connection stays until you confirm a new one.';
  }

  if (auth && auth.user) {
    if (ui.dealerName && !ui.dealerName.value) ui.dealerName.value = auth.user.name || '';
    if (ui.dealerEmail && !ui.dealerEmail.value) ui.dealerEmail.value = auth.user.email || '';
  }
  ui.dealerRequest.hidden = !state.dealerRequestOpen;
  ui.dealerRequestToggle.hidden = state.dealerRequestOpen;

  // Silent auto-DETECT (suggestion only — linking always waits for the user's click).
  if (!state.autoDealerConnectTried && !pending) {
    state.autoDealerConnectTried = true;
    setTimeout(() => detectDealership({ silent: true }), 50);
  }
}

function showGateError(text) {
  ui.gateErr.textContent = text || 'Something went wrong.';
  ui.gateErr.hidden = false;
}

function applyAccount(auth) {
  const signedIn = !!(auth && auth.signedIn);
  ui.accountBtn.hidden = !signedIn;
  if (!signedIn) { ui.accountMenu.hidden = true; return; }
  ui.accountEmail.textContent = (auth.user && auth.user.email) || 'Signed in';
  const periodEnd = auth.subscription && auth.subscription.periodEnd;
  ui.accountPlan.textContent = auth.entitled
    ? (periodEnd ? `Active · renews ${new Date(periodEnd).toLocaleDateString()}` : 'Active')
    : 'No active plan';
}

async function gateAction(action, btnEl) {
  ui.gateErr.hidden = true;
  // Instant local screen switches — no network, no button-state dance.
  if (action === 'dismissWelcome') { state.welcome = false; renderGate(); return; }
  if (action === 'checkoutBack') { state.checkoutPending = false; renderGate(); return; }
  if (action === 'detectDealer') { detectDealership(); return; }   // manages its own button state
  if (action === 'linkDetected') { linkDetectedDealership(); return; }
  if (action === 'openInventory') {
    const url = dealerInventoryUrl(state.auth);
    if (url) chrome.tabs.create({ url }).catch(() => window.open(url, '_blank'));
    state.welcome = false;
    renderGate();
    return;
  }
  const btn = btnEl || (action === 'refresh' ? ui.gateSecondary : ui.gatePrimary);
  const label = btn.textContent;
  btn.disabled = true;
  try {
    if (action === 'signin') {
      btn.textContent = 'Opening Google…';
      const res = await chrome.runtime.sendMessage({ type: 'EZLIST_SIGN_IN' });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Sign-in failed.');
      state.auth = res.auth; renderGate();
    } else if (action === 'checkout') {
      btn.textContent = 'Opening checkout…';
      const res = await chrome.runtime.sendMessage({ type: 'EZLIST_CHECKOUT' });
      if (!res || !res.ok) {
        const err = new Error((res && res.error) || 'Could not start checkout.');
        err.reason = res && res.reason;
        throw err;
      }
      // Checkout opened in a tab — hold the "finish in checkout" beat here; entitlement flips
      // via visibilitychange / the background checkout-watch / the manual recheck button.
      state.checkoutPending = true;
      renderGate();
    } else { // refresh | recheck | retry
      btn.textContent = 'Checking…';
      await refreshAuth({ refresh: true });
    }
  } catch (e) {
    if (action === 'checkout' && e.reason === 'no_dealership') {
      await refreshAuth({ refresh: true });
      showGateError('Connect your dealership before subscribing.');
    } else {
      showGateError(e.message || 'Something went wrong.');
    }
  } finally {
    btn.disabled = false;
    // Restore the label only if it still shows our transient text — a successful action may
    // have re-rendered the gate onto a new screen whose button text must not be clobbered.
    const transient = ['Opening Google…', 'Opening checkout…', 'Checking…'];
    if (transient.includes(btn.textContent)) btn.textContent = label;
  }
}

// Resolve a dealership (device-seen, or a user-entered URL) and show it for CONFIRMATION.
// Never links — that only happens in linkDetectedDealership after an explicit click.
async function detectDealership(opts = {}) {
  // For a user-entered site, ask for access up front (this click is the required user gesture) so
  // the background can read the live DOM to identify the platform — the only way to detect
  // bot-walled providers (Dealer.com/Cox) whose HTML the backend fetch can't reach. Declining
  // just falls back to server-side detection (fine for DealerOn).
  let canProbe = false;
  if (opts.url && !opts.silent) {
    try {
      let host = new URL(/^https?:\/\//i.test(opts.url) ? opts.url : `https://${opts.url}`).hostname.toLowerCase();
      const bare = host.replace(/^www\./, '');
      canProbe = await chrome.permissions.request({ origins: [`https://${bare}/*`, `https://www.${bare}/*`] });
    } catch { canProbe = false; }
  }
  if (!opts.silent) {
    ui.gateErr.hidden = true;
    ui.gatePrimary.disabled = true;
    ui.gatePrimary.textContent = 'Detecting…';
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_DETECT_DEALER', url: opts.url, canProbe });
    if (!res || !res.ok) {
      if (res && res.reason === 'unsupported_dealer') {
        if (res.normalizedDomain && !ui.dealerUrl.value) ui.dealerUrl.value = `https://${res.normalizedDomain}`;
        state.dealerRequestOpen = true;
        renderGate();
        showGateError(res.error || 'This dealership is not supported yet.');
        return;
      }
      if (opts.silent && res && res.reason === 'no_recent_dealer') return;
      throw new Error((res && res.error) || 'Could not detect a supported dealership.');
    }
    state.detectedDealer = res.dealership;
    state.dealerUrlOpen = false;
    state.dealerRequestOpen = false;
    renderGate(); // shows the "confirm it's yours" card; primary becomes "Connect <name>"
  } catch (e) {
    if (!opts.silent) showGateError(e.message || 'Could not detect dealership.');
  } finally {
    ui.gatePrimary.disabled = false;
    if (!state.detectedDealer && gateStateKey(state.auth) === 'no_dealership') {
      ui.gatePrimary.textContent = GATE.no_dealership.primary;
    }
  }
}

// The explicit consent moment: link the dealership the user just confirmed. The same click
// carries the Chrome host-permission request (user gesture required) so the dealer content
// scripts can be registered for the dealership's own domains — any DealerOn site, not just
// the manifest's static host.
async function linkDetectedDealership() {
  const d = state.detectedDealer;
  if (!d || !d.id) return;
  ui.gateErr.hidden = true;
  ui.gatePrimary.disabled = true;
  try {
    const origins = (Array.isArray(d.domains) ? d.domains : []).map((dom) => `https://${String(dom).toLowerCase()}/*`);
    if (origins.length) {
      let granted = false;
      try { granted = await chrome.permissions.request({ origins }); }
      catch (permErr) { throw new Error(`Couldn’t request site access: ${permErr.message}`); }
      if (!granted) {
        throw new Error(`CarXprt needs access to ${d.domains[0]} to read your inventory. Click Connect again and choose Allow.`);
      }
    }
    // Start the flash before refreshAuth repaints, so the user sees the link happen
    // instead of jumping straight to the subscribe screen.
    startLinkFlash(d);
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_LINK_DEALER', dealershipId: d.id });
    if (!res || !res.ok) {
      state.linkFlash = null;
      throw new Error((res && res.error) || 'Could not connect dealership.');
    }
    state.detectedDealer = null;
    state.changingDealer = false; // switch complete — resume the normal gate flow
    if (res.auth) state.auth = res.auth;
    await refreshAuth({ refresh: true });
  } catch (e) {
    renderGate();
    showGateError(e.message || 'Could not connect dealership.');
  } finally {
    ui.gatePrimary.disabled = false;
  }
}

async function submitDealerRequest(e) {
  e.preventDefault();
  ui.gateErr.hidden = true;
  ui.dealerRequestSubmit.disabled = true;
  const label = ui.dealerRequestSubmit.textContent;
  ui.dealerRequestSubmit.textContent = 'Sending…';
  try {
    const payload = {
      url: ui.dealerUrl.value.trim(),
      contactName: ui.dealerName.value.trim(),
      contactEmail: ui.dealerEmail.value.trim(),
      contactPhone: ui.dealerPhone.value.trim(),
      notes: ui.dealerNotes.value.trim()
    };
    if (!payload.url || !payload.contactName || !payload.contactEmail) {
      throw new Error('Enter the dealership URL, your name, and email.');
    }
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_REQUEST_DEALER', payload });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not send request.');
    state.dealerRequestOpen = false;
    state.auth = res.auth || await refreshAuth({ refresh: true });
    await refreshAuth({ refresh: true });
  } catch (err) {
    showGateError(err.message || 'Could not send request.');
  } finally {
    ui.dealerRequestSubmit.disabled = false;
    ui.dealerRequestSubmit.textContent = label;
  }
}

async function doSignOut() {
  await chrome.runtime.sendMessage({ type: 'EZLIST_SIGN_OUT' }).catch(() => {});
  ui.accountMenu.hidden = true;
  await refreshAuth();
}

async function openBilling() {
  ui.accountMenu.hidden = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_PORTAL' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not open billing.');
  } catch (e) { setStatus(e.message, true); }
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
