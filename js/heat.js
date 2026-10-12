/*
 * Heizwarte — reine Heizlogik: Schwellen, Heizarten, Gradtagzahl, Nachtfenster, Ampel, Fahrplan und Lüftungsfenster
 * (ohne Date, Intl, DOM, localStorage und fetch)
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Keine Abhängigkeiten: alles kommt als Parameter
  const api = {};
  root.Heizwarte.heat = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
