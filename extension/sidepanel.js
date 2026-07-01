'use strict';

// Carxpert side panel — control surface. Shows the current vehicle, lets the user
// tune the listing (description, emoji, unit, toggles), then hands off to the
// Facebook content script to fill the form. The user always reviews + Publishes.

const HELP_URL = 'https://github.com/srax/ez-lister';

const DEFAULT_PREFS = { emoji: '', unit: 'mi', category: '', dealerDesc: true, mileage: true, lang: 'en' };

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
  tDealer: el('t-dealer'), tMileage: el('t-mileage'),
  fill: el('fill'), openfb: el('openfb'), help: el('help'),
  status: el('status'),
  statsBtn: el('stats-btn'), statsBack: el('stats-back'),
  viewLister: el('view-lister'), viewStats: el('view-stats'),
  statsRange: el('stats-range'), statsRangeLabel: el('stats-range-label'),
  stActive: el('st-active'), stSold: el('st-sold'), stGross: el('st-gross'),
  stDays: el('st-days'), stHeroRange: el('st-hero-range'),
  stPlatforms: el('st-platforms'), stTrend: el('st-trend'), stListings: el('st-listings'),
};

const state = { draft: null, prefs: { ...DEFAULT_PREFS }, listed: {}, listings: {}, userEdited: false, filling: false };

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
  const candidates = [`${base}1.jpg`, `${base}0.jpg`, `${base}2.jpg`];
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
  ui.lang.value = state.prefs.lang || 'en';
  ui.unitMi.classList.toggle('on', state.prefs.unit === 'mi');
  ui.unitKm.classList.toggle('on', state.prefs.unit === 'km');
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
  if (stats) renderStats();
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

const listingsArray = () => Object.values(state.listings || {});

function withinRange(iso, range) {
  if (!iso) return false;
  if (range === 'all') return true;
  const days = range === '7' ? 7 : range === '90' ? 90 : 30;
  return (Date.now() - new Date(iso).getTime()) <= days * 864e5;
}

// All figures below come from our own publish log + manual "Mark sold" events — no FB
// scraping. Views/leads stay as samples until the FB-insights research lands.
function computeStats(range) {
  const all = listingsArray();
  const activeCount = all.filter((l) => l.status === 'active').length;
  const soldAll = all.filter((l) => l.status === 'sold');
  const soldInRange = soldAll.filter((l) => withinRange(l.soldAt, range));
  const gross = soldInRange.reduce((sum, l) => sum + (Number(l.soldPrice || l.price) || 0), 0);
  const spans = soldAll
    .filter((l) => l.soldAt && l.listedAt)
    .map((l) => (new Date(l.soldAt) - new Date(l.listedAt)) / 864e5);
  const avgDays = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
  return { activeCount, soldCount: soldInRange.length, gross, avgDays };
}

// Listings created per month, last 6 months.
function monthlyListed() {
  const now = new Date();
  const buckets = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleString('en-US', { month: 'short' }), val: 0 });
  }
  for (const l of listingsArray()) {
    if (!l.listedAt) continue;
    const d = new Date(l.listedAt);
    const b = buckets.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
    if (b) b.val += 1;
  }
  return buckets;
}

function renderStats() {
  const range = ui.statsRange ? ui.statsRange.value : '30';
  const s = computeStats(range);
  if (ui.stActive) ui.stActive.textContent = String(s.activeCount);
  if (ui.stSold) ui.stSold.textContent = String(s.soldCount);
  if (ui.stGross) ui.stGross.textContent = '$' + s.gross.toLocaleString('en-US');
  if (ui.stDays) ui.stDays.textContent = s.avgDays == null ? '—' : String(s.avgDays);
  if (ui.stHeroRange) ui.stHeroRange.textContent = rangeShort(range);
  renderTrend();
  renderPlatforms();
  renderListingList();
}

function renderTrend() {
  if (!ui.stTrend) return;
  const buckets = monthlyListed();
  const max = Math.max(1, ...buckets.map((b) => b.val));
  ui.stTrend.innerHTML = buckets.map((b, i) => {
    const h = Math.round((b.val / max) * 74);
    const on = i === buckets.length - 1 ? ' on' : '';
    return `<div class="trend-col"><span class="trend-val">${b.val}</span>`
      + `<div class="trend-bar${on}" style="height:${h}px"></div>`
      + `<span class="trend-label">${b.label}</span></div>`;
  }).join('');
}

function renderPlatforms() {
  if (!ui.stPlatforms) return;
  const all = listingsArray();
  const fbLive = all.filter((l) => l.status === 'active').length;
  const fbSold = all.filter((l) => l.status === 'sold').length;
  const total = Math.max(1, fbLive + fbSold);
  const pct = Math.round((fbLive / total) * 100);
  ui.stPlatforms.innerHTML = [
    `<div class="platform-row"><div class="platform-top"><span class="platform-name">FB Marketplace</span>`
      + `<span class="platform-stat">${fbSold} sold · ${fbLive} live</span></div>`
      + `<div class="platform-bar"><div class="platform-fill" style="width:${pct}%"></div></div></div>`,
    platformSoon('Craigslist'),
    platformSoon('OfferUp'),
  ].join('');
}

function platformSoon(name) {
  return `<div class="platform-row soon"><div class="platform-top"><span class="platform-name">${esc(name)}</span>`
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
  ui.stListings.innerHTML = all.map((l) => {
    const title = esc(l.title || l.vin || l.key || 'Vehicle');
    const price = l.price ? '$' + Number(l.price).toLocaleString('en-US') : '';
    const sold = l.status === 'sold';
    const pill = sold ? '<span class="lst-pill sold">Sold</span>' : '<span class="lst-pill live">Live</span>';
    const sep = price ? ' · ' : '';
    return `<div class="listing-row"><div class="listing-main">`
      + `<div class="listing-title">${title}</div>`
      + `<div class="listing-sub">${price}${sep}${pill}</div></div>`
      + `<button class="lst-sold-btn${sold ? ' undo' : ''}" data-key="${esc(l.key)}">${sold ? 'Undo' : 'Mark sold'}</button></div>`;
  }).join('');
}

// Manual sold signal — the reliable MVP source of truth for sale outcomes.
function markSold(key) {
  const l = state.listings[key];
  if (!l) return;
  if (l.status === 'sold') {
    l.status = 'active';
    delete l.soldAt;
    delete l.soldPrice;
  } else {
    l.status = 'sold';
    l.soldAt = new Date().toISOString();
    l.soldPrice = l.price;
  }
  chrome.storage.local.set({ ezlistListings: state.listings });
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
  ui.help.addEventListener('click', () => chrome.tabs.create({ url: HELP_URL }));
  ui.statsBtn.addEventListener('click', () => showView('stats'));
  ui.statsBack.addEventListener('click', () => showView('lister'));
  ui.statsRange.addEventListener('change', () => { ui.statsRangeLabel.textContent = rangeLabel(ui.statsRange.value); renderStats(); });
  ui.stListings.addEventListener('click', (e) => {
    const btn = e.target.closest('.lst-sold-btn');
    if (btn && btn.dataset.key) markSold(btn.dataset.key);
  });
  ui.openfb.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_FACEBOOK' }));
  ui.fill.addEventListener('click', onFill);
  ui.aiDraft.addEventListener('click', onAiDraft);
  ui.translate.addEventListener('click', onTranslate);
  ui.lang.addEventListener('change', () => savePref('lang', ui.lang.value, false));

  ui.desc.addEventListener('input', () => { state.userEdited = true; updateCharCount(); });

  ui.emoji.addEventListener('change', () => savePref('emoji', ui.emoji.value, true));
  ui.category.addEventListener('change', () => savePref('category', ui.category.value, false));
  ui.unitMi.addEventListener('click', () => savePref('unit', 'mi', true));
  ui.unitKm.addEventListener('click', () => savePref('unit', 'km', true));
  ui.tDealer.addEventListener('click', () => savePref('dealerDesc', !state.prefs.dealerDesc, true));
  ui.tMileage.addEventListener('click', () => savePref('mileage', !state.prefs.mileage, true));
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
    if (changedCar) recomposeDesc(); // new car → fresh description; keep edits if same car
  }
}

// ---------- fill hand-off ----------
async function onFill() {
  if (!state.draft || state.filling) return;
  state.filling = true;
  ui.fill.disabled = true;
  const original = ui.fill.textContent;
  ui.fill.textContent = 'Filling…';
  setStatus('Saving listing…');
  try {
    const fillDraft = { ...state.draft, description: ui.desc.value };
    if (!state.prefs.mileage) delete fillDraft.mileage;            // "Add mileage" off → leave blank
    if (state.prefs.category) fillDraft.bodyType = state.prefs.category; // category override → mapped by FB filler
    await chrome.runtime.sendMessage({ type: 'EZLIST_SAVE_DRAFT', draft: fillDraft, autoFill: true });
    setStatus('Opening Facebook & filling…');
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_FILL_NOW', key: keyForDraft(fillDraft) });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not reach the Facebook form.');
    // The FB content script streams per-field progress and the final result back
    // via EZLIST_FILL_STATUS, so we don't claim completion prematurely here.
  } catch (e) {
    setStatus(e.message || 'Something went wrong.', true);
  } finally {
    state.filling = false;
    ui.fill.disabled = false;
    ui.fill.textContent = original;
  }
}

// ---------- AI (routed through our backend) ----------
async function onAiDraft() {
  if (!state.draft) { setStatus('Pick a car first.', true); return; }
  ui.aiDraft.disabled = true;
  setStatus('Drafting with A.I.…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_AI_DESCRIBE', vehicle: state.draft, options: {} });
    if (!res || !res.ok) throw new Error((res && res.error) || 'A.I. draft failed.');
    ui.desc.value = (res.description || '').slice(0, 1000);
    state.userEdited = true;
    updateCharCount();
    setStatus('A.I. draft ready — edit if you like, then Fill.');
  } catch (e) {
    setStatus(e.message, true);
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

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
