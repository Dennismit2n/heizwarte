/*
 * Heizwarte — Testlader: zieht die klassischen Skripte in der Reihenfolge von index.html herein
 * und gibt globalThis.Heizwarte zurück (Muster: ohnespur/tests/_load.js). Noch nicht gebaute
 * Dateien werden übersprungen und einmal auf stderr genannt, damit Teiltests schon vor dem
 * Vollausbau laufen. boot.js und app.js laden die Tests nie: boot.js braucht ein DOM, und
 * app.js ist die einzige Datei, die beim Laden etwas tut.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ORDER = ['storage', 'i18n', 'geo', 'weather', 'heat', 'chart'];

// Die <script src>-Reihenfolge in index.html muss boot → ORDER → app sein. Sonst läuft der Test
// grün, während der Browser eine Datei vor ihrer Abhängigkeit lädt (die storage.js-Lücke aus
// BAUPLAN Abschnitt 2: Datei vorhanden, aber nie geladen).
function scriptOrderInHtml() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const re = /<script\b[^>]*\bsrc="\.\/js\/([a-z0-9-]+)\.js(?:\?v=[^"]*)?"/g;
  const names = [];
  let m;
  while ((m = re.exec(html)) !== null) { names.push(m[1]); }
  return names;
}

const expected = ['boot'].concat(ORDER, ['app']);
const actual = scriptOrderInHtml();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('[tests/_load] Skriptreihenfolge in index.html weicht ab.\n  erwartet: ' +
    expected.join(' → ') + '\n  gefunden: ' + actual.join(' → '));
}

const missing = [];

for (const name of ORDER) {
  const file = path.join(__dirname, '..', 'js', name + '.js');
  try {
    require(file);
  } catch (e) {
    // Nur das Fehlen der Datei selbst ist erlaubt; Fehler IN einer Datei sollen die Tests brechen.
    const notFound = e && e.code === 'MODULE_NOT_FOUND' &&
      String(e.message).includes(path.basename(file));
    if (!notFound) { throw e; }
    missing.push(name);
  }
}

if (missing.length) {
  process.stderr.write('[tests/_load] noch nicht gebaut: ' + missing.join(', ') + '\n');
}

const Heizwarte = globalThis.Heizwarte || {};
Object.defineProperty(Heizwarte, '_missing', { value: missing, enumerable: false, configurable: true });

module.exports = Heizwarte;
