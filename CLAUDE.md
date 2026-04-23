# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Start the server:**
```
python start.py
```
Runs on `http://localhost:8000`. `start.py` auto-installs missing dependencies from `requirements.txt` on first run.

**Install dependencies manually:**
```
pip install -r requirements.txt
```

**Run the server directly (no auto-install):**
```
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

**Interactive API docs:** `http://localhost:8000/api/docs`

## Architecture

### Backend (FastAPI + SQLite)

`backend/main.py` — single FastAPI app. All REST routes and the `/ws` WebSocket endpoint live here. A module-level `ConnectionManager` holds active WebSocket connections and broadcasts JSON messages to all of them. A single `HashcatRunner` and `JobQueue` instance are created at module level and shared across requests.

`backend/job_queue.py` — async job queue. A background `asyncio` task polls every 0.5s and spawns `_run_job` coroutines up to `max_concurrent` (default 1). `_run_job` writes job status to SQLite, calls `runner.run_job()`, and broadcasts updates through the `ConnectionManager`. Log lines are kept in memory (`_logs` dict, capped at 500 lines per job) and exposed via `GET /api/jobs/{id}/log`.

`backend/hashcat_runner.py` — subprocess wrapper. `build_command()` constructs the hashcat argv list from a `Job` model. `run_job()` launches hashcat with `asyncio.create_subprocess_exec`, streams stdout line-by-line through `_parse_line()` regex matchers, and detects newly cracked hashes by diffing the potfile before and after the run. **All hashcat subprocesses must use `cwd=ROOT/hashcat`** — without this, hashcat cannot find its OpenCL directory and exits immediately. Hash types are loaded at startup via `hashcat.exe -hh` (not `--help`, which omits hash modes).

`backend/db.py` — SQLite engine + manual migrations. Schema migrations are forward-only `ALTER TABLE ADD COLUMN` statements listed in the `_MIGRATIONS` list. Add new columns there rather than deleting the database. `init_db()` is called once at startup.

`backend/models.py` — SQLModel table definitions: `Job`, `CrackedHash`, `AppSettings`.

### Hashcat exit codes
- `0` = cracked at least one hash
- `1` = exhausted (completed, nothing found) — treated as **success**
- `2` = aborted by user
- `255` = error (bad args, missing file) — treated as **failure**

### Frontend (Vanilla JS SPA)

`frontend/index.html` — shell with sidebar nav. All navigation links use `data-page` attributes and `#/page/subpage` hash routing.

`frontend/app.js` — single file containing the router, all 14 page renderer functions, WebSocket client, and API helpers. Pages are rendered by replacing `document.getElementById('content').innerHTML`. The hash type selector is a fully custom dropdown (`setupHashTypeDropdown`) because native `<select>` ignores `option.hidden` in OS-rendered dropdowns.

`frontend/style.css` — custom classes only (Tailwind CDN handles utilities). Key classes: `.nav-link`, `.card`, `.field-input`, `.btn-primary`, `.btn-secondary`, `.mode-btn`, `.tab-btn`, `.log-terminal`, `.ht-item`.

### WebSocket message protocol
All messages are JSON with a `type` field:
- `job_update` — progress/speed/status update for a running job
- `job_done` — job finished (includes final `status`)
- `crack` — a hash was cracked (includes `hash` and `plaintext`)
- `log` — a raw stdout line from hashcat

### File layout at runtime
```
uploads/hashes/        — uploaded hash files + pasted_*.txt (auto-created from textarea input)
uploads/wordlists/     — uploaded wordlists + stripped_* (auto-created when strip_wordlist=true)
sessions/              — hashcat .restore files (one per job)
hashcat.potfile        — global potfile shared across all jobs
hashcatui.db           — SQLite database
```

### Key gotchas
- **Pasted hashes** are normalised (CRLF→LF, each line stripped, empty lines removed) and saved as `pasted_<hex>.txt` using `write_bytes` — never `write_text`, which causes Windows CRLF translation.
- **Strip wordlist** (`strip_wordlist=True` on a job) creates a cached `stripped_<filename>` copy with each line stripped. It is regenerated only when the source file is newer. This exists because rockyou.txt contains entries with leading spaces (e.g. ` 3117548331`) that would never match a hash of `3117548331`.
- **Hash types cache** is an in-process global (`_hash_types_cache` in `main.py`). Force-refresh with `GET /api/hash-types?refresh=true`.
- **Schema migrations**: never delete `hashcatui.db` to add a column — add an entry to `_MIGRATIONS` in `db.py` instead.
