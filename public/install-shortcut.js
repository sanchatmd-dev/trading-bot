(() => {
  'use strict';
  const cooldownKey = 'robotInstallDismissedUntil';
  const standalone = window.matchMedia('(display-mode: standalone)');
  const installed = () => standalone.matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mobile = ios || /Android/i.test(navigator.userAgent);
  if (!mobile || installed()) return;
  let deferredPrompt;
  let memoryDismissed = false;
  const copy = {
    en: ['Keep Robot Trade on your Home Screen', 'Open your trading dashboard quickly with a Home Screen shortcut.', 'In Safari, tap Share, then Add to Home Screen. If needed, enable Open as Web App, then tap Add.', 'Open your browser menu (⋮), then select Add to Home screen or Install app. If unavailable, open this page in Chrome.', 'Install', 'Not now', 'Close'],
    th: ['เพิ่ม Robot Trade บนหน้าจอโฮม', 'เปิดแดชบอร์ดเทรดได้รวดเร็วด้วยทางลัดบนหน้าจอโฮม', 'เปิดใน Safari แตะ แชร์ แล้วเลือก เพิ่มไปยังหน้าจอโฮม หากมีตัวเลือก เปิดเป็นเว็บแอป ให้เปิด แล้วแตะ เพิ่ม', 'เปิดเมนูเบราว์เซอร์ (⋮) แล้วเลือก เพิ่มลงในหน้าจอหลัก หรือ ติดตั้งแอป หากไม่มีเมนูนี้ ให้เปิดหน้านี้ใน Chrome', 'ติดตั้ง', 'ไว้ภายหลัง', 'ปิด']
  };
  const dialog = document.createElement('dialog');
  dialog.id = 'installShortcut';
  dialog.setAttribute('aria-labelledby', 'installShortcutTitle');
  dialog.setAttribute('aria-describedby', 'installShortcutDescription installShortcutSteps');
  dialog.innerHTML = '<button type="button" class="install-close">×</button><span class="install-label">ROBOT TRADE</span><h2 id="installShortcutTitle"></h2><p id="installShortcutDescription"></p><p id="installShortcutSteps"></p><div class="install-actions"><button type="button" class="ghost install-later"></button><button type="button" class="primary install-now" hidden></button></div>';
  document.body.append(dialog);
  const installButton = dialog.querySelector('.install-now');
  function render() {
    const language = document.querySelector('#language')?.value === 'th' ? 'th' : 'en';
    const words = copy[language];
    for (const [selector, text] of [['h2', words[0]], ['#installShortcutDescription', words[1]], ['#installShortcutSteps', words[ios ? 2 : 3]], ['.install-now', words[4]], ['.install-later', words[5]]]) {
      const node = dialog.querySelector(selector);
      if (node.textContent !== text) node.textContent = text;
    }
    dialog.querySelector('.install-close').setAttribute('aria-label', words[6]);
    installButton.hidden = !deferredPrompt;
    dialog.querySelector('#installShortcutSteps').hidden = !!deferredPrompt;
  }
  function dismissed() {
    try { return memoryDismissed || Number(localStorage.getItem(cooldownKey)) > Date.now(); }
    catch { return memoryDismissed; }
  }
  function dismiss() {
    memoryDismissed = true;
    try { localStorage.setItem(cooldownKey, String(Date.now() + 7 * 86400000)); } catch {}
    dialog.close();
  }
  function show() {
    if (installed() || dismissed() || document.hidden || dialog.open || document.querySelector('dialog[open]')) return;
    // Do not interrupt someone typing credentials or editing trading settings.
    if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
    render();
    dialog.showModal();
  }
  dialog.querySelector('.install-close').addEventListener('click', dismiss);
  dialog.querySelector('.install-later').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  installButton.addEventListener('click', async () => {
    const prompt = deferredPrompt;
    if (!prompt) return;
    deferredPrompt = null;
    installButton.disabled = true;
    try {
      await prompt.prompt();
      await prompt.userChoice;
      dismiss();
    } catch { render(); }
    finally { installButton.disabled = false; }
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    if (dialog.open) render();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; memoryDismissed = true; dialog.close(); });
  standalone.addEventListener('change', () => { if (installed()) dialog.close(); });
  document.querySelector('#language')?.addEventListener('change', render);
  window.setTimeout(show, 8000);
})();
