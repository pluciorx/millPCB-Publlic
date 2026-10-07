// ============================================================
// Trace Operations (finish, width, pad constraints, vertex ops)
// ============================================================

Object.assign(App, {
    finishTrace() {
        const pts = this.interaction.tracePoints;
        if (pts.length >= 2) {
            const traceLayer = (this.view.activeLayer === 'bottom') ? 'bottom' : 'top';
            const curved = new Array(pts.length - 1).fill(false);
            const segW = new Array(pts.length - 1).fill(this.params.traceWidth);
            this.traces.push({ id: this.nextId(), points: [...pts], width: this.params.traceWidth, segmentWidths: segW, layer: traceLayer, net: 'SIG1', curved });
            const created = this.traces[this.traces.length - 1];
            this.ensureCopperJunctionVertices(created);
            this.inheritNetFromJoins(created);
            if (typeof Plan !== 'undefined' && Plan.wouldCross && Plan.wouldCross(this, created.points, created.net)) {
                this.traces.pop();
                this.setStatus('Trace not placed: it would short another net. Move a part or use a wire jumper.');
            } else {
                this.saveState();
            }
        }
        this.interaction.tracePoints = [];
        this.render();
    },

    getSegmentWidth(trace, segIndex) {
        if (trace.segmentWidths && trace.segmentWidths[segIndex] !== undefined) return trace.segmentWidths[segIndex];
        return trace.width;
    },

    getPadConstraint(trace, pointIndex) {
        const pt = trace.points[pointIndex];
        if (!pt) return null;
        const tol = 1.5;
        for (const comp of this.components) {
            if (this.isWireJumper && this.isWireJumper(comp)) continue;
            const size = this.getCompSize(comp);
            if (!size) continue;
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const cpins = (comp.pins && comp.pins.length) ? comp.pins : size.pins;
            for (let pi = 0; pi < cpins.length; pi++) {
                const pin = cpins[pi];
                const px = comp.x + pin.x * cos - pin.y * sin;
                const py = comp.y + pin.x * sin + pin.y * cos;
                if (Math.abs(pt.x - px) < tol && Math.abs(pt.y - py) < tol) {
                    return this.getPinPadLimits(comp, size, pi);
                }
            }
        }
        for (const via of this.vias) {
            const dx = pt.x - via.x, dy = pt.y - via.y;
            if (Math.sqrt(dx * dx + dy * dy) < tol) {
                return { minW: 0.3, maxW: via.diameter * 1.5, label: 'via' };
            }
        }
        return null;
    },

    getPinPadLimits(comp, size, pinIndex) {
        const isTH = BoardView.isTH(size);
        let minW, maxW, label;
        if (isTH) {
            const holeD = 0.8;
            const padOuter = size.width > 8 ? 2.0 : 1.5;
            minW = holeD;
            maxW = padOuter * 1.5;
            label = `TH pin ${size.pins[pinIndex].name}`;
        } else {
            const bodyH = size.height;
            const padW = Math.max(0.4, bodyH * 0.7);
            minW = Math.max(0.2, padW * 0.5);
            maxW = padW * 1.8;
            label = `${size.name} pin ${size.pins[pinIndex].name}`;
        }
        return { minW: Math.round(minW * 100) / 100, maxW: Math.round(maxW * 100) / 100, label };
    },

    setSegmentWidth(traceId, segIndex, newWidth) {
        const trace = this.traces.find(t => t.id === traceId);
        if (!trace) return;
        if (!trace.segmentWidths) trace.segmentWidths = new Array(trace.points.length - 1).fill(trace.width);
        let clamped = newWidth;
        const startConstraint = this.getPadConstraint(trace, segIndex);
        const endConstraint = this.getPadConstraint(trace, segIndex + 1);
        if (startConstraint) clamped = Math.max(clamped, startConstraint.minW);
        if (endConstraint) clamped = Math.max(clamped, endConstraint.minW);
        if (startConstraint && endConstraint) {
            clamped = Math.min(clamped, Math.min(startConstraint.maxW, endConstraint.maxW));
        } else if (startConstraint) {
            clamped = Math.min(clamped, startConstraint.maxW);
        } else if (endConstraint) {
            clamped = Math.min(clamped, endConstraint.maxW);
        }
        clamped = Math.max(0.1, Math.min(clamped, 10));
        trace.segmentWidths[segIndex] = clamped;
        this.saveState();
        this.showProperties(trace);
        this.render();
    },

    ensureSegmentWidths(trace) {
        if (!trace.segmentWidths) trace.segmentWidths = [];
        const expected = trace.points.length - 1;
        while (trace.segmentWidths.length < expected) trace.segmentWidths.push(trace.width);
        while (trace.segmentWidths.length > expected) trace.segmentWidths.pop();
    },

    insertVertexInSegment(traceId, segIndex, wx, wy) {
        const trace = this.traces.find(t => t.id === traceId);
        if (!trace || !this._insertVertexInPlace(trace, segIndex, wx, wy)) return;
        this.saveState();
        if (this.interaction.selectedObject && this.interaction.selectedObject.type === 'traceSegment' && this.interaction.selectedObject.traceId === trace.id) {
            this.interaction.selectedObject = { type: 'trace', obj: trace };
        }
        this.showProperties(trace);
        this.render();
    },

    _insertVertexInPlace(trace, segIndex, wx, wy, exact) {
        if (!trace || segIndex < 0 || segIndex >= trace.points.length - 1) return null;
        if (!trace.curved) trace.curved = [];
        while (trace.curved.length < trace.points.length - 1) trace.curved.push(false);
        const newPt = exact ? { x: wx, y: wy } : { x: this.snapToGrid(wx), y: this.snapToGrid(wy) };
        const a = trace.points[segIndex], b = trace.points[segIndex + 1];
        if (Math.hypot(newPt.x - a.x, newPt.y - a.y) < 0.15) return a;
        if (Math.hypot(newPt.x - b.x, newPt.y - b.y) < 0.15) return b;
        const oldW = (trace.segmentWidths && trace.segmentWidths[segIndex] != null) ? trace.segmentWidths[segIndex] : trace.width;
        trace.points.splice(segIndex + 1, 0, newPt);
        trace.curved.splice(segIndex + 1, 0, false);
        this.ensureSegmentWidths(trace);
        if (trace.segmentWidths) {
            trace.segmentWidths[segIndex] = oldW;
            if (segIndex + 1 < trace.segmentWidths.length) trace.segmentWidths[segIndex + 1] = oldW;
        }
        return newPt;
    },

    // Snap a point onto another trace's edge and insert a joint vertex there.
    joinPointOntoCopper(pt, exceptTrace) {
        if (!pt) return false;
        const layer = exceptTrace ? (exceptTrace.layer || 'top') : null;
        const snap = this.snapToCopper(pt.x, pt.y, { exceptId: exceptTrace && exceptTrace.id, layer, preferTrace: true });
        if (!snap || (snap.kind !== 'edge' && snap.kind !== 'vertex')) return false;
        pt.x = snap.x;
        pt.y = snap.y;
        if (snap.kind === 'edge' && snap.trace) {
            this._insertVertexInPlace(snap.trace, snap.segIndex, snap.x, snap.y, true);
        }
        return true;
    },

    // When a new trace T-joins another, insert a vertex on the existing run so a joint exists.
    ensureCopperJunctionVertices(newTrace) {
        if (!newTrace || !newTrace.points || newTrace.points.length < 2) return;
        const layer = newTrace.layer || 'top';
        const ends = [newTrace.points[0], newTrace.points[newTrace.points.length - 1]];
        for (const ep of ends) {
            for (const tr of this.traces) {
                if (tr === newTrace || !tr.points || tr.points.length < 2) continue;
                if ((tr.layer || 'top') !== layer) continue;
                const already = tr.points.some(p => Math.hypot(p.x - ep.x, p.y - ep.y) < 0.2);
                if (already) continue;
                const tol = Math.max(tr.width || 0.5, newTrace.width || 0.5, 0.5);
                for (let si = 0; si < tr.points.length - 1; si++) {
                    if (this.pointToSegDist(ep.x, ep.y, tr.points[si], tr.points[si + 1]) <= tol) {
                        this._insertVertexInPlace(tr, si, ep.x, ep.y, true);
                        break;
                    }
                }
            }
        }
    },

    inheritNetFromJoins(trace) {
        if (!trace || !trace.points) return;
        const ends = [trace.points[0], trace.points[trace.points.length - 1]];
        for (const ep of ends) {
            for (const tr of this.traces) {
                if (tr === trace || !tr.points || !tr.net) continue;
                if ((tr.layer || 'top') !== (trace.layer || 'top')) continue;
                if (tr.points.some(p => Math.hypot(p.x - ep.x, p.y - ep.y) < 0.25)) {
                    trace.net = tr.net;
                    return;
                }
            }
        }
    },

    pointOnCompPad(pt, tol = 1.5) {
        if (!pt) return false;
        for (const comp of this.components) {
            const size = this.getCompSize(comp);
            if (!size || !size.pins) continue;
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            for (const pin of ((comp.pins && comp.pins.length) ? comp.pins : size.pins)) {
                const x = comp.x + pin.x * cos - pin.y * sin;
                const y = comp.y + pin.x * sin + pin.y * cos;
                if (Math.hypot(pt.x - x, pt.y - y) < tol) return true;
            }
        }
        return false;
    },

    // Unique copper join dots: T-junctions and shared vertices, not pads.
    collectCopperJunctions() {
        const seen = new Set();
        const out = [];
        const push = (x, y) => {
            const k = x.toFixed(2) + ',' + y.toFixed(2);
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ x, y });
        };
        const traces = this.traces || [];
        for (let i = 0; i < traces.length; i++) {
            const a = traces[i];
            if (!a.points || a.points.length < 2) continue;
            if (a.schemWire) continue; // logical wire — no copper junction dots
            for (let j = i + 1; j < traces.length; j++) {
                const b = traces[j];
                if (!b.points || b.points.length < 2) continue;
                if (b.schemWire) continue; // logical wire — no copper junction dots
                if ((a.layer || 'top') !== (b.layer || 'top')) continue;
                const tol = Math.max(a.width || 0.5, b.width || 0.5, 0.35);
                const checkEndOn = (from, onto) => {
                    for (const ep of [from.points[0], from.points[from.points.length - 1]]) {
                        if (this.pointOnCompPad(ep, 0.45)) continue;
                        for (let si = 0; si < onto.points.length - 1; si++) {
                            if (this.pointToSegDist(ep.x, ep.y, onto.points[si], onto.points[si + 1]) <= tol) {
                                push(ep.x, ep.y);
                                break;
                            }
                        }
                    }
                };
                checkEndOn(a, b);
                checkEndOn(b, a);
                for (const p of a.points) {
                    if (this.pointOnCompPad(p, 0.45)) continue;
                    for (const q of b.points) {
                        if (Math.hypot(p.x - q.x, p.y - q.y) <= tol) push(p.x, p.y);
                    }
                }
            }
        }
        return out;
    },

    splitTraceAtVertex(traceId, pointIndex) {
        const idx = this.traces.findIndex(t => t.id === traceId);
        if (idx === -1) return;
        const trace = this.traces[idx];
        if (trace.points.length < 3) return;
        if (pointIndex <= 0 || pointIndex >= trace.points.length - 1) return;
        this.ensureSegmentWidths(trace);
        const newTrace = {
            id: this.nextId(),
            points: trace.points.slice(pointIndex),
            width: trace.width,
            segmentWidths: trace.segmentWidths.slice(pointIndex),
            layer: trace.layer,
            net: trace.net,
            curved: (trace.curved || []).slice(pointIndex)
        };
        trace.points = trace.points.slice(0, pointIndex + 1);
        if (trace.curved) trace.curved = trace.curved.slice(0, pointIndex);
        trace.segmentWidths = trace.segmentWidths.slice(0, pointIndex);
        this.traces.splice(idx + 1, 0, newTrace);
        this.saveState();
        this.showProperties(trace);
        this.render();
    },

    // Pure mutation: remove one vertex from a trace and re-stitch the two adjacent
    // segments into a single wider segment. Returns true if a vertex was removed.
    // Performs no save/render so callers can batch many removals under one undo step.
    _canRemoveVertex(trace, pointIndex) {
        if (!trace.points || trace.points.length <= 2) return false;
        if (pointIndex < 0 || pointIndex >= trace.points.length) return false;
        if (pointIndex === 0 || pointIndex === trace.points.length - 1) {
            const constraint = this.getPadConstraint(trace, pointIndex);
            if (constraint && constraint.label && !constraint.label.includes('via')) return false;
        }
        return true;
    },

    _removeVertexInPlace(trace, pointIndex) {
        if (!this._canRemoveVertex(trace, pointIndex)) return false;
        this.ensureSegmentWidths(trace);
        const wBefore = trace.segmentWidths[pointIndex - 1] || trace.width;
        const wAfter = trace.segmentWidths[pointIndex] || trace.width;
        const mergedW = Math.max(wBefore, wAfter);
        trace.points.splice(pointIndex, 1);
        if (trace.curved && trace.curved.length > 0) {
            // The removed vertex joined two segments; drop one of their curve flags so
            // curved[] stays in sync with the now-shorter segment list. Clamped so that
            // endpoint removals (first/last) also remove a valid flag.
            const ci = Math.max(0, Math.min(pointIndex - 1, trace.curved.length - 1));
            trace.curved.splice(ci, 1);
        }
        if (pointIndex === 0) {
            trace.segmentWidths.splice(0, 1);
            if (trace.segmentWidths.length > 0) trace.segmentWidths[0] = mergedW;
        } else {
            trace.segmentWidths.splice(pointIndex, 1);
            if (pointIndex - 1 >= 0 && pointIndex - 1 < trace.segmentWidths.length) {
                trace.segmentWidths[pointIndex - 1] = mergedW;
            }
        }
        this.ensureSegmentWidths(trace);
        return true;
    },

    deleteTraceVertex(traceId, pointIndex) {
        const trace = this.traces.find(t => t.id === traceId);
        if (!trace || !this._removeVertexInPlace(trace, pointIndex)) return;
        this.saveState();
        this.showProperties(trace);
        this.render();
    },

    // Which joint to drop to remove the selected run between points[segIndex] and points[segIndex+1].
    _segmentJointToRemove(trace, segIndex) {
        if (!trace.points || segIndex < 0 || segIndex >= trace.points.length - 1) return -1;
        const endIdx = segIndex + 1;
        const startIdx = segIndex;
        const endOk = this._canRemoveVertex(trace, endIdx);
        const startOk = this._canRemoveVertex(trace, startIdx);
        if (endOk && startOk) return endIdx;
        if (endOk) return endIdx;
        if (startOk) return startIdx;
        return -1;
    },

    // Remove the segment between two joints by deleting one corner (never the whole trace).
    deleteTraceSegment(traceId, segIndex) {
        const trace = this.traces.find(t => t.id === traceId);
        if (!trace) return;
        const idx = this._segmentJointToRemove(trace, segIndex);
        if (idx < 0) {
            this.setStatus('Cannot remove segment (joints on pads are protected)');
            return;
        }
        if (!this._removeVertexInPlace(trace, idx)) {
            this.setStatus('Cannot remove segment');
            return;
        }
        const newSeg = Math.min(segIndex, trace.points.length - 2);
        this.interaction.selectedSegment = trace.points.length > 1
            ? { traceId: trace.id, segIndex: Math.max(0, newSeg) }
            : null;
        this.interaction.selectedObject = { type: 'trace', obj: trace };
        this.setStatus('Segment removed');
        this.saveState();
        this.showProperties(trace, Math.max(0, newSeg));
        this.render();
    },

    _pinAtPoint(pt, tol) {
        if (!pt || typeof this.pinBoardPos !== 'function' || typeof this.getCompPins !== 'function') return null;
        const lim = tol || 1.5;
        for (const comp of this.components || []) {
            const pins = this.getCompPins(comp);
            for (let i = 0; i < pins.length; i++) {
                const wp = this.pinBoardPos(comp, i);
                if (wp && Math.hypot(pt.x - wp.x, pt.y - wp.y) < lim) return { compId: comp.id, pinIndex: i };
            }
        }
        return null;
    },

    _tracePinPair(trace) {
        if (!trace || !trace.points || trace.points.length < 2) return null;
        const ends = Array.isArray(trace.schemEnds) ? trace.schemEnds : null;
        const valid = e => e && typeof e.compId === 'number' && typeof e.pinIndex === 'number';
        const a = valid(ends && ends[0]) ? { compId: ends[0].compId, pinIndex: ends[0].pinIndex } : this._pinAtPoint(trace.points[0]);
        const b = valid(ends && ends[1]) ? { compId: ends[1].compId, pinIndex: ends[1].pinIndex } : this._pinAtPoint(trace.points[trace.points.length - 1]);
        if (!a || !b || (a.compId === b.compId && a.pinIndex === b.pinIndex)) return null;
        return [a, b];
    },

    _samePinPair(a, b, c, d) {
        return (a.compId === c.compId && a.pinIndex === c.pinIndex && b.compId === d.compId && b.pinIndex === d.pinIndex)
            || (a.compId === d.compId && a.pinIndex === d.pinIndex && b.compId === c.compId && b.pinIndex === c.pinIndex);
    },

    _hasLogicalSchemWire(pair, exceptId) {
        if (!pair) return false;
        for (const t of this.traces || []) {
            if (!t.schemWire || t.id === exceptId) continue;
            const p = this._tracePinPair(t);
            if (p && this._samePinPair(pair[0], pair[1], p[0], p[1])) return true;
        }
        return false;
    },

    // Keep the schematic net when board copper that joined two pins is removed.
    _ensureLogicalSchemWire(trace) {
        if (!trace || trace.schemWire) return false;
        const pair = this._tracePinPair(trace);
        if (!pair || this._hasLogicalSchemWire(pair, trace.id)) return false;
        const ca = (this.components || []).find(c => c.id === pair[0].compId);
        const cb = (this.components || []).find(c => c.id === pair[1].compId);
        const pa = ca && this.pinBoardPos(ca, pair[0].pinIndex);
        const pb = cb && this.pinBoardPos(cb, pair[1].pinIndex);
        if (!pa || !pb) return false;
        this.traces.push({
            id: this.nextId(),
            points: [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }],
            width: trace.width || 0.5,
            layer: 'top',
            net: trace.net,
            schemWire: true,
            schemEnds: [
                { compId: pair[0].compId, pinIndex: pair[0].pinIndex },
                { compId: pair[1].compId, pinIndex: pair[1].pinIndex }
            ]
        });
        return true;
    },

    _copperConnectsPins(pair) {
        if (!pair || typeof this.pinBoardPos !== 'function') return false;
        const ca = (this.components || []).find(c => c.id === pair[0].compId);
        const cb = (this.components || []).find(c => c.id === pair[1].compId);
        const pa = ca && this.pinBoardPos(ca, pair[0].pinIndex);
        const pb = cb && this.pinBoardPos(cb, pair[1].pinIndex);
        if (!pa || !pb) return false;
        const touches = (pt, pin) => pt && Math.hypot(pt.x - pin.x, pt.y - pin.y) < 1.5;
        for (const t of this.traces || []) {
            if (!t || t.schemWire || !t.points || t.points.length < 2) continue;
            const f = t.points[0], l = t.points[t.points.length - 1];
            if ((touches(f, pa) && touches(l, pb)) || (touches(f, pb) && touches(l, pa))) return true;
        }
        return false;
    },

    // Drop hover/drag/menu leftovers that still point at the pre-cut geometry.
    // Stale segIndex is what made the next paint throw and stack the canvas zoom.
    _clearTracePointerState() {
        const i = this.interaction;
        i.selectedSegment = null;
        i.hoveredSegment = null;
        i.hoveredTraceVertex = null;
        i.draggingSegment = null;
        i.draggingVertex = null;
        i.contextTarget = null;
        i.selectedVertices = [];
    },

    // Pure geometry: split one copper run. Never reads or writes components.
    // Returns 'split' | 'trim' | 'delete' | null (invalid).
    _cutTraceGeometry(traceId, segIndex) {
        const idx = this.traces.findIndex(t => t.id === traceId);
        if (idx < 0) return null;
        const trace = this.traces[idx];
        const pts = trace.points;
        if (!pts || segIndex < 0 || segIndex >= pts.length - 1) return null;

        this.ensureSegmentWidths(trace);
        const sw = (trace.segmentWidths || []).slice();
        const cv = (trace.curved || []).slice();
        const leftPts = pts.slice(0, segIndex + 1);
        const rightPts = pts.slice(segIndex + 1);

        const applyHalf = (target, halfPts, halfSw, halfCv) => {
            target.points = halfPts.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
            target.segmentWidths = halfSw.slice();
            if (target.curved || halfCv.length) target.curved = halfCv.slice();
            this.ensureSegmentWidths(target);
            if (target.curved) {
                while (target.curved.length < Math.max(0, target.points.length - 1)) target.curved.push(false);
                target.curved.length = Math.max(0, target.points.length - 1);
            }
            delete target.waypoints;
            delete target.schemJoin;
            delete target.schemEnds;
            target.schemWire = false;
        };

        if (leftPts.length >= 2 && rightPts.length >= 2) {
            const newTrace = {
                id: this.nextId(),
                width: trace.width,
                layer: trace.layer || 'top',
                net: trace.net,
                schemWire: false
            };
            applyHalf(newTrace, rightPts, sw.slice(segIndex + 1), cv.slice(segIndex + 1));
            applyHalf(trace, leftPts, sw.slice(0, segIndex), cv.slice(0, segIndex));
            this.traces.splice(idx + 1, 0, newTrace);
            return 'split';
        }
        if (leftPts.length >= 2) {
            applyHalf(trace, leftPts, sw.slice(0, segIndex), cv.slice(0, segIndex));
            return 'trim';
        }
        if (rightPts.length >= 2) {
            applyHalf(trace, rightPts, sw.slice(segIndex + 1), cv.slice(segIndex + 1));
            return 'trim';
        }
        this.traces.splice(idx, 1);
        return 'delete';
    },

    // Open a gap by removing one copper run. Schematic nets stay wired.
    cutTraceSegment(traceId, segIndex) {
        const idx = this.traces.findIndex(t => t.id === traceId);
        if (idx < 0) {
            this.setStatus('Select a trace segment to cut');
            return;
        }
        const trace = this.traces[idx];
        if (trace.schemWire) {
            this.setStatus('Schematic connection — delete it in schematic view');
            return;
        }
        const pair = this._tracePinPair(trace);
        const already = this._hasLogicalSchemWire(pair, trace.id);
        const kept = this._ensureLogicalSchemWire(trace);
        const result = this._cutTraceGeometry(traceId, segIndex);
        if (!result) {
            this.setStatus('Cannot cut that segment');
            return;
        }
        const leftover = this.traces.find(t => t.id === traceId) || null;
        this._clearTracePointerState();
        if (result === 'delete' || !leftover) {
            this.interaction.selectedObject = null;
            const props = document.getElementById('properties-content');
            if (props) props.innerHTML = '<p class="hint">Select an object to see its properties.</p>';
        } else {
            this.interaction.selectedObject = { type: 'trace', obj: leftover };
        }
        this.setStatus((kept || already)
            ? (result === 'delete' ? 'Copper removed — schematic connection kept' : 'Copper cut — schematic connection kept')
            : (result === 'delete'
                ? 'Segment cut — that run had no leftover copper'
                : 'Segment cut — gap left for a component'));
        this.saveState();
        if (this.interaction.selectedObject) this.showProperties(this.interaction.selectedObject.obj);
        this.render();
    },

    cutSelectedSegment(traceId, segIndex) {
        let id = traceId, si = segIndex;
        if (id == null || si == null) {
            const ctx = this.interaction.contextTarget;
            if (ctx && ctx.type === 'trace' && ctx.segIndex !== undefined && ctx.obj) {
                id = ctx.obj.id;
                si = ctx.segIndex;
            } else if (this.interaction.selectedSegment) {
                id = this.interaction.selectedSegment.traceId;
                si = this.interaction.selectedSegment.segIndex;
            }
        }
        if (id == null || si == null || this.traces.findIndex(t => t.id === id) < 0) {
            this.setStatus('Select a trace segment to cut');
            return;
        }
        this.cutTraceSegment(id, si);
    },

    // Remove every multi-selected joint in a single action (one undo step).
    // Indices are processed highest-first per trace so lower indices stay valid.
    deleteSelectedVertices() {
        const sel = this.interaction.selectedVertices;
        if (!sel || sel.length === 0) return;
        const byTrace = new Map();
        for (const v of sel) {
            if (!byTrace.has(v.traceId)) byTrace.set(v.traceId, new Set());
            byTrace.get(v.traceId).add(v.pointIndex);
        }
        let removed = 0;
        for (const [traceId, idxSet] of byTrace) {
            const trace = this.traces.find(t => t.id === traceId);
            if (!trace) continue;
            const idxs = [...idxSet].sort((a, b) => b - a); // descending
            for (const i of idxs) if (this._removeVertexInPlace(trace, i)) removed++;
        }
        this.interaction.selectedVertices = [];
        this.interaction.selectedObject = null;
        this.interaction.selectedSegment = null;
        document.getElementById('properties-content').innerHTML = '<p class="hint">Select an object to see its properties.</p>';
        this.setStatus(removed > 0 ? `Removed ${removed} joint${removed === 1 ? '' : 's'}` : 'Nothing removed (joints on pads are protected)');
        if (removed > 0) this.saveState();
        this.render();
    },

    toggleSegmentCurve(traceId, segIndex) {
        const trace = this.traces.find(t => t.id === traceId);
        if (!trace) return;
        if (!trace.curved) trace.curved = [];
        while (trace.curved.length < trace.points.length - 1) trace.curved.push(false);
        trace.curved[segIndex] = !trace.curved[segIndex];
        this.saveState();
        this.showProperties(trace);
        this.render();
    },

    updateTracesForComp(comp) {
        const def = ComponentDefs.get(comp.type);
        if (!def || !def.sizes) return;
        const size = ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
        if (!size) return;
        const cpins = (comp.pins && comp.pins.length) ? comp.pins : size.pins;
        const pinWorldPos = cpins.map(pin => {
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            return { x: comp.x + pin.x * cos - pin.y * sin, y: comp.y + pin.x * sin + pin.y * cos };
        });
        const tol = 1.5;
        for (const trace of this.traces) {
            for (const pt of trace.points) {
                for (let pi = 0; pi < pinWorldPos.length; pi++) {
                    const pp = pinWorldPos[pi];
                    if (Math.abs(pt.x - pp.x) < tol && Math.abs(pt.y - pp.y) < tol) {
                        break;
                    }
                }
            }
        }
    },

    moveCompWithTraces(comp, oldX, oldY) {
        const dx = comp.x - oldX, dy = comp.y - oldY;
        if (dx === 0 && dy === 0) return;
        const def = ComponentDefs.get(comp.type);
        if (!def || !def.sizes) return;
        const size = ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
        if (!size) return;
        // Wire jumper pins can sit mid-segment (edge-snap placement / trace anchoring).
        // Insert a vertex there first so the copper has a point to follow.
        if (comp.type === 'jumper' && size.jkind === 'wire') {
            const jpins = (comp.pins && comp.pins.length) ? comp.pins : size.pins;
            const rad = (comp.rotation || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
            for (const pin of jpins) {
                const px = oldX + pin.x * cos - pin.y * sin, py = oldY + pin.x * sin + pin.y * cos;
                for (const tr of this.traces) {
                    if (!tr.points || tr.points.length < 2) continue;
                    if ((tr.layer || 'top') !== (comp.layer || 'top')) continue;
                    if (tr.points.some(p => Math.hypot(p.x - px, p.y - py) < 0.15)) continue;
                    for (let si = 0; si < tr.points.length - 1; si++) {
                        if (this.pointToSegDist(px, py, tr.points[si], tr.points[si + 1]) <= 0.75) {
                            this._insertVertexInPlace(tr, si, px, py, true);
                            break;
                        }
                    }
                }
            }
        }
        const tol = 1.5;
        for (const trace of this.traces) {
            for (const pt of trace.points) {
                for (const pin of ((comp.pins && comp.pins.length) ? comp.pins : size.pins)) {
                    const rad = (comp.rotation || 0) * Math.PI / 180;
                    const cos = Math.cos(rad), sin = Math.sin(rad);
                    const oldPinX = oldX + pin.x * cos - pin.y * sin;
                    const oldPinY = oldY + pin.x * sin + pin.y * cos;
                    if (Math.abs(pt.x - oldPinX) < tol && Math.abs(pt.y - oldPinY) < tol) {
                        pt.x += dx; pt.y += dy;
                        break;
                    }
                }
            }
        }
    },

    _wireJumperHoleWorld(comp, size) {
        const pins = (comp.pins && comp.pins.length >= 2) ? comp.pins : size.pins;
        const rad = (comp.rotation || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        return pins.map(p => ({ x: comp.x + p.x * cos - p.y * sin, y: comp.y + p.x * sin + p.y * cos }));
    },

    _rebuildWireJumperPose(comp, h0, h1) {
        const mx = (h0.x + h1.x) / 2, my = (h0.y + h1.y) / 2;
        const span = Math.max(Math.hypot(h1.x - h0.x, h1.y - h0.y), 0.01);
        const rot = Math.atan2(h1.y - h0.y, h1.x - h0.x) * 180 / Math.PI;
        comp.x = mx; comp.y = my; comp.rotation = rot; comp.span = span;
        comp.pins = [{ x: -span / 2, y: 0, name: '1' }, { x: span / 2, y: 0, name: '2' }];
    },

    // Make every wire-jumper hole a copper vertex so it grabs like any other joint.
    ensureWireJumperJoints() {
        if (!this.traces) return;
        for (const tr of this.traces) this._promoteJumperHolesOnTrace(tr, 1.5);
    },

    // Insert a vertex where a wire-jumper hole sits on an edge (not already a vertex).
    // Returns the segment indices (at insert time) where a new vertex was added.
    _promoteJumperHolesOnTrace(trace, edgeTol = 1.5) {
        const inserted = [];
        if (!trace || !Array.isArray(trace.points) || trace.points.length < 2) return inserted;
        const def = ComponentDefs.get('jumper');
        if (!def || !def.sizes) return inserted;
        for (const comp of this.components) {
            if (comp.type !== 'jumper') continue;
            const size = ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
            if (!size || size.jkind !== 'wire') continue;
            const holes = this._wireJumperHoleWorld(comp, size);
            for (const h of holes) {
                if (trace.points.some(p => Math.hypot(p.x - h.x, p.y - h.y) <= edgeTol)) continue;
                for (let si = 0; si < trace.points.length - 1; si++) {
                    if (this.pointToSegDist(h.x, h.y, trace.points[si], trace.points[si + 1]) <= edgeTol) {
                        const n = trace.points.length;
                        this._insertVertexInPlace(trace, si, h.x, h.y, true);
                        if (trace.points.length > n) inserted.push(si);
                        break;
                    }
                }
            }
        }
        return inserted;
    },

    // Stick a wire-jumper hole that sat on `from` onto `to` (vertex/segment drag).
    glueWireJumpersAt(from, to, tol = 1.5) {
        if (!from || !to || !this.components) return;
        const def = ComponentDefs.get('jumper');
        if (!def || !def.sizes) return;
        for (const comp of this.components) {
            if (!this.isWireJumper(comp)) continue;
            const size = ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
            if (!size || size.jkind !== 'wire') continue;
            const holes = this._wireJumperHoleWorld(comp, size);
            if (holes.length < 2) continue;
            const next = holes.map(h => ({ x: h.x, y: h.y }));
            let changed = false;
            for (let i = 0; i < next.length; i++) {
                const d0 = Math.hypot(holes[i].x - from.x, holes[i].y - from.y);
                const d1 = Math.hypot(holes[i].x - to.x, holes[i].y - to.y);
                if (d0 <= tol || d1 <= tol) {
                    next[i] = { x: to.x, y: to.y };
                    changed = true;
                }
            }
            if (changed) this._rebuildWireJumperPose(comp, next[0], next[1]);
        }
    },

    // Wire jumper follows copper like a 2-point track: each hole glued to its vertex.
    // Does not insert joints — call ensureWireJumperJoints / prepareSegmentDrag for that.
    anchorJumperPinsToTrace(trace, tol = 1.5) {
        if (!trace || !Array.isArray(trace.points) || trace.points.length === 0) return;
        const def = ComponentDefs.get('jumper');
        if (!def || !def.sizes) return;
        for (const comp of this.components) {
            if (!this.isWireJumper(comp)) continue;
            const size = ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize);
            if (!size || size.jkind !== 'wire') continue;
            const holes = this._wireJumperHoleWorld(comp, size);
            if (holes.length < 2) continue;
            const next = holes.map(h => ({ x: h.x, y: h.y }));
            let changed = false;
            for (let i = 0; i < next.length; i++) {
                let bestI = -1, bd = tol;
                for (let vi = 0; vi < trace.points.length; vi++) {
                    const v = trace.points[vi];
                    const d = Math.hypot(v.x - holes[i].x, v.y - holes[i].y);
                    if (d < bd) { bd = d; bestI = vi; }
                }
                if (bestI < 0) continue;
                const v = trace.points[bestI];
                if (v.x !== next[i].x || v.y !== next[i].y) {
                    next[i] = { x: v.x, y: v.y };
                    changed = true;
                }
            }
            if (changed) this._rebuildWireJumperPose(comp, next[0], next[1]);
        }
    },

    // Stretch one solder hole (like dragging a trace vertex). Copper on that hole follows.
    moveWireJumperHole(comp, holeIndex, nx, ny, tol = 1.5) {
        if (!this.isWireJumper(comp)) return;
        const size = ComponentDefs.getSize(ComponentDefs.get('jumper'), comp.size !== undefined ? comp.size : 2);
        const holes = this._wireJumperHoleWorld(comp, size);
        if (holeIndex < 0 || holeIndex >= holes.length) return;
        const old = holes[holeIndex];
        for (const trace of this.traces) {
            if (!trace.points) continue;
            for (const pt of trace.points) {
                if (Math.hypot(pt.x - old.x, pt.y - old.y) < tol) { pt.x = nx; pt.y = ny; }
            }
        }
        holes[holeIndex] = { x: nx, y: ny };
        this._rebuildWireJumperPose(comp, holes[0], holes[1]);
    },

    // Rotate a board component and move any trace endpoints sitting on its pads so traces stay connected.
    rotateCompWithTraces(comp, newRot) {
        const oldRot = comp.rotation || 0;
        if (oldRot === newRot) return;
        const pins = this.getCompPins(comp);
        if (!pins || !pins.length) { comp.rotation = newRot; return; }
        // Capture pre-rotation pin world positions.
        const oldRad = oldRot * Math.PI / 180;
        const oCos = Math.cos(oldRad), oSin = Math.sin(oldRad);
        const prePins = pins.map(p => ({ x: comp.x + p.x * oCos - p.y * oSin, y: comp.y + p.x * oSin + p.y * oCos }));
        // Apply new rotation.
        comp.rotation = newRot;
        // Compute post-rotation pin world positions.
        const newRad = newRot * Math.PI / 180;
        const nCos = Math.cos(newRad), nSin = Math.sin(newRad);
        const postPins = pins.map(p => ({ x: comp.x + p.x * nCos - p.y * nSin, y: comp.y + p.x * nSin + p.y * nCos }));
        // Move any trace point that was at an old pin position to the new position.
        const tol = 1.5;
        for (const trace of this.traces) {
            for (const pt of trace.points) {
                let bestI = -1, bd = Infinity;
                prePins.forEach((pp, i) => { const d = Math.hypot(pt.x - pp.x, pt.y - pp.y); if (d < bd) { bd = d; bestI = i; } });
                if (bestI >= 0 && bd < tol) {
                    pt.x = postPins[bestI].x;
                    pt.y = postPins[bestI].y;
                }
            }
        }
    },

    segmentDragAxis(p0, p1) {
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return 'free';
        const ang = Math.abs(Math.atan2(dy, dx)); // 0..pi
        const deg = 8 * Math.PI / 180;
        if (ang < deg || ang > Math.PI - deg) return 'h';
        if (Math.abs(ang - Math.PI / 2) < deg) return 'v';
        return 'free';
    },

    // If a segment end sits on a pad, insert a jog vertex so dragging the
    // segment does not pull the copper off the pad.
    prepareSegmentDrag(trace, segIndex) {
        const inserted = this._promoteJumperHolesOnTrace(trace, 1.5);
        let i = segIndex;
        for (let n = 0; n < inserted.length; n++) {
            if (inserted[n] <= i) i += 1;
        }
        const isPad = (idx) => {
            const c = this.getPadConstraint(trace, idx);
            return !!(c && c.label && String(c.label).indexOf('via') < 0);
        };
        const addVertex = (atIndex, fromIndex, newSegIndex) => {
            const p = trace.points[fromIndex];
            trace.points.splice(atIndex, 0, { x: p.x, y: p.y });
            if (!trace.curved) trace.curved = [];
            trace.curved.splice(newSegIndex, 0, false);
            if (!trace.segmentWidths) trace.segmentWidths = [];
            const w = (trace.segmentWidths[newSegIndex] != null) ? trace.segmentWidths[newSegIndex] : trace.width;
            trace.segmentWidths.splice(newSegIndex, 0, w);
        };
        if (isPad(i)) {
            addVertex(i + 1, i, i);
            i += 1;
        }
        if (isPad(i + 1)) {
            addVertex(i + 1, i + 1, i + 1);
        }
        this.ensureSegmentWidths(trace);
        return i;
    },

    applySegmentDrag(trace, segIndex, axis, origP0, origP1, dx, dy) {
        const p0 = trace.points[segIndex];
        const p1 = trace.points[segIndex + 1];
        if (!p0 || !p1) return;
        if (axis === 'h') {
            const ny = this.snapToGrid(origP0.y + dy);
            p0.x = origP0.x; p1.x = origP1.x;
            p0.y = ny; p1.y = ny;
        } else if (axis === 'v') {
            const nx = this.snapToGrid(origP0.x + dx);
            p0.y = origP0.y; p1.y = origP1.y;
            p0.x = nx; p1.x = nx;
        } else {
            const nx = this.snapToGrid(origP0.x + dx);
            const ny = this.snapToGrid(origP0.y + dy);
            const ox = nx - origP0.x, oy = ny - origP0.y;
            p0.x = origP0.x + ox; p0.y = origP0.y + oy;
            p1.x = origP1.x + ox; p1.y = origP1.y + oy;
        }
    }
});
