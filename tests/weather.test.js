/*
 * Heizwarte — Tests für js/weather.js: Adressen, Abruf (fetchJSON, fetchWithRetry, load) und das Zeitzonen-Modell auf unixtime
 *
 * Alle Dienste laufen gegen Fixtures über fakeFetch (tests/_fake.js), nie gegen das Netz. Die Ortszeit der Tests
 * kommt immer aus om.timezone bzw. einer ausdrücklichen Zone, nie aus der Zeitzone des Rechners: die Erwartungen
 * sind feste Zahlen und gelten unter jeder TZ. Der letzte Test beweist das, indem er die Prozess-Zeitzone wechselt;
 * die drei Prozessläufe mit TZ=Europe/Berlin, Pacific/Auckland und UTC bleiben Sache des Verifizierers.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const { fakeFetch, fakeSleep } = require('./_fake.js');
const weather = Heizwarte.weather;

const HOUR = 3600000;
const BERLIN = 'Europe/Berlin';

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
  assert.ok(Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps), a + ' ist nicht ' + b);
}

function cacheOf(om, extra) {
  return Object.assign({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' }, extra);
}

function modelOf(name, extra) {
  return weather.model(cacheOf(fixture(name), extra));
}

// Orte, wie sie nach der Einrichtung im Speicher stehen (lat/lon auf drei Stellen gerundet)
const BUERG = { lat: 48.881, lon: 9.441, elev: 414, cc: 'DE' };
const WIEN = { lat: 48.208, lon: 16.374, elev: 171, cc: 'AT' };
const LISSABON = { lat: 38.722, lon: -9.139, elev: null, cc: 'PT' };

// 09.10.2026 10:45 in Berlin (UTC+2): der Tag, an dem die Bürg-Fassung ihre Antwort geholt hat
const BUERG_NOW_MS = Date.UTC(2026, 9, 9, 8, 45);
// 13.01.2026 10:00 in Berlin (UTC+1)
const JAN13_MS = Date.UTC(2026, 0, 13, 9, 0);

const OM_CURRENT = 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day';
const OM_HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,wind_speed_10m,' +
  'wind_gusts_10m,precipitation_probability,precipitation,shortwave_radiation,weather_code,cloud_cover,is_day';
const OM_DAILY = 'temperature_2m_max,temperature_2m_min,sunshine_duration,sunrise,sunset,weather_code,' +
  'precipitation_sum,wind_gusts_10m_max';

const ALERT_FIELDS = ['event_de', 'event_en', 'headline_de', 'headline_en', 'description_de', 'description_en',
  'instruction_de', 'instruction_en', 'severity', 'onset', 'expires'];

// Die drei Dienste mit den Standard-Fixtures; über „over“ ersetzt der Test einzelne Antworten
function dienste(over) {
  const t = Object.assign({
    '/v1/forecast': fixture('om-buerg-2026-10-09.json'),
    '/weather?': fixture('bs-buerg.json'),
    '/alerts?': fixture('alerts-leer.json')
  }, over || {});
  return fakeFetch(Object.entries(t));
}

function urlsMit(f, teil) {
  return f.calls.map((c) => c.url).filter((u) => u.includes(teil));
}

// Antwortfolge aus tests/fixtures/retry.json für fakeFetch; ein body "@datei.json" wird durch die Fixture ersetzt
function folge(name) {
  const liste = fixture('retry.json')[name];
  assert.ok(Array.isArray(liste), 'retry.json kennt die Folge ' + name + ' nicht');
  return liste.map((spec) => {
    const s = clone(spec);
    if (typeof s.body === 'string' && s.body.startsWith('@')) { s.body = fixture(s.body.slice(1)); }
    return s;
  });
}

// Ein Abruf, der nie antwortet; er bricht nur ab, wenn das Signal ausgelöst wird
function haengendesFetch() {
  const f = (url, init) => new Promise((resolve, reject) => {
    f.signals.push(init && init.signal);
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      });
    }
  });
  f.signals = [];
  return f;
}

// Soll-Ortszeit einer Fixture ohne Intl: lens = Stunden je Tag (25 am Tag der Rückstellung, dort kommt 2 Uhr zweimal)
function sollOrtszeit(lens) {
  const out = [];
  lens.forEach((len, d) => {
    for (let h = 0; h < 24; h++) {
      out.push([d, h]);
      if (len === 25 && h === 2) { out.push([d, 2]); }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------------------------

test('weather.js: Schnittstelle aus Abschnitt 5 und globaler Name', () => {
  for (const name of ['modelFor', 'omUrl', 'bsUrls', 'fetchJSON', 'fetchWithRetry', 'load', 'tzSafe', 'localNow', 'dayKeyOf', 'model']) {
    assert.equal(typeof weather[name], 'function', name);
  }
  assert.equal(typeof weather.OpenMeteoError, 'function');
  assert.equal(globalThis.Heizwarte.weather, weather);
  assert.equal(require('../js/weather.js'), weather);
});

test('weather.js: kein Zugriff auf Gerätezeit, DOM oder Speicher im Code', () => {
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'js', 'weather.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const verboten of ['getHours', 'getMinutes', 'getDate', 'getDay', 'getFullYear', 'getMonth', 'getTimezoneOffset',
    'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'document', 'localStorage', 'sessionStorage',
    'innerHTML', 'XMLHttpRequest', 'navigator', 'Math.random', 'console']) {
    assert.ok(!new RegExp('\\b' + verboten.replace('.', '\\.') + '\\b').test(quelle), verboten + ' kommt im Code vor');
  }
  assert.ok(!/new Date\(\s*\)/.test(quelle), 'new Date() ohne Argument liest die Gerätezeit');
});

test('weather.js: Date nur als Date.parse (Bright-Sky-Stempel) und Date.now (Standardwert), Abschnitt 3', () => {
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'js', 'weather.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const funde = quelle.match(/\bDate\b(\.\w+)?/g) || [];
  assert.ok(funde.length > 0);
  for (const f of funde) { assert.ok(['Date.parse', 'Date.now'].indexOf(f) >= 0, f + ' kommt im Code vor'); }
});

test('bsUrls: die Kalenderrechnung ohne Date stimmt Tag für Tag, auch 2000 (Schaltjahr) und 2100 (keins)', () => {
  const tag = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  for (const [von, bis] of [[Date.UTC(1999, 11, 1), Date.UTC(2001, 2, 31)], [Date.UTC(2023, 11, 1), Date.UTC(2025, 2, 31)],
    [Date.UTC(2099, 11, 1), Date.UTC(2100, 2, 31)]]) {
    for (let t = von + 12 * 3600000; t <= bis; t += tag) {
      const q = new URL(weather.bsUrls(BUERG, 'UTC', t).mos).searchParams;
      assert.equal(q.get('date'), iso(t - tag), 'date zu ' + iso(t));
      assert.equal(q.get('last_date'), iso(t + 4 * tag), 'last_date zu ' + iso(t));
    }
  }
  assert.equal(new URL(weather.bsUrls(BUERG, 'UTC', Date.UTC(2100, 1, 27, 12)).mos).searchParams.get('last_date'), '2100-03-03');
});

// ---------------------------------------------------------------------------------------------
// Adressen
// ---------------------------------------------------------------------------------------------

test('modelFor: DACH nimmt icon_seamless, der Rest best_match', () => {
  for (const cc of ['DE', 'AT', 'CH', 'de', 'at']) { assert.equal(weather.modelFor(cc), 'icon_seamless', cc); }
  for (const cc of ['PT', 'US', 'NZ', 'LI', '', null, undefined, 49]) { assert.equal(weather.modelFor(cc), 'best_match', String(cc)); }
});

test('omUrl: Bürg mit Höhe, unixtime und automatischer Zeitzone, Parameter wie im Plan', () => {
  assert.equal(weather.omUrl(BUERG),
    'https://api.open-meteo.com/v1/forecast?latitude=48.881&longitude=9.441&elevation=414' +
    '&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=4&models=icon_seamless' +
    '&current=' + OM_CURRENT + '&hourly=' + OM_HOURLY + '&daily=' + OM_DAILY);

  const u = new URL(weather.omUrl(BUERG));
  assert.equal(u.searchParams.get('timeformat'), 'unixtime');
  assert.equal(u.searchParams.get('timezone'), 'auto');
  assert.equal(u.searchParams.get('hourly').split(',').length, 12);
  assert.equal(u.searchParams.get('daily').split(',').length, 8);
  assert.equal(u.searchParams.get('current').split(',').length, 6);
});

test('omUrl: ohne Höhe kein elevation, Land bestimmt das Modell, negative Koordinaten', () => {
  const u = new URL(weather.omUrl(LISSABON));
  assert.equal(u.searchParams.get('latitude'), '38.722');
  assert.equal(u.searchParams.get('longitude'), '-9.139');
  assert.equal(u.searchParams.has('elevation'), false);
  assert.equal(u.searchParams.get('models'), 'best_match');

  assert.equal(new URL(weather.omUrl(WIEN)).searchParams.get('models'), 'icon_seamless');
  assert.equal(new URL(weather.omUrl({ lat: 1, lon: 2, elev: 0, cc: null })).searchParams.get('elevation'), '0');
  assert.equal(new URL(weather.omUrl({ lat: 1, lon: 2 })).searchParams.has('elevation'), false, 'elev fehlt ganz');
});

test('omUrl und bsUrls: nie mehr als drei Nachkommastellen, auch bei ungerundeter Eingabe', () => {
  const roh = { lat: 48.8772683, lon: 9.3964273, elev: 417, cc: 'DE' };
  const u = new URL(weather.omUrl(roh));
  assert.equal(u.searchParams.get('latitude'), '48.877');
  assert.equal(u.searchParams.get('longitude'), '9.396');
  const b = weather.bsUrls(roh, BERLIN, JAN13_MS);
  assert.ok(b.mos.includes('lat=48.877&lon=9.396&'));
  assert.equal(b.alerts, 'https://api.brightsky.dev/alerts?lat=48.877&lon=9.396');
});

test('bsUrls: gestern bis heute+4 in der Ortszeit der Antwort, nicht in der des Geräts', () => {
  // 11.10.2026 12:00 UTC: in Berlin noch der 11., in Auckland (UTC+13 im Oktober) schon 01:00 am 12.
  const mittag = Date.UTC(2026, 9, 11, 12, 0);
  assert.equal(weather.bsUrls(BUERG, BERLIN, mittag).mos,
    'https://api.brightsky.dev/weather?lat=48.881&lon=9.441&date=2026-10-10&last_date=2026-10-15&tz=Europe/Berlin');
  const nz = weather.bsUrls({ lat: -36.85, lon: 174.763, cc: 'NZ' }, 'Pacific/Auckland', Date.UTC(2026, 9, 11, 12, 0));
  assert.ok(nz.mos.includes('&date=2026-10-11&last_date=2026-10-16&tz=Pacific/Auckland'), nz.mos);

  // 13.01.2026 23:30 UTC: in Lissabon noch der 13., in Berlin schon der 14.
  const spaet = Date.UTC(2026, 0, 13, 23, 30);
  assert.ok(weather.bsUrls(LISSABON, 'Europe/Lisbon', spaet).mos.includes('&date=2026-01-12&last_date=2026-01-17&tz='));
  assert.ok(weather.bsUrls(BUERG, BERLIN, spaet).mos.includes('&date=2026-01-13&last_date=2026-01-18&tz='));
});

test('bsUrls: Monats-, Jahres- und Schaltjahrwechsel rechnen in reinen Kalendertagen', () => {
  const tag = (nowMs, tz) => {
    const m = weather.bsUrls(BUERG, tz || 'UTC', nowMs).mos.match(/date=([\d-]+)&last_date=([\d-]+)/);
    return [m[1], m[2]];
  };
  assert.deepEqual(tag(Date.UTC(2026, 9, 31, 12, 0)), ['2026-10-30', '2026-11-04']);
  assert.deepEqual(tag(Date.UTC(2026, 11, 31, 12, 0)), ['2026-12-30', '2027-01-04']);
  assert.deepEqual(tag(Date.UTC(2026, 0, 1, 12, 0)), ['2025-12-31', '2026-01-05']);
  assert.deepEqual(tag(Date.UTC(2028, 1, 27, 12, 0)), ['2028-02-26', '2028-03-02'], '2028 ist ein Schaltjahr');
  assert.deepEqual(tag(Date.UTC(2027, 1, 27, 12, 0)), ['2027-02-26', '2027-03-03']);
  // die Umstellungsnacht: 25.10.2026 ist ein 25-Stunden-Tag, die Kalendertage bleiben trotzdem lückenlos
  assert.deepEqual(tag(Date.UTC(2026, 9, 25, 0, 30), BERLIN), ['2026-10-24', '2026-10-29']);
  assert.deepEqual(tag(Date.UTC(2026, 9, 25, 1, 30), BERLIN), ['2026-10-24', '2026-10-29']);
});

test('bsUrls: Warnungen nur für Deutschland oder unbekanntes Land, die Zone steht lesbar und sicher kodiert in der URL', () => {
  const now = Date.UTC(2026, 9, 11, 12, 0);
  assert.equal(weather.bsUrls({ lat: 48.881, lon: 9.441, cc: 'DE' }, BERLIN, now).alerts,
    'https://api.brightsky.dev/alerts?lat=48.881&lon=9.441');
  assert.notEqual(weather.bsUrls({ lat: 48.881, lon: 9.441, cc: null }, BERLIN, now).alerts, null, 'unbekanntes Land: fragen');
  assert.notEqual(weather.bsUrls({ lat: 48.881, lon: 9.441 }, BERLIN, now).alerts, null, 'cc fehlt: fragen');
  for (const cc of ['AT', 'CH', 'PT', 'US']) {
    assert.equal(weather.bsUrls({ lat: 48.2, lon: 16.4, cc }, BERLIN, now).alerts, null, cc);
  }

  // ein „+“ in der Zone wäre in einer Query ein Leerzeichen
  assert.ok(weather.bsUrls(BUERG, 'Etc/GMT+5', now).mos.endsWith('&tz=Etc/GMT%2B5'));
  assert.ok(weather.bsUrls(BUERG, 'America/Argentina/Buenos_Aires', now).mos.endsWith('&tz=America/Argentina/Buenos_Aires'));
  // eine Zone, die die Laufzeit nicht kennt, rechnet und schreibt sich als UTC statt zu werfen
  assert.ok(weather.bsUrls(BUERG, 'Mars/Olympus', now).mos.endsWith('&tz=UTC'));
});

// ---------------------------------------------------------------------------------------------
// fetchJSON
// ---------------------------------------------------------------------------------------------

test('fetchJSON: 200 mit JSON, no-store und Abbruchsignal, kein Fehler', async () => {
  const f = fakeFetch({ '/x': { hallo: 'welt' } });
  const r = await weather.fetchJSON('https://example.test/x', { fetchImpl: f });
  assert.deepEqual(r, { ok: true, status: 200, json: { hallo: 'welt' }, error: null });
  assert.equal(f.calls[0].init.cache, 'no-store');
  assert.ok(f.calls[0].init.signal, 'das Signal für die Frist fehlt');
  assert.equal(f.calls[0].init.signal.aborted, false, 'nach Erfolg wird nichts abgebrochen');
});

test('fetchJSON: HTTP-Fehler wirft nicht, ein JSON-Körper bleibt lesbar', async () => {
  const f = fakeFetch({
    '/404': { status: 404, body: { detail: 'No sources match your criteria' } },
    '/429': { status: 429 },
    '/500': { status: 500, body: '<html>kaputt</html>' }
  });
  assert.deepEqual(await weather.fetchJSON('https://example.test/404', { fetchImpl: f }),
    { ok: false, status: 404, json: { detail: 'No sources match your criteria' }, error: 'http' });
  assert.deepEqual(await weather.fetchJSON('https://example.test/429', { fetchImpl: f }),
    { ok: false, status: 429, json: null, error: 'http' }, '429 ohne Körper: json null');
  assert.deepEqual(await weather.fetchJSON('https://example.test/500', { fetchImpl: f }),
    { ok: false, status: 500, json: null, error: 'http' });
  assert.equal(f.count(), 3, 'kein Wiederholungsversuch');
});

test('fetchJSON: 200 mit Nicht-JSON ist parse, kein Netz und eine werfende Funktion sind offline', async () => {
  const f = fakeFetch({ '/seite': { status: 200, body: '<html>Anmeldung im WLAN</html>' }, '/weg': { throws: true } });
  assert.deepEqual(await weather.fetchJSON('https://example.test/seite', { fetchImpl: f }),
    { ok: false, status: 200, json: null, error: 'parse' });
  assert.deepEqual(await weather.fetchJSON('https://example.test/weg', { fetchImpl: f }),
    { ok: false, status: 0, json: null, error: 'offline' });
  // auch eine Funktion, die sofort (nicht erst als Promise) wirft
  const sofort = () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await weather.fetchJSON('https://example.test/', { fetchImpl: sofort }),
    { ok: false, status: 0, json: null, error: 'offline' });
});

test('fetchJSON: nach der Frist kommt timeout, das Signal wird ausgelöst, auch wenn fetch es ignoriert', async () => {
  const haengt = haengendesFetch();
  const r = await weather.fetchJSON('https://example.test/', { fetchImpl: haengt, timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, status: 0, json: null, error: 'timeout' });
  assert.equal(haengt.signals[0].aborted, true);

  // ein fetch, das das Signal gar nicht beachtet, bremst die Frist trotzdem nicht aus
  const taub = () => new Promise(() => {});
  assert.equal((await weather.fetchJSON('https://example.test/', { fetchImpl: taub, timeoutMs: 20 })).error, 'timeout');
});

// ---------------------------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------------------------

const RETRY_URL = 'https://example.test/forecast';

// Ruft fetchWithRetry mit einer Folge aus retry.json und schreibt alles mit: die Reihenfolge der Ereignisse (Meldung
// an die Oberfläche vor dem Warten), die Wartezeiten (fakeSleep) und die Abrufe (fakeFetch)
async function mitFolge(name, opts) {
  const f = fakeFetch([['/forecast', folge(name)]]);
  const sleep = fakeSleep();
  const ereignisse = [];
  const r = await weather.fetchWithRetry(RETRY_URL, Object.assign({
    fetchImpl: f,
    sleep: async (ms) => { ereignisse.push('sleep:' + ms); await sleep(ms); },
    onWait: (ms) => ereignisse.push('onWait:' + ms),
    onWaiting: (e) => ereignisse.push('onWaiting:' + JSON.stringify(e))
  }, opts || {}));
  return { r, f, sleep, ereignisse };
}

test('fetchWithRetry: 429, dann 200 – die Daten kommen an, genau ein sleep(60000), vorher die Meldung an die Oberfläche', async () => {
  const { r, f, sleep, ereignisse } = await mitFolge('429-dann-200');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.error, null);
  assert.deepEqual(r.json, fixture('om-buerg-2026-10-09.json'));
  assert.deepEqual(sleep.calls, [60000], 'genau ein sleep, 60 s');
  assert.equal(f.count(), 2, 'erster Versuch plus genau ein zweiter');
  assert.deepEqual(f.calls.map((c) => c.url), [RETRY_URL, RETRY_URL], 'derselbe Aufruf noch einmal');
  assert.notEqual(f.calls[0].init.signal, f.calls[1].init.signal, 'jeder Versuch hat seine eigene Frist');
  assert.equal(f.calls[1].init.signal.aborted, false);
  // die Statuszeile bekommt die Wartezeit, bevor gewartet wird (statusWaiting{s}, s in ganzen Sekunden)
  assert.deepEqual(ereignisse, ['onWait:60000', 'onWaiting:{"s":60,"ms":60000}', 'sleep:60000']);
});

test('fetchWithRetry: 429, dann 429 – kein Wurf, das Ergebnis ist der zweite 429, kein dritter Versuch', async () => {
  const { r, f, sleep } = await mitFolge('429-dann-429');
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.error, 'http');
  assert.equal(r.json.error, true);
  assert.deepEqual(sleep.calls, [60000]);
  assert.equal(f.count(), 2);
});

test('fetchWithRetry: Retry-After 30 wartet trotzdem 60 s – 60 s sind das Minimum', async () => {
  const { r, f, sleep, ereignisse } = await mitFolge('retry-after-30');
  assert.equal(r.ok, true);
  assert.deepEqual(sleep.calls, [60000]);
  assert.equal(f.count(), 2);
  assert.deepEqual(ereignisse, ['onWait:60000', 'onWaiting:{"s":60,"ms":60000}', 'sleep:60000']);
});

test('fetchWithRetry: Retry-After hebt die Wartezeit über 60 s, höchstens aber auf 120 s (wie update.py:25–37)', async () => {
  const tabelle = [
    ['retry-after-0', 60000],
    ['retry-after-30', 60000],
    ['retry-after-90', 90000],
    ['retry-after-120', 120000],
    ['retry-after-300', 120000],
    ['retry-after-unlesbar', 60000],     // „bald“ ist keine Zahl
    ['retry-after-datum', 60000]         // eine HTTP-Datumsangabe ist nicht lesbar und gilt wie kein Kopf
  ];
  for (const [name, soll] of tabelle) {
    const { r, f, sleep, ereignisse } = await mitFolge(name);
    assert.equal(r.ok, true, name);
    assert.deepEqual(sleep.calls, [soll], name);
    assert.equal(f.count(), 2, name);
    assert.deepEqual(ereignisse, ['onWait:' + soll, 'onWaiting:' + JSON.stringify({ s: soll / 1000, ms: soll }), 'sleep:' + soll], name);
  }
});

test('fetchWithRetry: gleich im ersten Versuch gut – kein sleep, keine Meldung, ein Abruf', async () => {
  const { r, f, sleep, ereignisse } = await mitFolge('200');
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, fixture('om-buerg-2026-10-09.json'));
  assert.equal(sleep.count, 0);
  assert.equal(f.count(), 1);
  assert.deepEqual(ereignisse, []);
});

test('fetchWithRetry: 500, 503, 404, Netzfehler und Zeitüberschreitung werden nicht wiederholt', async () => {
  for (const [name, status] of [['500-dann-200', 500], ['503-dann-200', 503]]) {
    const { r, f, sleep, ereignisse } = await mitFolge(name);
    assert.equal(r.ok, false, name);
    assert.equal(r.status, status, name);
    assert.equal(r.error, 'http', name);
    assert.equal(sleep.count, 0, name + ': auch ein Retry-After-Kopf macht aus 5xx keinen Wiederholungsgrund');
    assert.equal(f.count(), 1, name);
    assert.deepEqual(ereignisse, [], name);
  }

  const nichts = fakeFetch({ '/forecast': { status: 404, body: { detail: 'weg' } } });
  const s404 = fakeSleep();
  const r404 = await weather.fetchWithRetry(RETRY_URL, { fetchImpl: nichts, sleep: s404 });
  assert.equal(r404.status, 404);
  assert.equal(nichts.count(), 1);
  assert.equal(s404.count, 0);

  const weg = fakeFetch({ '/forecast': { throws: true } });
  const sWeg = fakeSleep();
  const rWeg = await weather.fetchWithRetry(RETRY_URL, { fetchImpl: weg, sleep: sWeg });
  assert.deepEqual(rWeg, { ok: false, status: 0, json: null, error: 'offline' });
  assert.equal(weg.count(), 1);
  assert.equal(sWeg.count, 0);

  const haengt = haengendesFetch();
  const sHaengt = fakeSleep();
  const rHaengt = await weather.fetchWithRetry(RETRY_URL, { fetchImpl: haengt, sleep: sHaengt, timeoutMs: 20 });
  assert.deepEqual(rHaengt, { ok: false, status: 0, json: null, error: 'timeout' });
  assert.equal(haengt.signals.length, 1);
  assert.equal(sHaengt.count, 0);
});

test('fetchWithRetry: retryOn und waitMs ändern den Anlass und das Mindestmaß, Retry-After bleibt gedeckelt', async () => {
  // 503 statt 429 als Anlass
  const a = await mitFolge('503-dann-200', { retryOn: [503] });
  assert.equal(a.r.ok, true);
  assert.deepEqual(a.sleep.calls, [60000], 'Retry-After 30 liegt unter dem Mindestmaß');
  const b = await mitFolge('429-dann-200', { retryOn: [503] });
  assert.equal(b.r.status, 429, 'ein 429 ist dann kein Anlass');
  assert.equal(b.sleep.count, 0);
  assert.equal(b.f.count(), 1);

  // kürzeres Mindestmaß; ein lesbarer Retry-After darüber gilt weiter, bis 120 s
  const c = await mitFolge('429-dann-200', { waitMs: 5000 });
  assert.deepEqual(c.sleep.calls, [5000]);
  assert.deepEqual(c.ereignisse, ['onWait:5000', 'onWaiting:{"s":5,"ms":5000}', 'sleep:5000']);
  assert.deepEqual((await mitFolge('retry-after-30', { waitMs: 5000 })).sleep.calls, [30000]);
  assert.deepEqual((await mitFolge('retry-after-300', { waitMs: 5000 })).sleep.calls, [120000]);

  // unbrauchbares waitMs fällt auf 60 s zurück
  for (const schlecht of [-1, NaN, Infinity, '5000', null]) {
    assert.deepEqual((await mitFolge('429-dann-200', { waitMs: schlecht })).sleep.calls, [60000], String(schlecht));
  }
});

test('fetchWithRetry: halbe Sekunden werden für die Anzeige aufgerundet', async () => {
  const { sleep, ereignisse } = await mitFolge('429-dann-200', { waitMs: 1500 });
  assert.deepEqual(sleep.calls, [1500]);
  assert.deepEqual(ereignisse, ['onWait:1500', 'onWaiting:{"s":2,"ms":1500}', 'sleep:1500']);
});

test('fetchWithRetry: ein werfender Beobachter stört den Abruf nicht', async () => {
  const f = fakeFetch([['/forecast', folge('429-dann-200')]]);
  const sleep = fakeSleep();
  const r = await weather.fetchWithRetry(RETRY_URL, {
    fetchImpl: f,
    sleep,
    onWait() { throw new Error('Oberfläche kaputt'); },
    onWaiting() { throw new Error('Oberfläche kaputt'); }
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sleep.calls, [60000]);
  assert.equal(f.count(), 2);
});

test('fetchWithRetry: Antworten ohne lesbare Köpfe warten das Mindestmaß, kein Wurf', async () => {
  const antworten = [
    { ok: false, status: 429, json: async () => ({}) },                                                 // gar keine Köpfe
    { ok: false, status: 429, headers: { get() { throw new Error('gesperrt'); } }, json: async () => ({}) },
    { ok: false, status: 429, headers: { get: () => undefined }, json: async () => ({}) }
  ];
  for (const erste of antworten) {
    let n = 0;
    const fetchImpl = async () => (n++ === 0 ? erste : { ok: true, status: 200, json: async () => ({ ok: 1 }) });
    const sleep = fakeSleep();
    const r = await weather.fetchWithRetry(RETRY_URL, { fetchImpl, sleep });
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { ok: 1 });
    assert.deepEqual(sleep.calls, [60000]);
    assert.equal(n, 2);
  }
});

test('fetchWithRetry: ohne eingespeistes sleep wartet es wirklich (setTimeout)', async () => {
  const f = fakeFetch([['/forecast', folge('429-dann-200')]]);
  const t0 = Date.now();
  const r = await weather.fetchWithRetry(RETRY_URL, { fetchImpl: f, waitMs: 30 });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 >= 20, 'es hat nicht gewartet');
  assert.equal(f.count(), 2);
});

// ---------------------------------------------------------------------------------------------
// load: der Normalfall
// ---------------------------------------------------------------------------------------------

test('load Bürg: Cache in der Form von Abschnitt 4, MOSMIX als [ms, °C], Station aus sources[0], keine Warnung', async () => {
  const f = dienste();
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: f, nowMs: BUERG_NOW_MS });
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(cache).sort(), ['alerts', 'alertsStatus', 'fetched', 'mos', 'mosStation', 'om', 'v']);
  assert.equal(cache.v, 2);
  assert.equal(cache.fetched, BUERG_NOW_MS);
  assert.deepEqual(cache.om, fixture('om-buerg-2026-10-09.json'), 'Open-Meteo roh, unverändert');
  assert.deepEqual(cache.mos, [[Date.UTC(2026, 9, 11, 0, 0), 9.9]]);
  assert.deepEqual(cache.mosStation, { name: 'BACKNANG', height: 291, distance: 7692 });
  assert.deepEqual(cache.alerts, []);
  assert.equal(cache.alertsStatus, 'none');

  // je Dienst genau eine Anfrage, Bright Sky mit der Zone aus der Open-Meteo-Antwort und dem Ortstag
  assert.equal(f.count(), 3);
  assert.equal(f.unmatched.length, 0);
  assert.equal(urlsMit(f, '/v1/forecast')[0], weather.omUrl(BUERG));
  assert.equal(urlsMit(f, '/weather?')[0],
    'https://api.brightsky.dev/weather?lat=48.881&lon=9.441&date=2026-10-08&last_date=2026-10-13&tz=Europe/Berlin');
  assert.equal(urlsMit(f, '/alerts?')[0], 'https://api.brightsky.dev/alerts?lat=48.881&lon=9.441');
});

test('load Bürg: das Modell verbindet MOSMIX über ms exakt, nur diese Stunde trägt einen Wert', async () => {
  const { cache } = await weather.load(BUERG, { fetchImpl: dienste(), nowMs: BUERG_NOW_MS });
  const m = weather.model(cache);
  const treffer = m.hours.filter((o) => o.mos !== null);
  assert.equal(treffer.length, 1);
  assert.equal(treffer[0].ms, Date.UTC(2026, 9, 11, 0, 0));
  assert.equal(treffer[0].mos, 9.9);
  assert.equal(treffer[0].h, 2, '00:00 UTC ist 02:00 in Berlin');
  assert.equal(m.days[treffer[0].dayIdx].key, '2026-10-11');
  assert.deepEqual(m.mosStation, { name: 'BACKNANG', height: 291, distance: 7692 });
  assert.equal(m.fetched, BUERG_NOW_MS);
});

test('load: fetched ist ohne nowMs die aktuelle Uhrzeit', async () => {
  const vor = Date.now();
  const { cache } = await weather.load(BUERG, { fetchImpl: dienste() });
  assert.ok(cache.fetched >= vor && cache.fetched <= Date.now());
});

test('load: fetched ist der Zeitpunkt der erfolgreichen Antwort, nicht der Start von load() (429 und 60 s)', async () => {
  // eine Uhr, die beim Warten weiterläuft
  let uhr = BUERG_NOW_MS;
  const sleep = async (ms) => { uhr += ms; };
  const f = dienste({ '/v1/forecast': folge('429-dann-200') });
  const { cache } = await weather.load(BUERG, { fetchImpl: f, sleep, now: () => uhr });
  assert.equal(cache.fetched, BUERG_NOW_MS + 60000);

  // ohne Warten: Start und Antwort fallen zusammen; now hat Vorrang vor nowMs
  uhr = BUERG_NOW_MS;
  const ohne = await weather.load(BUERG, { fetchImpl: dienste(), sleep, now: () => uhr, nowMs: 1 });
  assert.equal(ohne.cache.fetched, BUERG_NOW_MS);
  // eine Uhr, die Unsinn liefert, fällt auf die Gerätezeit zurück
  const vor = Date.now();
  const kaputt = await weather.load(BUERG, { fetchImpl: dienste(), now: () => 'bald' });
  assert.ok(kaputt.cache.fetched >= vor && kaputt.cache.fetched <= Date.now());
});

test('load: Eingabeort bleibt unverändert, und der Cache enthält weder Ortsnamen noch Adresse', async () => {
  const ort = { id: 'a1b2c3d4', label: 'Mama (Marktstraße 1)', lat: 48.881, lon: 9.441, elev: 414, elevAuto: false,
    cc: 'DE', tz: null, created: 1, heat: { type: 'radiator' } };
  const vorher = JSON.stringify(ort);
  const f = dienste();
  const { cache } = await weather.load(ort, { fetchImpl: f, nowMs: BUERG_NOW_MS });
  assert.equal(JSON.stringify(ort), vorher);
  assert.ok(!JSON.stringify(cache).includes('Marktstra'));
  assert.ok(!JSON.stringify(cache).includes('Mama'));
  // in keiner URL steht etwas anderes als gerundete Koordinaten, Höhe, Zeiten und die festen Variablenlisten
  for (const u of f.calls.map((c) => c.url)) {
    assert.ok(!u.includes('Mama') && !u.includes('Marktstra') && !u.includes('a1b2c3d4'), u);
    const q = new URL(u).searchParams;
    for (const k of ['latitude', 'longitude', 'lat', 'lon']) {
      if (q.has(k)) { assert.match(q.get(k), /^-?\d+\.\d{1,3}$/, k + ' in ' + u); }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// load: Warnungen
// ---------------------------------------------------------------------------------------------

test('load: echte DWD-Warnungen vom 10.10.2026 kommen wörtlich an, Null-Felder bleiben null', async () => {
  const roh = fixture('alerts-dwd-2026-10-10.json');
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: dienste({ '/alerts?': roh }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(problems, []);
  assert.equal(cache.alertsStatus, 'ok');
  assert.equal(cache.alerts.length, 17);
  roh.alerts.forEach((a, i) => {
    const w = cache.alerts[i];
    assert.deepEqual(Object.keys(w).sort(), ALERT_FIELDS.slice().sort());
    for (const k of ALERT_FIELDS) { assert.strictEqual(w[k], a[k], k + ' der Warnung ' + i); }
  });
  assert.equal(cache.alerts.filter((a) => a.expires === null).length, 7);
  assert.equal(cache.alerts.filter((a) => a.instruction_de === null).length, 7);
  assert.equal(cache.alerts[0].event_de, 'SCHWERE STURMBÖEN');
  assert.equal(cache.alerts[0].severity, 'moderate');
  // fremde Felder (id, warn_cell_ids, urgency …) fallen weg
  assert.ok(!('alert_id' in cache.alerts[0]) && !('warn_cell_ids' in cache.alerts[0]));
});

test('load: Warnungen mit fehlenden oder falschen Feldern ergeben null statt undefined, Nicht-Objekte fallen weg', async () => {
  const body = { alerts: [
    { event_de: 'FROST', headline_de: 'Amtliche WARNUNG vor FROST', severity: null, onset: 5, expires: undefined },
    null, 'x', 7,
    {}
  ] };
  const { cache } = await weather.load(BUERG, { fetchImpl: dienste({ '/alerts?': body }), nowMs: BUERG_NOW_MS });
  assert.equal(cache.alertsStatus, 'ok');
  assert.equal(cache.alerts.length, 2);
  assert.equal(cache.alerts[0].event_de, 'FROST');
  assert.equal(cache.alerts[0].onset, null, 'eine Zahl ist kein Zeitstempel');
  assert.equal(cache.alerts[0].expires, null);
  for (const k of ALERT_FIELDS) { assert.ok(cache.alerts[1][k] === null, k); }
});

test('load: 404 „not covered“ ist outside ohne Problem, die Warnungen bleiben null', async () => {
  const f = dienste({ '/alerts?': { status: 404, body: fixture('alerts-404-outside.json') } });
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: f, nowMs: BUERG_NOW_MS });
  assert.equal(cache.alertsStatus, 'outside');
  assert.equal(cache.alerts, null);
  assert.deepEqual(problems, []);
});

test('load: ein gescheiterter Warn-Abruf ist error mit Problem alertsFailed, Wetter und MOSMIX bleiben', async () => {
  for (const antwort of [{ status: 500 }, { status: 503, body: 'Wartung' }, { throws: true }, { status: 200, body: 'kein JSON' },
    { status: 200, body: { alerts: 'viele' } }]) {
    const { cache, problems } = await weather.load(BUERG, { fetchImpl: dienste({ '/alerts?': antwort }), nowMs: BUERG_NOW_MS });
    assert.equal(cache.alertsStatus, 'error', JSON.stringify(antwort));
    assert.equal(cache.alerts, null);
    assert.deepEqual(problems, ['alertsFailed']);
    assert.equal(cache.mosStation.name, 'BACKNANG');
    assert.equal(cache.om.timezone, 'Europe/Berlin');
  }
});

test('load: Warnungen werden nur für Deutschland oder ohne Land abgefragt', async () => {
  const kein = dienste();
  const { cache } = await weather.load(Object.assign({}, BUERG, { cc: 'CH' }), { fetchImpl: kein, nowMs: BUERG_NOW_MS });
  assert.equal(kein.count('/alerts?'), 0, 'außerhalb Deutschlands wird nichts angefragt');
  assert.equal(cache.alertsStatus, 'outside');
  assert.equal(cache.alerts, null);

  const unbekannt = dienste();
  await weather.load(Object.assign({}, BUERG, { cc: null }), { fetchImpl: unbekannt, nowMs: BUERG_NOW_MS });
  assert.equal(unbekannt.count('/alerts?'), 1, 'cc null (Standort ohne Reverse-Treffer): fragen');
});

// ---------------------------------------------------------------------------------------------
// load: MOSMIX und Bright-Sky-Null-Felder
// ---------------------------------------------------------------------------------------------

test('load: keine Station in Reichweite (404) ist mos leer ohne Problem', async () => {
  const f = dienste({ '/weather?': { status: 404, body: fixture('bs-404-nosource.json') } });
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: f, nowMs: BUERG_NOW_MS });
  assert.deepEqual(cache.mos, []);
  assert.equal(cache.mosStation, null);
  assert.deepEqual(problems, []);
  assert.equal(cache.alertsStatus, 'none', 'die Warnungen kommen trotzdem');
});

test('load: eine 404 ohne den erwarteten Text ist ein Fehler, nicht „keine Station“ oder „außerhalb“', async () => {
  for (const antwort of [{ status: 404 }, { status: 404, body: { detail: 'Not Found' } }, { status: 404, body: '<html>404</html>' },
    { status: 404, body: { detail: null } }]) {
    const w = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': antwort }), nowMs: BUERG_NOW_MS });
    assert.deepEqual(w.problems, ['mosFailed'], 'weather ' + JSON.stringify(antwort));
    assert.deepEqual(w.cache.mos, []);
    assert.equal(w.cache.mosStation, null);

    const a = await weather.load(BUERG, { fetchImpl: dienste({ '/alerts?': antwort }), nowMs: BUERG_NOW_MS });
    assert.equal(a.cache.alertsStatus, 'error', 'alerts ' + JSON.stringify(antwort));
    assert.equal(a.cache.alerts, null);
    assert.deepEqual(a.problems, ['alertsFailed']);
  }
  // die beiden echten Körper (KT §6.1, §6.2) bleiben „keine Station“ bzw. „außerhalb“, auch in anderer Schreibung
  const keine = await weather.load(BUERG, {
    fetchImpl: dienste({ '/weather?': { status: 404, body: { detail: 'no sources match your criteria' } } }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(keine.problems, []);
  const aussen = await weather.load(BUERG, {
    fetchImpl: dienste({ '/alerts?': { status: 404, body: fixture('alerts-404-outside.json') } }), nowMs: BUERG_NOW_MS });
  assert.equal(aussen.cache.alertsStatus, 'outside');
  assert.deepEqual(aussen.problems, []);
});

test('load: ein gescheiterter MOSMIX-Abruf ist mos leer mit Problem mosFailed, nie alte Werte', async () => {
  const kaputt = [{ status: 500 }, { status: 429 }, { throws: true }, { status: 200, body: 'kein JSON' },
    { status: 200, body: {} }, { status: 200, body: { weather: 'x' } }, { status: 200, body: [] }];
  for (const antwort of kaputt) {
    const { cache, problems } = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': antwort }), nowMs: BUERG_NOW_MS });
    assert.deepEqual(cache.mos, [], JSON.stringify(antwort));
    assert.equal(cache.mosStation, null);
    assert.deepEqual(problems, ['mosFailed']);
    assert.equal(cache.alertsStatus, 'none');
  }
});

test('load bs-fern: eine weit entfernte Station bleibt im Cache, die Entfernung entscheidet die Oberfläche', async () => {
  const f = dienste({ '/weather?': fixture('bs-fern.json') });
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: f, nowMs: BUERG_NOW_MS });
  assert.deepEqual(problems, []);
  assert.equal(cache.mosStation.distance, 40000);
  assert.ok(cache.mosStation.distance > 25000, 'weiter als die 25-km-Grenze der Legende');
  assert.equal(cache.mos.length, 1);
});

test('load: Bright-Sky-Null-Felder – Temperatur null, Stempel fehlt oder ist Unsinn, 0 °C zählt', async () => {
  const bs = fixture('bs-buerg.json');
  const rec = bs.weather[0];
  const mit = (extra) => Object.assign({}, rec, extra);
  bs.weather = [
    mit({ timestamp: '2026-10-11T00:00:00+00:00', temperature: null }),
    mit({ timestamp: '2026-10-11T01:00:00+00:00', temperature: 9.1, relative_humidity: null, wind_gust_speed: null, wind_gust_direction: null }),
    mit({ timestamp: null, temperature: 5 }),
    mit({ timestamp: undefined, temperature: 4 }),
    mit({ timestamp: 'unsinn', temperature: 3 }),
    mit({ timestamp: '2026-10-11T02:00:00+00:00', temperature: 'warm' }),
    mit({ timestamp: '2026-10-11T03:00:00+00:00', temperature: 0 }),
    mit({ timestamp: '2026-10-11T04:00:00+00:00', temperature: -3.5 }),
    mit({ timestamp: '2026-10-11T05:00:00+00:00', temperature: NaN }),
    null, 'x', 5
  ];
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': bs }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(problems, []);
  assert.deepEqual(cache.mos, [[Date.UTC(2026, 9, 11, 1, 0), 9.1], [Date.UTC(2026, 9, 11, 3, 0), 0], [Date.UTC(2026, 9, 11, 4, 0), -3.5]]);
  assert.ok(cache.mos.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));

  // 0 °C und −3,5 °C kommen im Modell an (nicht als „kein Wert“)
  const m = weather.model(cache);
  const werte = m.hours.filter((o) => o.mos !== null).map((o) => o.mos);
  assert.deepEqual(werte, [9.1, 0, -3.5]);
});

test('load: Station mit null in Name oder Höhe ist erlaubt, ohne Entfernung ist die Antwort unbrauchbar', async () => {
  const mitNull = fixture('bs-buerg.json');
  mitNull.sources[0].station_name = null;
  mitNull.sources[0].height = null;
  const a = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': mitNull }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(a.cache.mosStation, { name: '', height: null, distance: 7692 });
  assert.equal(a.cache.mos.length, 1);
  assert.deepEqual(a.problems, []);

  const ohneEntfernung = fixture('bs-buerg.json');
  ohneEntfernung.sources[0].distance = null;
  const b = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': ohneEntfernung }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(b.cache.mos, []);
  assert.equal(b.cache.mosStation, null);
  assert.deepEqual(b.problems, ['mosFailed']);

  const ohneQuellen = fixture('bs-buerg.json');
  ohneQuellen.sources = [];
  const c = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': ohneQuellen }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(c.cache.mos, []);
  assert.deepEqual(c.problems, ['mosFailed']);

  // eine leere Antwort (200 ohne Einträge) ist „keine Daten“, kein Fehler
  const leer = fixture('bs-buerg.json');
  leer.weather = [];
  const d = await weather.load(BUERG, { fetchImpl: dienste({ '/weather?': leer }), nowMs: BUERG_NOW_MS });
  assert.deepEqual(d.cache.mos, []);
  assert.equal(d.cache.mosStation, null);
  assert.deepEqual(d.problems, []);
});

// ---------------------------------------------------------------------------------------------
// load: andere Länder und Zonen
// ---------------------------------------------------------------------------------------------

test('load Wien: DACH-Modell, Zone Europe/Vienna in der URL, keine Warnungs-Anfrage, Station WIEN/CITY', async () => {
  const f = dienste({ '/v1/forecast': fixture('om-wien.json'), '/weather?': fixture('bs-wien.json') });
  const nowMs = Date.UTC(2026, 0, 13, 9, 0);
  const { cache, problems } = await weather.load(WIEN, { fetchImpl: f, nowMs });
  assert.deepEqual(problems, []);
  assert.equal(new URL(urlsMit(f, '/v1/forecast')[0]).searchParams.get('models'), 'icon_seamless');
  assert.equal(urlsMit(f, '/weather?')[0],
    'https://api.brightsky.dev/weather?lat=48.208&lon=16.374&date=2026-01-12&last_date=2026-01-17&tz=Europe/Vienna');
  assert.equal(f.count('/alerts?'), 0);
  assert.equal(weather.bsUrls(WIEN, 'Europe/Vienna', nowMs).alerts, null);
  assert.equal(cache.alertsStatus, 'outside');
  assert.deepEqual(cache.mosStation, { name: 'WIEN/CITY', height: 171, distance: 955 });
  assert.ok(cache.mosStation.distance <= 25000, 'nah genug für die Linie');
  assert.equal(weather.model(cache).tz, 'Europe/Vienna');
});

test('load Lissabon: best_match, Ortstag aus der Zone der Antwort (um 23:30 UTC noch der 13.)', async () => {
  const f = dienste({ '/v1/forecast': fixture('om-lissabon.json'), '/weather?': { status: 404, body: fixture('bs-404-nosource.json') } });
  const nowMs = Date.UTC(2026, 0, 13, 23, 30);
  const { cache, problems } = await weather.load(LISSABON, { fetchImpl: f, nowMs });
  assert.deepEqual(problems, []);
  const om = new URL(urlsMit(f, '/v1/forecast')[0]).searchParams;
  assert.equal(om.get('models'), 'best_match');
  assert.equal(om.has('elevation'), false);
  // dieselbe Uhrzeit in Berlin wäre schon der 14.: dort begänne das Fenster einen Tag später
  assert.equal(urlsMit(f, '/weather?')[0],
    'https://api.brightsky.dev/weather?lat=38.722&lon=-9.139&date=2026-01-12&last_date=2026-01-17&tz=Europe/Lisbon');
  assert.ok(weather.bsUrls(LISSABON, BERLIN, nowMs).mos.includes('&date=2026-01-13&'));
  assert.equal(f.count('/alerts?'), 0);
  assert.equal(cache.mosStation, null);
  assert.equal(weather.model(cache).tz, 'Europe/Lisbon');
});

test('load: unbekannte Zone meldet tzUnknown und rechnet mit dem festen Offset der Antwort', async () => {
  const om = fixture('om-mild.json');
  om.timezone = 'Mars/Olympus';
  om.utc_offset_seconds = 7200;
  const f = dienste({ '/v1/forecast': om });
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: f, nowMs: JAN13_MS });
  assert.deepEqual(problems, ['tzUnknown']);
  assert.ok(urlsMit(f, '/weather?')[0].endsWith('&tz=Etc/GMT-2'), urlsMit(f, '/weather?')[0]);
  assert.equal(cache.om.timezone, 'Mars/Olympus', 'der Cache bleibt Open-Meteo roh');
  const m = weather.model(cache);
  assert.equal(m.tz, 'Etc/GMT-2');
  assert.equal(m.hours.length, 120);

  // halbe Stunde Offset: kein Etc/GMT-Name möglich, also UTC
  const indien = fixture('om-mild.json');
  indien.timezone = 'Mars/Olympus';
  indien.utc_offset_seconds = 19800;
  const r = await weather.load(BUERG, { fetchImpl: dienste({ '/v1/forecast': indien }), nowMs: JAN13_MS });
  assert.deepEqual(r.problems, ['tzUnknown']);
  assert.equal(weather.model(r.cache).tz, 'UTC');

  // fehlt die Zone ganz, ist es dasselbe
  const ohne = fixture('om-mild.json');
  delete ohne.timezone;
  const s = await weather.load(BUERG, { fetchImpl: dienste({ '/v1/forecast': ohne }), nowMs: JAN13_MS });
  assert.deepEqual(s.problems, ['tzUnknown']);
});

// ---------------------------------------------------------------------------------------------
// load: Open-Meteo scheitert
// ---------------------------------------------------------------------------------------------

async function omFehler(antwort, opts) {
  const f = dienste({ '/v1/forecast': antwort });
  let gefangen = null;
  try {
    // sleep ist immer eingespeist: ein 429 würde sonst wirklich 60 s warten
    await weather.load(BUERG, Object.assign({ fetchImpl: f, nowMs: BUERG_NOW_MS, sleep: fakeSleep() }, opts || {}));
  } catch (e) {
    gefangen = e;
  }
  assert.ok(gefangen, 'load hätte werfen müssen: ' + JSON.stringify(antwort));
  assert.ok(gefangen instanceof Error);
  assert.ok(gefangen instanceof weather.OpenMeteoError);
  assert.equal(gefangen.name, 'OpenMeteoError');
  assert.equal(f.count('brightsky'), 0, 'ohne Open-Meteo wird Bright Sky nicht gefragt, es gäbe keine Zone');
  return gefangen;
}

test('load: OpenMeteoError mit Code – rate bei 429, http bei anderen Status, invalid bei Fehlerantworten', async () => {
  assert.equal((await omFehler({ status: 429 })).code, 'rate');
  assert.equal((await omFehler({ status: 429, body: { error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' } })).code, 'rate');
  assert.equal((await omFehler({ status: 500 })).code, 'http');
  assert.equal((await omFehler({ status: 503, body: 'Wartung' })).code, 'http');
  assert.equal((await omFehler({ status: 404, body: { detail: 'weg' } })).code, 'http');

  const e = await omFehler({ status: 400, body: fixture('om-error.json') });
  assert.equal(e.code, 'invalid');
  assert.ok(e.message.includes('ForecastVariable'), 'die Begründung von Open-Meteo steht in der Meldung');
});

test('load: auch eine 200-Antwort kann ungültig sein – Fehlerkennzeichen, kein hourly, leere Stunden, kein JSON', async () => {
  assert.equal((await omFehler(fixture('om-error.json'))).code, 'invalid');
  assert.equal((await omFehler({ latitude: 48.88 })).code, 'invalid');
  assert.equal((await omFehler({ hourly: {} })).code, 'invalid');
  assert.equal((await omFehler({ hourly: { time: [] } })).code, 'invalid');
  assert.equal((await omFehler({ hourly: { time: 'x' } })).code, 'invalid');
  assert.equal((await omFehler({ status: 200, body: '<html>Anmeldung im WLAN</html>' })).code, 'invalid');
  assert.equal((await omFehler({ status: 200, body: 'null' })).code, 'invalid');
});

test('load: kein Netz ist offline, keine Antwort in der Frist ist timeout', async () => {
  assert.equal((await omFehler({ throws: true })).code, 'offline');

  const haengt = haengendesFetch();
  let fehler = null;
  try {
    await weather.load(BUERG, { fetchImpl: haengt, nowMs: BUERG_NOW_MS, timeoutMs: 20 });
  } catch (e) {
    fehler = e;
  }
  assert.ok(fehler instanceof weather.OpenMeteoError);
  assert.equal(fehler.code, 'timeout');
  assert.equal(haengt.signals.length, 1, 'nur der Open-Meteo-Abruf lief');
});

test('load: ein Ort ohne Koordinaten wirft invalid, bevor irgendetwas gesendet wird', async () => {
  for (const ort of [null, undefined, {}, { lat: 48.88 }, { lat: NaN, lon: 9 }, { lat: '48.88', lon: '9.44' }]) {
    const f = dienste();
    await assert.rejects(weather.load(ort, { fetchImpl: f }), (e) => e instanceof weather.OpenMeteoError && e.code === 'invalid');
    assert.equal(f.count(), 0);
  }
});

// ---------------------------------------------------------------------------------------------
// load: HTTP 429 von Open-Meteo
// ---------------------------------------------------------------------------------------------

test('load: 429, dann 200 – der Cache kommt an, genau ein sleep(60000), Bright Sky läuft erst danach, je Dienst einmal', async () => {
  for (const name of ['429-dann-200', '429-tageslimit-dann-200']) {
    const f = dienste({ '/v1/forecast': folge(name) });
    const sleep = fakeSleep();
    const gemeldet = [];
    const { cache, problems } = await weather.load(BUERG, {
      fetchImpl: f,
      sleep,
      nowMs: BUERG_NOW_MS,
      onWait: (ms) => gemeldet.push(['onWait', ms]),
      onWaiting: (e) => gemeldet.push(['onWaiting', e])
    });
    assert.deepEqual(cache.om, fixture('om-buerg-2026-10-09.json'), name);
    assert.deepEqual(problems, [], name);
    assert.deepEqual(sleep.calls, [60000], name);
    assert.deepEqual(gemeldet, [['onWait', 60000], ['onWaiting', { s: 60, ms: 60000 }]], name);
    assert.equal(urlsMit(f, '/v1/forecast').length, 2, name);
    assert.equal(urlsMit(f, '/weather?').length, 1, name);
    assert.equal(urlsMit(f, '/alerts?').length, 1, name);
    assert.deepEqual(f.calls.slice(0, 2).map((c) => c.url.includes('/v1/forecast')), [true, true], name + ': Bright Sky erst nach der Antwort');
  }
});

test('load: 429, dann 429 – OpenMeteoError „rate“, ein sleep, zwei Abrufe, Bright Sky wird nicht gefragt', async () => {
  const f = dienste({ '/v1/forecast': folge('429-dann-429') });
  const sleep = fakeSleep();
  await assert.rejects(weather.load(BUERG, { fetchImpl: f, sleep, nowMs: BUERG_NOW_MS }), (e) => {
    assert.ok(e instanceof weather.OpenMeteoError);
    assert.equal(e.code, 'rate');
    assert.ok(e.message.includes('429'), e.message);
    return true;
  });
  assert.deepEqual(sleep.calls, [60000]);
  assert.equal(urlsMit(f, '/v1/forecast').length, 2);
  assert.equal(f.count('brightsky'), 0);
});

test('load: Retry-After 30 wartet 60 s, 90 wartet 90 s, 300 wartet 120 s', async () => {
  for (const [name, soll] of [['retry-after-30', 60000], ['retry-after-90', 90000], ['retry-after-300', 120000]]) {
    const f = dienste({ '/v1/forecast': folge(name) });
    const sleep = fakeSleep();
    const gemeldet = [];
    const { cache } = await weather.load(BUERG, { fetchImpl: f, sleep, nowMs: BUERG_NOW_MS, onWaiting: (e) => gemeldet.push(e) });
    assert.deepEqual(cache.om, fixture('om-buerg-2026-10-09.json'), name);
    assert.deepEqual(sleep.calls, [soll], name);
    assert.deepEqual(gemeldet, [{ s: soll / 1000, ms: soll }], name);
  }
});

test('load: 5xx von Open-Meteo wird nicht wiederholt, ein 429 von Bright Sky auch nicht', async () => {
  const f5 = dienste({ '/v1/forecast': folge('500-dann-200') });
  const s5 = fakeSleep();
  await assert.rejects(weather.load(BUERG, { fetchImpl: f5, sleep: s5, nowMs: BUERG_NOW_MS }),
    (e) => e instanceof weather.OpenMeteoError && e.code === 'http');
  assert.equal(s5.count, 0);
  assert.equal(urlsMit(f5, '/v1/forecast').length, 1);

  const fb = dienste({ '/weather?': { status: 429 }, '/alerts?': { status: 429 } });
  const sb = fakeSleep();
  const { cache, problems } = await weather.load(BUERG, { fetchImpl: fb, sleep: sb, nowMs: BUERG_NOW_MS });
  assert.deepEqual(problems, ['mosFailed', 'alertsFailed']);
  assert.deepEqual(cache.mos, []);
  assert.equal(sb.count, 0);
  assert.equal(urlsMit(fb, '/weather?').length, 1);
  assert.equal(urlsMit(fb, '/alerts?').length, 1);
  assert.equal(urlsMit(fb, '/v1/forecast').length, 1);
});

// ---------------------------------------------------------------------------------------------
// Modell
// ---------------------------------------------------------------------------------------------

test('Modell om-buerg-2026-10-09: 120 Stunden, 5 Tage, Tageswerte über daily zugeordnet', () => {
  const m = modelOf('om-buerg-2026-10-09.json');
  assert.equal(m.tz, 'Europe/Berlin');
  assert.equal(m.hours.length, 120);
  assert.equal(m.days.length, 5);
  assert.equal(m.gaps, 0);
  assert.deepEqual(m.days.map((d) => d.key), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  assert.deepEqual(m.days.map((d) => d.idx), [0, 1, 2, 3, 4]);
  assert.deepEqual(Object.keys(m).sort(), ['alerts', 'current', 'days', 'fetched', 'gaps', 'hours', 'mosStation', 'tz']);
  assert.deepEqual(Object.keys(m.hours[0]).sort(),
    ['app', 'cc', 'code', 'dayIdx', 'dew', 'gust', 'h', 'isDay', 'mos', 'ms', 'pp', 'pr', 'rh', 'sw', 'temp', 'wind']);
  assert.deepEqual(Object.keys(m.days[0]).sort(),
    ['code', 'gt', 'gust', 'idx', 'key', 'max', 'mean', 'min', 'partial', 'rain', 'sun', 'sunriseMs', 'sunsetMs']);
  assert.ok(m.days.every((d) => d.partial === false), 'fünf ganze Tage');
  assert.equal(m.alerts, null, 'der Cache hat keine Warnungen');

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

test('Modell om-null: Stunden ohne Temperatur fallen weg, gaps zählt, kein NaN, kein Absturz', () => {
  const m = modelOf('om-null.json');
  assert.equal(m.hours.length, 115);
  assert.equal(m.gaps, 5);
  for (const d of m.days) { assert.ok(Number.isFinite(d.mean) && Number.isFinite(d.gt), d.key); }
  for (const o of m.hours) { assert.ok(Number.isFinite(o.temp) && Number.isFinite(o.ms), 'Stunde ' + o.ms); }
  // am Tag 2 fehlen 03, 04 und 05 Uhr
  const h2 = m.hours.filter((o) => o.dayIdx === 2).map((o) => o.h);
  assert.equal(h2.length, 21);
  assert.ok(!h2.includes(3) && !h2.includes(4) && !h2.includes(5));
  // fehlende Windwerte bleiben null, die Stunde selbst bleibt
  assert.equal(m.hours.filter((o) => o.wind === null).length, 1);
  assert.equal(m.hours.filter((o) => o.gust === null).length, 1);
  // die fünf Tage bleiben, auch am Tag mit der Lücke ist die Ortsstunde der Nachbarn richtig
  assert.deepEqual(m.days.map((d) => d.key), ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16']);
  assert.equal(m.hours.find((o) => o.dayIdx === 2 && o.h === 6).ms, Date.UTC(2026, 0, 14, 5, 0));
});

test('Modell om-null: fehlende Spalten und Werte der Gruppen werfen nicht', () => {
  const om = fixture('om-null.json');
  delete om.hourly.dew_point_2m;
  om.hourly.cloud_cover = om.hourly.cloud_cover.slice(0, 10);          // kürzer als time
  om.hourly.weather_code[3] = 'x';
  delete om.daily;
  delete om.current;
  const m = weather.model(cacheOf(om));
  assert.equal(m.hours.length, 115);
  assert.ok(m.hours.every((o) => o.dew === null));
  assert.equal(m.hours[50].cc, null);
  assert.equal(m.hours[3].code, null);
  assert.equal(m.current, null);
  assert.ok(m.days.every((d) => d.max === null && d.sunriseMs === null));
  assert.ok(m.days.every((d) => Number.isFinite(d.mean)));
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
  assert.equal(weather.tzSafe('Mars/Olympus', -18000), 'Etc/GMT+5');
  assert.equal(weather.tzSafe(undefined, undefined), 'UTC');
  assert.equal(weather.tzSafe(null, 3600), 'Etc/GMT-1');
  assert.equal(weather.tzSafe('', 3600), 'Etc/GMT-1');
  assert.equal(weather.tzSafe(42, 'x'), 'UTC');
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

// ---------------------------------------------------------------------------------------------
// Ortszeit
// ---------------------------------------------------------------------------------------------

test('Ortszeit-Felder: dayIdx, h und key stimmen mit der Soll-Ortszeit jeder Fixture überein (jede Prozess-TZ)', () => {
  const faelle = [
    { name: 'om-buerg-2026-10-09.json', lens: [24, 24, 24, 24, 24], tz: BERLIN },
    { name: 'om-frost.json', lens: [24, 24, 24, 24, 24], tz: BERLIN },
    { name: 'om-lissabon.json', lens: [24, 24, 24, 24, 24], tz: 'Europe/Lisbon' },
    { name: 'om-wien.json', lens: [24, 24, 24, 24, 24], tz: 'Europe/Vienna' },
    { name: 'om-dst.json', lens: [24, 25, 24, 24, 24], tz: BERLIN }
  ];
  for (const fall of faelle) {
    const om = fixture(fall.name);
    const m = weather.model(cacheOf(om));
    const soll = sollOrtszeit(fall.lens);
    assert.equal(m.tz, fall.tz, fall.name);
    assert.equal(m.hours.length, soll.length, fall.name);
    assert.deepEqual(m.hours.map((o) => [o.dayIdx, o.h]), soll, fall.name);
    assert.deepEqual(m.hours.map((o) => o.ms), om.hourly.time.map((t) => t * 1000), fall.name + ': ms = Sekunden · 1000');
    // der Schlüssel jeder Stunde passt zu ihrem Tag; die Tage sind lückenlos aufeinanderfolgende Kalendertage
    m.hours.forEach((o) => assert.equal(weather.dayKeyOf(o.ms, m.tz), m.days[o.dayIdx].key, fall.name));
    m.days.forEach((d, i) => {
      assert.equal(d.idx, i);
      if (i) { assert.equal(Date.parse(d.key + 'T00:00:00Z') - Date.parse(m.days[i - 1].key + 'T00:00:00Z'), 24 * HOUR, fall.name); }
    });
  }
});

test('Ortszeit kommt aus om.timezone, nicht aus dem Prozess: dieselben Zeitpunkte, andere Zone, andere Stunde', () => {
  // Lissabon im Januar (UTC+0), gedeutet als Berlin (UTC+1): eine Stunde später, der Tagesschnitt wandert mit
  const lisbon = fixture('om-lissabon.json');
  const alsLissabon = weather.model(cacheOf(lisbon));
  const alsBerlin = weather.model(cacheOf(Object.assign({}, lisbon, { timezone: BERLIN, utc_offset_seconds: 3600 })));
  assert.equal(alsLissabon.hours[0].h, 0);
  assert.equal(alsBerlin.hours[0].h, 1);
  assert.equal(alsBerlin.hours[0].ms, alsLissabon.hours[0].ms);
  assert.equal(alsLissabon.days.length, 5);
  assert.equal(alsBerlin.days.length, 6, '120 Stunden ab 01:00 reichen in einen sechsten Tag');
  assert.deepEqual(alsBerlin.hours.filter((o) => o.dayIdx === 0).map((o) => o.h), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.equal(alsBerlin.hours.filter((o) => o.dayIdx === 5).length, 1);

  // Lissabon im Oktober hat Sommerzeit (UTC+1): die Bürg-Antwort beginnt dann um 23 Uhr des Vortags
  const buerg = fixture('om-buerg-2026-10-09.json');
  const lissOkt = weather.model(cacheOf(Object.assign({}, buerg, { timezone: 'Europe/Lisbon', utc_offset_seconds: 3600 })));
  assert.equal(lissOkt.hours[0].ms, Date.UTC(2026, 9, 7, 22, 0));
  assert.equal(lissOkt.hours[0].h, 23);
  assert.equal(lissOkt.days[0].key, '2026-10-07');
  assert.equal(lissOkt.hours.filter((o) => o.dayIdx === 0).length, 1);
  assert.equal(lissOkt.hours[1].h, 0);
  assert.equal(lissOkt.days[1].key, '2026-10-08');

  // New York (UTC−4 im Oktober): Ortsstunde 18 liegt bei 22:00 UTC
  const ny = weather.model(cacheOf(Object.assign({}, buerg, { timezone: 'America/New_York', utc_offset_seconds: -14400 })));
  assert.equal(ny.hours[0].h, 18);
  assert.equal(ny.days[0].key, '2026-10-07');
});

test('om-lissabon: Nachtfenster 18–9 liegt auf Ortsstunden, localNow weicht von Berlin ab', () => {
  const m = modelOf('om-lissabon.json');
  assert.equal(m.tz, 'Europe/Lisbon');
  assert.equal(m.hours[0].ms, Date.UTC(2026, 0, 12, 0, 0));
  assert.equal(m.days[0].key, '2026-01-12');
  assert.equal(m.hours.find((o) => o.dayIdx === 1 && o.h === 18).ms, Date.UTC(2026, 0, 13, 18, 0), '18 Uhr in Lissabon = 18 Uhr UTC im Januar');
  const nacht = nachtVonTag1(m);
  assert.deepEqual(nacht.map((o) => o.h), [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const spaet = Date.UTC(2026, 0, 13, 23, 30);
  assert.deepEqual(weather.localNow('Europe/Lisbon', spaet), { key: '2026-01-13', h: 23, min: 30, ms: spaet });
  assert.deepEqual(weather.localNow(BERLIN, spaet), { key: '2026-01-14', h: 0, min: 30, ms: spaet });
  assert.equal(weather.dayKeyOf(spaet, 'Europe/Lisbon'), '2026-01-13');
  assert.equal(weather.dayKeyOf(spaet, BERLIN), '2026-01-14');
});

// Die Ortsstunden 18 bis 9 der Nacht von Tag 1, wie heat.night sie wählt (hier nur zur Probe der Ortsstunden)
function nachtVonTag1(m) {
  return Heizwarte.heat.night(m.hours, 1).hs;
}

test('om-dst: 25.10.2026 hat 25 Stunden ohne Sprung, Stunde 2 kommt zweimal, kein doppelter Tag', () => {
  const om = fixture('om-dst.json');
  const m = weather.model(cacheOf(om));
  assert.equal(m.tz, 'Europe/Berlin');
  assert.equal(om.utc_offset_seconds, 7200, 'die Antwort behält den Offset von vor der Umstellung (KT §5.1)');
  assert.deepEqual(m.days.map((d) => d.key), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(m.days.map((d) => m.hours.filter((o) => o.dayIdx === d.idx).length), [24, 25, 24, 24, 24]);

  const tag = m.hours.filter((o) => o.dayIdx === 1);
  assert.deepEqual(tag.map((o) => o.h), [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  // 02:00 CEST und 02:00 CET sind zwei Zeitpunkte im Abstand einer Stunde
  const zwei = tag.filter((o) => o.h === 2);
  assert.equal(zwei[0].ms, Date.UTC(2026, 9, 25, 0, 0));
  assert.equal(zwei[1].ms, Date.UTC(2026, 9, 25, 1, 0));
  // die Zeitpunkte sind lückenlos stündlich: kein Sprung, keine Dopplung
  m.hours.forEach((o, i) => { if (i) { assert.equal(o.ms - m.hours[i - 1].ms, HOUR, 'Stunde ' + i); } });
  // die Ortsstunde springt nur zurück, nie vor: sie steigt um 1, bleibt einmal gleich (2, 2) und beginnt täglich bei 0
  m.hours.forEach((o, i) => {
    if (!i) { return; }
    const v = m.hours[i - 1];
    const schritt = o.dayIdx === v.dayIdx ? o.h - v.h : o.h - v.h + 24;
    assert.ok(schritt === 1 || (schritt === 0 && o.h === 2 && o.dayIdx === 1), 'Ortsstunde ' + v.h + ' → ' + o.h + ' bei ' + i);
  });

  // daily folgt dem festen Offset der Antwort, landet aber an jedem Tag richtig (Mittagsregel)
  assert.deepEqual(m.days.map((d) => d.max), om.daily.temperature_2m_max);
  assert.deepEqual(m.days.map((d) => d.min), om.daily.temperature_2m_min);
  for (const d of m.days) {
    assert.equal(weather.dayKeyOf(d.sunriseMs, m.tz), d.key, 'Sonnenaufgang von ' + d.key);
    assert.equal(weather.dayKeyOf(d.sunsetMs, m.tz), d.key, 'Sonnenuntergang von ' + d.key);
  }
  // Tagesmittel mit 25 Werten
  near(m.days[1].mean, tag.reduce((s, o) => s + o.temp, 0) / 25);
});

test('localNow und dayKeyOf rund um die Umstellungen 2026 in Berlin', () => {
  const at = (y, mo, d, h, mi) => weather.localNow(BERLIN, Date.UTC(y, mo, d, h, mi));
  // Herbst: 25.10. um 03:00 CEST (01:00 UTC) wird wieder 02:00 CET
  assert.deepEqual([at(2026, 9, 24, 23, 59).key, at(2026, 9, 24, 23, 59).h], ['2026-10-25', 1]);
  assert.deepEqual([at(2026, 9, 25, 0, 30).h, at(2026, 9, 25, 0, 30).min], [2, 30], '02:30 CEST');
  assert.deepEqual([at(2026, 9, 25, 1, 30).h, at(2026, 9, 25, 1, 30).min], [2, 30], '02:30 CET');
  assert.deepEqual([at(2026, 9, 25, 2, 0).h, at(2026, 9, 25, 2, 0).min], [3, 0]);
  assert.equal(at(2026, 9, 25, 22, 59).key, '2026-10-25');
  assert.equal(at(2026, 9, 25, 23, 0).key, '2026-10-26');
  // Frühjahr: 29.03. um 02:00 CET (01:00 UTC) wird 03:00 CEST, die Stunde 2 gibt es nicht
  assert.deepEqual([at(2026, 2, 29, 0, 59).h, at(2026, 2, 29, 0, 59).min], [1, 59]);
  assert.deepEqual([at(2026, 2, 29, 1, 0).h, at(2026, 2, 29, 1, 0).min], [3, 0]);
  assert.equal(weather.dayKeyOf(Date.UTC(2026, 2, 28, 23, 0), BERLIN), '2026-03-29');
});

test('localNow und dayKeyOf: Etc/GMT-2 wie Berlin im Sommer, halbe Stunden in Indien, ms bleibt erhalten', () => {
  // das Beispiel aus Abschnitt 12: 23:30 UTC am 11.10. ist 01:30 am 12.10. bei UTC+2
  assert.deepEqual(weather.localNow('Etc/GMT-2', Date.UTC(2026, 9, 11, 23, 30)),
    { key: '2026-10-12', h: 1, min: 30, ms: Date.UTC(2026, 9, 11, 23, 30) });
  assert.deepEqual(weather.localNow('Etc/GMT-2', Date.UTC(2026, 9, 11, 23, 30)),
    weather.localNow(BERLIN, Date.UTC(2026, 9, 11, 23, 30)));
  // Indien: UTC+5:30
  const kurzVor = Date.UTC(2026, 9, 11, 18, 29, 59, 999);
  assert.deepEqual(weather.localNow('Asia/Kolkata', kurzVor), { key: '2026-10-11', h: 23, min: 59, ms: kurzVor });
  assert.deepEqual(weather.localNow('Asia/Kolkata', kurzVor + 1), { key: '2026-10-12', h: 0, min: 0, ms: kurzVor + 1 });
  // Datumsgrenze: Auckland und Honolulu zur selben Sekunde an verschiedenen Tagen
  const t = Date.UTC(2026, 0, 13, 20, 0);
  assert.equal(weather.dayKeyOf(t, 'Pacific/Auckland'), '2026-01-14');
  assert.equal(weather.dayKeyOf(t, 'Pacific/Honolulu'), '2026-01-13');
  assert.equal(weather.dayKeyOf(t, 'UTC'), '2026-01-13');
});

test('localNow und dayKeyOf: tz null, undefined oder unbekannt rechnen in UTC, unter jeder Prozess-Zeitzone gleich', () => {
  // Place.tz ist null bis zur ersten Open-Meteo-Antwort; das darf weder werfen noch die Gerätezone nehmen
  const t = Date.UTC(2026, 9, 11, 23, 30);
  const soll = { key: '2026-10-11', h: 23, min: 30, ms: t };
  const alt = process.env.TZ;
  try {
    for (const zone of ['Pacific/Auckland', 'America/New_York', 'Asia/Kolkata', 'Europe/Berlin', 'UTC']) {
      process.env.TZ = zone;
      for (const tz of [null, undefined, '', 'Mars/Olympus', 42]) {
        assert.deepEqual(weather.localNow(tz, t), soll, zone + ' / ' + String(tz));
        assert.equal(weather.dayKeyOf(t, tz), '2026-10-11', zone + ' / ' + String(tz));
      }
    }
  } finally {
    if (alt === undefined) { delete process.env.TZ; } else { process.env.TZ = alt; }
  }
});

test('Modell: Warnungen aus dem Cache bekommen expiresMs, die Felder bleiben wörtlich', () => {
  const alle = fixture('alerts-dwd-2026-10-10.json').alerts;
  const vorher = JSON.stringify(alle);
  const m = modelOf('om-buerg-2026-10-09.json', { alerts: alle });
  assert.equal(JSON.stringify(alle), vorher, 'der Cache bleibt unverändert');
  assert.equal(m.alerts.length, 17);
  m.alerts.forEach((a, i) => {
    for (const k of ALERT_FIELDS) { assert.equal(a[k], alle[i][k], k); }
    assert.equal(a.expiresMs, alle[i].expires === null ? null : Date.parse(alle[i].expires));
  });
  assert.equal(m.alerts[0].expiresMs, Date.UTC(2026, 9, 11, 9, 0));
  assert.equal(m.alerts.filter((a) => a.expiresMs === null).length, 7);

  // unlesbarer Stempel gilt wie null; Nicht-Objekte fallen weg; ohne Warnungen null, leere Liste bleibt leer
  const odd = modelOf('om-mild.json', { alerts: [{ event_de: 'STURM', expires: 'bald' }, null, 3, { event_de: 'FROST' }] });
  assert.deepEqual(odd.alerts.map((a) => [a.event_de, a.expiresMs]), [['STURM', null], ['FROST', null]]);
  assert.equal(modelOf('om-mild.json').alerts, null);
  assert.deepEqual(modelOf('om-mild.json', { alerts: [] }).alerts, []);
});

test('Modell: leere oder kaputte Antwort wirft nicht und liefert ein leeres Modell', () => {
  for (const om of [{}, { hourly: {} }, { hourly: { time: [] } }, { hourly: { time: [1], temperature_2m: [null] } },
    { hourly: { time: ['x', null, NaN], temperature_2m: [1, 2, 3] } }]) {
    const m = weather.model(cacheOf(om));
    assert.equal(m.days.length, 0);
    assert.equal(m.hours.length, 0);
    assert.equal(m.current, null);
  }
  assert.doesNotThrow(() => weather.model(null));
  assert.doesNotThrow(() => weather.model({}));
  assert.equal(weather.model(null).fetched, null);
  assert.equal(weather.model({ v: 2, om: {}, fetched: 'gestern' }).fetched, null);
});

// ---------------------------------------------------------------------------------------------
// Zeitzonenunabhängigkeit
// ---------------------------------------------------------------------------------------------

test('Beweis: Modell, Adressen und load sind unter jeder Prozess-Zeitzone gleich', async () => {
  const namen = ['om-buerg-2026-10-09.json', 'om-frost.json', 'om-lissabon.json', 'om-wien.json', 'om-dst.json', 'om-null.json'];
  const zeiten = [JAN13_MS, BUERG_NOW_MS, Date.UTC(2026, 9, 24, 23, 59), Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30),
    Date.UTC(2026, 2, 29, 0, 59), Date.UTC(2026, 2, 29, 1, 0), Date.UTC(2026, 11, 31, 23, 30)];
  const zonen = [BERLIN, 'Europe/Lisbon', 'Pacific/Auckland', 'Asia/Kolkata', 'America/New_York', 'Etc/GMT-2', 'UTC'];

  async function rechne() {
    const f = dienste({ '/weather?': fixture('bs-buerg.json'), '/alerts?': fixture('alerts-dwd-2026-10-10.json') });
    const geladen = await weather.load(BUERG, { fetchImpl: f, nowMs: BUERG_NOW_MS });
    return JSON.stringify({
      modelle: namen.map((n) => modelOf(n)),
      jetzt: zeiten.map((t) => zonen.map((z) => [weather.localNow(z, t), weather.dayKeyOf(t, z), weather.bsUrls(BUERG, z, t)])),
      geladen,
      urls: f.calls.map((c) => c.url)
    });
  }

  const vorher = await rechne();
  const alt = process.env.TZ;
  // Versatz einer Beispielzeit in Minuten, damit der Test merkt, wenn der Wechsel nicht greift
  const erwartet = { 'Pacific/Auckland': -780, 'America/New_York': 300, 'Asia/Kolkata': -330, 'Europe/Berlin': -60, UTC: 0 };
  try {
    for (const zone of Object.keys(erwartet)) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2026, 0, 13, 12, 0)).getTimezoneOffset(), erwartet[zone], 'die Zone ' + zone + ' ist nicht aktiv');
      assert.equal(await rechne(), vorher, 'Ergebnis weicht unter TZ=' + zone + ' ab');
    }
  } finally {
    if (alt === undefined) { delete process.env.TZ; } else { process.env.TZ = alt; }
  }
});
