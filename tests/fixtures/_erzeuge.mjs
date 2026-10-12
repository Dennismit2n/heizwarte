/*
 * Heizwarte — Erzeuger der konstruierten Wetter-Fixtures (BAUPLAN Abschnitt 12, Tabelle „Fixtures“)
 *
 * Alle Dateien sind Open-Meteo-Antworten im Format timeformat=unixtime (Zeiten in Epoch-Sekunden),
 * Variablen wie in weather.omUrl() (hourly: 12 Spalten, daily: 8, current: 6). Die Werte sind von Hand
 * vorgegeben und von keinem Live-Aufruf abgeleitet; die Form folgt forecast1.json aus dem Plan. Das Skript
 * ist deterministisch (kein Zufall, kein Date.now, nur Date.UTC), läuft also unter jeder Zeitzone gleich.
 *
 *   node tests/fixtures/_erzeuge.mjs
 *
 * Herkunft je Datei (alle „konstruiert“, wo nichts anderes steht; Fenster 12.–16.01.2026 in Europe/Berlin,
 * UTC+1, fünf Tage wegen past_days=1, „heute“ ist also Tag 2 = 13.01.2026):
 *
 *   om-mild.json        Nächte 9,5 / 10,5 / 10 °C (die erste Nacht fest bei 9–10 °C), ruhiger Wind
 *   om-frost.json       Nächte −2 / −4 / −1 °C, Böen 25 km/h
 *   om-hartfrost.json   Nächte −6 / −4 / −2 °C (Nacht bis −5 setzt Stufe 3 hart, Bürg index:344)
 *   om-sturz.json       Tagesmittel 12 → 8 → 5 °C an den drei Tagen ab heute (genau, über Mittelwert-
 *                       Korrektur), Nächte 6 / 3 / 1 °C, kein Frost: drop48 = −7
 *   om-sturm.json       Nächte 3 °C, Wind 30 km/h, Böen 55 km/h, Sonne 0,5 h am Tag
 *   om-lissabon.json    Europe/Lisbon (UTC+0 im Januar), Nächte 8–10 °C, 38,72 / −9,14
 *   om-dst.json         24.–28.10.2026 über der Umstellung am 25.10. (UTC+2 → UTC+1): 25 Stundenwerte am
 *                       25.10., Stunde 2 kommt zweimal vor; utc_offset_seconds bleibt 7200 für die ganze
 *                       Antwort und daily.time folgt diesem festen Offset (so beschreibt es die Open-Meteo-
 *                       Doku, KT §5.1); die Stundenwerte sind echte Zeitpunkte
 *   om-null.json        null in temperature_2m (5 Stunden, darunter die Tiefstwert-Stunde der ersten Nacht)
 *                       und je ein null in wind_speed_10m und wind_gusts_10m
 *   om-lueften.json     trockene Mittagsluft am 13.01.: Taupunkte so gelegt, dass bei 20 °C und 55 % Raum-
 *                       feuchte genau die Stunden 10–13 (bei jetzt 11:30 die Stunden 11, 12, 13, 16) vorn
 *                       liegen; Regenwahrscheinlichkeit 60 % um 14 und 15 Uhr
 *   om-stale.json       Kopie von om-buerg-2026-10-09.json (die Fixture entsteht aus dem wx-data-Block der
 *                       Bürg-Fassung, siehe _buerg-nach-unixtime.mjs); veraltet, sobald „jetzt“ nach dem
 *                       12.10.2026 liegt (BAUPLAN: now = 14.10.2026 08:00)
 *   alerts-sturm.json   die Warnung SCHWERE STURMBÖEN (severity moderate) aus alerts-dwd-2026-10-10.json, mit
 *                       dem location-Block aus alerts-leer.json, in der Form der Bright-Sky-Antwort
 *
 * Nicht von diesem Skript, sondern von Hand kopiert aus _intern/plan/ (Mitschnitte vom 10./11.10.2026):
 *   alerts-dwd-2026-10-10.json  = bs_alerts_all.json (17 echte Warnungen, 7 × expires null, 7 × instruction_de null)
 *   alerts-leer.json            = bs_alerts.json (Bürg, alerts [] mit location)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const STUNDE = 3600;

// ---------------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------------

const r1 = (x) => { const v = Math.round(x * 10) / 10; return v === 0 ? 0 : v; };

// Taupunkt nach Magnus (a = 17,62, b = 243,12)
function taupunkt(t, rh) {
  const g = Math.log(rh / 100) + 17.62 * t / (243.12 + t);
  return 243.12 * g / (17.62 - g);
}

// Eine Zeile je Spalte: lesbar im Diff
function schreibe(v, einzug) {
  const pad = '  '.repeat(einzug);
  if (Array.isArray(v)) { return JSON.stringify(v); }
  if (v && typeof v === 'object') {
    const teile = Object.keys(v).map((k) => pad + '  ' + JSON.stringify(k) + ': ' + schreibe(v[k], einzug + 1));
    return '{\n' + teile.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(v);
}

function speichere(name, obj) {
  const datei = path.join(HIER, name);
  fs.writeFileSync(datei, schreibe(obj, 0) + '\n', 'utf8');
  console.log('geschrieben:', name);
}

// ---------------------------------------------------------------------------------------------------
// Baukasten
//
// opt.start     Epoch-Sekunden der Ortsmitternacht von Tag 0
// opt.lens      Stunden je Tag (24; 25 am Tag der Rückstellung)
// opt.tr        Temperatur um 05:00 Ortszeit, n+1 Werte: tr[d] ist der Wert am Morgen von Tag d. Die Nacht von
//               Tag k (18 Uhr bis 9 Uhr) hat ihren Tiefstwert also in tr[k + 1]
// opt.pk        Temperatur um 15:00 Ortszeit, n Werte
// opt.mittel    { tag: Zielmittel } holt das Tagesmittel auf den Wert (Korrektur auf Zehntel in den Stunden
//               9–14 und 16–19; Tiefst- und Höchstwert bleiben unberührt)
// ---------------------------------------------------------------------------------------------------

function baue(opt) {
  const n = opt.lens.length;
  const stunden = [];                 // { i, d, h }
  opt.lens.forEach((len, d) => {
    const lokal = [];
    for (let h = 0; h < 24; h++) {
      lokal.push(h);
      if (len === 25 && h === 2) { lokal.push(2); }
    }
    lokal.forEach((h) => stunden.push({ i: stunden.length, d, h }));
  });
  const N = stunden.length;
  const sek = (i) => opt.start + i * STUNDE;
  const finde = (d, h) => stunden.find((x) => x.d === d && x.h === h).i;

  // Ankerpunkte: Morgen-Tiefstwert 05:00, Nachmittags-Höchstwert 15:00, davor ein Höchstwert am Vortag
  const anker = [{ i: finde(0, 5) - 14, v: opt.pk[0] }];
  for (let d = 0; d < n; d++) {
    anker.push({ i: finde(d, 5), v: opt.tr[d] });
    anker.push({ i: finde(d, 15), v: opt.pk[d] });
  }
  anker.push({ i: finde(n - 1, 5) + 24, v: opt.tr[n] });

  // Kosinus-Übergang zwischen zwei Ankern: Extremwerte werden exakt getroffen und sind flach
  const temp = new Array(N);
  for (let i = 0; i < N; i++) {
    let k = 0;
    while (k < anker.length - 2 && i > anker[k + 1].i) { k++; }
    const a = anker[k];
    const b = anker[k + 1];
    const t = (i - a.i) / (b.i - a.i);
    temp[i] = Math.round((a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * t)) / 2) * 10);   // Zehntel
  }

  // Tagesmittel auf das Ziel holen
  for (const [dTxt, ziel] of Object.entries(opt.mittel || {})) {
    const d = Number(dTxt);
    const idx = stunden.filter((x) => x.d === d);
    const soll = Math.round(ziel * 10 * idx.length);
    const ist = idx.reduce((s, x) => s + temp[x.i], 0);
    const rest = soll - ist;
    const ziele = idx.filter((x) => (x.h >= 9 && x.h <= 14) || (x.h >= 16 && x.h <= 19));
    const basis = Math.trunc(rest / ziele.length);
    let uebrig = rest - basis * ziele.length;
    ziele.forEach((x) => {
      temp[x.i] += basis;
      if (uebrig !== 0) { temp[x.i] += Math.sign(uebrig); uebrig -= Math.sign(uebrig); }
    });
  }
  const t = temp.map((z) => z / 10);

  const wind = (d, h) => (typeof opt.wind === 'function' ? opt.wind(d, h) : (opt.wind === undefined ? 10 : opt.wind));
  const boen = (d, h) => (typeof opt.gust === 'function' ? opt.gust(d, h) : (opt.gust === undefined ? 22 : opt.gust));
  const sonne = (d) => opt.sun[d];                                   // Sonnenstunden des Tages
  const aufgang = opt.rise;
  const untergang = opt.set;

  const col = {
    temperature_2m: [], apparent_temperature: [], relative_humidity_2m: [], dew_point_2m: [],
    wind_speed_10m: [], wind_gusts_10m: [], precipitation_probability: [], precipitation: [],
    shortwave_radiation: [], weather_code: [], cloud_cover: [], is_day: []
  };
  stunden.forEach((x) => {
    const w = wind(x.d, x.h);
    const rh = Math.max(40, Math.min(100, Math.round(85 + 8 * Math.cos(2 * Math.PI * (x.h - 5) / 24))));
    const tag = x.h + 0.5 >= aufgang && x.h + 0.5 < untergang;
    const faktor = Math.min(1, sonne(x.d) / 6);
    const sw = tag ? Math.round(300 * faktor * Math.sin(Math.PI * (x.h + 0.5 - aufgang) / (untergang - aufgang))) : 0;
    col.temperature_2m.push(t[x.i]);
    col.apparent_temperature.push(r1(t[x.i] - w / 10 - 0.5));
    col.relative_humidity_2m.push(rh);
    col.dew_point_2m.push(opt.dew ? r1(opt.dew(x.d, x.h, t[x.i])) : r1(taupunkt(t[x.i], rh)));
    col.wind_speed_10m.push(w);
    col.wind_gusts_10m.push(boen(x.d, x.h));
    col.precipitation_probability.push(typeof opt.pp === 'function' ? opt.pp(x.d, x.h) : (opt.pp === undefined ? 10 : opt.pp));
    col.precipitation.push(typeof opt.pr === 'function' ? opt.pr(x.d, x.h) : (opt.pr === undefined ? 0 : opt.pr));
    col.shortwave_radiation.push(sw);
    col.weather_code.push(opt.code[x.d]);
    col.cloud_cover.push(Math.round(100 - 80 * faktor));
    col.is_day.push(tag ? 1 : 0);
  });

  // Tageswerte aus den Stunden (vor dem Einsetzen der null-Lücken)
  const daily = {
    time: [], temperature_2m_max: [], temperature_2m_min: [], sunshine_duration: [], sunrise: [], sunset: [],
    weather_code: [], precipitation_sum: [], wind_gusts_10m_max: []
  };
  for (let d = 0; d < n; d++) {
    const idx = stunden.filter((x) => x.d === d).map((x) => x.i);
    const werte = idx.map((i) => col.temperature_2m[i]);
    daily.time.push(opt.start + d * 86400);                           // fester Offset der Antwort (Open-Meteo-Doku)
    daily.temperature_2m_max.push(Math.max(...werte));
    daily.temperature_2m_min.push(Math.min(...werte));
    daily.sunshine_duration.push(Math.round(sonne(d) * 3600 * 100) / 100);
    const hStart = (hh) => sek(finde(d, Math.floor(hh))) + Math.round((hh - Math.floor(hh)) * 3600);
    daily.sunrise.push(hStart(aufgang));
    daily.sunset.push(hStart(untergang));
    daily.weather_code.push(opt.code[d]);
    daily.precipitation_sum.push(r1(idx.reduce((s, i) => s + col.precipitation[i], 0)));
    daily.wind_gusts_10m_max.push(Math.max(...idx.map((i) => col.wind_gusts_10m[i])));
  }

  // Lücken
  for (const [d, h] of opt.nullTemp || []) { col.temperature_2m[finde(d, h)] = null; }
  for (const [d, h] of opt.nullWind || []) { col.wind_speed_10m[finde(d, h)] = null; }
  for (const [d, h] of opt.nullGust || []) { col.wind_gusts_10m[finde(d, h)] = null; }

  // „jetzt“: 13.01. 10:00 (Tag 1, Stunde 10), alle 15 Minuten neu, wie Open-Meteo
  const ci = finde(1, 10);
  const einheiten = {
    temperature_2m: '°C', apparent_temperature: '°C', relative_humidity_2m: '%', dew_point_2m: '°C',
    wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', precipitation_probability: '%', precipitation: 'mm',
    shortwave_radiation: 'W/m²', weather_code: 'wmo code', cloud_cover: '%', is_day: ''
  };

  return {
    latitude: opt.lat,
    longitude: opt.lon,
    generationtime_ms: 0.2,
    utc_offset_seconds: opt.offset,
    timezone: opt.tz,
    timezone_abbreviation: opt.abk,
    elevation: opt.elev,
    current_units: {
      time: 'unixtime', interval: 'seconds', temperature_2m: '°C', apparent_temperature: '°C',
      relative_humidity_2m: '%', wind_speed_10m: 'km/h', weather_code: 'wmo code', is_day: ''
    },
    current: {
      time: sek(ci), interval: 900,
      temperature_2m: t[ci], apparent_temperature: col.apparent_temperature[ci],
      relative_humidity_2m: col.relative_humidity_2m[ci], wind_speed_10m: col.wind_speed_10m[ci],
      weather_code: col.weather_code[ci], is_day: col.is_day[ci]
    },
    hourly_units: Object.assign({ time: 'unixtime' }, einheiten),
    hourly: Object.assign({ time: stunden.map((x) => sek(x.i)) }, col),
    daily_units: {
      time: 'unixtime', temperature_2m_max: '°C', temperature_2m_min: '°C', sunshine_duration: 's',
      sunrise: 'unixtime', sunset: 'unixtime', weather_code: 'wmo code', precipitation_sum: 'mm',
      wind_gusts_10m_max: 'km/h'
    },
    daily
  };
}

// ---------------------------------------------------------------------------------------------------
// Berlin im Januar 2026 (UTC+1): Tag 0 ist der 12.01., Ortsmitternacht = 11.01. 23:00 UTC
// ---------------------------------------------------------------------------------------------------

const BERLIN = {
  tz: 'Europe/Berlin', abk: 'GMT+1', offset: 3600, lat: 48.88, lon: 9.44, elev: 414,
  start: Date.UTC(2026, 0, 12) / 1000 - 3600,
  lens: [24, 24, 24, 24, 24],
  rise: 8.25, set: 16.6
};

speichere('om-mild.json', baue(Object.assign({}, BERLIN, {
  tr: [10, 10, 9.5, 10.5, 10, 9.5], pk: [12, 12.5, 13, 12.5, 12],
  sun: [1, 2, 3, 2, 2], code: [3, 3, 3, 3, 3], wind: 10, gust: 22
})));

speichere('om-frost.json', baue(Object.assign({}, BERLIN, {
  tr: [3, 2, -2, -4, -1, 0], pk: [5, 4, 2, 1, 4],
  sun: [2, 2, 2, 3, 3], code: [3, 3, 1, 1, 3], wind: 12, gust: 25
})));

speichere('om-hartfrost.json', baue(Object.assign({}, BERLIN, {
  tr: [-2, -3, -6, -4, -2, -1], pk: [1, 0, -1, 0, 2],
  sun: [2, 2, 3, 3, 3], code: [3, 1, 1, 1, 3], wind: 12, gust: 25
})));

speichere('om-sturz.json', baue(Object.assign({}, BERLIN, {
  tr: [9, 9, 6, 3, 1, 0.5], pk: [15, 16, 12, 8, 6],
  mittel: { 1: 12, 2: 8, 3: 5 },
  sun: [3, 3, 1, 1, 2], code: [3, 3, 61, 61, 3], wind: 10, gust: 22,
  pp: (d) => (d >= 2 && d <= 3 ? 60 : 10), pr: (d, h) => (d >= 2 && d <= 3 && h % 4 === 0 ? 0.4 : 0)
})));

speichere('om-sturm.json', baue(Object.assign({}, BERLIN, {
  tr: [5, 4, 3, 3, 3, 3], pk: [6, 6, 5, 5, 5],
  sun: [0.5, 0.5, 0.5, 0.5, 0.5], code: [63, 63, 3, 3, 3], wind: 30, gust: 55,
  pp: 40, pr: (d, h) => (h % 3 === 0 ? 0.3 : 0)
})));

// Lissabon: Europe/Lisbon, im Januar UTC+0, also beginnt Tag 0 um 00:00 UTC
speichere('om-lissabon.json', baue({
  tz: 'Europe/Lisbon', abk: 'GMT+0', offset: 0, lat: 38.72, lon: -9.14, elev: 2,
  start: Date.UTC(2026, 0, 12) / 1000,
  lens: [24, 24, 24, 24, 24],
  rise: 7.75, set: 17.5,
  tr: [9, 9, 8, 9, 10, 10], pk: [14, 15, 14, 15, 16],
  sun: [6, 6, 5, 6, 6], code: [1, 1, 2, 1, 1], wind: 12, gust: 24
}));

// Umstellungswochenende: 24.10. (24 h), 25.10. (25 h), 26.–28.10. (je 24 h); Ortsmitternacht des 24.10.
// in der Sommerzeit = 23.10. 22:00 UTC
speichere('om-dst.json', baue({
  tz: 'Europe/Berlin', abk: 'GMT+2', offset: 7200, lat: 48.88, lon: 9.44, elev: 414,
  start: Date.UTC(2026, 9, 24) / 1000 - 7200,
  lens: [24, 25, 24, 24, 24],
  rise: 7.2, set: 17.2,
  tr: [8, 7, 5, 4, 6, 6], pk: [12, 11, 9, 10, 12],
  sun: [3, 3, 2, 3, 3], code: [3, 3, 3, 3, 3], wind: 10, gust: 20
}));

// Lücken in der Nacht der ersten Auswertung: Tag 2 (14.01.) 03–05 Uhr, dazu Tag 1 20 Uhr und Tag 3 12 Uhr
speichere('om-null.json', baue(Object.assign({}, BERLIN, {
  tr: [2, 1, -1, 0, 2, 2], pk: [4, 4, 3, 4, 5],
  sun: [2, 2, 2, 2, 3], code: [3, 3, 3, 3, 3], wind: 12, gust: 25,
  nullTemp: [[1, 20], [2, 3], [2, 4], [2, 5], [3, 12]],
  nullWind: [[2, 1]], nullGust: [[2, 6]]
})));

// Lüften: Taupunkte von Hand (Tag 1 = 13.01.), Regen um 14 und 15 Uhr, alle Temperaturen über 0 °C
const TAU = [3, 3, 3, 3, 3, 3, 3, 2.5, 2, 1, 0, -1.5, -2.5, -3.5, -2.8, -1, 0.5, 1.5, 2.5, 3, 3.5, 4, 4, 4];
speichere('om-lueften.json', baue(Object.assign({}, BERLIN, {
  tr: [4, 4, 4, 4, 4, 4], pk: [8, 8, 8, 8, 8],
  sun: [3, 3, 3, 3, 3], code: [3, 3, 3, 3, 3], wind: 10, gust: 22,
  dew: (d, h, temp) => (d === 1 ? TAU[h] : Math.min(temp - 1, 8.5)),
  pp: (d, h) => (d === 1 && (h === 14 || h === 15) ? 60 : 10)
})));

// ---------------------------------------------------------------------------------------------------
// Kopien und Ableitungen aus committeten Dateien
// ---------------------------------------------------------------------------------------------------

fs.copyFileSync(path.join(HIER, 'om-buerg-2026-10-09.json'), path.join(HIER, 'om-stale.json'));
console.log('kopiert: om-stale.json');

const dwd = JSON.parse(fs.readFileSync(path.join(HIER, 'alerts-dwd-2026-10-10.json'), 'utf8'));
const leer = JSON.parse(fs.readFileSync(path.join(HIER, 'alerts-leer.json'), 'utf8'));
const sturm = dwd.alerts.find((a) => a.event_de === 'SCHWERE STURMBÖEN');
if (!sturm) { throw new Error('SCHWERE STURMBÖEN fehlt in alerts-dwd-2026-10-10.json'); }
speichere('alerts-sturm.json', { alerts: [sturm], location: leer.location });
