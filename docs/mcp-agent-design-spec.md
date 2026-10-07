# MCP design workflow — implementation spec

Acceptance fixture: the 10-LED dimmer board. One header, ten 470 Ω resistors, ten trimmers, ten LEDs, a VCC rail, a GND rail, and a wiper tie on each trimmer.

Coordinates stay board millimetres, origin at board center, Y down.

## Where the bugs live

| What the agent hit | Where it is decided |
|---|---|
| A pin is on a net only when it sits within 0.15 mm of a trace’s first or last point. A drop that lands mid-rail is electrically invisible. | `ProjectApi.getPinNet` in `js/project-api.js` |
| GND quality uses the same endpoint rule (0.2 mm) and does not join two traces that touch along a segment. The autorouter does join those traces. | `Plan.netConnectivity` in `js/plan.js` vs `Autoroute.planNets` / `_tracesTouch` in `js/autorouter.js` |
| The schematic draws a wire only between `schemEnds[0]` and `schemEnds[1]`, or the first and last copper point. Intermediate pins on one polyline never appear. | `SchematicOps._rebuildSchemWireCache` in `js/schematic-ops.js` |
| `connect_pins` stores a straight segment `[pinA, pinB]`. The tool text says it draws an L. It also throws if both pins belong to one component. | `ProjectApi.connectPins` in `js/project-api.js` |
| `place_by_plan` sorts a zone by current `x`, then offsets every other part by ±12% of the zone height. It does not pair R1 with D1. | `Plan.placeByPlan` in `js/plan.js` |
| `add_component` returns `{id, label, type, x, y, rotation}` and no pin coordinates. | `millpcb_add_component` in `mcp/server.mjs` |
| With no copper, `Autoroute.isFullyWired` is true (`groups.size < 2`), so workflow marks `route` and `qualityCheck` as pass. DRC then reports a floating pin on every pad. | `isFullyWired` in `js/autorouter.js`; `millpcb_workflow` in `mcp/server.mjs` |
| The schematic PNG is not the browser schematic. It draws a board-sized box at each `schemX/schemY` and a line between centers, then scales that box into `maxSize`. A 2000-unit sheet makes every part a few pixels. | `renderSchematicPng` in `mcp/render.mjs` |

One tolerance constant. Today there are two: `0.15` (`getPinNet`, `Autoroute.NET_TOUCH`) and `0.2` (`Plan.netConnectivity`). Use `Autoroute.NET_TOUCH` (0.15 mm) everywhere a pad is tested against copper.

Build in this order. Each step is usable before the next exists.

1. Netlist plus the connectivity fix
2. `route_rail`
3. Pin returns and batch place
4. Circuit check and the workflow rule
5. Schematic PNG

## 1. Stored netlist

Add `project.netlist`, a map of net name to pin refs:

```json
{
  "VCC":  [{ "compId": 2, "pin": "1" }, { "compId": 3, "pin": "1" }],
  "DIM1": [{ "compId": 13, "pin": "1" }, { "compId": 13, "pin": "2" }, { "compId": 24, "pin": "A" }]
}
```

`getPinNet` reads this first. A pin listed here is on that net even when no copper touches it. Geometry remains the fallback for old boards that have no `netlist`.

Same-component pins are legal in the netlist. That is the trimmer wiper (pins `"1"` and `"2"` of one pot on `DIM1`). `connectPins` and `createSchemWire` should allow it when the two pin indexes differ. Keep the error only for the same pin connected to itself.

### Tool `millpcb_set_netlist`

```json
{
  "nets": {
    "VCC": [{ "compId": 2, "pin": "1" }, { "compId": 3, "pin": "1" }]
  },
  "mode": "merge"
}
```

`mode` is `merge` (default) or `replace`. Reject unknown `compId`, unknown pin name, and a pin that already belongs to a different net. Return `{ nets, pinCount, revision }`.

This call lays no copper. After it, `millpcb_autoroute` must see those pins as members. `planNets` currently discovers members only through `getPinNet`, so the netlist read has to land there. `skipRouted` stays true: a net whose copper already joins every listed pin is skipped.

### Schematic

For each net, draw one orthogonal wire from every listed pin to every other listed pin, using existing `SchematicLayout.route`. Do this from `netlist`, not from copper endpoints. A rail of ten resistors then shows ten pins on VCC whether the copper is one polyline or ten segments.

## 2. `millpcb_route_rail`

Lays the copper for one net that is already in the netlist, or creates the netlist entries as it routes.

```json
{
  "net": "VCC",
  "pins": [{ "compId": 2, "pin": "1" }, { "compId": 3, "pin": "1" }],
  "edge": "top",
  "width": 0.6,
  "stub": 2
}
```

`edge` is `top | bottom | left | right`. Optional `at` is an explicit rail coordinate in mm (board center, Y down) and overrides `edge`.

Algorithm:

1. Resolve every pin with `ProjectApi.pinWorld`. Fail the whole call if any pin is missing. Do not leave a partial rail.
2. Sort along the rail. Top and bottom sort by `x` ascending. Left and right sort by `y` ascending.
3. Rail coordinate. For `top`, `railY = min(pin.y) - stub`, clamped so the stroke stays inside the board by `width/2 + minClearance`. Same idea for the other three edges. `stub` defaults to 2 mm.
4. For each consecutive pair `(A, B)` append one trace whose **endpoints are the pins**:
   - horizontal rail: `A → (A.x, railY) → (B.x, railY) → B`
   - vertical rail: `A → (railX, A.y) → (railX, B.y) → B`
5. Set `schemEnds` to the two pins on every segment. Set `net`. Add both pins to `project.netlist[net]`.
6. Return `{ net, traces: [{id, points}], rail: {x or y}, revision }`.

Because each segment starts and ends on a pin, `getPinNet`, `Plan.netConnectivity`, and the schematic all agree. Overlapping same-net copper on the rail is acceptable.

Also fix `Plan.netConnectivity` to use the autorouter’s union: a pad within `NET_TOUCH` of any vertex **or** any segment joins that trace, and two same-net traces join when an endpoint of one lies within `NET_TOUCH` of a segment of the other. Report every split net, not only `GND`.

## 3. Orthogonal `connect_pins`

Add `style: "ortho" | "straight"`. Default `ortho`.

When the two pins share `x` or `y` within 0.05 mm, one segment is enough. Otherwise store three points: `A → elbow → B`. Prefer the elbow `(A.x, B.y)`. Use `(B.x, A.y)` when the first elbow leaves the board. Set `schemEnds`. Allow two different pins of one component (the wiper tie): `A → (A.x, B.y) → B`, which is the hook beside the pot.

Update the tool description. It currently promises an L path and the function stores `[pa, pb]`.

## 4. Pin coordinates and columns

`millpcb_add_component` and `millpcb_place_by_plan` return pins:

```json
{
  "id": 3,
  "label": "R1",
  "x": -35,
  "y": -18,
  "rotation": 90,
  "pins": [
    { "name": "1", "x": -35, "y": -20.54 },
    { "name": "2", "x": -35, "y": -15.46 }
  ]
}
```

Those `x/y` are `pinWorld` values. Round to 0.001 mm in the response so the agent does not re-derive rotation.

### `millpcb_add_components`

Takes `{ parts: [ same fields as add_component, plus optional "key" ] }` and runs inside one `session.mutate`. One id sequence, one label sequence. Return the parts in request order, each with `key` echoed back. Parallel single adds are what put D1 in the R2 column.

### `place_by_plan` groups

Extend the plan:

```json
"groups": [
  { "key": "1", "members": [3, 13, 24] },
  { "key": "2", "members": [4, 14, 23] }
]
```

Member ids are component ids. Each group has one index along the flow. Inside a zone, a member is placed at that group’s along-axis coordinate, on the zone’s cross-axis center. `stagger` defaults to `false`. The existing ±12% offset (`plan.js`, `cross * 0.12`) applies only when `stagger: true` and the zone has no groups.

Order groups by `key` with a natural sort (`1, 2, … 10`, not `1, 10, 2`). Zones without groups keep today’s spread, but sort by label with that same natural sort instead of by current `x`.

Dry-run (`apply: false`) returns the same pin list the apply would, so the agent can check columns before moving parts.

## 5. `millpcb_circuit_check`

Read-only. Input is the contract; it does not infer the circuit.

```json
{
  "rails": {
    "VCC": [{ "compId": 2, "pin": "1" }, { "compId": 3, "pin": "1" }],
    "GND": [{ "compId": 2, "pin": "2" }, { "compId": 24, "pin": "K" }]
  },
  "branches": [
    {
      "name": "LED1",
      "series": [
        [{ "compId": 3, "pin": "2" }, { "compId": 13, "pin": "3" }],
        [{ "compId": 13, "pin": "1" }, { "compId": 24, "pin": "A" }]
      ],
      "ties": [{ "compId": 13, "pins": ["1", "2"] }]
    }
  ]
}
```

For each rail, every listed pin must be on that net and in one copper group (`Plan.netConnectivity(...).groups === 1`). For each series pair, both pins must share one net and one copper group. Each tie must be the same net on those pins of that component. Return `violations[]` in the existing DRC shape: `{ type, severity, msg }` with types `rail-split`, `branch-open`, `tie-open`, `wrong-net`.

`millpcb_workflow` grows a `circuit` step between `route` and `qualityCheck`. Empty input means the step is `todo`, not pass.

## 6. Schematic screenshot

`renderSchematicPng` should call the same layout the browser uses (`SchematicLayout` + `SchematicOps.getSchemWirePoints`), not center-to-center lines.

Frame the symbol bounds, not the component centers. Pad the bounds by 40 schematic units. Scale so the shorter side of a resistor glyph is at least 24 px. If that makes the image larger than `maxSize`, split into a contact sheet of columns rather than shrinking the whole sheet into a corner. Draw the label (`R1`, `RV1`, `D1`) beside each glyph.

Optional arguments on `millpcb_screenshot`:

- `crop: { x, y, w, h }` in schematic units
- `columns: true` to render one branch per image

Default framing must make a 10-branch sheet readable at `maxSize: 1200` without a crop.

`layout_schematic` for a repeated series: when the netlist has N branches that share a rail, place branch `i` at `x = 200 + i * 220`, parts stacked on Y (resistor, trimmer, LED), rails as a top and bottom bus. Board `x/y` stay untouched.

## 7. Workflow empty-board rule

In `millpcb_workflow`, `route` is `todo` when the board has components and zero physical traces (`schemWire` excluded). `qualityCheck` is `todo` in that same case, not `pass`.

`isFullyWired` may stay as it is for a net that truly has fewer than two pads. The false pass comes from `planNets` returning no nets when nothing has copper yet.

`next` should point at `route` while any non-NC pin is in `planNets` diagnostics as `UNASSIGNED_PIN`. Floating-pin DRC already catches this; the workflow should surface it before export.

## 8. Imported library visibility

Current behavior, two different audiences.

**Agent / MCP process.** `millpcb_import_kicad_text` validates the footprint, calls `KicadImport.registerEntries` on the server `ComponentDefs`, and writes `.mcp/library/<key>.kicad_mod` (`mcp/library.mjs` `persistFootprint`). The next server start reloads those files (`loadPersistentLibrary` in `mcp/server.mjs`). `millpcb_list_footprints` and `millpcb_add_component` see the new type in this session and in later sessions. `millpcb_import_kicad` (a path inside the repo) registers for the current process only. It does not call `persistFootprint`.

**Live preview and the component palette.** They do not see the new type.

- `registerEntries` injects an “Imported (KiCad)” palette row only when `document` exists (`js/kicad-import.js` `_injectPaletteItem`). The MCP kernel is headless, so that call returns immediately.
- Placing the part broadcasts the project (`applyProject` in `js/agent-preview.js`). The component JSON includes copied `pins`, but the body is drawn from `App.getCompSize`, which looks up `ComponentDefs` **in the browser** (`js/app-core.js`).
- `BoardView.drawComponent` returns without drawing when that lookup fails (`js/board-view.js`). Pads, courtyard, and silk of an agent-imported footprint are absent on the live board.
- `millpcb_screenshot` (`renderBoardPng` in `mcp/render.mjs`) uses the server `ProjectApi`, so the PNG can show the footprint while the preview tab does not.

To make a newly imported part visible when it is used, the preview has to receive the def, not only the placed component:

1. On `millpcb_import_kicad_text` and `millpcb_import_kicad`, broadcast a `library` event with the registered def (key, sizes, pins, kicad pad geometry, optional `symGraphics`).
2. The preview handler registers that def with `KicadImport.registerEntries` in the browser. That fills `ComponentDefs` and adds the palette row, so `drawComponent` and the schematic symbol resolve.
3. On preview connect (`hello` / `GET /api/project`), include the server’s imported defs (anything with `kicadImported`, including `.mcp/library` reloads) so a refresh does not drop them.
4. Keep drawing from the browser `ComponentDefs` after that registration. The component’s copied `pins` stay the fallback for pad centers; courtyard and silk still need the size record.

Until that broadcast exists, “imported” means the agent can place it and a server PNG can draw it. The live view stays blank for that part.

## Tests

Add cases next to `tests/project-api.test.js`, `tests/plan.test.js`, `tests/autorouter.test.js`, and `tests/schematic-layout.test.js`.

1. A horizontal polyline that visits R1, R2, and R3 only at interior vertices: `getPinNet(R2.1)` is `VCC`, and `netConnectivity("VCC").groups` is 1.
2. `route_rail` of ten pins yields nine traces, each with `schemEnds` on a consecutive pair, and both checks above pass.
3. `connectPins` on two pins of one pot returns a 3-point orthogonal trace and does not throw.
4. `placeByPlan` with ten groups puts member 0 of every group on one X, member 1 on a second X, with equal Y inside a zone when `stagger` is omitted.
5. `addComponents` of ten LEDs returns labels `D1`…`D10` in request order.
6. Workflow on a placed, unwired board reports `route: todo`.
7. `circuit_check` on the dimmer netlist returns `[]` after `route_rail` plus the branch and wiper traces, and returns `branch-open` when one wiper tie is removed.
8. Schematic PNG of that board has a non-background pixel run wider than half the image (the sheet is not a corner blob).
9. After `import_kicad_text`, a preview snapshot includes the new def, and `getCompSize` on a placed instance of that type returns the KiCad size (courtyard and pads), not `null`.
