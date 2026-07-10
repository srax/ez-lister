import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDealerRequestEmail, emailConfigured, notifyDealerRequest } from './email.js';

test('buildDealerRequestEmail: subject + all fields, HTML-escaped', () => {
  const { subject, html, text } = buildDealerRequestEmail({
    url: 'https://www.example.com/',
    normalizedDomain: 'example.com',
    platform: 'dealerinspire',
    contactName: 'Jane <Doe>',
    contactEmail: 'jane@dealer.com',
    contactPhone: '555-1234',
    notes: 'please add us & thanks',
    accountEmail: 'user@acct.com',
    at: '2026-07-11T00:00:00.000Z',
    fingerprints: { diAssets: true }
  });
  assert.equal(subject, 'New dealership request: example.com');
  // fields present
  assert.match(html, /example\.com/);
  assert.match(html, /dealerinspire/);
  assert.match(html, /jane@dealer\.com/);
  assert.match(html, /user@acct\.com/);
  assert.match(text, /Contact email: jane@dealer\.com/);
  // HTML-escaped user input (no raw angle brackets / ampersand from the name/notes)
  assert.match(html, /Jane &lt;Doe&gt;/);
  assert.match(html, /please add us &amp; thanks/);
  assert.ok(!/Jane <Doe>/.test(html), 'name must be escaped');
});

test('buildDealerRequestEmail: falls back to url when no domain, tolerates empties', () => {
  const { subject, html } = buildDealerRequestEmail({ url: 'rameycars.com' });
  assert.equal(subject, 'New dealership request: rameycars.com');
  assert.match(html, /unknown \/ unsupported/); // platform default
});

test('emailConfigured / notifyDealerRequest: no-op (never throws) when unconfigured', async () => {
  const saved = { k: process.env.RESEND_API_KEY, f: process.env.EMAIL_FROM, t: process.env.EMAIL_TO_ADMIN };
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.EMAIL_TO_ADMIN;
  try {
    assert.equal(emailConfigured(), false);
    const r = await notifyDealerRequest({ url: 'x.com' });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true); // skipped, not an error
  } finally {
    if (saved.k) process.env.RESEND_API_KEY = saved.k;
    if (saved.f) process.env.EMAIL_FROM = saved.f;
    if (saved.t) process.env.EMAIL_TO_ADMIN = saved.t;
  }
});
