import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDealerRequestEmail,
  buildOrganizationInvitationEmail,
  buildOwnershipTransferEmail,
  emailConfigured,
  notifyDealerRequest,
  senderFrom,
  transactionalEmailConfigured
} from './email.js';

test('senderFrom: requester name becomes the display label; address stays on the verified domain', () => {
  const saved = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'CarXprt <no-reply@carxprt.com>';
  try {
    assert.equal(senderFrom('Jane Doe'), '"Jane Doe (via CarXprt)" <no-reply@carxprt.com>');
    // display name can't smuggle a different address / break the header
    assert.equal(senderFrom('Bad <x@evil.com>'), '"Bad x@evil.com (via CarXprt)" <no-reply@carxprt.com>');
    // no name → fall back to the configured EMAIL_FROM
    assert.equal(senderFrom(''), 'CarXprt <no-reply@carxprt.com>');
    // bare address form for EMAIL_FROM still works
    process.env.EMAIL_FROM = 'no-reply@carxprt.com';
    assert.equal(senderFrom('Jane'), '"Jane (via CarXprt)" <no-reply@carxprt.com>');
  } finally { process.env.EMAIL_FROM = saved; }
});

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

test('buildOrganizationInvitationEmail: includes scope, one-time code, expiry, and escapes input', () => {
  const { subject, html, text } = buildOrganizationInvitationEmail({
    organizationName: 'Stevens <Auto>',
    inviterName: 'Jane Manager',
    role: 'salesperson',
    rooftopNames: ['Stevens Toyota', 'Stevens Kia'],
    code: 'invite-secret',
    storeUrl: 'https://chromewebstore.google.com/detail/carxprt/example'
  });
  assert.match(subject, /Jane Manager invited you/);
  assert.match(html, /Stevens &lt;Auto&gt;/);
  assert.match(html, /Stevens Toyota, Stevens Kia/);
  assert.match(html, /invite-secret/);
  assert.match(text, /expires in seven days/);
  assert.match(text, /chromewebstore\.google\.com/);
});

test('buildOwnershipTransferEmail names the authority change, code, and expiry', () => {
  const { subject, html, text } = buildOwnershipTransferEmail({
    organizationName: 'Stevens <Group>',
    currentOwnerName: 'Jane Owner',
    code: 'owner-secret'
  });
  assert.match(subject, /Jane Owner asked you/);
  assert.match(html, /Stevens &lt;Group&gt;/);
  assert.match(html, /owner-secret/);
  assert.match(text, /expires in 24 hours/);
  assert.match(text, /former owner remains an all-rooftop manager/);
});

test('transactionalEmailConfigured does not require the admin recipient', () => {
  const saved = { k: process.env.RESEND_API_KEY, f: process.env.EMAIL_FROM, t: process.env.EMAIL_TO_ADMIN };
  process.env.RESEND_API_KEY = 're_test';
  process.env.EMAIL_FROM = 'CarXprt <no-reply@carxprt.com>';
  delete process.env.EMAIL_TO_ADMIN;
  try {
    assert.equal(transactionalEmailConfigured(), true);
    assert.equal(emailConfigured(), false);
  } finally {
    if (saved.k == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.k;
    if (saved.f == null) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = saved.f;
    if (saved.t == null) delete process.env.EMAIL_TO_ADMIN; else process.env.EMAIL_TO_ADMIN = saved.t;
  }
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
