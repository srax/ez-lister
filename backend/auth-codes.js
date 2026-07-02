import crypto from 'node:crypto';
import { pool } from './db.js';

// One-time codes for the extension auth handshake: 60s TTL, single-use. The atomic
// DELETE … RETURNING in consumeAuthCode guarantees only one caller can redeem a code.
// `db` is injectable so tests (and a future tx) can pass a client.

export async function createAuthCode(userId, db = pool) {
  const code = crypto.randomBytes(32).toString('hex');
  await db.query(
    "insert into extension_auth_codes (code, user_id, expires_at, used) values ($1, $2, now() + interval '60 seconds', false)",
    [code, userId]
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
