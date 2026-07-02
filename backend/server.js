import './env.js';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { runMigrations } from './db.js';
import { auth } from './auth.js';
import authRoutes from './routes/auth.js';
import metaRoutes from './routes/meta.js';
import aiRoutes from './routes/ai.js';
import meRoutes from './routes/me.js';

const app = express();
// Railway terminates TLS and forwards; trust the first proxy so req.ip is the real client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// CORS: exact chrome-extension origin allowlist (no wildcard in production). Every
// extension fetch routes through the background worker, so this is the only origin needed.
const EXTENSION_ID = process.env.EXTENSION_ID || 'ejagngoidhjkjoadbbijjkpdgelklael';
const devExtensionIds = (process.env.EXTENSION_IDS_DEV || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = new Set([
  `chrome-extension://${EXTENSION_ID}`,
  ...(process.env.NODE_ENV !== 'production' ? devExtensionIds.map((id) => `chrome-extension://${id}`) : [])
]);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-carxpert-token');
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Extension auth handshake (start/finish/exchange) — must precede the Better Auth catch-all
// and the global JSON parser (the exchange route brings its own express.json()).
app.use(authRoutes);

// Better Auth handler reads the RAW request body, so mount it before express.json().
app.all('/api/auth/*', toNodeHandler(auth));

// JSON body parser for everything else.
app.use(express.json({ limit: '2mb' }));

app.use(metaRoutes);
app.use(aiRoutes);
app.use(meRoutes);

// Dormant Firecrawl extraction + HTML fixtures: dev-only, NEVER mounted in production.
if (process.env.NODE_ENV !== 'production') {
  const { default: devRoutes } = await import('./routes/dev.js');
  app.use(devRoutes);
}

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Central error handler — never leak stack traces in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const body = { ok: false, error: err.message || 'internal error' };
  if (process.env.NODE_ENV !== 'production' && err.stack) body.stack = err.stack;
  res.status(status).json(body);
});

const PORT = Number(process.env.PORT || 3737);
// PaaS routes to the container's public interface (bind 0.0.0.0); local dev stays on loopback.
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const HOST = process.env.HOST || (onRailway ? '0.0.0.0' : '127.0.0.1');

async function start() {
  try {
    const applied = await runMigrations();
    console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations: up to date');
  } catch (err) {
    // Don't crash-loop: /health is DB-free, so stay up and surface the error in logs.
    console.error(`migration error: ${err.message}`);
  }
  app.listen(PORT, HOST, () => {
    console.log(`Carxpert backend on http://${HOST}:${PORT} (env=${process.env.NODE_ENV || 'dev'})`);
  });
}

start();
