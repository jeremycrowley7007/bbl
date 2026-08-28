#!/usr/bin/env python3
"""Repair request before_* snapshots after a league-wide stat reset."""

import argparse
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import DATABASE, LEAGUE_BASELINE, repair_request_snapshots  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "reset_at",
        help="When stats were reset (YYYY-MM-DD HH:MM:SS)",
    )
    parser.add_argument(
        "--baseline",
        type=int,
        default=LEAGUE_BASELINE,
        help=f"Reset baseline (default: {LEAGUE_BASELINE})",
    )
    parser.add_argument(
        "--db",
        default=DATABASE,
        help=f"SQLite database path (default: {DATABASE})",
    )
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    result = repair_request_snapshots(db, args.reset_at, args.baseline)
    db.commit()
    db.close()

    print("Repair complete.")
    print(f"  reset_at:          {args.reset_at}")
    print(f"  baseline:          {args.baseline}")
    print(f"  reset_added:       {result['reset_added']}")
    print(f"  requests_cleared:  {result['requests_cleared']}")


if __name__ == "__main__":
    main()
