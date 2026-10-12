/*
 * Heizwarte — Abruf von Open-Meteo und Bright Sky, Zeitzonen-Modell auf unixtime, eine Wiederholung bei HTTP 429
 *
 * Ortszeit entsteht nur über Intl mit ausdrücklicher timeZone, nie über getHours() des Geräts. Open-Meteo
 * liefert mit timeformat=unixtime echte Zeitpunkte; model() macht daraus je Stunde ms, Tagesindex und
 * Ortsstunde, damit heat.js ohne Date und Intl rechnen kann (BAUPLAN Abschnitt 5, weather).
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten (root.Heizwarte.heat) ERST IM FUNKTIONSKÖRPER holen, nie oben in eine Konstante kopieren

  // Ein Tag der Antwort beginnt in Open-Meteo bei Mitternacht mit festem Offset; zwölf Stunden dazu liegen in
  // jedem Fall am richtigen Ortstag, auch am Umstellungstag (BAUPLAN Abschnitt 5, weather)
  const HALF_DAY_MS = 43200000;

  // ---------------------------------------------------------------------------------------------
  // Ortszeit
  // ---------------------------------------------------------------------------------------------

  // Formatierer je Zone, weil ein neuer Intl.DateTimeFormat je Stunde spürbar kostet. Gefüllt wird erst beim
  // ersten Aufruf; beim Laden der Datei passiert nichts.
  const formatters = new Map();

  // Wirft RangeError bei einem unbekannten Zonennamen (in Node geprüft mit 'Mars/Olympus')
  function zoneFormat(tz) {
    let f = formatters.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      formatters.set(tz, f);
    }
    return f;
  }

  function zoneKnown(tz) {
    if (typeof tz !== 'string' || !tz) { return false; }
    try {
      zoneFormat(tz);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Kennt die Laufzeit die Zone nicht, gilt für die ganze Antwort der feste Offset als Ersatz: ganze Stunde →
  // 'Etc/GMT∓h' mit umgekehrtem Vorzeichen (+7200 s → 'Etc/GMT-2'), 0 → 'UTC', sonst 'UTC'. Die Rückgabe
  // bleibt immer ein String (null heißt bei Place.tz „noch keine Antwort“).
  function tzSafe(tz, offsetSec) {
    if (zoneKnown(tz)) { return tz; }
    if (typeof offsetSec === 'number' && isFinite(offsetSec) && offsetSec % 3600 === 0 && offsetSec !== 0) {
      const h = offsetSec / 3600;
      const name = 'Etc/GMT' + (h > 0 ? '-' : '+') + Math.abs(h);
      if (zoneKnown(name)) { return name; }
    }
    return 'UTC';
  }

  function localParts(ms, tz) {
    const p = {};
    for (const x of zoneFormat(tz).formatToParts(ms)) { p[x.type] = x.value; }
    // % 24: ältere Laufzeiten melden Mitternacht als 24 (Bürg index:243)
    return { key: p.year + '-' + p.month + '-' + p.day, h: Number(p.hour) % 24, min: Number(p.minute) };
  }

  // „Jetzt“ in der Ortszeit: { key: 'YYYY-MM-DD', h: 0–23, min: 0–59, ms }
  function localNow(tz, nowMs) {
    const p = localParts(nowMs, tz);
    return { key: p.key, h: p.h, min: p.min, ms: nowMs };
  }

  function dayKeyOf(ms, tz) {
    return localParts(ms, tz).key;
  }

  // ---------------------------------------------------------------------------------------------
  // Modell
  // ---------------------------------------------------------------------------------------------

  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  // Spalte einer Open-Meteo-Gruppe an der Stelle i; fehlende Spalte oder Lücke → null
  function column(group, name, i) {
    const a = group && group[name];
    return Array.isArray(a) ? numOrNull(a[i]) : null;
  }

  // Aus dem Cache (Open-Meteo roh in unixtime plus MOSMIX) wird das Modell, mit dem heat.js und die
  // Oberfläche rechnen:
  //   hours  eine Stunde je Zeitpunkt mit ms, dayIdx und h aus der Ortszeit (Intl, nicht getHours());
  //          Stunden ohne Temperatur fallen weg und zählen in gaps
  //   days   aus den Stunden gruppiert; mean ist das Mittel aller Stunden des Tages, gt die Gradtagzahl;
  //          die Tageswerte aus daily werden dem Tag über dayKeyOf(time + 12 h) zugeordnet
  //   mos    MOSMIX-Temperatur der Stunde, Verbindung über ms exakt
  function model(cache) {
    const heat = root.Heizwarte.heat;
    const om = (cache && cache.om) || {};
    const tz = tzSafe(om.timezone, om.utc_offset_seconds);
    const hr = om.hourly || {};
    const times = Array.isArray(hr.time) ? hr.time : [];
    const mos = new Map(Array.isArray(cache && cache.mos) ? cache.mos : []);

    const hours = [];
    const dayIndex = new Map();
    const dayKeys = [];
    let gaps = 0;
    for (let i = 0; i < times.length; i++) {
      const temp = column(hr, 'temperature_2m', i);
      const sec = numOrNull(times[i]);
      if (temp === null || sec === null) { gaps++; continue; }
      const ms = sec * 1000;
      const lp = localParts(ms, tz);
      let idx = dayIndex.get(lp.key);
      if (idx === undefined) {
        idx = dayKeys.length;
        dayIndex.set(lp.key, idx);
        dayKeys.push(lp.key);
      }
      hours.push({
        ms,
        dayIdx: idx,
        h: lp.h,
        temp,
        app: column(hr, 'apparent_temperature', i),
        rh: column(hr, 'relative_humidity_2m', i),
        dew: column(hr, 'dew_point_2m', i),
        wind: column(hr, 'wind_speed_10m', i),
        gust: column(hr, 'wind_gusts_10m', i),
        pp: column(hr, 'precipitation_probability', i),
        pr: column(hr, 'precipitation', i),
        sw: column(hr, 'shortwave_radiation', i),
        code: column(hr, 'weather_code', i),
        cc: column(hr, 'cloud_cover', i),
        isDay: column(hr, 'is_day', i) === 1,
        mos: mos.has(ms) ? numOrNull(mos.get(ms)) : null
      });
    }

    const sums = dayKeys.map(() => ({ sum: 0, n: 0 }));
    for (const o of hours) {
      sums[o.dayIdx].sum += o.temp;
      sums[o.dayIdx].n += 1;
    }
    const days = dayKeys.map((key, idx) => {
      const mean = sums[idx].sum / sums[idx].n;
      return {
        key, idx,
        max: null, min: null,
        mean,
        sun: null, code: null, rain: null, gust: null,
        gt: heat.degreeDay(mean),
        sunriseMs: null, sunsetMs: null
      };
    });

    const dl = om.daily || {};
    const dtimes = Array.isArray(dl.time) ? dl.time : [];
    for (let i = 0; i < dtimes.length; i++) {
      const sec = numOrNull(dtimes[i]);
      if (sec === null) { continue; }
      const idx = dayIndex.get(dayKeyOf(sec * 1000 + HALF_DAY_MS, tz));
      if (idx === undefined) { continue; }
      const d = days[idx];
      const sun = column(dl, 'sunshine_duration', i);
      const rise = column(dl, 'sunrise', i);
      const set = column(dl, 'sunset', i);
      d.max = column(dl, 'temperature_2m_max', i);
      d.min = column(dl, 'temperature_2m_min', i);
      d.sun = sun === null ? null : sun / 3600;
      d.code = column(dl, 'weather_code', i);
      d.rain = column(dl, 'precipitation_sum', i);
      d.gust = column(dl, 'wind_gusts_10m_max', i);
      d.sunriseMs = rise === null ? null : rise * 1000;
      d.sunsetMs = set === null ? null : set * 1000;
    }

    const c = om.current;
    const current = c && typeof c === 'object' && numOrNull(c.temperature_2m) !== null ? {
      temp: c.temperature_2m,
      app: numOrNull(c.apparent_temperature),
      rh: numOrNull(c.relative_humidity_2m),
      wind: numOrNull(c.wind_speed_10m),
      code: numOrNull(c.weather_code),
      isDay: c.is_day === 1
    } : null;

    return {
      tz,
      fetched: cache && typeof cache.fetched === 'number' ? cache.fetched : null,
      current,
      hours,
      days,
      mosStation: (cache && cache.mosStation) || null,
      gaps
    };
  }

  const api = {
    tzSafe,
    localNow,
    dayKeyOf,
    model
  };
  root.Heizwarte.weather = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
