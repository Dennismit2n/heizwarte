/*
 * Heizwarte — Sprachtabelle, Spracherkennung, t() und Intl-Hilfen für Uhrzeit, Datum und Zahlen
 *
 * Bis Meilenstein 4 gibt es nur den Block de; die 13 übrigen Sprachen kommen mit dem Commit
 * „Füge dreizehn Übersetzungen hinzu“. Jeder sichtbare Text der App steht hier unter einem
 * Schlüssel (camelCase, Platzhalter als {name}); kein anderes Skript baut ein Wort fest ein.
 *
 * Läuft ohne DOM (require in Node): apply() kehrt ohne document sofort zurück, t() und fmt.*
 * brauchen keins. Den Sprachstand hw:lang liest und schreibt allein Heizwarte.storage. Die
 * Zeit-Helfer rechnen nie mit der Gerätezeit: Ortszeit entsteht nur über Intl mit timeZone
 * (BAUPLAN Abschnitt 5 i18n, KT §8).
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Abhängigkeiten ERST IM FUNKTIONSKÖRPER holen (root.Heizwarte.storage), nie oben in eine Konstante kopieren

  // Reihenfolge wie auf der Startseite
  const LANGS = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'tr', 'ru', 'hi', 'zh', 'ja', 'ko'];

  // Die Platzhalter je Schlüssel stehen in der Schlüsseltabelle des Plans. Wo eine Zahl mit Einheit gemeint
  // ist, sagt der Kommentar, wer die Einheit liefert: {t} kommt fertig mit „°“ aus fmt.deg, {w} und {h}
  // fertig mit Einheit aus der App.
  const I18N = {
    de: {
      _name: 'Deutsch',

      // --- App, Knöpfe ---
      appName: 'Heizwarte',
      appClaim: 'Wann musst du die Heizung hochstellen?',
      placeLabel: 'Ort',
      btnReload: 'Neu laden',
      btnReloading: 'Lädt …',
      btnMore: 'Mehr anzeigen',
      btnLess: 'Weniger anzeigen',
      btnSettings: 'Einstellungen',
      btnBack: 'Zurück',
      btnNext: 'Weiter',
      btnDone: 'Fertig',
      btnRetry: 'Noch einmal versuchen',
      btnChange: 'Ändern',
      btnUse: 'Übernehmen',
      btnDelete: 'Löschen',
      btnAddPlace: 'Ort hinzufügen',
      btnCancel: 'Abbrechen',
      btnCityOnly: 'Nur den Ort suchen',

      // --- Status (nur statusStamp und statusWaiting tragen Platzhalter) ---
      statusLoading: 'Wird aktualisiert …',
      statusStamp: 'Stand: {when} ({ago}).',
      statusStale: '⚠ Veraltet – älter als einen Tag.',
      statusOffline: '⚠ Veraltet – gerade keine Verbindung. Sobald du wieder Netz hast, tippe auf Neu laden.',
      statusNoData: 'Noch keine Wetterdaten. Tippe auf Neu laden.',
      statusWaiting: 'Der Wetterdienst ist gerade ausgelastet. Heizwarte versucht es in {s} Sekunden noch einmal.',
      statusRateLimited: '⚠ Veraltet – der Wetterdienst ist ausgelastet. Versuch es in ein paar Minuten mit Neu laden.',
      storageBlocked: 'Speichern klappt nicht – die Einrichtung gilt nur für diese Sitzung.',
      storageFull: 'Speichern klappt nicht – der Speicher ist voll. Die Einrichtung gilt nur für diese Sitzung.',
      storeNewer: 'Diese Daten stammen von einer neueren Heizwarte-Version. Heizwarte lässt sie unverändert.',

      // --- Einrichtung ---
      setupIntro: 'Heizwarte sagt dir, wann du heizen musst. Dafür braucht sie deine Adresse.',
      setupPrivacy: 'Die Adresse wird nur einmal zum Suchen des Ortes gesendet. Danach bleibt sie auf deinem Handy. Nimmst du deinen Standort, geht stattdessen einmal dein auf etwa 100 m gerundeter Standort an die Ortssuche.',
      setupByAddress: 'Adresse eintippen',
      setupByLocation: 'Meinen Standort verwenden',
      setupStep: 'Schritt {n} von {of}',
      setupAddressTitle: 'Wo wohnst du?',
      setupStreet: 'Straße und Hausnummer',
      setupStreetHint: 'Ohne Straße nimmt Heizwarte die Ortsmitte.',
      setupZip: 'Postleitzahl',
      setupCity: 'Ort',
      setupSearch: 'Suchen',
      setupSearching: 'Suche läuft …',
      setupHitsTitle: 'Welche Adresse ist deine?',
      setupHitsHint: 'Tippe auf die passende Adresse.',
      setupNoNumber: 'Die Hausnummer kennt die Karte nicht. Heizwarte nimmt die Straßenmitte. Das reicht für das Wetter.',
      setupNoneFits: 'Keine passt? Adresse ändern',
      setupConfirmTitle: 'Stimmt das?',
      setupConfirmQuestion: 'Ist das deine Adresse?',
      setupConfirmYes: 'Ja, das stimmt',
      setupConfirmNo: 'Nein, zurück',
      setupRegion: 'Das liegt in: {region}.',
      // {w} und {h} sind nur Zahlen, die Einheit steht im Text: setupExtent in Metern („22 × 28 m“ bei einem Haus),
      // setupExtentKm in Kilometern („2,1 × 1,4 km“ bei einem Ortsteil; nur wenn beide Maße mindestens 1 km sind)
      setupExtent: 'Umriss etwa {w} × {h} m',
      setupExtentKm: 'Umriss etwa {w} × {h} km',
      setupCoords: '{lat} / {lon} · auf etwa 100 m gerundet',
      setupElev: 'Höhe: {m} m',
      setupElevAuto: 'automatisch ermittelt',
      setupElevLoading: 'Höhe: wird ermittelt …',
      setupElevUnknown: 'Höhe: unbekannt. Du kannst sie eintragen oder weitergehen.',
      setupElevHint: 'Die Höhe beeinflusst die Temperatur. Wenn du sie nicht weißt, lass sie so.',
      setupElevLabel: 'Höhe in Metern',
      setupLabel: 'Name für diesen Ort',
      setupMyPlace: 'Dein Standort',
      setupGeoWrong: 'Der Standort hat nicht gepasst. Tipp die Adresse ein.',
      setupHeatTitle: 'Wie heizt du?',
      setupHeatHint: 'Wähle, was am ehesten passt. Du kannst das später ändern.',
      setupHeatDontKnow: 'Weiß ich nicht',
      setupHeatDefaultHint: 'Heizart: Heizkörper (Annahme). Du kannst sie hier ändern.',
      hitHouse: 'Haus',
      hitStreet: 'Straße',
      hitPlace: 'Ort',
      hitPoi: 'Einrichtung',

      // --- Fehler (jeder endet in einem Knopf, Abschnitt 6) ---
      errNeedPlace: 'Heizwarte braucht Ort oder Postleitzahl, um die Straße zu finden.',
      errNoHit: 'Zu dieser Adresse hat Heizwarte nichts gefunden.',
      errNoHitTip1: 'Prüfe Postleitzahl und Ort.',
      errNoHitTip2: 'Oder suche nur den Ort.',
      errOfflineSearch: 'Gerade geht keine Verbindung. Prüfe WLAN oder Mobilfunk.',
      errSearchRejected: 'Die Ortssuche ist gerade ausgelastet. Bitte in einer Minute noch einmal.',
      errGeoDenied: 'Dein Handy hat den Standort nicht freigegeben. Du kannst die Adresse auch eintippen.',
      errGeoFailed: 'Der Standort kam nicht an.',
      errElev: 'Die Höhe konnte nicht ermittelt werden. Du kannst sie selbst eintragen.',
      errElevRange: 'Die Höhe passt nicht. Trage eine Zahl von −500 bis 9000 Metern ein oder lass das Feld leer.',
      errMaxPlaces: 'Fünf Orte sind das Maximum. Lösche erst einen Ort.',
      errTooOld: 'Die Wetterdaten sind zu alt für eine Empfehlung. Tippe auf Neu laden.',
      errLoadFailed: '⚠ Veraltet – der Wetterdienst hat nicht geantwortet. Tippe auf Neu laden.',

      // --- Heizarten (Abschnitt 7) ---
      profileRadiator: 'Heizkörper',
      profileFloorScreed: 'Fußbodenheizung im Estrich',
      profileFloorDry: 'Fußbodenheizung trocken/dünn',
      profileHeatpumpFloor: 'Wärmepumpe mit Fußbodenheizung',
      profileStorage: 'Nachtspeicher',
      profileHintRadiator: 'Heizkörper an der Wand. Wird in einer halben bis zwei Stunden warm.',
      profileHintFloorScreed: 'Fußboden, meist Fliesen, altes Haus. Braucht 3 bis 6 Stunden. Fußbodenheizung, aber unsicher welche? Nimm diese.',
      profileHintFloorDry: 'Fußboden mit dünnem Aufbau oder Trockenbau. 1 bis 3 Stunden.',
      profileHintHeatpumpFloor: 'Wärmepumpe mit Fußbodenheizung. 4 bis 8 Stunden.',
      profileHintStorage: 'Nachtspeicheröfen. Heizwarte sagt dir abends, ob du mehr aufladen sollst.',
      profileRule: 'Faustregel – stell die Zeiten nach deiner Wohnung ein',

      // --- Ampel (level* und plan* sagen nie „Fliesen“ oder „Fußboden“: die Stufentexte gelten für jede Heizart) ---
      level0: 'Ruhig',
      level1: 'Vorwarnung',
      level2: 'Heiz-Alarm',
      level3: 'Frost / Sturm',
      levelOf: 'Stufe {n} von 3: {name}',
      levelTitle0: 'Heizung im Normalbetrieb lassen.',
      // {when} ist ein Satzteil aus planNow, planToday oder planDay
      levelTitle1: 'Heizung {when} höher stellen.',
      levelTitle2: 'Heizung {when} deutlich hochdrehen.',
      levelTitle3: 'Heizung {when} durchlaufen lassen.',
      levelText0: 'Keine großen Temperatursprünge in Sicht. Deine Wohnung bleibt warm, ohne früher zu heizen.',
      // {lead} mit „h“ wie in planLead: „Stunden“ hieße bei einer Aufheizzeit von 1 „Bei 1 Stunden“
      levelText1: 'Abkühlung setzt gegen {onset} ein. Bei {lead} h Aufheizzeit musst du vorher starten.',
      levelText2: 'Abkühlung setzt gegen {onset} ein. Bei {lead} h Aufheizzeit musst du vorher starten.',
      levelText3: 'Abkühlung setzt gegen {onset} ein. Bei {lead} h Aufheizzeit musst du vorher starten.',
      levelNoData: 'Keine Empfehlung möglich – es fehlen aktuelle Wetterdaten.',
      reasonNightMin: 'Die Nacht wird kalt: bis {t}.',
      // {k} ist der Betrag ohne Vorzeichen
      reasonDrop48: 'Das Tagesmittel sinkt innerhalb von 48 Stunden um {k} Grad.',
      reasonColdWindy: 'Es ist kalt, windig und kaum sonnig.',
      reasonFrost: 'Die Nacht bringt Frost.',
      reasonGtRise: 'Der Heizbedarf steigt deutlich (plus {kd} Kd).',
      reasonAlert: 'Eine Warnung des Deutschen Wetterdienstes ist aktiv.',
      reasonCalmNights: 'Die Nächte bleiben über {t}.',
      reasonNoJumps: 'Es gibt keine großen Temperatursprünge.',

      // --- Fahrplan (planNow, planToday, planDay sind Satzteile: klein, ohne Punkt) ---
      planTitle: 'Heizfahrplan',
      planFor: 'Heizfahrplan: {profile}',
      planTitleStorage: 'Aufladung',
      planNightOf: '{day} Nacht',
      planStart: 'Start ab {time}',
      planToday: 'heute ab {time}',
      planDay: '{day} ab {time}',
      planNow: 'jetzt',
      planDue: 'Start fällig',
      planOptional: 'optional',
      planDisagree: 'Die zweite Meinung sagt {t}. Im Zweifel lieber früher heizen.',
      planGusty: 'Wegen starker Böen etwas früher starten.',
      // Je Nacht: {t} fertig mit „°“, {time} und {onset} aus fmt.time, {lead} die Zahl der Stunden ohne Einheit
      planNightMin: 'Tiefster Wert {t} gegen {time} Uhr',
      planLead: 'Abkühlung ab etwa {onset}. Aufheizzeit: {lead} h.',
      // Nachtspeicher, für jeden Abend außer heute (für heute gilt chargeTonight)
      planChargeEvening: 'Aufladung am Abend: {level}',
      strengthThrough: 'Durchheizen, keine Nachtabsenkung',
      strengthUp: 'Heizung eine Stufe höher',
      strengthNormal: 'Normal heizen',
      strengthLow: 'Sparsam heizen reicht',
      // {level} ist eines von chargeHigh, chargeUp, chargeNormal, chargeLow
      chargeTonight: 'Aufladung heute Abend: {level}',
      chargeHigh: 'deutlich höher',
      chargeUp: 'höher',
      chargeNormal: 'normal',
      chargeLow: 'niedrig',

      // --- Jetzt, Tage ({t} jeweils fertig mit „°“) ---
      nowTitle: 'Jetzt',
      nowFeels: 'Gefühlt {t}',
      nowWind: 'Wind {kmh} km/h',
      nowHumidity: 'Luftfeuchte {p} %',
      nowNightMin: 'Kommende Nacht bis {t} gegen {time} Uhr',
      daysTitle: 'Heute und die nächsten zwei Tage',
      dayToday: 'Heute',
      dayTomorrow: 'Morgen',
      dayMin: 'Tiefstwert {t}',
      dayMax: 'Höchstwert {t}',
      dayRain: 'Regen {mm} mm',
      daySun: 'Sonne {h} h',
      dayGust: 'Böen bis {kmh} km/h',
      // {k} ist der Betrag ohne Vorzeichen
      dayColder: 'Im Mittel {k} Grad kälter als am Vortag.',
      dayWarmer: 'Im Mittel {k} Grad wärmer als am Vortag.',
      daySame: 'Im Mittel so warm wie am Vortag.',

      // --- Kurve, Lüften ---
      chartTitle: 'Temperaturverlauf, 72 Stunden',
      chartLegendIcon: 'Hauptprognose (DWD ICON)',
      chartLegendMos: 'Zweite Meinung (MOSMIX): Station {station} auf {height} m Höhe',
      chartLegendRain: 'Regenwahrscheinlichkeit',
      chartNow: 'jetzt',
      // {minWhen} und {maxWhen} kommen aus fmt.when
      chartSummary: 'Tiefster Wert {min} ({minWhen}), höchster Wert {max} ({maxWhen}).',
      chartMosFar: 'Keine Wetterstation in der Nähe liefert eine zweite Meinung (MOSMIX).',
      airTitle: 'Lüften gegen Schimmel',
      airLabel: 'Stoßlüften 5–10 Minuten',
      airNone: 'Heute kein gutes Fenster mehr. Kurz querlüften reicht.',
      // {dew} fertig mit „°“, {comfort} nur die Zahl
      airNote: 'Draußen ist die Luft trockener als drinnen, wenn ihr Taupunkt unter etwa {dew} liegt (Raum {comfort} °C bei 55 % Luftfeuchte). Dann trägt jedes Lüften Feuchtigkeit hinaus.',
      airBest: 'Bestes Fenster',
      airSlot: 'Gegen {time} Uhr lüften.',

      // --- Warnungen (DWD-Texte stehen wörtlich dahinter, nie umformuliert) ---
      alertTitle: 'Warnungen des Deutschen Wetterdienstes',
      alertLangHint: 'Warntext im Wortlaut des Deutschen Wetterdienstes:',
      alertFrom: 'von {when}',
      alertUntil: 'bis {when}',
      alertUnavailable: 'Die Warnungen des Deutschen Wetterdienstes waren beim letzten Abruf nicht erreichbar.',
      alertSource: 'Quelle: Deutscher Wetterdienst',

      // --- Einstellungen ---
      settingsTitle: 'Einstellungen',
      settingsPlaces: 'Deine Orte',
      settingsPlaceActive: 'Diesen Ort anzeigen',
      settingsHeat: 'Heizart',
      settingsComfort: 'Gewünschte Raumtemperatur',
      settingsLeadMin: 'Aufheizzeit bei mildem Wetter (mindestens)',
      settingsLeadMax: 'Aufheizzeit bei Frost (höchstens)',
      settingsElev: 'Höhe über dem Meer',
      settingsAdvanced: 'Für Fortgeschrittene',
      settingsThresholdsHint: 'Ab diesen Werten schaltet die Ampel eine Stufe höher. Die Voreinstellungen sind Faustregeln.',
      threshWarnMinN: 'Vorwarnung, wenn die Nacht kälter wird als',
      threshWarnDrop48: 'Vorwarnung bei Veränderung des Tagesmittels in 48 Stunden',
      threshAlarmMinN: 'Heiz-Alarm, wenn die Nacht kälter wird als',
      threshAlarmDrop48: 'Heiz-Alarm bei Veränderung des Tagesmittels in 48 Stunden',
      threshAlarmGtRise: 'Heiz-Alarm, wenn der Heizbedarf von einem Tag zum nächsten steigt um',
      threshCritMinN: 'Frost-Stufe, wenn die Nacht kälter wird als',
      threshColdWind: 'Als windig gilt Wind ab',
      threshGustLead: 'Früher starten bei Böen ab',
      settingsReset: 'Auf Faustregel zurücksetzen',
      settingsDeleteConfirm: '„{name}“ wirklich löschen?',
      settingsDeleteLast: 'Das ist dein einziger Ort. Danach beginnt die Einrichtung von vorn. „{name}“ trotzdem löschen?',
      // {what} ist der Wert des jeweiligen Beschriftungsschlüssels (settingsComfort, settingsLeadMin, …)
      stepDown: '{what} verringern',
      stepUp: '{what} erhöhen',
      themeLabel: 'Darstellung',
      themeSystem: 'System',
      themeLight: 'Hell',
      themeDark: 'Dunkel',
      langLabel: 'Sprache',

      // --- Fußzeile (Quellenangaben nach KT §3.4, §4, §5.2, §6.3) ---
      footerWeather: 'Wetterdaten: Open-Meteo.com (CC BY 4.0); in Deutschland, Österreich und der Schweiz Modell DWD ICON.',
      footerDwd: 'Warnungen und zweite Meinung (MOSMIX): Quelle: Deutscher Wetterdienst, über Bright Sky.',
      footerAmpel: 'Heiz-Ampel: Datenbasis Deutscher Wetterdienst, eigene Elemente ergänzt. Die Ampel ist eine Faustregel, keine Norm.',
      footerVdi: 'Gradtagzahl nach VDI 3807: 20 °C minus Tagesmittel, nur an Heiztagen unter 15 °C.',
      footerElev: 'Höhe: Copernicus DEM GLO-90 des Copernicus-Programms (ESA), über Open-Meteo.',
      footerGeo: 'Ortssuche: Photon (komoot), Daten © OpenStreetMap-Mitwirkende (ODbL).',
      footerFont: 'Schrift: Atkinson Hyperlegible (SIL Open Font License).',
      footerCode: 'Quelloffen auf GitHub (MIT), © 2026 Dennismit2n. Keine Werbung, keine Zählung, keine Konten.',
      footerPrivacy: 'Deine Adresse (oder einmal dein auf etwa 100 m gerundeter Standort) geht einmal zur Ortssuche raus; die Wetterdienste bekommen nur auf etwa 100 m gerundete Koordinaten. Sonst verlässt nichts dein Gerät.',
      footerOffline: 'Nach dem ersten Besuch startet Heizwarte auch ohne Netz und zeigt den letzten Stand.',
      footerExternal: 'öffnet fremde Seite',

      // --- Wetter-Codes (WMO, 28 Stück) ---
      wmo0: 'Klar',
      wmo1: 'Überwiegend klar',
      wmo2: 'Teils bewölkt',
      wmo3: 'Bedeckt',
      wmo45: 'Nebel',
      wmo48: 'Reifnebel',
      wmo51: 'Leichter Niesel',
      wmo53: 'Niesel',
      wmo55: 'Starker Niesel',
      wmo56: 'Gefrierender Niesel',
      wmo57: 'Gefrierender Niesel',
      wmo61: 'Leichter Regen',
      wmo63: 'Regen',
      wmo65: 'Starker Regen',
      wmo66: 'Gefrierender Regen',
      wmo67: 'Gefrierender Regen',
      wmo71: 'Leichter Schneefall',
      wmo73: 'Schneefall',
      wmo75: 'Starker Schneefall',
      wmo77: 'Schneegriesel',
      wmo80: 'Regenschauer',
      wmo81: 'Kräftige Schauer',
      wmo82: 'Heftige Schauer',
      wmo85: 'Schneeschauer',
      wmo86: 'Starke Schneeschauer',
      wmo95: 'Gewitter',
      wmo96: 'Gewitter mit Hagel',
      wmo99: 'Gewitter mit Hagel'
    }
  };

  // Aktuelle Sprache; ändert nur apply()
  let current = 'de';
  // Listener von onApply(): Seiten mit mehr als statischen Texten zeichnen sich bei jedem Sprachwechsel neu
  const listeners = [];

  function hasKey(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key);
  }

  // Nur eigene Schlüssel zählen: ein gespeichertes „constructor“ oder „__proto__“ ist keine Sprache
  function known(code) {
    return typeof code === 'string' && hasKey(I18N, code);
  }

  // ---------------------------------------------------------------------------------------------
  // Spracherkennung, Anwenden, Übersetzen
  // ---------------------------------------------------------------------------------------------

  function browserLanguages() {
    // navigator nur hinter dem typeof-Wächter (Tests geben languages mit)
    if (typeof navigator === 'undefined' || !navigator) { return []; }
    if (navigator.languages && navigator.languages.length) { return navigator.languages; }
    return navigator.language ? [navigator.language] : [];
  }

  // 1. gespeicherte Sprache (nur wenn es dafür einen Block gibt), 2. erste Browsersprache aus LANGS mit
  // Block, 3. de. Wirft nie: ein werfendes Speicher-Backend zählt wie „nichts gespeichert“.
  function detect(opts) {
    const o = opts || {};
    const storage = o.storage !== undefined ? o.storage : (root.Heizwarte && root.Heizwarte.storage);
    const languages = o.languages !== undefined ? o.languages : browserLanguages();

    try {
      if (storage && typeof storage.get === 'function') {
        const saved = storage.get('lang');
        if (known(saved)) { return saved; }
      }
    } catch (e) {
      // gesperrter oder kaputter Speicher: weiter mit der Browsersprache
    }

    const list = Array.isArray(languages) ? languages : [languages];
    for (let i = 0; i < list.length; i++) {
      const code = String(list[i]).toLowerCase().split(/[-_]/)[0];
      if (LANGS.indexOf(code) >= 0 && known(code)) { return code; }
    }
    return 'de';
  }

  function onApply(fn) {
    if (typeof fn === 'function') { listeners.push(fn); }
  }

  // Ersetzt {name} durch vars.name; ein fehlender Wert lässt den Platzhalter stehen, damit der Fehler
  // sichtbar bleibt. Funktion als Ersatz statt Zeichenkette, damit „$&“ in API-Texten nichts anrichtet.
  // Rückfall: aktueller Block, dann de, dann der Schlüssel selbst.
  function t(key, vars) {
    const table = I18N[current] || I18N.de;
    let s;
    if (hasKey(table, key)) { s = table[key]; }
    else if (hasKey(I18N.de, key)) { s = I18N.de[key]; }
    else { return String(key); }
    if (vars && typeof s === 'string') {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        const v = hasKey(vars, name) ? vars[name] : undefined;
        return v === undefined || v === null ? m : String(v);
      });
    }
    return s;
  }

  function eachNode(doc, selector, fn) {
    const nodes = doc.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) { fn(nodes[i]); }
  }

  // Setzt die Sprache und beschriftet die Seite. opts gibt es nur für Tests und trägt Standardwerte:
  // { document = globalThis.document, storage = Heizwarte.storage }.
  // hw:lang schreibt apply() erst, wenn es mehr als einen Block gibt (ab M4). Vorher bliebe jeder, der
  // die App öffnet, danach auf de festgelegt, weil detect() zuerst den gespeicherten Wert liest.
  function apply(lang, opts) {
    const o = opts || {};
    current = known(lang) ? lang : (known(current) ? current : 'de');

    const doc = o.document !== undefined ? o.document : (typeof document !== 'undefined' ? document : undefined);
    if (!doc) { return; }

    if (Object.keys(I18N).length > 1) {
      try {
        const storage = o.storage !== undefined ? o.storage : (root.Heizwarte && root.Heizwarte.storage);
        if (storage && typeof storage.set === 'function') { storage.set('lang', current); }
      } catch (e) {
        // storage.set wirft nie; falls ein Ersatz es doch tut, darf init() nicht daran scheitern
      }
    }

    if (doc.documentElement) { doc.documentElement.lang = current; }
    doc.title = t('appName');
    eachNode(doc, '[data-i18n]', function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    eachNode(doc, '[data-i18n-aria]', function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    eachNode(doc, '[data-i18n-ph]', function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    eachNode(doc, '[data-i18n-title]', function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });

    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](current); } catch (e) { /* ein kaputter Listener darf die übrigen nicht aufhalten */ }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Intl-Hilfen
  // ---------------------------------------------------------------------------------------------

  const DASH = '–';
  const MINUS = '−';
  const cache = new Map();

  // Eine Sprache, die Intl kennt: die übergebene, sonst die aktuelle, sonst de. Wirft nie.
  function loc(lang) {
    if (typeof lang === 'string' && lang) {
      try {
        if (Intl.NumberFormat.supportedLocalesOf(lang).length) { return lang; }
      } catch (e) {
        // formal ungültiges Sprachkennzeichen → Rückfall unten
      }
    }
    return known(current) ? current : 'de';
  }

  function cached(kind, lang, tz, opts, make) {
    const key = kind + '|' + lang + '|' + tz + '|' + JSON.stringify(opts);
    let f = cache.get(key);
    if (!f) {
      f = make();
      cache.set(key, f);
    }
    return f;
  }

  // Ortszeit: immer mit der Zeitzone der Daten. Kennt die Laufzeit die Zone nicht, rechnet der Formatierer
  // in der Gerätezeit weiter, statt zu werfen (weather.tzSafe fängt unbekannte Zonen schon beim Laden ab).
  function dtf(lang, tz, opts) {
    return cached('dtf', lang, tz, opts, function () {
      const o = Object.assign({}, opts);
      if (tz) { o.timeZone = tz; }
      try {
        return new Intl.DateTimeFormat(lang, o);
      } catch (e) {
        delete o.timeZone;
        return new Intl.DateTimeFormat(lang, o);
      }
    });
  }

  function nf(lang, digits) {
    return cached('nf', lang, '', digits, function () {
      return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    });
  }

  // numeric 'auto' für „jetzt“, „heute“, „morgen“, „gestern“; 'always' für reine Zählung („vor 2 Tagen“)
  function rtf(lang, numeric) {
    const n = numeric === 'always' ? 'always' : 'auto';
    return cached('rtf', lang, '', n, function () {
      return new Intl.RelativeTimeFormat(lang, { numeric: n });
    });
  }

  // Date.parse(null) ist NaN, Intl.DateTimeFormat.format(NaN) wirft RangeError (Bright Sky liefert expires: null)
  function okTime(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
  }

  // Tage seit 1970-01-01 für ein Kalenderdatum (days_from_civil von Howard Hinnant); rechnet ohne Date
  function daysFromCivil(y, m, d) {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  // Laufende Tagesnummer des Ortsdatums (Rechenweg wie weather.dayKeyOf, aber hier, weil i18n vor weather lädt)
  function dayNumber(ms, tz) {
    const parts = dtf('en-US', tz, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms);
    const p = {};
    for (let i = 0; i < parts.length; i++) { p[parts[i].type] = parts[i].value; }
    return daysFromCivil(Number(p.year), Number(p.month), Number(p.day));
  }

  // Zahl in der Sprache. Das führende „-“ wird zu „−“ (U+2212); eine Null, die erst durch das Runden
  // negativ aussieht („-0,0“), verliert ihr Vorzeichen. Kein Wert → „–“.
  function num(x, digits, lang) {
    if (typeof x !== 'number' || !Number.isFinite(x)) { return DASH; }
    const d = Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 1;
    try {
      let s = nf(loc(lang), d).format(x);
      if (/^[-−]/.test(s)) {
        s = /[1-9]/.test(s) ? MINUS + s.slice(1) : s.slice(1);
      }
      return s;
    } catch (e) {
      return DASH;
    }
  }

  // Nie style: 'unit': das liefert in hi und pl fremde Einheitenschreibweisen (KT §8 Punkt 3)
  function temp(x, digits, lang) {
    const n = num(x, digits, lang);
    return n === DASH ? n : n + ' °C';
  }

  function deg(x, digits, lang) {
    const n = num(x, digits === undefined ? 0 : digits, lang);
    return n === DASH ? n : n + '°';
  }

  // Uhrzeit immer mit Minuten und in der Uhrzeitform der Sprache (12 h in en, hi, ko), nie nur die Stunde
  function time(ms, tz, lang) {
    if (!okTime(ms)) { return DASH; }
    try {
      return dtf(loc(lang), tz, { hour: 'numeric', minute: '2-digit' }).format(ms);
    } catch (e) {
      return DASH;
    }
  }

  function date(ms, tz, lang) {
    if (!okTime(ms)) { return DASH; }
    try {
      return dtf(loc(lang), tz, { day: 'numeric', month: 'short' }).format(ms);
    } catch (e) {
      return DASH;
    }
  }

  function wday(ms, tz, lang, long) {
    if (!okTime(ms)) { return DASH; }
    try {
      return dtf(loc(lang), tz, { weekday: long ? 'long' : 'short' }).format(ms);
    } catch (e) {
      return DASH;
    }
  }

  // „vor 3 Stunden“, „vor 5 Minuten“, „vor 2 Tagen“: Einheit automatisch (Minute, Stunde, Tag), unter einer
  // Minute „jetzt“. Das ist reine Zählung ohne Kalender: Bis unter 48 Stunden bleibt es bei Stunden, danach
  // ganze Tage mit numeric 'always'. Kalenderwörter („gestern“) widersprächen sonst fmt.when im selben Satz:
  // „Stand: heute 0:05 (gestern)“ um 23:40, weil 23,6 Stunden zur Tageseinheit gerundet würden.
  function rel(ms, nowMs, lang) {
    if (!okTime(ms) || !okTime(nowMs)) { return DASH; }
    try {
      const diff = (ms - nowMs) / 1000;
      const abs = Math.abs(diff);
      const sign = diff < 0 ? -1 : 1;
      const minutes = Math.round(abs / 60);
      const hours = Math.round(abs / 3600);
      if (abs < 60) { return rtf(loc(lang)).format(0, 'second'); }
      if (minutes < 60) { return rtf(loc(lang)).format(sign * minutes, 'minute'); }
      if (hours < 48) { return rtf(loc(lang)).format(sign * hours, 'hour'); }
      return rtf(loc(lang), 'always').format(sign * Math.max(2, Math.floor(abs / 86400)), 'day');
    } catch (e) {
      return DASH;
    }
  }

  // „heute 21:00“, „morgen 11:00“, „gestern 10:10“, sonst „Dienstag 15:00“. Der Tagesabstand kommt aus den
  // Ortsdaten beider Zeitpunkte, nicht aus 24-Stunden-Schritten: eine halbe Stunde nach Mitternacht ist
  // „morgen“, auch am Tag der Uhrumstellung. Ohne gültiges nowMs fehlt der Bezug, dann steht der Wochentag.
  function when(ms, nowMs, tz, lang) {
    if (!okTime(ms)) { return DASH; }
    try {
      const l = loc(lang);
      const clock = time(ms, tz, l);
      if (okTime(nowMs)) {
        const d = dayNumber(ms, tz) - dayNumber(nowMs, tz);
        if (d >= -1 && d <= 1) {
          return rtf(l).format(d, 'day') + ' ' + clock;
        }
      }
      return wday(ms, tz, l, true) + ' ' + clock;
    } catch (e) {
      return DASH;
    }
  }

  const fmt = { num: num, temp: temp, deg: deg, time: time, date: date, wday: wday, rel: rel, when: when };

  // Wettertext zu einem WMO-Code; unbekannter Code oder gar kein Code → „–“
  function wmo(code) {
    let n = NaN;
    if (typeof code === 'number') { n = code; }
    else if (typeof code === 'string' && /^\d{1,3}$/.test(code)) { n = Number(code); }
    if (!Number.isInteger(n)) { return DASH; }
    const key = 'wmo' + n;
    const table = I18N[current] || I18N.de;
    if (hasKey(table, key)) { return table[key]; }
    if (hasKey(I18N.de, key)) { return I18N.de[key]; }
    return DASH;
  }

  const api = {
    LANGS: LANGS,
    I18N: I18N,
    detect: detect,
    apply: apply,
    t: t,
    onApply: onApply,
    fmt: fmt,
    wmo: wmo,
    get lang() { return current; }
  };
  root.Heizwarte.i18n = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
