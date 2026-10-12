/*
 * Heizwarte — Zustand, Einrichtung, Rendern und Abruf. Als einzige Datei darf app.js beim Laden etwas tun.
 *
 * Stand dieses Schritts: die Einrichtung S1 bis S5 (BAUPLAN Abschnitt 6) und ein leeres Hauptbildschirm-Gerüst.
 * Abruf, Wetterblöcke, Einstellungen und Service Worker kommen in den nächsten Schritten dazu.
 *
 * Aller Text der Oberfläche steht in i18n.js und kommt hier nur über t() in die Seite. Was ein Dienst liefert
 * (Photon-Beschriftungen), geht ausschließlich per textContent hinein, nie über innerHTML.
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

  const state = {
    places: [],
    activeId: null,
    place: null,
    cache: null,
    model: null,
    verdict: null,
    source: 'none',
    loading: false,
    lastFetchMs: 0,
    waitUntilMs: 0,
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

  // Hausnummer aus dem Straßenfeld: erst am Ende („Marktstraße 1 a“), sonst am Anfang („10 Downing Street“)
  function extractNumber(street) {
    const s = String(street || '').trim();
    const end = /(\d+\s?[A-Za-z]?)$/.exec(s);
    if (end) { return end[1]; }
    const start = /^(\d+\s?[A-Za-z]?)(?=\s|$)/.exec(s);
    return start ? start[1] : '';
  }

  // ---------------------------------------------------------------------------------------------
  // Speicher
  // ---------------------------------------------------------------------------------------------

  // Schreibt nie, wenn die Daten von einer neueren Fassung stammen (Abschnitt 4, Migration Punkt 4)
  function persist(key, value) {
    if (state.newer) { return false; }
    return storage.set(key, value);
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

  function onByAddress() {
    const s = state.setup;
    if (!s || s.busy) { return; }
    s.way = 'address';
    goAddress();
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
    const btn = $(where === 'address' ? 'btnAddrLocation' : 'btnByLocation');
    clearError(where);
    markBusy(btn, true, 'setupSearching');

    let hit = null;
    let failure = null;
    try {
      const pos = await geo.locate(navigator.geolocation);
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
    markBusy(btn, false, 'setupByLocation');
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

  // Umriss als „22 × 28 m“ bzw. „2,1 × 1,4 km“: {w} die Zahl, {h} die Zahl mit Einheit. Nichts bei Punkten ohne Umriss.
  function extentText(hit) {
    const size = geo.extentSize(hit.extent, hit.lat);
    if (!size) { return ''; }
    const f = i18n.fmt;
    const big = Math.max(size.w, size.h);
    if (big < 1) { return ''; }
    if (big >= 1000) {
      return t('setupExtent', { w: f.num(size.w / 1000, 1), h: f.num(size.h / 1000, 1) + ' km' });
    }
    return t('setupExtent', { w: f.num(Math.max(1, Math.round(size.w)), 0), h: f.num(Math.max(1, Math.round(size.h)), 0) + ' m' });
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
    s.placeId = place.id;

    s.busy = false;
    markBusy($('btnConfirmYes'), false, 'setupConfirmYes');
    // Adresse und ungerundete Treffer werden nicht aufgehoben (B:63): nach dem Speichern bleibt nur der Ort
    clearAddressFields();
    s.fields = { street: '', zip: '', city: '' };
    s.hits = [];
    s.chosen = null;
    updateNotes();
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

  // Heizart setzen: Aufheizzeiten kommen aus der Tabelle der Heizart, Raumtemperatur und Schwellen bleiben
  function applyHeatType(place, type, confirmed) {
    const p = heat.PROFILES[type] || heat.PROFILES.radiator;
    place.heat.type = type;
    place.heat.leadMin = p.leadMin;
    place.heat.leadMax = p.leadMax;
    place.heat.confirmed = confirmed;
  }

  // „Fertig“ bestätigt die Wahl; „Weiß ich nicht“ lässt es beim Heizkörper und bei confirmed false
  function finishProfile(known) {
    const s = state.setup;
    const place = s && placeById(s.placeId);
    if (!place) { return; }
    applyHeatType(place, known ? selectedType() : 'radiator', known);
    persist('places', state.places);
    updateNotes();
    // Der Abruf (refresh(true)) startet hier, sobald er gebaut ist
    showMain({ focusNow: true });
  }

  // ---------------------------------------------------------------------------------------------
  // Hauptbildschirm (Gerüst)
  // ---------------------------------------------------------------------------------------------

  function renderMain() {
    const place = state.place;
    $('placeName').textContent = place ? place.label : '';
    $('heatHint').hidden = !(place && place.heat.confirmed === false);
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
    renderMain();
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
    if (state.screen === 's-main') { renderMain(); }
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
  }

  function init() {
    const H = root.Heizwarte || {};
    storage = H.storage;
    i18n = H.i18n;
    geo = H.geo;
    heat = H.heat;
    if (!storage || !i18n || !geo || !heat) {
      console.error('Heizwarte: ein Modul fehlt (storage, i18n, geo oder heat)');
      return;
    }

    storage.migrate();
    i18n.apply(i18n.detect());
    state.newer = storage.get('v', 2) > 2;
    loadPlaces();
    bindEvents();
    i18n.onApply(onLanguage);
    $('btnByLocation').hidden = !hasGeolocation();
    updateNotes();

    // Ohne Ort beginnt die Einrichtung bei S1, sonst der Hauptbildschirm. Der Fokus bleibt, wo er ist:
    // Er springt beim Start nicht von selbst auf eine Überschrift.
    if (state.places.length === 0) {
      showSetup({ focus: false });
    } else {
      showMain();
    }
    // Es folgen: aus dem Cache rendern, refresh(), visibilitychange, Service Worker (spätere Schritte)
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
