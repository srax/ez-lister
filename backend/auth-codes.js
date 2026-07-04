import crypto from 'node:crypto';
import { pool } from './db.js';

// One-time codes for the extension auth handshake: single-use, TTL from AUTH_CODE_TTL_SECONDS
// (default 60s; bumped on staging for human-in-the-loop testing). The atomic DELETE … RETURNING
// in consumeAuthCode guarantees only one caller can redeem a code. `db` is injectable for tests.

export async function createAuthCode(userId, db = pool) {
  const code = crypto.randomBytes(32).toString('hex');
  const ttl = Number(process.env.AUTH_CODE_TTL_SECONDS) || 60;
  await db.query(
    'insert into extension_auth_codes (code, user_id, expires_at, used) values ($1, $2, now() + make_interval(secs => $3), false)',
    [code, userId, ttl]
  );
  return code;
}

// → user_id on success, or null when the code is unknown / already used / expired.
export async function consumeAuthCode(code, db = pool) {
  const { rows } = await db.query(
    'delete from extension_auth_codes where code = $1 and used = false and expires_at > now() returning user_id',
    [code]
  );
  return rows.length ? rows[0].user_id : null;
}

// Housekeeping: consume only deletes redeemed codes; expired never-redeemed ones (abandoned
// sign-ins) accumulate forever without this. Piggybacks on the worker cleanup.
export async function pruneExpiredAuthCodes(db = pool) {
  const { rowCount } = await db.query('delete from extension_auth_codes where expires_at < now()');
  return rowCount;
}
