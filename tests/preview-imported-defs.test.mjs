#!/usr/bin/env node
// Imported kx_* footprints must travel with the preview snapshot and survive a reload.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernel, ProjectSession } from '../mcp/host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fpPath = path.join(ROOT, 'libs', 'leds', 'LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm.kicad_mod');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

const autoSave = path.join(os.tmpdir(), `millpcb-preview-defs-${process.pid}.pcb.json`);
try {
    const { ComponentDefs } = loadKernel(ROOT);
    const session = new ProjectSession(ROOT, { autoSaveFile: autoSave });
    session.newProject(true);

    const fp = session.KicadImport._parseFootprint(fs.readFileSync(fpPath, 'utf8'));
    const def = session.KicadImport._buildDef(fp, null);
    // Refresh path used to keep the geometry and drop `key`, which the preview then skipped.
    const bare = { ...def, key: undefined, kicadImported: true };
    ComponentDefs.defs[def.key] = bare;
    session.KicadImport.registerEntries([def]);
    const stamped = session.KicadImport.getImportedDefs().find(d => d.key === def.key);
    assert(stamped && stamped.sizes[0].kicad.pads.length >= 4, 'registerEntries keeps key and pad geometry');

    const beforePlace = session.snapshot();
    assert(beforePlace.importedDefs.some(d => d.key === def.key), 'snapshot lists the footprint before it is placed');
    session.mutate(p => session.ProjectApi.addComponent(p, { type: def.key, x: 0, y: 0, label: 'LED1' }));
    const snap = session.snapshot();
    assert(snap.importedDefs.some(d => d.key === def.key), 'snapshot lists the placed footprint');
    assert(snap.project.importedDefs.some(d => d.key === def.key), 'serialized project carries the same footprint');

    session.saveProject();
    delete ComponentDefs.defs[def.key];
    assert(!ComponentDefs.get(def.key), 'footprint removed from the live library');

    const session2 = new ProjectSession(ROOT, { autoSaveFile: autoSave });
    session2.loadParsed(JSON.parse(fs.readFileSync(autoSave, 'utf8')));
    const again = session2.snapshot();
    assert(again.importedDefs.some(d => d.key === def.key && d.sizes[0].kicad.pads.length >= 4), 'reloaded session restores the footprint for the preview');
    assert(ComponentDefs.get(def.key), 'reloaded footprint is installed for drawing');
} finally {
    try { fs.unlinkSync(autoSave); } catch (e) { /* temp file */ }
}

console.log(`preview-imported-defs: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
