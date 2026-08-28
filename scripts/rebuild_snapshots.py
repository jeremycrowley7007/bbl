#!/usr/bin/env python3
"""Rebuild all request before_* snapshots from league-reset replay.

  BBL_SKIP_INIT=1 python3 scripts/rebuild_snapshots.py \\
    --reset-at "2026-05-01 00:00:00"

  BBL_SKIP_INIT=1 python3 scripts/rebuild_snapshots.py \\
    --reset-at "2026-05-01 00:00:00" --yes
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("BBL_SKIP_INIT", "1")

from app import DATABASE, LEAGUE_BASELINE, STAT_FIELDS, rerun_request_snapshot_backfill  # noqa: E402


def preview(db: sqlite3.Connection, reset_at: str) -> None:
    rows = db.execute(
        """SELECT r.id, r.status, r.created_at, p.name,
                  r.before_placement, r.proposed_placement
           FROM requests r
           LEFT JOIN players p ON p.id = r.player_id
           WHERE r.player_id IS NOT NULL
           ORDER BY r.id"""
    ).fetchall()
    print(f"=== CURRENT ({len(rows)} stat requests) ===")
    for r in rows:
        print(
            f"#{r['id']} {r['status']:<8} {r['created_at']} {r['name'] or '?':<10} "
            f"b={r['before_placement']} p={r['proposed_placement']}"
        )
    print(f"\nWill clear before_*, scrub bad stat_history, replay from reset @ {reset_at}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=DATABASE)
    parser.add_argument("--reset-at", required=True)
    parser.add_argument("--baseline", type=int, default=LEAGUE_BASELINE)
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")

    preview(db, args.reset_at)
    if not args.yes:
        print("\nDry run. Re-run with --yes to apply.")
        db.close()
        return

    print()
    result = rerun_request_snapshot_backfill(db, args.reset_at, args.baseline)
    db.commit()

    print("=== RESULT ===")
    for k, v in result.items():
        if k in ("reconciliation", "end_state"):
            continue
        print(f"  {k}: {v}")

    if result.get("reconciliation"):
        print("\n=== RECONCILIATION MISMATCHES (replay end ≠ roster) ===")
        for row in result["reconciliation"]:
            print(
                f"  {row['name']}: sim OVR {row['sim_overall']} vs roster OVR {row['actual_overall']}"
            )
            for field, diff in row["diffs"].items():
                print(f"    {field}: sim={diff['sim']} actual={diff['actual']}")
    else:
        print("\n=== RECONCILIATION OK — replay end-state matches all roster rows ===")

    jeremy = db.execute(
        "SELECT id FROM players WHERE name='Jeremy' COLLATE NOCASE"
    ).fetchone()
    if jeremy and result.get("end_state", {}).get("Jeremy"):
        end = result["end_state"]["Jeremy"]
        roster = db.execute(
            "SELECT * FROM players WHERE id=?", (jeremy["id"],)
        ).fetchone()
        roster_ovr = round(sum(roster[f] for f in STAT_FIELDS) / len(STAT_FIELDS))
        print(f"\nJeremy: replay OVR {end['overall']} | roster OVR {roster_ovr}")

    print("\n=== AFTER ===")
    rows = db.execute(
        """SELECT r.id, r.status, r.created_at, p.name,
                  r.before_placement, r.proposed_placement,
                  r.before_bowling, r.proposed_bowling
           FROM requests r
           LEFT JOIN players p ON p.id = r.player_id
           WHERE r.player_id IS NOT NULL
           ORDER BY r.id"""
    ).fetchall()
    for r in rows:
        print(
            f"#{r['id']} {r['status']:<8} {r['name'] or '?':<10} "
            f"PLC {r['before_placement']}→{r['proposed_placement']}  "
            f"BWL {r['before_bowling']}→{r['proposed_bowling']}"
        )

    db.close()
    print("\nDone. Reload the web app.")


if __name__ == "__main__":
    main()
