// One-shot: parse libs/*.kicad_mod into js/kicad-lib-embed.js so footprints
// work without fetch (file://, Cursor preview, first paint).
// Run: node tools/embed-kicad-libs.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const ctx = { console };

function load(name) {
    const file = path.join(root, 'js', name);
    const extra = '\nthis.ComponentDefs=typeof ComponentDefs!=="undefined"?ComponentDefs:this.ComponentDefs;'
        + '\nthis.KicadImport=typeof KicadImport!=="undefined"?KicadImport:this.KicadImport;'
        + '\nthis.LibsLoader=typeof LibsLoader!=="undefined"?LibsLoader:this.LibsLoader;';
    vm.runInNewContext(fs.readFileSync(file, 'utf8') + extra, ctx, { filename: name });
}

load('component-defs.js');
load('kicad-import.js');
load('libs-loader.js');

const fileCache = {};
function parseFile(rel) {
    if (!fileCache[rel]) {
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        const fp = ctx.KicadImport._parseFootprint(text);
        if (!fp) throw new Error('parse failed: ' + rel);
        fileCache[rel] = fp;
    }
    return fileCache[rel];
}

const entries = [];
for (const entry of ctx.LibsLoader.manifest) {
    const fp = parseFile(entry.file);
    const size = ctx.LibsLoader._buildSize(fp, entry);
    entries.push({
        cat: entry.cat,
        label: entry.label,
        value: entry.value || undefined,
        size
    });
}

const out = path.join(root, 'js', 'kicad-lib-embed.js');
const body = 'const KicadLibEmbed = ' + JSON.stringify({ entries }) + ';\n';
fs.writeFileSync(out, body);
console.log('wrote', out, 'entries', entries.length, 'bytes', body.length);
