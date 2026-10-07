// ============================================================
// PCB Editor - Core State & Orchestration
// ============================================================

const App = {
    board: { width: 100, height: 80, thickness: 1.2, copperWeight: 1, material: 'FR4' },
    params: { traceWidth: 0.5, viaDiameter: 1.0, gridSize: 1.0, minTraceWidth: 0.38, minDrill: 0.1, minClearance: 0.38, jumperFollow: 'pads', routeAngle: 'hv45', showRulers: true, schemSnap: true, autoroute: { gridSize: 0.1, layer: 'top', skipRouted: true } },
    export: {
        kerfWidth: 0.15, units: 'mm',
        includeHoles: true, includeTraces: true, includeComps: true,
        includeBoardOutline: true, includeCopperOutlines: true,
        layers: { COPPER_TOP: true, COPPER_BOTTOM: false, TRACE_OUTLINE_TOP: false, TRACE_OUTLINE_BOTTOM: false, TRACE_TOP: false, TRACE_BOTTOM: false, PAD_TOP: false, PAD_BOTTOM: false },
        millToolDia: 0.2, millIsoDepth: 0.1, millSafeZ: 5,
        millFeed: 120, millPlunge: 50, millSpindle: 10000,
        millDrillToolDia: 0.8, millOutlineToolDia: 0.2,
        millDrillFeed: 50, millOutlineFeed: 72,
        millOutlinePasses: 3, millOutlineOvercut: 0, millDrillOvercut: 0.1,
        millSpindleDwell: 2, millProfile: 'grbl',
        dxfMode: 'standard',
        mirror: false  // flip board left-right (other-side view) for DXF/gCode output
    },

    traces: [],
    components: [],
    vias: [],
    boardOutline: [],
    silkTexts: [],
    requirements: null,
    zones: [],
    assignments: {},
    flowDirection: 'lr',
    netlist: {},
    groups: [],

    nets: [
        { name: 'VCC', color: '#ff4444' },
        { name: 'GND', color: '#44ff44' },
        { name: 'SIG1', color: '#4488ff' }
    ],

    view: {
        mode: 'board', tool: 'select', zoom: 1, panX: 0, panY: 0,
        activeLayer: 'top',
        visibleLayers: { top: true, bottom: false, silkTop: true, silkBottom: false, outline: true },
        schemZoom: 1, schemPanX: 0, schemPanY: 0
    },

    interaction: {
        isPanning: false, panStartX: 0, panStartY: 0,
        tracePoints: [], outlinePoints: [],
        selectedObject: null, placingComponent: null, placingSize: {},
        draggingComp: null, dragOffsetX: 0, dragOffsetY: 0,
        draggingJumperEnd: null, // { compId, holeIndex } — stretch a wire jumper like a trace vertex
        contextTarget: null, hoveredComp: null,
        previewFlashIds: null, // object ids flashed by agent-preview (MCP live view)
        lastMouseX: 0, lastMouseY: 0,
        draggingTraceVertex: null, // { traceId, pointIndex }
        hoveredTraceVertex: null,  // { traceId, pointIndex }
        hoveredSegment: null,      // { traceId, segIndex }
        selectedSegment: null,     // { traceId, segIndex } - highlighted on selection
        selectedVertices: [],      // [{ traceId, pointIndex }] multi-selected joints (board)
        draggingSegment: null,     // { traceId, segIndex, axis, startX, startY, origP0, origP1 }
        traceSnapKind: 'grid',
        // Schematic interaction state
        schemWireStart: null,       // { compId, pinIndex } first pin of wire
        schemWireInterior: [],      // intermediate points collected while drawing a schematic wire (world)
        schemWireCursor: null,      // live cursor for wire preview { x, y, snapped } (world)
        schemDraggingComp: null,    // component being dragged in schematic
        schemHoveredPin: null,      // { compId, pinIndex, x, y } cursor feedback
        schemSelectedWires: [],     // [trace] multi-selected wires for group drag
        schemSelectedJoint: null,    // { traceId, waypointIndex } selected schematic joint
        schemDraggingSeg: null,      // { traceId, segIndex, axis, origP0, origP1 } segment-slide drag
        schemPinPositions: [],      // [{ compId, pinIndex, sx, sy }] screen positions from last render
        schemPlacingPos: null,      // { x, y } cursor world position while placing a component in schematic view
        placingRotation: 0,         // rotation for component being placed (board)
        _placingOnCanvas: false,   // true once mouse has entered canvas during placement
        _placePreview: null,       // { x, y, lineX, lineY, sizeIdx, pins } ghost position while placing
        _dragAlign: null,          // { lineX, lineY } alignment guides while dragging a component
        clipboard: null             // copied component for Ctrl+C/V
    },

    undoStack: [], redoStack: [], idCounter: 0,
    projectMeta: null, // { id, title, description } of the loaded/saved project (null = unsaved)
    boardCanvas: null, schematicCanvas: null, boardCtx: null, schemCtx: null,

    init() {
        this.boardCanvas = document.getElementById('board-canvas');
        this.schematicCanvas = document.getElementById('schematic-canvas');
        this.boardCtx = this.boardCanvas.getContext('2d');
        this.schemCtx = this.schematicCanvas.getContext('2d');
        this.resizeCanvases();
        this.autoLoad();
        if (this.updateNetsList) this.updateNetsList(); // reflect loaded nets (incl. supply voltages)
        this.bindEvents();
        this.bindSchemCanvasEvents();
        this.ensureLabels();
        this.ensureAllCompSilkLayouts();
        this.saveState();
        this.fitToView();
    },

    resizeCanvases() {
        const container = document.getElementById('canvas-container');
        const w = container.clientWidth, h = container.clientHeight;
        [this.boardCanvas, this.schematicCanvas].forEach(c => { c.width = w; c.height = h; });
    },

    screenToWorld(sx, sy) {
        const cx = this.boardCanvas.width / 2, cy = this.boardCanvas.height / 2;
        return { x: (sx - cx) / this.view.zoom + this.view.panX, y: (sy - cy) / this.view.zoom + this.view.panY };
    },

    worldToScreen(wx, wy) {
        const cx = this.boardCanvas.width / 2, cy = this.boardCanvas.height / 2;
        return { x: (wx - this.view.panX) * this.view.zoom + cx, y: (wy - this.view.panY) * this.view.zoom + cy };
    },

    schemScreenToWorld(sx, sy) {
        const cx = this.schematicCanvas.width / 2, cy = this.schematicCanvas.height / 2;
        return { x: (sx - cx) / this.view.schemZoom + this.view.schemPanX, y: (sy - cy) / this.view.schemZoom + this.view.schemPanY };
    },

    schemWorldToScreen(wx, wy) {
        const cx = this.schematicCanvas.width / 2, cy = this.schematicCanvas.height / 2;
        return { x: (wx - this.view.schemPanX) * this.view.schemZoom + cx, y: (wy - this.view.schemPanY) * this.view.schemZoom + cy };
    },

    // Local pin definitions for a component (board mm, relative to center).
    getCompPins(comp) {
        if (comp && comp.pins && comp.pins.length) return comp.pins;
        const def = ComponentDefs.get(comp.type);
        if (!def || !def.sizes) return [];
        const size = ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
        return size ? size.pins : [];
    },

    // World (board mm) position of a specific pin, accounting for rotation.
    pinBoardPos(comp, pinIndex) {
        const pins = this.getCompPins(comp);
        const pin = pins[pinIndex];
        if (!pin) return null;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return { x: comp.x + pin.x * cos - pin.y * sin, y: comp.y + pin.x * sin + pin.y * cos };
    },

    // Assign schematic positions to any component missing schemX/schemY.
    // Topology-aware (net BFS + role buckets); never moves saved coordinates.
    ensureSchemPositions() {
        SchematicLayout.placeMissing(this.components, this.traces, this.netlist);
        this._schemWireCache = null;
    },

    // Ensure every component has a designator label (R1, C2, U1...).
    ensureLabels() {
        const counts = {};
        this.components.forEach(comp => {
            if (comp.label) return;
            const def = ComponentDefs.get(comp.type);
            const prefix = def ? def.prefix : 'X';
            counts[comp.type] = (counts[comp.type] || 0) + 1;
            comp.label = prefix + counts[comp.type];
        });
    },

    // Default silk label/value positions in component-local mm (unrotated, Y-down).
    // Normalizes in place so legacy/invalid values migrate on load/draw/export:
    // string/number/null → default object; bad rotation/fontSize dropped.
    // Stock defaults (x≈0, |y|≈hh+0.35) are lifted so the glyph clears the body.
    ensureCompSilkLayout(comp) {
        const size = this.getCompSize(comp);
        if (!size) return;
        const hh = size.height / 2;
        const gap = this.compSilkClearance(size);
        const dy = hh + gap;
        const oldDy = hh + 0.35;
        const farDy = hh + this.compSilkFontSize(size) * 0.65 + 0.4;
        const norm = (cur, sign) => {
            const defY = sign * dy;
            if (typeof cur !== 'object' || cur === null) return { x: 0, y: defY };
            if (typeof cur.x !== 'number' || !isFinite(cur.x)) cur.x = 0;
            if (typeof cur.y !== 'number' || !isFinite(cur.y)) cur.y = defY;
            if (typeof cur.rotation !== 'number' || !isFinite(cur.rotation)) delete cur.rotation;
            if (typeof cur.fontSize !== 'number' || !isFinite(cur.fontSize) || cur.fontSize <= 0) delete cur.fontSize;
            const stock = Math.abs(cur.y - sign * oldDy) < 0.08 || Math.abs(cur.y - sign * farDy) < 0.12;
            if (Math.abs(cur.x) < 0.05 && stock) cur.y = defY;
            return cur;
        };
        comp.silkLabel = norm(comp.silkLabel, -1);
        comp.silkValue = norm(comp.silkValue, 1);
    },

    ensureAllCompSilkLayouts() {
        this.components.forEach(comp => this.ensureCompSilkLayout(comp));
    },

    compSilkLocalToWorld(comp, lx, ly) {
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return { x: comp.x + lx * cos - ly * sin, y: comp.y + lx * sin + ly * cos };
    },

    compSilkWorldToLocal(comp, wx, wy) {
        const dx = wx - comp.x, dy = wy - comp.y;
        const rad = -(comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    },

    compSilkFontSize(size) {
        const span = Math.max(size.width || 0, size.height || 0, 0.8);
        return Math.max(0.7, Math.min(1.6, span * 0.14));
    },

    // Gap from body edge to silk baseline so the glyph sits fully outside.
    compSilkClearance(size) {
        return this.compSilkFontSize(size) * 0.35 + 0.18;
    },

    // Effective font size for a silk field: explicit per-label override wins, else auto.
    compSilkEffectiveFontSize(pos, size) {
        if (pos && typeof pos.fontSize === 'number' && isFinite(pos.fontSize) && pos.fontSize > 0) return pos.fontSize;
        return this.compSilkFontSize(size);
    },

    snapToGrid(val) {
        const g = this.params.gridSize;
        return Math.round(val / g) * g;
    },

    getCompSize(comp) {
        const def = ComponentDefs.get(comp.type);
        if (def && def.sizes) return ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
        // Placed parts copy their pins onto the component. Draw from those when
        // the kx_* footprint has not been installed in this page yet.
        const pins = comp && comp.pins;
        if (!pins || !pins.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < pins.length; i++) {
            const p = pins[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        if (!isFinite(minX)) return null;
        return {
            name: comp.type || 'part',
            width: Math.max(maxX - minX, 0.8) + 1.6,
            height: Math.max(maxY - minY, 0.8) + 1.6,
            pins: pins
        };
    },

    snapToPin(wx, wy) {
        const threshold = 2.0 / this.view.zoom + 1.5;
        let bestDist = Infinity, bestPin = null;
        for (const comp of this.components) {
            const size = this.getCompSize(comp);
            if (!size) continue;
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            for (const pin of ((comp.pins && comp.pins.length) ? comp.pins : size.pins)) {
                const px = comp.x + pin.x * cos - pin.y * sin;
                const py = comp.y + pin.x * sin + pin.y * cos;
                const d = Math.sqrt((wx - px) ** 2 + (wy - py) ** 2);
                if (d < threshold && d < bestDist) {
                    bestDist = d;
                    bestPin = { x: px, y: py };
                }
            }
        }
        return bestPin;
    },

    // Snap to pad, via, existing vertex, or the edge of another trace (for T-joins).
    // Closest candidate wins. preferTrace: a nearby copper run beats a distant pad.
    snapToCopper(wx, wy, opts) {
        const exceptId = opts && opts.exceptId;
        const layer = opts && opts.layer;
        const preferTrace = !!(opts && opts.preferTrace);
        const draw = !!(opts && opts.draw);
        const pinThresh = preferTrace ? Math.max(6 / this.view.zoom, 0.8) : (2.0 / this.view.zoom + 1.5);
        const vThresh = Math.max((draw ? 12 : 8) / this.view.zoom, draw ? 1.1 : 0.9);
        const eThresh = Math.max((draw ? 12 : 8) / this.view.zoom, (this.params.traceWidth || 0.5) * (draw ? 2 : 1.5));
        let best = null, bestD = Infinity;

        const consider = (d, maxD, cand) => {
            if (d < maxD && d < bestD) { bestD = d; best = cand; }
        };

        for (const comp of this.components) {
            const size = this.getCompSize(comp);
            if (!size) continue;
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            for (const pin of ((comp.pins && comp.pins.length) ? comp.pins : size.pins)) {
                const px = comp.x + pin.x * cos - pin.y * sin;
                const py = comp.y + pin.x * sin + pin.y * cos;
                consider(Math.hypot(wx - px, wy - py), pinThresh, { x: px, y: py, kind: 'pin' });
            }
        }
        for (const via of this.vias || []) {
            consider(Math.hypot(wx - via.x, wy - via.y), vThresh, { x: via.x, y: via.y, kind: 'via' });
        }
        for (const tr of this.traces) {
            if (!tr.points || tr.points.length < 2) continue;
            if (exceptId && tr.id === exceptId) continue;
            if (layer && (tr.layer || 'top') !== layer) continue;
            for (const p of tr.points) {
                consider(Math.hypot(wx - p.x, wy - p.y), vThresh, { x: p.x, y: p.y, kind: 'vertex', trace: tr });
            }
            for (let si = 0; si < tr.points.length - 1; si++) {
                const a = tr.points[si], b = tr.points[si + 1];
                const dx = b.x - a.x, dy = b.y - a.y;
                const l2 = dx * dx + dy * dy;
                let t = l2 === 0 ? 0 : ((wx - a.x) * dx + (wy - a.y) * dy) / l2;
                t = Math.max(0, Math.min(1, t));
                const px = a.x + t * dx, py = a.y + t * dy;
                const d = Math.hypot(wx - px, wy - py);
                if (t > 0.06 && t < 0.94) {
                    consider(d, eThresh, { x: px, y: py, kind: 'edge', trace: tr, segIndex: si });
                }
            }
        }
        return best;
    },

    // Magnetic snap while drawing a trace: copper (inside radius) > H/V/45 from last point > grid.
    // routeAngle=free skips the H/V/45 pull so the rubber-band follows the cursor.
    snapTraceDrawPoint(wx, wy) {
        const layer = (this.view.activeLayer === 'bottom') ? 'bottom' : 'top';
        const g = this.params.gridSize || 1;
        const orthoPull = Math.min(Math.max(g * 0.55, 10 / this.view.zoom), g * 2.5);
        const pts = this.interaction.tracePoints || [];
        const free = (this.params.routeAngle === 'free');

        const copper = this.snapToCopper(wx, wy, { layer, preferTrace: true, draw: true });
        if (pts.length) {
            const prev = pts[pts.length - 1];
            for (let i = 0; i < pts.length - 1; i++) {
                const p = pts[i];
                if (Math.hypot(wx - p.x, wy - p.y) < Math.max(8 / this.view.zoom, 0.9)) {
                    return { x: p.x, y: p.y, kind: 'vertex' };
                }
            }
            if (copper && (copper.kind === 'pin' || copper.kind === 'via' || copper.kind === 'vertex' || copper.kind === 'edge')) {
                return copper;
            }
            if (!free) {
                const pulled = this._pullHv45(prev, wx, wy, g, orthoPull);
                if (pulled) return pulled;
            }
        } else if (copper) {
            return copper;
        }
        return { x: this.snapToGrid(wx), y: this.snapToGrid(wy), kind: 'grid' };
    },

    _pullHv45(prev, wx, wy, g, pull) {
        const dx = wx - prev.x, dy = wy - prev.y;
        if (Math.abs(dy) <= pull) return { x: this.snapToGrid(wx), y: prev.y, kind: 'h' };
        if (Math.abs(dx) <= pull) return { x: prev.x, y: this.snapToGrid(wy), kind: 'v' };
        const adx = Math.abs(dx), ady = Math.abs(dy);
        if (Math.abs(adx - ady) <= pull) {
            const s = Math.round(((adx + ady) / 2) / g) * g;
            return { x: prev.x + (dx < 0 ? -s : s), y: prev.y + (dy < 0 ? -s : s), kind: 'diag' };
        }
        return null;
    },

    // Magnetic snap for wire-jumper ends: existing copper (pad / via / trace
    // vertex or edge) wins, grid as fallback — same feel as trace drawing.
    snapJumperEnd(wx, wy) {
        const c = this.snapToCopper(wx, wy, { preferTrace: true, draw: true });
        if (c && (c.kind === 'pin' || c.kind === 'via' || c.kind === 'vertex' || c.kind === 'edge')) {
            return { x: c.x, y: c.y };
        }
        return { x: this.snapToGrid(wx), y: this.snapToGrid(wy) };
    },

    // Ghost preview position while placing a component (not wire jumper):
    // grid snap + magnetic alignment to other components' edges/centres.
    // Returns null when nothing is armed; the mousedown commit reuses this so
    // the part lands exactly where the ghost was shown.
    placePreviewAt(wx, wy) {
        const type = this.interaction.placingComponent;
        if (!type || (type === 'jumper' && this.interaction.placingJumperKind === 'wire')) return null;
        const def = ComponentDefs.get(type);
        if (!def) return null;
        const sizeIdx = (this.interaction.placingSize && this.interaction.placingSize[type] !== undefined) ? this.interaction.placingSize[type] : def.defaultSize;
        const size = ComponentDefs.getSize(def, sizeIdx);
        if (!size || !size.pins) return null;
        const gx = this.snapToGrid(wx), gy = this.snapToGrid(wy);
        const a = this.alignPosToComps(gx, gy, { pins: size.pins, rotation: this.interaction.placingRotation || 0 }, null);
        return {
            x: a.x !== null ? a.x : gx, y: a.y !== null ? a.y : gy,
            lineX: a.lineX, lineY: a.lineY,
            sizeIdx, pins: size.pins.map(p => ({ ...p }))
        };
    },

    saveState() {
        // Collaboration lock: while agents are collaborating (App.editLocked),
        // the human preview is read-only — refuse to commit local edits.
        if (this.editLocked) { if (typeof this.setStatus === 'function') this.setStatus('Editing locked — an agent is collaborating. Use Unlock to edit.'); return; }
        const snapshot = JSON.stringify({ traces: this.traces, components: this.components, vias: this.vias, boardOutline: this.boardOutline, silkTexts: this.silkTexts });
        this.undoStack.push(snapshot);
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
    },

    undo() {
        if (this.undoStack.length <= 1) return;
        this.redoStack.push(this.undoStack.pop());
        const state = JSON.parse(this.undoStack[this.undoStack.length - 1]);
        Object.assign(this, state);
        this.render();
    },

    redo() {
        if (this.redoStack.length === 0) return;
        const snapshot = this.redoStack.pop();
        this.undoStack.push(snapshot);
        Object.assign(this, JSON.parse(snapshot));
        this.render();
    },

    // Clear every transient interaction/overlay state. BoardView and SchematicView
    // draw hover, context, selection and placement ghosts straight from these fields,
    // so a project reset must not leave any of them pointing at removed objects —
    // otherwise stale component outlines stay painted on the board.
    resetInteractionState() {
        const i = this.interaction;
        i.tracePoints = []; i.outlinePoints = [];
        i.selectedObject = null; i.selectedObjects = null; i.selectedSegment = null; i.selectedVertices = [];
        i.rubberBand = null;
        i.placingComponent = null; i.placingSize = {}; i.placingRotation = 0;
        i.placingJumperKind = null; i.jumperFirst = null;
        i._placingOnCanvas = false; i._placePreview = null;
        i.draggingComp = null; i.dragOffsetX = 0; i.dragOffsetY = 0;
        i.dragAllSelected = false; i.dragStartPositions = null; i._dragAlign = null;
        i.draggingJumperEnd = null; i.draggingVertex = null; i.draggingTraceVertex = null;
        i.draggingSegment = null; i.draggingSilk = null;
        i.contextTarget = null; i.hoveredComp = null; i.hoveredTraceVertex = null; i.hoveredSegment = null;
        i.previewFlashIds = null;
        i.clipboard = null;
        i.schemWireStart = null; i.schemWireInterior = []; i.schemWireCursor = null;
        i.schemDraggingComp = null; i.schemHoveredPin = null; i.schemSelectedWires = [];
        i.schemSelectedJoint = null; i.schemDraggingSeg = null; i.schemPinPositions = [];
        i.schemPlacingPos = null;
    },

    nextId() { return ++this.idCounter; },

    render() {
        if (this.view.mode === 'board') BoardView.render(this);
        else SchematicView.render(this);
    },

    setStatus(msg) {
        document.getElementById('status-msg').textContent = msg;
        setTimeout(() => { document.getElementById('status-msg').textContent = ''; }, 3000);
    },

    // Zoom shown as % of real size: 100% = 1:1 on a standard 96 DPI display (96/25.4 px per mm).
    // In schematic mode this reflects the schematic zoom (the board zoom stays unchanged).
    _activeZoom() {
        return this.view.mode === 'schematic' ? this.view.schemZoom : this.view.zoom;
    },
    updateStatusZoom() {
        const el = document.getElementById('status-zoom');
        if (!el) return;
        el.textContent = `Zoom: ${Math.round(this._activeZoom() * 25.4 / 96 * 100)}%`;
        el.title = '100% = real size (1:1 at 96 DPI)';
        this.syncZoomSelect();
    },

    // Live cursor position in board mm, measured from the board's top-left corner (status bar).
    updateStatusCoords(wx, wy) {
        const el = document.getElementById('status-coords');
        if (!el) return;
        const bx = wx + this.board.width / 2;
        const by = wy + this.board.height / 2;
        el.textContent = `X: ${bx.toFixed(2)} Y: ${by.toFixed(2)} mm`;
        el.title = 'Cursor position from the board top-left corner';
    },

    // Zoom preset % → px per mm (100% = real size at 96 DPI).
    pctToZoom(pct) { return pct / 100 * 96 / 25.4; },

    // Set board zoom, keeping the given screen point (default: canvas centre) fixed on screen.
    setBoardZoom(newZoom, anchorSx, anchorSy) {
        const canvas = this.boardCanvas;
        newZoom = Math.max(0.1, Math.min(newZoom, 40));
        const ax = anchorSx !== undefined ? anchorSx : canvas.width / 2;
        const ay = anchorSy !== undefined ? anchorSy : canvas.height / 2;
        const wpt = this.screenToWorld(ax, ay);
        this.view.zoom = newZoom;
        this.view.panX = wpt.x - (ax - canvas.width / 2) / newZoom;
        this.view.panY = wpt.y - (ay - canvas.height / 2) / newZoom;
        this.updateStatusZoom();
        this.render();
    },

    // Mode-aware zoom: drives the board zoom, or the schematic zoom when in schematic
    // view (anchor defaults to the active canvas centre). Keeps the + / − / exact-% controls
    // consistent with the status-bar zoom label in both views.
    setViewZoom(newZoom, anchorSx, anchorSy) {
        newZoom = Math.max(0.1, Math.min(newZoom, 40));
        if (this.view.mode !== 'schematic') { this.setBoardZoom(newZoom, anchorSx, anchorSy); return; }
        const canvas = this.schematicCanvas;
        const ax = anchorSx !== undefined ? anchorSx : canvas.width / 2;
        const ay = anchorSy !== undefined ? anchorSy : canvas.height / 2;
        const cx = canvas.width / 2, cy = canvas.height / 2;
        const wpt = {
            x: (ax - cx) / this.view.schemZoom + this.view.schemPanX,
            y: (ay - cy) / this.view.schemZoom + this.view.schemPanY
        };
        this.view.schemZoom = newZoom;
        this.view.schemPanX = wpt.x - (ax - cx) / newZoom;
        this.view.schemPanY = wpt.y - (ay - cy) / newZoom;
        this.updateStatusZoom();
        this.render();
    },

    // Reflect the current zoom in the preset dropdown: the matching preset when exactly on one,
    // otherwise a temporary option showing the actual rounded % (kept sorted, replaced on change).
    syncZoomSelect() {
        const sel = document.getElementById('zoom-select');
        if (!sel) return;
        const pct = Math.round(this._activeZoom() * 25.4 / 96 * 100);
        let match = null, ref = null;
        for (const opt of [...sel.options]) {
            const v = parseInt(opt.value, 10);
            if (Number.isNaN(v)) continue;           // skip placeholder
            if (opt.dataset.custom) { opt.remove(); continue; }
            if (v === pct) match = opt;
            else if (!ref && v > pct) ref = opt;
        }
        if (!match) {
            const opt = document.createElement('option');
            opt.value = String(pct);
            opt.textContent = pct + '%';
            opt.dataset.custom = '1';
            sel.insertBefore(opt, ref);              // null → append at end
        }
        sel.value = String(pct);
    }
};
