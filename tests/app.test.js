/*
 * Heizwarte — Tests für die reinen Zeilenfunktionen in js/app.js (verdictLines und planRows), ohne DOM
 *
 * app.js ist die einzige Datei, die beim Laden etwas tut, aber nur, wenn es ein document gibt. In Node ist keins da,
 * also lässt sich die Datei laden und ihr Node-Export (nur diese zwei Funktionen) benutzen. Die Tests füttern sie mit
 * echten Ergebnissen von heat.assess() auf den Fixtures und mit dem echten i18n.t(); die Formatierer (fmt) sind
 * kleine Ersatzobjekte, die zählen, ob der Start-Zweig überhaupt gerufen wird. Damit ist der Nachtspeicher-Zweig
 * bewiesen: keine Startzeit, keine Aufheizzeit, dafür die Aufladung am Abend.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Heizwarte = require('./_load.js');
const { verdictLines, planRows } = require('../js/app.js');
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
  assert.match(out.body, /^Abkühlung setzt gegen \d{1,2}:\d{2} ein\. Bei \d(,\d)? Stunden Aufheizzeit musst du vorher starten\.$/);
  assert.doesNotMatch(out.action, /Aufladung/);
});

test('verdictLines: Stufe 0 ist für jede Heizart dieselbe, ohne Eintrag bleibt es bei levelTitle0', () => {
  const view = viewOf('om-mild.json', PROF.storage);
  assert.equal(view.v.level, 0);
  const { fmt } = fmtFor(view);
  const speicher = verdictLines(0, view.v.plan[0], placeOf(PROF.storage), fmt);
  const boden = verdictLines(0, view.v.plan[0], placeOf(PROF.floorScreed), fmt);
  assert.deepEqual(speicher, boden);
  assert.equal(speicher.action, i18n.t('levelTitle0'));
  assert.equal(speicher.body, i18n.t('levelText0'));
  assert.deepEqual(verdictLines(2, null, placeOf(PROF.storage), fmt), { action: i18n.t('levelTitle0'), body: '' });
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
