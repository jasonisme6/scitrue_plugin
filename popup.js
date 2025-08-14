// Reads & writes the "enabled" flag in chrome.storage.local
const toggle = document.getElementById('toggle');

function render(on) {
  toggle.classList.toggle('on', !!on);
}

async function getEnabled() {
  const { scitrueEnabled } = await chrome.storage.local.get({ scitrueEnabled: true });
  return scitrueEnabled;
}

async function setEnabled(on) {
  await chrome.storage.local.set({ scitrueEnabled: !!on });
}

(async () => {
  render(await getEnabled());

  toggle.addEventListener('click', async () => {
    const current = await getEnabled();
    await setEnabled(!current);
    render(!current);
    // 不需要显式发消息；content.js 会通过 storage 变化立即响应
  });
})();
