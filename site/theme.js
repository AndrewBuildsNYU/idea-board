// Puts the viewer's saved theme on <html> before the first paint. Loaded as a
// plain, non-deferred script so a saved choice never flashes the default.
// The theme is a per-person preference, so it lives in this browser only.
(function () {
  try {
    var theme = localStorage.getItem('idea-board:theme');
    if (theme && theme !== 'auto') document.documentElement.setAttribute('data-theme', theme);
  } catch (error) {
    // Storage blocked: the device's light/dark setting decides.
  }
})();
