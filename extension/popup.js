'use strict';

const draftEl = document.getElementById('draft');
const statusEl = document.getElementById('status');
const listBtn = document.getElementById('listCurrent');
const facebookBtn = document.getElementById('facebook');

listBtn.addEventListener('click', listCurrent);
facebookBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'EZLIST_OPEN_FACEBOOK' }));

load();

async function load() {
  const response = await chrome.runtime.sendMessage({ type: 'EZLIST_GET_DRAFT' });
  renderDraft(response && response.ezlistDraft, response && response.ezlistLastExtractedAt);
}

async function listCurrent() {
  setBusy(true);
  statusEl.textContent = 'Listing this car…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab.');
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'EZLIST_LIST_CURRENT' });
    if (!result || !result.ok) throw new Error((result && result.error) || 'The page did not respond.');
    renderDraft(result.draft, new Date().toISOString());
    statusEl.textContent = 'Opening the Facebook vehicle form…';
  } catch (error) {
    statusEl.textContent = /Receiving end does not exist/.test(error.message)
      ? 'Open a dealership car page first, then try again.'
      : error.message;
  } finally {
    setBusy(false);
  }
}

function renderDraft(v, timestamp) {
  if (!v) {
    draftEl.innerHTML = '<h2>No vehicle ready</h2><p>Open the dealership inventory and click <b>⚡ List</b> on a car.</p>';
    return;
  }
  const title = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
  draftEl.innerHTML = `
    <h2>${esc(title)}</h2>
    <p>${v.price ? `$${Number(v.price).toLocaleString('en-US')}` : 'No price'}${typeof v.mileage === 'number' ? ` · ${Number(v.mileage).toLocaleString('en-US')} mi` : ''}</p>
    ${v.vin ? `<p class="meta">VIN ${esc(v.vin)}</p>` : ''}
    ${timestamp ? `<p class="meta">Saved ${new Date(timestamp).toLocaleString()}</p>` : ''}
  `;
}

function setBusy(busy) {
  listBtn.disabled = busy;
  listBtn.textContent = busy ? 'Working…' : 'List this car page';
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
