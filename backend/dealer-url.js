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
  if (allowNetwork) {
    const finalHost = await resolveFinalHost(`https://${inputHost}`, { fetchImpl });
    if (finalHost && !hosts.includes(finalHost)) hosts.push(finalHost);
  }
  return { inputHost, hosts };
}
