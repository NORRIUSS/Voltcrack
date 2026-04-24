import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import (
    Depends, FastAPI, File, HTTPException, UploadFile, WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlmodel import Session, select

from .db import engine, get_session, init_db
from .hashcat_runner import (
    HASHCAT_MASKS, HASHCAT_RULES, POTFILE_PATH, SESSIONS_DIR,
    UPLOADS_HASHES, UPLOADS_WORDLISTS, HashcatRunner,
)
from .job_queue import JobQueue, LOGS_DIR
from .models import AppSettings, CrackedHash, Job, JobStatus, JobTemplate

ROOT = Path(__file__).parent.parent
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="Voltcrack", docs_url="/api/docs")

runner = HashcatRunner()
queue = JobQueue(runner)
_hash_types_cache: Optional[list] = None
_devices_cache: Optional[list] = None


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        self.connections: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, data: dict):
        msg = json.dumps(data, default=str)
        dead = []
        for ws in list(self.connections):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    for d in [UPLOADS_HASHES, UPLOADS_WORDLISTS, SESSIONS_DIR]:
        d.mkdir(parents=True, exist_ok=True)
    init_db()
    queue.start(manager)

    # Auto-restore jobs that were running when server last stopped
    with Session(engine) as db:
        stuck = db.exec(select(Job).where(Job.status == JobStatus.running)).all()
        for job in stuck:
            job.status = JobStatus.pending
            db.commit()
            queue.enqueue(job.id)


# ---------------------------------------------------------------------------
# Static + index
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


# ---------------------------------------------------------------------------
# Hash types
# ---------------------------------------------------------------------------

@app.get("/api/hash-types")
async def get_hash_types(refresh: bool = False):
    global _hash_types_cache
    if _hash_types_cache is None or refresh:
        _hash_types_cache = await runner.get_hash_types()
    return _hash_types_cache


@app.get("/api/devices")
async def get_devices(refresh: bool = False):
    global _devices_cache
    if _devices_cache is None or refresh:
        _devices_cache = await runner.get_devices()
    return _devices_cache


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def _strip_wordlist(filename: Optional[str]) -> Optional[str]:
    """Return a temp wordlist with each entry's leading/trailing whitespace stripped.
    Returns the original filename unchanged if it is None or already stripped."""
    if not filename:
        return filename
    src = UPLOADS_WORDLISTS / filename
    if not src.exists():
        return filename
    stripped_name = f"stripped_{filename}"
    dest = UPLOADS_WORDLISTS / stripped_name
    # Only regenerate if the source is newer than the cached stripped file
    if not dest.exists() or src.stat().st_mtime > dest.stat().st_mtime:
        with src.open("rb") as fin, dest.open("wb") as fout:
            for line in fin:
                fout.write(line.strip() + b"\n")
    return stripped_name

class JobCreate(BaseModel):
    name: str = "Unnamed Job"
    hash_type: int
    attack_mode: int
    hash_file: Optional[str] = None   # existing uploaded file
    hash_text: Optional[str] = None   # raw pasted hashes
    wordlist: Optional[str] = None
    wordlist2: Optional[str] = None
    rules: Optional[str] = None
    mask: Optional[str] = None
    extra_args: Optional[str] = None
    devices: Optional[str] = None
    strip_wordlist: bool = False


@app.get("/api/jobs")
async def list_jobs(db: Session = Depends(get_session)):
    jobs = db.exec(select(Job).order_by(Job.created_at.desc())).all()
    return jobs


@app.post("/api/jobs", status_code=201)
async def create_job(body: JobCreate, db: Session = Depends(get_session)):
    if body.hash_text and body.hash_text.strip():
        # Normalise line endings, strip each hash line, drop blanks
        raw = body.hash_text.replace('\r\n', '\n').replace('\r', '\n')
        lines = [l.strip() for l in raw.split('\n') if l.strip()]
        if not lines:
            raise HTTPException(400, "No valid hashes found in input")
        filename = f"pasted_{uuid.uuid4().hex[:8]}.txt"
        # write_bytes avoids any Windows text-mode CRLF translation
        (UPLOADS_HASHES / filename).write_bytes(('\n'.join(lines) + '\n').encode('utf-8'))
        hash_file = filename
    elif body.hash_file:
        if not (UPLOADS_HASHES / body.hash_file).exists():
            raise HTTPException(400, f"Hash file '{body.hash_file}' not found")
        hash_file = body.hash_file
    else:
        raise HTTPException(400, "Provide either hash_text or hash_file")

    # Strip leading/trailing whitespace from each wordlist entry if requested.
    # rockyou.txt and similar lists sometimes contain entries like " password"
    # which produce a different hash from "password".
    wordlist = body.wordlist
    wordlist2 = body.wordlist2
    if body.strip_wordlist:
        wordlist  = _strip_wordlist(wordlist)
        wordlist2 = _strip_wordlist(wordlist2)

    session_name = f"job_{uuid.uuid4().hex[:10]}"
    job = Job(
        name=body.name,
        hash_type=body.hash_type,
        attack_mode=body.attack_mode,
        hash_file=hash_file,
        wordlist=wordlist,
        wordlist2=wordlist2,
        rules=body.rules,
        mask=body.mask,
        extra_args=body.extra_args,
        devices=body.devices,
        strip_wordlist=body.strip_wordlist,
        session_name=session_name,
        status=JobStatus.pending,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    queue.enqueue(job.id)
    return job


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: int, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.delete("/api/jobs/{job_id}")
async def cancel_job(job_id: int, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    await queue.kill(job_id)
    if job.status in (JobStatus.pending, JobStatus.running):
        job.status = JobStatus.cancelled
        job.finished_at = datetime.utcnow()
        db.commit()
    return {"ok": True}


@app.post("/api/jobs/{job_id}/pause")
async def pause_job(job_id: int, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.running:
        raise HTTPException(400, "Job is not running")
    await queue.pause(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: int, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.paused:
        raise HTTPException(400, "Job is not paused")
    job.status = JobStatus.pending
    db.commit()
    queue.enqueue(job_id, restore=True)
    return {"ok": True}


@app.delete("/api/history/{job_id}")
async def delete_history_job(job_id: int, db: Session = Depends(get_session)):
    """Permanently delete a completed/failed/cancelled job record from history."""
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status in (JobStatus.running, JobStatus.pending):
        raise HTTPException(400, "Cannot delete a running or pending job; cancel it first")
    # Also remove associated cracked hashes
    cracked = db.exec(select(CrackedHash).where(CrackedHash.job_id == job_id)).all()
    for c in cracked:
        db.delete(c)
    db.delete(job)
    db.commit()
    log_file = LOGS_DIR / f"{job_id}.txt"
    if log_file.exists():
        log_file.unlink()
    return {"ok": True}


@app.delete("/api/history")
async def clear_history(db: Session = Depends(get_session)):
    """Permanently delete ALL completed/failed/cancelled jobs from history."""
    done_statuses = (JobStatus.completed, JobStatus.failed, JobStatus.cancelled)
    jobs = db.exec(select(Job).where(Job.status.in_(done_statuses))).all()
    for job in jobs:
        cracked = db.exec(select(CrackedHash).where(CrackedHash.job_id == job.id)).all()
        for c in cracked:
            db.delete(c)
        db.delete(job)
        log_file = LOGS_DIR / f"{job.id}.txt"
        if log_file.exists():
            log_file.unlink()
    db.commit()
    return {"ok": True, "deleted": len(jobs)}


@app.get("/api/jobs/{job_id}/log")
async def get_job_log(job_id: int):
    lines = queue.get_logs(job_id)
    return {"lines": lines}


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

@app.get("/api/results")
async def get_all_results(db: Session = Depends(get_session)):
    rows = db.exec(
        select(CrackedHash).order_by(CrackedHash.cracked_at.desc())
    ).all()
    return rows


@app.get("/api/results/{job_id}")
async def get_results(job_id: int, db: Session = Depends(get_session)):
    rows = db.exec(select(CrackedHash).where(CrackedHash.job_id == job_id)).all()
    return rows


@app.get("/api/results/{job_id}/export")
async def export_results(job_id: int, fmt: str = "txt", db: Session = Depends(get_session)):
    rows = db.exec(select(CrackedHash).where(CrackedHash.job_id == job_id)).all()
    if fmt == "json":
        return JSONResponse([{"hash": r.hash, "plaintext": r.plaintext} for r in rows])
    if fmt == "csv":
        lines = ["hash,plaintext"] + [f"{r.hash},{r.plaintext}" for r in rows]
        return PlainTextResponse("\n".join(lines), media_type="text/csv")
    # default txt
    lines = [f"{r.hash}:{r.plaintext}" for r in rows]
    return PlainTextResponse("\n".join(lines))


@app.get("/api/potfile")
async def get_potfile():
    if not POTFILE_PATH.exists():
        return []
    entries = []
    for line in POTFILE_PATH.read_text(errors="replace").splitlines():
        line = line.strip()
        if ":" in line:
            h, _, p = line.partition(":")
            entries.append({"hash": h, "plaintext": p})
    return entries


@app.delete("/api/potfile")
async def clear_potfile():
    if POTFILE_PATH.exists():
        POTFILE_PATH.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# File management
# ---------------------------------------------------------------------------

@app.get("/api/files/hashes")
async def list_hashes():
    return sorted(f.name for f in UPLOADS_HASHES.iterdir() if f.is_file())


@app.post("/api/files/hashes", status_code=201)
async def upload_hash(file: UploadFile = File(...)):
    dest = UPLOADS_HASHES / file.filename
    dest.write_bytes(await file.read())
    return {"filename": file.filename, "size": dest.stat().st_size}


@app.get("/api/files/hashes/{filename}/content")
async def read_hash_file(filename: str):
    f = UPLOADS_HASHES / filename
    if not f.exists():
        raise HTTPException(404)
    return PlainTextResponse(f.read_text(encoding="utf-8", errors="replace"))


@app.delete("/api/files/hashes/{filename}")
async def delete_hash(filename: str):
    f = UPLOADS_HASHES / filename
    if not f.exists():
        raise HTTPException(404)
    f.unlink()
    return {"ok": True}


@app.get("/api/files/wordlists")
async def list_wordlists():
    return sorted(f.name for f in UPLOADS_WORDLISTS.iterdir() if f.is_file())


@app.post("/api/files/wordlists", status_code=201)
async def upload_wordlist(file: UploadFile = File(...)):
    dest = UPLOADS_WORDLISTS / file.filename
    dest.write_bytes(await file.read())
    return {"filename": file.filename, "size": dest.stat().st_size}


@app.delete("/api/files/wordlists/{filename}")
async def delete_wordlist(filename: str):
    f = UPLOADS_WORDLISTS / filename
    if not f.exists():
        raise HTTPException(404)
    f.unlink()
    return {"ok": True}


@app.get("/api/files/rules")
async def list_rules():
    if not HASHCAT_RULES.exists():
        return []
    return sorted(f.name for f in HASHCAT_RULES.iterdir()
                  if f.suffix in (".rule", ".rules") and f.is_file())


@app.get("/api/files/masks")
async def list_masks():
    if not HASHCAT_MASKS.exists():
        return []
    return sorted(f.name for f in HASHCAT_MASKS.iterdir()
                  if f.suffix == ".hcmask" and f.is_file())


# ---------------------------------------------------------------------------
# Hash duplicate check
# ---------------------------------------------------------------------------

class HashCheckRequest(BaseModel):
    hashes: List[str]
    hash_type: Optional[int] = None


@app.post("/api/check-hashes")
async def check_hashes(body: HashCheckRequest, db: Session = Depends(get_session)):
    """Return any hashes from the input that are already cracked in the DB."""
    if not body.hashes:
        return []
    normalised = [h.strip().lower() for h in body.hashes if h.strip()]
    rows = db.exec(select(CrackedHash)).all()
    matched = []
    seen = set()
    for row in rows:
        key = row.hash.strip().lower()
        if key in normalised and key not in seen:
            seen.add(key)
            matched.append({"hash": row.hash, "plaintext": row.plaintext,
                            "job_id": row.job_id, "cracked_at": str(row.cracked_at)})
    return matched


# ---------------------------------------------------------------------------
# Hash identification
# ---------------------------------------------------------------------------

class HashIdentifyRequest(BaseModel):
    hashes: List[str]


def _norm_hash_name(s: str) -> str:
    return s.lower().replace('-', '').replace(' ', '').replace('_', '')


@app.post("/api/identify-hash")
async def identify_hash(body: HashIdentifyRequest):
    """Identify hash type using name-that-hash (local)."""
    cleaned = [h.strip() for h in body.hashes if h.strip()]
    if not cleaned:
        return []
    sample = cleaned[0]

    def _nth():
        from name_that_hash import runner as nth_runner
        results = nth_runner.api_return_hashes_as_dict([sample], args={"popular_only": False})
        out = []
        for hash_results in results.values():
            for h in hash_results:
                if h.get('hashcat') is not None and not h.get('extended'):
                    out.append({"id": h['hashcat'], "name": h['name']})
        return out

    try:
        return await asyncio.get_event_loop().run_in_executor(None, _nth)
    except Exception:
        return []


@app.post("/api/identify-hcom")
async def identify_hcom(body: HashIdentifyRequest):
    """Cross-check a hash against hashes.com identifier and return merged results."""
    cleaned = [h.strip() for h in body.hashes if h.strip()]
    if not cleaned:
        return {"hcom_names": [], "matches": []}
    sample = cleaned[0]

    def _hcom():
        import urllib.request, urllib.parse, json as _json
        url = f"https://hashes.com/en/api/identifier?hash={urllib.parse.quote(sample)}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = _json.loads(resp.read())
        if data.get('success'):
            return data.get('algorithms', [])
        return []

    try:
        hcom_names = await asyncio.get_event_loop().run_in_executor(None, _hcom)
    except Exception:
        hcom_names = []

    hcom_norm = {_norm_hash_name(h) for h in hcom_names}

    # Use nth to resolve hcom names → hashcat mode IDs (nth names match hcom names better
    # than the raw hashcat cache, e.g. nth:"SHA-256" matches hcom:"SHA-256" → mode 1400,
    # whereas the hashcat cache has "SHA2-256" which doesn't normalise the same way).
    def _nth_for_hcom():
        from name_that_hash import runner as nth_runner
        results = nth_runner.api_return_hashes_as_dict([sample], args={"popular_only": False})
        out = []
        for hash_results in results.values():
            for h in hash_results:
                if h.get('hashcat') is not None:
                    out.append({"id": h['hashcat'], "name": h['name']})
        return out

    try:
        nth_all = await asyncio.get_event_loop().run_in_executor(None, _nth_for_hcom)
    except Exception:
        nth_all = []

    hcom_suggestions = []
    seen_ids: set = set()
    for h in nth_all:
        if _norm_hash_name(h['name']) in hcom_norm and h['id'] not in seen_ids:
            hcom_suggestions.append({"id": h['id'], "name": h['name']})
            seen_ids.add(h['id'])

    return {
        "hcom_names": hcom_names,
        "hcom_suggestions": hcom_suggestions,
    }


# ---------------------------------------------------------------------------
# Job templates
# ---------------------------------------------------------------------------

class TemplateCreate(BaseModel):
    name: str
    hash_type: int
    attack_mode: int
    wordlist: Optional[str] = None
    wordlist2: Optional[str] = None
    rules: Optional[str] = None
    mask: Optional[str] = None
    extra_args: Optional[str] = None
    strip_wordlist: bool = False


@app.get("/api/templates")
async def list_templates(db: Session = Depends(get_session)):
    return db.exec(select(JobTemplate).order_by(JobTemplate.created_at.desc())).all()


@app.post("/api/templates", status_code=201)
async def create_template(body: TemplateCreate, db: Session = Depends(get_session)):
    tmpl = JobTemplate(**body.model_dump())
    db.add(tmpl)
    db.commit()
    db.refresh(tmpl)
    return tmpl


@app.delete("/api/templates/{tmpl_id}")
async def delete_template(tmpl_id: int, db: Session = Depends(get_session)):
    tmpl = db.get(JobTemplate, tmpl_id)
    if not tmpl:
        raise HTTPException(404, "Template not found")
    db.delete(tmpl)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.get("/api/settings")
async def get_settings(db: Session = Depends(get_session)):
    rows = db.exec(select(AppSettings)).all()
    return {r.key: r.value for r in rows}


@app.post("/api/settings")
async def save_settings(body: dict, db: Session = Depends(get_session)):
    for key, value in body.items():
        existing = db.exec(select(AppSettings).where(AppSettings.key == key)).first()
        if existing:
            existing.value = str(value)
        else:
            db.add(AppSettings(key=key, value=str(value)))
        if key == "max_concurrent":
            try:
                queue.max_concurrent = int(value)
            except ValueError:
                pass
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@app.get("/api/stats")
async def get_stats(db: Session = Depends(get_session)):
    all_jobs = db.exec(select(Job)).all()
    total_cracked = db.exec(select(CrackedHash)).all()
    return {
        "total_jobs": len(all_jobs),
        "running": sum(1 for j in all_jobs if j.status == JobStatus.running),
        "pending": sum(1 for j in all_jobs if j.status == JobStatus.pending),
        "completed": sum(1 for j in all_jobs if j.status == JobStatus.completed),
        "failed": sum(1 for j in all_jobs if j.status == JobStatus.failed),
        "total_cracked": len(total_cracked),
        "queue_size": len(queue.get_queue_snapshot()),
    }


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # keep connection alive; client can send pings
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
