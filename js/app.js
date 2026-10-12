/*
 * Heizwarte — Zustand, Einrichtung, Rendern und Abruf. Als einzige Datei darf app.js beim Laden etwas tun.
 */
(function () {
  'use strict';

  function init() {
    // kommt mit den Bildschirmen: Migration, Sprache, Einrichtung oder Hauptbildschirm, Abruf, Service Worker
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
