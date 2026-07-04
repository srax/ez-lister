import test from 'node:test';
import assert from 'node:assert/strict';

// DB-backed lifecycle test. Skips when DATABASE_URL is absent so `npm test` stays offline;
// run it against the (proxy) Postgres with DATABASE_URL + PGSSL=require to actually exercise it.
const skip = process.env.DATABASE_URL ? false : 'no DATABASE_URL — set it (+ PGSSL) to run';

test('auth-code lifecycle: create → consume once → reuse rejected → expired rejected', { skip }, async () => {
  const { pool } = await import('./db.js');
  const { createAuthCode, consumeAuthCode } = await import('./auth-codes.js');
  const userId = `test-user-${Date.now()}`;

  try {
    // valid, single consume returns the user
    const code = await createAuthCode(userId);
    assert.equal(await consumeAuthCode(code), userId);

    // reuse is rejected (row already deleted)
    assert.equal(await consumeAuthCode(code), null);

    // expired code is rejected
    const expired = `expired-${Date.now()}`;
    await pool.query(
      "insert into extension_auth_codes (code, user_id, expires_at, used) values ($1, $2, now() - interval '1 second', false)",
      [expired, userId]
    );
    assert.equal(await consumeAuthCode(expired), null);
  } finally {
    await pool.query('delete from extension_auth_codes where user_id = $1', [userId]);
    await pool.end();
  }
});
