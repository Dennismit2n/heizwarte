/*
 * Heizwarte — Attrappen für die Tests: fakeFetch, fakeStorage, fakeSleep, fakeGeolocation.
 * Keine Abhängigkeiten, kein Netz, keine Uhr. Jede Attrappe zählt ihre Aufrufe mit, damit Tests
 * Regeln wie „genau ein Versuch“ oder „sleep(60000) einmal“ prüfen können.
 */
'use strict';

// ---------------------------------------------------------------------------------------------
// fakeFetch(tabelle)
//
// tabelle: Objekt { teilstring: antwort } oder Liste [[treffer, antwort], …]. „treffer“ ist ein
// Teilstring der ganzen URL (mit Query) oder ein RegExp; der erste Eintrag, der passt, gewinnt.
// Passt keiner, wird die Anfrage in fetch.unmatched vermerkt und mit einem FakeFetchError
// abgelehnt, damit eine vergessene Fixture nicht als „offline“ durchgeht.
//
// antwort ist eine der Formen:
//   - Spezifikation { status = 200, body, headers, throws }; body darf Objekt/Array (wird JSON),
//     String (roh) oder fehlend sein (leerer Body). throws = true oder ein Error lässt fetch werfen.
//     Als Spezifikation gilt ein Objekt mit mindestens einem der Schlüssel status, body, headers, throws.
//   - ein anderes Objekt oder Array: gilt als JSON-Body mit Status 200 (zum Beispiel eine Fixture).
//   - eine Liste von Spezifikationen: der n-te Aufruf dieses Eintrags nimmt Element n, das letzte
//     Element gilt dann weiter (erst 429, dann 200).
//   - eine Funktion (url, init, n) → eine der Formen oben.
// ---------------------------------------------------------------------------------------------

class FakeFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FakeFetchError';
  }
}

function matches(treffer, url) {
  if (treffer instanceof RegExp) { return treffer.test(url); }
  return url.includes(String(treffer));
}

function isSpec(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    ['status', 'body', 'headers', 'throws'].some((k) => Object.prototype.hasOwnProperty.call(x, k));
}

function toSpec(x) {
  return isSpec(x) ? x : { status: 200, body: x };
}

function makeResponse(url, spec) {
  const status = spec.status === undefined ? 200 : spec.status;
  let text = '';
  if (spec.body !== undefined && spec.body !== null) {
    text = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  }
  const headerMap = new Map();
  for (const k of Object.keys(spec.headers || {})) {
    headerMap.set(k.toLowerCase(), String(spec.headers[k]));
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    url,
    headers: {
      get: (name) => (headerMap.has(String(name).toLowerCase()) ? headerMap.get(String(name).toLowerCase()) : null),
      has: (name) => headerMap.has(String(name).toLowerCase())
    },
    // wie das echte Response: ein leerer oder kaputter Body lässt json() mit SyntaxError scheitern
    json: async () => JSON.parse(text),
    text: async () => text
  };
}

function fakeFetch(tabelle) {
  const eintraege = Array.isArray(tabelle) ? tabelle.slice() : Object.entries(tabelle || {});
  const zaehler = eintraege.map(() => 0);
  const calls = [];
  const unmatched = [];

  async function fetch(input, init) {
    const url = typeof input === 'string' ? input : String((input && input.url) || input);
    calls.push({ url, init });

    if (init && init.signal && init.signal.aborted) {
      const abort = new Error('The operation was aborted.');
      abort.name = 'AbortError';
      throw abort;
    }

    const i = eintraege.findIndex((e) => matches(e[0], url));
    if (i < 0) {
      unmatched.push(url);
      throw new FakeFetchError('fakeFetch: keine Antwort für ' + url);
    }

    const n = zaehler[i]++;
    let antwort = eintraege[i][1];
    if (typeof antwort === 'function') { antwort = antwort(url, init, n); }
    if (Array.isArray(antwort) && antwort.length && antwort.every(isSpec)) {
      antwort = antwort[Math.min(n, antwort.length - 1)];
    }

    const spec = toSpec(antwort);
    if (spec.throws) {
      throw spec.throws instanceof Error ? spec.throws : new TypeError('Failed to fetch');
    }
    return makeResponse(url, spec);
  }

  fetch.calls = calls;
  fetch.unmatched = unmatched;
  // Anzahl der Aufrufe, deren URL zum Treffer passt (ohne Angabe: alle)
  fetch.count = (treffer) => (treffer === undefined ? calls.length : calls.filter((c) => matches(treffer, c.url)).length);
  return fetch;
}

// ---------------------------------------------------------------------------------------------
// fakeStorage(anfang, optionen)
//
// Liefert ein Backend { getItem, setItem, removeItem, clear, key, length } für storage.use(), das
// zugleich die JSON-Schnittstelle von Heizwarte.storage nachbildet (get/set/remove mit Präfix hw:),
// damit i18n.detect({ storage: fakeStorage() }) ohne das echte Modul läuft.
//
// anfang:    Objekt { 'hw:lang': '"fr"', … } mit den rohen Schlüsseln; Strings bleiben unverändert,
//            alles andere wird zu JSON.
// optionen:  throwOnGet / throwOnSet (true: jeder Lese- bzw. Schreibzugriff wirft SecurityError),
//            maxChars (Obergrenze für Schlüssel plus Werte; wer sie überschreitet, bekommt
//            QuotaExceededError wie bei einem vollen localStorage).
// map:       der rohe Inhalt (Map) für Prüfungen in Tests.
// ---------------------------------------------------------------------------------------------

function fakeStorage(anfang, optionen) {
  const opt = optionen || {};
  const map = new Map();
  for (const k of Object.keys(anfang || {})) {
    const v = anfang[k];
    map.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }

  function groesse() {
    let n = 0;
    for (const [k, v] of map) { n += k.length + v.length; }
    return n;
  }

  function sperre(art) {
    const e = new Error('fakeStorage: ' + art + ' gesperrt');
    e.name = 'SecurityError';
    return e;
  }

  const backend = {
    getItem(k) {
      if (opt.throwOnGet) { throw sperre('Lesen'); }
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (opt.throwOnSet) { throw sperre('Schreiben'); }
      const wert = String(v);
      if (opt.maxChars !== undefined) {
        const alt = map.has(k) ? k.length + map.get(k).length : 0;
        if (groesse() - alt + k.length + wert.length > opt.maxChars) {
          const e = new Error('fakeStorage: voll');
          e.name = 'QuotaExceededError';
          throw e;
        }
      }
      map.set(k, wert);
    },
    removeItem(k) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
    key(i) {
      const k = Array.from(map.keys())[i];
      return k === undefined ? null : k;
    },
    get length() {
      return map.size;
    },

    // JSON-Schnittstelle wie Heizwarte.storage: wirft nie
    get(key, fallback) {
      try {
        const raw = backend.getItem('hw:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        backend.setItem('hw:' + key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    remove(key) {
      try { backend.removeItem('hw:' + key); } catch (e) { /* wie Heizwarte.storage: nie werfen */ }
    },

    map
  };
  return backend;
}

// ---------------------------------------------------------------------------------------------
// fakeSleep(): ersetzt die Wartefunktion { sleep }. Kehrt sofort zurück und merkt sich die
// angeforderten Wartezeiten in sleep.calls (Millisekunden); sleep.count ist deren Anzahl.
// ---------------------------------------------------------------------------------------------

function fakeSleep() {
  const calls = [];
  async function sleep(ms) {
    calls.push(ms);
  }
  sleep.calls = calls;
  Object.defineProperty(sleep, 'count', { get: () => calls.length });
  return sleep;
}

// ---------------------------------------------------------------------------------------------
// fakeGeolocation(code)
//
// Liefert ein Objekt mit getCurrentPosition(success, error, options) wie navigator.geolocation.
//   code fehlt oder 'ok'   → Erfolg mit der Standardposition (Marktstraße 1, Winnenden)
//   { lat, lon, acc }      → Erfolg mit dieser Position
//   'denied' oder 1        → Fehler PERMISSION_DENIED
//   'unavailable' oder 2   → Fehler POSITION_UNAVAILABLE
//   'timeout' oder 3       → Fehler TIMEOUT
// Die Rückmeldung kommt wie im Browser asynchron. Jeder Aufruf steht samt options in .calls.
// ---------------------------------------------------------------------------------------------

const GEO_CODES = { denied: 1, unavailable: 2, timeout: 3 };
const GEO_TEXTE = { 1: 'User denied Geolocation', 2: 'Position unavailable', 3: 'Timeout expired' };
const GEO_STANDARD = { lat: 48.8772683, lon: 9.3964273, acc: 20 };

function fakeGeolocation(code) {
  const calls = [];
  let fehler = null;
  let position = null;

  if (code === undefined || code === null || code === 'ok') {
    position = GEO_STANDARD;
  } else if (typeof code === 'object' && typeof code.lat === 'number' && typeof code.lon === 'number') {
    position = { lat: code.lat, lon: code.lon, acc: code.acc === undefined ? 20 : code.acc };
  } else if (Object.prototype.hasOwnProperty.call(GEO_CODES, code)) {
    fehler = GEO_CODES[code];
  } else if (code === 1 || code === 2 || code === 3) {
    fehler = code;
  } else {
    throw new TypeError('fakeGeolocation: unbekannter Code ' + String(code));
  }

  return {
    calls,
    getCurrentPosition(success, error, options) {
      calls.push({ options });
      Promise.resolve().then(() => {
        if (fehler !== null) {
          if (typeof error === 'function') {
            error({
              code: fehler,
              message: GEO_TEXTE[fehler],
              PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2,
              TIMEOUT: 3
            });
          }
          return;
        }
        success({
          coords: { latitude: position.lat, longitude: position.lon, accuracy: position.acc },
          timestamp: Date.now()
        });
      });
    }
  };
}

module.exports = { fakeFetch, fakeStorage, fakeSleep, fakeGeolocation, FakeFetchError };
