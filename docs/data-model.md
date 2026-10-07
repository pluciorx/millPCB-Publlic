# Data Model — Project JSON Schema

## File Format

Projects are saved as `.pcb.json` files (also stored in browser localStorage as named projects: index under key `millpcb.projects`, payloads under `millpcb.project.<id>`). The format is versioned and all dimensions are in **millimeters** unless noted.

## Top-Level Structure

```json
{
  "version": 1,
  "board": { ... },
  "params": { ... },
  "export": { ... },
  "nets": [ ... ],
  "traces": [ ... ],
  "components": [ ... ],
  "vias": [ ... ],
  "boardOutline": [ ... ],
  "silkTexts": [ ... ],
  "idCounter": 42,
  "importedDefs": [ ... ]
}
```

## Field Definitions

### `version` (integer)

Schema version. Currently always `1`. Used for future migration logic on load.

---

### `board` (object)

Physical board properties.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `width` | number | 100 | Board width in mm |
| `height` | number | 80 | Board height in mm |
| `thickness` | number | 1.2 | Board substrate thickness in mm |
| `copperWeight` | number | 1 | Copper weight in oz (1 or 2) |
| `material` | string | "FR4" | Substrate material name |

---

### `params` (object)

Design parameters and DRC constraints.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `traceWidth` | number | 0.5 | Default trace width in mm |
| `viaDiameter` | number | 1.0 | Default via outer diameter in mm |
| `gridSize` | number | 1.0 | Grid snap interval in mm |
| `minTraceWidth` | number | 0.38 | DRC: minimum allowed trace width (mm) |
| `minDrill` | number | 0.1 | DRC: minimum via drill diameter (mm) |
| `minClearance` | number | 0.38 | DRC: minimum clearance between different-net traces (mm) |

---

### `export` (object)

Export settings for SVG/DXF output.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `kerfWidth` | number | 0.15 | Laser cutter kerf compensation (mm) |
| `units` | string | "mm" | Output units: "mm" or "inches" |
| `includeHoles` | boolean | true | Include via/holes in export |
| `includeTraces` | boolean | true | Include trace centerlines in export |
| `includeComps` | boolean | true | Include component outlines in export |
| `includeBoardOutline` | boolean | true | Include board cut outline |
| `includeCopperOutlines` | boolean | true | Include copper outlines in DXF: per-trace (`TRACE_OUTLINE_TOP`/`BOTTOM`) and merged union (`COPPER_TOP`/`BOTTOM`) |
| `mirror` | boolean | false | Mirror X axis in DXF/G-code output (backside view); origin still recomputed to the south-west corner |
| `layers` | object | `{ COPPER_TOP: true, COPPER_BOTTOM: false, TRACE_OUTLINE_TOP: true, TRACE_OUTLINE_BOTTOM: false, TRACE_TOP: true, TRACE_BOTTOM: false, PAD_TOP: true, PAD_BOTTOM: false }` | Per-DXF-layer selection for exports. Each key gates the entity layer of the same name; bottom isolation in G-code follows `COPPER_BOTTOM`. Missing keys fall back to view layer visibility (top on, bottom when visible) |
| `dxfMode` | string | `"standard"` | DXF polyline style: `"standard"` (LWPOLYLINE) or `"legacy"` (POLYLINE/VERTEX/SEQEND) |
| `millToolDia` | number | 0.2 | G-code isolation tool diameter (mm) |
| `millDrillToolDia` | number | 0.8 | G-code drill bit diameter (mm) |
| `millOutlineToolDia` | number | 0.2 | G-code board outline tool diameter (mm) |
| `millIsoDepth` | number | 0.1 | G-code isolation cut depth (mm) |
| `millSafeZ` | number | 5 | G-code rapid Z height (mm) |
| `millFeed` | number | 120 | G-code isolation XY feed (mm/min) |
| `millDrillFeed` | number | 50 | G-code drill plunge feed (mm/min) |
| `millOutlineFeed` | number | 72 | G-code outline XY feed (mm/min) |
| `millPlunge` | number | 50 | G-code Z plunge feed (mm/min) |
| `millOutlinePasses` | number | 3 | Number of outline cut depth passes |
| `millDrillOvercut` | number | 0.1 | Extra drill depth beyond board thickness (mm) |
| `millOutlineOvercut` | number | 0 | Optional extra depth on final outline pass (mm) |
| `millSpindle` | number | 10000 | G-code spindle RPM |
| `millSpindleDwell` | number | 2 | Spindle spin-up dwell in seconds (`G4 P`); 0 disables |
| `millProfile` | string | "grbl" | Machine/controller profile name |

---

### `nets` (array of objects)

Named electrical nets with display colors.

```json
{ "name": "VCC", "color": "#ff4444" }
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Net identifier (unique, used in trace.net) |
| `color` | string | Hex color for rendering this net's traces/wires |

**Default nets**: VCC (#ff4444), GND (#44ff44), SIG1 (#4488ff). Additional nets are auto-named NET_4, NET_5, ... with cycling colors.

---

### `traces` (array of objects)

Copper traces connecting components on a net.

```json
{
  "id": 7,
  "points": [{ "x": 10, "y": 20 }, { "x": 15, "y": 20 }],
  "width": 0.5,
  "segmentWidths": [0.5],
  "layer": "top",
  "net": "VCC",
  "curved": [false]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique ID (from idCounter) |
| `points` | array of {x, y} | Polyline vertices in board mm coords. Minimum 2 points. |
| `width` | number | Default/base trace width in mm |
| `segmentWidths` | array of number | Per-segment widths (length = points.length - 1). Overrides `width` per segment. |
| `layer` | string | "top" or "bottom" |
| `net` | string | Net name this trace belongs to |
| `curved` | array of boolean | Per-segment flag: if true, rendered as quadratic Bézier (length = points.length - 1) |

**Geometry**: Each segment is between `points[i]` and `points[i+1]`. The `segmentWidths[i]` and `curved[i]` apply to that segment.

---

### `components` (array of objects)

Placed components on the board.

```json
{
  "id": 3,
  "type": "resistor",
  "x": 25.0,
  "y": -18.0,
  "rotation": 90,
  "layer": "top",
  "size": 2,
  "value": "10kΩ",
  "label": "R3",
  "pins": [{ "x": -1.0, "y": 0, "name": "1" }, { "x": 1.0, "y": 0, "name": "2" }],
  "schemX": -100,
  "schemY": 40
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique ID (from idCounter) |
| `type` | string | Component type key (see Component Library below) |
| `x` | number | Board X position in mm (center of component) |
| `y` | number | Board Y position in mm (center of component) |
| `rotation` | number | Rotation in degrees (0, 90, 180, 270 typical) |
| `layer` | string | "top" or "bottom" — which copper layer the pads are on |
| `size` | integer | Index into ComponentDefs[type].sizes[] for this instance |
| `value` | string | Electrical value label (e.g. "10kΩ", "100nF") |
| `label` | string | Designator (auto-assigned: R1, C2, U3, etc.) |
| `pins` | array of {x, y, name} | Pin positions relative to component center in mm. Copied from def at placement time; instance pins override the library def everywhere (snap, DRC, export). |
| `span` | number (optional) | Wire-jumper solder-hole span in mm. When present, `pins` are `{±span/2, 0}` and editable via props; load migrates legacy jumper instances to this form. |
| `schemX` | number | Schematic view X position (pixels) |
| `schemY` | number | Schematic view Y position (pixels) |

**Pin world position**: Calculated as `(comp.x + pin.x * cos(rot) - pin.y * sin(rot), comp.y + pin.x * sin(rot) + pin.y * cos(rot))`.

---

### `vias` (array of objects)

Solder holes — unplated through-holes (drilled, no copper ring). Used for hand-soldered wire jumpers and mounting.

```json
{ "id": 12, "x": 5.0, "y": -3.0, "diameter": 1.0, "drill": 0.5 }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique ID |
| `x` | number | X position in mm |
| `y` | number | Y position in mm |
| `diameter` | number | Hole diameter in mm (no pad — the hole is drilled as-is) |
| `drill` | number (optional) | Drill diameter in mm (defaults to `diameter`; G-code drills this) |

---

### `boardOutline` (array of {x, y})

User-drawn board outline polygon in mm coords. If empty or fewer than 3 points, the board is treated as a rectangle defined by `board.width` × `board.height`.

```json
[{ "x": -50, "y": -40 }, { "x": 50, "y": -40 }, { "x": 50, "y": 40 }, { "x": -50, "y": 40 }]
```

---

### `silkTexts` (array of objects)

Free-text annotations on the silk screen layer.

```json
{ "id": 20, "x": 10, "y": -35, "text": "REV A", "layer": "silkTop", "size": 2.0 }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique ID |
| `x` | number | X position in mm |
| `y` | number | Y position in mm |
| `text` | string | Text content |
| `layer` | string | "silkTop" or "silkBottom" |
| `size` | number | Font size in mm |

---

### `idCounter` (integer)

Monotonically increasing counter for generating unique IDs. Next ID = `++idCounter`.

---

### `importedDefs` (array of objects, optional)

Custom component definitions imported from KiCad files. Only present if the user has imported KiCad footprints/symbols. Each entry is a full ComponentDef structure that gets merged into `ComponentDefs.defs` on load.


---

## Component Library (Built-in Types)

The `type` field in a component references one of these keys in `ComponentDefs.defs`:

| Type Key | Prefix | Description | Available Packages |
|----------|--------|-------------|-------------------|
| `resistor` | R | Resistor | 10 common values (0805) + 0402–1210 + TH |
| `capacitor` | C | Capacitor | 10 common values + 0402–1206 + electrolytic |
| `led` | D | LED | 5mm/3mm colors, 0603–1206, WS2812B |
| `ic` | U | Integrated Circuit | NE555, LM358, LM324, 74HC00/14/595, ULN2803, ATmega328P, CH340C, 24LC256 + DIP/SOIC |
| `connector` | J | Pin header / USB | 1×2–2×16 generator, USB-C, barrel jack |
| `inductor` | L | Inductor | 0402, 0603, 0805, 1206, TH 5mm |
| `diode` | D | Diode | 1N4148, 1N400x, 1N5819, 1N5408, BAT54, SS14, UF4007 + packages |
| `transistor` | Q | NPN BJT | 2N2222, 2N3904, BC547, BC337, 2N4401, S8050, MMBT2222, MMBT3904, TIP120, TIP31 |
| `pnp` | Q | PNP BJT | 2N3906, 2N2907, BC557, BC327, 2N4403, S8550, MMBT2907, MMBT3906, TIP32 |
| `mosfet` | Q | MOSFET | 2N7000, 2N7002, AO3400, IRLZ44N, IRF540, AO3401, IRF9540 |
| `ldo` | U | Voltage regulator | AMS1117, LM1117, LM7805, LM7812, LM317, MCP1700, HT7333 |
| `fuse` | F | Fuse | 0603, 0805, 1206, TH 5×20 |
| `crystal` | Y | Crystal | HC-49S, SMD 3.2×2.5, SMD 5×3.2 |
| `switch` | SW | Switch | SPST 6mm, Tact 6mm |
| `gnd` | — | Ground test point | TP 2.5mm, TH TP, TH TP XL |
| `power` | — | Power test point | TP 2.5mm, TH TP, TH TP XL |
| `arduino_uno` | U | Arduino Uno R3 module | Uno R3 (KiCad Module.pretty) |
| `arduino_nano` | U | Arduino Nano module | Nano (KiCad) |
| `esp32_devkit` | U | ESP32 DevKitC | Espressif KiCad |
| `esp32s3_devkit` | U | ESP32-S3-DevKitC | Espressif KiCad |
| `esp32s2_mini` | U | ESP32-S2 mini / DevKitC | KiCad RF_Module + Espressif |
| `esp32s3_nano` | U | Arduino Nano ESP32 | KiCad Module.pretty |
| `esp8266_nodemcu` | U | Wemos D1 mini | KiCad RF_Module |
| `rpi_pico` | U | Raspberry Pi Pico | KiCad Module.pretty |

Plus any **imported KiCad** definitions (type key = footprint name from the `.kicad_mod` file).

### ComponentDef Structure

Each entry in `ComponentDefs.defs[type]` has:

```json
{
  "prefix": "R",
  "defaultValue": "10kΩ",
  "sizes": [
    {
      "name": "0805",
      "width": 2.0,
      "height": 1.25,
      "th": false,
      "pins": [{ "x": -1.0, "y": 0, "name": "1" }, { "x": 1.0, "y": 0, "name": "2" }]
    }
  ],
  "defaultSize": 2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | string | Designator prefix (R, C, U, D, Q, J, L) |
| `defaultValue` | string | Default value text shown in properties |
| `sizes` | array | Available package options for this type |
| `defaultSize` | integer | Index into `sizes[]` used when no size specified |

Each entry in `sizes[]`:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Package name (e.g. "0805", "DIP-8") |
| `width` | number | Body width in mm |
| `height` | number | Body height in mm |
| `th` | boolean (optional) | true if through-hole package |
| `padR` | number (optional) | Override THT pad radius in mm (default: pitch-based, max 1.0). Used by TH TP XL |
| `drillDia` | number (optional) | Override THT drill diameter in mm (default: padR × 0.8). Used by TH TP XL |
| `pins` | array of {x, y, name} | Pin positions relative to body center in mm |

