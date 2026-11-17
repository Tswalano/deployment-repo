// Apply the saved theme (dark / light / system) before the app renders, so there is no flash.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('ops-theme') || 'system'; } catch (e) { /* storage blocked */ }
  var light = pref === 'light' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', light ? '#f5f6f8' : '#090b0f');
})();
