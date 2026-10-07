# Plan: Connect Board View ↔ Schematic View

## Overview
Transform the schematic from a passive auto-layout preview into an interactive view that shares state with the board. Wires drawn in the schematic create real net connections (traces) in the board model, and component positions persist across both views.

---

## Data Model Changes

### Component object — new fields
```js
{
  id, type, x, y, rotation, layer, size, value,   // existing (board coords, mm)
  schemX: 0,    // NEW — schematic world X (pixels in schematic space)
  schemY: 0     // NEW — schematic world Y (pixels in schematic space)
}
```

### App state — new fields
```js
view: {
  // ... existing fields ...
  schemZoom: 1, schemPanX: 0, schemPanY: 0  // NEW
}

interaction: {
  // ... existing fields ...
  schemWireStart: null,      // NEW — { compId, pinIndex } first pin of wire
  schemDraggingComp: null,   // NEW — component being dragged in schematic
  schemHoveredPin: null      // NEW — { compId, pinIndex, x, y } cursor feedback
}
```

### Trace object — no change needed
Traces already have `points[]` (board mm coords) and `net`. Schematic wires create traces with points at connected pin positions.

---

## Phase 1: Persistent Schematic Positions

**Goal:** Components remember their schematic position across view switches, save/load.

### Tasks
1. **Auto-assign `schemX`/`schemY`** on first placement or load
   - Grid positions: rows of 4, 200px H / 150px V spacing
   - If already set, don't reassign
   - File: `js/app.js` → `placeComponent()`

2. **Use stored positions in schematic render**
   - Replace auto-layout grid calc with `comp.schemX` / `comp.schemY`
   - Apply pan/zoom transform before drawing
   - File: `js/schematic-view.js` → `render()`

3. **Save/load** — already works (components serialized as full objects)

4. **Migration for existing saves**
   - On load, if component lacks `schemX`/`schemY`, auto-assign grid position
   - File: `js/app.js` → after load, fill missing values


---

## Phase 2: Schematic Interactivity (Pan/Zoom + Drag)

**Goal:** User can pan, zoom, and drag components in the schematic view.

### Tasks
1. **Bind mouse events to `schematicCanvas`**
   - New method `bindSchemCanvasEvents()` in `app.js`
   - Called from `init()` alongside `bindCanvasEvents()`
   - Events: `mousedown`, `mousemove`, `mouseup`, `wheel`

2. **Schematic pan/zoom**
   - Middle-mouse or Alt+drag → pan (`schemPanX`, `schemPanY`)
   - Mouse wheel → zoom (`schemZoom`, clamped 0.2–5)
   - Coordinate helpers:
     ```js
     schemScreenToWorld(sx, sy) { ... }
     schemWorldToScreen(wx, wy) { ... }
     ```

3. **Drag components in schematic**
   - Left-click on component body → start drag
   - Move → update `comp.schemX`, `comp.schemY` (free placement, no grid snap)
   - Release → save state
   - Hit-test: click within ~60x40px of component center

### Files touched
- `js/app.js` — event binding, pan/zoom state, drag logic, coord helpers
- `js/schematic-view.js` — render with transform, highlight while dragging

---

## Phase 3: Wire Drawing → Net Connections

**Goal:** Click two pins in schematic to create a wire (net connection) that also appears as a trace in the board model.

### Tasks
1. **Pin hit-testing in schematic**
   - During render, compute screen positions of all component pins
   - Store in `app.interaction.schemPinPositions = [{ compId, pinIndex, x, y }]`
   - On click, find nearest pin within 10px threshold

2. **Wire drawing interaction**
   - Click pin A → set `schemWireStart`, show rubber-band line to cursor
   - Click pin B → create connection:
     - Determine net (prompt if different, auto-assign if new)
     - Create trace: `{ id, points: [pinA_boardPos, pinB_boardPos], width, net, layer }`
     - Pin board positions use existing rotation math: `comp.x + pin.x*cos - pin.y*sin`
   - Click empty space or Escape → cancel wire drawing

3. **Wire rendering in schematic**
   - Orthogonal wires (L-shaped) between connected pins
   - Color by net (reuse existing `nets[]` colors)
   - Replace crude `findNearestComp` approach with proper pin-to-pin mapping

4. **Net assignment logic**
   - Both pins have net → must match or prompt
   - One pin has net → assign to other
   - Neither → auto-assign next available (NET_1, NET_2...)

5. **Delete wire in schematic**
   - Click wire to select → Delete key removes corresponding trace from board model


---

## Phase 4: Bidirectional Sync & Highlight

**Goal:** Selecting/hovering an object in one view highlights it in the other when switching back.

### Tasks
1. **Preserve selection across view switch**
   - `interaction.selectedObject` is already shared — ensure schematic renders it highlighted
   - File: `js/schematic-view.js` — draw highlight on selected component

2. **Cross-view trace highlighting**
   - Trace selected in board → corresponding wire highlighted in schematic
   - Wire clicked in schematic → selects the corresponding trace (visible in board)

3. **Component reference labels**
   - Auto-assign designators: R1, C2, U1, D1... based on type + counter
   - Display label in both views next to component
   - File: `js/app.js` — auto-label on placement; both views render label

### Files touched
- `js/schematic-view.js` — highlight rendering, labels
- `js/board-view.js` — minor (already highlights selection)
- `js/app.js` — label assignment logic

---

## Phase 5: Component Rotation Completeness

**Goal:** Full rotation workflow in both views (keyboard shortcut, schematic rendering, place-time rotation).

### Current state
- `comp.rotation` field exists (0/90/180/270)
- Board view renders rotated components correctly
- Properties panel has rotation dropdown
- `App.rotateObj(id, rot)` works
- Export (SVG/DXF) applies rotation via `rotatePoint()`

### Missing tasks
1. **`R` key shortcut** — rotate selected component +90° (wraps 270→0)
   - In `handleKeydown()`: if `e.key === 'r' && !e.ctrlKey` and a component is selected → call `rotateObj(id, (rotation+90)%360)`
   - Also work while placing: rotate `placingComponent` preview orientation before drop
   - File: `js/app.js`

2. **Schematic symbol rotation**
   - Apply `comp.rotation` when drawing schematic symbols (ctx.rotate around component center)
   - Pins swap positions on 90°/180° rotation — affects pin hit-testing for wire drawing
   - File: `js/schematic-view.js`

3. **Rotate while placing**
   - While `placingComponent` is active, pressing R changes the pending rotation (cycle 0→90→180→270)
   - Show rotated ghost/preview on canvas before drop
   - Store in `interaction.placingRotation` (default 0)
   - On drop, assign to new component's `rotation` field
   - File: `js/app.js`, `js/board-view.js` (ghost rendering)

4. **Schematic drag respects rotation**
   - Hit-test for schematic drag must account for rotated symbol bounds
   - Pin positions in `schemPinPositions[]` must be computed post-rotation
   - File: `js/schematic-view.js`, `js/app.js`

### Files touched
- `js/app.js` — R key handler, placing rotation state, rotateObj on select
- `js/schematic-view.js` — rotated symbol rendering, pin positions after rotation
- `js/board-view.js` — ghost preview with rotation while placing

---

## Implementation Order & Dependencies

```
Phase 1 (positions) ──► Phase 2 (interactivity) ──► Phase 3 (wires) ──► Phase 4 (sync)
                                                                    │
                                                          Phase 5 (rotation) ◄┘
                                                                  
Phase 6 (shortcuts) — independent, can be done anytime after Phase 1
```

- Phase 1 first (Phase 2 needs stored positions to drag)
- Phase 2 before Phase 3 (need pan/zoom + hit-testing for wire drawing)
- Phase 3 is the core "connection" feature
- Phase 4 is polish, can be done last
- Phase 5 (rotation) can run in parallel with Phase 3/4 since it's mostly additive
- Phase 6 (shortcuts) is independent — just expands `handleKeydown()`, no dependency on schematic work

---

## Testing Checklist

### Phase 1
- [ ] Place component in board → switch to schematic → appears at grid position
- [ ] Switch back and forth → position stable
- [ ] Save → reload → positions preserved
- [ ] Load old save (no schemX/schemY) → auto-assigned, no crash

### Phase 2
- [ ] Middle-mouse drag pans schematic
- [ ] Mouse wheel zooms centered on cursor
- [ ] Left-click + drag moves component in schematic
- [ ] Dropped position persists after view switch
- [ ] Zoom/pan state preserved across switches

### Phase 3
- [ ] Click pin R1 → rubber band follows → click pin C2 → wire appears
- [ ] Wire colored by net
- [ ] Switch to board → trace exists connecting those pins
- [ ] Multiple wires from same pin (fan-out) work
- [ ] Click wire → select → Delete key removes trace from board
- [ ] Same-component pin-to-pin → rejected or warned
- [ ] Escape cancels wire drawing

### Phase 4
- [ ] Select component in board → switch to schematic → highlighted
- [ ] Select trace in board → switch to schematic → wire highlighted
- [ ] Labels (R1, C2...) visible in both views

### Phase 5
- [ ] Select component → press R → rotates 90° clockwise
- [ ] Press R four times → back to original orientation
- [ ] While placing component, press R → ghost preview rotates before drop
- [ ] Rotated component in schematic shows symbol rotated correctly
- [ ] Pin hit-testing works on rotated schematic symbols (pins on correct side)
- [ ] Trace endpoints follow pins after rotation change (properties panel or R key)

---

## Risks / Open Questions

| Item | Notes |
|------|-------|
| Schematic coordinate space | Pixels (not mm). Fine for now; switch to abstract units if multi-sheet needed. |
| Wire routing | Orthogonal L/Z paths only. No auto-router. User drags components to reduce crossings. |
| Pin mapping accuracy | Pins defined in component-local mm. In schematic drawn at fixed symbol positions. Need: `pinIndex → symbol pin position`. |
| Trace points from schematic | Endpoints are actual pin world positions (mm). Intermediate routing left to user in board view. |
| Multiple nets per pin | A pin belongs to one net only. Conflict → prompt for resolution. |

---

## Phase 6: Keyboard Shortcuts & Bindings

**Goal:** Complete, discoverable keyboard workflow matching standard PCB editor conventions.

### Current state
Only 10 bindings exist (Ctrl+Z/Y/S/O, Enter, Escape, V/T/O/S/D tool keys).
The `via` tool has NO keyboard shortcut. No copy/paste, no nudge, no zoom keys.

### Complete shortcut table to implement

| Key | Action | Implementation notes |
|-----|--------|---------------------|
| **R** | Rotate selected comp +90° | Phase 5 — `rotateObj(id, (rot+90)%360)` |
| **Del / Backspace** | Delete selected object | Call existing `deleteObject()` on `selectedObject` |
| **Ctrl+C** | Copy selected component | Store in `interaction.clipboard = { ...comp }` (deep copy) |
| **Ctrl+V** | Paste copied at cursor/grid | Clone with new ID, offset by grid*2 from source |
| **Ctrl+D** | Duplicate at 1-grid offset | Like paste but auto-offset, no clipboard needed |
| **Arrow keys** | Nudge selected comp by grid size | `moveObj(id, x±grid, y±grid)` — hold Shift for 5x |
| **F / Home** | Fit to view | Call existing `fitToView()` |
| **+ / =** | Zoom in (×1.25) | Same as button: `zoom * 1.25` |
| **- / _** | Zoom out (÷1.25) | Same as button: `zoom / 1.25` |
| **0** | Zoom to 100% | Set `view.zoom = 1` |
| **B** | Switch active layer top↔bottom | Toggle `view.activeLayer` between 'top'/'bottom' |
| **Tab** | Cycle visible layers | Next/prev in layer list, Shift+Tab reverses |
| **G** | Cycle grid size (0.5→1→2→5→10mm) | Update `params.gridSize`, show in status bar |
| **P** | Switch to via tool | Add `'p': 'via'` to keyMap |
| **M** | Mirror selected comp (flip layer) | Toggle comp.layer top↔bottom, flip Y pin offsets |
| **Ctrl+A** | Deselect all | `selectedObject = null`, render |
| **Ctrl+N** | New project (with confirm) | Confirm dialog → `newProject()` |
| **H / F1** | Show shortcut help overlay | Toggle a small panel listing all bindings |

### Implementation tasks
1. **Expand `handleKeydown()` in app.js**
   - Add all new key checks before the tool keyMap (so they take priority)
   - Guard: ignore shortcuts when focus is in an `<input>` element (`e.target.tagName === 'INPUT'`)
   - Use `e.preventDefault()` for all bound keys to prevent browser defaults

2. **Copy/Paste state**
   - Add `interaction.clipboard = null` to app state
   - Ctrl+C: deep-clone selected component (excluding id)
   - Ctrl+V: paste at current mouse position (snapped to grid), assign new id
   - Track last mouse world position for paste location

3. **Nudge with arrows**
   - Only works when a component is selected and tool is 'select'
   - `shiftKey` → 5× grid multiplier for larger moves
   - Call existing `moveObj()` which handles trace endpoint updates

4. **Layer cycling (Tab / B)**
   - Tab: cycle through visible layer list, update checkboxes + activeLayer
   - B: quick toggle top↔bottom only

5. **Grid cycling (G)**
   - Fixed set: [0.5, 1, 2, 5, 10] mm — cycle forward on each press
   - Update `params.gridSize` + status bar text

6. **Help overlay (H or F1)**
   - Small semi-transparent panel listing all shortcuts
   - Toggle on/off, dismiss with Escape or click elsewhere
   - Can be a simple div in the HTML, toggled via JS
   - File: `index.html` (add hidden div), `js/app.js` (toggle logic)

### Files touched
- `js/app.js` — expanded `handleKeydown()`, clipboard state, nudge, layer/grid cycling
- `index.html` — shortcut help overlay div
- `css/style.css` — help panel styling

### Testing
- [ ] Each key binding works and doesn't conflict with browser shortcuts
- [ ] Shortcuts ignored when typing in input fields (properties panel)
- [ ] Del deletes selected comp/trace/via correctly
- [ ] Ctrl+C then Ctrl+V creates a copy at cursor position
- [ ] Arrow keys nudge by exactly one grid step
- [ ] F fits view, +/- zooms, 0 resets to 100%
- [ ] B toggles layer, Tab cycles layers
- [ ] G cycles grid size with status bar update
- [ ] P activates via tool
- [ ] H/F1 shows help overlay, Escape dismisses it

---

## Files Summary

| File | Changes |
|------|---------|
| `js/app.js` | Schem view state, coord helpers, schematic event binding, wire creation, net assignment, drag, save/load migration, labels, expanded keyboard shortcuts, clipboard, nudge, layer/grid cycling |
| `js/schematic-view.js` | Use stored positions, transform, pin tracking, proper wire rendering, rubber-band, selection highlight, labels, rotated symbols |
| `js/board-view.js` | Ghost preview with rotation while placing; ensure traces from schematic render correctly |
| `index.html` | Shortcut help overlay div |
| `css/style.css` | Help panel styling, cursor styles for schematic canvas |

| File | Changes |
|------|---------|
| `js/app.js` | Schem view state, coord helpers, schematic event binding, wire creation, net assignment, drag, save/load migration, labels |
| `js/schematic-view.js` | Use stored positions, transform, pin tracking, proper wire rendering, rubber-band, selection highlight, labels |
| `js/board-view.js` | Minor: ensure traces from schematic render correctly (should already work) |
| `index.html` | No changes expected |
| `css/style.css` | Cursor styles for schematic canvas if needed |