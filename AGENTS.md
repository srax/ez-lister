# Repository Guidelines

## Project Structure & Module Organization

This repo contains a Chrome MV3 extension plus a local development backend.

- `extension/`: extension source. `manifest.json` defines permissions and entry points; `background.js` coordinates drafts, tabs, and backend calls; `dealerContent.js` injects dealership listing controls; `facebookContent.js` fills Facebook Marketplace; `sidepanel.*` implements the extension side panel.
- `extension/assets/`: extension icons.
- `backend/`: local backend and optional AI/Firecrawl extraction helpers. `server.js` serves fixtures and API routes; `normalize.js` contains listing normalization; `normalize.test.js` covers backend normalization.
- `scripts/`: helper scripts for a dedicated Chrome test profile.
- `dist/`: generated extension packages and store assets. Do not treat this as source.

## Build, Test, and Development Commands

- `npm run check`: syntax-checks backend and extension JavaScript with Node.
- `npm test`: runs the Node test suite.
- `npm run dev:backend`: starts the local backend on `http://127.0.0.1:3737`.
- `./scripts/open-test-chrome.sh`: opens a dedicated Chrome profile for extension testing.

Load the extension from `extension/` via `chrome://extensions` in Developer mode.

## Coding Style & Naming Conventions

Use CommonJS and plain JavaScript. Keep files in strict mode. Prefer `const`/`let`, two-space indentation, early returns, and small helper functions. Message names use the existing `EZLIST_*` pattern. Keep DOM selectors and Facebook/dealer assumptions isolated in content scripts.

## Testing Guidelines

Tests use Node’s built-in test runner (`node:test`) and `node:assert/strict`. Add backend tests as `*.test.js` next to the module under test, as in `backend/normalize.test.js`. For extension changes, run `npm run check` and perform a manual Chrome smoke test against the dealership page and Facebook vehicle form.

## Commit & Pull Request Guidelines

History uses short imperative commit messages, for example `Add privacy policy` or `Speed up fill, clean permissions for Web Store, handle edge cases`. PRs should describe user-facing behavior, list changed permissions, include test results, and attach screenshots when UI or Chrome Web Store assets change.

## Security & Configuration Tips

Never commit real API keys. Copy `backend/.env.example` to `backend/.env` for local secrets such as `OPENAI_API_KEY` or `CARXPERT_TOKEN`. Keep Chrome permissions minimal and justify any new host permissions. The extension must not collect Facebook credentials or auto-click Publish.
