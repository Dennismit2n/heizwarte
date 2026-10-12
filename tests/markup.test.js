/*
 * Tests für das Markup der Einrichtung (index.html, css/style.css, js/app.js), ohne Browser und ohne DOM-Paket:
 * ein kleiner Zerleger liest die Tags. Geprüft wird, was der Plan für die Bildschirme festlegt (BAUPLAN Abschnitt 6
 * und 8): jeder Bildschirm mit <h2 tabindex="-1">, sichtbare Beschriftungen statt Platzhaltern, Autofill-Attribute,
 * Fehlerzeilen als role="alert", kein style-Attribut und kein Inline-Skript wegen der CSP, Tippflächen in der CSS.
 * Dazu die Querverweise, die ohne Browser nicht auffielen: jede ID, die app.js anfasst, steht im Markup, und jeder
 * Schlüssel, den app.js als Zeichenkette nennt, steht in de.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');

const de = Heizwarte.i18n.I18N.de;
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

const SCREENS = ['s-welcome', 's-address', 's-hits', 's-confirm', 's-profile', 's-main', 's-settings'];

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Alle öffnenden Tags: { name, attrs, pos }. Attribute ohne Wert zählen als ''.
function tags(src) {
  const out = [];
  const clean = src.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const attrs = {};
    const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(m[2])) !== null) {
      attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
    }
    out.push({ name: m[1].toLowerCase(), attrs, pos: m.index });
  }
  return out;
}

const all = tags(html);
const byId = new Map();
for (const tg of all) {
  if (tg.attrs.id !== undefined) { byId.set(tg.attrs.id, tg); }
}

// Der Teil des Markups von einem Bildschirm bis zum nächsten
function screenSlice(id) {
  const start = html.indexOf('id="' + id + '"');
  assert.ok(start >= 0, id + ' fehlt');
  const rest = html.slice(start);
  const next = rest.indexOf('<section class="screen"', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

test('CSP: kein style-Attribut, kein Inline-Skript, keine Ereignis-Attribute', () => {
  for (const tg of all) {
    assert.equal(tg.attrs.style, undefined, '<' + tg.name + '> trägt ein style-Attribut');
    for (const name of Object.keys(tg.attrs)) {
      assert.ok(!/^on/.test(name), '<' + tg.name + '> trägt ' + name);
    }
    if (tg.name === 'script') { assert.ok(tg.attrs.src, 'Skript ohne src (Inline-Skript)'); }
    if (tg.name === 'style') { assert.fail('<style> im Markup'); }
  }
  const inhalte = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)).map((m) => m[1].trim());
  assert.ok(inhalte.length >= 8);
  assert.deepEqual(inhalte.filter(Boolean), [], 'Skript mit Inhalt');
  const csp = all.find((tg) => tg.name === 'meta' && tg.attrs['http-equiv'] === 'Content-Security-Policy');
  assert.ok(csp, 'CSP-Meta fehlt');
  assert.match(csp.attrs.content, /script-src 'self'/);
  assert.match(csp.attrs.content, /style-src 'self'/);
  assert.doesNotMatch(csp.attrs.content, /unsafe-inline|unsafe-eval/);
});

test('Viewport erlaubt das Zoomen', () => {
  const vp = all.find((tg) => tg.name === 'meta' && tg.attrs.name === 'viewport');
  assert.ok(vp);
  assert.doesNotMatch(vp.attrs.content, /maximum-scale|user-scalable/);
});

test('IDs sind eindeutig', () => {
  const seen = new Set();
  for (const tg of all) {
    if (tg.attrs.id === undefined) { continue; }
    assert.ok(!seen.has(tg.attrs.id), 'doppelte ID ' + tg.attrs.id);
    seen.add(tg.attrs.id);
  }
});

test('sieben Bildschirme, alle versteckt, jeder mit <h2 tabindex="-1">', () => {
  const screens = all.filter((tg) => tg.name === 'section' && /\bscreen\b/.test(tg.attrs.class || ''));
  assert.deepEqual(screens.map((tg) => tg.attrs.id), SCREENS);
  for (const tg of screens) {
    assert.equal(tg.attrs.hidden, '', tg.attrs.id + ' ist nicht versteckt');
    const h2 = tags(screenSlice(tg.attrs.id)).find((x) => x.name === 'h2');
    assert.ok(h2, tg.attrs.id + ' hat keine h2');
    assert.equal(h2.attrs.tabindex, '-1', tg.attrs.id + ': h2 ohne tabindex -1');
  }
});

test('Überschriften: genau ein h1, keine Stufe übersprungen', () => {
  const levels = all.filter((tg) => /^h[1-6]$/.test(tg.name)).map((tg) => Number(tg.name[1]));
  assert.equal(levels.filter((n) => n === 1).length, 1);
  assert.equal(levels[0], 1);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] - levels[i - 1] <= 1, 'Stufe übersprungen bei Überschrift ' + (i + 1));
  }
});

test('Felder haben eine sichtbare Beschriftung, nie nur einen Platzhalter', () => {
  const labelFor = new Set(all.filter((tg) => tg.name === 'label' && tg.attrs.for).map((tg) => tg.attrs.for));
  for (const tg of all) {
    assert.equal(tg.attrs.placeholder, undefined, 'placeholder an #' + tg.attrs.id);
    assert.equal(tg.attrs['data-i18n-ph'], undefined, 'data-i18n-ph an #' + tg.attrs.id);
    if (tg.name !== 'input') { continue; }
    if (tg.attrs.type === 'radio') { continue; }
    assert.ok(labelFor.has(tg.attrs.id), '<label for="' + tg.attrs.id + '"> fehlt');
  }
  // Radiokarten: das Eingabefeld sitzt im <label>, fünf Heizarten, eine gemeinsame Gruppe
  const radios = all.filter((tg) => tg.name === 'input' && tg.attrs.type === 'radio');
  assert.deepEqual(radios.map((tg) => tg.attrs.value), ['radiator', 'floorScreed', 'floorDry', 'heatpumpFloor', 'storage']);
  for (const r of radios) {
    assert.equal(r.attrs.name, 'heatType');
    const before = html.slice(0, r.pos);
    assert.ok(before.lastIndexOf('<label class="choice">') > before.lastIndexOf('</label>'), r.attrs.id + ' steht nicht in seinem Label');
  }
  assert.match(html, /role="radiogroup" aria-labelledby="h-profile"/);
});

test('Adressfelder tragen autocomplete, inputmode und enterkeyhint aus Abschnitt 6', () => {
  const f = (id) => byId.get(id).attrs;
  assert.equal(f('f-street').autocomplete, 'street-address');
  assert.equal(f('f-street').enterkeyhint, 'next');
  assert.equal(f('f-zip').autocomplete, 'postal-code');
  assert.equal(f('f-zip').inputmode, 'text');
  assert.equal(f('f-city').autocomplete, 'address-level2');
  assert.equal(f('f-city').enterkeyhint, 'search');
  assert.equal(f('f-elev').type, 'number');
  assert.equal(f('f-elev').inputmode, 'numeric');
  assert.equal(f('f-elev').min, '-500');
  assert.equal(f('f-elev').max, '9000');
  assert.equal(f('f-elev').step, '1');
  assert.equal(f('f-label').maxlength, '40');
});

test('Knöpfe: type gesetzt, nie disabled; Suchen ist ein Submit-Knopf im Formular', () => {
  const buttons = all.filter((tg) => tg.name === 'button');
  assert.ok(buttons.length > 10);
  for (const b of buttons) {
    assert.ok(b.attrs.type === 'button' || b.attrs.type === 'submit', '#' + b.attrs.id + ' ohne type');
    assert.equal(b.attrs.disabled, undefined, '#' + b.attrs.id + ' trägt disabled (erlaubt ist nur aria-disabled)');
  }
  assert.equal(byId.get('btnSearch').attrs.type, 'submit');
  assert.equal(byId.get('addrForm').name, 'form');
  assert.ok(html.indexOf('id="btnSearch"') > html.indexOf('id="addrForm"'));
  assert.ok(html.indexOf('id="btnSearch"') < html.indexOf('</form>'));
});

test('Fehlerzeilen sind leere role="alert"-Divs mit tabindex -1 und liegen über dem Hauptknopf', () => {
  for (const name of ['welcome', 'address', 'confirm']) {
    const box = byId.get('err-' + name);
    assert.ok(box, 'err-' + name);
    assert.equal(box.name, 'div');
    assert.equal(box.attrs.role, 'alert');
    assert.equal(box.attrs.tabindex, '-1');
    assert.match(html, new RegExp('id="err-' + name + '"[^>]*></div>'), 'err-' + name + ' ist nicht leer');
  }
  const primary = { welcome: 'btnByAddress', address: 'btnSearch', confirm: 'btnConfirmYes' };
  for (const name of Object.keys(primary)) {
    assert.ok(html.indexOf('id="err-' + name + '"') < html.indexOf('id="' + primary[name] + '"'), 'err-' + name + ' steht nicht über dem Hauptknopf');
  }
});

test('Statuszeile ist die einzige aria-live-Zeile des Hauptbildschirms; der Zähler ist polite', () => {
  assert.equal(byId.get('status').attrs['aria-live'], 'polite');
  assert.equal(byId.get('setupStep').attrs['aria-live'], 'polite');
  const live = all.filter((tg) => tg.attrs['aria-live'] !== undefined).map((tg) => tg.attrs.id);
  assert.deepEqual(live, ['setupStep', 'status']);
  const main = tags(screenSlice('s-main')).filter((tg) => tg.attrs['aria-live'] !== undefined).map((tg) => tg.attrs.id);
  assert.deepEqual(main, ['status']);
});

test('CSS: Tippflächen 48 und 64 px, Fokusring bleibt, Größen in rem', () => {
  assert.match(css, /button,\s*\.hit,\s*select,\s*input,\s*summary,\s*a\.footer-link\s*\{[^}]*min-height: 48px;[^}]*min-width: 48px;/);
  assert.match(css, /\.hit\s*\{\s*min-height: 64px;/);
  assert.match(css, /\.choice\s*\{[^}]*min-height: 64px;/);
  assert.match(css, /:focus-visible\s*\{\s*outline: 3px solid var\(--fg\);\s*outline-offset: 2px;/);
  assert.doesNotMatch(css, /outline:\s*(none|0)\b/, 'der Fokusring darf nie wegfallen');
  assert.doesNotMatch(css, /font-size:\s*[\d.]+px/);
  assert.match(css, /\[hidden\]\s*\{\s*display: none !important;/);
  assert.equal((css.match(/!important/g) || []).length, 1, 'nur [hidden] darf !important tragen');
  assert.doesNotMatch(css, /@keyframes|animation:|transition:/, 'keine Animationen (Abschnitt 8)');
});

test('app.js: kein innerHTML, kein style-Attribut, kein eval', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(code, /setAttribute\(\s*['"]style|cssText|\beval\(|new Function/);
  assert.doesNotMatch(code, /localStorage/, 'Zugriffe laufen über Heizwarte.storage');
});

test('app.js: jede ID, die der Code anfasst, steht im Markup', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '');
  const ids = new Set();
  let m;
  const re = /(?:\$|\bon|nextOnEnter)\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?/g;
  while ((m = re.exec(code)) !== null) {
    if (!/^[A-Za-z][\w-]*$/.test(m[1])) { continue; }
    ids.add(m[1]);
    if (m[2] && /^f-/.test(m[2])) { ids.add(m[2]); }
  }
  assert.ok(ids.size > 30, 'zu wenige IDs erkannt: ' + ids.size);
  for (const id of ids) {
    // 's-', 'r-', 'err-' und 'act-' sind Präfixe dynamischer IDs und werden unten einzeln geprüft
    if (id === 's-' || id === 'r-' || id === 'err-' || id === 'act-') { continue; }
    assert.ok(byId.has(id), 'app.js nennt #' + id + ', das Markup nicht');
  }
  for (const id of SCREENS) { assert.ok(code.includes("'" + id + "'"), id + ' fehlt in SCREENS'); }
  for (const type of ['radiator', 'floorScreed', 'floorDry', 'heatpumpFloor', 'storage']) {
    assert.ok(byId.has('r-' + type), '#r-' + type);
  }
  for (const name of ['welcome', 'address', 'confirm']) {
    assert.ok(byId.has('err-' + name), '#err-' + name);
    assert.ok(byId.has('s-' + name), '#s-' + name);
  }
  for (const name of ['welcome', 'address']) { assert.ok(byId.has('act-' + name), '#act-' + name); }
});

test('app.js: jeder Schlüssel, den der Code als Zeichenkette nennt, steht in de', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  const keys = new Set();
  const re = /'((?:err|setup|btn|hit|profile|status|store|storage|now)[A-Z]\w*)'/g;
  let m;
  while ((m = re.exec(code)) !== null) { keys.add(m[1]); }
  for (const k of ['setupSearching', 'setupSearch', 'setupByLocation', 'setupConfirmYes', 'errNeedPlace', 'errNoHit', 'errElevRange', 'hitHouse']) {
    assert.ok(keys.has(k), 'Prüfer erkennt ' + k + ' nicht');
  }
  // Namen wie 'btnSearch' sind Element-IDs und stehen im Markup; alles andere muss ein Schlüssel sein
  for (const k of keys) { assert.ok(has(de, k) || byId.has(k), 'app.js nennt ' + k + ', weder de noch das Markup kennen es'); }
});

test('Markup: jeder Schlüssel von data-i18n steht in de (auch die Fehlerzeilen-Knöpfe)', () => {
  for (const tg of all) {
    if (tg.attrs['data-i18n'] !== undefined) { assert.ok(has(de, tg.attrs['data-i18n']), '#' + tg.attrs.id + ': ' + tg.attrs['data-i18n']); }
  }
  // Auswege der Fehlerzeilen laut Tabelle in Abschnitt 6
  assert.equal(byId.get('btnCityOnly').attrs['data-i18n'], 'btnCityOnly');
  assert.equal(byId.get('btnAddrRetry').attrs['data-i18n'], 'btnRetry');
  assert.equal(byId.get('btnWelcomeRetry').attrs['data-i18n'], 'btnRetry');
  assert.equal(byId.get('btnWelcomeNext').attrs['data-i18n'], 'btnNext');
  assert.equal(byId.get('btnConfirmNo').attrs['data-i18n'], 'setupConfirmNo');
  assert.equal(byId.get('btnDontKnow').attrs['data-i18n'], 'setupHeatDontKnow');
});

test('Heizart-Karten nennen Namen und Laiensatz aus den profile*-Schlüsseln', () => {
  const slice = screenSlice('s-profile');
  for (const type of ['Radiator', 'FloorScreed', 'FloorDry', 'HeatpumpFloor', 'Storage']) {
    assert.match(slice, new RegExp('data-i18n="profile' + type + '"'));
    assert.match(slice, new RegExp('data-i18n="profileHint' + type + '"'));
  }
});
