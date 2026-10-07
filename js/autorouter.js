// ============================================================
// autorouter.js — routing grid, obstacle map, A* pathfinding + net planning,
// path simplification & exact pre-commit validation (Stories 1.1-1.4)
// ------------------------------------------------------------
// Pure functions over plain project data — no DOM, no App state.
// Builds the cell grid that A* pathfinding searches (Story 1.3),
// and marks every copper feature as an obstacle inflated by
// traceWidth/2 + clearance so routed traces keep DRC clearance:
//   - pads of every component on both layers (TH pads are drilled through)
//   - existing traces on the route layer (all nets — copper is copper)
//   - component bodies on the route layer (rotated bounding box)
//   - vias (through the board, so they block both layers)
//
// Grid convention: mm, origin at board center, Y-down (Board view).
//   ix = floor((x + width/2) / gridSize), iy = floor((y + height/2) / gridSize)
// state cell values: 0 = free, 1 = blocked (copper obstacle or board-edge inset).
//
// Loaded after drc.js / export.js in index.html — reuses the shared
// pointSegDistance() helper and Export.padFeatures(). Node: module.exports.
// ============================================================

const Autoroute = {

    // ------------------------------------------------------------
    // Rules
    // ------------------------------------------------------------

    // Resolve routing rules from project params, with options overrides.
    // Returns { gridSize, traceWidth, clearance, boardEdgeClearance, layer, expansion }
    // where expansion = traceWidth/2 + clearance (obstacle inflation radius).
    resolveRules(project, options) {
        const o = options || {};
        const params = (project && project.params) || {};
        const auto = params.autoroute || {};
        const gridSize = o.gridSize > 0 ? o.gridSize : ((auto.gridSize > 0) ? auto.gridSize : 0.1);
        const minTraceWidth = Number(params.minTraceWidth) > 0 ? Number(params.minTraceWidth) : 0.38;
        let traceWidth = o.traceWidth > 0 ? o.traceWidth : ((Number(params.traceWidth) > 0) ? params.traceWidth : 0.5);
        traceWidth = Math.max(minTraceWidth, Math.min(traceWidth, 2));
        const minClearance = Number(params.minClearance) > 0 ? Number(params.minClearance) : 0.38;
        const clearance = o.clearance > 0 ? Math.max(o.clearance, minClearance) : minClearance;
        const edgeRaw = Number.isFinite(o.boardEdgeClearance) ? o.boardEdgeClearance : 0.30;
        return {
            gridSize: gridSize,
            traceWidth: traceWidth,
            clearance: clearance,
            boardEdgeClearance: Math.max(0.1, Math.min(edgeRaw, 2)),
            layer: o.layer === 'bottom' ? 'bottom' : 'top',
            expansion: traceWidth / 2 + clearance
        };
    },

    // ------------------------------------------------------------
    // Grid
    // ------------------------------------------------------------

    // Build the routing grid for a project.
    // Returns { cols, rows, gridSize, state (Uint8Array), parent (Int32Array) }.
    // Cells whose centers fall inside the board-edge inset margin are BLOCKED (1).
    buildGrid(project, options) {
        const rules = this.resolveRules(project, options);
        const b = (project && project.board) || {};
        const bw = Number(b.width) > 0 ? Number(b.width) : 10;
        const bh = Number(b.height) > 0 ? Number(b.height) : 10;
        const gs = rules.gridSize;
        const cols = Math.max(1, Math.ceil(bw / gs));
        const rows = Math.max(1, Math.ceil(bh / gs));
        const state = new Uint8Array(cols * rows);
        const parent = new Int32Array(cols * rows).fill(-1); // A* back-pointers (Story 1.3)
        this._initEdges(state, cols, rows, gs, bw, bh, rules.boardEdgeClearance);
        return { cols: cols, rows: rows, gridSize: gs, width: bw, height: bh, state: state, parent: parent };
    },

    // Plain context shared by all routing stages (A*, net planning in later stories).
    createContext(project, options) {
        const b = (project && project.board) || {};
        return {
            project: project,
            board: { width: Number(b.width) > 0 ? Number(b.width) : 10, height: Number(b.height) > 0 ? Number(b.height) : 10 },
            rules: this.resolveRules(project, options),
            grid: this.buildGrid(project, options),
            obstacleMap: null,    // set by buildObstacles — shared view of grid.state
            routedTraces: [],     // traces committed so far (later stories)
            currentNet: null,
            shouldCancel: false
        };
    },

    // ------------------------------------------------------------
    // Obstacle map
    // ------------------------------------------------------------

    // Mark every copper feature as an obstacle inflated by rules.expansion.
    // Re-initializes grid.state first, so repeated calls on the same context
    // are idempotent (never cumulative). Same-net geometry is never blocked;
    // pad membership is trace-derived via ProjectApi.getPinNet (a trace
    // endpoint within NET_TOUCH of the pin) — never pin-name equality — the
    // identical predicate planNets and validateRoute use, so search and gate
    // agree. Components with a pin on the current net keep their body
    // perimeter ring free so routes can depart/arrive at that pin; validate-
    // Route's exact body check (4c) still gates committed geometry. Mutates
    // ctx.grid in place; returns it.
    buildObstacles(ctx) {
        const project = ctx.project || {};
        const rules = ctx.rules;
        const grid = ctx.grid;
        const board = ctx.board || { width: 10, height: 10 };
        // Re-init: BLOCKED (1) in the edge inset margin, FREE (0) elsewhere.
        this._initEdges(grid.state, grid.cols, grid.rows, grid.gridSize, board.width, board.height, rules.boardEdgeClearance);

        // Kernel helpers are optional (partial MCP loads) — degrade to edge-only map.
        if (typeof ComponentDefs === 'undefined' || typeof Export === 'undefined' ||
            typeof pointSegDistance !== 'function') {
            ctx.obstacleMap = grid.state;
            return grid;
        }

        const exp = rules.expansion;
        // A* is the coarse stage; the exact gate (validateRoute) judges the
        // committed geometry after simplifyPath has merged staircases and
        // endpoint lead-ins have been snapped. Those post-processing moves can
        // pull a chord up to one cell closer to copper than the searched
        // staircase, so the search keeps one extra cell of slack. The gate
        // stays the authority — this only makes the search conservative.
        const slack = grid.gridSize;
        // Component bodies only forbid physical overlap in validateRoute (4c),
        // so inflate body rings by half the trace width only — inflating by the
        // full `exp` would make the router stricter than the validator and
        // refuse legal runs that graze a body.
        const bodyExp = rules.traceWidth / 2;
        const currentNet = ctx.currentNet || null;
        // drc-style host so Export.padFeatures can resolve component sizes.
        const host = {
            getCompSize: function (c) {
                const def = ComponentDefs.get(c.type);
                if (!def) return null;
                return ComponentDefs.getSize(def, c.size !== undefined ? c.size : (def.defaultSize || 0));
            }
        };

        // 1. Pads — every component on both layers; same-net pads stay free.
        // Same-net membership is trace-derived (getPinNet), not pin-name
        // equality, so a pin named 'GND' with no GND trace is still blocked.
        // Exclusion is geometric (pad center within NET_TOUCH of a same-net
        // pin) — KiCad pad order/count need not match the pins list.
        const getPinNet = (typeof ProjectApi !== 'undefined')
            ? function (cid, pi) { return ProjectApi.getPinNet(project, cid, pi); } : null;
        const netPinsById = new Map(); // comp.id -> world positions of its same-net pins
        for (const comp of project.components || []) {
            let pads = [];
            try { pads = Export.padFeatures(host, comp) || []; } catch (e) { continue; }
            const size = host.getCompSize(comp);
            const pins = (comp.pins && comp.pins.length) ? comp.pins : ((size && size.pins) || []);
            const netPins = [];
            if (currentNet && getPinNet) {
                for (let pi = 0; pi < pins.length; pi++) {
                    if (!pins[pi] || getPinNet(comp.id, pi) !== currentNet) continue;
                    const wp = ProjectApi.pinWorld(project, comp.id, pi);
                    if (wp) netPins.push(wp);
                }
            }
            const onNetPin = function (x, y) {
                for (let k = 0; k < netPins.length; k++) {
                    if (Math.hypot(x - netPins[k].x, y - netPins[k].y) < Autoroute.NET_TOUCH) return true;
                }
                return false;
            };
            for (let pi = 0; pi < pads.length; pi++) {
                const pad = pads[pi];
                if (pad.kind === 'circle') {
                    if (onNetPin(pad.x, pad.y)) continue;
                    this._markCircle(grid, board, pad.x, pad.y, pad.r + exp + slack);
                } else if (pad.pts && pad.pts.length >= 3) {
                    const cx = (pad.cx != null) ? pad.cx : pad.pts[0].x;
                    const cy = (pad.cy != null) ? pad.cy : pad.pts[0].y;
                    if (onNetPin(cx, cy)) continue;
                    this._markPoly(grid, board, pad.pts, exp + slack);
                }
            }
            if (netPins.length > 0) netPinsById.set(comp.id, netPins);
        }

        // 2. Existing traces on the route layer (all nets except the current one).
        for (const tr of project.traces || []) {
            if ((tr.layer || 'top') !== rules.layer) continue;
            if (tr.schemWire) continue; // logical wire — not copper, doesn't block routing
            if (currentNet && tr.net === currentNet) continue;
            const pts = tr.points || [];
            for (let i = 0; i + 1 < pts.length; i++) {
                const w = (tr.segmentWidths && tr.segmentWidths[i]) || tr.width || 0.5;
                this._markSeg(grid, board, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, w / 2 + exp + slack);
            }
        }

        // Existing copper of the current net: used below to aim the pin
        // corridors along the stub the route must join.
        const sameNetTraces = [];
        if (currentNet) {
            for (const tr of project.traces || []) {
                if ((tr.layer || 'top') !== rules.layer) continue;
                if (tr.schemWire || tr.net !== currentNet) continue;
                if ((tr.points || []).length >= 2) sameNetTraces.push(tr);
            }
        }

        // 3. Component bodies on the route layer (rotated bounding box).
        // The perimeter ring is always blocked, including for components that
        // have a pin on the current net: copper may not cut across a body, so
        // a route must reach such a pin from OUTSIDE the body (going around it
        // when the pin sits on the far side). Same-net pins punch a channel
        // through the ring so A* can depart/arrive there; without the gap the
        // search would fail on any net whose pin touches its own body edge.
        const gs = grid.gridSize;
        const inset = Math.min(rules.boardEdgeClearance, board.width / 4, board.height / 4);
        const limX = board.width / 2 - inset, limY = board.height / 2 - inset;
        for (const comp of project.components || []) {
            if ((comp.layer || 'top') !== rules.layer) continue;
            const size = host.getCompSize(comp);
            if (!size) continue;
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const hw = size.width / 2, hh = size.height / 2;
            const wpt = function (lx, ly) {
                return { x: comp.x + lx * cos - ly * sin, y: comp.y + lx * sin + ly * cos };
            };
            const p0 = wpt(-hw, -hh), p1 = wpt(hw, -hh), p2 = wpt(hw, hh), p3 = wpt(-hw, hh);
            this._markSeg(grid, board, p0.x, p0.y, p1.x, p1.y, bodyExp);
            this._markSeg(grid, board, p1.x, p1.y, p2.x, p2.y, bodyExp);
            this._markSeg(grid, board, p2.x, p2.y, p3.x, p3.y, bodyExp);
            this._markSeg(grid, board, p3.x, p3.y, p0.x, p0.y, bodyExp);
            // Fill the whole footprint, not just the outline: copper that
            // diagonals across a body (even a through-hole one) would cut
            // through its pin column and lock the other pins out. Same-net
            // pins punch their channel through this fill below.
            let bx0 = Math.min(p0.x, p1.x, p2.x, p3.x) - bodyExp;
            let bx1 = Math.max(p0.x, p1.x, p2.x, p3.x) + bodyExp;
            let by0 = Math.min(p0.y, p1.y, p2.y, p3.y) - bodyExp;
            let by1 = Math.max(p0.y, p1.y, p2.y, p3.y) + bodyExp;
            this._forEachCellInBox(grid, board, bx0, by0, bx1, by1, (ix, iy) => {
                const i = iy * grid.cols + ix;
                const c = this._cellCenter(grid, board, ix, iy);
                const dx = c.x - comp.x, dy = c.y - comp.y;
                const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
                if (Math.abs(lx) > hw + bodyExp || Math.abs(ly) > hh + bodyExp) return;
                grid.state[i] = 1;
            });
            // Punch a channel through the ring at each same-net pin so A* can
            // reach the pin from outside the body (the pin pad itself is kept
            // free by step 1). Cells in the board-edge inset stay blocked so
            // BOARD_BOUNDARY semantics are unchanged.
            const np = netPinsById.get(comp.id);
            if (!np) continue;
            // The channel runs from the pin straight out of the body, so it
            // works whether the pin sits on the body edge (TH pads) or well
            // inside it (def body larger than the stored pin offsets). When
            // the net already has copper at this pin, the channel follows
            // that stub instead, so the route can join it.
            const half = bodyExp + gs;
            const reach = Math.hypot(hw, hh) + bodyExp + gs;
            for (let k = 0; k < np.length; k++) {
                const px = np[k].x, py = np[k].y;
                const dirs = [];
                // Copper runs H/V/45 only, so the pin must be reachable from
                // every legal heading — punching only the radial direction
                // would leave a pin whose radial is off-grid (e.g. an IC pin
                // at 19 deg) unreachable by any HV+45 last segment.
                dirs.push([1, 0], [-1, 0], [0, 1], [0, -1], [0.70711, 0.70711], [0.70711, -0.70711], [-0.70711, 0.70711], [-0.70711, -0.70711]);
                const dx = px - comp.x, dy = py - comp.y;
                const len = Math.hypot(dx, dy);
                if (len >= 1e-6) dirs.push([dx / len, dy / len]);
                for (let ti = 0; ti < sameNetTraces.length; ti++) {
                    const pts = sameNetTraces[ti].points;
                    const f = pts[0], l = pts[pts.length - 1];
                    const far = (Math.hypot(f.x - px, f.y - py) < Autoroute.NET_TOUCH) ? l
                        : ((Math.hypot(l.x - px, l.y - py) < Autoroute.NET_TOUCH) ? f : null);
                    if (!far) continue;
                    const ex = far.x - px, ey = far.y - py;
                    const el = Math.hypot(ex, ey);
                    if (el < 1e-6) continue;
                    dirs.push([ex / el, ey / el]);
                }
                for (let d = 0; d < dirs.length; d++) {
                    const ux = dirs[d][0], uy = dirs[d][1];
                    const bx = px + ux * reach, by = py + uy * reach;
                    const pinPt = { x: px, y: py }, outPt = { x: bx, y: by };
                    this._forEachCellInBox(grid, board, Math.min(px, bx) - half, Math.min(py, by) - half,
                        Math.max(px, bx) + half, Math.max(py, by) + half, (ix, iy) => {
                            const i = iy * grid.cols + ix;
                            if (grid.state[i] !== 1) return;
                            const c = this._cellCenter(grid, board, ix, iy);
                            // Never re-open the board-edge inset (BOARD_BOUNDARY).
                            if (Math.abs(c.x) > limX || Math.abs(c.y) > limY) return;
                            if (pointSegDistance(c, pinPt, outPt) >= half) return;
                            grid.state[i] = 0;
                        });
                }
            }
        }

        // 4. Vias — through the whole board, so they block both layers.
        for (const v of project.vias || []) {
            const d = Number(v.diameter) > 0 ? Number(v.diameter) : 1.2;
            this._markCircle(grid, board, v.x, v.y, d / 2 + exp + slack);
        }

        ctx.obstacleMap = grid.state; // shared view for later stages
        return grid;
    },

    // ------------------------------------------------------------
    // Net planning (Story 1.2)
    // ------------------------------------------------------------

    // Connectivity tolerance (mm). Must stay identical to the pin/trace
    // predicate in ProjectApi.getPinNet so "member" and "connected" agree.
    NET_TOUCH: 0.15,

    // Electrical connectivity on ONE layer: which existing same-net traces
    // (plus vias) join the member pads of a net. planNets' union-find unions
    // all same-net traces regardless of layer, so a net fully wired by
    // schematic wires would still be listed as routable — this gate catches
    // it before any star routing. Conservative: if the check can't prove
    // full connectivity (e.g. only on another layer), the net routes as
    // before. Returns Map "x,y" -> group id; members sharing a group are
    // electrically joined on `layer`.
    electricalGroups(project, netName, layer) {
        const P = ProjectApi;
        const keyOf = (x, y) => Math.round(x * 1e6) + ',' + Math.round(y * 1e6);
        const ids = new Map(); // position key -> node id
        const parent = [];
        const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
        const idOf = (x, y) => {
            const k = keyOf(x, y);
            let id = ids.get(k);
            if (id === undefined) { id = parent.length; ids.set(k, id); parent.push(id); }
            return id;
        };

        // Nodes: this net's member pad positions, then endpoints of each
        // same-net trace on `layer`. Edges: pad<->trace endpoint within
        // NET_TOUCH (same predicate as getPinNet), pins of one component
        // (the package joins them internally — IC power/ground pins, switch
        // and jumper bodies), and vias bridging coincident endpoints.
        const padKeys = [];
        const padPts = [];   // { x, y, id } — for pad<->trace proximity edges
        const padsByComp = new Map(); // compId -> [node ids] (component bridge)
        for (const comp of project.components || []) {
            const pins = P.getCompPins(comp);
            for (let pi = 0; pi < pins.length; pi++) {
                if (P.getPinNet(project, comp.id, pi) !== netName) continue;
                const wp = P.pinWorld(project, comp.id, pi);
                if (!wp) continue;
                padKeys.push(keyOf(wp.x, wp.y));
                const id = idOf(wp.x, wp.y);
                padPts.push({ x: wp.x, y: wp.y, id });
                const list = padsByComp.get(comp.id);
                if (list) list.push(id); else padsByComp.set(comp.id, [id]);
            }
        }
        // Component bridge — only when the net spans > 1 component. A lone
        // two-pin part on one net (open switch / jumper) is NOT internally
        // joined: its pins are separate nodes that need copper.
        if (padsByComp.size > 1) {
            for (const list of padsByComp.values()) {
                for (let i = 1; i < list.length; i++) union(list[i], list[0]);
            }
        }
        for (const t of project.traces || []) {
            if (t.net !== netName || (t.layer || 'top') !== layer) continue;
            if (t.schemWire) continue; // logical wire — no physical copper connectivity
            const pts = t.points || [];
            if (!pts.length) continue;
            union(idOf(pts[0].x, pts[0].y), idOf(pts[pts.length - 1].x, pts[pts.length - 1].y));
        }
        // Pad<->trace edges within NET_TOUCH of any segment (a pin on a
        // T-join or an interior vertex is on this copper, not only endpoints).
        for (const pn of padPts) {
            for (const t of project.traces || []) {
                if (t.net !== netName || (t.layer || 'top') !== layer) continue;
                if (t.schemWire) continue; // logical wire — no physical copper connectivity
                const pts = t.points || [];
                for (let s = 0; s + 1 < pts.length; s++) {
                    if (pointSegDistance(pn, pts[s], pts[s + 1]) < Autoroute.NET_TOUCH) {
                        union(pn.id, idOf(pts[0].x, pts[0].y));
                        break;
                    }
                }
            }
        }
        // T-join: an endpoint sitting on another same-net segment is one net.
        const layerTraces = [];
        for (const t of project.traces || []) {
            if (t.net !== netName || (t.layer || 'top') !== layer || t.schemWire) continue;
            if ((t.points || []).length >= 2) layerTraces.push(t);
        }
        for (let a = 0; a < layerTraces.length; a++) {
            const pa = layerTraces[a].points;
            const ends = [pa[0], pa[pa.length - 1]];
            for (let b = 0; b < layerTraces.length; b++) {
                if (a === b) continue;
                const pb = layerTraces[b].points;
                for (const e of ends) {
                    for (let s = 0; s + 1 < pb.length; s++) {
                        if (pointSegDistance(e, pb[s], pb[s + 1]) < Autoroute.NET_TOUCH) {
                            union(idOf(e.x, e.y), idOf(pb[0].x, pb[0].y));
                            break;
                        }
                    }
                }
            }
        }
        for (const v of project.vias || []) {
            for (const t of project.traces || []) {
                if (t.net !== netName || (t.layer || 'top') !== layer) continue;
                if (t.schemWire) continue; // logical wire — no physical copper connectivity
                const pts = t.points || [];
                if (!pts.length) continue;
                const f = pts[0], l = pts[pts.length - 1];
                if (Math.hypot(f.x - v.x, f.y - v.y) < Autoroute.NET_TOUCH) union(idOf(f.x, f.y), idOf(v.x, v.y));
                if (Math.hypot(l.x - v.x, l.y - v.y) < Autoroute.NET_TOUCH) union(idOf(l.x, l.y), idOf(v.x, v.y));
            }
        }

        // Map each member pad position to its group root.
        const groups = new Map();
        for (const k of padKeys) groups.set(k, find(ids.get(k)));
        return groups;
    },

    // True when every pad of this net is already joined by same-layer copper
    // (i.e. nothing left to route). Partial copper does NOT count as wired —
    // a net with one manual trace still needs the rest of its pads connected.
    isFullyWired(project, netName, layer) {
        const g = this.electricalGroups(project, netName, layer);
        if (g.size < 2) return true;
        let root = null;
        for (const r of g.values()) { if (root === null) root = r; else if (r !== root) return false; }
        return true;
    },

    // Plan which nets to route, in what order, with which root/targets.
    // Pure, deterministic, non-mutating — same input JSON gives same output.
    //
    // Membership is derived strictly via ProjectApi.getPinNet (a trace
    // endpoint within 0.15 mm of the pin). Pins with no such trace become
    // UNASSIGNED_PIN diagnostics and are never routed. Members of one net
    // are grouped into connected components through same-net traces:
    // pin<->trace endpoint < 0.15 mm; trace<->trace endpoint within 0.15 mm
    // of any segment of the other (pointSegDistance). Routable = >= 2 members
    // spanning > 1 component. See spec-1-2 for the full contract.
    planNets(project, options) {
        const P = ProjectApi;
        const comps = (project && project.components) || [];
        const traces = (project && project.traces) || [];

        // 1. Member scan — component array order, pin index order.
        const byNet = {};
        const netNames = [];
        const diagnostics = [];
        for (const comp of comps) {
            const pins = P.getCompPins(comp);
            for (let pi = 0; pi < pins.length; pi++) {
                const net = P.getPinNet(project, comp.id, pi);
                if (!net) {
                    diagnostics.push({ code: 'UNASSIGNED_PIN', compId: comp.id, pinIndex: pi, pinName: String(pins[pi] ? pins[pi].name : '') });
                    continue;
                }
                const wp = P.pinWorld(project, comp.id, pi); // non-null when getPinNet matched
                if (!wp) continue;
                if (!(net in byNet)) { netNames.push(net); byNet[net] = []; }
                const arr = byNet[net];
                arr.push({ compId: comp.id, pinIndex: pi, pinName: String(pins[pi].name), x: wp.x, y: wp.y, _i: arr.length });
            }
        }

        // 2. Per-net components + classification.
        const entries = []; // { entry, span } for routable nets
        const excluded = [];
        for (let ni = 0; ni < netNames.length; ni++) {
            const name = netNames[ni];
            const members = byNet[name];

            // Same-net PHYSICAL traces in project.traces array order (logical
            // schematic wires excluded — they carry no copper).
            const tIdx = [];
            for (let ti = 0; ti < traces.length; ti++) if (traces[ti].net === name && !traces[ti].schemWire) tIdx.push(ti);

            // Union-find over member nodes [0..m) + trace nodes [m..m+t).
            const nNodes = members.length + tIdx.length;
            const parent = new Int32Array(nNodes);
            for (let i = 0; i < nNodes; i++) parent[i] = i;
            const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
            const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

            // Pin<->trace edges — same endpoint predicate as getPinNet.
            for (let mi = 0; mi < members.length; mi++) {
                const m = members[mi];
                for (let k = 0; k < tIdx.length; k++) {
                    const pts = traces[tIdx[k]].points || [];
                    const f = pts[0], l = pts[pts.length - 1];
                    if ((f && Math.hypot(f.x - m.x, f.y - m.y) < Autoroute.NET_TOUCH) ||
                        (l && Math.hypot(l.x - m.x, l.y - m.y) < Autoroute.NET_TOUCH)) union(mi, members.length + k);
                }
            }
            // Trace<->trace edges — endpoint within tolerance of any segment.
            for (let a = 0; a < tIdx.length; a++) {
                const pa = traces[tIdx[a]].points || [];
                for (let b = a + 1; b < tIdx.length; b++) {
                    if (Autoroute._tracesTouch(pa, traces[tIdx[b]].points || [])) union(members.length + a, members.length + b);
                }
            }

            // Component bridge: pins of one instance on this net are joined
            // by the package itself (IC power/ground pins; switch/jumper
            // bodies), so no copper is needed between them — but only when
            // the net spans > 1 component. A lone two-pin part on one net
            // (open switch / jumper) keeps its pins as separate nodes that
            // need routing.
            const compSet = new Set();
            for (let mi = 0; mi < members.length; mi++) compSet.add(members[mi].compId);
            if (compSet.size > 1) {
                const firstByComp = new Map();
                for (let mi = 0; mi < members.length; mi++) {
                    const c = members[mi].compId;
                    if (firstByComp.has(c)) union(mi, firstByComp.get(c)); else firstByComp.set(c, mi);
                }
            }

            // Distinct components among member nodes.
            const rootOf = new Array(members.length);
            const distinct = [];
            for (let mi = 0; mi < members.length; mi++) {
                const r = find(mi);
                rootOf[mi] = r;
                if (distinct.indexOf(r) < 0) distinct.push(r);
            }

            if (members.length === 1) { excluded.push({ name, memberCount: 1, reason: 'SINGLE_MEMBER' }); continue; }
            if (distinct.length === 1) { excluded.push({ name, memberCount: members.length, reason: 'ALREADY_CONNECTED' }); continue; }

            // Layer-aware electrical check: the union-find above ignores trace
            // layers, so a net whose pads are already wired by existing
            // same-layer physical copper is NOT routable — routing it would
            // only add duplicate parallel paths. Logical schematic wires do
            // not count as wired.
            const eGroups = this.electricalGroups(project, name, (options && options.layer) || 'top');
            const eRoots = new Set();
            for (const r of eGroups.values()) eRoots.add(r);
            if (eRoots.size === 1) { excluded.push({ name, memberCount: members.length, reason: 'ALREADY_CONNECTED' }); continue; }

            // Root = min (compId ASC, pinIndex ASC) — independent of geometry.
            const sorted = members.slice().sort((a, b) => a.compId - b.compId || a.pinIndex - b.pinIndex);
            const rootNode = rootOf[sorted[0]._i];

            // Targets: one representative per same-layer electrical group
            // outside the root's group. Pads already joined by existing
            // copper (same eGroup) would each pull their own star route —
            // duplicate parallel traces — so only the closest member of a
            // group is routed; the rest ride the shared copper.
            const keyOf = (x, y) => Math.round(x * 1e6) + ',' + Math.round(y * 1e6);
            const rootEGroup = eGroups.get(keyOf(sorted[0].x, sorted[0].y));
            const reps = new Map(); // eGroup root -> representative target
            for (const m of sorted) {
                if (rootOf[m._i] === rootNode) continue;
                const eg = eGroups.get(keyOf(m.x, m.y));
                if (eg === rootEGroup) continue;
                let dist = Infinity;
                for (let k = 0; k < tIdx.length; k++) {
                    if (find(members.length + k) !== rootNode) continue;
                    const pts = traces[tIdx[k]].points || [];
                    for (let i = 0; i + 1 < pts.length; i++) {
                        const d = pointSegDistance({ x: m.x, y: m.y }, pts[i], pts[i + 1]);
                        if (d < dist) dist = d;
                    }
                }
                const cur = reps.get(eg);
                if (!cur || dist < cur.dist ||
                    (dist === cur.dist && (m.compId < cur.compId || (m.compId === cur.compId && m.pinIndex < cur.pinIndex)))) {
                    reps.set(eg, { compId: m.compId, pinIndex: m.pinIndex, pinName: m.pinName, x: m.x, y: m.y, dist });
                }
            }
            const targets = [];
            for (const r of reps.values()) targets.push(r);
            targets.sort((a, b) => a.dist - b.dist || a.compId - b.compId || a.pinIndex - b.pinIndex);

            // Bounding span over member positions (priority tie-break).
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const m of sorted) {
                if (m.x < minX) minX = m.x;
                if (m.x > maxX) maxX = m.x;
                if (m.y < minY) minY = m.y;
                if (m.y > maxY) maxY = m.y;
            }
            const span = Math.hypot(maxX - minX, maxY - minY);

            const clean = ms => ms.map(m => ({ compId: m.compId, pinIndex: m.pinIndex, pinName: m.pinName, x: m.x, y: m.y }));
            entries.push({
                span,
                entry: { name, memberCount: members.length, components: distinct.length, members: clean(sorted), root: clean([sorted[0]])[0], targets }
            });
        }

        // 3. Deterministic ordering.
        const cmpName = (a, b) => a < b ? -1 : a > b ? 1 : 0;
        excluded.sort((a, b) => cmpName(a.name, b.name));
        entries.sort((a, b) => b.entry.memberCount - a.entry.memberCount || b.span - a.span || cmpName(a.entry.name, b.entry.name));

        return { nets: entries.map(e => e.entry), excluded, diagnostics };
    },

    // Minimum spanning tree over a net's nodes (root + targets), grown from
    // nodes[0] (Prim). Returns edges in growth order: each edge's `from` node
    // is already in the tree when its leg is routed, so the leg starts from the
    // free end of that node's committed copper and joins at the `to` pad.
    // Replaces the star-from-root plan (CAP-7): multi-pin nets (GND/V12/DC_RAW)
    // no longer collide at one shared root pad. Deterministic: equal-distance
    // ties pick the lowest node index. Pure — no project mutation, no DOM.
    mstEdges(nodes) {
        if (!nodes || nodes.length < 2) return [];
        const inTree = new Array(nodes.length).fill(false);
        inTree[0] = true;
        const edges = [];
        for (let added = 1; added < nodes.length; added++) {
            let best = -1, bestFrom = -1, bestD = Infinity;
            for (let i = 0; i < nodes.length; i++) {
                if (!inTree[i]) continue;
                for (let j = 0; j < nodes.length; j++) {
                    if (inTree[j]) continue;
                    const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
                    if (d < bestD || (d === bestD && (best === -1 || j < best))) { bestD = d; best = j; bestFrom = i; }
                }
            }
            if (best === -1) break;
            inTree[best] = true;
            edges.push({ from: nodes[bestFrom], to: nodes[best] });
        }
        return edges;
    },

    // ------------------------------------------------------------
    // A* pathfinding on the grid (Story 1.3)
    // ------------------------------------------------------------

    // Default bend penalty in mm-equivalent cost units. Charged per turn
    // where consecutive move vectors meet at >= 90 degrees (dot <= 0);
    // 45-degree transitions (H<->D, V<->D) are free, so mitered corners
    // are always preferred over square ones.
    BEND_PENALTY: 5.0,

    // Cost epsilon charged per 45-degree direction change inside the A*
    // search key ONLY. Must stay far below one grid step so it can only
    // reorder paths that already cost the same; it exists because a 45
    // staircase and the equivalent long-diagonal run cost exactly the same,
    // and without a preference A* emits the staircase (which no amount of
    // local simplification can collapse).
    TURN45_EPS: 1e-5,

    // Fixed neighbor scan order (y-down grid): E NE N NW W SW S SE.
    _ASTAR_DIRS: [
        { dx: 1, dy: 0 }, { dx: 1, dy: -1 }, { dx: 0, dy: -1 }, { dx: -1, dy: -1 },
        { dx: -1, dy: 0 }, { dx: -1, dy: 1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }
    ],

    // A* over the routing grid for one start/goal pair (world mm).
    // State = (cell, lastMoveDir): the bend penalty makes edge cost depend
    // on the incoming direction, which cell-only search cannot optimize.
    // 9 states per cell (8 dirs + START), typed-array scratch, Euclidean
    // heuristic (consistent -> no re-opening; first popped goal is optimal).
    // Among equal-cost paths the search prefers the one with the fewest
    // direction changes: TURN45_EPS is added to the search key per heading
    // change, which is small enough to only ever reorder paths of equal real
    // cost. A 45-degree staircase and the equivalent long-diagonal-then-
    // straight run cost exactly the same, so without this preference A* emits
    // dozens of alternating H/D steps where a single diagonal was wanted —
    // and simplifyPath cannot collapse such a staircase locally.
    // The epsilon never enters `cost`, which stays `length + bends * bendPenalty`.
    // Diagonal moves are corner-cutting-safe: both orthogonal neighbors must
    // be free. Returns { points (cell centers, world mm), cost, bends } or
    // null when no path exists or an endpoint is blocked/out of range.
    // See spec-1-3 for the full contract.
    findPath(grid, sx, sy, ex, ey, options) {
        const o = options || {};
        const penalty = (Number.isFinite(o.bendPenalty) && o.bendPenalty >= 0) ? o.bendPenalty : Autoroute.BEND_PENALTY;
        const eps45 = (Number.isFinite(o.turn45Eps) && o.turn45Eps >= 0) ? o.turn45Eps : Autoroute.TURN45_EPS;
        const gs = grid.gridSize, cols = grid.cols, rows = grid.rows, state = grid.state;
        const bw = grid.width, bh = grid.height;
        if (!(bw > 0 && bh > 0) || !(gs > 0)) return null;

        // Endpoint -> cell (same mapping as the obstacle code).
        const toCell = (x, y) => {
            const ix = Math.floor((x + bw / 2) / gs);
            const iy = Math.floor((y + bh / 2) / gs);
            if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return -1;
            return iy * cols + ix;
        };
        const sIdx = toCell(sx, sy), gIdx = toCell(ex, ey);
        if (sIdx < 0 || gIdx < 0) return null;
        if (state[sIdx] !== 0) return null;
        if (sIdx === gIdx) return { points: [{ x: sx, y: sy }], cost: 0, bends: 0 };
        if (state[gIdx] !== 0) return null;

        const DIRS = Autoroute._ASTAR_DIRS;
        const ND = 9; // 8 directions + START (=8, no incoming direction)
        const nStates = cols * rows * ND;
        const gScore = new Float32Array(nStates).fill(Infinity);
        // Search key = gScore + TURN45_EPS * directionChanges. The epsilon is
        // far below one grid step, so it only ever breaks ties between paths of
        // equal real length — it makes the search pick the long-diagonal
        // decomposition of a staircase instead of the alternating one, which
        // simplifyPath cannot collapse on its own. Reported cost stays pure.
        const gAdj = new Float64Array(nStates).fill(Infinity);
        const closed = new Uint8Array(nStates);
        const parent = new Int32Array(nStates).fill(-1);
        // Direction changes along the best path found so far to each state —
        // heap tie-break only, never part of gScore.
        const turns = new Int32Array(nStates).fill(0x7fffffff);

        // Consistent heuristic: Euclidean cell-center -> goal-cell-center.
        const gcx = ((gIdx % cols) + 0.5) * gs - bw / 2;
        const gcy = (((gIdx / cols) | 0) + 0.5) * gs - bh / 2;
        const hOf = (ix, iy) => Math.hypot((ix + 0.5) * gs - bw / 2 - gcx, (iy + 0.5) * gs - bh / 2 - gcy);

        // Open list: binary min-heap on (f ASC, turns ASC, stateIndex ASC) — deterministic.
        const hF = [], hT = [], hS = [];
        let hN = 0;
        const better = (f, t, s, f2, t2, s2) =>
            f < f2 || (f === f2 && (t < t2 || (t === t2 && s < s2)));
        function heapPush(f, t, s) {
            if (hN * 2 >= hF.length) { hF.length = Math.max(16, hF.length * 2 || 16); hT.length = hF.length; hS.length = hF.length; }
            let i = hN++;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (!better(f, t, s, hF[p], hT[p], hS[p])) break;
                hF[i] = hF[p]; hT[i] = hT[p]; hS[i] = hS[p]; i = p;
            }
            hF[i] = f; hT[i] = t; hS[i] = s;
        }
        function heapPop() {
            const ts = hS[0];
            hN--;
            if (hN > 0) {
                const f = hF[hN], t = hT[hN], s = hS[hN];
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    if (l >= hN) break;
                    let m = l;
                    if (r < hN && better(hF[r], hT[r], hS[r], hF[l], hT[l], hS[l])) m = r;
                    if (!better(hF[m], hT[m], hS[m], f, t, s)) break;
                    hF[i] = hF[m]; hT[i] = hT[m]; hS[i] = hS[m]; i = m;
                }
                hF[i] = f; hT[i] = t; hS[i] = s;
            }
            return ts;
        }

        const startState = sIdx * ND + 8;
        gScore[startState] = 0;
        gAdj[startState] = 0;
        turns[startState] = 0;
        heapPush(hOf(sIdx % cols, (sIdx / cols) | 0), 0, startState);

        let goalState = -1;
        while (hN > 0) {
            const cur = heapPop();
            if (closed[cur]) continue;
            closed[cur] = 1;
            const cell = (cur / ND) | 0;
            if (cell === gIdx) { goalState = cur; break; }
            const dir = cur % ND;
            const ix = cell % cols, iy = (cell / cols) | 0;
            const baseG = gScore[cur];
            const baseAdj = gAdj[cur];
            const baseT = turns[cur];
            for (let d = 0; d < 8; d++) {
                const mv = DIRS[d];
                const nix = ix + mv.dx, niy = iy + mv.dy;
                if (nix < 0 || niy < 0 || nix >= cols || niy >= rows) continue;
                const ncell = niy * cols + nix;
                if (state[ncell] !== 0) continue;
                // No corner cutting: diagonal needs both orthogonal neighbors free.
                if (mv.dx !== 0 && mv.dy !== 0 &&
                    (state[iy * cols + nix] !== 0 || state[niy * cols + ix] !== 0)) continue;
                let turn = 0;
                let tstep = 0;
                if (dir !== 8) {
                    const pv = DIRS[dir];
                    const dot = pv.dx * mv.dx + pv.dy * mv.dy;
                    if (dot <= 0) turn = penalty; // 90 degrees or sharper
                    if (d !== dir) tstep = 1; // any heading change counts for the tie-break
                }
                const ns = ncell * ND + d;
                const step = (mv.dx !== 0 && mv.dy !== 0) ? Math.SQRT2 * gs : gs;
                const ng = baseG + step + turn;
                const nt = baseT + tstep;
                const nAdj = baseAdj + step + turn + tstep * eps45;
                if (nAdj < gAdj[ns]) {
                    gAdj[ns] = nAdj;
                    gScore[ns] = ng;
                    turns[ns] = nt;
                    parent[ns] = cur;
                    heapPush(nAdj + hOf(nix, niy), nt, ns);
                }
            }
        }
        if (goalState < 0) return null;

        // Reconstruct: walk parents to start, emit cell-center points.
        const cells = [];
        for (let s = goalState; s >= 0; s = parent[s]) cells.push((s / ND) | 0);
        cells.reverse();
        const points = new Array(cells.length);
        let bends = 0, prevDx = 0, prevDy = 0;
        for (let i = 0; i < cells.length; i++) {
            const ix = cells[i] % cols, iy = (cells[i] / cols) | 0;
            points[i] = { x: (ix + 0.5) * gs - bw / 2, y: (iy + 0.5) * gs - bh / 2 };
            if (i > 0) {
                const p = cells[i - 1];
                const dx = ix - (p % cols), dy = iy - ((p / cols) | 0);
                if (i > 1 && prevDx * dx + prevDy * dy <= 0) bends++;
                prevDx = dx; prevDy = dy;
            }
        }
        return { points: points, cost: gScore[goalState], bends: bends };
    },

    // ------------------------------------------------------------
    // Path simplification (Story 1.4)
    // ------------------------------------------------------------

    // Simplify an A* cell-center path into a smooth HV+45 polyline.
    // Pass 1 drops non-finite points and consecutive duplicates (< 1e-9).
    // Then a fixed-point loop removes ONE reducible interior node per round
    // and rescans, so newly-formed runs collapse too:
    //   - collinear triple (cross product ~ 0) -> merged when the middle point
    //     lies between its neighbors, keeping exactly the same point set
    //     (true for A* parent chains — the stated input domain; a backtrack
    //     triple like [(1,0),(0,0),(2,0)] would lose coverage of (0,0));
    //   - miter candidate: orthogonal EQUAL-leg corner -> A,B,C becomes the
    //     diagonal A->C (exactly 45 deg), but ONLY when
    //     options.validateSegment(A, C) returns true (FR20 — a merge that
    //     would fail exact validation stays unmerged). No predicate = no miters.
    // Pure and deterministic: new array returned, input untouched, fixed scan
    // order. Endpoints preserved exactly; HV+45 input keeps output angles in
    // {0 deg, 45 deg, 90 deg}. Terminates: each changing round removes one node.
    // Epsilon-chord merge tolerance (mm). A* cell staircases are ~gs/2 off a
    // straight H/V/45 line; merging them keeps routes clean. Must stay below
    // the min clearance so the merged chord never gets closer to copper than
    // the original staircase (validateRoute re-checks every segment, so this
    // can only ever remove points, never commit bad geometry).
    SIMPLIFY_EPS: 0.05,

    simplifyPath(points, options) {
        const validateSeg = (options && typeof options.validateSegment === 'function') ? options.validateSegment : null;
        const eps = (options && Number.isFinite(options.eps) && options.eps > 0) ? options.eps : Autoroute.SIMPLIFY_EPS;
        if (!Array.isArray(points)) return [];
        const pts = [];
        for (const p of points) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const q = pts[pts.length - 1];
            if (q && Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9) continue;
            pts.push({ x: p.x, y: p.y });
        }
        for (;;) {
            let changed = false;
            for (let i = 1; i + 1 < pts.length; i++) {
                const a = pts[i - 1], b = pts[i], c = pts[i + 1];
                const uax = b.x - a.x, uay = b.y - a.y;
                const ubx = c.x - b.x, uby = c.y - b.y;
                const la = Math.hypot(uax, uay), lb = Math.hypot(ubx, uby);
                if (la < 1e-9 || lb < 1e-9) { pts.splice(i, 1); changed = true; break; }
                // Collinear with the middle point between its neighbors (A*
                // parent chains): merging keeps exactly the same point set.
                if (Math.abs(uax * uby - uay * ubx) <= 1e-9 * la * lb) { pts.splice(i, 1); changed = true; break; }
                // Orthogonal equal legs -> A->C is an exact 45-degree miter.
                const dot = uax * ubx + uay * uby;
                if (Math.abs(dot) <= 1e-9 * la * lb && Math.abs(la - lb) <= 1e-6 && validateSeg && validateSeg(a, c)) {
                    pts.splice(i, 1); changed = true; break;
                }
                // Epsilon chord: b deviates < eps from line a-c and a-c stays
                // HV+45 -> collapse the staircase step (miter preserved).
                if (validateSeg) {
                    const acx = c.x - a.x, acy = c.y - a.y;
                    const lac = Math.hypot(acx, acy);
                    const dev = lac > 1e-9 ? Math.abs(uax * acy - uay * acx) / lac : Infinity;
                    if (dev < eps && validateSeg(a, c)) { pts.splice(i, 1); changed = true; break; }
                }
            }
            if (!changed) break;
        }
        return pts;
    },

    // ------------------------------------------------------------
    // Exact pre-commit validation (Story 1.4)
    // ------------------------------------------------------------

    // Validate a simplified polyline before it may be committed as a trace.
    // Fixed check order, first failure wins, structured reasons only (FR17/NFR9):
    //   1. INVALID_GEOMETRY — fewer than 2 finite points, consecutive duplicates,
    //      segment direction outside HV+45, self-intersection (any non-adjacent
    //      segment pair touching, segSegDistance < 1e-9), or a fold-back
    //      (consecutive collinear segments pointing opposite ways, e.g. [A,B,A]).
    //   2. BOARD_BOUNDARY — any point outside the edge-inset rectangle; inset =
    //      min(boardEdgeClearance, bw/4, bh/4), the same clamp as _initEdges.
    //   3. INVALID_GEOMETRY — width (options.width || rules.traceWidth) below
    //      params.minTraceWidth (manufacturing floor).
    //   4. CLEARANCE_VIOLATION — exact sweep using drc.js distances only
    //      (segSegDistance / pointSegDistance; no new distance math here):
    //      - other-net traces on the route layer: gap = dist - wA/2 - wB/2
    //        >= clearance (drc.js copper-to-copper convention, per-segment width);
    //      - pads of every component, both layers: required centerline distance
    //        padR + wA/2 + clearance (circle) / edge distance + wA/2 + clearance
    //        (polygon). Same-net exclusion via trace-derived getPinNet — the
    //        identical predicate buildObstacles uses, so search and gate agree;
    //      - SMD component bodies: BODY_OVERLAP if a route point lies in the
    //        rotated body interior or any segment comes within wA/2 of the body
    //        edge (copper would cut the footprint). TH components are exempt
    //        (body sits above the board plane); the component the route departs
    //        from is excluded, mirroring the same-net pad exclusion;
    //      - vias, both layers: diameter/2 + wA/2 + clearance.
    // FR25: while clean, a minimum copper gap below export.millToolDia records a
    // { type:'mill-gap', severity:'warning' } diagnostic — passes validation.
    validateRoute(ctx, points, net, options) {
        const o = options || {};
        const project = (ctx && ctx.project) || {};
        const rules = (ctx && ctx.rules) ? ctx.rules : this.resolveRules(project);
        const board = (ctx && ctx.board) || {};
        const bw = Number(board.width) > 0 ? Number(board.width) : 10;
        const bh = Number(board.height) > 0 ? Number(board.height) : 10;
        const wA = Number(o.width) > 0 ? Number(o.width) : rules.traceWidth;
        const clearance = rules.clearance;
        const params = project.params || {};
        const minTraceWidth = Number(params.minTraceWidth) > 0 ? Number(params.minTraceWidth) : 0.38;
        const EPS = 1e-6;
        const diagnostics = [];
        const bad = function (reason) { return { ok: false, reason: reason, diagnostics: diagnostics }; };

        // 1. Shape: finite points, no consecutive duplicates.
        if (!Array.isArray(points) || points.length < 2) return bad('INVALID_GEOMETRY');
        const pts = [];
        for (const p of points) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return bad('INVALID_GEOMETRY');
            const q = pts[pts.length - 1];
            if (q && Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9) return bad('INVALID_GEOMETRY');
            pts.push(p);
        }
        // Segment directions: H, V or exactly 45 degrees.
        for (let i = 0; i + 1 < pts.length; i++) {
            const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
            if (Math.hypot(dx, dy) < 1e-9) return bad('INVALID_GEOMETRY');
            const adx = Math.abs(dx), ady = Math.abs(dy);
            if (adx > 1e-9 && ady > 1e-9 && Math.abs(adx - ady) > EPS * Math.max(adx, ady)) return bad('INVALID_GEOMETRY');
        }
        // Self-intersection: non-adjacent segment pairs.
        for (let i = 0; i + 1 < pts.length; i++) {
            for (let j = i + 2; j + 1 < pts.length; j++) {
                if (segSegDistance(pts[i], pts[i + 1], pts[j], pts[j + 1]) < 1e-9) return bad('INVALID_GEOMETRY');
            }
        }
        // Fold-back: consecutive collinear segments pointing opposite ways
        // ([A,B,A]) overlap themselves — never a valid route.
        for (let i = 1; i + 1 < pts.length; i++) {
            const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y;
            const bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y;
            if (Math.abs(ax * by - ay * bx) <= EPS * Math.hypot(ax, ay) * Math.hypot(bx, by) && ax * bx + ay * by < 0) return bad('INVALID_GEOMETRY');
        }

        // 2. Board containment including the edge inset.
        const inset = Math.min(rules.boardEdgeClearance, bw / 4, bh / 4);
        const limX = bw / 2 - inset + EPS, limY = bh / 2 - inset + EPS;
        for (const p of pts) {
            if (Math.abs(p.x) > limX || Math.abs(p.y) > limY) return bad('BOARD_BOUNDARY');
        }

        // 3. Manufacturing width floor.
        if (wA < minTraceWidth - EPS) return bad('INVALID_GEOMETRY');

        // 4. Exact clearance sweep — mirrors buildObstacles' inflation model.
        const segs = [];
        for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
        let minGap = Infinity;

        // 4a. Other-net traces on the route layer.
        for (const tr of project.traces || []) {
            if ((tr.layer || 'top') !== rules.layer) continue;
            if (net && tr.net === net) continue;
            if (tr.schemWire) continue; // logical wire — no copper clearance needed
            const tpts = tr.points || [];
            for (let j = 0; j + 1 < tpts.length; j++) {
                const wB = (tr.segmentWidths && tr.segmentWidths[j]) || tr.width || 0.5;
                let dmin = Infinity;
                for (const s of segs) dmin = Math.min(dmin, segSegDistance(s[0], s[1], tpts[j], tpts[j + 1]));
                const gap = dmin - wA / 2 - wB / 2;
                if (gap < clearance - EPS) return bad('CLEARANCE_VIOLATION');
                minGap = Math.min(minGap, gap);
            }
        }

        // Component-size lookup shared by the pad sweep (4b) and body check (4c).
        const defHost = (typeof ComponentDefs !== 'undefined') ? { getCompSize: function (c) {
            const def = ComponentDefs.get(c.type);
            if (!def) return null;
            return ComponentDefs.getSize(def, c.size !== undefined ? c.size : (def.defaultSize || 0));
        } } : null;

        // 4b. Pads of every component (both layers), same-net pads excluded.
        const touch = Autoroute.NET_TOUCH || 0.15;
        if (defHost && typeof Export !== 'undefined') {
            for (const comp of project.components || []) {
                let pads = [];
                try { pads = Export.padFeatures(defHost, comp) || []; } catch (e) { pads = []; }
                const size = defHost.getCompSize(comp);
                const pins = (comp.pins && comp.pins.length) ? comp.pins : ((size && size.pins) || []);
                // Same-net exclusion is geometric + trace-derived (getPinNet):
                // a pad whose center sits on a same-net pin stays free. KiCad
                // pad order/count need not match the pins list.
                const netPins = [];
                if (net && typeof ProjectApi !== 'undefined') {
                    for (let pi = 0; pi < pins.length; pi++) {
                        if (!pins[pi] || ProjectApi.getPinNet(project, comp.id, pi) !== net) continue;
                        const wp = ProjectApi.pinWorld(project, comp.id, pi);
                        if (wp) netPins.push(wp);
                    }
                }
                for (let pi = 0; pi < pads.length; pi++) {
                    const pad = pads[pi];
                    const pcx = (pad.cx != null) ? pad.cx : pad.x;
                    const pcy = (pad.cy != null) ? pad.cy : pad.y;
                    let sameNetPad = false;
                    for (let k = 0; k < netPins.length && !sameNetPad; k++) {
                        if (Math.hypot(pcx - netPins[k].x, pcy - netPins[k].y) < touch) sameNetPad = true;
                    }
                    if (sameNetPad) continue;
                    let dmin = Infinity;
                    if (pad.kind === 'circle') {
                        for (const s of segs) dmin = Math.min(dmin, pointSegDistance(pad, s[0], s[1]) - pad.r);
                    } else if (pad.pts && pad.pts.length >= 3) {
                        for (let e = 0; e < pad.pts.length; e++) {
                            const p1 = pad.pts[e], p2 = pad.pts[(e + 1) % pad.pts.length];
                            for (const s of segs) dmin = Math.min(dmin, segSegDistance(s[0], s[1], p1, p2));
                        }
                    } else continue;
                    const gap = dmin - wA / 2;
                    if (gap < clearance - EPS) return bad('CLEARANCE_VIOLATION');
                    minGap = Math.min(minGap, gap);
                }
            }
        }

        // 4c. SMD component bodies — copper must not cut a surface-mount body.
        if (defHost) {
            const endPts = [pts[0], pts[pts.length - 1]];
            for (const comp of project.components || []) {
                const size = defHost.getCompSize(comp);
                if (!size || !(Number(size.width) > 0) || !(Number(size.height) > 0)) continue;
                if (size.th) continue; // through-hole — body sits above the board plane
                const cx = Number(comp.x) || 0, cy = Number(comp.y) || 0;
                const rot = ((Number(comp.rotation) || 0) * Math.PI) / 180;
                const cosR = Math.cos(rot), sinR = Math.sin(rot);
                // Route departs from one of this component's pins — excluded,
                // mirroring the same-net pad exclusion in 4b.
                const pins = (comp.pins && comp.pins.length) ? comp.pins : (size.pins || []);
                let endpointComp = false;
                for (const ep of endPts) {
                    for (const pin of pins) {
                        const px = cx + pin.x * cosR - pin.y * sinR;
                        const py = cy + pin.x * sinR + pin.y * cosR;
                        if (Math.hypot(ep.x - px, ep.y - py) < touch) endpointComp = true;
                    }
                }
                if (endpointComp) continue;
                const hw = size.width / 2, hh = size.height / 2;
                // Interior: any route point strictly inside the rotated body.
                for (const p of pts) {
                    const dx = p.x - cx, dy = p.y - cy;
                    const lx = dx * cosR + dy * sinR;
                    const ly = -dx * sinR + dy * cosR;
                    if (Math.abs(lx) < hw - EPS && Math.abs(ly) < hh - EPS) return bad('BODY_OVERLAP');
                }
                // Edge: any segment within wA/2 of the body boundary.
                const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (c) {
                    return { x: cx + c[0] * cosR - c[1] * sinR, y: cy + c[0] * sinR + c[1] * cosR };
                });
                for (let e = 0; e < 4; e++) {
                    const p1 = corners[e], p2 = corners[(e + 1) % 4];
                    let dmin = Infinity;
                    for (const s of segs) dmin = Math.min(dmin, segSegDistance(s[0], s[1], p1, p2));
                    if (dmin < wA / 2 - EPS) return bad('BODY_OVERLAP');
                }
            }
        }

        // 4d. Vias — through the board, so both layers.
        for (const v of project.vias || []) {
            const d = Number(v.diameter) > 0 ? Number(v.diameter) : 1.2;
            let dmin = Infinity;
            for (const s of segs) dmin = Math.min(dmin, pointSegDistance(v, s[0], s[1]) - d / 2);
            const gap = dmin - wA / 2;
            if (gap < clearance - EPS) return bad('CLEARANCE_VIOLATION');
            minGap = Math.min(minGap, gap);
        }

        // FR25: milling-gap warning — passes validation, records diagnostic.
        const millDia = Number(project.export && project.export.millToolDia) > 0 ? Number(project.export.millToolDia) : 0.2;
        if (minGap !== Infinity && minGap < millDia - EPS) {
            diagnostics.push({ type: 'mill-gap', severity: 'warning', gap: minGap });
        }
        return { ok: true, reason: null, diagnostics: diagnostics };
    },
    // ------------------------------------------------------------
    // Single-leg routing (schematic wire sync)
    // ------------------------------------------------------------

    // Route one pin-to-pin leg for a single net around pads/traces/bodies —
    // the primitive createSchemWire uses so board traces generated from
    // schematic wires do not cut through component bodies/pads or short a
    // neighbouring net. Endpoints are exact pad centers, which A* cannot
    // start/end on (pads/bodies block their own cells up to extent + expansion),
    // so a disk around each endpoint is freed first; its radius covers the
    // endpoint component's body ring and pads (options.endpoints = [{comp,
    // pinIndex} x2]) with a fixed fallback when that metadata is absent.
    // validateRoute's exact sweep remains the real gate. The candidate
    // trace is temporarily pushed onto project.traces during validation so the
    // trace-derived pad/body exclusions (getPinNet / NET_TOUCH) see it, and
    // popped again on failure — project is never mutated by a failed leg.
    // Returns { points, cost, bends } with endpoints snapped exactly to pa/pb
    // (HV+45 L-corners, same convention as route()), or null when no valid
    // path exists.
    routeLeg(project, pa, pb, options) {
        if (!project || !pa || !pb) return null;
        if (!Number.isFinite(pa.x) || !Number.isFinite(pa.y) || !Number.isFinite(pb.x) || !Number.isFinite(pb.y)) return null;
        const o = Object.assign({}, options);
        const net = (o && o.net) || null;
        const ctx = this.createContext(project, o);
        ctx.currentNet = net; // same-net pads/bodies stay free for departure/arrival
        this.buildObstacles(ctx);

        // Free the endpoint disks so A* can depart from / arrive at the pads.
        // The radius must cover everything buildObstacles blocks around the
        // endpoint component (body ring + pads, each inflated by expansion) —
        // a fixed radius is too small for big bodies (e.g. 3x3 gnd TP).
        const gs = ctx.grid.gridSize;
        const exp = ctx.rules.expansion;
        const host = {
            getCompSize: function (c) {
                const def = ComponentDefs.get(c.type);
                if (!def) return null;
                return ComponentDefs.getSize(def, c.size !== undefined ? c.size : (def.defaultSize || 0));
            }
        };
        const clearR = (p, meta) => {
            let r = exp + gs + 1.2; // fallback: typical pad-only extent
            if (!meta || !meta.comp) return r;
            const comp = meta.comp;
            const size = host.getCompSize(comp);
            if (!size) return r;
            const off = Math.hypot(p.x - comp.x, p.y - comp.y); // pin offset from body center
            r = Math.max(r, off + Math.hypot(size.width / 2, size.height / 2) + exp); // body ring outer
            let pads = [];
            try { pads = Export.padFeatures(host, comp) || []; } catch (e) { pads = []; }
            for (const pad of pads) {
                const pc = (pad.cx != null) ? { x: pad.cx, y: pad.cy } : pad;
                let pr = 0;
                if (pad.kind === 'circle') pr = pad.r;
                else if (pad.pts && pad.pts.length) for (const v of pad.pts) pr = Math.max(pr, Math.hypot(v.x - pc.x, v.y - pc.y));
                r = Math.max(r, Math.hypot(p.x - pc.x, p.y - pc.y) + pr + exp);
            }
            return r + gs;
        };
        const eps = (o.endpoints && o.endpoints.length === 2) ? o.endpoints : [null, null];
        for (let e = 0; e < 2; e++) {
            const p = (e === 0) ? pa : pb;
            const r = clearR(p, eps[e]);
            this._forEachCellInBox(ctx.grid, ctx.board, p.x - r, p.y - r, p.x + r, p.y + r, (ix, iy) => {
                const c = this._cellCenter(ctx.grid, ctx.board, ix, iy);
                if (Math.hypot(c.x - p.x, c.y - p.y) < r) ctx.grid.state[iy * ctx.grid.cols + ix] = 0;
            });
        }

        const raw = this.findPath(ctx.grid, pa.x, pa.y, pb.x, pb.y, o);
        if (!raw || !raw.points || raw.points.length === 0) return null;
        let pts = (raw.points.length === 1)
            ? [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }]
            : raw.points.map(p => ({ x: p.x, y: p.y }));
        const simplified = this.simplifyPath(pts);

        // Snap endpoints to the exact pad centers (HV+45 L-corners when the
        // direct end segment is off-angle — same convention as route()).
        const hv45 = (a, b) => {
            const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
            return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) <= 1e-6;
        };
        // True when a→b→c is not a straight reversal (a segment doubling back on
        // itself). Endpoint lead-ins must never create one.
        const noFoldBack = (a, b, c) => {
            const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
            const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
            if (la < 1e-9 || lb < 1e-9) return false;
            const collinear = Math.abs(ax * by - ay * bx) <= 1e-6 * la * lb;
            return !(collinear && ax * bx + ay * by < 0);
        };
        if (simplified.length === 2) {
            if (hv45(pa, pb)) {
                simplified[0] = { x: pa.x, y: pa.y };
                simplified[1] = { x: pb.x, y: pb.y };
            } else {
                simplified[0] = { x: pa.x, y: pa.y };
                simplified.splice(1, 0, { x: pb.x, y: pa.y });
                simplified[simplified.length - 1] = { x: pb.x, y: pb.y };
            }
        } else {
            // Replace the first cell point only when the NEW first segment
            // (pa -> second point) stays HV+45. If p0 is already an H/V run from
            // pa, just prepend pa; otherwise add a local L lead-in (one cell out)
            // so every committed segment is legal and the A* departure shape —
            // and its pad clearance — is preserved.
            const p0 = simplified[0];
            if (hv45(pa, simplified[1])) {
                simplified[0] = { x: pa.x, y: pa.y };
            } else if (hv45(pa, p0)) {
                simplified.splice(0, 0, { x: pa.x, y: pa.y });
            } else {
                // Two L orientations; prefer the corner that continues the
                // existing first segment rather than folding back on it.
                const c1 = { x: p0.x, y: pa.y }, c2 = { x: pa.x, y: p0.y };
                const nx = simplified[1];
                simplified.splice(0, 0, { x: pa.x, y: pa.y }, noFoldBack(c1, p0, nx) ? c1 : c2);
            }
            const last = simplified[simplified.length - 1];
            const r = simplified[simplified.length - 2];
            if (hv45(r, pb)) {
                simplified[simplified.length - 1] = { x: pb.x, y: pb.y };
            } else if (hv45(last, pb)) {
                simplified.splice(simplified.length, 0, { x: pb.x, y: pb.y });
            } else {
                const c1 = { x: last.x, y: pb.y }, c2 = { x: pb.x, y: last.y };
                simplified.splice(simplified.length, 0, noFoldBack(r, last, c1) ? c1 : c2, { x: pb.x, y: pb.y });
            }
        }

        // Exact validation with the candidate present so endpoint pads/bodies
        // are excluded (trace-derived membership). Popped again on failure.
        const cand = { id: -1, points: simplified, net: net, width: ctx.rules.traceWidth, layer: ctx.rules.layer };
        project.traces.push(cand);
        let v;
        try { v = this.validateRoute(ctx, simplified, net, o); }
        finally { project.traces.pop(); }
        if (!v.ok) return null;
        return { points: simplified, cost: raw.cost, bends: raw.bends };
    },

    // ------------------------------------------------------------
    // Whole-board routing (Story 1.5)
    // ------------------------------------------------------------

    // Route all routable nets in planned order (planNets). For each net, every
    // target routes from the root pin (star topology): findPath -> simplifyPath
    // -> validateRoute. A route commits via ProjectApi.addTrace only after full
    // validation; committed traces feed back into later nets' obstacle map and
    // clearance checks through project.traces. Unvalidated geometry never
    // touches the project. Transactional at run level: the caller wraps one
    // run in a single saveState() = one undo step.
    // Options: stage options + shouldCancel() -> bool (checked at net
    // boundaries) and onProgress({ done, total, net }) (after each net).
    // Returns { success, routedNets[], failedNets[{net, reason}], diagnostics[] };
    // routing failure is a structured result, never a thrown exception.
    route(project, options) {
        const o = options || {};
        const P = ProjectApi;
        // Segment angle inside {0, 45, 90} deg (same convention as validateRoute).
        const hv45 = (a, b) => {
            const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
            return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) <= 1e-6;
        };
        // True when a→b→c is not a straight reversal (a segment doubling back on
        // itself). Endpoint lead-ins must never create one.
        const noFoldBack = (a, b, c) => {
            const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
            const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
            if (la < 1e-9 || lb < 1e-9) return false;
            const collinear = Math.abs(ax * by - ay * bx) <= 1e-6 * la * lb;
            return !(collinear && ax * bx + ay * by < 0);
        };
        const ctx = this.createContext(project, o);
        const planned = this.planNets(project, o);
        let nets = planned.nets;
        const routedNets = [];
        const failedNets = [];
        const diagnostics = (planned.diagnostics || []).slice();
        // skipRouted: leave already-routed nets alone. "Already routed" means
        // the net's pads are fully joined by same-layer copper — a net with
        // only partial copper is still incomplete and must be completed,
        // otherwise its remaining schematic wires never get traces.
        if (o.skipRouted) {
            const layer = ctx.rules.layer;
            const kept = [];
            for (let i = 0; i < nets.length; i++) {
                if (this.isFullyWired(project, nets[i].name, layer)) {
                    diagnostics.push({ code: 'SKIPPED_ROUTED', net: nets[i].name });
                } else kept.push(nets[i]);
            }
            nets = kept;
        }
        // onlyNet: route a single named net (UI yields between nets; Epic 3).
        if (o.onlyNet) {
            const want = String(o.onlyNet);
            const kept = [];
            for (let i = 0; i < nets.length; i++) if (nets[i].name === want) kept.push(nets[i]);
            nets = kept;
        }
        let canceled = false;
        let processed = 0;

        for (let i = 0; i < nets.length; i++) {
            if (typeof o.shouldCancel === 'function' && o.shouldCancel()) { canceled = true; break; }
            const entry = nets[i];
            ctx.currentNet = entry.name;
            this.buildObstacles(ctx);

            // Departure/arrival. Each end is the point on THAT pad's existing
            // same-net copper closest to the other end — not the far tip of
            // the stub. Routing to the far tip laid a second trace along copper
            // that was already there. A pad with no copper uses its centre.
            const closestOnSeg = (p, a, b) => {
                const dx = b.x - a.x, dy = b.y - a.y;
                const len2 = dx * dx + dy * dy;
                if (len2 < 1e-12) return { x: a.x, y: a.y };
                let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
                t = Math.max(0, Math.min(1, t));
                return { x: a.x + t * dx, y: a.y + t * dy };
            };
            const nearPoint = (px, py, toward) => {
                let best = null, bd = Infinity;
                const touch = Autoroute.NET_TOUCH;
                for (let ti = 0; ti < project.traces.length; ti++) {
                    const t = project.traces[ti];
                    if (t.net !== entry.name || t.schemWire) continue;
                    if ((t.layer || 'top') !== ctx.rules.layer) continue;
                    const pts = t.points || [];
                    if (pts.length < 2) continue;
                    let touches = false;
                    for (let s = 0; s + 1 < pts.length; s++) {
                        if (pointSegDistance({ x: px, y: py }, pts[s], pts[s + 1]) < touch) { touches = true; break; }
                    }
                    if (!touches) continue;
                    for (let s = 0; s + 1 < pts.length; s++) {
                        const q = closestOnSeg(toward, pts[s], pts[s + 1]);
                        const d = Math.hypot(q.x - toward.x, q.y - toward.y);
                        if (d < bd - 1e-9) { bd = d; best = q; }
                    }
                }
                return best || { x: px, y: py };
            };
            // Spanning-tree topology (CAP-7): grow a minimum spanning tree over
            // the net's nodes (root + targets) and route each tree edge as a
            // pin-to-pin leg. Each edge's `from` node is already in the tree, so
            // its leg runs between the nearest points on each node's copper —
            // multi-pin nets no longer collide at one shared root pad. First
            // failing edge ends the net (its reason wins);
            // segments already validated for earlier edges still commit.
            const nodes = [entry.root].concat(entry.targets);
            const edges = this.mstEdges(nodes);
            let reason = null;
            const segments = [];

            const routeLeg = (startPt, endPt) => {
                if (!startPt || !endPt) return { committed: null, fail: 'NO_PATH' };
                // Already electrically adjacent (both ends on the same stub):
                // nothing to route — a zero-length trace is just noise.
                if (Math.hypot(startPt.x - endPt.x, startPt.y - endPt.y) < Autoroute.NET_TOUCH) return { committed: null, fail: null };
                // Candidate sources in priority order: the schematic wire hint
                // (designer's preferred path), then a fresh A* search. The hint
                // is only a shortcut — its geometry may be stale (components
                // moved since the wire was drawn), so a rejected hint falls
                // back to A* instead of failing the net.
                const sources = [];
                const hint = this.wireHint(project, entry.name, startPt, endPt);
                if (hint && Array.isArray(hint.points) && hint.points.length >= 2) sources.push(hint.points);
                let lastFail = 'NO_PATH';
                let committed = null;
                // One candidate pipeline: simplify (miters gated on exact
                // validation), snap endpoints to the free ends, validate.
                const tryPath = (rawPts) => {
                    if (!rawPts || rawPts.length === 0) { lastFail = 'NO_PATH'; return null; }
                    let points = null;
                    if (rawPts.length >= 2) points = rawPts;
                    else {
                        // Departure and arrival in one grid cell: direct stub.
                        points = [{ x: startPt.x, y: startPt.y }, { x: endPt.x, y: endPt.y }];
                    }
                    const simplified = this.simplifyPath(points, {
                        validateSegment: (a, c) => this.validateRoute(ctx, [a, c], entry.name, o).ok
                    });
                // Snap endpoints to the exact free ends so the committed trace
                // is electrically continuous with the stub (A* emits cell
                // centers). Direct snap only when the end segment stays HV+45;
                // off-grid free ends get one L-corner inserted (H-then-V at the
                // start, V-then-H at the end) so every committed segment is
                // legal and the net links up exactly. Validation judges
                // clearance as usual — a corner that violates never commits.
                if (simplified.length === 2) {
                    if (hv45(startPt, endPt)) {
                        simplified[0] = { x: startPt.x, y: startPt.y };
                        simplified[1] = { x: endPt.x, y: endPt.y };
                    } else {
                        simplified[0] = { x: startPt.x, y: startPt.y };
                        simplified.splice(1, 0, { x: endPt.x, y: startPt.y });
                        simplified[simplified.length - 1] = { x: endPt.x, y: endPt.y };
                    }
                } else {
                    // Replace the first/last cell point only when the NEW end
                    // segment (checked against the adjacent inner point) stays
                    // HV+45. If the outer point is already an H/V run from the
                    // endpoint, just prepend/append it; otherwise add a local L
                    // lead-in (one cell out) so every committed segment is legal
                    // and the A* departure shape — and its pad clearance — is
                    // preserved.
                    const p0 = simplified[0];
                    if (hv45(startPt, simplified[1])) {
                        simplified[0] = { x: startPt.x, y: startPt.y };
                    } else if (hv45(startPt, p0)) {
                        simplified.splice(0, 0, { x: startPt.x, y: startPt.y });
                    } else {
                        // Two L orientations; the one whose second leg folds back
                        // against the existing first segment is never a valid
                        // route, so prefer the continuing corner.
                        const c1 = { x: p0.x, y: startPt.y }, c2 = { x: startPt.x, y: p0.y };
                        const nx = simplified[1];
                        const c = noFoldBack(c1, p0, nx) ? c1 : c2;
                        simplified.splice(0, 0, { x: startPt.x, y: startPt.y }, c);
                    }
                    const last = simplified[simplified.length - 1];
                    const r = simplified[simplified.length - 2];
                    if (hv45(r, endPt)) {
                        simplified[simplified.length - 1] = { x: endPt.x, y: endPt.y };
                    } else if (hv45(last, endPt)) {
                        simplified.splice(simplified.length, 0, { x: endPt.x, y: endPt.y });
                    } else {
                        const c1 = { x: last.x, y: endPt.y }, c2 = { x: endPt.x, y: last.y };
                        const c = noFoldBack(r, last, c1) ? c1 : c2;
                        simplified.splice(simplified.length, 0, c, { x: endPt.x, y: endPt.y });
                    }
                }
                    const v = this.validateRoute(ctx, simplified, entry.name, o);
                    if (!v.ok) { lastFail = v.reason || 'INVALID_GEOMETRY'; return null; }
                    for (let d = 0; d < v.diagnostics.length; d++) diagnostics.push(v.diagnostics[d]);
                    return simplified;
                };
                for (let si = 0; si < sources.length && !committed; si++) committed = tryPath(sources[si]);
                // A* fallback: normal grid first. If the path exists but fails
                // clearance — usually endpoint-snap corners grazing a pad —
                // retry once on a grid inflated by 0.5mm so the search keeps
                // extra room from obstacles. The exact gate (original rules)
                // still judges the committed geometry.
                for (let wide = 0; wide < 2 && !committed; wide++) {
                    const aCtx = wide === 0 ? ctx : this.wideGridCtx(ctx);
                    const rawPts = (this.findPath(aCtx.grid, startPt.x, startPt.y, endPt.x, endPt.y, o) || {}).points;
                    committed = tryPath(rawPts);
                    if (!committed && lastFail !== 'CLEARANCE_VIOLATION') break;
                }
                if (!committed) return { committed: null, fail: lastFail };
                return { committed: committed, fail: null };
            };

            for (let ei = 0; ei < edges.length && !reason; ei++) {
                const startPt = nearPoint(edges[ei].from.x, edges[ei].from.y, { x: edges[ei].to.x, y: edges[ei].to.y });
                const endPt = nearPoint(edges[ei].to.x, edges[ei].to.y, startPt);
                const leg = routeLeg(startPt, endPt);
                if (leg.fail) { reason = leg.fail; break; }
                if (leg.committed) segments.push(leg.committed);
            }

            for (let si = 0; si < segments.length; si++) {
                // Drop any run that already lies on this net's copper. A* may
                // still walk along same-net copper (it is not an obstacle);
                // committing that walk would stack a second trace on the first.
                const segs = P._sameNetSegs(project, entry.name, ctx.rules.layer);
                const pieces = P.uncoveredPieces(segments[si], segs, Math.max(0.2, ctx.grid.gridSize * 0.6));
                for (let pi = 0; pi < pieces.length; pi++) {
                    if (P._polyLen(pieces[pi]) < Autoroute.NET_TOUCH) continue;
                    try {
                        ctx.routedTraces.push(P.addTrace(project, {
                            points: pieces[pi], net: entry.name,
                            width: ctx.rules.traceWidth, layer: ctx.rules.layer
                        }));
                    } catch (e) {
                        reason = 'CLEARANCE_VIOLATION';
                        break;
                    }
                }
                if (reason) break;
            }
            if (reason) { failedNets.push({ net: entry.name, reason: reason }); diagnostics.push({ code: reason, net: entry.name }); }
            else routedNets.push(entry.name);
            processed++;

            if (typeof o.onProgress === 'function') o.onProgress({ done: i + 1, total: nets.length, net: entry.name });
        }

        // Global checks after all nets (FR15). Connectivity over the nets this
        // run claims to have routed; shorts over every trace pair. Violations
        // keep their traces and report — the caller's single undo reverts all.
        let globalViolations = 0;
        const conn = this.validateConnectivity(project, o);
        for (let ci = 0; ci < conn.disconnected.length; ci++) {
            if (routedNets.indexOf(conn.disconnected[ci]) >= 0) {
                diagnostics.push({ code: 'NET_DISCONNECTED', net: conn.disconnected[ci] });
                globalViolations++;
            }
        }
        const shorts = this.detectShorts(project, o);
        for (let si = 0; si < shorts.length; si++) { diagnostics.push(shorts[si]); globalViolations++; }

        if (canceled) diagnostics.push({ code: 'CANCELED', done: processed, total: nets.length });

        const success = !canceled && failedNets.length === 0 && globalViolations === 0;
        return { success: success, routedNets: routedNets, failedNets: failedNets, diagnostics: diagnostics };
    },

    // Global connectivity check (FR15): a net is disconnected when its members
    // still span > 1 component — i.e. planNets would still list it as routable.
    // Returns { ok, disconnected: [netName...] } in planNets order.
    validateConnectivity(project, options) {
        const r = this.planNets(project, options);
        const disconnected = [];
        for (let i = 0; i < r.nets.length; i++) disconnected.push(r.nets[i].name);
        return { ok: disconnected.length === 0, disconnected: disconnected };
    },

    // Route hint from schematic wires: a logical wire on this net whose both
    // ends touch startPt/endPt (NET_TOUCH, same predicate as getPinNet) is the
    // designer's preferred copper path. Returns { points } ordered start->end,
    // or null when no such wire exists.
    wireHint(project, net, startPt, endPt) {
        const eps = Autoroute.NET_TOUCH;
        for (const tr of project.traces || []) {
            if (!tr.schemWire || tr.net !== net) continue;
            const pts = tr.points || [];
            if (pts.length < 2) continue;
            const f = pts[0], l = pts[pts.length - 1];
            const touchS = Math.hypot(f.x - startPt.x, f.y - startPt.y) < eps ||
                           Math.hypot(l.x - startPt.x, l.y - startPt.y) < eps;
            const touchE = Math.hypot(f.x - endPt.x, f.y - endPt.y) < eps ||
                           Math.hypot(l.x - endPt.x, l.y - endPt.y) < eps;
            if (!touchS || !touchE) continue;
            // Order the wire so it runs start -> end.
            let ordered = pts;
            if (Math.hypot(f.x - startPt.x, f.y - startPt.y) > Math.hypot(l.x - startPt.x, l.y - startPt.y)) {
                ordered = pts.slice().reverse();
            }
            const interior = ordered.slice(1, -1);
            const raw = [{ x: startPt.x, y: startPt.y }].concat(interior, [{ x: endPt.x, y: endPt.y }]);
            // Schematic wires may contain diagonal segments (drawn freely in the
            // schematic). Copper must be HV+45, so replace each diagonal with a
            // single elbow (longer leg first) before using it as a hint —
            // validateRoute still judges clearance/geometry.
            const out = [];
            for (let i = 0; i < raw.length - 1; i++) {
                if (!out.length) out.push(raw[i]);
                const p0 = out[out.length - 1], p1 = raw[i + 1];
                const dx = p1.x - p0.x, dy = p1.y - p0.y;
                if (Math.abs(dx) > 1e-6 && Math.abs(dy) > 1e-6) {
                    out.push(Math.abs(dx) >= Math.abs(dy) ? { x: p1.x, y: p0.y } : { x: p0.x, y: p1.y });
                }
                out.push(p1);
            }
            return { points: out };
        }
        return null;
    },

    // Shallow ctx copy whose obstacle grid is rebuilt with clearance inflated
    // by 0.5mm — used for the single A* retry when a valid path's endpoint
    // corners violate clearance. validateRoute always judges on the original
    // rules, so the gate stays exact.
    wideGridCtx(ctx) {
        const wide = Object.assign({}, ctx, {
            rules: Object.assign({}, ctx.rules, { clearance: (Number(ctx.rules.clearance) || 0.38) + 0.5 })
        });
        this.buildObstacles(wide);
        return wide;
    },

    // Global short check (FR15): different-net traces on the same layer whose
    // copper gap falls below the routing clearance — exactly drc.js's formula.
    // One entry per violating trace pair (min gap over all segment pairs), in
    // project.traces order: [{ code: 'SHORT', netA, netB, gap }].
    detectShorts(project, options) {
        const out = [];
        if (typeof segSegDistance !== 'function') return out; // partial loads
        const rules = this.resolveRules(project, options);
        const traces = (project && project.traces) || [];
        for (let a = 0; a < traces.length; a++) {
            const tA = traces[a];
            const ptsA = tA.points || [];
            if (ptsA.length < 2) continue;
            for (let b = a + 1; b < traces.length; b++) {
                const tB = traces[b];
                if ((tA.layer || 'top') !== (tB.layer || 'top')) continue;
                if (tA.net && tA.net === tB.net) continue; // same net = connected, skip (unnetted pairs are checked)
                if (tA.schemWire || tB.schemWire) continue; // logical wires are not copper
                const ptsB = tB.points || [];
                if (ptsB.length < 2) continue;
                let minGap = Infinity;
                for (let i = 0; i + 1 < ptsA.length; i++) {
                    const wA = (tA.segmentWidths && tA.segmentWidths[i]) || tA.width || 0.5;
                    for (let j = 0; j + 1 < ptsB.length; j++) {
                        const wB = (tB.segmentWidths && tB.segmentWidths[j]) || tB.width || 0.5;
                        const gap = segSegDistance(ptsA[i], ptsA[i + 1], ptsB[j], ptsB[j + 1]) - wA / 2 - wB / 2;
                        if (gap < minGap) minGap = gap;
                    }
                }
                if (minGap < rules.clearance - 1e-6) out.push({ code: 'SHORT', netA: tA.net, netB: tB.net, gap: minGap });
            }
        }
        return out;
    },

    // ------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------

    // Trace<->trace connection: any endpoint of one within NET_TOUCH of any
    // segment of the other (either direction).
    _tracesTouch(pa, pb) {
        const t = Autoroute.NET_TOUCH;
        const touch = (e, segs) => {
            for (let i = 0; i + 1 < segs.length; i++)
                if (pointSegDistance(e, segs[i], segs[i + 1]) < t) return true;
            return false;
        };
        const ea = [pa[0], pa[pa.length - 1]];
        const eb = [pb[0], pb[pb.length - 1]];
        for (const e of ea) if (e && touch(e, pb)) return true;
        for (const e of eb) if (e && touch(e, pa)) return true;
        // Degenerate polylines (< 2 points) have no segments — endpoint distance.
        for (const e of ea) for (const q of eb)
            if (e && q && Math.hypot(e.x - q.x, e.y - q.y) < t) return true;
        return false;
    },

    _initEdges(state, cols, rows, gs, bw, bh, boardEdge) {
        const inset = Math.min(boardEdge, bw / 4, bh / 4);
        for (let iy = 0; iy < rows; iy++) {
            const cy = (iy + 0.5) * gs - bh / 2;
            const outY = cy < -bh / 2 + inset || cy > bh / 2 - inset;
            let i = iy * cols;
            for (let ix = 0; ix < cols; ix++) {
                const cx = (ix + 0.5) * gs - bw / 2;
                state[i + ix] = (outY || cx < -bw / 2 + inset || cx > bw / 2 - inset) ? 1 : 0;
            }
        }
    },

    _cellCenter(grid, board, ix, iy) {
        return { x: (ix + 0.5) * grid.gridSize - board.width / 2, y: (iy + 0.5) * grid.gridSize - board.height / 2 };
    },

    // Call fn(ix, iy) for every cell whose center may fall inside [minX..maxX] x [minY..maxY].
    _forEachCellInBox(grid, board, minX, minY, maxX, maxY, fn) {
        const gs = grid.gridSize;
        const ix0 = Math.max(0, Math.floor((minX + board.width / 2) / gs));
        const ix1 = Math.min(grid.cols - 1, Math.floor((maxX + board.width / 2) / gs));
        const iy0 = Math.max(0, Math.floor((minY + board.height / 2) / gs));
        const iy1 = Math.min(grid.rows - 1, Math.floor((maxY + board.height / 2) / gs));
        for (let iy = iy0; iy <= iy1; iy++) {
            for (let ix = ix0; ix <= ix1; ix++) fn(ix, iy);
        }
    },

    // Block cells whose center is within thresh of segment (ax,ay)-(bx,by).
    _markSeg(grid, board, ax, ay, bx, by, thresh) {
        const A = { x: ax, y: ay }, B = { x: bx, y: by };
        this._forEachCellInBox(grid, board, Math.min(ax, bx) - thresh, Math.min(ay, by) - thresh,
            Math.max(ax, bx) + thresh, Math.max(ay, by) + thresh, (ix, iy) => {
                const i = iy * grid.cols + ix;
                if (grid.state[i] !== 0) return; // keep already-blocked cells as-is
                if (pointSegDistance(this._cellCenter(grid, board, ix, iy), A, B) < thresh) grid.state[i] = 1;
            });
    },

    // Block cells whose center is within r of circle center (x,y).
    _markCircle(grid, board, x, y, r) {
        this._forEachCellInBox(grid, board, x - r, y - r, x + r, y + r, (ix, iy) => {
            const i = iy * grid.cols + ix;
            if (grid.state[i] !== 0) return;
            const c = this._cellCenter(grid, board, ix, iy);
            if (Math.hypot(c.x - x, c.y - y) < r) grid.state[i] = 1;
        });
    },

    // Block cells whose center is within thresh of any edge of polygon pts.
    _markPoly(grid, board, pts, thresh) {
        for (let e = 0; e < pts.length; e++) {
            const a = pts[e], b = pts[(e + 1) % pts.length];
            this._markSeg(grid, board, a.x, a.y, b.x, b.y, thresh);
        }
    }
};

// Node: export for tests. Browser: global `Autoroute`.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Autoroute;
}