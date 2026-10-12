/*
 * Heizwarte — Tests für die Theme-Wahl System/Hell/Dunkel (BAUPLAN Abschnitt 8, „Theme ab M3“, und Abschnitt 4: hw:theme).
 *
 * Geprüft wird ohne Browser:
 *  - boot.js liest hw:theme als JSON in try/catch und setzt data-theme nur bei "light" und "dark" (in einer vm mit
 *    Attrappen für document und localStorage; jeder kaputte Wert, ein werfender Speicher und fehlendes DOM bleiben still),
 *  - index.html trägt zwei theme-color-Metas mit media und color-scheme "dark light", und die Töne stimmen in
 *    index.html, boot.js und app.js überein,
 *  - style.css hat den dunklen :root und zwei wortgleiche helle Blöcke mit denselben Variablen, darunter die zwölf
 *    Variablen für Kurve und Wettersymbole,
 *  - die Einstellungen haben <select id="themeSelect"> mit den drei Optionen, und app.js speichert über persist() und
 *    forget(), setzt data-theme samt Metas und zeichnet bei einem Systemwechsel neu.
 * Der Kontrast der hellen Farben folgt mit contrast.test.js im nächsten Schritt.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Heizwarte = require('./_load.js');
const { THEME_COLOR, themeOf, applyTheme } = require('../js/app.js');

const de = Heizwarte.i18n.I18N.de;
const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = lies('index.html');
const css = lies('css/style.css');
const appCode = lies('js/app.js');
const bootCode = lies('js/boot.js');

const DARK = '#111821';
const LIGHT = '#F3F3F6';

function funktion(code, name) {
  const start = code.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function ' + name + ' fehlt in app.js');
  const rest = code.slice(start + 1);
  const next = rest.search(/\n  (?:async )?function \w+\(/);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

// Attribute eines öffnenden Tags als Objekt
function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g;
  let m;
  const inner = tag.replace(/^<[a-zA-Z0-9-]+/, '').replace(/>$/, '');
  while ((m = re.exec(inner))) { out[m[1]] = m[2] === undefined ? '' : m[2]; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Attrappen: ein <html>-Element und zwei Metas
// ---------------------------------------------------------------------------------------------

function fakeDoc() {
  const doc = {
    attrs: {},
    metas: [
      { media: '(prefers-color-scheme: dark)', content: DARK, getAttribute(n) { return n === 'media' ? this.media : this.content; }, setAttribute(n, v) { if (n === 'content') { this.content = v; } } },
      { media: '(prefers-color-scheme: light)', content: LIGHT, getAttribute(n) { return n === 'media' ? this.media : this.content; }, setAttribute(n, v) { if (n === 'content') { this.content = v; } } }
    ]
  };
  doc.documentElement = {
    setAttribute(n, v) { doc.attrs[n] = v; },
    removeAttribute(n) { delete doc.attrs[n]; },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(doc.attrs, n) ? doc.attrs[n] : null; }
  };
  doc.querySelectorAll = (sel) => {
    assert.equal(sel, 'meta[name="theme-color"]');
    return doc.metas;
  };
  return doc;
}

// boot.js in einer vm laufen lassen. stored ist der rohe Wert unter hw:theme (null = fehlt); 'throw' lässt den Zugriff
// auf localStorage werfen; opts.noDocument lässt document weg.
function runBoot(stored, opts) {
  const doc = fakeDoc();
  const box = {};
  if (!(opts && opts.noDocument)) { box.document = doc; }
  if (stored === 'throw') {
    Object.defineProperty(box, 'localStorage', { get() { throw new Error('gesperrt'); } });
  } else {
    box.localStorage = {
      getItem(key) {
        assert.equal(key, 'hw:theme', 'boot.js liest nur hw:theme');
        return stored;
      }
    };
  }
  vm.runInNewContext(bootCode, box);
  return doc;
}

test('boot.js: "light" und "dark" als JSON setzen data-theme und beide theme-color-Metas', () => {
  const hell = runBoot('"light"');
  assert.equal(hell.attrs['data-theme'], 'light');
  assert.deepEqual(hell.metas.map((m) => m.content), [LIGHT, LIGHT]);
  const dunkel = runBoot('"dark"');
  assert.equal(dunkel.attrs['data-theme'], 'dark');
  assert.deepEqual(dunkel.metas.map((m) => m.content), [DARK, DARK]);
});

test('boot.js: fehlender, kaputter oder fremder Wert lässt „System“ stehen, nichts wirft', () => {
  // null = Schlüssel fehlt; 'light' ohne Anführungszeichen ist kein JSON (so schreibt die Startseite, hier nicht gültig)
  for (const roh of [null, '', 'light', 'dark', '"system"', '"Light"', '"hell"', 'null', '1', 'true', '{}', '["light"]', '{"light":1}', '"light', '\u0000']) {
    const doc = runBoot(roh);
    assert.deepEqual(doc.attrs, {}, 'kein data-theme bei ' + JSON.stringify(roh));
    assert.deepEqual(doc.metas.map((m) => m.content), [DARK, LIGHT], 'Metas unverändert bei ' + JSON.stringify(roh));
  }
});

test('boot.js: gesperrter Speicher und fehlendes DOM werfen nicht und ändern nichts', () => {
  const gesperrt = runBoot('throw');
  assert.deepEqual(gesperrt.attrs, {});
  assert.deepEqual(gesperrt.metas.map((m) => m.content), [DARK, LIGHT]);
  assert.doesNotThrow(() => runBoot('"light"', { noDocument: true }));
});

test('boot.js: nur JSON.parse(localStorage.getItem(\'hw:theme\')) in try/catch, kein innerHTML, keine Abhängigkeit von storage.js', () => {
  assert.ok(bootCode.includes("JSON.parse(localStorage.getItem('hw:theme'))"));
  assert.match(bootCode, /try \{[\s\S]*\} catch \(e\) \{/);
  assert.doesNotMatch(bootCode, /innerHTML|Heizwarte\.|\.style\b/);
});

// ---------------------------------------------------------------------------------------------
// index.html: zwei Metas, color-scheme
// ---------------------------------------------------------------------------------------------

test('index.html: zwei theme-color-Metas mit media dunkel und hell, color-scheme „dark light“', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const metas = (head.match(/<meta [^>]*>/g) || []).map(attrs);
  const farben = metas.filter((m) => m.name === 'theme-color');
  assert.equal(farben.length, 2, 'genau zwei theme-color-Metas');
  assert.deepEqual(farben.map((m) => [m.media, m.content]), [
    ['(prefers-color-scheme: dark)', DARK],
    ['(prefers-color-scheme: light)', LIGHT]
  ]);
  const schema = metas.filter((m) => m.name === 'color-scheme');
  assert.equal(schema.length, 1);
  assert.equal(schema[0].content, 'dark light');
  // boot.js steht nach den Metas im <head>, sonst fände es beim Lauf keine zum Überschreiben
  assert.ok(head.lastIndexOf('<meta name="theme-color"') < head.indexOf('src="./js/boot.js'));
});

test('Töne: index.html, boot.js und app.js nennen dieselben zwei Werte', () => {
  assert.deepEqual(THEME_COLOR, { dark: DARK, light: LIGHT });
  assert.ok(bootCode.includes("'" + LIGHT + "'") && bootCode.includes("'" + DARK + "'"));
  const manifest = JSON.parse(lies('manifest.webmanifest'));
  assert.equal(manifest.theme_color, DARK, 'der Ton des Manifests (ohne Metas) bleibt dunkel');
});

// ---------------------------------------------------------------------------------------------
// style.css: dunkler :root, zwei wortgleiche helle Blöcke
// ---------------------------------------------------------------------------------------------

// Der Inhalt zwischen { und passender } hinter der ersten Fundstelle von opener
function block(src, opener) {
  const at = src.indexOf(opener);
  assert.ok(at >= 0, opener + ' fehlt in style.css');
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') { depth += 1; }
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { return src.slice(src.indexOf('{', at) + 1, i); }
    }
  }
  throw new Error('Block ohne Ende: ' + opener);
}

// Zeilen ohne Einrückung und Kommentare, damit „wortgleich“ unabhängig vom Einrücken gilt
function normal(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((z) => z.trim()).filter(Boolean).join('\n');
}

function vars(body) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) { out[m[1]] = m[2].trim(); }
  return out;
}

// Kommentare vorab entfernen: der Kopf der CSS nennt dieselben Selektoren in Worten
const cssPur = css.replace(/\/\*[\s\S]*?\*\//g, '');
const dunkel = block(cssPur, '\n:root {');
const hellSystem = block(cssPur, ':root:not([data-theme="dark"])');
const hellGewaehlt = block(cssPur, ':root[data-theme="light"]');

const CHART_ICON = ['--chart-night', '--chart-grid', '--chart-rain', '--chart-mos',
  '--ic-sun', '--ic-moon', '--ic-cloud', '--ic-cloud-dark', '--ic-fog', '--ic-rain', '--ic-snow', '--ic-bolt'];

test('CSS: der Hell-Block für „System“ steht in @media (prefers-color-scheme: light) und schließt data-theme="dark" aus', () => {
  const media = block(cssPur, '@media (prefers-color-scheme: light)');
  assert.ok(media.includes(':root:not([data-theme="dark"])'));
  assert.equal(cssPur.split(':root:not([data-theme="dark"])').length - 1, 1);
  // der Hell-Block für die Wahl „Hell“ steht außerhalb jeder @media
  const vorMedia = cssPur.slice(0, cssPur.indexOf('@media (prefers-color-scheme: light)'));
  assert.ok(!vorMedia.includes(':root[data-theme="light"]'));
  assert.equal(cssPur.split(':root[data-theme="light"]').length - 1, 1);
});

test('CSS: die zwei hellen Blöcke sind wortgleich', () => {
  assert.equal(normal(hellSystem), normal(hellGewaehlt));
});

test('CSS: dunkel ist der Standard, hell trägt color-scheme light', () => {
  assert.match(dunkel, /color-scheme: dark;/);
  assert.match(hellSystem, /color-scheme: light;/);
  assert.match(hellGewaehlt, /color-scheme: light;/);
  // kein Hell-Wert im Wurzelblock: wo kein prefers-color-scheme gemeldet wird, bleibt es dunkel (Dennis ist lichtempfindlich)
  assert.equal(vars(dunkel)['--bg'], 'oklch(17% 0.018 252)');
  assert.equal(cssPur.split('prefers-color-scheme').length - 1, 1, 'genau eine @media (prefers-color-scheme)');
  assert.ok(cssPur.includes('@media (prefers-color-scheme: light)'), 'und sie fragt nach hell, dunkel ist der Wurzelblock');
});

test('CSS: Hell-Werte aus Abschnitt 8 (Flächen, Text, Ampel) stehen wörtlich da', () => {
  const soll = {
    '--bg': '#F3F3F6', '--surface': '#FFFFFF', '--line': '#DFE0ED', '--fg': '#1C1D27', '--muted': '#4A4D5E', '--faint': '#5F6275',
    '--ok': 'oklch(48% 0.14 152)', '--warn': 'oklch(50% 0.13 92)', '--alarm': 'oklch(52% 0.16 55)', '--crit': 'oklch(50% 0.20 25)'
  };
  for (const [name, wert] of Object.entries(soll)) {
    assert.equal(vars(hellSystem)[name], wert, name + ' hell (System)');
    assert.equal(vars(hellGewaehlt)[name], wert, name + ' hell (gewählt)');
  }
});

test('CSS: jede Farbvariable des dunklen Blocks hat ein Hell-Gegenstück, die zwölf Kurven- und Symbol-Variablen auch', () => {
  const d = vars(dunkel);
  const farbig = Object.keys(d).filter((n) => /oklch|#[0-9a-fA-F]{3,8}/.test(d[n]));
  for (const name of CHART_ICON) {
    assert.ok(farbig.includes(name), name + ' fehlt im dunklen Block');
  }
  const h = vars(hellSystem);
  for (const name of farbig) {
    assert.ok(Object.prototype.hasOwnProperty.call(h, name), name + ' hat keinen Hell-Wert');
    assert.notEqual(h[name], d[name], name + ' hell ist noch der Dunkelwert');
  }
  // die Schriften gehören nicht zum Theme
  for (const name of ['--display', '--body', '--mono']) { assert.ok(!(name in h), name); }
});

test('chart.js: die Wettersymbole benutzen nur var(--ic-*), nie Festwerte', () => {
  // chart.js nennt für die Symbole nur var(--ic-*); sonst gäbe es im Hell-Theme dunkel abgestimmte Festwerte
  const chart = lies('js/chart.js');
  assert.doesNotMatch(chart, /fill="oklch|stroke="oklch|fill="#|stroke="#/, 'chart.js: Symbole nur über var(--ic-*)');
  for (const name of CHART_ICON.filter((n) => n.startsWith('--ic-'))) {
    assert.ok(chart.includes('var(' + name + ')') || chart.includes("'" + name + "'"), name + ' wird in chart.js benutzt');
  }
});

// ---------------------------------------------------------------------------------------------
// Einstellungen: themeSelect
// ---------------------------------------------------------------------------------------------

test('Einstellungen: themeSelect mit sichtbarer Beschriftung und den drei Optionen, vor dem unteren „Zurück“', () => {
  const start = html.indexOf('id="s-settings"');
  const slice = html.slice(start, html.indexOf('</main>'));
  const label = (slice.match(/<label [^>]*>/g) || []).map(attrs).find((a) => a.for === 'themeSelect');
  assert.ok(label, '<label for="themeSelect"> fehlt');
  assert.equal(label['data-i18n'], 'themeLabel');
  const sel = (slice.match(/<select [^>]*>/g) || []).map(attrs).find((a) => a.id === 'themeSelect');
  assert.ok(sel, 'themeSelect fehlt');
  assert.equal(sel.autocomplete, 'off', 'Firefox stellt sonst nach dem Neuladen eine alte Auswahl wieder her');
  const optionen = (slice.slice(slice.indexOf('id="themeSelect"')).match(/<option [^>]*>/g) || []).slice(0, 3).map(attrs);
  assert.deepEqual(optionen.map((o) => [o.value, o['data-i18n']]), [
    ['system', 'themeSystem'], ['light', 'themeLight'], ['dark', 'themeDark']
  ]);
  for (const k of ['themeLabel', 'themeSystem', 'themeLight', 'themeDark']) { assert.ok(de[k], k); }
  assert.ok(slice.indexOf('id="themeSelect"') > slice.indexOf('id="settingsAdvanced"'));
  assert.ok(slice.indexOf('id="themeSelect"') < slice.indexOf('id="btnSettingsBack2"'));
});

// ---------------------------------------------------------------------------------------------
// app.js: Auswahl, Anwenden, Speichern, Systemwechsel
// ---------------------------------------------------------------------------------------------

test('themeOf: nur "light" und "dark" zählen, alles andere ist „System“', () => {
  assert.equal(themeOf('light'), 'light');
  assert.equal(themeOf('dark'), 'dark');
  for (const x of [undefined, null, '', 'system', 'Light', 'hell', 1, true, {}, ['light']]) {
    assert.equal(themeOf(x), 'system', JSON.stringify(x));
  }
});

test('applyTheme: setzt data-theme und beide Metas; „System“ nimmt das Attribut weg und gibt jeder Meta ihren Ton zurück', () => {
  const vorher = globalThis.document;
  try {
    const doc = fakeDoc();
    globalThis.document = doc;
    applyTheme('light');
    assert.equal(doc.attrs['data-theme'], 'light');
    assert.deepEqual(doc.metas.map((m) => m.content), [LIGHT, LIGHT]);
    applyTheme('dark');
    assert.equal(doc.attrs['data-theme'], 'dark');
    assert.deepEqual(doc.metas.map((m) => m.content), [DARK, DARK]);
    applyTheme('system');
    assert.ok(!('data-theme' in doc.attrs), 'bei „System“ ohne Attribut');
    assert.deepEqual(doc.metas.map((m) => m.content), [DARK, LIGHT], 'dunkle Meta dunkel, helle Meta hell');
    applyTheme('light');
    applyTheme('Unsinn');
    assert.ok(!('data-theme' in doc.attrs), 'ein unbekannter Wert zählt als „System“');
    assert.deepEqual(doc.metas.map((m) => m.content), [DARK, LIGHT]);
  } finally {
    if (vorher === undefined) { delete globalThis.document; } else { globalThis.document = vorher; }
  }
});

test('app.js: Wechsel speichert über persist() ("light"/"dark" als JSON) oder forget(), setzt das Theme und zeichnet neu', () => {
  const onTheme = funktion(appCode, 'onTheme');
  assert.match(onTheme, /if \(value === 'system'\) \{ forget\('theme'\); \} else \{ persist\('theme', value\); \}/);
  assert.match(onTheme, /applyTheme\(value\);\s*onSchemeChange\(\);/);
  assert.doesNotMatch(onTheme, /localStorage|storage\.set|storage\.remove/);
  assert.match(funktion(appCode, 'onSchemeChange'), /state\.screen === 's-main'\) \{ render\(\); \}/);
  assert.match(funktion(appCode, 'renderSettings'), /guard\(renderTheme\);/);
  assert.match(funktion(appCode, 'bindEvents'), /on\('themeSelect', 'change', onTheme\);/);
});

test('app.js: init() hört auf (prefers-color-scheme: light) und zeichnet beim Wechsel neu', () => {
  const init = funktion(appCode, 'init');
  assert.match(init, /root\.matchMedia\('\(prefers-color-scheme: light\)'\)/);
  assert.match(init, /addEventListener\('change', onSchemeChange\)/);
  assert.match(init, /typeof root\.matchMedia === 'function'/, 'ohne matchMedia läuft die App weiter');
});
