---
name: e2e-debug
description: Reproduce, inspect, and diagnose CarXprt Chrome MV3 extension flows end to end against the real Windows Chrome profile over CDP. Use Agent Browser for fast UI driving, Chrome DevTools MCP for precise DOM, console, request, and service-worker inspection, and Agent Browser HAR capture for multi-page network timelines or deriving stable read-only website clients. Use for onboarding, auth, dealership detection, side-panel behavior, inventory adapters, Facebook form filling, and bugs that need a real-browser repro. Always verify the exact profile, tab, extension worker, and backend before trusting results; never publish a Marketplace listing or replay authenticated Facebook writes.
---

# CarXprt E2E debug

Code runs in WSL2 while Chrome runs on Windows. Use the three lenses selectively; do not invoke every tool mechanically.

## Mandatory preflight

Record these facts before interpreting a result:

1. **CDP endpoint and Chrome profile** — identify the intended profile and read its `DevToolsActivePort`, or use the dedicated launcher port.
2. **Exact tab** — prove the target with URL plus a page-specific marker. When duplicate URLs exist across profiles, compare `performance.timeOrigin`, extension controls, or another unique runtime marker.
3. **Extension ID and manifest version** — enumerate CDP targets and evaluate `chrome.runtime.getManifest().version` from an extension context. The extension ID must match the backend trusted origin.
4. **MV3 worker version** — test a newly added `EZLIST_*` message or another behavior marker in the service-worker target. A current panel with a stale worker is a false pass.
5. **Backend environment** — confirm `ezlistBackendUrl` and whether the build targets local, staging, or production.
6. **State boundary** — state which actions are read-only and where the test must stop. Facebook `Publish`, CRM saves, payments, invitations, and other external writes remain manual unless the user explicitly authorizes that exact action.

Obtain browser/profile approval once for the scoped session. Do not repeatedly ask for the same safe read-only navigation or inspection.

## Choose the right lens

| Need | Primary lens | Why |
|---|---|---|
| Reproduce clicks, inputs, navigation, or visible state | Agent Browser | Fast semantic snapshots and reliable interaction refs |
| Inspect one DOM state, console exception, API response, storage value, or MV3 worker | Chrome DevTools MCP | Precise runtime and request-level evidence |
| Preserve a multi-page request timeline or compare two similar flows | Agent Browser HAR | Durable offline network record with response bodies |
| Discover whether a site has a stable reusable API | HAR plus `derive-client` | Separates real first-party endpoints from UI and analytics noise |
| Verify the final fix | Agent Browser, then targeted DevTools checks | Confirms user behavior and its underlying cause |

HAR is network evidence, not console output. Use `agent-browser console` or Chrome DevTools MCP for logs and exceptions.

## Lens 1: Agent Browser for the user-visible flow

1. Check the installed CLI with `agent-browser --version` and load its matching guide with `agent-browser skills get core --full`.
2. Connect to the existing Chrome process with a named session, for example:

   ```bash
   agent-browser --session carxpert-e2e connect "$PORT"
   agent-browser --session carxpert-e2e tab
   ```

3. Select the proven tab, take a semantic snapshot, act through refs or semantic selectors, wait for the resulting state, and snapshot again.
4. Prefer Agent Browser for onboarding, workspace selection, dealership detection, extension-panel state, and safe Facebook field edits.

Do not start a separate headless browser when the behavior depends on the user's extension, login session, or anti-bot cookies.

## Lens 2: Chrome DevTools MCP for root cause

Use the available `mcp__chrome_devtools__*` tools; some clients expose equivalent names under a plugin prefix.

- `list_console_messages` and `get_console_message`: exceptions, CSP failures, extension logs.
- `list_network_requests` and `get_network_request`: request/response status, body, timing, and the relevant non-secret headers.
- `evaluate_script`: DOM state, `chrome.storage.local`, content-script markers, and behavior probes.
- `list_pages` / `select_page`: page targeting. If extension targets are hidden, enumerate `http://127.0.0.1:$PORT/json` and identify the extension or service-worker target there.
- Performance tools: use only for latency or rendering regressions, not ordinary correctness checks.

Inspect the MV3 service worker explicitly whenever a message handler, auth token, background fetch, or tab-routing path is involved.

## Lens 3: HAR for durable network evidence

Use HAR only when a request sequence spans navigation, must be compared offline, or could justify a reusable read-only adapter.

1. Start immediately before the target flow and stop immediately after it:

   ```bash
   agent-browser --session carxpert-e2e network har start
   # Drive only the scoped flow.
   agent-browser --session carxpert-e2e network har stop /tmp/carxpert-e2e.har
   ```

2. For client derivation, load `agent-browser skills get derive-client --full`. If the installed CLI lacks that skill, use a current `npx agent-browser` invocation consistently for the entire capture and record its version.
3. Exercise the same operation twice with different safe inputs. Compare methods, origins, paths, query parameters, request bodies, response MIME types, and response schemas.
4. Ignore analytics, telemetry, fonts, images, and infrastructure noise. A derivable API is normally first-party, structured, stable across both inputs, and causally tied to the action.
5. Verify any proposed client against the live read-only endpoint. If it needs expiring signatures, device-bound cookies, per-form CSRF, or bot-protection state, keep that step browser-driven.

### HAR security

- Treat every HAR as a credential-bearing secret: it can contain cookies, bearer tokens, CSRF values, personal data, and response bodies.
- Write captures only to `/tmp`; never add them to the repository, logs, chat output, fixtures, or artifacts.
- Do not print raw headers, cookies, full query strings, or request bodies. Produce sanitized summaries with host/path, method, status, MIME type, timing, and schema keys.
- Delete the named temporary HAR as soon as the findings are recorded. Confirm no `*.har` remains in the repository or temporary capture set.

### Product boundaries

- **Dealership websites:** prefer, in order, an official feed/API, a stable public JSON endpoint, server-rendered HTML/JSON-LD, then live DOM extraction.
- **Dealer CRM:** prefer the vendor-supported API. A HAR-derived client is acceptable only for authorized, scoped, read-only discovery and must not become a brittle write integration by accident.
- **Facebook:** use HAR only to diagnose reads, field updates, or failed UI behavior. Never generate or replay a direct Marketplace GraphQL/write client, never export Facebook auth material, and never click `Publish`.

## Fix-and-verify loop

1. Run the preflight.
2. Reproduce with Agent Browser.
3. Use Chrome DevTools MCP on the narrow failing layer.
4. Add a short HAR capture only when the network sequence or endpoint shape remains material.
5. Minimize the cause, add a regression test, and implement the fix.
6. Truly reload the extension from `chrome://extensions` or an extension context; a page refresh does not reload the MV3 worker.
7. Refresh affected dealership/Facebook tabs so content scripts reinject.
8. Re-run the same visible flow and targeted inspector assertions.
9. Remove HARs and report the profile, tab, environment, observed behavior, causal evidence, tests, and anything intentionally not exercised.

## Dedicated launchers

`./scripts/open-test-chrome.sh [local|staging|prod]` uses CDP ports `9222`, `9223`, and `9224` respectively.

- `local` loads `extension/`.
- `staging` loads `dist/staging/`; build with `npm run build:ext:staging` first.
- `prod` loads `dist/prod/`.

Prefer these isolated profiles for repeatable tests. Connect to the user's existing Chrome profile only when reproducing profile-specific state that the dedicated browser cannot reproduce.
