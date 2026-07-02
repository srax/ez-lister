'use strict';

// `npm run check` — fast syntax sanity over the backend (ESM) and extension (CJS) trees.
// Runs `node --check` per file so each is parsed under its own nearest package.json module
// type (backend/ is "type":"module", extension/ inherits the root "commonjs"). A plain
// `node --check a.js b.js` only checks one file, so we iterate.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOTS = ['backend', 'extension'];
const SKIP_DIRS = new Set(['node_modules', 'migrations']);

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
}
for (const rel of ROOTS) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) walk(abs);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    const detail = (err.stderr && err.stderr.toString()) || err.message;
    console.error(`✗ ${path.relative(ROOT, file)}\n${detail}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed --check`);
  process.exit(1);
}
console.log(`✓ ${files.length} files OK`);
