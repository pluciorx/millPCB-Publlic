#!/usr/bin/env node
// Automated project-kernel (ProjectApi) tests — Node vm, no browser.
// Loads the same core scripts the MCP host will load, into one shared
// context (mirroring the browser global scope), then exercises the
// DOM-free kernel end to end.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

// Shared context: the kernel sees ComponentDefs / Export / Dxf / GCode /
// computeDrcViolations as free globals, exactly like in the browser.
const ctx = { console, App: {}, module: { exports: {} } }; // App stub — drc.js does Object.assign(App, ...)
loadScript('js/component-defs.js', ctx);
loadScript('js/export.js', ctx);
loadScript('js/dxf.js', ctx);
loadScript('js/gcode.js', ctx);
loadScript('js/drc.js', ctx);
// Board interaction ops — pure data functions on App (no DOM at load time),
// needed for the JP jumper anchoring regression tests below.
loadScript('js/hit-test.js', ctx);
loadScript('js/trace-ops.js', ctx);
loadScript('js/project-api.js', ctx);
const ProjectApi = ctx.module.exports;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}
function assertClose(a, b, eps, msg) {
    assert(Math.abs(a - b) <= eps, `${msg} (expected ${b}, got ${a})`);
}

// ============================================================
// 1. createEmptyProject shape
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    assert(p.board.width === 100 && p.board.height === 60, 'empty project board 100x60');
    assert(Array.isArray(p.nets) && p.nets.length === 3, 'empty project has 3 default nets');
    assert(p.nets[0].name === 'VCC' && p.nets[1].name === 'GND', 'default net names VCC/GND');
    assert(p.traces.length === 0 && p.components.length === 0 && p.vias.length === 0, 'empty object lists');
    assert(p.boardOutline === null, 'no outline by default');
    assert(p.params.jumperFollow === 'pads' && p.params.routeAngle === 'hv45', 'empty project jumperFollow/routeAngle defaults');
}

// ============================================================
// 2. serialize / deserialize round-trip + migration
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const c1 = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0, rotation: 90 });
    ProjectApi.addTrace(p, { points: [{ x: 0, y: 0 }, { x: 5, y: 3 }], net: 'VCC' });
    ProjectApi.addVia(p, { x: 1, y: 2, diameter: 1.0 });
    ProjectApi.addSilkText(p, { text: 'millPCB', x: -5, y: 10 });

    // Give two nets a supply voltage (a newer field) so the round-trip below
    // proves serialize/deserialize preserve it (feeds the LED resistor calc).
    p.nets[0].voltage = 5;     // integer volts
    p.nets[2].voltage = 0.33;  // fractional volts

    const data = ProjectApi.serialize(p);
    assert(data.version === 2, 'serialize sets version 2');
    assert(data.nets[0].voltage === 5, 'serialize includes net voltage');
    const json = JSON.parse(JSON.stringify(data)); // simulate file round-trip
    const q = ProjectApi.deserialize(json);
    assert(q.nets[0].voltage === 5, 'net voltage (integer) survives round-trip');
    assert(q.nets[2].voltage === 0.33, 'net voltage (fractional) survives round-trip');
    assert(q.components.length === 1 && q.components[0].id === c1.id, 'component survives round-trip');
    assertClose(q.components[0].x, -20, 1e-9, 'round-trip component x');
    assert(q.components[0].rotation === 90, 'round-trip rotation');
    assert(q.traces.length === 1 && q.traces[0].net === 'VCC', 'round-trip trace + net');
    assert(q.vias.length === 1 && q.silkTexts.length === 1, 'round-trip via + silk');
    assert(q.idCounter >= 4, 'idCounter preserved');

    // Backward compat: an empty/old file migrates to defaults.
    const old = ProjectApi.deserialize({ board: { width: 50 } });
    assert(old.board.width === 50 && old.board.height === 60, 'old file keeps given fields, fills defaults');
    assert(old.params.jumperFollow === 'pads' && old.params.routeAngle === 'hv45', 'old file migrates missing jumperFollow/routeAngle');
    const flipped = ProjectApi.deserialize({ params: { jumperFollow: 'joints', routeAngle: 'free', gridSize: 2 } });
    assert(flipped.params.jumperFollow === 'joints' && flipped.params.routeAngle === 'free', 'deserialize keeps flipped mode enums');
    ProjectApi.setParams(flipped, { jumperFollow: 'nope', routeAngle: 'nope' });
    assert(flipped.params.jumperFollow === 'pads' && flipped.params.routeAngle === 'hv45', 'setParams coerces invalid enums');
    let threw = false;
    try { ProjectApi.deserialize(null); } catch (e) { threw = true; }
    assert(threw, 'deserialize(null) throws');
}

// ============================================================
// 3. addComponent: labels, pins, errors
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0 });
    const r2 = ProjectApi.addComponent(p, { type: 'resistor', x: 20, y: 0 });
    assert(r1.label === 'R1' && r2.label === 'R2', 'auto labels R1, R2');
    assert(r1.value === '10k\u2126', 'default value from def');
    assert(Array.isArray(r1.pins) && r1.pins.length === 2, 'pins copied onto component');
    assertClose(r1.pins[0].x, -3.81, 1e-9, 'TH pin 1 local x');
    const cap = ProjectApi.addComponent(p, { type: 'capacitor', label: 'C7' });
    assert(cap.label === 'C7', 'explicit label kept');
    let threw = false;
    try { ProjectApi.addComponent(p, { type: 'does-not-exist' }); } catch (e) { threw = true; }
    assert(threw, 'unknown component type throws');
}

// ============================================================
// 4. pinWorld: unrotated + rotated
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const c = ProjectApi.addComponent(p, { type: 'resistor', x: 10, y: 5 }); // rotation 0
    let w = ProjectApi.pinWorld(p, c.id, '1');
    assertClose(w.x, 6.19, 1e-6, 'pin1 world x (unrotated)');
    assertClose(w.y, 5, 1e-6, 'pin1 world y (unrotated)');

    ProjectApi.updateObject(p, { id: c.id, patch: { rotation: 90 } });
    w = ProjectApi.pinWorld(p, c.id, 0); // by index too
    assertClose(w.x, 10, 1e-6, 'pin1 world x (rot 90)');
    assertClose(w.y, 1.19, 1e-6, 'pin1 world y (rot 90)');

    assert(ProjectApi.pinWorld(p, 9999, '1') === null, 'missing component -> null');
}

// ============================================================
// 5. connectPins: net resolution + conflicts
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0 });
    const r2 = ProjectApi.addComponent(p, { type: 'resistor', x: 20, y: 0 });

    // Neither pin connected -> new NET_n (defaults end at NET_3).
    const t1 = ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: r2.id, pin: '1' }, { style: 'straight' });
    assert(t1.net === 'NET_4', 'new auto net is NET_4');
    const a = ProjectApi.pinWorld(p, r1.id, '2');
    assertClose(t1.points[0].x, a.x, 1e-9, 'trace starts at pin world pos');
    const r4 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 25 });
    const t1o = ProjectApi.connectPins(p, { compId: r1.id, pin: '1' }, { compId: r4.id, pin: '1' });
    assert(t1o.points.length === 3, 'default style is orthogonal (elbow between unaligned pins)');

    // Explicit existing net -> reused, no new net entry.
    const netsBefore = p.nets.length;
    const t2 = ProjectApi.connectPins(p, { compId: r1.id, pin: '1' }, { compId: r2.id, pin: '2' }, { net: 'VCC' });
    assert(t2.net === 'VCC', 'explicit net used');
    assert(p.nets.length === netsBefore, 'existing net not duplicated');

    // One side already on a net -> that net wins.
    const r3 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 20 });
    const t3 = ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: r3.id, pin: '1' });
    assert(t3.net === 'NET_4', 'reuses net of already-connected pin');

    // Conflict: two pins on different nets -> error unless opts.net given.
    const p2 = ProjectApi.createEmptyProject();
    const a1 = ProjectApi.addComponent(p2, { type: 'resistor', x: -20, y: 0 });
    const b1 = ProjectApi.addComponent(p2, { type: 'resistor', x: 20, y: 0 });
    ProjectApi.addTrace(p2, { points: [ProjectApi.pinWorld(p2, a1.id, '2'), { x: -5, y: 8 }], net: 'VCC' });
    ProjectApi.addTrace(p2, { points: [ProjectApi.pinWorld(p2, b1.id, '1'), { x: 5, y: -8 }], net: 'GND' });
    let threw = false;
    try { ProjectApi.connectPins(p2, { compId: a1.id, pin: '2' }, { compId: b1.id, pin: '1' }); }
    catch (e) { threw = /conflict/.test(e.message); }
    assert(threw, 'net conflict throws');

    // Two DIFFERENT pins of one component are legal (trimmer wiper tie): a
    // 3-point orthogonal hook. Connecting a pin to itself still throws.
    let sameCompThrew = false, wiper = null;
    try { ProjectApi.connectPins(p2, { compId: a1.id, pin: '1' }, { compId: a1.id, pin: '1' }); }
    catch (e) { sameCompThrew = true; }
    assert(sameCompThrew, 'same-pin connect throws');
    wiper = ProjectApi.connectPins(p2, { compId: a1.id, pin: '1' }, { compId: a1.id, pin: '2' }, { net: 'WIPER', style: 'ortho' });
    assert(wiper.points.length === 3, 'wiper tie is a 3-point orthogonal trace');
    assert(wiper.schemEnds && wiper.schemEnds[0].compId === a1.id && wiper.schemEnds[1].compId === a1.id, 'wiper tie carries schemEnds');
}

// A second pin on a net that already has copper joins that copper.
// It must not draw another trace along the run that is already there.
{
    const p = ProjectApi.createEmptyProject({ width: 80, height: 60 });
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0 });
    const r2 = ProjectApi.addComponent(p, { type: 'resistor', x: 20, y: 0 });
    const r3 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 18 });
    const t1 = ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: r2.id, pin: '1' }, { net: 'GND', style: 'straight' });
    const before = p.traces.length;
    const stub = ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: r3.id, pin: '1' }, { net: 'GND' });
    assert(stub && stub.net === 'GND', 'second pin reuses GND');
    assert(p.traces.length === before + 1, 'join adds one stub, not a copy of the run');
    const stubLen = ProjectApi._polyLen(stub.points);
    assert(stubLen > 10 && stubLen < 22, 'stub is the drop onto the existing trace (got ' + stubLen.toFixed(2) + ')');
    const segs = [{ a: t1.points[0], b: t1.points[t1.points.length - 1] }];
    const kept = ProjectApi.uncoveredPieces(stub.points, segs, 0.05);
    let keptLen = 0;
    for (const q of kept) keptLen += ProjectApi._polyLen(q);
    assert(stubLen - keptLen < 0.2, 'stub does not run along the existing GND trace');
    const n = p.traces.length;
    ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: r2.id, pin: '1' }, { net: 'GND' });
    assert(p.traces.length === n, 'pins already on the trace add no second trace');
}

// ============================================================
// 6. runDrc: clean pass + real violations
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    let res = ProjectApi.runDrc(p);
    assert(res.ok && res.violations.length === 0, 'empty project passes DRC');

    ProjectApi.addTrace(p, { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], width: 0.2 }); // < 0.38
    res = ProjectApi.runDrc(p);
    assert(res.violations.some(v => v.type === 'trace-width'), 'thin trace flagged');

    // Clearance: parallel traces, different nets, gap = -0.1mm
    const p2 = ProjectApi.createEmptyProject();
    ProjectApi.addTrace(p2, { points: [{ x: 0, y: -5 }, { x: 20, y: -5 }], net: 'VCC', width: 0.5 });
    ProjectApi.addTrace(p2, { points: [{ x: 0, y: -4.6 }, { x: 20, y: -4.6 }], net: 'GND', width: 0.5 });
    res = ProjectApi.runDrc(p2);
    assert(res.violations.some(v => v.type === 'clearance'), 'close traces flagged');

    // Drill size: tiny via
    const p3 = ProjectApi.createEmptyProject();
    ProjectApi.addVia(p3, { x: 0, y: 0, diameter: 0.1 }); // drill defaults to 0.05 < 0.1
    res = ProjectApi.runDrc(p3);
    assert(res.violations.some(v => v.type === 'drill-size'), 'tiny via flagged');

    // Logical schematic wire with no copper
    const p4 = ProjectApi.createEmptyProject();
    const rA = ProjectApi.addComponent(p4, { type: 'resistor', x: -10, y: 0 });
    const rB = ProjectApi.addComponent(p4, { type: 'resistor', x: 10, y: 0 });
    const pa = ProjectApi.pinWorld(p4, rA.id, '2');
    const pb = ProjectApi.pinWorld(p4, rB.id, '1');
    p4.traces.push({
        id: ProjectApi.nextId(p4),
        points: [pa, pb],
        width: 0.5,
        layer: 'top',
        net: 'SIG1',
        schemWire: true,
        schemEnds: [{ compId: rA.id, pinIndex: 1 }, { compId: rB.id, pinIndex: 0 }]
    });
    res = ProjectApi.runDrc(p4);
    assert(res.violations.some(v => v.type === 'unrouted' && v.severity === 'warning'), 'schematic-only wire flagged unrouted');
    p4.traces.push({
        id: ProjectApi.nextId(p4),
        points: [pa, pb],
        width: 0.5,
        layer: 'top',
        net: 'SIG1'
    });
    res = ProjectApi.runDrc(p4);
    assert(!res.violations.some(v => v.type === 'unrouted'), 'matching copper clears the unrouted warning');

    // Duplicate identity (CAP-8): duplicate component id + duplicate label.
    const p5 = ProjectApi.createEmptyProject();
    const d1 = ProjectApi.addComponent(p5, { type: 'resistor', x: -10, y: 0, label: 'R1' });
    const d2 = ProjectApi.addComponent(p5, { type: 'resistor', x: 10, y: 0, label: 'R1' });
    d2.id = d1.id; // force an id collision
    const res5 = ProjectApi.runDrc(p5);
    assert(res5.violations.some(v => v.type === 'duplicate-id' && v.severity === 'error'), 'DRC flags duplicate component id');
    assert(res5.violations.some(v => v.type === 'duplicate-label' && v.severity === 'error'), 'DRC flags duplicate reference label');
    const p6 = ProjectApi.createEmptyProject();
    ProjectApi.addComponent(p6, { type: 'resistor', x: -10, y: 0, label: 'R1' });
    ProjectApi.addComponent(p6, { type: 'resistor', x: 10, y: 0, label: 'R2' });
    const res6 = ProjectApi.runDrc(p6);
    assert(!res6.violations.some(v => v.type === 'duplicate-id' || v.type === 'duplicate-label'), 'unique ids/labels pass the identity check');
}

// ============================================================
// 7. Export integration (SVG / DXF / G-code via the adapter)
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0 });
    const r2 = ProjectApi.addComponent(p, { type: 'resistor', x: 20, y: 0 });
    ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: r2.id, pin: '1' });

    const svg = ProjectApi.exportSvg(p);
    assert(typeof svg === 'string' && svg.includes('<svg'), 'exportSvg returns SVG markup');
    assert(svg.includes('R1'), 'SVG contains component label');

    const dxf = ProjectApi.exportDxf(p);
    assert(typeof dxf === 'string' && /SECTION/.test(dxf), 'exportDxf returns DXF');

    const gcode = ProjectApi.exportGcode(p);
    assert(typeof gcode === 'string' && /G21/.test(gcode) && /G0 X/.test(gcode), 'exportGcode returns G-code');
}

// ============================================================
// 8. Component silk labels: legacy migration + SVG export parity
// ============================================================
{
    // Legacy file where silkLabel is a plain string and silkValue is missing.
    const p = ProjectApi.createEmptyProject();
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    r1.silkLabel = 'R1'; // legacy string form
    delete r1.silkValue;
    r1.rotation = 90;
    const m = ProjectApi.deserialize(JSON.parse(JSON.stringify(p)));
    const mc = m.components[0];
    assert(typeof mc.silkLabel === 'object' && mc.silkLabel !== null, 'legacy string silkLabel migrates to object');
    assert(Number.isFinite(mc.silkLabel.x) && Number.isFinite(mc.silkLabel.y), 'migrated silkLabel has numeric coords');
    assert(typeof mc.silkValue === 'object' && Number.isFinite(mc.silkValue.x) && Number.isFinite(mc.silkValue.y), 'missing silkValue migrates to default below body');

    // Per-field rotation offset + explicit font size reach the SVG export.
    mc.silkLabel.rotation = 45;
    mc.silkLabel.fontSize = 3;
    const svg = ProjectApi.exportSvg(m);
    assert(!/NaN/.test(svg), 'no NaN anywhere in exported SVG');
    const labelEl = (svg.match(/<text[^>]*>R1<\/text>/) || [''])[0];
    assert(labelEl !== '', 'rotated label present in SVG');
    assert(labelEl.includes('transform="rotate(135 '), 'label rotation is part rotation + offset (90+45=135)');
    assert(labelEl.includes('font-size:3.00mm'), 'explicit font size exported inline');
    const valueEl = (svg.match(/<text[^>]*>10k\u2126<\/text>/) || [''])[0];
    assert(valueEl !== '', 'value text present in SVG');
    assert(valueEl.includes('transform="rotate(90 '), 'value inherits part rotation with zero per-field offset');

    // Auto sizing: no override -> inline auto font size, no transform at rotation 0.
    const mAuto = ProjectApi.createEmptyProject();
    ProjectApi.addComponent(mAuto, { type: 'resistor', x: 0, y: 0 });
    const svg2 = ProjectApi.exportSvg(mAuto);
    const autoEl = (svg2.match(/<text[^>]*>R1<\/text>/) || [''])[0];
    assert(/style="font-size:\d+\.\d{2}mm"/.test(autoEl), 'auto font size exported inline');
    assert(!autoEl.includes('transform='), 'no transform when total rotation is 0');

    // Small SMD: auto font stays under 1.2mm so "R1" does not swallow the body.
    const pGap = ProjectApi.createEmptyProject();
    const cGap = ProjectApi.addComponent(pGap, { type: 'resistor', x: 0, y: 0, sizeName: '0805' });
    const sz0805 = ProjectApi.getCompSize(cGap);
    const fs0805 = ProjectApi.compSilkFontSize(sz0805);
    assert(fs0805 <= 1.0, '0805 auto silk font is small enough to sit beside the body');
    const hh0805 = sz0805.height / 2;
    assert(Math.abs(cGap.silkLabel.y) > hh0805 + fs0805 * 0.5, 'designator baseline clears 0805 body');
}

// ============================================================
// 9. JP wire jumper: pads stay vs follow joints (no polyline slide)
// ============================================================
{
    const mk = (follow) => Object.assign({
        traces: [], components: [], vias: [],
        params: { jumperFollow: follow || 'pads', routeAngle: 'hv45', gridSize: 1 }
    }, ctx.App);

    function holes(jp) {
        const r = (jp.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        return jp.pins.map(p => ({ x: jp.x + p.x * c - p.y * s, y: jp.y + p.x * s + p.y * c }));
    }

    // Mid-segment pins: dragging the jumper body still splits copper (rigid body drag).
    {
        const k = mk();
        const tr = { id: 1, points: [{ x: 20, y: 65 }, { x: 80, y: 65 }], width: 0.6, layer: 'top' };
        const jp = { id: 2, type: 'jumper', size: 2, x: 55, y: 65, rotation: 0, pins: [{ x: -10, y: 0 }, { x: 10, y: 0 }], layer: 'top' };
        k.traces.push(tr); k.components.push(jp);
        jp.y = 69;
        k.moveCompWithTraces(jp, 55, 65);
        assert(tr.points.length === 4, 'mid-segment JP pins split trace into 4 points');
        assert(Math.hypot(tr.points[1].x - 45, tr.points[1].y - 69) < 0.01, 'split vertex follows pin 1');
        assert(Math.hypot(tr.points[2].x - 65, tr.points[2].y - 69) < 0.01, 'split vertex follows pin 2');
    }

    // Wire jumper always follows a glued vertex (pads mode does not pin the hairline).
    {
        const k = mk('pads');
        const trA = { id: 1, points: [{ x: 30, y: 50 }, { x: 10, y: 50 }], width: 0.6, layer: 'top' };
        const trB = { id: 2, points: [{ x: 50, y: 50 }, { x: 70, y: 50 }], width: 0.6, layer: 'top' };
        const jp = { id: 3, type: 'jumper', size: 2, x: 40, y: 50, rotation: 0, span: 20, pins: [{ x: -10, y: 0 }, { x: 10, y: 0 }], layer: 'top' };
        k.traces.push(trA, trB); k.components.push(jp);
        k.view = { zoom: 1 };
        for (let i = 0; i < 6; i++) { trA.points[0].y += 1; k.anchorJumperPinsToTrace(trA); }
        const h = holes(jp);
        assert(Math.hypot(h[0].x - 30, h[0].y - 56) < 0.05, 'wire JP follows moved vertex even if jumperFollow=pads');
        assert(Math.hypot(h[1].x - 50, h[1].y - 50) < 0.05, 'other hole stays');
    }

    // Follow joints: move only pin-1's vertex — that hole follows, pin 2 stays, pose rebuilds, no slide on trB.
    {
        const k = mk('joints');
        const trA = { id: 1, points: [{ x: 30, y: 50 }, { x: 10, y: 50 }], width: 0.6, layer: 'top' };
        const trB = { id: 2, points: [{ x: 50, y: 50 }, { x: 70, y: 50 }], width: 0.6, layer: 'top' };
        const jp = { id: 3, type: 'jumper', size: 2, x: 40, y: 50, rotation: 0, span: 20, pins: [{ x: -10, y: 0 }, { x: 10, y: 0 }], layer: 'top' };
        k.traces.push(trA, trB); k.components.push(jp);
        for (let i = 0; i < 6; i++) { trA.points[0].y += 1; k.anchorJumperPinsToTrace(trA); }
        const h = holes(jp);
        assert(Math.hypot(h[0].x - 30, h[0].y - 56) < 0.05, 'joints: pin 1 follows moved vertex');
        assert(Math.hypot(h[1].x - 50, h[1].y - 50) < 0.05, 'joints: pin 2 stays');
        assert(Math.abs(jp.span - Math.hypot(20, 6)) < 0.05, 'joints: span matches hole distance');
        assert(Math.hypot(trB.points[0].x - 50, trB.points[0].y - 50) < 0.01, 'joints: no slide of far-end copper');
        assert(Math.hypot(trB.points[1].x - 70, trB.points[1].y - 50) < 0.01, 'unrelated far vertex untouched');
    }

    // Mid-segment hole: promote to vertex, then joints follow that vertex only.
    {
        const k = mk('joints');
        const tr = { id: 1, points: [{ x: 20, y: 65 }, { x: 80, y: 65 }], width: 0.6, layer: 'top' };
        const jp = { id: 2, type: 'jumper', size: 2, x: 55, y: 65, rotation: 0, span: 20, pins: [{ x: -10, y: 0 }, { x: 10, y: 0 }], layer: 'top' };
        k.traces.push(tr); k.components.push(jp);
        k.ensureWireJumperJoints();
        assert(tr.points.length >= 4, 'mid-segment holes promoted to vertices');
        const v1 = tr.points.find(p => Math.hypot(p.x - 45, p.y - 65) < 0.2);
        assert(!!v1, 'promoted vertex at pin 1');
        for (let i = 0; i < 4; i++) { v1.y += 1; k.anchorJumperPinsToTrace(tr); }
        const h = holes(jp);
        assert(Math.hypot(h[0].x - v1.x, h[0].y - v1.y) < 0.05, 'joints: mid-segment hole follows its vertex');
        assert(Math.hypot(h[1].x - 65, h[1].y - 65) < 0.05, 'joints: other hole stays');
    }

    // Hairline hit, not footprint box; stretch one hole like a trace vertex.
    {
        const k = mk();
        k.view = { zoom: 1 };
        const jp = { id: 8, type: 'jumper', size: 2, x: 40, y: 50, rotation: 0, span: 20, pins: [{ x: -10, y: 0 }, { x: 10, y: 0 }], layer: 'top' };
        k.components.push(jp);
        k.traces.push({ id: 3, points: [{ x: 30, y: 50 }, { x: 10, y: 50 }], width: 0.6, layer: 'top' });
        const miss = k.hitWireJumper(40, 40);
        assert(!miss, 'offset from hairline is not a hit');
        const onLine = k.hitWireJumper(40, 50);
        assert(onLine && onLine.part === 'seg', 'mid hairline is a segment hit');
        const onHole = k.hitWireJumper(30, 50);
        assert(onHole && onHole.part === 'hole' && onHole.holeIndex === 0, 'solder hole is a vertex hit');
        k.moveWireJumperHole(jp, 0, 30, 60);
        const hs = holes(jp);
        assert(Math.hypot(hs[0].x - 30, hs[0].y - 60) < 0.05, 'dragged hole moves');
        assert(Math.hypot(hs[1].x - 50, hs[1].y - 50) < 0.05, 'other hole stays when stretching');
        assert(Math.abs(jp.span - Math.hypot(20, 10)) < 0.05, 'span rebuilds like a wire');
        assert(Math.hypot(k.traces[0].points[0].x - 30, k.traces[0].points[0].y - 60) < 0.05, 'copper on that hole follows');
    }

    // Promote mid-edge holes, then drag a copper segment — wire stays glued to its vertices.
    {
        const k = mk('pads');
        k.getCompSize = function (comp) {
            return { jkind: 'wire', pins: comp.pins || [], width: 2, height: 2, name: 'Wire' };
        };
        k.snapToGrid = function (v) { return v; };
        k.vias = [];
        ctx.BoardView = { isTH: function () { return true; } };
        const tr = { id: 1, points: [{ x: 20, y: 65 }, { x: 80, y: 65 }], width: 0.6, layer: 'top' };
        const jp = { id: 2, type: 'jumper', size: 2, x: 55, y: 65, rotation: 0, span: 20, pins: [{ x: -10, y: 0, name: '1' }, { x: 10, y: 0, name: '2' }], layer: 'top' };
        k.traces.push(tr); k.components.push(jp);
        const si = k.prepareSegmentDrag(tr, 0);
        assert(tr.points.length >= 4, 'prepareSegmentDrag promotes mid-edge holes to vertices');
        const h0 = holes(jp);
        assert(h0.every(h => tr.points.some(p => Math.hypot(p.x - h.x, p.y - h.y) < 0.15)), 'holes sit on vertices after promote');
        const a = tr.points[si], b = tr.points[si + 1];
        const o0 = { x: a.x, y: a.y }, o1 = { x: b.x, y: b.y };
        k.applySegmentDrag(tr, si, 'h', o0, o1, 0, 4);
        k.glueWireJumpersAt(o0, tr.points[si]);
        k.glueWireJumpersAt(o1, tr.points[si + 1]);
        const h1 = holes(jp);
        assert(h1.every(h => tr.points.some(p => Math.hypot(p.x - h.x, p.y - h.y) < 0.2)), 'wire JP stays glued to copper vertices after segment drag');
    }

    // T-join from a JP hole is a normal copper vertex (not a pad); dragging it stretches the wire.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.getCompSize = function (comp) {
            return { jkind: 'wire', pins: comp.pins || [], width: 2, height: 2, name: 'Wire' };
        };
        const tr = { id: 1, points: [{ x: 20, y: 65 }, { x: 80, y: 65 }], width: 0.6, layer: 'top' };
        const jp = { id: 2, type: 'jumper', size: 2, x: 55, y: 65, rotation: 0, span: 20, pins: [{ x: -10, y: 0, name: '1' }, { x: 10, y: 0, name: '2' }], layer: 'top' };
        k.traces.push(tr); k.components.push(jp);
        k.ensureWireJumperJoints();
        assert(tr.points.length >= 4, 'place/ensure turns JP holes into trace joints');
        const hit = k.hitTraceVertex(45, 65);
        assert(hit && hit.traceId === 1, 'JP T-join is hittable as a trace vertex');
        const pad = k.getPadConstraint(tr, hit.pointIndex);
        assert(!pad, 'wire JP joint is not a component pad');
        const prev = { x: tr.points[hit.pointIndex].x, y: tr.points[hit.pointIndex].y };
        tr.points[hit.pointIndex].y = 72;
        k.glueWireJumpersAt(prev, tr.points[hit.pointIndex]);
        const h = holes(jp);
        assert(Math.hypot(h[0].x - 45, h[0].y - 72) < 0.05, 'dragging that joint moves the JP hole');
        assert(Math.hypot(h[1].x - 65, h[1].y - 65) < 0.05, 'other JP hole stays');
    }
}

// ============================================================
// 10. Magnetic alignment (alignPosToComps) — edges/centres, threshold, rotation
// ============================================================
{
    const mk = () => Object.assign({ traces: [], components: [], vias: [] }, ctx.App);
    const resPins = [{ x: -5, y: 0 }, { x: 5, y: 0 }]; // 10 mm span

    // Edge snap: mover left edge (offset -5) snaps to target right edge at x=5 -> centre 10.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.components.push({ id: 1, type: 'resistor', x: 0, y: 0, rotation: 0, pins: resPins });
        const r = k.alignPosToComps(9.6, 3, { pins: resPins, rotation: 0 }, null);
        assert(r.x === 10 && Math.abs(r.lineX - 5) < 1e-9, 'edge-to-edge snap (centre 10, guide line at 5)');
        assert(r.y === null && r.lineY === null, 'y axis not aligned (no target y line within threshold)');
    }

    // Centre-to-centre on a rotated target; second axis snaps independently.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.components.push({ id: 2, type: 'capacitor', x: 20, y: 10, rotation: 90, pins: [{ x: 0, y: -3.25 }, { x: 0, y: 3.25 }] });
        const r = k.alignPosToComps(19.6, 9.4, { pins: resPins, rotation: 0 }, null);
        assert(Math.abs(r.x - 20) < 1e-9 && Math.abs(r.lineX - 20) < 1e-9, 'centre-to-centre snap on rotated target');
        assert(Math.abs(r.y - 10) < 1e-9 && Math.abs(r.lineY - 10) < 1e-9, 'y centre snap to rotated target');
    }

    // Threshold at zoom 1 is 2 mm: 2.5 mm away does not snap.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.components.push({ id: 3, type: 'resistor', x: 0, y: 0, rotation: 0, pins: resPins });
        const r = k.alignPosToComps(12.5, 3, { pins: resPins, rotation: 0 }, null);
        assert(r.x === null, 'no snap beyond 2 mm threshold');
    }

    // Threshold scales with zoom: at zoom 4 it is 4 px = 1 mm.
    {
        const k = mk();
        k.view = { zoom: 4 };
        k.components.push({ id: 4, type: 'resistor', x: 0, y: 0, rotation: 0, pins: resPins });
        assert(k.alignPosToComps(11.2, 3, { pins: resPins, rotation: 0 }, null).x === null, 'zoom 4: 1.2 mm away does not snap (1 mm threshold)');
        assert(k.alignPosToComps(10.8, 3, { pins: resPins, rotation: 0 }, null).x === 10, 'zoom 4: 0.8 mm away snaps');
    }

    // Non-90-degree mover has no stable edges -> never aligns.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.components.push({ id: 5, type: 'resistor', x: 0, y: 0, rotation: 0, pins: resPins });
        const r = k.alignPosToComps(9.9, 0, { pins: resPins, rotation: 45 }, null);
        assert(r.x === null && r.y === null, 'mover at 45 deg does not align');
    }

    // exceptId ignores the dragged component itself.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.components.push({ id: 6, type: 'resistor', x: 0, y: 0, rotation: 0, pins: resPins });
        const r = k.alignPosToComps(0.4, 3, { pins: resPins, rotation: 0 }, 6);
        assert(r.x === null && r.y === null, 'exceptId excludes the dragged component');
    }

    // Single-pin part (test point): centre-only alignment on both axes.
    {
        const k = mk();
        k.view = { zoom: 1 };
        k.components.push({ id: 7, type: 'gnd', x: 30, y: 20, rotation: 0, pins: [{ x: 0, y: 0 }] });
        const r = k.alignPosToComps(29.6, 19.5, { pins: resPins, rotation: 0 }, null);
        assert(Math.abs(r.x - 30) < 1e-9 && Math.abs(r.lineX - 30) < 1e-9, 'test point centre aligns mover on x');
        assert(Math.abs(r.y - 20) < 1e-9 && Math.abs(r.lineY - 20) < 1e-9, 'test point centre aligns mover on y');
    }
}

// ============================================================
// resistorBridges — robust anode↔supply series-resistor detection
// ============================================================
{
    // A 2-pin part centred at (x,0); pins at world (x-2) and (x+2).
    // aNet/bNet attach a 1- or 2-point trace whose endpoint sits on that pin.
    const part = (id, x, aNet, bNet, ext) => {
        const p = ProjectApi.createEmptyProject();
        p.components.push({ id, type: 'resistor', x, y: 0, rotation: 0, pins: [{ x: -2, y: 0 }, { x: 2, y: 0 }] });
        const tr = [];
        if (aNet) tr.push({ id: 100 + id * 2, points: [{ x: x - 2, y: 0 }, { x: x - 2 - (ext ? 10 : 4), y: 0 }], net: aNet, width: 0.5, layer: 'top' });
        if (bNet) tr.push({ id: 101 + id * 2, points: [{ x: x + 2, y: 0 }, { x: x + 2 + (ext ? 10 : 4), y: 0 }], net: bNet, width: 0.5, layer: 'top' });
        p.traces = tr;
        return p;
    };
    const by = (p, id) => p.components.find(c => c.id === id);

    // (1) Copper stubs: pin0 -> anode net A, pin1 -> supply V. Order-independent.
    {
        const p = part(1, 10, 'A', 'V', true);
        assert(ProjectApi.resistorBridges(p, by(p, 1), 'A', 'V') === true, 'copper: bridges anode↔VCC (A,V)');
        assert(ProjectApi.resistorBridges(p, by(p, 1), 'V', 'A') === true, 'copper: order-independent (V,A)');
        assert(ProjectApi.resistorBridges(p, by(p, 1), 'A', 'X') === false, 'copper: unrelated net is not a bridge');
    }

    // (2) Logical pin-to-pin wires — the case the old getPinNet check missed.
    {
        const p = part(2, 10, 'W', 'V', false);
        assert(ProjectApi.resistorBridges(p, by(p, 2), 'W', 'V') === true, 'logical wire: bridges anode↔VCC');
        assert(ProjectApi.resistorBridges(p, by(p, 2), 'V', 'W') === true, 'logical wire: order-independent');
    }

    // (3) Both pins on the same net is a bridge of that net (not a short across it).
    {
        const p = part(3, 10, 'X', 'X', true);
        assert(ProjectApi.resistorBridges(p, by(p, 3), 'X', 'X') === true, 'same-net: both pins on X');
        assert(ProjectApi.resistorBridges(p, by(p, 3), 'A', 'V') === false, 'same-net: not an A↔V bridge');
    }

    // (4) A pin touching two nets resolves each (set-of-nets, not first match).
    {
        const p = ProjectApi.createEmptyProject();
        p.components.push({ id: 4, type: 'resistor', x: 10, y: 0, rotation: 0, pins: [{ x: -2, y: 0 }, { x: 2, y: 0 }] });
        p.traces = [
            { id: 1, points: [{ x: 8, y: 0 }, { x: 0, y: 0 }], net: 'A', width: 0.5, layer: 'top' },
            { id: 2, points: [{ x: 8, y: 0 }, { x: 2, y: 2 }], net: 'B', width: 0.5, layer: 'top' },
            { id: 3, points: [{ x: 12, y: 0 }, { x: 30, y: 0 }], net: 'V', width: 0.5, layer: 'top' }
        ];
        const c = p.components[0];
        assert(ProjectApi.resistorBridges(p, c, 'A', 'V') === true, 'multi-net pin: A↔V detected');
        assert(ProjectApi.resistorBridges(p, c, 'B', 'V') === true, 'multi-net pin: B↔V also detected');
    }

    // (5) A part that is not 2-pinned can never be a bridge.
    {
        const p = ProjectApi.createEmptyProject();
        p.components.push({ id: 5, type: 'gnd', x: 0, y: 0, rotation: 0, pins: [{ x: 0, y: 0 }] });
        assert(ProjectApi.resistorBridges(p, p.components[0], 'A', 'V') === false, 'single-pin part is not a bridge');
    }
}

// ============================================================
// LED series-resistor reuse — full LED + VCC + resistor-on-anode layout
// (the reported bug: a resistor already on the anode side was missed, so a
// duplicate resistor + copper stub got placed. These tests lock the
// detection the calculator uses: findLedVcc / resistorBridges).
// World positions (rotation 0): LED@(10,10) -> anode A=(9.2,10), cathode
// K=(10.8,10). VCC symbol@(20,10) -> pad=(20,10). Resistor body@(16,10) ->
// pin0=(14,10) [anode side], pin1=(18,10) [supply side].
// ============================================================
{
    const ledPins = [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }];
    const ledComp = (id) => ({ id, type: 'led', x: 10, y: 10, rotation: 0, pins: ledPins });
    const vccComp = (id) => ({ id, type: 'power', x: 20, y: 10, rotation: 0, pins: [{ x: 0, y: 0, name: 'VCC' }] });
    const resComp = (id) => ({ id, type: 'resistor', x: 16, y: 10, rotation: 0, pins: [{ x: -2, y: 0 }, { x: 2, y: 0 }] });

    // (a) Existing series resistor on the anode side — copper stubs (anode↔R,
    // VCC↔R). The anode pin (9.2,10) is an endpoint of the A-net trace AND
    // 4.8mm from the resistor pin (14,10) — exactly the layout the old
    // first-match getPinNet check resolved wrong. Detection MUST find the
    // resistor so the calculator reuses it instead of placing a duplicate.
    {
        const p = ProjectApi.createEmptyProject();
        p.components.push(ledComp(1), vccComp(2), resComp(3));
        p.traces = [
            { id: 1, points: [{ x: 9.2, y: 10 }, { x: 14, y: 10 }], net: 'A', width: 0.5, layer: 'top' },   // LED-A -> R pin1
            { id: 2, points: [{ x: 20, y: 10 }, { x: 18, y: 10 }], net: 'VCC', width: 0.5, layer: 'top' }, // VCC -> R pin2
            { id: 3, points: [{ x: 10.8, y: 10 }, { x: 10.8, y: 14 }], net: 'GND', width: 0.5, layer: 'top' }
        ];
        const res = p.components.find(c => c.id === 3);
        const found = ProjectApi.resistorBridges(p, res, 'A', 'VCC');
        assert(found === true, 'reuse: copper-stub series resistor on anode detected');
        assert(ProjectApi.getPinNet(p, 1, 'A') === 'A', 'reuse: LED anode resolves to A net');
        assert(ProjectApi.getPinNet(p, 3, 0) === 'A', 'reuse: resistor pin1 on anode net');
        assert(ProjectApi.getPinNet(p, 3, 1) === 'VCC', 'reuse: resistor pin2 on VCC net');
    }

    // (b) Same wiring as logical pin-to-pin wires (connectPins output): zero stub.
    {
        const p = ProjectApi.createEmptyProject();
        p.components.push(ledComp(11), vccComp(12), resComp(13));
        p.traces = [
            { id: 11, points: [{ x: 9.2, y: 10 }, { x: 14, y: 10 }], net: 'A', width: 0.5, layer: 'top' },
            { id: 12, points: [{ x: 20, y: 10 }, { x: 18, y: 10 }], net: 'VCC', width: 0.5, layer: 'top' },
            { id: 13, points: [{ x: 10.8, y: 10 }, { x: 10.8, y: 14 }], net: 'GND', width: 0.5, layer: 'top' }
        ];
        const res = p.components.find(c => c.id === 13);
        assert(ProjectApi.resistorBridges(p, res, 'VCC', 'A') === true, 'reuse: logical wires (reversed order) detected');
    }

    // (c) Anode wired DIRECTLY to the supply: no series path exists, so no
    // resistor can be "on the anode side" — the calculator must refuse to place
    // a parallel part/stub (regression guard for the duplicate placement).
    {
        const p = ProjectApi.createEmptyProject();
        p.components.push(ledComp(21), vccComp(22), resComp(23));
        p.traces = [
            { id: 21, points: [{ x: 9.2, y: 10 }, { x: 20, y: 10 }], net: 'VCC', width: 0.5, layer: 'top' }, // LED-A directly to VCC
            { id: 22, points: [{ x: 10.8, y: 10 }, { x: 10.8, y: 14 }], net: 'GND', width: 0.5, layer: 'top' },
            { id: 23, points: [{ x: 14, y: 10 }, { x: 14, y: 2 }], net: 'A', width: 0.5, layer: 'top' } // leftover stub off the shared vertex
        ];
        assert(ProjectApi.getPinNet(p, 21, 'A') === 'VCC', 'direct: anode resolves to VCC');
        const res = p.components.find(c => c.id === 23);
        assert(ProjectApi.resistorBridges(p, res, 'VCC', 'VCC') === false, 'direct: no anode net -> no series path, nothing to reuse');
    }
}

// ============================================================
// Design-workflow plan data model (CAP-1/2, Story 1)
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    assert(p.requirements === null, 'plan: requirements null by default');
    assert(Array.isArray(p.zones) && p.zones.length === 0, 'plan: zones empty by default');
    assert(p.assignments && typeof p.assignments === 'object' && Object.keys(p.assignments).length === 0, 'plan: assignments empty by default');
    assert(p.flowDirection === 'lr', 'plan: flowDirection lr by default');

    // setPlan writes only provided keys and coerces enums.
    ProjectApi.setPlan(p, {
        requirements: { boardWidth: 100, boardHeight: 60, nets: ['GND', 'V12'] },
        zones: [{ id: 1, name: 'power', x: -50, y: -30, w: 100, h: 20 }, { id: 2, name: 'gnd', x: -50, y: 10, w: 100, h: 20 }],
        assignments: { 1: 1, 2: 2 },
        flowDirection: 'tb'
    });
    assert(p.requirements.boardWidth === 100, 'setPlan stores requirements');
    assert(p.zones.length === 2 && p.zones[0].name === 'power', 'setPlan stores zones');
    assert(p.assignments['1'] === 1, 'setPlan stores assignments');
    assert(p.flowDirection === 'tb', 'setPlan stores flowDirection');

    // Invalid flowDirection is coerced (left unchanged).
    ProjectApi.setPlan(p, { flowDirection: 'nope' });
    assert(p.flowDirection === 'tb', 'setPlan coerces invalid flowDirection');

    // requirements null clears the contract.
    ProjectApi.setPlan(p, { requirements: null });
    assert(p.requirements === null, 'setPlan clears requirements with null');

    // Round-trip preserves the plan.
    const data = ProjectApi.serialize(p);
    const q = ProjectApi.deserialize(JSON.parse(JSON.stringify(data)));
    assert(q.zones.length === 2 && q.zones[1].name === 'gnd', 'plan zones survive round-trip');
    assert(q.assignments['2'] === 2, 'plan assignments survive round-trip');
    assert(q.flowDirection === 'tb', 'plan flowDirection survives round-trip');

    // Backward compat: an old file with no plan fields migrates to defaults.
    const old = ProjectApi.deserialize({ board: { width: 50 }, components: [] });
    assert(old.requirements === null && old.zones.length === 0 && old.flowDirection === 'lr', 'old file migrates plan fields to defaults');

    // Imported footprint defs ride along with the project so a reloaded preview can draw them.
    p.importedDefs = [{ key: 'kx_demo', kicadImported: true, sizes: [{ width: 1, height: 1, pins: [], kicad: { pads: [] } }] }];
    const withDefs = ProjectApi.deserialize(JSON.parse(JSON.stringify(ProjectApi.serialize(p))));
    assert(withDefs.importedDefs && withDefs.importedDefs[0].key === 'kx_demo', 'importedDefs survive a project round-trip');
}

// ============================================================
// ============================================================
// Imported footprint label shortening (palette/library display)
// ============================================================
{
    const KicadImport = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/kicad-import.js'), 'utf8') + '; KicadImport', { console, ComponentDefs: ctx.ComponentDefs }, { filename: 'js/kicad-import.js' });
    const f = KicadImport._shortLabel.bind(KicadImport);
    assert(f('Capacitor_THT_CP_D5.0mm_P2.50mm') === 'THT CP D5.0 P2.50', 'shortLabel capacitor: ' + f('Capacitor_THT_CP_D5.0mm_P2.50mm'));
    assert(f('Capacitor_THT:CP_Radial_D5.0mm_P2.50mm') === 'CP Radial D5.0 P2.50', 'shortLabel capacitor namespace: ' + f('Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'));
    assert(f('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm') === 'SOIC-8 3.9x4.9 P1.27', 'shortLabel SOIC');
    assert(f('PinHeader_2x04_P2.54mm_Vertical') === 'PinHeader 2x04 P2.54', 'shortLabel pinheader');
    assert(f('Package_TO_SOT_THT:TO-220-3_Vertical') === 'TO-220-3', 'shortLabel TO-220');
    assert(f('LED_D3.0mm') === 'LED D3.0', 'shortLabel LED');
    assert(f('') === '', 'shortLabel empty stays empty');
}

// ============================================================
// 3D model: every through-hole size must have leads crossing the board
// ============================================================
{
    const ComponentDefs = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/component-defs.js'), 'utf8') + '; ComponentDefs', { console });
    const KicadImport = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/kicad-import.js'), 'utf8') + '; KicadImport', { console, ComponentDefs });
    const Embed = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/kicad-lib-embed.js'), 'utf8') + '; KicadLibEmbed', { console, ComponentDefs, KicadImport });
    const LibsLoader = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/libs-loader.js'), 'utf8') + '; LibsLoader', { console, ComponentDefs, KicadImport, KicadLibEmbed: Embed });
    LibsLoader.applyEmbed();
    const M = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/model3d.js'), 'utf8') + '; ({ _buildParts, _famOf })', { console, ComponentDefs, KicadImport });
    const THT = { ledth: 1, to92: 1, to220: 1, hdr: 1, axial: 1, diode: 1, polar: 1, box: 1, disc: 1, crystal: 1 };
    let checked = 0, missing = 0;
    for (const key of Object.keys(ComponentDefs.defs)) {
        const def = ComponentDefs.defs[key];
        if (!def || !def.sizes) continue;
        def.sizes.forEach(size => {
            const fam = M._famOf(size, key, def);
            if (!THT[fam]) return;
            const parts = M._buildParts(size, key, def);
            if (!parts.some(p => p.m === 'hole')) return; // SMD guard reclassified it
            checked++;
            if (!parts.some(p => p.m === 'tin' && p.t === 'c' && (p.y - p.h / 2) <= -0.75)) { missing++; }
        });
    }
    assert(checked > 40, '3D lead check covers THT sizes (' + checked + ')');
    assert(missing === 0, '3D THT sizes all have leads through the board (' + missing + ' missing)');

    const pad2 = (span) => [
        { x: -span / 2, y: 0, w: 1.6, h: 1.6, drill: 0.8 },
        { x: span / 2, y: 0, w: 1.6, h: 1.6, drill: 0.8 }
    ];
    const build = (name, extra) => M._buildParts(Object.assign({ name: name, width: 8, height: 4, kicad: Object.assign({ name: name, pads: pad2(5), fab: [], silk: [] }, extra || {}) }, {}), 'capacitor', { refPrefix: 'C' });
    const mkp = build('C_Rect_L7.2mm_W2.5mm_P5.00mm_FKS2_FKP2_MKS2_MKP2', {
        pads: pad2(5),
        fab: [{ type: 'rect', x1: -3.6, y1: -1.25, x2: 3.6, y2: 1.25, w: 0.1 }],
        silk: []
    });
    assert(M._famOf({ kicad: { name: 'C_Rect_L7.2mm_W2.5mm_P5.00mm_FKS2_FKP2_MKS2_MKP2', pads: pad2(5) } }, 'capacitor', { refPrefix: 'C' }) === 'box', 'MKP film cap is a box, not a can');
    assert(mkp.some(p => p.m === 'film' && p.t === 'b' && p.h > 2 && p.h < 8), 'MKP body is a low box');
    assert(!mkp.some(p => p.m === 'alu'), 'MKP body is not a vertical can');

    const silk = [];
    for (let i = 0; i < 40; i++) silk.push({ type: 'line', x1: i * 0.04, y1: -2.4, x2: i * 0.04, y2: 2.4, w: 0.12 });
    silk.push({ type: 'line', x1: -1.2, y1: -1.4, x2: -0.7, y2: -1.4, w: 0.12 });
    const radial = build('CP_Radial_D5.0mm_P2.50mm', {
        pads: pad2(2.5),
        fab: [{ type: 'circle', x: 0, y: 0, r: 2.5, w: 0.1 }],
        silk: silk
    });
    const silkBoxes = radial.filter(p => p.m === 'silk' && p.t === 'b');
    assert(silkBoxes.length < 5, 'electrolytic silk hatch is not a plate (' + silkBoxes.length + ' strokes left)');
    const can = radial.find(p => p.m === 'alu' && p.t === 'c' && !p.ax);
    assert(can && Math.abs(can.r - 2.5) < 0.05 && can.h > 5 && can.h < 9, 'electrolytic is a vertical can');

    const disc = build('C_Disc_D5.0mm_W2.5mm_P5.00mm', { pads: pad2(5), fab: [{ type: 'rect', x1: -2.5, y1: -1.25, x2: 2.5, y2: 1.25, w: 0.1 }] });
    const discBody = disc.find(p => p.m === 'ceramic' && p.t === 'c');
    assert(discBody && discBody.ax === 'z' && Math.abs(discBody.r - 2.5) < 0.05 && Math.abs(discBody.h - 2.5) < 0.05, 'ceramic disc stands on edge');

    const np = build('C_Radial_D10.0mm_H12.5mm_P5.00mm', {
        pads: pad2(5),
        fab: [{ type: 'circle', x: 0, y: 0, r: 5, w: 0.1 }],
        silk: []
    });
    const npCan = np.find(p => p.m === 'alu' && p.t === 'c' && !p.ax);
    assert(npCan && Math.abs(npCan.h - 12.5) < 0.05 && Math.abs(npCan.r - 5) < 0.05, 'non-polar radial uses D and H from the name');
    assert(!np.some(p => p.m === 'stripe'), 'non-polar radial has no polarity stripe');

    const ax = build('CP_Axial_L10.0mm_D6.0mm_P15.00mm_Horizontal', { pads: pad2(15), fab: [], silk: [] });
    const axBody = ax.find(p => p.m === 'alu' && p.t === 'c' && p.ax === 'x');
    assert(M._famOf({ kicad: { name: 'CP_Axial_L10.0mm_D6.0mm_P15.00mm_Horizontal', pads: pad2(15) } }, 'capacitor', { refPrefix: 'C' }) === 'axial', 'CP_Axial stays horizontal');
    assert(axBody && Math.abs(axBody.h - 10) < 0.05 && Math.abs(axBody.r - 3) < 0.05, 'axial electrolytic uses L and D');

    // DIP (NE555) and transistor packages: body axis, leads, and outline arcs.
    const byName = (key, re) => ComponentDefs.defs[key].sizes.find(s => re.test(s.name || ''));
    const ne = byName('ic', /NE555/);
    assert(ne && ne.kicad && ne.kicad.silk.some(g => g.type === 'arc' && Math.abs(g.sweep) > 2), 'NE555 silk has the pin-1 notch arc');
    const neParts = M._buildParts(ne, 'ic', ComponentDefs.defs.ic);
    const neBody = neParts.find(p => p.m === 'plastic' && p.t === 'b');
    assert(neBody && neBody.d > neBody.w && neBody.w > 5 && neBody.w < 8 && neBody.d > 8 && neBody.d < 13 && neBody.h > 2.5, 'NE555 body is a DIP along the pin columns (' + (neBody && neBody.w) + 'x' + (neBody && neBody.d) + ')');
    const neLeads = neParts.filter(p => p.t === 't');
    assert(neLeads.length === 8, 'NE555 has one lead per pin (' + neLeads.length + ')');
    ne.kicad.pads.forEach(p => {
        const hit = neLeads.some(ld => ld.pts.some(q => Math.hypot(q[0] - p.x, q[2] - p.y) < 0.45));
        assert(hit, 'NE555 lead reaches pad ' + p.num);
    });
    const dip16 = KicadImport._parseFootprint(fs.readFileSync(path.join(__dirname, '..', 'libs/ics/DIP-16_W7.62mm.kicad_mod'), 'utf8'));
    const notch16 = (dip16.silk || []).find(g => g.type === 'arc');
    assert(notch16 && Math.abs(notch16.r - 1) < 0.05 && notch16.y < -1, 'DIP-16 modern arc is the pin-1 notch');

    const q92 = byName('transistor', /TO-92/);
    assert(q92.kicad.silk.filter(g => g.type === 'arc' && g.r > 2).length >= 2, 'TO-92 body outline is arcs');
    const qParts = M._buildParts(q92, 'transistor', ComponentDefs.defs.transistor);
    const qBody = qParts.find(p => p.m === 'plastic' && p.t === 'poly');
    assert(qBody && qBody.pts.length > 8, 'TO-92 body is a D-shaped extrusion');
    let qx = 0, qy = 0;
    qBody.pts.forEach(p => { qx += p.x; qy += -p.y; });
    qx /= qBody.pts.length; qy /= qBody.pts.length;
    const pcx = q92.kicad.pads.reduce((s, p) => s + p.x, 0) / q92.kicad.pads.length;
    const pcy = q92.kicad.pads.reduce((s, p) => s + p.y, 0) / q92.kicad.pads.length;
    assert(Math.hypot(qx - pcx, qy - pcy) < 2.2, 'TO-92 body sits on its pads (' + qx.toFixed(2) + ',' + qy.toFixed(2) + ')');
    const span = qBody.pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - qx, -p.y - qy)), 0);
    assert(span > 2 && span < 3.2, 'TO-92 body is about 5mm across (' + (span * 2).toFixed(2) + ')');

    const tip = byName('transistor', /TO-220/);
    const tipParts = M._buildParts(tip, 'transistor', ComponentDefs.defs.transistor);
    const tipBody = tipParts.find(p => p.m === 'plastic' && p.t === 'b');
    const tipLeads = tip.kicad.pads.filter(p => p.drill && p.drill < 2);
    const tipHole = tip.kicad.pads.find(p => p.drill >= 2);
    const leadY = tipLeads.reduce((s, p) => s + p.y, 0) / tipLeads.length;
    assert(tipBody && (tipBody.z - leadY) * (tipHole.y - leadY) > 0, 'TO-220 plastic is toward the tab');
    assert(Math.abs(tipBody.z - leadY) > 2, 'TO-220 plastic is not sitting on the lead pads');
    assert(tipBody.h > 3.5 && tipBody.w > 8, 'TO-220 plastic is the full package');
    assert(tipParts.some(p => p.m === 'alu' && p.t === 'b'), 'TO-220 has a metal tab');

    const sot = byName('transistor', /SOT-23/);
    const sotParts = M._buildParts(sot, 'transistor', ComponentDefs.defs.transistor);
    const sotBody = sotParts.find(p => p.m === 'plastic' && p.t === 'b');
    const sotW = Math.min(sotBody.w, sotBody.d), sotL = Math.max(sotBody.w, sotBody.d);
    assert(sotW > 1 && sotW < 1.8 && sotL > 2.4 && sotL < 3.5, 'SOT-23 body is about 1.3 x 2.9 (' + sotW.toFixed(2) + 'x' + sotL.toFixed(2) + ')');
    assert(sotParts.filter(p => p.t === 't').length === 3, 'SOT-23 has three gull wings');

    const so = byName('ic', /^SOIC-8/);
    const soParts = M._buildParts(so, 'ic', ComponentDefs.defs.ic);
    const soLeads = soParts.filter(p => p.t === 't');
    assert(soLeads.length === 8, 'SOIC-8 has eight gull wings');
    so.kicad.pads.forEach(p => {
        const hit = soLeads.some(ld => ld.pts.some(q => Math.hypot(q[0] - p.x, q[2] - p.y) < 0.45 && Math.sign(q[0] || 1) === Math.sign(p.x || 1)));
        assert(hit, 'SOIC-8 lead stays on pad ' + p.num + ' side');
    });

    const tact = byName('switch', /Tact/);
    const tactParts = M._buildParts(tact, 'switch', ComponentDefs.defs.switch);
    assert(M._famOf(tact, 'switch', ComponentDefs.defs.switch) === 'push', 'tact switch is a push button');
    assert(tactParts.some(p => p.m === 'plastic' && p.t === 'b' && p.h > 2 && p.h < 5), 'tact body is a low square');
    assert(tactParts.some(p => p.t === 'c' && p.m === 'dark' && p.h < 2), 'tact has a button cap');
    assert(!tactParts.some(p => p.m === 'headerplastic'), 'tact is not drawn as a pin header');

    const spst = byName('switch', /SPST/);
    assert(M._famOf(spst, 'switch', ComponentDefs.defs.switch) === 'slide', 'SPST is a slide switch');

    const dip4 = ComponentDefs.makeDipSwitch(4);
    const dipParts = M._buildParts(dip4, 'switch', ComponentDefs.defs.switch);
    assert(dip4.pins.length === 8, 'DIP-4 switch has two pins per position');
    assert(dipParts.filter(p => p.m === 'dark' && p.t === 'b' && p.h < 1).length === 4, 'DIP-4 switch has one slider per position');
    const dipBody = dipParts.find(p => p.m === 'plastic' && p.t === 'b');
    assert(dipBody && dipBody.w > 7 && dipBody.d > 8, 'DIP switch body covers both pin rows');

    const male = ComponentDefs.makeHeader(1, 8, 2.54, 'male');
    const maleParts = M._buildParts(male, 'connector', ComponentDefs.defs.connector);
    assert(M._famOf(male, 'connector', ComponentDefs.defs.connector) === 'hdr', '1x8 male header is a header, not an axial part');
    const malePin = maleParts.find(p => p.m === 'tin' && p.t === 'b');
    const maleBody = maleParts.find(p => p.m === 'headerplastic');
    assert(malePin && malePin.h > 8 && maleBody && maleBody.h < 4, 'male header pins stand above a short base');
    assert(malePin.y + malePin.h / 2 > maleBody.y + maleBody.h / 2 + 4, 'male pins clear the housing');

    const female = ComponentDefs.makeHeader(1, 8, 2.54, 'female');
    const femParts = M._buildParts(female, 'connector', ComponentDefs.defs.connector);
    assert(M._famOf(female, 'connector', ComponentDefs.defs.connector) === 'socket', 'female header is a socket');
    const femPin = femParts.find(p => p.m === 'tin' && p.t === 'b');
    const femBody = femParts.find(p => p.m === 'headerplastic');
    assert(femBody && femBody.h > 7 && femPin && femPin.y + femPin.h / 2 < femBody.y + femBody.h / 2 - 2, 'female pins stay inside the socket');
    assert(female.name.indexOf('Female') === 0 && male.name.indexOf('Female') < 0, 'female header name is distinct from the male header');

    ['gnd', 'power', 'nc'].forEach(key => {
        const def = ComponentDefs.defs[key];
        def.sizes.forEach(size => {
            const parts = M._buildParts(size, key, def);
            assert(!parts.some(p => p.m === 'plastic' || p.m === 'tin'), key + ' ' + size.name + ' is a pad, not a package');
            assert(parts.some(p => p.m === 'copper' && p.t === 'c'), key + ' ' + size.name + ' pad is round');
        });
    });
}

console.log(`project-api: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);