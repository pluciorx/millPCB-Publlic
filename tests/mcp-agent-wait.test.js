#!/usr/bin/env node
// millpcb_agent_wait — server-side chat wake for agents whose client cannot arm
// output notifications. Spawns mcp/server.mjs in MILLPCB_TRANSPORT=http mode,
// holds a named session open, opens TWO MCP connections (two agents) and checks
// the three wake paths: wake on peer post, quiet timeout, immediate catch-up.
// No extra deps: child_process + global fetch (Node 18+). Requires mcp/node_modules.
const { spawn } = require('child_process');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}

const ROOT = path.join(__dirname, '..');
const MCP_PORT = 18191, PREV_PORT = 17951;
const SESSION = 'agentwait';

const overall = setTimeout(() => { console.error('FAIL: overall timeout'); process.exit(1); }, 120000);

const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MILLPCB_TRANSPORT: 'http', MILLPCB_MCP_PORT: String(MCP_PORT), MILLPCB_PREVIEW_PORT: String(PREV_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', () => {});

function parseMcpBody(text) {
    const t = String(text).trim();
    if (t.startsWith('event:') || t.includes('\ndata: ')) {
        const line = t.split('\n').find(l => l.trimStart().startsWith('data:'));
        return JSON.parse(line.trimStart().slice(5).trim());
    }
    return JSON.parse(t);
}

async function holdSession(id) {
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${PREV_PORT}/events?session=${encodeURIComponent(id)}`, { signal: ac.signal });
    if (!r.ok) return null;
    const reader = r.body.getReader();
    (async () => { try { while (true) { const { done } = await reader.read(); if (done) break; } } catch (e) { /* aborted */ } })();
    return { stop() { ac.abort(); } };
}

async function mcpPost(body, sessionId) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return fetch(`http://127.0.0.1:${MCP_PORT}/mcp?session=${SESSION}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
    });
}

async function openAgent(name) {
    const r = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '0' } } });
    const sid = r.headers.get('mcp-session-id');
    const initBody = parseMcpBody(await r.text());
    await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const call = async (tool, args, id = 2) => {
        const res = await mcpPost({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }, sid);
        const body = parseMcpBody(await res.text());
        if (body.error) throw new Error(body.error.message);
        return JSON.parse(body.result.content[0].text);
    };
    const join = await call('millpcb_agent_join', { name, model: 'test' });
    return { call, agentId: join.agentId, join, instructions: (initBody.result && initBody.result.instructions) || '' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForReady() {
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PREV_PORT}/api/health`); if (r.ok) return true; } catch (e) { /* not up yet */ }
        await sleep(500);
    }
    return false;
}

(async () => {
    if (!await waitForReady()) { console.error('FAIL: server did not start'); child.kill(); process.exit(1); }
    const held = await holdSession(SESSION);
    if (!held) { console.error('FAIL: could not hold session open'); child.kill(); process.exit(1); }

    const a = await openAgent('WaitA');
    const b = await openAgent('WaitB');
    assert(a.agentId && b.agentId && a.agentId !== b.agentId, 'two agents joined as distinct ids');
    assert(a.join.chatMaxChars === 1000 && String(a.join.chatLimit).includes('1000'), 'join tells the agent the 1000-character chat limit');
    assert(String(a.instructions).includes('1000'), 'MCP connect instructions state the 1000-character chat limit');
    assert(String(a.instructions).includes('PAIR WORK') && String(a.instructions).includes('"complete"') && String(a.instructions).includes('"failed"'), 'MCP connect instructions require a shared complete-or-failed verdict');

    // 1) wake: A blocks in agent_wait, B posts -> A wakes with the message.
    const pending = a.call('millpcb_agent_wait', { since: 0, timeout: 20 }, 10);
    await sleep(1000);
    const said = await b.call('millpcb_agent_say', { text: 'hallo from B' }, 11);
    assert(said.ok === true && said.seq === 1, 'agent_say stamps a monotonic seq');
    const woke = await pending;
    assert(woke.woke === true, 'blocked agent_wait wakes on peer post');
    assert(woke.messages.length === 1 && woke.messages[0].from === 'WaitB' && woke.messages[0].seq === 1, 'wake returns the peer message with its seq');
    assert(woke.lastSeq === 1, 'wake reports the new lastSeq cursor');

    // 2) quiet: nothing posted after the cursor -> timeout, woke:false.
    const t0 = Date.now();
    const quiet = await a.call('millpcb_agent_wait', { since: woke.lastSeq, timeout: 3 }, 12);
    assert(quiet.woke === false && quiet.timeoutSecs === 3, 'quiet board times out quietly (woke:false)');
    assert(Date.now() - t0 >= 2500, 'timeout path actually blocked for the requested time');

    // 3) immediate: a message already newer than the cursor returns at once.
    await b.call('millpcb_agent_say', { text: 'second' }, 13);
    const t1 = Date.now();
    const fast = await a.call('millpcb_agent_wait', { since: woke.lastSeq, timeout: 20 }, 14);
    assert(fast.woke === true && fast.messages.length === 1 && fast.messages[0].text === 'second', 'already-newer messages return immediately');
    assert(Date.now() - t1 < 2000, 'immediate path does not block');

    // 4) inbox exposes the seq cursor for the next wait.
    const box = await a.call('millpcb_agent_inbox', {}, 15);
    assert(box.messages.every(m => Number.isInteger(m.seq)), 'inbox messages carry seq');
    assert(box.messages[box.messages.length - 1].seq === fast.lastSeq, 'inbox last seq matches the wait cursor');
    assert(box.lastSeq === fast.lastSeq, 'inbox returns lastSeq separately from the index cursor');

    // 5) own post does not wake the author; a peer post still does.
    const mine = await a.call('millpcb_agent_say', { text: 'note to self' }, 16);
    const t2 = Date.now();
    const pendingOwn = a.call('millpcb_agent_wait', { since: fast.lastSeq, timeout: 8 }, 17);
    await sleep(500);
    const still = Date.now() - t2;
    assert(still >= 400, 'own message does not return the wait immediately');
    const peer = await b.call('millpcb_agent_say', { text: 'peer after own' }, 18);
    const wokePeer = await pendingOwn;
    assert(wokePeer.woke === true && wokePeer.messages.length === 1 && wokePeer.messages[0].text === 'peer after own', 'wait returns the peer line and skips the author line');
    assert(wokePeer.messages[0].seq === peer.seq && wokePeer.messages[0].seq > mine.seq, 'peer seq is newer than the author seq');

    // 6) chat text is kept up to 1000 characters and the cut is reported.
    const cut = await b.call('millpcb_agent_say', { text: 'y'.repeat(1200) }, 19);
    assert(cut.ok === true && cut.truncated === true && cut.chars === 1000 && cut.chatMaxChars === 1000, 'messages longer than 1000 are cut and reported');
    const box2 = await a.call('millpcb_agent_inbox', {}, 20);
    assert(box2.messages[box2.messages.length - 1].text.length === 1000, 'stored chat text is 1000 characters');

    held.stop();
    child.kill();
    clearTimeout(overall);
    console.log(`mcp-agent-wait: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); child.kill(); process.exit(1); });
