import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFromHtml, siteNameFromHtml } from './detect.js';
import { resolveDealer, slugFromHost } from './dealerships.js';

const DEALERON_HTML = `<!doctype html><html><head>
<title>Toyota Direct | New &amp; Used Toyota Dealer in Columbus OH</title>
<meta property="og:site_name" content="Toyota Direct">
</head><body>
<a href="/searchnew.aspx">New</a> <a href="/searchused.aspx">Used</a>
<img src="/inventoryphotos/1234/vin123/ip/1.jpg">
<a href="/sitemap.aspx">sitemap</a>
<footer>Website by DealerOn</footer>
</body></html>`;

const OTHER_HTML = '<html><head><title>Some Dealer</title></head><body>Powered by CustomCMS</body></html>';

const DEALERCOM_HTML = `<html><head><title>Chevy of Attleboro</title></head><body>
<a href="/used-inventory/index.htm">Used</a>
<img src="https://pictures.dealer.com/c/acct/0701/abc123x.jpg">
<div class="ddc-content"></div>
</body></html>`;

test('evidenceFromHtml: DealerOn markers all detected (Dealer.com markers stay off)', () => {
  const e = evidenceFromHtml(DEALERON_HTML);
  assert.deepEqual(e, {
    mentionsDealerOn: true, hasSitemapAspx: true, hasSearchNew: true, hasSearchUsed: true, hasInventoryPhotos: true,
    mentionsDealerDotCom: false, serverDdcInventoryPath: false
  });
});

test('evidenceFromHtml: Dealer.com markers detected (when not Akamai-walled)', () => {
  const e = evidenceFromHtml(DEALERCOM_HTML);
  assert.equal(e.mentionsDealerDotCom, true);
  assert.equal(e.serverDdcInventoryPath, true);
  assert.equal(e.mentionsDealerOn, false);
});

test('evidenceFromHtml: unknown-platform site scores nothing', () => {
  const e = evidenceFromHtml(OTHER_HTML);
  assert.equal(Object.values(e).some(Boolean), false);
});

test('siteNameFromHtml: og:site_name beats title; title is fallback; fallback of last resort', () => {
  assert.equal(siteNameFromHtml(DEALERON_HTML), 'Toyota Direct');
  assert.equal(siteNameFromHtml(OTHER_HTML), 'Some Dealer');
  assert.equal(siteNameFromHtml('<html></html>', 'apex.com'), 'apex.com');
});

test('slugFromHost strips www and non-alphanumerics', () => {
  assert.equal(slugFromHost('www.toyotadirect.com'), 'toyotadirect-com');
  assert.equal(slugFromHost('downtown.chevyman.com'), 'downtown-chevyman-com');
});

// ---- auto-onboard round trip against a fake db + fake fetch ----

function autoDb() {
  const dealers = new Map();
  const aliases = new Map();
  return {
    dealers,
    aliases,
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.includes('join dealership_aliases')) {
        for (const h of params[0]) {
          const id = aliases.get(h);
          if (id) {
            const d = dealers.get(id);
            return { rows: [{ ...d, domains: [...aliases].filter(([, v]) => v === id).map(([k]) => k) }] };
          }
        }
        return { rows: [] };
      }
      if (q.startsWith('select id from dealerships')) {
        return { rows: dealers.has(params[0]) ? [{ id: params[0] }] : [] };
      }
      if (q.startsWith('insert into dealerships')) {
        dealers.set(params[0], {
          id: params[0], name: params[1], platform: params[2], status: 'supported',
          timezone: params[3], config: JSON.parse(params[4])
        });
        return { rows: [] };
      }
      if (q.startsWith('insert into dealership_aliases')) {
        aliases.set(params[0], params[1]);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

const fakeFetch = (html) => async (url) => ({
  ok: true,
  status: 200,
  url,
  headers: { get: () => null },
  text: async () => html
});

test('resolveDealer auto-onboards an unknown DealerOn site', async () => {
  const db = autoDb();
  const r = await resolveDealer(
    { url: 'https://www.toyotadirect.com/' },
    { db, allowNetwork: true, fetchImpl: fakeFetch(DEALERON_HTML) }
  );
  assert.equal(r.supported, true);
  assert.equal(r.autoOnboarded, true);
  assert.equal(r.dealership.platform, 'dealeron');
  assert.equal(r.dealership.name, 'Toyota Direct');
  assert.ok(db.aliases.has('www.toyotadirect.com') && db.aliases.has('toyotadirect.com'));
  assert.equal(db.dealers.get('toyotadirect-com').config.sitemapUrl, 'https://www.toyotadirect.com/sitemap.aspx');
});

test('resolveDealer auto-onboards a Dealer.com site from client fingerprints when the server fetch is Akamai-walled', async () => {
  const db = autoDb();
  // Akamai 403s the backend fetch → no server evidence; only the extension's live-DOM probe reaches us.
  const walled = async () => ({ ok: false, status: 403, url: '', headers: { get: () => null }, text: async () => '' });
  const r = await resolveDealer(
    {
      url: 'https://www.attleborochevrolet.com/',
      fingerprints: {
        source: 'extension_manual', host: 'www.attleborochevrolet.com',
        ddcNamespace: true, siteName: 'Chevrolet Buick GMC of Attleboro'
      }
    },
    { db, allowNetwork: true, fetchImpl: walled }
  );
  assert.equal(r.supported, true);
  assert.equal(r.autoOnboarded, true);
  assert.equal(r.dealership.platform, 'dealercom');
  assert.equal(r.dealership.name, 'Chevrolet Buick GMC of Attleboro'); // client probe named the row
  assert.ok(db.aliases.has('www.attleborochevrolet.com') && db.aliases.has('attleborochevrolet.com'));
});

test('resolveDealer GENERIC-onboards an unrecognized platform that exposes schema.org dealer data', async () => {
  const db = autoDb();
  const walled = async () => ({ ok: false, status: 403, url: '', headers: { get: () => null }, text: async () => '' });
  const r = await resolveDealer(
    {
      url: 'https://www.classicchevrolet.com/',
      fingerprints: { source: 'extension_manual', host: 'www.classicchevrolet.com', hasSchemaAutoDealer: true, siteName: 'Classic Chevrolet' }
    },
    { db, allowNetwork: true, fetchImpl: walled }
  );
  assert.equal(r.supported, true);
  assert.equal(r.autoOnboarded, true);
  assert.equal(r.dealership.platform, 'generic');
  assert.equal(r.dealership.name, 'Classic Chevrolet');
});

test('a SPECIFIC platform still wins over generic even when schema.org is also present', async () => {
  const db = autoDb();
  const walled = async () => ({ ok: false, status: 403, url: '', headers: { get: () => null }, text: async () => '' });
  const r = await resolveDealer(
    { url: 'https://x.example.com/', fingerprints: { host: 'x.example.com', ddcNamespace: true, hasSchemaAutoDealer: true, hasSchemaVehicle: true } },
    { db, allowNetwork: true, fetchImpl: walled }
  );
  assert.equal(r.supported, true);
  assert.equal(r.dealership.platform, 'dealercom'); // specific detection beats the generic fallback
});

test('resolveDealer does NOT generic-onboard a site with no schema.org / platform signal', async () => {
  const db = autoDb();
  const walled = async () => ({ ok: false, status: 403, url: '', headers: { get: () => null }, text: async () => '' });
  const r = await resolveDealer(
    { url: 'https://random.example.com/', fingerprints: { host: 'random.example.com' } },
    { db, allowNetwork: true, fetchImpl: walled }
  );
  assert.equal(r.supported, false);
  assert.equal(db.dealers.size, 0);
});

test('resolveDealer does NOT auto-onboard a non-DealerOn site', async () => {
  const db = autoDb();
  const r = await resolveDealer(
    { url: 'https://downtown.example.com/' },
    { db, allowNetwork: true, fetchImpl: fakeFetch(OTHER_HTML) }
  );
  assert.equal(r.supported, false);
  assert.equal(db.dealers.size, 0);
});

test('resolveDealer still matches an existing supported dealership first', async () => {
  const db = autoDb();
  db.dealers.set('alexandria-toyota', { id: 'alexandria-toyota', name: 'Alexandria Toyota', platform: 'dealeron', status: 'supported', config: {} });
  db.aliases.set('www.alexandriatoyota.com', 'alexandria-toyota');
  const r = await resolveDealer(
    { url: 'https://www.alexandriatoyota.com/' },
    { db, allowNetwork: false }
  );
  assert.equal(r.supported, true);
  assert.equal(r.autoOnboarded, undefined);
  assert.equal(r.dealership.id, 'alexandria-toyota');
});