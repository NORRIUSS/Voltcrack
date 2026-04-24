import asyncio
import re
from pathlib import Path
from typing import Callable, Dict, Optional, Any

ROOT = Path(__file__).parent.parent
HASHCAT_BIN = ROOT / "hashcat" / "hashcat.exe"
SESSIONS_DIR = ROOT / "sessions"
POTFILE_PATH = ROOT / "hashcat.potfile"
UPLOADS_HASHES = ROOT / "uploads" / "hashes"
UPLOADS_WORDLISTS = ROOT / "uploads" / "wordlists"
HASHCAT_RULES = ROOT / "hashcat" / "rules"
HASHCAT_MASKS = ROOT / "hashcat" / "masks"

_SPEED_RE = re.compile(r"Speed\.#\d+\.*:\s+(.+?)(?:\s+\(|$)", re.MULTILINE)
_PROGRESS_RE = re.compile(r"Progress\.*:\s+(\d+)/(\d+)\s+\(([0-9.]+)%\)")
_RECOVERED_RE = re.compile(r"Recovered\.*:\s+(\d+)/(\d+)")
_ETA_RE = re.compile(r"Time\.Estimated\.*:\s+(.+?)(?:\s*$)", re.MULTILINE)
_TEMP_RE = re.compile(r"Hardware\.Mon\.#(\d+)\.*:.*?Temp:\s*(\d+)c.*?Util:\s*(\d+)%", re.IGNORECASE)
_STATUS_RE = re.compile(r"Status\.*:\s+(\w+)")
_DEVICE_ID_RE = re.compile(r"Backend Device ID #(\d+)")
_DEVICE_NAME_RE = re.compile(r"Name[.\s]+:\s*(.+)")
_DEVICE_TYPE_RE = re.compile(r"Type[.\s]+:\s*(.+)")
_DEVICE_VENDOR_RE = re.compile(r"Vendor[.\s]+:\s*(.+)")
_DEVICE_MEM_RE = re.compile(r"Memory\.Total[.\s]+:\s*(.+)")


class HashcatRunner:
    def __init__(self):
        self._processes: Dict[int, asyncio.subprocess.Process] = {}

    def build_command(self, job) -> list:
        cmd = [str(HASHCAT_BIN)]
        cmd += ["-m", str(job.hash_type)]
        cmd += ["-a", str(job.attack_mode)]
        cmd += ["--session", job.session_name]
        cmd += ["--status", "--status-timer=2"]
        cmd += [f"--potfile-path={POTFILE_PATH}"]

        hash_path = UPLOADS_HASHES / job.hash_file
        cmd.append(str(hash_path))

        mode = job.attack_mode
        if mode == 0:  # dictionary
            if job.wordlist:
                cmd.append(str(UPLOADS_WORDLISTS / job.wordlist))
            if job.rules:
                for rule in job.rules.split(","):
                    rule = rule.strip()
                    if rule:
                        cmd += ["-r", str(HASHCAT_RULES / rule)]
        elif mode == 1:  # combinator
            if job.wordlist:
                cmd.append(str(UPLOADS_WORDLISTS / job.wordlist))
            if job.wordlist2:
                cmd.append(str(UPLOADS_WORDLISTS / job.wordlist2))
        elif mode == 3:  # brute-force / mask
            if job.mask:
                # could be a built-in .hcmask file or a literal mask pattern
                mask_file = HASHCAT_MASKS / job.mask
                cmd.append(str(mask_file) if mask_file.exists() else job.mask)
        elif mode == 6:  # hybrid wordlist + mask
            if job.wordlist:
                cmd.append(str(UPLOADS_WORDLISTS / job.wordlist))
            if job.mask:
                cmd.append(job.mask)
        elif mode == 7:  # hybrid mask + wordlist
            if job.mask:
                cmd.append(job.mask)
            if job.wordlist:
                cmd.append(str(UPLOADS_WORDLISTS / job.wordlist))

        if job.devices:
            cmd += ["-d", job.devices]

        if job.extra_args:
            cmd += job.extra_args.split()

        return cmd

    async def run_job(self, job_id: int, on_update: Callable, on_crack: Callable) -> int:
        from .db import engine
        from .models import Job
        from sqlmodel import Session

        with Session(engine) as db:
            job = db.get(Job, job_id)
            if not job:
                return 1

        cmd = self.build_command(job)
        hash_path = UPLOADS_HASHES / job.hash_file

        await on_update({"type": "log", "line": f"[CMD] {' '.join(str(a) for a in cmd)}"})

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(ROOT / "hashcat"),
            )
        except Exception as e:
            await on_update({"type": "log", "line": f"[ERROR] Failed to start hashcat: {e}"})
            return 1

        self._processes[job_id] = proc

        try:
            async for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").rstrip()
                await on_update({"type": "log", "line": line})
                parsed = self._parse_line(line)
                if parsed:
                    await on_update({"type": "status", **parsed})
        except Exception:
            pass

        await proc.wait()
        self._processes.pop(job_id, None)

        # Use --show to get all cracked hashes for this hash file from the potfile.
        # This works whether the hash was cracked in this run or a previous one.
        cracked = await self._show_cracked(job.hash_type, hash_path)
        for h, p in cracked:
            await on_crack({"hash": h, "plaintext": p})

        return proc.returncode if proc.returncode is not None else 0

    async def restore_job(self, job_id: int, on_update: Callable, on_crack: Callable) -> int:
        from .db import engine
        from .models import Job
        from sqlmodel import Session

        with Session(engine) as db:
            job = db.get(Job, job_id)
            if not job:
                return 1
            session_name = job.session_name

        session_file = SESSIONS_DIR / f"{session_name}.restore"
        if not session_file.exists():
            return await self.run_job(job_id, on_update, on_crack)

        cmd = [str(HASHCAT_BIN), "--session", session_name, "--restore",
               f"--potfile-path={POTFILE_PATH}"]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(ROOT / "hashcat"),
            )
        except Exception as e:
            await on_update({"type": "log", "line": f"[ERROR] {e}"})
            return 1

        self._processes[job_id] = proc

        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            await on_update({"type": "log", "line": line})
            parsed = self._parse_line(line)
            if parsed:
                await on_update({"type": "status", **parsed})

        await proc.wait()
        self._processes.pop(job_id, None)

        with Session(engine) as db:
            job = db.get(Job, job_id)
        if job:
            cracked = await self._show_cracked(job.hash_type, UPLOADS_HASHES / job.hash_file)
            for h, p in cracked:
                await on_crack({"hash": h, "plaintext": p})

        return proc.returncode or 0

    async def kill(self, job_id: int):
        proc = self._processes.get(job_id)
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass

    async def run_benchmark(self, modes: list) -> asyncio.subprocess.Process:
        """Start a benchmark subprocess. Returns the process; caller streams stdout."""
        cmd = [str(HASHCAT_BIN), "-b"]
        for m in modes:
            cmd += ["-m", str(m)]
        return await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(ROOT / "hashcat"),
        )

    async def get_devices(self) -> list:
        try:
            proc = await asyncio.create_subprocess_exec(
                str(HASHCAT_BIN), "-I",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(ROOT / "hashcat"),
            )
            stdout, _ = await proc.communicate()
            return self._parse_devices(stdout.decode("utf-8", errors="replace"))
        except Exception:
            return []

    def _parse_devices(self, output: str) -> list:
        devices = []
        current: Optional[Dict] = None
        for line in output.splitlines():
            m = _DEVICE_ID_RE.search(line)
            if m:
                if current:
                    devices.append(current)
                current = {"id": int(m.group(1)), "name": "", "type": "", "vendor": "", "memory": ""}
                continue
            if current is None:
                continue
            if not current["name"]:
                m = _DEVICE_NAME_RE.search(line)
                if m:
                    current["name"] = m.group(1).strip()
                    continue
            if not current["type"]:
                m = _DEVICE_TYPE_RE.search(line)
                if m:
                    current["type"] = m.group(1).strip()
                    continue
            if not current["vendor"]:
                m = _DEVICE_VENDOR_RE.search(line)
                if m:
                    current["vendor"] = m.group(1).strip()
                    continue
            if not current["memory"]:
                m = _DEVICE_MEM_RE.search(line)
                if m:
                    current["memory"] = m.group(1).strip()
                    continue
        if current:
            devices.append(current)
        return devices

    async def get_hash_types(self) -> list:
        try:
            proc = await asyncio.create_subprocess_exec(
                str(HASHCAT_BIN), "-hh",           # -hh shows all hash modes; --help does not
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(ROOT / "hashcat"),          # must run from hashcat dir for OpenCL
            )
            stdout, _ = await proc.communicate()
            return self._parse_hash_types(stdout.decode("utf-8", errors="replace"))
        except Exception:
            return []

    def _parse_hash_types(self, help_text: str) -> list:
        results = []
        in_section = False
        row_re = re.compile(r"^\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$")
        for line in help_text.splitlines():
            if "Hash Modes" in line or "Hash modes" in line:  # section header
                in_section = True
                continue
            if in_section and "- [" in line:                  # next section starts
                break
            if in_section:
                m = row_re.match(line)
                if m:
                    results.append({
                        "id": int(m.group(1)),
                        "name": m.group(2).strip(),
                        "category": m.group(3).strip(),
                    })
        return results

    def _parse_line(self, line: str) -> Optional[Dict[str, Any]]:
        m = _PROGRESS_RE.search(line)
        if m:
            return {"progress": float(m.group(3)), "done": int(m.group(1)), "total": int(m.group(2))}

        m = _SPEED_RE.search(line)
        if m:
            return {"speed": m.group(1).strip()}

        m = _RECOVERED_RE.search(line)
        if m:
            return {"recovered": int(m.group(1)), "total_hashes": int(m.group(2))}

        m = _ETA_RE.search(line)
        if m:
            return {"eta": m.group(1).strip()}

        m = _TEMP_RE.search(line)
        if m:
            return {"temperature": f"{m.group(2)}°C", "utilization": f"{m.group(3)}%", "device_id": int(m.group(1))}

        m = _STATUS_RE.search(line)
        if m:
            return {"hashcat_status": m.group(1)}

        return None

    async def _show_cracked(self, hash_type: int, hash_path) -> list:
        """Return [(hash, plaintext), ...] for all cracked entries in the potfile for hash_path."""
        import uuid as _uuid
        outfile = ROOT / f"_show_{_uuid.uuid4().hex[:8]}.tmp"
        cmd = [
            str(HASHCAT_BIN),
            "-m", str(hash_type),
            str(hash_path),
            f"--potfile-path={POTFILE_PATH}",
            f"--outfile={outfile}",
            "--show",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=str(ROOT / "hashcat"),
            )
            await proc.communicate()
            if not outfile.exists():
                return []
            results = []
            for line in outfile.read_text(errors="replace").splitlines():
                line = line.strip()
                if ":" in line:
                    h, _, p = line.partition(":")
                    if h:
                        results.append((h, p))
            return results
        except Exception:
            return []
        finally:
            try:
                if outfile.exists():
                    outfile.unlink()
            except Exception:
                pass
