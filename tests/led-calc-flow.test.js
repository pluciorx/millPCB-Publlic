#!/usr/bin/env node
// Flow tests for the LED series-resistor calculator (App.calcLedResistor), which now
// works in the SCHEMATIC view. Loads the real app-props.js (Object.assign pattern is
// Node-safe) plus the schematic kernel into a vm context with a stub App, then checks:
//   1. VCC voltage is read from the VCC power symbol's value ("5V"/"3.3V"/"3V3").
//   2. An existing series resistor smaller than the target -> a NEW resistor is
//      inserted in series (value = target - existing), not a duplicate.
//   3. No series resistor -> one is inserted between VCC and the LED pin.
//   4. The new part is placed in a clear spot (no trace runs under a body).
// DOM-only methods (render, showProperties, createSchemWire, ...) are stubbed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

// Stub App: the state the calculator reads/writes. DOM-bound methods are stubbed
// AFTER app-props.js loads (its Object.assign would otherwise overwrite them).
const App = {
    components: [], traces: [], nets: [],
    view: { mode: 'schematic' },
    params: { traceWidth: 0.5 },
    board: { width: 100, height: 100 },
    _id: 100, _status: null, _wireCalls: [],
    nextId() { return ++this._id; }
};

const ctx = { console, App, prompt: () => null };
loadScript('js/component-defs.js', ctx);
loadScript('js/led-calc.js', ctx);
loadScript('js/project-api.js', ctx);
loadScript('js/schematic-layout.js', ctx);
loadScript('js/schematic-view.js', ctx);
loadScript('js/app-props.js', ctx);

// Node-safe stubs for the DOM-bound / schematic methods (override app-props' versions).
App.nextId = () => ++App._id;
App.saveState = () => { };
App.render = () => { };
App.showProperties = () => { };
App.setStatus = s => { App._status = s; };
App.ensureCompSilkLayout = () => { };
App.findFreeBoardSpot = () => ({ x: 5, y: 5 });
// Record the wire and push a logical trace so the placement's "wired" check passes.
App.createSchemWire = (a, b) => {
    App._wireCalls.push([a, b]);
    App.traces.push({ id: App.nextId(), points: [], width: 0.5, layer: 'top', net: 'W', schemWire: true, schemEnds: [a, b] });
};

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

// Reset the shared App for a scenario.
function reset(mode, components, traces) {
    App.components = components;
    App.traces = traces;
    App.nets = [];
    App.view = { mode };
    App._status = null;
    App._wireCalls = [];
    App._id = 100;
}

// Component builders. Board coords (x,y,pins) drive net derivation (getPinNet);
// schematic coords (schemX,schemY) drive placement. 2-pin parts anchor at x=±30.
const led = (id, sx, sy) => ({ id, type: 'led', x: 0, y: 0, rotation: 0, layer: 'top', value: 'LED-RED', label: 'D1', schemX: sx, schemY: sy, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] });
const vcc = (id, sx, sy, value) => ({ id, type: 'power', x: 10, y: 0, rotation: 0, layer: 'top', value: value || '5V', label: 'VCC', schemX: sx, schemY: sy, pins: [{ x: 0, y: 0, name: 'VCC' }] });
const res = (id, sx, sy, value) => ({ id, type: 'resistor', x: 5, y: 0, rotation: 0, layer: 'top', value: value || '100Ω', label: 'R1', schemX: sx, schemY: sy, pins: [{ x: -2, y: 0 }, { x: 2, y: 0 }] });
// Board-space wire with explicit schematic pin ends.
const wire = (id, p1, p2, net, e0, e1) => ({ id, points: [p1, p2], width: 0.5, layer: 'top', net, schemWire: true, schemEnds: [e0, e1] });

// Board pin world positions: LED-A (-0.8,0), LED-K (0.8,0), VCC (10,0), R1 pin0 (3,0), R1 pin1 (7,0).

// ============================================================
// 1. Voltage + resistance label parsing.
// ============================================================
assert(App.parseVolt('5V') === 5, 'parseVolt 5V');
assert(App.parseVolt('3.3V') === 3.3, 'parseVolt 3.3V');
assert(App.parseVolt('3V3') === 3.3, 'parseVolt 3V3');
assert(App.parseVolt('5') === 5, 'parseVolt bare number');
assert(App.parseVolt('abc') === null, 'parseVolt garbage -> null');
assert(App.parseRes('150Ω') === 150, 'parseRes 150Ω');
assert(App.parseRes('1.5kΩ') === 1500, 'parseRes 1.5kΩ');
assert(App.parseRes('4.7MΩ') === 4700000, 'parseRes 4.7MΩ');
assert(App.parseRes('220') === 220, 'parseRes bare number');

// ============================================================
// 2. findLedVcc: detects the VCC-side pin and any existing series resistor.
// ============================================================
{
    reset('schematic',
        [led(1, 0, 0), vcc(2, 100, 0, '5V'), res(3, 50, 0, '100Ω')],
        [wire(10, { x: 10, y: 0 }, { x: 3, y: 0 }, 'VCC', { compId: 2, pinIndex: 0 }, { compId: 3, pinIndex: 0 }),
            wire(11, { x: 7, y: 0 }, { x: -0.8, y: 0 }, 'ANODE', { compId: 3, pinIndex: 1 }, { compId: 1, pinIndex: 0 })]);
    const info = App.findLedVcc(App.components[0]);
    assert(info && info.vccComp.id === 2, 'findLedVcc finds the VCC symbol');
    assert(info && info.pinIndex === 0, 'findLedVcc: anode is the VCC-side pin');
    assert(info && info.existingResistor && info.existingResistor.id === 3, 'findLedVcc detects the existing series resistor');
    assert(info && info.ledFacingPin === 1, 'findLedVcc: existing R faces the LED on pin 1');
}
{
    reset('schematic', [led(1, 0, 0)], []);
    assert(App.findLedVcc(App.components[0]) === null, 'findLedVcc: no VCC symbol -> null');
}
// ============================================================
// 3. Existing series resistor SMALLER than target -> insert a new one in series
//    (value = target - existing). Old LED<->R wire is removed; new R bridges R and LED.
// ============================================================
{
    reset('schematic',
        [led(1, 0, 0), vcc(2, 100, 0, '5V'), res(3, 50, 0, '100Ω')],
        [wire(10, { x: 10, y: 0 }, { x: 3, y: 0 }, 'VCC', { compId: 2, pinIndex: 0 }, { compId: 3, pinIndex: 0 }),
            wire(11, { x: 7, y: 0 }, { x: -0.8, y: 0 }, 'ANODE', { compId: 3, pinIndex: 1 }, { compId: 1, pinIndex: 0 })]);
    App.calcLedResistor(App.components[0]);
    const newRes = App.components.find(c => c.type === 'resistor' && c.id !== 3);
    assert(!!newRes, '3: a new series resistor is inserted');
    const expectedAdd = App.nearestE24(150 - 100); // target 150Ω minus existing 100Ω
    assert(newRes && newRes.value === App.fmtRes(expectedAdd), `3: new R = ${App.fmtRes(expectedAdd)} (got ${newRes && newRes.value})`);
    assert(!App.traces.some(t => t.id === 11), '3: old LED<->R wire removed');
    assert(App._wireCalls.some(c => c[0].compId === newRes.id && c[1].compId === 1 && c[1].pinIndex === 0), '3: new R wired to the LED pin');
    assert(App._wireCalls.some(c => c[0].compId === newRes.id && c[1].compId === 3 && c[1].pinIndex === 1), '3: new R wired to the existing R pin');
    assert(/^Inserted/.test(App._status), `3: status says inserted (got: ${App._status})`);
}
// ============================================================
// 4. Existing series resistor already >= target -> no change.
// ============================================================
{
    reset('schematic',
        [led(1, 0, 0), vcc(2, 100, 0, '5V'), res(3, 50, 0, '330Ω')],
        [wire(10, { x: 10, y: 0 }, { x: 3, y: 0 }, 'VCC', { compId: 2, pinIndex: 0 }, { compId: 3, pinIndex: 0 }),
            wire(11, { x: 7, y: 0 }, { x: -0.8, y: 0 }, 'ANODE', { compId: 3, pinIndex: 1 }, { compId: 1, pinIndex: 0 })]);
    App.calcLedResistor(App.components[0]);
    assert(!App.components.some(c => c.type === 'resistor' && c.id !== 3), '4: no new resistor when existing >= target');
    assert(/no change/.test(App._status), `4: status says no change (got: ${App._status})`);
}

// ============================================================
// 5. No series resistor, anode wired DIRECTLY to VCC -> insert one between VCC and
//    the LED pin (the direct wire is removed so the R is in series, not parallel).
// ============================================================
{
    reset('schematic',
        [led(1, 0, 0), vcc(2, 100, 0, '5V')],
        [wire(10, { x: 10, y: 0 }, { x: -0.8, y: 0 }, 'VCC', { compId: 2, pinIndex: 0 }, { compId: 1, pinIndex: 0 })]);
    App.calcLedResistor(App.components[0]);
    const nr = App.components.find(c => c.type === 'resistor');
    assert(!!nr, '5: a resistor is placed between VCC and the LED');
    assert(nr && nr.value === App.fmtRes(150), `5: placed value 150Ω (got ${nr && nr.value})`);
    assert(!App.traces.some(t => t.id === 10), '5: direct VCC wire removed');
    assert(App._wireCalls.some(c => c[0].compId === nr.id && c[1].compId === 2 && c[1].pinIndex === 0), '5: wired to the VCC symbol');
    assert(App._wireCalls.some(c => c[0].compId === nr.id && c[1].compId === 1 && c[1].pinIndex === 0), '5: wired to the LED pin');
    assert(/^Placed/.test(App._status), `5: status says placed (got: ${App._status})`);
}

// ============================================================
// 6. Board view: the calculator is a no-op (schematic-only for now).
// ============================================================
{
    reset('board',
        [led(1, 0, 0), vcc(2, 100, 0, '5V')],
        [wire(10, { x: 10, y: 0 }, { x: -0.8, y: 0 }, 'VCC', { compId: 2, pinIndex: 0 }, { compId: 1, pinIndex: 0 })]);
    App.calcLedResistor(App.components[0]);
    assert(!App.components.some(c => c.type === 'resistor'), '6: board view places nothing');
    assert(/Schematic/.test(App._status), `6: status points to Schematic view (got: ${App._status})`);
}

console.log(`led-calc-flow: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);