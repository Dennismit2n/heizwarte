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
 */
(function () {
  'use strict';
  try {
    const value = JSON.parse(localStorage.getItem('hw:theme'));
    if (value === 'light' || value === 'dark') {
      const color = value === 'light' ? '#F3F3F6' : '#111821';
      document.documentElement.setAttribute('data-theme', value);
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      for (let i = 0; i < metas.length; i++) { metas[i].setAttribute('content', color); }
    }
  } catch (e) {
    // gesperrter Speicher, kein JSON oder kein DOM: dann gilt „System“, wie index.html es trägt
  }
})();
