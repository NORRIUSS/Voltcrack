/* =========================================================================
   Voltcrack — Single-Page Application
   ========================================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  hashTypes: [],
  jobs: [],
  stats: { total_jobs: 0, running: 0, pending: 0, completed: 0, failed: 0, total_cracked: 0, queue_size: 0 },
  liveJobLogs: {},
  hardwareLatest: {},
  deviceStats: {},   // device_id -> { temperature, utilization }
  devices: null,     // cached device list from /api/devices
  currentJobIdForLog: null,
  activeTab: { results: 'cracked', files: 'hashes' },
  clonePrefill: null,
};

// ── API helper ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${txt}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setWsStatus(true);
    clearTimeout(wsReconnectTimer);
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleWsMessage(msg);
  };

  ws.onclose = ws.onerror = () => {
    setWsStatus(false);
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };
}

function setWsStatus(online) {
  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  if (dot) dot.className = `w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-green-500' : 'bg-red-500'}`;
  if (label) label.textContent = online ? 'Connected' : 'Disconnected';
}

function handleWsMessage(msg) {
  if (msg.type === 'log') {
    const jid = msg.job_id;
    if (!state.liveJobLogs[jid]) state.liveJobLogs[jid] = [];
    state.liveJobLogs[jid].push(msg.line);
    if (state.liveJobLogs[jid].length > 500) state.liveJobLogs[jid].shift();
    if (currentPage() === 'monitor' && state.currentJobIdForLog === jid) {
      appendLogLine(msg.line);
    }
  }

  if (msg.type === 'status' || msg.type === 'job_update') {
    updateJobInState(msg);
    refreshTopbar();
    if (currentPage() === 'jobs/queue') renderPage('jobs/queue');
  }

  if (msg.type === 'job_done') {
    updateJobInState(msg);
    refreshTopbar();
    refreshStats();
    if (msg.status === 'completed' && currentPage() === 'jobs/queue') {
      navigate('results');
    } else if (currentPage() === 'jobs/queue' || currentPage() === 'jobs/history') {
      renderPage(currentPage());
    }
  }

  if (msg.type === 'crack') {
    state.stats.total_cracked = (state.stats.total_cracked || 0) + 1;
    refreshTopbar();
    const el = document.getElementById('stat-cracked-val');
    if (el) el.textContent = state.stats.total_cracked;
    if (currentPage() === 'results' && state.activeTab.results === 'cracked') {
      const c = document.getElementById('results-tab-content');
      if (c) renderCracked(c);
    }
  }

  if (msg.temperature || msg.utilization) {
    state.hardwareLatest = { ...state.hardwareLatest, ...msg };
    if (msg.device_id != null) {
      state.deviceStats[msg.device_id] = {
        temperature: msg.temperature,
        utilization: msg.utilization,
      };
    }
    if (currentPage() === 'monitor') renderHardwareCards();
  }
}

function updateJobInState(msg) {
  const job = state.jobs.find(j => j.id === msg.job_id);
  if (!job) return;
  if (msg.status) job.status = msg.status;
  if (msg.progress !== undefined) job.progress = msg.progress;
  if (msg.speed !== undefined) job.speed = msg.speed;
  if (msg.recovered !== undefined) job.recovered = msg.recovered;
  if (msg.eta !== undefined) job.eta = msg.eta;
  if (msg.temperature !== undefined) job.temperature = msg.temperature;
}

// ── Render guard ──────────────────────────────────────────────────────────
let _renderSeq = 0;
function startRender()        { _renderSeq++; }
function captureRender()      { return _renderSeq; }
function renderStale(seq)     { return seq !== _renderSeq; }

// ── Router ─────────────────────────────────────────────────────────────────
const PAGE_TITLES = {
  'jobs/new':    'New Job',
  'jobs/queue':  'Queue',
  'jobs/history':'History',
  'results':     'Results',
  'files':       'Files',
  'monitor':     'Monitor',
  'settings':    'Settings',
};

function currentPage() {
  const hash = location.hash.replace('#/', '').trim();
  const known = Object.keys(PAGE_TITLES);
  return known.includes(hash) ? hash : 'jobs/new';
}

function navigate(page) {
  location.hash = `#/${page}`;
}

window.addEventListener('hashchange', () => {
  renderPage(currentPage());
  updateNavActive(currentPage());
});

function updateNavActive(page) {
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
}

async function renderPage(page) {
  startRender();
  const title = document.getElementById('page-title');
  const content = document.getElementById('content');
  if (title) title.textContent = PAGE_TITLES[page] || page;

  switch (page) {
    case 'jobs/new': { const pf = state.clonePrefill; state.clonePrefill = null; await renderNewJob(content, pf); break; }
    case 'jobs/queue':   await renderQueue(content); break;
    case 'jobs/history': await renderHistory(content); break;
    case 'results':      await renderResults(content); break;
    case 'files':        await renderFiles(content); break;
    case 'monitor':      await renderMonitor(content); break;
    case 'settings':     await renderSettings(content); break;
    default: content.innerHTML = `<p class="text-gray-500">Unknown page: ${page}</p>`;
  }
}

// ── Topbar / stats refresh ──────────────────────────────────────────────────
function refreshTopbar() {
  const running = state.jobs.filter(j => j.status === 'running');
  const pill = document.getElementById('active-pill');
  const pillText = document.getElementById('active-pill-text');
  const pillSpeed = document.getElementById('active-pill-speed');
  if (running.length > 0) {
    pill && pill.classList.remove('hidden');
    const j = running[0];
    if (pillText) pillText.textContent = j.name || 'Job running';
    if (pillSpeed) pillSpeed.textContent = j.speed ? `@ ${j.speed}` : '';
  } else {
    pill && pill.classList.add('hidden');
  }

  const queueBadge = document.getElementById('badge-queue');
  const qSize = state.jobs.filter(j => j.status === 'pending').length + running.length;
  if (queueBadge) {
    queueBadge.textContent = qSize;
    queueBadge.classList.toggle('hidden', qSize === 0);
  }
}

async function refreshStats() {
  try {
    state.stats = await api('/api/stats');
    const el = document.getElementById('stat-cracked-val');
    if (el) el.textContent = state.stats.total_cracked;
    const jel = document.getElementById('stat-jobs-val');
    if (jel) jel.textContent = state.stats.total_jobs;
  } catch {}
}

// ── Common UI helpers ───────────────────────────────────────────────────────
function card(html) {
  return `<div class="card">${html}</div>`;
}

function badge(status, recovered = 0) {
  let label = status;
  let cls;
  if (status === 'completed') {
    if (recovered > 0) {
      label = 'cracked';
      cls = 'bg-green-500/20 text-green-400 border-green-500/30';
    } else {
      label = 'exhausted';
      cls = 'bg-gray-500/20 text-gray-400 border-gray-600/40';
    }
  } else {
    const map = {
      pending:   'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      running:   'bg-blue-500/20 text-blue-400 border-blue-500/30',
      failed:    'bg-red-500/20 text-red-400 border-red-500/30',
      cancelled: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
      paused:    'bg-purple-500/20 text-purple-400 border-purple-500/30 animate-pulse',
    };
    cls = map[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${cls}">${label}</span>`;
}

function progressBar(pct, color = 'orange') {
  const colors = { orange: 'bg-orange-500', blue: 'bg-blue-500', green: 'bg-green-500' };
  const bg = colors[color] || 'bg-orange-500';
  return `
    <div class="w-full bg-gray-800 rounded-full h-1.5">
      <div class="${bg} h-1.5 rounded-full transition-all duration-500" style="width:${Math.min(100, pct || 0)}%"></div>
    </div>`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function fmtDuration(start, end) {
  if (!start) return '—';
  const ms = new Date(end || Date.now()) - new Date(start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function emptyState(icon, msg) {
  return `<div class="flex flex-col items-center justify-center py-20 text-gray-600">
    <i class="fa-solid ${icon} text-4xl mb-3"></i>
    <p class="text-sm">${msg}</p>
  </div>`;
}

// ── Custom searchable hash type dropdown ────────────────────────────────────
function setupHashTypeDropdown(hashTypes) {
  const trigger  = document.getElementById('ht-trigger');
  const panel    = document.getElementById('ht-panel');
  const search   = document.getElementById('ht-search');
  const list     = document.getElementById('ht-list');
  const hidden   = document.getElementById('jf-hash-type');
  const display  = document.getElementById('ht-display');

  function renderList(q) {
    const query = (q || '').toLowerCase();
    // Group by category, filter by query
    const groups = {};
    hashTypes.forEach(h => {
      const label = `${h.id} — ${h.name}`;
      if (query && !label.toLowerCase().includes(query) && !h.category.toLowerCase().includes(query)) return;
      if (!groups[h.category]) groups[h.category] = [];
      groups[h.category].push(h);
    });

    if (!Object.keys(groups).length) {
      list.innerHTML = `<p class="px-3 py-2 text-xs text-gray-500">No results for "${escHtml(q)}"</p>`;
      return;
    }

    list.innerHTML = Object.entries(groups).map(([cat, items]) => `
      <div class="px-3 pt-2 pb-0.5 text-xs font-semibold text-gray-600 uppercase tracking-wider">${escHtml(cat)}</div>
      ${items.map(h => `
        <div class="ht-item px-3 py-1.5 text-sm cursor-pointer hover:bg-orange-500/15 hover:text-orange-300 ${hidden.value == h.id ? 'bg-orange-500/20 text-orange-400' : 'text-gray-300'}"
             tabindex="-1" data-id="${h.id}" data-label="${escHtml(h.id + ' — ' + h.name)}">
          <span class="text-gray-500 font-mono text-xs mr-2">${h.id}</span>${escHtml(h.name)}
        </div>`).join('')}
    `).join('');

    list.querySelectorAll('.ht-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent blur before click
        selectItem(item.dataset.id, item.dataset.label);
      });
    });
  }

  function selectItem(id, label) {
    hidden.value = id;
    display.textContent = label;
    display.classList.remove('text-gray-500');
    display.classList.add('text-gray-200');
    closePanel();
  }

  function openPanel() {
    panel.classList.remove('hidden');
    search.value = '';
    renderList('');
    search.focus();
    // Scroll selected item into view
    setTimeout(() => {
      const active = list.querySelector('.bg-orange-500\\/20');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }, 30);
  }

  function closePanel() {
    panel.classList.add('hidden');
  }

  trigger.addEventListener('click', () => {
    panel.classList.contains('hidden') ? openPanel() : closePanel();
  });

  search.addEventListener('input', () => renderList(search.value));

  // Close on outside click
  document.addEventListener('mousedown', function handler(e) {
    if (!document.getElementById('ht-wrapper')?.contains(e.target)) {
      closePanel();
    }
  });

  // Keyboard nav
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closePanel(); trigger.focus(); }
    if (e.key === 'Enter') {
      const first = list.querySelector('.ht-item');
      if (first) selectItem(first.dataset.id, first.dataset.label);
    }
    if (e.key === 'ArrowDown') {
      const first = list.querySelector('.ht-item');
      if (first) first.focus();
      e.preventDefault();
    }
  });

  list.addEventListener('keydown', e => {
    const items = [...list.querySelectorAll('.ht-item')];
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && idx < items.length - 1) { items[idx+1].focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp')  { idx > 0 ? items[idx-1].focus() : search.focus(); e.preventDefault(); }
    if (e.key === 'Enter' && idx >= 0) selectItem(items[idx].dataset.id, items[idx].dataset.label);
    if (e.key === 'Escape') { closePanel(); trigger.focus(); }
  });

  list.querySelectorAll && renderList('');
}

// ── Page: New Job ───────────────────────────────────────────────────────────
async function renderNewJob(el, prefill = null) {
  if (!state.hashTypes.length) {
    try { state.hashTypes = await api('/api/hash-types'); } catch {}
  }
  let hashes = [], wordlists = [], rules = [], masks = [], templates = [];
  try { [hashes, wordlists, rules, masks, templates] = await Promise.all([
    api('/api/files/hashes'), api('/api/files/wordlists'),
    api('/api/files/rules'),  api('/api/files/masks'),
    api('/api/templates'),
  ]); } catch {}

  const hashFileOpts = `<option value="">— select file —</option>` +
    hashes.map(f => `<option value="${f}">${escHtml(f)}</option>`).join('');
  const wordlistOpts = `<option value="">— none —</option>` +
    wordlists.map(f => `<option value="${f}">${escHtml(f)}</option>`).join('');
  const wordlistOpts2 = `<option value="">— none —</option>` +
    wordlists.map(f => `<option value="${f}">${escHtml(f)}</option>`).join('');
  const rulesOpts = rules.map(f =>
    `<label class="flex items-center gap-2 text-sm py-0.5 cursor-pointer hover:text-gray-200">
      <input type="checkbox" name="rules" value="${escHtml(f)}" class="accent-orange-500"> ${escHtml(f)}
    </label>`
  ).join('') || '<span class="text-gray-500 text-sm">No rule files found</span>';
  const maskOpts = `<option value="">— custom —</option>` +
    masks.map(f => `<option value="${f}">${escHtml(f)}</option>`).join('');

  const templatesBar = templates.length ? `
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-xs text-gray-500 flex-shrink-0">Load template:</span>
      ${templates.map(t => `
        <div class="flex items-center gap-0.5">
          <button data-load-tmpl='${JSON.stringify(t)}' class="text-xs px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:bg-orange-500/15 hover:border-orange-500/40 hover:text-orange-300 transition-all">
            ${escHtml(t.name)}
          </button>
          <button data-del-tmpl="${t.id}" class="text-xs w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all" title="Delete template">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>`).join('')}
    </div>` : '';

  el.innerHTML = `
  <div class="max-w-2xl mx-auto space-y-4">
    ${templatesBar ? `<div class="card py-2.5 px-3">${templatesBar}</div>` : ''}

    ${card(`
      <h2 class="card-title">Job Details</h2>
      <div class="space-y-3">
        <div>
          <label class="field-label">Job Name</label>
          <input id="jf-name" type="text" class="field-input" value="New Job" placeholder="Descriptive name" />
        </div>

        <div class="relative" id="ht-wrapper">
          <label class="field-label">Hash Type</label>
          <input id="jf-hash-type" type="hidden" value="" />
          <button type="button" id="ht-trigger" class="field-input text-left flex items-center justify-between w-full">
            <span id="ht-display" class="text-gray-500 truncate">Select hash type…</span>
            <i class="fa-solid fa-chevron-down text-gray-600 text-xs flex-shrink-0 ml-2"></i>
          </button>
          <div id="ht-panel" class="hidden absolute z-50 left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
            <div class="p-2 border-b border-gray-800">
              <input id="ht-search" type="text" class="field-input text-sm"
                placeholder="Search: md5, ntlm, sha256, wpa, bcrypt…" autocomplete="off" />
            </div>
            <div id="ht-list" class="overflow-y-auto max-h-56 py-1"></div>
          </div>
        </div>

        <div>
          <label class="field-label">Hashes</label>
          <div class="flex gap-1 mb-2" id="hash-input-tabs">
            <button class="tab-btn active" data-tab="paste">
              <i class="fa-solid fa-keyboard mr-1"></i>Paste hashes
            </button>
            <button class="tab-btn" data-tab="file">
              <i class="fa-solid fa-file mr-1"></i>Use file
            </button>
          </div>
          <div id="hash-tab-paste">
            <textarea id="jf-hash-text" class="field-input font-mono text-xs"
              rows="5" placeholder="One hash per line, e.g.:&#10;5f4dcc3b5aa765d61d8327deb882cf99&#10;e10adc3949ba59abbe56e057f20f883e"></textarea>
            <div id="identify-panel" class="hidden mt-2"></div>
            <div id="dup-panel" class="hidden mt-2"></div>
          </div>
          <div id="hash-tab-file" class="hidden">
            <select id="jf-hash-file" class="field-input">${hashFileOpts}</select>
            <p class="text-xs text-gray-600 mt-1">Upload files via <a href="#/files" class="text-orange-400 hover:underline">Files</a>.</p>
          </div>
        </div>
      </div>
    `)}

    ${card(`
      <h2 class="card-title">Attack Mode</h2>
      <div class="grid grid-cols-3 gap-2 mb-4" id="attack-mode-grid">
        ${[
          [0, 'Dictionary',  'fa-book-open',   'Wordlist + optional rules'],
          [1, 'Combinator',  'fa-object-group','Two wordlists combined'],
          [3, 'Brute-Force', 'fa-dumbbell',    'Mask / charset'],
          [6, 'Hybrid WL+M', 'fa-layer-group', 'Wordlist + mask suffix'],
          [7, 'Hybrid M+WL', 'fa-layer-group', 'Mask prefix + wordlist'],
        ].map(([id, label, icon, desc]) => `
          <button class="mode-btn ${id===0?'active':''}" data-mode="${id}" title="${desc}">
            <i class="fa-solid ${icon} mb-1 text-lg"></i>
            <span class="text-xs font-medium">${label}</span>
          </button>
        `).join('')}
      </div>
      <input id="jf-attack-mode" type="hidden" value="0" />

      <div id="mode-fields-0" class="mode-fields space-y-3">
        <div>
          <label class="field-label">Wordlist</label>
          <select id="jf-wordlist-0" class="field-input">${wordlistOpts}</select>
        </div>
        <div>
          <label class="field-label">Rules <span class="text-gray-500">(optional)</span></label>
          <div class="bg-gray-800 rounded-lg p-3 max-h-36 overflow-y-auto space-y-0.5">
            ${rulesOpts}
          </div>
        </div>
        <label class="strip-whitespace-opt flex items-start gap-2 cursor-pointer text-sm text-gray-400 hover:text-gray-200 bg-gray-800/50 rounded-lg px-3 py-2">
          <input type="checkbox" id="jf-strip-wordlist" class="accent-orange-500 mt-0.5 flex-shrink-0" checked>
          <span>
            <span class="font-medium text-gray-300">Strip whitespace from each candidate</span>
            <span class="block text-xs text-gray-500 mt-0.5">
              Removes leading/trailing spaces from every wordlist entry before hashing.
              Useful when rockyou.txt contains entries like <code>&nbsp;password&nbsp;</code> instead of <code>password</code>.
            </span>
          </span>
        </label>
      </div>

      <div id="mode-fields-1" class="mode-fields hidden space-y-3">
        <div>
          <label class="field-label">Wordlist 1</label>
          <select id="jf-wordlist-1a" class="field-input">${wordlistOpts}</select>
        </div>
        <div>
          <label class="field-label">Wordlist 2</label>
          <select id="jf-wordlist-1b" class="field-input">${wordlistOpts2}</select>
        </div>
      </div>

      <div id="mode-fields-3" class="mode-fields hidden space-y-3">
        <div>
          <label class="field-label">Mask file or pattern</label>
          <select id="jf-mask-file" class="field-input mb-2">${maskOpts}</select>
          <input id="jf-mask-custom" type="text" class="field-input" placeholder="e.g. ?u?l?l?l?d?d?d?d" />
          <p class="text-xs text-gray-500 mt-1">?l=lower  ?u=upper  ?d=digit  ?s=special  ?a=any</p>
        </div>
      </div>

      <div id="mode-fields-6" class="mode-fields hidden space-y-3">
        <div><label class="field-label">Wordlist</label>
          <select id="jf-wordlist-6" class="field-input">${wordlistOpts}</select></div>
        <div><label class="field-label">Mask suffix</label>
          <input id="jf-mask-6" type="text" class="field-input" placeholder="e.g. ?d?d?d?d" /></div>
      </div>

      <div id="mode-fields-7" class="mode-fields hidden space-y-3">
        <div><label class="field-label">Mask prefix</label>
          <input id="jf-mask-7" type="text" class="field-input" placeholder="e.g. ?d?d" /></div>
        <div><label class="field-label">Wordlist</label>
          <select id="jf-wordlist-7" class="field-input">${wordlistOpts}</select></div>
      </div>

      <details class="mt-4 border-t border-gray-800 pt-3">
        <summary class="cursor-pointer text-xs text-gray-500 hover:text-gray-400 select-none">
          Extra hashcat arguments
        </summary>
        <div class="mt-2">
          <input id="jf-extra" type="text" class="field-input font-mono text-sm" placeholder="e.g. --increment --increment-min=4" />
        </div>
      </details>
    `)}

    <div id="devices-card-wrap"></div>

    <div class="flex gap-3">
      <button id="btn-submit-job" class="btn-primary flex-1">
        <i class="fa-solid fa-play mr-2"></i>Start Job
      </button>
      <button id="btn-save-tmpl" class="btn-secondary px-4" title="Save current config as template">
        <i class="fa-solid fa-bookmark mr-1.5"></i>Save Template
      </button>
      <button id="btn-reset-job" class="btn-secondary px-4" title="Reset form">
        <i class="fa-solid fa-rotate-left"></i>
      </button>
    </div>

    <div id="job-feedback" class="hidden"></div>
  </div>`;

  // Custom hash type dropdown
  setupHashTypeDropdown(state.hashTypes);

  // Device selector card (async, non-blocking)
  (async () => {
    if (!state.devices) {
      try { state.devices = await api('/api/devices'); } catch { state.devices = []; }
    }
    const wrap = document.getElementById('devices-card-wrap');
    if (!wrap || !state.devices?.length) return;
    // Only show if more than one device (single device = nothing to choose)
    if (state.devices.length < 2) return;
    function deviceTypeIcon(type) {
      if (!type) return '<i class="fa-solid fa-microchip text-gray-500"></i>';
      const t = type.toUpperCase();
      if (t.includes('GPU')) return '<i class="fa-solid fa-display text-green-400"></i>';
      if (t.includes('CPU')) return '<i class="fa-solid fa-microchip text-blue-400"></i>';
      return '<i class="fa-solid fa-microchip text-gray-400"></i>';
    }
    wrap.innerHTML = card(`
      <h2 class="card-title">Devices</h2>
      <p class="text-xs text-gray-500 mb-3">Select which devices hashcat should use. Leave all checked to use all available.</p>
      <div class="space-y-2" id="device-checkboxes">
        ${state.devices.map(d => `
          <label class="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-800/40 transition-colors">
            <input type="checkbox" name="job-device" value="${d.id}" checked
              class="accent-orange-500 w-4 h-4 flex-shrink-0">
            <span class="text-sm">${deviceTypeIcon(d.type)}</span>
            <div class="min-w-0">
              <span class="text-sm text-gray-200 truncate block">${escHtml(d.name || 'Device ' + d.id)}</span>
              <span class="text-xs text-gray-500">${escHtml(d.type || '')}${d.memory ? ' · ' + escHtml(d.memory) : ''}</span>
            </div>
            <span class="ml-auto text-xs font-mono text-gray-600">#${d.id}</span>
          </label>`).join('')}
      </div>
    `);
  })();

  // Apply prefill from template
  if (prefill) applyPrefill(prefill);

  // Hash input tabs (Paste / File)
  document.getElementById('hash-input-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('hash-tab-paste').classList.toggle('hidden', tab !== 'paste');
    document.getElementById('hash-tab-file').classList.toggle('hidden', tab !== 'file');
  });

  // Attack mode buttons
  document.getElementById('attack-mode-grid').addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('jf-attack-mode').value = mode;
    document.querySelectorAll('.mode-fields').forEach(f => f.classList.add('hidden'));
    const mf = document.getElementById(`mode-fields-${mode}`);
    if (mf) mf.classList.remove('hidden');
  });

  // Duplicate check — debounced on hash textarea
  let _dupTimer = null;
  document.getElementById('jf-hash-text').addEventListener('input', () => {
    clearTimeout(_dupTimer);
    _dupTimer = setTimeout(() => { identifyHashes(); checkDuplicates(); }, 600);
  });

  // Template load / delete
  el.querySelectorAll('[data-load-tmpl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tmpl = JSON.parse(btn.dataset.loadTmpl);
      renderNewJob(el, tmpl);
    });
  });
  el.querySelectorAll('[data-del-tmpl]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delTmpl;
      if (!confirm('Delete this template?')) return;
      try { await api(`/api/templates/${id}`, { method: 'DELETE' }); renderNewJob(el); }
      catch(e) { alert(e.message); }
    });
  });

  // Save template
  document.getElementById('btn-save-tmpl').addEventListener('click', async () => {
    const name = prompt('Template name:');
    if (!name || !name.trim()) return;
    const mode = parseInt(document.getElementById('jf-attack-mode').value);
    const hashType = document.getElementById('jf-hash-type').value;
    if (!hashType) { alert('Select a hash type first.'); return; }
    const body = {
      name: name.trim(),
      hash_type: parseInt(hashType),
      attack_mode: mode,
      strip_wordlist: document.getElementById('jf-strip-wordlist')?.checked ?? true,
      extra_args: document.getElementById('jf-extra').value.trim() || null,
    };
    if (mode === 0) {
      body.wordlist = document.getElementById('jf-wordlist-0').value || null;
      const checked = Array.from(document.querySelectorAll('input[name="rules"]:checked')).map(c => c.value);
      body.rules = checked.length ? checked.join(',') : null;
    } else if (mode === 1) {
      body.wordlist  = document.getElementById('jf-wordlist-1a').value || null;
      body.wordlist2 = document.getElementById('jf-wordlist-1b').value || null;
    } else if (mode === 3) {
      const file = document.getElementById('jf-mask-file').value;
      body.mask = file || document.getElementById('jf-mask-custom').value.trim() || null;
    } else if (mode === 6) {
      body.wordlist = document.getElementById('jf-wordlist-6').value || null;
      body.mask = document.getElementById('jf-mask-6').value.trim() || null;
    } else if (mode === 7) {
      body.mask = document.getElementById('jf-mask-7').value.trim() || null;
      body.wordlist = document.getElementById('jf-wordlist-7').value || null;
    }
    try {
      await api('/api/templates', { method: 'POST', body: JSON.stringify(body) });
      renderNewJob(el);
    } catch(e) { alert(e.message); }
  });

  // Submit
  document.getElementById('btn-submit-job').addEventListener('click', submitJob);
  document.getElementById('btn-reset-job').addEventListener('click', () => renderNewJob(el));
}

function applyPrefill(tmpl) {
  // Name
  const nameEl = document.getElementById('jf-name');
  if (nameEl && tmpl.name) nameEl.value = tmpl.name;
  // Attack mode
  const modeBtn = document.querySelector(`.mode-btn[data-mode="${tmpl.attack_mode}"]`);
  if (modeBtn) {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    modeBtn.classList.add('active');
    document.getElementById('jf-attack-mode').value = tmpl.attack_mode;
    document.querySelectorAll('.mode-fields').forEach(f => f.classList.add('hidden'));
    const mf = document.getElementById(`mode-fields-${tmpl.attack_mode}`);
    if (mf) mf.classList.remove('hidden');
  }
  // Hash type
  if (tmpl.hash_type != null) {
    const ht = state.hashTypes.find(h => h.id === tmpl.hash_type);
    if (ht) {
      document.getElementById('jf-hash-type').value = ht.id;
      const display = document.getElementById('ht-display');
      if (display) {
        display.textContent = `${ht.id} — ${ht.name}`;
        display.classList.remove('text-gray-500');
        display.classList.add('text-gray-200');
      }
    }
  }
  // Hash input
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  if (tmpl.hash_file) {
    const isPasted = tmpl.hash_file.startsWith('pasted_');
    if (isPasted) {
      // Fetch content and put it in the textarea (stay on paste tab)
      fetch(`/api/files/hashes/${encodeURIComponent(tmpl.hash_file)}/content`)
        .then(r => r.ok ? r.text() : null)
        .then(text => {
          if (text) {
            const ta = document.getElementById('jf-hash-text');
            if (ta) { ta.value = text; ta.dispatchEvent(new Event('input')); }
          }
        }).catch(() => {});
    } else {
      // Switch to "Use file" tab and select the file
      const fileTab = document.querySelector('.tab-btn[data-tab="file"]');
      if (fileTab) fileTab.click();
      setVal('jf-hash-file', tmpl.hash_file);
    }
  }
  // Wordlists
  setVal('jf-wordlist-0', tmpl.wordlist);
  setVal('jf-wordlist-1a', tmpl.wordlist);
  setVal('jf-wordlist-1b', tmpl.wordlist2);
  setVal('jf-wordlist-6', tmpl.wordlist);
  setVal('jf-wordlist-7', tmpl.wordlist);
  // Mask
  if (tmpl.mask) {
    const maskFile = document.getElementById('jf-mask-file');
    const maskCustom = document.getElementById('jf-mask-custom');
    if (maskFile && [...maskFile.options].some(o => o.value === tmpl.mask)) {
      maskFile.value = tmpl.mask;
    } else if (maskCustom) {
      maskCustom.value = tmpl.mask;
    }
    setVal('jf-mask-6', tmpl.mask);
    setVal('jf-mask-7', tmpl.mask);
  }
  // Rules
  if (tmpl.rules) {
    const active = new Set(tmpl.rules.split(',').map(r => r.trim()));
    document.querySelectorAll('input[name="rules"]').forEach(cb => {
      cb.checked = active.has(cb.value);
    });
  }
  // Strip wordlist
  const strip = document.getElementById('jf-strip-wordlist');
  if (strip) strip.checked = tmpl.strip_wordlist ?? true;
  // Extra args
  setVal('jf-extra', tmpl.extra_args);
  // Devices
  if (tmpl.devices) {
    const selected = new Set(tmpl.devices.split(',').map(s => s.trim()));
    document.querySelectorAll('input[name="job-device"]').forEach(cb => {
      cb.checked = selected.has(cb.value);
    });
  }
}

async function checkDuplicates() {
  const panel = document.getElementById('dup-panel');
  if (!panel) return;
  const raw = document.getElementById('jf-hash-text')?.value || '';
  const hashes = raw.split('\n').map(h => h.trim()).filter(Boolean);
  if (!hashes.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  let matches = [];
  try { matches = await api('/api/check-hashes', { method: 'POST', body: JSON.stringify({ hashes }) }); }
  catch { return; }

  if (!matches.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2">
      <p class="text-xs font-medium text-yellow-400 mb-1.5">
        <i class="fa-solid fa-triangle-exclamation mr-1"></i>
        ${matches.length} of ${hashes.length} hash${hashes.length !== 1 ? 'es' : ''} already cracked
      </p>
      <div class="space-y-0.5">
        ${matches.map(m => `
          <div class="flex items-center gap-2 text-xs font-mono">
            <span class="text-gray-500 truncate">${escHtml(m.hash)}</span>
            <i class="fa-solid fa-arrow-right text-gray-700 flex-shrink-0"></i>
            <span class="text-green-400 font-bold flex-shrink-0">${escHtml(m.plaintext)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

async function submitJob() {
  const fb = document.getElementById('job-feedback');
  fb.className = '';
  fb.innerHTML = '';

  const mode = parseInt(document.getElementById('jf-attack-mode').value);
  const hashTypeEl = document.getElementById('jf-hash-type');
  const hashType = hashTypeEl.value ? parseInt(hashTypeEl.value) : null;

  if (hashType === null) {
    showFeedback(fb, 'error', 'Please select a hash type.');
    return;
  }

  // Determine hash source from active tab
  const pasteTabActive = !document.getElementById('hash-tab-paste').classList.contains('hidden');
  const hashText = pasteTabActive ? document.getElementById('jf-hash-text').value.trim() : '';
  const hashFile = !pasteTabActive ? (document.getElementById('jf-hash-file').value || '') : '';

  if (!hashText && !hashFile) {
    showFeedback(fb, 'error', 'Enter at least one hash or select a hash file.');
    return;
  }

  // Collect selected devices (null = all devices, i.e. no -d flag)
  const allDeviceBoxes = Array.from(document.querySelectorAll('input[name="job-device"]'));
  const checkedDevices = allDeviceBoxes.filter(c => c.checked).map(c => c.value);
  const devicesVal = allDeviceBoxes.length > 0 && checkedDevices.length < allDeviceBoxes.length
    ? checkedDevices.join(',') : null;

  const body = {
    name: document.getElementById('jf-name').value.trim() || 'Unnamed Job',
    hash_type: hashType,
    attack_mode: mode,
    hash_text: hashText || null,
    hash_file: hashFile || null,
    extra_args: document.getElementById('jf-extra').value.trim() || null,
    devices: devicesVal,
  };

  const stripEl = document.getElementById('jf-strip-wordlist');
  if (stripEl) body.strip_wordlist = stripEl.checked;

  if (mode === 0) {
    body.wordlist = document.getElementById('jf-wordlist-0').value || null;
    const checked = Array.from(document.querySelectorAll('input[name="rules"]:checked')).map(c => c.value);
    body.rules = checked.length ? checked.join(',') : null;
  } else if (mode === 1) {
    body.wordlist = document.getElementById('jf-wordlist-1a').value || null;
    body.wordlist2 = document.getElementById('jf-wordlist-1b').value || null;
  } else if (mode === 3) {
    const file = document.getElementById('jf-mask-file').value;
    const custom = document.getElementById('jf-mask-custom').value.trim();
    body.mask = file || custom || null;
  } else if (mode === 6) {
    body.wordlist = document.getElementById('jf-wordlist-6').value || null;
    body.mask = document.getElementById('jf-mask-6').value.trim() || null;
  } else if (mode === 7) {
    body.mask = document.getElementById('jf-mask-7').value.trim() || null;
    body.wordlist = document.getElementById('jf-wordlist-7').value || null;
  }

  const btn = document.getElementById('btn-submit-job');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Starting…';

  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    state.jobs.unshift(job);
    refreshStats();
    refreshTopbar();
    setTimeout(() => navigate('jobs/queue'), 400);
  } catch (err) {
    showFeedback(fb, 'error', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-play mr-2"></i>Start Job';
  }
}

function showFeedback(el, type, msg) {
  el.classList.remove('hidden');
  const map = {
    success: 'bg-green-500/10 border border-green-500/30 text-green-400',
    error:   'bg-red-500/10 border border-red-500/30 text-red-400',
    info:    'bg-blue-500/10 border border-blue-500/30 text-blue-400',
  };
  el.className = `rounded-lg px-4 py-3 text-sm ${map[type] || map.info}`;
  el.textContent = msg;
}

// ── Page: Queue ─────────────────────────────────────────────────────────────
async function renderQueue(el) {
  const seq = captureRender();
  try { state.jobs = await api('/api/jobs'); } catch {}
  if (renderStale(seq)) return;
  const active = state.jobs.filter(j => ['running', 'pending', 'paused'].includes(j.status));

  if (!active.length) {
    el.innerHTML = emptyState('fa-list-check', 'No active or pending jobs');
    return;
  }

  el.innerHTML = `<div class="space-y-3 max-w-3xl">` +
    active.map(j => jobCard(j, true)).join('') +
    `</div>`;

  // Attach cancel buttons
  el.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.cancel);
      if (!confirm('Cancel this job?')) return;
      try {
        await api(`/api/jobs/${id}`, { method: 'DELETE' });
        state.jobs = state.jobs.filter(j => j.id !== id);
        renderQueue(el);
      } catch(e) { alert(e.message); }
    });
  });

  // Pause buttons
  el.querySelectorAll('[data-pause]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.pause);
      try {
        await api(`/api/jobs/${id}/pause`, { method: 'POST' });
        const job = state.jobs.find(j => j.id === id);
        if (job) job.status = 'paused';
        renderQueue(el);
      } catch(e) { alert(e.message); }
    });
  });

  // Resume buttons
  el.querySelectorAll('[data-resume]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.resume);
      try {
        await api(`/api/jobs/${id}/resume`, { method: 'POST' });
        const job = state.jobs.find(j => j.id === id);
        if (job) job.status = 'pending';
        renderQueue(el);
      } catch(e) { alert(e.message); }
    });
  });

  // Log view buttons
  el.querySelectorAll('[data-view-log]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentJobIdForLog = parseInt(btn.dataset.viewLog);
      navigate('monitor');
    });
  });
}

function jobCard(job, showControls = false) {
  const pct = Math.round(job.progress || 0);
  const barColor = job.status === 'completed' ? 'green' : job.status === 'failed' ? 'red' : 'orange';

  return `
  <div class="card">
    <div class="flex items-start justify-between gap-3 mb-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-medium text-gray-200 truncate">#${job.id} ${escHtml(job.name)}</span>
          ${badge(job.status)}
          ${job.status === 'running' ? `<span class="text-xs text-blue-400 animate-pulse">LIVE</span>` : ''}
        </div>
        <div class="text-xs text-gray-500 mt-0.5">
          Mode ${job.attack_mode} · Type ${job.hash_type}
          ${job.hash_file ? ` · ${escHtml(job.hash_file)}` : ''}
        </div>
      </div>
      ${showControls ? `
        <div class="flex gap-2 flex-shrink-0">
          <button data-view-log="${job.id}" class="btn-icon" title="View log">
            <i class="fa-solid fa-terminal text-xs"></i>
          </button>
          ${job.status === 'running' ? `
          <button data-pause="${job.id}" class="btn-icon" title="Pause (saves checkpoint)">
            <i class="fa-solid fa-pause text-xs"></i>
          </button>` : ''}
          ${job.status === 'paused' ? `
          <button data-resume="${job.id}" class="btn-icon text-green-400 border-green-500/30 hover:bg-green-500/10" title="Resume from checkpoint">
            <i class="fa-solid fa-play text-xs"></i>
          </button>` : ''}
          <button data-cancel="${job.id}" class="btn-icon btn-icon-danger" title="Cancel">
            <i class="fa-solid fa-xmark text-xs"></i>
          </button>
        </div>` : ''}
    </div>

    ${progressBar(pct, barColor)}

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs text-gray-400">
      <div><span class="text-gray-600">Progress</span><br/><span class="text-gray-200 font-medium">${pct}%</span></div>
      <div><span class="text-gray-600">Speed</span><br/><span class="text-gray-200 font-medium">${job.speed || '—'}</span></div>
      <div><span class="text-gray-600">Recovered</span><br/><span class="text-gray-200 font-medium">${job.recovered || 0}</span></div>
      <div><span class="text-gray-600">ETA</span><br/><span class="text-gray-200 font-medium">${job.eta || '—'}</span></div>
    </div>
    ${job.temperature ? `<div class="mt-2 text-xs text-gray-500"><i class="fa-solid fa-thermometer-half mr-1 text-orange-400"></i>${job.temperature}</div>` : ''}
  </div>`;
}

// ── Page: History ───────────────────────────────────────────────────────────
async function renderHistory(el) {
  const seq = captureRender();
  try { state.jobs = await api('/api/jobs'); } catch {}
  if (renderStale(seq)) return;
  const done = state.jobs.filter(j => !['running', 'pending', 'paused'].includes(j.status));

  if (!done.length) {
    el.innerHTML = emptyState('fa-clock-rotate-left', 'No completed jobs yet');
    return;
  }

  el.innerHTML = `
  <div class="space-y-3 max-w-full">
    <div class="flex items-center justify-between">
      <p class="text-sm text-gray-500">${done.length} job${done.length !== 1 ? 's' : ''} in history</p>
      <button id="btn-clear-history" class="btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10">
        <i class="fa-solid fa-trash-can"></i>
        Clear All History
      </button>
    </div>
    <div class="overflow-x-auto rounded-xl border border-gray-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3">#</th>
            <th class="px-4 py-3">Name</th>
            <th class="px-4 py-3">Status</th>
            <th class="px-4 py-3">Type</th>
            <th class="px-4 py-3">Mode</th>
            <th class="px-4 py-3">Cracked</th>
            <th class="px-4 py-3">Duration</th>
            <th class="px-4 py-3">Created</th>
            <th class="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800/50">
          ${done.map(j => `
            <tr class="hover:bg-gray-800/40 transition-colors" id="history-row-${j.id}">
              <td class="px-4 py-3 text-gray-500">${j.id}</td>
              <td class="px-4 py-3 text-gray-200 font-medium max-w-xs truncate">${escHtml(j.name)}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1.5">
                  ${badge(j.status, j.recovered)}
                  ${j.status === 'failed' && j.error_msg ? `
                    <button data-err="${j.id}" title="${escHtml(j.error_msg)}"
                      class="text-red-400 hover:text-red-300 transition-colors">
                      <i class="fa-solid fa-circle-exclamation text-xs"></i>
                    </button>` : ''}
                </div>
              </td>
              <td class="px-4 py-3 text-gray-400 font-mono">${j.hash_type}</td>
              <td class="px-4 py-3 text-gray-400">${modeLabel(j.attack_mode)}</td>
              <td class="px-4 py-3">
                ${(j.recovered || 0) > 0
                  ? `<button data-expand="${j.id}" class="flex items-center gap-1.5 text-green-400 font-medium hover:text-green-300 transition-colors">
                       ${j.recovered} <i class="fa-solid fa-chevron-right text-xs transition-transform expand-chevron"></i>
                     </button>`
                  : `<span class="text-gray-600">0</span>`}
              </td>
              <td class="px-4 py-3 text-gray-400">${fmtDuration(j.started_at, j.finished_at)}</td>
              <td class="px-4 py-3 text-gray-500 text-xs">${fmtDate(j.created_at)}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <button data-clone-job="${j.id}" class="btn-icon" title="Clone job (re-run with different settings)">
                    <i class="fa-solid fa-clone text-xs"></i>
                  </button>
                  <button data-delete-job="${j.id}" class="btn-icon btn-icon-danger" title="Delete job">
                    <i class="fa-solid fa-trash text-xs"></i>
                  </button>
                </div>
              </td>
            </tr>
            <tr id="expand-row-${j.id}" class="hidden">
              <td colspan="9" class="px-4 pb-3 pt-0 bg-gray-900/30">
                <div id="expand-content-${j.id}" class="rounded-lg overflow-hidden border border-gray-800/60 text-xs font-mono">
                  <div class="text-gray-500 px-3 py-2"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Loading…</div>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  // Expand cracked hashes inline
  el.querySelectorAll('[data-expand]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.expand);
      const row = document.getElementById(`expand-row-${id}`);
      const content = document.getElementById(`expand-content-${id}`);
      const chevron = btn.querySelector('.expand-chevron');
      const isOpen = !row.classList.contains('hidden');

      if (isOpen) {
        row.classList.add('hidden');
        chevron && chevron.classList.remove('rotate-90');
        return;
      }

      row.classList.remove('hidden');
      chevron && chevron.classList.add('rotate-90');

      try {
        const rows = await api(`/api/results/${id}`);
        if (!rows.length) {
          content.innerHTML = `<div class="px-3 py-2 text-gray-500">No cracked hashes recorded.</div>`;
          return;
        }
        content.innerHTML = rows.map((r, i) => `
          <div class="flex items-center gap-3 px-3 py-1.5 ${i % 2 === 0 ? 'bg-gray-900/40' : ''}">
            <span class="text-gray-500 truncate flex-1">${escHtml(r.hash)}</span>
            <i class="fa-solid fa-arrow-right text-gray-700 flex-shrink-0"></i>
            <span class="text-green-400 font-bold flex-shrink-0">${escHtml(r.plaintext)}</span>
          </div>`).join('');
      } catch(e) {
        content.innerHTML = `<div class="px-3 py-2 text-red-400">${e.message}</div>`;
      }
    });
  });

  // Error detail toggle
  el.querySelectorAll('[data-err]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.err);
      const j = done.find(x => x.id === id);
      if (!j?.error_msg) return;
      const existing = document.getElementById(`err-panel-${id}`);
      if (existing) { existing.remove(); return; }
      const row = document.getElementById(`history-row-${id}`);
      const tr = document.createElement('tr');
      tr.id = `err-panel-${id}`;
      tr.innerHTML = `<td colspan="9" class="px-4 pb-3 pt-0">
        <div class="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
          <p class="text-xs font-semibold text-red-400 mb-1"><i class="fa-solid fa-circle-exclamation mr-1"></i>Error details</p>
          <pre class="text-xs text-red-300/80 whitespace-pre-wrap font-mono">${escHtml(j.error_msg)}</pre>
        </div>
      </td>`;
      row.insertAdjacentElement('afterend', tr);
    });
  });

  // Clone job → navigate to new job form pre-filled
  el.querySelectorAll('[data-clone-job]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.cloneJob);
      const j = done.find(x => x.id === id);
      if (!j) return;
      state.clonePrefill = {
        name:           j.name + ' (clone)',
        hash_type:      j.hash_type,
        attack_mode:    j.attack_mode,
        hash_file:      j.hash_file,
        wordlist:       j.wordlist,
        wordlist2:      j.wordlist2,
        rules:          j.rules,
        mask:           j.mask,
        extra_args:     j.extra_args,
        strip_wordlist: j.strip_wordlist,
      };
      window.location.hash = '#/jobs/new';
    });
  });

  // Per-row delete
  el.querySelectorAll('[data-delete-job]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.deleteJob);
      if (!confirm(`Delete job #${id} from history? This cannot be undone.`)) return;
      try {
        await api(`/api/history/${id}`, { method: 'DELETE' });
        state.jobs = state.jobs.filter(j => j.id !== id);
        const row = document.getElementById(`history-row-${id}`);
        if (row) {
          row.style.transition = 'opacity 0.2s';
          row.style.opacity = '0';
          setTimeout(() => renderHistory(el), 220);
        }
      } catch(e) { alert(e.message); }
    });
  });

  // Clear all
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (!confirm(`Delete all ${done.length} history job(s)? This cannot be undone.`)) return;
    try {
      await api('/api/history', { method: 'DELETE' });
      state.jobs = state.jobs.filter(j => ['running', 'pending', 'paused'].includes(j.status));
      renderHistory(el);
      refreshStats();
    } catch(e) { alert(e.message); }
  });
}

function modeLabel(m) {
  return { 0:'Dictionary', 1:'Combinator', 3:'Brute-Force', 6:'Hybrid WL+M', 7:'Hybrid M+WL' }[m] || `Mode ${m}`;
}

// ── Page: Cracked ───────────────────────────────────────────────────────────
async function renderCracked(el) {
  const seq = captureRender();
  el.innerHTML = `<div class="text-gray-500 text-sm py-6 text-center"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading…</div>`;
  let rows = [];
  try { rows = await api('/api/results'); } catch {}
  if (renderStale(seq)) return;

  if (!rows.length) {
    el.innerHTML = emptyState('fa-key', 'No cracked hashes yet');
    return;
  }

  // Build a job id→name map for the label column
  const jobMap = {};
  state.jobs.forEach(j => { jobMap[j.id] = j.name; });

  el.innerHTML = `
  <div class="max-w-4xl space-y-3">
    <div class="flex items-center justify-between">
      <p class="text-sm text-gray-500">${rows.length} cracked hash${rows.length !== 1 ? 'es' : ''}</p>
      <button id="cracked-refresh" class="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
        <i class="fa-solid fa-rotate-right"></i> Refresh
      </button>
    </div>
    <div class="overflow-x-auto rounded-xl border border-gray-800">
      <table class="w-full text-sm font-mono">
        <thead>
          <tr class="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3">Hash</th>
            <th class="px-4 py-3">Plaintext</th>
            <th class="px-4 py-3">Job</th>
            <th class="px-4 py-3">Time</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800/50">
          ${rows.map(r => `
            <tr class="hover:bg-gray-800/40">
              <td class="px-4 py-2 text-gray-400 max-w-xs truncate" title="${escHtml(r.hash)}">${escHtml(r.hash)}</td>
              <td class="px-4 py-2 text-green-400 font-bold">${escHtml(r.plaintext)}</td>
              <td class="px-4 py-2 text-gray-500 text-xs">${r.job_id ? `#${r.job_id}${jobMap[r.job_id] ? ' ' + escHtml(jobMap[r.job_id]) : ''}` : '—'}</td>
              <td class="px-4 py-2 text-gray-600 text-xs">${fmtDate(r.cracked_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  document.getElementById('cracked-refresh').addEventListener('click', () => renderCracked(el));
}

// ── Page: Potfile ───────────────────────────────────────────────────────────
async function renderPotfile(el) {
  el.innerHTML = `<div class="text-gray-500 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading potfile…</div>`;
  let entries = [];
  try { entries = await api('/api/potfile'); } catch {}

  const headerHtml = `
    <div class="flex items-center justify-end mb-3">
      <button id="btn-clear-potfile" class="btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10">
        <i class="fa-solid fa-trash-can"></i>
        Delete Potfile
      </button>
    </div>`;

  if (!entries.length) {
    el.innerHTML = headerHtml + emptyState('fa-database', 'Potfile is empty');
    document.getElementById('btn-clear-potfile').addEventListener('click', () => confirmClearPotfile(el));
    return;
  }

  el.innerHTML = headerHtml + `
  <div class="max-w-4xl space-y-3">
    <div class="flex items-center gap-3">
      <input id="potfile-search" class="field-input flex-1" placeholder="Filter hashes or plaintexts…" />
      <span class="text-sm text-gray-500">${entries.length} entries</span>
    </div>
    <div class="overflow-x-auto rounded-xl border border-gray-800">
      <table class="w-full text-sm font-mono" id="potfile-table">
        <thead>
          <tr class="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3">Hash</th><th class="px-4 py-3">Plaintext</th>
          </tr>
        </thead>
        <tbody id="potfile-body" class="divide-y divide-gray-800/50">
          ${entries.map(r => `
            <tr class="hover:bg-gray-800/40" data-hash="${escHtml(r.hash)}" data-plain="${escHtml(r.plaintext)}">
              <td class="px-4 py-2 text-gray-400 max-w-xs truncate">${escHtml(r.hash)}</td>
              <td class="px-4 py-2 text-green-400 font-bold">${escHtml(r.plaintext)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  document.getElementById('btn-clear-potfile').addEventListener('click', () => confirmClearPotfile(el));

  document.getElementById('potfile-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#potfile-body tr').forEach(row => {
      const match = row.dataset.hash.toLowerCase().includes(q) ||
                    row.dataset.plain.toLowerCase().includes(q);
      row.style.display = match ? '' : 'none';
    });
  });
}

function renderIdentifyPanel(panel, matches, hcomNorm = new Set(), hcomOnly = [], mismatch = false) {
  if (!matches.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  const hashes = (document.getElementById('jf-hash-text')?.value || '')
    .split('\n').map(h => h.trim()).filter(Boolean);

  const [best, ...rest] = matches;

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 space-y-1.5">

      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-blue-300">
          ${hcomNorm.size ? '<i class="fa-solid fa-circle-check text-green-400 mr-1"></i>' : '<i class="fa-solid fa-wand-magic-sparkles text-blue-400/70 mr-1"></i>'}
          Most likely: <span class="font-mono">${best.id}</span> ${escHtml(best.name)}
        </span>
        <button type="button"
          class="use-detected flex-shrink-0 text-xs px-2.5 py-0.5 rounded-full
                 bg-blue-500/20 border border-blue-500/40 text-blue-300
                 hover:bg-blue-500/30 hover:text-blue-200 transition-all font-medium"
          data-id="${best.id}" data-label="${escHtml(best.id + ' — ' + best.name)}">
          Use
        </button>
      </div>

      ${!hcomNorm.size ? `
        <button type="button" id="btn-hcom-check"
          class="w-full text-left text-xs px-2 py-1 rounded-md
                 bg-gray-800/60 border border-gray-700/60 text-gray-400
                 hover:bg-gray-700/60 hover:text-gray-200 hover:border-gray-600 transition-all">
          <i class="fa-solid fa-globe mr-1.5 text-gray-500"></i>Cross-check with hashes.com
        </button>` : ''}

      ${mismatch ? `
        <div class="rounded-md border border-yellow-500/30 bg-yellow-500/5 px-2.5 py-2 space-y-1">
          <p class="text-xs font-medium text-yellow-400">
            <i class="fa-solid fa-triangle-exclamation mr-1"></i>hashes.com disagrees with nth
          </p>
          ${hcomOnly.length ? `
            <p class="text-xs text-gray-500 mb-0.5">hashes.com suggests:</p>
            ${hcomOnly.map(m => `
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs text-yellow-300/80">
                  <span class="font-mono mr-1.5">${m.id}</span>${escHtml(m.name)}
                </span>
                <button type="button"
                  class="use-detected flex-shrink-0 text-xs px-2 py-0.5 rounded-full
                         bg-yellow-500/15 border border-yellow-500/30 text-yellow-400
                         hover:bg-yellow-500/25 hover:text-yellow-300 transition-all"
                  data-id="${m.id}" data-label="${escHtml(m.id + ' — ' + m.name)}">
                  Use
                </button>
              </div>`).join('')}` : '<p class="text-xs text-gray-500">No matching hashcat mode found for hashes.com suggestion.</p>'}
        </div>` : ''}

      ${rest.length ? `
        <div class="border-t border-blue-500/10 pt-1 space-y-1">
          <p class="text-xs text-gray-600">Also possible:</p>
          ${rest.map(m => `
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs text-gray-500">
                ${hcomNorm.has(m.id) ? '<i class="fa-solid fa-circle-check text-green-400 mr-1"></i>' : ''}
                <span class="font-mono mr-1.5">${m.id}</span>${escHtml(m.name)}
              </span>
              <button type="button"
                class="use-detected flex-shrink-0 text-xs px-2 py-0.5 rounded-full
                       bg-gray-800 border border-gray-700 text-gray-400
                       hover:bg-blue-500/15 hover:border-blue-500/30 hover:text-blue-400 transition-all"
                data-id="${m.id}" data-label="${escHtml(m.id + ' — ' + m.name)}">
                Use
              </button>
            </div>`).join('')}
        </div>` : ''}
    </div>`;

  // Wire Use buttons
  panel.querySelectorAll('.use-detected').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('jf-hash-type').value = btn.dataset.id;
      const display = document.getElementById('ht-display');
      if (display) {
        display.textContent = btn.dataset.label;
        display.classList.remove('text-gray-500');
        display.classList.add('text-gray-200');
      }
      panel.querySelectorAll('.use-detected').forEach(b => {
        b.textContent = b === btn ? '✓ Applied' : 'Use';
        b.classList.toggle('opacity-40', b !== btn);
      });
    });
  });

  // Wire hashes.com button
  const hcomBtn = document.getElementById('btn-hcom-check');
  if (hcomBtn) {
    hcomBtn.addEventListener('click', async () => {
      hcomBtn.disabled = true;
      hcomBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Checking…';
      try {
        const res = await api('/api/identify-hcom', { method: 'POST', body: JSON.stringify({ hashes }) });
        const hcomSuggestions = res.hcom_suggestions || [];
        const hcomIds = new Set(hcomSuggestions.map(s => s.id));
        const nthIds  = new Set(matches.map(m => m.id));
        const confirmed = matches.filter(m => hcomIds.has(m.id));
        const others    = matches.filter(m => !hcomIds.has(m.id));
        const hcomOnly  = hcomSuggestions.filter(s => !nthIds.has(s.id));
        const mismatch  = hcomSuggestions.length > 0 && confirmed.length === 0;
        renderIdentifyPanel(panel, [...confirmed, ...others], hcomIds, hcomOnly, mismatch);
      } catch {
        hcomBtn.disabled = false;
        hcomBtn.innerHTML = '<i class="fa-solid fa-globe mr-1"></i>hashes.com';
      }
    });
  }
}

async function identifyHashes() {
  const panel = document.getElementById('identify-panel');
  if (!panel) return;
  const hashes = (document.getElementById('jf-hash-text')?.value || '')
    .split('\n').map(h => h.trim()).filter(Boolean);
  if (!hashes.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="flex items-center gap-2 text-xs text-gray-500">
    <i class="fa-solid fa-spinner fa-spin text-orange-400"></i>Identifying…</div>`;

  let matches = [];
  try {
    matches = await api('/api/identify-hash', { method: 'POST', body: JSON.stringify({ hashes }) });
  } catch { panel.classList.add('hidden'); return; }

  renderIdentifyPanel(panel, matches);
}

async function confirmClearPotfile(el) {
  if (!confirm('Delete the entire potfile? Hashcat will no longer skip previously cracked hashes.')) return;
  try {
    await api('/api/potfile', { method: 'DELETE' });
    renderPotfile(el);
  } catch(e) { alert(e.message); }
}

// ── Page: Export ────────────────────────────────────────────────────────────
async function renderExport(el) {
  try { state.jobs = await api('/api/jobs'); } catch {}

  el.innerHTML = `
  <div class="max-w-md space-y-4">
    ${card(`
      <h2 class="card-title">Export Cracked Hashes</h2>
      <div class="space-y-3">
        <div>
          <label class="field-label">Job</label>
          <select id="exp-job" class="field-input">
            ${state.jobs.map(j => `<option value="${j.id}">#${j.id} — ${escHtml(j.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field-label">Format</label>
          <div class="flex gap-2">
            <label class="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm">
              <input type="radio" name="exp-fmt" value="txt" checked class="accent-orange-500"> TXT (hash:plain)
            </label>
            <label class="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm">
              <input type="radio" name="exp-fmt" value="csv" class="accent-orange-500"> CSV
            </label>
            <label class="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm">
              <input type="radio" name="exp-fmt" value="json" class="accent-orange-500"> JSON
            </label>
          </div>
        </div>
        <button id="btn-export" class="btn-primary w-full">
          <i class="fa-solid fa-download mr-2"></i>Download
        </button>
      </div>
    `)}
  </div>`;

  document.getElementById('btn-export').addEventListener('click', () => {
    const jobId = document.getElementById('exp-job').value;
    const fmt = document.querySelector('input[name="exp-fmt"]:checked').value;
    window.location.href = `/api/results/${jobId}/export?fmt=${fmt}`;
  });
}

// ── Page: File Manager (hashes / wordlists) ─────────────────────────────────
async function renderFileManager(el, type) {
  let files = [];
  try { files = await api(`/api/files/${type}`); } catch {}

  const label = type === 'hashes' ? 'Hash Files' : 'Wordlists';
  const icon  = type === 'hashes' ? 'fa-hashtag' : 'fa-book-open';

  el.innerHTML = `
  <div class="max-w-2xl space-y-4">
    ${card(`
      <h2 class="card-title"><i class="fa-solid ${icon} mr-2 text-orange-400"></i>${label}</h2>
      <div id="drop-zone" class="border-2 border-dashed border-gray-700 rounded-xl p-8 text-center text-gray-500 hover:border-orange-500/50 hover:text-gray-400 transition-colors cursor-pointer">
        <i class="fa-solid fa-cloud-arrow-up text-3xl mb-2 block"></i>
        <p class="text-sm">Drop files here or <span class="text-orange-400 underline cursor-pointer" id="browse-trigger">browse</span></p>
        <input id="file-input" type="file" class="hidden" multiple />
      </div>
      <div id="upload-progress" class="hidden mt-2"></div>
    `)}

    <div id="file-list">
      ${renderFileTable(files, type)}
    </div>
  </div>`;

  setupDropZone(type, el);
}

function renderFileTable(files, type) {
  if (!files.length) return emptyState('fa-folder-open', 'No files uploaded yet');
  return `
  <div class="overflow-x-auto rounded-xl border border-gray-800">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
          <th class="px-4 py-3">Filename</th>
          <th class="px-4 py-3 text-right">Actions</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-800/50">
        ${files.map(f => `
          <tr class="hover:bg-gray-800/40">
            <td class="px-4 py-3 font-mono text-gray-300">${escHtml(f)}</td>
            <td class="px-4 py-3 text-right">
              <button data-del="${escHtml(f)}" data-type="${type}" class="btn-icon btn-icon-danger" title="Delete">
                <i class="fa-solid fa-trash text-xs"></i>
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function setupDropZone(type, container) {
  const dz = container.querySelector('#drop-zone');
  const fi = container.querySelector('#file-input');
  const browse = container.querySelector('#browse-trigger');
  browse.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => uploadFiles(type, fi.files, container));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('border-orange-500'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('border-orange-500'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('border-orange-500');
    uploadFiles(type, e.dataTransfer.files, container);
  });

  container.addEventListener('click', async e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const name = btn.dataset.del;
    const t = btn.dataset.type;
    if (!confirm(`Delete "${name}"?`)) return;
    try {
      await api(`/api/files/${t}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      renderFileManager(container, t);
    } catch(err) { alert(err.message); }
  });
}

async function uploadFiles(type, fileList, container) {
  const prog = container.querySelector('#upload-progress');
  prog.classList.remove('hidden');
  prog.innerHTML = '';

  for (const file of fileList) {
    const row = document.createElement('div');
    row.className = 'text-xs text-gray-400 py-1';
    row.textContent = `Uploading ${file.name}…`;
    prog.appendChild(row);

    const fd = new FormData();
    fd.append('file', file);
    try {
      await fetch(`/api/files/${type}`, { method: 'POST', body: fd });
      row.className = 'text-xs text-green-400 py-1';
      row.textContent = `✓ ${file.name}`;
    } catch {
      row.className = 'text-xs text-red-400 py-1';
      row.textContent = `✗ ${file.name} — failed`;
    }
  }

  setTimeout(() => {
    prog.classList.add('hidden');
    renderFileManager(container, type);
  }, 1200);
}

// ── Page: File List (rules / masks) ─────────────────────────────────────────
async function renderFileList(el, type) {
  let files = [];
  try { files = await api(`/api/files/${type}`); } catch {}

  const label = type === 'rules' ? 'Rule Files' : 'Mask Files';
  const icon  = type === 'rules' ? 'fa-scroll' : 'fa-mask';

  el.innerHTML = `
  <div class="max-w-2xl space-y-3">
    ${card(`
      <h2 class="card-title"><i class="fa-solid ${icon} mr-2 text-orange-400"></i>${label}</h2>
      <p class="text-xs text-gray-500">Built-in files from the hashcat directory. Select these when creating a job.</p>
    `)}
    ${files.length ? `
    <div class="overflow-x-auto rounded-xl border border-gray-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3">Filename</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800/50">
          ${files.map(f => `
            <tr class="hover:bg-gray-800/40">
              <td class="px-4 py-3 font-mono text-gray-300">${escHtml(f)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : emptyState('fa-folder-open', `No ${type} files found`)}
  </div>`;
}


function renderHardwareCards() {
  const running = state.jobs.find(j => j.status === 'running');
  const temp = document.getElementById('hw-temp');
  const util = document.getElementById('hw-util');
  const speed = document.getElementById('hw-speed');
  if (temp) temp.textContent = state.hardwareLatest.temperature || '—';
  if (util) util.textContent = state.hardwareLatest.utilization || '—';
  if (speed && running) speed.textContent = running.speed || '—';
  // Update per-device cards
  for (const [id, stats] of Object.entries(state.deviceStats)) {
    const t = document.getElementById(`device-temp-${id}`);
    const u = document.getElementById(`device-util-${id}`);
    if (t) t.textContent = stats.temperature || '—';
    if (u) u.textContent = stats.utilization || '—';
  }
}

// ── Page: Live Log ──────────────────────────────────────────────────────────
async function renderLiveLog(el) {
  try { state.jobs = await api('/api/jobs'); } catch {}
  const activeJobs = state.jobs.filter(j => j.status === 'running' || j.status === 'pending');
  const defaultId = state.currentJobIdForLog || (activeJobs[0] && activeJobs[0].id) || (state.jobs[0] && state.jobs[0].id);

  el.innerHTML = `
  <div class="flex flex-col h-full max-w-4xl space-y-3">
    <div class="flex items-center gap-3">
      <select id="log-job-sel" class="field-input w-auto">
        ${state.jobs.map(j => `<option value="${j.id}" ${j.id==defaultId?'selected':''}>#${j.id} — ${escHtml(j.name)}</option>`).join('')}
      </select>
      <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
        <input type="checkbox" id="log-autoscroll" checked class="accent-orange-500"> Auto-scroll
      </label>
      <button id="log-clear" class="btn-secondary px-3 py-1.5 text-xs ml-auto">Clear</button>
    </div>
    <div id="log-terminal" class="log-terminal flex-1"></div>
  </div>`;

  async function loadLog(jobId) {
    state.currentJobIdForLog = parseInt(jobId);
    const term = document.getElementById('log-terminal');
    const cached = state.liveJobLogs[jobId];
    if (cached && cached.length) {
      term.innerHTML = cached.map(l => `<div class="log-line">${escHtml(l)}</div>`).join('');
    } else {
      try {
        const { lines } = await api(`/api/jobs/${jobId}/log`);
        state.liveJobLogs[jobId] = lines;
        term.innerHTML = lines.map(l => `<div class="log-line">${escHtml(l)}</div>`).join('');
      } catch {}
    }
    scrollLog();
  }

  function scrollLog() {
    const chk = document.getElementById('log-autoscroll');
    const term = document.getElementById('log-terminal');
    if (chk && chk.checked && term) term.scrollTop = term.scrollHeight;
  }

  if (defaultId) await loadLog(defaultId);

  document.getElementById('log-job-sel').addEventListener('change', e => loadLog(e.target.value));
  document.getElementById('log-clear').addEventListener('click', () => {
    const jobId = document.getElementById('log-job-sel').value;
    state.liveJobLogs[jobId] = [];
    document.getElementById('log-terminal').innerHTML = '';
  });
}

function appendLogLine(line) {
  const term = document.getElementById('log-terminal');
  if (!term) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = line;
  term.appendChild(div);
  const chk = document.getElementById('log-autoscroll');
  if (chk && chk.checked) term.scrollTop = term.scrollHeight;
  // Cap DOM nodes
  while (term.children.length > 600) term.removeChild(term.firstChild);
}


// ── Page: Results (tabbed) ──────────────────────────────────────────────────
async function renderResults(el, tab) {
  tab = tab || state.activeTab.results || 'cracked';
  const tabs = [
    { id: 'cracked', label: 'Cracked',  icon: 'fa-key' },
    { id: 'potfile', label: 'Potfile',  icon: 'fa-database' },
    { id: 'export',  label: 'Export',   icon: 'fa-file-export' },
  ];

  el.innerHTML = `
    <div class="flex gap-1 mb-5 border-b border-gray-800 pb-2">
      ${tabs.map(t => `
        <button class="tab-btn ${t.id === tab ? 'active' : ''}" data-tab="${t.id}">
          <i class="fa-solid ${t.icon} mr-1.5 text-xs"></i>${t.label}
        </button>`).join('')}
    </div>
    <div id="results-tab-content"></div>`;

  async function switchTab(id) {
    state.activeTab.results = id;
    el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    const c = document.getElementById('results-tab-content');
    if (id === 'cracked') await renderCracked(c);
    else if (id === 'potfile') await renderPotfile(c);
    else await renderExport(c);
  }

  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) await switchTab(btn.dataset.tab);
  });

  await switchTab(tab);
}

// ── Page: Files (tabbed) ────────────────────────────────────────────────────
async function renderFiles(el, tab) {
  tab = tab || state.activeTab.files || 'hashes';
  const tabs = [
    { id: 'hashes',    label: 'Hashes',    icon: 'fa-hashtag' },
    { id: 'wordlists', label: 'Wordlists', icon: 'fa-book-open' },
    { id: 'rules',     label: 'Rules',     icon: 'fa-scroll' },
    { id: 'masks',     label: 'Masks',     icon: 'fa-mask' },
  ];

  el.innerHTML = `
    <div class="flex gap-1 mb-5 border-b border-gray-800 pb-2">
      ${tabs.map(t => `
        <button class="tab-btn ${t.id === tab ? 'active' : ''}" data-tab="${t.id}">
          <i class="fa-solid ${t.icon} mr-1.5 text-xs"></i>${t.label}
        </button>`).join('')}
    </div>
    <div id="files-tab-content"></div>`;

  async function switchTab(id) {
    state.activeTab.files = id;
    el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    const c = document.getElementById('files-tab-content');
    if (id === 'hashes' || id === 'wordlists') await renderFileManager(c, id);
    else await renderFileList(c, id);
  }

  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) await switchTab(btn.dataset.tab);
  });

  await switchTab(tab);
}

// ── Page: Monitor (hardware + log) ──────────────────────────────────────────
async function renderMonitor(el) {
  if (!state.devices) {
    try { state.devices = await api('/api/devices'); } catch { state.devices = []; }
  }
  const running = state.jobs.find(j => j.status === 'running');

  function deviceTypeIcon(type) {
    if (!type) return '<i class="fa-solid fa-microchip text-gray-500"></i>';
    const t = type.toUpperCase();
    if (t.includes('GPU')) return '<i class="fa-solid fa-display text-green-400"></i>';
    if (t.includes('CPU')) return '<i class="fa-solid fa-microchip text-blue-400"></i>';
    return '<i class="fa-solid fa-microchip text-gray-400"></i>';
  }

  const deviceCards = (state.devices || []).map(d => {
    const stats = state.deviceStats[d.id] || {};
    const temp = stats.temperature || '—';
    const util = stats.utilization || '—';
    return `
      <div class="card py-3 space-y-2" id="device-card-${d.id}">
        <div class="flex items-center gap-2">
          <span class="text-base">${deviceTypeIcon(d.type)}</span>
          <div class="min-w-0">
            <p class="text-xs font-semibold text-gray-200 truncate" title="${escHtml(d.name)}">${escHtml(d.name || 'Device ' + d.id)}</p>
            <p class="text-xs text-gray-500">${escHtml(d.type || '')}${d.vendor ? ' · ' + escHtml(d.vendor) : ''}${d.memory ? ' · ' + escHtml(d.memory) : ''}</p>
          </div>
          <span class="ml-auto text-xs font-mono text-gray-600">#${d.id}</span>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div class="rounded-md bg-gray-800/60 px-2 py-1.5 flex items-center gap-1.5">
            <i class="fa-solid fa-thermometer-half text-orange-400"></i>
            <span class="text-gray-400">Temp</span>
            <span id="device-temp-${d.id}" class="ml-auto font-semibold text-gray-200">${temp}</span>
          </div>
          <div class="rounded-md bg-gray-800/60 px-2 py-1.5 flex items-center gap-1.5">
            <i class="fa-solid fa-gauge-high text-blue-400"></i>
            <span class="text-gray-400">Util</span>
            <span id="device-util-${d.id}" class="ml-auto font-semibold text-gray-200">${util}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  const noDevices = !state.devices?.length ? `
    <div class="card py-3 text-center text-xs text-gray-500">
      <i class="fa-solid fa-triangle-exclamation text-yellow-500 mr-1"></i>
      No devices found — is hashcat installed?
    </div>` : '';

  el.innerHTML = `
    <div class="space-y-4 h-full flex flex-col">
      <div>
        <p class="text-xs text-gray-500 uppercase tracking-wider mb-2 font-medium">Devices</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${deviceCards || noDevices}
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3 flex-shrink-0">
        <div class="card flex items-center gap-3 py-3">
          <i class="fa-solid fa-thermometer-half text-orange-400 text-lg w-6 text-center flex-shrink-0"></i>
          <div><p class="text-xs text-gray-500 mb-0.5">Temperature</p>
               <p id="hw-temp" class="font-semibold text-gray-200 text-sm">${state.hardwareLatest.temperature || '—'}</p></div>
        </div>
        <div class="card flex items-center gap-3 py-3">
          <i class="fa-solid fa-gauge-high text-blue-400 text-lg w-6 text-center flex-shrink-0"></i>
          <div><p class="text-xs text-gray-500 mb-0.5">Util</p>
               <p id="hw-util" class="font-semibold text-gray-200 text-sm">${state.hardwareLatest.utilization || '—'}</p></div>
        </div>
        <div class="card flex items-center gap-3 py-3">
          <i class="fa-solid fa-bolt text-orange-400 text-lg w-6 text-center flex-shrink-0"></i>
          <div><p class="text-xs text-gray-500 mb-0.5">Speed</p>
               <p id="hw-speed" class="font-semibold text-orange-400 text-sm">${running ? (running.speed || '—') : '—'}</p></div>
        </div>
      </div>
      <div id="monitor-log-wrap" class="flex-1 min-h-0"></div>
    </div>`;

  await renderLiveLog(document.getElementById('monitor-log-wrap'));
}

// ── Page: Settings (merged) ─────────────────────────────────────────────────
async function renderSettings(el) {
  let settings = {};
  try { settings = await api('/api/settings'); } catch {}

  el.innerHTML = `
  <div class="max-w-lg space-y-4">
    ${card(`
      <h2 class="card-title">Hashcat</h2>
      <div class="space-y-3">
        <div>
          <label class="field-label">Status timer (seconds)</label>
          <input id="cfg-status-timer" type="number" min="1" max="60" class="field-input"
            value="${settings.status_timer || 2}" />
        </div>
        <div>
          <label class="field-label">Potfile path <span class="text-gray-600">(relative to project root)</span></label>
          <input id="cfg-potfile" type="text" class="field-input font-mono"
            value="${settings.potfile_path || 'hashcat.potfile'}" />
        </div>
        <div>
          <label class="field-label">Extra global flags</label>
          <input id="cfg-global-flags" type="text" class="field-input font-mono"
            value="${settings.global_flags || ''}" placeholder="e.g. --force --opencl-device-types=1,2" />
        </div>
      </div>
    `)}
    ${card(`
      <h2 class="card-title">App</h2>
      <div class="space-y-3">
        <div>
          <label class="field-label">Max concurrent jobs</label>
          <input id="cfg-max-concurrent" type="number" min="1" max="8" class="field-input"
            value="${settings.max_concurrent || 1}" />
          <p class="text-xs text-gray-500 mt-1">Usually 1 — GPU runs one cracking job at a time efficiently.</p>
        </div>
        <label class="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
          <input type="checkbox" id="cfg-auto-restore" class="accent-orange-500"
            ${settings.auto_restore !== 'false' ? 'checked' : ''} />
          Resume interrupted jobs on server restart
        </label>
      </div>
    `)}
    <div class="flex items-center gap-3">
      <button id="btn-save-settings" class="btn-primary">
        <i class="fa-solid fa-floppy-disk mr-2"></i>Save Settings
      </button>
      <div id="cfg-feedback" class="hidden text-sm"></div>
    </div>
  </div>`;

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const fb = document.getElementById('cfg-feedback');
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          status_timer:    document.getElementById('cfg-status-timer').value,
          potfile_path:    document.getElementById('cfg-potfile').value,
          global_flags:    document.getElementById('cfg-global-flags').value,
          max_concurrent:  document.getElementById('cfg-max-concurrent').value,
          auto_restore:    document.getElementById('cfg-auto-restore').checked ? 'true' : 'false',
        }),
      });
      showFeedback(fb, 'success', 'Saved.');
    } catch(e) { showFeedback(fb, 'error', e.message); }
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  // Sidebar nav clicks
  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      navigate(a.dataset.page);
    });
  });

  // Preload jobs + stats
  try { [state.jobs, state.stats] = await Promise.all([api('/api/jobs'), api('/api/stats')]); } catch {}

  refreshTopbar();
  const el = document.getElementById('stat-cracked-val');
  if (el) el.textContent = state.stats.total_cracked;
  const jel = document.getElementById('stat-jobs-val');
  if (jel) jel.textContent = state.stats.total_jobs;

  // Route to initial page
  const page = currentPage();
  updateNavActive(page);
  await renderPage(page);

  // WebSocket
  connectWS();
}

document.addEventListener('DOMContentLoaded', boot);
