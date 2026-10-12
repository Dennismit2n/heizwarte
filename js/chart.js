/*
 * Heizwarte — Temperaturfarben, Wettersymbole, Kurve als SVG-String (layout) getrennt von der Bedienung (bind) und Textzusammenfassung
 *
 * Stand dieses Schritts: tcol() mit der dunklen Ankertabelle und icon(). Die Kurve (layout, summary, bind),
 * die Skala (scaleCss) und die helle Ankertabelle kommen in späteren Schritten dazu.
 * Nichts hier fasst das DOM an: beide Funktionen liefern Zeichenketten.
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen, nie oben in eine Konstante kopieren

  // Anker [°C, L %, C, H] wie Bürg index:222. EINE Abweichung: der −10-°C-Anker ist von [-10,55,.14,275] auf
  // [-10,62,.13,275] gehoben. Bürgs Wert ergibt nur 3,49:1 auf --surface; tcol() färbt aber echten Kleintext
  // (Tagesspanne, Nachttief). Mit dem gehobenen Anker liegen laut Plan (Abschnitt 5 chart) alle 22 Stufen
  // der Skala über 4,5:1; der Kontrasttest dazu kommt in Meilenstein 3. °C-Anker −10/0/10/18/25/32 bleiben (B:44).
  const ANCH_DARK = [[-10, 62, 0.13, 275], [0, 72, 0.11, 245], [10, 85, 0.05, 210], [18, 88, 0.08, 90], [25, 76, 0.16, 58], [32, 63, 0.20, 28]];

  // scheme → Ankertabelle. Die helle Tabelle (ANCH_LIGHT) kommt mit dem Theme in Meilenstein 3.
  const ANCHORS = { dark: ANCH_DARK };

  // Neutrale Mitte der Skala für Werte ohne Zahl
  const NEUTRAL_C = 10;

  // Farbe zur Temperatur t (°C) als 'oklch(L% C H[ / a])'. Formel wie Bürg index:224–228: Segment suchen,
  // L, C und H linear mischen. Der Farbton läuft numerisch linear, nicht auf dem kürzeren Kreisbogen
  // (210 → 90 läuft über 150, Grün); unter −10 und über 32 bleibt die Farbe auf dem Randanker.
  // Kein Wert (null, NaN) ergibt die neutrale Mitte statt 'oklch(NaN% …)'.
  function tcol(t, alpha, scheme) {
    const A = ANCHORS[scheme] || ANCHORS.dark;
    const x = typeof t === 'number' && Number.isFinite(t) ? t : NEUTRAL_C;
    let i = 0;
    if (x <= A[0][0]) { i = 0; }
    else if (x >= A[A.length - 1][0]) { i = A.length - 2; }
    else { while (x > A[i + 1][0]) { i++; } }
    const lo = A[i];
    const hi = A[i + 1];
    const f = Math.max(0, Math.min(1, (x - lo[0]) / (hi[0] - lo[0])));
    const L = lo[1] + (hi[1] - lo[1]) * f;
    const C = lo[2] + (hi[2] - lo[2]) * f;
    const H = lo[3] + (hi[3] - lo[3]) * f;
    const a = alpha !== undefined && alpha !== null ? ' / ' + alpha : '';
    return 'oklch(' + L.toFixed(1) + '% ' + C.toFixed(3) + ' ' + H.toFixed(1) + a + ')';
  }

  // ---------------------------------------------------------------------------------------------
  // Wettersymbole
  // ---------------------------------------------------------------------------------------------

  function r2(x) {
    return Math.round(x * 100) / 100;
  }

  // Sonne mit acht Strahlen (Bürg index:250); Farben nur als var(--ic-*), die CSS setzt die Werte je Theme
  function sunShape() {
    let rays = '';
    for (let k = 0; k < 8; k++) {
      const a = k * 45 * Math.PI / 180;
      rays += '<line x1="' + r2(12 + 7 * Math.cos(a)) + '" y1="' + r2(12 + 7 * Math.sin(a)) +
        '" x2="' + r2(12 + 9.2 * Math.cos(a)) + '" y2="' + r2(12 + 9.2 * Math.sin(a)) + '"/>';
    }
    return '<circle cx="12" cy="12" r="4.2" fill="var(--ic-sun)"/>' +
      '<g stroke="var(--ic-sun)" stroke-width="1.6" stroke-linecap="round">' + rays + '</g>';
  }

  function moonShape() {
    return '<path d="M15.5 4.5a7.5 7.5 0 1 0 4 12.8 6 6 0 0 1-4-12.8z" fill="var(--ic-moon)"/>';
  }

  function cloudShape(colorVar) {
    return '<path d="M7 19h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.4A3.4 3.4 0 0 0 7 19z" fill="var(' + colorVar + ')"/>';
  }

  // SVG-String zum WMO-Code, rein dekorativ (aria-hidden): der Wettertext steht immer daneben.
  // Zuordnung wie Bürg index:248–262. Ein Code ohne Zahl zählt als bedeckt, wie bei Bürg (?? 3).
  // Gewitterwolke: Bürg nimmt dafür ein dunkleres Grau (60 %) als für „bedeckt“ (66 %); hier teilen sich
  // beide --ic-cloud-dark, weil der Plan nur diese eine Variable kennt (Abschnitt 8).
  function icon(code, isDay, size) {
    const c = typeof code === 'number' && Number.isFinite(code) ? code : 3;
    const day = isDay !== false && isDay !== 0;
    const s = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 30;
    let g;
    if (c <= 1) {
      g = day ? sunShape() : moonShape();
    } else if (c === 2) {
      g = '<g transform="translate(-3 -4) scale(.8)">' + (day ? sunShape() : moonShape()) + '</g>' + cloudShape('--ic-cloud');
    } else if (c === 3) {
      g = cloudShape('--ic-cloud-dark');
    } else if (c === 45 || c === 48) {
      g = '<g stroke="var(--ic-fog)" stroke-width="2" stroke-linecap="round">' +
        '<line x1="4" y1="9" x2="20" y2="9"/><line x1="3" y1="13" x2="18" y2="13"/><line x1="6" y1="17" x2="21" y2="17"/></g>';
    } else if ((c >= 71 && c <= 77) || c === 85 || c === 86) {
      g = '<g transform="translate(0 -3)">' + cloudShape('--ic-cloud') + '</g>' +
        '<g fill="var(--ic-snow)"><circle cx="8" cy="21" r="1.3"/><circle cx="12.5" cy="22.5" r="1.3"/><circle cx="17" cy="21" r="1.3"/></g>';
    } else if (c >= 95) {
      g = '<g transform="translate(0 -3)">' + cloudShape('--ic-cloud-dark') + '</g>' +
        '<path d="M12.5 15l-3 5h3l-1.5 4 4.5-6h-3l1.5-3z" fill="var(--ic-bolt)"/>';
    } else {
      g = '<g transform="translate(0 -3)">' + cloudShape('--ic-cloud') + '</g>' +
        '<g stroke="var(--ic-rain)" stroke-width="1.7" stroke-linecap="round">' +
        '<line x1="8" y1="19" x2="7" y2="22.5"/><line x1="12.5" y1="19" x2="11.5" y2="22.5"/><line x1="17" y1="19" x2="16" y2="22.5"/></g>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 25" aria-hidden="true" focusable="false">' + g + '</svg>';
  }

  const api = { ANCH_DARK, tcol, icon };
  root.Heizwarte.chart = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
