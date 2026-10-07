# PCB Editor — Laser Cutter Export

A browser-based PCB (Printed Circuit Board) editor designed for generating laser-cutter and CNC-compatible output files. Supports interactive board design, schematic wiring, component placement with KiCad import, Design Rule Checking, and export to SVG/DXF.

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System architecture, file structure, data flow, rendering pipeline |
| [Data Model](./data-model.md) | Project JSON schema, all object types, field definitions |
| [Modules](./modules.md) | Per-file breakdown of every JavaScript module and its responsibilities |
| [Features](./features.md) | User-facing features, tools, keyboard shortcuts, interactions |
| [Export Formats](./export-formats.md) | SVG and DXF output format specifications, layer mapping |
| [MCP server plan](../PLAN-mcp.md) | Headless MCP tools so agents can edit/export millPCB projects |
| [Docker / Portainer deployment](./deployment-docker.md) | LAN MCP server in Docker: Streamable HTTP endpoint, preview, volumes, tokens |

---

## Quick Overview

- **No build system** — open `index.html` in any modern browser
- **No backend server** — all logic runs client-side
- **Persistence** — localStorage (auto-save) + JSON file download/upload
- **Rendering** — HTML5 Canvas 2D (board view + schematic view)
- **Dependencies** — only [JSZip](https://stuk.github.io/jszip/) for KiCad `.zip` import

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Markup | HTML5 |
| Styling | CSS3 (single `css/style.css`) |
| Logic | Vanilla JavaScript (ES2020) |
| Rendering | Canvas 2D API |
| File handling | File API, Blob, URL.createObjectURL |
| Persistence | localStorage + JSON download |
| External lib | JSZip (KiCad archive import only) |

## Getting Started

```
1. Open index.html in a browser (Chrome/Edge/Firefox)
2. Use the toolbar to select tools
3. Click palette items to place components
4. Draw traces, run DRC, export when done
```

No installation, no server, no build step required.

## File Structure

```
qwenTest/
├── index.html              # Single-page application entry point
├── css/
│   └── style.css           # All styles (dark theme, panels, canvas)
├── js/
│   ├── component-defs.js   # Component library (footprints + symbols)
│   ├── app-core.js         # Global App state object & core methods
│   ├── hit-test.js         # Hit-testing & geometry helpers
│   ├── trace-ops.js        # Trace operations (finish, width, pad constraints)
│   ├── app-props.js        # Properties panel rendering
│   ├── app-save.js         # Save/Load/AutoLoad project logic
│   ├── app-ui.js           # UI bindings, keyboard shortcuts, tool switching
│   ├── app-canvas-board.js # Board canvas mouse/wheel/context events
│   ├── board-view.js       # Board view Canvas 2D renderer
│   ├── schematic-view.js   # Schematic view Canvas 2D renderer
│   ├── schematic-ops.js    # Schematic interaction (pan/zoom/drag/wire)
│   ├── gcode.js            # GRBL G-code generator
│   ├── dxf.js              # DXF R2000 generator
│   ├── export.js           # SVG / DXF / G-code export entry points
│   ├── drc.js              # Design Rule Check engine
│   ├── vendor/jszip.min.js # JSZip library (bundled, no CDN dependency)
│   ├── kicad-import.js     # KiCad S-expression parser & footprint importer
│   └── app.js              # Bootstrap (DOMContentLoaded → App.init())
├── PCBLib/                 # User's KiCad component library (.zip packages)
├── pcbLibrary/             # Additional library files
├── _zipx/                  # Sample extracted KiCad package
├── docs/                   # This documentation
└── PLAN-schematic-board.md # Feature planning document
```
