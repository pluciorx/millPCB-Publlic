// millPCB MCP server — front end over the DOM-free project kernel.
// Transports (MILLPCB_TRANSPORT):
//   stdio (default)  node mcp/server.mjs          — spawned by an MCP client (Claude Desktop etc.)
//   http             node mcp/server.mjs          — Streamable HTTP on /mcp (Docker / LAN clients)
// Env:  MILLPCB_ROOT            repo dir (default = parent of mcp/; Docker: /app)
//       MILLPCB_TRANSPORT       'stdio' | 'http' (default stdio)
//       MILLPCB_MCP_PORT        HTTP MCP port (default 8090); /mcp is ALSO served
//                               on the preview port (one public port behind
//                               port-restricting CDNs, e.g. Cloudflare)
//       MILLPCB_PREVIEW_PORT    preview/SSE port (default 7847)
//       MILLPCB_BIND            bind address for both servers (default 127.0.0.1; Docker: 0.0.0.0)
//       MILLPCB_TOKEN           optional shared token for /mcp + /api/project.
//                               Named preview /events?session=<id> stays open so the
//                               millpcb.com tab can hold the session without that token.
//       MILLPCB_PROJECTS_DIR    trusted dir for user .pcb.json files (Docker: /data/projects)
//       MILLPCB_EXPORTS_DIR     export output dir (default <root>/exports; Docker: /data/exports)
//       MILLPCB_RESTORE=1       reload the autosaved project at startup (Docker restarts)
//       MILLPCB_OPEN_BROWSER=1  open the preview in a browser tab (stdio/local only)
// Deps live in mcp/: npm install
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import childProcess from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

import { ProjectSession, loadKernel, safeResolve, MILLPCB_ROOT_DEFAULT } from './host.mjs';
import { startPreviewServer } from './preview-http.mjs';
import { renderBoardPng, renderSchematicPng } from './render.mjs';
import { validateFootprintText, persistFootprint, loadPersistentLibrary } from './library.mjs';
import { createTaskManager, hashState } from './taskManager.mjs';

const ROOT = process.env.MILLPCB_ROOT ? path.resolve(process.env.MILLPCB_ROOT) : MILLPCB_ROOT_DEFAULT;
const PREVIEW_PORT = parseInt(process.env.MILLPCB_PREVIEW_PORT || '7847', 10);
const TRANSPORT = (process.env.MILLPCB_TRANSPORT || 'stdio').toLowerCase(); // 'stdio' | 'http'
const MCP_PORT = parseInt(process.env.MILLPCB_MCP_PORT || '8090', 10);
const BIND = process.env.MILLPCB_BIND || '127.0.0.1';
const TOKEN = process.env.MILLPCB_TOKEN || null;
const PROJECTS_DIR = process.env.MILLPCB_PROJECTS_DIR ? path.resolve(process.env.MILLPCB_PROJECTS_DIR) : null;
const EXPORTS_DIR = process.env.MILLPCB_EXPORTS_DIR ? path.resolve(process.env.MILLPCB_EXPORTS_DIR) : path.join(ROOT, 'exports');
// TLS (public deployments, e.g. behind Cloudflare "Full"): self-signed cert is fine.
const TLS = (() => {
    const c = process.env.MILLPCB_TLS_CERT, k = process.env.MILLPCB_TLS_KEY;
    if (!c || !k) return null;
    if (!fs.existsSync(c) || !fs.existsSync(k)) { console.error('[millpcb-mcp] TLS cert/key not found — falling back to http'); return null; }
    return { cert: fs.readFileSync(c), key: fs.readFileSync(k) };
})();

const { ProjectApi, Autoroute, KicadImport, Plan, SchematicLayout, ComponentDefs } = loadKernel(ROOT); // also warms/validates ROOT up front
// ---------------------------------------------------------------------------
// Session registry — user-facing sessions keyed by a short id. The preview
// page shows its session id; an agent connects to /mcp?session=<id> and both
// ends share one ProjectSession. stdio mode uses the 'default' session.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = parseInt(process.env.MILLPCB_SESSION_TTL_MS || String(12 * 3600 * 1000), 10);
const AUTOSAVE_TTL_MS = parseInt(process.env.MILLPCB_AUTOSAVE_TTL_MS || String(30 * 24 * 3600 * 1000), 10);
const registry = new Map(); // sessionId -> { id, session, clients:Set<res>, mcpTransports:Set, lastSeen }
let previewInfo = null; // { url, close } — set by main() once the preview server is up

/** SSE URL for one session. Agents stream this in the background and wake on `event: chat`. */
function eventsUrlFor(entry) {
    if (!previewInfo || !previewInfo.url || !entry) return null;
    let origin = String(previewInfo.url).replace(/\/index\.html\?.*$/, '');
    // Link-local advertise address is not reachable from agent machines.
    // Point the chat stream at the public DNS name instead.
    if (/\/\/(169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)/.test(origin)) {
        const port = (origin.match(/:(\d+)/) || [])[1] || String(PREVIEW_PORT);
        origin = 'https://agent.millpcb.com:' + port;
    }
    return origin + '/api/chat/events?session=' + encodeURIComponent(entry.id);
}

function touchEntry(entry) { entry.lastSeen = Date.now(); }

function createSessionEntry(id) {
    // The 'default' session keeps the canonical autosave path (PROJECTS_DIR
    // when set, else .mcp/preview/project.pcb.json); named sessions get
    // per-id files so users never overwrite each other.
    const autoSaveFile = id === 'default'
        ? (PROJECTS_DIR ? path.join(PROJECTS_DIR, 'project.pcb.json') : path.join(ROOT, '.mcp', 'preview', 'project.pcb.json'))
        : path.join(PROJECTS_DIR || path.join(ROOT, '.mcp', 'preview'), `project-${id}.pcb.json`);
    const entry = {
        id,
        session: new ProjectSession(ROOT, { projectsDir: PROJECTS_DIR, autoSaveFile }),
        clients: new Set(),
        mcpTransports: new Set(),
        secret: null, // per-user token, set by the browser tab that holds this session
        agents: new Map(), // agentId -> { name, transport } — collaborating MCP clients
        chat: [], // shared agent log: { from, text, rev, t }
        editLock: false, // true => the human preview is read-only (set when 2+ agents join)
        mutationOwner: null, // agentId allowed to change the board when 2+ agents are joined
        tasks: [], // read-only task claims: { task, agentId, owner, status }
        agentSeq: 0, // running A1, A2... counter for this session
        lastSeen: Date.now()
    };
    // Restore the session's autosave so work survives server restarts.
    if (fs.existsSync(autoSaveFile)) {
        try { entry.session.loadParsed(JSON.parse(fs.readFileSync(autoSaveFile, 'utf8'))); }
        catch (e) { console.error(`[millpcb-mcp] session ${id}: restore failed:`, e.message); }
    }
    return entry;
}

function canonicalSessionId(id) {
    const clean = String(id || 'default').trim().toLowerCase();
    return clean || 'default';
}

function getSessionEntry(id) {
    const key = canonicalSessionId(id);
    let entry = registry.get(key);
    if (!entry) {
        entry = createSessionEntry(key);
        registry.set(key, entry);
        console.error(`[millpcb-mcp] session ${key} created`);
    }
    touchEntry(entry);
    return entry;
}

/** Lookup only — does not create. A session is live while a browser tab holds /events. */
function peekSession(id) {
    return registry.get(canonicalSessionId(id)) || null;
}

function sessionIsLive(entry) {
    return !!(entry && entry.clients && entry.clients.size > 0);
}

function findSessionBySecret(secret) {
    if (!secret) return null;
    for (const entry of registry.values()) {
        if (entry.secret === secret) return entry;
    }
    return null;
}

/** Remember the token from the browser tab. Reject a later caller who presents a different one. */
function acceptEventToken(entry, presented) {
    if (TOKEN && presented === TOKEN) return true;
    if (!entry.secret) {
        if (presented && /^[a-f0-9]{32}$/.test(presented)) entry.secret = presented;
        return true;
    }
    if (!presented) return false;
    return entry.secret === presented;
}

function sseSend(res, type, data) {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (e) { /* client went away; 'close' cleans it up */ }
}

function broadcast(entry, type, payload) {
    for (const res of entry.clients) sseSend(res, type, payload);
    if (type === 'chat' && entry.chatClients) {
        for (const res of entry.chatClients) sseSend(res, type, payload);
    }
}

/** Wake every pending millpcb_agent_wait long-poll whose "since" cursor is now
 * behind a newer chat message. Server-side wake: an agent needs no SSE
 * listener and no client-side output notification to hear a peer. */
function chatAfter(entry, since, agentId) {
    return entry.chat.filter(m => (m.seq || 0) > since && (!agentId || m.agentId !== agentId));
}

function notifyChatWaiters(entry) {
    if (!entry.chatWaiters || !entry.chatWaiters.size) return;
    for (const w of [...entry.chatWaiters]) {
        const messages = chatAfter(entry, w.since, w.agentId);
        if (!messages.length) continue;
        if (w.settled) continue;
        w.settled = true;
        entry.chatWaiters.delete(w);
        clearTimeout(w.timer);
        w.resolve({ ok: true, woke: true, since: w.since, lastSeq: entry.chatSeq, total: entry.chat.length, messages });
    }
}

/** Push the current agent roster + lock state to every preview client. */
function broadcastAgents(entry) {
    broadcast(entry, 'agents', {
        agents: [...entry.agents.values()].map(a => a.name),
        count: entry.agents.size,
        mutationOwner: mutationOwnerName(entry),
        revision: entry.session.revision
    });
}

/** Shared agent chat: millpcb_agent_say keeps at most this many characters. */
const CHAT_MAX_CHARS = 1000;

/** Name of the agent currently holding the board mutation lock, or null. */
function mutationOwnerName(entry) {
    return (entry.mutationOwner && entry.agents.get(entry.mutationOwner)?.name) || null;
}

/** Per-agent board presence: cursor + selection, drawn on the human preview. */
const AGENT_COLORS = ['#ff5d5d', '#5db0ff', '#b07bff', '#ffb84d', '#4dd07a', '#ff5db0', '#4de0e0', '#c8e04d'];
function agentColor(i) { return AGENT_COLORS[i % AGENT_COLORS.length]; }

function broadcastAgentState(entry) {
    broadcast(entry, 'agents_state', {
        agents: [...entry.agents.entries()].map(([id, a], i) => ({
            id, name: a.name, model: a.model || null, color: a.color || agentColor(i),
            cursor: a.cursor || null, selection: a.selection || [],
            role: a.role || null, view: a.view || null
        })),
        mutationOwner: mutationOwnerName(entry)
    });
}

/** Recompute the auto-lock rule (2+ agents => locked) and notify the preview. */
function recomputeLock(entry) {
    entry.editLock = entry.agents.size >= 2;
    broadcast(entry, 'lock', { locked: entry.editLock, agents: entry.agents.size, mutationOwner: mutationOwnerName(entry), revision: entry.session.revision });
}

/** Remove an agent bound to a transport (on disconnect) and refresh the lock.
 *  A dropped peer must not leave the survivor waiting on a verdict or a lock. */
function dropAgentForTransport(entry, transport) {
    const names = [];
    for (const [id, a] of entry.agents) {
        if (a.transport !== transport) continue;
        names.push(a.name || id);
        entry.agents.delete(id);
        if (entry.mutationOwner === id) entry.mutationOwner = null;
        if (entry.tasks) entry.tasks = entry.tasks.filter(t => t.agentId !== id);
    }
    if (!names.length) return;
    recomputeLock(entry);
    broadcastAgents(entry);
    const left = entry.agents.size;
    const text = left === 0
        ? `[BLOCKED] ${names.join(', ')} disconnected. No agents left on this session.`
        : `[BLOCKED] ${names.join(', ')} disconnected. ${left === 1 ? 'You are the only agent left — the mutation lock is free and you may finish alone. Do not wait for their verdict.' : 'Their mutation lock is released.'}`;
    entry.chatSeq = (entry.chatSeq || 0) + 1;
    entry.chat.push({ from: 'server', agentId: null, text, rev: entry.session.revision, t: Date.now(), seq: entry.chatSeq });
    if (entry.chat.length > 200) entry.chat.shift();
    broadcast(entry, 'chat', { from: 'server', text, rev: entry.session.revision });
    notifyChatWaiters(entry);
}

/** When two or more agents share a session, only the mutation owner may change the board.
 *  A single agent, or a connection that has not joined, is not locked — tests and solo work stay open.
 *  Read-only tools never call this. */
function mutationGate(holder) {
    const entry = holder.entry;
    if (!entry || entry.agents.size < 2) return null;
    const ownerId = entry.mutationOwner;
    if (ownerId && ownerId === holder.agentId && entry.agents.has(ownerId)) return null;
    const owner = ownerId && entry.agents.get(ownerId);
    return {
        ok: false,
        gated: 'mutation',
        status: owner ? 'MUTATION_LOCKED' : 'MUTATION_LOCK_REQUIRED',
        owner: owner ? owner.name : null,
        error: owner
            ? `Mutation lock is held by ${owner.name}. Do not wait. Do read-only work (parts, pinouts, netlist, placement, crossings) and report it. Acquire the lock only for a short mutation batch.`
            : 'Two or more agents are connected. Call millpcb_mutation_lock action="acquire" before changing the board, then release it.'
    };
}

/** After a mutation: boardMutate() already bumped rev — push + persist. */
function afterMutation(entry, { message, ids = [], drc = false } = {}) {
    const session = entry.session;
    const snap = session.snapshot();
    broadcast(entry, 'project', snap);
    if (ids.length) broadcast(entry, 'focus', { revision: session.revision, ids, message });
    if (drc) broadcast(entry, 'drc', { revision: session.revision, ...(session.runDrc() || {}) });
    try { session.saveProject(); } catch (e) { /* autosave is best-effort */ }
    return snap;
}

/** Drop sessions with no preview clients and no MCP transports past the TTL. */
function sweepSessions() {
    const now = Date.now();
    for (const [id, entry] of registry) {
        if (id === 'default') continue;
        if (entry.clients.size || entry.mcpTransports.size) continue;
        if (now - entry.lastSeen <= SESSION_TTL_MS) continue;
        try { entry.session.saveProject(); } catch (e) { /* best-effort */ }
        registry.delete(id);
        console.error(`[millpcb-mcp] session ${id} expired`);
    }
    sweepAutosaveFiles();
}

/** Delete autosaved session files of unknown sessions older than the TTL
 * (public server: every visitor id creates one file; without cleanup they
 * accumulate forever). Runs with the session sweep and once at startup. */
function sweepAutosaveFiles() {
    const dirs = [path.join(ROOT, '.mcp', 'preview')];
    if (PROJECTS_DIR) dirs.push(PROJECTS_DIR);
    const now = Date.now();
    for (const dir of dirs) {
        let files;
        try { files = fs.readdirSync(dir); } catch (e) { continue; } // dir may not exist
        for (const f of files) {
            const m = /^project-(.+)\.pcb\.json$/.exec(f);
            if (!m) continue; // only per-id files; the canonical project.pcb.json survives
            if (registry.has(m[1])) continue;
            const full = path.join(dir, f);
            try {
                if (now - fs.statSync(full).mtimeMs > AUTOSAVE_TTL_MS) {
                    fs.unlinkSync(full);
                    console.error(`[millpcb-mcp] autosave ${f} expired`);
                }
            } catch (e) { /* best-effort */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------
function textResult(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
}

/** Flip the live preview to Board or Schematic and remember it for new clients. */
function showPreview(entry, view) {
    if (view !== 'board' && view !== 'schematic') return;
    entry.previewView = view;
    broadcast(entry, 'view', { view, revision: entry.session.revision });
}

/** True once the circuit is declared as a schematic (netlist or logical wires), not as copper. */
function schematicReady(project) {
    const nets = (project && project.netlist) || {};
    let pins = 0;
    for (const name of Object.keys(nets)) pins += (nets[name] || []).length;
    const wires = ((project && project.traces) || []).filter(t => t.schemWire).length;
    return pins >= 2 || wires >= 1;
}

/** Copper tools stay closed until the schematic exists, so the user sees the circuit before traces. */
function schematicGate(entry) {
    if (schematicReady(entry.session.project)) return null;
    return {
        ok: false,
        gated: 'schematic',
        status: 'SCHEMATIC_REQUIRED',
        error: 'Declare the schematic/netlist before electrical validation. Call millpcb_set_netlist — the live preview switches to the Schematic.'
    };
}

/** Stored logical PASS for this exact revision. A live recompute is not enough:
 *  any mutation deletes electricalValidation, so routing stays closed until
 *  millpcb_check type="circuit" records NETLIST_VALID again. */
function electricalGate(entry) {
    const p = entry.session.project;
    if (!schematicReady(p)) {
        return {
            ok: false,
            gated: 'schematic',
            status: 'SCHEMATIC_REQUIRED',
            error: 'Declare the schematic/netlist before electrical validation.'
        };
    }
    const validation = p.electricalValidation;
    if (!validation || validation.revision !== entry.session.revision) {
        return {
            ok: false,
            gated: 'electrical',
            status: 'NETLIST_NOT_VALIDATED',
            electricalOk: false,
            error: 'Electrical validation is required before routing. Call millpcb_check type="circuit" and fix all violations. A previous pass does not survive an edit.'
        };
    }
    if (!validation.valid) {
        return {
            ok: false,
            gated: 'electrical',
            status: 'NETLIST_INVALID',
            electricalOk: false,
            violations: validation.violations || [],
            error: 'Electrical validation failed. Fix the schematic/netlist before routing.'
        };
    }
    return null;
}

/** Schematic, then stored electrical PASS, then placement. DRC is separate:
 *  it flags pins that have no copper yet, so it cannot block the first trace. */
function copperGate(entry, opts) {
    const schem = schematicGate(entry);
    if (schem) return schem;
    const electrical = electricalGate(entry);
    if (electrical) return electrical;
    const planViolations = Plan.planCheck(entry.session.project);
    if (planViolations.length) {
        return { ok: false, gated: 'plan', violations: planViolations, error: 'plan check failed — fix placement (millpcb_check type="plan") before routing' };
    }
    if (opts && opts.drc) {
        const drc = entry.session.runDrc() || {};
        const errors = (drc.violations || []).filter(v => v.severity === 'error');
        if (errors.length) {
            return { ok: false, gated: 'drc', status: 'DRC_INVALID', violations: errors, error: 'DRC reports errors — fix them before autorouting' };
        }
    }
    return null;
}

function hasPhysicalCopper(project) {
    return ((project && project.traces) || []).some(t => t && !t.schemWire);
}

/** Record Plan.electricalCheck for the revision mutate() just left behind. */
function storeElectricalValidation(session, violations) {
    session.project.electricalValidation = {
        revision: session.revision,
        valid: violations.length === 0,
        violations
    };
}

/**
 * CAP-4 gate: refuse to route/export while the plan placement is invalid
 * (out-of-board / out-of-zone / overlap) or DRC reports errors. Returns a
 * result object to return directly, or null when the gate passes.
 */
function planGate(entry) {
    const planViolations = Plan.planCheck(entry.session.project);
    if (planViolations.length) {
        return { ok: false, gated: 'plan', violations: planViolations, error: 'plan check failed — fix placement (millpcb_check type="plan") before routing/exporting' };
    }
    const drc = entry.session.runDrc() || {};
    const errors = (drc.violations || []).filter(v => v.severity === 'error');
    if (errors.length) {
        return { ok: false, gated: 'drc', violations: errors, error: 'DRC reports errors — fix them before routing/exporting' };
    }
    return null;
}

// ---------------------------------------------------------------------------
// MCP server factory — one McpServer instance per transport session (stdio or HTTP).
// All tools operate on the registry session bound to this McpServer. The
// binding lives in a holder so millpcb_use_session can re-point a live
// connection at another registry session (multi-user: one fixed MCP URL,
// the session chosen per connection/prompt).
// ---------------------------------------------------------------------------
function createMcpServer(entry) {
    const holder = { entry };
    const session = entry.session;
    const s = new McpServer({ name: 'millpcb', version: '0.1.0' }, {
        instructions: 'SESSION JOIN: When the user gives a millPCB session id, call millpcb_use_session with that id before any other tool. If that call fails, reply with exactly "sorry but there is no active session" and stop. Do not create a session. millPCB designs SINGLE-LAYER PCBs drilled/laser-cut from ONE copper sheet: no vias, no second copper layer. A net crossing is NOT solvable by routing on a single layer — fix it by MOVING components (placement) or by inserting a JP wire (a two-pad wire jumper soldered OVER the crossing trace; no via). The router does not insert jumpers; you place them. COPPER MUST NOT CROSS another net: add_trace, connect_pins, route_rail, and the board trace tool refuse that geometry and do not store it. millpcb_check type="drc" and type="quality" both report a crossing as an error. Fix it by moving a part or placing a JP jumper (the jumper wire goes over the other trace; do not draw the cross). COMPONENTS: use REAL parts only — call millpcb_list_footprints first (built-ins + 144 real KiCad footprints) and use one of those; if a part is missing, import the GENUINE KiCad library files with millpcb_import_kicad (path = repo file/dir, or content = paste the real .kicad_mod exported from KiCad, plus its .kicad_sym symbol for pin names) — NEVER invent footprint geometry; the server rejects invented footprints. SIZES: this board is drilled/milled and soldered by hand — pick the LARGEST package that fits the board, in this order of preference: THT through-hole first, then 1206, then 0805, then 0603 only when space truly demands it. Example: pick R_1206 over R_0805 over R_0603; prefer axial THT resistors, D_DO-35 diodes, TO-92 transistors, pin headers over SMD equivalents. requirements is the design contract: write what the board must do (function, board size, inputs/outputs, current->trace width, net rules) so the final acceptance has a target. FLOW: call millpcb_workflow first and after every major step — it reports plan/place/planCheck/schematic/electrical/route/circuit/quality/drc/export and the single next action. Guided path: millpcb_set_plan -> millpcb_place_by_plan (apply, preview shows the Board) -> millpcb_check type="plan" -> SCHEMATIC: millpcb_set_netlist (preview switches to the Schematic and lays symbols out) -> millpcb_layout_schematic if the sheet is still crowded -> millpcb_screenshot view=schematic. HARD GATE: a declared schematic is NOT electrical validation. Before any copper, millpcb_check type="circuit" must return status NETLIST_VALID (rails, branches, ties, and unused for intentional NC pins). Do not route on any other status. Every pin is on its net or marked unused. Every net is in the contract. A missing contract is NETLIST_INVALID. Any later edit clears that pass — run the check again. Copper tools refuse until the stored validation matches the current revision. Missing copper is not an electrical failure. After routing, run millpcb_check type="circuit" again: NETLIST_VALID then COPPER_VALID. Then quality and drc, then millpcb_export (EXPORT_ALLOWED). DRC pass, autoroute success, and a schematic existing do not mean the circuit is correct. Never route around an electrical error. EYES: after placement and after routing, call millpcb_screenshot (view=board, then view=schematic) to SEE what you built — verify it against the plan before continuing; millpcb_render_map gives a precise labeled text map. The schematic view is drawn by the human-facing renderer, not by your coordinates: after wiring, call millpcb_layout_schematic once so the schematic is readable (topology placement + orthogonal wires) — never hand-place schemX/schemY. SEPARATE PROBLEMS: Schematic and PCB routing are separate optimization problems. Schematic layout optimizes human readability and logical grouping. PCB layout optimizes physical connectivity, clearance, component placement, and single-layer manufacturability. Never use PCB-style shortest-path routing to construct schematic wiring. PREVIEW: millpcb_preview returns the live preview URL (it carries the session id) — give it to the user verbatim. The preview follows the work: placement and copper routing show the Board; declaring or laying out the circuit shows the Schematic, framed on the symbols. Call millpcb_set_view only to override that. CHAT LIMIT: each millpcb_agent_say is at most 1000 characters; longer text is cut. millpcb_agent_join returns chatMaxChars so you see that limit as soon as you join. PARALLEL WORK: the mutation lock serializes PCB edits. It does not serialize thinking. Startup: millpcb_use_session, millpcb_agent_join (role when you know it), millpcb_agent_inbox, millpcb_workflow. When 2+ agents have joined, every project edit requires millpcb_mutation_lock action="acquire". Hold it only for the smallest mutation batch, then action="release". Do the research first: parts, pinouts, footprints, netlist and contract review, placement, likely single-layer crossings, jumper spots, DRC and quality. Do not hold the lock during that work. If another agent owns the lock, do NOT wait and do NOT call millpcb_agent_wait because of the lock. Do read-only work and report a result. A reviewer does not edit the board unless the owner sends [HANDOFF]. Claim a research task with millpcb_agent_task so two agents do not repeat it. Lifecycle tasks (millpcb_task_open, millpcb_task_plan, millpcb_task_act, millpcb_task_finish) are owned by the server: you propose, the server authorizes, verifies, and sets status. While one is open, board edits require millpcb_task_act first. Messages use a prefix and carry a result: [REQUEST] [PART] [REVIEW] [WARNING] [DECISION] [HANDOFF] [DONE] [BLOCKED]. Triage [BLOCKED] and [WARNING] first. Do not post [checking], [still working], or [almost done]. Inbox: read it at the start of the turn, before acquire, after a mutation, and before you decide you are blocked. millpcb_agent_wait only when there is no mutation to do, no review left, and no request waiting. PAIR WORK: while two or more agents are connected, one agent does not close the project. Both must post the same verdict, "complete" or "failed". If an agent disconnects, the server posts [BLOCKED], releases their mutation lock, and the survivor is told they are alone — do not wait for a dead agent verdict; finish alone. With 2+ agents the human preview auto-locks until they Unlock it. Roles are single-owner. millpcb_agent_inbox lists agents, the mutation owner, tasks, and the human lock. Show your cursor with millpcb_agent_cursor. Any mutation clears electrical validation; no copper until NETLIST_VALID for the current revision. LIVE CHAT: the inbox does not wake you between turns. Immediately after millpcb_agent_join, read eventsUrl from that result (or from millpcb_preview). If it is set and you do not already have a listener for this session, start one background shell: curl.exe -N -k -s "<eventsUrl>". eventsUrl is the public chat SSE (https://agent.millpcb.com:2053/api/chat/events?session=<id> when the server would otherwise advertise 169.254). It needs no session token and sends no board JSON. If that host is still a 169.254 address or /events returns 401, use the public /api/chat/events URL instead. Arm an output notification for the pattern ^event: chat$ — that line is a new message. event: chat_log is the history replay; ignore it, and ignore ": ping". WAKE (primary, no listener needed): millpcb_agent_wait(since=<lastSeq>) blocks until a PEER posts (your own lines do not wake you) and returns those messages. On woke:false call wait again immediately in the same turn — ending the turn goes back to sleep. Timeout default 45s, max 90s (the public proxy cuts longer calls). It needs no curl and no client-side output notification. When you wake, act on the message: if it is from another agent, reply with millpcb_agent_say and do what it asks. If it is from you, do not reply. Leave the listener running for the whole session. Do this yourself on join; do not wait for the user to ask.'
    });

    /** Wrap a tool handler: catch errors; caller runs afterMutation() before returning.
     * A handler may return a raw MCP result ({ content: [...] }, e.g. an image) —
     * anything else is JSON-stringified as text. */
    function tool(name, description, shape, handler) {
        s.registerTool(name, { title: name, description, inputSchema: shape }, async (args) => {
            try {
                const res = await handler(args || {});
                if (res && Array.isArray(res.content)) return res;
                return textResult(res ?? { ok: true });
            } catch (err) {
                if (err && err.gate) return textResult(err.gate);
                return errorResult(err);
            }
        });
    }

    registerTools(tool, holder);
    s.holder = holder; // HTTP transport wiring (multi-user session switching)
    return s;
}

/** Register all millPCB tools on a McpServer (via its `tool` wrapper).
 * `holder` = { entry } — millpcb_use_session reassigns the `entry`/`session`
 * bindings below; every tool closure reads them at call time, so the whole
 * connection follows the switch. */
function registerTools(tool, holder) {
    let entry = holder.entry;
    let session = entry.session;

    function actorId() { return holder.agentId || 'agent'; }

    /** When a lifecycle task is open, design writes are refused until that task is EXECUTING for this agent. */
    function taskWriteGate() {
        const mgr = entry.taskManager;
        if (!mgr) return null;
        return mgr.writeGate(actorId());
    }

    function noteDesignHash() {
        const mgr = entry.taskManager;
        if (!mgr || !session.project) return;
        try { mgr.observe(actorId(), hashState(session.project)); } catch (e) { /* hash is best-effort */ }
    }

    /** Project edit. With 2+ joined agents this throws the mutation gate unless this connection holds the lock. */
    function boardMutate(fn) {
        const denied = mutationGate(holder) || taskWriteGate();
        if (denied) throw Object.assign(new Error(denied.error), { gate: denied });
        noteDesignHash();
        const result = session.mutate(fn);
        noteDesignHash();
        return result;
    }

// ---------------------------------------------------------------------------
// Session tools
// ---------------------------------------------------------------------------
tool('millpcb_new_project', 'Create a fresh empty board (clears the session). The preview canvas resets.', { reset: z.boolean().optional().describe('Keep existing project when false (default true)') },
    async ({ reset }) => {
        const denied = mutationGate(holder) || taskWriteGate();
        if (denied) return denied;
        session.newProject(reset !== false);
        afterMutation(entry, { message: 'new project' });
        return { ok: true, revision: session.revision, stats: session.snapshot().stats, previewUrl: previewInfo?.url };
    });

tool('millpcb_open_project', 'Load a .pcb.json file (path relative to the millPCB root) into the session.', { path: z.string().describe('Project file path, e.g. "board.pcb.json"') },
    async ({ path: p }) => {
        const denied = mutationGate(holder) || taskWriteGate();
        if (denied) return denied;
        session.openProject(p);
        afterMutation(entry, { message: `opened ${p}` });
        return { ok: true, revision: session.revision, stats: session.snapshot().stats, sourcePath: session.sourcePath };
    });

tool('millpcb_save_project', 'Write the session to a .pcb.json file (default: current source path or .mcp/preview/project.pcb.json).', { path: z.string().optional() },
    async ({ path: p }) => ({ ok: true, ...session.saveProject(p) }));

tool('millpcb_get_project', 'Get the current project (summary by default; full .pcb.json with full=true).', { full: z.boolean().optional() },
    async ({ full }) => {
        const snap = session.snapshot();
        if (!snap) return { ok: false, error: 'no project in session' };
        return { ok: true, revision: snap.revision, sourcePath: session.sourcePath, stats: snap.stats, ...(full ? { project: snap.project } : {}) };
    });

tool('millpcb_set_board', 'Set board size and/or export params (width/height mm, copper thickness, isolation/drill widths, min trace/clearance).', {
    width: z.number().optional(), height: z.number().optional(),
    copperThickness: z.number().optional(), isolationWidth: z.number().optional(),
    drillDiameter: z.number().optional(), minTraceWidth: z.number().optional(), minClearance: z.number().optional()
}, async (args) => {
    const patch = {};
    if (args.width != null || args.height != null) {
        patch.board = { width: args.width ?? session.project.board.width, height: args.height ?? session.project.board.height };
    }
    const paramKeys = ['copperThickness', 'isolationWidth', 'drillDiameter', 'minTraceWidth', 'minClearance'];
    if (paramKeys.some(k => args[k] != null)) {
        patch.params = Object.fromEntries(paramKeys.filter(k => args[k] != null).map(k => [k, args[k]]));
    }
    boardMutate(p => ProjectApi.setProjectPatch(p, patch));
    afterMutation(entry, { message: 'board/params updated' });
    return { ok: true, board: session.project.board, params: session.project.params, revision: session.revision };
});

tool('millpcb_preview', 'Preview server status: URL, session id, connected clients, current revision. The url carries ?session= so the page joins THIS session — give it to the user verbatim. eventsUrl is the SSE stream for this session; a joined agent listens to it and wakes on event: chat.', {},
    async () => ({
        ok: true,
        url: previewInfo ? previewInfo.url + '&session=' + encodeURIComponent(entry.id) : null,
        spaUrl: previewInfo ? previewInfo.url.replace('/index.html?preview=1', '/') : null,
        eventsUrl: eventsUrlFor(entry),
        sessionId: entry.id,
        clients: entry.clients.size,
        revision: session.revision
    }));

tool('millpcb_set_view', 'Switch the live preview page between the Board and Schematic views (broadcast to every preview client on this session). Call it at design start (schematic) and again whenever your work moves between the schematic and the board, so the user always watches the view you are acting on.', { view: z.enum(['board', 'schematic']).describe('Which view the preview page should show') },
    async ({ view }) => {
        entry.previewView = view;
        broadcast(entry, 'view', { view, revision: session.revision });
        return { ok: true, view, clients: entry.clients.size, revision: session.revision };
    });

// ---------------------------------------------------------------------------
// Collaboration tools — two (or more) agents on one session coordinate here.
// Each MCP connection is one agent. Join to announce yourself; say to post to
// the shared chat the human sees; inbox to read what the others posted. When
// 2+ agents are present the human preview auto-locks (read-only) until they
// explicitly Unlock it.
// ---------------------------------------------------------------------------
tool('millpcb_agent_join', 'Announce this agent on the shared session so the human sees who is working, and (optionally) claim a work role for consensus. name must be unique on this session: a second join with the same name is rejected. model is required: pass the model you are running as, for example "Grok 4.7". Call once at the start; re-call to update your role/sheet. The result includes chatMaxChars (1000): each millpcb_agent_say longer than that is cut. When a second agent joins, the human preview auto-locks (read-only) until they Unlock it. A role is single-owner: if it is taken, this returns the current owner so you can negotiate via millpcb_agent_say (e.g. one agent role="schematic" view="schematic", the other role="routing" view="board"). Returns eventsUrl — start the live-chat listener on it immediately (see LIVE CHAT in the server instructions). With a peer present, keep checking they are still working; stop only when both of you agree the project is complete or both agree it failed.', { name: z.string().describe('Unique short name on this session, e.g. "Router" or "Placer". A second agent with the same name is rejected.'), model: z.string().describe('Required. The model you are, e.g. "Grok 4.7" or "Claude Sonnet".'), role: z.string().optional().describe('Work role to claim, e.g. "schematic", "placement", "routing", "DRC"'), view: z.enum(['board', 'schematic']).optional().describe('Which sheet this agent works on') },
    async ({ name, role, view, model }) => {
        const label = String(name || '').trim().slice(0, 24);
        const modelName = String(model || '').trim().slice(0, 48);
        if (!label) return { ok: false, status: 'NAME_REQUIRED', error: 'name is required and must be unique on this session' };
        if (!modelName) return { ok: false, status: 'MODEL_REQUIRED', error: 'model is required: pass the model you are, for example "Grok 4.7"' };
        for (const [id, other] of entry.agents) {
            if (id !== holder.agentId && other.name.toLowerCase() === label.toLowerCase()) {
                return { ok: false, status: 'NAME_TAKEN', owner: other.name, agentId: id, model: other.model || null, error: `Name "${label}" is already used by ${id}${other.model ? ' (' + other.model + ')' : ''}. Pick a different name.` };
            }
        }
        if (holder.agentId && entry.agents.has(holder.agentId)) {
            const mine = entry.agents.get(holder.agentId);
            mine.name = label;
            mine.model = modelName;
        } else {
            holder.agentId = 'A' + (++entry.agentSeq);
            entry.agents.set(holder.agentId, { name: label, model: modelName, transport: holder.transport, color: agentColor(entry.agentSeq - 1), cursor: null, selection: [], role: null, view: null });
        }
        const a = entry.agents.get(holder.agentId);
        let taken = null;
        if (role) {
            const rlabel = String(role).trim().toLowerCase().slice(0, 24);
            for (const [id, other] of entry.agents) {
                if (id !== holder.agentId && other.role === rlabel) { taken = { role: rlabel, owner: other.name, agentId: id }; break; }
            }
            if (!taken) a.role = rlabel;
        }
        if (view === 'board' || view === 'schematic') a.view = view;
        recomputeLock(entry);
        broadcastAgents(entry);
        broadcastAgentState(entry);
        return {
            ok: true, agentId: holder.agentId, name: label, model: a.model, color: a.color, role: a.role, view: a.view, taken,
            agents: [...entry.agents.values()].map(x => x.name), editLock: entry.editLock, eventsUrl: eventsUrlFor(entry),
            chatMaxChars: CHAT_MAX_CHARS,
            chatLimit: `Keep each millpcb_agent_say to ${CHAT_MAX_CHARS} characters. Longer text is cut.`,
            pairWork: 'If another agent holds the mutation lock, do not wait. Do read-only work and report a result. Wait only when no independent work remains. Stop only when both of you post the same verdict, complete or failed.',
            revision: session.revision
        };
    });

tool('millpcb_agent_say', 'Post a result to the shared agent chat. Start with a prefix: [REQUEST] [PART] [REVIEW] [WARNING] [DECISION] [HANDOFF] [DONE] [BLOCKED]. A finding, decision, request, or blocker. Not progress noise.', { text: z.string().describe('Message to post (max 1000 chars; longer text is cut)') },
    async ({ text }) => {
        const raw = String(text || '').trim();
        const msg = raw.slice(0, CHAT_MAX_CHARS);
        if (!msg) return { ok: false, error: 'empty message' };
        if (/^\[?(starting|checking|still working|still checking|almost done)\]?\.?$/i.test(msg)) {
            return { ok: false, error: 'Do not post progress noise. Send a result with a prefix: [REVIEW] [WARNING] [PART] [REQUEST] [DECISION] [HANDOFF] [DONE] [BLOCKED].' };
        }
        const from = (holder.agentId && entry.agents.get(holder.agentId)?.name) || 'Agent';
        entry.chatSeq = (entry.chatSeq || 0) + 1;
        entry.chat.push({ from, agentId: holder.agentId || null, text: msg, rev: session.revision, t: Date.now(), seq: entry.chatSeq });
        if (entry.chat.length > 200) entry.chat.shift();
        broadcast(entry, 'chat', { from, text: msg, rev: session.revision });
        notifyChatWaiters(entry);
        return { ok: true, from, seq: entry.chatSeq, chars: msg.length, chatMaxChars: CHAT_MAX_CHARS, truncated: raw.length > CHAT_MAX_CHARS, revision: session.revision };
    });

tool('millpcb_agent_inbox', 'Read the shared collaboration state: the agent chat log (messages from millpcb_agent_say, each carrying a monotonic "seq"), every agent\'s claimed role and sheet ("who is doing what"), and the lock state. Call it to see what the other agent has communicated. "since" here is a 0-based message index, not a seq. To WAIT for the next peer message, call millpcb_agent_wait with since set to lastSeq (the seq cursor), not this index.', { since: z.number().optional().describe('Return only chat messages after this 0-based index. Not a seq — use lastSeq with millpcb_agent_wait.') },
    async ({ since }) => {
        const from = Number.isInteger(since) ? Math.max(0, since + 1) : 0;
        return {
            ok: true,
            total: entry.chat.length,
            lastSeq: entry.chatSeq || 0,
            messages: entry.chat.slice(from),
            agents: [...entry.agents.entries()].map(([id, a]) => ({ id, name: a.name, model: a.model || null, role: a.role || null, view: a.view || null })),
            editLock: entry.editLock,
            mutationOwner: (entry.mutationOwner && entry.agents.get(entry.mutationOwner)?.name) || null,
            mutationOwnerId: entry.mutationOwner || null,
            mutationOwnerModel: (entry.mutationOwner && entry.agents.get(entry.mutationOwner)?.model) || null,
            alone: entry.agents.size <= 1,
            tasks: entry.tasks || [],
            revision: session.revision
        };
    });

tool('millpcb_mutation_lock', 'Take or release the single PCB mutation lock. Required before any project edit when 2+ agents have joined. Acquire only for the smallest mutation batch, then release. If another agent holds it, this returns immediately with MUTATION_LOCKED — do not wait; do read-only work instead. One agent, or no join yet, does not need the lock.', {
    action: z.enum(['acquire', 'release']).describe('acquire the lock, or release it if you hold it')
}, async ({ action }) => {
    if (!holder.agentId || !entry.agents.has(holder.agentId)) return { ok: false, error: 'call millpcb_agent_join first' };
    const me = entry.agents.get(holder.agentId);
    if (action === 'release') {
        if (entry.mutationOwner === holder.agentId) entry.mutationOwner = null;
        broadcastAgents(entry);
        return { ok: true, status: 'MUTATION_RELEASED', owner: null, revision: session.revision };
    }
    const ownerId = entry.mutationOwner;
    const owner = ownerId && entry.agents.get(ownerId);
    if (owner && ownerId !== holder.agentId) {
        const who = `${owner.name} (${ownerId}${owner.model ? ', ' + owner.model : ''})`;
        return { ok: false, status: 'MUTATION_LOCKED', owner: owner.name, ownerId, model: owner.model || null, error: `Mutation lock is held by ${who}. Only ${ownerId} can release it. Do not wait. Do read-only work and report it.` };
    }
    entry.mutationOwner = holder.agentId;
    broadcastAgents(entry);
    return { ok: true, status: 'MUTATION_ACQUIRED', owner: me.name, revision: session.revision };
});

tool('millpcb_agent_task', 'Claim a read-only task so another agent does not repeat it. status active, done, or blocked. A second claim of an active task returns the current owner.', {
    task: z.string().describe('Short task name, e.g. "Verify U3 footprint"'),
    status: z.enum(['active', 'done', 'blocked']).optional().describe('Default active')
}, async ({ task, status }) => {
    if (!holder.agentId || !entry.agents.has(holder.agentId)) return { ok: false, error: 'call millpcb_agent_join first' };
    const key = String(task || '').trim().slice(0, 80);
    if (!key) return { ok: false, error: 'empty task' };
    const next = status || 'active';
    if (!entry.tasks) entry.tasks = [];
    const mine = entry.tasks.find(t => t.task.toLowerCase() === key.toLowerCase() && t.agentId === holder.agentId);
    const other = entry.tasks.find(t => t.task.toLowerCase() === key.toLowerCase() && t.agentId !== holder.agentId && t.status === 'active');
    if (other && next === 'active' && !mine) {
        return { ok: false, status: 'TASK_TAKEN', owner: other.owner, task: other.task, error: `${other.owner} already has this task active. Review their result instead of repeating it, unless a second opinion was requested.` };
    }
    const me = entry.agents.get(holder.agentId);
    if (mine) { mine.status = next; mine.owner = me.name; }
    else entry.tasks.push({ task: key, agentId: holder.agentId, owner: me.name, status: next });
    if (entry.tasks.length > 40) entry.tasks.splice(0, entry.tasks.length - 40);
    return { ok: true, task: key, status: next, owner: me.name, tasks: entry.tasks };
});

const taskCriteria = z.record(z.union([
    z.number(),
    z.object({ max: z.number().optional(), min: z.number().optional(), eq: z.number().optional() })
])).optional();

function taskMgr() {
    if (!entry.taskManager) entry.taskManager = createTaskManager();
    return entry.taskManager;
}

tool('millpcb_task_open', 'Open a server-owned lifecycle task (CREATED then PLANNING). You cannot set its status. While it is open, board edits wait for millpcb_task_act.', {
    taskId: z.string().optional(),
    goal: z.string().describe('What this task must achieve'),
    successCriteria: taskCriteria,
    metrics: z.record(z.number()).optional().describe('Starting measurements, e.g. { erc_errors: 5 }')
}, async ({ taskId, goal, successCriteria, metrics }) => {
    const created = taskMgr().createTask({
        taskId, goal, successCriteria, metrics, agentId: actorId()
    });
    if (!created.ok) return created;
    return taskMgr().accept(created.task.taskId, { agentId: actorId() });
});

tool('millpcb_task_plan', 'Submit a plan. The server moves PLANNING or REPLANNING to READY, or rejects a replay of a failed strategy as DUPLICATE_STRATEGY.', {
    taskId: z.string(),
    expectedVersion: z.number().describe('task.version you last observed'),
    actions: z.array(z.object({
        type: z.string(),
        target: z.string().optional(),
        intent: z.string().optional(),
        parameters: z.record(z.any()).optional()
    })),
    expectedEffects: z.record(z.any()),
    resources: z.array(z.string()).describe('Resources this plan will write, usually ["board"]'),
    successCriteria: taskCriteria,
    goal: z.string().optional(),
    blocked: z.boolean().optional(),
    reason: z.string().optional()
}, async (plan) => taskMgr().submitPlan(plan.taskId, { ...plan, agentId: actorId() }));

tool('millpcb_task_act', 'Ask the server to approve one action. On success the task is EXECUTING and this agent may edit the board until millpcb_task_finish.', {
    taskId: z.string(),
    expectedVersion: z.number(),
    actionId: z.string(),
    type: z.string(),
    intent: z.string(),
    target: z.string().optional(),
    parameters: z.record(z.any()).optional(),
    expectedEffect: z.record(z.any()).optional(),
    resource: z.string().optional().describe('Write resource, default board')
}, async (action) => taskMgr().beginAction(action.taskId, { ...action, agentId: actorId() }));

tool('millpcb_task_finish', 'Report that the approved action finished. The server verifies metrics and chooses the next status. A timeout returns UNKNOWN and blocks a retry until millpcb_task_recover.', {
    taskId: z.string(),
    expectedVersion: z.number(),
    metrics: z.record(z.number()).optional(),
    stateHash: z.string().optional(),
    timedOut: z.boolean().optional(),
    blocked: z.boolean().optional(),
    unrecoverable: z.boolean().optional(),
    reason: z.string().optional()
}, async (input) => {
    const mgr = taskMgr();
    if (!input.metrics && !input.timedOut && !input.blocked && !input.unrecoverable && session.project) {
        const drc = session.runDrc() || {};
        const errors = (drc.violations || []).filter(v => v.severity === 'error').length;
        input = { ...input, metrics: { drc_errors: errors } };
    }
    return mgr.finishAction(input.taskId, input);
});

tool('millpcb_task_recover', 'Inspect real board state after a timeout. Required before the same task may run another action.', {
    taskId: z.string(),
    expectedVersion: z.number(),
    metrics: z.record(z.number()),
    stateHash: z.string().optional()
}, async (input) => taskMgr().recover(input.taskId, { ...input, agentId: actorId() }));

tool('millpcb_task_cancel', 'Cancel a task from CREATED, READY, or BLOCKED.', {
    taskId: z.string(),
    expectedVersion: z.number(),
    reason: z.string().optional()
}, async (input) => taskMgr().cancel(input.taskId, { ...input, agentId: actorId() }));

tool('millpcb_task_resolve', 'Blocked dependency is gone. Server moves BLOCKED to PLANNING.', {
    taskId: z.string(),
    expectedVersion: z.number()
}, async (input) => taskMgr().resolveBlock(input.taskId, { ...input, agentId: actorId() }));

tool('millpcb_task_status', 'Read the server task snapshot and recent transitions. Status is read-only.', {
    taskId: z.string()
}, async ({ taskId }) => {
    const mgr = entry.taskManager;
    if (!mgr) return { ok: false, error: 'NOT_FOUND' };
    const task = mgr.get(taskId);
    if (!task) return { ok: false, error: 'NOT_FOUND' };
    return { ok: true, task, transitions: mgr.transitions(taskId) };
});

tool('millpcb_agent_wait', 'Long-poll WAKE for the shared chat: the call blocks server-side until a PEER posts a message newer than your "since" cursor, then returns those messages. Your own posts do not wake you. This is the wake path for agents whose client cannot arm output notifications on a background shell — no SSE listener, no curl, no regex. Loop it and do not end the turn: millpcb_agent_wait(since=<lastSeq>) -> if a peer wrote, millpcb_agent_say -> wait again. On woke:false, call wait again immediately. Ending the turn goes back to sleep.', {
    since: z.number().optional().describe('Highest message seq you already handled (lastSeq from millpcb_agent_inbox or a previous wait). Omit to wait for anything posted from now.'),
    timeout: z.number().optional().describe('Seconds to block (default 45, max 90). The public proxy drops calls longer than 100s.')
}, async ({ since, timeout }) => {
    const self = holder.agentId || null;
    const startSeq = Number.isInteger(since) ? since : (entry.chatSeq || 0);
    const secs = Math.min(90, Math.max(1, Number(timeout) || 45));
    const fresh = () => chatAfter(entry, startSeq, self);
    const done = (messages, woke) => ({
        ok: true, woke, since: startSeq, lastSeq: entry.chatSeq || 0, total: entry.chat.length,
        messages, ...(woke ? {} : { timeoutSecs: secs })
    });
    const immediate = fresh();
    if (immediate.length) return done(immediate, true);
    return await new Promise((resolve) => {
        const w = { since: startSeq, agentId: self, settled: false, resolve: (r) => resolve(r) };
        w.timer = setTimeout(() => {
            if (w.settled) return;
            w.settled = true;
            entry.chatWaiters.delete(w);
            const late = fresh();
            resolve(done(late, late.length > 0));
        }, secs * 1000);
        if (!entry.chatWaiters) entry.chatWaiters = new Set();
        entry.chatWaiters.add(w);
        notifyChatWaiters(entry); // close the register-vs-post race
    });
});

tool('millpcb_agent_cursor', 'Show this agent\'s presence on the human board: a labeled cursor at a world coordinate (mm, board origin at center) and/or a selection highlight (component/trace ids) in the agent color. Pass null x/y to clear the cursor, an empty ids array to clear the selection.', { x: z.number().nullable().describe('Board X in mm (origin at board center); null clears the cursor'), y: z.number().nullable().describe('Board Y in mm (origin at board center); null clears the cursor'), ids: z.array(z.number()).optional().describe('Component/trace ids this agent has selected; empty clears') },
    async ({ x, y, ids }) => {
        if (!holder.agentId || !entry.agents.has(holder.agentId)) return { ok: false, error: 'call millpcb_agent_join first' };
        const a = entry.agents.get(holder.agentId);
        if (x !== undefined || y !== undefined) a.cursor = (typeof x === 'number' && typeof y === 'number') ? { x, y } : null;
        if (Array.isArray(ids)) a.selection = ids.slice(0, 100);
        broadcastAgentState(entry);
        return { ok: true, cursor: a.cursor, selection: a.selection, revision: session.revision };
    });







tool('millpcb_use_session', 'Join a session the user already has open on millpcb.com. Call this first when the user names a session id (for example "using millPCB session id 1a2b3c4d5e6f"). Does not create a session. If the browser tab is closed or the id is unknown, this fails — reply to the user with exactly "sorry but there is no active session" and stop.', { session: z.string().describe('Session id from the millpcb.com Agent dialog, e.g. "1a2b3c4d5e6f"') },
    async ({ session: id }) => {
        const clean = String(id).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(clean)) throw new Error('invalid session id — use the id shown in the Agent modal (letters/digits, 2-32 chars)');
        const target = peekSession(clean);
        if (!sessionIsLive(target)) throw new Error('sorry but there is no active session');
        if (holder.lockedSessionId && holder.lockedSessionId !== clean) throw new Error('sorry but there is no active session');
        if (!target.session._project) target.session.newProject(); // live tab with no board yet starts empty
        const stats = target.session.snapshot()?.stats ?? null;
        if (target === holder.entry) return { ok: true, sessionId: clean, note: 'already bound to this session', revision: target.session.revision, stats };
        const t = holder.transport;
        if (t) { holder.entry.mcpTransports.delete(t); target.mcpTransports.add(t); }
        holder.entry = target;
        entry = target;
        session = target.session;
        return {
            ok: true, sessionId: clean,
            revision: target.session.revision,
            stats,
            liveView: previewInfo ? previewInfo.url + '&session=' + clean : null
        };
    });

// ---------------------------------------------------------------------------
// Design-plan tools (CAP-1..CAP-4) — the guided workflow the agent drives.
// Single-layer board: drilled/laser-cut from ONE copper sheet, no vias. A net
// crossing is topologically unsolvable by routing — fix it by MOVING components
// (placement), never by adding a via. Plan first, place, then route.
// ---------------------------------------------------------------------------
const zoneSchema = z.object({
    id: z.number().describe('Zone id (referenced by assignments)'),
    name: z.string().optional(),
    x: z.number().describe('Zone center X (mm, board origin at center, Y down)'),
    y: z.number().describe('Zone center Y'),
    w: z.number().describe('Zone width'),
    h: z.number().describe('Zone height')
});

tool('millpcb_set_plan', 'Set the design plan: requirements, placement zones, component->zone assignments, placement groups, and signal flow direction. Drives the guided workflow (plan -> place -> route). Groups = [{key, members:[compId]}]: each group is one column along the flow axis, members stacked on the zone cross-axis center (channel per LED).', {
    requirements: z.record(z.any()).nullable().optional().describe('Design contract: what the board must do (function, board size, inputs/outputs, current->trace width, net rules). The acceptance target for the final check. null clears'),
    zones: z.array(zoneSchema).optional().describe('Placement zones (axis-aligned rects)'),
    assignments: z.record(z.number()).optional().describe('Map of component id -> zone id'),
    groups: z.array(z.object({ key: z.union([z.string(), z.number()]), members: z.array(z.number()).min(1) })).optional().describe('Placement groups: one flow-axis index per group, members share it'),
    flowDirection: z.enum(['lr', 'rl', 'tb', 'bt']).optional().describe('Signal flow axis for placement spread')
}, async (args) => {
    const patch = {};
    if (args.requirements !== undefined) patch.requirements = args.requirements;
    if (args.zones !== undefined) patch.zones = args.zones;
    if (args.assignments !== undefined) patch.assignments = args.assignments;
    if (args.groups !== undefined) patch.groups = args.groups;
    if (args.flowDirection !== undefined) patch.flowDirection = args.flowDirection;
    boardMutate(p => ProjectApi.setPlan(p, patch));
    afterMutation(entry, { message: 'plan updated' });
    const p = session.project;
    return { ok: true, requirements: p.requirements, zones: p.zones, assignments: p.assignments, groups: p.groups, flowDirection: p.flowDirection, revision: session.revision };
});

tool('millpcb_set_netlist', 'Declare the circuit on the SCHEMATIC before any copper: net name -> list of pins ({compId, pin}). Lays no copper. Switches the live preview to the Schematic and places symbols that have no schematic position, so the user sees the circuit. Same-component pins are legal (a trimmer wiper ties two pins of one pot). Rejects unknown compId/pin and a pin already declared on a different net.', {
    nets: z.record(z.array(z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) }))).describe('Net name -> member pins'),
    mode: z.enum(['merge', 'replace']).optional().describe('merge (default) adds to the stored netlist; replace clears it first')
}, async ({ nets, mode }) => {
    const res = boardMutate(p => {
        const out = ProjectApi.setNetlist(p, nets, mode || 'merge');
        if (SchematicLayout) SchematicLayout.placeMissing(p.components, p.traces, p.netlist);
        return out;
    });
    afterMutation(entry, { message: `netlist: ${res.nets} net(s), ${res.pinCount} pin(s)` });
    showPreview(entry, 'schematic');
    return { ok: true, ...res, view: 'schematic', revision: session.revision };
});

tool('millpcb_route_rail', 'Lay one net as a rail along a board edge: pins sorted along the rail, a bus stroke at `at` (explicit coordinate) or offset from `edge` by `stub`, and one trace per consecutive pair whose endpoints ARE the pins (A -> rail -> B). Every pin on the rail is then electrically visible (getPinNet / connectivity / schematic all agree). Creates netlist entries as it routes. Fails the whole call if any pin is missing or if any new segment would cross another net (nothing is stored in that case).', {
    net: z.string().describe('Net name (created if new)'),
    pins: z.array(z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) })).min(2).optional().describe('Rail member pins; defaults to this net\'s stored netlist entries'),
    edge: z.enum(['top', 'bottom', 'left', 'right']).optional().describe('Rail edge (default top)'),
    at: z.number().optional().describe('Explicit rail coordinate in mm (board center, Y down) overriding edge'),
    width: z.number().optional().describe('Rail trace width (default params.traceWidth)'),
    stub: z.number().optional().describe('Rail offset from the pin line in mm (default 2)')
}, async ({ net, pins, edge, at, width, stub }) => {
    const memberPins = (pins && pins.length) ? pins : ((session.project.netlist && session.project.netlist[net]) || []);
    if (memberPins.length < 2) return { ok: false, error: `route_rail: net "${net}" has no pins — pass pins or declare them first with millpcb_set_netlist` };
    const gate = copperGate(entry);
    if (gate) return gate;
    const res = boardMutate(p => ProjectApi.routeRail(p, net, memberPins, { edge, at, width, stub }));
    afterMutation(entry, { message: `rail ${res.net}: ${res.traces.length} trace(s)`, ids: res.traces.map(t => t.id) });
    showPreview(entry, 'board');
    return {
        ok: true, net: res.net, rail: (edge || 'top') === 'top' || (edge || 'top') === 'bottom' ? { y: res.rail } : { x: res.rail },
        traces: res.traces.map(t => ({ id: t.id, points: t.points })),
        revision: session.revision
    };
});

tool('millpcb_place_by_plan', 'Compute plan-driven component positions from zones + groups + flow direction. Dry-run by default (returns the moves with resulting pin coordinates without applying); apply=true moves the components. With groups, each group is a channel: member i of every group lands on the same flow-axis coordinate (R at X0, trimmer at X1, LED at X2 — columns line up); channels share the zone cross-center, zone.stagger spreads them. Single-layer: placement is how you avoid crossings, not routing.', {
    apply: z.boolean().optional().describe('Apply the placement to the board (default false = preview only)')
}, async ({ apply }) => {
    const moves = Plan.placeByPlan(session.project);
    const withPins = moves.map(m => {
        const c = session.project.components.find(x => x.id === m.id);
        const saved = c ? { x: c.x, y: c.y } : null;
        if (c) { c.x = m.x; c.y = m.y; }
        const out = c ? compWithPins(session.project, c) : { id: m.id, x: m.x, y: m.y };
        if (c && saved) { c.x = saved.x; c.y = saved.y; }
        return { id: m.id, x: m.x, y: m.y, pins: out.pins };
    });
    if (!apply) return { ok: true, applied: false, moves: withPins };
    boardMutate(p => Plan.applyPlacement(p, moves));
    afterMutation(entry, { message: `placed ${moves.length} component(s) by plan`, ids: moves.map(m => m.id) });
    showPreview(entry, 'board');
    const planViolations = Plan.planCheck(session.project);
    return { ok: true, applied: true, moves: withPins, planCheck: planViolations, revision: session.revision };
});

tool('millpcb_check', 'Run a design check. type="drc" (trace width, clearance, drill size — refreshes the preview DRC panel; status DRC_INVALID when errors), "plan" (placement), "quality" (no vias, no cross-net crossings, nets not split; status QUALITY_INVALID), "circuit" (the CONTRACT). Circuit first runs Plan.electricalCheck and stores electricalValidation for this revision. status NETLIST_VALID opens copper. status NETLIST_INVALID means fix the netlist or contract — do not route. When physical copper exists, Plan.circuitCheck also runs: COPPER_VALID or COPPER_INVALID. A missing contract is NETLIST_INVALID. Any edit clears the stored pass. Passing args stores the contract; calling again with no args re-checks the stored one.', {
    type: z.enum(['drc', 'plan', 'quality', 'circuit']).describe('Which check to run'),
    rails: z.array(z.object({ net: z.string(), pins: z.array(z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) })).optional() })).optional().describe('circuit only: rail declarations'),
    branches: z.array(z.object({ net: z.string(), from: z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) }), to: z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) }) })).optional().describe('circuit only: branch declarations (single links)'),
    ties: z.array(z.object({ net: z.string(), pins: z.array(z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) })).optional() })).optional().describe('circuit only: same-component tie declarations'),
    unused: z.array(z.object({ compId: z.number(), pin: z.union([z.string(), z.number()]) })).optional().describe('circuit only: pins intentionally left unconnected (NC)')
}, async ({ type, rails, branches, ties, unused }) => {
    if (type === 'drc') {
        const result = session.runDrc();
        broadcast(entry, 'drc', { revision: session.revision, ...result });
        const errors = (result.violations || []).filter(v => v.severity === 'error');
        return { ok: errors.length === 0, ...(errors.length ? { status: 'DRC_INVALID' } : {}), ...result };
    }
    if (type === 'plan') {
        const violations = Plan.planCheck(session.project);
        return { ok: violations.length === 0, violations };
    }
    if (type === 'quality') {
        const violations = Plan.qualityCheck(session.project);
        return { ok: violations.length === 0, ...(violations.length ? { status: 'QUALITY_INVALID' } : {}), violations };
    }
    const denied = mutationGate(holder);
    if (denied) return denied;
    const incoming = (rails || []).length + (branches || []).length + (ties || []).length + (unused || []).length;
    let contract;
    if (incoming) {
        contract = { rails: rails || [], branches: branches || [], ties: ties || [], unused: unused || [] };
        boardMutate(p => { p.circuitContract = contract; });
    } else if (session.project.circuitContract) {
        contract = session.project.circuitContract;
    } else {
        const nets = Object.keys(session.project.netlist || {});
        const violations = [{ type: 'missing-contract', severity: 'error', msg: `No circuit contract. Stored nets: ${nets.join(', ') || '(none)'}. Declare rails, branches, ties, and unused pins.` }];
        storeElectricalValidation(session, violations);
        return { ok: false, electricalOk: false, status: 'NETLIST_INVALID', netlistStatus: 'NETLIST_INVALID', violations, revision: session.revision };
    }
    const electrical = Plan.electricalCheck(session.project, contract);
    storeElectricalValidation(session, electrical);
    const netlistStatus = electrical.length ? 'NETLIST_INVALID' : 'NETLIST_VALID';
    let copper = [];
    let status = netlistStatus;
    if (!electrical.length && hasPhysicalCopper(session.project)) {
        copper = Plan.circuitCheck(session.project, contract);
        status = copper.length ? 'COPPER_INVALID' : 'COPPER_VALID';
    }
    if (incoming) afterMutation(entry, { message: `circuit contract: ${contract.rails.length} rail(s), ${contract.branches.length} branch(es), ${contract.ties.length} tie(s)` });
    const violations = electrical.concat(copper);
    return {
        ok: status === 'NETLIST_VALID' || status === 'COPPER_VALID',
        electricalOk: electrical.length === 0,
        status,
        netlistStatus,
        copperStatus: hasPhysicalCopper(session.project) && !electrical.length ? (copper.length ? 'COPPER_INVALID' : 'COPPER_VALID') : null,
        violations,
        revision: session.revision
    };
});

// ---------------------------------------------------------------------------
// Library + inspect tools
// ---------------------------------------------------------------------------
tool('millpcb_list_footprints', 'List the component types available to millpcb_add_component: built-ins plus all embedded KiCad library entries (144 footprints in libs/) plus agent-imported persistent library parts. Compact by design — use it instead of reading js/kicad-lib-embed.js, which is too large for a model context. When several packages exist for one part, pick the largest that fits: THT first, then 1206, then 0805, then 0603.', {},
    async () => ({ ok: true, footprints: ProjectApi.listFootprints() }));

tool('millpcb_import_kicad', 'Import a KiCad footprint into this session\'s component library. Two forms: path = repo-relative .kicad_mod file (or a directory to import all .kicad_mod in it); OR content = pasted genuine .kicad_mod source text for an EXTERNAL part (ONLY genuine parts exported from real KiCad libraries — the check rejects invented geometry: a real footprint must have (version/(generator) headers and fab/silk courtyard graphics), optionally paired with its .kicad_sym symbol text for real pin names. The text form is saved to the persistent library (.mcp/library/) so it is reusable in every future session. Check millpcb_list_footprints FIRST and use a built-in part when it exists. Place afterwards with millpcb_add_component using the returned type key (e.g. "kx_fuse_holder_5x20").', {
    path: z.string().optional().describe('Repo-relative .kicad_mod file or directory, e.g. "libs/misc/Fuse_Holder_5x20.kicad_mod" or "libs/misc"'),
    content: z.string().optional().describe('Full genuine .kicad_mod source text (external part), e.g. (footprint "Package_SO:SOIC-8_..." (version 20240101) (generator "pcbnew") ...)'),
    symbol: z.string().optional().describe('Optional matching .kicad_sym symbol library text — gives real pin names AND the real symbol graphics drawn in the schematic view'),
    pinNames: z.record(z.string()).optional().describe('Optional pad-number -> pin-name override, e.g. {"1":"A","2":"K"}'),
    model3d: z.array(z.object({ name: z.string().optional(), uri: z.string() })).optional().describe('Optional 3D model reference(s) for the part — URL or KiCad path of the .wrl/.step model. Footprints with embedded (model ...) statements carry theirs automatically.'),
    overwrite: z.boolean().optional().describe('Allow replacing a built-in footprint with the same key (default false — collisions are rejected)')
}, async ({ path: p, content, symbol, pinNames, model3d, overwrite }) => {
    if (!KicadImport) return { ok: false, error: 'KiCad import unavailable in this kernel' };
    if (content) {
        const { def } = validateFootprintText(content, KicadImport, ComponentDefs, { overwrite, symbolText: symbol, model3d });
        if (pinNames && def.sizes[0]) {
            const size = def.sizes[0];
            size.pins = (size.pins || []).map((pn, i) => {
                const padNum = size.kicad && size.kicad.pads[i] ? size.kicad.pads[i].num : null;
                return padNum != null && pinNames[padNum] ? { ...pn, name: pinNames[padNum] } : pn;
            });
        }
        KicadImport.registerEntries([def]);
        broadcast(entry, 'library', { defs: [def] });
        const m3d = def.sizes[0] && def.sizes[0].model3d;
        const file = persistFootprint(ROOT, def.key, content, symbol, m3d);
        const size = def.sizes[0];
        return {
            ok: true, key: def.key, label: def.label, saved: file,
            width: size.width, height: size.height, pins: (size.pins || []).map(x => x.name),
            symbolGraphics: !!(size.symGraphics && size.symGraphics.length),
            model3d: m3d ? m3d.map(m => m.uri) : undefined,
            note: 'saved to the persistent library — reusable in all future sessions'
        };
    }
    if (!p) return { ok: false, error: 'pass path (repo file/dir) or content (pasted .kicad_mod text)' };
    const target = safeResolve(ROOT, p);
    let files = [];
    if (fs.statSync(target).isDirectory()) {
        files = fs.readdirSync(target).filter(f => f.toLowerCase().endsWith('.kicad_mod') || f.toLowerCase().endsWith('.mod'));
    } else {
        files = [path.basename(target)];
    }
    const parts = [];
    let added = 0;
    for (const f of files) {
        const fp = KicadImport._parseFootprint(fs.readFileSync(path.join(target, f), 'utf8'));
        if (!fp) continue;
        const def = KicadImport._buildDef(fp, null);
        if (!def || !def.key) continue;
        // sizes[0].pins is in the same order as sizes[0].kicad.pads.
        if (pinNames && def.sizes[0]) {
            const size = def.sizes[0];
            size.pins = (size.pins || []).map((pn, i) => {
                const padNum = size.kicad && size.kicad.pads[i] ? size.kicad.pads[i].num : null;
                return padNum != null && pinNames[padNum] ? { ...pn, name: pinNames[padNum] } : pn;
            });
        }
        KicadImport.registerEntries([def]); // headless-safe: palette injection is guarded
        added++;
        broadcast(entry, 'library', { defs: [def] });
        const size = def.sizes[0];
        parts.push({ key: def.key, label: def.label, width: size.width, height: size.height, pins: (size.pins || []).map(x => x.name) });
    }
    return { ok: true, added, parts };
});

tool('millpcb_inspect', 'Inspect one object by id (component / trace / via / silk) or summarize all objects.', { id: z.number().optional().describe('Object id; omit for a full listing') },
    async ({ id }) => {
        const p = session.project;
        if (id == null) {
            return { ok: true, revision: session.revision, components: p.components.map(c => ({ id: c.id, label: c.label, type: c.type, x: +c.x.toFixed(2), y: +c.y.toFixed(2), rotation: c.rotation })), traces: p.traces.length, vias: p.vias.length, nets: p.nets.map(n => n.name) };
        }
        const comp = p.components.find(c => c.id === id);
        if (comp) {
            const def = ComponentDefs.get(comp.type);
            const size = def && def.sizes ? def.sizes[comp.size !== undefined ? comp.size : (def.defaultSize || 0)] : null;
            return { ok: true, object: { kind: 'component', ...comp, pinWorlds: comp.pins.map((pin, i) => ({ pin: pin.name, ...ProjectApi.pinWorld(p, comp.id, i) })), model3d: size && size.model3d ? size.model3d.map(m => m.uri) : undefined } };
        }
        const trace = p.traces.find(t => t.id === id);
        if (trace) return { ok: true, object: { kind: 'trace', ...trace } };
        const via = p.vias.find(v => v.id === id);
        if (via) return { ok: true, object: { kind: 'via', ...via } };
        const silk = p.silkTexts.find(s => s.id === id);
        if (silk) return { ok: true, object: { kind: 'silk', ...silk } };
        return { ok: false, error: `no object with id ${id}` };
    });

const pt = z.object({ x: z.number(), y: z.number() }).describe('Board coordinate in mm, origin at board center, Y down');
const pinRef = z.object({
    compId: z.number().describe('Component id'),
    pin: z.union([z.string(), z.number()]).describe('Pin name (e.g. "1", "A", "K"); a number matches the pin name first, then falls back to a 0-based index')
}).describe('A component pin to connect');

/** Agents write pin 1/2 meaning the pins NAMED "1"/"2"; the kernel treats bare
 *  numbers as 0-based indices (pin 2 on a 2-pin part = out of range, pin 1 =
 *  the SECOND pin). Resolve name-first at the MCP boundary, index as fallback. */
function resolvePinRef(ref) {
    if (typeof ref.pin !== 'number') return ref;
    const comp = session.project.components.find(c => c.id === ref.compId);
    if (comp && ProjectApi.getCompPins(comp).some(p => String(p.name) === String(ref.pin))) return { ...ref, pin: String(ref.pin) };
    return ref;
}

// ---------------------------------------------------------------------------
// Edit tools (each mutation broadcasts the project + focuses the new ids)
// ---------------------------------------------------------------------------
tool('millpcb_add_component', 'Place one component, or MANY in one call via parts[] (order preserved; pass a "key" per part and it is echoed back so you can build groups/rail pin lists without guessing ids). Coordinates: mm, origin at board CENTER, Y down (a 60x40 board spans x -30..30, y -20..20). Check part size before spacing — the default resistor is a 6.3mm TH axial — prefer it and other THT/large parts; use a compact sizeIndex (e.g. 14 = 0805) only when space truly demands it. Returns each placed component with its pin WORLD coordinates so you never re-derive rotation.', {
    type: z.string().optional().describe('Component type key from millpcb_list_footprints, e.g. "resistor", "capacitor", "led", "ic", "connector" (single-component form)'),
    x: z.number().optional(), y: z.number().optional(), rotation: z.number().optional(),
    label: z.string().optional().describe('Label override; auto (R1, C2, U1...) when omitted'),
    value: z.string().optional(), sizeIndex: z.number().optional().describe('Index into the type\'s size list (see millpcb_inspect of a built-in for the list)'),
    parts: z.array(z.object({
        type: z.string(), x: z.number(), y: z.number(), rotation: z.number().optional(),
        label: z.string().optional(), value: z.string().optional(), sizeIndex: z.number().optional(),
        key: z.string().optional().describe('Echoed back on the result (e.g. "R1", "LED3")')
    })).min(1).optional().describe('Multi-component form: place many in one call')
}, async (args) => {
    if (Array.isArray(args.parts)) {
        const parts = args.parts;
        const added = boardMutate(p => parts.map(spec => {
            const { key, sizeIndex, ...rest } = spec;
            return ProjectApi.addComponent(p, { ...rest, size: sizeIndex });
        }));
        afterMutation(entry, { message: `added ${added.length} component(s)`, ids: added.map(c => c.id) });
        const out = added.map((c, i) => ({ key: parts[i].key, component: compWithPins(session.project, c) }));
        return { ok: true, parts: out, revision: session.revision };
    }
    if (!args.type || args.x == null || args.y == null) return { ok: false, error: 'pass type + x + y, or a parts[] array' };
    const spec = { type: args.type, x: args.x, y: args.y, rotation: args.rotation, label: args.label, value: args.value, size: args.sizeIndex };
    const comp = boardMutate(p => ProjectApi.addComponent(p, spec));
    afterMutation(entry, { message: `added ${comp.label}`, ids: [comp.id] });
    return { ok: true, component: compWithPins(session.project, comp), revision: session.revision };
});

/** Component summary + pin WORLD coordinates (rounded to µm) — agents place
 *  rails/wires without re-deriving rotation math. */
function compWithPins(project, comp) {
    const pins = (ProjectApi.getCompPins(comp) || []).map((p, i) => {
        const wp = ProjectApi.pinWorld(project, comp.id, i);
        return wp ? { name: String(p.name), x: Math.round(wp.x * 1000) / 1000, y: Math.round(wp.y * 1000) / 1000 } : null;
    }).filter(Boolean);
    return { id: comp.id, label: comp.label, type: comp.type, x: comp.x, y: comp.y, rotation: comp.rotation, pins };
}

tool('millpcb_connect_pins', 'Connect two pins with copper. Default style "ortho": A -> elbow -> B (aligned pins stay one segment). If that net already has a trace, the new copper joins the nearest point on it instead of laying a second path on top. Two DIFFERENT pins of one component are legal — the wiper tie beside a pot. style "straight" stores the direct segment. Refuses the call if the new copper would cross another net.', {
    from: pinRef, to: pinRef, net: z.string().optional().describe('Net name; resolved from existing pin nets or auto-created'), width: z.number().optional(),
    style: z.enum(['ortho', 'straight']).optional().describe('ortho (default) = L path with an elbow; straight = direct segment')
}, async ({ from, to, net, width, style }) => {
    const gate = copperGate(entry);
    if (gate) return gate;
    const trace = boardMutate(p => ProjectApi.connectPins(p, resolvePinRef(from), resolvePinRef(to), { net, width, style }));
    afterMutation(entry, { message: `connected ${net || trace.net}`, ids: [trace.id] });
    showPreview(entry, 'board');
    return { ok: true, trace: { id: trace.id, net: trace.net, points: trace.points }, revision: session.revision };
});

tool('millpcb_autoroute', 'Auto-route every net that is not yet fully wired (A* over the board obstacle map). Returns per-net results; failures are structured, not thrown. A path that would cross another net is not stored.', {
    gridSize: z.number().optional().describe('Search grid step in mm (default 0.1)'),
    layer: z.enum(['top', 'bottom']).optional(),
    traceWidth: z.number().optional(),
    clearance: z.number().optional().describe('Minimum copper-to-copper/pad clearance in mm'),
    skipRouted: z.boolean().optional().describe('Skip nets already fully joined by copper (default true)'),
    onlyNet: z.string().optional().describe('Route just this net (e.g. "NET_7") and leave the others untouched')
}, async (args) => {
    const gate = copperGate(entry, { drc: true });
    if (gate) return gate;
    const result = boardMutate(p => Autoroute.route(p, args));
    const failed = result.failedNets || [];
    afterMutation(entry, { message: `autorouted ${result.routedNets.length} net(s)${failed.length ? ' — ' + failed.map(f => `${f.net}: ${f.reason}`).join('; ') : ''}`, ids: [] });
    showPreview(entry, 'board');
    return { ok: result.success === true, routed: result.routedNets, failed: failed, diagnostics: result.diagnostics || [], revision: session.revision };
});

tool('millpcb_add_schem_wire', 'Add a schematic (logical) wire between two pins: records net connectivity without laying copper. Points are the schematic drawing hint; when the router is available the leg is auto-routed around parts.', {
    from: pinRef, to: pinRef, net: z.string().optional(), width: z.number().optional(),
    points: z.array(pt).optional().describe('Explicit polyline hint; omit for a straight or auto-routed leg')
}, async (args) => {
    const wire = boardMutate(p => {
        const out = ProjectApi.createSchemWire(p, resolvePinRef(args.from), resolvePinRef(args.to), args);
        if (SchematicLayout) SchematicLayout.placeMissing(p.components, p.traces, p.netlist);
        return out;
    });
    afterMutation(entry, { message: `schematic wire on ${wire.net}`, ids: [wire.id] });
    showPreview(entry, 'schematic');
    return { ok: true, wire: { id: wire.id, net: wire.net, points: wire.points }, view: 'schematic', revision: session.revision };
});

tool('millpcb_set_schematic', 'Move components in schematic space (schemX/schemY) without touching board positions.', {
    list: z.array(z.object({ id: z.number(), x: z.number(), y: z.number() })).min(1)
}, async ({ list }) => {
    const moved = boardMutate(p => ProjectApi.setSchemPositions(p, list));
    afterMutation(entry, { message: `moved ${moved.length} component(s) in schematic` });
    showPreview(entry, 'schematic');
    return { ok: true, moved, view: 'schematic', revision: session.revision };
});

tool('millpcb_layout_schematic', 'Auto-arrange the SCHEMATIC view: re-places every component by net topology (hub centred, signal flow left to right, rails on rings) and clears manual wire waypoints so all legs re-route orthogonally around the symbols. Call this after wiring is complete — it fixes crossing/diagonal schematic wires. Board positions are untouched.', { keepPositions: z.boolean().optional().describe('Keep current schemX/schemY and only place components that lack them (default false = full re-layout)') },
    async ({ keepPositions }) => {
        boardMutate(p => {
            if (!keepPositions) for (const c of p.components) { delete c.schemX; delete c.schemY; }
            for (const t of p.traces) if (t.schemWire) t.waypoints = null;
            SchematicLayout.placeMissing(p.components, p.traces, p.netlist);
        });
        afterMutation(entry, { message: 'schematic auto-layout applied' });
        showPreview(entry, 'schematic');
        return {
            ok: true, view: 'schematic', revision: session.revision,
            placed: session.project.components.map(c => ({ id: c.id, label: c.label, x: c.schemX, y: c.schemY }))
        };
    });

tool('millpcb_add_trace', 'Add a freehand copper trace. Refuses the call if the polyline would cross another net.', {
    points: z.array(pt).min(2), net: z.string().optional(), width: z.number().optional(), layer: z.enum(['top', 'bottom']).optional()
}, async (args) => {
    const gate = copperGate(entry);
    if (gate) return gate;
    const trace = boardMutate(p => ProjectApi.addTrace(p, args));
    afterMutation(entry, { message: `trace on ${trace.net}`, ids: [trace.id] });
    showPreview(entry, 'board');
    return { ok: true, trace: { id: trace.id, net: trace.net }, revision: session.revision };
});

tool('millpcb_add_via', 'Rejected. millPCB is a single copper sheet. A crossing is solved by moving parts or placing a JP wire jumper, not a via.', { x: z.number(), y: z.number(), diameter: z.number().optional(), drillDiameter: z.number().optional() },
    async () => ({ ok: false, error: 'millPCB is single-layer. Vias are not supported. Cross a trace with a JP wire jumper, not a via.' }));

tool('millpcb_add_silk_text', 'Add a silkscreen text.', { text: z.string(), x: z.number(), y: z.number(), fontSize: z.number().optional() },
    async (args) => {
        const silk = boardMutate(p => ProjectApi.addSilkText(p, args));
        afterMutation(entry, { message: 'silk text added', ids: [silk.id] });
        return { ok: true, silk: { id: silk.id, text: silk.text }, revision: session.revision };
    });

tool('millpcb_set_outline', 'Set the board outline polygon (null clears it).', { points: z.array(pt).min(3).nullable() },
    async ({ points }) => {
        boardMutate(p => ProjectApi.setOutline(p, points));
        afterMutation(entry, { message: points ? 'outline set' : 'outline cleared' });
        return { ok: true, outlinePoints: points?.length ?? 0, revision: session.revision };
    });

tool('millpcb_add_net', 'Add a named net.', { name: z.string() },
    async ({ name }) => {
        const net = boardMutate(p => ProjectApi.addNet(p, { name }));
        afterMutation(entry, { message: `net ${name} added` });
        return { ok: true, net: net.name, revision: session.revision };
    });

tool('millpcb_update_object', 'Update fields of an existing object (position, rotation, value, width, text...).', {
    id: z.number(), patch: z.record(z.union([z.string(), z.number(), z.boolean()]))
}, async ({ id, patch }) => {
    const obj = boardMutate(p => ProjectApi.updateObject(p, { id, patch }));
    afterMutation(entry, { message: 'object updated', ids: [id] });
    return { ok: true, object: { id: obj.id, ...obj }, revision: session.revision };
});

tool('millpcb_remove_object', 'Remove an object by id.', { id: z.number() },
    async ({ id }) => {
        const removed = boardMutate(p => ProjectApi.removeObject(p, id));
        afterMutation(entry, { message: `removed ${removed.kind} #${id}` });
        return { ok: true, removed: removed.kind, revision: session.revision };
    });

// ---------------------------------------------------------------------------
// Check + export tools
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Eyes + flow: screenshot, ASCII map, workflow status
// ---------------------------------------------------------------------------
tool('millpcb_screenshot', 'SEE the design: returns a PNG image of the board (copper, pads, bodies, zones) or the schematic view (real symbol glyphs, orthogonal wires, labels — same layout the browser draws; a wide sheet is split into readable column strips). Call it after placement/routing to verify what you built looks right — this is your visual feedback loop.', {
    view: z.enum(['board', 'schematic']).optional().describe('What to render (default board)'),
    maxSize: z.number().optional().describe('Max image dimension in px (200-1400, default 900)'),
    crop: z.object({ x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional() }).optional().describe('Schematic only: frame this region in schematic units'),
    columns: z.boolean().optional().describe('Schematic only: one image per component column')
}, async ({ view, maxSize, crop, columns }) => {
    const p = session.project;
    if (view === 'schematic') {
        const strips = renderSchematicPng(p, ProjectApi, { maxSize, rootDir: ROOT, crop, columns });
        const content = [];
        for (let i = 0; i < strips.length; i++) {
            content.push({ type: 'image', data: strips[i].png.toString('base64'), mimeType: 'image/png' });
            if (strips.length > 1) content.push({ type: 'text', text: `schematic strip ${i + 1}/${strips.length}: x ${strips[i].x0.toFixed(0)}..${strips[i].x1.toFixed(0)} schematic units` });
        }
        content.push({ type: 'text', text: JSON.stringify({ view: 'schematic', revision: session.revision, strips: strips.length, components: p.components.length, traces: p.traces.length }) });
        return { content };
    }
    const png = renderBoardPng(p, ProjectApi, ROOT, { maxSize });
    return {
        content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ view: view || 'board', revision: session.revision, board: `${p.board.width}x${p.board.height}mm`, components: p.components.length, traces: p.traces.length }) }
        ]
    };
});

tool('millpcb_render_map', 'Text (ASCII) map of the board: zones, copper, components with ids — precise, label-readable layout for reasoning where a picture is not enough.', {
    cols: z.number().optional().describe('Map width in characters (40-200, default 110)')
}, async ({ cols }) => {
    const p = session.project;
    const nCols = Math.min(200, Math.max(40, cols || 110));
    const bw = p.board.width, bh = p.board.height;
    const nRows = Math.max(10, Math.round(nCols * (bh / bw) * 0.5)); // chars are ~2x taller than wide
    const grid = Array.from({ length: nRows }, () => Array(nCols).fill('.'));
    const px = (x) => Math.round((x + bw / 2) / bw * (nCols - 1));
    const py = (y) => Math.round((y + bh / 2) / bh * (nRows - 1));
    const put = (x, y, ch) => {
        const c = px(x), r = py(y);
        if (r < 0 || c < 0 || r >= nRows || c >= nCols) return;
        grid[r][c] = ch;
    };
    const line = (x0, y0, x1, y1, ch) => {
        const steps = Math.max(Math.abs(px(x1) - px(x0)), Math.abs(py(y1) - py(y0)), 1);
        for (let i = 0; i <= steps; i++) put(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, ch);
    };
    for (const z of p.zones || []) {
        const hw = (z.w || 0) / 2, hh = (z.h || 0) / 2;
        line(z.x - hw, z.y - hh, z.x + hw, z.y - hh, '='); line(z.x - hw, z.y + hh, z.x + hw, z.y + hh, '=');
        line(z.x - hw, z.y - hh, z.x - hw, z.y + hh, '='); line(z.x + hw, z.y - hh, z.x + hw, z.y + hh, '=');
    }
    for (const t of p.traces || []) {
        if (t.schemWire) continue;
        const pts = t.points || [];
        for (let i = 1; i < pts.length; i++) line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, '#');
    }
    for (const v of p.vias || []) put(v.x, v.y, 'o');
    for (const comp of p.components || []) {
        const label = String(comp.id);
        put(comp.x, comp.y, label[label.length - 1]);
    }
    const legend = p.components.map(c => `${c.id}=${c.type}${c.ref ? ' ' + c.ref : ''}@(${(c.x ?? 0).toFixed(1)},${(c.y ?? 0).toFixed(1)})`).join('  ');
    const frame = grid.map(row => `|${row.map(ch => ch === '.' ? ' ' : ch).join('')}|`);
    return {
        ok: true,
        board: `${bw}x${bh}mm`,
        map: `  +${'-'.repeat(nCols)}+\n${frame.join('\n')}\n  +${'-'.repeat(nCols)}+`,
        legend,
        symbols: '#=copper o=via ==zone border letter=component id (last digit)'
    };
});

tool('millpcb_workflow', 'Where am I in the design flow? Read-only status: plan -> placement -> schematic -> electrical -> routing -> copper circuit -> quality -> drc -> export, with pass/fail per step and the single recommended next action. Electrical validation is a hard gate: copper stays closed until electricalOk. Call at the start and after every major step.', {},
    async () => {
        const p = session.project;
        const steps = [];
        const hasPlan = !!(p.requirements && (p.zones || []).length && Object.keys(p.assignments || {}).length);
        steps.push({ step: 'plan', status: hasPlan ? 'done' : 'todo', detail: hasPlan ? `${(p.zones || []).length} zones, ${Object.keys(p.assignments || {}).length} assignments` : 'set requirements + zones + assignments (millpcb_set_plan)' });
        const comps = p.components.length;
        steps.push({ step: 'place', status: comps ? 'done' : 'todo', detail: `${comps} components on board` });
        const planViolations = Plan.planCheck(p);
        steps.push({ step: 'planCheck', status: planViolations.length ? 'fail' : (comps ? 'pass' : 'todo'), detail: planViolations.length ? `${planViolations.length} placement violation(s) — millpcb_check type="plan"` : 'placement inside zones, no overlaps' });
        const schemDeclared = schematicReady(p);
        const schemPlaced = (p.components || []).every(c => typeof c.schemX === 'number' && typeof c.schemY === 'number');
        let schemStatus, schemDetail;
        if (!comps) { schemStatus = 'todo'; schemDetail = 'place components first'; }
        else if (!schemDeclared) { schemStatus = 'todo'; schemDetail = 'declare the circuit with millpcb_set_netlist — the preview switches to the Schematic before any copper'; }
        else if (!schemPlaced) { schemStatus = 'todo'; schemDetail = 'call millpcb_layout_schematic so the sheet is readable, then run the electrical check'; }
        else { schemStatus = 'pass'; schemDetail = 'circuit is declared and symbols are placed — preview shows the Schematic'; }
        steps.push({ step: 'schematic', status: schemStatus, detail: schemDetail });
        const validation = p.electricalValidation;
        const electricalFresh = !!(validation && validation.revision === session.revision);
        let electricalStatus, electricalDetail;
        if (!schemDeclared) { electricalStatus = 'todo'; electricalDetail = 'declare the schematic first (millpcb_set_netlist)'; }
        else if (!electricalFresh) { electricalStatus = 'todo'; electricalDetail = 'run millpcb_check type="circuit". A netlist is not validation, and any edit clears a previous pass.'; }
        else if (!validation.valid) { electricalStatus = 'fail'; electricalDetail = `${(validation.violations || []).length} electrical violation(s) — fix the netlist or contract, then millpcb_check type="circuit". Do not route.`; }
        else { electricalStatus = 'pass'; electricalDetail = 'electrical/netlist validation passed'; }
        steps.push({ step: 'electrical', status: electricalStatus, detail: electricalDetail });
        const physical = p.traces.filter(t => !t.schemWire).length;
        const plan = Autoroute.planNets(p, {});
        const unassigned = (plan.diagnostics || []).filter(d => d.code === 'UNASSIGNED_PIN');
        const unwired = plan.nets.filter(n => !Autoroute.isFullyWired(p, n.name));
        let routeStatus, routeDetail;
        if (!comps) { routeStatus = 'todo'; routeDetail = 'place components first'; }
        else if (!schemDeclared) { routeStatus = 'todo'; routeDetail = 'schematic first — millpcb_set_netlist, then electrical validation, then copper'; }
        else if (electricalStatus !== 'pass') { routeStatus = 'blocked'; routeDetail = 'electrical validation required before copper routing'; }
        else if (!physical) { routeStatus = 'todo'; routeDetail = 'electrical check passed — lay rails (millpcb_route_rail) and links (millpcb_connect_pins), then millpcb_autoroute. The preview switches to the Board.'; }
        else if (unassigned.length) { routeStatus = 'fail'; routeDetail = `${unassigned.length} pin(s) on no net — connect each pin to its net (millpcb_connect_pins / millpcb_route_rail / millpcb_set_netlist) before routing`; }
        else if (unwired.length) { routeStatus = 'fail'; routeDetail = `${unwired.length} net(s) not fully wired: ${unwired.map(n => n.name).join(', ')} — millpcb_autoroute`; }
        else { routeStatus = 'pass'; routeDetail = 'all nets connected with copper'; }
        steps.push({ step: 'route', status: routeStatus, detail: routeDetail });
        const circuitViolations = p.circuitContract ? Plan.circuitCheck(p, p.circuitContract) : [{ type: 'missing-contract' }];
        steps.push({ step: 'circuit', status: !p.circuitContract ? 'todo' : (circuitViolations.length ? 'fail' : 'pass'), detail: !p.circuitContract ? 'declare rails/branches/ties (millpcb_check type="circuit")' : circuitViolations.length ? `${circuitViolations.length} copper contract violation(s) — route them, then millpcb_check type="circuit"` : 'declared circuit contract matches copper' });
        const quality = Plan.qualityCheck(p);
        steps.push({ step: 'qualityCheck', status: quality.length ? 'fail' : (comps ? 'pass' : 'todo'), detail: quality.length ? `${quality.length} violation(s) — millpcb_check type="quality"` : 'no vias / crossings / split GND' });
        const drc = session.runDrc() || {};
        const drcErrors = (drc.violations || []).filter(v => v.severity === 'error');
        steps.push({ step: 'drc', status: drcErrors.length ? 'fail' : (comps ? 'pass' : 'todo'), detail: drcErrors.length ? `${drcErrors.length} error(s) — millpcb_check type="drc"` : 'clearance/width/drill rules ok' });
        const exportReady = hasPlan && comps && !planViolations.length && electricalStatus === 'pass' && routeStatus === 'pass' && !circuitViolations.length && !quality.length && !drcErrors.length;
        steps.push({ step: 'export', status: exportReady ? 'ready' : 'blocked', detail: exportReady ? 'millpcb_export (format=svg/dxf/gcode) is unlocked' : 'fix failing steps first (electrical, route, circuit, quality, DRC)' });
        const order = ['plan', 'place', 'planCheck', 'schematic', 'electrical', 'route', 'circuit', 'qualityCheck', 'drc', 'export'];
        const next = steps.find(s => s.status === 'todo' || s.status === 'fail' || s.status === 'blocked');
        return {
            ok: true,
            revision: session.revision,
            board: `${p.board.width}x${p.board.height}mm`,
            components: comps,
            traces: p.traces.filter(t => !t.schemWire).length,
            steps,
            next: next ? { step: next.step, do: next.detail } : null,
            tip: 'The live preview follows you: Schematic while the circuit is declared, Board once copper is laid. Screenshot the view you are on before moving on.'
        };
    });

function exportToFile(kind, filename, content) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    const file = path.join(EXPORTS_DIR, filename);
    fs.writeFileSync(file, content);
    return { ok: true, format: kind, file, bytes: Buffer.byteLength(content), preview: content.split('\n').slice(0, 8).join('\n') };
}

/** Session-namespaced, traversal-safe export file name: two users exporting
 *  "board" never overwrite each other, and a name can never escape EXPORTS_DIR. */
function exportFileName(name, id, kind) {
    const safe = String(name || 'board').replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 60) || 'board';
    return `${safe}-${id}.${kind}`;
}

tool('millpcb_export', 'Export the board. format="svg" (mm units), "dxf" (R2000, Y-up, origin at south-west corner) or "gcode" (GRBL isolation + drill + outline). Writes exports/<name>-<session>.<ext> (session-namespaced — never overwrites another user file). Gated: refuses while plan, electrical, copper-circuit, quality, or DRC checks fail.', {
    format: z.enum(['svg', 'dxf', 'gcode']).describe('Export format'),
    name: z.string().optional()
}, async ({ format, name }) => {
    const planViolations = Plan.planCheck(session.project);
    if (planViolations.length) return { ok: false, gated: 'plan', violations: planViolations, error: 'plan check failed — fix placement before export' };
    const electrical = electricalGate(entry);
    if (electrical) return electrical;
    const copper = Plan.circuitCheck(session.project, session.project.circuitContract);
    if (copper.length) return { ok: false, gated: 'circuit', status: 'COPPER_INVALID', violations: copper, error: 'circuit check failed — copper does not match the contract' };
    const quality = Plan.qualityCheck(session.project);
    if (quality.length) return { ok: false, gated: 'quality', status: 'QUALITY_INVALID', violations: quality, error: 'quality check failed — millpcb_check type="quality" before export' };
    const drc = session.runDrc() || {};
    const drcErrors = (drc.violations || []).filter(v => v.severity === 'error');
    if (drcErrors.length) return { ok: false, gated: 'drc', status: 'DRC_INVALID', violations: drcErrors, error: 'DRC reports errors — fix them before export' };
    const gen = { svg: ProjectApi.exportSvg.bind(ProjectApi), dxf: ProjectApi.exportDxf.bind(ProjectApi), gcode: ProjectApi.exportGcode.bind(ProjectApi) }[format];
    return { ...exportToFile(format, exportFileName(name, entry.id, format), gen(session.project)), status: 'EXPORT_ALLOWED' };
});
}

// ---------------------------------------------------------------------------
// HTTP (Streamable) MCP transport — one McpServer per client, bound to the
// registry session named by ?session=<id> (default: 'default').
// v1: POST-only (no server->client SSE stream); GET => 405, DELETE closes a session.
// ---------------------------------------------------------------------------
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 10 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); }
        });
        req.on('end', () => {
            if (!data) return resolve(undefined);
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body: ' + e.message)); }
        });
        req.on('error', reject);
    });
}

let httpServer = null;

function createMcpHandler() {
    const transports = new Map(); // mcp-session-id -> { transport, server }

    return async (req, res) => {
        let url;
        try { url = new URL(req.url, `http://localhost:${MCP_PORT}`); }
        catch (e) { res.writeHead(400); res.end('bad request'); return; }

        if (url.pathname !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found — the MCP endpoint is /mcp');
            return;
        }
        const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const presented = header || url.searchParams.get('token') || '';
        const operator = !!(TOKEN && presented === TOKEN);
        const owned = !operator && presented ? findSessionBySecret(presented) : null;
        if (TOKEN && !operator && !(owned && sessionIsLive(owned))) {
            const userToken = /^[a-f0-9]{32}$/.test(presented);
            const status = userToken ? 409 : 401;
            const error = userToken ? 'sorry but there is no active session' : 'token required — pass Authorization: Bearer <MILLPCB_TOKEN> or ?token=***';
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error }));
            return;
        }

        const requested = canonicalSessionId(url.searchParams.get('session') || 'default');
        let entry;
        let lockedToUser = false;
        if (owned && sessionIsLive(owned)) {
            entry = owned;
            touchEntry(entry);
            lockedToUser = true;
        } else if (requested === 'default') entry = getSessionEntry('default');
        else {
            if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(requested)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'invalid session id' }));
                return;
            }
            entry = peekSession(requested);
            if (!sessionIsLive(entry)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'sorry but there is no active session' }));
                return;
            }
            touchEntry(entry);
        }

        const sessionId = req.headers['mcp-session-id'];
        let transportEntry = sessionId ? transports.get(sessionId) : undefined;
        try {
            if (req.method === 'POST') {
                if (!transportEntry) {
                    const transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => crypto.randomUUID(),
                        onsessioninitialized: (id) => { if (transportEntry) transports.set(id, transportEntry); }
                    });
                    transportEntry = { transport, server: null };
                    transport.onclose = () => {
                        if (transport.sessionId && transports.get(transport.sessionId) === transportEntry) transports.delete(transport.sessionId);
                        entry.mcpTransports.delete(transport);
                        dropAgentForTransport(entry, transport);
                        const h = transportEntry.server && transportEntry.server.holder;
                        if (h && h.entry !== entry) { h.entry.mcpTransports.delete(transport); dropAgentForTransport(h.entry, transport); }
                    };
                    const mcpServer = createMcpServer(entry);
                    transportEntry.server = mcpServer;
                    mcpServer.holder.transport = transport; // enables millpcb_use_session re-binding
                    mcpServer.holder.lockedSessionId = lockedToUser ? entry.id : null;
                    entry.mcpTransports.add(transport);
                    await mcpServer.connect(transport);
                }
                const body = await readJsonBody(req);
                await transportEntry.transport.handleRequest(req, res, body);
            } else if (req.method === 'DELETE') {
                if (!transportEntry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('unknown session'); return; }
                await transportEntry.transport.handleRequest(req, res);
                try { await transportEntry.server?.close(); } catch (e) { /* ignore */ }
                transports.delete(sessionId);
                entry.mcpTransports.delete(transportEntry.transport);
                dropAgentForTransport(entry, transportEntry.transport);
                { const h = transportEntry.server && transportEntry.server.holder; if (h && h.entry !== entry) { h.entry.mcpTransports.delete(transportEntry.transport); dropAgentForTransport(h.entry, transportEntry.transport); } }
            } else {
                res.writeHead(405, { 'Allow': 'POST, DELETE', 'Content-Type': 'text/plain' });
                res.end('method not allowed — use POST (MCP Streamable HTTP)');
            }
        } catch (e) {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            try { res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } })); }
            catch (e2) { /* ignore */ }
        }
    };

}

// Shared by the dedicated MCP port and the preview port (single public port when
// a CDN/proxy restricts ports, e.g. Cloudflare only forwards 2053/2083/2087/2096/8443).
const mcpHandler = createMcpHandler();

function startHttpMcp() {
    httpServer = TLS ? https.createServer(TLS, mcpHandler) : http.createServer(mcpHandler);
    httpServer.listen(MCP_PORT, BIND);
    console.error(`[millpcb-mcp] MCP endpoint: ${TLS ? 'https' : 'http'}://${BIND === '0.0.0.0' ? '<host>' : BIND}:${MCP_PORT}/mcp` + (TOKEN ? ' [token required]' : ''));
}

// ---------------------------------------------------------------------------
// Startup: optional restore, preview server, then the chosen transport.
// ---------------------------------------------------------------------------
async function main() {
    if (!['stdio', 'http'].includes(TRANSPORT)) {
        console.error(`[millpcb-mcp] unknown MILLPCB_TRANSPORT '${TRANSPORT}' (expected 'stdio' or 'http')`);
        process.exit(1);
    }

    // Persistent footprint library: re-register agent-imported parts.
    try {
        const n = loadPersistentLibrary(ROOT, KicadImport, ComponentDefs);
        if (n) console.error(`[millpcb-mcp] persistent library: ${n} footprint(s) re-loaded`);
    } catch (e) { console.error('[millpcb-mcp] persistent library load failed:', e.message); }

    // Docker restarts: reload the autosaved project so edits survive container recreation.
    if (process.env.MILLPCB_RESTORE === '1') {
        const def = getSessionEntry('default');
        const file = def.session.autoSaveFile;
        if (file && fs.existsSync(file)) {
            try {
                def.session.loadParsed(JSON.parse(fs.readFileSync(file, 'utf8')));
                console.error(`[millpcb-mcp] restored project from ${file} (rev ${def.session.revision})`);
            } catch (e) {
                console.error('[millpcb-mcp] restore failed:', e.message);
            }
        }
    }

    try {
        previewInfo = await startPreviewServer({ rootDir: ROOT, port: PREVIEW_PORT, getSession: getSessionEntry, peekSession, acceptEventToken, listSessions: () => registry.values(), bind: BIND, token: TOKEN, tls: TLS, mcpHandler });
        if (process.env.MILLPCB_OPEN_BROWSER === '1' && TRANSPORT === 'stdio') {
            const cmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
            childProcess.spawn(cmd, [previewInfo.url], { detached: true, stdio: 'ignore' }).unref();
        }
    } catch (e) {
        console.error('[millpcb-mcp] preview server unavailable:', e.message);
    }

    const sweeper = setInterval(sweepSessions, 10 * 60 * 1000);
    sweeper.unref();
    sweepAutosaveFiles(); // startup pass: prune stale per-id files left from past runs

    const shutdown = async () => {
        try { await previewInfo?.close(); } catch (e) { /* ignore */ }
        if (httpServer) { try { httpServer.close(); } catch (e) { /* ignore */ } }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    if (TRANSPORT === 'http') {
        startHttpMcp();
        console.error(`[millpcb-mcp] ready — root ${ROOT}, MCP port ${MCP_PORT} (/mcp?session=<id>), preview ${previewInfo?.url ?? 'off'}`);
        return;
    }

    process.stdin.on('close', shutdown); // MCP client disconnected (stdio only)
    const server = createMcpServer(getSessionEntry('default'));
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[millpcb-mcp] ready — root ${ROOT}, preview ${previewInfo?.url ?? 'off'}`);
}

main().catch((e) => { console.error('[millpcb-mcp] fatal:', e); process.exit(1); });


