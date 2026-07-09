#!/usr/bin/env bash
# Prod health snapshot: users/links/listings, subs, events, last scan, AI usage.
# Usage: npm run ops   (or ./scripts/ops-overview.sh)
# Token: $ADMIN_TOKEN if set, else pulled via the railway CLI (must be linked to
# the production environment — `railway status` to check).
set -euo pipefail

BASE="${CARXPERT_API:-https://carxpert-tools-backend-production.up.railway.app}"
TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(railway variables --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['ADMIN_TOKEN'])")
fi

curl -sS -m 20 -H "x-admin-token: $TOKEN" "$BASE/api/admin/overview" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if not d.get('ok'):
    print('ERROR:', d); sys.exit(1)
print('— users —')
for u in d['users']:
    flags = ('comp ' if u['comp'] else '') + (u['dealership_id'] or 'NO DEALER')
    print(f\"  {u['email']:36s} {flags:24s} active={u['active_listings']} sold={u['sold_listings']}\")
print('— subscriptions —', d['subscriptionsByStatus'] or 'none', '| comp grants:', d['compGrants'])
print('— listings —', d['listingsByStatus'] or 'none')
print('— events (7d) —', d['events7d'] or 'none')
s = d.get('lastScan')
if s:
    print(f\"— last scan — {s['started_at']} ok={s['ok']} vins={s['vin_count']} src={s['source']} err={s['error']}\")
else:
    print('— last scan — never ran')
print('— AI today —', d['aiToday'])
"
