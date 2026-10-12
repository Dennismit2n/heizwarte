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
 * kommen mit den Meilensteinen 3 und 5 dazu.
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

// Fall 3: keine horizontale Scrollleiste
async function expectNoHorizontalScroll(page, where) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(w.scroll, 'scrollWidth ≤ innerWidth: ' + where).toBeLessThanOrEqual(w.inner);
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

// Geht alle Bildschirme der Einrichtung und den Hauptbildschirm durch und ruft check(Name) auf jedem auf
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
  // alle neun Stellen wurden geprüft, kein Zweig hat sie übersprungen
  expect(seen, 'geprüfte Bildschirme').toHaveLength(9);
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
