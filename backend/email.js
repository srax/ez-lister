// Transactional email via an HTTP API — no SMTP library, keeping the backend dep-light. Wired to
// Resend (POST https://api.resend.com/emails); swapping providers is a one-fetch change. Everything
// is env-configured and NO-OPS gracefully when unset, so a missing key never breaks the caller.
//
//   RESEND_API_KEY    Resend API key
//   EMAIL_FROM        verified sender, e.g. "CarXprt <requests@carxprt.com>"
//   EMAIL_TO_ADMIN    where internal requests go (comma-separated for multiple)
//
// User-facing transactional messages (such as organization invitations) need only
// RESEND_API_KEY + EMAIL_FROM. EMAIL_TO_ADMIN is intentionally not part of that gate.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.EMAIL_TO_ADMIN);
}

export function transactionalEmailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
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

// Compose the "From" line. The ADDRESS must stay on the verified domain (EMAIL_FROM) — you can't
// send as an arbitrary requester address (Resend blocks spoofing). But we can put the REQUESTER'S
// NAME as the display label, so the inbox shows "Jane Doe (via CarXprt)" and Reply-To routes to
// their real email — the standard contact-form pattern.
export function senderFrom(requesterName) {
  const base = (process.env.EMAIL_FROM || '').trim();
  const addr = (base.match(/<([^>]+)>/) || [null, base])[1].trim(); // address inside <>, else whole string
  const name = String(requesterName || '').replace(/["<>\r\n]/g, '').trim().slice(0, 60);
  return name ? `"${name} (via CarXprt)" <${addr}>` : (base || addr);
}

async function sendEmail({ to, subject, html, text, replyTo, fromName }) {
  if (!transactionalEmailConfigured()) {
    console.warn('[email] not configured (RESEND_API_KEY/EMAIL_FROM) — skipping:', subject);
    return { ok: false, skipped: true };
  }
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s || '').trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, skipped: true, reason: 'no_recipient' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: senderFrom(fromName), to: recipients, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
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
    return await sendEmail({
      to: (process.env.EMAIL_TO_ADMIN || '').split(',').map((s) => s.trim()).filter(Boolean),
      subject, html, text,
      fromName: details.contactName || undefined,   // inbox shows "<name> (via CarXprt)"
      replyTo: details.contactEmail || undefined    // Reply goes to the requester
    });
  } catch (e) {
    console.error('[email] notifyDealerRequest error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}

export function buildOrganizationInvitationEmail(details = {}) {
  const organizationName = String(details.organizationName || 'your dealership team').trim();
  const inviterName = String(details.inviterName || 'A dealership manager').trim();
  const role = String(details.role || 'salesperson').trim();
  const rooftops = Array.isArray(details.rooftopNames)
    ? details.rooftopNames.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const code = String(details.code || '').trim();
  const storeUrl = String(details.storeUrl || '').trim();
  const subject = `${inviterName} invited you to ${organizationName} on CarXprt`;
  const rooftopText = rooftops.length ? rooftops.join(', ') : 'the dealership team';
  const install = storeUrl
    ? `<p><a href="${esc(storeUrl)}" style="display:inline-block;background:#dfff39;color:#111;padding:10px 14px;text-decoration:none;font-weight:700;border-radius:6px">Open CarXprt</a></p>`
    : '';
  const html = `<h2 style="margin:0 0 8px">Join ${esc(organizationName)}</h2>`
    + `<p>${esc(inviterName)} invited you as a ${esc(role)} for ${esc(rooftopText)}.</p>`
    + `<p>Sign in to CarXprt with this email, choose <b>Join an existing team</b>, and enter this one-time code:</p>`
    + `<p style="font:700 18px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;background:#f5f5f7;padding:12px;border-radius:6px;word-break:break-all">${esc(code)}</p>`
    + `<p>This code expires in seven days and works only for the invited email address.</p>${install}`;
  const text = [
    `Join ${organizationName}`,
    '',
    `${inviterName} invited you as a ${role} for ${rooftopText}.`,
    'Sign in to CarXprt with this email, choose "Join an existing team", and enter this one-time code:',
    '',
    code,
    '',
    'This code expires in seven days and works only for the invited email address.',
    storeUrl ? `Open CarXprt: ${storeUrl}` : ''
  ].filter((line, index, all) => line || index < all.length - 1).join('\n');
  return { subject, html, text };
}

// Invitation persistence is authoritative; delivery is best-effort and never rolls the
// invitation back. The inviter receives the same one-time code in the API response as a
// fallback when email is unavailable.
export async function notifyOrganizationInvitation(details = {}) {
  try {
    const { subject, html, text } = buildOrganizationInvitationEmail(details);
    return await sendEmail({
      to: details.email,
      subject,
      html,
      text
    });
  } catch (e) {
    console.error('[email] notifyOrganizationInvitation error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}

export function buildOrganizationAccessRequestEmail(details = {}) {
  const organizationName = String(details.organizationName || 'your dealership team').trim();
  const dealershipName = String(details.dealershipName || 'your dealership').trim();
  const requesterName = String(details.requesterName || details.requesterEmail || 'A salesperson').trim();
  const requesterEmail = String(details.requesterEmail || '').trim();
  const requestedRole = String(details.requestedRole || 'salesperson').trim();
  const storeUrl = String(details.storeUrl || '').trim();
  const subject = `${requesterName} requested access to ${dealershipName} on CarXprt`;
  const open = storeUrl ? `\nOpen CarXprt: ${storeUrl}` : '';
  const html = `<h2 style="margin:0 0 8px">New team access request</h2>`
    + `<p><b>${esc(requesterName)}</b>${requesterEmail ? ` (${esc(requesterEmail)})` : ''} requested ${esc(requestedRole)} access to <b>${esc(dealershipName)}</b> in ${esc(organizationName)}.</p>`
    + '<p>Open CarXprt and review <b>Team → Access requests</b>. Approval is available only to an authenticated owner or authorized manager.</p>'
    + (storeUrl ? `<p><a href="${esc(storeUrl)}">Open CarXprt</a></p>` : '');
  const text = [
    'New team access request', '',
    `${requesterName}${requesterEmail ? ` (${requesterEmail})` : ''} requested ${requestedRole} access to ${dealershipName} in ${organizationName}.`,
    'Open CarXprt and review Team > Access requests. Approval requires an authenticated owner or authorized manager.',
    open
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}

export async function notifyOrganizationAccessRequest(details = {}) {
  try {
    const { subject, html, text } = buildOrganizationAccessRequestEmail(details);
    return await sendEmail({
      to: details.recipients || [],
      subject,
      html,
      text,
      replyTo: details.requesterEmail || undefined
    });
  } catch (e) {
    console.error('[email] notifyOrganizationAccessRequest error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}

export function buildOrganizationAccessDecisionEmail(details = {}) {
  const organizationName = String(details.organizationName || 'your dealership team').trim();
  const dealershipName = String(details.dealershipName || 'your dealership').trim();
  const role = String(details.role || 'salesperson').trim();
  const status = String(details.status || '').trim();
  const reason = String(details.reason || '').trim();
  const storeUrl = String(details.storeUrl || '').trim();
  const approved = status === 'approved';
  const waiting = status === 'approved_awaiting_capacity';
  const subject = approved
    ? `Your CarXprt access to ${dealershipName} was approved`
    : waiting
      ? `Your CarXprt access to ${dealershipName} is waiting for a seat`
      : `Update on your CarXprt access request for ${dealershipName}`;
  const heading = approved ? 'Team access approved' : waiting ? 'Approved, waiting for a seat' : 'Team access request declined';
  const message = approved
    ? `You now have ${role} access to ${dealershipName} in ${organizationName}.`
    : waiting
      ? `Your ${role} access to ${dealershipName} in ${organizationName} was approved, but the rooftop has no listing seat available yet. CarXprt will unlock automatically after capacity is added.`
      : `Your request for ${role} access to ${dealershipName} in ${organizationName} was not approved.${reason ? ` Reason: ${reason}` : ''}`;
  const html = `<h2 style="margin:0 0 8px">${esc(heading)}</h2><p>${esc(message)}</p>`
    + (storeUrl ? `<p><a href="${esc(storeUrl)}">Open CarXprt</a></p>` : '');
  const text = [heading, '', message, storeUrl ? `Open CarXprt: ${storeUrl}` : ''].filter(Boolean).join('\n');
  return { subject, html, text };
}

export async function notifyOrganizationAccessDecision(details = {}) {
  try {
    const { subject, html, text } = buildOrganizationAccessDecisionEmail(details);
    return await sendEmail({ to: details.email, subject, html, text });
  } catch (e) {
    console.error('[email] notifyOrganizationAccessDecision error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}

export function buildOrganizationRoleChangedEmail(details = {}) {
  const organizationName = String(details.organizationName || 'your dealership team').trim();
  const role = String(details.role || 'salesperson').trim();
  const roleLabel = role === 'manager' ? 'Manager' : 'Salesperson';
  const storeUrl = String(details.storeUrl || '').trim();
  const subject = `Your CarXprt role in ${organizationName} is now ${roleLabel}`;
  const message = role === 'manager'
    ? `An organization owner changed your role in ${organizationName} to Manager. You can review team activity and manage salespeople within your assigned dealership locations.`
    : `An organization owner changed your role in ${organizationName} to Salesperson. Listing access depends on the dealership seats assigned to you.`;
  const html = `<h2 style="margin:0 0 8px">Role updated</h2><p>${esc(message)}</p>`
    + (storeUrl ? `<p><a href="${esc(storeUrl)}">Open CarXprt</a></p>` : '');
  const text = ['Role updated', '', message, storeUrl ? `Open CarXprt: ${storeUrl}` : ''].filter(Boolean).join('\n');
  return { subject, html, text };
}

export async function notifyOrganizationRoleChanged(details = {}) {
  try {
    const { subject, html, text } = buildOrganizationRoleChangedEmail(details);
    return await sendEmail({ to: details.email, subject, html, text });
  } catch (e) {
    console.error('[email] notifyOrganizationRoleChanged error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}

export function buildOwnershipTransferEmail(details = {}) {
  const organizationName = String(details.organizationName || 'your dealership team').trim();
  const ownerName = String(details.currentOwnerName || 'The current owner').trim();
  const code = String(details.code || '').trim();
  const storeUrl = String(details.storeUrl || '').trim();
  const subject = `${ownerName} asked you to become the CarXprt owner for ${organizationName}`;
  const html = `<h2 style="margin:0 0 8px">Accept ownership of ${esc(organizationName)}</h2>`
    + `<p>${esc(ownerName)} started an ownership transfer to you.</p>`
    + `<p>Open the CarXprt team view while signed in with this email and enter this one-time code:</p>`
    + `<p style="font:700 18px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;background:#f5f5f7;padding:12px;border-radius:6px;word-break:break-all">${esc(code)}</p>`
    + `<p>The code expires in 24 hours. Accepting gives you billing and organization control; the former owner remains an all-rooftop manager.</p>`
    + (storeUrl ? `<p><a href="${esc(storeUrl)}">Open CarXprt</a></p>` : '');
  const text = [
    `Accept ownership of ${organizationName}`,
    '',
    `${ownerName} started an ownership transfer to you.`,
    'Open the CarXprt team view while signed in with this email and enter this one-time code:',
    '',
    code,
    '',
    'The code expires in 24 hours. Accepting gives you billing and organization control; the former owner remains an all-rooftop manager.',
    storeUrl ? `Open CarXprt: ${storeUrl}` : ''
  ].filter((line, index, all) => line || index < all.length - 1).join('\n');
  return { subject, html, text };
}

export async function notifyOwnershipTransfer(details = {}) {
  try {
    const { subject, html, text } = buildOwnershipTransferEmail(details);
    return await sendEmail({ to: details.email, subject, html, text });
  } catch (e) {
    console.error('[email] notifyOwnershipTransfer error', (e && e.message) || e);
    return { ok: false, error: 'notify error' };
  }
}
