// Applies the saved appearance and effects level before first paint, so nobody sees a flash of the wrong theme.
(function () {
  try {
    var raw = localStorage.getItem('gridiron.prefs.v1');
    var state = raw ? JSON.parse(raw).state || {} : {};
    var theme = state.theme;
    if (theme === 'system') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'dark' ? '#030806' : '#f8f6f1');
    }
    if (state.effects === 'full' || state.effects === 'reduced' || state.effects === 'flat') {
      document.documentElement.setAttribute('data-effects', state.effects);
    }
  } catch (e) {
    /* storage unavailable: keep the Night default */
  }
})();
