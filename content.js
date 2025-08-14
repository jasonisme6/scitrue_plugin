/**
 *  SciTrue – content script with enable/disable toggle + API integration
 *  --------------------------------------------------------------------
 *  • Toggle source: chrome.storage.local.scitrueEnabled (default true)
 *  • Two entry points:
 *      – Selection → “Evaluate” button → call /api/analyze_claim
 *      – Double-click empty area → input box → “Evaluate” → same API
 *  • UX:
 *      – Blocking modal shows loading; cannot be closed by outside click
 *      – Close only via the × button
 *      – Renders pretty result view on success; error card on failure
 */

(() => {
  'use strict';

  // --------------------------- config ---------------------------
  const API_URL = 'http://localhost:5002/api/analyze_claim';
  const DEFAULT_K = 5;
  const REQUEST_TIMEOUT_MS = 120000; // 30s timeout

  // ---------- global on/off ----------
  let enabled = true; // will be hydrated below

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.scitrueEnabled) return;
    enabled = !!changes.scitrueEnabled.newValue;
    if (!enabled) {
      removeActionBtn(); removeInputBox(); removePopup(); removeModal();
    }
  });

  chrome.storage.local.get({ scitrueEnabled: true }, (res) => {
    enabled = !!res.scitrueEnabled;
  });

  /* ------------------------------------------------------------------
   *  Shared runtime state
   * ----------------------------------------------------------------*/
  let actionBtn = null;   // floating “Evaluate Selected Claim”
  let inputBox  = null;   // textarea + Evaluate
  let popup     = null;   // legacy small popup (not used for results)
  let popupOpen = false;

  // track last mouse (reserved for future hotkeys)
  let lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  document.addEventListener('mousemove', (e) => { lastMouse = { x: e.pageX, y: e.pageY }; }, true);

  /* ------------------------------------------------------------------
   *  Tiny helpers
   * ----------------------------------------------------------------*/
  const remove = (el) => { if (el) el.remove(); };
  const removeActionBtn = () => { remove(actionBtn); actionBtn = null; };
  const removeInputBox  = () => { remove(inputBox); inputBox  = null; };
  const removePopup     = () => { remove(popup);     popup     = null; popupOpen = false; };

  // HTML-escape
  function safe(x) {
    if (x == null) return '';
    const s = String(x);
    return s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function safeUrl(u) {
    try {
      const url = new URL(u, location.href);
      return url.toString();
    } catch { return '#'; }
  }

  /* ------------------------------------------------------------------
   *  Modal (blocking) – only × can close
   * ----------------------------------------------------------------*/
  let modalBackdrop = null;   // dark overlay
  let modalCard     = null;   // centered card
  let modalBody     = null;   // scrollable content area
  let modalClose    = null;   // × button

  function removeModal() {
    remove(modalBackdrop);
    remove(modalCard);
    modalBackdrop = modalCard = modalBody = modalClose = null;
    document.documentElement.style.overflow = ''; // restore scroll
  }

  function openModalSkeleton() {
    removeModal();

    document.documentElement.style.overflow = 'hidden'; // lock scroll

    modalBackdrop = document.createElement('div');
    Object.assign(modalBackdrop.style, {
      position:'fixed', inset:'0', background:'rgba(0,0,0,0.55)', zIndex: 2147483646
    });

    modalCard = document.createElement('div');
    Object.assign(modalCard.style, {
      position:'fixed', top:'50%', left:'50%',
      transform:'translate(-50%,-50%)',
      width:'min(920px, 90vw)', maxHeight:'80vh',
      background:'#0f1115', color:'#eaeef3',
      border:'1px solid #2a2f3a', borderRadius:'14px',
      boxShadow:'0 20px 60px rgba(0,0,0,0.45)',
      padding:'18px 20px 16px', zIndex: 2147483647,
      display:'flex', flexDirection:'column'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display:'flex', alignItems:'center', justifyContent:'space-between',
      marginBottom:'10px'
    });
    const title = document.createElement('div');
    title.textContent = 'SciTrue – Analysis';
    Object.assign(title.style, { fontSize:'16px', fontWeight:'600', letterSpacing:'0.2px' });

    modalClose = document.createElement('button');
    modalClose.textContent = '×';
    Object.assign(modalClose.style, {
      fontSize:'22px', lineHeight:'22px',
      background:'transparent', border:'none', color:'#aab2bf',
      cursor:'pointer', padding:'2px 8px', borderRadius:'8px'
    });
    modalClose.onmouseenter = () => (modalClose.style.color = '#fff');
    modalClose.onmouseleave = () => (modalClose.style.color = '#aab2bf');
    modalClose.onclick      = removeModal;

    header.appendChild(title);
    header.appendChild(modalClose);

    modalBody = document.createElement('div');
    Object.assign(modalBody.style, {
      overflow:'auto', borderRadius:'10px', background:'#0b0d12',
      border:'1px solid #212635', padding:'14px'
    });

    modalCard.appendChild(header);
    modalCard.appendChild(modalBody);
    document.body.appendChild(modalBackdrop);
    document.body.appendChild(modalCard);
  }

  function showLoadingInModal(claimText) {
    openModalSkeleton();

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      gap:'14px', padding:'28px 8px'
    });

    // Spinner
    const spinner = document.createElement('div');
    Object.assign(spinner.style, {
      width:'46px', height:'46px', borderRadius:'50%',
      border:'4px solid #2b3242', borderTop:'4px solid #3aa1ff',
      animation:'scitrue-spin 0.9s linear infinite'
    });
    // keyframes (idempotent is fine)
    const style = document.createElement('style');
    style.textContent = '@keyframes scitrue-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);

    const line1 = document.createElement('div');
    line1.textContent = 'Analyzing claim…';
    Object.assign(line1.style, { fontSize:'15px', fontWeight:'600' });

    const line2 = document.createElement('div');
    line2.textContent = `“${claimText}”`;
    Object.assign(line2.style, {
      fontSize:'13px', color:'#c3cad5', textAlign:'center', maxWidth:'640px'
    });

    wrap.appendChild(spinner);
    wrap.appendChild(line1);
    wrap.appendChild(line2);
    modalBody.replaceChildren(wrap);
  }

  function renderErrorInModal(message) {
    const box = document.createElement('div');
    Object.assign(box.style, {
      background:'#1a0f10', border:'1px solid #5a1f27', color:'#ffdfe3',
      padding:'14px', borderRadius:'10px', fontSize:'13px', lineHeight:'1.5', whiteSpace:'pre-wrap'
    });
    box.textContent = message || 'Unexpected error.';
    modalBody.replaceChildren(box);
  }

  function renderResultInModal(result) {
    // Expected shape (example):
    // {
    //   articles: 5,
    //   claim: "Human are not animals.",
    //   summary: "...",
    //   "overall reason for accuracy": "...",
    //   subclaims: [{ title, venue/journal_title, year, label/relation, url, "relevant sentence"/relevant_sentence, relation_reason/function_reason }, ...]
    // }

    const container = document.createElement('div');
    Object.assign(container.style, { display:'grid', gap:'12px' });

    // Top summary card
    const summary = document.createElement('div');
    Object.assign(summary.style, {
      background:'#0f1420', border:'1px solid #22314b', borderRadius:'10px',
      padding:'12px 14px'
    });

    function sanitizeSummaryHTML(raw) {
      if (!raw) return '';
      const parser = new DOMParser();
      const doc = parser.parseFromString(String(raw), 'text/html');

      (function walk(node) {
        const kids = Array.from(node.childNodes);
        for (const child of kids) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName !== 'A') {
              // Replace non-<a> elements with their text content
              child.replaceWith(document.createTextNode(child.textContent || ''));
              continue;
            }
            // For <a>: keep only safe http/https links
            const href = child.getAttribute('href') || '';
            let ok = false, urlStr = '#';
            try {
              const u = new URL(href, location.href);
              if (/^https?:$/i.test(u.protocol)) { ok = true; urlStr = u.toString(); }
            } catch {}
            if (!ok) {
              child.replaceWith(document.createTextNode(child.textContent || ''));
              continue;
            }
            child.setAttribute('href', urlStr);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
            // Make it look like a link in the dark UI
            child.style.color = '#3aa1ff';
            child.style.textDecoration = 'underline';
          }
        }
      })(doc.body);

      return doc.body.innerHTML;
    }

    const sanitizedSummaryHTML = sanitizeSummaryHTML(result.summary);

    summary.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;">
        <div style="font-size:14px;font-weight:600;">
          Result Overview
        </div>
        <div style="font-size:12px;opacity:.85">
          Articles: <b>${safe(result.articles)}</b>
        </div>
      </div>
      <div style="margin-top:8px;font-size:13px;opacity:.9">
        <div style="color:#a7b4c7">Claim</div>
        <div style="margin-top:4px;font-weight:600">${safe(result.claim)}</div>
      </div>
      ${result.summary ? `
      <div style="margin-top:10px;font-size:13px;opacity:.92">
        <div style="color:#a7b4c7">Summary</div>
        <div style="margin-top:4px">${sanitizedSummaryHTML}</div>
      </div>` : ''}
      ${result['overall reason for accuracy'] ? `
      <div style="margin-top:10px;font-size:13px;opacity:.92">
        <div style="color:#a7b4c7">Overall Reason</div>
        <div style="margin-top:4px">${safe(result['overall reason for accuracy'])}</div>
      </div>` : ''}
    `;

    container.appendChild(summary);

    // Subclaims list
    if (Array.isArray(result.subclaims) && result.subclaims.length) {
      const listWrap = document.createElement('div');
      Object.assign(listWrap.style, {
        background:'#0f1420', border:'1px solid #22314b', borderRadius:'10px',
        padding:'12px 14px'
      });

      const heading = document.createElement('div');
      heading.textContent = 'Evidence & Subclaims';
      Object.assign(heading.style, { fontSize:'14px', fontWeight:'600', marginBottom:'8px' });
      listWrap.appendChild(heading);

      const list = document.createElement('div');
      Object.assign(list.style, { display:'grid', gap:'10px' });

      result.subclaims.forEach((sc, i) => {
        const card = document.createElement('div');
        Object.assign(card.style, {
          border:'1px solid #2a3752', borderRadius:'10px', padding:'10px 12px',
          background:'#0c1220'
        });

        const title = document.createElement('div');
        title.innerHTML = `
          <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-size:13px;font-weight:600;">
                ${safe(sc.title || `Source #${i+1}`)}
              </div>
              <div style="font-size:12px;opacity:.8;margin-top:2px;">
                ${safe(sc.venue || sc.journal_title || '—')} · ${safe(sc.year || '')}
              </div>
            </div>
            ${sc.url ? `<a href="${safeUrl(sc.url)}" target="_blank" rel="noopener noreferrer"
               style="font-size:12px;text-decoration:none;border:1px solid #36548b;padding:4px 8px;border-radius:8px">
               Open</a>` : ''}
          </div>
        `;
        card.appendChild(title);

        const rel = sc.label || sc.relation;
        if (rel) {
          const badge = document.createElement('div');
          Object.assign(badge.style, {
            display:'inline-block', marginTop:'8px',
            fontSize:'11px', padding:'2px 8px', borderRadius:'999px',
            border: '1px solid #3d567e', background:'#101b2d', opacity:.95
          });
          badge.textContent = rel;
          card.appendChild(badge);
        }

        if (sc['relevant sentence'] || sc.relevant_sentence) {
          const rs = document.createElement('div');
          Object.assign(rs.style, { marginTop:'8px', fontSize:'13px', lineHeight:'1.5' });
          rs.innerHTML = `<span style="color:#90a4c5">Relevant:</span> ${safe(sc['relevant sentence'] || sc.relevant_sentence)}`;
          card.appendChild(rs);
        }

        if (sc.relation_reason || sc.function_reason) {
          const why = document.createElement('div');
          Object.assign(why.style, { marginTop:'6px', fontSize:'12px', opacity:.9 });
          why.innerHTML = `<span style="color:#90a4c5">Reason:</span> ${safe(sc.relation_reason || sc.function_reason)}`;
          card.appendChild(why);
        }

        list.appendChild(card);
      });

      listWrap.appendChild(list);
      container.appendChild(listWrap);
    }

    modalBody.replaceChildren(container);
  }

  /* ------------------------------------------------------------------
   *  API call + orchestration
   * ----------------------------------------------------------------*/
  async function analyzeClaim(claim, k = DEFAULT_K) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim, k }),
      signal: controller.signal
    }).finally(() => clearTimeout(t));

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    return res.json();
  }

  async function runAnalysisFlow(claimText) {
    if (!enabled) return;
    showLoadingInModal(claimText);
    try {
      const result = await analyzeClaim(claimText, DEFAULT_K);
      renderResultInModal(result);
    } catch (err) {
      renderErrorInModal(
        `Failed to analyze. ${err?.message || err || 'Unknown error.'}\n` +
        `• Ensure the API is running at ${API_URL}\n` +
        `• Check network / CORS / firewall`
      );
    }
  }

  /* ------------------------------------------------------------------
   *  (Legacy) small popup (not used for results)
   * ----------------------------------------------------------------*/
  function createPopup(text, anchorX, anchorY) {
    if (!enabled) return;
    removePopup();
    popupOpen = true;
    try { window.getSelection().removeAllRanges(); } catch (_) {}

    popup = document.createElement('div');
    Object.assign(popup.style, {
      position:'absolute', top:`${anchorY}px`, left:`${anchorX}px`,
      minWidth:'240px', minHeight:'36px', width:'max-content', overflow:'auto',
      resize:'both', padding:'16px 22px 18px', background:'#111', color:'#fff',
      border:'1px solid #444', borderRadius:'10px', boxShadow:'0 4px 14px rgba(0,0,0,0.35)',
      fontSize:'14px', lineHeight:'1.45', zIndex:9999
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position:'absolute', top:'6px', right:'10px',
      fontSize:'20px', background:'transparent', border:'none',
      color:'#bbb', cursor:'pointer'
    });
    closeBtn.onmouseenter = () => (closeBtn.style.color = '#fff');
    closeBtn.onmouseleave = () => (closeBtn.style.color = '#bbb');
    closeBtn.onclick      = removePopup;

    popup.textContent = text;
    popup.appendChild(closeBtn);
    document.body.appendChild(popup);

    const r = popup.getBoundingClientRect();
    if (r.right  > window.innerWidth)  popup.style.left = `${window.innerWidth  - r.width  - 12}px`;
    if (r.bottom > window.innerHeight) popup.style.top  = `${window.innerHeight - r.height - 12}px`;

    window.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { removePopup(); window.removeEventListener('keydown', esc); }
    }, { once: true });
  }

  /* ------------------------------------------------------------------
   *  Fancy pill-shaped button generator
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
    if (floating) {
      btn.onmousedown = () => (btn.style.transform = 'translateY(1px)');
      btn.onmouseup   = () => (btn.style.transform = 'translateY(-1px)');
    }
    return btn;
  }

  /* ------------------------------------------------------------------
   *  Floating “Evaluate” button for text selection
   * ----------------------------------------------------------------*/
  function createActionBtn(x, y, selectedText) {
    if (!enabled) return;
    removeActionBtn();
    const btn = (actionBtn = makeFancyBtn('Evaluate'));
    Object.assign(btn.style, { top: `${y}px`, left: `${x}px` });
    btn.onclick = () => {
      removeActionBtn();
      runAnalysisFlow(selectedText); // Blocking modal + API call
    };
    document.body.appendChild(btn);
  }

  /* ------------------------------------------------------------------
   *  Custom-claim input panel (single line)
   * ----------------------------------------------------------------*/
  function renderInputBox(px, py) {
    if (!enabled) return;
    removeInputBox();

    const box = document.createElement('div');
    inputBox = box;
    Object.assign(box.style, {
      position:'absolute', top:`${py}px`, left:`${px}px`,
      padding:'18px 20px 20px', background:'#111', color:'#fff',
      border:'1px solid #444', borderRadius:'10px',
      boxShadow:'0 4px 14px rgba(0,0,0,0.35)', zIndex:9999,
      display:'flex', alignItems:'center', gap:'12px'
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position:'absolute', top:'4px', right:'4px',
      fontSize:'20px', background:'transparent', border:'none', color:'#bbb', cursor:'pointer'
    });
    closeBtn.onmouseenter = () => (closeBtn.style.color = '#fff');
    closeBtn.onmouseleave = () => (closeBtn.style.color = '#bbb');
    closeBtn.onclick      = removeInputBox;
    box.appendChild(closeBtn);

    const textarea = document.createElement('textarea');
    // single-line, no wrap, no newline
    const fontPx = 14, linePx = 20, padTop = 0.5, padBottom = 0.5;
    const oneLine = linePx + padTop + padBottom;

    textarea.setAttribute('rows', '1');
    textarea.setAttribute('wrap', 'off');

    const s = textarea.style;
    s.setProperty('width', '350px', 'important');
    s.setProperty('height', `${oneLine}px`, 'important');
    s.setProperty('min-height', `${oneLine}px`, 'important');
    s.setProperty('max-height', `${oneLine}px`, 'important');
    s.setProperty('resize', 'horizontal', 'important');
    s.setProperty('overflow-y', 'hidden', 'important');
    s.setProperty('white-space', 'nowrap', 'important');
    s.setProperty('box-sizing', 'content-box', 'important');
    s.setProperty('padding', `${padTop}px 8px ${padBottom}px`, 'important');
    s.setProperty('font-size', `${fontPx}px`, 'important');
    s.setProperty('line-height', `${linePx}px`, 'important');
    s.setProperty('font-family',
      'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', 'important');
    s.setProperty('border', '1px solid #555', 'important');
    s.setProperty('border-radius', '6px', 'important');
    s.setProperty('background', '#fff', 'important');
    s.setProperty('color', '#000', 'important');

    textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

    const evalBtn = makeFancyBtn('Evaluate', false);
    evalBtn.onclick = () => {
      if (!enabled) return;
      const val = textarea.value.trim();
      if (!val) { textarea.style.border = '1px solid #ff5555'; textarea.focus(); return; }
      removeInputBox();
      runAnalysisFlow(val); // Blocking modal + API call
    };

    box.appendChild(textarea);
    box.appendChild(evalBtn);
    document.body.appendChild(box);

    const r = box.getBoundingClientRect();
    if (r.right  > window.innerWidth)  box.style.left = `${window.innerWidth  - r.width  - 12}px`;
    if (r.bottom > window.innerHeight) box.style.top  = `${window.innerHeight - r.height - 12}px`;
  }

  /* ------------------------------------------------------------------
   *  Click-away cleanup (do NOT close modal by outside click)
   * ----------------------------------------------------------------*/
  document.addEventListener('mousedown', (e) => {
    if (!enabled) { removeActionBtn(); removeInputBox(); removePopup(); removeModal(); return; }
    if (actionBtn && !actionBtn.contains(e.target)) removeActionBtn();
    if (inputBox  && !inputBox.contains(e.target))  removeInputBox();
    // Intentionally do NOT close popup/modal by outside click
  }, true);

  /* ------------------------------------------------------------------
   *  Selection workflow – HTML only
   * ----------------------------------------------------------------*/
  document.addEventListener('mouseup', () => {
    if (!enabled) { removeActionBtn(); return; }
    setTimeout(() => {
      if (!enabled) return;
      const sel  = window.getSelection();
      const text = sel.toString().trim();
      if (!text || !sel.rangeCount) { removeActionBtn(); return; }

      // Avoid triggering when selection is inside our input box
      if (inputBox) {
        let node = sel.getRangeAt(0).commonAncestorContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
        if (inputBox.contains(node)) { removeActionBtn(); return; }
      }

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      createActionBtn(
        rect.right + window.scrollX + 12,
        rect.top   + window.scrollY,
        text
      );
    }, 10);
  }, true);

  /* ------------------------------------------------------------------
   *  Double-click workflow – HTML only (open input box)
   * ----------------------------------------------------------------*/
  document.addEventListener('dblclick', (e) => {
    if (!enabled) return;
    // For custom claim input; block default double-click select
    e.preventDefault();
    try { window.getSelection().removeAllRanges(); } catch (_) {}
    if (popupOpen) return;
    if (inputBox && inputBox.contains(e.target)) return;
    removeActionBtn();
    renderInputBox(e.pageX + 12, e.pageY);
  }, true);
})();
