from sqlalchemy import text
from sqlmodel import create_engine, Session, SQLModel
from pathlib import Path

ROOT = Path(__file__).parent.parent
DB_PATH = ROOT / "hashcatui.db"
engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)

# Each entry: (table, column, sqlite_type, default)
_MIGRATIONS = [
    ("job", "strip_wordlist", "INTEGER", "0"),
    ("job", "devices",        "TEXT",    "NULL"),
]


def init_db():
    SQLModel.metadata.create_all(engine)
    _run_migrations()


def _run_migrations():
    """Add any missing columns to existing tables (forward-only migrations)."""
    with engine.connect() as conn:
        for table, column, col_type, default in _MIGRATIONS:
            rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
            existing = {r[1] for r in rows}
            if column not in existing:
                if default.upper() == "NULL":
                    ddl = f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"
                else:
                    ddl = f"ALTER TABLE {table} ADD COLUMN {column} {col_type} NOT NULL DEFAULT {default}"
                conn.execute(text(ddl))
        conn.commit()


def get_session():
    with Session(engine) as session:
        yield session
