#!/usr/bin/env python3
"""Seed Season 1 team rosters (does not create players or change stats).

  Rosso    — Joe, Louie
  Azzurri  — Milo, Joe (non pedo)
  Verde    — Zach, Seiichi
  Viola    — Jeremy, Jackson
  Giallo   — Bryce, Cole
  Arancio  — Sam, Jeremy.pdf

Dry-run (default):
  BBL_SKIP_INIT=1 python3 scripts/setup_prod_season.py

Apply:
  BBL_SKIP_INIT=1 python3 scripts/setup_prod_season.py --apply

On PythonAnywhere, set DATA_DIR to wherever bocce.db lives, e.g.:
  export DATA_DIR=$HOME/bbl
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("BBL_SKIP_INIT", "1")

from app import DATABASE  # noqa: E402

SEASON_NAME = "Season 1"

SEASON_TEAMS: list[tuple[str, list[str]]] = [
    ("Rosso", ["Joe", "Louie"]),
    ("Azzurri", ["Milo", "Joe (non pedo)"]),
    ("Verde", ["Zach", "Seiichi"]),
    ("Viola", ["Jeremy", "Jackson"]),
    ("Giallo", ["Bryce", "Cole"]),
    ("Arancio", ["Sam", "Jeremy.pdf"]),
]

NAME_ALIASES: dict[str, list[str]] = {
    "Jeremy.pdf": ["Jeremy.PDF", "Jeremy pdf", "Jeremy Pdf"],
}


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    return db


def normalize_key(name: str) -> str:
    return " ".join(name.strip().lower().split())


def load_players_by_key(db: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    out: dict[str, sqlite3.Row] = {}
    for row in db.execute("SELECT * FROM players"):
        out[normalize_key(row["name"])] = row
    return out


def resolve_player_id(by_key: dict[str, sqlite3.Row], canonical_name: str) -> int | None:
    key = normalize_key(canonical_name)
    if key in by_key:
        return by_key[key]["id"]
    for alt in NAME_ALIASES.get(canonical_name, []):
        ak = normalize_key(alt)
        if ak in by_key:
            return by_key[ak]["id"]
    return None


def preview_teams(db: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    season = db.execute(
        "SELECT * FROM seasons WHERE name=? ORDER BY id LIMIT 1", (SEASON_NAME,)
    ).fetchone()
    if not season:
        lines.append(f"  CREATE season {SEASON_NAME!r}")
    else:
        lines.append(f"  USE season {SEASON_NAME!r} (id={season['id']})")

    by_key = load_players_by_key(db)
    for team_name, members in SEASON_TEAMS:
        missing = [
            m for m in members if resolve_player_id(by_key, m) is None
        ]
        if missing:
            lines.append(f"  {team_name}: BLOCKED — no roster player {missing}")
            continue
        lines.append(f"  {team_name}: {members} (roster will be replaced)")
    return lines


def sync_season_teams(db: sqlite3.Connection) -> None:
    season = db.execute(
        "SELECT * FROM seasons WHERE name=? ORDER BY id LIMIT 1", (SEASON_NAME,)
    ).fetchone()
    if not season:
        cur = db.execute(
            "INSERT INTO seasons (name, sort_order, is_active) VALUES (?,?,1)",
            (SEASON_NAME, 1),
        )
        season_id = cur.lastrowid
    else:
        season_id = season["id"]
        db.execute("UPDATE seasons SET is_active=1 WHERE id=?", (season_id,))

    by_key = load_players_by_key(db)
    existing_teams = {
        row["name"]: row
        for row in db.execute(
            "SELECT * FROM season_teams WHERE season_id=?", (season_id,)
        ).fetchall()
    }

    for i, (team_name, members) in enumerate(SEASON_TEAMS):
        if team_name in existing_teams:
            team_id = existing_teams[team_name]["id"]
            db.execute(
                "UPDATE season_teams SET sort_order=? WHERE id=?", (i, team_id)
            )
        else:
            cur = db.execute(
                "INSERT INTO season_teams (season_id, name, sort_order) VALUES (?,?,?)",
                (season_id, team_name, i),
            )
            team_id = cur.lastrowid

        db.execute(
            "DELETE FROM season_team_players WHERE season_team_id=?", (team_id,)
        )
        for member in members:
            pid = resolve_player_id(by_key, member)
            if pid is None:
                raise RuntimeError(f"No roster player named {member!r}")
            db.execute(
                "INSERT INTO season_team_players (season_team_id, player_id) VALUES (?,?)",
                (team_id, pid),
            )

    for name, row in existing_teams.items():
        if name in {t[0] for t in SEASON_TEAMS}:
            continue
        games = db.execute(
            """SELECT COUNT(*) FROM game_sides gs
               JOIN season_teams st ON st.id = gs.season_team_id
               WHERE st.id=?""",
            (row["id"],),
        ).fetchone()[0]
        if games:
            raise RuntimeError(
                f"Old team {name!r} (id={row['id']}) has logged games; remove manually."
            )
        db.execute("DELETE FROM season_teams WHERE id=?", (row["id"],))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write changes (default is dry-run preview only)",
    )
    args = parser.parse_args()

    print(f"Database: {DATABASE}")
    if not os.path.isfile(DATABASE):
        print("ERROR: database file not found. Set DATA_DIR if prod DB is elsewhere.")
        return 1

    db = connect()
    try:
        print("\n=== SEASON 1 TEAMS ===")
        for line in preview_teams(db):
            print(line)

        if not args.apply:
            print("\nDry run only. Re-run with --apply to commit.")
            return 0

        sync_season_teams(db)
        db.commit()
        print("\nApplied. Reload the web app and refresh the Season tab.")
        return 0
    except Exception as exc:
        db.rollback()
        print(f"\nERROR: {exc}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
