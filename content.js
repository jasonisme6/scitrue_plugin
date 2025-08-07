/**
 *  SciTrue – content script
 *  ---------------------------------------
 *  • HTML pages
 *      – Text selection  → floating “Evaluate Selected Claim” button
 *      – Double-click empty area → “Input Customized Claim” flow
 */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
   *  Shared runtime state
   * ----------------------------------------------------------------*/
  let actionBtn = null;   // floating “Evaluate Selected Claim”
  let inputBox  = null;   // textarea + Evaluate
  let popup     = null;   // result panel
  let popupOpen = false;

  // track last mouse coordinates (for Alt+C anchor)
  let lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  document.addEventListener('mousemove', (e) => { lastMouse = { x: e.pageX, y: e.pageY }; });

  /* ------------------------------------------------------------------
   *  Tiny helpers
   * ----------------------------------------------------------------*/
  const remove = (el) => { if (el) el.remove(); };
  const removeActionBtn = () => { remove(actionBtn); actionBtn = null; };
  const removeInputBox  = () => { remove(inputBox); inputBox = null; };
  const removePopup     = () => { remove(popup); popup = null; popupOpen = false; };

  /* ------------------------------------------------------------------
   *  Popup panel (black card that shows the claim text)
   * ----------------------------------------------------------------*/
  function createPopup(text, anchorX, anchorY) {
    removePopup();
    popupOpen = true;
    window.getSelection().removeAllRanges(); // clear highlight

    popup = document.createElement('div');
    Object.assign(popup.style, {
      position   : 'absolute',
      top        : `${anchorY}px`,
      left       : `${anchorX}px`,
      maxWidth   : '340px',
      maxHeight  : '60vh',
      overflowY  : 'auto',
      padding    : '16px 22px 18px',
      background : '#111',
      color      : '#fff',
      border     : '1px solid #444',
      borderRadius: '10px',
      boxShadow  : '0 4px 14px rgba(0,0,0,0.35)',
      fontSize   : '14px',
      lineHeight : '1.45',
      zIndex     : 9999
    });

    // close (×) button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position   : 'absolute',
      top        : '6px',
      right      : '10px',
      fontSize   : '20px',
      background : 'transparent',
      border     : 'none',
      color      : '#bbb',
      cursor     : 'pointer'
    });
    closeBtn.onmouseenter = () => (closeBtn.style.color = '#fff');
    closeBtn.onmouseleave = () => (closeBtn.style.color = '#bbb');
    closeBtn.onclick      = removePopup;

    popup.textContent = text;
    popup.appendChild(closeBtn);
    document.body.appendChild(popup);

    // keep inside viewport
    const r = popup.getBoundingClientRect();
    if (r.right  > window.innerWidth)  popup.style.left = `${window.innerWidth  - r.width  - 12}px`;
    if (r.bottom > window.innerHeight) popup.style.top  = `${window.innerHeight - r.height - 12}px`;

    // ESC key closes popup
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
      padding       : '6px 16px',
      fontSize      : '14px',
      fontWeight    : '500',
      letterSpacing : '0.2px',
      color         : '#fff',
      background    : 'linear-gradient(135deg,#1e90ff 0%,#0069ff 100%)',
      border        : '1px solid rgba(255,255,255,0.25)',
      borderRadius  : '9999px',
      boxShadow     : '0 4px 10px rgba(0,0,0,0.20)',
      cursor        : 'pointer',
      transition    : 'transform 0.12s ease, box-shadow 0.12s ease',
      zIndex        : 9999,
      userSelect    : 'none',
      position      : floating ? 'absolute' : 'static'
    });
    btn.onmouseenter = () => {
      btn.style.boxShadow = '0 6px 14px rgba(0,0,0,0.25)';
      btn.style.transform = 'translateY(-1px)';
    };
    btn.onmouseleave = () => {
      btn.style.boxShadow = '0 4px 10px rgba(0,0,0,0.20)';
      btn.style.transform = 'none';
    };
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
    removeActionBtn();
    actionBtn = makeFancyBtn('Evaluate');
    Object.assign(actionBtn.style, { top: `${y}px`, left: `${x}px` });
    actionBtn.onclick = () => {
      const rect = actionBtn.getBoundingClientRect();
      removeActionBtn();
      createPopup(selectedText,
                  rect.left + window.scrollX,
                  rect.top  + window.scrollY);
    };
    document.body.appendChild(actionBtn);
  }

  /* ------------------------------------------------------------------
   *  Custom-claim input panel
   * ----------------------------------------------------------------*/
  function renderInputBox(px, py) {
    removeInputBox();

    inputBox = document.createElement('div');
    Object.assign(inputBox.style, {
      position     : 'absolute',
      top          : `${py}px`,
      left         : `${px}px`,
      padding      : '18px 20px 20px',
      background   : '#111',
      color        : '#fff',
      border       : '1px solid #444',
      borderRadius : '10px',
      boxShadow    : '0 4px 14px rgba(0,0,0,0.35)',
      zIndex       : 9999,
      display      : 'flex',
      alignItems   : 'center',
      gap          : '12px'
    });

    // close (×) button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position   : 'absolute',
      top        : '4px',
      right      : '4px',
      fontSize   : '20px',
      background : 'transparent',
      border     : 'none',
      color      : '#bbb',
      cursor     : 'pointer'
    });
    closeBtn.onmouseenter = () => (closeBtn.style.color = '#fff');
    closeBtn.onmouseleave = () => (closeBtn.style.color = '#bbb');
    closeBtn.onclick      = removeInputBox;
    inputBox.appendChild(closeBtn);

    // textarea for claim text
    const textarea = document.createElement('textarea');
    Object.assign(textarea.style, {
      width        : '350px',
      height       : '34px',
      resize       : 'both',
      border       : '1px solid #555',
      borderRadius : '6px',
      background   : '#222',
      color        : '#fff',
      padding      : '6px 8px',
      fontSize     : '14px',
      lineHeight   : '1.4',
      flexShrink   : '0'
    });

    // Evaluate button
    const evalBtn = makeFancyBtn('Evaluate', false);
    evalBtn.onclick = () => {
      const val = textarea.value.trim();
      if (!val) {
        textarea.style.border = '1px solid #ff5555';
        textarea.focus();
        return;
      }
      const r = evalBtn.getBoundingClientRect();
      removeInputBox();
      createPopup(val,
                  r.left + window.scrollX,
                  r.bottom + window.scrollY + 12);
    };

    inputBox.appendChild(textarea);
    inputBox.appendChild(evalBtn);
    document.body.appendChild(inputBox);

    // keep panel inside viewport
    const r = inputBox.getBoundingClientRect();
    if (r.right  > window.innerWidth)  inputBox.style.left = `${window.innerWidth  - r.width  - 12}px`;
    if (r.bottom > window.innerHeight) inputBox.style.top  = `${window.innerHeight - r.height - 12}px`;
  }

  /* ------------------------------------------------------------------
   *  Click-away cleanup
   * ----------------------------------------------------------------*/
  document.addEventListener('mousedown', (e) => {
    if (actionBtn && !actionBtn.contains(e.target)) removeActionBtn();
    if (inputBox  && !inputBox.contains(e.target))  removeInputBox();
    if (popup     && !popup.contains(e.target))     removePopup();
  });

  /* ------------------------------------------------------------------
   *  Selection workflow – HTML only
   * ----------------------------------------------------------------*/
  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      if (popupOpen) return;
      const sel  = window.getSelection();
      const text = sel.toString().trim();
      if (!text) { removeActionBtn(); return; }

      // ignore selection inside the input panel
      if (inputBox && sel.rangeCount) {
        let node = sel.getRangeAt(0).commonAncestorContainer;
        if (node.nodeType === 3) node = node.parentNode;
        if (inputBox.contains(node)) { removeActionBtn(); return; }
      }

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      createActionBtn(rect.right + window.scrollX + 12,
                      rect.top  + window.scrollY,
                      text);
    }, 10); // allow selection to settle
  });

  /* ------------------------------------------------------------------
   *  Double-click workflow – HTML only (now opens input box directly)
   * ----------------------------------------------------------------*/
  document.addEventListener('dblclick', (e) => {
    if (popupOpen) return;
    if (inputBox && inputBox.contains(e.target)) return;
    if (window.getSelection().toString().trim()) return; // ignore when text selected
    removeActionBtn();
    renderInputBox(e.pageX + 12, e.pageY);
  });

})();