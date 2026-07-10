// Transactional email via an HTTP API — no SMTP library, keeping the backend dep-light. Wired to
// Resend (POST https://api.resend.com/emails); swapping providers is a one-fetch change. Everything
// is env-configured and NO-OPS gracefully when unset, so a missing key never breaks the caller.
//
//   RESEND_API_KEY    Resend API key
//   EMAIL_FROM        verified sender, e.g. "CarXprt <requests@carxprt.com>"
//   EMAIL_TO_ADMIN    where requests go (comma-separated for multiple)

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.EMAIL_TO_ADMIN);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Pure formatter (exported for tests): a dealer-request notification's subject/html/text.
export function buildDealerRequestEmail(d = {}) {
  const subject = `New dealership request: ${d.normalizedDomain || d.url || 'unknown site'}`;
  const row = (k, v) => (v ? `<tr><td style="padding:4px 12px;font-weight:600;white-space:nowrap">${esc(k)}</td><td style="padding:4px 12px">${esc(v)}</td></tr>` : '');
  const html = `<h2 style="margin:0 0 8px">New dealership platform request</h2>`
    + `<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">`
    + row('Dealership URL', d.url)
    + row('Domain', d.normalizedDomain)
    + row('Detected platform', d.platform || 'unknown / unsupported')
    + row('Contact name', d.contactName)
    + row('Contact email', d.contactEmail)
    + row('Contact phone', d.contactPhone)
    + row('Notes', d.notes)
    + row('Signed-in account', d.accountEmail)
    + row('Submitted at', d.at)
    + `</table>`
    + (d.fingerprints ? `<pre style="background:#f5f5f7;padding:8px;border-radius:6px;font-size:12px;overflow:auto">${esc(JSON.stringify(d.fingerprints, null, 2)).slice(0, 1500)}</pre>` : '');
  const text = [
    'New dealership platform request', '',
    `Dealership URL: ${d.url || ''}`,
    `Domain: ${d.normalizedDomain || ''}`,
    `Detected platform: ${d.platform || 'unknown / unsupported'}`,
    `Contact name: ${d.contactName || ''}`,
    `Contact email: ${d.contactEmail || ''}`,
    `Contact phone: ${d.contactPhone || ''}`,
    `Notes: ${d.notes || ''}`,
    `Signed-in account: ${d.accountEmail || ''}`,
    `Submitted at: ${d.at || ''}`
  ].join('\n');
  return { subject, html, text };
}

async function sendEmail({ subject, html, text, replyTo }) {
  if (!emailConfigured()) {
    console.warn('[email] not configured (RESEND_API_KEY/EMAIL_FROM/EMAIL_TO_ADMIN) — skipping:', subject);
    return { ok: false, skipped: true };
  }
  const to = process.env.EMAIL_TO_ADMIN.split(',').map((s) => s.trim()).filter(Boolean);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: controller.signal
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[email] send failed', resp.status, body.slice(0, 200));
      return { ok: false, status: resp.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[email] send error', (e && e.message) || e);
    return { ok: false, error: (e && e.message) || 'send error' };
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort: build + send a dealer-request notification. Never throws.
export async function notifyDealerRequest(details = {}) {
  try {
    const { subject, html, text } = buildDealerRequestEmail(details);
    return await sendEmail({ subject, html, text, replyTo: details.contactEmail || undefined });
  } catch (e) {
    console.error('[email] notifyDealerRequest error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}
