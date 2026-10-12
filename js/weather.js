/*
 * Heizwarte — Abruf von Open-Meteo und Bright Sky, Zeitzonen-Modell auf unixtime, eine Wiederholung bei HTTP 429
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen, nie oben in eine Konstante kopieren
  const api = {};
  root.Heizwarte.weather = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
