#!/usr/bin/env python3
"""Inspect bocce.db to debug stat snapshots and narrow down a league reset date."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import (  # noqa: E402
    DATABASE,
    LEAGUE_BASELINE,
    STAT_FIELDS,
    reconstruct_player_stats_at,
)

STAT_LABELS = {
    "placement": "PLC",
    "bowling": "BWL",
    "tilt_aversion": "TLT",
    "wall_ball": "WBL",
    "substance_use": "SUB",
    "flair": "FLR",
}


def connect(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    return db


def parse_dt(value: str) -> datetime:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(
        f"Invalid datetime {value!r} — use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS"
    )


def days_ago(value: str, now: datetime | None = None) -> str:
    now = now or datetime.now()
    dt = parse_dt(value)
    delta = now - dt
    return f"{delta.days}d ago"


def overall(stats: dict) -> int:
    return round(sum(stats[f] for f in STAT_FIELDS) / len(STAT_FIELDS))


def format_stats(stats: dict) -> str:
    parts = [f"{STAT_LABELS[f]}={stats[f]}" for f in STAT_FIELDS]
    return " ".join(parts) + f" OVR={overall(stats)}"


def before_dict(row: sqlite3.Row) -> dict:
    return {f: row[f"before_{f}"] for f in STAT_FIELDS}


def proposed_dict(row: sqlite3.Row) -> dict:
    return {f: row[f"proposed_{f}"] for f in STAT_FIELDS}


def is_flat_baseline(stats: dict, baseline: int = LEAGUE_BASELINE) -> bool:
    return all(stats[f] == baseline for f in STAT_FIELDS)


def cmd_players(db: sqlite3.Connection, _args: argparse.Namespace) -> None:
    print("=== PLAYERS (current) ===")
    for p in db.execute("SELECT * FROM players ORDER BY id"):
        stats = {f: p[f] for f in STAT_FIELDS}
        print(f"#{p['id']:>2} {p['name']:<10} {format_stats(stats)}")


def cmd_timeline(db: sqlite3.Connection, args: argparse.Namespace) -> None:
    print("=== REQUEST TIMELINE ===")
    rows = db.execute(
        """SELECT r.*, p.name AS player_name
           FROM requests r
           LEFT JOIN players p ON p.id = r.player_id
           WHERE r.player_id IS NOT NULL
           AND (r.request_type IS NULL OR r.request_type = 'stat_update')
           ORDER BY r.created_at ASC, r.id ASC"""
    ).fetchall()

    for r in rows:
        before = before_dict(r)
        proposed = proposed_dict(r)
        changed = [STAT_LABELS[f] for f in STAT_FIELDS if proposed[f] is not None]
        before_flat = is_flat_baseline(before) if any(v is not None for v in before.values()) else None
        print(
            f"#{r['id']:<3} {days_ago(r['created_at']):>8}  {r['created_at']}  "
            f"{r['status']:<8} {r['player_name'] or '?'}"
        )
        if changed:
            bits = []
            for f in STAT_FIELDS:
                if proposed[f] is None:
                    continue
                b = before[f]
                bits.append(f"{STAT_LABELS[f]} {b if b is not None else '?'}→{proposed[f]}")
            print(f"      {' | '.join(bits)}")
        if before_flat is True:
            print(f"      before_* all {LEAGUE_BASELINE}")
        elif before_flat is False:
            print(f"      before_* mixed/pre-reset era")


def cmd_history(db: sqlite3.Connection, args: argparse.Namespace) -> None:
    print("=== STAT HISTORY ===")
    by_source = db.execute(
        "SELECT source, COUNT(*) AS n FROM stat_history GROUP BY source ORDER BY source"
    ).fetchall()
    for row in by_source:
        print(f"  {row['source']}: {row['n']}")

    print("\n--- reset_all rows ---")
    resets = db.execute(
        """SELECT sh.created_at, p.name, sh.stat_field, sh.old_value, sh.new_value
           FROM stat_history sh
           JOIN players p ON p.id = sh.player_id
           WHERE sh.source='reset_all'
           ORDER BY sh.created_at, p.name, sh.stat_field"""
    ).fetchall()
    if not resets:
        print("  (none recorded)")
    else:
        current_ts = None
        for row in resets:
            if row["created_at"] != current_ts:
                current_ts = row["created_at"]
                print(f"\n  @ {row['created_at']} ({days_ago(row['created_at'])})")
            print(
                f"    {row['name']:<10} {row['stat_field']:<16} "
                f"{row['old_value']}→{row['new_value']}"
            )

    if args.player:
        player = db.execute(
            "SELECT * FROM players WHERE name=? COLLATE NOCASE",
            (args.player,),
        ).fetchone()
        if not player:
            print(f"\nPlayer not found: {args.player}")
            return
        print(f"\n--- full history: {player['name']} ---")
        for row in db.execute(
            """SELECT created_at, stat_field, old_value, new_value, source, request_id
               FROM stat_history WHERE player_id=?
               ORDER BY created_at ASC, id ASC""",
            (player["id"],),
        ):
            print(
                f"  {row['created_at']}  {row['source']:<16} "
                f"{row['stat_field']:<16} {row['old_value']}→{row['new_value']}"
                + (f" req#{row['request_id']}" if row["request_id"] else "")
            )


def cmd_reconstruct(db: sqlite3.Connection, args: argparse.Namespace) -> None:
    at = args.at.strftime("%Y-%m-%d %H:%M:%S")
    print(f"=== RECONSTRUCT @ {at} ({days_ago(at)}) ===")
    if args.player:
        players = db.execute(
            "SELECT * FROM players WHERE name=? COLLATE NOCASE",
            (args.player,),
        ).fetchall()
    else:
        players = db.execute("SELECT * FROM players ORDER BY id").fetchall()

    if not players:
        print("No players matched.")
        return

    for p in players:
        stats = reconstruct_player_stats_at(db, p["id"], at)
        print(f"{p['name']:<10} {format_stats(stats)}")


def _virtual_stats_at(db, player_id: int, at_time: str, reset_at: str, baseline: int) -> dict:
    """Reconstruct stats as if a reset happened at reset_at (without writing DB)."""
    stats = reconstruct_player_stats_at(db, player_id, at_time)
    if at_time >= reset_at:
        pre_reset = reconstruct_player_stats_at(db, player_id, reset_at)
        if not is_flat_baseline(pre_reset, baseline):
            stats = dict.fromkeys(STAT_FIELDS, baseline)
            rows = db.execute(
                """SELECT stat_field, new_value, created_at FROM stat_history
                   WHERE player_id=? AND created_at > ? AND created_at <= ?
                   ORDER BY created_at ASC, id ASC""",
                (player_id, reset_at, at_time),
            ).fetchall()
            for row in rows:
                if row["stat_field"] in stats:
                    stats[row["stat_field"]] = row["new_value"]
    return stats


def cmd_try_reset(db: sqlite3.Connection, args: argparse.Namespace) -> None:
    reset_at = args.reset_at.strftime("%Y-%m-%d %H:%M:%S")
    baseline = args.baseline
    print(f"=== DRY RUN: reset @ {reset_at} ({days_ago(reset_at)}) → baseline {baseline} ===")
    print("(Does not modify the database.)\n")

    rows = db.execute(
        """SELECT r.*, p.name AS player_name
           FROM requests r
           JOIN players p ON p.id = r.player_id
           WHERE r.request_type IS NULL OR r.request_type = 'stat_update'
           ORDER BY r.created_at ASC, r.id ASC"""
    ).fetchall()

    for r in rows:
        era = "POST-reset" if r["created_at"] >= reset_at else "PRE-reset"
        current = before_dict(r)
        expected = _virtual_stats_at(db, r["player_id"], r["created_at"], reset_at, baseline)

        mismatches = []
        for f in STAT_FIELDS:
            cur = current[f]
            exp = expected[f]
            if cur is None:
                continue
            if cur != exp:
                mismatches.append(f"{STAT_LABELS[f]} stored={cur} expected={exp}")

        marker = "OK" if not mismatches else "MISMATCH"
        print(
            f"#{r['id']:<3} {era:<10} {days_ago(r['created_at']):>8}  "
            f"{r['created_at']}  {r['player_name']}  [{marker}]"
        )
        print(f"      expected @ create: {format_stats(expected)}")
        if mismatches:
            print(f"      fixes: {', '.join(mismatches)}")
        elif era == "POST-reset" and not is_flat_baseline(current, baseline):
            print(f"      stored before_* still look pre-reset — repair would rebuild")


def cmd_guess_reset(db: sqlite3.Connection, args: argparse.Namespace) -> None:
    now = datetime.now()
    window_start = (now - timedelta(days=args.max_days)).strftime("%Y-%m-%d %H:%M:%S")
    window_end = (now - timedelta(days=args.min_days)).strftime("%Y-%m-%d %H:%M:%S")

    print("=== RESET DATE GUESS ===")
    print(f"Search window: {window_start} ({args.max_days}d ago)")
    print(f"            to {window_end} ({args.min_days}d ago)\n")

    rows = db.execute(
        """SELECT r.*, p.name AS player_name
           FROM requests r
           JOIN players p ON p.id = r.player_id
           WHERE (r.request_type IS NULL OR r.request_type = 'stat_update')
           ORDER BY r.created_at ASC, r.id ASC"""
    ).fetchall()

    if not rows:
        print("No stat requests found.")
        return

    print("Request clusters (gap > 1 day):")
    prev = None
    for r in rows:
        if prev:
            gap = parse_dt(r["created_at"]) - parse_dt(prev["created_at"])
            if gap.days >= 1:
                print(
                    f"  gap {gap.days}d between #{prev['id']} ({prev['created_at']}) "
                    f"and #{r['id']} ({r['created_at']})"
                )
        prev = r

    print("\nBoundary candidates (last pre-reset-looking → first post-reset-looking):")
    last_pre = None
    for r in rows:
        before = before_dict(r)
        has_before = any(v is not None for v in before.values())
        looks_pre = has_before and not is_flat_baseline(before, LEAGUE_BASELINE)
        if looks_pre:
            last_pre = r
        elif last_pre and r["created_at"] > last_pre["created_at"]:
            midpoint = parse_dt(last_pre["created_at"]) + (
                parse_dt(r["created_at"]) - parse_dt(last_pre["created_at"])
            ) / 2
            candidate = midpoint.strftime("%Y-%m-%d %H:%M:%S")
            print(
                f"  after #{last_pre['id']} ({last_pre['created_at']}, {last_pre['player_name']})"
            )
            print(
                f"  before #{r['id']} ({r['created_at']}, {r['player_name']})"
            )
            print(f"  → try: {candidate}\n")
            last_pre = None

    existing = db.execute(
        "SELECT DISTINCT created_at FROM stat_history WHERE source='reset_all' ORDER BY created_at"
    ).fetchall()
    if existing:
        print("Existing reset_all in stat_history:")
        for row in existing:
            print(f"  {row['created_at']} ({days_ago(row['created_at'])})")

    print("\nScoring candidate dates in window (lower mismatch count = better):")
    candidates = []
    start = parse_dt(window_start)
    end = parse_dt(window_end)
    step = timedelta(days=1)
    cur = start
    while cur <= end:
        candidates.append(cur.strftime("%Y-%m-%d %H:%M:%S"))
        cur += step

    scored = []
    for reset_at in candidates:
        mismatches = 0
        for r in rows:
            if r["created_at"] < reset_at:
                continue
            expected = _virtual_stats_at(db, r["player_id"], r["created_at"], reset_at, LEAGUE_BASELINE)
            current = before_dict(r)
            for f in STAT_FIELDS:
                if current[f] is not None and current[f] != expected[f]:
                    mismatches += 1
        scored.append((mismatches, reset_at))

    scored.sort()
    for mismatches, reset_at in scored[:8]:
        print(f"  {reset_at} ({days_ago(reset_at):>8})  mismatches={mismatches}")

    if scored:
        best = scored[0]
        print(f"\nBest guess: {best[1]} ({days_ago(best[1])})")


def cmd_dump(db: sqlite3.Connection, args: argparse.Namespace) -> None:
    """Paste-friendly JSON dump of the data needed to debug snapshots."""
    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "league_baseline": LEAGUE_BASELINE,
        "players": [],
        "requests": [],
        "stat_history_summary": [],
        "reset_all_timestamps": [],
    }

    for p in db.execute("SELECT * FROM players ORDER BY id"):
        payload["players"].append({
            "id": p["id"],
            "name": p["name"],
            **{f: p[f] for f in STAT_FIELDS},
            "overall": overall({f: p[f] for f in STAT_FIELDS}),
        })

    for r in db.execute(
        """SELECT r.*, p.name AS player_name
           FROM requests r
           LEFT JOIN players p ON p.id = r.player_id
           ORDER BY r.id"""
    ):
        payload["requests"].append({
            "id": r["id"],
            "player": r["player_name"],
            "player_id": r["player_id"],
            "status": r["status"],
            "created_at": r["created_at"],
            "closed_at": r["closed_at"],
            "days_ago": days_ago(r["created_at"]),
            "before": before_dict(r),
            "proposed": proposed_dict(r),
        })

    for row in db.execute(
        "SELECT source, COUNT(*) AS n FROM stat_history GROUP BY source ORDER BY source"
    ):
        payload["stat_history_summary"].append(dict(row))

    for row in db.execute(
        "SELECT DISTINCT created_at FROM stat_history WHERE source='reset_all' ORDER BY created_at"
    ):
        payload["reset_all_timestamps"].append(row["created_at"])

    text = json.dumps(payload, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"Wrote {args.output}")
    else:
        print(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default=DATABASE,
        help=f"SQLite database path (default: {DATABASE})",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("players", help="Show current player stats")

    sub.add_parser("timeline", help="Request timeline with before/proposed values")

    p_hist = sub.add_parser("history", help="Stat history summary and optional player detail")
    p_hist.add_argument("--player", help="Show full history for one player")

    p_rec = sub.add_parser("reconstruct", help="Rebuild stat lines at a point in time")
    p_rec.add_argument("at", type=parse_dt, help="Timestamp (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)")
    p_rec.add_argument("--player", help="Limit to one player")

    p_try = sub.add_parser("try-reset", help="Dry-run a reset date without modifying DB")
    p_try.add_argument("reset_at", type=parse_dt, help="Candidate reset timestamp")
    p_try.add_argument("--baseline", type=int, default=LEAGUE_BASELINE)

    p_guess = sub.add_parser("guess-reset", help="Suggest reset dates from request gaps and scoring")
    p_guess.add_argument("--min-days", type=int, default=111, help="Newest edge of search window")
    p_guess.add_argument("--max-days", type=int, default=142, help="Oldest edge of search window")

    p_dump = sub.add_parser("dump", help="JSON dump to paste in chat or save to file")
    p_dump.add_argument("-o", "--output", help="Write JSON to file instead of stdout")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    db = connect(args.db)

    commands = {
        "players": cmd_players,
        "timeline": cmd_timeline,
        "history": cmd_history,
        "reconstruct": cmd_reconstruct,
        "try-reset": cmd_try_reset,
        "guess-reset": cmd_guess_reset,
        "dump": cmd_dump,
    }
    commands[args.command](db, args)
    db.close()


if __name__ == "__main__":
    main()
