/*
 * Heizwarte — Tests für js/geo.js: Photon-Suche, Treffer lesen und ordnen, Höhe, Rundung, Standort
 *
 * Alle Dienste laufen gegen Fixtures über fakeFetch (tests/_fake.js), nie gegen das Netz; die Geräteposition
 * kommt von fakeGeolocation. Herkunft der Fixtures (BAUPLAN Abschnitt 12):
 *   photon-haus.json               Kopie von photon1.json: echte Antwort auf "Marktstraße 1 71364 Winnenden" (5 Treffer)
 *   photon-ohne-nummer.json        Kopie von photon2.json: echte Antwort auf "Bürg Winnenden" (Ortsteil, Haltestelle, Friedhof …)
 *   photon-strasse-ohne-nummer.json  konstruiert in der Form von photon1.json: drei Straßentreffer "Marktstraße"
 *                                  (zwei Abschnitte in Winnenden, einer in Waiblingen); Koordinaten und osm_id von Hand
 *   photon-leer.json               KT §3.2: features []
 *   photon-reverse-leer.json       konstruiert, Form wie photon-leer.json (KT §3.5)
 *   photon-400-lang.json           KT §3.3: Body der 400-Antwort bei lang=xx (im Test mit Status 400 ausgeliefert)
 *   elev.json                      KT §4: {"elevation":[417.0]}
 *   elev-400.json                  Form aus KT §4 (error true, reason); der Wortlaut ist von Hand, ausgeliefert mit Status 400
 *   elev-leer.json                 konstruiert: {"elevation":[]}
 * Die 429-Antwort hat keine eigene Fixture (leerer Body, Abschnitt 12): sie ist im Test ein { status: 429 }.
 * geo.js hat keine Zeitabhängigkeit; die Zeitzonenläufe aus Abschnitt 12 ändern an diesen Tests nichts.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const { fakeFetch, fakeGeolocation } = require('./_fake.js');
const geo = Heizwarte.geo;

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function near(a, b, eps) {
  assert.ok(Math.abs(a - b) <= eps, a + ' ist nicht ' + b + ' ± ' + eps);
}

// Photon-Dienst mit einer Antwort für /api/ (Suche); über „spec“ auch Status, Köpfe oder Fehler
function photon(antwort) {
  return fakeFetch({ 'photon.komoot.io/api/': antwort });
}

// Reverse-Dienst von Photon
function photonReverse(antwort) {
  return fakeFetch({ 'photon.komoot.io/reverse': antwort });
}

function hoehe(antwort) {
  return fakeFetch({ 'api.open-meteo.com/v1/elevation': antwort });
}

// Wirft der Aufruf einen GeoError mit diesem Code?
async function wirftGeoError(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof geo.GeoError, 'GeoError erwartet, bekommen: ' + e);
    assert.equal(e.code, code);
    assert.ok(e instanceof Error);
    return true;
  });
}

// Ein GeoJSON-Feature in der Form von Photon, für die kind-Regeln und kaputte Eingaben
function feature(props, lon, lat) {
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'Point', coordinates: [lon === undefined ? 9.4 : lon, lat === undefined ? 48.9 : lat] }
  };
}

function kindOf(props) {
  return geo.parseFeatures({ features: [feature(props)] })[0].kind;
}

// Zeichenkette ohne Kommentare, damit die Quelltextprüfung nur Code sieht
function ohneKommentare(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const MARKTSTRASSE_EXTENT = [9.3962769, 48.8773938, 9.3965767, 48.8771427];

// ---------------------------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------------------------

test('geo.js ist geladen und bietet genau die Schnittstelle aus Abschnitt 5', () => {
  assert.ok(!Heizwarte._missing.includes('geo'));
  assert.deepEqual(Object.keys(geo).sort(), [
    'GeoError', 'buildQuery', 'describe', 'elevation', 'extentSize', 'locate', 'parseFeatures',
    'photonLang', 'rank', 'reverse', 'round3', 'search'
  ]);
  assert.equal(globalThis.Heizwarte.geo, geo, 'auch unter Heizwarte.geo erreichbar');
});

test('geo.js fasst weder Uhr noch DOM noch Speicher noch navigator an', () => {
  const code = ohneKommentare(fs.readFileSync(path.join(__dirname, '..', 'js', 'geo.js'), 'utf8'));
  for (const verboten of [/\bDate\b/, /\bIntl\b/, /\bdocument\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bnavigator\b/, /\binnerHTML\b/]) {
    assert.doesNotMatch(code, verboten, String(verboten));
  }
  // Photon darf der Browser aus seinem Zwischenspeicher bedienen (max-age=3600, KT §3.4)
  assert.doesNotMatch(code, /no-store/);
});

// ---------------------------------------------------------------------------------------------
// round3, photonLang, buildQuery
// ---------------------------------------------------------------------------------------------

test('round3: drei Nachkommastellen, wie im Plan', () => {
  assert.equal(geo.round3(48.8813), 48.881);
  assert.equal(geo.round3(9.4412), 9.441);
  assert.equal(geo.round3(48.8772683), 48.877);
  assert.equal(geo.round3(9.3964273), 9.396);
  assert.equal(geo.round3(48.8817501), 48.882);
  assert.equal(geo.round3(-9.1393), -9.139);
  assert.equal(geo.round3(-9.1397), -9.14);
  assert.equal(geo.round3(48), 48);
  assert.ok(Number.isNaN(geo.round3(NaN)));
  assert.ok(Number.isNaN(geo.round3(undefined)));
});

test('round3: negative Null wird zu 0', () => {
  assert.ok(Object.is(geo.round3(-0.0004), 0));
  assert.ok(Object.is(geo.round3(0.0004), 0));
  assert.ok(Object.is(geo.round3(-0), 0));
});

test('round3 liefert nie mehr als drei Nachkommastellen, auch nicht in der Textform', () => {
  // feste Folge statt Zufall: ein einfacher Kongruenzgenerator
  let s = 12345;
  const next = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < 3000; i++) {
    const x = (next() - 0.5) * 360 + next() * 1e-7;
    const r = geo.round3(x);
    assert.match(String(r), /^-?\d+(\.\d{1,3})?$/, 'round3(' + x + ') = ' + r);
    near(r, x, 0.0005 + 1e-9);
  }
  // Randfälle aus der Praxis: Werte mit vielen Stellen
  for (const x of [48.8772683, 9.3964273, 38.7223, -9.1393, 0.1 + 0.2, 1.0005, 2.675, 179.99999, -90]) {
    assert.match(String(geo.round3(x)), /^-?\d+(\.\d{1,3})?$/, String(x));
  }
});

test('photonLang: de, fr, alles andere en (KT §3.3)', () => {
  assert.equal(geo.photonLang('de'), 'de');
  assert.equal(geo.photonLang('fr'), 'fr');
  assert.equal(geo.photonLang('en'), 'en');
  assert.equal(geo.photonLang('ko'), 'en');
  const soll = { de: 'de', en: 'en', es: 'en', fr: 'fr', it: 'en', nl: 'en', pl: 'en', pt: 'en', tr: 'en', ru: 'en', hi: 'en', zh: 'en', ja: 'en', ko: 'en' };
  for (const lang of Object.keys(soll)) { assert.equal(geo.photonLang(lang), soll[lang], lang); }
  assert.equal(geo.photonLang('de-AT'), 'de');
  assert.equal(geo.photonLang('FR'), 'fr');
  assert.equal(geo.photonLang('pt-BR'), 'en');
  assert.equal(geo.photonLang('xx'), 'en');
  for (const nichts of [undefined, null, '', 42, {}]) { assert.equal(geo.photonLang(nichts), 'en'); }
});

test('buildQuery: Teile mit Leerzeichen, leere weg', () => {
  assert.equal(geo.buildQuery({ street: 'Marktstraße 1', zip: '71364', city: 'Winnenden' }), 'Marktstraße 1 71364 Winnenden');
  assert.equal(geo.buildQuery({ street: '', zip: '71364', city: 'Winnenden' }), '71364 Winnenden');
  assert.equal(geo.buildQuery({ street: '  ', zip: '', city: ' Winnenden ' }), 'Winnenden');
  assert.equal(geo.buildQuery({ street: 'Marktstraße   1', city: 'Winnenden' }), 'Marktstraße 1 Winnenden');
  assert.equal(geo.buildQuery({}), '');
  assert.equal(geo.buildQuery(), '');
  assert.equal(geo.buildQuery(null), '');
});

// ---------------------------------------------------------------------------------------------
// parseFeatures
// ---------------------------------------------------------------------------------------------

test('parseFeatures photon-haus: [lon, lat] richtig gedreht, kind house, poi, poi, poi, house', () => {
  const hits = geo.parseFeatures(fixture('photon-haus.json'));
  assert.equal(hits.length, 5);
  assert.deepEqual(hits.map((h) => h.kind), ['house', 'poi', 'poi', 'poi', 'house']);

  const h = hits[0];
  assert.equal(h.lat, 48.8772683);
  assert.equal(h.lon, 9.3964273);
  assert.equal(h.cc, 'DE');
  assert.equal(h.hasNumber, true);
  assert.deepEqual(h.extent, MARKTSTRASSE_EXTENT);
  assert.equal(h.label, 'Marktstraße 1');
  assert.equal(h.line2, '71364 Winnenden, Deutschland');
  assert.equal(h.region, 'Bahnhofsvorstadt, Rems-Murr-Kreis, Baden-Württemberg');
  assert.deepEqual(h.parts, {
    name: '', housenumber: '1', street: 'Marktstraße', postcode: '71364', city: 'Winnenden', district: 'Winnenden',
    locality: 'Bahnhofsvorstadt', county: 'Rems-Murr-Kreis', state: 'Baden-Württemberg', country: 'Deutschland',
    osmKey: 'building', osmValue: 'commercial', type: 'house'
  });

  // Läden: type 'house' MIT Nummer und name ist kein Haus
  assert.equal(hits[1].parts.name, 'Apotheke am Kronenplatz');
  assert.equal(hits[1].parts.osmKey, 'amenity');
  assert.equal(hits[1].hasNumber, true);
  assert.equal(hits[1].extent, null);
  assert.equal(hits[2].parts.name, 'Sezi\'s Kiosk');
  assert.equal(hits[3].parts.name, 'Blue Bar');

  assert.equal(hits[4].parts.housenumber, '23/1');
  assert.equal(hits[4].label, 'Marktstraße 23/1');
  assert.equal(hits[4].region, 'Gerberviertel, Rems-Murr-Kreis, Baden-Württemberg');
});

test('parseFeatures photon-ohne-nummer: Ortsteil ist place, Haltestelle ist poi und kein Haus, Backhäusle ist house', () => {
  const hits = geo.parseFeatures(fixture('photon-ohne-nummer.json'));
  assert.equal(hits.length, 5);
  assert.deepEqual(hits.map((h) => h.kind), ['place', 'poi', 'poi', 'poi', 'house']);

  const buerg = hits[0];
  assert.equal(buerg.parts.type, 'district');
  assert.equal(buerg.hasNumber, false);
  assert.equal(buerg.lat, 48.8817501);
  assert.equal(buerg.lon, 9.4413625);
  assert.equal(buerg.label, 'Bürg');
  assert.equal(buerg.line2, 'Winnenden, Deutschland');
  assert.equal(buerg.region, 'Rems-Murr-Kreis, Baden-Württemberg');
  assert.deepEqual(buerg.extent, [9.4324428, 48.8941292, 9.4627316, 48.870991]);

  // die Falle aus KT §3.2: type 'house', aber keine Nummer
  const halt = hits[1];
  assert.equal(halt.parts.type, 'house');
  assert.equal(halt.parts.osmKey, 'highway');
  assert.equal(halt.hasNumber, false);
  assert.equal(halt.kind, 'poi');
  assert.equal(halt.label, 'Ebniseestraße');
  assert.equal(halt.line2, '71364 Winnenden, Deutschland');
  assert.equal(halt.region, 'Schulerhof, Rems-Murr-Kreis, Baden-Württemberg');

  assert.equal(hits[2].parts.type, 'other');
  assert.equal(hits[2].label, 'Friedhof Bürg', 'ohne Straße und Nummer trägt der Name');
  assert.equal(hits[3].kind, 'poi', 'Spielplatz: type house, ohne Nummer');

  const backhaeusle = hits[4];
  assert.equal(backhaeusle.kind, 'house');
  assert.equal(backhaeusle.hasNumber, true);
  assert.equal(backhaeusle.label, 'Neuffenstraße 6');

  // kein „undefined“, „null“ oder „NaN“ in irgendeinem Text
  for (const h of hits) {
    for (const text of [h.label, h.line2, h.region]) { assert.doesNotMatch(text, /undefined|null|NaN/); }
    assert.ok(h.label.length > 0);
  }
});

test('parseFeatures photon-strasse-ohne-nummer: type street, kein hasNumber, Name als Anzeige', () => {
  const hits = geo.parseFeatures(fixture('photon-strasse-ohne-nummer.json'));
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.kind), ['street', 'street', 'street']);
  assert.deepEqual(hits.map((h) => h.hasNumber), [false, false, false]);
  assert.equal(hits[0].label, 'Marktstraße');
  assert.equal(hits[0].line2, '71364 Winnenden, Deutschland');
  assert.equal(hits[0].region, 'Bahnhofsvorstadt, Rems-Murr-Kreis, Baden-Württemberg');
  assert.equal(hits[2].line2, '71332 Waiblingen, Deutschland');
  assert.equal(hits[2].region, 'Waiblingen, Rems-Murr-Kreis, Baden-Württemberg');
});

test('parseFeatures: die kind-Regeln einzeln', () => {
  // Gebäude, auch mit Name und ohne Nummer
  assert.equal(kindOf({ osm_key: 'building', name: 'Backhäusle', type: 'house' }), 'house');
  assert.equal(kindOf({ osm_key: 'building', housenumber: '3', type: 'house' }), 'house');
  // Adresspunkt mit Nummer ohne Namen (Annahme in Abschnitt 5): Haus, auch ohne building
  assert.equal(kindOf({ osm_key: 'place', housenumber: '3', type: 'house' }), 'house');
  // Nummer mit Namen und ohne building: Ort von Interesse
  assert.equal(kindOf({ osm_key: 'amenity', housenumber: '1', name: 'Blue Bar', type: 'house' }), 'poi');
  // Straße
  assert.equal(kindOf({ osm_key: 'highway', name: 'Marktstraße', type: 'street' }), 'street');
  // Orte nach Layer
  for (const type of ['locality', 'district', 'city', 'county', 'state', 'country']) {
    assert.equal(kindOf({ osm_key: 'place', name: 'X', type }), 'place', type);
  }
  // alles andere
  assert.equal(kindOf({ osm_key: 'landuse', name: 'Friedhof', type: 'other' }), 'poi');
  assert.equal(kindOf({ osm_key: 'highway', name: 'Haltestelle', type: 'house' }), 'poi');
  assert.equal(kindOf({}), 'poi');
  assert.equal(kindOf({ type: 'etwas-neues', name: 'X' }), 'poi');
});

test('parseFeatures: Randfälle der Felder', () => {
  const [a] = geo.parseFeatures({ features: [feature({ countrycode: 'at', housenumber: 5, street: ' Ringstraße ', extent: [1, 2, 3] })] });
  assert.equal(a.cc, 'AT', 'Ländercode groß');
  assert.equal(a.parts.housenumber, '5', 'Zahl wird Text');
  assert.equal(a.hasNumber, true);
  assert.equal(a.parts.street, 'Ringstraße', 'getrimmt');
  assert.equal(a.extent, null, 'Umriss mit drei Zahlen ist unbrauchbar');
  assert.equal(a.label, 'Ringstraße 5');

  const [b] = geo.parseFeatures({ features: [feature({ extent: ['a', 'b', 'c', 'd'] })] });
  assert.equal(b.cc, null);
  assert.equal(b.extent, null);
  assert.equal(b.hasNumber, false);
  assert.equal(b.label, '');
  for (const key of Object.keys(b.parts)) { assert.equal(b.parts[key], '', key); }

  // der Umriss ist eine Kopie, nicht das Feld der Antwort
  const geojson = clone(fixture('photon-haus.json'));
  const [c] = geo.parseFeatures(geojson);
  c.extent[0] = 0;
  assert.equal(geojson.features[0].properties.extent[0], 9.3962769);
});

test('parseFeatures: kaputte Features fallen weg, kaputte Antworten ergeben []', () => {
  const gut = feature({ name: 'Gut', type: 'city' });
  const kaputt = [
    null,
    'text',
    42,
    {},
    { type: 'Feature', properties: {} },
    { type: 'Feature', geometry: { type: 'Point' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: ['9.4', '48.9'] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [9.4, null] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [9.4, 91] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [181, 48.9] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [NaN, 48.9] } }
  ];
  const hits = geo.parseFeatures({ features: kaputt.concat([gut]) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'Gut');

  for (const x of [null, undefined, {}, [], 'x', 0, { features: null }, { features: 'x' }, { features: {} }, fixture('photon-leer.json')]) {
    assert.deepEqual(geo.parseFeatures(x), []);
  }
});

// ---------------------------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------------------------

test('rank photon-haus: vier Treffer an einer round3-Koordinate werden einer, es bleiben zwei', () => {
  const hits = geo.parseFeatures(fixture('photon-haus.json'));
  const gerundet = hits.map((h) => geo.round3(h.lat) + '/' + geo.round3(h.lon));
  assert.deepEqual(gerundet, ['48.877/9.396', '48.877/9.396', '48.877/9.396', '48.877/9.396', '48.877/9.397']);

  const r = geo.rank(hits, { housenumber: '1' });
  assert.equal(r.length, 2);
  assert.equal(r[0].label, 'Marktstraße 1');
  assert.equal(r[0].kind, 'house');
  assert.deepEqual(r[0].extent, MARKTSTRASSE_EXTENT, 'das Gebäude W 121843542, nicht Apotheke, Kiosk oder Bar');
  assert.equal(r[1].label, 'Marktstraße 23/1');
});

test('rank: der Eingabe-Liste passiert nichts, jeder Aufruf liefert dasselbe', () => {
  const hits = geo.parseFeatures(fixture('photon-haus.json'));
  const vorher = clone(hits);
  const a = geo.rank(hits, { housenumber: '1' });
  const b = geo.rank(hits, { housenumber: '1' });
  assert.deepEqual(hits, vorher);
  assert.deepEqual(a, b);
  assert.notEqual(a, hits);
});

test('rank: Haus mit passender Nummer vor übrigen Häusern', () => {
  const hits = geo.parseFeatures(fixture('photon-haus.json'));
  const r = geo.rank(hits, { housenumber: '23/1' });
  assert.deepEqual(r.map((h) => h.label), ['Marktstraße 23/1', 'Marktstraße 1']);
  // ohne gesuchte Nummer bleibt Photons Reihenfolge innerhalb der Klasse
  for (const wanted of [undefined, null, {}, { housenumber: '' }, { housenumber: '99' }, '', 7]) {
    assert.deepEqual(geo.rank(hits, wanted).map((h) => h.label), ['Marktstraße 1', 'Marktstraße 23/1'], JSON.stringify(wanted));
  }
});

test('rank: wanted als Zeichenkette, mit Leerzeichen und Groß- oder Kleinschreibung', () => {
  const hits = geo.parseFeatures({ features: [
    feature({ street: 'Ringstraße', housenumber: '12', osm_key: 'building', type: 'house' }, 9.1, 48.1),
    feature({ street: 'Ringstraße', housenumber: '1 A', osm_key: 'building', type: 'house' }, 9.2, 48.2),
    feature({ street: 'Ringstraße', housenumber: '1', osm_key: 'building', type: 'house' }, 9.3, 48.3)
  ] });
  assert.equal(geo.rank(hits, '1a')[0].parts.housenumber, '1 A');
  assert.equal(geo.rank(hits, ' 1A ')[0].parts.housenumber, '1 A');
  assert.equal(geo.rank(hits, { housenumber: '1' })[0].parts.housenumber, '1', '"1" trifft nicht "12" und nicht "1 A"');
  assert.equal(geo.rank(hits, { housenumber: '12' })[0].parts.housenumber, '12');
});

test('rank: Haus mit passender Nummer schlägt den Laden an derselben Koordinate, auch wenn der Laden zuerst kommt', () => {
  const hits = geo.parseFeatures(fixture('photon-haus.json'));
  const r = geo.rank([hits[1], hits[2], hits[3], hits[0]], { housenumber: '1' });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'house');
  assert.equal(r[0].label, 'Marktstraße 1');
  assert.deepEqual(r[0].extent, MARKTSTRASSE_EXTENT);
});

test('rank: Häuser, dann Straßen, dann Orte, dann Läden; je Klasse Photons Reihenfolge', () => {
  const hits = geo.parseFeatures({ features: [
    feature({ name: 'Laden A', osm_key: 'shop', type: 'house', housenumber: '1' }, 9.01, 48.01),
    feature({ name: 'Ort', osm_key: 'place', type: 'city' }, 9.02, 48.02),
    feature({ name: 'Straße', osm_key: 'highway', type: 'street' }, 9.03, 48.03),
    feature({ name: 'Haus B', osm_key: 'building', type: 'house' }, 9.04, 48.04),
    feature({ name: 'Laden B', osm_key: 'shop', type: 'other' }, 9.05, 48.05),
    feature({ name: 'Haus A', osm_key: 'building', type: 'house' }, 9.06, 48.06),
    feature({ name: 'Kreis', osm_key: 'boundary', type: 'county' }, 9.07, 48.07),
    feature({ name: 'Straße 2', osm_key: 'highway', type: 'street' }, 9.08, 48.08)
  ] });
  assert.deepEqual(geo.rank(hits, {}).map((h) => h.label), [
    'Haus B', 'Haus A', 'Straße', 'Straße 2', 'Ort', 'Kreis', 'Laden A', 'Laden B'
  ]);
});

test('rank: Straßenabschnitte an einer Koordinate werden einer', () => {
  const hits = geo.parseFeatures(fixture('photon-strasse-ohne-nummer.json'));
  const r = geo.rank(hits, {});
  assert.equal(r.length, 2, 'zwei Abschnitte in Winnenden teilen 48.877/9.397');
  assert.equal(r[0].line2, '71364 Winnenden, Deutschland');
  assert.equal(r[0].region, 'Bahnhofsvorstadt, Rems-Murr-Kreis, Baden-Württemberg', 'der erste Abschnitt bleibt');
  assert.equal(r[1].line2, '71332 Waiblingen, Deutschland');
});

test('rank photon-ohne-nummer: Backhäusle, Bürg und Haltestelle teilen 48.882/9.441, es bleibt das Haus', () => {
  // Beobachtung zum Plan (siehe BAUPLAN, „Vom Bau einzutragen“): Die Regel „bestplatzierter der Gruppe bleibt“
  // lässt das Haus den Ortsteil verdecken, wenn beide dieselbe gerundete Koordinate haben.
  const hits = geo.parseFeatures(fixture('photon-ohne-nummer.json'));
  const r = geo.rank(hits, {});
  assert.deepEqual(r.map((h) => h.label), ['Neuffenstraße 6', 'Friedhof Bürg', 'Ebniseestraße']);
  assert.equal(r[2].parts.name, 'Waldspielplatz Bürg');
  assert.equal(r[0].kind, 'house');
  assert.equal(geo.round3(r[0].lat), 48.882);
  assert.equal(geo.round3(r[0].lon), 9.441);
  assert.deepEqual(r.map((h) => h.kind), ['house', 'poi', 'poi']);
});

test('rank: tolerant gegenüber Unsinn', () => {
  assert.deepEqual(geo.rank([], { housenumber: '1' }), []);
  assert.deepEqual(geo.rank(undefined, {}), []);
  assert.deepEqual(geo.rank(null), []);
  assert.deepEqual(geo.rank('x'), []);
  const hits = geo.parseFeatures(fixture('photon-haus.json'));
  assert.equal(geo.rank([null, undefined, 5].concat(hits), { housenumber: '1' }).length, 2);
});

// ---------------------------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------------------------

test('describe: label, line2 und region aus den vorhandenen Feldern', () => {
  const d = geo.describe({ parts: {
    street: 'Marktstraße', housenumber: '1', postcode: '71364', city: 'Winnenden', country: 'Deutschland',
    locality: 'Bahnhofsvorstadt', district: 'Winnenden', county: 'Rems-Murr-Kreis', state: 'Baden-Württemberg'
  } });
  assert.deepEqual(d, {
    label: 'Marktstraße 1',
    line2: '71364 Winnenden, Deutschland',
    region: 'Bahnhofsvorstadt, Rems-Murr-Kreis, Baden-Württemberg'
  });
});

test('describe: Rückfälle ohne Straße, ohne Postleitzahl, ohne Ort, ohne alles', () => {
  // label: Straße + Nummer, sonst Name, sonst Ort
  assert.equal(geo.describe({ parts: { street: 'Ebniseestraße', name: 'Haltestelle' } }).label, 'Ebniseestraße');
  assert.equal(geo.describe({ parts: { name: 'Bürg', city: 'Winnenden' } }).label, 'Bürg');
  assert.equal(geo.describe({ parts: { city: 'Winnenden' } }).label, 'Winnenden');
  // eine Nummer allein ist keine Anzeige: sie hängt nur an einer Straße
  assert.equal(geo.describe({ parts: { housenumber: '3', name: 'Laden A' } }).label, 'Laden A');
  assert.equal(geo.describe({ parts: { housenumber: '3', city: 'Bürg' } }).label, 'Bürg');
  assert.equal(geo.describe({ parts: { housenumber: '3' } }).label, '');
  assert.equal(geo.describe({ parts: { street: 'Ringstraße', housenumber: '3', name: 'Laden A' } }).label, 'Ringstraße 3');
  // line2
  assert.equal(geo.describe({ parts: { city: 'Winnenden', country: 'Deutschland' } }).line2, 'Winnenden, Deutschland');
  assert.equal(geo.describe({ parts: { postcode: '71364', city: 'Winnenden' } }).line2, '71364 Winnenden');
  assert.equal(geo.describe({ parts: { postcode: '71364' } }).line2, '71364');
  assert.equal(geo.describe({ parts: { country: 'Deutschland' } }).line2, 'Deutschland', 'kein führendes Komma');
  // region: locality vor district
  assert.equal(geo.describe({ parts: { locality: 'A', district: 'B', county: 'C', state: 'D' } }).region, 'A, C, D');
  assert.equal(geo.describe({ parts: { district: 'B', state: 'D' } }).region, 'B, D');
  assert.equal(geo.describe({ parts: { county: 'C' } }).region, 'C');
  // nichts da: leere Texte, kein Wurf
  const leer = { label: '', line2: '', region: '' };
  assert.deepEqual(geo.describe({ parts: {} }), leer);
  assert.deepEqual(geo.describe({}), leer);
  assert.deepEqual(geo.describe(null), leer);
  assert.deepEqual(geo.describe(), leer);
});

test('describe: nie „undefined“ im Text, auch bei halben Treffern', () => {
  const halbe = [
    { parts: { street: 'Marktstraße' } },
    { parts: { housenumber: '3' } },
    { parts: { postcode: undefined, city: null, country: undefined } },
    { parts: { street: undefined, housenumber: undefined, name: undefined, city: undefined } }
  ];
  for (const hit of halbe) {
    const d = geo.describe(hit);
    for (const text of [d.label, d.line2, d.region]) {
      assert.equal(typeof text, 'string');
      assert.doesNotMatch(text, /undefined|null|NaN/);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// extentSize
// ---------------------------------------------------------------------------------------------

test('extentSize: Marktstraße 1 ist etwa 22 × 28 m', () => {
  const s = geo.extentSize(MARKTSTRASSE_EXTENT, 48.8772683);
  assert.equal(Math.round(s.w), 22);
  assert.equal(Math.round(s.h), 28);
  near(s.w, 21.95, 0.1);
  near(s.h, 27.77, 0.1);
  // Formel aus dem Plan, unabhängig nachgerechnet
  near(s.w, (9.3965767 - 9.3962769) * 111320 * Math.cos(48.8772683 * Math.PI / 180), 1e-9);
  near(s.h, (48.8773938 - 48.8771427) * 110574, 1e-9);
});

test('extentSize: ein Ortsteil ist einige Kilometer groß', () => {
  const s = geo.extentSize([9.4324428, 48.8941292, 9.4627316, 48.870991], 48.8817501);
  assert.ok(s.w > 2100 && s.w < 2300, 'Breite ' + s.w);
  assert.ok(s.h > 2500 && s.h < 2600, 'Höhe ' + s.h);
});

test('extentSize: ohne Breite gilt die Mitte des Umrisses, ein umgekehrter Umriss liefert dieselbe Größe', () => {
  const mit = geo.extentSize(MARKTSTRASSE_EXTENT, 48.8772683);
  const ohne = geo.extentSize(MARKTSTRASSE_EXTENT);
  near(ohne.w, mit.w, 0.01);
  near(ohne.h, mit.h, 1e-9);
  const falsch = geo.extentSize([9.3965767, 48.8771427, 9.3962769, 48.8773938], 48.8772683);
  near(falsch.w, mit.w, 1e-9);
  near(falsch.h, mit.h, 1e-9);
  for (const lat of [NaN, null, 'x']) { assert.ok(geo.extentSize(MARKTSTRASSE_EXTENT, lat).w > 0); }
});

test('extentSize: null ohne brauchbaren Umriss', () => {
  for (const x of [null, undefined, [], [1, 2, 3], [1, 2, 3, 4, 5], ['a', 'b', 'c', 'd'], [1, 2, 3, NaN], 'x', {}]) {
    assert.equal(geo.extentSize(x, 48.9), null, JSON.stringify(x));
  }
  assert.deepEqual(geo.extentSize([9, 48, 9, 48], 48), { w: 0, h: 0 }, 'Umriss ohne Fläche ist 0 × 0, nicht null');
});

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

test('search: genau ein Aufruf mit Photon-URL, limit 5, lang und kodierter Anfrage', async () => {
  const f = photon(fixture('photon-haus.json'));
  const hits = await geo.search({ street: 'Marktstraße 1', zip: '71364', city: 'Winnenden', lang: 'de', fetchImpl: f });

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://photon.komoot.io/api/?q=Marktstra%C3%9Fe%201%2071364%20Winnenden&limit=5&lang=de');
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('q'), 'Marktstraße 1 71364 Winnenden');
  assert.deepEqual(Array.from(u.searchParams.keys()), ['q', 'limit', 'lang'], 'sonst geht nichts an Photon');
  // ohne cache: 'no-store', damit der Browser das max-age=3600 von Photon nutzt
  assert.ok(f.calls[0].init && !('cache' in f.calls[0].init));

  assert.equal(hits.length, 5);
  assert.equal(hits[0].label, 'Marktstraße 1');
  assert.deepEqual(hits.map((h) => h.kind), ['house', 'poi', 'poi', 'poi', 'house']);
});

test('search: auch mit fertiger Anfrage als Zeichenkette (Form aus Abschnitt 5)', async () => {
  const f = photon(fixture('photon-haus.json'));
  const hits = await geo.search('Marktstraße 1 71364 Winnenden', { lang: 'fr', fetchImpl: f });
  assert.equal(hits.length, 5);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://photon.komoot.io/api/?q=Marktstra%C3%9Fe%201%2071364%20Winnenden&limit=5&lang=fr');
});

test('search: Sprache wird auf de, en, fr abgebildet, nie xx an Photon', async () => {
  for (const [lang, soll] of [['de', 'de'], ['fr', 'fr'], ['en', 'en'], ['ko', 'en'], ['pl', 'en'], [undefined, 'en'], ['xx', 'en']]) {
    const f = photon(fixture('photon-leer.json'));
    await geo.search({ city: 'Winnenden', lang, fetchImpl: f });
    assert.equal(new URL(f.calls[0].url).searchParams.get('lang'), soll, String(lang));
  }
});

test('search: Sonderzeichen in der Anfrage werden kodiert und kommen unverändert an', async () => {
  const f = photon(fixture('photon-leer.json'));
  await geo.search({ street: 'Straße & Weg #1?', zip: '', city: 'Köln=Nord', fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0].url).searchParams.get('q'), 'Straße & Weg #1? Köln=Nord');
  assert.deepEqual(Array.from(new URL(f.calls[0].url).searchParams.keys()), ['q', 'limit', 'lang']);
});

test('search: mit allen Optionen im ersten Argument und im zweiten, das zweite gewinnt', async () => {
  const f1 = photon(fixture('photon-leer.json'));
  const f2 = photon(fixture('photon-leer.json'));
  await geo.search({ city: 'Winnenden', lang: 'de', fetchImpl: f1 }, { lang: 'fr', fetchImpl: f2 });
  assert.equal(f1.calls.length, 0);
  assert.equal(f2.calls.length, 1);
  assert.equal(new URL(f2.calls[0].url).searchParams.get('lang'), 'fr');
});

test('search: 200 mit leerer Liste ergibt [] ohne Fehler', async () => {
  const f = photon(fixture('photon-leer.json'));
  assert.deepEqual(await geo.search({ street: 'Qxzvwy Gibtsnichtstraße 999', zip: '99999', city: 'Nirgendwostadt', fetchImpl: f }), []);
  assert.equal(f.calls.length, 1);
  // auch eine Antwort ohne features ist leer und kein Fehler
  const g = photon({});
  assert.deepEqual(await geo.search({ city: 'X', fetchImpl: g }), []);
});

test('search: leere Anfrage ergibt [] ohne Netzaufruf', async () => {
  const f = photon(fixture('photon-haus.json'));
  assert.deepEqual(await geo.search({ street: '', zip: ' ', city: '', fetchImpl: f }), []);
  assert.deepEqual(await geo.search('   ', { fetchImpl: f }), []);
  assert.deepEqual(await geo.search('', { fetchImpl: f }), []);
  assert.deepEqual(await geo.search({ fetchImpl: f }), []);
  assert.equal(f.calls.length, 0);
});

test('search: HTTP 400 (lang nicht unterstützt) wirft GeoError rejected, ein Aufruf', async () => {
  const f = photon({ status: 400, body: fixture('photon-400-lang.json') });
  await wirftGeoError(geo.search({ city: 'Winnenden', lang: 'de', fetchImpl: f }), 'rejected');
  assert.equal(f.calls.length, 1, 'kein automatischer Retry');
});

test('search: HTTP 429 mit leerem Body wirft GeoError rejected, ein Aufruf', async () => {
  const f = photon({ status: 429 });
  await wirftGeoError(geo.search({ street: 'Marktstraße 1', zip: '71364', city: 'Winnenden', fetchImpl: f }), 'rejected');
  assert.equal(f.calls.length, 1, 'kein automatischer Retry');
});

test('search: HTTP 429 mit Retry-After und JSON-Body bleibt rejected, ein Aufruf', async () => {
  const f = photon({ status: 429, headers: { 'Retry-After': '60' }, body: { message: 'Too many requests' } });
  await wirftGeoError(geo.search({ city: 'Winnenden', fetchImpl: f }), 'rejected');
  assert.equal(f.calls.length, 1);
});

test('search: übrige 4xx sind rejected, 5xx und Netzfehler sind offline', async () => {
  for (const status of [401, 403, 404, 414, 418]) {
    await wirftGeoError(geo.search({ city: 'X', fetchImpl: photon({ status }) }), 'rejected');
  }
  for (const status of [500, 502, 503, 504]) {
    const f = photon({ status, body: { message: 'Fehler' } });
    await wirftGeoError(geo.search({ city: 'X', fetchImpl: f }), 'offline');
    assert.equal(f.calls.length, 1, 'auch bei ' + status + ' kein zweiter Versuch');
  }
  await wirftGeoError(geo.search({ city: 'X', fetchImpl: photon({ throws: true }) }), 'offline');
  await wirftGeoError(geo.search({ city: 'X', fetchImpl: photon({ throws: new TypeError('NetworkError') }) }), 'offline');
  // eine Anfrage, auf die der Dienst nicht antwortet (fakeFetch lehnt unbekannte URLs ab)
  await wirftGeoError(geo.search({ city: 'X', fetchImpl: fakeFetch({}) }), 'offline');
});

test('search: Antwort ohne lesbares JSON (zum Beispiel eine Anmeldeseite im WLAN) ist offline', async () => {
  const f = photon({ status: 200, body: '<html><body>Bitte anmelden</body></html>' });
  await wirftGeoError(geo.search({ city: 'X', fetchImpl: f }), 'offline');
  assert.equal(f.calls.length, 1);
});

test('search: keine Antwort in der Frist ist offline, auch wenn fetchImpl das Signal ignoriert', async () => {
  let signal = null;
  const haengt = (url, init) => { signal = init && init.signal; return new Promise(() => {}); };
  await wirftGeoError(geo.search({ city: 'X', fetchImpl: haengt, timeoutMs: 30 }), 'offline');
  if (signal) { assert.equal(signal.aborted, true, 'die Anfrage wurde abgebrochen'); }
});

test('search: ohne fetchImpl und ohne globales fetch ist es offline, kein Wurf aus der Luft', async () => {
  const gemerkt = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    await wirftGeoError(geo.search({ city: 'X' }), 'offline');
  } finally {
    globalThis.fetch = gemerkt;
  }
});

test('search + rank: Marktstraße 1 in Winnenden ergibt zwei Auswahlknöpfe', async () => {
  const f = photon(fixture('photon-haus.json'));
  const hits = await geo.search({ street: 'Marktstraße 1', zip: '71364', city: 'Winnenden', lang: 'de', fetchImpl: f });
  const r = geo.rank(hits, { housenumber: '1' });
  assert.deepEqual(r.map((h) => h.label), ['Marktstraße 1', 'Marktstraße 23/1']);
  assert.deepEqual(r.map((h) => h.cc), ['DE', 'DE']);
});

// ---------------------------------------------------------------------------------------------
// elevation
// ---------------------------------------------------------------------------------------------

test('elevation: 417 m, abgefragt mit den gerundeten Koordinaten', async () => {
  const f = hoehe(fixture('elev.json'));
  assert.equal(await geo.elevation(48.8813, 9.4412, { fetchImpl: f }), 417);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.open-meteo.com/v1/elevation?latitude=48.881&longitude=9.441');
});

test('elevation: nie ungerundete Koordinaten in der URL (DoD 5)', async () => {
  const f = hoehe(fixture('elev.json'));
  await geo.elevation(48.8772683, 9.3964273, { fetchImpl: f });
  await geo.elevation(-33.8688197, 151.2092955, { fetchImpl: f });
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    const u = new URL(c.url);
    assert.match(u.searchParams.get('latitude'), /^-?\d+\.\d{1,3}$/);
    assert.match(u.searchParams.get('longitude'), /^-?\d+\.\d{1,3}$/);
  }
  assert.ok(f.calls[0].url.endsWith('latitude=48.877&longitude=9.396'));
  assert.ok(f.calls[1].url.endsWith('latitude=-33.869&longitude=151.209'));
});

test('elevation: Fehlerantwort, leere Liste und Unbrauchbares ergeben null', async () => {
  assert.equal(await geo.elevation(91, 9.4, { fetchImpl: hoehe({ status: 400, body: fixture('elev-400.json') }) }), null);
  // auch mit Status 200 gilt error: true als Fehler
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe(fixture('elev-400.json')) }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe(fixture('elev-leer.json')) }), null);
  for (const elevation of [[null], ['417'], [true], [{}], 417, null, 'x']) {
    assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe({ elevation }) }), null, JSON.stringify(elevation));
  }
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe({}) }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe({ status: 200, body: 'kein json' }) }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe({ status: 500, body: { elevation: [417] } }) }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe({ status: 429 }) }), null);
});

test('elevation: Netzfehler und Zeitüberschreitung ergeben null, nie einen Wurf', async () => {
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: hoehe({ throws: true }) }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: fakeFetch({}) }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: () => new Promise(() => {}), timeoutMs: 30 }), null);
  assert.equal(await geo.elevation(48.9, 9.4, { fetchImpl: () => { throw new Error('sofort'); } }), null);
});

test('elevation: ungültige Koordinaten ergeben null ohne Netzaufruf', async () => {
  const f = hoehe(fixture('elev.json'));
  for (const [lat, lon] of [[NaN, 9.4], [48.9, undefined], [undefined, undefined], ['x', 'y'], [Infinity, 9.4]]) {
    assert.equal(await geo.elevation(lat, lon, { fetchImpl: f }), null);
  }
  assert.equal(f.calls.length, 0);
});

test('elevation: rundet auf ganze Meter, auch unter Null und um Null', async () => {
  const mit = (e) => geo.elevation(48.9, 9.4, { fetchImpl: hoehe({ elevation: [e] }) });
  assert.equal(await mit(416.6), 417);
  assert.equal(await mit(416.4), 416);
  assert.equal(await mit(-3.4), -3);
  assert.equal(await mit(-3.6), -4);
  assert.ok(Object.is(await mit(0.2), 0));
  assert.ok(Object.is(await mit(-0.2), 0), 'kein -0');
  assert.equal(await mit(0), 0, '0 m ist eine Höhe, kein Fehlen');
});

// ---------------------------------------------------------------------------------------------
// reverse
// ---------------------------------------------------------------------------------------------

test('reverse: Photon bekommt nur die gerundete Position (Entscheidung 13)', async () => {
  const f = photonReverse(fixture('photon-haus.json'));
  const hit = await geo.reverse(48.8772683, 9.3964273, { lang: 'de', fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://photon.komoot.io/reverse?lon=9.396&lat=48.877&lang=de');
  assert.ok(!f.calls[0].url.includes('48.8772683') && !f.calls[0].url.includes('9.3964273'));
  assert.ok(!('cache' in f.calls[0].init));

  const u = new URL(f.calls[0].url);
  assert.match(u.searchParams.get('lat'), /^-?\d+\.\d{1,3}$/);
  assert.match(u.searchParams.get('lon'), /^-?\d+\.\d{1,3}$/);
  assert.deepEqual(Array.from(u.searchParams.keys()), ['lon', 'lat', 'lang']);

  // das erste Feature der Antwort, als Hit
  assert.equal(hit.label, 'Marktstraße 1');
  assert.equal(hit.kind, 'house');
  assert.equal(hit.cc, 'DE');
  assert.equal(hit.lat, 48.8772683, 'der Hit trägt die Photon-Koordinate, gerundet wird beim Speichern');
});

test('reverse: Sprache wie bei der Suche, negative Koordinaten gerundet', async () => {
  const f = photonReverse(fixture('photon-leer.json'));
  await geo.reverse(-33.8688197, 151.2092955, { lang: 'ko', fetchImpl: f });
  await geo.reverse(38.7223, -9.1393, { lang: 'fr', fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://photon.komoot.io/reverse?lon=151.209&lat=-33.869&lang=en');
  assert.equal(f.calls[1].url, 'https://photon.komoot.io/reverse?lon=-9.139&lat=38.722&lang=fr');
});

test('reverse: leeres Ergebnis ist null, kein Wurf', async () => {
  assert.equal(await geo.reverse(48.9, 9.4, { fetchImpl: photonReverse(fixture('photon-reverse-leer.json')) }), null);
  assert.equal(await geo.reverse(48.9, 9.4, { fetchImpl: photonReverse({}) }), null);
});

test('reverse: Fehler, Drosselung und Netzausfall ergeben null, nie einen Wurf', async () => {
  for (const antwort of [
    { status: 429 },
    { status: 400, body: fixture('photon-400-lang.json') },
    { status: 500 },
    { status: 200, body: 'kein json' },
    { throws: true }
  ]) {
    const f = photonReverse(antwort);
    assert.equal(await geo.reverse(48.9, 9.4, { fetchImpl: f }), null, JSON.stringify(antwort));
    assert.equal(f.calls.length, 1, 'kein zweiter Versuch');
  }
  assert.equal(await geo.reverse(48.9, 9.4, { fetchImpl: fakeFetch({}) }), null);
  assert.equal(await geo.reverse(48.9, 9.4, { fetchImpl: () => new Promise(() => {}), timeoutMs: 30 }), null);
});

test('reverse: ungültige Koordinaten ergeben null ohne Netzaufruf', async () => {
  const f = photonReverse(fixture('photon-haus.json'));
  for (const [lat, lon] of [[NaN, 9.4], [48.9, undefined], ['a', 'b'], [Infinity, -Infinity]]) {
    assert.equal(await geo.reverse(lat, lon, { fetchImpl: f }), null);
  }
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// locate
// ---------------------------------------------------------------------------------------------

test('locate: liefert die rohe Position und fragt mit den Optionen aus Abschnitt 5', async () => {
  const g = fakeGeolocation();
  const pos = await geo.locate(g);
  assert.deepEqual(pos, { lat: 48.8772683, lon: 9.3964273, acc: 20 }, 'ungerundet: gerundet wird erst später');
  assert.equal(g.calls.length, 1);
  assert.deepEqual(g.calls[0].options, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 });
});

test('locate: eigene Zeitgrenze und eigene Position', async () => {
  const g = fakeGeolocation({ lat: -33.8688197, lon: 151.2092955, acc: 1200 });
  assert.deepEqual(await geo.locate(g, { timeoutMs: 5000 }), { lat: -33.8688197, lon: 151.2092955, acc: 1200 });
  assert.equal(g.calls[0].options.timeout, 5000);
  for (const timeoutMs of [0, -1, NaN, 'x', undefined]) {
    const h = fakeGeolocation();
    await geo.locate(h, { timeoutMs });
    assert.equal(h.calls[0].options.timeout, 10000, String(timeoutMs));
  }
});

test('locate: verweigert, nicht verfügbar, Zeitüberschreitung', async () => {
  await wirftGeoError(geo.locate(fakeGeolocation('denied')), 'denied');
  await wirftGeoError(geo.locate(fakeGeolocation('unavailable')), 'unavailable');
  await wirftGeoError(geo.locate(fakeGeolocation('timeout')), 'timeout');
  await wirftGeoError(geo.locate(fakeGeolocation(1)), 'denied');
  await wirftGeoError(geo.locate(fakeGeolocation(2)), 'unavailable');
  await wirftGeoError(geo.locate(fakeGeolocation(3)), 'timeout');
});

test('locate: ein Aufruf je Anfrage, auch im Fehlerfall', async () => {
  const g = fakeGeolocation('denied');
  await wirftGeoError(geo.locate(g), 'denied');
  assert.equal(g.calls.length, 1);
});

test('locate: kein geolocation-Objekt, kaputtes Objekt, sofortiger Wurf', async () => {
  await wirftGeoError(geo.locate(undefined), 'unavailable');
  await wirftGeoError(geo.locate(null), 'unavailable');
  await wirftGeoError(geo.locate({}), 'unavailable');
  await wirftGeoError(geo.locate({ getCurrentPosition: 'nein' }), 'unavailable');
  // unsichere Seite: manche Browser werfen schon beim Aufruf
  const wirft = { getCurrentPosition() { throw new Error('Only secure origins are allowed'); } };
  await wirftGeoError(geo.locate(wirft), 'unavailable');
});

test('locate: unbekannter Fehlercode und Position ohne Koordinaten sind unavailable', async () => {
  const fehler = { getCurrentPosition(ok, err) { Promise.resolve().then(() => err({ code: 99, message: 'komisch' })); } };
  await wirftGeoError(geo.locate(fehler), 'unavailable');
  const ohneFehler = { getCurrentPosition(ok, err) { Promise.resolve().then(() => err(undefined)); } };
  await wirftGeoError(geo.locate(ohneFehler), 'unavailable');
  for (const coords of [undefined, null, {}, { latitude: '48.9', longitude: '9.4' }, { latitude: NaN, longitude: 9.4 }, { latitude: 48.9, longitude: null }]) {
    const g = { getCurrentPosition(ok) { Promise.resolve().then(() => ok({ coords })); } };
    await wirftGeoError(geo.locate(g), 'unavailable');
  }
});

test('locate: fehlende Genauigkeit ist null', async () => {
  const g = { getCurrentPosition(ok) { Promise.resolve().then(() => ok({ coords: { latitude: 48.9, longitude: 9.4 } })); } };
  assert.deepEqual(await geo.locate(g), { lat: 48.9, lon: 9.4, acc: null });
  const h = { getCurrentPosition(ok) { Promise.resolve().then(() => ok({ coords: { latitude: 0, longitude: 0, accuracy: 0 } })); } };
  assert.deepEqual(await geo.locate(h), { lat: 0, lon: 0, acc: 0 }, '0 ist eine gültige Koordinate und eine gültige Genauigkeit');
});

// ---------------------------------------------------------------------------------------------
// GeoError
// ---------------------------------------------------------------------------------------------

test('GeoError: Error mit .code und lesbarem Namen', () => {
  for (const code of ['denied', 'unavailable', 'timeout', 'offline', 'rejected']) {
    const e = new geo.GeoError(code);
    assert.ok(e instanceof Error);
    assert.ok(e instanceof geo.GeoError);
    assert.equal(e.code, code);
    assert.equal(e.name, 'GeoError');
    assert.ok(e.message.length > 0);
    assert.ok(String(e.stack).length > 0);
  }
  assert.equal(new geo.GeoError('offline', 'kein Netz').message, 'kein Netz');
});
