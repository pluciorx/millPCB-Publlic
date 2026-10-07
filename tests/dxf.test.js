#!/usr/bin/env node
// Automated DXF export tests (Node, no browser).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

const exportCtx = { module: { exports: {} }, console };
const dxfCtx = { module: { exports: {} }, console };
loadScript('js/export.js', exportCtx);
loadScript('js/dxf.js', dxfCtx);
const Export = exportCtx.module.exports;
const Dxf = dxfCtx.module.exports;

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
        millSpindleDwell: 2, millProfile: 'grbl',
        dxfMode: 'standard'
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

function generate(app, options) {
    return Dxf.generateFromApp(app, Export, options);
}

// Independent pair-walker (does not use Dxf.parse).
function parsePairsIndependent(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        pairs.push({ code: parseInt(lines[i], 10), value: lines[i + 1] });
    }
    return pairs;
}

function independentScan(text) {
    const pairs = parsePairsIndependent(text);
    const layers = [];
    const entities = [];
    const summary = { LINE: 0, LWPOLYLINE: 0, POLYLINE: 0, VERTEX: 0, SEQEND: 0, CIRCLE: 0, ARC: 0 };
    let section = null;
    let i = 0;
    let current = null;
    const flush = () => { if (current) { entities.push(current); current = null; } };

    while (i < pairs.length) {
        const g = pairs[i];
        if (g.code === 0 && g.value === 'SECTION') {
            flush();
            section = pairs[i + 1] && pairs[i + 1].code === 2 ? pairs[i + 1].value : null;
            i += 2;
            continue;
        }
        if (g.code === 0 && g.value === 'ENDSEC') { flush(); section = null; i++; continue; }
        if (g.code === 0 && g.value === 'EOF') break;
        if (section === 'TABLES' && g.code === 0 && g.value === 'LAYER') {
            let name = null;
            i++;
            while (i < pairs.length && pairs[i].code !== 0) {
                if (pairs[i].code === 2) name = pairs[i].value;
                i++;
            }
            if (name) layers.push(name);
            continue;
        }
        if (section === 'ENTITIES' && g.code === 0) {
            const type = g.value;
            if (summary[type] !== undefined) summary[type]++;
            const ent = { type, layer: '0', points: [], closed: false };
            i++;
            while (i < pairs.length && pairs[i].code !== 0) {
                const p = pairs[i];
                if (p.code === 8) ent.layer = p.value;
                if (p.code === 70) ent.flags = parseInt(p.value, 10);
                if (p.code === 10) ent._x = parseFloat(p.value);
                if (p.code === 20) {
                    const y = parseFloat(p.value);
                    if (ent._x != null) {
                        ent.points.push({ x: ent._x, y });
                        if (ent.x == null) { ent.x = ent._x; ent.y = y; }
                    }
                    ent._x = null;
                }
                if (p.code === 11) ent.x2 = parseFloat(p.value);
                if (p.code === 21) ent.y2 = parseFloat(p.value);
                if (p.code === 30 || p.code === 31) {
                    const z = parseFloat(p.value);
                    if (Math.abs(z) > 1e-9) ent.nonzeroZ = true;
                }
                if (p.code === 40) ent.r = parseFloat(p.value);
                if (p.code === 41) ent.v41 = parseFloat(p.value);
                if (p.code === 43) ent.v43 = parseFloat(p.value);
                i++;
            }
            if (type === 'LINE') {
                ent.x1 = ent.x; ent.y1 = ent.y;
            }
            if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
                ent.closed = (ent.flags & 1) === 1;
            }
            if (type === 'VERTEX' && entities.length) {
                const last = entities[entities.length - 1];
                if (last.type === 'POLYLINE') last.points.push({ x: ent.x, y: ent.y });
            } else if (type !== 'SEQEND') {
                entities.push(ent);
            }
            continue;
        }
        i++;
    }
    return { layers, entities, summary };
}

function outlineBox(result) {
    const pts = [];
    result.entities.filter(e => e.layer === 'OUTLINE').forEach(e => {
        if (e.points) e.points.forEach(p => pts.push(p));
    });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    return { minX, minY, maxX, maxY, pts };
}

function polylineHasWidthGroups(dxf) {
    const lines = dxf.replace(/\r\n/g, '\n').split('\n');
    let inPoly = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '0' && (lines[i + 1] === 'LWPOLYLINE' || lines[i + 1] === 'POLYLINE' || lines[i + 1] === 'VERTEX')) {
            inPoly = true;
            continue;
        }
        if (lines[i] === '0') inPoly = false;
        if (inPoly && (lines[i] === '40' || lines[i] === '41' || lines[i] === '43')) return true;
    }
    return false;
}

function coordValues(dxf) {
    const lines = dxf.replace(/\r\n/g, '\n').split('\n');
    const vals = [];
    let inEntities = false;
    for (let i = 0; i + 1 < lines.length; i++) {
        const code = parseInt(lines[i], 10);
        if (code === 0 && lines[i + 1] === 'SECTION') {
            inEntities = (lines[i + 3] === 'ENTITIES');
            continue;
        }
        if (code === 0 && lines[i + 1] === 'ENDSEC') { inEntities = false; continue; }
        if (!inEntities) continue;
        if (code === 10 || code === 20 || code === 11 || code === 21 || code === 30 || code === 31 ||
            (code === 40 && lines[i - 2] !== '0')) {
            vals.push(lines[i + 1]);
        }
    }
    return vals;
}

// --- Test 1: Basic 100 x 80 mm board outline bounds ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false }
    });
    const result = generate(app);
    assert(result.ok, 'Test 1: generate DXF (' + (result.error || 'ok') + ')');
    const box = outlineBox(result);
    assertClose(box.minX, 0, 1e-6, 'Test 1: outline minX');
    assertClose(box.minY, 0, 1e-6, 'Test 1: outline minY');
    assertClose(box.maxX, 100, 1e-6, 'Test 1: outline maxX');
    assertClose(box.maxY, 80, 1e-6, 'Test 1: outline maxY');
    assert(result.dxf.indexOf('AC1015') !== -1, 'Test 1: AC1015');
    const pairs = parsePairsIndependent(result.dxf);
    let insunits = null, measurement = null;
    for (let i = 0; i < pairs.length; i++) {
        if (pairs[i].code === 9 && pairs[i].value === '$INSUNITS') insunits = pairs[i + 1].value;
        if (pairs[i].code === 9 && pairs[i].value === '$MEASUREMENT') measurement = pairs[i + 1].value;
    }
    assert(insunits === '4', 'Test 1: $INSUNITS is 4 (got ' + insunits + ')');
    assert(measurement === '1', 'Test 1: $MEASUREMENT is 1 (got ' + measurement + ')');
}

// --- Test 2: Trace width is NOT encoded in DXF ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeComps: false, includeCopperOutlines: false, includeTraces: true, layers: { COPPER_TOP: false, TRACE_TOP: true } },
        traces: [{
            id: 1, layer: 'top', width: 0.5, segmentWidths: [0.5], curved: [false],
            points: [{ x: -40, y: 20 }, { x: -20, y: 20 }]
        }]
    });
    const result = generate(app);
    assert(result.ok, 'Test 2: generate DXF (' + (result.error || 'ok') + ')');
    const text = result.dxf.replace(/\r\n/g, '\n');
    assert(text.indexOf('\n40\n0.5\n') === -1 && text.indexOf('\n40\n0.500000\n') === -1,
        'Test 2: must not contain group 40 = 0.5');
    assert(text.indexOf('\n41\n0.5\n') === -1 && text.indexOf('\n41\n0.500000\n') === -1,
        'Test 2: must not contain group 41 = 0.5');
    assert(text.indexOf('\n43\n0.5\n') === -1 && text.indexOf('\n43\n0.500000\n') === -1,
        'Test 2: must not contain group 43 = 0.5');
    assert(!polylineHasWidthGroups(result.dxf), 'Test 2: polylines must not have 40/41/43');
    const traces = result.entities.filter(e => e.layer === 'TRACE_TOP');
    assert(traces.length === 1, 'Test 2: one TRACE_TOP entity (got ' + traces.length + ')');
    assert(traces[0].type === 'LINE', 'Test 2: isolated segment is LINE (got ' + traces[0].type + ')');
}

// --- Test 3: Drill circle radius = diameter / 2 ---
{
    const app = minimalApp({
        export: { includeTraces: false, includeComps: false, includeCopperOutlines: false, includeHoles: true },
        vias: [{ id: 1, x: 0, y: 0, diameter: 1.6, drill: 0.8 }]
    });
    const result = generate(app);
    assert(result.ok, 'Test 3: generate DXF (' + (result.error || 'ok') + ')');
    const drills = result.entities.filter(e => e.layer === 'DRILL' && e.type === 'CIRCLE');
    assert(drills.length === 1, 'Test 3: one DRILL circle (got ' + drills.length + ')');
    assertClose(drills[0].r, 0.4, 1e-9, 'Test 3: circle radius');
}

// --- Test 4: Closed outline flag 70 = 1 ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false }
    });
    const result = generate(app);
    assert(result.ok, 'Test 4: generate DXF');
    const outline = result.entities.find(e => e.layer === 'OUTLINE');
    assert(!!outline && outline.closed === true, 'Test 4: outline is closed');
    const text = result.dxf.replace(/\r\n/g, '\n');
    const idx = text.indexOf('\nLWPOLYLINE\n8\nOUTLINE\n');
    assert(idx !== -1, 'Test 4: OUTLINE LWPOLYLINE present');
    const slice = text.slice(idx, idx + 80);
    assert(slice.indexOf('\n70\n1\n') !== -1, 'Test 4: 70/1 on outline polyline');
}

// --- Test 5: No 3D geometry (Z = 0) ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: false, includeComps: false },
        traces: [{
            id: 1, layer: 'top', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }],
        vias: [{ id: 2, x: 5, y: 5, diameter: 1.0, drill: 0.5 }]
    });
    const result = generate(app);
    assert(result.ok, 'Test 5: generate DXF');
    const pairs = parsePairsIndependent(result.dxf);
    let zBad = false;
    for (let i = 0; i < pairs.length; i++) {
        if ((pairs[i].code === 30 || pairs[i].code === 31) && Math.abs(parseFloat(pairs[i].value)) > 1e-9) zBad = true;
    }
    assert(!zBad, 'Test 5: all Z values are 0');
}

// --- Test 6: Precision — '.' decimal separator, six decimal places ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false }
    });
    const result = generate(app);
    assert(result.ok, 'Test 6: generate DXF');
    assert(result.dxf.indexOf(',') === -1, 'Test 6: no comma decimal separators');
    const coords = coordValues(result.dxf);
    assert(coords.length > 0, 'Test 6: has coordinates');
    coords.forEach(v => {
        assert(/^-?\d+\.\d{6}$/.test(v), 'Test 6: six decimal places (got ' + v + ')');
        assert(!/[eE]/.test(v), 'Test 6: no scientific notation (' + v + ')');
    });
    const stripped = result.dxf.replace(/\r\n/g, '');
    assert(stripped.indexOf('\n') === -1 && stripped.indexOf('\r') === -1, 'Test 6: CRLF line endings');
}

// --- Test 7: Parser round-trip ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: false, includeComps: false },
        traces: [{
            id: 1, layer: 'top', width: 0.4, curved: [false, false],
            points: [{ x: -20, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }]
        }],
        vias: [{ id: 2, x: 0, y: 0, diameter: 1.0, drill: 0.6 }]
    });
    const result = generate(app);
    assert(result.ok, 'Test 7: generate DXF (' + (result.error || 'ok') + ')');
    const parsed = Dxf.parse(result.dxf);
    assert(parsed.ok, 'Test 7: Dxf.parse (' + (parsed.error || 'ok') + ')');
    const indie = independentScan(result.dxf);
    assert(indie.summary.CIRCLE === parsed.summary.CIRCLE, 'Test 7: independent CIRCLE count');
    assert(indie.summary.LINE + indie.summary.LWPOLYLINE ===
        parsed.summary.LINE + parsed.summary.LWPOLYLINE, 'Test 7: independent line/poly count');
    assert(indie.layers.indexOf('OUTLINE') !== -1, 'Test 7: OUTLINE layer');
    assert(indie.layers.indexOf('TRACE_TOP') !== -1, 'Test 7: TRACE_TOP layer');
    assert(indie.layers.indexOf('DRILL') !== -1, 'Test 7: DRILL layer');
    assert(indie.layers.every(n => /^[A-Z0-9_]+$/.test(n)), 'Test 7: ASCII layer names');
    const box = outlineBox(result);
    assertClose(box.minX, 0, 1e-6, 'Test 7: bbox minX');
    assertClose(box.maxX, 100, 1e-6, 'Test 7: bbox maxX');
}

// --- Test 8: Legacy POLYLINE / VERTEX / SEQEND ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false, dxfMode: 'legacy' }
    });
    const result = generate(app, { mode: 'legacy' });
    assert(result.ok, 'Test 8: generate legacy DXF (' + (result.error || 'ok') + ')');
    assert(result.dxf.indexOf('LWPOLYLINE') === -1, 'Test 8: no LWPOLYLINE');
    assert(result.dxf.indexOf('\nPOLYLINE\r') !== -1 || result.dxf.indexOf('\nPOLYLINE\n') !== -1 ||
        result.dxf.split('\r\n').indexOf('POLYLINE') !== -1, 'Test 8: POLYLINE present');
    assert(result.dxf.split('\r\n').indexOf('VERTEX') !== -1, 'Test 8: VERTEX present');
    assert(result.dxf.split('\r\n').indexOf('SEQEND') !== -1, 'Test 8: SEQEND present');
    const parsed = Dxf.parse(result.dxf);
    assert(parsed.ok, 'Test 8: parse legacy');
    assert(parsed.summary.POLYLINE >= 1, 'Test 8: parsed POLYLINE count');
    assert(parsed.summary.VERTEX >= 3, 'Test 8: parsed VERTEX count');
    assert(parsed.summary.SEQEND >= 1, 'Test 8: parsed SEQEND count');
    assert(parsed.summary.LWPOLYLINE === 0, 'Test 8: parsed LWPOLYLINE is 0');
    const indie = independentScan(result.dxf);
    assert(indie.summary.POLYLINE >= 1 && indie.summary.VERTEX >= 3 && indie.summary.SEQEND >= 1,
        'Test 8: independent parser sees legacy polyline');
}

// --- Test 9: Deterministic export ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: false, includeComps: false },
        traces: [{
            id: 1, layer: 'top', width: 0.5, curved: [false],
            points: [{ x: -10, y: -5 }, { x: 10, y: -5 }]
        }],
        vias: [{ id: 2, x: 2, y: 3, diameter: 1.2, drill: 0.7 }]
    });
    const a = generate(app);
    const b = generate(app);
    assert(a.ok && b.ok, 'Test 9: both exports succeeded');
    assert(a.dxf === b.dxf, 'Test 9: byte-for-byte identical re-export');
}

// --- Extra: inches setting must not scale DXF (always mm) ---
{
    const app = minimalApp({
        export: { units: 'inches', includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false }
    });
    const result = generate(app);
    assert(result.ok, 'Units: generate DXF');
    const box = outlineBox(result);
    assertClose(box.maxX, 100, 1e-6, 'Units: outline still 100 mm (not inches)');
    const pairs = parsePairsIndependent(result.dxf);
    let insunits = null;
    for (let i = 0; i < pairs.length; i++) {
        if (pairs[i].code === 9 && pairs[i].value === '$INSUNITS') insunits = pairs[i + 1].value;
    }
    assert(insunits === '4', 'Units: $INSUNITS stays 4');
}

// --- Extra: no tool compensation on outline ---
{
    const app = minimalApp({
        export: {
            includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false,
            millOutlineToolDia: 0.2
        }
    });
    const result = generate(app);
    const box = outlineBox(result);
    assertClose(box.minX, 0, 1e-9, 'No CAM offset: minX');
    assertClose(box.maxX, 100, 1e-9, 'No CAM offset: maxX');
    assertClose(box.minY, 0, 1e-9, 'No CAM offset: minY');
    assertClose(box.maxY, 80, 1e-9, 'No CAM offset: maxY');
}

// --- Extra: invalid geometry fails the export ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeComps: false, includeCopperOutlines: false, includeTraces: true, layers: { COPPER_TOP: false, TRACE_TOP: true } },
        traces: [{
            id: 1, layer: 'top', width: 0.5, curved: [false],
            points: [{ x: NaN, y: 0 }, { x: 1, y: 0 }]
        }]
    });
    const result = generate(app);
    assert(!result.ok, 'Invalid geometry: export must fail');
}

// --- Extra: no HATCH / SPLINE / XDATA ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [{
            id: 1, layer: 'top', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }]
    });
    const result = generate(app);
    assert(result.ok, 'Forbidden entities: generate (' + (result.error || 'ok') + ')');
    const lines = new Set(result.dxf.split('\r\n'));
    ['HATCH', 'SPLINE', 'ELLIPSE', 'INSERT', '3DSOLID', 'REGION', '1001'].forEach(tok => {
        assert(!lines.has(tok), 'Forbidden entities: no ' + tok);
    });
}

// --- COPPER: Merged overlapping trace + via ring → single closed loop on COPPER_TOP ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [{
            id: 1, layer: 'top', width: 1.0, curved: [false],
            points: [{ x: -5, y: 0 }, { x: 5, y: 0 }]
        }],
        vias: [{ id: 2, x: 0, y: 0, diameter: 1.6, drill: 0.8 }]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER merged: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    // Trace outline overlaps via ring — they should merge into a single loop
    assert(copperTop.length === 1, 'COPPER merged: exactly 1 COPPER_TOP loop (got ' + copperTop.length + ')');
    const poly = copperTop[0];
    assert((poly.type === 'LWPOLYLINE' || poly.type === 'POLYLINE') && poly.closed === true,
        'COPPER merged: entity is a closed polyline');
}

// --- COPPER: Separated traces → distinct loops ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [
            { id: 1, layer: 'top', width: 0.5, curved: [false], points: [{ x: -30, y: -10 }, { x: -20, y: -10 }] },
            { id: 2, layer: 'top', width: 0.5, curved: [false], points: [{ x: 20, y: 10 }, { x: 30, y: 10 }] }
        ]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER separated: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    assert(copperTop.length === 2, 'COPPER separated: exactly 2 COPPER_TOP loops (got ' + copperTop.length + ')');
}

// --- COPPER: Bottom hidden → no COPPER_BOTTOM entities ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        view: { visibleLayers: { bottom: false } },
        traces: [{
            id: 1, layer: 'bottom', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER bottom hidden: generate (' + (result.error || 'ok') + ')');
    const copperBottom = result.entities.filter(e => e.layer === 'COPPER_BOTTOM');
    assert(copperBottom.length === 0, 'COPPER bottom hidden: no COPPER_BOTTOM entities (got ' + copperBottom.length + ')');
}

// --- COPPER: Bottom visible → COPPER_BOTTOM entities present ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        view: { visibleLayers: { bottom: true } },
        traces: [{
            id: 1, layer: 'bottom', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER bottom visible: generate (' + (result.error || 'ok') + ')');
    const copperBottom = result.entities.filter(e => e.layer === 'COPPER_BOTTOM');
    assert(copperBottom.length >= 1, 'COPPER bottom visible: has COPPER_BOTTOM entities (got ' + copperBottom.length + ')');
}

// --- Explicit export.layers overrides view visibility ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true, layers: { COPPER_BOTTOM: false, TRACE_OUTLINE_BOTTOM: false, TRACE_BOTTOM: false } },
        view: { visibleLayers: { bottom: true } },
        traces: [{
            id: 1, layer: 'bottom', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }]
    });
    const result = generate(app);
    assert(result.ok, 'explicit bottom layers off: generate (' + (result.error || 'ok') + ')');
    assert(result.entities.filter(e => e.layer === 'COPPER_BOTTOM').length === 0, 'explicit COPPER_BOTTOM=false: no COPPER_BOTTOM despite visible bottom view');
    assert(result.entities.filter(e => e.layer === 'TRACE_OUTLINE_BOTTOM' || e.layer === 'TRACE_BOTTOM').length === 0, 'explicit bottom trace layers off: no bottom trace entities');
}

// --- Per-layer selection keeps top layers independent ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true, layers: { PAD_TOP: false, TRACE_OUTLINE_TOP: false } },
        traces: [{
            id: 1, layer: 'top', width: 0.5, curved: [false],
            points: [{ x: -10, y: 0 }, { x: 10, y: 0 }]
        }],
        components: [{ id: 1, x: 20, y: 0, rot: 0, layer: 'top', defName: 'res', pins: [{ x: -1, y: 0 }, { x: 1, y: 0 }] }]
    });
    app.getCompSize = () => ({ pins: app.components[0].pins });
    const result = generate(app);
    assert(result.ok, 'per-layer top selection: generate (' + (result.error || 'ok') + ')');
    assert(result.entities.filter(e => e.layer === 'PAD_TOP').length === 0, 'PAD_TOP=false: no pad entities');
    assert(result.entities.filter(e => e.layer === 'TRACE_OUTLINE_TOP').length === 0, 'TRACE_OUTLINE_TOP=false: no trace outline entities');
    assert(result.entities.filter(e => e.layer === 'COPPER_TOP').length >= 1, 'COPPER_TOP still present with merged copper (pads + traces)');
}

// --- COPPER: Isolated via ring → single closed contour ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        vias: [{ id: 1, x: 0, y: 0, diameter: 2.0, drill: 1.0 }]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER isolated via: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    assert(copperTop.length === 1, 'COPPER isolated via: exactly 1 COPPER_TOP loop (got ' + copperTop.length + ')');
    assert(copperTop[0].closed === true, 'COPPER isolated via: loop is closed');
}

// --- COPPER: No copper → no COPPER entities ---
{
    const app = minimalApp({
        export: { includeHoles: false, includeTraces: false, includeComps: false, includeCopperOutlines: false }
    });
    const result = generate(app);
    assert(result.ok, 'COPPER empty: generate (' + (result.error || 'ok') + ')');
    const copperAll = result.entities.filter(e => e.layer === 'COPPER_TOP' || e.layer === 'COPPER_BOTTOM');
    assert(copperAll.length === 0, 'COPPER empty: no COPPER entities (got ' + copperAll.length + ')');
}

// --- COPPER: Two collinear overlapping traces → single merged island ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [
            { id: 1, layer: 'top', width: 0.5, curved: [false], points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
            { id: 2, layer: 'top', width: 0.5, curved: [false], points: [{ x: 10, y: 0 }, { x: 30, y: 0 }] }
        ]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER collinear overlap: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    assert(copperTop.length === 1, 'COPPER collinear overlap: exactly 1 COPPER_TOP loop (got ' + copperTop.length + ')');
}

// --- COPPER: T-junction (perpendicular trace ending on horizontal) → single island ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [
            { id: 1, layer: 'top', width: 0.5, curved: [false], points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
            { id: 2, layer: 'top', width: 0.5, curved: [false], points: [{ x: 10, y: -3 }, { x: 10, y: 0 }] }
        ]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER T-junction: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    assert(copperTop.length === 1, 'COPPER T-junction: exactly 1 COPPER_TOP loop (got ' + copperTop.length + ')');
}

// --- COPPER: V-junction (two traces meeting at an angle) → single island ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [
            { id: 1, layer: 'top', width: 0.5, curved: [false], points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
            { id: 2, layer: 'top', width: 0.5, curved: [false], points: [{ x: 10, y: 0 }, { x: 15, y: 5 }] }
        ]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER V-junction: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    assert(copperTop.length === 1, 'COPPER V-junction: exactly 1 COPPER_TOP loop (got ' + copperTop.length + ')');
}

// --- COPPER: Two overlapping rectangles (simulated via wide traces) → single island ---
{
    const app = minimalApp({
        export: { includeCopperOutlines: true },
        traces: [
            { id: 1, layer: 'top', width: 2.0, curved: [false], points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] },
            { id: 2, layer: 'top', width: 2.0, curved: [false], points: [{ x: 3, y: 0 }, { x: 8, y: 0 }] }
        ]
    });
    const result = generate(app);
    assert(result.ok, 'COPPER wide overlap: generate (' + (result.error || 'ok') + ')');
    const copperTop = result.entities.filter(e => e.layer === 'COPPER_TOP');
    assert(copperTop.length === 1, 'COPPER wide overlap: exactly 1 COPPER_TOP loop (got ' + copperTop.length + ')');
}

console.log('Passed:', passed, 'Failed:', failed);
process.exit(failed ? 1 : 0);
