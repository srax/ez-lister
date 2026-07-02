import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.env.DATABASE_URL ? false : 'no DATABASE_URL — set it (+ PGSSL) to run';

test('bumpAiUsage: counts per user/day/kind, flips limited over the cap', { skip }, async () => {
  const { pool } = await import('./db.js');
  const { bumpAiUsage, DAILY_LIMIT } = await import('./ai-limits.js');
  const userId = `ai-usage-test-${Date.now()}`;
  try {
    const first = await bumpAiUsage(userId, 'describe');
    assert.equal(first.count, 1);
    assert.equal(first.limited, false);

    // separate counter per kind
    const t = await bumpAiUsage(userId, 'translate');
    assert.equal(t.count, 1);

    // push describe to the limit and one over
    const tz = 'America/New_York';
    await pool.query(
      `update ai_usage set describe_count = $2 where user_id = $1 and day = (now() at time zone $3)::date`,
      [userId, DAILY_LIMIT, tz]
    );
    const over = await bumpAiUsage(userId, 'describe'); // now DAILY_LIMIT + 1
    assert.equal(over.count, DAILY_LIMIT + 1);
    assert.equal(over.limited, true);

    await assert.rejects(() => bumpAiUsage(userId, 'bogus'));
  } finally {
    await pool.query('delete from ai_usage where user_id = $1', [userId]);
    await pool.end();
  }
});
