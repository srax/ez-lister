'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'sidepanel.html'), 'utf8');
const panelSource = fs.readFileSync(path.join(__dirname, 'sidepanel.js'), 'utf8');
const panelCss = fs.readFileSync(path.join(__dirname, 'sidepanel.css'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');

test('side panel is instruction-only and does not duplicate the generated Facebook description', () => {
  assert.match(html, />AI description instructions</i);
  assert.match(html, /id="ai-instructions"\s+class="vsl-in"/);
  assert.match(html, />SEO friendly</i);
  assert.doesNotMatch(html, /Tell AI how to improve/i);
  assert.match(html, />\s*Improve Facebook description\s*</i);
  assert.doesNotMatch(html, />Listing description</i);
  assert.doesNotMatch(html, /id="desc"/);
  assert.doesNotMatch(html, /id="ai-format"/);
  assert.doesNotMatch(html, /id="t-ai"/);
  assert.doesNotMatch(html, /id="openfb"/);
  assert.doesNotMatch(panelSource, /ui\.desc/);
  assert.doesNotMatch(panelSource, /aiFormat/);
  assert.doesNotMatch(panelSource, /Auto A\.I\./);
  assert.doesNotMatch(panelSource, /Ready\. Tune the listing, then Fill\./);
  assert.doesNotMatch(panelSource, /click Fill listing to send it to Facebook/i);
  assert.match(panelSource, /Couldn.t update the open Facebook description/i);
  assert.doesNotMatch(panelSource, /EZLIST_OPEN_PLATFORM/);
});

test('AI description instructions are one-shot and reopen as an empty placeholder', () => {
  const textarea = html.match(/<textarea id="ai-instructions"[^>]*>/i)?.[0] || '';
  assert.match(textarea, /placeholder="Example: Make it more formal and simple\./i);
  assert.doesNotMatch(textarea, /\bvalue=/i);
  assert.doesNotMatch(panelSource, /state\.prefs\.aiInstructions/);
  assert.doesNotMatch(panelSource, /scheduleAiPreferenceSave/);
  assert.doesNotMatch(panelSource, /aiInstructions:\s*['"]/);
  assert.match(panelSource, /delete\s+storedPrefs\.aiInstructions/);
  assert.match(panelSource, /state\.description\s*=\s*generatedDescription;\s*ui\.aiInstructions\.value\s*=\s*'';/);
});

test('side panel sends the stored ad as revision context and writes AI output directly to Facebook', () => {
  assert.match(panelSource, /currentDescription:\s*currentDescription\(\)/);
  assert.match(panelSource, /instructions:\s*ui\.aiInstructions\.value/);
  assert.match(panelSource, /distanceUnit:\s*state\.prefs\.unit/);
  assert.match(panelSource, /includeMileage:\s*state\.prefs\.mileage/);
  assert.doesNotMatch(panelSource, /format:\s*ui\./);
  assert.match(panelSource, /await\s+syncDescriptionToFacebook\(generatedDescription\)/);
  assert.match(panelSource, /type:\s*'EZLIST_UPDATE_DESCRIPTION'/);
  assert.match(backgroundSource, /case\s+'EZLIST_UPDATE_DESCRIPTION'/);
  assert.match(backgroundSource, /description,\s*\n\s*previousDescription/);
});

test('AI instructions have a minimal outline and fixed edges use faint separators', () => {
  assert.match(panelCss, /\.vsl-in\{[^}]*border:1px solid rgba\(35,38,58,\.13\)/s);
  assert.match(panelCss, /\.head\{[^}]*box-shadow:0 2px 8px -7px rgba\(35,38,58,\.11\)/s);
  assert.match(panelCss, /\.foot\{[^}]*box-shadow:0 -2px 8px -7px rgba\(35,38,58,\.11\)/s);
  assert.doesNotMatch(panelCss, /\.head\{[^}]*border-bottom/s);
  assert.doesNotMatch(panelCss, /\.foot\{[^}]*border-top/s);
});

test('translation languages are visible single-select buttons rather than a dropdown', () => {
  assert.doesNotMatch(html, /<select id="lang"/i);
  assert.match(html, /id="lang" class="lang-options" role="radiogroup"/i);
  for (const lang of ['en', 'es', 'fa', 'ur']) {
    assert.match(html, new RegExp(`<button[^>]+data-lang="${lang}"`, 'i'));
  }
  assert.match(panelSource, /savePref\('lang', button\.dataset\.lang, false\)/);
  assert.match(panelSource, /targetLang:\s*lang/);
  assert.match(panelCss, /\.lang-options\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/s);
  assert.match(panelCss, /\.lang-btn\.on\{[^}]*background:#fff/s);
});

test('Facebook replaces only Description for the matching already-filled vehicle', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'facebookContent.js'), 'utf8');
  let listener;
  let filledResolve;
  const filled = new Promise((resolve) => { filledResolve = resolve; });
  const textCalls = [];
  const draft = {
    vin: 'TESTVIN1234567890',
    year: 2016,
    make: 'BMW',
    model: '228i',
    description: 'Original copy'
  };

  const ok = (name) => Promise.resolve({ name, ok: true, msg: 'filled' });
  const sandbox = {
    location: { hostname: 'www.facebook.com', pathname: '/marketplace/create/vehicle', href: 'https://www.facebook.com/marketplace/create/vehicle' },
    document: {
      documentElement: { lang: 'en' },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setInterval() { return 1; },
    clearInterval() {},
    console,
    chrome: {
      storage: { local: { set: async () => {} } },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        async sendMessage(message) {
          if (message.type === 'EZLIST_CAN_LIST') return { ok: true };
          if (message.type === 'EZLIST_GET_DRAFT') return { ezlistDraft: draft, ezlistAutoFill: false };
          if (message.type === 'EZLIST_FILL_STATUS' && /(?:Listing filled|Filled ✓)/.test(message.text || '')) filledResolve();
          return { ok: true };
        }
      }
    },
    CarxpertFill: {
      sleep: async () => {}, norm: (value) => String(value || ''), waitUntil: async () => null,
      getLabel: () => null, waitForLabel: async () => null, readOptions: () => [],
      closeAnyDropdown: async () => {}, settleUi: async () => {},
      fillTextField: async (name, value) => { textCalls.push([name, value]); return { name, ok: true, msg: 'filled' }; },
      selectDropdown: (name) => ok(Array.isArray(name) ? name[0] : name),
      fillAutocomplete: (name) => ok(name), attachPhotos: () => 0, waitForCount: async () => null
    },
    CarxpertFb: {
      mapColor: (value) => value, mapBody: (value) => value, mapFuel: (value) => value,
      mapTransmission: (value) => value, optionCandidates: (value) => [value], judgePublishNav: () => false
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'facebookContent.js' });
  assert.equal(typeof listener, 'function');

  listener({ type: 'EZLIST_FILL', key: draft.vin }, {}, () => {});
  await filled;
  textCalls.length = 0;

  const update = (message) => new Promise((resolve) => {
    const keepOpen = listener(message, {}, resolve);
    assert.equal(keepOpen, true);
  });

  const wrong = await update({ type: 'EZLIST_UPDATE_DESCRIPTION', key: 'OTHER-VIN', description: 'Wrong car' });
  assert.equal(wrong.updated, false);
  assert.deepEqual(textCalls, []);

  const right = await update({
    type: 'EZLIST_UPDATE_DESCRIPTION',
    key: draft.vin,
    description: 'More formal, vehicle-specific copy.'
  });
  assert.equal(right.updated, true);
  assert.deepEqual(textCalls, [['Description', 'More formal, vehicle-specific copy.']]);
});

test('Facebook recovers the matching filled vehicle after a form refresh and translates only Description', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'facebookContent.js'), 'utf8');
  const previousDescription = 'Original English vehicle description.';
  const translatedDescription = 'Descripción traducida del vehículo.';
  const draft = {
    vin: 'REFRESHEDVIN123456',
    year: 2020,
    make: 'Toyota',
    model: 'Highlander',
    description: translatedDescription,
    _carxpertContext: { key: 'personal:user-1:dealer-1' }
  };
  const descriptionInput = { value: previousDescription };
  const descriptionLabel = { querySelector: () => descriptionInput };
  const textCalls = [];
  let listener;

  const ok = (name) => Promise.resolve({ name, ok: true, msg: 'filled' });
  const sandbox = {
    location: { hostname: 'www.facebook.com', pathname: '/marketplace/create/vehicle', href: 'https://www.facebook.com/marketplace/create/vehicle' },
    document: {
      documentElement: { lang: 'en' },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setInterval() { return 1; },
    clearInterval() {},
    console,
    chrome: {
      storage: { local: { set: async () => {} } },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        async sendMessage(message) {
          if (message.type === 'EZLIST_GET_DRAFT') {
            return { ezlistDraft: draft, ezlistAutoFill: false, ezlistActiveContext: draft._carxpertContext };
          }
          return { ok: true };
        }
      }
    },
    CarxpertFill: {
      sleep: async () => {}, norm: (value) => String(value || '').trim().toLowerCase(), waitUntil: async () => null,
      getLabel: (name) => name === 'Description' ? descriptionLabel : null,
      waitForLabel: async () => true, readOptions: () => [],
      closeAnyDropdown: async () => {}, settleUi: async () => {},
      fillTextField: async (name, value) => {
        textCalls.push([name, value]);
        descriptionInput.value = String(value);
        return { name, ok: true, msg: 'filled' };
      },
      selectDropdown: (name) => ok(Array.isArray(name) ? name[0] : name),
      fillAutocomplete: (name) => ok(name), attachPhotos: () => 0, waitForCount: async () => null
    },
    CarxpertFb: {
      mapColor: (value) => value, mapBody: (value) => value, mapFuel: (value) => value,
      mapTransmission: (value) => value, optionCandidates: (value) => [value], judgePublishNav: () => false
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'facebookContent.js' });

  const result = await new Promise((resolve) => {
    const keepOpen = listener({
      type: 'EZLIST_UPDATE_DESCRIPTION',
      key: draft.vin,
      description: translatedDescription,
      previousDescription
    }, {}, resolve);
    assert.equal(keepOpen, true);
  });

  assert.equal(result.updated, true);
  assert.deepEqual(textCalls, [['Description', translatedDescription]]);
});

test('Facebook recovers by VIN after a failed sync and extension reload changed the stored copy', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'facebookContent.js'), 'utf8');
  const vin = '3N1CE2CP2EL414588';
  const visibleDescription = `2014 Nissan Versa Note\nVIN: ${vin}\nCall today.`;
  const failedStoredDescription = `A prior translation containing VIN ${vin} that never reached Facebook.`;
  const replacement = `Formal replacement copy for VIN ${vin}.`;
  const descriptionInput = { value: visibleDescription };
  const descriptionLabel = { querySelector: () => descriptionInput };
  const textCalls = [];
  let listener;

  const sandbox = {
    location: { hostname: 'www.facebook.com', pathname: '/marketplace/create/vehicle', href: 'https://www.facebook.com/marketplace/create/vehicle' },
    document: {
      documentElement: { lang: 'en' },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setInterval() { return 1; },
    clearInterval() {},
    console,
    chrome: {
      storage: { local: { set: async () => {} } },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        async sendMessage(message) {
          if (message.type === 'EZLIST_GET_DRAFT') {
            return { ezlistDraft: { vin, description: failedStoredDescription }, ezlistAutoFill: false };
          }
          return { ok: true };
        }
      }
    },
    CarxpertFill: {
      sleep: async () => {}, norm: (value) => String(value || '').trim().toLowerCase(), waitUntil: async () => null,
      getLabel: (name) => name === 'Description' ? descriptionLabel : null,
      waitForLabel: async () => true, readOptions: () => [],
      closeAnyDropdown: async () => {}, settleUi: async () => {},
      fillTextField: async (name, value) => {
        textCalls.push([name, value]);
        descriptionInput.value = String(value);
        return { name, ok: true, msg: 'filled' };
      },
      selectDropdown: async () => ({ ok: true }), fillAutocomplete: async () => ({ ok: true }),
      attachPhotos: () => 0, waitForCount: async () => null
    },
    CarxpertFb: {
      mapColor: (value) => value, mapBody: (value) => value, mapFuel: (value) => value,
      mapTransmission: (value) => value, optionCandidates: (value) => [value], judgePublishNav: () => false
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'facebookContent.js' });

  const result = await new Promise((resolve) => {
    listener({
      type: 'EZLIST_UPDATE_DESCRIPTION',
      key: vin,
      description: replacement,
      previousDescription: failedStoredDescription
    }, {}, resolve);
  });

  assert.equal(result.updated, true);
  assert.deepEqual(textCalls, [['Description', replacement]]);
});
