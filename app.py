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
ADMIN_KEY = os.environ.get("ADMIN_KEY", "bocce-admin-2024")
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
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            played_at TEXT NOT NULL,
            location TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
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
    ]
    for sql in migrations:
        try:
            db.execute(sql)
        except sqlite3.OperationalError:
            pass

    # Carry over old defense→tilt_aversion and long_game→flair for existing rows
    db.execute("UPDATE players SET tilt_aversion = defense WHERE tilt_aversion = 50 AND defense != 50")
    db.execute("UPDATE players SET flair = long_game WHERE flair = 50 AND long_game != 50")

    seed_players = [
        #       name       PLC  BWL  WBL  SUB  TLT  FLR
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


def replay_request_snapshots(db, reset_at, baseline=LEAGUE_BASELINE):
    """Rebuild before_* by replaying requests from a league reset forward.

    Assumes every player was at ``baseline`` after ``reset_at``, then walks
    requests in time order: snapshot stats at creation, apply approved changes
    at close. This avoids relying on poisoned stat_history backfill rows.
    """
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
        "request_approved": 3,
    }
    events = [(reset_at, "reset", None, None)]
    for p in players.values():
        events.append((p["created_at"], "player_join", None, p["id"]))
    for r in requests:
        events.append((r["created_at"], "request_created", r["id"], r["player_id"]))
        if r["status"] == "approved" and r["closed_at"]:
            events.append((r["closed_at"], "request_approved", r["id"], r["player_id"]))

    events.sort(key=lambda e: (e[0], event_rank[e[1]], e[2] or 0))

    sim = {}
    snapshots = {}

    def baseline_stats():
        return {f: baseline for f in STAT_FIELDS}

    for _ts, kind, req_id, player_id in events:
        if kind == "reset":
            for pid, p in players.items():
                if p["created_at"] <= _ts:
                    sim[pid] = baseline_stats()
        elif kind == "player_join":
            sim[player_id] = baseline_stats()
        elif kind == "request_created":
            r = req_map[req_id]
            pid = r["player_id"]
            if pid not in sim:
                sim[pid] = baseline_stats()
            snapshots[req_id] = dict(sim[pid])
        elif kind == "request_approved":
            r = req_map[req_id]
            pid = r["player_id"]
            if pid not in sim:
                sim[pid] = baseline_stats()
            for f in STAT_FIELDS:
                proposed = r[f"proposed_{f}"]
                if proposed is not None:
                    sim[pid][f] = proposed

    for req_id, stats in snapshots.items():
        updates = [f"before_{f}=?" for f in STAT_FIELDS]
        values = [stats[f] for f in STAT_FIELDS] + [req_id]
        db.execute(
            f"UPDATE requests SET {', '.join(updates)} WHERE id=?",
            values,
        )

    return {"requests_updated": len(snapshots)}


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


def parse_game_teams(db, data):
    """Validate an incoming game payload.

    Returns ``(teams, None)`` on success or ``(None, message)`` on failure, where
    ``teams`` is a list of dicts with ``score``, ``player_ids`` and ``guests``.
    Everything is checked before any row is written so a rejected payload never
    leaves a half-built game behind.
    """
    teams_in = data.get("teams")
    if not isinstance(teams_in, list) or len(teams_in) < 2:
        return None, "A game needs at least 2 teams"
    if len(teams_in) > MAX_TEAMS_PER_GAME:
        return None, f"A game can have at most {MAX_TEAMS_PER_GAME} teams"

    teams = []
    seen_players = set()
    for i, t in enumerate(teams_in):
        if not isinstance(t, dict):
            return None, f"Team {i + 1} is malformed"

        try:
            score = int(t.get("score"))
        except (TypeError, ValueError):
            return None, f"Team {i + 1} needs a numeric score"
        if score < 0:
            return None, f"Team {i + 1} score cannot be negative"

        player_ids = []
        for pid in t.get("player_ids") or []:
            try:
                pid = int(pid)
            except (TypeError, ValueError):
                return None, f"Team {i + 1} has an invalid player"
            if pid in seen_players:
                return None, "A player cannot be on two teams in the same game"
            if not db.execute("SELECT 1 FROM players WHERE id=?", (pid,)).fetchone():
                return None, f"Player {pid} not found"
            seen_players.add(pid)
            player_ids.append(pid)

        guests = []
        for name in t.get("guests") or []:
            name = (name or "").strip()
            if name:
                guests.append(name)

        roster_size = len(player_ids) + len(guests)
        if roster_size == 0:
            return None, f"Team {i + 1} needs at least 1 player"
        if roster_size > MAX_PLAYERS_PER_TEAM:
            return None, f"Team {i + 1} can have at most {MAX_PLAYERS_PER_TEAM} players"

        teams.append({
            "score": score,
            "player_ids": player_ids,
            "guests": guests,
        })

    top = max(t["score"] for t in teams)
    if sum(1 for t in teams if t["score"] == top) > 1:
        return None, "Scores can't be tied — someone has to win"

    return teams, None


def write_game_teams(db, game_id, teams):
    """Replace the team/roster rows for a game. Assumes ``teams`` is validated."""
    db.execute("DELETE FROM game_teams WHERE game_id=?", (game_id,))
    for i, t in enumerate(teams):
        cur = db.execute(
            "INSERT INTO game_teams (game_id, team_index, score) VALUES (?,?,?)",
            (game_id, i, t["score"]),
        )
        team_row_id = cur.lastrowid
        for pid in t["player_ids"]:
            db.execute(
                """INSERT INTO game_team_players (game_team_id, game_id, player_id, guest_name)
                   VALUES (?,?,?,NULL)""",
                (team_row_id, game_id, pid),
            )
        for name in t["guests"]:
            db.execute(
                """INSERT INTO game_team_players (game_team_id, game_id, player_id, guest_name)
                   VALUES (?,?,NULL,?)""",
                (team_row_id, game_id, name),
            )


def game_to_dict(db, row):
    """Expand a game row into teams, rosters and the derived winner."""
    game = dict(row)
    teams = db.execute(
        "SELECT * FROM game_teams WHERE game_id=? ORDER BY team_index",
        (game["id"],),
    ).fetchall()

    scores = [t["score"] for t in teams]
    top = max(scores, default=None)
    outright = scores.count(top) == 1 if teams else False
    game["teams"] = []
    for t in teams:
        members = db.execute(
            """SELECT gtp.player_id, gtp.guest_name, p.name AS player_name, p.photo_url
               FROM game_team_players gtp
               LEFT JOIN players p ON gtp.player_id = p.id
               WHERE gtp.game_team_id=?
               ORDER BY gtp.id""",
            (t["id"],),
        ).fetchall()
        td = dict(t)
        td["players"] = [
            {
                "player_id": m["player_id"],
                "name": m["player_name"] if m["player_id"] else m["guest_name"],
                "photo_url": m["photo_url"] or "",
                "is_guest": m["player_id"] is None,
            }
            for m in members
        ]
        td["won"] = outright and t["score"] == top
        game["teams"].append(td)

    winner = next((t for t in game["teams"] if t["won"]), None)
    game["winning_team_index"] = winner["team_index"] if winner else None
    return game


def player_records(db):
    """Lifetime win/loss per player id, derived from logged games."""
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
    if played:
        return jsonify({
            "error": f"{player['name']} appears in {played} logged game(s). "
                     "Delete those games first."
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
# Routes — games API
# ---------------------------------------------------------------------------

@app.route("/api/games")
def api_get_games():
    db = get_db()
    limit = request.args.get("limit", type=int)
    sql = "SELECT * FROM games ORDER BY played_at DESC, id DESC"
    params = ()
    if limit and limit > 0:
        sql += " LIMIT ?"
        params = (limit,)
    rows = db.execute(sql, params).fetchall()
    return jsonify([game_to_dict(db, r) for r in rows])


@app.route("/api/games/<int:game_id>")
def api_get_game(game_id):
    db = get_db()
    row = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if not row:
        return jsonify({"error": "Game not found"}), 404
    return jsonify(game_to_dict(db, row))


@app.route("/api/games", methods=["POST"])
def api_create_game():
    data = request.json or {}
    db = get_db()

    played_at = normalize_played_at(data.get("played_at"))
    if played_at is None:
        return jsonify({"error": "Invalid game date/time"}), 400

    teams, err = parse_game_teams(db, data)
    if err:
        return jsonify({"error": err}), 400

    cur = db.execute(
        "INSERT INTO games (played_at, location, notes) VALUES (?,?,?)",
        (
            played_at,
            (data.get("location") or "").strip(),
            (data.get("notes") or "").strip(),
        ),
    )
    game_id = cur.lastrowid
    write_game_teams(db, game_id, teams)
    db.commit()

    row = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    return jsonify(game_to_dict(db, row)), 201


@app.route("/api/games/<int:game_id>", methods=["PUT"])
def api_update_game(game_id):
    data = request.json or {}
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    game = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if not game:
        return jsonify({"error": "Game not found"}), 404

    played_at = game["played_at"]
    if "played_at" in data:
        played_at = normalize_played_at(data.get("played_at"))
        if played_at is None:
            return jsonify({"error": "Invalid game date/time"}), 400

    teams = None
    if "teams" in data:
        teams, err = parse_game_teams(db, data)
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
    if teams is not None:
        write_game_teams(db, game_id, teams)
    db.commit()

    row = db.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    return jsonify(game_to_dict(db, row))


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


@app.route("/api/records")
def api_records():
    """Lifetime win/loss standings, best record first."""
    db = get_db()
    records = player_records(db)
    rows = db.execute("SELECT id, name, photo_url FROM players ORDER BY name").fetchall()

    standings = []
    for r in rows:
        rec = records.get(r["id"], EMPTY_RECORD)
        played = rec["games_played"]
        standings.append({
            "player_id": r["id"],
            "name": r["name"],
            "photo_url": r["photo_url"],
            "win_pct": round(rec["wins"] / played, 3) if played else None,
            **rec,
        })

    standings.sort(
        key=lambda s: (s["win_pct"] is not None, s["win_pct"] or 0, s["wins"], s["point_diff"]),
        reverse=True,
    )
    return jsonify(standings)


@app.route("/api/players/<int:player_id>/games")
def api_player_games(player_id):
    db = get_db()
    if not db.execute("SELECT 1 FROM players WHERE id=?", (player_id,)).fetchone():
        return jsonify({"error": "Player not found"}), 404

    rows = db.execute(
        """SELECT g.* FROM games g
           JOIN game_team_players gtp ON gtp.game_id = g.id
           WHERE gtp.player_id=?
           ORDER BY g.played_at DESC, g.id DESC""",
        (player_id,),
    ).fetchall()

    results = db.execute(
        "SELECT game_id, result, score, opponent_score, point_diff "
        "FROM player_game_results WHERE player_id=?",
        (player_id,),
    ).fetchall()
    by_game = {r["game_id"]: dict(r) for r in results}

    games = []
    for row in rows:
        d = game_to_dict(db, row)
        d["player_result"] = by_game.get(d["id"])
        games.append(d)

    record = player_records(db).get(player_id, EMPTY_RECORD)
    return jsonify({"record": record, "games": games})


# ---------------------------------------------------------------------------
# Routes — requests API
# ---------------------------------------------------------------------------

@app.route("/api/requests", methods=["GET"])
def api_get_requests():
    status = request.args.get("status", "open")
    db = get_db()
    if status == "closed":
        rows = db.execute(
            """SELECT r.*, COALESCE(p.name, r.proposed_name) as player_name
               FROM requests r LEFT JOIN players p ON r.player_id = p.id
               WHERE r.status IN ('approved', 'denied', 'closed')
               ORDER BY r.created_at DESC""",
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT r.*, COALESCE(p.name, r.proposed_name) as player_name
               FROM requests r LEFT JOIN players p ON r.player_id = p.id
               WHERE r.status=?
               ORDER BY r.created_at DESC""",
            (status,),
        ).fetchall()

    results = []
    for row in rows:
        d = dict(row)
        d["upvote_count"] = db.execute(
            "SELECT COUNT(*) FROM upvotes WHERE request_id=?", (d["id"],)
        ).fetchone()[0]
        d["downvote_count"] = db.execute(
            "SELECT COUNT(*) FROM downvotes WHERE request_id=?", (d["id"],)
        ).fetchone()[0]
        d["comment_count"] = db.execute(
            "SELECT COUNT(*) FROM comments WHERE request_id=?", (d["id"],)
        ).fetchone()[0]
        results.append(d)
    return jsonify(results)


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
