/*
 * Heizwarte — Temperaturfarben, Wettersymbole, Kurve als SVG-String (layout) getrennt von der Bedienung (bind) und Textzusammenfassung
 *
 * tcol() und scaleCss() mit der dunklen und der hellen Ankertabelle, icon() für die Wettersymbole, dazu die Kurve der
 * nächsten 72 Stunden: layout() baut den SVG-String nach Bürg index:447–484, summary() fasst Tiefst- und Höchstwert
 * für den Satz unter der Kurve zusammen, bind() hängt den Zeiger-Tooltip an (Bürg index:487–502).
 * Nur bind() fasst das DOM an; alles andere liefert Zeichenketten und Zahlen.
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen, nie oben in eine Konstante kopieren

  // Anker [°C, L %, C, H] wie Bürg index:222. EINE Abweichung: der −10-°C-Anker ist von [-10,55,.14,275] auf
  // [-10,62,.13,275] gehoben. Bürgs Wert ergibt nur 3,49:1 auf --surface; tcol() färbt aber echten Kleintext
  // (Tagesspanne, Nachttief). Mit dem gehobenen Anker liegen laut Plan (Abschnitt 5 chart) alle 22 Stufen
  // der Skala über 4,5:1 (tests/contrast.test.js hält das fest). °C-Anker −10/0/10/18/25/32 bleiben (B:44).
  const ANCH_DARK = [[-10, 62, 0.13, 275], [0, 72, 0.11, 245], [10, 85, 0.05, 210], [18, 88, 0.08, 90], [25, 76, 0.16, 58], [32, 63, 0.20, 28]];

  // Helle Ankertabelle (Theme hell): gleiche C und H, L auf 42–48 % gesenkt, damit jede Stufe als Text auf #FFFFFF und
  // #F3F3F6 mindestens 4,5:1 erreicht (tests/contrast.test.js, der Test schlägt fehl statt die Werte anzupassen).
  // Der 18-°C-Anker ist bewusst Braunocker (H 90, L 46): kein Gelb hält auf Weiß. Die Werte sind die aus dem Plan; die
  // Prüfung ergab keinen Anlass, sie zu ändern (kleinstes Verhältnis 5,74:1 bei 10 °C auf #F3F3F6).
  const ANCH_LIGHT = [[-10, 42, 0.14, 275], [0, 45, 0.11, 245], [10, 48, 0.05, 210], [18, 46, 0.08, 90], [25, 46, 0.16, 58], [32, 44, 0.20, 28]];

  // scheme → Ankertabelle; ein unbekanntes scheme gilt als dunkel (Standard der App, Dennis ist lichtempfindlich)
  const ANCHORS = { dark: ANCH_DARK, light: ANCH_LIGHT };

  // Neutrale Mitte der Skala für Werte ohne Zahl
  const NEUTRAL_C = 10;

  // Farbe zur Temperatur t (°C) als 'oklch(L% C H[ / a])'. Formel wie Bürg index:224–228: Segment suchen,
  // L, C und H linear mischen. Der Farbton läuft numerisch linear, nicht auf dem kürzeren Kreisbogen
  // (210 → 90 läuft über 150, Grün); unter −10 und über 32 bleibt die Farbe auf dem Randanker.
  // Kein Wert (null, NaN) ergibt die neutrale Mitte statt 'oklch(NaN% …)'. scheme 'dark' (Standard) oder 'light'.
  function tcol(t, alpha, scheme) {
    const A = scheme === 'light' ? ANCHORS.light : ANCHORS.dark;
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

  // Farbverlauf der Skala unter der Kurve: 22 Stützstellen von −10 bis 32 °C in 2-K-Schritten (Bürg index:230), als Wert
  // für el.style.setProperty('background', …) (CSSOM, mit der CSP vereinbar).
  function scaleCss(scheme) {
    const stops = [];
    for (let k = 0; k < 22; k++) { stops.push(tcol(-10 + k * 2, undefined, scheme)); }
    return 'linear-gradient(90deg,' + stops.join(',') + ')';
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

  // ---------------------------------------------------------------------------------------------
  // Kurve: die 72 Stunden ab Mitternacht von heute (Bürg index:447–503)
  // ---------------------------------------------------------------------------------------------

  const HOUR_MS = 3600000;
  // Weiter als so viele Meter weg zeichnet die Kurve keine zweite Meinung (MOSMIX). Dieselbe Grenze wie MOS_NEAR_M in
  // app.js (Legende und Fahrplan); Annahme 25 km, KT §6.1.
  const MOS_NEAR_M = 25000;
  // Höhe des Regenbalkens bei 100 % (Bürg „PB“, index:448)
  const RAIN_H = 34;
  // Platz um die Zeichnung; L ist 36 statt Bürgs 30, damit „−12°“ links nicht abgeschnitten wird
  const PAD_L = 36;
  const PAD_R = 8;
  const PAD_T = 16;
  const PAD_B = 40;
  // So viele Einheiten vom Rand entfernt kippt die Beschriftung nach innen (Tiefstwert-Label, „jetzt“)
  const EDGE = 24;
  // Gedankenstrich, den i18n.wmo() für einen unbekannten Code liefert
  const DASH = '–';

  function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  // Zahl für das SVG auf d Nachkommastellen, nie NaN und nie „-0“
  function rnd(x, d) {
    if (!isNum(x)) { return '0'; }
    const k = Math.pow(10, d);
    return String(Math.round(x * k) / k + 0);
  }

  function f2(x) {
    return rnd(x, 2);
  }

  // Text für ein SVG-Textelement: die Beschriftungen kommen aus eigenen Tabellen und Intl, werden aber trotzdem maskiert
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // <text> mit Füllfarbe als Attribut (nicht per CSS: eine CSS-Regel schlüge das Attribut)
  function txt(x, y, anchor, fill, content, extra) {
    return '<text x="' + f2(x) + '" y="' + f2(y) + '" text-anchor="' + anchor + '" fill="' + fill + '"' + (extra || '') + '>' +
      esc(content) + '</text>';
  }

  // Die Stunden der Kurve: heute (verdict.D[0]) und die zwei folgenden Ortstage, in der Reihenfolge des Modells. Ohne
  // Ampel-Tage (zu alte Daten) oder ohne Stunden gibt es kein Fenster: null.
  function windowOf(model, verdict) {
    const first = verdict && Array.isArray(verdict.D) ? verdict.D[0] : null;
    if (!model || !Array.isArray(model.hours) || !first || !isNum(first.idx)) { return null; }
    const hs = model.hours.filter((o) => o && isNum(o.ms) && isNum(o.temp) && o.dayIdx >= first.idx && o.dayIdx <= first.idx + 2);
    return hs.length ? hs : null;
  }

  // Liegt eine MOSMIX-Station nah genug für eine zweite Meinung? Ohne Entfernung nie (null <= 25000 wäre wahr)
  function mosNear(model) {
    const s = model && model.mosStation;
    return !!s && isNum(s.distance) && s.distance <= MOS_NEAR_M;
  }

  // Die Kurve als SVG-String: Temperatur der nächsten 72 Stunden mit Farbverlauf nach tcol(), Nachtbänder aus den
  // Läufen ohne Tageslicht, Regenbalken, die zweite Meinung (MOSMIX) gestrichelt und nur bei naher Station, die Tiefst-
  // werte der Nächte und die Marke „jetzt“. Farben nur als var(--…) (CSS je Theme) und tcol() (Temperaturfarbe);
  // kein style-Attribut, damit die CSP hält.
  //   model, verdict   weather.model() und heat.assess(): das Fenster beginnt bei verdict.D[0], die Nächte stehen in
  //                    verdict.nights (atMs, min)
  //   now              weather.localNow(): Marke „jetzt“ (now.ms)
  //   opts.width       Breite der Zeichenfläche in Pixeln, geklemmt auf 320 bis 720 (Rückfall 720)
  //   opts.scheme      'dark' (Standard) oder 'light'
  //   opts.labels      { today, tomorrow, now, wday(ms), hour(ms) }: fertige Texte der Sprache (wday ist der lange
  //                    Wochentag, hour die Uhrzeit einer Stundenmarke in der Ortszeit; ohne hour steht die Ortsstunde)
  //   opts.fmt         { deg(x, digits) }: Grad mit „°“ in der Sprache
  // Ergebnis: markup (ein vollständiges <svg>, das app.js in das leere <svg role="img"> der Seite setzt), die Maße W, H,
  // L, R, T, B, xs (x je Stunde), hs (die Stunden des Modells) und, für bind(): ys (y je Stunde), scheme, mos (wird die
  // zweite Meinung gezeichnet). Ohne Fenster: markup '' und leere Listen.
  function layout(model, verdict, now, opts) {
    const o = opts || {};
    const scheme = o.scheme === 'light' ? 'light' : 'dark';
    const labels = o.labels || {};
    const fmt = o.fmt || {};
    const deg = typeof fmt.deg === 'function' ? fmt.deg : (v) => f2(v) + '°';
    const W = Math.round(Math.min(720, Math.max(320, isNum(o.width) && o.width > 0 ? o.width : 720)));
    const H = W < 520 ? 250 : 280;
    const L = PAD_L;
    const R = PAD_R;
    const T = PAD_T;
    const B = PAD_B;
    const out = { markup: '', W, H, L, R, T, B, xs: [], hs: [], ys: [], scheme, mos: false };
    const win = windowOf(model, verdict);
    if (!win) { return out; }

    // Zeitachse: von der ersten Stunde bis zum Ende der letzten; jede Stunde hat einen Streifen von x(ms) an
    const start = win[0].ms;
    const end = win[win.length - 1].ms + HOUR_MS;
    const span = end - start;
    const pw = W - L - R;
    const ph = H - T - B;
    const x = (ms) => L + (ms - start) / span * pw;

    // Temperaturachse: Spanne aus Hauptprognose (und zweiter Meinung, wenn sie gezeichnet wird), auf gerade Zahlen
    // gerundet und um 1 Grad aufgeweitet (Bürg index:453–456)
    // Gezeichnet wird sie erst ab zwei Werten im Fenster: ein einzelner Wert ergäbe einen Pfad „M x y“ ohne Strich,
    // und die Legende verspräche eine Linie, die es nicht gibt
    const mosOn = mosNear(model) && win.filter((h) => isNum(h.mos)).length >= 2;
    const temps = [];
    for (const h of win) {
      temps.push(h.temp);
      if (mosOn && isNum(h.mos)) { temps.push(h.mos); }
    }
    const tmin = Math.floor(Math.min.apply(null, temps) / 2) * 2 - 1;
    const tmax = Math.ceil(Math.max.apply(null, temps) / 2) * 2 + 1;
    const y = (v) => T + (tmax - v) / (tmax - tmin) * ph;

    // Verläufe: tg färbt Linie und Fläche nach der Temperatur an der Stelle; tf und fm lassen die Fläche nach unten
    // ausblenden (weiß ist hier nur Maske, keine sichtbare Farbe)
    let s = '<defs><linearGradient id="tg" gradientUnits="userSpaceOnUse" x1="0" y1="' + f2(y(tmax)) + '" x2="0" y2="' + f2(y(tmin)) + '">';
    for (let k = 0; k <= 12; k++) {
      s += '<stop offset="' + rnd(k / 12, 4) + '" stop-color="' + tcol(tmax - (tmax - tmin) * k / 12, undefined, scheme) + '"/>';
    }
    s += '</linearGradient><linearGradient id="tf" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<mask id="fm"><rect x="0" y="0" width="' + W + '" height="' + H + '" fill="url(#tf)"/></mask></defs>';

    // Nachtbänder: je ein Lauf zusammenhängender Stunden ohne Tageslicht (hourly.is_day, nicht Sonnenauf- und -untergang)
    let run = null;
    win.forEach((h, i) => {
      if (!h.isDay && run === null) { run = h.ms; }
      if (run !== null && (h.isDay || i === win.length - 1)) {
        const to = h.isDay ? h.ms : end;
        s += '<rect class="chart-night" x="' + f2(x(run)) + '" y="' + T + '" width="' + f2(x(to) - x(run)) + '" height="' + ph +
          '" fill="var(--chart-night)"/>';
        run = null;
      }
    });

    // Gitter und Beschriftung der Temperaturachse; die Nulllinie ist dicker und durchgezogen
    const step = tmax - tmin > 14 ? 4 : 2;
    for (let v = Math.ceil(tmin / step) * step; v <= tmax; v += step) {
      const yy = y(v);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + f2(yy) + '" y2="' + f2(yy) + '" stroke="var(--chart-grid)" stroke-width="' +
        (v === 0 ? '1.4' : '.7') + '"' + (v === 0 ? '' : ' stroke-dasharray="2 4"') + '/>';
      s += txt(L - 6, yy + 4, 'end', 'var(--faint)', deg(v, 0));
    }

    // Regenbalken: Höhe = Wahrscheinlichkeit, Deckkraft wächst mit ihr
    const bw = Math.max(1, pw * HOUR_MS / span - 2);
    for (const h of win) {
      if (isNum(h.pp) && h.pp > 0) {
        const pp = Math.min(100, h.pp);
        const bh = pp / 100 * RAIN_H;
        s += '<rect class="chart-rain" x="' + f2(x(h.ms) + 1) + '" y="' + f2(H - B - bh) + '" width="' + f2(bw) + '" height="' + f2(bh) +
          '" fill="var(--chart-rain)" fill-opacity="' + rnd(0.25 + pp / 200, 3) + '" rx="1"/>';
      }
    }

    // Tagesgrenzen, Tagesnamen (in der Mitte des Tages) und die Stundenmarken
    const dayRuns = [];
    for (const h of win) {
      const last = dayRuns[dayRuns.length - 1];
      if (last && last.idx === h.dayIdx) {
        last.endMs = h.ms + HOUR_MS;
      } else {
        dayRuns.push({ idx: h.dayIdx, startMs: h.ms, endMs: h.ms + HOUR_MS });
      }
    }
    dayRuns.forEach((d, k) => {
      if (k > 0) {
        s += '<line class="chart-day" x1="' + f2(x(d.startMs)) + '" x2="' + f2(x(d.startMs)) + '" y1="' + T + '" y2="' + (H - B + 6) +
          '" stroke="var(--chart-grid)" stroke-width="1.2"/>';
      }
      const mid = (d.startMs + d.endMs) / 2;
      const name = k === 0 ? labels.today : (k === 1 ? labels.tomorrow : (typeof labels.wday === 'function' ? labels.wday(mid) : ''));
      if (name) { s += txt(x(mid), H - 12, 'middle', 'var(--muted)', name); }
    });
    // Stundenmarken: die Uhrzeit in der Form der Sprache (12 h in en, hi, ko) aus labels.hour; ohne sie die Ortsstunde
    const ticks = W < 520 ? [12] : [6, 18];
    const hourText = typeof labels.hour === 'function' ? (h) => labels.hour(h.ms) : (h) => String(h.h);
    for (const h of win) {
      if (ticks.indexOf(h.h) >= 0) { s += txt(x(h.ms), H - B + 14, 'middle', 'var(--faint)', hourText(h)); }
    }

    // Linien: Fläche unter der Hauptprognose, zweite Meinung gestrichelt (überspringt Stunden ohne Wert), Hauptprognose
    const pts = (key) => win.filter((h) => isNum(h[key])).map((h, i) => (i ? 'L' : 'M') + f2(x(h.ms)) + ' ' + f2(y(h[key]))).join('');
    const line = pts('temp');
    s += '<path d="' + line + ' L' + f2(x(win[win.length - 1].ms)) + ' ' + (H - B) + ' L' + f2(x(start)) + ' ' + (H - B) +
      ' Z" fill="url(#tg)" mask="url(#fm)"/>';
    if (mosOn) {
      s += '<path class="chart-mos" d="' + pts('mos') + '" fill="none" stroke="var(--chart-mos)" stroke-width="1.4" stroke-dasharray="4 3"/>';
    }
    s += '<path class="chart-line" d="' + line + '" fill="none" stroke="url(#tg)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';

    // Tiefstwert jeder Nacht im Fenster: Punkt in der Temperaturfarbe, Zahl darunter (oder darüber, wenn unten kein Platz ist).
    // Die Zahl steht auf Nachtband und Verlaufsfläche; ein Hof in der Grundfarbe (--bg, wie am Punkt) hält ihren Kontrast
    // bei den 4,5:1, die contrast.test.js für jede Stufe gegen --bg prüft
    const anchorOf = (cx) => (cx < L + EDGE ? 'start' : (cx > W - R - EDGE ? 'end' : 'middle'));
    for (const n of (verdict && Array.isArray(verdict.nights) ? verdict.nights : [])) {
      if (!n || !isNum(n.atMs) || !isNum(n.min) || n.atMs < start || n.atMs >= end) { continue; }
      const cx = x(n.atMs);
      const cy = y(n.min);
      const col = tcol(n.min, undefined, scheme);
      s += '<circle class="chart-nightmin" cx="' + f2(cx) + '" cy="' + f2(cy) + '" r="4.5" fill="' + col + '" stroke="var(--bg)" stroke-width="2"/>';
      s += txt(cx, cy + 18 <= H - B - 2 ? cy + 18 : cy - 10, anchorOf(cx), col, deg(n.min, 1),
        ' font-weight="700" stroke="var(--bg)" stroke-width="3" stroke-linejoin="round" paint-order="stroke"');
    }

    // Marke „jetzt“, nur wenn die Zeit im Fenster liegt
    const nowMs = now && isNum(now.ms) ? now.ms : null;
    if (nowMs !== null && nowMs >= start && nowMs < end) {
      const nx = x(nowMs);
      s += '<line class="chart-now" x1="' + f2(nx) + '" x2="' + f2(nx) + '" y1="' + (T - 4) + '" y2="' + (H - B) + '" stroke="var(--fg)" stroke-width="1.2"/>';
      if (labels.now) { s += txt(nx, T - 5, anchorOf(nx), 'var(--fg)', labels.now, ' font-size="11"'); }
    }

    // Zeiger für bind(): Linie und Punkt, zu Beginn unsichtbar
    s += '<line id="chartCur" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--fg)" stroke-width="1" opacity="0"/>' +
      '<circle id="chartDot" cx="0" cy="0" r="5" fill="var(--fg)" stroke="var(--bg)" stroke-width="2" opacity="0"/>';

    out.markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" font-size="12" aria-hidden="true" focusable="false">' + s + '</svg>';
    out.xs = win.map((h) => Math.round(x(h.ms) * 100) / 100);
    out.ys = win.map((h) => Math.round(y(h.temp) * 100) / 100);
    out.hs = win;
    out.mos = mosOn;
    return out;
  }

  // Tiefster und höchster Wert der Hauptprognose im Fenster der Kurve (erste Stunde bei Gleichstand), für den Satz
  // unter der Kurve. Ohne Fenster null.
  function summary(model, verdict) {
    const win = windowOf(model, verdict);
    if (!win) { return null; }
    let lo = win[0];
    let hi = win[0];
    for (const h of win) {
      if (h.temp < lo.temp) { lo = h; }
      if (h.temp > hi.temp) { hi = h; }
    }
    return { min: lo.temp, minMs: lo.ms, max: hi.temp, maxMs: hi.ms };
  }

  // Tooltip an die Kurve hängen (Bürg index:487–502). Zeiger über der Kurve, Tippen oder Ziehen mit dem Finger zeigt die
  // nächste Stunde: senkrechte Linie, Punkt in der Temperaturfarbe und ein Kasten mit den Werten. Aller Text geht per
  // textContent hinein, die Farbe per CSSOM (nie ein style-Attribut). Mit der Maus verschwindet der Kasten beim Verlassen,
  // mit dem Finger bleibt er, bis außerhalb getippt wird (ein Tippen würde ihn sonst nur aufblitzen lassen).
  //   svgEl, tipEl   das leere <svg> der Seite (mit dem Ergebnis von layout() gefüllt) und der Kasten
  //   lay            das Ergebnis von layout()
  //   opts.fmt       { deg(x, digits), num(x, digits), time(ms), wday(ms) (kurz), wmo(code) }
  //   opts.t         t(key, vars)
  // Gibt unbind zurück: nimmt alle Handler wieder ab und blendet den Kasten aus.
  function bind(svgEl, tipEl, lay, opts) {
    const none = function () {};
    if (!svgEl || !tipEl || !lay || !Array.isArray(lay.xs) || !lay.xs.length || !isNum(lay.W) || !svgEl.ownerDocument) { return none; }
    const o = opts || {};
    const fmt = o.fmt || {};
    const t = typeof o.t === 'function' ? o.t : function (key) { return key; };
    const deg = typeof fmt.deg === 'function' ? fmt.deg : function (v) { return f2(v) + '°'; };
    const num = typeof fmt.num === 'function' ? fmt.num : function (v) { return f2(v); };
    const doc = svgEl.ownerDocument;
    const cur = svgEl.querySelector('#chartCur');
    const dot = svgEl.querySelector('#chartDot');
    let shown = -1;

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) { node.className = className; }
      if (text !== undefined) { node.textContent = text; }
      return node;
    }

    function join(parts, sep) {
      return parts.filter(Boolean).join(sep);
    }

    function hide() {
      tipEl.hidden = true;
      if (cur) { cur.setAttribute('opacity', '0'); }
      if (dot) { dot.setAttribute('opacity', '0'); }
      shown = -1;
    }

    // Kasten füllen: Kopfzeile, Temperatur in ihrer Farbe samt gefühlter, dann Wind, Regen, Feuchte und Taupunkt, zuletzt
    // die zweite Meinung. Eine Zeile ohne Werte entfällt.
    function fill(k) {
      const h = lay.hs[k];
      const col = tcol(h.temp, undefined, lay.scheme);
      if (cur) {
        cur.setAttribute('x1', String(lay.xs[k]));
        cur.setAttribute('x2', String(lay.xs[k]));
        cur.setAttribute('opacity', '0.5');
      }
      if (dot) {
        dot.setAttribute('cx', String(lay.xs[k]));
        dot.setAttribute('cy', String(lay.ys[k]));
        dot.setAttribute('fill', col);
        dot.setAttribute('opacity', '1');
      }
      tipEl.replaceChildren();
      const when = join([typeof fmt.wday === 'function' ? fmt.wday(h.ms) : '', typeof fmt.time === 'function' ? fmt.time(h.ms) : ''], ' ');
      const sky = typeof fmt.wmo === 'function' ? fmt.wmo(h.code) : '';
      tipEl.appendChild(el('div', 'chart-tip-head', join([when, sky === DASH ? '' : sky], ' · ')));
      const main = el('div', 'chart-tip-main');
      const big = el('b', '', deg(h.temp, 1));
      big.style.setProperty('color', col);
      main.appendChild(big);
      if (isNum(h.app)) { main.appendChild(el('span', 'chart-tip-feels', t('nowFeels', { t: deg(h.app, 0) }))); }
      tipEl.appendChild(main);
      const lines = [
        [isNum(h.wind) ? t('nowWind', { kmh: num(h.wind, 0) }) : '', isNum(h.gust) ? t('dayGust', { kmh: num(h.gust, 0) }) : ''],
        [isNum(h.pp) ? t('chartTipRain', { p: num(h.pp, 0) }) : '', isNum(h.pr) && h.pr > 0 ? t('dayRain', { mm: num(h.pr, 1) }) : ''],
        [isNum(h.rh) ? t('nowHumidity', { p: num(h.rh, 0) }) : '', isNum(h.dew) ? t('chartTipDew', { t: deg(h.dew, 1) }) : ''],
        [lay.mos && isNum(h.mos) ? t('chartTipMos', { t: deg(h.mos, 1) }) : '']
      ];
      for (const parts of lines) {
        const text = join(parts, ' · ');
        if (text) { tipEl.appendChild(el('div', 'chart-tip-line', text)); }
      }
      tipEl.hidden = false;
    }

    // Der Kasten sitzt oben, auf der Höhe der Stunde, und bleibt ganz im Bild
    function place(k, width) {
      const bx = lay.xs[k] / lay.W * width;
      const tw = tipEl.offsetWidth || 0;
      tipEl.style.left = Math.min(width - tw / 2 - 4, Math.max(tw / 2 + 4, bx)) + 'px';
    }

    function pick(ev) {
      const r = svgEl.getBoundingClientRect();
      if (!(r.width > 0) || !isNum(ev.clientX)) { return; }
      const px = (ev.clientX - r.left) / r.width * lay.W;
      let k = 0;
      let best = Infinity;
      for (let i = 0; i < lay.xs.length; i++) {
        const d = Math.abs(lay.xs[i] - px);
        if (d < best) { best = d; k = i; }
      }
      if (k !== shown || tipEl.hidden) {
        fill(k);
        shown = k;
      }
      place(k, r.width);
    }

    function onLeave(ev) {
      if (ev.pointerType !== 'touch') { hide(); }
    }

    function onOutside(ev) {
      if (!svgEl.contains(ev.target)) { hide(); }
    }

    svgEl.addEventListener('pointermove', pick);
    svgEl.addEventListener('pointerdown', pick);
    svgEl.addEventListener('pointerleave', onLeave);
    svgEl.addEventListener('pointercancel', hide);
    doc.addEventListener('pointerdown', onOutside);
    return function unbind() {
      svgEl.removeEventListener('pointermove', pick);
      svgEl.removeEventListener('pointerdown', pick);
      svgEl.removeEventListener('pointerleave', onLeave);
      svgEl.removeEventListener('pointercancel', hide);
      doc.removeEventListener('pointerdown', onOutside);
      hide();
    };
  }

  const api = { ANCH_DARK, ANCH_LIGHT, tcol, scaleCss, icon, layout, summary, bind };
  root.Heizwarte.chart = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
