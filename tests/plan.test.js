#!/usr/bin/env node
// Design-workflow kernel (Plan) tests â€” Node vm, no browser.
// Loads the DOM-free kernel the MCP host loads, then exercises placement,
// plan check, and quality checks end to end.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

const ctx = { console, App: {}, module: { exports: {} } };
loadScript('js/component-defs.js', ctx);
loadScript('js/export.js', ctx);
loadScript('js/dxf.js', ctx);
loadScript('js/gcode.js', ctx);
loadScript('js/drc.js', ctx);
loadScript('js/project-api.js', ctx);
const ProjectApi = ctx.module.exports;
loadScript('js/plan.js', ctx);
const Plan = ctx.module.exports;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

// ============================================================
// 1. Zone geometry (AD-3)
// ============================================================
{
    const z = { id: 1, name: 'power', x: 0, y: -10, w: 40, h: 20 };
    const r = Plan.zoneRect(z);
    assert(r.minX === -20 && r.maxX === 20 && r.minY === -20 && r.maxY === 0, 'zoneRect center-based bounds');
    assert(Plan.pointInZone(0, -10, z) === true, 'pointInZone center inside');
    assert(Plan.pointInZone(21, -10, z) === false, 'pointInZone outside x');
    assert(Plan.pointInZone(0, 1, z) === false, 'pointInZone outside y');
}

// ============================================================
// 2. Component bounds (rotation-aware)
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const c = ProjectApi.addComponent(p, { type: 'capacitor', x: 0, y: 0, size: 9 }); // 8x10
    const b0 = Plan.compBounds(p, c);
    assert(Math.abs(b0.hw - 4) < 1e-9 && Math.abs(b0.hh - 5) < 1e-9, 'compBounds unrotated 8x10');
    c.rotation = 90;
    const b90 = Plan.compBounds(p, c);
    assert(Math.abs(b90.hw - 5) < 1e-9 && Math.abs(b90.hh - 4) < 1e-9, 'compBounds 90deg swaps extents');
}

// ============================================================
// 3. Plan-aware placement (CAP-3)
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    p.board.width = 100; p.board.height = 60;
    ProjectApi.setPlan(p, {
        zones: [{ id: 1, name: 'power', x: 0, y: -15, w: 80, h: 20 }],
        assignments: {},
        flowDirection: 'lr'
    });
    const a = ProjectApi.addComponent(p, { type: 'resistor', x: -30, y: 0 });
    const b = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    const c = ProjectApi.addComponent(p, { type: 'resistor', x: 30, y: 0 });
    p.assignments = { [a.id]: 1, [b.id]: 1, [c.id]: 1 };

    const moves = Plan.placeByPlan(p);
    assert(moves.length === 3, 'placeByPlan returns a move per assigned part');
    // lr flow: x increases with netlist order; all inside the zone.
    const byId = {};
    moves.forEach(m => { byId[m.id] = m; });
    assert(byId[a.id].x < byId[b.id].x && byId[b.id].x < byId[c.id].x, 'lr flow spreads left->right');
    assert(moves.every(m => Plan.pointInZone(m.x, m.y, p.zones[0])), 'placed parts land inside their zone');

    // rl flow reverses the order.
    p.flowDirection = 'rl';
    const movesRl = Plan.placeByPlan(p);
    const byIdRl = {};
    movesRl.forEach(m => { byIdRl[m.id] = m; });
    assert(byIdRl[a.id].x > byIdRl[b.id].x && byIdRl[b.id].x > byIdRl[c.id].x, 'rl flow spreads right->left');

    // applyPlacement mutates x/y.
    const n = Plan.applyPlacement(p, moves);
    assert(n === 3 && p.components.find(x => x.id === a.id).x === byId[a.id].x, 'applyPlacement sets positions');
}

// ============================================================
// 4. Plan check (CAP-4, DRC-shaped)
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    p.board.width = 40; p.board.height = 30;
    ProjectApi.setPlan(p, { zones: [{ id: 1, name: 'z', x: 0, y: 0, w: 10, h: 10 }], assignments: {} });
    const a = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    const b = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 }); // overlap a
    p.assignments = { [a.id]: 1, [b.id]: 1 };
    const v = Plan.planCheck(p);
    assert(v.some(x => x.type === 'overlap'), 'planCheck flags overlap');

    // Out of board.
    const c = ProjectApi.addComponent(p, { type: 'resistor', x: 100, y: 100 });
    p.assignments[c.id] = 1;
    const v2 = Plan.planCheck(p);
    assert(v2.some(x => x.type === 'out-of-board'), 'planCheck flags out-of-board');
    assert(v2.some(x => x.type === 'out-of-zone'), 'planCheck flags out-of-zone');

    // Clean placement -> no violations.
    const clean = ProjectApi.createEmptyProject();
    clean.board.width = 100; clean.board.height = 60;
    ProjectApi.setPlan(clean, { zones: [{ id: 1, name: 'z', x: 0, y: 0, w: 40, h: 20 }], assignments: {} });
    const d = ProjectApi.addComponent(clean, { type: 'resistor', x: -10, y: 0 });
    const e = ProjectApi.addComponent(clean, { type: 'resistor', x: 10, y: 0 });
    clean.assignments = { [d.id]: 1, [e.id]: 1 };
    assert(Plan.planCheck(clean).length === 0, 'planCheck clean placement passes');
}

// ============================================================
// 5. Quality checks (CAP-10)
// ============================================================
{
    // Single-layer: vias flagged.
    const p = ProjectApi.createEmptyProject();
    ProjectApi.addVia(p, { x: 0, y: 0 });
    assert(Plan.qualityCheck(p).some(x => x.type === 'single-layer'), 'qualityCheck flags vias on single-layer');

    // Cross-net crossing.
    const q = ProjectApi.createEmptyProject();
    q.traces = [
        { id: 1, points: [{ x: -10, y: 0 }, { x: 10, y: 0 }], net: 'A', width: 0.5, layer: 'top' },
        { id: 2, points: [{ x: 0, y: -10 }, { x: 0, y: 10 }], net: 'B', width: 0.5, layer: 'top' }
    ];
    assert(Plan.qualityCheck(q).some(x => x.type === 'crossing'), 'qualityCheck flags cross-net crossing');
    assert(ctx.computeDrcViolations(q).some(x => x.type === 'crossing'), 'DRC flags cross-net crossing');
    const before = q.traces.length;
    let refused = false;
    try {
        ProjectApi.addTrace(q, { points: [{ x: 0, y: -5 }, { x: 0, y: 5 }], net: 'C', width: 0.5 });
    } catch (e) {
        refused = /not placed/.test(e.message);
    }
    assert(refused, 'addTrace refuses a cross-net short');
    assert(q.traces.length === before, 'refused trace is not stored');
    ProjectApi.addTrace(q, { points: [{ x: -10, y: 0 }, { x: -2, y: 0 }], net: 'A', width: 0.5 });
    assert(q.traces.length === before + 1, 'same-net trace that does not cross another net is stored');

    // Same-net shared vertex is NOT a crossing.
    const s = ProjectApi.createEmptyProject();
    s.traces = [
        { id: 1, points: [{ x: -10, y: 0 }, { x: 0, y: 0 }], net: 'A', width: 0.5, layer: 'top' },
        { id: 2, points: [{ x: 0, y: 0 }, { x: 0, y: 10 }], net: 'A', width: 0.5, layer: 'top' }
    ];
    assert(!Plan.qualityCheck(s).some(x => x.type === 'crossing'), 'qualityCheck ignores same-net joins');

    // GND connectivity: two isolated GND pads -> disconnected groups.
    const g = ProjectApi.createEmptyProject();
    const c1 = ProjectApi.addComponent(g, { type: 'capacitor', x: -20, y: 0, size: 4 });
    const c2 = ProjectApi.addComponent(g, { type: 'capacitor', x: 20, y: 0, size: 4 });
    g.traces = [
        { id: 1, points: [{ x: -21, y: 0 }, { x: -19, y: 0 }], net: 'GND', width: 0.5, layer: 'top' },
        { id: 2, points: [{ x: 19, y: 0 }, { x: 21, y: 0 }], net: 'GND', width: 0.5, layer: 'top' }
    ];
    const conn = Plan.netConnectivity(g, 'GND');
    assert(conn && conn.components === 2 && conn.groups === 2, 'netConnectivity finds 2 disconnected GND groups');
    assert(Plan.qualityCheck(g).some(x => x.type === 'gnd-disconnected'), 'qualityCheck flags disconnected GND');

    // Connected GND (one trace joining both) -> single group, no violation.
    const gc = ProjectApi.createEmptyProject();
    const a1 = ProjectApi.addComponent(gc, { type: 'capacitor', x: -20, y: 0, size: 4 });
    const a2 = ProjectApi.addComponent(gc, { type: 'capacitor', x: 20, y: 0, size: 4 });
    gc.traces = [
        { id: 1, points: [{ x: -21, y: 0 }, { x: 21, y: 0 }], net: 'GND', width: 0.5, layer: 'top' }
    ];
    const conn2 = Plan.netConnectivity(gc, 'GND');
    assert(conn2 && conn2.groups === 1, 'netConnectivity finds 1 connected GND group');
    assert(!Plan.qualityCheck(gc).some(x => x.type === 'gnd-disconnected'), 'qualityCheck passes connected GND');
}

// ============================================================
// Spec test 1 — pad touching an interior vertex of a polyline
// ============================================================
{
    const p = ProjectApi.createEmptyProject();
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0 });
    const r2 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    const r3 = ProjectApi.addComponent(p, { type: 'resistor', x: 20, y: 0 });
    const w1 = ProjectApi.pinWorld(p, r1.id, 1);
    const w2 = ProjectApi.pinWorld(p, r2.id, 0);
    const w3 = ProjectApi.pinWorld(p, r3.id, 0);
    p.traces = [{ id: 1, points: [{ x: w1.x, y: w1.y }, { x: w2.x, y: w2.y }, { x: w3.x, y: w3.y }], net: 'VCC', width: 0.5, layer: 'top' }];
    assert(ProjectApi.getPinNet(p, r2.id, 0) === 'VCC', 'getPinNet resolves pad touching interior vertex');
    const g = Plan.netConnectivity(p, 'VCC');
    assert(g && g.groups === 1, 'netConnectivity one group through interior vertex');
}

// ============================================================
// Spec test 2 — routeRail of ten pins: 9 traces, schemEnds pairs
// ============================================================
{
    const p = ProjectApi.createEmptyProject({ width: 100, height: 40 });
    const comps = [];
    for (let i = 0; i < 10; i++) comps.push(ProjectApi.addComponent(p, { type: 'resistor', x: -45 + i * 10, y: -10 }));
    const pins = comps.map(c => ({ compId: c.id, pin: '1' }));
    const res = ProjectApi.routeRail(p, 'VCC', pins, { edge: 'top' });
    assert(res.traces.length === 9, 'routeRail 10 pins -> 9 traces');
    let endsOk = res.traces.length === 9;
    res.traces.forEach((t, i) => {
        const se = t.schemEnds;
        if (!se || se.length !== 2) { endsOk = false; return; }
        const ids = [se[0].compId, se[1].compId].sort((a, b) => a - b);
        const want = [comps[i].id, comps[i + 1].id].sort((a, b) => a - b);
        if (ids[0] !== want[0] || ids[1] !== want[1]) endsOk = false;
    });
    assert(endsOk, 'routeRail schemEnds on consecutive pairs');
    const g = Plan.netConnectivity(p, 'VCC');
    assert(g && g.groups === 1, 'routeRail rail is one connected group');
    let stacked = 0;
    for (let i = 0; i < res.traces.length; i++) {
        for (let j = i + 1; j < res.traces.length; j++) {
            const segs = [];
            const pb = res.traces[j].points;
            for (let s = 0; s + 1 < pb.length; s++) segs.push({ a: pb[s], b: pb[s + 1] });
            const kept = ProjectApi.uncoveredPieces(res.traces[i].points, segs, 0.05);
            let klen = 0;
            for (const q of kept) klen += ProjectApi._polyLen(q);
            stacked += ProjectApi._polyLen(res.traces[i].points) - klen;
        }
    }
    assert(stacked < 0.2, 'routeRail does not stack one trace on another');
}

// ============================================================
// Spec test 4 — placeByPlan groups: columns line up, equal Y
// ============================================================
{
    const p = ProjectApi.createEmptyProject({ width: 100, height: 60 });
    const groups = [];
    const all = [];
    for (let g = 0; g < 10; g++) {
        const members = [];
        for (let i = 0; i < 3; i++) {
            const c = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
            members.push(c.id); all.push(c.id);
        }
        groups.push({ key: 'B' + (g + 1), members });
    }
    const assignments = {};
    all.forEach(id => assignments[id] = 1);
    ProjectApi.setPlan(p, {
        requirements: { boardWidth: 100, boardHeight: 60 },
        zones: [{ id: 1, name: 'main', x: 0, y: 0, w: 90, h: 50 }],
        assignments: assignments, groups: groups, flowDirection: 'lr'
    });
    const moves = Plan.placeByPlan(p);
    const byId = {};
    moves.forEach(m => byId[m.id] = m);
    const x0 = groups.map(g => byId[g.members[0]].x);
    const x1 = groups.map(g => byId[g.members[1]].x);
    assert(x0.every(x => Math.abs(x - x0[0]) < 1e-6), 'groups: member 0 of every group on one X');
    assert(x1.every(x => Math.abs(x - x1[0]) < 1e-6), 'groups: member 1 of every group on one X');
    assert(Math.abs(x0[0] - x1[0]) > 1, 'groups: member 0 and member 1 on distinct X');
    const ys = moves.map(m => m.y);
    assert(ys.every(y => Math.abs(y - ys[0]) < 1e-6), 'groups: equal Y in zone when stagger omitted');
}

// ============================================================
// Spec test 7 — circuitCheck on the dimmer contract
// ============================================================
{
    const p = ProjectApi.createEmptyProject({ width: 80, height: 40 });
    const hdr = ProjectApi.addComponent(p, { type: 'connector', x: -30, y: 0 });
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -10, y: -10 });
    const jp = ProjectApi.addComponent(p, { type: 'jumper', x: 5, y: 0 });
    const d1 = ProjectApi.addComponent(p, { type: 'led', x: 20, y: 10 });
    ProjectApi.setNetlist(p, {
        VCC: [{ compId: hdr.id, pin: '1' }, { compId: r1.id, pin: '1' }],
        DIM1: [{ compId: r1.id, pin: '2' }, { compId: jp.id, pin: '1' }, { compId: jp.id, pin: '2' }, { compId: d1.id, pin: 'A' }],
        GND: [{ compId: d1.id, pin: 'K' }, { compId: hdr.id, pin: '2' }]
    }, 'merge');
    ProjectApi.routeRail(p, 'VCC', [{ compId: hdr.id, pin: '1' }, { compId: r1.id, pin: '1' }], { edge: 'top' });
    ProjectApi.connectPins(p, { compId: r1.id, pin: '2' }, { compId: jp.id, pin: '1' }, { net: 'DIM1' });
    ProjectApi.connectPins(p, { compId: jp.id, pin: '1' }, { compId: jp.id, pin: '2' }, { net: 'DIM1' });
    ProjectApi.connectPins(p, { compId: jp.id, pin: '2' }, { compId: d1.id, pin: 'A' }, { net: 'DIM1' });
    ProjectApi.connectPins(p, { compId: d1.id, pin: 'K' }, { compId: hdr.id, pin: '2' }, { net: 'GND' });
    const contract = {
        rails: [{ net: 'VCC' }],
        branches: [
            { net: 'DIM1', from: { compId: r1.id, pin: '2' }, to: { compId: jp.id, pin: '1' } },
            { net: 'DIM1', from: { compId: jp.id, pin: '2' }, to: { compId: d1.id, pin: 'A' } },
            { net: 'GND', from: { compId: d1.id, pin: 'K' }, to: { compId: hdr.id, pin: '2' } }
        ],
        ties: [{ net: 'DIM1', pins: [{ compId: jp.id, pin: '1' }, { compId: jp.id, pin: '2' }] }]
    };
    const clean = Plan.circuitCheck(p, contract);
    assert(clean.length === 0, 'circuitCheck clean on wired dimmer (got ' + JSON.stringify(clean).slice(0, 200) + ')');
    const tieIdx = p.traces.findIndex(t => t.net === 'DIM1' && t.schemEnds && t.schemEnds[0].compId === jp.id && t.schemEnds[1].compId === jp.id);
    assert(tieIdx >= 0, 'wiper tie trace exists');
    p.traces.splice(tieIdx, 1);
    const v = Plan.circuitCheck(p, contract);
    assert(v.some(x => x.type === 'tie-open'), 'circuitCheck flags tie-open when wiper copper removed');
}

// Logical electrical gate — contract vs netlist, no copper required.
{
    const missing = Plan.electricalCheck({ components: [], netlist: {}, traces: [] }, null);
    assert(missing.some(x => x.type === 'missing-contract'), 'electricalCheck: missing contract fails');

    const p = ProjectApi.createEmptyProject({ width: 80, height: 40 });
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: -10, y: 0 });
    const d1 = ProjectApi.addComponent(p, { type: 'led', x: 10, y: 0 });
    ProjectApi.setNetlist(p, {
        VCC: [{ compId: r1.id, pin: '1' }],
        SIG: [{ compId: r1.id, pin: '2' }, { compId: d1.id, pin: 'A' }],
        GND: [{ compId: d1.id, pin: 'K' }]
    }, 'merge');
    const clean = Plan.electricalCheck(p, { rails: [{ net: 'SIG' }], branches: [], ties: [] });
    assert(clean.length === 0, 'electricalCheck clean with no copper (got ' + JSON.stringify(clean).slice(0, 240) + ')');

    const wrong = Plan.electricalCheck(p, {
        rails: [{ net: 'SIG', pins: [{ compId: r1.id, pin: '1' }, { compId: d1.id, pin: 'A' }] }],
        branches: [],
        ties: []
    });
    assert(wrong.some(x => x.type === 'wrong-net'), 'electricalCheck flags a pin on the wrong net');
}

{
    const p = ProjectApi.createEmptyProject({ width: 80, height: 40 });
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    ProjectApi.setNetlist(p, { NET: [{ compId: r1.id, pin: '1' }] }, 'replace');
    const v = Plan.electricalCheck(p, { rails: [{ net: 'NET', pins: [{ compId: r1.id, pin: '1' }, { compId: r1.id, pin: '1' }] }], branches: [], ties: [], unused: [] });
    assert(v.some(x => x.type === 'floating-pin'), 'electricalCheck flags the unconnected resistor pin');
    const nc = Plan.electricalCheck(p, {
        rails: [{ net: 'NET', pins: [{ compId: r1.id, pin: '1' }, { compId: r1.id, pin: '1' }] }],
        branches: [], ties: [],
        unused: [{ compId: r1.id, pin: '2' }]
    });
    assert(nc.length === 0, 'electricalCheck accepts an explicit NC pin (got ' + JSON.stringify(nc).slice(0, 200) + ')');
}

{
    const p = ProjectApi.createEmptyProject({ width: 40, height: 20 });
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    p.netlist = {
        A: [{ compId: r1.id, pin: '1' }],
        B: [{ compId: r1.id, pin: '1' }, { compId: r1.id, pin: '2' }]
    };
    const merged = Plan.electricalCheck(p, { rails: [{ net: 'B' }], branches: [], ties: [] });
    assert(merged.some(x => x.type === 'net-merge'), 'electricalCheck flags a pin on two nets');
}

{
    const p = ProjectApi.createEmptyProject({ width: 40, height: 20 });
    const r1 = ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0 });
    const r2 = ProjectApi.addComponent(p, { type: 'resistor', x: 15, y: 0 });
    ProjectApi.setNetlist(p, {
        SIG: [{ compId: r1.id, pin: '1' }, { compId: r2.id, pin: '1' }]
    }, 'replace');
    const uncovered = Plan.electricalCheck(p, {
        rails: [],
        branches: [],
        ties: [{ net: 'OTHER', pins: [{ compId: r1.id, pin: '1' }, { compId: r1.id, pin: '2' }] }],
        unused: [{ compId: r2.id, pin: '2' }]
    });
    assert(uncovered.some(x => x.type === 'uncovered-net'), 'electricalCheck flags a net missing from the contract');
}

{
    const p = ProjectApi.createEmptyProject({ width: 40, height: 20 });
    p.traces = [
        { id: 1, net: 'A', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], width: 0.5 },
        { id: 2, net: 'B', points: [{ x: 0, y: 10 }, { x: 10, y: 0 }], width: 0.5 }
    ];
    const q = Plan.qualityCheck(p);
    assert(q.some(v => v.type === 'crossing'), 'qualityCheck flags a cross-net crossing');
}

{
    const p = ProjectApi.createEmptyProject({ width: 80, height: 40 });
    const a = ProjectApi.addComponent(p, { type: 'resistor', x: -20, y: 0 });
    const b = ProjectApi.addComponent(p, { type: 'resistor', x: 20, y: 0 });
    const pa = ProjectApi.pinWorld(p, a.id, '1');
    const railY = pa.y - 2;
    const midY = (pa.y + railY) / 2;
    p.traces = [{ id: 99, net: 'BLOCK', points: [{ x: -40, y: midY }, { x: 40, y: midY }], width: 0.5, layer: 'top' }];
    const n = p.traces.length;
    let refused = false;
    try {
        ProjectApi.routeRail(p, 'VCC', [{ compId: a.id, pin: '1' }, { compId: b.id, pin: '1' }], { edge: 'top', stub: 2 });
    } catch (e) {
        refused = /not placed/.test(e.message);
    }
    assert(refused, 'routeRail refuses a rail that shorts another net');
    assert(p.traces.length === n, 'routeRail stores nothing when it would short');
}

console.log(`plan: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

