/**
 *  SciTrue – content script (multi-card tray + streaming + full view)
 *  --------------------------------------------------------------------
 *  • Selection → “Evaluate” → POST /api/analyze_claim_stream
 *  • Quadruple-click empty area → input → “Evaluate”
 *  • Tray: fixed width (~18vw), vertical stacked cards, aligned
 *  • Card: dot + dynamic status + title (multi-line) + Details / ×
 *  • Full view: skeleton first, then progressive: Summary → Overall → Subclaims
 */

(() => {
  'use strict';

  const API_STREAM_URL = 'http://localhost:5002/api/analyze_claim_stream';
  const DEFAULT_K = 5;

  const PALETTE = {
    panelBg: '#0f1420',
    border:  '#22314b',
    text:    '#eaeef3',
    dimText: '#a7b4c7',
    accent:  '#3aa1ff',
    badgeBg: '#101b2d',
    badgeBr: '#36548b',
    cardBg:  '#0c1220',
  };

  const SUBCLAIM_BG_COLORS = [
    '#F7B7B7',
    '#E6E6FA',
    '#FFEFD5',
    '#F0FFFF',
    '#FFFAFA',
    '#FFF0F5',
    '#F5F5DC',
    '#FFE4C4',
    '#E0FFFF'
  ];

  const CONTRIBUTION_COLORS = {
    'corroborating': '#1F4307',
    'partially corroborating': '#34740A',
    'slightly corroborating': '#42930D',
    'contrasting': '#931C0D',
    'partially contrasting': '#CB4231',
    'slightly contrasting': '#E15F50',
    'inconclusive': 'black'
  };
  const colorForContribution = (txt) =>
    txt ? (CONTRIBUTION_COLORS[String(txt).toLowerCase()] || null) : null;

  // ---------- global on/off ----------
  let enabled = true;
  const jobs = new Map(); // id -> job

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.scitrueEnabled) return;
    enabled = !!changes.scitrueEnabled.newValue;
    if (!enabled) teardownAll();
  });
  chrome.storage.local.get({ scitrueEnabled: true }, (res) => {
    enabled = !!res.scitrueEnabled;
  });

  /* ------------------------------------------------------------------
   *  Shared runtime state
   * ----------------------------------------------------------------*/
  let actionBtn = null; // floating Evaluate button near selection
  let inputBox  = null; // resizable input panel
  let suppressNextMouseup = false;

  // ---- tray (singleton; hosts multiple cards) ----
  let trayRoot = null;
  function ensureTray() {
    if (!enabled) return null;
    if (trayRoot) return trayRoot;
    trayRoot = document.createElement('div');
    trayRoot.id = 'scitrue-tray';
    Object.assign(trayRoot.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      zIndex: 2147483646,
      maxHeight: '70vh',
      overflowY: 'auto',
      pointerEvents: 'auto',
      width: 'clamp(300px, 18vw, 380px)',
    });
    document.body.appendChild(trayRoot);
    return trayRoot;
  }

  const remove = (el) => { if (el) el.remove(); };
  const removeActionBtn = () => { remove(actionBtn); actionBtn = null; };
  const removeInputBox  = () => { remove(inputBox);  inputBox  = null;  };
  function removeTray() { if (trayRoot) { trayRoot.remove(); trayRoot = null; } }

  // Abort all jobs, close modals, remove cards & tray
  function teardownAll() {
    for (const job of jobs.values()) {
      try { job.controller?.abort(); } catch {}
      try { job.__modalBackdrop?.remove(); } catch {}
      try { job.__modalPanel?.remove(); } catch {}
      try { job.elements?.card?.remove(); } catch {}
    }
    jobs.clear();
    removeActionBtn();
    removeInputBox();
    removeTray();
  }

  // small helpers
  const safe = (x) => (x == null ? '' : String(x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])));
  function safeUrl(u) { try { return new URL(u, location.href).toString(); } catch { return '#'; } }

  /* ------------------------------------------------------------------
   *  Job model
   * ----------------------------------------------------------------*/
  let jobSeq = 0;
  function createJob(claimText, k = DEFAULT_K) {
    const id = `job_${Date.now()}_${++jobSeq}`;
    const ctrl = new AbortController();
    const job = {
      id, claimText, k,
      controller: ctrl,
      status: 'running',
      summaryHTML: '',
      overallText: '',
      subclaims: [],
      __full: null, __modalBackdrop: null, __modalPanel: null,
      elements: {}
    };
    renderJobCard(job);
    runJob(job).catch(() => {});
    jobs.set(id, job);
    return job;
  }

  function renderJobCard(job) {
    const tray = ensureTray();
    if (!tray) return;

    const card = document.createElement('div');
    Object.assign(card.style, {
      width: '100%',
      background: PALETTE.panelBg,
      color: PALETTE.text,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '10px 12px',
      borderBottom: `1px solid ${PALETTE.border}`,
      background: '#0b0f18',
    });

    const statusDot = document.createElement('span');
    Object.assign(statusDot.style, {
      width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block',
      background: '#3aa1ff', flex: '0 0 auto',
    });

    const statusText = document.createElement('div');
    Object.assign(statusText.style, { fontSize: '12px', opacity: 0.9, flex: '0 0 auto' });
    statusText.textContent = 'Analyzing…';

    const title = document.createElement('div');
    Object.assign(title.style, {
      fontSize: '13px',
      fontWeight: '600',
      flex: '1 1 auto',
      whiteSpace: 'normal',
      wordBreak: 'break-word',
      lineHeight: '1.35',
    });
    title.textContent = job.claimText;

    const btnDetails = document.createElement('button');
    btnDetails.textContent = 'Details';
    styleMiniBtn(btnDetails);

    {
      const btnClose = document.createElement('button');
      btnClose.textContent = '×';
      styleMiniBtn(btnClose);
      header.append(statusDot, statusText, title, btnDetails, btnClose);
      card.appendChild(header);
      tray.appendChild(card);

      btnDetails.onclick = () => openFullscreenModal(job);
      btnClose.onclick   = () => {
        try { job.controller.abort(); } catch {}
        try { job.__modalBackdrop?.remove(); } catch {}
        try { job.__modalPanel?.remove(); } catch {}
        card.remove();
        job.status = 'canceled';
        jobs.delete(job.id);
      };
    }

    job.elements = { card, header, statusDot, statusText, title, btnDetails };
  }

  function styleMiniBtn(btn) {
    Object.assign(btn.style, {
      fontSize: '12px', padding: '3px 8px', borderRadius: '8px',
      border: `1px solid ${PALETTE.badgeBr}`, background: PALETTE.badgeBg,
      color: PALETTE.text, cursor: 'pointer',
    });
    btn.onmouseenter = () => btn.style.opacity = '0.9';
    btn.onmouseleave = () => btn.style.opacity = '1';
  }

  function sanitizeSummaryHTML(raw) {
    if (!raw) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(raw), 'text/html');
    (function walk(node) {
      const kids = Array.from(node.childNodes);
      for (const child of kids) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName !== 'A') {
            child.replaceWith(document.createTextNode(child.textContent || ''));
            continue;
          }
          const href = child.getAttribute('href') || '';
          let ok = false, urlStr = '#';
          try {
            const u = new URL(href, location.href);
            if (/^https?:$/i.test(u.protocol)) { ok = true; urlStr = u.toString(); }
          } catch {}
          if (!ok) { child.replaceWith(document.createTextNode(child.textContent || '')); continue; }
          child.setAttribute('href', urlStr);
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
          child.style.color = PALETTE.accent;
          child.style.textDecoration = 'underline';
        }
      }
    })(doc.body);
    return doc.body.innerHTML;
  }

  /* ------------------------------------------------------------------
   *  Fullscreen modal – skeleton + progressive updates
   * ----------------------------------------------------------------*/
  function openFullscreenModal(job) {
    const { claimText } = job;

    try { job.__modalBackdrop?.remove(); } catch {}
    try { job.__modalPanel?.remove(); } catch {}
    job.__modalBackdrop = job.__modalPanel = null;

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,0.55)', zIndex: 2147483647 });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position:'fixed', inset:'4vh 2vw', background:'#0f1115', color:PALETTE.text,
      border:'1px solid #2a2f3a', borderRadius:'14px', boxShadow:'0 20px 60px rgba(0,0,0,0.45)',
      display:'flex', flexDirection:'column', zIndex: 2147483648
    });

    const header = document.createElement('div');
    Object.assign(header.style, { display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'10px 12px', borderBottom:'1px solid #2a2f3a' });

    const hLeft = document.createElement('div');
    hLeft.innerHTML = `<div style="font-size:15px;font-weight:700">SciTrue – Full View</div>
                       <div style="font-size:12px;opacity:.85;margin-top:2px;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(claimText)}</div>`;

    const btnClose = document.createElement('button');
    btnClose.textContent = '×';
    Object.assign(btnClose.style, {
      fontSize:'14px', padding:'6px 10px', borderRadius:'8px',
      border:`1px solid ${PALETTE.badgeBr}`, background: PALETTE.badgeBg,
      color: PALETTE.text, cursor:'pointer'
    });
    const closeAll = () => { try { backdrop.remove(); panel.remove(); } catch {} ; job.__modalBackdrop = job.__modalPanel = job.__full = null; };
    btnClose.onclick = closeAll;

    header.appendChild(hLeft); header.appendChild(btnClose);

    const body = document.createElement('div');
    Object.assign(body.style, { overflow:'auto', padding:'14px', height:'100%' });

    // skeleton shimmer
    const style = document.createElement('style');
    style.textContent = `
      @keyframes scitrue-skel { 0%{background-position:0 0;} 100%{background-position:-200% 0;} }
      .skel { background:linear-gradient(90deg,#1a1f2b,#10141e,#1a1f2b); background-size:200% 100%; animation:scitrue-skel 1.2s linear infinite; }
      .sc-link { color:#3aa1ff !important; text-decoration:underline !important; cursor:pointer }
    `;
    panel.appendChild(style);

    const sec = document.createElement('div');
    sec.innerHTML = `
      <section style="border:1px solid ${PALETTE.border};border-radius:10px;padding:12px;margin-bottom:12px;background:${PALETTE.panelBg}">
        <div style="font-weight:700;margin-bottom:6px">Summary</div>
        <div id="${job.id}_full_summary" style="line-height:1.6">
          ${job.summaryHTML ? '' : `<div class="skel" style="height:64px;border-radius:8px;"></div>`}
        </div>
      </section>
      <section style="border:1px solid ${PALETTE.border};border-radius:10px;padding:12px;margin-bottom:12px;background:${PALETTE.panelBg}">
        <div style="font-weight:700;margin-bottom:6px">Overall Verdict</div>
        <div id="${job.id}_full_overall" style="line-height:1.6">
          ${job.overallText ? '' : `<div class="skel" style="height:18px;width:60%;border-radius:6px;"></div>`}
        </div>
      </section>
      <section style="border:1px solid ${PALETTE.border};border-radius:10px;padding:12px;background:${PALETTE.panelBg}">
        <div style="font-weight:700;margin-bottom:6px">Subclaims</div>
        <div id="${job.id}_full_list" style="display:grid;gap:10px">
          ${job.subclaims.length ? '' : `<div class="skel" style="height:18px;border-radius:6px;"></div>`}
        </div>
      </section>
    `;
    body.appendChild(sec);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    const el = {
      summary: panel.querySelector(`#${job.id}_full_summary`),
      overall: panel.querySelector(`#${job.id}_full_overall`),
      list:    panel.querySelector(`#${job.id}_full_list`)
    };

    // sync cached data if already available
    if (job.summaryHTML)  el.summary.innerHTML = job.summaryHTML;
    if (job.overallText)  el.overall.textContent = job.overallText;
    if (job.subclaims.length) for (const sc of job.subclaims) appendSubclaimCard(el.list, sc, job.id);

    job.__modalBackdrop = backdrop;
    job.__modalPanel = panel;
    job.__full = el;
  }

  /* ------------------------------------------------------------------
   *  Subclaim card
   * ----------------------------------------------------------------*/
  function appendSubclaimCard(listEl, sc, jobId) {
    // ---------- helpers ----------
    const pick = (obj, keys, def='') => {
      for (const k of keys) {
        const v = obj?.[k];
        if (v != null && String(v).trim() !== '') return v;
      }
      return def;
    };
    const safe = (x) => (x == null ? '' : String(x).replace(/[&<>"]/g, c => (
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]
    )));
    const safeUrl = (u) => { try { return u ? new URL(u, location.href).toString() : ''; } catch { return ''; } };

    const link = (label, id) =>
      `<a href="#" data-toggle="${id}" class="sc-link">Show ${safe(label)}</a>`;

    const row = (label, valueHTML) => `
      <div style="margin-top:8px;background:rgba(255,255,255,0.03);padding:6px 8px;border-radius:6px">
        <span style="font-weight:700">${safe(label)}:</span> ${valueHTML}
      </div>`;

    const collapsible = (label, innerHTML) => {
      if (!innerHTML) return '';
      const id = `${label.replace(/\W+/g,'_')}_${Math.random().toString(36).slice(2,8)}`;
      return `
        <div style="margin-top:8px;background:rgba(255,255,255,0.03);padding:6px 8px;border-radius:6px">
          <span style="font-weight:700">${safe(label)}:</span>
          ${link(label, id)}
          <div id="${id}" style="display:none;margin-top:6px;line-height:1.55">${innerHTML}</div>
        </div>`;
    };

    const listify = (arr) => {
      if (!arr) return '';
      if (Array.isArray(arr)) return `<ul style="margin:6px 0 0 16px;padding:0">${arr.map(x=>`<li>${safe(x)}</li>`).join('')}</ul>`;
      return `<div>${safe(String(arr))}</div>`;
    };

    const renderSjr = (sjrObj) => {
      if (!sjrObj || typeof sjrObj !== 'object' || !Object.keys(sjrObj).length) return '';
      const rows = Object.entries(sjrObj).map(([k,v]) => {
        const isLink = typeof v === 'string' && /^https?:/i.test(v);
        const vHtml  = isLink
          ? `<a href="${safeUrl(v)}" target="_blank" rel="noopener noreferrer" class="sc-link">${safe(v)}</a>`
          : safe(v ?? '');
        return `<tr><td style="padding:4px 8px">${safe(k)}</td><td style="padding:4px 8px">${vHtml}</td></tr>`;
      }).join('');
      return collapsible('SJR', `<table style="border-collapse:collapse;border:1px solid ${PALETTE.badgeBr};border-radius:6px"><tbody>${rows}</tbody></table>`);
    };

    // ---------- read normalized fields ----------
    const title      = pick(sc, ['title']);
    const claimTxt   = pick(sc, ['claim']);
    const section    = pick(sc, ['section']);
    const paragraph  = pick(sc, ['paragraph']);
    const abstract   = pick(sc, ['abstract']);
    const url        = pick(sc, ['url']);
    const year       = pick(sc, ['year']);
    const relSent    = pick(sc, ['relevant_sentence','relevant sentence']);
    const label      = pick(sc, ['label']);
    const contributionText = pick(sc, ['contribution','stance_contribution'], '');

    const suppAss    = pick(sc, ['supporting assumptions']);
    const refuAss    = pick(sc, ['refuting assumptions']);

    const sjrObj     = sc.sjr;
    const relType    = pick(sc, ['relevant sentence type']);
    const funcReason = pick(sc, ['function_reason']);
    const relation   = pick(sc, ['relation']);
    const relReason  = pick(sc, ['relation_reason']);
    const bibtex     = pick(sc, ['bibtex']);

    // ---------- build card ----------
    const card = document.createElement('div');
    Object.assign(card.style, {
      border:`1px solid ${PALETTE.border}`,
      borderRadius:'10px',
      padding:'10px 12px',
      background: SUBCLAIM_BG_COLORS[(sc.index ?? 0) % SUBCLAIM_BG_COLORS.length],
      fontSize:'13px',
      transition: 'transform .08s ease',
    });
    card.style.setProperty('color', '#000', 'important');
    card.onmouseenter = () => { card.style.transform = 'translateY(-1px)'; };
    card.onmouseleave = () => { card.style.transform = 'none'; };

    const n = (sc.index ?? 0) + 1;

    // header
    const badgeId = `sc_badge_${jobId}_${sc.index ?? 0}`;
    const badgeColor = colorForContribution(contributionText) || '#444';
    const headHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-weight:700;font-size:16px">Subclaim ${n}</div>
          <div id="${badgeId}"
               style="display:${contributionText ? 'inline-block' : 'none'};
                      font-size:12px;padding:3px 10px;border-radius:999px;font-weight:600;
                      background:#fff !important;
                      border:1.5px solid ${badgeColor} !important;
                      color:${badgeColor} !important;">
               ${safe(contributionText)}
          </div>
        </div>
        <!-- Open 按钮已移除 -->
      </div>
    `;

    // rows
    const rowsHTML =
        (claimTxt ? row('Claim', safe(claimTxt)) : '')
      + (title ? row('Title', safe(title)) : '')
      + (year ? row('Year', safe(year)) : '')
      + (url ? row('URL', `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" class="sc-link">${safe(url)}</a>`) : '')
      + (paragraph ? collapsible('Paragraph', `<div>${safe(paragraph)}</div>`) : '')
      + (abstract ? collapsible('Abstract', `<div>${safe(abstract)}</div>`) : '')
      + (relSent ? row('Relevant Sentence', safe(relSent)) : '')
      + (label ? row('Label', safe(label)) : '')
      + (suppAss ? collapsible('Supporting Assumptions', listify(suppAss)) : '')
      + (refuAss ? collapsible('Refuting Assumptions', listify(refuAss)) : '')
      + renderSjr(sjrObj)
      + ((relType || funcReason)
          ? collapsible('Context', `<div>The source is highly likely contributing <strong>${safe(relType||'—')}</strong> of the study. ${safe(funcReason||'')}</div>`)
          : '')
      + ((relation || relReason)
          ? collapsible('Claim/Article Relation', `<div>The claim article relationship is <strong>${safe(relation||'—')}</strong> – ${safe(relReason||'')}</div>`)
          : '')
      + (bibtex ? collapsible('BibTeX', `<pre style="white-space:pre-wrap;margin:0">${safe(bibtex)}</pre>`) : '');

    card.innerHTML = headHTML + rowsHTML;

    card.querySelectorAll('a[data-toggle]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.getAttribute('data-toggle');
        const panel = card.querySelector(`#${id}`);
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        a.textContent = (visible ? 'Show ' : 'Hide ') + a.textContent.replace(/^Show |^Hide /,'');
      });
    });

    listEl.appendChild(card);
  }

  /* ------------------------------------------------------------------
   *  Stream runner per job
   * ----------------------------------------------------------------*/
  async function runJob(job) {
    const { controller } = job;
    const { statusDot, statusText, btnDetails } = job.elements;

    let errored = false;
    let invalid = false;

    setStatus('Analyzing…');

    try {
      const res = await fetch(API_STREAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim: job.claimText, k: job.k }),
        signal: controller.signal
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;

          let msg = null;
          try { msg = JSON.parse(line); } catch {}
          if (!msg || invalid) continue;

          switch (msg.type) {
            case 'status': setStatus(msg.message || ''); break;

            case 'start':
              statusDot.style.background = '#3aa1ff';
              setStatus('Fetching evidence…');
              break;

            case 'articles': {
              const n = msg.count ?? 0;
              setStatus(`Articles: ${n}`);
              if (!n) { markInvalid(); invalid = true; }
              break;
            }

            case 'summary': {
              const html = sanitizeSummaryHTML(msg.html || '');
              job.summaryHTML = html;
              if (job.__full) job.__full.summary.innerHTML = html || '';
              setStatus('Summary ready');
              break;
            }

            case 'summary_chunk': {
              const chunk = sanitizeSummaryHTML(msg.html || '') + ' ';
              job.summaryHTML += chunk;
              if (job.__full) job.__full.summary.innerHTML = job.summaryHTML;
              break;
            }

            case 'overall_reason': {
              job.overallText = msg.text || '';
              if (job.__full) job.__full.overall.textContent = job.overallText;
              setStatus('Verdict ready');
              break;
            }

            case 'subclaim': {
              if (msg.data) {
                job.subclaims.push(msg.data);
                if (job.__full) appendSubclaimCard(job.__full.list, msg.data, job.id);
                setStatus(`Adding subclaims… (${job.subclaims.length})`);
              }
              break;
            }

            case 'subclaim_update': {
              const i = msg.index ?? 0;
              const data = msg.data || {};
              const contrib = (data.contribution || '').trim();
              job.subclaims[i] = { ...(job.subclaims[i] || {}), contribution: contrib };

              if (job.__full) {
                const badge = job.__full.list.querySelector(`#sc_badge_${job.id}_${i}`);
                if (badge) {
                  if (contrib) {
                    const color = colorForContribution(contrib) || '#444';
                    badge.textContent = contrib;
                    badge.style.display = 'inline-block';
                    badge.style.setProperty('border-color', color, 'important');
                    badge.style.setProperty('color', color, 'important');
                    badge.style.setProperty('background', '#fff', 'important');
                  } else {
                    badge.style.display = 'none';
                  }
                }
              }
              break;
            }

            case 'error':
              errored = true;
              markInvalid();
              invalid = true;
              break;

            case 'done':
              if (!invalid && !errored) {
                job.status = 'done';
                statusDot.style.background = '#2ecc71';
                setStatus('Completed');
              }
              break;
          }
        }
      }
    } catch {
      if (job.status !== 'canceled') { markInvalid(); }
    }

    function setStatus(t){ statusText.textContent = t; }
    function markInvalid() {
      job.status = 'error';
      statusDot.style.background = '#e74c3c';
      setStatus('Invalid Claim');
      if (btnDetails) { btnDetails.style.display = 'none'; btnDetails.onclick = null; }
    }
  }

  /* ------------------------------------------------------------------
   *  Evaluate button near selection
   * ----------------------------------------------------------------*/
  function makeFancyBtn(label, floating = true) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      padding:'4px 10px', fontSize:'12px', fontWeight:'500', letterSpacing:'0.2px',
      color:'#fff', background:'linear-gradient(135deg,#1e90ff 0%,#0069ff 100%)',
      border:'1px solid rgba(255,255,255,0.25)', borderRadius:'9999px',
      boxShadow:'0 4px 10px rgba(0,0,0,0.20)', cursor:'pointer',
      transition:'transform 0.12s ease, box-shadow 0.12s ease',
      zIndex:9999, userSelect:'none', position: floating ? 'absolute' : 'static'
    });
    btn.onmouseenter = () => { btn.style.boxShadow = '0 6px 14px rgba(0,0,0,0.25)'; btn.style.transform = 'translateY(-1px)'; };
    btn.onmouseleave = () => { btn.style.boxShadow = '0 4px 10px rgba(0,0,0,0.20)'; btn.style.transform = 'none'; };
    if (floating) { btn.onmousedown = () => (btn.style.transform = 'translateY(1px)');
                    btn.onmouseup   = () => (btn.style.transform = 'translateY(-1px)'); }
    return btn;
  }

  function createActionBtn(x, y, selectedText) {
    if (!enabled) return;
    removeActionBtn();
    const btn = (actionBtn = makeFancyBtn('Evaluate'));
    Object.assign(btn.style, { top: `${y}px`, left: `${x}px` });
    btn.onclick = () => {
      suppressNextMouseup = true;
      removeActionBtn();
      try { window.getSelection().removeAllRanges(); } catch {}
      ensureTray();
      createJob(selectedText);
    };
    document.body.appendChild(btn);
  }

  /* ------------------------------------------------------------------
   *  Resizable input panel (quadruple-click anywhere)
   * ----------------------------------------------------------------*/
  function renderInputBox(px, py) {
    if (!enabled) return;
    removeInputBox();

    const box = document.createElement('div');
    inputBox = box;
    Object.assign(box.style, {
      position: 'absolute',
      top: `${py}px`,
      left: `${px}px`,
      resize: 'horizontal',
      overflow: 'hidden',
      width: '520px',
      minWidth: '380px',
      maxWidth: '80vw',
      height: '52px',
      padding: '12px 14px',
      background: '#111',
      color: '#fff',
      border: '1px solid #444',
      borderRadius: '10px',
      boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
        fontSize: '16px',
        border: '1px solid #444',
        borderRadius: '6px',
        background: '#222',
        color: '#bbb',
        cursor: 'pointer',
        padding: '0 8px',
        flex: '0 0 auto'
    });
    closeBtn.onclick = () => removeInputBox();

    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.wrap = 'off';
    Object.assign(textarea.style, {
      flex: '1 1 auto',
      minWidth: '120px',
      height: '28px',
      resize: 'none',
      overflowY: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      padding: '2px 8px',
      fontSize: '14px',
      lineHeight: '20px',
      border: '1px solid #555',
      borderRadius: '6px',
      background: '#fff',
      color: '#000',
    });
    textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

    const evalBtn = makeFancyBtn('Evaluate', false);
    Object.assign(evalBtn.style, { flex: '0 0 auto' });
    evalBtn.onclick = () => {
      if (!enabled) return;
      const val = textarea.value.trim();
      if (!val) { textarea.style.border = '1px solid #ff5555'; textarea.focus(); return; }
      removeInputBox(); ensureTray(); createJob(val);
    };

    box.appendChild(textarea);
    box.appendChild(evalBtn);
    box.appendChild(closeBtn);
    document.body.appendChild(box);

    const r = box.getBoundingClientRect();
    if (r.right  > window.innerWidth)  box.style.left = `${window.innerWidth  - r.width  - 12}px`;
    if (r.bottom > window.innerHeight) box.style.top  = `${window.innerHeight - r.height - 12}px`;
  }

  /* ------------------------------------------------------------------
   *  Selection & click hooks
   * ----------------------------------------------------------------*/
  document.addEventListener('mouseup', () => {
    if (!enabled) { removeActionBtn(); return; }
    if (suppressNextMouseup) { suppressNextMouseup = false; removeActionBtn(); return; }
    setTimeout(() => {
      if (!enabled) return;
      const sel  = window.getSelection();
      const text = sel.toString().trim();
      if (!text || !sel.rangeCount) { removeActionBtn(); return; }
      if (inputBox) {
        let node = sel.getRangeAt(0).commonAncestorContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
        if (inputBox.contains(node)) { removeActionBtn(); return; }
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      createActionBtn(rect.right + window.scrollX + 12, rect.top + window.scrollY, text);
    }, 10);
  }, true);

  document.addEventListener('click', (e) => {
    if (!enabled) return;
    if (e.detail === 4) {
      e.preventDefault();
      try { window.getSelection().removeAllRanges(); } catch {}
      removeActionBtn();
      renderInputBox(e.pageX + 12, e.pageY);
    }
  }, true);

})();
