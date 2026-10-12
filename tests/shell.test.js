/*
 * Heizwarte — Tests für die App-Hülle (BAUPLAN Abschnitt 12, shell.test.js).
 *
 * index.html, manifest.webmanifest, css/style.css und sw.js müssen zusammenpassen. Gehen sie
 * auseinander, merkt es niemand: eine Datei in SHELL, die es nicht gibt, lässt addAll() und damit
 * die ganze Installation des Service Workers scheitern; eine Datei, die die Seite lädt, aber SHELL
 * nicht nennt, fehlt beim Start ohne Netz. Die Regeln, jeweils in beide Richtungen:
 *
 *   (1) Jede lokale src/href aus index.html steht zeichengleich, mit ?v=, in SHELL.
 *   (2) Jedes icons[].src aus dem Manifest und jedes url(…) aus css/style.css steht nach der Auflösung
 *       relativ zur Quelldatei, mit ./ davor, in SHELL (Manifest icon-512.png → ./icon-512.png,
 *       CSS ../assets/fonts/… → ./assets/fonts/…). data:, http(s): und #… zählen nicht.
 *   (3) Jeder SHELL-Eintrag stammt aus (1) oder (2); feste Ausnahmen nur ./ und ./index.html.
 *   (4) Jeder SHELL-Eintrag existiert ohne ?v= als Datei im Repo (./ ist index.html), in genau dieser
 *       Schreibweise (GitHub Pages unterscheidet Groß und Klein, NTFS nicht).
 *   (5) Alle ?v= sind gleich, CACHE heißt heizwarte-v<n>, das Manifest hat start_url ./, scope ./ und
 *       display standalone, ORDER in tests/_load.js entspricht der Skriptreihenfolge in index.html.
 *
 * Dazu die Seite selbst: Viewport wörtlich (Zoom bleibt erlaubt), keine style-Attribute und kein
 * Inline-Skript wegen der CSP.
 *
 * Stufen-Schalter für die Manifest-id (BAUPLAN Abschnitt 9): Meilenstein 1 deployt das Manifest OHNE
 * id (Spec-Standard, gleiche Identität wie die Bürg-App), Meilenstein 2 setzt "id": "/heizwarte/".
 * Der Commit „Setze die Manifest-id auf /heizwarte/“ stellt STUFE auf 'M2'; danach bleibt es dort.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

const STUFE = 'M1';
const ID_JE_STUFE = { M1: undefined, M2: '/heizwarte/' };
if (!Object.prototype.hasOwnProperty.call(ID_JE_STUFE, STUFE)) {
  throw new Error('[tests/shell] unbekannte STUFE ' + STUFE);
}

// Feste Ausnahmen von Regel 3: die Startseite unter zwei Namen. Kein Tag nennt sie, sie ist die Hülle selbst.
const AUSNAHMEN = ['./', './index.html'];

// ---------------------------------------------------------------------------------------------
// Dateien lesen
// ---------------------------------------------------------------------------------------------

function lies(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// CACHE und SHELL aus sw.js, ohne den Worker zu starten: das Skript läuft in einer leeren Hülle, in der
// nur die Listener-Anmeldung am Ende von sw.js etwas findet. Auf der Datei selbst lesen heißt, dass auch
// eine zusammengesetzte Liste (zum Beispiel mit einem Stempel in einer Konstante) richtig ankommt.
function leseSw() {
  const hülle = {
    self: { addEventListener() {}, location: { origin: 'https://example.invalid' }, clients: {}, skipWaiting() {} },
    caches: {},
    fetch() {},
    URL,
    console
  };
  const kontext = vm.createContext(hülle);
  const aus = vm.runInContext(lies('sw.js') + '\n;({ CACHE, SHELL });', kontext, { filename: 'sw.js', timeout: 2000 });
  // in die eigene Realm kopieren, sonst vergleicht assert.deepEqual Arrays aus fremden Prototypen
  return { CACHE: String(aus.CACHE), SHELL: Array.from(aus.SHELL) };
}

// Alle öffnenden Tags: { name, attrs }. Attribute ohne Wert zählen als ''. Kommentare werden übersprungen.
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
    out.push({ name: m[1].toLowerCase(), attrs });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pfade: was zählt als lokal, wie löst man auf
// ---------------------------------------------------------------------------------------------

// Lokal ist, was die App aus ihrem eigenen Ordner lädt. data:, http(s):, mailto:, blob: (jedes Schema),
// protokollrelative Adressen (//host) und #Sprungmarken zählen nicht.
function istLokal(wert) {
  if (typeof wert !== 'string' || wert.trim() === '') { return false; }
  if (wert.startsWith('#') || wert.startsWith('//')) { return false; }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(wert)) { return false; }
  return true;
}

// Eine Adresse aus einer Quelldatei im Ordner `ordner` (relativ zur Wurzel, ohne Schrägstrich am Ende,
// '' für die Wurzel) in die Form der SHELL-Einträge bringen: ./pfad, Query und #… bleiben dran.
function aufloesen(wert, ordner) {
  const m = /^([^?#]*)([\s\S]*)$/.exec(wert);
  const pfad = m[1];
  const anhang = m[2];
  if (pfad.startsWith('/')) {
    throw new Error('absoluter Pfad ' + wert + ': die App liegt unter /heizwarte/, nur relative Pfade sind erlaubt');
  }
  const norm = path.posix.normalize(path.posix.join(ordner, pfad));
  if (norm === '..' || norm.startsWith('../')) {
    throw new Error('Pfad ' + wert + ' führt aus dem Repo hinaus');
  }
  if (norm === '.' || norm === './') { return './' + anhang; }
  return './' + norm + anhang;
}

function ohneAnhang(eintrag) {
  return eintrag.replace(/[?#][\s\S]*$/, '');
}

function stempelVon(wert) {
  const m = /[?&]v=([^&#]*)/.exec(wert);
  return m ? m[1] : null;
}

// Die Datei hinter einem SHELL-Eintrag: ohne ?v=, ./ ist die Startseite. Ein Eintrag ohne ./ am Anfang
// oder einer, der aus dem Repo hinausführt, hat keine.
function dateiVon(eintrag) {
  let p = ohneAnhang(String(eintrag));
  if (p === './') { p = './index.html'; }
  if (!p.startsWith('./')) { return null; }
  const voll = path.join(ROOT, p);
  const rel = path.relative(ROOT, voll);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
  return voll;
}

// Die Datei gibt es genau in dieser Schreibweise. Windows (NTFS) und damit fs.existsSync und der Dev-Server finden
// ./INDEX.html auch als index.html, GitHub Pages nicht: dort wäre der Eintrag ein 404 und addAll scheiterte. Darum
// muss jeder Pfadteil wörtlich im Verzeichnis darüber stehen.
function existiert(eintrag) {
  const datei = dateiVon(eintrag);
  if (datei === null) { return false; }
  let ordner = ROOT;
  for (const teil of path.relative(ROOT, datei).split(path.sep)) {
    let namen;
    try { namen = fs.readdirSync(ordner); } catch (e) { return false; }
    if (!namen.includes(teil)) { return false; }
    ordner = path.join(ordner, teil);
  }
  return fs.statSync(ordner).isFile();
}

// ---------------------------------------------------------------------------------------------
// Die Prüfregeln als reine Funktionen: sie geben eine Liste der Verstöße zurück, leer heißt in Ordnung.
// So lassen sich beide Richtungen auch an absichtlich kaputten Eingaben vorführen (siehe unten).
// ---------------------------------------------------------------------------------------------

// Richtung Quelle → SHELL (Regeln 1 und 2): jede genannte Adresse muss zeichengleich in SHELL stehen
function fehltInShell(adressen, shell, woher) {
  return Array.from(new Set(adressen))
    .filter((a) => !shell.includes(a))
    .map((a) => woher + ' nennt ' + a + ', in SHELL fehlt es');
}

// Richtung SHELL → Quelle (Regel 3): jeder Eintrag ist genannt oder eine der festen Ausnahmen
function ohneQuelle(genannt, shell) {
  return shell
    .filter((e) => !AUSNAHMEN.includes(e) && !genannt.includes(e))
    .map((e) => 'SHELL nennt ' + e + ', aber weder index.html noch Manifest noch CSS laden es');
}

// Richtung SHELL → Dateisystem (Regel 4)
function ohneDatei(shell, gibtEs) {
  return shell
    .filter((e) => !gibtEs(e))
    .map((e) => 'SHELL nennt ' + e + ', die Datei ' + ohneAnhang(String(e)) + ' gibt es nicht');
}

// ---------------------------------------------------------------------------------------------
// Die echten Quellen einmal einlesen
// ---------------------------------------------------------------------------------------------

const html = lies('index.html');
const manifest = JSON.parse(lies('manifest.webmanifest'));
const css = lies('css/style.css');
const { CACHE, SHELL } = leseSw();

const alleTags = tags(html);

// Jede lokale src/href aus index.html: { tag, rel, wert }, wert genau wie geschrieben
const htmlRefs = [];
for (const tg of alleTags) {
  for (const attr of ['src', 'href']) {
    if (istLokal(tg.attrs[attr])) {
      htmlRefs.push({ tag: tg.name, rel: String(tg.attrs.rel || '').toLowerCase(), wert: tg.attrs[attr] });
    }
  }
}
const htmlAdressen = htmlRefs.map((r) => r.wert);

const manifestAdressen = (Array.isArray(manifest.icons) ? manifest.icons : [])
  .map((i) => i && i.src)
  .filter(istLokal)
  .map((s) => aufloesen(s, ''));

// Kommentare raus, dann jedes url(…) in der Schreibweise mit oder ohne Anführungszeichen
const cssOhneKommentare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const cssAdressen = [];
{
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/g;
  let m;
  while ((m = re.exec(cssOhneKommentare)) !== null) {
    const wert = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    if (istLokal(wert)) { cssAdressen.push(aufloesen(wert, 'css')); }
  }
}

// Eigener Code: Stylesheets und Skripte, sie tragen den ?v=-Stempel. Alles andere (Manifest, Icons) nicht.
function istCode(r) {
  return r.tag === 'script' || (r.tag === 'link' && /(^|\s)stylesheet(\s|$)/.test(r.rel));
}

// ---------------------------------------------------------------------------------------------
// Auflösung wie im Plan
// ---------------------------------------------------------------------------------------------

test('Auflösung: Manifest icon-512.png → ./icon-512.png, CSS ../assets/fonts/… → ./assets/fonts/…', () => {
  assert.equal(aufloesen('icon-512.png', ''), './icon-512.png');
  assert.equal(aufloesen('./icon-512.png', ''), './icon-512.png');
  assert.equal(aufloesen('../assets/fonts/a.woff2', 'css'), './assets/fonts/a.woff2');
  assert.equal(aufloesen('../assets/fonts/a.woff2?x=1', 'css'), './assets/fonts/a.woff2?x=1');
  assert.equal(aufloesen('bild.png', 'css'), './css/bild.png');
  assert.equal(aufloesen('./', ''), './');
  assert.throws(() => aufloesen('/icon.png', ''), /absoluter Pfad/);
  assert.throws(() => aufloesen('../../x.png', 'css'), /hinaus/);
});

test('Auflösung: data:, http(s):, mailto:, #… und //host zählen nicht als lokal, alles andere schon', () => {
  for (const nicht of ['data:image/png;base64,AAAA', 'https://example.org/a.css', 'http://example.org/', 'mailto:a@b.de', '#main', '//cdn.example.org/a.js', '', '   ', undefined, null]) {
    assert.equal(istLokal(nicht), false, String(nicht));
  }
  for (const doch of ['./css/style.css?v=1', 'icon-192.png', '../assets/x.woff2', './']) {
    assert.equal(istLokal(doch), true, doch);
  }
});

test('Die Quellen liefern wirklich etwas, damit keine Regel leer durchläuft', () => {
  assert.ok(htmlRefs.filter((r) => r.tag === 'script').length >= 8, 'weniger als acht Skripte in index.html gefunden');
  assert.ok(htmlRefs.some((r) => r.tag === 'link' && /stylesheet/.test(r.rel)), 'kein Stylesheet in index.html gefunden');
  assert.ok(htmlRefs.some((r) => r.tag === 'link' && r.rel === 'manifest'), 'kein Manifest-Link in index.html gefunden');
  assert.ok(manifestAdressen.length >= 3, 'weniger als drei Manifest-Icons gefunden');
  assert.ok(cssAdressen.length >= 4, 'weniger als vier url() in css/style.css gefunden');
  assert.ok(Array.isArray(SHELL) && SHELL.length > 0, 'SHELL ist leer');
});

// ---------------------------------------------------------------------------------------------
// Regel 1 bis 4: SHELL gegen die drei Quellen und das Dateisystem
// ---------------------------------------------------------------------------------------------

test('Regel 1: jede lokale src/href aus index.html steht zeichengleich, mit ?v=, in SHELL', () => {
  assert.deepEqual(fehltInShell(htmlAdressen, SHELL, 'index.html'), []);
});

test('Regel 2: jedes icons[].src aus dem Manifest steht aufgelöst, mit ./ davor, in SHELL', () => {
  assert.deepEqual(fehltInShell(manifestAdressen, SHELL, 'manifest.webmanifest'), []);
});

test('Regel 2: jedes url(…) aus css/style.css steht aufgelöst relativ zur CSS-Datei, mit ./ davor, in SHELL', () => {
  assert.deepEqual(fehltInShell(cssAdressen, SHELL, 'css/style.css'), []);
});

test('Regel 3: jeder SHELL-Eintrag stammt aus index.html, Manifest oder CSS (Ausnahmen nur ./ und ./index.html)', () => {
  assert.deepEqual(AUSNAHMEN, ['./', './index.html']);
  assert.deepEqual(ohneQuelle(htmlAdressen.concat(manifestAdressen, cssAdressen), SHELL), []);
});

test('Regel 4: jeder SHELL-Eintrag existiert ohne ?v= als Datei im Repo (./ ist index.html)', () => {
  assert.deepEqual(ohneDatei(SHELL, existiert), []);
});

test('SHELL ist eine Liste von Texten mit ./ davor, ohne Doppelte, ohne Fragment', () => {
  assert.ok(SHELL.every((e) => typeof e === 'string'), 'ein Eintrag ist kein Text');
  assert.deepEqual(SHELL.filter((e) => !e.startsWith('./')), [], 'Eintrag ohne ./ am Anfang');
  assert.deepEqual(SHELL.filter((e, i) => SHELL.indexOf(e) !== i), [], 'doppelter Eintrag');
  assert.deepEqual(SHELL.filter((e) => e.includes('#')), [], 'Eintrag mit #');
  assert.ok(SHELL.includes('./') && SHELL.includes('./index.html'), 'die Startseite fehlt unter ./ oder ./index.html');
});

test('beide Richtungen schlagen an: fehlender, überzähliger und nicht vorhandener Eintrag werden gefunden', () => {
  // Quelle → SHELL: anderer Stempel gilt als fehlend (zeichengleich), ebenso ein ganz fehlender Pfad
  assert.equal(fehltInShell(['./js/a.js?v=2026-10-12'], ['./js/a.js?v=2026-10-11'], 'index.html').length, 1);
  assert.equal(fehltInShell(['./js/a.js?v=1', './b.png', './b.png'], ['./js/a.js?v=1'], 'index.html').length, 1);
  assert.deepEqual(fehltInShell(['./js/a.js?v=1'], ['./js/a.js?v=1'], 'index.html'), []);
  // SHELL → Quelle: ein Eintrag, den niemand nennt; die Ausnahmen bleiben frei
  assert.equal(ohneQuelle(['./a.js'], ['./', './index.html', './a.js', './zuviel.js']).length, 1);
  assert.deepEqual(ohneQuelle([], ['./', './index.html']), []);
  assert.equal(ohneQuelle(['./a.js?v=2'], ['./a.js?v=1']).length, 1);
  // SHELL → Datei: ohne ?v= suchen, ./ ist index.html, ein Pfad aus dem Repo hinaus gibt es nie
  assert.equal(existiert('./'), true);
  assert.equal(existiert('./index.html'), true);
  assert.equal(existiert('./css/style.css?v=2026-10-12'), true);
  assert.equal(existiert('./gibt-es-nicht.js'), false);
  assert.equal(existiert('./css'), false, 'ein Ordner ist keine Datei');
  assert.equal(existiert('./../package.json'), false);
  assert.equal(existiert('index.html'), false, 'ohne ./ am Anfang');
  // Groß/Klein muss stimmen, auch wenn das Dateisystem es nicht unterscheidet (GitHub Pages unterscheidet)
  assert.equal(existiert('./INDEX.html'), false, 'INDEX.html ist nicht index.html');
  assert.equal(existiert('./CSS/style.css?v=2026-10-12'), false, 'Ordner in anderer Schreibweise');
  assert.equal(existiert('./js/App.js'), false, 'Datei in anderer Schreibweise');
  assert.equal(existiert('./Icon-192.png'), false);
  assert.equal(ohneDatei(['./index.html', './gibt-es-nicht.js'], existiert).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Regel 5: Stempel, Cache-Name, Manifest, Skriptreihenfolge
// ---------------------------------------------------------------------------------------------

test('Regel 5: alle ?v= in index.html sind gleich und haben die Form JJJJ-MM-TT, bei zwei Deploys am Tag mit Buchstabe', () => {
  const stempel = new Set(htmlAdressen.map(stempelVon).filter((s) => s !== null));
  assert.equal(stempel.size, 1, 'verschiedene ?v= in index.html: ' + Array.from(stempel).join(', '));
  const [einziger] = Array.from(stempel);
  assert.match(einziger, /^\d{4}-\d{2}-\d{2}[a-z]?$/);
  // und derselbe Stempel in sw.js (zeichengleiche Einträge folgen schon aus Regel 1 und 3)
  const inSw = new Set(SHELL.map(stempelVon).filter((s) => s !== null));
  assert.deepEqual(Array.from(inSw), [einziger], 'SHELL trägt einen anderen Stempel als index.html');
});

test('Regel 5: den Stempel tragen genau die eigenen Stylesheets und Skripte, Manifest und Icons nie', () => {
  const code = htmlRefs.filter(istCode);
  assert.ok(code.length >= 9, 'weniger als ein Stylesheet und acht Skripte');
  for (const r of code) { assert.notEqual(stempelVon(r.wert), null, r.wert + ' hat keinen ?v='); }
  for (const r of htmlRefs.filter((x) => !istCode(x))) {
    assert.equal(stempelVon(r.wert), null, r.wert + ' darf keinen ?v= tragen (der Pfad muss stabil bleiben)');
  }
  for (const a of manifestAdressen.concat(cssAdressen)) {
    assert.equal(stempelVon(a), null, a + ' darf keinen ?v= tragen');
  }
});

test('Regel 5: CACHE heißt heizwarte-v<n>', () => {
  assert.match(CACHE, /^heizwarte-v[1-9]\d*$/);
});

test('Regel 5: Manifest-id passt zur Stufe ' + STUFE + (STUFE === 'M1' ? ' (ohne id)' : ' (id /heizwarte/)'), () => {
  const hatId = Object.prototype.hasOwnProperty.call(manifest, 'id');
  const soll = ID_JE_STUFE[STUFE];
  if (soll === undefined) {
    assert.equal(hatId, false, 'Meilenstein 1 deployt das Manifest ohne id');
  } else {
    assert.equal(manifest.id, soll);
  }
  // nie die zwei Fallen aus Abschnitt 9: "./" löst gegen den Origin auf (zweite App), "heizwarte" ohne Schrägstrich ebenso
  assert.notEqual(manifest.id, './');
  assert.notEqual(manifest.id, 'heizwarte');
});

test('Regel 5: Manifest hat start_url ./, scope ./ und display standalone', () => {
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
});

test('Regel 5: ORDER in tests/_load.js entspricht der Skriptreihenfolge in index.html (boot → ORDER → app)', () => {
  const lader = lies('tests/_load.js');
  const m = /const ORDER = \[([^\]]*)\]/.exec(lader);
  assert.ok(m, 'const ORDER = […] in tests/_load.js nicht gefunden');
  const order = Array.from(m[1].matchAll(/'([a-z0-9-]+)'/g)).map((x) => x[1]);
  assert.ok(order.length > 0);
  const imHtml = alleTags
    .filter((tg) => tg.name === 'script' && typeof tg.attrs.src === 'string')
    .map((tg) => (/^\.\/js\/([a-z0-9-]+)\.js(?:\?v=[^"]*)?$/.exec(tg.attrs.src) || [])[1]);
  assert.deepEqual(imHtml, ['boot'].concat(order, ['app']));
  // und jede dieser Dateien liegt in SHELL
  for (const name of imHtml) {
    assert.ok(SHELL.some((e) => ohneAnhang(e) === './js/' + name + '.js'), name + '.js fehlt in SHELL');
  }
});

// ---------------------------------------------------------------------------------------------
// Die Seite selbst: Zoom, CSP
// ---------------------------------------------------------------------------------------------

test('Viewport steht wörtlich da, ohne maximum-scale und ohne user-scalable', () => {
  const zeile = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
  assert.ok(html.includes(zeile), 'die Viewport-Zeile weicht vom Plan ab (Abschnitt 2)');
  const viewports = alleTags.filter((tg) => tg.name === 'meta' && tg.attrs.name === 'viewport');
  assert.equal(viewports.length, 1, 'genau eine Viewport-Meta');
  assert.doesNotMatch(viewports[0].attrs.content, /maximum-scale|user-scalable/i);
  assert.doesNotMatch(html, /maximum-scale|user-scalable/i);
});

test('index.html: keine style-Attribute, kein <style>, kein Inline-Skript, keine Ereignis-Attribute', () => {
  for (const tg of alleTags) {
    assert.equal(tg.attrs.style, undefined, '<' + tg.name + '> trägt ein style-Attribut');
    assert.notEqual(tg.name, 'style', '<style> im Markup');
    for (const name of Object.keys(tg.attrs)) {
      assert.ok(!/^on/.test(name), '<' + tg.name + '> trägt ' + name);
    }
    for (const attr of ['src', 'href']) {
      assert.doesNotMatch(String(tg.attrs[attr] || ''), /^\s*javascript:/i, '<' + tg.name + ' ' + attr + '> beginnt mit javascript:');
    }
    if (tg.name === 'script') { assert.ok(tg.attrs.src, '<script> ohne src (Inline-Skript)'); }
  }
  const inhalte = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)).map((m) => m[1].trim());
  assert.ok(inhalte.length >= 8, 'weniger als acht <script> gefunden');
  assert.deepEqual(inhalte.filter(Boolean), [], 'Skript mit Inhalt');
});

test('css/style.css: kein @import, damit keine Quelle an SHELL vorbei geladen wird', () => {
  assert.doesNotMatch(cssOhneKommentare, /@import/i);
});

// ---------------------------------------------------------------------------------------------
// sw.js im Betrieb: am HTTP-Cache vorbei laden (Review Runde 3, Befund 3) und Rückfall ohne Netz
// ---------------------------------------------------------------------------------------------

// Wo der Worker liegt; relative Adressen in sw.js lösen sich dagegen auf, wie im Browser
const SW_URL = 'https://dennismit2n.github.io/heizwarte/sw.js';
const APP_URL = new URL('./', SW_URL).href;

// sw.js in einer nachgebauten Worker-Umgebung: die Listener werden eingesammelt, caches und fetch sind Attrappen
// mit Protokoll. netz: false lässt jedes fetch scheitern wie ohne Verbindung.
function starteSw({ netz = true, vorher = [] } = {}) {
  const listener = {};
  const protokoll = { addAll: [], fetch: [] };
  const ablage = new Map();
  for (const u of vorher) { ablage.set(new URL(u, SW_URL).href, new Response('alt')); }
  const schlüssel = (r) => (typeof r === 'string' ? new URL(r, SW_URL).href : r.url);
  const cache = {
    addAll: async (liste) => {
      protokoll.addAll.push(liste);
      for (const r of liste) { ablage.set(schlüssel(r), new Response('neu')); }
    },
    match: async (r) => { const t = ablage.get(schlüssel(r)); return t ? t.clone() : undefined; },
    put: async (r, antwort) => { ablage.set(schlüssel(r), antwort); }
  };
  class SwRequest extends Request {
    constructor(u, init) { super(typeof u === 'string' ? new URL(u, SW_URL) : u, init); }
  }
  const hülle = {
    self: {
      addEventListener: (typ, f) => { listener[typ] = f; },
      location: new URL(SW_URL),
      clients: { claim: async () => {} },
      skipWaiting: async () => {}
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async (r, init) => {
      protokoll.fetch.push({ url: schlüssel(r), init });
      if (!netz) { throw new TypeError('Failed to fetch'); }
      return new Response('vom Netz', { status: 200 });
    },
    Request: SwRequest,
    Response,
    URL,
    console
  };
  vm.runInContext(lies('sw.js'), vm.createContext(hülle), { filename: 'sw.js', timeout: 2000 });
  return { listener, protokoll, ablage };
}

// Ein fetch-Ereignis durchspielen: Antwort und alle Arbeit im Hintergrund abwarten
async function holeUeberSw(sw, request) {
  const hinten = [];
  let antwort = null;
  sw.listener.fetch({ request, respondWith: (p) => { antwort = p; }, waitUntil: (p) => { hinten.push(p); } });
  assert.ok(antwort, 'fetch-Listener ruft respondWith nicht');
  let ergebnis;
  let fehler = null;
  try { ergebnis = await antwort; } catch (e) { fehler = e; }
  await Promise.all(hinten);
  return { ergebnis, fehler };
}

// Eine Navigation wie im Browser (mode 'navigate' lässt sich in Node nicht bauen, darum ein schlichtes Objekt)
function navigation(url) {
  return { url: new URL(url, SW_URL).href, method: 'GET', mode: 'navigate' };
}

// Prüft eine addAll-Liste: genau SHELL, jede Adresse als Request mit cache 'reload'
function pruefeNeuLaden(liste) {
  assert.equal(liste.length, SHELL.length);
  liste.forEach((r, i) => {
    assert.equal(typeof r, 'object', SHELL[i] + ' geht als Text an addAll, also mit dem HTTP-Cache');
    assert.equal(r.cache, 'reload', SHELL[i] + ' wird nicht am HTTP-Cache vorbei geladen');
    assert.equal(r.url, new URL(SHELL[i], SW_URL).href);
  });
}

test('sw.js: addAll steht genau einmal da (in fillShell), Installation und Selbstheilung laden darüber', () => {
  const code = lies('sw.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal((code.match(/\.addAll\(/g) || []).length, 1, 'addAll außerhalb von fillShell');
  assert.match(code, /function fillShell\(cache\) \{\s*return cache\.addAll\(SHELL\.map\(u => new Request\(u, \{ cache: 'reload' \}\)\)\);\s*\}/);
});

test('sw.js: die Installation legt die ganze Hülle am HTTP-Cache vorbei ab (cache reload)', async () => {
  const sw = starteSw();
  let warten = null;
  sw.listener.install({ waitUntil: (p) => { warten = p; } });
  assert.ok(warten, 'install ruft waitUntil nicht');
  await warten;
  assert.equal(sw.protokoll.addAll.length, 1);
  pruefeNeuLaden(sw.protokoll.addAll[0]);
});

test('sw.js: Navigation mit Netz fragt den Server (no-cache) und holt eine gelöschte Hülle am HTTP-Cache vorbei nach', async () => {
  const sw = starteSw();
  const { ergebnis, fehler } = await holeUeberSw(sw, navigation('./'));
  assert.equal(fehler, null);
  assert.equal(await ergebnis.text(), 'vom Netz');
  assert.equal(sw.protokoll.fetch.length, 1);
  assert.equal(sw.protokoll.fetch[0].init && sw.protokoll.fetch[0].init.cache, 'no-cache', 'Navigation ohne no-cache');
  assert.equal(sw.protokoll.addAll.length, 1, 'die Hülle wurde nicht nachgeholt');
  pruefeNeuLaden(sw.protokoll.addAll[0]);
  // liegt die Hülle wieder da, holt die nächste Navigation sie nicht noch einmal
  await holeUeberSw(sw, navigation('./'));
  assert.equal(sw.protokoll.addAll.length, 1);
});

test('sw.js: gestempelte Dateien gehen ohne Zusatz ans Netz, nur Navigationen fragen mit no-cache', async () => {
  const sw = starteSw({ vorher: SHELL });
  const skript = SHELL.find((e) => e.startsWith('./js/app.js'));
  const { ergebnis } = await holeUeberSw(sw, new Request(new URL(skript, SW_URL)));
  assert.equal(await ergebnis.text(), 'alt', 'Altbestand zuerst (stale-while-revalidate)');
  assert.equal(sw.protokoll.fetch.length, 1);
  assert.equal(sw.protokoll.fetch[0].init, undefined);
  assert.equal(sw.protokoll.addAll.length, 0, 'keine Selbstheilung bei Nicht-Navigation');
});

test('sw.js: Navigation ohne Netz und ohne Treffer bekommt ./index.html (Rückfall schon in M1, Review Runde 3)', async () => {
  const sw = starteSw({ netz: false, vorher: SHELL });
  const { ergebnis, fehler } = await holeUeberSw(sw, navigation('./nicht-im-cache.html'));
  assert.equal(fehler, null, 'Navigation ohne Netz endet im Fehler statt in der App-Hülle');
  assert.equal(await ergebnis.text(), 'alt');
  assert.equal(sw.protokoll.addAll.length, 0);
  // eine Nicht-Navigation ohne Treffer bekommt dagegen den Netzfehler
  const datei = await holeUeberSw(sw, new Request(new URL('./gibt-es-nicht.js', SW_URL)));
  assert.ok(datei.fehler instanceof TypeError);
});

test('sw.js: fremde Origin und POST laufen am Worker vorbei (kein respondWith)', () => {
  const sw = starteSw();
  for (const request of [
    new Request('https://api.open-meteo.com/v1/forecast?latitude=48.877'),
    new Request(APP_URL, { method: 'POST', body: 'x' })
  ]) {
    let antwortet = false;
    sw.listener.fetch({ request, respondWith: () => { antwortet = true; }, waitUntil: () => {} });
    assert.equal(antwortet, false, request.method + ' ' + request.url);
  }
});
