import { pool } from './db.js';

// Fill-accuracy eval loop: every real fill_completed event carries data.fields =
// [{ name, ok, msg }]. Aggregating per-field ok-rate over N days turns each listing into
// an eval case — it tells us when Facebook changes the form before users complain.
export async function fillAccuracy(days = 14, db = pool) {
  const { rows } = await db.query(
    `select f->>'name' as field,
            count(*)::int as total,
            sum(case when (f->>'ok')::boolean then 1 else 0 end)::int as ok
     from usage_events e
     cross join lateral jsonb_array_elements(coalesce(e.data->'fields', '[]'::jsonb)) as f
     where e.type = 'fill_completed'
       and e.occurred_at > now() - ($1 || ' days')::interval
     group by f->>'name'
     order by (count(*) - sum(case when (f->>'ok')::boolean then 1 else 0 end)) desc, field`,
    [String(days)]
  );

  const fields = rows.map((r) => ({
    field: r.field,
    total: r.total,
    ok: r.ok,
    okRate: r.total ? Number((r.ok / r.total).toFixed(3)) : null
  }));
  const totalFills = await db.query(
    `select count(*)::int as n from usage_events
     where type = 'fill_completed' and occurred_at > now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return { fills: totalFills.rows[0].n, fields };
}

// Raw per-fill diagnostics: every fill_completed event with its per-field ok/msg trail and
// the owner's email. This is the "why did HIS machine fail" view — 'field not found' means
// the label never matched (FB UI language / composer variant), 'no option matched' means the
// dropdown opened but its options differ, 'got ""' means the set didn't stick (timing/React).
export async function recentFills(days = 7, db = pool) {
  const { rows } = await db.query(
    `select e.occurred_at, e.client_key, u.email, e.data->'fields' as fields
     from usage_events e
     left join "user" u on u.id = e.user_id
     where e.type = 'fill_completed'
       and e.occurred_at > now() - ($1 || ' days')::interval
     order by e.occurred_at desc limit 100`,
    [String(Math.min(90, Math.max(1, days)))]
  );
  return rows;
}

// Extraction-quality view: every extraction_completed event carries data.provider, data.host,
// data.completeness (0..1) and data.missing = [field, …]. Aggregating per dealer surfaces the
// WEAKEST dealerships/themes automatically (lowest completeness first) — the whole point being that
// we can't manually test every dealership on a platform, so the data tells us which ones need a
// selector or a schema.org-fallback tweak. `missingFields` shows WHICH fields fail most often.
export async function extractionQuality(days = 14, db = pool) {
  const window = [String(Math.min(90, Math.max(1, days)))];
  const byDealer = await db.query(
    `select data->>'provider' as provider,
            data->>'host' as host,
            count(*)::int as extractions,
            round(avg((data->>'completeness')::numeric), 2) as avg_completeness
     from usage_events
     where type = 'extraction_completed'
       and occurred_at > now() - ($1 || ' days')::interval
     group by 1, 2
     order by avg_completeness asc nulls last, extractions desc`,
    window
  );
  const missingFields = await db.query(
    `select m as field, count(*)::int as missing_count
     from usage_events e
     cross join lateral jsonb_array_elements_text(coalesce(e.data->'missing', '[]'::jsonb)) as m
     where e.type = 'extraction_completed'
       and e.occurred_at > now() - ($1 || ' days')::interval
     group by m
     order by missing_count desc, field`,
    window
  );
  const total = await db.query(
    `select count(*)::int as n from usage_events
     where type = 'extraction_completed' and occurred_at > now() - ($1 || ' days')::interval`,
    window
  );
  return { extractions: total.rows[0].n, byDealer: byDealer.rows, missingFields: missingFields.rows };
}

// Retention: delete usage_events older than 90 days. Piggybacks on the worker loop (A4).
export async function pruneUsageEvents(db = pool) {
  const { rowCount } = await db.query("delete from usage_events where occurred_at < now() - interval '90 days'");
  return rowCount;
}
