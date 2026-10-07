# Features & User Interactions

## Views

### Board View (default)

Top-down view of the PCB in millimeters. Shows copper traces, component footprints, vias, board outline, and silk screen annotations. Supports pan/zoom/rotate.

### Schematic View

Electrical wiring diagram with type-specific symbols (resistor zigzag, IC boxes, LED triangles, etc.). Wires drawn here create actual board traces. Components can be dragged to arrange the schematic layout independently of their board positions.

**Switch**: Toolbar buttons "Board" / "Schematic", or press `B` / `S`.

---

## Tools

| Tool | Key | Description |
|------|-----|-------------|
| **Select** | (default) | Click to select objects, drag to move, click vertices to edit traces |
| **Trace** | `T` | Draw copper traces by clicking waypoints. Double-click or right-click to finish. |
| **Via** | `V` | Place plated through-holes. Click to place. |
| **Outline** | `O` | Draw custom board outline polygon. Click to add points, double-click to close. |
| **Text** | `X` | Add silk screen text annotations. Click to place, type in properties panel. |

---

## Component Placement

1. Click a component in the left palette (or click ▼ to choose a package size)
2. A ghost preview follows the cursor on the board
3. Press `R` to rotate the ghost before placing
4. Left-click to place the component
5. Repeat for multiple placements (palette item stays active until Escape or another tool is selected)

**Multi-select**: Hold `Ctrl` or `Shift` and click components to select a group. Drag any selected component to move the entire group.

---

## Trace Drawing

1. Select the **Trace** tool
2. Click to place waypoints (snaps to grid and nearby pins)
3. The active trace follows the cursor as a rubber-band line
4. **Double-click** or **right-click** to finish the trace
5. `Esc` to cancel the current trace

### Trace Editing

- Select a trace → click a vertex to drag it
- Delete a joint: select a vertex and press `Del`, or right-click → **Delete Joint**. The trace re-routes (adjacent segments merge); the whole trace is never deleted, and joints on pads are protected.
- Multi-select joints with Ctrl/Shift+click, then `Del` to remove them all in one undo step (batched per trace).
- Right-click a segment to add a new vertex at that point
- Select a segment → change width in properties panel
- Each segment can have an independent width (clamped by pad constraints at endpoints)

### Curved Traces

Segments can be toggled to render as quadratic Bézier curves. The control point is automatically computed for a smooth arc between the two endpoints.

---

## Schematic Wiring

1. Switch to **Schematic** view
2. Click a pin on one component → a rubber-band wire follows the cursor
3. Click a pin on another component to complete the wire
4. A board trace is automatically created connecting those pins' physical positions
5. If both pins are already on the same net, the new trace joins that net
6. If pins are on different nets, the user is prompted to merge or create a new net

---

## Net Management

- Nets are named electrical connections (VCC, GND, SIG1, NET_4, ...)
- Each net has a unique color used for rendering traces and wires
- Add custom nets via the properties panel "Add Net" button
- Assign traces to nets in the trace properties panel
- Schematic wiring automatically assigns/merges nets

---

## Layer Visibility

Toggle visibility of each layer independently via the left panel checkboxes:

| Layer | Description |
|-------|-------------|
| Top Copper | Traces and pads on the top side |
| Bottom Copper | Traces and pads on the bottom side (dashed in rendering) |
| Silk Top | Component outlines + text on top silk |
| Silk Bottom | Component outlines + text on bottom silk |
| Outline | Board outline polygon |

---

## DRC (Design Rule Check)

Click the **DRC** button to run all checks. Results appear in a panel:

- ✓ Pass (green) — no violations
- ✗ Fail (red) — errors and warnings listed with descriptions

Configurable parameters (in left panel):
- Minimum trace width (mm)
- Minimum drill diameter (mm)
- Minimum clearance between nets (mm)

---

## Export

| Format | Button | Description |
|--------|--------|-------------|
| **SVG** | "Export SVG" | Vector graphic with CSS classes for laser cutting. Includes outline, traces, holes, component outlines. |
| **DXF** | "Export DXF" | AutoCAD R2000 interchange file: PCB geometry on named layers (centerline traces, pads, drills, outline). Optional legacy POLYLINE mode for older CAM software. |
| **G-code** | "Export G-code" | GRBL file: isolate copper, drill holes, cut the board outline. |

Export options configurable in the right panel:
- Kerf width compensation (mm)
- Unit system (mm / inches) — SVG/G-code; DXF is always millimeters
- DXF format: R2000 Standard (LWPOLYLINE) or R2000 Legacy (POLYLINE/VERTEX)
- Toggle inclusion of outline, copper outlines, holes, traces, components
- CNC mill: tool diameter, isolation depth, safe Z, feed, plunge, spindle

---

## Save / Load

| Action | How |
|--------|-----|
| **Save** | "Save" button (Ctrl+S) → **Save Project** dialog → title + description → stored in browser localStorage (multiple named projects; re-saving updates the same entry, with a hint shown) |
| **Load** | "Load" button (Ctrl+O) → **Open Project** dialog → pick a saved project, or **Import from file…** (.pcb.json) |
| **Download to file** | Save Project dialog → ⬇ Download .json → saves current design as `<title>.pcb.json` |
| **Delete** | Open Project dialog → 🗑 on a row (confirmation dialog) |
| **Auto-load** | On startup: the most recently saved project is restored automatically |
| **New project** | "New" button → confirmation dialog → resets all state |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `R` | Rotate selected component / placement ghost by 90° |
| `Delete` / `Backspace` | Delete selected object |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+S` | Save project |
| `Ctrl+O` | Open project |
| `Ctrl+G` | Group selected components |
| `Ctrl+Shift+G` | Ungroup |
| `Escape` | Cancel current operation / deselect |
| `V` | Switch to Select tool |
| `T` | Switch to Trace tool |
| `O` | Switch to Outline tool |
| `S` | Switch to Text tool |
| `D` | Switch to Delete tool |

---

## Mouse Controls (Board View)

| Action | Effect |
|--------|--------|
| Left-click | Tool action (select/place/trace point) |
| Left-drag | Move selected component(s) |
| Middle-mouse drag | Pan the view |
| Middle-click | Rotate selected component 90° |
| Right-click | Context menu / finish trace / cancel |
| Scroll wheel | Zoom in/out (centered on cursor) |
| Zoom dropdown (toolbar) | Jump to exact zoom level (10–800%, 100% = real size) |
| Double-click | Finish active trace / close outline polygon |
| Ctrl+Click | Multi-select components |

---

## Mouse Controls (Schematic View)

| Action | Effect |
|--------|--------|
| Left-click pin | Start/end wire connection |
| Left-drag component | Move schematic symbol |
| Middle-mouse drag | Pan the view |
| Scroll wheel | Zoom in/out |

---

## KiCad Import

Import footprints and symbols from KiCad v6 files:

1. Click "Import KiCad" button (or drop files)
2. Supported inputs:
   - Single `.kicad_mod` file (footprint)
   - Single `.kicad_sym` file (symbol library)
   - `.zip` archive containing a full KiCad footprint/symbol package
3. Imported parts appear in the component palette
4. Custom definitions are saved with the project (`importedDefs` field)

The `PCBLib/` directory is auto-scanned on load if the app is served over HTTP (not file://).

