// Schematic topology placer + obstacle/overlap-aware orthogonal router.
// DOM-free. Global SchematicLayout for App and Node tests.
const SchematicLayout = {
    SNAP: 20,
    RING_X: 100,
    RING_Y: 80,
    MATCH_MM: 1.5,

    placeMissing(components, traces, netlist) {
        if (!components || !components.length) return;
        const missing = components.filter(c => typeof c.schemX !== 'number' || typeof c.schemY !== 'number');
        if (!missing.length) return;
        const placed = components.filter(c => typeof c.schemX === 'number' && typeof c.schemY === 'number');
        const graph = this._graph(components, traces || [], netlist);
        const taken = new Set();
        placed.forEach(c => taken.add(this._key(c.schemX, c.schemY)));
        if (placed.length) this._placeIncremental(components, missing, graph, taken);
        else this._placeFresh(components, graph, taken);
        components.forEach(c => {
            if (typeof c.schemX === 'number' && typeof c.schemY === 'number') return;
            this._assignIsolated(c, components, taken);
        });
    },

    outwardStub(pin, bounds, lane) {
        if (!pin) return pin;
        if (!bounds) return { x: pin.x, y: pin.y };
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        let dx = pin.x - cx, dy = pin.y - cy;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) dx = 1;
        const horiz = Math.abs(dx) >= Math.abs(dy);
        const ux = horiz ? (dx >= 0 ? 1 : -1) : 0;
        const uy = horiz ? 0 : (dy >= 0 ? 1 : -1);
        let x = pin.x, y = pin.y;
        for (let i = 0; i < 48; i++) {
            if (x <= bounds.minX || x >= bounds.maxX || y <= bounds.minY || y >= bounds.maxY) break;
            x += ux * 2;
            y += uy * 2;
        }
        const pad = 8 + (Math.abs(lane || 0) % 6) * 8;
        return { x: x + ux * pad, y: y + uy * pad };
    },

    _dedupePts(pts) {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i], last = out[out.length - 1];
            if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
        }
        return out;
    },

    route(aw, bw, obstacles, occupied, opts) {
        if (!aw || !bw) return [aw, bw];
        if (aw.x === bw.x && aw.y === bw.y) return [aw, bw];
        const obs = obstacles || [];
        const occ = occupied || [];
        const aBound = opts && opts.aBound;
        const bBound = opts && opts.bBound;
        // Deepen the pin stubs (lane increases the exit pad) until the assembled path —
        // stubs included — clears every distinct-net wire. A stub elbow that lands on
        // another net's channel is a short, so push it out of that channel.
        let best = null;
        for (let lane = 0; lane <= 6; lane++) {
            const sa = aBound ? this.outwardStub(aw, aBound, (opts.aLane || 0) + lane) : aw;
            const sb = bBound ? this.outwardStub(bw, bBound, (opts.bLane || 0) + lane) : bw;
            const mid = this._routeOrtho({ x: sa.x, y: sa.y }, { x: sb.x, y: sb.y }, obs, occ);
            const pts = this._dedupePts([aw, { x: sa.x, y: sa.y }, ...mid, { x: sb.x, y: sb.y }, bw]);
            if (pts.length < 2) continue;
            if (!this.pathOverlaps(pts, occ)) return pts;
            if (!best) best = pts;
        }
        return best || [aw, bw];
    },

    _routeOrtho(aw, bw, obs, occ) {
        if (aw.x === bw.x && aw.y === bw.y) return [aw, bw];
        const tryPath = (pts) => this.pathClear(pts, obs) && !this.pathOverlaps(pts, occ);

        const alignedX = Math.abs(aw.x - bw.x) < 0.5;
        const alignedY = Math.abs(aw.y - bw.y) < 0.5;
        if (alignedX || alignedY) {
            if (tryPath([aw, bw])) return [aw, bw];
        } else {
            const vElbow = { x: aw.x, y: bw.y };
            if (tryPath([aw, vElbow, bw])) return [aw, vElbow, bw];
            const hElbow = { x: bw.x, y: aw.y };
            if (tryPath([aw, hElbow, bw])) return [aw, hElbow, bw];
        }

        const dx = bw.x - aw.x, dy = bw.y - aw.y;
        const tryStaples = (horizDom) => {
            const channels = horizDom
                ? this._channels(aw.y, bw.y, occ, 'y')
                : this._channels(aw.x, bw.x, occ, 'x');
            for (const ch of channels) {
                const pts = horizDom
                    ? [aw, { x: aw.x, y: ch }, { x: bw.x, y: ch }, bw]
                    : [aw, { x: ch, y: aw.y }, { x: ch, y: bw.y }, bw];
                if (tryPath(pts)) return pts;
            }
            return null;
        };
        const first = tryStaples(Math.abs(dx) >= Math.abs(dy));
        if (first) return first;
        const second = tryStaples(Math.abs(dx) < Math.abs(dy));
        if (second) return second;

        const farAt = (pad) => [
            [aw, { x: aw.x, y: Math.min(aw.y, bw.y) - pad }, { x: bw.x, y: Math.min(aw.y, bw.y) - pad }, bw],
            [aw, { x: aw.x, y: Math.max(aw.y, bw.y) + pad }, { x: bw.x, y: Math.max(aw.y, bw.y) + pad }, bw],
            [aw, { x: Math.min(aw.x, bw.x) - pad, y: aw.y }, { x: Math.min(aw.x, bw.x) - pad, y: bw.y }, bw],
            [aw, { x: Math.max(aw.x, bw.x) + pad, y: aw.y }, { x: Math.max(aw.x, bw.x) + pad, y: bw.y }, bw]
        ];
        const detours = this._bboxDetours(aw, bw, obs);
        for (const pts of detours) {
            if (tryPath(pts)) return pts;
        }
        for (let pad = 80; pad <= 640; pad += 40) {
            const far = farAt(pad);
            for (let i = 0; i < far.length; i++) {
                if (tryPath(far[i])) return far[i];
            }
        }
        // Last resort: prefer a path that is also free of distinct-net overlaps, so a
        // wire never crosses/stacks another net when any overlap-free route exists.
        for (const pts of detours) {
            if (this.pathClear(pts, obs) && !this.pathOverlaps(pts, occ)) return pts;
        }
        for (let pad = 80; pad <= 2000; pad += 40) {
            const far = farAt(pad);
            for (let i = 0; i < far.length; i++) {
                if (this.pathClear(far[i], obs) && !this.pathOverlaps(far[i], occ)) return far[i];
            }
        }
        if (this.pathClear([aw, bw], obs) && !this.pathOverlaps([aw, bw], occ)) return [aw, bw];
        // No clean route exists: fall back to a straight pin-to-pin line. This is the
        // least-bad option — a giant far-pad loop (the old farAt(2000) fallback) sweeps
        // across the whole sheet and overlaps every net it passes.
        return [aw, bw];
    },

    pathClear(pts, obstacles) {
        if (!pts || pts.length < 2 || !obstacles || !obstacles.length) return true;
        for (let i = 0; i < pts.length - 1; i++) {
            if (this.segHitsBody(pts[i], pts[i + 1], obstacles)) return false;
        }
        return true;
    },

    pathOverlaps(pts, occupied) {
        if (!pts || pts.length < 2 || !occupied || !occupied.length) return false;
        for (let i = 0; i < pts.length - 1; i++) {
            for (let o = 0; o < occupied.length; o++) {
                if (this.segsTouch(pts[i], pts[i + 1], occupied[o].p, occupied[o].q)) return true;
            }
        }
        return false;
    },

    // Any intersection between segments p->q and s->t, INCLUDING endpoint touches.
    // Used only for distinct-net occupancy, so every touch is a short: a stub elbow
    // landing on another net's wire counts, not just a mid-segment "X".
    segsTouch(p, q, s, t) {
        const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        const d1 = o(s, t, p), d2 = o(s, t, q), d3 = o(p, q, s), d4 = o(p, q, t);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
        const on = (a, b, c) => Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) &&
            Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
        if (d1 === 0 && on(s, t, p)) return true;
        if (d2 === 0 && on(s, t, q)) return true;
        if (d3 === 0 && on(p, q, s)) return true;
        if (d4 === 0 && on(p, q, t)) return true;
        return false;
    },

    // Open segment p->q strictly inside any AABB. Touching an edge is not a hit.
    segHitsBody(p, q, obstacles) {
        for (let i = 0; i < obstacles.length; i++) {
            const o = obstacles[i];
            if (Math.max(p.x, q.x) < o.minX || Math.min(p.x, q.x) > o.maxX) continue;
            if (Math.max(p.y, q.y) < o.minY || Math.min(p.y, q.y) > o.maxY) continue;
            const dx = q.x - p.x, dy = q.y - p.y;
            if (dx === 0 && dy === 0) {
                if (p.x > o.minX && p.x < o.maxX && p.y > o.minY && p.y < o.maxY) return true;
                continue;
            }
            // Axis-aligned run on a face is an edge touch, not an interior hit.
            if (dx === 0 && !(p.x > o.minX && p.x < o.maxX)) continue;
            if (dy === 0 && !(p.y > o.minY && p.y < o.maxY)) continue;
            let t0 = 0, t1 = 1;
            if (dx !== 0) {
                const ta = (o.minX - p.x) / dx, tb = (o.maxX - p.x) / dx;
                t0 = Math.max(t0, Math.min(ta, tb));
                t1 = Math.min(t1, Math.max(ta, tb));
            }
            if (dy !== 0) {
                const ta = (o.minY - p.y) / dy, tb = (o.maxY - p.y) / dy;
                t0 = Math.max(t0, Math.min(ta, tb));
                t1 = Math.min(t1, Math.max(ta, tb));
            }
            if (t1 > t0) {
                const fromEnd = t0 <= 1e-9 && t1 < 1 - 1e-9;
                const toEnd = t0 > 1e-9 && t1 >= 1 - 1e-9;
                const clipLen = Math.hypot(dx, dy) * (t1 - t0);
                if ((fromEnd || toEnd) && clipLen <= 16) continue;
                return true;
            }
        }
        return false;
    },

    collinearOverlap(p, q, s, t, eps) {
        if (eps == null) eps = 2;
        const overlap = (a0, a1, b0, b1) => Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)) > eps;
        const horiz = Math.abs(p.y - q.y) < eps && Math.abs(s.y - t.y) < eps && Math.abs(p.y - s.y) < eps;
        const vert = Math.abs(p.x - q.x) < eps && Math.abs(s.x - t.x) < eps && Math.abs(p.x - s.x) < eps;
        if (horiz) return overlap(p.x, q.x, s.x, t.x);
        if (vert) return overlap(p.y, q.y, s.y, t.y);
        return false;
    },

    _snap(v) { return Math.round(v / this.SNAP) * this.SNAP; },
    _key(x, y) { return Math.round(x) + ',' + Math.round(y); },

    _pinBoardPos(comp, pinIndex) {
        const pins = (comp && comp.pins) ? comp.pins : [];
        const pin = pins[pinIndex];
        if (!pin) return null;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return { x: comp.x + pin.x * cos - pin.y * sin, y: comp.y + pin.x * sin + pin.y * cos };
    },

    _matchPin(components, pt) {
        let best = null, bd = Infinity;
        for (let c = 0; c < components.length; c++) {
            const comp = components[c];
            const pins = comp.pins || [];
            for (let i = 0; i < pins.length; i++) {
                const bp = this._pinBoardPos(comp, i);
                if (!bp) continue;
                const d = Math.hypot(bp.x - pt.x, bp.y - pt.y);
                if (d < bd) { bd = d; best = { comp, pinIndex: i }; }
            }
        }
        return bd < this.MATCH_MM ? best : null;
    },

    _graph(components, traces, netlist) {
        const byId = {};
        components.forEach(c => { byId[c.id] = { comp: c, nbrs: [] }; });
        const netsOf = {};
        components.forEach(c => { netsOf[c.id] = new Set(); });
        (traces || []).forEach(tr => {
            if (!tr || !tr.points || tr.points.length < 2) return;
            const a = this._matchPin(components, tr.points[0]);
            const b = this._matchPin(components, tr.points[tr.points.length - 1]);
            if (!a) return;
            netsOf[a.comp.id].add(tr.net || '');
            if (!b || a.comp.id === b.comp.id) return;
            netsOf[b.comp.id].add(tr.net || '');
            this._addNbr(byId[a.comp.id].nbrs, { id: b.comp.id, net: tr.net || '', pinSelf: a.pinIndex, pinOther: b.pinIndex });
            this._addNbr(byId[b.comp.id].nbrs, { id: a.comp.id, net: tr.net || '', pinSelf: b.pinIndex, pinOther: a.pinIndex });
        });
        // Stored netlist members join the graph too: a declared net pulls its
        // components together even when no copper/wire geometry exists yet.
        const nl = netlist || null;
        if (nl) {
            const compIds = new Set(components.map(c => c.id));
            for (const netName of Object.keys(nl)) {
                const members = (nl[netName] || []).filter(r => compIds.has(r.compId));
                for (const m of members) netsOf[m.compId].add(netName);
                for (let i = 0; i < members.length; i++) {
                    for (let j = i + 1; j < members.length; j++) {
                        const a = members[i], b = members[j];
                        if (a.compId === b.compId) continue;
                        this._addNbr(byId[a.compId].nbrs, { id: b.compId, net: netName, pinSelf: 0, pinOther: 0 });
                        this._addNbr(byId[b.compId].nbrs, { id: a.compId, net: netName, pinSelf: 0, pinOther: 0 });
                    }
                }
            }
        }
        return { byId, netsOf };
    },

    _isRailNet(net) {
        const n = String(net || '').toUpperCase();
        return n === 'VCC' || n === 'GND' || n === '+' || n === '-' || n === '3V3' || n === '5V' || n === 'VIN';
    },

    _addNbr(list, edge) {
        const prev = list.find(e => e.id === edge.id);
        if (!prev) { list.push(edge); return; }
        if (this._isRailNet(prev.net) && !this._isRailNet(edge.net)) {
            prev.net = edge.net;
            prev.pinSelf = edge.pinSelf;
            prev.pinOther = edge.pinOther;
        }
    },

    _isHubType(type) {
        return type === 'ic' || type === 'ldo' || type === 'transistor' || type === 'pnp' || type === 'mosfet'
            || type === 'arduino_uno' || type === 'arduino_nano' || type === 'esp32_devkit'
            || type === 'esp32s3_devkit' || type === 'esp32s2_mini' || type === 'esp32s3_nano'
            || type === 'esp8266_nodemcu' || type === 'rpi_pico';
    },

    _pickHub(components) {
        let best = null, n = -1;
        for (let i = 0; i < components.length; i++) {
            const c = components[i];
            const pn = (c.pins && c.pins.length) || 0;
            if (this._isHubType(c.type) && pn > n) { n = pn; best = c; }
        }
        return best || components[0];
    },

    _pinSide(comp, pinIndex) {
        const pins = comp.pins || [];
        const n = pins.length;
        if (this._isHubType(comp.type) && (comp.type === 'ic' || comp.type === 'ldo')) {
            return pinIndex < Math.ceil(n / 2) ? 'left' : 'right';
        }
        const xs = pins.map(p => p.x);
        const mid = xs.length ? (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 : 0;
        const pin = pins[pinIndex];
        if (!pin) return 'right';
        return pin.x <= mid ? 'left' : 'right';
    },

    _pinRowY(comp, pinIndex, hubY) {
        const pins = comp.pins || [];
        const n = pins.length;
        if (!n) return hubY;
        if (comp.type === 'ic' || comp.type === 'ldo') {
            const leftCount = Math.ceil(n / 2);
            const onLeft = pinIndex < leftCount;
            const count = onLeft ? leftCount : n - leftCount;
            const j = onLeft ? pinIndex : pinIndex - leftCount;
            return hubY + (j - (count - 1) / 2) * this.RING_Y;
        }
        return hubY;
    },

    _roleRank(comp) {
        if (comp.type === 'connector') return 0;
        if (comp.type === 'power') return 1;
        if (comp.type === 'gnd') return 4;
        return 2;
    },

    _freeSlot(ox, oy, taken, prefer) {
        const tryAt = (x, y) => {
            const sx = this._snap(x), sy = this._snap(y);
            const k = this._key(sx, sy);
            if (taken.has(k)) return null;
            taken.add(k);
            return { x: sx, y: sy };
        };
        const hit = tryAt(ox, oy);
        if (hit) return hit;
        const dirs = prefer === 'left'
            ? [[-1, 0], [-1, -1], [-1, 1], [0, -1], [0, 1], [1, 0], [1, -1], [1, 1]]
            : prefer === 'up'
                ? [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1]]
                : prefer === 'down'
                    ? [[0, 1], [-1, 1], [1, 1], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1]]
                    : [[1, 0], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [-1, -1], [-1, 1]];
        for (let r = 1; r <= 18; r++) {
            for (let d = 0; d < dirs.length; d++) {
                const found = tryAt(ox + dirs[d][0] * r * this.RING_X, oy + dirs[d][1] * r * this.RING_Y);
                if (found) return found;
            }
        }
        const fallback = tryAt(ox + this.RING_X * 20, oy);
        return fallback || { x: this._snap(ox), y: this._snap(oy) };
    },

    _assign(comp, x, y, taken) {
        const slot = this._freeSlot(x, y, taken, x < 0 ? 'left' : 'right');
        comp.schemX = slot.x;
        comp.schemY = slot.y;
    },

    _placedBBox(components) {
        let minX = 0, minY = 0, maxX = 0, maxY = 0, n = 0;
        components.forEach(c => {
            if (typeof c.schemX !== 'number' || typeof c.schemY !== 'number') return;
            if (!n) { minX = maxX = c.schemX; minY = maxY = c.schemY; n = 1; return; }
            if (c.schemX < minX) minX = c.schemX;
            if (c.schemX > maxX) maxX = c.schemX;
            if (c.schemY < minY) minY = c.schemY;
            if (c.schemY > maxY) maxY = c.schemY;
            n++;
        });
        return { minX, minY, maxX, maxY, n };
    },

    _assignIsolated(comp, components, taken) {
        const hub = this._pickHub(components);
        const hx = typeof hub.schemX === 'number' ? hub.schemX : 0;
        const hy = typeof hub.schemY === 'number' ? hub.schemY : 0;
        if (comp.type === 'connector' || comp.type === 'power') {
            this._assign(comp, hx - 3 * this.RING_X, hy + (comp.type === 'power' ? -this.RING_Y : 0), taken);
            return;
        }
        if (comp.type === 'gnd') {
            this._assign(comp, hx, hy + 2 * this.RING_Y, taken);
            return;
        }
        const bb = this._placedBBox(components);
        this._assign(comp, bb.maxX + this.RING_X + 40, (bb.minY + bb.maxY) / 2, taken);
    },

    _placeFresh(components, graph, taken) {
        const hub = this._pickHub(components);
        hub.schemX = 0;
        hub.schemY = 0;
        taken.add(this._key(0, 0));
        const q = [hub];
        const seen = new Set([hub.id]);
        while (q.length) {
            const cur = q.shift();
            const node = graph.byId[cur.id];
            if (!node) continue;
            const nbrs = node.nbrs.slice().sort((a, b) => {
                const ca = graph.byId[a.id].comp, cb = graph.byId[b.id].comp;
                const r = this._roleRank(ca) - this._roleRank(cb);
                if (r) return r;
                return a.pinSelf - b.pinSelf;
            });
            for (let i = 0; i < nbrs.length; i++) {
                const e = nbrs[i];
                if (seen.has(e.id)) continue;
                const nb = graph.byId[e.id].comp;
                if (typeof nb.schemX === 'number' && typeof nb.schemY === 'number') {
                    seen.add(e.id);
                    q.push(nb);
                    continue;
                }
                const xy = this._suggest(nb, cur, hub, e);
                this._assign(nb, xy.x, xy.y, taken);
                seen.add(e.id);
                q.push(nb);
            }
        }
    },

    _suggest(nb, cur, hub, edge) {
        const hx = hub.schemX || 0, hy = hub.schemY || 0;
        const cx = cur.schemX || 0, cy = cur.schemY || 0;
        if (nb.type === 'connector') return { x: hx - 3 * this.RING_X, y: hy };
        if (nb.type === 'power') return { x: hx, y: hy - 2 * this.RING_Y };
        if (nb.type === 'gnd') return { x: cx, y: cy + 2 * this.RING_Y };
        if (cur.id === hub.id) {
            const side = this._pinSide(hub, edge.pinSelf);
            const y = this._pinRowY(hub, edge.pinSelf, hy);
            const pins = hub.pins || [];
            const leftCount = Math.ceil(pins.length / 2);
            const j = side === 'left' ? edge.pinSelf : edge.pinSelf - leftCount;
            const xOff = (2 + (j % 2)) * this.RING_X;
            return { x: hx + (side === 'left' ? -xOff : xOff), y: y };
        }
        // Signal chain: spread horizontally away from the hub so the router gets clear
        // channels. Stacking a chain vertically (the old dominant-axis rule) packs the
        // glyphs into one column and forces wires to cut through bodies.
        const dx = cx - hx;
        return { x: cx + (dx >= 0 ? this.RING_X : -this.RING_X), y: cy };
    },

    _placeIncremental(components, missing, graph, taken) {
        const pending = missing.slice();
        let guard = 0;
        while (pending.length && guard++ < 80) {
            let idx = pending.findIndex(c => this._placedNetNeighbors(c, components, graph).length);
            if (idx < 0) idx = 0;
            const comp = pending.splice(idx, 1)[0];
            const nbrs = this._placedNetNeighbors(comp, components, graph);
            if (!nbrs.length) {
                this._assignIsolated(comp, components, taken);
                continue;
            }
            let sx = 0, sy = 0;
            nbrs.forEach(n => { sx += n.schemX; sy += n.schemY; });
            sx /= nbrs.length;
            sy /= nbrs.length;
            const prefer = comp.type === 'connector' || comp.type === 'power' ? 'left'
                : comp.type === 'gnd' ? 'down' : 'right';
            const slot = this._freeSlot(sx + (prefer === 'left' ? -this.RING_X : prefer === 'down' ? 0 : this.RING_X),
                sy + (prefer === 'down' ? this.RING_Y : prefer === 'left' && comp.type === 'power' ? -this.RING_Y : 0),
                taken, prefer);
            comp.schemX = slot.x;
            comp.schemY = slot.y;
        }
    },

    _placedNetNeighbors(comp, components, graph) {
        const nets = graph.netsOf[comp.id] || new Set();
        return components.filter(c => {
            if (c.id === comp.id) return false;
            if (typeof c.schemX !== 'number' || typeof c.schemY !== 'number') return false;
            const other = graph.netsOf[c.id] || new Set();
            for (const n of nets) if (other.has(n)) return true;
            return false;
        });
    },

    _channels(a, b, occupied, axis) {
        const mid = (a + b) / 2;
        const out = [mid];
        for (let k = 1; k <= 16; k++) out.push(mid - k * 40, mid + k * 40);
        (occupied || []).forEach(seg => {
            const horiz = Math.abs(seg.p.y - seg.q.y) < 0.5;
            const vert = Math.abs(seg.p.x - seg.q.x) < 0.5;
            if (axis === 'y' && horiz) {
                for (let k = 1; k <= 6; k++) out.push(seg.p.y - k * 20, seg.p.y + k * 20);
            }
            if (axis === 'x' && vert) {
                for (let k = 1; k <= 6; k++) out.push(seg.p.x - k * 20, seg.p.x + k * 20);
            }
        });
        return out;
    },

    _bboxDetours(aw, bw, obstacles) {
        let minX = Math.min(aw.x, bw.x), maxX = Math.max(aw.x, bw.x);
        let minY = Math.min(aw.y, bw.y), maxY = Math.max(aw.y, bw.y);
        (obstacles || []).forEach(o => {
            if (o.minX < minX) minX = o.minX;
            if (o.maxX > maxX) maxX = o.maxX;
            if (o.minY < minY) minY = o.minY;
            if (o.maxY > maxY) maxY = o.maxY;
        });
        const paths = [];
        [40, 80, 120, 200].forEach(pad => {
            paths.push([aw, { x: aw.x, y: minY - pad }, { x: bw.x, y: minY - pad }, bw]);
            paths.push([aw, { x: aw.x, y: maxY + pad }, { x: bw.x, y: maxY + pad }, bw]);
            paths.push([aw, { x: minX - pad, y: aw.y }, { x: minX - pad, y: bw.y }, bw]);
            paths.push([aw, { x: maxX + pad, y: aw.y }, { x: maxX + pad, y: bw.y }, bw]);
        });
        return paths;
    }
};
