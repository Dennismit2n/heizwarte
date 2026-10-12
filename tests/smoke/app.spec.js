/*
 * Heizwarte — Smoke-Test im Browser (BAUPLAN Abschnitt 12, „Smoke“), Meilenstein 1: die Fälle 1 bis 10.
 *
 * Läuft mit npx playwright test in Chromium, einmal bei 360 px (phone) und einmal bei 1280 px (desktop).
 * Das Netz gibt es nicht: Open-Meteo, Bright Sky, Photon und die Höhenabfrage werden per page.route auf die
 * Dateien unter tests/fixtures umgeleitet; jede andere fremde Anfrage bricht ab und wäre ein Fehler.
 * Die Seitenuhr steht auf dem Fixture-Tag (13.01.2026 10:00 Europe/Berlin), sonst sagt die Ampel „zu alt“.
 * Wartezeiten laufen über page.clock.fastForward und page.clock.runFor, nie über echtes Warten. Erwartete Sätze
 * kommen aus den deutschen Planschlüsseln in js/i18n.js (I18N.de), nicht abgeschrieben aus der Oberfläche.
 *
 * Fall 3 (Sprachen) läuft bis M4 nur auf Deutsch, weil es noch keine Sprachwahl gibt. Die Fälle 11 bis 17
 * kommen mit den Meilensteinen 3 und 5 dazu; Fall 11 („Mehr anzeigen“: Kurve und Lüften, hw:more), Fall 12 (Heizart, Höhe, Stepper, Orte der Einstellungen, Schwellen
 * „Für Fortgeschrittene“), Fall 13 (Theme System/Hell/Dunkel), Fall 14 (Stufenzeile als Text) und Fall 17 (mehrere Orte: Nachtrag, Umschalter, Wechsel
 * während eines Abrufs, Maximum fünf) stehen schon.
 * Die Einstellungen sind außerdem die zehnte Stelle in walkScreens und damit in Fall 2, 3 und 5. Fall 3 läuft
 * zusätzlich mit drei Orten, zwei davon mit 40 Zeichen langen Namen (Umschalter im Kopf, Ortsliste, Rückfrage).
 */
'use strict';

const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const { I18N } = require('../../js/i18n.js');

const expect = base.expect;
const FIXTURES = path.join(__dirname, '..', 'fixtures');

// Jetzt = Tag 2 von 5 der konstruierten Wetter-Fixtures (past_days=1)
const NOW = new Date('2026-01-13T10:00:00+01:00');

// Tippflächen nach Fall 2
const TAP_SELECTOR = 'button, a, select, input, summary, [role=button]';

// Eine Koordinate in einer Anfrage hat höchstens drei Nachkommastellen (DoD 5)
const COORD = /^-?\d+\.\d{1,3}$/;

// Marktstraße 1 aus photon-haus.json, wie Fall 7 sie als Standort vorgibt
const HOME = { latitude: 48.8772683, longitude: 9.3964273 };

// ---------------------------------------------------------------------------------------------
// Erwartete Texte: immer der Schlüssel aus I18N.de, damit eine Textänderung den Smoke nicht still bricht
// ---------------------------------------------------------------------------------------------

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Der deutsche Text eines Schlüssels; {x}-Platzhalter werden mit vars gefüllt, fehlende bleiben stehen
function deText(key, vars) {
  const s = I18N.de[key];
  if (typeof s !== 'string' || s === '') { throw new Error('Schlüssel ' + key + ' fehlt in I18N.de'); }
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

// Ein Satz mit Platzhaltern als Muster: der feste Anteil wörtlich, jeder Platzhalter steht für beliebigen Text
function deRx(key) {
  return new RegExp(deText(key).split(/\{\w+\}/).map(escapeRx).join('.+?'));
}

// Satz 1 der Statuszeile mit Uhrzeit: der feste Anfang von statusStamp („Stand: “), danach eine Uhrzeit wie 9:00
// (ohne führende Null, Eintrag zum Schritt „i18n“ in BAUPLAN Abschnitt 16)
const STAMP_WITH_TIME = new RegExp(escapeRx(deText('statusStamp').split('{')[0]) + '.*\\d{1,2}:\\d{2}');

// ---------------------------------------------------------------------------------------------
// Rahmen: jeder Fall sammelt Fehler der Seite; ein nicht abgefangener Fehler lässt ihn scheitern
// ---------------------------------------------------------------------------------------------

const test = base.test.extend({
  errors: [async ({ page }, use) => {
    const seen = { page: [], console: [] };
    page.on('pageerror', (e) => { seen.page.push(String((e && e.message) || e)); });
    page.on('console', (m) => { if (m.type() === 'error') { seen.console.push(m.text()); } });
    await use(seen);
    expect(seen.page, 'nicht abgefangene Fehler der Seite').toEqual([]);
  }, { auto: true }]
});

// ---------------------------------------------------------------------------------------------
// Netz auf Fixtures umleiten
// ---------------------------------------------------------------------------------------------

function fixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function answer(route, body, status) {
  return route.fulfill({
    status: status || 200,
    contentType: 'application/json; charset=utf-8',
    // die Seite fragt von localhost:8619 aus bei fremden Hosts an: ohne diesen Kopf blockiert CORS die Antwort
    headers: { 'access-control-allow-origin': '*' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

// Nur der erste Treffer aus photon-haus.json: S3 entfällt dann (Fall 1, zweiter Durchlauf)
function photonOneHit() {
  const json = JSON.parse(fixtureText('photon-haus.json'));
  json.features = json.features.slice(0, 1);
  return JSON.stringify(json);
}

function isLocal(url) {
  return !/^https?:$/.test(url.protocol) || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

// Leitet die fünf Dienste um und zählt jede Anfrage. net.on.<dienst>(route, n) ist die Antwort und lässt sich
// im Fall austauschen; n zählt ab 1. net.log.<dienst> hält die URLs, net.log.stray alles Fremde ohne Route.
async function mockNet(page) {
  const log = { photon: [], reverse: [], elevation: [], forecast: [], weather: [], alerts: [], stray: [] };
  const net = {
    log,
    count: (kind) => log[kind].length,
    reset: () => { for (const k of Object.keys(log)) { log[k].length = 0; } },
    on: {
      photon: (route) => answer(route, fixtureText('photon-haus.json')),
      reverse: (route) => answer(route, fixtureText('photon-haus.json')),
      elevation: (route) => answer(route, fixtureText('elev.json')),
      forecast: (route) => answer(route, fixtureText('om-frost.json')),
      weather: (route) => answer(route, fixtureText('bs-buerg.json')),
      alerts: (route) => answer(route, fixtureText('alerts-leer.json'))
    }
  };
  // Zuerst eingetragen = zuletzt gefragt: fängt alles Fremde ab, das keine der Routen unten trifft
  await page.route((url) => !isLocal(url), (route) => {
    log.stray.push(route.request().url());
    return route.abort('failed');
  });
  const wire = (glob, kind) => page.route(glob, (route) => {
    log[kind].push(route.request().url());
    return net.on[kind](route, log[kind].length);
  });
  await wire('**/photon.komoot.io/api/**', 'photon');
  await wire('**/photon.komoot.io/reverse**', 'reverse');
  await wire('**/v1/elevation**', 'elevation');
  await wire('**/v1/forecast**', 'forecast');
  await wire('**/api.brightsky.dev/weather**', 'weather');
  await wire('**/api.brightsky.dev/alerts**', 'alerts');
  return net;
}

// Alle drei Dienste brechen ab (Fall 9, Offline); die Zähler gehören je einem Host
async function blockNet(page) {
  const log = { openMeteo: [], brightSky: [], photon: [], stray: [] };
  await page.route((url) => !isLocal(url), (route) => {
    log.stray.push(route.request().url());
    return route.abort('failed');
  });
  const wire = (glob, kind) => page.route(glob, (route) => {
    log[kind].push(route.request().url());
    return route.abort('internetdisconnected');
  });
  await wire('**/api.open-meteo.com/**', 'openMeteo');
  await wire('**/api.brightsky.dev/**', 'brightSky');
  await wire('**/photon.komoot.io/**', 'photon');
  return { log, count: (kind) => log[kind].length };
}

// Die Seitenuhr auf den Fixture-Tag, vor dem ersten goto
async function startClock(page) {
  await page.clock.install({ time: NOW });
}

// Die Seitenuhr eine Sekunde weiterlaufen lassen (jeder bis dahin fällige Zeitgeber feuert, auch ein nachgeschobener)
// und danach eine Runde durch den Seiten-Thread: Was die Zeitgeber anstoßen, ist dann gelaufen. Keine echte
// Wartezeit (Abschnitt 12 „Uhr“); requestAnimationFrame hängt nach clock.install selbst an der Seitenuhr.
async function settle(page) {
  await page.clock.runFor(1000);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

// Schreibt im Seiten-Thread jeden fetch()-Aufruf der App mit, im Augenblick des Aufrufs. Die Route-Zähler kommen
// über den Browser-Prozess später an; für „es kam keine Anfrage“ zählt deshalb dieses Protokoll (vor dem goto).
async function logFetches(page) {
  await page.addInitScript(() => {
    const original = window.fetch;
    const seen = [];
    Object.defineProperty(window, '__hwFetches', { value: seen });
    window.fetch = function () {
      const input = arguments[0];
      seen.push(String(input && typeof input === 'object' && 'url' in input ? input.url : input));
      return original.apply(window, arguments);
    };
  });
}

// Wie viele fetch()-Aufrufe der Seite gingen an eine Adresse, die part enthält
function fetchesTo(page, part) {
  return page.evaluate((p) => window.__hwFetches.filter((u) => u.includes(p)).length, part);
}

// ---------------------------------------------------------------------------------------------
// Bedienung
// ---------------------------------------------------------------------------------------------

async function fillAddress(page) {
  await page.locator('#f-street').fill('Marktstraße 1');
  await page.locator('#f-zip').fill('71364');
  await page.locator('#f-city').fill('Winnenden');
}

// Nach „Suchen“: bei mehreren Treffern S3 und der erste Treffer, bei einem gleich S4
async function pickFirstHit(page) {
  await page.locator('#s-hits:not([hidden]), #s-confirm:not([hidden])').first().waitFor();
  if (await page.locator('#s-hits').isVisible()) { await page.locator('#hitList .hit').first().click(); }
  await expect(page.locator('#s-confirm')).toBeVisible();
}

// Einrichtung mit der Maus bis zum Hauptbildschirm, Daten da (Temperatur steht im Jetzt-Block)
async function setUpByClicks(page) {
  await page.goto('/');
  await page.locator('#btnByAddress').click();
  await fillAddress(page);
  await page.locator('#btnSearch').click();
  await pickFirstHit(page);
  await page.locator('#btnConfirmYes').click();
  await expect(page.locator('#s-profile')).toBeVisible();
  await page.locator('#btnDone').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowTemp')).toContainText('°');
}

// Tab drücken, bis das Element den Fokus hat (Tab-Reihenfolge = Lesereihenfolge)
async function tabTo(page, selector) {
  for (let i = 0; i < 20; i++) {
    const there = await page.evaluate((sel) => !!document.activeElement && document.activeElement.matches(sel), selector);
    if (there) { return; }
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab erreicht ' + selector + ' nicht');
}

// Der Fokus liegt auf der <h2> dieses Bildschirms (nie auf body)
async function expectFocusOnHeading(page, screenId) {
  await expect.poll(() => page.evaluate((id) => {
    const a = document.activeElement;
    return !!a && a.tagName === 'H2' && document.getElementById(id).contains(a);
  }, screenId), { message: 'Fokus auf der <h2> von ' + screenId }).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// Prüfungen, die mehrere Fälle auf jedem Bildschirm brauchen
// ---------------------------------------------------------------------------------------------

// Fall 2: jede sichtbare Tippfläche mindestens 48 × 48 px, kein sichtbarer Knopf mit disabled
async function expectTapSizes(page, where) {
  const bad = [];
  let checked = 0;
  for (const el of await page.locator(TAP_SELECTOR).all()) {
    if (!(await el.isVisible())) { continue; }
    checked += 1;
    const box = await el.boundingBox();
    const info = await el.evaluate((e) => ({ name: e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''), disabled: !!e.disabled }));
    if (!box || box.width < 48 || box.height < 48) {
      bad.push(info.name + ' ist ' + (box ? Math.round(box.width) + ' × ' + Math.round(box.height) : 'ohne Fläche'));
    }
    if (info.disabled) { bad.push(info.name + ' trägt disabled'); }
  }
  // Ein Bildschirm ohne eine einzige sichtbare Tippfläche wäre ein Fehler im Test selbst
  expect(checked, 'geprüfte Tippflächen: ' + where).toBeGreaterThan(0);
  expect(bad, 'Tippflächen: ' + where).toEqual([]);
}

// Fall 3: keine horizontale Scrollleiste. Im Projekt phone (isMobile) weitet Chromium das Layout-Viewport auf zu
// breiten Inhalt aus: innerWidth wächst dann mit (gemessen: 413 statt 360 px bei einem Ortsnamen mit 40 Zeichen im
// Umschalter), und scrollWidth ≤ innerWidth allein sähe nichts. Deshalb zusätzlich gegen die eingestellte Breite.
async function expectNoHorizontalScroll(page, where) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(w.scroll, 'scrollWidth ≤ innerWidth: ' + where).toBeLessThanOrEqual(w.inner);
  const set = page.viewportSize().width;
  expect(w.inner, 'innerWidth ≤ eingestellte Breite ' + set + ' px: ' + where).toBeLessThanOrEqual(set);
  expect(w.scroll, 'scrollWidth ≤ eingestellte Breite ' + set + ' px: ' + where).toBeLessThanOrEqual(set);
}

// Fall 5: genau ein h1, danach keine Stufe übersprungen, keine leere Überschrift
async function expectHeadingOrder(page, where) {
  const heads = await page.evaluate(() => Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .filter((h) => h.getClientRects().length > 0 && getComputedStyle(h).visibility !== 'hidden')
    .map((h) => ({ level: Number(h.tagName.charAt(1)), text: h.textContent.trim() })));
  expect(heads.filter((h) => h.level === 1), 'genau ein h1: ' + where).toHaveLength(1);
  expect(heads[0].level, 'die erste Überschrift ist das h1: ' + where).toBe(1);
  for (let i = 1; i < heads.length; i++) {
    expect(heads[i].level, 'Stufe von „' + heads[i].text + '“ springt: ' + where).toBeLessThanOrEqual(heads[i - 1].level + 1);
  }
  expect(heads.filter((h) => h.text === ''), 'leere Überschrift: ' + where).toEqual([]);
}

// Geht alle Bildschirme der Einrichtung, den Hauptbildschirm und die Einstellungen durch und ruft check(Name) auf jedem auf
async function walkScreens(page, net, check) {
  const seen = [];
  const visit = async (name) => { seen.push(name); await check(name); };
  await page.goto('/');
  await expect(page.locator('#s-welcome')).toBeVisible();
  await visit('S1 Start');

  await page.locator('#btnByAddress').click();
  await expect(page.locator('#s-address')).toBeVisible();
  await visit('S2 Adresse');

  await page.locator('#btnSearch').click();
  await expect(page.locator('#err-address')).toContainText(deText('errNeedPlace'));
  await visit('S2 mit Fehlerzeile (Ort fehlt)');

  await fillAddress(page);
  const hits = net.on.photon;
  net.on.photon = (route) => answer(route, fixtureText('photon-leer.json'));
  await page.locator('#btnSearch').click();
  await expect(page.locator('#err-address')).toContainText(deText('errNoHit'));
  await expect(page.locator('#btnCityOnly')).toBeVisible();
  await visit('S2 mit Fehlerzeile (nichts gefunden)');

  net.on.photon = hits;
  await page.locator('#btnSearch').click();
  await expect(page.locator('#s-hits')).toBeVisible();
  await visit('S3 Treffer');

  await page.locator('#hitList .hit').first().click();
  await expect(page.locator('#s-confirm')).toBeVisible();
  await visit('S4 Bestätigen');

  await page.locator('#btnElevChange').click();
  await expect(page.locator('#f-elev')).toBeVisible();
  await visit('S4 mit Höhenfeld');

  await page.locator('#btnConfirmYes').click();
  await expect(page.locator('#s-profile')).toBeVisible();
  await visit('S5 Heizart');

  await page.locator('#btnDone').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await visit('Hauptbildschirm');

  await page.locator('#settingsBtn').click();
  await expect(page.locator('#s-settings')).toBeVisible();
  await visit('Einstellungen');
  // alle zehn Stellen wurden geprüft, kein Zweig hat sie übersprungen
  expect(seen, 'geprüfte Bildschirme').toHaveLength(10);
}

// ---------------------------------------------------------------------------------------------
// Fälle
// ---------------------------------------------------------------------------------------------

test('Fall 1: Einrichtung nur mit der Tastatur, mehrere Treffer', async ({ page }) => {
  await mockNet(page);
  await startClock(page);
  await page.goto('/');

  // S1 hat keinen Zähler
  await expect(page.locator('#s-welcome')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText('');
  await tabTo(page, '#btnByAddress');
  await page.keyboard.press('Enter');

  // S2: Enter in Straße und PLZ springt weiter, Enter im Ortsfeld sucht
  await expect(page.locator('#s-address')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 1, of: 4 }));
  await expectFocusOnHeading(page, 's-address');
  await tabTo(page, '#f-street');
  await page.keyboard.type('Marktstraße 1');
  await page.keyboard.press('Enter');
  await tabTo(page, '#f-zip');
  await page.keyboard.type('71364');
  await page.keyboard.press('Enter');
  await tabTo(page, '#f-city');
  await page.keyboard.type('Winnenden');
  await page.keyboard.press('Enter');

  // S3: der erste Treffer mit der Leertaste
  await expect(page.locator('#s-hits')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 2, of: 4 }));
  await expectFocusOnHeading(page, 's-hits');
  await tabTo(page, '#hitList .hit');
  await page.keyboard.press('Space');

  // S4: „Ja, das stimmt“ mit Enter
  await expect(page.locator('#s-confirm')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 3, of: 4 }));
  await expectFocusOnHeading(page, 's-confirm');
  await tabTo(page, '#btnConfirmYes');
  await page.keyboard.press('Enter');

  // S5: „Fertig“ mit der Leertaste
  await expect(page.locator('#s-profile')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 4, of: 4 }));
  await expectFocusOnHeading(page, 's-profile');
  await tabTo(page, '#btnDone');
  await page.keyboard.press('Space');

  // Hauptbildschirm: Fokus auf der Überschrift des Jetzt-Blocks, Temperatur, Handlungssatz mit Uhrzeit
  await expect(page.locator('#s-main')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement === document.querySelector('section#now h2')),
    { message: 'Fokus auf section#now h2' }).toBe(true);
  await expect(page.locator('#setupStep')).toHaveText('');
  await expect(page.locator('#nowTemp')).toContainText('°');
  await expect(page.locator('#verdictAction')).toContainText(/\d{1,2}:\d{2}/);
  // bis M4 schreibt apply() die Sprache nicht in den Speicher
  expect(await page.evaluate(() => localStorage.getItem('hw:lang'))).toBeNull();
});

test('Fall 1: Einrichtung mit nur einem Treffer, Zurück führt zu S2 mit gefüllten Feldern', async ({ page }) => {
  const net = await mockNet(page);
  net.on.photon = (route) => answer(route, photonOneHit());
  await startClock(page);
  await page.goto('/');

  await tabTo(page, '#btnByAddress');
  await page.keyboard.press('Enter');
  await expect(page.locator('#s-address')).toBeVisible();
  await tabTo(page, '#f-street');
  await page.keyboard.type('Marktstraße 1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('71364');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Winnenden');
  await tabTo(page, '#btnSearch');
  await page.keyboard.press('Space');

  // S3 entfällt, der Zähler in S4 bleibt „3 von 4“
  await expect(page.locator('#s-confirm')).toBeVisible();
  await expect(page.locator('#s-hits')).toBeHidden();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 3, of: 4 }));
  await expectFocusOnHeading(page, 's-confirm');

  await tabTo(page, '#btnConfirmNo');
  await page.keyboard.press('Enter');
  await expect(page.locator('#s-address')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 1, of: 4 }));
  await expectFocusOnHeading(page, 's-address');
  await expect(page.locator('#f-street')).toHaveValue('Marktstraße 1');
  await expect(page.locator('#f-zip')).toHaveValue('71364');
  await expect(page.locator('#f-city')).toHaveValue('Winnenden');
  expect(net.count('photon')).toBe(1);
});

test('Fall 2: jede Tippfläche ist mindestens 48 × 48 px, kein Knopf trägt disabled', async ({ page }) => {
  const net = await mockNet(page);
  await startClock(page);
  await walkScreens(page, net, (where) => expectTapSizes(page, where));
});

test('Fall 3: keine horizontale Scrollleiste, Fußzeilen-Links mit Text und Hinweis (nur de bis M4)', async ({ page }) => {
  const net = await mockNet(page);
  await startClock(page);
  // Bis M4 gibt es nur den Block de und keine Sprachwahl; mit M4 läuft diese Schleife über alle 14 Sprachen
  // und wechselt vor jedem Durchgang per langSelect (B:66, B:67).
  for (const lang of ['de']) {
    await walkScreens(page, net, async (where) => {
      await expectNoHorizontalScroll(page, lang + ', ' + where);
      // Die Fußzeile sieht auf jedem Bildschirm gleich aus: drei Links, jeder mit Text und Hinweis „öffnet extern“
      const links = page.locator('footer a[href^="http"]');
      await expect(links, 'drei Links in der Fußzeile: ' + lang + ', ' + where).toHaveCount(3);
      for (const a of await links.all()) {
        const shown = (await a.locator('span[data-i18n]:not(.visually-hidden)').textContent()).trim();
        expect(shown, 'sichtbarer Linktext: ' + lang + ', ' + where).not.toBe('');
        const hint = (await a.locator('.visually-hidden').textContent()).trim();
        expect(hint, 'versteckter Hinweis: ' + lang + ', ' + where).not.toBe('');
      }
    });
  }
});

test('Fall 4: keine Konsolenfehler im ganzen Durchlauf', async ({ page, errors }) => {
  const net = await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);
  // „Neu laden“ und ein Neustart der Seite, dann läuft auch der Service Worker mit
  await page.locator('#reload').click();
  await expect(page.locator('#reload')).not.toHaveAttribute('aria-disabled', 'true');
  await page.reload();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  expect(errors.console, 'console.error').toEqual([]);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

test('Fall 5: ein h1, keine übersprungene Überschriftenstufe', async ({ page }) => {
  const net = await mockNet(page);
  await startClock(page);
  await walkScreens(page, net, (where) => expectHeadingOrder(page, where));
});

test.describe('Fall 6: Fehlerwege enden in einem Knopf', () => {
  test('Ort und PLZ leer, nichts gefunden, kein Netz, Photon bittet um Pause', async ({ page }) => {
    const net = await mockNet(page);
    await logFetches(page);
    await startClock(page);
    await page.goto('/');
    await page.locator('#btnByAddress').click();
    await expect(page.locator('#s-address')).toBeVisible();

    // Ort und PLZ leer: Satz im Alert, kein Netzaufruf, Fokus im Ortsfeld
    await page.locator('#btnSearch').click();
    await expect(page.locator('#err-address')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#err-address')).toContainText(deText('errNeedPlace'));
    expect(net.count('photon')).toBe(0);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('f-city');

    // nichts gefunden: Felder bleiben gefüllt, „Nur den Ort suchen“ ist der Ausweg
    await fillAddress(page);
    net.on.photon = (route) => answer(route, fixtureText('photon-leer.json'));
    await page.locator('#btnSearch').click();
    await expect(page.locator('#err-address')).toContainText(deText('errNoHit'));
    await expect(page.locator('#f-street')).toHaveValue('Marktstraße 1');
    await expect(page.locator('#f-zip')).toHaveValue('71364');
    await expect(page.locator('#f-city')).toHaveValue('Winnenden');
    await expect(page.locator('#btnCityOnly')).toBeVisible();
    await expect(page.locator('#btnCityOnly')).toHaveText(deText('btnCityOnly'));
    expect(net.count('photon')).toBe(1);

    // kein Netz: Satz und „Noch einmal versuchen“
    net.on.photon = (route) => route.abort();
    await page.locator('#btnSearch').click();
    await expect(page.locator('#err-address')).toContainText(deText('errOfflineSearch'));
    await expect(page.locator('#btnAddrRetry')).toBeVisible();
    await expect(page.locator('#btnAddrRetry')).toHaveText(deText('btnRetry'));

    // Photon bittet um Pause (429): Satz und Knopf, aber kein automatischer Wiederholungsversuch
    net.reset();
    net.on.photon = (route) => route.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, body: '' });
    await page.locator('#btnAddrRetry').click();
    await expect(page.locator('#err-address')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#err-address')).toContainText(deText('errSearchRejected'));
    await expect(page.locator('#btnAddrRetry')).toBeVisible();
    expect(net.count('photon')).toBe(1);
    const asked = await fetchesTo(page, 'photon.komoot.io/api');
    expect(asked, 'das Protokoll sieht die Photon-Aufrufe der Seite').toBeGreaterThanOrEqual(1);
    await page.clock.fastForward(61000);
    await settle(page);
    expect(await fetchesTo(page, 'photon.komoot.io/api'), 'die Seite fragt Photon nicht von selbst erneut').toBe(asked);
    expect(net.count('photon'), 'Photon wird nicht von selbst wiederholt').toBe(1);
  });

  test('Höhe nicht ermittelbar: S4 sagt es, „Ja, das stimmt“ führt weiter zu S5', async ({ page }) => {
    const net = await mockNet(page);
    net.on.elevation = (route) => answer(route, fixtureText('elev-400.json'), 400);
    await startClock(page);
    await page.goto('/');
    await page.locator('#btnByAddress').click();
    await fillAddress(page);
    await page.locator('#btnSearch').click();
    await pickFirstHit(page);
    await expect(page.locator('#c-elevVal')).toHaveText(deText('setupElevUnknown'));
    await page.locator('#btnConfirmYes').click();
    await expect(page.locator('#s-profile')).toBeVisible();
    expect(net.count('elevation')).toBe(1);
  });

  test('Standort ohne Adresse: S4 zeigt „Dein Standort“ und die gerundeten Koordinaten', async ({ page, context }) => {
    const net = await mockNet(page);
    net.on.reverse = (route) => answer(route, fixtureText('photon-reverse-leer.json'));
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation(HOME);
    await startClock(page);
    await page.goto('/');
    await page.locator('#btnByLocation').click();
    await expect(page.locator('#s-confirm')).toBeVisible();
    await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 1, of: 2 }));
    await expect(page.locator('#c-label')).toHaveText(deText('setupMyPlace'));
    await expect(page.locator('#c-line2')).toHaveText('48,877 / 9,396');
    expect(net.count('reverse')).toBe(1);
    expect(net.count('photon')).toBe(0);
  });
});

test.describe('Fall 7: nur gerundete Koordinaten, nie Straße oder PLZ (DoD 5)', () => {
  // Alles, was nach der Adresssuche das Gerät verlässt: Höhe, Open-Meteo, Bright Sky
  function afterSearch(net) {
    return [].concat(net.log.elevation, net.log.forecast, net.log.weather, net.log.alerts);
  }

  function expectRounded(urls, latName, lonName, what) {
    expect(urls.length, what + ': mindestens eine Anfrage').toBeGreaterThan(0);
    for (const u of urls) {
      const q = new URL(u).searchParams;
      expect(q.get(latName), what + ' ' + latName + ' in ' + u).toMatch(COORD);
      expect(q.get(lonName), what + ' ' + lonName + ' in ' + u).toMatch(COORD);
    }
  }

  test('Adresse: Photon genau einmal, danach keine Straße und keine PLZ in einer Anfrage', async ({ page }) => {
    const net = await mockNet(page);
    await startClock(page);
    await setUpByClicks(page);
    await expect.poll(() => net.count('forecast')).toBeGreaterThanOrEqual(1);
    await expect.poll(() => net.count('weather')).toBeGreaterThanOrEqual(1);

    expect(net.count('photon'), 'eine Suche = ein Aufruf bei Photon').toBe(1);
    expect(net.count('reverse')).toBe(0);
    expect(net.count('elevation')).toBeGreaterThanOrEqual(1);
    for (const u of afterSearch(net)) {
      expect(decodeURIComponent(u), 'Anfrage nach der Suche').not.toMatch(/Marktstra|71364|Winnenden/i);
    }
    expectRounded(net.log.elevation, 'latitude', 'longitude', 'Höhe');
    expectRounded(net.log.forecast, 'latitude', 'longitude', 'Open-Meteo');
    expectRounded(net.log.weather, 'lat', 'lon', 'Bright Sky Wetter');
    expectRounded(net.log.alerts, 'lat', 'lon', 'Bright Sky Warnungen');
    expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  });

  test('Standort: Reverse genau einmal, Suche gar nicht, die rohe Position verlässt das Gerät nie', async ({ page, context }) => {
    const net = await mockNet(page);
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation(HOME);
    await startClock(page);

    await page.goto('/');
    await page.locator('#btnByLocation').click();
    await expect(page.locator('#s-confirm')).toBeVisible();
    await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 1, of: 2 }));
    await page.locator('#btnConfirmYes').click();
    await expect(page.locator('#s-profile')).toBeVisible();
    await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 2, of: 2 }));
    await page.locator('#btnDone').click();
    await expect(page.locator('#nowTemp')).toContainText('°');
    await expect.poll(() => net.count('weather')).toBeGreaterThanOrEqual(1);

    expect(net.count('reverse'), 'Photon reverse genau einmal').toBe(1);
    expect(net.count('photon'), 'keine Adresssuche').toBe(0);
    expectRounded(net.log.reverse, 'lat', 'lon', 'Reverse');
    expectRounded(net.log.elevation, 'latitude', 'longitude', 'Höhe');
    expectRounded(net.log.forecast, 'latitude', 'longitude', 'Open-Meteo');
    expectRounded(net.log.weather, 'lat', 'lon', 'Bright Sky Wetter');
    expectRounded(net.log.alerts, 'lat', 'lon', 'Bright Sky Warnungen');
    // Die ungerundete Position (48,8772683 / 9,3964273) steht in keiner einzigen URL
    const all = [].concat(net.log.reverse, afterSearch(net));
    for (const u of all) { expect(u, 'ungerundete Position in ' + u).not.toMatch(/48\.8772|9\.3964/); }
    expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  });
});

test('Fall 8: 429 vom Wetterdienst zeigt statusWaiting, nach 60 s kommen die Daten', async ({ page }) => {
  const net = await mockNet(page);
  net.on.forecast = (route, n) => (n === 1
    ? answer(route, { error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' }, 429)
    : answer(route, fixtureText('om-frost.json')));
  await startClock(page);

  await page.goto('/');
  await page.locator('#btnByAddress').click();
  await fillAddress(page);
  await page.locator('#btnSearch').click();
  await pickFirstHit(page);
  await page.locator('#btnConfirmYes').click();
  await page.locator('#btnDone').click();

  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#status')).toContainText(deText('statusWaiting', { s: 60 }));
  await expect(page.locator('#nowTemp')).not.toContainText('°');
  expect(net.count('forecast')).toBe(1);

  await page.clock.fastForward(60000);
  await expect(page.locator('#nowTemp')).toContainText('°');
  await expect(page.locator('#status')).toContainText(STAMP_WITH_TIME);
  await expect(page.locator('#status')).not.toContainText(deRx('statusWaiting'));
  expect(net.count('forecast'), 'genau ein zweiter Versuch').toBe(2);
});

test('Fall 8: wer in der Wartezeit nach dem 429 den Ort wechselt und zurückkommt, sieht wieder statusWaiting mit der Restzeit', async ({ page }) => {
  const net = await mockNet(page);
  // Ort 1 (latitude=48.8) bekommt beim ersten Abruf 429, alle anderen Abrufe bekommen Daten
  let refused = false;
  net.on.forecast = (route) => {
    if (!refused && route.request().url().includes('latitude=48.8&')) {
      refused = true;
      return answer(route, { error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' }, 429);
    }
    return answer(route, fixtureText('om-frost.json'));
  };
  await seedPlaces(page, 2);
  await startClock(page);
  await page.goto('/');
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#status')).toContainText(deText('statusWaiting', { s: 60 }));

  // 20 s später auf Ort 2 und gleich wieder zurück: der Abruf von Ort 1 wartet noch
  await page.clock.fastForward(20000);
  await page.locator('#placeSelect').selectOption('ort00001');
  await expect(page.locator('#nowTemp')).toContainText('°');
  await page.locator('#placeSelect').selectOption('ort00000');
  await expect.poll(() => storedActive(page)).toBe('ort00000');
  await expect(page.locator('#status')).toContainText(deRx('statusWaiting'));
  await expect(page.locator('#status')).not.toContainText(deText('statusWaiting', { s: 60 }));
  await expect(page.locator('#status')).not.toContainText(deText('statusLoading'));
  // die Zahl im Wartesatz (Satz 1 „Stand: …“ trägt selbst Ziffern)
  const waitRx = new RegExp(escapeRx(deText('statusWaiting').split('{s}')[0]) + '(\\d+)');
  const left = Number(waitRx.exec(await page.locator('#status').textContent())[1]);
  expect(left, 'Restzeit in Sekunden').toBeGreaterThan(30);
  expect(left).toBeLessThanOrEqual(40);

  // nach der Wartezeit kommt der zweite Versuch, die Daten erscheinen unter Ort 1
  await page.clock.fastForward(60000);
  await expect(page.locator('#status')).toContainText(STAMP_WITH_TIME);
  await expect(page.locator('#status')).not.toContainText(deRx('statusWaiting'));
  await expect(page.locator('#nowTemp')).toContainText('°');
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

test('Fall 9: Offline-Stand aus dem Service-Worker-Cache, Selbstheilung nach fremder Löschung', async ({ page, context }) => {
  const net = await mockNet(page);
  await startClock(page);

  // (a) ein Geschwister-Werkzeug hat auf demselben Origin schon einen Cache angelegt; eine Datei ohne Service
  // Worker öffnen (im frischen Kontext ist noch keiner registriert), dort den Cache vorab füllen
  await page.goto('/tests/fixtures/elev.json');
  await page.evaluate(() => caches.open('bigday-v6').then((c) => c.put('/bigday/probe', new Response('x'))));
  await setUpByClicks(page);

  // (b) die Hülle liegt im eigenen Cache, der fremde ist unberührt
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  expect(await page.evaluate(() => caches.has('bigday-v6')), 'fremder Cache bleibt').toBe(true);
  const own = (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('heizwarte-'));
  expect(own, 'genau eine eigene Hülle').toHaveLength(1);
  expect(own[0]).toMatch(/^heizwarte-v\d+$/);

  // (c) Geschwister-Löschung nachstellen: alle heizwarte-Caches weg, Neustart mit Netz, die Hülle holt sich nach
  await page.evaluate(async () => {
    for (const k of await caches.keys()) { if (k.startsWith('heizwarte-')) { await caches.delete(k); } }
  });
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => caches.match('./index.html').then((r) => !!r)),
    { message: 'Hülle heilt sich selbst' }).toBe(true);
  expect(await page.evaluate(() => caches.has('bigday-v6')), 'fremder Cache bleibt').toBe(true);
  await expect(page.locator('#nowTemp')).toContainText('°');

  // (d) Offline: die Fixture-Routen weg, alle drei Dienste brechen ab, dann Netz aus und Neustart
  await page.unrouteAll();
  const blocked = await blockNet(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await expect(page.locator('#status')).toContainText(STAMP_WITH_TIME);
  await expect(page.locator('#status')).toContainText(deText('statusOffline'));
  // die App versucht den Abruf trotzdem (bei jedem Start neu laden)
  await expect.poll(() => blocked.count('openMeteo')).toBeGreaterThanOrEqual(1);
  expect(net.log.stray, 'Anfragen ohne Route (vor dem Offline-Schritt)').toEqual([]);
  expect(blocked.log.stray, 'Anfragen ohne Route (offline)').toEqual([]);
});

test('Fall 10: visibilitychange ruft erneut ab, aber nicht innerhalb von 60 Sekunden', async ({ page }) => {
  const net = await mockNet(page);
  await logFetches(page);
  await startClock(page);
  await setUpByClicks(page);
  const first = net.count('forecast');
  const firstInPage = await fetchesTo(page, '/v1/forecast');
  expect(firstInPage, 'das Protokoll sieht die Abrufe der Seite').toBeGreaterThanOrEqual(1);
  expect(first).toBeGreaterThanOrEqual(1);

  const dispatch = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  // innerhalb der 60 Sekunden bleibt es beim einen Abruf (Flatterschutz)
  await dispatch();
  await settle(page);
  expect(await fetchesTo(page, '/v1/forecast'), 'kein Abruf innerhalb von 60 s (Seite)').toBe(firstInPage);
  expect(net.count('forecast'), 'kein Abruf innerhalb von 60 s').toBe(first);

  // danach löst der Wechsel zurück in die App einen neuen Abruf aus
  await page.clock.fastForward(61000);
  await dispatch();
  await expect.poll(() => net.count('forecast')).toBe(first + 1);
  await expect(page.locator('#reload')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#nowTemp')).toContainText('°');
});

// ---------------------------------------------------------------------------------------------
// Fall 11: „Mehr anzeigen“ (BAUPLAN Abschnitt 8, Blöcke 8 bis 10; Entscheidung 9): Kurve (bis jetzt ein Gerüst) und
// Lüften liegen hinter einem großen Knopf, die Wahl bleibt in hw:more
// ---------------------------------------------------------------------------------------------

// Der gespeicherte Wert von hw:more (roher JSON-Text oder null)
function storedMore(page) {
  return page.evaluate(() => localStorage.getItem('hw:more'));
}

// Der Fokus liegt auf dem Knopf „Mehr/Weniger anzeigen“ (Disclosure-Muster)
async function expectFocusOnMore(page) {
  await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id), {
    message: 'Fokus auf #more'
  }).toBe('more');
}

// Die Kurve ist gezeichnet (Fall 11, BAUPLAN Abschnitt 8 Block 9): 72 Stunden als SVG mit Verlauf, Nachtbändern und
// Tiefstwerten, der Satz darunter ist zugleich das aria-label des Bildes, die Legende nennt Hauptprognose und Regen,
// die Farbskala trägt ihren Verlauf. Ohne passende MOSMIX-Stunden steht statt der zweiten Meinung chartMosFar.
async function expectChartDrawn(page) {
  const svg = page.locator('#chartSvg');
  await expect(svg).toHaveAttribute('viewBox', /^0 0 \d+ \d+$/);
  await expect(svg.locator('linearGradient#tg')).toHaveCount(1);
  await expect(svg.locator('path.chart-line')).toHaveCount(1);
  expect(await svg.locator('.chart-night').count(), 'mindestens drei Nachtbänder').toBeGreaterThanOrEqual(3);
  expect(await svg.locator('.chart-nightmin').count(), 'Tiefstwerte der Nächte').toBeGreaterThanOrEqual(2);
  await expect(svg.locator('.chart-now')).toHaveCount(1);
  await expect(svg.locator('text', { hasText: deText('chartNow') })).toHaveCount(1);
  await expect(svg.locator('text', { hasText: deText('dayToday') })).toHaveCount(1);
  await expect(svg.locator('text', { hasText: deText('dayTomorrow') })).toHaveCount(1);
  // Stundenmarken in der Uhrzeitform der Sprache (de: „12:00“, nie die nackte Zahl), Review M3 Runde 3, N2 und N9
  expect(await svg.locator('text').filter({ hasText: /^\d{1,2}:00$/ }).count(), 'Stundenmarken als Uhrzeit').toBeGreaterThanOrEqual(3);
  const summary = page.locator('#chartSummary');
  await expect(summary).toHaveText(deRx('chartSummary'));
  await expect(summary).toContainText('°');
  await expect(svg).toHaveAttribute('aria-label', (await summary.textContent()).trim());
  const legend = await page.locator('#chartLegend p').allTextContents();
  expect(legend[0]).toBe(deText('chartLegendIcon'));
  expect(legend[legend.length - 1]).toBe(deText('chartLegendRain'));
  expect(legend.length === 3 && (legend[1] === deText('chartMosFar') || deRx('chartLegendMos').test(legend[1])), 'zweite Zeile: ' + legend[1]).toBe(true);
  // Farbskala: der Verlauf steht als Hintergrund, die sechs Marken darunter
  expect(await page.locator('#scale').evaluate((e) => getComputedStyle(e).backgroundImage)).toMatch(/linear-gradient/);
  await expect(page.locator('.scale-labels span')).toHaveCount(6);
}

// Die Kurve ist so breit gezeichnet wie ihre Spalte: viewBox-Breite = Breite von .chart-wrap, geklemmt auf 320 bis 720.
// Nie die Rückfallbreite 720 eines verborgenen Hauptbildschirms (Review M3 Runde 3, Befund 1 und 2: am Handy stauchte
// das die Zeichnung auf etwa 328 px, die Schrift auf etwa 5 px)
async function expectChartFitsColumn(page, where) {
  const width = await page.locator('.chart-wrap').evaluate((e) => Math.round(Math.min(720, Math.max(320, e.clientWidth))));
  await expect(page.locator('#chartSvg'), where).toHaveAttribute('viewBox', new RegExp('^0 0 ' + width + ' \\d+$'));
}

test('Fall 11: „Mehr anzeigen“ klappt Kurve und Lüften auf, bleibt nach dem Neuladen offen, „Weniger anzeigen“ löscht hw:more', async ({ page, errors }) => {
  const net = await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);

  const more = page.locator('#more');
  const chart = page.locator('#chart');
  const air = page.locator('#air');

  // zu Beginn: ein großer Knopf über die ganze Breite, beide Blöcke zu, nichts gespeichert
  await expect(more).toBeVisible();
  await expect(more).toHaveText(deText('btnMore'));
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(chart).toBeHidden();
  await expect(air).toBeHidden();
  expect(await storedMore(page), 'zu Beginn kein hw:more').toBeNull();
  const box = await more.boundingBox();
  const column = await page.locator('#now').boundingBox();
  expect(box.height, 'Knopf mindestens 56 px hoch').toBeGreaterThanOrEqual(56);
  expect(Math.abs(box.width - column.width), 'Knopf in voller Breite des Inhalts').toBeLessThanOrEqual(1);

  // Klick: Kurve (Gerüst) und Lüften sind da, der Knopf heißt „Weniger anzeigen“, der Fokus bleibt auf ihm
  await more.click();
  await expect(more).toHaveText(deText('btnLess'));
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(chart).toBeVisible();
  await expect(air).toBeVisible();
  await expect(page.locator('#chart h2')).toHaveText(deText('chartTitle'));
  await expect(page.locator('#chartSvg')).toHaveAttribute('role', 'img');
  await expectChartDrawn(page);
  await expect(page.locator('#air h2')).toHaveText(deText('airTitle'));
  expect(await storedMore(page)).toBe('true');
  await expectFocusOnMore(page);

  // Lüften: die Fenster als Sätze, genau eines mit „Bestes Fenster“ im Text, darunter der Erklärsatz
  const slots = page.locator('#airList li');
  await expect(slots).toHaveCount(4);
  for (const text of await slots.locator('.air-text').allTextContents()) { expect(text).toMatch(deRx('airSlot')); }
  await expect(page.locator('#airList li.best')).toHaveCount(1);
  await expect(page.locator('#airList li.best .air-tag')).toHaveText(deText('airBest'));
  await expect(page.locator('#airList .air-tag')).toHaveCount(1);
  await expect(page.locator('#airNone')).toBeHidden();
  await expect(page.locator('#airNote')).toHaveText(deRx('airNote'));

  // Offen bleibt die Seite bedienbar: Tippflächen, Scrollleiste, Überschriften
  await expectTapSizes(page, 'Hauptbildschirm mit Mehr anzeigen');
  await expectNoHorizontalScroll(page, 'Hauptbildschirm mit Mehr anzeigen');
  await expectHeadingOrder(page, 'Hauptbildschirm mit Mehr anzeigen');
  await expectChartFitsColumn(page, 'nach dem Aufklappen');

  // Einstellungen und „Zurück“: render() läuft, solange der Hauptbildschirm verborgen ist (beim Zurückkehren und bei
  // einem Abruf im Hintergrund); die Kurve trägt danach trotzdem die Breite ihrer Spalte, nicht 720
  await openSettings(page);
  const vorher = net.count('forecast');
  await page.clock.fastForward(61000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => net.count('forecast'), { message: 'Abruf, während die Einstellungen offen sind' }).toBe(vorher + 1);
  await settle(page);
  await page.locator('#btnSettingsBack').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(chart).toBeVisible();
  await expectChartFitsColumn(page, 'nach „Zurück“ aus den Einstellungen');
  await expectChartDrawn(page);
  await expectNoHorizontalScroll(page, 'Kurve nach „Zurück“');

  // Neuladen: bleibt offen (hw:more), auch der Knopf trägt den Zustand
  await page.reload();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await expect(more).toHaveText(deText('btnLess'));
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expectChartFitsColumn(page, 'nach dem Neuladen mit hw:more');
  await expect(chart).toBeVisible();
  await expect(air).toBeVisible();
  await expect(slots).toHaveCount(4);

  // Ein Abruf im Hintergrund zeichnet neu, ohne den Zustand anzutasten
  await page.clock.fastForward(61000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => net.count('forecast')).toBeGreaterThanOrEqual(2);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(chart).toBeVisible();

  // „Weniger anzeigen“ mit der Tastatur: beide Blöcke zu, der Schlüssel weg, der Fokus bleibt
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveText(deText('btnMore'));
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(chart).toBeHidden();
  await expect(air).toBeHidden();
  expect(await storedMore(page), 'hw:more fehlt nach „Weniger anzeigen“').toBeNull();
  await expectFocusOnMore(page);

  // Neuladen: bleibt zu
  await page.reload();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await expect(more).toHaveText(deText('btnMore'));
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(chart).toBeHidden();
  await expect(air).toBeHidden();
  expect(await storedMore(page)).toBeNull();
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  expect(errors.console, 'console.error').toEqual([]);
});

test('Fall 11: ist die Außenluft zu feucht, steht airNone statt der Fenster; der Erklärsatz bleibt', async ({ page, errors }) => {
  const net = await mockNet(page);
  const om = JSON.parse(fixtureText('om-lueften.json'));
  om.hourly.dew_point_2m = om.hourly.dew_point_2m.map((x) => x + 20);
  net.on.forecast = (route) => answer(route, om);
  await startClock(page);
  await setUpByClicks(page);

  await page.locator('#more').click();
  await expect(page.locator('#air')).toBeVisible();
  await expect(page.locator('#airList li')).toHaveCount(0);
  await expect(page.locator('#airNone')).toHaveText(deText('airNone'));
  await expect(page.locator('#airNote')).toHaveText(deRx('airNote'));
  await expectFocusOnMore(page);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  expect(errors.console, 'console.error').toEqual([]);
});

test('Fall 11: nahe Station → zweite Meinung in Legende und gestrichelter Linie; Zeiger und Finger öffnen den Kasten; Größenänderung zeichnet nur die Kurve neu', async ({ page, errors }) => {
  const net = await mockNet(page);
  // Bright Sky: zwei MOSMIX-Werte in aufeinanderfolgenden Stunden des Fensters (14.01., 12:00 und 13:00 Berlin),
  // Station BACKNANG in 7,7 km (ein einzelner Wert zeichnet keine Linie)
  net.on.weather = (route) => answer(route, bsInWindow('bs-buerg.json'));
  await startClock(page);
  await setUpByClicks(page);
  await page.locator('#more').click();
  await expect(page.locator('#chart')).toBeVisible();

  const svg = page.locator('#chartSvg');
  const tip = page.locator('#chartTip');
  const legend = page.locator('#chartLegend p');
  await expect(legend).toHaveCount(3);
  await expect(legend.nth(1)).toHaveText(deText('chartLegendMos', { station: 'BACKNANG', height: 291 }));
  await expect(svg.locator('path.chart-mos')).toHaveCount(1);
  // die Linie ist wirklich ein Strich (mit „L“ und Länge), nicht nur ein Startpunkt „M x y“
  await expect(svg.locator('path.chart-mos')).toHaveAttribute('d', /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  expect(await svg.locator('path.chart-mos').evaluate((p) => p.getTotalLength()), 'Länge der gestrichelten Linie').toBeGreaterThan(0);
  await expect(page.locator('#chartLegend .legend-swatch')).toHaveCount(3);
  await expect(tip).toBeHidden();

  // Zeiger (Maus): der Kasten zeigt die nächste Stunde, Linie und Punkt erscheinen; weg vom Bild verschwindet alles
  await svg.hover({ position: { x: 150, y: 100 } });
  await expect(tip).toBeVisible();
  await expect(tip.locator('.chart-tip-head')).toContainText(':');
  await expect(tip.locator('b')).toContainText('°');
  await expect(tip.locator('.chart-tip-feels')).toHaveText(deRx('nowFeels'));
  await expect(tip).toContainText(deText('chartTipRain').split(' {')[0]);
  await expect(svg.locator('#chartCur')).toHaveAttribute('opacity', '0.5');
  await expect(svg.locator('#chartDot')).toHaveAttribute('opacity', '1');
  const inside = await tip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const b = el.parentElement.getBoundingClientRect();
    return r.left >= b.left - 1 && r.right <= b.right + 1;
  });
  expect(inside, 'der Kasten bleibt im Bild').toBe(true);
  await page.mouse.move(2, 2);
  await expect(tip).toBeHidden();
  await expect(svg.locator('#chartCur')).toHaveAttribute('opacity', '0');

  // Finger (nur im Handy-Projekt): Tippen zeigt den Kasten, er bleibt nach dem Loslassen; ein Tippen daneben schließt ihn
  if (test.info().project.name === 'phone') {
    await svg.tap({ position: { x: 200, y: 100 } });
    await expect(tip).toBeVisible();
    await page.locator('#chart h2').tap();
    await expect(tip).toBeHidden();
  }

  // Größenänderung: nur die Kurve passt ihre Breite an (viewBox = Breite der Spalte, 320 bis 720), der Rest bleibt stehen
  const widthOf = () => page.locator('.chart-wrap').evaluate((e) => Math.round(Math.min(720, Math.max(320, e.clientWidth))));
  const viewBoxOf = () => svg.getAttribute('viewBox');
  expect(await viewBoxOf()).toMatch(new RegExp('^0 0 ' + (await widthOf()) + ' \\d+$'));
  const before = await viewBoxOf();
  const original = page.viewportSize();
  const fetches = net.count('forecast');
  await page.setViewportSize({ width: 600, height: original.height });
  await settle(page);
  await expect.poll(viewBoxOf).not.toBe(before);
  expect(await viewBoxOf()).toMatch(new RegExp('^0 0 ' + (await widthOf()) + ' \\d+$'));
  await expect(page.locator('#more')).toHaveAttribute('aria-expanded', 'true');
  expect(net.count('forecast'), 'die Größenänderung ruft nichts ab').toBe(fetches);
  await expectNoHorizontalScroll(page, 'Kurve bei 600 px');
  await page.setViewportSize(original);
  await settle(page);
  await expect.poll(viewBoxOf).toBe(before);
  await expectNoHorizontalScroll(page, 'Kurve bei ' + original.width + ' px');
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  expect(errors.console, 'console.error bei offener Kurve, Zeiger und Kasten').toEqual([]);
});

test('Fall 11: ohne MOSMIX-Stunden im Fenster steht chartMosFar; im hellen Theme trägt die Kurve die hellen Farben', async ({ page, errors }) => {
  const net = await mockNet(page);
  await startClock(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await setUpByClicks(page);
  await page.locator('#more').click();
  const svg = page.locator('#chartSvg');
  await expect(page.locator('#chartLegend p').nth(1)).toHaveText(deText('chartMosFar'));
  await expect(svg.locator('path.chart-mos')).toHaveCount(0);
  const stops = () => svg.locator('linearGradient#tg stop').first().getAttribute('stop-color');
  const lightness = async () => Number(/oklch\(([\d.]+)%/.exec(await stops())[1]);
  expect(await lightness(), 'dunkel: helle Temperaturfarben (L ≥ 62 %)').toBeGreaterThanOrEqual(62);
  const dark = await page.locator('#scale').evaluate((e) => getComputedStyle(e).backgroundImage);
  // System auf hell: die Kurve und die Skala zeichnen sich neu, mit den dunklen Schriftfarben der hellen Tabelle
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(lightness).toBeLessThanOrEqual(48);
  const light = await page.locator('#scale').evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(light).not.toBe(dark);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  expect(errors.console, 'console.error').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// M3-DoD 7: Warnungen des Deutschen Wetterdienstes nur in Deutschland, zweite Meinung (MOSMIX) nur bei naher Station
// ---------------------------------------------------------------------------------------------

// Photon-Antwort mit genau einem Treffer in Wien (countrycode AT): S3 entfällt, der Ort liegt außerhalb des DWD-Gebiets
function photonWien() {
  const json = JSON.parse(fixtureText('photon-haus.json'));
  const f = json.features[0];
  Object.assign(f.properties, {
    street: 'Stephansplatz', housenumber: '1', locality: 'Innere Stadt', district: 'Innere Stadt', city: 'Wien', county: 'Wien',
    state: 'Wien', country: 'Österreich', postcode: '1010', countrycode: 'AT', extent: [16.3736, 48.2083, 16.3740, 48.2081]
  });
  f.geometry.coordinates = [16.3738, 48.2082];
  json.features = [f];
  return JSON.stringify(json);
}

// Bright Sky aus einer Fixture, mit zwei MOSMIX-Werten in aufeinanderfolgenden Stunden mitten im Fenster (14.01., 12:00
// und 13:00 Berlin): bs-buerg, bs-wien und bs-fern tragen nur eine Stunde vom 11.10.2026, die außerhalb der Wetter-
// Fixtures vom Januar läge, und ein einzelner Wert zeichnet keine Linie (chart.layout braucht zwei). So hängt es allein
// an der Entfernung der Station, ob die zweite Meinung erscheint.
function bsInWindow(name) {
  const bs = JSON.parse(fixtureText(name));
  const first = bs.weather[0];
  first.timestamp = '2026-01-14T11:00:00+00:00';
  first.temperature = 2.5;
  bs.weather = [first, Object.assign({}, first, { timestamp: '2026-01-14T12:00:00+00:00', temperature: 3.0 })];
  return bs;
}

test('DoD 7: ein Ort in Wien fragt keine Warnungen ab, zeigt keinen Warnblock, und die nahe Station zeichnet die zweite Meinung', async ({ page, errors }) => {
  const net = await mockNet(page);
  net.on.photon = (route) => answer(route, photonWien());
  net.on.elevation = (route) => answer(route, { elevation: [171.0] });
  net.on.forecast = (route) => answer(route, fixtureText('om-wien.json'));
  net.on.weather = (route) => answer(route, bsInWindow('bs-wien.json'));
  // Falle: käme die Anfrage trotzdem, läge in Wien ein Sturm vor – und der Block stünde da
  net.on.alerts = (route) => answer(route, fixtureText('alerts-sturm.json'));
  await logFetches(page);
  await startClock(page);
  await setUpByClicks(page);

  const [place] = await storedPlaces(page);
  expect(place.cc, 'Photon meldet Österreich').toBe('AT');
  expect(net.count('forecast')).toBeGreaterThanOrEqual(1);
  const om = new URL(net.log.forecast[0]).searchParams;
  expect(om.get('models'), 'DACH rechnet mit icon_seamless').toBe('icon_seamless');
  expect(om.get('latitude')).toBe('48.208');
  expect(net.count('weather')).toBeGreaterThanOrEqual(1);
  expect(net.log.weather[0], 'Bright Sky rechnet in der Zone der Antwort').toContain('&tz=Europe/Vienna');

  // keine Warnungs-Anfrage, weder an der Route noch im Seiten-Thread; Status outside, kein Block, kein Fehlertext
  expect(net.count('alerts'), 'Anfragen an /alerts').toBe(0);
  expect(await fetchesTo(page, 'api.brightsky.dev/alerts'), 'fetch() an /alerts').toBe(0);
  const cache = await storedCache(page, place.id);
  expect(cache.alertsStatus).toBe('outside');
  expect(cache.alerts).toBeNull();
  await expect(page.locator('#alerts')).toBeHidden();
  await expect(page.locator('#alertUnavailable')).toBeHidden();
  await expect(page.locator('#alertList .alert-item')).toHaveCount(0);
  await expect(page.locator('[role=alert]:visible')).toHaveCount(0);

  // Station WIEN/CITY in 955 m: nah genug, die gestrichelte Linie und ihre Legendenzeile stehen
  expect(cache.mosStation).toEqual({ name: 'WIEN/CITY', height: 171, distance: 955 });
  await page.locator('#more').click();
  await expect(page.locator('#chart')).toBeVisible();
  await expect(page.locator('#chartLegend p')).toHaveCount(3);
  await expect(page.locator('#chartLegend p').nth(1)).toHaveText(deText('chartLegendMos', { station: 'WIEN/CITY', height: 171 }));
  await expect(page.locator('#chartSvg path.chart-mos')).toHaveCount(1);
  await expect(page.locator('#chartSvg path.chart-mos')).toHaveAttribute('d', /L/);
  expect(await page.locator('#chartSvg path.chart-mos').evaluate((p) => p.getTotalLength()), 'Länge der gestrichelten Linie').toBeGreaterThan(0);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  expect(errors.console, 'console.error').toEqual([]);
});

test('DoD 7: liegt die Station 40 km weit weg, gibt es keine MOSMIX-Linie und chartMosFar steht in der Legende', async ({ page, errors }) => {
  const net = await mockNet(page);
  net.on.weather = (route) => answer(route, bsInWindow('bs-fern.json'));
  await startClock(page);
  await setUpByClicks(page);

  // der Ort liegt in Deutschland: die Warnungen werden abgefragt (leer), der Block bleibt trotzdem weg
  const [place] = await storedPlaces(page);
  expect(place.cc).toBe('DE');
  expect(net.count('alerts'), 'in Deutschland wird gefragt').toBeGreaterThanOrEqual(1);
  await expect(page.locator('#alerts')).toBeHidden();

  // die Werte liegen im Fenster, die Station aber 40 km entfernt: ausgeblendet allein wegen der 25-km-Grenze
  const cache = await storedCache(page, place.id);
  expect(cache.mos.length, 'zwei MOSMIX-Werte im Cache').toBe(2);
  expect(cache.mosStation.distance).toBe(40000);
  await page.locator('#more').click();
  await expect(page.locator('#chart')).toBeVisible();
  await expect(page.locator('#chartLegend p')).toHaveCount(3);
  await expect(page.locator('#chartLegend p').nth(1)).toHaveText(deText('chartMosFar'));
  await expect(page.locator('#chartLegend .legend-swatch')).toHaveCount(2);
  await expect(page.locator('#chartSvg path.chart-mos')).toHaveCount(0);
  await expect(page.locator('#chartSvg path.chart-line')).toHaveCount(1);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
  expect(errors.console, 'console.error').toEqual([]);
});

test('DoD 7: meldet der DWD für einen deutschen Ort 404 „not covered“, steht weder ein Warnblock noch ein Fehler da', async ({ page }) => {
  const net = await mockNet(page);
  net.on.alerts = (route) => answer(route, fixtureText('alerts-404-outside.json'), 404);
  await startClock(page);
  await setUpByClicks(page);

  expect(net.count('alerts')).toBeGreaterThanOrEqual(1);
  const [place] = await storedPlaces(page);
  expect(place.cc).toBe('DE');
  const cache = await storedCache(page, place.id);
  expect(cache.alertsStatus, '404 „not covered“ heißt outside, nicht error').toBe('outside');
  expect(cache.alerts).toBeNull();
  await expect(page.locator('#alerts')).toBeHidden();
  await expect(page.locator('#alertUnavailable')).toBeHidden();
  await expect(page.locator('[role=alert]:visible')).toHaveCount(0);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

test('DoD 7: in Deutschland zeigt der Warnblock die Warnung des DWD mit Überschrift und Quelle; ein Abruffehler heißt alertUnavailable', async ({ page }) => {
  const net = await mockNet(page);
  net.on.alerts = (route) => answer(route, fixtureText('alerts-sturm.json'));
  await startClock(page);
  await setUpByClicks(page);

  const alert = JSON.parse(fixtureText('alerts-sturm.json')).alerts[0];
  await expect(page.locator('#alerts')).toBeVisible();
  await expect(page.locator('#alerts h2')).toHaveText(deText('alertTitle'));
  await expect(page.locator('#alertList .alert-item')).toHaveCount(1);
  await expect(page.locator('#alertList .alert-item h3')).toHaveText(alert.headline_de);
  await expect(page.locator('#alertList .alert-item .alert-text').first()).toHaveText(alert.description_de);
  await expect(page.locator('#alertSource')).toBeVisible();
  await expect(page.locator('#alertSource')).toHaveText(deText('alertSource'));
  await expect(page.locator('#alertUnavailable')).toBeHidden();
  const [place] = await storedPlaces(page);
  expect((await storedCache(page, place.id)).alertsStatus).toBe('ok');

  // ein gescheiterter Abruf (500) beim nächsten Start: der Block steht mit dem Hinweis da, ohne Warnungen
  net.on.alerts = (route) => answer(route, { detail: 'Wartung' }, 500);
  await page.reload();
  await expect(page.locator('#alertUnavailable')).toBeVisible();
  await expect(page.locator('#alertUnavailable')).toHaveText(deText('alertUnavailable'));
  await expect(page.locator('#alertList .alert-item')).toHaveCount(0);
  expect((await storedCache(page, place.id)).alertsStatus).toBe('error');
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Fall 12: die Einstellungen (Heizart, Höhe, Stepper, Ortsliste)
// ---------------------------------------------------------------------------------------------

// Gespeicherte Orte aus localStorage (hw:places)
function storedPlaces(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('hw:places') || 'null'));
}

// Die Startzeile der ersten Karte im Fahrplan („Start ab 16:00“) als Minuten seit Mitternacht; die Karten stehen im
// Markup auch dann, wenn der Hauptbildschirm gerade verborgen ist
async function firstStartMinutes(page) {
  const text = await page.locator('#planList li').first().locator('.plan-when').textContent();
  const m = /(\d{1,2}):(\d{2})/.exec(text || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

async function openSettings(page) {
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#s-settings')).toBeVisible();
  await expectFocusOnHeading(page, 's-settings');
}

test('Fall 12: Heizart ändert den Plan, Höhe löst einen neuen Abruf aus, „Zurück“ führt auf #settingsBtn', async ({ page }) => {
  const net = await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);

  // Heizkörper: kurze Aufheizzeit, später Start
  const radiatorStart = await firstStartMinutes(page);
  expect(radiatorStart, 'Startzeile der ersten Nacht mit Heizkörper').not.toBeNull();

  await openSettings(page);
  await expect(page.locator('#s-settings h2')).toHaveText(deText('settingsTitle'));
  await expect(page.locator('#rs-radiator')).toBeChecked();

  // Fußbodenheizung im Estrich: lange Aufheizzeit, der Start rückt vor. Ampel und Fahrplan ziehen entprellt nach,
  // ohne dass die Seite neu lädt oder die Einstellungen verlassen werden.
  await page.locator('#rs-floorScreed').click();
  await expect.poll(async () => radiatorStart - (await firstStartMinutes(page)),
    { message: 'Start der ersten Nacht rückt um mindestens eine Stunde vor' }).toBeGreaterThanOrEqual(60);
  await expect(page.locator('#planHead')).toHaveText(deText('planFor', { profile: deText('profileFloorScreed') }));
  const heat = (await storedPlaces(page))[0].heat;
  expect(heat).toMatchObject({ type: 'floorScreed', leadMin: 3, leadMax: 6, confirmed: true });
  await expect(page.locator('#leadMinOut')).toHaveText(deText('unitHours', { n: '3' }));
  await expect(page.locator('#leadMaxOut')).toHaveText(deText('unitHours', { n: '6' }));

  // Höhe von Hand: Enter speichert und ruft sofort neu ab (auch innerhalb von 60 s), die URL trägt die neue Höhe
  await expect(page.locator('#settingsElevEdit')).toBeHidden();
  await expect(page.locator('#settingsElevVal')).toHaveText(deText('setupElev', { m: 417 }));
  await expect(page.locator('#settingsElevAuto')).toBeVisible();
  const forecasts = net.count('forecast');
  await page.locator('#btnSettingsElev').click();
  await expect(page.locator('#settingsElevInput')).toBeVisible();
  await expect(page.locator('#settingsElevInput')).toBeFocused();
  await page.locator('#settingsElevInput').fill('500');
  await page.keyboard.press('Enter');
  await expect.poll(() => net.count('forecast')).toBe(forecasts + 1);
  expect(net.log.forecast[net.log.forecast.length - 1]).toMatch(/[?&]elevation=500(&|$)/);
  expect((await storedPlaces(page))[0]).toMatchObject({ elev: 500, elevAuto: false });
  await expect(page.locator('#settingsElevVal')).toHaveText(deText('setupElev', { m: 500 }));
  await expect(page.locator('#settingsElevAuto')).toBeHidden();
  await expect(page.locator('#nowTemp')).toContainText('°');

  // Feld leeren: die Höhe wird neu abgefragt (elev.json = 417 m) und gilt wieder als automatisch. Solange die Antwort
  // aussteht, sagt die Anzeige setupElevLoading (wie in S4); die Route hält die Antwort bis zur Prüfung zurück.
  const elevations = net.count('elevation');
  const forecasts2 = net.count('forecast');
  let releaseElev = null;
  const elevGate = new Promise((resolve) => { releaseElev = resolve; });
  net.on.elevation = async (route) => {
    await elevGate;
    return answer(route, fixtureText('elev.json'));
  };
  await page.locator('#settingsElevInput').fill('');
  await page.keyboard.press('Enter');
  await expect.poll(() => net.count('elevation')).toBe(elevations + 1);
  await expect(page.locator('#settingsElevVal')).toHaveText(deText('setupElevLoading'));
  await expect(page.locator('#settingsElevAuto')).toBeHidden();
  expect(net.count('forecast'), 'vor der Antwort kein Abruf').toBe(forecasts2);
  releaseElev();
  await expect.poll(() => net.count('forecast')).toBe(forecasts2 + 1);
  expect(net.log.forecast[net.log.forecast.length - 1]).toMatch(/[?&]elevation=417(&|$)/);
  expect((await storedPlaces(page))[0]).toMatchObject({ elev: 417, elevAuto: true });
  await expect(page.locator('#settingsElevVal')).toHaveText(deText('setupElev', { m: 417 }));
  await expect(page.locator('#settingsElevAuto')).toBeVisible();
  await expect(page.locator('#settingsElevInput')).toHaveValue('417');

  // ungültig wird nicht gespeichert und nicht abgerufen: der Satz steht in der Alert-Zeile unter dem Feld
  const forecasts3 = net.count('forecast');
  await page.locator('#settingsElevInput').fill('99999');
  await page.keyboard.press('Enter');
  await expect(page.locator('#settingsElevErr')).toContainText(deText('errElevRange'));
  await expect(page.locator('#settingsElevInput')).toHaveAttribute('aria-invalid', 'true');
  expect((await storedPlaces(page))[0]).toMatchObject({ elev: 417, elevAuto: true });
  expect(net.count('forecast'), 'kein Abruf bei ungültiger Höhe').toBe(forecasts3);

  // „Zurück“ (unten) → Hauptbildschirm, der Fokus liegt auf dem Knopf, der die Einstellungen geöffnet hat
  await page.locator('#btnSettingsBack2').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#s-settings')).toBeHidden();
  await expect(page.locator('#settingsBtn')).toBeFocused();
  expect(await firstStartMinutes(page)).toBeLessThan(radiatorStart - 59);

  // und oben
  await openSettings(page);
  await page.locator('#btnSettingsBack').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#settingsBtn')).toBeFocused();
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

test('Fall 12: Stepper in halben Schritten, Grenzen, leadMin ≤ leadMax, Nachtspeicher ohne Aufheizzeiten', async ({ page }) => {
  await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);
  await openSettings(page);

  // Heizkörper: 20 °C, Aufheizzeit 0,5 bis 2 h; alle Zahlen mit Einheit
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '20' }));
  await expect(page.locator('#leadMinOut')).toHaveText(deText('unitHours', { n: '0,5' }));
  await expect(page.locator('#leadMaxOut')).toHaveText(deText('unitHours', { n: '2' }));
  await expect(page.locator('#comfortUp')).toHaveAttribute('aria-label', deText('stepUp', { what: deText('settingsComfort') }));
  await expect(page.locator('#leadMinDown')).toHaveAttribute('aria-label', deText('stepDown', { what: deText('settingsLeadMin') }));

  await page.locator('#comfortUp').click();
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '20,5' }));
  expect((await storedPlaces(page))[0].heat.comfort).toBe(20.5);

  // leadMin über leadMax: leadMax zieht mit (0,5 → 2 sind drei Schritte, der vierte schiebt beide auf 2,5)
  for (let i = 0; i < 4; i++) { await page.locator('#leadMinUp').click(); }
  await expect(page.locator('#leadMinOut')).toHaveText(deText('unitHours', { n: '2,5' }));
  await expect(page.locator('#leadMaxOut')).toHaveText(deText('unitHours', { n: '2,5' }));
  let h = (await storedPlaces(page))[0].heat;
  expect(h).toMatchObject({ leadMin: 2.5, leadMax: 2.5 });
  // leadMax unter leadMin: leadMin zieht mit
  await page.locator('#leadMaxDown').click();
  await expect(page.locator('#leadMinOut')).toHaveText(deText('unitHours', { n: '2' }));
  await expect(page.locator('#leadMaxOut')).toHaveText(deText('unitHours', { n: '2' }));
  h = (await storedPlaces(page))[0].heat;
  expect(h.leadMin).toBeLessThanOrEqual(h.leadMax);

  // Raumtemperatur bleibt in 17 bis 23 °C: am Rand ist der Knopf aria-disabled (nie disabled) und tut nichts.
  // Playwright wartet bei aria-disabled auf „enabled“, der Druck am Rand geht deshalb mit force.
  for (let i = 0; i < 7; i++) { await page.locator('#comfortDown').click(); }
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '17' }));
  await expect(page.locator('#comfortDown')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#comfortDown')).not.toHaveAttribute('disabled', /.*/);
  await page.locator('#comfortDown').click({ force: true });
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '17' }));
  expect((await storedPlaces(page))[0].heat.comfort).toBe(17);
  for (let i = 0; i < 12; i++) { await page.locator('#comfortUp').click(); }
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '23' }));
  await expect(page.locator('#comfortUp')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#comfortUp').click({ force: true });
  expect((await storedPlaces(page))[0].heat.comfort).toBe(23);

  // Nachtspeicher: beide Aufheizzeiten entfallen, der Fahrplan heißt „Aufladung“, die Raumtemperatur bleibt
  await page.locator('#rs-storage').click();
  await expect(page.locator('#stepLeadMin')).toBeHidden();
  await expect(page.locator('#stepLeadMax')).toBeHidden();
  await expect(page.locator('#stepComfort')).toBeVisible();
  await expect(page.locator('#planHead')).toHaveText(deText('planTitleStorage'));
  h = (await storedPlaces(page))[0].heat;
  expect(h).toMatchObject({ type: 'storage', leadMin: null, leadMax: null, confirmed: true, comfort: 23 });

  // zurück zum Heizkörper: die Tabellenwerte kommen wieder, die Raumtemperatur bleibt
  await page.locator('#rs-radiator').click();
  await expect(page.locator('#stepLeadMin')).toBeVisible();
  await expect(page.locator('#leadMinOut')).toHaveText(deText('unitHours', { n: '0,5' }));
  await expect(page.locator('#leadMaxOut')).toHaveText(deText('unitHours', { n: '2' }));
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '23' }));

  // nach dem Neuladen stehen die Werte in den Einstellungen wie gespeichert
  await page.reload();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await openSettings(page);
  await expect(page.locator('#comfortOut')).toHaveText(deText('unitCelsius', { n: '23' }));
  await expect(page.locator('#rs-radiator')).toBeChecked();
});

test('Fall 12: Ortsliste mit Name, Radio und Löschen mit Rückfrage; der einzige Ort führt nach S1', async ({ page }) => {
  await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);
  const place = (await storedPlaces(page))[0];
  await openSettings(page);

  // genau ein Ort: Name als Textfeld mit sichtbarer Beschriftung, Radio „Diesen Ort anzeigen“ gewählt
  const items = page.locator('#settingsPlaceList > li');
  await expect(items).toHaveCount(1);
  const name = items.first().locator('input[type=text]');
  await expect(name).toHaveValue(place.label);
  await expect(items.first().locator('label[for]')).toHaveText(deText('setupLabel'));
  await expect(items.first().locator('input[type=radio]')).toBeChecked();
  await expect(items.first()).toContainText(deText('settingsPlaceActive'));

  // umbenennen: getrimmt, leer behält den alten Namen
  await name.fill('  Opa  ');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await storedPlaces(page))[0].label).toBe('Opa');
  await expect(name).toHaveValue('Opa');
  await expect(page.locator('#settingsHeatPlace')).toHaveText('Opa');
  await expect(items.first().locator('.choice')).toContainText('Opa');
  await name.fill('   ');
  await page.keyboard.press('Enter');
  await expect(name).toHaveValue('Opa');
  expect((await storedPlaces(page))[0].label).toBe('Opa');

  // Löschen: erst die Rückfrage als zweiter Knopf (beim einzigen Ort settingsDeleteLast), keine confirm()-Box
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs += 1; return d.dismiss(); });
  const del = items.first().getByRole('button', { name: deText('btnDelete'), exact: true });
  await expect(del).toHaveAttribute('aria-expanded', 'false');
  await expect(items.first().locator('.place-confirm')).toBeHidden();
  await del.click();
  const ask = items.first().getByRole('button', { name: deText('settingsDeleteLast', { name: 'Opa' }), exact: true });
  await expect(ask).toBeVisible();
  await expect(ask).toBeFocused();
  await expect(del).toHaveAttribute('aria-expanded', 'true');
  // „Abbrechen“ schließt sie und gibt den Fokus an „Löschen“ zurück; es bleibt alles beim Alten
  await items.first().getByRole('button', { name: deText('btnCancel'), exact: true }).click();
  await expect(ask).toBeHidden();
  await expect(del).toBeFocused();
  expect(await storedPlaces(page)).toHaveLength(1);
  // Escape schließt sie ebenfalls
  await del.click();
  await expect(ask).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ask).toBeHidden();
  await expect(del).toBeFocused();
  // gehaltenes Enter auf „Löschen“: der erste Druck öffnet die Rückfrage, die Wiederholungen der Taste (repeat)
  // landen auf der Frage und löschen nichts; erst ein neuer Druck wäre die zweite Entscheidung
  await page.keyboard.down('Enter');
  await expect(ask).toBeFocused();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(ask).toBeVisible();
  expect(await storedPlaces(page)).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(ask).toBeHidden();
  await expect(del).toBeFocused();

  // bestätigen: der Ort und sein Cache sind weg, die Einrichtung beginnt bei S1 mit dem Fokus auf der Überschrift
  expect(await page.evaluate((id) => localStorage.getItem('hw:cache:' + id) !== null, place.id), 'Cache des Orts vorher da').toBe(true);
  await del.click();
  await ask.click();
  await expect(page.locator('#s-welcome')).toBeVisible();
  await expect(page.locator('#s-settings')).toBeHidden();
  await expectFocusOnHeading(page, 's-welcome');
  expect(await storedPlaces(page)).toEqual([]);
  expect(await page.evaluate((id) => localStorage.getItem('hw:cache:' + id), place.id)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('hw:active'))).toBeNull();
  expect(dialogs, 'keine confirm()-Box').toBe(0);

  // und von dort aus geht es wie beim ersten Mal weiter bis zu den Daten
  await page.locator('#btnByAddress').click();
  await fillAddress(page);
  await page.locator('#btnSearch').click();
  await pickFirstHit(page);
  await page.locator('#btnConfirmYes').click();
  await page.locator('#btnDone').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowTemp')).toContainText('°');
  expect(await storedPlaces(page)).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------
// Fall 12 (Fortsetzung): „Für Fortgeschrittene“, die acht Ampelschwellen je Ort
// ---------------------------------------------------------------------------------------------

// Die Standardwerte der acht Schwellen als { Schlüssel: [Einheit, Zahl] }, so wie die Stepper sie zeigen;
// Temperaturen in °C, Veränderungen in „Grad“ (unitDegrees), Wind in km/h
const SCHWELLEN_STANDARD = {
  threshWarnMinN: ['unitCelsius', '5'],
  threshWarnDrop48: ['unitDegrees', '−4'],
  threshAlarmMinN: ['unitCelsius', '0'],
  threshAlarmDrop48: ['unitDegrees', '−6'],
  threshAlarmGtRise: ['unitDegrees', '5'],
  threshCritMinN: ['unitCelsius', '−5'],
  threshColdWind: ['unitKmh', '20'],
  threshGustLead: ['unitKmh', '40']
};

async function expectThreshDefaults(page) {
  for (const [k, [unit, n]] of Object.entries(SCHWELLEN_STANDARD)) {
    await expect(page.locator('#' + k + 'Out'), k).toHaveText(deText(unit, { n }));
  }
}

test('Fall 12: Schwellen für Fortgeschrittene sind zugeklappt, ein Stepper schreibt nur sein Feld, „Auf Faustregel zurücksetzen“ macht thresh null', async ({ page }) => {
  const net = await mockNet(page);
  // milde Nächte: Stufe 0, solange warnMinN (5 °C) unter dem Tiefstwert der ersten Nacht (9,5 °C) liegt
  net.on.forecast = (route) => answer(route, fixtureText('om-mild.json'));
  await startClock(page);
  await setUpByClicks(page);
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(0));
  expect((await storedPlaces(page))[0].heat.thresh, 'ohne eigene Schwellen steht null im Speicher').toBeNull();

  await openSettings(page);
  // zugeklappt: nur die Zusammenfassung ist da, weder Zahlen noch Zurücksetzen
  const det = page.locator('#settingsAdvanced');
  const summary = det.locator('summary');
  await expect(summary).toHaveText(deText('settingsAdvanced'));
  await expect(det).not.toHaveAttribute('open', /.*/);
  await expect(page.locator('#threshWarnMinNOut')).toBeHidden();
  await expect(page.locator('#btnThreshReset')).toBeHidden();
  await summary.click();
  await expect(det).toHaveAttribute('open', '');
  await expect(det.locator('p.hint').first()).toHaveText(deText('settingsThresholdsHint'));
  await expectThreshDefaults(page);
  // die Knöpfe nennen die Schwelle mit ihrem Hauptwort (threshName…), nicht mit dem Satzanfang der Beschriftung
  for (const k of Object.keys(SCHWELLEN_STANDARD)) {
    const what = deText('threshName' + k.slice('thresh'.length));
    await expect(page.locator('#' + k + 'Up')).toHaveAttribute('aria-label', deText('stepUp', { what }));
    await expect(page.locator('#' + k + 'Down')).toHaveAttribute('aria-label', deText('stepDown', { what }));
  }
  // die Frost-Schwellen enden bei 0 °C: alarmMinN steht mit der Faustregel schon am oberen Rand
  await expect(page.locator('#threshAlarmMinNUp')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#threshCritMinNUp')).not.toHaveAttribute('aria-disabled', /.*/);
  await expect(page.locator('#btnThreshReset')).toHaveText(deText('settingsReset'));
  // aufgeklappt: Tippflächen, Scrollleiste und Überschriften wie auf jedem Bildschirm
  await expectTapSizes(page, 'Einstellungen mit Schwellen');
  await expectNoHorizontalScroll(page, 'Einstellungen mit Schwellen');
  await expectHeadingOrder(page, 'Einstellungen mit Schwellen');

  // sieben Schritte an warnMinN (5 → 12 °C): nur dieses Feld landet im Speicher, die Ampel zieht ohne neuen Abruf nach
  const forecasts = net.count('forecast');
  for (let i = 0; i < 7; i++) { await page.locator('#threshWarnMinNUp').click(); }
  await expect(page.locator('#threshWarnMinNOut')).toHaveText(deText('unitCelsius', { n: '12' }));
  expect((await storedPlaces(page))[0].heat.thresh).toEqual({ warnMinN: 12 });
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(1));
  expect(net.count('forecast'), 'Schwellen ändern die Ampel, sie rufen nichts ab').toBe(forecasts);

  // ein zweiter Stepper ergänzt sein Feld, das erste bleibt
  await page.locator('#threshColdWindUp').click();
  await expect(page.locator('#threshColdWindOut')).toHaveText(deText('unitKmh', { n: '25' }));
  expect((await storedPlaces(page))[0].heat.thresh).toEqual({ warnMinN: 12, coldWind: 25 });
  await expect(page.locator('#threshWarnMinNOut')).toHaveText(deText('unitCelsius', { n: '12' }));
  await expect(page.locator('#threshGustLeadOut')).toHaveText(deText('unitKmh', { n: '40' }));

  // nach dem Neuladen stehen die Werte da, das <details> ist wieder zu und lässt sich mit der Tastatur öffnen
  await page.reload();
  await expect(page.locator('#nowTemp')).toContainText('°');
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(1));
  // der Start ruft einmal ab; von hier an zählt der Stand danach
  await expect.poll(() => net.count('forecast'), { message: 'der Start nach dem Neuladen ruft einmal ab' }).toBe(forecasts + 1);
  const forecastsStart = net.count('forecast');
  await openSettings(page);
  await expect(det).not.toHaveAttribute('open', /.*/);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(det).toHaveAttribute('open', '');
  await expect(page.locator('#threshWarnMinNOut')).toHaveText(deText('unitCelsius', { n: '12' }));
  await expect(page.locator('#threshColdWindOut')).toHaveText(deText('unitKmh', { n: '25' }));

  // am Rand bleibt der Knopf fokussierbar (aria-disabled, nie disabled) und tut nichts
  for (let i = 0; i < 4; i++) { await page.locator('#threshGustLeadDown').click(); }
  await expect(page.locator('#threshGustLeadOut')).toHaveText(deText('unitKmh', { n: '20' }));
  await expect(page.locator('#threshGustLeadDown')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#threshGustLeadDown')).not.toHaveAttribute('disabled', /.*/);
  await page.locator('#threshGustLeadDown').click({ force: true });
  await expect(page.locator('#threshGustLeadOut')).toHaveText(deText('unitKmh', { n: '20' }));
  expect((await storedPlaces(page))[0].heat.thresh).toEqual({ warnMinN: 12, coldWind: 25, gustLead: 20 });

  // Zurücksetzen: thresh wird null, alle acht Zahlen stehen wieder auf den Faustregeln, die Ampel auf Stufe 0
  await page.locator('#btnThreshReset').click();
  expect((await storedPlaces(page))[0].heat.thresh).toBeNull();
  await expectThreshDefaults(page);
  await expect(page.locator('#threshGustLeadDown')).not.toHaveAttribute('aria-disabled', /.*/);
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(0));
  await expect(page.locator('#btnThreshReset')).toBeFocused();
  // und noch einmal drücken schadet nicht
  await page.locator('#btnThreshReset').click();
  expect((await storedPlaces(page))[0].heat.thresh).toBeNull();
  expect(net.count('forecast'), 'auch Zurücksetzen ruft nichts ab').toBe(forecastsStart);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Fall 14: die Ampel trägt Stufe, Zahl und Wort als Text, nie Farbe allein
// ---------------------------------------------------------------------------------------------

test('Fall 14: die Stufenzeile enthält „Stufe“, die Zahl und das Wort als Text; die Lampen sind nur Zierde', async ({ page }) => {
  const net = await mockNet(page);
  // je ein Wetter für Stufe 0, 2 und 3 (Stufe 1 entsteht im Fall oben über die Schwelle)
  const faelle = [['om-mild.json', 0], ['om-frost.json', 2], ['om-hartfrost.json', 3]];
  const wetter = (datei) => (route) => answer(route, fixtureText(datei));
  net.on.forecast = wetter(faelle[0][0]);
  await startClock(page);
  await setUpByClicks(page);
  const anfang = deText('levelOf').split('{')[0].trim();
  expect(anfang, 'der feste Anfang des Satzes').toBe('Stufe');
  for (const [i, [datei, stufe]] of faelle.entries()) {
    if (i > 0) {
      net.on.forecast = wetter(datei);
      await page.reload();
    }
    const zeile = page.locator('#verdictTitle');
    await expect(zeile, datei).toHaveText(levelLine(stufe));
    const text = (await zeile.textContent()).trim();
    expect(text.startsWith(anfang + ' ' + stufe), 'Wort „Stufe“ und Zahl am Anfang: ' + text).toBe(true);
    expect(text, 'das Wort der Stufe steht im Satz').toContain(deText('level' + stufe));
    // die Zeile ist eine Überschrift (Screenreader springen dorthin); die Lampen daneben sind Zierde und ohne Text
    expect(await zeile.evaluate((e) => e.tagName)).toBe('H2');
    await expect(page.locator('#verdict .lamp')).toHaveAttribute('aria-hidden', 'true');
    expect((await page.locator('#verdict .lamp').textContent()).trim(), 'die Lampen tragen keinen Text').toBe('');
  }
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Fall 13: Theme System/Hell/Dunkel (BAUPLAN Abschnitt 8, „Theme ab M3“). Playwright meldet ohne Angabe „hell“; jeder
// Test legt das System deshalb mit page.emulateMedia fest. Gemessen wird am Ergebnis: data-theme, hw:theme (JSON),
// beide theme-color-Metas und die Variable --bg, die der CSS-Block des gewählten Themes setzt.
// ---------------------------------------------------------------------------------------------

const TON_DUNKEL = '#111821';
const TON_HELL = '#F3F3F6';
const BG_DUNKEL = 'oklch(17% 0.018 252)';
const BG_HELL = '#F3F3F6';

function themeState(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const css = getComputedStyle(html);
    return {
      attr: html.getAttribute('data-theme'),
      stored: localStorage.getItem('hw:theme'),
      metas: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute('content')),
      bg: css.getPropertyValue('--bg').trim(),
      scheme: css.colorScheme
    };
  });
}

test('Fall 13: themeSelect schaltet System, Hell und Dunkel; data-theme, hw:theme und beide theme-color-Metas folgen, Reload → bleibt', async ({ page }) => {
  const net = await mockNet(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await startClock(page);
  await setUpByClicks(page);

  // Start: „System“, und das System ist dunkel
  expect(await themeState(page)).toEqual({ attr: null, stored: null, metas: [TON_DUNKEL, TON_HELL], bg: BG_DUNKEL, scheme: 'dark' });

  await openSettings(page);
  const select = page.locator('#themeSelect');
  await expect(select).toHaveValue('system');
  await expect(page.locator('label[for=themeSelect]')).toHaveText(deText('themeLabel'));
  await expect(select.locator('option')).toHaveText([deText('themeSystem'), deText('themeLight'), deText('themeDark')]);
  const box = await select.boundingBox();
  expect(box.height, 'Auswahl mindestens 48 px hoch').toBeGreaterThanOrEqual(48);

  // Hell: sofort, auch gegen das dunkle System; gespeichert als JSON
  await select.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await themeState(page)).toEqual({ attr: 'light', stored: '"light"', metas: [TON_HELL, TON_HELL], bg: BG_HELL, scheme: 'light' });

  // Reload: bleibt, und die Auswahl zeigt es beim nächsten Öffnen
  await page.reload();
  await expect(page.locator('#s-main')).toBeVisible();
  expect(await themeState(page)).toEqual({ attr: 'light', stored: '"light"', metas: [TON_HELL, TON_HELL], bg: BG_HELL, scheme: 'light' });
  await openSettings(page);
  await expect(select).toHaveValue('light');

  // Dunkel: gilt auch, wenn das System hell ist
  await page.emulateMedia({ colorScheme: 'light' });
  await select.selectOption('dark');
  expect(await themeState(page)).toEqual({ attr: 'dark', stored: '"dark"', metas: [TON_DUNKEL, TON_DUNKEL], bg: BG_DUNKEL, scheme: 'dark' });
  await page.reload();
  expect(await themeState(page)).toEqual({ attr: 'dark', stored: '"dark"', metas: [TON_DUNKEL, TON_DUNKEL], bg: BG_DUNKEL, scheme: 'dark' });

  // System: Attribut und Schlüssel weg, die Metas bekommen ihre Töne zurück, das System (hier hell) entscheidet
  await openSettings(page);
  await expect(select).toHaveValue('dark');
  await select.selectOption('system');
  expect(await themeState(page)).toEqual({ attr: null, stored: null, metas: [TON_DUNKEL, TON_HELL], bg: BG_HELL, scheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await themeState(page)).toEqual({ attr: null, stored: null, metas: [TON_DUNKEL, TON_HELL], bg: BG_DUNKEL, scheme: 'dark' });
  await page.reload();
  expect(await themeState(page)).toEqual({ attr: null, stored: null, metas: [TON_DUNKEL, TON_HELL], bg: BG_DUNKEL, scheme: 'dark' });
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

test('Fall 13: wechselt das System, während „System“ gilt, zeichnet der Hauptbildschirm neu', async ({ page }) => {
  const net = await mockNet(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await startClock(page);
  await setUpByClicks(page);

  // jedes Rendern schreibt die Temperatur neu: die Beobachtung zählt die Schreibvorgänge
  await page.evaluate(() => {
    window.__neuGezeichnet = 0;
    new MutationObserver((records) => { window.__neuGezeichnet += records.length; })
      .observe(document.getElementById('nowTemp'), { childList: true, characterData: true, subtree: true });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => window.__neuGezeichnet)).toBeGreaterThan(0);
  expect((await themeState(page)).bg, 'das System ist jetzt hell und „System“ folgt ihm').toBe(BG_HELL);

  const gezaehlt = await page.evaluate(() => window.__neuGezeichnet);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => window.__neuGezeichnet)).toBeGreaterThan(gezaehlt);
  expect((await themeState(page)).bg).toBe(BG_DUNKEL);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

test('Fall 13: ein Wert unter hw:theme, der kein JSON "light" oder "dark" ist, lässt „System“ gelten', async ({ page }) => {
  const net = await mockNet(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  // so schreibt die Startseite ihren Schlüssel (roh), und so sähe ein Unsinnswert aus: beides gilt hier nicht
  for (const roh of ['light', '"Hell"', '"system"', '{"theme":"light"}']) {
    await page.addInitScript((wert) => { try { localStorage.setItem('hw:theme', wert); } catch (e) { /* ohne Speicher gibt es nichts zu setzen */ } }, roh);
    await page.goto('/');
    expect(await themeState(page), roh).toEqual({ attr: null, stored: roh, metas: [TON_DUNKEL, TON_HELL], bg: BG_DUNKEL, scheme: 'dark' });
    await expect(page.locator('#s-welcome')).toBeVisible();
  }
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Fall 17: mehrere Orte (Nachtrag aus den Einstellungen, Umschalter, Wechsel während eines Abrufs, Maximum fünf)
// ---------------------------------------------------------------------------------------------

// Aktiver Ort laut Speicher (hw:active) und der Cache eines Orts (hw:cache:<id>) als Objekt oder null
function storedActive(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('hw:active') || 'null'));
}

function storedCache(page, id) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem('hw:cache:' + key) || 'null'), id);
}

// Wie oft die Forecast-Route für die Breite lat (round3, wie in der URL) getroffen wurde
function forecastHits(net, lat) {
  return net.log.forecast.filter((u) => u.includes('latitude=' + lat + '&')).length;
}

// Der Satz der Stufenzeile für Stufe n (levelOf mit dem Namen der Stufe)
function levelLine(n) {
  return deText('levelOf', { n, name: deText('level' + n) });
}

// Ein weiterer Ort über Einstellungen → „Ort hinzufügen“ bis zum Hauptbildschirm mit Daten des neuen Orts. fixture ist
// die Photon-Antwort für die Suche (der Test wählt den ersten Treffer). Gibt die Ortsliste aus dem Speicher zurück.
async function addPlaceByClicks(page, net, fixture) {
  net.on.photon = (route) => answer(route, fixtureText(fixture));
  await openSettings(page);
  await page.locator('#btnAddPlace').click();
  await expect(page.locator('#s-address')).toBeVisible();
  await fillAddress(page);
  await page.locator('#btnSearch').click();
  await pickFirstHit(page);
  await page.locator('#btnConfirmYes').click();
  await expect(page.locator('#s-profile')).toBeVisible();
  await page.locator('#btnDone').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowBody')).toBeVisible();
  return storedPlaces(page);
}

test('Fall 17: zweiter Ort über „Ort hinzufügen“, Umschalter, Wechsel zurück auch innerhalb von 60 s, Löschen bis S1', async ({ page, errors }) => {
  const net = await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);
  const [a] = await storedPlaces(page);

  // bei einem Ort steht nur sein Name da, kein Umschalter
  await expect(page.locator('#placeName')).toHaveText(a.label);
  await expect(page.locator('#placePick')).toBeHidden();

  // Nachtrag: Einrichtung ab S2 mit dem Zähler „1 von 4“, „Zurück“ führt in die Einstellungen
  await openSettings(page);
  await expect(page.locator('#btnAddPlace')).toBeVisible();
  await page.locator('#btnAddPlace').click();
  await expect(page.locator('#s-address')).toBeVisible();
  await expectFocusOnHeading(page, 's-address');
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 1, of: 4 }));
  await page.locator('#btnAddrBack').click();
  await expect(page.locator('#s-settings')).toBeVisible();
  await expectFocusOnHeading(page, 's-settings');
  await expect(page.locator('#setupStep')).toHaveText('');
  expect(await storedPlaces(page), 'abgebrochen: kein zweiter Ort').toHaveLength(1);

  // und noch einmal bis zum Ende: Zähler 1, 2, 3, 4 von 4; der neue Ort ist nach „Ja“ in S4 gespeichert und aktiv
  net.on.photon = (route) => answer(route, fixtureText('photon-ohne-nummer.json'));
  await page.locator('#btnAddPlace').click();
  await fillAddress(page);
  await page.locator('#btnSearch').click();
  await expect(page.locator('#s-hits')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 2, of: 4 }));
  await page.locator('#hitList .hit').first().click();
  await expect(page.locator('#s-confirm')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 3, of: 4 }));
  await page.locator('#btnConfirmYes').click();
  await expect(page.locator('#s-profile')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 4, of: 4 }));
  await expect.poll(async () => (await storedPlaces(page)).length).toBe(2);
  const [, b] = await storedPlaces(page);
  expect(await storedActive(page), 'der neue Ort ist aktiv').toBe(b.id);
  await page.locator('#btnDone').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowBody')).toBeVisible();

  // ab zwei Orten: sichtbares Label und natives Auswahlfeld statt des Namens, der neue Ort ist gewählt
  await expect(page.locator('#placePick')).toBeVisible();
  await expect(page.locator('#placeName')).toBeHidden();
  await expect(page.locator('label[for="placeSelect"]')).toBeVisible();
  await expect(page.locator('label[for="placeSelect"]')).toHaveText(deText('placeLabel'));
  expect(await page.locator('#placeSelect').evaluate((el) => el.tagName)).toBe('SELECT');
  await expect(page.locator('#placeSelect option')).toHaveText([a.label, b.label]);
  await expect(page.locator('#placeSelect')).toHaveValue(b.id);
  // je Ort ein Cache (M3-DoD 2): zwei Schlüssel hw:cache:<id>
  await expect.poll(async () => (await storedCache(page, a.id)) !== null && (await storedCache(page, b.id)) !== null).toBe(true);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hw:cache:')).sort());
  expect(keys).toEqual(['hw:cache:' + a.id, 'hw:cache:' + b.id].sort());

  // Umschalten auf den ersten Ort ruft die Forecast-Route erneut ab, auch innerhalb von 60 s (refresh(true))
  const hits = net.count('forecast');
  await page.locator('#placeSelect').selectOption(a.id);
  await expect.poll(() => net.count('forecast')).toBe(hits + 1);
  expect(await storedActive(page)).toBe(a.id);
  await expect(page.locator('#placeSelect')).toHaveValue(a.id);
  await expect(page.locator('#reload')).not.toHaveAttribute('aria-disabled', 'true');

  // dasselbe mit dem Radio „Diesen Ort anzeigen“ in den Einstellungen
  await openSettings(page);
  const items = page.locator('#settingsPlaceList > li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator('input[type=radio]')).toBeChecked();
  await expect(items.nth(1).locator('input[type=radio]')).not.toBeChecked();
  await expect(items.nth(1).locator('.choice')).toContainText(deText('settingsPlaceActive'));
  const hitsRadio = net.count('forecast');
  await items.nth(1).locator('.choice').click();
  await expect(items.nth(1).locator('input[type=radio]')).toBeChecked();
  await expect.poll(() => net.count('forecast')).toBe(hitsRadio + 1);
  expect(await storedActive(page)).toBe(b.id);
  await page.locator('#btnSettingsBack').click();
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#placeSelect')).toHaveValue(b.id);

  // Löschen des aktiven Orts: der andere rückt nach (hw:active), sein Cache geht mit, der Cache des Nachrückers bleibt
  await openSettings(page);
  await items.nth(1).getByRole('button', { name: deText('btnDelete'), exact: true }).click();
  await items.nth(1).getByRole('button', { name: deText('settingsDeleteConfirm', { name: b.label }), exact: true }).click();
  await expect(items).toHaveCount(1);
  expect(await storedActive(page), 'der übrige Ort ist aktiv').toBe(a.id);
  expect(await storedCache(page, b.id), 'der Cache des gelöschten Orts geht mit').toBeNull();
  expect(await storedCache(page, a.id)).not.toBeNull();
  await expect(items.first().locator('input[type=radio]')).toBeChecked();
  await page.locator('#btnSettingsBack').click();
  await expect(page.locator('#placePick')).toBeHidden();
  await expect(page.locator('#placeName')).toHaveText(a.label);

  // der einzige verbliebene Ort: settingsDeleteLast, danach S1
  await openSettings(page);
  await items.first().getByRole('button', { name: deText('btnDelete'), exact: true }).click();
  await items.first().getByRole('button', { name: deText('settingsDeleteLast', { name: a.label }), exact: true }).click();
  await expect(page.locator('#s-welcome')).toBeVisible();
  expect(await storedPlaces(page)).toEqual([]);
  expect(errors.console, 'console.error').toEqual([]);
});

test('Fall 17: Wechsel während eines Abrufs zeigt nie die Daten des alten Orts unter dem Namen des neuen', async ({ page, errors }) => {
  const net = await mockNet(page);
  await startClock(page);
  await setUpByClicks(page);
  const [a] = await storedPlaces(page);
  const [, b] = await addPlaceByClicks(page, net, 'photon-ohne-nummer.json');
  expect(a.lat, 'Ort A liegt bei 48.877').toBe(48.877);
  expect(b.lat, 'Ort B liegt bei 48.882 (round3 von 48.8817501)').toBe(48.882);

  // A liefert Frost (Stufe 2), B milde Nächte (Stufe 0); die Antwort für A hält der Handler zurück, bis der Test sie freigibt
  let hold = false;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  net.on.forecast = async (route) => {
    if (route.request().url().includes('latitude=48.882&')) { return answer(route, fixtureText('om-mild.json')); }
    if (hold) { await gate; }
    return answer(route, fixtureText('om-frost.json'));
  };
  await expect.poll(async () => (await storedCache(page, a.id)) !== null).toBe(true);
  const fetchedBefore = (await storedCache(page, a.id)).fetched;
  const hitsA = forecastHits(net, 48.877);
  const hitsB = forecastHits(net, 48.882);
  hold = true;

  // auf A umschalten: der Abruf für A läuft und hängt
  await page.locator('#placeSelect').selectOption(a.id);
  await expect.poll(() => forecastHits(net, 48.877)).toBe(hitsA + 1);
  await expect(page.locator('#reload')).toHaveAttribute('aria-disabled', 'true');

  // währenddessen auf B umschalten: die Forecast-Route wird für B getroffen, B hängt sich nicht an den Abruf von A
  await page.locator('#placeSelect').selectOption(b.id);
  await expect.poll(() => forecastHits(net, 48.882)).toBe(hitsB + 1);
  await expect(page.locator('#placeSelect')).toHaveValue(b.id);
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(0));
  await expect(page.locator('#reload')).not.toHaveAttribute('aria-disabled', 'true');
  const hitsAfterB = net.count('forecast');

  // jetzt die späte Antwort für A freigeben (die Seitenuhr läuft vorher ein Stück weiter, damit „fetched“ später liegt)
  await page.clock.runFor(2000);
  release();
  await expect.poll(async () => (await storedCache(page, a.id)).fetched, { message: 'die späte Antwort schreibt hw:cache:<id von A>' })
    .toBeGreaterThan(fetchedBefore);
  await settle(page);

  // angezeigt wird weiter nur B: Name, Stufe 0 aus B’s Daten, nie die Stufe 2 von A; kein Doppelabruf, B bleibt aktiv
  await expect(page.locator('#placeSelect')).toHaveValue(b.id);
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(0));
  await expect(page.locator('#verdictTitle')).not.toHaveText(levelLine(2));
  expect(await storedActive(page)).toBe(b.id);
  expect(net.count('forecast'), 'kein zusätzlicher Abruf durch die späte Antwort').toBe(hitsAfterB);

  // und auf A gewechselt, steht der geschriebene Stand sofort da (Stufe 2)
  hold = false;
  await page.locator('#placeSelect').selectOption(a.id);
  await expect(page.locator('#verdictTitle')).toHaveText(levelLine(2));
  expect(errors.console, 'console.error').toEqual([]);
});

// count Orte vorab im Speicher (Format nach BAUPLAN Abschnitt 4), bevor die App startet. Ort i heißt „Ort i+1“
// (oder labels[i]), liegt auf 300 + 100 · i m (von Hand nicht geändert, elevAuto) und hat die Id ort0000i.
function seedPlaces(page, count, labels) {
  return page.addInitScript((arg) => {
    try {
      if (localStorage.getItem('hw:v') !== null) { return; }
      const places = [];
      for (let i = 0; i < arg.n; i++) {
        places.push({
          id: 'ort0000' + i, label: arg.labels[i] || 'Ort ' + (i + 1), lat: 48.8 + i / 100, lon: 9.4, elev: 300 + 100 * i,
          elevAuto: true, cc: 'DE', tz: null,
          heat: { type: 'radiator', leadMin: 0.5, leadMax: 2, comfort: 20, thresh: null, confirmed: true }, created: 1
        });
        localStorage.setItem('hw:cache:ort0000' + i, JSON.stringify({ v: 2, fetched: 1, om: {} }));
      }
      localStorage.setItem('hw:v', '2');
      localStorage.setItem('hw:places', JSON.stringify(places));
      localStorage.setItem('hw:active', JSON.stringify('ort00000'));
    } catch (e) {
      // ohne Speicher gibt es keinen Seed; der Test fiele dann an seinen Erwartungen auf
    }
  }, { n: count, labels: labels || [] });
}

test('Fall 17: bei fünf Orten zeigt „Ort hinzufügen“ errMaxPlaces, nach dem Löschen eines Orts geht es wieder', async ({ page }) => {
  const net = await mockNet(page);
  await seedPlaces(page, 5);
  await startClock(page);
  await page.goto('/');
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#nowBody')).toBeVisible();
  await expect(page.locator('#placeSelect option')).toHaveCount(5);
  expect(net.count('forecast'), 'nur der aktive Ort wird abgerufen').toBe(1);

  await openSettings(page);
  const items = page.locator('#settingsPlaceList > li');
  await expect(items).toHaveCount(5);
  const add = page.locator('#btnAddPlace');
  const err = page.locator('#settingsPlacesErr');
  await expect(err).toBeEmpty();

  // der Knopf bleibt aktiv; ein Druck zeigt den Satz in der Alert-Zeile über dem Knopf, der Fokus geht darauf
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  expect(await add.evaluate((el) => el.disabled)).toBe(false);
  await add.click();
  await expect(err).toHaveText(deText('errMaxPlaces'));
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toBeFocused();
  await expect(page.locator('#s-address')).toBeHidden();
  const above = await page.evaluate(() => {
    const e = document.getElementById('settingsPlacesErr').getBoundingClientRect();
    const b = document.getElementById('btnAddPlace').getBoundingClientRect();
    return e.bottom <= b.top;
  });
  expect(above, 'die Alert-Zeile steht über dem Knopf').toBe(true);
  expect(await storedPlaces(page)).toHaveLength(5);

  // ein zweiter Druck setzt den Satz nicht doppelt
  await add.click();
  await expect(err.locator('p')).toHaveCount(1);

  // die Ortsliste mit „Löschen“ steht darüber; ein nicht aktiver Ort weg: Satz weg, Cache weg, der aktive Ort bleibt
  expect(await storedCache(page, 'ort00002')).not.toBeNull();
  await items.nth(2).getByRole('button', { name: deText('btnDelete'), exact: true }).click();
  await items.nth(2).getByRole('button', { name: deText('settingsDeleteConfirm', { name: 'Ort 3' }), exact: true }).click();
  await expect(items).toHaveCount(4);
  await expect(err).toBeEmpty();
  expect(await storedCache(page, 'ort00002')).toBeNull();
  expect(await storedActive(page)).toBe('ort00000');

  // jetzt geht es wieder: Einrichtung ab S2, Zähler „1 von 4“
  await add.click();
  await expect(page.locator('#s-address')).toBeVisible();
  await expect(page.locator('#setupStep')).toHaveText(deText('setupStep', { n: 1, of: 4 }));
});

// ---------------------------------------------------------------------------------------------
// Fall 3 (Fortsetzung): lange Ortsnamen im Umschalter und in den Einstellungen
// ---------------------------------------------------------------------------------------------

// Zwei Namen mit der Höchstlänge von 40 Zeichen (LABEL_MAX in app.js): einer mit Leerzeichen und Bindestrichen, wie
// ihn Photon aus Straße und Hausnummer baut, einer ganz ohne Stelle zum Umbrechen
const LANG_MIT = 'Bürgermeister-Müller-Straße 12 Winnenden';
const LANG_OHNE = 'Donaudampfschifffahrtsgesellschaftshafen';

test('Fall 3: Orte mit 40 Zeichen langen Namen schieben weder den Umschalter noch die Einstellungen über den Rand', async ({ page }) => {
  expect(LANG_MIT).toHaveLength(40);
  expect(LANG_OHNE).toHaveLength(40);
  const net = await mockNet(page);
  await seedPlaces(page, 3, ['Ort 1', LANG_MIT, LANG_OHNE]);
  await startClock(page);
  await page.goto('/');
  await expect(page.locator('#s-main')).toBeVisible();
  await expect(page.locator('#placePick')).toBeVisible();
  await expect(page.locator('#placeSelect option')).toHaveCount(3);
  await expect(page.locator('#nowTemp')).toContainText('°');
  // Ein <select> ist so breit wie seine längste Option: auch mit „Ort 1“ gewählt zählt der lange Name
  await expectNoHorizontalScroll(page, 'Hauptbildschirm, kurzer Name gewählt');
  for (const [id, name] of [['ort00001', LANG_MIT], ['ort00002', LANG_OHNE]]) {
    await page.locator('#placeSelect').selectOption(id);
    await expect.poll(() => storedActive(page)).toBe(id);
    await expect(page.locator('#nowTemp')).toContainText('°');
    await expectNoHorizontalScroll(page, 'Hauptbildschirm, ' + name);
    await expectTapSizes(page, 'Hauptbildschirm, ' + name);
  }

  await openSettings(page);
  await expectNoHorizontalScroll(page, 'Einstellungen mit langen Namen');
  // die Rückfrage beim Löschen trägt den Namen ohne Umbruchstelle mitten im Satz
  const items = page.locator('#settingsPlaceList > li');
  await items.nth(2).getByRole('button', { name: deText('btnDelete'), exact: true }).click();
  await expect(items.nth(2).getByRole('button', { name: deText('settingsDeleteConfirm', { name: LANG_OHNE }), exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page, 'Einstellungen mit Rückfrage zum langen Namen');
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Fall 12 (Fortsetzung): das Höhenfeld gehört zum aktiven Ort
// ---------------------------------------------------------------------------------------------

test('Fall 12: Ortswechsel schließt das Höhenfeld samt Fehler; eine späte Höhenabfrage landet beim Ort, für den sie lief', async ({ page }) => {
  const net = await mockNet(page);
  await seedPlaces(page, 2);
  await startClock(page);
  await page.goto('/');
  await expect(page.locator('#s-main')).toBeVisible();
  await openSettings(page);
  const items = page.locator('#settingsPlaceList > li');
  const val = page.locator('#settingsElevVal');
  const input = page.locator('#settingsElevInput');
  await expect(val).toHaveText(deText('setupElev', { m: 300 }));

  // Ort 1: ungültige Höhe, der Fehler steht unter dem Feld
  await page.locator('#btnSettingsElev').click();
  await expect(input).toBeFocused();
  await input.fill('99999');
  await page.keyboard.press('Enter');
  await expect(page.locator('#settingsElevErr')).toContainText(deText('errElevRange'));

  // Wechsel auf Ort 2 per Radio: Feld zu, Fehler weg, Anzeige und Feld zeigen die Höhe von Ort 2
  await items.nth(1).locator('.choice').click();
  await expect(items.nth(1).locator('input[type=radio]')).toBeChecked();
  await expect(page.locator('#settingsElevEdit')).toBeHidden();
  await expect(page.locator('#btnSettingsElev')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#settingsElevErr')).toBeEmpty();
  await expect(input).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(val).toHaveText(deText('setupElev', { m: 400 }));
  await expect(input).toHaveValue('400');

  // Ort 2: Feld leeren, die Höhenabfrage hängt; währenddessen zurück auf Ort 1
  let releaseElev = null;
  const elevGate = new Promise((resolve) => { releaseElev = resolve; });
  net.on.elevation = async (route) => {
    await elevGate;
    return answer(route, fixtureText('elev.json'));
  };
  const elevations = net.count('elevation');
  await page.locator('#btnSettingsElev').click();
  await input.fill('');
  await page.keyboard.press('Enter');
  await expect.poll(() => net.count('elevation')).toBe(elevations + 1);
  await expect(val).toHaveText(deText('setupElevLoading'));
  await items.nth(0).locator('.choice').click();
  await expect(items.nth(0).locator('input[type=radio]')).toBeChecked();
  await expect(val).toHaveText(deText('setupElev', { m: 300 }));
  await expect(page.locator('#settingsElevEdit')).toBeHidden();

  // die Antwort kommt: Ort 2 bekommt 417 m (automatisch), Ort 1 und seine Anzeige bleiben unberührt
  releaseElev();
  await expect.poll(async () => (await storedPlaces(page))[1].elev).toBe(417);
  expect((await storedPlaces(page))[1]).toMatchObject({ elev: 417, elevAuto: true });
  expect((await storedPlaces(page))[0]).toMatchObject({ elev: 300, elevAuto: true });
  await expect(val).toHaveText(deText('setupElev', { m: 300 }));
  await expect(input).toHaveValue('300');

  // zurück auf Ort 2: die neue Höhe steht da, und der Abruf trägt sie in der URL
  const forecasts = net.count('forecast');
  await items.nth(1).locator('.choice').click();
  await expect(val).toHaveText(deText('setupElev', { m: 417 }));
  await expect.poll(() => net.count('forecast')).toBe(forecasts + 1);
  expect(net.log.forecast[net.log.forecast.length - 1]).toMatch(/[?&]elevation=417(&|$)/);
  expect(net.log.stray, 'Anfragen ohne Route').toEqual([]);
});
