/* Rinix Mail — Service Worker registration (kept separate from app.js so
   registration timing is independent of app boot / auth state). */
(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function (err) {
      console.warn("Rinix Mail: service worker registration failed:", err);
    });
  });
})();
