/*
 * Heizwarte — läuft im <head> vor dem ersten Paint (eigene Datei wegen der CSP, kein Inline-Skript).
 * Liest die Theme-Wahl hw:theme und setzt sie, bevor etwas gemalt wird (BAUPLAN Abschnitt 4 und 8):
 *  - Der Wert liegt als JSON im Speicher ("light" oder "dark", Schlüssel fehlt = System). storage.js ist hier noch nicht
 *    geladen, deshalb liest diese Datei den Schlüssel selbst und wirft nie.
 *  - Nur "light" und "dark" setzen data-theme am <html> und überschreiben beide <meta name="theme-color"> mit dem
 *    gewählten Ton. Bei „System“ bleibt alles, wie index.html es trägt: die zwei Metas mit media dunkel und hell
 *    und kein data-theme, dann entscheidet das System.
 * Die Töne stehen auch in app.js (THEME_COLOR), das sie beim Umschalten in den Einstellungen setzt; ein Test hält
 * beide Stellen und die Metas in index.html zusammen.
 *
 * Sehhilfen der Werkstatt (31.10.2026): Zuerst gilt die gemeinsame Wahl aller Werkzeuge, als TEXT unter
 * werkstatt.darstellung (alle liegen auf einem Ursprung). hw:theme bleibt der Rückfall. Acht Werte: System, light,
 * dark, hc-dark, hc-light, cvd-dark, cvd-light, invert. data-theme trägt hell/dunkel, data-vision Hoher Kontrast
 * (contrast), Farbenblind (cvd) und Umkehr (invert); bei „System“ mit „Kontrast erhöhen“ am Gerät gilt Hoher Kontrast.
 * Dieselbe Auflösung steht in app.js (visionOf). Im Hohen Kontrast tragen die Metas Schwarz bzw. Weiß.
 */
(function () {
  'use strict';
  try {
    const shared = localStorage.getItem('werkstatt.darstellung');
    let value = shared || JSON.parse(localStorage.getItem('hw:theme'));
    const known = ['light', 'dark', 'hc-dark', 'hc-light', 'cvd-dark', 'cvd-light', 'invert'];
    if (typeof value !== 'string') { value = null; }
    // ein Wert eines anderen Werkzeugs (Spectroton „soft-dark“) zählt als seine Familie
    if (value && known.indexOf(value) < 0) { value = /dark/.test(value) ? 'dark' : (/light/.test(value) ? 'light' : null); }
    let theme = null;
    let vision = null;
    if (value === 'light' || value === 'dark') { theme = value; }
    else if (value === 'hc-dark' || value === 'hc-light') { theme = value.slice(3); vision = 'contrast'; }
    else if (value === 'cvd-dark' || value === 'cvd-light') { theme = value.slice(4); vision = 'cvd'; }
    else if (value === 'invert') { vision = 'invert'; }
    else if (typeof matchMedia === 'function' && matchMedia('(prefers-contrast: more)').matches) {
      theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      vision = 'contrast';
    }
    if (theme) {
      const color = vision === 'contrast' ? (theme === 'light' ? '#FFFFFF' : '#000000') : (theme === 'light' ? '#F3F3F6' : '#111821');
      document.documentElement.setAttribute('data-theme', theme);
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      for (let i = 0; i < metas.length; i++) { metas[i].setAttribute('content', color); }
    }
    if (vision) { document.documentElement.setAttribute('data-vision', vision); }
  } catch (e) {
    // gesperrter Speicher, kein JSON oder kein DOM: dann gilt „System“, wie index.html es trägt
  }
})();

// Knopf „Installieren“ (Nachtrag 30.10.2026): Chrome, Edge und Samsung Internet melden die Installierbarkeit
// mit beforeinstallprompt, manchmal bevor app.js läuft. Das Ereignis bleibt hier liegen, bis app.js es abholt
// (renderInstall); ohne DOM (Node) passiert nichts.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredInstall = e;
    if (typeof window.onInstallReady === 'function') { window.onInstallReady(); }
  });
}
