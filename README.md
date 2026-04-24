
<div align="center">

```
⚡ Voltcrack
```

**A web UI for hashcat that doesn't make you want to cry**

[![Status](https://img.shields.io/badge/status-testing%20phase-orange?style=flat-square)](https://github.com/aliilaali1/hashcatui)
[![Built with](https://img.shields.io/badge/built%20with-FastAPI%20%2B%20Vanilla%20JS-blue?style=flat-square)](https://github.com/aliilaali1/hashcatui)
[![Platform](https://img.shields.io/badge/platform-Windows%20only-lightgrey?style=flat-square&logo=windows)](https://github.com/aliilaali1/hashcatui)
[![Vibes](https://img.shields.io/badge/vibes-immaculate-purple?style=flat-square)](https://github.com/aliilaali1/hashcatui)

</div>

---

Look, running hashcat from the terminal is fine. Totally fine. Nobody said anything about it not being fine. But what if — hear me out — what if you could do it from a dark-mode web UI with live progress bars, GPU temperature readout, and a benchmark page? Yeah. That's what we're doing here.

Voltcrack wraps hashcat in a slick browser interface so you can queue jobs, monitor them in real time, and not have to remember a single flag ever again.

> ⚠️ **heads up** — this project is still in the **testing phase**. things work, but things also occasionally explode. you've been warned. use it, break it, tell me what broke.

---

## what it does

```
📋  job queue        →  create, queue, pause, resume, cancel jobs
🔍  hash detection   →  auto-identifies hash types (+ hashes.com cross-check)
📡  live monitoring  →  real-time speed, progress, GPU temp via WebSocket
🖥️  device selector  →  pick which GPU/CPU devices hashcat should use
📁  file manager     →  upload wordlists and hash files through the browser
📜  history          →  full job history, clone to re-run with a different hash type
💾  log persistence  →  every job's output saved to disk, readable anytime
⚡  benchmark        →  live streaming benchmark across common hash modes
🔁  clone jobs       →  re-run any historical job with tweaked settings
```

---

## getting started

> 🪟 **Windows only.** the bundled hashcat binary is `hashcat.exe` and the whole thing is built and tested on Windows. linux/mac support is not planned right now. if you're on linux you probably already live in the terminal anyway.

clone it, run it, that's literally it:

```bash
git clone https://github.com/aliilaali1/hashcatui
cd hashcatui
python start.py
```

then open **http://localhost:8000** in your browser.

`start.py` handles dependency installation on first run. hashcat is bundled — no separate install needed. GPU kernels get compiled automatically on first launch (so the first run takes a moment, don't panic).

**requirements:** Windows 10/11, Python 3.10+, a GPU or CPU that hashcat supports, and a vague sense of optimism.

---

## attack modes

| mode | name | what it does |
|------|------|-------------|
| 0 | Dictionary | wordlist + optional rules |
| 1 | Combinator | two wordlists mashed together |
| 3 | Brute-Force | mask / charset patterns |
| 6 | Hybrid WL+M | wordlist with a mask suffix |
| 7 | Hybrid M+WL | mask prefix + wordlist |

---

## stack

- **backend** — FastAPI, SQLite (via SQLModel), asyncio subprocess for hashcat
- **frontend** — plain HTML/CSS/JS (no framework, no build step, no nonsense)
- **realtime** — WebSocket for live job updates, cracks, and hardware stats
- **benchmark** — Server-Sent Events (SSE) for live streaming benchmark results
- **hash id** — `name-that-hash` locally + optional hashes.com cross-check

---

## current state of affairs

it works! mostly! here's the honest breakdown:

- ✅ job creation, queue, history, results — solid
- ✅ real-time monitoring with per-device GPU stats — works great
- ✅ hash identification — pretty good, occasionally wrong (hash identification is hard, don't @ me)
- ✅ pause/resume — works, may lose a few seconds of progress on pause
- ✅ benchmark page — live streaming, cached between visits
- ✅ clone jobs — re-run any job from history with a different hash type
- ✅ log persistence — full stdout saved per job, viewable in history
- 🧪 edge cases — still being discovered daily
- 🧪 multi-GPU setups — works in theory, tested on potato hardware

if something breaks, open an issue. if something works really well, also open an issue (positive feedback is underrated).

---

## disclaimer

this tool is for **authorized testing only** — CTFs, your own systems, or environments you have explicit permission to test. don't be that person.

---

<div align="center">

made with too much coffee and a genuine hatred of terminal scrollback

⚡

</div>
