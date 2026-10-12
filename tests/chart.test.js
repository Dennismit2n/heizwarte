/*
 * Tests für chart.js: die dunkle und die helle Ankertabelle, tcol(), scaleCss() und icon() (Kontrast beider Tabellen:
 * contrast.test.js) sowie die Kurve: layout() (SVG-String), summary() (Tiefst- und Höchstwert) und bind() (Tooltip, mit einer
 * Papier-Attrappe statt DOM). Die Kurve läuft auf den Fixtures in tests/fixtures/ (13.01.2026 Berlin, 25.10.2026 mit
 * der Uhrumstellung) und braucht keine Zeitzone des Rechners: alle Zeiten kommen als Zahlen aus weather.model().
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { chart, weather, heat } = require('./_load.js');

// Wie ein Browser: oklch(L% C H[ / a]) in Zahlen
function lesen(farbe) {
  const m = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(farbe);
  assert.ok(m, 'keine gültige oklch-Farbe: ' + farbe);
  return { L: Number(m[1]), C: Number(m[2]), H: Number(m[3]), a: m[4] === undefined ? null : Number(m[4]) };
}

test('ANCH_DARK: sechs Anker bei −10, 0, 10, 18, 25, 32 °C; nur der −10-Anker weicht von Bürg ab', () => {
  assert.deepEqual(chart.ANCH_DARK.map((a) => a[0]), [-10, 0, 10, 18, 25, 32]);
  assert.deepEqual(chart.ANCH_DARK[0], [-10, 62, 0.13, 275]);
  // die übrigen fünf wie Bürg index:222
  assert.deepEqual(chart.ANCH_DARK.slice(1), [[0, 72, 0.11, 245], [10, 85, 0.05, 210], [18, 88, 0.08, 90], [25, 76, 0.16, 58], [32, 63, 0.20, 28]]);
});

test('tcol: auf den Ankern genau der Ankerwert, im Format von Bürg', () => {
  assert.equal(chart.tcol(-10), 'oklch(62.0% 0.130 275.0)');
  assert.equal(chart.tcol(0), 'oklch(72.0% 0.110 245.0)');
  assert.equal(chart.tcol(10), 'oklch(85.0% 0.050 210.0)');
  assert.equal(chart.tcol(18), 'oklch(88.0% 0.080 90.0)');
  assert.equal(chart.tcol(25), 'oklch(76.0% 0.160 58.0)');
  assert.equal(chart.tcol(32), 'oklch(63.0% 0.200 28.0)');
});

test('tcol: lineare Mischung zwischen den Ankern, Farbton numerisch linear (nicht kürzester Bogen)', () => {
  assert.equal(chart.tcol(5), 'oklch(78.5% 0.080 227.5)');
  // 10 → 18 °C: Farbton 210 → 90 läuft über 150 (Grün), nicht über 330 (Violett)
  assert.equal(chart.tcol(14), 'oklch(86.5% 0.065 150.0)');
  assert.equal(chart.tcol(21.5), 'oklch(82.0% 0.120 74.0)');
});

test('tcol: außerhalb −10…32 °C bleibt die Farbe auf dem Randanker', () => {
  assert.equal(chart.tcol(-40), chart.tcol(-10));
  assert.equal(chart.tcol(60), chart.tcol(32));
});

test('tcol: Alpha hängt sich hinten an, ohne Alpha steht nichts dahinter', () => {
  assert.equal(chart.tcol(0, 0.5), 'oklch(72.0% 0.110 245.0 / 0.5)');
  assert.equal(chart.tcol(0, 0), 'oklch(72.0% 0.110 245.0 / 0)');
  assert.equal(chart.tcol(0, null), chart.tcol(0));
  assert.doesNotMatch(chart.tcol(0), /\//);
});

test('tcol: kein Wert ergibt die neutrale Mitte statt NaN, in jeder Schreibweise', () => {
  const mitte = chart.tcol(10);
  for (const x of [null, undefined, NaN, Infinity, -Infinity, '12', {}]) {
    const s = chart.tcol(x);
    assert.doesNotMatch(s, /NaN|undefined|null|Infinity/, String(x));
    assert.ok(lesen(s));
  }
  assert.equal(chart.tcol(null), mitte);
  assert.equal(chart.tcol(NaN), mitte);
});

test('tcol: ohne oder mit unbekanntem scheme gilt Dunkel; jede Stufe der dunklen Skala ist gültig', () => {
  for (const scheme of [undefined, null, 'dark', 'sepia', 'LIGHT', '', 1, {}]) {
    assert.equal(chart.tcol(7, undefined, scheme), chart.tcol(7, undefined, 'dark'), String(scheme));
  }
  assert.equal(chart.tcol(7, undefined, 'dark'), chart.tcol(7));
  assert.notEqual(chart.tcol(7, undefined, 'light'), chart.tcol(7, undefined, 'dark'));
  for (let t = -12; t <= 34; t += 0.5) {
    const c = lesen(chart.tcol(t));
    assert.ok(c.L >= 62 && c.L <= 88, 'L bei ' + t);
    assert.ok(c.C > 0 && c.C < 0.21, 'C bei ' + t);
    assert.ok(c.H >= 28 && c.H <= 275, 'H bei ' + t);
  }
});

test('tcol: wärmer heißt hier nur anders, nie dunkler als der Kleintext-Boden (L ≥ 62 %)', () => {
  // Der gehobene −10-°C-Anker (62 statt 55 %) ist die einzige Abweichung von Bürg; darunter darf nichts liegen
  const kleinste = Math.min.apply(null, chart.ANCH_DARK.map((a) => a[1]));
  assert.equal(kleinste, 62);
});

// ---------------------------------------------------------------------------------------------
// helle Ankertabelle und scaleCss
// ---------------------------------------------------------------------------------------------

test('ANCH_LIGHT: sechs Anker bei denselben °C wie die dunkle Tabelle, gleiche Farbtöne, L gesenkt', () => {
  assert.deepEqual(chart.ANCH_LIGHT, [[-10, 42, 0.14, 275], [0, 45, 0.11, 245], [10, 48, 0.05, 210], [18, 46, 0.08, 90], [25, 46, 0.16, 58], [32, 44, 0.20, 28]]);
  assert.deepEqual(chart.ANCH_LIGHT.map((a) => a[0]), chart.ANCH_DARK.map((a) => a[0]));
  assert.deepEqual(chart.ANCH_LIGHT.map((a) => a[3]), chart.ANCH_DARK.map((a) => a[3]), 'gleiche Farbtöne');
  // C gleich bis auf den −10-°C-Anker, den der Plan nur im Dunkeln anhebt (C .13 dunkel, .14 hell wie bei Bürg)
  assert.deepEqual(chart.ANCH_LIGHT.slice(1).map((a) => a[2]), chart.ANCH_DARK.slice(1).map((a) => a[2]));
  for (let k = 0; k < 6; k++) { assert.ok(chart.ANCH_LIGHT[k][1] <= 48 && chart.ANCH_LIGHT[k][1] < chart.ANCH_DARK[k][1], 'L hell < dunkel bei Anker ' + k); }
});

test('tcol hell: auf den Ankern genau der Ankerwert, dazwischen linear, Alpha hängt hinten dran', () => {
  assert.equal(chart.tcol(-10, undefined, 'light'), 'oklch(42.0% 0.140 275.0)');
  assert.equal(chart.tcol(0, undefined, 'light'), 'oklch(45.0% 0.110 245.0)');
  assert.equal(chart.tcol(10, undefined, 'light'), 'oklch(48.0% 0.050 210.0)');
  assert.equal(chart.tcol(18, undefined, 'light'), 'oklch(46.0% 0.080 90.0)');
  assert.equal(chart.tcol(25, undefined, 'light'), 'oklch(46.0% 0.160 58.0)');
  assert.equal(chart.tcol(32, undefined, 'light'), 'oklch(44.0% 0.200 28.0)');
  assert.equal(chart.tcol(5, undefined, 'light'), 'oklch(46.5% 0.080 227.5)');
  assert.equal(chart.tcol(14, undefined, 'light'), 'oklch(47.0% 0.065 150.0)', '10 → 18 °C läuft über Grün, nicht über Violett');
  assert.equal(chart.tcol(21.5, undefined, 'light'), 'oklch(46.0% 0.120 74.0)');
  assert.equal(chart.tcol(0, 0.5, 'light'), 'oklch(45.0% 0.110 245.0 / 0.5)');
  assert.doesNotMatch(chart.tcol(0, undefined, 'light'), /\//);
});

test('tcol hell: außerhalb −10…32 °C bleibt die Farbe auf dem Randanker; kein Wert ergibt die neutrale Mitte, nie NaN', () => {
  assert.equal(chart.tcol(-40, undefined, 'light'), chart.tcol(-10, undefined, 'light'));
  assert.equal(chart.tcol(60, undefined, 'light'), chart.tcol(32, undefined, 'light'));
  for (const x of [null, undefined, NaN, Infinity, -Infinity, '12', {}]) {
    const s = chart.tcol(x, undefined, 'light');
    assert.doesNotMatch(s, /NaN|undefined|null|Infinity/, String(x));
    assert.equal(s, chart.tcol(10, undefined, 'light'), String(x));
  }
  for (let t = -12; t <= 34; t += 0.5) {
    const c = lesen(chart.tcol(t, undefined, 'light'));
    assert.ok(c.L >= 42 && c.L <= 48, 'L bei ' + t);
    assert.ok(c.C > 0 && c.C < 0.21, 'C bei ' + t);
    assert.ok(c.H >= 28 && c.H <= 275, 'H bei ' + t);
  }
});

test('scaleCss: 22 Stützstellen von −10 bis 32 °C in 2-K-Schritten, je Schema die eigene Tabelle', () => {
  for (const scheme of ['dark', 'light']) {
    const s = chart.scaleCss(scheme);
    assert.match(s, /^linear-gradient\(90deg,oklch\(/);
    assert.ok(s.endsWith(')'));
    const stuetzen = s.slice('linear-gradient(90deg,'.length, -1).split(',');
    assert.equal(stuetzen.length, 22, scheme);
    assert.equal(stuetzen[0], chart.tcol(-10, undefined, scheme));
    assert.equal(stuetzen[21], chart.tcol(32, undefined, scheme));
    assert.equal(stuetzen[5], chart.tcol(0, undefined, scheme));
    assert.doesNotMatch(s, /NaN|undefined|null/);
  }
  assert.notEqual(chart.scaleCss('light'), chart.scaleCss('dark'));
  assert.equal(chart.scaleCss(), chart.scaleCss('dark'), 'ohne scheme gilt Dunkel');
  assert.equal(chart.scaleCss('sepia'), chart.scaleCss('dark'));
});

// ---------------------------------------------------------------------------------------------
// icon
// ---------------------------------------------------------------------------------------------

const CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

test('icon: jeder WMO-Code ergibt ein SVG, tags sind ausgeglichen, ohne NaN und undefined', () => {
  for (const code of CODES) {
    for (const day of [true, false]) {
      const s = chart.icon(code, day, 30);
      assert.match(s, /^<svg [^>]*viewBox="0 0 24 25"[^>]*>.*<\/svg>$/s, code + ' ist kein SVG');
      assert.doesNotMatch(s, /NaN|undefined|null|Infinity/, code + ' enthält ungültige Zahlen');
      // jedes öffnende g hat sein schließendes
      assert.equal((s.match(/<g[ >]/g) || []).length, (s.match(/<\/g>/g) || []).length, code + ': g ungleich');
    }
  }
});

test('icon: dekorativ (aria-hidden), Größe aus dem dritten Parameter', () => {
  const s = chart.icon(3, true, 34);
  assert.match(s, /aria-hidden="true"/);
  assert.match(s, /focusable="false"/);
  assert.match(s, /width="34" height="34"/);
  assert.match(chart.icon(3), /width="30" height="30"/, 'Standardgröße 30');
  assert.match(chart.icon(3, true, -4), /width="30"/, 'unsinnige Größe fällt auf 30');
  assert.match(chart.icon(3, true, NaN), /width="30"/);
});

test('icon: CSP-fest, kein style-Attribut, keine festen Farben; Farben nur als var(--ic-*)', () => {
  for (const code of CODES) {
    const s = chart.icon(code, true, 30);
    assert.doesNotMatch(s, /\sstyle=/, code + ': style-Attribut');
    assert.doesNotMatch(s, /oklch\(|#[0-9a-f]{3,6}\b|rgb\(|currentColor/i, code + ': feste Farbe');
    assert.doesNotMatch(s, /<script|\son\w+=/i);
    for (const m of s.matchAll(/var\((--[\w-]+)\)/g)) {
      assert.match(m[1], /^--ic-(sun|moon|cloud|cloud-dark|fog|rain|snow|bolt)$/, code + ': unbekannte Variable ' + m[1]);
    }
    assert.match(s, /var\(--ic-/, code + ' nutzt keine --ic-Farbe');
  }
});

test('icon: Zuordnung wie Bürg (Sonne/Mond, teils bewölkt, bedeckt, Nebel, Schnee, Gewitter, sonst Regen)', () => {
  const hat = (code, day, v) => chart.icon(code, day, 30).includes('var(--ic-' + v + ')');
  assert.ok(hat(0, true, 'sun') && !hat(0, true, 'moon'));
  assert.ok(hat(0, false, 'moon') && !hat(0, false, 'sun'), 'Nacht zeigt den Mond');
  assert.ok(hat(1, true, 'sun'));
  // teils bewölkt: Sonne (bzw. Mond) verkleinert und eine Wolke
  assert.ok(hat(2, true, 'sun') && hat(2, true, 'cloud') && !hat(2, true, 'cloud-dark'));
  assert.ok(hat(2, false, 'moon') && hat(2, false, 'cloud'));
  assert.match(chart.icon(2, true), /scale\(\.8\)/);
  // bedeckt: nur die dunkle Wolke
  assert.ok(hat(3, true, 'cloud-dark') && !hat(3, true, 'sun') && !hat(3, true, 'cloud'));
  assert.ok(hat(45, true, 'fog') && hat(48, true, 'fog'));
  for (const code of [71, 73, 75, 77, 85, 86]) { assert.ok(hat(code, true, 'snow'), 'Schnee ' + code); }
  for (const code of [95, 96, 99]) { assert.ok(hat(code, true, 'bolt'), 'Gewitter ' + code); }
  for (const code of [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]) { assert.ok(hat(code, true, 'rain'), 'Regen ' + code); }
});

test('icon: ohne Code gilt „bedeckt“ wie bei Bürg, ohne Tag/Nacht-Angabe gilt Tag', () => {
  for (const code of [null, undefined, NaN, '3', {}]) {
    assert.equal(chart.icon(code, true, 30), chart.icon(3, true, 30), String(code));
  }
  assert.equal(chart.icon(0, undefined, 30), chart.icon(0, true, 30));
  assert.equal(chart.icon(0, 1, 30), chart.icon(0, true, 30));
  assert.equal(chart.icon(0, 0, 30), chart.icon(0, false, 30));
});

test('chart.js läuft in Node ohne DOM und exportiert genau die Schnittstelle aus Abschnitt 5', () => {
  assert.deepEqual(Object.keys(chart).sort(), ['ANCH_DARK', 'ANCH_LIGHT', 'bind', 'icon', 'layout', 'scaleCss', 'summary', 'tcol']);
  assert.equal(globalThis.Heizwarte.chart, chart);
});

// ---------------------------------------------------------------------------------------------
// Kurve: layout, summary, bind (BAUPLAN Abschnitt 5 chart und 12)
// ---------------------------------------------------------------------------------------------

// 13.01.2026 10:00 in Berlin (UTC+1): „heute“ ist Tag 1 der konstruierten Fixtures (past_days=1), die Kurve zeigt Tag 1 bis 3
const JAN13_MS = Date.UTC(2026, 0, 13, 9, 0);
// 25.10.2026 10:00 in Berlin (UTC+1, nach der Umstellung): der Tag hat 25 Stunden
const DST_NOW_MS = Date.UTC(2026, 9, 25, 9, 0);
const HOUR = 3600000;
const RADIATOR = { type: 'radiator', leadMin: 0.5, leadMax: 2, comfort: 20, thresh: null, confirmed: true };

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function cacheOf(name, extra) {
  return Object.assign({ v: 2, fetched: 0, om: fixture(name), mos: [], mosStation: null, alerts: null, alertsStatus: 'none' }, extra);
}

// Modell, „jetzt“ und Ampel zu einer Fixture, so wie app.js sie der Kurve gibt
function curveOf(name, nowMs, extra) {
  const model = weather.model(cacheOf(name, extra));
  const now = weather.localNow(model.tz, nowMs);
  const verdict = heat.assess(model, now, RADIATOR, []);
  return { model, now, verdict };
}

// MOSMIX-Werte 1,5 Grad über der Hauptprognose, für jede Stunde, samt Station in distance Metern
function mosFor(name, distance) {
  const base = weather.model(cacheOf(name));
  return {
    mos: base.hours.map((h) => [h.ms, Math.round((h.temp + 1.5) * 10) / 10]),
    mosStation: { name: 'BACKNANG', distance, height: 291 }
  };
}

const LABELS = { today: 'Heute', tomorrow: 'Morgen', now: 'jetzt', wday: () => 'Donnerstag' };
const FMT = { deg: (x, d) => x.toFixed(d === undefined ? 0 : d).replace('-', '−') + '°' };

function layoutOf(c, opts) {
  return chart.layout(c.model, c.verdict, c.now, Object.assign({ width: 360, scheme: 'dark', labels: LABELS, fmt: FMT }, opts));
}

// Läufe zusammenhängender Stunden ohne Tageslicht, unabhängig vom Code gezählt
function nightRuns(hs) {
  let runs = 0;
  let inNight = false;
  for (const h of hs) {
    if (!h.isDay) {
      if (!inNight) { runs++; }
      inNight = true;
    } else {
      inNight = false;
    }
  }
  return runs;
}

function count(text, re) {
  return (text.match(re) || []).length;
}

test('layout: ein SVG mit dem Verlauf tg, 72 Stunden, ohne NaN, ohne style-Attribut, ohne Skript', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const lay = layoutOf(c);
  assert.match(lay.markup, /^<svg /);
  assert.ok(lay.markup.includes('<linearGradient id="tg"'));
  assert.ok(lay.markup.includes('<mask id="fm">'));
  assert.doesNotMatch(lay.markup, /NaN|undefined|null|Infinity/);
  assert.doesNotMatch(lay.markup, /\sstyle=/, 'CSP: kein style-Attribut');
  assert.doesNotMatch(lay.markup, /<script|\son\w+=|javascript:/i);
  assert.equal(count(lay.markup, /<svg\b/g), 1);
  assert.equal(count(lay.markup, /<\/svg>/g), 1);
  assert.match(lay.markup, /aria-hidden="true"/, 'die Zeichnung ist Dekor: der Satz darunter trägt die Aussage');
  // Maße
  assert.equal(lay.W, 360);
  assert.equal(lay.H, 250);
  assert.deepEqual([lay.L, lay.R, lay.T, lay.B].every((v) => Number.isFinite(v) && v > 0), true);
  assert.ok(lay.markup.includes('viewBox="0 0 360 250"'));
  // heute und die zwei folgenden Tage, Stunde für Stunde
  assert.equal(lay.hs.length, 72);
  assert.equal(lay.xs.length, 72);
  assert.equal(lay.ys.length, 72);
  assert.deepEqual(lay.hs, c.model.hours.filter((h) => h.dayIdx >= 1 && h.dayIdx <= 3));
  assert.equal(lay.hs[0].h, 0);
  assert.equal(lay.hs[71].h, 23);
  assert.equal(lay.xs[0], lay.L, 'die erste Stunde beginnt am linken Rand der Fläche');
  for (let i = 1; i < 72; i++) { assert.ok(lay.xs[i] > lay.xs[i - 1], 'x steigt bei ' + i); }
  assert.ok(lay.xs[71] < lay.W - lay.R, 'die letzte Stunde endet vor dem rechten Rand');
  for (const y of lay.ys) { assert.ok(y >= lay.T && y <= lay.H - lay.B, 'y liegt in der Fläche: ' + y); }
  assert.equal(lay.scheme, 'dark');
  assert.equal(lay.mos, false);
});

test('layout: die Anzahl der Nachtbänder ist die Anzahl der Läufe ohne Tageslicht (auch am Rand, auch ganz hell oder ganz dunkel)', () => {
  for (const [name, nowMs] of [['om-frost.json', JAN13_MS], ['om-mild.json', JAN13_MS], ['om-lissabon.json', JAN13_MS], ['om-dst.json', DST_NOW_MS]]) {
    const c = curveOf(name, nowMs);
    for (const scheme of ['dark', 'light']) {
      const lay = layoutOf(c, { scheme });
      assert.equal(count(lay.markup, /class="chart-night"/g), nightRuns(lay.hs), name + ' ' + scheme);
    }
  }
  const c = curveOf('om-frost.json', JAN13_MS);
  const bands = (hours) => count(layoutOf({ model: Object.assign({}, c.model, { hours }), verdict: c.verdict, now: c.now }).markup, /class="chart-night"/g);
  assert.equal(bands(c.model.hours.map((h) => Object.assign({}, h, { isDay: true }))), 0, 'ganz hell: kein Band');
  assert.equal(bands(c.model.hours.map((h) => Object.assign({}, h, { isDay: false }))), 1, 'ganz dunkel: ein Band');
  // nur die letzte Stunde im Fenster dunkel: ein Band, das am rechten Rand der Fläche endet
  const last = c.model.hours.map((h) => Object.assign({}, h, { isDay: !(h.dayIdx === 3 && h.h === 23) }));
  const m = Object.assign({}, c.model, { hours: last });
  const lay = layoutOf({ model: m, verdict: c.verdict, now: c.now });
  assert.equal(count(lay.markup, /class="chart-night"/g), 1);
  const band = /<rect class="chart-night" x="([\d.]+)" y="\d+" width="([\d.]+)"/.exec(lay.markup);
  assert.ok(Math.abs(Number(band[1]) + Number(band[2]) - (lay.W - lay.R)) < 0.02, 'das Band endet am rechten Rand');
  assert.ok(Math.abs(Number(band[1]) - lay.xs[71]) < 0.02, 'und beginnt bei der letzten Stunde');
});

test('layout: Farben nur als var(--…), tcol() und die Maske; beide Schemata, die Verläufe folgen dem Schema', () => {
  const c = curveOf('om-frost.json', JAN13_MS, mosFor('om-frost.json', 7692));
  const erlaubt = [
    /^none$/, /^url\(#(?:tg|tf|fm)\)$/,
    /^var\(--(?:chart-night|chart-grid|chart-rain|chart-mos|fg|bg|muted|faint)\)$/,
    /^oklch\([\d.]+% [\d.]+ [\d.]+\)$/
  ];
  const outputs = {};
  for (const scheme of ['dark', 'light']) {
    const lay = layoutOf(c, { scheme });
    outputs[scheme] = lay.markup;
    // die weiße Maske tf ist keine sichtbare Farbe; sie wird vor der Prüfung herausgenommen
    const ohneMaske = lay.markup.replace(/<linearGradient id="tf"[\s\S]*?<\/linearGradient>/, '');
    let n = 0;
    for (const m of ohneMaske.matchAll(/\s(?:fill|stroke|stop-color)="([^"]*)"/g)) {
      n++;
      assert.ok(erlaubt.some((re) => re.test(m[1])), scheme + ': unerlaubte Farbe ' + m[1]);
    }
    assert.ok(n > 40, 'die Prüfung hat Farben gesehen: ' + n);
    assert.equal(count(lay.markup, /<stop /g), 15, '13 Stufen im Temperaturverlauf, 2 in der Maske');
    assert.equal(lay.scheme, scheme);
    // die Farbe der kältesten Stufe steht im Verlauf: sie kommt aus dem Ankersatz des Schemas
    const stops = [...lay.markup.matchAll(/id="tg"[\s\S]*?<\/linearGradient>/g)][0][0];
    const farben = [...stops.matchAll(/stop-color="([^"]+)"/g)].map((m) => lesen(m[1]));
    const lMax = Math.max.apply(null, farben.map((f) => f.L));
    if (scheme === 'dark') { assert.ok(lMax > 60, 'dunkel: hell auf dunkel'); } else { assert.ok(lMax < 50, 'hell: dunkle Schrift-Farben (L ≤ 48 %)'); }
  }
  assert.notEqual(outputs.dark, outputs.light);
  // ohne scheme oder mit einem unbekannten gilt Dunkel
  assert.equal(layoutOf(c, { scheme: undefined }).markup, outputs.dark);
  assert.equal(layoutOf(c, { scheme: 'sepia' }).markup, outputs.dark);
});

test('layout: die zweite Meinung (MOSMIX) nur bei Station bis 25 km; sonst gleiches Bild wie ganz ohne', () => {
  const ohne = layoutOf(curveOf('om-frost.json', JAN13_MS));
  assert.equal(count(ohne.markup, /class="chart-mos"/g), 0);
  for (const [distance, soll] of [[7692, true], [25000, true], [25001, false], [40000, false], [null, false], [NaN, false], [undefined, false]]) {
    const lay = layoutOf(curveOf('om-frost.json', JAN13_MS, mosFor('om-frost.json', distance)));
    assert.equal(lay.mos, soll, 'distance ' + distance);
    assert.equal(count(lay.markup, /class="chart-mos"/g), soll ? 1 : 0, 'Linie bei ' + distance);
    if (!soll) { assert.equal(lay.markup, ohne.markup, 'eine ferne Station ändert nichts, auch nicht die Achse (' + distance + ')'); }
  }
  // MOSMIX weit außerhalb der Hauptprognose weitet die Achse nur, wenn die Linie gezeichnet wird
  const stark = mosFor('om-frost.json', 5000);
  stark.mos = stark.mos.map(([ms, v]) => [ms, v + 30]);
  const nah = layoutOf(curveOf('om-frost.json', JAN13_MS, stark));
  assert.notEqual(nah.markup, ohne.markup);
  const fern = layoutOf(curveOf('om-frost.json', JAN13_MS, Object.assign({}, stark, { mosStation: Object.assign({}, stark.mosStation, { distance: 30000 }) })));
  assert.equal(fern.markup, ohne.markup);
  // Station nah, aber kein einziger Wert: keine Linie
  const leer = layoutOf(curveOf('om-frost.json', JAN13_MS, { mos: [], mosStation: { name: 'X', distance: 1000, height: 5 } }));
  assert.equal(leer.mos, false);
  assert.equal(leer.markup, ohne.markup);
});

test('layout: die zweite Meinung erst ab zwei Werten im Fenster; ein einzelner Wert zeichnet nichts und verspricht keine Linie', () => {
  const ohne = layoutOf(curveOf('om-frost.json', JAN13_MS));
  const voll = mosFor('om-frost.json', 7692);
  const base = curveOf('om-frost.json', JAN13_MS).model;
  // 14.01.2026 12:00 und 13:00 Berlin: zwei Stunden mitten im Fenster
  const zwoelf = base.hours.find((h) => h.dayIdx === 2 && h.h === 12).ms;
  const eins = { mos: voll.mos.filter(([ms]) => ms === zwoelf), mosStation: voll.mosStation };
  assert.equal(eins.mos.length, 1);
  const einzeln = layoutOf(curveOf('om-frost.json', JAN13_MS, eins));
  assert.equal(einzeln.mos, false, 'ein Wert: keine Linie, die Legende sagt chartMosFar');
  assert.equal(count(einzeln.markup, /class="chart-mos"/g), 0);
  assert.equal(einzeln.markup, ohne.markup, 'ein einzelner Wert ändert auch die Achse nicht');
  const zwei = { mos: voll.mos.filter(([ms]) => ms === zwoelf || ms === zwoelf + HOUR), mosStation: voll.mosStation };
  const paar = layoutOf(curveOf('om-frost.json', JAN13_MS, zwei));
  assert.equal(paar.mos, true);
  const d = /class="chart-mos" d="([^"]+)"/.exec(paar.markup)[1];
  assert.match(d, /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/, 'ein Strich von der ersten zur zweiten Stunde: ' + d);
});

test('layout: die Stundenmarken kommen aus labels.hour(ms) (Uhrzeitform der Sprache), ohne sie die Ortsstunde', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const calls = [];
  const labels = Object.assign({}, LABELS, { hour: (ms) => { calls.push(ms); return 'U' + ms; } });
  const eng = layoutOf(c, { width: 360, labels });
  const mittag = eng.hs.filter((h) => h.h === 12).map((h) => h.ms);
  assert.equal(mittag.length, 3);
  assert.deepEqual(calls, mittag, 'hour bekommt den Zeitpunkt jeder Marke');
  for (const ms of mittag) { assert.ok(eng.markup.includes('>U' + ms + '</text>'), 'Marke ' + ms); }
  assert.equal(count(eng.markup, />12<\/text>/g), 0, 'keine nackte Ortsstunde, wenn hour da ist');
  // 12-Stunden-Form wie in en: die Marke ist der Text aus labels, maskiert
  const en = layoutOf(c, { width: 600, labels: Object.assign({}, LABELS, { hour: (ms) => (c.model.hours.find((h) => h.ms === ms).h < 12 ? '6 AM' : '6 PM') }) });
  assert.equal(count(en.markup, />6 AM<\/text>/g), 3);
  assert.equal(count(en.markup, />6 PM<\/text>/g), 3);
  const bose = layoutOf(c, { labels: Object.assign({}, LABELS, { hour: () => '<i>' }) });
  assert.ok(bose.markup.includes('&lt;i&gt;'));
  assert.doesNotMatch(bose.markup, /<i>/);
});

test('layout: die Zahl des Tiefstwerts steht auf einem Hof in --bg (Nachtband und Fläche liegen darunter)', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  for (const scheme of ['dark', 'light']) {
    const lay = layoutOf(c, { scheme });
    const zahlen = [...lay.markup.matchAll(/<text [^>]*font-weight="700"[^>]*>/g)].map((m) => m[0]);
    assert.ok(zahlen.length >= 2, scheme + ': Zahlen der Tiefstwerte');
    for (const z of zahlen) {
      assert.match(z, /stroke="var\(--bg\)"/, scheme + ': ' + z);
      assert.match(z, /stroke-width="3"/);
      assert.match(z, /paint-order="stroke"/, 'der Hof liegt unter der Füllung');
      assert.match(z, /fill="oklch\(/, 'die Zahl selbst bleibt in der Temperaturfarbe');
    }
  }
});

test('layout: Breite klemmt auf 320 bis 720; unter 520 stehen 250 Einheiten Höhe und die 12-Uhr-Marke, darüber 280 und 6 und 18', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  for (const [width, W] of [[100, 320], [320, 320], [361.4, 361], [719, 719], [5000, 720], [undefined, 720], [null, 720], [NaN, 720], ['400', 720], [-5, 720]]) {
    assert.equal(layoutOf(c, { width }).W, W, 'Breite ' + width);
  }
  const eng = layoutOf(c, { width: 519 });
  assert.equal(eng.H, 250);
  assert.equal(count(eng.markup, />12<\/text>/g), 3, 'eine Marke je Tag');
  assert.equal(count(eng.markup, />6<\/text>/g) + count(eng.markup, />18<\/text>/g), 0);
  const weit = layoutOf(c, { width: 520 });
  assert.equal(weit.H, 280);
  assert.equal(count(weit.markup, />6<\/text>/g), 3);
  assert.equal(count(weit.markup, />18<\/text>/g), 3);
  assert.equal(count(weit.markup, />12<\/text>/g), 0);
  for (const lay of [eng, weit]) { assert.doesNotMatch(lay.markup, /NaN|undefined|null|Infinity/); }
});

test('layout: Tagesnamen in der Mitte des Tages, der dritte Tag über wday(ms); Beschriftung wird maskiert', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const calls = [];
  const lay = layoutOf(c, { labels: { today: 'Heute', tomorrow: 'Morgen', now: 'jetzt', wday: (ms) => { calls.push(ms); return 'Do'; } } });
  assert.match(lay.markup, />Heute<\/text>/);
  assert.match(lay.markup, />Morgen<\/text>/);
  assert.match(lay.markup, />Do<\/text>/);
  assert.deepEqual(calls, [Date.UTC(2026, 0, 15, 11, 0)], 'wday bekommt die Mitte des dritten Tages (12:00 Berlin)');
  assert.equal(count(lay.markup, /class="chart-day"/g), 2, 'zwei Tagesgrenzen');
  const bose = layoutOf(c, { labels: { today: '<b>&"x"', tomorrow: 'M', now: 'j', wday: () => 'D' } });
  assert.ok(bose.markup.includes('&lt;b&gt;&amp;&quot;x&quot;'));
  assert.doesNotMatch(bose.markup, /<b>/);
  // ohne Beschriftungen und ohne fmt: kein Wurf, keine Lücke
  const nackt = chart.layout(c.model, c.verdict, c.now, {});
  assert.equal(nackt.W, 720);
  assert.doesNotMatch(nackt.markup, /NaN|undefined|null/);
  assert.doesNotThrow(() => chart.layout(c.model, c.verdict, c.now));
});

test('layout: „jetzt“ nur im Fenster; die Tiefstwerte der Nächte, die im Fenster liegen; Regenbalken je Stunde mit Regenwahrscheinlichkeit', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const lay = layoutOf(c);
  assert.equal(count(lay.markup, /class="chart-now"/g), 1);
  assert.match(lay.markup, />jetzt<\/text>/);
  const spaeter = layoutOf({ model: c.model, verdict: c.verdict, now: weather.localNow(c.model.tz, Date.UTC(2026, 0, 20, 9, 0)) });
  assert.equal(count(spaeter.markup, /class="chart-now"/g), 0, 'ein Zeitpunkt nach dem Fenster zeichnet keine Marke');
  assert.doesNotMatch(spaeter.markup, />jetzt<\/text>/);
  assert.equal(count(chart.layout(c.model, c.verdict, null, { labels: LABELS, fmt: FMT }).markup, /class="chart-now"/g), 0, 'ohne now keine Marke');
  // Tiefstwerte: genau die Nächte aus der Ampel, deren Tiefpunkt im Fenster liegt
  const start = lay.hs[0].ms;
  const end = lay.hs[71].ms + HOUR;
  const soll = c.verdict.nights.filter((n) => n.atMs >= start && n.atMs < end);
  assert.ok(soll.length >= 2);
  assert.equal(count(lay.markup, /class="chart-nightmin"/g), soll.length);
  for (const n of soll) { assert.ok(lay.markup.includes('>' + FMT.deg(n.min, 1) + '</text>'), 'Zahl der Nacht ' + n.min); }
  // Regenbalken: eine pro Stunde mit pp > 0, nie höher als 34 Einheiten
  const regen = c.model.hours.filter((h) => h.dayIdx >= 1 && h.dayIdx <= 3 && h.pp > 0).length;
  const mitRegen = layoutOf(curveOf('om-lueften.json', JAN13_MS));
  assert.equal(count(mitRegen.markup, /class="chart-rain"/g), mitRegen.hs.filter((h) => h.pp > 0).length);
  assert.ok(mitRegen.hs.some((h) => h.pp > 0), 'die Fixture hat Regenstunden');
  assert.equal(count(lay.markup, /class="chart-rain"/g), regen);
  for (const m of mitRegen.markup.matchAll(/class="chart-rain"[^>]* height="([\d.]+)"[^>]* fill-opacity="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 34, 'Höhe ' + m[1]);
    assert.ok(Number(m[2]) >= 0.25 && Number(m[2]) <= 0.75, 'Deckkraft ' + m[2]);
  }
});

test('layout: die Uhrumstellung (25 Stunden am 25.10.) kostet nichts: 73 Stunden, die Zeitachse läuft über echte Zeit', () => {
  const c = curveOf('om-dst.json', DST_NOW_MS);
  const lay = layoutOf(c);
  assert.equal(lay.hs.length, 73);
  assert.equal(lay.hs.filter((h) => h.dayIdx === lay.hs[0].dayIdx).length, 25);
  assert.equal(lay.xs[0], lay.L);
  for (let i = 1; i < lay.xs.length; i++) { assert.ok(lay.xs[i] > lay.xs[i - 1], 'x steigt bei ' + i); }
  // gleichmäßig: jede Stunde gleich breit, auch die doppelte Stunde 2
  const breite = lay.xs[1] - lay.xs[0];
  for (let i = 1; i < lay.xs.length; i++) { assert.ok(Math.abs(lay.xs[i] - lay.xs[i - 1] - breite) < 0.02, 'gleich breit bei ' + i); }
  assert.doesNotMatch(lay.markup, /NaN|undefined|null|Infinity/);
  assert.equal(count(lay.markup, /class="chart-night"/g), nightRuns(lay.hs));
  assert.equal(count(lay.markup, /class="chart-day"/g), 2);
  assert.equal(count(lay.markup, />12<\/text>/g), 3);
});

test('layout: ohne Fenster (keine Ampel-Tage, kein Modell, keine Stunden) leer und ohne Wurf', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const tooOld = curveOf('om-stale.json', Date.UTC(2026, 9, 20, 9, 0));
  assert.deepEqual(tooOld.verdict.D, [], 'die Fixture ist zu alt');
  for (const lay of [
    layoutOf(tooOld),
    chart.layout(c.model, { D: [] }, c.now, {}),
    chart.layout(c.model, null, c.now, {}),
    chart.layout(c.model, undefined, c.now),
    chart.layout(null, c.verdict, c.now, {}),
    chart.layout({}, c.verdict, c.now, {}),
    chart.layout({ hours: [] }, c.verdict, c.now, {})
  ]) {
    assert.equal(lay.markup, '');
    assert.deepEqual([lay.xs, lay.hs, lay.ys], [[], [], []]);
    assert.equal(lay.mos, false);
    assert.ok(Number.isFinite(lay.W) && Number.isFinite(lay.H));
  }
  assert.equal(chart.summary(tooOld.model, tooOld.verdict), null);
  assert.equal(chart.summary(null, c.verdict), null);
  assert.equal(chart.summary(c.model, null), null);
  assert.equal(chart.summary(c.model, { D: [] }), null);
});

test('summary: Tiefst- und Höchstwert der 72 Stunden samt Zeit, der erste Zeitpunkt bei Gleichstand', () => {
  for (const [name, nowMs] of [['om-frost.json', JAN13_MS], ['om-mild.json', JAN13_MS], ['om-sturz.json', JAN13_MS], ['om-dst.json', DST_NOW_MS]]) {
    const c = curveOf(name, nowMs);
    const fenster = c.model.hours.filter((h) => h.dayIdx >= c.verdict.D[0].idx && h.dayIdx <= c.verdict.D[0].idx + 2);
    const s = chart.summary(c.model, c.verdict);
    const temps = fenster.map((h) => h.temp);
    assert.equal(s.min, Math.min.apply(null, temps), name);
    assert.equal(s.max, Math.max.apply(null, temps), name);
    assert.equal(s.minMs, fenster.find((h) => h.temp === s.min).ms, name + ': erste Stunde mit dem Tiefstwert');
    assert.equal(s.maxMs, fenster.find((h) => h.temp === s.max).ms, name + ': erste Stunde mit dem Höchstwert');
    assert.deepEqual(Object.keys(s).sort(), ['max', 'maxMs', 'min', 'minMs']);
  }
  // die Tage vor und nach dem Fenster zählen nicht: der Tiefstwert von Tag 4 (16.01.) und der Vortag liegen außerhalb
  const c = curveOf('om-frost.json', JAN13_MS);
  const kalt = c.model.hours.map((h) => (h.dayIdx === 0 || h.dayIdx === 4 ? Object.assign({}, h, { temp: -40 }) : h));
  const s = chart.summary(Object.assign({}, c.model, { hours: kalt }), c.verdict);
  assert.ok(s.min > -40);
  // eine einzige gleichmäßige Temperatur: Tiefst- und Höchstwert sind dieselbe erste Stunde
  const flach = c.model.hours.map((h) => Object.assign({}, h, { temp: 5 }));
  const f = chart.summary(Object.assign({}, c.model, { hours: flach }), c.verdict);
  assert.deepEqual([f.min, f.max], [5, 5]);
  assert.equal(f.minMs, f.maxMs);
  assert.equal(f.minMs, c.model.hours.find((h) => h.dayIdx === 1).ms);
});

// ---------------------------------------------------------------------------------------------
// bind: Tooltip mit einer Papier-Attrappe (kein DOM in Node)
// ---------------------------------------------------------------------------------------------

function fakeDom() {
  const docListeners = {};
  const svgListeners = {};
  function node(tag) {
    const n = {
      tag, className: '', children: [], attrs: {}, hidden: false, textContent: '', offsetWidth: 150,
      style: { props: {}, left: '', setProperty(k, v) { this.props[k] = v; } },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren() { this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); }
    };
    // Aller Text geht per textContent hinein: innerHTML an einem Knoten der Attrappe ist ein Fehler
    Object.defineProperty(n, 'innerHTML', { set() { throw new Error('innerHTML im Tooltip'); }, get() { return ''; } });
    return n;
  }
  const doc = {
    createElement: node,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn); }
  };
  const cur = node('line');
  const dot = node('circle');
  const svg = node('svg');
  svg.ownerDocument = doc;
  svg.querySelector = (sel) => (sel === '#chartCur' ? cur : (sel === '#chartDot' ? dot : null));
  svg.getBoundingClientRect = () => ({ left: 10, top: 0, width: 360, height: 250 });
  svg.addEventListener = (type, fn) => { (svgListeners[type] = svgListeners[type] || []).push(fn); };
  svg.removeEventListener = (type, fn) => { svgListeners[type] = (svgListeners[type] || []).filter((f) => f !== fn); };
  svg.contains = (n) => n === svg || n.insideSvg === true;
  const tip = node('div');
  tip.hidden = true;
  const total = (table) => Object.keys(table).reduce((sum, k) => sum + table[k].length, 0);
  return {
    doc, svg, tip, cur, dot,
    fireSvg(type, ev) { (svgListeners[type] || []).slice().forEach((fn) => fn(ev)); },
    fireDoc(type, ev) { (docListeners[type] || []).slice().forEach((fn) => fn(ev)); },
    listeners: () => ({ svg: total(svgListeners), doc: total(docListeners) }),
    registered: () => ({ svg: Object.keys(svgListeners).filter((k) => svgListeners[k].length).sort(), doc: Object.keys(docListeners).filter((k) => docListeners[k].length).sort() })
  };
}

// Alle Texte eines Knotenbaums, ein Eintrag je Knoten mit Text
function texte(n) {
  return [n.textContent].concat(...n.children.map(texte)).filter(Boolean);
}

// Ein t(), das Schlüssel und Werte sichtbar macht
function tSpur(key, vars) {
  return key + '(' + Object.keys(vars || {}).map((k) => k + '=' + vars[k]).join(',') + ')';
}

const TIP_FMT = {
  deg: FMT.deg,
  num: (x, d) => x.toFixed(d === undefined ? 0 : d),
  time: (ms) => 'Z' + (ms % 86400000 / HOUR),
  wday: () => 'Mo',
  wmo: (code) => 'W' + code
};

function bindOn(c, opts) {
  const lay = layoutOf(c);
  const d = fakeDom();
  const unbind = chart.bind(d.svg, d.tip, lay, Object.assign({ fmt: TIP_FMT, t: tSpur }, opts));
  // x in Fenstereinheiten → Bildschirm: die Attrappe liegt bei left 10 und ist 360 breit (= W, also 1:1)
  const at = (k, dx) => ({ clientX: 10 + lay.xs[k] * 360 / lay.W + (dx || 0), pointerType: 'mouse', target: d.svg });
  return { lay, d, unbind, at };
}

test('bind: meldet vier Zeiger-Handler am Bild und einen am Dokument an; unbind nimmt alle wieder ab', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const { d, unbind } = bindOn(c);
  assert.deepEqual(d.registered(), { svg: ['pointercancel', 'pointerdown', 'pointerleave', 'pointermove'], doc: ['pointerdown'] });
  assert.equal(typeof unbind, 'function');
  d.fireSvg('pointermove', { clientX: 100, pointerType: 'mouse', target: d.svg });
  assert.equal(d.tip.hidden, false);
  unbind();
  assert.deepEqual(d.listeners(), { svg: 0, doc: 0 });
  assert.equal(d.tip.hidden, true, 'unbind blendet den Kasten aus');
  assert.equal(d.cur.attrs.opacity, '0');
  assert.equal(d.dot.attrs.opacity, '0');
  assert.doesNotThrow(() => unbind(), 'zweimal abbauen schadet nicht');
});

test('bind: der Zeiger wählt die nächste Stunde; Linie, Punkt in der Temperaturfarbe und Kasten per textContent', () => {
  const c = curveOf('om-frost.json', JAN13_MS, mosFor('om-frost.json', 7692));
  const { lay, d, at } = bindOn(c);
  const k = 30;
  d.fireSvg('pointermove', at(k, 0.4));
  const h = lay.hs[k];
  assert.equal(d.tip.hidden, false);
  assert.equal(d.cur.attrs.opacity, '0.5');
  assert.equal(d.cur.attrs.x1, String(lay.xs[k]));
  assert.equal(d.cur.attrs.x2, String(lay.xs[k]));
  assert.equal(d.dot.attrs.opacity, '1');
  assert.equal(d.dot.attrs.cx, String(lay.xs[k]));
  assert.equal(d.dot.attrs.cy, String(lay.ys[k]));
  assert.equal(d.dot.attrs.fill, chart.tcol(h.temp, undefined, 'dark'));
  // Kopfzeile, große Temperatur in ihrer Farbe (CSSOM, kein style-Attribut), gefühlte Temperatur, dann die Zeilen
  const [head, main, ...zeilen] = d.tip.children;
  assert.equal(head.textContent, 'Mo Z' + (h.ms % 86400000 / HOUR) + ' · W' + h.code);
  assert.equal(main.children[0].tag, 'b');
  assert.equal(main.children[0].textContent, FMT.deg(h.temp, 1));
  assert.equal(main.children[0].style.props.color, chart.tcol(h.temp, undefined, 'dark'));
  assert.equal(main.children[1].textContent, 'nowFeels(t=' + FMT.deg(h.app, 0) + ')');
  assert.equal(zeilen.length, 4);
  assert.equal(zeilen[0].textContent, 'nowWind(kmh=' + h.wind.toFixed(0) + ') · dayGust(kmh=' + h.gust.toFixed(0) + ')');
  assert.equal(zeilen[1].textContent.split(' · ')[0], 'chartTipRain(p=' + h.pp.toFixed(0) + ')');
  assert.equal(zeilen[2].textContent, 'nowHumidity(p=' + h.rh.toFixed(0) + ') · chartTipDew(t=' + FMT.deg(h.dew, 1) + ')');
  assert.equal(zeilen[3].textContent, 'chartTipMos(t=' + FMT.deg(h.mos, 1) + ')');
  for (const n of d.tip.children) { assert.equal(n.attrs.style, undefined); }
  // eine andere Stunde: der Kasten wird neu gefüllt
  d.fireSvg('pointermove', at(5));
  assert.equal(d.dot.attrs.cx, String(lay.xs[5]));
  assert.equal(d.tip.children[1].children[0].textContent, FMT.deg(lay.hs[5].temp, 1));
});

test('bind: die Zeile der zweiten Meinung fehlt ohne nahe Station; eine Zeile ohne Werte entfällt; kein Wettertext bei „–“', () => {
  const c = curveOf('om-frost.json', JAN13_MS, mosFor('om-frost.json', 40000));
  const { lay, d, at } = bindOn(c, { fmt: Object.assign({}, TIP_FMT, { wmo: () => '–' }) });
  d.fireSvg('pointermove', at(12));
  assert.equal(lay.mos, false);
  assert.equal(d.tip.children.length, 2 + 3, 'Kopf, Haupt, Wind, Regen, Feuchte; keine MOSMIX-Zeile');
  assert.doesNotMatch(texte(d.tip).join('|'), /chartTipMos/);
  assert.equal(d.tip.children[0].textContent, 'Mo Z' + (lay.hs[12].ms % 86400000 / HOUR), 'kein „ · –“ ohne Wettertext');
  // Stunde ohne Wind, Böen, Regen und Feuchte: nur Kopf und Temperatur
  const nackt = Object.assign({}, c.model, { hours: c.model.hours.map((h) => Object.assign({}, h, { wind: null, gust: null, pp: null, pr: null, rh: null, dew: null, app: null })) });
  const o = bindOn({ model: nackt, verdict: c.verdict, now: c.now });
  o.d.fireSvg('pointermove', o.at(3));
  assert.equal(o.d.tip.children.length, 2);
  assert.equal(o.d.tip.children[1].children.length, 1, 'ohne gefühlte Temperatur nur die große Zahl');
  // Regen: die Menge nur, wenn es regnet
  const nass = Object.assign({}, c.model, { hours: c.model.hours.map((h) => Object.assign({}, h, { pp: 80, pr: 1.25 })) });
  const r = bindOn({ model: nass, verdict: c.verdict, now: c.now });
  r.d.fireSvg('pointermove', r.at(3));
  assert.ok(texte(r.d.tip).some((x) => x.includes('dayRain(mm=1.3)') || x.includes('dayRain(mm=1.2)')), texte(r.d.tip).join('|'));
  const trocken = Object.assign({}, c.model, { hours: c.model.hours.map((h) => Object.assign({}, h, { pp: 80, pr: 0 })) });
  const tr = bindOn({ model: trocken, verdict: c.verdict, now: c.now });
  tr.d.fireSvg('pointermove', tr.at(3));
  assert.doesNotMatch(texte(tr.d.tip).join('|'), /dayRain/);
});

test('bind: der Kasten bleibt im Bild (links und rechts begrenzt); Zeiger links vom Bild wählt die erste, rechts die letzte Stunde', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const { lay, d, at } = bindOn(c);
  d.fireSvg('pointermove', { clientX: -500, pointerType: 'mouse', target: d.svg });
  assert.equal(d.dot.attrs.cx, String(lay.xs[0]));
  assert.equal(d.tip.style.left, (150 / 2 + 4) + 'px', 'links begrenzt auf halbe Kastenbreite + 4');
  d.fireSvg('pointermove', { clientX: 5000, pointerType: 'mouse', target: d.svg });
  assert.equal(d.dot.attrs.cx, String(lay.xs[71]));
  assert.equal(d.tip.style.left, (360 - 150 / 2 - 4) + 'px', 'rechts begrenzt');
  d.fireSvg('pointermove', at(36));
  const left = Number(d.tip.style.left.replace('px', ''));
  assert.ok(Math.abs(left - lay.xs[36] / lay.W * 360) < 0.01, 'in der Mitte unter der Stunde');
});

test('bind: Maus verlässt das Bild → Kasten weg; Finger bleibt, bis außerhalb getippt oder abgebrochen wird; Tippen im Bild lässt ihn stehen', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const { d, at } = bindOn(c);
  d.fireSvg('pointermove', at(20));
  assert.equal(d.tip.hidden, false);
  d.fireSvg('pointerleave', { pointerType: 'mouse' });
  assert.equal(d.tip.hidden, true);
  assert.equal(d.cur.attrs.opacity, '0');
  assert.equal(d.dot.attrs.opacity, '0');

  // Finger: pointerdown zeigt, pointerleave (kommt nach dem Loslassen) verbirgt nicht
  d.fireSvg('pointerdown', Object.assign(at(20), { pointerType: 'touch' }));
  assert.equal(d.tip.hidden, false);
  d.fireSvg('pointerleave', { pointerType: 'touch' });
  assert.equal(d.tip.hidden, false, 'der Kasten bleibt nach dem Loslassen stehen');
  d.fireDoc('pointerdown', { target: { insideSvg: true } });
  assert.equal(d.tip.hidden, false, 'ein Tippen auf die Kurve schließt ihn nicht');
  d.fireDoc('pointerdown', { target: { insideSvg: false } });
  assert.equal(d.tip.hidden, true, 'ein Tippen daneben schließt ihn');
  // Abbruch (der Browser übernimmt das senkrechte Scrollen)
  d.fireSvg('pointerdown', Object.assign(at(21), { pointerType: 'touch' }));
  assert.equal(d.tip.hidden, false);
  d.fireSvg('pointercancel', { pointerType: 'touch' });
  assert.equal(d.tip.hidden, true);
  // nach dem Verbergen füllt dieselbe Stunde den Kasten neu
  d.fireSvg('pointermove', at(21));
  assert.equal(d.tip.hidden, false);
  assert.ok(d.tip.children.length >= 2);
});

test('bind: ohne Bild, ohne Kasten, ohne Layout oder mit leerem Layout nichts zu tun und kein Wurf', () => {
  const c = curveOf('om-frost.json', JAN13_MS);
  const lay = layoutOf(c);
  const d = fakeDom();
  for (const args of [[null, d.tip, lay], [d.svg, null, lay], [d.svg, d.tip, null], [d.svg, d.tip, {}], [d.svg, d.tip, layoutOf(curveOf('om-stale.json', Date.UTC(2026, 9, 20, 9, 0)))]]) {
    const unbind = chart.bind(...args, { fmt: TIP_FMT, t: tSpur });
    assert.equal(typeof unbind, 'function');
    assert.doesNotThrow(() => unbind());
  }
  assert.deepEqual(d.listeners(), { svg: 0, doc: 0 }, 'nichts angemeldet');
  // ohne opts: Rückfälle für t und Formatierer
  const b = chart.bind(d.svg, d.tip, lay);
  d.fireSvg('pointermove', { clientX: 100, pointerType: 'mouse', target: d.svg });
  assert.equal(d.tip.hidden, false);
  b();
});
