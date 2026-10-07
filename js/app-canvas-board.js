// ============================================================
// Board Canvas Mouse / Wheel / Context Menu Events
// ============================================================

Object.assign(App, {
    bindCanvasEvents() {
        const canvas = this.boardCanvas;
        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 2) return;
            // Collaboration lock: block board edits while agents collaborate (panning/zoom stay).
            if (this.editLocked && e.button === 0) { if (typeof this.setStatus === 'function') this.setStatus('Editing locked — an agent is collaborating. Use Unlock to edit.'); return; }
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = this.screenToWorld(sx, sy);

            // Middle-mouse panning / click-to-rotate
            if (e.button === 1) {
                e.preventDefault();
                this.interaction.isPanning = true;
                this.interaction.panStartX = sx;
                this.interaction.panStartY = sy;
                this.interaction._midClickStartX = sx;
                this.interaction._midClickStartY = sy;
                return;
            }

            // Placing component from palette (takes priority over tool)
            if (this.interaction.placingComponent) {
                const type = this.interaction.placingComponent;
                const def = ComponentDefs.get(type);
                const sizeIdx = (this.interaction.placingSize && this.interaction.placingSize[type] !== undefined) ? this.interaction.placingSize[type] : def.defaultSize;
                const size = ComponentDefs.getSize(def, sizeIdx);
                if (!size || !size.pins) {
                    this.setStatus('Cannot place: missing footprint');
                    return;
                }
                let px = world.x, py = world.y, rot = this.interaction.placingRotation || 0, span = null;
                if (!(type === 'jumper' && size.jkind === 'wire')) {
                    // Commit exactly where the ghost preview sits (grid snap + magnetic alignment).
                    const pv = this.placePreviewAt(world.x, world.y);
                    if (pv) { px = pv.x; py = pv.y; }
                }
                if (type === 'jumper' && size.jkind === 'wire') {
                    // Wire jumper: two clicks define the solder-hole centres.
                    // Each click snaps magnetically to pads / vias / trace ends, grid otherwise.
                    const gp = this.snapJumperEnd(world.x, world.y);
                    const gx = gp.x, gy = gp.y;
                    const f = this.interaction.jumperFirst;
                    if (!f) {
                        this.interaction.jumperFirst = { x: gx, y: gy };
                        this.setStatus('Wire jumper: click the other solder hole (snaps to pads & trace ends)');
                        this.render();
                        return;
                    }
                    span = Math.hypot(gx - f.x, gy - f.y);
                    const pr = Math.max(0.35, Math.min(1.0, (span || 10) * 0.4));
                    if (span < 2 * pr + (this.params.minClearance || 0.38)) {
                        this.setStatus('Jumper too short — click farther away');
                        this.render();
                        return;
                    }
                    px = (f.x + gx) / 2; py = (f.y + gy) / 2;
                    rot = Math.atan2(gy - f.y, gx - f.x) * 180 / Math.PI;
                }
                const value = (size.value !== undefined && size.value !== null) ? String(size.value)
                    : ((def.defaultValue !== undefined && def.defaultValue !== null) ? String(def.defaultValue) : '');
                const comp = { id: this.nextId(), type, x: px, y: py, rotation: Math.round(rot), value, label: def.prefix + (this.components.filter(c => c.type === type).length + 1), size: sizeIdx, pins: size.pins.map(p => ({ ...p })) };
                if (span !== null) {
                    comp.span = span;
                    const half = span / 2;
                    comp.pins = [{ x: -half, y: 0, name: '1' }, { x: half, y: 0, name: '2' }];
                }
                this.components.push(comp);
                this.ensureSchemPositions();
                this.ensureLabels();
                this.ensureCompSilkLayout(comp);
                this.interaction.placingRotation = 0;
                this.interaction.placingComponent = null;
                this.interaction.jumperFirst = null;
                this.interaction.placingJumperKind = null;
                document.querySelectorAll('.comp-item').forEach(i => i.classList.remove('placing-active'));
                this.saveState();
                if (type === 'jumper' && this.ensureWireJumperJoints) this.ensureWireJumperJoints();
                this.render();
                return;
            }

            if (this.view.tool === 'select') {
                if (this.ensureWireJumperJoints) this.ensureWireJumperJoints();
                const tvHit = this.hitTraceVertex(world.x, world.y);
                if (tvHit) {
                    // Ctrl/Shift+click toggles this joint in/out of the multi-select set.
                    if (e.ctrlKey || e.shiftKey) {
                        if (!this.interaction.selectedVertices) this.interaction.selectedVertices = [];
                        const isSel = v => v.traceId === tvHit.traceId && v.pointIndex === tvHit.pointIndex;
                        if (this.interaction.selectedVertices.find(isSel)) {
                            this.interaction.selectedVertices = this.interaction.selectedVertices.filter(v => !isSel(v));
                        } else {
                            this.interaction.selectedVertices.push({ traceId: tvHit.traceId, pointIndex: tvHit.pointIndex });
                        }
                        this.interaction.selectedObject = null;
                        this.render();
                        return;
                    }
                    // Plain click collapses any joint multi-select to this single vertex.
                    if (this.interaction.selectedVertices && this.interaction.selectedVertices.length) this.interaction.selectedVertices = [];
                    this.interaction.selectedObject = { type: 'traceVertex', traceId: tvHit.traceId, pointIndex: tvHit.pointIndex };
                    this.interaction.selectedObjects = null;
                    this.interaction.selectedSegment = null;
                    this.interaction.draggingVertex = { ...tvHit, startWorld: { x: world.x, y: world.y } };
                    const trace = this.traces.find(t => t.id === tvHit.traceId);
                    if (trace) this.showProperties(trace, tvHit.pointIndex - 1);
                    return;
                }
                for (const c of this.components) {
                    const compLayer = c.layer || 'top';
                    const silkVisible = (compLayer === 'top' && this.view.visibleLayers.silkTop) ||
                        (compLayer === 'bottom' && this.view.visibleLayers.silkBottom);
                    if (!silkVisible) continue;
                    const silkHit = this.hitCompSilk(c, world.x, world.y);
                    if (silkHit) {
                        this.interaction.selectedObject = { type: 'compSilk', compId: silkHit.compId, field: silkHit.field, obj: silkHit.comp };
                        this.interaction.draggingSilk = { compId: silkHit.compId, field: silkHit.field };
                        this.showProperties(silkHit.comp);
                        return;
                    }
                }
                const viaHit = this.hitVia(world.x, world.y);
                if (viaHit) {
                    this.interaction.selectedObject = { type: 'via', obj: viaHit };
                    this.interaction.selectedObjects = null;
                    this.interaction.selectedSegment = null;
                    this.showProperties(viaHit);
                    return;
                }
                const traceHit = this.hitTrace(world.x, world.y);
                if (traceHit) {
                    const trace = traceHit.obj;
                    const segIndex = traceHit.segIndex;
                    const a = trace.points[segIndex], b = trace.points[segIndex + 1];
                    const axis = this.segmentDragAxis(a, b);
                    this.interaction.selectedObject = { type: 'trace', obj: trace };
                    this.interaction.selectedObjects = null;
                    this.interaction.selectedSegment = { traceId: trace.id, segIndex };
                    this.interaction.draggingSegment = {
                        traceId: trace.id, segIndex, axis, prepared: false,
                        startX: world.x, startY: world.y,
                        origP0: { x: a.x, y: a.y }, origP1: { x: b.x, y: b.y }
                    };
                    this.showProperties(trace, segIndex);
                    return;
                }
                const wjHit = this.hitWireJumper(world.x, world.y);
                if (wjHit) {
                    this.interaction.selectedObject = { type: 'component', obj: wjHit.comp };
                    this.interaction.selectedObjects = null;
                    this.interaction.selectedSegment = null;
                    this.showProperties(wjHit.comp);
                    if (wjHit.part === 'hole') {
                        this.interaction.draggingJumperEnd = { compId: wjHit.comp.id, holeIndex: wjHit.holeIndex };
                    } else {
                        this.interaction.draggingComp = wjHit.comp;
                        this.interaction.dragAllSelected = false;
                        this.interaction.dragOffsetX = world.x - wjHit.comp.x;
                        this.interaction.dragOffsetY = world.y - wjHit.comp.y;
                    }
                    return;
                }
                const comp = this.hitComponent(world.x, world.y);
                if (comp) {
                    if (comp.groupId && !(e.ctrlKey || e.shiftKey)) {
                        this.interaction.selectedObjects = this.components.filter(cc => cc.groupId === comp.groupId);
                    }
                    // Multi-select with Ctrl/Shift or click on already-selected group
                    if (e.ctrlKey || e.shiftKey) {
                        if (!this.interaction.selectedObjects) this.interaction.selectedObjects = [];
                        const exists = this.interaction.selectedObjects.find(cc => cc.id === comp.id);
                        if (exists) this.interaction.selectedObjects = this.interaction.selectedObjects.filter(cc => cc.id !== comp.id);
                        else this.interaction.selectedObjects.push(comp);
                        this.interaction.draggingComp = comp;
                        this.interaction.dragAllSelected = true;
                        this.interaction.dragStartPositions = this.interaction.selectedObjects.map(cc => ({ id: cc.id, x: cc.x, y: cc.y }));
                    } else if (this.interaction.selectedObjects && this.interaction.selectedObjects.length > 0) {
                        const alreadyIn = this.interaction.selectedObjects.find(cc => cc.id === comp.id);
                        if (alreadyIn) {
                            this.interaction.draggingComp = comp;
                            this.interaction.dragAllSelected = true;
                            this.interaction.dragStartPositions = this.interaction.selectedObjects.map(cc => ({ id: cc.id, x: cc.x, y: cc.y }));
                        } else {
                            this.interaction.selectedObjects = comp.groupId ? this.components.filter(cc => cc.groupId === comp.groupId) : null;
                            this.interaction.selectedObject = { type: 'component', obj: comp };
                            this.interaction.draggingComp = comp;
                            this.interaction.dragAllSelected = !!(this.interaction.selectedObjects && this.interaction.selectedObjects.length > 1);
                            if (this.interaction.dragAllSelected) {
                                this.interaction.dragStartPositions = this.interaction.selectedObjects.map(cc => ({ id: cc.id, x: cc.x, y: cc.y }));
                            }
                        }
                    } else {
                        this.interaction.selectedObject = { type: 'component', obj: comp };
                        this.interaction.draggingComp = comp;
                        this.interaction.dragAllSelected = !!(this.interaction.selectedObjects && this.interaction.selectedObjects.length > 1);
                        if (this.interaction.dragAllSelected) {
                            this.interaction.dragStartPositions = this.interaction.selectedObjects.map(cc => ({ id: cc.id, x: cc.x, y: cc.y }));
                        }
                    }
                    this.interaction.selectedSegment = null;
                    this.interaction.dragOffsetX = world.x - comp.x;
                    this.interaction.dragOffsetY = world.y - comp.y;
                    this.showProperties(comp);
                    return;
                }
                // Empty space → start rubber-band select
                const zoneHit = this.hitZone(world.x, world.y);
                if (zoneHit) {
                    this.interaction.selectedObject = { type: 'zone', obj: zoneHit.zone };
                    this.interaction.selectedObjects = null;
                    this.interaction.selectedSegment = null;
                    this.interaction.draggingZone = {
                        zone: zoneHit.zone, part: zoneHit.part, corner: zoneHit.corner,
                        startX: world.x, startY: world.y,
                        origX: zoneHit.zone.x, origY: zoneHit.zone.y, origW: zoneHit.zone.w, origH: zoneHit.zone.h
                    };
                    this.setStatus(`Zone ${zoneHit.zone.name} — drag to ${zoneHit.part === 'move' ? 'move' : 'resize'}; Delete to remove`);
                    this.render();
                    return;
                }
                this.interaction.rubberBand = { startX: world.x, startY: world.y, endX: world.x, endY: world.y };
                this.render();
 } else if (this.view.tool === 'trace') {
 const snapped = this.snapTraceDrawPoint(world.x, world.y);
 let pt = { x: snapped.x, y: snapped.y };
 if (snapped.kind === 'edge' && snapped.trace) {
     const host = this._insertVertexInPlace(snapped.trace, snapped.segIndex, snapped.x, snapped.y, true);
     if (host) pt = host;
 } else if (snapped.kind === 'vertex' && snapped.trace) {
     const host = snapped.trace.points.find(p => Math.hypot(p.x - snapped.x, p.y - snapped.y) < 0.25);
     if (host) pt = host;
 }
 this.interaction.tracePoints.push(pt);
 this.interaction.traceSnapKind = snapped.kind;
 this.render();
 } else if (this.view.tool === 'outline') {
 this.interaction.outlinePoints.push({ x: world.x, y: world.y });
 this.render();
 } else if (this.view.tool === 'zone') {
 this.interaction.zoneDrag = { startX: world.x, startY: world.y, endX: world.x, endY: world.y };
 this.render();
 } else if (this.view.tool === 'via') {
 const via = { id: this.nextId(), x: world.x, y: world.y, diameter: this.params.viaDiameter };
 this.vias.push(via);
 this.saveState();
 this.render();
 } else if (this.view.tool === 'text') {
 const text = prompt('Silk text:');
 if (text) {
 this.silkTexts.push({ id: this.nextId(), text, x: world.x, y: world.y, layer: this.view.activeLayer || 'silkTop', size: 1.0 });
 this.saveState();
 this.render();
 }
 } else if (this.view.tool === 'delete') {
 this.deleteAt(world.x, world.y);
 }
 });
        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = this.screenToWorld(sx, sy);

            // Always update lastMouse in world coords (used by trace preview rendering)
            this.interaction.lastMouseX = world.x;
            this.interaction.lastMouseY = world.y;
            this.updateStatusCoords(world.x, world.y);
            if (this.interaction.placingComponent) {
                this.interaction._placingOnCanvas = true;
                this.interaction._placePreview = this.placePreviewAt(world.x, world.y);
            }
            if (this.view.tool === 'trace') {
                const s = this.snapTraceDrawPoint(world.x, world.y);
                this.interaction.lastMouseX = s.x;
                this.interaction.lastMouseY = s.y;
                this.interaction.traceSnapKind = s.kind;
            }

            // Panning (middle mouse)
            if (this.interaction.isPanning) {
                const dx = (sx - this.interaction.panStartX) / this.view.zoom;
                const dy = (sy - this.interaction.panStartY) / this.view.zoom;
                this.view.panX -= dx;
                this.view.panY -= dy;
                this.interaction.panStartX = sx;
                this.interaction.panStartY = sy;
                this.render();
                return;
            }

            // Dragging a trace segment (horizontal → up/down, vertical → left/right)
            if (this.interaction.draggingSegment) {
                const ds = this.interaction.draggingSegment;
                const trace = this.traces.find(t => t.id === ds.traceId);
                if (trace) {
                    const moved = Math.hypot(world.x - ds.startX, world.y - ds.startY);
                    if (!ds.prepared && moved > 0.15) {
                        ds.segIndex = this.prepareSegmentDrag(trace, ds.segIndex);
                        const a = trace.points[ds.segIndex], b = trace.points[ds.segIndex + 1];
                        ds.origP0 = { x: a.x, y: a.y };
                        ds.origP1 = { x: b.x, y: b.y };
                        ds.axis = this.segmentDragAxis(a, b);
                        ds.prepared = true;
                        this.interaction.selectedSegment = { traceId: trace.id, segIndex: ds.segIndex };
                    }
                    if (ds.prepared) {
                        this.applySegmentDrag(trace, ds.segIndex, ds.axis, ds.origP0, ds.origP1,
                            world.x - ds.startX, world.y - ds.startY);
                        const a = trace.points[ds.segIndex], b = trace.points[ds.segIndex + 1];
                        this.glueWireJumpersAt(ds.origP0, a);
                        this.glueWireJumpersAt(ds.origP1, b);
                    }
                    this.render();
                    return;
                }
            }

            // Dragging component silk label (designator or value)
            if (this.interaction.draggingSilk) {
                const comp = this.components.find(c => c.id === this.interaction.draggingSilk.compId);
                if (comp) {
                    this.ensureCompSilkLayout(comp);
                    const local = this.compSilkWorldToLocal(comp, world.x, world.y);
                    if (this.interaction.draggingSilk.field === 'label') {
                        comp.silkLabel.x = local.x;
                        comp.silkLabel.y = local.y;
                    } else {
                        comp.silkValue.x = local.x;
                        comp.silkValue.y = local.y;
                    }
                    this.render();
                }
            }

            if (this.interaction.draggingJumperEnd) {
                const dj = this.interaction.draggingJumperEnd;
                const jp = this.components.find(c => c.id === dj.compId);
                if (jp) {
                    const snap = this.snapJumperEnd(world.x, world.y);
                    this.moveWireJumperHole(jp, dj.holeIndex, snap.x, snap.y);
                    this.render();
                }
                return;
            }

            // Dragging component (single or multi)
            if (this.interaction.draggingComp) {
                const comp = this.interaction.draggingComp;
                const oldX = comp.x, oldY = comp.y;
                let nx = world.x - this.interaction.dragOffsetX;
                let ny = world.y - this.interaction.dragOffsetY;
                // Magnetic alignment to other components' edges/centres.
                // Single-part drags only (a multi-drag group moves rigidly; wire jumpers excluded).
                if (!this.isWireJumper(comp) && !this.interaction.dragAllSelected) {
                    // Grid first, then magnetic alignment wins where it fires (same order as placePreviewAt).
                    const gx = this.snapToGrid(nx), gy = this.snapToGrid(ny);
                    const a = this.alignPosToComps(gx, gy, comp, comp.id);
                    nx = a.x !== null ? a.x : gx;
                    ny = a.y !== null ? a.y : gy;
                    this.interaction._dragAlign = { lineX: a.lineX, lineY: a.lineY };
                } else {
                    this.interaction._dragAlign = null;
                }
                comp.x = nx;
                comp.y = ny;
                this.moveCompWithTraces(comp, oldX, oldY);
                // If multi-drag, move all selected components together (incremental per-frame)
                if (this.interaction.dragAllSelected && this.interaction.selectedObjects) {
                    const dx = comp.x - oldX, dy = comp.y - oldY;
                    for (const sc of this.interaction.selectedObjects) {
                        if (sc === comp) continue;
                        const prevX = sc.x, prevY = sc.y;
                        sc.x += dx;
                        sc.y += dy;
                        this.moveCompWithTraces(sc, prevX, prevY);
                    }
                }
                this.render();
            }

            // Rubber-band select in progress
            if (this.interaction.rubberBand) {
                this.interaction.rubberBand.endX = world.x;
                this.interaction.rubberBand.endY = world.y;
                this.render();
            }

            // Dragging trace vertex
            if (this.interaction.draggingVertex) {
                const dv = this.interaction.draggingVertex;
                const trace = this.traces.find(t => t.id === dv.traceId);
                if (trace) {
                    const snap = this.snapToCopper(world.x, world.y, { exceptId: trace.id, layer: trace.layer || 'top', preferTrace: true });
                    const p = snap || { x: this.snapToGrid(world.x), y: this.snapToGrid(world.y) };
                    const pt = trace.points[dv.pointIndex];
                    const prev = { x: pt.x, y: pt.y };
                    pt.x = p.x;
                    pt.y = p.y;
                    this.glueWireJumpersAt(prev, pt);
                    this.render();
                }
            }

            // Hover detection (select tool only). When it can't run (another tool
            // active, or a drag in flight) the stale hover is cleared instead —
            // otherwise BoardView keeps painting the old component's outline.
            const hoverBlocked = this.interaction.draggingComp || this.interaction.draggingJumperEnd ||
                this.interaction.draggingVertex || this.interaction.draggingSilk || this.interaction.draggingSegment;
            if (this.view.tool === 'select' && !hoverBlocked) {
                if (this.ensureWireJumperJoints) this.ensureWireJumperJoints();
                const hoverVtx = this.hitTraceVertex(world.x, world.y);
                const nextVtx = hoverVtx ? { traceId: hoverVtx.traceId, pointIndex: hoverVtx.pointIndex } : null;
                const hoverSeg = hoverVtx ? null : this.hitTrace(world.x, world.y);
                const nextHover = hoverSeg ? { traceId: hoverSeg.obj.id, segIndex: hoverSeg.segIndex } : null;
                const prev = this.interaction.hoveredSegment;
                const prevVtx = this.interaction.hoveredTraceVertex;
                const hoverChanged = (!prev && nextHover) || (prev && !nextHover) ||
                    (prev && nextHover && (prev.traceId !== nextHover.traceId || prev.segIndex !== nextHover.segIndex)) ||
                    (!prevVtx && nextVtx) || (prevVtx && !nextVtx) ||
                    (prevVtx && nextVtx && (prevVtx.traceId !== nextVtx.traceId || prevVtx.pointIndex !== nextVtx.pointIndex));
                this.interaction.hoveredSegment = nextHover;
                this.interaction.hoveredTraceVertex = nextVtx;
                const hoverComp = (nextHover || nextVtx) ? null : this.hitComponent(world.x, world.y);
                const wjHover = (nextHover || nextVtx) ? null : this.hitWireJumper(world.x, world.y);
                if (hoverComp !== this.interaction.hoveredComp || hoverChanged) {
                    this.interaction.hoveredComp = hoverComp;
                    if (nextVtx) canvas.style.cursor = 'pointer';
                    else if (nextHover) {
                        const t = hoverSeg.obj;
                        const p0 = t.points[nextHover.segIndex], p1 = t.points[nextHover.segIndex + 1];
                        const axis = this.segmentDragAxis(p0, p1);
                        canvas.style.cursor = axis === 'h' ? 'ns-resize' : (axis === 'v' ? 'ew-resize' : 'move');
                    } else if (wjHover && wjHover.part === 'hole') canvas.style.cursor = 'pointer';
                    else canvas.style.cursor = hoverComp ? 'move' : 'default';
                    this.render();
                }
            } else if (hoverBlocked || this.view.tool !== 'select') {
                if (this.interaction.hoveredComp || this.interaction.hoveredSegment || this.interaction.hoveredTraceVertex) {
                    this.interaction.hoveredComp = null;
                    this.interaction.hoveredSegment = null;
                    this.interaction.hoveredTraceVertex = null;
                    this.render();
                }
            }

            // Trace / outline / placing preview rendered via lastMouseX/Y in board-view.js
            if (this.view.tool === 'trace' || this.view.tool === 'outline' || this.interaction.placingComponent) {
                this.render();
            }
            if (this.interaction.zoneDrag) {
                this.interaction.zoneDrag.endX = world.x;
                this.interaction.zoneDrag.endY = world.y;
                this.render();
            }
            if (this.interaction.draggingZone) {
                const dz = this.interaction.draggingZone;
                const dx = world.x - dz.startX, dy = world.y - dz.startY;
                if (dz.part === 'move') {
                    dz.zone.x = dz.origX + dx;
                    dz.zone.y = dz.origY + dy;
                } else {
                    // Resize from the grabbed corner: keep the opposite corner fixed.
                    const x1 = dz.origX - dz.origW / 2, y1 = dz.origY - dz.origH / 2;
                    const x2 = dz.origX + dz.origW / 2, y2 = dz.origY + dz.origH / 2;
                    if (dz.corner === 0) { x1 = x1 + dx; y1 = y1 + dy; }
                    else if (dz.corner === 1) { x2 = x2 + dx; y1 = y1 + dy; }
                    else if (dz.corner === 2) { x2 = x2 + dx; y2 = y2 + dy; }
                    else { x1 = x1 + dx; y2 = y2 + dy; }
                    dz.zone.w = Math.max(2, Math.abs(x2 - x1));
                    dz.zone.h = Math.max(2, Math.abs(y2 - y1));
                    dz.zone.x = (x1 + x2) / 2;
                    dz.zone.y = (y1 + y2) / 2;
                }
                this.render();
            }
        });

        canvas.addEventListener('mouseleave', () => {
            // Drop the placement ghost while the cursor is off the canvas.
            if (this.interaction.placingComponent) {
                this.interaction._placingOnCanvas = false;
                this.interaction._placePreview = null;
                this.render();
            }
        });

        canvas.addEventListener('mouseup', (e) => {
            // Middle-click rotate: if mouse didn't move much, treat as rotate
            if (e.button === 1 && this.interaction._midClickStartX !== undefined) {
                const dx = e.clientX - this.interaction._midClickStartX;
                const dy = e.clientY - this.interaction._midClickStartY;
                if (Math.sqrt(dx*dx+dy*dy) < 4) {
                    const rect = canvas.getBoundingClientRect();
                    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
                    const world = this.screenToWorld(sx, sy);
                    const comp = this.hitComponent(world.x, world.y) || (this.interaction.selectedObject && this.interaction.selectedObject.type === 'component' ? this.interaction.selectedObject.obj : null);
                    if (comp && !this.isWireJumper(comp)) { const newRot = ((comp.rotation||0)+90)%360; this.rotateCompWithTraces(comp, newRot); this.saveState(); this.render(); this.showProperties(comp); }
                }
                this.interaction._midClickStartX = undefined;
                this.interaction._midClickStartY = undefined;
            }
            // Finalize rubber-band select
            if (this.interaction.rubberBand) {
                const rb = this.interaction.rubberBand;
                const rx1 = Math.min(rb.startX, rb.endX), ry1 = Math.min(rb.startY, rb.endY);
                const rx2 = Math.max(rb.startX, rb.endX), ry2 = Math.max(rb.startY, rb.endY);
                if (Math.abs(rx2 - rx1) > 0.5 || Math.abs(ry2 - ry1) > 0.5) {
                    const selected = this.components.filter(comp => {
                        const size = this.getCompSize(comp);
                        const hw = size ? size.width / 2 : 0.5, hh = size ? size.height / 2 : 0.5;
                        return comp.x + hw >= rx1 && comp.x - hw <= rx2 && comp.y + hh >= ry1 && comp.y - hh <= ry2;
                    });
                    if (selected.length > 0) {
                        this.interaction.selectedObjects = selected;
                        this.interaction.selectedObject = null;
                        this.showProperties(selected[0]);
                    } else {
                        this.interaction.selectedObject = null;
                        this.interaction.selectedObjects = null;
                        document.getElementById('properties-content').innerHTML = '<p class="hint">Select an object to see its properties.</p>';
                    }
                } else {
                    this.interaction.selectedObject = null;
                    this.interaction.selectedObjects = null;
                    document.getElementById('properties-content').innerHTML = '<p class="hint">Select an object to see its properties.</p>';
                }
                this.interaction.rubberBand = null;
                this.render();
            }
            if (this.interaction.isPanning) {
                this.interaction.isPanning = false;
            }
            if (this.interaction.zoneDrag) {
                const zd = this.interaction.zoneDrag;
                const x1 = Math.min(zd.startX, zd.endX), x2 = Math.max(zd.startX, zd.endX);
                const y1 = Math.min(zd.startY, zd.endY), y2 = Math.max(zd.startY, zd.endY);
                this.interaction.zoneDrag = null;
                if (x2 - x1 >= 2 && y2 - y1 >= 2) {
                    const id = (this.zones || []).reduce((m, z) => Math.max(m, z.id), 0) + 1;
                    this.zones = this.zones || [];
                    this.zones.push({ id, name: `Zone ${id}`, x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 });
                    this.saveState();
                    this.setStatus(`Zone ${id} drawn — select components, then Assign sel.`);
                    if (this.renderPlanPanel) this.renderPlanPanel();
                }
                this.render();
            }
            if (this.interaction.draggingZone) {
                this.saveState();
                this.interaction.draggingZone = null;
                if (this.renderPlanPanel) this.renderPlanPanel();
                this.render();
            }
            if (this.interaction.draggingJumperEnd) {
                this.saveState();
                this.interaction.draggingJumperEnd = null;
            }
            if (this.interaction.draggingComp) {
                this.saveState();
                this.interaction.draggingComp = null;
                this.interaction._dragAlign = null;
                this.interaction.dragAllSelected = false;
                this.interaction.dragStartPositions = null;
            }
            if (this.interaction.draggingVertex) {
                const dv = this.interaction.draggingVertex;
                const trace = this.traces.find(t => t.id === dv.traceId);
                if (trace && trace.points[dv.pointIndex]) {
                    this.joinPointOntoCopper(trace.points[dv.pointIndex], trace);
                    this.ensureCopperJunctionVertices(trace);
                    this.anchorJumperPinsToTrace(trace);
                }
                this.saveState();
                this.interaction.draggingVertex = null;
            }
            if (this.interaction.draggingSegment) {
                const ds = this.interaction.draggingSegment;
                const trace = this.traces.find(t => t.id === ds.traceId);
                if (trace) {
                    this.ensureCopperJunctionVertices(trace);
                    this.anchorJumperPinsToTrace(trace);
                }
                this.saveState();
                this.interaction.draggingSegment = null;
            }
            if (this.interaction.draggingSilk) {
                this.saveState();
                const sel = this.interaction.selectedObject;
                if (sel && sel.type === 'compSilk' && sel.obj) this.showProperties(sel.obj); // refresh X/Y fields after the drag
                this.interaction.draggingSilk = null;
            }
        });
        canvas.addEventListener('dblclick', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = this.screenToWorld(sx, sy);

            if (this.view.tool === 'trace' && this.interaction.tracePoints.length >= 2) {
                this.finishTrace();
            } else if (this.view.tool === 'select') {
                const tvHit = this.hitTraceVertex(world.x, world.y);
                if (tvHit) {
                    this.deleteTraceVertex(tvHit.traceId, tvHit.pointIndex);
                    return;
                }
                const traceHit = this.hitTrace(world.x, world.y);
                if (traceHit && traceHit.segIndex !== undefined) {
                    this.insertVertexInSegment(traceHit.obj.id, traceHit.segIndex, world.x, world.y);
                }
            }
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            // Get world point under cursor BEFORE zoom change
            const wx = this.screenToWorld(sx, sy).x;
            const wy = this.screenToWorld(sx, sy).y;
            // Smooth zoom proportional to scroll delta (handles mouse + trackpad)
            let delta = -e.deltaY;
            if (e.deltaMode === 1) delta *= 33;
            if (e.deltaMode === 2) delta *= canvas.clientHeight;
            const factor = Math.pow(1.001, delta);
            const newZoom = Math.min(Math.max(this.view.zoom * factor, 0.1), 40);
            // Adjust pan so world point under cursor stays fixed
            const cx = canvas.width / 2, cy = canvas.height / 2;
            this.view.panX = wx - (sx - cx) / newZoom;
            this.view.panY = wy - (sy - cy) / newZoom;
            this.view.zoom = newZoom;
            this.updateStatusZoom();
            this.render();
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = this.screenToWorld(sx, sy);
            const hit = this.hitAnyElement(world.x, world.y);
            if (hit && hit.type === 'trace' && hit.segIndex !== undefined) {
                this.interaction.selectedObjects = null;
                this.interaction.contextTarget = hit;
                this.interaction.selectedSegment = { traceId: hit.obj.id, segIndex: hit.segIndex };
                this.interaction.selectedObject = { type: 'trace', obj: hit.obj };
                this.showContextMenu(e.clientX - rect.left, e.clientY - rect.top);
                return;
            }
            if (this.interaction.selectedObjects && this.interaction.selectedObjects.length > 0) {
                this.interaction.contextTarget = { type: 'component', obj: this.interaction.selectedObjects[0] };
                this.showContextMenu(e.clientX - rect.left, e.clientY - rect.top);
                return;
            }
            if (this.interaction.selectedVertices && this.interaction.selectedVertices.length > 0) {
                this.interaction.contextTarget = { type: 'traceVertex', ...this.interaction.selectedVertices[0] };
                this.showContextMenu(e.clientX - rect.left, e.clientY - rect.top);
                return;
            }
            if (hit) {
                this.interaction.contextTarget = hit;
                this.showContextMenu(e.clientX - rect.left, e.clientY - rect.top);
            } else {
                this.hideContextMenu();
            }
        });
    }
});
