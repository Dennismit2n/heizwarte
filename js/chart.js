/*
 * Heizwarte — Temperaturfarben, Wettersymbole, Kurve als SVG-String (layout) getrennt von der Bedienung (bind) und Textzusammenfassung
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen, nie oben in eine Konstante kopieren
  const api = {};
  root.Heizwarte.chart = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
