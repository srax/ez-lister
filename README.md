# ezlist

ezlist turns Alexandria Toyota vehicle pages into Facebook Marketplace vehicle drafts.

The safe split is intentional:

- The Chrome extension reads structured vehicle data from the dealership page.
- The extension stores the draft locally and fills Facebook in the user's own browser session.
- The user reviews the listing and clicks Publish manually.
- The backend is kept as a local development/fallback service for fixtures and optional Firecrawl extraction.

## Run Backend

The main Alexandria Toyota flow does not require the backend. Run it only for local fixtures or fallback extraction:

```bash
npm run dev:backend
```

The backend listens on `http://127.0.0.1:3737`.

## Load Extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the `extension/` directory.

From Windows, the WSL path is usually available under:

```text
\\wsl.localhost\Ubuntu\home\hasnatrao\projects\auto_listing\extension
```

If the distro name differs, run:

```bash
wslpath -w extension
```

## Dedicated Test Chrome Profile

Do not use Guest mode. Guest mode is temporary and can lose the extension/login state.

Use a separate Chrome user-data directory instead:

```bash
./scripts/open-test-chrome.sh
```

Then load the unpacked extension into that Chrome window and log in to a legitimate Facebook account you are allowed to test with.

## Workflow

1. Load the unpacked extension.
2. Log into Facebook in the same Chrome profile.
3. Open the Alexandria Toyota inventory or vehicle detail page.
4. Click `⚡ List` on the specific vehicle. The Facebook vehicle form opens and **auto-fills** every field plus the photos.
5. Review every field and photo. (The panel's `Fill listing` button re-runs the fill if needed.)
6. Click Publish manually.

For a local smoke test before using a real dealer page, open:

```text
http://127.0.0.1:3737/fixtures/sample-inventory
```

## Notes

- The extension never receives Facebook credentials or cookies, and never sends data to any server.
- The extension does not auto-click Publish — the user always reviews and publishes.
- Photos are downloaded by the background service worker (bypassing Facebook's page CSP/CORS) and attached to the listing; up to 20 are uploaded.
- After reloading the extension, refresh any already-open dealership tab — content scripts only inject on fresh page loads.
- Facebook requires mileage ≥ 300 (lower values are left blank), marketing colours are mapped to Facebook's palette (unknowns left blank), and dealer pricing is taken as the largest plausible value — so always sanity-check the draft before publishing.
