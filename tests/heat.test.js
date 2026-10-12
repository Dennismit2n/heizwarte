/*
 * Heizwarte — Tests für js/heat.js (reine Heizlogik) auf den Fixtures in tests/fixtures/
 *
 * heat.js rechnet auf dem Ergebnis von weather.model(); deshalb prüft der erste Block auch das Modell, das
 * die Fixtures liefern (der volle Test von weather.js folgt mit dessen Abruf-Teil). Alle Zeiten sind feste
 * Zeitpunkte (Date.UTC) und werden über weather.localNow() in Ortszeit gebracht — nichts hängt an der Zeitzone
 * des Rechners; der letzte Test beweist das, indem er die Prozess-Zeitzone wechselt.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const heat = Heizwarte.heat;
const weather = Heizwarte.weather;

const HOUR = 3600000;

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function cacheOf(name, extra) {
  return Object.assign({ v: 2, fetched: 0, om: fixture(name), mos: [], mosStation: null, alerts: null, alertsStatus: 'none' }, extra);
}

function modelOf(name, extra) {
  return weather.model(cacheOf(name, extra));
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function near(a, b, eps) {
  assert.ok(Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps), a + ' ist nicht ' + b + ' (±' + (eps === undefined ? 1e-9 : eps) + ')');
}

const PROF = {
  floorScreed: { type: 'floorScreed', leadMin: 3, leadMax: 6, comfort: 20, thresh: null, confirmed: true },
  radiator: { type: 'radiator', leadMin: 0.5, leadMax: 2, comfort: 20, thresh: null, confirmed: true },
  floorDry: { type: 'floorDry', leadMin: 1, leadMax: 3, comfort: 20, thresh: null, confirmed: true },
  heatpumpFloor: { type: 'heatpumpFloor', leadMin: 4, leadMax: 8, comfort: 20, thresh: null, confirmed: true },
  storage: { type: 'storage', leadMin: null, leadMax: null, comfort: 20, thresh: null, confirmed: true }
};

function withThresh(profile, thresh) {
  return Object.assign({}, profile, { thresh });
}

// 13.01.2026 10:00 in Berlin (UTC+1): „heute“ ist Tag 1 der konstruierten Fixtures (past_days=1)
const JAN13_MS = Date.UTC(2026, 0, 13, 9, 0);
const BERLIN = 'Europe/Berlin';
const NOW_JAN13 = weather.localNow(BERLIN, JAN13_MS);
// 09.10.2026 10:45 in Berlin (UTC+2): der Tag, an dem die Bürg-Fassung ihre Antwort geholt hat
const BUERG_NOW_MS = Date.UTC(2026, 9, 9, 8, 45);
// 14.10.2026 08:00 in Berlin: zwei Tage nach dem letzten Tag der Bürg-Antwort
const STALE_NOW_MS = Date.UTC(2026, 9, 14, 6, 0);
// 25.10.2026 10:00 in Berlin (UTC+1, nach der Umstellung)
const DST_NOW_MS = Date.UTC(2026, 9, 25, 9, 0);

function verdictOf(name, nowMs, tz, profile, alerts) {
  const m = modelOf(name);
  return heat.assess(m, weather.localNow(tz || m.tz, nowMs), profile || PROF.floorScreed, alerts || []);
}

const REASON_KEYS = ['nightMin', 'drop48', 'coldWindy', 'frost', 'gtRise', 'alert', 'calmNights', 'noJumps', 'tooOld'];

// Die drei „Heute“-Nächte nach Bürg-Art, direkt aus den Rohdaten gerechnet (ohne Intl, mit dem festen Offset):
// Nacht k = 18:00 am Tag k bis 09:00 am Tag k+1 → Sekunden ab Ortsmitternacht von Tag k
function rohNachtMin(om, k) {
  const t0 = om.daily.time[k] + 18 * 3600;
  const t1 = om.daily.time[k] + 33 * 3600;
  let min = Infinity;
  om.hourly.time.forEach((t, i) => {
    const v = om.hourly.temperature_2m[i];
    if (t >= t0 && t <= t1 && v !== null && v < min) { min = v; }
  });
  return min;
}

function alleZahlenEndlich(x, pfad, fehler) {
  if (typeof x === 'number') {
    if (!isFinite(x)) { fehler.push(pfad + ' = ' + x); }
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => alleZahlenEndlich(v, pfad + '[' + i + ']', fehler));
  } else if (x && typeof x === 'object') {
    Object.keys(x).forEach((k) => alleZahlenEndlich(x[k], pfad + '.' + k, fehler));
  }
  return fehler;
}

// ---------------------------------------------------------------------------------------------
// Aufbau, Konstanten
// ---------------------------------------------------------------------------------------------

test('heat.js: Schnittstelle aus Abschnitt 5 und globaler Name', () => {
  for (const name of ['thresholds', 'degreeDay', 'night', 'lead', 'alertMatches', 'assess', 'plan', 'airSlots', 'isDue']) {
    assert.equal(typeof heat[name], 'function', name);
  }
  for (const name of ['THRESH', 'DEFAULT_THRESH', 'PROFILES', 'ALERT_RX_DE', 'ALERT_RX_EN', 'SEVERE_RX']) {
    assert.ok(heat[name], name);
  }
  assert.equal(globalThis.Heizwarte.heat, heat);
  assert.equal(require('../js/heat.js'), heat);
});

test('heat.js: kein Date, kein Intl, kein DOM, kein Speicher, kein Netz im Code', () => {
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'js', 'heat.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const verboten of ['Date', 'Intl', 'document', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest',
    'navigator', 'setTimeout', 'Math.random', 'innerHTML', 'console', 'I18N', 'require']) {
    assert.ok(!new RegExp('\\b' + verboten.replace('.', '\\.') + '\\b').test(quelle), verboten + ' kommt im Code vor');
  }
});

test('THRESH, DEFAULT_THRESH, PROFILES: die Zahlen aus Abschnitt 5 und 7', () => {
  const T = heat.THRESH;
  assert.deepEqual([T.nightFrom, T.nightTo, T.nightMinHours], [18, 9, 10]);
  assert.deepEqual([T.warnMinN, T.warnDrop48, T.coldMin, T.coldWind, T.coldSun], [5, -4, 8, 20, 2]);
  assert.deepEqual([T.alarmMinN, T.alarmDrop48, T.alarmGtRise, T.critMinN], [0, -6, 5, -5]);
  assert.deepEqual([T.gustLead, T.gustLeadAdd, T.needKnee, T.needSpan], [40, 0.5, 12, 12]);
  assert.deepEqual([T.heatBase, T.heatLimit], [20, 15]);
  assert.deepEqual([T.mosDisagree, T.optionalFrom, T.strongUp, T.strongNormal], [2, 9, 5, 9]);
  assert.equal(T.staleHours, 26);
  assert.deepEqual([T.rhIndoor, T.magnusA, T.magnusB, T.airMargin], [55, 17.62, 243.12, 2]);
  assert.deepEqual([T.airFrom, T.airTo, T.airSlots], [7, 22, 4]);

  assert.deepEqual(Object.keys(heat.DEFAULT_THRESH).sort(),
    ['alarmDrop48', 'alarmGtRise', 'alarmMinN', 'coldWind', 'critMinN', 'gustLead', 'warnDrop48', 'warnMinN']);
  for (const k of Object.keys(heat.DEFAULT_THRESH)) { assert.equal(heat.DEFAULT_THRESH[k], T[k], k); }

  const P = heat.PROFILES;
  assert.deepEqual(Object.keys(P), ['radiator', 'floorScreed', 'floorDry', 'heatpumpFloor', 'storage']);
  assert.deepEqual([P.radiator.leadMin, P.radiator.leadMax], [0.5, 2]);
  assert.deepEqual([P.floorScreed.leadMin, P.floorScreed.leadMax], [3, 6]);
  assert.deepEqual([P.floorDry.leadMin, P.floorDry.leadMax], [1, 3]);
  assert.deepEqual([P.heatpumpFloor.leadMin, P.heatpumpFloor.leadMax], [4, 8]);
  assert.deepEqual([P.storage.leadMin, P.storage.leadMax], [null, null]);

  assert.throws(() => { 'use strict'; T.warnMinN = 99; }, TypeError, 'THRESH ist eingefroren');
});

// ---------------------------------------------------------------------------------------------
// Modell aus den Fixtures (Voraussetzung für alles Weitere)
// ---------------------------------------------------------------------------------------------

test('Modell om-buerg-2026-10-09: 120 Stunden, 5 Tage, Tageswerte über daily zugeordnet', () => {
  const m = modelOf('om-buerg-2026-10-09.json');
  assert.equal(m.tz, 'Europe/Berlin');
  assert.equal(m.hours.length, 120);
  assert.equal(m.days.length, 5);
  assert.equal(m.gaps, 0);
  assert.deepEqual(m.days.map((d) => d.key), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  assert.deepEqual(m.days.map((d) => d.idx), [0, 1, 2, 3, 4]);
  assert.deepEqual(Object.keys(m).sort(), ['current', 'days', 'fetched', 'gaps', 'hours', 'mosStation', 'tz']);
  assert.deepEqual(Object.keys(m.hours[0]).sort(),
    ['app', 'cc', 'code', 'dayIdx', 'dew', 'gust', 'h', 'isDay', 'mos', 'ms', 'pp', 'pr', 'rh', 'sw', 'temp', 'wind']);
  assert.deepEqual(Object.keys(m.days[0]).sort(),
    ['code', 'gt', 'gust', 'idx', 'key', 'max', 'mean', 'min', 'rain', 'sun', 'sunriseMs', 'sunsetMs']);

  // erste Stunde: 08.10.2026 00:00 in Berlin = 07.10. 22:00 UTC
  assert.equal(m.hours[0].ms, Date.UTC(2026, 9, 7, 22, 0));
  assert.equal(m.hours[0].h, 0);
  assert.equal(m.hours[0].dayIdx, 0);
  assert.equal(m.hours[119].h, 23);
  assert.equal(m.hours[119].dayIdx, 4);
  m.hours.forEach((o, i) => { if (i) { assert.equal(o.ms - m.hours[i - 1].ms, HOUR); } });

  // Tageswerte stehen am richtigen Tag (Daten der echten Antwort vom 09.10.2026)
  const d1 = m.days[1];
  assert.equal(d1.max, 11.1);
  assert.equal(d1.min, 2.9);
  near(d1.sun, 10496.51 / 3600);
  assert.equal(d1.code, 61);
  assert.equal(d1.rain, 2.5);
  assert.equal(d1.gust, 27.4);
  assert.equal(d1.sunriseMs, Date.UTC(2026, 9, 9, 5, 33));
  assert.equal(d1.sunsetMs, Date.UTC(2026, 9, 9, 16, 44));

  // Tagesmittel = Mittel aller Stundenwerte, Gradtagzahl über degreeDay
  const t1 = m.hours.filter((o) => o.dayIdx === 1).map((o) => o.temp);
  assert.equal(t1.length, 24);
  near(d1.mean, t1.reduce((a, b) => a + b, 0) / 24);
  near(d1.gt, 20 - d1.mean);

  assert.equal(m.current.temp, 8.6);
  assert.equal(m.current.isDay, true);
});

test('Modell: MOSMIX wird über ms verbunden, mosStation und fetched kommen aus dem Cache', () => {
  const om = fixture('om-mild.json');
  const t = om.hourly.time;
  const mos = [[t[30] * 1000, 7.5], [t[31] * 1000, null], [(t[32] + 1800) * 1000, 3]];   // letzte liegt neben dem Raster
  const station = { name: 'BACKNANG', height: 291, distance: 7692 };
  const m = weather.model({ v: 2, fetched: 12345, om, mos, mosStation: station, alerts: null, alertsStatus: 'none' });
  assert.equal(m.hours[30].mos, 7.5);
  assert.equal(m.hours[31].mos, null);
  assert.equal(m.hours[32].mos, null);
  assert.equal(m.hours.filter((o) => o.mos !== null).length, 1);
  assert.deepEqual(m.mosStation, station);
  assert.equal(m.fetched, 12345);
});

test('Modell om-null: Stunden ohne Temperatur fallen weg, gaps zählt, kein NaN', () => {
  const m = modelOf('om-null.json');
  assert.equal(m.hours.length, 115);
  assert.equal(m.gaps, 5);
  assert.deepEqual(alleZahlenEndlich(m.days, 'days', []), []);
  for (const d of m.days) { assert.ok(Number.isFinite(d.mean) && Number.isFinite(d.gt), d.key); }
  // am Tag 2 fehlen 03, 04 und 05 Uhr
  const h2 = m.hours.filter((o) => o.dayIdx === 2).map((o) => o.h);
  assert.equal(h2.length, 21);
  assert.ok(!h2.includes(3) && !h2.includes(4) && !h2.includes(5));
  // fehlende Windwerte bleiben null, die Stunde selbst bleibt
  assert.equal(m.hours.filter((o) => o.wind === null).length, 1);
  assert.equal(m.hours.filter((o) => o.gust === null).length, 1);
});

test('Modell: unbekannte Zone fällt auf den festen Offset zurück, kein Wurf', () => {
  const om = fixture('om-mild.json');
  om.timezone = 'Mars/Olympus';
  om.utc_offset_seconds = 3600;
  const m = weather.model({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
  assert.equal(m.tz, 'Etc/GMT-1');
  assert.equal(m.hours[0].h, 0);
  assert.equal(m.days[0].key, '2026-01-12');
  assert.equal(weather.tzSafe('Mars/Olympus', 7200), 'Etc/GMT-2');
  assert.equal(weather.tzSafe('Mars/Olympus', 19800), 'UTC');
  assert.equal(weather.tzSafe('Mars/Olympus', 0), 'UTC');
  assert.equal(weather.tzSafe('Europe/Lisbon', 7200), 'Europe/Lisbon');
});

test('localNow: eine Laufzeit, die Mitternacht als Stunde 24 meldet, ergibt Stunde 0', () => {
  const echt = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function () {
    return {
      formatToParts: () => [
        { type: 'year', value: '2026' }, { type: 'literal', value: '-' }, { type: 'month', value: '01' },
        { type: 'day', value: '14' }, { type: 'hour', value: '24' }, { type: 'minute', value: '05' }
      ]
    };
  };
  try {
    // eine Zone, die in diesem Prozess noch nie benutzt wurde, damit kein echter Formatierer im Zwischenspeicher liegt
    assert.deepEqual(weather.localNow('Etc/GMT-9', 1000), { key: '2026-01-14', h: 0, min: 5, ms: 1000 });
  } finally {
    Intl.DateTimeFormat = echt;
  }
  assert.deepEqual(weather.localNow('Etc/GMT-9', Date.UTC(2026, 0, 13, 15, 5)), { key: '2026-01-14', h: 0, min: 5, ms: Date.UTC(2026, 0, 13, 15, 5) });
});

test('Modell: leere oder kaputte Antwort wirft nicht, assess meldet tooOld', () => {
  for (const om of [{}, { hourly: {} }, { hourly: { time: [] } }, { hourly: { time: [1], temperature_2m: [null] } }]) {
    const m = weather.model({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
    assert.equal(m.days.length, 0);
    const v = heat.assess(m, NOW_JAN13, PROF.floorScreed, []);
    assert.equal(v.level, null);
    assert.deepEqual(v.reasons, [{ key: 'tooOld' }]);
  }
});

// ---------------------------------------------------------------------------------------------
// thresholds, degreeDay, dewPoint, lead
// ---------------------------------------------------------------------------------------------

test('thresholds: Standardwerte, ein Teilobjekt ändert nur seine Schwelle', () => {
  assert.deepEqual(heat.thresholds(PROF.floorScreed), heat.DEFAULT_THRESH);
  assert.deepEqual(heat.thresholds({}), heat.DEFAULT_THRESH);
  assert.deepEqual(heat.thresholds(null), heat.DEFAULT_THRESH);

  const t = heat.thresholds(withThresh(PROF.floorScreed, { warnMinN: 8 }));
  assert.equal(t.warnMinN, 8);
  for (const k of Object.keys(heat.DEFAULT_THRESH)) {
    if (k !== 'warnMinN') { assert.equal(t[k], heat.DEFAULT_THRESH[k], k); }
  }
  // das Ergebnis ist eine Kopie: Änderungen daran treffen die Standardwerte nicht
  t.warnMinN = 99;
  assert.equal(heat.DEFAULT_THRESH.warnMinN, 5);
  assert.equal(heat.thresholds(PROF.floorScreed).warnMinN, 5);
});

test('thresholds: nur bekannte Schwellen mit Zahlenwert zählen; ein ganzer Ort wird verstanden', () => {
  const t = heat.thresholds(withThresh(PROF.floorScreed, { warnMinN: null, critMinN: '7', coldWind: NaN, foo: 1, gustLead: 35 }));
  assert.equal(t.warnMinN, 5);
  assert.equal(t.critMinN, -5);
  assert.equal(t.coldWind, 20);
  assert.equal(t.gustLead, 35);
  assert.ok(!('foo' in t));
  const ort = { id: 'a1b2c3d4', label: 'Mama', heat: withThresh(PROF.radiator, { alarmMinN: 1 }) };
  assert.equal(heat.thresholds(ort).alarmMinN, 1);
});

test('degreeDay: 20 °C minus Tagesmittel unter 15 °C, sonst 0, null und NaN ergeben 0', () => {
  near(heat.degreeDay(5), 15);
  near(heat.degreeDay(-3.5), 23.5);
  near(heat.degreeDay(14.9), 5.1);
  assert.equal(heat.degreeDay(15), 0);
  assert.equal(heat.degreeDay(22), 0);
  assert.equal(heat.degreeDay(null), 0);
  assert.equal(heat.degreeDay(undefined), 0);
  assert.equal(heat.degreeDay(NaN), 0);
});

test('Gradtagzahl im Modell: 20 minus Mittel an kalten Tagen, 0 an warmen', () => {
  const kalt = modelOf('om-frost.json');
  for (const d of kalt.days) { near(d.gt, 20 - d.mean); assert.ok(d.mean < 15); }
  const warm = clone(kalt);
  warm.days.forEach((d) => { d.mean = 16; });
  assert.equal(heat.degreeDay(warm.days[0].mean), 0);
});

test('dewPoint: Magnus-Formel, 20 °C bei 55 % ergibt etwa 10,7 °C', () => {
  near(heat.dewPoint(20, 55), 10.68, 0.01);
  near(heat.dewPoint(20, 100), 20, 1e-9);
  assert.ok(heat.dewPoint(5, 60) < 5);
});

test('lead: die Formel mit Knie bei 12 K, Böenzuschlag und Grenzen', () => {
  const fs3 = PROF.floorScreed;
  assert.equal(heat.lead(fs3, 8, 20), 3, 'Nacht 8 °C: need 12 → leadMin');
  assert.equal(heat.lead(fs3, 15, 20), 3, 'milder als das Knie bleibt bei leadMin');
  assert.equal(heat.lead(fs3, -4, 20), 6, 'Nacht −4 °C: need 24 → leadMax (KB §5)');
  near(heat.lead(fs3, 2, 20), 4.5, 1e-12);
  near(heat.lead(fs3, 3, 20), 3 + 5 / 12 * 3, 1e-12);
  assert.equal(heat.lead(fs3, 8, 40), 3, 'genau 40 km/h zählt noch nicht');
  assert.equal(heat.lead(fs3, 8, 40.1), 3.5);
  near(heat.lead(fs3, 3, 55), 3 + 5 / 12 * 3 + 0.5, 1e-12);
  assert.equal(heat.lead(fs3, -10, 55), 6, 'nie über leadMax');
  assert.equal(heat.lead(fs3, 8, null), 3, 'Böen unbekannt: kein Zuschlag');

  assert.equal(heat.lead(PROF.radiator, -4, 20), 2);
  assert.equal(heat.lead(PROF.radiator, 12, 20), 0.5);
  assert.equal(heat.lead(PROF.floorDry, -4, 20), 3);
  assert.equal(heat.lead(PROF.floorDry, 12, 20), 1);
  assert.equal(heat.lead(PROF.heatpumpFloor, -4, 20), 8);
  assert.equal(heat.lead(PROF.heatpumpFloor, 12, 20), 4);
  assert.equal(heat.lead(PROF.storage, -4, 60), 0, 'Nachtspeicher heizt nicht vor');
});

test('lead: Wunschtemperatur, eigene Grenzen, fehlende Werte und die Schwelle gustLead', () => {
  near(heat.lead(Object.assign({}, PROF.floorScreed, { comfort: 22 }), 8, 20), 3 + 2 / 12 * 3, 1e-12);
  near(heat.lead(Object.assign({}, PROF.floorScreed, { comfort: 18 }), 6, 20), 3, 1e-12);
  // eigene Grenzen
  assert.equal(heat.lead(Object.assign({}, PROF.floorScreed, { leadMin: 2, leadMax: 4 }), -4, 20), 4);
  assert.equal(heat.lead(Object.assign({}, PROF.floorScreed, { leadMin: 2, leadMax: 4 }), 10, 20), 2);
  // Grenzen fehlen: Tabelle der Heizart, bei unbekannter Heizart die Estrich-Werte
  assert.equal(heat.lead({ type: 'radiator' }, -4, 20), 2);
  assert.equal(heat.lead({}, -4, 20), 6);
  assert.equal(heat.lead(undefined, 8, 20), 3);
  // einstellbare Böenschwelle
  assert.equal(heat.lead(withThresh(PROF.floorScreed, { gustLead: 30 }), 8, 35), 3.5);
  assert.equal(heat.lead(withThresh(PROF.floorScreed, { gustLead: 60 }), 8, 55), 3);
});

// ---------------------------------------------------------------------------------------------
// alertMatches
// ---------------------------------------------------------------------------------------------

test('alertMatches: leere Eingaben und null', () => {
  for (const x of [[], null, undefined, 'x', {}, [null, undefined, 3]]) {
    assert.deepEqual(heat.alertMatches(x), { level: 0, hits: [] });
  }
});

test('alertMatches: echte DWD-Warnungen vom 10.10.2026 (17 Stück, 7 × expires null)', () => {
  const alle = fixture('alerts-dwd-2026-10-10.json').alerts;
  assert.equal(alle.length, 17);
  assert.equal(alle.filter((a) => a.expires === null).length, 7);
  assert.equal(alle.filter((a) => a.instruction_de === null).length, 7);

  const r = heat.alertMatches(alle);
  assert.equal(r.level, 2, 'keine severe/extreme-Warnung darunter');
  assert.equal(r.hits.length, 16, 'alle außer DAUERREGEN');
  assert.ok(!r.hits.some((a) => a.event_de === 'DAUERREGEN'));

  const sturm = alle.find((a) => a.event_de === 'SCHWERE STURMBÖEN');
  assert.deepEqual(heat.alertMatches([sturm]), { level: 2, hits: [sturm] });

  // STARKWIND mit expires null: Stufe 2 ohne Wurf
  const stark = alle.find((a) => a.event_de === 'STARKWIND' && a.expires === null);
  assert.ok(stark);
  assert.deepEqual(heat.alertMatches([stark]), { level: 2, hits: [stark] });
  // DAUERREGEN trifft nicht
  const regen = alle.find((a) => a.event_de === 'DAUERREGEN');
  assert.deepEqual(heat.alertMatches([regen]), { level: 0, hits: [] });
});

test('alertMatches: englischer Name allein genügt, die deutsche Liste kennt BÖEN nicht', () => {
  const alle = fixture('alerts-dwd-2026-10-10.json').alerts;
  const boeen = alle.find((a) => a.event_de === 'BÖEN');
  assert.ok(boeen);
  assert.ok(!heat.ALERT_RX_DE.test(boeen.event_de), 'BÖEN allein trifft die deutsche Liste nicht');
  assert.ok(heat.ALERT_RX_EN.test(boeen.event_en), 'near gale trifft die englische');
  assert.equal(heat.alertMatches([boeen]).hits.length, 1);

  assert.equal(heat.alertMatches([{ event_de: null, event_en: 'gale-force gusts', severity: 'minor' }]).level, 2);
  assert.equal(heat.alertMatches([{ event_de: 'GLATTEIS', event_en: null, severity: 'minor' }]).level, 2);
  assert.equal(heat.alertMatches([{ event_de: 'Frost', event_en: '', severity: null }]).level, 2);
  assert.equal(heat.alertMatches([{ event_de: 'HITZE', event_en: 'heat', severity: 'severe' }]).level, 0);
});

test('alertMatches: Felder null oder fehlend werfen nicht', () => {
  const ohne = [
    { event_de: null, event_en: null, severity: null, expires: null },
    { severity: 'extreme' },
    {},
    { event_de: undefined, event_en: undefined }
  ];
  assert.deepEqual(heat.alertMatches(ohne), { level: 0, hits: [] });
  // trifft, aber ohne Schwere: Stufe 2
  assert.equal(heat.alertMatches([{ event_de: 'STURM', severity: null }]).level, 2);
});

test('alertMatches: severe und extreme heben auf Stufe 3, moderate nicht', () => {
  const sturm = fixture('alerts-sturm.json').alerts[0];
  assert.equal(sturm.event_de, 'SCHWERE STURMBÖEN');
  assert.equal(sturm.severity, 'moderate');
  assert.equal(heat.alertMatches([sturm]).level, 2);
  for (const s of ['severe', 'extreme']) {
    assert.equal(heat.alertMatches([Object.assign({}, sturm, { severity: s })]).level, 3, s);
  }
  // eine schwere Warnung neben leichten genügt
  const leicht = Object.assign({}, sturm, { severity: 'minor', event_de: 'WINDBÖEN' });
  assert.equal(heat.alertMatches([leicht, Object.assign({}, sturm, { severity: 'severe' })]).level, 3);
  // eine schwere Warnung, die gar nicht trifft, zählt nicht
  const regen = Object.assign({}, sturm, { event_de: 'STARKREGEN', event_en: 'heavy rain', severity: 'extreme' });
  assert.deepEqual(heat.alertMatches([leicht, regen]).hits, [leicht]);
  assert.equal(heat.alertMatches([leicht, regen]).level, 2);
});

// ---------------------------------------------------------------------------------------------
// night
// ---------------------------------------------------------------------------------------------

test('night: Ortsstunden 18 bis 9, 16 Werte, Tiefstwert, Ende, Wind, Böen', () => {
  const m = modelOf('om-sturm.json');
  const n = heat.night(m.hours, 1);
  assert.deepEqual(Object.keys(n).sort(), ['atH', 'atMs', 'dayIdx', 'gust', 'hs', 'min', 'mosMin', 'toMs', 'wind']);
  assert.equal(n.dayIdx, 1);
  assert.equal(n.hs.length, 16);
  assert.deepEqual(n.hs.map((o) => o.h), [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(n.hs.map((o) => o.dayIdx), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(n.min, 3);
  assert.ok(n.hs.every((o) => o.temp >= n.min));
  assert.equal(n.toMs, n.hs[15].ms);
  assert.equal(n.toMs, Date.UTC(2026, 0, 14, 8, 0), '14.01. 09:00 in Berlin');
  assert.equal(n.atMs, n.hs.find((o) => o.temp === n.min).ms);
  assert.equal(weather.localNow(BERLIN, n.atMs).h, n.atH);
  assert.equal(n.wind, 30);
  assert.equal(n.gust, 55);
  assert.equal(n.mosMin, null);
});

test('night: zu wenige Stunden ergeben null; die letzten Tage der Antwort haben keine volle Nacht', () => {
  const m = modelOf('om-mild.json');
  assert.ok(heat.night(m.hours, 3));
  assert.equal(heat.night(m.hours, 4), null, 'nur 18 bis 23 Uhr des letzten Tages, 6 Werte');
  assert.equal(heat.night(m.hours, 9), null);
  assert.equal(heat.night([], 0), null);
  assert.equal(heat.night(undefined, 0), null);
});

test('night: der erste Tiefstwert gewinnt, mosMin ist das kleinste MOSMIX-Minimum', () => {
  const m = modelOf('om-frost.json');
  const base = heat.night(m.hours, 1);
  // gleicher Tiefstwert noch einmal später: der frühere bleibt
  const doppelt = clone(m.hours);
  const spaeter = doppelt.find((o) => o.dayIdx === 2 && o.h === 8);
  spaeter.temp = base.min;
  const n2 = heat.night(doppelt, 1);
  assert.equal(n2.min, base.min);
  assert.equal(n2.atMs, base.atMs);

  const mit = clone(m.hours);
  mit.find((o) => o.dayIdx === 1 && o.h === 22).mos = 1.5;
  mit.find((o) => o.dayIdx === 2 && o.h === 4).mos = -0.5;
  mit.find((o) => o.dayIdx === 2 && o.h === 5).mos = null;
  assert.equal(heat.night(mit, 1).mosMin, -0.5);
});

test('night: Lücken (null in der Temperatur) zählen nicht, auch nicht im Rohlauf', () => {
  const m = modelOf('om-null.json');
  const n = heat.night(m.hours, 1);
  assert.equal(n.hs.length, 12, '16 minus 20 Uhr minus 03, 04, 05 Uhr');
  // Tiefstwert unabhängig aus den Rohdaten (ohne Intl, mit festem Offset)
  assert.equal(n.min, rohNachtMin(fixture('om-null.json'), 1));
  assert.equal(n.min, -0.9);
  assert.equal(n.atH, 6);
  // hs enthält nur Stunden mit Temperatur
  assert.ok(n.hs.every((o) => Number.isFinite(o.temp)));
  // ein Rohlauf mit einem null in den Stunden (wie von Hand gebaut) wird ebenfalls übersprungen
  const hand = clone(modelOf('om-mild.json').hours);
  hand[30].temp = null;
  hand[31].temp = undefined;
  const nh = heat.night(hand, 1);
  assert.ok(nh.hs.every((o) => Number.isFinite(o.temp)));
  // Wind und Böen ignorieren null
  assert.equal(n.wind, 12);
  assert.equal(n.gust, 25);
});

// ---------------------------------------------------------------------------------------------
// Zeitzone und Uhrumstellung
// ---------------------------------------------------------------------------------------------

test('om-lissabon: Ortsstunden von Europe/Lisbon, Nachtfenster 18–9, anders als in Berlin', () => {
  const m = modelOf('om-lissabon.json');
  assert.equal(m.tz, 'Europe/Lisbon');
  assert.equal(m.hours.length, 120);
  assert.equal(m.hours[0].ms, Date.UTC(2026, 0, 12, 0, 0));
  assert.equal(m.hours[0].h, 0);
  assert.equal(m.days[0].key, '2026-01-12');
  const n = heat.night(m.hours, 1);
  assert.deepEqual(n.hs.map((o) => o.h), [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(n.hs[0].ms, Date.UTC(2026, 0, 13, 18, 0), '18 Uhr in Lissabon = 18 Uhr UTC im Januar');

  // dieselben Zeitpunkte in Berlin gedeutet: eine Ortsstunde später
  const om = fixture('om-lissabon.json');
  om.timezone = BERLIN;
  om.utc_offset_seconds = 3600;
  const alsBerlin = weather.model({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
  assert.equal(alsBerlin.hours[0].ms, m.hours[0].ms);
  assert.equal(alsBerlin.hours[0].h, 1);

  // „jetzt“ um 23:30 UTC liegt in Lissabon am 13.01., in Berlin schon am 14.01.
  const spaet = Date.UTC(2026, 0, 13, 23, 30);
  assert.deepEqual(weather.localNow('Europe/Lisbon', spaet), { key: '2026-01-13', h: 23, min: 30, ms: spaet });
  assert.deepEqual(weather.localNow(BERLIN, spaet), { key: '2026-01-14', h: 0, min: 30, ms: spaet });
  const v = heat.assess(m, weather.localNow('Europe/Lisbon', spaet), PROF.floorScreed, []);
  assert.equal(v.D[0].key, '2026-01-13');
  assert.equal(v.nights[0].dayIdx, 1);
  const vb = heat.assess(m, weather.localNow(BERLIN, spaet), PROF.floorScreed, []);
  assert.equal(vb.D[0].key, '2026-01-14', 'mit der falschen Zone wanderte „jetzt“ um einen Tag');
});

test('om-dst: 25.10.2026 hat 25 Stunden, Stunde 2 kommt zweimal, die Nacht davor hat 17 Werte', () => {
  const m = modelOf('om-dst.json');
  assert.equal(m.tz, 'Europe/Berlin');
  assert.equal(m.hours.length, 121);
  assert.equal(m.days.length, 5, 'kein doppelter Tag');
  assert.deepEqual(m.days.map((d) => d.key), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  const tag = m.hours.filter((o) => o.dayIdx === 1);
  assert.equal(tag.length, 25);
  assert.deepEqual(tag.map((o) => o.h), [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  assert.deepEqual(m.days.map((d) => m.hours.filter((o) => o.dayIdx === d.idx).length), [24, 25, 24, 24, 24]);
  // die Zeitpunkte sind eindeutig und lückenlos stündlich (unixtime)
  m.hours.forEach((o, i) => { if (i) { assert.equal(o.ms - m.hours[i - 1].ms, HOUR, 'Stunde ' + i); } });
  // 02:00 CEST und 02:00 CET liegen eine Stunde auseinander
  const zwei = tag.filter((o) => o.h === 2);
  assert.equal(zwei[0].ms, Date.UTC(2026, 9, 25, 0, 0));
  assert.equal(zwei[1].ms, Date.UTC(2026, 9, 25, 1, 0));
  // Tagesmittel mit 25 Werten
  near(m.days[1].mean, tag.reduce((s, o) => s + o.temp, 0) / 25);
  // Tageswerte aus daily (fester Offset 7200 für die ganze Antwort) landen trotzdem am richtigen Tag
  assert.ok(m.days.every((d) => d.max !== null && d.min !== null && d.sunriseMs !== null), 'jeder Tag hat seine daily-Werte');
  assert.deepEqual(m.days.map((d) => d.max), fixture('om-dst.json').daily.temperature_2m_max);

  const n = heat.night(m.hours, 0);
  assert.equal(n.hs.length, 17);
  assert.deepEqual(n.hs.map((o) => o.h), [18, 19, 20, 21, 22, 23, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(heat.night(m.hours, 1).hs.length, 16, 'die Nacht danach ist wieder normal');
  assert.equal(heat.night(m.hours, 2).hs.length, 16);
  const nachts = [0, 1, 2, 3].map((k) => heat.night(m.hours, k)).filter(Boolean);
  assert.equal(nachts.filter((x) => x.hs.length === 17).length, 1, 'genau eine Nacht mit 17 Werten');
});

test('om-dst: kein Versatz der Startzeiten, die Vorgängernacht mit 17 Werten geht in dN ein', () => {
  const m = modelOf('om-dst.json');
  const now = weather.localNow(m.tz, DST_NOW_MS);
  assert.deepEqual([now.key, now.h], ['2026-10-25', 10]);
  const v = heat.assess(m, now, PROF.floorScreed, []);
  assert.equal(v.level, 1);
  assert.equal(v.nights[0].hs.length, 16);
  const vorher = heat.night(m.hours, 0);
  near(v.plan[0].dN, v.nights[0].min - vorher.min);

  for (const e of v.plan) {
    assert.equal(e.startMs % HOUR, 0, 'volle Stunde');
    assert.equal(e.onsetMs - e.startMs, Math.ceil(e.lead) * HOUR);
    assert.equal(e.onsetMs % HOUR, 0);
    // beide liegen am selben Ortstag, die Ortsstunde passt zur Aufheizzeit
    const s = weather.localNow(m.tz, e.startMs);
    const o = weather.localNow(m.tz, e.onsetMs);
    assert.equal(s.key, o.key);
    assert.equal(o.h - s.h, Math.ceil(e.lead));
  }
  // Auch ein Fahrplan, der vor der Umstellung beginnt: Nacht des 24.10.
  const vorUm = heat.assess(m, weather.localNow(m.tz, Date.UTC(2026, 9, 24, 10, 0)), PROF.floorScreed, []);
  assert.equal(vorUm.nights[0].hs.length, 17);
  assert.equal(vorUm.plan[0].startMs % HOUR, 0);
  assert.equal(vorUm.plan[0].onsetMs - vorUm.plan[0].startMs, Math.ceil(vorUm.plan[0].lead) * HOUR);
});

// ---------------------------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------------------------

test('assess om-buerg-2026-10-09: ruhige Nacht, Stufe 0, Fahrplan mit 3 h und „sparsam“', () => {
  const v = verdictOf('om-buerg-2026-10-09.json', BUERG_NOW_MS, null, PROF.floorScreed, []);
  assert.deepEqual(Object.keys(v), ['level', 'reasons', 'D', 'prev', 'nights', 'plan', 'al']);
  assert.equal(v.level, 0);
  // Nächte 09./10., 10./11., 11./12.10.: unabhängig aus den Rohdaten gerechnet
  const om = fixture('om-buerg-2026-10-09.json');
  assert.deepEqual(v.nights.map((n) => n.min), [rohNachtMin(om, 1), rohNachtMin(om, 2), rohNachtMin(om, 3)]);
  assert.deepEqual(v.nights.map((n) => n.min), [9.1, 8.5, 5.1]);
  assert.deepEqual(v.reasons, [{ key: 'calmNights', n: 8 }, { key: 'noJumps' }]);
  assert.deepEqual(v.D.map((d) => d.key), ['2026-10-09', '2026-10-10', '2026-10-11']);
  assert.equal(v.prev.key, '2026-10-08');
  assert.deepEqual(v.al, []);

  assert.equal(v.plan.length, 3);
  assert.equal(v.plan[0].lead, 3);
  assert.equal(v.plan[0].strength, 'low');
  assert.equal(v.plan[0].optional, true);
  assert.equal(v.plan[0].charge, null);
  assert.equal(v.plan[1].strength, 'normal');
  assert.equal(v.plan[2].strength, 'normal');
  assert.equal(v.plan[0].dayIdx, 1);
  assert.equal(v.plan[0].startMs % HOUR, 0);
  // Abkühlung beginnt am Nachmittag/Abend, nicht am nächsten Tag
  const onset = weather.localNow('Europe/Berlin', v.plan[0].onsetMs);
  assert.equal(onset.key, '2026-10-09');
  assert.ok(onset.h >= 11 && onset.h <= 23);
});

test('assess om-mild: Stufe 0, optional, „sparsam“, die Gradtagzahl ist ruhig', () => {
  const v = verdictOf('om-mild.json', JAN13_MS, BERLIN);
  assert.equal(v.level, 0);
  assert.deepEqual(v.reasons, [{ key: 'calmNights', n: 9 }, { key: 'noJumps' }]);
  assert.deepEqual(v.nights.map((n) => n.min), [9.5, 10.5, 10]);
  assert.equal(v.plan[0].optional, true);
  assert.equal(v.plan[0].strength, 'low');
  assert.equal(v.plan[0].lead, 3);
  assert.equal(v.plan[0].gusty, false);
  assert.equal(v.plan[0].disagree, false);
  near(v.plan[0].dN, -0.5, 1e-9);
});

test('thresholds-Mischung: om-mild mit warnMinN 12 wird Stufe 1 (nightMin), die anderen Schwellen bleiben', () => {
  const standard = verdictOf('om-mild.json', JAN13_MS, BERLIN, PROF.floorScreed);
  const scharf = verdictOf('om-mild.json', JAN13_MS, BERLIN, withThresh(PROF.floorScreed, { warnMinN: 12 }));
  assert.equal(standard.level, 0);
  assert.equal(scharf.level, 1);
  assert.deepEqual(scharf.reasons, [{ key: 'nightMin', n: 9.5 }]);

  // Teilobjekt { warnMinN: 8 } lässt om-frost bei Stufe 2: die sieben anderen Schwellen bleiben Standard
  const frost = verdictOf('om-frost.json', JAN13_MS, BERLIN, withThresh(PROF.floorScreed, { warnMinN: 8 }));
  assert.equal(frost.level, 2);
  assert.deepEqual(frost.reasons.map((r) => r.key), ['nightMin', 'frost']);
});

test('jede einstellbare Schwelle wirkt an ihrer Regel', () => {
  const lvl = (name, thresh, profile) => verdictOf(name, JAN13_MS, BERLIN, withThresh(profile || PROF.floorScreed, thresh));
  // alarmMinN: Frostnacht erst ab −5 → die Nacht bis −4 bleibt eine Vorwarnung
  const a = lvl('om-frost.json', { alarmMinN: -5 });
  assert.equal(a.level, 1);
  assert.deepEqual(a.reasons.map((r) => r.key), ['nightMin']);
  // critMinN: −6 setzt nur hart, wenn die Schwelle es zulässt
  assert.equal(lvl('om-hartfrost.json', {}).level, 3);
  assert.equal(lvl('om-hartfrost.json', { critMinN: -7 }).level, 2);
  // warnDrop48 / alarmDrop48 / warnMinN: der Sturz von −7 K
  const s = lvl('om-sturz.json', {});
  assert.equal(s.level, 2);
  assert.deepEqual(s.reasons.map((r) => r.key), ['nightMin', 'drop48']);
  assert.equal(lvl('om-sturz.json', { warnDrop48: -8, alarmDrop48: -8 }).level, 1, 'nur die kalte Nacht');
  assert.equal(lvl('om-sturz.json', { warnDrop48: -8, alarmDrop48: -8, warnMinN: 2 }).level, 0);
  assert.equal(lvl('om-sturz.json', { alarmDrop48: -8 }).level, 1, 'warnDrop48 −4 greift weiter, alarmDrop48 −8 nicht');
  // coldWind: 30 km/h Wind sind bei coldWind 35 nicht mehr windig
  const w = lvl('om-sturm.json', { coldWind: 35 });
  assert.deepEqual(w.reasons.map((r) => r.key), ['nightMin']);
  // gustLead: Böen 55 km/h, Zuschlag und gusty hängen an der Schwelle
  const g1 = verdictOf('om-sturm.json', JAN13_MS, BERLIN, PROF.floorScreed);
  const g2 = lvl('om-sturm.json', { gustLead: 60 });
  assert.equal(g1.plan[0].gusty, true);
  assert.equal(g2.plan[0].gusty, false);
  near(g1.plan[0].lead - g2.plan[0].lead, 0.5, 1e-12);
  const g3 = lvl('om-sturm.json', { gustLead: 55 });
  assert.equal(g3.plan[0].gusty, false, 'genau auf der Schwelle: noch keine starken Böen');
  assert.equal(g3.plan[0].lead, g2.plan[0].lead);
  // alarmGtRise (Gradtagzahl-Sprung) siehe eigener Test
});

test('assess: eine Regel ohne Chip (alarmDrop48) hebt die Stufe an, ohne „ruhige Nächte“ zu behaupten', () => {
  // warnDrop48 weit unten und warnMinN darunter: nur alarmDrop48 (−6) greift bei drop48 = −7
  const v = verdictOf('om-sturz.json', JAN13_MS, BERLIN, withThresh(PROF.floorScreed, { warnDrop48: -10, warnMinN: 2 }));
  assert.equal(v.level, 2);
  assert.deepEqual(v.reasons, []);
  // ohne jede Regel bleibt es bei Stufe 0 mit den beiden Ruhe-Gründen
  const ruhig = verdictOf('om-sturz.json', JAN13_MS, BERLIN, withThresh(PROF.floorScreed, { warnDrop48: -10, alarmDrop48: -10, warnMinN: 2 }));
  assert.equal(ruhig.level, 0);
  assert.deepEqual(ruhig.reasons.map((r) => r.key), ['calmNights', 'noJumps']);
});

test('assess om-frost: Stufe 2, Frostnacht, „durchheizen“, Aufheizzeit nach Heizart', () => {
  const v = verdictOf('om-frost.json', JAN13_MS, BERLIN);
  assert.equal(v.level, 2);
  assert.deepEqual(v.reasons, [{ key: 'nightMin', n: -4 }, { key: 'frost' }]);
  assert.deepEqual(v.nights.map((n) => n.min), [-2, -4, -1]);
  assert.equal(v.plan[0].strength, 'through');
  assert.equal(v.plan[1].strength, 'through');
  assert.equal(v.plan[0].optional, false);
  assert.equal(heat.lead(PROF.floorScreed, -4, 20), 6);
  assert.equal(heat.lead(PROF.radiator, -4, 20), 2);
  near(v.plan[0].lead, 5.5, 1e-12);
  near(v.plan[1].lead, 6, 1e-12);
  near(v.plan[0].dN, -4, 1e-9);
  near(v.plan[0].swing, 6, 1e-9);

  // Heizkörper startet später als Fußbodenheizung im Estrich: mindestens eine Stunde, hier vier
  const radiator = heat.plan(modelOf('om-frost.json'), v.nights, PROF.radiator);
  assert.ok(radiator[0].startMs - v.plan[0].startMs >= HOUR);
  assert.equal(radiator[0].startMs - v.plan[0].startMs, 4 * HOUR);
  assert.equal(radiator[0].onsetMs, v.plan[0].onsetMs, 'die Abkühlung hängt nicht von der Heizart ab');
  assert.equal(v.plan[0].onsetMs - v.plan[0].startMs, 6 * HOUR);
  assert.equal(radiator[0].onsetMs - radiator[0].startMs, 2 * HOUR);
});

test('assess om-hartfrost: Nacht bis −6 °C setzt Stufe 3 ohne jede Warnung', () => {
  const v = verdictOf('om-hartfrost.json', JAN13_MS, BERLIN);
  assert.equal(v.level, 3);
  assert.deepEqual(v.al, []);
  assert.deepEqual(v.reasons.map((r) => r.key), ['nightMin', 'frost']);
  assert.ok(!v.reasons.some((r) => r.key === 'alert'));
  assert.equal(v.nights[0].min, -6);
});

test('assess om-sturz: Tagesmittel 12 → 5 °C in 48 h ohne Frost ist Stufe 2 mit drop48 = −7', () => {
  const m = modelOf('om-sturz.json');
  near(m.days[1].mean, 12);
  near(m.days[2].mean, 8);
  near(m.days[3].mean, 5);
  const v = heat.assess(m, NOW_JAN13, PROF.floorScreed, []);
  assert.equal(v.level, 2);
  assert.deepEqual(v.reasons.map((r) => r.key), ['nightMin', 'drop48']);
  const r = v.reasons.find((x) => x.key === 'drop48');
  near(r.n, -7, 1e-9);
  assert.ok(!v.reasons.some((x) => x.key === 'frost'), 'kein Frost');
  assert.ok(v.nights[0].min > 0 && v.nights[1].min > 0);
  assert.deepEqual(v.nights.map((n) => n.min), [6, 3, 1]);
  // die Gradtagzahl springt um 4 und 3 Kd: unter der Schwelle von 5
  assert.ok(!v.reasons.some((x) => x.key === 'gtRise'));
  // Stufen des Fahrplans: Nacht 6 → normal, 3 und 1 → eine Stufe höher
  assert.deepEqual(v.plan.map((e) => e.strength), ['normal', 'up', 'up']);
});

test('assess om-sturm: kalt, windig, wenig Sonne gibt coldWindy; Böen verlängern die Aufheizzeit', () => {
  const m = modelOf('om-sturm.json');
  const v = heat.assess(m, NOW_JAN13, PROF.floorScreed, []);
  assert.equal(v.level, 1);
  assert.deepEqual(v.reasons.map((r) => r.key), ['nightMin', 'coldWindy']);
  assert.equal(v.nights[0].wind, 30);
  assert.equal(v.nights[0].gust, 55);
  assert.ok(v.D[0].sun < 2);
  const e = v.plan[0];
  assert.equal(e.gusty, true);
  near(e.lead, 3 + 5 / 12 * 3 + 0.5, 1e-12);
  assert.equal(e.onsetMs - e.startMs, 5 * HOUR);
  assert.equal(heat.lead(PROF.floorScreed, 3, 20) + 0.5, e.lead, 'Böenzuschlag genau eine halbe Stunde');

  // scheint die Sonne, fällt coldWindy weg
  const sonnig = clone(m);
  sonnig.days.forEach((d) => { d.sun = 5; });
  const v2 = heat.assess(sonnig, NOW_JAN13, PROF.floorScreed, []);
  assert.deepEqual(v2.reasons.map((r) => r.key), ['nightMin']);
  // fehlende Sonnenwerte zählen nicht als „kein Sonnenschein“
  const ohneSonne = clone(m);
  ohneSonne.days.forEach((d) => { d.sun = null; });
  assert.deepEqual(heat.assess(ohneSonne, NOW_JAN13, PROF.floorScreed, []).reasons.map((r) => r.key), ['nightMin']);
  // weht kaum Wind, fällt es ebenfalls weg
  const still = clone(m);
  still.hours.forEach((o) => { o.wind = 10; });
  assert.deepEqual(heat.assess(still, NOW_JAN13, PROF.floorScreed, []).reasons.map((r) => r.key), ['nightMin']);
  // zu mild (8 °C und mehr): auch weg
  const mild = clone(m);
  mild.hours.forEach((o) => { o.temp += 6; });
  assert.ok(!heat.assess(mild, NOW_JAN13, PROF.floorScreed, []).reasons.some((r) => r.key === 'coldWindy'));
});

test('assess mit DWD-Warnung: alerts-sturm hebt auf Stufe 2, severe auf 3, mit Chip alert', () => {
  const m = modelOf('om-sturm.json');
  const sturm = fixture('alerts-sturm.json').alerts;
  const v = heat.assess(m, NOW_JAN13, PROF.floorScreed, sturm);
  assert.equal(v.level, 2);
  assert.deepEqual(v.reasons.map((r) => r.key), ['nightMin', 'coldWindy', 'alert']);
  assert.deepEqual(v.al, sturm);

  const schwer = [Object.assign({}, sturm[0], { severity: 'severe' })];
  const v3 = heat.assess(m, NOW_JAN13, PROF.floorScreed, schwer);
  assert.equal(v3.level, 3);
  assert.deepEqual(v3.al, schwer);

  // an einem ruhigen Tag hebt eine Warnung allein die Ampel an, ohne die Ruhe-Gründe
  const ruhig = heat.assess(modelOf('om-mild.json'), NOW_JAN13, PROF.floorScreed, sturm);
  assert.equal(ruhig.level, 2);
  assert.deepEqual(ruhig.reasons, [{ key: 'alert' }]);

  // eine Warnung, die nicht trifft, ändert nichts
  const regen = [Object.assign({}, sturm[0], { event_de: 'DAUERREGEN', event_en: 'persistent rain' })];
  const v0 = heat.assess(modelOf('om-mild.json'), NOW_JAN13, PROF.floorScreed, regen);
  assert.equal(v0.level, 0);
  assert.deepEqual(v0.al, []);

  // alle 17 echten Warnungen vom 10.10.: Stufe 2, 16 Treffer, kein Wurf
  const alle = fixture('alerts-dwd-2026-10-10.json').alerts;
  const vAlle = heat.assess(m, NOW_JAN13, PROF.floorScreed, alle);
  assert.equal(vAlle.level, 2);
  assert.equal(vAlle.al.length, 16);

  // alerts null oder fehlend
  assert.equal(heat.assess(m, NOW_JAN13, PROF.floorScreed, null).level, 1);
  assert.equal(heat.assess(m, NOW_JAN13, PROF.floorScreed).level, 1);
});

test('assess: die Regeln greifen genau auf der Schwelle (< bei warnMinN, <= bei den anderen)', () => {
  const m = modelOf('om-mild.json');                     // Nächte 9,5 / 10,5 / 10 °C, ruhig
  const keys = (v) => v.reasons.map((r) => r.key);
  const mit = (thresh, modell) => heat.assess(modell || m, NOW_JAN13, withThresh(PROF.floorScreed, thresh), []);

  // warnMinN: minN < Schwelle
  assert.equal(mit({ warnMinN: 9.5 }).level, 0);
  assert.equal(mit({ warnMinN: 9.6 }).level, 1);
  // alarmMinN und critMinN: minN <= Schwelle
  assert.deepEqual(keys(mit({ alarmMinN: 9.5 })), ['frost']);
  assert.equal(mit({ alarmMinN: 9.5 }).level, 2);
  assert.equal(mit({ alarmMinN: 9.4 }).level, 0);
  assert.equal(mit({ critMinN: 9.5 }).level, 3);
  assert.equal(mit({ critMinN: 9.4 }).level, 0);

  // Tagesmittel 10 → 8 → 5: drop48 = −5 (ganze Zahlen, damit die Gleichheit exakt ist)
  const sturz = clone(m);
  sturz.days[1].mean = 10; sturz.days[2].mean = 8; sturz.days[3].mean = 5;
  assert.equal(mit({}, sturz).level, 1);                 // −5 ≤ −4
  assert.deepEqual(keys(mit({}, sturz)), ['drop48']);
  assert.equal(mit({ warnDrop48: -5 }, sturz).level, 1, 'warnDrop48: drop48 <= Schwelle');
  assert.equal(mit({ warnDrop48: -5.1 }, sturz).level, 0);
  assert.equal(mit({ alarmDrop48: -5 }, sturz).level, 2, 'alarmDrop48: drop48 <= Schwelle');
  assert.equal(mit({ alarmDrop48: -5.1, warnDrop48: -5.1 }, sturz).level, 0);

  // Gradtagzahl-Sprung genau 5: gtRise >= Schwelle
  const sprung = clone(m);
  sprung.days[1].gt = 8; sprung.days[2].gt = 13; sprung.days[3].gt = 13;
  assert.equal(mit({}, sprung).level, 2);
  assert.equal(mit({ alarmGtRise: 5.1 }, sprung).level, 0);

  // kalt + windig: Nacht < 8 °C, Wind > 20 km/h, Sonne < 2 h (jeweils streng)
  const kalt = clone(m);
  kalt.hours.forEach((o) => { o.temp -= 5; o.wind = 21; });        // Nächte 4,5 / 5,5 / 5 °C
  kalt.days[1].sun = 1.9; kalt.days[2].sun = 3;
  assert.ok(keys(mit({}, kalt)).includes('coldWindy'));
  const wind20 = clone(kalt); wind20.hours.forEach((o) => { o.wind = 20; });
  assert.ok(!keys(mit({}, wind20)).includes('coldWindy'), 'genau 20 km/h ist nicht windig');
  const sonne2 = clone(kalt); sonne2.days[1].sun = 2; sonne2.days[2].sun = 2;
  assert.ok(!keys(mit({}, sonne2)).includes('coldWindy'), 'genau 2 Stunden Sonne sind nicht wenig');
  const nacht8 = clone(m);
  nacht8.hours.forEach((o) => { o.temp = 8 + (o.temp - 9.5); o.wind = 30; });   // erste Nacht genau 8 °C, zweite 9 °C
  nacht8.days[1].sun = 0; nacht8.days[2].sun = 0;
  assert.ok(!keys(mit({}, nacht8)).includes('coldWindy'), 'genau 8 °C ist nicht kalt genug');
});

test('assess: Gradtagzahl-Sprung ab 5 Kd hebt auf Stufe 2 (gtRise), die Schwelle ist einstellbar', () => {
  const m = modelOf('om-mild.json');
  const sprung = clone(m);
  sprung.days[2].gt = sprung.days[1].gt + 5.5;            // D[1] gegenüber D[0]
  const v = heat.assess(sprung, NOW_JAN13, PROF.floorScreed, []);
  assert.equal(v.level, 2);
  assert.deepEqual(v.reasons.map((r) => r.key), ['gtRise']);
  near(v.reasons[0].n, 5.5, 1e-9);

  const klein = clone(m);
  klein.days[2].gt = klein.days[1].gt + 4.5;
  klein.days[3].gt = klein.days[2].gt;                    // kein zweiter Sprung
  assert.equal(heat.assess(klein, NOW_JAN13, PROF.floorScreed, []).level, 0);
  assert.equal(heat.assess(klein, NOW_JAN13, withThresh(PROF.floorScreed, { alarmGtRise: 4 }), []).level, 2);

  // der zweite Sprung (D[2] gegenüber D[1]) zählt ebenso
  const zweiter = clone(m);
  zweiter.days[3].gt = zweiter.days[2].gt + 6;
  assert.deepEqual(heat.assess(zweiter, NOW_JAN13, PROF.floorScreed, []).reasons.map((r) => r.key), ['gtRise']);
});

test('assess: kein Zugriff auf Tage ohne Nachbarn, fehlende Tage zählen als 0', () => {
  const m = modelOf('om-frost.json');
  // heute = 15.01. (Index 3): nur eine Nacht, D hat zwei Tage
  const v = heat.assess(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 15, 9, 0)), PROF.floorScreed, []);
  assert.equal(v.D.length, 2);
  assert.equal(v.nights.length, 1);
  assert.equal(v.plan.length, 1);
  assert.equal(v.level, 2);
  assert.equal(v.prev.key, '2026-01-14');
  // heute = erster Tag: keine prev, dN der ersten Nacht kommt aus der Nacht davor (Index −1) oder 0
  const erster = heat.assess(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 12, 9, 0)), PROF.floorScreed, []);
  assert.equal(erster.prev, null);
  assert.equal(erster.D.length, 3);
});

test('assess om-stale (Bürg-Antwort, jetzt 14.10.2026 08:00): level null, tooOld, kein Wurf', () => {
  const v = verdictOf('om-stale.json', STALE_NOW_MS, 'Europe/Berlin', PROF.floorScreed, []);
  assert.deepEqual(v, { level: null, reasons: [{ key: 'tooOld' }], D: [], prev: null, nights: [], plan: [], al: [] });
  assert.deepEqual(Object.keys(v), ['level', 'reasons', 'D', 'prev', 'nights', 'plan', 'al']);
  // dieselbe Antwort ist am Tag der Abfrage gültig
  assert.equal(verdictOf('om-stale.json', BUERG_NOW_MS, 'Europe/Berlin', PROF.floorScreed, []).level, 0);
  // ein Tag vor dem Fenster
  assert.equal(verdictOf('om-stale.json', Date.UTC(2026, 9, 1, 8, 0), 'Europe/Berlin', PROF.floorScreed, []).level, null);
});

test('assess: heute ist der letzte Tag der Antwort (keine Nacht mehr) ergibt ebenfalls tooOld', () => {
  const m = modelOf('om-mild.json');
  const v = heat.assess(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 16, 9, 0)), PROF.floorScreed, []);
  assert.equal(v.level, null);
  assert.deepEqual(v.reasons, [{ key: 'tooOld' }]);
  // ohne „jetzt“ und ohne Modell kein Wurf
  assert.equal(heat.assess(m, null, PROF.floorScreed, []).level, null);
  assert.equal(heat.assess(null, NOW_JAN13, PROF.floorScreed, []).level, null);
  assert.equal(heat.assess({ days: [], hours: [] }, NOW_JAN13, PROF.floorScreed, []).level, null);
});

test('assess om-null: Lücken ergeben keine NaN und einen Tiefstwert aus den vorhandenen Stunden', () => {
  const v = verdictOf('om-null.json', JAN13_MS, BERLIN);
  assert.deepEqual(alleZahlenEndlich(v.reasons, 'reasons', []), []);
  assert.deepEqual(alleZahlenEndlich(v.plan, 'plan', []), []);
  assert.deepEqual(alleZahlenEndlich(v.D, 'D', []), []);
  assert.deepEqual(alleZahlenEndlich(v.nights.map((n) => [n.min, n.wind, n.gust, n.atMs, n.toMs]), 'nights', []), []);
  assert.equal(v.nights[0].min, -0.9, 'der Tiefstwert um 03–05 Uhr fehlt, 06 Uhr ist der kleinste vorhandene');
  assert.equal(v.level, 2);
  assert.deepEqual(v.reasons.map((r) => r.key), ['nightMin', 'frost']);
});

test('Reason-Schlüssel und Verdict-Form: nur Schlüssel aus dem Plan, n bei den Zahlengründen', () => {
  const faelle = [
    verdictOf('om-mild.json', JAN13_MS, BERLIN), verdictOf('om-frost.json', JAN13_MS, BERLIN),
    verdictOf('om-hartfrost.json', JAN13_MS, BERLIN), verdictOf('om-sturz.json', JAN13_MS, BERLIN),
    verdictOf('om-sturm.json', JAN13_MS, BERLIN, PROF.floorScreed, fixture('alerts-sturm.json').alerts),
    verdictOf('om-stale.json', STALE_NOW_MS, BERLIN)
  ];
  const mitN = ['nightMin', 'drop48', 'gtRise', 'calmNights'];
  for (const v of faelle) {
    assert.ok(v.level === null || [0, 1, 2, 3].includes(v.level));
    assert.ok(v.reasons.length >= 1);
    for (const r of v.reasons) {
      assert.ok(REASON_KEYS.includes(r.key), r.key);
      assert.equal('n' in r, mitN.includes(r.key), r.key);
      assert.deepEqual(Object.keys(r), 'n' in r ? ['key', 'n'] : ['key']);
    }
    for (const e of v.plan) {
      assert.deepEqual(Object.keys(e), ['dayIdx', 'onsetMs', 'startMs', 'lead', 'swing', 'dN', 'strength', 'optional',
        'disagree', 'gusty', 'charge']);
      assert.ok(['through', 'up', 'normal', 'low'].includes(e.strength));
    }
  }
});

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

test('plan: Abkühlung beginnt, wenn die Temperatur halb zwischen Höchstwert und Nachttief liegt', () => {
  const m = modelOf('om-frost.json');
  const v = heat.assess(m, NOW_JAN13, PROF.floorScreed, []);
  v.nights.forEach((n, k) => {
    const e = v.plan[k];
    assert.equal(e.dayIdx, n.dayIdx);
    // Höchstwert des Tages zwischen 10 und 18 Uhr
    const tag = m.hours.filter((o) => o.dayIdx === n.dayIdx && o.h >= 10 && o.h <= 18);
    const peak = tag.reduce((a, o) => (o.temp > a.temp ? o : a));
    near(e.swing, peak.temp - n.min, 1e-9);
    const mid = n.min + (peak.temp - n.min) * 0.5;
    const onset = m.hours.find((o) => o.ms === e.onsetMs);
    assert.ok(onset.ms > peak.ms && onset.temp <= mid, 'onset ist nach dem Höchstwert und höchstens in der Mitte');
    const davor = m.hours.find((o) => o.ms === onset.ms - HOUR);
    assert.ok(davor.ms <= peak.ms || davor.temp > mid, 'und es ist die erste solche Stunde');
    assert.equal(e.dN, k === 0 ? n.min - heat.night(m.hours, n.dayIdx - 1).min : n.min - v.nights[k - 1].min);
  });
});

test('plan: startMs ist onset minus aufgerundete Aufheizzeit, immer auf voller Stunde', () => {
  for (const [name, profil] of [['om-frost.json', PROF.floorScreed], ['om-mild.json', PROF.radiator],
    ['om-sturm.json', PROF.heatpumpFloor], ['om-sturz.json', PROF.floorDry], ['om-lissabon.json', PROF.floorScreed]]) {
    const m = modelOf(name);
    const v = heat.assess(m, weather.localNow(m.tz, name === 'om-lissabon.json' ? JAN13_MS + HOUR : JAN13_MS), profil, []);
    for (const e of v.plan) {
      assert.equal(e.startMs, e.onsetMs - Math.ceil(e.lead) * HOUR, name);
      assert.equal(e.startMs % HOUR, 0, name);
      assert.ok(e.lead >= profil.leadMin && e.lead <= profil.leadMax, name);
    }
  }
  // ganze Stunden: kein Aufrunden
  const mild = verdictOf('om-mild.json', JAN13_MS, BERLIN);
  assert.equal(mild.plan[0].onsetMs - mild.plan[0].startMs, 3 * HOUR);
});

test('plan: optional ab 9 °C, disagree bei mehr als 2 K Abstand zu MOSMIX, gusty bei Böen über 40', () => {
  const om = fixture('om-mild.json');
  const mosFuer = (delta) => {
    const m0 = weather.model({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
    return m0.hours.map((o) => [o.ms, o.temp + delta]);
  };
  const bauen = (delta) => weather.model({ v: 2, fetched: 0, om, mos: mosFuer(delta), mosStation: null, alerts: null, alertsStatus: 'none' });
  const pruefe = (delta) => {
    const m = bauen(delta);
    return heat.assess(m, NOW_JAN13, PROF.floorScreed, []).plan[0];
  };
  assert.equal(pruefe(3).disagree, true, 'MOSMIX 3 K wärmer');
  assert.equal(pruefe(-3).disagree, true, 'MOSMIX 3 K kälter: die Bedingung gilt in beide Richtungen');
  assert.equal(pruefe(2).disagree, false, 'genau 2 K sind noch keine Abweichung');
  assert.equal(pruefe(1).disagree, false);
  assert.equal(pruefe(0).disagree, false);
  // ohne MOSMIX nie
  assert.equal(heat.assess(modelOf('om-mild.json'), NOW_JAN13, PROF.floorScreed, []).plan[0].disagree, false);
  // mosMin ist das Minimum der MOSMIX-Werte in der Nacht
  const m3 = bauen(3);
  const n = heat.night(m3.hours, 1);
  near(n.mosMin, n.hs.reduce((a, o) => Math.min(a, o.mos), Infinity), 1e-12);

  // optional: 9,5 °C ja; −2 °C nein; gusty
  assert.equal(verdictOf('om-mild.json', JAN13_MS, BERLIN).plan[0].optional, true);
  assert.equal(verdictOf('om-frost.json', JAN13_MS, BERLIN).plan[0].optional, false);
  assert.equal(verdictOf('om-sturm.json', JAN13_MS, BERLIN).plan[0].gusty, true);
  assert.equal(verdictOf('om-frost.json', JAN13_MS, BERLIN).plan[0].gusty, false);
});

test('plan: strength nach Tiefstwert mit den Grenzen 0, 5 und 9 °C', () => {
  const m = modelOf('om-mild.json');
  const base = heat.assess(m, NOW_JAN13, PROF.floorScreed, []);
  const mitMin = (min) => {
    const n = Object.assign({}, base.nights[0], { min });
    return heat.plan(m, [n], PROF.floorScreed)[0].strength;
  };
  assert.equal(mitMin(-8), 'through');
  assert.equal(mitMin(0), 'through');
  assert.equal(mitMin(0.1), 'up');
  assert.equal(mitMin(4.9), 'up');
  assert.equal(mitMin(5), 'normal');
  assert.equal(mitMin(8.9), 'normal');
  assert.equal(mitMin(9), 'low');
  assert.equal(mitMin(14), 'low');
  // alarmMinN verschiebt die Grenze für „durchheizen“
  const n = Object.assign({}, base.nights[0], { min: -2 });
  assert.equal(heat.plan(m, [n], withThresh(PROF.floorScreed, { alarmMinN: -3 }))[0].strength, 'up');
  // „optional“ ab genau 9 °C
  const optional = (min) => heat.plan(m, [Object.assign({}, base.nights[0], { min })], PROF.floorScreed)[0].optional;
  assert.equal(optional(8.9), false);
  assert.equal(optional(9), true);
  assert.equal(optional(9.1), true);
});

test('plan: leere Liste und fehlende Nacht-Stunden werfen nicht', () => {
  const m = modelOf('om-mild.json');
  assert.deepEqual(heat.plan(m, [], PROF.floorScreed), []);
  assert.deepEqual(heat.plan(m, undefined, PROF.floorScreed), []);
  // ein Tag ohne Stunden zwischen 10 und 18 Uhr: Rückfall auf die erste Nachtstunde
  const ohneTag = clone(m);
  ohneTag.hours = ohneTag.hours.filter((o) => !(o.dayIdx === 1 && o.h >= 10 && o.h <= 18));
  const n2 = heat.night(ohneTag.hours, 1);
  const e = heat.plan(ohneTag, [n2], PROF.floorScreed)[0];
  assert.ok(Number.isFinite(e.startMs) && Number.isFinite(e.onsetMs));
  assert.equal(e.swing, n2.hs[0].temp - n2.min, 'der Höchstwert fehlt, die erste Nachtstunde springt ein');
});

// ---------------------------------------------------------------------------------------------
// Nachtspeicher
// ---------------------------------------------------------------------------------------------

test('Nachtspeicher: plan() liefert je Nacht charge und kein startMs, onsetMs ist 20 Uhr am Vorabend', () => {
  const m = modelOf('om-sturz.json');
  const v = heat.assess(m, NOW_JAN13, PROF.storage, []);
  assert.equal(v.plan.length, 3);
  v.plan.forEach((e, k) => {
    assert.equal(e.startMs, null);
    assert.equal(e.lead, 0);
    assert.equal(e.dayIdx, v.nights[k].dayIdx);
    const abend = m.hours.find((o) => o.dayIdx === e.dayIdx && o.h === 20);
    assert.equal(e.onsetMs, abend.ms, '20 Uhr am Vorabend der Nacht');
    assert.deepEqual(Object.keys(e), ['dayIdx', 'onsetMs', 'startMs', 'lead', 'swing', 'dN', 'strength', 'optional',
      'disagree', 'gusty', 'charge']);
  });
  // Nächte 6 / 3 / 1 °C → normal / up / up
  assert.deepEqual(v.plan.map((e) => e.charge), ['normal', 'up', 'up']);
  // nie fällig, auch wenn „jetzt“ in der Nacht liegt
  v.plan.forEach((e, k) => assert.equal(heat.isDue(e, v.nights[k].toMs - HOUR, v.nights[k].toMs), false));
});

test('Nachtspeicher: charge in vier Stufen high / up / normal / low', () => {
  const m = modelOf('om-mild.json');
  const base = heat.assess(m, NOW_JAN13, PROF.storage, []);
  const mitMin = (min) => heat.plan(m, [Object.assign({}, base.nights[0], { min })], PROF.storage)[0].charge;
  assert.equal(mitMin(-3), 'high');
  assert.equal(mitMin(0), 'high');
  assert.equal(mitMin(2), 'up');
  assert.equal(mitMin(5), 'normal');
  assert.equal(mitMin(8.9), 'normal');
  assert.equal(mitMin(9), 'low');
  assert.equal(verdictOf('om-frost.json', JAN13_MS, BERLIN, PROF.storage).plan[0].charge, 'high');
  assert.equal(verdictOf('om-mild.json', JAN13_MS, BERLIN, PROF.storage).plan[0].charge, 'low');
  // andere Heizarten haben nie charge
  for (const p of ['floorScreed', 'radiator', 'floorDry', 'heatpumpFloor']) {
    assert.equal(verdictOf('om-frost.json', JAN13_MS, BERLIN, PROF[p]).plan[0].charge, null, p);
  }
});

test('Nachtspeicher: die Ampel selbst hängt nicht von der Heizart ab', () => {
  for (const name of ['om-mild.json', 'om-frost.json', 'om-hartfrost.json', 'om-sturz.json', 'om-sturm.json']) {
    const a = verdictOf(name, JAN13_MS, BERLIN, PROF.storage);
    const b = verdictOf(name, JAN13_MS, BERLIN, PROF.floorScreed);
    assert.equal(a.level, b.level, name);
    assert.deepEqual(a.reasons, b.reasons, name);
  }
  // auch ein Ort mit .heat statt eines Profils wird verstanden
  const ort = { id: '0a1b2c3d', label: 'Opa', heat: PROF.storage };
  assert.equal(verdictOf('om-frost.json', JAN13_MS, BERLIN, ort).plan[0].charge, 'high');
});

// ---------------------------------------------------------------------------------------------
// isDue
// ---------------------------------------------------------------------------------------------

test('isDue: ab startMs bis zum Ende der Nacht, Grenzen: Start inklusive, Ende exklusive', () => {
  const v = verdictOf('om-frost.json', JAN13_MS, BERLIN);
  const e = v.plan[0];
  const bis = v.nights[0].toMs;
  assert.equal(heat.isDue(e, e.startMs - 1, bis), false);
  assert.equal(heat.isDue(e, e.startMs, bis), true);
  assert.equal(heat.isDue(e, e.onsetMs, bis), true);
  assert.equal(heat.isDue(e, bis - 1, bis), true);
  assert.equal(heat.isDue(e, bis, bis), false);
  assert.equal(heat.isDue(e, bis + HOUR, bis), false);
  // ungültige Eingaben: nie fällig, kein Wurf
  assert.equal(heat.isDue(null, e.startMs, bis), false);
  assert.equal(heat.isDue(e, NaN, bis), false);
  assert.equal(heat.isDue(e, e.startMs, undefined), false);
  assert.equal(heat.isDue({ startMs: null }, 0, 1), false, 'null ist nicht 0');
});

// ---------------------------------------------------------------------------------------------
// airSlots
// ---------------------------------------------------------------------------------------------

test('airSlots om-lueften: höchstens 4 Fenster, chronologisch, genau ein best, die trockensten Stunden', () => {
  const m = modelOf('om-lueften.json');
  const r = heat.airSlots(m, NOW_JAN13, PROF.floorScreed);
  near(r.indoorDew, 10.68, 0.01);
  assert.deepEqual(Object.keys(r), ['indoorDew', 'slots']);
  assert.ok(r.slots.length <= 4);
  assert.equal(r.slots.length, 4);
  assert.deepEqual(r.slots.map((s) => s.h), [10, 11, 12, 13]);
  assert.deepEqual(Object.keys(r.slots[0]), ['ms', 'h', 'score', 'best']);
  r.slots.forEach((s, i) => { if (i) { assert.ok(s.ms > r.slots[i - 1].ms, 'chronologisch'); } });
  assert.equal(r.slots.filter((s) => s.best).length, 1);
  const best = r.slots.find((s) => s.best);
  assert.equal(best.h, 13, 'Taupunkt −3,5 °C ist der niedrigste');
  assert.ok(r.slots.every((s) => s.score <= best.score));
  // jedes Fenster: Außentaupunkt mindestens 2 K unter dem im Raum
  for (const s of r.slots) {
    const o = m.hours.find((x) => x.ms === s.ms);
    assert.ok(o.dew < r.indoorDew - 2);
    assert.equal(weather.localNow(m.tz, s.ms).h, s.h);
    assert.equal(o.dayIdx, 1, 'nur heute');
  }
  // 13 Uhr: (10,68 + 3,5) + 2 (trocken) + 1 (über 0 °C) + 1 (wenig Wind)
  near(best.score, r.indoorDew + 3.5 + 4, 1e-9);
});

test('airSlots: „jetzt“ schneidet vorne ab (eine Stunde Vorlauf), Regen drückt die Wertung', () => {
  const m = modelOf('om-lueften.json');
  const r = heat.airSlots(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 13, 10, 30)), PROF.floorScreed);
  // jetzt 11:30 → Kandidaten ab 10:30, also ab der 11-Uhr-Stunde; die Regenstunden 14 und 15 fallen zurück
  assert.deepEqual(r.slots.map((s) => s.h), [11, 12, 13, 16]);
  assert.equal(r.slots.find((s) => s.best).h, 13);
  // jetzt genau 11:00 → Kandidaten ab 10:00, die 10-Uhr-Stunde ist wieder dabei
  const r2 = heat.airSlots(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 13, 10, 0)), PROF.floorScreed);
  assert.deepEqual(r2.slots.map((s) => s.h), [10, 11, 12, 13]);
  // 22:30: Kandidaten ab 21:30, also nur die Stunde 22; 23 Uhr liegt außerhalb von 7 bis 22
  const spaet = heat.airSlots(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 13, 21, 30)), PROF.floorScreed);
  assert.deepEqual(spaet.slots.map((s) => s.h), [22]);
  assert.equal(spaet.slots[0].best, true);
});

test('airSlots: zu feuchte Außenluft ergibt keine Fenster; die Raumtemperatur verschiebt die Schwelle', () => {
  const m = modelOf('om-lueften.json');
  const nass = clone(m);
  nass.hours.forEach((o) => { o.dew += 20; });
  assert.deepEqual(heat.airSlots(nass, NOW_JAN13, PROF.floorScreed).slots, []);
  // knapp an der Grenze: Taupunkt genau Innen − 2 ist kein Fenster, darunter schon
  const innen = heat.airSlots(m, NOW_JAN13, PROF.floorScreed).indoorDew;
  const grenze = clone(m);
  grenze.hours.forEach((o) => { o.dew = innen - 2; });
  assert.deepEqual(heat.airSlots(grenze, NOW_JAN13, PROF.floorScreed).slots, []);
  grenze.hours.forEach((o) => { o.dew = innen - 2.01; });
  assert.ok(heat.airSlots(grenze, NOW_JAN13, PROF.floorScreed).slots.length > 0);
  // kühleres Zimmer = niedrigerer Raumtaupunkt = strengere Schwelle
  const kuehl = heat.airSlots(m, NOW_JAN13, Object.assign({}, PROF.floorScreed, { comfort: 17 }));
  assert.ok(kuehl.indoorDew < innen);
  near(kuehl.indoorDew, heat.dewPoint(17, 55), 1e-12);
});

test('airSlots: nur Stunden von 7 bis 22 Uhr, gleicher Wert bei Gleichstand: der frühere gewinnt', () => {
  const m = clone(modelOf('om-lueften.json'));
  m.hours.forEach((o) => { if (o.dayIdx === 1) { o.dew = -5; o.pp = 10; o.wind = 5; o.temp = 5; } });
  const r = heat.airSlots(m, weather.localNow(BERLIN, Date.UTC(2026, 0, 13, 4, 0)), PROF.floorScreed);
  // gleiche Wertung überall: die ersten vier (7, 8, 9, 10 Uhr), best ist die erste
  assert.deepEqual(r.slots.map((s) => s.h), [7, 8, 9, 10]);
  assert.deepEqual(r.slots.map((s) => s.best), [true, false, false, false]);
  assert.ok(r.slots.every((s) => s.h >= 7 && s.h <= 22));
});

test('airSlots: fehlende Werte werfen nicht und zählen neutral; kein Fenster, wenn heute fehlt', () => {
  const m = clone(modelOf('om-lueften.json'));
  const ohnePp = clone(m);
  ohnePp.hours.forEach((o) => { o.pp = null; });
  const a = heat.airSlots(m, NOW_JAN13, PROF.floorScreed);
  const b = heat.airSlots(ohnePp, NOW_JAN13, PROF.floorScreed);
  assert.equal(b.slots.length, 4);
  const um13 = (r) => r.slots.find((s) => s.h === 13);
  near(um13(a).score - um13(b).score, 2, 1e-12);   // ohne Regenwahrscheinlichkeit entfällt der Pluspunkt, nichts wird abgezogen
  const ohneDew = clone(m);
  ohneDew.hours.forEach((o) => { o.dew = null; });
  assert.deepEqual(heat.airSlots(ohneDew, NOW_JAN13, PROF.floorScreed).slots, []);
  assert.deepEqual(heat.airSlots(modelOf('om-stale.json'), weather.localNow(BERLIN, STALE_NOW_MS), PROF.floorScreed).slots, []);
  assert.deepEqual(heat.airSlots(m, null, PROF.floorScreed).slots, []);
  assert.equal(typeof heat.airSlots(m, null, PROF.floorScreed).indoorDew, 'number');
});

// ---------------------------------------------------------------------------------------------
// Zeitzonenunabhängigkeit
// ---------------------------------------------------------------------------------------------

test('Beweis: Modell, Ampel, Fahrplan und Lüften sind unter jeder Prozess-Zeitzone gleich', () => {
  const rechne = () => JSON.stringify({
    buerg: verdictOf('om-buerg-2026-10-09.json', BUERG_NOW_MS),
    frost: verdictOf('om-frost.json', JAN13_MS, BERLIN),
    sturm: verdictOf('om-sturm.json', JAN13_MS, BERLIN, PROF.floorScreed, fixture('alerts-sturm.json').alerts),
    dst: verdictOf('om-dst.json', DST_NOW_MS),
    vorDst: verdictOf('om-dst.json', Date.UTC(2026, 9, 24, 10, 0)),
    lissabon: verdictOf('om-lissabon.json', Date.UTC(2026, 0, 13, 23, 30)),
    speicher: verdictOf('om-sturz.json', JAN13_MS, BERLIN, PROF.storage),
    luft: heat.airSlots(modelOf('om-lueften.json'), NOW_JAN13, PROF.floorScreed),
    modell: modelOf('om-dst.json')
  });
  const vorher = rechne();
  const alt = process.env.TZ;
  // Versatz einer Beispielzeit in Minuten, damit der Test merkt, wenn der Wechsel nicht greift
  const erwartet = { 'Pacific/Auckland': -780, 'America/New_York': 300, 'Asia/Kolkata': -330, 'Europe/Berlin': -60, UTC: 0 };
  try {
    for (const zone of Object.keys(erwartet)) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2026, 0, 13, 12, 0)).getTimezoneOffset(), erwartet[zone], 'die Zone ' + zone + ' ist nicht aktiv');
      assert.equal(rechne(), vorher, 'Ergebnis weicht unter TZ=' + zone + ' ab');
    }
  } finally {
    if (alt === undefined) { delete process.env.TZ; } else { process.env.TZ = alt; }
  }
});
