// Zero-dependency static file server for local development (no build step, no npm install).
// Usage: npm run server   (or: node server.js [port])
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.kicad_mod': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('Forbidden'); return;
    }

    fs.stat(filePath, (err, stat) => {
        const target = (!err && stat.isDirectory()) ? path.join(filePath, 'index.html') : filePath;
        fs.readFile(target, (err2, data) => {
            if (err2) { res.writeHead(404).end('Not found: ' + urlPath); return; }
            const ext = path.extname(target).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
            res.end(data);
        });
    });
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try: node server.js 9000`);
    else console.error(e.message);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`millPCB running at http://localhost:${PORT}/  (Ctrl+C to stop)`);
});