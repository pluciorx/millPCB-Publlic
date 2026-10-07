# Plan: millPCB MCP Server (agent tool)

## Goal

Give coding agents an **MCP server** that can create, edit, check, and export millPCB projects — and **show those edits live on the board canvas** while the agent works.

**Deployment (v2, primary):** the backend runs as a **Docker container managed via Portainer** on the user's machine, exposing MCP over **Streamable HTTP** plus the localhost SSE preview. The website stays on **shared hosting** (static SPA). Local `node mcp/server.mjs` (stdio) remains the dev fallback. See **Deployment v2** below.

The source of truth for an agent session is the MCP process (in-memory project). The open editor is a **live view** of that session via **SSE** (Server-Sent Events) on localhost. Saving still writes `.pcb.json`; export still writes SVG / DXF / G-code.

## Why this shape

millPCB is a **no-backend SPA**. The global `App` object, canvas, and DOM stay in the browser. Export and G-code already run in Node via `vm`. The MCP process is long-lived (as long as Cursor has the server attached), so it can host a tiny **localhost HTTP + SSE** preview without becoming a public backend.

Do **not**:

- Puppeteer / CDP the canvas (slow, brittle, no need)
- Add a bundler, TypeScript build, or CDN to the SPA
- Put `package.json` at the repo root
- Duplicate SVG/DXF/G-code generators in the MCP layer
- Host the MCP process on millpcb.com (no Node on FTP; no multi-user agent backend in v1)

Do:

- Isolate Node + MCP SDK under `mcp/`
- Extract a **DOM-free project kernel** the browser and MCP both call
- After every mutating tool, **broadcast** the project so the canvas redraws
- Keep `file://` working when MCP is not running (no EventSource, normal editor)

## Why SSE (not WebSocket for v1)

| | SSE | WebSocket |
|---|-----|-----------|
| Direction | Server → browser (exactly the agent→screen path) | Bidirectional |
| Browser API | `EventSource`, auto-reconnect | Manual reconnect |
| MCP stdio | Unrelated; SSE is a second listener on localhost HTTP | Same |

Agent commands already arrive over MCP stdio. The screen only needs to **follow**. SSE is the right fit.

Bidirectional sync (user drags a part in the preview tab, agent sees it) is **Phase 4**: `POST /api/project` or then upgrade to WebSocket. v1 preview is **follow-the-agent**.

## Architecture

```
Agent (Cursor / Claude)
        │  MCP stdio (JSON-RPC)
        ▼
┌──────────────────────────────────────────┐
│  mcp/server.mjs                          │
│    tool handlers + path sandbox          │
│    on mutate → preview.broadcast(...)    │
├──────────────────────────────────────────┤
│  mcp/preview-http.mjs                    │
│    127.0.0.1:7847 (configurable)         │
│    GET /              SPA files          │
│    GET /events        SSE stream         │
│    GET /api/health    { ok, clients }    │
└─────────┬────────────────────────────────┘
          │                    │
          ▼                    ▼
┌─────────────────┐    Browser tab
│  mcp/host.mjs   │    http://127.0.0.1:7847/?preview=1
│  vm: kernel     │         EventSource('/events')
└────────┬────────┘         applyProjectData → App.render()
         ▼                  highlight last ids
  js/project-api.js
  component-defs, drc, export, dxf, gcode
```

Two channels, one process:

1. **stdio** — MCP tools (agent)
2. **HTTP localhost** — static millPCB files + SSE (human eyes)

**Session model:** one in-memory project per MCP process. Mutating tools update memory, then `broadcast`. `save_project` writes disk. Opening a path replaces the session and broadcasts.

**Coordinate contract:** board millimeters, origin at board center, Y-down (`docs/architecture.md`).

## Live preview protocol

### HTTP (bind `127.0.0.1` only in local mode; Docker overrides via `MILLPCB_BIND`, see Deployment v2)

| Route | Role |
|-------|------|
| `GET /` `GET /index.html` `GET /css/*` `GET /js/*` `GET /libs/*` `GET /img/*` | Serve the existing SPA from `MILLPCB_ROOT` (no copy, no dist) |
| `GET /events` | `Content-Type: text/event-stream`. Hold the response open. |
| `GET /api/health` | `{ ok, previewUrl, clientCount, rev }` |
| `GET /api/project` | Current snapshot (for the first paint before SSE hello, or reconnect) |

Headers on `/events`: `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Heartbeat every 15s as SSE comments (`: ping`) so proxies and EventSource stay alive.

### SSE event types

Named events (`event:` line) so the client can branch:

```
event: hello
data: {"rev":0,"preview":true}

event: project
data: {"rev":12,"tool":"millpcb_add_component","message":"Placed R1","ids":[3],"project":{...}}

event: focus
data: {"rev":12,"ids":[3],"message":"Placed R1"}

event: drc
data: {"rev":13,"ok":false,"violations":[{"type":"clearance","msg":"..."}]}
```

- **`project`**: full `.pcb.json` body (boards are small; skip deltas in v1).
- **`focus`**: same rev, for highlight without waiting to parse a large payload twice (optional; client can also read `ids` from `project`).
- **`drc`**: after `millpcb_drc` so the DRC panel updates without a fake button click.

`rev` is a monotonic integer. Client ignores events with `rev <= lastApplied`.

### Browser (`js/agent-preview.js`)

Load last in `index.html` (after `app.js` logic, or from `app.js` after `App.init()`).

Enable only when:

- `?preview=1` (MCP-served tab), or
- `localStorage millpcb-preview-url` set for debugging

Behavior:

1. `EventSource` to same-origin `/events` (no CORS when MCP serves the SPA).
2. On `project`: `App.applyProjectData(data.project)` then `App.render()`. Skip `fitToView` on every event (jarring); fit on `rev === 0` / board size change only.
3. Highlight `ids` for ~1.5s (reuse selection styling or a `previewFlashIds` array `BoardView` draws).
4. Status banner: **Agent preview · connected** / **reconnecting…** / last `message`.
5. On `drc`: feed the existing DRC panel from violation objects (same as headless return).
6. **Follow mode:** in `?preview=1`, local mutating UI can stay enabled but should be treated as diverging until Phase 4 POST-back. v1: show a note “Following agent — save/load still local unless you POST”. Simplest v1: **leave tools working** but next SSE `project` event **overwrites** local edits (last agent write wins). Document that clearly.

`file://` without MCP: `agent-preview.js` no-ops. No EventSource, no banner.

FTP / millpcb.com: the **editor** deploys as today. Live agent follow is a separate question — see **Hosted millpcb.com vs local agent** below.

### Opening the screen

On MCP start (and via tool `millpcb_preview`):

- Listen on `MILLPCB_PREVIEW_PORT` (default `7847`), host `127.0.0.1`
- Log and return `http://127.0.0.1:7847/?preview=1`
- Optional `MILLPCB_OPEN_BROWSER=1`: `start` / `xdg-open` / `open` that URL once

If the port is in use, try `7848–7857` or fail with the bound port in the error (do not bind `0.0.0.0` **in local mode**; Docker binds `0.0.0.0` inside the container but maps to host loopback — see Deployment v2).

## Kernel: `js/project-api.js`

New file, no `document` / canvas. Browser `App` methods become thin wrappers. MCP never calls `App.init()`.

| Function | Responsibility |
|----------|----------------|
| `createEmptyProject()` | Same defaults as `App` board/params/export/nets |
| `serialize(project)` / `deserialize(json)` | Versioned `.pcb.json`; migrate missing fields |
| `listFootprints()` | Types, prefixes, size names/indexes from `ComponentDefs` |
| `addComponent(project, spec)` | Resolve type+size, copy pins, assign label, `nextId` |
| `pinWorld(project, compId, pinNameOrIndex)` | Rotation-aware transform from data-model.md |
| `addTrace(project, spec)` | Points, layer, net, width, `segmentWidths`/`curved` |
| `connectPins(project, a, b)` | Trace between two pin world positions; net merge rules like schematic-ops |
| `addVia` / `addSilkText` / `setOutline` / `setBoard` / `addNet` |
| `updateObject` / `removeObject` | By id |
| `runDrc(project)` | Same checks as `drc.js`, **return** `{ ok, violations[] }` |
| `exportSvg` / `exportDxf` / `exportGcode` | Call existing `Export` / `Dxf` / `GCode` |

**Browser glue:**

- `drc.js`: compute violations first; only touch `#drc-results` if the element exists
- Placement / schematic connect / save: call `ProjectApi` (Phase 3)
- `BoardView`: draw `App.interaction.previewFlashIds` if set

Do not move canvas, hit-test, or undo into the kernel. Undo stays UI-only.

## MCP package (`mcp/`)

```
mcp/
  package.json          # @modelcontextprotocol/sdk, type: module
  server.mjs            # StdioServerTransport + tool handlers
  host.mjs              # vm: ComponentDefs, ProjectApi, Export, Dxf, GCode
  preview-http.mjs      # localhost static + SSE
  README.md             # Cursor config + preview URL
```

**Path sandbox:** resolve file tools against `MILLPCB_ROOT` or `cwd`. Refuse `..` escapes.

**Tool replies:** compact summaries for the agent. The **screen** gets the full project via SSE, not via the MCP result payload.

## Tool catalog

### Session

| Tool | What the agent does |
|------|---------------------|
| `millpcb_new_project` | Empty board; broadcast SSE |
| `millpcb_open_project` | Load `.pcb.json`; broadcast |
| `millpcb_save_project` | Write session to path |
| `millpcb_get_project` | Summary or full JSON (agent-side; UI already has SSE) |
| `millpcb_set_board` | Size / params; broadcast |
| `millpcb_preview` | Return preview URL, client count, rev; does not require a mutation |

Every mutating tool includes `message` + `ids` in the SSE envelope so the banner and highlight work.

### Library, edit, check, export

Same as before: `list_footprints`, `inspect`, `add_component`, `connect_pins`, `add_trace`, `add_via`, `add_silk_text`, `set_outline`, `add_net`, `update`, `remove`, `drc`, `export`.

`millpcb_drc` broadcasts `drc` (and does not need a full project event unless geometry changed).

**Out of v1:** KiCad zip import, schematic auto-layout, raster screenshots, two-way POST sync.

## Agent workflow (intended)

1. User starts Cursor with millPCB MCP → preview HTTP comes up
2. Agent or user opens `http://127.0.0.1:7847/?preview=1` (or auto-open)
3. Banner shows **connected**
4. `list_footprints` → `new_project` → canvas clears to empty board
5. Each `add_component` / `connect_pins` redraws; new parts flash
6. `drc` fills the DRC panel
7. `save_project` + `export` for files to cut

If nobody has the tab open, tools still succeed; SSE has zero clients. Preview is feedback, not a requirement for correctness.

## Deployment v2: Docker (Portainer) + shared hosting

**Decision:** the MCP backend runs as a **Docker container** managed via Portainer (Docker Desktop on the user's PC). The website stays on **shared hosting** (Hostido NVMe 3, static SPA over FTP). Docker changes nothing about the shared box — it still cannot run Node.

### Topology

```
Cursor / Claude Desktop                    Browser tab
   │ MCP Streamable HTTP                      │ EventSource SSE
   ▼ http://localhost:8090/mcp                ▼ http://localhost:7847/?preview=1
┌─────────────── Portainer-managed container: millpcb-mcp ───────────────┐
│ node mcp/server.mjs  (MILLPCB_TRANSPORT=http)                          │
│   ├─ :8090 /mcp        MCP endpoint (one shared ProjectSession/proc)   │
│   ├─ :7847             SPA static files + /events SSE + /api/*         │
│   └─ kernel: js/project-api.js, component-defs, drc, export, dxf, gcode│
│ volumes (bind mounts):                                                  │
│   ./projects → /data/projects   .pcb.json autosave                     │
│   ./exports  → /data/exports    svg / dxf / g-code                     │
└──────────────────────────────────────────────────────────────────────────┘

millpcb.com (Hostido NVMe 3): static SPA only — share/demo/manual editing.
```

### Why HTTP MCP instead of stdio in Docker

| | stdio (`docker run -i`) | **Streamable HTTP (chosen)** |
|---|---|---|
| Who starts it | Client spawns a container per session | Long-running service; client just opens a URL |
| Port mapping | Each spawn needs fresh `-p 7847` → collisions, orphans | Fixed ports declared once in compose |
| Session lifetime | Dies when the client restarts | Container + `restart: unless-stopped`; autosave to volume survives rebuilds |
| Client config | `command: docker, args: [run -i …]` (fragile on Windows) | `"url": "http://localhost:8090/mcp"` |

SDK 1.30 ships `StreamableHTTPServerTransport`. One shared in-memory `ProjectSession` serves all MCP sessions (same model as today's one-project-per-process). Fallback if a client ever lacks remote-URL support: stdio via `docker run -i --rm -p 127.0.0.1:7847:7847 millpcb-mcp`.

### Container spec (sketch)

**Dockerfile** (context = repo root): `node:24-alpine`; copy `index.html help.html css js libs img mcp`; `npm ci` in `mcp/`; `ENV MILLPCB_TRANSPORT=http MILLPCB_ROOT=/app MILLPCB_BIND=0.0.0.0 MILLPCB_PROJECTS_DIR=/data/projects MILLPCB_EXPORTS_DIR=/data/exports`; `EXPOSE 8090 7847`; `CMD ["node","mcp/server.mjs"]`.

**docker-compose.yml** (import as a Portainer stack):

```yaml
services:
  millpcb-mcp:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8090"   # MCP — host loopback only
      - "127.0.0.1:7847:7847"   # preview — host loopback only
    volumes:
      - ./projects:/data/projects
      - ./exports:/data/exports
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:7847/api/health"]
      interval: 30s
```

**Security model:**

- Mapping to `127.0.0.1` keeps everything private; the existing Host-header guard still sees `Host: localhost`.
- **LAN watch (phone / second PC) is opt-in:** map to `0.0.0.0` *and* set `MILLPCB_TOKEN`; then `/api/*`, `/events`, and MCP requests require `Authorization: Bearer <token>`. Never expose without the token; not for the internet.
- Kernel + SPA are baked into the image (rebuild to pick up repo changes); only user state lives in volumes.

### Code changes this deployment requires

1. `server.mjs`: `MILLPCB_TRANSPORT=http` → serve MCP on `MILLPCB_MCP_PORT` (default `8090`) with `StreamableHTTPServerTransport`; stdio stays the default for local dev.
2. `preview-http.mjs`: `MILLPCB_BIND` env (default `127.0.0.1`); optional `MILLPCB_TOKEN` guard on `/api/*`, `/events`, and the MCP endpoint when set.
3. `host.mjs` / `server.mjs`: `MILLPCB_PROJECTS_DIR` (default `<root>/.mcp/preview`) and `MILLPCB_EXPORTS_DIR` (default `<root>/exports`); optional `MILLPCB_RESTORE=1` loads the last autosave at startup.
4. New files: `Dockerfile`, `docker-compose.yml`, `.dockerignore` (exclude `node_modules`, `.git`, `_zipx/`, `PCBLib/`, `pcbLibrary/`, `exports/`, `projects/`).
5. CI unchanged (syntax + tests). Optional later: build the image in CI, do not push.

### Feasibility verdict

- **Portainer:** ✅ plain compose stack / single container — nothing exotic needed.
- **Windows file access:** ✅ bind mounts put `.pcb.json` and exports in `./projects`, `./exports` on disk.
- **Remote MCP from Cursor/Claude Desktop:** ✅ via URL (streamable HTTP); stdio `docker run -i` remains the fallback.
- **Shared hosting:** unchanged — live view is always the local container port; millpcb.com stays static (PHP push/poll bridge remains the later option for a public watch tab).

## Hosted millpcb.com vs local agent

The deployed site is still a **static SPA** (HTML/CSS/JS on FTP). The MCP server is a **Node process on the machine where the agent runs** (your PC, with Cursor). Those are not the same host.

| What you open | Does the editor work? | Do you see the agent live? |
|---------------|----------------------|----------------------------|
| `http://127.0.0.1:7847/?preview=1` (MCP serves files + SSE) | Yes | **Yes — this is the supported path** |
| `file://…/index.html` | Yes | No (no MCP HTTP) |
| `https://millpcb.com` (FTP deploy, no query) | Yes (today’s app) | No — that page has no agent session |
| `https://millpcb.com/?preview=1` hoping to hit local MCP | Editor yes | **Usually no** — HTTPS page talking to `http://127.0.0.1` is mixed content; browsers block or flake |

So: **hosting the website does not host the agent, and does not give you live SSE by itself.**

**Why not put MCP on the public server?** millpcb.com has no Node backend. A public `/events` stream would need sessions, auth, and a process per user. That is a different product and is out of v1.

**Optional later (local agent + millpcb.com tab):** CORS on localhost SSE + `?mcp=http://127.0.0.1:7847`. Only reliable if the page is **HTTP** or the browser allows HTTPS→localhost. Do not depend on this for v1.

**Practical rule (v1):** agent live view = MCP’s localhost URL. millpcb.com = share/demo/manual editing of saved `.pcb.json`.

### What it would take to follow the agent *on millpcb.com*

Three different products. Cost is mostly **hosting + identity**, not canvas code.

#### A. millpcb.com is only the UI; agent still on your PC (~1–2 days after v1)

Goal: open `https://millpcb.com/?mcp=1` and the tab follows **your** local Cursor MCP.

Need:

1. Local preview HTTP already running (v1).
2. CORS on `/events` and `/api/project`: allow `https://millpcb.com`.
3. SPA: if `?mcp=1` (or a known localhost URL), `EventSource('http://127.0.0.1:7847/events')`.
4. **TLS on localhost** (`https://127.0.0.1:7847`) with a trustable cert (`mkcert`) **or** rely on browser localhost mixed-content exceptions (Chrome is looser than Safari/Firefox). Without this, HTTPS millpcb.com → HTTP localhost is the usual failure.
5. User gesture / Private Network Access: some browsers prompt the first time a public site talks to loopback.

Does **not** need a Node process on the FTP host. Fails if MCP is not running, if the user is on a phone, or if the browser blocks loopback.

#### B. Shared live session on the internet (real hosted preview — ~1–3 weeks + always-on host)

Goal: millpcb.com shows the board **without** a local MCP HTTP port. A phone, a second PC, or a friend can watch.

FTP static hosting cannot do this. You need a small **always-on** process (VPS, Fly, Railway, Cloudflare Worker + Durable Object, etc.) that is not the current lftp mirror.

Need:

| Piece | Why |
|-------|-----|
| Session id + secret (or login) | Otherwise anyone can subscribe to `/events` or inject traces |
| In-memory or Redis project per session | Same kernel as MCP, but keyed by session |
| `GET /events?session=` SSE (or WebSocket) **on HTTPS** | Same origin as millpcb.com, so no mixed content |
| `POST /api/mutate` or MCP **Streamable HTTP** | Agent must reach the **public** host, not stdio on the laptop |
| Cursor MCP config | `url: https://millpcb.com/mcp` (or a subdomain) instead of `node mcp/server.mjs` — Cursor must support remote MCP for that client |
| Export files | Write to object storage or signed download URLs; not `C:\Git\...` |
| Idle timeout / max sessions | Cheap host does not keep boards forever |
| HTTPS + WAF rate limits | Public mutate API is an abuse target |

stdio MCP stays for local v1. Hosted path is **HTTP MCP** (or a thin REST the agent tools wrap). Same `project-api.js` in Node on the server.

Ops change: FTP can still serve `index.html`; SSE/MCP must live on Node (or Worker). Typical pattern: `app.millpcb.com` Node + `millpcb.com` static, or move the whole site off FTP.

#### C. Cloud Cursor agent designing a board you watch in the browser

Same as B, plus the agent runtime is not on your PC. The millPCB API must be on the public internet with a token the cloud agent is allowed to use. Local stdio MCP cannot see that.

### Hostido NVMe 3 (millpcb.com today)

NVMe 3 is **shared hosting** (LiteSpeed + DirectAdmin, SSH, Redis, ~20 GB, 2 vCPU, 4 GB RAM). It is not a VPS: no root, no systemd, no binding extra ports. Hostido’s **Node.js app installer is withdrawn**, so this box cannot run the MCP process or a long-lived Node SSE server.

| Fits on NVMe 3 | Does not fit |
|----------------|--------------|
| Static SPA (current FTP deploy) | `node mcp/server.mjs` as a daemon |
| PHP (or Python) **short** HTTP: POST snapshot, GET snapshot | MCP Streamable HTTP / stdio |
| Redis as last-project cache (NVMe 3 includes Redis) | Many concurrent PHP SSE connections (LiteSpeed timeouts, process limits) |
| HTTPS on millpcb.com (Let’s Encrypt) | Custom listen port 7847 |

**Hostido-shaped “watch on millpcb.com”** (after local MCP v1, ~2–4 days): keep MCP on the PC. After each mutate, POST the project JSON to `https://millpcb.com/agent/push.php` with a secret. The SPA polls `GET /agent/state.php` every ~400 ms (or reads Redis). Visual follow works on the public site **without Node on Hostido**. Tradeoff: polling, not SSE; secret in the URL or a session cookie; not a public unauthenticated live URL.

**If you later want real SSE + remote MCP on the same domain:** you need a VPS (Hostido’s own FAQ still treats VPS as a separate/future product). Put Node on `app.millpcb.com` and keep the SPA on NVMe 3, or move the app off shared hosting.

## Cursor / client wiring

**Docker mode (primary)** — remote MCP over HTTP, container running via Portainer:

```json
{
  "mcpServers": {
    "millpcb": { "url": "http://localhost:8090/mcp" }
  }
}
```

**Local dev mode (stdio)** — no Docker:

```json
{
  "mcpServers": {
    "millpcb": {
      "command": "node",
      "args": ["mcp/server.mjs"],
      "cwd": "C:/Git/millPCB",
      "env": {
        "MILLPCB_ROOT": "C:/Git/millPCB",
        "MILLPCB_PREVIEW_PORT": "7847",
        "MILLPCB_OPEN_BROWSER": "1"
      }
    }
  }
}
```

`npm install` only inside `mcp/`. The Docker image bakes the same deps (`npm ci` in `mcp/`).

## Tests (CI)

- `node --check mcp/*.mjs` and `js/project-api.js` / `js/agent-preview.js`
- `node tests/project-api.test.js` — place, connect, serialize
- `node tests/preview-sse.test.js` — fake HTTP: mutate → SSE `project` event parses, `rev` increases
- Existing gcode/dxf tests unchanged

Do not FTP-deploy `mcp/`. **Do** deploy `js/agent-preview.js` with the SPA (harmless no-op without `?preview=1`).

## Phases

### Phase 0 — Spike

- vm-load defs + export; write a dummy `.nc`
- Tiny `http` server: `/events` sends one hardcoded `project` event; browser `EventSource` logs it

### Phase 1 — Kernel + DRC headless

- `js/project-api.js`; DRC returns data without requiring DOM
- Unit tests for place + serialize

### Phase 2 — MCP tools + SSE preview (v1 ship)

- `server.mjs` + `preview-http.mjs` serving repo static files
- Mutating tools broadcast `project` + `focus`
- `js/agent-preview.js` + banner + flash ids + `?preview=1`
- `millpcb_preview` tool; optional auto-open browser
- README: open the preview URL before asking the agent to design

### Phase 2b — Docker / Portainer deployment (v2 ship)

- `server.mjs` HTTP mode: `MILLPCB_TRANSPORT=http`, `StreamableHTTPServerTransport`, `MILLPCB_MCP_PORT` (default 8090)
- `preview-http.mjs`: `MILLPCB_BIND` env; optional `MILLPCB_TOKEN` guard on `/api/*`, `/events`, MCP endpoint
- `MILLPCB_PROJECTS_DIR` / `MILLPCB_EXPORTS_DIR`; optional `MILLPCB_RESTORE=1` loads last autosave at startup
- `Dockerfile` + `docker-compose.yml` + `.dockerignore`; import as Portainer stack; healthcheck on `/api/health`
- Smoke: container up → client connects via URL → edit tools → watch tab updates live

### Phase 3 — Browser uses the kernel

- Placement, schematic connect, save/load call `ProjectApi`

### Phase 4 — Two-way (optional)

- Preview tab `POST /api/project` after local edits, or WebSocket
- Conflict rule: `rev` compare; agent tools win or merge explicitly

## Invariants (do not break)

- SPA without MCP: `file://` and millpcb.com work as today
- Preview/MCP reachable **only via host loopback** (stdio: bind `127.0.0.1`; Docker: ports mapped to `127.0.0.1:*`); any wider exposure requires `MILLPCB_TOKEN`
- `.pcb.json` backward compatible
- Export geometry stays in `export.js` / `dxf.js` / `gcode.js`
- Script order: `project-api.js` after `component-defs.js`; `agent-preview.js` after `app.js` (or invoked from it)
- No new CDN; MCP deps stay under `mcp/node_modules`

## Success criteria

With MCP running and the preview tab open:

1. Agent creates a 40×30 mm board → canvas updates immediately
2. Agent places 0805 LED, resistor, 1×2 header → parts appear and flash
3. `connect_pins` draws traces on screen
4. DRC results show in the panel
5. Disconnecting SSE shows **reconnecting…**; EventSource resumes without a full page reload
6. `file://` index.html with no query string has no banner and no network calls to localhost
