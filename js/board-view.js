// ============================================================
// Board View - Canvas Rendering
// ============================================================
const BoardView = {
    render(app) {
        const ctx = app.boardCtx;
        const canvas = app.boardCanvas;
        const w = canvas.width, h = canvas.height;

        // Clear
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        try {
        // Apply transform: center + pan + zoom
        ctx.translate(w / 2, h / 2);
        ctx.scale(app.view.zoom, app.view.zoom);
        ctx.translate(-app.view.panX, -app.view.panY);

        const bw = app.board.width, bh = app.board.height;

        // Draw board substrate
        if (app.view.visibleLayers.outline) {
            this.drawBoard(ctx, app, -bw / 2, -bh / 2, bw, bh);
        }

        // Draw grid
        this.drawGrid(ctx, app, -bw / 2, -bh / 2, bw, bh);

        // Draw traces. Logical schematic wires stay visible as dashed lines
        // unless copper still joins the same two pins.
        if (app.view.visibleLayers.top || app.view.visibleLayers.bottom) {
            app.traces.forEach(trace => {
                if (trace.layer === 'top' && !app.view.visibleLayers.top) return;
                if (trace.layer === 'bottom' && !app.view.visibleLayers.bottom) return;
                if (trace.schemWire) {
                    const pair = app._tracePinPair && app._tracePinPair(trace);
                    const copperOnPins = pair && app._copperConnectsPins && app._copperConnectsPins(pair);
                    if (!copperOnPins) this.drawSchemWire(ctx, app, trace);
                } else this.drawTrace(ctx, app, trace);
            });
            this.drawCopperJunctions(ctx, app);
        }

        // Draw current trace being drawn
        if (app.interaction.tracePoints.length > 0) {
            this.drawActiveTrace(ctx, app);
        }

        // Wire-jumper placement ghost (two-click span definition).
        if (app.interaction.placingComponent === 'jumper' && app.interaction.placingJumperKind === 'wire') {
            this.drawJumperGhost(ctx, app);
        }

        // Draw components (copper layer)
        if (app.view.visibleLayers.top || app.view.visibleLayers.bottom) {
            app.components.forEach(comp => {
                const compLayer = comp.layer || 'top';
                if (compLayer === 'top' && !app.view.visibleLayers.top) return;
                if (compLayer === 'bottom' && !app.view.visibleLayers.bottom) return;
                this.drawComponent(ctx, app, comp);
            });
        }

        // Draw silk screen annotations (text, outlines of components)
        if (app.view.visibleLayers.silkTop || app.view.visibleLayers.silkBottom) {
            app.components.forEach(comp => {
                const compLayer = comp.layer || 'top';
                if (compLayer === 'top' && !app.view.visibleLayers.silkTop) return;
                if (compLayer === 'bottom' && !app.view.visibleLayers.silkBottom) return;
                this.drawSilkComponent(ctx, app, comp);
            });
            // Draw silk text objects
            (app.silkTexts || []).forEach(txt => {
                if (txt.layer === 'silkTop' && !app.view.visibleLayers.silkTop) return;
                if (txt.layer === 'silkBottom' && !app.view.visibleLayers.silkBottom) return;
                this.drawSilkText(ctx, app, txt);
            });
        }

        // Draw vias
        app.vias.forEach(via => this.drawVia(ctx, app, via));

        // Draw plan placement zones (guided-workflow overlay)
        if ((app.zones || []).length) {
            this.drawZones(ctx, app);
        }

        // Live rectangle preview while dragging a new zone.
        if (app.interaction.zoneDrag) {
            this.drawZoneDragPreview(ctx, app);
        }

        // Draw board outline
        if ((app.boardOutline || []).length >= 3 && app.view.visibleLayers.outline) {
            this.drawOutline(ctx, app, app.boardOutline);
        }

        // Draw active outline being drawn
        if ((app.interaction.outlinePoints || []).length > 0) {
            this.drawActiveOutline(ctx, app);
        }

        // Draw selection highlight
        if (app.interaction.selectedObject) {
            this.drawSelection(ctx, app);
        }

        // Draw multi-selection highlights
        if (app.interaction.selectedObjects && app.interaction.selectedObjects.length > 0) {
            this.drawMultiSelection(ctx, app);
        }

        // Draw rubber-band rectangle
        if (app.interaction.rubberBand) {
            this.drawRubberBand(ctx, app);
        }

        // Draw hover highlight
        if (app.interaction.hoveredComp && !app.interaction.draggingComp) {
            this.drawHoverHighlight(ctx, app);
        }

        // Draw context menu target highlight
        if (app.interaction.contextTarget) {
            this.drawContextHighlight(ctx, app);
        }

        // Draw agent-preview flash (objects just changed by the MCP agent)
        if (app.interaction.previewFlashIds && app.interaction.previewFlashIds.length) {
            this.drawPreviewFlash(ctx, app);
        }

        // Per-agent board presence: selection highlights + labeled cursors.
        if (app.agentOverlay && app.agentOverlay.length) {
            this.drawAgentOverlay(ctx, app);
        }

        // Ghost preview + alignment guides while placing a component.
        if (app.interaction.placingComponent) {
            this.drawPlacementGhost(ctx, app);
        }
        // Alignment guides while dragging an existing component.
        if (app.interaction.draggingComp && app.interaction._dragAlign) {
            this.drawAlignGuides(ctx, app, app.interaction._dragAlign);
        }

        } finally {
            ctx.restore();
        }

        // Draw crosshair at mouse position for trace tool
        if (app.view.tool === 'trace' && app.interaction.tracePoints.length > 0) {
            const mp = app.worldToScreen(app.interaction.lastMouseX, app.interaction.lastMouseY);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(mp.x - 10, mp.y); ctx.lineTo(mp.x + 10, mp.y);
            ctx.moveTo(mp.x, mp.y - 10); ctx.lineTo(mp.x, mp.y + 10);
            ctx.stroke();
        }

        // Rulers (screen space, top + left) — toggleable from the status bar.
        if (app.params.showRulers !== false) {
            this.drawRulers(ctx, app);
        }
    },
    drawBoard(ctx, app, x, y, w, h) {
        ctx.fillStyle = '#1a4d2e';
        ctx.strokeStyle = '#2d7a4a';
        ctx.lineWidth = 0.5;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.font = `${Math.max(3, w / 20)}px monospace`;
        ctx.fillText(`${app.board.material} ${w}x${h}mm`, x + 2, y + h - 3);
    },

    // Live rectangle preview while the user drags out a new placement zone.
    drawZoneDragPreview(ctx, app) {
        const zd = app.interaction.zoneDrag;
        const x = Math.min(zd.startX, zd.endX), y = Math.min(zd.startY, zd.endY);
        const w = Math.abs(zd.endX - zd.startX), h = Math.abs(zd.endY - zd.startY);
        ctx.save();
        ctx.setLineDash(this._pxDash(app, [4, 3]));
        ctx.lineWidth = this._pxW(app, 1.2);
        ctx.fillStyle = 'rgba(80,160,255,0.12)';
        ctx.strokeStyle = 'rgba(80,160,255,0.85)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(80,160,255,0.95)';
        ctx.font = `${this._pxW(app, 10).toFixed(2)}px monospace`;
        ctx.fillText(`${w.toFixed(1)}×${h.toFixed(1)}mm`, x + this._pxW(app, 3), y + this._pxW(app, 12));
        ctx.restore();
    },

    // Plan placement zones: dashed rectangles with a name label (guided workflow).
    drawZones(ctx, app) {
        const palette = ['rgba(80,160,255,0.10)', 'rgba(255,160,80,0.10)', 'rgba(120,255,140,0.10)', 'rgba(255,120,200,0.10)', 'rgba(255,230,90,0.10)'];
        const stroke = ['rgba(80,160,255,0.7)', 'rgba(255,160,80,0.7)', 'rgba(120,255,140,0.7)', 'rgba(255,120,200,0.7)', 'rgba(255,230,90,0.7)'];
        const sel = app.interaction.selectedObject;
        const selZone = sel && sel.type === 'zone' ? sel.obj : null;
        ctx.save();
        ctx.setLineDash(this._pxDash(app, [4, 3]));
        ctx.lineWidth = this._pxW(app, 1);
        (app.zones || []).forEach((z, i) => {
            const x = z.x - z.w / 2, y = z.y - z.h / 2;
            const isSel = z === selZone;
            ctx.fillStyle = palette[i % palette.length];
            ctx.strokeStyle = stroke[i % stroke.length];
            ctx.fillRect(x, y, z.w, z.h);
            ctx.strokeRect(x, y, z.w, z.h);
            ctx.setLineDash([]);
            // Subtle selection indication: solid brighter outline + corner handles.
            if (isSel) {
                ctx.lineWidth = this._pxW(app, 1.5);
                ctx.strokeStyle = 'rgba(255,255,255,0.85)';
                ctx.strokeRect(x, y, z.w, z.h);
                ctx.lineWidth = this._pxW(app, 1);
                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                const hs = this._pxW(app, 6);
                [[x, y], [x + z.w, y], [x + z.w, y + z.h], [x, y + z.h]].forEach(([cx, cy]) => ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs));
                ctx.setLineDash(this._pxDash(app, [4, 3]));
            }
            ctx.fillStyle = stroke[i % stroke.length];
            ctx.font = `${this._pxW(app, 11).toFixed(2)}px monospace`;
            ctx.fillText(z.name || `Z${z.id}`, x + this._pxW(app, 3), y + this._pxW(app, 12));
            ctx.setLineDash(this._pxDash(app, [4, 3]));
        });
        ctx.restore();
    },

    drawGrid(ctx, app, x, y, w, h) {
        const g = app.params.gridSize;
        ctx.strokeStyle = 'rgba(100,180,255,0.08)';
        ctx.lineWidth = this._pxW(app, 0.7);
        ctx.beginPath();
        for (let gx = x; gx <= x + w; gx += g) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
        for (let gy = y; gy <= y + h; gy += g) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
        ctx.stroke();
        ctx.strokeStyle = 'rgba(100,180,255,0.15)';
        ctx.lineWidth = this._pxW(app, 1);
        ctx.beginPath();
        for (let gx = x; gx <= x + w; gx += g * 5) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
        for (let gy = y; gy <= y + h; gy += g * 5) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
        ctx.stroke();
    },

    // Ghost preview of the component being placed (grid snap + magnetic alignment).
    // Wire jumpers have their own dedicated two-click ghost (drawJumperGhost).
    drawPlacementGhost(ctx, app) {
        const pv = app.interaction._placePreview;
        if (!pv || !app.interaction._placingOnCanvas) return;
        const type = app.interaction.placingComponent;
        if (type === 'jumper' && app.interaction.placingJumperKind === 'wire') return;
        if (!ComponentDefs.get(type)) return;
        const ghost = {
            id: -1, type, x: pv.x, y: pv.y,
            rotation: app.interaction.placingRotation || 0,
            size: pv.sizeIdx, pins: pv.pins, label: '', value: ''
        };
        ctx.save();
        ctx.globalAlpha = 0.55;
        this.drawComponent(ctx, app, ghost);
        if (app.view.visibleLayers.silkTop || app.view.visibleLayers.silkBottom) {
            this.drawSilkComponent(ctx, app, ghost);
        }
        ctx.restore();
        if (pv.lineX !== null || pv.lineY !== null) {
            this.drawAlignGuides(ctx, app, { lineX: pv.lineX, lineY: pv.lineY });
        }
    },

    // Full-viewport alignment guide lines at aligned edge/centre positions (subtle).
    drawAlignGuides(ctx, app, lines) {
        if (!lines || (lines.lineX === null && lines.lineY === null)) return;
        const tl = app.screenToWorld(0, 0);
        const br = app.screenToWorld(app.boardCanvas.width, app.boardCanvas.height);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,92,138,0.4)';
        ctx.lineWidth = this._pxW(app, 1);
        if (lines.lineX !== null) {
            ctx.beginPath(); ctx.moveTo(lines.lineX, tl.y); ctx.lineTo(lines.lineX, br.y); ctx.stroke();
        }
        if (lines.lineY !== null) {
            ctx.beginPath(); ctx.moveTo(tl.x, lines.lineY); ctx.lineTo(br.x, lines.lineY); ctx.stroke();
        }
        ctx.restore();
    },

    // Screen-space mm rulers along the top and left edges of the canvas.
    // Tick step auto-adapts to zoom (1/2/5 x 10^n mm, ~40 px spacing).
    drawRulers(ctx, app) {
        const canvas = app.boardCanvas;
        const w = canvas.width, h = canvas.height;
        const size = 18; // ruler thickness in px
        const zoom = app.view.zoom;
        let step = 100;
        outer:
        for (let n = -2; n <= 6; n++) {
            for (const m of [1, 2, 5]) {
                const s = m * Math.pow(10, n);
                if (s * zoom >= 40) { step = s; break outer; }
            }
        }
        const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
        const fmt = v => { const t = v.toFixed(dec); return t === '-0' ? '0' : t; };

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#6f97c9';
        ctx.fillStyle = '#101a30';

        // Top ruler (X)
        ctx.fillRect(0, 0, w, size);
        ctx.strokeRect(0.5, 0.5, w - 1, size - 1);
        // Labels are relative to the board's top-left corner (world origin is the board centre),
        // so a fitted board reads 0 at the ruler corner and increases along both edges.
        const ox = app.board.width / 2, oy = app.board.height / 2;
        const wxl = app.screenToWorld(0, 0).x + ox;   // relative: world + half board size
        const wxr = app.screenToWorld(w, 0).x + ox;
        ctx.font = '10px monospace';
        ctx.textBaseline = 'top';
        // Numeric labels target ~10 mm spacing (falls back to every tick when step > 10 mm).
        const labelEvery = Math.max(1, Math.round(10 / step + 1e-9));
        for (let k = Math.ceil(wxl / step - 1e-6); k * step <= wxr + 1e-6; k++) {
            const rx = k * step;                       // mm from the board's left edge
            const sx = app.worldToScreen(rx - ox, 0).x;
            if (sx < size || sx > w) continue;
            const labeled = ((k % labelEvery) + labelEvery) % labelEvery === 0;
            ctx.beginPath();
            ctx.moveTo(sx + 0.5, size);
            ctx.lineTo(sx + 0.5, size - (labeled ? 11 : 6));
            ctx.stroke();
            if (labeled) {
                ctx.fillStyle = rx === 0 ? '#e8c15a' : '#7fb3d5';
                ctx.fillText(fmt(rx), sx + 3, 2);
                ctx.fillStyle = '#101a30';
            }
        }

        // Dense sub-ticks (5 per step) for finer reading — e.g. 2 mm ticks inside a 10 mm step.
        const sub = step / 5;
        for (let k = Math.ceil(wxl / sub - 1e-6); k * sub <= wxr + 1e-6; k++) {
            if (((k % 5) + 5) % 5 === 0) continue; // step tick already drawn
            const sx = app.worldToScreen(k * sub - ox, 0).x;
            if (sx < size || sx > w) continue;
            ctx.beginPath();
            ctx.moveTo(sx + 0.5, size);
            ctx.lineTo(sx + 0.5, size - 4);
            ctx.stroke();
        }

        // Left ruler (Y)
        ctx.fillRect(0, size, size, h - size);
        ctx.strokeRect(0.5, size + 0.5, size - 1, h - size - 1);
        const wyt = app.screenToWorld(0, size).y + oy;
        const wyb = app.screenToWorld(0, h).y + oy;
        for (let k = Math.ceil(wyt / step - 1e-6); k * step <= wyb + 1e-6; k++) {
            const ry = k * step;                       // mm from the board's top edge
            const sy = app.worldToScreen(0, ry - oy).y;
            if (sy < size || sy > h) continue;
            const labeled = ((k % labelEvery) + labelEvery) % labelEvery === 0;
            ctx.beginPath();
            ctx.moveTo(size, sy + 0.5);
            ctx.lineTo(size - (labeled ? 11 : 6), sy + 0.5);
            ctx.stroke();
            if (labeled) {
                ctx.save();
                ctx.translate(9, sy + 3);
                ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = ry === 0 ? '#e8c15a' : '#7fb3d5';
                ctx.fillText(fmt(ry), 0, 0);
                ctx.restore();
            }
        }

        // Dense sub-ticks (5 per step) — mirrors the top ruler.
        for (let k = Math.ceil(wyt / sub - 1e-6); k * sub <= wyb + 1e-6; k++) {
            if (((k % 5) + 5) % 5 === 0) continue;
            const sy = app.worldToScreen(0, k * sub - oy).y;
            if (sy < size || sy > h) continue;
            ctx.beginPath();
            ctx.moveTo(size, sy + 0.5);
            ctx.lineTo(size - 4, sy + 0.5);
            ctx.stroke();
        }
        ctx.restore();
    },

    // Logical schematic wire on the board: thin dashed net-color line.
    // Connectivity hint only — never copper (no DRC, no export).
    drawSchemWire(ctx, app, trace) {
        const pts = trace.points;
        if (!pts || pts.length < 2) return;
        ctx.save();
        ctx.strokeStyle = this.getNetColor(app, trace.net);
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = this._pxW(app, 1.2); // thin
        ctx.setLineDash(this._pxDash(app, [5, 4]));
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
    },

    drawTrace(ctx, app, trace) {
        const netColor = this.getNetColor(app, trace.net);
        const pts = trace.points;
        if (!pts || pts.length < 2) return;
        const curved = trace.curved || [];

        // Get per-segment widths (fallback to trace.width)
        const segWidths = [];
        for (let i = 0; i < pts.length - 1; i++) {
            segWidths.push(app.getSegmentWidth(trace, i));
        }

        // One solid stroke per run of equal width. A hairline down the middle
        // rasterizes as a stair-step on a diagonal, so the copper is the stroke.
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        let i = 0;
        while (i < pts.length - 1) {
            const w = segWidths[i];
            let j = i + 1;
            while (j < pts.length - 1 && segWidths[j] === w && !curved[j] && !curved[j - 1]) j++;
            const drawRun = () => {
                ctx.beginPath();
                ctx.moveTo(pts[i].x, pts[i].y);
                for (let k = i; k < j; k++) {
                    const p0 = pts[k], p1 = pts[k + 1];
                    if (curved[k]) {
                        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                        const dx = p1.x - p0.x, dy = p1.y - p0.y;
                        const len = Math.hypot(dx, dy);
                        if (len > 0.01) ctx.quadraticCurveTo(mx - dy * 0.3, my + dx * 0.3, p1.x, p1.y);
                        else ctx.lineTo(p1.x, p1.y);
                    } else ctx.lineTo(p1.x, p1.y);
                }
            };
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = w + 0.12;
            drawRun();
            ctx.stroke();
            ctx.strokeStyle = netColor;
            ctx.lineWidth = w;
            drawRun();
            ctx.stroke();
            i = j;
        }

        // Draw hovered segment highlight (bright glow)
        const hovSeg = app.interaction.hoveredSegment;
        if (hovSeg && hovSeg.traceId === trace.id) {
            const i = hovSeg.segIndex;
            const p0 = pts[i], p1 = pts[i + 1];
            if (!p0 || !p1) { /* stale hover after cut/delete */ } else {
            const w = segWidths[i] || trace.width;
            this._drawLitPath(ctx, app, [p0, p1], 'hover', w);
            }
        }

        // Selected segment: width readout only — outline is drawn in drawSelection.
        const selObj = app.interaction.selectedObject;
        const selSeg = app.interaction.selectedSegment;
        if ((selObj && selObj.type === 'traceSegment' && selObj.traceId === trace.id) ||
            (selSeg && selSeg.traceId === trace.id && selObj && selObj.type === 'trace' && selObj.obj && selObj.obj.id === trace.id)) {
            const i = (selObj && selObj.type === 'traceSegment') ? selObj.segIndex : selSeg.segIndex;
            const p0 = pts[i], p1 = pts[i + 1];
            if (p0 && p1) {
                const w = segWidths[i] || trace.width;
                const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                ctx.fillStyle = '#cfe8ff';
                ctx.font = `${11 / app.view.zoom}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(w + ' mm', mx, my - w / 2 - 0.4);
            }
        }

        // Vertices: small dots when idle (grab targets). Selected traces use
        // the handle squares below.
        const selObj2 = app.interaction.selectedObject;
        const isTraceSelected = (selObj2 && selObj2.type === 'trace' && selObj2.obj && selObj2.obj.id === trace.id) ||
                                (selObj2 && selObj2.type === 'traceSegment' && selObj2.traceId === trace.id) ||
                                (selObj2 && selObj2.type === 'traceVertex' && selObj2.traceId === trace.id);
        if (!isTraceSelected) {
            pts.forEach((p) => {
                ctx.fillStyle = 'rgba(255,255,255,0.55)';
                ctx.strokeStyle = 'rgba(0,0,0,0.45)';
                ctx.lineWidth = this._selHair(app);
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(0.25, 1.0 / app.view.zoom), 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            });
        }

        // Pad constraint rings only when this trace is selected
        if (isTraceSelected) {
            pts.forEach((p, pi) => {
                const constraint = app.getPadConstraint(trace, pi);
                if (constraint && (pi === 0 || pi === pts.length - 1)) {
                    ctx.strokeStyle = 'rgba(255,200,0,0.6)';
                    ctx.lineWidth = 0.3;
                    const padR = constraint.maxW * 0.7;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, padR, 0, Math.PI * 2);
                    ctx.stroke();
                }
            });
        }

        // Hovered vertex
        if (app.interaction.hoveredTraceVertex) {
            const hv = app.interaction.hoveredTraceVertex;
            const trace2 = app.traces.find(t => t.id === hv.traceId);
            if (trace2 && trace2.points[hv.pointIndex]) {
                const hp = trace2.points[hv.pointIndex];
                this._drawHandleSquare(ctx, app, hp.x, hp.y, 'hover');
            }
        }

        // Multi-selected joints (what DEL will remove)
        if (app.interaction.selectedVertices && app.interaction.selectedVertices.length) {
            for (const sv of app.interaction.selectedVertices) {
                if (sv.traceId !== trace.id) continue;
                const sp = pts[sv.pointIndex];
                if (!sp) continue;
                this._drawHandleSquare(ctx, app, sp.x, sp.y, 'context');
            }
        }

        // Draw vertex handles if this trace is selected or a segment of it is selected
        if (isTraceSelected) {
            pts.forEach((p) => {
                this._drawHandleSquare(ctx, app, p.x, p.y, 'select');
            });
            // Draw segment midpoints with width label and curve indicator
            for (let i = 0; i < pts.length - 1; i++) {
                const mx = (pts[i].x + pts[i+1].x) / 2;
                const my = (pts[i].y + pts[i+1].y) / 2;
                const r = 2.0 / app.view.zoom;
                ctx.fillStyle = curved[i] ? '#ff6600' : '#888';
                ctx.beginPath();
                ctx.moveTo(mx, my - r);
                ctx.lineTo(mx + r, my);
                ctx.lineTo(mx, my + r);
                ctx.lineTo(mx - r, my);
                ctx.closePath();
                ctx.fill();
                // Show segment width as small text
                const sw = segWidths[i];
                if (sw !== undefined) {
                    ctx.fillStyle = 'rgba(255,255,255,0.9)';
                    ctx.font = `${10 / app.view.zoom}px monospace`;
                    ctx.textAlign = 'center';
                    ctx.fillText(sw.toFixed(1), mx, my - r - 2 / app.view.zoom);
                }
            }
        }
    },

    // Ghost for wire-jumper placement: dashed TH pads + silk hairline + live span. No copper bar.
    drawJumperGhost(ctx, app) {
        if (!app.interaction._placingOnCanvas) return;
        const def = ComponentDefs.get('jumper');
        if (!def) return;
        let sizeIdx = (app.interaction.placingSize && app.interaction.placingSize.jumper !== undefined) ? app.interaction.placingSize.jumper : -1;
        if (sizeIdx < 0 || !def.sizes[sizeIdx] || def.sizes[sizeIdx].jkind !== 'wire') sizeIdx = def.sizes.findIndex(s => s.jkind === 'wire');
        const size = ComponentDefs.getSize(def, sizeIdx);
        if (!size || !size.pins || size.pins.length < 2) return;
        const mp = app.snapJumperEnd(app.interaction.lastMouseX, app.interaction.lastMouseY);
        const mx = mp.x, my = mp.y;
        const f = app.interaction.jumperFirst;
        let p1, p2, span;
        if (f) {
            p1 = f; p2 = { x: mx, y: my };
            span = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        } else {
            const rad = (app.interaction.placingRotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const fullSpan = Math.abs(size.pins[1].x) * 2;
            p1 = { x: mx, y: my };
            p2 = { x: mx + fullSpan * cos, y: my + fullSpan * sin };
            span = fullSpan;
        }
        const pr = Math.max(0.35, Math.min(1.0, (span || 10) * 0.4));
        ctx.save();
        // Silk hairline preview (where the wire goes) — deliberately not copper.
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 0.15;
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        // Dashed TH pad ghosts (same proportions as drawComponent's TH pads).
        [p1, p2].forEach(p => {
            ctx.fillStyle = 'rgba(212,168,67,0.45)';
            ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.2;
            ctx.setLineDash([0.4, 0.3]);
            ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
        });
        // Live span text at the midpoint.
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        ctx.fillStyle = '#ffffff';
        ctx.font = `${10 / app.view.zoom}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(span.toFixed(1) + ' mm', mid.x, mid.y - pr - 3 / app.view.zoom);
        ctx.restore();
    },

    drawActiveTrace(ctx, app) {
        const pts = [...app.interaction.tracePoints];
        const lastPt = { x: app.interaction.lastMouseX, y: app.interaction.lastMouseY };
        pts.push(lastPt);
        const kind = app.interaction.traceSnapKind || 'grid';
        const copper = kind === 'pin' || kind === 'via' || kind === 'vertex' || kind === 'edge';
        const ortho = kind === 'h' || kind === 'v' || kind === 'diag';

        if (app.interaction.tracePoints.length) {
            const prev = app.interaction.tracePoints[app.interaction.tracePoints.length - 1];
            ctx.save();
            ctx.strokeStyle = 'rgba(120,180,255,0.22)';
            ctx.lineWidth = 0.12;
            ctx.setLineDash([0.6, 0.5]);
            const span = Math.max(app.board.width, app.board.height) * 2;
            ctx.beginPath();
            ctx.moveTo(prev.x - span, prev.y); ctx.lineTo(prev.x + span, prev.y);
            ctx.moveTo(prev.x, prev.y - span); ctx.lineTo(prev.x, prev.y + span);
            ctx.stroke();
            ctx.restore();
        }

        // Solid copper at the real width. A dashed centerline stair-steps on a diagonal.
        ctx.strokeStyle = copper ? 'rgba(0,255,100,0.9)' : (ortho ? 'rgba(80,170,255,0.9)' : 'rgba(255,190,40,0.9)');
        ctx.lineWidth = Math.max(0.2, app.params.traceWidth);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();

        app.interaction.tracePoints.forEach(p => {
            ctx.fillStyle = '#ffcc33';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 0.6, 0, Math.PI * 2);
            ctx.fill();
        });

        const ring = copper ? 2.0 : (ortho ? 1.5 : 1.1);
        ctx.strokeStyle = copper ? '#00ff64' : (ortho ? '#7ec8ff' : '#ffcc33');
        ctx.lineWidth = 0.45;
        ctx.beginPath();
        ctx.arc(lastPt.x, lastPt.y, ring, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = copper ? 'rgba(0,255,100,0.28)' : (ortho ? 'rgba(120,200,255,0.22)' : 'rgba(255,200,50,0.18)');
        ctx.fill();
    },

    // Determine if a component size is TH (through-hole) or SMD
    isTH(size) {
        if (!size) return false;
        if (size.th) return true; // dev-board modules use round header pads
        if (!size.name) return false;
        const n = size.name.toUpperCase();
        if (n.startsWith('TH')) return true;
        if (n.includes('(TH)')) return true;
        if (n.startsWith('TO-') || /\bTO-\d+/.test(n)) return true;
        if (n.startsWith('DIP')) return true;
        if (n.startsWith('HEADER') || n.indexOf('\u00d7') >= 0) return true;
        return false;
    },

    drawComponent(ctx, app, comp) {
        const size = app.getCompSize(comp);
        if (!size) return;
        const th = this.isTH(size);
        ctx.save();
        ctx.translate(comp.x, comp.y);
        ctx.rotate((comp.rotation || 0) * Math.PI / 180);
        const compPins = (comp.pins && comp.pins.length) ? comp.pins : size.pins;

        if (size.kicad) {
            this.drawKicadFootprint(ctx, size, app, comp);
        } else {
            this._drawCadPads(ctx, size, compPins, th, comp.layer);
        }

        ctx.restore();
    },

    _drawCadPads(ctx, size, pins, th, layer) {
        if (!pins || !pins.length) return;
        let minPinDist = Infinity;
        for (let a = 0; a < pins.length; a++) {
            for (let b = a + 1; b < pins.length; b++) {
                const d = Math.hypot(pins[a].x - pins[b].x, pins[a].y - pins[b].y);
                if (d < minPinDist) minPinDist = d;
            }
        }
        if (!isFinite(minPinDist)) minPinDist = 2.54;

        const copper = (layer === 'bottom') ? '#6ea3c9' : '#d4a843';
        const edge = 'rgba(0,0,0,0.55)';

        pins.forEach((pin, idx) => {
            if (th) {
                const pr = size.padR || Math.max(0.35, Math.min(1.0, minPinDist * 0.4));
                const holeR = ((size.drillDia != null) ? size.drillDia : pr * 0.8) / 2;
                ctx.fillStyle = copper;
                ctx.strokeStyle = edge;
                ctx.lineWidth = 0.12;
                if (idx === 0 && pins.length >= 3) {
                    const s = pr * 2;
                    this.roundRect(ctx, pin.x - pr, pin.y - pr, s, s, 0.08);
                    ctx.fill(); ctx.stroke();
                } else {
                    ctx.beginPath(); ctx.arc(pin.x, pin.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                }
                ctx.fillStyle = '#0a0a1a';
                ctx.beginPath(); ctx.arc(pin.x, pin.y, holeR, 0, Math.PI * 2); ctx.fill();
            } else {
                const twoPad = pins.length === 2;
                let pw, ph;
                if (typeof Export !== 'undefined' && Export.smdPadWH) {
                    const dim = Export.smdPadWH(pin, minPinDist, twoPad);
                    pw = dim.pw; ph = dim.ph;
                } else {
                    const along = Math.max(0.35, Math.min(minPinDist * (twoPad ? 0.55 : 0.45), twoPad ? 1.4 : 1.6));
                    const across = Math.max(0.45, Math.min(minPinDist * (twoPad ? 0.42 : 1.05), twoPad ? 1.2 : 2.2));
                    const onXEdge = Math.abs(pin.x) > Math.abs(pin.y);
                    pw = onXEdge ? across : along; ph = onXEdge ? along : across;
                }
                const rr = Math.min(pw, ph) * 0.22;
                ctx.fillStyle = copper;
                ctx.strokeStyle = edge;
                ctx.lineWidth = 0.08;
                this.roundRect(ctx, pin.x - pw / 2, pin.y - ph / 2, pw, ph, rr);
                ctx.fill(); ctx.stroke();
            }
        });
    },

    _moduleSilkName(type) {
        const names = {
            arduino_uno: 'UNO R3', arduino_nano: 'NANO',
            esp32_devkit: 'ESP32', esp32s3_devkit: 'ESP32-S3',
            esp32s2_mini: 'ESP32-S2', esp32s3_nano: 'ESP32-S3',
            esp8266_nodemcu: 'NodeMCU', rpi_pico: 'Pico'
        };
        return names[type] || null;
    },

    // Designator + value on the silk layer (draggable positions stored on comp.silkLabel / comp.silkValue).
    drawCompSilkLabels(ctx, app, comp, size, silkColor) {
        app.ensureCompSilkLayout(comp);
        const label = (comp.label || '').trim();
        const value = (comp.value || '').trim();
        if (!label && !value) return;
        const fs = app.compSilkFontSize(size);
        ctx.save();
        ctx.translate(comp.x, comp.y);
        ctx.rotate((comp.rotation || 0) * Math.PI / 180);
        ctx.font = 'bold ' + fs.toFixed(2) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(0.06, fs * 0.08);
        ctx.strokeStyle = 'rgba(10,14,26,0.85)';

        const drawOne = (text, pos, baseline, fill) => {
            if (!text) return;
            const ffs = app.compSilkEffectiveFontSize(pos, size);
            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.rotate((pos.rotation || 0) * Math.PI / 180);
            ctx.font = 'bold ' + ffs.toFixed(2) + 'px sans-serif';
            ctx.lineWidth = Math.max(0.06, ffs * 0.08);
            ctx.textBaseline = baseline;
            ctx.strokeText(text, 0, 0);
            ctx.fillStyle = fill;
            ctx.fillText(text, 0, 0);
            ctx.restore();
        };

        drawOne(label, comp.silkLabel, 'bottom', silkColor || '#ffffff');
        drawOne(value, comp.silkValue, 'top', silkColor || '#ffd78a');
        ctx.restore();
    },

    drawSilkComponent(ctx, app, comp) {
        const size = app.getCompSize(comp);
        if (!size) return;
        const silkColor = (comp.layer === 'bottom') ? '#f1c40f' : '#e8eef4';
        ctx.save();
        ctx.translate(comp.x, comp.y);
        ctx.rotate((comp.rotation || 0) * Math.PI / 180);
        const hw = size.width / 2, hh = size.height / 2;
        const th = this.isTH(size);
        const pins = (comp.pins && comp.pins.length) ? comp.pins : (size.pins || []);
        const type = comp.type;
        const nm = (size.name || '').toUpperCase();

        if (size.kicad) {
            this.drawKicadSilkGraphics(ctx, size, app, comp);
        } else {
            ctx.strokeStyle = silkColor;
            ctx.fillStyle = silkColor;
            ctx.lineWidth = 0.15;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.globalAlpha = 0.92;

            const courtyard = (pad) => {
                this.roundRect(ctx, -hw - pad, -hh - pad, size.width + pad * 2, size.height + pad * 2, Math.min(0.4, hw * 0.12));
                ctx.stroke();
            };
            const pin1Dot = () => {
                if (!pins.length) return;
                if (['transistor', 'pnp', 'mosfet', 'diode', 'led', 'resistor', 'gnd', 'power', 'nc', 'jumper', 'fuse', 'crystal', 'ic'].indexOf(type) >= 0) return;
                const p1 = pins[0];
                const awayX = Math.abs(p1.x) >= Math.abs(p1.y) ? Math.sign(p1.x || 1) : 0;
                const awayY = awayX === 0 ? Math.sign(p1.y || -1) : 0;
                ctx.beginPath(); ctx.arc(p1.x + awayX * 0.65, p1.y + awayY * 0.65, 0.22, 0, Math.PI * 2); ctx.fill();
            };

            if (type === 'jumper' && size.jkind === 'wire' && pins.length >= 2) {
                ctx.beginPath(); ctx.moveTo(pins[0].x, pins[0].y); ctx.lineTo(pins[1].x, pins[1].y); ctx.stroke();
            } else if (type === 'capacitor' && th) {
                const cr = Math.min(hw, hh);
                ctx.beginPath(); ctx.arc(0, 0, cr, 0, Math.PI * 2); ctx.stroke();
                const plus = this._electrolyticPlusPin(size, pins);
                if (plus) {
                    const minus = pins.find(p => p !== plus);
                    if (minus) {
                        ctx.lineWidth = 0.28;
                        const bx = minus.x * 0.55;
                        ctx.beginPath(); ctx.moveTo(bx, -cr * 0.45); ctx.lineTo(bx, cr * 0.45); ctx.stroke();
                    }
                    this._drawPlusMark(ctx, plus);
                }
            } else if (type === 'led' && th) {
                const lr = Math.min(hw, hh);
                ctx.beginPath(); ctx.arc(0, 0, lr, 0, Math.PI * 2); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(-lr + 0.15, -lr * 0.55); ctx.lineTo(-lr + 0.15, lr * 0.55); ctx.stroke();
            } else if (type === 'diode') {
                courtyard(0.15);
                const bandW = Math.max(0.25, size.width * 0.08);
                ctx.lineWidth = 0.22;
                ctx.beginPath(); ctx.moveTo(hw - bandW, -hh + 0.2); ctx.lineTo(hw - bandW, hh - 0.2); ctx.stroke();
            } else if (type === 'resistor' && th) {
                const bodyW = size.width * 0.5;
                const bodyH = Math.min(size.height * 0.55, bodyW * 0.55);
                const capR = bodyH / 2;
                this.roundRect(ctx, -bodyW / 2, -capR, bodyW, bodyH, capR);
                ctx.stroke();
                if (pins.length >= 2) {
                    ctx.beginPath();
                    ctx.moveTo(-bodyW / 2, 0); ctx.lineTo(pins[0].x, pins[0].y);
                    ctx.moveTo(bodyW / 2, 0); ctx.lineTo(pins[pins.length - 1].x, pins[pins.length - 1].y);
                    ctx.stroke();
                }
            } else if ((type === 'transistor' || type === 'pnp' || type === 'mosfet' || type === 'ldo') && (nm.includes('TO-92') || nm.includes('TO-220'))) {
                const tr = Math.min(hw, hh);
                if (nm.includes('TO-220')) {
                    this.roundRect(ctx, -hw, -hh, size.width, size.height, 0.3);
                    ctx.stroke();
                    ctx.beginPath(); ctx.arc(0, -hh * 0.15, Math.min(hw, hh * 0.45), Math.PI, 0); ctx.stroke();
                } else {
                    const cx = 0, cy = -hh * 0.12, r = tr * 0.82;
                    const flatY = cy + r * 0.55;
                    const half = Math.sqrt(Math.max(0, r * r - (flatY - cy) * (flatY - cy)));
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, Math.atan2(flatY - cy, -half), Math.atan2(flatY - cy, half), false);
                    ctx.closePath();
                    ctx.stroke();
                }
            } else if (type === 'gnd' || type === 'power' || type === 'nc') {
                const cr = Math.min(hw, hh) * 0.9;
                ctx.beginPath(); ctx.arc(0, 0, cr, 0, Math.PI * 2); ctx.stroke();
                if (type === 'gnd') {
                    const gs = cr * 0.45;
                    ctx.beginPath(); ctx.moveTo(-gs, gs * 0.2); ctx.lineTo(gs, gs * 0.2); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(-gs * 0.65, gs * 0.5); ctx.lineTo(gs * 0.65, gs * 0.5); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(-gs * 0.3, gs * 0.8); ctx.lineTo(gs * 0.3, gs * 0.8); ctx.stroke();
                } else if (type === 'power') {
                    const ps = cr * 0.4;
                    ctx.beginPath(); ctx.moveTo(-ps, 0); ctx.lineTo(ps, 0); ctx.moveTo(0, -ps); ctx.lineTo(0, ps); ctx.stroke();
                } else {
                    const ns = cr * 0.35;
                    ctx.beginPath(); ctx.moveTo(-ns, -ns); ctx.lineTo(ns, ns); ctx.moveTo(ns, -ns); ctx.lineTo(-ns, ns); ctx.stroke();
                }
            } else if (this._moduleSilkName(type)) {
                this.roundRect(ctx, -hw, -hh, size.width, size.height, 1.2);
                ctx.stroke();
                ctx.globalAlpha = 0.45;
                ctx.font = 'bold ' + Math.max(1.0, Math.min(2.0, Math.min(hw, hh) * 0.08)).toFixed(2) + 'px sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(this._moduleSilkName(type), 0, 0);
                ctx.globalAlpha = 0.92;
            } else if (type === 'ic' || type === 'connector') {
                courtyard(0.2);
                if (type === 'ic') {
                    const notchR = Math.min(0.9, hw * 0.18);
                    ctx.beginPath(); ctx.arc(0, -hh, notchR, 0, Math.PI); ctx.stroke();
                }
                pin1Dot();
            } else if (type === 'capacitor' && !th) {
                const bw = Math.abs((pins[0].x || 0) - (pins[1].x || 0)) * 0.42;
                const bh = size.height * 0.72;
                this.roundRect(ctx, -Math.max(bw, 0.3) / 2, -bh / 2, Math.max(bw, 0.3), bh, 0.06);
                ctx.stroke();
                ctx.lineWidth = 0.22;
                ctx.beginPath(); ctx.moveTo(-Math.max(bw, 0.3) / 2, -bh / 2); ctx.lineTo(-Math.max(bw, 0.3) / 2, bh / 2); ctx.stroke();
            } else if (type === 'led' && !th) {
                const bw = Math.abs((pins[0].x || 0) - (pins[1].x || 0)) * 0.42;
                const bh = size.height * 0.72;
                this.roundRect(ctx, -Math.max(bw, 0.3) / 2, -bh / 2, Math.max(bw, 0.3), bh, 0.06);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(-Math.max(bw, 0.3) / 2, -bh / 2);
                ctx.lineTo(-Math.max(bw, 0.3) / 2 + 0.35, -bh / 2);
                ctx.lineTo(-Math.max(bw, 0.3) / 2, -bh / 2 + 0.4);
                ctx.closePath();
                ctx.stroke();
            } else if (pins.length === 2 && !th) {
                const bw = Math.abs((pins[0].x || 0) - (pins[1].x || 0)) * 0.42;
                const bh = size.height * 0.72;
                this.roundRect(ctx, -Math.max(bw, 0.3) / 2, -bh / 2, Math.max(bw, 0.3), bh, 0.06);
                ctx.stroke();
            } else {
                courtyard(0.15);
                pin1Dot();
            }
            ctx.globalAlpha = 1;
            this._drawPadPinLabels(ctx, size, pins);
        }
        ctx.restore();

        this.drawCompSilkLabels(ctx, app, comp, size, silkColor);
    },

    // Glowing highlight for objects just created/changed by the MCP agent
    // (agent-preview "focus" events). Components get a frame; traces a glow.
    drawPreviewFlash(ctx, app) {
        const ids = new Set(app.interaction.previewFlashIds);
        ctx.save();
        app.components.forEach(comp => {
            if (!ids.has(comp.id)) return;
            const size = app.getCompSize(comp);
            if (!size) return;
            const pad = 2.5;
            const rad = (comp.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const local = [
                { x: -size.width / 2 - pad, y: -size.height / 2 - pad },
                { x: size.width / 2 + pad, y: -size.height / 2 - pad },
                { x: size.width / 2 + pad, y: size.height / 2 + pad },
                { x: -size.width / 2 - pad, y: size.height / 2 + pad }
            ];
            const rp = local.map(p => ({
                x: comp.x + p.x * cos - p.y * sin,
                y: comp.y + p.x * sin + p.y * cos
            }));
            ctx.beginPath();
            rp.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
            ctx.closePath();
            ctx.strokeStyle = 'rgba(255, 214, 0, 0.95)';
            ctx.lineWidth = Math.max(1.5, 0.6 / app.view.zoom);
            ctx.setLineDash([]);
            ctx.shadowColor = '#ffd600';
            ctx.shadowBlur = 12;
            ctx.stroke();
        });
        app.traces.forEach(trace => {
            if (!ids.has(trace.id)) return;
            const pts = trace.points || [];
            if (pts.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.strokeStyle = 'rgba(0, 229, 255, 0.8)';
            ctx.lineWidth = (trace.width || 0.5) + Math.max(1.5, 0.8 / app.view.zoom);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowColor = '#00e5ff';
            ctx.shadowBlur = 12;
            ctx.stroke();
        });
        ctx.restore();
    },

    drawAgentOverlay(ctx, app) {
        const byId = new Map();
        app.components.forEach(c => byId.set(c.id, { kind: 'comp', obj: c }));
        app.traces.forEach(t => byId.set(t.id, { kind: 'trace', obj: t }));
        ctx.save();
        ctx.setLineDash([]);
        for (const a of app.agentOverlay) {
            const color = a.color || '#ffffff';
            // Selection outlines in the agent's color.
            (a.selection || []).forEach(id => {
                const hit = byId.get(id);
                if (!hit) return;
                if (hit.kind === 'comp') {
                    const size = app.getCompSize(hit.obj);
                    if (!size) return;
                    const comp = hit.obj, pad = 2.5;
                    const rad = (comp.rotation || 0) * Math.PI / 180;
                    const cos = Math.cos(rad), sin = Math.sin(rad);
                    const local = [
                        { x: -size.width / 2 - pad, y: -size.height / 2 - pad },
                        { x: size.width / 2 + pad, y: -size.height / 2 - pad },
                        { x: size.width / 2 + pad, y: size.height / 2 + pad },
                        { x: -size.width / 2 - pad, y: size.height / 2 + pad }
                    ];
                    ctx.beginPath();
                    local.forEach((p, i) => {
                        const x = comp.x + p.x * cos - p.y * sin;
                        const y = comp.y + p.x * sin + p.y * cos;
                        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                    });
                    ctx.closePath();
                    ctx.strokeStyle = color;
                    ctx.lineWidth = this._pxW(app, 2);
                    ctx.stroke();
                } else {
                    const pts = hit.obj.points || [];
                    if (pts.length < 2) return;
                    ctx.beginPath();
                    ctx.moveTo(pts[0].x, pts[0].y);
                    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = (hit.obj.width || 0.5) + this._pxW(app, 2);
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.stroke();
                }
            });
            // Labeled cursor marker.
            if (a.cursor) {
                const r = this._pxW(app, 5);
                ctx.beginPath();
                ctx.arc(a.cursor.x, a.cursor.y, r, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = '#0a0a1a';
                ctx.lineWidth = this._pxW(app, 1);
                ctx.stroke();
                ctx.font = `${this._pxW(app, 11).toFixed(2)}px monospace`;
                ctx.fillStyle = color;
                ctx.fillText(a.name || 'Agent', a.cursor.x + r + this._pxW(app, 2), a.cursor.y - r);
            }
        }
        ctx.restore();
    },

    drawSilkText(ctx, app, txt) {
        const color = txt.layer === 'silkBottom' ? '#f1c40f' : '#ffffff';
        ctx.save();
        ctx.translate(txt.x, txt.y);
        if (txt.rotation) ctx.rotate(txt.rotation * Math.PI / 180);
        ctx.fillStyle = color;
        ctx.font = `${txt.size || 2}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt.text, 0, 0);
        ctx.restore();
    },

    drawCopperJunctions(ctx, app) {
        const pts = app.collectCopperJunctions ? app.collectCopperJunctions() : [];
        if (!pts.length) return;
        for (const p of pts) {
            const r = Math.max(0.45, 1.1 / Math.max(app.view.zoom, 0.4));
            ctx.fillStyle = '#f4d35e';
            ctx.strokeStyle = '#1a1a12';
            ctx.lineWidth = this._pxW(app, 0.6);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    },

    drawVia(ctx, app, via) {
        ctx.fillStyle = '#ff8800';
        ctx.beginPath();
        ctx.arc(via.x, via.y, via.diameter / 2 + 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a0a1a';
        ctx.beginPath();
        ctx.arc(via.x, via.y, via.diameter / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ff8800';
        ctx.lineWidth = this._pxW(app, 0.8);
        const r = via.diameter / 4;
        ctx.beginPath();
        ctx.moveTo(via.x - r, via.y); ctx.lineTo(via.x + r, via.y);
        ctx.moveTo(via.x, via.y - r); ctx.lineTo(via.x, via.y + r);
        ctx.stroke();
    },

    drawOutline(ctx, app, points) {
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = this._pxW(app, 1.2);
        ctx.setLineDash(this._pxDash(app, [6, 4]));
        ctx.beginPath();
        points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
    },

    drawActiveOutline(ctx, app) {
        const pts = app.interaction.outlinePoints;
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = this._pxW(app, 1.2);
        ctx.setLineDash(this._pxDash(app, [6, 4]));
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
        ctx.setLineDash([]);
        const dot = this._pxW(app, 4);
        pts.forEach(p => {
            ctx.fillStyle = '#ffaa00';
            ctx.beginPath();
            ctx.arc(p.x, p.y, dot, 0, Math.PI * 2);
            ctx.fill();
        });
    },

    // Screen-space stroke. `weight` is CSS-px so it stays readable at any zoom.
    _selHair(app, weight) {
        return (weight || 1.6) / Math.max(app.view.zoom, 0.01);
    },

    // Screen-constant stroke width: `px` is CSS pixels, divided by zoom so the
    // line stays the same on-screen thickness at any zoom (CAD-style hairlines).
    _pxW(app, px) {
        return Math.max(px, 0.01) / Math.max(app.view.zoom, 0.01);
    },

    // Screen-constant dash pattern: `px` array in CSS pixels, divided by zoom.
    _pxDash(app, px) {
        const z = Math.max(app.view.zoom, 0.01);
        return px.map(v => v / z);
    },

    _selTheme(mode) {
        if (mode === 'hover') return { fill: 'rgba(170,220,255,0.14)', glow: '#6eb8ef', line: '#e8f5ff', glowPx: 8, weight: 1.55 };
        if (mode === 'multi') return { fill: 'rgba(140,200,245,0.16)', glow: '#7ec8ff', line: '#f4fbff', glowPx: 9, weight: 1.7 };
        if (mode === 'context') return { fill: 'rgba(230,126,115,0.14)', glow: '#e67e73', line: '#ffe4e0', glowPx: 7, weight: 1.55 };
        return { fill: 'rgba(190,230,255,0.20)', glow: '#9ad8ff', line: '#ffffff', glowPx: 12, weight: 1.9 };
    },

    _strokeSel(ctx, app, color, weight) {
        ctx.strokeStyle = color;
        ctx.fillStyle = 'transparent';
        ctx.lineWidth = this._selHair(app, weight);
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
    },

    _lightOn(ctx, theme) {
        ctx.shadowColor = theme.glow;
        ctx.shadowBlur = theme.glowPx;
        ctx.strokeStyle = theme.line;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.setLineDash([]);
    },

    _drawCornerBrackets(ctx, x, y, w, h) {
        if (!(w > 0) || !(h > 0)) return;
        const len = Math.min(Math.max(0.4, Math.min(w, h) * 0.22), Math.min(w, h) * 0.45);
        ctx.beginPath();
        ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
        ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
        ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
        ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len);
        ctx.stroke();
    },

    _drawLitRect(ctx, app, x, y, w, h, mode) {
        const t = this._selTheme(mode);
        ctx.shadowBlur = 0;
        ctx.fillStyle = t.fill;
        ctx.fillRect(x, y, w, h);
        this._lightOn(ctx, t);
        ctx.lineWidth = this._selHair(app, t.weight);
        ctx.strokeRect(x, y, w, h);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = t.line;
        ctx.lineWidth = this._selHair(app, t.weight + 0.2);
        this._drawCornerBrackets(ctx, x, y, w, h);
    },

    _drawLitPath(ctx, app, points, mode, width) {
        if (!points || points.length < 2) return;
        const t = this._selTheme(mode);
        ctx.beginPath();
        points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        this._lightOn(ctx, t);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = (Number(width) > 0 ? Number(width) : 0.5) + this._selHair(app, 3.2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = this._selHair(app, t.weight);
        ctx.stroke();
        ctx.shadowBlur = 0;
    },

    _drawHandleSquare(ctx, app, x, y, mode) {
        const t = this._selTheme(mode || 'select');
        const s = 2.6 / Math.max(app.view.zoom, 0.01);
        ctx.shadowBlur = 0;
        ctx.fillStyle = t.line;
        ctx.strokeStyle = t.glow;
        ctx.lineWidth = this._selHair(app, 1.2);
        ctx.fillRect(x - s, y - s, s * 2, s * 2);
        ctx.strokeRect(x - s, y - s, s * 2, s * 2);
    },

    _drawCompBrackets(ctx, app, comp, mode) {
        const size = app.getCompSize(comp);
        if (!size) return;
        const pins = (comp.pins && comp.pins.length) ? comp.pins : size.pins;
        ctx.save();
        ctx.translate(comp.x, comp.y);
        ctx.rotate((comp.rotation || 0) * Math.PI / 180);
        if (size.jkind === 'wire' && pins && pins.length >= 2) {
            this._drawLitPath(ctx, app, [{ x: pins[0].x, y: pins[0].y }, { x: pins[1].x, y: pins[1].y }], mode, 0.2);
            pins.forEach(p => this._drawHandleSquare(ctx, app, p.x, p.y, mode));
        } else {
            const pad = 0.22;
            this._drawLitRect(ctx, app, -size.width / 2 - pad, -size.height / 2 - pad, size.width + pad * 2, size.height + pad * 2, mode);
        }
        ctx.restore();
    },

    drawMultiSelection(ctx, app) {
        const sel = app.interaction.selectedObjects;
        if (!sel || sel.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const comp of sel) {
            const size = app.getCompSize(comp);
            if (!size) continue;
            const hw = size.width / 2 + 0.25, hh = size.height / 2 + 0.25;
            const rad = ((comp.rotation || 0) * Math.PI) / 180;
            const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
            const extW = hw * cos + hh * sin;
            const extH = hw * sin + hh * cos;
            minX = Math.min(minX, comp.x - extW);
            minY = Math.min(minY, comp.y - extH);
            maxX = Math.max(maxX, comp.x + extW);
            maxY = Math.max(maxY, comp.y + extH);
            this._drawCompBrackets(ctx, app, comp, 'multi');
        }
        if (minX === Infinity) return;
        ctx.save();
        this._drawLitRect(ctx, app, minX, minY, maxX - minX, maxY - minY, 'multi');
        const gids = sel.map(c => c.groupId).filter(Boolean);
        if (gids.length === sel.length && gids.length > 0) {
            const fs = 10 / Math.max(app.view.zoom, 0.01);
            ctx.font = fs.toFixed(2) + 'px sans-serif';
            ctx.fillStyle = '#f4fbff';
            ctx.shadowColor = '#7ec8ff';
            ctx.shadowBlur = 6;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText('GROUP', minX, minY - 0.3);
            ctx.shadowBlur = 0;
        }
        ctx.restore();
    },

    drawRubberBand(ctx, app) {
        const rb = app.interaction.rubberBand;
        if (!rb) return;
        const x = Math.min(rb.startX, rb.endX);
        const y = Math.min(rb.startY, rb.endY);
        const w = Math.abs(rb.endX - rb.startX);
        const h = Math.abs(rb.endY - rb.startY);
        ctx.save();
        ctx.fillStyle = 'rgba(160,215,255,0.10)';
        ctx.fillRect(x, y, w, h);
        const t = this._selTheme('hover');
        this._lightOn(ctx, t);
        ctx.lineWidth = this._selHair(app, 1.4);
        ctx.strokeRect(x, y, w, h);
        ctx.shadowBlur = 0;
        ctx.restore();
    },

    drawSelection(ctx, app) {
        const sel = app.interaction.selectedObject;
        if (!sel || !sel.obj) return;
        const obj = sel.obj;

        const segInfo = app.interaction.selectedSegment;
        if (segInfo && obj.points && obj.id === segInfo.traceId && segInfo.segIndex < obj.points.length - 1) {
            const p0 = obj.points[segInfo.segIndex];
            const p1 = obj.points[segInfo.segIndex + 1];
            this._drawLitPath(ctx, app, [p0, p1], 'select', obj.width);
            this._drawHandleSquare(ctx, app, p0.x, p0.y, 'select');
            this._drawHandleSquare(ctx, app, p1.x, p1.y, 'select');
        }

        if (sel.type === 'compSilk' && sel.obj) {
            const comp = sel.obj;
            const size = app.getCompSize(comp);
            if (size) {
                app.ensureCompSilkLayout(comp);
                const isValue = sel.field === 'value';
                const pos = isValue ? comp.silkValue : comp.silkLabel;
                const text = ((isValue ? comp.value : comp.label) || '').trim();
                if (text) {
                    const wp = app.compSilkLocalToWorld(comp, pos.x, pos.y);
                    const ffs = app.compSilkEffectiveFontSize(pos, size);
                    const tw = text.length * ffs * 0.55 + 0.6;
                    const th = ffs + 0.4;
                    const by = isValue ? -0.15 : -th + 0.15;
                    ctx.save();
                    ctx.translate(wp.x, wp.y);
                    ctx.rotate(((comp.rotation || 0) + (pos.rotation || 0)) * Math.PI / 180);
                    this._drawLitRect(ctx, app, -tw / 2, by, tw, th, 'select');
                    ctx.restore();
                }
            }
        } else if (sel.type === 'component' || (obj.x !== undefined && ComponentDefs.get(obj.type))) {
            this._drawCompBrackets(ctx, app, obj, 'select');
        } else if (sel.type === 'via' || obj.diameter !== undefined) {
            const r = (obj.diameter || 1) / 2 + 0.2;
            ctx.save();
            ctx.translate(obj.x, obj.y);
            this._drawLitRect(ctx, app, -r, -r, r * 2, r * 2, 'select');
            ctx.restore();
        } else if (obj.points) {
            this._drawLitPath(ctx, app, obj.points, 'select', obj.width);
        }
    },

    drawContextHighlight(ctx, app) {
        const target = app.interaction.contextTarget;
        if (!target || !target.obj) return;
        const obj = target.obj;
        if (target.type === 'component') {
            this._drawCompBrackets(ctx, app, obj, 'context');
        } else if (target.type === 'via') {
            const r = (obj.diameter || 1) / 2 + 0.2;
            ctx.save();
            ctx.translate(obj.x, obj.y);
            this._drawLitRect(ctx, app, -r, -r, r * 2, r * 2, 'context');
            ctx.restore();
        } else if (target.type === 'trace' && obj.points) {
            this._drawLitPath(ctx, app, obj.points, 'context', obj.width);
        }
    },

    drawHoverHighlight(ctx, app) {
        const comp = app.interaction.hoveredComp;
        if (!comp) return;
        this._drawCompBrackets(ctx, app, comp, 'hover');
    },

    getNetColor(app, netName) {
        const net = app.nets.find(n => n.name === netName);
        return net ? net.color : '#888888';
    },

    // ---- KiCad imported-footprint rendering (exact pads + fab/silk graphics) ----
    _kxPadPath(ctx, p) {
        ctx.beginPath();
        if (p.shape === 'circle' || p.shape === 'hole') {
            const r = Math.max(p.w, p.h) / 2;
            ctx.arc(0, 0, r, 0, Math.PI * 2);
        } else if (p.shape === 'oval') {
            ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
        } else if (p.shape === 'roundrect') {
            const r = Math.min(p.w, p.h) * 0.25;
            this.roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, r);
        } else { // rect (default)
            ctx.rect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
    },

    _kxDrawGraphics(ctx, g, color) {
        if (!g || g.type == null) return;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        if (g.type === 'line') {
            ctx.lineWidth = Math.max(0.1, g.w || 0.1);
            ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
        } else if (g.type === 'rect') {
            const x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2);
            const w = Math.abs(g.x2 - g.x1), h = Math.abs(g.y2 - g.y1);
            ctx.lineWidth = Math.max(0.1, g.w || 0.1);
            ctx.strokeRect(x, y, w, h);
        } else if (g.type === 'circle') {
            ctx.lineWidth = Math.max(0.1, g.w || 0.1);
            ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2); ctx.stroke();
        } else if (g.type === 'arc' && g.r > 0) {
            ctx.lineWidth = Math.max(0.1, g.w || 0.1);
            ctx.beginPath();
            ctx.arc(g.x, g.y, g.r, g.a0, g.a0 + (g.sweep || 0), (g.sweep || 0) < 0);
            ctx.stroke();
        } else if (g.type === 'poly' && g.pts && g.pts.length) {
            ctx.lineWidth = Math.max(0.1, g.w || 0.1);
            ctx.beginPath();
            ctx.moveTo(g.pts[0].x, g.pts[0].y);
            for (let i = 1; i < g.pts.length; i++) ctx.lineTo(g.pts[i].x, g.pts[i].y);
            ctx.closePath();
            if (g.fill) ctx.fill();
            ctx.stroke();
        }
    },

    drawKicadFootprint(ctx, size, app, comp) {
        const k = size.kicad;
        const pads = k.pads || [];
        pads.forEach(p => {
            ctx.save();
            ctx.translate(p.x, p.y);
            if (p.rot) ctx.rotate(p.rot * Math.PI / 180);
            this._kxPadPath(ctx, p);
            ctx.fillStyle = (comp.layer === 'bottom') ? '#6ea3c9' : '#d4a843';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.55)';
            ctx.lineWidth = 0.12;
            ctx.stroke();
            if (p.type === 'thru_hole') {
                ctx.fillStyle = '#0a0a1a';
                if (p.drillOval) {
                    ctx.beginPath(); ctx.ellipse(0, 0, p.drillOval.w / 2, p.drillOval.h / 2, 0, 0, Math.PI * 2); ctx.fill();
                } else if (p.drill) {
                    ctx.beginPath(); ctx.arc(0, 0, p.drill / 2, 0, Math.PI * 2); ctx.fill();
                }
            }
            ctx.restore();
        });
    },

    _padPinMinSpacing(pins) {
        let minD = Infinity;
        for (let a = 0; a < pins.length; a++) {
            for (let b = a + 1; b < pins.length; b++) {
                const d = Math.hypot(pins[a].x - pins[b].x, pins[a].y - pins[b].y);
                if (d > 0.2 && d < minD) minD = d;
            }
        }
        return isFinite(minD) ? minD : 2.54;
    },

    _padHalfForPin(size, pin, minD, along) {
        const pads = size.kicad && size.kicad.pads;
        if (pads && pads.length) {
            let best = pads[0], bd = Infinity;
            for (let i = 0; i < pads.length; i++) {
                const d = Math.hypot(pads[i].x - pin.x, pads[i].y - pin.y);
                if (d < bd) { bd = d; best = pads[i]; }
            }
            return Math.max(0.2, (along ? best.w : best.h) / 2);
        }
        if (this.isTH(size)) return size.padR || Math.max(0.35, Math.min(1.0, minD * 0.4));
        return Math.max(0.28, Math.min(minD * 0.28, 1.1));
    },

    // Pin names sit off the copper. 2-pin polarity (A/K, +/-) goes outside the
    // body; 3+ pin names sit just inside the pad toward the body.
    _drawPadPinLabels(ctx, size, pins) {
        if (!pins || pins.length < 2) return;
        const numeric = n => /^\d+$/.test(String(n || ''));
        if (pins.length === 2 && pins.every(p => numeric(p.name))) return;
        const twoPin = pins.length === 2;
        const minD = this._padPinMinSpacing(pins);
        const hw = (size.width || 0) / 2, hh = (size.height || 0) / 2;
        ctx.fillStyle = 'rgba(232,238,244,0.95)';
        ctx.textBaseline = 'middle';
        pins.forEach(pin => {
            const name = String(pin.name || '').trim();
            if (!name) return;
            let fs = Math.max(twoPin ? 0.5 : 0.38, Math.min(0.62, minD * 0.22));
            const maxW = Math.max(minD * 0.82, 1.2);
            if (name.length * fs * 0.58 > maxW) {
                fs = maxW / (name.length * 0.58);
                if (fs < 0.32) return;
            }
            const along = Math.abs(pin.x) >= Math.abs(pin.y);
            const padH = this._padHalfForPin(size, pin, minD, along);
            ctx.font = fs.toFixed(2) + 'px sans-serif';
            if (twoPin) {
                const outX = pin.x === 0 ? 0 : Math.sign(pin.x);
                const outY = pin.y === 0 ? 0 : Math.sign(pin.y);
                if (along && outX) {
                    const dist = Math.max(padH, hw - Math.abs(pin.x)) + fs * 0.4 + 0.12;
                    ctx.textAlign = outX > 0 ? 'left' : 'right';
                    ctx.fillText(name, pin.x + outX * dist, pin.y);
                } else if (outY) {
                    const dist = Math.max(padH, hh - Math.abs(pin.y)) + fs * 0.5 + 0.12;
                    ctx.textAlign = 'center';
                    ctx.fillText(name, pin.x, pin.y + outY * dist);
                }
                return;
            }
            const inwardX = pin.x === 0 ? 0 : -Math.sign(pin.x);
            const inwardY = pin.y === 0 ? 0 : -Math.sign(pin.y);
            const dist = padH + fs * 0.28 + 0.12;
            if (along && inwardX) {
                ctx.textAlign = inwardX < 0 ? 'right' : 'left';
                ctx.fillText(name, pin.x + inwardX * dist, pin.y);
            } else if (inwardY) {
                ctx.textAlign = 'center';
                ctx.fillText(name, pin.x, pin.y + inwardY * dist);
            } else {
                ctx.textAlign = 'center';
                ctx.fillText(name, pin.x, pin.y - dist);
            }
        });
    },

    // Positive lead of a polarised capacitor. KiCad radial pin 1 is +.
    // Built-in electrolytics mark + on the pin named "+", otherwise the right-hand lead.
    _electrolyticPlusPin(size, pins) {
        if (!pins || pins.length < 2) return null;
        const named = pins.find(p => p.name === '+');
        if (named) return named;
        const blob = ((size && size.name) || '') + ' ' + ((size && size.kicad && size.kicad.name) || '');
        if (!/electrolytic|cp_radial|c_radial|radial_d/i.test(blob)) return null;
        if (size && size.kicad) return pins.find(p => String(p.name) === '1') || pins[0];
        return pins.slice().sort((a, b) => b.x - a.x)[0];
    },

    // "+" sits on the can, inboard of the positive pad, so polarity is readable on silk.
    _drawPlusMark(ctx, pin) {
        if (!pin) return;
        const ox = pin.x === 0 ? 0 : Math.sign(pin.x);
        const oy = pin.y === 0 ? 0 : Math.sign(pin.y);
        ctx.save();
        ctx.fillStyle = 'rgba(232,238,244,0.95)';
        ctx.font = 'bold 1.4px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', pin.x - ox * 1.8, pin.y - oy * 1.8);
        ctx.restore();
    },

    _skipKicadSilkText(t, pads, pins, comp) {
        const s = String(t.text || '').trim();
        if (!s) return true;
        if (s === '+' || s === '-' || s === '±') return false;
        if (/^(REF\*\*?|\*{0,2}VALUE\*{0,2}|%R|%V)$/i.test(s)) return true;
        const lab = ((comp && comp.label) || '').trim();
        const val = ((comp && comp.value) || '').trim();
        if (lab && s.toUpperCase() === lab.toUpperCase()) return true;
        if (val && s.toUpperCase() === val.toUpperCase()) return true;
        const up = s.toUpperCase();
        if (pins && pins.some(p => String(p.name || '').toUpperCase() === up)) return true;
        if (pads && pads.some(p => {
            const hw = (p.w || 1) / 2 + 0.3, hh = (p.h || 1) / 2 + 0.3;
            return Math.abs((t.x || 0) - (p.x || 0)) <= hw && Math.abs((t.y || 0) - (p.y || 0)) <= hh;
        })) return true;
        return false;
    },

    drawKicadSilkGraphics(ctx, size, app, comp) {
        const k = size.kicad;
        const pads = k.pads || [];
        const pins = (comp && comp.pins) || size.pins || [];

        if (k.silk) k.silk.forEach(g => this._kxDrawGraphics(ctx, g, 'rgba(255,255,255,0.85)'));
        if (k.fab) k.fab.forEach(g => this._kxDrawGraphics(ctx, g, 'rgba(255,255,255,0.45)'));
        this._drawPlusMark(ctx, this._electrolyticPlusPin(size, pins));
        if (k.texts) {
            k.texts.forEach(t => {
                if (this._skipKicadSilkText(t, pads, pins, comp)) return;
                const fs = Math.min(0.7, Math.max(0.4, t.size || 0.55));
                ctx.save();
                ctx.translate(t.x, t.y);
                ctx.font = fs.toFixed(2) + 'px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.88)';
                ctx.textAlign = t.justify === 'left' ? 'left' : (t.justify === 'right' ? 'right' : 'center');
                ctx.textBaseline = 'middle';
                ctx.fillText(t.text, 0, 0);
                ctx.restore();
            });
        }

        this._drawPadPinLabels(ctx, size, pins);
    },

    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
};

