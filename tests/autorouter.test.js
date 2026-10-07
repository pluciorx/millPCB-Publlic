#!/usr/bin/env node
// Automated routing-grid / obstacle-map tests (Story 1.1) — Node vm, no browser.
// Same shared-context harness as project-api.test.js: the kernel scripts see
// each other's top-level bindings exactly like in the browser global scope.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

const ctx = { console, App: {}, module: { exports: {} } }; // App stub — drc.js does Object.assign(App, ...)
loadScript('js/component-defs.js', ctx);
loadScript('js/export.js', ctx);
loadScript('js/dxf.js', ctx);
loadScript('js/gcode.js', ctx);
loadScript('js/drc.js', ctx);
loadScript('js/project-api.js', ctx);
const ProjectApi = ctx.module.exports; // capture before autorouter overwrites it
loadScript('js/autorouter.js', ctx);
const Autoroute = ctx.module.exports;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}
function assertClose(a, b, eps, msg) {
    assert(Math.abs(a - b) <= eps, `${msg} (expected ${b}, got ${a})`);
}

// 10x10 mm board, default params (traceWidth 0.5, minClearance 0.38).
function makeProject() {
    const p = ProjectApi.createEmptyProject();
    p.board.width = 10;
    p.board.height = 10;
    return p;
}
function cell(g, ix, iy) { return g.state[iy * g.cols + ix]; }
function assertCell(g, ix, iy, expected, msg) {
    const got = cell(g, ix, iy);
    assert(got === expected, `${msg} — cell(${ix},${iy}) expected ${expected}, got ${got}`);
}

// ------------------------------------------------------------
// T1: grid shape + board-edge inset (gs 0.25 → 40x40)
// center(i) = (i+0.5)*0.25 - 5; inset 0.5 → boundary |c| > 4.5 is BLOCKED(1)
// ------------------------------------------------------------
{
    const g = Autoroute.buildGrid(makeProject(), { gridSize: 0.25, boardEdgeClearance: 0.5 });
    assert(g.gridSize === 0.25, 'T1: gridSize echoed');
    assert(g.state.constructor.name === 'Uint8Array' && g.state.length === 1600, 'T1: state is Uint8Array(cols*rows)');
    assert(g.parent.constructor.name === 'Int32Array' && g.parent.length === 1600, 'T1: parent is Int32Array(cols*rows)');
    let allNeg = true;
    for (let i = 0; i < g.parent.length; i++) if (g.parent[i] !== -1) { allNeg = false; break; }
    assert(allNeg, 'T1: parent initialized to -1');
    assertCell(g, 0, 0, 1, 'T1: corner cell in edge inset blocked');       // center (-4.875,-4.875)
    assertCell(g, 1, 20, 1, 'T1: inset ring blocked');             // center x=-4.625 < -4.5
    assertCell(g, 2, 20, 0, 'T1: just inside inset is FREE');       // center x=-4.375 >= -4.5
    assertCell(g, 20, 20, 0, 'T1: board middle FREE');              // center (0.125,0.125)
}

// ------------------------------------------------------------
// T2: options overrides + rule resolution
// ------------------------------------------------------------
{
    const p = makeProject();
    const g2 = Autoroute.buildGrid(p, { gridSize: 0.1, boardEdgeClearance: 1.0 });
    assert(g2.cols === 100 && g2.rows === 100, 'T2: gs 0.1 → 100x100 grid');
    assert(g2.state.length === 10000, 'T2: state sized to new grid');
    assertCell(g2, 9, 50, 1, 'T2: boardEdgeClearance 1.0 blocks |c|>4.0');   // center x=-4.05
    assertCell(g2, 10, 50, 0, 'T2: inside 1.0 inset is FREE');       // center x=-3.95

    const r = Autoroute.resolveRules(p, { traceWidth: 0.8, clearance: 0.5 });
    assert(r.traceWidth === 0.8 && r.clearance === 0.5, 'T2: options override params');
    assertClose(r.expansion, 0.9, 1e-9, 'T2: expansion = traceWidth/2 + clearance');

    const d = Autoroute.resolveRules(p);
    assert(d.gridSize === 0.1 && d.traceWidth === 0.5 && d.clearance === 0.38 && d.boardEdgeClearance === 0.3,
        'T2: defaults from params (grid 0.1, tw 0.5, clr 0.38, edge 0.3)');
    assertClose(d.expansion, 0.63, 1e-9, 'T2: default expansion 0.63');
}

// ------------------------------------------------------------
// T3: circular TH pad (gnd "TH TP": 3x3 body, pad r=1 at pin (0,0))
// placed at (2,2) → cells within r+expansion blocked, far cell free
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: 2, y: 2, sizeName: 'TH TP' });
    const c = Autoroute.createContext(p, { gridSize: 0.25 });
    Autoroute.buildObstacles(c);
    const g = c.grid;
    assertCell(g, 28, 28, 1, 'T3: cell on pad blocked (world 2.125,2.125)');
    assertCell(g, 2, 2, 0, 'T3: far cell free (world -4.375,-4.375, dist ~9mm)');
}

// ------------------------------------------------------------
// T4: existing trace on route layer blocks cells around it
// trace (-2,-2)→(2,-2) w=0.5 → threshold 0.5/2+0.38 = 0.88
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addTrace(p, { points: [{ x: -2, y: -2 }, { x: 2, y: -2 }], net: 'VCC', width: 0.5 });
    const c = Autoroute.createContext(p, { gridSize: 0.25 });
    Autoroute.buildObstacles(c);
    const g = c.grid;
    assertCell(g, 20, 11, 1, 'T4: cell 0.125mm from trace blocked (world 0.125,-2.125)');
    assertCell(g, 20, 34, 0, 'T4: cell 5.75mm away free (world 0.125,3.625)');
}

// ------------------------------------------------------------
// T5: boardEdgeClearance option changes the inset ring
// boardEdgeClearance 0.25 → boundary |c| > 4.75 is BLOCKED(1)
// ------------------------------------------------------------
{
    const g = Autoroute.buildGrid(makeProject(), { gridSize: 0.25, boardEdgeClearance: 0.25 });
    assertCell(g, 0, 20, 1, 'T5: outermost column in inset blocked');  // center x=-4.875 < -4.75
    assertCell(g, 1, 20, 0, 'T5: next column FREE');                // center x=-4.625 >= -4.75
}

// ------------------------------------------------------------
// T6: rotated component body (gnd "TH TP" at origin, rotation 45°)
// 3x3 body → diamond with tips (0,±2.121), (±2.121,0).
// Cell (world 0.125,2.125) is 0.091mm from the rotated edge (blocked),
// but 0.625mm from an axis-aligned body — so only rotation handling blocks it.
// (Inflation is traceWidth/2 = 0.25, matching validateRoute's body rule.)
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: 0, y: 0, rotation: 45, sizeName: 'TH TP' });
    const c = Autoroute.createContext(p, { gridSize: 0.25 });
    Autoroute.buildObstacles(c);
    const g = c.grid;
    assertCell(g, 20, 28, 1, 'T6: cell in rotated body inflation band blocked (world 0.125,2.125)');
    assertCell(g, 20, 34, 0, 'T6: cell outside diamond free (world 0.125,3.625)');
}

// ------------------------------------------------------------
// T7: fine grid (gs 0.05 → 200x200) + via ring boundary
// pad at (2,2) r=1+0.63=1.63; via (-3,3) d=2 → same 1.63 block radius
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: 2, y: 2, sizeName: 'TH TP' });
    ProjectApi.addVia(p, { x: -3, y: 3, diameter: 2 });
    const c = Autoroute.createContext(p, { gridSize: 0.05 });
    Autoroute.buildObstacles(c);
    const g = c.grid;
    assert(g.cols === 200 && g.rows === 200, 'T7: gs 0.05 → 200x200 grid');
    assert(g.state.length === 40000, 'T7: state sized to fine grid');
    assertCell(g, 140, 140, 1, 'T7: pad cell blocked (world 2.025,2.025)');
    assertCell(g, 183, 140, 0, 'T7: just outside body expansion free (world 4.175,2.025)');
    // via boundary: block radius 1.63 from (-3,3)
    assertCell(g, 71, 160, 1, 'T7: via ring inside blocked (dist 1.575 < 1.63)');   // world -1.425,3.025
    assertCell(g, 74, 160, 0, 'T7: via ring outside free (dist 1.725 > 1.63)');      // world -1.275,3.025
}

// ------------------------------------------------------------
// T8: idempotency — rebuild on the same context never accumulates
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: 2, y: 2, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -2, y: -2 }, { x: 2, y: -2 }], net: 'VCC', width: 0.5 });
    const c = Autoroute.createContext(p);
    Autoroute.buildObstacles(c);
    const snapState = Array.from(c.grid.state);
    const snapParent = Array.from(c.grid.parent);
    Autoroute.buildObstacles(c); // second build on the same context
    let same = true;
    for (let i = 0; i < snapState.length; i++) if (c.grid.state[i] !== snapState[i]) { same = false; break; }
    assert(same, 'T8: state identical after rebuild (no accumulation)');
    let parentIntact = true;
    for (let i = 0; i < snapParent.length; i++) if (c.grid.parent[i] !== -1) { parentIntact = false; break; }
    assert(parentIntact, 'T8: parent untouched by obstacle build');
    assert(c.obstacleMap === c.grid.state, 'T8: obstacleMap is the shared state view');
}

// ------------------------------------------------------------
// T9: same-net geometry is never blocked (matrix SAME_NET_GEOMETRY)
// Resistor 0805 at origin: body 2.0x1.25, pin '1' @(-1,0), pin '2' @(1,0).
// Left pad ring sticks out beyond the body: cell(9,20) center (-2.625,0.125) is 0.525 from the pin-'1' pad edge (< expansion 0.63), outside the body.
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'resistor', x: 0, y: 0, size: 0 });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: 3, y: -3 }], net: 'VCC', width: 0.5 });
    // Stub touching pin '1' @(-1,0): under trace-derived membership this stub is
    // what puts pad '1' on net '1' — the pin name alone never does.
    ProjectApi.addTrace(p, { points: [{ x: -1, y: 0 }, { x: -3, y: 0 }], net: '1', width: 0.5 });

    // Baseline (no current net): pad ring and trace both blocked.
    const a = Autoroute.createContext(p, { gridSize: 0.25 });
    Autoroute.buildObstacles(a);
    assertCell(a.grid, 9, 20, 1, 'T9: baseline blocks pin-1 pad cell');
    assertCell(a.grid, 20, 7, 1, 'T9: baseline blocks VCC trace cell (world 0.125,-3.125)');

    // currentNet = 'VCC': the VCC trace is free; pads still blocked (pin '1'
    // belongs to net '1', not VCC).
    const b = Autoroute.createContext(p, { gridSize: 0.25 });
    b.currentNet = 'VCC';
    Autoroute.buildObstacles(b);
    assertCell(b.grid, 20, 7, 0, 'T9: same-net trace not blocked');
    assertCell(b.grid, 9, 20, 1, 'T9: other pad still blocked');

    // currentNet = '1': the pin-'1' pad is free (stub-derived membership); the VCC trace still blocked.
    const c = Autoroute.createContext(p, { gridSize: 0.25 });
    c.currentNet = '1';
    Autoroute.buildObstacles(c);
    assertCell(c.grid, 9, 20, 0, 'T9: same-net pad not blocked');
    assertCell(c.grid, 20, 7, 1, 'T9: other trace still blocked');
}

// ------------------------------------------------------------
// T10: FULLY_BLOCKED matrix row + byte-identical determinism
// ------------------------------------------------------------
{
    // A huge via covers the whole small board — build must not throw.
    const p = makeProject();
    p.board.width = 4;
    p.board.height = 4;
    ProjectApi.addVia(p, { x: 0, y: 0, diameter: 20 });
    const c = Autoroute.createContext(p, { gridSize: 0.5 });
    Autoroute.buildObstacles(c);
    let allBlocked = true;
    for (let i = 0; i < c.grid.state.length; i++) if (c.grid.state[i] === 0) { allBlocked = false; break; }
    assert(allBlocked, 'T10: fully blocked board has no free cells');

    // Two fresh builds on the same project+options are byte-identical.
    const p2 = makeProject();
    ProjectApi.addComponent(p2, { type: 'gnd', x: 2, y: 2, sizeName: 'TH TP' });
    const a = Autoroute.createContext(p2, { gridSize: 0.25 });
    const b = Autoroute.createContext(p2, { gridSize: 0.25 });
    Autoroute.buildObstacles(a);
    Autoroute.buildObstacles(b);
    let identical = true;
    for (let i = 0; i < a.grid.state.length; i++) if (a.grid.state[i] !== b.grid.state[i]) { identical = false; break; }
    assert(identical, 'T10: identical inputs -> byte-identical obstacle maps');
}

// ------------------------------------------------------------
// T11: EMPTY_BOARD matrix row — 100x80 mm @ default 0.1 grid
// ~800k cells in typed arrays; interior free, edge ring blocked.
// ------------------------------------------------------------
{
    const p = ProjectApi.createEmptyProject();
    p.board.width = 100;
    p.board.height = 80;
    const g = Autoroute.buildGrid(p);
    assert(g.cols === 1000 && g.rows === 800, 'T11: 100x80 @ 0.1 -> 1000x800 grid');
    assert(g.state.length === 800000, 'T11: ~800k cells in one Uint8Array');
    assert(g.state[400 * g.cols + 500] === 0, 'T11: board middle FREE on empty board');
    assert(g.state[0] === 1 && g.state[g.cols - 1] === 1, 'T11: edge ring blocked on empty board');
}

// ------------------------------------------------------------
// T12: OTHER_NET_TRACE matrix row — different-layer traces ignored
// ------------------------------------------------------------
{
    const p = makeProject();
    ProjectApi.addTrace(p, { points: [{ x: -2, y: -2 }, { x: 2, y: -2 }], net: 'VCC', width: 0.5, layer: 'bottom' });
    const c = Autoroute.createContext(p, { gridSize: 0.25 }); // routes top by default
    Autoroute.buildObstacles(c);
    assertCell(c.grid, 20, 11, 0, 'T12: bottom trace not blocked when routing top');

    const d = Autoroute.createContext(p, { gridSize: 0.25, layer: 'bottom' });
    Autoroute.buildObstacles(d);
    assertCell(d.grid, 20, 11, 1, 'T12: same trace blocked when routing bottom');
}

// ------------------------------------------------------------
// Story 1.2 — planNets (derived membership, deterministic priority)
// Fixtures: 'gnd' TH TP = single pad at the component's world position.
// ------------------------------------------------------------

// T13: EMPTY_PROJECT matrix row — no components/traces at all.
{
    const p = makeProject();
    const r = Autoroute.planNets(p);
    assert(Array.isArray(r.nets) && r.nets.length === 0, 'T13: empty project -> no nets');
    assert(r.excluded.length === 0, 'T13: empty project -> no excluded');
    assert(r.diagnostics.length === 0, 'T13: empty project -> no diagnostics');
}

// T14: NO_TRACES matrix row — two bare pads, nothing inferrable.
{
    const p = makeProject();
    const a = ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    const b = ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 0 && r.excluded.length === 0, 'T14: no traces -> nothing routable');
    assert(r.diagnostics.length === 2, 'T14: both bare pads diagnosed');
    assert(r.diagnostics[0].code === 'UNASSIGNED_PIN' && r.diagnostics[0].compId === a.id && r.diagnostics[0].pinIndex === 0, 'T14: first diagnostic = pad A pin 0 (component order)');
    assert(r.diagnostics[1].code === 'UNASSIGNED_PIN' && r.diagnostics[1].compId === b.id, 'T14: second diagnostic = pad B');
}

// T15: SINGLE_MEMBER_STUB matrix row — one pad + stub on a net.
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: 0, y: -3 }], net: 'NET_9' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 0, 'T15: single-member net not routable');
    assert(r.excluded.length === 1 && r.excluded[0].name === 'NET_9' && r.excluded[0].memberCount === 1 && r.excluded[0].reason === 'SINGLE_MEMBER', 'T15: excluded as SINGLE_MEMBER');
}

// T16: ALREADY_CONNECTED_2PIN matrix row — connectPins joins both pads.
{
    const p = makeProject();
    const a = ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    const b = ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    const t = ProjectApi.connectPins(p, { compId: a.id, pin: 0 }, { compId: b.id, pin: 0 });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 0 && r.diagnostics.length === 0, 'T16: connected net -> no nets/diagnostics');
    assert(r.excluded.length === 1 && r.excluded[0].name === t.net && r.excluded[0].memberCount === 2 && r.excluded[0].reason === 'ALREADY_CONNECTED', 'T16: excluded as ALREADY_CONNECTED with memberCount 2');
}

// T17: DISJOINT_2PIN matrix row — two stubs, same net, no connection.
// A(-3,-3) stub to (-1,-3); B(3,3) stub to (1,3). Target dist = hypot(4,6).
{
    const p = makeProject();
    const a = ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    const b = ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: -1, y: -3 }], net: 'NET_5' });
    ProjectApi.addTrace(p, { points: [{ x: 3, y: 3 }, { x: 1, y: 3 }], net: 'NET_5' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 1 && r.excluded.length === 0 && r.diagnostics.length === 0, 'T17: one routable net');
    const n = r.nets[0];
    assert(n.name === 'NET_5' && n.memberCount === 2 && n.components === 2, 'T17: two members in two components');
    assert(n.members.length === 2 && n.members[0].compId === a.id && n.members[1].compId === b.id, 'T17: both pads are members (comp order)');
    assert(n.root.compId === a.id && n.root.pinIndex === 0, 'T17: root = lowest compId/pinIndex');
    assert(n.targets.length === 1 && n.targets[0].compId === b.id, 'T17: single target = pad B');
    assertClose(n.targets[0].dist, Math.hypot(4, 6), 1e-9, 'T17: target dist to root stub end (-1,-3)');
}

// T18: TRACE_JOIN_CHAIN matrix row — 0.1 mm gap < 0.15 joins the traces.
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: 0, y: -3 }], net: 'NET_7' });
    ProjectApi.addTrace(p, { points: [{ x: 0.1, y: -3 }, { x: 3, y: 3 }], net: 'NET_7' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 0 && r.excluded.length === 1 && r.excluded[0].name === 'NET_7' && r.excluded[0].reason === 'ALREADY_CONNECTED', 'T18: 0.1mm trace gap joins components -> ALREADY_CONNECTED');
}

// T19: TRACE_GAP_0_2 matrix row — 0.2 mm gap >= 0.15 keeps two components.
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: 0, y: -3 }], net: 'NET_8' });
    ProjectApi.addTrace(p, { points: [{ x: 0.2, y: -3 }, { x: 3, y: 3 }], net: 'NET_8' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 1 && r.nets[0].components === 2, 'T19: 0.2mm gap keeps two components');
    assertClose(r.nets[0].targets[0].dist, Math.hypot(3, 6), 1e-9, 'T19: target dist to root stub end (0,-3)');
}

// T20: MULTI_PIN_PARTIAL matrix row — 4 members, AB already joined, C/D not.
// Targets ordered by distance to root-component geometry (6 < 7).
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: -3, sizeName: 'TH TP' });
    const c = ProjectApi.addComponent(p, { type: 'gnd', x: 0, y: 3, sizeName: 'TH TP' });
    const d = ProjectApi.addComponent(p, { type: 'gnd', x: 0, y: 4, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: 3, y: -3 }], net: 'NET_8' });
    ProjectApi.addTrace(p, { points: [{ x: 0, y: 2 }, { x: 0, y: 3 }], net: 'NET_8' });
    ProjectApi.addTrace(p, { points: [{ x: 0, y: 3.3 }, { x: 0, y: 4 }], net: 'NET_8' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 1 && r.nets[0].memberCount === 4 && r.nets[0].components === 3, 'T20: 4 members in 3 components');
    assert(r.nets[0].targets.length === 2, 'T20: two targets outside root component');
    assert(r.nets[0].targets[0].compId === c.id && r.nets[0].targets[1].compId === d.id, 'T20: targets ordered by distance (6 < 7)');
    assertClose(r.nets[0].targets[0].dist, 6, 1e-9, 'T20: C dist to AB trace');
    assertClose(r.nets[0].targets[1].dist, 7, 1e-9, 'T20: D dist to AB trace');
}

// T21: UNASSIGNED_MIXED matrix row — routable net + one bare pad.
{
    const p = makeProject();
    ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    const c = ProjectApi.addComponent(p, { type: 'gnd', x: 0, y: 0, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: -1, y: -3 }], net: 'NET_5' });
    ProjectApi.addTrace(p, { points: [{ x: 3, y: 3 }, { x: 1, y: 3 }], net: 'NET_5' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 1 && r.nets[0].name === 'NET_5', 'T21: routable net planned');
    assert(r.diagnostics.length === 1 && r.diagnostics[0].code === 'UNASSIGNED_PIN' && r.diagnostics[0].compId === c.id, 'T21: bare pad diagnosed, not routed');
}

// T22: ORDERING_PRIORITY matrix row — count DESC, then span DESC, then name.
// NET_3: 3 members (span 2). NET_2: 2 members (span sqrt(17)~4.12).
// NET_10: 2 members (span 1.5). Lexicographic-only would give NET_10 first — trap.
{
    const p = makeProject();
    for (const [x, y] of [[-4, -4], [-4, -3], [-4, -2]]) ProjectApi.addComponent(p, { type: 'gnd', x, y, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -4, y: -4 }, { x: -4.8, y: -4 }], net: 'NET_3' });
    ProjectApi.addTrace(p, { points: [{ x: -4, y: -3 }, { x: -4.8, y: -3 }], net: 'NET_3' });
    ProjectApi.addTrace(p, { points: [{ x: -4, y: -2 }, { x: -4.8, y: -2 }], net: 'NET_3' });
    ProjectApi.addComponent(p, { type: 'gnd', x: -4, y: 3, sizeName: 'TH TP' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 0, y: 4, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: -4, y: 3 }, { x: -4.8, y: 3 }], net: 'NET_2' });
    ProjectApi.addTrace(p, { points: [{ x: 0, y: 4 }, { x: 0.8, y: 4 }], net: 'NET_2' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: -4, sizeName: 'TH TP' });
    ProjectApi.addComponent(p, { type: 'gnd', x: 4.5, y: -4, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: 3, y: -4 }, { x: 3.6, y: -4 }], net: 'NET_10' });
    ProjectApi.addTrace(p, { points: [{ x: 4.5, y: -4 }, { x: 3.9, y: -4 }], net: 'NET_10' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 3 && r.excluded.length === 0, 'T22: three routable nets');
    assert(r.nets[0].name === 'NET_3' && r.nets[0].memberCount === 3, 'T22: member count DESC first (NET_3)');
    assert(r.nets[1].name === 'NET_2', 'T22: span DESC beats lexicographic name (NET_2 before NET_10)');
    assert(r.nets[2].name === 'NET_10', 'T22: smallest span last');
}

// T23: ROOT_SELECTION matrix row — root is min (compId, pinIndex), not geometry.
{
    const p = makeProject();
    const first = ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
    const second = ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
    ProjectApi.addTrace(p, { points: [{ x: 3, y: 3 }, { x: 1, y: 3 }], net: 'NET_6' });
    ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: -1, y: -3 }], net: 'NET_6' });
    const r = Autoroute.planNets(p);
    assert(r.nets.length === 1, 'T23: routable');
    assert(r.nets[0].root.compId === first.id, 'T23: root = lowest compId regardless of position');
    assert(r.nets[0].targets[0].compId === second.id, 'T23: target = the other pad');
    assertClose(r.nets[0].targets[0].dist, Math.hypot(4, 6), 1e-9, 'T23: dist to root stub end (1,3)');
}

// T24: DETERMINISM + non-mutation — identical inputs give identical output;
// the project object is untouched.
{
    const build = () => {
        const p = makeProject();
        ProjectApi.addComponent(p, { type: 'gnd', x: -3, y: -3, sizeName: 'TH TP' });
        ProjectApi.addComponent(p, { type: 'gnd', x: 3, y: 3, sizeName: 'TH TP' });
        ProjectApi.addComponent(p, { type: 'gnd', x: 0, y: 0, sizeName: 'TH TP' });
        ProjectApi.addTrace(p, { points: [{ x: -3, y: -3 }, { x: -1, y: -3 }], net: 'NET_5' });
        ProjectApi.addTrace(p, { points: [{ x: 3, y: 3 }, { x: 1, y: 3 }], net: 'NET_5' });
        return p;
    };
    const r1 = Autoroute.planNets(build());
    const r2 = Autoroute.planNets(build());
    assert(JSON.stringify(r1) === JSON.stringify(r2), 'T24: identical inputs -> identical output');
    const p3 = build();
    const before = JSON.stringify(p3);
    Autoroute.planNets(p3);
    assert(JSON.stringify(p3) === before, 'T24: planNets does not mutate the project');
}

// ============================================================
// Story 1.3 — A* findPath on the grid (HV+45)
// Grids: 10x10 mm @ gs 0.25 (40x40); boardEdgeClearance 0.1 keeps every
// boundary cell free, so tests write obstacles straight into g.state.
// ============================================================
function pc(g, ix, iy) { // exact cell-center point (world mm)
    return { x: (ix + 0.5) * g.gridSize - g.width / 2, y: (iy + 0.5) * g.gridSize - g.height / 2 };
}
function openGrid(gs) {
    return Autoroute.buildGrid(makeProject(), { gridSize: gs, boardEdgeClearance: 0.1 });
}

// Shared validity check: legal 8-neighbor steps (no corner cutting), every
// cell free, endpoints at start/goal cell centers, cost identity holds.
function assertPathValid(g, res, sx, sy, ex, ey, penalty, tag) {
    const pts = res.points, gs = g.gridSize;
    const cx = i => Math.round((pts[i].x + g.width / 2) / gs - 0.5);
    const cy = i => Math.round((pts[i].y + g.height / 2) / gs - 0.5);
    assert(pts.length >= 2, `${tag}: has points`);
    assertClose(pts[0].x, pc(g, Math.floor((sx + g.width / 2) / gs), Math.floor((sy + g.height / 2) / gs)).x, 1e-9, `${tag}: first point x = start cell center`);
    assertClose(pts[0].y, pc(g, Math.floor((sx + g.width / 2) / gs), Math.floor((sy + g.height / 2) / gs)).y, 1e-9, `${tag}: first point y = start cell center`);
    assertClose(pts[pts.length - 1].x, pc(g, Math.floor((ex + g.width / 2) / gs), Math.floor((ey + g.height / 2) / gs)).x, 1e-9, `${tag}: last point x = goal cell center`);
    assertClose(pts[pts.length - 1].y, pc(g, Math.floor((ex + g.width / 2) / gs), Math.floor((ey + g.height / 2) / gs)).y, 1e-9, `${tag}: last point y = goal cell center`);
    let len = 0;
    for (let i = 0; i < pts.length; i++) {
        const ix = cx(i), iy = cy(i);
        assert(ix >= 0 && iy >= 0 && ix < g.cols && iy < g.rows, `${tag}: point ${i} in bounds`);
        assert(g.state[iy * g.cols + ix] === 0, `${tag}: point ${i} cell free`);
        if (i > 0) {
            const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
            const adx = Math.abs(dx), ady = Math.abs(dy), diag = adx > 1e-9 && ady > 1e-9;
            assert((Math.abs(adx - gs) < 1e-9 && ady < 1e-9) || (adx < 1e-9 && Math.abs(ady - gs) < 1e-9) ||
                   (diag && Math.abs(adx - gs) < 1e-9 && Math.abs(ady - gs) < 1e-9), `${tag}: step ${i} is a legal 8-neighbor move`);
            if (diag) { // no corner cutting: both orthogonal neighbors free
                assert(g.state[cy(i) * g.cols + cx(i - 1)] === 0 && g.state[cy(i - 1) * g.cols + cx(i)] === 0,
                    `${tag}: diagonal step ${i} does not cut a corner`);
            }
            len += Math.hypot(dx, dy);
        }
    }
    assertClose(res.cost, len + res.bends * penalty, 1e-3, `${tag}: cost = length + bends*penalty (len ${len.toFixed(4)}, bends ${res.bends})`);
}

// T25: STRAIGHT_H — open grid, same row: collinear H path, exact cost, 0 bends.
{
    const g = openGrid(0.25), s = pc(g, 10, 20), e = pc(g, 30, 20);
    const r = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    assert(r !== null, 'T25: path found');
    assert(r.points.length === 21, `T25: one point per cell (got ${r ? r.points.length : 'null'})`);
    let colinear = true;
    for (const p of r.points) if (Math.abs(p.y - s.y) > 1e-9) colinear = false;
    assert(colinear, 'T25: all points on the start row');
    assert(r.bends === 0, 'T25: zero bends');
    assertClose(r.cost, 5.0, 1e-6, 'T25: cost = direct length');
    assertPathValid(g, r, s.x, s.y, e.x, e.y, Autoroute.BEND_PENALTY, 'T25');
}

// T26: NO_PATH_WALL — full-height column wall separates the endpoints.
{
    const g = openGrid(0.25);
    for (let iy = 0; iy < g.rows; iy++) g.state[iy * g.cols + 20] = 1;
    const s = pc(g, 10, 20), e = pc(g, 30, 20);
    assert(Autoroute.findPath(g, s.x, s.y, e.x, e.y) === null, 'T26: wall -> no path');
}

// T27: BLOCKED_ENDPOINT — start or goal cell blocked -> null (no partial).
{
    const g1 = openGrid(0.25);
    g1.state[20 * g1.cols + 15] = 1;
    const s = pc(g1, 15, 20), e = pc(g1, 25, 20);
    assert(Autoroute.findPath(g1, s.x, s.y, e.x, e.y) === null, 'T27: blocked start -> null');
    const g2 = openGrid(0.25);
    g2.state[20 * g2.cols + 25] = 1;
    assert(Autoroute.findPath(g2, s.x, s.y, e.x, e.y) === null, 'T27: blocked goal -> null');
}

// T28: OUT_OF_RANGE — endpoint outside the board extent -> null.
{
    const g = openGrid(0.25), e = pc(g, 25, 20);
    assert(Autoroute.findPath(g, -6, 0, e.x, e.y) === null, 'T28: start out of range -> null');
    assert(Autoroute.findPath(g, 0, 0, 5.4, 0) === null, 'T28: goal out of range -> null');
}

// T29: SAME_CELL — both endpoints in one cell -> single point at exact start.
{
    const g = openGrid(0.25), c = pc(g, 15, 20);
    const r = Autoroute.findPath(g, c.x, c.y, c.x, c.y);
    assert(r && r.points.length === 1, 'T29: single point');
    assertClose(r.points[0].x, c.x, 1e-12, 'T29: exact start x');
    assertClose(r.points[0].y, c.y, 1e-12, 'T29: exact start y');
    assert(r.cost === 0 && r.bends === 0, 'T29: cost 0, bends 0');
    const s = { x: c.x + 0.03, y: c.y - 0.02 }, e = { x: c.x + 0.05, y: c.y + 0.04 };
    const r2 = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    assert(r2 && r2.points.length === 1, 'T29: off-center same cell -> single point');
    assertClose(r2.points[0].x, s.x, 1e-12, 'T29: off-center exact start x');
    assertClose(r2.points[0].y, s.y, 1e-12, 'T29: off-center exact start y');
}

// T30: DETOUR_MITRED — single blocked cell on the direct line. Optimum is a
// one-row miter with zero >=90-degree turns; cost identity holds.
{
    const g = openGrid(0.25);
    g.state[20 * g.cols + 15] = 1;
    const s = pc(g, 10, 20), e = pc(g, 20, 20);
    const r = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    assert(r !== null, 'T30: detour found');
    let avoids = true;
    for (const p of r.points) {
        const ix = Math.round((p.x + g.width / 2) / g.gridSize - 0.5), iy = Math.round((p.y + g.height / 2) / g.gridSize - 0.5);
        if (ix === 15 && iy === 20) avoids = false;
    }
    assert(avoids, 'T30: blocked cell not on path');
    assert(r.bends === 0, `T30: mitered detour has no >=90-degree turn (got ${r.bends})`);
    assertClose(r.cost, 8 * g.gridSize + 2 * Math.SQRT2 * g.gridSize, 1e-4, 'T30: optimal miter cost');
    assertPathValid(g, r, s.x, s.y, e.x, e.y, Autoroute.BEND_PENALTY, 'T30');
}

// T31: DIAGONAL_RUN — open field, 45-degree offset goal: straight diagonal.
{
    const g = openGrid(0.25), s = pc(g, 10, 20), e = pc(g, 20, 10);
    const r = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    assert(r !== null, 'T31: path found');
    assert(r.points.length === 11, `T31: 11 cell centers (got ${r ? r.points.length : 'null'})`);
    let allDiag = true;
    for (let i = 1; i < r.points.length; i++) {
        if (Math.abs(Math.abs(r.points[i].x - r.points[i - 1].x) - g.gridSize) > 1e-9 ||
            Math.abs(Math.abs(r.points[i].y - r.points[i - 1].y) - g.gridSize) > 1e-9) allDiag = false;
    }
    assert(allDiag, 'T31: every step is diagonal');
    assert(r.bends === 0, 'T31: zero bends');
    assertClose(r.cost, 10 * Math.SQRT2 * g.gridSize, 1e-5, 'T31: cost = sqrt(2)*n*gs');
    assertPathValid(g, r, s.x, s.y, e.x, e.y, Autoroute.BEND_PENALTY, 'T31');
}

// T32: BEND_COUNTING — S-shaped 1-cell corridor forces two >=90-degree turns;
// miters are geometrically impossible. Cost identity at P=0 and P=5.
{
    const g = openGrid(0.25);
    for (let iy = 0; iy < g.rows; iy++) for (let ix = 0; ix < g.cols; ix++) {
        const free = (iy === 20 && ix >= 10 && ix <= 30) || (ix === 30 && iy >= 20 && iy <= 28) || (iy === 28 && ix >= 20 && ix <= 30);
        g.state[iy * g.cols + ix] = free ? 0 : 1;
    }
    const s = pc(g, 10, 20), e = pc(g, 20, 28);
    const r0 = Autoroute.findPath(g, s.x, s.y, e.x, e.y, { bendPenalty: 0 });
    assert(r0 !== null, 'T32: corridor routable');
    assert(r0.bends === 2, `T32: two >=90-degree turns (got ${r0 ? r0.bends : 'null'})`);
    assertClose(r0.cost, 38 * g.gridSize, 1e-6, 'T32: cost(P=0) = length');
    const r5 = Autoroute.findPath(g, s.x, s.y, e.x, e.y, { bendPenalty: 5 });
    assertClose(r5.cost, 38 * g.gridSize + 10, 1e-6, 'T32: cost(P=5) = length + 5*bends');
    assertPathValid(g, r0, s.x, s.y, e.x, e.y, 0, 'T32-P0');
    assertPathValid(g, r5, s.x, s.y, e.x, e.y, 5, 'T32-P5');
}

// T33: NO_CORNER_CUTTING — rows meet only at a diagonal gap between two
// blocked cells -> null; unblocking one cell makes it routable (positive).
{
    const g = openGrid(0.25);
    for (let iy = 0; iy < g.rows; iy++) for (let ix = 0; ix < g.cols; ix++) {
        const free = (iy === 20 && ix >= 10 && ix <= 14) || (iy === 21 && ix >= 15 && ix <= 30);
        g.state[iy * g.cols + ix] = free ? 0 : 1;
    }
    const s = pc(g, 10, 20), e = pc(g, 30, 21);
    assert(Autoroute.findPath(g, s.x, s.y, e.x, e.y) === null, 'T33: diagonal gap only -> no path');
    g.state[20 * g.cols + 15] = 0; // unblock one of the two orthogonal cells
    const r = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    assert(r !== null, 'T33: positive control — routable once a cell opens');
    assertPathValid(g, r, s.x, s.y, e.x, e.y, Autoroute.BEND_PENALTY, 'T33');
}

// T34: DETERMINISM — obstacle-scattered grid, two runs byte-identical.
{
    const g = openGrid(0.25);
    for (let iy = 0; iy < g.rows; iy++) for (let ix = 0; ix < g.cols; ix++)
        if ((ix * 7 + iy * 13) % 9 === 0) g.state[iy * g.cols + ix] = 1;
    g.state[5 * g.cols + 5] = 0; // guarantee endpoints free
    g.state[35 * g.cols + 35] = 0;
    const s = pc(g, 5, 5), e = pc(g, 35, 35);
    const r1 = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    const r2 = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    assert(r1 !== null, 'T34: scattered grid routable');
    assert(JSON.stringify(r1) === JSON.stringify(r2), 'T34: two runs byte-identical');
}

// T35: PERF_LARGE — 100x80 mm @ 0.1 mm (~800k cells), route across the board.
{
    const p = makeProject();
    p.board.width = 100;
    p.board.height = 80;
    const g = Autoroute.buildGrid(p, { gridSize: 0.1, boardEdgeClearance: 0.1 });
    assert(g.cols === 1000 && g.rows === 800, 'T35: grid shape 1000x800');
    const s = pc(g, 2, 400), e = pc(g, 997, 400);
    const t0 = Date.now();
    const r = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
    const ms = Date.now() - t0;
    assert(r !== null, 'T35: path found');
    assert(ms < 5000, `T35: within 5 s bound (took ${ms} ms)`);
    assert(r.bends === 0, 'T35: straight run across open field');
    assertClose(r.cost, 99.5, 1e-2, 'T35: cost ~ direct length');
}

// ============================================================
// Story 1.4 — simplifyPath + validateRoute (T36-T47)
// ============================================================

// T36: STRAIGHT — collinear cell centers collapse to the two endpoints.
{
    const raw = [];
    for (let i = 0; i < 11; i++) raw.push({ x: i, y: 0 });
    const rawBefore = JSON.stringify(raw);
    const sp = Autoroute.simplifyPath(raw);
    assert(sp.length === 2, 'T36: straight run collapses to 2 points');
    assertClose(sp[0].x, 0, 1e-9, 'T36: start preserved');
    assertClose(sp[1].x, 10, 1e-9, 'T36: end preserved');
    assert(JSON.stringify(raw) === rawBefore, 'T36: input coordinates untouched');
}

// T37: MITER — equal-leg 90 deg corner becomes a 45 deg diagonal only when the
// validation predicate approves; no predicate or unequal legs stay square.
{
    const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 2, y: -1 }];
    let sp = Autoroute.simplifyPath(sq, { validateSegment: function () { return true; } });
    assert(sp.length === 3, 'T37: miter applied with approving predicate');
    assertClose(sp[1].x, 1, 1e-9, 'T37: diagonal corner x');
    assertClose(sp[1].y, -1, 1e-9, 'T37: diagonal corner y');
    sp = Autoroute.simplifyPath(sq);
    assert(sp.length === 4, 'T37: no miter without predicate');
    sp = Autoroute.simplifyPath(sq, { validateSegment: function () { return false; } });
    assert(sp.length === 4, 'T37: rejecting predicate keeps the square corner');
    assertClose(sp[1].x, 1, 1e-9, 'T37: rejected miter — corner x preserved');
    assertClose(sp[1].y, 0, 1e-9, 'T37: rejected miter — corner y preserved');
    const un = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: -1 }];
    sp = Autoroute.simplifyPath(un, { validateSegment: function () { return true; } });
    assert(sp.length === 3, 'T37: unequal legs never mitered');
}

// T38: DETERMINISM + ANGLE SET — mixed path, two runs byte-identical, every
// output segment H/V/45.
{
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 2 }];
    const r1 = Autoroute.simplifyPath(pts, { validateSegment: function () { return true; } });
    const r2 = Autoroute.simplifyPath(pts, { validateSegment: function () { return true; } });
    assert(JSON.stringify(r1) === JSON.stringify(r2), 'T38: deterministic');
    assert(r1.length === 3, 'T38: collinear + miter collapse');
    const angOk = ps => {
        for (let i = 0; i + 1 < ps.length; i++) {
            const dx = Math.abs(ps[i + 1].x - ps[i].x), dy = Math.abs(ps[i + 1].y - ps[i].y);
            if (dx > 1e-9 && dy > 1e-9 && Math.abs(dx - dy) > 1e-6 * Math.max(dx, dy)) return false;
        }
        return true;
    };
    assert(angOk(r1), 'T38: output angles in {0,45,90}');
}

// T39: CLEAN ROUTE — valid geometry, inside board, far from other copper.
{
    const p = makeProject();
    p.traces.push({ id: 69, net: 'VCC', layer: 'top', width: 0.5, points: [{ x: -3, y: -4 }, { x: 3, y: -4 }] });
    const c = Autoroute.createContext(p);
    const v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === true, 'T39: clean route passes');
    assert(Array.isArray(v.diagnostics) && v.diagnostics.length === 0, 'T39: no diagnostics');
}

// T40: BOARD BOUNDARY — outside the edge inset fails, inside passes.
{
    const c = Autoroute.createContext(makeProject());
    let v = Autoroute.validateRoute(c, [{ x: -4.6, y: 0 }, { x: 4.6, y: 0 }], null);
    assert(v.ok === true, 'T40: inside edge inset ok');
    v = Autoroute.validateRoute(c, [{ x: -4.6, y: 0 }, { x: 4.9, y: 0 }], null);
    assert(v.ok === false && v.reason === 'BOARD_BOUNDARY', 'T40: outside edge inset fails');
}

// T41: INVALID GEOMETRY — self-intersection, non-HV45 angle, single point,
// consecutive duplicate; plus the minTraceWidth floor.
{
    const c = Autoroute.createContext(makeProject());
    let v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 0, y: -2 }], null);
    assert(v.ok === false && v.reason === 'INVALID_GEOMETRY', 'T41: self-intersection');
    v = Autoroute.validateRoute(c, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0.5 }], null);
    assert(v.ok === false && v.reason === 'INVALID_GEOMETRY', 'T41: non-HV45 angle');
    v = Autoroute.validateRoute(c, [{ x: 0, y: 0 }], null);
    assert(v.ok === false && v.reason === 'INVALID_GEOMETRY', 'T41: single point');
    v = Autoroute.validateRoute(c, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }], null);
    assert(v.ok === false && v.reason === 'INVALID_GEOMETRY', 'T41: consecutive duplicate');
    v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }], null, { width: 0.3 });
    assert(v.ok === false && v.reason === 'INVALID_GEOMETRY', 'T41: width below minTraceWidth');
    v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: -2, y: 0 }], null);
    assert(v.ok === false && v.reason === 'INVALID_GEOMETRY', 'T41: fold-back [A,B,A] rejected');
}

// T42: CLEARANCE THRESHOLD — gap == minClearance passes, below fails.
{
    const p = makeProject();
    p.traces.push({ id: 70, net: 'VCC', layer: 'top', width: 0.5, points: [{ x: -3, y: -0.88 }, { x: 3, y: -0.88 }] });
    const c = Autoroute.createContext(p);
    let v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === true, 'T42: gap == minClearance passes');
    p.traces[0].points = [{ x: -3, y: -0.8 }, { x: 3, y: -0.8 }];
    v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === false && v.reason === 'CLEARANCE_VIOLATION', 'T42: gap < minClearance fails');
}

// T43: PADS + VIAS — same-net pad excluded (trace-derived membership), other-
// net pad and a nearby via violate; via at clearance passes.
{
    const p = makeProject();
    p.components.push({ id: 92, type: 'gnd', x: -2, y: 0 });
    // Stub touching the pin @(-2,0): this is what makes the pad same-net for a
    // GND route (pin name alone no longer excludes it).
    p.traces.push({ id: 91, net: 'GND', layer: 'top', width: 0.5, points: [{ x: -2, y: 0 }, { x: -4, y: 0 }] });
    const c = Autoroute.createContext(p);
    const route = [{ x: -2, y: 0 }, { x: 0, y: 0 }];
    let v = Autoroute.validateRoute(c, route, 'GND');
    assert(v.ok === true, 'T43: same-net pad excluded');
    v = Autoroute.validateRoute(c, route, 'VCC');
    assert(v.ok === false && v.reason === 'CLEARANCE_VIOLATION', 'T43: other-net pad violates');
    const p2 = makeProject();
    p2.vias.push({ id: 93, x: 0, y: -0.9, diameter: 1.2 });
    const c2 = Autoroute.createContext(p2);
    v = Autoroute.validateRoute(c2, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === false && v.reason === 'CLEARANCE_VIOLATION', 'T43: via below clearance fails');
    p2.vias[0].y = -1.5;
    v = Autoroute.validateRoute(c2, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === true, 'T43: via at clearance passes');
}

// T44: FR25 MILL-GAP WARNING — gap below export.millToolDia warns but passes.
{
    const p = makeProject();
    p.traces.push({ id: 71, net: 'VCC', layer: 'top', width: 0.5, points: [{ x: -3, y: -0.9 }, { x: 3, y: -0.9 }] });
    p.export = Object.assign({}, p.export, { millToolDia: 0.5 });
    const c = Autoroute.createContext(p);
    const route = [{ x: -2, y: 0 }, { x: 2, y: 0 }];
    let v = Autoroute.validateRoute(c, route, 'GND');
    assert(v.ok === true, 'T44: gap 0.4 >= clearance passes');
    assert(v.diagnostics.length === 1 && v.diagnostics[0].type === 'mill-gap', 'T44: mill-gap warning recorded');
    assertClose(v.diagnostics[0].gap, 0.4, 1e-6, 'T44: diagnostic gap value');
    p.export.millToolDia = 0.2;
    v = Autoroute.validateRoute(c, route, 'GND');
    assert(v.ok === true && v.diagnostics.length === 0, 'T44: no warning above tool dia');
}

// T45: END-TO-END — buildObstacles + findPath + simplifyPath + validateRoute.
{
    const p = makeProject();
    // Two gnd test points 6 mm apart with no stubs — no net membership; the
    // corridor between them stays free by geometry (pads far enough away).
    p.components.push({ id: 90, type: 'gnd', x: -3, y: 0 });
    p.components.push({ id: 91, type: 'gnd', x: 3, y: 0 });
    const c = Autoroute.createContext(p, { gridSize: 0.25 });
    Autoroute.buildObstacles(c);
    const r = Autoroute.findPath(c.grid, -0.7, 0, 0.7, 0);
    assert(r !== null, 'T45: path found in corridor between test points');
    assert(r.bends === 0, 'T45: straight corridor run');
    const vseg = (a, b) => Autoroute.validateRoute(c, [a, b], 'GND').ok;
    const sp = Autoroute.simplifyPath(r.points, { validateSegment: vseg });
    assert(sp.length === 2, 'T45: straight run collapses to endpoints');
    const v = Autoroute.validateRoute(c, sp, 'GND');
    assert(v.ok === true, 'T45: exact validation passes (pads clear of corridor)');
    assert(Array.isArray(v.diagnostics) && v.diagnostics.length === 0, 'T45: no diagnostics');
}

// T46: INPUT HYGIENE — non-array / empty / single-point inputs and null or
// non-finite entries are dropped without touching the input array.
{
    assert(Autoroute.simplifyPath(null).length === 0, 'T46: null input -> []');
    assert(Autoroute.simplifyPath(undefined).length === 0, 'T46: undefined input -> []');
    assert(Autoroute.simplifyPath({ x: 0, y: 0 }).length === 0, 'T46: non-array input -> []');
    assert(Autoroute.simplifyPath([]).length === 0, 'T46: empty array -> []');
    const one = [{ x: 3, y: -2 }];
    const s1 = Autoroute.simplifyPath(one);
    assert(s1.length === 1 && s1[0].x === 3 && s1[0].y === -2, 'T46: single point passes through');
    const dirty = [{ x: 0, y: 0 }, null, { x: NaN, y: 0 }, { x: 1, y: Infinity }, { x: 1, y: 0 }];
    const s2 = Autoroute.simplifyPath(dirty);
    assert(s2.length === 2 && s2[0].x === 0 && s2[0].y === 0 && s2[1].x === 1 && s2[1].y === 0, 'T46: null / non-finite entries dropped');
    assert(dirty.length === 5 && dirty[1] === null, 'T46: input untouched');
}

// T47: TRACE EXCLUSIONS — a same-net trace and an off-layer (bottom) trace at
// zero gap are not clearance-checked, mirroring buildObstacles' skip rules.
{
    const p = makeProject();
    p.traces.push({ id: 72, net: 'GND', layer: 'top', width: 0.5, points: [{ x: -2, y: 0 }, { x: 2, y: 0 }] });
    let c = Autoroute.createContext(p);
    let v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === true, 'T47: same-net trace excluded (ok)');
    assert(v.diagnostics.length === 0, 'T47: no diagnostics for excluded trace');
    const p2 = makeProject();
    p2.traces.push({ id: 73, net: 'VCC', layer: 'bottom', width: 0.5, points: [{ x: -2, y: 0 }, { x: 2, y: 0 }] });
    c = Autoroute.createContext(p2);
    v = Autoroute.validateRoute(c, [{ x: -2, y: 0 }, { x: 2, y: 0 }], 'GND');
    assert(v.ok === true, 'T47: bottom-layer trace excluded (ok)');
}

// T48: SMD BODY CLEARANCE — a route must not cut a surface-mount body
// (Story 1.4 review fix, Option A). TH bodies are exempt; the component the
// route departs from is excluded. SOIC-8 = type 'ic' size 13 (body 4.9 x 3.9,
// pins on the side edges at x = +/-2.45).
{
    const p = makeProject();
    p.components.push({ id: 93, type: 'ic', size: 13, x: 0, y: 0 });
    const c = Autoroute.createContext(p);
    // (a) Edge crossing — vertical run enters through the bottom edge and exits
    // through the top edge at x = -0.5; side-edge pads keep >= 0.5 mm clearance,
    // so only the new body check can reject it.
    let v = Autoroute.validateRoute(c, [{ x: -0.5, y: -3 }, { x: -0.5, y: 3 }], 'VCC');
    assert(v.ok === false && v.reason === 'BODY_OVERLAP', 'T48a: SMD body edge crossing rejected (BODY_OVERLAP)');
    // (b) Pure interior — segment lies fully inside the body between pin rows;
    // every pad is farther than clearance, so the interior test must fire.
    v = Autoroute.validateRoute(c, [{ x: -0.5, y: 1.5 }, { x: 0.5, y: 1.5 }], 'VCC');
    assert(v.ok === false && v.reason === 'BODY_OVERLAP', 'T48b: route inside SMD body interior rejected (BODY_OVERLAP)');
    // (c) TH exemption — the same kind of crossing over a through-hole LED body passes.
    const p2 = makeProject();
    p2.components.push({ id: 94, type: 'led', size: 0, x: 0, y: 0 }); // 5mm Red, th: true
    const c2 = Autoroute.createContext(p2);
    v = Autoroute.validateRoute(c2, [{ x: -2.5, y: 1.2 }, { x: 0.5, y: 4.2 }], 'VCC');
    assert(v.ok === true, 'T48c: TH component body exempt (ok)');
    // (d) Endpoint exclusion — route departing an SMD pin of its own component
    // (pin trace-connected, so pad membership is trace-derived, not by name).
    const p3 = makeProject();
    p3.components.push({ id: 95, type: 'led', size: 6, x: 0, y: 0 }); // 0805, pin A at (-1, 0)
    p3.traces.push({ id: 96, net: 'A', layer: 'top', width: 0.5, points: [{ x: -1, y: 0 }, { x: -2.5, y: 0 }] });
    const c3 = Autoroute.createContext(p3);
    v = Autoroute.validateRoute(c3, [{ x: -1, y: 0 }, { x: -3, y: 0 }], 'A');
    assert(v.ok === true, 'T48d: route departing its own SMD pin excluded (ok)');
}

// ------------------------------------------------------------
// T49-T56: ROUTE() PIPELINE (Story 1.5) — planNets -> findPath -> simplify ->
// validateRoute -> commit, with diagnostics, progress and cancel. Fixtures use
// gnd test points whose pin is named 'GND' while stub traces carry explicit net
// names: membership must come from traces (getPinNet), never pin names.
// ------------------------------------------------------------
function gndPad(id, x, y) { return { id: id, type: 'gnd', x: x, y: y, pins: [{ name: 'GND', x: 0, y: 0 }] }; }
// Through-hole test point (size 1 = 'TH TP'): no SMD body, so validateRoute's
// BODY_OVERLAP check never applies — these fixtures test routing geometry,
// not surface-mount clearance.
function thGndPad(id, x, y) { const c = gndPad(id, x, y); c.size = 1; return c; }
function stubTrace(a, b, net) { return { points: [a, b], net: net, width: 0.5, layer: 'top' }; }

// T49: pin name != net — trace-derived membership lets route() connect two pads.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3));
    p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
    p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
    const r = Autoroute.route(p, {});
    assert(r.success === true && JSON.stringify(r.routedNets) === '["NET_5"]', 'T49: pin-name/net mismatch routes via trace-derived membership');
    assert(p.traces.length === 3, 'T49: one committed trace added');
    const t = p.traces[2];
    assert(t.net === 'NET_5' && t.points.length >= 2, 'T49: committed trace on NET_5 with points');
    assertClose(t.width, 0.5, 1e-9, 'T49: committed trace width = rules.traceWidth');
    assert(t.layer === 'top', 'T49: committed trace layer = rules.layer');
    assertClose(t.points[0].x, -1, 1e-6, 'T49: starts at stub free end (-1,-3) x');
    assertClose(t.points[0].y, -3, 1e-6, 'T49: starts at stub free end (-1,-3) y');
    assertClose(t.points[t.points.length - 1].x, 1, 1e-6, 'T49: ends at stub free end (1,3) x');
    assertClose(t.points[t.points.length - 1].y, 3, 1e-6, 'T49: ends at stub free end (1,3) y');
}

// T50: star topology — root plus two targets; one committed trace per target,
// nearer target (shorter distance to the root stub) routes first.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, 0, 0), gndPad(2, 4, -2), gndPad(3, 5, 3));
    p.traces.push(stubTrace({ x: 0, y: 0 }, { x: 2, y: 0 }, 'N1'));
    p.traces.push(stubTrace({ x: 4, y: -2 }, { x: 4, y: 0 }, 'N1'));
    p.traces.push(stubTrace({ x: 5, y: 3 }, { x: 5, y: 1 }, 'N1'));
    const r = Autoroute.route(p, {});
    assert(r.success === true && JSON.stringify(r.routedNets) === '["N1"]', 'T50: star net routed');
    assert(p.traces.length === 5, 'T50: one committed trace per target');
    const tB = p.traces[3];
    assert(tB.points.length === 2 && tB.points[1].x === 4 && tB.points[1].y === 0, 'T50: nearer target gets straight run to its stub free end');
    const tC = p.traces[4];
    assertClose(tC.points[tC.points.length - 1].x, 5, 1e-6, 'T50: second route ends at C stub free end x');
    assertClose(tC.points[tC.points.length - 1].y, 1, 1e-6, 'T50: second route ends at C stub free end y');
}

// T51: NO_PATH — full-height other-net barrier blocks the only corridor; net
// fails with a NO_PATH diagnostic and nothing is committed.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -4, -3), gndPad(2, 4, 0));
    p.traces.push(stubTrace({ x: -4, y: -3 }, { x: -2, y: -3 }, 'N1'));
    p.traces.push(stubTrace({ x: 4, y: 0 }, { x: 2.5, y: 0 }, 'N1'));
    p.traces.push({ points: [{ x: 1, y: -15 }, { x: 1, y: 15 }], net: 'BLK', width: 0.5, layer: 'top' });
    const r = Autoroute.route(p, {});
    assert(r.success === false && r.routedNets.length === 0, 'T51: blocked net fails');
    assert(r.failedNets.length === 1 && r.failedNets[0].net === 'N1' && r.failedNets[0].reason === 'NO_PATH', 'T51: failure reason NO_PATH');
    assert(r.diagnostics.some(d => d.code === 'NO_PATH' && d.net === 'N1'), 'T51: NO_PATH diagnostic recorded (reason in both arrays)');
    assert(p.traces.length === 3, 'T51: nothing committed on failure');
}

// T52: via obstacle — route detours around an unrelated via in the corridor.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -4, 0), gndPad(2, 4, 0));
    p.traces.push(stubTrace({ x: -4, y: 0 }, { x: -2, y: 0 }, 'NET_5'));
    p.traces.push(stubTrace({ x: 4, y: 0 }, { x: 2, y: 0 }, 'NET_5'));
    p.vias.push({ id: 9, x: 0, y: 0, diameter: 1.2 });
    const r = Autoroute.route(p, {});
    assert(r.success === true && JSON.stringify(r.routedNets) === '["NET_5"]', 'T52: detour around via succeeds');
    assert(p.traces.length === 3, 'T52: committed trace added');
}

// T53: board edge — pads near the edge inset still route from interior free ends.
{
    const p = makeProject();
    p.board.width = 12; p.board.height = 8;
    p.components.push(gndPad(1, -4.5, -3), gndPad(2, 4.5, 3));
    p.traces.push(stubTrace({ x: -4.5, y: -3 }, { x: -2.5, y: -3 }, 'NET_5'));
    p.traces.push(stubTrace({ x: 4.5, y: 3 }, { x: 2.5, y: 3 }, 'NET_5'));
    const r = Autoroute.route(p, {});
    assert(r.success === true && JSON.stringify(r.routedNets) === '["NET_5"]', 'T53: edge-adjacent pads route');
}

// T54: determinism — identical fresh projects give byte-identical results.
{
    const mk = () => {
        const p = makeProject();
        p.board.width = 20; p.board.height = 20;
        p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3));
        p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
        p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
        return p;
    };
    const p1 = mk(), p2 = mk();
    const r1 = Autoroute.route(p1, {});
    const r2 = Autoroute.route(p2, {});
    assert(JSON.stringify(r1) === JSON.stringify(r2), 'T54: route() deterministic across fresh projects');
    assert(JSON.stringify(p1.traces) === JSON.stringify(p2.traces), 'T54: committed trace sets identical (AC5)');
}

// T55: progress + cancel — one onProgress event per net; shouldCancel stops the
// loop and records a CANCELED diagnostic. Net order is span DESC (NET_6 first).
{
    const mk = () => {
        const p = makeProject();
        p.board.width = 20; p.board.height = 20;
        p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3), gndPad(3, -8, 8), gndPad(4, 8, 8));
        p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
        p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
        p.traces.push(stubTrace({ x: -8, y: 8 }, { x: -6, y: 8 }, 'NET_6'));
        p.traces.push(stubTrace({ x: 8, y: 8 }, { x: 6, y: 8 }, 'NET_6'));
        return p;
    };
    const evs = [];
    const r = Autoroute.route(mk(), { onProgress: e => evs.push(e) });
    assert(r.success === true && r.routedNets.length === 2, 'T55: both nets routed');
    assert(evs.length === 2 && evs[0].done === 1 && evs[1].done === 2 && evs[1].total === 2, 'T55: one progress event per net');
    assert(evs[0].net === 'NET_6' && evs[1].net === 'NET_5', 'T55: deterministic net order (span DESC)');
    const evs2 = [];
    let stop = false;
    const r2 = Autoroute.route(mk(), {
        onProgress: e => { evs2.push(e); if (e.done >= 1) stop = true; },
        shouldCancel: () => stop
    });
    assert(r2.success === false && evs2.length === 1, 'T55: cancel stops before the second net');
    assert(r2.diagnostics.some(d => d.code === 'CANCELED' && d.done === 1 && d.total === 2), 'T55: CANCELED diagnostic recorded');
}

// T56: validateConnectivity + detectShorts — unrouted stubs are disconnected,
// routed project is connected; trace gap below/above clearance.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3));
    p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
    p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
    let c = Autoroute.validateConnectivity(p);
    assert(c.ok === false && JSON.stringify(c.disconnected) === '["NET_5"]', 'T56: unrouted net reported disconnected');
    const r = Autoroute.route(p, {});
    assert(r.success === true, 'T56: route succeeds for connectivity check');
    c = Autoroute.validateConnectivity(p);
    assert(c.ok === true && (c.disconnected || []).length === 0, 'T56: routed project fully connected');

    const p2 = makeProject();
    p2.traces.push({ points: [{ x: -2, y: 0 }, { x: 2, y: 0 }], net: 'N1', width: 0.5, layer: 'top' });
    p2.traces.push({ points: [{ x: -2, y: 0.7 }, { x: 2, y: 0.7 }], net: 'N2', width: 0.5, layer: 'top' });
    const s = Autoroute.detectShorts(p2);
    assert(s.length === 1 && s[0].code === 'SHORT' && s[0].netA === 'N1' && s[0].netB === 'N2', 'T56: gap 0.2 < clearance is a short');
    assertClose(s[0].gap, 0.2, 1e-6, 'T56: short gap value');
    p2.traces[1].points = [{ x: -2, y: 1.4 }, { x: 2, y: 1.4 }];
    assert(Autoroute.detectShorts(p2).length === 0, 'T56: gap 0.9 >= clearance is clear');
    p2.traces[0].net = undefined; p2.traces[1].net = undefined;
    p2.traces[1].points = [{ x: -2, y: 0.7 }, { x: 2, y: 0.7 }]; // gap 0.2 again
    const s3 = Autoroute.detectShorts(p2);
    assert(s3.length === 1 && s3[0].code === 'SHORT', 'T56: unnetted pair below clearance is a short (undefined nets are not "same net")');
}

// T57: OFF_GRID_ENDPOINTS — free ends off the grid centers: endpoint snapping
// inserts one L-corner per end so the committed trace is exact AND HV+45.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(thGndPad(1, -4, -3), thGndPad(2, 4, 3.2));
    p.traces.push(stubTrace({ x: -4, y: -3 }, { x: -2.6, y: -3 }, 'NET_7'));
    p.traces.push(stubTrace({ x: 4, y: 3.2 }, { x: 2.6, y: 3.2 }, 'NET_7'));
    const r = Autoroute.route(p, {});
    assert(r.success === true && JSON.stringify(r.routedNets) === '["NET_7"]', 'T57: off-grid free ends route');
    assert(p.traces.length === 3, 'T57: committed trace added');
    const t = p.traces[2];
    assertClose(t.points[0].x, -2.6, 1e-9, 'T57: exact start free end x (corner snap)');
    assertClose(t.points[0].y, -3, 1e-9, 'T57: exact start free end y (corner snap)');
    const last = t.points[t.points.length - 1];
    assertClose(last.x, 2.6, 1e-9, 'T57: exact end free end x (corner snap)');
    assertClose(last.y, 3.2, 1e-9, 'T57: exact end free end y (corner snap)');
    let angOk = true;
    for (let i = 0; i + 1 < t.points.length; i++) {
        const a = t.points[i], b = t.points[i + 1];
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        if (!(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) <= 1e-6)) angOk = false;
    }
    assert(angOk, 'T57: every committed segment HV+45');
}

// T58: SAME_CELL_ENDPOINTS — free ends in one grid cell. On a free grid
// findPath returns the single-point branch (route() converts it to the exact
// [start, end] stub). With real pads that close, planNets' NET_TOUCH model
// treats the net as already connected -> excluded, nothing committed.
{
    const g = openGrid(0.25);
    const rp = Autoroute.findPath(g, -0.08, 0, -0.02, 0);
    assert(rp !== null && rp.points.length === 1, 'T58: same-cell endpoints on free grid -> single-point path');

    const p = makeProject();
    p.components.push(thGndPad(1, -0.05, 0), thGndPad(2, 0.05, 0));
    p.traces.push(stubTrace({ x: -0.05, y: 0 }, { x: -0.08, y: 0 }, 'N1'));
    p.traces.push(stubTrace({ x: 0.05, y: 0 }, { x: 0.08, y: 0 }, 'N1'));
    const plan = Autoroute.planNets(p, {});
    assert(plan.nets.length === 0 && plan.excluded.some(e => e.name === 'N1' && e.reason === 'ALREADY_CONNECTED'), 'T58: same-cell pads classify as ALREADY_CONNECTED');
    const r = Autoroute.route(p, {});
    assert(r.success === true && r.routedNets.length === 0 && r.failedNets.length === 0, 'T58: excluded net is neither routed nor failed');
    assert(p.traces.length === 2, 'T58: nothing committed');
}

// T59: MULTI_PIN_PARTIAL — 3-member net, one target behind a full-height
// barrier: nearer target's segment commits, net fails with the first reason.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(thGndPad(1, -6, 0), thGndPad(2, -2, 3), thGndPad(3, 5, 0));
    p.traces.push(stubTrace({ x: -6, y: 0 }, { x: -4, y: 0 }, 'N1'));
    p.traces.push(stubTrace({ x: -2, y: 3 }, { x: -2, y: 1.5 }, 'N1'));
    p.traces.push(stubTrace({ x: 5, y: 0 }, { x: 3, y: 0 }, 'N1'));
    p.traces.push({ points: [{ x: 1, y: -15 }, { x: 1, y: 15 }], net: 'BLK', width: 0.5, layer: 'top' });
    const r = Autoroute.route(p, {});
    assert(r.success === false && JSON.stringify(r.routedNets) === '[]', 'T59: partial net not counted routed');
    assert(r.failedNets.length === 1 && r.failedNets[0].net === 'N1' && r.failedNets[0].reason === 'NO_PATH', 'T59: net fails with first failure reason');
    assert(p.traces.length === 5, 'T59: reachable target segment committed (4 stubs + 1 route)');
    assert(r.diagnostics.some(d => d.code === 'NO_PATH' && d.net === 'N1'), 'T59: NO_PATH diagnostic recorded');
}

// T60: PARTIAL_FAILURE — one blocked net + one routable net coexist: the run
// continues past the failure, the good net commits, success is false.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(thGndPad(1, -6, -3), thGndPad(2, -2, -5), thGndPad(3, -4, 3), thGndPad(4, 5, 0));
    p.traces.push(stubTrace({ x: -6, y: -3 }, { x: -4, y: -3 }, 'NET_A'));
    p.traces.push(stubTrace({ x: -2, y: -5 }, { x: -2, y: -3.5 }, 'NET_A'));
    p.traces.push(stubTrace({ x: -4, y: 3 }, { x: -2, y: 3 }, 'NET_B'));
    p.traces.push(stubTrace({ x: 5, y: 0 }, { x: 3, y: 0 }, 'NET_B'));
    p.traces.push({ points: [{ x: 1, y: -15 }, { x: 1, y: 15 }], net: 'BLK', width: 0.5, layer: 'top' });
    const r = Autoroute.route(p, {});
    assert(r.success === false, 'T60: mixed run fails overall');
    assert(JSON.stringify(r.routedNets) === '["NET_A"]', 'T60: routable net still routed & committed');
    assert(r.failedNets.length === 1 && r.failedNets[0].net === 'NET_B' && r.failedNets[0].reason === 'NO_PATH', 'T60: blocked net in failedNets with reason');
    assert(p.traces.length === 6, 'T60: only the successful net committed (5 stubs + 1 route)');
    assert(r.diagnostics.some(d => d.code === 'NO_PATH' && d.net === 'NET_B'), 'T60: NO_PATH diagnostic recorded');
}

// T61: NO_ROUTABLE_NETS — pads without stubs: nothing planned, success true,
// UNASSIGNED_PIN diagnostics carried through.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3));
    const r = Autoroute.route(p, {});
    assert(r.success === true && r.routedNets.length === 0 && r.failedNets.length === 0, 'T61: no routable nets — success with empty results');
    assert(p.traces.length === 0, 'T61: nothing committed');
    assert(r.diagnostics.filter(d => d.code === 'UNASSIGNED_PIN').length === 2, 'T61: UNASSIGNED_PIN diagnostics carried through');
}

// T62: CANCEL before the first net — shouldCancel true from the start: done 0,
// nothing committed, CANCELED diagnostic.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3));
    p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
    p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
    const r = Autoroute.route(p, { shouldCancel: () => true });
    assert(r.success === false && r.routedNets.length === 0 && p.traces.length === 2, 'T62: cancel before first net commits nothing');
    assert(r.diagnostics.some(d => d.code === 'CANCELED' && d.done === 0 && d.total === 1), 'T62: CANCELED diagnostic at done 0');
}

// ------------------------------------------------------------
// T63-T65: electrical-group planning (regression: duplicate star traces)
// A per-pad star re-traces copper that components / existing traces already
// provide. planNets must collapse electrically connected same-layer pads into
// one group and route only between groups — while a lone two-pin part on its
// net (open switch / jumper) stays un-bridged and still routes.
// ------------------------------------------------------------

// T63: COMPONENT_BRIDGE — net spans 2 components; comp1's two pins are joined
// by the package itself, and existing copper reaches comp3 → whole net is one
// electrical group → ALREADY_CONNECTED, nothing routed.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    const c1 = gndPad(1, -4, 0);
    c1.size = 1; c1.pins = [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 8, y: 0 }]; // pads at (-4,0),(4,0)
    p.components.push(c1);
    p.components.push(thGndPad(3, 7, 0));
    p.traces.push(stubTrace({ x: -4, y: 0 }, { x: -3, y: 0 }, 'N1'));
    p.traces.push(stubTrace({ x: 4, y: 0 }, { x: 6, y: 0 }, 'N1'));   // copper from pin B to...
    p.traces.push(stubTrace({ x: 7, y: 0 }, { x: 6, y: 0 }, 'N1'));   // ...comp3's pad: all connected
    const plan = Autoroute.planNets(p);
    assert(plan.nets.length === 0 && plan.excluded.some(e => e.name === 'N1' && e.reason === 'ALREADY_CONNECTED'),
        'T63: package-bridged net excluded as ALREADY_CONNECTED');
    const r = Autoroute.route(p);
    assert(r.success === true && p.traces.length === 3, 'T63: nothing routed/committed');
}

// T64: GROUP_DEDUP — three pads, B+C pre-joined by copper (one electrical
// group). Exactly one representative target is chosen for that group and one
// route is committed — no duplicate star traces.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(thGndPad(1, -6, 0));   // A
    p.components.push(thGndPad(2, -3, 0));   // B
    p.components.push(thGndPad(3, 5, 0));    // C
    p.traces.push(stubTrace({ x: -6, y: 0 }, { x: -4, y: 0 }, 'N1')); // stub from A
    p.traces.push(stubTrace({ x: -3, y: 0 }, { x: 2, y: 0 }, 'N1'));  // B reaches (2,0)
    p.traces.push(stubTrace({ x: 5, y: 0 }, { x: 2, y: 0 }, 'N1'));   // C joins the same group at (2,0)
    const plan = Autoroute.planNets(p);
    assert(plan.nets.length === 1 && plan.nets[0].name === 'N1', 'T64: net routable');
    assert(plan.nets[0].targets.length === 1, 'T64: one representative target per group');
    const t = plan.nets[0].targets[0];
    assert(t.x === -3 && t.compId === 2, 'T64: nearest pad (B) is the group representative');
    const r = Autoroute.route(p);
    assert(r.success === true && r.routedNets.length === 1, 'T64: routed once');
    assert(p.traces.length === 4, 'T64: exactly one new trace committed (no duplicates)');
    for (let ti = 0; ti < p.traces.length; ti++) {
        const tr = p.traces[ti];
        let len = 0;
        for (let k = 1; k < tr.points.length; k++)
            len += Math.hypot(tr.points[k].x - tr.points[k-1].x, tr.points[k].y - tr.points[k-1].y);
        assert(len > 0.01, `T64: trace ${ti} is not zero-length`);
    }
}

// T65: OPEN_SWITCH — a single two-pin component on its net must NOT be bridged
// by the package (the switch is open): both pads are distinct electrical
// groups and the net routes normally.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    const c1 = gndPad(1, -4, 0);
    c1.size = 1; c1.pins = [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 8, y: 0 }]; // pads at (-4,0),(4,0)
    p.components.push(c1);
    p.traces.push(stubTrace({ x: -4, y: 0 }, { x: -3, y: 0 }, 'N1'));
    p.traces.push(stubTrace({ x: 4, y: 0 }, { x: 3, y: 0 }, 'N1'));
    const plan = Autoroute.planNets(p);
    assert(plan.nets.length === 1 && plan.nets[0].name === 'N1', 'T65: lone two-pin net stays routable');
    assert(plan.nets[0].targets.length === 1, 'T65: one target (other pad)');
    const r = Autoroute.route(p);
    assert(r.success === true && r.routedNets.length === 1, 'T65: open switch routes');
    assert(p.traces.length === 3, 'T65: exactly one new trace committed');
    const added = p.traces[2];
    let len = 0;
    for (let k = 1; k < added.points.length; k++)
        len += Math.hypot(added.points[k].x - added.points[k-1].x, added.points[k].y - added.points[k-1].y);
    assert(len > 5, 'T65: routed the gap between the pins, not a zero-length stub');
}

// T66: SKIP_ROUTED — only nets whose pads are already FULLY joined by same-layer
// copper are left alone. A net with partial copper (stubs off each pad) is still
// incomplete, so skipRouted must complete it — otherwise its remaining legs are
// silently never routed.
{
    const mk = () => {
        const p = makeProject();
        p.board.width = 20; p.board.height = 20;
        p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3), gndPad(3, -8, 8), gndPad(4, 8, 8));
        p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
        p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
        p.traces.push(stubTrace({ x: -8, y: 8 }, { x: -6, y: 8 }, 'NET_6'));
        p.traces.push(stubTrace({ x: 8, y: 8 }, { x: 6, y: 8 }, 'NET_6'));
        return p;
    };
    const p = mk();
    const r = Autoroute.route(p, { skipRouted: true });
    assert(r.success === true && r.routedNets.length === 2 && r.failedNets.length === 0,
        'T66: partially coppered nets are still completed with skipRouted on');
    assert(p.traces.length === 6, 'T66: one trace committed per net');
    assert(r.diagnostics.filter(d => d.code === 'SKIPPED_ROUTED').length === 0, 'T66: nothing silently skipped');
    const r2 = Autoroute.route(mk(), {});
    assert(r2.success === true && r2.routedNets.length === 2, 'T66: control run (no flag) routes both nets');
}

// T67: onlyNet routes a single named net and leaves the other project's nets alone.
{
    const p = makeProject();
    p.board.width = 20; p.board.height = 20;
    p.components.push(gndPad(1, -3, -3), gndPad(2, 3, 3), gndPad(3, -8, 8), gndPad(4, 8, 8));
    p.traces.push(stubTrace({ x: -3, y: -3 }, { x: -1, y: -3 }, 'NET_5'));
    p.traces.push(stubTrace({ x: 3, y: 3 }, { x: 1, y: 3 }, 'NET_5'));
    p.traces.push(stubTrace({ x: -8, y: 8 }, { x: -6, y: 8 }, 'NET_6'));
    p.traces.push(stubTrace({ x: 8, y: 8 }, { x: 6, y: 8 }, 'NET_6'));
    const before = p.traces.length;
    const r = Autoroute.route(p, { onlyNet: 'NET_5' });
    assert(r.routedNets.length === 1 && r.routedNets[0] === 'NET_5', 'T67: only NET_5 routed');
    assert(r.failedNets.length === 0, 'T67: no failures');
    assert(p.traces.length === before + 1, 'T67: one new trace');
    const nets = p.traces.map(t => t.net);
    assert(nets.filter(n => n === 'NET_5').length === 3, 'T67: NET_5 has original stubs + new copper');
    assert(nets.filter(n => n === 'NET_6').length === 2, 'T67: NET_6 stubs untouched');
}

// ============================================================
// T68: equal-cost tie-break — a diagonal run must not be emitted as a
// staircase. On an open grid, offset (dx,dy) has an optimal path of
// dy diagonal steps plus (dx-dy) straight steps, i.e. exactly two
// direction runs (one for a pure diagonal). Without the TURN45_EPS
// preference A* used to interleave H/D steps (3+ runs), which simplifyPath
// cannot collapse.
// ============================================================
{
    const g = openGrid(0.25);
    function runs(res) {
        const pts = res.points;
        let r = 0, pd = '';
        for (let i = 1; i < pts.length; i++) {
            const dx = Math.sign(pts[i].x - pts[i - 1].x), dy = Math.sign(pts[i].y - pts[i - 1].y);
            const d = dx === 0 ? 'V' : dy === 0 ? 'H' : 'D';
            if (i === 1 || pd !== d) r++;
            pd = d;
        }
        return r;
    }
    for (const [dx, dy] of [[12, 6], [16, 8], [12, 3], [10, 4], [14, 7], [8, 8]]) {
        const s = pc(g, 10, 10), e = pc(g, 10 + dx, 10 + dy);
        const res = Autoroute.findPath(g, s.x, s.y, e.x, e.y);
        assertPathValid(g, res, s.x, s.y, e.x, e.y, Autoroute.BEND_PENALTY, `T68 ${dx},${dy}`);
        assert(res.points.length === dx + 1, `T68 ${dx},${dy}: ${dx + 1} points (no detour)`);
        const wantRuns = dx === dy ? 1 : 2;
        assert(runs(res) === wantRuns, `T68 ${dx},${dy}: ${wantRuns} direction runs, got ${runs(res)}`);
        assert(res.bends === 0, `T68 ${dx},${dy}: no 90-degree bends`);
    }
}

// T69: endpoint lead-in must not fold back. Real-world fixture (a 100x80 board
// whose only unrouted net runs from an off-grid resistor pad straight up, then
// diagonals to an LED pad): the A* departure cell centre sits BELOW the pad
// free end, so the naive H-then-V corner doubles back on the path's first
// segment and validateRoute rejects the whole net as INVALID_GEOMETRY. The
// corner choice now follows the existing first segment.
{
    const p = ProjectApi.createEmptyProject();
    p.board.width = 100; p.board.height = 80;
    const Y = -23.41658461340107, Y2 = 2.5641775001320894;
    p.components.push(
        { id: 1, type: 'resistor', x: -15.590867514431963, y: Y, rotation: 180, size: 10, pins: [{ x: -2.54, y: 0, name: '1' }, { x: 2.54, y: 0, name: '2' }] },
        { id: 2, type: 'power', x: 14.409132485568037, y: Y, rotation: 270, size: 0, pins: [{ x: 0, y: 0, name: 'VCC' }] },
        { id: 3, type: 'gnd', x: -0.5908675144319631, y: Y2, rotation: 0, size: 0, pins: [{ x: 0, y: 0, name: 'GND' }] },
        { id: 4, type: 'led', x: -30.590867514431956, y: Y2, rotation: 0, size: 0, pins: [{ x: -1.27, y: 0, name: 'A' }, { x: 1.27, y: 0, name: 'K' }] }
    );
    p.traces.push(
        { points: [{ x: 14.409132485568037, y: Y }, { x: -13.050867514431964, y: Y }], width: 0.5, layer: 'top', net: 'NET_4', schemWire: true },
        { points: [{ x: -18.130867514431962, y: Y }, { x: -31.86086751443196, y: Y2 }], width: 0.5, layer: 'top', net: 'NET_5', schemWire: true },
        { points: [{ x: -29.320867514431953, y: Y2 }, { x: -0.5908675144319631, y: Y2 }], width: 0.5, layer: 'top', net: 'NET_6', schemWire: true },
        { points: [{ x: -0.5908675144319631, y: Y2 }, { x: -29.320867514431956, y: Y2 }], width: 0.5, layer: 'top', net: 'NET_6' },
        { points: [{ x: -13.050867514431964, y: Y }, { x: 14.409132485568037, y: Y }], width: 0.5, layer: 'top', net: 'NET_4' }
    );
    const before = p.traces.length;
    const r = Autoroute.route(p, { gridSize: 0.1, clearance: 0.38, traceWidth: 0.5, skipRouted: true });
    assert(r.success === true && JSON.stringify(r.routedNets) === '["NET_5"]', 'T69: real off-grid net routes (no INVALID_GEOMETRY)');
    assert(p.traces.length === before + 1, 'T69: one committed trace added');
    const t = p.traces[p.traces.length - 1];
    let fold = false, angOk = true;
    for (let i = 0; i + 1 < t.points.length; i++) {
        const a = t.points[i], b = t.points[i + 1];
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        if (!(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) <= 1e-6)) angOk = false;
        if (i + 2 < t.points.length) {
            const c = t.points[i + 2];
            const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
            const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
            if (la > 1e-9 && lb > 1e-9 && Math.abs(ax * by - ay * bx) <= 1e-6 * la * lb && ax * bx + ay * by < 0) fold = true;
        }
    }
    assert(angOk, 'T69: every committed segment HV+45');
    assert(!fold, 'T69: no segment folds back on its neighbour');
}

// T70: a route must detour AROUND a component body to reach a pin on the far
// side. Same fixture as T69, but with every net unrouted: NET_5 runs from the
// resistor pad (inside its own body) to the LED pad, so the straight line cuts
// the resistor body. Bodies are blocked for the net's own component too, with a
// corridor punched at the pin, so A* goes around instead of failing BODY_OVERLAP.
{
    const p = ProjectApi.createEmptyProject();
    p.board.width = 100; p.board.height = 80;
    const Y = -23.41658461340107, Y2 = 2.5641775001320894;
    p.components.push(
        { id: 1, type: 'resistor', x: -15.590867514431963, y: Y, rotation: 180, size: 10, pins: [{ x: -2.54, y: 0, name: '1' }, { x: 2.54, y: 0, name: '2' }] },
        { id: 2, type: 'power', x: 14.409132485568037, y: Y, rotation: 270, size: 0, pins: [{ x: 0, y: 0, name: 'VCC' }] },
        { id: 3, type: 'gnd', x: -0.5908675144319631, y: Y2, rotation: 0, size: 0, pins: [{ x: 0, y: 0, name: 'GND' }] },
        { id: 4, type: 'led', x: -30.590867514431956, y: Y2, rotation: 0, size: 0, pins: [{ x: -1.27, y: 0, name: 'A' }, { x: 1.27, y: 0, name: 'K' }] }
    );
    p.traces.push(
        { points: [{ x: 14.409132485568037, y: Y }, { x: -13.050867514431964, y: Y }], width: 0.5, layer: 'top', net: 'NET_4', schemWire: true },
        { points: [{ x: -18.130867514431962, y: Y }, { x: -31.86086751443196, y: Y2 }], width: 0.5, layer: 'top', net: 'NET_5', schemWire: true },
        { points: [{ x: -29.320867514431953, y: Y2 }, { x: -0.5908675144319631, y: Y2 }], width: 0.5, layer: 'top', net: 'NET_6', schemWire: true }
    );
    const before = p.traces.length;
    const r = Autoroute.route(p, { gridSize: 0.1, clearance: 0.38, traceWidth: 0.5, skipRouted: true });
    const routed = JSON.stringify(r.routedNets);
    assert(r.success === true && routed === '["NET_5","NET_6","NET_4"]', `T70: all three nets routed (got ${routed})`);
    assert(p.traces.length === before + 3, 'T70: three committed traces added');
    let bodyOverlap = false;
    for (const d of r.diagnostics) if (d.code === 'BODY_OVERLAP') bodyOverlap = true;
    assert(!bodyOverlap, 'T70: no BODY_OVERLAP diagnostics');
    // Resistor body (axis-aligned at rotation 180): the route may run inside its
    // own endpoint body (validateRoute 4c excludes endpoint components), but it
    // must not cut straight across it — it has to leave the body and go around.
    const rx0 = -15.590867514431963 - 6.3 / 2, rx1 = -15.590867514431963 + 6.3 / 2;
    const ry0 = Y - 3.2 / 2, ry1 = Y + 3.2 / 2;
    let angOk = true;
    for (let ti = before; ti < p.traces.length; ti++) {
        const pts = p.traces[ti].points;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
            if (!(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) <= 1e-6)) angOk = false;
        }
    }
    assert(angOk, 'T70: every committed segment HV+45');
    const t5 = p.traces.slice(before).find(t => t.net === 'NET_5');
    let minX = Infinity;
    for (const q of t5.points) if (q.x < minX) minX = q.x;
    assert(t5.points.length > 2, 'T70: NET_5 is not a straight cut through the resistor');
    assert(minX < rx0, 'T70: NET_5 detours west of the resistor body');
}

// T71: a pad joining a net that already has a run must not lay a second
// trace along that run. New copper is only the gap up to the existing trace.
{
    const p = makeProject();
    p.board.width = 40; p.board.height = 20;
    p.components.push(thGndPad(1, -10, 0), thGndPad(2, 0, 0), thGndPad(3, 10, 0));
    p.traces.push(stubTrace({ x: 0, y: 0 }, { x: 10, y: 0 }, 'N1'));
    const r = Autoroute.route(p, { gridSize: 0.1 });
    assert(r.success === true, 'T71: net routed (' + (r.failedNets[0] && r.failedNets[0].reason) + ')');
    let added = 0;
    for (let ti = 1; ti < p.traces.length; ti++) {
        const pts = p.traces[ti].points;
        for (let k = 1; k < pts.length; k++) added += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
    }
    assert(added < 14, 'T71: new copper joins the existing run (length ' + added.toFixed(2) + ', not a full cover)');
    const segs = [{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }];
    let stacked = 0;
    for (let ti = 1; ti < p.traces.length; ti++) {
        const pts = p.traces[ti].points;
        const kept = ProjectApi.uncoveredPieces(pts, segs, 0.2);
        let klen = 0;
        for (const q of kept) klen += ProjectApi._polyLen(q);
        stacked += ProjectApi._polyLen(pts) - klen;
    }
    assert(stacked < 0.3, 'T71: committed copper does not cover the existing run');
}

console.log(`autorouter tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
