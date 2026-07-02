import { pool } from './db.js';

// Per-user daily AI limits via the ai_usage table. The day boundary is the user's
// dealership timezone (falls back to America/New_York). Atomic upsert returns the new count
// so the check and the increment can't race. 100 describe + 100 translate per local day.
export const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 100);

const COLUMN = { describe: 'describe_count', translate: 'translate_count' };

async function userDayAndTz(userId, db) {
  const { rows } = await db.query(
    `select coalesce(d.timezone, 'America/New_York') as tz
     from (select $1::text as uid) x
     left join user_dealerships ud on ud.user_id = x.uid
     left join dealerships d on d.id = ud.dealership_id`,
    [userId]
  );
  return rows[0] ? rows[0].tz : 'America/New_York';
}

// Increment the counter for (user, local-day, kind) and return { count, limited }.
// Over-limit still increments (harmless) but reports limited=true so the caller 429s.
export async function bumpAiUsage(userId, kind, db = pool) {
  const col = COLUMN[kind];
  if (!col) throw new Error(`unknown ai usage kind: ${kind}`);
  const tz = await userDayAndTz(userId, db);
  const { rows } = await db.query(
    `insert into ai_usage (user_id, day, ${col})
     values ($1, (now() at time zone $2)::date, 1)
     on conflict (user_id, day) do update set ${col} = ai_usage.${col} + 1
     returning ${col} as count`,
    [userId, tz]
  );
  const count = rows[0].count;
  return { count, limited: count > DAILY_LIMIT };
}
