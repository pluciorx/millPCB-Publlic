# AGENTS.md

<!-- bmad:context -->
<!-- Verified 2026-09-06 against 7076b04. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## millPCB

Browser-based, single-page PCB editor for laser cutting / CNC milling. Vanilla JS (ES2020), no build step, no root package manager — open `index.html` and it runs. A separate `mcp/` sub-project (Node 24, npm, ESM) exposes the same kernel over MCP with a live preview. Deep design docs in `docs/`; feature planning in `PLAN-schematic-board.md`.

## Policy

- Do not add a bundler, root package manager, module system, or TypeScript build. The no-build constraint is fundamental.
- Do not introduce CDN/external script tags in the browser app. Vendor under `js/vendor/` and reference locally. *Exception:* the Google Analytics gtag snippet (`googletagmanager.com/gtag/js?id=G-LBBZFT66R7`) in `index.html` is intentional — do not remove or vendor it.
- Product scope: hobbyist/maker tool, NOT professional EDA. Keep features simple and opinionated; favor "good enough for makers" over exhaustive correctness. User-facing copy should say "easy PCB design for CNC/laser", never "professional PCB software" or "manufacturing-ready".

## Where things are

- SPA entry: `index.html` (defines UI + `<script>` load order — authoritative).
- All styles: `css/style.css` (single file, dark theme).
- App logic: `js/` (vanilla ES2020; module loading order below is critical).
- MCP server: `mcp/` (Node 24, ESM, own `package.json`; validated in CI but NOT deployed to FTP).
- Built-in footprints: `libs/` (.kicad_mod files by category).
- Gitignored scratch: `_*.js`, `_*.ps1`, `_zipx/`, `pcbLibrary/`, `PCBLib/`, plus local agent tooling (`.cursor/`, `.grok/`, `.agents/`, `_bmad/`, `_bmad-output/`). Not part of the public repo. The deploy workflow also keeps them out of the site publish.
- Design docs (read before non-trivial changes): `docs/architecture.md` (coordinate systems, rendering), `docs/data-model.md` (project JSON schema), `docs/export-formats.md` (SVG/DXF specs), `docs/modules.md` (per-file breakdown).

## Running and verifying

- Open `index.html` in a browser. For KiCad library auto-scan, serve over HTTP (`npx http-server`) since `file://` blocks directory scanning.
- Syntax check (what CI enforces — run before finishing any change):
  ```powershell
  Get-ChildItem js\*.js, mcp\*.mjs | ForEach-Object { node --check $_.FullName }
  ```
- Tests (all run in CI): `node tests/gcode.test.js`, `node tests/dxf.test.js`, `node tests/project-api.test.js`.
- MCP tests spawn their own server (needs `npm ci --prefix mcp`): `node tests/mcp-http.test.js`, `node tests/mcp-agent-wait.test.js` (agent chat wake). To drive a live server by hand: `cd mcp && npm install && node server.mjs` (stdio; preview on http://localhost:7847/).

## Conventions that differ from defaults

- Global singleton state: all app state lives in one global `App` object (`js/app-core.js`). Modules extend via `Object.assign(App, {…})`. No imports/exports — communicate through shared globals (`App`, `BoardView`, `SchematicView`, `Export`, `ComponentDefs`, `KicadImport`).
- Pull-based rendering: no animation loop. Call `App.render()` after every state mutation; renderers are immediate-mode (clear + full redraw).
- Undo/redo is full JSON snapshots (max 50). Call `saveState()` after every mutating operation.
- Module loading order in `index.html` is critical — later files depend on earlier globals. Insert new JS files at the correct position:
  `component-defs → project-api → app-core → hit-test → trace-ops → app-props → app-save → examples → app-ui → app-canvas-board → board-view → schematic-view → schematic-ops → gcode → dxf → export → drc → vendor/jszip.min → kicad-import → kicad-lib-embed → libs-loader → agent-preview → app`
- One responsibility per file. Extend the right module rather than adding cross-cutting logic.
- No network calls in the browser app except optional `fetch` of local library files when served over HTTP. Must keep working from `file://`.

## Known pitfalls

- SVG uses mm units; DXF is Y-up Cartesian with origin at board south-west corner (`flipY()` then shift). Do not bake tool compensation into DXF.
- Backward-compatible saves: old project files may lack newer fields (e.g. `schemX`/`schemY`). Load path must migrate missing values, never fail.
- Keyboard shortcuts must be ignored while focus is in an `<input>` (`e.target.tagName === 'INPUT'`).
- Deployment: push to `main` triggers CI → SSH deploy (no FTP). The workflow tars `dist/` (index.html, help.html, legal.html, css/, js/ incl. vendor/, libs/, img/) straight into `~/domains/millpcb.com/public_html` on the hosting box, then deploys + restarts the MCP server. Needs repo secrets `SSH_KEY_MCP`, `SSH_HOST`, `SSH_PORT`, and `SSH_USER`; skipped when any are absent. Do not commit the host, user, port, or origin IP. If you add new top-level asset types, update the "Prepare publish directory" step in `.github/workflows/deploy.yml` or they won't be deployed.
- The MCP server loads browser kernel files (`js/*.js`) in a DOM-free scope via `mcp/host.mjs` — do not add unguarded DOM-only code to shared kernel files (`project-api.js`, `drc.js`, `gcode.js`, `dxf.js`).
- Never read `js/kicad-lib-embed.js` in an agent/model context — it is ~310 KB (~80k tokens) and will stall a model. Use the MCP tools `millpcb_list_footprints` (compact) and `millpcb_import_kicad` (parses + registers .kicad_mod files headlessly) instead. The MCP kernel loads the full KiCad chain (kicad-import → kicad-lib-embed → libs-loader + `applyEmbed()`), so MCP sessions see the same 144 footprints as the browser. Regenerate the embed with `node tools/embed-kicad-libs.js`, verify with `node tools/verify-embed.js`. Note: importing a footprint whose label matches a built-in library size (e.g. `TH 5x20`) overwrites that built-in entry.


## Agents limitations
- we are tight on context size so summarize the work in shortest but still valuable way, only facts. 
- Do not overthing  and sped to much time on one feature, we will iterate. 
- Use short and simple wording when possible during thinking and development.

<!-- /bmad:context -->

## Cache busting

- `index.html` tags every `js/` and `css/` asset with `?v=YYYYMMDD-N`. Before publishing a release run `node tools/bump-cache-version.js` (or pass an explicit token). millpcb.com's page cache keys on the URL, so the new token is what makes a fix visible immediately — `.htaccess` keeps HTML at `no-cache`, but cached js/css entries can live for a week.


