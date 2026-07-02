// Load backend/.env (KEY=VALUE) into process.env before anything reads it, with zero deps.
// Real env (Railway) always wins — we only fill keys that aren't already set.
// Import this FIRST from any module that reads env at load time (server.js, db.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

(function loadEnv() {
  try {
    const envPath = path.join(here, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* ignore — env is optional in dev, injected in prod */
  }
})();
