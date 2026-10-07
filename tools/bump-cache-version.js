// Bump the ?v= cache-busting token on every asset tag in index.html.
// Run before a release so millpcb.com's page cache cannot serve stale
// js/css to returning visitors: a new token is a new URL, so the host
// must fetch the published file.
//   node tools/bump-cache-version.js            -> 20261005-1 => 20261005-2
//   node tools/bump-cache-version.js 20261006-1 -> set an explicit token
const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '..', 'index.html');
const TOKEN = /\?v=(\d{8}-\d+)"/g;

let html = fs.readFileSync(file, 'utf8');
const found = [...html.matchAll(TOKEN)].map(m => m[1]);
if (!found.length) {
    console.error('index.html has no ?v=YYYYMMDD-N asset tokens to bump.');
    process.exit(1);
}
const current = found[0];

const arg = process.argv[2];
let next;
if (arg) {
    if (!/^\d{8}-\d+$/.test(arg)) {
        console.error(`token "${arg}" must look like 20261005-1`);
        process.exit(1);
    }
    next = arg;
} else {
    const distinct = [...new Set(found)];
    if (distinct.length > 1) {
        console.error(`index.html mixes ${distinct.length} tokens — pass one explicitly:`);
        for (const t of distinct) console.error('  ' + t);
        process.exit(1);
    }
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const day = current.slice(0, 8);
    const n = Number(current.slice(9));
    next = `${today}-${day === today ? n + 1 : 1}`;
}

if (next === current) {
    console.log(`token already ${current} — nothing to do`);
    process.exit(0);
}

html = html.replace(TOKEN, `?v=${next}"`);
fs.writeFileSync(file, html, 'utf8');
console.log(`bumped ${current} -> ${next} on ${found.length} asset tags`);
