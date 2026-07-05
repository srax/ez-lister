# Chrome Web Store submission — Carxpert Lightning Lister v0.2.1

Everything to paste into the dev console (chrome.google.com/webstore/devconsole). The item
was created (Draft) with ID `nfpnkiknibofeiicekdehonjmpnonaeh` via the one-time
`--first-upload` zip (key.pem at the zip root — see scripts/build-extension.js). Every
upload from now on uses the normal keyless build: `npm run build:ext:prod` →
`dist/carxpert-extension-prod-v<version>.zip`. The ID is fixed for the item's lifetime —
the backend's OAuth redirect and CORS depend on it staying `nfpn…`.
The old unlisted "ezlist" item (`ejagn…`) stays untouched; archive it once this is live.

## Listing

- **Name:** Carxpert Lightning Lister (taken from the manifest `name`, not this doc)
- **Summary (132 chars max):** List your dealership's inventory to Facebook Marketplace in
  one click — with AI descriptions, sync, and sales stats.
- **Category:** Workflow & Planning (or Tools)
- **Language:** English (US)

**Description:**

> Carxpert turns hours of re-typing into one click. Browse your dealership's inventory site,
> hit ⚡ List on any vehicle, and Carxpert fills the Facebook Marketplace "Vehicle for sale"
> form — photos, price, mileage, colors, description — in your own logged-in Facebook
> session. You review and click Publish yourself.
>
> • One-click extraction from your dealership website (DealerOn-powered sites supported today)
> • Accurate form fill: UK/US term mapping, color matching, price validation, up to 20 photos
> • AI-written descriptions and translations (optional)
> • Automatic sold detection: when a car leaves your website, your stats update
> • Sales dashboard: active listings, time-to-sale, inventory value
>
> Carxpert never auto-publishes and never touches your Facebook credentials. A subscription
> is required; sign in with Google to get started.

- **Visibility:** Unlisted for the pilot (flip to Public when ready).

## Privacy tab

- **Single purpose:** Re-post a car dealership's own vehicle inventory from its dealership
  website to Facebook Marketplace, with listing tracking and stats.
- **Privacy policy URL:** `https://carxpert-tools-backend-production.up.railway.app/privacy`

**Permission justifications:**

- `storage` — caches the vehicle draft, user preferences, and listing history locally so the
  side panel and form fill work across pages.
- `sidePanel` — the extension's main UI (vehicle review, description editing, stats) lives in
  Chrome's side panel.
- `identity` — Google sign-in for the user's Carxpert account (launchWebAuthFlow); no other
  account access.
- `alarms` — periodically flushes queued listing events to the user's account when the
  service worker was asleep.
- Host `www.alexandriatoyota.com` — reads vehicle data (VIN, price, specs, photos) from the
  dealership's own inventory pages to build the listing. V1 supports this pilot dealership;
  further dealer sites ship in updates.
- Host `*.facebook.com` — fills the Marketplace "Vehicle for sale" form in the user's session
  and detects when the user publishes. Never reads credentials; never auto-publishes.
- Host `carxpert-tools-backend-production.up.railway.app` — the extension's own backend:
  sign-in, subscription check, listing sync, AI text generation.

**Data usage disclosures (check exactly these):**

- Personally identifiable information: **yes** (email/name via Google sign-in) — used for
  app functionality, not sold, not shared for unrelated purposes.
- Authentication information: **no** (Facebook credentials are never accessed).
- Website content: **yes** (vehicle data from the dealership site) — app functionality only.
- Everything else (location, web history, user activity, personal communications,
  financial/health info): **no**.

## Known V1 limitations (roadmap, not blockers)

- One dealer host baked in; each new dealership platform/site needs a version bump (until we
  move dealer hosts to `optional_host_permissions`).
- Views/leads metrics show "coming soon" (Facebook-side scraping not shipped).
- Stripe runs in test mode until the live cutover (B4).
