// ============================================================
// Hit Testing & Geometry Helpers
// ============================================================

Object.assign(App, {
    hitCompSilk(comp, wx, wy) {
        const size = this.getCompSize(comp);
        if (!size) return null;
        this.ensureCompSilkLayout(comp);
        const local = this.compSilkWorldToLocal(comp, wx, wy);
        // Rotated text-box test per field — same box metrics as the on-screen
        // selection highlight in drawCompSilkLabels.
        const hitField = (text, pos, isLabel) => {
            if (!text) return false;
            const fs = this.compSilkEffectiveFontSize(pos, size);
            const tw = text.length * fs * 0.55 + 0.6;
            const th = fs + 0.4;
            const y0 = isLabel ? -th + 0.15 : -0.15;
            const y1 = isLabel ? 0.15 : -0.15 + th;
            const dx = local.x - pos.x, dy = local.y - pos.y;
            const rad = -(pos.rotation || 0) * Math.PI / 180;
            const qx = dx * Math.cos(rad) - dy * Math.sin(rad);
            const qy = dx * Math.sin(rad) + dy * Math.cos(rad);
            return qx >= -tw / 2 && qx <= tw / 2 && qy >= y0 && qy <= y1;
        };
        const label = (comp.label || '').trim();
        const value = (comp.value || '').trim();
        if (hitField(label, comp.silkLabel, true)) return { compId: comp.id, field: 'label', comp };
        if (hitField(value, comp.silkValue, false)) return { compId: comp.id, field: 'value', comp };
        return null;
    },

    selectAt(wx, wy) {
        const threshold = 3 / this.view.zoom;
        // Component silk labels (designator / value) take priority when silk is visible.
        for (const comp of this.components) {
            const compLayer = comp.layer || 'top';
            const silkVisible = (compLayer === 'top' && this.view.visibleLayers.silkTop) ||
                (compLayer === 'bottom' && this.view.visibleLayers.silkBottom);
            if (!silkVisible) continue;
            const silkHit = this.hitCompSilk(comp, wx, wy);
            if (silkHit) {
                this.interaction.selectedObject = { type: 'compSilk', compId: silkHit.compId, field: silkHit.field, obj: silkHit.comp };
                this.showProperties(silkHit.comp);
                this.render();
                return;
            }
        }
        const wjSel = this.hitWireJumper(wx, wy);
        if (wjSel) {
            this.interaction.selectedObject = { type: 'component', obj: wjSel.comp };
            this.showProperties(wjSel.comp); this.render(); return;
        }
        for (const comp of this.components) {
            if (this.isWireJumper(comp)) continue;
            const size = this.getCompSize(comp);
            if (!size) continue;
            const hw = size.width / 2 + threshold, hh = size.height / 2 + threshold;
            if (Math.abs(wx - comp.x) < hw && Math.abs(wy - comp.y) < hh) {
                this.interaction.selectedObject = { type: 'component', obj: comp };
                this.showProperties(comp); this.render(); return;
            }
        }
        for (const via of this.vias) {
            const dx = wx - via.x, dy = wy - via.y;
            if (Math.sqrt(dx * dx + dy * dy) < via.diameter / 2 + threshold) {
                this.interaction.selectedObject = { type: 'via', obj: via };
                this.showProperties(via); this.render(); return;
            }
        }
        for (const trace of this.traces) {
            if (trace.schemWire) continue; // logical wire — not selectable board copper
            if (this.pointNearPolyline(wx, wy, trace.points, threshold + trace.width / 2)) {
                this.interaction.selectedObject = { type: 'trace', obj: trace };
                this.interaction.selectedSegment = null;
                this.showProperties(trace); this.render(); return;
            }
        }
        for (const txt of this.silkTexts) {
            if (Math.abs(wx - txt.x) < threshold + 2 && Math.abs(wy - txt.y) < threshold + 1) {
                this.interaction.selectedObject = { type: 'silktxt', obj: txt };
                this.showProperties(txt); this.render(); return;
            }
        }
        this.interaction.selectedObject = null;
        this.interaction.selectedSegment = null;
        document.getElementById('properties-content').innerHTML = '<p class="hint">Select an object to see its properties.</p>';
        this.render();
    },

    // Hit-test a placement zone: corner handle -> resize, interior -> move.
    hitZone(wx, wy) {
        const zones = this.zones || [];
        const thr = 4 / this.view.zoom;
        for (let i = zones.length - 1; i >= 0; i--) {
            const z = zones[i];
            const x1 = z.x - z.w / 2, y1 = z.y - z.h / 2, x2 = z.x + z.w / 2, y2 = z.y + z.h / 2;
            const corners = [[x1, y1, 0], [x2, y1, 1], [x2, y2, 2], [x1, y2, 3]];
            for (const [cx, cy, ci] of corners) {
                if (Math.abs(wx - cx) < thr && Math.abs(wy - cy) < thr) return { zone: z, part: 'resize', corner: ci };
            }
            if (wx > x1 && wx < x2 && wy > y1 && wy < y2) return { zone: z, part: 'move' };
        }
        return null;
    },

    deleteAt(wx, wy) {
        const threshold = 3 / this.view.zoom;
        for (let i = this.components.length - 1; i >= 0; i--) {
            const comp = this.components[i];
            const size = this.getCompSize(comp);
            if (!size) continue;
            const hw = size.width / 2 + threshold, hh = size.height / 2 + threshold;
            if (Math.abs(wx - comp.x) < hw && Math.abs(wy - comp.y) < hh) {
                this.components.splice(i, 1); this.saveState(); this.render(); return;
            }
        }
        for (let i = this.vias.length - 1; i >= 0; i--) {
            const via = this.vias[i];
            if (Math.sqrt((wx - via.x) ** 2 + (wy - via.y) ** 2) < via.diameter / 2 + threshold) {
                this.vias.splice(i, 1); this.saveState(); this.render(); return;
            }
        }
        for (let i = this.traces.length - 1; i >= 0; i--) {
            if (this.traces[i].schemWire) continue; // logical wire — not deletable board copper
            if (this.pointNearPolyline(wx, wy, this.traces[i].points, threshold + this.traces[i].width / 2)) {
                if (this._ensureLogicalSchemWire) this._ensureLogicalSchemWire(this.traces[i]);
                this.traces.splice(i, 1); this.saveState(); this.render(); return;
            }
        }
        for (let i = this.silkTexts.length - 1; i >= 0; i--) {
            const txt = this.silkTexts[i];
            if (Math.abs(wx - txt.x) < threshold + 2 && Math.abs(wy - txt.y) < threshold + 1) {
                this.silkTexts.splice(i, 1); this.saveState(); this.render(); return;
            }
        }
    },

    pointNearPolyline(px, py, points, dist) {
        for (let i = 0; i < points.length - 1; i++) {
            if (this.pointToSegDist(px, py, points[i], points[i + 1]) < dist) return true;
        }
        return false;
    },

    pointToSegDist(px, py, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - a.x) ** 2 + (py - a.y) ** 2);
        let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.sqrt((px - a.x - t * dx) ** 2 + (py - a.y - t * dy) ** 2);
    },

    hitTraceVertex(wx, wy) {
        // Screen-space grab (~12px) so joints stay hittable at high zoom; never smaller than ~1.2mm.
        const threshold = Math.max(12 / this.view.zoom, 1.2);
        let best = null, bd = Infinity;
        for (const trace of this.traces) {
            if (!trace.points) continue;
            if (trace.schemWire) continue; // logical wire — no board vertex handles
            for (let i = 0; i < trace.points.length; i++) {
                const p = trace.points[i];
                const d = Math.hypot(wx - p.x, wy - p.y);
                if (d < threshold && d < bd) { bd = d; best = { traceId: trace.id, pointIndex: i }; }
            }
        }
        return best;
    },

    hitTraceSegment(wx, wy) {
        const threshold = 3 / this.view.zoom;
        for (const trace of this.traces) {
            if (trace.schemWire) continue; // logical wire — not board copper
            for (let i = 0; i < trace.points.length - 1; i++) {
                const segW = this.getSegmentWidth(trace, i);
                if (this.pointToSegDist(wx, wy, trace.points[i], trace.points[i + 1]) < threshold + segW / 2) {
                    return { traceId: trace.id, segIndex: i };
                }
            }
        }
        return null;
    },

    hitAnyElement(wx, wy) {
        const tvHit = this.hitTraceVertex(wx, wy);
        if (tvHit) return { type: 'traceVertex', traceId: tvHit.traceId, pointIndex: tvHit.pointIndex };
        const via = this.hitVia(wx, wy);
        if (via) return { type: 'via', obj: via };
        const trace = this.hitTrace(wx, wy);
        if (trace) return { type: 'trace', obj: trace.obj, segIndex: trace.segIndex };
        const comp = this.hitComponent(wx, wy);
        if (comp) return { type: 'component', obj: comp };
        return null;
    },

    isWireJumper(comp) {
        if (!comp || comp.type !== 'jumper') return false;
        const def = ComponentDefs.get('jumper');
        const size = (this.getCompSize && this.getCompSize(comp)) || (def && ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize));
        return !!(size && size.jkind === 'wire');
    },

    // Wire jumper is a two-ended airwire: hit a hole (vertex) or the hairline (segment), not a footprint box.
    hitWireJumper(wx, wy) {
        const zoom = (this.view && this.view.zoom) || 1;
        const holeR = Math.max(6 / zoom, 0.8);
        const segTol = Math.max(6 / zoom, 0.8);
        let best = null, bestD = Infinity;
        for (let i = this.components.length - 1; i >= 0; i--) {
            const comp = this.components[i];
            if (!this.isWireJumper(comp)) continue;
            const def = ComponentDefs.get('jumper');
            const size = (this.getCompSize && this.getCompSize(comp)) || (def && ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize));
            const holes = this._wireJumperHoleWorld ? this._wireJumperHoleWorld(comp, size) : [];
            if (holes.length < 2) continue;
            for (let h = 0; h < holes.length; h++) {
                const d = Math.hypot(wx - holes[h].x, wy - holes[h].y);
                if (d <= holeR && d < bestD) { bestD = d; best = { comp, part: 'hole', holeIndex: h }; }
            }
            const dSeg = this.pointToSegDist(wx, wy, holes[0], holes[1]);
            if (dSeg <= segTol && dSeg < bestD) { bestD = dSeg; best = { comp, part: 'seg', holeIndex: -1 }; }
        }
        return best;
    },

    hitComponent(wx, wy) {
        const wj = this.hitWireJumper(wx, wy);
        if (wj) return wj.comp;
        const threshold = 3 / this.view.zoom;
        for (let i = this.components.length - 1; i >= 0; i--) {
            const comp = this.components[i];
            if (this.isWireJumper(comp)) continue;
            const size = this.getCompSize(comp);
            if (!size) continue;
            const hw = size.width / 2 + threshold, hh = size.height / 2 + threshold;
            if (Math.abs(wx - comp.x) < hw && Math.abs(wy - comp.y) < hh) return comp;
        }
        return null;
    },

    hitVia(wx, wy) {
        const threshold = 3 / this.view.zoom;
        for (let i = this.vias.length - 1; i >= 0; i--) {
            const via = this.vias[i];
            if (Math.sqrt((wx - via.x) ** 2 + (wy - via.y) ** 2) < via.diameter / 2 + threshold) return via;
        }
        return null;
    },

    hitTrace(wx, wy) {
        if (this.hitTraceVertex(wx, wy)) return null; // joint grab always wins over the run
        const threshold = Math.max(4 / this.view.zoom, 0.4);
        let best = null, bestD = Infinity;
        for (let i = this.traces.length - 1; i >= 0; i--) {
            const trace = this.traces[i];
            if (trace.schemWire) continue; // logical wire — not board copper
            for (let si = 0; si < trace.points.length - 1; si++) {
                const segW = this.getSegmentWidth ? this.getSegmentWidth(trace, si) : (trace.width || 0.5);
                const d = this.pointToSegDist(wx, wy, trace.points[si], trace.points[si + 1]);
                const maxD = threshold + segW / 2;
                if (d < maxD && d < bestD) {
                    bestD = d;
                    best = { obj: trace, segIndex: si };
                }
            }
        }
        return best;
    },

    // Magnetic alignment: given a candidate centre (x, y) for a moving component,
    // find the nearest position where one of its edges/centre lines up with an
    // edge/centre of another component on the board.
    // movingComp: { pins: [{x,y} local mm], rotation } — its x/y are not needed.
    // exceptId: id to ignore (the dragged component itself).
    // Returns { x, y, lineX, lineY }; a null axis means no snap; lineX/lineY are
    // the world coords of the alignment guides (for drawing). Only movers at
    // 0/90/180/270° participate — arbitrary-angle parts have no stable edges.
    alignPosToComps(x, y, movingComp, exceptId) {
        const res = { x: null, y: null, lineX: null, lineY: null };
        const pins = movingComp && movingComp.pins;
        if (!pins || !pins.length) return res;
        const rot = Math.round(movingComp.rotation || 0) % 360;
        if (rot % 90 !== 0) return res;
        // Mover key local points: bounding-box corners + centre.
        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (const p of pins) {
            xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x);
            ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
        }
        const keyPts = [[xmin, ymin], [xmax, ymin], [xmin, ymax], [xmax, ymax], [0, 0]];
        // Rotate key points to world space → offset lines relative to the centre.
        const rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        const r3 = v => Math.round(v * 1000) / 1000; // µm-precision dedupe key
        const xOffs = [...new Set(keyPts.map(([lx, ly]) => r3(lx * cos - ly * sin)))];
        const yOffs = [...new Set(keyPts.map(([lx, ly]) => r3(lx * sin + ly * cos)))];

        // Snap threshold: ~4 px on screen, capped at 2 mm (not grabby when zoomed out).
        const th = Math.min(4 / this.view.zoom, 2);
        let bestDx = th, bestDy = th;
        for (const c of this.components) {
            if (c.id === exceptId) continue;
            const cp = (c.pins && c.pins.length) ? c.pins : this.getCompPins(c);
            if (!cp || !cp.length) continue;
            // Target key points in world space (targets may be at any rotation).
            const crad = (c.rotation || 0) * Math.PI / 180, cc = Math.cos(crad), ss = Math.sin(crad);
            let cxmin = Infinity, cxmax = -Infinity, cyymin = Infinity, cyymax = -Infinity;
            for (const p of cp) {
                cxmin = Math.min(cxmin, p.x); cxmax = Math.max(cxmax, p.x);
                cyymin = Math.min(cyymin, p.y); cyymax = Math.max(cyymax, p.y);
            }
            const cpt = [[cxmin, cyymin], [cxmax, cyymin], [cxmin, cyymax], [cxmax, cyymax], [0, 0]];
            for (const [lx, ly] of cpt) {
                const wx = c.x + lx * cc - ly * ss; // world x of a target key point
                const wy = c.y + lx * ss + ly * cc; // world y
                for (const o of xOffs) {
                    const cand = wx - o, d = Math.abs(cand - x);
                    if (d < bestDx) { bestDx = d; res.x = cand; res.lineX = wx; }
                }
                for (const o of yOffs) {
                    const cand = wy - o, d = Math.abs(cand - y);
                    if (d < bestDy) { bestDy = d; res.y = cand; res.lineY = wy; }
                }
            }
        }
        return res;
    }
});
