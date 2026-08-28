#!/usr/bin/env bash
# Run on PythonAnywhere:  cd ~/bbl && bash scripts/audit_prod.sh
# Uses sqlite3 only — no pull/deploy required if you paste this file in.

set -euo pipefail

DB="${1:-bocce.db}"

if [[ ! -f "$DB" ]]; then
  echo "Database not found: $DB"
  echo "Usage: bash scripts/audit_prod.sh [path/to/bocce.db]"
  exit 1
fi

run() {
  sqlite3 -header -column "$DB" "$1"
}

echo "=============================================="
echo "BBL REQUEST AUDIT  $(date '+%Y-%m-%d %H:%M:%S')"
echo "Database: $DB"
echo "=============================================="

echo
echo "=== CURRENT PLAYER STATS ==="
run "SELECT id, name, placement AS plc, bowling AS bwl, tilt_aversion AS tlt,
            wall_ball AS wbl, substance_use AS sub, flair AS flr
     FROM players ORDER BY id;"

echo
echo "=== STAT HISTORY (by source) ==="
run "SELECT source, COUNT(*) AS rows FROM stat_history GROUP BY source ORDER BY source;"

echo
echo "=== RESET EVENTS (if any) ==="
run "SELECT created_at, COUNT(*) AS stat_rows
     FROM stat_history WHERE source='reset_all'
     GROUP BY created_at ORDER BY created_at;"

echo
echo "=== REQUEST TIMELINE (stat updates) ==="
run "SELECT r.id,
            r.status,
            r.created_at,
            CAST(julianday('now') - julianday(r.created_at) AS INTEGER) AS days_ago,
            p.name AS player,
            r.before_placement AS b_plc,
            r.proposed_placement AS p_plc,
            r.before_bowling AS b_bwl,
            r.proposed_bowling AS p_bwl,
            r.closed_at
     FROM requests r
     LEFT JOIN players p ON p.id = r.player_id
     WHERE r.player_id IS NOT NULL
       AND (r.request_type IS NULL OR r.request_type = 'stat_update')
     ORDER BY r.created_at, r.id;"

echo
echo "=== REQUEST GAPS (>1 day between consecutive requests) ==="
sqlite3 "$DB" <<'SQL'
.mode column
.headers on
WITH ordered AS (
  SELECT id, created_at,
         LAG(created_at) OVER (ORDER BY created_at, id) AS prev_at,
         LAG(id) OVER (ORDER BY created_at, id) AS prev_id
  FROM requests
  WHERE player_id IS NOT NULL
    AND (request_type IS NULL OR request_type = 'stat_update')
)
SELECT prev_id AS from_id,
       prev_at AS from_at,
       id AS to_id,
       created_at AS to_at,
       CAST(julianday(created_at) - julianday(prev_at) AS INTEGER) AS gap_days
FROM ordered
WHERE prev_at IS NOT NULL
  AND julianday(created_at) - julianday(prev_at) >= 1
ORDER BY created_at;
SQL

echo
echo "=== LIKELY RESET WINDOW ==="
echo "Look for the big gap above. Reset probably landed BETWEEN those two clusters."
echo "Requests BEFORE reset: mixed before_* values (72, 68, 80...)"
echo "Requests AFTER reset:  before_* should all be 62"

echo
echo "=== before_* CHECK (all 62 = post-reset era?) ==="
run "SELECT r.id, r.created_at, p.name,
            CASE WHEN before_placement=62 AND before_bowling=62 AND before_tilt_aversion=62
                      AND before_wall_ball=62 AND before_substance_use=62 AND before_flair=62
                 THEN 'all-62' ELSE 'mixed' END AS before_era
     FROM requests r
     JOIN players p ON p.id = r.player_id
     WHERE r.player_id IS NOT NULL
       AND (r.request_type IS NULL OR r.request_type = 'stat_update')
     ORDER BY r.created_at;"

echo
echo "=== WIPE PREVIEW (requests that would be deleted if cutoff = day after last Apr-7 request) ==="
run "SELECT id, status, created_at, p.name AS player
     FROM requests r
     LEFT JOIN players p ON p.id = r.player_id
     WHERE r.created_at < '2026-04-08 00:00:00'
     ORDER BY r.id;"

echo
echo "(Adjust cutoff date once you pick the reset day — see scripts/wipe_requests.sh)"
