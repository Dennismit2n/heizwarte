/*
 * Heizwarte — Abruf von Open-Meteo und Bright Sky, Zeitzonen-Modell auf unixtime
 *
 * Ortszeit entsteht nur über Intl mit ausdrücklicher timeZone, nie über getHours() des Geräts. Open-Meteo
 * liefert mit timeformat=unixtime echte Zeitpunkte; model() macht daraus je Stunde ms, Tagesindex und
 * Ortsstunde, damit heat.js ohne Date und Intl rechnen kann (BAUPLAN Abschnitt 4 und 5, weather).
 *
 * Abruf: Open-Meteo ist Pflicht, load() wirft OpenMeteoError, wenn es scheitert. Bright Sky (MOSMIX als
 * zweite Meinung, DWD-Warnungen) ist Zugabe: Scheitert es, meldet load() ein Problem und liefert leere
 * Werte, nie die alten (behebt Bürg index:284 und 292). Antwortet Open-Meteo mit HTTP 429, wiederholt
 * fetchWithRetry den Abruf genau einmal nach 60 s; Bright Sky wird nicht wiederholt.
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

  // ---------------------------------------------------------------------------------------------
  // Adressen
  // ---------------------------------------------------------------------------------------------

  const OM_URL = 'https://api.open-meteo.com/v1/forecast';
  const BS_URL = 'https://api.brightsky.dev';
  const CACHE_VERSION = 2;

  // Variablenlisten wie Bürg index:269–272; neu sind timezone=auto, timeformat=unixtime und die Modellwahl
  const OM_CURRENT = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'wind_speed_10m',
    'weather_code', 'is_day'];
  const OM_HOURLY = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m',
    'wind_speed_10m', 'wind_gusts_10m', 'precipitation_probability', 'precipitation', 'shortwave_radiation',
    'weather_code', 'cloud_cover', 'is_day'];
  const OM_DAILY = ['temperature_2m_max', 'temperature_2m_min', 'sunshine_duration', 'sunrise', 'sunset',
    'weather_code', 'precipitation_sum', 'wind_gusts_10m_max'];

  // DACH hat das Haus-Modell des DWD; außerhalb nimmt Open-Meteo sein bestes Modell. Annahme (KT §5.1):
  // best_match ist außerhalb von DE/AT/CH besser als icon_seamless.
  function modelFor(cc) {
    return typeof cc === 'string' && ['DE', 'AT', 'CH'].indexOf(cc.toUpperCase()) >= 0 ? 'icon_seamless' : 'best_match';
  }

  // Koordinate auf höchstens drei Nachkommastellen (~100 m). Orte sind schon so gerundet; die Rundung hier ist
  // der Gürtel zum Hosenträger, damit nie eine genauere Position das Gerät verlässt (BAUPLAN DoD 5).
  function coord(x) {
    return String(Math.round(x * 1000) / 1000);
  }

  // 'YYYY-MM-DD' plus n Tage, reine UTC-Rechnung ohne Gerätezeitzone
  function addDays(key, n) {
    const p = key.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n)).toISOString().slice(0, 10);
  }

  // Zonennamen bleiben lesbar (Europe/Berlin), aber ein '+' ('Etc/GMT+5') würde in einer Query als Leerzeichen gelesen
  function zoneParam(zone) {
    return encodeURIComponent(zone).replace(/%2F/g, '/');
  }

  // Open-Meteo mit unixtime und automatischer Zeitzone. elevation nur, wenn der Ort eine Höhe hat (sonst nimmt
  // Open-Meteo sein Höhenmodell).
  function omUrl(place) {
    let url = OM_URL + '?latitude=' + coord(place.lat) + '&longitude=' + coord(place.lon);
    if (typeof place.elev === 'number' && isFinite(place.elev)) { url += '&elevation=' + place.elev; }
    return url + '&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=4&models=' + modelFor(place.cc) +
      '&current=' + OM_CURRENT.join(',') + '&hourly=' + OM_HOURLY.join(',') + '&daily=' + OM_DAILY.join(',');
  }

  // Bright Sky erst NACH der Open-Meteo-Antwort, weil tz = om.timezone ist (Annahme: date und last_date werden in
  // tz gedeutet). Warnungen gibt es nur für Deutschland: cc 'DE' oder unbekannt (Standort ohne Reverse-Treffer).
  function bsUrls(place, tz, nowMs) {
    const zone = tzSafe(tz);
    const heute = dayKeyOf(nowMs, zone);
    const pos = 'lat=' + coord(place.lat) + '&lon=' + coord(place.lon);
    return {
      mos: BS_URL + '/weather?' + pos + '&date=' + addDays(heute, -1) + '&last_date=' + addDays(heute, 4) +
        '&tz=' + zoneParam(zone),
      alerts: place.cc === 'DE' || place.cc === null || place.cc === undefined ? BS_URL + '/alerts?' + pos : null
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Abruf
  // ---------------------------------------------------------------------------------------------

  // code: 'rate' (HTTP 429), 'invalid' (Fehlerantwort oder unbrauchbarer Inhalt), 'http' (anderer Status),
  // 'offline' (kein Netz), 'timeout' (keine Antwort in der Frist)
  class OpenMeteoError extends Error {
    constructor(code, message) {
      super(message || ('Open-Meteo: ' + code));
      this.name = 'OpenMeteoError';
      this.code = code;
    }
  }

  // Holt und liest JSON; wirft nie (anders als Bürg index:276). Rückgabe { ok, status, json, error }:
  //   error  null     alles gut
  //          'http'    Status außerhalb 200–299; json ist trotzdem gelesen, wenn der Körper JSON war
  //          'parse'   Status 2xx, aber der Körper ist kein JSON
  //          'offline' fetch ist gescheitert (kein Netz, gesperrt), status 0
  //          'timeout' keine Antwort innerhalb von timeoutMs (Standard 8 s), status 0
  async function fetchJSON(url, opts) {
    const o = opts || {};
    const timeoutMs = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : 8000;
    const fetchImpl = o.fetchImpl || (typeof root.fetch === 'function' ? root.fetch : null);
    if (!fetchImpl) { return { ok: false, status: 0, json: null, error: 'offline' }; }

    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    // Die Frist gilt auch, wenn fetchImpl das Signal ignoriert: der Wettlauf unten entscheidet
    const late = new Promise((resolve) => {
      timer = setTimeout(() => {
        if (ctl) { ctl.abort(); }
        resolve({ ok: false, status: 0, json: null, error: 'timeout' });
      }, timeoutMs);
    });

    const request = (async () => {
      let res;
      try {
        res = await fetchImpl(url, ctl ? { cache: 'no-store', signal: ctl.signal } : { cache: 'no-store' });
      } catch (e) {
        return { ok: false, status: 0, json: null, error: 'offline' };
      }
      const status = typeof res.status === 'number' ? res.status : 0;
      let json = null;
      let parsed = false;
      try {
        json = await res.json();
        parsed = true;
      } catch (e) {
        json = null;
      }
      if (!res.ok) { return { ok: false, status, json, error: 'http' }; }
      return parsed ? { ok: true, status, json, error: null } : { ok: false, status, json: null, error: 'parse' };
    })();

    try {
      return await Promise.race([request, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Wartezeit vor dem zweiten Versuch und Deckel für Retry-After (wie update.py:25–37 der Bürg-Fassung)
  const RETRY_WAIT_MS = 60000;
  const RETRY_AFTER_MAX_MS = 120000;

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Retry-After in Millisekunden, wenn der Kopf lesbar ist (ganze Sekunden, wie update.py mit isdigit()); sonst null
  function readRetryAfter(res) {
    try {
      const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      return typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) * 1000 : null;
    } catch (e) {
      return null;
    }
  }

  // Die Oberfläche darf den Abruf nie stören: ein werfender Beobachter wird übergangen
  function notify(fn, arg) {
    if (typeof fn !== 'function') { return; }
    try {
      fn(arg);
    } catch (e) {
      /* absichtlich leer */
    }
  }

  // Wie fetchJSON, aber mit genau EINEM zweiten Versuch, wenn der erste Status in retryOn steht (Standard: 429).
  // Wartezeit: waitMs (60 s), bei lesbarem Retry-After max(waitMs, min(Retry-After, 120 s)); Retry-After 30 s
  // wartet also trotzdem 60 s, Retry-After 300 s nur 120 s. Vor dem Warten melden die Beobachter die Zeit an die
  // Oberfläche: onWait(ms) wie im Plan und onWaiting({ s, ms }) mit ganzen Sekunden für statusWaiting{s}.
  // 5xx, Netzfehler und Zeitüberschreitung werden nicht wiederholt. Ein zweiter 429 kommt als Ergebnis zurück
  // ({ ok: false, status: 429, … }), geworfen wird nichts; load() macht daraus OpenMeteoError('rate').
  // opts: { retryOn, waitMs, sleep, fetchImpl, onWait, onWaiting, timeoutMs }
  async function fetchWithRetry(url, opts) {
    const o = opts || {};
    const retryOn = Array.isArray(o.retryOn) ? o.retryOn : [429];
    const waitMs = typeof o.waitMs === 'number' && isFinite(o.waitMs) && o.waitMs >= 0 ? o.waitMs : RETRY_WAIT_MS;
    const sleep = typeof o.sleep === 'function' ? o.sleep : defaultSleep;
    const base = o.fetchImpl || (typeof root.fetch === 'function' ? root.fetch : null);

    // Ein Versuch; die Köpfe liest nur der Umweg über fetchImpl, weil fetchJSON sie nicht weitergibt
    async function attempt() {
      let retryAfterMs = null;
      const spy = base ? async (u, init) => {
        const res = await base(u, init);
        retryAfterMs = readRetryAfter(res);
        return res;
      } : undefined;
      const r = await fetchJSON(url, { fetchImpl: spy, timeoutMs: o.timeoutMs });
      return { r, retryAfterMs };
    }

    const first = await attempt();
    if (retryOn.indexOf(first.r.status) < 0) { return first.r; }

    const wait = first.retryAfterMs === null ? waitMs : Math.max(waitMs, Math.min(first.retryAfterMs, RETRY_AFTER_MAX_MS));
    notify(o.onWait, wait);
    notify(o.onWaiting, { s: Math.ceil(wait / 1000), ms: wait });
    await sleep(wait);
    return (await attempt()).r;
  }

  // null, wenn die Open-Meteo-Antwort brauchbar ist, sonst der passende Fehler
  function omFailure(r) {
    if (r.error === 'timeout') { return new OpenMeteoError('timeout', 'Open-Meteo antwortet nicht rechtzeitig'); }
    if (r.error === 'offline') { return new OpenMeteoError('offline', 'Open-Meteo ist nicht erreichbar'); }
    const reason = r.json && typeof r.json.reason === 'string' ? r.json.reason : '';
    if (r.status === 429) { return new OpenMeteoError('rate', 'Open-Meteo: HTTP 429' + (reason ? ' – ' + reason : '')); }
    if (r.json && r.json.error === true) { return new OpenMeteoError('invalid', 'Open-Meteo: ' + (reason || 'Fehlerantwort')); }
    if (!r.ok) { return new OpenMeteoError(r.error === 'parse' ? 'invalid' : 'http', 'Open-Meteo: HTTP ' + r.status); }
    const h = r.json && r.json.hourly;
    if (!h || !Array.isArray(h.time) || h.time.length === 0) {
      return new OpenMeteoError('invalid', 'Open-Meteo: Antwort ohne Stundenwerte');
    }
    return null;
  }

  // Station aus sources[0]. Ohne endliche Entfernung lässt sich nicht beurteilen, ob die Linie taugt: dann null.
  function parseStation(s) {
    if (!s || typeof s !== 'object') { return null; }
    const distance = numOrNull(s.distance);
    if (distance === null) { return null; }
    return { name: typeof s.station_name === 'string' ? s.station_name : '', height: numOrNull(s.height), distance };
  }

  // Bright Sky /weather → { mos: [[epochMs, °C], …], station } oder null, wenn die Antwort unbrauchbar ist.
  // Nur Einträge mit Zeitstempel und Temperatur; 0 °C zählt (nicht per Wahrheitswert aussortieren).
  function parseMos(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.weather)) { return null; }
    const station = parseStation(Array.isArray(json.sources) ? json.sources[0] : null);
    const mos = [];
    for (const w of json.weather) {
      if (!w || typeof w !== 'object' || typeof w.timestamp !== 'string') { continue; }
      const ms = Date.parse(w.timestamp);        // Stempel tragen einen Offset (+00:00): echter Zeitpunkt
      const temp = numOrNull(w.temperature);
      if (!isFinite(ms) || temp === null) { continue; }
      mos.push([ms, temp]);
    }
    if (mos.length > 0 && station === null) { return null; }
    return { mos, station: mos.length > 0 ? station : null };
  }

  // Warnungen wörtlich (KT §6.3): nur die elf Felder, jedes string oder null; fremde Felder fallen weg
  const ALERT_FIELDS = ['event_de', 'event_en', 'headline_de', 'headline_en', 'description_de', 'description_en',
    'instruction_de', 'instruction_en', 'severity', 'onset', 'expires'];

  function cleanAlert(a) {
    if (!a || typeof a !== 'object') { return null; }
    const out = {};
    for (const f of ALERT_FIELDS) { out[f] = typeof a[f] === 'string' ? a[f] : null; }
    return out;
  }

  // Holt Open-Meteo (Pflicht), danach Bright Sky /weather und /alerts (Zugabe) und gibt den neuen Cache samt
  // Problemen zurück: 'tzUnknown' (Zone der Antwort unbekannt, fester Offset als Ersatz), 'mosFailed',
  // 'alertsFailed'. Es gibt keinen alten Cache als Eingabe; was nicht ankommt, ist leer (mos [], alerts null).
  //   alertsStatus  'ok' (Warnungen da), 'none' (Abfrage ohne Warnung), 'outside' (kein DWD-Gebiet: Ort nicht
  //                 in Deutschland, nicht abgefragt oder 404), 'error' (Abfrage gescheitert)
  // Open-Meteo wird bei HTTP 429 einmal nach 60 s wiederholt (fetchWithRetry); ein zweiter 429 wirft
  // OpenMeteoError('rate'). Bright Sky wird nie wiederholt.
  // opts: { fetchImpl, sleep, nowMs, timeoutMs, onWait, onWaiting }
  async function load(place, opts) {
    const o = opts || {};
    const nowMs = typeof o.nowMs === 'number' && isFinite(o.nowMs) ? o.nowMs : Date.now();
    const net = { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs };
    if (!place || typeof place.lat !== 'number' || !isFinite(place.lat) ||
        typeof place.lon !== 'number' || !isFinite(place.lon)) {
      throw new OpenMeteoError('invalid', 'Ort ohne Koordinaten');
    }

    const r = await fetchWithRetry(omUrl(place), {
      fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, sleep: o.sleep, onWait: o.onWait, onWaiting: o.onWaiting
    });
    const failure = omFailure(r);
    if (failure) { throw failure; }
    const om = r.json;

    const problems = [];
    const tz = tzSafe(om.timezone, om.utc_offset_seconds);
    if (!zoneKnown(om.timezone)) { problems.push('tzUnknown'); }

    const urls = bsUrls(place, tz, nowMs);
    const [wr, ar] = await Promise.all([fetchJSON(urls.mos, net), urls.alerts ? fetchJSON(urls.alerts, net) : null]);

    let mos = [];
    let mosStation = null;
    if (wr.ok) {
      const parsed = parseMos(wr.json);
      if (parsed) {
        mos = parsed.mos;
        mosStation = parsed.station;
      } else {
        problems.push('mosFailed');
      }
    } else if (wr.status !== 404) {
      problems.push('mosFailed');           // 404 heißt „keine Station in Reichweite“, das ist kein Fehler
    }

    let alerts = null;
    let alertsStatus = 'outside';
    if (ar) {
      if (ar.ok && ar.json && Array.isArray(ar.json.alerts)) {
        alerts = ar.json.alerts.map(cleanAlert).filter(Boolean);
        alertsStatus = alerts.length > 0 ? 'ok' : 'none';
      } else if (ar.status !== 404) {
        alertsStatus = 'error';
        problems.push('alertsFailed');
      }                                      // 404 „not covered by the DWD“ bleibt 'outside'
    }

    return { cache: { v: CACHE_VERSION, fetched: nowMs, om, mos, mosStation, alerts, alertsStatus }, problems };
  }

  const api = {
    modelFor,
    omUrl,
    bsUrls,
    fetchJSON,
    fetchWithRetry,
    load,
    tzSafe,
    localNow,
    dayKeyOf,
    model,
    OpenMeteoError
  };
  root.Heizwarte.weather = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
