/* Kleiner statischer Entwicklungsserver ohne Abhängigkeiten: node tools/dev-server.js */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8619;

// Wie GitHub Pages: der Pfad muss in genau dieser Schreibweise da sein. Windows (NTFS) fände INDEX.html sonst
// auch als index.html, und ein Groß/Klein-Fehler bliebe in jedem lokalen Test unsichtbar.
function exakt(file) {
  let ordner = ROOT;
  for (const teil of path.relative(ROOT, file).split(path.sep)) {
    let namen;
    try { namen = fs.readdirSync(ordner); } catch (e) { return false; }
    if (!namen.includes(teil)) return false;
    ordner = path.join(ordner, teil);
  }
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    // kaputte Prozentkodierung darf den Prozess nicht beenden
    res.writeHead(400); res.end(); return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  // ROOT plus Trenner prüfen, sonst käme ein Nachbarordner wie "heizwarte-foo" durch
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!exakt(file)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`heizwarte dev server: http://localhost:${PORT}`));
