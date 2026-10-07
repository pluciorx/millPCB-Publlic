#!/usr/bin/env node
// Automated HTTP (Streamable) MCP transport tests.
// Spawns mcp/server.mjs in MILLPCB_TRANSPORT=http mode and exercises /mcp over
// real HTTP: initialize/session lifecycle, tools, preview endpoints with token
// auth, MILLPCB_PROJECTS_DIR autosave and MILLPCB_RESTORE on restart.
// No extra deps: child_process + global fetch (Node 18+). Requires mcp/node_modules
// (npm ci --prefix mcp) because the server imports the MCP SDK.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

const ROOT = path.join(__dirname, '..');
const MCP_PORT = 18091, PREV_PORT = 17851;   // phase 1
const MCP2_PORT = 18092, PREV2_PORT = 17852; // phase 2 (token + restore)
const MCP3_PORT = 18093, PREV3_PORT = 17853; // phase 3 (autosave sweep)
const TOKEN = 'test-token-123';
const PROJ_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'millpcb-mcp-test-'));

const overall = setTimeout(() => { console.error('FAIL: overall timeout'); process.exit(1); }, 180000);

function startServer({ mcpPort, prevPort, token, restore, autosaveTtl } = {}) {
    const env = {
        ...process.env,
        MILLPCB_TRANSPORT: 'http',
        MILLPCB_MCP_PORT: String(mcpPort),
        MILLPCB_PREVIEW_PORT: String(prevPort),
        MILLPCB_PROJECTS_DIR: PROJ_DIR
    };
    delete env.MILLPCB_TOKEN;
    if (token) env.MILLPCB_TOKEN = token;
    if (restore) env.MILLPCB_RESTORE = '1';
    if (autosaveTtl) env.MILLPCB_AUTOSAVE_TTL_MS = String(autosaveTtl);
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errLog = '';
    child.stderr.on('data', d => { errLog += d; });
    return { child, log: () => errLog };
}

function waitForExit(child) {
    return new Promise(res => { if (child.exitCode !== null) return res(); child.once('exit', res); });
}

async function waitHealthy(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (r.ok) return true;
        } catch (e) { /* not up yet */ }
        await new Promise(res => setTimeout(res, 250));
    }
    return false;
}

/** MCP Streamable HTTP answers with application/json OR an SSE frame. */
function parseMcpBody(text) {
    const t = String(text).trim();
    if (t.startsWith('event:') || t.includes('\ndata: ')) {
        const line = t.split('\n').find(l => l.trimStart().startsWith('data:'));
        return JSON.parse(line.trimStart().slice(5).trim());
    }
    return JSON.parse(t);
}

/** Hold a named preview session open (what the millpcb.com tab does). */
async function holdSession(port, id, token) {
    const ac = new AbortController();
    const q = 'session=' + encodeURIComponent(id) + (token ? '&token=' + encodeURIComponent(token) : '');
    const r = await fetch(`http://127.0.0.1:${port}/events?${q}`, { signal: ac.signal });
    if (!r.ok) {
        const text = await r.text();
        return { ok: false, status: r.status, text, stop() {} };
    }
    const reader = r.body.getReader();
    (async () => {
        try { while (true) { const { done } = await reader.read(); if (done) break; } }
        catch (e) { /* aborted when the test drops the session */ }
    })();
    return { ok: true, status: r.status, stop() { ac.abort(); } };
}

async function mcpPost(port, body, { sessionId, token, urlOverride } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = urlOverride || `http://127.0.0.1:${port}/mcp`;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-http-test', version: '0' } } };
const NOTIF_INIT = { jsonrpc: '2.0', method: 'notifications/initialized' };
const toolCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } });

/** Non-background pixel run of an RGB PNG (bg = 22,26,34 schematic background). */
function pngContentRun(png) {
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    let off = 8; const idat = [];
    while (off + 8 <= png.length) {
        const len = png.readUInt32BE(off);
        const type = png.toString('ascii', off + 4, off + 8);
        if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
        off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    let minCol = w, maxCol = -1;
    for (let y = 0; y < h; y++) {
        const rowStart = y * (w * 3 + 1) + 1;
        for (let x = 0; x < w; x++) {
            const i3 = rowStart + x * 3;
            if (raw[i3] === 22 && raw[i3 + 1] === 26 && raw[i3 + 2] === 34) continue;
            if (x < minCol) minCol = x;
            if (x > maxCol) maxCol = x;
        }
    }
    return { w, h, runW: maxCol - minCol + 1 };
}

(async () => {
    // ================= PHASE 1: HTTP transport + projectsDir autosave =================
    const s1 = startServer({ mcpPort: MCP_PORT, prevPort: PREV_PORT });
    assert(await waitHealthy(PREV_PORT), 'phase1: preview server became healthy');
    if (failed) { console.error('--- spawned server stderr ---\n' + s1.log()); process.exit(1); }

    let r = await mcpPost(MCP_PORT, INIT);
    assert(r.status === 200, `phase1: initialize -> 200 (got ${r.status})`);
    const sid = r.headers.get('mcp-session-id');
    assert(!!sid, 'phase1: initialize returned mcp-session-id');
    let msg = parseMcpBody(await r.text());
    assert(msg.result && msg.result.serverInfo && msg.result.serverInfo.name === 'millpcb', 'phase1: initialize result carries serverInfo.millpcb');

    r = await mcpPost(MCP_PORT, NOTIF_INIT, { sessionId: sid });
    assert(r.status === 202, `phase1: initialized notification -> 202 (got ${r.status})`);

    r = await mcpPost(MCP_PORT, toolCall(2, 'millpcb_new_project'), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && msg.result.content[0].text.includes('"ok": true'), `phase1: millpcb_new_project ok (got ${msg.result.content[0].text.slice(0, 120)})`);

    r = await mcpPost(MCP_PORT, toolCall(25, 'millpcb_set_board', { width: 88, height: 66 }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const boardRes = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && boardRes.ok === true, `phase1: millpcb_set_board ok (got ${msg.result.content[0].text.slice(0, 160)})`);

    r = await mcpPost(MCP_PORT, toolCall(3, 'millpcb_add_component', { type: 'resistor', x: -10, y: 0 }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && msg.result.content[0].text.includes('"label": "R1"'), `phase1: add_component placed R1 (got ${msg.result.content[0].text.slice(0, 120)})`);

    r = await mcpPost(MCP_PORT, toolCall(4, 'millpcb_get_project', { full: true }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const proj = JSON.parse(msg.result.content[0].text).project;
    assert(proj.components.length === 1 && proj.components[0].type === 'resistor', 'phase1: get_project(full) shows the resistor');

    r = await mcpPost(MCP_PORT, toolCall(20, 'millpcb_add_component', { type: 'resistor', x: 10, y: 0 }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const addR2 = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && addR2.ok === true && addR2.component.label === 'R2', `phase1: add_component placed R2 (got ${msg.result.content[0].text.slice(0, 160)})`);
    const idR1 = proj.components[0].id, idR2 = addR2.component.id;

    r = await mcpPost(MCP_PORT, toolCall(40, 'millpcb_set_netlist', { nets: { SIG: [{ compId: idR1, pin: '2' }, { compId: idR2, pin: '1' }] } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const nlFirst = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && nlFirst.ok === true && nlFirst.view === 'schematic', `phase1: set_netlist opens the schematic (got ${msg.result.content[0].text.slice(0, 160)})`);

    r = await mcpPost(MCP_PORT, toolCall(41, 'millpcb_check', {
        type: 'circuit',
        rails: [{ net: 'SIG' }],
        unused: [{ compId: idR1, pin: '1' }, { compId: idR2, pin: '2' }]
    }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const sigElec = JSON.parse(msg.result.content[0].text);
    assert(sigElec.electricalOk === true && sigElec.status === 'NETLIST_VALID', `phase1: SIG contract opens the copper gate (got ${msg.result.content[0].text.slice(0, 180)})`);

    r = await mcpPost(MCP_PORT, toolCall(43, 'millpcb_update_object', { id: idR1, patch: { x: -8 } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && JSON.parse(msg.result.content[0].text).ok === true, 'phase1: move R1');
    r = await mcpPost(MCP_PORT, toolCall(44, 'millpcb_connect_pins', { from: { compId: idR1, pin: '2' }, to: { compId: idR2, pin: '1' } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const stale = JSON.parse(msg.result.content[0].text);
    assert(stale.ok === false && stale.status === 'NETLIST_NOT_VALIDATED', `phase1: move clears electrical pass (got ${msg.result.content[0].text.slice(0, 180)})`);
    r = await mcpPost(MCP_PORT, toolCall(45, 'millpcb_update_object', { id: idR1, patch: { x: -10 } }), { sessionId: sid });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(46, 'millpcb_check', {
        type: 'circuit',
        rails: [{ net: 'SIG' }],
        unused: [{ compId: idR1, pin: '1' }, { compId: idR2, pin: '2' }]
    }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const reElec = JSON.parse(msg.result.content[0].text);
    assert(reElec.status === 'NETLIST_VALID', `phase1: re-check after the move (got ${msg.result.content[0].text.slice(0, 180)})`);

    r = await mcpPost(MCP_PORT, toolCall(21, 'millpcb_connect_pins', { from: { compId: idR1, pin: '2' }, to: { compId: idR2, pin: '1' } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const connRes = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && connRes.ok === true, `phase1: connect_pins R1.2-R2.1 ok (got ${msg.result.content[0].text.slice(0, 160)})`);

    // Numeric pin refs must resolve to the pin NAME first (agents write 1/2
    // meaning pins named "1"/"2"; kernel index semantics would pick pin 2 / fail).
    // Schematic wire = no copper, so this cannot skew routing/DRC downstream.
    r = await mcpPost(MCP_PORT, toolCall(26, 'millpcb_add_schem_wire', { from: { compId: idR1, pin: 1 }, to: { compId: idR2, pin: 2 } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const numRes = JSON.parse(msg.result.content[0].text);
    const numWire = numRes.wire;
    const near = (a, b) => Math.abs(a - b) < 0.01;
    // Schematic wire points are in schematic space: symbol pin stubs at ±2.54.
    // R1 pin "1" stub is at x=-12.54; index semantics would pick pin "2" (x=-7.46).
    // R2 pin "2" stub is at x=12.54; index 2 on a 2-pin part is out of range (would throw).
    assert(r.status === 200 && numRes.ok === true
        && near(numWire.points[0].x, -12.54) && near(numWire.points[0].y, 0)
        && near(numWire.points[1].x, 12.54) && near(numWire.points[1].y, 0),
        `phase1: numeric pin 1/2 resolve to names, not indices (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP_PORT, toolCall(22, 'millpcb_add_schem_wire', { from: { compId: idR1, pin: '1' }, to: { compId: idR2, pin: '2' } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const wireRes = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && wireRes.ok === true && wireRes.wire.net, `phase1: millpcb_add_schem_wire ok with net (got ${msg.result.content[0].text.slice(0, 160)})`);
    const schemNet = wireRes.wire.net;

    r = await mcpPost(MCP_PORT, toolCall(42, 'millpcb_check', {
        type: 'circuit',
        rails: [{ net: 'SIG' }, { net: schemNet }]
    }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const bothElec = JSON.parse(msg.result.content[0].text);
    assert(bothElec.electricalOk === true, `phase1: both nets covered before autoroute (got ${msg.result.content[0].text.slice(0, 180)})`);

    r = await mcpPost(MCP_PORT, toolCall(23, 'millpcb_autoroute', { gridSize: 0.25 }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const routeRes = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && routeRes.ok === true && routeRes.routed.includes(schemNet), `phase1: millpcb_autoroute routed ${schemNet} (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP_PORT, toolCall(24, 'millpcb_check', { type: 'drc' }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const drcRes = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && drcRes.ok === true, `phase1: millpcb_check drc clean after autoroute (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP_PORT, toolCall(47, 'millpcb_export', { format: 'svg' }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const staleExport = JSON.parse(msg.result.content[0].text);
    assert(staleExport.ok === false && staleExport.status === 'NETLIST_NOT_VALIDATED', `phase1: export blocked after routing cleared validation (got ${msg.result.content[0].text.slice(0, 180)})`);

    r = await mcpPost(MCP_PORT, toolCall(54, 'millpcb_set_netlist', { nets: { [schemNet]: [{ compId: idR1, pin: '1' }, { compId: idR2, pin: '2' }] } }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === true, `phase1: schem net stored in the netlist (got ${msg.result.content[0].text.slice(0, 160)})`);

    r = await mcpPost(MCP_PORT, toolCall(48, 'millpcb_check', { type: 'circuit', rails: [{ net: 'SIG' }, { net: schemNet }] }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const copperOk = JSON.parse(msg.result.content[0].text);
    assert(copperOk.status === 'COPPER_VALID', `phase1: copper matches the contract (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP_PORT, toolCall(49, 'millpcb_export', { format: 'svg' }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const exported = JSON.parse(msg.result.content[0].text);
    assert(exported.ok === true && exported.status === 'EXPORT_ALLOWED', `phase1: export allowed when every gate passes (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP_PORT, toolCall(50, 'millpcb_get_project', { full: true }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const routed = JSON.parse(msg.result.content[0].text).project;
    const copperTrace = (routed.traces || []).find(t => !t.schemWire);
    r = await mcpPost(MCP_PORT, toolCall(51, 'millpcb_update_object', { id: copperTrace.id, patch: { width: 0.05 } }), { sessionId: sid });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(52, 'millpcb_check', { type: 'circuit' }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).netlistStatus === 'NETLIST_VALID', 'phase1: narrow trace does not invalidate the netlist');
    r = await mcpPost(MCP_PORT, toolCall(53, 'millpcb_export', { format: 'svg' }), { sessionId: sid });
    msg = parseMcpBody(await r.text());
    const drcBlocked = JSON.parse(msg.result.content[0].text);
    assert(drcBlocked.ok === false && drcBlocked.status === 'DRC_INVALID', `phase1: export blocked on DRC (got ${msg.result.content[0].text.slice(0, 200)})`);

    await new Promise(res => setTimeout(res, 500)); // autosave is best-effort
    const autoSave = path.join(PROJ_DIR, 'project.pcb.json');
    assert(fs.existsSync(autoSave), 'phase1: autosave written to MILLPCB_PROJECTS_DIR/project.pcb.json');

    r = await fetch(`http://127.0.0.1:${PREV_PORT}/?preview=1`);
    const page = await r.text();
    assert(r.status === 200 && page.includes('agent-preview'), 'phase1: preview page served with agent-preview.js');

    r = await fetch(`http://127.0.0.1:${PREV_PORT}/api/project`);
    const apiProj = await r.json();
    assert(r.status === 200 && Array.isArray(apiProj.components) && apiProj.components.length === 2, 'phase1: /api/project reflects the session');

    r = await fetch(`http://127.0.0.1:${MCP_PORT}/nope`);
    assert(r.status === 404, `phase1: non-/mcp path on MCP port -> 404 (got ${r.status})`);
    await r.text();

// ============ PHASE 1b: agent design-flow tools (spec tests 5, 6, 8, 9) ============
    // Own registry session (?session=flow1b): keeps the default session autosave intact for phase 2 restore.
    // The browser tab must be connected first — a named session with no preview client is refused.
    const hold1b = await holdSession(PREV_PORT, 'flow1b');
    assert(hold1b.ok, `phase1b: preview client holds flow1b (got ${hold1b.status} ${hold1b.text || ''})`);
    const URL1B = `http://127.0.0.1:` + MCP_PORT + `/mcp?session=flow1b`;
    r = await mcpPost(MCP_PORT, { ...INIT, id: 29 }, { urlOverride: URL1B });
    const sid1b = r.headers.get('mcp-session-id');
    await r.text();
    r = await mcpPost(MCP_PORT, NOTIF_INIT, { sessionId: sid1b, urlOverride: URL1B });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(30, 'millpcb_new_project'), { sessionId: sid1b, urlOverride: URL1B });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(31, 'millpcb_set_board', { width: 80, height: 40 }), { sessionId: sid1b, urlOverride: URL1B });
    await r.text();

    // Spec test 5: batch add 10 LEDs -> labels D1..D10 in request order + pin echo.
    const ledParts = Array.from({ length: 10 }, (_, i) => ({ type: 'led', x: -30 + i * 6, y: 10, key: 'LED' + (i + 1) }));
    r = await mcpPost(MCP_PORT, toolCall(32, 'millpcb_add_component', { parts: ledParts }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const batch = JSON.parse(msg.result.content[0].text);
    const wantLabels = Array.from({ length: 10 }, (_, i) => 'D' + (i + 1)).join(',');
    const gotLabels = (batch.parts || []).map(x => x.component.label).join(',');
    assert(batch.ok === true && gotLabels === wantLabels, `phase1: add_component parts labels in request order (got ${gotLabels})`);
    assert((batch.parts || []).every(x => x.key && x.component && Array.isArray(x.component.pins) && x.component.pins.length === 2), 'phase1: add_component parts echoes key + pins');
    const ledIds = batch.parts.map(x => x.component.id);

    // Spec test 6: placed, unwired board -> workflow route is todo (not pass).
    r = await mcpPost(MCP_PORT, toolCall(33, 'millpcb_workflow'), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const wf1 = JSON.parse(msg.result.content[0].text);
    const routeStep1 = (wf1.steps || []).find(s => s.step === 'route');
    assert(routeStep1 && routeStep1.status === 'todo', `phase1: workflow route todo on unwired board (got ${routeStep1 && routeStep1.status})`);

    // Spec test 8 setup: 10-branch dimmer sheet (resistors + netlist + VCC rail).
    const resParts = Array.from({ length: 10 }, (_, i) => ({ type: 'resistor', x: -30 + i * 6, y: -10, key: 'R' + (i + 1) }));
    r = await mcpPost(MCP_PORT, toolCall(34, 'millpcb_add_component', { parts: resParts }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const resistors = JSON.parse(msg.result.content[0].text).parts.map(x => x.component.id);
    const nets = { VCC: [], GND: [] };
    for (let i = 0; i < 10; i++) {
        nets.VCC.push({ compId: resistors[i], pin: '1' });
        nets['DIM' + (i + 1)] = [{ compId: resistors[i], pin: '2' }, { compId: ledIds[i], pin: 'A' }];
        nets.GND.push({ compId: ledIds[i], pin: 'K' });
    }
    r = await mcpPost(MCP_PORT, toolCall(35, 'millpcb_set_netlist', { nets }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const nlRes = JSON.parse(msg.result.content[0].text);
    assert(nlRes.ok === true && nlRes.nets >= 12, `phase1: set_netlist stores nets (got ${msg.result.content[0].text.slice(0, 120)})`);

    r = await mcpPost(MCP_PORT, toolCall(36, 'millpcb_route_rail', { net: 'VCC', edge: 'top' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const blockedRail = JSON.parse(msg.result.content[0].text);
    assert(blockedRail.ok === false && blockedRail.status === 'NETLIST_NOT_VALIDATED', `phase1: route_rail blocked until electrical validation (got ${msg.result.content[0].text.slice(0, 180)})`);

    const dimBranches = [];
    for (let i = 0; i < 10; i++) {
        dimBranches.push({ net: 'DIM' + (i + 1), from: { compId: resistors[i], pin: '2' }, to: { compId: ledIds[i], pin: 'A' } });
    }
    r = await mcpPost(MCP_PORT, toolCall(361, 'millpcb_check', { type: 'circuit', rails: [{ net: 'VCC' }, { net: 'GND' }], branches: dimBranches }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const elecRes = JSON.parse(msg.result.content[0].text);
    assert(elecRes.electricalOk === true && elecRes.status === 'NETLIST_VALID', `phase1: circuit contract is electrically valid before copper (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP_PORT, toolCall(362, 'millpcb_route_rail', { net: 'VCC', edge: 'top' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const railRes = JSON.parse(msg.result.content[0].text);
    assert(railRes.ok === true && railRes.traces.length === 9, `phase1: route_rail VCC 10 pins -> 9 traces (got ${msg.result.content[0].text.slice(0, 160)})`);

    // Routing cleared the stored pass. Re-check the same contract: netlist still valid, copper is not.
    r = await mcpPost(MCP_PORT, toolCall(37, 'millpcb_check', { type: 'circuit' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const ccRes = JSON.parse(msg.result.content[0].text);
    assert(ccRes.status === 'COPPER_INVALID' && (ccRes.violations || []).some(v => v.type === 'branch-open'), `phase1: copper check flags branch-open (got ${msg.result.content[0].text.slice(0, 180)})`);

    // Spec test 8: schematic PNG of the sheet is not a corner blob.
    r = await mcpPost(MCP_PORT, toolCall(38, 'millpcb_screenshot', { view: 'schematic', maxSize: 1200 }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const schemImg = ((msg.result && msg.result.content) || []).find(c => c.type === 'image');
    assert(!!schemImg && !!schemImg.data, 'phase1: schematic screenshot returns an image');
    if (schemImg) {
        const run = pngContentRun(Buffer.from(schemImg.data, 'base64'));
        assert(run.runW > run.w / 2, `phase1: schematic PNG content run wider than half (run ${run.runW}/${run.w})`);
    }

    // Spec test 9: millpcb_import_kicad (content) -> preview snapshot carries the def; placed part resolves geometry.
    const modText = fs.readFileSync(path.join(ROOT, 'libs', 'modules', 'ESP32-DevKitC.kicad_mod'), 'utf8');
    r = await mcpPost(MCP_PORT, toolCall(39, 'millpcb_import_kicad', { content: modText }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const impRes = JSON.parse(msg.result.content[0].text);
    assert(impRes.ok === true && !!impRes.key, `phase1: millpcb_import_kicad ok (got ${msg.result.content[0].text.slice(0, 120)})`);
    r = await fetch(`http://127.0.0.1:${PREV_PORT}/api/project?session=flow1b`);
    const apiProj2 = await r.json();
    assert(Array.isArray(apiProj2.importedDefs) && apiProj2.importedDefs.some(d => d.key === impRes.key), 'phase1: /api/project includes the imported def');
    r = await mcpPost(MCP_PORT, toolCall(40, 'millpcb_add_component', { type: impRes.key, x: 0, y: 0 }), { sessionId: sid1b, urlOverride: URL1B });

    msg = parseMcpBody(await r.text());
    const impComp = JSON.parse(msg.result.content[0].text);
    assert(impComp.ok === true && impComp.component && Array.isArray(impComp.component.pins) && impComp.component.pins.length > 0, `phase1: placed imported part resolves geometry (got ${msg.result.content[0].text.slice(0, 160)})`);

    // Two agents: one mutation lock, reviewers stay read-only.
    r = await mcpPost(MCP_PORT, { ...INIT, id: 70 }, { urlOverride: URL1B });
    const sidPair = r.headers.get('mcp-session-id');
    await r.text();
    r = await mcpPost(MCP_PORT, NOTIF_INIT, { sessionId: sidPair, urlOverride: URL1B });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(71, 'millpcb_agent_join', { name: 'Lead', model: 'test', role: 'lead' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === true, 'phase1c: lead joined');
    r = await mcpPost(MCP_PORT, toolCall(72, 'millpcb_agent_join', { name: 'Reviewer', model: 'test', role: 'electrical' }), { sessionId: sidPair, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === true, 'phase1c: reviewer joined');
    r = await mcpPost(MCP_PORT, { ...INIT, id: 84 }, { urlOverride: URL1B });
    const sidDup = r.headers.get('mcp-session-id');
    await r.text();
    r = await mcpPost(MCP_PORT, NOTIF_INIT, { sessionId: sidDup, urlOverride: URL1B });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(85, 'millpcb_agent_join', { name: 'lead', model: 'test' }), { sessionId: sidDup, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const dupName = JSON.parse(msg.result.content[0].text);
    assert(dupName.ok === false && dupName.status === 'NAME_TAKEN' && dupName.agentId, `phase1c: duplicate agent name is rejected (got ${msg.result.content[0].text.slice(0, 180)})`);
    r = await mcpPost(MCP_PORT, toolCall(86, 'millpcb_agent_join', { name: 'Spare', model: '   ' }), { sessionId: sidDup, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const noModel = JSON.parse(msg.result.content[0].text);
    assert(noModel.ok === false && noModel.status === 'MODEL_REQUIRED', `phase1c: blank model is rejected (got ${msg.result.content[0].text.slice(0, 180)})`);
    r = await mcpPost(MCP_PORT, toolCall(73, 'millpcb_add_component', { type: 'resistor', x: 0, y: 0 }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const needLock = JSON.parse(msg.result.content[0].text);
    assert(needLock.ok === false && needLock.status === 'MUTATION_LOCK_REQUIRED', `phase1c: edit without the lock is refused (got ${msg.result.content[0].text.slice(0, 180)})`);
    r = await mcpPost(MCP_PORT, toolCall(74, 'millpcb_workflow', {}), { sessionId: sidPair, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === true, 'phase1c: reviewer can still read the workflow');
    r = await mcpPost(MCP_PORT, toolCall(75, 'millpcb_mutation_lock', { action: 'acquire' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).status === 'MUTATION_ACQUIRED', `phase1c: lead acquired the lock (got ${msg.result.content[0].text.slice(0, 160)})`);
    r = await mcpPost(MCP_PORT, toolCall(76, 'millpcb_add_component', { type: 'resistor', x: 5, y: 5 }), { sessionId: sidPair, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const locked = JSON.parse(msg.result.content[0].text);
    assert(locked.ok === false && locked.status === 'MUTATION_LOCKED' && locked.owner === 'Lead', `phase1c: reviewer cannot edit (got ${msg.result.content[0].text.slice(0, 180)})`);
    r = await mcpPost(MCP_PORT, toolCall(77, 'millpcb_agent_task', { task: 'Verify U3 footprint' }), { sessionId: sidPair, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === true, 'phase1c: reviewer claimed a task');
    r = await mcpPost(MCP_PORT, toolCall(78, 'millpcb_agent_task', { task: 'Verify U3 footprint' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const taken = JSON.parse(msg.result.content[0].text);
    assert(taken.ok === false && taken.status === 'TASK_TAKEN' && taken.owner === 'Reviewer', `phase1c: duplicate task refused (got ${msg.result.content[0].text.slice(0, 160)})`);
    r = await mcpPost(MCP_PORT, toolCall(79, 'millpcb_agent_say', { text: '[checking]' }), { sessionId: sidPair, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === false, 'phase1c: progress noise is refused');
    r = await mcpPost(MCP_PORT, toolCall(80, 'millpcb_mutation_lock', { action: 'release' }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).status === 'MUTATION_RELEASED', 'phase1c: lead released the lock');
    r = await mcpPost(MCP_PORT, toolCall(81, 'millpcb_mutation_lock', { action: 'acquire' }), { sessionId: sidPair, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).status === 'MUTATION_ACQUIRED', 'phase1c: reviewer took the lock');
    r = await fetch(URL1B, { method: 'DELETE', headers: { 'mcp-session-id': sidPair, Accept: 'application/json, text/event-stream' } });
    await r.text();
    r = await mcpPost(MCP_PORT, toolCall(82, 'millpcb_agent_inbox', {}), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    const afterDeath = JSON.parse(msg.result.content[0].text);
    assert(afterDeath.alone === true && afterDeath.mutationOwner === null && (afterDeath.messages || []).some(m => /disconnected/.test(m.text) && /finish alone/.test(m.text)),
        `phase1c: a dropped agent frees the lock and wakes the survivor (got ${msg.result.content[0].text.slice(0, 240)})`);
    r = await mcpPost(MCP_PORT, toolCall(83, 'millpcb_add_component', { type: 'resistor', x: 12, y: 0 }), { sessionId: sid1b, urlOverride: URL1B });
    msg = parseMcpBody(await r.text());
    assert(JSON.parse(msg.result.content[0].text).ok === true, `phase1c: survivor can edit without the dead agent's lock (got ${msg.result.content[0].text.slice(0, 160)})`);
    hold1b.stop();
    s1.child.kill();

    // ================= PHASE 2: token auth + MILLPCB_RESTORE =================
    const s2 = startServer({ mcpPort: MCP2_PORT, prevPort: PREV2_PORT, token: TOKEN, restore: true });
    assert(await waitHealthy(PREV2_PORT), 'phase2: preview server became healthy');

    r = await mcpPost(MCP2_PORT, INIT);
    assert(r.status === 401, `phase2: /mcp without token -> 401 (got ${r.status})`);
    await r.text();

    r = await mcpPost(MCP2_PORT, INIT, { token: 'wrong' });
    assert(r.status === 401, `phase2: /mcp with wrong token -> 401 (got ${r.status})`);
    await r.text();

    r = await mcpPost(MCP2_PORT, INIT, { token: TOKEN });
    assert(r.status === 200, `phase2: /mcp with Bearer token -> 200 (got ${r.status})`);
    const sid2 = r.headers.get('mcp-session-id');
    msg = parseMcpBody(await r.text());
    assert(!!sid2 && msg.result.serverInfo.name === 'millpcb', 'phase2: authenticated initialize ok');

    r = await mcpPost(MCP2_PORT, INIT, { urlOverride: `http://127.0.0.1:${MCP2_PORT}/mcp?token=${TOKEN}` });
    assert(r.status === 200, `phase2: /mcp with ?token=*** -> 200 (got ${r.status})`);
    await r.text();

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 3000);
    r = await fetch(`http://127.0.0.1:${PREV2_PORT}/events?token=${TOKEN}`, { signal: ac.signal });
    assert(r.status === 200, `phase2: /events with token -> 200 SSE (got ${r.status})`);

    r = await fetch(`http://127.0.0.1:${PREV2_PORT}/events`);
    assert(r.status === 401, `phase2: /events without token -> 401 (got ${r.status})`);
    await r.text();

    r = await fetch(`http://127.0.0.1:${PREV2_PORT}/api/health`);
    assert(r.status === 200, `phase2: /api/health stays open for healthchecks (got ${r.status})`);
    await r.text();

    r = await mcpPost(MCP2_PORT, toolCall(5, 'millpcb_get_project', { full: true }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const proj2 = JSON.parse(msg.result.content[0].text).project;
    assert(proj2.components.length === 2 && proj2.components.every(c => c.type === 'resistor'),
        `phase2: MILLPCB_RESTORE reloaded the autosaved project (got ${proj2.components.length} components)`);

    // ============ PHASE 2b: millpcb_use_session — shared URL, per-user sessions ============
    r = await mcpPost(MCP2_PORT, toolCall(9, 'millpcb_use_session', { session: 'alice' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && msg.result.isError === true && /no active session/.test(msg.result.content[0].text),
        `phase2b: use_session with no browser tab fails (got ${msg.result.content[0].text.slice(0, 160)})`);

    const holdAlice = await holdSession(PREV2_PORT, 'alice');
    assert(holdAlice.ok, `phase2b: alice preview connects without the MCP token (got ${holdAlice.status})`);
    r = await mcpPost(MCP2_PORT, toolCall(10, 'millpcb_use_session', { session: 'alice' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const sw = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && sw.ok === true && sw.sessionId === 'alice',
        `phase2b: use_session alice ok (got ${msg.result.content[0].text.slice(0, 120)})`);

    r = await mcpPost(MCP2_PORT, toolCall(11, 'millpcb_add_component', { type: 'resistor', x: 5, y: 5, label: 'A1' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && JSON.parse(msg.result.content[0].text).ok === true,
        `phase2b: add_component on alice ok (got ${msg.result.content[0].text.slice(0, 160)})`);

    const holdBob = await holdSession(PREV2_PORT, 'bob');
    assert(holdBob.ok, 'phase2b: bob preview connects');
    r = await mcpPost(MCP2_PORT, toolCall(12, 'millpcb_use_session', { session: 'bob' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && JSON.parse(msg.result.content[0].text).sessionId === 'bob', 'phase2b: use_session bob ok');

    r = await mcpPost(MCP2_PORT, toolCall(13, 'millpcb_get_project', { full: true }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const bobProj = JSON.parse(msg.result.content[0].text).project;
    assert(bobProj.components.length === 0, `phase2b: bob session is isolated (got ${bobProj.components.length} components)`);

    r = await mcpPost(MCP2_PORT, toolCall(14, 'millpcb_use_session', { session: 'alice' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && JSON.parse(msg.result.content[0].text).sessionId === 'alice', 'phase2b: back to alice ok');

    r = await mcpPost(MCP2_PORT, toolCall(15, 'millpcb_get_project', { full: true }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const aliceProj = JSON.parse(msg.result.content[0].text).project;
    assert(aliceProj.components.length === 1 && aliceProj.components[0].label === 'A1',
        `phase2b: alice board preserved after switching (got ${aliceProj.components.length} components: ${aliceProj.components.map(c => c.label).join(',')})`);

    r = await mcpPost(MCP2_PORT, toolCall(16, 'millpcb_use_session', { session: 'x!' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && msg.result.isError === true, 'phase2b: invalid session id rejected');

    r = await mcpPost(MCP2_PORT, toolCall(17, 'millpcb_get_project', { full: true }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const afterBad = JSON.parse(msg.result.content[0].text).project;
    assert(afterBad.components.length === 1, 'phase2b: failed switch left binding on alice');

    // ============ PHASE 2c: millpcb_layout_schematic ============
    r = await mcpPost(MCP2_PORT, toolCall(20, 'millpcb_layout_schematic', {}), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const lay = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && lay.ok === true && lay.placed.length === 1 &&
        Number.isFinite(lay.placed[0].x) && Number.isFinite(lay.placed[0].y),
        `phase2c: layout placed alice's resistor (got ${msg.result.content[0].text.slice(0, 160)})`);

    r = await mcpPost(MCP2_PORT, toolCall(21, 'millpcb_layout_schematic', { keepPositions: true }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const lay2 = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && lay2.ok === true && lay2.placed[0].x === lay.placed[0].x && lay2.placed[0].y === lay.placed[0].y,
        'phase2c: keepPositions preserves existing schematic positions');

    // ============ PHASE 2d: eyes + flow (screenshot / map / workflow) ============
    r = await mcpPost(MCP2_PORT, toolCall(22, 'millpcb_workflow', {}), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const wf = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && wf.ok === true && Array.isArray(wf.steps) && wf.steps.length === 10 &&
        wf.steps.some(s => s.step === 'electrical') &&
        wf.steps.every(s => s.step && s.status) && (wf.next === null || wf.next.step),
        `phase2d: workflow reports electrical gate + next (got ${msg.result.content[0].text.slice(0, 160)})`);

    r = await mcpPost(MCP2_PORT, toolCall(23, 'millpcb_render_map', {}), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const map = JSON.parse(msg.result.content[0].text);
    const mapRows = (map.map || '').split('\n');
    const mapHits = mapRows.filter(x => x.includes('#') || /[0-9]/.test(x.replace(/[+|-]/g, '')));
    assert(r.status === 200 && map.ok === true && mapRows.length > 10 && mapHits.length >= 1 &&
        map.legend.includes('resistor'),
        `phase2d: render map shows copper + component id + legend (rows ${mapRows.length}, hits ${mapHits.length}, ${JSON.stringify(map.map).slice(0, 120)})`);

    r = await mcpPost(MCP2_PORT, toolCall(24, 'millpcb_screenshot', { view: 'board' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const img = msg.result.content.find(c => c.type === 'image');
    const pngMagic = img ? Buffer.from(img.data, 'base64').slice(1, 4).toString('ascii') : '';
    assert(r.status === 200 && !!img && img.mimeType === 'image/png' && pngMagic === 'PNG',
        `phase2d: screenshot returns PNG image content (got ${msg.result.content.map(c => c.type).join(',')})`);

    r = await mcpPost(MCP2_PORT, toolCall(25, 'millpcb_screenshot', { view: 'schematic' }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const img2 = msg.result.content.find(c => c.type === 'image');
    assert(r.status === 200 && !!img2 && Buffer.from(img2.data, 'base64').length > 100,
        'phase2d: schematic screenshot renders too');

    // ============ PHASE 2e: millpcb_import_kicad (content form) — real parts only ============
    const realMod = '(footprint "TestRC0805" (version 20240101) (generator "pcbnew")\n  (layer "F.Cu")\n  (pad 1 smd rect (at -0.95 0) (size 1 1.3) (layers "F.Cu" "F.Paste" "F.Mask"))\n  (pad 2 smd rect (at 0.95 0) (size 1 1.3) (layers "F.Cu" "F.Paste" "F.Mask"))\n  (fp_line (start -2 -0.6) (end 2 -0.6) (layer "F.CrtYd") (width 0.05))\n  (fp_line (start -0.6 -0.6) (end 0.6 -0.6) (layer "F.Fab") (width 0.1))\n  (model "TestRC0805" (uri "https://example.com/models/rc0805.wrl") (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))\n)';
    const realSym = '(kicad_symbol_lib (version 20240101) (generator kicad_symbol_editor)\n  (symbol "TestRC0805:TestRC0805" (pin_names (offset 0))\n    (symbol "TestRC0805:TestRC0805_1_1"\n      (rect (pts (xy -2 -1) (xy 2 -1) (xy 2 1) (xy -2 1)) (stroke (width 0.25)))\n      (polyline (pts (xy -2 0) (xy -1 0.6) (xy 0 -0.6) (xy 1 0.6) (xy 2 0)) (stroke (width 0.25)))\n      (pin passive line (at -2 0) (length 1) (name "A") (number "1"))\n      (pin passive line (at 2 0) (length 1) (name "K") (number "2"))\n    )\n  )\n)';
    r = await mcpPost(MCP2_PORT, toolCall(26, 'millpcb_import_kicad', { content: realMod, symbol: realSym }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const imp = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && imp.ok === true && imp.key === 'kx_testrc0805' &&
        imp.pins.join(',') === 'A,K' && imp.saved && imp.saved.includes('.mcp/library') &&
        imp.symbolGraphics === true && Array.isArray(imp.model3d) && imp.model3d[0].includes('rc0805.wrl'),
        `phase2e: genuine footprint+symbol import ok with real pin names + symbol graphics + 3D ref (got ${msg.result.content[0].text.slice(0, 200)})`);

    r = await mcpPost(MCP2_PORT, toolCall(27, 'millpcb_import_kicad', {
        content: '(footprint "InventedPart" (layer "F.Cu")\n  (pad 1 thru_hole circle (at -2.5 0) (size 1.7 1.7) (drill 1) (layers F.Cu B.Cu))\n)'
    }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && msg.result.isError === true && /genuine|invent/i.test(msg.result.content[0].text),
        `phase2e: invented footprint rejected (got ${msg.result.content[0].text.slice(0, 120)})`);

    // Placed with real pin names, and the persisted file exists for reuse.
    r = await mcpPost(MCP2_PORT, toolCall(28, 'millpcb_add_component', { type: 'kx_testrc0805', x: 20, y: 10 }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    assert(r.status === 200 && !msg.result.isError,
        `phase2e: imported part placeable (got ${msg.result.content[0].text.slice(0, 120)})`);
    assert(fs.existsSync(path.join(ROOT, '.mcp', 'library', 'kx_testrc0805.kicad_mod')),
        'phase2e: footprint persisted to library');

    // ============ PHASE 2f: 3D model references ============
    // Agent-supplied model3d reference (footprint without embedded model).
    const noModelMod = realMod.replace(/\n  \(model [^\n]*\n/, '\n');
    r = await mcpPost(MCP2_PORT, toolCall(29, 'millpcb_import_kicad', {
        content: noModelMod,
        model3d: [{ uri: 'https://example.com/custom/part3d.wrl' }]
    }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const imp3d = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && imp3d.ok === true && Array.isArray(imp3d.model3d) &&
        imp3d.model3d[0] === 'https://example.com/custom/part3d.wrl',
        `phase2f: agent-supplied model3d accepted (got ${msg.result.content[0].text.slice(0, 160)})`);

    // inspect on a placed imported part exposes its 3D reference.
    r = await mcpPost(MCP2_PORT, toolCall(30, 'millpcb_add_component', { type: 'kx_testrc0805', x: 25, y: 10 }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const placed = JSON.parse(msg.result.content[0].text);
    r = await mcpPost(MCP2_PORT, toolCall(31, 'millpcb_inspect', { id: placed.component.id }), { sessionId: sid2, token: TOKEN });
    msg = parseMcpBody(await r.text());
    const insp = JSON.parse(msg.result.content[0].text);
    assert(r.status === 200 && insp.ok === true && Array.isArray(insp.object.model3d) &&
        insp.object.model3d[0].includes('part3d.wrl'),
        `phase2f: inspect shows 3D model reference (got ${msg.result.content[0].text.slice(0, 160)})`);

    // Persisted library file carries the model reference for future reloads.
    const persisted = fs.readFileSync(path.join(ROOT, '.mcp', 'library', 'kx_testrc0805.kicad_mod'), 'utf8');
    assert(persisted.includes(';KICAD_MODEL3D') && persisted.includes('part3d.wrl'),
        'phase2f: model3d persisted in library file');

    const USER = 'a'.repeat(32);
    const holdCarol = await holdSession(PREV2_PORT, 'carol', USER);
    assert(holdCarol.ok, `phase2b: carol tab claims its own token (got ${holdCarol.status})`);
    r = await mcpPost(MCP2_PORT, INIT, { urlOverride: `http://127.0.0.1:${MCP2_PORT}/mcp?token=${USER}` });
    assert(r.status === 200, `phase2b: /mcp with the user's token joins carol (got ${r.status})`);
    await r.text();
    r = await mcpPost(MCP2_PORT, INIT, { urlOverride: `http://127.0.0.1:${MCP2_PORT}/mcp?token=${'b'.repeat(32)}` });
    assert(r.status === 409, `phase2b: unknown user token is not an active session (got ${r.status})`);
    await r.text();

    holdAlice.stop();
    holdBob.stop();
    holdCarol.stop();
    s2.child.kill();
    await waitForExit(s2.child);

    // ============ PHASE 3: startup autosave sweep ============
    // Only files for unknown sessions older than the TTL get pruned.
    fs.writeFileSync(path.join(PROJ_DIR, 'project-keep.pcb.json'), '{}');
    fs.writeFileSync(path.join(PROJ_DIR, 'project-old.pcb.json'), '{}');
    fs.writeFileSync(path.join(PROJ_DIR, 'project-alice.pcb.json'), '{}');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(PROJ_DIR, 'project-old.pcb.json'), past, past);
    const s3 = startServer({ mcpPort: MCP3_PORT, prevPort: PREV3_PORT, restore: true, autosaveTtl: 5000 });
    assert(await waitHealthy(PREV3_PORT), 'phase3: server healthy');
    const holdKeep = await holdSession(PREV3_PORT, 'keep');
    assert(holdKeep.ok, `phase3: keep session is live (got ${holdKeep.status})`);
    const init3 = await mcpPost(MCP3_PORT, INIT, { urlOverride: `http://127.0.0.1:${MCP3_PORT}/mcp?session=keep` });
    const sid3 = init3.headers.get('mcp-session-id');
    await init3.text();
    assert(!!sid3, 'phase3: keep session initialized');
    const r3 = await mcpPost(MCP3_PORT, toolCall(30, 'millpcb_get_project', {}), { sessionId: sid3 });
    assert(r3.status === 200, 'phase3: keep session connected');
    await new Promise(res => setTimeout(res, 1500));
    assert(!fs.existsSync(path.join(PROJ_DIR, 'project-old.pcb.json')), 'phase3: stale unknown file swept');
    assert(fs.existsSync(path.join(PROJ_DIR, 'project-keep.pcb.json')), 'phase3: active session file kept');
    assert(fs.existsSync(path.join(PROJ_DIR, 'project-alice.pcb.json')), 'phase3: fresh unknown file kept');
    holdKeep.stop();
    s3.child.kill();
    await waitForExit(s3.child);

    try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    clearTimeout(overall);
    console.log(`mcp-http: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
