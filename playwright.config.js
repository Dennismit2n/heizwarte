/*
 * Heizwarte — Playwright-Einstellungen für den Smoke-Test (BAUPLAN Abschnitt 2 und 12).
 *
 * Nur Chromium, ein Worker, ein Lauf = ein Browser. Nie zugleich mit node --test, Builds oder anderen
 * Agenten (16 GB RAM). testDir ist Pflicht: ohne ihn sucht Playwright im ganzen Repo nach *.test.js und
 * lädt dabei auch die node:test-Dateien unter tests/. Das Netz leitet jeder Fall selbst per page.route auf
 * die Fixtures um; nach außen geht nie eine Anfrage.
 *
 * Aufruf: npx playwright test        (vorher kein anderer Testlauf)
 *         npx playwright test --list (zeigt nur Dateien unter tests/smoke)
 */
'use strict';

const { defineConfig } = require('@playwright/test');

const PORT = 8619;

module.exports = defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    // localhost, nicht 127.0.0.1: app.js registriert den Service Worker nur über https oder auf localhost
    baseURL: 'http://localhost:' + PORT,
    // Ohne locale folgt detect() der Sprache des Testrechners; Fall 3 läuft bis M4 nur auf Deutsch
    locale: 'de-DE',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'phone',
      // Das Projekt shots (Bildschirmfoto) kommt erst mit M4; seine Datei läuft in diesen beiden Projekten nie
      testIgnore: /shots\.spec\.js/,
      use: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }
    },
    {
      name: 'desktop',
      testIgnore: /shots\.spec\.js/,
      use: { viewport: { width: 1280, height: 800 } }
    }
  ],
  webServer: {
    command: 'node tools/dev-server.js',
    // Der Server hört auf 127.0.0.1; die Bereitschaftsprüfung geht darum dorthin
    url: 'http://127.0.0.1:' + PORT + '/',
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30000
  }
});
