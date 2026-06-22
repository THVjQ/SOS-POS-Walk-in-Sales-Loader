// ==UserScript==
// @name         SOS POS Sales Loader
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  Paste rows from your sales sheet. Repair-job parser (v2) produces device + job labels only, cutting narrative notes. Skips existing tickets. Defers unresolvable rows for manual entry. Namespaced pane IDs to avoid clashing with other SOS POS scripts.
// @author       Claude
// @match        https://app.sospos.com.au/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  // Guard: if a second copy loads (e.g. manager + a direct install both running),
  // bail out so we don't get two panels with duplicate IDs breaking tab switching.
  if (window.__sostSalesLoaded__) return;
  window.__sostSalesLoaded__ = true;

  // Bump this in lock-step with @version above. The TM Script Manager strips the
  // UserScript header before eval, so @version isn't readable at runtime — this
  // body constant is what the header badge shows.
  const SCRIPT_VERSION = '2.8';

  // ─────────────────────────────────────────────────────────────
  // Parser — device + repair job extractor (v2 improved algorithm)
  // Produces:  device label + job labels joined, narrative stripped.
  // Walk-ins bypass this entirely (handled separately below).
  // ─────────────────────────────────────────────────────────────
  const Parser = (() => {
    // ── Phone ────────────────────────────────────────────────────
    function findPhone(text) {
      const cands = text.match(/(?:\+?61[\s-]?|0)?\d(?:[\s-]?\d){6,11}/g) || [];
      const valid = [];
      for (const c of cands) {
        let d = c.replace(/[^\d]/g,'');
        if (d.startsWith('61') && d.length >= 11) d = '0' + d.slice(2);
        if (d.length === 9 && d[0] === '4') d = '0' + d;
        if (d.length === 8) d = '02' + d;
        const isMobile = /^04\d{8}$/.test(d);
        const isLand   = /^0[2-9]\d{8}$/.test(d);
        if (!isMobile && !isLand) continue;
        valid.push({ pretty: prettyPhone(d), isMobile });
      }
      const mob = valid.find(v => v.isMobile);
      return mob ? mob.pretty : (valid.length ? valid[0].pretty : 'X');
    }
    function prettyPhone(d) {
      if (/^04\d{8}$/.test(d))   return d.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3');
      if (/^0[2-9]\d{8}$/.test(d)) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2 $3');
      return d;
    }

    // ── Email ────────────────────────────────────────────────────
    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const firstEmail = t => { const m = t.match(EMAIL_RE); return m ? m[0].toLowerCase() : ''; };

    // ── Device ───────────────────────────────────────────────────
    const TIER  = '(pro max|pro|plus|max|mini|ultra|fe|\\+)';
    const cap   = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
    const upper = s => s ? s.toUpperCase().replace(/\s+/g,' ').trim() : '';
    function tierSuffix(t) {
      if (!t) return '';
      const x = t.toLowerCase().trim();
      return x === '+' ? ' Plus' : ' ' + x.split(/\s+/).map(cap).join(' ');
    }

    const DEVICE_PATTERNS = [
      { re: /\bipad\s*(pro|air|mini)?\s*(\d{1,2}\.\d|\d{1,2}\s*(?:"|inch))?\s*(\d{1,2})?(?:st|nd|rd|th)?\s*(?:gen)?\s*(a\d{4})?/i,
        fmt: m => ('iPad '+(m[1]?cap(m[1])+' ':'')+
                   (m[2]?m[2].trim()+' ':'')+
                   (m[3]?m[3]+' ':'')+
                   (m[4]?m[4].toUpperCase():'')).replace(/\s+/g,' ').trim() },
      { re: /\bmacbook\s*(pro|air)?\s*(a\d{4})?/i,
        fmt: m => 'MacBook'+(m[1]?' '+cap(m[1]):'')+( m[2]?' '+m[2].toUpperCase():'') },
      { re: /\bipod\b/i, fmt: () => 'iPod' },
      { re: new RegExp('\\biphone\\s*(\\d{1,2}s?|xs max|xs|xr|x|se\\s*\\d?|se)\\s*'+TIER+'?','i'),
        fmt: m => 'iPhone '+upper(m[1])+tierSuffix(m[2]) },
      { re: /\b(?:samsung\s+)?(?:galaxy\s+)?(s|note|tab)\s*(\d{1,3}[a-z]?)\s*(ultra|plus|fe|\+|pro)?/i,
        fmt: m => 'Galaxy '+m[1].toUpperCase()+m[2].toUpperCase()+tierSuffix(m[3]) },
      { re: /\b(?:samsung\s+)?(?:galaxy\s+)?a\s*(\d{2,3}[a-z]?)(?!\d)\s*(5g)?/i,
        fmt: m => 'Galaxy A'+m[1].toUpperCase()+(m[2]?' 5G':'') },
      { re: /\b(?:samsung\s+)?(?:galaxy\s+)?z\s*(flip|fold)\s*(\d)?/i,
        fmt: m => 'Galaxy Z '+cap(m[1])+(m[2]?' '+m[2]:'') },
      { re: /\bsamsung\s+(sm-?\w+)/i,          fmt: m => 'Samsung '+m[1].toUpperCase() },
      { re: /\bpixel\s*(\d{1,2}\s*a?)\s*(pro xl|pro|xl|fold)?/i,
        fmt: m => 'Pixel '+upper(m[1])+(m[2]?' '+m[2].split(/\s+/).map(cap).join(' '):'') },
      { re: /\b(oppo)\s*([a-z]?\d{2,3}[a-z]*(?:\s*\d?g)?)/i,
        fmt: m => 'Oppo '+m[2].toUpperCase().replace(/\s+/g,'') },
      { re: /\b(?:moto|motorola)\s*(edge\s*\d+|g\d+\w*|\w+)/i,
        fmt: m => 'Moto '+m[1].split(/\s+/).map(cap).join(' ') },
      { re: /\bnothing\s*phone\s*(\w+)/i,      fmt: m => 'Nothing Phone '+m[1] },
      { re: /\bhmd\s*(\w+\+?)/i,               fmt: m => 'HMD '+cap(m[1]) },
    ];

    function detectDevice(text) {
      let best = null;
      DEVICE_PATTERNS.forEach(p => {
        const m = text.match(p.re);
        if (m && (best === null || m.index < best.index))
          best = { device: p.fmt(m).replace(/\s+/g,' ').trim(), index: m.index };
      });
      return best || { device: '', index: -1 };
    }

    // ── Repair jobs ───────────────────────────────────────────────
    const JOBS = [
      [/charging?\s*port\s*clean|c\/?p\s*clean|port\s*clean/i,       'Charging Port Clean'],
      [/charging?\s*port|charge\s*port|c\/?p\b/i,                    'Charging Port'],
      [/rear\s*housing/i,                                             'Rear Housing'],
      [/rear\s*glass|back\s*glass|b\/?g\b/i,                         'Rear Glass'],
      [/camera\s*glass|cam\s*glass|cam(?:era)?\s*lens|lens\s*protector/i, 'Camera Glass'],
      [/\bcamera\b|\bcam\b/i,                                         'Camera'],
      [/housing|frame/i,                                              'Housing'],
      [/\boled\b/i,                                                   'OLED'],
      [/\blcd\b/i,                                                    'LCD'],
      [/\bdigi(?:tizer)?\b/i,                                         'Digitizer'],
      [/\bscreen\b|\bscre+ne?\b|\bsceen\b|screne/i,                  'Screen'],
      [/amp\s*battery|battery\s*amp|\bbattery\b|\bbatt\b/i,          'Battery'],
      [/data\s*transfer/i,                                            'Data Transfer'],
      [/data\s*recover(?:y|ed)?/i,                                    'Data Recovery'],
      [/virus\s*clean|scam\s*clean|\bvirus\b|\bscam\b/i,             'Virus Clean'],
      [/factory\s*reset|\brestore\b/i,                                'Restore'],
      [/ear\s*piece|earpiece|\bspeaker\b/i,                           'Speaker'],
      [/power\s*button/i,                                             'Power Button'],
      [/sim\s*tray/i,                                                 'Sim Tray'],
      [/signal\s*flex/i,                                              'Signal Flex'],
      [/microphone|\bmic\b/i,                                         'Microphone'],
      [/\bwd\b|water\s*damaged?|liquid\s*damaged?/i,                  'Water Damage'],
    ];

    const NARRATIVE_CUTOFFS = /\b(call:|pin:|imei|cx\b|customer|opened? (?:the )?device|testing ok|tried|warned|quoted|happy to|will (?:be|drop|call|pick)|came (?:back|in)|did ?n.?t|was ?n.?t|does ?n.?t|is ?n.?t|no image|no touch|glitch|liquid damage indicators|no notes|paid|deposit|apple id|password|passcode|aware it)\b/i;

    function detectJobsIn(segment) {
      const raw = [];
      for (const [re, label] of JOBS) {
        const g = new RegExp(re.source,'gi'); let m;
        while ((m = g.exec(segment)) !== null) {
          raw.push({ label, index: m.index, len: m[0].length });
          if (m.index === g.lastIndex) g.lastIndex++;
        }
      }
      raw.sort((a,b) => a.index-b.index || b.len-a.len);
      const accepted = [];
      for (const j of raw) {
        if (accepted.some(a => j.index < a.index+a.len && a.index < j.index+j.len)) continue;
        accepted.push(j);
      }
      const seen = new Set();
      return accepted.filter(j => seen.has(j.label) ? false : seen.add(j.label)).map(j => j.label);
    }

    function detectJobs(body) {
      const cut  = body.search(NARRATIVE_CUTOFFS);
      let head   = (cut > 0 ? body.slice(0,cut) : body).replace(/\s+and\s+/gi,' + ');
      const primary = head.split(',')[0];
      let jobs = detectJobsIn(primary);
      if (!jobs.length) jobs = detectJobsIn(body);
      if (jobs.length > 1) jobs = jobs.filter(j => j !== 'Water Damage');
      if ((jobs.includes('OLED') || jobs.includes('LCD')) && jobs.includes('Screen'))
        jobs = jobs.filter(j => j !== 'Screen');
      return jobs;
    }

    // ── Name ──────────────────────────────────────────────────────
    const NAME_JUNK = /\b(call|text only|text|mob|ph|phone|cx|walkin|walk-in)\b[:.]?/gi;
    function detectName(line) {
      const dashIdx  = line.search(/\s*-\s*/);
      const phoneM   = line.match(/(?:\+?61[\s-]?|0)?\d(?:[\s-]?\d){6,11}/);
      const phoneIdx = phoneM ? line.indexOf(phoneM[0]) : -1;
      let cut = line.length;
      if (dashIdx  >= 0) cut = Math.min(cut, dashIdx);
      if (phoneIdx >= 0) cut = Math.min(cut, phoneIdx);
      let name = line.slice(0,cut)
        .replace(NAME_JUNK,'')
        .replace(/[-–—:\s]+$/,'')
        .replace(/\s+/g,' ').trim();
      return /^(walk\s*-?in)?$/i.test(name) ? 'Walk-in' : (name || 'Walk-in');
    }

    // ── Main ──────────────────────────────────────────────────────
    function parseNote(rawLine) {
      const line  = String(rawLine).replace(/\s+/g,' ').trim();
      const name  = detectName(line);
      const phone = findPhone(line);
      const email = firstEmail(line);

      let body = line.replace(/^\s*walk\s*-?in\b[\s:-]*/i,' ');
      if (name && name !== 'Walk-in') body = body.replace(name,' ');
      body = body
        .replace(/(?:\+?61[\s-]?|0)?\d(?:[\s-]?\d){6,11}/g,' ')
        .replace(EMAIL_RE,' ')
        .replace(/\$\s*\d+(?:\.\d+)?/g,' ')
        .replace(/\bpin:?\s*\d+/gi,' ')
        .replace(/\s+/g,' ').trim();

      const { device } = detectDevice(body);
      const jobs = detectJobs(body);

      let item;
      if (device && jobs.length)  item = device + ' ' + jobs.join(' + ');
      else if (device)            item = device;
      else if (jobs.length)       item = jobs.join(' + ');
      else                        item = body.replace(/^[-–—\s]+|[-–—\s]+$/g,'') || '(see note)';

      return { name, phone, email, item: item.replace(/\s+/g,' ').trim(), device, jobs, raw: rawLine.trim() };
    }

    return { parseNote };
  })();

  // ─────────────────────────────────────────────────────────────
  // COLUMN MAP  (0-based, tab-separated paste)
  // ─────────────────────────────────────────────────────────────
  const COL = { TICKET: 2, CASH: 4, EFTPOS: 5 };

  // ─────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────
  const DEFAULTS = { stepDelay: 350, stripWalkin: true, priceMode: 'sum', payMode: 'auto1', useNoteParser: true };
  function loadCfg() { try { return Object.assign({},DEFAULTS,JSON.parse(GM_getValue('sost_cfg','{}'))); } catch { return Object.assign({},DEFAULTS); } }
  function saveCfg(c) { GM_setValue('sost_cfg',JSON.stringify(c)); }
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
      position: fixed; bottom: 72px; left: 20px; width: 420px; background: #0f172a;
      color: #e2e8f0; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.7);
      font-family: 'Segoe UI',system-ui,sans-serif; font-size: 13px; z-index: 99998;
      border: 1px solid #1e293b; display: none; overflow: hidden;
      max-height: calc(100vh - 88px);
    }
    #sost-panel.open { display: flex; flex-direction: column; }
    #sost-header {
      background: linear-gradient(135deg,#14b8a6 0%,#0d9488 100%); padding: 14px 16px;
      font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px;
      flex: 0 0 auto;
    }
    #sost-header .sost-title { flex: 1; }
    #sost-ver {
      font-size: 10px; font-weight: 700; color: #ccfbf1; background: rgba(0,0,0,.22);
      border-radius: 20px; padding: 2px 8px; letter-spacing: .3px; white-space: nowrap;
    }
    #sost-close-btn {
      background: rgba(255,255,255,.2); border: none; color: #fff; width: 26px; height: 26px;
      border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; display: flex;
      align-items: center; justify-content: center;
    }
    #sost-close-btn:hover { background: rgba(255,255,255,.35); }
    #sost-tabs { display: flex; background: #0a1120; border-bottom: 1px solid #1e293b; flex: 0 0 auto; }
    .sost-tab { flex: 1; padding: 9px 0; text-align: center; font-size: 12px; font-weight: 600;
      cursor: pointer; color: #64748b; border-bottom: 2px solid transparent; user-select: none; }
    .sost-tab.active { color: #14b8a6; border-bottom-color: #14b8a6; }
    .sost-pane { display: none; padding: 14px; }
    .sost-pane.active { display: block; flex: 1 1 auto; min-height: 60px; overflow-y: auto; }
    .sost-pane::-webkit-scrollbar { width: 6px; }
    .sost-pane::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
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
    #sost-preview { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
    #sost-preview::-webkit-scrollbar { width: 4px; }
    #sost-preview::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
    .sost-section-h { font-size: 10px; font-weight: 800; letter-spacing: .8px; text-transform: uppercase;
      color: #64748b; margin: 4px 0 -2px; }
    .sost-job { background: #131f2e; border: 1px solid #1e293b; border-radius: 10px; padding: 9px 11px; }
    .sost-job.active { background: #06201d; border-color: #14b8a6; }
    .sost-job.done { background: #0a150a; border-color: #166534; opacity: .65; }
    .sost-job.existing { background: #1a1200; border-color: #78350f; opacity: .7; }
    .sost-job.manual { background: #160d1f; border-color: #6d28d9; }
    .sost-job.manual.active { border-color: #a855f7; }
    .sost-job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .sost-badge { border-radius: 6px; padding: 1px 7px; font-size: 10px; font-weight: 800; }
    .sost-badge.named  { background: #134e4a; color: #5eead4; }
    .sost-badge.walk   { background: #422006; color: #fdba74; }
    .sost-badge.exists { background: #78350f; color: #fcd34d; }
    .sost-badge.manual { background: #4c1d95; color: #c4b5fd; }
    .sost-job-name { font-size: 12.5px; font-weight: 700; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sost-job-total { margin-left: auto; font-size: 12px; font-weight: 700; color: #4ade80; }
    .sost-job-sub { font-size: 10.5px; color: #64748b; margin-bottom: 4px; }
    .sost-line { display: flex; gap: 6px; font-size: 11px; color: #94a3b8; padding: 2px 0; border-top: 1px solid #1e293b; }
    .sost-line:first-of-type { border-top: none; }
    .sost-line .ln-desc { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sost-line .ln-price { color: #4ade80; font-weight: 600; }
    .sost-line .ln-method { color: #64748b; font-size: 10px; background: #0f172a; border-radius: 4px; padding: 0 5px; }
    .sost-manual-note { font-size: 10px; color: #64748b; font-style: italic; margin-bottom: 5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sost-manual-input { width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #6d28d9;
      color: #e2e8f0; border-radius: 6px; padding: 5px 8px; font-size: 12px; outline: none; margin-top: 4px; }
    .sost-manual-input:focus { border-color: #a855f7; }
    .sost-manual-input::placeholder { color: #4c1d95; }
    #sost-prog-wrap { margin-top: 10px; }
    #sost-prog-bg { height: 5px; background: #1e293b; border-radius: 3px; overflow: hidden; }
    #sost-prog-bar { height: 100%; width: 0%; background: linear-gradient(90deg,#14b8a6,#0d9488); border-radius: 3px; transition: width .4s; }
    #sost-status { margin-top: 6px; font-size: 11.5px; color: #94a3b8; min-height: 16px; text-align: center; }
    .sost-divider { border: none; border-top: 1px solid #1e293b; margin: 12px 0; }
    .sost-note { color: #475569; font-size: 11px; line-height: 1.6; margin: 0; }
    .sost-note b { color: #5eead4; }
    .sost-row2 { display: flex; gap: 8px; } .sost-row2 > * { flex: 1; }
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
  fab.id = 'sost-fab'; fab.title = 'SOS POS Sales Loader'; fab.innerHTML = '🏷️';
  document.body.appendChild(fab);
  [400, 1200, 2500, 4500].forEach(t => setTimeout(positionFab, t));
  window.addEventListener('resize', () => setTimeout(positionFab, 100));

  const panel = document.createElement('div');
  panel.id = 'sost-panel';
  panel.innerHTML = `
    <div id="sost-header">
      <span>🏷️</span><span class="sost-title">Sales Loader</span>
      <span id="sost-ver">v…</span>
      <button id="sost-close-btn" title="Close">✕</button>
    </div>
    <div id="sost-tabs">
      <div class="sost-tab active" data-tab="build">🛠 Build</div>
      <div class="sost-tab" data-tab="results">📋 Results</div>
      <div class="sost-tab" data-tab="settings">⚙ Settings</div>
    </div>

    <!-- BUILD -->
    <div class="sost-pane active" id="sost-tab-build">
      <div id="sost-drop-zone" tabindex="0" title="Click then Ctrl+V to paste">
        <textarea id="sost-paste" tabindex="-1" aria-hidden="true"></textarea>
        <div class="dz-icon">📋</div>
        <div class="dz-main">Click here, then paste the day's rows</div>
        <div class="dz-sub">Named tickets first, walk-ins after, manual review last.</div>
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
    <div class="sost-pane" id="sost-tab-results">
      <div id="sost-results-empty">No tickets captured yet.</div>
      <table id="sost-results-table" style="display:none">
        <thead><tr><th>Ticket #</th><th>Name</th></tr></thead>
        <tbody id="sost-results-body"></tbody>
      </table>
      <div class="sost-btn-row" id="sost-results-actions" style="display:none">
        <button class="sost-btn sost-btn-primary sost-btn-sm" id="sost-copy-btn" style="flex:1">📋 Copy for Sheets</button>
        <button class="sost-btn sost-btn-muted sost-btn-sm" id="sost-results-clear">Clear</button>
      </div>
      <p class="sost-note" style="margin-top:8px">Ticket #s are <b>editable</b> — fix any before copying. The name is shown for reference; <b>Copy</b> outputs ticket numbers only (one per line).</p>
    </div>

    <!-- SETTINGS -->
    <div class="sost-pane" id="sost-tab-settings">
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
      <div class="sost-row2">
        <div class="sost-field">
          <label class="sost-label">Smart note parser</label>
          <select class="sost-select" id="sost-note-parser">
            <option value="yes">On — strips name/phone/email</option>
            <option value="no">Off — use raw description</option>
          </select>
        </div>
      </div>
      <button class="sost-btn sost-btn-primary sost-btn-sm" id="sost-save-cfg">Save settings</button>
      <hr class="sost-divider">
      <p class="sost-note">
        <b>Parser on:</b> name/phone/email stripped from description — only device + repair goes into SOSPOS.<br>
        <b>Manual items:</b> rows the parser can't resolve (no device, password in notes, etc.) are deferred — fill the description field then build them at the end.<br>
        <b>Existing:</b> rows where col C already has a ticket number are shown in orange and skipped.<br>
        <b>Columns:</b> C=ticket# · E=cash · F=eftpos · col after PIN = description.
      </p>
    </div>
  `;
  document.body.appendChild(panel);

  // Show the running version in the header badge (from body constant — survives
  // the manager's header-stripping, unlike GM_info / @version)
  (function () {
    const vEl = document.getElementById('sost-ver');
    if (vEl) { vEl.textContent = 'v' + SCRIPT_VERSION; vEl.title = 'Sales Loader version ' + SCRIPT_VERSION; }
  })();

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('sost-close-btn').addEventListener('click', () => panel.classList.remove('open'));
  document.querySelectorAll('.sost-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sost-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sost-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = panel.querySelector('#sost-tab-' + tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // settings wiring
  const $price = document.getElementById('sost-price-mode');
  const $delay = document.getElementById('sost-step-delay');
  const $strip = document.getElementById('sost-strip');
  const $pay   = document.getElementById('sost-pay-mode');
  const $noteParser = document.getElementById('sost-note-parser');
  $price.value = cfg.priceMode; $delay.value = cfg.stepDelay;
  $strip.value = cfg.stripWalkin ? 'yes' : 'no'; $pay.value = cfg.payMode;
  $noteParser.value = cfg.useNoteParser ? 'yes' : 'no';
  document.getElementById('sost-save-cfg').addEventListener('click', () => {
    cfg.priceMode = $price.value;
    cfg.stepDelay = Math.max(100, parseInt($delay.value,10) || DEFAULTS.stepDelay);
    cfg.stripWalkin  = $strip.value === 'yes';
    cfg.payMode      = $pay.value;
    cfg.useNoteParser = $noteParser.value === 'yes';
    saveCfg(cfg); setStatus('✓ Settings saved.');
    if (rawCache) doParse(rawCache);
  });

  // ─────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────
  let jobs = [], builtIdx = -1, rawCache = '', results = [];
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
  function num(v) { const n = parseFloat(String(v||'').replace(/[^0-9.]/g,'')); return isNaN(n)?0:n; }
  function priceFor(c,e) { return cfg.priceMode==='cash'?c:cfg.priceMode==='eftpos'?e:c+e; }
  function methodLabel(c,e) { if(c>0&&e>0) return `Split $${c}c/$${e}e`; if(c>0) return 'Cash'; if(e>0) return 'EFTPOS'; return '—'; }
  function isWalkin(desc) { return /^\s*walk[\s-]?in\b|^\s*walkin\b/i.test(desc); }

  function extractDescription(cols) {
    const pin = cols.findIndex(c => c.trim().toUpperCase() === 'PIN');
    if (pin >= 0 && cols[pin+1] && cols[pin+1].trim()) return cols[pin+1].trim();
    for (let i=cols.length-1; i>=0; i--) if (cols[i] && cols[i].trim()) return cols[i].trim();
    return '';
  }

  function stripWalk(d) {
    if (cfg.stripWalkin) d = d.replace(/^\s*walk[\s-]?in\s*[-–:]?\s*/i,'').trim();
    return d || '(item)';
  }

  // Detect rows where col C already has a real ticket number → skip
  function isExistingTicket(ticket) {
    return /^[A-Z]\d{3,}/.test((ticket||'').trim());
  }

  // Resolve description via Parser (when on) or simple split fallback.
  // Returns { name, phone, email, item, needsManual }
  // needsManual = true when the parser could not produce a clean item, or
  // when the note contains sensitive data (passwords) that must not go into SOSPOS.
  function resolveDesc(rawDesc) {
    if (!cfg.useNoteParser) {
      const ph = rawDesc.match(/0[\d\s-]{7,}/);
      if (ph) {
        const idx   = rawDesc.indexOf(ph[0]);
        const name  = rawDesc.slice(0,idx).replace(/[-–\s]+$/,'').trim();
        const after = rawDesc.slice(idx+ph[0].length).replace(/^\s*[-–:]\s*/,'').trim();
        return { name: name||'', phone: ph[0].trim(), email: '', item: after||rawDesc, needsManual: false };
      }
      return { name: '', phone: 'X', email: '', item: rawDesc, needsManual: false };
    }

    const r = Parser.parseNote(rawDesc);
    const item = r.item || '';
    // Flag for manual review: unresolvable item OR note contains credentials
    const needsManual = !item || item === '(see note)' || /password[\s:]/i.test(rawDesc);
    return { name: r.name||'', phone: r.phone||'X', email: r.email||'', item, needsManual };
  }

  // ─────────────────────────────────────────────────────────────
  // doParse
  // ─────────────────────────────────────────────────────────────
  const SKIP = /^(date|ticket|status|description|no\.?|google|balanced|fri|sat|sun|mon|tue|wed|thu|customer)$/i;

  function doParse(raw) {
    rawCache = raw;
    if (!raw) { setStatus('⚠️ Nothing pasted yet.'); return; }

    const namedMap = new Map(), walkMap = new Map(), manualMap = new Map(), existingList = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const cols  = line.split('\t');
      const desc  = extractDescription(cols);
      if (!desc || SKIP.test(desc.trim())) continue;

      const cash   = num(cols[COL.CASH]),  eftpos = num(cols[COL.EFTPOS]);
      const price  = priceFor(cash, eftpos);
      const ticket = (cols[COL.TICKET] || '').trim();

      // Skip rows that already have a real ticket number
      if (isExistingTicket(ticket)) {
        existingList.push({ ticket, desc });
        continue;
      }

      if (isWalkin(desc)) {
        const key = 'W:' + (ticket || 'Walk-in (no #)');
        const t   = ticket || 'Walk-in (no #)';
        if (!walkMap.has(key)) walkMap.set(key, { type:'walkin', ticket:t, items:[], total:0, totalCash:0, totalEftpos:0, status:'pending' });
        const g = walkMap.get(key);
        g.items.push({ desc: stripWalk(desc), price, cash, eftpos, method: methodLabel(cash,eftpos) });
        g.total += price; g.totalCash += cash; g.totalEftpos += eftpos;
      } else {
        const resolved = resolveDesc(desc);

        if (resolved.needsManual) {
          const key = 'M:' + (ticket || resolved.name || desc.slice(0,20));
          if (!manualMap.has(key)) manualMap.set(key, {
            type:'manual', ticket, rawNote: desc,
            customer: { name: resolved.name||'(unknown)', phone: resolved.phone||'X', email: resolved.email },
            items:[], total:0, totalCash:0, totalEftpos:0, status:'pending', manualDesc:'',
          });
          const g = manualMap.get(key);
          g.items.push({ desc:'', price, cash, eftpos, method: methodLabel(cash,eftpos) });
          g.total += price; g.totalCash += cash; g.totalEftpos += eftpos;
        } else {
          const key = 'N:' + (ticket || resolved.name);
          if (!namedMap.has(key)) namedMap.set(key, {
            type:'named', ticket,
            customer: { name: resolved.name||'(no name)', phone: resolved.phone||'X', email: resolved.email },
            items:[], total:0, totalCash:0, totalEftpos:0, status:'pending',
          });
          const g = namedMap.get(key);
          if ((!g.customer.name || g.customer.name==='(no name)') && resolved.name) g.customer = { name:resolved.name, phone:resolved.phone||'X', email:resolved.email };
          g.items.push({ desc: resolved.item||'(item)', price, cash, eftpos, method: methodLabel(cash,eftpos) });
          g.total += price; g.totalCash += cash; g.totalEftpos += eftpos;
        }
      }
    }

    const named   = Array.from(namedMap.values());
    const walk    = Array.from(walkMap.values());
    const manual  = Array.from(manualMap.values());
    jobs = [...named, ...walk, ...manual];
    builtIdx = -1; captured.clear();
    renderPreview(named.length, walk.length, manual.length, existingList);

    const buildable = named.length + walk.length + manual.length;
    if (buildable) {
      dropZone.classList.add('has-data');
      document.getElementById('sost-paste-summary').style.display = 'flex';
      document.getElementById('sost-count-badge').textContent = buildable;
      document.getElementById('sost-count-label').textContent =
        [named.length&&`${named.length} named`, walk.length&&`${walk.length} walk-in`, manual.length&&`${manual.length} manual`].filter(Boolean).join(' · ');
      const b = document.getElementById('sost-build-btn');
      b.style.display = 'block'; b.disabled = false;
      b.textContent = `▶ Start — Build 1/${buildable} (${labelOf(jobs[0])})`;
      document.getElementById('sost-clear-btn').style.display = 'block';
      setStatus('');
    } else if (existingList.length) {
      dropZone.classList.add('has-data');
      setStatus(`ℹ️ All ${existingList.length} rows have existing ticket numbers — nothing to build.`);
    } else {
      dropZone.classList.remove('has-data');
      setStatus('⚠️ No valid rows found — check column map in Settings.');
    }
  }

  function labelOf(job) {
    if (job.type==='named')  return job.customer.name;
    if (job.type==='walkin') return job.ticket;
    return job.customer.name + ' (manual)';
  }

  // ─────────────────────────────────────────────────────────────
  // renderPreview
  // ─────────────────────────────────────────────────────────────
  function renderPreview(nNamed, nWalk, nManual, existingList) {
    const html = [];
    let walkSeen = false;

    jobs.forEach((job, gi) => {
      if (job.type === 'walkin' && !walkSeen) {
        walkSeen = true;
        if (nWalk) html.push(`<div class="sost-section-h">Walk-ins — built after named (${nWalk})</div>`);
      }
      if (job.type === 'manual' && html[html.length-1] && !html[html.length-1].includes('manual')) {
        if (nManual) html.push(`<div class="sost-section-h">Needs manual description (${nManual})</div>`);
      }

      const badge = job.type==='named'  ? `<span class="sost-badge named">CX</span>`
                  : job.type==='walkin' ? `<span class="sost-badge walk">WALK</span>`
                  :                        `<span class="sost-badge manual">REVIEW</span>`;
      const title = job.type==='named'  ? esc(job.customer.name)
                  : job.type==='walkin' ? esc(job.ticket)
                  :                        esc(job.customer.name);
      const sub = (job.type==='named'||job.type==='manual')
        ? `<div class="sost-job-sub">☎ ${esc(job.customer.phone)}${job.customer.email?' · ✉ '+esc(job.customer.email):''}</div>`
        : '';

      let manualInput = '';
      if (job.type === 'manual') {
        manualInput = `
          <div class="sost-manual-note" title="${esc(job.rawNote)}">📋 ${esc(job.rawNote.slice(0,80))}${job.rawNote.length>80?'…':''}</div>
          <input class="sost-manual-input" data-gi="${gi}" placeholder="Enter device + repair description…" value="${esc(job.manualDesc)}">`;
      }

      html.push(`
        <div class="sost-job ${job.status}" id="sost-job-${gi}">
          <div class="sost-job-head">${badge}<span class="sost-job-name">${title}</span><span class="sost-job-total">$${job.total.toFixed(2)}</span></div>
          ${sub}
          ${manualInput}
          ${job.items.map(it => it.desc ? `<div class="sost-line"><span class="ln-desc">${esc(it.desc)}</span><span class="ln-method">${it.method}</span><span class="ln-price">$${it.price.toFixed(2)}</span></div>` : '').join('')}
        </div>`);
    });

    // Existing tickets section (orange, no action)
    if (existingList.length) {
      html.push(`<div class="sost-section-h">Existing tickets — skipped (${existingList.length})</div>`);
      for (const ex of existingList) {
        html.push(`
          <div class="sost-job existing">
            <div class="sost-job-head"><span class="sost-badge exists">EXISTS</span>
              <span class="sost-job-name">${esc(ex.ticket)}</span></div>
            <div class="sost-job-sub" style="font-size:10px;color:#78350f">${esc(ex.desc.slice(0,80))}${ex.desc.length>80?'…':''}</div>
          </div>`);
      }
    }

    if (!html.length) {
      document.getElementById('sost-preview').innerHTML = '';
      return;
    }
    if (nNamed) html.unshift(`<div class="sost-section-h">Named tickets — built first (${nNamed})</div>`);
    document.getElementById('sost-preview').innerHTML = html.join('');

    // Wire manual inputs → update job.manualDesc live
    document.querySelectorAll('.sost-manual-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const gi = Number(inp.dataset.gi);
        if (jobs[gi]) { jobs[gi].manualDesc = inp.value; jobs[gi].items.forEach(it => it.desc = inp.value || '(item)'); }
      });
    });
  }

  function esc(s) { return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  function clearAll() {
    jobs=[]; builtIdx=-1; rawCache=''; captured.clear();
    pasteArea.value='';
    document.getElementById('sost-preview').innerHTML='';
    document.getElementById('sost-build-btn').style.display='none';
    document.getElementById('sost-clear-btn').style.display='none';
    document.getElementById('sost-prog-bar').style.width='0%';
    dropZone.classList.remove('has-data');
    document.getElementById('sost-paste-summary').style.display='none';
    setStatus('');
  }

  function setStatus(m) { document.getElementById('sost-status').textContent = m; }
  function setJobStatus(i,s) { jobs[i].status=s; const el=document.getElementById(`sost-job-${i}`); if(el) el.className=`sost-job ${s}`; }
  function setProgress() {
    const done = jobs.filter(j=>j.status==='done').length;
    document.getElementById('sost-prog-bar').style.width = jobs.length?`${Math.round(done/jobs.length*100)}%`:'0%';
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
    if (mode === 'manual' && builtIdx >= 0) captureResult(builtIdx);

    // Find next buildable job (skip manual with no description)
    let toBuild = builtIdx + 1;
    while (toBuild < jobs.length && jobs[toBuild].type === 'manual' && !jobs[toBuild].manualDesc.trim()) {
      setJobStatus(toBuild, 'pending');
      toBuild++;
    }
    if (toBuild >= jobs.length) { finishAll(); return; }

    setJobStatus(toBuild, 'active');
    setStatus(`Building ${labelOf(jobs[toBuild])}…`);
    try {
      await buildJob(jobs[toBuild]);
      if (mode === 'auto1') { await payAndComplete(jobs[toBuild]); captureResult(toBuild); }
      setJobStatus(toBuild, 'done'); builtIdx = toBuild; setProgress();
      updateStepButton(mode);
    } catch (e) {
      setJobStatus(toBuild, 'pending'); buildBtn.disabled = false;
      setStatus('✕ ' + e.message); console.error('[SOS Loader]', e);
    }
  }

  function updateStepButton(mode) {
    buildBtn.disabled = false;
    // Find the next buildable job index
    let next = builtIdx + 1;
    while (next < jobs.length && jobs[next].type === 'manual' && !jobs[next].manualDesc.trim()) next++;
    const remaining = next < jobs.length;
    const totalNum  = builtIdx + 2;
    if (mode === 'auto1') {
      if (remaining) { buildBtn.textContent=`▶ Next (${totalNum}/${jobs.length})`; setStatus(`✓ Paid "${labelOf(jobs[builtIdx])}". Click for next.`); }
      else finishAll();
    } else {
      if (remaining) { buildBtn.textContent=`✓ Built — Checkout, then Next (${totalNum}/${jobs.length})`; setStatus(`Review & Checkout "${labelOf(jobs[builtIdx])}", then click for next.`); }
      else { buildBtn.textContent='✓ Built last — Checkout, then Finish'; setStatus('Checkout the last one, then click Finish.'); }
    }
  }

  async function runAll() {
    for (let i = builtIdx+1; i < jobs.length; i++) {
      if (jobs[i].type === 'manual' && !jobs[i].manualDesc.trim()) { setJobStatus(i,'pending'); continue; }
      setJobStatus(i,'active'); setStatus(`(${i+1}/${jobs.length}) ${labelOf(jobs[i])}…`);
      try {
        await buildJob(jobs[i]); await payAndComplete(jobs[i]);
        captureResult(i); setJobStatus(i,'done'); builtIdx=i; setProgress();
      } catch (e) {
        setJobStatus(i,'pending'); setStatus(`✕ Stopped at ${labelOf(jobs[i])}: ${e.message}`);
        console.error('[SOS Loader]', e); buildBtn.disabled=false;
        buildBtn.textContent=`▶ Resume from ${i+1}/${jobs.length}`; return;
      }
      await sleep(cfg.stepDelay + 400);
    }
    finishAll();
  }

  function finishAll() {
    const skippedManual = jobs.filter(j=>j.type==='manual'&&j.status!=='done').length;
    buildBtn.textContent = skippedManual ? `✓ Done — fill ${skippedManual} manual item${skippedManual>1?'s':''} then ▶` : '✓ All done';
    buildBtn.disabled = skippedManual === 0;
    if (skippedManual) { buildBtn.disabled = false; setStatus(`🎉 Auto-built done. Fill in the ${skippedManual} purple items above, then click ▶ again.`); }
    else { setStatus(`🎉 Finished — ${results.length} ticket${results.length!==1?'s':''} captured. See Results.`); switchTab('results'); }
  }

  // ─────────────────────────────────────────────────────────────
  // Build a single job (named, walk-in, or manual)
  // ─────────────────────────────────────────────────────────────
  async function buildJob(job) {
    const saleTab = findTab('Sale');
    if (saleTab) { saleTab.click(); await sleep(cfg.stepDelay); }

    if (job.type === 'named' || job.type === 'manual') {
      await createCustomer(job.customer);
    } else {
      const w = findWalkInButton();
      if (!w) throw new Error('Walk-in button not found');
      w.click(); await sleep(cfg.stepDelay + 150);
    }

    for (let k=0; k<job.items.length; k++) {
      if (k>0) { const a=findAddItemButton(); if(!a) throw new Error('"Add another item" not found'); a.click(); await sleep(cfg.stepDelay); }
      const descs=lineInputs('Item description'), prices=lineInputs('0.00');
      const d=descs[k], p=prices[k];
      if (!d||!p) throw new Error(`Line row ${k+1} fields not found`);
      setNativeValue(d, job.items[k].desc); await sleep(80);
      setNativeValue(p, String(job.items[k].price)); await sleep(cfg.stepDelay);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Payment
  // ─────────────────────────────────────────────────────────────
  function round2(x) { return Math.round(x*100)/100; }

  async function payAndComplete(job) {
    const checkoutBtn = findCheckoutButton();
    if (!checkoutBtn) throw new Error('Checkout button not found');
    if (checkoutBtn.disabled) throw new Error('Checkout button is disabled');
    checkoutBtn.click();
    const dialog = await waitFor(() => findCheckoutDialog(), 5000);
    if (!dialog) throw new Error('Checkout modal did not open');
    await sleep(cfg.stepDelay);

    const total = round2(job.total);
    let payCash=0, payEftpos=0;
    if (cfg.priceMode==='cash') payCash=total;
    else if (cfg.priceMode==='eftpos') payEftpos=total;
    else { payCash=round2(job.totalCash); payEftpos=round2(job.totalEftpos); }
    if (Math.abs((payCash+payEftpos)-total)>0.005) payEftpos=round2(total-payCash);

    if (total > 0) {
      const cashIn=splitInput(dialog,'Cash'), eftIn=splitInput(dialog,'EFTPOS');
      if (payCash>0)   { if(!cashIn) throw new Error('Cash split field not found');   setNativeValue(cashIn,payCash.toFixed(2));   await sleep(160); }
      if (payEftpos>0) { if(!eftIn)  throw new Error('EFTPOS split field not found');  setNativeValue(eftIn,payEftpos.toFixed(2)); await sleep(160); }
      await sleep(cfg.stepDelay);
    }

    const completeBtn = Array.from(dialog.querySelectorAll('button')).find(b=>/complete payment/i.test(b.textContent));
    if (!completeBtn) throw new Error('Complete Payment button not found');
    let tries=0;
    while (completeBtn.disabled && tries<12) { await sleep(150); tries++; }
    if (completeBtn.disabled) throw new Error('Complete Payment stayed disabled — modal left open for you');
    completeBtn.click();
    await waitFor(()=>!findCheckoutDialog(), 6000);
    await sleep(cfg.stepDelay+400);
  }

  // ─────────────────────────────────────────────────────────────
  // Create customer (with duplicate dialog handling)
  // ─────────────────────────────────────────────────────────────
  async function createCustomer(c) {
    const addBtn = findAddCustomerButton();
    if (!addBtn) throw new Error('Add-customer (+) button not found');
    addBtn.click();

    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
    if (!dialog) throw new Error('Add Customer dialog did not open');
    await sleep(cfg.stepDelay);

    // If dup dialog appeared immediately (unlikely but possible)
    if (isDupDialog(dialog)) { await handleDupDialog(dialog, c.phone); return; }

    const nameEl  = dialog.querySelector('input[placeholder="Customer name"]') || dialog.querySelector('input');
    const phoneEl = dialog.querySelector('input[placeholder="0400 000 000"]') || dialog.querySelectorAll('input')[1];
    const emailEl = dialog.querySelector('input[type="email"], input[placeholder="customer@example.com"]');

    if (nameEl)              { setNativeValue(nameEl,  c.name);          await sleep(90); }
    if (phoneEl)             { setNativeValue(phoneEl, c.phone || 'X');  await sleep(90); }
    if (emailEl && c.email)  { setNativeValue(emailEl, c.email);         await sleep(90); }
    await sleep(cfg.stepDelay);

    const createBtn = Array.from(dialog.querySelectorAll('button')).find(b=>/create customer/i.test(b.textContent));
    if (!createBtn) throw new Error('Create Customer button not found');
    if (createBtn.disabled) await sleep(300);
    createBtn.click();

    // Wait for either: dialog closes, OR dup dialog replaces it
    const which = await waitForEither(
      () => !document.querySelector('[role="dialog"]'),
      () => isDupDialog(document.querySelector('[role="dialog"]')),
      6000
    );

    if (which === 2) {
      const dupDialog = document.querySelector('[role="dialog"]');
      await handleDupDialog(dupDialog, c.phone);
    }

    await waitFor(() => !document.querySelector('[role="dialog"]'), 6000);
    await sleep(cfg.stepDelay);
  }

  function isDupDialog(d) {
    if (!d) return false;
    return d.textContent.includes('Possible duplicate') ||
      !!Array.from(d.querySelectorAll('button')).find(b => /create new anyway/i.test(b.textContent));
  }

  async function handleDupDialog(dialog, phone) {
    await sleep(200);
    const useButtons    = Array.from(dialog.querySelectorAll('button')).filter(b => /use this customer/i.test(b.textContent));
    const createAnyway  = Array.from(dialog.querySelectorAll('button')).find(b  => /create new anyway/i.test(b.textContent));

    if (!phone || phone === 'X') {
      // No real phone — create new
      if (createAnyway && !createAnyway.disabled) createAnyway.click();
    } else if (useButtons.length === 1) {
      // Exactly one match — use it automatically
      useButtons[0].click();
    } else if (useButtons.length > 1) {
      // Multiple matches — pause and let user pick
      setStatus('⚠️ Multiple customers found — please select one in the dialog.');
      buildBtn.disabled = false;
      await waitFor(() => !document.querySelector('[role="dialog"]'), 120000, 500);
    } else {
      // No use-this button — just create new
      if (createAnyway && !createAnyway.disabled) createAnyway.click();
    }
    await sleep(cfg.stepDelay);
  }

  // ─────────────────────────────────────────────────────────────
  // Results
  // ─────────────────────────────────────────────────────────────
  function captureResult(i) {
    if (captured.has(i)) return;
    captured.add(i);
    const job  = jobs[i];
    const name = job.type==='named'||job.type==='manual' ? job.customer.name : 'Walk-in';
    results.push({ ticket: latestTicket(), name });
    renderResults();
  }

  function latestTicket() {
    const set = new Set();
    document.querySelectorAll('td,span,div,a,button').forEach(el => {
      if (el.children.length) return;
      const t = el.textContent.trim();
      if (/^[A-Z]\d{3,6}$/.test(t)) set.add(t);
    });
    const arr = Array.from(set).map(t => ({ t, n: parseInt(t.replace(/\D/g,''),10) }));
    if (!arr.length) return '';
    arr.sort((a,b) => b.n-a.n);
    return arr[0].t;
  }

  function renderResults() {
    const body=document.getElementById('sost-results-body');
    const table=document.getElementById('sost-results-table');
    const empty=document.getElementById('sost-results-empty');
    const actions=document.getElementById('sost-results-actions');
    if (!results.length) { table.style.display='none'; actions.style.display='none'; empty.style.display='block'; return; }
    empty.style.display='none'; table.style.display='table'; actions.style.display='flex';
    body.innerHTML = results.map((r,i) => `
      <tr><td><input data-i="${i}" value="${esc(r.ticket)}" placeholder="A####"></td>
      <td class="sost-res-name">${esc(r.name)}</td></tr>`).join('');
    body.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { results[Number(inp.dataset.i)].ticket = inp.value; }));
  }

  document.getElementById('sost-copy-btn').addEventListener('click', () => {
    const tsv = results.map(r=>r.ticket).join('\n');
    navigator.clipboard.writeText(tsv).then(
      () => { const b=document.getElementById('sost-copy-btn'); const o=b.textContent; b.textContent='✓ Copied!'; setTimeout(()=>b.textContent=o,1500); },
      () => alert('Copy failed:\n\n'+tsv)
    );
  });
  document.getElementById('sost-results-clear').addEventListener('click', () => { results=[]; captured.clear(); renderResults(); });

  function switchTab(name) {
    document.querySelectorAll('.sost-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
    document.querySelectorAll('.sost-pane').forEach(p=>p.classList.toggle('active',p.id==='sost-tab-'+name));
  }

  // ─────────────────────────────────────────────────────────────
  // DOM helpers
  // ─────────────────────────────────────────────────────────────
  function findTab(label) { return Array.from(document.querySelectorAll('[role="tab"]')).find(t=>t.textContent.trim().toLowerCase().includes(label.toLowerCase())); }
  function findWalkInButton() { return document.querySelector('button[title*="Walk-in" i]') || Array.from(document.querySelectorAll('button')).find(b=>/walk[\s-]?in/i.test(b.getAttribute('title')||b.textContent||'')); }
  function findAddCustomerButton() { return Array.from(document.querySelectorAll('button')).find(b=>b.querySelector('svg.lucide-user-plus')); }
  function findAddItemButton() { return Array.from(document.querySelectorAll('button')).find(b=>/add another item/i.test(b.textContent.trim())); }
  function lineInputs(ph) { return Array.from(document.querySelectorAll(`input[placeholder="${ph}"]`)); }
  function findCheckoutButton() {
    return Array.from(document.querySelectorAll('button')).find(b=>
      !b.closest('[role="dialog"]') && /checkout/i.test(b.textContent.trim()) && !/move to board/i.test(b.textContent));
  }
  function findCheckoutDialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(d=>{ const h=d.querySelector('h2'); return h&&/checkout/i.test(h.textContent); });
  }
  function splitInput(dialog, labelText) {
    const lab = Array.from(dialog.querySelectorAll('label')).find(l=>l.textContent.trim()===labelText);
    if (!lab) return null;
    return (lab.parentElement||dialog).querySelector('input[type="number"]');
  }

  function setNativeValue(el, value) {
    const proto  = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;
    if (setter) setter.call(el,value); else el.value=value;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }

  function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
  async function waitFor(fn, timeout=4000, step=100) { const t0=Date.now(); while(Date.now()-t0<timeout){ const r=fn(); if(r) return r; await sleep(step); } return null; }
  async function waitForEither(fn1, fn2, timeout=6000, step=100) {
    const t0=Date.now();
    while(Date.now()-t0<timeout){ if(fn1()) return 1; if(fn2()) return 2; await sleep(step); }
    return 0;
  }

  // ─────────────────────────────────────────────────────────────
  // Position FAB next to app's own bottom-left buttons
  // ─────────────────────────────────────────────────────────────
  function positionFab() {
    let best=null, bestRight=-1;
    document.querySelectorAll('button,a,div,[role="button"]').forEach(el=>{
      if (el.id&&(el.id.startsWith('sost')||el.id.startsWith('sosw'))) return;
      if (el===fab||el===panel) return;
      const r=el.getBoundingClientRect();
      if (r.width<32||r.width>60) return;
      if (Math.abs(r.width-r.height)>12) return;
      if (r.bottom<window.innerHeight-110||r.bottom>window.innerHeight-3) return;
      if (r.left<2||r.left>340) return;
      if (r.right>bestRight) { bestRight=r.right; best=r; }
    });
    if (best&&bestRight<=400) { fab.style.left=Math.round(bestRight+12)+'px'; fab.style.bottom=Math.round(window.innerHeight-best.bottom)+'px'; }
    else { fab.style.left='224px'; fab.style.bottom='20px'; }
  }

})();
