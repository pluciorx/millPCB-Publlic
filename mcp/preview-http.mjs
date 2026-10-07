// millPCB preview server — HTTP server for the live agent preview.
//   GET /events?session=<id>  SSE stream (hello / project / focus / drc / view) for one session
//   GET /api/health      { ok, revision, clients, sessions }  (always open — Docker healthcheck)
//   GET /api/project?session=<id>  current serialized .pcb.json for one session
//   GET <anything else>  serve the SPA from MILLPCB_ROOT (/, /css/*, /js/*, /libs/*, /img/*)
// Sessions are resolved through getSession(sessionId) (registry in server.mjs).
// GET /events?session=<id> creates that session and holds it live (the millpcb.com tab).
// No ?session= means the 'default' session (same URL shape as plain stdio mode).
// Local mode (default): binds 127.0.0.1 and rejects non-local Host headers as a second guard.
// Docker/LAN mode: pass bind != loopback; the host guard is then off, so set `token`
// to require ?token=*** or "Authorization: Bearer <t>" on /api/project and on /events
// for the default session. A named /events?session=<id> stays open without the token
// so the public site can hold the session; the token still locks /mcp.
// /events and /api/* answer CORS for cross-origin pages (e.g. millpcb.com watching the LAN server).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.kicad_mod': 'text/plain; charset=utf-8',
    '.zip': 'application/zip'
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalRequest(req) {
    const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
    return LOCAL_HOSTS.has(hostHeader);
}

/**
 * Start the preview server.
 * @param {object} opts
 *   rootDir    absolute path of the millPCB repo to serve
 *   port       listen port (default 7847)
 *   getSession fn(sessionId) -> registry entry { id, session, clients, ... } (creates on demand)
 *   peekSession fn(sessionId) -> entry or null (no create). Health uses this for named ids.
 *   listSessions fn() -> iterable of registry entries (for close(); optional)
 *   bind       address to bind (default '127.0.0.1'; use '0.0.0.0' in Docker/LAN mode)
 *   token      optional shared token; when set, /api/project and default /events require it
 *   tls        optional { cert, key } PEM buffers -> serve HTTPS
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startPreviewServer({ rootDir, port = 7847, getSession, peekSession = null, acceptEventToken = null, listSessions = null, bind = '127.0.0.1', token = null, tls = null, mcpHandler = null }) {
    const loopback = (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost');

    function authOk(req, url) {
        if (!token) return true;
        const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        return header === token || url.searchParams.get('token') === token;
    }

    const handler = (req, res) => {
        if (loopback && !isLocalRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('local access only');
            return;
        }
        let url;
        try { url = new URL(req.url, `http://127.0.0.1:${port}`); }
        catch (e) { res.writeHead(400); res.end('bad request'); return; }

        // /mcp shares the preview port (own auth inside the MCP handler), so a
        // CDN-restricted deployment only needs one public HTTPS port.
        if (url.pathname === '/mcp' && mcpHandler) { mcpHandler(req, res); return; }

        const isData = url.pathname === '/events' || url.pathname === '/api/project' || url.pathname === '/api/health' || url.pathname === '/api/lock' || url.pathname === '/api/chat' || url.pathname === '/api/chat/events';
        if (isData && req.method === 'OPTIONS') { // CORS preflight for cross-origin pages
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type'
            });
            res.end();
            return;
        }
        const cors = isData ? { 'Access-Control-Allow-Origin': '*' } : {};

        if (req.method === 'GET' && url.pathname === '/events') {
            const sid = sessionParam(url);
            if (!sid) { sendJson(res, 400, { ok: false, error: 'invalid session id' }); return; }
            // Named sessions are the public site's presence channel. The shared
            // token still locks /mcp and /api/project. Default /events stays locked.
            if (sid === 'default' && !authOk(req, url)) { sendJson(res, 401, { ok: false, error: 'token required' }); return; }
            const presented = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            const entry = getSession(sid);
            if (sid !== 'default' && acceptEventToken && !acceptEventToken(entry, presented)) {
                sendJson(res, 401, { ok: false, error: 'token required' });
                return;
            }
            handleSSE(req, res, entry, cors);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/health') {
            const sid = sessionParam(url);
            if (!sid) { sendJson(res, 400, { ok: false, error: 'invalid session id' }); return; }
            const entry = sid === 'default' ? getSession('default') : (peekSession ? peekSession(sid) : getSession(sid));
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({
                ok: true,
                active: !!(entry && entry.clients.size),
                revision: entry ? entry.session.revision : 0,
                clients: entry ? entry.clients.size : 0,
                agents: entry ? entry.agents.size : 0,
                locked: entry ? !!entry.editLock : false,
                sessions: listSessions ? [...listSessions()].length : (entry ? 1 : 0)
            }));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/lock') {
            const sid = sessionParam(url);
            if (!sid) { sendJson(res, 400, { ok: false, error: 'invalid session id' }); return; }
            const entry = getSession(sid);
            const presented = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (sid !== 'default' && acceptEventToken && !acceptEventToken(entry, presented)) {
                sendJson(res, 401, { ok: false, error: 'token required' }); return;
            }
            if (sid === 'default' && !authOk(req, url)) { sendJson(res, 401, { ok: false, error: 'token required' }); return; }
            let body = '';
            req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
            req.on('end', () => {
                let locked = true;
                let releaseMutation = false;
                try {
                    const j = JSON.parse(body || '{}');
                    if (typeof j.locked === 'boolean') locked = j.locked;
                    if (j.releaseMutation === true) releaseMutation = true;
                } catch (e) { /* default lock */ }
                entry.editLock = locked;
                // Human override: the user may free an agent's mutation lock even
                // though only that agent can release it over MCP.
                if (releaseMutation) entry.mutationOwner = null;
                const owner = (entry.mutationOwner && entry.agents.get(entry.mutationOwner)?.name) || null;
                for (const res2 of entry.clients) {
                    try { res2.write(`event: lock\ndata: ${JSON.stringify({ locked, agents: entry.agents.size, manual: true, mutationOwner: owner, revision: entry.session.revision })}\n\n`); } catch (e) { /* ignore */ }
                    try { res2.write(`event: agents\ndata: ${JSON.stringify({ agents: [...entry.agents.values()].map(a => a.name), count: entry.agents.size, mutationOwner: owner, revision: entry.session.revision })}\n\n`); } catch (e) { /* ignore */ }
                }
                sendJson(res, 200, { ok: true, locked, agents: entry.agents.size, mutationOwner: owner, revision: entry.session.revision });
            });
            return;
        }
        // Agent chat SSE. Named sessions stay open with no token and carry no
        // project JSON — only chat events — so two agents can hold the stream.
        if (req.method === 'GET' && url.pathname === '/api/chat/events') {
            const sid = sessionParam(url);
            if (!sid) { sendJson(res, 400, { ok: false, error: 'invalid session id' }); return; }
            if (sid === 'default' && !authOk(req, url)) { sendJson(res, 401, { ok: false, error: 'token required' }); return; }
            const entry = sid === 'default' ? getSession('default') : (peekSession ? peekSession(sid) : getSession(sid));
            if (!entry) { sendJson(res, 404, { ok: false, error: 'session not found' }); return; }
            handleChatSSE(req, res, entry, cors);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/chat') {
            const sid = sessionParam(url);
            if (!sid) { sendJson(res, 400, { ok: false, error: 'invalid session id' }); return; }
            const entry = sid === 'default' ? getSession('default') : (peekSession ? peekSession(sid) : getSession(sid));
            if (!entry) { sendJson(res, 404, { ok: false, error: 'session not found' }); return; }
            const since = parseInt(url.searchParams.get('since') || '-1', 10);
            const messages = (entry.chat || []).slice(since + 1);
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, total: (entry.chat || []).length, messages }));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/project') {
            if (!authOk(req, url)) { sendJson(res, 401, { ok: false, error: 'token required' }); return; }
            const sid = sessionParam(url);
            if (!sid) { sendJson(res, 400, { ok: false, error: 'invalid session id' }); return; }
            const entry = getSession(sid);
            const snap = entry.session.snapshot();
            if (!snap) { sendJson(res, 409, { ok: false, error: 'no project in session' }); return; }
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ...snap.project, importedDefs: snap.importedDefs, revision: snap.revision }));
            return;
        }
        serveStatic(req, res, rootDir);
    };

    const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    server.listen(port, bind);
    const base = advertiseHost(bind, port, tls);
    const url = `${base}/index.html?preview=1`;
    console.error(`[millpcb-mcp] preview: ${url} (SPA at ${base}/)` +
        (token ? ' [token required for /mcp-facing /api/project + default /events; named /events open]' : (!loopback ? ' ⚠ open to the network without a token' : '')));

    return {
        url,
        close: () => new Promise((resolve) => {
            for (const entry of listSessions()) {
                for (const res of entry.clients) { try { res.end(); } catch (e) { /* ignore */ } }
                entry.clients.clear();
                if (entry.chatClients) {
                    for (const res of entry.chatClients) { try { res.end(); } catch (e) { /* ignore */ } }
                    entry.chatClients.clear();
                }
            }
            server.close(() => resolve());
        })
    };
}

function privateIPv4(address) {
    return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address);
}

/** Friendly base URL to advertise: localhost when loopback, else the public name. */
function advertiseHost(bind, port, tls = null) {
    const scheme = tls ? 'https' : 'http';
    if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') return `${scheme}://localhost:${port}`;
    const envOrigin = (process.env.MILLPCB_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
    if (envOrigin) return envOrigin;
    // A TLS deployment is the public app. A 10/8 or 169.254 address on that
    // box is not the name users and agents should open.
    if (tls) return `https://agent.millpcb.com:${port}`;
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const info of ifaces[name] || []) {
            if (info.family === 'IPv4' && !info.internal && !privateIPv4(info.address)) {
                return `${scheme}://${info.address}:${port}`;
            }
        }
    }
    return `${scheme}://localhost:${port}`;
}

/** 'default' when omitted; null when the id is not a safe session key. */
function sessionParam(url) {
    const raw = (url.searchParams.get('session') || '').trim().toLowerCase();
    if (!raw) return 'default';
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(raw)) return null;
    return raw;
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

/** Chat-only SSE. Does not join entry.clients, so it neither dumps the board nor counts as the user's preview tab. */
function handleChatSSE(req, res, entry, extraHeaders = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...extraHeaders
    });
    res.write('retry: 1500\n\n');
    if (!entry.chatClients) entry.chatClients = new Set();
    entry.chatClients.add(res);
    if (entry.chat && entry.chat.length) {
        res.write(`event: chat_log\ndata: ${JSON.stringify({ messages: entry.chat })}\n\n`);
    }
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { clearInterval(ping); } }, 15000);
    req.on('close', () => {
        clearInterval(ping);
        entry.chatClients.delete(res);
    });
}

/** SSE endpoint: register the client on its session, replay current state, then stay open. */
function handleSSE(req, res, entry, extraHeaders = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...extraHeaders
    });
    res.write('retry: 1500\n\n');

    entry.clients.add(res);
    entry.lastSeen = Date.now();

    // hello (with the session id the page should show to the user), then current state.
    const ownerName = (entry.mutationOwner && entry.agents.get(entry.mutationOwner)?.name) || null;
    res.write(`event: hello\ndata: ${JSON.stringify({ server: 'millpcb-mcp', session: entry.id, revision: entry.session.revision, agents: [...entry.agents.values()].map(a => a.name), locked: !!entry.editLock, mutationOwner: ownerName })}\n\n`);
    const snap = entry.session.snapshot();
    if (snap) {
        res.write(`event: project\ndata: ${JSON.stringify(snap)}\n\n`);
    }
    // Late joiners land in the view the agent last chose (millpcb_set_view).
    if (entry.previewView) {
        res.write(`event: view\ndata: ${JSON.stringify({ view: entry.previewView, revision: entry.session.revision })}\n\n`);
    }
    // Replay the collaboration state: roster, lock, and the shared chat log.
    res.write(`event: agents\ndata: ${JSON.stringify({ agents: [...entry.agents.values()].map(a => a.name), count: entry.agents.size, mutationOwner: ownerName, revision: entry.session.revision })}\n\n`);
    res.write(`event: agents_state\ndata: ${JSON.stringify({ agents: [...entry.agents.entries()].map(([id, a], i) => ({ id, name: a.name, model: a.model || null, color: a.color || null, cursor: a.cursor || null, selection: a.selection || [], role: a.role || null, view: a.view || null })), mutationOwner: ownerName })}\n\n`);
    res.write(`event: lock\ndata: ${JSON.stringify({ locked: !!entry.editLock, agents: entry.agents.size, mutationOwner: ownerName, revision: entry.session.revision })}\n\n`);
    if (entry.chat && entry.chat.length) {
        res.write(`event: chat_log\ndata: ${JSON.stringify({ messages: entry.chat })}\n\n`);
    }

    req.on('close', () => {
        entry.clients.delete(res);
        entry.lastSeen = Date.now();
    });
}

/** Serve a static file from the repo root; index.html for `/`. */
function serveStatic(req, res, rootDir) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (e) { res.writeHead(400); res.end('bad request'); return; }
    if (pathname === '/') pathname = '/index.html';

    const rootAbs = path.resolve(rootDir);
    const filePath = path.resolve(rootAbs, '.' + pathname);
    // Path sandbox: must stay inside the repo root.
    if (!filePath.startsWith(rootAbs + path.sep) && filePath !== rootAbs) {
        res.writeHead(403); res.end('forbidden'); return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
    }
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // The preview page must pick up footprint-sync fixes without a stale cached script.
    if (ext === '.html' || ext === '.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
}
