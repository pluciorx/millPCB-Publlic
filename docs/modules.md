# Modules — File-by-File Breakdown

Each JavaScript file in `js/` has a single responsibility. They are loaded sequentially via `<script>` tags and communicate through shared globals (`App`, `BoardView`, `SchematicView`, `Export`, `ComponentDefs`, `KicadImport`).

---

## `component-defs.js`

**Global**: `ComponentDefs`

Static data file defining all built-in component types. No logic beyond a lookup helper.

| Export | Description |
|--------|-------------|
| `ComponentDefs.defs` | Object mapping type keys → ComponentDef structures |
| `ComponentDefs.get(type)` | Returns the def for a type key, or null |
| `ComponentDefs.getSize(def, sizeIdx)` | Returns the size entry at index (with fallback to defaultSize) |

**Dependencies**: None (pure data).

---

## `app-core.js`

**Global**: `App` (base definition)

The heart of the application. Defines the initial state object and core methods that all other modules extend.

### State Properties

| Property | Type | Description |
|----------|------|-------------|
| `board` | object | Board dimensions & material |
| `params` | object | Design parameters (trace width, grid, DRC limits) |
| `export` | object | Export settings (kerf, units, toggles) |
| `traces` | array | All placed traces |
| `components` | array | All placed components |
| `vias` | array | All placed vias |
| `boardOutline` | array | User-drawn outline polygon points |
| `silkTexts` | array | Silk screen text objects |
| `nets` | array | Named nets with colors |
| `view` | object | mode, tool, zoom, panX/Y, activeLayer, visibleLayers, schemZoom/Pan |
| `interaction` | object | All transient interaction state (see below) |
| `undoStack` | array | JSON snapshots for undo |
| `redoStack` | array | JSON snapshots for redo |
| `idCounter` | number | Next ID to assign |
| `boardCanvas`, `schematicCanvas` | HTMLCanvasElement | Canvas DOM elements |
| `boardCtx`, `schemCtx` | CanvasRenderingContext2D | 2D contexts |

### Interaction State Fields

| Field | Description |
|-------|-------------|
| `isPanning`, `panStartX/Y` | Middle-mouse pan state |
| `tracePoints[]` | Points being collected for a new trace |
| `outlinePoints[]` | Points being collected for board outline |
| `selectedObject` | Currently selected {type, obj} |
| `placingComponent`, `placingSize` | Component type being placed from palette |
| `draggingComp`, `dragOffsetX/Y` | Component drag state |
| `contextTarget` | Right-click context menu target |
| `hoveredComp` | Component under cursor (for hover effects) |
| `lastMouseX/Y` | Last mouse position in world coords |
| `draggingTraceVertex`, `hoveredTraceVertex` | Trace vertex manipulation |
| `hoveredSegment`, `selectedSegment` | Segment highlight state |
| `schemWireStart` | First pin of wire being drawn in schematic |
| `schemDraggingComp` | Component being dragged in schematic |
| `schemHoveredPin` | Pin under cursor in schematic |
| `schemPinPositions[]` | Screen positions of all pins from last render |
| `placingRotation` | Rotation for component being placed |
| `_placePreview`, `_dragAlign` | Placement ghost position / drag alignment guide lines |
| `clipboard` | Copied component (for Ctrl+C/V) |

### Core Methods

| Method | Description |
|--------|-------------|
| `init()` | Get canvas refs, resize, autoLoad, bind events, saveState, fitToView |
| `resizeCanvases()` | Match canvas dimensions to container |
| `screenToWorld(sx, sy)` | Board view: screen → world (mm) |
| `worldToScreen(wx, wy)` | Board view: world → screen (px) |
| `setBoardZoom(zoom, sx?, sy?)` | Set zoom keeping a screen point (default centre) fixed; drives ➕/➖ and the preset dropdown |
| `schemScreenToWorld(sx, sy)` | Schematic view: screen → world |
| `schemWorldToScreen(wx, wy)` | Schematic view: world → screen |
| `pinBoardPos(comp, pinIndex)` | Get world position of a component's pin |
| `ensureSchemPositions()` | Auto-assign schemX/schemY to components missing them |
| `ensureLabels()` | Auto-assign designator labels (R1, C2, ...) |
| `snapToGrid(val)` | Round value to nearest grid step |
| `getCompSize(comp)` | Get size def for a placed component |
| `snapToPin(wx, wy)` | Find nearest pin within threshold |
| `placePreviewAt(wx, wy)` | Placement ghost position: grid snap + magnetic alignment to other components |
| `saveState()` | Push undo snapshot |
| `undo()` / `redo()` | Pop/restore state snapshots |
| `nextId()` | Increment and return new unique ID |
| `render()` | Dispatch to BoardView or SchematicView render |
| `setStatus(msg)` | Flash message in status bar (auto-clears after 3s) |

**Dependencies**: `ComponentDefs`, DOM elements.

---

## `hit-test.js`

**Extends**: `App`

Geometry helpers for object selection and deletion at a world coordinate point.

| Method | Description |
|--------|-------------|
| `selectAt(wx, wy)` | Find component/via/trace/silkText under point → set selectedObject |
| `deleteAt(wx, wy)` | Delete the object found at point |
| `hitComponent(wx, wy)` | Check if point is within any component bounding box |
| `hitTraceVertex(wx, wy)` | Check if point is near a trace vertex (for dragging) |
| `pointNearPolyline(wx, wy, points, tol)` | Distance check against polyline segments |
| `alignPosToComps(x, y, movingComp, exceptId)` | Magnetic alignment: nearest position where the mover's edges/centre line up with another component's edges/centre; returns snapped centre + guide-line coords (threshold ~4 px on screen, capped at 2 mm; 0/90/180/270° movers only) |

**Dependencies**: `App` state (components, vias, traces), `ComponentDefs`.

---

## `trace-ops.js`

**Extends**: `App`

Operations related to trace creation, width adjustment, and pad constraints.

| Method | Description |
|--------|-------------|
| `finishTrace()` | Finalize the active trace from interaction.tracePoints into traces[] |
| `getSegmentWidth(trace, segIndex)` | Get effective width for a segment (segmentWidths or fallback to trace.width) |
| `getPadConstraint(trace, pointIndex)` | Find if a trace endpoint is on a pad/via → return {minW, maxW, label} |
| `getPinPadLimits(comp, size, pinIndex)` | Compute min/max trace width for a given pin's pad |
| `setSegmentWidth(traceId, segIndex, newWidth)` | Set segment width with clamping to pad constraints |

**Dependencies**: `App` state (traces, components, vias), `BoardView.isTH()`.

---

## `app-props.js`

**Extends**: `App`

Renders the right-hand properties panel based on the currently selected object.

| Method | Description |
|--------|-------------|
| `showProperties(obj, segIndex?)` | Build and inject HTML into #properties-content for the given object type |
| `updateNetList()` | Render the net list panel with colors |
| `addNet()` | Add a new named net to the nets array |

**Supported property types**: component (position, rotation, layer, value, label), trace (width per segment, net assignment), via (diameter, drill), silkText (text, size, layer).

**Dependencies**: `App` state, DOM elements.

---

## `app-save.js`

**Extends**: `App`

Project persistence: multi-project localStorage store, two project modals — **Save Project** (title/description form + download) and **Open Project** (saved list + import/delete) — plus file download/upload.

| Method | Description |
|--------|-------------|
| `saveProject()` / `loadProject()` | Entry points (Save/Load buttons, Ctrl+S/O) → open the Save or Open modal |
| `openSaveProjectModal()` / `openOpenProjectModal()` / `closeProjectModal(overlayId)` | Show/hide the two modals; Save prefills title/description and warns when overwriting an existing entry |
| `listLocalProjects()` | Index of saved projects, newest first (migrates legacy `pcb-project` key) |
| `saveCurrentToStorage()` | Upsert current design under the modal's title/description |
| `loadLocalProject(id)` / `deleteLocalProject(id)` | Restore or remove a stored project (with confirmation) |
| `downloadProjectFile()` | Download current design as `<title>.pcb.json` |
| `autoLoad()` | On startup: restore most recently saved project if present |

**Dependencies**: DOM (file input), `App` state, `ComponentDefs`.

---

## `app-ui.js`

**Extends**: `App`

All UI event bindings: toolbar buttons, keyboard shortcuts, tool/view switching, palette interactions, and layer visibility toggles.

| Method | Description |
|--------|-------------|
| `bindEvents()` | Wire up all DOM event listeners (buttons, resize, palette) |
| `handleKeydown(e)` | Keyboard shortcut handler (R=rotate, Del, Ctrl+Z/Y, etc.) |
| `setTool(toolName)` | Switch active tool (select/trace/via/outline/text) |
| `setView(viewName)` | Switch between board and schematic views |
| `fitToView()` | Fit whole board to canvas, centered (rulers read 0 at the board's top-left corner) |
| `toggleLayer(layerKey)` | Toggle visibility of a copper/silk layer |

**Keyboard shortcuts handled**: V/T/O/S/D (tools), R/Space (rotate), Enter (finish trace/outline), Delete/Backspace, Ctrl+Z/Y (undo/redo), Ctrl+S/O (save/open), Ctrl+G / Ctrl+Shift+G (group/ungroup), Escape.

**Dependencies**: DOM elements, `ComponentDefs`, `App` state.

---

## `app-canvas-board.js`

**Extends**: `App`

All mouse and wheel event handling for the board canvas: panning, zooming, component placement/dragging, trace drawing, vertex editing, context menu.

| Method | Description |
|--------|-------------|
| `bindCanvasEvents()` | Attach mousedown/mousemove/mouseup/wheel/contextmenu to boardCanvas |

**Interaction modes handled**:
- Left-click: tool action (place/drag/select/trace point)
- Middle-mouse: pan (or click-to-rotate selected component)
- Right-click: context menu / finish trace / cancel placement
- Wheel: zoom in/out centered on cursor
- Double-click: finish active trace
- Ctrl+Click: multi-select components

**Dependencies**: `App` state, `hit-test.js` methods, `trace-ops.js` methods.


---

## `board-view.js`

**Global**: `BoardView`

Canvas 2D renderer for the board view. All drawing is immediate-mode.

| Method | Description |
|--------|-------------|
| `render(app)` | Full frame: clear → transform → draw all layers in order |
| `drawBoard(ctx, app, x, y, w, h)` | Green substrate rectangle + border |
| `drawGrid(ctx, app, x, y, w, h)` | Dotted grid lines at params.gridSize intervals |
| `drawTrace(ctx, app, trace)` | Polyline with per-segment width, net color, dashed for bottom layer |
| `drawActiveTrace(ctx, app)` | Rubber-band preview of in-progress trace |
| `drawComponent(ctx, app, comp)` | Copper pads only (rounded-rect SMD, annular TH with pin-1 square) |
| `drawSilkComponent(ctx, app, comp)` | Silk screen: component outline + label text |
| `drawSilkText(ctx, app, txt)` | Free silk text annotation |
| `drawVia(ctx, app, via)` | Concentric circles (outer pad + inner drill) |
| `drawOutline(ctx, app, points)` | Board outline polygon |
| `drawPlacementGhost(ctx, app)` | Semi-transparent preview of the armed component at the snapped/aligned ghost position |
| `drawAlignGuides(ctx, app, lines)` | Full-viewport magenta alignment guide lines (placing or dragging) |
| `drawRulers(ctx, app)` | Screen-space mm rulers on top/left edges; labels relative to board top-left corner (0 at fitted corner); tick step adapts to zoom (1/2/5×10ⁿ); hidden when `params.showRulers` is false |
| `isTH(size)` | Helper: is this a through-hole package? |

**Dependencies**: `App` state, Canvas 2D API.

---

## `schematic-view.js`

**Global**: `SchematicView`

Canvas 2D renderer for the schematic view. Draws electrical symbols and wires.

| Method | Description |
|--------|-------------|
| `render(app)` | Full frame: clear → transform → draw grid, wires, symbols |
| `schemPinAnchors(comp)` | Compute screen anchor points for each pin of a component symbol |
| `drawSchemSymbol(ctx, app, comp)` | Draw type-specific symbol (resistor zigzag, IC box, LED, etc.) |
| `_isKicadImported(comp)` | Check if component uses imported KiCad graphics |

**Supported symbol types**: resistor, capacitor, led, ic, connector, inductor, diode, switch, fuse, crystal, transistor (NPN), pnp, mosfet, ldo, gnd, power, MCU boards, and KiCad-imported parts.

**Dependencies**: `App` state, Canvas 2D API.

---

## `schematic-ops.js`

**Extends**: `App`

Schematic view interaction: panning, zooming, component dragging, wire drawing between pins, and net management.

| Method | Description |
|--------|-------------|
| `hitSchemPin(sx, sy)` | Find pin under cursor in schematic (screen coords) |
| `hitSchemComp(sx, sy)` | Find component under cursor in schematic |
| `getPinNet(comp, pinIndex)` | Find which net a pin is connected to (via board traces) |
| `nextNetName()` | Auto-generate next net name and color |
| `createSchemWire(a, b)` | Create a board trace between two schematic pins (handles net merging) |

**Dependencies**: `App` state, `pinBoardPos()`.

---

## `gcode.js`

**Global**: `GCode`

GRBL G-code generation: isolation, drill, and board-cut toolpaths with machine profiles.

| Method | Description |
|--------|-------------|
| `generateFromApp(app, exportApi)` | Validate settings, build toolpaths, emit G-code text |
| `buildToolpaths(app, exportApi)` | Isolation / drill / outline geometry in G-code coordinates |
| `parseConfig(app)` | Read mill settings from `app.export` |

**Dependencies**: `Export` geometry helpers (`flipY`, `boardOutlinePoints`, `collectCopperOutlines`, `collectDrills`, `offsetPolygon`).

---

## `dxf.js`

**Global**: `Dxf`

AutoCAD DXF R2000 (`AC1015`) generator optimized for CAD/CAM compatibility. Standard mode uses `LINE` / `LWPOLYLINE` / `CIRCLE` / `ARC`. Legacy mode uses classic `POLYLINE` + `VERTEX` + `SEQEND` instead of `LWPOLYLINE`.

| Method | Description |
|--------|-------------|
| `generateFromApp(app, exportApi, options?)` | Validate geometry, serialize DXF, self-parse; returns `{ ok, dxf, error, summary, bounds }` |
| `parse(text)` | Conservative DXF group-code parser used for round-trip validation |
| `buildTransform(exportApi, app)` | Y-up, south-west origin transform (`flipY` + shift) |

Coordinates are always millimeters. Trace width is **not** encoded. Drills are `CIRCLE` with radius = drill diameter / 2. Tool compensation is not applied.

**Dependencies**: `Export` geometry helpers (`flipY`, `boardOutlinePoints`, `padFeatures`, `generateTraceOutline`, `collectDrills`, curve samplers).

---

## `export.js`

**Global**: `Export`

Generates SVG, DXF, and GRBL G-code files from the current project state. DXF and G-code generation live in `dxf.js` / `gcode.js`; this module collects PCB geometry and triggers downloads.

| Method | Description |
|--------|-------------|
| `exportSVG(app)` | Generate complete SVG with CSS classes → trigger download |
| `exportDXF(app)` | Call `Dxf.generateFromApp` → trigger download (or alert on validation failure) |
| `exportGCode(app)` | Call `GCode.generateFromApp` → trigger download (or alert on validation failure) |
| `download(content, filename, mime)` | Create Blob + object URL + anchor click for browser download |
| `normalizeTraces(app)` | Expand per-segment widths into flat segments before export |
| `generateTraceOutline(app, trace)` | Closed copper-island polygon (parallel curves at ±width/2) |
| `padFeatures(app, comp)` | World-space pad circles/polygons (KiCad geometry or pitch-safe fallback) |
| `flipY(point)` | Flip Y axis (screen-down → Cartesian-up) for DXF and G-code |

**Dependencies**: `App` state, `Dxf`, `GCode`, DOM (Blob/URL).


---

## `drc.js`

**Extends**: `App`

Design Rule Check engine. Validates the current design against user-configurable rules.

| Method | Description |
|--------|-------------|
| `runDRC()` | Execute all checks → return violations array + update DRC panel UI |
| `traceConnectsToComp(trace, comp)` | Helper: does any point of a trace touch a component pin? |

**Checks performed**:
1. **Min trace width** — any segment below params.minTraceWidth
2. **Min drill** — any via with drill < params.minDrill
3. **Clearance** — distance between different-net trace segments < params.minClearance
4. **Unconnected pins** — component pins not touched by any trace on the active layer
5. **Off-board** — components or vias outside board boundaries

Also defines standalone geometry helpers: `segSegDistance(p1, p2, p3, p4)` and `pointSegDistance(p, a, b)`.

**Dependencies**: `App` state, geometry helpers.

---

## `autorouter.js`

**Global**: `Autoroute`

Pure routing kernel (Epic 1, Stories 1.1-1.4) — no DOM, no App state; the browser, Node tests and the MCP host share the same file. Builds the routing grid and obstacle map, plans nets, finds A* paths, simplifies them to HV+45 polylines, and validates routes exactly before commit.

| Method | Description |
|--------|-------------|
| `resolveRules(project, options)` | Routing rules from params + option overrides (gridSize, traceWidth, clearance, boardEdgeClearance, layer, expansion) |
| `buildGrid(project, options)` | Typed-array cell grid in mm (Y-down); cells inside the board-edge inset are blocked |
| `createContext(project, options)` | Grid + rules snapshot for the routing pipeline |
| `buildObstacles(ctx)` | Inflate pads / same-layer traces / component bodies / vias into the grid; same-net (trace-derived via `ProjectApi.getPinNet`) geometry is never blocked |
| `planNets(project, options)` | Derived net membership (`ProjectApi.getPinNet`), connected components, deterministic route order |
| `findPath(grid, sx, sy, ex, ey)` | A* over the grid (8-directional HV+45) → `{ points, cost, bends }` or null |
| `simplifyPath(points, options)` | Collinear merge + optional 45° miters gated by `options.validateSegment(A, C)` |
| `validateRoute(ctx, points, net, options)` | Exact pre-commit gate: geometry (incl. fold-back), board inset, width floor, clearance sweep (traces / pads / SMD bodies / vias), FR25 mill-gap warning |
| `route(project, options)` | Whole-board run: plan → A* per net target → validate → commit validated traces into `project.traces` (one call = one undo step in the UI) → returns `{ success, routedNets, failedNets, diagnostics }` |

**UI wiring**: `App.runAutoroute()` in `app-ui.js` (toolbar `#btn-autoroute` opens the options modal). Options persist as `params.autoroute`. Route yields between nets so `#btn-autoroute-cancel` can stop a run; results go to `#autoroute-results` and the status bar.

**Dependencies**: `ComponentDefs`, `Export.padFeatures` (degrades gracefully when absent), drc.js helpers (`segSegDistance`, `pointSegDistance`), `ProjectApi.getPinNet` (net membership in planNets / buildObstacles / validateRoute).

---

## `kicad-import.js`

**Global**: `KicadImport` + helper functions

Parses KiCad v6 S-expression files (`.kicad_mod` footprints and `.kicad_sym` symbols), constructs ComponentDefs entries, registers them into the palette, and handles file/archive loading.

| Method/Function | Description |
|-----------------|-------------|
| `_kxTokenize(text)` | Tokenizer for S-expression text (handles parens, strings, numbers) |
| `_kxParse(text)` | Parse tokens into nested arrays (S-expr tree) |
| `KicadImport.parseFootprint(text)` | Extract pad positions, body outline, silk graphics from .kicad_mod |
| `KicadImport.parseSymbol(text)` | Extract pin definitions from .kicad_sym |
| `KicadImport.registerDef(def)` | Add imported def to ComponentDefs.defs + inject palette item |
| `KicadImport.loadFile(file)` | Handle single file or ZIP archive upload |
| `KicadImport.scanLibrary()` | Scan /PCBLib/ directory (if served over HTTP) for .zip packages |

**Dependencies**: `ComponentDefs`, `JSZip` (for .zip archives), DOM (file input, fetch).

---

## `component-library.js`

**Global**: `ComponentLibrary`

Component Library modal (Library button next to Import KiCad). Lists all installed parts (built-in categories + imported `kx_*` defs), previews the pin layout (top-view SVG of pads/drills/fab outline) and the 3D body (reuses `Model3D.buildScene` + `render(canvas)`), lets the user pick a package and arm placement, and removes imported parts. An "Online Repos" tab browses public GitHub repositories (curated KiCad official footprints + any `owner/repo[/path]`) via the GitHub contents API, previews any `.kicad_mod`, and registers + places it on demand. Online tab degrades gracefully offline / on `file://`.

| Method/Function | Description |
|-----------------|-------------|
| `ComponentLibrary.init()` | Wire modal buttons, tabs, search, size select, place/remove, 3D canvas |
| `ComponentLibrary.open()` / `close()` / `setTab(tab)` | Modal lifecycle, Installed/Online tabs |
| `ComponentLibrary.renderList()` | Search-filtered list of rows for the active tab |
| `ComponentLibrary.selectRow(row)` | Select a row; online rows fetch + parse the footprint first |
| `ComponentLibrary._showPreview(key, def, sizeIdx, source)` | Pin-layout SVG, 3D render, info line, model3d links, size picker |
| `ComponentLibrary.placeSelected()` | Register online def, arm `App.interaction` placement, close modal |
| `ComponentLibrary.removeSelected()` | Delete an imported def + its palette item |
| `_loadDirs/_loadFolder/_gh` | GitHub repo/folder listing via `api.github.com` |

**Dependencies**: `ComponentDefs`, `KicadImport`, `Model3D`, `App`. Network calls are optional (Online tab only) and never block the app.

---

## `model3d.js`

Component 3D preview built on vendored Three.js r147 (`js/vendor/three.min.js`, MIT, loaded before this file). WebGL viewers are created lazily per canvas (WeakMap), one context each, with PBR materials, soft shadows, hemisphere + key/fill/rim lights and ACES tone mapping. The orientation cube is a separate canvas beside the part or board view and follows that canvas's orbit; the library strip has no cube. Camera state is stored on the canvas. `buildScene(size)` turns a component size into a mesh spec: KiCad footprints render an FR-4 slab with copper pads, drill holes and silkscreen/fab graphics, plus a package-accurate body chosen by footprint name (DIP with a pin-1 index, SOIC/QFP gull-wing tube leads, TO-92, TO-220 with tab + mounting hole, SOT-23, pin headers, axial resistor/diode with cathode band, electrolytic can with vent cross and sleeve stripe, domed LED with cathode post, SMD/PLCC LED lens, SMD chip with tin terminations). Built-in sizes without a KiCad footprint get an equivalent generated body from their pin layout. Left-drag orbits, right or middle drag pans, the wheel zooms toward the cursor, double-click resets; KiCad `model3d` references are listed as links. Browser-only - the MCP kernel never loads this file.

| API | Description |
|-----|-------------|
| `Model3D.openFor(compId)` | Open the modal for a placed component |
| `Model3D.buildScene(size)` | Rebuild the mesh spec for a component size |
| `Model3D.render(canvasEl)` | Render into a canvas (creates its viewer on first call) |
| `Model3D.bind(canvasId)` | Wire drag/wheel/close handlers once |
| `Model3D.yaw / .pitch / .zoom` | Orbit camera state |

**Dependencies**: `THREE` (vendored), `App`, `ComponentDefs`, `KicadImport` (`_fabBodySize`).

---

## `app.js`

Bootstrap script. Listens for `DOMContentLoaded` then calls `App.init()`.

```javascript
document.addEventListener('DOMContentLoaded', () => { App.init(); });
```

**Dependencies**: `App` (all other modules must be loaded first).

