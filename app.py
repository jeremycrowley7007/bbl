import os
import sqlite3
import uuid
from flask import Flask, render_template, request, jsonify, g, send_from_directory
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------------------
# Configuration — all tuneable via environment variables
# ---------------------------------------------------------------------------
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(__file__) or ".")
DATABASE = os.path.join(DATA_DIR, "bocce.db")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "bocce-admin-2024")
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp"}

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
    """)

    seed_players = [
        ("Jeremy", 72, 78, 65, 70, 74, 68),
        ("Prakash", 68, 62, 75, 71, 66, 73),
        ("Jackson", 80, 70, 72, 68, 77, 74),
        ("Joe", 65, 74, 70, 76, 63, 71),
        ("Zaki", 74, 66, 78, 72, 70, 67),
        ("Bryce", 70, 72, 67, 74, 72, 76),
    ]

    for name, pl, bo, de, wb, su, lg in seed_players:
        existing = db.execute("SELECT id FROM players WHERE name=?", (name,)).fetchone()
        if not existing:
            db.execute(
                "INSERT INTO players (name, placement, bowling, defense, wall_ball, substance_use, long_game) VALUES (?,?,?,?,?,?,?)",
                (name, pl, bo, de, wb, su, lg),
            )
    db.commit()
    db.close()


# Idempotent — safe to call on every boot (gunicorn or local)
init_db()


def player_to_dict(row):
    d = dict(row)
    stats = [d["placement"], d["bowling"], d["defense"], d["wall_ball"], d["substance_use"], d["long_game"]]
    d["overall"] = round(sum(stats) / len(stats))
    return d


def request_to_dict(row):
    return dict(row)


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


# ---------------------------------------------------------------------------
# Routes — players API
# ---------------------------------------------------------------------------

@app.route("/api/players")
def api_players():
    db = get_db()
    rows = db.execute("SELECT * FROM players ORDER BY id").fetchall()
    players = [player_to_dict(r) for r in rows]
    return jsonify(players)


@app.route("/api/players/<int:player_id>", methods=["PUT"])
def api_update_player(player_id):
    data = request.json
    if data.get("admin_key") != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 403

    db = get_db()
    player = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    if not player:
        return jsonify({"error": "Player not found"}), 404

    fields = ["placement", "bowling", "defense", "wall_ball", "substance_use", "long_game", "photo_url"]
    updates = []
    values = []
    for f in fields:
        if f in data:
            updates.append(f"{f}=?")
            values.append(data[f])

    if updates:
        values.append(player_id)
        db.execute(f"UPDATE players SET {', '.join(updates)} WHERE id=?", values)
        db.commit()

    row = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
    return jsonify(player_to_dict(row))


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
            proposed_placement, proposed_bowling, proposed_defense,
            proposed_wall_ball, proposed_substance_use, proposed_long_game)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            data["player_id"],
            data.get("requested_by", "Anonymous"),
            data.get("description", ""),
            data.get("proposed_placement"),
            data.get("proposed_bowling"),
            data.get("proposed_defense"),
            data.get("proposed_wall_ball"),
            data.get("proposed_substance_use"),
            data.get("proposed_long_game"),
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
            proposed_placement, proposed_bowling, proposed_defense,
            proposed_wall_ball, proposed_substance_use, proposed_long_game)
           VALUES ('new_player',?,?,?,?,?,?,?,?,?)""",
        (
            proposed_name,
            data.get("requested_by", "Anonymous"),
            data.get("description", ""),
            data.get("proposed_placement", 50),
            data.get("proposed_bowling", 50),
            data.get("proposed_defense", 50),
            data.get("proposed_wall_ball", 50),
            data.get("proposed_substance_use", 50),
            data.get("proposed_long_game", 50),
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
            """INSERT INTO players (name, placement, bowling, defense, wall_ball, substance_use, long_game)
               VALUES (?,?,?,?,?,?,?)""",
            (
                req["proposed_name"],
                req["proposed_placement"] or 50,
                req["proposed_bowling"] or 50,
                req["proposed_defense"] or 50,
                req["proposed_wall_ball"] or 50,
                req["proposed_substance_use"] or 50,
                req["proposed_long_game"] or 50,
            ),
        )
    except sqlite3.IntegrityError:
        return jsonify({"error": "Player already exists"}), 409

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

    comments = db.execute(
        "SELECT * FROM comments WHERE request_id=? ORDER BY created_at ASC", (req_id,)
    ).fetchall()
    d["comments"] = [dict(c) for c in comments]

    upvoters = db.execute(
        "SELECT voter FROM upvotes WHERE request_id=?", (req_id,)
    ).fetchall()
    d["upvoters"] = [u["voter"] for u in upvoters]

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
        stat_fields = ["placement", "bowling", "defense", "wall_ball", "substance_use", "long_game"]
        updates = []
        values = []
        for f in stat_fields:
            proposed = req[f"proposed_{f}"]
            if proposed is not None:
                updates.append(f"{f}=?")
                values.append(proposed)
        if updates:
            values.append(req["player_id"])
            db.execute(f"UPDATE players SET {', '.join(updates)} WHERE id=?", values)

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


# ---------------------------------------------------------------------------
# Local dev entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    print(f"Starting Bocce Ball League on http://localhost:{port}")
    app.run(debug=debug, host="0.0.0.0", port=port)
