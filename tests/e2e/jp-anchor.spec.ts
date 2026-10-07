// JP follow modes + schematic T-join / corners / routeAngle (status-bar persist).
import { test, expect } from '@playwright/test';
import path from 'path';
import { pathToFileURL } from 'url';

const INDEX = pathToFileURL(path.resolve(__dirname, '..', '..', 'index.html')).href;

declare const App: any;
declare const ProjectApi: any;
declare const SchematicView: any;

type Page = any;

async function toScreen(page: Page, wx: number, wy: number) {
    return page.evaluate(([x, y]) => {
        const s = App.worldToScreen(x, y);
        const r = document.getElementById('board-canvas')!.getBoundingClientRect();
        return { x: r.left + s.x, y: r.top + s.y };
    }, [wx, wy] as [number, number]);
}

async function clickWorld(page: Page, wx: number, wy: number) {
    const p = await toScreen(page, wx, wy);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
}

async function dragWorld(page: Page, from: [number, number], to: [number, number], steps = 8) {
    const a = await toScreen(page, from[0], from[1]);
    const b = await toScreen(page, to[0], to[1]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    await page.mouse.up();
}

async function resetBoard(page: Page) {
    await page.evaluate(() => {
        localStorage.removeItem('pcb-project');
        App.traces = [];
        App.components = [];
        App.vias = [];
        App.view.zoom = 4; App.view.panX = 0; App.view.panY = 0;
        App.render();
    });
}

async function placeJpOnTraces(page: Page) {
    await resetBoard(page);
    await page.evaluate(() => {
        App.traces.push({ id: 910, points: [{ x: 30, y: 50 }, { x: 10, y: 50 }], width: 0.6, layer: 'top', net: 'VCC' });
        App.traces.push({ id: 911, points: [{ x: 50, y: 50 }, { x: 70, y: 50 }], width: 0.6, layer: 'top', net: 'GND' });
        App.interaction.placingComponent = 'jumper';
        App.interaction.placingJumperKind = 'wire';
        App.interaction.placingSize = { jumper: 2 };
        App.render();
    });
    await clickWorld(page, 30, 50);
    await clickWorld(page, 50, 50);
}

test('Wire jumper follows a dragged copper vertex like a 2-point track', async ({ page }) => {
    await page.goto(INDEX);
    await page.waitForFunction('typeof App !== "undefined" && Array.isArray(App.traces)');
    await page.evaluate(() => { App.params.jumperFollow = 'pads'; App.syncStatusModeToggles(); });
    await placeJpOnTraces(page);

    const after = await page.evaluate(() => {
        const trA = App.traces.find((t: any) => t.id === 910);
        for (let i = 0; i < 6; i++) { trA.points[0].y += 1; App.anchorJumperPinsToTrace(trA); }
        const jp = App.components.find((c: any) => c.type === 'jumper');
        const r = (jp.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const pin1 = { x: jp.x + jp.pins[0].x * c - jp.pins[0].y * s, y: jp.y + jp.pins[0].x * s + jp.pins[0].y * c };
        const pin2 = { x: jp.x + jp.pins[1].x * c - jp.pins[1].y * s, y: jp.y + jp.pins[1].x * s + jp.pins[1].y * c };
        const end = trA.points[0];
        return {
            gap: Math.hypot(end.x - pin1.x, end.y - pin1.y),
            pin2y: pin2.y,
            span: jp.span,
            rot: jp.rotation || 0
        };
    });
    expect(after.gap).toBeLessThanOrEqual(0.05);
    expect(after.pin2y).toBeCloseTo(50, 1);
    expect(after.span).toBeGreaterThan(20.1);
    expect(Math.abs(after.rot)).toBeGreaterThan(5);
});

test('Follow joints: one vertex moves that hole; other stays; no polyline slide', async ({ page }) => {
    await page.goto(INDEX);
    await page.waitForFunction('typeof App !== "undefined" && Array.isArray(App.traces)');
    await page.evaluate(() => { App.params.jumperFollow = 'joints'; App.syncStatusModeToggles(); });
    await placeJpOnTraces(page);

    const out = await page.evaluate(() => {
        const trA = App.traces.find((t: any) => t.id === 910);
        for (let i = 0; i < 6; i++) { trA.points[0].y += 1; App.anchorJumperPinsToTrace(trA); }
        const jp = App.components.find((c: any) => c.type === 'jumper');
        const r = (jp.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const pin1 = { x: jp.x + jp.pins[0].x * c - jp.pins[0].y * s, y: jp.y + jp.pins[0].x * s + jp.pins[0].y * c };
        const pin2 = { x: jp.x + jp.pins[1].x * c - jp.pins[1].y * s, y: jp.y + jp.pins[1].x * s + jp.pins[1].y * c };
        const a = App.traces.find((t: any) => t.id === 910).points[0];
        const b = App.traces.find((t: any) => t.id === 911).points[0];
        return {
            d1: Math.hypot(pin1.x - a.x, pin1.y - a.y),
            pin2,
            b,
            span: jp.span
        };
    });
    expect(out.d1, 'pin 1 glued to moved vertex').toBeLessThanOrEqual(0.05);
    expect(Math.hypot(out.pin2.x - 50, out.pin2.y - 50), 'pin 2 stays').toBeLessThanOrEqual(0.2);
    expect(Math.hypot(out.b.x - 50, out.b.y - 50), 'no slide along far trace').toBeLessThanOrEqual(0.05);
    expect(out.span).toBeGreaterThan(20.1);
});

test('JP T-join on a trace is a normal draggable vertex', async ({ page }) => {
    await page.goto(INDEX);
    await page.waitForFunction('typeof App !== "undefined" && Array.isArray(App.traces)');
    await resetBoard(page);
    await page.evaluate(() => {
        App.traces.push({ id: 930, points: [{ x: 20, y: 65 }, { x: 80, y: 65 }], width: 0.6, layer: 'top', net: 'VCC' });
        App.interaction.placingComponent = 'jumper';
        App.interaction.placingJumperKind = 'wire';
        App.interaction.placingSize = { jumper: 2 };
        App.render();
    });
    await clickWorld(page, 45, 65);
    await clickWorld(page, 65, 65);

    const before = await page.evaluate(() => {
        const tr = App.traces.find((t: any) => t.id === 930);
        return { n: tr.points.length, hit: App.hitTraceVertex(45, 65) };
    });
    expect(before.n).toBeGreaterThanOrEqual(4);
    expect(before.hit).toBeTruthy();

    await dragWorld(page, [45, 65], [45, 72]);

    const after = await page.evaluate(() => {
        const tr = App.traces.find((t: any) => t.id === 930);
        const jp = App.components.find((c: any) => c.type === 'jumper');
        const r = (jp.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const pin1 = { x: jp.x + jp.pins[0].x * c - jp.pins[0].y * s, y: jp.y + jp.pins[0].x * s + jp.pins[0].y * c };
        const pin2 = { x: jp.x + jp.pins[1].x * c - jp.pins[1].y * s, y: jp.y + jp.pins[1].x * s + jp.pins[1].y * c };
        const v = tr.points.find((p: any) => Math.abs(p.x - 45) < 0.3);
        return { vy: v && v.y, pin1y: pin1.y, pin2, n: tr.points.length };
    });
    expect(after.n).toBeGreaterThanOrEqual(4);
    expect(after.vy).toBeGreaterThan(70);
    expect(after.pin1y).toBeGreaterThan(70);
    expect(Math.hypot(after.pin2.x - 65, after.pin2.y - 65)).toBeLessThanOrEqual(0.3);
});

test('Body drag still carries mid-segment copper', async ({ page }) => {
    await page.goto(INDEX);
    await page.waitForFunction('typeof App !== "undefined" && Array.isArray(App.traces)');
    await resetBoard(page);
    await page.evaluate(() => {
        App.traces.push({ id: 920, points: [{ x: 20, y: 65 }, { x: 80, y: 65 }], width: 0.6, layer: 'top', net: 'VCC' });
        App.interaction.placingComponent = 'jumper';
        App.interaction.placingJumperKind = 'wire';
        App.interaction.placingSize = { jumper: 2 };
        App.view.visibleLayers.silkTop = false;
        App.render();
    });
    await clickWorld(page, 45, 65);
    await clickWorld(page, 65, 65);
    await dragWorld(page, [55, 66.2], [55, 70.5]);

    const gapE = await page.evaluate(() => {
        const jp = App.components[App.components.length - 1];
        const r = (jp.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const pin1 = { x: jp.x + jp.pins[0].x * c - jp.pins[0].y * s, y: jp.y + jp.pins[0].x * s + jp.pins[0].y * c };
        const pts = App.traces.find((t: any) => t.id === 920).points;
        let d = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
            const ax = pts[i].x, ay = pts[i].y, bx = pts[i + 1].x - ax, by = pts[i + 1].y - ay;
            const len2 = bx * bx + by * by || 1e-9;
            let t = ((pin1.x - ax) * bx + (pin1.y - ay) * by) / len2;
            t = Math.max(0, Math.min(1, t));
            d = Math.min(d, Math.hypot(pin1.x - (ax + t * bx), pin1.y - (ay + t * by)));
        }
        return { gap: d, points: pts.length };
    });
    expect(gapE.gap).toBeLessThanOrEqual(0.05);
    expect(gapE.points).toBeGreaterThanOrEqual(4);
});

test('Status-bar toggles persist on reload; schematic T-join, cross, corners, routeAngle', async ({ page }) => {
    await page.goto(INDEX);
    await page.waitForFunction('typeof App !== "undefined" && Array.isArray(App.traces)');

    await expect(page.locator('#status-route-angle')).toHaveText('45°');
    await page.locator('#status-route-angle').click();
    await expect(page.locator('#status-route-angle')).toHaveText('Free');
    expect(await page.evaluate(() => App.params.routeAngle)).toBe('free');

    await page.evaluate(() => {
        localStorage.setItem('pcb-project', JSON.stringify(ProjectApi.serialize(App)));
    });
    await page.reload();
    await page.waitForFunction('typeof App !== "undefined" && Array.isArray(App.traces)');
    await expect(page.locator('#status-route-angle')).toHaveText('Free');
    expect(await page.evaluate(() => App.params.routeAngle)).toBe('free');

    const oldFile = await page.evaluate(() => {
        App.applyProjectData({ board: { width: 80 }, params: { gridSize: 2 } });
        return { follow: App.params.jumperFollow, angle: App.params.routeAngle, grid: App.params.gridSize };
    });
    expect(oldFile.follow).toBe('pads');
    expect(oldFile.angle).toBe('hv45');
    expect(oldFile.grid).toBe(2);

    const schem = await page.evaluate(() => {
        App.traces = [];
        App.components = [];
        const mkR = (id: number, x: number, y: number, sx: number, sy: number) => {
            const def = ComponentDefs.get('resistor');
            const size = ComponentDefs.getSize(def, 0);
            return {
                id, type: 'resistor', x, y, schemX: sx, schemY: sy, rotation: 0, size: 0, label: 'R' + id,
                pins: size.pins.map((p: any) => ({ ...p })), layer: 'top'
            };
        };
        const r1 = mkR(1, -10, 0, -80, 0);
        const r2 = mkR(2, 10, 0, 80, 0);
        const r3 = mkR(3, 0, 10, 0, 80);
        App.components.push(r1, r2, r3);
        const p1 = App.pinBoardPos(r1, 1);
        const p2 = App.pinBoardPos(r2, 0);
        const host = { id: 50, points: [p1, p2], width: 0.5, layer: 'top', net: 'SIG1', schemWire: true };
        App.traces.push(host);
        App._schemWireCache = null;
        const hostPts = App.getSchemWirePoints(host);
        const mid = { x: (hostPts[0].x + hostPts[1].x) / 2, y: (hostPts[0].y + hostPts[1].y) / 2 };
        App.interaction.schemWireInterior = [{ x: 0, y: 40 }];
        App.createSchemTJoin({ compId: r3.id, pinIndex: 0 }, { trace: host, segIndex: 0, x: mid.x, y: mid.y }, mid.x, mid.y);
        const stub = App.traces.find((t: any) => t.schemJoin);
        const stubPts = stub ? App.getSchemWirePoints(stub) : null;
        const stubWp = !!(stub && stub.waypoints && stub.waypoints.length);

        const r4 = mkR(4, 0, -10, 0, -80);
        const r5 = mkR(5, 20, 10, 120, 80);
        App.components.push(r4, r5);
        const crossA = {
            id: 60,
            points: [App.pinBoardPos(r1, 0), App.pinBoardPos(r2, 1)],
            width: 0.5, layer: 'top', net: 'NETA', schemWire: true,
            waypoints: [{ x: -40, y: -40 }, { x: 40, y: 40 }]
        };
        const crossB = {
            id: 61,
            points: [App.pinBoardPos(r4, 0), App.pinBoardPos(r5, 0)],
            width: 0.5, layer: 'top', net: 'NETB', schemWire: true,
            waypoints: [{ x: -40, y: 40 }, { x: 40, y: -40 }]
        };
        App.traces.push(crossA, crossB);
        App._schemWireCache = null;
        const ca = App.getSchemWirePoints(crossA);
        const cb = App.getSchemWirePoints(crossB);

        App.createSchemWire({ compId: r1.id, pinIndex: 0 }, { compId: r2.id, pinIndex: 1 }, [{ x: 0, y: -30 }, { x: 20, y: -30 }]);
        const withWp = App.traces[App.traces.length - 1];
        App._schemWireCache = null;
        const wpPts = App.getSchemWirePoints(withWp);

        App.params.routeAngle = 'hv45';
        App.interaction.schemWireStart = { compId: r1.id, pinIndex: 0 };
        App.interaction.schemWireInterior = [];
        const pin = SchematicView.schemPinWorld(r1, 0);
        const hv = App._snapSchemWirePoint(pin.x + 40, pin.y + 1);
        App.params.routeAngle = 'free';
        const fr = App._snapSchemWirePoint(pin.x + 40, pin.y + 1);
        App.traces = [];
        App.components = [];
        App.params.routeAngle = 'hv45';
        App.interaction.tracePoints = [{ x: 0, y: 0 }];
        App.view.zoom = 4;
        const board45 = App.snapTraceDrawPoint(10, 0.2);
        App.params.routeAngle = 'free';
        const boardFree = App.snapTraceDrawPoint(10, 0.2);

        return {
            stubJoin: !!(stub && stub.schemJoin),
            stubCached: !!(stubPts && stubPts.length >= 2),
            stubWp,
            sameNet: stub && stub.net === host.net,
            crossNets: crossA.net !== crossB.net && !crossA.schemJoin && !crossB.schemJoin,
            crossKept: !!(ca && cb && ca.length >= 2 && cb.length >= 2),
            wpKept: !!(wpPts && wpPts.some((p: any) => Math.hypot(p.x - 0, p.y + 30) < 2)),
            hvKind: hv.kind,
            hvY: hv.y,
            pinY: pin.y,
            freeKind: fr.kind,
            board45kind: board45.kind,
            boardFreeKind: boardFree.kind
        };
    });

    expect(schem.stubJoin, 'T-join writes schemJoin').toBeTruthy();
    expect(schem.stubCached, 'T-stub stays in cache').toBeTruthy();
    expect(schem.stubWp, 'T-join keeps user waypoints').toBeTruthy();
    expect(schem.sameNet, 'T-join shares net').toBeTruthy();
    expect(schem.crossNets, 'crossing wires stay separate nets').toBeTruthy();
    expect(schem.crossKept).toBeTruthy();
    expect(schem.wpKept, 'user waypoints remain').toBeTruthy();
    expect(schem.hvY).toBeCloseTo(schem.pinY, 5);
    expect(schem.freeKind).not.toBe('h');
    expect(schem.board45kind).toBe('h');
    expect(schem.boardFreeKind).toBe('grid');
});
