/* Rooted In Liberty: tiny visit, signup and download counter.
   Sends to our Cloudflare Worker. No cookies, nothing personal. */
(function () {
  var URL_BASE = 'https://ril-stats.cary-bergeron.workers.dev';
  function send(type, source) {
    if (!URL_BASE) return;
    var body = JSON.stringify({ type: type, source: source || '', page: location.pathname, referrer: document.referrer || '' });
    try {
      if (navigator.sendBeacon) { navigator.sendBeacon(URL_BASE + '/e', new Blob([body], { type: 'text/plain' })); return; }
    } catch (e) {}
    try { fetch(URL_BASE + '/e', { method: 'POST', body: body, keepalive: true, mode: 'cors' }); } catch (e) {}
  }
  window.rilTrack = send;
  var src = new URLSearchParams(location.search).get('src') || '';
  send('visit', src);
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href$=".pdf"]');
    if (a) send('download', a.getAttribute('data-src') || location.pathname.replace(/^\/|\.html$/g, '') || 'home');
  });
})();
