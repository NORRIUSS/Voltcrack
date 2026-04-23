from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class JobStatus(str, Enum):
    pending = "pending"
    running = "running"
    paused = "paused"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class Job(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    hash_type: int
    attack_mode: int
    hash_file: str
    wordlist: Optional[str] = None
    wordlist2: Optional[str] = None
    rules: Optional[str] = None      # comma-separated rule filenames
    mask: Optional[str] = None
    extra_args: Optional[str] = None
    devices: Optional[str] = None   # comma-separated device IDs, e.g. "1,2"; None = all
    strip_wordlist: bool = False
    status: JobStatus = Field(default=JobStatus.pending)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    session_name: str = ""
    progress: float = 0.0
    speed: str = ""
    recovered: int = 0
    total_hashes: int = 0
    eta: str = ""
    temperature: str = ""
    error_msg: Optional[str] = None


class CrackedHash(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    job_id: int = Field(foreign_key="job.id")
    hash: str
    plaintext: str
    cracked_at: datetime = Field(default_factory=datetime.utcnow)


class JobTemplate(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    hash_type: int
    attack_mode: int
    wordlist: Optional[str] = None
    wordlist2: Optional[str] = None
    rules: Optional[str] = None
    mask: Optional[str] = None
    extra_args: Optional[str] = None
    strip_wordlist: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


class AppSettings(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    key: str = Field(unique=True)
    value: str
