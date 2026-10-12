/*
 * Heizwarte — Farbrechnung für die Kontrasttests: OKLCH → sRGB-Hex und WCAG-Kontrastverhältnis.
 *
 * Quelle: spectroton/js/app.js (gleicher Autor, MIT-Lizenz, Copyright (c) 2026 Dennis Ulmer), dort
 *   Zeilen 8–32    clamp01, srgbToLin, linToSrgb, hexToRgb, rgbToHex
 *   Zeilen 45–55   oklabToLinRgb
 *   Zeilen 68–71   oklchToLinRgb
 *   Zeilen 105–123 oklchToHex, relLum, contrast
 * wortgleich bis auf die Schreibweise (Anführungszeichen, Kommentare). Nicht übernommen: linRgbToOklab, hexToOklch,
 * inSrgb, inP3, clampChroma und APCA; dieser Test braucht sie nicht (BAUPLAN Abschnitt 2, „tests/_farbe.js“).
 *
 * L wird als Anteil übergeben (0…1), wie spectroton app.js:183: oklchToHex(L / 100, C, H). Kanäle außerhalb sRGB
 * werden geklemmt (clamp01), nicht über Chroma abgebildet: Die warmen Stufen 20–32 °C liegen außerhalb von sRGB
 * (BAUPLAN Abschnitt 5 chart, „Keine inSrgb-Prüfung“).
 */
'use strict';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function srgbToLin(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) { return null; }
  let h = m[1];
  if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255
  };
}

function rgbToHex({ r, g, b }) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + (h(r) + h(g) + h(b)).toUpperCase();
}

function oklabToLinRgb(L, a, bb) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  };
}

// Rohes lineares sRGB für ein OKLCH-Tripel (L als Anteil 0…1, H in Grad)
function oklchToLinRgb(L, C, H) {
  const rad = H * Math.PI / 180;
  return oklabToLinRgb(L, C * Math.cos(rad), C * Math.sin(rad));
}

function oklchToHex(L, C, H) {
  const lin = oklchToLinRgb(L, C, H);
  return rgbToHex({
    r: linToSrgb(clamp01(lin.r)),
    g: linToSrgb(clamp01(lin.g)),
    b: linToSrgb(clamp01(lin.b))
  });
}

// WCAG 2.2: relative Leuchtdichte und Kontrastverhältnis zweier Hex-Farben
function relLum(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

function contrast(hexA, hexB) {
  const a = relLum(hexA);
  const b = relLum(hexB);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { oklchToHex, contrast };
