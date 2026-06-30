# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Carxpert** (the repo/README/AGENTS still say "ezlist" — same project, rebranded) is a Chrome MV3 extension that re-posts a car dealership's inventory to Facebook Marketplace. It reads each vehicle from the dealership page, fills the Marketplace "Vehicle for sale" form in the user's own logged-in session, and the user reviews + clicks Publish. There is also a small local backend that proxies AI calls. See `AGENTS.md` for coding conventions, commit style, and file-by-file structure — this doc covers the cross-cutting architecture and the things that will bite you.

## Commands

- `npm run dev:backend` — backend on `http://127.0.0.1:3737`. AI routes need `OPENAI_API_KEY` (shell env or `backend/.env`).
- `npm run check` — `node --check` over backend + extension JS (fast sanity before reloading).
- `npm test` — Node's built-in test runner. Single file: `node --test backend/normalize.test.js`.
- `./scripts/open-test-chrome.sh` — launches Windows Chrome on a dedicated profile with `--remote-debugging-port=9222` and the extension auto-loaded (`--load-extension`). This is how live testing is done.
- Package the extension: `cd extension && zip -rq ../dist/carxpert-extension-v0.2.0.zip .`
- After reloading the unpacked extension, **refresh any already-open dealer/Facebook tabs** — content scripts only inject on fresh page loads.

## Architecture: three runtime contexts

Everything is message-passing between three MV3 contexts over `chrome.runtime` + `chrome.storage.local`, with `EZLIST_*` message types. Understanding a flow means reading all three:

1. **Content scripts** (isolated world, injected per matched host):
   - `extension/dealerContent.js` (dealership site): injects ⚡ List buttons per car, extracts the vehicle straight from DealerOn `data-*` attributes (no scraping/regex), and paints a button green **✓ Added** when its VIN is in `ezlistListedVins`.
   - `extension/facebookContent.js` (facebook.com): the form-fill engine for `/marketplace/create/vehicle`, plus publish-detection. Has **no UI** (the side panel replaced the old injected overlay).
2. **Side panel** (`extension/sidepanel.{html,js,css}`): the user-facing control surface — vehicle summary, editable description, prefs (emoji/unit/category/toggles/language), AI buttons, and **Fill listing**. Opened by clicking the toolbar icon.
3. **Background service worker** (`extension/background.js`): message router + privileged ops — opens/prewarms the FB tab, **fetches photos** (must happen here), and **proxies AI** to the backend.

### Core flows
- **List a car**: dealerContent extracts → `EZLIST_SAVE_DRAFT` (writes `ezlistDraft` + one-shot `ezlistAutoFill`) → prefetch photos + `EZLIST_OPEN_FACEBOOK` → facebookContent auto-fills on load → user reviews + Publishes.
- **Fill from panel**: sidepanel saves the edited draft → `EZLIST_FILL_NOW` → background opens/reuses the FB tab + `EZLIST_FILL` → facebookContent fills. Progress streams back via `EZLIST_FILL_STATUS`.
- **Green "✓ Added" (publish-confirmed, "Option A")**: facebookContent marks a VIN listed **only on a real publish** (URL leaves `/marketplace/create/vehicle` for `/marketplace/item/<id>` or `/you/`), writing `ezlistListedVins`. dealerContent + sidepanel repaint via `storage.onChanged`. Key is VIN → stock# → URL.
- **AI**: sidepanel → `EZLIST_AI_DESCRIBE` / `EZLIST_AI_TRANSLATE` → background → backend `/api/ai/{describe,translate}` → OpenAI. The OpenAI key lives **only in the backend** ("our key, our cost" — users never supply one; a paywall is planned, not built).

### `chrome.storage.local` keys
`ezlistDraft`, `ezlistAutoFill` (one-shot fill trigger), `ezlistLastExtractedAt`, `ezlistPrefs`, `ezlistListedVins`, `ezlistBackendUrl`, `ezlistBackendToken`.

### Backend (`backend/`, pure Node `http`, zero deps, port 3737)
`server.js` routes: `/health`, `/api/ai/describe` (gpt-4o-mini), `/api/ai/translate` (gpt-4o — handles translation natively, no separate service), plus the **dormant** Firecrawl `/api/listings/extract` + HTML fixtures. `ai.js` holds the OpenAI calls + prompts. Loads `backend/.env`; optional `CARXPERT_TOKEN` gate (header `x-carxpert-token`) + in-memory rate limit.

## Constraints that will bite you

- **Photos must be fetched in the background worker.** The Facebook page CSP blocks in-page external fetches; the worker returns base64 data URLs, uploaded via `DataTransfer → input.files → dispatch('change')`. Cap 20.
- **Content scripts can't hook the page's `history.pushState`** (isolated world), so publish-detection **polls `location.pathname`** (+ `popstate`). It's deliberately conservative — it never wrongly greens a card; if a real publish doesn't trigger it, tune the URL regex in facebookContent.js against Facebook's actual post-publish URL.
- **React form fill**: set values with the native setter (`Object.getOwnPropertyDescriptor(proto,'value').set.call`) then dispatch `input`/`change`/`blur`. Custom dropdowns are `label[role=combobox]` → portal `[role=option]` (real pointer-event click, then poll for options). Field name = `aria-labelledby` for dropdowns, else `textContent`.
- **Facebook is UK-English locale**: map US terms (Sport Utility→4x4, Gasoline→Petrol, marketing colours→FB palette with unknowns left blank, Automatic→"Automatic transmission"). Mileage `< 300` is rejected by FB → left blank.
- **Side panel** opens via `setPanelBehavior({openPanelOnActionClick:true})`, but with `--load-extension` the SW may skip its init, so there's an `action.onClicked → sidePanel.open({windowId})` fallback. Needs `minimum_chrome_version` 114.
- **Dev manifest carries localhost host permissions** (`http://127.0.0.1:3737/*`, `http://localhost:3737/*`) for the local backend. **Swap these for the deployed (Vercel) URL before any Web Store submit** — store builds must keep permissions minimal and justified.
- **Non-negotiables**: never auto-click Publish; never collect Facebook credentials/cookies. (Note: the README's "never sends data to any server" line predates the AI backend — description text now goes to OpenAI via our backend when AI features are used.)

## WSL2 + Windows Chrome testing

Code lives in WSL2; Chrome runs on Windows. Mirrored networking makes `localhost` shared both ways: Windows Chrome reaches the WSL backend at `127.0.0.1:3737`, and WSL reaches the debug port at `127.0.0.1:9222`. `chrome-devtools-mcp` connects via `--browser-url=http://127.0.0.1:9222`. The extension ID is path-derived (stable across reloads). `chrome-devtools` `list_pages` hides extension pages (side panel / chrome-extension://) — find them via `curl http://127.0.0.1:9222/json`, and `evaluate_script` will still target a just-opened extension page.
