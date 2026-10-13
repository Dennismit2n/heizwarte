/*
 * Heizwarte — Service Worker: hält die App-Hülle für den Start ohne Netz bereit.
 * Wetter- und Adressabfragen laufen an ihm vorbei (andere Origin), die Wetterdaten selbst
 * legt die Seite im localStorage ab. BAUPLAN Abschnitt 9; die Regeln für SHELL prüft
 * tests/shell.test.js.
 */
'use strict';

// Bürg war heizwarte-v1; der M1-Deploy geht schon mit heizwarte-v2 raus (BAUPLAN Abschnitt 9). Ab M2 bei
// jedem Deploy um 1 erhöhen (M2 → v3), zusammen mit den ?v=-Stempeln in index.html.
const CACHE = 'heizwarte-v4';

// Genau die Dateien, die index.html, das Manifest und css/style.css laden, mit denselben ?v=-Stempeln
// wie in index.html. Nichts darüber hinaus: eine Datei, die es nicht gibt, ließe addAll und damit
// die ganze Installation scheitern.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css?v=2026-10-13',
  './js/boot.js?v=2026-10-13',
  './js/storage.js?v=2026-10-13',
  './js/i18n.js?v=2026-10-13',
  './js/geo.js?v=2026-10-13',
  './js/weather.js?v=2026-10-13',
  './js/heat.js?v=2026-10-13',
  './js/chart.js?v=2026-10-13',
  './js/app.js?v=2026-10-13',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './assets/fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  './assets/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  './assets/fonts/atkinson-hyperlegible-latin-ext-400-normal.woff2',
  './assets/fonts/atkinson-hyperlegible-latin-ext-700-normal.woff2'
];

// Die ganze Hülle in den Cache, am HTTP-Cache des Browsers vorbei (cache: 'reload'). GitHub Pages schickt
// jede Datei mit max-age=600; mit dem Standardmodus käme ./ womöglich als alte Startseite aus dem HTTP-Cache,
// während die Skripte mit dem neuen ?v=-Stempel frisch geladen werden. activate löscht danach die alte Hülle,
// und ohne Netz verlangte die alte Startseite Skripte, die in keinem Cache mehr liegen: leere Seite.
// Einzige Stelle mit addAll, damit Installation und Selbstheilung gleich laden.
function fillShell(cache) {
  return cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(fillShell).then(() => self.skipWaiting()));
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
  if (!index) { await fillShell(cache); }
}

async function answer(e) {
  const req = e.request;
  const isNav = req.mode === 'navigate';
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);

  // Netzantwort holen und, wenn sie in Ordnung ist, für das nächste Mal ablegen (nie ein 404 oder 500).
  // Eine Navigation fragt dabei immer beim Server nach (no-cache: bedingte Anfrage mit ETag, meist nur 304),
  // sonst bekäme der Cache bis zu zehn Minuten lang die alte Startseite aus dem HTTP-Cache zu neuem Code.
  let stored = null;
  const net = fetch(req, isNav ? { cache: 'no-cache' } : undefined).then(r => {
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
