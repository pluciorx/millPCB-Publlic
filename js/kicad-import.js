// ============================================================
// KiCad Import - S-expression parser, footprint/symbol parsing,
// component-def construction, registration, palette injection,
// file-picker + /PCBLib auto-scan, and save/load persistence.
//
// Imported parts plug into the existing data model: each becomes a
// ComponentDefs entry whose single size carries `size.pins[]` (mm,
// relative to the component centre) plus a `size.kicad` block with the
// exact pad shapes and F.Fab / F.SilkS graphics for faithful rendering.
// ============================================================

// ---------- S-expression tokenizer ----------
function _kxTokenize(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '(') { tokens.push('('); i++; continue; }
        if (c === ')') { tokens.push(')'); i++; continue; }
        if (c === '"') {
            i++; let s = '';
            while (i < n && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < n) {
                    const e = text[i + 1];
                    if (e === 'n') s += '\n';
                    else if (e === 't') s += '\t';
                    else if (e === '"') s += '"';
                    else if (e === '\\') s += '\\';
                    else s += e;
                    i += 2; continue;
                }
                s += text[i]; i++;
            }
            i++; // skip closing quote
            tokens.push({ str: s });
            continue;
        }
        let a = '';
        while (i < n && text[i] !== ' ' && text[i] !== '\t' && text[i] !== '\n' &&
               text[i] !== '\r' && text[i] !== '(' && text[i] !== ')') {
            a += text[i]; i++;
        }
        tokens.push(a);
    }
    return tokens;
}

function _kxNum(s) {
    if (typeof s === 'number') return s;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(s))) return parseFloat(s);
    return s;
}

// Parse an S-expression text into an array of top-level nodes.
// Nodes are numbers, strings (from "quoted"), or nested arrays whose [0] is the keyword.
function _kxParse(text) {
    const tokens = _kxTokenize(text);
    let pos = 0;
    function readOne() {
        if (pos >= tokens.length) return null;
        const t = tokens[pos];
        if (t === '(') {
            pos++;
            const arr = [];
            while (pos < tokens.length && tokens[pos] !== ')') arr.push(readOne());
            pos++; // consume ')'
            return arr;
        }
        if (typeof t === 'object' && t.str !== undefined) { pos++; return t.str; }
        pos++;
        return _kxNum(t);
    }
    const out = [];
    while (pos < tokens.length) {
        const v = readOne();
        if (v !== null) out.push(v);
    }
    return out;
}

// First sub-list of `list` whose keyword === key, e.g. _kxProp(pad,'at') -> ['at', x, y].
function _kxProp(list, key) {
    if (!Array.isArray(list)) return undefined;
    for (let i = 1; i < list.length; i++) {
        const c = list[i];
        if (Array.isArray(c) && c[0] === key) return c;
    }
    return undefined;
}

// All sub-lists of `list` whose keyword === key.
function _kxAll(list, key) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 1; i < list.length; i++) {
        const c = list[i];
        if (Array.isArray(c) && c[0] === key) out.push(c);
    }
    return out;
}

// Circle through three points. Returns null when the points are colinear.
function _kxCircle3(x1, y1, x2, y2, x3, y3) {
    const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(d) < 1e-9) return null;
    const x = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
    const y = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
    return { x, y, r: Math.hypot(x1 - x, y1 - y) };
}

// CCW distance from a to b, in [0, 2pi).
function _kxCcw(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return d;
}

const KicadImport = {
    // KiCad (drill ...) — round hole, oval hole, or nested (offset ...) args.
    _parseDrill(dr) {
        let drill = 0, drillOval = null;
        if (!dr) return { drill, drillOval };
        const nums = [];
        let oval = false;
        for (let i = 1; i < dr.length; i++) {
            const a = dr[i];
            if (a === 'oval' || a === 'OVAL') oval = true;
            else if (typeof a === 'number') nums.push(a);
        }
        if (oval && nums.length >= 2) {
            drillOval = { w: nums[0], h: nums[1] };
            drill = Math.min(nums[0], nums[1]);
        } else if (nums.length >= 1) {
            drill = nums[0];
        }
        return { drill, drillOval };
    },

    _padAABB(p) {
        const r = ((p.rot || 0) % 180 + 180) % 180;
        if (r > 45 && r < 135) return { w: p.h, h: p.w };
        return { w: p.w, h: p.h };
    },

    _setPadAABBSize(p, w, h) {
        const r = ((p.rot || 0) % 180 + 180) % 180;
        if (r > 45 && r < 135) { p.h = w; p.w = h; }
        else { p.w = w; p.h = h; }
    },

    // Shrink pads that overlap so milled copper islands stay isolated.
    // Does not move pad centres (trace snap points stay valid).
    separateOverlappingPads(pads, minGap) {
        if (!pads || pads.length < 2) return pads;
        const gap = minGap == null ? 0.15 : minGap;
        for (let pass = 0; pass < 8; pass++) {
            let changed = false;
            for (let i = 0; i < pads.length; i++) {
                for (let j = i + 1; j < pads.length; j++) {
                    const a = pads[i], b = pads[j];
                    const aa = this._padAABB(a), bb = this._padAABB(b);
                    const overlapX = (aa.w + bb.w) / 2 - Math.abs(b.x - a.x);
                    const overlapY = (aa.h + bb.h) / 2 - Math.abs(b.y - a.y);
                    if (overlapX <= -gap || overlapY <= -gap) continue;
                    if (overlapX <= 0 && overlapY <= 0) continue;
                    const minDim = (p) => Math.max(0.3, p.drill || 0, (p.drillOval ? Math.min(p.drillOval.w, p.drillOval.h) : 0));
                    if (overlapX > 0 && overlapY > 0) {
                        changed = true;
                        if (overlapX <= overlapY) {
                            const need = overlapX + gap;
                            const nwA = Math.max(minDim(a), aa.w - need / 2);
                            const nwB = Math.max(minDim(b), bb.w - need / 2);
                            this._setPadAABBSize(a, nwA, aa.h);
                            this._setPadAABBSize(b, nwB, bb.h);
                        } else {
                            const need = overlapY + gap;
                            const nhA = Math.max(minDim(a), aa.h - need / 2);
                            const nhB = Math.max(minDim(b), bb.h - need / 2);
                            this._setPadAABBSize(a, aa.w, nhA);
                            this._setPadAABBSize(b, bb.w, nhB);
                        }
                    }
                }
            }
            if (!changed) break;
        }
        return pads;
    },

    // Body size from F.Fab graphics when present (pad bbox includes pad copper
    // and makes IC bodies cover neighbouring pads).
    _fabBodySize(fp) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const add = (x, y) => {
            if (typeof x !== 'number' || typeof y !== 'number') return;
            if (x < minX) minX = x; if (y < minY) minY = y;
            if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        };
        (fp.fab || []).concat(fp.silk || []).forEach(g => this._gfxAccumulate(g, add));
        if (!isFinite(minX)) return null;
        const width = maxX - minX, height = maxY - minY;
        if (width < 0.3 || height < 0.3) return null;
        return { width: +width.toFixed(3), height: +height.toFixed(3) };
    },

    // Points of one graphic, for bounding boxes. Arcs are sampled so a
    // TO-92 body or DIP notch contributes its real extent.
    _gfxAccumulate(g, add) {
        if (!g || typeof add !== 'function') return;
        if ((g.type === 'line' || g.type === 'rect') && typeof g.x1 === 'number') {
            add(g.x1, g.y1); add(g.x2, g.y2);
        } else if (g.type === 'circle' && g.r > 0) {
            add(g.x - g.r, g.y - g.r); add(g.x + g.r, g.y + g.r);
        } else if (g.type === 'arc' && g.r > 0 && typeof g.a0 === 'number') {
            const n = 12;
            const sweep = g.sweep || 0;
            for (let i = 0; i <= n; i++) {
                const a = g.a0 + sweep * i / n;
                add(g.x + g.r * Math.cos(a), g.y + g.r * Math.sin(a));
            }
        } else if (g.type === 'poly' && g.pts) {
            g.pts.forEach(pt => add(pt.x, pt.y));
        }
    },

    // fp_arc, both KiCad dialects. Angles are Y-up radians: 0 = +X, CCW positive.
    // Legacy: (start cx cy) is the centre, (end) is the arc start, (angle) is the sweep.
    // KiCad 6+: (start) (mid) (end) are three points on the arc.
    _kxFpArc(node) {
        const w = this._kxStrokeWidth(node);
        const start = _kxProp(node, 'start') || [];
        const end = _kxProp(node, 'end') || [];
        const mid = _kxProp(node, 'mid');
        const ang = _kxProp(node, 'angle');
        const num = (arr, i) => (arr && typeof arr[i] === 'number') ? arr[i] : null;
        if (mid && num(start, 1) != null && num(mid, 1) != null && num(end, 1) != null) {
            const c = _kxCircle3(start[1], start[2], mid[1], mid[2], end[1], end[2]);
            if (!c || c.r < 0.01) return null;
            const a0 = Math.atan2(start[2] - c.y, start[1] - c.x);
            const am = Math.atan2(mid[2] - c.y, mid[1] - c.x);
            const a1 = Math.atan2(end[2] - c.y, end[1] - c.x);
            const ccw = _kxCcw(a0, a1);
            const ccwMid = _kxCcw(a0, am);
            const sweep = (ccwMid <= ccw + 1e-3) ? ccw : (ccw - Math.PI * 2);
            return { type: 'arc', x: c.x, y: c.y, r: c.r, a0, sweep, w };
        }
        if (ang && typeof ang[1] === 'number' && num(start, 1) != null && num(end, 1) != null) {
            const cx = start[1], cy = start[2];
            const r = Math.hypot(end[1] - cx, end[2] - cy);
            if (r < 0.01) return null;
            return { type: 'arc', x: cx, y: cy, r, a0: Math.atan2(end[2] - cy, end[1] - cx), sweep: ang[1] * Math.PI / 180, w };
        }
        return null;
    },

    _shiftGfx(g, cx, cy) {
        const n = (v, o) => (typeof v === 'number' && isFinite(v)) ? +(v - o).toFixed(3) : v;
        const o = Object.assign({}, g);
        if (o.x1 != null) o.x1 = n(o.x1, cx);
        if (o.y1 != null) o.y1 = n(o.y1, cy);
        if (o.x2 != null) o.x2 = n(o.x2, cx);
        if (o.y2 != null) o.y2 = n(o.y2, cy);
        if (o.x != null) o.x = n(o.x, cx);
        if (o.y != null) o.y = n(o.y, cy);
        if (o.pts) o.pts = o.pts.map(pt => ({ x: n(pt.x, cx), y: n(pt.y, cy) }));
        return o;
    },

    _kxStrokeWidth(node, fallback) {
        const wd = _kxProp(node, 'width');
        if (wd && typeof wd[1] === 'number') return wd[1];
        const st = _kxProp(node, 'stroke');
        if (st) {
            const sw = _kxProp(st, 'width');
            if (sw && typeof sw[1] === 'number') return sw[1];
            if (typeof st[1] === 'number') return st[1];
        }
        return fallback == null ? 0.1 : fallback;
    },

    _kxLayer(node) {
        const ly = _kxProp(node, 'layer');
        return ly ? String(ly[1] || '') : '';
    },

    _kxShortPinName(name) {
        if (name == null) return '';
        let s = String(name).trim();
        if (!s || s === 'REF**' || s === '${REFERENCE}' || s.indexOf('%') === 0) return '';
        s = s.replace('~{RESET}', 'RST').replace('+5V', '5V');
        const slash = s.indexOf('/');
        if (slash > 0 && slash <= 8) s = s.slice(0, slash);
        return s;
    },

    // Parse a .kicad_mod footprint into a normalized structure.
    _parseFootprint(text) {
        const top = _kxParse(text);
        const fp = top.find(n => Array.isArray(n) && (n[0] === 'footprint' || n[0] === 'module'));
        if (!fp) return null;
        const name = (typeof fp[1] === 'string') ? fp[1] : String(fp[1]);
        const layerNode = _kxProp(fp, 'layer');
        const attrNode = _kxProp(fp, 'attr');

        // 3D model references (KiCad 6+ embed (model "name" (uri "...") ...) in footprints).
        const models = [];
        _kxAll(fp, 'model').forEach(m => {
            const nm = (typeof m[1] === 'string') ? m[1] : '';
            const u = _kxProp(m, 'uri') || _kxProp(m, 'path');
            const uri = (u && typeof u[1] === 'string') ? u[1] : '';
            if (uri && models.length < 10) models.push({ name: nm.slice(0, 120), uri: uri.slice(0, 300) });
        });

        const pads = [];
        _kxAll(fp, 'pad').forEach(pad => {
            const num = (pad[1] == null || pad[1] === '') ? '' : String(pad[1]);
            const ptype = pad[2];      // 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect'
            const shape = pad[3];      // 'rect'|'roundrect'|'circle'|'oval'|'hole'
            const at = _kxProp(pad, 'at') || [];
            const sz = _kxProp(pad, 'size') || [];
            const drillInfo = this._parseDrill(_kxProp(pad, 'drill'));
            pads.push({
                num, type: ptype, shape,
                x: typeof at[1] === 'number' ? at[1] : 0,
                y: typeof at[2] === 'number' ? at[2] : 0,
                rot: typeof at[3] === 'number' ? at[3] : 0,
                w: typeof sz[1] === 'number' ? sz[1] : 1,
                h: typeof sz[2] === 'number' ? sz[2] : (typeof sz[1] === 'number' ? sz[1] : 1),
                drill: drillInfo.drill, drillOval: drillInfo.drillOval
            });
        });
        this.separateOverlappingPads(pads, 0.15);

        const fab = [], silk = [], texts = [];
        const pushG = (ly, g) => {
            if (ly === 'F.Fab') fab.push(g);
            else if (ly === 'F.SilkS') silk.push(g);
        };
        _kxAll(fp, 'fp_line').forEach(l => {
            const s = _kxProp(l, 'start') || [], e = _kxProp(l, 'end') || [];
            pushG(this._kxLayer(l), { type: 'line', x1: s[1], y1: s[2], x2: e[1], y2: e[2], w: this._kxStrokeWidth(l) });
        });
        _kxAll(fp, 'fp_rect').forEach(r => {
            const s = _kxProp(r, 'start') || [], e = _kxProp(r, 'end') || [];
            pushG(this._kxLayer(r), { type: 'rect', x1: s[1], y1: s[2], x2: e[1], y2: e[2], w: this._kxStrokeWidth(r) });
        });
        _kxAll(fp, 'fp_circle').forEach(c => {
            const ce = _kxProp(c, 'center') || [], en = _kxProp(c, 'end') || [];
            const cx = ce[1], cy = ce[2];
            const rad = Math.hypot((en[1] || 0) - cx, (en[2] || 0) - cy);
            pushG(this._kxLayer(c), { type: 'circle', x: cx, y: cy, r: rad, w: this._kxStrokeWidth(c) });
        });
        _kxAll(fp, 'fp_arc').forEach(a => {
            const arc = this._kxFpArc(a);
            if (arc) pushG(this._kxLayer(a), arc);
        });
        _kxAll(fp, 'fp_poly').forEach(p => {
            const ptsNode = _kxProp(p, 'pts') || [];
            const pts = [];
            for (let i = 1; i < ptsNode.length; i++) {
                const xy = ptsNode[i];
                if (Array.isArray(xy) && xy[0] === 'xy') pts.push({ x: xy[1], y: xy[2] });
            }
            if (pts.length) pushG(this._kxLayer(p), { type: 'poly', pts, w: this._kxStrokeWidth(p), fill: !!_kxProp(p, 'fill') });
        });
        _kxAll(fp, 'fp_text').forEach(tx => {
            const kind = tx[1], raw = tx[2];
            if (kind === 'reference' || kind === 'value') return;
            const label = this._kxShortPinName(typeof raw === 'string' ? raw : '');
            if (!label) return;
            const at = _kxProp(tx, 'at') || [];
            const fx = _kxProp(_kxProp(tx, 'effects') || [], 'font');
            const sz = fx ? _kxProp(fx, 'size') : null;
            const just = _kxProp(_kxProp(tx, 'effects') || [], 'justify');
            texts.push({
                text: label,
                x: typeof at[1] === 'number' ? at[1] : 0,
                y: typeof at[2] === 'number' ? at[2] : 0,
                rot: typeof at[3] === 'number' ? at[3] : 0,
                size: (sz && typeof sz[1] === 'number') ? sz[1] : 0.7,
                justify: just ? String(just[1] || 'center') : 'center',
                layer: this._kxLayer(tx)
            });
        });

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const addPt = (x, y) => { if (x == null || y == null) return; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        // Component size/centre is the pin field (pad bounding box). Fab/silk graphics
        // are drawn on top in board-view; they may extend beyond this box.
        pads.forEach(p => { addPt(p.x - p.w / 2, p.y - p.h / 2); addPt(p.x + p.w / 2, p.y + p.h / 2); });
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 2; maxY = 2; }

        return { name, layer: layerNode ? layerNode[1] : 'F.Cu', attr: attrNode ? String(attrNode[1]) : '', pads, fab, silk, texts, models, bbox: { minX, minY, maxX, maxY } };
    },
    // Parse a .kicad_sym symbol library into { name: { opins, footprint, graphics } }.
    _parseSymbol(text) {
        const top = _kxParse(text);
        const lib = top.find(n => Array.isArray(n) && (n[0] === 'kicad_symbol_lib' || n[0] === 'symbol_library'));
        if (!lib) return null;
        const out = {};
        // (pts (xy x y) (xy x y) ...) -> [[x,y],...]
        const ptsOf = (node) => {
            const p = _kxProp(node, 'pts');
            if (!p) return null;
            const pts = [];
            _kxAll(p, 'xy').forEach(xy => {
                if (typeof xy[1] === 'number' && typeof xy[2] === 'number') pts.push([xy[1], xy[2]]);
            });
            return pts.length >= 2 ? pts : null;
        };
        _kxAll(lib, 'symbol').forEach(sym => {
            const name = (typeof sym[1] === 'string') ? sym[1] : String(sym[1]);
            // KiCad wraps the graphical pins in a nested (symbol "...") node.
            const nested = _kxAll(sym, 'symbol');
            const pinHost = nested.length ? nested[0] : sym;
            // Footprint link property ("Library:Footprint").
            let footprint = '';
            _kxAll(sym, 'property').forEach(pr => { if (pr[1] === 'Footprint' && typeof pr[3] === 'string') footprint = pr[3]; });
            // Symbol graphics (symbol units: 100 units = 1.27 mm; 200 = 2.54 mm pin).
            const graphics = [];
            const pushG = (g) => { if (graphics.length < 300) graphics.push(g); };
            _kxAll(pinHost, 'rect').forEach(r => { const p = ptsOf(r); if (p) pushG({ t: 'r', pts: [p[0], p[p.length - 1]] }); });
            _kxAll(pinHost, 'polyline').forEach(pl => { const p = ptsOf(pl); if (p) pushG({ t: 'p', pts: p }); });
            _kxAll(pinHost, 'ellipse').forEach(e => { const p = ptsOf(e); if (p) pushG({ t: 'e', pts: [p[0], p[p.length - 1]] }); });
            // KiCad arc stores (width height mid end); start = mid - (w/2, h/2).
            _kxAll(pinHost, 'arc').forEach(a => {
                const wd = _kxProp(a, 'width'), ht = _kxProp(a, 'height');
                const mid = _kxProp(a, 'mid'), end = _kxProp(a, 'end');
                if (!mid || !end) return;
                const w = (wd && typeof wd[1] === 'number') ? wd[1] : 0;
                const h = (ht && typeof ht[1] === 'number') ? ht[1] : 0;
                if (typeof mid[1] !== 'number' || typeof mid[2] !== 'number' ||
                    typeof end[1] !== 'number' || typeof end[2] !== 'number') return;
                pushG({ t: 'a', pts: [[mid[1] - w / 2, mid[2] - h / 2], [mid[1], mid[2]], [end[1], end[2]]] });
            });
            const opins = [];
            _kxAll(pinHost, 'pin').forEach(pin => {
                const kind = pin[2], ptype = pin[3];
                const at = _kxProp(pin, 'at') || [];
                const nm = _kxProp(pin, 'name');
                const op = _kxProp(pin, 'number');
                const numStr = (op && typeof op[1] === 'string') ? op[1] : '';
                let numVal;
                if (/^\d+$/.test(numStr)) numVal = parseInt(numStr, 10);
                else {
                    const m = numStr.match(/\d+/g);
                    numVal = m ? parseInt(m[m.length - 1], 10) : null;
                }
                const px = typeof at[1] === 'number' ? at[1] : 0;
                const py = typeof at[2] === 'number' ? at[2] : 0;
                const ang = typeof at[3] === 'number' ? at[3] : 0;
                const lenN = _kxProp(pin, 'length');
                const len = (lenN && typeof lenN[1] === 'number') ? lenN[1] : 0;
                // Pin graphic: line from the anchor along its angle.
                if (len > 0) {
                    const rad = ang * Math.PI / 180;
                    pushG({ t: 'l', pts: [[px, py], [px + len * Math.cos(rad), py + len * Math.sin(rad)]] });
                }
                opins.push({
                    kind, type: ptype,
                    x: px, y: py,
                    name: (nm && typeof nm[1] === 'string') ? nm[1] : '',
                    numStr, numVal
                });
            });
            out[name] = { opins, footprint, graphics };
        });
        return out;
    },
    // Build a ComponentDefs entry from a parsed footprint (+ optional symbol).
    _buildDef(fp, sym) {
        const pads = fp.pads;
        const bbox = fp.bbox;
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;

        // Order pins by numeric pad number so schematic pin index is stable.
        const ordered = pads.slice().sort((a, b) => {
            const na = /^\d+$/.test(a.num) ? parseInt(a.num, 10) : Infinity;
            const nb = /^\d+$/.test(b.num) ? parseInt(b.num, 10) : Infinity;
            if (na !== nb) return na - nb;
            return a.num.localeCompare(b.num);
        });

        // Match symbol opins to pads by number for pin names.
        const nameFor = {};
        let hasSymNames = false;
        if (sym && sym.opins) {
            sym.opins.forEach(op => {
                if (op.numVal != null) { nameFor[op.numVal] = op.name; hasSymNames = true; }
            });
        }

        const pins = ordered.map(p => ({
            x: +(p.x - cx).toFixed(3),
            y: +(p.y - cy).toFixed(3),
            name: (hasSymNames && nameFor[parseInt(p.num, 10)]) ? nameFor[parseInt(p.num, 10)] : p.num
        }));

        const fabSize = this._fabBodySize(fp);
        const width = fabSize ? fabSize.width : Math.max(bbox.maxX - bbox.minX, 0.5);
        const height = fabSize ? fabSize.height : Math.max(bbox.maxY - bbox.minY, 0.5);
        const th = pads.some(p => p.type === 'thru_hole');
        const kicad = {
            name: fp.name, layer: fp.layer, attr: fp.attr,
            cx, cy,
            pads: ordered.map(p => ({
                num: p.num, type: p.type, shape: p.shape,
                x: +(p.x - cx).toFixed(3), y: +(p.y - cy).toFixed(3), rot: p.rot || 0,
                w: p.w, h: p.h, drill: p.drill || 0, drillOval: p.drillOval
            })),
            fab: fp.fab.map(g => this._shiftGfx(g, cx, cy)),
            silk: fp.silk.map(g => this._shiftGfx(g, cx, cy))
        };

        const size = {
            name: fp.name, width: +width.toFixed(3), height: +height.toFixed(3),
            th, pins, kicad
        };
        // Real symbol graphics (symbol units) — schematic-view draws them when present.
        if (sym && sym.graphics && sym.graphics.length) size.symGraphics = sym.graphics;
        // KiCad 3D model references from the footprint (name + uri/path).
        if (fp.models && fp.models.length) size.model3d = fp.models;

        let refPrefix = 'U';
        if (/^R/i.test(fp.name)) refPrefix = 'R';
        else if (/^C/i.test(fp.name)) refPrefix = 'C';
        else if (/(L|IND)/i.test(fp.name)) refPrefix = 'L';
        else if (/(DIP|SOP|SOIC|QFP|BGA|TSSOP|LQFP|TQFP|QFN|DFN|MSOP|SSOP|PLCC|PGA)/i.test(fp.name)) refPrefix = 'U';
        else if (/^(LED|LM)/i.test(fp.name)) refPrefix = 'D';

        const defKey = 'kx_' + fp.name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
        return {
            key: defKey,
            type: 'ic',
            label: fp.name,
            value: '',
            refPrefix,
            kicadImported: true,
            defaultSize: 0,
            sizes: [size]
        };
    },
    // Register built defs into ComponentDefs and inject palette entries.
    registerEntries(entries) {
        let added = 0;
        (entries || []).forEach(def => {
            if (!def || !def.key) return;
            const existing = ComponentDefs.defs[def.key];
            if (existing) {
                // Refresh geometry but preserve any placed-instance defaults.
                existing.key = def.key;
                existing.label = def.label;
                existing.refPrefix = def.refPrefix;
                existing.sizes = def.sizes;
                existing.kicadImported = true;
            } else {
                ComponentDefs.defs[def.key] = def;
            }
            added++;
        });
        return added;
    },

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    // Build a small schematic-style SVG icon from the pin layout.
    _iconSVG(size) {
        const pins = (size && size.pins) || [];
        if (!pins.length) return '<svg viewBox="0 0 40 32"><rect x="12" y="8" width="16" height="16" fill="none" stroke="#ccc"/></svg>';
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pins.forEach(p => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; });
        const bw = Math.max(maxX - minX, 0.1), bh = Math.max(maxY - minY, 0.1);
        const pad = Math.max(bw, bh) * 0.35 + 0.2;
        const scale = 28 / (Math.max(bw, bh) + pad * 2);
        const toX = x => 20 + (x - (minX + maxX) / 2) * scale;
        const toY = y => 16 + (y - (minY + maxY) / 2) * scale;
        let dots = '';
        pins.forEach(p => { dots += '<circle cx="' + toX(p.x).toFixed(1) + '" cy="' + toY(p.y).toFixed(1) + '" r="1.6" fill="#7fd4ff"/>'; });
        const bwPx = bw * scale, bhPx = bh * scale;
        return '<svg viewBox="0 0 40 32"><rect x="' + (20 - bwPx / 2).toFixed(1) + '" y="' + (16 - bhPx / 2).toFixed(1) + '" width="' + bwPx.toFixed(1) + '" height="' + bhPx.toFixed(1) + '" fill="none" stroke="#ccc"/><circle cx="' + toX(pins[0].x).toFixed(1) + '" cy="' + toY(pins[0].y).toFixed(1) + '" r="2.2" fill="#7fd4ff"/>' + dots + '</svg>';
    },

    // Compact display label for a footprint: strip KiCad namespace prefixes and
    // pitch/size suffixes so palette labels fit ("Capacitor_THT_CP_D5.0mm_P2.50mm" → "CP D5.0 P2.50").
    _shortLabel(name) {
        let s = String(name || '');
        s = s.replace(/^[A-Za-z0-9_]+:/, '');
        s = s.replace(/^(Capacitor|Resistor|Inductor|Diode|Transistor|Package|Connector|Fuse|Switch|Crystal)_/, '');
        s = s.replace(/_(P\d+(?:\.\d+)?mm|D\d+(?:\.\d+)?mm|L\d+(?:\.\d+)?mm|W\d+(?:\.\d+)?mm|\d+(?:\.\d+)?x\d+(?:\.\d+)?mm|Pad\d+(?:\.\d+)?mm_P\d+(?:\.\d+)?mm)/g, ' $1');
        s = s.replace(/(\d+(?:\.\d+)?)mm/g, '$1');
        s = s.replace(/_(\d+(?:\.\d+)?x\d+(?:\.\d+)?|P\d+(?:\.\d+)?|D\d+(?:\.\d+)?|L\d+(?:\.\d+)?|W\d+(?:\.\d+)?|Pad\d+(?:\.\d+)?)/g, ' $1');
        s = s.replace(/_Vertical|_Horizontal/g, '');
        s = s.replace(/[_\s]+/g, ' ').trim();
        return s || String(name || '');
    },

    _readFile(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('Failed to read ' + file.name));
            if (file.type && file.type.indexOf('zip') !== -1) r.readAsArrayBuffer(file);
            else r.readAsText(file);
        });
    },

    // Import a FileList / array of files (.zip, .kicad_mod, .kicad_sym).
    async importFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return 0;
        let added = 0, failed = 0;
        for (const file of files) {
            try {
                const lower = file.name.toLowerCase();
                if (lower.endsWith('.zip')) {
                    added += await this._importZip(file);
                } else if (lower.endsWith('.kicad_mod') || lower.endsWith('.mod')) {
                    const text = await this._readFile(file);
                    const fp = this._parseFootprint(text);
                    if (!fp) throw new Error('No footprint found in ' + file.name);
                    added += this.registerEntries([this._buildDef(fp, null)]);
                } else if (lower.endsWith('.kicad_sym') || lower.endsWith('.sym')) {
                    // A bare symbol without a footprint has no pads; report it.
                    throw new Error(file.name + ' is a symbol only - import its .kicad_mod or a .zip package');
                } else {
                    failed++;
                }
            } catch (err) {
                failed++;
                if (typeof App !== 'undefined' && App.setStatus) App.setStatus('KiCad import error: ' + err.message);
                console.warn('KiCad import:', file.name, err);
            }
        }
        const msg = `Imported ${added} KiCad part${added === 1 ? '' : 's'} - open Library to place` + (failed ? ` (${failed} failed)` : '');
        if (typeof App !== 'undefined' && App.setStatus) App.setStatus(msg);
        if (added && typeof ComponentLibrary !== 'undefined' && ComponentLibrary.open) ComponentLibrary.open();
        return added;
    },

    async _importZip(file) {
        const buf = await this._readFile(file);
        const zip = await JSZip.loadAsync(buf);
        const mods = [], syms = [];
        for (const path of Object.keys(zip.files)) {
            const f = zip.files[path];
            if (f.dir) continue;
            const lower = path.toLowerCase();
            if (lower.endsWith('.kicad_mod') || lower.endsWith('.mod')) mods.push({ name: path, text: await f.async('string') });
            else if (lower.endsWith('.kicad_sym') || lower.endsWith('.sym')) syms.push({ name: path, text: await f.async('string') });
        }
        return this._pairAndBuild(mods, syms);
    },

    // Pair each footprint with a symbol and register defs.
    _pairAndBuild(mods, syms) {
        const parsedSyms = [];  // { symName, opins, footprint }
        syms.forEach(s => {
            const parsed = this._parseSymbol(s.text);
            if (!parsed) return;
            for (const key of Object.keys(parsed)) parsedSyms.push({ symName: key, ...parsed[key] });
        });
        const defs = [];
        mods.forEach(m => {
            const fp = this._parseFootprint(m.text);
            if (!fp) return;
            // 1) Symbol that explicitly references this footprint ("Lib:Fp").
            let sym = parsedSyms.find(ps => {
                const ref = ps.footprint ? String(ps.footprint).split(':').pop() : '';
                return ref && ref.toLowerCase() === fp.name.toLowerCase();
            }) || null;
            // 2) Fallback: same name, else the only symbol present.
            if (!sym) sym = parsedSyms.find(ps => ps.symName.toLowerCase() === fp.name.toLowerCase()) || null;
            if (!sym && parsedSyms.length === 1) sym = parsedSyms[0];
            defs.push(this._buildDef(fp, sym));
        });
        return this.registerEntries(defs);
    },
    // Extract .kicad_mod/.kicad_sym from an in-memory zip ArrayBuffer.
    async _importZipBytes(buf) {
        const zip = await JSZip.loadAsync(buf);
        const mods = [], syms = [];
        for (const path of Object.keys(zip.files)) {
            const f = zip.files[path];
            if (f.dir) continue;
            const lower = path.toLowerCase();
            if (lower.endsWith('.kicad_mod') || lower.endsWith('.mod')) mods.push({ name: path, text: await f.async('string') });
            else if (lower.endsWith('.kicad_sym') || lower.endsWith('.sym')) syms.push({ name: path, text: await f.async('string') });
        }
        return this._pairAndBuild(mods, syms);
    },

    // Fetch a single package (zip or footprint) listed in the PCBLib manifest.
    async _fetchPackage(p) {
        const url = p.url;
        const lower = String(url).toLowerCase();
        if (lower.endsWith('.zip')) {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
            return this._importZipBytes(await resp.arrayBuffer());
        } else if (lower.endsWith('.kicad_mod') || lower.endsWith('.mod')) {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
            const fp = this._parseFootprint(await resp.text());
            if (!fp) return 0;
            return this.registerEntries([this._buildDef(fp, null)]);
        }
        return 0;
    },

    // Auto-load packages from /PCBLib via a generated manifest (HTTP only).
    async autoScanPCBLib() {
        try {
            const resp = await fetch('PCBLib/index.json', { cache: 'no-cache' });
            if (!resp.ok) return 0;
            const manifest = await resp.json();
            const packages = (manifest && (manifest.packages || manifest.parts)) || [];
            let added = 0;
            for (const p of packages) {
                try { added += await this._fetchPackage(p); }
                catch (e) { console.warn('PCBLib auto-scan:', e); }
            }
            if (added && typeof App !== 'undefined' && App.setStatus) App.setStatus(`Loaded ${added} part(s) from /PCBLib`);
            return added;
        } catch (e) {
            // No manifest or not served over HTTP - the manual picker is the fallback.
            return 0;
        }
    },

    // All imported component definitions (for persistence).
    getImportedDefs() {
        const out = [];
        for (const key of Object.keys(ComponentDefs.defs)) {
            const d = ComponentDefs.defs[key];
            if (!d) continue;
            // A refreshed entry used to keep the geometry and drop `key`, so the
            // preview restored nothing and the part drew as an empty type.
            if (!d.key) d.key = key;
            if (d.kicadImported || String(key).indexOf('kx_') === 0) out.push(d);
        }
        return out;
    },

    // Re-register persisted imported defs after a project load.
    restoreDefs(obj) {
        if (!obj) return 0;
        const list = Array.isArray(obj) ? obj : [obj];
        let n = 0;
        list.forEach(def => {
            if (!def || !def.key) return;
            ComponentDefs.defs[def.key] = def;
            n++;
        });
        return n;
    },

    // Wire up the palette button + file input, then attempt /PCBLib auto-scan.
    init() {
        const btn = document.getElementById('kicad-import-btn');
        const input = document.getElementById('kicad-file-input');
        if (btn && input) {
            btn.addEventListener('click', () => { input.value = ''; input.click(); });
            input.addEventListener('change', async (e) => { await this.importFiles(e.target.files); });
        }
        if (!/^(file:|chrome-extension:)/i.test(location.protocol)) {
            this.autoScanPCBLib().catch(() => {});
        }
    },
};

