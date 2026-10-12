/*
 * Tests für js/i18n.js, Stufe M1 (BAUPLAN Abschnitt 12): nur der Block de, vollständig; Platzhalter-
 * und Hausstil-Regeln; Spracherkennung; apply() mit einem Papier-DOM; die Intl-Helfer unter
 * ausdrücklicher Zeitzone (deshalb für jede Prozess-TZ gleich); kein fester Text im Code (E:63).
 *
 * Stufe M4 (Commit „Füge dreizehn Übersetzungen hinzu“) ersetzt die Prüfung „genau der Block de“ durch
 * „alle 14 Blöcke, gleiche Schlüsselmenge, gleiche Platzhalter“ und lässt detect() mit ['sv', 'pl'] 'pl' liefern.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const { fakeStorage } = require('./_fake.js');

const i18n = Heizwarte.i18n;
const { I18N, LANGS, fmt } = i18n;
const de = I18N.de;
const ROOT = path.join(__dirname, '..');

// Schlüsseltabelle aus BAUPLAN Abschnitt 5 i18n, samt Platzhaltern in geschweiften Klammern.
// Neuer Schlüssel im Code heißt: hier ergänzen UND in js/i18n.js einen deutschen Text setzen.
const SCHLUESSEL = {
  'App, Knöpfe': 'appName appClaim placeLabel btnReload btnReloading btnMore btnLess btnSettings btnBack btnNext btnDone btnRetry btnChange btnUse btnDelete btnAddPlace btnCancel btnCityOnly',
  Status: 'statusLoading statusStamp{when,ago} statusStale statusOffline statusNoData statusWaiting{s} statusRateLimited storageBlocked storageFull storeNewer',
  Einrichtung: 'setupIntro setupPrivacy setupByAddress setupByLocation setupStep{n,of} setupAddressTitle setupStreet setupStreetHint setupZip setupCity setupSearch setupSearching setupHitsTitle setupHitsHint setupNoNumber setupNoneFits setupConfirmTitle setupConfirmQuestion setupConfirmYes setupConfirmNo setupRegion{region} setupExtent{w,h} setupCoords{lat,lon} setupElev{m} setupElevAuto setupElevLoading setupElevUnknown setupElevHint setupElevLabel setupLabel setupMyPlace setupGeoWrong setupHeatTitle setupHeatHint setupHeatDontKnow setupHeatDefaultHint hitHouse hitStreet hitPlace hitPoi',
  Fehler: 'errNeedPlace errNoHit errNoHitTip1 errNoHitTip2 errOfflineSearch errSearchRejected errGeoDenied errGeoFailed errElev errMaxPlaces errTooOld errLoadFailed',
  Heizarten: 'profileRadiator profileFloorScreed profileFloorDry profileHeatpumpFloor profileStorage profileHintRadiator profileHintFloorScreed profileHintFloorDry profileHintHeatpumpFloor profileHintStorage profileRule',
  Ampel: 'level0 level1 level2 level3 levelOf{n,name} levelTitle0 levelTitle1{when} levelTitle2{when} levelTitle3{when} levelText0 levelText1{onset,lead} levelText2{onset,lead} levelText3{onset,lead} levelNoData reasonNightMin{t} reasonDrop48{k} reasonColdWindy reasonFrost reasonGtRise{kd} reasonAlert reasonCalmNights{t} reasonNoJumps',
  Fahrplan: 'planTitle planFor{profile} planTitleStorage planNightOf{day} planStart{time} planToday{time} planDay{day,time} planNow planDue planOptional planDisagree{t} planGusty strengthThrough strengthUp strengthNormal strengthLow chargeTonight{level} chargeHigh chargeUp chargeNormal chargeLow',
  'Jetzt, Tage': 'nowTitle nowFeels{t} nowWind{kmh} nowHumidity{p} nowNightMin{t,time} daysTitle dayToday dayTomorrow dayMin{t} dayMax{t} dayRain{mm} daySun{h} dayGust{kmh} dayColder{k} dayWarmer{k} daySame',
  'Kurve, Lüften': 'chartTitle chartLegendIcon chartLegendMos{station,height} chartLegendRain chartNow chartSummary{min,minWhen,max,maxWhen} chartMosFar airTitle airLabel airNone airNote{dew,comfort} airBest airSlot{time}',
  Warnungen: 'alertTitle alertLangHint alertFrom{when} alertUntil{when} alertUnavailable alertSource',
  Einstellungen: 'settingsTitle settingsPlaces settingsPlaceActive settingsHeat settingsComfort settingsLeadMin settingsLeadMax settingsElev settingsAdvanced settingsThresholdsHint threshWarnMinN threshWarnDrop48 threshAlarmMinN threshAlarmDrop48 threshAlarmGtRise threshCritMinN threshColdWind threshGustLead settingsReset settingsDeleteConfirm{name} settingsDeleteLast{name} stepDown{what} stepUp{what} themeLabel themeSystem themeLight themeDark langLabel',
  Fußzeile: 'footerWeather footerDwd footerAmpel footerVdi footerElev footerGeo footerFont footerCode footerPrivacy footerOffline footerExternal',
  'Wetter-Codes': 'wmo0 wmo1 wmo2 wmo3 wmo45 wmo48 wmo51 wmo53 wmo55 wmo56 wmo57 wmo61 wmo63 wmo65 wmo66 wmo67 wmo71 wmo73 wmo75 wmo77 wmo80 wmo81 wmo82 wmo85 wmo86 wmo95 wmo96 wmo99'
};

// { Schlüssel: [Platzhalter, sortiert] } und Schlüssel je Gruppe
const ERWARTET = {};
const GRUPPE = {};
for (const gruppe of Object.keys(SCHLUESSEL)) {
  for (const token of SCHLUESSEL[gruppe].split(/\s+/)) {
    const m = /^(\w+)(?:\{([\w,]+)\})?$/.exec(token);
    assert.ok(m, 'Schlüsseltabelle im Test kaputt bei ' + token);
    ERWARTET[m[1]] = m[2] ? m[2].split(',').sort() : [];
    GRUPPE[m[1]] = gruppe;
  }
}

function platzhalter(text) {
  const namen = [];
  text.replace(/\{(\w+)\}/g, (m, n) => { namen.push(n); return m; });
  return Array.from(new Set(namen)).sort();
}

// Zeitpunkte: Berlin im Januar ist UTC+1
const bei = (tag, h, min) => Date.UTC(2026, 0, tag, h - 1, min);
const Z = bei(13, 10, 0);                  // Dienstag, 13.01.2026, 10:00 Berlin = 09:00 UTC
const JETZT = bei(13, 23, 30);             // 23:30 Berlin, kurz vor Mitternacht
const BERLIN = 'Europe/Berlin';

// Block kurz einhängen, damit Pfade prüfbar sind, die es erst ab M4 wirklich gibt; danach wieder entfernen
function mitBlock(code, fn) {
  I18N[code] = { _name: 'Test ' + code };
  try {
    return fn();
  } finally {
    delete I18N[code];
    i18n.apply('de', { document: fakeDocument([]), storage: fakeStorage() });
  }
}

// ---------------------------------------------------------------------------------------------
// Papier-DOM für apply()
// ---------------------------------------------------------------------------------------------

function fakeElement(attrs) {
  const el = { attrs: Object.assign({}, attrs), textContent: '' };
  el.getAttribute = (n) => (Object.prototype.hasOwnProperty.call(el.attrs, n) ? el.attrs[n] : null);
  el.setAttribute = (n, v) => { el.attrs[n] = String(v); };
  return el;
}

function fakeDocument(elements) {
  return {
    documentElement: { lang: '' },
    title: '',
    querySelectorAll(selector) {
      const m = /^\[([a-z0-9-]+)\]$/.exec(selector);
      return elements.filter((e) => m && Object.prototype.hasOwnProperty.call(e.attrs, m[1]));
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Block de
// ---------------------------------------------------------------------------------------------

test('Stufe M1: I18N enthält genau den Block de, LANGS die 14 Sprachen der Startseite', () => {
  assert.deepEqual(Object.keys(I18N), ['de']);
  assert.equal(de._name, 'Deutsch');
  assert.deepEqual(LANGS, ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'tr', 'ru', 'hi', 'zh', 'ja', 'ko']);
});

test('Block de hat genau die Schlüssel der Tabelle im Plan, nicht mehr und nicht weniger', () => {
  const vorhanden = Object.keys(de).filter((k) => k !== '_name').sort();
  const soll = Object.keys(ERWARTET).sort();
  assert.equal(soll.length, 236);
  assert.deepEqual(soll.filter((k) => !vorhanden.includes(k)), [], 'fehlt in de');
  assert.deepEqual(vorhanden.filter((k) => !soll.includes(k)), [], 'steht in de, aber nicht in der Tabelle');
});

test('kein Wert in de ist leer oder besteht nur aus Leerraum', () => {
  for (const k of Object.keys(de)) {
    assert.equal(typeof de[k], 'string', k + ' ist kein Text');
    assert.notEqual(de[k].trim(), '', k + ' ist leer');
  }
});

test('Platzhalter je Schlüssel entsprechen der Tabelle, keine losen Klammern', () => {
  for (const k of Object.keys(ERWARTET)) {
    assert.deepEqual(platzhalter(de[k]), ERWARTET[k], 'Platzhalter von ' + k);
    assert.equal(de[k].replace(/\{\w+\}/g, '').match(/[{}]/), null, 'lose Klammer in ' + k);
  }
});

test('Gruppe Status: nur statusStamp und statusWaiting tragen Platzhalter', () => {
  const mit = Object.keys(ERWARTET).filter((k) => GRUPPE[k] === 'Status' && platzhalter(de[k]).length);
  assert.deepEqual(mit.sort(), ['statusStamp', 'statusWaiting']);
});

test('levelTitle1–3 tragen {when}; level* und plan* nennen weder Fliesen noch Fußboden', () => {
  for (const n of [1, 2, 3]) {
    assert.ok(de['levelTitle' + n].includes('{when}'), 'levelTitle' + n);
  }
  assert.ok(!de.levelTitle0.includes('{when}'));
  for (const k of Object.keys(de)) {
    if (/^(level|plan)/.test(k)) {
      assert.doesNotMatch(de[k], /fliesen|fußboden/i, k);
    }
  }
});

test('Heizarten: jeder Typ hat Namen und Laiensatz mit seiner Aufheizzeit aus Abschnitt 7', () => {
  assert.equal(de.profileRadiator, 'Heizkörper');
  assert.match(de.profileHintRadiator, /halben bis zwei Stunden/);
  assert.match(de.profileHintFloorScreed, /3 bis 6 Stunden/);
  assert.match(de.profileHintFloorDry, /1 bis 3 Stunden/);
  assert.match(de.profileHintHeatpumpFloor, /4 bis 8 Stunden/);
  assert.match(de.profileHintStorage, /aufladen/);
  assert.match(de.profileRule, /^Faustregel/);
  for (const k of ['settingsLeadMin', 'settingsLeadMax', 'levelText1']) {
    assert.match(de[k], /Aufheizzeit/, k);
  }
});

test('Hausstil: ’ statt \', kein Geviertstrich, kein Vorlauf, saubere Leerzeichen', () => {
  for (const k of Object.keys(de)) {
    const v = de[k];
    assert.ok(!v.includes('\''), k + ' enthält ein gerades Apostroph');
    assert.ok(!v.includes('—'), k + ' enthält einen Geviertstrich');
    assert.ok(!v.includes('...'), k + ' enthält drei Punkte statt …');
    assert.ok(!/\s-\s/.test(v), k + ' enthält einen Bindestrich mit Leerzeichen statt –');
    assert.equal(v, v.trim(), k + ' hat Leerraum am Rand');
    assert.ok(!/ {2}/.test(v), k + ' hat doppelte Leerzeichen');
    assert.ok(!/Vorlauf/.test(v), k + ' sagt Vorlauf; in der Oberfläche heißt es Aufheizzeit');
  }
});

test('Datenschutzsätze nennen den gerundeten Standort (Entscheidung 13, Wahl a)', () => {
  assert.match(de.setupPrivacy, /einmal dein auf etwa 100 m gerundeter Standort/);
  assert.match(de.footerPrivacy, /\(oder einmal dein auf etwa 100 m gerundeter Standort\)/);
  assert.match(de.footerPrivacy, /Ortssuche raus; die Wetterdienste bekommen nur auf etwa 100 m gerundete Koordinaten\. Sonst verlässt nichts dein Gerät\.$/);
  assert.doesNotMatch(de.setupPrivacy + de.footerPrivacy, /einmal dein Standort/);
});

test('Quellenangaben der Fußzeile sind vollständig', () => {
  assert.match(de.footerWeather, /Open-Meteo\.com \(CC BY 4\.0\)/);
  assert.match(de.footerDwd, /Deutscher Wetterdienst/);
  assert.match(de.footerElev, /Copernicus DEM GLO-90/);
  assert.match(de.footerGeo, /OpenStreetMap-Mitwirkende \(ODbL\)/);
  assert.match(de.footerFont, /Atkinson Hyperlegible/);
  assert.match(de.footerCode, /MIT/);
});

// ---------------------------------------------------------------------------------------------
// WMO, t()
// ---------------------------------------------------------------------------------------------

test('wmo: 28 Codes mit Text, unbekannter oder fehlender Code gibt „–“', () => {
  const codes = Object.keys(de).filter((k) => /^wmo\d+$/.test(k));
  assert.equal(codes.length, 28);
  for (const k of codes) {
    assert.equal(i18n.wmo(Number(k.slice(3))), de[k], k);
  }
  assert.equal(i18n.wmo(61), 'Leichter Regen');
  assert.equal(i18n.wmo('3'), 'Bedeckt');
  for (const schlecht of [4, 100, -1, 61.5, null, undefined, NaN, '', 'x', {}, [61]]) {
    assert.equal(i18n.wmo(schlecht), '–', String(schlecht));
  }
});

test('t(): Platzhalter, Rückfall auf den Schlüssel, nichts Besonderes bei $ im Wert', () => {
  assert.equal(i18n.t('btnBack'), 'Zurück');
  assert.equal(i18n.t('statusStamp', { when: 'heute 12:00', ago: 'vor 3 Stunden' }), 'Stand: heute 12:00 (vor 3 Stunden).');
  assert.equal(i18n.t('setupStep', { n: 2, of: 4 }), 'Schritt 2 von 4');
  assert.equal(i18n.t('planDay', { day: 'Dienstag', time: 0 }), 'Dienstag ab 0', 'Zahl 0 ist ein Wert');
  assert.equal(i18n.t('planDay', { day: '$&', time: '$1' }), '$& ab $1');
  assert.equal(i18n.t('levelTitle2', {}), 'Heizung {when} deutlich hochdrehen.', 'fehlender Wert lässt den Platzhalter stehen');
  assert.equal(i18n.t('levelTitle2', { when: null }), 'Heizung {when} deutlich hochdrehen.');
  assert.equal(i18n.t('gibtEsNicht'), 'gibtEsNicht');
  assert.equal(i18n.t('constructor'), 'constructor', 'geerbte Eigenschaften sind keine Schlüssel');
  assert.equal(i18n.t('toString'), 'toString');
});

test('Platzhalter zusammengesetzter Sätze: Handlungssatz der Ampel', () => {
  const wann = i18n.t('planToday', { time: '15:00' });
  assert.equal(wann, 'heute ab 15:00');
  assert.equal(i18n.t('levelTitle1', { when: wann }), 'Heizung heute ab 15:00 höher stellen.');
  assert.equal(i18n.t('levelTitle3', { when: i18n.t('planNow') }), 'Heizung jetzt durchlaufen lassen.');
  assert.equal(i18n.t('levelOf', { n: 2, name: i18n.t('level2') }), 'Stufe 2 von 3: Heiz-Alarm');
  assert.equal(i18n.t('stepUp', { what: i18n.t('settingsComfort') }), 'Gewünschte Raumtemperatur erhöhen');
});

// ---------------------------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------------------------

test('detect: ohne Block für die Browsersprache oder das Gespeicherte gilt de', () => {
  assert.equal(i18n.detect({ storage: fakeStorage(), languages: ['sv', 'pl'] }), 'de');
  assert.equal(i18n.detect({ storage: fakeStorage({ 'hw:lang': '"fr"' }), languages: ['sv'] }), 'de', 'gespeichertes fr ohne Block zählt nicht');
  assert.equal(i18n.detect({ storage: fakeStorage({ 'hw:lang': '"de"' }), languages: ['sv'] }), 'de');
  assert.equal(i18n.detect({ storage: fakeStorage(), languages: [] }), 'de');
  assert.equal(i18n.detect({ storage: null, languages: ['en-US'] }), 'de');
});

test('detect: werfender Speicher, Müll und geerbte Namen ergeben ohne Wurf de', () => {
  assert.equal(i18n.detect({ storage: fakeStorage({}, { throwOnGet: true }), languages: ['de'] }), 'de');
  assert.equal(i18n.detect({ storage: { get() { throw new Error('gesperrt'); } }, languages: ['sv'] }), 'de');
  for (const wert of ['constructor', '__proto__', 'toString', 42, null, ['de'], { de: 1 }]) {
    const speicher = { get: () => wert };
    assert.equal(i18n.detect({ storage: speicher, languages: ['sv'] }), 'de', String(wert));
  }
  assert.equal(i18n.detect({ storage: fakeStorage(), languages: [null, undefined, 42, {}, 'constructor'] }), 'de');
});

test('detect: Gespeichertes schlägt Browsersprache, erste passende Browsersprache gewinnt (Block eingehängt)', () => {
  mitBlock('pl', () => {
    assert.equal(i18n.detect({ storage: fakeStorage(), languages: ['sv', 'pl'] }), 'pl');
    assert.equal(i18n.detect({ storage: fakeStorage(), languages: ['sv', 'PL-pl', 'de'] }), 'pl', 'Großschreibung und Region');
    assert.equal(i18n.detect({ storage: fakeStorage(), languages: 'pl_PL' }), 'pl', 'einzelne Zeichenkette');
    assert.equal(i18n.detect({ storage: fakeStorage({ 'hw:lang': '"pl"' }), languages: ['de'] }), 'pl');
    assert.equal(i18n.detect({ storage: fakeStorage({ 'hw:lang': '"de"' }), languages: ['pl'] }), 'de');
    assert.equal(i18n.detect({ storage: fakeStorage(), languages: ['de-AT', 'pl'] }), 'de', 'de-AT ist de und kommt zuerst');
  });
});

// ---------------------------------------------------------------------------------------------
// apply(), onApply()
// ---------------------------------------------------------------------------------------------

test('apply ohne document kehrt sofort zurück und wirft nicht', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(i18n.apply('de'), undefined);
  assert.equal(i18n.apply('xx'), undefined);
  assert.equal(i18n.lang, 'de');
});

test('apply beschriftet textContent, aria-label, placeholder, title, lang und document.title', () => {
  const a = fakeElement({ 'data-i18n': 'btnBack' });
  const b = fakeElement({ 'data-i18n-aria': 'btnSettings' });
  const c = fakeElement({ 'data-i18n-ph': 'setupStreet' });
  const d = fakeElement({ 'data-i18n-title': 'footerExternal' });
  const e = fakeElement({ 'data-i18n': 'gibtEsNicht' });
  const doc = fakeDocument([a, b, c, d, e]);
  const speicher = fakeStorage();

  i18n.apply('de', { document: doc, storage: speicher });

  assert.equal(a.textContent, 'Zurück');
  assert.equal(b.attrs['aria-label'], 'Einstellungen');
  assert.equal(c.attrs.placeholder, 'Straße und Hausnummer');
  assert.equal(d.attrs.title, 'öffnet fremde Seite');
  assert.equal(e.textContent, 'gibtEsNicht', 'unbekannter Schlüssel bleibt sichtbar');
  assert.equal(b.textContent, '', 'aria-Schlüssel berührt den Text nicht');
  assert.equal(doc.documentElement.lang, 'de');
  assert.equal(doc.title, 'Heizwarte');
});

test('apply schreibt bis M4 kein hw:lang, danach schon (Block eingehängt)', () => {
  const doc = fakeDocument([]);
  const vorher = fakeStorage();
  i18n.apply('de', { document: doc, storage: vorher });
  assert.equal(vorher.map.has('hw:lang'), false, 'mit nur einem Block bliebe jeder auf de festgelegt');

  mitBlock('pl', () => {
    const nachher = fakeStorage();
    i18n.apply('pl', { document: doc, storage: nachher });
    assert.equal(nachher.map.get('hw:lang'), '"pl"');
    assert.equal(doc.documentElement.lang, 'pl');
    assert.equal(i18n.lang, 'pl');
    assert.equal(i18n.t('btnBack'), 'Zurück', 'fehlender Schlüssel im Block fällt auf de zurück');
    assert.equal(i18n.wmo(61), 'Leichter Regen');
    // werfendes Backend: init() darf an hw:lang nie scheitern
    assert.doesNotThrow(() => i18n.apply('pl', { document: doc, storage: fakeStorage({}, { throwOnSet: true }) }));
    assert.doesNotThrow(() => i18n.apply('pl', { document: doc, storage: { set() { throw new Error('kaputt'); } } }));
  });
  assert.equal(i18n.lang, 'de');
});

test('apply mit unbekannter Sprache bleibt bei der aktuellen', () => {
  const doc = fakeDocument([]);
  i18n.apply('xx', { document: doc, storage: fakeStorage() });
  assert.equal(i18n.lang, 'de');
  i18n.apply('constructor', { document: doc, storage: fakeStorage() });
  assert.equal(i18n.lang, 'de');
  assert.equal(doc.documentElement.lang, 'de');
});

test('onApply: Listener bekommen die Sprache; ein werfender Listener hält die übrigen nicht auf', () => {
  const gesehen = [];
  let aktiv = true;
  i18n.onApply(() => { if (aktiv) { throw new Error('kaputter Listener'); } });
  i18n.onApply((lang) => { if (aktiv) { gesehen.push(lang); } });
  i18n.onApply('kein Listener');
  i18n.apply('de', { document: fakeDocument([]), storage: fakeStorage() });
  aktiv = false;
  assert.deepEqual(gesehen, ['de']);
});

// ---------------------------------------------------------------------------------------------
// fmt.*
// ---------------------------------------------------------------------------------------------

test('fmt.num: Sprachzeichen, Minus U+2212, Nachkommastellen, Null ohne Vorzeichen', () => {
  assert.equal(fmt.num(-3.5, 1, 'de'), '−3,5');
  assert.equal(fmt.num(-3.5, 1, 'en'), '−3.5');
  assert.equal(fmt.num(3, undefined, 'de'), '3,0', 'Standard: eine Nachkommastelle');
  assert.equal(fmt.num(3.14159, 2, 'de'), '3,14');
  assert.equal(fmt.num(-12, 0, 'de'), '−12');
  assert.equal(fmt.num(-0.04, 1, 'de'), '0,0', 'durch Runden negative Null verliert das Vorzeichen');
  assert.equal(fmt.num(-0, 0, 'de'), '0');
  assert.equal(fmt.num(0, 1, 'en'), '0.0');
  for (const l of LANGS) {
    assert.ok(fmt.num(-3.5, 1, l).startsWith('−'), l + ': ' + fmt.num(-3.5, 1, l));
  }
});

test('fmt.temp und fmt.deg hängen °C bzw. ° an und nehmen nie style:unit', () => {
  assert.equal(fmt.temp(-3.5, 1, 'de'), '−3,5 °C');
  assert.equal(fmt.temp(12.34, 0, 'en'), '12 °C');
  assert.equal(fmt.deg(-1, undefined, 'de'), '−1°');
  assert.equal(fmt.deg(7.46, 1, 'de'), '7,5°');
  assert.equal(fmt.temp(-3.5, 1, 'pl'), '−3,5 °C');
  assert.equal(fmt.temp(-3.5, 1, 'hi'), '−3.5 °C');
  assert.equal(fmt.temp(NaN, 1, 'de'), '–');
  assert.equal(fmt.deg(null, 0, 'de'), '–');
});

test('fmt.time: Ortszeit nur über timeZone, nie über die Prozess-TZ', () => {
  const t = (tz) => fmt.time(Z, tz, 'de');
  assert.equal(t('Europe/Berlin'), '10:00');
  assert.equal(t('Europe/Lisbon'), '9:00');
  assert.equal(t('Pacific/Auckland'), '22:00', 'NZDT ist UTC+13');
  assert.match(t('America/New_York'), /^0?4:00$/, 'EST ist UTC−5');
  assert.equal(t('UTC'), '9:00');
  // Sommerzeit: dieselbe Uhrzeit im Juli ist eine Stunde früher in UTC
  const juli = Date.UTC(2026, 6, 13, 8, 0);
  assert.equal(fmt.time(juli, 'Europe/Berlin', 'de'), '10:00');
  // Halbstunden-Zone (Indien +5:30) behält die Minuten
  assert.equal(fmt.time(Z, 'Asia/Kolkata', 'de'), '14:30');
  // Minuten stehen immer da, auch um volle Stunden
  for (const l of LANGS) {
    assert.match(fmt.time(Z, BERLIN, l), /\d:00/, l + ': ' + fmt.time(Z, BERLIN, l));
  }
});

test('fmt.time folgt der Sprache: 12 Stunden in en, hi, ko, sonst 24', () => {
  assert.match(fmt.time(bei(13, 15, 5), BERLIN, 'en'), /^3:05\s?PM$/);
  assert.equal(fmt.time(bei(13, 15, 5), BERLIN, 'fr'), '15:05');
  assert.equal(fmt.time(bei(13, 15, 5), BERLIN, 'ru'), '15:05');
  assert.match(fmt.time(bei(13, 15, 5), BERLIN, 'ko'), /3:05/);
  assert.match(fmt.time(bei(13, 15, 5), BERLIN, 'hi'), /3:05/);
});

test('fmt.date und fmt.wday: Datum und Wochentag in Ortszeit', () => {
  assert.match(fmt.date(Z, BERLIN, 'de'), /^13\. ?Jan/);
  assert.match(fmt.date(Z, BERLIN, 'en'), /^Jan 13$/);
  assert.equal(fmt.wday(Z, BERLIN, 'de', true), 'Dienstag');
  assert.match(fmt.wday(Z, BERLIN, 'de'), /^Di\.?$/);
  // 23:30 Berlin ist in Auckland schon der nächste Kalendertag
  assert.equal(fmt.wday(JETZT, BERLIN, 'de', true), 'Dienstag');
  assert.equal(fmt.wday(JETZT, 'Pacific/Auckland', 'de', true), 'Mittwoch');
  assert.match(fmt.date(JETZT, 'Pacific/Auckland', 'de'), /^14\. ?Jan/);
});

test('fmt.rel: Einheit automatisch, vor, in, jetzt; unter 48 Stunden Stunden, danach Tage ohne Kalenderwort', () => {
  assert.equal(fmt.rel(JETZT - 3 * 3600e3, JETZT, 'de'), 'vor 3 Stunden');
  assert.equal(fmt.rel(JETZT - 5 * 60e3, JETZT, 'de'), 'vor 5 Minuten');
  assert.equal(fmt.rel(JETZT - 20e3, JETZT, 'de'), 'jetzt');
  assert.equal(fmt.rel(JETZT, JETZT, 'de'), 'jetzt');
  assert.equal(fmt.rel(JETZT - 59.7 * 60e3, JETZT, 'de'), 'vor 1 Stunde', '60 Minuten werden zur Stunde');
  assert.equal(fmt.rel(JETZT - 23.6 * 3600e3, JETZT, 'de'), 'vor 24 Stunden', 'kein „gestern“ für reine Stundenzählung');
  assert.equal(fmt.rel(JETZT - 36 * 3600e3, JETZT, 'de'), 'vor 36 Stunden');
  assert.equal(fmt.rel(JETZT - 47.4 * 3600e3, JETZT, 'de'), 'vor 47 Stunden');
  assert.equal(fmt.rel(JETZT - 47.6 * 3600e3, JETZT, 'de'), 'vor 2 Tagen', 'ab 48 Stunden ganze Tage, nie „vorgestern“');
  assert.equal(fmt.rel(JETZT - 3 * 86400e3, JETZT, 'de'), 'vor 3 Tagen');
  assert.equal(fmt.rel(JETZT + 2 * 3600e3, JETZT, 'de'), 'in 2 Stunden');
  assert.equal(fmt.rel(JETZT + 3 * 86400e3, JETZT, 'de'), 'in 3 Tagen');
  assert.equal(fmt.rel(JETZT - 3 * 3600e3, JETZT, 'en'), '3 hours ago');
  assert.equal(fmt.rel(JETZT - 2 * 86400e3, JETZT, 'en'), '2 days ago');
});

test('fmt.rel und fmt.when im Stempel widersprechen sich nicht (Review Runde 1)', () => {
  // jetzt 23:40, Abruf 00:05 desselben Tages: „heute 0:05 (vor 24 Stunden)“, nicht „(gestern)“
  const spaet = bei(13, 23, 40);
  const frueh = bei(13, 0, 5);
  assert.equal(fmt.when(frueh, spaet, BERLIN, 'de'), 'heute 0:05');
  assert.equal(fmt.rel(frueh, spaet, 'de'), 'vor 24 Stunden');
  // 26 Stunden über zwei Kalendertage: Abruf Montag 23:00, jetzt Mittwoch 1:00
  const mo = bei(12, 23, 0);
  const mi = bei(14, 1, 0);
  assert.equal(mi - mo, 26 * 3600e3);
  assert.equal(fmt.when(mo, mi, BERLIN, 'de'), 'Montag 23:00');
  assert.equal(fmt.rel(mo, mi, 'de'), 'vor 26 Stunden');
  for (const l of ['de', 'en', 'fr', 'ja']) {
    assert.ok(/\d/.test(fmt.rel(mo, mi, l)), l + ': eine Zahl statt eines Kalenderworts');
  }
});

test('fmt.when: heute, morgen, gestern, sonst Wochentag, je nach Ortsdatum', () => {
  assert.equal(fmt.when(bei(13, 21, 0), JETZT, BERLIN, 'de'), 'heute 21:00');
  assert.equal(fmt.when(bei(14, 11, 0), JETZT, BERLIN, 'de'), 'morgen 11:00');
  assert.equal(fmt.when(bei(12, 10, 10), JETZT, BERLIN, 'de'), 'gestern 10:10');
  assert.equal(fmt.when(bei(16, 15, 0), JETZT, BERLIN, 'de'), 'Freitag 15:00');
  assert.equal(fmt.when(bei(11, 15, 0), JETZT, BERLIN, 'de'), 'Sonntag 15:00');
  // eine Stunde nach Mitternacht ist schon morgen, obwohl keine 24 Stunden vergangen sind
  assert.match(fmt.when(bei(14, 0, 30), JETZT, BERLIN, 'de'), /^morgen 0{1,2}:30$/);
  // dieselben Zeitpunkte in Auckland (UTC+13): JETZT ist dort schon Mittwoch 11:30
  assert.equal(fmt.when(bei(14, 11, 0), JETZT, 'Pacific/Auckland', 'de'), 'heute 23:00');
  assert.equal(fmt.when(bei(13, 10, 0), JETZT, 'Pacific/Auckland', 'de'), 'gestern 22:00');
  assert.equal(fmt.when(bei(13, 10, 0), JETZT, BERLIN, 'de'), 'heute 10:00');
  assert.equal(fmt.when(bei(14, 11, 0), JETZT, BERLIN, 'en').replace(/\s/g, ' '), 'tomorrow 11:00 AM');
});

test('fmt.when über die Uhrumstellung vom 25.10.2026 zählt Kalendertage, nicht 24-Stunden-Schritte', () => {
  const abends = Date.UTC(2026, 9, 25, 22, 30);       // 23:30 MEZ am 25.10.
  // 00:30 MESZ am 25.10. liegt genau 24 Stunden davor und ist trotzdem heute
  assert.match(fmt.when(Date.UTC(2026, 9, 24, 22, 30), abends, BERLIN, 'de'), /^heute 0{1,2}:30$/);
  // 02:00 MEZ am 26.10. ist morgen
  assert.match(fmt.when(Date.UTC(2026, 9, 26, 1, 0), abends, BERLIN, 'de'), /^morgen 0?2:00$/);
  // 02:30 am 25.10. gibt es zweimal; beide Zeitpunkte sind heute
  assert.match(fmt.when(Date.UTC(2026, 9, 25, 0, 30), abends, BERLIN, 'de'), /^heute 0?2:30$/);
  assert.match(fmt.when(Date.UTC(2026, 9, 25, 1, 30), abends, BERLIN, 'de'), /^heute 0?2:30$/);
});

test('fmt.*: NaN, null, undefined, Unendlich und Zeiten außerhalb von Date werfen nie', () => {
  const keineZahl = [NaN, undefined, null, Infinity, -Infinity, '12', {}, []];
  const schlecht = keineZahl.concat([8.64e15 + 1, -8.64e15 - 1]);   // gültige Zahlen, aber außerhalb von Date
  for (const x of keineZahl) {
    assert.equal(fmt.num(x, 1, 'de'), '–', 'num ' + String(x));
    assert.equal(fmt.temp(x, 1, 'de'), '–', 'temp ' + String(x));
    assert.equal(fmt.deg(x, 0, 'de'), '–', 'deg ' + String(x));
  }
  for (const x of schlecht) {
    assert.equal(fmt.time(x, BERLIN, 'de'), '–', 'time ' + String(x));
    assert.equal(fmt.date(x, BERLIN, 'de'), '–', 'date ' + String(x));
    assert.equal(fmt.wday(x, BERLIN, 'de', true), '–', 'wday ' + String(x));
    assert.equal(fmt.rel(x, JETZT, 'de'), '–', 'rel ms ' + String(x));
    assert.equal(fmt.rel(JETZT, x, 'de'), '–', 'rel nowMs ' + String(x));
    assert.equal(fmt.when(x, JETZT, BERLIN, 'de'), '–', 'when ms ' + String(x));
  }
  assert.equal(fmt.time(NaN, 'Europe/Berlin', 'de'), '–');
  // ohne Bezugszeit zeigt when den Wochentag statt zu werfen
  for (const x of schlecht) {
    assert.equal(fmt.when(bei(13, 21, 0), x, BERLIN, 'de'), 'Dienstag 21:00', 'when nowMs ' + String(x));
  }
});

test('fmt.*: unbekannte Zeitzone und ungültige Sprache werfen nie', () => {
  assert.doesNotThrow(() => fmt.time(Z, 'Mars/Olympus', 'de'));
  assert.match(fmt.time(Z, 'Mars/Olympus', 'de'), /\d:00/);
  assert.doesNotThrow(() => fmt.when(Z, Z, 'Mars/Olympus', 'de'));
  assert.doesNotThrow(() => fmt.time(Z, undefined, 'de'));
  for (const sprache of [undefined, null, '', 'xx', 'de_DE', 'kein gültiges Kennzeichen', 42, {}]) {
    assert.match(fmt.num(1.5, 1, sprache), /^1[,.]5$/, String(sprache));
    assert.match(fmt.time(Z, BERLIN, sprache), /\d:00/, String(sprache));
    assert.notEqual(fmt.rel(JETZT - 3600e3, JETZT, sprache), '–', String(sprache));
  }
});

test('fmt.time/date/wday/rel/when/num laufen in allen 14 Sprachen ohne Wurf und ohne Platzhalter', () => {
  for (const l of LANGS) {
    for (const wert of [
      fmt.num(-3.5, 1, l), fmt.temp(-3.5, 1, l), fmt.deg(-3.5, 0, l),
      fmt.time(Z, BERLIN, l), fmt.date(Z, BERLIN, l), fmt.wday(Z, BERLIN, l), fmt.wday(Z, BERLIN, l, true),
      fmt.rel(JETZT - 3 * 3600e3, JETZT, l), fmt.when(bei(14, 11, 0), JETZT, BERLIN, l),
      fmt.when(bei(13, 21, 0), JETZT, BERLIN, l), fmt.when(bei(12, 10, 10), JETZT, BERLIN, l),
      fmt.when(bei(16, 15, 0), JETZT, BERLIN, l)
    ]) {
      assert.equal(typeof wert, 'string', l);
      assert.notEqual(wert, '', l);
      assert.notEqual(wert, '–', l);
      assert.doesNotMatch(wert, /undefined|NaN|\[object/, l);
    }
  }
});

test('fmt.time ohne lang folgt der aktuellen Sprache (de)', () => {
  assert.equal(fmt.time(Z, BERLIN), '10:00');
  assert.equal(fmt.num(-1.5), '−1,5');
});

// ---------------------------------------------------------------------------------------------
// Kein fester Text im Code (E:63)
// ---------------------------------------------------------------------------------------------

function ohneKommentare(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

// alle Schlüssel, die als Zeichenkettenliteral an t(…) übergeben werden (auch i18n.t, Heizwarte.i18n.t)
function tSchluessel(src) {
  const re = /(?<![\w$])(?:[\w$]+\.)*t\(\s*(['"])(\w+)\1\s*[,)]/g;
  const out = [];
  let m;
  while ((m = re.exec(ohneKommentare(src))) !== null) { out.push(m[2]); }
  return out;
}

// Zeichenkettenliterale mit Buchstaben, die direkt in textContent oder einen Textknoten wandern
function festerText(src) {
  const code = ohneKommentare(src);
  const re = /\.textContent\s*\+?=\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1|createTextNode\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
  const out = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const text = m[2] !== undefined ? m[2] : m[4];
    if (/\p{L}/u.test(text)) { out.push(text); }
  }
  return out;
}

// Textknoten mit Buchstaben, die nicht direkt in einem Element mit data-i18n stehen
// (ausgenommen title, script, style, Kommentare). Kleiner Zerleger, kein DOM nötig.
function textOhneSchluessel(html) {
  const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'col', 'area', 'base', 'wbr', 'embed', 'param', 'track']);
  const SKIP = new Set(['title', 'script', 'style']);
  const re = /<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)/g;
  const quelle = html.replace(/<!--[\s\S]*?-->/g, '');
  const stapel = [];
  const schlecht = [];
  let m;
  while ((m = re.exec(quelle)) !== null) {
    if (m[2] !== undefined) {
      const name = m[2].toLowerCase();
      if (m[1]) {
        while (stapel.length) {
          if (stapel.pop().name === name) { break; }
        }
      } else if (!VOID.has(name) && !/\/\s*$/.test(m[3])) {
        stapel.push({ name, i18n: /\sdata-i18n\s*=/.test(' ' + m[3]), skip: SKIP.has(name) });
      }
    } else if (m[4] !== undefined && /\p{L}/u.test(m[4])) {
      const oben = stapel[stapel.length - 1];
      if (!stapel.some((s) => s.skip) && !(oben && oben.i18n)) { schlecht.push(m[4].trim()); }
    }
  }
  return schlecht;
}

test('Prüfer selbst: tSchluessel erkennt Aufrufe und lässt Ähnliches in Ruhe', () => {
  const probe = [
    "el.textContent = t('btnBack');",
    "x = i18n.t(\"levelOf\", { n: 1 });",
    "y = Heizwarte.i18n.t('appName')",
    "s.split('a'); q.set('lang', 1); r.get('lang'); it('x'); at('y'); t(key); t('a' + n);",
    "// t('imKommentar')",
    "/* t('imBlock') */"
  ].join('\n');
  assert.deepEqual(tSchluessel(probe), ['btnBack', 'levelOf', 'appName']);
});

test('Prüfer selbst: festerText findet Literale mit Buchstaben, nicht leere oder übersetzte', () => {
  assert.deepEqual(festerText("a.textContent = 'Hallo'; b.textContent = \"Ok\"; c.textContent = `Hi`; d.createTextNode('Text');"), ['Hallo', 'Ok', 'Hi', 'Text']);
  assert.deepEqual(festerText("a.textContent = ''; b.textContent = t('x'); c.textContent = '123'; d.createTextNode(t('y')); e.textContent += '–';"), []);
  assert.deepEqual(festerText("// a.textContent = 'Kommentar'"), []);
});

test('Prüfer selbst: textOhneSchluessel findet losen Text, nicht den unter data-i18n', () => {
  assert.deepEqual(textOhneSchluessel('<p>Hallo</p>'), ['Hallo']);
  assert.deepEqual(textOhneSchluessel('<p data-i18n="x">Hallo</p>'), []);
  assert.deepEqual(textOhneSchluessel('<p data-i18n="x"><a href="#">Hallo</a></p>'), ['Hallo']);
  assert.deepEqual(textOhneSchluessel('<p data-i18n-aria="x">Hallo</p>'), ['Hallo'], 'aria-Schlüssel ist kein Textschlüssel');
  assert.deepEqual(textOhneSchluessel('<a><span data-i18n="a"></span> <span class="visually-hidden" data-i18n="b"></span></a>'), []);
  assert.deepEqual(textOhneSchluessel('<head><title>Hallo</title><style>a{}</style><script>var x = "Hallo";</script></head>'), []);
  assert.deepEqual(textOhneSchluessel('<!doctype html><!-- Hallo --><meta name="d" content="Hallo > Welt"><br/><p data-i18n="x">Ja</p>'), []);
  assert.deepEqual(textOhneSchluessel('<ul><li>Eins</li><li data-i18n="z">Zwei</li></ul>'), ['Eins']);
});

test('jeder t()-Schlüssel in js/*.js existiert in de', () => {
  const dateien = fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'));
  assert.ok(dateien.includes('i18n.js'));
  for (const name of dateien) {
    const src = fs.readFileSync(path.join(ROOT, 'js', name), 'utf8');
    for (const schluessel of tSchluessel(src)) {
      assert.ok(Object.prototype.hasOwnProperty.call(de, schluessel), name + ': t(\'' + schluessel + '\') hat keinen Schlüssel in de');
    }
  }
});

test('js/*.js außer i18n.js geben textContent und Textknoten nie ein Literal mit Buchstaben (E:63)', () => {
  for (const name of fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js') && n !== 'i18n.js')) {
    const src = fs.readFileSync(path.join(ROOT, 'js', name), 'utf8');
    assert.deepEqual(festerText(src), [], name);
  }
});

test('index.html: jeder Text steht in einem Element mit data-i18n, jeder Schlüssel existiert in de (E:63)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.deepEqual(textOhneSchluessel(html), []);
  const re = /\sdata-i18n(?:-aria|-ph|-title)?="([^"]*)"/g;
  let m;
  let anzahl = 0;
  while ((m = re.exec(html)) !== null) {
    anzahl++;
    assert.ok(Object.prototype.hasOwnProperty.call(de, m[1]), 'index.html: data-i18n="' + m[1] + '" hat keinen Schlüssel in de');
  }
  assert.ok(anzahl > 0);
  assert.match(html, /<h1 data-i18n="appName">/, 'auch die Überschrift trägt einen Schlüssel');
});
