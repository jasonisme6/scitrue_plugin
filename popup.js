// DOM (keep your existing ones)
const toggle         = document.getElementById('toggle');
const kInput         = document.getElementById('kInput');
const relationSelect = document.getElementById('relationSelect');
const mainfindingChk = document.getElementById('mainfindingChk');

// NEW DOM
const authBar    = document.getElementById('authBar');
const helloUser  = document.getElementById('helloUser');
const logoutBtn  = document.getElementById('logoutBtn');
const historyBtn = document.getElementById('historyBtn');
const authPanel  = document.getElementById('authPanel');
const authEmail  = document.getElementById('authEmail');
const authPwd    = document.getElementById('authPwd');
const loginBtn   = document.getElementById('loginBtn');
const registerBtn= document.getElementById('registerBtn');
const authErr    = document.getElementById('authErr');

// Helpers (keep yours)
const clampK = (v) => Math.max(1, Math.min(15, Number(v) || 5));

// Storage (extend to include user email)
async function getSettings() {
  const {
    scitrueK = 5,
    scitrueRelation = 'relevant',
    scitrueMainfinding = false,
    scitrueUserEmail = ''
  } = await chrome.storage.local.get({
    scitrueK: 5,
    scitrueRelation: 'relevant',
    scitrueMainfinding: false,
    scitrueUserEmail: ''
  });
  return {
    scitrueK: clampK(scitrueK),
    scitrueRelation,
    scitrueMainfinding: !!scitrueMainfinding,
    scitrueUserEmail: String(scitrueUserEmail || '')
  };
}
async function setSettings({ scitrueK, scitrueRelation, scitrueMainfinding }) {
  await chrome.storage.local.set({
    scitrueK: clampK(scitrueK),
    scitrueRelation,
    scitrueMainfinding: !!scitrueMainfinding
  });
}
async function getEnabled() {
  const { scitrueEnabled } = await chrome.storage.local.get({ scitrueEnabled: true });
  return !!scitrueEnabled;
}
async function setEnabled(on) { await chrome.storage.local.set({ scitrueEnabled: !!on }); }
const toggleChk = document.getElementById('toggleChk'); // 开关里的实际 <input type="checkbox">
function renderEnabled(on) {
   toggle.classList.toggle('on', !!on);
   if (toggleChk) toggleChk.checked = !!on;
}

// NEW: UI switchers
function showAuth(email) {
  // Hide settings, show login view, force disabled
  document.querySelectorAll('.section').forEach(sec => sec.style.display = 'none');
  authPanel.style.display = '';
  authBar.style.display = 'none';
  renderEnabled(false);
}
function showSettings(email) {
  // Show settings, hide login view
  authPanel.style.display = 'none';
  authBar.style.display = '';
  helloUser.textContent = `Hi, ${email}`;
  // Show all normal setting sections
  document.querySelectorAll('.section').forEach(sec => {
    if (sec.id !== 'authPanel') sec.style.display = '';
  });
}

// Init
(async () => {
  const enabled = await getEnabled();          // your existing default is true
  const s = await getSettings();               // includes scitrueUserEmail
  const loggedIn = !!s.scitrueUserEmail;
  renderEnabled(loggedIn ? enabled : false);

  // If not logged-in, force disabled view & show auth
  if (!loggedIn) {
    await setEnabled(false);
    renderEnabled(false);
    showAuth();
  } else {
    renderEnabled(enabled);
    showSettings(s.scitrueUserEmail);
  }

  // seed fields
  kInput.value = String(s.scitrueK);
  relationSelect.value = s.scitrueRelation;
  mainfindingChk.checked = s.scitrueMainfinding;

  // Persistors (unchanged)
  const persistAll = () => setSettings({
    scitrueK: kInput.value,
    scitrueRelation: relationSelect.value,
    scitrueMainfinding: mainfindingChk.checked
  });
  kInput.addEventListener('input', () => {
    const v = clampK(kInput.value);
    if (String(v) !== kInput.value) kInput.value = String(v);
  });
  kInput.addEventListener('change', persistAll);
  kInput.addEventListener('blur',   persistAll);
  relationSelect.addEventListener('change', persistAll);
  mainfindingChk.addEventListener('change', persistAll);

  // Toggle enable only when logged in
  toggle.addEventListener('click', async () => {
    const { scitrueUserEmail } = await chrome.storage.local.get({ scitrueUserEmail: '' });
    if (!scitrueUserEmail) return;  // ignore when not logged-in
    const current = await getEnabled();
    await setEnabled(!current);
    renderEnabled(!current);
  });

  // ===== Auth handlers =====
  const API_LOGIN_URL = 'http://localhost:5002/api/login';

  function showAuthError(msg) {
    authErr.textContent = msg || '';
    authErr.style.display = msg ? '' : 'none';
  }

  loginBtn.addEventListener('click', async () => {
    showAuthError('');
    const email = (authEmail.value || '').trim();
    const pwd   = (authPwd.value || '').trim();
    if (!email || !pwd) {
      showAuthError('Email and password cannot be empty.');
      return;
    }
    try {
      const res = await fetch(API_LOGIN_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ userEmail: email, userPassword: pwd })
      });
      if (!res.ok) { showAuthError(`HTTP ${res.status}`); return; }
      const data = await res.json();
      if (data && data.ok === true) {
        await chrome.storage.local.set({ scitrueUserEmail: email, scitrueEnabled: true });
        renderEnabled(true);
        showSettings(email);
      } else {
        showAuthError('Invalid email or password.');
      }
    } catch (e) {
      showAuthError('Login failed. Is the API running?');
    }
  });

  registerBtn.addEventListener('click', () => {
    // open verify page in a new window
    window.open('http://localhost:8501/?page=verify', '_blank', 'noopener');
  });

  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['scitrueUserEmail']);
    await setEnabled(false);
    renderEnabled(false);
    showAuth();
  });

  historyBtn.addEventListener('click', async () => {
    const { scitrueUserEmail = '' } = await chrome.storage.local.get({ scitrueUserEmail: '' });
    const url = `http://localhost:8501/?page=history&userEmail=${encodeURIComponent(scitrueUserEmail)}`;
    window.open(url, '_blank', 'noopener');
  });
})();
