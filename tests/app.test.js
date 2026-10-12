/*
 * Heizwarte — Tests für die reinen Zeilenfunktionen in js/app.js (verdictLines, planRows und statusLines), ohne DOM
 *
 * app.js ist die einzige Datei, die beim Laden etwas tut, aber nur, wenn es ein document gibt. In Node ist keins da,
 * also lässt sich die Datei laden und ihr Node-Export (nur diese drei Funktionen) benutzen. Die Tests füttern sie mit
 * echten Ergebnissen von heat.assess() auf den Fixtures und mit dem echten i18n.t(); die Formatierer (fmt) sind
 * kleine Ersatzobjekte, die zählen, ob der Start-Zweig überhaupt gerufen wird. Damit ist der Nachtspeicher-Zweig
 * bewiesen: keine Startzeit, keine Aufheizzeit, dafür die Aufladung am Abend. Danach steht die Zustandstabelle der
 * Statuszeile (BAUPLAN Abschnitt 8, Block 2): jeder Zustand, die 26-Stunden-Grenze, kein Cache, zu alte Daten.
 * Seit Review Runde 2 zusätzlich: die Zeitlogik des Fahrplans (whenPhrase, nightName, planWhen) über die
 * Uhrumstellung am 25.10.2026 und in Lissabon, der Jetzt-Block (currentOf) in der doppelten Stunde, der Umriss
 * (extentLine) ohne feste Einheit und die Hausnummer (extractNumber) mit „12/1“ und „5-7“.
 * Am Ende die Regeln der Einstellungen (BAUPLAN Abschnitt 7 und 8): Stepper-Grenzen und Schrittweite, leadMin ≤ leadMax,
 * die Höhenregel (Zahl von Hand, leer automatisch, ungültig nichts), Löschen mit Nachrücken und der Ortsname.
 * Zuletzt die Regeln der Ortsliste (BAUPLAN Abschnitt 4, 6 und 8): höchstens fünf Orte, der aktive Ort, wenn
 * hw:active fehlt oder ins Leere zeigt, und wann der Umschalter im Kopf steht.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const {
  verdictLines, planRows, statusLines, currentOf, extentLine, extractNumber, whenPhrase, nightName, planWhen,
  STEPPERS, stepValue, applyStep, parseElev, elevPatch, afterDelete, cleanLabel,
  MAX_PLACES, canAddPlace, appendPlace, resolveActive, showsSwitcher
} = require('../js/app.js');
const heat = Heizwarte.heat;
const weather = Heizwarte.weather;
const i18n = Heizwarte.i18n;

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function modelOf(name) {
  return weather.model({ v: 2, fetched: 0, om: fixture(name), mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

const PROF = {
  floorScreed: { type: 'floorScreed', leadMin: 3, leadMax: 6, comfort: 20, thresh: null, confirmed: true },
  radiator: { type: 'radiator', leadMin: 0.5, leadMax: 2, comfort: 20, thresh: null, confirmed: true },
  storage: { type: 'storage', leadMin: null, leadMax: null, comfort: 20, thresh: null, confirmed: true }
};

function placeOf(heatProfile) {
  return { id: '0a1b2c3d', label: 'Opa', cc: 'DE', heat: heatProfile };
}

// 13.01.2026 10:00 in Berlin (UTC+1): „heute“ ist Tag 1 der konstruierten Fixtures (past_days=1)
const JAN13_MS = Date.UTC(2026, 0, 13, 9, 0);
// 13.01.2026 23:00 in Berlin: die Nacht läuft, der Start der Fußbodenheizung ist längst fällig
const JAN13_NIGHT_MS = Date.UTC(2026, 0, 13, 22, 0);

// Ergebnis von heat.assess() samt Modell und Jetzt, so wie app.js es in buildView() zusammenstellt
function viewOf(name, profile, nowMs) {
  const m = modelOf(name);
  const now = weather.localNow(m.tz, nowMs === undefined ? JAN13_MS : nowMs);
  const v = heat.assess(m, now, profile, []);
  return { m, now, v, todayIdx: m.days.findIndex((d) => d.key === now.key) };
}

// Wie numAuto in app.js: höchstens eine Nachkommastelle, ohne „,0“
function roundedNum(x) {
  const r = Math.round(x * 10) / 10;
  return i18n.fmt.num(r, Number.isInteger(r) ? 0 : 1);
}

// Formatierer für planRows: echter Text aus i18n, Ortszeit des Orts. startLine ist ein Ersatz, der mitzählt; er soll
// beim Nachtspeicher nie gerufen werden.
function fmtFor(view, over) {
  const f = i18n.fmt;
  const tz = view.m.tz;
  const calls = { startLine: 0, isDue: 0 };
  const fmt = {
    t: i18n.t,
    time: (ms) => f.time(ms, tz),
    deg: (x, digits) => f.deg(x, digits),
    num: roundedNum,
    todayIdx: view.todayIdx,
    mosNear: false,
    nightName: (night) => {
      const off = night.dayIdx - view.todayIdx;
      return i18n.t('planNightOf', { day: off === 0 ? i18n.t('dayToday') : (off === 1 ? i18n.t('dayTomorrow') : 'Tag ' + off) });
    },
    isDue: (entry, night) => { calls.isDue++; return heat.isDue(entry, view.now.ms, night.toMs); },
    startLine: (entry, night, due) => {
      calls.startLine++;
      return due ? 'Jetzt' : i18n.t('planStart', { time: f.time(entry.startMs, tz) });
    },
    when: () => 'ZEIT'
  };
  return { fmt: Object.assign(fmt, over || {}), calls };
}

function texts(row) {
  return row.lines.map((l) => l.text);
}

function classes(row) {
  return row.lines.map((l) => l.cls);
}

// Wörter, die beim Nachtspeicher nirgends stehen dürfen: Startzeit, Aufheizzeit, Hinweise nur für Heizarten mit Start
const NUR_MIT_START = /Start|Aufheizzeit|Abkühlung ab|Böen|fällig|optional|Heizung eine Stufe|Normal heizen|Sparsam|Durchheizen/;

// ---------------------------------------------------------------------------------------------
// planRows: Nachtspeicher
// ---------------------------------------------------------------------------------------------

test('planRows Nachtspeicher: je Abend die Aufladung, heute mit chargeTonight, danach mit planChargeEvening', () => {
  const view = viewOf('om-sturz.json', PROF.storage);
  const { fmt } = fmtFor(view);
  const rows = planRows(view.v, placeOf(PROF.storage), fmt);

  assert.equal(rows.length, 3, 'eine Karte je Nacht');
  assert.deepEqual(rows.map((r) => r.head), ['Heute Nacht', 'Morgen Nacht', 'Tag 2 Nacht']);
  // Nächte 6 / 3 / 1 °C → normal / up / up (heat.test.js)
  assert.equal(rows[0].lines[0].cls, 'plan-when');
  assert.equal(rows[0].lines[0].text, 'Aufladung heute Abend: normal');
  assert.equal(rows[1].lines[0].text, 'Aufladung am Abend: höher');
  assert.equal(rows[2].lines[0].text, 'Aufladung am Abend: höher');
});

test('planRows Nachtspeicher: keine Startzeile, keine Aufheizzeit, keine Heizstufe, keine Zusätze', () => {
  for (const name of ['om-sturz.json', 'om-frost.json', 'om-mild.json', 'om-sturm.json']) {
    const view = viewOf(name, PROF.storage);
    const { fmt, calls } = fmtFor(view);
    const rows = planRows(view.v, placeOf(PROF.storage), fmt);
    assert.ok(rows.length > 0, name);
    assert.equal(calls.startLine, 0, name + ': die Startzeile wird nie gebaut');
    assert.equal(calls.isDue, 0, name + ': „Start fällig“ wird nie gefragt');
    for (const row of rows) {
      for (const cls of classes(row)) {
        assert.ok(['plan-when', 'plan-meta', 'plan-note'].includes(cls), name + ': Zeile ' + cls + ' gibt es nur mit Start');
      }
      for (const text of texts(row)) { assert.doesNotMatch(text, NUR_MIT_START, name + ': ' + text); }
      assert.equal(row.lines.filter((l) => l.cls === 'plan-meta').length, 1, name + ': nur der Tiefstwert, kein Abkühlungs-Satz');
    }
  }
});

test('planRows Nachtspeicher: die vier Aufladungsstufen aus dem Wetter', () => {
  const stufe = (name) => planRows(viewOf(name, PROF.storage).v, placeOf(PROF.storage), fmtFor(viewOf(name, PROF.storage)).fmt)[0].lines[0].text;
  assert.equal(stufe('om-frost.json'), 'Aufladung heute Abend: deutlich höher');
  assert.equal(stufe('om-sturz.json'), 'Aufladung heute Abend: normal');
  assert.equal(stufe('om-mild.json'), 'Aufladung heute Abend: niedrig');
  // „höher“ (up): Nacht zwischen 0 und 5 °C
  const view = viewOf('om-sturz.json', PROF.storage);
  const v = clone(view.v);
  v.plan[0].charge = 'up';
  assert.equal(planRows(v, placeOf(PROF.storage), fmtFor(view).fmt)[0].lines[0].text, 'Aufladung heute Abend: höher');
});

test('planRows Nachtspeicher: Tiefstwert mit Uhrzeit, wie bei jeder Heizart', () => {
  const view = viewOf('om-frost.json', PROF.storage);
  const { fmt } = fmtFor(view);
  const rows = planRows(view.v, placeOf(PROF.storage), fmt);
  const n = view.v.nights[0];
  const meta = rows[0].lines.find((l) => l.cls === 'plan-meta');
  assert.equal(meta.text, i18n.t('planNightMin', { t: i18n.fmt.deg(n.min, 1), time: i18n.fmt.time(n.atMs, view.m.tz) }));
  assert.match(meta.text, /^Tiefster Wert [−\d]/);
});

test('planRows Nachtspeicher: auch mitten in der Nacht keine Startzeile und kein „Start fällig“', () => {
  const view = viewOf('om-frost.json', PROF.storage, JAN13_NIGHT_MS);
  const { fmt, calls } = fmtFor(view);
  const rows = planRows(view.v, placeOf(PROF.storage), fmt);
  assert.equal(calls.startLine, 0);
  for (const row of rows) { for (const text of texts(row)) { assert.doesNotMatch(text, /fällig|Jetzt/, text); } }
});

test('planRows Nachtspeicher: die zweite Meinung gilt auch hier, aber nur mit naher Station und Zahl', () => {
  const view = viewOf('om-frost.json', PROF.storage);
  const v = clone(view.v);
  v.plan[0].disagree = true;
  v.nights[0].mosMin = v.nights[0].min + 3;
  const mit = planRows(v, placeOf(PROF.storage), fmtFor(view, { mosNear: true }).fmt);
  const note = mit[0].lines.filter((l) => l.cls === 'plan-note');
  assert.equal(note.length, 1);
  assert.match(note[0].text, /^Die zweite Meinung sagt /);
  // Station zu weit weg: kein Satz, kein Fehlerhinweis
  const fern = planRows(v, placeOf(PROF.storage), fmtFor(view, { mosNear: false }).fmt);
  assert.equal(fern[0].lines.filter((l) => l.cls === 'plan-note').length, 0);
  // Station nah, aber ohne Zahl für diese Nacht: ebenfalls kein Satz
  const w = clone(v);
  w.nights[0].mosMin = null;
  assert.equal(planRows(w, placeOf(PROF.storage), fmtFor(view, { mosNear: true }).fmt)[0].lines.filter((l) => l.cls === 'plan-note').length, 0);
});

test('planRows Nachtspeicher: die Heizart des Orts entscheidet, ein Eintrag ohne charge bekommt trotzdem keinen Start', () => {
  const view = viewOf('om-frost.json', PROF.storage);
  const v = clone(view.v);
  for (const e of v.plan) { e.charge = null; }
  const { fmt, calls } = fmtFor(view);
  const rows = planRows(v, placeOf(PROF.storage), fmt);
  assert.equal(calls.startLine, 0, 'Ort ist Nachtspeicher: nie eine Startzeile');
  for (const row of rows) {
    assert.ok(!classes(row).includes('plan-when'), 'ohne charge gibt es keine Aufladungszeile');
    assert.ok(classes(row).includes('plan-meta'), 'der Tiefstwert bleibt');
  }
});

test('planRows: ein Eintrag mit charge zählt als Nachtspeicher, auch wenn der Ort etwas anderes sagt', () => {
  const view = viewOf('om-frost.json', PROF.storage);
  const { fmt, calls } = fmtFor(view);
  const rows = planRows(view.v, placeOf(PROF.floorScreed), fmt);
  assert.equal(calls.startLine, 0);
  assert.equal(rows[0].lines[0].text, 'Aufladung heute Abend: deutlich höher');
});

// ---------------------------------------------------------------------------------------------
// planRows: Heizarten mit Start (zum Vergleich)
// ---------------------------------------------------------------------------------------------

test('planRows Fußbodenheizung: Startzeile, Heizstufe, Tiefstwert und Aufheizzeit, nirgends eine Aufladung', () => {
  const view = viewOf('om-frost.json', PROF.floorScreed);
  const { fmt, calls } = fmtFor(view);
  const rows = planRows(view.v, placeOf(PROF.floorScreed), fmt);

  assert.equal(rows.length, 3);
  assert.equal(calls.startLine, 3, 'eine Startzeile je Nacht');
  const first = rows[0];
  assert.deepEqual(classes(first), ['plan-when', 'plan-strength', 'plan-meta', 'plan-meta']);
  assert.match(first.lines[0].text, /^Start ab \d{1,2}:\d{2}$/);
  assert.equal(first.lines[1].text, i18n.t('strengthThrough'));
  const e = view.v.plan[0];
  assert.equal(first.lines[3].text, i18n.t('planLead', { onset: i18n.fmt.time(e.onsetMs, view.m.tz), lead: roundedNum(e.lead) }));
  assert.match(first.lines[3].text, /Aufheizzeit: \d(,\d)? h\.$/);
  assert.ok(e.lead > 2, 'die Fußbodenheizung im Estrich heizt länger vor als ein Heizkörper');
  for (const row of rows) { for (const text of texts(row)) { assert.doesNotMatch(text, /Aufladung/, text); } }
});

test('planRows Fußbodenheizung: mitten in der Nacht steht „Start fällig“, Böen und optional kommen dazu', () => {
  const nacht = viewOf('om-frost.json', PROF.floorScreed, JAN13_NIGHT_MS);
  const rows = planRows(nacht.v, placeOf(PROF.floorScreed), fmtFor(nacht).fmt);
  assert.equal(rows[0].lines[0].text, 'Jetzt');
  assert.equal(rows[0].lines.find((l) => l.cls === 'plan-tag').text, 'Start fällig');

  const view = viewOf('om-frost.json', PROF.floorScreed);
  const v = clone(view.v);
  v.plan[1].gusty = true;
  v.plan[2].optional = true;
  const r = planRows(v, placeOf(PROF.floorScreed), fmtFor(view).fmt);
  assert.equal(r[1].lines.find((l) => l.cls === 'plan-note').text, i18n.t('planGusty'));
  assert.equal(r[2].lines.find((l) => l.cls === 'plan-tag').text, 'optional');
});

test('planRows Heizkörper gegen Fußboden: dieselben Karten, aber die Aufheizzeit kommt aus dem Profil', () => {
  const va = viewOf('om-frost.json', PROF.radiator);
  const vb = viewOf('om-frost.json', PROF.floorScreed);
  const a = planRows(va.v, placeOf(PROF.radiator), fmtFor(va).fmt);
  const b = planRows(vb.v, placeOf(PROF.floorScreed), fmtFor(vb).fmt);
  assert.ok(a[0].lines.at(-1).text.endsWith('Aufheizzeit: ' + roundedNum(va.v.plan[0].lead) + ' h.'));
  assert.ok(b[0].lines.at(-1).text.endsWith('Aufheizzeit: ' + roundedNum(vb.v.plan[0].lead) + ' h.'));
  assert.ok(va.v.plan[0].lead < vb.v.plan[0].lead, 'Heizkörper heizt kürzer vor');
  assert.equal(a.length, b.length);
});

// ---------------------------------------------------------------------------------------------
// planRows: Randfälle
// ---------------------------------------------------------------------------------------------

test('planRows: ohne Ampel, ohne Plan oder ohne passende Nacht kommt eine leere Liste, kein Wurf', () => {
  const view = viewOf('om-frost.json', PROF.storage);
  const { fmt } = fmtFor(view);
  assert.deepEqual(planRows(null, placeOf(PROF.storage), fmt), []);
  assert.deepEqual(planRows(undefined, placeOf(PROF.storage), fmt), []);
  assert.deepEqual(planRows({ level: null, plan: [], nights: [] }, placeOf(PROF.storage), fmt), []);
  assert.deepEqual(planRows({ level: 1 }, placeOf(PROF.storage), fmt), []);
  // mehr Einträge als Nächte: die Einträge ohne Nacht fallen weg
  const v = clone(view.v);
  v.nights = v.nights.slice(0, 1);
  assert.equal(planRows(v, placeOf(PROF.storage), fmt).length, 1);
  // Ort ohne Heizart: wie eine Heizart mit Start
  const { fmt: f2, calls } = fmtFor(viewOf('om-frost.json', PROF.floorScreed));
  assert.equal(planRows(viewOf('om-frost.json', PROF.floorScreed).v, { id: 'x' }, f2).length, 3);
  assert.equal(calls.startLine, 3);
});

test('planRows: reiner Text, keine Elemente, und die Eingaben bleiben unverändert', () => {
  const view = viewOf('om-sturz.json', PROF.storage);
  const vor = JSON.stringify(view.v);
  const rows = planRows(view.v, placeOf(PROF.storage), fmtFor(view).fmt);
  assert.equal(JSON.stringify(view.v), vor, 'planRows verändert die Ampel nicht');
  for (const row of rows) {
    assert.equal(typeof row.head, 'string');
    for (const line of row.lines) {
      assert.equal(typeof line.cls, 'string');
      assert.equal(typeof line.text, 'string');
      assert.ok(line.text.length > 0);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// verdictLines: die Ampel
// ---------------------------------------------------------------------------------------------

test('verdictLines Nachtspeicher: ab Stufe 1 steht chargeTonight statt levelTitle1–3, ohne Aufheizzeit-Satz', () => {
  for (const [name, erwartet] of [['om-frost.json', 'Aufladung heute Abend: deutlich höher'], ['om-sturz.json', 'Aufladung heute Abend: normal']]) {
    const view = viewOf(name, PROF.storage);
    assert.ok(view.v.level >= 1, name + ' ist mindestens Stufe 1');
    const { fmt, calls } = fmtFor(view);
    let whenCalls = 0;
    fmt.when = () => { whenCalls++; return 'ZEIT'; };
    const out = verdictLines(view.v.level, view.v.plan[0], placeOf(PROF.storage), fmt);
    assert.equal(out.action, erwartet, name);
    assert.equal(out.body, '', name + ': kein Satz über Aufheizzeit');
    assert.equal(whenCalls, 0, name + ': kein Satzteil „heute ab 15:00“');
    assert.equal(calls.startLine, 0);
  }
});

test('verdictLines Fußbodenheizung: levelTitle mit Satzteil und levelText mit Aufheizzeit', () => {
  const view = viewOf('om-frost.json', PROF.floorScreed);
  const { fmt } = fmtFor(view);
  const out = verdictLines(view.v.level, view.v.plan[0], placeOf(PROF.floorScreed), fmt);
  assert.equal(out.action, 'Heizung ZEIT deutlich hochdrehen.');
  const e = view.v.plan[0];
  assert.equal(out.body, i18n.t('levelText2', { onset: i18n.fmt.time(e.onsetMs, view.m.tz), lead: roundedNum(e.lead) }));
  assert.match(out.body, /^Abkühlung setzt gegen \d{1,2}:\d{2} ein\. Bei \d(,\d)? h Aufheizzeit musst du vorher starten\.$/);
  assert.doesNotMatch(out.action, /Aufladung/);
});

test('verdictLines: Aufheizzeit 1 heißt „1 h“, nie „1 Stunden“ (Heizkörper, Trockenbau; alle drei Stufen gleich)', () => {
  const view = viewOf('om-frost.json', PROF.radiator);
  const { fmt } = fmtFor(view);
  const e = Object.assign({}, view.v.plan[0], { lead: 1 });
  for (const level of [1, 2, 3]) {
    const out = verdictLines(level, e, placeOf(PROF.radiator), fmt);
    assert.match(out.body, /Bei 1 h Aufheizzeit musst du vorher starten\.$/, 'Stufe ' + level);
    assert.doesNotMatch(out.body, /Stunden/, 'Stufe ' + level);
  }
  const halb = verdictLines(1, Object.assign({}, e, { lead: 0.5 }), placeOf(PROF.radiator), fmt);
  assert.match(halb.body, /Bei 0,5 h Aufheizzeit/);
  // derselbe Wortlaut wie im Fahrplan (planLead): Zahl und „h“
  assert.match(i18n.t('planLead', { onset: '22:00', lead: '1' }), /1 h\.$/);
});

test('verdictLines: Stufe 0 ist für jede Heizart dieselbe; ab Stufe 1 ohne Eintrag bleiben beide Zeilen leer', () => {
  const view = viewOf('om-mild.json', PROF.storage);
  assert.equal(view.v.level, 0);
  const { fmt } = fmtFor(view);
  const speicher = verdictLines(0, view.v.plan[0], placeOf(PROF.storage), fmt);
  const boden = verdictLines(0, view.v.plan[0], placeOf(PROF.floorScreed), fmt);
  assert.deepEqual(speicher, boden);
  assert.equal(speicher.action, i18n.t('levelTitle0'));
  assert.equal(speicher.body, i18n.t('levelText0'));
  // Der Satz von Stufe 0 („Normalbetrieb“) widerspräche einer Überschrift „Stufe 2 von 3“; die Zeilen bleiben leer
  for (const level of [1, 2, 3]) {
    for (const prof of [PROF.storage, PROF.floorScreed, PROF.radiator]) {
      assert.deepEqual(verdictLines(level, null, placeOf(prof), fmt), { action: '', body: '' }, 'Stufe ' + level + ' ' + prof.type);
    }
  }
});

test('verdictLines Nachtspeicher: ohne charge im Eintrag bleibt der Handlungssatz leer statt einer falschen Startzeit', () => {
  const view = viewOf('om-frost.json', PROF.storage);
  const e = Object.assign({}, view.v.plan[0], { charge: null });
  const out = verdictLines(2, e, placeOf(PROF.storage), fmtFor(view).fmt);
  assert.deepEqual(out, { action: '', body: '' });
});

// ---------------------------------------------------------------------------------------------
// Beweis: Ortszeit statt Gerätezeit
// ---------------------------------------------------------------------------------------------

test('Beweis: planRows und verdictLines liefern unter jeder Prozess-Zeitzone denselben Text', () => {
  const { execFileSync } = require('node:child_process');
  const skript = `
    const H = require(${JSON.stringify(path.join(__dirname, '_load.js'))});
    const { planRows, verdictLines } = require(${JSON.stringify(path.join(__dirname, '..', 'js', 'app.js'))});
    const fs = require('node:fs');
    const om = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'om-frost.json'))}, 'utf8'));
    const m = H.weather.model({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
    const now = H.weather.localNow(m.tz, ${JAN13_MS});
    const prof = { type: 'floorScreed', leadMin: 3, leadMax: 6, comfort: 20, thresh: null, confirmed: true };
    const v = H.heat.assess(m, now, prof, []);
    const f = H.i18n.fmt;
    const today = m.days.findIndex((d) => d.key === now.key);
    const fmt = { t: H.i18n.t, time: (ms) => f.time(ms, m.tz), deg: (x, d) => f.deg(x, d), num: (x) => f.num(x, 1),
      todayIdx: today, mosNear: false, nightName: (n) => 'N' + n.dayIdx, isDue: (e, n) => H.heat.isDue(e, now.ms, n.toMs),
      startLine: (e) => f.time(e.startMs, m.tz), when: () => 'W' };
    process.stdout.write(JSON.stringify([planRows(v, { heat: prof }, fmt), verdictLines(v.level, v.plan[0], { heat: prof }, fmt)]));
  `;
  const lauf = (tz) => execFileSync(process.execPath, ['-e', skript], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
  const berlin = lauf('Europe/Berlin');
  assert.ok(berlin.length > 200);
  assert.equal(lauf('Pacific/Auckland'), berlin);
  assert.equal(lauf('America/New_York'), berlin);
});

// ---------------------------------------------------------------------------------------------
// statusLines: die Zustandstabelle der Statuszeile (BAUPLAN Abschnitt 8, Block 2)
// ---------------------------------------------------------------------------------------------

const de = i18n.I18N.de;
const HOUR_MS = 3600000;
const BERLIN = 'Europe/Berlin';
// 13.01.2026 13:30 in Berlin (UTC+1)
const STATUS_NOW = Date.UTC(2026, 0, 13, 12, 30);

// Die Sätze der Tabelle, wörtlich (so fängt der Test auch einen vertauschten Schlüssel)
const S = {
  loading: 'Wird aktualisiert …',
  stale: '⚠ Veraltet – älter als einen Tag.',
  offline: '⚠ Veraltet – gerade keine Verbindung. Sobald du wieder Netz hast, tippe auf Neu laden.',
  failed: '⚠ Veraltet – der Wetterdienst hat nicht geantwortet. Tippe auf Neu laden.',
  waiting60: 'Der Wetterdienst ist gerade ausgelastet. Heizwarte versucht es in 60 Sekunden noch einmal.',
  rateLimited: '⚠ Veraltet – der Wetterdienst ist ausgelastet. Versuch es in ein paar Minuten mit Neu laden.',
  noData: 'Noch keine Wetterdaten. Tippe auf Neu laden.'
};

// Formatierer wie statusFmt() in app.js, nur mit fester Zeitzone und Sprache statt Seitenzustand
function statusFmt(over) {
  const f = i18n.fmt;
  return Object.assign({
    t: i18n.t,
    staleHours: heat.THRESH.staleHours,
    when: (ms, nowMs) => f.when(ms, nowMs, BERLIN, 'de'),
    rel: (ms, nowMs) => f.rel(ms, nowMs, 'de')
  }, over || {});
}

function cacheAged(hours) {
  return { v: 2, fetched: STATUS_NOW - hours * HOUR_MS };
}

function statusOf(status, cache, extra, over) {
  return statusLines(Object.assign({ status, waitS: 0, tooOld: false }, extra || {}), cache, STATUS_NOW, statusFmt(over));
}

function pairs(lines) {
  return lines.map((l) => [l.cls, l.text]);
}

test('statusLines mit Cache: Satz 1 ist der Stand, Satz 2 folgt der Tabelle je Zustand', () => {
  const cache = cacheAged(3);
  const stand = ['status-stamp', 'Stand: heute 10:30 (vor 3 Stunden).'];
  assert.deepEqual(pairs(statusOf('loading', cache)), [stand, ['status-info', S.loading]]);
  assert.deepEqual(pairs(statusOf('live', cache)), [stand]);
  assert.deepEqual(pairs(statusOf(null, cache)), [stand], 'vor dem ersten Abruf: nur der Stand');
  assert.deepEqual(pairs(statusOf('offline', cache)), [stand, ['status-warn', S.offline]]);
  assert.deepEqual(pairs(statusOf('failed', cache)), [stand, ['status-warn', S.failed]]);
  assert.deepEqual(pairs(statusOf('waiting', cache, { waitS: 60 })), [stand, ['status-info', S.waiting60]]);
  assert.deepEqual(pairs(statusOf('rateLimited', cache)), [stand, ['status-warn', S.rateLimited]]);
});

test('statusLines: der Stand kommt aus dem Cache, die Zeitzone aus fmt, nie aus dem Gerät', () => {
  const cache = cacheAged(3);
  const auckland = statusOf('live', cache, null, { when: (ms, nowMs) => i18n.fmt.when(ms, nowMs, 'Pacific/Auckland', 'de') });
  // 09:30 UTC ist in Auckland (UTC+13) 22:30 und dort schon „gestern“, denn „jetzt“ ist dort 01:30 am Folgetag; in Berlin 10:30
  assert.equal(auckland[0].text, 'Stand: gestern 22:30 (vor 3 Stunden).');
  assert.equal(statusOf('live', cache)[0].text, 'Stand: heute 10:30 (vor 3 Stunden).');
  // gestern, wenn der Abruf vor Mitternacht der Ortszeit lag
  assert.equal(statusOf('live', cacheAged(14))[0].text, 'Stand: gestern 23:30 (vor 14 Stunden).');
});

test('statusLines ohne Cache: kein Stand; loading und waiting stehen allein, jeder Fehler heißt statusNoData', () => {
  assert.deepEqual(pairs(statusOf('loading', null)), [['status-info', S.loading]]);
  assert.deepEqual(pairs(statusOf('waiting', null, { waitS: 60 })), [['status-info', S.waiting60]]);
  for (const status of ['noCache', 'offline', 'failed', 'rateLimited']) {
    assert.deepEqual(pairs(statusOf(status, null)), [['status-info', S.noData]], status);
  }
  // noch nichts bekannt: keine Zeile, kein Platzhaltertext
  assert.deepEqual(statusOf(null, null), []);
  assert.deepEqual(statusOf('live', null), []);
  assert.deepEqual(statusLines(null, null, STATUS_NOW, statusFmt()), []);
  assert.deepEqual(statusLines(undefined, undefined, STATUS_NOW, statusFmt()), []);
  // ein Cache ohne brauchbaren Abrufzeitpunkt zählt nicht als Stand
  for (const kaputt of [{ v: 2 }, { v: 2, fetched: NaN }, { v: 2, fetched: '12:00' }, {}]) {
    assert.deepEqual(pairs(statusOf('noCache', kaputt)), [['status-info', S.noData]]);
    assert.deepEqual(statusOf('live', kaputt), []);
  }
  // noCache mit Cache widerspräche sich (onFetchFailed setzt es nur ohne Cache): der Stand bleibt, kein falscher Satz
  assert.deepEqual(pairs(statusOf('noCache', cacheAged(3))), [['status-stamp', 'Stand: heute 10:30 (vor 3 Stunden).']]);
});

test('statusLines: ohne Netz steht „⚠ Veraltet“ unabhängig vom Alter, genau einmal', () => {
  for (const status of ['offline', 'failed', 'rateLimited']) {
    for (const hours of [0.01, 1, 25, 26, 26.5, 100, 24 * 40]) {
      const lines = statusOf(status, cacheAged(hours));
      assert.equal(lines.length, 2, status + ' ' + hours + ' h: Stand und ein Satz');
      assert.equal(lines[0].cls, 'status-stamp');
      assert.equal(lines[1].cls, 'status-warn');
      assert.match(lines[1].text, /^⚠ Veraltet – /, status + ' ' + hours + ' h');
      assert.equal(lines.filter((l) => /Veraltet/.test(l.text)).length, 1, status + ' ' + hours + ' h: kein zweites „Veraltet“ durch statusStale');
    }
  }
});

test('statusLines: statusStale erst über 26 Stunden, auch mit Netz', () => {
  // genau an der Grenze: noch nicht
  assert.deepEqual(pairs(statusOf('live', cacheAged(26))).map((p) => p[1]).filter((x) => /Veraltet/.test(x)), []);
  assert.equal(statusOf('live', cacheAged(25.99)).length, 1);
  // knapp darüber: der Satz kommt dazu, mit Symbol und Wort
  const alt = statusOf('live', cacheAged(26.01));
  assert.deepEqual(pairs(alt.slice(1)), [['status-warn', S.stale]]);
  assert.deepEqual(pairs(statusOf(null, cacheAged(48)).slice(1)), [['status-warn', S.stale]]);
  // während des Abrufs: Hinweis und Warnung nebeneinander, nur bei Alter über der Grenze
  assert.deepEqual(pairs(statusOf('loading', cacheAged(2)).slice(1)), [['status-info', S.loading]]);
  assert.deepEqual(pairs(statusOf('loading', cacheAged(30)).slice(1)), [['status-info', S.loading], ['status-warn', S.stale]]);
  assert.deepEqual(pairs(statusOf('waiting', cacheAged(30), { waitS: 60 }).slice(1)), [['status-info', S.waiting60], ['status-warn', S.stale]]);
  // die Grenze kommt aus fmt (heat.THRESH.staleHours = 26), nicht aus einer zweiten Zahl in der Funktion
  assert.equal(heat.THRESH.staleHours, 26);
  assert.equal(statusOf('live', cacheAged(10), null, { staleHours: 6 }).length, 2);
  assert.equal(statusOf('live', cacheAged(10), null, { staleHours: 12 }).length, 1);
});

test('statusLines: zu alte Daten (Ampel ohne Stufe) zeigen Stand und statusStale, nie ein zweites errTooOld', () => {
  // Echter Fall: zehn Tage nach dem Abruf liegt „heute“ nicht mehr im Fenster, assess() liefert level null
  const m = modelOf('om-frost.json');
  const spaeter = JAN13_MS + 10 * 24 * HOUR_MS;
  const v = heat.assess(m, weather.localNow(m.tz, spaeter), PROF.floorScreed, []);
  assert.equal(v.level, null);
  assert.deepEqual(v.plan, [], 'Fahrplan fällt weg, die Ampel sagt errTooOld');
  const cache = { v: 2, fetched: JAN13_MS - HOUR_MS };
  const lines = statusLines({ status: 'live', waitS: 0, tooOld: v.level === null }, cache, spaeter, statusFmt());
  assert.equal(lines.length, 2);
  assert.match(lines[0].text, /^Stand: .+ \(vor 10 Tagen\)\.$/);
  assert.deepEqual(pairs(lines.slice(1)), [['status-warn', S.stale]]);
  // tooOld allein genügt, auch wenn der Abruf jung ist (Geräteuhr zurückgestellt)
  assert.deepEqual(pairs(statusOf('live', cacheAged(2), { tooOld: true }).slice(1)), [['status-warn', S.stale]]);
  // in keinem Zustand steht errTooOld in der Statuszeile
  for (const status of [null, 'loading', 'live', 'offline', 'failed', 'waiting', 'rateLimited', 'noCache']) {
    for (const cache2 of [null, cacheAged(2), cacheAged(80)]) {
      for (const line of statusOf(status, cache2, { tooOld: true, waitS: 60 })) {
        assert.notEqual(line.text, i18n.t('errTooOld'));
        assert.doesNotMatch(line.text, /zu alt/);
      }
    }
  }
  // ohne tooOld und ohne Alter über der Grenze bleibt es beim Stand
  assert.equal(statusOf('live', cacheAged(2), { tooOld: false }).length, 1);
});

test('statusLines: statusWaiting nennt die Wartezeit, ohne gültige Zahl 60', () => {
  assert.equal(statusOf('waiting', cacheAged(1), { waitS: 120 })[1].text,
    'Der Wetterdienst ist gerade ausgelastet. Heizwarte versucht es in 120 Sekunden noch einmal.');
  assert.equal(statusOf('waiting', cacheAged(1), { waitS: 90.4 })[1].text.includes('in 90 Sekunden'), true);
  for (const waitS of [0, -5, NaN, undefined, null, '60', Infinity]) {
    assert.equal(statusOf('waiting', cacheAged(1), { waitS })[1].text, S.waiting60, String(waitS));
  }
  // Die Zeile zählt nicht herunter: derselbe Aufruf zu einem späteren Zeitpunkt ergibt denselben Satz
  const early = statusLines({ status: 'waiting', waitS: 60 }, null, STATUS_NOW, statusFmt());
  const later = statusLines({ status: 'waiting', waitS: 60 }, null, STATUS_NOW + 30000, statusFmt());
  assert.deepEqual(early, later);
});

test('statusLines: geht die Geräteuhr zurück, steht „jetzt“ statt einer Zahl in der Zukunft', () => {
  const zukunft = { v: 2, fetched: STATUS_NOW + 5 * 60000 };
  const lines = statusOf('live', zukunft);
  assert.equal(lines.length, 1, 'ein Abruf aus der Zukunft ist nicht veraltet');
  assert.equal(lines[0].text, 'Stand: heute 13:35 (jetzt).');
  assert.doesNotMatch(lines[0].text, /in \d/);
});

test('statusLines: jede Kombination ergibt ganze Sätze, Warnungen tragen Symbol und Wort, Hinweise kein Symbol', () => {
  const erlaubt = new Set(['status-stamp', 'status-info', 'status-warn']);
  const stati = [null, 'loading', 'live', 'offline', 'failed', 'waiting', 'rateLimited', 'noCache'];
  let n = 0;
  for (const status of stati) {
    for (const cache of [null, cacheAged(0.1), cacheAged(3), cacheAged(30)]) {
      for (const tooOld of [false, true]) {
        const lines = statusOf(status, cache, { tooOld, waitS: 60 });
        assert.ok(lines.length <= 4, 'höchstens Stand, Hinweis und Warnung');
        const stamps = lines.filter((l) => l.cls === 'status-stamp');
        assert.equal(stamps.length, cache && lines.length ? 1 : 0, 'der Stand steht genau dann, wenn ein Cache da ist');
        if (stamps.length) { assert.equal(lines[0].cls, 'status-stamp', 'der Stand steht vorn'); }
        for (const l of lines) {
          n++;
          assert.ok(erlaubt.has(l.cls), l.cls);
          assert.ok(typeof l.text === 'string' && l.text.length > 0);
          assert.doesNotMatch(l.text, /[{}]/, 'kein offener Platzhalter: ' + l.text);
          assert.doesNotMatch(l.text, /undefined|NaN|null/, l.text);
          if (l.cls === 'status-warn') { assert.match(l.text, /^⚠ Veraltet – /); } else { assert.doesNotMatch(l.text, /⚠|Veraltet/); }
        }
      }
    }
  }
  assert.ok(n > 100);
});

test('statusLines: nur die Zeilen, die Platzhalter tragen, bekommen welche (statusStamp, statusWaiting)', () => {
  // Der Fehlertext errLoadFailed gehört zur Tabelle und steht in der Gruppe Fehler, nicht Status
  for (const k of ['statusLoading', 'statusStale', 'statusOffline', 'statusRateLimited', 'statusNoData', 'errLoadFailed']) {
    assert.doesNotMatch(de[k], /\{/, k);
  }
  assert.match(de.statusStamp, /\{when\}.*\{ago\}/);
  assert.match(de.statusWaiting, /\{s\}/);
});

test('Beweis: statusLines liefert unter jeder Prozess-Zeitzone denselben Text', () => {
  const { execFileSync } = require('node:child_process');
  const skript = `
    const H = require(${JSON.stringify(path.join(__dirname, '_load.js'))});
    const { statusLines } = require(${JSON.stringify(path.join(__dirname, '..', 'js', 'app.js'))});
    const f = H.i18n.fmt;
    const fmt = { t: H.i18n.t, staleHours: H.heat.THRESH.staleHours,
      when: (ms, now) => f.when(ms, now, 'Europe/Berlin', 'de'), rel: (ms, now) => f.rel(ms, now, 'de') };
    const now = ${STATUS_NOW};
    const out = [];
    for (const status of [null, 'loading', 'live', 'offline', 'failed', 'waiting', 'rateLimited', 'noCache']) {
      for (const h of [null, 0.2, 3, 14, 30]) {
        const cache = h === null ? null : { v: 2, fetched: now - h * 3600000 };
        out.push(statusLines({ status, waitS: 60, tooOld: false }, cache, now, fmt));
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const lauf = (tz) => execFileSync(process.execPath, ['-e', skript], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
  const berlin = lauf('Europe/Berlin');
  assert.ok(berlin.length > 1000);
  assert.equal(lauf('Pacific/Auckland'), berlin);
  assert.equal(lauf('America/New_York'), berlin);
});

// ---------------------------------------------------------------------------------------------
// Zeitlogik des Fahrplans: whenPhrase, nightName, planWhen (Review Runde 2, N8)
// ---------------------------------------------------------------------------------------------

// Uhrumstellung: In der Nacht zum 25.10.2026 gibt es in Berlin 2 Uhr zweimal (00:00Z als Sommerzeit, 01:00Z als
// Winterzeit). om-dst.json beginnt am Samstag, 24.10., um 0:00 Ortszeit.
const DST = {
  satNoon: Date.UTC(2026, 9, 24, 10, 0),     // Samstag 12:00 Sommerzeit
  first230: Date.UTC(2026, 9, 25, 0, 30),    // Sonntag 2:30, erstes Mal (Sommerzeit)
  second230: Date.UTC(2026, 9, 25, 1, 30),   // Sonntag 2:30, zweites Mal (Winterzeit)
  second245: Date.UTC(2026, 9, 25, 1, 45),   // Sonntag 2:45, zweites Mal
  sun3: Date.UTC(2026, 9, 25, 2, 0)          // Sonntag 3:00 Winterzeit
};

// Ansicht wie buildView() in app.js, nur ohne Ampel (die Zeitlogik und der Jetzt-Block brauchen sie nicht)
function viewAt(name, nowMs, fetched) {
  const m = weather.model({ v: 2, fetched: fetched === undefined ? 0 : fetched, om: fixture(name), mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
  const now = weather.localNow(m.tz, nowMs);
  return { m, now, todayIdx: m.days.findIndex((d) => d.key === now.key) };
}

// Zeitformatierer wie timeFmt() in app.js, mit fester Sprache und der Zeitzone, die der Test nennt
function ztFor(tz) {
  const f = i18n.fmt;
  return {
    t: i18n.t,
    lang: 'de',
    time: (ms) => f.time(ms, tz, 'de'),
    wday: (ms) => f.wday(ms, tz, 'de', true),
    dayKey: (ms) => weather.dayKeyOf(ms, tz)
  };
}

test('whenPhrase am 25.10.2026: die doppelte Stunde 2:30 heißt „heute ab 2:30“, nicht 1:30 oder 3:30', () => {
  const zt = ztFor('Europe/Berlin');
  // jetzt ist das erste 2:30 (Sommerzeit), der Start das zweite (Winterzeit): noch nicht fällig, heute, 2:30
  const erst = viewAt('om-dst.json', DST.first230);
  assert.equal(erst.now.key, '2026-10-25');
  assert.equal(whenPhrase(erst, { startMs: DST.second230 }, zt), 'heute ab 2:30');
  assert.equal(whenPhrase(erst, { startMs: DST.sun3 }, zt), 'heute ab 3:00');
  // jetzt ist das zweite 2:45: beide 2:30 liegen zurück, der Start ist fällig
  const zweit = viewAt('om-dst.json', DST.second245);
  assert.equal(whenPhrase(zweit, { startMs: DST.second230 }, zt), 'jetzt');
  assert.equal(whenPhrase(zweit, { startMs: DST.first230 }, zt), 'jetzt');
  // vom Samstag aus: der Start am Sonntag trägt den Wochentag, der am Samstag „heute“
  const samstag = viewAt('om-dst.json', DST.satNoon);
  assert.equal(samstag.now.key, '2026-10-24');
  assert.equal(whenPhrase(samstag, { startMs: DST.second230 }, zt), 'Sonntag ab 2:30');
  assert.equal(whenPhrase(samstag, { startMs: Date.UTC(2026, 9, 24, 14, 0) }, zt), 'heute ab 16:00');
});

test('planWhen über die Umstellung: eigener Tag, Folgetag, Start am Vortag und fällig', () => {
  const zt = ztFor('Europe/Berlin');
  const samstag = viewAt('om-dst.json', DST.satNoon);
  const satNacht = { dayIdx: 0 };
  const sonNacht = { dayIdx: 1 };
  const monNacht = { dayIdx: 2 };
  // Start auf dem Tag der Nacht: nur die Uhrzeit (16:00 Sommerzeit)
  assert.equal(planWhen(samstag, { startMs: Date.UTC(2026, 9, 24, 14, 0) }, satNacht, false, zt), 'Start ab 16:00');
  // Start nach Mitternacht, in der zweiten 2-Uhr-Stunde: anderer Tag als die Nacht, also mit Wochentag
  assert.equal(planWhen(samstag, { startMs: DST.second230 }, satNacht, false, zt), 'Sonntag ab 2:30');
  // derselbe Start, gesehen vom ersten 2:30 aus: jetzt ist schon Sonntag, also „Heute“
  assert.equal(planWhen(viewAt('om-dst.json', DST.first230), { startMs: DST.second230 }, satNacht, false, zt), 'Heute ab 2:30');
  // Start am Vortag der Nacht (Samstag 22:00 für die Sonntagnacht): heute bzw. mit Wochentag
  assert.equal(planWhen(samstag, { startMs: Date.UTC(2026, 9, 24, 20, 0) }, sonNacht, false, zt), 'Heute ab 22:00');
  assert.equal(planWhen(samstag, { startMs: Date.UTC(2026, 9, 25, 21, 0) }, monNacht, false, zt), 'Sonntag ab 22:00');
  // Sonntagnacht nach der Umstellung: 18:00 Winterzeit = 17:00Z
  assert.equal(planWhen(samstag, { startMs: Date.UTC(2026, 9, 25, 17, 0) }, sonNacht, false, zt), 'Start ab 18:00');
  // fällig: „Jetzt“ mit großem Anfangsbuchstaben, ohne Uhrzeit
  assert.equal(planWhen(samstag, { startMs: DST.satNoon }, satNacht, true, zt), 'Jetzt');
});

test('nightName: Heute, Morgen, danach der Wochentag des Abends, auch über die Umstellung', () => {
  const zt = ztFor('Europe/Berlin');
  const samstag = viewAt('om-dst.json', DST.satNoon);
  assert.deepEqual([0, 1, 2, 3, 4].map((k) => nightName(samstag, { dayIdx: k }, zt)),
    ['Heute Nacht', 'Morgen Nacht', 'Montag Nacht', 'Dienstag Nacht', 'Mittwoch Nacht']);
  // in der doppelten Stunde ist „heute“ der Sonntag, ganz gleich, ob Sommer- oder Winterzeit
  for (const ms of [DST.first230, DST.second230]) {
    const v = viewAt('om-dst.json', ms);
    assert.equal(nightName(v, { dayIdx: 1 }, zt), 'Heute Nacht');
    assert.equal(nightName(v, { dayIdx: 3 }, zt), 'Dienstag Nacht');
  }
});

test('Lissabon: Uhrzeit, Kalendertag und Wochentag in der Ortszeit des Orts, nicht in der Berlins', () => {
  // Dienstag, 13.01.2026, 10:00 in Lissabon (UTC+0) = 11:00 in Berlin
  const view = viewAt('om-lissabon.json', Date.UTC(2026, 0, 13, 10, 0));
  assert.equal(view.m.tz, 'Europe/Lisbon');
  assert.equal(view.now.key, '2026-01-13');
  const zt = ztFor(view.m.tz);
  const spaet = { startMs: Date.UTC(2026, 0, 13, 23, 30) };
  assert.equal(whenPhrase(view, { startMs: Date.UTC(2026, 0, 13, 16, 0) }, zt), 'heute ab 16:00');
  assert.equal(whenPhrase(view, spaet, zt), 'heute ab 23:30');
  assert.equal(planWhen(view, spaet, { dayIdx: view.todayIdx }, false, zt), 'Start ab 23:30');
  assert.equal(planWhen(view, { startMs: Date.UTC(2026, 0, 14, 0, 30) }, { dayIdx: view.todayIdx }, false, zt), 'Mittwoch ab 0:30');
  assert.deepEqual([1, 2, 3].map((k) => nightName(view, { dayIdx: k }, zt)), ['Heute Nacht', 'Morgen Nacht', 'Donnerstag Nacht']);
  // Gegenprobe: mit Berlins Zeitzone läge derselbe Start schon am Mittwoch, eine Stunde später
  assert.equal(whenPhrase(view, spaet, ztFor('Europe/Berlin')), 'Mittwoch ab 0:30');
});

test('Beweis: whenPhrase, nightName und planWhen liefern unter jeder Prozess-Zeitzone denselben Text', () => {
  const { execFileSync } = require('node:child_process');
  // Die Zone wird zur Laufzeit gesetzt (process.env.TZ), weil Node unter Windows TZ beim Start nicht liest
  // (Eintrag zum Schritt „i18n“); getTimezoneOffset zeigt, dass der Wechsel wirklich greift.
  const skript = (tz) => `
    process.env.TZ = ${JSON.stringify(tz)};
    const H = require(${JSON.stringify(path.join(__dirname, '_load.js'))});
    const { whenPhrase, nightName, planWhen } = require(${JSON.stringify(path.join(__dirname, '..', 'js', 'app.js'))});
    const fs = require('node:fs');
    const dir = ${JSON.stringify(path.join(__dirname, 'fixtures'))};
    const f = H.i18n.fmt;
    const out = [];
    const faelle = [['om-dst.json', [${DST.satNoon}, ${DST.first230}, ${DST.second245}]], ['om-lissabon.json', [${Date.UTC(2026, 0, 13, 10, 0)}]]];
    for (const [name, nows] of faelle) {
      const om = JSON.parse(fs.readFileSync(require('node:path').join(dir, name), 'utf8'));
      const m = H.weather.model({ v: 2, fetched: 0, om, mos: [], mosStation: null, alerts: null, alertsStatus: 'none' });
      const zt = { t: H.i18n.t, lang: 'de', time: (ms) => f.time(ms, m.tz, 'de'), wday: (ms) => f.wday(ms, m.tz, 'de', true),
        dayKey: (ms) => H.weather.dayKeyOf(ms, m.tz) };
      for (const nowMs of nows) {
        const now = H.weather.localNow(m.tz, nowMs);
        const view = { m, now, todayIdx: m.days.findIndex((d) => d.key === now.key) };
        for (let k = 0; k < m.days.length; k++) { out.push(nightName(view, { dayIdx: k }, zt)); }
        for (const o of m.hours) {
          if (o.h % 2 !== 0) { continue; }
          const e = { startMs: o.ms };
          out.push(whenPhrase(view, e, zt));
          for (let k = 0; k < m.days.length; k++) { out.push(planWhen(view, e, { dayIdx: k }, false, zt)); }
        }
      }
    }
    process.stdout.write(JSON.stringify({ off: new Date(${Date.UTC(2026, 0, 13, 12, 0)}).getTimezoneOffset(), out }));
  `;
  const lauf = (tz) => JSON.parse(execFileSync(process.execPath, ['-e', skript(tz)], { encoding: 'utf8' }));
  const berlin = lauf('Europe/Berlin');
  const auckland = lauf('Pacific/Auckland');
  const newYork = lauf('America/New_York');
  assert.ok(berlin.out.length > 1000, 'zu wenige Zeilen: ' + berlin.out.length);
  assert.ok(berlin.out.includes('heute ab 2:00'), 'die zweite 2-Uhr-Stunde vom ersten 2:30 aus ist dabei');
  assert.equal(new Set([berlin.off, auckland.off, newYork.off]).size, 3, 'die Prozess-Zeitzone hat wirklich gewechselt');
  assert.deepEqual(auckland.out, berlin.out);
  assert.deepEqual(newYork.out, berlin.out);
});

// ---------------------------------------------------------------------------------------------
// Jetzt-Block, Umriss, Hausnummer (Review Runde 2, N12, Befund 2 mit N10, N11)
// ---------------------------------------------------------------------------------------------

test('currentOf: die Prognose-Stunde nach dem absoluten Zeitpunkt, auch in der doppelten Stunde am 25.10.', () => {
  // zweites 2:30 (Winterzeit, 01:30Z): die Stunde ab 01:00Z, nicht die erste 2-Uhr-Stunde ab 00:00Z
  const zweit = currentOf(viewAt('om-dst.json', DST.second230));
  const erst = currentOf(viewAt('om-dst.json', DST.first230));
  assert.equal(zweit.ms, Date.UTC(2026, 9, 25, 1, 0));
  assert.equal(erst.ms, Date.UTC(2026, 9, 25, 0, 0));
  assert.notEqual(zweit.temp, erst.temp, 'zwei verschiedene Stunden mit eigenen Werten');
  // Lissabon: 10:20 Ortszeit → die Stunde ab 10:00
  assert.equal(currentOf(viewAt('om-lissabon.json', Date.UTC(2026, 0, 13, 10, 20))).ms, Date.UTC(2026, 0, 13, 10, 0));
  // frischer Abruf (höchstens 90 Minuten alt): der current-Block der Antwort
  const frisch = viewAt('om-dst.json', DST.second230, DST.second230 - 10 * 60000);
  assert.equal(currentOf(frisch), frisch.m.current);
  // außerhalb der Prognose bleibt nur der current-Block
  const danach = viewAt('om-dst.json', Date.UTC(2026, 10, 30, 12, 0));
  assert.equal(currentOf(danach), danach.m.current);
});

test('extentLine: Einheit aus dem Schlüssel, Kilometer nur, wenn beide Maße mindestens 1 km sind', () => {
  const fmt = { t: i18n.t, num: i18n.fmt.num };
  assert.equal(extentLine({ w: 22.4, h: 27.6 }, fmt), 'Umriss etwa 22 × 28 m');
  assert.equal(extentLine({ w: 2140, h: 1390 }, fmt), 'Umriss etwa 2,1 × 1,4 km');
  // schmal und lang: beide in Metern statt „0,0 × 1,2 km“
  assert.equal(extentLine({ w: 15, h: 1200 }, fmt), 'Umriss etwa 15 × 1.200 m');
  assert.equal(extentLine({ w: 1200, h: 40 }, fmt), 'Umriss etwa 1.200 × 40 m');
  // unter einem Meter je Seite wird 1 m; ohne Umriss oder ohne Fläche nichts
  assert.equal(extentLine({ w: 0.4, h: 30 }, fmt), 'Umriss etwa 1 × 30 m');
  assert.equal(extentLine({ w: 0, h: 0 }, fmt), '');
  assert.equal(extentLine(null, fmt), '');
  // echte Umrisse über geo.extentSize (wie geo.test.js): Marktstraße 1 und der Ortsteil Bürg
  const geo = Heizwarte.geo;
  assert.equal(extentLine(geo.extentSize([9.3962769, 48.8773938, 9.3965767, 48.8771427], 48.8772683), fmt), 'Umriss etwa 22 × 28 m');
  assert.match(extentLine(geo.extentSize([9.4324428, 48.8941292, 9.4627316, 48.870991], 48.8817501), fmt), /^Umriss etwa \d,\d × \d,\d km$/);
  // die Platzhalter bekommen nur Zahlen, die Einheit steckt im Schlüssel
  const gesehen = [];
  extentLine({ w: 22, h: 28 }, { t: (k, v) => { gesehen.push([k, v]); return k; }, num: i18n.fmt.num });
  extentLine({ w: 2100, h: 1400 }, { t: (k, v) => { gesehen.push([k, v]); return k; }, num: i18n.fmt.num });
  assert.deepEqual(gesehen, [['setupExtent', { w: '22', h: '28' }], ['setupExtentKm', { w: '2,1', h: '1,4' }]]);
});

test('extractNumber: Hausnummern mit Schrägstrich und Bindestrich, die Rangfolge hebt das richtige Haus', () => {
  assert.equal(extractNumber('Hauptstraße 12/1'), '12/1');
  assert.equal(extractNumber('Hauptstraße 12 / 1'), '12 / 1');
  assert.equal(extractNumber('Am Markt 5-7'), '5-7');
  assert.equal(extractNumber('Marktstraße 1 a'), '1 a');
  assert.equal(extractNumber('Marktstraße 1'), '1');
  assert.equal(extractNumber('10 Downing Street'), '10');
  assert.equal(extractNumber('Hauptstraße'), '');
  assert.equal(extractNumber(''), '');
  // geo.rank vergleicht ohne Leerraum: das Haus 12/1 kommt vor die Häuser 1 und 12, das Haus 5-7 vor das Haus 5
  const geo = Heizwarte.geo;
  const haus = (nr, lon) => ({ kind: 'house', lat: 48.877, lon, label: 'Hauptstraße ' + nr, parts: { housenumber: nr } });
  const hits = [haus('1', 9.390), haus('12', 9.391), haus('12/1', 9.392)];
  assert.equal(geo.rank(hits, { housenumber: extractNumber('Hauptstraße 12/1') })[0].parts.housenumber, '12/1');
  assert.equal(geo.rank(hits, { housenumber: extractNumber('Hauptstraße 12 / 1') })[0].parts.housenumber, '12/1');
  const markt = [haus('5', 9.393), haus('5-7', 9.394)];
  assert.equal(geo.rank(markt, { housenumber: extractNumber('Am Markt 5-7') })[0].parts.housenumber, '5-7');
});

// ---------------------------------------------------------------------------------------------
// Einstellungen: Stepper, Höhe, Löschen, Ortsname (BAUPLAN Abschnitt 7 und 8)
// ---------------------------------------------------------------------------------------------

const STEP_FELDER = ['comfort', 'leadMin', 'leadMax'];

test('Stepper: Grenzen und Schrittweite wie in Abschnitt 7, Einheit und Beschriftung stehen in de', () => {
  assert.deepEqual(Object.keys(STEPPERS), STEP_FELDER);
  const grenzen = (f) => [STEPPERS[f].min, STEPPERS[f].max, STEPPERS[f].step];
  assert.deepEqual(grenzen('comfort'), [17, 23, 0.5]);
  assert.deepEqual(grenzen('leadMin'), [0.5, 8, 0.5]);
  assert.deepEqual(grenzen('leadMax'), [1, 10, 0.5]);
  for (const f of STEP_FELDER) {
    assert.ok(Object.prototype.hasOwnProperty.call(i18n.I18N.de, STEPPERS[f].unit), f + ': Einheit');
    assert.ok(Object.prototype.hasOwnProperty.call(i18n.I18N.de, STEPPERS[f].label), f + ': Beschriftung');
  }
  // Zahl mit Einheit, wie der Stepper sie zeigt
  assert.equal(i18n.t('unitCelsius', { n: roundedNum(20.5) }), '20,5 °C');
  assert.equal(i18n.t('unitCelsius', { n: roundedNum(20) }), '20 °C');
  assert.equal(i18n.t('unitHours', { n: roundedNum(3) }), '3 h');
  assert.equal(i18n.t('unitHours', { n: roundedNum(0.5) }), '0,5 h');
});

test('Stepper: die Werte aller Heizarten liegen in den Grenzen, leadMin ≤ leadMax', () => {
  for (const [typ, p] of Object.entries(heat.PROFILES)) {
    if (typ === 'storage') {
      assert.equal(p.leadMin, null);
      assert.equal(p.leadMax, null);
      continue;
    }
    assert.ok(p.leadMin >= STEPPERS.leadMin.min && p.leadMin <= STEPPERS.leadMin.max, typ + ' leadMin');
    assert.ok(p.leadMax >= STEPPERS.leadMax.min && p.leadMax <= STEPPERS.leadMax.max, typ + ' leadMax');
    assert.ok(p.leadMin <= p.leadMax, typ);
  }
});

test('stepValue: halbe Schritte, am Rand bleibt der Wert, krumme und fremde Werte rasten ein', () => {
  assert.equal(stepValue('comfort', 20, 1), 20.5);
  assert.equal(stepValue('comfort', 20, -1), 19.5);
  assert.equal(stepValue('comfort', 23, 1), 23);
  assert.equal(stepValue('comfort', 22.5, 1), 23);
  assert.equal(stepValue('comfort', 17, -1), 17);
  assert.equal(stepValue('comfort', 17.5, -1), 17);
  assert.equal(stepValue('leadMin', 0.5, -1), 0.5);
  assert.equal(stepValue('leadMin', 8, 1), 8);
  assert.equal(stepValue('leadMin', 3, 1), 3.5);
  assert.equal(stepValue('leadMax', 1, -1), 1);
  assert.equal(stepValue('leadMax', 10, 1), 10);
  assert.equal(stepValue('leadMax', 9.5, 1), 10);
  // ein krummer Wert rastet erst auf das Raster ein, dann folgt der Schritt
  assert.equal(stepValue('comfort', 20.3, 1), 21);
  assert.equal(stepValue('comfort', 20.2, -1), 19.5);
  // außerhalb der Grenzen (kaputter Speicher) führt der erste Schritt zurück in den Bereich
  assert.equal(stepValue('comfort', 30, -1), 23);
  assert.equal(stepValue('comfort', 10, 1), 17);
  assert.equal(stepValue('leadMax', 40, 1), 10);
  // ohne Zahl: Raumtemperatur startet bei 20, die Aufheizzeiten bei ihrer unteren Grenze
  assert.equal(stepValue('comfort', null, 1), 20.5);
  assert.equal(stepValue('leadMin', NaN, 1), 1);
  assert.equal(stepValue('leadMax', undefined, 1), 1.5);
  // unbekanntes Feld ändert nichts
  assert.equal(stepValue('nope', 5, 1), 5);
});

test('stepValue: von der unteren bis zur oberen Grenze in lauter halben Schritten, ohne einen auszulassen', () => {
  for (const f of STEP_FELDER) {
    const s = STEPPERS[f];
    let v = s.min;
    let n = 0;
    while (stepValue(f, v, 1) !== v) {
      const next = stepValue(f, v, 1);
      assert.equal(next - v, 0.5, f + ' von ' + v);
      v = next;
      n++;
    }
    assert.equal(v, s.max, f + ' endet an der oberen Grenze');
    assert.equal(n, (s.max - s.min) / 0.5, f + ': Anzahl der Schritte');
    while (stepValue(f, v, -1) !== v) { v = stepValue(f, v, -1); }
    assert.equal(v, s.min, f + ' kommt an die untere Grenze zurück');
  }
});

test('applyStep: leadMin über leadMax zieht leadMax mit, leadMax unter leadMin zieht leadMin mit (Bürg index:509–510)', () => {
  const v = { comfort: 20, leadMin: 3, leadMax: 6 };
  assert.deepEqual(applyStep(v, 'leadMin', 1), { comfort: 20, leadMin: 3.5, leadMax: 6 });
  assert.deepEqual(v, { comfort: 20, leadMin: 3, leadMax: 6 }, 'die Eingabe bleibt unberührt');
  assert.deepEqual(applyStep({ comfort: 20, leadMin: 6, leadMax: 6 }, 'leadMin', 1), { comfort: 20, leadMin: 6.5, leadMax: 6.5 });
  assert.deepEqual(applyStep({ comfort: 20, leadMin: 3, leadMax: 3 }, 'leadMax', -1), { comfort: 20, leadMin: 2.5, leadMax: 2.5 });
  // leadMax kann nicht unter 1 fallen, und leadMin zieht dort nicht weiter
  assert.deepEqual(applyStep({ comfort: 20, leadMin: 1, leadMax: 1 }, 'leadMax', -1), { comfort: 20, leadMin: 1, leadMax: 1 });
  // leadMin am oberen Rand: leadMax bleibt gleich hoch, nichts ändert sich
  assert.deepEqual(applyStep({ comfort: 20, leadMin: 8, leadMax: 8 }, 'leadMin', 1), { comfort: 20, leadMin: 8, leadMax: 8 });
  // leadMax zieht bis 10 mit
  assert.deepEqual(applyStep({ comfort: 20, leadMin: 8, leadMax: 8 }, 'leadMax', 1), { comfort: 20, leadMin: 8, leadMax: 8.5 });
  // die Raumtemperatur rührt die Aufheizzeiten nicht an
  assert.deepEqual(applyStep(v, 'comfort', 1), { comfort: 20.5, leadMin: 3, leadMax: 6 });
  // Nachtspeicher: keine Aufheizzeiten, die Raumtemperatur lässt sich trotzdem ändern
  assert.deepEqual(applyStep({ comfort: 20, leadMin: null, leadMax: null }, 'comfort', -1), { comfort: 19.5, leadMin: null, leadMax: null });
  // unbekanntes Feld
  assert.deepEqual(applyStep(v, 'nope', 1), v);
});

test('applyStep: nach beliebig vielen Schritten liegt alles im Bereich, auf dem Raster, und leadMin ≤ leadMax', () => {
  let seed = 20261012;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let v = { comfort: 20, leadMin: 3, leadMax: 6 };
  for (let i = 0; i < 5000; i++) {
    const feld = STEP_FELDER[Math.floor(rnd() * 3)];
    v = applyStep(v, feld, rnd() < 0.5 ? -1 : 1);
    for (const f of STEP_FELDER) {
      assert.ok(v[f] >= STEPPERS[f].min && v[f] <= STEPPERS[f].max, f + ' = ' + v[f] + ' im Schritt ' + i);
      assert.equal((v[f] * 2) % 1, 0, f + ' = ' + v[f] + ' liegt nicht auf dem Raster');
    }
    assert.ok(v.leadMin <= v.leadMax, 'leadMin ' + v.leadMin + ' > leadMax ' + v.leadMax + ' im Schritt ' + i);
  }
});

test('parseElev: leer, Zahl von −500 bis 9000 (ganze Meter) oder ungültig', () => {
  for (const leer of ['', '   ', undefined, null]) { assert.deepEqual(parseElev(leer, false), { kind: 'empty' }, String(leer)); }
  assert.deepEqual(parseElev('500', false), { kind: 'ok', n: 500 });
  assert.deepEqual(parseElev(' 417 ', false), { kind: 'ok', n: 417 });
  assert.deepEqual(parseElev('-500', false), { kind: 'ok', n: -500 });
  assert.deepEqual(parseElev('9000', false), { kind: 'ok', n: 9000 });
  assert.deepEqual(parseElev('416.6', false), { kind: 'ok', n: 417 });
  assert.deepEqual(parseElev('0', false), { kind: 'ok', n: 0 });
  assert.ok(Object.is(parseElev('-0', false).n, 0), 'minus null wird null');
  assert.ok(Object.is(parseElev('-0.4', false).n, 0), 'auch gerundet kein minus null');
  for (const schlecht of ['-501', '9001', '9000.4', 'abc', '1,5', '12abc', 'Infinity', 'NaN']) {
    assert.deepEqual(parseElev(schlecht, false), { kind: 'bad' }, schlecht);
  }
  // der Browser meldet „abc“ in einem number-Feld als badInput mit leerem value
  assert.deepEqual(parseElev('', true), { kind: 'bad' });
});

test('elevPatch: Zahl heißt von Hand, leer heißt automatisch (auch ohne Antwort), ungültig speichert nichts', () => {
  assert.deepEqual(elevPatch(parseElev('500', false), null), { elev: 500, elevAuto: false });
  assert.deepEqual(elevPatch(parseElev('500', false), 417), { elev: 500, elevAuto: false }, 'die Zahl gilt, nicht die Antwort');
  assert.deepEqual(elevPatch(parseElev('', false), 417), { elev: 417, elevAuto: true });
  assert.deepEqual(elevPatch(parseElev('', false), 416.6), { elev: 417, elevAuto: true });
  // Dienst ohne Antwort: Open-Meteo nimmt sein eigenes Höhenmodell (elev null), die Höhe gilt trotzdem als automatisch
  assert.deepEqual(elevPatch(parseElev('', false), null), { elev: null, elevAuto: true });
  assert.deepEqual(elevPatch(parseElev('', false), undefined), { elev: null, elevAuto: true });
  assert.deepEqual(elevPatch(parseElev('', false), NaN), { elev: null, elevAuto: true });
  assert.equal(elevPatch(parseElev('9001', false), 417), null);
  assert.equal(elevPatch(parseElev('', true), 417), null);
  assert.equal(elevPatch(undefined, 417), null);
});

test('afterDelete: der aktive Ort bleibt, sonst rückt der nächste nach, am Ende der davor, ohne Ort null', () => {
  const [a, b, c] = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((id) => ({ id }));
  const alle = [a, b, c];
  const ids = (r) => r.places.map((p) => p.id);

  let r = afterDelete(alle, b.id, b.id);
  assert.deepEqual(ids(r), [a.id, c.id]);
  assert.equal(r.activeId, c.id, 'der Ort, der an die Stelle rutscht');
  assert.equal(r.switched, true);

  r = afterDelete(alle, c.id, c.id);
  assert.deepEqual(ids(r), [a.id, b.id]);
  assert.equal(r.activeId, b.id, 'am Listenende der davor');

  r = afterDelete(alle, a.id, a.id);
  assert.equal(r.activeId, b.id);

  r = afterDelete(alle, a.id, b.id);
  assert.deepEqual(ids(r), [b.id, c.id]);
  assert.equal(r.activeId, b.id, 'ein anderer Ort gelöscht: der aktive bleibt');
  assert.equal(r.switched, false);

  r = afterDelete([a], a.id, a.id);
  assert.deepEqual(r.places, []);
  assert.equal(r.activeId, null);
  assert.equal(r.switched, true);

  r = afterDelete(alle, 'gibtEsNicht', a.id);
  assert.deepEqual(ids(r), [a.id, b.id, c.id]);
  assert.equal(r.activeId, a.id);
  assert.equal(r.switched, false);
  assert.equal(alle.length, 3, 'die Eingabe bleibt unberührt');
});

test('cleanLabel: getrimmt, auf 40 Zeichen gekürzt, leer behält den alten Namen', () => {
  assert.equal(cleanLabel('  Mama ', 'Opa'), 'Mama');
  assert.equal(cleanLabel('', 'Opa'), 'Opa');
  assert.equal(cleanLabel('   ', 'Opa'), 'Opa');
  assert.equal(cleanLabel(null, 'Opa'), 'Opa');
  assert.equal(cleanLabel(undefined, 'Opa'), 'Opa');
  assert.equal(cleanLabel('x'.repeat(50), 'Opa'), 'x'.repeat(40));
  // nach dem Kürzen bleibt kein Leerzeichen am Ende, und ein Emoji reißt nicht in der Mitte
  assert.equal(cleanLabel('a'.repeat(39) + ' b', 'Opa'), 'a'.repeat(39));
  assert.equal(Array.from(cleanLabel('😀'.repeat(45), 'Opa')).length, 40);
  assert.equal(cleanLabel('Winnenden-Bürg', 'Opa'), 'Winnenden-Bürg');
});

// ---------------------------------------------------------------------------------------------
// Ortsliste: Maximum, aktiver Ort, Umschalter
// ---------------------------------------------------------------------------------------------

function orte(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'ort' + i, label: 'Ort ' + i }));
}

test('canAddPlace: bis zu vier Orte darf einer dazukommen, bei fünf nicht; das Maximum ist 5', () => {
  assert.equal(MAX_PLACES, 5);
  for (let n = 0; n <= 4; n++) { assert.equal(canAddPlace(orte(n)), true, n + ' Orte'); }
  assert.equal(canAddPlace(orte(5)), false);
  assert.equal(canAddPlace(orte(6)), false, 'auch eine überlange Liste bekommt keinen Ort mehr');
  assert.equal(canAddPlace(null), false);
  assert.equal(canAddPlace(undefined), false);
});

test('appendPlace: hängt hinten an und lässt die alte Liste unberührt; der sechste Ort wird abgelehnt', () => {
  const eins = orte(1);
  const neu = { id: 'neu', label: 'Neu' };
  const zwei = appendPlace(eins, neu);
  assert.deepEqual(zwei.map((p) => p.id), ['ort0', 'neu'], 'neuer Ort am Ende (Reihenfolge = Umschalter)');
  assert.equal(eins.length, 1, 'die Eingabe bleibt unberührt');
  assert.notEqual(zwei, eins);

  let liste = [];
  for (let i = 0; i < 5; i++) { liste = appendPlace(liste, { id: 'x' + i }); assert.ok(liste, 'Ort ' + (i + 1)); }
  assert.equal(liste.length, 5);
  assert.equal(appendPlace(liste, { id: 'sechs' }), null, 'ein sechster Ort ist unmöglich');
  assert.equal(liste.length, 5);
  assert.equal(appendPlace(null, neu), null);
});

test('resolveActive: hw:active gilt, solange es den Ort gibt, sonst der erste Ort, ohne Ort null', () => {
  const liste = orte(3);
  assert.equal(resolveActive(liste, 'ort2'), 'ort2');
  assert.equal(resolveActive(liste, 'ort0'), 'ort0');
  assert.equal(resolveActive(liste, 'geloescht'), 'ort0', 'zeigt hw:active ins Leere, gilt der erste');
  assert.equal(resolveActive(liste, null), 'ort0', 'fehlt hw:active, gilt der erste');
  assert.equal(resolveActive(liste, undefined), 'ort0');
  assert.equal(resolveActive([], 'ort0'), null);
  assert.equal(resolveActive(null, 'ort0'), null);
});

test('resolveActive nach afterDelete: der nachrückende Ort ist auch der, den ein Neustart wählen würde', () => {
  const liste = orte(3);
  const r = afterDelete(liste, 'ort1', 'ort1');
  assert.equal(resolveActive(r.places, r.activeId), r.activeId);
  const letzter = afterDelete(orte(1), 'ort0', 'ort0');
  assert.equal(resolveActive(letzter.places, letzter.activeId), null);
});

test('showsSwitcher: ein Ort zeigt nur den Namen, ab zwei Orten steht der Umschalter da', () => {
  assert.equal(showsSwitcher(orte(0)), false);
  assert.equal(showsSwitcher(orte(1)), false);
  assert.equal(showsSwitcher(orte(2)), true);
  assert.equal(showsSwitcher(orte(5)), true);
  assert.equal(showsSwitcher(null), false);
});
