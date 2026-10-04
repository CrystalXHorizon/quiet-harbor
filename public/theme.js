// Run before styles paint; appearance works independently of account startup.
(() => {
  const key = 'qh-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = valid(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
    });
    const opener = document.getElementById('appearance-open');
    const label = `外观设置（当前：${theme === 'dark' ? '深色' : '浅色'}）`;
    if (opener) { opener.setAttribute('aria-label', label); opener.title = label; }
    const summary = document.getElementById('theme-summary');
    if (summary) summary.textContent = preference === 'system'
      ? `正在跟随系统，当前为${theme === 'dark' ? '深色' : '浅色'}。`
      : `已使用${theme === 'dark' ? '深色' : '浅色'}模式。`;
  }

  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.addEventListener('click', () => {
        preference = valid(button.dataset.themeChoice);
        try { localStorage.setItem(key, preference); } catch { /* Still apply for this page. */ }
        apply();
      });
    });
    const dialog = document.getElementById('appearance-dialog');
    document.querySelectorAll('[data-theme-open]').forEach(button => {
      button.addEventListener('click', () => {
        button.closest('dialog')?.close();
        if (dialog && !dialog.open) dialog.showModal();
      });
    });
    // Keep the appearance dialog usable even if the account bundle fails to load.
    dialog?.querySelector('[data-theme-close]')?.addEventListener('click', () => dialog.close());
    apply();
  }, { once: true });
})();
