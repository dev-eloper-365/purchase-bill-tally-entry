// Theme toggle: System -> Light -> Dark -> System. "System" (nothing in
// localStorage) is the default and tracks prefers-color-scheme live; the
// button lets a user pin Light or Dark instead. The actual theme
// attribute is already set synchronously in <head> before first paint -
// this file only wires up the button and keeps it in sync afterward.

(function () {
  var ICONS = {
    system:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    light:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>',
  };
  var LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  var ORDER = ['system', 'light', 'dark'];

  function getMode() {
    var stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  }

  function resolve(mode) {
    if (mode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return mode;
  }

  function apply(mode) {
    var resolved = resolve(mode);
    document.documentElement.setAttribute('data-theme-mode', mode);
    document.documentElement.setAttribute('data-theme', resolved);
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.innerHTML = ICONS[mode];
      btn.title = 'Theme: ' + LABELS[mode] + ' (click to change)';
    }
  }

  function init() {
    apply(getMode());

    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var current = getMode();
        var next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
        if (next === 'system') {
          localStorage.removeItem('theme');
        } else {
          localStorage.setItem('theme', next);
        }
        apply(next);
      });
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (getMode() === 'system') apply('system');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
