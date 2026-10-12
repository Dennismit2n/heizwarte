/*
 * Heizwarte — Ortssuche über Photon, Rangfolge der Treffer, Höhe, Rundung und Standortbestimmung
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen, nie oben in eine Konstante kopieren
  const api = {};
  root.Heizwarte.geo = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
