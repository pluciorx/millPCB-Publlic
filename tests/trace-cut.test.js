#!/usr/bin/env node
// Cut must open a copper gap without touching components, and must clear
// stale hover/selection so the next board paint cannot throw.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath, context) {
    const filePath = path.join(__dirname, '..', relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInNewContext(code, context, { filename: filePath });
}

const documentStub = {
    getElementById() {
        return { innerHTML: '', textContent: '', style: {} };
    }
};

const ctx = {
    console,
    document: documentStub,
    setTimeout: () => {},
    App: {
        traces: [],
        components: [],
        vias: [],
        interaction: {
            selectedObject: null,
            selectedSegment: null,
            hoveredSegment: null,
            hoveredTraceVertex: null,
            draggingSegment: null,
            draggingVertex: null,
            contextTarget: null,
            selectedVertices: []
        },
        idCounter: 0,
        nextId() { return ++this.idCounter; },
        saveState() {},
        render() {},
        setStatus() {},
        showProperties() {}
    }
};

loadScript('js/trace-ops.js', ctx);
const App = ctx.App;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

function makeAppState() {
    App.idCounter = 10;
    App.components = [
        { id: 1, type: 'resistor', x: 0, y: 0 },
        { id: 2, type: 'capacitor', x: 10, y: 0 }
    ];
    App.traces = [{
        id: 5,
        width: 0.5,
        layer: 'top',
        net: 'SIG1',
        points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 20, y: 10 }
        ],
        segmentWidths: [0.5, 0.5, 0.5],
        curved: [false, false, false]
    }];
    App.interaction.hoveredSegment = { traceId: 5, segIndex: 2 };
    App.interaction.selectedSegment = { traceId: 5, segIndex: 1 };
    App.interaction.contextTarget = { type: 'trace', obj: App.traces[0], segIndex: 1 };
}

// 1. Mid-run cut splits into two traces and leaves a gap
{
    makeAppState();
    const compsBefore = App.components.length;
    const result = App._cutTraceGeometry(5, 1);
    assert(result === 'split', 'middle cut returns split');
    assert(App.traces.length === 2, 'split produces two traces');
    assert(App.traces[0].points.length === 2 && App.traces[1].points.length === 2, 'each half is a 2-point run');
    assert(App.traces[0].points[1].x === 10 && App.traces[0].points[1].y === 0, 'left half ends at the cut');
    assert(App.traces[1].points[0].x === 10 && App.traces[1].points[0].y === 10, 'right half starts after the cut');
    assert(App.components.length === compsBefore, 'split does not remove components');
    assert(App.components[0].id === 1 && App.components[1].id === 2, 'component ids unchanged');
}

// 2. Cutting the last segment trims; leftover hover index would be out of range
{
    makeAppState();
    const result = App._cutTraceGeometry(5, 2);
    assert(result === 'trim', 'last-segment cut returns trim');
    assert(App.traces.length === 1, 'trim keeps one trace');
    assert(App.traces[0].points.length === 3, 'last segment dropped, 3 points remain');
    assert(App.components.length === 2, 'trim does not remove components');
}

// 3. Two-point run: cutting the only segment deletes that copper
{
    makeAppState();
    App.traces[0].points = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
    App.traces[0].segmentWidths = [0.5];
    const result = App._cutTraceGeometry(5, 0);
    assert(result === 'delete', '2-point cut returns delete');
    assert(App.traces.length === 0, 'only-segment cut removes that trace');
    assert(App.components.length === 2, 'delete-cut does not remove components');
}

// 4. Invalid index is a no-op
{
    makeAppState();
    const snapshot = JSON.stringify(App.traces);
    assert(App._cutTraceGeometry(5, 99) === null, 'out-of-range cut returns null');
    assert(App._cutTraceGeometry(999, 0) === null, 'missing trace returns null');
    assert(JSON.stringify(App.traces) === snapshot, 'invalid cut mutates nothing');
    assert(App.components.length === 2, 'invalid cut leaves components');
}

// 5. Public cut clears stale pointer state (the zoom-crash leftover)
{
    makeAppState();
    App.cutTraceSegment(5, 1);
    assert(App.interaction.hoveredSegment === null, 'cut clears hoveredSegment');
    assert(App.interaction.selectedSegment === null, 'cut clears selectedSegment');
    assert(App.interaction.contextTarget === null, 'cut clears contextTarget');
    assert(App.interaction.hoveredTraceVertex === null, 'cut clears hoveredTraceVertex');
    assert(App.components.length === 2, 'public cut leaves components');
    assert(App.traces.length === 2, 'public cut still splits');
}

// 6. cutSelectedSegment accepts an explicit snapshot (menu hide may clear live state)
{
    makeAppState();
    const id = App.traces[0].id;
    App.interaction.contextTarget = null;
    App.interaction.selectedSegment = null;
    App.cutSelectedSegment(id, 0);
    assert(App.traces.length === 1, 'explicit ids still cut after live state was cleared');
    assert(App.traces[0].points[0].x === 10 && App.traces[0].points[0].y === 0, 'first segment removed');
    assert(App.components.length === 2, 'explicit-id cut leaves components');
}

function stubPins() {
    App.getCompPins = function (c) { return c.pins || []; };
    App.pinBoardPos = function (c, i) {
        const p = this.getCompPins(c)[i];
        return p ? { x: c.x + p.x, y: c.y + p.y } : null;
    };
}

// 7. Cutting board copper that joins two schematic pins keeps the logical wire
{
    stubPins();
    App.idCounter = 20;
    App.components = [
        { id: 1, x: 0, y: 0, pins: [{ x: 0, y: 0 }] },
        { id: 2, x: 20, y: 0, pins: [{ x: 0, y: 0 }] }
    ];
    App.traces = [
        {
            id: 8, net: 'SIG1', schemWire: true, width: 0.5, layer: 'top',
            points: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
            schemEnds: [{ compId: 1, pinIndex: 0 }, { compId: 2, pinIndex: 0 }]
        },
        {
            id: 9, net: 'SIG1', width: 0.5, layer: 'top',
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
            segmentWidths: [0.5, 0.5]
        }
    ];
    App.cutTraceSegment(9, 0);
    assert(App.traces.some(t => t.schemWire && t.net === 'SIG1'), 'existing schematic wire survives a copper cut');
    assert(!App.traces.some(t => t.id === 9 && t.points.length === 3), 'copper run is no longer intact');
    assert(App._copperConnectsPins([{ compId: 1, pinIndex: 0 }, { compId: 2, pinIndex: 0 }]) === false, 'pins are not copper-connected after the cut');
}

// 8. Dual-purpose board trace: cut copper, spawn a logical schematic wire
{
    stubPins();
    App.idCounter = 30;
    App.components = [
        { id: 1, x: 0, y: 0, pins: [{ x: 0, y: 0 }] },
        { id: 2, x: 8, y: 0, pins: [{ x: 0, y: 0 }] }
    ];
    App.traces = [{
        id: 11, net: 'NET_4', width: 0.5, layer: 'top',
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }],
        segmentWidths: [0.5]
    }];
    App.cutTraceSegment(11, 0);
    const logical = App.traces.filter(t => t.schemWire);
    assert(logical.length === 1, 'cut of pin-to-pin copper keeps a schematic wire');
    assert(logical[0].schemEnds[0].compId === 1 && logical[0].schemEnds[1].compId === 2, 'logical wire remembers both pins');
    assert(!App.traces.some(t => t.id === 11), 'copper trace itself is gone');
}

console.log(`trace-cut tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
