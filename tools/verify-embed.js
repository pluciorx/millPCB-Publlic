const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const ctx = { console };
function load(n) {
    const extra = '\nthis.ComponentDefs=typeof ComponentDefs!=="undefined"?ComponentDefs:this.ComponentDefs;'
        + '\nthis.KicadImport=typeof KicadImport!=="undefined"?KicadImport:this.KicadImport;'
        + '\nthis.KicadLibEmbed=typeof KicadLibEmbed!=="undefined"?KicadLibEmbed:this.KicadLibEmbed;'
        + '\nthis.LibsLoader=typeof LibsLoader!=="undefined"?LibsLoader:this.LibsLoader;';
    vm.runInNewContext(fs.readFileSync(path.join(root, 'js', n), 'utf8') + extra, ctx, { filename: n });
}
load('component-defs.js');
load('kicad-lib-embed.js');
load('kicad-import.js');
load('libs-loader.js');
ctx.LibsLoader.applyEmbed();
const u = ctx.ComponentDefs.get('arduino_uno').sizes[0];
const e = ctx.ComponentDefs.get('esp32_devkit').sizes[0];
if (!u.kicad || u.kicad.pads.length < 30) throw new Error('uno missing kicad pads');
if (!e.kicad || e.pins.length < 30) throw new Error('esp missing pins');
console.log('uno pads', u.kicad.pads.length, 'silk', u.kicad.silk.length, 'pin0', u.pins[0].name);
console.log('esp pads', e.kicad.pads.length, 'pins', e.pins.length, e.pins.slice(0, 5).map(p => p.name).join(','));
console.log('ok');
