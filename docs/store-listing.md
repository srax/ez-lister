# Chrome Web Store submission — CarXprt Lightning Lister v0.3.0

Use this as the source of truth for the Chrome Web Store dashboard. The existing item ID is
`nfpnkiknibofeiicekdehonjmpnonaeh`; update uploads use the normal keyless production build:

```sh
PROD_BACKEND_URL=https://carxpert-tools-backend-production.up.railway.app npm run build:ext:prod
```

Upload `dist/carxpert-extension-prod-v0.3.0.zip`. Never use `--first-upload` for an update.
The extension ID is fixed for the item's lifetime, and the backend OAuth redirect and CORS
configuration depend on it.

## Store listing

- **Name:** CarXprt Lightning Lister
- **Summary (132 characters max):** Turn dealership inventory into ready-to-review Facebook
  Marketplace and Craigslist vehicle drafts.
- **Category:** Tools
- **Language:** English (United States)

**Description:**

> CarXprt Lightning Lister helps dealership salespeople turn vehicles from supported dealership
> inventory pages into ready-to-review Facebook Marketplace and Craigslist drafts.
>
> Open a supported inventory page, choose a vehicle, review its details, and fill the destination
> form in the browser session you already use. CarXprt can transfer the vehicle's photos, price,
> mileage, VIN, colors, specifications, source link, and description where the destination form
> supports those fields.
>
> • Fill Facebook Marketplace and Craigslist vehicle drafts without retyping every field
> • Review and adjust vehicle details before they are sent to the destination form
> • Generate or revise an SEO-friendly listing description with your own AI instructions
> • Translate the current description into Spanish, Urdu, or Farsi
> • Use miles or kilometers while keeping the selected unit consistent in the listing
> • Keep a private history of listings and dealership sales activity
>
> CarXprt does not collect Facebook credentials and never clicks Publish. You remain responsible
> for reviewing the completed draft and publishing it yourself. Google sign-in and an active
> CarXprt subscription are required.

## Privacy tab

- **Single purpose:** Help dealership staff transfer vehicle data from supported dealership
  inventory pages into ready-to-review Facebook Marketplace and Craigslist listing forms, with
  optional AI-assisted descriptions and private listing history.
- **Privacy policy URL:**
  `https://carxpert-tools-backend-production.up.railway.app/privacy`

### Permission justifications

- `storage` — stores the signed-in account state, selected dealership/workspace, vehicle drafts,
  user preferences, queued synchronization events, and private listing history needed across
  dealership and destination tabs.
- `sidePanel` — provides the extension's main interface for vehicle review, AI instructions,
  translations, listing actions, account controls, and stats.
- `activeTab` — inspects the dealership tab only after the user invokes CarXprt, so dealership
  detection can work without permanent access to every site.
- `identity` — opens the Google sign-in flow and returns a one-time code to this extension. It is
  not used to access unrelated Google account data.
- `alarms` — refreshes account entitlement, synchronizes queued listing events, and checks tracked
  inventory periodically while the MV3 service worker is asleep.
- `scripting` — registers or injects CarXprt's own packaged dealership content script after the
  user grants access to a supported dealership host. It does not download or execute remote code.
- Optional host `https://*/*` — lets the user explicitly grant access to their own supported
  dealership website when it is not one of the preconfigured pilot hosts. Access is requested for
  the detected dealership host, not silently granted to all sites.
- Hosts `www.alexandriatoyota.com`, `*.vlautosales.com`, and `*.keithsautosales.com` — read the
  dealership's public vehicle inventory fields and photos to prepare a listing draft for the pilot
  dealerships.
- Hosts `*.carsforsale.com` and `photos.autocorner.com` — retrieve public vehicle detail or image
  resources referenced by supported dealership inventory pages.
- Host `*.facebook.com` — fills the Facebook Marketplace "Vehicle for sale" form in the user's
  existing session and observes the listing flow for status updates. It never reads Facebook
  credentials and never clicks Publish.
- Host `post.craigslist.org` — fills the Craigslist vehicle form in the user's existing session.
  It never clicks Publish.
- Host `carxpert-tools-backend-production.up.railway.app` — accesses Carxprt's own backend for
  sign-in, subscription and dealership access checks, listing synchronization, and AI text
  generation.

### Data usage disclosures

Select only the categories the current production package handles:

- Personally identifiable information: **yes** — Google account name and email are used for
  account functionality and dealership access.
- Authentication information: **no** — Carxprt never reads Facebook or Craigslist credentials;
  the Carxprt bearer session is an application session rather than a password collected from the
  user.
- User activity: **yes** — user-initiated listing events and outcomes are recorded to provide
  private history and dealership stats.
- Website content: **yes** — public vehicle information and photos are read from supported
  dealership pages and written to user-selected listing forms.
- Location, web history, personal communications, financial/payment information, and health
  information: **no**.

The required limited-use certifications must remain checked. Data is used only to deliver the
listing/account functionality, is not sold, and is not used for unrelated advertising or lending.

## Distribution and publishing

- `Contains in-app purchases`: **yes** (an active subscription is required).
- Regions: all regions unless product or legal scope changes.
- Visibility for the broad launch: **Public**. Use **Unlisted** instead while access is limited to
  invited pilots.
- Submit with **deferred publishing**. Approval should stage v0.3.0 without automatically replacing
  the currently published version; manually publish after the approved build passes a final smoke
  test.

## Test instructions

The reviewer needs an entitled Carxprt test account because the core workflow is behind Google
sign-in and subscription checks. Create a dedicated Google reviewer account, grant it an active
test entitlement and a supported dealership connection, then enter its credentials directly in
the confidential Chrome Web Store **Test instructions** fields. Never put the password in this
repository or chat.

Suggested additional instructions:

> 1. Sign in to CarXprt with the reviewer Google account supplied above.
> 2. The account is already entitled and connected to Alexandria Toyota.
> 3. Open `https://www.alexandriatoyota.com/searchused.aspx`, then click the CarXprt toolbar icon.
> 4. Select a vehicle with its List button and choose Facebook or Craigslist. CarXprt prepares a
>    draft; no listing is published automatically.
> 5. If testing Facebook or Craigslist form fill, sign in to that third-party site with your own
>    reviewer account. Click Fill listing and confirm that fields are populated. Stop before the
>    site's final Publish/Post action.
> 6. AI description generation and translation are optional and operate on the selected vehicle's
>    draft text.

## Release boundary

- Production keeps dealership-organization features disabled until the separate organization,
  rooftop, role, seat, and billing rollout is approved.
- Sold/inventory scanning runs only for dealership platforms with a server-side scan adapter;
  AutoCorner and CarsForSale pilot sites are not scheduled for unsupported scans.
- The extension fills drafts and stops before every destination's final publish action.
