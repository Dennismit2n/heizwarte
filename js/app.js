/*
 * Heizwarte — Zustand, Einrichtung, Rendern und Abruf. Als einzige Datei darf app.js beim Laden etwas tun.
 *
 * Stand dieses Schritts: die Einrichtung S1 bis S5 (BAUPLAN Abschnitt 6) und der Hauptbildschirm bis zum
 * Heizfahrplan: Kopfzeile, Statuszeile, Jetzt, Ampel, Warnungen, Tage, Fahrplan (Abschnitt 8, Blöcke 1 bis 7) samt
 * Abruf (refresh) mit Cache je Ort. Kurve, Lüften, Einstellungen, Fußzeile und Service Worker kommen in den
 * nächsten Schritten dazu.
 *
 * Aller Text der Oberfläche steht in i18n.js und kommt hier nur über t() in die Seite. Was ein Dienst liefert
 * (Photon-Beschriftungen, Warntexte), geht ausschließlich per textContent hinein. innerHTML gibt es nur in
 * setSvg(), und dorthin kommt nur, was chart.js aus Zahlen und eigenen Bausteinen baut.
 */
(function (root) {
  'use strict';

  const MAX_PLACES = 5;
  const LABEL_MAX = 40;
  const ELEV_MIN = -500;
  const ELEV_MAX = 9000;
  const DEFAULT_COMFORT = 20;
  const HEAT_TYPES = ['radiator', 'floorScreed', 'floorDry', 'heatpumpFloor', 'storage'];
  const SCREENS = ['s-welcome', 's-address', 's-hits', 's-confirm', 's-profile', 's-main', 's-settings'];

  // Ohne force ruft refresh() frühestens 60 Sekunden nach dem letzten Abruf noch einmal ab (Flatterschutz, Abschnitt 5 app)
  const THROTTLE_MS = 60000;
  // So viele Sekunden nennt statusWaiting, wenn der Wetterdienst keine gültige Wartezeit mitgeteilt hat (Abschnitt 5 weather)
  const WAIT_DEFAULT_S = 60;
  // So lange gilt der „current“-Block der Antwort als Jetzt-Wert; danach nimmt die Anzeige die Stunde der Prognose (Entwurf)
  const FRESH_MS = 90 * 60000;
  // So lange wartet der Standort-Weg höchstens, die Zeit für die Standortabfrage des Browsers eingeschlossen. Großzügig,
  // damit auch wer langsam liest, die Abfrage beantworten kann; danach führt errGeoFailed mit zwei Knöpfen weiter.
  const LOCATE_DEADLINE_MS = 30000;

  // Ampelfarbe je Stufe 0 bis 3 (CSS-Variablen aus style.css)
  const LEVEL_COLOR = ['var(--ok)', 'var(--warn)', 'var(--alarm)', 'var(--crit)'];
  // Schlüssel je Stufe 0 bis 3: Name, Handlungssatz ({when} ab Stufe 1), Begründungssatz ({onset}, {lead} ab Stufe 1)
  const LEVEL_KEYS = ['level0', 'level1', 'level2', 'level3'];
  const TITLE_KEYS = ['levelTitle0', 'levelTitle1', 'levelTitle2', 'levelTitle3'];
  const TEXT_KEYS = ['levelText0', 'levelText1', 'levelText2', 'levelText3'];
  // PlanEntry.charge → Schlüssel (Nachtspeicher)
  const CHARGE_KEY = { high: 'chargeHigh', up: 'chargeUp', normal: 'chargeNormal', low: 'chargeLow' };
  // PlanEntry.strength → Schlüssel (Heizstufe der Nacht)
  const STRENGTH_KEY = { through: 'strengthThrough', up: 'strengthUp', normal: 'strengthNormal', low: 'strengthLow' };
  // Heizart → Schlüssel ihres Namens (Überschrift des Fahrplans)
  const PROFILE_KEY = {
    radiator: 'profileRadiator',
    floorScreed: 'profileFloorScreed',
    floorDry: 'profileFloorDry',
    heatpumpFloor: 'profileHeatpumpFloor',
    storage: 'profileStorage'
  };
  // Weiter als so viele Meter weg zählt die MOSMIX-Station nicht mehr als nah: dann keine zweite Meinung im
  // Fahrplan (und später keine Linie in der Kurve). Annahme 25 km, KT §6.1.
  const MOS_NEAR_M = 25000;

  // Schrittzähler je Weg (Tabelle in Abschnitt 6): S1 hat keinen; der Nachtrag aus den Einstellungen zählt wie die Adresse
  const STEP_OF = {
    address: { 's-address': 1, 's-hits': 2, 's-confirm': 3, 's-profile': 4, of: 4 },
    location: { 's-confirm': 1, 's-profile': 2, of: 2 }
  };

  // Art eines Treffers → Schlüssel der Beschriftung
  const KIND_KEY = { house: 'hitHouse', street: 'hitStreet', place: 'hitPlace', poi: 'hitPoi' };

  // Module werden in init() aufgelöst, nicht beim Laden
  let storage = null;
  let i18n = null;
  let geo = null;
  let heat = null;
  let weather = null;
  let chart = null;

  const state = {
    places: [],
    activeId: null,
    place: null,
    cache: null,
    model: null,
    verdict: null,
    source: 'none',
    loading: false,
    // Zustand der Statuszeile nach der Tabelle in Abschnitt 8 Punkt 2 (statusLines macht den Text daraus):
    // 'loading' | 'live' | 'offline' | 'failed' | 'waiting' | 'rateLimited' | 'noCache'; vor dem ersten Abruf null
    status: null,
    lastFetchMs: 0,
    waitUntilMs: 0,
    // Sekunden, die der Wetterdienst um Geduld bat (statusWaiting{s}); nur bei status 'waiting'
    waitS: 0,
    problems: [],
    // true, wenn hw:v neuer ist als diese Fassung: dann bleibt der Speicher unangetastet (storeNewer)
    newer: false,
    screen: null,
    // Einrichtung: { step, fields: { street, zip, city }, hits, chosen, elev, … } oder null
    setup: null
  };

  // ---------------------------------------------------------------------------------------------
  // Kleine Helfer
  // ---------------------------------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function t(key, vars) {
    return i18n.t(key, vars);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  // Kürzt nach Zeichen, nicht nach UTF-16-Einheiten, damit kein Emoji in der Mitte reißt
  function clip(text, max) {
    return Array.from(String(text)).slice(0, max).join('');
  }

  function hasGeolocation() {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
  }

  // 8 Hex-Zeichen aus crypto.getRandomValues, nie aus dem Namen (BAUPLAN Abschnitt 4, Place.id). Ohne crypto
  // (gibt es in keinem Browser mit localStorage) greift Math.random; die Id ist kein Geheimnis, nur eindeutig.
  function newId(taken) {
    for (let tries = 0; tries < 20; tries++) {
      const bytes = new Uint8Array(4);
      const c = root.crypto;
      if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(bytes);
      } else {
        for (let i = 0; i < bytes.length; i++) { bytes[i] = Math.floor(Math.random() * 256); }
      }
      let id = '';
      for (let i = 0; i < bytes.length; i++) { id += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); }
      if (taken.indexOf(id) < 0) { return id; }
    }
    return String(Date.now());
  }

  // Hausnummer aus dem Straßenfeld: erst am Ende („Marktstraße 1 a“, „Hauptstraße 12/1“, „Am Markt 5-7“), sonst am
  // Anfang („10 Downing Street“). Rein; geo.rank vergleicht ohne Leerraum („12 / 1“ trifft „12/1“).
  function extractNumber(street) {
    const s = String(street || '').trim();
    const end = /(\d+\s?[A-Za-z]?(?:\s?[/-]\s?\d+\s?[A-Za-z]?)?)$/.exec(s);
    if (end) { return end[1]; }
    const start = /^(\d+\s?[A-Za-z]?)(?=\s|$)/.exec(s);
    return start ? start[1] : '';
  }

  // ---------------------------------------------------------------------------------------------
  // Speicher
  // ---------------------------------------------------------------------------------------------

  // Schreibt nie, wenn die Daten von einer neueren Fassung stammen (Abschnitt 4, Migration Punkt 4). Nach jedem
  // Schreiben zieht der Hinweis am Seitenkopf nach: Ein Speicher, der erst jetzt voll oder gesperrt ist, soll
  // sofort sichtbar werden und nicht erst beim nächsten Start.
  function persist(key, value) {
    if (state.newer) { return false; }
    const ok = storage.set(key, value);
    updateNotes();
    return ok;
  }

  function isPlace(p) {
    return !!p && typeof p === 'object' && typeof p.id === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
      !!p.heat && typeof p.heat === 'object';
  }

  function placeById(id) {
    for (const p of state.places) {
      if (p.id === id) { return p; }
    }
    return null;
  }

  // Lesen ist tolerant: unbekannte Felder bleiben unbeachtet, kaputte Orte fallen weg
  function loadPlaces() {
    const raw = storage.get('places', []);
    state.places = Array.isArray(raw) ? raw.filter(isPlace).slice(0, MAX_PLACES) : [];
    const active = storage.get('active', null);
    state.activeId = placeById(active) ? active : (state.places.length ? state.places[0].id : null);
    state.place = placeById(state.activeId);
  }

  // Hinweise am Seitenkopf: Speicher gesperrt oder voll, Daten von neuerer Fassung
  function updateNotes() {
    const degraded = storage.degraded;
    $('noteBlocked').hidden = degraded !== 'blocked';
    $('noteFull').hidden = degraded !== 'full';
    $('noteNewer').hidden = !state.newer;
  }

  // ---------------------------------------------------------------------------------------------
  // Bildschirme, Zähler, Fokus
  // ---------------------------------------------------------------------------------------------

  function stepFor(screen) {
    const s = state.setup;
    if (!s || s.reentry) { return null; }
    const table = STEP_OF[s.way];
    return table && table[screen] ? { n: table[screen], of: table.of } : null;
  }

  function renderStep() {
    const step = stepFor(state.screen);
    $('setupStep').textContent = step ? t('setupStep', { n: step.n, of: step.of }) : '';
  }

  // Schaltet hidden um. Der Fokus geht auf die <h2> des neuen Bildschirms (tabindex -1), nie auf body, weil der
  // vorher fokussierte Knopf mit seinem Bildschirm verschwindet. opts.focus === false: Fokus bleibt (App-Start).
  function showScreen(id, opts) {
    const o = opts || {};
    state.screen = id;
    if (state.setup) { state.setup.step = id; }
    for (const s of SCREENS) { $(s).hidden = s !== id; }
    clearAllErrors();
    renderStep();
    if (o.focus !== false) {
      if (typeof window.scrollTo === 'function') { window.scrollTo(0, 0); }
      const h = $(id).querySelector('h2');
      if (h) { h.focus(); }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Fehlertexte: ein <div role="alert"> je Bildschirm, darunter Knöpfe, die weiterführen (Abschnitt 6)
  // ---------------------------------------------------------------------------------------------

  function toggleActions(name, wanted) {
    const box = $('act-' + name);
    if (!box) { return; }
    for (const b of box.querySelectorAll('[data-act]')) {
      const act = b.getAttribute('data-act');
      b.hidden = wanted.indexOf(act) < 0 || (act === 'location' && !hasGeolocation());
    }
  }

  // keys: Schlüssel der Sätze; actions: welche Auswege sichtbar sind; opts.focus false lässt den Fokus, wo er ist.
  // Der Satz steht erst im Moment des Fehlers im Alert-Div, damit Screenreader ihn ansagen.
  function showError(name, keys, actions, opts) {
    const box = $('err-' + name);
    box.replaceChildren();
    for (const k of keys) { box.appendChild(make('p', '', t(k))); }
    toggleActions(name, actions || []);
    if (!opts || opts.focus !== false) { box.focus(); }
  }

  // Der Hauptknopf je Bildschirm: dorthin geht der Fokus, wenn der gedrückte Ausweg mit seiner Fehlerzeile verschwindet
  const PRIMARY = { welcome: 'btnByAddress', address: 'btnSearch', confirm: 'btnConfirmYes' };

  function clearError(name) {
    const actions = $('act-' + name);
    const screen = $('s-' + name);
    // Fokus nie auf body fallen lassen: ein Ausweg, der gerade gedrückt wurde, wird mit der Fehlerzeile versteckt
    if (actions && screen && !screen.hidden && actions.contains(document.activeElement)) { $(PRIMARY[name]).focus(); }
    $('err-' + name).replaceChildren();
    toggleActions(name, []);
  }

  function clearAllErrors() {
    for (const name of ['welcome', 'address', 'confirm']) { clearError(name); }
    setInvalid(['f-zip', 'f-city', 'f-elev'], false);
  }

  function setInvalid(ids, on) {
    for (const id of ids) {
      if (on) { $(id).setAttribute('aria-invalid', 'true'); } else { $(id).removeAttribute('aria-invalid'); }
    }
  }

  // Knopf mit Laufanzeige: aria-disabled statt disabled, damit er den Fokus behält und für Tab sichtbar bleibt
  function markBusy(btn, on, labelKey) {
    if (on) { btn.setAttribute('aria-disabled', 'true'); } else { btn.removeAttribute('aria-disabled'); }
    btn.setAttribute('data-i18n', labelKey);
    btn.textContent = t(labelKey);
  }

  function resetBusyUi() {
    markBusy($('btnSearch'), false, 'setupSearch');
    markBusy($('btnByLocation'), false, 'setupByLocation');
    markBusy($('btnAddrLocation'), false, 'setupByLocation');
    markBusy($('btnConfirmYes'), false, 'setupConfirmYes');
  }

  // Bricht laufende Abrufe der Einrichtung ab: ihre späte Antwort wird verworfen (Zähler opToken)
  function cancelOps() {
    const s = state.setup;
    if (!s) { return; }
    s.opToken += 1;
    if (s.busy) {
      s.busy = false;
      resetBusyUi();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Einrichtung: Zustand
  // ---------------------------------------------------------------------------------------------

  function newSetup(add) {
    return {
      step: null,
      // true: Nachtrag aus den Einstellungen (beginnt bei S2, Zurück führt nach s-settings)
      add: !!add,
      // 'address' oder 'location': bestimmt den Schrittzähler
      way: 'address',
      fields: { street: '', zip: '', city: '' },
      // getippte Hausnummer der letzten Suche (für setupNoNumber)
      number: '',
      hits: [],
      chosen: null,
      // automatisch ermittelte Höhe und ihr Stand: 'loading' | 'ok' | 'unknown'
      elev: null,
      elevState: 'loading',
      elevToken: 0,
      elevPromise: null,
      elevTyped: false,
      geoWrong: false,
      // Eine Anfrage zur Zeit (Ein-Aufruf-Regel); opToken verwirft späte Antworten nach Zurück
      busy: false,
      opToken: 0,
      // S5 für einen schon gespeicherten Ort, aufgerufen aus dem Hauptbildschirm (Hinweis setupHeatDefaultHint)
      reentry: false,
      placeId: null
    };
  }

  function clearAddressFields() {
    $('f-street').value = '';
    $('f-zip').value = '';
    $('f-city').value = '';
  }

  // Beginnt die Einrichtung. opts.add: Nachtrag, dann gleich bei S2. opts.focus false: App-Start, Fokus bleibt.
  function showSetup(opts) {
    const o = opts || {};
    state.setup = newSetup(o.add);
    clearAddressFields();
    resetBusyUi();
    if (o.add) {
      goAddress({ focus: o.focus });
    } else {
      showScreen('s-welcome', { focus: o.focus });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // S1 Start und der Standort-Weg
  // ---------------------------------------------------------------------------------------------

  // „Mit Adresse“ führt immer weiter, auch während einer Standortsuche: Bleibt die Standortabfrage unbeantwortet
  // (Chromes Berechtigungs-Chip klappt ein, Firefox schließt die Abfrage bei einem Klick daneben), wartete die Suche
  // sonst ohne Ende und S1 hätte keinen Ausweg. cancelOps verwirft ihre späte Antwort (opToken).
  function onByAddress() {
    const s = state.setup;
    if (!s) { return; }
    if (s.busy) { cancelOps(); }
    s.way = 'address';
    goAddress();
  }

  // Standort mit eigener Frist (LOCATE_DEADLINE_MS): Die Frist von geo.locate gilt erst nach der Erlaubnis, die Zeit
  // bis zur Antwort auf die Standortabfrage zählt dort nicht mit. Diese hier umfasst beides; danach steht
  // errGeoFailed mit „Nochmal“ und „Weiter“ (Abschnitt 6). Eine spätere Antwort des Geräts verpufft im Promise.race.
  function locateWithDeadline() {
    let timer = null;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new geo.GeoError('timeout', 'Standort: keine Antwort innerhalb von ' + (LOCATE_DEADLINE_MS / 1000) + ' s'));
      }, LOCATE_DEADLINE_MS);
    });
    return Promise.race([geo.locate(navigator.geolocation), deadline]).finally(() => { clearTimeout(timer); });
  }

  function onLocationFailure(failure, where) {
    const code = failure && failure.code;
    const denied = code === 'denied';
    if (!denied && code !== 'unavailable' && code !== 'timeout') { console.error(failure); }
    const key = denied ? 'errGeoDenied' : 'errGeoFailed';
    if (where === 'address') {
      // auf S2 führt das Formular selbst weiter; nur ein nicht verweigerter Standort lässt sich noch einmal versuchen
      showError('address', [key], denied ? [] : ['location']);
    } else {
      showError('welcome', [key], denied ? ['next'] : ['retry', 'next']);
    }
  }

  // Position → auf etwa 100 m gerundet → Photon reverse (Wahl a, Abschnitt 5 geo) → S4. Die rohe Position
  // verlässt das Gerät nie. Läuft von S1 und, als zweiter Weg bei Netzfehlern, von S2.
  async function onByLocation() {
    const s = state.setup;
    if (!s || s.busy) { return; }
    s.busy = true;
    const token = ++s.opToken;
    const stale = () => state.setup !== s || s.opToken !== token;
    const where = state.screen === 's-address' ? 'address' : 'welcome';
    // Die Laufanzeige sitzt auf einem sichtbaren Knopf. Auf S2 verschwindet der Ausweg „Standort verwenden“ mit
    // seiner Fehlerzeile; dort trägt der Hauptknopf „Sucht …“, denn er nimmt währenddessen keine Klicks an.
    const btn = $(where === 'address' ? 'btnSearch' : 'btnByLocation');
    const idleKey = where === 'address' ? 'setupSearch' : 'setupByLocation';
    clearError(where);
    markBusy(btn, true, 'setupSearching');

    let hit = null;
    let failure = null;
    try {
      const pos = await locateWithDeadline();
      if (stale()) { return; }
      const lat = geo.round3(pos.lat);
      const lon = geo.round3(pos.lon);
      hit = await geo.reverse(lat, lon, { lang: i18n.lang });
      if (stale()) { return; }
      if (!hit) {
        // Kein Treffer: Standort ohne Adresse, S4 zeigt „Dein Standort“ und die gerundeten Koordinaten
        hit = { my: true, lat, lon, cc: null, label: '', line2: '', region: '', hasNumber: false, kind: 'poi', parts: {}, extent: null };
      }
    } catch (e) {
      failure = e;
    }
    if (stale()) { return; }

    s.busy = false;
    markBusy(btn, false, idleKey);
    if (failure) {
      onLocationFailure(failure, where);
      return;
    }
    s.way = 'location';
    s.number = '';
    s.hits = [];
    chooseHit(hit);
  }

  // ---------------------------------------------------------------------------------------------
  // S2 Adresse und Suche
  // ---------------------------------------------------------------------------------------------

  function goAddress(opts) {
    const s = state.setup;
    $('geoWrong').hidden = !s.geoWrong;
    showScreen('s-address', opts);
  }

  function readFields() {
    const f = {
      street: $('f-street').value.trim(),
      zip: $('f-zip').value.trim(),
      city: $('f-city').value.trim()
    };
    state.setup.fields = f;
    return f;
  }

  function setSearching(on) {
    markBusy($('btnSearch'), on, on ? 'setupSearching' : 'setupSearch');
  }

  // Klick und Enter im Ortsfeld laufen durch dieselbe Prüfung. Ohne Ort und Postleitzahl kein Netzaufruf.
  function onSearch() {
    const s = state.setup;
    if (!s || s.busy) { return; }
    const f = readFields();
    setInvalid(['f-zip', 'f-city'], false);
    clearError('address');
    if (!f.zip && !f.city) {
      setInvalid(['f-zip', 'f-city'], true);
      // der Satz steht im Alert, der Fokus geht ausnahmsweise ins Feld, weil das Feld selbst der Ausweg ist
      showError('address', ['errNeedPlace'], [], { focus: false });
      $('f-city').focus();
      return;
    }
    s.number = extractNumber(f.street);
    s.geoWrong = false;
    $('geoWrong').hidden = true;
    runSearch({ street: f.street, zip: f.zip, city: f.city });
  }

  // Der Ausweg nach „nichts gefunden“: nur der Ort, ohne Straße. Fehlt der Ort, nimmt die Suche die Postleitzahl.
  function onCityOnly() {
    const s = state.setup;
    if (!s || s.busy) { return; }
    const f = readFields();
    const place = f.city || f.zip;
    if (!place) { onSearch(); return; }
    clearError('address');
    s.number = '';
    s.geoWrong = false;
    $('geoWrong').hidden = true;
    runSearch({ city: place }, true);
  }

  // Genau ein geo.search() je Aufruf. Während er läuft, trägt der Knopf aria-disabled und weitere Klicks verpuffen.
  async function runSearch(query, cityOnly) {
    const s = state.setup;
    s.busy = true;
    const token = ++s.opToken;
    setSearching(true);

    let ranked = null;
    let failure = null;
    try {
      const hits = await geo.search(query, { lang: i18n.lang });
      ranked = geo.rank(hits, { housenumber: s.number });
    } catch (e) {
      failure = e;
    }
    if (state.setup !== s || s.opToken !== token) { return; }

    s.busy = false;
    setSearching(false);
    if (failure) {
      onSearchFailure(failure);
      return;
    }
    if (!ranked.length) {
      const f = s.fields;
      // „Nur den Ort suchen“ hilft nur, wenn die Suche vorher mehr als den Ort enthielt
      const narrower = !cityOnly && !!f.city && (!!f.street || !!f.zip);
      showError('address', ['errNoHit', 'errNoHitTip1', 'errNoHitTip2'], narrower ? ['cityOnly'] : []);
      return;
    }
    s.hits = ranked;
    if (ranked.length === 1) {
      // Bei genau einem Treffer entfällt S3; der Zähler in S4 bleibt „3 von 4“
      chooseHit(ranked[0]);
    } else {
      goHits();
    }
  }

  function onSearchFailure(failure) {
    const code = failure && failure.code;
    if (code === 'rejected') {
      // Photon bittet um Pause: kein automatischer Wiederholungsversuch, nur der Knopf
      showError('address', ['errSearchRejected'], ['retry']);
      return;
    }
    if (code !== 'offline') { console.error(failure); }
    showError('address', ['errOfflineSearch'], ['retry', 'location']);
  }

  function onAddrBack() {
    const s = state.setup;
    if (!s) { return; }
    cancelOps();
    if (s.add) {
      state.setup = null;
      showScreen('s-settings');
    } else {
      showScreen('s-welcome');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // S3 Treffer
  // ---------------------------------------------------------------------------------------------

  // Die Hausnummer-Warnung gilt nur dort, wo „Straßenmitte“ stimmt: bei Straßen und Häusern (Annahme, Plan sagt allgemein
  // hit.hasNumber === false); bei einem Ort oder einer Einrichtung wäre der Satz falsch
  function missingNumber(hit) {
    const s = state.setup;
    return !!s && !!s.number && !hit.hasNumber && (hit.kind === 'street' || hit.kind === 'house');
  }

  function hitLabel(hit) {
    if (hit.my) { return t('setupMyPlace'); }
    return hit.label || hit.line2 || '–';
  }

  function renderHits() {
    const s = state.setup;
    const list = $('hitList');
    list.replaceChildren();
    if (!s) { return; }
    s.hits.forEach((hit, i) => {
      const btn = make('button', 'hit');
      btn.type = 'button';
      btn.setAttribute('data-index', String(i));
      btn.appendChild(make('span', 'hit-label', hitLabel(hit)));
      if (hit.line2) { btn.appendChild(make('span', 'hit-line', hit.line2)); }
      if (KIND_KEY[hit.kind]) { btn.appendChild(make('span', 'hit-kind', t(KIND_KEY[hit.kind]))); }
      if (missingNumber(hit)) { btn.appendChild(make('span', 'hit-note', t('setupNoNumber'))); }
      const li = make('li');
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function goHits() {
    renderHits();
    showScreen('s-hits');
  }

  function onHitClick(e) {
    const s = state.setup;
    const btn = e.target && e.target.closest ? e.target.closest('button.hit') : null;
    if (!s || !btn) { return; }
    const hit = s.hits[Number(btn.getAttribute('data-index'))];
    if (hit) { chooseHit(hit); }
  }

  function onHitsBack() {
    cancelOps();
    goAddress();
  }

  // Treffer gewählt (aus S3, bei einem einzigen Treffer aus S2, oder vom Standort): die Höhe startet sofort parallel
  function chooseHit(hit) {
    const s = state.setup;
    s.chosen = hit;
    startElevation(hit);
    goConfirm();
  }

  // ---------------------------------------------------------------------------------------------
  // S4 Bestätigen
  // ---------------------------------------------------------------------------------------------

  function startElevation(hit) {
    const s = state.setup;
    const token = ++s.elevToken;
    s.elev = null;
    s.elevState = 'loading';
    s.elevTyped = false;
    // geo.elevation rundet selbst auf drei Stellen und wirft nie
    s.elevPromise = geo.elevation(hit.lat, hit.lon).then((m) => {
      if (state.setup !== s || s.elevToken !== token) { return m; }
      s.elev = m;
      s.elevState = m === null ? 'unknown' : 'ok';
      if (state.screen === 's-confirm') {
        if (m !== null && !s.elevTyped) { $('f-elev').value = String(m); }
        renderElevation();
      }
      return m;
    });
  }

  // Inhalt des Höhenfelds: leer, Zahl im Bereich oder ungültig (auch „abc“ in einem number-Feld)
  function readElev() {
    const input = $('f-elev');
    if (input.validity && input.validity.badInput) { return { kind: 'bad' }; }
    const raw = input.value.trim();
    if (raw === '') { return { kind: 'empty' }; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < ELEV_MIN || n > ELEV_MAX) { return { kind: 'bad' }; }
    const rounded = Math.round(n);
    return { kind: 'ok', n: rounded === 0 ? 0 : rounded };
  }

  function renderElevation() {
    const s = state.setup;
    const val = $('c-elevVal');
    const auto = $('c-elevAuto');
    const manual = readElev();
    auto.hidden = true;
    if (manual.kind === 'ok' && manual.n !== s.elev) {
      val.textContent = t('setupElev', { m: i18n.fmt.num(manual.n, 0) });
    } else if (s.elevState === 'ok') {
      val.textContent = t('setupElev', { m: i18n.fmt.num(s.elev, 0) });
      auto.hidden = false;
    } else if (s.elevState === 'unknown') {
      val.textContent = t('setupElevUnknown');
    } else {
      val.textContent = t('setupElevLoading');
    }
  }

  function setLine(id, text) {
    const p = $(id);
    p.textContent = text;
    p.hidden = !text;
  }

  // Umriss als „Umriss etwa 22 × 28 m“ bzw. „Umriss etwa 2,1 × 1,4 km“. Die Einheit steht im Schlüssel
  // (setupExtent für Meter, setupExtentKm für Kilometer), hierher kommen nur Zahlen. Kilometer nur, wenn beide Maße
  // mindestens 1000 m sind; sonst beide in Metern, damit ein schmaler, langer Umriss nicht „0,0 × 1,2 km“ heißt.
  // Rein: size { w, h } in Metern (geo.extentSize) oder null, fmt { t, num }. Nichts bei Punkten ohne Umriss.
  function extentLine(size, fmt) {
    if (!size || !isNum(size.w) || !isNum(size.h)) { return ''; }
    if (Math.max(size.w, size.h) < 1) { return ''; }
    if (Math.min(size.w, size.h) >= 1000) {
      return fmt.t('setupExtentKm', { w: fmt.num(size.w / 1000, 1), h: fmt.num(size.h / 1000, 1) });
    }
    return fmt.t('setupExtent', { w: fmt.num(Math.max(1, Math.round(size.w)), 0), h: fmt.num(Math.max(1, Math.round(size.h)), 0) });
  }

  function extentText(hit) {
    return extentLine(geo.extentSize(hit.extent, hit.lat), { t, num: i18n.fmt.num });
  }

  function coordsOf(hit) {
    const f = i18n.fmt;
    return { lat: f.num(geo.round3(hit.lat), 3), lon: f.num(geo.round3(hit.lon), 3) };
  }

  function renderConfirm() {
    const s = state.setup;
    const hit = s && s.chosen;
    if (!hit) { return; }
    const c = coordsOf(hit);
    $('c-label').textContent = hitLabel(hit);
    // Ohne Adresse (Standort ohne Reverse-Treffer) stehen die gerundeten Koordinaten in der zweiten Zeile
    setLine('c-line2', hit.my ? c.lat + ' / ' + c.lon : hit.line2);
    setLine('c-region', hit.region ? t('setupRegion', { region: hit.region }) : '');
    setLine('c-extent', extentText(hit));
    $('c-coords').textContent = t('setupCoords', c);
    $('c-nonumber').hidden = !missingNumber(hit);
    renderElevation();
  }

  function openElevEdit(open) {
    $('elevEdit').hidden = !open;
    $('btnElevChange').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { $('f-elev').focus(); }
  }

  function goConfirm() {
    const s = state.setup;
    $('f-elev').value = '';
    openElevEdit(false);
    $('f-label').value = clip(hitLabel(s.chosen), LABEL_MAX);
    renderConfirm();
    showScreen('s-confirm');
  }

  // „Nein, zurück“: Ziel je nach Weg (Abschnitt 6, Rückwege)
  function onConfirmNo() {
    const s = state.setup;
    if (!s) { return; }
    cancelOps();
    if (s.way === 'location') {
      // Standort-Weg: zur Adresseingabe, der Ort aus dem Reverse-Treffer vorbelegt (nur wenn es einen gab)
      const hit = s.chosen;
      if (hit && !hit.my && hit.parts && hit.parts.city) { $('f-city').value = hit.parts.city; }
      s.way = 'address';
      s.geoWrong = true;
      goAddress();
    } else if (s.hits.length > 1) {
      goHits();
    } else {
      goAddress();
    }
  }

  function makePlace(s, elev, auto) {
    const hit = s.chosen;
    const typed = $('f-label').value.trim();
    const p = heat.PROFILES.radiator;
    return {
      id: newId(state.places.map((x) => x.id)),
      label: clip(typed || hitLabel(hit), LABEL_MAX),
      // gespeichert wird nur die auf etwa 100 m gerundete Koordinate (DoD 5)
      lat: geo.round3(hit.lat),
      lon: geo.round3(hit.lon),
      elev,
      elevAuto: auto,
      cc: hit.cc || null,
      tz: null,
      heat: { type: 'radiator', leadMin: p.leadMin, leadMax: p.leadMax, comfort: DEFAULT_COMFORT, thresh: null, confirmed: false },
      created: Date.now()
    };
  }

  // „Ja, das stimmt“: Der Ort wird sofort gespeichert und aktiv, danach S5. Ist die Höhe noch unterwegs und das
  // Feld leer, wartet der Knopf auf sie (höchstens die 8 Sekunden von geo.elevation).
  async function onConfirmYes() {
    const s = state.setup;
    if (!s || s.busy) { return; }
    clearError('confirm');
    setInvalid(['f-elev'], false);

    const manual = readElev();
    if (manual.kind === 'bad') {
      openElevEdit(true);
      setInvalid(['f-elev'], true);
      showError('confirm', ['errElevRange']);
      return;
    }
    if (state.places.length >= MAX_PLACES) {
      showError('confirm', ['errMaxPlaces']);
      return;
    }

    s.busy = true;
    const token = ++s.opToken;
    markBusy($('btnConfirmYes'), true, 'setupConfirmYes');

    let elev = null;
    let auto = false;
    if (manual.kind === 'ok') {
      elev = manual.n;
      auto = elev === s.elev;
    } else {
      if (s.elevState === 'loading' && s.elevPromise) { await s.elevPromise; }
      if (state.setup !== s || s.opToken !== token) { return; }
      elev = s.elev;
      auto = elev !== null;
    }

    const place = makePlace(s, elev, auto);
    state.places.push(place);
    persist('places', state.places);
    persist('active', place.id);
    state.activeId = place.id;
    state.place = place;
    // der neue Ort hat noch keine Daten: die Anzeige darf nicht die des vorigen Orts behalten
    loadCache();
    s.placeId = place.id;

    s.busy = false;
    markBusy($('btnConfirmYes'), false, 'setupConfirmYes');
    // Adresse und ungerundete Treffer werden nicht aufgehoben (B:63): nach dem Speichern bleibt nur der Ort
    clearAddressFields();
    s.fields = { street: '', zip: '', city: '' };
    s.hits = [];
    s.chosen = null;
    goProfile();
  }

  // ---------------------------------------------------------------------------------------------
  // S5 Heizart
  // ---------------------------------------------------------------------------------------------

  function goProfile() {
    const s = state.setup;
    const place = placeById(s.placeId);
    if (!place) {
      showMain({ focusNow: true });
      return;
    }
    const type = HEAT_TYPES.indexOf(place.heat.type) >= 0 ? place.heat.type : 'radiator';
    $('r-' + type).checked = true;
    showScreen('s-profile');
  }

  function selectedType() {
    const checked = document.querySelector('input[name="heatType"]:checked');
    return checked && HEAT_TYPES.indexOf(checked.value) >= 0 ? checked.value : 'radiator';
  }

  // Heizart setzen: Beim Wechsel der Heizart kommen die Aufheizzeiten aus ihrer Tabelle (Abschnitt 7); bleibt die
  // Heizart dieselbe, bleiben auch eigene Aufheizzeiten stehen. Raumtemperatur und Schwellen bleiben immer.
  function applyHeatType(place, type, confirmed) {
    if (type !== place.heat.type) {
      const p = heat.PROFILES[type] || heat.PROFILES.radiator;
      place.heat.type = type;
      place.heat.leadMin = p.leadMin;
      place.heat.leadMax = p.leadMax;
    }
    place.heat.confirmed = confirmed;
  }

  // „Fertig“ bestätigt die Wahl; „Weiß ich nicht“ lässt es beim Heizkörper und bei confirmed false
  function finishProfile(known) {
    const s = state.setup;
    const place = s && placeById(s.placeId);
    if (!place) { return; }
    // Ein neuer Ort hat noch keine Daten und ruft sofort ab; wer nur die Heizart nachträgt, rechnet mit den
    // vorhandenen Daten neu (showMain rendert, die Ampel nimmt die Aufheizzeiten der neuen Heizart)
    const isNew = !s.reentry;
    applyHeatType(place, known ? selectedType() : 'radiator', known);
    persist('places', state.places);
    showMain({ focusNow: true });
    if (isNew) { refresh(true); }
  }

  // ---------------------------------------------------------------------------------------------
  // Abruf und Cache (Datenfluss: weather.load → weather.model → heat.assess)
  // ---------------------------------------------------------------------------------------------

  // Läuft ein Abruf für einen Ort, hängt sich jeder weitere Aufruf für denselben Ort an ihn an (Inflight-Sperre
  // je Ort-Id). Ein Abruf kann mit dem 429-Wiederholversuch über eine Minute dauern: eine globale Sperre hielte
  // den Ortswechsel so lange fest, und die Daten des alten Orts erschienen unter dem Namen des neuen.
  const inflight = new Map();

  function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  function isCache(c) {
    return !!c && typeof c === 'object' && c.v === 2 && isNum(c.fetched) && !!c.om && typeof c.om === 'object';
  }

  // Ein Block, der wirft, darf die übrigen nicht mitreißen (Abschnitt 5 app, render)
  function guard(fn) {
    try {
      return fn();
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // Modell zum Cache: Ortszeit, Stunden, Tage, Warnungen. Scheitert die Rechnung, bleibt die Anzeige leer statt zu brechen.
  function modelOf(cache) {
    return cache ? guard(() => weather.model(cache)) : null;
  }

  // Liest den Cache des aktiven Orts (hw:cache:<id>) und rechnet das Modell dazu
  function loadCache() {
    const raw = state.activeId ? storage.get('cache:' + state.activeId, null) : null;
    state.cache = isCache(raw) ? raw : null;
    state.model = modelOf(state.cache);
    state.verdict = null;
    state.source = state.cache ? 'cache' : 'none';
  }

  function onWait(id, ms) {
    if (id !== state.activeId) { return; }
    state.status = 'waiting';
    state.waitS = Math.ceil(ms / 1000);
    state.waitUntilMs = Date.now() + ms;
    guard(renderStatus);
  }

  // Ergebnis eines Abrufs. Der Cache eines Orts wird immer geschrieben, auch wenn inzwischen ein anderer Ort aktiv
  // ist; gerendert wird nur der aktive Ort. Ein inzwischen gelöschter Ort bekommt keinen Cache zurück.
  function onFetched(id, result) {
    const place = placeById(id);
    if (!place) { return; }
    persist('cache:' + id, result.cache);
    const model = modelOf(result.cache);
    if (!place.tz && model) {
      place.tz = model.tz;
      persist('places', state.places);
    }
    if (id === state.activeId) {
      state.cache = result.cache;
      state.model = model;
      state.problems = result.problems;
      state.source = 'live';
      state.status = 'live';
      state.lastFetchMs = Date.now();
      render();
    } else {
      // Sicherheitsnetz: den Abruf für den jetzt aktiven Ort hat der Ortswechsel schon gestartet. Läuft er noch,
      // hängt sich der Aufruf an; ist er fertig, greift die 60-Sekunden-Sperre, es gibt keinen Doppelabruf.
      refresh(false);
    }
  }

  // Fehler eines Abrufs. Der alte Stand bleibt sichtbar; ein Fehler eines nicht mehr aktiven Orts ändert nichts
  // an der Anzeige. Erwartete Ausfälle (kein Netz, Wetterdienst ausgelastet) kommen als Warnung in die Konsole,
  // alles andere als Fehler.
  function onFetchFailed(id, failure) {
    const code = failure && failure.code;
    if (weather.OpenMeteoError && failure instanceof weather.OpenMeteoError) {
      console.warn('Heizwarte: Abruf gescheitert (' + code + ')');
    } else {
      console.error(failure);
    }
    if (id !== state.activeId) { return; }
    // auch ein gescheiterter Versuch zählt für den Flatterschutz: sonst riefe jeder Wechsel zurück in die App
    // einen ausgelasteten Wetterdienst erneut an
    state.lastFetchMs = Date.now();
    if (!state.cache) {
      state.status = 'noCache';
    } else if (code === 'rate') {
      state.status = 'rateLimited';
    } else if (code === 'offline' || code === 'timeout') {
      state.status = 'offline';
    } else {
      state.status = 'failed';
    }
    render();
  }

  async function fetchFor(id) {
    const place = placeById(id);
    let result = null;
    let failure = null;
    try {
      result = await weather.load(place, { onWait: (ms) => onWait(id, ms) });
    } catch (e) {
      failure = e;
    }
    inflight.delete(id);
    guard(() => {
      renderReload();
      if (failure) { onFetchFailed(id, failure); } else { onFetched(id, result); }
    });
  }

  // Holt das Wetter für den aktiven Ort. force umgeht den 60-Sekunden-Flatterschutz (Neu laden, Ortswechsel,
  // neuer Ort, neue Höhe). Gibt das Versprechen des laufenden Abrufs zurück; es wird nie abgelehnt.
  function refresh(force) {
    const id = state.activeId;
    if (!id || !placeById(id)) { return Promise.resolve(); }
    if (inflight.has(id)) {
      // Zurück an einen Ort gewechselt, dessen Abruf noch läuft: die Statuszeile kennt den Zustand noch nicht
      if (state.status === null) {
        state.status = 'loading';
        guard(renderStatus);
      }
      return inflight.get(id);
    }
    if (!force && Date.now() - state.lastFetchMs < THROTTLE_MS) { return Promise.resolve(); }
    state.status = 'loading';
    const job = fetchFor(id);
    inflight.set(id, job);
    renderReload();
    guard(renderStatus);
    return job;
  }

  function onVisible() {
    if (document.visibilityState === 'visible' && state.place) { refresh(false); }
  }

  // Wechsel auf einen anderen Ort: dessen Cache sofort anzeigen (oder nichts), dann neu abrufen
  function activatePlace(id) {
    const place = placeById(id);
    if (!place) { return; }
    state.activeId = id;
    state.place = place;
    persist('active', id);
    state.status = null;
    loadCache();
    render();
    refresh(true);
  }

  function onPlaceChange() {
    const id = $('placeSelect').value;
    if (id !== state.activeId) { activatePlace(id); }
  }

  // ---------------------------------------------------------------------------------------------
  // Hauptbildschirm: Kopfzeile, Jetzt, Ampel, Warnungen, drei Tage (Abschnitt 8)
  // ---------------------------------------------------------------------------------------------

  // Einzige Stelle mit innerHTML. Der Text kommt aus chart.icon() oder später chart.layout(): nur Zahlen, eigene
  // Bausteine und var(--…)-Farben, nie Text aus einer API.
  function setSvg(el, markup) {
    el.innerHTML = markup;
  }

  // Zahl mit höchstens einer Nachkommastelle, ohne „,0“: 3 Stunden, 3,5 Stunden
  function numAuto(x) {
    const r = Math.round(x * 10) / 10;
    return i18n.fmt.num(r, Number.isInteger(r) ? 0 : 1);
  }

  // Zeile mit Text oder, wenn leer, verborgen
  function setLine(id, text) {
    const p = $(id);
    p.textContent = text;
    p.hidden = !text;
  }

  // Alles, was von „jetzt“ abhängt, in einem Zug: Ortszeit, Ampel (heat.assess), Index des heutigen Tages.
  // Wird bei jedem render() neu gerechnet, weil zwischen zwei Abrufen Zeit vergeht und die Heizart sich ändern kann.
  function buildView() {
    const m = state.model;
    if (!m) { return null; }
    const now = weather.localNow(m.tz, Date.now());
    const v = heat.assess(m, now, state.place.heat, m.alerts);
    return { m, now, v, todayIdx: m.days.findIndex((d) => d.key === now.key) };
  }

  let placeSig = '';

  // Ortszeile: bei einem Ort der Name als Text, ab zwei Orten Beschriftung und natives Auswahlfeld
  function renderPlaces() {
    const many = state.places.length > 1;
    $('placeName').textContent = state.place ? state.place.label : '';
    $('placeName').hidden = many;
    $('placePick').hidden = !many;
    if (!many) { return; }
    const sel = $('placeSelect');
    const sig = state.places.map((p) => p.id + '|' + p.label).join('||');
    if (sig !== placeSig) {
      placeSig = sig;
      sel.replaceChildren();
      for (const p of state.places) {
        const opt = make('option', '', p.label);
        opt.value = p.id;
        sel.appendChild(opt);
      }
    }
    sel.value = state.activeId;
  }

  // „Neu laden“ trägt während eines Abrufs „Lädt …“ und aria-disabled (nie disabled, der Fokus bleibt)
  function renderReload() {
    const btn = $('reload');
    state.loading = inflight.has(state.activeId);
    markBusy(btn, state.loading, state.loading ? 'btnReloading' : 'btnReload');
  }

  function renderHead() {
    renderPlaces();
    $('heatHint').hidden = !(state.place && state.place.heat.confirmed === false);
    renderReload();
  }

  // Statuszeile (Abschnitt 8, Block 2): Stand und Zustand des Abrufs als zwei Sätze. Die einzige aria-live-Zeile.

  // Die Sätze der Statuszeile als fertiger Text: [{ cls, text }]. Rein: kein DOM, keine Module, keine Gerätezeit.
  //   st      { status, waitS, tooOld }: status wie state.status (null vor dem ersten Abruf), waitS die Wartezeit
  //           in Sekunden (nur bei 'waiting'), tooOld wahr, wenn die Ampel wegen zu alter Daten keine Stufe hat
  //           (verdict.level null)
  //   cache   Cache des aktiven Orts oder null; gebraucht wird nur cache.fetched
  //   nowMs   Jetzt in Epoch-Millisekunden
  //   fmt     t(key, vars), staleHours (heat.THRESH.staleHours), when(ms, nowMs) in der Ortszeit des Orts,
  //           rel(ms, nowMs) für „vor 3 Stunden“
  // Satz 1 ist der Stand (status-stamp), sobald ein Cache da ist. Satz 2 je Zustand nach der Tabelle in Abschnitt 8:
  // loading und waiting sind Hinweise (status-info), offline, failed und rateLimited beginnen selbst mit
  // „⚠ Veraltet“ (status-warn), und zwar ohne Netz unabhängig vom Alter. Ab fmt.staleHours kommt statusStale dazu,
  // auch mit Netz; ebenso bei tooOld, denn die Ampel sagt dann schon errTooOld und die Statuszeile nur „älter als
  // einen Tag“. Ohne Cache gibt es keinen Stand: loading und waiting stehen allein, ein gescheiterter Abruf
  // heißt statusNoData (jeder Weg endet bei „Neu laden“).
  function statusLines(st, cache, nowMs, fmt) {
    const status = st ? st.status : null;
    const lines = [];
    const add = (cls, key, vars) => { lines.push({ cls, text: fmt.t(key, vars) }); };
    const waiting = () => {
      const s = st && isNum(st.waitS) && st.waitS > 0 ? Math.round(st.waitS) : WAIT_DEFAULT_S;
      add('status-info', 'statusWaiting', { s });
    };

    if (!cache || !isNum(cache.fetched)) {
      if (status === 'loading') {
        add('status-info', 'statusLoading');
      } else if (status === 'waiting') {
        waiting();
      } else if (status === 'noCache' || status === 'offline' || status === 'failed' || status === 'rateLimited') {
        add('status-info', 'statusNoData');
      }
      return lines;
    }

    // Geht die Geräteuhr zurück, liegt der Abruf scheinbar in der Zukunft: dann „jetzt“ statt „in 5 Minuten“
    const fetched = cache.fetched;
    lines.push({
      cls: 'status-stamp',
      text: fmt.t('statusStamp', { when: fmt.when(fetched, nowMs), ago: fmt.rel(Math.min(fetched, nowMs), nowMs) })
    });
    if (status === 'offline') { add('status-warn', 'statusOffline'); return lines; }
    if (status === 'failed') { add('status-warn', 'errLoadFailed'); return lines; }
    if (status === 'rateLimited') { add('status-warn', 'statusRateLimited'); return lines; }
    if (status === 'loading') {
      add('status-info', 'statusLoading');
    } else if (status === 'waiting') {
      waiting();
    }
    const ageH = (nowMs - fetched) / 3600000;
    if (ageH > fmt.staleHours || (st && st.tooOld === true)) { add('status-warn', 'statusStale'); }
    return lines;
  }

  // Die Formatierer für statusLines aus dem Stand der Seite: Sprache aus i18n, der Stand in der Ortszeit des Orts
  function statusFmt() {
    const f = i18n.fmt;
    const tz = state.model ? state.model.tz : (state.place ? state.place.tz : null);
    return {
      t,
      staleHours: heat.THRESH.staleHours,
      when: (ms, nowMs) => f.when(ms, nowMs, tz, i18n.lang),
      rel: (ms, nowMs) => f.rel(ms, nowMs, i18n.lang)
    };
  }

  let statusSig = '';

  // Schreibt die Zeile nur, wenn sich ein Satz geändert hat: Das Vorlesen der Live-Region soll nicht bei jedem
  // render() von vorn beginnen. Der alte Stand bleibt stehen, bis der neue Zustand da ist.
  function renderStatus() {
    const st = { status: state.status, waitS: state.waitS, tooOld: !!state.verdict && state.verdict.level === null };
    const lines = statusLines(st, state.cache, Date.now(), statusFmt());
    const sig = lines.map((l) => l.cls + '|' + l.text).join('\n');
    if (sig === statusSig) { return; }
    statusSig = sig;
    const box = $('status');
    box.replaceChildren();
    lines.forEach((l, i) => {
      if (i > 0) { box.appendChild(document.createTextNode(' ')); }
      box.appendChild(make('span', l.cls, l.text));
    });
  }

  // Wetter jetzt: frisch (höchstens FRESH_MS alt) der „current“-Block der Antwort, sonst die Prognose-Stunde, in
  // der „jetzt“ liegt; fehlt sie, bleibt der „current“-Block. Ohne beides gibt es keine Anzeige. Die Stunde wird über
  // den absoluten Zeitpunkt gewählt, nicht über die Ortsstunde: Am 25.10. gibt es 2 Uhr zweimal, und in Zonen mit
  // halben Stunden trifft die Wahl, ob die Stunden der Antwort auf volle Orts- oder volle UTC-Stunden fallen.
  // Rein: kein DOM, keine Gerätezeit.
  function currentOf(view) {
    const m = view.m;
    const nowMs = view.now.ms;
    const hour = m.hours.find((o) => o.ms <= nowMs && nowMs < o.ms + 3600000) || null;
    const fresh = !!m.current && isNum(m.fetched) && view.now.ms - m.fetched <= FRESH_MS;
    return (fresh || !hour) ? (m.current || hour) : hour;
  }

  function renderNow(view) {
    const cur = view ? currentOf(view) : null;
    $('nowBody').hidden = !cur;
    const rootStyle = document.documentElement.style;
    if (!cur) {
      rootStyle.removeProperty('--t');
      return;
    }
    const f = i18n.fmt;
    rootStyle.setProperty('--t', chart.tcol(cur.temp));
    $('nowTemp').textContent = f.deg(cur.temp, 0);
    setSvg($('nowIcon'), chart.icon(cur.code, cur.isDay, 34));
    $('nowCond').textContent = i18n.wmo(cur.code);
    setLine('nowFeels', isNum(cur.app) ? t('nowFeels', { t: f.deg(cur.app, 0) }) : '');
    setLine('nowWind', isNum(cur.wind) ? t('nowWind', { kmh: f.num(Math.round(cur.wind), 0) }) : '');
    setLine('nowHumidity', isNum(cur.rh) ? t('nowHumidity', { p: f.num(Math.round(cur.rh), 0) }) : '');
    const night = view.v.nights[0];
    setLine('nowNightMin', night ? t('nowNightMin', { t: f.deg(night.min, 1), time: f.time(night.atMs, view.m.tz) }) : '');
  }

  // Der Fahrplaneintrag, von dem Handlungssatz und Begründung handeln: der erste, dessen Nacht noch läuft
  // (Bürg index:395), sonst der erste
  function planPick(view) {
    const k = view.v.nights.findIndex((n) => n.toMs > view.now.ms);
    return view.v.plan[k >= 0 ? k : 0] || null;
  }

  // Zeitformatierer für whenPhrase, nightName und planWhen: Text und Sprache aus i18n, jede Uhrzeit, jeder Wochentag
  // und jeder Kalendertag in der Ortszeit des Orts (view.m.tz), nie in der des Geräts. Die drei Funktionen selbst
  // bekommen dieses Bündel als zt und sind damit rein (kein DOM, keine Module, keine Gerätezeit, in Node getestet).
  function timeFmt(view) {
    const f = i18n.fmt;
    const tz = view.m.tz;
    return {
      t,
      lang: i18n.lang,
      time: (ms) => f.time(ms, tz),
      wday: (ms) => f.wday(ms, tz, i18n.lang, true),
      dayKey: (ms) => weather.dayKeyOf(ms, tz)
    };
  }

  // Satzteil für levelTitle1–3: „jetzt“, „heute ab 15:00“ oder „Dienstag ab 15:00“
  function whenPhrase(view, entry, zt) {
    if (entry.startMs <= view.now.ms) { return zt.t('planNow'); }
    const time = zt.time(entry.startMs);
    if (zt.dayKey(entry.startMs) === view.now.key) { return zt.t('planToday', { time }); }
    return zt.t('planDay', { day: zt.wday(entry.startMs), time });
  }

  // Ein Nachtspeicher kennt weder Startzeit noch Aufheizzeit (heat.plan setzt startMs null und charge). Maßgeblich ist
  // die Heizart des Orts; ein Eintrag mit charge zählt auch dann, denn „Start ab –“ wäre in jedem Fall falsch.
  function isStorage(place, entry) {
    return !!(place && place.heat && place.heat.type === 'storage') || !!(entry && entry.charge);
  }

  // Handlungssatz und Begründung der Ampel als fertiger Text. Rein: kein DOM, keine Module, keine Gerätezeit.
  //   fmt.t(key, vars)   Text zum Schlüssel
  //   fmt.when(entry)    Satzteil für levelTitle1–3 („jetzt“, „heute ab 15:00“, „Dienstag ab 15:00“)
  //   fmt.time(ms)       Uhrzeit in der Ortszeit des Orts
  //   fmt.num(x)         Zahl mit höchstens einer Nachkommastelle
  // Stufe 0 gilt für jede Heizart gleich (levelTitle0, levelText0). Ab Stufe 1 steht beim Nachtspeicher
  // chargeTonight{level} statt levelTitle1–3, und levelText1–3 entfällt: Der Satz nennt „{lead} h
  // Aufheizzeit“, und der Nachtspeicher hat keine. Ab Stufe 1 ohne Fahrplaneintrag bleiben beide Zeilen leer (sie
  // werden verborgen, die Stufe steht in der <h2>); der Satz von Stufe 0 widerspräche der Überschrift.
  function verdictLines(level, entry, place, fmt) {
    if (level === 0) { return { action: fmt.t(TITLE_KEYS[0]), body: fmt.t(TEXT_KEYS[0]) }; }
    if (!entry) { return { action: '', body: '' }; }
    if (isStorage(place, entry)) {
      const action = entry.charge ? fmt.t('chargeTonight', { level: fmt.t(CHARGE_KEY[entry.charge]) }) : '';
      return { action, body: '' };
    }
    return {
      action: fmt.t(TITLE_KEYS[level], { when: fmt.when(entry) }),
      body: fmt.t(TEXT_KEYS[level], { onset: fmt.time(entry.onsetMs), lead: fmt.num(entry.lead) })
    };
  }

  // Die Formatierer für verdictLines aus dem Stand der Seite: Sprache aus i18n, Ortszeit des Orts
  function verdictFmt(view) {
    const f = i18n.fmt;
    const tz = view.m.tz;
    const zt = timeFmt(view);
    return {
      t,
      when: (entry) => whenPhrase(view, entry, zt),
      time: (ms) => f.time(ms, tz),
      num: numAuto
    };
  }

  function reasonText(r) {
    const f = i18n.fmt;
    switch (r.key) {
      case 'nightMin': return t('reasonNightMin', { t: f.deg(r.n, 1) });
      case 'drop48': return t('reasonDrop48', { k: numAuto(Math.abs(r.n)) });
      case 'coldWindy': return t('reasonColdWindy');
      case 'frost': return t('reasonFrost');
      case 'gtRise': return t('reasonGtRise', { kd: numAuto(r.n) });
      case 'alert': return t('reasonAlert');
      case 'calmNights': return t('reasonCalmNights', { t: f.deg(r.n, 0) });
      case 'noJumps': return t('reasonNoJumps');
      default: return '';
    }
  }

  // Ampel. Die Stufe steht immer als Text (Stufe, Zahl, Wort, Satz), die vier Lampen sind nur Zierde.
  // Die <h2> bleibt immer sichtbar, damit der Block auch ohne Stufe eine Überschrift hat (Sprung per Überschrift):
  // ohne Modell steht dort levelNoData, bei Daten älter als das Fenster (level null) errTooOld.
  function renderVerdict(view) {
    const sec = $('verdict');
    const v = view ? view.v : null;
    const shown = !!v && v.level !== null;
    for (const lamp of sec.querySelectorAll('.lamp i')) {
      lamp.classList.toggle('on', shown && lamp.classList.contains('l' + v.level));
    }
    if (!shown) {
      sec.style.removeProperty('--lv');
      setLine('verdictTitle', view ? t('errTooOld') : t('levelNoData'));
      for (const id of ['verdictAction', 'verdictText', 'verdictReasons']) { $(id).hidden = true; }
      return;
    }
    const entry = planPick(view);
    sec.style.setProperty('--lv', LEVEL_COLOR[v.level]);
    setLine('verdictTitle', t('levelOf', { n: v.level, name: t(LEVEL_KEYS[v.level]) }));
    const lines = verdictLines(v.level, entry, state.place, verdictFmt(view));
    setLine('verdictAction', lines.action);
    setLine('verdictText', lines.body);
    const list = $('verdictReasons');
    list.replaceChildren();
    for (const r of v.reasons) {
      const text = reasonText(r);
      if (text) { list.appendChild(make('li', '', text)); }
    }
    list.hidden = !list.firstChild;
  }

  // DWD-Text in der Sprache der Oberfläche: Deutsch aus den _de-Feldern, alle anderen aus den _en-Feldern
  // (Wortlaut, nie umformuliert, KT §6.3). Ein Feld zählt nur, wenn es ein nicht-leerer Text ist.
  function alertText(a, name) {
    const v = a[name + (i18n.lang === 'de' ? '_de' : '_en')];
    return typeof v === 'string' && v.trim() !== '' ? v : '';
  }

  // „von heute 21:00 bis morgen 11:00“; ohne Beginn keine Zeile, ohne Ende kein „bis“ (expires ist oft null)
  function alertTime(a, view) {
    const f = i18n.fmt;
    const from = typeof a.onset === 'string' ? Date.parse(a.onset) : NaN;
    if (!Number.isFinite(from)) { return ''; }
    const parts = [t('alertFrom', { when: f.when(from, view.now.ms, view.m.tz, i18n.lang) })];
    const until = typeof a.expires === 'string' ? Date.parse(a.expires) : NaN;
    if (Number.isFinite(until)) { parts.push(t('alertUntil', { when: f.when(until, view.now.ms, view.m.tz, i18n.lang) })); }
    return parts.join(' ');
  }

  function alertItem(a, view) {
    const item = make('article', 'alert-item');
    const head = alertText(a, 'headline') || alertText(a, 'event');
    if (head) { item.appendChild(make('h3', '', head)); }
    const when = alertTime(a, view);
    if (when) { item.appendChild(make('p', 'alert-time', when)); }
    for (const name of ['description', 'instruction']) {
      const text = alertText(a, name);
      if (text) { item.appendChild(make('p', 'alert-text', text)); }
    }
    return item;
  }

  // Warnungen: nur in Deutschland oder wenn die Abfrage Warnungen geliefert hat; es zählen die noch gültigen.
  // Ohne Warnung und ohne Abruffehler bleibt der Block weg.
  function renderAlerts(view) {
    const place = state.place;
    const status = state.cache ? state.cache.alertsStatus : null;
    const eligible = !!view && !!place && (place.cc === 'DE' || status === 'ok');
    const list = eligible ? heat.activeAlerts(view.m.alerts, view.now.ms) : [];
    const failed = eligible && place.cc === 'DE' && status === 'error';
    const box = $('alertList');
    box.replaceChildren();
    for (const a of list) {
      const item = alertItem(a, view);
      if (item.firstChild) { box.appendChild(item); }
    }
    const any = !!box.firstChild;
    $('alerts').hidden = !(any || failed);
    $('alertLang').hidden = !any || i18n.lang === 'de';
    $('alertSource').hidden = !any;
    $('alertUnavailable').hidden = !failed;
  }

  // Eine Stunde mitten am Tag (12 Uhr, sonst die erste) als Zeitpunkt für Wochentag und Datum der Tageskarte
  function dayMs(view, day) {
    let first = null;
    for (const o of view.m.hours) {
      if (o.dayIdx !== day.idx) { continue; }
      if (o.h === 12) { return o.ms; }
      if (first === null) { first = o.ms; }
    }
    return first;
  }

  // Vergleich mit dem Vortag als Satz, nie als Farbe allein: ab einem Grad Unterschied kälter oder wärmer
  function compareText(day, ref) {
    if (!ref || day.partial || ref.partial) { return ''; }
    const dm = day.mean - ref.mean;
    if (dm <= -1) { return t('dayColder', { k: numAuto(-dm) }); }
    if (dm >= 1) { return t('dayWarmer', { k: numAuto(dm) }); }
    return t('daySame');
  }

  function dayCard(view, day, i, ref) {
    const f = i18n.fmt;
    const tz = view.m.tz;
    const lang = i18n.lang;
    const ms = dayMs(view, day);
    const card = make('article', 'day');
    const name = i === 0 ? t('dayToday') : (i === 1 ? t('dayTomorrow') : f.wday(ms, tz, lang, true));
    card.appendChild(make('h3', '', name));
    card.appendChild(make('p', 'day-date', i < 2 ? f.wday(ms, tz, lang, true) + ' ' + f.date(ms, tz, lang) : f.date(ms, tz, lang)));
    if (isNum(day.code)) {
      const cond = make('p', 'day-cond');
      const ic = make('span', 'icon');
      setSvg(ic, chart.icon(day.code, true, 32));
      cond.appendChild(ic);
      cond.appendChild(make('span', '', i18n.wmo(day.code)));
      card.appendChild(cond);
    }
    // Die Zahlen der Spanne tragen die Temperaturfarbe; der Satz daneben sagt dasselbe in Worten
    if (isNum(day.min)) {
      const p = make('p', 'day-range', t('dayMin', { t: f.deg(day.min, 0) }));
      p.style.color = chart.tcol(day.min);
      card.appendChild(p);
    }
    if (isNum(day.max)) {
      const p = make('p', 'day-range', t('dayMax', { t: f.deg(day.max, 0) }));
      p.style.color = chart.tcol(day.max);
      card.appendChild(p);
    }
    if (isNum(day.rain) && day.rain >= 0.2) { card.appendChild(make('p', '', t('dayRain', { mm: f.num(day.rain, 1) }))); }
    if (isNum(day.sun)) { card.appendChild(make('p', '', t('daySun', { h: f.num(day.sun, 1) }))); }
    const cmp = compareText(day, ref);
    if (cmp) { card.appendChild(make('p', 'day-note', cmp)); }
    return card;
  }

  // Heute und die zwei folgenden Tage. Die Tage kommen aus dem Modell, nicht aus der Ampel: Sie bleiben auch dann,
  // wenn die Ampel wegen fehlender Nächte „zu alt“ sagt. Liegt heute gar nicht im Modell, entfällt der Block.
  function renderDays(view) {
    const list = $('dayList');
    list.replaceChildren();
    const days = view && view.todayIdx >= 0 ? view.m.days.slice(view.todayIdx, view.todayIdx + 3) : [];
    $('days').hidden = !days.length;
    days.forEach((day, i) => {
      const ref = i === 0 ? view.m.days[view.todayIdx - 1] : days[i - 1];
      list.appendChild(dayCard(view, day, i, ref));
    });
  }

  // Heizfahrplan (Abschnitt 8, Block 7): je Nacht eine Karte. Die Einträge kommen aus view.v.plan, denselben, aus
  // denen der Handlungssatz der Ampel seinen ersten laufenden Eintrag nimmt (planPick); heat.plan() rechnet mit
  // den Aufheizzeiten aus place.heat. Alle Zeiten sind Ortszeit des Orts (view.m.tz), nie die des Geräts.

  // Erster Buchstabe groß: planNow, planToday und planDay sind Satzteile („jetzt“), hier stehen sie am Zeilenanfang
  function upFirst(text, lang) {
    const chars = Array.from(text);
    return chars.length ? chars[0].toLocaleUpperCase(lang) + chars.slice(1).join('') : text;
  }

  // Zweite Meinung (MOSMIX) zählt nur, wenn die Station nah genug liegt (Abschnitt 8, MOSMIX-Regel)
  function mosNear(model) {
    const s = model.mosStation;
    return !!s && isNum(s.distance) && s.distance <= MOS_NEAR_M;
  }

  // Überschrift: „Heizfahrplan: Heizkörper“; der Nachtspeicher plant keinen Start, er lädt auf. Eine unbekannte
  // Heizart bekommt den Namen ohne Zusatz.
  function planHeading(place) {
    const type = place.heat && place.heat.type;
    if (type === 'storage') { return t('planTitleStorage'); }
    return PROFILE_KEY[type] ? t('planFor', { profile: t(PROFILE_KEY[type]) }) : t('planTitle');
  }

  // „Heute Nacht“, „Morgen Nacht“, danach der Wochentag („Mittwoch Nacht“). Die Nacht gehört zum Abend ihres Tags.
  // Rein, zt aus timeFmt(view).
  function nightName(view, night, zt) {
    const off = night.dayIdx - view.todayIdx;
    let day;
    if (off === 0) {
      day = zt.t('dayToday');
    } else if (off === 1) {
      day = zt.t('dayTomorrow');
    } else {
      const own = view.m.days[night.dayIdx];
      day = own ? zt.wday(dayMs(view, own)) : '';
    }
    return zt.t('planNightOf', { day });
  }

  // Zeile mit dem Start: „Jetzt“, wenn er fällig ist; sonst „Start ab 15:00“. Nur wenn der Start nicht auf den Tag
  // der Nacht fällt (lange Aufheizzeit, früher Beginn der Abkühlung), steht der Tag davor: „Heute ab 22:00“ oder
  // „Montag ab 22:00“. Rein, zt aus timeFmt(view).
  function planWhen(view, entry, night, due, zt) {
    if (due) { return upFirst(zt.t('planNow'), zt.lang); }
    const time = zt.time(entry.startMs);
    const startKey = zt.dayKey(entry.startMs);
    const own = view.m.days[night.dayIdx];
    if (own && startKey === own.key) { return zt.t('planStart', { time }); }
    if (startKey === view.now.key) { return upFirst(zt.t('planToday', { time }), zt.lang); }
    return upFirst(zt.t('planDay', { day: zt.wday(entry.startMs), time }), zt.lang);
  }

  // Die Zeilen des Fahrplans als fertiger Text, je Nacht eine Karte: [{ head, lines: [{ cls, text }] }].
  // Rein: kein DOM, keine Module, keine Gerätezeit. Aus verdict kommen plan und nights (heat.assess), aus place
  // die Heizart; alles, was von Sprache und Ortszeit abhängt, bringt fmt mit:
  //   fmt.t(key, vars)                 Text zum Schlüssel
  //   fmt.time(ms)                     Uhrzeit in der Ortszeit des Orts
  //   fmt.deg(x, digits)               Grad mit „°“
  //   fmt.num(x)                       Zahl mit höchstens einer Nachkommastelle (Aufheizzeit)
  //   fmt.todayIdx                     Index des heutigen Tages im Modell (verdict.nights[k].dayIdx ist derselbe Index)
  //   fmt.mosNear                      liegt die MOSMIX-Station nah genug, damit die zweite Meinung zählt
  //   fmt.nightName(night)             „Heute Nacht“, „Morgen Nacht“, „Mittwoch Nacht“
  //   fmt.isDue(entry, night)          ist der Start fällig (heat.isDue)
  //   fmt.startLine(entry, night, due) Zeile mit dem Start: „Jetzt“, „Start ab 15:00“, „Montag ab 22:00“
  // Nachtspeicher: statt des Starts steht je Abend die Aufladung (chargeTonight für heute, planChargeEvening für die
  // folgenden), und es gibt weder eine Startzeile noch die Hinweise „fällig“, „optional“ und „Böen“, weder Heizstufe
  // noch Aufheizzeit. Tiefstwert und, wenn nah genug und uneinig, die zweite Meinung gelten für jede Heizart.
  function planRows(verdict, place, fmt) {
    const rows = [];
    if (!verdict || !Array.isArray(verdict.plan) || !Array.isArray(verdict.nights)) { return rows; }
    verdict.plan.forEach((entry, k) => {
      const night = verdict.nights[k];
      if (!entry || !night) { return; }
      const storage = isStorage(place, entry);
      const lines = [];
      if (storage) {
        if (entry.charge) {
          const level = fmt.t(CHARGE_KEY[entry.charge]);
          lines.push({
            cls: 'plan-when',
            text: night.dayIdx === fmt.todayIdx ? fmt.t('chargeTonight', { level }) : fmt.t('planChargeEvening', { level })
          });
        }
      } else {
        const due = fmt.isDue(entry, night);
        lines.push({ cls: 'plan-when', text: fmt.startLine(entry, night, due) });
        const tag = entry.optional ? fmt.t('planOptional') : (due ? fmt.t('planDue') : '');
        if (tag) { lines.push({ cls: 'plan-tag', text: tag }); }
        lines.push({ cls: 'plan-strength', text: fmt.t(STRENGTH_KEY[entry.strength]) });
      }
      lines.push({ cls: 'plan-meta', text: fmt.t('planNightMin', { t: fmt.deg(night.min, 1), time: fmt.time(night.atMs) }) });
      if (!storage) {
        lines.push({ cls: 'plan-meta', text: fmt.t('planLead', { onset: fmt.time(entry.onsetMs), lead: fmt.num(entry.lead) }) });
        if (entry.gusty) { lines.push({ cls: 'plan-note', text: fmt.t('planGusty') }); }
      }
      // Richtungsneutral: Die Bedingung löst in beide Richtungen aus, und die zweite Meinung ist kein Fehler
      if (entry.disagree && fmt.mosNear && isNum(night.mosMin)) {
        lines.push({ cls: 'plan-note', text: fmt.t('planDisagree', { t: fmt.deg(night.mosMin, 1) }) });
      }
      rows.push({ head: fmt.nightName(night), lines });
    });
    return rows;
  }

  // Die Formatierer für planRows aus dem Stand der Seite: Sprache aus i18n, Ortszeit des Orts (view.m.tz)
  function planFmt(view) {
    const f = i18n.fmt;
    const tz = view.m.tz;
    const zt = timeFmt(view);
    return {
      t,
      time: (ms) => f.time(ms, tz),
      deg: (x, digits) => f.deg(x, digits),
      num: numAuto,
      todayIdx: view.todayIdx,
      mosNear: mosNear(view.m),
      nightName: (night) => nightName(view, night, zt),
      isDue: (entry, night) => heat.isDue(entry, view.now.ms, night.toMs),
      startLine: (entry, night, due) => planWhen(view, entry, night, due, zt)
    };
  }

  // Eine Karte: Überschrift der Nacht und ihre Zeilen, alles per textContent
  function planItem(row) {
    const li = make('li', 'plan-item');
    li.appendChild(make('h3', '', row.head));
    for (const line of row.lines) { li.appendChild(make('p', line.cls, line.text)); }
    return li;
  }

  function renderPlan(view) {
    const list = $('planList');
    list.replaceChildren();
    const rows = view ? planRows(view.v, state.place, planFmt(view)) : [];
    for (const row of rows) { list.appendChild(planItem(row)); }
    $('plan').hidden = !list.firstChild;
    $('planHead').textContent = list.firstChild ? planHeading(state.place) : '';
  }

  // Zeichnet den Hauptbildschirm neu, Block für Block; scheitert einer, laufen die übrigen weiter
  function render() {
    if (!state.place) { return; }
    guard(renderHead);
    const view = guard(buildView);
    state.verdict = view ? view.v : null;
    guard(renderStatus);
    guard(() => renderNow(view));
    guard(() => renderVerdict(view));
    guard(() => renderAlerts(view));
    guard(() => renderDays(view));
    guard(() => renderPlan(view));
  }

  function onSettingsOpen() {
    state.setup = null;
    showScreen('s-settings');
  }

  // „Zurück“ aus den Einstellungen: der Fokus kehrt auf den Knopf zurück, der sie geöffnet hat
  function onSettingsBack() {
    showMain();
    $('settingsBtn').focus();
  }

  // opts.focusNow: Fokus auf section#now h2, nur nach der Einrichtung, nie beim normalen App-Start
  function showMain(opts) {
    const o = opts || {};
    state.setup = null;
    state.place = placeById(state.activeId) || state.places[0] || null;
    if (!state.place) {
      showSetup({ focus: o.focusNow });
      return;
    }
    state.activeId = state.place.id;
    render();
    showScreen('s-main', { focus: !!o.focusNow });
  }

  // Die Heizart eines schon gespeicherten Orts nachtragen: S5 ohne Zähler, „Fertig“ führt zurück
  function onHeatChange() {
    const place = state.place;
    if (!place) { return; }
    state.setup = newSetup(false);
    state.setup.reentry = true;
    state.setup.placeId = place.id;
    goProfile();
  }

  // ---------------------------------------------------------------------------------------------
  // Sprache, Handler, Start
  // ---------------------------------------------------------------------------------------------

  // Dynamisch gebauter Text zieht bei jedem Sprachwechsel nach
  function onLanguage() {
    if (state.screen === null) { return; }
    renderStep();
    if (state.screen === 's-hits') { renderHits(); }
    if (state.screen === 's-confirm') { renderConfirm(); }
    if (state.screen === 's-main') { render(); }
  }

  function on(id, type, fn) {
    $(id).addEventListener(type, fn);
  }

  // Enter in Straße und PLZ springt zum nächsten Feld (enterkeyhint „next“), erst Enter im Ortsfeld sucht
  function nextOnEnter(fromId, toId) {
    on(fromId, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        $(toId).focus();
      }
    });
  }

  function bindEvents() {
    on('btnByAddress', 'click', onByAddress);
    on('btnByLocation', 'click', onByLocation);
    on('btnWelcomeRetry', 'click', onByLocation);
    on('btnWelcomeNext', 'click', onByAddress);

    on('btnAddrBack', 'click', onAddrBack);
    on('addrForm', 'submit', (e) => { e.preventDefault(); onSearch(); });
    nextOnEnter('f-street', 'f-zip');
    nextOnEnter('f-zip', 'f-city');
    on('btnCityOnly', 'click', onCityOnly);
    on('btnAddrRetry', 'click', onSearch);
    on('btnAddrLocation', 'click', onByLocation);
    on('f-zip', 'input', () => setInvalid(['f-zip', 'f-city'], false));
    on('f-city', 'input', () => setInvalid(['f-zip', 'f-city'], false));

    on('btnHitsBack', 'click', onHitsBack);
    on('btnNoneFits', 'click', onHitsBack);
    on('hitList', 'click', onHitClick);

    on('btnElevChange', 'click', () => openElevEdit($('elevEdit').hidden));
    on('f-elev', 'input', () => {
      if (state.setup) { state.setup.elevTyped = true; }
      setInvalid(['f-elev'], false);
      renderElevation();
    });
    on('btnConfirmYes', 'click', onConfirmYes);
    on('btnConfirmNo', 'click', onConfirmNo);

    on('btnDone', 'click', () => finishProfile(true));
    on('btnDontKnow', 'click', () => finishProfile(false));
    on('btnHeatChange', 'click', onHeatChange);

    // „Neu laden“ ruft immer ab und hängt sich an einen laufenden Abruf an (refresh(true))
    on('reload', 'click', () => { refresh(true); });
    on('settingsBtn', 'click', onSettingsOpen);
    on('btnSettingsBack', 'click', onSettingsBack);
    on('placeSelect', 'change', onPlaceChange);
  }

  // Service Worker nur über https oder auf localhost (dort sieht ihn auch der Offline-Smoke-Test).
  // Ein Fehler beim Registrieren stört die App nicht, er steht in der Konsole.
  function registerWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) { return; }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') { return; }
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }

  function init() {
    const H = root.Heizwarte || {};
    storage = H.storage;
    i18n = H.i18n;
    geo = H.geo;
    heat = H.heat;
    weather = H.weather;
    chart = H.chart;
    if (!storage || !i18n || !geo || !heat || !weather || !chart) {
      console.error('Heizwarte: ein Modul fehlt (storage, i18n, geo, weather, heat oder chart)');
      return;
    }

    storage.migrate();
    i18n.apply(i18n.detect());
    state.newer = storage.get('v', 2) > 2;
    loadPlaces();
    loadCache();
    bindEvents();
    i18n.onApply(onLanguage);
    $('btnByLocation').hidden = !hasGeolocation();
    updateNotes();

    // Ohne Ort beginnt die Einrichtung bei S1, sonst der Hauptbildschirm. Der Fokus bleibt, wo er ist:
    // Er springt beim Start nicht von selbst auf eine Überschrift. showMain zeigt zuerst den Cache,
    // refresh() holt danach frische Daten (mit dem Flatterschutz kein Doppelabruf).
    if (state.places.length === 0) {
      showSetup({ focus: false });
    } else {
      showMain();
      refresh(false);
    }
    document.addEventListener('visibilitychange', onVisible);
    registerWorker();
    // Es folgen: Einstellungen, Größenänderung der Kurve (spätere Schritte)
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Nur für Node-Tests (tests/app.test.js): die reinen Funktionen von Ampel, Fahrplan, Statuszeile, Jetzt-Block,
  // Umriss und Hausnummer sowie die Zeitlogik des Fahrplans (whenPhrase, nightName, planWhen mit zt). Im Browser gibt
  // es kein module, app.js bleibt dort ohne Export und ohne Eintrag in Heizwarte.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { verdictLines, planRows, statusLines, currentOf, extentLine, extractNumber, whenPhrase, nightName, planWhen };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
