/*
 * Heizwarte — Service Worker: hält die App-Hülle für den Start ohne Netz bereit.
 * Wetter- und Adressabfragen laufen an ihm vorbei (andere Origin), die Wetterdaten selbst
 * legt die Seite im localStorage ab. BAUPLAN Abschnitt 9; die Regeln für SHELL prüft
 * tests/shell.test.js.
 */
'use strict';

// Bei jedem Deploy um 1 erhöhen (zusammen mit den ?v=-Stempeln in index.html). Bürg war heizwarte-v1.
const CACHE = 'heizwarte-v2';

// Genau die Dateien, die index.html, das Manifest und css/style.css laden, mit denselben ?v=-Stempeln
// wie in index.html. Nichts darüber hinaus: eine Datei, die es nicht gibt, ließe addAll und damit
// die ganze Installation scheitern.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css?v=2026-10-12',
  './js/boot.js?v=2026-10-12',
  './js/storage.js?v=2026-10-12',
  './js/i18n.js?v=2026-10-12',
  './js/geo.js?v=2026-10-12',
  './js/weather.js?v=2026-10-12',
  './js/heat.js?v=2026-10-12',
  './js/chart.js?v=2026-10-12',
  './js/app.js?v=2026-10-12',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './assets/fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  './assets/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  './assets/fonts/atkinson-hyperlegible-latin-ext-400-normal.woff2',
  './assets/fonts/atkinson-hyperlegible-latin-ext-700-normal.woff2'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Nur eigene alte Hüllen löschen. Cache Storage gehört dem ganzen Origin, die Hüllen der anderen
// Werkzeuge auf dennismit2n.github.io (zum Beispiel bigday-v6) dürfen nicht angefasst werden.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('heizwarte-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Mehrere Geschwister-Werkzeuge löschen beim Aktivieren jeden fremden Cache, also auch diesen.
// Fehlt ./index.html im Cache, obwohl das Netz antwortet, holt der Worker die ganze Hülle nach,
// sonst scheiterte der nächste Start ohne Netz.
async function healShell(cache) {
  const index = await cache.match('./index.html');
  if (!index) { await cache.addAll(SHELL); }
}

async function answer(e) {
  const req = e.request;
  const isNav = req.mode === 'navigate';
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);

  // Netzantwort holen und, wenn sie in Ordnung ist, für das nächste Mal ablegen (nie ein 404 oder 500)
  let stored = null;
  const net = fetch(req).then(r => {
    if (r.ok) { stored = cache.put(req, r.clone()).catch(console.error); }
    return r;
  });

  // Arbeit im Hintergrund, die den Worker bis zu ihrem Ende am Leben hält. Fehlt das Netz, ist das
  // erwartbar und keine Meldung wert; ein Fehler beim Nachholen der Hülle dagegen schon.
  // Eine Navigation mit Netz prüft dabei, ob die Hülle noch vollständig im Cache liegt.
  const after = net.then(
    () => Promise.resolve(stored).then(() => (isNav ? healShell(cache).catch(console.error) : null)),
    () => null
  );
  e.waitUntil(after);

  // Stale-while-revalidate: den Altbestand sofort liefern, die Netzantwort erneuert ihn nebenbei
  if (hit) { return hit; }

  try {
    return await net;
  } catch (err) {
    // Kein Netz und nichts im Cache: eine Navigation bekommt die Startseite der App, alles andere den Fehler
    if (isNav) {
      const index = await cache.match('./index.html');
      if (index) { return index; }
    }
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  // Nur GET an die eigene Origin; Wetter-, Adress- und Höhenabfragen gehen direkt ans Netz
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) { return; }
  e.respondWith(answer(e));
});
