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
  platform: el('platform'), howto: el('howto'), category: el('category'), emoji: el('emoji'),
  unitMi: el('unit-mi'), unitKm: el('unit-km'),
  desc: el('desc'), charcount: el('charcount'),
  aiDraft: el('ai-draft'), lang: el('lang'), translate: el('translate'),
  tDealer: el('t-dealer'), tMileage: el('t-mileage'),
  fill: el('fill'), openfb: el('openfb'), help: el('help'),
  status: el('status'),
};

const state = { draft: null, prefs: { ...DEFAULT_PREFS }, listed: {}, userEdited: false, filling: false };

init();

async function init() {
  const store = await chrome.storage.local.get(['ezlistDraft', 'ezlistPrefs', 'ezlistListedVins']);
  state.draft = store.ezlistDraft || null;
  state.prefs = { ...DEFAULT_PREFS, ...(store.ezlistPrefs || {}) };
  state.listed = store.ezlistListedVins || {};
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
  ui.fill.disabled = state.filling;
  if (!state.filling) {
    setStatus(isListed(d) ? 'Already listed — fill again to re-list with changes.' : 'Ready. Tune the listing, then Fill.');
  }
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

// ---------- events ----------
function wireEvents() {
  ui.help.addEventListener('click', () => chrome.tabs.create({ url: HELP_URL }));
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
    const res = await chrome.runtime.sendMessage({ type: 'EZLIST_FILL_NOW' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not reach the Facebook form.');
    setStatus('Review every field & photos, then press Publish.');
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
