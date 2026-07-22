# Extension — build, load & launch cutover

Operational runbook for the Carxpert extension. Pairs with the plan in
`docs/plans/04-agent-extension.md`.

## Pinned extension ID

The extension ID is pinned via the `key` in `extension/manifest.json`, so it's identical
across dev (unpacked), staging, and prod:

```
ID: nfpnkiknibofeiicekdehonjmpnonaeh
```

The **private** signing key used to pin unpacked builds is kept out of the repo at
`~/.config/carxpert/extension-signing-key.pem` (mode 600). **Back it up.** Normal updates to the
existing Chrome Web Store item use the keyless store ZIP; never include `key.pem` in an update.

The backend derives everything else from this ID via the `EXTENSION_ID` env var
(CORS allowlist, Better Auth `trustedOrigins`, and the `/api/auth/extension/finish`
`chromiumapp.org` redirect host — see `backend/routes/auth.js`). So **every backend
deployment must set `EXTENSION_ID` to the pinned ID above.**

```
# staging (and later prod):
EXTENSION_ID=nfpnkiknibofeiicekdehonjmpnonaeh
```

The same pinned ID is also the backend default, but every deployed environment still sets
`EXTENSION_ID` explicitly so configuration drift is visible.

## Builds

```
npm run build:ext:staging          # → dist/staging/ (unpacked), backend = staging Railway
npm run build:ext:prod             # → dist/prod/ + zip, requires PROD_BACKEND_URL
PROD_BACKEND_URL=https://carxpert-tools-backend-production.up.railway.app npm run build:ext:prod
```

Each build swaps `host_permissions` (drops localhost + other Railway hosts, adds the target
backend), rewrites the `BACKEND_URL` constant, and carries the pinned `key` through unchanged.
The source `extension/` tree is never modified.

## Loading for dev/test

- **Local source build**: load `extension/` unpacked (`chrome://extensions` → Load unpacked).
  It always targets `127.0.0.1:3737`; use this only with the local backend.
- **Clean staging artifact**: `npm run build:ext:staging` then load `dist/staging/`.
  The packaged backend URL is authoritative; do not override `ezlistBackendUrl` in storage.
- **Environment switch**: loading local, staging, or production under the pinned ID clears cached
  auth, lease, draft, and workspace state when the packaged backend changes. Sign in again after
  switching environments. The pinned key keeps the extension ID stable regardless of load path.
- Use a dedicated profile per target: `./scripts/open-test-chrome.sh local`, `staging`, or
  `prod`. Reusing one Chrome profile across targets can retain a service worker from the previous
  unpacked path because all builds share the pinned ID.
- On `chrome://extensions`, confirm **Source** points to the expected `extension/` or
  `dist/<environment>/` directory and click **Reload** after every rebuild. Then refresh open
  dealer/Facebook tabs; content scripts only reinject on fresh page loads.

## Launch cutover (C6 ⇄ A5 ⇄ B4)

The x-carxpert-token → bearer switch is breaking; do it in this order once billing is live:

1. **Extension ready** (this branch): ships sign-in + bearer on every call. It already sends
   `Authorization: Bearer` and only sends the legacy `x-carxpert-token` if one is in storage
   (the store build injects none) — so the client side is effectively bearer-only already.
2. **A5**: set `AI_AUTH_MODE=bearer` on the backend and drop `x-carxpert-token` from the CORS
   allow-headers. AI now requires bearer + entitlement.
3. **B4**: swap Stripe to live keys + register the live webhook endpoint (staging stays
   sandbox/test).
4. Bump `manifest.version`, build prod, submit to the Web Store. Honor `/api/version`
   `minExtensionVersion` as the kill-switch for old builds.

Verify on staging (bearer mode + test Stripe) before promoting.
