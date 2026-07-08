'use strict';

// Carxpert side panel — control surface. Shows the current vehicle, lets the user
// tune the listing (description, emoji, unit, toggles), then hands off to the
// Facebook content script to fill the form. The user always reviews + Publishes.

const DEFAULT_PREFS = { emoji: '', unit: 'mi', category: '', dealerDesc: true, mileage: true, lang: 'en', aiDesc: false, platform: 'fb' };

// Where-to-post labels for status copy (must match the #platform <option> values).
const PLATFORM_LABEL = { fb: 'Facebook Marketplace', craigslist: 'Craigslist', offerup: 'OfferUp', cars: 'Cars.com' };
const platformLabel = (p) => PLATFORM_LABEL[p] || 'Facebook Marketplace';

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
  tAi: el('t-ai'), tDealer: el('t-dealer'), tMileage: el('t-mileage'),
  fill: el('fill'), openfb: el('openfb'),
  status: el('status'),
  statsBtn: el('stats-btn'), statsBack: el('stats-back'),
  viewLister: el('view-lister'), viewStats: el('view-stats'),
  statsRange: el('stats-range'), statsRangeLabel: el('stats-range-label'),
  stActive: el('st-active'), stSold: el('st-sold'), stGross: el('st-gross'),
  stDays: el('st-days'), stHeroRange: el('st-hero-range'), stDelta: el('st-delta'),
  stListed: el('st-listed'), stListedSub: el('st-listed-sub'), stValue: el('st-value'),
  stPlatforms: el('st-platforms'), stTrend: el('st-trend'), stListings: el('st-listings'),
  // auth + entitlement gate
  gate: el('gate'), gateIcon: el('gate-icon'), gateTitle: el('gate-title'), gateMsg: el('gate-msg'),
  gateDealer: el('gate-dealer'), gatePrice: el('gate-price'), gatePriceAmt: el('gate-price-amt'), gatePricePer: el('gate-price-per'),
  gatePrimary: el('gate-primary'), gateSecondary: el('gate-secondary'),
  gateErr: el('gate-err'), gateSignout: el('gate-signout'),
  dealerConnect: el('dealer-connect'), dealerPending: el('dealer-pending'),
  dealerRequestToggle: el('dealer-request-toggle'), dealerRequest: el('dealer-request'),
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
  linkFlash: null
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
  await refreshAuth();
}

// ---------- rendering ----------
function keyForDraft(d) {
  if (!d) return '';
  return (d.vin || '').toUpperCase() || d.stock || d.sourceUrl || '';
}

function isListed(d) {
  const k = keyForDraft(d);
  return !!(k && state.listed[k]);
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

function formatDistance(mi) {
  if (state.prefs.unit === 'km') return `${Math.round(mi * 1.60934).toLocaleString('en-US')} km`;
  return `${Number(mi).toLocaleString('en-US')} mi`;
}

function composeDescription(d, prefs) {
  if (!d) return '';
  const lines = [];
  const title = [d.year, d.make, d.model].filter(Boolean).join(' ');
  lines.push((prefs.emoji ? prefs.emoji + ' ' : '') + title);
  if (prefs.mileage && typeof d.mileage === 'number') lines.push(`• Mileage: ${formatDistance(d.mileage)}`);
  if (prefs.dealerDesc) {
    if (d.vin) lines.push(`• VIN: ${d.vin}`);
    if (d.stock) lines.push(`• Stock #: ${d.stock}`);
    if (d.exteriorColor) lines.push(`• Exterior: ${d.exteriorColor}`);
    if (d.interiorColor) lines.push(`• Interior: ${d.interiorColor}`);
    if (d.engine) lines.push(`• Engine: ${d.engine}`);
    if (d.fuelType) lines.push(`• Fuel: ${d.fuelType}`);
  }
  lines.push('');
  lines.push('Message us to schedule a test drive!');
  if (d.sourceUrl) lines.push(d.sourceUrl);
  return lines.join('\n');
}

function recomposeDesc() {
  ui.desc.value = composeDescription(state.draft, state.prefs).slice(0, 1000);
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
  ui.lang.value = state.prefs.lang || 'en';
  ui.unitMi.classList.toggle('on', state.prefs.unit === 'mi');
  ui.unitKm.classList.toggle('on', state.prefs.unit === 'km');
  ui.tAi.classList.toggle('on', !!state.prefs.aiDesc);
  ui.tDealer.classList.toggle('on', !!state.prefs.dealerDesc);
  ui.tMileage.classList.toggle('on', !!state.prefs.mileage);
}

function setStatus(text, isError) {
  ui.status.textContent = text || '';
  ui.status.classList.toggle('err', !!isError);
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
    if (!state.listings[key]) {
      state.listings[key] = {
        key,
        vin: key.length === 17 ? key : undefined,
        platform: 'fb',
        status: 'active',
        listedAt: (v && v.listedAt) || new Date().toISOString(),
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
    status: r.status === 'sold' ? 'sold' : 'active',
    listedAt: r.listed_at || undefined,
    soldAt: r.sold_at || undefined,
    sourceUrl: r.source_url || undefined
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
  const all = listingsArray();
  const active = all.filter((l) => l.status === 'active');
  const soldAll = all.filter((l) => l.status === 'sold');
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
  for (const l of listingsArray()) {
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
  renderListingList();
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
  const all = listingsArray();
  const fbLive = all.filter((l) => l.status === 'active').length;
  const fbSold = all.filter((l) => l.status === 'sold' && withinRange(l.soldAt, range)).length;
  const total = Math.max(1, fbLive + fbSold);
  const pct = Math.round((fbLive / total) * 100);
  ui.stPlatforms.innerHTML = [
    `<div class="platform-row"><div class="platform-top"><span class="platform-name">FB Marketplace</span>`
      + `<span class="platform-stat">${fbSold} sold ${rangeShort(range)} · ${fbLive} live</span></div>`
      + `<div class="platform-bar"><div class="platform-fill" style="width:${pct}%"></div></div></div>`,
    platformSoon('Craigslist'),
    platformSoon('OfferUp'),
  ].join('');
}

function platformSoon(name) {
  return `<div class="platform-row is-soon"><div class="platform-top"><span class="platform-name">${esc(name)}</span>`
    + `<span class="platform-stat">soon</span></div>`
    + `<div class="platform-bar"><div class="platform-fill" style="width:0%"></div></div></div>`;
}

function renderListingList() {
  if (!ui.stListings) return;
  const all = listingsArray().sort((a, b) => new Date(b.listedAt || 0) - new Date(a.listedAt || 0));
  if (!all.length) {
    ui.stListings.innerHTML = '<div class="listing-empty">No listings tracked yet. Cars you publish with Carxpert show up here.</div>';
    return;
  }
  const dayCount = (from, to) => Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5));
  ui.stListings.innerHTML = all.map((l) => {
    const title = esc(l.title || l.vin || l.key || 'Vehicle');
    const sold = l.status === 'sold';
    const price = l.price || l.soldPrice ? '$' + Number((sold && l.soldPrice) || l.price).toLocaleString('en-US') : '';
    const pill = sold ? '<span class="lst-pill sold">Sold</span>' : '<span class="lst-pill live">Live</span>';
    const days = sold
      ? (l.soldAt && l.listedAt ? `sold in ${dayCount(l.listedAt, l.soldAt)}d` : '')
      : (l.listedAt ? `live ${dayCount(l.listedAt, Date.now())}d` : '');
    const bits = [price, pill, days ? `<span class="lst-days">${days}</span>` : ''].filter(Boolean).join(' · ');
    return `<div class="listing-row"><div class="listing-main">`
      + `<div class="listing-title">${title}</div>`
      + `<div class="listing-sub">${bits}</div></div>`
      + `<button class="lst-sold-btn${sold ? ' undo' : ''}" data-key="${esc(l.key)}">${sold ? 'Undo' : 'Mark sold'}</button></div>`;
  }).join('');
}

// Manual sold signal — the reliable MVP source of truth for sale outcomes.
function markSold(key) {
  let l = state.listings[key];
  if (!l) {
    // Server-only listing (synced from another device) — materialise a local record so the
    // change persists locally and syncs back.
    const s = state.serverListings[key];
    if (!s) return;
    l = { ...s };
    state.listings[key] = l;
  }
  let type;
  if (l.status === 'sold') {
    l.status = 'active'; delete l.soldAt; delete l.soldPrice; type = 'marked_sold_undo';
  } else {
    l.status = 'sold'; l.soldAt = new Date().toISOString(); l.soldPrice = l.price; type = 'marked_sold';
  }
  chrome.storage.local.set({ ezlistListings: state.listings }); // triggers background auto-sync
  chrome.runtime.sendMessage({
    type: 'EZLIST_ENQUEUE_EVENT',
    event: { type, clientKey: key, occurredAt: new Date().toISOString(), data: type === 'marked_sold' ? { soldPrice: l.soldPrice } : null }
  }).catch(() => {});
  renderStats();
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
  ui.statsBtn.addEventListener('click', () => showView('stats'));
  ui.statsBack.addEventListener('click', () => showView('lister'));
  ui.statsRange.addEventListener('change', () => { ui.statsRangeLabel.textContent = rangeLabel(ui.statsRange.value); renderStats(); });
  ui.stListings.addEventListener('click', (e) => {
    const btn = e.target.closest('.lst-sold-btn');
    if (btn && btn.dataset.key) markSold(btn.dataset.key);
  });
  ui.openfb.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_PLATFORM', platform: ui.platform.value || 'fb' }));
  ui.platform.addEventListener('change', () => savePref('platform', ui.platform.value, false));
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
  ui.unitMi.addEventListener('click', () => savePref('unit', 'mi', true));
  ui.unitKm.addEventListener('click', () => savePref('unit', 'km', true));
  ui.tDealer.addEventListener('click', () => savePref('dealerDesc', !state.prefs.dealerDesc, true));
  ui.tMileage.addEventListener('click', () => savePref('mileage', !state.prefs.mileage, true));

  // auth + gate
  ui.gatePrimary.addEventListener('click', () => gateAction(ui.gatePrimary.dataset.action));
  ui.gateSecondary.addEventListener('click', () => gateAction(ui.gateSecondary.dataset.action));
  ui.dealerRequestToggle.addEventListener('click', () => { state.dealerRequestOpen = true; renderGate(); });
  ui.dealerRequestCancel.addEventListener('click', () => { state.dealerRequestOpen = false; renderGate(); });
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
  if (!gate || !gate.ok) { await refreshAuth({ refresh: true }); return; }
  state.filling = true;
  ui.fill.disabled = true;
  const original = ui.fill.textContent;
  const platform = ui.platform.value || 'fb';
  const name = platformLabel(platform);
  ui.fill.textContent = 'Filling…';
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
// One gate screen per /api/me reason. The background worker owns auth/entitlement; the panel
// just renders the right step and fires the action.
const GATE = {
  signed_out: { icon: '🔑', title: 'Sign in to Carxpert', msg: 'Sign in with your Google account to start listing inventory to Facebook Marketplace.', primary: 'Sign in with Google', action: 'signin' },
  no_dealership: { icon: '🏬', title: 'Connect your dealership', msg: 'Open your dealership inventory page, then detect and connect it here. Supported dealers unlock checkout immediately.', primary: 'Detect dealership', action: 'connectDealer' },
  no_subscription: { title: 'Start your subscription', msg: 'One-click dealer inventory to Facebook Marketplace, with AI descriptions & translations.', primary: 'Subscribe', action: 'checkout', price: true },
  expired: { title: 'Renew your subscription', msg: 'Your subscription has ended. Renew to keep listing to Facebook Marketplace.', primary: 'Renew', action: 'checkout', price: true },
  unknown: { icon: '⚠️', title: 'Couldn’t load your account', msg: 'We couldn’t reach the server. Check your connection and try again.', primary: 'Retry', action: 'recheck' }
};

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

function renderGate() {
  const auth = state.auth || { signedIn: false };
  applyAccount(auth);
  // The linking moment gets its own beat (spinner → tick) before the next gate step —
  // otherwise a successful auto-connect silently drops the user on the subscribe screen.
  if (state.linkFlash && auth.signedIn) { renderLinkFlash(); return; }
  const key = gateStateKey(auth);
  if (!key) { ui.gate.hidden = true; return; }
  const g = GATE[key];
  ui.gate.hidden = false;
  ui.gatePrimary.hidden = false;
  ui.gateIcon.textContent = '';
  ui.gateIcon.hidden = true;
  ui.gateTitle.textContent = g.title;
  ui.gateMsg.textContent = g.msg;
  renderVerifiedDealer(key, auth);
  ui.gatePrice.hidden = !g.price;
  if (g.price) renderPlan();
  ui.gatePrimary.textContent = g.primary;
  ui.gatePrimary.dataset.action = g.action;
  if (g.secondary) { ui.gateSecondary.hidden = false; ui.gateSecondary.textContent = g.secondary; ui.gateSecondary.dataset.action = g.secondaryAction; }
  else ui.gateSecondary.hidden = true;
  renderDealerConnect(key, auth);
  ui.gateSignout.hidden = !auth.signedIn;
  ui.gateErr.hidden = true;
}

function renderLinkFlash() {
  const f = state.linkFlash;
  const name = f.name
    || (state.auth && state.auth.dealership && state.auth.dealership.name)
    || 'Dealership';
  ui.gate.hidden = false;
  ui.gateIcon.hidden = false;
  ui.gateIcon.innerHTML = f.stage === 'linking'
    ? '<span class="gate-spinner" aria-hidden="true"></span>'
    : '<span class="gate-tick" aria-hidden="true">✓</span>';
  ui.gateTitle.textContent = f.stage === 'linking' ? 'Connecting your dealership…' : 'Dealership linked';
  ui.gateMsg.textContent = f.stage === 'linking' ? 'Verifying with Carxpert' : '';
  ui.gateDealer.hidden = f.stage !== 'linked';
  if (f.stage === 'linked') {
    ui.gateDealer.innerHTML = `${esc(name)}<small>Verified by Carxpert backend</small>`;
  }
  ui.gatePrice.hidden = true;
  ui.gatePrimary.hidden = true;
  ui.gateSecondary.hidden = true;
  ui.dealerConnect.hidden = true;
  ui.gateErr.hidden = true;
  ui.gateSignout.hidden = true;
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
  ui.gateDealer.innerHTML = `${esc(dealer.name || 'Dealership verified')}<small>Verified by Carxpert backend</small>`;
}

function renderDealerConnect(key, auth) {
  const active = key === 'no_dealership';
  ui.dealerConnect.hidden = !active;
  if (!active) {
    state.dealerRequestOpen = false;
    state.autoDealerConnectTried = false;
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

  if (auth && auth.user) {
    if (ui.dealerName && !ui.dealerName.value) ui.dealerName.value = auth.user.name || '';
    if (ui.dealerEmail && !ui.dealerEmail.value) ui.dealerEmail.value = auth.user.email || '';
  }
  ui.dealerRequest.hidden = !state.dealerRequestOpen;
  ui.dealerRequestToggle.hidden = state.dealerRequestOpen;

  if (!state.autoDealerConnectTried && !pending) {
    state.autoDealerConnectTried = true;
    setTimeout(() => connectDealer({ silent: true }), 50);
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

async function gateAction(action) {
  ui.gateErr.hidden = true;
  const btn = action === 'refresh' ? ui.gateSecondary : ui.gatePrimary;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    if (action === 'signin') {
      btn.textContent = 'Opening Google…';
      const res = await chrome.runtime.sendMessage({ type: 'EZLIST_SIGN_IN' });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Sign-in failed.');
      state.auth = res.auth; renderGate();
    } else if (action === 'connectDealer') {
      await connectDealer();
    } else if (action === 'checkout') {
      btn.textContent = 'Opening checkout…';
      const res = await chrome.runtime.sendMessage({ type: 'EZLIST_CHECKOUT' });
      if (!res || !res.ok) {
        const err = new Error((res && res.error) || 'Could not start checkout.');
        err.reason = res && res.reason;
        throw err;
      }
      // Checkout opens in a tab; entitlement flips when the user returns (visibilitychange) or taps refresh.
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
    btn.textContent = label;
  }
}

async function connectDealer(opts = {}) {
  if (!opts.silent) {
    ui.gateErr.hidden = true;
    ui.gatePrimary.disabled = true;
    ui.gatePrimary.textContent = 'Detecting…';
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_CONNECT_DEALER' });
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
    state.dealerRequestOpen = false;
    // Start the flash before refreshAuth repaints, so the user sees the link happen
    // instead of jumping straight to the subscribe screen.
    if (!(state.auth && state.auth.dealership)) {
      startLinkFlash(res.auth && res.auth.dealership);
    }
    state.auth = res.auth || await refreshAuth({ refresh: true });
    await refreshAuth({ refresh: true });
  } catch (e) {
    if (!opts.silent) showGateError(e.message || 'Could not connect dealership.');
  } finally {
    ui.gatePrimary.disabled = false;
    if (gateStateKey(state.auth) === 'no_dealership') ui.gatePrimary.textContent = GATE.no_dealership.primary;
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
