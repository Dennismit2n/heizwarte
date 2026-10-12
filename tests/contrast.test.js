/*
 * Heizwarte — Kontrasttest (BAUPLAN Abschnitt 12, „contrast.test.js“, ab Meilenstein 3).
 *
 * Geprüft wird in beiden Themes, ob jede Farbe, die als Text steht, mindestens 4,5:1 (WCAG AA, Fließtext) gegen beide
 * Grundtöne ihres Themes erreicht:
 *  - alle 22 Stufen der Temperaturskala (−10 … 32 °C in 2-K-Schritten) beider Ankertabellen, dazu ein feines Raster in
 *    halben Grad und die sechs Anker selbst, weil echte Temperaturen zwischen den Stufen liegen. Grund für den
 *    Textmaßstab: tcol() färbt echten Kleintext (Tagesspanne, Nachttief-Label, Tooltip),
 *  - die vier Ampelfarben, die auch die Textfarbe der Stufenzeile sind,
 *  - die Textfarben --fg, --muted und --faint.
 * Grundtöne: hell #FFFFFF (--surface) und #F3F3F6 (--bg), dunkel oklch(17% 0.018 252) (--bg) und oklch(21.5% 0.02 252)
 * (--surface, darauf steht der Text wirklich; #111821 ist nur der theme-color-Ton im Manifest).
 *
 * Der Test SCHLÄGT FEHL, statt Farben anzupassen: Liegt ein Wert unter 4,5:1, ändert man die Farbe (L oder C) im Code
 * und in der Festschreibung unten, nie die Schwelle. Die Farbwerte der Variablen liest der Test aus css/style.css und
 * vergleicht sie mit den hier festgeschriebenen Konstanten, damit CSS und Test nicht auseinanderlaufen.
 * Rechnung: OKLCH → sRGB über tests/_farbe.js, Kanäle außerhalb sRGB werden geklemmt, es gibt keine inSrgb-Prüfung
 * (BAUPLAN Abschnitt 5 chart). Ein Browser bildet Farben außerhalb sRGB über die Chroma ab, nicht durch Klemmen.
 * Gegenprobe beim Bau (einmalig, Chroma-Abbildung wie spectroton clampChroma, halbe Grad von −12 bis 34 °C): Die dunkle
 * Skala liegt vollständig in sRGB (Abweichung 0, kleinstes Verhältnis 4,55:1 bei 32 °C auf --surface); bei der hellen
 * weicht das Verhältnis um höchstens 0,42 ab, das kleinste bleibt 5,74:1 (10 °C auf #F3F3F6), Abstand zur Grenze also
 * über 1,2.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { chart } = require('./_load.js');
const { oklchToHex, contrast } = require('./_farbe.js');

const MIN = 4.5;
const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

// Festgeschrieben: die Farben, die diese Prüfung abnimmt. Ändert sich ein Wert im CSS, schlägt der Vergleich unten
// an und zwingt zu einer bewussten Änderung hier (zusammen mit einem neuen Kontrastlauf).
const TOKENS = {
  dark: {
    '--bg': 'oklch(17% 0.018 252)',
    '--surface': 'oklch(21.5% 0.02 252)',
    '--fg': 'oklch(95% 0.008 250)',
    '--muted': 'oklch(72% 0.02 250)',
    '--faint': 'oklch(62% 0.02 250)',
    '--ok': 'oklch(76% 0.15 152)',
    '--warn': 'oklch(85% 0.16 92)',
    '--alarm': 'oklch(73% 0.17 55)',
    '--crit': 'oklch(66% 0.21 25)'
  },
  light: {
    '--bg': '#F3F3F6',
    '--surface': '#FFFFFF',
    '--fg': '#1C1D27',
    '--muted': '#4A4D5E',
    '--faint': '#5F6275',
    '--ok': 'oklch(48% 0.14 152)',
    '--warn': 'oklch(50% 0.13 92)',
    '--alarm': 'oklch(52% 0.16 55)',
    '--crit': 'oklch(50% 0.20 25)'
  }
};
const TEXT = ['--fg', '--muted', '--faint'];
const AMPEL = ['--ok', '--warn', '--alarm', '--crit'];

// Anker der Ankertabellen, festgeschrieben (chart.test.js prüft dieselben Zahlen gegen chart.js)
const ANCH_LIGHT = [[-10, 42, 0.14, 275], [0, 45, 0.11, 245], [10, 48, 0.05, 210], [18, 46, 0.08, 90], [25, 46, 0.16, 58], [32, 44, 0.20, 28]];
const ANCH_DARK = [[-10, 62, 0.13, 275], [0, 72, 0.11, 245], [10, 85, 0.05, 210], [18, 88, 0.08, 90], [25, 76, 0.16, 58], [32, 63, 0.20, 28]];

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

// '#RRGGBB' oder 'oklch(L% C H)' → '#RRGGBB'
function zuHex(wert) {
  const w = String(wert).trim();
  if (/^#[0-9a-f]{6}$/i.test(w)) { return w.toUpperCase(); }
  const m = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(w);
  assert.ok(m, 'weder #RRGGBB noch oklch(L% C H): ' + w);
  return oklchToHex(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}

// Der Inhalt des Blocks hinter dem ersten Vorkommen von selektor (die Blöcke in style.css haben keine Verschachtelung)
function block(selektor, ab) {
  const start = css.indexOf(selektor, ab || 0);
  assert.ok(start >= 0, 'Selektor fehlt in style.css: ' + selektor);
  const auf = css.indexOf('{', start);
  const zu = css.indexOf('}', auf);
  assert.ok(auf > 0 && zu > auf, 'Block nicht lesbar: ' + selektor);
  return css.slice(auf + 1, zu);
}

function variablen(inhalt) {
  const out = {};
  const re = /(--[a-z0-9-]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(inhalt))) { out[m[1]] = m[2].trim(); }
  return out;
}

const mediaStart = css.indexOf('@media (prefers-color-scheme: light) {');
assert.ok(mediaStart >= 0, 'der helle @media-Block fehlt in style.css');
const BLOECKE = {
  dark: { name: ':root (dunkel)', vars: variablen(block(':root {')) },
  light: [
    { name: '@media (prefers-color-scheme: light) :root:not([data-theme="dark"])', vars: variablen(block(':root:not([data-theme="dark"])', mediaStart)) },
    { name: ':root[data-theme="light"]', vars: variablen(block(':root[data-theme="light"]')) }
  ]
};

// Die Grundtöne eines Themes als Hex, in der Reihenfolge (--surface, --bg)
function gruende(scheme) {
  return [zuHex(TOKENS[scheme]['--surface']), zuHex(TOKENS[scheme]['--bg'])];
}

// tcol() liefert 'oklch(L% C H)'; als Hex für die Rechnung
function stufeHex(t, scheme) {
  return zuHex(chart.tcol(t, undefined, scheme));
}

// Prüft einen Text in Hex gegen alle Gründe und bricht mit lesbarer Meldung ab
function pruefe(wer, hex, bgs) {
  for (const bg of bgs) {
    const c = contrast(hex, bg);
    assert.ok(c >= MIN, wer + ' ' + hex + ' auf ' + bg + ' hat nur ' + c.toFixed(2) + ':1 (verlangt ' + MIN + ':1)');
  }
}

function kleinste(hexListe, bgs) {
  let min = Infinity;
  for (const hex of hexListe) { for (const bg of bgs) { min = Math.min(min, contrast(hex, bg)); } }
  return min;
}

// ---------------------------------------------------------------------------------------------
// Handwerkszeug
// ---------------------------------------------------------------------------------------------

test('_farbe: Kontrast Schwarz/Weiß ist 21:1, gleiche Farbe 1:1, die Reihenfolge ist egal', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#336699', '#336699').toFixed(2), '1.00');
  assert.equal(contrast('#336699', '#FFFFFF'), contrast('#FFFFFF', '#336699'));
});

test('_farbe: oklchToHex nimmt L als Anteil; Weiß, Schwarz und ein bekannter Mittelwert stimmen', () => {
  assert.equal(oklchToHex(1, 0, 0), '#FFFFFF');
  assert.equal(oklchToHex(0, 0, 0), '#000000');
  // oklch(62.8% 0.2577 29.23) ist das reine sRGB-Rot
  assert.equal(oklchToHex(0.6279553606, 0.2576833077, 29.2338851923), '#FF0000');
  // Kanäle außerhalb sRGB werden geklemmt, kein NaN, immer sechs Hex-Stellen
  assert.match(oklchToHex(0.9, 0.4, 150), /^#[0-9A-F]{6}$/);
});

test('Kontrolle: der Test kann fehlschlagen – die dunkle Skala fällt auf Weiß durch (Gelb hält auf Weiß nicht)', () => {
  const gelb = stufeHex(18, 'dark');
  assert.ok(contrast(gelb, '#FFFFFF') < 2, 'dunkles Gelb auf Weiß: ' + contrast(gelb, '#FFFFFF').toFixed(2));
  assert.throws(() => pruefe('dunkle Stufe 18 °C', gelb, ['#FFFFFF']), /hat nur/);
});

// ---------------------------------------------------------------------------------------------
// Festschreibung: das CSS trägt genau die Werte, die geprüft werden
// ---------------------------------------------------------------------------------------------

test('CSS: der dunkle :root trägt die festgeschriebenen Farben', () => {
  for (const [name, wert] of Object.entries(TOKENS.dark)) {
    assert.equal(BLOECKE.dark.vars[name], wert, name + ' im dunklen :root');
  }
});

test('CSS: beide hellen Blöcke tragen die festgeschriebenen Farben', () => {
  for (const b of BLOECKE.light) {
    for (const [name, wert] of Object.entries(TOKENS.light)) {
      assert.equal(b.vars[name], wert, name + ' in ' + b.name);
    }
  }
});

test('chart.js: beide Ankertabellen sind festgeschrieben', () => {
  assert.deepEqual(chart.ANCH_DARK, ANCH_DARK);
  assert.deepEqual(chart.ANCH_LIGHT, ANCH_LIGHT);
});

// ---------------------------------------------------------------------------------------------
// Temperaturskala
// ---------------------------------------------------------------------------------------------

for (const scheme of ['light', 'dark']) {
  test('Skala ' + scheme + ': alle 22 Stufen (−10 … 32 °C, 2-K-Schritte) erreichen ' + MIN + ':1 gegen beide Grundtöne', () => {
    const bgs = gruende(scheme);
    const hexe = [];
    for (let k = 0; k < 22; k++) {
      const t = -10 + k * 2;
      const hex = stufeHex(t, scheme);
      hexe.push(hex);
      pruefe(scheme + ' ' + t + ' °C', hex, bgs);
    }
    assert.equal(hexe.length, 22);
    assert.ok(kleinste(hexe, bgs) >= MIN);
  });

  test('Skala ' + scheme + ': auch die Zwischenwerte (halbe Grad von −12 bis 34 °C) und die sechs Anker halten ' + MIN + ':1', () => {
    const bgs = gruende(scheme);
    for (let t = -12; t <= 34; t += 0.5) { pruefe(scheme + ' ' + t + ' °C', stufeHex(t, scheme), bgs); }
    for (const anker of (scheme === 'light' ? ANCH_LIGHT : ANCH_DARK)) { pruefe(scheme + ' Anker ' + anker[0] + ' °C', stufeHex(anker[0], scheme), bgs); }
    // kein Wert (null, NaN) ergibt die neutrale Mitte: auch sie ist Text
    pruefe(scheme + ' ohne Wert', zuHex(chart.tcol(NaN, undefined, scheme)), bgs);
  });

  test('Skala ' + scheme + ': scaleCss() setzt dieselben 22 Stützstellen, die geprüft wurden', () => {
    const css22 = chart.scaleCss(scheme);
    const stuetzen = css22.slice('linear-gradient(90deg,'.length, -1).split(',');
    assert.equal(stuetzen.length, 22);
    stuetzen.forEach((s, k) => { assert.equal(s, chart.tcol(-10 + k * 2, undefined, scheme), 'Stufe ' + k); });
  });
}

// ---------------------------------------------------------------------------------------------
// Ampel und Textfarben
// ---------------------------------------------------------------------------------------------

for (const scheme of ['light', 'dark']) {
  const bloecke = scheme === 'light' ? BLOECKE.light : [BLOECKE.dark];
  test('Ampel ' + scheme + ': ok, warn, alarm und crit erreichen ' + MIN + ':1 gegen beide Grundtöne', () => {
    const bgs = gruende(scheme);
    for (const b of bloecke) {
      for (const name of AMPEL) { pruefe(scheme + ' ' + name + ' (' + b.name + ')', zuHex(b.vars[name]), bgs); }
    }
  });

  test('Textfarben ' + scheme + ': --fg, --muted und --faint erreichen ' + MIN + ':1 gegen beide Grundtöne', () => {
    const bgs = gruende(scheme);
    for (const b of bloecke) {
      for (const name of TEXT) { pruefe(scheme + ' ' + name + ' (' + b.name + ')', zuHex(b.vars[name]), bgs); }
    }
  });

  test('Grundtöne ' + scheme + ': --bg und --surface im CSS sind die, gegen die geprüft wird', () => {
    for (const b of (scheme === 'light' ? BLOECKE.light : [BLOECKE.dark])) {
      assert.equal(zuHex(b.vars['--surface']), gruende(scheme)[0]);
      assert.equal(zuHex(b.vars['--bg']), gruende(scheme)[1]);
    }
  });
}

test('--faint bleibt in beiden Themes leiser als --muted und --fg (nur Rang, nicht Kontrast)', () => {
  for (const scheme of ['light', 'dark']) {
    const bg = gruende(scheme)[0];
    const c = (name) => contrast(zuHex(TOKENS[scheme][name]), bg);
    assert.ok(c('--faint') < c('--muted') && c('--muted') < c('--fg'), scheme);
  }
});
