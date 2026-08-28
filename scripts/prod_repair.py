#!/usr/bin/env python3
"""Prod repair: undo backfill → delete early requests → rerun backfill.

Example (dry-run first):
  BBL_SKIP_INIT=1 python3 scripts/prod_repair.py \\
    --delete-before "2026-05-09 00:00:00" \\
    --reset-at "2026-05-01 00:00:00"

  BBL_SKIP_INIT=1 python3 scripts/prod_repair.py \\
    --delete-before "2026-05-09 00:00:00" \\
    --reset-at "2026-05-01 00:00:00" \\
    --yes
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("BBL_SKIP_INIT", "1")

from app import (  # noqa: E402
    DATABASE,
    LEAGUE_BASELINE,
    STAT_FIELDS,
    delete_requests_before,
    rerun_request_snapshot_backfill,
    undo_request_snapshots,
)


def preview(db: sqlite3.Connection, delete_before: str, reset_at: str | None) -> None:
    print("=== STEP 1: undo backfill (clear all before_*) ===")
    count = db.execute(
        """SELECT COUNT(*) FROM requests
           WHERE player_id IS NOT NULL
           AND (request_type IS NULL OR request_type = 'stat_update')"""
    ).fetchone()[0]
    print(f"  Will clear before_* on {count} stat requests")

    print(f"\n=== STEP 2: delete requests before {delete_before} ===")
    rows = db.execute(
        """SELECT r.id, r.status, r.created_at, p.name
           FROM requests r
           LEFT JOIN players p ON p.id = r.player_id
           WHERE r.created_at < ?
           ORDER BY r.id""",
        (delete_before,),
    ).fetchall()
    if not rows:
        print("  (none)")
    for r in rows:
        print(f"  #{r['id']} {r['status']:<8} {r['created_at']}  {r['name'] or '?'}")
    print(f"  Total to delete: {len(rows)}")

    print("\n=== STEP 3: replay snapshots from reset (not stat_history backfill) ===")
    remaining = db.execute(
        """SELECT COUNT(*) FROM requests
           WHERE player_id IS NOT NULL
           AND created_at >= ?
           AND (request_type IS NULL OR request_type = 'stat_update')""",
        (delete_before,),
    ).fetchone()[0]
    print(f"  Will replay before_* for {remaining} remaining requests")
    if reset_at:
        print(f"  Reset anchor: {reset_at}")


def run(db: sqlite3.Connection, delete_before: str, reset_at: str | None, baseline: int) -> None:
    cleared = undo_request_snapshots(db)
    print(f"Step 1: cleared before_* on {cleared} requests")

    deleted = delete_requests_before(db, delete_before)
    print(f"Step 2: deleted {deleted} requests before {delete_before}")

    if not reset_at:
        raise SystemExit("Step 3 requires --reset-at for replay-based snapshots")
    result = rerun_request_snapshot_backfill(db, reset_at, baseline)
    print(f"Step 3: {result}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default=DATABASE,
        help=f"Database path (default: {DATABASE})",
    )
    parser.add_argument(
        "--delete-before",
        required=True,
        help="Delete requests with created_at before this (YYYY-MM-DD HH:MM:SS)",
    )
    parser.add_argument(
        "--reset-at",
        help="Record league reset in stat_history before backfill (recommended)",
    )
    parser.add_argument(
        "--baseline",
        type=int,
        default=LEAGUE_BASELINE,
        help=f"Reset baseline (default: {LEAGUE_BASELINE})",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Apply changes (default is dry-run preview only)",
    )
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")

    preview(db, args.delete_before, args.reset_at)

    if not args.yes:
        print("\nDry run only. Re-run with --yes to apply.")
        db.close()
        return

    print()
    run(db, args.delete_before, args.reset_at, args.baseline)
    db.commit()

    print("\n=== AFTER ===")
    rows = db.execute(
        """SELECT r.id, r.status, r.created_at, p.name,
                  r.before_placement, r.proposed_placement
           FROM requests r
           LEFT JOIN players p ON p.id = r.player_id
           ORDER BY r.id"""
    ).fetchall()
    for r in rows:
        print(
            f"#{r['id']} {r['status']:<8} {r['created_at']} {r['name'] or '?':<10} "
            f"b_plc={r['before_placement']} p_plc={r['proposed_placement']}"
        )

    db.close()
    print("\nDone. Reload your web app.")


if __name__ == "__main__":
    main()
