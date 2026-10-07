// ============================================================
// Export Module - SVG, DXF, and GRBL G-code for CNC / laser
// ============================================================
const Export = {
    // Data normalization: ensure segmentWidths and curved arrays
    // have the correct length (points.length - 1) before export.
    normalizeTraces(app) {
        app.traces.forEach(trace => {
            if (trace.schemWire) return; // logical wire — never physical copper in exports
            const expected = trace.points.length - 1;
            if (expected < 1) return;
            if (!trace.segmentWidths || trace.segmentWidths.length !== expected) {
                const old = trace.segmentWidths || [];
                const nw = new Array(expected).fill(trace.width);
                for (let i = 0; i < Math.min(old.length, expected); i++) {
                    if (old[i] !== undefined && old[i] > 0) nw[i] = old[i];
                }
                trace.segmentWidths = nw;
            }
            if (!trace.curved || trace.curved.length !== expected) {
                const old = trace.curved || [];
                const nc = new Array(expected).fill(false);
                for (let i = 0; i < Math.min(old.length, expected); i++) {
                    nc[i] = !!old[i];
                }
                trace.curved = nc;
            }
        });
    },

    // Is a named export layer (COPPER_TOP, TRACE_OUTLINE_BOTTOM, PAD_TOP, ...) included?
    // Explicit app.export.layers[name] wins; default: COPPER_TOP on, other top layers off, bottom follows view visibility.
    layerOn(app, name) {
        const layers = app.export && app.export.layers;
        if (layers && typeof layers[name] === 'boolean') return layers[name];
        if (name === 'COPPER_TOP') return true;
        if (name.indexOf('BOTTOM') !== -1) {
            const vl = app.view && app.view.visibleLayers;
            return !!(vl && vl.bottom);
        }
        return false;
    },

    // Copper side gate used for merged-copper contents and G-code bottom isolation.
    layerEnabled(app, side) {
        return this.layerOn(app, side === 'bottom' ? 'COPPER_BOTTOM' : 'COPPER_TOP');
    },

    // SVG preview visibility — view-based, independent of export layer selection.
    _traceLayerVisible(app, trace) {
        if (trace.layer === 'top') return !app.view || !app.view.visibleLayers || app.view.visibleLayers.top !== false;
        if (trace.layer === 'bottom') return !app.view || !app.view.visibleLayers || app.view.visibleLayers.bottom !== false;
        return true;
    },

    // DOM-free preview: render the DXF entities (per current export settings) as an SVG string.
    // Returns { svg, layers:[{name,color}], empty } or null when export validation fails.
    buildPreviewSVG(app) {
        const dxf = Dxf.generateFromApp(app, this);
        if (!dxf.ok) return null;
        const colors = {
            OUTLINE: '#ffffff',
            COPPER_TOP: '#2ecc71', COPPER_BOTTOM: '#3498db',
            TRACE_OUTLINE_TOP: '#a3e635', TRACE_OUTLINE_BOTTOM: '#7fb3d5',
            TRACE_TOP: '#f1c40f', TRACE_BOTTOM: '#f39c12',
            PAD_TOP: '#e67e22', PAD_BOTTOM: '#9b59b6',
            DRILL: '#e74c3c'
        };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const bounds = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        const entityPts = e => {
            if (e.type === 'LINE') return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
            if (e.type === 'CIRCLE' || e.type === 'ARC') return [{ x: e.x - e.r, y: e.y - e.r }, { x: e.x + e.r, y: e.y + e.r }];
            return e.points || [];
        };
        for (const e of dxf.entities) {
            if (!colors[e.layer]) continue;
            entityPts(e).forEach(p => bounds(p.x, p.y));
        }
        if (!isFinite(minX)) return { svg: '', layers: [], empty: true, bounds: null };
        const pad = 1; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        const w = maxX - minX, h = maxY - minY;
        const sw = Math.max(0.03, Math.min(w, h) * 0.004);
        const fy = y => (minY + maxY - y).toFixed(3); // flip Y for SVG
        let body = '';
        const present = [];
        for (const e of dxf.entities) {
            const c = colors[e.layer]; if (!c) continue;
            if (!present.includes(e.layer)) present.push(e.layer);
            if (e.type === 'CIRCLE') {
                body += `<circle cx="${e.x.toFixed(3)}" cy="${fy(e.y)}" r="${e.r.toFixed(3)}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
            } else if (e.type === 'ARC') {
                // approximate with full circle (reference only)
                body += `<circle cx="${e.x.toFixed(3)}" cy="${fy(e.y)}" r="${e.r.toFixed(3)}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-dasharray="${sw * 4} ${sw * 2}"/>`;
            } else if (e.type === 'LINE') {
                body += `<line x1="${e.x1.toFixed(3)}" y1="${fy(e.y1)}" x2="${e.x2.toFixed(3)}" y2="${fy(e.y2)}" stroke="${c}" stroke-width="${sw}"/>`;
            } else if (e.closed) {
                body += `<polygon points="${e.points.map(p => p.x.toFixed(3) + ',' + fy(p.y)).join(' ')}" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="${sw}"/>`;
            } else {
                // open centerlines: no fill
                body += `<polyline points="${e.points.map(p => p.x.toFixed(3) + ',' + fy(p.y)).join(' ')}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
            }
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(3)} ${minY.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
        return { svg, layers: present.map(name => ({ name, color: colors[name] })), empty: false, bounds: { x: minX, y: minY, w, h } };
    },

    boardOutlinePoints(app) {
        const bw = app.board.width, bh = app.board.height;
        if (app.boardOutline && app.boardOutline.length >= 3) {
            return app.boardOutline.map(p => ({ x: p.x, y: p.y }));
        }
        const x = -bw / 2, y = -bh / 2;
        return [
            { x, y }, { x: x + bw, y }, { x: x + bw, y: y + bh }, { x, y: y + bh }
        ];
    },

    minPinDistance(pins) {
        let minD = Infinity;
        for (let a = 0; a < pins.length; a++) {
            for (let b = a + 1; b < pins.length; b++) {
                const d = Math.hypot(pins[a].x - pins[b].x, pins[a].y - pins[b].y);
                if (d < minD) minD = d;
            }
        }
        return isFinite(minD) ? minD : 2.54;
    },

    // SMD land size (mm). 2-pad chips leave a ceramic gap; IC rows keep longer lands.
    smdPadWH(pin, minD, twoPad) {
        const along = Math.max(0.35, Math.min(minD * (twoPad ? 0.55 : 0.45), twoPad ? 1.4 : 1.6));
        const across = Math.max(0.45, Math.min(minD * (twoPad ? 0.42 : 1.05), twoPad ? 1.2 : 2.2));
        const onXEdge = Math.abs(pin.x) > Math.abs(pin.y);
        return { pw: onXEdge ? across : along, ph: onXEdge ? along : across };
    },

    // World-space copper pads for a placed component (KiCad geometry when present).
    padFeatures(app, comp) {
        const size = app.getCompSize(comp);
        if (!size) return [];
        const out = [];
        const kPads = size.kicad && size.kicad.pads;
        if (kPads && kPads.length) {
            kPads.forEach(pad => {
                const thru = pad.type === 'thru_hole';
                // TH square pads are KiCad pin-1 markers; mill them as round rings.
                const isRound = pad.shape === 'circle' || pad.shape === 'hole' ||
                    (thru && pad.shape !== 'oval' && !pad.drillOval) ||
                    (pad.shape === 'oval' && Math.abs(pad.w - pad.h) < 0.02);
                const center = this.rotatePoint({ x: pad.x, y: pad.y }, comp);
                if (isRound) {
                    out.push({
                        kind: 'circle', x: center.x, y: center.y,
                        r: Math.max(pad.w, pad.h) / 2,
                        drill: pad.drill || 0, drillOval: pad.drillOval || null,
                        thru: pad.type === 'thru_hole', layer: comp.layer
                    });
                } else {
                    const hw = pad.w / 2, hh = pad.h / 2;
                    const pr = (pad.rot || 0) * Math.PI / 180;
                    const c = Math.cos(pr), s = Math.sin(pr);
                    const local = [
                        { x: -hw, y: -hh }, { x: hw, y: -hh },
                        { x: hw, y: hh }, { x: -hw, y: hh }
                    ].map(p => ({
                        x: pad.x + p.x * c - p.y * s,
                        y: pad.y + p.x * s + p.y * c
                    }));
                    out.push({
                        kind: 'poly',
                        pts: local.map(p => this.rotatePoint(p, comp)),
                        drill: pad.drill || 0, drillOval: pad.drillOval || null,
                        thru: pad.type === 'thru_hole', layer: comp.layer,
                        cx: center.x, cy: center.y
                    });
                }
            });
            return out;
        }

        const pins = (comp.pins && comp.pins.length) ? comp.pins : (size.pins || []);
        const th = this.isTHForExport(size);
        const minD = this.minPinDistance(pins);
        pins.forEach(pin => {
            const wp = this.rotatePoint(pin, comp);
            if (th) {
                // size.padR / size.drillDia override the pitch-based defaults (e.g. TH TP XL).
                const pr = size.padR || Math.max(0.35, Math.min(1.0, minD * 0.4));
                out.push({
                    kind: 'circle', x: wp.x, y: wp.y, r: pr,
                    drill: (size.drillDia != null) ? size.drillDia : pr * 0.8, thru: true, layer: comp.layer
                });
            } else {
                const twoPad = pins.length === 2;
                const dim = this.smdPadWH(pin, minD, twoPad);
                const pw = dim.pw, ph = dim.ph;
                const local = [
                    { x: pin.x - pw / 2, y: pin.y - ph / 2 },
                    { x: pin.x + pw / 2, y: pin.y - ph / 2 },
                    { x: pin.x + pw / 2, y: pin.y + ph / 2 },
                    { x: pin.x - pw / 2, y: pin.y + ph / 2 }
                ];
                out.push({
                    kind: 'poly', pts: local.map(p => this.rotatePoint(p, comp)),
                    drill: 0, thru: false, layer: comp.layer, cx: wp.x, cy: wp.y
                });
            }
        });
        return out;
    },

    collectCopperOutlines(app) {
        const items = [];
        if (app.export.includeTraces) {
            app.traces.forEach(trace => {
                if (trace.schemWire) return; // logical wire — not copper outline
                const layer = trace.layer === 'bottom' ? 'bottom' : 'top';
                if (!this.layerEnabled(app, layer)) return;
                this.generateTraceOutline(app, trace).forEach(pts => {
                    if (pts && pts.length >= 3) items.push({ layer, kind: 'poly', pts });
                });
            });
        }
        if (app.export.includeComps) {
            app.components.forEach(comp => {
                const layer = comp.layer === 'bottom' ? 'bottom' : 'top';
                if (!this.layerEnabled(app, layer)) return;
                this.padFeatures(app, comp).forEach(pad => {
                    if (pad.kind === 'circle') {
                        items.push({ layer, kind: 'circle', x: pad.x, y: pad.y, r: pad.r });
                    } else if (pad.pts && pad.pts.length >= 3) {
                        items.push({ layer, kind: 'poly', pts: pad.pts });
                    }
                });
            });
        }
        app.vias.forEach(via => {
            const r = (via.diameter / 2) + 0.5;
            if (this.layerEnabled(app, 'top')) items.push({ layer: 'top', kind: 'circle', x: via.x, y: via.y, r });
            if (this.layerEnabled(app, 'bottom')) items.push({ layer: 'bottom', kind: 'circle', x: via.x, y: via.y, r });
        });
        return items;
    },

    collectDrills(app) {
        const holes = [];
        if (!app.export.includeHoles) return holes;
        app.vias.forEach(via => {
            const drill = via.drill || (via.diameter * 0.5);
            holes.push({ x: via.x, y: via.y, r: Math.max(0.05, drill / 2) });
        });
        if (app.export.includeComps) {
            app.components.forEach(comp => {
                this.padFeatures(app, comp).forEach(pad => {
                    if (pad.drillOval && pad.drillOval.w && pad.drillOval.h) {
                        holes.push({
                            x: pad.x != null ? pad.x : pad.cx,
                            y: pad.y != null ? pad.y : pad.cy,
                            oval: true, w: pad.drillOval.w, h: pad.drillOval.h
                        });
                    } else if (pad.thru && pad.drill > 0) {
                        holes.push({
                            x: pad.x != null ? pad.x : pad.cx,
                            y: pad.y != null ? pad.y : pad.cy,
                            r: pad.drill / 2
                        });
                    } else if (pad.thru && pad.kind === 'circle') {
                        holes.push({ x: pad.x, y: pad.y, r: pad.r * 0.7 });
                    }
                });
            });
        }
        return holes;
    },

    collectTraceCenterlines(app) {
        const segs = [];
        if (!app.export.includeTraces) return segs;
        app.traces.forEach(trace => {
            if (trace.schemWire) return; // logical wire — not a copper centerline
            if (!this._traceLayerVisible(app, trace)) return;
            const layer = trace.layer === 'bottom' ? 'bottom' : 'top';
            for (let i = 0; i < trace.points.length - 1; i++) {
                const p0 = trace.points[i], p1 = trace.points[i + 1];
                const w = this._segmentWidth(app, trace, i);
                if (trace.curved && trace.curved[i]) {
                    segs.push({
                        layer, width: w,
                        pts: this.sampleQuadraticBezier(p0, p1, this.curveSegments(p0, p1))
                    });
                } else {
                    segs.push({ layer, width: w, pts: [p0, p1] });
                }
            }
        });
        return segs;
    },

    // Browser-facing wrapper: build SVG text and trigger a download.
    exportSVG(app) {
        const svg = this.buildSVG(app);
        this.download(svg, 'pcb-export.svg', 'image/svg+xml');
    },

    // DOM-free SVG builder. Returns the full SVG document as a string.
    // Used by Export.exportSVG in the browser and by the headless kernel (MCP).
    buildSVG(app) {
        this.normalizeTraces(app);
        const bw = app.board.width, bh = app.board.height;
        const kerf = app.export.kerfWidth;
        const margin = 5;
        const minX = -bw / 2 - margin, minY = -bh / 2 - margin;
        const width = bw + margin * 2, height = bh + margin * 2;

        let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="${minX} ${minY} ${width} ${height}">\n`;
        svg += `  <!-- PCB: ${app.board.material} ${bw}x${bh}x${app.board.thickness}mm, Cu:${app.board.copperWeight}oz, Kerf:${kerf}mm -->\n`;
        svg += `  <defs><style>\n`;
        svg += `    .outline{fill:none;stroke:#000;stroke-width:${kerf};}\n`;
        svg += `    .trace-top{fill:none;stroke:#000;stroke-linecap:round;stroke-linejoin:round;}\n`;
        svg += `    .trace-bottom{fill:none;stroke:#000;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:2,1;}\n`;
        svg += `    .via{fill:none;stroke:#000;}\n`;
        svg += `    .comp-body{fill:none;stroke:#000;stroke-width:0.3;}\n`;
        svg += `    .comp-pin{fill:none;stroke:#000;stroke-width:0.2;}\n`;
        svg += `    .label{font-size:1.5mm;fill:#000;font-family:monospace;}\n`;
        svg += `  </style></defs>\n\n`;

        if (app.export.includeBoardOutline !== false && app.view.visibleLayers.outline) {
            svg += `  <!-- CUT PATH -->\n`;
            const outline = this.boardOutlinePoints(app);
            const pts = outline.map(p => `${p.x},${p.y}`).join(' ');
            svg += `  <polygon points="${pts}" class="outline" id="board-outline"/>\n`;
        }

        if (app.export.includeTraces) {
            svg += `  <!-- TRACES -->\n`;
            this.collectTraceCenterlines(app).forEach(seg => {
                const cls = seg.layer === 'top' ? 'trace-top' : 'trace-bottom';
                const sw = seg.width + kerf;
                if (seg.pts.length === 2) {
                    const p0 = seg.pts[0], p1 = seg.pts[1];
                    svg += `  <line x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}" class="${cls}" stroke-width="${sw}"/>\n`;
                } else {
                    const d = seg.pts.map((p, i) => (i ? 'L' : 'M') + ` ${p.x} ${p.y}`).join(' ');
                    svg += `  <path d="${d}" class="${cls}" stroke-width="${sw}"/>\n`;
                }
            });
        }

        if (app.export.includeHoles) {
            svg += `\n  <!-- HOLES -->\n`;
            this.collectDrills(app).forEach(h => {
                if (h.oval) {
                    svg += `  <ellipse cx="${h.x}" cy="${h.y}" rx="${h.w / 2}" ry="${h.h / 2}" class="via" stroke-width="0.3"/>\n`;
                } else {
                    svg += `  <circle cx="${h.x}" cy="${h.y}" r="${h.r}" class="via" stroke-width="0.3"/>\n`;
                }
            });
        }

        if (app.export.includeComps) {
            svg += `\n  <!-- COMPONENTS -->\n`;
                app.components.forEach(comp => {
                const size = app.getCompSize(comp);
                if (!size) return;
                app.ensureCompSilkLayout(comp);
                const hw = size.width / 2, hh = size.height / 2;
                const corners = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }].map(c => this.rotatePoint(c, comp));
                const pts = corners.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');
                svg += `  <g id="comp-${comp.id}" data-type="${comp.type}" data-value="${comp.value}" data-size="${size.name}">\n`;
                svg += `    <polygon points="${pts}" class="comp-body"/>\n`;
                this.padFeatures(app, comp).forEach(pad => {
                    if (pad.kind === 'circle') {
                        svg += `    <circle cx="${pad.x.toFixed(3)}" cy="${pad.y.toFixed(3)}" r="${pad.r.toFixed(3)}" class="comp-pin"/>\n`;
                    } else {
                        const pp = pad.pts.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');
                        svg += `    <polygon points="${pp}" class="comp-pin"/>\n`;
                    }
                });
                const silkTextEl = (pos, text) => {
                    // World anchor already includes component rotation; rotate about it by
                    // part rotation + per-field offset so the export matches the board view.
                    const wp = this.rotatePoint(pos, comp);
                    const ffs = app.compSilkEffectiveFontSize(pos, size);
                    const rot = ((comp.rotation || 0) + (pos.rotation || 0)) % 360;
                    const tf = rot !== 0 ? ` transform="rotate(${rot} ${wp.x.toFixed(2)} ${wp.y.toFixed(2)})"` : '';
                    return `    <text x="${wp.x.toFixed(2)}" y="${wp.y.toFixed(2)}" class="label" style="font-size:${ffs.toFixed(2)}mm" text-anchor="middle"${tf}>${text}</text>\n`;
                };
                if (comp.label) svg += silkTextEl(comp.silkLabel, comp.label);
                if (comp.value) svg += silkTextEl(comp.silkValue, comp.value);
                svg += `  </g>\n`;
            });
        }

        svg += `</svg>\n`;
        return svg;
    },

    exportDXF(app) {
        const result = Dxf.generateFromApp(app, this);
        if (!result.ok) {
            alert('DXF export failed:\n\n' + result.error);
            return;
        }
        this.download(result.dxf, 'pcb-export.dxf', 'application/dxf');
        if (typeof app.setStatus === 'function') {
            const s = result.summary || {};
            const poly = result.mode === 'legacy' ? (s.POLYLINE || 0) : (s.LWPOLYLINE || 0);
            app.setStatus('DXF: ' + (s.LINE || 0) + ' LINE, ' + poly + ' poly, ' + (s.CIRCLE || 0) + ' CIRCLE');
        }
    },

    // GRBL-flavour G-code: isolation mill, drill, then board cut.
    exportGCode(app) {
        const result = GCode.generateFromApp(app, this);
        if (!result.ok) {
            alert('G-code export failed:\n\n' + result.error);
            return;
        }
        this.download(result.gcode, 'pcb-mill.gcode', 'text/plain');
    },

    // Offset a closed polygon outward by `dist` (mitered). World Y-down coords.
    offsetPolygon(pts, dist) {
        if (!pts || pts.length < 3) return pts ? pts.slice() : [];
        const n = pts.length;
        let area = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        const sign = area >= 0 ? 1 : -1;
        const out = [];
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
            const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y;
            const dx2 = next.x - cur.x, dy2 = next.y - cur.y;
            const l1 = Math.hypot(dx1, dy1) || 1;
            const l2 = Math.hypot(dx2, dy2) || 1;
            const n1x = sign * dy1 / l1, n1y = -sign * dx1 / l1;
            const n2x = sign * dy2 / l2, n2y = -sign * dx2 / l2;
            let nx = n1x + n2x, ny = n1y + n2y;
            const nl = Math.hypot(nx, ny) || 1;
            nx /= nl; ny /= nl;
            const dot = Math.max(0.2, Math.min(1, n1x * nx + n1y * ny));
            const miter = Math.min(Math.abs(dist) * 4, dist / dot);
            out.push({ x: cur.x + nx * miter, y: cur.y + ny * miter });
        }
        return out;
    },

    // World Y-down → Cartesian Y-up. Shared by DXF and G-code.
    flipY(p) {
        return { x: p.x, y: -p.y };
    },

    _segmentWidth(app, trace, i) {
        if (app && typeof app.getSegmentWidth === 'function') return app.getSegmentWidth(trace, i);
        if (trace.segmentWidths && trace.segmentWidths[i] !== undefined) return trace.segmentWidths[i];
        return trace.width;
    },

    // ============================================================
    // Curve helpers — must match board-view.js rendering exactly
    // ============================================================
    quadControlPoint(p0, p1) {
        const mx = (p0.x + p1.x) / 2;
        const my = (p0.y + p1.y) / 2;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) return { x: mx, y: my };
        const offAmt = len * 0.3;
        return { x: mx - (dy / len) * offAmt, y: my + (dx / len) * offAmt };
    },

    curveSegments(p0, p1) {
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const approxArcLen = len * 1.3;
        const spacing = 0.5;
        return Math.max(8, Math.min(64, Math.ceil(approxArcLen / spacing)));
    },

    sampleQuadraticBezier(p0, p1, segments) {
        const pts = [];
        const c = this.quadControlPoint(p0, p1);
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const it = 1 - t;
            pts.push({
                x: it * it * p0.x + 2 * it * t * c.x + t * t * p1.x,
                y: it * it * p0.y + 2 * it * t * c.y + t * t * p1.y
            });
        }
        return pts;
    },

    _leftNormal(p0, p1) {
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: -dy / len, y: dx / len, dx: dx / len, dy: dy / len, len };
    },

    _offsetPt(p, n, s) {
        return { x: p.x + n.x * s, y: p.y + n.y * s };
    },

    // Intersection of infinite lines p + t*d and q + s*e.
    _lineIntersect(p, d, q, e) {
        const cross = d.x * e.y - d.y * e.x;
        if (Math.abs(cross) < 1e-10) return null;
        const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / cross;
        return { x: p.x + t * d.x, y: p.y + t * d.y };
    },

    // Semicircle clockwise from the right offset (fromRight) or from the left.
    // Start cap: fromRight=true  (right -> back -> left).
    // End cap:   fromRight=false (left -> forward -> right).
    _halfCap(center, n, hw, fromRight) {
        const rx = fromRight ? -n.x : n.x;
        const ry = fromRight ? -n.y : n.y;
        const pts = [];
        const steps = 8;
        for (let i = 0; i <= steps; i++) {
            const ang = -Math.PI * i / steps;
            const c = Math.cos(ang), s = Math.sin(ang);
            pts.push({
                x: center.x + (rx * c - ry * s) * hw,
                y: center.y + (rx * s + ry * c) * hw
            });
        }
        return pts;
    },

    _dedupePoly(pts) {
        const cleaned = [];
        for (let i = 0; i < pts.length; i++) {
            if (cleaned.length === 0) { cleaned.push(pts[i]); continue; }
            const prev = cleaned[cleaned.length - 1];
            const dx = pts[i].x - prev.x, dy = pts[i].y - prev.y;
            if (dx * dx + dy * dy > 1e-8) cleaned.push(pts[i]);
        }
        if (cleaned.length > 2) {
            const f = cleaned[0], l = cleaned[cleaned.length - 1];
            if ((l.x - f.x) ** 2 + (l.y - f.y) ** 2 < 1e-8) cleaned.pop();
        }
        return cleaned;
    },

    // Closed copper boundary for one trace: parallel offsets +/- width/2.
    // This is the isolation mill path on COPPER_OUTLINE_*.
    generateTraceOutline(app, trace) {
        const pts = trace.points;
        const n = pts.length;
        if (n < 2) return [];

        const flatStart = this._endpointAtPin(app, pts[0], trace.width);
        const flatEnd = this._endpointAtPin(app, pts[n - 1], trace.width);
        const curved = trace.curved || new Array(n - 1).fill(false);
        const spine = [];
        const hwAt = [];
        const MIN_HW = 0.05;

        const pushSpine = (p, w) => {
            if (spine.length) {
                const prev = spine[spine.length - 1];
                if ((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2 < 1e-10) return;
            }
            spine.push({ x: p.x, y: p.y });
            hwAt.push(Math.max(w / 2, MIN_HW));
        };

        for (let i = 0; i < n - 1; i++) {
            const w = this._segmentWidth(app, trace, i);
            if (curved[i]) {
                const samples = this.sampleQuadraticBezier(pts[i], pts[i + 1], this.curveSegments(pts[i], pts[i + 1]));
                for (let j = 0; j < samples.length; j++) pushSpine(samples[j], w);
            } else {
                pushSpine(pts[i], w);
            }
        }
        pushSpine(pts[n - 1], this._segmentWidth(app, trace, n - 2));
        if (spine.length < 2) return [];

        const m = spine.length;
        const left = [];
        const right = [];
        const MITER_LIMIT = 4;

        for (let i = 0; i < m; i++) {
            if (i === 0) {
                const N = this._leftNormal(spine[0], spine[1]);
                const hw = hwAt[0];
                left.push(this._offsetPt(spine[0], N, hw));
                right.push(this._offsetPt(spine[0], N, -hw));
                continue;
            }
            if (i === m - 1) {
                const N = this._leftNormal(spine[m - 2], spine[m - 1]);
                const hw = hwAt[m - 2];
                left.push(this._offsetPt(spine[m - 1], N, hw));
                right.push(this._offsetPt(spine[m - 1], N, -hw));
                continue;
            }
            const n1 = this._leftNormal(spine[i - 1], spine[i]);
            const n2 = this._leftNormal(spine[i], spine[i + 1]);
            const hw1 = hwAt[i - 1], hw2 = hwAt[i];
            const joinSide = (sign, arr) => {
                const a0 = this._offsetPt(spine[i - 1], n1, sign * hw1);
                const a1 = this._offsetPt(spine[i], n1, sign * hw1);
                const b0 = this._offsetPt(spine[i], n2, sign * hw2);
                const hit = this._lineIntersect(a0, { x: n1.dx, y: n1.dy }, b0, { x: n2.dx, y: n2.dy });
                if (hit) {
                    const d = Math.hypot(hit.x - spine[i].x, hit.y - spine[i].y);
                    if (d <= Math.max(hw1, hw2) * MITER_LIMIT) {
                        arr.push(hit);
                        return;
                    }
                }
                arr.push(a1);
                arr.push(b0);
            };
            joinSide(1, left);
            joinSide(-1, right);
        }

        const outline = [];
        const nStart = this._leftNormal(spine[0], spine[1]);
        const nEnd = this._leftNormal(spine[m - 2], spine[m - 1]);

        if (flatStart) {
            outline.push(right[0], left[0]);
        } else {
            outline.push(...this._halfCap(spine[0], nStart, hwAt[0], true));
        }
        for (let i = 1; i < left.length; i++) outline.push(left[i]);
        if (flatEnd) {
            outline.push(left[left.length - 1], right[right.length - 1]);
        } else {
            outline.push(...this._halfCap(spine[m - 1], nEnd, hwAt[m - 2], false));
        }
        for (let i = right.length - 2; i >= 1; i--) outline.push(right[i]);

        const cleaned = this._dedupePoly(outline);
        return cleaned.length >= 3 ? [cleaned] : [];
    },

    _endpointAtPin(app, pt, traceWidth) {
        const tol = 1.2 + (traceWidth || 0.4) / 2;
        const tolSq = tol * tol;
        for (const comp of app.components) {
            const pins = (app.getCompPins && app.getCompPins(comp)) || comp.pins || [];
            for (const pin of pins) {
                const wp = this.rotatePoint(pin, comp);
                const dx = wp.x - pt.x, dy = wp.y - pt.y;
                if (dx * dx + dy * dy < tolSq) return true;
            }
        }
        return false;
    },

    isTHForExport(size) {
        if (!size) return false;
        if (size.th) return true;
        if (!size.name) return false;
        const n = size.name.toUpperCase();
        if (n.startsWith('TH')) return true;
        if (n.includes('(TH)')) return true;
        if (n.startsWith('TO-')) return true;
        if (n.startsWith('DIP')) return true;
        if (n.startsWith('HEADER')) return true;
        return false;
    },

    rotatePoint(pt, comp) {
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return { x: comp.x + pt.x * cos - pt.y * sin, y: comp.y + pt.x * sin + pt.y * cos };
    },

    download(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    circleToPolygon(cx, cy, r, sides) {
        if (sides == null) sides = 64;
        const pts = [];
        for (let i = 0; i < sides; i++) {
            const a = (2 * Math.PI * i) / sides;
            pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        return pts;
    },

    _segmentIntersection(a, b, c, d) {
        const dx1 = b.x - a.x, dy1 = b.y - a.y;
        const dx2 = d.x - c.x, dy2 = d.y - c.y;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) < 1e-14) return null; // parallel — handled by _collinearSplitPoints
        const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
        const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
        // Proper crossing: both parameters strictly interior
        if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) {
            return { x: a.x + t * dx1, y: a.y + t * dy1 };
        }
        // T-junctions: endpoint of one segment on interior of the other
        if (t > 1e-9 && t < 1 - 1e-9) {
            if (Math.abs(u) < 1e-9 || Math.abs(u - 1) < 1e-9) {
                return { x: a.x + t * dx1, y: a.y + t * dy1 };
            }
        }
        if (u > 1e-9 && u < 1 - 1e-9) {
            if (Math.abs(t) < 1e-9 || Math.abs(t - 1) < 1e-9) {
                return { x: a.x + t * dx1, y: a.y + t * dy1 };
            }
        }
        return null;
    },

    _collinearSplitPoints(a, b, c, d) {
        // Returns { pts1: [...], pts2: [...] } split points for collinear overlapping segments
        const dx1 = b.x - a.x, dy1 = b.y - a.y;
        const dx2 = d.x - c.x, dy2 = d.y - c.y;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) > 1e-14) return null; // Not parallel
        const len1 = Math.hypot(dx1, dy1);
        if (len1 < 1e-14) return null;
        // Check collinearity: perpendicular distance from c to line ab
        const cross = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / len1;
        if (Math.abs(cross) > 1e-10) return null; // Not collinear
        // Project onto the line direction (unit vector along ab)
        const ux = dx1 / len1, uy = dy1 / len1;
        const t2a = (c.x - a.x) * ux + (c.y - a.y) * uy;
        const t2b = (d.x - a.x) * ux + (d.y - a.y) * uy;
        const min1 = 0, max1 = len1;
        const min2 = Math.min(t2a, t2b), max2 = Math.max(t2a, t2b);
        const lo = Math.max(min1, min2), hi = Math.min(max1, max2);
        if (lo >= hi - 1e-10) return null; // No overlap
        const toPt = t => ({ x: a.x + t * ux, y: a.y + t * uy });
        const EPS = 1e-10;
        const pts1 = [], pts2 = [];
        if (lo > min1 + EPS && lo < max1 - EPS) pts1.push(toPt(lo));
        if (hi > min1 + EPS && hi < max1 - EPS) pts1.push(toPt(hi));
        if (lo > min2 + EPS && lo < max2 - EPS) pts2.push(toPt(lo));
        if (hi > min2 + EPS && hi < max2 - EPS) pts2.push(toPt(hi));
        if (!pts1.length && !pts2.length) return null;
        return { pts1, pts2 };
    },

    _pointInPolygon(pt, poly) {
        const n = poly.length;
        // Boundary check: if point is on any edge, it's NOT strictly inside
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (pt.x < Math.min(xi, xj) - 1e-9 || pt.x > Math.max(xi, xj) + 1e-9) continue;
            if (pt.y < Math.min(yi, yj) - 1e-9 || pt.y > Math.max(yi, yj) + 1e-9) continue;
            const dx = xj - xi, dy = yj - yi;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-20) {
                const ddx = pt.x - xi, ddy = pt.y - yi;
                if (ddx * ddx + ddy * ddy < 1e-18) return false; // on vertex → not strictly inside
            } else {
                let t = ((pt.x - xi) * dx + (pt.y - yi) * dy) / len2;
                if (t < 0 || t > 1) continue;
                const px = xi + t * dx, py = yi + t * dy;
                const ddx = pt.x - px, ddy = pt.y - py;
                if (ddx * ddx + ddy * ddy < 1e-18) return false; // on edge → not strictly inside
            }
        }
        // Standard ray-casting for interior test
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (((yi > pt.y) !== (yj > pt.y)) &&
                (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    },

    /**
     * Returns true if point is strictly inside poly, or on poly's boundary
     * (for coincident-edge tiebreaking in union).
     */
    _pointInPolygonOrOn(pt, poly) {
        // Strict interior test first
        let inside = false;
        const n = poly.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (((yi > pt.y) !== (yj > pt.y)) &&
                (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        if (inside) return true;
        // Check if on boundary (for coincident edge handling)
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (pt.x < Math.min(xi, xj) - 1e-9 || pt.x > Math.max(xi, xj) + 1e-9) continue;
            if (pt.y < Math.min(yi, yj) - 1e-9 || pt.y > Math.max(yi, yj) + 1e-9) continue;
            const dx = xj - xi, dy = yj - yi;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-20) {
                const ddx = pt.x - xi, ddy = pt.y - yi;
                if (ddx * ddx + ddy * ddy < 1e-18) return true;
            } else {
                let t = ((pt.x - xi) * dx + (pt.y - yi) * dy) / len2;
                if (t < 0 || t > 1) continue;
                const px = xi + t * dx, py = yi + t * dy;
                const ddx = pt.x - px, ddy = pt.y - py;
                if (ddx * ddx + ddy * ddy < 1e-18) return true;
            }
        }
        return false;
    },

    _chainBoundaryLoops(edges) {
        const key = p => p.x.toFixed(9) + ',' + p.y.toFixed(9);
        const adj = {};
        edges.forEach((e, i) => {
            const ka = key(e.a), kb = key(e.b);
            if (!adj[ka]) adj[ka] = [];
            if (!adj[kb]) adj[kb] = [];
            adj[ka].push(i);
            adj[kb].push(i);
        });
        const used = new Array(edges.length).fill(false);
        const loops = [];
        for (let start = 0; start < edges.length; start++) {
            if (used[start]) continue;
            const loopPts = [edges[start].a, edges[start].b];
            used[start] = true;
            let curPt = edges[start].b;
            for (;;) {
                const ck = key(curPt);
                const candidates = adj[ck] || [];
                let nextIdx = -1;
                for (const ci of candidates) {
                    if (!used[ci]) { nextIdx = ci; break; }
                }
                if (nextIdx === -1) break;
                used[nextIdx] = true;
                const e = edges[nextIdx];
                let nextPt;
                if (key(e.a) === ck) { nextPt = e.b; } else { nextPt = e.a; }
                if (key(nextPt) === key(loopPts[0])) break;
                loopPts.push(nextPt);
                curPt = nextPt;
            }
            if (loopPts.length >= 3) loops.push(loopPts);
        }
        return loops;
    },

    unionCopperIslands(app, side) {
        if (side === 'bottom' && !this.layerEnabled(app, 'bottom')) {
            return [];
        }
        const items = this.collectCopperOutlines(app).filter(it => it.layer === side);
        if (!items.length) return [];

        const polys = [];
        items.forEach(item => {
            if (item.kind === 'circle') {
                polys.push(this.circleToPolygon(item.x, item.y, item.r, 64));
            } else if (item.pts && item.pts.length >= 3) {
                polys.push(item.pts.slice());
            }
        });
        if (!polys.length) return [];

        const edges = [];
        polys.forEach((poly, pi) => {
            for (let i = 0; i < poly.length; i++) {
                const j = (i + 1) % poly.length;
                edges.push({ a: poly[i], b: poly[j], polyIdx: pi });
            }
        });

        const splitPoints = edges.map(() => []);
        for (let i = 0; i < edges.length; i++) {
            for (let j = i + 1; j < edges.length; j++) {
                if (edges[i].polyIdx === edges[j].polyIdx) continue;
                const pt = this._segmentIntersection(edges[i].a, edges[i].b, edges[j].a, edges[j].b);
                if (pt) {
                    splitPoints[i].push(pt);
                    splitPoints[j].push(pt);
                }
                const col = this._collinearSplitPoints(edges[i].a, edges[i].b, edges[j].a, edges[j].b);
                if (col) {
                    for (const p of col.pts1) splitPoints[i].push(p);
                    for (const p of col.pts2) splitPoints[j].push(p);
                }
            }
        }

        const EPS = 1e-9;
        const subEdges = [];
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (splitPoints[i].length) {
                const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
                splitPoints[i].sort((p1, p2) => {
                    const t1 = (p1.x - e.a.x) * dx + (p1.y - e.a.y) * dy;
                    const t2 = (p2.x - e.a.x) * dx + (p2.y - e.a.y) * dy;
                    return t1 - t2;
                });
                // Deduplicate: remove points closer than 1e-8 to previous
                const deduped = [splitPoints[i][0]];
                for (let k = 1; k < splitPoints[i].length; k++) {
                    const prev = deduped[deduped.length - 1];
                    const cur = splitPoints[i][k];
                    const ddx = cur.x - prev.x, ddy = cur.y - prev.y;
                    if (ddx * ddx + ddy * ddy > 1e-16) deduped.push(cur);
                }
                splitPoints[i] = deduped;
            }
            const pts = [e.a, ...splitPoints[i], e.b];
            for (let k = 0; k < pts.length - 1; k++) {
                const a = pts[k], b = pts[k + 1];
                if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) > EPS * EPS) {
                    subEdges.push({ a, b, polyIdx: e.polyIdx });
                }
            }
        }

        const boundaryEdges = [];
        for (const se of subEdges) {
            const mid = { x: (se.a.x + se.b.x) / 2, y: (se.a.y + se.b.y) / 2 };
            let coveredByOther = false;
            for (let pi = 0; pi < polys.length; pi++) {
                if (pi === se.polyIdx) continue;
                if (this._pointInPolygon(mid, polys[pi])) {
                    // Strictly inside → always covered
                    coveredByOther = true;
                    break;
                }
                if (pi < se.polyIdx && this._pointInPolygonOrOn(mid, polys[pi])) {
                    // On boundary of lower-index polygon → covered (tiebreak for coincident edges)
                    coveredByOther = true;
                    break;
                }
            }
            if (!coveredByOther) boundaryEdges.push(se);
        }

        return this._chainBoundaryLoops(boundaryEdges);
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Export;
}
