import test from 'node:test';
import assert from 'node:assert/strict';

import { describe, translate, TRANSLATE_MODEL } from './ai.js';

test('describe revises the current copy using dealer instructions and trusted vehicle facts', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: 'A polished, factual vehicle description.' } }] };
      }
    };
  };

  const result = await describe({
    year: 2016,
    make: 'BMW',
    model: '2 Series 228i',
    mileage: 74500,
    drivetrain: 'All-wheel drive',
    engine: '2.0L 4-cylinder',
    fuelEconomy: '23 city / 35 highway MPG',
    historyReportUrl: 'https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=TESTVIN',
    sourceUrl: 'https://www.keithsautosales.com/vehicles/example'
  }, {
    instructions: 'Make it more formal and include the CARFAX link.',
    currentDescription: 'Original dealership copy.'
  });

  assert.equal(result, [
    'A polished, factual vehicle description.',
    '',
    'https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=TESTVIN'
  ].join('\n'));
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-openai-key');
  const system = request.body.messages.find((message) => message.role === 'system').content;
  const user = request.body.messages.find((message) => message.role === 'user').content;
  assert.match(system, /SEO-friendly/i);
  assert.match(system, /never invent/i);
  assert.match(system, /1,000 characters/i);
  assert.doesNotMatch(user, /Description format:/i);
  assert.match(user, /Dealer instructions:\s*Make it more formal and include the CARFAX link\./i);
  assert.match(user, /Current description:\s*Original dealership copy\./i);
  assert.match(user, /Drivetrain:\s*All-wheel drive/i);
  assert.match(user, /Fuel economy:\s*23 city \/ 35 highway MPG/i);
  assert.match(user, /History report URL:\s*https:\/\/www\.carfax\.com\//i);
});

test('describe rejects unsupported AI claims, removes a duplicate trim, and preserves a requested source URL', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: [
          '2014 Nissan Versa Note SV SV',
          '',
          'Price: $6,950',
          'Mileage: 86,185 miles',
          'VIN: 3N1CE2CP2EL414588',
          'Stock #: 7149',
          '',
          'Dealer-inspected and ready to drive.'
        ].join('\n') } }]
      };
    }
  });

  const result = await describe({
    year: 2014,
    make: 'Nissan',
    model: 'Versa Note SV',
    trim: 'SV',
    price: 6950,
    mileage: 86185,
    vin: '3N1CE2CP2EL414588',
    stock: '7149',
    sourceUrl: 'https://www.vlautosales.com/Inventory/Details/example'
  }, {
    instructions: 'Make it more formal and preserve the exact source URL.'
  });

  assert.match(result, /^2014 Nissan Versa Note SV$/m);
  assert.doesNotMatch(result, /SV SV/i);
  assert.doesNotMatch(result, /dealer[- ]?inspected|ready to drive/i);
  assert.match(result, /\$6,950/);
  assert.match(result, /86,185 miles/);
  assert.match(result, /3N1CE2CP2EL414588/);
  assert.match(result, /Stock #:\s*7149/i);
  assert.match(result, /https:\/\/www\.vlautosales\.com\/Inventory\/Details\/example/);
});

test('describe fallback does not repeat a trim already present in the model', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() { return { error: { message: 'temporarily unavailable' } }; }
  });

  const result = await describe({
    year: 2014,
    make: 'Nissan',
    model: 'Versa Note SV',
    trim: 'SV',
    price: 6950
  });

  assert.match(result, /^2014 Nissan Versa Note SV$/m);
  assert.doesNotMatch(result, /SV SV/i);
});

test('describe preserves the current description when OpenAI is temporarily unavailable', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() { return { error: { message: 'temporarily unavailable' } }; }
  });

  const current = 'Keep this exact current description.';
  const result = await describe(
    { year: 2015, make: 'Volkswagen', model: 'Golf SportWagen' },
    { currentDescription: current, instructions: 'Make it simpler.' }
  );

  assert.equal(result, current);
  assert.doesNotMatch(result, /dealer-inspected/i);
});

test('describe sends the selected distance unit and Add mileage choice as factual constraints', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content: 'Grounded copy.' } }] }; }
    };
  };

  const vehicle = { year: 2018, make: 'Buick', model: 'Encore Preferred', mileage: 91280 };
  await describe(vehicle, { distanceUnit: 'km', includeMileage: true });
  await describe(vehicle, { distanceUnit: 'mi', includeMileage: false });

  const withMileageSystem = requests[0].messages.find((message) => message.role === 'system').content;
  const withMileageUser = requests[0].messages.find((message) => message.role === 'user').content;
  assert.match(withMileageSystem, /use only kilometers \(km\)/i);
  assert.match(withMileageUser, /Mileage:\s*146,901 km/i);
  assert.doesNotMatch(withMileageUser, /91,280 miles/i);

  const withoutMileageSystem = requests[1].messages.find((message) => message.role === 'system').content;
  const withoutMileageUser = requests[1].messages.find((message) => message.role === 'user').content;
  assert.match(withoutMileageSystem, /turned Add mileage off/i);
  assert.doesNotMatch(withoutMileageUser, /^Mileage:/im);
});

test('translate uses GPT-5.6 Luna for every language with explicit no-reasoning settings', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content: 'Translated listing.' } }] }; }
    };
  };

  for (const language of ['es', 'fa', 'ur']) {
    assert.equal(await translate('Mileage: 146,901 km\nVIN: KL4CJASB9JB719925', language), 'Translated listing.');
  }

  assert.equal(TRANSLATE_MODEL, 'gpt-5.6-luna');
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.body.model, 'gpt-5.6-luna');
    assert.equal(request.body.reasoning_effort, 'none');
    assert.equal(request.body.max_completion_tokens, 800);
    assert.equal('temperature' in request.body, false);
    assert.equal('max_tokens' in request.body, false);
    const system = request.body.messages.find((message) => message.role === 'system').content;
    assert.match(system, /naturally and fluently/i);
    assert.match(system, /distance value\/unit/i);
  }
});
