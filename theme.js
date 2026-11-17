// Follow the system theme until explicitly toggled, then persist the preference.
(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { const stored = localStorage.getItem('tabsir-theme'); if (['light', 'dark'].includes(stored)) preference = stored; } catch { /* System default. */ }
  const resolved = () => preference || (system.matches ? 'dark' : 'light');
  function apply() {
    document.documentElement.dataset.theme = resolved();
    document.querySelector('meta[name="color-scheme"]').content = resolved();
    const button = document.querySelector('#theme-toggle');
    if (button) {
      const label = `Switch to ${resolved() === 'dark' ? 'light' : 'dark'} mode`;
      button.setAttribute('aria-label', label); button.title = label;
    }
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelector('#theme-toggle')?.addEventListener('click', () => {
      preference = resolved() === 'dark' ? 'light' : 'dark'; apply();
      try { localStorage.setItem('tabsir-theme', preference); } catch { /* Current page still switches. */ }
    });
    system.addEventListener('change', () => { if (!preference) apply(); });
    window.addEventListener('storage', event => {
      if (event.key !== 'tabsir-theme' && event.key !== null) return;
      preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : undefined;
      apply();
    });
  });
})();
