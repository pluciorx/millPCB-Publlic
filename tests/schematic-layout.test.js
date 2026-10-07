#!/usr/bin/env node
// Schematic layout engine tests — Node vm, no browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code + '\ntry{this.ComponentDefs=ComponentDefs;}catch(e){}\ntry{this.SchematicLayout=SchematicLayout;}catch(e){}\ntry{this.SchematicView=SchematicView;}catch(e){}\ntry{this.App=App;}catch(e){}\ntry{this.Examples=Examples;}catch(e){}\ntry{this.computeDrcViolations=computeDrcViolations;}catch(e){}\ntry{this.Export=Export;}catch(e){}\ntry{this.ProjectApi=ProjectApi;}catch(e){}\ntry{this.Autoroute=Autoroute;}catch(e){}\ntry{this.segSegDistance=segSegDistance;}catch(e){}', context, { filename: filePath });
}

const ctx = { console, App: {} };
loadScript('js/component-defs.js', ctx);
loadScript('js/export.js', ctx);
loadScript('js/drc.js', ctx);
loadScript('js/project-api.js', ctx);
loadScript('js/autorouter.js', ctx);
loadScript('js/schematic-layout.js', ctx);
loadScript('js/app-core.js', ctx);
loadScript('js/schematic-view.js', ctx);
loadScript('js/schematic-ops.js', ctx);
loadScript('js/examples.js', ctx);

const SchematicLayout = ctx.SchematicLayout;
const SchematicView = ctx.SchematicView;
const App = ctx.App;
const Examples = ctx.Examples;
const ComponentDefs = ctx.ComponentDefs;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

function clonePins(type, sizeIdx) {
    const def = ComponentDefs.get(type);
    const size = ComponentDefs.getSize(def, sizeIdx !== undefined ? sizeIdx : def.defaultSize);
    return size.pins.map(p => ({ ...p }));
}

function pinPos(comp, pinIndex) {
    const pin = comp.pins[pinIndex];
    const rad = (comp.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return { x: comp.x + pin.x * cos - pin.y * sin, y: comp.y + pin.x * sin + pin.y * cos };
}

function fourColSlot(i) {
    const spacingX = 200, spacingY = 150, cols = 4;
    return {
        x: -((cols - 1) * spacingX) / 2 + (i % cols) * spacingX,
        y: -40 + Math.floor(i / cols) * spacingY
    };
}

function routeProject(components, traces) {
    App.components = components;
    App.traces = traces;
    App._schemWireCache = null;
    return traces.map(tr => ({ tr, pts: App.getSchemWirePoints(tr) })).filter(x => x.pts);
}

function bodyCrossCount(components, routed) {
    let n = 0;
    const bounds = components.map(c => SchematicView.schemSymbolBounds(c));
    routed.forEach(({ tr, pts }) => {
        // Endpoint glyphs are exempt: a wire starts/ends at its pin, which sits inside
        // its own extended symbol bounds. All other glyphs must stay clear.
        const skip = new Set();
        const ea = SchematicLayout._matchPin(components, tr.points[0]);
        const eb = SchematicLayout._matchPin(components, tr.points[tr.points.length - 1]);
        if (ea) skip.add(ea.comp.id);
        if (eb) skip.add(eb.comp.id);
        const obs = bounds.filter((o, i) => !skip.has(components[i].id));
        if (!SchematicLayout.pathClear(pts, obs)) n++;
    });
    return n;
}

function stackedDistinctNets(routed) {
    let n = 0;
    for (let i = 0; i < routed.length; i++) {
        for (let j = i + 1; j < routed.length; j++) {
            if ((routed[i].tr.net || '') === (routed[j].tr.net || '')) continue;
            const pa = routed[i].pts, pb = routed[j].pts;
            for (let a = 0; a < pa.length - 1; a++) {
                for (let b = 0; b < pb.length - 1; b++) {
                    if (SchematicLayout.collinearOverlap(pa[a], pa[a + 1], pb[b], pb[b + 1])) n++;
                }
            }
        }
    }
    return n;
}

// ---- Missing positions: topology, not 4-col add-order ----
{
    const u1 = { id: 1, type: 'ic', x: 0, y: 0, rotation: 0, size: 0, value: 'NE555', label: 'U1', pins: clonePins('ic', 0) };
    const j1 = { id: 2, type: 'connector', x: 0, y: 10, rotation: 0, size: 0, value: 'POWER', label: 'J1', pins: clonePins('connector', 0) };
    const r1 = { id: 3, type: 'resistor', x: -10, y: 0, rotation: 0, size: 0, value: '10k', label: 'R1', pins: clonePins('resistor', 0) };
    const gnd = { id: 4, type: 'gnd', x: 5, y: 8, rotation: 0, size: 0, value: 'GND', label: '', pins: clonePins('gnd', 0) };
    const pwr = { id: 5, type: 'power', x: 0, y: -8, rotation: 0, size: 0, value: 'VCC', label: '', pins: clonePins('power', 0) };
    const traces = [
        { id: 1, points: [pinPos(j1, 0), pinPos(u1, 7)], net: 'VCC', schemWire: true },
        { id: 2, points: [pinPos(j1, 1), pinPos(u1, 0)], net: 'GND', schemWire: true },
        { id: 3, points: [pinPos(u1, 6), pinPos(r1, 0)], net: 'DIS_NET', schemWire: true },
        { id: 4, points: [pinPos(u1, 0), pinPos(gnd, 0)], net: 'GND', schemWire: true }
    ];
    const comps = [u1, j1, r1, gnd, pwr];
    SchematicLayout.placeMissing(comps, traces);
    comps.forEach(c => assert(typeof c.schemX === 'number' && typeof c.schemY === 'number', c.label + ' placed'));
    assert(u1.schemX === 0 && u1.schemY === 0, 'hub IC at origin, not 4-col slot 0');
    assert(j1.schemX < u1.schemX, 'connector left of hub');
    assert(gnd.schemY > u1.schemY, 'GND below hub row');
    assert(pwr.schemY < u1.schemY, 'VCC/power above hub');
    const slot0 = fourColSlot(0);
    assert(!(comps[0].schemX === slot0.x && comps[0].schemY === slot0.y &&
        comps[1].schemX === fourColSlot(1).x && comps[1].schemY === fourColSlot(1).y),
        'not dumped into 4-col add-order grid');
    const distR = Math.hypot(r1.schemX - u1.schemX, r1.schemY - u1.schemY);
    assert(distR < 280, 'timing resistor near hub, not far grid dump (' + distR + ')');

    const bare = (c) => { const o = Object.assign({}, c); delete o.schemX; delete o.schemY; return o; };
    App.components = comps.map(bare);
    App.traces = traces;
    App.ensureSchemPositions();
    const u1e = App.components.find(c => c.label === 'U1');
    const j1e = App.components.find(c => c.label === 'J1');
    const gnde = App.components.find(c => c.type === 'gnd');
    const pwre = App.components.find(c => c.type === 'power');
    assert(u1e.schemX === 0 && u1e.schemY === 0, 'ensureSchemPositions hub at origin');
    assert(j1e.schemX < u1e.schemX, 'ensureSchemPositions connector left of hub');
    assert(gnde.schemY > u1e.schemY, 'ensureSchemPositions GND below hub');
    assert(pwre.schemY < u1e.schemY, 'ensureSchemPositions power above hub');
}

// ---- Saved project: existing schemX/schemY unchanged ----
{
    const a = { id: 1, type: 'resistor', x: 0, y: 0, pins: clonePins('resistor', 0), schemX: 123, schemY: 456 };
    const b = { id: 2, type: 'led', x: 10, y: 0, pins: clonePins('led', 0), schemX: -50, schemY: 80 };
    SchematicLayout.placeMissing([a, b], [{ id: 1, points: [pinPos(a, 1), pinPos(b, 0)], net: 'N', schemWire: true }]);
    assert(a.schemX === 123 && a.schemY === 456, 'saved resistor position unchanged');
    assert(b.schemX === -50 && b.schemY === 80, 'saved LED position unchanged');
    App.components = [
        { id: 1, type: 'resistor', x: 0, y: 0, pins: clonePins('resistor', 0), schemX: 123, schemY: 456 },
        { id: 2, type: 'led', x: 10, y: 0, pins: clonePins('led', 0), schemX: -50, schemY: 80 }
    ];
    App.traces = [{ id: 1, points: [pinPos(App.components[0], 1), pinPos(App.components[1], 0)], net: 'N', schemWire: true }];
    App.ensureSchemPositions();
    assert(App.components[0].schemX === 123 && App.components[0].schemY === 456, 'ensureSchemPositions keeps saved resistor');
    assert(App.components[1].schemX === -50 && App.components[1].schemY === 80, 'ensureSchemPositions keeps saved LED');
}

// ---- New part on existing net sits near neighbor ----
{
    const r1 = { id: 1, type: 'resistor', x: 0, y: 0, pins: clonePins('resistor', 0), schemX: 0, schemY: 0 };
    const d1 = { id: 2, type: 'led', x: 8, y: 0, pins: clonePins('led', 0), schemX: 100, schemY: 0 };
    const r2 = { id: 3, type: 'resistor', x: 16, y: 0, pins: clonePins('resistor', 0) };
    const traces = [
        { id: 1, points: [pinPos(r1, 1), pinPos(d1, 0)], net: 'SIG', schemWire: true },
        { id: 2, points: [pinPos(d1, 1), pinPos(r2, 0)], net: 'SIG', schemWire: true }
    ];
    SchematicLayout.placeMissing([r1, d1, r2], traces);
    const dist = Math.min(Math.hypot(r2.schemX - r1.schemX, r2.schemY - r1.schemY),
        Math.hypot(r2.schemX - d1.schemX, r2.schemY - d1.schemY));
    assert(dist <= 220, 'new part near same-net cluster, not next 4-col cell (' + dist + ')');
    const nextGrid = fourColSlot(2);
    assert(!(r2.schemX === nextGrid.x && r2.schemY === nextGrid.y), 'new part is not 4-col slot 2');
}

// ---- Isolated new part: free slot right of bbox, not 4-col dump ----
{
    const r1 = { id: 1, type: 'resistor', x: 0, y: 0, pins: clonePins('resistor', 0), schemX: 0, schemY: 0 };
    const iso = { id: 2, type: 'resistor', x: 40, y: 40, pins: clonePins('resistor', 0) };
    SchematicLayout.placeMissing([r1, iso], []);
    assert(iso.schemX > r1.schemX, 'isolated part to the right of placed bbox');
}

// ---- Auto-route: no body hit; detour not straight through glyph ----
{
    const aw = { x: -80, y: 0 }, bw = { x: 80, y: 0 };
    const box = { minX: -20, minY: -20, maxX: 20, maxY: 20 };
    const pts = SchematicLayout.route(aw, bw, [box], []);
    assert(!SchematicLayout.segHitsBody(aw, bw, [box]) || pts.length > 2, 'does not keep a body-hitting straight line');
    assert(SchematicLayout.pathClear(pts, [box]), 'detour clears the glyph AABB');
}

{
    const box = { minX: -20, minY: -20, maxX: 20, maxY: 20 };
    const aw = { x: -20, y: 0 }, bw = { x: 20, y: 0 };
    const pts = SchematicLayout.route(aw, bw, [box], [], { aBound: box, bBound: box });
    assert(SchematicLayout.pathClear(pts, [box]), 'route with endpoint aBound/bBound clears glyph interior');
    assert(pts[0].x === aw.x && pts[pts.length - 1].x === bw.x, 'route still starts and ends on the pins');
}

// ---- Auto-route: other-net collinear overlap avoided ----
{
    const aw = { x: 0, y: 0 }, bw = { x: 200, y: 0 };
    const occupied = [{ p: { x: 40, y: 0 }, q: { x: 160, y: 0 } }];
    const pts = SchematicLayout.route(aw, bw, [], occupied);
    assert(!SchematicLayout.pathOverlaps(pts, occupied), 'distinct net does not share a collinear overlapping segment');
}

// ---- User waypoints: drawn polyline uses waypoints, not auto-route ----
{
    const a = { id: 1, type: 'resistor', x: 0, y: 0, pins: clonePins('resistor', 0), schemX: 0, schemY: 0 };
    const b = { id: 2, type: 'led', x: 20, y: 0, pins: clonePins('led', 0), schemX: 200, schemY: 0 };
    App.components = [a, b];
    const trace = {
        id: 9, net: 'SIG', schemWire: true,
        points: [pinPos(a, 1), pinPos(b, 0)],
        waypoints: [{ x: 40, y: 90 }, { x: 160, y: 90 }]
    };
    App.traces = [trace];
    App._schemWireCache = null;
    const pts = App.getSchemWirePoints(trace);
    assert(pts && pts.length === 4, 'waypoint polyline has pin + two waypoints + pin');
    assert(pts[1].x === 40 && pts[1].y === 90 && pts[2].x === 160 && pts[2].y === 90, 'waypoints used as drawn');
}

// ---- Examples: place + route bar for every starter ----
{
    Examples.list.forEach(ex => {
        const data = Examples.build(ex.id);
        const boardXY = data.components.map(c => ({ id: c.id, x: c.x, y: c.y, rot: c.rotation }));
        SchematicLayout.placeMissing(data.components, data.traces);
        data.components.forEach(c => {
            assert(typeof c.schemX === 'number' && typeof c.schemY === 'number', ex.id + ' ' + (c.label || c.type) + ' has schematic pos');
        });
        boardXY.forEach((b, i) => {
            const c = data.components[i];
            assert(c.x === b.x && c.y === b.y && c.rotation === b.rot, ex.id + ' board geometry unchanged for id ' + b.id);
        });
        const routed = routeProject(data.components, data.traces);
        const expectedWires = data.traces.filter(tr => tr.points && tr.points.length >= 2 && tr.schemWire !== false).length;
        assert(routed.length === expectedWires, ex.id + ' every netted trace is visible (' + routed.length + '/' + expectedWires + ')');
        const geom = ex.id === 'ne555-heart'
            ? routed.filter(x => x.tr.net !== 'LED_NET' && x.tr.net !== 'GND' && x.tr.net !== 'VCC')
            : routed;
        const crosses = bodyCrossCount(data.components, geom);
        assert(crosses === 0, ex.id + ' no wire through symbol interiors (' + crosses + ')');
        const stacked = stackedDistinctNets(geom);
        assert(stacked === 0, ex.id + ' no stacked distinct-net segments (' + stacked + ')');

        const byLabel = {};
        data.components.forEach(c => { if (c.label) byLabel[c.label] = c; });
        const hub = byLabel.U1;
        const loads = data.components.filter(c => c.type === 'led' || (c.type === 'resistor' && c.label && c.label !== 'R1' && c.label !== 'R2'));
        if (hub && loads.length) {
            loads.forEach(c => {
                const d = Math.hypot(c.schemX - hub.schemX, c.schemY - hub.schemY);
                assert(d < 700, ex.id + ' ' + c.label + ' clustered with hub (' + d + ')');
            });
        }
    });
}

// ---- NE555 Heart specific reading order ----
{
    const data = Examples.build('ne555-heart');
    SchematicLayout.placeMissing(data.components, data.traces);
    const find = lab => data.components.find(c => c.label === lab);
    const u1 = find('U1'), j1 = find('J1'), r1 = find('R1'), r2 = find('R2'), c1 = find('C1'), c2 = find('C2');
    const leds = data.components.filter(c => c.type === 'led');
    assert(leds.length >= 14, 'NE555: at least 14 LEDs');
    leds.forEach(d => {
        assert(Math.hypot(d.x, d.y) > 10, 'NE555: ' + d.label + ' on heart ring not at origin');
    });
    const r3 = find('R3'), d1 = find('D1'), d2 = find('D2'), d3 = find('D3');
    assert(j1.schemX < u1.schemX, 'NE555: J1 left of U1');
    const nearIc = [r1, r2, c1, c2];
    nearIc.forEach(c => {
        const d = Math.hypot(c.schemX - u1.schemX, c.schemY - u1.schemY);
        assert(d < 360, 'NE555: ' + c.label + ' timing part by IC (' + d + ')');
    });
    const ledCx = (d1.schemX + d2.schemX + d3.schemX) / 3;
    const ledCy = (d1.schemY + d2.schemY + d3.schemY) / 3;
    const ledSpan = Math.max(
        Math.hypot(d1.schemX - d2.schemX, d1.schemY - d2.schemY),
        Math.hypot(d2.schemX - d3.schemX, d2.schemY - d3.schemY),
        Math.hypot(d1.schemX - d3.schemX, d1.schemY - d3.schemY)
    );
    assert(ledSpan < 450, 'NE555: LEDs cluster together');
    const r3ToLed = Math.hypot(r3.schemX - ledCx, r3.schemY - ledCy);
    assert(r3ToLed < 400, 'NE555: R3 with LED cluster');
    const c1Wired = data.traces.some(tr => {
        const a = SchematicLayout._matchPin(data.components, tr.points[0]);
        const b = SchematicLayout._matchPin(data.components, tr.points[tr.points.length - 1]);
        return (a && a.comp.id === c1.id) || (b && b.comp.id === c1.id);
    });
    assert(c1Wired, 'NE555: C1 is wired');
    const gnd = data.components.find(c => c.type === 'gnd');
    const gndLoop = Math.hypot(gnd.schemX - u1.schemX, gnd.schemY - u1.schemY);
    assert(gndLoop < 560, 'NE555: GND not a distant corner loop');
    const thresh = 0.55;
    data.components.forEach(c => {
        const rad = (c.rotation || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        (c.pins || []).forEach(pin => {
            const px = c.x + pin.x * cos - pin.y * sin, py = c.y + pin.x * sin + pin.y * cos;
            const hit = data.traces.some(tr => tr.points.some(q => Math.abs(q.x - px) < thresh && Math.abs(q.y - py) < thresh));
            assert(hit, 'NE555: pin wired ' + (c.label || c.type) + ' ' + pin.name);
        });
    });
    assert(data.traces.some(tr => tr.net === 'LED_NET' && tr.schemWire !== false), 'NE555: LED net visible on schematic');
    assert(data.vias.length >= 1, 'NE555: has a via');
    assert(data.silkTexts.some(s => s.layer === 'silkTop') && data.silkTexts.some(s => s.layer === 'silkBottom'), 'NE555: silk both sides');
    const drc = ctx.computeDrcViolations(data);
    const hard = drc.filter(v => v.type !== 'unrouted');
    assert(hard.length === 0, 'NE555: DRC pass (' + hard.map(v => v.msg).join('; ') + ')');
    assert(drc.some(v => v.type === 'unrouted'), 'NE555: schematic-only nets flagged as unrouted');
    assert(data.traces.some(tr => tr.net === 'GND' && tr.schemWire !== false && (tr.points || []).length >= 2), 'NE555: cathode/GND visible on schematic');
    assert(data.traces.some(tr => tr.net === 'VCC' && tr.schemWire !== false), 'NE555: VCC visible on schematic');
}

// A/K letters removed from diode/LED glyph
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'schematic-view.js'), 'utf8');
    const fn = src.slice(src.indexOf('drawDiodeSymbol'), src.indexOf('drawSwitchSymbol'));
    assert(!/\bfillText\(\s*['"]A['"]/.test(fn) && !/\bfillText\(\s*['"]K['"]/.test(fn), 'LED/diode glyph has no A/K letters');
}

{
    const polar = { type: 'capacitor', pins: [{ name: '-' }, { name: '+' }] };
    const ceramic = { type: 'capacitor', pins: [{ name: '1' }, { name: '2' }] };
    assert(ctx.SchematicView._isPolarCap(polar), 'electrolytic +/- pins use polar cap glyph');
    assert(!ctx.SchematicView._isPolarCap(ceramic), 'ceramic 1/2 pins stay unpolarized');
    const def = ctx.ComponentDefs.get('capacitor');
    const ei = def.sizes.findIndex(s => /Electrolytic/.test(s.name));
    assert(ei >= 0 && ctx.SchematicView._isPolarCap({ type: 'capacitor', size: ei, pins: def.sizes[ei].pins }), 'named electrolytic footprint is polar');
}

{
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'schematic-view.js'), 'utf8');
    assert(src.includes('-e.hh - 4'), 'schematic labels sit on glyph bounds, not a far offset');
}

// Floating-pin DRC: open pin errors; NC (X) pad counts as termination
{
    const led = { id: 1, type: 'led', x: 0, y: 0, rotation: 0, size: 0, label: 'D1', pins: clonePins('led', 0) };
    const open = { traces: [], components: [led] };
    const vOpen = ctx.computeDrcViolations(open).filter(v => v.type === 'floating-pin');
    assert(vOpen.length >= 2, 'unwired LED pins are floating');
    const nc = { id: 2, type: 'nc', x: led.x + led.pins[0].x, y: led.y + led.pins[0].y, rotation: 0, size: 0, label: 'X1', pins: clonePins('nc', 0) };
    const r = { id: 3, type: 'resistor', x: 10, y: 0, rotation: 0, size: 0, label: 'R1', pins: clonePins('resistor', 0) };
    const half = {
        traces: [{ id: 1, points: [ { x: led.x + led.pins[1].x, y: led.y }, { x: r.x + r.pins[0].x, y: r.y } ], width: 0.5, net: 'SIG' }],
        components: [led, nc, r]
    };
    const vHalf = ctx.computeDrcViolations(half).filter(v => v.type === 'floating-pin');
    assert(vHalf.length === 1 && /R1/.test(vHalf[0].msg), 'NC pad terminates one LED pin; other resistor pin still floats');
}

// T-join cache (pin+schemJoin), crossing is not a net, user waypoints stick, routeAngle snap
{
    const mkR = (id, x, y, sx, sy) => ({
        id, type: 'resistor', x, y, schemX: sx, schemY: sy, rotation: 0, size: 0, label: 'R' + id,
        pins: clonePins('resistor', 0), layer: 'top'
    });
    const r1 = mkR(1, -10, 0, -80, 0);
    const r2 = mkR(2, 10, 0, 80, 0);
    const r3 = mkR(3, 0, 10, 0, 80);
    App.components = [r1, r2, r3];
    App.traces = [];
    App.params.routeAngle = 'hv45';
    const host = {
        id: 50,
        points: [App.pinBoardPos(r1, 1), App.pinBoardPos(r2, 0)],
        width: 0.5, layer: 'top', net: 'SIG1', schemWire: true
    };
    const join = SchematicView.schemPinWorld(r2, 0);
    const stub = {
        id: 51,
        points: [App.pinBoardPos(r3, 0), host.points[0]],
        width: 0.5, layer: 'top', net: 'SIG1', schemWire: true,
        schemJoin: { x: join.x, y: join.y }
    };
    App.traces = [host, stub];
    App._schemWireCache = null;
    const stubPts = App.getSchemWirePoints(stub);
    assert(stubPts && stubPts.length >= 2, 'T-stub with schemJoin is cached (pin+join)');

    const crossA = {
        id: 60, points: [App.pinBoardPos(r1, 0), App.pinBoardPos(r2, 1)],
        width: 0.5, net: 'NETA', schemWire: true, waypoints: [{ x: -40, y: -40 }, { x: 40, y: 40 }]
    };
    const crossB = {
        id: 61, points: [App.pinBoardPos(r3, 1), App.pinBoardPos(r2, 1)],
        width: 0.5, net: 'NETB', schemWire: true, waypoints: [{ x: -40, y: 40 }, { x: 40, y: -40 }]
    };
    App.traces = [crossA, crossB];
    App._schemWireCache = null;
    assert(crossA.net !== crossB.net && !crossA.schemJoin && !crossB.schemJoin, 'crossing wires are not joined');
    assert(App.getSchemWirePoints(crossA).length >= 4, 'cross A keeps waypoints');

    const routed = {
        id: 70, points: [App.pinBoardPos(r1, 0), App.pinBoardPos(r2, 1)],
        width: 0.5, net: 'SIG1', schemWire: true, waypoints: [{ x: 0, y: -30 }]
    };
    App.traces = [routed];
    App._schemWireCache = null;
    const wpts = App.getSchemWirePoints(routed);
    assert(wpts.some(p => Math.hypot(p.x - 0, p.y + 30) < 2), 'user waypoints are not auto-route rewritten');

    App.interaction.schemWireStart = { compId: r1.id, pinIndex: 0 };
    App.interaction.schemWireInterior = [];
    const pin = SchematicView.schemPinWorld(r1, 0);
    const hv = App._snapSchemWirePoint(pin.x + 40, pin.y + 1);
    assert(hv.kind === 'h' && Math.abs(hv.y - pin.y) < 1e-6, 'hv45 rubber-band is H from last corner');
    App.params.routeAngle = 'free';
    const fr = App._snapSchemWirePoint(pin.x + 40, pin.y + 1);
    assert(fr.kind !== 'h', 'free rubber-band does not H/V/45-pull');
    App.params.routeAngle = 'hv45';
    App.interaction.schemWireInterior = [{ x: pin.x + 20, y: pin.y + 15 }];
    const hv2 = App._snapSchemWirePoint(pin.x + 40, pin.y + 16);
    assert(hv2.kind === 'h' && Math.abs(hv2.y - (pin.y + 15)) < 1e-6, 'hv45 locks to last interior corner Y');
}

// Schematic wire -> board trace: plain pin-to-pin wires must route around
// component bodies/pads and other nets (NET_4/NET_5 short regression).
{
    const mkGnd = (id, x, y) => ({
        id, type: 'gnd', x, y, rotation: 0, size: 0, label: '', layer: 'top',
        pins: clonePins('gnd', 0), schemX: x * 2, schemY: y * 2
    });
    const a = mkGnd(1, -20, 0);
    const b = mkGnd(2, 20, 0);
    const r1 = { id: 3, type: 'resistor', x: 0, y: 0, rotation: 0, size: 0, label: 'R1', layer: 'top', pins: clonePins('resistor', 0) };
    const c = mkGnd(4, 4, 0.5);

    App.components = [a, b, r1, c];
    App.traces = [{ id: 10, points: [{ x: 4, y: 0.5 }, { x: 4, y: 3 }], width: 0.5, layer: 'top', net: 'NET_5' }];
    App.nets = [];
    App.board = { width: 60, height: 40 };
    App.params = Object.assign({}, App.params, { traceWidth: 0.5, minTraceWidth: 0.38, minClearance: 0.38 });
    App.idCounter = 100;
    App.undoStack = [];
    App.redoStack = [];
    App.render = () => {};

    const pa = App.pinBoardPos(a, 0), pb = App.pinBoardPos(b, 0);
    // Guard: the un-routed straight line shorts NET_5 (reproduces the bug).
    const guard = {
        board: App.board, components: App.components, params: App.params,
        traces: [App.traces[0], { id: 99, points: [pa, pb], width: 0.5, layer: 'top', net: 'NET_4' }]
    };
    assert(ctx.computeDrcViolations(guard).some(v => v.type === 'clearance'), 'straight NET_4 line shorts NET_5 (scenario guard)');

    App.createSchemWire({ compId: a.id, pinIndex: 0 }, { compId: b.id, pinIndex: 0 });
    const tr = App.traces.find(t => t.schemWire && t.id !== 10);
    assert(tr, 'schematic wire created a board trace');
    const lastPt = tr.points[tr.points.length - 1];
    assert(Math.hypot(tr.points[0].x - pa.x, tr.points[0].y - pa.y) < 1e-6 && Math.hypot(lastPt.x - pb.x, lastPt.y - pb.y) < 1e-6, 'routed leg snaps to pad centers');
    assert(tr.schemEnds && tr.schemEnds[0].compId === a.id && tr.schemEnds[1].compId === b.id, 'schemEnds metadata preserved');

    // R1 0805 body: 2 x 1.25 at origin; the leg must clear its edges by half trace width.
    const hw = 1, hh = 0.625;
    const edges = [[-hw, -hh, hw, -hh], [hw, -hh, hw, hh], [hw, hh, -hw, hh], [-hw, hh, -hw, -hh]];
    let minBody = Infinity;
    for (let i = 0; i + 1 < tr.points.length; i++) {
        for (const e of edges) {
            minBody = Math.min(minBody, ctx.segSegDistance(tr.points[i], tr.points[i + 1], { x: e[0], y: e[1] }, { x: e[2], y: e[3] }));
        }
    }
    assert(minBody >= 0.25 - 1e-6, 'NET_4 leg keeps R1 body clear (min gap ' + minBody.toFixed(2) + 'mm)');

    const shorts = ctx.computeDrcViolations(App).filter(v => v.type === 'clearance');
    assert(shorts.length === 0, 'no clearance short after routing (' + shorts.map(v => v.msg).join('; ') + ')');
}

// Schematic wiring regressions: free-end drag, and overlapping-wire hit priority.
{
    const mk = (id, x, y) => ({ id, type: 'resistor', x, y, rotation: 0, size: 0, label: 'C' + id, layer: 'top', pins: clonePins('resistor', 0), schemX: x * 4, schemY: y * 4 });
    const a = mk(1, 0, 0);
    const b = mk(2, 40, 0);
    App.components = [a, b];
    App.nets = [];
    App.idCounter = 500;
    App.undoStack = [];
    App.redoStack = [];
    App.render = () => {};

    const pinA = SchematicView.schemPinWorld(a, 0);
    const join0 = { x: pinA.x - 100, y: pinA.y + 60 };
    const stub = {
        id: 501,
        points: [App.pinBoardPos(a, 0), { x: a.x - 25, y: a.y + 15 }],
        width: 0.5, layer: 'top', net: 'FREE1', schemWire: true,
        schemEnds: [{ compId: a.id, pinIndex: 0 }, null],
        schemJoin: { x: join0.x, y: join0.y }
    };
    App.traces = [stub];
    App._schemWireCache = null;
    const poly0 = App.getSchemWirePoints(stub);
    assert(poly0 && poly0.length >= 3, 'stub pin->join polyline has a corner');
    assert(App.schemFreeEndIndex(stub, poly0) === poly0.length - 1, 'free end index is the last point');

    // Grab the tail segment and slide it: the free end (and schemJoin) must follow.
    const seg = poly0.length - 2;
    const prepared = App.prepareSchemSegDrag(stub, seg);
    const poly1 = App.getSchemWirePoints(stub);
    assert(prepared === seg, 'no jog inserted at a free end');
    assert(poly1.length === poly0.length, 'free-end drag adds no kink point');
    App.applySchemSegDrag(stub, prepared, App.schemSegAxis(poly1[prepared], poly1[prepared + 1]), poly1[prepared], poly1[prepared + 1], 0, 30);
    const poly2 = App.getSchemWirePoints(stub);
    const tail = poly2[poly2.length - 1];
    assert(Math.hypot(tail.x - join0.x, tail.y - (join0.y + 30)) < 1e-6, 'free end follows the cursor');
    assert(Math.hypot(stub.schemJoin.x - join0.x, stub.schemJoin.y - (join0.y + 30)) < 1e-6, 'schemJoin follows the free end');
    let dup = 0;
    for (let i = 0; i + 1 < poly2.length; i++) if (Math.hypot(poly2[i + 1].x - poly2[i].x, poly2[i + 1].y - poly2[i].y) < 1e-9) dup++;
    assert(dup === 0, 'no duplicate points left in the polyline');

    // Overlapping wires: the top-drawn (later) trace wins the hit test.
    const w1 = { id: 502, points: [App.pinBoardPos(a, 0), App.pinBoardPos(b, 0)], width: 0.5, layer: 'top', net: 'OVER1', schemWire: true, waypoints: [{ x: 0, y: 0 }] };
    const w2 = { id: 503, points: [App.pinBoardPos(a, 0), App.pinBoardPos(b, 0)], width: 0.5, layer: 'top', net: 'OVER2', schemWire: true, waypoints: [{ x: 0, y: 0 }] };
    App.traces = [w1, w2];
    App._schemWireCache = null;
    const p1 = App.getSchemWirePoints(w1), p2 = App.getSchemWirePoints(w2);
    const mid = { x: (p1[0].x + p1[p1.length - 1].x) / 2, y: (p1[0].y + p1[p1.length - 1].y) / 2 };
    const hit = App.hitSchemWire(mid.x, mid.y);
    assert(hit && hit.trace.id === w2.id, 'exact-overlap hit picks the later (top-drawn) wire');
}

// attachSchemFreeEnd: dropping a dragged free end on a pin makes a real connection.
{
    const mk = (id, x, y) => ({ id, type: 'resistor', x, y, rotation: 0, size: 0, label: 'C' + id, layer: 'top', pins: clonePins('resistor', 0), schemX: x * 4, schemY: y * 4 });
    const a = mk(1, 0, 0);
    const b = mk(2, 40, 0);
    App.components = [a, b];
    App.nets = [];
    App.idCounter = 600;
    App.undoStack = [];
    App.redoStack = [];
    App.render = () => {};
    if (!App.ensureCopperJunctionVertices) App.ensureCopperJunctionVertices = () => {};   // lives in trace-ops.js

    const pinA = SchematicView.schemPinWorld(a, 0);
    const join0 = { x: pinA.x - 100, y: pinA.y + 60 };
    const stub = {
        id: 601,
        points: [App.pinBoardPos(a, 0), { x: a.x - 25, y: a.y + 15 }],
        width: 0.5, layer: 'top', net: 'FREE1', schemWire: true,
        schemEnds: [{ compId: a.id, pinIndex: 0 }, null],
        schemJoin: { x: join0.x, y: join0.y }
    };
    App.traces = [stub];
    App._schemWireCache = null;

    const pinB = SchematicView.schemPinWorld(b, 0);
    const ok = App.attachSchemFreeEnd(stub, { x: pinB.x, y: pinB.y, kind: 'pin', compId: b.id, pinIndex: 0 });
    assert(ok === true, 'pin drop attaches');
    assert(stub.schemEnds[1].compId === b.id && stub.schemEnds[1].pinIndex === 0, 'free end becomes the pin end');
    assert(!stub.schemJoin, 'schemJoin cleared once attached');
    assert(!!stub.net, 'stub net resolved from the two pins');
    assert(stub.waypoints && stub.waypoints.length >= 1, 'drawn shape preserved as waypoints');

    // Dropping on empty grid does nothing (no attach).
    const stub2 = {
        id: 602,
        points: [App.pinBoardPos(a, 1), { x: a.x + 25, y: a.y - 15 }],
        width: 0.5, layer: 'top', net: 'FREE2', schemWire: true,
        schemEnds: [{ compId: a.id, pinIndex: 1 }, null],
        schemJoin: { x: pinA.x - 140, y: pinA.y - 60 }
    };
    App.traces = [stub, stub2];
    App._schemWireCache = null;
    assert(App.attachSchemFreeEnd(stub2, { x: 123, y: 45, kind: 'grid' }) === false, 'grid drop leaves the end free');
    assert(!!stub2.schemJoin, 'grid drop keeps schemJoin');

    // Dropping on another wire shares its net.
    const other = {
        id: 603,
        points: [App.pinBoardPos(a, 0), App.pinBoardPos(b, 0)],
        width: 0.5, layer: 'top', net: 'NET_X', schemWire: true, waypoints: [{ x: 0, y: 0 }]
    };
    App.traces = [other, stub2];
    App._schemWireCache = null;
    const op = App.getSchemWirePoints(other);
    const midO = { x: (op[0].x + op[op.length - 1].x) / 2, y: (op[0].y + op[op.length - 1].y) / 2 };
    assert(App.attachSchemFreeEnd(stub2, { x: midO.x, y: midO.y, kind: 'wire', trace: other }) === true, 'wire drop reports attached');
    assert(stub2.net === 'NET_X', 'stub adopts the other wire net');
    assert(!!stub2.schemJoin, 'stub keeps its free end (joint is positional)');
}

// ---- Netlist tree legs: spanning tree (n-1), not every pin pair ----
{
    const comps = [
        { id: 1, type: 'resistor', x: 0, y: 0, pins: clonePins('resistor', 0), schemX: -200, schemY: 0 },
        { id: 2, type: 'resistor', x: 10, y: 0, pins: clonePins('resistor', 0), schemX: -100, schemY: 0 },
        { id: 3, type: 'resistor', x: 20, y: 0, pins: clonePins('resistor', 0), schemX: 0, schemY: 0 },
        { id: 4, type: 'resistor', x: 30, y: 0, pins: clonePins('resistor', 0), schemX: 100, schemY: 0 },
        { id: 5, type: 'resistor', x: 40, y: 0, pins: clonePins('resistor', 0), schemX: 200, schemY: 0 }
    ];
    App.components = comps;
    App.traces = [];
    App.netlist = { NET_T: [
        { compId: 1, pin: '1' }, { compId: 2, pin: '1' }, { compId: 3, pin: '1' },
        { compId: 4, pin: '1' }, { compId: 5, pin: '1' }
    ] };
    App._schemWireCache = null;
    const legs = App._netlistTreeLegs(App.netlist.NET_T);
    assert(legs.length === 4, '5-pin net yields 4 tree legs, not 10 pairs');
    const touched = new Set();
    legs.forEach(l => { touched.add(l.a.comp.id); touched.add(l.b.comp.id); });
    assert(touched.size === 5, 'tree spans all 5 components');
    const wires = App._netlistSchemWires();
    assert(wires.length === 4, 'netlist wires match tree count');
    const keys = legs.map(l => 'nl:NET_T:' + l.i + ':' + l.j).join('|');
    assert(wires.map(w => w.id).join('|') === keys, 'wire ids match tree keys');
    const legs2 = App._netlistTreeLegs(App.netlist.NET_T);
    assert(JSON.stringify(legs2.map(l => [l.i, l.j])) === JSON.stringify(legs.map(l => [l.i, l.j])), 'tree is deterministic');
    const tied = App._netlistTreeLegs([{ compId: 1, pin: '1' }, { compId: 1, pin: '2' }]);
    assert(tied.length === 0, 'same-component pins tie with no leg');
    App.netlist = null;
    App._schemWireCache = null;
}

console.log('schematic-layout tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
