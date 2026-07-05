'use strict';

// Produce an environment-specific extension build (the client half of the
// isDeployed/isProduction/isStaging split — same source, three targets).
//
//   node scripts/build-extension.js <env> [--zip]
//     env = local | staging | prod
//
//   node scripts/build-extension.js prod            # store zip, prod backend
//   node scripts/build-extension.js staging         # unpacked dir, staging backend
//   PROD_BACKEND_URL=https://api.example.com node scripts/build-extension.js prod
//
// What it does (vs. the source extension/):
//   1. Rewrites the BACKEND_URL constant in background.js to the env's backend origin.
//   2. Rewrites host_permissions — strips every backend host (localhost + *.railway.app)
//      and adds the target env's backend origin. localhost is kept only for `local`.
//      Dealer + Facebook hosts are always kept.
//   3. The manifest `key` (pinned extension ID) is carried through in dist/<env>/ for
//      unpacked local testing. It is stripped from Web Store ZIPs because Chrome Web Store
//      rejects uploaded packages that include the `key` field.
//   4. Emits dist/<env>/ (unpacked, for loading) and a zip for prod (or any env with --zip).
//   5. --first-upload: additionally embeds the private signing key as key.pem in the zip
//      root — the ONLY way to make a brand-new Web Store item adopt our pinned extension
//      ID (the store derives the item ID from key.pem on the very first upload, then keeps
//      it forever). Subsequent update uploads must NOT include it, so this is opt-in and
//      the zip gets a "-first-upload" suffix to keep it out of the normal update path.
//
// The source extension/ tree is never modified — the build happens in a temp dir.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

// Per-env backend origin. prod is intentionally unset until production is provisioned —
// supply it via arg or PROD_BACKEND_URL so a store build can never silently point at staging.
const ENVS = {
  local: { url: 'http://127.0.0.1:3737', keepLocalhost: true },
  staging: { url: 'https://carxpert-tools-backend-staging.up.railway.app' },
  prod: { url: process.env.PROD_BACKEND_URL || '' }
};

// A host_permission entry is a "backend host" (swappable per env) if it's localhost or a
// Railway deployment. Dealer/Facebook hosts don't match, so they're preserved.
const BACKEND_HOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i;
const RAILWAY_HOST_RE = /^https?:\/\/[^/]*\.railway\.app\//i;

const DEV_BACKEND_LITERAL = "const BACKEND_URL = 'http://127.0.0.1:3737';";

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// Chrome extension ID = first 16 bytes of SHA-256(SPKI DER public key), hex mapped 0-f → a-p.
function extensionIdFromSpkiDer(der) {
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
}

const SIGNING_KEY_PATH = process.env.EXTENSION_SIGNING_KEY
  || path.join(os.homedir(), '.config', 'carxpert', 'extension-signing-key.pem');

function parseUrl(raw, env) {
  if (!raw) fail(`No backend URL for env "${env}". For prod, pass a URL arg or set PROD_BACKEND_URL.`);
  let url;
  try { url = new URL(raw); } catch { fail(`"${raw}" is not a valid URL.`); }
  if (env !== 'local' && url.protocol !== 'https:') {
    fail(`Deployed build needs https:// (got ${url.protocol}//). Chrome blocks insecure backend calls.`);
  }
  const base = `${url.protocol}//${url.host}`;
  return { base, hostPattern: `${base}/*` };
}

function main() {
  const env = (process.argv[2] || 'prod').toLowerCase();
  const wantZip = process.argv.includes('--zip') || env === 'prod';
  const firstUpload = process.argv.includes('--first-upload');
  if (firstUpload && env !== 'prod') fail('--first-upload only makes sense for the prod (store) build.');
  const cfg = ENVS[env];
  if (!cfg) fail(`Unknown env "${env}". Use: local | staging | prod`);

  // Allow an explicit URL override as the 3rd token (e.g. prod before its URL is in this file).
  const urlArg = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : cfg.url;
  const { base, hostPattern } = parseUrl(urlArg, env);

  // ---- manifest: swap backend hosts, keep key/dealer/facebook ----
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  if (!manifest.key) fail('Source manifest has no "key" — the extension ID would be unpinned. Run the keygen step (see docs/plans/04-agent-extension.md C0).');
  const before = manifest.host_permissions || [];
  const kept = before.filter((h) => {
    if (RAILWAY_HOST_RE.test(h)) return false;
    if (BACKEND_HOST_RE.test(h)) return Boolean(cfg.keepLocalhost);
    return true; // dealer + facebook
  });
  const nextPerms = [...new Set([...kept, hostPattern])];
  manifest.host_permissions = nextPerms;
  const version = manifest.version;

  // ---- background.js: rewrite the BACKEND_URL constant ----
  const bgPath = path.join(SRC, 'background.js');
  let bg = fs.readFileSync(bgPath, 'utf8');
  if (!bg.includes(DEV_BACKEND_LITERAL)) {
    fail(`Could not find the dev BACKEND_URL line in background.js.\n  Expected: ${DEV_BACKEND_LITERAL}`);
  }
  bg = bg.replace(DEV_BACKEND_LITERAL, `const BACKEND_URL = '${base}';`);

  // ---- assemble build dir (source tree untouched) ----
  const outDir = path.join(DIST, env);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(SRC, outDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(outDir, 'lib'))) {
    if (file.endsWith('.test.js')) fs.rmSync(path.join(outDir, 'lib', file), { force: true });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'background.js'), bg);

  let zipInfo = '(none)';
  if (wantZip) {
    const zipName = `carxpert-extension-${env}-v${version}${firstUpload ? '-first-upload' : ''}.zip`;
    const zipPath = path.join(DIST, zipName);
    const zipDir = path.join(DIST, `.zip-${env}`);
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(zipDir, { recursive: true, force: true });
    fs.cpSync(outDir, zipDir, { recursive: true });

    const storeManifestPath = path.join(zipDir, 'manifest.json');
    const storeManifest = JSON.parse(fs.readFileSync(storeManifestPath, 'utf8'));
    delete storeManifest.key;
    fs.writeFileSync(storeManifestPath, `${JSON.stringify(storeManifest, null, 2)}\n`);

    if (firstUpload) {
      if (!fs.existsSync(SIGNING_KEY_PATH)) {
        fail(`Signing key not found at ${SIGNING_KEY_PATH} (override with EXTENSION_SIGNING_KEY).`);
      }
      const pem = fs.readFileSync(SIGNING_KEY_PATH, 'utf8');
      const pemId = extensionIdFromSpkiDer(
        crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })
      );
      const manifestId = extensionIdFromSpkiDer(Buffer.from(manifest.key, 'base64'));
      if (pemId !== manifestId) {
        fail(`key.pem derives ID ${pemId} but the manifest key pins ${manifestId} — wrong signing key.`);
      }
      fs.writeFileSync(path.join(zipDir, 'key.pem'), pem, { mode: 0o600 });
      console.log(`\n⚠ FIRST-UPLOAD zip: contains the PRIVATE signing key (key.pem, ID ${pemId}).`);
      console.log('  Upload it once to create the store item, then delete the zip. Updates use the normal build.');
    }

    try {
      execFileSync('zip', ['-rq', zipPath, '.'], { cwd: zipDir });
    } catch (e) {
      fail(`zip failed (is the "zip" CLI installed? "sudo apt-get install zip"): ${e.message}`);
    } finally {
      fs.rmSync(zipDir, { recursive: true, force: true });
    }
    zipInfo = `${path.relative(ROOT, zipPath)} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB)`;
  }

  console.log('\n✓ Build complete');
  console.log(`  env:              ${env}`);
  console.log(`  version:          ${version}`);
  console.log(`  backend URL:      ${base}`);
  console.log(`  host_permissions: ${before.length} → ${nextPerms.length}`);
  for (const h of before) if (!nextPerms.includes(h)) console.log(`      removed: ${h}`);
  if (!before.includes(hostPattern)) console.log(`      added:   ${hostPattern}`);
  console.log(`  unpacked:         ${path.relative(ROOT, outDir)}/`);
  console.log(`  zip:              ${zipInfo}\n`);
}

main();
