import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, resolveFinalHost, candidateHosts } from './dealer-url.js';

test('normalizeHost: bare domain gets https + host only', () => {
  assert.equal(normalizeHost('alexandriatoyota.com'), 'alexandriatoyota.com');
});

test('normalizeHost: strips scheme-case, port, path, query, hash; lowercases', () => {
  assert.equal(normalizeHost('HTTPS://WWW.AlexandriaToyota.com:443/searchused.aspx?x=1#y'), 'www.alexandriatoyota.com');
});

test('normalizeHost: adds scheme to a www/path input', () => {
  assert.equal(normalizeHost('www.example.com/inventory'), 'www.example.com');
});

test('normalizeHost: trailing dot removed', () => {
  assert.equal(normalizeHost('example.com.'), 'example.com');
});

test('normalizeHost: lookalikes stay distinct (exact host, no fuzzy/suffix match)', () => {
  assert.equal(normalizeHost('alexandriatoyota.com.evil.com'), 'alexandriatoyota.com.evil.com');
  assert.equal(normalizeHost('wwwalexandriatoyota.com'), 'wwwalexandriatoyota.com');
  assert.notEqual(normalizeHost('alexandriatoyota.com.evil.com'), 'alexandriatoyota.com');
});

test('normalizeHost: rejects empty / non-http(s) / hostless', () => {
  assert.throws(() => normalizeHost(''));
  assert.throws(() => normalizeHost('   '));
  assert.throws(() => normalizeHost('ftp://example.com'));
  assert.throws(() => normalizeHost('javascript:alert(1)'));
  assert.throws(() => normalizeHost('localhost')); // no dot → invalid host
});

test('resolveFinalHost: follows a redirect via injected fetch', async () => {
  const seq = {
    'https://mydealership.com/': { status: 301, location: 'https://www.mydealership.com/' },
    'https://www.mydealership.com/': { status: 200, location: null }
  };
  const fetchImpl = async (url) => {
    const r = seq[url] || { status: 200, location: null };
    return { status: r.status, headers: { get: (h) => (h.toLowerCase() === 'location' ? r.location : null) } };
  };
  assert.equal(await resolveFinalHost('https://mydealership.com/', { fetchImpl }), 'www.mydealership.com');
});

test('resolveFinalHost: caps redirects, returns last host', async () => {
  const fetchImpl = async () => ({
    status: 301,
    headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://next.example.com/' : null) }
  });
  assert.equal(await resolveFinalHost('https://start.example.com/', { fetchImpl, maxRedirects: 2 }), 'next.example.com');
});

test('resolveFinalHost: network error falls back to the current host', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  assert.equal(await resolveFinalHost('https://oops.example.com/', { fetchImpl }), 'oops.example.com');
});

test('candidateHosts: input + final host, deduped', async () => {
  const fetchImpl = async () => ({
    status: 301,
    headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://www.foo.com/' : null) }
  });
  const { inputHost, hosts } = await candidateHosts('foo.com', { fetchImpl });
  assert.equal(inputHost, 'foo.com');
  assert.deepEqual(hosts, ['foo.com', 'www.foo.com']);
});

// ---- hostMatchesDomains: pins listings/probes to a dealership's own domains ----
import { hostMatchesDomains } from './dealer-url.js';

test('hostMatchesDomains: exact aliases and www/apex equivalence', () => {
  const domains = ['www.alexandriatoyota.com', 'alexandriatoyota.com'];
  assert.equal(hostMatchesDomains('www.alexandriatoyota.com', domains), true);
  assert.equal(hostMatchesDomains('alexandriatoyota.com', domains), true);
  assert.equal(hostMatchesDomains('ALEXANDRIATOYOTA.COM', domains), true); // case-insensitive
  assert.equal(hostMatchesDomains('alexandriatoyota.com.', domains), true); // trailing dot
});

test('hostMatchesDomains: subdomains of a www-stripped alias match (inventory subdomain gap)', () => {
  assert.equal(hostMatchesDomains('inventory.alexandriatoyota.com', ['www.alexandriatoyota.com']), true);
  assert.equal(hostMatchesDomains('m.alexandriatoyota.com', ['alexandriatoyota.com']), true);
});

test('hostMatchesDomains: lookalike domains never match (dot boundary required)', () => {
  assert.equal(hostMatchesDomains('evil-alexandriatoyota.com', ['alexandriatoyota.com']), false);
  assert.equal(hostMatchesDomains('alexandriatoyota.com.evil.com', ['alexandriatoyota.com']), false);
  assert.equal(hostMatchesDomains('notalexandriatoyota.com', ['www.alexandriatoyota.com']), false);
});

test('hostMatchesDomains: empty/garbage input is false, never throws', () => {
  assert.equal(hostMatchesDomains('', ['x.com']), false);
  assert.equal(hostMatchesDomains(null, ['x.com']), false);
  assert.equal(hostMatchesDomains('x.com', []), false);
  assert.equal(hostMatchesDomains('x.com', null), false);
  assert.equal(hostMatchesDomains('x.com', [null, '', 'x.com']), true);
});
