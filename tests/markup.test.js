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

// Argumente aller Aufrufe von name(…) im Code als Text, mit Klammerzählung (auch die Definition steht dabei)
function aufrufe(code, name) {
  const out = [];
  let i = -1;
  while ((i = code.indexOf(name + '(', i + 1)) >= 0) {
    if (/[\w$.]/.test(code[i - 1] || '')) { continue; }
    let depth = 0;
    let j = i + name.length;
    for (; j < code.length; j++) {
      if (code[j] === '(') { depth++; }
      else if (code[j] === ')' && --depth === 0) { break; }
    }
    out.push(code.slice(i + name.length + 1, j));
  }
  return out;
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
  // Radiokarten: das Eingabefeld sitzt im <label>, fünf Heizarten, eine gemeinsame Gruppe. S5 (Name heatType) und
  // die Einstellungen (Name settingsHeatType, IDs rs-<Heizart>) tragen dieselben fünf Karten.
  const radios = all.filter((tg) => tg.name === 'input' && tg.attrs.type === 'radio');
  const TYPES = ['radiator', 'floorScreed', 'floorDry', 'heatpumpFloor', 'storage'];
  const s5 = radios.filter((tg) => tg.attrs.name === 'heatType');
  const einst = radios.filter((tg) => tg.attrs.name === 'settingsHeatType');
  assert.deepEqual(s5.map((tg) => tg.attrs.value), TYPES);
  assert.deepEqual(einst.map((tg) => tg.attrs.value), TYPES);
  assert.deepEqual(einst.map((tg) => tg.attrs.id), TYPES.map((x) => 'rs-' + x));
  assert.equal(radios.length, s5.length + einst.length, 'jede Radiokarte gehört zu einer der zwei Gruppen');
  for (const r of radios) {
    const before = html.slice(0, r.pos);
    assert.ok(before.lastIndexOf('<label class="choice">') > before.lastIndexOf('</label>'), r.attrs.id + ' steht nicht in seinem Label');
  }
  assert.match(html, /role="radiogroup" aria-labelledby="h-profile"/);
  assert.match(html, /role="radiogroup" aria-labelledby="h-set-heat"/);
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
  // außer Zähler und Statuszeile tragen nur die Zahlen der Stepper in den Einstellungen eine Live-Region
  // (<output aria-live="polite">, Abschnitt 7): die drei oben und die acht Schwellen in „Für Fortgeschrittene“
  const live = all.filter((tg) => tg.attrs['aria-live'] !== undefined).map((tg) => tg.attrs.id);
  assert.deepEqual(live, ['setupStep', 'status', 'comfortOut', 'leadMinOut', 'leadMaxOut',
    'threshWarnMinNOut', 'threshWarnDrop48Out', 'threshAlarmMinNOut', 'threshAlarmDrop48Out', 'threshAlarmGtRiseOut',
    'threshCritMinNOut', 'threshColdWindOut', 'threshGustLeadOut']);
  const main = tags(screenSlice('s-main')).filter((tg) => tg.attrs['aria-live'] !== undefined).map((tg) => tg.attrs.id);
  assert.deepEqual(main, ['status']);
  for (const id of ['comfortOut', 'leadMinOut', 'leadMaxOut']) {
    assert.equal(byId.get(id).name, 'output', id);
    assert.equal(byId.get(id).attrs['aria-live'], 'polite', id);
  }
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

test('app.js: innerHTML nur in setSvg und nur mit chart.icon/chart.layout, kein style-Attribut, kein eval', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(code, /outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(code, /setAttribute\(\s*['"]style|cssText|\beval\(|new Function/);
  assert.doesNotMatch(code, /localStorage/, 'Zugriffe laufen über Heizwarte.storage');
  // genau eine Stelle schreibt HTML: setSvg. API-Text (Photon, Warnungen) geht nur per textContent hinein.
  assert.equal((code.match(/innerHTML/g) || []).length, 1, 'innerHTML steht mehr als einmal im Code');
  assert.match(code, /function setSvg\(el, markup\)\s*\{\s*el\.innerHTML = markup;\s*\}/);
  const echte = aufrufe(code, 'setSvg').filter((a) => a !== 'el, markup');
  assert.ok(echte.length >= 2, 'setSvg wird für Jetzt-Symbol und Tageskarten gebraucht');
  for (const a of echte) {
    assert.match(a, /^[\w$.()']+,\s*chart\.(icon|layout)\(/, 'setSvg mit etwas anderem als chart.icon/chart.layout: ' + a);
  }
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
  const re = /'((?:err|setup|btn|hit|profile|status|store|storage|now|level|alert|day|reason|charge|plan|strength|air|chart)[A-Z]\w*)'/g;
  let m;
  while ((m = re.exec(code)) !== null) { keys.add(m[1]); }
  for (const k of ['setupSearching', 'setupSearch', 'setupByLocation', 'setupConfirmYes', 'errNeedPlace', 'errNoHit', 'errElevRange', 'hitHouse',
    'levelTitle0', 'levelText0', 'levelOf', 'levelNoData', 'chargeTonight', 'chargeHigh', 'planNow', 'planToday', 'planDay',
    'reasonNightMin', 'alertFrom', 'alertUntil', 'dayToday', 'dayColder', 'daySame', 'nowFeels', 'nowNightMin',
    'planFor', 'planTitle', 'planTitleStorage', 'planNightOf', 'planStart', 'planDue', 'planOptional', 'planDisagree', 'planGusty',
    'planNightMin', 'planLead', 'planChargeEvening', 'strengthThrough', 'strengthLow', 'profileRadiator', 'profileStorage',
    'btnMore', 'btnLess', 'airBest', 'airSlot', 'airNone', 'airNote']) {
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

// ---------------------------------------------------------------------------------------------
// Hauptbildschirm: Kopf, Jetzt, Ampel, Warnungen, Tage, Fahrplan (BAUPLAN Abschnitt 8, Blöcke 1 und 3 bis 7)
// ---------------------------------------------------------------------------------------------

test('Hauptbildschirm: Blöcke in der Reihenfolge des Plans, Screenreader-Reihenfolge = DOM-Reihenfolge', () => {
  const folge = ['placeName', 'placePick', 'reload', 'settingsBtn', 'heatHint', 'status', 'now', 'verdict', 'alerts', 'days', 'plan', 'more', 'chart', 'air'];
  const slice = screenSlice('s-main');
  let letzte = -1;
  for (const id of folge) {
    const pos = slice.indexOf('id="' + id + '"');
    assert.ok(pos > letzte, '#' + id + ' fehlt oder steht an der falschen Stelle');
    letzte = pos;
  }
  // Überschriften des Hauptbildschirms: h2 je Block, keine Stufe übersprungen (die h3 der Karten entstehen in app.js)
  const ebenen = tags(slice).filter((tg) => /^h[1-6]$/.test(tg.name));
  assert.deepEqual(ebenen.map((tg) => tg.name), ['h2', 'h2', 'h2', 'h2', 'h2', 'h2', 'h2']);
  assert.equal(ebenen[0].attrs.tabindex, '-1');
  assert.equal(byId.get('verdictTitle').name, 'h2');
});

test('Kopfzeile: Ortswahl mit sichtbarer Beschriftung, zwei Textknöpfe mit Schlüssel, kein disabled', () => {
  const label = all.find((tg) => tg.name === 'label' && tg.attrs.for === 'placeSelect');
  assert.ok(label, '<label for="placeSelect"> fehlt');
  assert.equal(label.attrs['data-i18n'], 'placeLabel');
  assert.equal(byId.get('placeSelect').name, 'select');
  assert.equal(byId.get('placePick').attrs.hidden, '', 'Ortswahl erscheint erst ab zwei Orten');
  for (const [id, key] of [['reload', 'btnReload'], ['settingsBtn', 'btnSettings']]) {
    const b = byId.get(id);
    assert.equal(b.name, 'button');
    assert.equal(b.attrs.type, 'button');
    assert.equal(b.attrs['data-i18n'], key, '#' + id + ' trägt den Schlüssel ' + key);
    assert.equal(b.attrs.disabled, undefined);
  }
  // der Hinweis zur angenommenen Heizart bleibt mit seinem Knopf erhalten
  assert.equal(byId.get('heatHint').attrs.hidden, '');
  assert.equal(byId.get('btnHeatChange').attrs['data-i18n'], 'btnChange');
});

test('Jetzt, Ampel, Warnungen, Tage: die Bausteine, die app.js füllt, stehen im Markup', () => {
  for (const id of ['nowBody', 'nowTemp', 'nowIcon', 'nowCond', 'nowFeels', 'nowWind', 'nowHumidity', 'nowNightMin',
    'verdictTitle', 'verdictAction', 'verdictText', 'verdictReasons',
    'alertLang', 'alertList', 'alertSource', 'alertUnavailable', 'dayList']) {
    assert.ok(byId.has(id), '#' + id);
  }
  // Die Ampel hat immer eine sichtbare <h2>: ohne Stufe trägt sie levelNoData bzw. errTooOld (Review Runde 2, N4)
  assert.equal(byId.get('verdictTitle').attrs.hidden, undefined, 'die Überschrift der Ampel ist nie verborgen');
  assert.ok(!byId.has('verdictNote'), 'der Grund ohne Stufe steht in der Überschrift, nicht in einer eigenen Zeile');
  const ampel = funktion(app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1'), 'renderVerdict');
  assert.match(ampel, /setLine\('verdictTitle', view \? t\('errTooOld'\) : t\('levelNoData'\)\);/);
  assert.doesNotMatch(ampel, /\['verdictTitle', 'verdictAction'/, 'die Überschrift wird ohne Stufe nicht versteckt');
  // Handlungssatz direkt nach der Stufenüberschrift, vor allem anderen (Punkt 4)
  const slice = screenSlice('s-main');
  const pos = (id) => slice.indexOf('id="' + id + '"');
  assert.ok(pos('verdictTitle') < pos('verdictAction') && pos('verdictAction') < pos('verdictText') &&
    pos('verdictText') < pos('verdictReasons'));
  assert.equal(byId.get('verdictReasons').name, 'ul', 'Begründungen sind eine Liste aus ganzen Sätzen, keine Chips');
  // vier Lampen, nur Zierde: aria-hidden am Behälter, von Stufe 3 oben bis Stufe 0 unten
  const lamp = tags(slice).find((tg) => (tg.attrs.class || '') === 'lamp');
  assert.ok(lamp);
  assert.equal(lamp.attrs['aria-hidden'], 'true');
  const lampen = slice.slice(lamp.pos, slice.indexOf('</div>', lamp.pos));
  assert.deepEqual(Array.from(lampen.matchAll(/<i class="(l\d)">/g)).map((m) => m[1]), ['l3', 'l2', 'l1', 'l0']);
  // Warnungen und Tage sind bis zum ersten Rendern verborgen; der Warnblock hat seine Überschrift mit Schlüssel
  assert.equal(byId.get('alerts').attrs.hidden, '');
  assert.equal(byId.get('days').attrs.hidden, '');
  assert.equal(byId.get('alertSource').attrs['data-i18n'], 'alertSource');
  assert.equal(byId.get('alertUnavailable').attrs['data-i18n'], 'alertUnavailable');
  assert.match(slice, /<h2 data-i18n="alertTitle">/);
  assert.match(slice, /<h2 data-i18n="daysTitle">/);
});

// ---------------------------------------------------------------------------------------------
// Heizfahrplan (BAUPLAN Abschnitt 8, Block 7)
// ---------------------------------------------------------------------------------------------

test('Fahrplan: Block steht nach den Tagen, Überschrift und Liste füllt app.js, bis dahin verborgen', () => {
  const plan = byId.get('plan');
  assert.equal(plan.name, 'section');
  assert.equal(plan.attrs.hidden, '');
  const head = byId.get('planHead');
  assert.equal(head.name, 'h2');
  assert.equal(head.attrs['data-i18n'], undefined, 'die Überschrift trägt einen Platzhalter und kommt aus app.js (planFor)');
  assert.equal(byId.get('planList').name, 'ul');
  const slice = screenSlice('s-main');
  assert.ok(slice.indexOf('id="days"') < slice.indexOf('id="plan"'), 'Fahrplan nach den drei Tagen');
  assert.ok(slice.indexOf('id="plan"') < slice.indexOf('id="planHead"') && slice.indexOf('id="planHead"') < slice.indexOf('id="planList"'));
});

test('Fahrplan: Schlüssel in de, Satzteile ohne Punkt, planDisagree ohne Richtung', () => {
  const ph = (text) => Array.from(new Set(Array.from(text.matchAll(/\{(\w+)\}/g)).map((m) => m[1]))).sort();
  assert.deepEqual(ph(de.planNightMin), ['t', 'time']);
  assert.deepEqual(ph(de.planLead), ['lead', 'onset']);
  assert.deepEqual(ph(de.planChargeEvening), ['level']);
  assert.deepEqual(ph(de.planDisagree), ['t']);
  for (const k of ['planNow', 'planToday', 'planDay']) { assert.doesNotMatch(de[k], /\.$/, k + ' ist ein Satzteil'); }
  // Die Bedingung löst in beide Richtungen aus (PlanEntry.disagree kennt keine): der Satz darf keine nennen
  assert.doesNotMatch(de.planDisagree, /kälter|wärmer|milder|höher|niedriger|tiefer|mehr|weniger/i);
  assert.match(de.planDisagree, /zweite Meinung/);
  // Aufheizzeit, nicht Vorlauf (Abschnitt 3), und kein Fahrplantext nennt Fliesen oder Fußboden
  assert.match(de.planLead, /Aufheizzeit/);
});

test('Fahrplan: app.js verdrahtet Überschrift, Stärken, MOSMIX-Regel und Ortszeit', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  // eine Überschrift je Heizart, der Nachtspeicher heißt „Aufladung“
  for (const [type, key] of [['radiator', 'profileRadiator'], ['floorScreed', 'profileFloorScreed'], ['floorDry', 'profileFloorDry'],
    ['heatpumpFloor', 'profileHeatpumpFloor'], ['storage', 'profileStorage']]) {
    assert.ok(code.includes(type + ": '" + key + "'"), 'PROFILE_KEY ' + type);
    assert.ok(has(de, key), key);
  }
  assert.match(code, /type === 'storage'\) \{ return t\('planTitleStorage'\)/);
  assert.match(code, /t\('planFor', \{ profile: t\(PROFILE_KEY\[type\]\) \}\)/);
  for (const [stufe, key] of [['through', 'strengthThrough'], ['up', 'strengthUp'], ['normal', 'strengthNormal'], ['low', 'strengthLow']]) {
    assert.ok(code.includes(stufe + ": '" + key + "'"), 'STRENGTH_KEY ' + stufe);
  }
  // MOSMIX: nur mit Station innerhalb 25 km (Meter), und nur dann der Satz
  assert.match(code, /MOS_NEAR_M = 25000;/);
  assert.match(code, /s\.distance <= MOS_NEAR_M/);
  assert.match(code, /entry\.disagree && fmt\.mosNear && isNum\(night\.mosMin\)/);
  assert.match(code, /mosNear: mosNear\(view\.m\)/, 'planFmt reicht die MOSMIX-Regel an planRows weiter');
  // Start fällig nach heat.isDue, Handlungssatz und Fahrplan lesen denselben verdict.plan
  assert.match(code, /heat\.isDue\(entry, view\.now\.ms, night\.toMs\)/);
  assert.match(code, /verdict\.plan\.forEach\(\(entry, k\) =>/);
  assert.match(code, /planRows\(view\.v, state\.place, planFmt\(view\)\)/, 'renderPlan zeichnet die Zeilen aus planRows');
  assert.match(code, /function planPick\(view\)\s*\{[^}]*view\.v\.plan\[/);
  assert.match(code, /const entry = planPick\(view\);/, 'der Handlungssatz der Ampel nimmt planPick');
  // render: Fahrplan nach den Tagen, jeder Block für sich im guard
  assert.ok(code.indexOf('guard(() => renderDays(view));') < code.indexOf('guard(() => renderPlan(view));'));
  // Zeiten nur über fmt mit der Zeitzone des Orts, nie über die Gerätezeit
  const plan = code.slice(code.indexOf('function upFirst'), code.indexOf('function render()'));
  assert.ok(plan.length > 1500, 'Fahrplan-Code nicht gefunden');
  assert.doesNotMatch(plan, /new Date|getHours|getMinutes|toLocaleTimeString|toLocaleDateString|Intl\./);
  // Startzeile und Satzteil der Ampel rechnen über zt (timeFmt): Uhrzeit, Wochentag und Kalendertag des Orts
  assert.match(plan, /zt\.time\(entry\.startMs\)/);
  assert.match(plan, /zt\.dayKey\(entry\.startMs\)/);
  assert.match(plan, /fmt\.time\(night\.atMs\)/);
  assert.match(plan, /fmt\.time\(entry\.onsetMs\)/);
  assert.match(plan, /time: \(ms\) => f\.time\(ms, tz\)/, 'planFmt rechnet jede Uhrzeit in der Ortszeit des Orts');
  assert.match(plan, /const zt = timeFmt\(view\);/, 'planFmt reicht die Zeitformatierer an nightName und planWhen');
  assert.equal(plan.includes('view.m.tz'), true);
  const zeit = funktion(code, 'timeFmt');
  assert.match(zeit, /const tz = view\.m\.tz;/);
  assert.match(zeit, /time: \(ms\) => f\.time\(ms, tz\)/);
  assert.match(zeit, /wday: \(ms\) => f\.wday\(ms, tz, i18n\.lang, true\)/);
  assert.match(zeit, /dayKey: \(ms\) => weather\.dayKeyOf\(ms, tz\)/);
  for (const name of ['whenPhrase', 'nightName', 'planWhen']) {
    assert.doesNotMatch(funktion(code, name), /i18n\.|weather\.|[^.\w]t\(|Date|Intl\./, name + ' ist rein und nimmt alles aus zt');
  }
});

test('Fahrplan: CSS-Karte je Nacht, Hinweis im Rahmen statt nur in Farbe', () => {
  assert.match(css, /\.plan\s*\{[^}]*list-style: none;/);
  assert.match(css, /\.plan-item\s*\{[^}]*background: var\(--surface\);/);
  assert.match(css, /\.plan-tag\s*\{[^}]*border: 2px solid var\(--edge\);/);
  assert.match(css, /\.plan-when\s*\{[^}]*font-size: 1\.375rem;/);
});

// ---------------------------------------------------------------------------------------------
// Mehr anzeigen: Kurve (Gerüst) und Lüften (BAUPLAN Abschnitt 8, Blöcke 8 bis 10)
// ---------------------------------------------------------------------------------------------

test('Mehr anzeigen: ein Knopf mit aria-expanded, danach Kurve und Lüften, alles zu Beginn verborgen', () => {
  const more = byId.get('more');
  assert.equal(more.name, 'button');
  assert.equal(more.attrs.type, 'button');
  assert.equal(more.attrs['aria-expanded'], 'false');
  assert.equal(more.attrs['aria-controls'], 'chart air');
  assert.equal(more.attrs['data-i18n'], 'btnMore');
  assert.equal(more.attrs.disabled, undefined, 'nie disabled');
  assert.equal(more.attrs.hidden, '', 'ohne Daten gibt es nichts aufzuklappen');
  for (const id of ['chart', 'air']) {
    assert.equal(byId.get(id).name, 'section', id);
    assert.equal(byId.get(id).attrs.hidden, '', id + ' ist zu Beginn verborgen');
  }
  const slice = screenSlice('s-main');
  assert.ok(slice.indexOf('id="plan"') < slice.indexOf('id="more"'), 'Knopf nach dem Fahrplan');
  assert.ok(slice.indexOf('id="more"') < slice.indexOf('id="chart"'), 'Kurve nach dem Knopf');
  assert.ok(slice.indexOf('id="chart"') < slice.indexOf('id="air"'), 'Lüften nach der Kurve');
});

test('Mehr anzeigen: die Kurve ist ein Gerüst mit Überschrift, Legende, Bild mit Rolle und Zusammenfassung', () => {
  const slice = screenSlice('s-main');
  const chart = slice.slice(slice.indexOf('id="chart"'), slice.indexOf('id="air"'));
  const inner = tags(chart);
  const h2 = inner.find((tg) => tg.name === 'h2');
  assert.ok(h2 && h2.attrs['data-i18n'] === 'chartTitle', 'Überschrift chartTitle');
  assert.equal(byId.get('chartLegend').name, 'div');
  const svg = byId.get('chartSvg');
  assert.equal(svg.name, 'svg');
  assert.equal(svg.attrs.role, 'img');
  assert.equal(byId.get('chartSummary').name, 'p');
  assert.ok(chart.indexOf('id="chartLegend"') < chart.indexOf('id="chartSvg"') && chart.indexOf('id="chartSvg"') < chart.indexOf('id="chartSummary"'));
  // Gezeichnet wird zur Laufzeit (nächster Schritt): im Markup bleibt das Bild leer
  assert.match(chart, /<svg[^>]*><\/svg>/);
});

test('Mehr anzeigen: Lüften hat Überschrift, Beschriftung, Liste, „kein Fenster“ und den Erklärsatz; kein aria-live', () => {
  const slice = screenSlice('s-main');
  const air = slice.slice(slice.indexOf('id="air"'));
  const inner = tags(air);
  assert.deepEqual(inner.filter((tg) => tg.name === 'h2').map((tg) => tg.attrs['data-i18n']), ['airTitle']);
  assert.ok(inner.some((tg) => tg.attrs['data-i18n'] === 'airLabel'), 'airLabel');
  assert.equal(byId.get('airList').name, 'ul');
  assert.equal(byId.get('airNone').attrs.hidden, '');
  assert.equal(byId.get('airNote').name, 'p');
  assert.ok(air.indexOf('id="airList"') < air.indexOf('id="airNone"') && air.indexOf('id="airNone"') < air.indexOf('id="airNote"'));
  assert.ok(inner.every((tg) => tg.attrs['aria-live'] === undefined), 'nur die Statuszeile ist aria-live');
});

test('Mehr anzeigen: app.js verdrahtet Klick, hw:more, Beschriftung und Fokus; Lüften wird nur bei offenem Block gerechnet', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  assert.match(code, /on\('more', 'click', onMore\);/);
  const onMore = code.slice(code.indexOf('function onMore()'));
  const body = onMore.slice(0, onMore.indexOf('\n  }\n'));
  assert.match(body, /state\.more = !state\.more;/);
  assert.match(body, /persist\('more', true\)/);
  assert.match(body, /forget\('more'\)/);
  assert.match(body, /\$\('more'\)\.focus\(\)/, 'der Fokus bleibt auf dem Knopf');
  assert.match(code, /state\.more = storage\.get\('more', false\) === true;/);
  assert.match(code, /t\(state\.more \? 'btnLess' : 'btnMore'\)/);
  assert.match(code, /setAttribute\('aria-expanded', expanded\)/);
  // airRows wird nur von renderAir gerufen, und renderAir nur in renderMore und nur im Zweig „offen“
  assert.equal((code.match(/airRows\(/g) || []).length, 2, 'Definition und ein Aufruf');
  assert.equal((code.match(/renderAir\(/g) || []).length, 2, 'Definition und ein Aufruf, im guard von renderMore');
  assert.match(code, /if \(open\) \{\s*guard\(\(\) => renderAir\(view\)\);\s*\} else \{\s*\$\('air'\)\.hidden = true;/);
  // render() zeichnet den Knopf mit; Sprachwechsel läuft über render() (onLanguage)
  assert.match(code, /guard\(\(\) => renderMore\(view\)\);/);
});

test('Mehr anzeigen: Schlüssel in de, CSS mit 56-px-Knopf über die ganze Breite und Rahmen für das beste Fenster', () => {
  for (const k of ['btnMore', 'btnLess', 'chartTitle', 'airTitle', 'airLabel', 'airNone', 'airNote', 'airBest', 'airSlot']) {
    assert.ok(has(de, k), k + ' fehlt in de');
  }
  assert.match(css, /\.more-btn\s*\{[^}]*width: 100%;[^}]*min-height: 56px;/);
  assert.match(css, /\.air-tag\s*\{[^}]*border: 2px solid var\(--edge\);/);
  assert.match(css, /\.air-list\s*\{[^}]*list-style: none;/);
});

test('Einstellungen: der Weg zurück ist da, kein Bildschirm ohne Ausgang', () => {
  const back = byId.get('btnSettingsBack');
  assert.equal(back.attrs['data-i18n'], 'btnBack');
  assert.ok(html.indexOf('id="btnSettingsBack"') < html.indexOf('data-i18n="settingsTitle"'), 'Zurück steht über der Überschrift');
});

test('Einrichtung: Kopf ist <h1>, Zähler, <h2>; „Zurück“ steht unten über dem Hauptknopf, nie vor der <h2>', () => {
  // in keinem Bildschirm der Einrichtung steht ein Knopf vor der Überschrift (Abschnitt 6: Kopf h1 → setupStep → h2)
  for (const id of ['s-welcome', 's-address', 's-hits', 's-confirm', 's-profile']) {
    const folge = tags(screenSlice(id)).filter((tg) => tg.name === 'h2' || tg.name === 'button');
    assert.equal(folge[0].name, 'h2', id + ': erst die Überschrift, dann die Knöpfe');
  }
  // S2: Zurück direkt über dem Hauptknopf „Suchen“, unter der Fehlerzeile und ihren Auswegen
  const s2 = screenSlice('s-address');
  assert.match(s2, /id="act-address"[\s\S]*<\/div>\s*<button type="button" class="back" id="btnAddrBack" data-i18n="btnBack"><\/button>\s*<div class="actions">\s*<button type="submit" class="primary" id="btnSearch"/);
  // S3 hat keinen Hauptknopf: Zurück steht unter der Liste, neben „Keine passt?“ (Reihenfolge der Tabelle in Abschnitt 6)
  const s3 = screenSlice('s-hits');
  const pos3 = (needle) => s3.indexOf(needle);
  assert.ok(pos3('<h2') < pos3('id="hitList"') && pos3('id="hitList"') < pos3('id="btnNoneFits"') &&
    pos3('id="btnNoneFits"') < pos3('id="btnHitsBack"'), 'S3: h2, Liste, Keine passt?, Zurück');
  assert.equal(byId.get('btnHitsBack').attrs['data-i18n'], 'btnBack');
});

test('Einrichtung: die Standortsuche sperrt nichts (Abbruch über „Mit Adresse“, eigene Frist, sichtbare Laufanzeige)', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  // „Mit Adresse“ (und „Weiter“ aus der Fehlerzeile) bricht eine laufende Standortsuche ab, statt still zu verpuffen
  const byAddress = funktion(code, 'onByAddress');
  assert.match(byAddress, /if \(!s\) \{ return; \}\s*if \(s\.busy\) \{ cancelOps\(\); \}/);
  assert.doesNotMatch(byAddress, /s\.busy\) \{ return; \}/);
  assert.match(code, /on\('btnWelcomeNext', 'click', onByAddress\);/);
  // eine eigene Frist über die ganze Standortabfrage, auch über die Zeit bis zur Erlaubnis; danach errGeoFailed
  assert.match(code, /const LOCATE_DEADLINE_MS = 30000;/);
  const frist = funktion(code, 'locateWithDeadline');
  assert.match(frist, /new geo\.GeoError\('timeout'/);
  assert.match(frist, /Promise\.race\(\[geo\.locate\(navigator\.geolocation\), deadline\]\)/);
  assert.match(frist, /clearTimeout\(timer\)/);
  const byLocation = funktion(code, 'onByLocation');
  assert.match(byLocation, /await locateWithDeadline\(\)/);
  assert.doesNotMatch(byLocation, /geo\.locate\(/, 'nie ohne Frist');
  assert.match(funktion(code, 'onLocationFailure'), /code !== 'timeout'/, 'die Frist endet in errGeoFailed, nicht in der Konsole');
  // auf S2 sitzt die Laufanzeige auf dem sichtbaren Hauptknopf, nicht auf dem versteckten Ausweg
  assert.match(byLocation, /\$\(where === 'address' \? 'btnSearch' : 'btnByLocation'\)/);
  assert.match(byLocation, /markBusy\(btn, false, idleKey\)/);
  assert.match(funktion(code, 'resetBusyUi'), /markBusy\(\$\('btnSearch'\), false, 'setupSearch'\)/);
});

test('app.js: Umriss ohne feste Einheit, Heizart behält eigene Aufheizzeiten', () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  // die Einheit steht im Schlüssel (setupExtent in m, setupExtentKm in km), nie als Literal im Code
  assert.doesNotMatch(code, /'\s*k?m'/, 'feste Einheit „ m“/„ km“ in app.js');
  assert.match(funktion(code, 'extentLine'), /fmt\.t\('setupExtentKm'/);
  assert.match(funktion(code, 'extentLine'), /fmt\.t\('setupExtent'/);
  assert.match(de.setupExtent, / m$/);
  assert.match(de.setupExtentKm, / km$/);
  // Wechsel der Heizart setzt die Aufheizzeiten der Tabelle; dieselbe Heizart lässt eigene stehen (Abschnitt 7)
  assert.match(funktion(code, 'applyHeatType'), /if \(type !== place\.heat\.type\) \{[^}]*leadMin = p\.leadMin;[^}]*\}\s*place\.heat\.confirmed = confirmed;/);
});

test('CSS: Wettersymbol-Variablen, Ampelfarbe in --lv, Tage ab 720 px dreispaltig', () => {
  for (const v of ['--ic-sun', '--ic-moon', '--ic-cloud', '--ic-cloud-dark', '--ic-fog', '--ic-rain', '--ic-snow', '--ic-bolt']) {
    assert.match(css, new RegExp(v + ':\\s*oklch\\('), v + ' fehlt in :root');
  }
  assert.match(css, /clamp\(3rem, 14vw, 5rem\)/, 'große Temperatur: clamp(3rem, 14vw, 5rem)');
  // Ohne Stufe fehlt --lv: dann bleibt die Ampel neutral (--line), nie grün getönt, als wäre alles ruhig
  assert.match(css, /\.verdict\s*\{[^}]*border-left: 6px solid var\(--lv, var\(--line\)\);[^}]*background: color-mix\(in oklch, var\(--lv, var\(--line\)\) 9%, var\(--bg\)\);/);
  assert.doesNotMatch(css, /var\(--lv, var\(--ok\)\)/);
  assert.match(css, /@media \(min-width: 720px\)\s*\{\s*\.days\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test('Stufen- und Aufladungs-Schlüssel, die app.js aus Zeichenkette und Zahl baut, stehen in de', () => {
  for (let n = 0; n <= 3; n++) {
    for (const k of ['level', 'levelTitle', 'levelText']) { assert.ok(has(de, k + n), k + n); }
  }
  assert.match(de.levelTitle1, /\{when\}/);
  assert.match(de.levelText1, /\{onset\}.*\{lead\}/);
  for (const k of ['chargeHigh', 'chargeUp', 'chargeNormal', 'chargeLow', 'chargeTonight']) { assert.ok(has(de, k), k); }
  // app.js führt die vier Stufen als feste Schlüsseltabellen, nie als zusammengesetzten Text
  for (const reihe of ['level', 'levelTitle', 'levelText']) {
    const liste = [0, 1, 2, 3].map((n) => "'" + reihe + n + "'").join(', ');
    assert.ok(app.includes('[' + liste + ']'), 'Tabelle für ' + reihe + ' fehlt in app.js');
  }
  // app.js verdrahtet die vier Aufladungsstufen von PlanEntry.charge
  for (const [stufe, key] of [['high', 'chargeHigh'], ['up', 'chargeUp'], ['normal', 'chargeNormal'], ['low', 'chargeLow']]) {
    assert.ok(app.includes(stufe + ": '" + key + "'"), 'CHARGE_KEY ' + stufe);
  }
  for (const k of ['nightMin', 'drop48', 'coldWindy', 'frost', 'gtRise', 'alert', 'calmNights', 'noJumps']) {
    assert.ok(app.includes("case '" + k + "'"), 'reasonText kennt ' + k);
  }
});

// ---------------------------------------------------------------------------------------------
// Statuszeile, Neu laden, Fehlerwege (BAUPLAN Abschnitt 8, Block 1 und 2; Abschnitt 5 app)
// ---------------------------------------------------------------------------------------------

// Der Quelltext einer Funktion von „function name(“ bis zur nächsten Funktion auf Einrückungsstufe 2
function funktion(code, name) {
  const start = code.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function ' + name + ' fehlt in app.js');
  const rest = code.slice(start + 1);
  const next = rest.search(/\n  (?:async )?function \w+\(/);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

const appCode = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

test('Statuszeile: ein leeres <p> mit aria-live direkt nach dem Kopf, gefüllt wird sie nur mit Textknoten', () => {
  const st = byId.get('status');
  assert.equal(st.name, 'p');
  assert.equal(st.attrs['aria-live'], 'polite');
  assert.equal(st.attrs.hidden, undefined, 'eine verborgene Live-Region liest ihren ersten Inhalt nicht vor');
  assert.match(html, /<p id="status" aria-live="polite"><\/p>/, 'leer im Markup, app.js schreibt hinein');
  const kopf = funktion(appCode, 'renderStatus');
  assert.doesNotMatch(kopf, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(kopf, /make\('span', l\.cls, l\.text\)/, 'jeder Satz ein <span> mit textContent');
  // die Zeile wird nur neu geschrieben, wenn sich ein Satz ändert (die Live-Region liest sonst jedes render() vor)
  assert.match(kopf, /if \(sig === statusSig\) \{ return; \}/);
});

test('Statuszeile: render, refresh und onWait ziehen sie nach; sie hängt am Zustand und nicht an einer Zahl', () => {
  const render = funktion(appCode, 'render');
  assert.ok(render.indexOf('state.verdict = ') < render.indexOf('guard(renderStatus);'), 'tooOld liest state.verdict');
  assert.ok(render.indexOf('guard(renderStatus);') < render.indexOf('guard(() => renderNow(view));'), 'Stempel steht vor dem Jetzt-Block');
  assert.match(funktion(appCode, 'onWait'), /state\.status = 'waiting';[\s\S]*guard\(renderStatus\);/);
  const refresh = funktion(appCode, 'refresh');
  assert.match(refresh, /state\.status = 'loading';\s*const job = fetchFor\(id\);\s*inflight\.set\(id, job\);\s*renderReload\(\);\s*guard\(renderStatus\);/);
  assert.match(refresh, /if \(state\.status === null\) \{\s*state\.status = 'loading';\s*guard\(renderStatus\);/,
    'zurück an einen Ort mit laufendem Abruf: „Wird aktualisiert“ statt einer Zeile ohne Zustand');
  // die Formatierer: Stand in der Ortszeit, Grenze aus heat.THRESH, kein Date in der Statuszeile
  const fmt = funktion(appCode, 'statusFmt');
  assert.match(fmt, /staleHours: heat\.THRESH\.staleHours/);
  assert.match(fmt, /f\.when\(ms, nowMs, tz, i18n\.lang\)/);
  assert.match(fmt, /state\.model \? state\.model\.tz/);
  assert.doesNotMatch(funktion(appCode, 'statusLines'), /new Date|Date\.now|Intl\.|getHours|toLocale/);
  assert.match(funktion(appCode, 'renderStatus'), /tooOld: !!state\.verdict && state\.verdict\.level === null/);
});

test('Fehlerwege: jeder Abrufcode landet im Zustand der Tabelle, der alte Stand bleibt sichtbar', () => {
  const fail = funktion(appCode, 'onFetchFailed');
  assert.match(fail, /if \(id !== state\.activeId\) \{ return; \}/, 'ein nicht mehr aktiver Ort ändert die Anzeige nicht');
  assert.match(fail, /if \(!state\.cache\) \{\s*state\.status = 'noCache';/);
  assert.match(fail, /code === 'rate'\) \{\s*state\.status = 'rateLimited';/);
  assert.match(fail, /code === 'offline' \|\| code === 'timeout'\) \{\s*state\.status = 'offline';/);
  assert.match(fail, /\} else \{\s*state\.status = 'failed';/, 'http und invalid');
  // der Cache wird beim Fehler nicht angefasst: weder geleert noch durch null ersetzt
  assert.doesNotMatch(fail, /state\.cache = |state\.model = |loadCache\(\)/);
  // nie stummes catch: erwartete Ausfälle als Warnung, alles andere als Fehler in der Konsole
  assert.match(fail, /console\.warn\(/);
  assert.match(fail, /console\.error\(failure\)/);
  assert.doesNotMatch(appCode, /catch \([a-z]+\) \{\s*\}/, 'kein leeres catch');
  // die Codes gibt es in weather.js wirklich
  const weatherSrc = fs.readFileSync(path.join(ROOT, 'js', 'weather.js'), 'utf8');
  for (const code of ['rate', 'invalid', 'http', 'offline', 'timeout']) {
    assert.ok(weatherSrc.includes("'" + code + "'"), 'OpenMeteoError ' + code);
  }
  // render zeichnet nach dem Fehler aus dem vorhandenen Cache: Ampel und Fahrplan bleiben, nur die Zeile ändert sich
  assert.match(fail, /render\(\);\s*\}\s*$/);
});

test('Neu laden: Knopf mit aria-disabled statt disabled, Klick hängt sich an den laufenden Abruf, Fokus bleibt', () => {
  const reload = byId.get('reload');
  assert.equal(reload.name, 'button');
  assert.equal(reload.attrs['data-i18n'], 'btnReload');
  assert.equal(reload.attrs.disabled, undefined);
  assert.ok(has(de, 'btnReloading'));
  // während des Abrufs trägt er btnReloading und aria-disabled; dasselbe Element, kein Austausch, also bleibt der Fokus
  assert.match(funktion(appCode, 'renderReload'), /markBusy\(btn, state\.loading, state\.loading \? 'btnReloading' : 'btnReload'\)/);
  const busy = funktion(appCode, 'markBusy');
  assert.match(busy, /setAttribute\('aria-disabled', 'true'\)/);
  assert.match(busy, /btn\.textContent = t\(labelKey\)/);
  assert.doesNotMatch(busy, /replaceWith|replaceChildren|remove\(\)|\.blur\(|disabled = /);
  assert.doesNotMatch(appCode, /setAttribute\('disabled'|\.disabled = /, 'nirgends ein echtes disabled');
  // „Neu laden“ ruft immer ab (force) und nimmt einen laufenden Abruf mit
  assert.match(appCode, /on\('reload', 'click', \(\) => \{ refresh\(true\); \}\)/);
  assert.match(funktion(appCode, 'refresh'), /if \(inflight\.has\(id\)\) \{[\s\S]*return inflight\.get\(id\);/);
  assert.match(css, /button\[aria-disabled="true"\]\s*\{/);
});

test('Abruf: beim Start und bei jeder Rückkehr in die App, mit dem 60-Sekunden-Flatterschutz', () => {
  assert.match(appCode, /document\.addEventListener\('visibilitychange', onVisible\);/);
  const visible = funktion(appCode, 'onVisible');
  assert.match(visible, /document\.visibilityState === 'visible' && state\.place\) \{ refresh\(false\); \}/);
  assert.match(appCode, /THROTTLE_MS = 60000;/);
  assert.match(funktion(appCode, 'refresh'), /!force && Date\.now\(\) - state\.lastFetchMs < THROTTLE_MS/);
  assert.match(funktion(appCode, 'init'), /showMain\(\);\s*refresh\(false\);/, 'Start: erst der Cache, dann der frische Abruf');
});

test('Speicherhinweise am Kopf: drei versteckte Zeilen mit Schlüssel, nach jedem Schreiben nachgezogen', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  for (const [id, key] of [['noteBlocked', 'storageBlocked'], ['noteFull', 'storageFull'], ['noteNewer', 'storeNewer']]) {
    const tg = byId.get(id);
    assert.equal(tg.name, 'p');
    assert.equal(tg.attrs['data-i18n'], key);
    assert.equal(tg.attrs.hidden, '', id + ' ist ohne Anlass verborgen');
    assert.ok(header.includes('id="' + id + '"'), id + ' steht im Seitenkopf, über allen Bildschirmen');
    assert.ok(has(de, key));
  }
  // ganze Sätze ohne Platzhalter: der Satz trägt die Bedeutung, der Rahmen nur die Auffälligkeit
  assert.doesNotMatch(de.storageBlocked + de.storageFull + de.storeNewer, /\{/);
  const notes = funktion(appCode, 'updateNotes');
  assert.match(notes, /\$\('noteBlocked'\)\.hidden = degraded !== 'blocked';/);
  assert.match(notes, /\$\('noteFull'\)\.hidden = degraded !== 'full';/);
  assert.match(notes, /\$\('noteNewer'\)\.hidden = !state\.newer;/);
  // jedes Schreiben geht durch persist(), und das zieht den Hinweis nach (ein Speicher, der erst jetzt voll wird)
  assert.match(funktion(appCode, 'persist'), /const ok = storage\.set\(key, value\);\s*updateNotes\(\);\s*return ok;/);
  assert.equal((appCode.match(/storage\.set\(/g) || []).length, 1, 'storage.set steht nur in persist');
  // neuere Fassung: nichts wird geschrieben
  assert.match(funktion(appCode, 'persist'), /if \(state\.newer\) \{ return false; \}/);
});

test('Statuszeile: CSS trägt „⚠ Veraltet“ in der Warnfarbe, Symbol und Wort bleiben der eigentliche Träger', () => {
  assert.match(css, /#status\s*\{\s*color: var\(--muted\);\s*\}/);
  assert.match(css, /#status \.status-warn\s*\{\s*color: var\(--warn\);\s*\}/);
  // die drei Klassen, die statusLines vergibt
  for (const cls of ['status-stamp', 'status-info', 'status-warn']) {
    assert.ok(appCode.includes("'" + cls + "'"), cls + ' fehlt in app.js');
  }
  // jeder Satz der Gruppe, der „veraltet“ meldet, beginnt mit dem Symbol (nie die Farbe allein)
  for (const k of ['statusStale', 'statusOffline', 'statusRateLimited', 'errLoadFailed']) {
    assert.match(de[k], /^⚠ Veraltet – /, k);
  }
});

// ---------------------------------------------------------------------------------------------
// Fußzeile (BAUPLAN Abschnitt 8): zehn Absätze, drei davon ganz als Link mit verstecktem „öffnet fremde Seite“
// ---------------------------------------------------------------------------------------------

const FOOTER_KEYS = ['footerWeather', 'footerDwd', 'footerAmpel', 'footerVdi', 'footerElev', 'footerGeo', 'footerFont', 'footerCode', 'footerPrivacy', 'footerOffline'];
const FOOTER_LINKS = {
  footerWeather: 'https://open-meteo.com/',
  footerElev: 'https://doi.org/10.5270/ESA-c5d3d65',
  footerCode: 'https://github.com/Dennismit2n/heizwarte'
};

function footerSlice() {
  const start = html.indexOf('<footer');
  const end = html.indexOf('</footer>');
  assert.ok(start >= 0 && end > start, '<footer> fehlt');
  return html.slice(start, end);
}

test('Fußzeile: genau ein footer hinter main, nicht versteckt, zehn Absätze in der Reihenfolge des Plans', () => {
  assert.equal(all.filter((tg) => tg.name === 'footer').length, 1);
  assert.ok(html.indexOf('</main>') < html.indexOf('<footer'), 'footer steht hinter main');
  assert.equal(all.find((tg) => tg.name === 'footer').attrs.hidden, undefined, 'die Fußzeile ist nie versteckt');
  const slice = footerSlice();
  const absaetze = tags(slice).filter((tg) => tg.name === 'p');
  assert.equal(absaetze.length, 10);
  // Schlüssel in Reihenfolge: bei Zeilen ohne Link am p, bei Zeilen mit Link am ersten span im a
  const schluessel = Array.from(slice.matchAll(/data-i18n="(footer[A-Za-z]+)"/g)).map((m) => m[1]).filter((k) => k !== 'footerExternal');
  assert.deepEqual(schluessel, FOOTER_KEYS);
  for (const k of FOOTER_KEYS.concat('footerExternal')) { assert.ok(has(de, k), k + ' fehlt in de'); }
});

test('Fußzeile: die drei Link-Zeilen sind wörtlich das Markup des Plans (Satz im a, versteckter Span im a, kein data-i18n am p)', () => {
  const slice = footerSlice();
  const zeilen = slice.match(/<p>[\s\S]*?<\/p>/g) || [];
  assert.equal(zeilen.length, 3, 'drei p ohne data-i18n tragen einen Link');
  assert.equal((slice.match(/<a\b/g) || []).length, 3, 'genau drei Links in der Fußzeile');
  const erwartet = Object.keys(FOOTER_LINKS).map((k) =>
    '<p><a class="footer-link" href="' + FOOTER_LINKS[k] + '" target="_blank" rel="noopener noreferrer">' +
    '<span data-i18n="' + k + '"></span> <span class="visually-hidden" data-i18n="footerExternal"></span></a></p>');
  assert.deepEqual(zeilen, erwartet);
  // ein a in einem p mit data-i18n wäre nach dem ersten apply() weg
  for (const tg of tags(slice).filter((x) => x.name === 'p' && x.attrs['data-i18n'] !== undefined)) {
    const ab = slice.slice(tg.pos);
    assert.ok(!/^<p\b[^>]*>\s*<a\b/.test(ab), 'a unter data-i18n-Absatz');
  }
  for (const tg of tags(slice).filter((x) => x.name === 'a')) {
    assert.equal(tg.attrs.target, '_blank');
    assert.equal(tg.attrs.rel, 'noopener noreferrer');
    assert.equal(tg.attrs['aria-label'], undefined, 'aria-label überschriebe den sichtbaren Satz');
  }
});

test('Fußzeile: CSS macht den Link zum Inline-Block mit Tippfläche, blendet den Zusatz nur optisch aus und unterstreicht den Link', () => {
  assert.match(css, /a\.footer-link\s*\{\s*display: inline-block;\s*\}/);
  assert.match(css, /\.visually-hidden\s*\{[^}]*position: absolute;[^}]*width: 1px;[^}]*height: 1px;[^}]*margin: -1px;[^}]*overflow: hidden;[^}]*clip-path: inset\(50%\);[^}]*white-space: nowrap;/);
  assert.match(css, /footer a\.footer-link\s*\{[^}]*text-decoration: underline;/, 'Link nie nur durch Farbe kenntlich');
});

test('Fußzeile: die Texte nennen Quelle und Lizenz, die Datenschutzzeile trägt die Klammer mit dem gerundeten Standort', () => {
  assert.match(de.footerWeather, /Open-Meteo\.com \(CC BY 4\.0\)/);
  assert.match(de.footerElev, /Copernicus-Programms/);
  assert.match(de.footerCode, /\(MIT\), © 2026 Dennismit2n/);
  assert.match(de.footerPrivacy, /\(oder einmal dein auf etwa 100 m gerundeter Standort\)/);
  assert.equal(de.footerExternal, 'öffnet fremde Seite');
});

test('Service Worker: Registrierung in init() nur über https oder localhost, Fehler landen in der Konsole', () => {
  const reg = funktion(appCode, 'registerWorker');
  assert.ok(reg.includes("'serviceWorker' in navigator"));
  assert.ok(reg.includes("location.protocol !== 'https:' && location.hostname !== 'localhost'"));
  assert.ok(reg.includes("navigator.serviceWorker.register('./sw.js').catch(console.error)"));
  assert.ok(!reg.includes('/claude/'), 'kein Sonderfall wie in der Bürg-Fassung');
  assert.ok(funktion(appCode, 'init').includes('registerWorker();'), 'init() ruft die Registrierung');
});

test('Manifest und Kopf: Manifest-Link, theme-color, Manifest-id /heizwarte/ ab Meilenstein 2', () => {
  const link = all.find((tg) => tg.name === 'link' && tg.attrs.rel === 'manifest');
  assert.equal(link.attrs.href, './manifest.webmanifest');
  // ab M3 zwei Metas mit media (BAUPLAN Abschnitt 8, boot.js): bis M2 war es eine ohne media
  const themes = all.filter((tg) => tg.name === 'meta' && tg.attrs.name === 'theme-color');
  assert.deepEqual(themes.map((tg) => [tg.attrs.media, tg.attrs.content]), [
    ['(prefers-color-scheme: dark)', '#111821'],
    ['(prefers-color-scheme: light)', '#F3F3F6']
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, '/heizwarte/', 'ab Meilenstein 2 trägt das Manifest id /heizwarte/ (BAUPLAN Abschnitt 9)');
  assert.equal(manifest.theme_color, '#111821');
  assert.equal(manifest.background_color, '#111821');
});

// ---------------------------------------------------------------------------------------------
// Einstellungen (BAUPLAN Abschnitt 7 und 8): Ortsliste, Heizart, Stepper, Höhe
// ---------------------------------------------------------------------------------------------

test('Einstellungen: Reihenfolge der Blöcke, h3 unter der h2, Zurück oben und unten', () => {
  const slice = screenSlice('s-settings');
  const folge = ['btnSettingsBack', 'data-i18n="settingsTitle"', 'id="h-set-places"', 'id="settingsPlaceList"', 'id="h-set-heat"',
    'id="rs-radiator"', 'id="stepComfort"', 'id="stepLeadMin"', 'id="stepLeadMax"', 'id="h-set-elev"', 'id="settingsElevInput"', 'id="settingsAdvanced"', 'id="stepThreshWarnMinN"', 'id="stepThreshGustLead"',
    'id="btnThreshReset"', 'id="themeSelect"', 'id="btnSettingsBack2"'];
  let letzte = -1;
  for (const f of folge) {
    const pos = slice.indexOf(f);
    assert.ok(pos > letzte, f + ' fehlt oder steht an der falschen Stelle');
    letzte = pos;
  }
  const ebenen = tags(slice).filter((tg) => /^h[1-6]$/.test(tg.name));
  assert.deepEqual(ebenen.map((tg) => tg.name), ['h2', 'h3', 'h3', 'h3'], 'eine h2, darunter die Blöcke als h3');
  assert.equal(ebenen[0].attrs.tabindex, '-1');
  assert.deepEqual(ebenen.map((tg) => tg.attrs['data-i18n']), ['settingsTitle', 'settingsPlaces', 'settingsHeat', 'settingsElev']);
  for (const id of ['btnSettingsBack', 'btnSettingsBack2']) {
    assert.equal(byId.get(id).attrs['data-i18n'], 'btnBack', id);
    assert.equal(byId.get(id).attrs.class, 'back', id);
  }
});

test('Einstellungen: drei Stepper mit Knopf „−“, Zahl in <output aria-live="polite">, Knopf „+“ und Beschriftung', () => {
  const felder = { comfort: 'settingsComfort', leadMin: 'settingsLeadMin', leadMax: 'settingsLeadMax' };
  for (const [feld, schluessel] of Object.entries(felder)) {
    const F = feld[0].toUpperCase() + feld.slice(1);
    const label = byId.get('lbl' + F);
    assert.equal(label.attrs['data-i18n'], schluessel);
    const gruppe = all.find((tg) => tg.attrs.role === 'group' && tg.attrs['aria-labelledby'] === 'lbl' + F);
    assert.ok(gruppe, 'Stepper ' + feld + ' ist eine Gruppe mit der Beschriftung');
    for (const id of [feld + 'Down', feld + 'Up']) {
      const b = byId.get(id);
      assert.equal(b.name, 'button', id);
      assert.equal(b.attrs.type, 'button', id);
      assert.match(b.attrs.class, /\bstep-btn\b/, id);
      assert.equal(b.attrs['data-i18n'], undefined, id + ': der Name kommt als aria-label aus stepDown/stepUp, nicht als Text');
    }
    // das Zeichen auf dem Knopf ist Zierde (aria-hidden), der Name steckt im aria-label, das app.js setzt
    assert.match(html, new RegExp('id="' + feld + 'Down"><span aria-hidden="true">−</span></button>'));
    assert.match(html, new RegExp('id="' + feld + 'Up"><span aria-hidden="true">\\+</span></button>'));
    const out = byId.get(feld + 'Out');
    assert.equal(out.name, 'output');
    assert.equal(out.attrs['aria-live'], 'polite');
    assert.equal(out.attrs.for, feld + 'Down ' + feld + 'Up');
    // Reihenfolge im Markup: Beschriftung, −, Zahl, +
    assert.ok(html.indexOf('id="lbl' + F + '"') < html.indexOf('id="' + feld + 'Down"') &&
      html.indexOf('id="' + feld + 'Down"') < html.indexOf('id="' + feld + 'Out"') &&
      html.indexOf('id="' + feld + 'Out"') < html.indexOf('id="' + feld + 'Up"'), feld);
  }
  // beide Aufheizzeiten sitzen in einem Kasten, den app.js bei der Heizart Nachtspeicher verbirgt
  assert.ok(byId.has('stepLeadMin') && byId.has('stepLeadMax'));
  const code = funktion(appCode, 'renderSteppers');
  assert.ok(code.includes("place.heat.type === 'storage'"));
  assert.ok(code.includes("$('stepLeadMin').hidden = noLead;") && code.includes("$('stepLeadMax').hidden = noLead;"));
  assert.ok(code.includes("t('stepDown', { what })") && code.includes("t('stepUp', { what })"), 'aria-label aus stepDown/stepUp');
  assert.ok(code.includes('t(spec.unit, { n: numAuto(value) })'), 'Zahl mit Einheit über den Schlüssel');
  assert.ok(code.includes('setAriaDisabled'), 'am Rand aria-disabled, nie disabled');
  assert.doesNotMatch(code, /\.disabled\b/);
});

test('Einstellungen: „Für Fortgeschrittene“ ist ein zugeklapptes <details> mit Hinweis, acht Steppern und „Auf Faustregel zurücksetzen“', () => {
  const felder = ['WarnMinN', 'WarnDrop48', 'AlarmMinN', 'AlarmDrop48', 'AlarmGtRise', 'CritMinN', 'ColdWind', 'GustLead'];
  const det = byId.get('settingsAdvanced');
  assert.equal(det.name, 'details');
  assert.equal(det.attrs.open, undefined, 'zugeklappt');
  assert.equal(det.attrs.class, 'advanced');
  const slice = screenSlice('s-settings');
  const von = slice.indexOf('id="settingsAdvanced"');
  const bis = slice.indexOf('</details>');
  assert.ok(von > 0 && bis > von, 'das <details> schließt im Einstellungsbildschirm');
  const innen = tags(slice.slice(von, bis));
  const summary = innen.find((tg) => tg.name === 'summary');
  assert.ok(summary, 'ohne <summary> gäbe es nichts zum Aufklappen');
  assert.equal(summary.attrs['data-i18n'], 'settingsAdvanced');
  assert.ok(slice.indexOf('<summary', von) < slice.indexOf('data-i18n="settingsThresholdsHint"'), 'die Zusammenfassung steht zuerst');
  assert.ok(innen.some((tg) => tg.name === 'p' && tg.attrs['data-i18n'] === 'settingsThresholdsHint' && /\bhint\b/.test(tg.attrs.class)));
  assert.equal(innen.filter((tg) => /^h[1-6]$/.test(tg.name)).length, 0, 'keine Überschrift: die Zusammenfassung ist die Beschriftung');
  // acht Stepper wie die drei oberen: Beschriftung, −, Zahl in <output aria-live="polite">, +; Reihenfolge wie in THRESH_STEPPERS
  assert.equal(innen.filter((tg) => tg.attrs.role === 'group').length, 8);
  let letzte = von;
  for (const F of felder) {
    const k = 'thresh' + F;
    const K = 'Thresh' + F;
    const label = byId.get('lbl' + K);
    assert.equal(label.attrs['data-i18n'], k);
    assert.ok(has(de, k), k + ' fehlt in de');
    const gruppe = all.find((tg) => tg.attrs.role === 'group' && tg.attrs['aria-labelledby'] === 'lbl' + K);
    assert.ok(gruppe, 'Stepper ' + k + ' ist eine Gruppe mit der Beschriftung');
    for (const id of [k + 'Down', k + 'Up']) {
      const b = byId.get(id);
      assert.equal(b.name, 'button', id);
      assert.equal(b.attrs.type, 'button', id);
      assert.match(b.attrs.class, /\bstep-btn\b/, id);
      assert.equal(b.attrs['data-i18n'], undefined, id);
    }
    assert.match(html, new RegExp('id="' + k + 'Down"><span aria-hidden="true">−</span></button>'));
    assert.match(html, new RegExp('id="' + k + 'Up"><span aria-hidden="true">\\+</span></button>'));
    const out = byId.get(k + 'Out');
    assert.equal(out.name, 'output');
    assert.equal(out.attrs['aria-live'], 'polite');
    assert.equal(out.attrs.for, k + 'Down ' + k + 'Up');
    const pos = slice.indexOf('id="step' + K + '"');
    assert.ok(pos > letzte, k + ' steht an der falschen Stelle');
    letzte = pos;
    assert.ok(html.indexOf('id="lbl' + K + '"') < html.indexOf('id="' + k + 'Down"') &&
      html.indexOf('id="' + k + 'Down"') < html.indexOf('id="' + k + 'Out"') &&
      html.indexOf('id="' + k + 'Out"') < html.indexOf('id="' + k + 'Up"'), k);
  }
  const reset = byId.get('btnThreshReset');
  assert.equal(reset.name, 'button');
  assert.equal(reset.attrs.type, 'button');
  assert.equal(reset.attrs['data-i18n'], 'settingsReset');
  assert.equal(reset.attrs.disabled, undefined);
  assert.ok(slice.indexOf('id="btnThreshReset"') > letzte && slice.indexOf('id="btnThreshReset"') < bis, 'Zurücksetzen steht nach den acht Steppern, im <details>');
  // das <details> kommt nach der Höhe und vor dem unteren „Zurück“
  assert.ok(von > slice.indexOf('id="settingsElevInput"') && von < slice.indexOf('id="btnSettingsBack2"'));
  // alle Einheiten der acht Stepper gibt es in de
  for (const k of ['unitCelsius', 'unitKmh', 'unitDegrees']) { assert.ok(has(de, k), k); }
  assert.match(de.unitKmh, /^\{n\} km\/h$/);
  // Veränderungen (Tagesmittel, Heizbedarf) im Laienwort „Grad“, kein Fachwort „Kd“ am Stepper
  assert.match(de.unitDegrees, /^\{n\} Grad$/);
  assert.ok(!has(de, 'unitKd'), 'unitKd ist durch unitDegrees ersetzt');
  // die Knöpfe nennen jede Schwelle mit ihrem Hauptwort (threshName…), nicht mit dem Satzanfang der Beschriftung
  for (const f of felder) { assert.ok(has(de, 'threshName' + f), 'threshName' + f); }
});

test('Einstellungen: die Schwellen-Stepper schreiben nur ihr Feld in place.heat.thresh, „Zurücksetzen“ setzt null, beide rechnen entprellt neu', () => {
  assert.match(appCode, /const THRESH_FIELDS = \['warnMinN', 'warnDrop48', 'alarmMinN', 'alarmDrop48', 'alarmGtRise', 'critMinN', 'coldWind', 'gustLead'\];/);
  const schritt = funktion(appCode, 'onThreshStep');
  assert.ok(schritt.includes('applyThreshStep(place.heat.thresh, heat.DEFAULT_THRESH, field, dir)'), 'der Schritt kennt nur sein Feld und die Standardwerte');
  assert.ok(schritt.includes('place.heat.thresh = next;'));
  assert.ok(schritt.includes("persist('places', state.places)"), 'jede Änderung wird gespeichert');
  assert.ok(schritt.includes('renderThresh();') && schritt.includes('scheduleRecalc();'));
  const zurueck = funktion(appCode, 'onThreshReset');
  assert.ok(zurueck.includes('place.heat.thresh = null;'), 'Faustregel heißt thresh = null');
  assert.ok(zurueck.includes("persist('places', state.places)") && zurueck.includes('scheduleRecalc();'));
  const zeichnen = funktion(appCode, 'renderThresh');
  assert.ok(zeichnen.includes('heat.thresholds(place)'), 'angezeigt wird der Mischwert aus eigenem und Standardwert');
  assert.ok(zeichnen.includes("t('stepDown', { what })") && zeichnen.includes("t('stepUp', { what })"), 'aria-label aus stepDown/stepUp');
  assert.ok(zeichnen.includes('const what = t(spec.name);'), 'aria-label der Schwellen aus dem Hauptwort, nicht aus dem Satzanfang');
  assert.ok(zeichnen.includes('t(spec.unit, { n: numAuto(value) })'), 'Zahl mit Einheit über den Schlüssel');
  assert.ok(zeichnen.includes('setAriaDisabled'), 'am Rand aria-disabled, nie disabled');
  assert.doesNotMatch(zeichnen, /\.disabled\b|innerHTML/);
  assert.ok(zeichnen.includes('if (out.textContent !== text)'), 'unveränderte Zahlen werden nicht neu geschrieben (Live-Region)');
  assert.ok(funktion(appCode, 'renderSettingsActive').includes('renderThresh();'), 'beim Öffnen und beim Sprachwechsel');
  assert.match(appCode, /on\(id \+ 'Down', 'click', \(\) => onThreshStep\(field, -1\)\);/);
  assert.match(appCode, /on\(id \+ 'Up', 'click', \(\) => onThreshStep\(field, 1\)\);/);
  assert.match(appCode, /on\('btnThreshReset', 'click', onThreshReset\);/);
  // das Markup kennt jede ID, die aus den Tabellen entsteht
  for (const f of Object.keys(Heizwarte.heat.DEFAULT_THRESH)) {
    const k = 'thresh' + f[0].toUpperCase() + f.slice(1);
    for (const id of [k + 'Down', k + 'Up', k + 'Out']) { assert.ok(byId.has(id), '#' + id); }
  }
});

test('Einstellungen: CSS für das <details> „Für Fortgeschrittene“ ohne Animation, die Zusammenfassung bleibt eine 48-px-Fläche', () => {
  assert.match(css, /\.advanced\s*\{[^}]*background: var\(--surface\);[^}]*border: 1px solid var\(--line\);/);
  assert.match(css, /\.advanced summary\s*\{[^}]*font-weight: 700;[^}]*cursor: pointer;/);
  assert.match(css, /\.advanced-body\s*\{[^}]*display: flex;[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /summary[^{]*\{[^}]*(?:list-style|display:\s*flex)|::marker|::-webkit-details-marker/, 'das eingebaute Dreieck bleibt: es zeigt auf/zu');
});

test('Einstellungen: Heizart-Karten bleiben die von S5, die Wahl setzt confirmed und rechnet entprellt neu', () => {
  const slice = screenSlice('s-settings');
  for (const type of ['Radiator', 'FloorScreed', 'FloorDry', 'HeatpumpFloor', 'Storage']) {
    assert.match(slice, new RegExp('data-i18n="profile' + type + '"'));
    assert.match(slice, new RegExp('data-i18n="profileHint' + type + '"'));
  }
  assert.match(slice, /data-i18n="profileRule"/, 'Faustregel unter den Karten');
  const wahl = funktion(appCode, 'onSettingsHeat');
  assert.ok(wahl.includes('applyHeatType(place, type, true)'), 'der Wechsel setzt confirmed true');
  assert.ok(wahl.includes('persist(\'places\', state.places)'));
  assert.ok(wahl.includes('scheduleRecalc();'));
  assert.ok(appCode.includes("document.querySelectorAll('input[name=\"settingsHeatType\"]')"));
});

test('Einstellungen: Stepper und Heizart rechnen nur Ampel und Fahrplan neu, 150 ms entprellt', () => {
  assert.match(appCode, /const RECALC_MS = 150;/);
  const neu = funktion(appCode, 'recalcVerdict');
  assert.ok(neu.includes('renderVerdict(view)') && neu.includes('renderPlan(view)'));
  assert.doesNotMatch(neu, /\brender\(\)|renderNow|renderDays|renderAlerts|renderHead|renderStatus/, 'nur Ampel und Fahrplan');
  const plan = funktion(appCode, 'scheduleRecalc');
  assert.ok(plan.includes('cancelRecalc();') && plan.includes('setTimeout(recalcVerdict, RECALC_MS)'));
  const schritt = funktion(appCode, 'onStep');
  assert.ok(schritt.includes('applyStep(before, field, dir)') && schritt.includes('scheduleRecalc();'));
  assert.ok(schritt.includes("persist('places', state.places)"), 'jede Änderung wird gespeichert');
  // die Handler hängen an allen sechs Knöpfen
  assert.match(appCode, /on\(field \+ 'Down', 'click', \(\) => onStep\(field, -1\)\);/);
  assert.match(appCode, /on\(field \+ 'Up', 'click', \(\) => onStep\(field, 1\)\);/);
  assert.match(appCode, /const STEP_FIELDS = \['comfort', 'leadMin', 'leadMax'\];/);
});

test('Einstellungen: Höhe mit Anzeige, Ändern-Knopf und Feld nach den Regeln von S4, gespeichert beim change', () => {
  const f = byId.get('settingsElevInput').attrs;
  assert.equal(f.type, 'number');
  assert.equal(f.inputmode, 'numeric');
  assert.equal(f.min, '-500');
  assert.equal(f.max, '9000');
  assert.equal(f.step, '1');
  const label = all.find((tg) => tg.name === 'label' && tg.attrs.for === 'settingsElevInput');
  assert.equal(label.attrs['data-i18n'], 'setupElevLabel');
  assert.equal(byId.get('settingsElevHint').attrs['data-i18n'], 'setupElevHint');
  assert.equal(byId.get('settingsElevAuto').attrs['data-i18n'], 'setupElevAuto');
  assert.equal(byId.get('settingsElevAuto').attrs.hidden, '');
  const knopf = byId.get('btnSettingsElev');
  assert.equal(knopf.attrs['data-i18n'], 'btnChange');
  assert.equal(knopf.attrs['aria-expanded'], 'false');
  assert.equal(knopf.attrs['aria-controls'], 'settingsElevEdit');
  assert.equal(byId.get('settingsElevEdit').attrs.hidden, '', 'das Feld ist erst nach „Ändern“ da');
  const err = byId.get('settingsElevErr');
  assert.equal(err.attrs.role, 'alert');
  assert.match(html, /id="settingsElevErr"[^>]*><\/div>/, 'die Fehlerzeile ist leer');

  const code = funktion(appCode, 'onElevCommit');
  assert.ok(code.includes('parseElev(input.value,'), 'dieselbe Regel wie S4');
  assert.ok(code.includes('geo.elevation(place.lat, place.lon)'), 'leer fragt mit den gerundeten Koordinaten des Orts neu');
  assert.ok(code.includes('elevPatch(parsed, auto)'));
  assert.ok(code.includes("persist('places', state.places)"));
  assert.ok(code.includes('refresh(true)'), 'danach sofort neu abrufen: die Höhe steckt in der Forecast-URL');
  assert.ok(code.includes("t('errElevRange')"), 'ungültig nennt den Satz aus S4');
  assert.match(appCode, /on\('settingsElevInput', 'change', onElevCommit\);/);
  assert.match(appCode, /on\('btnSettingsElev', 'click', \(\) => openSettingsElev\(\$\('settingsElevEdit'\)\.hidden\)\);/);
  // Anzeige: setupElev, setupElevAuto nur solange automatisch, setupElevUnknown ohne Höhe
  const anzeige = funktion(appCode, 'renderSettingsElev');
  assert.ok(anzeige.includes("t('setupElev', {") && anzeige.includes("t('setupElevUnknown')"));
  assert.ok(anzeige.includes('known && place.elevAuto'));
});

test('Einstellungen: Löschen mit Rückfrage als zweiter Knopf, ohne confirm(); der letzte Ort führt zu S1', () => {
  assert.doesNotMatch(appCode, /\bconfirm\s*\(|\balert\s*\(|\bprompt\s*\(/, 'keine Browser-Dialoge');
  const item = funktion(appCode, 'placeItem');
  assert.ok(item.includes("t('btnDelete')") && item.includes("t('btnCancel')"));
  assert.ok(item.includes("t('settingsDeleteLast', { name: p.label })") && item.includes("t('settingsDeleteConfirm', { name: p.label })"));
  assert.ok(item.includes("t('settingsPlaceActive')") && item.includes("t('setupLabel')"));
  assert.ok(item.includes("delBtn.setAttribute('aria-expanded'") && item.includes("delBtn.setAttribute('aria-controls', box.id)"));
  assert.ok(item.includes('input.maxLength = LABEL_MAX') && item.includes("input.type = 'text'") && item.includes('label.htmlFor = nameId'),
    'Name als Textfeld mit sichtbarer Beschriftung, höchstens 40 Zeichen');
  assert.ok(item.includes("radio.type = 'radio'") && item.includes("radio.name = 'settingsPlace'"));
  assert.ok(item.includes("e.key === 'Escape'"), 'Escape schließt die Rückfrage');
  assert.ok(item.includes('box.hidden = true;'), 'die Rückfrage ist erst nach dem Druck auf „Löschen“ da');
  const weg = funktion(appCode, 'deletePlace');
  assert.ok(weg.includes('afterDelete(state.places, id, state.activeId)'));
  assert.ok(weg.includes("forget('cache:' + id)"), 'der Cache des Orts geht mit');
  assert.ok(weg.includes('state.places.length === 0') && weg.includes('showSetup();'), 'der letzte Ort: Einrichtung bei S1');
  assert.ok(weg.includes('activatePlace(next.activeId)'), 'wer nachrückt, wird wie beim Umschalten aktiv');
  assert.ok(weg.includes('.focus()'), 'der Fokus fällt nie auf body');
  // der Name ändert sich beim change und bleibt in der Rückfrage aktuell
  assert.ok(item.includes("input.addEventListener('change'") && item.includes('yes.textContent = question()'));
});

test('Einstellungen: Öffnen setzt den Fokus auf die h2, beide Zurück führen auf #settingsBtn', () => {
  assert.match(appCode, /on\('btnSettingsBack', 'click', onSettingsBack\);/);
  assert.match(appCode, /on\('btnSettingsBack2', 'click', onSettingsBack\);/);
  const zurueck = funktion(appCode, 'onSettingsBack');
  assert.ok(zurueck.includes('showMain();') && zurueck.includes("$('settingsBtn').focus();"));
  const auf = funktion(appCode, 'onSettingsOpen');
  assert.ok(auf.includes("showScreen('s-settings')"), 'showScreen setzt den Fokus auf die erste h2 des Bildschirms');
  assert.ok(auf.includes('renderSettings();'));
  // die Texte der Liste ziehen beim Sprachwechsel nach
  assert.match(funktion(appCode, 'onLanguage'), /if \(state\.screen === 's-settings'\) \{ renderSettings\(\); \}/);
});

test('Einstellungen: „Ort hinzufügen“ bleibt aktiv, errMaxPlaces steht als Alert-Zeile direkt darüber', () => {
  const knopf = byId.get('btnAddPlace');
  assert.ok(knopf, '#btnAddPlace');
  assert.equal(knopf.name, 'button');
  assert.equal(knopf.attrs['data-i18n'], 'btnAddPlace');
  assert.equal(knopf.attrs.disabled, undefined, 'kein deaktivierter Knopf ohne Satz (Abschnitt 6)');
  assert.equal(knopf.attrs['aria-disabled'], undefined);
  const zeile = byId.get('settingsPlacesErr');
  assert.ok(zeile, '#settingsPlacesErr');
  assert.equal(zeile.name, 'div');
  assert.equal(zeile.attrs.role, 'alert');
  assert.equal(zeile.attrs.tabindex, '-1');
  assert.match(html, /id="settingsPlacesErr"[^>]*><\/div>/, 'leer im Markup, app.js schreibt hinein');
  // Reihenfolge im Block „Orte“: Liste mit „Löschen“, Alert-Zeile, „Ort hinzufügen“
  const liste = html.indexOf('id="settingsPlaceList"');
  assert.ok(liste >= 0 && liste < html.indexOf('id="settingsPlacesErr"'), 'die Ortsliste steht über der Alert-Zeile');
  assert.ok(html.indexOf('id="settingsPlacesErr"') < html.indexOf('id="btnAddPlace"'), 'die Alert-Zeile steht direkt über dem Knopf');
  assert.ok(screenSlice('s-settings').includes('id="btnAddPlace"'), 'der Knopf gehört in die Einstellungen');
  assert.match(appCode, /on\('btnAddPlace', 'click', onAddPlace\);/);
});

test('Einstellungen: Ort hinzufügen beginnt den Nachtrag bei S2, bei fünf Orten zeigt ein Druck errMaxPlaces und der Fokus geht darauf', () => {
  const add = funktion(appCode, 'onAddPlace');
  assert.ok(add.includes('canAddPlace(state.places)'), 'die Regel steckt in der reinen Funktion');
  assert.ok(add.includes('showSetup({ add: true })'), 'Nachtrag: Einrichtung ab S2');
  assert.ok(add.includes("$('settingsPlacesErr').focus()"), 'der Fokus geht auf den Fehlertext');
  const fehler = funktion(appCode, 'renderPlacesError');
  assert.ok(fehler.includes("t('errMaxPlaces')") && fehler.includes('replaceChildren()'), 'der Satz wird erst im Moment des Drucks gesetzt');
  // beim Neuzeichnen der Einstellungen (Öffnen, Löschen, Sprachwechsel) zieht die Zeile nach
  assert.ok(funktion(appCode, 'renderSettings').includes('renderPlacesError'));
  // der Nachtrag zählt wie die Adresse („Schritt 1 von 4“) und „Zurück“ auf S2 führt in die Einstellungen
  assert.match(funktion(appCode, 'onAddrBack'), /if \(s\.add\) \{\s*state\.setup = null;\s*showScreen\('s-settings'\);/);
  assert.ok(funktion(appCode, 'stepFor').includes('STEP_OF[s.way]'), 'der Zähler hängt am Weg, nicht am Nachtrag');
  // der neue Ort wird bei „Ja“ in S4 aktiv; das Maximum gilt auch dort
  const ja = funktion(appCode, 'onConfirmYes');
  assert.ok(ja.includes('canAddPlace(state.places)') && ja.includes('appendPlace(state.places, place)'));
  assert.ok(ja.includes("persist('active', place.id)") && ja.includes('state.activeId = place.id'));
  assert.doesNotMatch(appCode, /state\.places\.push\(/, 'die Liste wächst nur über appendPlace');
});

test('Ortswechsel: Umschalter und Radio gehen beide über activatePlace (hw:active, Cache zeigen, refresh(true))', () => {
  const wechsel = funktion(appCode, 'activatePlace');
  assert.ok(wechsel.includes("persist('active', id)") && wechsel.includes('loadCache()') && wechsel.includes('refresh(true)'));
  // die Wartezeit nach dem ersten 429 gilt je Ort weiter; ein offenes Höhenfeld des alten Orts geht zu
  assert.ok(wechsel.indexOf('resumeWait(id)') > wechsel.indexOf('state.status = null;') && wechsel.indexOf('resumeWait(id)') < wechsel.indexOf('render();'));
  assert.ok(wechsel.includes('openSettingsElev(false)'));
  assert.ok(funktion(appCode, 'onWait').indexOf('waitingUntil.set(id') < funktion(appCode, 'onWait').indexOf('if (id !== state.activeId)'),
    'die Wartezeit wird auch für einen nicht aktiven Ort gemerkt');
  assert.ok(funktion(appCode, 'onPlaceChange').includes('activatePlace(id)'));
  assert.ok(funktion(appCode, 'onPlacePick').includes('activatePlace(id)'));
  assert.match(appCode, /on\('placeSelect', 'change', onPlaceChange\);/);
  // späte Antwort eines anderen Orts: der Cache wird geschrieben, gerendert wird nur der aktive Ort
  const fertig = funktion(appCode, 'onFetched');
  assert.ok(fertig.includes("persist('cache:' + id, result.cache)"));
  assert.ok(fertig.includes('if (id === state.activeId) {') && fertig.includes('refresh(false)'));
  assert.ok(funktion(appCode, 'onFetchFailed').includes('if (id !== state.activeId) { return; }'));
  assert.ok(funktion(appCode, 'onWait').includes('if (id !== state.activeId) { return; }'));
});

test('Einstellungen: jede ID der Stepper steht im Markup, alle Schlüssel der Stepper in de', () => {
  for (const feld of ['comfort', 'leadMin', 'leadMax']) {
    for (const id of [feld + 'Down', feld + 'Up', feld + 'Out']) { assert.ok(byId.has(id), '#' + id); }
  }
  for (const k of ['unitHours', 'unitCelsius', 'stepDown', 'stepUp', 'settingsDeleteConfirm', 'settingsDeleteLast', 'btnCancel',
    'settingsPlaceActive', 'settingsPlaces', 'settingsHeat', 'settingsElev', 'errElevRange']) {
    assert.ok(has(de, k), k + ' fehlt in de');
  }
  assert.match(de.unitHours, /^\{n\} h$/);
  assert.match(de.unitCelsius, /^\{n\} °C$/);
});

test('Einstellungen: CSS mit 48-px-Knöpfen am Stepper, Zahl in der Mitte, Löschen mit eigenem Rand', () => {
  assert.match(css, /\.step-btn\s*\{[^}]*min-width: 48px;[^}]*min-height: 48px;/);
  assert.match(css, /\.stepper\s*\{[^}]*display: flex;[^}]*align-items: center;/);
  assert.match(css, /\.stepper output\s*\{[^}]*text-align: center;/);
  assert.match(css, /\.step-btn\[aria-disabled="true"\]\s*\{[^}]*cursor: default;/);
  assert.match(css, /button\.danger\s*\{[^}]*border-color: var\(--crit\);/);
  assert.match(css, /\.place-item\s*\{[^}]*background: var\(--surface\);/);
});
