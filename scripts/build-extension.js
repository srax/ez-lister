'use strict';

// Produce a Chrome Web Store-ready extension zip.
//
//   node scripts/build-extension.js <BACKEND_URL> [BACKEND_TOKEN]
//   BACKEND_URL=https://carxpert-backend.up.railway.app BACKEND_TOKEN=xxx node scripts/build-extension.js
//
// What it does (vs. the dev extension/):
//   1. Rewrites host_permissions — drops the http://localhost / 127.0.0.1 dev entries
//      (which get Web Store review rejected) and adds the deployed backend origin.
//   2. Rewrites the BACKEND_URL constant in background.js to the deployed URL, and (if a
//      token is given) the BACKEND_TOKEN constant used to authenticate the gated backend.
//   3. Zips the result to dist/carxpert-extension-v<version>.zip.
//
// The source extension/ tree is never modified — the build happens in a temp dir.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

const DEV_BACKEND_LITERAL = "const BACKEND_URL = 'http://127.0.0.1:3737';";
const DEV_TOKEN_LITERAL = "const BACKEND_TOKEN = '';";

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function parseBackendUrl(raw) {
  if (!raw) {
    fail('No backend URL given. Usage: node scripts/build-extension.js <https://your-backend-url>');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    fail(`Backend URL must be https:// for a store build (got ${url.protocol}//). Chrome blocks insecure backend calls.`);
  }
  // Base URL the extension prepends paths to (no trailing slash): `${BACKEND_URL}/api/...`
  const base = `${url.protocol}//${url.host}`;
  return { base, hostPattern: `${base}/*` };
}

function main() {
  const backendArg = process.argv[2] || process.env.BACKEND_URL;
  const token = (process.argv[3] || process.env.BACKEND_TOKEN || '').trim();
  const { base, hostPattern } = parseBackendUrl(backendArg);

  // ---- read + transform manifest ----
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const before = manifest.host_permissions || [];
  const kept = before.filter((h) => !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i.test(h));
  const nextPerms = [...new Set([...kept, hostPattern])];
  manifest.host_permissions = nextPerms;
  const version = manifest.version;

  // ---- read + transform background.js ----
  const bgPath = path.join(SRC, 'background.js');
  let bg = fs.readFileSync(bgPath, 'utf8');
  if (!bg.includes(DEV_BACKEND_LITERAL)) {
    fail(`Could not find the dev BACKEND_URL line in background.js.\n  Expected: ${DEV_BACKEND_LITERAL}\n  Update DEV_BACKEND_LITERAL in this script if the source changed.`);
  }
  bg = bg.replace(DEV_BACKEND_LITERAL, `const BACKEND_URL = '${base}';`);
  if (token) {
    if (!bg.includes(DEV_TOKEN_LITERAL)) {
      fail(`Could not find the dev BACKEND_TOKEN line in background.js.\n  Expected: ${DEV_TOKEN_LITERAL}`);
    }
    bg = bg.replace(DEV_TOKEN_LITERAL, `const BACKEND_TOKEN = '${token}';`);
  }

  // ---- assemble build dir (temp; source tree untouched) ----
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carxpert-build-'));
  fs.cpSync(SRC, buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(buildDir, 'background.js'), bg);

  // ---- zip ----
  fs.mkdirSync(DIST, { recursive: true });
  const zipPath = path.join(DIST, `carxpert-extension-v${version}.zip`);
  fs.rmSync(zipPath, { force: true });
  try {
    execFileSync('zip', ['-rq', zipPath, '.'], { cwd: buildDir });
  } catch (e) {
    fail(`zip failed (is the "zip" CLI installed? "sudo apt-get install zip"): ${e.message}`);
  }
  fs.rmSync(buildDir, { recursive: true, force: true });

  const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log('\n✓ Store-ready build complete');
  console.log(`  version:          ${version}`);
  console.log(`  backend URL:      ${base}`);
  console.log(`  backend token:    ${token ? 'baked in (gated backend)' : 'none (open backend)'}`);
  console.log(`  host_permissions: ${before.length} → ${nextPerms.length}`);
  for (const h of before) if (!nextPerms.includes(h)) console.log(`      removed: ${h}`);
  console.log(`      added:   ${hostPattern}`);
  console.log(`  output:           dist/carxpert-extension-v${version}.zip (${size} KB)\n`);
}

main();
