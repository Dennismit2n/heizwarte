/*
 * Heizwarte — reine Heizlogik: Schwellen, Heizarten, Gradtagzahl, Nachtfenster, Ampel, Fahrplan und Lüftungsfenster
 * (ohne Date, Intl, DOM, localStorage und fetch)
 *
 * Alles rechnet auf Zahlen, die weather.model() vorab bestimmt hat: ms (Epoch-Millisekunden), dayIdx
 * (Index des Tages im Modell) und h (Ortsstunde 0–23). Deshalb liefert heat.js unter jeder Prozess-
 * Zeitzone dasselbe, auch am Umstellungstag mit 25 Stundenwerten und in Orten außerhalb von Berlin.
 * Texte entstehen hier nirgends: assess() und plan() geben Schlüssel zurück, app.js übersetzt sie.
 * Schnittstelle und Herkunft jeder Zahl: BAUPLAN Abschnitt 5 (heat) und 7; Vorbild ist die Bürg-Fassung
 * (index.html Zeile 305–375), jede Schwelle nennt dort ihre Zeile.
 */
(function (root) {
  'use strict';
  root.Heizwarte = root.Heizwarte || {};
  // Keine Abhängigkeiten: alles kommt als Parameter

  // ---------------------------------------------------------------------------------------------
  // Zahlen
  // ---------------------------------------------------------------------------------------------

  const HOUR_MS = 3600000;
  // Wunsch-Raumtemperatur, wenn das Profil keine nennt (Bürg index:326)
  const DEFAULT_COMFORT = 20;

  const THRESH = Object.freeze({
    nightFrom: 18, nightTo: 9, nightMinHours: 10,                         // index:318–320
    warnMinN: 5, warnDrop48: -4, coldMin: 8, coldWind: 20, coldSun: 2,    // index:337–340
    alarmMinN: 0, alarmDrop48: -6, alarmGtRise: 5, critMinN: -5,          // index:341–344
    gustLead: 40, gustLeadAdd: 0.5, needKnee: 12, needSpan: 12,           // index:356–359
    heatBase: 20, heatLimit: 15,                                          // index:311, B:168
    mosDisagree: 2, optionalFrom: 9, strongUp: 5, strongNormal: 9,        // index:430, 433, 363
    staleHours: 26,                                                       // index:385
    rhIndoor: 55, magnusA: 17.62, magnusB: 243.12, airMargin: 2,          // index:369, 373
    airFrom: 7, airTo: 22, airSlots: 4                                    // index:371, 374
  });

  // Die acht Ampelschwellen, die je Ort einstellbar sind (place.heat.thresh, BAUPLAN Abschnitt 7).
  // Alles andere in THRESH bleibt Konstante.
  const DEFAULT_THRESH = Object.freeze({
    warnMinN: THRESH.warnMinN,
    warnDrop48: THRESH.warnDrop48,
    alarmMinN: THRESH.alarmMinN,
    alarmDrop48: THRESH.alarmDrop48,
    alarmGtRise: THRESH.alarmGtRise,
    critMinN: THRESH.critMinN,
    coldWind: THRESH.coldWind,
    gustLead: THRESH.gustLead
  });

  // Faustregeln für die Aufheizzeit in Stunden (B:117). Nachtspeicher heizt nicht vor, er lädt auf.
  const PROFILES = Object.freeze({
    radiator: Object.freeze({ leadMin: 0.5, leadMax: 2 }),
    floorScreed: Object.freeze({ leadMin: 3, leadMax: 6 }),
    floorDry: Object.freeze({ leadMin: 1, leadMax: 3 }),
    heatpumpFloor: Object.freeze({ leadMin: 4, leadMax: 8 }),
    storage: Object.freeze({ leadMin: null, leadMax: null })
  });

  // Warnungen: DWD-Namen (event_de, index:345) und die englischen Namen (event_en, Annahme für die Liste,
  // B:52 nennt beide Felder). Die Schwere wird getrennt geprüft (index:346).
  // Englisch verlangt bei storm einen Wortanfang und bei ice ein ganzes Wort: Sonst trifft „thunderstorm“
  // (GEWITTER, STARKES GEWITTER) über „storm“, und jede Gewitterwarnung höbe die Ampel auf Heiz-Alarm.
  // Bürg schlug bei Gewitter nur an, wenn der deutsche Name ORKAN oder STURM trug; das bleibt so, weil die
  // deutsche Liste unverändert ist. „storm-force gusts“, „near gale“ und „black ice“ treffen weiter.
  const ALERT_RX_DE = /frost|sturm|orkan|glätte|glatteis|kälte|schnee|wind/i;
  const ALERT_RX_EN = /frost|\bstorm|gale|\bice\b|cold|snow|wind/i;
  const SEVERE_RX = /severe|extreme/;

  // Stufe der Heizung (strength) und Ladestand beim Nachtspeicher (charge) teilen sich dieselben Schwellen
  // (Bürg index:363)
  const CHARGE_OF = { through: 'high', up: 'up', normal: 'normal', low: 'low' };

  // ---------------------------------------------------------------------------------------------
  // Hilfen
  // ---------------------------------------------------------------------------------------------

  function isNum(x) {
    return typeof x === 'number' && isFinite(x);
  }

  // Die Funktionen nehmen ein HeatProfile; ein ganzer Ort (mit .heat) wird ebenfalls verstanden.
  function profileOf(p) {
    if (p && typeof p === 'object') {
      return p.heat && typeof p.heat === 'object' ? p.heat : p;
    }
    return {};
  }

  function comfortOf(p) {
    return isNum(p.comfort) ? p.comfort : DEFAULT_COMFORT;
  }

  // Grenzen der Aufheizzeit: aus dem Profil, sonst aus der Tabelle der Heizart, sonst Estrich (Bürg-Standard)
  function leadRange(p) {
    const base = PROFILES[p.type] || PROFILES.floorScreed;
    return {
      lo: isNum(p.leadMin) ? p.leadMin : base.leadMin,
      hi: isNum(p.leadMax) ? p.leadMax : base.leadMax
    };
  }

  // Größter endlicher Wert, sonst 0 (Bürg: Math.max über alle Stunden, null zählt dort als 0)
  function maxOf(values) {
    let m = null;
    for (const v of values) {
      if (isNum(v) && (m === null || v > m)) { m = v; }
    }
    return m === null ? 0 : m;
  }

  // ---------------------------------------------------------------------------------------------
  // Schwellen, Gradtagzahl, Taupunkt
  // ---------------------------------------------------------------------------------------------

  // Standardwerte, überlagert von place.heat.thresh. Es zählen nur die acht bekannten Schwellen mit einer
  // Zahl; ein Teilobjekt { warnMinN: 8 } ändert genau diese eine.
  function thresholds(profile) {
    const t = Object.assign({}, DEFAULT_THRESH);
    const own = profileOf(profile).thresh;
    if (own && typeof own === 'object') {
      for (const k of Object.keys(DEFAULT_THRESH)) {
        if (isNum(own[k])) { t[k] = own[k]; }
      }
    }
    return t;
  }

  // Gradtagzahl nach VDI 3807 in Kd: 20 °C minus Tagesmittel, nur an Heiztagen (Mittel unter 15 °C)
  function degreeDay(mean) {
    if (!isNum(mean)) { return 0; }
    return mean < THRESH.heatLimit ? THRESH.heatBase - mean : 0;
  }

  // Taupunkt nach Magnus aus Temperatur (°C) und relativer Feuchte (%) (Bürg index:369)
  function dewPoint(tempC, rhPercent) {
    const a = THRESH.magnusA;
    const b = THRESH.magnusB;
    const g = Math.log(rhPercent / 100) + a * tempC / (b + tempC);
    return b * g / (a - g);
  }

  // ---------------------------------------------------------------------------------------------
  // Nacht
  // ---------------------------------------------------------------------------------------------

  // Nacht des Tages dayIdx: Ortsstunden 18 bis 23 dieses Tages und 0 bis 9 des nächsten, beide Grenzen
  // inklusive (Bürg 16 Stundenwerte). Stunden ohne Temperatur zählen nicht; unter 10 Stunden gibt es keine
  // Nacht. Am Umstellungstag im Herbst liegt die Stunde 2 zweimal darin (17 Werte).
  function night(hours, dayIdx) {
    const hs = [];
    for (const o of hours || []) {
      if (!o || !isNum(o.temp)) { continue; }
      if ((o.dayIdx === dayIdx && o.h >= THRESH.nightFrom) ||
          (o.dayIdx === dayIdx + 1 && o.h <= THRESH.nightTo)) {
        hs.push(o);
      }
    }
    if (hs.length < THRESH.nightMinHours) { return null; }

    // der erste Tiefstwert gewinnt, wie bei Bürg
    let lo = hs[0];
    const mos = [];
    for (const o of hs) {
      if (o.temp < lo.temp) { lo = o; }
      if (isNum(o.mos)) { mos.push(o.mos); }
    }
    return {
      dayIdx,
      min: lo.temp,
      atMs: lo.ms,
      atH: lo.h,
      toMs: hs[hs.length - 1].ms,
      wind: maxOf(hs.map((o) => o.wind)),
      gust: maxOf(hs.map((o) => o.gust)),
      mosMin: mos.length ? Math.min.apply(null, mos) : null,
      hs
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Aufheizzeit
  // ---------------------------------------------------------------------------------------------

  // Stunden Aufheizzeit für eine Nacht mit Tiefstwert nightMin und Böen gust (Bürg index:356–359):
  // Bis needKnee Kelvin zwischen Wunsch und Nacht gilt leadMin, danach wächst sie linear bis leadMax.
  // Starke Böen ziehen durchs Haus und geben eine halbe Stunde dazu. Nachtspeicher: 0.
  function lead(profile, nightMin, gust) {
    const p = profileOf(profile);
    if (p.type === 'storage') { return 0; }
    const T = thresholds(p);
    const r = leadRange(p);
    const need = isNum(nightMin) ? comfortOf(p) - nightMin : 0;
    let v = r.lo + Math.max(0, need - THRESH.needKnee) / THRESH.needSpan * (r.hi - r.lo);
    if (isNum(gust) && gust > T.gustLead) { v += THRESH.gustLeadAdd; }
    return Math.min(r.hi, Math.max(r.lo, v));
  }

  // ---------------------------------------------------------------------------------------------
  // Warnungen
  // ---------------------------------------------------------------------------------------------

  // Trifft eine Warnung nach dem deutschen ODER dem englischen Namen, zählt sie (Stufe 2); ist einer der
  // Treffer severe oder extreme, ist es Stufe 3. Fehlende Felder (null) werfen nicht: Die Prüfung läuft
  // über einen leeren String. Bright Sky liefert expires, severity, event_* und instruction_* auch als null.
  function alertMatches(alerts) {
    const hits = [];
    let severe = false;
    if (Array.isArray(alerts)) {
      for (const a of alerts) {
        if (!a || typeof a !== 'object') { continue; }
        if (ALERT_RX_DE.test(a.event_de || '') || ALERT_RX_EN.test(a.event_en || '')) {
          hits.push(a);
          if (SEVERE_RX.test(String(a.severity || ''))) { severe = true; }
        }
      }
    }
    return { level: hits.length ? (severe ? 3 : 2) : 0, hits };
  }

  // Nur Warnungen, die zum Zeitpunkt nowMs noch gelten. weather.model() gibt jeder Warnung expiresMs mit
  // (null = ohne Ende); abgelaufen ist sie ab expiresMs <= nowMs. Eine Warnung ohne expiresMs (roh aus dem
  // Cache) bleibt stehen, weil heat.js keine Zeitstempel lesen darf. Grund: Ein alter Cache (ohne Netz)
  // hielte die Ampel sonst mit längst abgelaufenen Sturmwarnungen oben.
  function activeAlerts(alerts, nowMs) {
    if (!Array.isArray(alerts)) { return []; }
    return alerts.filter((a) => !(a && typeof a === 'object' && isNum(a.expiresMs) && isNum(nowMs) && a.expiresMs <= nowMs));
  }

  // ---------------------------------------------------------------------------------------------
  // Fahrplan
  // ---------------------------------------------------------------------------------------------

  // Stufe der Heizung nach Nacht-Tiefstwert (Bürg index:363, dort als Text)
  function strengthOf(nightMin, T) {
    if (nightMin <= T.alarmMinN) { return 'through'; }
    if (nightMin < THRESH.strongUp) { return 'up'; }
    if (nightMin < THRESH.strongNormal) { return 'normal'; }
    return 'low';
  }

  // Ein Eintrag je Nacht (Bürg index:350–365), in der Reihenfolge von nights.
  //   peak   wärmste Stunde des Tages zwischen 10 und 18 Uhr (Rückfall: erste Stunde der Nacht)
  //   onset  erste Stunde nach dem Höchstwert, die höchstens halb zwischen Tiefst- und Höchstwert liegt:
  //          ab da kühlt es merklich ab
  //   start  onset minus Aufheizzeit, auf die volle Stunde abgerundet. onset liegt schon auf einer vollen
  //          Ortsstunde, also genügt es, ceil(lead) Stunden abzuziehen — ohne Date und auch bei Halbstunden-
  //          Offsets (Indien +5:30) richtig, wo ein UTC-Raster danebenläge.
  //   dN     Unterschied zur Nacht davor; für die erste Nacht aus night(dayIdx - 1). Am ersten Tag der Antwort
  //          besteht diese Nacht nur aus den Morgenstunden 0 bis 9 (genau die 10 nötigen), wie bei Bürg.
  // Nachtspeicher (BAUPLAN Abschnitt 7): kein Vorlauf und kein startMs; onsetMs ist die Stunde 20 Uhr am
  // Vorabend, und charge sagt, wie hoch aufgeladen werden soll.
  function plan(model, nights, profile) {
    const p = profileOf(profile);
    const T = thresholds(p);
    const storage = p.type === 'storage';
    const hours = (model && model.hours) || [];

    return (nights || []).map((n, k) => {
      let peak = null;
      for (const o of hours) {
        if (o.dayIdx === n.dayIdx && o.h >= 10 && o.h <= 18 && isNum(o.temp) &&
            (peak === null || o.temp > peak.temp)) {
          peak = o;
        }
      }
      if (peak === null) { peak = n.hs[0]; }
      const mid = n.min + (peak.temp - n.min) * 0.5;

      let onset = null;
      for (const o of hours) {
        if (o.ms > peak.ms && isNum(o.temp) && o.temp <= mid) { onset = o; break; }
      }
      if (onset === null) { onset = n.hs[0]; }

      const prevN = k === 0 ? night(hours, n.dayIdx - 1) : nights[k - 1];
      const strength = strengthOf(n.min, T);
      const entry = {
        dayIdx: n.dayIdx,
        onsetMs: onset.ms,
        startMs: null,
        lead: 0,
        swing: peak.temp - n.min,
        dN: prevN ? n.min - prevN.min : 0,
        strength,
        optional: n.min >= THRESH.optionalFrom,
        disagree: isNum(n.mosMin) && Math.abs(n.mosMin - n.min) > THRESH.mosDisagree,
        gusty: n.gust > T.gustLead,
        charge: null
      };

      if (storage) {
        let evening = null;
        for (const o of hours) {
          if (o.dayIdx === n.dayIdx && o.h === 20) { evening = o; break; }
        }
        entry.onsetMs = (evening || n.hs[0]).ms;
        entry.charge = CHARGE_OF[strength];
      } else {
        entry.lead = lead(p, n.min, n.gust);
        entry.startMs = onset.ms - Math.ceil(entry.lead) * HOUR_MS;
      }
      return entry;
    });
  }

  // Ist der Start fällig? Ab startMs bis zum Ende der Nacht (Bürg index:432). Ohne startMs
  // (Nachtspeicher) nie.
  function isDue(entry, nowMs, nightToMs) {
    if (!entry || !isNum(entry.startMs) || !isNum(nowMs) || !isNum(nightToMs)) { return false; }
    return entry.startMs <= nowMs && nightToMs > nowMs;
  }

  // ---------------------------------------------------------------------------------------------
  // Ampel
  // ---------------------------------------------------------------------------------------------

  function tooOld() {
    return { level: null, reasons: [{ key: 'tooOld' }], D: [], prev: null, nights: [], plan: [], al: [] };
  }

  // Ampel 0 bis 3 mit Gründen (Bürg index:328–347, Werte aus thresholds(profile)). now kommt aus
  // weather.localNow(): { key, h, min, ms }. Liegt der heutige Tag nicht im Modell oder fehlt jede
  // Nacht, sind die Daten zu alt: level null, kein Wurf (behebt den Absturz bei Bürg index:450).
  //   Stufe 1 Vorwarnung   Nacht unter warnMinN, Tagesmittel fällt um warnDrop48 in 48 h, kalt+windig+trüb
  //   Stufe 2 Heiz-Alarm   Frostnacht, Absturz um alarmDrop48, Gradtagzahl springt, passende Warnung
  //   Stufe 3 Frost/Sturm  Nacht bis critMinN, Warnung mit severe/extreme
  function assess(model, now, profile, alerts) {
    const p = profileOf(profile);
    const days = (model && Array.isArray(model.days)) ? model.days : [];
    const today = now ? days.findIndex((d) => d.key === now.key) : -1;
    if (today < 0) { return tooOld(); }

    const T = thresholds(p);
    const D = days.slice(today, today + 3);
    const prev = today > 0 ? days[today - 1] : null;
    const nights = [];
    for (const d of D) {
      const n = night(model.hours, d.idx);
      if (n) { nights.push(n); }
    }
    if (!nights.length) { return tooOld(); }

    // kleinster Tiefstwert der ersten zwei Nächte
    const first2 = nights.slice(0, 2);
    const minN = Math.min.apply(null, first2.map((n) => n.min));
    // fehlende Tage zählen als 0, Rumpftage (partial, weather.model) ebenso: Ein Tag aus einer einzigen
    // Stunde nach der Frühjahrsumstellung hat kein Tagesmittel. Nicht über mean = null lösen, denn
    // null − Zahl rechnet in JavaScript mit 0.
    const whole = (d) => !!d && !d.partial;
    const drop48 = Math.min(
      whole(D[0]) && whole(D[1]) ? D[1].mean - D[0].mean : 0,
      whole(D[0]) && whole(D[2]) ? D[2].mean - D[0].mean : 0
    );
    const gtRise = Math.max(
      whole(D[0]) && whole(D[1]) ? D[1].gt - D[0].gt : 0,
      whole(D[1]) && whole(D[2]) ? D[2].gt - D[1].gt : 0
    );
    // coldMin und coldSun sind nicht einstellbar und kommen deshalb aus THRESH
    const coldWindy = first2.some((n) => n.min < THRESH.coldMin && n.wind > T.coldWind) &&
      D.slice(0, 2).some((d) => isNum(d.sun) && d.sun < THRESH.coldSun);

    const am = alertMatches(activeAlerts(alerts, now.ms));

    let level = 0;
    const reasons = [];
    const raise = (l) => { if (l > level) { level = l; } };

    if (minN < T.warnMinN) { raise(1); reasons.push({ key: 'nightMin', n: minN }); }
    if (drop48 <= T.warnDrop48) { raise(1); reasons.push({ key: 'drop48', n: drop48 }); }
    if (coldWindy) { raise(1); reasons.push({ key: 'coldWindy' }); }
    if (minN <= T.alarmMinN) { raise(2); reasons.push({ key: 'frost' }); }
    if (drop48 <= T.alarmDrop48) { raise(2); }
    if (gtRise >= T.alarmGtRise) { raise(2); reasons.push({ key: 'gtRise', n: gtRise }); }
    // Mit den Faustregeln liegt critMinN unter alarmMinN, dann steht 'frost' schon da. Mit eigenen Schwellen
    // (alarmMinN unter critMinN) fehlte sonst jeder Grund für Stufe 3; critMinN ist in den Einstellungen höchstens
    // 0 °C, der Satz „Die Nacht bringt Frost.“ stimmt also auch dann.
    if (minN <= T.critMinN) {
      raise(3);
      if (!reasons.some((r) => r.key === 'frost')) { reasons.push({ key: 'frost' }); }
    }
    if (am.hits.length) { raise(am.level); reasons.push({ key: 'alert' }); }
    // Keine Regel hat gegriffen: ruhige Nächte ohne große Sprünge
    if (level === 0) {
      reasons.push({ key: 'calmNights', n: Math.floor(minN) }, { key: 'noJumps' });
    }

    return { level, reasons, D, prev, nights, plan: plan(model, nights, p), al: am.hits };
  }

  // ---------------------------------------------------------------------------------------------
  // Lüften
  // ---------------------------------------------------------------------------------------------

  // Bis zu airSlots Fenster heute (Bürg index:368–375), in denen die Außenluft deutlich trockener ist als
  // die Raumluft bei rhIndoor Prozent: Taupunkt draußen mindestens airMargin Kelvin unter dem drinnen.
  // Kandidaten sind die Stunden von einer Stunde vor jetzt bis zum Ende des heutigen Tages, nur zwischen
  // airFrom und airTo Uhr Ortszeit. Das beste Fenster (höchste Wertung, bei Gleichstand das früheste) trägt
  // best. Fehlende Werte (null) geben weder Plus noch Minus.
  function airSlots(model, now, profile) {
    const p = profileOf(profile);
    const indoorDew = dewPoint(comfortOf(p), THRESH.rhIndoor);
    const days = (model && Array.isArray(model.days)) ? model.days : [];
    const today = now ? days.findIndex((d) => d.key === now.key) : -1;
    if (today < 0 || !isNum(now.ms)) { return { indoorDew, slots: [] }; }

    const scored = [];
    for (const o of model.hours) {
      if (o.dayIdx !== today || o.ms < now.ms - HOUR_MS) { continue; }
      if (o.h < THRESH.airFrom || o.h > THRESH.airTo) { continue; }
      if (!isNum(o.dew) || !(o.dew < indoorDew - THRESH.airMargin)) { continue; }
      const score = (indoorDew - o.dew) +
        (isNum(o.pp) ? (o.pp < 30 ? 2 : -3) : 0) +
        (isNum(o.temp) ? (o.temp > 0 ? 1 : -1) : 0) +
        (isNum(o.wind) ? (o.wind < 25 ? 1 : 0) : 0);
      scored.push({ ms: o.ms, h: o.h, score, best: false });
    }

    // die besten, bei gleicher Wertung die früheren; danach in zeitlicher Reihenfolge
    const top = scored
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (b.s.score - a.s.score) || (a.i - b.i))
      .slice(0, THRESH.airSlots)
      .map((x) => x.s)
      .sort((a, b) => a.ms - b.ms);
    let bi = 0;
    top.forEach((s, i) => { if (s.score > top[bi].score) { bi = i; } });
    if (top.length) { top[bi].best = true; }
    return { indoorDew, slots: top };
  }

  const api = {
    THRESH,
    DEFAULT_THRESH,
    PROFILES,
    ALERT_RX_DE,
    ALERT_RX_EN,
    SEVERE_RX,
    thresholds,
    degreeDay,
    dewPoint,
    night,
    lead,
    alertMatches,
    activeAlerts,
    assess,
    plan,
    isDue,
    airSlots
  };
  root.Heizwarte.heat = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : window);
