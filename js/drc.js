// ============================================================
// Design Rule Check (DRC) - Manufacturing Constraint Validation
// Min trace width: 0.38mm | Min drill: 0.1mm | Min clearance: 0.38mm
// ============================================================

Object.assign(App, {
    runDRC() {
        const violations = computeDrcViolations(this);
        this.renderDrcPanel(violations);
        this.setStatus(violations.length === 0 ? 'DRC: PASS' : `DRC: ${violations.filter(v=>v.severity==='error').length} errors`);
        return violations;
    },

    // Render DRC results into the right-hand panel. DOM-safe: no-op when
    // the element does not exist (e.g. headless / agent preview feed).
    renderDrcPanel(violations) {
        if (typeof document === 'undefined') return;
        const panel = document.getElementById('drc-results');
        if (!panel) return;
        if (violations.length === 0) {
            panel.innerHTML = '<div class="drc-pass">✓ DRC Pass — No violations</div>';
        } else {
            const errors = violations.filter(v => v.severity === 'error').length;
            const warnings = violations.filter(v => v.severity === 'warning').length;
            let html = `<div class="drc-summary">${errors} error(s), ${warnings} warning(s)</div>`;
            violations.slice(0, 30).forEach(v => {
                html += `<div class="drc-item ${v.severity}">${v.msg}</div>`;
            });
            if (violations.length > 30) html += `<div class="drc-item">... and ${violations.length - 30} more</div>`;
            panel.innerHTML = html;
        }
    },

    traceConnectsToComp(trace, comp) {
        const size = this.getCompSize(comp);
        if (!size) return false;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const threshold = 0.5;
        for (const pin of ((comp.pins && comp.pins.length) ? comp.pins : size.pins)) {
            const px = comp.x + pin.x * cos - pin.y * sin;
            const py = comp.y + pin.x * sin + pin.y * cos;
            for (let i = 0; i < trace.points.length; i++) {
                if (Math.abs(trace.points[i].x - px) < threshold && Math.abs(trace.points[i].y - py) < threshold) return true;
            }
        }
        return false;
    }
});

// ============================================================
// Pure, DOM-free DRC checks. Operates on any plain project-like
// object ({ traces, vias, params }). Used by App.runDRC in the
// browser and by the headless kernel (MCP server / tests).
// ============================================================

function computeDrcViolations(project) {
    const violations = [];
    const params = project.params || {};
    const minTraceW = params.minTraceWidth || 0.38;
    const minDrill = params.minDrill || 0.1;
    const minClearance = params.minClearance || 0.38;

    // 1. Check trace widths
    for (const trace of project.traces || []) {
        if (trace.schemWire) continue; // logical wire — no copper width to check
        if (trace.width < minTraceW) {
            violations.push({ type: 'trace-width', severity: 'error', msg: `Trace ${trace.id}: width ${trace.width.toFixed(2)}mm < min ${minTraceW}mm` });
        }
        if (trace.segmentWidths) {
            trace.segmentWidths.forEach((w, i) => {
                if (w < minTraceW) violations.push({ type: 'trace-width', severity: 'error', msg: `Trace ${trace.id} seg ${i+1}: width ${w.toFixed(2)}mm < min ${minTraceW}mm` });
            });
        }
    }

    // 2. Check via/drill sizes
    for (const via of project.vias || []) {
        const drill = via.drill || (via.diameter * 0.5);
        if (drill < minDrill) {
            violations.push({ type: 'drill-size', severity: 'error', msg: `Via at (${via.x.toFixed(1)},${via.y.toFixed(1)}): drill ${drill.toFixed(2)}mm < min ${minDrill}mm` });
        }
    }

    // 2b. Check component TH pad drills (solder holes, wire-jumper pads) against the same minimum.
    if (typeof ComponentDefs !== 'undefined' && typeof Export !== 'undefined') {
        const drcHost = {
            getCompSize(c) {
                const def = ComponentDefs.get(c.type);
                return def ? ComponentDefs.getSize(def, c.size !== undefined ? c.size : def.defaultSize) : null;
            }
        };
        for (const comp of project.components || []) {
            let pads = [];
            try { pads = Export.padFeatures(drcHost, comp) || []; } catch (e) { pads = []; }
            for (const pad of pads) {
                if (!pad.thru) continue; // SMD pads have no drill
                const drill = pad.drill || 0;
                if (drill >= minDrill) continue;
                violations.push({ type: 'drill-size', severity: 'error', msg: `Pad on ${comp.label || comp.type} at (${pad.x.toFixed(1)},${pad.y.toFixed(1)}): drill ${drill.toFixed(2)}mm < min ${minDrill}mm` });
            }
        }
    }

    // 3. Check clearance between traces on same layer (different nets)
    const traces = project.traces || [];
    for (let a = 0; a < traces.length; a++) {
        for (let b = a + 1; b < traces.length; b++) {
            const tA = traces[a], tB = traces[b];
            if (tA.layer !== tB.layer) continue;
            if (tA.net === tB.net) continue; // same net = connected, skip
            if (tA.schemWire || tB.schemWire) continue; // logical wires are not copper

            const ptsA = tA.points, ptsB = tB.points;
            for (let i = 0; i < ptsA.length - 1; i++) {
                const wA = (tA.segmentWidths && tA.segmentWidths[i]) || tA.width;
                for (let j = 0; j < ptsB.length - 1; j++) {
                    const wB = (tB.segmentWidths && tB.segmentWidths[j]) || tB.width;
                    const minDist = segSegDistance(ptsA[i], ptsA[i+1], ptsB[j], ptsB[j+1]);
                    const gap = minDist - wA/2 - wB/2;
                    if (gap < minClearance) {
                        violations.push({ type: 'clearance', severity: 'error', msg: `Clr ${gap.toFixed(2)}mm < ${minClearance}: T${tA.id} seg${i+1} ↔ T${tB.id} seg${j+1}` });
                    }
                }
            }
        }
    }

    // 4. Floating pins: every pin needs a trace or an NC (X) pad on it.
    // MCU modules skip — too many unused GPIOs for a maker board.
    const pinTol = 0.55;
    const ncPads = (project.components || []).filter(c => c.type === 'nc');
    for (const comp of project.components || []) {
        if (comp.type === 'nc') continue;
        if (typeof ComponentDefs !== 'undefined' && ComponentDefs.isModule && ComponentDefs.isModule(comp.type)) continue;
        const pins = comp.pins || [];
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        for (const pin of pins) {
            const px = comp.x + pin.x * cos - pin.y * sin;
            const py = comp.y + pin.x * sin + pin.y * cos;
            let hit = false;
            for (const tr of traces) {
                for (const q of tr.points || []) {
                    if (Math.abs(q.x - px) < pinTol && Math.abs(q.y - py) < pinTol) { hit = true; break; }
                }
                if (hit) break;
            }
            if (!hit) {
                for (const nc of ncPads) {
                    if (Math.hypot(nc.x - px, nc.y - py) < 0.8) { hit = true; break; }
                }
            }
            if (!hit) {
                const who = (comp.label || comp.type) + '.' + (pin.name || '?');
                violations.push({ type: 'floating-pin', severity: 'error', msg: `Floating pin ${who} — add a trace or an NC pad (X)` });
            }
        }
    }

    // 5. Logical schematic wires with no copper path between the same ends.
    const seenUnrouted = new Set();
    for (const tr of traces) {
        if (!tr.schemWire || !tr.points || tr.points.length < 2) continue;
        const pa = tr.points[0], pb = tr.points[tr.points.length - 1];
        if (drcCopperConnects(project, pa, pb, tr.net)) continue;
        const aName = drcEndName(project, tr, 0, pa);
        const bName = drcEndName(project, tr, 1, pb);
        const key = (tr.net || '') + '\0' + [aName, bName].sort().join('\0');
        if (seenUnrouted.has(key)) continue;
        seenUnrouted.add(key);
        const net = tr.net || 'net';
        violations.push({
            type: 'unrouted',
            severity: 'warning',
            msg: `Unrouted ${net}: ${aName} — ${bName} (schematic only, no copper)`
        });
    }

    // 6. Duplicate identity (CAP-8): component ids must be unique, and
    // reference labels (e.g. two "U1") must not repeat. Catches copy/paste
    // and import collisions that silently break netlist references.
    {
        const comps = project.components || [];
        const seenId = new Map();
        for (const c of comps) {
            if (seenId.has(c.id)) {
                violations.push({ type: 'duplicate-id', severity: 'error', msg: `Duplicate component id ${c.id} (${seenId.get(c.id)} and ${c.label || c.type})` });
            } else {
                seenId.set(c.id, c.label || c.type);
            }
        }
        const seenLabel = new Map();
        for (const c of comps) {
            const label = (c.label || '').trim();
            if (!label) continue;
            if (seenLabel.has(label)) {
                violations.push({ type: 'duplicate-label', severity: 'error', msg: `Duplicate reference label ${label} (ids ${seenLabel.get(label)} and ${c.id})` });
            } else {
                seenLabel.set(label, c.id);
            }
        }
    }

    // 7. Single-layer shorts: two nets whose centerlines cross. Same check as quality.
    if (typeof Plan !== 'undefined' && Plan.crossNetCrossings) {
        for (const msg of Plan.crossNetCrossings(project)) {
            violations.push({ type: 'crossing', severity: 'error', msg });
        }
    }

    return violations;
}

function drcEndName(project, trace, which, pt) {
    const ref = Array.isArray(trace.schemEnds) ? trace.schemEnds[which] : null;
    if (ref && typeof ref.compId === 'number') {
        const comp = (project.components || []).find(c => c.id === ref.compId);
        if (comp) {
            const pin = (comp.pins || [])[ref.pinIndex];
            return (comp.label || comp.type) + '.' + ((pin && pin.name) || (ref.pinIndex + 1));
        }
    }
    const hit = drcPinAt(project, pt, 1.5);
    if (hit) return hit;
    return '(' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1) + ')';
}

function drcPinAt(project, pt, tol) {
    for (const comp of project.components || []) {
        const pins = comp.pins || [];
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        for (let i = 0; i < pins.length; i++) {
            const px = comp.x + pins[i].x * cos - pins[i].y * sin;
            const py = comp.y + pins[i].x * sin + pins[i].y * cos;
            if (Math.hypot(px - pt.x, py - pt.y) < tol) {
                return (comp.label || comp.type) + '.' + (pins[i].name || (i + 1));
            }
        }
    }
    return null;
}

function drcTraceTouches(trace, pt, tol) {
    const pts = trace.points || [];
    const hit = Math.max(tol, ((trace.width || 0.5) / 2) + 0.2);
    for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - pt.x, pts[i].y - pt.y) < hit) return true;
    }
    for (let i = 0; i < pts.length - 1; i++) {
        if (pointSegDistance(pt, pts[i], pts[i + 1]) < hit) return true;
    }
    return false;
}

// A pin belongs to `net` when some trace on that net has an endpoint on it
// (same rule as ProjectApi.getPinNet, which counts logical schematic wires too).
function drcPinOnNet(project, x, y, net) {
    for (const tr of project.traces || []) {
        if (tr.net !== net) continue;
        const pts = tr.points || [];
        const first = pts[0], last = pts[pts.length - 1];
        if ((first && Math.hypot(first.x - x, first.y - y) < 0.15) ||
            (last && Math.hypot(last.x - x, last.y - y) < 0.15)) return true;
    }
    return false;
}

// Component-bridge rule (mirrors js/autorouter.js): when a net spans more than
// one component, the pins of a single instance on that net are joined by the
// package itself, so copper reaching one of them electrically reaches all.
// Without this, DRC reports a net the autorouter legitimately left uncoppered.
function drcBridgeSet(project, net, pt, tol) {
    const out = [pt];
    if (!net) return out;
    const groups = [];
    let compsOnNet = 0;
    for (const comp of project.components || []) {
        const pins = comp.pins || [];
        if (!pins.length) continue;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const near = [];
        for (let i = 0; i < pins.length; i++) {
            const px = comp.x + pins[i].x * cos - pins[i].y * sin;
            const py = comp.y + pins[i].x * sin + pins[i].y * cos;
            if (drcPinOnNet(project, px, py, net)) near.push({ x: px, y: py });
        }
        if (!near.length) continue;
        compsOnNet++;
        if (near.length > 1) groups.push(near);
    }
    if (compsOnNet < 2) return out;
    for (const g of groups) {
        let hit = false;
        for (const q of g) if (Math.hypot(q.x - pt.x, q.y - pt.y) < tol) { hit = true; break; }
        if (hit) for (const q of g) out.push(q);
    }
    return out;
}

function drcCopperConnects(project, pa, pb, net) {
    const tol = 1.5;
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < tol) return true;
    const starts = drcBridgeSet(project, net, pa, tol);
    const ends = drcBridgeSet(project, net, pb, tol);
    const touchesStart = (tr) => { for (const s of starts) if (drcTraceTouches(tr, s, tol)) return true; return false; };
    const touchesEnd = (tr) => { for (const e of ends) if (drcTraceTouches(tr, e, tol)) return true; return false; };
    const nearEnd = (p) => { for (const e of ends) if (Math.hypot(e.x - p.x, e.y - p.y) < tol) return true; return false; };
    const copper = (project.traces || []).filter(t => !t.schemWire && t.points && t.points.length >= 2 && (!net || !t.net || t.net === net));
    const vias = project.vias || [];
    const seen = new Set();
    const q = [];
    for (let i = 0; i < copper.length; i++) {
        if (touchesStart(copper[i])) { seen.add(i); q.push(i); }
    }
    while (q.length) {
        const i = q.pop();
        const tr = copper[i];
        if (touchesEnd(tr)) return true;
        for (let j = 0; j < copper.length; j++) {
            if (seen.has(j)) continue;
            let join = false;
            for (let k = 0; k < tr.points.length; k++) {
                if (drcTraceTouches(copper[j], tr.points[k], tol)) { join = true; break; }
            }
            if (!join) {
                for (let k = 0; k < copper[j].points.length; k++) {
                    if (drcTraceTouches(tr, copper[j].points[k], tol)) { join = true; break; }
                }
            }
            if (join) { seen.add(j); q.push(j); }
        }
        for (let v = 0; v < vias.length; v++) {
            const vp = { x: vias[v].x, y: vias[v].y };
            if (!drcTraceTouches(tr, vp, tol)) continue;
            if (nearEnd(vp)) return true;
            for (let j = 0; j < copper.length; j++) {
                if (seen.has(j)) continue;
                if (drcTraceTouches(copper[j], vp, tol)) { seen.add(j); q.push(j); }
            }
        }
    }
    return false;
}

// ============================================================
// Geometry helpers for DRC
// ============================================================

function segSegDistance(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const rx = p1.x - p3.x, ry = p1.y - p3.y;
    const a = d1x*d1x + d1y*d1y;
    const e = d2x*d2x + d2y*d2y;
    const f = d2x*rx + d2y*ry;
    if (a < 1e-10 && e < 1e-10) return Math.sqrt(rx*rx + ry*ry);
    if (a < 1e-10) {
        let t = f / e; t = Math.max(0, Math.min(1, t));
        const qx = p3.x + d2x*t - p1.x, qy = p3.y + d2y*t - p1.y;
        return Math.sqrt(qx*qx + qy*qy);
    }
    const c = d1x*rx + d1y*ry;
    if (e < 1e-10) {
        let t = -c / a; t = Math.max(0, Math.min(1, t));
        const qx = p1.x + d1x*t - p3.x, qy = p1.y + d1y*t - p3.y;
        return Math.sqrt(qx*qx + qy*qy);
    }
    const b = d1x*d2x + d1y*d2y;
    const denom = a*e - b*b;
    let s, t;
    if (denom < 1e-10) { s = 0; t = f / e; t = Math.max(0, Math.min(1, t)); }
    else { s = (b*f - c*e) / denom; s = Math.max(0, Math.min(1, s)); t = (b*s + f) / e; t = Math.max(0, Math.min(1, t)); }
    const qx = p1.x + d1x*s - (p3.x + d2x*t);
    const qy = p1.y + d1y*s - (p3.y + d2y*t);
    return Math.sqrt(qx*qx + qy*qy);
}

function pointSegDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy;
    if (len2 < 1e-10) return Math.sqrt((p.x-a.x)**2 + (p.y-a.y)**2);
    let t = ((p.x-a.x)*dx + (p.y-a.y)*dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx*t - p.x, py = a.y + dy*t - p.y;
    return Math.sqrt(px*px + py*py);
}

