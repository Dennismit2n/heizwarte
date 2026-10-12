/*
 * Heizwarte — einmaliges Werkzeug: wandelt den wx-data-Block der Bürg-Fassung nach timeformat=unixtime.
 *
 * Quelle: ${BUERG}/index.html, Zeile 212, <script id="wx-data" type="application/json">. Darin steht unter
 * "om" eine ECHTE Open-Meteo-Antwort vom 09.10.2026 (5 Tage, 08.–12.10., timezone Europe/Berlin,
 * utc_offset_seconds 7200, iso8601 ohne Offset). Heizwarte fragt dagegen mit timeformat=unixtime ab
 * (BAUPLAN Abschnitt 5, weather). Dieses Skript schreibt dieselben Werte in der neuen Form:
 *   - hourly.time, current.time, daily.time, daily.sunrise, daily.sunset als Epoch-Sekunden;
 *     daily.time ist die Ortsmitternacht des Tages (mit dem festen Offset der Antwort)
 *   - die zugehörigen *_units auf "unixtime"
 *   - alle Messwerte unverändert
 * Es schreibt nur den Teil "om" (eine reine Open-Meteo-Antwort) nach om-buerg-2026-10-09.json neben dieses
 * Skript. MOSMIX ("mos") und Warnungen ("alerts") aus dem Block bleiben unberührt; kein Live-Aufruf.
 *
 * Aufruf (nur wenn die Fixture neu entstehen soll):
 *   node tests/fixtures/_buerg-nach-unixtime.mjs [Pfad zum Bürg-Ordner]
 * Standard für den Ordner: C:/Users/danyr/source/repos/dennismit2n.github.io/heizwarte (oder Umgebungsvariable BUERG).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const BUERG = process.argv[2] || process.env.BUERG || 'C:/Users/danyr/source/repos/dennismit2n.github.io/heizwarte';
const AUS = path.join(HIER, 'om-buerg-2026-10-09.json');

const html = fs.readFileSync(path.join(BUERG, 'index.html'), 'utf8');
const m = html.match(/<script id="wx-data" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { throw new Error('wx-data-Block nicht gefunden in ' + BUERG); }
const om = JSON.parse(m[1]).om;

const offset = om.utc_offset_seconds;

// Versatz der Zone in Sekunden zu einem Zeitpunkt, über Intl gemessen (unabhängig von der Prozess-Zeitzone)
function offsetAt(epochSec, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const x of f.formatToParts(epochSec * 1000)) { p[x.type] = x.value; }
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
  return wall - epochSec;
}

// "2026-10-08T07:31" (Berliner Wanduhrzeit) oder "2026-10-08" → Epoch-Sekunden mit dem festen Offset der Antwort
function toEpoch(s) {
  const [d, t] = s.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = (t || '00:00').split(':').map(Number);
  const sec = Date.UTC(y, mo - 1, da, h, mi) / 1000 - offset;
  // Gegenprobe: die Zone muss zu diesem Zeitpunkt wirklich den Offset der Antwort haben (sonst läge ein
  // Umstellungstag im Fenster und der feste Offset stimmte nicht)
  if (offsetAt(sec, om.timezone) !== offset) {
    throw new Error('Offset passt nicht zu ' + s + ' in ' + om.timezone);
  }
  return sec;
}

const out = JSON.parse(JSON.stringify(om));
out.current.time = toEpoch(om.current.time);
out.current_units.time = 'unixtime';
out.hourly.time = om.hourly.time.map(toEpoch);
out.hourly_units.time = 'unixtime';
out.daily.time = om.daily.time.map(toEpoch);
out.daily.sunrise = om.daily.sunrise.map(toEpoch);
out.daily.sunset = om.daily.sunset.map(toEpoch);
out.daily_units.time = 'unixtime';
out.daily_units.sunrise = 'unixtime';
out.daily_units.sunset = 'unixtime';

// eine Zeile je Spalte: lesbar im Diff, ohne die Datei in tausend Zeilen zu zerlegen
function schreibe(v, einzug) {
  const pad = '  '.repeat(einzug);
  if (Array.isArray(v)) { return JSON.stringify(v); }
  if (v && typeof v === 'object') {
    const teile = Object.keys(v).map((k) => pad + '  ' + JSON.stringify(k) + ': ' + schreibe(v[k], einzug + 1));
    return '{\n' + teile.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(v);
}

fs.writeFileSync(AUS, schreibe(out, 0) + '\n', 'utf8');
console.log('geschrieben:', AUS, '(' + out.hourly.time.length + ' Stunden, ' + out.daily.time.length + ' Tage)');
