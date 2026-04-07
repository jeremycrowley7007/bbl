# (BBL) Bocce Ball League

A web app for tracking bocce ball player stats with FIFA-style player cards, community stat update requests, and admin controls.

## Quick Start (Local Dev)

```bash
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5050

Set `FLASK_DEBUG=1` to enable hot reload during development.

## Features

- **FIFA 14-style player cards** with overall rating and 6 stats
- **Stat update requests** — anyone can propose changes with evidence
- **New player requests** — nominate someone to join the league
- **Comments & upvotes** — community discussion on each request
- **Admin controls** — approve/deny requests and apply stat changes
- **Photo uploads** — click any player card to upload a photo
- **Request history** — all past requests remain viewable

## Admin

Click the Admin button and enter the admin key to:
- Apply proposed stat changes to player cards
- Approve new player requests
- Deny requests with a note
- Close out resolved requests

## Stats

Each player is rated 1-99 in six categories:
- **PLC** Placement — accuracy of ball placement
- **BWL** Bowling — power and consistency of throws
- **DEF** Defense — ability to knock opponents away
- **WBL** Wall Ball — bank shot and wall play
- **SUB** Substance Use — performance enhancement via beverages
- **LNG** Long Game — distance throws and strategy

## Deploying to Railway

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATA_DIR` | Yes | Path to persistent storage (e.g. `/data`) |
| `ADMIN_KEY` | Yes | Secret key for admin operations |
| `PORT` | Auto | Set automatically by Railway |

### Setup

1. Create a new Railway project and connect your repo
2. Add a **Volume** mounted at `/data`
3. Set environment variables:
   - `DATA_DIR=/data`
   - `ADMIN_KEY=your-secret-key-here`
4. Railway will detect the `Procfile` and run `gunicorn app:app`
5. Deploy

### What lives on the volume

- `/data/bocce.db` — SQLite database (created automatically on first boot)
- `/data/photos/` — uploaded player photos

### Start command

Railway uses the Procfile automatically:
```
web: gunicorn app:app
```

### Local dev with production-like config

```bash
DATA_DIR=./data ADMIN_KEY=test-key python app.py
```
