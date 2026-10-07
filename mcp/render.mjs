// millPCB render — DOM-free board/schematic rasterizer + PNG encoder.
// Gives MCP agents "eyes": millpcb_screenshot returns a PNG the agent can
// actually see. Pure Node (node:zlib only) — no canvas, no native deps.
//
// Coordinate convention matches the board view: mm, origin at board center,
// Y-down. Schematic space uses schemX/schemY (renderer units) when present.
import zlib from 'node:zlib';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { loadKernel } from './host.mjs';

// export.js is a browser kernel file (no module system in the browser); load
// it into a bare vm context so we can reuse Export.padFeatures() geometry.
let Export = null;
function loadExport(rootDir) {
    if (Export) return Export;
    const ctx = vm.createContext({ console, App: {}, module: { exports: {} } });
    vm.runInContext(fs.readFileSync(path.join(rootDir, 'js', 'export.js'), 'utf8'), ctx, { filename: 'export.js' });
    Export = ctx.module.exports;
    return Export;
}

// ---------------------------------------------------------------------------
// PNG encoder (8-bit RGB, filter 0)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // color type: RGB
    const raw = Buffer.alloc(height * (width * 3 + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0; // filter: none
        rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ---------------------------------------------------------------------------
// Canvas — small software rasterizer over an RGB pixel buffer
// ---------------------------------------------------------------------------
class Canvas {
    constructor(width, height, bg) {
        this.w = width;
        this.h = height;
        this.px = Buffer.alloc(width * height * 3);
        this.bg = bg;
        this.fillBg();
    }
    fillBg() {
        const [r, g, b] = this.bg;
        for (let i = 0; i < this.px.length; i += 3) { this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; }
    }
    set(x, y, c) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const i = (y * this.w + x) * 3;
        this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
    }
    blend(x, y, c, a) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const i = (y * this.w + x) * 3;
        this.px[i] = Math.round(this.px[i] + (c[0] - this.px[i]) * a);
        this.px[i + 1] = Math.round(this.px[i + 1] + (c[1] - this.px[i + 1]) * a);
        this.px[i + 2] = Math.round(this.px[i + 2] + (c[2] - this.px[i + 2]) * a);
    }
    disc(cx, cy, r, c, alpha = 1) {
        const r2 = r * r;
        const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
        const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
        for (let y = y0; y <= y1; y++) {
            const dy = y - cy;
            for (let x = x0; x <= x1; x++) {
                const dx = x - cx;
                if (dx * dx + dy * dy <= r2) { if (alpha === 1) this.set(x, y, c); else this.blend(x, y, c, alpha); }
            }
        }
    }
    line(x0, y0, x1, y1, w, c) {
        const len = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(len));
        const r = Math.max(0.5, w / 2);
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            this.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, c);
        }
    }
    polyline(pts, w, c) {
        for (let i = 1; i < pts.length; i++) this.line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, w, c);
    }
    polygon(pts, c, alpha = 1) {
        if (pts.length < 3) return;
        let minY = Infinity, maxY = -Infinity;
        for (const p of pts) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
            const xs = [];
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
                    xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
                }
            }
            xs.sort((p, q) => p - q);
            for (let k = 0; k + 1 < xs.length; k += 2) {
                for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) {
                    if (alpha === 1) this.set(x, y, c); else this.blend(x, y, c, alpha);
                }
            }
        }
    }
    rectOutline(x0, y0, x1, y1, c, w = 1) {
        this.line(x0, y0, x1, y0, w, c); this.line(x1, y0, x1, y1, w, c);
        this.line(x1, y1, x0, y1, w, c); this.line(x0, y1, x0, y0, w, c);
    }
    toPng() { return encodePng(this.w, this.h, this.px); }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const C = {
    outside: [24, 24, 28],
    board: [38, 74, 48],
    boardEdge: [210, 210, 210],
    copper: [205, 170, 90],
    pad: [235, 215, 150],
    drill: [24, 24, 28],
    body: [90, 95, 105],
    bodyEdge: [170, 175, 185],
    zone: [80, 130, 235],
    via: [205, 170, 90],
    schemBg: [22, 26, 34],
    schemBoard: [30, 36, 46],
    schemBody: [70, 110, 170],
    schemBodyEdge: [150, 190, 240],
    wire: [200, 200, 210]
};

function netColor(project, netName) {
    const n = (project.nets || []).find(x => x.name === netName);
    const m = n && /^#([0-9a-f]{6})$/i.exec(n.color || '');
    if (!m) return C.wire;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rotPoint(p, cx, cy, deg) {
    const rad = (deg || 0) * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const dx = p.x - cx, dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

function compBox(size) {
    if (size && size.kicad && size.kicad.bbox) {
        const bb = size.kicad.bbox;
        return { w: bb.w || 2, h: bb.h || 2 };
    }
    const w = size ? (size.width || 2) : 2;
    const h = size ? (size.height || 1) : 1;
    return { w: Math.max(w, 0.5), h: Math.max(h, 0.5) };
}

// KiCad footprint graphics (fab/silk) -> canvas strokes. xf maps footprint-local
// mm (component origin, pre-rotation) to pixel space; lw(mm) scales line widths.
function kxGraphic(cv, g, xf, lw, color, alpha) {
    if (!g || g.type == null) return;
    if (g.type === 'line') {
        const a = xf({ x: g.x1, y: g.y1 }), b = xf({ x: g.x2, y: g.y2 });
        cv.line(a.x, a.y, b.x, b.y, lw(g.w), color);
    } else if (g.type === 'rect') {
        const a = xf({ x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2) });
        const b = xf({ x: Math.max(g.x1, g.x2), y: Math.max(g.y1, g.y2) });
        cv.rectOutline(a.x, a.y, b.x, b.y, color, lw(g.w));
    } else if (g.type === 'circle') {
        const c = xf({ x: g.x, y: g.y });
        const r = (g.r || 0) * cv._kxScale;
        if (r < 0.3) return;
        const pts = [];
        for (let i = 0; i < 40; i++) {
            const a = i / 40 * Math.PI * 2;
            pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
        }
        cv.polyline(pts.concat([pts[0]]), lw(g.w), color);
    } else if (g.type === 'arc' && g.r > 0) {
        const c = xf({ x: g.x, y: g.y });
        const r = (g.r || 0) * (cv._kxScale || 1);
        if (r < 0.3) return;
        const sweep = g.sweep || 0;
        const n = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 10)));
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const a = g.a0 + sweep * i / n;
            pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
        }
        cv.polyline(pts, lw(g.w), color);
    } else if (g.type === 'poly' && g.pts && g.pts.length >= 3) {
        const pts = g.pts.map(p => xf(p));
        if (g.fill) cv.polygon(pts, color, alpha);
        cv.polyline(pts.concat([pts[0]]), lw(g.w), color);
    }
}

// Exact KiCad pad shape as a filled polygon (circle pads use disc).
function kxPadShape(p) {
    const pts = [];
    if (p.shape === 'circle' || p.shape === 'hole') {
        const r = Math.max(p.w, p.h) / 2;
        for (let i = 0; i < 24; i++) {
            const a = i / 24 * Math.PI * 2;
            pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
        }
    } else if (p.shape === 'oval') {
        const rx = p.w / 2, ry = p.h / 2;
        for (let i = 0; i < 24; i++) {
            const a = i / 24 * Math.PI * 2;
            pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
        }
    } else if (p.shape === 'roundrect') {
        const r = Math.min(p.w, p.h) * 0.25;
        const hw = p.w / 2, hh = p.h / 2;
        const corners = [[hw, -hh, 0], [hw, hh, Math.PI / 2], [-hw, hh, Math.PI], [-hw, -hh, Math.PI * 1.5]];
        for (const [cx, cy, a0] of corners) {
            for (let k = 0; k <= 4; k++) {
                const a = a0 + k / 4 * Math.PI / 2;
                pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
            }
        }
    } else {
        pts.push({ x: -p.w / 2, y: -p.h / 2 }, { x: p.w / 2, y: -p.h / 2 },
            { x: p.w / 2, y: p.h / 2 }, { x: -p.w / 2, y: p.h / 2 });
    }
    return pts;
}

// ---------------------------------------------------------------------------
// Board render
// ---------------------------------------------------------------------------
// api: the kernel ProjectApi (needs getCompSize + adapter for pad geometry).
export function renderBoardPng(project, api, rootDir, opts = {}) {
    Export = loadExport(rootDir);
    const maxPx = Math.min(1400, Math.max(200, opts.maxSize || 900));
    const bw = project.board.width, bh = project.board.height;
    const scale = Math.min(maxPx / Math.max(bw, 1), maxPx / Math.max(bh, 1));
    const W = Math.round(bw * scale) + 40, H = Math.round(bh * scale) + 40;
    const ox = 20, oy = 20;
    const X = (x) => ox + (x + bw / 2) * scale;
    const Y = (y) => oy + (y + bh / 2) * scale;

    const cv = new Canvas(W, H, C.outside);
    // board sheet
    cv.polygon([
        { x: X(-bw / 2), y: Y(-bh / 2) }, { x: X(bw / 2), y: Y(-bh / 2) },
        { x: X(bw / 2), y: Y(bh / 2) }, { x: X(-bw / 2), y: Y(bh / 2) }
    ], C.board);
    if (project.boardOutline && project.boardOutline.length >= 3) {
        cv.polygon(project.boardOutline.map(p => ({ x: X(p.x), y: Y(p.y) })), C.board);
    }
    cv.rectOutline(X(-bw / 2), Y(-bh / 2), X(bw / 2), Y(bh / 2), C.boardEdge, 2);

    // plan zones
    for (const z of project.zones || []) {
        const hw = (z.w || 0) / 2, hh = (z.h || 0) / 2;
        cv.rectOutline(X(z.x - hw), Y(z.y - hh), X(z.x + hw), Y(z.y + hh), C.zone, 2);
    }

    // copper traces (skip logical schematic wires)
    for (const t of project.traces || []) {
        if (t.schemWire) continue;
        const pts = (t.points || []).map(p => ({ x: X(p.x), y: Y(p.y) }));
        if (pts.length < 2) continue;
        cv.polyline(pts, Math.max(1.5, (t.width || project.params.traceWidth || 0.5) * scale), C.copper);
    }

    // vias
    for (const v of project.vias || []) {
        cv.disc(X(v.x), Y(v.y), Math.max(1, (v.diameter || 1.2) / 2 * scale), C.via);
        cv.disc(X(v.x), Y(v.y), Math.max(0.5, (v.drillDiameter || 0.6) / 2 * scale), C.drill);
    }

    // components: built-ins get body + pad geometry (same source as SVG export);
    // KiCad imports draw fab/silk graphics + exact pads, matching the editor.
    const app = api.adapter(project);
    for (const comp of project.components || []) {
        const size = api.getCompSize(comp);
        const k = size && size.kicad;
        if (k) {
            const rot = comp.rotation || 0;
            const xf = (p) => { const q = rotPoint(p, 0, 0, rot); return { x: X(comp.x + q.x), y: Y(comp.y + q.y) }; };
            cv._kxScale = scale;
            const lw = (mm) => Math.max(1, (mm || 0.12) * scale);
            (k.fab || []).forEach(g => kxGraphic(cv, g, xf, lw, [205, 212, 226], 0.45));
            (k.silk || []).forEach(g => kxGraphic(cv, g, xf, lw, [240, 244, 252], 0.85));
            for (const p of (k.pads || [])) {
                const pts = kxPadShape(p).map(q => {
                    const r1 = rotPoint(q, 0, 0, p.rot || 0);
                    return xf({ x: p.x + r1.x, y: p.y + r1.y });
                });
                cv.polygon(pts, C.pad);
                cv.polyline(pts.concat([pts[0]]), 1, [40, 32, 10]);
                if (p.type === 'thru_hole') {
                    const c = xf(rotPoint({ x: p.x, y: p.y }, 0, 0, p.rot || 0));
                    if (p.drillOval) {
                        const dr = Math.max(p.drillOval.w, p.drillOval.h) / 2 * scale;
                        cv.disc(c.x, c.y, Math.max(0.5, dr), C.drill);
                    } else if (p.drill) {
                        cv.disc(c.x, c.y, Math.max(0.5, p.drill / 2 * scale), C.drill);
                    }
                }
            }
            const box = compBox(size);
            const label = comp.label || '';
            if (label) drawText(cv, label, X(comp.x), Y(comp.y) - (box.h / 2 + 3) * scale, Math.max(6, Math.min(9, 1.0 * scale)), [232, 244, 255], 'center');
            continue;
        }
        const box = compBox(size);
        const hw = box.w / 2, hh = box.h / 2;
        const corners = [{ x: comp.x - hw, y: comp.y - hh }, { x: comp.x + hw, y: comp.y - hh },
        { x: comp.x + hw, y: comp.y + hh }, { x: comp.x - hw, y: comp.y + hh }]
            .map(p => rotPoint({ x: X(p.x), y: Y(p.y) }, X(comp.x), Y(comp.y), comp.rotation || 0));
        cv.polygon(corners, C.body, 0.85);
        for (const pad of Export.padFeatures(app, comp)) {
            if (pad.kind === 'circle') {
                cv.disc(X(pad.x), Y(pad.y), Math.max(1, pad.r * scale), C.pad);
                if (pad.thru && pad.drill > 0) cv.disc(X(pad.x), Y(pad.y), Math.max(0.5, pad.drill / 2 * scale), C.drill);
            } else if (pad.pts && pad.pts.length >= 3) {
                cv.polygon(pad.pts.map(p => ({ x: X(p.x), y: Y(p.y) })), C.pad);
                if (pad.thru && pad.drill > 0) cv.disc(X(pad.cx), Y(pad.cy), Math.max(0.5, pad.drill / 2 * scale), C.drill);
            }
        }
    }

    return cv.toPng();
}

// ---------------------------------------------------------------------------
// Schematic render — mirrors the browser schematic: SchematicLayout topology
// placement + SchematicView symbol geometry and per-type glyph drawing, with
// the same obstacle-aware orthogonal wire router the browser cache uses.
// ---------------------------------------------------------------------------

// 5x7 pixel font (A-Z, 0-9, few symbols) for labels — no canvas text in Node.
const FONT57 = {
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    'D': ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['10010', '10010', '10010', '11111', '00010', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
    '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
    ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function drawText(cv, text, x, y, px, color, align = 'center') {
    const s = String(text || '');
    const cell = Math.max(1, Math.round(px / 7));
    const w = s.length * 5 * cell + (s.length - 1) * cell;
    let x0 = x;
    if (align === 'center') x0 = x - w / 2;
    else if (align === 'right') x0 = x - w;
    for (let ci = 0; ci < s.length; ci++) {
        const g = FONT57[s[ci].toUpperCase()];
        if (!g) continue;
        const gx = x0 + ci * 6 * cell;
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                if (g[row][col] !== '1') continue;
                for (let dy = 0; dy < cell; dy++) {
                    for (let dx = 0; dx < cell; dx++) cv.set(Math.round(gx + dx), Math.round(y + row * cell + dy), color);
                }
            }
        }
    }
    return w;
}

function parseColor(c) {
    if (Array.isArray(c)) return { rgb: c, a: 1 };
    const str = String(c || '');
    let m = /^#([0-9a-f]{6})$/i.exec(str);
    if (m) { const v = parseInt(m[1], 16); return { rgb: [(v >> 16) & 255, (v >> 8) & 255, v & 255], a: 1 }; }
    m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(str);
    if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] !== undefined ? +m[4] : 1 };
    return { rgb: [200, 200, 210], a: 1 };
}

// Canvas2D shim over the pixel Canvas: affine transform + path building.
// Lets SchematicView.draw*Symbol run unmodified in Node.
function makeCtx(canvas, scale) {
    const ident = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const stack = [];
    let m = { ...ident };
    let paths = [];
    let cur = null;
    const ctx = {
        lineWidth: 2,
        strokeStyle: '#aaddff',
        fillStyle: '#aaddff',
        lineCap: 'butt',
        font: '', textAlign: 'center', textBaseline: 'alphabetic',
        shadowColor: '', shadowBlur: 0,
        save() { stack.push({ m: { ...m }, lw: this.lineWidth, ss: this.strokeStyle, fs: this.fillStyle }); },
        restore() { const p = stack.pop(); if (p) { m = p.m; this.lineWidth = p.lw; this.strokeStyle = p.ss; this.fillStyle = p.fs; } },
        translate(tx, ty) { m = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.a * tx + m.c * ty + m.e, f: m.b * tx + m.d * ty + m.f }; },
        rotate(rad) {
            const c = Math.cos(rad), s = Math.sin(rad);
            m = { a: m.a * c + m.c * s, b: m.b * c + m.d * s, c: m.a * -s + m.c * c, d: m.b * -s + m.d * c, e: m.e, f: m.f };
        },
        _pt(x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; },
        beginPath() { paths = []; cur = null; },
        moveTo(x, y) { cur = [ctx._pt(x, y)]; paths.push(cur); },
        lineTo(x, y) { if (!cur) return ctx.moveTo(x, y); cur.push(ctx._pt(x, y)); },
        closePath() { if (cur && cur.length > 1) cur.push({ ...cur[0] }); },
        rect(x, y, w, h) {
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
            ctx.closePath();
        },
        strokeRect(x, y, w, h) { ctx.rect(x, y, w, h); ctx.stroke(); },
        arc(x, y, r, sa, ea) {
            const seg = 24, span = (ea - sa) || Math.PI * 2;
            for (let i = 0; i <= seg; i++) {
                const ang = sa + span * i / seg;
                const px = x + r * Math.cos(ang), py = y + r * Math.sin(ang);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
        },
        ellipse(x, y, rx, ry, rot, sa, ea) {
            const seg = 24, span = (ea - sa) || Math.PI * 2;
            for (let i = 0; i <= seg; i++) {
                const ang = sa + span * i / seg;
                const c = Math.cos(rot || 0), s = Math.sin(rot || 0);
                const ex = rx * Math.cos(ang), ey = ry * Math.sin(ang);
                const px = x + ex * c - ey * s, py = y + ex * s + ey * c;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
        },
        setLineDash() {},
        stroke() {
            const col = parseColor(ctx.strokeStyle);
            const w = Math.max(1, ctx.lineWidth * scale);
            for (const p of paths) if (p.length > 1) canvas.polyline(p, w, col.rgb);
        },
        fill() {
            const col = parseColor(ctx.fillStyle);
            for (const p of paths) if (p.length > 2) canvas.polygon(p, col.rgb, col.a);
        },
        fillText(text, x, y) {
            const col = parseColor(ctx.fillStyle);
            const p = ctx._pt(x, y);
            let px = 11 * scale;
            const fm = /([\d.]+)px/.exec(String(ctx.font || ''));
            if (fm) px = parseFloat(fm[1]) * scale;
            drawText(canvas, text, p.x, p.y - px, Math.max(6, px), col.rgb, ctx.textAlign);
        },
        strokeText() {}
    };
    return ctx;
}

// Draw one component's glyph with the browser's own symbol drawing code.
function drawSchemGlyph(cv, sv, comp, X, Y, scale) {
    const cx = comp.schemX || 0, cy = comp.schemY || 0;
    const ctx = makeCtx(cv, scale);
    ctx.save();
    ctx.translate(X(cx), Y(cy));
    ctx.rotate((sv.schemRotation(comp) || 0) * Math.PI / 180);
    ctx.strokeStyle = '#aaddff'; ctx.fillStyle = '#aaddff'; ctx.lineWidth = 2;
    const t = comp.type;
    try {
        if (sv._isKicadImported(comp)) sv.drawKicadSymbol(ctx, comp);
        else switch (t) {
            case 'resistor': sv.drawResistorSymbol(ctx); break;
            case 'capacitor': sv.drawCapSymbol(ctx, comp); break;
            case 'led': sv.drawDiodeSymbol(ctx, true); break;
            case 'diode': sv.drawDiodeSymbol(ctx, false); break;
            case 'ic': sv.drawICSymbol(ctx, comp); break;
            case 'connector': sv.drawConnSymbol(ctx, comp); break;
            case 'inductor': sv.drawInductorSymbol(ctx); break;
            case 'transistor': sv.drawTransistorSymbol(ctx, false); break;
            case 'pnp': sv.drawTransistorSymbol(ctx, true); break;
            case 'mosfet': sv.drawMosfetSymbol(ctx, sv._mosfetPChannel(comp)); break;
            case 'ldo': sv.drawLDOSymbol(ctx, comp); break;
            case 'switch': sv.drawSwitchSymbol(ctx); break;
            case 'fuse': sv.drawFuseSymbol(ctx); break;
            case 'crystal': sv.drawCrystalSymbol(ctx); break;
            case 'gnd': sv.drawGNDsymbol(ctx); break;
            case 'power': sv.drawPowerSymbol(ctx, comp); break;
            case 'nc': sv.drawNCSymbol(ctx); break;
            default: ctx.strokeRect(-20, -15, 40, 30);
        }
    } catch (e) { /* unknown type: box fallback */ }
    ctx.restore();
    // Pin dots on the leg endpoints (world anchors, unrotated draw).
    const pins = comp.pins || [];
    pins.forEach((p, i) => {
        const wp = sv.schemPinWorld(comp, i);
        cv.disc(X(wp.x), Y(wp.y), Math.max(1.5, 2.2 * scale / 2), [102, 255, 204]);
    });
    // Label beside the glyph (unrotated, above).
    const e = sv._schemGlyphHalfExtents(comp);
    const label = comp.label || comp.type || '';
    if (label) drawText(cv, label, X(cx), Y(cy) - (e.hh + 6) * scale, Math.max(7, 10 * scale / 2), [232, 244, 255], 'center');
}

/**
 * Schematic PNG using the browser layout: topology placement for unplaced
 * parts, real symbol glyphs, obstacle-aware orthogonal wires (traces with
 * schemEnds + stored-netlist legs). Framed on symbol bounds padded 40 units,
 * scaled so a resistor glyph's short side is >= 24 px; when that exceeds
 * maxSize the sheet splits into a contact sheet of column strips.
 * Returns an array of { png, x0, w } (schematic units) — one entry per image.
 */
export function renderSchematicPng(project, api, opts = {}) {
    const rootDir = opts.rootDir;
    const kernel = rootDir ? loadKernel(rootDir) : null;
    const sv = kernel && kernel.SchematicView;
    const sl = kernel && kernel.SchematicLayout;
    const maxPx = Math.min(1400, Math.max(200, opts.maxSize || 900));
    const comps = (project.components || []).map(c => ({ ...c }));
    if (!sv || !sl) return [renderSchematicPngLegacy(project, api, opts)];

    // Topology placement for anything without schematic coordinates.
    sl.placeMissing(comps, project.traces || [], project.netlist);
    const byId = new Map(comps.map(c => [c.id, c]));
    const boundsOf = (c) => sv.schemSymbolBounds(c);

    // Wires: same construction as the browser's schematic wire cache.
    const occupiedByNet = [];
    const wirePaths = [];
    const obstaclesAll = comps.map(boundsOf);
    // Pin pairs a real trace already draws — a netlist leg for the same pair is a
    // duplicate wire with no clean channel left, so it is skipped (matches the
    // browser's _rebuildSchemWireCache).
    const joinedPairs = new Set();
    const pairKey = (net, a, b) => {
        const k1 = a.comp.id + ':' + a.pinIndex, k2 = b.comp.id + ':' + b.pinIndex;
        return net + '|' + (k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1);
    };
    const routePair = (a, b, net) => {
        const aw = sv.schemPinWorld(a.comp, a.pinIndex), bw = sv.schemPinWorld(b.comp, b.pinIndex);
        const occupied = occupiedByNet.filter(s => !net || !s.net || s.net !== net).map(s => ({ p: s.p, q: s.q }));
        const pts = sl.route(aw, bw, obstaclesAll, occupied, { aBound: boundsOf(a.comp), bBound: boundsOf(b.comp), aLane: a.pinIndex, bLane: b.pinIndex });
        wirePaths.push({ net: net || '', pts });
        for (let i = 0; i < pts.length - 1; i++) occupiedByNet.push({ net: net || '', p: pts[i], q: pts[i + 1] });
    };
    for (const trace of project.traces || []) {
        const ends = trace.schemEnds;
        if (!Array.isArray(ends) || ends.length < 2) continue;
        const a = byId.get(ends[0].compId), b = byId.get(ends[1].compId);
        if (!a || !b) continue;
        routePair({ comp: a, pinIndex: ends[0].pinIndex }, { comp: b, pinIndex: ends[1].pinIndex }, trace.net);
        joinedPairs.add(pairKey(trace.net || '', { comp: a, pinIndex: ends[0].pinIndex }, { comp: b, pinIndex: ends[1].pinIndex }));
    }
    for (const netName of Object.keys(project.netlist || {})) {
        const refs = [];
        for (const r of project.netlist[netName] || []) {
            const comp = byId.get(r.compId);
            if (!comp) continue;
            const pinIndex = api.pinIndex(project, r.compId, r.pin);
            if (pinIndex !== null) refs.push({ comp, pinIndex });
        }
        for (let i = 0; i + 1 < refs.length; i++) {
            if (joinedPairs.has(pairKey(netName, refs[i], refs[i + 1]))) continue;
            routePair(refs[i], refs[i + 1], netName);
        }
    }

    // Frame: symbol bounds + wire points, padded 40 schematic units.
    let minX = -40, maxX = 40, minY = -40, maxY = 40;
    const grow = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
    comps.forEach(c => { const b = boundsOf(c); grow(b.minX, b.minY); grow(b.maxX, b.maxY); });
    wirePaths.forEach(w => w.pts.forEach(p => grow(p.x, p.y)));
    minX -= 40; minY -= 40; maxX += 40; maxY += 40;
    if (opts.crop && Number.isFinite(opts.crop.x)) {
        minX = opts.crop.x; minY = opts.crop.y;
        maxX = minX + (opts.crop.w || 200); maxY = minY + (opts.crop.h || 150);
    }

    // Scale: fit maxSize, but never below 2 px/unit (resistor short side 12u -> 24px).
    const spanX = Math.max(maxX - minX, 10), spanY = Math.max(maxY - minY, 10);
    let scale = Math.min(maxPx / spanX, maxPx / spanY);
    scale = Math.max(scale, 2);
    const maxUnits = maxPx / scale;

    // Column strips (contact sheet) when the sheet is wider than one image.
    const strips = [];
    if (spanX <= maxUnits && !opts.columns) {
        strips.push({ x0: minX, x1: maxX, y0: minY, y1: maxY });
    } else {
        const cols = [];
        let x0 = minX;
        while (x0 < maxX - 1) {
            const x1 = Math.min(x0 + maxUnits, maxX);
            cols.push({ x0, x1 });
            if (x1 >= maxX - 1) break;
            x0 = x1;
        }
        if (opts.columns) {
            // One strip per component column: group by x position.
            const xs = [...new Set(comps.map(c => Math.round((c.schemX || 0) / 10)))].sort((a, b) => a - b);
            strips.length = 0;
            for (const xg of xs) {
                const pad = maxUnits / 2;
                strips.push({ x0: Math.max(minX, xg - pad), x1: Math.min(maxX, xg + pad), y0: minY, y1: maxY });
            }
            if (!strips.length) strips.push({ x0: minX, x1: maxX, y0: minY, y1: maxY });
        } else {
            for (const c of cols) strips.push({ x0: c.x0, x1: c.x1, y0: minY, y1: maxY });
        }
    }

    const out = [];
    for (const st of strips) {
        const w = Math.round((st.x1 - st.x0) * scale) + 8, h = Math.round((st.y1 - st.y0) * scale) + 8;
        const cv = new Canvas(w, h, C.schemBg);
        const X = (x) => 4 + (x - st.x0) * scale;
        const Y = (y) => 4 + (y - st.y0) * scale;
        for (const wpath of wirePaths) {
            const col = netColor(project, wpath.net);
            cv.polyline(wpath.pts.map(p => ({ x: X(p.x), y: Y(p.y) })), Math.max(1.5, 2 * scale / 2), col);
        }
        for (const comp of comps) {
            const cx = comp.schemX || 0, cy = comp.schemY || 0;
            if (cx < st.x0 - 60 || cx > st.x1 + 60) continue;
            drawSchemGlyph(cv, sv, comp, X, Y, scale);
        }
        out.push({ png: cv.toPng(), x0: st.x0, x1: st.x1, w: st.x1 - st.x0, h: st.y1 - st.y0 });
    }
    return out;
}

// Legacy fallback (no kernel): board-sized boxes at schemX/schemY.
function renderSchematicPngLegacy(project, api, opts = {}) {
    const maxPx = Math.min(1400, Math.max(200, opts.maxSize || 900));
    const comps = project.components || [];
    let minX = -50, maxX = 50, minY = -30, maxY = 30;
    const posOf = (c) => ({ x: (c.schemX != null ? c.schemX : c.x), y: (c.schemY != null ? c.schemY : c.y) });
    for (const comp of comps) {
        const p = posOf(comp);
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const spanX = Math.max(maxX - minX, 10), spanY = Math.max(maxY - minY, 10);
    const scale = Math.min(maxPx / spanX, maxPx / spanY);
    const W = Math.round(spanX * scale) + 40, H = Math.round(spanY * scale) + 40;
    const X = (x) => 20 + (x - minX) * scale;
    const Y = (y) => 20 + (y - minY) * scale;
    const cv = new Canvas(W, H, C.schemBg);
    const byId = new Map(comps.map(c => [c.id, c]));
    for (const t of project.traces || []) {
        const ends = t.schemEnds;
        let pa = null, pb = null;
        if (Array.isArray(ends) && ends.length >= 2) {
            const a = byId.get(ends[0].compId), b = byId.get(ends[1].compId);
            if (a && b) { pa = posOf(a); pb = posOf(b); }
        } else if ((t.points || []).length >= 2) {
            pa = t.points[0]; pb = t.points[t.points.length - 1];
        }
        if (!pa || !pb) continue;
        cv.line(X(pa.x), Y(pa.y), X(pb.x), Y(pb.y), 2, netColor(project, t.net));
    }
    for (const comp of comps) {
        const p = posOf(comp);
        const size = api.getCompSize(comp);
        const box = compBox(size);
        const hw = Math.max(box.w, 8) / 2, hh = Math.max(box.h, 6) / 2;
        cv.polygon([
            { x: X(p.x - hw), y: Y(p.y - hh) }, { x: X(p.x + hw), y: Y(p.y - hh) },
            { x: X(p.x + hw), y: Y(p.y + hh) }, { x: X(p.x - hw), y: Y(p.y + hh) }
        ], C.schemBody, 0.9);
    }
    return { png: cv.toPng(), x0: minX, x1: minX + spanX, w: spanX, h: spanY };
}
