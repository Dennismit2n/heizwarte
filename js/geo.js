/*
 * Heizwarte — Ortssuche über Photon, Rangfolge der Treffer, Höhe, Rundung und Standortbestimmung
 *
 * Alles Netz läuft über fetchImpl (Standard: fetch), die Geräteposition über das übergebene geolocation-Objekt;
 * die Datei fasst weder DOM noch Speicher noch navigator an (BAUPLAN Abschnitt 3 und 5, geo). Beim Laden
 * passiert nichts.
 *
 * Datenschutz (DoD 5): Die Adresse geht genau einmal je Knopfdruck an Photon (search). Alles, was danach an
 * Dienste geht oder gespeichert wird, ist auf drei Nachkommastellen (etwa 100 m) gerundet: elevation() und
 * reverse() runden selbst (Entscheidung 13). Die Hits aus parseFeatures() tragen dagegen die ungerundete
 * Photon-Koordinate und leben nur im Speicher der Einrichtung.
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten gibt es nicht: geo.js steht in der Ladereihenfolge vor weather.js und braucht kein anderes Modul

  const PHOTON_URL = 'https://photon.komoot.io';
  const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
  const SEARCH_LIMIT = 5;
  const FETCH_TIMEOUT_MS = 8000;
  const LOCATE_TIMEOUT_MS = 10000;
  const LOCATE_MAX_AGE_MS = 300000;

  // Meter je Grad wie im Plan: ein Breitengrad 110574 m, ein Längengrad am Äquator 111320 m
  const M_PER_DEG_LAT = 110574;
  const M_PER_DEG_LON = 111320;

  // code: 'denied' (Standort nicht freigegeben), 'unavailable' (keine Position), 'timeout' (Position kam nicht
  // rechtzeitig), 'offline' (Photon nicht erreichbar oder unbrauchbare Antwort), 'rejected' (Photon lehnt ab:
  // HTTP 400, 429 und die übrigen 4xx). app.js bildet .code auf die err*-Schlüssel ab.
  class GeoError extends Error {
    constructor(code, message) {
      super(message || ('Geo: ' + code));
      this.name = 'GeoError';
      this.code = code;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Kleine Helfer
  // ---------------------------------------------------------------------------------------------

  // Runden auf drei Nachkommastellen (etwa 100 m). Das Ergebnis hat nie mehr Stellen, weil eine ganze Zahl durch
  // 1000 geteilt wird; -0 wird zu 0, damit nirgends "-0" in einer Adresse steht.
  function round3(x) {
    const r = Math.round(Number(x) * 1000) / 1000;
    return r === 0 ? 0 : r;
  }

  // Zeichenkette aus einem Photon-Feld: Texte getrimmt, Zahlen als Text, alles andere leer
  function str(v) {
    if (typeof v === 'string') { return v.trim(); }
    if (typeof v === 'number' && isFinite(v)) { return String(v); }
    return '';
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // Photon kennt nur default, de, en und fr; jede andere Sprache lehnt die öffentliche Instanz mit HTTP 400 ab
  // (KT §3.3). 'de-AT' zählt als 'de'; ohne Angabe oder bei einer anderen Sprache gilt 'en'.
  function photonLang(lang) {
    const base = String(lang === undefined || lang === null ? '' : lang).toLowerCase().split(/[-_]/)[0];
    if (base === 'de') { return 'de'; }
    if (base === 'fr') { return 'fr'; }
    return 'en';
  }

  // "Marktstraße 1 71364 Winnenden": Teile mit einem Leerzeichen, leere weg
  function buildQuery(input) {
    const a = input || {};
    return [a.street, a.zip, a.city]
      .map((x) => str(x).replace(/\s+/g, ' '))
      .filter(Boolean)
      .join(' ');
  }

  // Holt und liest JSON; wirft nie. Rückgabe { ok, status, json, error }:
  //   error  null       alles gut, oder ein HTTP-Fehler (dann ok false und status gesetzt)
  //          'parse'    Antwort ohne lesbares JSON
  //          'offline'  fetch ist gescheitert, status 0
  //          'timeout'  keine Antwort innerhalb von timeoutMs, status 0
  // Absichtlich ohne cache: 'no-store', damit der Browser das max-age=3600 von Photon nutzt (KT §3.4).
  async function getJSON(url, opts) {
    const o = opts || {};
    const timeoutMs = isNum(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : FETCH_TIMEOUT_MS;
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
        res = await (ctl ? fetchImpl(url, { signal: ctl.signal }) : fetchImpl(url));
      } catch (e) {
        return { ok: false, status: 0, json: null, error: 'offline' };
      }
      const status = res && typeof res.status === 'number' ? res.status : 0;
      const ok = !!(res && res.ok);
      let json = null;
      let parsed = false;
      try {
        json = await res.json();
        parsed = true;
      } catch (e) {
        json = null;
      }
      return { ok, status, json, error: parsed ? null : 'parse' };
    })();

    try {
      return await Promise.race([request, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Treffer lesen
  // ---------------------------------------------------------------------------------------------

  // Layer, die Photon als Orte führt (KT §3.1). 'house' und 'street' sind eigene Arten, 'other' bleibt 'poi'.
  const PLACE_TYPES = ['locality', 'district', 'city', 'county', 'state', 'country'];

  function kindOf(parts, hasNumber) {
    if (parts.osmKey === 'building' || (hasNumber && !parts.name)) { return 'house'; }
    if (parts.type === 'street') { return 'street'; }
    if (PLACE_TYPES.indexOf(parts.type) >= 0) { return 'place'; }
    // Die Bushaltestelle "Winnenden Bürg" trägt type 'house' ohne Nummer, Apotheke, Kiosk und Bar tragen
    // type 'house' MIT Nummer und name: alles Orte von Interesse, kein Haus (photon2.json, photon1.json)
    return 'poi';
  }

  // Anzeigetexte aus den vorhandenen Feldern, nie street + " " + housenumber blind (KT §3.2).
  // Nimmt einen Hit (liest hit.parts) und liefert { label, line2, region }.
  function describe(hit) {
    const p = (hit && hit.parts) || {};
    // Die Nummer hängt nur an einer Straße: eine Nummer allein ("3") wäre als Anzeige sinnlos, dann trägt der Name
    const address = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';
    const label = address || p.name || p.city || '';
    // Fehlen Postleitzahl und Ort, steht nur das Land da, ohne führendes Komma
    const place = [p.postcode, p.city].filter(Boolean).join(' ');
    const line2 = [place, p.country].filter(Boolean).join(', ');
    const region = [p.locality || p.district, p.county, p.state].filter(Boolean).join(', ');
    return { label, line2, region };
  }

  // Ein GeoJSON-Feature → Hit, oder null, wenn es keine brauchbare Koordinate hat
  function parseFeature(f) {
    if (!f || typeof f !== 'object') { return null; }
    const p = f.properties && typeof f.properties === 'object' ? f.properties : {};
    const c = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    if (!c) { return null; }
    // GeoJSON-Reihenfolge: [lon, lat] (KT §3.1), nicht lat/lon
    const lon = c[0];
    const lat = c[1];
    if (!isNum(lon) || !isNum(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { return null; }

    const parts = {
      name: str(p.name),
      housenumber: str(p.housenumber),
      street: str(p.street),
      postcode: str(p.postcode),
      city: str(p.city),
      district: str(p.district),
      locality: str(p.locality),
      county: str(p.county),
      state: str(p.state),
      country: str(p.country),
      osmKey: str(p.osm_key),
      osmValue: str(p.osm_value),
      type: str(p.type)
    };
    const hasNumber = !!parts.housenumber;
    // extent ist [west, nord, ost, süd] = [minLon, maxLat, maxLon, minLat] (KT §3.1)
    const ext = p.extent;
    const extent = Array.isArray(ext) && ext.length === 4 && ext.every(isNum) ? ext.slice() : null;
    const cc = str(p.countrycode).toUpperCase();

    const hit = {
      lat,
      lon,
      cc: cc || null,
      label: '',
      line2: '',
      region: '',
      hasNumber,
      kind: kindOf(parts, hasNumber),
      parts,
      extent
    };
    return Object.assign(hit, describe(hit));
  }

  // GeoJSON einer Photon-Antwort → Hit[] in der Reihenfolge von Photon. Rein: kein Netz, kein DOM.
  // Ein fehlendes oder unbrauchbares features-Feld ergibt [], keinen Fehler (leere Liste ist kein Fehler, KT §3.2).
  function parseFeatures(geojson) {
    const list = geojson && Array.isArray(geojson.features) ? geojson.features : [];
    const hits = [];
    for (const f of list) {
      const hit = parseFeature(f);
      if (hit) { hits.push(hit); }
    }
    return hits;
  }

  // Hausnummern vergleichbar machen: "1 A" und "1a" sind dieselbe Nummer
  function normNumber(x) {
    return str(x).toLowerCase().replace(/\s+/g, '');
  }

  // Klasse für die Reihenfolge: 0 Haus mit gesuchter Nummer, 1 übrige Häuser, 2 Straße, 3 Ort, 4 alles andere
  function rankClass(hit, number) {
    switch (hit.kind) {
      case 'house':
        return number && normNumber(hit.parts && hit.parts.housenumber) === number ? 0 : 1;
      case 'street':
        return 2;
      case 'place':
        return 3;
      default:
        return 4;
    }
  }

  // Reihenfolge der Treffer für die Auswahl (rein, die Eingabeliste bleibt unverändert):
  // Haus mit passender Nummer, übrige Häuser, Straßen, Orte, dahinter die Orte von Interesse; innerhalb einer
  // Klasse bleibt Photons Reihenfolge. Treffer mit derselben round3-Koordinate werden zu einem zusammengefasst
  // (es bleibt der bestplatzierte): gespeichert würden ohnehin dieselben gerundeten Koordinaten, dasselbe label
  // und dasselbe cc, mehrere Knöpfe wären eine Auswahl ohne Folge.
  // wanted: { housenumber } aus der Eingabe (auch eine Zeichenkette oder nichts).
  function rank(hits, wanted) {
    const list = Array.isArray(hits) ? hits.filter((h) => h && typeof h === 'object') : [];
    const number = normNumber(wanted && typeof wanted === 'object' ? wanted.housenumber : wanted);
    const sorted = list
      .map((hit, i) => ({ hit, i, cls: rankClass(hit, number) }))
      .sort((a, b) => (a.cls - b.cls) || (a.i - b.i));
    const seen = new Set();
    const out = [];
    for (const s of sorted) {
      const key = round3(s.hit.lat) + '/' + round3(s.hit.lon);
      if (seen.has(key)) { continue; }
      seen.add(key);
      out.push(s.hit);
    }
    return out;
  }

  // Größe des Umrisses in Metern { w, h } oder null. extent = [minLon, maxLat, maxLon, minLat];
  // w = Längenunterschied · 111320 · cos(Breite), h = Breitenunterschied · 110574 (Plan, Abschnitt 5 geo).
  // lat ist die Breite für den Kosinus; fehlt sie, gilt die Mitte des Umrisses.
  function extentSize(extent, lat) {
    if (!Array.isArray(extent) || extent.length !== 4 || !extent.every(isNum)) { return null; }
    const minLon = extent[0];
    const maxLat = extent[1];
    const maxLon = extent[2];
    const minLat = extent[3];
    const phi = isNum(lat) ? lat : (maxLat + minLat) / 2;
    return {
      w: Math.abs(maxLon - minLon) * M_PER_DEG_LON * Math.cos(phi * Math.PI / 180),
      h: Math.abs(maxLat - minLat) * M_PER_DEG_LAT
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Dienste
  // ---------------------------------------------------------------------------------------------

  // Adressensuche bei Photon: genau ein Aufruf je Knopfdruck, nie beim Tippen (KT §3.4).
  //   search('Marktstraße 1 71364 Winnenden', { lang, fetchImpl, timeoutMs })     wie im Plan
  //   search({ street, zip, city, lang, fetchImpl, timeoutMs })                   baut die Anfrage selbst (buildQuery)
  // 200 mit leerer Liste → []. Fehler (alle als GeoError):
  //   'rejected'  HTTP 400, 429 und die übrigen 4xx (Photon lehnt ab oder drosselt); kein automatischer Retry
  //   'offline'   fetch scheitert, Zeitüberschreitung, HTTP 5xx oder eine Antwort ohne lesbares JSON
  // Eine leere Anfrage ergibt [] ohne Netzaufruf.
  async function search(query, opts) {
    let o = opts || {};
    let q = query;
    if (query !== null && typeof query === 'object') {
      o = Object.assign({}, query, opts || {});
      q = buildQuery(query);
    }
    q = str(q);
    if (!q) { return []; }

    const url = PHOTON_URL + '/api/?q=' + encodeURIComponent(q) + '&limit=' + SEARCH_LIMIT + '&lang=' + photonLang(o.lang);
    const r = await getJSON(url, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });

    if (r.error === 'offline') { throw new GeoError('offline', 'Photon ist nicht erreichbar'); }
    if (r.error === 'timeout') { throw new GeoError('offline', 'Photon antwortet nicht rechtzeitig'); }
    if (r.status >= 400 && r.status < 500) { throw new GeoError('rejected', 'Photon: HTTP ' + r.status); }
    if (!r.ok) { throw new GeoError('offline', 'Photon: HTTP ' + r.status); }
    if (r.error === 'parse') { throw new GeoError('offline', 'Photon: Antwort ohne lesbares JSON'); }
    return parseFeatures(r.json);
  }

  // Höhe in Metern (ganze Zahl) oder null; wirft nie. Fragt mit den GERUNDETEN Koordinaten, damit DoD 5 (B:63)
  // wörtlich gilt (BAUPLAN Abschnitt 5 geo, Abweichung von B:118). Antwort: { elevation: [417.0] } (KT §4);
  // { error: true }, ein Netzfehler, ein leeres Feld oder eine unbrauchbare Zahl ergeben null.
  async function elevation(lat, lon, opts) {
    try {
      const o = opts || {};
      const la = round3(lat);
      const lo = round3(lon);
      if (!isNum(la) || !isNum(lo)) { return null; }
      const url = ELEVATION_URL + '?latitude=' + la + '&longitude=' + lo;
      const r = await getJSON(url, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });
      if (r.error || !r.ok || !r.json || r.json.error === true) { return null; }
      const e = Array.isArray(r.json.elevation) ? r.json.elevation[0] : null;
      if (!isNum(e)) { return null; }
      const m = Math.round(e);
      return m === 0 ? 0 : m;
    } catch (e) {
      return null;
    }
  }

  // Adresse zur Koordinate (KT §3.5) → Hit oder null; wirft nie. Photon bekommt nur die auf drei Nachkommastellen
  // gerundete Position (Entscheidung 13: nichts Genaueres als etwa 100 m verlässt das Gerät). Ein leeres Ergebnis
  // und jeder Fehler (kein Netz, Drosselung) ergeben null: der Standort ist bekannt, der Reverse-Treffer nur die
  // Beschriftung, die App nimmt dann "Dein Standort".
  async function reverse(lat, lon, opts) {
    try {
      const o = opts || {};
      const la = round3(lat);
      const lo = round3(lon);
      if (!isNum(la) || !isNum(lo)) { return null; }
      const url = PHOTON_URL + '/reverse?lon=' + lo + '&lat=' + la + '&lang=' + photonLang(o.lang);
      const r = await getJSON(url, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });
      if (r.error || !r.ok) { return null; }
      const hits = parseFeatures(r.json);
      return hits.length ? hits[0] : null;
    } catch (e) {
      return null;
    }
  }

  // Geräteposition → { lat, lon, acc } (acc = Genauigkeit in Metern oder null), ROH und ungerundet; gerundet wird
  // erst beim Weiterreichen (reverse, elevation, Speichern). geolocation ist navigator.geolocation, übergeben von
  // app.js, damit die Datei navigator nie anfasst. Fehler als GeoError: 'denied', 'unavailable', 'timeout'.
  // Keine eigene Frist auf die Berechtigungsfrage: die Zeit, in der jemand den Dialog liest, läuft nicht ab.
  function locate(geolocation, opts) {
    const o = opts || {};
    const timeout = isNum(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : LOCATE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
        reject(new GeoError('unavailable', 'Dieses Gerät kann keinen Standort bestimmen'));
        return;
      }
      try {
        geolocation.getCurrentPosition(
          (pos) => {
            const c = pos && pos.coords;
            if (!c || !isNum(c.latitude) || !isNum(c.longitude)) {
              reject(new GeoError('unavailable', 'Standort ohne Koordinaten'));
              return;
            }
            resolve({ lat: c.latitude, lon: c.longitude, acc: isNum(c.accuracy) ? c.accuracy : null });
          },
          (err) => {
            // PositionError.code: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
            const n = err && err.code;
            const code = n === 1 ? 'denied' : (n === 3 ? 'timeout' : 'unavailable');
            reject(new GeoError(code, (err && err.message) || ('Standort: ' + code)));
          },
          { enableHighAccuracy: false, maximumAge: LOCATE_MAX_AGE_MS, timeout }
        );
      } catch (e) {
        reject(new GeoError('unavailable', (e && e.message) || 'Standort nicht verfügbar'));
      }
    });
  }

  const api = {
    buildQuery,
    photonLang,
    search,
    parseFeatures,
    rank,
    describe,
    extentSize,
    round3,
    elevation,
    reverse,
    locate,
    GeoError
  };
  root.Heizwarte.geo = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
