/*
 * Heizwarte — läuft im <head> vor dem ersten Paint (eigene Datei wegen der CSP, kein Inline-Skript).
 * M1–M2: setzt nur das Theme-Meta auf den dunklen Manifest-Ton; die Theme-Wahl kommt in M3.
 */
(function () {
  'use strict';
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.setAttribute('content', '#111821'); }
  } catch (e) {
    // ohne DOM oder bei gesperrtem Zugriff gibt es nichts zu setzen; die Meta-Zeile in index.html trägt denselben Wert
  }
})();
