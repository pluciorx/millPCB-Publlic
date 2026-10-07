# MillPCB Autorouting Mechanism

> **Repo conformance (validated 2026-09-11).** This spec is a design-intent document. Where it conflicts with the millPCB codebase, the codebase wins; patched sections note this inline. Binding constraints:
> - No build step, no module system — flat `js/*.js`, global singletons (AGENTS.md). No classes/interfaces/C#-style abstractions; pure functions on plain project objects (`ProjectApi` pattern).
> - Net membership is **derived geometrically** (`ProjectApi.getPinNet`: trace endpoint within 0.15 mm of a pin ⇒ pin inherits `trace.net`). There is no explicit pin→net assignment in the data model (§4 patched).
> - `vias` are **unplated drilled holes** for hand-soldered wire jumpers — they connect nothing electrically. V1 routing is single-layer; vias are obstacles, not endpoints (§5 patched).
> - Defaults must respect DRC floors: `params.minTraceWidth = 0.38`, `params.minClearance = 0.38` (§6 patched).
> - Milling rules already exist as `export.mill*` + `gcode.js` — no new `ManufacturingRules` service (§7 patched).
> - No Web Worker: the app must keep working from `file://` (§53 patched).
> - Lean implementation spine: `_bmad-output/planning-artifacts/architecture/architecture-autorouting-2026-09-11/ARCHITECTURE-SPINE.md`.

## 1. Purpose

Implement an automatic PCB routing mechanism for MillPCB that connects electrical nets between pads/pins while respecting PCB geometry, milling constraints, clearances, board boundaries, and existing copper/traces.

The router must generate deterministic, manufacturable toolpaths suitable for PCB milling.

The primary objective is:

> Given a PCB layout containing board dimensions, pads, holes, components, nets and routing constraints, automatically generate valid copper traces connecting all electrically connected endpoints without violating manufacturing constraints.

The router is **not** responsible for generating G-code. It produces logical/geometry-level traces that can later be converted into milling toolpaths.

---

# 2. Design Principles

The autorouter must follow these principles:

1. **Deterministic**
   - Same input + same configuration = same routing result.
   - No dependency on LLMs or external services.

2. **Geometry-first**
   - All routing decisions are based on geometric constraints.
   - Electrical connectivity is represented separately from geometry.

3. **Manufacturing-aware**
   - Minimum trace width.
   - Minimum clearance.
   - Milling tool diameter.
   - Board edge clearance.
   - Hole/pad clearance.
   - Optional copper isolation requirements.

4. **Incremental**
   - Router should be able to route one net at a time.
   - Failed nets must not invalidate successful routes.

5. **Interactive**
   - User should be able to manually route some connections and let autorouting handle the rest.

6. **Explainable**
   - Router should report why a net could not be routed.

7. **Extensible**
   - Architecture must allow multiple routing algorithms later.

---

# 3. Input

The autorouter receives a `RoutingBoard` model.

Conceptually:

```text
RoutingBoard
 ├── BoardOutline
 ├── Layers
 ├── Pads
 ├── Holes
 ├── Components
 ├── Nets
 ├── ExistingTraces
 └── RoutingRules
```

## 3.1 Board outline

```text
BoardOutline
 ├── width
 ├── height
 └── polygon
```

The board may eventually support arbitrary polygons, therefore routing must not assume a rectangular board.

---

# 4. Electrical Model

Each electrical connection belongs to a `Net`.

Example:

```text
Net: GND
 ├── U1.GND
 ├── C1.2
 ├── C2.2
 └── J1.3
```

A net may contain:

- 2 endpoints
- multiple endpoints
- pads
- manually created connection points (trace endpoints)

**Repo conformance:** millPCB has no explicit pin→net assignment. Membership is *derived*: a pin belongs to the net of any trace whose endpoint lies within 0.15 mm of the pin (`ProjectApi.getPinNet`). The router derives net membership this way and routes only pins whose inferred net has ≥ 2 members with at least one unconnected pin. `vias` are unplated holes (wire jumpers) and are **not** net endpoints in V1 — they are obstacles.

---

# 5. Routing Endpoint

Each endpoint contains:

```text
RoutingEndpoint
 ├── id
 ├── netId
 ├── position
 ├── padShape
 ├── padSize
 ├── layer
 └── allowedConnectionArea
```

The router must consider the entire pad geometry rather than treating every pad as a mathematical point.

**Repo conformance:** endpoint data is derived, not stored — world position from `ProjectApi.pinWorld(project, compId, pin)` (rotation-aware), pad shape/size from `ComponentDefs` (SMD = rect, TH = circle with pitch-based radius). `layer`: V1 routes on a single layer per run (default `'top'`); there is no plated-via layer crossing in millPCB.

---

# 6. Routing Rules

The following parameters must be configurable.

```text
RoutingRules
 ├── traceWidth
 ├── minimumClearance
 ├── boardEdgeClearance
 ├── minimumHoleClearance
 ├── minimumPadClearance
 ├── gridSize
 ├── routingAngleMode
 ├── maximumTraceLength
 ├── maximumBends
 └── allowedLayers
```

Example (values at/above millPCB DRC floors):

```text
traceWidth = 0.50 mm        (project default; must be >= params.minTraceWidth 0.38)
minimumClearance = 0.38 mm  (= params.minClearance floor)
boardEdgeClearance = 0.30 mm
routingGridSize = 0.10 mm   (routing grid — NOT params.gridSize, which is the 1.0 mm draw snap)
routingAngleMode = 45_DEGREE
```

**Repo conformance:** rules are read from the project (`params`, `export`) rather than a separate configuration store; routing options may persist as an optional `params.autoroute` object (migrated on load, per the backward-compatibility rule).

---

# 7. Milling Constraints

MillPCB is intended for PCB milling rather than conventional PCB fabrication.

The routing engine therefore must support:

```text
MillConstraints
 ├── toolDiameter
 ├── isolationWidth
 ├── minimumTraceWidth
 ├── minimumClearance
 └── edgeClearance
```

The effective copper clearance must account for the milling tool.

For example:

```text
effectiveClearance =
    requestedClearance + toolDiameter / 2
```

**Repo conformance:** do NOT create a new `ManufacturingRules` service — milling rules already exist as `export.millToolDia` / `millDrillToolDia` / … and are consumed by `gcode.js`. The router reads those same fields (e.g. warn when the routed gap is < `export.millToolDia`, since the isolation tool must fit between copper) and does not duplicate them.

---

# 8. Routing Representation

Internally, traces should be represented as a sequence of connected segments.

```text
Trace
 ├── netId
 ├── width
 └── segments[]
```

Each segment:

```text
TraceSegment
 ├── startPoint
 ├── endPoint
 └── width
```

The initial implementation should support:

- horizontal segments
- vertical segments
- 45° segments

Future implementations may support arbitrary angles.

**Repo conformance:** the output is committed as a plain polyline via `ProjectApi.addTrace({ points, net, width, layer })` — the existing trace model (`points[]`, per-segment `segmentWidths`, optional `curved`) already supports everything the router emits and more. Do not introduce a parallel `segments[]` representation.

---

# 9. Routing Grid

The first implementation should use a **discrete routing grid**.

Example:

```text
gridSize = 0.10 mm
```

Every routing node is mapped to the grid.

```text
(x, y) -> GridNode
```

A grid node contains:

```text
GridNode
 ├── x
 ├── y
 ├── blocked
 ├── cost
 ├── parent
 └── state
```

Possible states:

```text
FREE
BLOCKED
START
TARGET
ROUTED
```

**Repo conformance:** board coordinates are mm with origin at the **board center** and **Y-down**. Grid index mapping: `ix = floor((x + board.width/2) / gridSize)`, `iy = floor((y + board.height/2) / gridSize)` (plus `boardEdgeClearance` inset). For memory, implement nodes as typed arrays (`Uint8Array` state, `Int32Array` parent, cost array) rather than one object per node — a 100×80 mm board at 0.1 mm is ~800k cells.

---

# 10. Obstacle Generation

Before routing, construct an obstacle map.

Obstacles include:

- existing traces
- pads belonging to other nets
- holes
- board edges
- component keep-outs
- user-defined keep-outs

The obstacle geometry must be expanded by the required clearance.

Conceptually:

```text
obstacle =
    geometry
    expanded by
    (traceWidth / 2 + clearance)
```

This is critical.

The router should never perform raw point-to-point collision testing without considering trace width.

---

# 11. Same-Net Geometry

Pads and traces belonging to the same net should generally not be treated as obstacles.

Example:

```text
NET_A pad
      |
      | allowed
      |
NET_A trace
```

But the router must still prevent unintended shorts between different nets.

---

# 12. Routing Algorithm

The initial autorouter should use:

## A* Pathfinding

A* is recommended because it provides:

- deterministic routing
- relatively simple implementation
- good performance
- configurable cost function
- easy debugging
- support for routing preferences

**Repo conformance:** no class/interface hierarchy — the repo is flat vanilla JS. The algorithm is a pure function in `js/autorouter.js`; selection is an options field (`options.algorithm`, default `'astar'`). Future implementations (Lee, Dijkstra, congestion routers) are added as sibling functions sharing the grid + obstacle API.

---

# 13. A* Cost Function

The cost function should not simply minimize distance.

Recommended cost:

```text
totalCost =
    distanceCost
  + bendCost
  + proximityCost
  + congestionCost
  + edgeCost
  + manufacturingCost
```

Initial implementation:

```text
movementCost
+
bendPenalty
```

Example:

```text
straight movement = 1.0
45° movement      = 1.414
bend penalty      = 5.0
```

This encourages short and smooth traces.

---

# 14. Routing Preferences

The router should prefer:

1. shortest valid path
2. fewer bends
3. larger distance from obstacles
4. larger distance from board edges
5. lower congestion
6. manufacturable geometry

The priority should be configurable.

---

# 15. 45-Degree Routing

The default routing mode should support:

```text
0°
45°
90°
135°
180°
225°
270°
315°
```

Avoid arbitrary angles in the first implementation.

This produces cleaner PCB traces and simplifies manufacturing.

---

# 16. Net Routing Order

Routing order strongly affects success rate.

The router should calculate a priority for every net.

Recommended factors:

```text
priority =
    numberOfPins
  + estimatedLength
  + obstacleDensity
  + criticality
```

Route difficult nets first.

Examples:

```text
Net with 2 pins and huge open area
    -> low priority

Net with 12 pins in dense area
    -> high priority
```

Initially use a deterministic heuristic.

---

# 17. Critical Nets

The system should support net priority classes:

```text
CRITICAL
HIGH
NORMAL
LOW
```

Examples:

```text
GND      -> HIGH
POWER    -> HIGH
CLOCK    -> CRITICAL
SIGNAL   -> NORMAL
```

The exact classification should come from the PCB design rather than being hard-coded.

**Repo conformance (V1 deferral):** the data model has no per-net priority field and no UI for one. V1 uses a deterministic heuristic only (pin count + bounding span, tie-break netId ASC); priority classes are deferred until a net-properties UI exists.

---

# 18. Multi-Pin Nets

For a net containing more than two endpoints:

```text
A
|
B----C
|
D
```

the router must create a connected topology.

Initial implementation:

1. Select one endpoint as the root.
2. Find the nearest unconnected endpoint.
3. Route it to the existing net geometry.
4. Add the resulting trace to the routed geometry.
5. Repeat until all endpoints are connected.

Example:

```text
root
 |
 +---- endpoint
 |
 +---- endpoint
 |
 +---- endpoint
```

Later versions may implement Steiner-tree optimization.

---

# 19. Endpoint Selection

For multi-pin nets, use deterministic ordering.

Recommended:

```text
1. Choose endpoint with lowest ID as root.
2. Find nearest remaining endpoint.
3. Route to existing net geometry.
4. Repeat.
```

Later optimization may use:

```text
minimum spanning tree
Steiner tree
```

---

# 20. Failed Routing

A failed route must NOT crash the entire routing operation.

Return:

```text
RoutingResult
 ├── success
 ├── routedNets[]
 ├── failedNets[]
 └── diagnostics[]
```

Example diagnostic:

```text
Net SPI_MOSI could not be routed.

Reason:
No valid path between U2.5 and U3.12.

Possible causes:
- insufficient clearance
- blocked area
- board boundary
- routing grid too coarse
```

---

# 21. Partial Routing

The router must support partial success.

Example:

```text
20 nets
18 routed
2 failed
```

The user should be able to inspect the result and manually fix the remaining two nets.

---

# 22. Manual + Automatic Routing

Existing user-created traces must be treated as fixed geometry.

Example:

```text
Manual traces
      ↓
Obstacle map
      ↓
Autorouter
      ↓
Remaining connections
```

The user should be able to mark traces as:

```text
LOCKED
UNLOCKED
```

Locked traces cannot be modified by autorouting.

---

# 23. Rerouting

The architecture must support rerouting a selected net.

Example:

```text
reroute(netId)
```

The existing trace for that net is temporarily removed from the obstacle map.

Other nets remain blocked.

Then:

```text
remove old route
      ↓
rebuild obstacle map
      ↓
route net
      ↓
validate
      ↓
commit
```

Use transactional behavior so a failed reroute restores the previous route.

---

# 24. Routing Transaction

Routing operations should be atomic.

Conceptually:

```text
BEGIN ROUTING TRANSACTION

generate route
validate route

if valid:
    commit

else:
    rollback
```

Never leave partially corrupted geometry after a failed operation.

**Repo conformance:** millPCB's atomicity mechanism is the snapshot undo system. Route into a **draft** array (never touching live state), validate, then commit to `App` with a single `saveState()` — one autoroute run = one undo step. Rollback = discard the draft; nothing was ever mutated.

---

# 25. Collision Detection

Collision detection should be centralized.

**Repo conformance:** no `ICollisionDetector` interface. Reuse the pure geometry helpers already in `drc.js` (`segSegDistance`, `pointSegDistance` — top-level globals, DOM-free, shared by browser and MCP kernel). Two-stage strategy: grid membership test during A* (fast), segment-distance validation on the final polyline before commit (exact).

It must check:

- board boundary
- other nets
- pads
- holes
- keep-outs
- existing traces

---

# 26. Geometry Engine

Do not implement geometric calculations directly inside the A* algorithm.

Separate:

```text
Routing algorithm
        ↓
Geometry abstraction
        ↓
Collision detection
        ↓
PCB geometry
```

This allows the routing algorithm to remain independent of the UI.

**Repo conformance:** the "Geometry Engine" layer already exists as the pure helpers in `drc.js` — reuse them; do not reimplement distance math in `autorouter.js`.

---

# 27. Router Architecture

Recommended high-level architecture:

```text
                ┌────────────────────┐
                │   Autorouter API   │
                └─────────┬──────────┘
                          │
                          ▼
                ┌────────────────────┐
                │ Routing Controller │
                └─────────┬──────────┘
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
       Net Planner   Grid Builder   Validator
             │            │            │
             └────────────┼────────────┘
                          ▼
                  Routing Algorithm
                          │
                         A*
                          │
                          ▼
                   Collision Engine
                          │
                          ▼
                    Geometry Engine
                          │
                          ▼
                     Trace Model
```

---

# 28. Suggested API (repo conformance)

No interfaces — plain functions on a plain project object (the `ProjectApi` pattern), all pure and DOM-free:

```js
Autoroute.route(project, options)        // whole board -> RoutingResult
Autoroute.routeNet(project, netName, o)  // single net
Autoroute.rerouteNet(project, netName, o)
// options: { layer, traceWidth, clearance, gridSize, angleMode,
//            shouldCancel() -> bool, onProgress(p) }
```

Internals (module-private functions in `js/autorouter.js`): `buildGrid`, `buildObstacles`, `planNets`, `findPath` (A*), `simplifyPath`, `validateRoute`. Cancellation is the `options.shouldCancel()` callback, not a token object.

---

# 29. Routing Context

Avoid passing dozens of parameters between functions.

Create:

```text
RoutingContext
```

containing:

```text
RoutingContext
 ├── board
 ├── rules
 ├── grid
 ├── obstacleMap
 ├── routedTraces
 ├── currentNet
 └── shouldCancel   (callback, not a token object)
```

---

# 30. Validation

Every generated route must be validated before being committed.

Validation must include:

### Electrical

- correct net
- all endpoints connected
- no unintended shorts

### Geometry

- no self-intersection
- no illegal angles
- no invalid segments

### Manufacturing

- minimum trace width
- minimum clearance
- minimum edge clearance
- minimum hole clearance

### Board

- entire trace inside board
- (V2, deferred) no routing through keep-outs

---

# 31. Connectivity Validation

After routing, the system should be able to construct a connectivity graph.

Example:

```text
U1.1
 |
 +--- trace ---+
               |
               +--- U2.4
               |
               +--- C1.1
```

The validator verifies that all endpoints belonging to the net belong to the same connected component.

---

# 32. Short Detection

After routing all nets, perform a global short check.

Conceptually:

```text
for each trace:
    for each neighboring trace:
        if different nets && clearance violated:
            report short
```

Use spatial indexing rather than O(n²) comparison when the number of traces becomes large.

---

# 33. Spatial Index

The architecture should allow a spatial index such as:

```text
R-tree
quadtree
uniform grid
```

The first implementation uses the routing grid itself as the spatial index — no abstraction layer. If larger boards need one later, add a plain-function uniform-grid/quadtree helper; do not introduce an interface.

---

# 34. Performance Requirements

The router must remain responsive for typical hobby PCB layouts.

Target:

```text
Small PCB:
< 100 nets
< 500 pads

Routing:
ideally < 1 second
```

For larger designs:

```text
100–500 nets
```

the UI must remain responsive. **Repo conformance:** no Web Worker (breaks `file://`, which AGENTS.md requires to keep working). Instead, route one net per synchronous pass and call `App.render()` between nets — progress via `onProgress` callback + status bar, cancellation via `options.shouldCancel()`.

---

# 35. Progress Reporting

The router should expose:

```text
RoutingProgress
 ├── totalNets
 ├── processedNets
 ├── successfulNets
 ├── failedNets
 └── currentNet
```

Example UI:

```text
Autorouting...

██████████████░░░░░░ 72%

36 / 50 nets
34 routed
2 failed
```

---

# 36. Cancellation

Routing must be cancellable.

The UI must be able to execute:

```text
Cancel Autorouting
```

The algorithm must periodically check:

```js
options.shouldCancel() // between nets and every N A* iterations
```

Cancellation discards the current draft route; already-committed nets stay. The board is left in a consistent state (see §24).

---

# 37. Determinism

Determinism is mandatory.

Avoid:

- random routing
- unordered collections affecting routing order
- floating-point dependent decisions where possible

Sort nets and candidate nodes using stable ordering.

For example:

```text
priority DESC
netId ASC
```

---

# 38. Grid Resolution

The grid size must be configurable.

Recommended default:

```text
0.10 mm
```

Possible values:

```text
0.05 mm
0.10 mm
0.20 mm
0.25 mm
```

The router should warn the user if the grid is too coarse relative to the PCB geometry.

Example:

```text
Grid resolution 0.25 mm may prevent routing through
0.20 mm clearance areas.
```

---

# 39. Route Smoothing

A* may produce unnecessary bends.

After finding a route:

```text
A → B → C → D → E
```

run a simplification pass.

Possible transformations:

```text
A → B → C
```

into:

```text
A ─────── C
```

when the direct segment is valid.

The smoothing stage must never violate routing rules.

---

# 40. Post-Processing Pipeline

Generated route:

```text
A*
 ↓
Path reconstruction
 ↓
Remove redundant nodes
 ↓
Merge collinear segments
 ↓
45° cleanup
 ↓
Collision validation
 ↓
Manufacturing validation
 ↓
Commit
```

---

# 41. Routing Strategies

The architecture should support different routing strategies.

Initial:

```text
AStarRoutingStrategy
```

Future:

```text
AStarCongestionRoutingStrategy
HighSpeedRoutingStrategy
PowerRoutingStrategy
InteractiveRoutingStrategy
```

Use:

```text
IRoutingStrategy
```

rather than hard-coding strategy selection.

---

# 42. Congestion Handling

If routing fails because the board is congested, a later routing pass should be able to reroute existing non-critical traces.

Example:

```text
Pass 1
    route all nets

Pass 2
    identify failed nets

Pass 3
    temporarily remove low-priority routes

Pass 4
    reroute congested area

Pass 5
    retry failed nets
```

This should be designed into the architecture, but does not need to be implemented in version 1.

---

# 43. Routing Passes

Recommended future architecture:

```text
RoutingSession

Pass 1:
    Easy routing

Pass 2:
    Difficult routing

Pass 3:
    Rip-up and reroute

Pass 4:
    Optimization
```

Each pass operates on the same board model but has different routing policies.

---

# 44. Route Optimization

Once all nets are successfully routed, optional optimization may attempt to minimize:

```text
total trace length
number of bends
congestion
distance to board edge
```

Optimization must never sacrifice manufacturability.

---

# 45. User Controls

The UI should expose:

```text
[Autoroute]

Options:

Trace width:          0.50 mm   (min 0.38 = DRC floor)
Clearance:            0.38 mm   (DRC floor)
Grid:                 0.10 mm   (routing grid; draw snap is separate)
Routing mode:         45°
Optimize routes:      ON
Rip-up & reroute:     OFF

[Start]
[Cancel]
```

Advanced options can expose:

```text
bend penalty
edge penalty
congestion penalty
maximum iterations
routing strategy
```

---

# 46. Visual Feedback

During routing, the UI should optionally display:

- current net
- explored routing area
- successful routes
- failed routes
- blocked areas
- route preview

However, visualization must be decoupled from the routing engine.

The core router must work without a UI.

---

# 47. Error Model

Do not throw generic exceptions for normal routing failures.

Routing failure is an expected domain result.

Use structured diagnostics:

```text
RoutingFailureReason

NO_PATH
BOARD_BOUNDARY
CLEARANCE_VIOLATION
OBSTACLE
GRID_TOO_COARSE
MAX_BENDS_EXCEEDED
MAX_LENGTH_EXCEEDED
INVALID_GEOMETRY
```

---

# 48. Logging

Provide structured logging:

```text
Routing started
Net GND routing started
Net GND routed: 12.4 mm, 4 bends
Net SPI_MOSI failed: NO_PATH
Routing completed: 46/50 nets
```

Debug mode may additionally log:

```text
A* iterations
visited nodes
candidate paths
collision checks
```

Debug logging must be disabled or reduced in production.

---

# 49. Serialization

Routing configuration should be serializable.

Example:

```json
{
  "traceWidth": 0.3,
  "clearance": 0.2,
  "gridSize": 0.1,
  "angleMode": "45",
  "edgeClearance": 0.3,
  "optimize": true
}
```

This allows projects to preserve routing settings.

---

# 50. Testing Strategy

The routing engine requires extensive automated tests.

## Unit tests

Test:

- grid generation
- obstacle expansion
- collision detection
- pathfinding
- bend calculation
- trace smoothing
- clearance validation
- board boundary validation

## Integration tests

Test:

```text
2-pin net
multi-pin net
multiple nets
existing traces
blocked board
dense board
board edge
holes
keep-outs
```

## Regression tests

Every discovered routing bug should produce a permanent test case.

---

# 51. Golden Test Boards

Create a collection of deterministic test layouts:

```text
tests/autorouter/
    basic-2pin/
    crossing/
    blocked/
    multi-pin/
    dense/
    edge-clearance/
    holes/
    keepouts/
    milling-clearance/
```

Each test should contain:

```text
input board
routing configuration
expected result
```

Expected result should preferably verify topology and constraints rather than exact coordinates, unless exact determinism is intentionally being tested.

---

# 52. Architecture Boundary

The autorouter must NOT depend directly on:

- DOM
- canvas
- React components
- UI state
- browser events
- rendering code

Recommended dependency direction:

```text
UI
 ↓
Autorouter API
 ↓
Routing Domain
 ↓
Geometry Domain
```

Never:

```text
Routing Engine
 ↓
React / Canvas
```

---

# 53. Execution Model (repo conformance)

**No Web Worker.** `file://` is a hard requirement (AGENTS.md) and browsers block worker scripts under `file://`. The router runs on the main thread, one net per synchronous pass, with `App.render()` between passes — at hobbyist scale (≤ a few hundred nets, ~800k grid cells in typed arrays) this keeps the UI responsive while giving progress reporting and cancellation for free.

The same pure kernel also runs headless in Node (`tests/`) and inside the MCP server's `vm` context (`mcp/host.mjs`), so routing is testable and scriptable without any browser.

---

# 54. No AI Dependency

The autorouter itself should not use an LLM.

LLM/AI functionality may assist with:

- explaining routing failures
- suggesting configuration
- interpreting user commands
- recommending trace widths
- explaining manufacturing problems

But:

```text
AI
```

must remain outside the deterministic routing engine.

The core routing decision must be reproducible without an AI service.

---

# 55. Version 1 Scope

The first implementation should include ONLY:

```text
✓ 2-pin routing
✓ Multi-pin routing
✓ A*
✓ 45° routing
✓ Configurable grid
✓ Trace width
✓ Clearance
✓ Board boundary
✓ Pads
✓ Holes
✓ Existing traces
✓ Collision detection
✓ Route validation
✓ Partial success
✓ Routing diagnostics
✓ Cancellation
✓ Progress reporting
✓ Deterministic results
```

Do NOT implement initially:

```text
✗ advanced rip-up/reroute
✗ Steiner tree optimization
✗ differential pairs
✗ length matching
✗ impedance routing
✗ high-speed constraints
✗ arbitrary-angle routing
✗ AI-based routing
✗ keep-outs (no such concept in the data model yet — V2)
✗ multi-layer / via layer-crossing (vias are unplated holes)
✗ Web Worker execution (file:// constraint)
```

These should be extension points, not part of the first implementation.

---

# 56. Module Structure (repo conformance)

No new folders, no classes — one new flat file plus reuse of the existing pure kernel:

```text
js/autorouter.js           NEW — pure functions: buildGrid, buildObstacles,
                           planNets, findPath (A*), simplifyPath, validateRoute,
                           route / routeNet / rerouteNet
js/project-api.js          REUSE — pinWorld, getPinNet, addTrace, ensureNet, nextId
js/drc.js                  REUSE — segSegDistance, pointSegDistance, clearance logic
js/app-ui.js               Autoroute button + options; progress via status bar
index.html                 <script src="js/autorouter.js"> after drc.js, before vendor/jszip.min
css/style.css              options row styling (existing patterns)
tests/autorouter.test.js   node test, same pattern as tests/gcode.test.js
```

The domain boundary to preserve: everything in `autorouter.js` is DOM-free and operates on plain project objects — so the browser App, the Node test runner, and the MCP server (`mcp/host.mjs`) all use the identical code path.

---

# 57. Core Execution Flow

The complete autorouting flow should be:

```text
User clicks Autoroute
        ↓
Create RoutingSession
        ↓
Load board
        ↓
Load routing rules
        ↓
Validate board
        ↓
Build obstacle map
        ↓
Analyze nets
        ↓
Calculate net priorities
        ↓
Sort nets
        ↓
For each net:
        ↓
    Generate routing target(s)
        ↓
    Run A*
        ↓
    Reconstruct path
        ↓
    Simplify path
        ↓
    Validate geometry
        ↓
    Validate manufacturing constraints
        ↓
    Commit route
        ↓
After all nets:
        ↓
Global connectivity validation
        ↓
Global short detection
        ↓
Generate RoutingResult
        ↓
Return result to UI
```

---

# 58. Architecture Agent Requirements

The implementation agent must:

1. Inspect the existing MillPCB architecture before modifying it.
2. Reuse existing PCB geometry/domain models where possible.
3. Avoid introducing duplicate representations of pads, traces, nets or coordinates.
4. Keep autorouting independent from rendering.
5. Introduce interfaces only where they provide meaningful extensibility.
6. Avoid premature abstractions.
7. Keep the first implementation simple enough to debug.
8. Add automated tests alongside the router.
9. Preserve deterministic behavior.
10. Do not modify unrelated functionality.

Before implementation, the architecture agent should produce a **short architecture spine** (≤ ~200 lines — oversized docs have previously overflowed implementer context in this repo): integration points on `ProjectApi`, data model changes, module/file list, grid/collision strategy, testing strategy, sequence. The validated spine for this feature is `_bmad-output/planning-artifacts/architecture/architecture-autorouting-2026-09-11/ARCHITECTURE-SPINE.md`.

Only after this analysis should implementation begin.

---

# 59. Definition of Done

Autorouting is considered complete for V1 when:

```text
[ ] Two-pin nets can be automatically routed.
[ ] Multi-pin nets can be automatically connected.
[ ] Existing traces are respected.
[ ] Pads and holes are respected.
[ ] Keep-outs are respected.
[ ] Board boundaries are respected.
[ ] Trace width is respected.
[ ] Clearance is respected.
[ ] Milling constraints are respected.
[ ] No unintended shorts are produced.
[ ] All routed nets pass connectivity validation.
[ ] Failed nets produce useful diagnostics.
[ ] Partial routing is supported.
[ ] Routing can be cancelled.
[ ] Routing progress can be reported.
[ ] Results are deterministic.
[ ] UI remains responsive.
[ ] Automated regression tests exist.
[ ] Router has no dependency on AI or external services.
```

# 60. Important Architectural Decision

The most important design decision is to treat autorouting as a **domain service**, not as a UI feature.

The system should conceptually look like:

```text
             MillPCB
                │
       ┌────────┴────────┐
       │                 │
    Editor            Autorouter
       │                 │
       │          ┌──────┴──────┐
       │          │             │
       │        Planner       A* Engine
       │          │             │
       │          └──────┬──────┘
       │                 │
       └──────────┬──────┘
                  │
             PCB Domain
                  │
             Geometry
                  │
          Manufacturing Rules
```

This allows the autorouter to evolve independently from the editor and eventually support more advanced PCB routing features without requiring a rewrite of the MillPCB application.