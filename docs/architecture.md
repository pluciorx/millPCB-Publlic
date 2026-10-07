# Architecture

## Overview

The PCB Editor is a **single-page, zero-backend web application** that runs entirely in the browser. All state lives in memory (a global `App` object), rendering uses Canvas 2D, and persistence is via localStorage + file download/upload.

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser                                  │
│                                                             │
│  ┌───────────┐    ┌──────────────────────────────────────┐  │
│  │  HTML UI  │    │           Canvas (2D)                │  │
│  │  Toolbar  │    │                                      │  │
│  │  Panels   │    │   BoardView.render(app)              │  │
│  │  Status   │    │   SchematicView.render(app)          │  │
│  └─────┬─────┘    └──────────────────────────────────────┘  │
│        │                                                    │
│        ▼                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    App (global object)                  │  │
│  │                                                        │  │
│  │  State:  board, traces[], components[], vias[], nets[] │  │
│  │  View:   mode, tool, zoom, panX/Y, activeLayer         │  │
│  │  Inter:  selectedObject, placingComponent, dragState   │  │
│  │                                                        │  │
│  │  Methods: init(), render(), saveState(), undo()...     │  │
│  └────────────────────────────────────────────────────────┘  │
│        │                     │                    │          │
│        ▼                     ▼                    ▼          │
│  ┌──────────┐       ┌─────────────┐      ┌────────────┐    │
│  │ Save/Load│       │   Export    │      │    DRC     │    │
│  │ (JSON)   │       │ SVG/DXF/NC  │      │  Engine    │    │
│  └──────────┘       └─────────────┘      └────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Design Patterns

### 1. Global Singleton State

The entire application state is a single global object called `App`, defined in `app-core.js` and extended via `Object.assign(App, {...})` in other modules. This avoids module systems and keeps everything accessible without imports.

```javascript
// app-core.js defines the base:
const App = { board: {...}, traces: [], components: [], ... };

// Other files extend it:
Object.assign(App, { saveProject() {...} });   // app-save.js
Object.assign(App, { runDRC() {...} });        // drc.js
```

### 2. Render-Loop (Pull-based)

There is no continuous animation loop. Rendering happens **on demand** — whenever state changes, `App.render()` is called:

```javascript
App.render() {
    if (this.view.mode === 'board') BoardView.render(this);
    else SchematicView.render(this);
}
```

This keeps CPU usage at zero when idle.

### 3. Immediate Mode Drawing

Both `BoardView` and `SchematicView` clear the canvas and redraw everything from scratch on each `render()` call. There is no retained-mode scene graph or dirty-rect optimization. For typical PCB sizes (<1000 objects), this performs well at 60fps during interaction.

### 4. Event-driven Interaction

All user input (mouse, keyboard) flows through event listeners bound in `app-ui.js` and `app-canvas-board.js`. Events mutate state → call `render()`.

## Module Loading Order

Scripts are loaded in a specific order via `<script>` tags in `index.html`:

```
1. component-defs.js      → defines ComponentDefs (data)
2. app-core.js            → defines App (state + core methods)
3. hit-test.js            → extends App (hit-testing helpers)
4. trace-ops.js           → extends App (trace operations)
5. app-props.js           → extends App (properties panel)
6. app-save.js            → extends App (save/load)
7. app-ui.js              → extends App (UI bindings, keyboard)
8. app-canvas-board.js    → extends App (canvas mouse events)
9. board-view.js          → defines BoardView (renderer)
10. schematic-view.js     → defines SchematicView (renderer)
11. schematic-ops.js      → extends App (schematic interaction)
12. gcode.js              → defines GCode (GRBL toolpaths)
13. dxf.js                → defines Dxf (R2000 DXF generator)
14. export.js             → defines Export (SVG/DXF/G-code entry points)
15. drc.js                → extends App (DRC engine)
16. vendor/jszip.min.js   → defines JSZip (library)
17. kicad-import.js       → defines KicadImport (KiCad parser)
18. libs-loader.js        → library scan
19. app.js                → bootstrap: DOMContentLoaded → App.init()
```

## Data Flow

### User Action → State → Render

```
User clicks "Trace" tool
    → App.setTool('trace')          [app-ui.js]
    → view.tool = 'trace'           [state change]
    → render()                      [visual update: cursor changes]

User clicks canvas at (x, y)
    → mousedown handler             [app-canvas-board.js]
    → screenToWorld(sx, sy)         [coord transform]
    → interaction.tracePoints.push({x, y})  [state change]
    → render()                      [draws rubber-band trace]

User double-clicks (finish trace)
    → finishTrace()                 [trace-ops.js]
    → traces.push({...})            [state change]
    → saveState()                   [pushes undo snapshot]
    → render()                      [final trace appears]
```

### Save/Load Flow

```
Save:
  App.saveProject()
    → serialize {board, params, export, nets, traces, components, vias, boardOutline, idCounter}
    → JSON.stringify(data)
    → localStorage.setItem('pcb-project', json)     [auto-persist]
    → Blob download as 'project.pcb.json'            [user file]

Load:
  App.loadProject()
    → File input dialog → FileReader.readAsText(file)
    → JSON.parse(text)
    → Object.assign(App, parsed fields)
    → ensureSchemPositions() + ensureLabels()       [migration]
    → saveState() + fitToView() + render()
```

## Coordinate Systems

### Board View (mm, origin at board center)

```
worldX = (screenX - canvasWidth/2) / zoom + panX
worldY = (screenY - canvasHeight/2) / zoom + panY

Inverse:
screenX = (worldX - panX) * zoom + canvasWidth/2
screenY = (worldY - panY) * zoom + canvasHeight/2
```

- **World units**: millimeters
- **Origin**: center of the board (0, 0)
- **Positive Y**: downward (canvas convention)
- **Board extent**: from `(-width/2, -height/2)` to `(+width/2, +height/2)`

### Schematic View (pixels, origin at schematic center)

```
schemScreenX = (schemWorldX - schemPanX) * schemZoom + canvasWidth/2
schemScreenY = (schemWorldY - schemPanY) * schemZoom + canvasHeight/2
```

- **World units**: pixels (screen-space at zoom=1)
- **Component positions**: stored as `comp.schemX`, `comp.schemY`
- **Independent** from board coordinates — schematic is a separate layout space

### Pin Position Calculation (rotation-aware)

```javascript
// Given component at (cx, cy) with rotation θ (degrees), pin at local (px, py):
const rad = θ * Math.PI / 180;
worldPinX = cx + px * cos(rad) - py * sin(rad);
worldPinY = cy + px * sin(rad) + py * cos(rad);
```


## Rendering Pipeline (Board View)

Each `render()` call draws layers in this order:

```
1. Clear canvas (dark background #0a0a1a)
2. Apply transform (translate center → scale zoom → translate -pan)
3. Draw board substrate (green rect + border)
4. Draw grid (dotted lines at gridSize intervals)
5. Draw traces (per-segment width, color by net, dashed for bottom layer)
6. Draw active trace being drawn (rubber-band preview)
7. Draw components (copper pads: rects for SMD, circles for TH)
8. Draw silk screen (component outlines + text labels)
9. Draw vias (concentric circles)
10. Draw board outline (user-drawn polygon if exists)
11. Draw selection highlights (bounding box, vertices)
12. Draw placement ghost preview (if placing component)
```

## Rendering Pipeline (Schematic View)

```
1. Clear canvas
2. Apply transform (schemZoom + schemPanX/Y)
3. Draw grid
4. Draw wires (traces between schematic pins, colored by net)
5. Draw component symbols (type-specific: resistor zigzag, IC box, LED triangle...)
6. Draw pin labels and anchor points
7. Draw rubber-band wire being drawn
8. Draw selection highlights
```

## Undo/Redo System

- **Strategy**: Full state snapshot (JSON string of traces, components, vias, boardOutline, silkTexts)
- **Stack size**: 50 entries max (oldest discarded)
- **Trigger**: `saveState()` called after every mutating operation
- **Restore**: `JSON.parse(snapshot)` → `Object.assign(App, state)` → `render()`

## Extension Points

| What | How |
|------|-----|
| Add a new component type | Add entry to `ComponentDefs.defs`, add symbol in `schematic-view.js` |
| Add a new tool | Add button in HTML, handle in `app-canvas-board.js`, render in `board-view.js` |
| Add a new export format | Create method in `export.js`, add toolbar button |
| Add a new DRC rule | Add check block in `drc.js` `runDRC()` |
| Add keyboard shortcut | Extend `handleKeydown()` in `app-ui.js` |

