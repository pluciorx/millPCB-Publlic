# millPCB

Easy browser PCB design for CNC and laser cutting. Hobbyist tool, not professional EDA.

Draw a simple board in the browser and export SVG, DXF, or G-code for a CNC router or laser cutter. No install and no account. The live editor is at [millpcb.com](https://millpcb.com/). You own the designs you make.

millPCB is one HTML page plus vanilla JavaScript. There is no bundler and no backend for the editor itself. An optional MCP server lets an AI agent edit the same project while you watch.

## Try it

Open `index.html` in Chrome, Edge, or Firefox, or go to [millpcb.com](https://millpcb.com/).

Serving the folder over HTTP (`npx http-server`) lets the app scan a local KiCad library. `file://` still runs the editor; directory scanning is what it blocks.

## What you can do

- **Board view** — place parts, draw copper, set the outline, add silk text. Pan, zoom, and rotate. Grid snap.
- **Schematic view** — wire pins with symbols. Layout is independent of the board. Press `B` / `S` to switch views.
- **Parts** — built-in footprints plus KiCad `.kicad_mod`, `.kicad_sym`, and `.zip` import. Prefer through-hole, then 1206, then 0805. This is hand-soldered, milled or laser-cut board, so the large package is the right one.
- **Single copper sheet** — one layer. A crossing is not a via. Move a part, or place a wire jumper (two pads, the wire solders over the other trace).
- **Checks** — design-rule check for clearance, trace width, and drill size.
- **Export** — SVG for a laser, DXF R2000 for CAD/CAM, GRBL-style G-code to isolate, drill, and cut the outline.
- **Save** — named projects in `localStorage`, or a `.pcb.json` file. The last project reloads on startup.

| Key | Action |
|-----|--------|
| `T` | Draw a trace. Double-click or right-click to finish. |
| `O` | Board outline |
| `X` | Silk text |
| `R` | Rotate 90° |
| `Del` | Delete the selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+S` / `Ctrl+O` | Save / open |
| Middle-drag / wheel | Pan / zoom |

More interaction detail is in [docs/features.md](docs/features.md).

## Design with an agent

1. Open [millpcb.com](https://millpcb.com/) and leave the tab open.
2. Click **Agent**. The dialog shows your session id, a prompt, and the Agent MCP URL. Copy the URL into the agent once (Cursor, Claude Desktop, or any Streamable HTTP MCP client).
3. Prompt with the session id, for example: `create a LED circuit using millPCB session id <your id>`. The agent calls `millpcb_use_session`. If the tab is closed, there is no session.
4. The board on that tab updates as the agent works. **Live view** opens the same session.

The session id stays in this browser (`localStorage`). Each visitor has their own id. One MCP URL serves everyone; the agent binds to the id you name. Two or more agents lock the preview until you click **Unlock editing**. If an agent is stuck holding the board, **Release agent lock** frees it.

Public endpoints on the live site (the token, when the server has one, belongs in the agent config, not in the prompt):

- Preview: `https://agent.millpcb.com:2053/index.html?preview=1`
- MCP: `https://agent.millpcb.com:2096/mcp`
- Agent chat events: `https://agent.millpcb.com:2053/api/chat/events?session=<id>`

### Run the agent server yourself

```bash
cd mcp
npm install
node server.mjs
```

That speaks MCP on stdio and serves the preview at `http://localhost:7847/`. Add `?preview=1` for the read-only live view.

HTTP transport, for a client that connects by URL:

```bash
MILLPCB_TRANSPORT=http node mcp/server.mjs
```

MCP is on `http://127.0.0.1:8090/mcp`, preview on port `7847`. Set `MILLPCB_TOKEN` before binding beyond localhost. Tool list, environment variables, and Docker are in [mcp/README.md](mcp/README.md) and [docs/deployment-docker.md](docs/deployment-docker.md).

Claude Desktop, stdio:

```json
{
  "mcpServers": {
    "millpcb": {
      "command": "node",
      "args": ["C:/path/to/millPCB/mcp/server.mjs"]
    }
  }
}
```

## Develop

No build step. Syntax check, which CI also runs:

```powershell
Get-ChildItem js\*.js, mcp\*.mjs | ForEach-Object { node --check $_.FullName }
```

Tests:

```powershell
node tests/gcode.test.js
node tests/dxf.test.js
node tests/project-api.test.js
node tests/mcp-http.test.js
node tests/mcp-agent-wait.test.js
```

MCP tests need `npm ci --prefix mcp` once. Push to `main` runs the same checks in GitHub Actions.

Module order in `index.html` matters. Later files use globals from earlier ones: `component-defs`, `project-api`, `app-core`, then views, export, DRC, KiCad import, and `app.js` last. State lives on one global `App` object. Call `App.render()` after a change. `saveState()` snapshots undo (max 50).

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/features.md](docs/features.md) | Tools, shortcuts, export, save |
| [docs/architecture.md](docs/architecture.md) | Coordinates, rendering, data flow |
| [docs/data-model.md](docs/data-model.md) | `.pcb.json` schema |
| [docs/modules.md](docs/modules.md) | What each JS file does |
| [docs/export-formats.md](docs/export-formats.md) | SVG and DXF |
| [mcp/README.md](mcp/README.md) | MCP tools, sessions, env vars |
| [docs/deployment-docker.md](docs/deployment-docker.md) | Docker / Portainer |
| [hosting/README.md](hosting/README.md) | Operator notes for the live host |
| [help.html](help.html) | In-app help |
| [legal.html](legal.html) | License, privacy, cookies |

## Hosting

The live site deploy is GitHub Actions over SSH. It does not store the host name, user, port, or key in the repo. Actions secrets are `SSH_KEY_MCP`, `SSH_HOST`, `SSH_PORT`, and `SSH_USER`. If any are missing, the deploy step skips and the tests still run.

On a machine that deploys by hand, copy `hosting/hosting.example.ps1` to `hosting/hosting.local.ps1` (gitignored) and fill in the SSH user, host, and port. The private key stays in your own `.ssh` folder. `mcp/server.env` (token, TLS, ports) lives only on the host.

Details: [hosting/README.md](hosting/README.md).

## License

millPCB’s own code is source-available and all rights reserved. Looking at this repository does not grant a license to copy or reuse it. You own the designs you create.

Third-party pieces are credited in [legal.html](legal.html): JSZip and Three.js (MIT), most bundled footprints (KiCad, CC-BY-SA 4.0), Espressif modules (Apache 2.0).
