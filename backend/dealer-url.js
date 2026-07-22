// Dealer URL normalization. The host parse is PURE (heavily tested); redirect-following is
// network (injectable fetch so it's testable too). Matching is EXACT host only — a lookalike
// domain must never resolve to a real dealership (contract requirement).

export const DEALER_UA =
  'CarxpertBot/0.2 (+https://carxpert-tools-backend-staging.up.railway.app; dealer inventory check)';

// Trim → add https:// if scheme missing → parse → lowercased host, no port/path/query/hash.
// Throws on empty / invalid / non-http(s).
export function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('url required');
  let s = raw.trim();
  if (!s) throw new Error('url required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) urls allowed');
  const host = u.hostname.toLowerCase().replace(/\.$/, ''); // hostname excludes the port
  if (!host || !host.includes('.')) throw new Error('invalid host');
  return host;
}

// Hosts the backend must never fetch server-side (SSRF hygiene): IP literals, localhost-ish
// names, and platform-internal suffixes. Alias matching still sees the input host — we just
// refuse to send requests toward them.
const BLOCKED_HOST_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[|^localhost$|\.(internal|local|localhost)$/i;
export function isBlockedHost(host) {
  return BLOCKED_HOST_RE.test(host || '');
}

// Does `host` belong to one of a dealership's alias domains? Exact match, or a dot-boundary
// subdomain of a www-stripped alias — 'inventory.dealer.com' matches alias 'www.dealer.com',
// while a lookalike 'evil-dealer.com' can never match (the '.' boundary is required). Used to
// pin a listing's source_url (and probe targets) to the dealership it claims to come from.
export function hostMatchesDomains(host, domains) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const d of domains || []) {
    const alias = String(d || '').toLowerCase().replace(/\.$/, '');
    if (!alias) continue;
    if (h === alias) return true;
    const apex = alias.replace(/^www\./, '');
    if (h === apex || h.endsWith(`.${apex}`)) return true;
  }
  return false;
}

// Follow redirects (max 3, GET, ~5s timeout, http(s) only) and return the FINAL host.
// Best-effort: any network/parse failure falls back to the last known host. Injectable
// fetchImpl for tests.
export async function resolveFinalHost(startUrl, { fetchImpl = fetch, maxRedirects = 3, timeoutMs = 5000 } = {}) {
  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': DEALER_UA }
      });
    } catch {
      clearTimeout(timer);
      break; // network error — use the host we have
    }
    clearTimeout(timer);
    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
    if (!location) break;
    let next;
    try {
      next = new URL(location, url);
    } catch {
      break;
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') break;
    if (isBlockedHost(next.hostname.toLowerCase())) break; // never follow a redirect inward
    url = next.toString();
  }
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

// Both hosts to match against aliases: the input host and (optionally) the post-redirect host.
export async function candidateHosts(raw, { allowNetwork = true, fetchImpl = fetch } = {}) {
  const inputHost = normalizeHost(raw);
  const hosts = [inputHost];
  if (allowNetwork && !isBlockedHost(inputHost)) {
    const finalHost = await resolveFinalHost(`https://${inputHost}`, { fetchImpl });
    if (finalHost && !hosts.includes(finalHost)) hosts.push(finalHost);
  }
  return { inputHost, hosts };
}
