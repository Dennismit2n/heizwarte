/*
 * Heizwarte — localStorage-Hülle: Schlüssel mit Präfix hw:, Rückfall im Speicher, Versionsstand und Migration
 *
 * Alle Werte liegen als JSON im Speicher (auch Texte wie hw:lang oder hw:theme). Kein Zugriff wirft nach
 * außen: get() liefert den Rückfallwert, set() liefert false, remove() schweigt. Fällt der Speicher aus,
 * läuft die App mit einer Map im Arbeitsspeicher weiter, und degraded sagt der Oberfläche warum:
 *   'blocked'  der Zugriff selbst ist gesperrt oder wirft (Site-Daten aus, Sandbox, privates Fenster),
 *              oder setItem wirft ohne Quota-Bezug; dann bleibt das Backend lesbar (schreibgeschützt)
 *   'full'     setItem scheitert an der Quota, auch nach dem Opfern fremder Wetter-Caches
 *   null       alles gut
 * Schlüsselübersicht und Typen: BAUPLAN Abschnitt 4, Schnittstelle: Abschnitt 5 (storage).
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Keine Abhängigkeiten: nur das Standard-Backend localStorage, und das nur in try/catch

  const PREFIX = 'hw:';
  const VERSION = 2;
  // Schlüssel der Bürg-Fassung (Version 1, ohne hw:v), ohne Präfix
  const LEGACY_KEYS = ['cache', 'leadMin', 'leadMax', 'comfort'];

  // Zustand des Moduls. Beim Laden wird nichts gelesen und nichts geschrieben; das Backend wird beim
  // ersten Zugriff aufgelöst (resolve), damit ein werfender localStorage-Zugriff dort landet und nicht
  // beim require.
  let backend = null;     // echtes Backend { getItem, setItem, removeItem } oder null (= noch nicht aufgelöst)
  let blocked = false;    // true: das Backend wird nicht mehr benutzt, alles liegt in mem
  let readOnly = false;   // true: setItem warf ohne Quota-Bezug; gelesen wird weiter, geschrieben nur nach mem
  let full = false;       // true: mindestens ein Wert passte auch nach dem Opfern nicht mehr hinein
  // Rohe Strings unter dem vollen Schlüssel (mit hw:). Im Modus 'blocked' ist das der ganze Speicher,
  // sonst nur das, was nicht ins Backend passte oder (schreibgeschützt) nicht hinein durfte. Beim Lesen
  // gewinnt mem vor dem Backend; der Wert null steht für einen in dieser Sitzung gelöschten Schlüssel.
  const mem = new Map();

  // ---------------------------------------------------------------------------------------------
  // Backend
  // ---------------------------------------------------------------------------------------------

  // Liefert das Backend oder null, wenn nur noch der Arbeitsspeicher bleibt.
  function resolve() {
    if (blocked) { return null; }
    if (backend) { return backend; }
    try {
      const ls = root.localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function' &&
          typeof ls.removeItem === 'function') {
        backend = ls;
        return backend;
      }
    } catch (e) {
      // schon der Zugriff auf localStorage wirft (gesperrte Site-Daten, Sandbox) → Rückfall unten
    }
    blocked = true;
    return null;
  }

  function goBlocked() {
    blocked = true;
    backend = null;
  }

  // Annahme: Quota-Fehler erkennt man am Namen. Die älteren Codes 22 (WebKit, Blink) und 1014 sowie
  // den Firefox-Namen NS_ERROR_DOM_QUOTA_REACHED nehmen wir dazu, ohne sie hier geprüft zu haben.
  function isQuota(e) {
    if (!e) { return false; }
    return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 || e.code === 1014;
  }

  // Roher String zu einem vollen Schlüssel oder null. Wirft nie; wirft das Backend, wird es abgeschaltet.
  function read(fullKey) {
    if (mem.has(fullKey)) { return mem.get(fullKey); }
    const be = resolve();
    if (!be) { return null; }
    try {
      const raw = be.getItem(fullKey);
      return raw === undefined ? null : raw;
    } catch (e) {
      goBlocked();
      return null;
    }
  }

  // Id des aktiven Orts aus hw:places und hw:active, damit dessen Cache beim Opfern bleibt.
  // hw:active gilt, wenn es in hw:places steht; sonst places[0] (BAUPLAN Abschnitt 4, Schlüsseltabelle).
  // Ist die Ortsliste leer oder unlesbar, bleibt der Cache der gemerkten active-Id trotzdem geschützt.
  function activeId() {
    const places = get('places');
    const active = get('active');
    const ids = [];
    if (Array.isArray(places)) {
      for (const p of places) {
        if (p && typeof p.id === 'string') { ids.push(p.id); }
      }
    }
    if (typeof active === 'string' && (ids.length === 0 || ids.indexOf(active) >= 0)) { return active; }
    return ids.length ? ids[0] : null;
  }

  // Löscht alle hw:cache:<id> außer dem des aktiven Orts. Die Ids kommen aus den Schlüsseln des
  // Backends (wenn es sich aufzählen lässt, wie localStorage) und aus hw:places (wenn nicht).
  // Ein Cache ist abgeleitet und beim nächsten Start neu zu holen, deshalb darf er weichen.
  function evictForeignCaches(be) {
    const cachePrefix = PREFIX + 'cache:';
    const keep = activeId();
    const ids = new Set();
    try {
      if (typeof be.key === 'function' && typeof be.length === 'number') {
        for (let i = 0; i < be.length; i++) {
          const k = be.key(i);
          if (typeof k === 'string' && k.indexOf(cachePrefix) === 0) { ids.add(k.slice(cachePrefix.length)); }
        }
      }
    } catch (e) { /* nicht aufzählbar: dann nur die Orte aus hw:places */ }
    const places = get('places');
    if (Array.isArray(places)) {
      for (const p of places) {
        if (p && typeof p.id === 'string') { ids.add(p.id); }
      }
    }
    for (const id of ids) {
      if (id === keep) { continue; }
      try { be.removeItem(cachePrefix + id); } catch (e) { /* weiter mit den übrigen */ }
    }
  }

  // Schreibt einen rohen String. true = steht im Backend, false = nur im Arbeitsspeicher dieser Sitzung.
  function write(fullKey, raw) {
    const be = resolve();
    if (!be || readOnly) {
      mem.set(fullKey, raw);
      return false;
    }
    try {
      be.setItem(fullKey, raw);
      mem.delete(fullKey);
      return true;
    } catch (e) {
      if (!isQuota(e)) {
        // kein Platzproblem, sondern gesperrt: ab jetzt schreibgeschützt. Das Backend bleibt lesbar, damit ein
        // einzelner Fehler mitten in der Sitzung nicht alle gespeicherten Orte unsichtbar macht; der Wert
        // bleibt in dieser Sitzung. Ganz abgeschaltet wird nur, wenn schon das Lesen wirft.
        readOnly = true;
        mem.set(fullKey, raw);
        return false;
      }
    }
    // Quota: fremde Wetter-Caches opfern und genau einmal wiederholen
    evictForeignCaches(be);
    try {
      be.setItem(fullKey, raw);
      mem.delete(fullKey);
      return true;
    } catch (e2) {
      mem.set(fullKey, raw);
      full = true;
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Öffentliche Schnittstelle
  // ---------------------------------------------------------------------------------------------

  // Tauscht das Backend aus (Tests) und setzt den Zustand zurück. Ohne Argument gilt wieder localStorage.
  function use(b) {
    backend = b || null;
    blocked = false;
    readOnly = false;
    full = false;
    mem.clear();
  }

  // Wert zu hw:<key> als JSON-Wert. Fehlt der Schlüssel oder ist der Inhalt kein JSON: fallback.
  function get(key, fallback) {
    try {
      const raw = read(PREFIX + key);
      if (typeof raw !== 'string') { return fallback; }
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  // Schreibt hw:<key> als JSON. Liefert true, wenn der Wert im Backend steht; false, wenn er nur im
  // Arbeitsspeicher dieser Sitzung liegt (get() liefert ihn trotzdem) oder gar nicht gespeichert werden
  // kann (undefined, Funktionen, Zyklen). Wirft nie.
  function set(key, value) {
    try {
      const raw = JSON.stringify(value);
      if (typeof raw !== 'string') { return false; }
      return write(PREFIX + key, raw);
    } catch (e) {
      return false;
    }
  }

  // Entfernt hw:<key> aus dem Backend und aus dem Arbeitsspeicher. Wirft nie. Schreibgeschützt (oder wenn
  // removeItem wirft) bleibt der Wert im Backend stehen; ein Grabstein (null) in mem verdeckt ihn für diese
  // Sitzung, damit get() danach den Rückfallwert liefert.
  function remove(key) {
    const fullKey = PREFIX + key;
    mem.delete(fullKey);
    const be = resolve();
    if (!be) { return; }
    if (readOnly) {
      mem.set(fullKey, null);
      return;
    }
    try {
      be.removeItem(fullKey);
    } catch (e) {
      readOnly = true;
      mem.set(fullKey, null);
    }
  }

  // 8 Hex-Zeichen aus crypto.getRandomValues, nie aus dem Namen (BAUPLAN Abschnitt 4, Place.id).
  // Ohne crypto wirft newId(); migrate() fängt das (die alten Schlüssel bleiben für den nächsten Start).
  // Jeder Browser mit localStorage hat crypto.getRandomValues, Node ab 19 ebenso.
  function newId() {
    const bytes = new Uint8Array(4);
    const c = root.crypto;
    if (!c || typeof c.getRandomValues !== 'function') { throw new Error('crypto.getRandomValues fehlt'); }
    c.getRandomValues(bytes);
    let id = '';
    for (let i = 0; i < bytes.length; i++) { id += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); }
    return id;
  }

  // Zahl aus einem gespeicherten Wert, sonst def (Bürg speichert Zahlen, las sie aber mit +x)
  function numOr(v, def) {
    if (typeof v !== 'number' && typeof v !== 'string') { return def; }
    if (typeof v === 'string' && v.trim() === '') { return def; }
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  // Der Ort, den die Bürg-Installation (nur das Handy von Dennis) beim ersten Start nach dem Update bekommt.
  // Werte nach BAUPLAN Abschnitt 4, Migration Fall 3; die drei Einstellungen kommen aus den alten Schlüsseln.
  function buergPlace(id, nowMs) {
    return {
      id,
      label: 'Winnenden-Bürg',
      lat: 48.881,
      lon: 9.441,
      elev: 414,
      elevAuto: false,
      cc: 'DE',
      tz: 'Europe/Berlin',
      heat: {
        type: 'floorScreed',
        leadMin: numOr(get('leadMin'), 3),
        leadMax: numOr(get('leadMax'), 6),
        comfort: numOr(get('comfort'), 20),
        thresh: null,
        confirmed: true
      },
      created: nowMs
    };
  }

  // Version 1 → 2 (BAUPLAN Abschnitt 4), läuft als Erstes in app.init(). Idempotent: ein zweiter Lauf
  // ändert nichts. Rückgabe { from, created }:
  //   from 2 (Fall 1) bereits Version 2, 1 (Fall 3) Bürg-Daten übernommen, null (Fall 2) frische Installation
  //   und bei hw:v > 2 (Fall 4); die App erkennt dann storeNewer an storage.get('v', 2) > 2.
  //   created: der angelegte Bürg-Ort (nur Fall 3), sonst null.
  // Optionen (nur für Tests, Muster aus Abschnitt 3): nowMs, newId.
  //
  // Reihenfolge in Fall 3 wie im Plan: erst den neuen Zustand schreiben (hw:places, hw:active), dann die
  // alten Schlüssel löschen, zuletzt hw:v. Bricht der Lauf dazwischen ab, findet der nächste Lauf die
  // Orte schon vor und legt keinen zweiten an (Wiederaufnahme unten). Steht der neue Zustand nicht im
  // Backend (voll, gesperrt), bleiben die alten Schlüssel stehen und hw:v nur im Arbeitsspeicher; der
  // nächste Start versucht es noch einmal. Fremde hw:*-Schlüssel (Fall 5) fasst nichts davon an.
  function migrate(opts) {
    const o = opts || {};
    const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
    const makeId = typeof o.newId === 'function' ? o.newId : newId;
    const result = { from: null, created: null };
    try {
      // Fall 1 (v === 2) und Fall 4 (v > 2): nichts anfassen
      const v = get('v');
      if (typeof v === 'number' && Number.isFinite(v) && v >= VERSION) {
        if (v === VERSION) { result.from = 2; }
        return result;
      }

      const legacy = LEGACY_KEYS.some((k) => read(PREFIX + k) !== null);
      const places = get('places');
      const hasPlaces = Array.isArray(places);

      // Fall 2: frische Installation, auch eine abgebrochene (hw:places [] steht, hw:v fehlt noch). Ein
      // leeres [] zu überschreiben ist harmlos; nur eine nicht leere Ortsliste gilt als Wiederaufnahme von Fall 3.
      if (!legacy && !(hasPlaces && places.length > 0)) {
        set('places', []);
        set('v', VERSION);
        return result;
      }

      // Fall 3 (und seine Wiederaufnahme nach Abbruch): hw:v fehlt, aber es gibt Daten
      result.from = 1;
      let durable = true;
      if (legacy && !(hasPlaces && places.length > 0)) {
        const place = buergPlace(makeId(), nowMs);
        const okPlaces = set('places', [place]);
        const okActive = set('active', place.id);
        durable = okPlaces && okActive;
        result.created = place;
      }
      if (durable) {
        for (const k of LEGACY_KEYS) { remove(k); }
        set('v', VERSION);
      } else {
        mem.set(PREFIX + 'v', JSON.stringify(VERSION));
      }
      return result;
    } catch (e) {
      // nicht zu Ende gekommen (zum Beispiel ohne crypto keine Id): nichts übernommen, der nächste Start
      // versucht es noch einmal
      return { from: null, created: null };
    }
  }

  const api = { use, get, set, remove, migrate };
  // null | 'blocked' | 'full'; löst das Backend beim ersten Zugriff mit auf, damit der Wert nie veraltet ist
  Object.defineProperty(api, 'degraded', {
    enumerable: true,
    get() {
      resolve();
      if (blocked || readOnly) { return 'blocked'; }
      return full ? 'full' : null;
    }
  });

  root.Heizwarte.storage = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
