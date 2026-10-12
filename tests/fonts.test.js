/*
 * Tests für die selbst gehostete Schrift (BAUPLAN Abschnitt 8, „Schriften“): die vier woff2-Dateien aus
 * @fontsource/atkinson-hyperlegible@5.3.0 liegen unverändert in assets/fonts/ (Größe, Magic, SHA-256), die Lizenz
 * liegt daneben, und css/style.css bindet sie je Stärke in zwei Teilmengen (latin-ext, latin) mit font-display swap
 * ein. Die Zeichenbereiche müssen Polnisch und Türkisch abdecken, sonst fiele ein ł oder ş mitten im Wort auf die
 * Rückfallschrift.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FONTS = path.join(ROOT, 'assets', 'fonts');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

// Erwartung aus Abschnitt 8 (Größen) und aus dem Abruf vom 12.10.2026 (SHA-256)
const FILES = {
  'atkinson-hyperlegible-latin-400-normal.woff2': {
    size: 17208,
    sha256: 'd64ba838ef5472bba248620ec4fd8b5aa7cf0db2908e0bb230600caf279ba7bc',
  },
  'atkinson-hyperlegible-latin-700-normal.woff2': {
    size: 17524,
    sha256: '140e2bd25a7315c8a062508391426b0d8c3297400c947b8d847be28f73a199f0',
  },
  'atkinson-hyperlegible-latin-ext-400-normal.woff2': {
    size: 9384,
    sha256: '61eeb0eb8b881a84d069e67be1723f5b353b0b9b866ad8e7ad9dba66cdc4dabd',
  },
  'atkinson-hyperlegible-latin-ext-700-normal.woff2': {
    size: 9372,
    sha256: '840ced16f975d8abc2594b436d0206649e0c2a7327e36750ff849d3d37c3c02e',
  },
};

// Alle @font-face-Blöcke als { family, weight, display, src, range }
function faces() {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = m[1];
    const get = (prop) => {
      const r = new RegExp(prop + '\\s*:\\s*([^;]+);').exec(body);
      return r ? r[1].trim() : null;
    };
    out.push({
      family: get('font-family'),
      style: get('font-style'),
      weight: get('font-weight'),
      display: get('font-display'),
      src: get('src'),
      range: get('unicode-range'),
    });
  }
  return out;
}

// „U+0100-02BA, U+0304“ → Prüfung, ob ein Zeichen im Bereich liegt
function covers(range, cp) {
  return range.split(',').some((part) => {
    const m = /^\s*U\+([0-9A-F]+)(?:-([0-9A-F]+))?\s*$/i.exec(part);
    assert.ok(m, 'unicode-range nicht lesbar: ' + part);
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    return cp >= lo && cp <= hi;
  });
}

function pick(weight, subset) {
  return faces().find((f) => f.weight === weight && new RegExp('-' + subset + '-' + weight).test(f.src));
}

test('die vier woff2-Dateien liegen unverändert in assets/fonts/ (Größe, Magic wOF2, SHA-256)', () => {
  for (const [name, want] of Object.entries(FILES)) {
    const file = path.join(FONTS, name);
    assert.ok(fs.existsSync(file), name + ' fehlt');
    const buf = fs.readFileSync(file);
    assert.equal(buf.length, want.size, name + ': Größe');
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', name + ': Magic');
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), want.sha256, name + ': SHA-256');
  }
});

test('OFL.txt liegt neben den Schriften: SIL Open Font License 1.1 mit dem Urheberrechtsvermerk', () => {
  const ofl = fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8');
  assert.match(ofl, /^Copyright 2020 Braille Institute of America, Inc\./);
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.ok(!ofl.includes('\r'), 'LF statt CRLF');
});

test('style.css hat genau vier @font-face: Atkinson Hyperlegible 400 und 700, je latin-ext und latin, font-display swap', () => {
  const all = faces();
  assert.equal(all.length, 4);
  for (const f of all) {
    assert.equal(f.family, '"Atkinson Hyperlegible"');
    assert.equal(f.style, 'normal');
    assert.equal(f.display, 'swap');
    assert.ok(f.range, 'unicode-range fehlt');
  }
  for (const weight of ['400', '700']) {
    for (const subset of ['latin-ext', 'latin']) {
      const f = pick(weight, subset);
      assert.ok(f, weight + ' ' + subset + ' fehlt');
      const name = 'atkinson-hyperlegible-' + subset + '-' + weight + '-normal.woff2';
      assert.equal(f.src, 'url("../assets/fonts/' + name + '") format("woff2")');
      assert.ok(fs.existsSync(path.join(FONTS, name)), name + ' fehlt im Ordner');
    }
  }
});

test('die Zeichenbereiche sind die der Startseite: latin deckt Deutsch ab, latin-ext Polnisch und Türkisch', () => {
  for (const weight of ['400', '700']) {
    const latin = pick(weight, 'latin').range;
    const ext = pick(weight, 'latin-ext').range;
    // latin: ASCII, Umlaute, ß, Grad, Minuszeichen, Euro, typografischer Apostroph und Gedankenstrich
    for (const cp of [0x41, 0x7a, 0xe4, 0xf6, 0xfc, 0xdf, 0xb0, 0xb7, 0x2212, 0x20ac, 0x2019, 0x2013, 0x2014]) {
      assert.ok(covers(latin, cp), 'latin ' + weight + ' ohne U+' + cp.toString(16));
    }
    // latin-ext: ą ę ł ś ź ż ć ń (pl) und ş ğ İ (tr), dazu ı aus latin (U+0131)
    for (const cp of [0x105, 0x119, 0x142, 0x15b, 0x17a, 0x17c, 0x107, 0x144, 0x15f, 0x11f, 0x130]) {
      assert.ok(covers(ext, cp), 'latin-ext ' + weight + ' ohne U+' + cp.toString(16));
      assert.ok(!covers(latin, cp), 'latin ' + weight + ' darf U+' + cp.toString(16) + ' nicht doppeln');
    }
    assert.ok(covers(latin, 0x131), 'ı (U+0131) gehört zu latin');
  }
  // dieselben Bereiche in beiden Stärken
  assert.equal(pick('400', 'latin').range, pick('700', 'latin').range);
  assert.equal(pick('400', 'latin-ext').range, pick('700', 'latin-ext').range);
});

test('--body nennt Atkinson Hyperlegible zuerst, dann Segoe UI und die Systemschrift; Zahlen laufen tabellarisch', () => {
  assert.match(css, /--body:\s*"Atkinson Hyperlegible",\s*"Segoe UI",\s*system-ui,\s*sans-serif;/);
  assert.match(css, /--mono:\s*ui-monospace,\s*"Cascadia Mono",\s*Consolas,\s*monospace;/);
  assert.match(css, /body\s*\{[^}]*font: 1\.125rem\/1\.5 var\(--body\);[^}]*font-variant-numeric: tabular-nums;/);
});

test('die CSS lädt keine Schrift von fremden Servern (CSP font-src self)', () => {
  assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(css, /url\(\s*['"]?(?!\.\.\/assets\/fonts\/)[^)'"]*\.(woff2?|ttf|otf)/i);
});
