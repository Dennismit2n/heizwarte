/*
 * Heizwarte — Sprachtabelle, Spracherkennung, t() und Intl-Hilfen für Uhrzeit, Datum und Zahlen
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen (root.Heizwarte.storage), nie oben in eine Konstante kopieren
  const api = {};
  root.Heizwarte.i18n = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
