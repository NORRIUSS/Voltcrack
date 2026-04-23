"""
HashcatUI launcher — run this to start the web server.
Usage:  python start.py
Then open http://localhost:8000 in your browser.
"""
import sys
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent

def check_deps():
    try:
        import fastapi, uvicorn, sqlmodel
    except ImportError:
        print("[*] Installing dependencies...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")])
        print("[+] Dependencies installed.\n")

def main():
    check_deps()
    import uvicorn
    print("=" * 50)
    print("  HashcatUI")
    print("  http://localhost:8000")
    print("=" * 50)
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info",
        app_dir=str(ROOT),
    )

if __name__ == "__main__":
    main()
