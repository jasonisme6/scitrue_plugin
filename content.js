/**
 *  SciTrue – content script (floating, draggable cards with inline details)
 *  --------------------------------------------------------------------
 *  • Selection → “Evaluate” → POST /api/analyze_claim_stream (NDJSON)
 *  • Quadruple-click empty area → input → “Evaluate”
 *  • Each Evaluate spawns a draggable card at click location
 *  • Card: dot + dynamic status + title (multi-line) + Show/Hide Details / ×
 *  • Details expand inside the same card (scrollable): Summary → Overall → Subclaims
 *  • Cards are resizable only when details are expanded
 */

(() => {
  'use strict';

  const API_STREAM_URL = 'https://www.scitrue.org/api/analyze_claim_stream';

  let settings = { k: 5, relation: 'relevant', mainfinding: false, userEmail: '', year: 'All Years' };
  chrome.storage.local.get(
  { scitrueK: 5, scitrueRelation: 'relevant', scitrueMainfinding: false, scitrueEnabled: true, scitrueUserEmail: '', scitrueYear: 'All Years' },
  (res) => {
    enabled = !!res.scitrueEnabled && !!res.scitrueUserEmail;
    settings = {
      k: Math.max(1, Math.min(15, Number(res.scitrueK) || 5)),
      relation: String(res.scitrueRelation || 'relevant'),
      mainfinding: !!res.scitrueMainfinding,
      userEmail: String(res.scitrueUserEmail || ''),
      year: String(res.scitrueYear || 'All Years')
    };
    if (!enabled) teardownAll();
  }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // enabled now depends on both toggle and userEmail presence
  if (changes.scitrueEnabled || changes.scitrueUserEmail) {
    const on = (changes.scitrueEnabled?.newValue ?? enabled) && !!(changes.scitrueUserEmail?.newValue ?? settings.userEmail);
    enabled = !!on;
    if (!enabled) teardownAll();
  }

  if (changes.scitrueK || changes.scitrueRelation || changes.scitrueMainfinding || changes.scitrueUserEmail || changes.scitrueYear) {
  const scitrueK           = changes.scitrueK?.newValue ?? settings.k;
  const scitrueRelation    = changes.scitrueRelation?.newValue ?? settings.relation;
  const scitrueMainfinding = changes.scitrueMainfinding?.newValue ?? settings.mainfinding;
  const scitrueUserEmail   = changes.scitrueUserEmail?.newValue ?? settings.userEmail;
  const scitrueYear        = changes.scitrueYear?.newValue ?? settings.year;
  settings = {
    k: Math.max(1, Math.min(15, Number(scitrueK) || 5)),
    relation: String(scitrueRelation || 'relevant'),
    mainfinding: !!scitrueMainfinding,
    userEmail: String(scitrueUserEmail || ''),
    year: String(scitrueYear || 'All Years')
  };
  }

  });

  // Fixed widths
  const COLLAPSED_WIDTH_CSS = 'clamp(320px, 26vw, 520px)';
  const EXPANDED_WIDTH_PX   = 720;

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
        '#E6E6FA', '#FFEFD5', '#F0FFFF', '#F7B7B7', '#E0FFE0',
        '#FFF0F5', '#F5F5DC', '#FFE4C4', '#E0FFFF', '#FFFACD'
  ];

  const CONTRIBUTION_COLORS = {
        'completely supports': '#32CD32',
        'conditionally supports': '#9ACD32',
        'completely refutes': '#931C0D',
        'conditionally refutes': '#F08080',
  };
  const colorForContribution = (txt) =>
    txt ? (CONTRIBUTION_COLORS[String(txt).toLowerCase()] || null) : null;

  let enabled = false;
  const jobs = new Map();

  let actionBtn = null;
  let inputBox  = null;
  let suppressNextMouseup = false;

  const remove = (el) => { if (el) el.remove(); };
  const removeActionBtn = () => { remove(actionBtn); actionBtn = null; };
  const removeInputBox  = () => { remove(inputBox);  inputBox  = null;  };

  function teardownAll() {
    for (const job of jobs.values()) {
      try { job.controller?.abort(); } catch {}
      try { job.__details?.remove(); } catch {}
      try { job.elements?.card?.remove(); } catch {}
    }
    jobs.clear();
    removeActionBtn();
    removeInputBox();
  }

  const safe = (x) => (x == null ? '' : String(x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])));

  function ensureGlobalStyles() {
    if (document.getElementById('scitrue-global-styles')) return;
    const s = document.createElement('style');
    s.id = 'scitrue-global-styles';
    s.textContent = `
        .scitrue-details{scrollbar-width:thin;scrollbar-color:#2a3448 transparent;}
        .scitrue-details::-webkit-scrollbar{width:4px;height:4px}
        .scitrue-details::-webkit-scrollbar-track{background:transparent}
        .scitrue-details::-webkit-scrollbar-thumb{background:#2a3448;border-radius:4px}
        .scitrue-subclaim{padding-top:0}
        .scitrue-subclaim .sc-row{margin-top:0}
        .scitrue-subclaim .sc-row + .sc-row{margin-top:6px}
    `;
    document.head.appendChild(s);
  }

  function makeDraggable(panel, handle, opts = {}) {
    let dragging = false, dx = 0, dy = 0;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (opts.ignore && opts.ignore(e)) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
      e.preventDefault();
    };
    const onMouseMove = (e) => {
      if (!dragging) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = panel.getBoundingClientRect();
      const left = clamp(e.clientX - dx, 8, vw - rect.width - 8);
      const top  = clamp(e.clientY - dy, 8, vh - rect.height - 8);
      panel.style.left = `${left + window.scrollX}px`;
      panel.style.top  = `${top + window.scrollY}px`;
    };
    const onMouseUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };

    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', onMouseDown, true);
  }

  let jobSeq = 0;
  function createJob(claimText, k = settings.k, pos = null) {
    const id = `job_${Date.now()}_${++jobSeq}`;
    const controller = new AbortController();
    const job = {
      id, claimText, k, controller,
      status: 'running',
      summaryHTML: '',
      overallText: '',
      verdictColor: '',
      subclaims: [],
      articlesCount: settings.k,
      infoMessage: '',
      elements: {},
      __details: null,
      __full: null,
      expanded: false,
      initialPos: pos,
      collapsedHeight: null,
      collapsedWidthCSS: COLLAPSED_WIDTH_CSS
    };
    renderJobCard(job);
    runJob(job).catch(() => {});
    jobs.set(id, job);
    return job;
  }

  function renderJobCard(job) {
    const card = document.createElement('div');
    card.className = 'scitrue-card';
    Object.assign(card.style, {
      position: 'absolute',
      left: `${(job.initialPos?.x ?? (window.scrollX + window.innerWidth - 420 - 16))}px`,
      top:  `${(job.initialPos?.y ?? (window.scrollY + window.innerHeight - 220 - 16))}px`,
      width: COLLAPSED_WIDTH_CSS,
      minWidth: '300px',
      minHeight: '64px',
      background: PALETTE.panelBg,
      color: PALETTE.text,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      overflow: 'hidden',
      zIndex: 2147483646,
      userSelect: 'auto',
      display: 'flex',
      flexDirection: 'column',
      resize: 'none'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '10px 12px',
      borderBottom: `1px solid ${PALETTE.border}`,
      background: '#0b0f18',
      flex: '0 0 auto'
    });

    const statusDot = document.createElement('span');
    Object.assign(statusDot.style, {
      width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block',
      background: '#3aa1ff', flex: '0 0 auto'
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
      lineHeight: '1.35'
    });
    title.textContent = job.claimText;

    const btnDetails = document.createElement('button');
    btnDetails.textContent = 'Show Details';
    styleMiniBtn(btnDetails);
    btnDetails.style.display = 'none';

    const btnClose = document.createElement('button');
    btnClose.textContent = '×';
    styleMiniBtn(btnClose);

    header.append(statusDot, statusText, title, btnDetails, btnClose);
    card.appendChild(header);

    const infoBar = document.createElement('div');
    Object.assign(infoBar.style, {
      borderTop: `1px solid ${PALETTE.border}`,
      padding: '8px 12px',
      fontSize: '12px',
      color: PALETTE.dimText,
      background: 'transparent',
      display: 'block'
    });
    const k = job.k || settings.k;
    const minSec = 3 * k;
    const maxSec = 5 * k + 8;
    infoBar.textContent = `The process usually takes between ${minSec} and ${maxSec} seconds for ${k} papers.`;
    job.infoMessage = infoBar.textContent;
    card.appendChild(infoBar);

    document.body.appendChild(card);

    refreshCollapsedSize(job);

    btnDetails.onclick = () => toggleDetails(job);
    btnClose.onclick   = () => {
      try { job.controller.abort(); } catch {}
      try { job.__details?.remove(); } catch {}
      card.remove();
      job.status = 'canceled';
      jobs.delete(job.id);
    };

    makeDraggable(card, header);
    job.elements = { card, header, statusDot, statusText, title, btnDetails, infoBar };
  }

  function styleMiniBtn(btn) {
    Object.assign(btn.style, {
      fontSize: '12px', padding: '3px 8px', borderRadius: '8px',
      border: `1px solid ${PALETTE.badgeBr}`, background: PALETTE.badgeBg,
      color: PALETTE.text, cursor: 'pointer'
    });
    btn.onmouseenter = () => btn.style.opacity = '0.9';
    btn.onmouseleave = () => btn.style.opacity = '1';
  }

  // Collapsed size helpers
  function refreshCollapsedSize(job) {
    const els = job.elements || {};
    const card   = els.card;
    const infoBar= els.infoBar;
    if (!card || !infoBar) return;

    const prevDisplay = infoBar.style.display;
    infoBar.style.display = 'block';

    card.style.resize = 'none';
    card.style.height = 'auto';
    void card.offsetHeight;
    job.collapsedHeight = Math.max(card.offsetHeight, 64);

    infoBar.style.display = prevDisplay || 'block';
  }

  // Info bar helpers
  function setInfoMessage(job, kind) {
    const { infoBar } = job.elements || {};
    if (!infoBar) return;

    let msg = job.infoMessage || '';
    switch (kind) {
      case 'fetching':
        const k = job.k || settings.k;
        const minSec = 3 * k;
        const maxSec = 5 * k + 8;
        msg = `The process usually takes between ${minSec} and ${maxSec} seconds for ${k} papers.`; break;
      case 'summary':
        msg = 'Evidence collection has finished. You may click "Show Details" to view.'; break;
      case 'completed':
        msg = 'Your process has fully completed. Click "Show Details" to see the report.'; break;
      case 'invalid':
        msg = 'Your claim is not a valid scientific claim. Please try a different claim.'; break;
      case 'credit':
        msg = 'User reached the maximum credits.'; break;
      case 'exception':
        msg = 'Something is wrong with the system, please contact the developers for support.'; break;
      default: break;
    }
    job.infoMessage = msg;
    infoBar.textContent = msg;

    if (!job.expanded) refreshCollapsedSize(job);
  }

  function sanitizeSummaryHTML(raw) {
    if (!raw) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(raw), 'text/html');

    const ALLOWED_TAGS = new Set([
      'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'P', 'DIV', 'BR', 'UL', 'OL', 'LI'
    ]);

    (function walk(node) {
      const kids = Array.from(node.childNodes);
      for (const child of kids) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toUpperCase();

          if (!ALLOWED_TAGS.has(tag)) {
            while (child.firstChild) {
              node.insertBefore(child.firstChild, child);
            }
            node.removeChild(child);
            continue;
          }

          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
              child.removeAttribute(attr.name);
            }
          }

          if (tag === 'A') {
            const href = child.getAttribute('href') || '';
            let ok = false, urlStr = '#';
            try {
              const u = new URL(href, location.href);
              if (/^https?:/i.test(u.protocol)) { ok = true; urlStr = u.toString(); }
            } catch {}
            if (!ok) {
              child.replaceWith(document.createTextNode(child.textContent || ''));
              continue;
            }
            child.setAttribute('href', urlStr);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
            child.style.color = PALETTE.accent;
            child.style.textDecoration = 'underline';
          }

          walk(child);
        }
      }
    })(doc.body);

    return doc.body.innerHTML;
  }

function ensureSubclaimVisible(job, index) {
  if (!job.__full) {
    toggleDetails(job);
  }
  if (!job.__full || !job.__full.list) return;

  const listEl = job.__full.list;
  const cards = Array.from(listEl.children);
  if (!cards.length || index < 0 || index >= cards.length) return;

  let targetCard = null;

  cards.forEach((card, i) => {
    const header = card.firstElementChild;
    const body   = card.lastElementChild;
    if (!header || !body) return;

    const isOpen = body.style.display !== 'none';

    if (i === index) {
      targetCard = card;
      if (!isOpen) {
        header.click();
      }
    } else {
      if (isOpen) {
        header.click();
      }
    }
  });

  if (!targetCard) return;

  const details = job.__details;
  if (details) {
    const offsetTop = targetCard.offsetTop;
    details.scrollTo({
      top: Math.max(offsetTop - 12, 0),
      behavior: 'smooth'
    });
  } else {
    const rect = targetCard.getBoundingClientRect();
    window.scrollTo({
      top: window.scrollY + rect.top - 80,
      behavior: 'smooth'
    });
  }

  targetCard.style.outline = '2px solid #ff9800';
  setTimeout(() => {
    targetCard.style.outline = '';
  }, 1200);
}


  function wireSummaryClicks(job) {
    if (!job.__full || !job.__full.summary) return;
    const root = job.__full.summary;
    const chunks = root.querySelectorAll('.summary-chunk[data-idx]');
    if (!chunks.length) return;

    chunks.forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idxStr = el.getAttribute('data-idx');
        const idx = idxStr ? parseInt(idxStr, 10) : NaN;
        if (!Number.isFinite(idx)) return;
        ensureSubclaimVisible(job, idx);
      });
    });
  }



function applyVerdictColor(job) {
  const c = job.verdictColor || '#000000';
  const el = job.__full || {};
  if (el.verdictSection) el.verdictSection.style.border = `2px solid ${c}`;
  if (el.verdictHeading) el.verdictHeading.style.color = c;
}

  function toggleDetails(job) {
    ensureGlobalStyles();

    const { card, btnDetails, infoBar } = job.elements;

    if (!job.expanded) {
      // Expand
      infoBar.style.display = 'none';

      const targetW = Math.min(EXPANDED_WIDTH_PX, Math.max(360, window.innerWidth - 32));
      card.style.width  = `${targetW}px`;

      const details = document.createElement('div');
      job.__details = details;
      details.className = 'scitrue-details';
      Object.assign(details.style, {
        borderTop: `1px solid ${PALETTE.border}`,
        background: PALETTE.panelBg,
        flex: '1 1 auto',
        overflow: 'auto',
        padding: '12px',
        maxHeight: '60vh',
        userSelect: 'text'
      });

      details.addEventListener('wheel', (e) => {
        const el = details;
        const atTop = el.scrollTop === 0 && e.deltaY < 0;
        const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight && e.deltaY > 0;
        if (!atTop && !atBottom) { e.preventDefault(); el.scrollTop += e.deltaY; }
      }, { passive: false });

      const vColor = job.verdictColor || '#000000';
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <section style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:12px;background:#fff;color:#000">
          <div style="font-weight:800;font-size:16px;margin-bottom:8px">Summary:</div>
          <div id="${job.id}_full_summary" style="line-height:1.6">
            ${job.summaryHTML ? '' : `<div style="height:18px;width:60%;border-radius:6px;background:#f3f4f6"></div>`}
          </div>
        </section>

       <section id="${job.id}_verdict_section" style="border:2px solid ${vColor};border-radius:12px;padding:14px 16px;margin-bottom:12px;background:#fff;color:#000">
        <div id="${job.id}_verdict_heading" style="font-weight:800;font-size:16px;margin-bottom:8px;color:${vColor}">Verdict and Reason:</div>
        <div id="${job.id}_full_overall" style="line-height:1.6">
            ${job.overallText ? '' : `<div style="height:18px;width:60%;border-radius:6px;background:#f3f4f6"></div>`}
        </div>
        </section>

        <div id="${job.id}_full_list"
             style="display:grid;gap:10px;margin-top:8px"></div>
      `;

      details.appendChild(wrap);
      card.appendChild(details);

      const el = {
        summary: details.querySelector(`#${job.id}_full_summary`),
        overall: details.querySelector(`#${job.id}_full_overall`),
        list:    details.querySelector(`#${job.id}_full_list`),
        verdictSection: details.querySelector(`#${job.id}_verdict_section`),
        verdictHeading: details.querySelector(`#${job.id}_verdict_heading`),
      };

      job.__full = el;

      if (job.summaryHTML) {
        el.summary.innerHTML = job.summaryHTML;
        wireSummaryClicks(job);
      }
      if (job.overallText)  el.overall.textContent = job.overallText;
      if (job.subclaims.length) {
        for (const sc of job.subclaims) appendSubclaimCard(el.list, sc, job.id);
      }

      job.expanded = true;
      btnDetails.textContent = 'Hide Details';
      applyVerdictColor(job);

      const current = card.getBoundingClientRect();
      const targetH = Math.min(Math.max(current.height, 260), Math.floor(window.innerHeight * 0.45));
      card.style.height = `${targetH}px`;
      card.style.resize = 'both';
    } else {
      // Collapse
      try { job.__details?.remove(); } catch {}
      job.__details = null;
      job.__full = null;
      job.expanded = false;
      btnDetails.textContent = 'Show Details';

      card.style.resize = 'none';
      card.style.width  = job.collapsedWidthCSS;

      infoBar.style.display = 'block';
      job.elements.infoBar.textContent = job.infoMessage || job.elements.infoBar.textContent;

      refreshCollapsedSize(job);
    }
  }

  function appendSubclaimCard(listEl, sc, jobId) {
    const pick = (obj, keys, def='') => {
      for (const k of keys) {
        const v = obj?.[k];
        if (v != null && String(v).trim() !== '') return v;
      }
      return def;
    };
    const safeTxt = (x) => (x == null ? '' : String(x).replace(/[&<>"]/g, c => (
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]
    )));
    const safeU = (u) => { try { return u ? new URL(u, location.href).toString() : ''; } catch { return ''; } };

    const linkBtn = (label, id) =>
      `<button type="button" data-toggle="${id}" data-label="${safeTxt(label)}"
               style="background:inherit;border:none;padding:0;margin-left:8px;
                      font:inherit;cursor:pointer;color:${PALETTE.accent};
                      outline:none">Show ${safeTxt(label)}</button>`;

    const row = (label, valueHTML) => `
      <div class="sc-row" style="margin-top:6px;background:rgba(255,255,255,0.03);padding:6px 8px;border-radius:6px">
        <span style="font-weight:700">${safeTxt(label)}:</span> ${valueHTML}
      </div>`;

    const collapsible = (label, innerHTML) => {
      if (!innerHTML) return '';
      const id = `${label.replace(/\W+/g,'_')}_${Math.random().toString(36).slice(2,8)}`;
      return `
        <div class="sc-row" style="margin-top:8px;background:rgba(0,0,0,0.03);padding:6px 8px;border-radius:6px">
          <span style="font-weight:700">${safeTxt(label)}:</span>
          ${linkBtn(label, id)}
          <div id="${id}" style="display:none;margin-top:6px;line-height:1.55">${innerHTML}</div>
        </div>`;
    };

    const listify = (arr) => {
      if (!arr) return '';
      if (Array.isArray(arr)) return `<ul style="margin:6px 0 0 16px;padding:0">${arr.map(x=>`<li>${safeTxt(x)}</li>`).join('')}</ul>`;
      return `<div>${safeTxt(String(arr))}</div>`;
    };

    const renderSjr = (sjrObj) => {
      if (!sjrObj || typeof sjrObj !== 'object' || !Object.keys(sjrObj).length) return '';
      const rows = Object.entries(sjrObj).map(([k,v]) => {
        const isLink = typeof v === 'string' && /^https?:/i.test(v);
        const vHtml  = isLink
          ? `<a href="${safeU(v)}" target="_blank" rel="noopener noreferrer" style="color:${PALETTE.accent};text-decoration:underline">${safeTxt(v)}</a>`
          : safeTxt(v ?? '');
        return `<tr><td style="padding:4px 8px">${safeTxt(k)}</td><td style="padding:4px 8px">${vHtml}</td></tr>`;
      }).join('');
      return collapsible('SJR', `<table style="border-collapse:collapse;border:1px solid ${PALETTE.badgeBr};border-radius:6px"><tbody>${rows}</tbody></table>`);
    };

    const title      = pick(sc, ['title']);
    const paragraph  = pick(sc, ['paragraph']);
    const section    = pick(sc, ['section']);
    const url        = pick(sc, ['url']);
    const abstract   = pick(sc, ['abstract']);
    const venue      = pick(sc, ['venue']);
    const year       = pick(sc, ['year']);
    const citationCount = pick(sc, ['citationCount']);
    const relSent    = pick(sc, ['relevant_sentence','relevant sentence']);
    const label      = pick(sc, ['label']);
    const contributionText = pick(sc, ['contribution','stance_contribution'], '');
    const suppAss    = pick(sc, ['supporting assumptions']);
    const refuAss    = pick(sc, ['refuting assumptions']);
    const sjrObj     = sc.sjr;
    const openAccessPdf = pick(sc, ['openAccessPdf']);
    const fieldsOfStudy = pick(sc, ['fieldsOfStudy']);
    const relType    = pick(sc, ['relevant sentence type']);
    const funcReason = pick(sc, ['function_reason']);
    const relation   = pick(sc, ['relation']);
    const relReason  = pick(sc, ['relation_reason']);
    const bibtex     = pick(sc, ['bibtex']);

    const container = document.createElement('div');
    Object.assign(container.style, {
      border:`1px solid ${PALETTE.border}`,
      borderRadius:'10px',
      background: SUBCLAIM_BG_COLORS[(sc.index ?? 0) % SUBCLAIM_BG_COLORS.length],
      color:'#000',
      overflow:'hidden'
    });

    const n = (sc.index ?? 0) + 1;
    const badgeId = `sc_badge_${jobId}_${sc.index ?? 0}`;
    const badgeColor = colorForContribution(contributionText) || '#444';

    const header = document.createElement('div');
    header.setAttribute('role','button');
    Object.assign(header.style, {
      display:'flex', alignItems:'center', justifyContent:'space-between', gap:'8px',
      padding:'10px 12px', cursor:'pointer', userSelect:'none'
    });
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="sc-caret" style="display:inline-block;transform:rotate(0deg);transition:transform .12s ease">▶</span>
        <div style="font-weight:700;font-size:16px">Subclaim ${n}</div>
        <div id="${badgeId}"
             style="display:${contributionText ? 'inline-block' : 'none'};
                    font-size:12px;padding:3px 10px;border-radius:999px;font-weight:600;
                    background:#fff !important;border:1.5px solid ${badgeColor} !important;color:${badgeColor} !important;">
             ${safeTxt(contributionText) + " to the given claim"}
        </div>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'scitrue-subclaim';
    Object.assign(body.style, { padding:'0 12px 10px', display:'none' }); // default collapsed

    const rowsHTML =
        (title ? row('Title', safeTxt(title)) : '')
      + (paragraph ? collapsible('Paragraph', `<div>${safeTxt(paragraph)}</div>`) : '')
      + (section ? row('Section', safeTxt(section)) : '')
      + (url ? row('URL', `<a href="${safeU(url)}" target="_blank" rel="noopener noreferrer" style="color:${PALETTE.accent};text-decoration:underline">${safeTxt(url)}</a>`) : '')
      + (abstract ? collapsible('Abstract', `<div>${safeTxt(abstract)}</div>`) : '')
      + (venue ? row('Venue', safeTxt(venue)) : '')
      + (year ? row('Year', safeTxt(year)) : '')
      + (citationCount ? row('Citation Count', safeTxt(citationCount)) : '')
      + (relSent ? row('Relevant Sentence', safeTxt(relSent)) : '')
      + (label ? row('Label', safeTxt(label)) : '')
      + (suppAss ? collapsible('Supporting Assumptions', listify(suppAss)) : '')
      + (refuAss ? collapsible('Refuting Assumptions', listify(refuAss)) : '')
      + renderSjr(sjrObj)
      + (openAccessPdf ? row('Open Access', `<a href="${safeU(openAccessPdf)}" target="_blank" rel="noopener noreferrer" style="color:${PALETTE.accent};text-decoration:underline">${safeTxt(openAccessPdf)}</a>`) : '')
      + (fieldsOfStudy ? row('Field of Study', safeTxt(fieldsOfStudy)) : '')
      + ((relType || funcReason)
          ? collapsible('Context', `<div>The source is highly likely contributing <strong>${safeTxt(relType||'—')}</strong> of the study. ${safeTxt(funcReason||'')}</div>`)
          : '')
      + ((relation || relReason)
          ? collapsible('Claim/Article Relation', `<div>The claim article relationship is <strong>${safeTxt(relation||'—')}</strong> – ${safeTxt(relReason||'')}</div>`)
          : '')
      + (bibtex ? collapsible('BibTeX', `<pre style="white-space:pre-wrap;margin:0">${safeTxt(bibtex)}</pre>`) : '');

    body.innerHTML = rowsHTML;

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-toggle]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-toggle');
      const label = btn.getAttribute('data-label') || 'Section';
      const target = body.querySelector(`#${CSS.escape(id)}`);
      if (!target) return;
      const open = target.style.display !== 'none';
      target.style.display = open ? 'none' : 'block';
      btn.textContent = (open ? 'Show ' : 'Hide ') + label;
    });

    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      const caret = header.querySelector('.sc-caret');
      if (caret) caret.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
    });

    container.appendChild(header);
    container.appendChild(body);
    listEl.appendChild(container);
  }

  function updateClaimText(job, index) {
    const sc = job.subclaims[index] || {};
    const claim =
        (sc.claim || sc.paper_claim || sc.claim_text || sc.subclaim || '').trim();
    const el = document.getElementById(`sc_claim_${job.id}_${index}`);
    if (!el) return;
    el.textContent = claim ? `Claim: ${claim}` : '';
    }

  function syncAllClaimTexts(job) {
       for (let i = 0; i < job.subclaims.length; i++) updateClaimText(job, i);
  }

  // --- Contribution badge utilities ---
  function applyContributionBadgeStyles(badge, contrib) {
    const color = colorForContribution(contrib) || '#444';
    badge.textContent = contrib || '';
    if (contrib) {
      badge.style.display = 'inline-block';
      badge.style.setProperty('border-color', color, 'important');
      badge.style.setProperty('color', color, 'important');
      badge.style.setProperty('background', '#fff', 'important');
    } else {
      badge.style.display = 'none';
    }
  }

  function updateContributionBadge(job, index) {
    if (!job.__full) return;
    const sc = job.subclaims[index] || {};
    const contrib = (sc.contribution || sc.stance_contribution || '').trim();
    const badge = job.__full.list?.querySelector?.(`#sc_badge_${job.id}_${index}`);
    if (badge) applyContributionBadgeStyles(badge, contrib);
  }

  async function runJob(job) {
    if (!enabled) { return; }
    const { controller } = job;
    const { statusDot, statusText, btnDetails } = job.elements;

    setStatus('Analyzing');

    try {
      const res = await fetch(API_STREAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim: job.claimText, k: job.k, relation: settings.relation, mainfinding: settings.mainfinding, userEmail: settings.userEmail, year: settings.year}),
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
          if (!msg) continue;

          switch (msg.type) {
            case 'status': {
              const m = (msg.message || '').trim();
              setStatus(m || '');
              if (/Generating summary/i.test(m)) {
                setInfoMessage(job, 'summary');
                btnDetails.style.display = '';
              } else if (/Evaluating verdict/i.test(m)) {
                btnDetails.style.display = '';
              } else if (/Collecting evidence/i.test(m)) {
                setInfoMessage(job, 'fetching');
              } else if (/Using cached result/i.test(m)) {
                setInfoMessage(job, 'summary');
                btnDetails.style.display = '';
              }
              break;
            }

            case 'start':
              statusDot.style.background = '#3aa1ff';
              setStatus('Fetching evidence');
              setInfoMessage(job, 'fetching');
              btnDetails.style.display = 'none';
              break;

            case 'summary': {
              const html = sanitizeSummaryHTML(msg.html || '');
              job.summaryHTML = html;
              if (job.__full) {
                job.__full.summary.innerHTML = html || '';
                wireSummaryClicks(job);
              }
              setStatus('Generating summary');
              setInfoMessage(job, 'summary');
              btnDetails.style.display = '';
              break;
            }

            case 'summary_chunk': {
              const chunk = sanitizeSummaryHTML(msg.html || '') + ' ';
              job.summaryHTML += chunk;
              if (job.__full) {
                job.__full.summary.innerHTML = job.summaryHTML;
                wireSummaryClicks(job);
              }
              setStatus('Generating summary');
              setInfoMessage(job, 'summary');
              btnDetails.style.display = '';
              break;
            }

            case 'overall_reason': {
              job.overallText = msg.text || '';
              job.verdictColor = msg.color || '#000000';
              if (job.__full) {
                job.__full.overall.textContent = job.overallText;
                applyVerdictColor(job);
              }
              setStatus('Evaluating verdict');
              btnDetails.style.display = '';
              break;
            }

            case 'subclaim': {
              if (msg.data) {
                const data = { ...msg.data };
                const index = job.subclaims.length;
                if (data.index == null) data.index = index;
                job.subclaims.push(data);
                if (job.__full) {
                  appendSubclaimCard(job.__full.list, data, job.id);
                  updateContributionBadge(job, index);
                  updateClaimText(job, index);
                }
                setStatus('Adding subclaims');
                btnDetails.style.display = '';
              }
              break;
            }

            case 'subclaim_update': {
              break;
            }

            case 'no_credit':
              markNoCredit();
              break;

            case 'invalid_claim':
              markInvalidClaim();
              break;

            case 'system_exception':
              markException();
              break;

            case 'done':
              job.status = 'done';
              statusDot.style.background = '#2ecc71';
              setStatus('Completed');
              setInfoMessage(job, 'completed');
              btnDetails.style.display = '';
              break;
          }
        }
      }
    } catch {
      if (job.status !== 'canceled') { markException(); }
    }

    function setStatus(t){ job.elements.statusText.textContent = t; }
    function markInvalidClaim() {
      job.status = 'error';
      job.elements.statusDot.style.background = '#e74c3c';
      setStatus('Invalid Claim');
      setInfoMessage(job, 'invalid');
      if (job.elements.btnDetails) {
        job.elements.btnDetails.style.display = 'none';
        job.elements.btnDetails.onclick = null;
      }
    }

    function markException() {
      job.status = 'error';
      job.elements.statusDot.style.background = '#e74c3c';
      setStatus('System Error');
      setInfoMessage(job, 'exception');
      if (job.elements.btnDetails) {
        job.elements.btnDetails.style.display = 'none';
        job.elements.btnDetails.onclick = null;
      }
    }

    function markNoCredit() {
      job.status = 'error';
      job.elements.statusDot.style.background = '#e74c3c';
      setStatus('No Credit');
      setInfoMessage(job, 'credit');
      if (job.elements.btnDetails) {
        job.elements.btnDetails.style.display = 'none';
        job.elements.btnDetails.onclick = null;
      }
    }
  }

  function makeFancyBtn(label, floating = true) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      padding:'4px 10px', fontSize:'12px', fontWeight:'500', letterSpacing:'0.2px',
      color:'#fff', background:'linear-gradient(135deg,#1e90ff 0%,#0069ff 100%)',
      border:'1px solid rgba(255,255,255,0.25)', borderRadius:'9999px',
      boxShadow:'0 4px 10px rgba(0,0,0,0.20)', cursor:'pointer',
      transition:'transform 0.12s ease, box-shadow 0.12s ease',
      zIndex:2147483647, userSelect:'none', position: floating ? 'absolute' : 'static'
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
      const pos = { x, y };
      removeActionBtn();
      try { window.getSelection().removeAllRanges(); } catch {}
      createJob(selectedText, settings.k, pos);
    };
    document.body.appendChild(btn);
  }

  // Input panel (quadruple-click). Draggable; fixed width, auto-growing height (no inner scrollbars).
  function renderInputBox(px, py) {
    if (!enabled) return;
    removeInputBox();

    const box = document.createElement('div');
    box.id = 'scitrue-input';
    inputBox = box;
    Object.assign(box.style, {
      position: 'absolute',
      top: `${py}px`,
      left: `${px}px`,
      width: '520px',
      minWidth: '380px',
      height: 'auto',
      minHeight: '52px',
      padding: '12px 14px',
      background: '#111',
      color: '#fff',
      border: '1px solid #444',
      borderRadius: '10px',
      boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      zIndex: 2147483647,
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      cursor: 'move',
      overflow: 'visible'
    });

    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.wrap = 'soft';
    Object.assign(textarea.style, {
      flex: '1 1 auto',
      minWidth: '120px',
      resize: 'none',
      overflowY: 'hidden',
      overflowX: 'hidden',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      padding: '6px 8px',
      fontSize: '14px',
      lineHeight: '20px',
      border: '1px solid #555',
      borderRadius: '6px',
      background: '#fff',
      color: '#000',
      cursor: 'text',
      height: '28px'
    });

    const autosize = () => {
      textarea.style.height = 'auto';
      const h = Math.max(28, textarea.scrollHeight);
      textarea.style.height = `${h}px`;
    };
    textarea.addEventListener('input', autosize);
    textarea.addEventListener('change', autosize);
    textarea.addEventListener('cut',   () => setTimeout(autosize, 0));
    textarea.addEventListener('paste', () => setTimeout(autosize, 0));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
    });

    const evalBtn = makeFancyBtn('Evaluate', false);
    Object.assign(evalBtn.style, { flex: '0 0 auto', cursor: 'pointer' });

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

    evalBtn.onclick = () => {
      if (!enabled) return;
      const val = textarea.value.trim();
      if (!val) { textarea.style.border = '1px solid #ff5555'; textarea.focus(); return; }
      const r = box.getBoundingClientRect();
      const pos = { x: r.right + 12 + window.scrollX, y: r.top + window.scrollY };
      removeInputBox();
      createJob(val, settings.k, pos);
    };
    closeBtn.onclick = () => removeInputBox();

    box.appendChild(textarea);
    box.appendChild(evalBtn);
    box.appendChild(closeBtn);
    document.body.appendChild(box);

    makeDraggable(box, box, { ignore: (e) => {
      const t = e.target;
      return t === textarea || t === evalBtn || t === closeBtn;
    }});

    const r = box.getBoundingClientRect();
    if (r.right  > window.innerWidth)  box.style.left = `${window.innerWidth  - r.width  - 12}px`;
    if (r.bottom > window.innerHeight) box.style.top  = `${window.innerHeight - r.height - 12}px`;

    autosize();
  }

  document.addEventListener('mouseup', () => {
    if (!enabled) { removeActionBtn(); return; }
    if (suppressNextMouseup) { suppressNextMouseup = false; removeActionBtn(); return; }
    setTimeout(() => {
      if (!enabled) return;
      const sel  = window.getSelection();
      const text = sel.toString().trim();
      if (!text || !sel.rangeCount) { removeActionBtn(); return; }
        let node = sel.getRangeAt(0).commonAncestorContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
        const isInsideOurUI =
        (node.closest && (node.closest('.scitrue-card') || node.closest('#scitrue-input')));

        if (isInsideOurUI) { removeActionBtn(); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      createActionBtn(rect.right + window.scrollX + 12, rect.top + window.scrollY, text);
    }, 10);
  }, true);

  document.addEventListener('click', (e) => {
    if (!enabled) return;
    if (e.detail === 4) {
      if (e.target.closest('.scitrue-card') || e.target.closest('#scitrue-input')) return;
      e.preventDefault();
      try { window.getSelection().removeAllRanges(); } catch {}
      removeActionBtn();
      renderInputBox(e.pageX + 12, e.pageY);
    }
  }, true);

})();
