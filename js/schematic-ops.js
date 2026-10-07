// ============================================================
// Schematic Interaction - pan/zoom/drag/wire + net logic
// ============================================================
Object.assign(App, {
    // --- Hit testing (screen coordinates) ---
    hitSchemPin(sx, sy) {
        const pins = this.interaction.schemPinPositions || [];
        let best = null, bd = Infinity;
        for (const p of pins) {
            const d = Math.hypot(p.sx - sx, p.sy - sy);
            if (d < bd) { bd = d; best = p; }
        }
        return bd <= 10 ? best : null;
    },

    hitSchemComp(sx, sy) {
        const w = this.schemScreenToWorld(sx, sy);
        let best = null, bd = Infinity;
        for (const comp of this.components) {
            const b = SchematicView.schemSymbolBounds(comp, 4);
            if (w.x < b.minX || w.x > b.maxX || w.y < b.minY || w.y > b.maxY) {
                // Also accept clicks on the unrotated label/value text just outside the glyph.
                const e = SchematicView._schemGlyphHalfExtents(comp);
                const cx = comp.schemX || 0, cy = comp.schemY || 0;
                const vw = Math.max(12, (comp.value || '').length * 6) / 2 + 3;
                const lw = Math.max(12, (comp.label || '').length * 7) / 2 + 3;
                const onValue = w.x > cx - vw && w.x < cx + vw && w.y > cy + e.hh - 2 && w.y < cy + e.hh + 18;
                const onLabel = w.x > cx - lw && w.x < cx + lw && w.y > cy - e.hh - 16 && w.y < cy - e.hh + 4;
                if (!onValue && !onLabel) continue;
            }
            const d = Math.hypot((comp.schemX || 0) - w.x, (comp.schemY || 0) - w.y);
            if (d < bd) { bd = d; best = comp; }
        }
        return best;
    },

    // Find the net of a trace touching a given pin's board position.
    getPinNet(comp, pinIndex) {
        const bp = this.pinBoardPos(comp, pinIndex);
        if (!bp) return null;
        for (const t of this.traces) {
            if (!t.points) continue;
            for (const p of t.points) {
                if (Math.hypot(p.x - bp.x, p.y - bp.y) < 1.0) return t.net;
            }
        }
        return null;
    },

    nextNetName() {
        let i = this.nets.length + 1;
        while (this.nets.some(n => n.name === 'NET_' + i)) i++;
        const colors = ['#ff8844', '#aa66ff', '#44dddd', '#ff66aa', '#99cc33'];
        const name = 'NET_' + i;
        this.nets.push({ name, color: colors[(i - 1) % colors.length] });
        if (this.updateNetsList) this.updateNetsList();
        return name;
    },

    // Create a real board trace between two schematic pins, optionally routed through
    // interior waypoints (schematic world). Host traces for T-joins get vertices inserted.
    createSchemWire(startPin, endPin, waypoints) {
        if (startPin.compId === endPin.compId && startPin.pinIndex === endPin.pinIndex) return;
        const ca = this.components.find(c => c.id === startPin.compId);
        if (!ca) return;
        const cb = (endPin.compId !== undefined) ? this.components.find(c => c.id === endPin.compId) : null;
        const endTrace = (endPin.compId === undefined && endPin.traceId !== undefined) ? this.traces.find(t => t.id === endPin.traceId) : null;
        if ((endPin.compId !== undefined && !cb) || (endPin.compId === undefined && !endTrace)) return;
        const pa = this.pinBoardPos(ca, startPin.pinIndex);
        // Board position of the end: pin anchor, or the end trace's nearest board point to the join.
        let pb = null;
        if (cb) {
            pb = this.pinBoardPos(cb, endPin.pinIndex);
        } else if (endTrace && endTrace.points && endTrace.points.length >= 1) {
            pb = endTrace.points[endTrace.points.length - 1];
        }
        if (!pa || !pb) return;

        // Guard: connecting two pins of the SAME part to a net it is already on is a
        // redundant short — both pins of one component share the same net internally.
        // Drawing it adds a stray jumper line between the pads, so no-op with a notice.
        if (startPin.compId === endPin.compId && endPin.compId !== undefined) {
            const na = this.getPinNet(ca, startPin.pinIndex);
            const nb = this.getPinNet(cb, endPin.pinIndex);
            if (na && na === nb) { this.setStatus('Already connected: both pins are on ' + na); return; }
        }

        const net = this._resolveSchemNet(startPin, endPin);
        if (!net) return;

        // Schematic-world polyline: pinA -> interior waypoints -> pinB.
        const wps = (waypoints || []).map(w => ({ x: w.x, y: w.y }));

        let pts;
        if (wps.length) {
            // Board-space polyline: pinA -> mapped interior waypoints -> pinB.
            const boardPts = [pa];
            for (const wp of wps) {
                let bp = this._schemWorldToBoard(wp);
                if (!bp) continue;
                const wh = this._nearestSchemWirePoint(wp.x, wp.y, 8);
                if (wh) {
                    // Share a vertex with the host wire so both traces stay electrically joined.
                    const jb = this._schemJoinBoardPoint(wh.trace, wh.segIndex, wp);
                    if (jb) bp = jb;
                }
                boardPts.push(bp);
            }
            boardPts.push(pb);
            // Drop consecutive near-duplicate points.
            pts = [];
            for (const p of boardPts) {
                const last = pts[pts.length - 1];
                if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.3) pts.push(p);
            }
        } else {
            // Plain pin-to-pin wire: route the board leg around component
            // bodies/pads and existing copper (A* on the routing grid, exact
            // clearance validation) so it cannot cut through a part or short a
            // neighbouring net. Falls back to the direct line when no valid
            // path exists. A trace-end continuation has no component pin at the far
            // end, so it is a straight run to the end point.
            let leg = null;
            if (cb && typeof Autoroute !== 'undefined') {
                leg = Autoroute.routeLeg(this, pa, pb, { net: net, layer: 'top', traceWidth: this.params.traceWidth, endpoints: [{ comp: ca, pinIndex: startPin.pinIndex }, { comp: cb, pinIndex: endPin.pinIndex }] });
            }
            pts = leg ? leg.points : [pa, pb];
        }
        if (pts.length < 2) return;

        const trace = { id: this.nextId(), points: pts, width: this.params.traceWidth, layer: 'top', net, schemWire: true };
        if (wps.length) trace.waypoints = wps;
        // Explicit end references: schematic rendering resolves wire ends by identity,
        // not by matching board geometry against pads. A trace-end end is recorded as a
        // join point so its free end stays grabbable.
        if (cb) {
            trace.schemEnds = [
                { compId: startPin.compId, pinIndex: startPin.pinIndex },
                { compId: cb.id, pinIndex: endPin.pinIndex }
            ];
        } else {
            trace.schemEnds = [{ compId: startPin.compId, pinIndex: startPin.pinIndex }, null];
            trace.schemJoin = { x: endPin.joinX, y: endPin.joinY };
            trace.schemJoinTraceId = endPin.traceId;
        }
        this.traces.push(trace);
        this.interaction.selectedObject = { type: 'trace', obj: trace };
        if (this.showProperties) this.showProperties(trace, 0);
        this.saveState();
        this.render();
    },

    // Resolve the net for a new wire between two ends (pins or trace ends).
    // Returns null to cancel creation.
    _resolveSchemNet(startEnd, endEnd) {
        const netOfEnd = (end) => {
            if (end && end.compId !== undefined) {
                const c = this.components.find(cc => cc.id === end.compId);
                return c ? this.getPinNet(c, end.pinIndex) : null;
            }
            const tr = (end && end.traceId !== undefined) ? this.traces.find(t => t.id === end.traceId) : null;
            return tr ? (tr.net || null) : null;
        };
        const na = netOfEnd(startEnd);
        const nb = netOfEnd(endEnd);
        if (na && nb) {
            if (na === nb) return na;
            const choice = prompt('Net conflict:\nEnd A is on "' + na + '" and end B is on "' + nb + '".\nEnter the net name to merge them, or press Cancel:');
            if (!choice) return null;
            return choice;
        }
        if (na) return na;
        if (nb) return nb;
        return this.nextNetName();
    },

    _schemWireDrawPrev() {
        const interior = this.interaction.schemWireInterior || [];
        if (interior.length) return interior[interior.length - 1];
        const start = this.interaction.schemWireStart;
        if (!start) return null;
        const comp = this.components.find(c => c.id === start.compId);
        return comp ? SchematicView.schemPinWorld(comp, start.pinIndex) : null;
    },

    // Snap a schematic-world point while drawing a wire. Priority: pin / wire inside
    // snap radius (always — these are connection targets) > H/V/45 from last committed
    // point (unless routeAngle=free) > 5px grid. Grid/H-V/45 snapping is disabled when
    // the Snap toggle is off (points then follow the raw cursor).
    _snapSchemWirePoint(wx, wy) {
        for (const comp of this.components) {
            const n = this.getCompPins(comp).length;
            for (let i = 0; i < n; i++) {
                const wp = SchematicView.schemPinWorld(comp, i);
                if (Math.hypot(wp.x - wx, wp.y - wy) <= 8) return { x: wp.x, y: wp.y, kind: 'pin', compId: comp.id, pinIndex: i };
            }
        }
        const wh = this._nearestSchemWirePoint(wx, wy, 10);
        if (wh) return { x: wh.x, y: wh.y, kind: wh.kind || 'edge', trace: wh.trace, segIndex: wh.segIndex };
        if (this.params.schemSnap === false) return { x: wx, y: wy, kind: 'free' };
        const prev = this._schemWireDrawPrev();
        if (prev && this.params.routeAngle !== 'free') {
            const g = 5, pull = 8;
            const dx = wx - prev.x, dy = wy - prev.y;
            if (Math.abs(dy) <= pull) return { x: Math.round(wx / g) * g, y: prev.y, kind: 'h' };
            if (Math.abs(dx) <= pull) return { x: prev.x, y: Math.round(wy / g) * g, kind: 'v' };
            const adx = Math.abs(dx), ady = Math.abs(dy);
            if (Math.abs(adx - ady) <= pull) {
                const s = Math.round(((adx + ady) / 2) / g) * g;
                return { x: prev.x + (dx < 0 ? -s : s), y: prev.y + (dy < 0 ? -s : s), kind: 'diag' };
            }
        }
        return { x: Math.round(wx / 5) * 5, y: Math.round(wy / 5) * 5, kind: 'grid' };
    },

    // Snap a schematic placement position (component centre / ghost) to the 5-unit grid
    // when the Snap toggle is on. Off → raw cursor position.
    _snapSchemPos(x, y) {
        if (this.params.schemSnap === false) return { x, y };
        const g = 5;
        return { x: Math.round(x / g) * g, y: Math.round(y / g) * g };
    },

    // Nearest point on any existing schematic wire within tol (world). Prefers vertices.
    _nearestSchemWirePoint(wx, wy, tol = 8) {
        let best = null, bd = Infinity;
        for (const tr of this.traces) {
            const pts = this.getSchemWirePoints(tr);
            if (!pts || pts.length < 2) continue;
            for (const p of pts) {
                const d = Math.hypot(p.x - wx, p.y - wy);
                if (d <= tol && d < bd) { bd = d; best = { x: p.x, y: p.y, kind: 'vertex', trace: tr, segIndex: 0 }; }
            }
            for (let i = 0; i < pts.length - 1; i++) {
                const ax = pts[i].x, ay = pts[i].y, bx = pts[i + 1].x, by = pts[i + 1].y;
                const dx = bx - ax, dy = by - ay;
                const l2 = dx * dx + dy * dy;
                let t = l2 === 0 ? 0 : ((wx - ax) * dx + (wy - ay) * dy) / l2;
                t = Math.max(0, Math.min(1, t));
                const px = ax + t * dx, py = ay + t * dy;
                const d = Math.hypot(wx - px, wy - py);
                if (d <= tol && d < bd) { bd = d; best = { x: px, y: py, kind: 'edge', trace: tr, segIndex: i }; }
            }
        }
        return best;
    },

    // Map a schematic-world point to board space (nearest pin anchor).
    _schemWorldToBoard(wp) {
        for (const comp of this.components) {
            const n = this.getCompPins(comp).length;
            for (let i = 0; i < n; i++) {
                const pw = SchematicView.schemPinWorld(comp, i);
                if (Math.hypot(pw.x - wp.x, pw.y - wp.y) <= 1.5) {
                    const bp = this.pinBoardPos(comp, i);
                    if (bp) return bp;
                }
            }
        }
        const m = this.schemPinLookup()(wp);
        return m ? { x: m.bp.x, y: m.bp.y } : null;
    },

    // Find where a schematic-world point lands on the host trace's BOARD polyline and insert
    // a shared vertex there so both traces stay electrically joined. Returns the board point.
    _schemJoinBoardPoint(trace, segIndex, wp) {
        if (!trace || !trace.points || trace.points.length < 2) return null;
        const spts = this.getSchemWirePoints(trace);
        if (!spts || spts.length < 2) return null;
        let si = -1, st = 0, bd = Infinity;
        for (let i = 0; i < spts.length - 1; i++) {
            const ax = spts[i].x, ay = spts[i].y, bx = spts[i + 1].x, by = spts[i + 1].y;
            const dx = bx - ax, dy = by - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((wp.x - ax) * dx + (wp.y - ay) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(wp.x - (ax + t * dx), wp.y - (ay + t * dy));
            if (d < bd) { bd = d; si = i; st = t; }
        }
        if (si < 0 || bd > 25) return null;
        const bp = trace.points[si], bq = trace.points[si + 1];
        if (!bp || !bq) return null;
        const jx = bp.x + st * (bq.x - bp.x), jy = bp.y + st * (bq.y - bp.y);
        this._insertVertexInPlace(trace, si, jx, jy, true);
        return { x: jx, y: jy };
    },

    // Finish the in-progress schematic wire at a schematic-world point.
    finishSchemWireDraw(wx, wy, screenPin) {
        if (!this.interaction.schemWireStart) return;
        const start = this.interaction.schemWireStart;
        // 1) Finish on a pin (not the starting pin). Prefer the screen-space hit from the
        // click (zoom-independent); fall back to a world-radius search for clicks that just
        // miss it at high zoom.
        let pinHit = null;
        if (screenPin) {
            if (screenPin.compId === start.compId && screenPin.pinIndex === start.pinIndex) {
                this.cancelSchemWireDraw(); return; // clicked the starting pin again
            }
            pinHit = { compId: screenPin.compId, pinIndex: screenPin.pinIndex };
        } else {
            for (const comp of this.components) {
                const n = this.getCompPins(comp).length;
                for (let i = 0; i < n; i++) {
                    const wp = SchematicView.schemPinWorld(comp, i);
                    if (Math.hypot(wp.x - wx, wp.y - wy) <= 8) pinHit = { compId: comp.id, pinIndex: i };
                }
            }
            if (pinHit && pinHit.compId === start.compId && pinHit.pinIndex === start.pinIndex) {
                this.cancelSchemWireDraw(); return; // clicked the starting pin again
            }
        }
        if (pinHit) {
            this.createSchemWire(start, pinHit, this.interaction.schemWireInterior);
            this.cancelSchemWireDraw();
            return;
        }
        // 2) Finish on an existing wire (T-join). Use the re-hit's ON-WIRE point
        // (wh.x/y) — the exact position the preview ring showed — not the raw cursor
        // (wx/wy), which may be a few mm off the line at the moment of the click.
        const wh = this._nearestSchemWirePoint(wx, wy, 10);
        if (wh) {
            this.createSchemTJoin(start, wh, wh.x, wh.y);
            this.cancelSchemWireDraw();
            return;
        }
        // 3) Otherwise add the point as an interior waypoint (snapped).
        const snap = this._snapSchemWirePoint(wx, wy);
        this.interaction.schemWireInterior.push({ x: snap.x, y: snap.y });
        this.render();
    },

    cancelSchemWireDraw() {
        if (this.interaction.schemWireStart) this.setStatus('Wire drawing cancelled');
        this.interaction.schemWireStart = null;
        this.interaction.schemWireInterior = [];
        this.interaction.schemWireCursor = null;
        this.render();
    },

    // Commit the in-progress wire at its current snapped cursor position (Enter).
    // Pin → pin-to-pin wire, on a wire → T-join, free/grid point → a stub trace whose
    // end sits on that snapped point so the user can continue or connect it later.
    commitSchemWireDraw() {
        if (!this.interaction.schemWireStart) return;
        const start = this.interaction.schemWireStart;
        // Enter commits the wire up to the LAST CLICKED point; the live cursor only
        // extends it while nothing has been clicked yet (pure rubber-band stub).
        if (this.interaction.schemWireInterior && this.interaction.schemWireInterior.length) {
            const clicked = this.interaction.schemWireInterior.slice();
            this.interaction.schemWireCursor = clicked.pop();
            this.interaction.schemWireInterior = clicked;
        }
        const cursor = this.interaction.schemWireCursor;
        if (!cursor) { this.cancelSchemWireDraw(); return; }
        // Resolve the start board point + net from either a pin or a trace end.
        let startBoard = null, startNet = null, startEnd;
        if (start.compId !== undefined) {
            const ca = this.components.find(c => c.id === start.compId);
            if (!ca) { this.cancelSchemWireDraw(); return; }
            startBoard = this.pinBoardPos(ca, start.pinIndex);
            startNet = this.getPinNet(ca, start.pinIndex);
            startEnd = { compId: start.compId, pinIndex: start.pinIndex };
        } else {
            const st = this.traces.find(t => t.id === start.traceId);
            if (!st || !st.points || !st.points.length) { this.cancelSchemWireDraw(); return; }
            startBoard = st.points[st.points.length - 1];
            startNet = st.net || null;
            startEnd = { traceId: st.id, joinX: cursor.x, joinY: cursor.y }; // join resolved to cursor below
        }
        if (!startBoard) { this.cancelSchemWireDraw(); return; }

        if (cursor.kind === 'pin') {
            const endEnd = { compId: cursor.compId, pinIndex: cursor.pinIndex };
            const net = this._resolveSchemNet(startEnd, endEnd);
            if (!net) { this.cancelSchemWireDraw(); return; }
            // For a trace-end start, attach the new leg to that trace's board end.
            this._appendLegToStart(start, startBoard, startNet, net, cursor, this.interaction.schemWireInterior || []);
            this.cancelSchemWireDraw();
            return;
        }
        if (cursor.kind === 'edge' || cursor.kind === 'vertex') {
            if (start.compId !== undefined) {
                this.createSchemTJoin(start, { x: cursor.x, y: cursor.y, kind: cursor.kind, trace: cursor.trace, segIndex: cursor.segIndex }, cursor.x, cursor.y);
            } else {
                // Trace-end → wire: splice onto the target wire at the on-wire point.
                this._appendLegToStart(start, startBoard, startNet, cursor.trace.net || startNet, cursor, this.interaction.schemWireInterior || []);
            }
            this.cancelSchemWireDraw();
            return;
        }
        // Free / grid / H / V / 45° endpoint: commit a stub ending on the snapped point.
        const interior = (this.interaction.schemWireInterior || []).slice();
        const pb = this._schemWorldToBoard({ x: cursor.x, y: cursor.y }) || { x: startBoard.x, y: startBoard.y };
        const net = startNet || this.nextNetName();
        // Board polyline mirrors the schematic shape (mapped interior waypoints) so the
        // board and schematic views never disagree on the committed leg.
        const boardPts = [{ x: startBoard.x, y: startBoard.y }];
        for (const wp of interior) {
            const mb = this._schemWorldToBoard(wp);
            if (mb) boardPts.push(mb);
        }
        boardPts.push({ x: pb.x, y: pb.y });
        const endEnd = { compId: startEnd.compId, pinIndex: startEnd.pinIndex };
        const stub = (start.compId !== undefined)
            ? { schemEnds: [startEnd, null] }
            : { schemEnds: [startEnd, null], schemJoinTraceId: start.traceId };
        const trace = {
            id: this.nextId(),
            points: boardPts,
            width: this.params.traceWidth, layer: 'top', net,
            schemWire: true,
            schemJoin: { x: cursor.x, y: cursor.y },
            schemEnds: stub.schemEnds
        };
        if (stub.schemJoinTraceId !== undefined) trace.schemJoinTraceId = stub.schemJoinTraceId;
        if (interior.length) trace.waypoints = interior;
        this.traces.push(trace);
        this.interaction.selectedObject = { type: 'trace', obj: trace };
        this.setStatus('Wire committed');
        this.saveState();
        this.cancelSchemWireDraw();
    },

    // Append a new leg from a (pin or trace) start to a resolved cursor end, reusing the
    // start trace's net. For a trace-end start the new leg becomes its own trace linked
    // back via schemJoinTraceId so both ends stay grabbable.
    _appendLegToStart(start, startBoard, startNet, net, cursor, interior) {
        const pb = (cursor.kind === 'pin')
            ? (() => { const c = this.components.find(cc => cc.id === cursor.compId); return c ? this.pinBoardPos(c, cursor.pinIndex) : startBoard; })()
            : (this._schemWorldToBoard({ x: cursor.x, y: cursor.y }) || startBoard);
        const endEnd = (cursor.kind === 'pin') ? { compId: cursor.compId, pinIndex: cursor.pinIndex } : null;
        const boardPts = [{ x: startBoard.x, y: startBoard.y }];
        for (const wp of interior) { const mb = this._schemWorldToBoard(wp); if (mb) boardPts.push(mb); }
        boardPts.push({ x: pb.x, y: pb.y });
        const trace = {
            id: this.nextId(), points: boardPts, width: this.params.traceWidth, layer: 'top', net, schemWire: true,
            schemJoin: { x: cursor.x, y: cursor.y },
            schemEnds: (start.compId !== undefined)
                ? [{ compId: start.compId, pinIndex: start.pinIndex }, endEnd]
                : [{ traceId: start.traceId, joinX: startBoard.x, joinY: startBoard.y }, endEnd]
        };
        if (start.compId === undefined) trace.schemJoinTraceId = start.traceId;
        if (interior.length) trace.waypoints = interior;
        this.traces.push(trace);
        this.interaction.selectedObject = { type: 'trace', obj: trace };
        this.setStatus('Wire committed');
        this.saveState();
    },

    // Finish a schematic wire on another wire's edge (T-join): net merge + copper join + visible joint.
    createSchemTJoin(start, wireHit, wx, wy) {
        const ca = this.components.find(c => c.id === start.compId);
        if (!ca || !wireHit || !wireHit.trace) return;
        const pa = this.pinBoardPos(ca, start.pinIndex);
        const target = wireHit.trace;
        if (!pa || !target.points || target.points.length < 2) return;
        let net = target.net || this.getPinNet(ca, start.pinIndex) || this.nextNetName();
        const pinNet = this.getPinNet(ca, start.pinIndex);
        if (pinNet && target.net && pinNet !== target.net) {
            const choice = prompt('Net conflict:\nPin is on "' + pinNet + '" and wire is on "' + target.net + '".\nEnter the net name to merge them, or press Cancel:');
            if (!choice) return;
            net = choice;
            target.net = net;
        } else if (pinNet && !target.net) target.net = pinNet;
        else if (!pinNet) target.net = net;

        this.ensureSchemWaypoints(target);
        const tpts = this.getSchemWirePoints(target);
        let seg = wireHit.segIndex;
        if (tpts && tpts.length >= 2) {
            // Vertex hits report segIndex 0 — if the point isn't on that segment, find the right one.
            const nearEnd = (Math.hypot(tpts[seg].x - wx, tpts[seg].y - wy) < 2 ||
                             Math.hypot(tpts[seg + 1].x - wx, tpts[seg + 1].y - wy) < 2);
            if (!nearEnd) {
                let bd = Infinity;
                for (let si = 0; si < tpts.length - 1; si++) {
                    const d = Math.hypot(tpts[si].x - wx, tpts[si].y - wy);
                    if (d < bd) { bd = d; seg = si; }
                }
            }
            const proj = { x: Math.round(wx / 5) * 5, y: Math.round(wy / 5) * 5 };
            target.waypoints = target.waypoints || [];
            const already = target.waypoints.some(w => Math.hypot(w.x - proj.x, w.y - proj.y) < 4);
            if (!already) {
                const wpIdx = Math.max(0, Math.min(seg, target.waypoints.length));
                target.waypoints.splice(wpIdx, 0, proj);
            }
        }

        let joinBoard = { x: pa.x, y: pa.y }, bestD = Infinity, joinSeg = 0;
        for (let si = 0; si < target.points.length - 1; si++) {
            const a = target.points[si], b = target.points[si + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((pa.x - a.x) * dx + (pa.y - a.y) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + t * dx, py = a.y + t * dy;
            const d = Math.hypot(pa.x - px, pa.y - py);
            if (d < bestD) { bestD = d; joinBoard = { x: px, y: py }; joinSeg = si; }
        }
        this._insertVertexInPlace(target, joinSeg, joinBoard.x, joinBoard.y, true);
        const stub = {
            id: this.nextId(),
            points: [{ x: pa.x, y: pa.y }, { x: joinBoard.x, y: joinBoard.y }],
            width: this.params.traceWidth, layer: target.layer || 'top', net,
            schemWire: true, schemJoin: { x: wx, y: wy },
            schemEnds: [{ compId: start.compId, pinIndex: start.pinIndex }, null] // other end is the join point
        };
        const interior = (this.interaction.schemWireInterior || []).map(w => ({ x: w.x, y: w.y }));
        if (interior.length) stub.waypoints = interior;
        this.traces.push(stub);
        this.ensureCopperJunctionVertices(stub);
        this.interaction.selectedObject = { type: 'trace', obj: stub };
        this.setStatus('Joined wire');
        this.saveState();
        this.render();
    },

    // Build a board-position -> (comp, pinIndex) matcher for schematic pins.
    schemPinLookup() {
        const pinByPos = [];
        this.components.forEach((comp) => {
            const pins = this.getCompPins(comp);
            pins.forEach((p, i) => {
                const bp = this.pinBoardPos(comp, i);
                if (bp) pinByPos.push({ bp, comp, pinIndex: i });
            });
        });
        return (pt) => {
            let best = null, bd = Infinity;
            for (const e of pinByPos) { const d = Math.hypot(e.bp.x - pt.x, e.bp.y - pt.y); if (d < bd) { bd = d; best = e; } }
            return bd < 1.5 ? best : null;
        };
    },

    _schemWireCacheKey() {
        const c = (this.components || []).map(x => x.id + ':' + x.schemX + ',' + x.schemY + ',' + (typeof x.schemRotation === 'number' ? x.schemRotation : (x.rotation || 0)) + ':' + x.x + ',' + x.y).join('|');
        const t = (this.traces || []).map(tr => {
            const wp = tr.waypoints && tr.waypoints.length ? JSON.stringify(tr.waypoints) : '';
            const join = tr.schemJoin ? (tr.schemJoin.x + ',' + tr.schemJoin.y) : '';
            const pts = JSON.stringify(tr.points || []);
            return tr.id + ':' + (tr.net || '') + ':' + (tr.schemWire === false ? '0' : '1') + ':' + wp + ':' + join + ':' + pts;
        }).join('|');
        return c + '#' + t + '#' + (this.netlist ? JSON.stringify(this.netlist) : '');
    },

    _rebuildSchemWireCache() {
        const map = new Map();
        const matchPin = this.schemPinLookup();
        const occupiedByNet = [];
        // Pin pairs a real trace already draws. A netlist leg for the very same pair
        // would be a second wire between the same two pins: it has nowhere clean to go
        // (the copper owns the channel) and collapses to a diagonal across the sheet.
        const joinedPairs = new Set();
        const pairKey = (net, a, b) => {
            const k1 = a.comp.id + ':' + a.pinIndex, k2 = b.comp.id + ':' + b.pinIndex;
            return net + '|' + (k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1);
        };
        // Stored netlist: draw a spanning tree per net (n-1 legs), NOT every pin
        // pair. A hub net like GND with a dozen pins would otherwise spray dozens
        // of straight lines across every symbol on the sheet. Legs are virtual
        // (no trace object) keyed 'nl:<net>:<i>:<j>'.
        const nl = this.netlist || null;
        const nlLegs = [];
        if (nl) {
            for (const netName of Object.keys(nl)) {
                for (const leg of this._netlistTreeLegs(nl[netName])) {
                    nlLegs.push({ key: 'nl:' + netName + ':' + leg.i + ':' + leg.j, net: netName, a: leg.a, b: leg.b });
                }
            }
        }
        (this.traces || []).forEach(trace => {
            if (!trace || !trace.points || trace.points.length < 2) return;
            if (trace.schemWire === false) return;
            // Resolve an end by explicit pin reference (schemEnds) first; fall back to
            // positional board-geometry matching for legacy projects without schemEnds.
            const resolveEnd = (which) => {
                const ref = Array.isArray(trace.schemEnds) ? trace.schemEnds[which] : null;
                if (ref && typeof ref.compId === 'number' && typeof ref.pinIndex === 'number') {
                    const comp = this.components.find(c => c.id === ref.compId);
                    if (comp && ref.pinIndex >= 0 && ref.pinIndex < this.getCompPins(comp).length) {
                        return { comp, pinIndex: ref.pinIndex };
                    }
                }
                const bp = which === 0 ? trace.points[0] : trace.points[trace.points.length - 1];
                return matchPin(bp);
            };
            const a = resolveEnd(0);
            const b = resolveEnd(1);
            const join = trace.schemJoin;
            if (!a) return;
            if (!b && !join) return;
            if (b && a.comp.id === b.comp.id && a.pinIndex === b.pinIndex && !join) return;
            if (b) joinedPairs.add(pairKey(trace.net || '', a, b));
            const aw = SchematicView.schemPinWorld(a.comp, a.pinIndex);
            const bw = join ? { x: join.x, y: join.y } : SchematicView.schemPinWorld(b.comp, b.pinIndex);
            const wps = (trace.waypoints && trace.waypoints.length) ? trace.waypoints : null;
            let pts;
            if (wps) {
                pts = [{ x: aw.x, y: aw.y }, ...wps.map(w => ({ x: w.x, y: w.y })), { x: bw.x, y: bw.y }];
            } else {
                // Route the main path around EVERY symbol body, including the endpoints.
                // Each endpoint's own bounds are passed as aBound/bBound so the router's
                // outwardStub pushes the leg out of its glyph first; the only segments
                // allowed inside a body are the short pin stubs (aw→sa, sb→bw), which
                // legitimately connect the pin to the body edge. The long middle run
                // avoids all glyphs, so a net goes around a part instead of under it.
                // Same-net runs are ignored as occupancy so a multi-segment net can share
                // a channel.
                const obstacles = this.components.map(c => SchematicView.schemSymbolBounds(c));
                const myNet = trace.net || '';
                const occupied = occupiedByNet
                    .filter(s => !myNet || !s.net || s.net !== myNet)
                    .map(s => ({ p: s.p, q: s.q }));
                pts = SchematicView._schemRoute(aw, bw, obstacles, occupied, {
                    aBound: SchematicView.schemSymbolBounds(a.comp),
                    bBound: b ? SchematicView.schemSymbolBounds(b.comp) : null,
                    aLane: a.pinIndex,
                    bLane: b ? b.pinIndex : 0,
                });
            }
            map.set(trace.id, pts);
            const net = trace.net || '';
            for (let i = 0; i < pts.length - 1; i++) {
                occupiedByNet.push({ net, p: pts[i], q: pts[i + 1] });
            }
        });
        // Netlist legs route after real wires so they occupy leftover channels.
        const obstaclesAll = this.components.map(c => SchematicView.schemSymbolBounds(c));
        for (const leg of nlLegs) {
            if (joinedPairs.has(pairKey(leg.net, leg.a, leg.b))) continue;
            const aw = SchematicView.schemPinWorld(leg.a.comp, leg.a.pinIndex);
            const bw = SchematicView.schemPinWorld(leg.b.comp, leg.b.pinIndex);
            const occupied = occupiedByNet.filter(s => !leg.net || !s.net || s.net !== leg.net).map(s => ({ p: s.p, q: s.q }));
            const pts = SchematicView._schemRoute(aw, bw, obstaclesAll, occupied, {
                aBound: SchematicView.schemSymbolBounds(leg.a.comp),
                bBound: SchematicView.schemSymbolBounds(leg.b.comp),
                aLane: leg.a.pinIndex,
                bLane: leg.b.pinIndex
            });
            map.set(leg.key, pts);
            for (let i = 0; i < pts.length - 1; i++) occupiedByNet.push({ net: leg.net, p: pts[i], q: pts[i + 1] });
        }
        this._schemWireCache = { key: this._schemWireCacheKey(), map };
        return map;
    },

    // Virtual wire objects for stored-netlist legs (schematic rendering only —
    // they carry no copper and are not in app.traces). Mirrors _netlistTreeLegs
    // exactly so every id here has a matching polyline in the wire cache.
    _netlistSchemWires() {
        const nl = this.netlist;
        if (!nl) return [];
        const out = [];
        for (const netName of Object.keys(nl)) {
            for (const leg of this._netlistTreeLegs(nl[netName])) {
                out.push({ id: 'nl:' + netName + ':' + leg.i + ':' + leg.j, net: netName, points: [null, null], schemWire: true });
            }
        }
        return out;
    },

    // Resolve a net's declared pins and pick a spanning tree of legs: same-component
    // pins are tied by the symbol (free union, no leg); every remaining pin attaches
    // to the pin already in the tree that is nearest in schematic space (Prim over
    // Manhattan distance). Deterministic: same netlist + positions => same legs.
    _netlistTreeLegs(pins) {
        const refs = (pins || []).map(r => {
            const comp = this.components.find(c => c.id === r.compId);
            const pi = comp ? ProjectApi.pinIndex(this, r.compId, r.pin) : null;
            return (comp && pi !== null && pi !== undefined) ? { comp, pinIndex: pi } : null;
        }).filter(Boolean);
        if (refs.length < 2) return [];
        const parent = refs.map((_, i) => i);
        const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
        const pos = refs.map(r => SchematicView.schemPinWorld(r.comp, r.pinIndex));
        const dist = (i, j) => Math.abs(pos[i].x - pos[j].x) + Math.abs(pos[i].y - pos[j].y);
        for (let i = 0; i < refs.length; i++) {
            for (let j = i + 1; j < refs.length; j++) {
                if (refs[i].comp.id === refs[j].comp.id) union(i, j);
            }
        }
        const inTree = refs.map((_, i) => find(i) === find(0));
        const legs = [];
        let guard = refs.length;
        while (guard-- > 0 && inTree.some(v => !v)) {
            let best = null;
            for (let i = 0; i < refs.length; i++) {
                if (!inTree[i]) continue;
                for (let j = 0; j < refs.length; j++) {
                    if (inTree[j]) continue;
                    const d = dist(i, j);
                    if (!best || d < best.d) best = { i, j, d };
                }
            }
            if (!best) break;
            if (find(best.i) !== find(best.j)) legs.push({ i: best.i, j: best.j, a: refs[best.i], b: refs[best.j] });
            union(best.i, best.j);
            const c = find(best.i);
            for (let j = 0; j < refs.length; j++) if (find(j) === c) inTree[j] = true;
        }
        return legs;
    },

    // Full schematic-world polyline for a wire: [pinA, ...interior vertices, pinB].
    // Waypoints stay as drawn; otherwise sequential auto-route so later nets see occupied channels.
    getSchemWirePoints(trace) {
        if (!trace || !trace.points || trace.points.length < 2) return null;
        const key = this._schemWireCacheKey();
        if (!this._schemWireCache || this._schemWireCache.key !== key) this._rebuildSchemWireCache();
        const cached = this._schemWireCache.map.get(trace.id);
        if (cached) return cached;
        return null;
    },

    // Hit-test a schematic wire near a SCHEMATIC-world point (follows the drawn polyline).
    // Returns { trace, segIndex } so callers can segment-slide the grabbed run.
    hitSchemWire(wx, wy, tol = 6, exceptId) {
        const segDist = (ax, ay, bx, by) => {
            const dx = bx - ax, dy = by - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((wx - ax) * dx + (wy - ay) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(wx - (ax + t * dx), wy - (ay + t * dy));
        };
        let best = null, bestD = Infinity;
        for (const tr of this.traces) {
            if (exceptId && tr.id === exceptId) continue;
            const pts = this.getSchemWirePoints(tr);
            if (!pts || pts.length < 2) continue;
            for (let i = 0; i < pts.length - 1; i++) {
                const d = segDist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
                // Later traces draw on top, so when two wires overlap exactly the
                // visible (top) one wins — otherwise a same-net circle would grab, and
                // mangle, the wire underneath it.
                if (d < tol && d <= bestD + 1e-9) { bestD = d; best = { trace: tr, segIndex: i }; }
            }
        }
        return best;
    },

    // Hit-test the unattached (grabbable) end of a wire near a schematic-world point.
    hitSchemFreeEnd(wx, wy, tol = 9) {
        for (let i = this.traces.length - 1; i >= 0; i--) {
            const tr = this.traces[i];
            if (!tr.schemJoin) continue;
            const pts = this.getSchemWirePoints(tr);
            const idx = this.schemFreeEndIndex(tr, pts);
            if (idx < 0) continue;
            const p = pts[idx];
            if (Math.hypot(p.x - wx, p.y - wy) <= tol) return { trace: tr, index: idx, x: p.x, y: p.y };
        }
        return null;
    },

    // Drop a dragged free end onto a pin (or another wire) and make it stick.
    attachSchemFreeEnd(trace, snap) {
        if (!trace || !snap) return false;
        if (snap.kind === 'pin' && Array.isArray(trace.schemEnds)) {
            const startEnd = trace.schemEnds[0];
            const endEnd = { compId: snap.compId, pinIndex: snap.pinIndex };
            // Same-part same-net short is redundant — refuse like createSchemWire does.
            if (startEnd.compId === snap.compId) {
                const ca = this.components.find(c => c.id === startEnd.compId);
                const na = ca ? this.getPinNet(ca, startEnd.pinIndex) : null;
                const nb = ca ? this.getPinNet(ca, snap.pinIndex) : null;
                if (na && na === nb) { this.setStatus('Already connected: both pins are on ' + na); return false; }
            }
            const net = this._resolveSchemNet(startEnd, endEnd);
            if (!net) return false;
            this.ensureSchemWaypoints(trace);          // keep the drawn shape
            trace.net = net;
            trace.schemEnds = [startEnd, endEnd];
            delete trace.schemJoin;
            // Extend the board copper to the new pad: a mid-air stub has no real far
            // endpoint, so lay a straight leg between the two pin pads (matches how a
            // pin-to-pin wire's board leg is built).
            const ca = this.components.find(c => c.id === startEnd.compId);
            const cb = this.components.find(c => c.id === snap.compId);
            const pa = ca ? this.pinBoardPos(ca, startEnd.pinIndex) : null;
            const pb = cb ? this.pinBoardPos(cb, snap.pinIndex) : null;
            if (pa && pb) trace.points = [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }];
            this.ensureCopperJunctionVertices(trace);
            return true;
        }
        if (snap.kind === 'wire' && snap.trace) {
            // Share the net so the joint reads as one continuous line.
            if (snap.trace.net) trace.net = snap.trace.net;
            else if (trace.net) snap.trace.net = trace.net;
            return true;
        }
        return false;
    },

    // Snap a dragged free end: pins and other wires first, then the 5-unit grid.
    _snapSchemEndPos(wx, wy, ownId) {
        for (const comp of this.components) {
            const n = this.getCompPins(comp).length;
            for (let i = 0; i < n; i++) {
                const p = SchematicView.schemPinWorld(comp, i);
                if (Math.hypot(p.x - wx, p.y - wy) <= 8) return { x: p.x, y: p.y, kind: 'pin', compId: comp.id, pinIndex: i };
            }
        }
        for (const tr of this.traces) {
            if (tr.id === ownId) continue;
            const pts = this.getSchemWirePoints(tr);
            if (!pts) continue;
            for (const p of pts) if (Math.hypot(p.x - wx, p.y - wy) <= 8) return { x: p.x, y: p.y, kind: 'wire', trace: tr };
        }
        const g = this._snapSchemPos(wx, wy);
        return { x: g.x, y: g.y, kind: 'grid' };
    },

    // --- Wire path editing (waypoints stored in schematic world space) ---
    hitSchemWaypoint(wx, wy, tol = 8) {
        for (const tr of this.traces) {
            const pts = this.getSchemWirePoints(tr);
            if (!pts || pts.length < 3) continue;
            for (let i = 1; i < pts.length - 1; i++) {
                const w = pts[i];
                if (Math.hypot(w.x - wx, w.y - wy) <= tol) return { trace: tr, index: i - 1, needsWaypoints: !(tr.waypoints && tr.waypoints.length) };
            }
        }
        return null;
    },

    // Turn the default route into explicit waypoints so its vertices become editable.
    ensureSchemWaypoints(trace) {
        if (trace.waypoints && trace.waypoints.length) return;
        const pts = this.getSchemWirePoints(trace);
        if (!pts || pts.length < 2) return;
        if (pts.length === 2) {
            // Straight line: insert a midpoint so it becomes draggable.
            const mx = Math.round((pts[0].x + pts[1].x) / 2 / 5) * 5;
            const my = Math.round((pts[0].y + pts[1].y) / 2 / 5) * 5;
            trace.waypoints = [{ x: mx, y: my }];
        } else {
            trace.waypoints = pts.slice(1, -1).map(p => ({ x: p.x, y: p.y }));
        }
    },

    // Insert a waypoint at the clicked point on the nearest segment of the wire.
    insertSchemWaypoint(trace, wx, wy) {
        this.ensureSchemWaypoints(trace);
        const pts = this.getSchemWirePoints(trace);
        if (!pts || pts.length < 2) return;
        let bestSeg = 0, bestD = Infinity, proj = { x: wx, y: wy };
        for (let i = 0; i < pts.length - 1; i++) {
            const ax = pts[i].x, ay = pts[i].y, bx = pts[i + 1].x, by = pts[i + 1].y;
            const dx = bx - ax, dy = by - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((wx - ax) * dx + (wy - ay) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * dx, py = ay + t * dy;
            const d = Math.hypot(wx - px, wy - py);
            if (d < bestD) { bestD = d; bestSeg = i; proj = { x: px, y: py }; }
        }
        trace.waypoints.splice(bestSeg, 0, { x: Math.round(proj.x / 5) * 5, y: Math.round(proj.y / 5) * 5 });
        this.interaction.selectedObject = { type: 'trace', obj: trace };
        if (this.showProperties) this.showProperties(trace, 0);
        this.saveState();
        this.render();
    },

    // Reposition a waypoint (called live while dragging).
    moveSchemWaypoint(trace, index, wx, wy) {
        if (!trace.waypoints || !trace.waypoints[index]) return;
        trace.waypoints[index].x = Math.round(wx / 5) * 5;
        trace.waypoints[index].y = Math.round(wy / 5) * 5;
    },

    // Remove a waypoint; when none remain the wire reverts to its default L-shape.
    deleteSchemWaypoint(trace, index) {
        if (!trace.waypoints || !trace.waypoints.length) return;
        trace.waypoints.splice(index, 1);
        if (trace.waypoints.length === 0) delete trace.waypoints;
        this.saveState();
        this.render();
    },

    // --- Schematic segment-slide helpers (mirrors board trace-ops algorithm) ---

    // Get the full polyline for a schematic wire: [pinA, ...waypoints, pinB]
    getSchemPolyline(trace) {
        return this.getSchemWirePoints(trace);
    },

    // Write back interior points to trace.waypoints from a full polyline array.
    // Consecutive duplicates are dropped so a moved joint can never leave a
    // zero-length run behind (that renders as rubbish on the board).
    setSchemWaypointsFromPolyline(trace, poly) {
        const inner = [];
        for (let i = 1; i < poly.length - 1; i++) {
            const p = poly[i];
            const last = inner[inner.length - 1];
            if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) continue;
            inner.push({ x: p.x, y: p.y });
        }
        // A waypoint sitting exactly on the free join is redundant: the join itself is the vertex.
        const join = trace.schemJoin;
        const lastPt = poly[poly.length - 1];
        if (join && lastPt && inner.length &&
            Math.hypot(lastPt.x - join.x, lastPt.y - join.y) < 1e-6 &&
            Math.hypot(inner[inner.length - 1].x - join.x, inner[inner.length - 1].y - join.y) < 1e-6) {
            inner.pop();
        }
        if (inner.length === 0) delete trace.waypoints;
        else trace.waypoints = inner;
    },

    // Index of a wire's unattached (grabbable) end in its schematic polyline, or -1.
    // commitSchemWireDraw leaves schemEnds[1] === null with schemJoin as the free anchor,
    // which is the LAST point of the polyline.
    schemFreeEndIndex(trace, poly) {
        if (!trace || !trace.schemJoin || !Array.isArray(trace.schemEnds)) return -1;
        if (trace.schemEnds[1] !== null) return -1;
        return poly && poly.length >= 2 ? poly.length - 1 : -1;
    },

    // Determine drag axis for a schematic segment (mirrors board segmentDragAxis).
    schemSegAxis(p0, p1) {
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return 'free';
        const ang = Math.abs(Math.atan2(dy, dx));
        const deg = 8 * Math.PI / 180;
        if (ang < deg || ang > Math.PI - deg) return 'h';
        if (Math.abs(ang - Math.PI / 2) < deg) return 'v';
        return 'free';
    },

    // Prepare a schematic segment for dragging: materialize waypoints, insert jogs at pin ends.
    // Returns the (possibly adjusted) segment index in the full polyline.
    prepareSchemSegDrag(trace, segIndex) {
        this.ensureSchemWaypoints(trace);
        let poly = this.getSchemPolyline(trace);
        if (!poly || poly.length < 2) return -1;
        let i = segIndex;
        // If start of segment is a pin (index 0), insert a jog waypoint so pin stays fixed.
        if (i === 0) {
            const p = poly[0];
            trace.waypoints = trace.waypoints || [];
            trace.waypoints.unshift({ x: p.x, y: p.y });
            i += 1;
            poly = this.getSchemPolyline(trace);
        }
        // If the end of the segment is a fixed pin, insert a jog so the pin stays put.
        // An unattached end (schemJoin) is grabbable itself, so it must NOT get a jog —
        // otherwise dragging it only moves the jog and leaves a doubled kink.
        if (i + 1 >= poly.length - 1 && this.schemFreeEndIndex(trace, poly) !== poly.length - 1) {
            const p = poly[poly.length - 1];
            trace.waypoints = trace.waypoints || [];
            trace.waypoints.push({ x: p.x, y: p.y });
            poly = this.getSchemPolyline(trace);
        }
        return i;
    },

    // Apply a constrained segment drag to a schematic wire's polyline.
    applySchemSegDrag(trace, segIndex, axis, origP0, origP1, dx, dy) {
        const poly = this.getSchemPolyline(trace);
        if (!poly) return;
        const p0 = poly[segIndex];
        const p1 = poly[segIndex + 1];
        if (!p0 || !p1) return;
        if (axis === 'h') {
            const ny = Math.round((origP0.y + dy) / 5) * 5;
            p0.x = origP0.x; p1.x = origP1.x;
            p0.y = ny; p1.y = ny;
        } else if (axis === 'v') {
            const nx = Math.round((origP0.x + dx) / 5) * 5;
            p0.y = origP0.y; p1.y = origP1.y;
            p0.x = nx; p1.x = nx;
        } else {
            const nx = Math.round((origP0.x + dx) / 5) * 5;
            const ny = Math.round((origP0.y + dy) / 5) * 5;
            const ox = nx - origP0.x, oy = ny - origP0.y;
            p0.x = origP0.x + ox; p0.y = origP0.y + oy;
            p1.x = origP1.x + ox; p1.y = origP1.y + oy;
        }
        // An unattached end has no waypoint of its own: its position lives in schemJoin,
        // so carry the moved last point back into it.
        const freeIdx = this.schemFreeEndIndex(trace, poly);
        if (freeIdx >= 0 && poly[freeIdx]) trace.schemJoin = { x: poly[freeIdx].x, y: poly[freeIdx].y };
        this.setSchemWaypointsFromPolyline(trace, poly);
    },

    // Remove a schematic joint (waypoint) by trace ID and waypoint index.
    deleteSchemJoint(traceId, waypointIndex) {
        const trace = this.traces.find(t => t.id === traceId);
        if (!trace || !trace.waypoints) return;
        if (waypointIndex < 0 || waypointIndex >= trace.waypoints.length) return;
        trace.waypoints.splice(waypointIndex, 1);
        if (trace.waypoints.length === 0) delete trace.waypoints; // revert to auto-route
        this.interaction.schemSelectedJoint = null;
        this.setStatus('Joint removed');
        this.saveState();
        this.render();
    },

    // Rotate a schematic component +90° and move any wire endpoints sitting on its pads so traces stay connected.
    rotateSchemComp(comp) {
        const prePins = this.getCompPins(comp).map((_, i) => this.pinBoardPos(comp, i));
        comp.rotation = (comp.rotation || 0) + 90;
        if (comp.rotation >= 360) comp.rotation -= 360;
        const tol = 1.5;
        for (const tr of this.traces) {
            [0, tr.points.length - 1].forEach((idx) => {
                const pt = tr.points[idx];
                if (!pt) return;
                // Prefer the explicit pin reference: move the endpoint straight to the rotated pad.
                const ref = Array.isArray(tr.schemEnds) ? tr.schemEnds[idx] : null;
                if (ref && ref.compId === comp.id && typeof ref.pinIndex === 'number') {
                    const np = this.pinBoardPos(comp, ref.pinIndex);
                    if (np) { pt.x = np.x; pt.y = np.y; return; }
                }
                let bestI = -1, bd = Infinity;
                prePins.forEach((pp, i) => { if (pp) { const d = Math.hypot(pt.x - pp.x, pt.y - pp.y); if (d < bd) { bd = d; bestI = i; } } });
                if (bestI >= 0 && bd < tol) {
                    const np = this.pinBoardPos(comp, bestI);
                    if (np) { pt.x = np.x; pt.y = np.y; }
                }
            });
        }
        this.saveState();
        this.render();
    },

    // Commit a palette component at the clicked schematic position. The board footprint is
    // auto-placed in a free spot so copper exists without leaving the schematic view.
    placeSchemCompAt(sx, sy) {
        const type = this.interaction.placingComponent;
        const def = ComponentDefs.get(type);
        if (!def) return;
        const sizeIdx = (this.interaction.placingSize && this.interaction.placingSize[type] !== undefined) ? this.interaction.placingSize[type] : def.defaultSize;
        const size = ComponentDefs.getSize(def, sizeIdx);
        if (!size || !size.pins) { this.setStatus('Cannot place: missing footprint'); return; }
        const w = this.schemScreenToWorld(sx, sy);
        const sp = this._snapSchemPos(w.x, w.y);
        const value = (size.value !== undefined && size.value !== null) ? String(size.value)
            : ((def.defaultValue !== undefined && def.defaultValue !== null) ? String(def.defaultValue) : '');
        const spot = this.findFreeBoardSpot();
        const comp = { id: this.nextId(), type, x: spot.x, y: spot.y, rotation: 0, value, label: def.prefix + (this.components.filter(c => c.type === type).length + 1), size: sizeIdx, pins: size.pins.map(p => ({ ...p })), schemX: sp.x, schemY: sp.y };
        this.components.push(comp);
        this.ensureSchemPositions();
        this.ensureLabels();
        this.ensureCompSilkLayout(comp);
        this.interaction.placingComponent = null;
        this.interaction.placingJumperKind = null;
        this.interaction.schemPlacingPos = null;
        document.querySelectorAll('.comp-item').forEach(i => i.classList.remove('placing-active'));
        this.saveState();
        this.render();
    },

    // First free spot on the board (ring scan from center, >20mm from other component centers).
    findFreeBoardSpot() {
        const cx = this.board.width / 2, cy = this.board.height / 2;
        for (let r = 0; r < 150; r += 15) {
            for (let a = 0; a < 360; a += 30) {
                const x = cx + r * Math.cos(a * Math.PI / 180);
                const y = cy + r * Math.sin(a * Math.PI / 180);
                if (x < 5 || y < 5 || x > this.board.width - 5 || y > this.board.height - 5) continue;
                if (this.components.every(c => Math.hypot(c.x - x, c.y - y) > 20)) return { x, y };
            }
        }
        return { x: cx, y: cy };
    },

    bindSchemCanvasEvents() {
        const canvas = this.schematicCanvas;
        let panning = false, panStart = null;
        let draggingComp = null, dragOffset = null;
        let draggingWp = null;
        let draggingEnd = null;

        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

            // Pan: middle mouse or Alt+left.
            if (e.button === 1 || (e.button === 0 && e.altKey)) {
                e.preventDefault();
                panning = true;
                panStart = { sx, sy, px: this.view.schemPanX, py: this.view.schemPanY };
                canvas.style.cursor = 'grabbing';
                return;
            }
            if (e.button !== 0) return;

            // Placing component from palette (takes priority over tools, like the board canvas).
            if (this.interaction.placingComponent && this.view.mode === 'schematic') {
                this.placeSchemCompAt(sx, sy);
                return;
            }

            const wh = this.schemScreenToWorld(sx, sy);

            // Delete tool -> remove the component or wire under the cursor.
            if (this.view.tool === 'delete') {
                const comp = this.hitSchemComp(sx, sy);
                if (comp) {
                    this.interaction.selectedObject = { type: 'component', obj: comp };
                    this.deleteSelected();   // removes the component and any connected traces/wires
                    return;
                }
                const wire = this.hitSchemWire(wh.x, wh.y);
                if (wire) this.deleteObject({ type: 'trace', obj: wire.trace });
                return;
            }

            // Pin hit -> start / finish a wire.
            const pin = this.hitSchemPin(sx, sy);
            if (pin) {
                if (this.interaction.schemWireStart) {
                    this.finishSchemWireDraw(wh.x, wh.y, pin);
                } else {
                    this.interaction.schemWireStart = { compId: pin.compId, pinIndex: pin.pinIndex };
                    this.interaction.schemWireInterior = [];
                    // Seed the rubber-band cursor at the start pin so the anchor dot
                    // is visible immediately (before the first mousemove).
                    const startComp = this.components.find(c => c.id === pin.compId);
                    const sp = startComp ? SchematicView.schemPinWorld(startComp, pin.pinIndex) : null;
                    this.interaction.schemWireCursor = sp ? { x: sp.x, y: sp.y, kind: 'pin' } : null;
                    this.setStatus('Click a pin or wire to finish, click empty space to add points, right-click to cancel');
                }
                this.render();
                return;
            }

            // In-progress wire on empty space: T-join if on an existing wire, else interior point.
            if (this.interaction.schemWireStart) {
                this.finishSchemWireDraw(wh.x, wh.y);
                return;
            }

            // Free (unattached) wire end -> drag it freely in 2D, ahead of waypoint/segment hits.
            const endHit = this.hitSchemFreeEnd(wh.x, wh.y);
            if (endHit) {
                draggingEnd = { trace: endHit.trace };
                this.interaction.selectedObject = { type: 'trace', obj: endHit.trace };
                canvas.style.cursor = 'move';
                this.render();
                return;
            }

            // Waypoint hit -> select joint + drag it to reshape the wire path.
            const wp = this.hitSchemWaypoint(wh.x, wh.y);
            if (wp) {
                if (wp.needsWaypoints) this.ensureSchemWaypoints(wp.trace);
                draggingWp = { trace: wp.trace, index: wp.index };
                this.interaction.selectedObject = { type: 'trace', obj: wp.trace };
                this.interaction.schemSelectedJoint = { traceId: wp.trace.id, waypointIndex: wp.index };
                canvas.style.cursor = 'move';
                this.render();
                return;
            }

            // Wire hit before component so a run next to a symbol can be segment-slid.
            const wireHit = this.hitSchemWire(wh.x, wh.y);
            if (wireHit) {
                const tr = wireHit.trace;
                if (e.shiftKey) {
                    const idx = this.interaction.schemSelectedWires.findIndex(w => w.id === tr.id);
                    if (idx >= 0) this.interaction.schemSelectedWires.splice(idx, 1);
                    else this.interaction.schemSelectedWires.push(tr);
                } else {
                    this.interaction.schemSelectedWires = [tr];
                    this.interaction.schemSelectedJoint = null;
                    // Do not freeze waypoints until the pointer actually moves (CAP-3).
                    this.interaction.schemDraggingSeg = {
                        traceId: tr.id,
                        segIndex: wireHit.segIndex,
                        prepared: false,
                        startX: wh.x, startY: wh.y
                    };
                    canvas.style.cursor = 'move';
                }
                this.interaction.selectedObject = { type: 'trace', obj: tr };
                if (this.showProperties) this.showProperties(tr, 0);
                this.render();
                return;
            }

            // Component body hit -> drag to a new schematic position.
            const comp = this.hitSchemComp(sx, sy);
            if (comp) {
                draggingComp = comp;
                const w = this.schemScreenToWorld(sx, sy);
                dragOffset = { dx: comp.schemX - w.x, dy: comp.schemY - w.y };
                this.interaction.selectedObject = { type: 'component', obj: comp };
                if (this.showProperties) this.showProperties(comp);
                this.render();
                return;
            }

            // Empty space -> cancel an in-progress wire and clear selections.
            if (this.interaction.schemWireStart) this.cancelSchemWireDraw();
            if (this.interaction.schemSelectedWires.length) {
                this.interaction.schemSelectedWires = [];
            }
            if (this.interaction.schemSelectedJoint) {
                this.interaction.schemSelectedJoint = null;
            }
            this.interaction.selectedObject = null;
            this.render();
        });

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

            if (panning) {
                this.view.schemPanX = panStart.px - (sx - panStart.sx) / this.view.schemZoom;
                this.view.schemPanY = panStart.py - (sy - panStart.sy) / this.view.schemZoom;
                this.render();
                return;
            }
            if (draggingComp) {
                const w = this.schemScreenToWorld(sx, sy);
                const sn = this._snapSchemPos(w.x + dragOffset.dx, w.y + dragOffset.dy);
                draggingComp.schemX = sn.x;
                draggingComp.schemY = sn.y;
                this.render();
                return;
            }

            // Ghost preview while placing a component from the palette.
            if (this.interaction.placingComponent && this.view.mode === 'schematic') {
                const w = this.schemScreenToWorld(sx, sy);
                const sn = this._snapSchemPos(w.x, w.y);
                this.interaction.schemPlacingPos = { x: sn.x, y: sn.y };
                canvas.style.cursor = 'crosshair';
                this.render();
                return;
            }

            // Free-end drag: the unattached end follows the cursor in any direction.
            if (draggingEnd) {
                const w = this.schemScreenToWorld(sx, sy);
                const sn = this._snapSchemEndPos(w.x, w.y, draggingEnd.trace.id);
                draggingEnd.trace.schemJoin = { x: sn.x, y: sn.y };
                draggingEnd.snap = sn;
                this.render();
                return;
            }

            if (draggingWp) {
                const w = this.schemScreenToWorld(sx, sy);
                const hit = this.hitSchemWire(w.x, w.y, 10, draggingWp.trace.id);
                if (hit) {
                    const poly = this.getSchemPolyline(hit.trace);
                    const i = hit.segIndex;
                    if (poly && poly[i] && poly[i + 1]) {
                        const ax = poly[i].x, ay = poly[i].y, bx = poly[i + 1].x, by = poly[i + 1].y;
                        const dx = bx - ax, dy = by - ay;
                        const l2 = dx * dx + dy * dy;
                        let t = l2 === 0 ? 0 : ((w.x - ax) * dx + (w.y - ay) * dy) / l2;
                        t = Math.max(0, Math.min(1, t));
                        this.moveSchemWaypoint(draggingWp.trace, draggingWp.index, ax + t * dx, ay + t * dy);
                        draggingWp._join = { trace: hit.trace, x: ax + t * dx, y: ay + t * dy, segIndex: i };
                    }
                } else {
                    draggingWp._join = null;
                    this.moveSchemWaypoint(draggingWp.trace, draggingWp.index, w.x, w.y);
                }
                this.render();
                return;
            }

            // Segment-slide: freeze path on first real move, then slide the grabbed run.
            if (this.interaction.schemDraggingSeg) {
                const w = this.schemScreenToWorld(sx, sy);
                const d = this.interaction.schemDraggingSeg;
                const trace = this.traces.find(t => t.id === d.traceId);
                if (trace) {
                    const moved = Math.hypot(w.x - d.startX, w.y - d.startY);
                    if (!d.prepared && moved > 4) {
                        d.segIndex = this.prepareSchemSegDrag(trace, d.segIndex);
                        const poly = this.getSchemPolyline(trace);
                        if (d.segIndex >= 0 && poly && poly[d.segIndex] && poly[d.segIndex + 1]) {
                            d.origP0 = { x: poly[d.segIndex].x, y: poly[d.segIndex].y };
                            d.origP1 = { x: poly[d.segIndex + 1].x, y: poly[d.segIndex + 1].y };
                            d.axis = this.schemSegAxis(poly[d.segIndex], poly[d.segIndex + 1]);
                            d.prepared = true;
                            canvas.style.cursor = d.axis === 'h' ? 'ns-resize' : (d.axis === 'v' ? 'ew-resize' : 'move');
                        }
                    }
                    if (d.prepared) this.applySchemSegDrag(trace, d.segIndex, d.axis, d.origP0, d.origP1, w.x - d.startX, w.y - d.startY);
                }
                this.render();
                return;
            }

            // Update rubber-band cursor while drawing a wire (snapped).
            if (this.interaction.schemWireStart) {
                const w = this.schemScreenToWorld(sx, sy);
                const snap = this._snapSchemWirePoint(w.x, w.y);
                this.interaction.schemWireCursor = { x: snap.x, y: snap.y, kind: snap.kind, trace: snap.trace, segIndex: snap.segIndex };
                this.render();
                return;
            }

            // Hover feedback: highlight the pin under the cursor.
            const pin = this.hitSchemPin(sx, sy);
            const next = pin ? { compId: pin.compId, pinIndex: pin.pinIndex } : null;
            const prev = this.interaction.schemHoveredPin;
            const changed = (next === null) !== (prev === null) || (next && prev && (next.compId !== prev.compId || next.pinIndex !== prev.pinIndex));
            if (changed) {
                this.interaction.schemHoveredPin = next;
                this.render();
            }
            // Cursor: pin > component > segment axis > default.
            if (pin) canvas.style.cursor = 'crosshair';
            else if (this.hitSchemWaypoint(this.schemScreenToWorld(sx, sy).x, this.schemScreenToWorld(sx, sy).y)) canvas.style.cursor = 'move';
            else {
                const wh2 = this.schemScreenToWorld(sx, sy);
                const wireHover = this.hitSchemWire(wh2.x, wh2.y);
                if (wireHover) {
                    const poly = this.getSchemPolyline(wireHover.trace);
                    const i = wireHover.segIndex;
                    if (poly && poly[i] && poly[i + 1]) {
                        const axis = this.schemSegAxis(poly[i], poly[i + 1]);
                        canvas.style.cursor = axis === 'h' ? 'ns-resize' : (axis === 'v' ? 'ew-resize' : 'move');
                    } else canvas.style.cursor = 'pointer';
                } else canvas.style.cursor = this.hitSchemComp(sx, sy) ? 'move' : 'default';
                if (this.hitSchemFreeEnd(wh2.x, wh2.y)) canvas.style.cursor = 'move';
            }
        });

        window.addEventListener('mouseup', () => {
            if (panning) { panning = false; canvas.style.cursor = 'default'; }
            if (draggingComp) {
                this.saveState();
                draggingComp = null;
                dragOffset = null;
                this.render();
            }
            if (draggingEnd) {
                this.attachSchemFreeEnd(draggingEnd.trace, draggingEnd.snap);
                this.saveState();
                draggingEnd = null;
                canvas.style.cursor = 'default';
                this.render();
            }
            if (draggingWp) {
                if (draggingWp._join) {
                    const j = draggingWp._join;
                    this.ensureSchemWaypoints(j.trace);
                    const already = (j.trace.waypoints || []).some(p => Math.hypot(p.x - j.x, p.y - j.y) < 4);
                    if (!already) {
                        const idx = Math.max(0, Math.min(j.segIndex, (j.trace.waypoints || []).length));
                        j.trace.waypoints.splice(idx, 0, { x: j.x, y: j.y });
                    }
                    if (draggingWp.trace.net && j.trace.net && draggingWp.trace.net !== j.trace.net) {
                        j.trace.net = draggingWp.trace.net;
                    } else if (draggingWp.trace.net) j.trace.net = draggingWp.trace.net;
                    this.ensureCopperJunctionVertices(draggingWp.trace);
                }
                this.saveState();
                draggingWp = null;
                canvas.style.cursor = 'default';
                this.render();
            }
            if (this.interaction.schemDraggingSeg) {
                if (this.interaction.schemDraggingSeg.prepared) this.saveState();
                this.interaction.schemDraggingSeg = null;
                canvas.style.cursor = 'default';
                this.render();
            }
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
            const w = this.schemScreenToWorld(sx, sy);
            let delta = -e.deltaY;
            if (e.deltaMode === 1) delta *= 33;
            else if (e.deltaMode === 2) delta *= canvas.clientHeight;
            const factor = Math.pow(1.0015, delta);
            const nz = Math.min(Math.max(this.view.schemZoom * factor, 0.2), 5);
            const cx = canvas.width / 2, cy = canvas.height / 2;
            this.view.schemPanX = w.x - (sx - cx) / nz;
            this.view.schemPanY = w.y - (sy - cy) / nz;
            this.view.schemZoom = nz;
            this.updateStatusZoom();
            this.render();
        }, { passive: false });

        // Double-click a wire to add a bend; double-click a waypoint to remove it.
        canvas.addEventListener('dblclick', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
            if (this.hitSchemPin(sx, sy)) return;               // pins start/finish wires
            const comp = this.hitSchemComp(sx, sy);
            if (comp) {                                          // double-click a symbol to edit its value
                const v = prompt('Value for ' + (comp.label || comp.type) + ':', comp.value || '');
                if (v !== null) this.updateCompValue(comp.id, v);
                return;
            }
            const wh = this.schemScreenToWorld(sx, sy);
            const wp = this.hitSchemWaypoint(wh.x, wh.y);
            if (wp) {
                if (wp.needsWaypoints) this.ensureSchemWaypoints(wp.trace);
                this.deleteSchemWaypoint(wp.trace, wp.index);
                return;
            }
            const wire = this.hitSchemWire(wh.x, wh.y);
            if (wire) this.insertSchemWaypoint(wire.trace, wh.x, wh.y);
        });

        // Right-click cancels an in-progress schematic wire; otherwise opens the
        // context menu for a component under the cursor (e.g. LED resistor calc).
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this.interaction.schemWireStart) { this.cancelSchemWireDraw(); return; }
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
            const comp = this.hitSchemComp(sx, sy);
            if (comp) {
                this.interaction.contextTarget = { type: 'component', obj: comp };
                this.showContextMenu(sx, sy);
                return;
            }
            // A wire under the cursor is a delete target too (right-click = remove this net run).
            const wh = this.schemScreenToWorld(sx, sy);
            const wire = this.hitSchemWire(wh.x, wh.y);
            if (wire) {
                this.interaction.contextTarget = { type: 'trace', obj: wire.trace };
                this.interaction.selectedObject = { type: 'trace', obj: wire.trace };
                this.showContextMenu(sx, sy);
            } else {
                this.hideContextMenu();
            }
        });
    }
});
