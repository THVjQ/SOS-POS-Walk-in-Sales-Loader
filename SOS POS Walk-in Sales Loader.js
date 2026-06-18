// ==UserScript==
// @name         SOS POS Ticket + Walk-in Loader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Paste a day's rows. Named-customer tickets are built first (create customer + repair line + stop at Checkout), then walk-ins. Captures each new ticket # next to the name to paste back into Google Sheets.
// @author       Claude
// @match        https://app.sospos.com.au/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // COLUMN MAP (0-based, tab-separated paste). Adjust if your sheet differs.
  //   C=2 ticket#  ·  E=4 cash  ·  F=5 eftpos  ·  description = last cell (after "PIN")
  // ─────────────────────────────────────────────────────────────
  const COL = { TICKET: 2, CASH: 4, EFTPOS: 5 };

  // ─────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────
  const DEFAULTS = { stepDelay: 350, stripWalkin: true, priceMode: 'sum', payMode: 'auto1' };
  function loadCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(GM_getValue('sost_cfg', '{}'))); }
    catch { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg(c) { GM_setValue('sost_cfg', JSON.stringify(c)); }
  let cfg = loadCfg();

  // ─────────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #sost-fab {
      position: fixed; bottom: 20px; left: 224px; width: 44px; height: 44px;
      border-radius: 50%; background: #0d9488; box-shadow: 0 3px 14px rgba(13,148,136,.55);
      border: none; cursor: pointer; z-index: 99999; display: flex; align-items: center;
      justify-content: center; font-size: 20px; transition: background .15s; user-select: none;
    }
    #sost-fab:hover { background: #0f766e; }
    #sost-panel {
      position: fixed; bottom: 72px; left: 20px; width: 410px; background: #0f172a;
      color: #e2e8f0; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.7);
      font-family: 'Segoe UI',system-ui,sans-serif; font-size: 13px; z-index: 99998;
      border: 1px solid #1e293b; display: none; overflow: hidden;
    }
    #sost-panel.open { display: block; }
    #sost-header {
      background: linear-gradient(135deg,#14b8a6 0%,#0d9488 100%); padding: 14px 16px;
      font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px;
    }
    #sost-header .sost-title { flex: 1; }
    #sost-close-btn {
      background: rgba(255,255,255,.2); border: none; color: #fff; width: 26px; height: 26px;
      border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; display: flex;
      align-items: center; justify-content: center;
    }
    #sost-close-btn:hover { background: rgba(255,255,255,.35); }
    #sost-tabs { display: flex; background: #0a1120; border-bottom: 1px solid #1e293b; }
    .sost-tab { flex: 1; padding: 9px 0; text-align: center; font-size: 12px; font-weight: 600;
      cursor: pointer; color: #64748b; border-bottom: 2px solid transparent; user-select: none; }
    .sost-tab.active { color: #14b8a6; border-bottom-color: #14b8a6; }
    .sost-pane { display: none; padding: 14px; }
    .sost-pane.active { display: block; }
    .sost-field { margin-bottom: 10px; }
    .sost-label { display: block; font-size: 11px; font-weight: 600; color: #64748b;
      margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
    .sost-input, .sost-select { width: 100%; box-sizing: border-box; background: #1e293b;
      border: 1px solid #334155; color: #e2e8f0; border-radius: 8px; padding: 7px 10px;
      font-size: 13px; outline: none; }
    .sost-input:focus, .sost-select:focus { border-color: #14b8a6; }
    .sost-select option { background: #1e293b; }
    .sost-btn { padding: 9px 14px; border-radius: 8px; border: none; cursor: pointer;
      font-weight: 600; font-size: 13px; white-space: nowrap; transition: opacity .15s, transform .1s; }
    .sost-btn:hover { opacity: .88; } .sost-btn:active { transform: scale(.97); }
    .sost-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sost-btn-primary { background: linear-gradient(135deg,#14b8a6,#0d9488); color: #fff; }
    .sost-btn-success { background: #16a34a; color: #fff; }
    .sost-btn-muted { background: #334155; color: #94a3b8; }
    .sost-btn-sm { padding: 5px 10px; font-size: 12px; }
    .sost-btn-row { display: flex; gap: 6px; margin-top: 8px; }
    #sost-drop-zone { border: 2px dashed #334155; border-radius: 10px; padding: 18px 14px;
      text-align: center; cursor: pointer; margin-bottom: 10px; position: relative;
      transition: border-color .2s, background .2s; }
    #sost-drop-zone:hover { border-color: #14b8a6; background: rgba(20,184,166,.06); }
    #sost-drop-zone .dz-icon { font-size: 26px; margin-bottom: 4px; }
    #sost-drop-zone .dz-main { font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 2px; }
    #sost-drop-zone .dz-sub { font-size: 11px; color: #475569; }
    #sost-drop-zone.has-data { border-style: solid; border-color: #16a34a; background: rgba(22,163,74,.05);
      padding: 10px 14px; text-align: left; cursor: default; }
    #sost-drop-zone.has-data .dz-icon, #sost-drop-zone.has-data .dz-main, #sost-drop-zone.has-data .dz-sub { display: none; }
    #sost-paste { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; top: 0; left: 0; }
    #sost-paste-summary { display: none; align-items: center; gap: 8px; font-size: 12px; color: #86efac; }
    #sost-paste-summary .ps-count { background: #166534; color: #86efac; border-radius: 20px; padding: 2px 9px; font-weight: 700; }
    #sost-paste-summary .ps-clear { margin-left: auto; cursor: pointer; color: #f87171; font-size: 16px; line-height: 1; padding: 2px 4px; }
    #sost-preview { max-height: 250px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
    #sost-preview::-webkit-scrollbar { width: 4px; }
    #sost-preview::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
    .sost-section-h { font-size: 10px; font-weight: 800; letter-spacing: .8px; text-transform: uppercase;
      color: #64748b; margin: 4px 0 -2px; }
    .sost-job { background: #131f2e; border: 1px solid #1e293b; border-radius: 10px; padding: 9px 11px; }
    .sost-job.active { background: #06201d; border-color: #14b8a6; }
    .sost-job.done { background: #0a150a; border-color: #166534; opacity: .65; }
    .sost-job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .sost-badge { border-radius: 6px; padding: 1px 7px; font-size: 10px; font-weight: 800; }
    .sost-badge.named { background: #134e4a; color: #5eead4; }
    .sost-badge.walk { background: #422006; color: #fdba74; }
    .sost-job-name { font-size: 12.5px; font-weight: 700; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sost-job-total { margin-left: auto; font-size: 12px; font-weight: 700; color: #4ade80; }
    .sost-job-sub { font-size: 10.5px; color: #64748b; margin-bottom: 4px; }
    .sost-line { display: flex; gap: 6px; font-size: 11px; color: #94a3b8; padding: 2px 0; border-top: 1px solid #1e293b; }
    .sost-line:first-of-type { border-top: none; }
    .sost-line .ln-desc { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sost-line .ln-price { color: #4ade80; font-weight: 600; }
    .sost-line .ln-method { color: #64748b; font-size: 10px; background: #0f172a; border-radius: 4px; padding: 0 5px; }
    #sost-prog-wrap { margin-top: 10px; }
    #sost-prog-bg { height: 5px; background: #1e293b; border-radius: 3px; overflow: hidden; }
    #sost-prog-bar { height: 100%; width: 0%; background: linear-gradient(90deg,#14b8a6,#0d9488); border-radius: 3px; transition: width .4s; }
    #sost-status { margin-top: 6px; font-size: 11.5px; color: #94a3b8; min-height: 16px; text-align: center; }
    .sost-divider { border: none; border-top: 1px solid #1e293b; margin: 12px 0; }
    .sost-note { color: #475569; font-size: 11px; line-height: 1.6; margin: 0; }
    .sost-note b { color: #5eead4; }
    .sost-row2 { display: flex; gap: 8px; } .sost-row2 > * { flex: 1; }
    /* results */
    #sost-results-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #sost-results-table th { text-align: left; color: #64748b; font-size: 10px; text-transform: uppercase; padding: 4px; }
    #sost-results-table td { padding: 3px 4px; border-top: 1px solid #1e293b; }
    #sost-results-table input { width: 78px; background: #1e293b; border: 1px solid #334155; color: #e2e8f0;
      border-radius: 6px; padding: 4px 6px; font-size: 12px; }
    .sost-res-name { color: #cbd5e1; }
    #sost-results-empty { color: #475569; font-size: 12px; text-align: center; padding: 16px 0; }
  `;
  document.head.appendChild(style);

  // ─────────────────────────────────────────────────────────────
  // FAB + panel
  // ─────────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'sost-fab';
  fab.title = 'SOS POS Ticket + Walk-in Loader';
  fab.innerHTML = '👤';
  document.body.appendChild(fab);
  [400, 1200, 2500, 4500].forEach(t => setTimeout(positionFab, t));
  window.addEventListener('resize', () => setTimeout(positionFab, 100));

  const panel = document.createElement('div');
  panel.id = 'sost-panel';
  panel.innerHTML = `
    <div id="sost-header">
      <span>👤</span><span class="sost-title">Ticket + Walk-in Loader</span>
      <button id="sost-close-btn" title="Close">✕</button>
    </div>
    <div id="sost-tabs">
      <div class="sost-tab active" data-tab="build">🛠 Build</div>
      <div class="sost-tab" data-tab="results">📋 Results</div>
      <div class="sost-tab" data-tab="settings">⚙ Settings</div>
    </div>

    <!-- BUILD -->
    <div class="sost-pane active" id="tab-build">
      <div id="sost-drop-zone" tabindex="0" title="Click then Ctrl+V to paste">
        <textarea id="sost-paste" tabindex="-1" aria-hidden="true"></textarea>
        <div class="dz-icon">📋</div>
        <div class="dz-main">Click here, then paste the day's rows</div>
        <div class="dz-sub">Named tickets build first, walk-ins after.</div>
        <div id="sost-paste-summary">
          <span class="ps-count" id="sost-count-badge">0</span>
          <span id="sost-count-label">jobs ready</span>
          <span class="ps-clear" id="sost-dz-clear" title="Clear">✕</span>
        </div>
      </div>
      <div class="sost-btn-row">
        <button class="sost-btn sost-btn-success" id="sost-build-btn" style="display:none;flex:1">▶ Start</button>
        <button class="sost-btn sost-btn-muted sost-btn-sm" id="sost-clear-btn" style="display:none">Clear</button>
      </div>
      <div id="sost-preview"></div>
      <div id="sost-prog-wrap"><div id="sost-prog-bg"><div id="sost-prog-bar"></div></div><div id="sost-status"></div></div>
    </div>

    <!-- RESULTS -->
    <div class="sost-pane" id="tab-results">
      <div id="sost-results-empty">No tickets captured yet.<br>They appear here as you build each one.</div>
      <table id="sost-results-table" style="display:none">
        <thead><tr><th>Ticket #</th><th>Name</th></tr></thead>
        <tbody id="sost-results-body"></tbody>
      </table>
      <div class="sost-btn-row" id="sost-results-actions" style="display:none">
        <button class="sost-btn sost-btn-primary sost-btn-sm" id="sost-copy-btn" style="flex:1">📋 Copy for Sheets</button>
        <button class="sost-btn sost-btn-muted sost-btn-sm" id="sost-results-clear">Clear</button>
      </div>
      <p class="sost-note" style="margin-top:8px">Ticket #s are read off the dashboard automatically and are <b>editable</b> — fix any before copying. Copy is tab-separated (ticket ⇥ name).</p>
    </div>

    <!-- SETTINGS -->
    <div class="sost-pane" id="tab-settings">
      <div class="sost-field">
        <label class="sost-label">Payment</label>
        <select class="sost-select" id="sost-pay-mode">
          <option value="manual">Stop at Checkout — I take payment</option>
          <option value="auto1">Auto-pay each, pause between (recommended)</option>
          <option value="autoall">Auto-pay — run everything</option>
        </select>
      </div>
      <div class="sost-field">
        <label class="sost-label">Line item price</label>
        <select class="sost-select" id="sost-price-mode">
          <option value="sum">Cash + EFTPOS added together</option>
          <option value="eftpos">EFTPOS column only</option>
          <option value="cash">Cash column only</option>
        </select>
      </div>
      <div class="sost-row2">
        <div class="sost-field">
          <label class="sost-label">Step delay (ms)</label>
          <input class="sost-input" id="sost-step-delay" type="number" min="100" step="50" />
        </div>
        <div class="sost-field">
          <label class="sost-label">Strip "Walkin" prefix</label>
          <select class="sost-select" id="sost-strip">
            <option value="yes">Yes</option><option value="no">No</option>
          </select>
        </div>
      </div>
      <button class="sost-btn sost-btn-primary sost-btn-sm" id="sost-save-cfg">Save settings</button>
      <hr class="sost-divider">
      <p class="sost-note">
        <b>Order:</b> named tickets first (create customer → repair line → pay), then walk-ins.<br>
        <b>Name parse:</b> <code>Name - Phone - repair details</code>. First phone only; no phone → <b>X</b>; email auto-detected.<br>
        <b>Payment:</b> the split is taken from the cash/eftpos columns. Complete is only clicked once the app confirms the amount reconciles to the total — otherwise the modal is left open for you.<br>
        <b>Columns:</b> C ticket# · E cash · F eftpos · last cell = description. Edit the <code>COL</code> map up top if needed.
      </p>
    </div>
  `;
  document.body.appendChild(panel);

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('sost-close-btn').addEventListener('click', () => panel.classList.remove('open'));
  document.querySelectorAll('.sost-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sost-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sost-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // settings wiring
  const $price = document.getElementById('sost-price-mode');
  const $delay = document.getElementById('sost-step-delay');
  const $strip = document.getElementById('sost-strip');
  const $pay = document.getElementById('sost-pay-mode');
  $price.value = cfg.priceMode; $delay.value = cfg.stepDelay; $strip.value = cfg.stripWalkin ? 'yes' : 'no'; $pay.value = cfg.payMode;
  document.getElementById('sost-save-cfg').addEventListener('click', () => {
    cfg.priceMode = $price.value;
    cfg.stepDelay = Math.max(100, parseInt($delay.value, 10) || DEFAULTS.stepDelay);
    cfg.stripWalkin = $strip.value === 'yes';
    cfg.payMode = $pay.value;
    saveCfg(cfg); setStatus('✓ Settings saved.');
    if (rawCache) doParse(rawCache);
  });

  // ─────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────
  let jobs = [];          // ordered: named first, then walk-ins
  let builtIdx = -1;      // index of the last job we built
  let rawCache = '';
  let results = [];       // [{ticket, name}]
  const captured = new Set();

  const dropZone = document.getElementById('sost-drop-zone');
  const pasteArea = document.getElementById('sost-paste');
  dropZone.addEventListener('click', e => { if (e.target.id === 'sost-dz-clear') return; if (!dropZone.classList.contains('has-data')) pasteArea.focus(); });
  pasteArea.addEventListener('paste', e => {
    e.preventDefault();
    const raw = (e.clipboardData || window.clipboardData).getData('text');
    pasteArea.value = raw; setTimeout(() => doParse(raw), 40);
  });
  document.getElementById('sost-dz-clear').addEventListener('click', clearAll);

  // ─────────────────────────────────────────────────────────────
  // Parse helpers
  // ─────────────────────────────────────────────────────────────
  function num(v) { const n = parseFloat(String(v || '').replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; }
  function priceFor(c, e) { return cfg.priceMode === 'cash' ? c : cfg.priceMode === 'eftpos' ? e : c + e; }
  function methodLabel(c, e) { if (c > 0 && e > 0) return `Split $${c}c/$${e}e`; if (c > 0) return 'Cash'; if (e > 0) return 'EFTPOS'; return '—'; }
  function isWalkin(desc) { return /^\s*walk[\s-]?in\b/i.test(desc); }

  function extractDescription(cols) {
    const pin = cols.findIndex(c => c.trim().toUpperCase() === 'PIN');
    if (pin >= 0 && cols[pin + 1] && cols[pin + 1].trim()) return cols[pin + 1].trim();
    for (let i = cols.length - 1; i >= 0; i--) if (cols[i] && cols[i].trim()) return cols[i].trim();
    return '';
  }

  function stripWalk(d) {
    if (cfg.stripWalkin) d = d.replace(/^\s*walk[\s-]?in\s*[-–:]?\s*/i, '').trim();
    return d || '(item)';
  }

  // Find the first Australian-style phone in a string.
  function firstPhone(s) {
    const re = /0[\d\s-]{6,}/g; let m;
    while ((m = re.exec(s))) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 12) {
        const raw = m[0].replace(/[\s-]+$/, '');
        return { raw: raw.trim(), index: m.index, end: m.index + raw.length };
      }
    }
    return null;
  }

  function parseNamed(desc) {
    let email = '';
    const em = desc.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (em) email = em[0];

    const ph = firstPhone(desc);
    let name = '', phone = 'X', details = '';

    if (ph) {
      phone = ph.raw.replace(/\s+/g, ' ').trim();
      name = desc.slice(0, ph.index).replace(/[-–\s]+$/, '').trim();
      let rest = desc.slice(ph.end);
      rest = rest.replace(/^\s*\([^)]*\)/, '');     // drop a "(second phone / note)" right after
      rest = rest.replace(/^\s*[-–:]\s*/, '').trim();
      details = rest;
    } else {
      const parts = desc.split(/\s+[-–]\s+/);
      name = (parts.shift() || '').trim();
      details = parts.join(' - ').trim();
    }
    if (email) {
      name = name.replace(email, '').trim();
      details = details.replace(email, '').replace(/^\s*[-–:]\s*/, '').trim();
    }
    return { name: name || '(no name)', phone, email, details: details || desc };
  }

  const SKIP = /^(date|ticket|status|description|no\.?|google|balanced|fri|sat|sun|mon|tue|wed|thu)$/i;

  function doParse(raw) {
    rawCache = raw;
    if (!raw) { setStatus('⚠️ Nothing pasted yet.'); return; }

    const namedMap = new Map(), walkMap = new Map();

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const desc = extractDescription(cols);
      if (!desc || SKIP.test(desc)) continue;

      const cash = num(cols[COL.CASH]), eftpos = num(cols[COL.EFTPOS]);
      const price = priceFor(cash, eftpos);
      let ticket = (cols[COL.TICKET] || '').trim();

      if (isWalkin(desc)) {
        if (!ticket) ticket = 'Walk-in (no #)';
        const key = 'W:' + ticket;
        if (!walkMap.has(key)) walkMap.set(key, { type: 'walkin', ticket, items: [], total: 0, totalCash: 0, totalEftpos: 0, status: 'pending' });
        const g = walkMap.get(key);
        g.items.push({ desc: stripWalk(desc), price, cash, eftpos, method: methodLabel(cash, eftpos) });
        g.total += price; g.totalCash += cash; g.totalEftpos += eftpos;
      } else {
        const p = parseNamed(desc);
        if (!ticket) ticket = p.name;
        const key = 'N:' + ticket;
        if (!namedMap.has(key)) namedMap.set(key, { type: 'named', ticket, customer: { name: p.name, phone: p.phone, email: p.email }, items: [], total: 0, totalCash: 0, totalEftpos: 0, status: 'pending' });
        const g = namedMap.get(key);
        if ((!g.customer.name || g.customer.name === '(no name)') && p.name) g.customer = { name: p.name, phone: p.phone, email: p.email };
        g.items.push({ desc: p.details, price, cash, eftpos, method: methodLabel(cash, eftpos) });
        g.total += price; g.totalCash += cash; g.totalEftpos += eftpos;
      }
    }

    const named = Array.from(namedMap.values());
    const walk = Array.from(walkMap.values());
    jobs = [...named, ...walk];
    builtIdx = -1; captured.clear();
    renderPreview(named.length, walk.length);

    if (jobs.length) {
      dropZone.classList.add('has-data');
      document.getElementById('sost-paste-summary').style.display = 'flex';
      document.getElementById('sost-count-badge').textContent = jobs.length;
      document.getElementById('sost-count-label').textContent = `${named.length} named · ${walk.length} walk-in`;
      const b = document.getElementById('sost-build-btn');
      b.style.display = 'block'; b.disabled = false;
      b.textContent = `▶ Start — Build 1/${jobs.length} (${labelOf(jobs[0])})`;
      document.getElementById('sost-clear-btn').style.display = 'block';
      setStatus('');
    } else {
      dropZone.classList.remove('has-data');
      setStatus('⚠️ No valid rows found — check the column map in Settings.');
    }
  }

  function labelOf(job) { return job.type === 'named' ? job.customer.name : job.ticket; }

  function renderPreview(nNamed, nWalk) {
    const html = [];
    let idx = 0;
    if (nNamed) html.push(`<div class="sost-section-h">Named tickets — built first (${nNamed})</div>`);
    jobs.forEach((job, gi) => {
      if (job.type === 'walkin' && idx === 0 && nWalk) { html.push(`<div class="sost-section-h">Walk-ins — built last (${nWalk})</div>`); }
      if (job.type === 'walkin') idx = 1;
      const badge = job.type === 'named'
        ? `<span class="sost-badge named">CX</span>`
        : `<span class="sost-badge walk">WALK</span>`;
      const title = job.type === 'named' ? esc(job.customer.name) : esc(job.ticket);
      const sub = job.type === 'named'
        ? `<div class="sost-job-sub">☎ ${esc(job.customer.phone)}${job.customer.email ? ' · ✉ ' + esc(job.customer.email) : ''}</div>` : '';
      html.push(`
        <div class="sost-job ${job.status}" id="sost-job-${gi}">
          <div class="sost-job-head">${badge}<span class="sost-job-name">${title}</span><span class="sost-job-total">$${job.total.toFixed(2)}</span></div>
          ${sub}
          ${job.items.map(it => `<div class="sost-line"><span class="ln-desc">${esc(it.desc)}</span><span class="ln-method">${it.method}</span><span class="ln-price">$${it.price.toFixed(2)}</span></div>`).join('')}
        </div>`);
    });
    document.getElementById('sost-preview').innerHTML = html.join('');
  }

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function clearAll() {
    jobs = []; builtIdx = -1; rawCache = ''; captured.clear();
    pasteArea.value = '';
    document.getElementById('sost-preview').innerHTML = '';
    document.getElementById('sost-build-btn').style.display = 'none';
    document.getElementById('sost-clear-btn').style.display = 'none';
    document.getElementById('sost-prog-bar').style.width = '0%';
    dropZone.classList.remove('has-data');
    document.getElementById('sost-paste-summary').style.display = 'none';
    setStatus('');
  }

  function setStatus(m) { document.getElementById('sost-status').textContent = m; }
  function setJobStatus(i, s) { jobs[i].status = s; const el = document.getElementById(`sost-job-${i}`); if (el) el.className = `sost-job ${s}`; }
  function setProgress() {
    const done = jobs.filter(j => j.status === 'done').length;
    document.getElementById('sost-prog-bar').style.width = jobs.length ? `${Math.round(done / jobs.length * 100)}%` : '0%';
  }

  // ─────────────────────────────────────────────────────────────
  // Build stepping
  // ─────────────────────────────────────────────────────────────
  const buildBtn = document.getElementById('sost-build-btn');
  buildBtn.addEventListener('click', onBuildClick);
  document.getElementById('sost-clear-btn').addEventListener('click', clearAll);

  async function onBuildClick() {
    buildBtn.disabled = true;
    const mode = cfg.payMode;

    if (mode === 'autoall') { await runAll(); return; }

    // manual: capture the ticket the user just checked out before moving on
    if (mode === 'manual' && builtIdx >= 0) captureResult(builtIdx);

    const toBuild = builtIdx + 1;
    if (toBuild >= jobs.length) { finishAll(); return; }

    setJobStatus(toBuild, 'active');
    setStatus(`Building ${labelOf(jobs[toBuild])}…`);
    try {
      await buildJob(jobs[toBuild]);
      if (mode === 'auto1') {
        await payAndComplete(jobs[toBuild]);
        captureResult(toBuild);
      }
      setJobStatus(toBuild, 'done'); builtIdx = toBuild; setProgress();
      updateStepButton(mode);
    } catch (e) {
      setJobStatus(toBuild, 'pending'); buildBtn.disabled = false;
      setStatus('✕ ' + e.message); console.error('[SOS Ticket]', e);
    }
  }

  function updateStepButton(mode) {
    buildBtn.disabled = false;
    const remaining = builtIdx + 1 < jobs.length;
    if (mode === 'auto1') {
      if (remaining) { buildBtn.textContent = `▶ Next ticket (${builtIdx + 2}/${jobs.length})`; setStatus(`✓ Paid "${labelOf(jobs[builtIdx])}". Click for the next.`); }
      else { finishAll(); }
    } else { // manual
      if (remaining) { buildBtn.textContent = `✓ Built — Checkout, then Next (${builtIdx + 2}/${jobs.length})`; setStatus(`Review & Checkout "${labelOf(jobs[builtIdx])}", then click for next.`); }
      else { buildBtn.textContent = '✓ Built last — Checkout, then Finish'; setStatus('Checkout the last one, then click Finish.'); }
    }
  }

  async function runAll() {
    for (let i = builtIdx + 1; i < jobs.length; i++) {
      setJobStatus(i, 'active'); setStatus(`(${i + 1}/${jobs.length}) ${labelOf(jobs[i])}…`);
      try {
        await buildJob(jobs[i]);
        await payAndComplete(jobs[i]);
        captureResult(i);
        setJobStatus(i, 'done'); builtIdx = i; setProgress();
      } catch (e) {
        setJobStatus(i, 'pending');
        setStatus(`✕ Stopped at ${labelOf(jobs[i])}: ${e.message}`);
        console.error('[SOS Ticket]', e);
        buildBtn.disabled = false; buildBtn.textContent = `▶ Resume from ${i + 1}/${jobs.length}`;
        return; // halt the run so you can fix it, then resume
      }
      await sleep(cfg.stepDelay + 400);
    }
    finishAll();
  }

  function finishAll() {
    buildBtn.textContent = '✓ All done'; buildBtn.disabled = true;
    setStatus(`🎉 Finished — ${results.length} ticket${results.length !== 1 ? 's' : ''} captured. See Results.`);
    switchTab('results');
  }

  async function buildJob(job) {
    const saleTab = findTab('Sale');
    if (saleTab) { saleTab.click(); await sleep(cfg.stepDelay); }

    if (job.type === 'named') {
      await createCustomer(job.customer);
    } else {
      const w = findWalkInButton();
      if (!w) throw new Error('Walk-in button not found');
      w.click(); await sleep(cfg.stepDelay + 150);
    }

    for (let k = 0; k < job.items.length; k++) {
      if (k > 0) { const a = findAddItemButton(); if (!a) throw new Error('"Add another item" not found'); a.click(); await sleep(cfg.stepDelay); }
      const descs = lineInputs('Item description'), prices = lineInputs('0.00');
      const d = descs[k], p = prices[k];
      if (!d || !p) throw new Error(`Line row ${k + 1} fields not found`);
      setNativeValue(d, job.items[k].desc); await sleep(80);
      setNativeValue(p, String(job.items[k].price)); await sleep(cfg.stepDelay);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Payment: open Checkout, fill the split fields, click Complete
  // (the app keeps Complete disabled until entered == total, which
  //  is our safety check — we never force it.)
  // ─────────────────────────────────────────────────────────────
  function round2(x) { return Math.round(x * 100) / 100; }

  async function payAndComplete(job) {
    const checkoutBtn = findCheckoutButton();
    if (!checkoutBtn) throw new Error('Checkout button not found');
    if (checkoutBtn.disabled) throw new Error('Checkout button is disabled (customer/items missing?)');
    checkoutBtn.click();

    const dialog = await waitFor(() => findCheckoutDialog(), 5000);
    if (!dialog) throw new Error('Checkout modal did not open');
    await sleep(cfg.stepDelay);

    const total = round2(job.total);

    // decide the split from the columns / price mode (always sums to the total)
    let payCash = 0, payEftpos = 0;
    if (cfg.priceMode === 'cash') payCash = total;
    else if (cfg.priceMode === 'eftpos') payEftpos = total;
    else { payCash = round2(job.totalCash); payEftpos = round2(job.totalEftpos); }
    if (Math.abs((payCash + payEftpos) - total) > 0.005) payEftpos = round2(total - payCash); // reconcile rounding

    if (total > 0) {
      const cashIn = splitInput(dialog, 'Cash');
      const eftIn = splitInput(dialog, 'EFTPOS');
      if (payCash > 0) { if (!cashIn) throw new Error('Cash split field not found'); setNativeValue(cashIn, payCash.toFixed(2)); await sleep(160); }
      if (payEftpos > 0) { if (!eftIn) throw new Error('EFTPOS split field not found'); setNativeValue(eftIn, payEftpos.toFixed(2)); await sleep(160); }
      await sleep(cfg.stepDelay);
    }

    const completeBtn = Array.from(dialog.querySelectorAll('button')).find(b => /complete payment/i.test(b.textContent));
    if (!completeBtn) throw new Error('Complete Payment button not found');

    // Wait for the app to validate the entered amount and enable the button.
    let tries = 0;
    while (completeBtn.disabled && tries < 12) { await sleep(150); tries++; }
    if (completeBtn.disabled) throw new Error('Complete Payment stayed disabled — amounts did not reconcile; modal left open for you');

    completeBtn.click();
    await waitFor(() => !findCheckoutDialog(), 6000);
    await sleep(cfg.stepDelay + 400); // let the dashboard register the new ticket #
  }

  async function createCustomer(c) {
    const addBtn = findAddCustomerButton();
    if (!addBtn) throw new Error('Add-customer (+) button not found');
    addBtn.click();
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
    if (!dialog) throw new Error('Add Customer dialog did not open');
    await sleep(cfg.stepDelay);

    const nameEl = dialog.querySelector('input[placeholder="Customer name"]')
      || dialog.querySelector('input');
    const phoneEl = dialog.querySelector('input[placeholder="0400 000 000"]')
      || dialog.querySelectorAll('input')[1];
    const emailEl = dialog.querySelector('input[type="email"], input[placeholder="customer@example.com"]');

    if (nameEl) { setNativeValue(nameEl, c.name); await sleep(90); }
    if (phoneEl) { setNativeValue(phoneEl, c.phone || 'X'); await sleep(90); }
    if (emailEl && c.email) { setNativeValue(emailEl, c.email); await sleep(90); }
    await sleep(cfg.stepDelay);

    const createBtn = Array.from(dialog.querySelectorAll('button')).find(b => /create customer/i.test(b.textContent));
    if (!createBtn) throw new Error('Create Customer button not found');
    if (createBtn.disabled) { await sleep(300); }   // give React validation a tick
    if (createBtn.disabled) console.warn('[SOS Ticket] Create button still disabled — check name/phone validation');
    createBtn.click();
    await waitFor(() => !document.querySelector('[role="dialog"]'), 4000);
    await sleep(cfg.stepDelay);
  }

  // ─────────────────────────────────────────────────────────────
  // Results capture
  // ─────────────────────────────────────────────────────────────
  function captureResult(i) {
    if (captured.has(i)) return;
    captured.add(i);
    const job = jobs[i];
    const name = job.type === 'named' ? job.customer.name : 'Walk-in';
    results.push({ ticket: latestTicket(), name });
    renderResults();
  }

  function latestTicket() {
    const set = new Set();
    document.querySelectorAll('td, span, div, a, button').forEach(el => {
      if (el.children.length) return;                 // leaf nodes only
      const t = el.textContent.trim();
      if (/^[A-Z]\d{3,6}$/.test(t)) set.add(t);        // e.g. A2918
    });
    const arr = Array.from(set).map(t => ({ t, n: parseInt(t.replace(/\D/g, ''), 10) }));
    if (!arr.length) return '';
    arr.sort((a, b) => b.n - a.n);
    return arr[0].t;                                   // highest number = newest ticket
  }

  function renderResults() {
    const body = document.getElementById('sost-results-body');
    const table = document.getElementById('sost-results-table');
    const empty = document.getElementById('sost-results-empty');
    const actions = document.getElementById('sost-results-actions');
    if (!results.length) { table.style.display = 'none'; actions.style.display = 'none'; empty.style.display = 'block'; return; }
    empty.style.display = 'none'; table.style.display = 'table'; actions.style.display = 'flex';
    body.innerHTML = results.map((r, i) => `
      <tr><td><input data-i="${i}" value="${esc(r.ticket)}" placeholder="A####"></td>
      <td class="sost-res-name">${esc(r.name)}</td></tr>`).join('');
    body.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { results[Number(inp.dataset.i)].ticket = inp.value; }));
  }

  document.getElementById('sost-copy-btn').addEventListener('click', () => {
    const tsv = results.map(r => `${r.ticket}\t${r.name}`).join('\n');
    navigator.clipboard.writeText(tsv).then(
      () => { const b = document.getElementById('sost-copy-btn'); const o = b.textContent; b.textContent = '✓ Copied!'; setTimeout(() => b.textContent = o, 1500); },
      () => alert('Copy failed — here it is:\n\n' + tsv)
    );
  });
  document.getElementById('sost-results-clear').addEventListener('click', () => { results = []; captured.clear(); renderResults(); });

  function switchTab(name) {
    document.querySelectorAll('.sost-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.sost-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  // ─────────────────────────────────────────────────────────────
  // DOM helpers
  // ─────────────────────────────────────────────────────────────
  function findTab(label) { return Array.from(document.querySelectorAll('[role="tab"]')).find(t => t.textContent.trim().toLowerCase().includes(label.toLowerCase())); }
  function findWalkInButton() { return document.querySelector('button[title*="Walk-in" i]') || Array.from(document.querySelectorAll('button')).find(b => /walk[\s-]?in/i.test(b.getAttribute('title') || b.textContent || '')); }
  function findAddCustomerButton() { return Array.from(document.querySelectorAll('button')).find(b => b.querySelector('svg.lucide-user-plus')); }
  function findAddItemButton() { return Array.from(document.querySelectorAll('button')).find(b => /add another item/i.test(b.textContent.trim())); }
  function lineInputs(ph) { return Array.from(document.querySelectorAll(`input[placeholder="${ph}"]`)); }

  // The Sale-panel "Checkout" button (not the one inside any dialog)
  function findCheckoutButton() {
    return Array.from(document.querySelectorAll('button')).find(b =>
      !b.closest('[role="dialog"]') && /checkout/i.test(b.textContent.trim()) && !/move to board/i.test(b.textContent));
  }
  // The Checkout dialog, identified by its heading
  function findCheckoutDialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(d => {
      const h = d.querySelector('h2'); return h && /checkout/i.test(h.textContent);
    });
  }
  // One of the Split/Custom number inputs by its small label (Cash / EFTPOS / Transfer)
  function splitInput(dialog, labelText) {
    const lab = Array.from(dialog.querySelectorAll('label')).find(l => l.textContent.trim() === labelText);
    if (!lab) return null;
    return (lab.parentElement || dialog).querySelector('input[type="number"]');
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  async function waitFor(fn, timeout = 4000, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = fn(); if (r) return r; await sleep(step); } return null; }

  function positionFab() {
    let best = null, bestRight = -1;
    document.querySelectorAll('button, a, div, [role="button"]').forEach(el => {
      if (el.id && (el.id.startsWith('sost') || el.id.startsWith('sosw'))) return;
      if (el === fab || el === panel) return;
      const r = el.getBoundingClientRect();
      if (r.width < 32 || r.width > 60) return;
      if (Math.abs(r.width - r.height) > 12) return;
      if (r.bottom < window.innerHeight - 110 || r.bottom > window.innerHeight - 3) return;
      if (r.left < 2 || r.left > 340) return;
      if (r.right > bestRight) { bestRight = r.right; best = r; }
    });
    if (best && bestRight <= 400) { fab.style.left = Math.round(bestRight + 12) + 'px'; fab.style.bottom = Math.round(window.innerHeight - best.bottom) + 'px'; }
    else { fab.style.left = '224px'; fab.style.bottom = '20px'; }
  }

})();
