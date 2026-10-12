/*
 * Tests für js/storage.js: JSON-Kodierung, Migration Version 1 → 2 (alle sechs Fälle aus BAUPLAN
 * Abschnitt 4), gesperrter und voller Speicher, Quota-Pfad, Löschen eines Orts samt Cache.
 * Das Backend ist immer fakeStorage() aus _fake.js, nie das echte localStorage.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const { fakeStorage } = require('./_fake.js');

const storage = Heizwarte.storage;
// Bürg-Schlüssel (Version 1): hw:cache, hw:leadMin 3.5, hw:leadMax 7, hw:comfort 20, kein hw:v
const V1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'storage-v1.json'), 'utf8'));
// feste Uhr und feste Id, damit der angelegte Ort exakt verglichen werden kann
const FEST = { nowMs: Date.UTC(2026, 9, 12, 14, 0, 0), newId: () => 'a1b2c3d4' };

const j = JSON.stringify;

// Backend für storage.use() anlegen und zurückgeben
function neu(anfang, optionen) {
  const be = fakeStorage(anfang, optionen);
  storage.use(be);
  return be;
}

// roher Inhalt als einfaches Objekt (Schlüssel → String), zum Vergleichen vorher/nachher
function inhalt(be) {
  return Object.fromEntries(be.map);
}

// Zeichen, die fakeStorage mit maxChars zählt: Schlüssel plus Wert
function groesse(be) {
  let n = 0;
  for (const [k, v] of be.map) { n += k.length + v.length; }
  return n;
}

// Zwei Orte, davon A aktiv, je ein Wetter-Cache, dazu ein Cache ohne Ort (Waise) und ein fremder Schlüssel
function mitCaches(optionen) {
  const wert = (n) => 'x'.repeat(n);
  return neu({
    'hw:v': 2,
    'hw:places': [{ id: 'aaaa1111' }, { id: 'bbbb2222' }],
    'hw:active': j('aaaa1111'),
    'hw:cache:aaaa1111': { daten: wert(200) },
    'hw:cache:bbbb2222': { daten: wert(200) },
    'hw:cache:cccc3333': { daten: wert(200) },
    'hw:x': 'fremd-und-roh'
  }, optionen);
}

test.afterEach(() => {
  storage.use(fakeStorage());
});

// ---------------------------------------------------------------------------------------------
// Schnittstelle und JSON-Kodierung
// ---------------------------------------------------------------------------------------------

test('Schnittstelle: use, get, set, remove, migrate und degraded; dieselbe Hülle wie Heizwarte.storage', () => {
  assert.deepEqual(Object.keys(storage).sort(), ['degraded', 'get', 'migrate', 'remove', 'set', 'use']);
  assert.equal(Heizwarte.storage, require('../js/storage.js'));
  neu();
  assert.equal(storage.degraded, null);
});

test('JSON-Kodierung: alles liegt als JSON unter hw:<key>, Typen und Umlaute bleiben erhalten', () => {
  const be = neu();
  const wert = { a: [1, 2.5, null, true], b: { text: 'Grüße – ’quer’' }, leer: [] };

  assert.equal(storage.set('x', wert), true);
  assert.equal(be.getItem('hw:x'), JSON.stringify(wert));
  assert.deepEqual(storage.get('x'), wert);

  // auch Texte, Zahlen und Wahrheitswerte als JSON (hw:lang, hw:theme, hw:more)
  storage.set('lang', 'fr');
  assert.equal(be.getItem('hw:lang'), '"fr"');
  assert.equal(storage.get('lang'), 'fr');
  storage.set('more', true);
  assert.equal(be.getItem('hw:more'), 'true');
  assert.equal(storage.get('more'), true);
  storage.set('n', 3.5);
  assert.equal(be.getItem('hw:n'), '3.5');
  assert.equal(storage.get('n'), 3.5);
  storage.set('z', null);
  assert.equal(be.getItem('hw:z'), 'null');
  assert.equal(storage.get('z', 'fallback'), null);

  // nichts ohne Präfix, nichts im Speicher-Rückfall
  assert.equal(be.getItem('x'), null);
  assert.equal(storage.degraded, null);
});

test('get: Rückfallwert bei fehlendem Schlüssel, kaputtem JSON und Schlüsseln ohne Präfix', () => {
  neu({ 'hw:kaputt': '{nicht json', ohnePraefix: '"x"' });

  assert.equal(storage.get('fehlt'), undefined);
  assert.equal(storage.get('fehlt', 42), 42);
  assert.equal(storage.get('kaputt', 'fb'), 'fb');
  assert.equal(storage.get('ohnePraefix', 'fb'), 'fb');
});

test('set mit nicht speicherbaren Werten: false, kein Wurf, nichts ändert sich', () => {
  const be = neu({ 'hw:x': '1' });
  const zyklus = {};
  zyklus.selbst = zyklus;

  assert.equal(storage.set('x', undefined), false);
  assert.equal(storage.set('x', zyklus), false);
  assert.equal(storage.set('x', 10n), false);
  assert.equal(storage.set('x', () => 1), false);
  assert.equal(be.getItem('hw:x'), '1');
  assert.equal(storage.degraded, null);
});

test('remove: nimmt nur den einen Schlüssel weg und schweigt bei fehlenden', () => {
  neu({ 'hw:a': 1, 'hw:b': 2, 'hw:cache:p1': 3 });

  storage.remove('a');
  storage.remove('gibt-es-nicht');
  assert.equal(storage.get('a', 'weg'), 'weg');
  assert.equal(storage.get('b'), 2);
  assert.equal(storage.get('cache:p1'), 3);
});

test('use() setzt den Zustand zurück: degraded null und keine Werte aus der alten Sitzung', () => {
  neu({}, { throwOnSet: true });
  assert.equal(storage.set('a', 1), false);
  assert.equal(storage.degraded, 'blocked');

  neu();
  assert.equal(storage.degraded, null);
  assert.equal(storage.get('a', 'weg'), 'weg');
});

// ---------------------------------------------------------------------------------------------
// Migration Version 1 → 2
// ---------------------------------------------------------------------------------------------

test('Migration Fall 1: hw:v = 2 → nichts tun, auch wenn alte Bürg-Schlüssel danebenstehen', () => {
  const be = neu({ 'hw:v': 2, 'hw:places': [], 'hw:leadMin': 5, 'hw:x': 'roh' });
  const vorher = inhalt(be);

  assert.deepEqual(storage.migrate(FEST), { from: 2, created: null });
  assert.deepEqual(inhalt(be), vorher);
});

test('Migration Fall 2: frische Installation → hw:v = 2 und hw:places = []', () => {
  const be = neu();

  assert.deepEqual(storage.migrate(FEST), { from: null, created: null });
  assert.deepEqual(inhalt(be), { 'hw:places': '[]', 'hw:v': '2' });
  assert.equal(storage.degraded, null);
});

test('Migration Fall 3: storage-v1.json → Ort Winnenden-Bürg mit 3,5 / 7 / 20, alte Schlüssel weg', () => {
  const be = neu(V1);
  const erwartet = {
    id: 'a1b2c3d4',
    label: 'Winnenden-Bürg',
    lat: 48.881,
    lon: 9.441,
    elev: 414,
    elevAuto: false,
    cc: 'DE',
    tz: 'Europe/Berlin',
    heat: { type: 'floorScreed', leadMin: 3.5, leadMax: 7, comfort: 20, thresh: null, confirmed: true },
    created: FEST.nowMs
  };

  assert.deepEqual(storage.migrate(FEST), { from: 1, created: erwartet });
  assert.deepEqual(storage.get('places'), [erwartet]);
  assert.equal(storage.get('active'), 'a1b2c3d4');
  assert.equal(storage.get('v'), 2);
  // der Bürg-Cache ist verworfen (Wanduhrzeit ohne Offset passt nicht ins unixtime-Modell)
  for (const alt of ['hw:cache', 'hw:leadMin', 'hw:leadMax', 'hw:comfort']) {
    assert.equal(be.getItem(alt), null, alt + ' müsste weg sein');
  }
  assert.deepEqual(Object.keys(inhalt(be)).sort(), ['hw:active', 'hw:places', 'hw:v']);
  assert.equal(storage.degraded, null);
});

test('Migration Fall 3 ohne Optionen: Id aus 8 Hex-Zeichen (zufällig), created = jetzt', () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    neu(V1);
    const vor = Date.now();
    const r = storage.migrate();
    const nach = Date.now();

    assert.match(r.created.id, /^[0-9a-f]{8}$/);
    assert.ok(r.created.created >= vor && r.created.created <= nach);
    assert.equal(storage.get('active'), r.created.id);
    ids.add(r.created.id);
  }
  // die Id hängt nicht am Namen: gleiche Eingabe, verschiedene Ids
  assert.ok(ids.size > 1);
});

test('Migration Fall 3: fehlende oder kaputte Einstellungen fallen auf 3 / 6 / 20', () => {
  neu({ 'hw:cache': { fetched: 'x' } });
  assert.deepEqual(storage.migrate(FEST).created.heat,
    { type: 'floorScreed', leadMin: 3, leadMax: 6, comfort: 20, thresh: null, confirmed: true });

  // kein JSON → 3; der Text "8" zählt als Zahl 8 (Bürg las mit +x); 21,5 bleibt exakt
  neu({ 'hw:leadMin': 'kein json', 'hw:leadMax': '"8"', 'hw:comfort': 21.5 });
  assert.deepEqual(storage.migrate(FEST).created.heat,
    { type: 'floorScreed', leadMin: 3, leadMax: 8, comfort: 21.5, thresh: null, confirmed: true });

  // null und true sind keine Zahlen
  neu({ 'hw:leadMax': null, 'hw:comfort': true });
  assert.deepEqual(storage.migrate(FEST).created.heat,
    { type: 'floorScreed', leadMin: 3, leadMax: 6, comfort: 20, thresh: null, confirmed: true });
});

test('Migration ist idempotent: der zweite Lauf ändert nichts', () => {
  const be = neu(V1);
  storage.migrate(FEST);
  const nachLauf1 = inhalt(be);

  assert.deepEqual(storage.migrate({ nowMs: 1, newId: () => 'ffffffff' }), { from: 2, created: null });
  assert.deepEqual(inhalt(be), nachLauf1);

  const frisch = neu();
  storage.migrate(FEST);
  const frischNachLauf1 = inhalt(frisch);

  assert.deepEqual(storage.migrate(FEST), { from: 2, created: null });
  assert.deepEqual(inhalt(frisch), frischNachLauf1);
});

test('Migration Fall 4: hw:v > 2 → Daten unangetastet, die App erkennt es an get("v")', () => {
  for (const v of [3, 7]) {
    const be = neu({
      'hw:v': v,
      'hw:places': [{ id: 'p1', neuesFeld: 1 }],
      'hw:cache': { a: 1 },
      'hw:leadMin': 5,
      'hw:zukunft': { x: 1 }
    });
    const vorher = inhalt(be);

    assert.deepEqual(storage.migrate(FEST), { from: null, created: null });
    assert.deepEqual(inhalt(be), vorher);
    assert.ok(storage.get('v', 2) > 2);
  }
});

test('Migration Fall 5: fremde hw:*-Schlüssel und Orts-Caches bleiben in jedem Fall stehen', () => {
  const fremd = {
    'hw:x': j('bleibt'),
    'hw:cache:ab12cd34': { fetched: 1 },
    'hw:theme': j('dark'),
    sonstwas: 'roh'
  };

  // frische Installation
  const frisch = neu(fremd);
  storage.migrate(FEST);
  for (const k of Object.keys(fremd)) {
    assert.equal(frisch.getItem(k), typeof fremd[k] === 'string' ? fremd[k] : j(fremd[k]), k);
  }

  // Bürg-Installation: nur der Schlüssel hw:cache fällt weg, nicht hw:cache:<id>
  const buerg = neu(Object.assign({}, V1, fremd));
  storage.migrate(FEST);
  assert.equal(buerg.getItem('hw:cache'), null);
  for (const k of Object.keys(fremd)) {
    assert.equal(buerg.getItem(k), typeof fremd[k] === 'string' ? fremd[k] : j(fremd[k]), k);
  }
});

test('Migration nach Abbruch mitten in Fall 3: vorhandene Orte bleiben, kein zweiter Ort', () => {
  const ort = { id: 'p0p0p0p0', label: 'Mama' };

  // places und active stehen schon, die alten Schlüssel noch, hw:v fehlt
  const a = neu(Object.assign({}, V1, { 'hw:places': [ort], 'hw:active': j('p0p0p0p0') }));
  assert.deepEqual(storage.migrate(FEST), { from: 1, created: null });
  assert.deepEqual(storage.get('places'), [ort]);
  assert.deepEqual(Object.keys(inhalt(a)).sort(), ['hw:active', 'hw:places', 'hw:v']);

  // die alten Schlüssel sind schon gelöscht, nur hw:v fehlt noch: places darf nicht überschrieben werden
  const b = neu({ 'hw:places': [ort], 'hw:active': j('p0p0p0p0') });
  assert.deepEqual(storage.migrate(FEST), { from: 1, created: null });
  assert.deepEqual(storage.get('places'), [ort]);
  assert.equal(b.getItem('hw:v'), '2');
});

test('Migration nach Abbruch mitten in Fall 2: hw:places [] ohne hw:v ist eine frische Installation, nicht Bürg', () => {
  const be = neu({ 'hw:places': [] });
  assert.deepEqual(storage.migrate(FEST), { from: null, created: null });
  assert.deepEqual(inhalt(be), { 'hw:places': '[]', 'hw:v': '2' });
  assert.deepEqual(storage.migrate(FEST), { from: 2, created: null });
});

test('Migration Fall 3 ohne crypto: kein Wurf, keine Id aus Math.random, der nächste Start versucht es wieder', () => {
  const echt = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const be = neu(V1);
  const vorher = inhalt(be);
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  let r;
  try {
    r = storage.migrate({ nowMs: FEST.nowMs });
  } finally {
    Object.defineProperty(globalThis, 'crypto', echt);
  }
  assert.deepEqual(r, { from: null, created: null });
  assert.deepEqual(inhalt(be), vorher, 'die Bürg-Schlüssel bleiben, hw:v fehlt weiter');

  // mit crypto klappt es beim nächsten Start
  const r2 = storage.migrate({ nowMs: FEST.nowMs });
  assert.equal(r2.from, 1);
  assert.match(r2.created.id, /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------------------------
// Fall 6: Speicher gesperrt oder voll
// ---------------------------------------------------------------------------------------------

test('Migration Fall 6: Backend wirft bei setItem → kein Wurf, Sitzung läuft im Arbeitsspeicher weiter', () => {
  const be = neu(V1, { throwOnSet: true });
  const vorher = inhalt(be);

  const r = storage.migrate(FEST);
  assert.equal(r.from, 1);
  assert.equal(r.created.label, 'Winnenden-Bürg');
  assert.equal(storage.degraded, 'blocked');
  // nichts im Backend verändert: die alten Schlüssel bleiben für den nächsten Start
  assert.deepEqual(inhalt(be), vorher);
  // in dieser Sitzung ist der Ort trotzdem da
  assert.deepEqual(storage.get('places'), [r.created]);
  assert.equal(storage.get('active'), r.created.id);
  assert.equal(storage.get('v'), 2);
  // und ein zweiter Lauf legt keinen zweiten an
  assert.deepEqual(storage.migrate(FEST), { from: 2, created: null });
  assert.equal(storage.get('places').length, 1);
});

test('Migration Fall 6: Speicher voll → alte Schlüssel bleiben, der Ort lebt in der Sitzung', () => {
  const opt = {};
  const be = neu(V1, opt);
  opt.maxChars = groesse(be); // kein Zeichen Luft
  const vorher = inhalt(be);

  const r = storage.migrate(FEST);
  assert.equal(r.from, 1);
  assert.equal(r.created.id, 'a1b2c3d4');
  assert.equal(storage.degraded, 'full');
  assert.deepEqual(inhalt(be), vorher);
  assert.deepEqual(storage.get('places'), [r.created]);
  assert.equal(storage.get('v'), 2);
});

test('Backend wirft schon beim Lesen: Rückfallwert, degraded blocked, Schreiben nur im Speicher', () => {
  const be = neu(V1, { throwOnGet: true });
  const vorher = inhalt(be);

  assert.equal(storage.get('leadMin', 'fb'), 'fb');
  assert.equal(storage.degraded, 'blocked');

  assert.equal(storage.set('a', 1), false);
  assert.equal(storage.get('a'), 1);
  storage.remove('a');
  assert.equal(storage.get('a', 'weg'), 'weg');

  // das Backend sieht von all dem nichts; die Migration läuft als frische Installation im Speicher
  assert.deepEqual(storage.migrate(FEST), { from: null, created: null });
  assert.deepEqual(storage.get('places'), []);
  assert.equal(storage.get('v'), 2);
  assert.deepEqual(inhalt(be), vorher);
});

test('Backend wirft bei setItem ohne Quota-Fehler: false, Wert bleibt in der Sitzung, degraded blocked', () => {
  const be = neu({ 'hw:alt': 1 }, { throwOnSet: true });

  assert.equal(storage.set('neu', { a: 1 }), false);
  assert.equal(storage.degraded, 'blocked');
  assert.deepEqual(storage.get('neu'), { a: 1 });
  assert.equal(be.getItem('hw:neu'), null);
  // das Backend bleibt lesbar: der alte Wert ist weiter da
  assert.equal(storage.get('alt'), 1);
});

test('ein einzelner Schreibfehler mitten in der Sitzung macht die gespeicherten Orte nicht unlesbar', () => {
  const ort = { id: 'p0p0p0p0', label: 'Mama' };
  const opt = {};
  const be = neu({ 'hw:v': 2, 'hw:places': [ort], 'hw:active': j('p0p0p0p0'), 'hw:lang': j('de') }, opt);
  assert.equal(storage.set('more', true), true);
  assert.equal(storage.degraded, null);

  // ab jetzt wirft setItem einen SecurityError (zum Beispiel Site-Daten mitten in der Sitzung gesperrt)
  opt.throwOnSet = true;
  assert.equal(storage.set('cache:p0p0p0p0', { v: 2 }), false);
  assert.equal(storage.degraded, 'blocked');
  assert.deepEqual(storage.get('places'), [ort], 'die Orte stehen weiter im Backend und bleiben lesbar');
  assert.equal(storage.get('active'), 'p0p0p0p0');
  assert.equal(storage.get('more'), true);
  assert.deepEqual(storage.get('cache:p0p0p0p0'), { v: 2 }, 'der neue Wert lebt in der Sitzung');

  // schreibgeschützt: auch Schreiben ohne Fehler geht nur noch in den Arbeitsspeicher, Löschen verdeckt nur
  opt.throwOnSet = false;
  assert.equal(storage.set('lang', 'fr'), false);
  assert.equal(storage.get('lang'), 'fr');
  assert.equal(be.getItem('hw:lang'), j('de'));
  storage.remove('more');
  assert.equal(storage.get('more', 'weg'), 'weg');
  assert.equal(be.getItem('hw:more'), 'true', 'das Backend bleibt unangetastet');
  assert.equal(storage.migrate(FEST).from, 2);
});

test('removeItem wirft: der Schlüssel ist in der Sitzung weg, alles andere bleibt lesbar', () => {
  const inner = fakeStorage({ 'hw:v': 2, 'hw:a': 1, 'hw:b': 2 });
  storage.use({
    getItem: (k) => inner.getItem(k),
    setItem: (k, v) => inner.setItem(k, v),
    removeItem: () => { const e = new Error('gesperrt'); e.name = 'SecurityError'; throw e; }
  });
  storage.remove('a');
  assert.equal(storage.get('a', 'weg'), 'weg');
  assert.equal(storage.get('b'), 2);
  assert.equal(storage.degraded, 'blocked');
  assert.equal(inner.getItem('hw:a'), '1');
  assert.equal(storage.set('c', 3), false, 'danach schreibgeschützt');
  assert.equal(storage.get('c'), 3);
});

test('Standard-Backend: wirft schon der Zugriff auf localStorage, bleibt alles im Arbeitsspeicher', () => {
  const vorher = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      const e = new Error('Zugriff verweigert');
      e.name = 'SecurityError';
      throw e;
    }
  });
  try {
    storage.use(); // wieder das Standard-Backend
    assert.equal(storage.degraded, 'blocked');
    assert.equal(storage.set('x', { a: 1 }), false);
    assert.deepEqual(storage.get('x'), { a: 1 });
    assert.deepEqual(storage.migrate(FEST), { from: null, created: null });
    assert.equal(storage.get('v'), 2);
  } finally {
    if (vorher) { Object.defineProperty(globalThis, 'localStorage', vorher); } else { delete globalThis.localStorage; }
  }
});

test('Standard-Backend: ohne localStorage (Node) gilt blocked, mit localStorage wird es benutzt', () => {
  const vorher = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: undefined });
    storage.use();
    assert.equal(storage.degraded, 'blocked');

    const ls = fakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: ls });
    storage.use();
    assert.equal(storage.set('a', 1), true);
    assert.equal(ls.getItem('hw:a'), '1');
    assert.equal(storage.degraded, null);
  } finally {
    if (vorher) { Object.defineProperty(globalThis, 'localStorage', vorher); } else { delete globalThis.localStorage; }
  }
});

// ---------------------------------------------------------------------------------------------
// Quota-Pfad
// ---------------------------------------------------------------------------------------------

test('Quota: fremde hw:cache:<id> werden geopfert, der Cache des aktiven Orts bleibt, dann klappt der Wert', () => {
  const opt = {};
  const be = mitCaches(opt);
  opt.maxChars = groesse(be) + 40; // der neue Cache von A ist rund 180 Zeichen größer als der alte

  const neuerCache = { daten: 'y'.repeat(380) };
  assert.equal(storage.set('cache:aaaa1111', neuerCache), true);

  assert.equal(be.getItem('hw:cache:bbbb2222'), null);
  assert.equal(be.getItem('hw:cache:cccc3333'), null);
  assert.equal(be.getItem('hw:cache:aaaa1111'), j(neuerCache));
  assert.equal(be.getItem('hw:x'), 'fremd-und-roh');
  assert.equal(be.getItem('hw:v'), '2');
  assert.deepEqual(storage.get('places'), [{ id: 'aaaa1111' }, { id: 'bbbb2222' }]);
  assert.equal(storage.degraded, null);
});

test('Quota: ein Backend ohne key() und length opfert die Caches der Orte aus hw:places', () => {
  const opt = {};
  const inner = mitCaches(opt);
  opt.maxChars = groesse(inner) + 40;
  // nur getItem, setItem, removeItem: wie ein Backend, das sich nicht aufzählen lässt
  storage.use({
    getItem: (k) => inner.getItem(k),
    setItem: (k, v) => inner.setItem(k, v),
    removeItem: (k) => inner.removeItem(k)
  });

  assert.equal(storage.set('cache:aaaa1111', { daten: 'y'.repeat(380) }), true);
  assert.equal(inner.getItem('hw:cache:bbbb2222'), null);
  assert.notEqual(inner.getItem('hw:cache:aaaa1111'), null);
  assert.equal(storage.degraded, null);
});

test('Quota: steht hw:active nicht in hw:places, bleibt der Cache von places[0]', () => {
  const opt = {};
  const be = mitCaches(opt);
  be.setItem('hw:active', j('zzzz9999'));
  opt.maxChars = groesse(be) + 40;

  assert.equal(storage.set('notiz', 'n'.repeat(300)), true);
  assert.notEqual(be.getItem('hw:cache:aaaa1111'), null);
  assert.equal(be.getItem('hw:cache:bbbb2222'), null);
  assert.equal(be.getItem('hw:cache:cccc3333'), null);
});

test('Quota: der alte Fehlercode 22 ohne Namen löst den Opferpfad ebenfalls aus', () => {
  const m = new Map([
    ['hw:places', j([{ id: 'a' }, { id: 'b' }])],
    ['hw:active', j('a')],
    ['hw:cache:b', j('alt')]
  ]);
  storage.use({
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    removeItem: (k) => { m.delete(k); },
    setItem(k, v) {
      if (!m.has(k) && m.size >= 3) {
        const e = new Error('voll');
        e.code = 22;
        throw e;
      }
      m.set(k, v);
    }
  });

  assert.equal(storage.set('lang', 'de'), true);
  assert.equal(m.has('hw:cache:b'), false);
  assert.equal(m.get('hw:lang'), '"de"');
  assert.equal(storage.degraded, null);
});

test('Quota: passt der Wert auch nach dem Opfern nicht, bleibt er im Speicher und degraded wird full', () => {
  const opt = {};
  const be = mitCaches(opt);
  opt.maxChars = groesse(be) + 40;

  const gross = 'z'.repeat(5000);
  assert.equal(storage.set('notiz', gross), false);
  assert.equal(storage.degraded, 'full');
  assert.equal(be.getItem('hw:notiz'), null);
  assert.equal(storage.get('notiz'), gross);
  // der aktive Cache wurde trotzdem nie geopfert
  assert.notEqual(be.getItem('hw:cache:aaaa1111'), null);

  // Kleines geht weiter ins Backend; degraded bleibt für den Rest der Sitzung full
  assert.equal(storage.set('klein', 1), true);
  assert.equal(be.getItem('hw:klein'), '1');
  assert.equal(storage.degraded, 'full');

  // remove räumt auch den Sitzungswert weg
  storage.remove('notiz');
  assert.equal(storage.get('notiz', 'weg'), 'weg');
});

test('Quota: ein Wert, der nicht mehr passt, überlagert beim Lesen den alten Wert im Backend', () => {
  const opt = {};
  const be = mitCaches(opt);
  opt.maxChars = groesse(be) + 40;
  const alt = be.getItem('hw:cache:aaaa1111');

  assert.equal(storage.set('cache:aaaa1111', { daten: 'y'.repeat(5000) }), false);
  assert.equal(be.getItem('hw:cache:aaaa1111'), alt);
  assert.equal(storage.get('cache:aaaa1111').daten.length, 5000);
  assert.equal(storage.degraded, 'full');
});

// ---------------------------------------------------------------------------------------------
// Orte löschen
// ---------------------------------------------------------------------------------------------

test('Löschen eines Orts: remove("cache:<id>") nimmt genau dessen Cache mit, die übrigen bleiben', () => {
  const be = mitCaches();

  // so löscht die App einen Ort: Liste ohne den Ort schreiben, dann dessen Cache entfernen
  const rest = storage.get('places').filter((p) => p.id !== 'bbbb2222');
  assert.equal(storage.set('places', rest), true);
  storage.remove('cache:bbbb2222');

  assert.equal(be.getItem('hw:cache:bbbb2222'), null);
  assert.notEqual(be.getItem('hw:cache:aaaa1111'), null);
  assert.notEqual(be.getItem('hw:cache:cccc3333'), null); // gehört keinem Ort der Liste, aber auch nicht diesem
  assert.deepEqual(storage.get('places'), [{ id: 'aaaa1111' }]);
  assert.equal(storage.get('cache:bbbb2222', 'weg'), 'weg');
  assert.equal(be.getItem('hw:x'), 'fremd-und-roh');
});

test('Löschen eines Orts: auch ein Cache, der nur im Arbeitsspeicher lag, ist danach weg', () => {
  const opt = {};
  const be = neu({
    'hw:v': 2,
    'hw:places': [{ id: 'aaaa1111' }, { id: 'bbbb2222' }],
    'hw:active': j('bbbb2222')
  }, opt);
  opt.maxChars = groesse(be) + 10;

  // der Cache des aktiven Orts B passt nicht mehr hinein und lebt nur in der Sitzung
  assert.equal(storage.set('cache:bbbb2222', 'q'.repeat(2000)), false);
  assert.equal(storage.degraded, 'full');
  assert.equal(storage.get('cache:bbbb2222').length, 2000);

  storage.set('places', [{ id: 'aaaa1111' }]);
  storage.remove('cache:bbbb2222');
  assert.equal(storage.get('cache:bbbb2222', 'weg'), 'weg');
  assert.equal(be.getItem('hw:cache:bbbb2222'), null);
});
