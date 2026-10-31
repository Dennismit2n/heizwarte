/*
 * Heizwarte — Tests für die Sehhilfen der Werkstatt (31.10.2026): Hoher Kontrast, Farbenblind, Umgekehrte Farben.
 *
 * Die Wahl gilt in allen Werkzeugen auf dem Ursprung dennismit2n.github.io und liegt als roher Text unter
 * werkstatt.darstellung; hw:theme bleibt der Rückfall. Geprüft wird ohne Browser:
 *  - boot.js setzt data-theme und data-vision aus dem gemeinsamen Schlüssel, vor hw:theme, samt Metas,
 *  - visionOf und schemeOf (rein) lösen die acht Werte auf, „System“ folgt „Kontrast erhöhen“,
 *  - die Temperaturfarben halten im Hohen Kontrast 7:1 auf Schwarz bzw. Weiß und bei Umkehr im Dunkeln 4,5:1 NACH
 *    dem Umdrehen (die Seite wird per filter: invert(1) gedreht), über ein Halbgrad-Raster von −12 bis 34 °C,
 *  - die Auswahl hat die acht Einträge mit Beschriftung, die CSS die Blöcke, storage.js die zwei rohen Zugriffe.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Heizwarte = require('./_load.js');
const { fakeStorage } = require('./_fake.js');
const { oklchToHex, contrast } = require('./_farbe.js');
const { THEMES, visionOf, schemeOf } = require('../js/app.js');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const bootCode = lies('js/boot.js');
const html = lies('index.html');
const cssPur = lies('css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const de = Heizwarte.i18n.I18N.de;
const chart = Heizwarte.chart;

// boot.js in einer vm: shared = Wert unter werkstatt.darstellung, theme = roher Wert unter hw:theme
function boot(shared, theme, mm) {
  const attrs = {};
  const metas = [{ content: '#111821', setAttribute(n, v) { this.content = v; } }, { content: '#F3F3F6', setAttribute(n, v) { this.content = v; } }];
  const box = {
    document: {
      documentElement: { setAttribute(n, v) { attrs[n] = v; } },
      querySelectorAll: () => metas
    },
    localStorage: { getItem: (k) => (k === 'werkstatt.darstellung' ? shared : theme) }
  };
  if (mm) { box.matchMedia = mm; }
  vm.runInNewContext(bootCode, box);
  return { attrs, metas: metas.map((m) => m.content) };
}

test('boot.js: der gemeinsame Schlüssel gilt vor hw:theme und setzt data-theme, data-vision und die Metas', () => {
  assert.deepEqual(boot('hc-dark', null), { attrs: { 'data-theme': 'dark', 'data-vision': 'contrast' }, metas: ['#000000', '#000000'] });
  assert.deepEqual(boot('hc-light', '"dark"'), { attrs: { 'data-theme': 'light', 'data-vision': 'contrast' }, metas: ['#FFFFFF', '#FFFFFF'] });
  assert.deepEqual(boot('cvd-light', null), { attrs: { 'data-theme': 'light', 'data-vision': 'cvd' }, metas: ['#F3F3F6', '#F3F3F6'] });
  assert.deepEqual(boot('invert', '"light"'), { attrs: { 'data-vision': 'invert' }, metas: ['#111821', '#F3F3F6'] });
  assert.deepEqual(boot('dark', '"light"').attrs, { 'data-theme': 'dark' }, 'roh, nicht JSON, wie die anderen Werkzeuge');
  assert.deepEqual(boot('soft-dark', null).attrs, { 'data-theme': 'dark' }, 'Spectrotons eigener Wert zählt als dunkel');
  assert.deepEqual(boot(null, '"light"').attrs, { 'data-theme': 'light' }, 'ohne gemeinsamen Schlüssel gilt hw:theme');
  assert.deepEqual(boot('system', '"light"').attrs, {}, '„System“ im gemeinsamen Schlüssel schlägt hw:theme');
});

test('boot.js: „System“ mit „Kontrast erhöhen“ am Gerät setzt Hohen Kontrast in der Gerätefarbe', () => {
  const geraet = (hell, mehr) => (q) => ({ matches: q === '(prefers-contrast: more)' ? mehr : hell });
  assert.deepEqual(boot(null, null, geraet(false, true)).attrs, { 'data-theme': 'dark', 'data-vision': 'contrast' });
  assert.deepEqual(boot('system', null, geraet(true, true)).attrs, { 'data-theme': 'light', 'data-vision': 'contrast' });
  assert.deepEqual(boot(null, null, geraet(true, false)).attrs, {});
});

test('visionOf: acht Werte, unbekannte zählen als System, „Kontrast erhöhen“ nur bei System', () => {
  assert.deepEqual(THEMES, ['system', 'light', 'dark', 'hc-dark', 'hc-light', 'cvd-dark', 'cvd-light', 'invert']);
  const v = (c, hell, mehr) => visionOf(c, hell, mehr);
  assert.deepEqual(v('light', false, true), { theme: 'light', vision: null });
  assert.deepEqual(v('hc-dark', true, false), { theme: 'dark', vision: 'contrast' });
  assert.deepEqual(v('hc-light', false, false), { theme: 'light', vision: 'contrast' });
  assert.deepEqual(v('cvd-dark', true, false), { theme: 'dark', vision: 'cvd' });
  assert.deepEqual(v('invert', false, true), { theme: null, vision: 'invert' });
  assert.deepEqual(v('system', true, true), { theme: 'light', vision: 'contrast' });
  assert.deepEqual(v('system', false, false), { theme: null, vision: null });
  assert.deepEqual(v('Unsinn', false, false), { theme: null, vision: null });
});

test('schemeOf: Hoher Kontrast und Umkehr im Dunkeln wählen eigene Ankertabellen', () => {
  assert.equal(schemeOf('dark', true, 'contrast'), 'hc-dark');
  assert.equal(schemeOf('light', false, 'contrast'), 'hc-light');
  assert.equal(schemeOf(undefined, false, 'invert'), 'inv-dark');
  assert.equal(schemeOf(undefined, true, 'invert'), 'light', 'umgedreht hell braucht keine eigene Tabelle');
  assert.equal(schemeOf('light', false, 'cvd'), 'light');
  assert.equal(schemeOf(undefined, false, undefined), 'dark');
});

// tcol liefert 'oklch(L% C H)'; in Hex über die Rechnung der Testhilfe (Kanäle geklemmt)
function hex(css) {
  const m = /oklch\(([\d.]+)% ([\d.]+) ([\d.]+)/.exec(css);
  return oklchToHex(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}
const umgedreht = (h) => '#' + [1, 3, 5].map((i) => (255 - parseInt(h.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');

test('Temperaturfarben: im Hohen Kontrast jede Stufe mindestens 7:1 auf Schwarz bzw. Weiß', () => {
  for (let t = -12; t <= 34; t += 0.5) {
    const dunkel = hex(chart.tcol(t, undefined, 'hc-dark'));
    const hell = hex(chart.tcol(t, undefined, 'hc-light'));
    assert.ok(contrast(dunkel, '#000000') >= 7, t + ' °C hc-dark ' + dunkel + ': ' + contrast(dunkel, '#000000').toFixed(2));
    assert.ok(contrast(hell, '#FFFFFF') >= 7, t + ' °C hc-light ' + hell + ': ' + contrast(hell, '#FFFFFF').toFixed(2));
  }
});

test('Temperaturfarben: bei Umkehr im Dunkeln hält jede Stufe NACH dem Umdrehen 4,5:1 gegen beide Grundtöne', () => {
  const flaeche = oklchToHex(0.215, 0.02, 252);
  const grund = oklchToHex(0.17, 0.018, 252);
  for (let t = -12; t <= 34; t += 0.5) {
    const f = umgedreht(hex(chart.tcol(t, undefined, 'inv-dark')));
    for (const g of [flaeche, grund]) {
      assert.ok(contrast(f, umgedreht(g)) >= 4.5, t + ' °C umgedreht ' + f + ' auf ' + umgedreht(g) + ': ' + contrast(f, umgedreht(g)).toFixed(2));
    }
  }
  assert.equal(chart.tcol(10, undefined, 'unbekannt'), chart.tcol(10, undefined, 'dark'), 'unbekanntes Schema bleibt dunkel');
});

test('Einstellungen: die Auswahl hat die acht Einträge in dieser Reihenfolge, jeder mit deutscher Beschriftung', () => {
  const ab = html.slice(html.indexOf('id="themeSelect"'));
  const optionen = (ab.slice(0, ab.indexOf('</select>')).match(/<option value="([^"]+)" data-i18n="([^"]+)"/g) || [])
    .map((o) => /value="([^"]+)" data-i18n="([^"]+)"/.exec(o).slice(1));
  assert.deepEqual(optionen.map((o) => o[0]), THEMES);
  for (const [, key] of optionen) { assert.ok(de[key], key + ' fehlt in de'); assert.doesNotMatch(de[key], /[–—]/, key); }
});

test('CSS: Hoher Kontrast hat beide Grundtöne, Umkehr setzt die hellen Werte bei hellem System zurück', () => {
  assert.ok(cssPur.includes(':root[data-vision="contrast"][data-theme="dark"]'));
  assert.ok(cssPur.includes(':root[data-vision="contrast"][data-theme="light"]'));
  assert.ok(cssPur.includes(':root[data-vision="cvd"][data-theme="dark"]'));
  assert.ok(cssPur.includes(':root[data-vision="cvd"][data-theme="light"]'));
  assert.match(cssPur, /:root\[data-vision="invert"\] \{\s*filter: invert\(1\);/);
  const media = cssPur.slice(cssPur.indexOf('@media (prefers-color-scheme: light)'), cssPur.indexOf(':root[data-theme="light"]'));
  assert.ok(media.includes(':root[data-vision="invert"]:not([data-theme])'), 'Rücksetzung steht in der einen @media');
  assert.match(cssPur, /@media print \{[\s\S]*:root\[data-vision="invert"\][\s\S]*filter: none;/, 'gedruckt wird nie umgedreht');
});

test('storage.js: getShared/setShared lesen und schreiben werkstatt.darstellung roh, sonst nichts', () => {
  const be = fakeStorage({ 'werkstatt.darstellung': 'hc-dark' });
  Heizwarte.storage.use(be);
  assert.equal(Heizwarte.storage.getShared('werkstatt.darstellung'), 'hc-dark');
  assert.equal(Heizwarte.storage.setShared('werkstatt.darstellung', 'invert'), true);
  assert.equal(be.getItem('werkstatt.darstellung'), 'invert', 'roh, ohne JSON und ohne hw:');
  assert.equal(Heizwarte.storage.getShared('hw:theme'), null, 'nur der freigegebene Schlüssel');
  assert.equal(Heizwarte.storage.setShared('fremd', 'x'), false);
  assert.equal(Heizwarte.storage.setShared('werkstatt.darstellung', 3), false, 'nur Text');
  Heizwarte.storage.use(fakeStorage());
});
