import asyncio
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Set, Dict, Any

LOGS_DIR = Path(__file__).parent.parent / "logs"
LOGS_DIR.mkdir(exist_ok=True)

_ERROR_KEYWORDS = ("exception", "error", "no hashes", "warning", "invalid", "failed", "not found", "token length")

def _extract_error(log_lines: list) -> str:
    relevant = [l for l in log_lines if any(kw in l.lower() for kw in _ERROR_KEYWORDS)]
    chosen = relevant[-8:] if relevant else log_lines[-8:]
    return "\n".join(chosen)[:1000]


class JobQueue:
    def __init__(self, runner):
        self.runner = runner
        self._queue: deque = deque()
        self._running: Set[int] = set()
        self._restore_set: Set[int] = set()   # job IDs that should resume via --restore
        self.max_concurrent: int = 1
        self._manager = None
        self._logs: Dict[int, list] = {}   # job_id -> live lines (running jobs only)
        self._started = False

    def start(self, manager):
        self._manager = manager
        if not self._started:
            self._started = True
            asyncio.create_task(self._worker())

    def enqueue(self, job_id: int, restore: bool = False):
        self._queue.append(job_id)
        if restore:
            self._restore_set.add(job_id)

    def cancel_queued(self, job_id: int):
        try:
            self._queue.remove(job_id)
        except ValueError:
            pass
        self._restore_set.discard(job_id)

    async def pause(self, job_id: int):
        """Mark job as paused then kill the process; _run_job will see paused status and skip overwrite."""
        from .db import engine
        from .models import Job, JobStatus
        from sqlmodel import Session
        with Session(engine) as db:
            job = db.get(Job, job_id)
            if job and job.status == JobStatus.running:
                job.status = JobStatus.paused
                db.commit()
        await self.runner.kill(job_id)

    async def kill(self, job_id: int):
        self.cancel_queued(job_id)
        await self.runner.kill(job_id)

    def get_queue_snapshot(self) -> list:
        return list(self._queue)

    def get_running(self) -> Set[int]:
        return set(self._running)

    def get_logs(self, job_id: int) -> list:
        # Live job: return in-memory buffer
        if job_id in self._running:
            return self._logs.get(job_id, [])
        # Completed/failed job: read persisted log file
        log_file = LOGS_DIR / f"{job_id}.txt"
        if log_file.exists():
            return log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        return self._logs.get(job_id, [])

    async def _worker(self):
        while True:
            if self._queue and len(self._running) < self.max_concurrent:
                job_id = self._queue.popleft()
                self._running.add(job_id)
                asyncio.create_task(self._run_job(job_id))
            await asyncio.sleep(0.5)

    async def _run_job(self, job_id: int):
        from .db import engine
        from .models import Job, JobStatus, CrackedHash
        from sqlmodel import Session

        try:
            with Session(engine) as db:
                job = db.get(Job, job_id)
                if not job:
                    return
                job.status = JobStatus.running
                job.started_at = datetime.utcnow()
                db.commit()

            self._logs[job_id] = []
            log_file = LOGS_DIR / f"{job_id}.txt"
            log_file.write_text("", encoding="utf-8")  # truncate/create
            await self._broadcast({"type": "job_update", "job_id": job_id, "status": "running"})

            async def on_update(data: Dict[str, Any]):
                if data["type"] == "log":
                    line = data["line"]
                    self._logs.setdefault(job_id, []).append(line)
                    if len(self._logs[job_id]) > 500:
                        self._logs[job_id] = self._logs[job_id][-500:]
                    with log_file.open("a", encoding="utf-8") as fh:
                        fh.write(line + "\n")

                with Session(engine) as db:
                    job = db.get(Job, job_id)
                    if not job:
                        return
                    if data["type"] == "status":
                        if "progress" in data:
                            job.progress = data["progress"]
                        if "speed" in data:
                            job.speed = data["speed"]
                        if "recovered" in data:
                            job.recovered = data["recovered"]
                        if "total_hashes" in data:
                            job.total_hashes = data["total_hashes"]
                        if "eta" in data:
                            job.eta = data["eta"]
                        if "temperature" in data:
                            job.temperature = data["temperature"]
                        db.commit()

                await self._broadcast({"type": "job_update", "job_id": job_id, **data})

            _reported: set = set()

            async def on_crack(crack: Dict[str, str]):
                key = (job_id, crack["hash"])
                if key in _reported:
                    return
                _reported.add(key)
                with Session(engine) as db:
                    entry = CrackedHash(
                        job_id=job_id,
                        hash=crack["hash"],
                        plaintext=crack["plaintext"],
                    )
                    db.add(entry)
                    db.commit()
                await self._broadcast({"type": "crack", "job_id": job_id, **crack})

            use_restore = job_id in self._restore_set
            self._restore_set.discard(job_id)
            if use_restore:
                returncode = await self.runner.restore_job(job_id, on_update, on_crack)
            else:
                returncode = await self.runner.run_job(job_id, on_update, on_crack)

            # Hashcat exit codes:
            #   0 = at least one hash cracked
            #   1 = exhausted (ran to completion, nothing found) — still a success
            #   2 = aborted by user (pause/cancel)
            #   255 = error (bad args, missing file, etc.)
            success = returncode in (0, 1)

            with Session(engine) as db:
                job = db.get(Job, job_id)
                # Don't overwrite if pause() already set the status to paused
                if job and job.status == JobStatus.running:
                    job.status = JobStatus.completed if success else JobStatus.failed
                    job.finished_at = datetime.utcnow()
                    if not success:
                        job.error_msg = _extract_error(self._logs.get(job_id, []))
                    db.commit()
                final_status = job.status.value if job else ("completed" if success else "failed")

            await self._broadcast({"type": "job_done", "job_id": job_id, "status": final_status})

        except Exception as e:
            try:
                with Session(engine) as db:
                    job = db.get(Job, job_id)
                    if job and job.status == JobStatus.running:
                        job.status = JobStatus.failed
                        job.finished_at = datetime.utcnow()
                        db.commit()
            except Exception:
                pass
            await self._broadcast({"type": "job_done", "job_id": job_id, "status": "failed"})

        finally:
            self._running.discard(job_id)
            self._logs.pop(job_id, None)  # disk is authoritative now

    async def _broadcast(self, data: Dict[str, Any]):
        if self._manager:
            await self._manager.broadcast(data)
