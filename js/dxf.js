// ============================================================
// DXF R2000 (AC1015) export — PCB geometry interchange
// Standard mode: LINE / LWPOLYLINE / CIRCLE / ARC
// Legacy mode:   LINE / POLYLINE+VERTEX+SEQEND / CIRCLE / ARC
// ============================================================
const Dxf = {
    NL: '\r\n',
    PREC: 6,
    EPS: 1e-9,

    LAYERS: [
        { name: '0', color: 7 },
        { name: 'OUTLINE', color: 7 },
        { name: 'TRACE_OUTLINE_TOP', color: 1 },
        { name: 'TRACE_TOP', color: 1 },
        { name: 'PAD_TOP', color: 1 },
        { name: 'COPPER_TOP', color: 1 },
        { name: 'TRACE_OUTLINE_BOTTOM', color: 5 },
        { name: 'TRACE_BOTTOM', color: 5 },
        { name: 'PAD_BOTTOM', color: 5 },
        { name: 'COPPER_BOTTOM', color: 5 },
        { name: 'DRILL', color: 3 }
    ],

    ENTITY_LAYER_ORDER: [
        'OUTLINE',
        'TRACE_OUTLINE_TOP', 'TRACE_TOP', 'PAD_TOP', 'COPPER_TOP',
        'TRACE_OUTLINE_BOTTOM', 'TRACE_BOTTOM', 'PAD_BOTTOM', 'COPPER_BOTTOM',
        'DRILL'
    ],

    MODE_STANDARD: 'standard',
    MODE_LEGACY: 'legacy',

    fmtCoord(n) {
        const v = Math.abs(n) < 5e-12 ? 0 : n;
        return v.toFixed(this.PREC);
    },

    isFiniteNum(n) {
        return typeof n === 'number' && isFinite(n);
    },

    isValidPoint(p) {
        return p && this.isFiniteNum(p.x) && this.isFiniteNum(p.y);
    },

    almostEq(a, b) {
        return Math.abs(a - b) <= this.EPS;
    },

    dist2(a, b) {
        const dx = a.x - b.x, dy = a.y - b.y;
        return dx * dx + dy * dy;
    },

    cleanOpenPoints(pts) {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (!this.isValidPoint(p)) return { ok: false, error: 'Invalid polyline vertex (NaN/Infinity).' };
            if (out.length && this.dist2(out[out.length - 1], p) <= this.EPS * this.EPS) continue;
            out.push({ x: p.x, y: p.y });
        }
        return { ok: true, points: out };
    },

    cleanClosedPoints(pts) {
        const open = this.cleanOpenPoints(pts);
        if (!open.ok) return open;
        const out = open.points.slice();
        if (out.length >= 2 && this.dist2(out[0], out[out.length - 1]) <= this.EPS * this.EPS) out.pop();
        return { ok: true, points: out };
    },

    undirectedLineKey(layer, a, b) {
        const aKey = this.fmtCoord(a.x) + ',' + this.fmtCoord(a.y);
        const bKey = this.fmtCoord(b.x) + ',' + this.fmtCoord(b.y);
        return aKey < bKey
            ? layer + '|L|' + aKey + '|' + bKey
            : layer + '|L|' + bKey + '|' + aKey;
    },

    circleKey(layer, c) {
        return layer + '|C|' + this.fmtCoord(c.x) + ',' + this.fmtCoord(c.y) + '|' + this.fmtCoord(c.r);
    },

    polylineKey(layer, closed, pts) {
        const body = pts.map(p => this.fmtCoord(p.x) + ',' + this.fmtCoord(p.y)).join(';');
        return layer + '|P|' + (closed ? '1' : '0') + '|' + body;
    },

    segmentWidth(app, trace, i) {
        if (app && typeof app.getSegmentWidth === 'function') return app.getSegmentWidth(trace, i);
        if (trace.segmentWidths && trace.segmentWidths[i] !== undefined) return trace.segmentWidths[i];
        return trace.width;
    },

    // World Y-down, board-center origin → DXF Y-up, south-west origin.
    // With mirror on, also flips X so the output is the other-side (bottom) view.
    buildTransform(exportApi, app) {
        const outlineWorld = exportApi.boardOutlinePoints(app);
        if (!outlineWorld || !outlineWorld.length) {
            return { ok: false, error: 'Board outline has no points.' };
        }
        for (let i = 0; i < outlineWorld.length; i++) {
            if (!this.isValidPoint(outlineWorld[i])) {
                return { ok: false, error: 'Board outline contains invalid coordinates.' };
            }
        }
        const mirror = !!(app && app.export && app.export.mirror);
        const flip = (p) => {
            const f = exportApi.flipY(p);
            return mirror ? { x: -f.x, y: f.y } : f;
        };
        let originX = Infinity, originY = Infinity;
        outlineWorld.forEach(p => {
            const f = flip(p);
            if (f.x < originX) originX = f.x;
            if (f.y < originY) originY = f.y;
        });
        if (!this.isFiniteNum(originX) || !this.isFiniteNum(originY)) {
            return { ok: false, error: 'Failed to compute DXF origin from board outline.' };
        }
        const toDxf = (p) => {
            const f = flip(p);
            return { x: f.x - originX, y: f.y - originY, z: 0 };
        };
        return { ok: true, originX, originY, toDxf, outlineWorld };
    },

    traceCenterlineWorld(exportApi, app, trace) {
        const pts = trace.points || [];
        if (pts.length < 2) return { ok: true, points: [] };
        const world = [];
        const push = (p) => {
            if (!this.isValidPoint(p)) return false;
            if (world.length && this.dist2(world[world.length - 1], p) <= this.EPS * this.EPS) return true;
            world.push({ x: p.x, y: p.y });
            return true;
        };
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i], p1 = pts[i + 1];
            if (!this.isValidPoint(p0) || !this.isValidPoint(p1)) {
                return { ok: false, error: 'Trace contains invalid coordinates.' };
            }
            if (trace.curved && trace.curved[i]) {
                const samples = exportApi.sampleQuadraticBezier(p0, p1, exportApi.curveSegments(p0, p1));
                for (let j = 0; j < samples.length; j++) {
                    if (!push(samples[j])) return { ok: false, error: 'Trace curve sample is invalid.' };
                }
            } else {
                if (!push(p0)) return { ok: false, error: 'Trace vertex is invalid.' };
            }
        }
        if (!push(pts[pts.length - 1])) return { ok: false, error: 'Trace vertex is invalid.' };
        return { ok: true, points: world };
    },

    ovalPolyline(cx, cy, w, h) {
        const hw = w / 2, hh = h / 2;
        return [
            { x: cx - hw, y: cy - hh },
            { x: cx + hw, y: cy - hh },
            { x: cx + hw, y: cy + hh },
            { x: cx - hw, y: cy + hh }
        ];
    },

    collectEntities(app, exportApi, toDxf) {
        const errors = [];
        const buckets = {};
        this.ENTITY_LAYER_ORDER.forEach(name => { buckets[name] = []; });
        const seen = Object.create(null);
        const ex = app.export || {};

        const pushLine = (layer, a, b) => {
            if (!this.isValidPoint(a) || !this.isValidPoint(b)) {
                errors.push('LINE on ' + layer + ' has invalid coordinates.');
                return;
            }
            if (this.dist2(a, b) <= this.EPS * this.EPS) return;
            const key = this.undirectedLineKey(layer, a, b);
            if (seen[key]) return;
            seen[key] = true;
            buckets[layer].push({ type: 'LINE', layer, x1: a.x, y1: a.y, z1: 0, x2: b.x, y2: b.y, z2: 0 });
        };

        const pushPolyline = (layer, points, closed) => {
            const cleaned = closed ? this.cleanClosedPoints(points) : this.cleanOpenPoints(points);
            if (!cleaned.ok) {
                errors.push(cleaned.error + ' (layer ' + layer + ')');
                return;
            }
            const pts = cleaned.points;
            if (closed) {
                if (pts.length < 3) {
                    errors.push('Closed polyline on ' + layer + ' has fewer than 3 vertices.');
                    return;
                }
            } else if (pts.length < 2) {
                return;
            } else if (pts.length === 2) {
                pushLine(layer, pts[0], pts[1]);
                return;
            }
            const key = this.polylineKey(layer, !!closed, pts);
            if (seen[key]) return;
            seen[key] = true;
            buckets[layer].push({ type: 'POLYLINE', layer, closed: !!closed, points: pts });
        };

        const pushCircle = (layer, x, y, r) => {
            if (!this.isFiniteNum(x) || !this.isFiniteNum(y) || !this.isFiniteNum(r)) {
                errors.push('CIRCLE on ' + layer + ' has invalid coordinates or radius.');
                return;
            }
            if (!(r > 0)) {
                errors.push('CIRCLE on ' + layer + ' has invalid radius ' + r + '.');
                return;
            }
            const key = this.circleKey(layer, { x, y, r });
            if (seen[key]) return;
            seen[key] = true;
            buckets[layer].push({ type: 'CIRCLE', layer, x, y, z: 0, r });
        };

        const pushArc = (layer, x, y, r, startAng, endAng) => {
            if (!this.isFiniteNum(x) || !this.isFiniteNum(y) || !this.isFiniteNum(r) ||
                !this.isFiniteNum(startAng) || !this.isFiniteNum(endAng)) {
                errors.push('ARC on ' + layer + ' has invalid geometry.');
                return;
            }
            if (!(r > 0)) {
                errors.push('ARC on ' + layer + ' has invalid radius ' + r + '.');
                return;
            }
            buckets[layer].push({ type: 'ARC', layer, x, y, z: 0, r, startAng, endAng });
        };
        void pushArc;

        // OUTLINE
        if (ex.includeBoardOutline !== false) {
            const outline = exportApi.boardOutlinePoints(app).map(toDxf);
            pushPolyline('OUTLINE', outline, true);
        }

        // TRACE_OUTLINE (individual trace copper boundaries — PCB geometry, not tool compensation)
        if (ex.includeCopperOutlines !== false && app.traces) {
            app.traces.forEach(trace => {
                if (trace.schemWire) return; // logical wire — not copper outline
                const layer = trace.layer === 'bottom' ? 'TRACE_OUTLINE_BOTTOM' : 'TRACE_OUTLINE_TOP';
                if (!exportApi.layerOn(app, layer)) return;
                const polys = exportApi.generateTraceOutline(app, trace) || [];
                polys.forEach(pts => {
                    if (!pts || pts.length < 3) return;
                    pushPolyline(layer, pts.map(toDxf), true);
                });
            });
        }

        // TRACE centerlines
        if (ex.includeTraces !== false && app.traces) {
            app.traces.forEach(trace => {
                if (trace.schemWire) return; // logical wire — not a copper centerline
                const layer = trace.layer === 'bottom' ? 'TRACE_BOTTOM' : 'TRACE_TOP';
                if (!exportApi.layerOn(app, layer)) return;
                const spine = this.traceCenterlineWorld(exportApi, app, trace);
                if (!spine.ok) {
                    errors.push(spine.error);
                    return;
                }
                if (spine.points.length < 2) return;
                const dxfPts = spine.points.map(toDxf);
                if (dxfPts.length === 2) pushLine(layer, dxfPts[0], dxfPts[1]);
                else pushPolyline(layer, dxfPts, false);
            });
        }

        // PADS — components
        if (ex.includeComps !== false && app.components) {
            app.components.forEach(comp => {
                const padLayer = comp.layer === 'bottom' ? 'PAD_BOTTOM' : 'PAD_TOP';
                if (!exportApi.layerOn(app, padLayer)) return;
                exportApi.padFeatures(app, comp).forEach(pad => {
                    if (pad.kind === 'circle') {
                        const c = toDxf({ x: pad.x, y: pad.y });
                        pushCircle(padLayer, c.x, c.y, pad.r);
                    } else if (pad.pts && pad.pts.length >= 3) {
                        pushPolyline(padLayer, pad.pts.map(toDxf), true);
                    } else {
                        errors.push('Unsupported pad geometry on ' + padLayer + '.');
                    }
                });
            });
        }

        // PADS — via copper rings (through-hole: both sides)
        if (ex.includeComps !== false && app.vias) {
            app.vias.forEach(via => {
                if (!this.isFiniteNum(via.x) || !this.isFiniteNum(via.y)) {
                    errors.push('Via has invalid coordinates.');
                    return;
                }
                const r = (via.diameter || 0) / 2;
                if (!(r > 0)) return;
                const c = toDxf({ x: via.x, y: via.y });
                if (exportApi.layerOn(app, 'PAD_TOP')) pushCircle('PAD_TOP', c.x, c.y, r);
                if (exportApi.layerOn(app, 'PAD_BOTTOM')) pushCircle('PAD_BOTTOM', c.x, c.y, r);
            });
        }

        // DRILL
        if (ex.includeHoles !== false) {
            exportApi.collectDrills(app).forEach(h => {
                const c = toDxf({ x: h.x, y: h.y });
                if (h.oval) {
                    if (!(h.w > 0) || !(h.h > 0)) {
                        errors.push('Oval drill has invalid size.');
                        return;
                    }
                    pushPolyline('DRILL', this.ovalPolyline(c.x, c.y, h.w, h.h), true);
                } else {
                    pushCircle('DRILL', c.x, c.y, h.r);
                }
            });
        }

        // COPPER (unioned copper-island outlines — all traces + pads + vias merged)
        ['top', 'bottom'].forEach(side => {
            if (!exportApi.layerEnabled(app, side)) return;
            const layerName = side === 'top' ? 'COPPER_TOP' : 'COPPER_BOTTOM';
            const islands = exportApi.unionCopperIslands(app, side);
            islands.forEach(pts => {
                if (!pts || pts.length < 3) return;
                const dxfPts = pts.map(p => toDxf(p));
                pushPolyline(layerName, dxfPts, true);
            });
        });

        const entities = [];
        this.ENTITY_LAYER_ORDER.forEach(name => {
            buckets[name].forEach(ent => entities.push(ent));
        });
        return { ok: errors.length === 0, error: errors.join('\n'), entities };
    },

    entityBounds(ent, bounds) {
        const add = (x, y) => {
            if (x < bounds.minX) bounds.minX = x;
            if (y < bounds.minY) bounds.minY = y;
            if (x > bounds.maxX) bounds.maxX = x;
            if (y > bounds.maxY) bounds.maxY = y;
        };
        if (ent.type === 'LINE') {
            add(ent.x1, ent.y1); add(ent.x2, ent.y2);
        } else if (ent.type === 'CIRCLE' || ent.type === 'ARC') {
            add(ent.x - ent.r, ent.y - ent.r);
            add(ent.x + ent.r, ent.y + ent.r);
        } else if (ent.type === 'POLYLINE') {
            ent.points.forEach(p => add(p.x, p.y));
        }
    },

    computeBounds(entities) {
        const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        entities.forEach(ent => this.entityBounds(ent, bounds));
        if (!isFinite(bounds.minX)) {
            return { minX: 0, minY: 0, maxX: 0, maxY: 0, empty: true };
        }
        bounds.empty = false;
        return bounds;
    },

    validateEntities(entities, app) {
        const errors = [];
        entities.forEach(ent => {
            if (ent.type === 'LINE') {
                [ent.x1, ent.y1, ent.z1, ent.x2, ent.y2, ent.z2].forEach(n => {
                    if (!this.isFiniteNum(n)) errors.push('LINE has non-finite coordinates.');
                });
                if (ent.z1 !== 0 || ent.z2 !== 0) errors.push('LINE is not planar Z=0.');
                if (this.almostEq(ent.x1, ent.x2) && this.almostEq(ent.y1, ent.y2)) {
                    errors.push('Zero-length LINE.');
                }
            } else if (ent.type === 'CIRCLE') {
                if (!this.isFiniteNum(ent.x) || !this.isFiniteNum(ent.y) || !this.isFiniteNum(ent.r)) {
                    errors.push('CIRCLE has non-finite geometry.');
                }
                if (ent.z !== 0) errors.push('CIRCLE is not planar Z=0.');
                if (!(ent.r > 0)) errors.push('CIRCLE radius must be > 0.');
            } else if (ent.type === 'ARC') {
                if (!(ent.r > 0)) errors.push('ARC radius must be > 0.');
                if (ent.z !== 0) errors.push('ARC is not planar Z=0.');
            } else if (ent.type === 'POLYLINE') {
                if (!ent.points || ent.points.length < (ent.closed ? 3 : 2)) {
                    errors.push('POLYLINE has too few vertices.');
                }
                (ent.points || []).forEach(p => {
                    if (!this.isValidPoint(p)) errors.push('POLYLINE vertex is invalid.');
                });
            } else {
                errors.push('Unsupported geometry type: ' + ent.type);
            }
        });

        const outline = entities.filter(e => e.layer === 'OUTLINE');
        if (app && app.export && app.export.includeBoardOutline !== false &&
            (!app.boardOutline || app.boardOutline.length < 3) &&
            outline.length) {
            const b = this.computeBounds(outline);
            const bw = app.board && app.board.width;
            const bh = app.board && app.board.height;
            if (this.isFiniteNum(bw) && this.isFiniteNum(bh)) {
                if (Math.abs(b.minX) > 1e-6 || Math.abs(b.minY) > 1e-6 ||
                    Math.abs(b.maxX - bw) > 1e-6 || Math.abs(b.maxY - bh) > 1e-6) {
                    errors.push(
                        'Board outline bounds (' + b.minX + ',' + b.minY + ')-(' +
                        b.maxX + ',' + b.maxY + ') do not match board ' + bw + ' x ' + bh + ' mm with origin (0,0).'
                    );
                }
            }
        }
        return errors;
    },

    writer() {
        const lines = [];
        const self = this;
        return {
            pair(code, value) {
                lines.push(String(code), String(value));
            },
            coord(code, n) {
                lines.push(String(code), self.fmtCoord(n));
            },
            toString() {
                return lines.join(self.NL) + self.NL;
            }
        };
    },

    emitLine(w, ent) {
        w.pair(0, 'LINE');
        w.pair(8, ent.layer);
        w.coord(10, ent.x1); w.coord(20, ent.y1); w.coord(30, 0);
        w.coord(11, ent.x2); w.coord(21, ent.y2); w.coord(31, 0);
    },

    emitCircle(w, ent) {
        w.pair(0, 'CIRCLE');
        w.pair(8, ent.layer);
        w.coord(10, ent.x); w.coord(20, ent.y); w.coord(30, 0);
        w.coord(40, ent.r);
    },

    emitArc(w, ent) {
        w.pair(0, 'ARC');
        w.pair(8, ent.layer);
        w.coord(10, ent.x); w.coord(20, ent.y); w.coord(30, 0);
        w.coord(40, ent.r);
        w.coord(50, ent.startAng);
        w.coord(51, ent.endAng);
    },

    emitLwPolyline(w, ent) {
        w.pair(0, 'LWPOLYLINE');
        w.pair(8, ent.layer);
        w.pair(90, ent.points.length);
        w.pair(70, ent.closed ? 1 : 0);
        ent.points.forEach(p => {
            w.coord(10, p.x);
            w.coord(20, p.y);
        });
    },

    emitLegacyPolyline(w, ent) {
        w.pair(0, 'POLYLINE');
        w.pair(8, ent.layer);
        w.pair(66, 1);
        w.pair(70, ent.closed ? 1 : 0);
        ent.points.forEach(p => {
            w.pair(0, 'VERTEX');
            w.pair(8, ent.layer);
            w.coord(10, p.x);
            w.coord(20, p.y);
            w.coord(30, 0);
        });
        w.pair(0, 'SEQEND');
        w.pair(8, ent.layer);
    },

    serialize(entities, bounds, legacy) {
        const w = this.writer();
        w.pair(0, 'SECTION');
        w.pair(2, 'HEADER');
        w.pair(9, '$ACADVER'); w.pair(1, 'AC1015');
        w.pair(9, '$INSUNITS'); w.pair(70, 4);
        w.pair(9, '$MEASUREMENT'); w.pair(70, 1);
        if (bounds && !bounds.empty) {
            w.pair(9, '$EXTMIN');
            w.coord(10, bounds.minX); w.coord(20, bounds.minY); w.coord(30, 0);
            w.pair(9, '$EXTMAX');
            w.coord(10, bounds.maxX); w.coord(20, bounds.maxY); w.coord(30, 0);
        }
        w.pair(0, 'ENDSEC');

        w.pair(0, 'SECTION');
        w.pair(2, 'TABLES');
        w.pair(0, 'TABLE');
        w.pair(2, 'LAYER');
        w.pair(70, this.LAYERS.length);
        this.LAYERS.forEach(layer => {
            w.pair(0, 'LAYER');
            w.pair(2, layer.name);
            w.pair(70, 0);
            w.pair(62, layer.color);
            w.pair(6, 'CONTINUOUS');
        });
        w.pair(0, 'ENDTAB');
        w.pair(0, 'ENDSEC');

        w.pair(0, 'SECTION');
        w.pair(2, 'ENTITIES');
        entities.forEach(ent => {
            if (ent.type === 'LINE') this.emitLine(w, ent);
            else if (ent.type === 'CIRCLE') this.emitCircle(w, ent);
            else if (ent.type === 'ARC') this.emitArc(w, ent);
            else if (ent.type === 'POLYLINE') {
                if (legacy) this.emitLegacyPolyline(w, ent);
                else this.emitLwPolyline(w, ent);
            }
        });
        w.pair(0, 'ENDSEC');
        w.pair(0, 'EOF');
        return w.toString();
    },

    countEntities(entities, legacy) {
        const summary = { LINE: 0, LWPOLYLINE: 0, POLYLINE: 0, VERTEX: 0, SEQEND: 0, CIRCLE: 0, ARC: 0 };
        entities.forEach(ent => {
            if (ent.type === 'LINE') summary.LINE++;
            else if (ent.type === 'CIRCLE') summary.CIRCLE++;
            else if (ent.type === 'ARC') summary.ARC++;
            else if (ent.type === 'POLYLINE') {
                if (legacy) {
                    summary.POLYLINE++;
                    summary.VERTEX += ent.points.length;
                    summary.SEQEND++;
                } else {
                    summary.LWPOLYLINE++;
                }
            }
        });
        return summary;
    },

    parse(text) {
        if (typeof text !== 'string' || !text.length) {
            return { ok: false, error: 'Empty DXF.' };
        }
        if (text.charCodeAt(0) === 0xFEFF) {
            return { ok: false, error: 'DXF must not start with a UTF-8 BOM.' };
        }
        const rawLines = text.split(/\r\n|\n|\r/);
        if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
        if (rawLines.length % 2 !== 0) {
            return { ok: false, error: 'DXF group codes and values are not paired.' };
        }
        const groups = [];
        for (let i = 0; i < rawLines.length; i += 2) {
            const code = parseInt(rawLines[i], 10);
            if (!isFinite(code)) return { ok: false, error: 'Invalid group code: ' + rawLines[i] };
            groups.push({ code, value: rawLines[i + 1] });
        }

        const header = {};
        const layers = [];
        const entities = [];
        const summary = { LINE: 0, LWPOLYLINE: 0, POLYLINE: 0, VERTEX: 0, SEQEND: 0, CIRCLE: 0, ARC: 0 };
        let section = null;
        let table = null;
        let i = 0;
        let sawEof = false;
        let currentPoly = null;

        const finishPoly = () => {
            if (currentPoly) {
                entities.push(currentPoly);
                currentPoly = null;
            }
        };

        const readEntity = (type, start) => {
            const ent = { type, layer: '0', closed: false, points: [], codes: [] };
            let j = start + 1;
            while (j < groups.length && groups[j].code !== 0) {
                const g = groups[j];
                ent.codes.push(g);
                if (g.code === 8) ent.layer = g.value;
                else if (g.code === 70) ent.flags = parseInt(g.value, 10);
                else if (g.code === 90) ent.nVerts = parseInt(g.value, 10);
                else if (g.code === 10) ent.x = parseFloat(g.value);
                else if (g.code === 20) ent.y = parseFloat(g.value);
                else if (g.code === 30) ent.z = parseFloat(g.value);
                else if (g.code === 11) ent.x2 = parseFloat(g.value);
                else if (g.code === 21) ent.y2 = parseFloat(g.value);
                else if (g.code === 31) ent.z2 = parseFloat(g.value);
                else if (g.code === 40) ent.r = parseFloat(g.value);
                else if (g.code === 41) ent.v41 = parseFloat(g.value);
                else if (g.code === 43) ent.v43 = parseFloat(g.value);
                else if (g.code === 50) ent.startAng = parseFloat(g.value);
                else if (g.code === 51) ent.endAng = parseFloat(g.value);
                j++;
            }
            if (type === 'LWPOLYLINE') {
                ent.closed = (ent.flags & 1) === 1;
                const pts = [];
                let x = null;
                ent.codes.forEach(g => {
                    if (g.code === 10) x = parseFloat(g.value);
                    else if (g.code === 20 && x != null) {
                        pts.push({ x, y: parseFloat(g.value) });
                        x = null;
                    }
                });
                ent.points = pts;
            }
            if (type === 'POLYLINE') {
                ent.closed = (ent.flags & 1) === 1;
            }
            return { ent, next: j };
        };

        while (i < groups.length) {
            const g = groups[i];
            if (g.code === 0 && g.value === 'EOF') {
                sawEof = true;
                if (i !== groups.length - 1) {
                    return { ok: false, error: 'Data found after EOF.' };
                }
                break;
            }
            if (g.code === 0 && g.value === 'SECTION') {
                const name = groups[i + 1];
                section = name && name.code === 2 ? name.value : null;
                i += 2;
                continue;
            }
            if (g.code === 0 && g.value === 'ENDSEC') {
                section = null;
                i++;
                continue;
            }
            if (section === 'HEADER' && g.code === 9) {
                const key = g.value;
                const v = groups[i + 1];
                if (v) header[key] = v.value;
                i += 2;
                continue;
            }
            if (section === 'TABLES' && g.code === 0 && g.value === 'TABLE') {
                const name = groups[i + 1];
                table = name && name.code === 2 ? name.value : null;
                i += 2;
                continue;
            }
            if (section === 'TABLES' && g.code === 0 && g.value === 'ENDTAB') {
                table = null;
                i++;
                continue;
            }
            if (section === 'TABLES' && table === 'LAYER' && g.code === 0 && g.value === 'LAYER') {
                const rec = readEntity('LAYER', i);
                let name = '0';
                rec.ent.codes.forEach(c => { if (c.code === 2) name = c.value; });
                layers.push(name);
                i = rec.next;
                continue;
            }
            if (section === 'ENTITIES' && g.code === 0) {
                const type = g.value;
                if (type === 'VERTEX') {
                    const rec = readEntity('VERTEX', i);
                    if (!currentPoly) return { ok: false, error: 'VERTEX without POLYLINE.' };
                    currentPoly.points.push({ x: rec.ent.x, y: rec.ent.y, z: rec.ent.z || 0 });
                    summary.VERTEX++;
                    i = rec.next;
                    continue;
                }
                if (type === 'SEQEND') {
                    summary.SEQEND++;
                    finishPoly();
                    i++;
                    while (i < groups.length && groups[i].code !== 0) i++;
                    continue;
                }
                finishPoly();
                if (type === 'LINE' || type === 'CIRCLE' || type === 'ARC' || type === 'LWPOLYLINE' || type === 'POLYLINE') {
                    const rec = readEntity(type, i);
                    if (type === 'POLYLINE') {
                        currentPoly = rec.ent;
                        summary.POLYLINE++;
                    } else {
                        entities.push(rec.ent);
                        summary[type]++;
                    }
                    i = rec.next;
                    continue;
                }
                if (type === 'HATCH' || type === 'SPLINE' || type === 'ELLIPSE' || type === 'INSERT' ||
                    type === '3DSOLID' || type === 'REGION' || type === '3DFACE') {
                    return { ok: false, error: 'Unsupported entity type: ' + type };
                }
                i++;
                continue;
            }
            i++;
        }
        finishPoly();
        if (!sawEof) return { ok: false, error: 'DXF is missing EOF.' };

        return { ok: true, header, layers, entities, summary, groups };
    },

    verifySerialized(dxf, expectedSummary, legacy) {
        const parsed = this.parse(dxf);
        if (!parsed.ok) return parsed;
        if (parsed.header.$ACADVER !== 'AC1015') {
            return { ok: false, error: 'DXF $ACADVER is not AC1015.' };
        }
        if (parsed.header.$INSUNITS !== '4') {
            return { ok: false, error: 'DXF $INSUNITS is not 4 (millimeters).' };
        }
        if (parsed.header.$MEASUREMENT !== '1') {
            return { ok: false, error: 'DXF $MEASUREMENT is not 1.' };
        }
        const forbidden = ['HATCH', 'SPLINE', 'ELLIPSE', 'INSERT', 'BLOCK', '3DSOLID', 'REGION', '1001'];
        for (let k = 0; k < forbidden.length; k++) {
            if (dxf.indexOf('\n' + forbidden[k] + '\r') !== -1 || dxf.indexOf('\n' + forbidden[k] + '\n') !== -1 ||
                dxf.split(this.NL).indexOf(forbidden[k]) !== -1) {
                if (forbidden[k] === 'BLOCK' && dxf.indexOf('BLOCKS') !== -1) {
                    return { ok: false, error: 'DXF contains BLOCKS section.' };
                }
                if (forbidden[k] !== 'BLOCK') {
                    return { ok: false, error: 'DXF contains forbidden construct: ' + forbidden[k] };
                }
            }
        }
        if (/[0-9]\.[0-9]+[eE][+-]?[0-9]+/.test(dxf)) {
            return { ok: false, error: 'DXF contains scientific notation.' };
        }
        if (legacy) {
            if (parsed.summary.LWPOLYLINE > 0) {
                return { ok: false, error: 'Legacy DXF must not contain LWPOLYLINE.' };
            }
        } else if (parsed.summary.POLYLINE > 0 || parsed.summary.VERTEX > 0) {
            return { ok: false, error: 'Standard DXF must not contain POLYLINE/VERTEX.' };
        }
        const keys = Object.keys(expectedSummary);
        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if ((parsed.summary[key] || 0) !== (expectedSummary[key] || 0)) {
                return {
                    ok: false,
                    error: 'Entity count mismatch for ' + key + ': expected ' +
                        (expectedSummary[key] || 0) + ', parsed ' + (parsed.summary[key] || 0)
                };
            }
        }
        parsed.entities.forEach(ent => {
            if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
                const hasWidth = (ent.codes || []).some(c => c.code === 40 || c.code === 41 || c.code === 43);
                if (hasWidth) {
                    parsed.ok = false;
                    parsed.error = 'Polyline on ' + ent.layer + ' encodes width (group 40/41/43).';
                }
            }
            const zs = [];
            if (ent.z != null) zs.push(ent.z);
            if (ent.z2 != null) zs.push(ent.z2);
            (ent.points || []).forEach(p => { if (p.z != null) zs.push(p.z); });
            if (ent.type === 'LINE') zs.push(ent.z || 0, ent.z2 || 0);
            zs.forEach(z => {
                if (Math.abs(z) > 1e-9) {
                    parsed.ok = false;
                    parsed.error = 'Non-zero Z on ' + ent.type + '.';
                }
            });
        });
        if (parsed.ok === false) return parsed;
        return parsed;
    },

    generateFromApp(app, exportApi, options) {
        const opts = options || {};
        try {
            exportApi.normalizeTraces(app);
            const mode = opts.mode || (app.export && app.export.dxfMode) || this.MODE_STANDARD;
            const legacy = mode === this.MODE_LEGACY || mode === 'legacy';

            const xf = this.buildTransform(exportApi, app);
            if (!xf.ok) return xf;

            const collected = this.collectEntities(app, exportApi, xf.toDxf);
            if (!collected.ok) return { ok: false, error: collected.error };

            const valErrs = this.validateEntities(collected.entities, app);
            if (valErrs.length) return { ok: false, error: valErrs.join('\n') };

            const bounds = this.computeBounds(collected.entities);
            const summary = this.countEntities(collected.entities, legacy);
            const dxf = this.serialize(collected.entities, bounds, legacy);
            const verified = this.verifySerialized(dxf, summary, legacy);
            if (!verified.ok) return { ok: false, error: verified.error };

            return {
                ok: true,
                dxf,
                mode: legacy ? this.MODE_LEGACY : this.MODE_STANDARD,
                summary,
                bounds,
                entities: collected.entities,
                parsed: verified
            };
        } catch (err) {
            return { ok: false, error: (err && err.message) ? err.message : String(err) };
        }
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Dxf;
}
