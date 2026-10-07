// ============================================================
// project-api.js — DOM-free project kernel
// ------------------------------------------------------------
// Pure functions that operate on plain project objects:
//   { board, params, export, nets, traces[], components[],
//     vias[], boardOutline[], silkTexts[], idCounter }
//
// Loaded in the browser (after component-defs.js) AND loaded
// inside a Node `vm` context by the MCP server (mcp/host.mjs).
// No DOM / canvas access anywhere in this file.
//
// Coordinate convention: board mm, origin at board center, Y-down
// (same as the Board view). Pin world positions are rotation-aware.
// ============================================================

const ProjectApi = {
    PROJECT_VERSION: 2,

    clone(x) { return JSON.parse(JSON.stringify(x)); },

    // ------------------------------------------------------------
    // Project lifecycle
    // ------------------------------------------------------------

    createEmptyProject() {
        return {
            board: { width: 100, height: 60, thickness: 1.5, copperWeight: '1oz', material: 'FR-4' },
            params: { traceWidth: 0.5, viaDiameter: 1.2, gridSize: 1, minTraceWidth: 0.38, minDrill: 0.1, minClearance: 0.38, jumperFollow: 'pads', routeAngle: 'hv45' },
            export: { includeOutlines: true, includeTraces: true, includeComps: true, includeHoles: true, includeSilk: true },
            nets: [
                { id: 1, name: 'VCC', color: '#e74c3c' },
                { id: 2, name: 'GND', color: '#95a5a6' },
                { id: 3, name: 'SIG1', color: '#f39c12' }
            ],
            traces: [],
            components: [],
            vias: [],
            boardOutline: null,
            silkTexts: [],
            // Design-workflow plan (CAP-1/2). requirements is a machine-checkable
            // contract (null = none); zones are axis-aligned rects in board mm
            // {id,name,x,y,w,h}; assignments maps compId -> zone id; flowDirection
            // is the power-flow direction 'lr'|'rl'|'tb'|'bt'. Placement/routing are
            // DERIVED from these, never stored as truth (AD-1).
            requirements: null,
            zones: [],
            assignments: {},
            flowDirection: 'lr',
            // Placement groups (MCP agent design flow): [{key, members:[compId]}].
            // Each group is a channel (row): member i of every group shares the
            // flow-axis coordinate i, so an R/trimmer/LED channel places as a
            // column. Empty = today's spread.
            groups: [],
            // Stored netlist (MCP agent design flow): net name -> [{compId, pin}].
            // Declared membership wins over geometry in getPinNet; boards without
            // a netlist keep the geometric fallback. Same-component pins are legal
            // (a trimmer wiper ties two pins of one pot onto a net).
            netlist: {},
            // Circuit contract (MCP design flow): { rails, branches, ties } declared
            // by the agent via millpcb_circuit_check; the workflow's circuit step
            // verifies it against copper. null = not declared.
            circuitContract: null,
            // Logical electrical PASS for one project revision. Cleared on every
            // mutation. null = not validated. { revision, valid, violations }.
            electricalValidation: null,
            idCounter: 0
        };
    },

    // Pick the finite numeric values of `keys` out of `src` into a fresh object.
    pickFinite(src, keys) {
        const out = {};
        for (const k of keys) {
            const v = src ? src[k] : undefined;
            if (typeof v === 'number' && isFinite(v)) out[k] = v;
        }
        return out;
    },

    // Patch top-level sections (board size / export params).
    setProjectPatch(project, patch) {
        if (patch.board) project.board = Object.assign({}, project.board, this.pickFinite(patch.board, ['width', 'height']));
        if (patch.params) {
            project.params = Object.assign({}, project.params, patch.params);
            this._normalizeModeParams(project.params);
        }
        return project;
    },

    // Patch the design-workflow plan (CAP-1/2). Each field is optional; only the
    // provided keys are written. requirements null clears the contract; zones are
    // validated to axis-aligned rects {id,name,x,y,w,h}; flowDirection is coerced
    // to a known enum. Placement/routing stay derived (AD-1).
    setPlan(project, patch) {
        patch = patch || {};
        if (patch.requirements !== undefined) {
            project.requirements = (patch.requirements && typeof patch.requirements === 'object') ? this.clone(patch.requirements) : null;
        }
        if (Array.isArray(patch.zones)) {
            project.zones = patch.zones.map(z => Object.assign({ id: 0, name: '', x: 0, y: 0, w: 0, h: 0 }, z));
        }
        if (patch.assignments && typeof patch.assignments === 'object') {
            project.assignments = this.clone(patch.assignments);
        }
        if (['lr', 'rl', 'tb', 'bt'].indexOf(patch.flowDirection) >= 0) {
            project.flowDirection = patch.flowDirection;
        }
        if (Array.isArray(patch.groups)) {
            project.groups = patch.groups.map(g => ({ key: g.key, members: (g.members || []).map(Number) })).filter(g => g.members.length);
        }
        return project;
    },

    // Serialize a project (or App-like state) to the saved JSON shape.
    serialize(project) {
        const p = this.clone({
            board: project.board,
            params: project.params,
            export: project.export,
            nets: project.nets || [],
            traces: project.traces || [],
            components: project.components || [],
            vias: project.vias || [],
            boardOutline: project.boardOutline || null,
            silkTexts: project.silkTexts || [],
            requirements: project.requirements || null,
            zones: project.zones || [],
            assignments: project.assignments || {},
            flowDirection: project.flowDirection || 'lr',
            netlist: project.netlist || {},
            groups: project.groups || [],
            circuitContract: project.circuitContract || null,
            electricalValidation: project.electricalValidation || null
        });
        p.version = this.PROJECT_VERSION;
        p.idCounter = project.idCounter || 0;
        // Preserve KiCad imported footprints (present in browser saves).
        if (project.importedDefs && project.importedDefs.length) {
            p.importedDefs = this.clone(project.importedDefs);
        }
        return p;
    },

    // Deserialize a saved JSON into a live project. Missing fields are
    // migrated to defaults (backward compatible with old files).
    deserialize(json) {
        const p = this.createEmptyProject();
        if (!json || typeof json !== 'object') throw new Error('Invalid project data');
        p.board = Object.assign(p.board, json.board || {});
        p.params = Object.assign(p.params, json.params || {});
        this._normalizeModeParams(p.params);
        p.export = Object.assign(p.export, json.export || {});
        p.nets = (json.nets && json.nets.length) ? this.clone(json.nets) : p.nets;
        p.traces = (json.traces || []).map(t => {
            const tr = Object.assign({ points: [], width: 0.5, layer: 'top', net: null }, t);
            if (!Array.isArray(tr.points)) tr.points = [];
            return tr;
        });
        p.components = (json.components || []).map(c => {
            const comp = Object.assign({ id: 0, type: 'resistor', x: 0, y: 0, rotation: 0, size: 0, label: '', value: '', layer: 'top' }, c);
            // Migrate legacy wire-jumper instances (no span / missing pins) to span + pin pair.
            if (comp.type === 'jumper') {
                const def = ComponentDefs.get('jumper');
                const size = def && comp.size !== undefined ? ComponentDefs.getSize(def, comp.size) : null;
                if (size && size.jkind === 'wire') {
                    if (!Array.isArray(comp.pins) || comp.pins.length < 2) {
                        const span = Number(comp.span) > 0 ? Number(comp.span) : 10;
                        comp.span = span;
                        comp.pins = [{ x: -span / 2, y: 0, name: '1' }, { x: span / 2, y: 0, name: '2' }];
                    } else if (comp.span === undefined) {
                        const a = comp.pins[0], b = comp.pins[comp.pins.length - 1];
                        comp.span = Math.hypot(b.x - a.x, b.y - a.y);
                    }
                }
            }
            return comp;
        });
        p.vias = (json.vias || []).map(v =>
            Object.assign({ id: 0, x: 0, y: 0, diameter: 1.2, drill: null }, v));
        p.boardOutline = json.boardOutline && json.boardOutline.length >= 3 ? this.clone(json.boardOutline) : null;
        p.silkTexts = (json.silkTexts || []).map(s =>
            Object.assign({ id: 0, text: '', x: 0, y: 0, size: 2.0, rotation: 0, layer: 'silkTop' }, s));
        // Design-workflow plan (CAP-1/2): migrate missing fields to defaults so
        // projects saved before the plan existed load unchanged (AD-1, backward-compat).
        p.requirements = (json.requirements && typeof json.requirements === 'object') ? this.clone(json.requirements) : null;
        p.zones = (json.zones || []).map(z =>
            Object.assign({ id: 0, name: '', x: 0, y: 0, w: 0, h: 0 }, z));
        p.assignments = (json.assignments && typeof json.assignments === 'object') ? this.clone(json.assignments) : {};
        p.flowDirection = ['lr', 'rl', 'tb', 'bt'].indexOf(json.flowDirection) >= 0 ? json.flowDirection : 'lr';
        // Stored netlist: migrate missing field to {} (old files), clone entries.
        p.netlist = (json.netlist && typeof json.netlist === 'object') ? this.clone(json.netlist) : {};
        p.groups = Array.isArray(json.groups) ? this.clone(json.groups) : [];
        p.circuitContract = (json.circuitContract && typeof json.circuitContract === 'object') ? this.clone(json.circuitContract) : null;
        p.electricalValidation = (json.electricalValidation && typeof json.electricalValidation === 'object') ? this.clone(json.electricalValidation) : null;
        if (Array.isArray(json.importedDefs) && json.importedDefs.length) {
            p.importedDefs = this.clone(json.importedDefs);
            if (typeof KicadImport !== 'undefined' && KicadImport.restoreDefs) KicadImport.restoreDefs(p.importedDefs);
        }
        let maxId = p.idCounter;
        [p.traces, p.components, p.vias, p.silkTexts].forEach(list =>
            list.forEach(o => { if (o.id > maxId) maxId = o.id; }));
        p.idCounter = Math.max(p.idCounter || 0, maxId);
        // Migrate legacy/missing silk label fields to the object form on load.
        p.components.forEach(c => this.ensureCompSilkLayout(c));
        return p;
    },

    nextId(project) {
        project.idCounter = (project.idCounter || 0) + 1;
        return project.idCounter;
    },

    // ------------------------------------------------------------
    // Component geometry (mirrors App.getCompSize / getCompPins —
    // kept here so the kernel has no dependency on App/DOM)
    // ------------------------------------------------------------

    getCompSize(comp) {
        const def = ComponentDefs.get(comp.type);
        if (!def) return null;
        return ComponentDefs.getSize(def, comp.size || 0);
    },

    getCompPins(comp) {
        if (comp.pins && comp.pins.length) return comp.pins;
        const size = this.getCompSize(comp);
        return (size && size.pins) || [];
    },

    // Default silk label/value positions in component-local mm (unrotated, Y-down).
    // Object convention shared with the browser kernel; normalizes legacy/invalid
    // values in place (string/number/null → default object; bad rotation/fontSize dropped).
    // Stock defaults (x≈0, |y|≈hh+0.35) are lifted so the glyph clears the body.
    ensureCompSilkLayout(comp) {
        const size = this.getCompSize(comp);
        const hh = size ? size.height / 2 : 1;
        const gap = size ? this.compSilkClearance(size) : 0.45;
        const dy = hh + gap;
        const oldDy = hh + 0.35;
        const farDy = size ? hh + this.compSilkFontSize(size) * 0.65 + 0.4 : hh + 0.9;
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

    // Auto silk font size: scale with component span, clamped for legibility (mirrors app-core).
    compSilkFontSize(size) {
        const span = Math.max(size.width || 0, size.height || 0, 0.8);
        return Math.max(0.7, Math.min(1.6, span * 0.14));
    },

    compSilkClearance(size) {
        return this.compSilkFontSize(size) * 0.35 + 0.18;
    },

    // Effective font size for a silk field: explicit per-label override wins, else auto.
    compSilkEffectiveFontSize(pos, size) {
        if (pos && typeof pos.fontSize === 'number' && isFinite(pos.fontSize) && pos.fontSize > 0) return pos.fontSize;
        return this.compSilkFontSize(size);
    },

    // World position of a component pin. `pin` is a pin name or index.
    // Returns { x, y, name } in board mm (rotation-aware), or null.
    pinWorld(project, compId, pin) {
        const comp = project.components.find(c => c.id === compId);
        if (!comp) return null;
        const pins = this.getCompPins(comp);
        let p = null;
        if (typeof pin === 'number') {
            p = pins[pin] || null;
        } else {
            p = pins.find(x => String(x.name) === String(pin)) || null;
            if (!p && pins.length === 1) p = pins[0]; // forgiving: single-pin parts
        }
        if (!p) return null;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return {
            x: comp.x + p.x * cos - p.y * sin,
            y: comp.y + p.x * sin + p.y * cos,
            name: p.name
        };
    },

    // ------------------------------------------------------------
    // Footprint library
    // ------------------------------------------------------------

    listFootprints(type) {
        const out = [];
        for (const [t, def] of Object.entries(ComponentDefs.defs)) {
            if (type && t !== String(type)) continue;
            out.push({
                type: t,
                prefix: def.prefix,
                module: !!def.module,
                defaultSize: def.defaultSize || 0,
                sizes: (def.sizes || []).map((s, i) => ({
                    index: i,
                    name: s.name,
                    width: s.width,
                    height: s.height,
                    pins: (s.pins || []).length,
                    ...(s.model3d ? { model3d: s.model3d.map(m => m.uri) } : {}),
                    ...(s.symGraphics ? { symGraphics: true } : {})
                }))
            });
        }
        return out;
    },

    // ------------------------------------------------------------
    // Edits — each returns the created/updated object
    // ------------------------------------------------------------

    addComponent(project, spec) {
        if (!spec || !spec.type) throw new Error('addComponent: "type" is required');
        const def = ComponentDefs.get(spec.type);
        if (!def) throw new Error(`Unknown component type: ${spec.type}`);
        let sizeIdx;
        if (spec.size !== undefined) {
            sizeIdx = spec.size;
        } else if (spec.sizeName !== undefined) {
            sizeIdx = (def.sizes || []).findIndex(s => s.name === spec.sizeName);
            if (sizeIdx < 0) throw new Error(`Unknown size "${spec.sizeName}" for ${spec.type}`);
        } else if (spec.type === 'jumper' && Number(spec.span) > 0) {
            // A span means a wire jumper — pick the Wire size, not the default 0Ω.
            sizeIdx = (def.sizes || []).findIndex(s => s.jkind === 'wire');
            if (sizeIdx < 0) sizeIdx = def.defaultSize || 0;
        } else {
            sizeIdx = def.defaultSize || 0;
        }
        const size = ComponentDefs.getSize(def, sizeIdx);
        let label = spec.label;
        if (!label) {
            // KiCad-imported defs carry refPrefix (no prefix) — fall back so
            // auto labels are "U1"/"R1", never "undefined1".
            const pfx = def.prefix || def.refPrefix || 'U';
            let maxNum = 0;
            project.components.forEach(c => {
                if (c.type === spec.type && c.label) {
                    const m = String(c.label).match(/^([A-Za-z]*)(\d+)$/);
                    if (m && m[1] === pfx) maxNum = Math.max(maxNum, parseInt(m[2], 10));
                }
            });
            label = `${pfx}${maxNum + 1}`;
        }
        const comp = {
            id: this.nextId(project),
            type: spec.type,
            x: Number(spec.x) || 0,
            y: Number(spec.y) || 0,
            rotation: (Number(spec.rotation) || 0) % 360,
            size: sizeIdx,
            label,
            value: spec.value !== undefined ? String(spec.value) : ((def.prefix === 'JP' && size.value) ? String(size.value) : (def.defaultValue || '')),
            layer: spec.layer === 'bottom' ? 'bottom' : 'top',
            // Copy pins so the component is self-contained in saves.
            pins: (size.pins || []).map(p => ({ ...p }))
        };
        if (spec.type === 'jumper' && size.jkind === 'wire') {
            const span = Number(spec.span) > 0 ? Number(spec.span) : Math.hypot(size.pins[1].x - size.pins[0].x, size.pins[1].y - size.pins[0].y);
            comp.span = span;
            comp.pins = [{ x: -span / 2, y: 0, name: '1' }, { x: span / 2, y: 0, name: '2' }];
        }
        this.ensureCompSilkLayout(comp);
        project.components.push(comp);
        return comp;
    },

    // Rewrite a wire jumper's span + pins and drag connected trace endpoints with them.
    applyJumperSpan(project, compId, newSpan) {
        const c = (project.components || []).find(x => x.id === compId);
        if (!c || c.type !== 'jumper') return null;
        const def = ComponentDefs.get('jumper');
        const size = def && c.size !== undefined ? ComponentDefs.getSize(def, c.size) : null;
        if (!size || size.jkind !== 'wire') return null;
        const span = Math.max(2, Number(newSpan) || 0);
        const oldPins = (Array.isArray(c.pins) && c.pins.length >= 2) ? c.pins : [{ x: -5, y: 0 }, { x: 5, y: 0 }];
        const rad = (c.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const toWorld = pin => ({ x: c.x + pin.x * cos - pin.y * sin, y: c.y + pin.x * sin + pin.y * cos });
        const oldW = oldPins.map(toWorld);
        c.span = span;
        c.pins = [{ x: -span / 2, y: 0, name: '1' }, { x: span / 2, y: 0, name: '2' }];
        const newW = c.pins.map(toWorld);
        const tol = 1.5;
        let moved = 0;
        for (const trace of project.traces || []) {
            for (const pt of trace.points || []) {
                for (let i = 0; i < oldW.length; i++) {
                    if (Math.hypot(pt.x - oldW[i].x, pt.y - oldW[i].y) < tol && i < newW.length) {
                        pt.x = newW[i].x; pt.y = newW[i].y;
                        moved++;
                        break;
                    }
                }
            }
        }
        return { comp: c, moved };
    },

    // Schematic wires are LOGICAL connections stored as board-space traces
    // with schemWire: true. Only netlist derivation (getPinNet) may treat them
    // as copper; rendering, DRC, hit-testing, autorouting and export must skip
    // them so no physical PCB copper appears until the user routes.
    isSchemTrace(trace) { return !!(trace && trace.schemWire); },

    getPinNet(project, compId, pin) {
        const wp = this.pinWorld(project, compId, pin);
        if (!wp) return null;
        // Stored netlist wins: a declared pin is on its net even with no copper.
        const nl = project.netlist;
        if (nl) {
            const i = this.pinIndex(project, compId, pin);
            if (i !== null) {
                for (const netName of Object.keys(nl)) {
                    const refs = nl[netName] || [];
                    for (const ref of refs) {
                        if (ref.compId !== compId) continue;
                        const ri = this.pinIndex(project, compId, ref.pin);
                        if (ri !== null && ri === i) return netName;
                    }
                }
            }
        }
        for (const trace of project.traces || []) {
            if (!trace.net) continue;
            const pts = trace.points || [];
            for (let i = 0; i < pts.length; i++) {
                if (Math.hypot(pts[i].x - wp.x, pts[i].y - wp.y) < 0.15) return trace.net;
            }
        }
        return null;
    },

    // Merge/replace stored-netlist entries. Validates every ref (component exists,
    // pin name/index resolves) and rejects a pin already declared on a DIFFERENT
    // net. Ensures a project.nets entry for each net name. Returns
    // { nets, pinCount } — throws on invalid input.
    setNetlist(project, nets, mode) {
        if (!project.netlist) project.netlist = {};
        const replace = mode === 'replace';
        const errors = [];
        const normalized = {};
        for (const netName of Object.keys(nets || {})) {
            const refs = nets[netName] || [];
            normalized[netName] = [];
            for (const ref of refs) {
                const comp = (project.components || []).find(c => c.id === ref.compId);
                if (!comp) { errors.push(`unknown compId ${ref.compId} on net ${netName}`); continue; }
                const pi = this.pinIndex(project, ref.compId, ref.pin);
                if (pi === null) { errors.push(`pin ${JSON.stringify(ref.pin)} not found on component ${ref.compId} (${comp.label || comp.type})`); continue; }
                for (const other of Object.keys(project.netlist)) {
                    if (replace) continue;
                    for (const r of (project.netlist[other] || [])) {
                        if (r.compId !== ref.compId) continue;
                        const ri = this.pinIndex(project, r.compId, r.pin);
                        if (ri === pi && other !== netName) errors.push(`pin ${comp.label || comp.type}.${String(ref.pin)} already on net ${other}`);
                    }
                }
                normalized[netName].push({ compId: ref.compId, pin: String(this.getCompPins(comp)[pi].name) });
            }
        }
        if (errors.length) throw new Error('setNetlist: ' + errors.join('; '));
        if (replace) project.netlist = {};
        for (const netName of Object.keys(normalized)) {
            const arr = project.netlist[netName] || (project.netlist[netName] = []);
            for (const ref of normalized[netName]) {
                if (!arr.some(r => r.compId === ref.compId && String(r.pin) === ref.pin)) arr.push(ref);
            }
            this.ensureNet(project, netName);
        }
        let pinCount = 0;
        for (const n of Object.keys(project.netlist)) pinCount += project.netlist[n].length;
        return { nets: Object.keys(project.netlist).length, pinCount };
    },

    // True when a 2-pin component electrically connects `netA` and `netB`: one pin
    // on netA, the other on netB (either order). Tolerant to BOTH copper stubs and
    // logical pin-to-pin wires, which in this data model are both traces with an
    // endpoint at a component pin. Uses a set of nets per pin (not getPinNet's
    // first match) with a looser tolerance, so a pin touching several traces still
    // resolves correctly. Used by the LED series-resistor reuse detection.
    resistorBridges(project, comp, netA, netB, opts = {}) {
        const tol = opts.tol !== undefined ? opts.tol : 0.3;
        const pins = this.getCompPins(comp);
        if (!pins || pins.length !== 2) return false;
        const w0 = this.pinWorld(project, comp.id, 0);
        const w1 = this.pinWorld(project, comp.id, 1);
        if (!w0 || !w1) return false;
        const netsAt = (p) => {
            const s = new Set();
            for (const tr of project.traces || []) {
                if (!tr.net) continue;
                const pts = tr.points || [];
                const a = pts[0], b = pts[pts.length - 1];
                if (a && Math.hypot(a.x - p.x, a.y - p.y) < tol) s.add(tr.net);
                if (b && Math.hypot(b.x - p.x, b.y - p.y) < tol) s.add(tr.net);
            }
            return s;
        };
        const n0 = netsAt(w0), n1 = netsAt(w1);
        if (!netA || !netB) return false;
        if (netA === netB) return n0.has(netA) && n1.has(netB);
        return (n0.has(netA) && n1.has(netB)) || (n0.has(netB) && n1.has(netA));
    },

    nextNetName(project) {
        let maxNum = 3;
        const consider = name => {
            const m = String(name).match(/^NET_(\d+)$/);
            if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
        };
        (project.nets || []).forEach(n => consider(n.name));
        // Traces can carry a net name that was never declared in project.nets
        // (addTrace does not register one), so they must count too — otherwise
        // a second auto-named net silently reuses the first one's name.
        (project.traces || []).forEach(t => consider(t.net));
        return `NET_${maxNum + 1}`;
    },

    // Ensure a net with this name exists in project.nets; returns it.
    ensureNet(project, name, color) {
        if (!name) return null;
        let net = (project.nets || []).find(n => n.name === name);
        if (!net) {
            net = { id: this.nextId(project), name, color: color || '#00d4ff' };
            project.nets.push(net);
        }
        return net;
    },

    addTrace(project, spec) {
        if (!spec || !Array.isArray(spec.points) || spec.points.length < 2) {
            throw new Error('addTrace: at least 2 points are required');
        }
        const trace = {
            id: this.nextId(project),
            points: spec.points.map(p => ({ x: Number(p.x), y: Number(p.y) })),
            width: spec.width !== undefined ? Number(spec.width) : (project.params.traceWidth || 0.5),
            layer: spec.layer === 'bottom' ? 'bottom' : 'top',
            net: spec.net || this.nextNetName(project)
        };
        if (spec.curved && Array.isArray(spec.curved)) trace.curved = spec.curved;
        if (spec.segmentWidths && Array.isArray(spec.segmentWidths)) trace.segmentWidths = spec.segmentWidths;
        if (!spec.schemWire && typeof Plan !== 'undefined' && Plan.wouldCross) {
            const hit = Plan.wouldCross(project, trace.points, trace.net);
            if (hit) throw new Error(hit);
        }
        project.traces.push(trace);
        return trace;
    },

    _ptSegDist(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    },

    _closestOnSeg(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return { x: a.x, y: a.y };
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return { x: a.x + t * dx, y: a.y + t * dy };
    },

    // Physical same-net segments on one layer (schematic wires are not copper).
    _sameNetSegs(project, net, layer) {
        const segs = [];
        const want = layer === 'bottom' ? 'bottom' : 'top';
        for (const t of project.traces || []) {
            if (!t || t.schemWire || t.net !== net) continue;
            if ((t.layer || 'top') !== want) continue;
            const pts = t.points || [];
            for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i], b: pts[i + 1], trace: t });
        }
        return segs;
    },

    _hitsSegs(p, segs, tol) {
        for (const s of segs) if (this._ptSegDist(p, s.a, s.b) <= tol) return s;
        return null;
    },

    // Intersection of the horizontal (or vertical) line through p with segment ab.
    _axisHit(p, a, b, horizontal) {
        const dx = b.x - a.x, dy = b.y - a.y;
        if (horizontal) {
            if (Math.abs(dy) < 1e-9) {
                if (Math.abs(a.y - p.y) > 1e-6) return null;
                const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
                return { x: Math.max(x0, Math.min(x1, p.x)), y: p.y };
            }
            const t = (p.y - a.y) / dy;
            if (t < -1e-9 || t > 1 + 1e-9) return null;
            return { x: a.x + t * dx, y: p.y };
        }
        if (Math.abs(dx) < 1e-9) {
            if (Math.abs(a.x - p.x) > 1e-6) return null;
            const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
            return { x: p.x, y: Math.max(y0, Math.min(y1, p.y)) };
        }
        const t = (p.x - a.x) / dx;
        if (t < -1e-9 || t > 1 + 1e-9) return null;
        return { x: p.x, y: a.y + t * dy };
    },

    // Shortest join from p onto existing copper. Ortho (Manhattan) by default;
    // straight uses the Euclidean foot. Returns { q, len } or null.
    _bestJoin(p, segs, straight) {
        let best = null;
        for (const s of segs) {
            const cands = straight
                ? [this._closestOnSeg(p, s.a, s.b)]
                : [s.a, s.b, this._axisHit(p, s.a, s.b, true), this._axisHit(p, s.a, s.b, false)];
            for (const q of cands) {
                if (!q) continue;
                if (this._ptSegDist(q, s.a, s.b) > 1e-4) continue;
                const len = straight
                    ? Math.hypot(p.x - q.x, p.y - q.y)
                    : Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
                if (!best || len < best.len - 1e-9) best = { q: { x: q.x, y: q.y }, len };
            }
        }
        return best;
    },

    _elbowPoints(project, a, b) {
        if (Math.abs(a.x - b.x) <= 0.05 || Math.abs(a.y - b.y) <= 0.05) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        const bw = project.board.width / 2, bh = project.board.height / 2, inset = 0.01;
        const e1 = { x: a.x, y: b.y }, e2 = { x: b.x, y: a.y };
        const inside = pt => pt.x >= -bw + inset && pt.x <= bw - inset && pt.y >= -bh + inset && pt.y <= bh - inset;
        const elbow = inside(e1) ? e1 : (inside(e2) ? e2 : e1);
        return [{ x: a.x, y: a.y }, elbow, { x: b.x, y: b.y }];
    },

    // Pin-to-pin polyline. Ortho inserts one elbow (same-component ties always
    // do, even when the pins share an axis — callers rely on the 3-point hook).
    _pinToPinPoints(project, pa, pb, sameComp, style) {
        let points = [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }];
        const needElbow = Math.abs(pa.x - pb.x) > 0.05 && Math.abs(pa.y - pb.y) > 0.05;
        if ((style || 'ortho') === 'ortho' && (needElbow || sameComp)) {
            const bw = project.board.width / 2, bh = project.board.height / 2, inset = 0.01;
            const e1 = { x: pa.x, y: pb.y }, e2 = { x: pb.x, y: pa.y };
            const inside = pt => pt.x >= -bw + inset && pt.x <= bw - inset && pt.y >= -bh + inset && pt.y <= bh - inset;
            const elbow = inside(e1) ? e1 : (inside(e2) ? e2 : e1);
            points = [{ x: pa.x, y: pa.y }, elbow, { x: pb.x, y: pb.y }];
        }
        return points;
    },

    _dedupePts(points) {
        const out = [];
        for (const p of points || []) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const q = out[out.length - 1];
            if (q && Math.hypot(q.x - p.x, q.y - p.y) < 1e-6) continue;
            out.push({ x: p.x, y: p.y });
        }
        return out;
    },

    _polyLen(pts) {
        let n = 0;
        for (let i = 1; i < (pts || []).length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return n;
    },

    // Parameter interval of p-q that runs along segment a-b (collinear overlap).
    // A point touch returns null — a T-join is not an overlapping run.
    _collinearOverlapT(p, q, a, b, tol) {
        const dx = q.x - p.x, dy = q.y - p.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return null;
        const len = Math.sqrt(len2);
        const lineDist = pt => Math.abs(dx * (pt.y - p.y) - dy * (pt.x - p.x)) / len;
        if (lineDist(a) > tol || lineDist(b) > tol) return null;
        const tOf = pt => ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / len2;
        let t0 = tOf(a), t1 = tOf(b);
        if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
        const lo = Math.max(0, t0), hi = Math.min(1, t1);
        if (hi - lo < 1e-4) return null;
        return [lo, hi];
    },

    // Pieces of a polyline that are not already covered by same-net copper.
    // `tol` is how far (mm) a run may sit from an existing segment and still
    // count as the same trace. Empty segs returns the polyline unchanged.
    uncoveredPieces(points, segs, tol) {
        tol = tol || 0.05;
        const pts = this._dedupePts(points);
        if (pts.length < 2) return [];
        if (!segs || !segs.length) return [pts];
        const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        const pieces = [];
        let cur = null;
        const flush = () => { if (cur && cur.length >= 2) pieces.push(cur); cur = null; };
        const push = pt => {
            if (!cur) cur = [];
            const last = cur[cur.length - 1];
            if (last && Math.hypot(last.x - pt.x, last.y - pt.y) < 1e-6) return;
            cur.push(pt);
        };
        for (let i = 0; i + 1 < pts.length; i++) {
            const iv = [];
            for (const s of segs) {
                const hit = this._collinearOverlapT(pts[i], pts[i + 1], s.a, s.b, tol);
                if (hit) iv.push(hit);
            }
            iv.sort((a, b) => a[0] - b[0]);
            const covered = [];
            for (const span of iv) {
                if (!covered.length || span[0] > covered[covered.length - 1][1] + 1e-6) covered.push([span[0], span[1]]);
                else covered[covered.length - 1][1] = Math.max(covered[covered.length - 1][1], span[1]);
            }
            const spans = [];
            let t = 0;
            for (const span of covered) {
                if (span[0] > t + 1e-4) spans.push([t, span[0]]);
                t = Math.max(t, span[1]);
            }
            if (t < 1 - 1e-4) spans.push([t, 1]);
            if (!spans.length) { flush(); continue; }
            for (const span of spans) {
                if (span[0] > 1e-4) flush();
                push(lerp(pts[i], pts[i + 1], span[0]));
                push(lerp(pts[i], pts[i + 1], span[1]));
                if (span[1] < 1 - 1e-4) flush();
            }
        }
        flush();
        return pieces;
    },

    // Insert a vertex where q meets same-net copper so the joint is a real point.
    _splitNetAt(project, net, layer, q) {
        const want = layer === 'bottom' ? 'bottom' : 'top';
        for (const t of project.traces || []) {
            if (!t || t.schemWire || t.net !== net) continue;
            if ((t.layer || 'top') !== want) continue;
            const pts = t.points || [];
            for (let i = 0; i < pts.length; i++) {
                if (Math.hypot(pts[i].x - q.x, pts[i].y - q.y) <= 0.05) return pts[i];
            }
            for (let i = 0; i + 1 < pts.length; i++) {
                if (this._ptSegDist(q, pts[i], pts[i + 1]) > 0.02) continue;
                const pt = { x: q.x, y: q.y };
                pts.splice(i + 1, 0, pt);
                if (Array.isArray(t.curved)) t.curved.splice(i + 1, 0, false);
                if (Array.isArray(t.segmentWidths)) {
                    const w = t.segmentWidths[i] != null ? t.segmentWidths[i] : t.width;
                    t.segmentWidths.splice(i + 1, 0, w);
                }
                return pt;
            }
        }
        return { x: q.x, y: q.y };
    },

    // Connect two pins with a straight trace. Pin refs: { compId, pin }
    // where pin is a name or index. Net resolution:
    //   opts.net            -> use it (created if missing)
    //   both pins have nets -> must match, else error
    //   one has a net       -> use that net
    //   neither             -> create NET_n
    connectPins(project, from, to, opts = {}) {
        const pa = this.pinWorld(project, from.compId, from.pin);
        const pb = this.pinWorld(project, to.compId, to.pin);
        if (!pa) throw new Error(`connectPins: pin ${JSON.stringify(from.pin)} not found on component ${from.compId}`);
        if (!pb) throw new Error(`connectPins: pin ${JSON.stringify(to.pin)} not found on component ${to.compId}`);
        if (from.compId === to.compId) {
            // Two DIFFERENT pins of one component are legal (a trimmer wiper tie).
            const ia = this.pinIndex(project, from.compId, from.pin);
            const ib = this.pinIndex(project, to.compId, to.pin);
            if (ia === ib) throw new Error('connectPins: cannot connect a pin to itself');
        }
        let net;
        if (opts.net) {
            net = this.ensureNet(project, opts.net).name;
        } else {
            const na = this.getPinNet(project, from.compId, from.pin);
            const nb = this.getPinNet(project, to.compId, to.pin);
            if (na && nb) {
                if (na !== nb) throw new Error(`connectPins: net conflict "${na}" vs "${nb}" — pass opts.net to choose`);
                net = na;
            } else {
                net = na || nb || this.nextNetName(project);
            }
        }
        // Orthogonal by default: A -> elbow -> B. When this net already has
        // copper, don't lay a second path along it — join the loose pin to the
        // nearest point on that copper (or skip the call when both pins already
        // sit on it).
        const style = opts.style || 'ortho';
        const straight = style === 'straight';
        const layer = opts.layer === 'bottom' ? 'bottom' : 'top';
        const sameComp = from.compId === to.compId;
        const TOL = 0.15;
        const ia = this.pinIndex(project, from.compId, from.pin);
        const ib = this.pinIndex(project, to.compId, to.pin);
        const finish = (trace) => {
            if (trace && ia !== null && ib !== null) trace.schemEnds = [{ compId: from.compId, pinIndex: ia }, { compId: to.compId, pinIndex: ib }];
            return trace;
        };
        const addPieces = (rawPts, segsNow) => {
            const added = [];
            for (const pts of this.uncoveredPieces(rawPts, segsNow, 0.05)) {
                if (this._polyLen(pts) < 0.02) continue;
                added.push(this.addTrace(project, { points: pts, net, layer, width: opts.width }));
            }
            return added;
        };
        const stubPts = (pin, q) => straight ? [{ x: pin.x, y: pin.y }, { x: q.x, y: q.y }] : this._elbowPoints(project, pin, q);

        const segs = this._sameNetSegs(project, net, layer);
        if (!segs.length) {
            return finish(this.addTrace(project, {
                points: this._pinToPinPoints(project, pa, pb, sameComp, style), net, layer, width: opts.width
            }));
        }
        const fromHit = this._hitsSegs(pa, segs, TOL);
        const toHit = this._hitsSegs(pb, segs, TOL);
        if (fromHit && toHit) return fromHit.trace;

        if (fromHit || toHit) {
            const loose = fromHit ? pb : pa;
            const join = this._bestJoin(loose, segs, straight);
            if (!join || join.len <= TOL) return (fromHit || toHit).trace;
            const q = this._splitNetAt(project, net, layer, join.q);
            const added = addPieces(stubPts(loose, q), segs);
            return added.length ? finish(added[0]) : (fromHit || toHit).trace;
        }

        // Both pins are off the existing copper. Two short stubs win when they
        // add less copper than a pin-to-pin path plus one link back to the net.
        const jA = this._bestJoin(pa, segs, straight);
        const jB = this._bestJoin(pb, segs, straight);
        const stubCost = (jA ? jA.len : Infinity) + (jB ? jB.len : Infinity);
        const bridgePts = this._pinToPinPoints(project, pa, pb, sameComp, style);
        const bridgeCost = this._polyLen(bridgePts) + Math.min(jA ? jA.len : Infinity, jB ? jB.len : Infinity);
        if (jA && jB && stubCost <= bridgeCost + 1e-6) {
            const added = [];
            for (const item of [{ pin: pa, q: jA.q }, { pin: pb, q: jB.q }]) {
                if (item.q == null) continue;
                const q = this._splitNetAt(project, net, layer, item.q);
                const one = addPieces(stubPts(item.pin, q), segs);
                if (one.length) added.push(one[0]);
            }
            if (added.length) return finish(added[0]);
        }
        const added = addPieces(bridgePts, segs);
        const touches = added.some(tr => (tr.points || []).some(pt => this._hitsSegs(pt, segs, TOL)));
        if (!touches && (jA || jB)) {
            const pin = (!jA || (jB && jB.len < jA.len)) ? pb : pa;
            const join = pin === pa ? jA : jB;
            if (join && join.len > TOL) {
                const q = this._splitNetAt(project, net, layer, join.q);
                addPieces(stubPts(pin, q), segs);
            }
        }
        if (added.length) return finish(added[0]);
        return finish(this.addTrace(project, { points: bridgePts, net, layer, width: opts.width }));
    },

    // Numeric index of a pin given a name or index (null when not found).
    pinIndex(project, compId, pin) {
        const comp = project.components.find(c => c.id === compId);
        if (!comp) return null;
        const pins = this.getCompPins(comp);
        if (typeof pin === 'number') return (pin >= 0 && pin < pins.length) ? pin : null;
        const i = pins.findIndex(x => String(x.name) === String(pin));
        return i >= 0 ? i : (pins.length === 1 ? 0 : null);
    },

    // Logical (schematic) wire between two pins: records net connectivity but
    // lays no copper — DRC, hit-testing, export and the autorouter all skip
    // schemWire traces, and the points are only the drawing hint the schematic
    // renderer uses. Pin refs match connectPins: { compId, pin } (name or index).
    // The UI path (schematic-ops.createSchemWire) adds waypoint/T-join/selection
    // handling on top of the same net-resolution rules.
    createSchemWire(project, from, to, opts = {}) {
        if (from.compId === to.compId) throw new Error('createSchemWire: cannot wire two pins of the same component');
        const ia = this.pinIndex(project, from.compId, from.pin);
        const ib = this.pinIndex(project, to.compId, to.pin);
        if (ia === null) throw new Error(`createSchemWire: pin ${JSON.stringify(from.pin)} not found on component ${from.compId}`);
        if (ib === null) throw new Error(`createSchemWire: pin ${JSON.stringify(to.pin)} not found on component ${to.compId}`);
        const pa = this.pinWorld(project, from.compId, ia);
        const pb = this.pinWorld(project, to.compId, ib);
        let name;
        if (opts.net) {
            name = opts.net;
        } else {
            const na = this.getPinNet(project, from.compId, ia);
            const nb = this.getPinNet(project, to.compId, ib);
            if (na && nb) {
                if (na !== nb) throw new Error(`createSchemWire: net conflict "${na}" vs "${nb}" — pass opts.net to choose`);
                name = na;
            } else name = na || nb || this.nextNetName(project);
        }
        const net = this.ensureNet(project, name).name;
        let points = opts.points;
        if (!points) {
            points = [pa, pb];
            // When the routing kernel is loaded, draw the leg around bodies and
            // existing copper so the wire never cuts through a part.
            if (typeof Autoroute !== 'undefined') {
                const leg = Autoroute.routeLeg(project, pa, pb, {
                    net, layer: opts.layer || 'top',
                    traceWidth: opts.width !== undefined ? Number(opts.width) : (project.params.traceWidth || 0.5),
                    endpoints: [
                        { comp: project.components.find(c => c.id === from.compId), pinIndex: ia },
                        { comp: project.components.find(c => c.id === to.compId), pinIndex: ib }
                    ]
                });
                if (leg && leg.points && leg.points.length >= 2) points = leg.points;
            }
        }
        const trace = {
            id: this.nextId(project),
            points: points.map(q => ({ x: Number(q.x), y: Number(q.y) })),
            width: opts.width !== undefined ? Number(opts.width) : (project.params.traceWidth || 0.5),
            layer: opts.layer || 'top',
            net,
            schemWire: true,
            schemEnds: [{ compId: from.compId, pinIndex: ia }, { compId: to.compId, pinIndex: ib }]
        };
        project.traces.push(trace);
        return trace;
    },

    // Lay one net as a rail along a board edge: pins sorted along the rail, a
    // bus stroke at `rail` (explicit coordinate) or offset from the edge by
    // `stub`, and one trace per consecutive pair whose ENDPOINTS ARE THE PINS
    // (A → rail → B). The first pair keeps both drops; each later pair starts
    // on the rail where the previous trace already ended, so a shared drop is
    // not drawn a second time. Creates netlist entries as it
    // routes. Fails the whole call (throws) if any pin is missing — never a
    // partial rail.
    routeRail(project, netName, pins, opts = {}) {
        const edge = opts.edge || 'top';
        const stub = opts.stub !== undefined ? Number(opts.stub) : 2;
        const width = opts.width !== undefined ? Number(opts.width) : (project.params.traceWidth || 0.5);
        const clearance = (project.params && project.params.minClearance) || 0.38;
        const resolved = [];
        for (const ref of pins || []) {
            const pi = this.pinIndex(project, ref.compId, ref.pin);
            const wp = this.pinWorld(project, ref.compId, pi);
            if (pi === null || !wp) throw new Error(`routeRail: pin ${JSON.stringify(ref.pin)} not found on component ${ref.compId}`);
            resolved.push({ compId: ref.compId, pinIndex: pi, x: wp.x, y: wp.y });
        }
        if (resolved.length < 2) throw new Error('routeRail: needs at least two pins');
        const horizontal = edge === 'top' || edge === 'bottom';
        resolved.sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
        const bw = project.board.width / 2, bh = project.board.height / 2;
        let rail;
        if (opts.at !== undefined && opts.at !== null) rail = Number(opts.at);
        else {
            rail = horizontal
                ? (edge === 'top' ? Math.min(...resolved.map(r => r.y)) : Math.max(...resolved.map(r => r.y)))
                : (edge === 'left' ? Math.min(...resolved.map(r => r.x)) : Math.max(...resolved.map(r => r.x)));
        }
        const inset = width / 2 + clearance;
        if (horizontal) rail = Math.max(-bh + inset, Math.min(bh - inset, edge === 'top' ? rail - stub : rail + stub));
        else rail = Math.max(-bw + inset, Math.min(bw - inset, edge === 'left' ? rail - stub : rail + stub));
        const net = netName;
        const planned = [];
        for (let i = 0; i < resolved.length - 1; i++) {
            const a = resolved[i], b = resolved[i + 1];
            // Later pairs omit the drop already drawn for pin `a`.
            const pts = horizontal
                ? (i === 0
                    ? [{ x: a.x, y: a.y }, { x: a.x, y: rail }, { x: b.x, y: rail }, { x: b.x, y: b.y }]
                    : [{ x: a.x, y: rail }, { x: b.x, y: rail }, { x: b.x, y: b.y }])
                : (i === 0
                    ? [{ x: a.x, y: a.y }, { x: rail, y: a.y }, { x: rail, y: b.y }, { x: b.x, y: b.y }]
                    : [{ x: rail, y: a.y }, { x: rail, y: b.y }, { x: b.x, y: b.y }]);
            planned.push({
                a, b,
                points: pts.map(q => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 }))
            });
        }
        if (typeof Plan !== 'undefined' && Plan.wouldCross) {
            for (const item of planned) {
                const hit = Plan.wouldCross(project, item.points, net);
                if (hit) throw new Error(hit);
            }
        }
        this.ensureNet(project, net);
        if (!project.netlist) project.netlist = {};
        const arr = project.netlist[net] || (project.netlist[net] = []);
        for (const r of resolved) {
            const name = String(this.getCompPins(project.components.find(c => c.id === r.compId))[r.pinIndex].name);
            if (!arr.some(e => e.compId === r.compId && String(e.pin) === name)) arr.push({ compId: r.compId, pin: name });
        }
        const traces = [];
        for (const item of planned) {
            const trace = {
                id: this.nextId(project),
                points: item.points,
                width, layer: 'top', net,
                schemEnds: [{ compId: item.a.compId, pinIndex: item.a.pinIndex }, { compId: item.b.compId, pinIndex: item.b.pinIndex }]
            };
            project.traces.push(trace);
            traces.push(trace);
        }
        return { net, traces, rail };
    },

    // Move components in schematic space only (schemX/schemY); board positions
    // are untouched. Entries: { id, x, y }.
    setSchemPositions(project, list) {
        const out = [];
        for (const e of list || []) {
            const comp = project.components.find(c => c.id === e.id);
            if (!comp) continue;
            comp.schemX = Number(e.x);
            comp.schemY = Number(e.y);
            out.push({ id: comp.id, schemX: comp.schemX, schemY: comp.schemY });
        }
        return out;
    },

    addVia(project, spec) {
        const via = {
            id: this.nextId(project),
            x: Number(spec.x),
            y: Number(spec.y),
            diameter: spec.diameter !== undefined ? Number(spec.diameter) : (project.params.viaDiameter || 1.2),
            drill: spec.drill !== undefined ? Number(spec.drill) : null
        };
        project.vias.push(via);
        return via;
    },

    addSilkText(project, spec) {
        const txt = {
            id: this.nextId(project),
            text: String(spec.text || ''),
            x: Number(spec.x) || 0,
            y: Number(spec.y) || 0,
            size: spec.size !== undefined ? Number(spec.size) : 2.0,
            rotation: Number(spec.rotation) || 0,
            layer: spec.layer === 'silkBottom' ? 'silkBottom' : 'silkTop'
        };
        project.silkTexts.push(txt);
        return txt;
    },

    setOutline(project, points) {
        if (!Array.isArray(points) || points.length < 3) throw new Error('setOutline: at least 3 points required');
        project.boardOutline = points.map(p => ({ x: Number(p.x), y: Number(p.y) }));
        return project.boardOutline;
    },

    setBoard(project, patch) {
        const boardPatch = {};
        ['width', 'height', 'thickness'].forEach(k => {
            if (patch[k] !== undefined) boardPatch[k] = Number(patch[k]);
        });
        ['copperWeight', 'material'].forEach(k => {
            if (patch[k] !== undefined) boardPatch[k] = String(patch[k]);
        });
        Object.assign(project.board, boardPatch);
        return project.board;
    },

    setParams(project, patch) {
        const numKeys = ['traceWidth', 'viaDiameter', 'gridSize', 'minTraceWidth', 'minDrill', 'minClearance'];
        numKeys.forEach(k => {
            if (patch[k] !== undefined) project.params[k] = Number(patch[k]);
        });
        if (patch.jumperFollow !== undefined) project.params.jumperFollow = patch.jumperFollow === 'joints' ? 'joints' : 'pads';
        if (patch.routeAngle !== undefined) project.params.routeAngle = patch.routeAngle === 'free' ? 'free' : 'hv45';
        this._normalizeModeParams(project.params);
        return project.params;
    },

    _normalizeModeParams(params) {
        if (!params) return params;
        if (params.jumperFollow !== 'joints') params.jumperFollow = 'pads';
        if (params.routeAngle !== 'free') params.routeAngle = 'hv45';
        return params;
    },

    addNet(project, spec) {
        return this.ensureNet(project, String(spec.name), spec.color);
    },

    // Find an object by id across components/traces/vias/silkTexts.
    findObject(project, id) {
        const lists = [
            ['component', project.components],
            ['trace', project.traces],
            ['via', project.vias],
            ['silk', project.silkTexts]
        ];
        for (const [type, list] of lists) {
            const obj = (list || []).find(o => o.id === id);
            if (obj) return { type, obj };
        }
        return null;
    },

    updateObject(project, spec) {
        const found = this.findObject(project, spec.id);
        if (!found) throw new Error(`updateObject: no object with id ${spec.id}`);
        const patch = Object.assign({}, spec.patch || {});
        delete patch.id; // id is immutable
        Object.assign(found.obj, patch);
        return found.obj;
    },

    removeObject(project, id) {
        const found = this.findObject(project, id);
        if (!found) throw new Error(`removeObject: no object with id ${id}`);
        const listKey = { component: 'components', trace: 'traces', via: 'vias', silk: 'silkTexts' }[found.type];
        project[listKey].splice(project[listKey].indexOf(found.obj), 1);
        return found.type;
    },

    // ------------------------------------------------------------
    // DRC + export — reuse the exact browser logic (drc.js,
    // export.js, dxf.js, gcode.js) so geometry never diverges.
    // ------------------------------------------------------------

    runDrc(project) {
        if (typeof computeDrcViolations !== 'function') {
            return { ok: false, violations: [], error: 'DRC module not loaded' };
        }
        const violations = computeDrcViolations(project);
        return { ok: violations.length === 0, violations };
    },

    // Build an App-like adapter so Export / Dxf / GCode run unmodified.
    adapter(project) {
        const self = this;
        return {
            board: project.board,
            params: project.params,
            export: project.export,
            nets: project.nets || [],
            traces: project.traces || [],
            components: project.components || [],
            vias: project.vias || [],
            boardOutline: project.boardOutline || null,
            silkTexts: project.silkTexts || [],
            // Headless export always includes every layer.
            view: { visibleLayers: { top: true, bottom: true, silkTop: true, silkBottom: true, outline: true } },
            getCompSize(comp) { return self.getCompSize(comp); },
            ensureCompSilkLayout(comp) { self.ensureCompSilkLayout(comp); },
            compSilkFontSize(size) { return self.compSilkFontSize(size); },
            compSilkEffectiveFontSize(pos, size) { return self.compSilkEffectiveFontSize(pos, size); }
        };
    },

    exportSvg(project) {
        if (typeof Export === 'undefined') throw new Error('Export module not loaded');
        return Export.buildSVG(this.adapter(project));
    },

    exportDxf(project) {
        if (typeof Dxf === 'undefined' || typeof Export === 'undefined') throw new Error('Dxf/Export modules not loaded');
        const res = Dxf.generateFromApp(this.adapter(project), Export);
        // generateFromApp returns { ok, dxf, ... } — surface the string on success.
        if (res && res.ok) return res.dxf;
        throw new Error('DXF export failed: ' + ((res && res.error) || 'unknown error'));
    },

    exportGcode(project) {
        if (typeof GCode === 'undefined' || typeof Export === 'undefined') throw new Error('GCode/Export modules not loaded');
        const res = GCode.generateFromApp(this.adapter(project), Export);
        // generateFromApp returns { ok, gcode, ... } — surface the string on success.
        if (res && res.ok) return res.gcode;
        throw new Error('G-code export failed: ' + ((res && res.error) || 'unknown error'));
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ProjectApi;