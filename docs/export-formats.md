# Export Formats

## SVG Export

**File**: `pcb-export.svg`  
**MIME**: `image/svg+xml`  
**Units**: Millimeters (viewBox in mm)

### Structure

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -40 100 80" width="100mm" height="80mm">
  <style>
    .outline { fill: none; stroke: #000; stroke-width: 0.5; }
    .trace-top { stroke: #00f; fill: none; }
    .trace-bottom { stroke: #0f0; fill: none; stroke-dasharray: 2,1; }
    .via { fill: none; stroke: #000; }
    .comp-body { fill: rgba(0,100,0,0.3); stroke: #080; }
    .comp-pin { fill: #ff0; stroke: #000; }
    .label { font-size: 2mm; fill: #fff; }
  </style>

  <!-- CUT PATH -->
  <polygon points="..." class="outline" id="board-outline"/>

  <!-- TRACES -->
  <line x1="..." y1="..." x2="..." y2="..." class="trace-top" stroke-width="0.5" data-net="VCC"/>
  <path d="M ... Q ... ..." class="trace-top" stroke-width="0.5" data-net="SIG1"/>

  <!-- HOLES -->
  <circle cx="..." cy="..." r="0.5" class="via" stroke-width="0.3"/>

  <!-- COMPONENTS -->
  <g id="comp-3" data-type="resistor" data-value="10kΩ" data-size="0805">
    <polygon points="..." class="comp-body"/>
    <circle cx="..." cy="..." r="0.8" class="comp-pin"/>
    <text x="..." y="..." class="label" text-anchor="middle">R1</text>
  </g>
</svg>
```

### Key Features

- **Kerf compensation**: Trace widths are expanded by `kerfWidth` for laser cutting accuracy
- **Per-segment widths**: Each line/path has its own `stroke-width`
- **Curved segments**: Exported as quadratic Bézier `<path d="M...Q...">` 
- **Data attributes**: `data-net`, `data-type`, `data-value`, `data-size` for downstream processing
- **Layer visibility respected**: Only visible layers are included

### Laser Cutter Usage

The SVG is designed to be directly importable into laser cutting software (LightBurn, Inkscape → CNC). The outline polygon defines the cut path, traces define mill paths, and holes define drill points.

---

## DXF Export

**File**: `pcb-export.dxf`  
**Module**: `js/dxf.js` (generation) + `js/export.js` (geometry helpers)  
**Format**: AutoCAD DXF R2000 (`AC1015`)  
**Units**: Millimeters (`$INSUNITS = 4`, `$MEASUREMENT = 1`) — never scaled to inches  
**Precision**: 6 decimal places, `.` decimal separator, no scientific notation  
**Line endings**: CRLF  
**Origin**: south-west corner of the board, Cartesian Y-up (internal Y-down coordinates are converted once via `flipY()` then shifted so min X/Y = 0). With **Mirror X** (`mirror: true`) the geometry is additionally negated on X (backside view) and the origin is recomputed from the mirrored outline.

DXF is a **geometry interchange** format. It describes the PCB, not milling toolpaths. Tool compensation, isolation offsets, and cut depths belong to G-code.

### Modes

| Mode | Export setting | Polylines |
|------|----------------|-----------|
| **R2000 Standard** (default) | `dxfMode: "standard"` | `LWPOLYLINE` |
| **R2000 Legacy** | `dxfMode: "legacy"` | classic `POLYLINE` + `VERTEX` + `SEQEND` |

Both modes also use `LINE`, `CIRCLE`, and `ARC`. Neither mode encodes trace width with polyline groups 40/41/43.

**Mirror X** (`mirror: true`): flips the geometry on X (backside view) after the Y flip; the origin is recomputed from the mirrored outline so coordinates stay non-negative and SW-origin based.

**Layer selection** (`export.layers`, default: all `*_TOP` on, all `*_BOTTOM` off): one checkbox per DXF layer — `COPPER_TOP/BOTTOM`, `TRACE_OUTLINE_TOP/BOTTOM`, `TRACE_TOP/BOTTOM`, `PAD_TOP/BOTTOM`. Each key gates the entity layer of the same name; the COPPER_* merged outlines always contain traces + pads + vias regardless of the other selections. Missing keys fall back to view layer visibility (top on, bottom when visible) for old saves.

### Section Structure

```
SECTION: HEADER
  $ACADVER = AC1015
  $INSUNITS = 4 (mm)
  $MEASUREMENT = 1 (metric)
  $EXTMIN / $EXTMAX (geometry bounding box)

SECTION: TABLES
  LAYER definitions (see below)

SECTION: ENTITIES
  All geometric entities

EOF
```

No BLOCKS, OBJECTS, CLASSES, XDATA, HATCH, or SPLINE.

### Layer Definitions

| Layer Name | Color (ACI) | Content |
|-----------|-------------|---------|
| `OUTLINE` | 7 | Board outline as a **closed** polyline — actual board edge, no cutter offset |
| `TRACE_OUTLINE_TOP` | 1 | Top trace copper boundaries (individual per-trace outlines) |
| `TRACE_TOP` | 1 | Top trace **centerlines** (no width) |
| `PAD_TOP` | 1 | Top pads (`CIRCLE` or closed polyline) |
| `COPPER_TOP` | 1 | Top copper — merged union of all traces, pads, and vias (isolation milling ready) |
| `TRACE_OUTLINE_BOTTOM` | 5 | Bottom trace copper boundaries |
| `TRACE_BOTTOM` | 5 | Bottom trace centerlines |
| `PAD_BOTTOM` | 5 | Bottom pads |
| `COPPER_BOTTOM` | 5 | Bottom copper — merged union (isolation milling ready) |
| `DRILL` | 3 | Drill holes as `CIRCLE` with radius = drillDiameter / 2 |

Layer names are ASCII, stable, and independent of UI language.

### Entity Types

- **LINE** — isolated straight trace segments
- **LWPOLYLINE** (standard) / **POLYLINE+VERTEX+SEQEND** (legacy) — connected traces, closed outlines, rectangular pads, copper boundaries. Closed contours use group `70 = 1` without repeating the first vertex.
- **CIRCLE** — round pads and drills (`40` = radius)
- **ARC** — genuine circular arcs (degrees), when present

Traces are centerlines. A 0.5 mm track from (10,20) to (20,20) is a two-point line/polyline, **not** a polyline with width 0.5.

### Coordinate transform

Board view is millimeters, origin at board center, Y down. DXF is millimeters, origin at the board south-west corner, Y up:

```
dxfX =  worldX  - originX
dxfY = -worldY  - originY
```

where `(originX, originY)` is the south-west corner of the flipped board outline. A default 100 × 80 mm board therefore occupies `0 ≤ X ≤ 100`, `0 ≤ Y ≤ 80`. This is the same XY convention as G-code **before** tool-radius compensation.

### Tests

Run `node tests/dxf.test.js` locally or in CI to verify outline bounds, centerline traces (no width groups), drill radius, closed contours, Z=0, six-decimal formatting, parser round-trip, legacy POLYLINE mode, and deterministic re-export.


---

## G-code Export

**File**: `pcb-mill.gcode`  
**Module**: `js/gcode.js` (generation) + `js/export.js` (geometry collection)  
**Dialect**: GRBL-compatible profile (`millProfile: "grbl"`)  
**Origin**: south-west corner of the board after Y-up conversion (same XY as DXF, then G-code offsets isolation/outline by tool radius). With **Mirror X** (`mirror: true`) the toolpaths are mirrored on X and a `; MIRRORED OUTPUT` comment is emitted.

**Layer selection** (`export.layers`): bottom isolation is only generated when `COPPER_BOTTOM` is enabled (default off); the bottom section still carries the flip-the-board comment.

Invalid export settings are rejected with an alert before any file is downloaded.

### Operations (one file)

1. **Isolation** — mill around copper (traces + pads + via rings) with the **isolation tool**. Tool centre is the copper outline offset outward by `millToolDia/2`. Depth = `millIsoDepth`. Top copper always; bottom only when `COPPER_BOTTOM` is selected (mill after flipping the board).
2. **Drill** — explicit plunge/peck at via and through-hole centres with the **drill tool** to `board.thickness + millDrillOvercut`. Tool-change comments are emitted when the drill diameter differs from the previous tool.
3. **Board cut** — follow the outline offset outward by `millOutlineToolDia/2`, in `millOutlinePasses` evenly spaced Z passes through board thickness (optional `millOutlineOvercut` on the final pass).

### Initialization sequence

```
G21 / G20
G90
G17
G94
G40
G49
G54
G0 Z<safeZ>
G0 X<start> Y<start>
M3 S<spindle>
G4 P<dwell>   ; omitted when dwell is 0 or profile disables dwell
```

The spindle is **not** started until the tool is positioned at the first cut XY location.

### Settings (Export panel)

| Setting | Default | Meaning |
|---------|---------|---------|
| Tool Ø | 0.2 mm | Isolation bit diameter |
| Drill Ø | 0.8 mm | Drill bit diameter (separate from isolation tool) |
| Outline Tool | 0.2 mm | Board outline cut tool diameter |
| Iso Depth | 0.1 mm | Copper isolation depth |
| Safe Z | 5 mm | Rapid clearance height |
| Iso Feed | 120 mm/min | Isolation XY feed |
| Drill Feed | 50 mm/min | Drill plunge feed |
| Outline Feed | 72 mm/min | Board cut XY feed |
| Plunge | 50 mm/min | Z plunge feed for isolation/outline |
| Outline Passes | 3 | Number of board cut depth passes |
| Drill Overcut | 0.1 mm | Extra drill depth beyond board thickness |
| Outline Overcut | 0 mm | Optional final outline pass overcut (may mark spoilboard) |
| Spindle | 10000 RPM | `M3 S` value from profile |
| Spindle Dwell | 2 s | `G4 P` after spindle start; 0 disables |

### Tests

Run `node tests/gcode.test.js` locally or in CI to verify outline compensation, pass depths, drill depth, spindle ordering, and validation.
