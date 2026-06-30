'use strict';

// Carxpert AI: server-side OpenAI calls. The user's extension never holds the key —
// it calls our backend, which calls OpenAI with OUR key.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// The intro blurb is easy → a cheap model is plenty.
const DESCRIBE_MODEL = process.env.DESCRIBE_MODEL || 'gpt-4o-mini';
// Translation: cheap + accurate default for common languages; a stronger model only
// for less-common / RTL languages where the mini model is measurably weaker.
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
const TRANSLATE_MODEL_STRONG = process.env.TRANSLATE_MODEL_STRONG || 'gpt-4o';
const STRONG_LANGS = new Set(['fa', 'ur', 'ar', 'zh', 'ja', 'ko', 'hi', 'th']);

const LANGS = {
  en: 'English', es: 'Spanish', fa: 'Farsi (Persian)', ur: 'Urdu',
  fr: 'French', de: 'German', ar: 'Arabic', zh: 'Chinese (Simplified)', pt: 'Portuguese'
};

async function chat({ model, system, user, temperature = 0.5, maxTokens = 500 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { const e = new Error('OPENAI_API_KEY is not set on the server'); e.status = 500; throw e; }
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, temperature, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { const e = new Error((data.error && data.error.message) || `OpenAI error ${resp.status}`); e.status = 502; throw e; }
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (text || '').trim();
}

// ---- description: deterministic structure, AI writes ONLY the human intro ----
// Bullets come from real fields (always valid, identical layout every time); the model
// just adds a short, warm intro. This is what keeps every listing clean and consistent.
const SPEC_FIELDS = [
  ['Price', (v) => (v.price ? `$${Number(v.price).toLocaleString('en-US')}` : '')],
  ['Mileage', (v) => (typeof v.mileage === 'number' ? `${v.mileage.toLocaleString('en-US')} miles` : v.mileage)],
  ['Exterior', (v) => v.exteriorColor],
  ['Interior', (v) => v.interiorColor],
  ['Engine', (v) => v.engine],
  ['Fuel', (v) => v.fuelType],
  ['Transmission', (v) => v.transmission],
  ['VIN', (v) => v.vin],
  ['Stock #', (v) => v.stock]
];

function titleLine(v) {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function bulletLines(v) {
  return SPEC_FIELDS
    .map(([label, get]) => [label, get(v)])
    .filter(([, val]) => val != null && val !== '')
    .map(([label, val]) => `• ${label}: ${val}`);
}

function blurbFacts(v) {
  const rows = [
    ['Year', v.year], ['Make', v.make], ['Model', v.model], ['Trim', v.trim], ['Body', v.bodyType],
    ['Mileage', typeof v.mileage === 'number' ? `${v.mileage.toLocaleString('en-US')} miles` : v.mileage],
    ['Exterior', v.exteriorColor], ['Fuel', v.fuelType]
  ];
  return rows.filter(([, x]) => x != null && x !== '').map(([k, x]) => `${k}: ${x}`).join('\n');
}

async function intro(vehicle) {
  const facts = blurbFacts(vehicle);
  if (!facts) return '';
  const system = [
    "You write a short, warm intro for a car dealership's Facebook Marketplace vehicle listing.",
    'Output 1–2 natural sentences only — no markdown, no bullet points, no spec list.',
    'Do NOT mention price, VIN, stock number, or a call to action (those are added separately).',
    'Use ONLY the facts provided; never invent features, condition, or history. Max 40 words.'
  ].join(' ');
  return chat({ model: DESCRIBE_MODEL, system, user: facts, temperature: 0.6, maxTokens: 120 });
}

async function describe(vehicle = {}) {
  const title = titleLine(vehicle);
  const bullets = bulletLines(vehicle);
  if (!title && !bullets.length) { const e = new Error('no vehicle data provided'); e.status = 400; throw e; }

  let blurb = '';
  try { blurb = await intro(vehicle); }
  catch (e) { if (e.status === 500) throw e; /* blurb optional — still return the structured listing */ }

  const parts = [];
  if (title) parts.push(title);
  if (blurb) parts.push('', blurb);
  if (bullets.length) parts.push('', 'Key details:', ...bullets);
  parts.push('', 'Dealer-inspected and ready to drive. Message us to schedule a test drive!');
  return parts.join('\n');
}

async function translate(text, targetLang) {
  if (!text || !text.trim()) return '';
  const lang = LANGS[targetLang] || targetLang || 'English';
  const model = STRONG_LANGS.has(targetLang) ? TRANSLATE_MODEL_STRONG : TRANSLATE_MODEL;
  const system = [
    `Translate the user's vehicle listing into ${lang}.`,
    'Preserve the exact line structure and bullet markers (•). Keep all numbers, prices, VIN, units, and proper nouns exactly as-is.',
    'Translate the field labels (Price, Mileage, Exterior, etc.). Output ONLY the translation — no notes, no quotes.'
  ].join(' ');
  return chat({ model, system, user: text, temperature: 0.2, maxTokens: 800 });
}

module.exports = { describe, translate, LANGS, DESCRIBE_MODEL, TRANSLATE_MODEL, TRANSLATE_MODEL_STRONG };
