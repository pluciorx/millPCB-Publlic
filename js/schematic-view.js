// ============================================================
// Schematic View - Canvas Rendering
// ============================================================
const SchematicView = {
    // Symbol-local pin anchor points (px). Each entry maps to comp.pins[i] and
    // sits EXACTLY on the endpoint of that pin's drawn leg, so wires always meet
    // the leg edge. Returned array length === comp.pins.length.
    schemPinAnchors(comp) {
        const pins = (comp && comp.pins && comp.pins.length) ? comp.pins : [];
        const n = pins.length;
        if (this._isKicadImported(comp)) return this._kicadAnchors(n);
        let a;
        switch (comp.type) {
            case 'ic': {
                // Pins split left/right by index; legs exit the body at x=±35.
                const leftCount = Math.ceil(n / 2);
                const rightCount = n - leftCount;
                a = [];
                for (let i = 0; i < leftCount; i++) {
                    const t = leftCount > 1 ? i / (leftCount - 1) : 0.5;
                    a.push({ x: -35, y: -15 + t * 30 });
                }
                for (let j = 0; j < rightCount; j++) {
                    const t = rightCount > 1 ? j / (rightCount - 1) : 0.5;
                    a.push({ x: 35, y: -15 + t * 30 });
                }
                break;
            }
            case 'switch': {
                if (n <= 2) {
                    a = [];
                    for (let i = 0; i < Math.max(n, 1); i++) {
                        const t = n > 1 ? i / (n - 1) : 0.5;
                        a.push({ x: -30 + t * 60, y: 0 });
                    }
                    break;
                }
                const xs = pins.map(p => p.x);
                const mid = xs.length ? (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 : 0;
                const left = [], right = [];
                pins.forEach((p, i) => { (p.x <= mid ? left : right).push(i); });
                left.sort((ia, ib) => pins[ia].y - pins[ib].y);
                right.sort((ia, ib) => pins[ia].y - pins[ib].y);
                const nRow = Math.max(left.length, right.length, 1);
                const pitch = 14;
                const H = Math.max(18, (nRow - 1) * pitch / 2 + 12);
                a = new Array(n);
                left.forEach((pi, i) => {
                    const t = left.length > 1 ? i / (left.length - 1) : 0.5;
                    a[pi] = { x: -36, y: -H + 12 + t * (2 * H - 24) };
                });
                right.forEach((pi, i) => {
                    const t = right.length > 1 ? i / (right.length - 1) : 0.5;
                    a[pi] = { x: 36, y: -H + 12 + t * (2 * H - 24) };
                });
                break;
            }
            case 'connector': {
                // All legs exit the top at y=-20.
                const spacing = n > 1 ? Math.min(15, 60 / (n - 1)) : 0;
                const startX = -((n - 1) * spacing) / 2;
                a = [];
                for (let i = 0; i < n; i++) a.push({ x: startX + i * spacing, y: -20 });
                break;
            }
            case 'transistor':
            case 'pnp':
                a = this._namedAnchors(pins, { B: { x: -30, y: 0 }, C: { x: 30, y: -18 }, E: { x: 30, y: 18 } },
                    [{ x: -30, y: 0 }, { x: 30, y: -18 }, { x: 30, y: 18 }]);
                break;
            case 'mosfet':
                a = this._namedAnchors(pins, { G: { x: -30, y: 0 }, D: { x: 30, y: -18 }, S: { x: 30, y: 18 } },
                    [{ x: -30, y: 0 }, { x: 30, y: -18 }, { x: 30, y: 18 }]);
                break;
            case 'ldo':
                a = this._namedAnchors(pins, {
                    VIN: { x: -35, y: -9 }, GND: { x: -35, y: 9 }, ADJ: { x: -35, y: 9 }, VOUT: { x: 30, y: 0 }
                }, [{ x: -35, y: -9 }, { x: -35, y: 9 }, { x: 30, y: 0 }]);
                break;
            case 'gnd':
                a = [{ x: 0, y: -15 }];
                break;
            case 'power':
                a = [{ x: 0, y: 15 }];
                break;
            case 'nc':
                a = [{ x: 0, y: 0 }];
                break;
            case 'arduino_uno':
            case 'arduino_nano':
            case 'esp32_devkit':
            case 'esp32s3_devkit':
            case 'esp32s2_mini':
            case 'esp32s3_nano':
            case 'esp8266_nodemcu':
            case 'rpi_pico': {
                const pins = (comp && comp.pins && comp.pins.length) ? comp.pins : [];
                const xs = pins.map(p => p.x);
                const mid = xs.length ? (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 : 0;
                const left = [], right = [];
                pins.forEach((p, i) => { (p.x <= mid ? left : right).push(i); });
                left.sort((ia, ib) => pins[ia].y - pins[ib].y);
                right.sort((ia, ib) => pins[ia].y - pins[ib].y);
                const nRow = Math.max(left.length, right.length, 1);
                const pitch = 10;
                const H = Math.max(40, (nRow - 1) * pitch / 2 + 18);
                a = new Array(n);
                left.forEach((pi, i) => {
                    const t = left.length > 1 ? i / (left.length - 1) : 0.5;
                    a[pi] = { x: -48, y: -H + 14 + t * (2 * H - 28) };
                });
                right.forEach((pi, i) => {
                    const t = right.length > 1 ? i / (right.length - 1) : 0.5;
                    a[pi] = { x: 48, y: -H + 14 + t * (2 * H - 28) };
                });
                break;
            }
            default: {
                // 2-pin horizontal parts (resistor/capacitor/diode/led/inductor)
                // and any fallback: legs run along y=0 from -30 to +30.
                if (n === 0) { a = [{ x: 0, y: 0 }]; break; }
                a = [];
                for (let i = 0; i < n; i++) {
                    const t = n > 1 ? i / (n - 1) : 0.5;
                    a.push({ x: -30 + t * 60, y: 0 });
                }
            }
        }
        // Safety: guarantee exactly n anchors so index always maps to comp.pins[i].
        if (a.length !== n) {
            const out = [];
            for (let i = 0; i < n; i++) out.push(a[Math.min(i, a.length - 1)] || { x: 0, y: 0 });
            return out;
        }
        return a;
    },

    // Schematic symbol angle. Optional schemRotation; otherwise board rotation.
    schemRotation(comp) {
        if (typeof comp.schemRotation === 'number') return comp.schemRotation;
        return comp.rotation || 0;
    },

    // World-space position of a pin anchor (rotation + schematic offset applied).
    schemPinWorld(comp, pinIndex) {
        const a = this.schemPinAnchors(comp)[pinIndex];
        if (!a) return { x: comp.schemX || 0, y: comp.schemY || 0 };
        const rad = this.schemRotation(comp) * Math.PI / 180;
        const c = Math.cos(rad), s = Math.sin(rad);
        return { x: (comp.schemX || 0) + a.x * c - a.y * s, y: (comp.schemY || 0) + a.x * s + a.y * c };
    },

    // Font size in world units that renders as `px` screen pixels at the current
    // zoom. Every schematic glyph is drawn inside the zoom transform, so dividing
    // label sizes by the zoom keeps them legible at any zoom level.
    _schemFont(px) {
        const z = Math.max(this._schemZoom || 1, 0.05);
        return (px / z).toFixed(2);
    },

    // Local-frame half-extents (max |x| / max |y| from the symbol centre) that enclose
    // each type's DRAWN glyph. Mirrors the geometry in draw*Symbol so auto-routing avoids
    // the visible body, not just the pin anchors (e.g. a connector box sits below its
    // top-edge pins, and GND/Power/LED glyphs extend past their single anchor).
    _schemGlyphHalfExtents(comp) {
        const pins = (comp && comp.pins) ? comp.pins : [];
        const n = pins.length;
        if (this._isKicadImported(comp)) { const L = this._kicadLayout(n); return { hw: L.halfW + 10, hh: L.halfH }; }
        switch (comp.type) {
            case 'resistor':  return { hw: 30, hh: 6 };
            case 'capacitor': return { hw: 30, hh: 12 };
            case 'inductor':  return { hw: 30, hh: 5 };
            case 'diode':     return { hw: 30, hh: 10 };
            case 'led':       return { hw: 30, hh: 23 };
            case 'ic':        return { hw: 35, hh: 18 };
            case 'transistor':
            case 'pnp':       return { hw: 30, hh: 18 };
            case 'mosfet':    return { hw: 30, hh: 18 };
            case 'ldo':       return { hw: 35, hh: 18 };
            case 'switch': {
                if (n > 2) {
                    const anchors = this.schemPinAnchors(comp);
                    let mX = 20, mY = 12;
                    anchors.forEach(an => { if (Math.abs(an.x) > mX) mX = Math.abs(an.x); if (Math.abs(an.y) > mY) mY = Math.abs(an.y); });
                    return { hw: mX, hh: mY };
                }
                return { hw: 30, hh: 12 };
            }
            case 'fuse':      return { hw: 30, hh: 8 };
            case 'jumper':    return { hw: 30, hh: 8 };
            case 'crystal':   return { hw: 30, hh: 12 };
            case 'gnd':       return { hw: 14, hh: 15 };
            case 'power':     return { hw: 8, hh: 15 };
            case 'nc':        return { hw: 10, hh: 10 };
            case 'connector': {
                const spacing = n > 1 ? Math.min(15, 60 / (n - 1)) : 0;
                return { hw: ((n - 1) * spacing) / 2 + 8, hh: 20 };
            }
            case 'arduino_uno': case 'arduino_nano': case 'esp32_devkit':
            case 'esp32s3_devkit': case 'esp32s2_mini': case 'esp32s3_nano':
            case 'esp8266_nodemcu': case 'rpi_pico': {
                const anchors = this.schemPinAnchors(comp);
                let mX = 0, mY = 0;
                for (const a of anchors) { if (Math.abs(a.x) > mX) mX = Math.abs(a.x); if (Math.abs(a.y) > mY) mY = Math.abs(a.y); }
                return { hw: Math.max(48, mX), hh: Math.max(34, mY) };
            }
            default:          return { hw: 20, hh: 15 };
        }
    },

    // World-space axis-aligned bounding box of a component's DRAWN symbol, expanded by
    // the margin. Rotation-aware: rotates the local glyph rectangle corners then takes
    // the AABB. Used to keep auto-routed wires from crossing glyph bodies.
    schemSymbolBounds(comp, margin = 8) {
        const e = this._schemGlyphHalfExtents(comp);
        const cx = comp.schemX || 0, cy = comp.schemY || 0;
        const rad = this.schemRotation(comp) * Math.PI / 180;
        const c = Math.cos(rad), s = Math.sin(rad);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [lx, ly] of [[-e.hw, -e.hh], [e.hw, -e.hh], [-e.hw, e.hh], [e.hw, e.hh]]) {
            const wx = cx + lx * c - ly * s;
            const wy = cy + lx * s + ly * c;
            if (wx < minX) minX = wx;
            if (wx > maxX) maxX = wx;
            if (wy < minY) minY = wy;
            if (wy > maxY) maxY = wy;
        }
        return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
    },

    _schemSegHits(p, q, obstacles) {
        return SchematicLayout.segHitsBody(p, q, obstacles || []);
    },

    _schemClear(pts, obstacles) {
        return SchematicLayout.pathClear(pts, obstacles || []);
    },

    _schemRoute(aw, bw, obstacles, occupied, opts) {
        return SchematicLayout.route(aw, bw, obstacles || [], occupied || [], opts);
    },

    _namedAnchors(pins, map, fallback) {
        const n = pins.length;
        const a = new Array(n);
        for (let i = 0; i < n; i++) {
            const key = String((pins[i] && pins[i].name) || '').toUpperCase();
            a[i] = map[key] || fallback[i] || { x: 0, y: 0 };
        }
        return a;
    },

    // ---- KiCad imported-symbol rendering (box + pin stubs, IC style) ----
    _isKicadImported(comp) {
        const def = ComponentDefs.get(comp.type);
        return !!(def && def.kicadImported);
    },

    // Layout shared by the anchor computation and symbol drawing so legs line up.
    // Small pin counts (1-2) draw at built-in glyph scale (like a resistor), not
    // the full IC box: a 2-pin KiCad import should not dwarf a built-in symbol.
    _kicadLayout(n) {
        if (n <= 2) return { leftCount: Math.ceil(n / 2), rightCount: n - Math.ceil(n / 2), spacing: 0, halfW: 12, halfH: 6, small: true };
        const leftCount = Math.ceil(n / 2);
        const rightCount = n - leftCount;
        const maxRow = Math.max(leftCount, rightCount, 1);
        const spacing = maxRow > 1 ? Math.min(16, 30 / (maxRow - 1)) : 0;
        const colSpan = (Math.max(leftCount, rightCount) - 1) * spacing;
        const halfH = Math.max(18, colSpan / 2 + 6);
        return { leftCount, rightCount, spacing, halfW: 25, halfH, small: false };
    },

    // Symbol-local anchors: pins split left/right, legs exit the body at x=±(halfW+10).
    _kicadAnchors(n) {
        if (n === 0) return [{ x: 0, y: 0 }];
        const L = this._kicadLayout(n);
        const ax = L.halfW + 10;
        const a = [];
        for (let i = 0; i < L.leftCount; i++) {
            const rowHalf = ((L.leftCount - 1) * L.spacing) / 2;
            a.push({ x: -ax, y: -rowHalf + i * L.spacing });
        }
        for (let j = 0; j < L.rightCount; j++) {
            const rowHalf = ((L.rightCount - 1) * L.spacing) / 2;
            a.push({ x: ax, y: -rowHalf + j * L.spacing });
        }
        return a;
    },

    // Draw an imported part: real KiCad symbol graphics when the paired
    // .kicad_sym provided them, otherwise a box with pin stubs + labels.
    _symGraphicsFor(comp) {
        const def = ComponentDefs.get(comp.type);
        if (!def || !def.kicadImported) return null;
        const idx = comp.size !== undefined ? comp.size : (def.defaultSize || 0);
        const size = def.sizes && def.sizes[idx];
        return (size && size.symGraphics && size.symGraphics.length) ? size.symGraphics : null;
    },

    // Draw symbol graphics (KiCad symbol units, Y-up) scaled to fit the
    // body box [-25..25] x [-halfH..halfH], Y flipped to canvas space.
    _drawSymGraphics(ctx, gfx, halfW, halfH) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        gfx.forEach(g => g.pts.forEach(p => {
            if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }));
        if (!isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) return;
        const s = Math.min((halfW * 2 - 4) / (maxX - minX), (halfH * 2 - 4) / (maxY - minY));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const tx = (x) => (x - cx) * s;
        const ty = (y) => -(y - cy) * s;
        ctx.fillStyle = 'rgba(40,60,90,0.45)';
        ctx.strokeStyle = '#8fb3d5';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.rect(tx(minX), ty(maxY), (maxX - minX) * s, (maxY - minY) * s);
        ctx.fill();
        gfx.forEach(g => {
            ctx.beginPath();
            if (g.t === 'r') {
                const x1 = tx(g.pts[0][0]), y1 = ty(g.pts[0][1]);
                const x2 = tx(g.pts[1][0]), y2 = ty(g.pts[1][1]);
                ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
            } else if (g.t === 'e') {
                const cxp = (g.pts[0][0] + g.pts[1][0]) / 2, cyp = (g.pts[0][1] + g.pts[1][1]) / 2;
                ctx.ellipse(tx(cxp), ty(cyp), Math.abs(g.pts[1][0] - g.pts[0][0]) * s / 2, Math.abs(g.pts[1][1] - g.pts[0][1]) * s / 2, 0, 0, Math.PI * 2);
            } else {
                g.pts.forEach((p, i) => { if (i === 0) ctx.moveTo(tx(p[0]), ty(p[1])); else ctx.lineTo(tx(p[0]), ty(p[1])); });
            }
            ctx.stroke();
        });
    },

    drawKicadSymbol(ctx, comp) {
        const pins = comp.pins || [];
        const n = pins.length;
        const L = this._kicadLayout(n);
        const gfx = this._symGraphicsFor(comp);
        if (gfx) {
            this._drawSymGraphics(ctx, gfx, L.halfW, L.halfH);
        } else {
            ctx.fillStyle = 'rgba(40,60,90,0.55)';
            ctx.strokeStyle = '#8fb3d5';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(-L.halfW, -L.halfH, L.halfW * 2, L.halfH * 2, 3);
            else ctx.rect(-L.halfW, -L.halfH, L.halfW * 2, L.halfH * 2);
            ctx.fill(); ctx.stroke();
        }
        // Legs + pin-name labels (aligned to _kicadAnchors).
        ctx.lineWidth = 1;
        const drawSide = (count, xBody, xEnd, startIdx, dir) => {
            for (let i = 0; i < count; i++) {
                const rowHalf = ((count - 1) * L.spacing) / 2;
                const y = -rowHalf + i * L.spacing;
                ctx.beginPath(); ctx.moveTo(xBody, y); ctx.lineTo(xEnd, y); ctx.stroke();
                const nm = (pins[startIdx + i] && pins[startIdx + i].name) ? String(pins[startIdx + i].name) : '';
                if (nm) {
                    ctx.fillStyle = '#9fc0dd';
                    ctx.font = this._schemFont(9) + 'px monospace';
                    ctx.textAlign = dir < 0 ? 'right' : 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(nm, xEnd + dir * 2, y);
                }
            }
        };
        drawSide(L.leftCount, -L.halfW, -(L.halfW + 10), 0, -1);
        drawSide(L.rightCount, L.halfW, L.halfW + 10, L.leftCount, 1);
    },

    render(app) {
        const ctx = app.schemCtx;
        const canvas = app.schematicCanvas;
        const w = canvas.width, h = canvas.height;

        // Clear with dark background
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);


        // Title block
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(w - 200, h - 40, 190, 35);
        ctx.strokeStyle = 'rgba(100,150,200,0.3)';
        ctx.strokeRect(w - 200, h - 40, 190, 35);
        ctx.fillStyle = '#7fb3d5';
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('SCHEMATIC VIEW', w - 195, h - 25);
        ctx.fillText(`${app.board.width}x${app.board.height}mm`, w - 195, h - 12);

        // Ensure schematic positions + labels exist (migration / first switch).
        app.ensureSchemPositions();
        app.ensureLabels();

        const comps = app.components;
        const ghost = this._placingGhost(app);

        if (comps.length === 0 && !ghost) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No components placed', w / 2, h / 2 - 10);
            ctx.font = '12px sans-serif';
            ctx.fillText('Pick a component from the left panel and click here to place it', w / 2, h / 2 + 15);
            return;
        }

        // Reset per-frame pin hit-test cache.
        app.interaction.schemPinPositions = [];

        // Apply world transform: zoom around center, then pan offset.
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(app.view.schemZoom, app.view.schemZoom);
        ctx.translate(-app.view.schemPanX, -app.view.schemPanY);
        this._schemZoom = app.view.schemZoom;

        // World-space grid aligned to the 5-unit snap grid so the on-screen lines show
        // exactly where wires & parts snap. Step grows with zoom-out to stay readable.
        {
            const zoom = app.view.schemZoom;
            let gstep = 5;
            while (gstep * zoom < 15 && gstep < 200) gstep += 5;
            if (gstep * zoom >= 15) {
                const x0 = app.view.schemPanX - w / (2 * zoom), x1 = app.view.schemPanX + w / (2 * zoom);
                const y0 = app.view.schemPanY - h / (2 * zoom), y1 = app.view.schemPanY + h / (2 * zoom);
                ctx.strokeStyle = app.params.schemSnap === false ? 'rgba(100,150,200,0.05)' : 'rgba(100,150,200,0.10)';
                ctx.lineWidth = 1 / zoom;
                ctx.beginPath();
                for (let gx = Math.floor(x0 / gstep) * gstep; gx <= x1; gx += gstep) { ctx.moveTo(gx, y0); ctx.lineTo(gx, y1); }
                for (let gy = Math.floor(y0 / gstep) * gstep; gy <= y1; gy += gstep) { ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); }
                ctx.stroke();
            }
        }

        // Draw wires first so component symbol bodies render on top of them: any wire
        // that must cross a body passes behind it rather than cutting through the glyph.
        this.drawWires(ctx, app);

        // Draw symbols at their stored schematic positions (on top of wires).
        comps.forEach((comp) => { this.drawSymbol(ctx, app, comp); });

        // Ghost preview for a palette component being placed in this view.
        if (ghost) {
            ctx.globalAlpha = 0.5;
            this.drawSymbol(ctx, app, ghost);
            ctx.globalAlpha = 1;
        }

        // Hovered pin highlight.
        const hp = app.interaction.schemHoveredPin;
        if (hp) {
            const hcomp = comps.find(c => c.id === hp.compId);
            if (hcomp) {
                const wp = this.schemPinWorld(hcomp, hp.pinIndex);
                ctx.strokeStyle = '#00ffff';
                ctx.lineWidth = 2 / app.view.schemZoom;
                ctx.beginPath(); ctx.arc(wp.x, wp.y, 6, 0, Math.PI * 2); ctx.stroke();
            }
        }

        // Rubber-band wire being drawn (start pin -> interior points -> snapped cursor).
        const ws = app.interaction.schemWireStart;
        if (ws) {
            const wcomp = comps.find(c => c.id === ws.compId);
            if (wcomp) {
                const wp = this.schemPinWorld(wcomp, ws.pinIndex);
                const cursor = app.interaction.schemWireCursor;
                if (cursor) {
                    ctx.strokeStyle = 'rgba(0,255,170,0.9)';
                    ctx.lineWidth = 2 / app.view.schemZoom;
                    ctx.setLineDash([6 / app.view.schemZoom, 4 / app.view.schemZoom]);
                    const interior = app.interaction.schemWireInterior || [];
                    const path = [wp, ...interior.map(p => ({ x: p.x, y: p.y })), cursor];
                    this._polyPath(ctx, path);
                    ctx.stroke();
                    for (const p of interior) {
                        ctx.setLineDash([]);
                        ctx.fillStyle = 'rgba(0,255,170,0.9)';
                        ctx.fillRect(p.x - 3 / app.view.schemZoom, p.y - 3 / app.view.schemZoom, 6 / app.view.schemZoom, 6 / app.view.schemZoom);
                        ctx.setLineDash([6 / app.view.schemZoom, 4 / app.view.schemZoom]);
                    }
                    ctx.setLineDash([]);
                    // Always show an anchor dot at the live end of the rubber-band so the
                    // wire never "floats" — regardless of snap kind (grid / H / V / 45° /
                    // free / pin / edge). When locked to a pin or an existing wire
                    // (pin / vertex / edge), add a brighter ring so the exact connection
                    // point (pin or T-join) is obvious.
                    const locked = cursor.kind === 'pin' || cursor.kind === 'vertex' || cursor.kind === 'edge';
                    const dotR = (locked ? 4 : 2.6) / app.view.schemZoom;
                    ctx.fillStyle = locked ? '#00ffaa' : 'rgba(0,255,170,0.85)';
                    ctx.beginPath(); ctx.arc(cursor.x, cursor.y, dotR, 0, Math.PI * 2); ctx.fill();
                    if (locked) {
                        const ar = 5.5 / app.view.schemZoom;
                        ctx.strokeStyle = '#00ffaa';
                        ctx.lineWidth = 2 / app.view.schemZoom;
                        ctx.beginPath(); ctx.arc(cursor.x, cursor.y, ar, 0, Math.PI * 2); ctx.stroke();
                        ctx.fillStyle = 'rgba(0,255,170,0.22)';
                        ctx.beginPath(); ctx.arc(cursor.x, cursor.y, ar, 0, Math.PI * 2); ctx.fill();
                    }
                }
            }
        }

        ctx.restore();
    },
    drawWires(ctx, app) {
        const traces = app.traces;
        const nlWires = app._netlistSchemWires ? app._netlistSchemWires() : [];
        if ((!traces || !traces.length) && !nlWires.length) return;
        const selSet = new Set((app.interaction.schemSelectedWires || []).map(w => w.id));
        const drawList = (traces || []).concat(nlWires);
        drawList.forEach((trace) => {
            const pts = app.getSchemWirePoints(trace);
            if (!pts || pts.length < 2) return;
            const color = BoardView.getNetColor(app, trace.net);
            const selected = (app.interaction.selectedObject &&
                app.interaction.selectedObject.type === 'trace' &&
                app.interaction.selectedObject.obj.id === trace.id) || selSet.has(trace.id);
            ctx.strokeStyle = selected ? '#ffffff' : color;
            ctx.lineWidth = (selected ? 4 : 2.5) / app.view.schemZoom;
            if (selected) {
                ctx.shadowColor = '#8fd0ff';
                ctx.shadowBlur = 8 / Math.max(app.view.schemZoom, 0.3);
            } else {
                ctx.shadowBlur = 0;
            }
            this._polyPath(ctx, pts);
            ctx.stroke();
            ctx.shadowBlur = 0;
            // Interior joints always visible as small points; selected wire gets larger handles.
            const r = (selected ? 4 : 2.5) / app.view.schemZoom;
            const selJoint = app.interaction.schemSelectedJoint;
            const interiors = pts.slice(1, -1);
            interiors.forEach((wpt, idx) => {
                const isSelJoint = selected && selJoint && selJoint.traceId === trace.id && selJoint.waypointIndex === idx;
                ctx.beginPath();
                ctx.arc(wpt.x, wpt.y, isSelJoint ? r * 1.5 : r, 0, Math.PI * 2);
                if (isSelJoint) {
                    ctx.fillStyle = '#00ffff';
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2 / app.view.schemZoom;
                    ctx.fill(); ctx.stroke();
                } else {
                    ctx.fillStyle = selected ? '#0a2a3a' : color;
                    ctx.strokeStyle = selected ? '#00ffff' : 'rgba(255,255,255,0.85)';
                    ctx.lineWidth = 1.2 / app.view.schemZoom;
                    ctx.fill(); ctx.stroke();
                }
            });
            // Unattached (grabbable) end: draw a clear open dot so the user can see and
            // grab the end of a line that stops in mid-air (Enter-committed stub, T-join
            // stub, etc.) and continue routing from it.
            const freeIdx = app.schemFreeEndIndex(trace, pts);
            if (freeIdx >= 0 && pts[freeIdx]) {
                const fe = pts[freeIdx];
                const fr = (selected ? 4.5 : 3.2) / app.view.schemZoom;
                ctx.beginPath(); ctx.arc(fe.x, fe.y, fr, 0, Math.PI * 2);
                ctx.fillStyle = '#00ffaa';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                ctx.lineWidth = 1.4 / app.view.schemZoom;
                ctx.stroke();
            }
            // An unattached end gets an open ring handle so the user can see (and grab) it.
            if (trace.schemJoin && Array.isArray(trace.schemEnds) && trace.schemEnds[1] === null) {
                const e = pts[pts.length - 1];
                ctx.beginPath();
                ctx.arc(e.x, e.y, r * 1.2, 0, Math.PI * 2);
                ctx.fillStyle = '#1a1a12';
                ctx.strokeStyle = selected ? '#00ffff' : color;
                ctx.lineWidth = 1.6 / app.view.schemZoom;
                ctx.fill(); ctx.stroke();
            }
        });
        this.drawSchemJunctions(ctx, app);
    },

    drawSchemJunctions(ctx, app) {
        const traces = app.traces || [];
        const seen = new Set();
        const r = 3.2 / app.view.schemZoom;
        const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 6;
        for (let i = 0; i < traces.length; i++) {
            const pa = app.getSchemWirePoints(traces[i]);
            if (!pa || pa.length < 2) continue;
            for (let j = i + 1; j < traces.length; j++) {
                const pb = app.getSchemWirePoints(traces[j]);
                if (!pb || pb.length < 2) continue;
                const share = [];
                for (const a of pa) {
                    for (const b of pb) {
                        if (near(a, b)) share.push(a);
                    }
                }
                const endOn = (ends, poly) => {
                    for (const e of ends) {
                        for (let s = 0; s < poly.length - 1; s++) {
                            const ax = poly[s].x, ay = poly[s].y, bx = poly[s + 1].x, by = poly[s + 1].y;
                            const dx = bx - ax, dy = by - ay;
                            const l2 = dx * dx + dy * dy;
                            let t = l2 === 0 ? 0 : ((e.x - ax) * dx + (e.y - ay) * dy) / l2;
                            t = Math.max(0, Math.min(1, t));
                            const px = ax + t * dx, py = ay + t * dy;
                            if (Math.hypot(e.x - px, e.y - py) < 6) share.push({ x: px, y: py });
                        }
                    }
                };
                endOn([pa[0], pa[pa.length - 1]], pb);
                endOn([pb[0], pb[pb.length - 1]], pa);
                for (const p of share) {
                    const k = Math.round(p.x / 2) + ',' + Math.round(p.y / 2);
                    if (seen.has(k)) continue;
                    seen.add(k);
                    ctx.fillStyle = '#f4d35e';
                    ctx.strokeStyle = '#1a1a12';
                    ctx.lineWidth = 1 / app.view.schemZoom;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }
        }
    },

    _polyPath(ctx, pts) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    },

    // Dev board module symbol: titled block with pins on the left/right edges.
    drawModuleSymbol(ctx, comp) {
        const anchors = this.schemPinAnchors(comp);
        let maxX = 0, maxY = 0;
        anchors.forEach(a => {
            if (Math.abs(a.x) > maxX) maxX = Math.abs(a.x);
            if (Math.abs(a.y) > maxY) maxY = Math.abs(a.y);
        });
        const bw = Math.max(48, maxX);
        const H = Math.max(34, maxY);
        ctx.lineWidth = 2;
        ctx.strokeRect(-bw, -H, bw * 2, H * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = 'bold ' + this._schemFont(11) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(comp.label || comp.type, 0, -10);
        ctx.fillStyle = '#9fd8ff';
        ctx.font = this._schemFont(10) + 'px monospace';
        ctx.fillText(comp.value || '', 0, 8);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = this._schemFont(8) + 'px monospace';
        const pins = comp.pins || [];
        anchors.forEach((a, i) => {
            if (i >= pins.length) return;
            const left = a.x < 0;
            ctx.textAlign = left ? 'right' : 'left';
            const raw = pins[i].name || '';
            const label = (typeof KicadImport !== 'undefined' && KicadImport._kxShortPinName)
                ? (KicadImport._kxShortPinName(raw) || raw) : raw;
            ctx.fillText(label, a.x + (left ? -5 : 5), a.y);
        });
        ctx.textAlign = 'center';
    },

    // Ghost symbol for palette placement in schematic view (null when not placing here).
    _placingGhost(app) {
        const type = app.interaction.placingComponent;
        if (!type || app.view.mode !== 'schematic') return null;
        const pos = app.interaction.schemPlacingPos;
        if (!pos) return null;
        const def = ComponentDefs.get(type);
        if (!def) return null;
        const sizeIdx = (app.interaction.placingSize && app.interaction.placingSize[type] !== undefined) ? app.interaction.placingSize[type] : def.defaultSize;
        const size = ComponentDefs.getSize(def, sizeIdx);
        if (!size || !size.pins) return null;
        return { id: -1, type, rotation: 0, value: '', label: def.prefix + '?', size: sizeIdx, pins: size.pins, schemX: pos.x, schemY: pos.y };
    },

    drawSymbol(ctx, app, comp) {
        const def = ComponentDefs.get(comp.type);
        if (!def) return;
        const cx = comp.schemX || 0, cy = comp.schemY || 0;
        const selected = app.interaction.selectedObject &&
            app.interaction.selectedObject.type === 'component' &&
            app.interaction.selectedObject.obj.id === comp.id;

        ctx.save();
        ctx.translate(cx, cy);

        if (selected) {
            ctx.shadowColor = '#8fd0ff';
            ctx.shadowBlur = 10 / Math.max(app.view.schemZoom, 0.3);
        }
        ctx.strokeStyle = selected ? '#ffffff' : '#aaddff';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = selected ? 2.4 : 2;

        ctx.save();
        ctx.rotate(this.schemRotation(comp) * Math.PI / 180);
        if (this._isKicadImported(comp)) { this.drawKicadSymbol(ctx, comp); } else {
        switch (comp.type) {
            case 'resistor':
                this.drawResistorSymbol(ctx); break;
            case 'capacitor':
                this.drawCapSymbol(ctx, comp); break;
            case 'led':
            case 'diode':
                this.drawDiodeSymbol(ctx, comp.type === 'led'); break;
            case 'ic':
                this.drawICSymbol(ctx, comp); break;
            case 'connector':
                this.drawConnSymbol(ctx, comp); break;
            case 'inductor':
                this.drawInductorSymbol(ctx); break;
            case 'transistor':
                this.drawTransistorSymbol(ctx, false); break;
            case 'pnp':
                this.drawTransistorSymbol(ctx, true); break;
            case 'mosfet':
                this.drawMosfetSymbol(ctx, this._mosfetPChannel(comp)); break;
            case 'ldo':
                this.drawLDOSymbol(ctx, comp); break;
            case 'switch':
                this.drawSwitchSymbol(ctx, comp); break;
            case 'fuse':
                this.drawFuseSymbol(ctx); break;
            case 'jumper':
                this.drawJumperSymbol(ctx, comp); break;
            case 'crystal':
                this.drawCrystalSymbol(ctx); break;
            case 'gnd':
                this.drawGNDsymbol(ctx); break;
            case 'power':
                this.drawPowerSymbol(ctx, comp); break;
            case 'nc':
                this.drawNCSymbol(ctx); break;
            case 'arduino_uno':
            case 'arduino_nano':
            case 'esp32_devkit':
            case 'esp32s3_devkit':
            case 'esp32s2_mini':
            case 'esp32s3_nano':
            case 'esp8266_nodemcu':
            case 'rpi_pico':
                this.drawModuleSymbol(ctx, comp); break;
            default:
                ctx.strokeRect(-20, -15, 40, 30);
        }
        } // end non-kicad symbol branch
        ctx.restore();

        // Pin dots sit exactly on the leg endpoints + record screen positions.
        ctx.shadowBlur = 0;
        const pins = comp.pins || [];
        const anchors = this.schemPinAnchors(comp);
        anchors.forEach((a, i) => {
            if (i >= pins.length) return;
            const wp = this.schemPinWorld(comp, i);
            // ctx is already translated by (cx,cy); wp is a world coord, so draw
            // at the local rotated position to land exactly on the leg endpoint.
            const lx = wp.x - cx, ly = wp.y - cy;
            ctx.fillStyle = '#66ffcc';
            ctx.strokeStyle = '#0a2a1a';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            const sp = app.schemWorldToScreen(wp.x, wp.y);
            app.interaction.schemPinPositions.push({ compId: comp.id, pinIndex: i, sx: sp.x, sy: sp.y });
        });

        // Label + value (unrotated). Module symbols draw their own reference/name inside.
        const isModule = ComponentDefs.isModule && ComponentDefs.isModule(comp.type);
        if (!isModule) {
            const e = this._schemGlyphHalfExtents(comp);
            ctx.fillStyle = selected ? '#ffffff' : '#e8f4ff';
            ctx.font = 'bold ' + this._schemFont(11) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(comp.label || comp.type, 0, -e.hh - 4);
            ctx.fillStyle = '#88aacc';
            ctx.font = this._schemFont(10) + 'px monospace';
            ctx.fillText(comp.value || '', 0, e.hh + 12);
        }

        ctx.restore();
    },
    drawJumperSymbol(ctx, comp) {
        const def = ComponentDefs.get('jumper');
        const size = def && comp.size !== undefined ? ComponentDefs.getSize(def, comp.size) : (def ? ComponentDefs.getSize(def, def.defaultSize || 0) : null);
        if (!size) return;
        const pins = (comp.pins && comp.pins.length >= 2) ? comp.pins : size.pins;
        const a = pins[0], b = pins[pins.length - 1];
        if (size.jkind === 'wire') {
            // Two solder-hole anchors bridged by a dashed wire line.
            [a, b].forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke(); });
            ctx.setLineDash([5, 3]);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            ctx.setLineDash([]);
        } else {
            const hw = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y) / 2 + 4), hh = 6;
            ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
            ctx.font = 'bold ' + this._schemFont(7) + 'px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('0Ω', 0, 0);
        }
    },
    drawResistorSymbol(ctx) {
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-20, 0);
        // Zigzag
        for (let i = 0; i < 5; i++) {
            const x1 = -20 + i * 8;
            const y1 = i % 2 === 0 ? -6 : 6;
            ctx.lineTo(x1 + 4, y1);
        }
        ctx.lineTo(20, 0); ctx.lineTo(30, 0);
        ctx.stroke();
    },

    _isPolarCap(comp) {
        const pins = (comp && comp.pins) || [];
        if (pins.some(p => p && (p.name === '+' || p.name === '-'))) return true;
        const def = ComponentDefs.get(comp && comp.type);
        const size = def ? ComponentDefs.getSize(def, comp.size !== undefined ? comp.size : def.defaultSize) : null;
        const nm = ((size && size.name) || '') + ' ' + ((comp && comp.value) || '');
        return /electrolytic|\bcp[_ ]/i.test(nm);
    },

    drawCapSymbol(ctx, comp) {
        const pins = (comp && comp.pins) || [];
        const polar = this._isPolarCap(comp);
        const leftIsPlus = !!(pins[0] && pins[0].name === '+');
        const lw = ctx.lineWidth || 2;
        const bold = lw * 2.6;
        const plate = (x, thick) => {
            ctx.beginPath();
            ctx.moveTo(x, -12); ctx.lineTo(x, 12);
            ctx.lineWidth = thick ? bold : lw;
            ctx.lineCap = 'butt';
            ctx.stroke();
        };
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-5, 0);
        ctx.moveTo(5, 0); ctx.lineTo(30, 0);
        ctx.lineWidth = lw;
        ctx.stroke();
        if (polar) {
            plate(-5, !leftIsPlus);
            plate(5, leftIsPlus);
            ctx.lineWidth = lw;
            const px = leftIsPlus ? -14 : 14;
            ctx.beginPath();
            ctx.moveTo(px - 3, -8); ctx.lineTo(px + 3, -8);
            ctx.moveTo(px, -11); ctx.lineTo(px, -5);
            ctx.stroke();
        } else {
            plate(-5, false);
            plate(5, false);
        }
    },

    drawDiodeSymbol(ctx, isLED) {
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-5, 0);
        // Triangle
        ctx.moveTo(-5, -10); ctx.lineTo(10, 0); ctx.lineTo(-5, 10); ctx.closePath();
        ctx.stroke();
        // Bar
        ctx.beginPath();
        ctx.moveTo(10, -10); ctx.lineTo(10, 10);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(10, 0); ctx.lineTo(30, 0);
        ctx.stroke();
        if (isLED) {
            // Arrows for LED
            ctx.beginPath();
            ctx.moveTo(5, -15); ctx.lineTo(12, -20);
            ctx.moveTo(5, -18); ctx.lineTo(12, -13);
            ctx.moveTo(8, -18); ctx.lineTo(15, -23);
            ctx.moveTo(8, -21); ctx.lineTo(15, -16);
            ctx.stroke();
        }
    },

    drawSwitchSymbol(ctx, comp) {
        const pins = (comp && comp.pins) || [];
        if (pins.length > 2) {
            const anchors = this.schemPinAnchors(comp);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            anchors.forEach(a => {
                if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
                if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y;
            });
            const x0 = minX + 10, x1 = maxX - 10, y0 = minY - 8, y1 = maxY + 8;
            ctx.strokeRect(x0, y0, Math.max(8, x1 - x0), Math.max(8, y1 - y0));
            anchors.forEach(a => {
                const edge = a.x < 0 ? x0 : x1;
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(edge, a.y); ctx.stroke();
            });
            return;
        }
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-12, 0);
        ctx.moveTo(12, 0); ctx.lineTo(30, 0);
        ctx.moveTo(-12, 0); ctx.lineTo(10, -12);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(12, 0, 3, 0, Math.PI * 2);
        ctx.stroke();
    },

    drawFuseSymbol(ctx) {
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-18, 0);
        ctx.rect(-18, -8, 36, 16);
        ctx.moveTo(18, 0); ctx.lineTo(30, 0);
        ctx.stroke();
    },

    drawCrystalSymbol(ctx) {
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-12, 0);
        ctx.moveTo(-12, -12); ctx.lineTo(-12, 12);
        ctx.moveTo(-6, -8); ctx.lineTo(-6, 8);
        ctx.moveTo(6, -8); ctx.lineTo(6, 8);
        ctx.moveTo(12, -12); ctx.lineTo(12, 12);
        ctx.moveTo(12, 0); ctx.lineTo(30, 0);
        ctx.stroke();
    },

    _mosfetPChannel(comp) {
        const def = ComponentDefs.get(comp.type);
        const size = ComponentDefs.getSize(def, comp.size);
        if (size && size.channel === 'p') return true;
        return !!(size && size.name && /P-ch/i.test(size.name));
    },

    drawICSymbol(ctx, comp) {
        const pins = comp.pins || [];
        const n = pins.length;
        const leftCount = Math.ceil(n / 2);
        const rightCount = n - leftCount;
        // Body.
        ctx.strokeRect(-25, -18, 50, 36);
        // Left legs (top -> bottom).
        for (let i = 0; i < leftCount; i++) {
            const t = leftCount > 1 ? i / (leftCount - 1) : 0.5;
            const py = -15 + t * 30;
            ctx.beginPath(); ctx.moveTo(-25, py); ctx.lineTo(-35, py); ctx.stroke();
        }
        // Right legs (top -> bottom).
        for (let j = 0; j < rightCount; j++) {
            const t = rightCount > 1 ? j / (rightCount - 1) : 0.5;
            const py = -15 + t * 30;
            ctx.beginPath(); ctx.moveTo(25, py); ctx.lineTo(35, py); ctx.stroke();
        }
        // Pin name labels just outside each leg.
        ctx.fillStyle = '#8fbfff';
        ctx.font = this._schemFont(9) + 'px monospace';
        for (let i = 0; i < leftCount; i++) {
            const t = leftCount > 1 ? i / (leftCount - 1) : 0.5;
            const py = -15 + t * 30;
            ctx.textAlign = 'right';
            ctx.fillText(pins[i].name || String(i + 1), -38, py + 3);
        }
        for (let j = 0; j < rightCount; j++) {
            const idx = leftCount + j;
            const t = rightCount > 1 ? j / (rightCount - 1) : 0.5;
            const py = -15 + t * 30;
            ctx.textAlign = 'left';
            ctx.fillText(pins[idx].name || String(idx + 1), 38, py + 3);
        }
    },

    drawConnSymbol(ctx, comp) {
        const pins = comp.pins || [];
        const spacing = Math.min(15, 60 / Math.max(1, pins.length - 1));
        const startX = -((pins.length - 1) * spacing) / 2;
        ctx.strokeRect(startX - 8, -12, (pins.length - 1) * spacing + 16, 24);
        pins.forEach((pin, i) => {
            const px = startX + i * spacing;
            ctx.beginPath(); ctx.arc(px, 0, 3, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(px, -12); ctx.lineTo(px, -20); ctx.stroke();
        });
    },

    drawInductorSymbol(ctx) {
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-20, 0);
        for (let i = 0; i < 4; i++) {
            const x1 = -20 + i * 10;
            ctx.arc(x1 + 5, 0, 5, Math.PI, 0);
        }
        ctx.lineTo(30, 0);
        ctx.stroke();
    },

    drawTransistorSymbol(ctx, isPnp) {
        ctx.beginPath();
        ctx.moveTo(-6, -14); ctx.lineTo(-6, 14);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-6, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-6, -7); ctx.lineTo(30, -18);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-6, 7); ctx.lineTo(30, 18);
        ctx.stroke();
        const ex0 = -6, ey0 = 7, ex1 = 30, ey1 = 18;
        const len = Math.hypot(ex1 - ex0, ey1 - ey0);
        const ux = (ex1 - ex0) / len, uy = (ey1 - ey0) / len;
        const px = -uy, py = ux;
        const along = isPnp ? 0.28 : 0.72;
        const tipAlong = isPnp ? 0.16 : 0.84;
        const bx = ex0 + ux * (len * along), by = ey0 + uy * (len * along);
        const tx = ex0 + ux * (len * tipAlong), ty = ey0 + uy * (len * tipAlong);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(bx - px * 5, by - py * 5);
        ctx.lineTo(bx + px * 5, by + py * 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#8fbfff';
        ctx.font = 'bold ' + this._schemFont(10) + 'px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('B', -34, 4);
        ctx.textAlign = 'left';
        ctx.fillText('C', 34, -20);
        ctx.fillText('E', 34, 24);
    },

    drawMosfetSymbol(ctx, pChannel) {
        ctx.beginPath();
        ctx.moveTo(-30, 0); ctx.lineTo(-10, 0);
        ctx.moveTo(-10, -14); ctx.lineTo(-10, 14);
        ctx.moveTo(-4, -12); ctx.lineTo(-4, -2);
        ctx.moveTo(-4, 2); ctx.lineTo(-4, 12);
        ctx.moveTo(-4, -7); ctx.lineTo(8, -7); ctx.lineTo(8, -18); ctx.lineTo(30, -18);
        ctx.moveTo(-4, 7); ctx.lineTo(8, 7); ctx.lineTo(8, 18); ctx.lineTo(30, 18);
        ctx.stroke();
        if (pChannel) {
            ctx.beginPath(); ctx.arc(-10, 0, 3, 0, Math.PI * 2); ctx.stroke();
        }
        const ay = pChannel ? -7 : 7;
        ctx.beginPath();
        if (pChannel) { ctx.moveTo(-4, ay); ctx.lineTo(2, ay - 4); ctx.lineTo(2, ay + 4); }
        else { ctx.moveTo(8, ay); ctx.lineTo(2, ay - 4); ctx.lineTo(2, ay + 4); }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#8fbfff';
        ctx.font = 'bold ' + this._schemFont(10) + 'px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('G', -34, 4);
        ctx.textAlign = 'left';
        ctx.fillText('D', 34, -20);
        ctx.fillText('S', 34, 24);
    },

    drawLDOSymbol(ctx, comp) {
        const pins = comp.pins || [];
        const hasAdj = pins.some(p => String(p.name).toUpperCase() === 'ADJ');
        ctx.strokeRect(-25, -18, 40, 36);
        ctx.beginPath(); ctx.moveTo(-25, -9); ctx.lineTo(-35, -9); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-25, 9); ctx.lineTo(-35, 9); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(30, 0); ctx.stroke();
        ctx.fillStyle = '#ffaa44';
        ctx.font = 'bold ' + this._schemFont(9) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(comp.value || 'LDO', -5, 0);
        ctx.fillStyle = '#aaddff';
        ctx.font = this._schemFont(8) + 'px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('VIN', -37, -9);
        ctx.fillText(hasAdj ? 'ADJ' : 'GND', -37, 9);
        ctx.textAlign = 'left';
        ctx.fillText('VOUT', 32, 0);
    },

    drawGNDsymbol(ctx) {
        // Vertical line from top
        ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(0, 0); ctx.stroke();
        // Three horizontal lines decreasing in width (standard GND symbol)
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-9, 6); ctx.lineTo(9, 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-4, 12); ctx.lineTo(4, 12); ctx.stroke();
        ctx.lineWidth = 1.5;
    },

    drawPowerSymbol(ctx, comp) {
        ctx.beginPath(); ctx.moveTo(0, 15); ctx.lineTo(0, 5); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 4); ctx.stroke();
    },

    drawNCSymbol(ctx) {
        ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-6, -6); ctx.lineTo(6, 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(6, -6); ctx.lineTo(-6, 6); ctx.stroke();
    }
};