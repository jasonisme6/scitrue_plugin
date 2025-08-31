// DOM
const toggle         = document.getElementById('toggle');
const kInput         = document.getElementById('kInput');
const relationSelect = document.getElementById('relationSelect');
const mainfindingChk = document.getElementById('mainfindingChk');

// Helpers
const clampK = (v) => Math.max(1, Math.min(15, Number(v) || 5));

// Storage (same keys)
async function getSettings() {
  const { scitrueK = 5, scitrueRelation = 'relevant', scitrueMainfinding = false } =
    await chrome.storage.local.get({
      scitrueK: 5,
      scitrueRelation: 'relevant',
      scitrueMainfinding: false,
    });
  return {
    scitrueK: clampK(scitrueK),
    scitrueRelation,
    scitrueMainfinding: !!scitrueMainfinding,
  };
}

async function setSettings({ scitrueK, scitrueRelation, scitrueMainfinding }) {
  await chrome.storage.local.set({
    scitrueK: clampK(scitrueK),
    scitrueRelation,
    scitrueMainfinding: !!scitrueMainfinding,
  });
}

function render(on) { toggle.classList.toggle('on', !!on); }

async function getEnabled() {
  const { scitrueEnabled } = await chrome.storage.local.get({ scitrueEnabled: true });
  return !!scitrueEnabled;
}
async function setEnabled(on) { await chrome.storage.local.set({ scitrueEnabled: !!on }); }

// Init
(async () => {
  render(await getEnabled());

  const { scitrueK, scitrueRelation, scitrueMainfinding } = await getSettings();
  kInput.value = String(scitrueK);
  relationSelect.value = scitrueRelation;
  mainfindingChk.checked = scitrueMainfinding;

  // Clamp and persist K
  const persistK = () => setSettings({
    scitrueK: kInput.value,
    scitrueRelation: relationSelect.value,
    scitrueMainfinding: mainfindingChk.checked,
  });
  kInput.addEventListener('input', () => {
    const v = clampK(kInput.value);
    if (String(v) !== kInput.value) kInput.value = String(v);
  });
  kInput.addEventListener('change', persistK);
  kInput.addEventListener('blur',   persistK);

  // Persist relation
  relationSelect.addEventListener('change', () => setSettings({
    scitrueK: kInput.value,
    scitrueRelation: relationSelect.value,
    scitrueMainfinding: mainfindingChk.checked,
  }));

  // Persist main findings (only checkbox toggles)
  mainfindingChk.addEventListener('change', () => setSettings({
    scitrueK: kInput.value,
    scitrueRelation: relationSelect.value,
    scitrueMainfinding: mainfindingChk.checked,
  }));

  // Toggle
  toggle.addEventListener('click', async () => {
    const current = await getEnabled();
    await setEnabled(!current);
    render(!current);
  });
})();
