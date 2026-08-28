#!/usr/bin/env bash
# Delete old requests (and their comments/votes) before a cutoff date.
#
#   cd ~/bbl
#   bash scripts/wipe_requests.sh 2026-04-28          # dry-run
#   bash scripts/wipe_requests.sh 2026-04-28 --yes    # actually delete
#
# Cutoff is inclusive: requests created BEFORE this timestamp are removed.

set -euo pipefail

DB="${BBL_DB:-bocce.db}"
CUTOFF="${1:-}"
CONFIRM="${2:-}"

if [[ -z "$CUTOFF" ]]; then
  echo "Usage: bash scripts/wipe_requests.sh CUTOFF [--yes]"
  echo "  CUTOFF  YYYY-MM-DD or 'YYYY-MM-DD HH:MM:SS'"
  echo "  --yes   skip confirmation and delete"
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "Database not found: $DB"
  exit 1
fi

echo "=== REQUESTS TO DELETE (created_at < $CUTOFF) ==="
sqlite3 -header -column "$DB" \
  "SELECT r.id, r.status, r.created_at, p.name AS player
   FROM requests r
   LEFT JOIN players p ON p.id = r.player_id
   WHERE r.created_at < '$CUTOFF'
   ORDER BY r.id;"

COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM requests WHERE created_at < '$CUTOFF';")
echo
echo "Total requests to delete: $COUNT"

if [[ "$COUNT" -eq 0 ]]; then
  echo "Nothing to do."
  exit 0
fi

if [[ "$CONFIRM" != "--yes" ]]; then
  echo
  echo "Dry run only. Re-run with --yes to delete:"
  echo "  bash scripts/wipe_requests.sh '$CUTOFF' --yes"
  exit 0
fi

read -r -p "Type DELETE to confirm: " answer
if [[ "$answer" != "DELETE" ]]; then
  echo "Aborted."
  exit 1
fi

sqlite3 "$DB" <<SQL
PRAGMA foreign_keys=ON;
BEGIN;
DELETE FROM comments WHERE request_id IN (SELECT id FROM requests WHERE created_at < '$CUTOFF');
DELETE FROM upvotes WHERE request_id IN (SELECT id FROM requests WHERE created_at < '$CUTOFF');
DELETE FROM downvotes WHERE request_id IN (SELECT id FROM requests WHERE created_at < '$CUTOFF');
DELETE FROM stat_history WHERE request_id IN (SELECT id FROM requests WHERE created_at < '$CUTOFF');
DELETE FROM requests WHERE created_at < '$CUTOFF';
COMMIT;
SQL

echo "Done. Remaining requests:"
sqlite3 -header -column "$DB" \
  "SELECT id, status, created_at FROM requests ORDER BY id;"
