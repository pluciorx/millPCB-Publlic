# Docker / Portainer Deployment — LAN MCP Server

Runs the millPCB MCP server as a Docker container on the LAN host (`192.168.0.123`), exposing:

| Service | URL | Purpose |
|---|---|---|
| **MCP (Streamable HTTP)** | `http://192.168.0.123:8090/mcp` | AI agents connect by URL — no per-session process spawning |
| **Live preview + SSE** | `http://192.168.0.123:7847/?preview=1` | Read-only canvas view of the agent's board, updates live |

Everything else (project files, exports) persists in host directories under `./data/`, so container
recreation/redeploy never loses work. On restart, `MILLPCB_RESTORE=1` reloads the autosaved project.

## Requirements

- Docker Engine (with BuildKit) and Portainer CE already running on `192.168.0.123`.
- The millPCB repository cloned on the host, e.g. `/opt/millPCB` (contains `Dockerfile`, `docker-compose.yml`).

## Option A — Portainer stack (recommended)

1. Open Portainer → **Stacks** → **Add stack**.
2. Give it a name, e.g. `millpcb-mcp`.
3. In **Web editor**, paste the full contents of `docker-compose.yml` from the repo root:

   ```yaml
   services:
     millpcb-mcp:
       build: .
       image: millpcb-mcp:latest
       container_name: millpcb-mcp
       restart: unless-stopped
       ports:
         - "8090:8090"   # MCP Streamable HTTP endpoint -> http://<host>:8090/mcp
         - "7847:7847"   # live preview + SSE           -> http://<host>:7847/?preview=1
       environment:
         MILLPCB_TRANSPORT: "http"
         MILLPCB_BIND: "0.0.0.0"
         MILLPCB_MCP_PORT: "8090"
         MILLPCB_PREVIEW_PORT: "7847"
         MILLPCB_PROJECTS_DIR: "/data/projects"
         MILLPCB_EXPORTS_DIR: "/data/exports"
         MILLPCB_RESTORE: "1"
         # Recommended once exposed on the LAN — enables token auth on /mcp,
         # /events and /api/project (preview page picks it up via ?token=***
         # MILLPCB_TOKEN: "change-me"
       volumes:
         - ./data/projects:/data/projects   # user .pcb.json projects (persisted)
         - ./data/exports:/data/exports     # SVG/DXF/G-code exports (persisted)
   ```

4. **Deploy the stack** — Portainer builds the image (`Dockerfile` next to the compose file) and starts the container.
5. Watch it come up: **Containers → millpcb-mcp** should show *Healthy* within ~30 s (healthcheck polls `/api/health`).

> Note: a Portainer stack built from the Web editor uses the Portainer server's filesystem for `build: .` and
> the relative volumes. If your Portainer runs in a container with its own rootfs, use **Option B** on the host
> instead (same compose file, `docker compose up -d --build`) so `./data/...` lands where you expect.

## Option B — docker compose CLI on the host

```bash
cd /opt/millPCB
docker compose up -d --build
docker compose logs -f millpcb-mcp     # until: "ready — ... MCP port 8090 (/mcp), preview http://..."
```

## Environment variables

| Variable | Compose value | Meaning |
|---|---|---|
| `MILLPCB_TRANSPORT` | `http` | Streamable HTTP MCP on `/mcp` (vs `stdio` for client-spawned use) |
| `MILLPCB_BIND` | `0.0.0.0` | Bind both servers to all interfaces (Docker/LAN). Loopback default otherwise. |
| `MILLPCB_MCP_PORT` | `8090` | MCP endpoint port |
| `MILLPCB_PREVIEW_PORT` | `7847` | Preview/SSE port |
| `MILLPCB_PROJECTS_DIR` | `/data/projects` | Where user `.pcb.json` files + autosave live (volume) |
| `MILLPCB_EXPORTS_DIR` | `/data/exports` | Where SVG/DXF/G-code exports are written (volume) |
| `MILLPCB_RESTORE` | `1` | Reload the autosaved project at startup (edits survive restarts) |
| `MILLPCB_TOKEN` | *(unset)* | Shared token for `/mcp`, `/events`, `/api/project` — see Security below |

## Verifying the deployment

```bash
# 1. Healthcheck (open, no token — used by Docker)
curl http://192.168.0.123:7847/api/health        # -> {"ok":true,"revision":...,"clients":N}

# 2. Preview page (browser on any LAN machine)
#    http://192.168.0.123:7847/?preview=1  — shows the live canvas with a "LIVE" badge

# 3. MCP endpoint responds (unauthenticated ping; expect an MCP/JSON-RPC answer, not a web page)
curl -s -X POST http://192.168.0.123:8090/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ping","version":"0"}}}'
```

In Portainer: the container status should be **Healthy**, and logs end with
`[millpcb-mcp] ready — root /app, MCP port 8090 (/mcp), preview http://...`.

## Connecting an MCP client

Any client with Streamable HTTP support (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "millpcb": { "url": "http://192.168.0.123:8090/mcp" }
  }
}
```

With a token set, either add the header or append it to the URL:

```json
{
  "mcpServers": {
    "millpcb": {
      "url": "http://192.168.0.123:8090/mcp",
      "headers": { "Authorization": "***" }
    }
  }
}
```

or `http://192.168.0.123:8090/mcp?token=*** The preview page accepts the same token via
`http://192.168.0.123:7847/?preview=1&token=***

Tools available over MCP: `millpcb_new_project`, `millpcb_open_project`, `millpcb_save_project`,
`millpcb_get_project`, `millpcb_set_board`, `millpcb_preview`, `millpcb_list_footprints`,
`millpcb_inspect`, the edit tools (`millpcb_add_component`, `millpcb_connect_pins`,
`millpcb_add_trace`, `millpcb_add_via`, `millpcb_add_silk_text`, `millpcb_set_outline`,
`millpcb_add_net`, `millpcb_update_object`, `millpcb_remove_object`) and check/export
(`millpcb_drc`, `millpcb_export_svg`, `millpcb_export_dxf`, `millpcb_export_gcode`).
Exports land in `./data/exports/` on the host.

## Security

- **LAN use:** set `MILLPCB_TOKEN` to a long random string (`openssl rand -hex 16`) and share it only with
  your MCP clients. Without a token, anyone on the LAN can drive the editor and read project files.
- Keep ports `8090`/`7847` **private (LAN-only)** in the host firewall; do not port-forward them.
- **Public exposure is separate work:** put an HTTPS reverse proxy (Caddy/Traefik/nginx) in front, terminate
  TLS there, and keep the token — the container itself speaks plain HTTP by design.

## Updating the app

```bash
cd /opt/millPCB && git pull
docker compose up -d --build      # rebuilds the image; data/ volumes are untouched
```

The new container restores the last autosaved project on start (`MILLPCB_RESTORE=1`).

