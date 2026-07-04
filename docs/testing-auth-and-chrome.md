# Testing the sign-in flow — two paths (and when to use each)

There are two very different things people call "testing the flow." Pick the right one — a
lot of struggle comes from reaching for a browser when curl would have answered it in 5s.

| You want to test… | Use | Needs a browser? |
|---|---|---|
| Backend auth (start/finish/exchange, `/api/me`, gates, leases) | **curl + tiny Node scripts** | **No** |
| The one real Google consent screen | a human in any browser (30s) | Yes, but manual |
| Extension **UI** (side panel, content-script fill, buttons) | **test Chrome + chrome-devtools-mcp** | Yes |

---

## Path A — backend auth flow (this is how the A0–A5 flow was verified; no browser)

Everything except Google's own consent page is testable headlessly against the deployed
backend. The trick for the parts that "need a logged-in user": **seed a Better Auth session
directly via the internal adapter** instead of clicking through Google.

Prereqs for local runs: `DATABASE_URL` (Railway public proxy) + `PGSSL=require` in the env
(same as every backend test). Against deployed staging you need neither.

```bash
BASE=https://carxpert-tools-backend-staging.up.railway.app

# 1. /start must 302 to Google with the right client_id + redirect_uri (no login needed)
curl -s -o /dev/null -w '%{redirect_url}\n' "$BASE/api/auth/extension/start"
#   → https://accounts.google.com/o/oauth2/v2/auth?...client_id=...&redirect_uri=.../api/auth/callback/google

# 2. Better Auth itself is alive
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/auth/get-session"   # 200

# 3. /api/me is bearer-gated
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/me"                 # 401
```

To exercise `exchange → bearer → /api/me` **without Google**, seed a user + one-time code
locally (Better Auth's internal adapter creates the user and session for you):

```bash
# run the backend locally (PORT=3940) with DATABASE_URL + PGSSL=require, then:
SEED=$(node --input-type=module -e '
  import { auth } from "./backend/auth.js";
  import { createAuthCode } from "./backend/auth-codes.js";
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.createUser({ email:"t"+Date.now()+"@e.com", name:"T", emailVerified:true });
  const code = await createAuthCode(u.id);
  console.log(u.id + "|" + code);
  process.exit(0);')
CODE=${SEED##*|}
TOK=$(curl -s -X POST localhost:3940/api/auth/extension/exchange -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')
curl -s localhost:3940/api/me -H "Authorization: Bearer $TOK"          # full profile JSON
# reuse the same code → 401 (single-use). Clean up the seeded user/session afterward.
```

The only step this can't cover is Google's consent click. For that: open
`$BASE/api/auth/extension/start` in a normal browser, sign in with a **test user** (added on
the OAuth consent screen), and success = the browser lands on a broken
`https://<extid>.chromiumapp.org/?code=...` page. The `?code=` in the address bar **is** the
pass — that fake host only the extension can catch.

---

## Path B — extension UI via test Chrome + chrome-devtools-mcp (WSL2 ⇄ Windows)

Code lives in WSL2; Chrome runs on **Windows**. Mirrored networking shares `localhost` both
ways, so WSL reaches the debug port and Windows Chrome reaches the WSL backend — both at
`127.0.0.1`.

### 1. Launch the instrumented Chrome (from WSL)
```bash
./scripts/open-test-chrome.sh
```
This calls `open-test-chrome.ps1`, which starts **Windows** Chrome with a dedicated profile
(`%USERPROFILE%\ezlist-chrome-profile`) and these flags that matter:
`--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --remote-allow-origins=*
--load-extension="<wsl path to>/extension"`, opening `chrome://extensions`.

### 2. Confirm the debug endpoint is up (from WSL)
```bash
curl -s http://127.0.0.1:9222/json/version   # → {"Browser":"Chrome/149...","webSocketDebuggerUrl":...}
```
If this is empty, Chrome isn't running with the debug port — re-run the script, and make sure
no other non-debug Chrome instance is holding the profile.

### 3. chrome-devtools-mcp connects to `--browser-url=http://127.0.0.1:9222`
The MCP is already wired to that port. **Key gotcha:** its `list_pages` **hides**
extension pages (side panel, `chrome-extension://…`). To act on them, find the target
yourself:
```bash
curl -s http://127.0.0.1:9222/json | \
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>JSON.parse(d).forEach(p=>console.log(p.type,p.url)))'
# look for  page  chrome-extension://<id>/sidepanel.html
```
`evaluate_script` / `take_snapshot` can still target a just-opened extension page even though
`list_pages` won't show it.

### Gotchas that cost the most time
- **Extension ID is path-derived and NOT the pinned prod ID** until the store `key` is added
  to `manifest.json`. In the running instance the side panel is
  `chrome-extension://bjdelccmgbfeklbbgpiiieondihmmokd/…`, not the prod
  `ejagngoidhjkjoadbbijjkpdgelklael`. Don't hardcode the ID — read it from `/json`.
- **After reloading the unpacked extension, refresh any open dealer/Facebook tabs** —
  content scripts only inject on a fresh page load.
- If a fetch from the extension to the backend fails, remember Windows Chrome hits the WSL
  backend at `127.0.0.1:3737` (mirrored networking); the backend must be running in WSL.
- `--remote-allow-origins=*` is required for CDP over the WSL⇄Windows boundary; if you see
  CDP handshake/403s, that flag (or a stale Chrome without it) is why.

---

## TL;DR to hand another agent
- Testing the **backend** sign-in? Don't open a browser. Use Path A (curl + a seeded session).
- Testing the **extension UI**? `./scripts/open-test-chrome.sh`, verify
  `curl 127.0.0.1:9222/json/version`, then drive it with chrome-devtools-mcp — and find
  extension pages via `curl 127.0.0.1:9222/json` because `list_pages` hides them.
