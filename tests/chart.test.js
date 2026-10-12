/*
 * Tests für chart.js, soweit es in diesem Schritt gebaut ist: die dunkle und die helle Ankertabelle, tcol(), scaleCss() und
 * icon(). Der Kontrast beider Tabellen steht in contrast.test.js. Die Kurve (layout, summary, bind) kommt mit ihren eigenen
 * Tests später dazu.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { chart } = require('./_load.js');

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

test('chart.js läuft in Node ohne DOM und exportiert genau, was dieser Schritt baut', () => {
  assert.deepEqual(Object.keys(chart).sort(), ['ANCH_DARK', 'ANCH_LIGHT', 'icon', 'scaleCss', 'tcol']);
  assert.equal(globalThis.Heizwarte.chart, chart);
});
