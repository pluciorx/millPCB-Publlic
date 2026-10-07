#!/usr/bin/env node
// Automated G-code geometry and generation tests (Node, no browser).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

const exportCtx = { module: { exports: {} }, console };
const gcodeCtx = { module: { exports: {} }, console };
loadScript('js/export.js', exportCtx);
loadScript('js/gcode.js', gcodeCtx);
const Export = exportCtx.module.exports;
const GCode = gcodeCtx.module.exports;

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        return;
    }
    failed++;
    console.error('FAIL:', message);
}

function assertClose(a, b, eps, message) {
    assert(Math.abs(a - b) <= eps, `${message} (expected ${b}, got ${a})`);
}

function defaultExport(overrides) {
    return Object.assign({
        kerfWidth: 0.15, units: 'mm',
        includeHoles: true, includeTraces: true, includeComps: true,
        includeBoardOutline: true, includeCopperOutlines: true,
        millToolDia: 0.2, millIsoDepth: 0.1, millSafeZ: 5,
        millFeed: 120, millPlunge: 50, millSpindle: 10000,
        millDrillToolDia: 0.8, millOutlineToolDia: 0.2,
        millDrillFeed: 50, millOutlineFeed: 72,
        millOutlinePasses: 3, millOutlineOvercut: 0, millDrillOvercut: 0.1,
        millSpindleDwell: 2, millProfile: 'grbl'
    }, overrides || {});
}

function minimalApp(overrides) {
    const o = overrides || {};
    return {
        board: Object.assign({ width: 100, height: 80, thickness: 1.2, material: 'FR4' }, o.board),
        export: defaultExport(o.export),
        traces: o.traces || [],
        components: o.components || [],
        vias: o.vias || [],
        boardOutline: o.boardOutline || [],
        view: Object.assign({ visibleLayers: { bottom: false } }, o.view || {})
    };
}

// --- Board outline bounds ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeCopperOutlines: false },
        vias: []
    });
    const tp = GCode.buildToolpaths(app, Export);
    const outline = tp.sections.find(s => s.type === 'outline');
    assert(!!outline, 'outline section exists');
    const b = outline.bounds;
    assertClose(b.minX, -0.1, 1e-4, 'outline minX');
    assertClose(b.maxX, 100.1, 1e-4, 'outline maxX');
    assertClose(b.minY, -0.1, 1e-4, 'outline minY');
    assertClose(b.maxY, 80.1, 1e-4, 'outline maxY');
}

// --- Outline pass depths ---
{
    const depths = GCode.outlinePassDepths(1.2, 3, 0);
    assert(depths.length === 3, 'three outline passes');
    assertClose(depths[0], 0.4, 1e-6, 'pass 1 depth');
    assertClose(depths[1], 0.8, 1e-6, 'pass 2 depth');
    assertClose(depths[2], 1.2, 1e-6, 'pass 3 depth');
}

// --- Drill depth ---
{
    const depth = GCode.drillDepth(1.2, 0.1);
    assertClose(depth, 1.3, 1e-6, 'drill depth with overcut');
}

// --- Isolation tool diameter compensation ---
{
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const off02 = Export.offsetPolygon(square, 0.1);
    const off04 = Export.offsetPolygon(square, 0.2);
    const max02 = Math.max(...off02.map(p => p.x));
    const max04 = Math.max(...off04.map(p => p.x));
    assert(max04 > max02, '0.4 mm tool produces larger offset than 0.2 mm tool');
}

// --- Drilling retracts to safe Z ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: false, includeBoardOutline: false },
        vias: [{ x: 10, y: 10, diameter: 1.0, drill: 0.8 }]
    });
    const result = GCode.generateFromApp(app, Export);
    assert(result.ok, 'drill-only generation succeeds');
    const lines = result.gcode.split('\n');
    const plungeIdx = lines.findIndex(l => l.includes('G1 Z-1.3000'));
    const retractIdx = lines.findIndex((l, i) => i > plungeIdx && l.includes('G0 Z5.0000'));
    assert(plungeIdx >= 0, 'drill plunge to -1.3 present');
    assert(retractIdx > plungeIdx, 'drill retracts to safe Z after plunge');
}

// --- Explicit export.layers.COPPER_BOTTOM enables bottom isolation even when view hides it ---
{
    const app = minimalApp({
        export: { layers: { COPPER_BOTTOM: true } },
        view: { visibleLayers: { bottom: false } },
        traces: [{
            id: 1, layer: 'bottom', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }]
    });
    const result = GCode.generateFromApp(app, Export);
    assert(result.ok, 'explicit COPPER_BOTTOM=true: generate (' + (result.error || 'ok') + ')');
    assert(result.gcode.includes('ISOLATION BOTTOM'), 'explicit COPPER_BOTTOM=true emits ISOLATION BOTTOM despite hidden bottom view');
}

// --- Spindle sequence ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeCopperOutlines: false }
    });
    const result = GCode.generateFromApp(app, Export);
    assert(result.ok, 'outline-only generation succeeds');
    const lines = result.gcode.split('\n').filter(l => !l.startsWith(';'));
    const zSafeIdx = lines.findIndex(l => l === 'G0 Z5.0000');
    const xyIdx = lines.findIndex((l, i) => i > zSafeIdx && l.startsWith('G0 X') && l.includes(' Y'));
    const m3Idx = lines.findIndex((l, i) => i > xyIdx && l.startsWith('M3 S'));
    const dwellIdx = lines.findIndex((l, i) => i > m3Idx && l.startsWith('G4 P'));
    const plungeIdx = lines.findIndex((l, i) => i > dwellIdx && l.startsWith('G1 Z-'));
    assert(zSafeIdx >= 0, 'safe Z retract in init');
    assert(xyIdx > zSafeIdx, 'XY move after safe Z');
    assert(m3Idx > xyIdx, 'spindle starts after XY positioning');
    assert(dwellIdx > m3Idx, 'dwell after spindle start');
    assert(plungeIdx > dwellIdx, 'plunge after dwell');
    assert(lines.findIndex(l => l.startsWith('M3 S')) === m3Idx, 'M3 not emitted before positioning');
}

// --- Validation rejects unsafe config ---
{
    const app = minimalApp({ board: { width: 100, height: 80, thickness: 1.2 }, export: { millSafeZ: 0.5 } });
    const result = GCode.generateFromApp(app, Export);
    assert(!result.ok, 'low safe Z rejected');
    assert(result.error.includes('Safe Z'), 'validation error mentions safe Z');
}

// --- Program end ---
{
    const app = minimalApp({ export: { includeHoles: false, includeCopperOutlines: false } });
    const result = GCode.generateFromApp(app, Export);
    const tail = result.gcode.trim().split('\n').slice(-4);
    assert(tail[0] === 'M5', 'spindle stopped before end');
    assert(tail[1] === 'G0 Z5.0000', 'retract before homing');
    assert(tail[3] === 'M30', 'program ends with M30');
}

// --- THT test point pads: standard TH TP vs TH TP XL export distinct drills ---
{
    const mkApp = (sizeOverride) => {
        const comp = { id: 1, type: 'gnd', x: 20, y: 30, rotation: 0, layer: 'top', pins: [{ x: 0, y: 0 }] };
        const app = minimalApp({ components: [comp] });
        app.getCompSize = () => Object.assign({ th: true, pins: [{ x: 0, y: 0 }] }, sizeOverride);
        return app;
    };

    // Standard TH TP (no padR/drillDia): pitch-based Ø2mm pad, 0.8mm drill.
    const std = GCode.buildToolpaths(mkApp({}), Export);
    const stdDrill = std.sections.find(s => s.type === 'drill');
    assert(!!stdDrill && stdDrill.holes.length === 1, 'TH TP: one drill hole');
    assertClose(stdDrill.toolDiameter, 0.8, 1e-6, 'TH TP drill section uses 0.8mm tool');

    // TH TP XL: Ø4mm pad with 1.2mm drill → own drill section.
    const xl = GCode.buildToolpaths(mkApp({ padR: 2.0, drillDia: 1.2 }), Export);
    const xlDrill = xl.sections.find(s => s.type === 'drill');
    assert(!!xlDrill && xlDrill.holes.length === 1, 'TH TP XL: one drill hole');
    assertClose(xlDrill.toolDiameter, 1.2, 1e-6, 'TH TP XL drill section uses 1.2mm tool');

    // Mixed diameters (via + XL pad) → one section per diameter, sorted ascending.
    const app = mkApp({ padR: 2.0, drillDia: 1.2 });
    app.vias = [{ x: 10, y: 10, diameter: 1.0, drill: 0.8 }];
    const mixed = GCode.buildToolpaths(app, Export);
    const drills = mixed.sections.filter(s => s.type === 'drill');
    assert(drills.length === 2, 'mixed diameters produce two drill sections');
    if (drills.length === 2) {
        assertClose(drills[0].toolDiameter, 0.8, 1e-6, 'first drill section is 0.8mm');
        assert(drills[0].holes.length === 1, '0.8mm section has the via hole');
        assertClose(drills[1].toolDiameter, 1.2, 1e-6, 'second drill section is 1.2mm');
        assert(drills[1].holes.length === 1, '1.2mm section has the XL pad hole');
    }

    // G-code text labels each drill block with its tool size.
    const result = GCode.generateFromApp(app, Export);
    assert(result.ok, 'mixed-drill generation succeeds');
    assert(result.gcode.includes('0.8 mm drill'), 'gcode labels 0.8mm drill block');
    assert(result.gcode.includes('1.2 mm drill'), 'gcode labels 1.2mm drill block');
}

console.log(`G-code tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
