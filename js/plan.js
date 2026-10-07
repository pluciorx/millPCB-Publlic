// ============================================================
// plan.js — DOM-free design-workflow kernel (CAP-3/4/10)
// ------------------------------------------------------------
// Pure functions over plain project data: plan-aware placement, plan check,
// and good-practice/optimization checks. No DOM, no App state. Loaded after
// project-api.js in index.html and in the MCP host (mcp/host.mjs).
//
// Plan is stored (requirements/zones/assignments/flowDirection); placement
// is DERIVED from it, never stored as truth (AD-1). Zones are axis-aligned
// rects in board mm, origin at board center, Y-down (AD-3). Plan check
// returns a DRC-shaped violation list so it composes with DRC (AD-4).
//
// Coordinate convention: board mm, origin at board center, Y-down.
// ============================================================

const Plan = {

    // ------------------------------------------------------------
    // Geometry helpers
    // ------------------------------------------------------------

    // Zone rect as board-space bounds. x/y are the rect CENTER (board origin
    // at center, Y-down); w/h are full extents (AD-3).
    zoneRect(zone) {
        const hw = (zone.w || 0) / 2, hh = (zone.h || 0) / 2;
        return { minX: zone.x - hw, maxX: zone.x + hw, minY: zone.y - hh, maxY: zone.y + hh };
    },

    pointInZone(x, y, zone) {
        const r = this.zoneRect(zone);
        return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
    },

    // Rotation-aware component body bounding box (half-extents swap at 90/270).
    compBounds(project, comp) {
        const size = ProjectApi.getCompSize(comp);
        const rot = ((comp.rotation || 0) % 360 + 360) % 360;
        let w = size ? size.width : 2, h = size ? size.height : 2;
        if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
        const hw = w / 2, hh = h / 2;
        return { minX: comp.x - hw, maxX: comp.x + hw, minY: comp.y - hh, maxY: comp.y + hh, hw, hh };
    },

    // Two axis-aligned boxes overlap (with a clearance gap between them).
    boxesOverlap(a, b, gap) {
        gap = gap || 0;
        return a.minX < b.maxX - gap && b.minX < a.maxX - gap &&
               a.minY < b.maxY - gap && b.minY < a.maxY - gap;
    },

    // ------------------------------------------------------------
    // CAP-3 — Plan-aware placement
    // ------------------------------------------------------------

    // Compute placement moves for every component assigned to a zone, laid
    // into the zone's slot grid along the flow direction. Returns
    // [{id, x, y}] — does NOT mutate the project (AD-1: placement is derived).
    // Flow 'lr'/'rl' spread along X, 'tb'/'bt' along Y. Components keep their
    // relative order along the flow axis (netlist order the designer set).
    placeByPlan(project) {
        const zones = project.zones || [];
        const assignments = project.assignments || {};
        const flow = project.flowDirection || 'lr';
        const horizontal = flow === 'lr' || flow === 'rl';
        const zoneById = {};
        zones.forEach(z => { zoneById[z.id] = z; });
        const groups = project.groups || [];

        // Natural sort: "1", "2", ... "10" (not "1", "10", "2").
        const natKey = (s) => String(s).replace(/(\d+)(?!.*\d)|(\d+)/g, m => m.padStart(12, '0'));
        const natLabel = (c) => natKey(c.label || String(c.id));

        // Group members by component id.
        const groupOfComp = {};
        groups.forEach((g, gi) => (g.members || []).forEach(id => { groupOfComp[id] = gi; }));

        // Group assigned components by zone, preserving component array order.
        const byZone = {};
        (project.components || []).forEach(c => {
            const zid = assignments[c.id];
            if (zid == null || !zoneById[zid]) return;
            (byZone[zid] = byZone[zid] || []).push(c);
        });

        const moves = [];
        for (const zid of Object.keys(byZone)) {
            const zone = zoneById[zid];
            const comps = byZone[zid];
            const r = this.zoneRect(zone);

            // Zones WITH groups: each group is a channel (row). Member index i
            // of every group lands on the SAME flow-axis coordinate (columns
            // line up: R at X0, trimmer at X1, LED at X2). Channels share the
            // zone's cross-axis center; zone.stagger spreads them across it.
            const zoneGroups = groups
                .filter(g => (g.members || []).some(id => comps.some(c => c.id === id)))
                .sort((a, b) => natKey(a.key) < natKey(b.key) ? -1 : natKey(a.key) > natKey(b.key) ? 1 : 0);
            if (zoneGroups.length) {
                const maxMembers = Math.max.apply(null, zoneGroups.map(g => (g.members || []).length));
                const span = horizontal ? (r.maxX - r.minX) : (r.maxY - r.minY);
                const cross = horizontal ? (r.maxY - r.minY) : (r.maxX - r.minX);
                const margin = Math.min(2, span / (2 * Math.max(maxMembers, 1)));
                const usable = Math.max(0, span - 2 * margin);
                const step = maxMembers > 1 ? usable / (maxMembers - 1) : 0;
                const start = horizontal ? r.minX + margin : r.minY + margin;
                const crossCenter = horizontal ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2;
                const stagger = zone.stagger === true;
                const ng = zoneGroups.length;
                zoneGroups.forEach((g, gi) => {
                    const off = (stagger && ng > 1) ? (-cross / 2 + cross * gi / (ng - 1)) : 0;
                    (g.members || []).forEach((id, mi) => {
                        const c = comps.find(x => x.id === id);
                        if (!c) return;
                        const along = maxMembers > 1 ? start + step * mi : (horizontal ? (r.minX + r.maxX) / 2 : (r.minY + r.maxY) / 2);
                        if (horizontal) moves.push({ id: c.id, x: along, y: crossCenter + off });
                        else moves.push({ id: c.id, x: crossCenter + off, y: along });
                    });
                });
                continue;
            }

            // Zones WITHOUT groups: today's spread, natural label sort.
            comps.sort((a, b) => natLabel(a) < natLabel(b) ? -1 : natLabel(a) > natLabel(b) ? 1 : 0);
            if (flow === 'rl' || flow === 'bt') comps.reverse();

            const n = comps.length;
            const span = horizontal ? (r.maxX - r.minX) : (r.maxY - r.minY);
            const cross = horizontal ? (r.maxY - r.minY) : (r.maxX - r.minX);
            const stagger = zone.stagger === true;
            // Margin so bodies clear the zone edges.
            const margin = Math.min(2, span / (2 * Math.max(n, 1)));
            const usable = Math.max(0, span - 2 * margin);
            const step = n > 1 ? usable / (n - 1) : 0;
            const start = horizontal ? r.minX + margin : r.minY + margin;
            const crossCenter = horizontal ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2;
            for (let i = 0; i < n; i++) {
                const along = n > 1 ? start + step * i : (horizontal ? (r.minX + r.maxX) / 2 : (r.minY + r.maxY) / 2);
                const off = (stagger && n > 1) ? (i % 2 === 0 ? -cross * 0.12 : cross * 0.12) : 0;
                if (horizontal) moves.push({ id: comps[i].id, x: along, y: crossCenter + off });
                else moves.push({ id: comps[i].id, x: crossCenter + off, y: along });
            }
        }
        return moves;
    },

    // Apply placement moves to the project (sets component x/y). Returns count.
    applyPlacement(project, moves) {
        let n = 0;
        (moves || []).forEach(m => {
            const c = (project.components || []).find(x => x.id === m.id);
            if (c) { c.x = m.x; c.y = m.y; n++; }
        });
        return n;
    },

    // ------------------------------------------------------------
    // CAP-4 — Plan check (DRC-shaped violations, AD-4)
    // ------------------------------------------------------------

    // Validate the plan placement: every assigned part inside the board, inside
    // its zone, and not overlapping another part. Returns violations[] in the
    // DRC shape {type, severity, msg}. Pure — never throws.
    planCheck(project) {
        const violations = [];
        const comps = project.components || [];
        const zones = project.zones || [];
        const assignments = project.assignments || {};
        const zoneById = {};
        zones.forEach(z => { zoneById[z.id] = z; });
        const bw = (project.board && project.board.width) || 100;
        const bh = (project.board && project.board.height) || 60;
        const clearance = (project.params && project.params.minClearance) || 0.38;

        for (const c of comps) {
            const b = this.compBounds(project, c);
            // In board bounds.
            if (b.minX < -bw / 2 || b.maxX > bw / 2 || b.minY < -bh / 2 || b.maxY > bh / 2) {
                violations.push({ type: 'out-of-board', severity: 'error', msg: `${c.label || c.id} outside board bounds` });
            }
            // In its assigned zone.
            const zid = assignments[c.id];
            if (zid != null && zoneById[zid]) {
                if (!this.pointInZone(c.x, c.y, zoneById[zid])) {
                    violations.push({ type: 'out-of-zone', severity: 'error', msg: `${c.label || c.id} outside assigned zone ${zoneById[zid].name || zid}` });
                }
            }
        }

        // Overlaps (pairwise, with clearance gap).
        for (let i = 0; i < comps.length; i++) {
            for (let j = i + 1; j < comps.length; j++) {
                const a = this.compBounds(project, comps[i]);
                const b = this.compBounds(project, comps[j]);
                if (this.boxesOverlap(a, b, clearance)) {
                    violations.push({ type: 'overlap', severity: 'error', msg: `${comps[i].label || comps[i].id} overlaps ${comps[j].label || comps[j].id}` });
                }
            }
        }
        return violations;
    },

    // ---- Circuit contract check (spec §5) --------------------------------
    // Contract: { rails: [{net, pins?}], branches: [{net, from, to}], ties: [{net, pins}] }
    // Verifies declared intent against real copper. Pair joined by copper =
    // good; joined only via netlist = needs-routing; not joined = disconnected;
    // copper path runs through a foreign-net pad = wrong-net.
    circuitCheck(project, contract) {
        contract = contract || project.circuitContract || {};
        const touch = (typeof Autoroute !== 'undefined' && Autoroute.NET_TOUCH) || 0.15;
        const ptSeg = (p, a, b) => {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
            let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        };
        // Connectivity groups for one net. mode 'full' = copper + netlist,
        // mode 'copper' = copper only (netlist stripped).
        const groupsFor = (net, mode) => {
            const src = mode === 'copper' ? { ...project, netlist: {} } : project;
            const members = [];
            const seen = new Set();
            const addMember = (compId, pinIndex) => {
                const k = compId + ':' + pinIndex;
                if (seen.has(k)) return;
                seen.add(k);
                members.push({ compId, pinIndex });
            };
            if (mode === 'full') {
                for (const ref of ((project.netlist || {})[net] || [])) {
                    const pi = ProjectApi.pinIndex(project, ref.compId, ref.pin);
                    if (pi !== null) addMember(ref.compId, pi);
                }
            }
            for (const c of (src.components || [])) {
                const pins = ProjectApi.getCompPins(c);
                for (let pi = 0; pi < pins.length; pi++) {
                    if (ProjectApi.getPinNet(src, c.id, pi) === net) addMember(c.id, pi);
                }
            }
            if (!members.length) return null;
            const traces = (src.traces || []).filter(t => t.net === net && !t.schemWire);
            const parent = new Array(members.length + traces.length);
            for (let i = 0; i < parent.length; i++) parent[i] = i;
            const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
            const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
            if (mode === 'full') {
                // The netlist DECLARES its members on one net: they are joined
                // logically even before copper exists. Copper then only decides
                // needs-routing vs routed.
                for (let i = 1; i < members.length; i++) union(0, i);
            }
            for (let mi = 0; mi < members.length; mi++) {
                const w = ProjectApi.pinWorld(src, members[mi].compId, members[mi].pinIndex);
                if (!w) continue;
                for (let k = 0; k < traces.length; k++) {
                    const pts = traces[k].points || [];
                    if (pts.length < 2) continue;
                    let joined = false;
                    for (let s = 0; s + 1 < pts.length && !joined; s++) if (ptSeg(w, pts[s], pts[s + 1]) < touch) joined = true;
                    if (!joined) {
                        const f = pts[0], l = pts[pts.length - 1];
                        if (Math.hypot(f.x - w.x, f.y - w.y) < touch || Math.hypot(l.x - w.x, l.y - w.y) < touch) joined = true;
                    }
                    if (joined) union(mi, members.length + k);
                }
            }
            for (let a = 0; a < traces.length; a++) {
                const pa = traces[a].points || [];
                if (pa.length < 2) continue;
                for (let b = a + 1; b < traces.length; b++) {
                    const pb = traces[b].points || [];
                    if (pb.length < 2) continue;
                    let joined = false;
                    const endsA = [pa[0], pa[pa.length - 1]], endsB = [pb[0], pb[pb.length - 1]];
                    for (const e of endsA) { for (let s = 0; s + 1 < pb.length; s++) if (ptSeg(e, pb[s], pb[s + 1]) < touch) { joined = true; break; } if (joined) break; }
                    if (!joined) for (const e of endsB) { for (let s = 0; s + 1 < pa.length; s++) if (ptSeg(e, pa[s], pa[s + 1]) < touch) { joined = true; break; } if (joined) break; }
                    if (joined) union(members.length + a, members.length + b);
                }
            }
            const rootOf = new Map();
            for (let mi = 0; mi < members.length; mi++) {
                const c = (src.components || []).find(x => x.id === members[mi].compId);
                const pins = c ? ProjectApi.getCompPins(c) : [];
                const pin = pins[members[mi].pinIndex] || {};
                if (pin.num !== undefined) rootOf.set(members[mi].compId + '|' + String(pin.num), find(mi));
                if (pin.name !== undefined) rootOf.set(members[mi].compId + '|' + String(pin.name), find(mi));
            }
            return rootOf;
        };
        // Foreign-net pads sitting on copper groups of this net.
        const foreignOn = (net) => {
            const copperRoot = groupsFor(net, 'copper');
            if (!copperRoot) return new Map();
            const roots = new Set(copperRoot.values());
            const foreign = new Map(); // root -> [{compId,pin,net}]
            for (const c of (project.components || [])) {
                const pins = ProjectApi.getCompPins(c);
                for (let pi = 0; pi < pins.length; pi++) {
                    const pinNet = ProjectApi.getPinNet(project, c.id, pi);
                    if (!pinNet || pinNet === net) continue;
                    const pin = pins[pi] || {};
                    const num = String(pin.num !== undefined ? pin.num : (pin.name !== undefined ? pin.name : pi));
                    const k = c.id + '|' + num;
                    const kN = c.id + '|' + String(pin.name !== undefined ? pin.name : pi);
                    const r = copperRoot.get(k);
                    const rN = copperRoot.get(kN);
                    const rr = r !== undefined ? r : rN;
                    if (rr === undefined) continue;
                    const list = foreign.get(rr) || [];
                    list.push({ compId: c.id, pin: num, net: pinNet });
                    foreign.set(rr, list);
                }
            }
            return foreign;
        };
        const violations = [];
        const cache = {};
        const copperCache = {};
        const getGroups = (net, mode) => {
            const k = net + '|' + mode;
            if (!cache[k]) cache[k] = groupsFor(net, mode);
            return cache[k];
        };
        const getForeign = (net) => {
            if (!copperCache[net]) copperCache[net] = foreignOn(net);
            return copperCache[net];
        };
        const checkPair = (net, a, b, kind) => {
            const openType = kind === 'rail' ? 'rail-split' : kind === 'tie' ? 'tie-open' : 'branch-open';
            const ka = a.compId + '|' + a.pin, kb = b.compId + '|' + b.pin;
            const full = getGroups(net, 'full');
            const ga = full ? full.get(ka) : undefined, gb = full ? full.get(kb) : undefined;
            if (ga === undefined || gb === undefined) { violations.push({ type: 'unknown-pin', net, pins: [ka, kb] }); return; }
            if (ga !== gb) { violations.push({ type: 'disconnected', net, pins: [ka, kb] }); return; }
            const cop = getGroups(net, 'copper');
            const ca = cop ? cop.get(ka) : undefined, cb = cop ? cop.get(kb) : undefined;
            if (ca !== undefined && ca === cb) {
                const fr = (getForeign(net).get(ca) || []);
                if (fr.length) violations.push({ type: 'wrong-net', net, pins: [ka, kb], foreign: fr.slice(0, 5) });
            } else {
                violations.push({ type: openType, net, pins: [ka, kb] });
            }
        };
        const memberPairs = (kind, net, pins) => {
            let members = pins;
            if (!members) {
                const nl = (project.netlist || {})[net];
                if (!nl || nl.length < 2) { violations.push({ type: 'unknown-net', net }); return null; }
                members = nl.map(m => ({ compId: m.compId, pin: m.pin }));
            }
            members = members.map(m => ({ compId: m.compId, pin: String(m.pin) }));
            if (members.length < 2) { violations.push({ type: 'unknown-net', net }); return null; }
            return members;
        };
        for (const rail of (contract.rails || [])) {
            const members = memberPairs('rail', rail.net, rail.pins);
            if (!members) continue;
            for (let i = 0; i < members.length - 1; i++) checkPair(rail.net, members[i], members[i + 1], 'rail');
        }
        for (const br of (contract.branches || [])) {
            if (!br.from || !br.to) { violations.push({ type: 'unknown-pin', net: br.net }); continue; }
            checkPair(br.net, { compId: br.from.compId, pin: String(br.from.pin) }, { compId: br.to.compId, pin: String(br.to.pin) }, 'branch');
        }
        for (const tie of (contract.ties || [])) {
            const members = memberPairs('tie', tie.net, tie.pins);
            if (!members) continue;
            for (let i = 0; i < members.length - 1; i++) checkPair(tie.net, members[i], members[i + 1], 'tie');
        }
        return violations;
    },

    // Logical circuit check (docs/millpcb_agent_instructions.md §6–8).
    // Contract vs the NETLIST / schematic wires — no copper required.
    // Missing contract is a failure. A clean result is electricalOk:
    // copper tools may open. Copper match stays in circuitCheck.
    // Contract: { rails, branches, ties, unused: [{compId, pin}] }.
    electricalCheck(project, contract) {
        contract = contract || project.circuitContract || null;
        const violations = [];
        const rails = (contract && contract.rails) || [];
        const branches = (contract && contract.branches) || [];
        const ties = (contract && contract.ties) || [];
        const unused = (contract && contract.unused) || [];
        if (!rails.length && !branches.length && !ties.length) {
            violations.push({ type: 'missing-contract', severity: 'error', msg: 'No circuit contract. Declare rails, branches and ties with millpcb_check type="circuit". A netlist alone is not validation.' });
            return violations;
        }

        const pinNet = new Map();
        const membersByNet = {};
        const note = (net, compId, pinRef) => {
            const pi = ProjectApi.pinIndex(project, compId, pinRef);
            if (pi === null) return null;
            const comp = (project.components || []).find(c => c.id === compId);
            const pins = comp ? ProjectApi.getCompPins(comp) : [];
            const name = pins[pi] && pins[pi].name != null ? String(pins[pi].name) : String(pinRef);
            const k = compId + ':' + pi;
            const prev = pinNet.get(k);
            if (prev && prev !== net) {
                violations.push({ type: 'net-merge', severity: 'error', compId, pin: name, nets: [prev, net], msg: `${comp ? (comp.label || comp.id) : compId} pin ${name} is on both ${prev} and ${net}` });
            } else if (!prev) pinNet.set(k, net);
            const list = membersByNet[net] || (membersByNet[net] = []);
            if (!list.some(m => m.compId === compId && m.pinIndex === pi)) list.push({ compId, pin: name, pinIndex: pi });
            return { compId, pin: name, pinIndex: pi };
        };
        for (const net of Object.keys(project.netlist || {})) {
            for (const m of project.netlist[net] || []) note(net, m.compId, m.pin);
        }
        for (const t of project.traces || []) {
            if (!t.schemWire || !t.net) continue;
            for (const end of t.schemEnds || []) note(t.net, end.compId, end.pinIndex);
        }

        const unusedKeys = new Set();
        for (const u of unused) {
            const pi = ProjectApi.pinIndex(project, u.compId, u.pin);
            if (pi === null) {
                violations.push({ type: 'unknown-pin', severity: 'error', compId: u.compId, pin: String(u.pin), msg: `unused pin ${u.compId}:${u.pin} does not exist` });
                continue;
            }
            unusedKeys.add(u.compId + ':' + pi);
        }

        for (const c of project.components || []) {
            const pins = ProjectApi.getCompPins(c);
            for (let pi = 0; pi < pins.length; pi++) {
                const k = c.id + ':' + pi;
                const name = pins[pi] && pins[pi].name != null ? String(pins[pi].name) : String(pi);
                const onNet = pinNet.get(k);
                const isUnused = unusedKeys.has(k);
                if (!onNet && !isUnused) {
                    violations.push({ type: 'floating-pin', severity: 'error', compId: c.id, pin: name, msg: `${c.label || c.id} pin ${name} is not on a net and not marked unused` });
                } else if (onNet && isUnused) {
                    violations.push({ type: 'unused-assigned', severity: 'error', compId: c.id, pin: name, net: onNet, msg: `${c.label || c.id} pin ${name} is marked unused but is on ${onNet}` });
                }
            }
        }

        const covered = new Set();
        for (const rail of rails) if (rail && rail.net) covered.add(rail.net);
        for (const br of branches) if (br && br.net) covered.add(br.net);
        for (const tie of ties) if (tie && tie.net) covered.add(tie.net);
        for (const net of Object.keys(membersByNet)) {
            if ((membersByNet[net] || []).length >= 2 && !covered.has(net)) {
                violations.push({ type: 'uncovered-net', severity: 'error', net, msg: `Net ${net} is declared on the schematic but missing from the circuit contract` });
            }
        }

        const expectOn = (net, compId, pinRef) => {
            const pi = ProjectApi.pinIndex(project, compId, pinRef);
            if (pi === null) {
                violations.push({ type: 'unknown-pin', severity: 'error', net, compId, pin: String(pinRef), msg: `Pin ${compId}:${pinRef} does not exist` });
                return;
            }
            const actual = pinNet.get(compId + ':' + pi);
            if (actual === net) return;
            const comp = (project.components || []).find(c => c.id === compId);
            const who = comp ? (comp.label || comp.id) : compId;
            if (!actual) violations.push({ type: 'disconnected', severity: 'error', net, compId, pin: String(pinRef), msg: `${who} pin ${pinRef} is not on ${net}` });
            else violations.push({ type: 'wrong-net', severity: 'error', net, actual, compId, pin: String(pinRef), msg: `${who} pin ${pinRef} is on ${actual}, contract says ${net}` });
        };

        for (const rail of rails) {
            if (!rail || !rail.net) { violations.push({ type: 'unknown-net', severity: 'error', msg: 'rail is missing a net name' }); continue; }
            const pins = rail.pins;
            if (pins && pins.length) {
                if (pins.length < 2) violations.push({ type: 'unknown-net', severity: 'error', net: rail.net, msg: `Rail ${rail.net} needs at least two pins` });
                for (const m of pins) expectOn(rail.net, m.compId, m.pin);
            } else if ((membersByNet[rail.net] || []).length < 2) {
                violations.push({ type: 'unknown-net', severity: 'error', net: rail.net, msg: `Rail ${rail.net} is not a net with two or more pins` });
            }
        }
        for (const br of branches) {
            if (!br || !br.net || !br.from || !br.to) {
                violations.push({ type: 'unknown-pin', severity: 'error', net: br && br.net, msg: 'branch needs net, from and to' });
                continue;
            }
            expectOn(br.net, br.from.compId, br.from.pin);
            expectOn(br.net, br.to.compId, br.to.pin);
        }
        for (const tie of ties) {
            if (!tie || !tie.net) { violations.push({ type: 'unknown-net', severity: 'error', msg: 'tie is missing a net name' }); continue; }
            const pins = tie.pins || [];
            if (pins.length < 2) { violations.push({ type: 'unknown-net', severity: 'error', net: tie.net, msg: `Tie ${tie.net} needs at least two pins` }); continue; }
            const comps = new Set(pins.map(m => m.compId));
            if (comps.size !== 1) violations.push({ type: 'tie-split', severity: 'error', net: tie.net, msg: `Tie ${tie.net} must join pins of one component` });
            for (const m of pins) expectOn(tie.net, m.compId, m.pin);
        }
        return violations;
    },

    // ------------------------------------------------------------
    // CAP-10 — Good-practices / optimization checks
    // ------------------------------------------------------------

    // Machine-checkable quality gate beyond raw DRC, run each loop pass.
    // Returns violations[] in the DRC shape. Checks: single-layer (no vias),
    // cross-net trace crossings, GND as one connected net, components grouped
    // by zone. Pure — never throws.
    qualityCheck(project) {
        const violations = [];

        // Single-layer: vias are not routable on a drilled/laser-cut sheet.
        if ((project.vias || []).length) {
            violations.push({ type: 'single-layer', severity: 'error', msg: `${project.vias.length} via(s) on a single-layer board — use a wire jumper, not a via` });
        }

        // Cross-net trace crossings (planar violation: two nets cross with no jumper).
        const crossings = this.crossNetCrossings(project);
        for (const cx of crossings) violations.push({ type: 'crossing', severity: 'error', msg: cx });

        // Every net must be ONE connected copper net (tree/rail), never islands.
        // GND keeps its dedicated message; all other nets with >1 component are
        // reported too (the spec: report every split net, not only GND).
        const netNames = new Set((project.nets || []).map(n => n.name));
        for (const t of project.traces || []) if (t.net && !t.schemWire) netNames.add(t.net);
        for (const n of Object.keys(project.netlist || {})) netNames.add(n);
        for (const netName of netNames) {
            const g = this.netConnectivity(project, netName);
            if (g && g.components > 1 && g.groups > 1) {
                if (netName === 'GND') {
                    violations.push({ type: 'gnd-disconnected', severity: 'error', msg: `GND net spans ${g.components} components in ${g.groups} disconnected groups — connect as one tree/rail` });
                } else {
                    violations.push({ type: 'net-disconnected', severity: 'error', msg: `${netName} net spans ${g.components} components in ${g.groups} disconnected groups — connect as one tree/rail` });
                }
            }
        }

        return violations;
    },

    // Count cross-net trace crossings among physical (non-schematic) traces.
    // Returns human-readable messages. Uses segment-segment intersection.
    crossNetCrossings(project) {
        const out = [];
        const traces = (project.traces || []).filter(t => !t.schemWire && t.net);
        for (let i = 0; i < traces.length; i++) {
            for (let j = i + 1; j < traces.length; j++) {
                if (traces[i].net === traces[j].net) continue;
                if (this.traceSegmentsCross(traces[i].points, traces[j].points)) {
                    out.push(`${traces[i].net} (T${traces[i].id}) crosses ${traces[j].net} (T${traces[j].id}) — single-layer crossing, needs a jumper`);
                }
            }
        }
        return out;
    },

    // First other-net trace this polyline would short. Null when the copper is safe to store.
    // Shared endpoints and same-net joins are not crossings (see segsIntersect).
    wouldCross(project, points, net) {
        const name = net || '';
        const traces = (project.traces || []).filter(t => t && !t.schemWire && t.net && t.net !== name);
        for (const t of traces) {
            if (this.traceSegmentsCross(points, t.points)) {
                return `${name || 'net'} would cross ${t.net} (T${t.id}) — not placed (single-layer short)`;
            }
        }
        return null;
    },

    traceSegmentsCross(pa, pb) {
        pa = pa || []; pb = pb || [];
        for (let i = 0; i + 1 < pa.length; i++) {
            for (let j = 0; j + 1 < pb.length; j++) {
                if (this.segsIntersect(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true;
            }
        }
        return false;
    },

    // Proper segment-segment intersection (shared endpoints are not crossings).
    segsIntersect(a, b, c, d) {
        const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
        const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
        return false; // collinear touches ignored (same-net joins are not crossings)
    },

    // Electrical connectivity of a named net over physical copper: how many
    // components carry the net, and how many disconnected copper groups they
    // form. Returns {components, groups} or null when the net has no members.
    // Joins use the autorouter's union rule at NET_TOUCH: a pad within NET_TOUCH
    // of any VERTEX **or SEGMENT** of a same-net trace, and two same-net traces
    // join when an endpoint of one lies within NET_TOUCH of a segment of the
    // other. Members may come from the stored netlist (no copper needed to be a
    // member) as well as from geometry.
    netConnectivity(project, netName) {
        const comps = project.components || [];
        const members = [];
        const seen = new Set();
        const addMember = (compId, pinIndex) => {
            const k = compId + ':' + pinIndex;
            if (seen.has(k)) return;
            seen.add(k);
            members.push({ compId, pinIndex });
        };
        const nl = (project.netlist && project.netlist[netName]) || [];
        for (const ref of nl) {
            const pi = ProjectApi.pinIndex(project, ref.compId, ref.pin);
            if (pi !== null) addMember(ref.compId, pi);
        }
        for (const c of comps) {
            const pins = ProjectApi.getCompPins(c);
            for (let pi = 0; pi < pins.length; pi++) {
                if (ProjectApi.getPinNet(project, c.id, pi) === netName) { addMember(c.id, pi); break; }
            }
        }
        if (!members.length) return null;
        // Union-find over member pads joined by same-net traces.
        const traces = (project.traces || []).filter(t => t.net === netName && !t.schemWire);
        const parent = new Array(members.length + traces.length);
        for (let i = 0; i < parent.length; i++) parent[i] = i;
        const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
        const touch = (typeof Autoroute !== 'undefined' && Autoroute.NET_TOUCH) || 0.15;
        const ptSeg = (p, a, b) => {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
            let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        };
        for (let mi = 0; mi < members.length; mi++) {
            const w = ProjectApi.pinWorld(project, members[mi].compId, members[mi].pinIndex);
            if (!w) continue;
            for (let k = 0; k < traces.length; k++) {
                const pts = traces[k].points || [];
                if (!pts.length) continue;
                let joined = false;
                for (let s = 0; s + 1 < pts.length && !joined; s++) if (ptSeg(w, pts[s], pts[s + 1]) < touch) joined = true;
                if (!joined) {
                    const f = pts[0], l = pts[pts.length - 1];
                    if (Math.hypot(f.x - w.x, f.y - w.y) < touch || Math.hypot(l.x - w.x, l.y - w.y) < touch) joined = true;
                }
                if (joined) union(mi, members.length + k);
            }
        }
        // Trace<->trace: endpoint of one within NET_TOUCH of a segment of the other.
        for (let a = 0; a < traces.length; a++) {
            const pa = traces[a].points || [];
            if (pa.length < 2) continue;
            for (let b = a + 1; b < traces.length; b++) {
                const pb = traces[b].points || [];
                if (pb.length < 2) continue;
                let touch2 = false;
                const endsA = [pa[0], pa[pa.length - 1]], endsB = [pb[0], pb[pb.length - 1]];
                for (const e of endsA) { for (let s = 0; s + 1 < pb.length; s++) if (ptSeg(e, pb[s], pb[s + 1]) < touch) { touch2 = true; break; } if (touch2) break; }
                if (!touch2) for (const e of endsB) { for (let s = 0; s + 1 < pa.length; s++) if (ptSeg(e, pa[s], pa[s + 1]) < touch) { touch2 = true; break; } if (touch2) break; }
                if (touch2) union(members.length + a, members.length + b);
            }
        }
        const compRoot = {};
        for (let mi = 0; mi < members.length; mi++) compRoot[members[mi].compId] = find(mi);
        const groups = new Set(Object.values(compRoot));
        return { components: Object.keys(compRoot).length, groups: groups.size };
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = Plan;
