import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));

// Railway's INTERNAL DATABASE_URL (postgres.railway.internal) needs no TLS; the public
// proxy or an external Postgres may. Set PGSSL=require to force TLS and accept Railway's
// self-signed proxy cert (used when running migrations from a laptop over the proxy).
const ssl = process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false;
const connectionString = process.env.DATABASE_URL || '';

export const pool = new Pool(connectionString ? { connectionString, ssl } : { ssl });

export function query(text, params) {
  return pool.query(text, params);
}

// Run a unit of work on one connection. Domain services use SERIALIZABLE when concurrent
// requests could otherwise over-allocate seats or approve two claims for one rooftop.
export async function withTransaction(work, {
  db = pool,
  isolation = 'read committed',
  retries = 0
} = {}) {
  const allowed = new Set(['read committed', 'repeatable read', 'serializable']);
  if (!allowed.has(isolation)) throw new Error(`unsupported transaction isolation: ${isolation}`);

  for (let attempt = 0; ; attempt += 1) {
    const client = await db.connect();
    try {
      await client.query(`begin isolation level ${isolation}`);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      const retryable = err && (err.code === '40001' || err.code === '40P01');
      if (!retryable || attempt >= retries) throw err;
    } finally {
      client.release();
    }
  }
}

// Forward-only migration runner: applies every backend/migrations/*.sql not yet recorded
// in schema_migrations, in filename order, each inside its own transaction. Runs on boot.
export async function runMigrations() {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  await pool.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const dir = path.join(here, 'migrations');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    : [];
  const { rows } = await pool.query('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
