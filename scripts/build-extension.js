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
//   3. The manifest `key` (pinned extension ID) is carried through unchanged, so the ID is
//      identical across local/staging/prod and matches the backend's EXTENSION_ID.
//   4. Emits dist/<env>/ (unpacked, for loading) and a zip for prod (or any env with --zip).
//
// The source extension/ tree is never modified — the build happens in a temp dir.

const fs = require('node:fs');
const path = require('node:path');
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
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'background.js'), bg);

  let zipInfo = '(none)';
  if (wantZip) {
    const zipPath = path.join(DIST, `carxpert-extension-${env}-v${version}.zip`);
    fs.rmSync(zipPath, { force: true });
    try {
      execFileSync('zip', ['-rq', zipPath, '.'], { cwd: outDir });
    } catch (e) {
      fail(`zip failed (is the "zip" CLI installed? "sudo apt-get install zip"): ${e.message}`);
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
