// public/splash.js
(() => {
  const DURATION_MS = 3500; // length of your splash.gif

  window.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    if (!splash) return;

    setTimeout(() => {
      // fade the splash
      splash.classList.add('hidden');

      // reveal the app (remove the “hide root” gate)
      document.documentElement.classList.remove('splash-active');

      // remove splash after fade-out completes
      setTimeout(() => splash.remove(), 520);
    }, DURATION_MS);
  });
})();
