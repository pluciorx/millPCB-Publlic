# millPCB MCP Server

Exposes the DOM-free `ProjectApi` kernel as [MCP](https://modelcontextprotocol.io) tools — over **stdio** (client-spawned, default) or **Streamable HTTP** (`/mcp`, for Docker/LAN deployments) — plus a live preview of the real SPA canvas. An AI agent can design a PCB (components, traces, vias, nets, silk), run DRC, export SVG/DXF/G-code — and you watch every change appear in `index.html` as it happens.

## Quick start (stdio)

```bash
cd mcp
npm install
node server.mjs            # speaks MCP over stdio; preview on http://localhost:7847/
```

Open **http://localhost:7847/** — that's the normal SPA in *agent mode* (`?preview=1`): read-only, auto-updating from the agent via SSE. (Without the flag the page is your usual editable app.)

### Claude Desktop config (`.claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "millpcb": {
      "command": "node",
      "args": ["C:/Git/millPCB/mcp/server.mjs"]
    }
  }
}
```

## HTTP transport (Streamable HTTP) + Docker

The same server can expose MCP over Streamable HTTP instead of stdio — clients connect by URL, no per-session process spawning:

```bash
MILLPCB_TRANSPORT=http node mcp/server.mjs   # MCP on http://<host>:8090/mcp, preview on :7847
```

Client config (any MCP client with Streamable HTTP support):

```json
{
  "mcpServers": {
    "millpcb": { "url": "http://192.168.0.123:8090/mcp" }
  }
}
```

With `MILLPCB_TOKEN` set, add `"headers": { "Authorization": "***" }` (or append `?token=*** to the URL).

## Sessions (multi-user over one server)

In HTTP transport the server keeps a **registry of sessions** keyed by a short id:

- Open millpcb.com and click **Agent**. The dialog shows a session id (kept in `localStorage['millpcb-session-id']`). Leave that tab open — it holds the session live.
- The agent is configured once with the shared MCP URL. The user prompt only names the session id (`using millPCB session id <id>`). The agent calls `millpcb_use_session`. If that tab is closed, the tool fails and the agent says there is no active session. It does not create a session.
- `?session=<id>` on the MCP URL also binds, but only when that same session is already live. Omit `?session=` for the `default` session (stdio behaves like a single default session too).
- Each session autosaves to `.mcp/preview/project-<id>.pcb.json` (default → `project.pcb.json`) and is restored when the server restarts. Sessions idle >12 h (no preview client, no MCP transport) are swept from memory (`MILLPCB_SESSION_TTL_MS` to change).

### Shared hosting via SSH (Hostido-style)

`mcp/server.sh` starts/stops the server on the host (nohup, loopback bind); `hosting/hosting.ps1` deploys, controls it, and opens the SSH tunnel so `localhost:7847`/`localhost:8090` on your PC reach it. See [hosting/README.md](../hosting/README.md).

### Docker / Portainer

```bash
docker compose up -d --build      # or deploy docker-compose.yml as a Portainer stack
```

Full instructions (Portainer steps, env vars, verification, client config, security): [docs/deployment-docker.md](../docs/deployment-docker.md).

- **MCP endpoint:** `http://<host>:8090/mcp` — also served on the preview port
  (`http://<host>:7847/mcp`), so deployments behind port-restricting CDNs
  (Cloudflare forwards only 443/2053/2083/2087/2096/8443) need just one public port.
- **Live preview:** `http://<host>:7847/?preview=1` (append `&token=*** when auth is enabled)
- **Volumes:** `./data/projects` (user `.pcb.json` files + autosave) and `./data/exports` (SVG/DXF/G-code).
- `MILLPCB_RESTORE=1` reloads the autosaved project on container restart, so edits survive redeploys.
- Set `MILLPCB_TOKEN` in the compose file to require a shared token on `/mcp` and `/api/project` — recommended once the ports are reachable beyond localhost. Named `/events?session=<id>` stays open so the millpcb.com tab can hold the session. For public exposure put an HTTPS reverse proxy in front (separate work).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MILLPCB_TRANSPORT` | `stdio` | `stdio` (client-spawned) or `http` (Streamable HTTP on `/mcp`) |
| `MILLPCB_ROOT` | repo root (2 levels up from `mcp/`) | Base directory for app files; fallback autosave location |
| `MILLPCB_MCP_PORT` | `8090` | Streamable HTTP MCP port (`http` transport) |
| `MILLPCB_PREVIEW_PORT` | `7847` | Preview/SSE HTTP port |
| `MILLPCB_BIND` | `127.0.0.1` | Bind address for both servers; `0.0.0.0` to expose on the LAN/Docker |
| `MILLPCB_TOKEN` | off | Shared token for `/mcp`, `/api/project`, and default `/events` (Bearer header or `?token=`). Named `/events?session=<id>` does not need it |
| `MILLPCB_PROJECTS_DIR` | off | Trusted dir for user `.pcb.json` files; autosave goes to `<dir>/project.pcb.json` (Docker: `/data/projects`) |
| `MILLPCB_EXPORTS_DIR` | `<root>/exports` | Where SVG/DXF/G-code exports are written (Docker: `/data/exports`) |
| `MILLPCB_RESTORE` | off | Set to `1` to reload the autosaved project at startup (Docker restarts) |
| `MILLPCB_TLS_CERT` / `MILLPCB_TLS_KEY` | off | PEM paths -> both servers serve HTTPS (self-signed is fine behind Cloudflare "Full") |
| `MILLPCB_SESSION_TTL_MS` | 12 h | Idle named sessions (no preview client, no MCP transport) are swept after this |
| `MILLPCB_OPEN_BROWSER` | off | Set to `1` to open the preview in a browser on start (stdio only) |

## Tools

**Session:** `millpcb_new_project`, `millpcb_open_project`, `millpcb_save_project`, `millpcb_get_project`, `millpcb_set_board`, `millpcb_preview` (returns the preview URL with `?session=`/`?token=` baked in — hand it to the user), `millpcb_set_view` (switches the live preview page between Board and Schematic — call at design start and when moving between views), `millpcb_use_session` (shared MCP URL, multi-user: re-binds this connection to any session id)

**Inspect / library:** `millpcb_list_footprints`, `millpcb_inspect` (one object by id, or summary of all), `millpcb_import_kicad` (import .kicad_mod files from the repo headlessly via `path`, **or** paste a **genuine** .kicad_mod + optional .kicad_sym symbol text via `content` — security-checked, real pin names AND real symbol graphics drawn in the schematic view, saved to the persistent library `.mcp/library/` so imported parts survive restarts and are reusable in every session; invented geometry is rejected: a real footprint must carry `(version`/`(generator` headers and fab/courtyard graphics). 3D model references: `(model ...)` statements embedded in the footprint and the optional `model3d` parameter are stored with the part, listed by list/inspect, and shown as links in the app's 3D preview modal.)

**Eyes + flow** (the agent's feedback loop): `millpcb_screenshot` (PNG of the board or schematic — the agent literally sees what it built), `millpcb_render_map` (labeled ASCII map of the board), `millpcb_workflow` (status of plan → place → planCheck → route → quality → DRC → export with the single next action)

**Plan / workflow:** `millpcb_set_plan`, `millpcb_place_by_plan`, `millpcb_check` (type="plan"/"quality"/"drc"/"circuit")

**Edit** (each mutation bumps the revision, broadcasts to the preview, and autosaves):
`millpcb_add_component` (one component, or many in one call via `parts[]`), `millpcb_connect_pins` (auto L-route when pins aren't aligned), `millpcb_autoroute` (route every unwired net with the A* router; per-net results, failures are structured), `millpcb_add_schem_wire` (logical schematic wire — records net connectivity, no copper; the drawing leg is auto-routed around parts), `millpcb_set_schematic` (move components in schematic space only), `millpcb_layout_schematic` (auto-arrange the schematic view: topology placement + orthogonal wire re-route), `millpcb_add_trace`, `millpcb_add_via`, `millpcb_add_silk_text`, `millpcb_set_outline`, `millpcb_add_net`, `millpcb_update_object`, `millpcb_remove_object`

**Check / export:** `millpcb_check` (type="drc"/"plan"/"quality"/"circuit" — drc refreshes the preview panel; circuit checks the declared contract), `millpcb_export` (format="svg"/"dxf"/"gcode", written to `exports/`; route/export are gated on planCheck + DRC)

Coordinates are board mm, origin at board center, Y-down — the same system the SPA uses.

## Architecture

```
mcp/server.mjs        MCP front end — stdio or Streamable HTTP (/mcp); one
                      McpServer per session; registers all tools
mcp/host.mjs          Loads js/*.js kernel files (component-defs → app-core →
                      trace-ops → drc.js) in a browser-like global scope, no DOM.
                      ProjectSession = single project + revision counter + undo/redo
                      snapshots + autosave to .mcp/preview/project.pcb.json
mcp/preview-http.mjs  HTTP server: serves the SPA, /api/health, /api/project
                      (GET full JSON / POST load), /events (SSE). Loopback by
                      default; MILLPCB_BIND + MILLPCB_TOKEN for LAN/Docker.
js/project-api.js     Shared kernel (pure functions over the project object);
                      also loaded by the browser app. Single source of truth for
                      geometry, nets, DRC and export.
js/agent-preview.js   Browser side: only active with ?preview=1 — subscribes to
                      SSE, applies projects, renders BoardView read-only, shows a
                      "LIVE" badge, and never overwrites localStorage autosave.
```

Data flow for one edit: `tools/call` → `session.mutate()` (ProjectApi fn) → revision++ + undo snapshot → SSE broadcast (`project` event with full JSON + focused object ids) → SPA applies it and redraws → best-effort autosave to `.mcp/preview/project.pcb.json`.

## Files created by the server (all gitignored)

- `.mcp/preview/project.pcb.json` — preview autosave (or `<MILLPCB_PROJECTS_DIR>/project.pcb.json` when set, e.g. `/data/projects` in Docker)
- `exports/*.svg|dxf|gcode` — generated exports (`<MILLPCB_EXPORTS_DIR>`, e.g. `/data/exports` in Docker)

## Notes & limits

- Preview binds **loopback by default** with a Host-header guard. Bind elsewhere (`MILLPCB_BIND=0.0.0.0`) and set `MILLPCB_TOKEN` before exposing it on the LAN/Docker.
- The MCP server and the browser preview share one session in the server process; a human editing in the *editable* SPA (no `?preview=1`) does not sync back to the agent — use `millpcb_open_project` on a saved file instead.
- Undo/redo lives in the MCP session only (`max 50` snapshots), separate from browser localStorage history.
