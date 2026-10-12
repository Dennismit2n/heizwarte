/*
 * Heizwarte — localStorage-Hülle: Schlüssel mit Präfix hw:, Rückfall im Speicher, Versionsstand und Migration
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Keine Abhängigkeiten: nur das Standard-Backend localStorage, und das nur in try/catch
  const api = {};
  root.Heizwarte.storage = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
