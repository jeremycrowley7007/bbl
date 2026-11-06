import os
import sqlite3
import uuid
from datetime import datetime
from flask import Flask, render_template, request, jsonify, g, send_from_directory
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------------------
# Configuration — all tuneable via environment variables
# ---------------------------------------------------------------------------
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
DATABASE = os.path.join(DATA_DIR, "bocce.db")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "bocce-2026")
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp"}

STAT_FIELDS = ["placement", "bowling", "tilt_aversion", "wall_ball", "substance_use", "flair"]
LEAGUE_BASELINE = 62  # every player notionally joins the league at this value across the board
LEAGUE_RESET_AT = os.environ.get("LEAGUE_RESET_AT", "").strip() or None

BEFORE_STAT_COLUMNS = [f"before_{f}" for f in STAT_FIELDS]

MAX_TEAMS_PER_GAME = 4
MAX_PLAYERS_PER_TEAM = 4

os.makedirs(PHOTO_DIR, exist_ok=True)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            photo_url TEXT DEFAULT '',
            placement INTEGER DEFAULT 50,
            bowling INTEGER DEFAULT 50,
            defense INTEGER DEFAULT 50,
            wall_ball INTEGER DEFAULT 50,
            substance_use INTEGER DEFAULT 50,
            long_game INTEGER DEFAULT 50,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_type TEXT DEFAULT 'stat_update',
            player_id INTEGER,
            proposed_name TEXT,
            requested_by TEXT NOT NULL,
            description TEXT NOT NULL,
            proposed_placement INTEGER,
            proposed_bowling INTEGER,
            proposed_defense INTEGER,
            proposed_wall_ball INTEGER,
            proposed_substance_use INTEGER,
            proposed_long_game INTEGER,
            status TEXT DEFAULT 'open',
            admin_note TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            closed_at TEXT,
            FOREIGN KEY (player_id) REFERENCES players(id)
        );
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (request_id) REFERENCES requests(id)
        );
        CREATE TABLE IF NOT EXISTS upvotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            voter TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (request_id) REFERENCES requests(id),
            UNIQUE(request_id, voter)
        );
        CREATE TABLE IF NOT EXISTS downvotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            voter TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (request_id) REFERENCES requests(id),
            UNIQUE(request_id, voter)
        );
        CREATE TABLE IF NOT EXISTS stat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            stat_field TEXT NOT NULL,
            old_value INTEGER,
            new_value INTEGER NOT NULL,
            source TEXT NOT NULL,
            request_id INTEGER,
            changed_by TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (player_id) REFERENCES players(id),
            FOREIGN KEY (request_id) REFERENCES requests(id)
        );
        CREATE INDEX IF NOT EXISTS idx_stat_history_player
            ON stat_history(player_id, created_at);
        -- Seasons own their teams. A season_team row is the durable identity
        -- ("Rosso in Season 1" ≠ "Rosso in Season 2") — follow-up seasons get
        -- fresh team rows even if the branding repeats.
        CREATE TABLE IF NOT EXISTS seasons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS season_teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
            UNIQUE(season_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_season_teams_season ON season_teams(season_id);
        CREATE TABLE IF NOT EXISTS season_team_players (
            season_team_id INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (season_team_id, player_id),
            FOREIGN KEY (season_team_id) REFERENCES season_teams(id) ON DELETE CASCADE,
            FOREIGN KEY (player_id) REFERENCES players(id)
        );
        CREATE INDEX IF NOT EXISTS idx_stp_player ON season_team_players(player_id);

        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_id INTEGER,
            played_at TEXT NOT NULL,
            location TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (season_id) REFERENCES seasons(id)
        );
        CREATE INDEX IF NOT EXISTS idx_games_played_at ON games(played_at DESC);
        CREATE TABLE IF NOT EXISTS game_teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            team_index INTEGER NOT NULL,
            score INTEGER NOT NULL,
            FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
            UNIQUE(game_id, team_index)
        );
        CREATE INDEX IF NOT EXISTS idx_game_teams_game ON game_teams(game_id);
        CREATE TABLE IF NOT EXISTS game_team_players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_team_id INTEGER NOT NULL,
            game_id INTEGER NOT NULL,
            player_id INTEGER,
            guest_name TEXT,
            FOREIGN KEY (game_team_id) REFERENCES game_teams(id) ON DELETE CASCADE,
            FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
            FOREIGN KEY (player_id) REFERENCES players(id),
            UNIQUE(game_id, player_id),
            CHECK ((player_id IS NOT NULL AND guest_name IS NULL)
                OR (player_id IS NULL AND guest_name IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_gtp_player ON game_team_players(player_id);
        CREATE INDEX IF NOT EXISTS idx_gtp_team ON game_team_players(game_team_id);

        CREATE TABLE IF NOT EXISTS tournaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS tournament_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL,
            place INTEGER NOT NULL CHECK (place BETWEEN 1 AND 3),
            player_id INTEGER,
            name TEXT NOT NULL,
            FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
            FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tournament_results_tournament
            ON tournament_results(tournament_id, place);

        -- Season games: exactly two sides, each a season_team. Win/loss and
        -- point diff are derived, never stored.
        CREATE TABLE IF NOT EXISTS game_sides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            season_team_id INTEGER NOT NULL,
            side_index INTEGER NOT NULL,
            score INTEGER NOT NULL,
            FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
            FOREIGN KEY (season_team_id) REFERENCES season_teams(id),
            UNIQUE(game_id, side_index),
            UNIQUE(game_id, season_team_id)
        );
        CREATE INDEX IF NOT EXISTS idx_game_sides_game ON game_sides(game_id);
        CREATE INDEX IF NOT EXISTS idx_game_sides_team ON game_sides(season_team_id);

        -- Win/loss is never stored, only derived: a team won if it outscored the
        -- best of the teams it was up against. Ties are rejected when a game is
        -- logged, so a tie in the data (a hand-edited row) counts for nobody
        -- rather than awarding two winners.
        CREATE VIEW IF NOT EXISTS player_game_results AS
        SELECT
            gtp.player_id       AS player_id,
            g.id                AS game_id,
            g.played_at         AS played_at,
            gt.id               AS game_team_id,
            gt.score            AS score,
            opp.top_score       AS opponent_score,
            gt.score - opp.top_score AS point_diff,
            CASE WHEN gt.score > opp.top_score THEN 'win' ELSE 'loss' END AS result
        FROM game_team_players gtp
        JOIN game_teams gt ON gtp.game_team_id = gt.id
        JOIN games g ON gt.game_id = g.id
        JOIN (SELECT a.id AS team_id, MAX(b.score) AS top_score
              FROM game_teams a
              JOIN game_teams b ON b.game_id = a.game_id AND b.id != a.id
              GROUP BY a.id) opp ON opp.team_id = gt.id
        WHERE gtp.player_id IS NOT NULL;

    """)

    # Migrate: add new stat columns for existing databases
    migrations = [
        "ALTER TABLE players ADD COLUMN tilt_aversion INTEGER DEFAULT 50",
        "ALTER TABLE players ADD COLUMN flair INTEGER DEFAULT 50",
        "ALTER TABLE requests ADD COLUMN proposed_tilt_aversion INTEGER",
        "ALTER TABLE requests ADD COLUMN proposed_flair INTEGER",
        # Snapshot of player stats at approval time, so approved requests
        # can still display what changed after the player row is updated.
        "ALTER TABLE requests ADD COLUMN before_placement INTEGER",
        "ALTER TABLE requests ADD COLUMN before_bowling INTEGER",
        "ALTER TABLE requests ADD COLUMN before_tilt_aversion INTEGER",
        "ALTER TABLE requests ADD COLUMN before_wall_ball INTEGER",
        "ALTER TABLE requests ADD COLUMN before_substance_use INTEGER",
        "ALTER TABLE requests ADD COLUMN before_flair INTEGER",
        # Games are stamped at save time and sides are identified by index only —
        # no attribution, no team names to drift out of sync with reality.
        "ALTER TABLE games DROP COLUMN logged_by",
        "ALTER TABLE game_teams DROP COLUMN team_name",
        "ALTER TABLE games ADD COLUMN season_id INTEGER REFERENCES seasons(id)",
    ]
    for sql in migrations:
        try:
            db.execute(sql)
        except sqlite3.OperationalError:
            pass

    # Season standings view depends on games.season_id (added via migration on
    # older DBs), so create it after migrations rather than in the bootstrap DDL.
    db.execute("""
        CREATE VIEW IF NOT EXISTS season_team_game_results AS
        SELECT
            gs.season_team_id   AS season_team_id,
            g.id                AS game_id,
            g.season_id         AS season_id,
            g.played_at         AS played_at,
            gs.score            AS score,
            opp.score           AS opponent_score,
            gs.score - opp.score AS point_diff,
            CASE WHEN gs.score > opp.score THEN 'win' ELSE 'loss' END AS result
        FROM game_sides gs
        JOIN games g ON g.id = gs.game_id
        JOIN game_sides opp ON opp.game_id = gs.game_id AND opp.id != gs.id
        WHERE g.season_id IS NOT NULL
    """)

    # Carry over old defense→tilt_aversion and long_game→flair for existing rows
    db.execute("UPDATE players SET tilt_aversion = defense WHERE tilt_aversion = 50 AND defense != 50")
    db.execute("UPDATE players SET flair = long_game WHERE flair = 50 AND long_game != 50")

    seed_players = [
        #       name       PLC  BWL  WBL  SUB  TLT  CLH
        ("Jeremy",   72, 78, 70, 74, 65, 68),
        ("Prakash",  68, 62, 71, 66, 75, 73),
        ("Jackson",  80, 70, 68, 77, 72, 74),
        ("Joe",      65, 74, 76, 63, 70, 71),
        ("Zaki",     74, 66, 72, 70, 78, 67),
        ("Bryce",    70, 72, 74, 72, 67, 76),
    ]

    for name, pl, bo, wb, su, ta, fl in seed_players:
        existing = db.execute("SELECT id FROM players WHERE name=?", (name,)).fetchone()
        if not existing:
            db.execute(
                "INSERT INTO players (name, placement, bowling, wall_ball, substance_use, tilt_aversion, flair) VALUES (?,?,?,?,?,?,?)",
                (name, pl, bo, wb, su, ta, fl),
            )

    # One-shot backfill of stat_history from existing players and any approved
    # requests that already captured a `before_*` snapshot. Runs only when the
    # history table is empty, so it's safe to call on every boot.
    history_rows = db.execute("SELECT COUNT(*) FROM stat_history").fetchone()[0]
    if history_rows == 0:
        _backfill_stat_history(db)

    if LEAGUE_RESET_AT:
        ensure_reset_in_history(db, LEAGUE_RESET_AT, LEAGUE_BASELINE)

    _seed_tournaments(db)
    _seed_season_one(db)

    db.commit()
    db.close()


def _backfill_stat_history(db):
    """Reconstruct best-effort player stat history from existing data.

    Rules:
      - One ``created`` row per player per stat at ``LEAGUE_BASELINE`` — every
        player notionally joins the league at the same starting line.
      - If the player has drifted from that baseline by the time tracking
        kicked in, one ``pre_tracking`` row per stat captures that cumulative
        gap. The drift target is the earliest ``before_<stat>`` snapshot we
        have on an approved request, falling back to the player's current
        value when no approval data exists.
      - One ``request_approved`` row per stat per approved request that has a
        ``before_<stat>`` snapshot, dated ``closed_at``.
    """
    players = db.execute("SELECT * FROM players").fetchall()
    for p in players:
        for f in STAT_FIELDS:
            db.execute(
                """INSERT INTO stat_history
                   (player_id, stat_field, old_value, new_value, source, changed_by, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (p["id"], f, None, LEAGUE_BASELINE, "created", "system", p["created_at"]),
            )

            approvals = db.execute(
                f"SELECT id, before_{f} AS bv, proposed_{f} AS pv, "
                f"closed_at, requested_by FROM requests "
                f"WHERE player_id=? AND status='approved' "
                f"AND before_{f} IS NOT NULL AND proposed_{f} IS NOT NULL "
                f"ORDER BY closed_at ASC, id ASC",
                (p["id"],),
            ).fetchall()
            for a in approvals:
                db.execute(
                    """INSERT INTO stat_history
                       (player_id, stat_field, old_value, new_value, source,
                        request_id, changed_by, created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        p["id"], f, a["bv"], a["pv"], "request_approved",
                        a["id"], a["requested_by"], a["closed_at"],
                    ),
                )


# Inserted by name when missing, so later tournaments can be shipped without
# wiping admin-logged results already on production.
SEED_TOURNAMENTS = [
    ("BBL Tournament I", {1: ["Jeremy", "Joe"], 2: ["Zach", "Bryce"]}),
    ("BBL Tournament II", {
        1: ["Jeremy", "Cole"],
        2: ["Bryce", "Zaki"],
        3: ["Prakash", "Milo"],
    }),
    ("BBL Tournament III", {
        1: ["Jackson", "Milo"],
        2: ["Louie", "Seiichi"],
    }),
]


def _seed_tournaments(db):
    for name, places in SEED_TOURNAMENTS:
        existing = db.execute(
            "SELECT id FROM tournaments WHERE name=?", (name,)
        ).fetchone()
        if existing:
            continue
        cur = db.execute("INSERT INTO tournaments (name) VALUES (?)", (name,))
        for place, names in places.items():
            for person in names:
                player = db.execute(
                    "SELECT id, name FROM players WHERE lower(name)=lower(?)",
                    (person,),
                ).fetchone()
                db.execute(
                    """INSERT INTO tournament_results
                       (tournament_id, place, player_id, name)
                       VALUES (?,?,?,?)""",
                    (
                        cur.lastrowid,
                        place,
                        player["id"] if player else None,
                        player["name"] if player else person,
                    ),
                )

    # Typo fix: Tournament III was briefly seeded with "Luc" instead of Louie.
    louie = db.execute(
        "SELECT id, name FROM players WHERE lower(name)=lower(?)", ("Louie",)
    ).fetchone()
    db.execute(
        """UPDATE tournament_results
           SET name=?, player_id=?
           WHERE lower(name)=lower('Luc')
           AND tournament_id IN (
             SELECT id FROM tournaments WHERE name='BBL Tournament III'
           )""",
        (
            louie["name"] if louie else "Louie",
            louie["id"] if louie else None,
        ),
    )


def _seed_season_one(db):
    """Bootstrap Season 1 with three local scratch teams if missing.

    Real roster splits come later; for local tryouts we pair the six seed
    players into Rosso / Azzurri / Verde. Team names stay editable in the UI.
    """
    existing = db.execute(
        "SELECT id FROM seasons WHERE name=?", ("Season 1",)
    ).fetchone()
    if existing:
        return

    cur = db.execute(
        "INSERT INTO seasons (name, sort_order, is_active) VALUES (?,?,1)",
        ("Season 1", 1),
    )
    season_id = cur.lastrowid

    # Prefer the classic seed roster; fall back to whatever players exist.
    preferred = ["Jeremy", "Prakash", "Jackson", "Joe", "Zaki", "Bryce"]
    by_name = {
        r["name"]: r["id"]
        for r in db.execute("SELECT id, name FROM players").fetchall()
    }
    player_ids = [by_name[n] for n in preferred if n in by_name]
    if len(player_ids) < 6:
        extras = [
            r["id"]
            for r in db.execute("SELECT id FROM players ORDER BY id").fetchall()
            if r["id"] not in player_ids
        ]
        player_ids.extend(extras)
    player_ids = player_ids[:6]
    while len(player_ids) < 6:
        player_ids.append(None)

    roster_plan = [
        ("Rosso", player_ids[0:2]),
        ("Azzurri", player_ids[2:4]),
        ("Verde", player_ids[4:6]),
    ]
    for i, (team_name, members) in enumerate(roster_plan):
        tcur = db.execute(
            "INSERT INTO season_teams (season_id, name, sort_order) VALUES (?,?,?)",
            (season_id, team_name, i),
        )
        for pid in members:
            if pid is None:
                continue
            db.execute(
                "INSERT INTO season_team_players (season_team_id, player_id) VALUES (?,?)",
                (tcur.lastrowid, pid),
            )


def reconstruct_player_stats_at(db, player_id, at_time):
    """Rebuild a player's stat line as it stood at a given timestamp."""
    stats = {f: LEAGUE_BASELINE for f in STAT_FIELDS}
    rows = db.execute(
        """SELECT stat_field, new_value FROM stat_history
           WHERE player_id=? AND created_at <= ?
           ORDER BY created_at ASC, id ASC""",
        (player_id, at_time),
    ).fetchall()
    for row in rows:
        field = row["stat_field"]
        if field in stats:
            stats[field] = row["new_value"]
    return stats


def _backfill_request_snapshots(db):
    """Fill missing before_* columns from stat_history at request creation time."""
    requests = db.execute(
        """SELECT * FROM requests
           WHERE player_id IS NOT NULL
           AND (request_type IS NULL OR request_type = 'stat_update')"""
    ).fetchall()

    for req in requests:
        missing = [f for f in STAT_FIELDS if req[f"before_{f}"] is None]
        if not missing or not req["created_at"]:
            continue

        stats = reconstruct_player_stats_at(db, req["player_id"], req["created_at"])
        updates = []
        values = []
        for field in missing:
            updates.append(f"before_{field}=?")
            values.append(stats[field])
        values.append(req["id"])
        db.execute(
            f"UPDATE requests SET {', '.join(updates)} WHERE id=?",
            values,
        )


def _clear_request_snapshots_from(db, reset_at):
    """Drop before_* snapshots on requests created at or after a league reset."""
    nulls = ", ".join(f"{col}=NULL" for col in BEFORE_STAT_COLUMNS)
    db.execute(
        f"""UPDATE requests SET {nulls}
            WHERE player_id IS NOT NULL
            AND created_at >= ?
            AND (request_type IS NULL OR request_type = 'stat_update')""",
        (reset_at,),
    )


def ensure_reset_in_history(db, reset_at, baseline=LEAGUE_BASELINE):
    """Record a league-wide stat reset in stat_history (idempotent)."""
    existing = db.execute(
        "SELECT 1 FROM stat_history WHERE source='reset_all' AND created_at=? LIMIT 1",
        (reset_at,),
    ).fetchone()
    if existing:
        return False

    players = db.execute("SELECT id FROM players").fetchall()
    for p in players:
        stats = reconstruct_player_stats_at(db, p["id"], reset_at)
        for f in STAT_FIELDS:
            old = stats[f]
            if old == baseline:
                continue
            record_stat_change(
                db, p["id"], f, old, baseline,
                "reset_all", changed_by="admin", created_at=reset_at,
            )
    return True


def repair_request_snapshots(db, reset_at, baseline=LEAGUE_BASELINE):
    """Fix bad before_* snapshots after a league reset was missing from history."""
    return rerun_request_snapshot_backfill(db, reset_at, baseline)


def undo_request_snapshots(db):
    """Clear all before_* columns (reverses snapshot backfill)."""
    nulls = ", ".join(f"{col}=NULL" for col in BEFORE_STAT_COLUMNS)
    db.execute(
        f"""UPDATE requests SET {nulls}
            WHERE player_id IS NOT NULL
            AND (request_type IS NULL OR request_type = 'stat_update')"""
    )
    return db.execute(
        """SELECT COUNT(*) FROM requests
           WHERE player_id IS NOT NULL
           AND (request_type IS NULL OR request_type = 'stat_update')"""
    ).fetchone()[0]


def delete_requests_before(db, cutoff):
    """Delete requests created before cutoff and their related rows."""
    ids = [
        r["id"]
        for r in db.execute(
            "SELECT id FROM requests WHERE created_at < ?", (cutoff,)
        ).fetchall()
    ]
    if not ids:
        return 0

    placeholders = ",".join("?" * len(ids))
    for table in ("comments", "upvotes", "downvotes"):
        db.execute(f"DELETE FROM {table} WHERE request_id IN ({placeholders})", ids)
    db.execute(f"DELETE FROM stat_history WHERE request_id IN ({placeholders})", ids)
    db.execute(f"DELETE FROM requests WHERE id IN ({placeholders})", ids)
    return len(ids)


def _player_overall(stats):
    return round(sum(stats[f] for f in STAT_FIELDS) / len(STAT_FIELDS))


def stats_before_all_approvals(db, player_id):
    """Reverse approved requests from the current player row.

    Uses ``stat_history.old_value`` from live approvals when available so join
    stats match the roster we have today.
    """
    player = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    if not player:
        return {f: LEAGUE_BASELINE for f in STAT_FIELDS}

    sim = {f: player[f] for f in STAT_FIELDS}
    approvals = db.execute(
        """SELECT * FROM requests
           WHERE player_id=? AND status='approved' AND closed_at IS NOT NULL
           ORDER BY closed_at DESC, id DESC""",
        (player_id,),
    ).fetchall()

    for req in approvals:
        for f in STAT_FIELDS:
            proposed = req[f"proposed_{f}"]
            if proposed is None:
                continue
            row = db.execute(
                """SELECT old_value FROM stat_history
                   WHERE request_id=? AND stat_field=? AND source='request_approved'
                   LIMIT 1""",
                (req["id"], f),
            ).fetchone()
            if row and row["old_value"] is not None:
                sim[f] = row["old_value"]
    return sim


def verify_reconciliation(db, sim):
    """Compare replay end-state to current player rows."""
    rows = db.execute("SELECT * FROM players ORDER BY id").fetchall()
    report = []
    for p in rows:
        pid = p["id"]
        if pid not in sim:
            continue
        diffs = {
            f: {"sim": sim[pid][f], "actual": p[f]}
            for f in STAT_FIELDS
            if sim[pid][f] != p[f]
        }
        if diffs:
            report.append({
                "player_id": pid,
                "name": p["name"],
                "sim_overall": _player_overall(sim[pid]),
                "actual_overall": _player_overall({f: p[f] for f in STAT_FIELDS}),
                "diffs": diffs,
            })
    return report


def _ensure_sim_player(sim, players, pid, reset_at, baseline, db):
    if pid in sim:
        return
    if players[pid]["created_at"] > reset_at:
        sim[pid] = stats_before_all_approvals(db, pid)
    else:
        sim[pid] = {f: baseline for f in STAT_FIELDS}


def _history_old_value(db, req_id, field):
    row = db.execute(
        """SELECT old_value FROM stat_history
           WHERE request_id=? AND stat_field=? AND source='request_approved'
           LIMIT 1""",
        (req_id, field),
    ).fetchone()
    return row["old_value"] if row else None


def _anchor_player_snapshots_backward(db, pid, forward_snaps, player_row):
    """Rebuild approved-request snapshots by walking backward from roster row."""
    sim = {f: player_row[f] for f in STAT_FIELDS}
    approved = db.execute(
        """SELECT * FROM requests
           WHERE player_id=? AND status='approved' AND closed_at IS NOT NULL
           ORDER BY closed_at DESC, id DESC""",
        (pid,),
    ).fetchall()
    anchored = {}
    for req in approved:
        fwd = forward_snaps.get(req["id"], {})
        snap = {}
        for f in STAT_FIELDS:
            proposed = req[f"proposed_{f}"]
            if proposed is not None:
                old = _history_old_value(db, req["id"], f)
                if old is None:
                    old = fwd.get(f, sim[f])
                snap[f] = old
                sim[f] = old
            else:
                snap[f] = fwd.get(f, sim[f])
        anchored[req["id"]] = snap
    return anchored


def replay_request_snapshots(db, reset_at, baseline=LEAGUE_BASELINE):
    """Rebuild before_* by simulating from league reset forward, roster-anchored."""
    players = {
        p["id"]: p
        for p in db.execute("SELECT * FROM players").fetchall()
    }
    requests = db.execute(
        """SELECT * FROM requests
           WHERE player_id IS NOT NULL
           AND (request_type IS NULL OR request_type = 'stat_update')
           ORDER BY created_at ASC, id ASC"""
    ).fetchall()
    req_map = {r["id"]: r for r in requests}

    event_rank = {
        "reset": 0,
        "player_join": 1,
        "request_created": 2,
        "request_denied": 3,
        "request_approved": 4,
    }
    events = [(reset_at, "reset", None, None)]
    for p in players.values():
        if p["created_at"] > reset_at:
            events.append((p["created_at"], "player_join", None, p["id"]))
    for r in requests:
        if r["status"] == "open":
            events.append((r["created_at"], "request_created", r["id"], r["player_id"]))
        if r["status"] == "approved" and r["closed_at"]:
            events.append((r["closed_at"], "request_approved", r["id"], r["player_id"]))
        elif r["status"] == "denied":
            ts = r["closed_at"] or r["created_at"]
            events.append((ts, "request_denied", r["id"], r["player_id"]))

    events.sort(key=lambda e: (e[0], event_rank[e[1]], e[2] or 0))

    sim = {}
    snapshots = {}

    for _ts, kind, req_id, player_id in events:
        if kind == "reset":
            for pid, p in players.items():
                if p["created_at"] <= _ts:
                    sim[pid] = {f: baseline for f in STAT_FIELDS}
        elif kind == "player_join":
            sim[player_id] = stats_before_all_approvals(db, player_id)
        elif kind == "request_created":
            r = req_map[req_id]
            pid = r["player_id"]
            _ensure_sim_player(sim, players, pid, reset_at, baseline, db)
            snapshots[req_id] = dict(sim[pid])
        elif kind == "request_denied":
            r = req_map[req_id]
            pid = r["player_id"]
            _ensure_sim_player(sim, players, pid, reset_at, baseline, db)
            snapshots[req_id] = dict(sim[pid])
        elif kind == "request_approved":
            r = req_map[req_id]
            pid = r["player_id"]
            _ensure_sim_player(sim, players, pid, reset_at, baseline, db)
            snapshots[req_id] = dict(sim[pid])
            for f in STAT_FIELDS:
                proposed = r[f"proposed_{f}"]
                if proposed is None:
                    continue
                old = sim[pid][f]
                db.execute(
                    """UPDATE stat_history
                       SET old_value=?, new_value=?
                       WHERE request_id=? AND stat_field=? AND source='request_approved'""",
                    (old, proposed, req_id, f),
                )
                if db.execute("SELECT changes()").fetchone()[0] == 0:
                    record_stat_change(
                        db, pid, f, old, proposed,
                        "request_approved", request_id=req_id,
                    )
                sim[pid][f] = proposed

    reconciliation = verify_reconciliation(db, sim)
    for pid, player in players.items():
        has_approved = db.execute(
            """SELECT 1 FROM requests
               WHERE player_id=? AND status='approved' AND closed_at IS NOT NULL
               LIMIT 1""",
            (pid,),
        ).fetchone()
        if has_approved:
            snapshots.update(
                _anchor_player_snapshots_backward(db, pid, snapshots, player)
            )

    for req_id, stats in snapshots.items():
        updates = [f"before_{f}=?" for f in STAT_FIELDS]
        values = [stats[f] for f in STAT_FIELDS] + [req_id]
        db.execute(
            f"UPDATE requests SET {', '.join(updates)} WHERE id=?",
            values,
        )

    return {
        "requests_updated": len(snapshots),
        "reconciliation_mismatches": len(reconciliation),
        "reconciliation": reconciliation,
        "end_state": {
            players[pid]["name"]: {
                "overall": _player_overall(sim[pid]),
                **sim[pid],
            }
            for pid in sim
        },
    }


def scrub_stat_history_backfill(db):
    """Remove inferred stat_history rows that corrupt timeline replay."""
    db.execute("DELETE FROM stat_history WHERE source IN ('pre_tracking', 'created')")
    return db.execute("SELECT changes()").fetchone()[0]


def rerun_request_snapshot_backfill(db, reset_at=None, baseline=LEAGUE_BASELINE):
    """Clear before_* and rebuild from league-reset replay."""
    if not reset_at:
        raise ValueError("reset_at is required for snapshot replay")
    cleared = undo_request_snapshots(db)
    scrub_stat_history_backfill(db)
    reset_added = ensure_reset_in_history(db, reset_at, baseline)
    result = replay_request_snapshots(db, reset_at, baseline)
    result["reset_added"] = reset_added
    result["requests_cleared"] = cleared
    return result


if not os.environ.get("BBL_SKIP_INIT"):
    init_db()


def record_stat_change(db, player_id, stat_field, old_value, new_value,
                       source, request_id=None, changed_by=None, created_at=None):
    """Insert one row into stat_history. Caller is responsible for skipping no-ops."""
    if created_at:
        db.execute(
            """INSERT INTO stat_history
               (player_id, stat_field, old_value, new_value, source,
                request_id, changed_by, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (player_id, stat_field, old_value, new_value, source,
             request_id, changed_by, created_at),
        )
    else:
        db.execute(
            """INSERT INTO stat_history
               (player_id, stat_field, old_value, new_value, source, request_id, changed_by)
               VALUES (?,?,?,?,?,?,?)""",
            (player_id, stat_field, old_value, new_value, source, request_id, changed_by),
        )


def player_to_dict(row):
    d = dict(row)
    stats = [d[f] for f in STAT_FIELDS]
    d["overall"] = round(sum(stats) / len(stats))
    return d


def request_to_dict(row):
    return dict(row)


# ---------------------------------------------------------------------------
# Game results
# ---------------------------------------------------------------------------

def normalize_played_at(value):
    """Accept the browser's datetime-local format or a plain date; store 'YYYY-MM-DD HH:MM'."""
    raw = (value or "").strip().replace("T", " ")
    if not raw:
        return datetime.now().strftime("%Y-%m-%d %H:%M")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            continue
    return None


def parse_season_sides(db, season_id, data):
    """Validate a season game: exactly two distinct season teams + scores."""
    sides_in = data.get("sides")
    if not isinstance(sides_in, list) or len(sides_in) != 2:
        return None, "A season game needs exactly 2 teams"

    sides = []
    seen_teams = set()
    for i, s in enumerate(sides_in):
        if not isinstance(s, dict):
            return None, f"Side {i + 1} is malformed"
        try:
            team_id = int(s.get("season_team_id"))
            score = int(s.get("score"))
        except (TypeError, ValueError):
            return None, f"Side {i + 1} needs a team and numeric score"
        if score < 0:
            return None, f"Side {i + 1} score cannot be negative"
        if team_id in seen_teams:
            return None, "Pick two different teams"
        team = db.execute(
            "SELECT id FROM season_teams WHERE id=? AND season_id=?",
            (team_id, season_id),
        ).fetchone()
        if not team:
            return None, f"Team {team_id} is not in this season"
        seen_teams.add(team_id)
        sides.append({"season_team_id": team_id, "score": score})

    if sides[0]["score"] == sides[1]["score"]:
        return None, "Scores can't be tied — someone has to win"

    return sides, None


def write_game_sides(db, game_id, sides):
    db.execute("DELETE FROM game_sides WHERE game_id=?", (game_id,))
    for i, s in enumerate(sides):
        db.execute(
            """INSERT INTO game_sides (game_id, season_team_id, side_index, score)
               VALUES (?,?,?,?)""",
            (game_id, s["season_team_id"], i, s["score"]),
        )


def season_team_roster(db, season_team_id):
    rows = db.execute(
        """SELECT p.*
           FROM season_team_players stp
           JOIN players p ON p.id = stp.player_id
           WHERE stp.season_team_id=?
           ORDER BY p.name""",
        (season_team_id,),
    ).fetchall()
    return [player_to_dict(r) for r in rows]


def season_game_to_dict(db, row):
    """Expand a season-scoped game into sides + derived winner."""
    game = dict(row)
    sides = db.execute(
        """SELECT gs.*, st.name AS team_name
           FROM game_sides gs
           JOIN season_teams st ON st.id = gs.season_team_id
           WHERE gs.game_id=?
           ORDER BY gs.side_index""",
        (game["id"],),
    ).fetchall()

    scores = [s["score"] for s in sides]
    top = max(scores, default=None)
    outright = scores.count(top) == 1 if sides else False

    game["sides"] = []
    for s in sides:
        game["sides"].append({
            "id": s["id"],
            "season_team_id": s["season_team_id"],
            "team_name": s["team_name"],
            "side_index": s["side_index"],
            "score": s["score"],
            "players": season_team_roster(db, s["season_team_id"]),
            "won": bool(outright and s["score"] == top),
        })

    winner = next((s for s in game["sides"] if s["won"]), None)
    game["winning_season_team_id"] = winner["season_team_id"] if winner else None
    return game


def season_team_records(db, season_id):
    rows = db.execute(
        """SELECT season_team_id,
                  SUM(result = 'win')  AS wins,
                  SUM(result = 'loss') AS losses,
                  COUNT(*)             AS games_played,
                  SUM(point_diff)      AS point_diff
           FROM season_team_game_results
           WHERE season_id=?
           GROUP BY season_team_id""",
        (season_id,),
    ).fetchall()
    return {
        r["season_team_id"]: {
            "wins": r["wins"] or 0,
            "losses": r["losses"] or 0,
            "games_played": r["games_played"] or 0,
            "point_diff": r["point_diff"] or 0,
        }
        for r in rows
    }


EMPTY_TEAM_RECORD = {"wins": 0, "losses": 0, "games_played": 0, "point_diff": 0}


def season_to_dict(db, season_row):
    season = dict(season_row)
    records = season_team_records(db, season["id"])
    teams = db.execute(
        """SELECT * FROM season_teams
           WHERE season_id=?
           ORDER BY sort_order, id""",
        (season["id"],),
    ).fetchall()

    standings = []
    for t in teams:
        rec = records.get(t["id"], EMPTY_TEAM_RECORD)
        played = rec["games_played"]
        standings.append({
            "id": t["id"],
            "name": t["name"],
            "sort_order": t["sort_order"],
            "players": season_team_roster(db, t["id"]),
            "win_pct": round(rec["wins"] / played, 3) if played else None,
            **rec,
        })

    standings.sort(
        key=lambda s: (
            s["win_pct"] is not None,
            s["win_pct"] or 0,
            s["wins"],
            s["point_diff"],
        ),
        reverse=True,
    )

    games = db.execute(
        """SELECT * FROM games
           WHERE season_id=?
           ORDER BY played_at DESC, id DESC""",
        (season["id"],),
    ).fetchall()

    season["standings"] = standings
    season["games"] = [season_game_to_dict(db, g) for g in games]
    return season


def player_records(db):
    """Legacy freeform player W/L — kept for older game rows only."""
    rows = db.execute(
        """SELECT player_id,
                  SUM(result = 'win')  AS wins,
                  SUM(result = 'loss') AS losses,
                  COUNT(*)             AS games_played,
                  SUM(point_diff)      AS point_diff
           FROM player_game_results
           GROUP BY player_id"""
    ).fetchall()
    return {
        r["player_id"]: {
            "wins": r["wins"] or 0,
            "losses": r["losses"] or 0,
            "games_played": r["games_played"] or 0,
            "point_diff": r["point_diff"] or 0,
        }
        for r in rows
    }


EMPTY_RECORD = {"wins": 0, "losses": 0, "games_played": 0, "point_diff": 0}


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(PHOTO_DIR, filename)


@app.route("/api/admin/verify", methods=["POST"])
def api_verify_admin():
    data = request.json
    if data.get("admin_key") == ADMIN_KEY:
        return jsonify({"valid": True})
    return jsonify({"valid": False}), 401


@app.route("/api/admin/reset-stats", methods=["POST"])
def api_reset_stats():
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    baseline = int(data.get("baseline", LEAGUE_BASELINE))
    baseline = max(1, min(99, baseline))

    db = get_db()
    reset_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    players_before = db.execute("SELECT * FROM players").fetchall()
    db.execute(
        "UPDATE players SET placement=?, bowling=?, tilt_aversion=?, wall_ball=?, substance_use=?, flair=?",
        (baseline, baseline, baseline, baseline, baseline, baseline),
    )
    for p in players_before:
        for f in STAT_FIELDS:
            if p[f] != baseline:
                record_stat_change(
                    db, p["id"], f, p[f], baseline,
                    "reset_all", changed_by="admin", created_at=reset_at,
                )
    db.commit()
    return jsonify({"success": True, "baseline": baseline, "reset_at": reset_at})


@app.route("/api/admin/repair-snapshots", methods=["POST"])
def api_repair_snapshots():
    """Re-record a past league reset in history and rebuild request before_* snapshots."""
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    reset_at = (data.get("reset_at") or "").strip()
    if not reset_at:
        return jsonify({"error": "reset_at is required (YYYY-MM-DD HH:MM:SS)"}), 400

    baseline = int(data.get("baseline", LEAGUE_BASELINE))
    baseline = max(1, min(99, baseline))

    db = get_db()
    result = repair_request_snapshots(db, reset_at, baseline)
    db.commit()
    return jsonify({"success": True, "reset_at": reset_at, "baseline": baseline, **result})


# ---------------------------------------------------------------------------
# Routes — players API
# ---------------------------------------------------------------------------

@app.route("/api/players")
def api_players():
    db = get_db()
    rows = db.execute("SELECT * FROM players ORDER BY id").fetchall()
    records = player_records(db)
    players = []
    for r in rows:
        d = player_to_dict(r)
        d["record"] = dict(records.get(r["id"], EMPTY_RECORD))
        players.append(d)
    return jsonify(players)


@app.route("/api/players/<int:player_id>/history")
def api_player_history(player_id):
    db = get_db()
    player = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    if not player:
        return jsonify({"error": "Player not found"}), 404

    rows = db.execute(
        """SELECT * FROM stat_history
           WHERE player_id=?
           ORDER BY created_at ASC, id ASC""",
        (player_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/players", methods=["POST"])
def api_create_player():
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400

    db = get_db()
    try:
        db.execute(
            "INSERT INTO players (name, placement, bowling, tilt_aversion, wall_ball, substance_use, flair) VALUES (?,?,?,?,?,?,?)",
            (
                name,
                data.get("placement", LEAGUE_BASELINE),
                data.get("bowling", LEAGUE_BASELINE),
                data.get("tilt_aversion", LEAGUE_BASELINE),
                data.get("wall_ball", LEAGUE_BASELINE),
                data.get("substance_use", LEAGUE_BASELINE),
                data.get("flair", LEAGUE_BASELINE),
            ),
        )
    except sqlite3.IntegrityError:
        return jsonify({"error": "Player already exists"}), 409

    row = db.execute("SELECT * FROM players WHERE name=?", (name,)).fetchone()
    for f in STAT_FIELDS:
        record_stat_change(db, row["id"], f, None, row[f], "created", changed_by="admin")
    db.commit()
    return jsonify(player_to_dict(row)), 201


@app.route("/api/players/<int:player_id>", methods=["PUT"])
def api_update_player(player_id):
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    player = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    if not player:
        return jsonify({"error": "Player not found"}), 404

    fields = ["name"] + STAT_FIELDS + ["photo_url"]
    updates = []
    values = []
    for f in fields:
        if f in data:
            updates.append(f"{f}=?")
            values.append(data[f])

    if updates:
        values.append(player_id)
        db.execute(f"UPDATE players SET {', '.join(updates)} WHERE id=?", values)
        for f in STAT_FIELDS:
            if f in data and data[f] != player[f]:
                record_stat_change(
                    db, player_id, f, player[f], data[f],
                    "admin_edit", changed_by="admin",
                )
        db.commit()

    row = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    return jsonify(player_to_dict(row))


@app.route("/api/players/<int:player_id>", methods=["DELETE"])
def api_delete_player(player_id):
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    player = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    if not player:
        return jsonify({"error": "Player not found"}), 404

    played = db.execute(
        "SELECT COUNT(*) FROM game_team_players WHERE player_id=?", (player_id,)
    ).fetchone()[0]
    rostered = db.execute(
        "SELECT COUNT(*) FROM season_team_players WHERE player_id=?", (player_id,)
    ).fetchone()[0]
    if played or rostered:
        bits = []
        if played:
            bits.append(f"{played} logged game(s)")
        if rostered:
            bits.append(f"{rostered} season roster(s)")
        return jsonify({
            "error": f"{player['name']} appears in {' and '.join(bits)}. "
                     "Remove them there first."
        }), 409

    db.execute("DELETE FROM players WHERE id=?", (player_id,))
    db.commit()
    return jsonify({"success": True})


@app.route("/api/players/<int:player_id>/photo", methods=["POST"])
def api_upload_photo(player_id):
    db = get_db()
    player = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    if not player:
        return jsonify({"error": "Player not found"}), 404

    if "photo" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["photo"]
    if not file.filename:
        return jsonify({"error": "No file selected"}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": f"Invalid file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"}), 400

    filename = secure_filename(f"{player_id}_{uuid.uuid4().hex[:8]}.{ext}")
    filepath = os.path.join(PHOTO_DIR, filename)
    file.save(filepath)

    photo_url = f"/uploads/{filename}"
    db.execute("UPDATE players SET photo_url=? WHERE id=?", (photo_url, player_id))
    db.commit()

    return jsonify({"success": True, "photo_url": photo_url})


# ---------------------------------------------------------------------------
# Routes — seasons + games API
# ---------------------------------------------------------------------------

@app.route("/api/seasons")
def api_list_seasons():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, sort_order, is_active, created_at FROM seasons "
        "ORDER BY sort_order, id"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/seasons/active")
def api_active_season():
    db = get_db()
    row = db.execute(
        "SELECT * FROM seasons WHERE is_active=1 ORDER BY sort_order, id LIMIT 1"
    ).fetchone()
    if not row:
        row = db.execute(
            "SELECT * FROM seasons ORDER BY sort_order, id LIMIT 1"
        ).fetchone()
    if not row:
        return jsonify({"error": "No seasons yet"}), 404
    return jsonify(season_to_dict(db, row))


@app.route("/api/seasons/<int:season_id>")
def api_get_season(season_id):
    db = get_db()
    row = db.execute("SELECT * FROM seasons WHERE id=?", (season_id,)).fetchone()
    if not row:
        return jsonify({"error": "Season not found"}), 404
    return jsonify(season_to_dict(db, row))


@app.route("/api/season-teams/<int:team_id>", methods=["PUT"])
def api_rename_season_team(team_id):
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Team name is required"}), 400
    if len(name) > 40:
        return jsonify({"error": "Team name is too long"}), 400

    db = get_db()
    team = db.execute("SELECT * FROM season_teams WHERE id=?", (team_id,)).fetchone()
    if not team:
        return jsonify({"error": "Team not found"}), 404

    clash = db.execute(
        "SELECT 1 FROM season_teams WHERE season_id=? AND name=? AND id!=?",
        (team["season_id"], name, team_id),
    ).fetchone()
    if clash:
        return jsonify({"error": "Another team in this season already has that name"}), 400

    db.execute("UPDATE season_teams SET name=? WHERE id=?", (name, team_id))
    db.commit()
    season = db.execute(
        "SELECT * FROM seasons WHERE id=?", (team["season_id"],)
    ).fetchone()
    return jsonify(season_to_dict(db, season))


@app.route("/api/games")
def api_get_games():
    db = get_db()
    season_id = request.args.get("season_id", type=int)
    limit = request.args.get("limit", type=int)
    sql = "SELECT * FROM games WHERE season_id IS NOT NULL"
    params = []
    if season_id:
        sql += " AND season_id=?"
        params.append(season_id)
    sql += " ORDER BY played_at DESC, id DESC"
    if limit and limit > 0:
        sql += " LIMIT ?"
        params.append(limit)
    rows = db.execute(sql, params).fetchall()
    return jsonify([season_game_to_dict(db, r) for r in rows])


@app.route("/api/games/<int:game_id>")
def api_get_game(game_id):
    db = get_db()
    row = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if not row:
        return jsonify({"error": "Game not found"}), 404
    if row["season_id"] is None:
        return jsonify({"error": "Legacy freeform games are no longer supported"}), 410
    return jsonify(season_game_to_dict(db, row))


@app.route("/api/games", methods=["POST"])
def api_create_game():
    data = request.json or {}
    db = get_db()

    try:
        season_id = int(data.get("season_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "season_id is required"}), 400

    season = db.execute("SELECT * FROM seasons WHERE id=?", (season_id,)).fetchone()
    if not season:
        return jsonify({"error": "Season not found"}), 404

    played_at = normalize_played_at(data.get("played_at"))
    if played_at is None:
        return jsonify({"error": "Invalid game date/time"}), 400

    sides, err = parse_season_sides(db, season_id, data)
    if err:
        return jsonify({"error": err}), 400

    cur = db.execute(
        "INSERT INTO games (season_id, played_at, location, notes) VALUES (?,?,?,?)",
        (
            season_id,
            played_at,
            (data.get("location") or "").strip(),
            (data.get("notes") or "").strip(),
        ),
    )
    game_id = cur.lastrowid
    write_game_sides(db, game_id, sides)
    db.commit()

    row = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    return jsonify(season_game_to_dict(db, row)), 201


@app.route("/api/games/<int:game_id>", methods=["PUT"])
def api_update_game(game_id):
    data = request.json or {}
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    game = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if not game:
        return jsonify({"error": "Game not found"}), 404
    if game["season_id"] is None:
        return jsonify({"error": "Legacy freeform games are no longer supported"}), 410

    played_at = game["played_at"]
    if "played_at" in data:
        played_at = normalize_played_at(data.get("played_at"))
        if played_at is None:
            return jsonify({"error": "Invalid game date/time"}), 400

    sides = None
    if "sides" in data:
        sides, err = parse_season_sides(db, game["season_id"], data)
        if err:
            return jsonify({"error": err}), 400

    db.execute(
        "UPDATE games SET played_at=?, location=?, notes=? WHERE id=?",
        (
            played_at,
            (data["location"].strip() if "location" in data else game["location"]),
            (data["notes"].strip() if "notes" in data else game["notes"]),
            game_id,
        ),
    )
    if sides is not None:
        write_game_sides(db, game_id, sides)
    db.commit()

    row = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    return jsonify(season_game_to_dict(db, row))


@app.route("/api/games/<int:game_id>", methods=["DELETE"])
def api_delete_game(game_id):
    data = request.json or {}
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    if not db.execute("SELECT 1 FROM games WHERE id=?", (game_id,)).fetchone():
        return jsonify({"error": "Game not found"}), 404

    db.execute("DELETE FROM games WHERE id=?", (game_id,))
    db.commit()
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# Routes — tournaments
# ---------------------------------------------------------------------------

MAX_PLAYERS_PER_PLACE = 4
PLACE_LABELS = {1: "First", 2: "Second", 3: "Third"}


def serialize_tournaments(db):
    tournaments = db.execute(
        "SELECT * FROM tournaments ORDER BY id ASC"
    ).fetchall()
    results = []
    for tournament in tournaments:
        rows = db.execute(
            """SELECT tr.place, tr.player_id, tr.name AS saved_name,
                      p.name AS player_name, p.photo_url
               FROM tournament_results tr
               LEFT JOIN players p ON p.id = tr.player_id
               WHERE tr.tournament_id=?
               ORDER BY tr.place, tr.id""",
            (tournament["id"],),
        ).fetchall()
        places = {"1": [], "2": [], "3": []}
        for row in rows:
            places[str(row["place"])].append({
                "player_id": row["player_id"],
                "name": row["player_name"] or row["saved_name"],
                "photo_url": row["photo_url"] or "",
                "is_guest": row["player_id"] is None,
            })
        results.append({
            "id": tournament["id"],
            "name": tournament["name"],
            "places": places,
        })
    return results


def parse_tournament_places(db, raw_places):
    if not isinstance(raw_places, dict):
        raise ValueError("Add players to at least first place.")

    cleaned = {1: [], 2: [], 3: []}
    seen_ids = set()
    seen_names = set()

    for place in (1, 2, 3):
        entries = raw_places.get(str(place), raw_places.get(place, [])) or []
        if not isinstance(entries, list):
            raise ValueError(f"{PLACE_LABELS[place]} place is invalid.")
        if len(entries) > MAX_PLAYERS_PER_PLACE:
            raise ValueError(
                f"{PLACE_LABELS[place]} place can have at most {MAX_PLAYERS_PER_PLACE} players."
            )
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError(f"{PLACE_LABELS[place]} place is invalid.")
            player_id = entry.get("player_id")
            guest_name = (entry.get("guest_name") or "").strip()

            if player_id:
                player = db.execute(
                    "SELECT id, name FROM players WHERE id=?", (player_id,)
                ).fetchone()
                if not player:
                    raise ValueError("One of those players is no longer on the roster.")
                person_id, person_name = player["id"], player["name"]
            elif guest_name:
                player = db.execute(
                    "SELECT id, name FROM players WHERE lower(name)=lower(?)",
                    (guest_name,),
                ).fetchone()
                if player:
                    person_id, person_name = player["id"], player["name"]
                else:
                    person_id, person_name = None, guest_name
            else:
                raise ValueError("Each spot needs a roster player or a guest name.")

            name_key = person_name.lower()
            if person_id in seen_ids or name_key in seen_names:
                raise ValueError(f"{person_name} is listed more than once.")
            if person_id is not None:
                seen_ids.add(person_id)
            seen_names.add(name_key)
            cleaned[place].append((person_id, person_name))

    if not cleaned[1]:
        raise ValueError("First place needs at least one player.")
    return cleaned


def save_tournament_results(db, tournament_id, places):
    db.execute(
        "DELETE FROM tournament_results WHERE tournament_id=?", (tournament_id,)
    )
    for place, members in places.items():
        for player_id, name in members:
            db.execute(
                """INSERT INTO tournament_results
                   (tournament_id, place, player_id, name)
                   VALUES (?,?,?,?)""",
                (tournament_id, place, player_id, name),
            )


@app.route("/api/tournaments", methods=["GET"])
def api_get_tournaments():
    return jsonify(serialize_tournaments(get_db()))


@app.route("/api/tournaments", methods=["POST"])
def api_create_tournament():
    data = request.json or {}
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Tournament name is required."}), 400
    if len(name) > 80:
        return jsonify({"error": "Tournament name is too long."}), 400

    db = get_db()
    try:
        places = parse_tournament_places(db, data.get("places"))
        cur = db.execute("INSERT INTO tournaments (name) VALUES (?)", (name,))
        save_tournament_results(db, cur.lastrowid, places)
        db.commit()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except sqlite3.IntegrityError:
        return jsonify({"error": "A tournament with that name already exists."}), 409

    return jsonify({"success": True}), 201


@app.route("/api/tournaments/<int:tournament_id>", methods=["PUT"])
def api_update_tournament(tournament_id):
    data = request.json or {}
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Tournament name is required."}), 400
    if len(name) > 80:
        return jsonify({"error": "Tournament name is too long."}), 400

    db = get_db()
    existing = db.execute(
        "SELECT id FROM tournaments WHERE id=?", (tournament_id,)
    ).fetchone()
    if not existing:
        return jsonify({"error": "Tournament not found."}), 404

    try:
        places = parse_tournament_places(db, data.get("places"))
        db.execute(
            "UPDATE tournaments SET name=? WHERE id=?", (name, tournament_id)
        )
        save_tournament_results(db, tournament_id, places)
        db.commit()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except sqlite3.IntegrityError:
        return jsonify({"error": "A tournament with that name already exists."}), 409

    return jsonify({"success": True})


@app.route("/api/tournaments/<int:tournament_id>", methods=["DELETE"])
def api_delete_tournament(tournament_id):
    data = request.json or {}
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    deleted = db.execute(
        "DELETE FROM tournaments WHERE id=?", (tournament_id,)
    ).rowcount
    db.commit()
    if not deleted:
        return jsonify({"error": "Tournament not found."}), 404
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# Routes — requests API
# ---------------------------------------------------------------------------

@app.route("/api/requests", methods=["GET"])
def api_get_requests():
    status = request.args.get("status", "open")
    paginated = "page" in request.args or "per_page" in request.args
    try:
        page = max(1, int(request.args.get("page", 1)))
        per_page = min(25, max(1, int(request.args.get("per_page", 6))))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid pagination"}), 400

    player_id = request.args.get("player_id", "").strip()
    if player_id:
        try:
            player_id = int(player_id)
        except ValueError:
            return jsonify({"error": "Invalid player"}), 400

    db = get_db()
    if status == "closed":
        where = "r.status IN ('approved', 'denied', 'closed')"
        params = []
        if player_id:
            where += " AND r.player_id=?"
            params.append(player_id)
    else:
        where = "r.status=?"
        params = [status]

    total = db.execute(
        f"SELECT COUNT(*) FROM requests r WHERE {where}", params
    ).fetchone()[0]
    pages = max(1, (total + per_page - 1) // per_page)
    page = min(page, pages)

    limit_sql = ""
    query_params = list(params)
    if paginated:
        limit_sql = " LIMIT ? OFFSET ?"
        query_params.extend([per_page, (page - 1) * per_page])

    rows = db.execute(
        f"""SELECT r.*, COALESCE(p.name, r.proposed_name) as player_name,
                   (SELECT COUNT(*) FROM upvotes u WHERE u.request_id=r.id) AS upvote_count,
                   (SELECT COUNT(*) FROM downvotes d WHERE d.request_id=r.id) AS downvote_count,
                   (SELECT COUNT(*) FROM comments c WHERE c.request_id=r.id) AS comment_count
            FROM requests r LEFT JOIN players p ON r.player_id = p.id
            WHERE {where}
            ORDER BY r.created_at DESC{limit_sql}""",
        query_params,
    ).fetchall()

    results = [dict(row) for row in rows]
    if not paginated:
        return jsonify(results)

    return jsonify({
        "items": results,
        "page": page,
        "per_page": per_page,
        "total": total,
        "pages": pages,
    })


@app.route("/api/requests/counts", methods=["GET"])
def api_request_counts():
    db = get_db()
    open_count = db.execute(
        "SELECT COUNT(*) FROM requests WHERE status='open'"
    ).fetchone()[0]
    closed_count = db.execute(
        "SELECT COUNT(*) FROM requests WHERE status IN ('approved', 'denied', 'closed')"
    ).fetchone()[0]
    return jsonify({"open": open_count, "closed": closed_count})


@app.route("/api/requests", methods=["POST"])
def api_create_request():
    data = request.json
    db = get_db()

    player = db.execute("SELECT * FROM players WHERE id=?", (data.get("player_id"),)).fetchone()
    if not player:
        return jsonify({"error": "Player not found"}), 404

    db.execute(
        """INSERT INTO requests
           (player_id, requested_by, description,
            proposed_placement, proposed_bowling, proposed_tilt_aversion,
            proposed_wall_ball, proposed_substance_use, proposed_flair,
            before_placement, before_bowling, before_tilt_aversion,
            before_wall_ball, before_substance_use, before_flair)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            data["player_id"],
            data.get("requested_by", "Anonymous"),
            data.get("description", ""),
            data.get("proposed_placement"),
            data.get("proposed_bowling"),
            data.get("proposed_tilt_aversion"),
            data.get("proposed_wall_ball"),
            data.get("proposed_substance_use"),
            data.get("proposed_flair"),
            player["placement"],
            player["bowling"],
            player["tilt_aversion"],
            player["wall_ball"],
            player["substance_use"],
            player["flair"],
        ),
    )
    db.commit()
    return jsonify({"success": True}), 201


@app.route("/api/requests/new-player", methods=["POST"])
def api_create_new_player_request():
    data = request.json
    db = get_db()

    proposed_name = data.get("proposed_name", "").strip()
    if not proposed_name:
        return jsonify({"error": "Player name is required"}), 400

    db.execute(
        """INSERT INTO requests
           (request_type, proposed_name, requested_by, description,
            proposed_placement, proposed_bowling, proposed_tilt_aversion,
            proposed_wall_ball, proposed_substance_use, proposed_flair)
           VALUES ('new_player',?,?,?,?,?,?,?,?,?)""",
        (
            proposed_name,
            data.get("requested_by", "Anonymous"),
            data.get("description", ""),
            data.get("proposed_placement", LEAGUE_BASELINE),
            data.get("proposed_bowling", LEAGUE_BASELINE),
            data.get("proposed_tilt_aversion", LEAGUE_BASELINE),
            data.get("proposed_wall_ball", LEAGUE_BASELINE),
            data.get("proposed_substance_use", LEAGUE_BASELINE),
            data.get("proposed_flair", LEAGUE_BASELINE),
        ),
    )
    db.commit()
    return jsonify({"success": True}), 201


@app.route("/api/requests/<int:req_id>/approve-player", methods=["POST"])
def api_approve_new_player(req_id):
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    req = db.execute("SELECT * FROM requests WHERE id=? AND request_type='new_player'", (req_id,)).fetchone()
    if not req:
        return jsonify({"error": "Not found"}), 404

    try:
        db.execute(
            """INSERT INTO players (name, placement, bowling, tilt_aversion, wall_ball, substance_use, flair)
               VALUES (?,?,?,?,?,?,?)""",
            (
                req["proposed_name"],
                req["proposed_placement"] or LEAGUE_BASELINE,
                req["proposed_bowling"] or LEAGUE_BASELINE,
                req["proposed_tilt_aversion"] or LEAGUE_BASELINE,
                req["proposed_wall_ball"] or LEAGUE_BASELINE,
                req["proposed_substance_use"] or LEAGUE_BASELINE,
                req["proposed_flair"] or LEAGUE_BASELINE,
            ),
        )
    except sqlite3.IntegrityError:
        return jsonify({"error": "Player already exists"}), 409

    new_player = db.execute(
        "SELECT * FROM players WHERE name=?", (req["proposed_name"],)
    ).fetchone()
    if new_player is not None:
        for f in STAT_FIELDS:
            record_stat_change(
                db, new_player["id"], f, None, new_player[f],
                "created",
                request_id=req_id,
                changed_by=req["requested_by"],
            )

    db.execute(
        "UPDATE requests SET status='approved', admin_note=?, closed_at=datetime('now') WHERE id=?",
        (data.get("admin_note", "Player added!"), req_id),
    )
    db.commit()
    return jsonify({"success": True})


@app.route("/api/requests/<int:req_id>")
def api_get_request(req_id):
    db = get_db()
    row = db.execute(
        """SELECT r.*, COALESCE(p.name, r.proposed_name) as player_name
           FROM requests r LEFT JOIN players p ON r.player_id = p.id
           WHERE r.id=?""",
        (req_id,),
    ).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404

    d = dict(row)
    d["upvote_count"] = db.execute(
        "SELECT COUNT(*) FROM upvotes WHERE request_id=?", (req_id,)
    ).fetchone()[0]
    d["downvote_count"] = db.execute(
        "SELECT COUNT(*) FROM downvotes WHERE request_id=?", (req_id,)
    ).fetchone()[0]

    comments = db.execute(
        "SELECT * FROM comments WHERE request_id=? ORDER BY created_at ASC", (req_id,)
    ).fetchall()
    d["comments"] = [dict(c) for c in comments]

    upvoters = db.execute(
        "SELECT voter FROM upvotes WHERE request_id=?", (req_id,)
    ).fetchall()
    d["upvoters"] = [u["voter"] for u in upvoters]

    downvoters = db.execute(
        "SELECT voter FROM downvotes WHERE request_id=?", (req_id,)
    ).fetchall()
    d["downvoters"] = [u["voter"] for u in downvoters]

    return jsonify(d)


@app.route("/api/requests/<int:req_id>/close", methods=["POST"])
def api_close_request(req_id):
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    req = db.execute("SELECT * FROM requests WHERE id=?", (req_id,)).fetchone()
    if not req:
        return jsonify({"error": "Not found"}), 404

    resolution = "denied"
    if data.get("apply_changes"):
        resolution = "approved"
        player = db.execute(
            "SELECT * FROM players WHERE id=?", (req["player_id"],)
        ).fetchone()

        before_updates = []
        before_values = []
        stat_updates = []
        stat_values = []
        for f in STAT_FIELDS:
            proposed = req[f"proposed_{f}"]
            if proposed is None:
                continue
            stat_updates.append(f"{f}=?")
            stat_values.append(proposed)
            if player is not None:
                before_updates.append(f"before_{f}=?")
                before_values.append(player[f])

        if stat_updates and player is not None:
            stat_values.append(req["player_id"])
            db.execute(
                f"UPDATE players SET {', '.join(stat_updates)} WHERE id=?",
                stat_values,
            )

            for f in STAT_FIELDS:
                proposed = req[f"proposed_{f}"]
                if proposed is None or proposed == player[f]:
                    continue
                record_stat_change(
                    db, player["id"], f, player[f], proposed,
                    "request_approved",
                    request_id=req_id,
                    changed_by=req["requested_by"],
                )

        if before_updates:
            before_values.append(req_id)
            db.execute(
                f"UPDATE requests SET {', '.join(before_updates)} WHERE id=?",
                before_values,
            )

    db.execute(
        "UPDATE requests SET status=?, admin_note=?, closed_at=datetime('now') WHERE id=?",
        (resolution, data.get("admin_note", ""), req_id),
    )
    db.commit()
    return jsonify({"success": True})


@app.route("/api/requests/<int:req_id>/comment", methods=["POST"])
def api_add_comment(req_id):
    data = request.json
    db = get_db()
    db.execute(
        "INSERT INTO comments (request_id, author, body) VALUES (?,?,?)",
        (req_id, data.get("author", "Anonymous"), data.get("body", "")),
    )
    db.commit()
    return jsonify({"success": True}), 201


@app.route("/api/requests/<int:req_id>/upvote", methods=["POST"])
def api_upvote(req_id):
    data = request.json
    voter = data.get("voter", "Anonymous")
    db = get_db()
    try:
        db.execute(
            "INSERT INTO upvotes (request_id, voter) VALUES (?,?)", (req_id, voter)
        )
        db.commit()
        return jsonify({"success": True}), 201
    except sqlite3.IntegrityError:
        db.execute(
            "DELETE FROM upvotes WHERE request_id=? AND voter=?", (req_id, voter)
        )
        db.commit()
        return jsonify({"success": True, "removed": True})


@app.route("/api/requests/<int:req_id>/downvote", methods=["POST"])
def api_downvote(req_id):
    data = request.json
    voter = data.get("voter", "Anonymous")
    db = get_db()
    try:
        db.execute(
            "INSERT INTO downvotes (request_id, voter) VALUES (?,?)", (req_id, voter)
        )
        db.commit()
        return jsonify({"success": True}), 201
    except sqlite3.IntegrityError:
        db.execute(
            "DELETE FROM downvotes WHERE request_id=? AND voter=?", (req_id, voter)
        )
        db.commit()
        return jsonify({"success": True, "removed": True})


# ---------------------------------------------------------------------------
# Local dev entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    print(f"Starting Bocce Ball League on http://localhost:{port}")
    app.run(debug=debug, host="0.0.0.0", port=port)
