// ============================================================
// Properties Panel, Context Menu & Object Actions
// ============================================================

Object.assign(App, {
    showProperties(obj, segIndex) {
        const el = document.getElementById('properties-content');
        let html = '';
        const sel = this.interaction.selectedObject;
        if (sel && sel.type === 'compSilk' && obj.id === sel.compId) {
            // Silk label/value selected: edit this field's text, local offset, rotation and font size.
            this.ensureCompSilkLayout(obj);
            const isValue = sel.field === 'value';
            const pos = isValue ? obj.silkValue : obj.silkLabel;
            const text = (isValue ? obj.value : obj.label) || '';
            const rot = typeof pos.rotation === 'number' ? pos.rotation : 0;
            const fsize = typeof pos.fontSize === 'number' ? pos.fontSize : '';
            html += `<div class="prop-item"><label>Type</label><span>Silk ${isValue ? 'value' : 'label'} — ${obj.type}</span></div>`;
            html += `<div class="prop-item"><label>Text</label><input type="text" value="${text}" onchange="App.${isValue ? 'updateCompValue' : 'updateCompLabel'}(${obj.id}, this.value)"></div>`;
            html += `<div class="prop-item"><label>X (local mm)</label><input type="number" step="0.1" value="${pos.x}" onchange="App.setCompSilkPos(${obj.id}, '${sel.field}', parseFloat(this.value), null)"></div>`;
            html += `<div class="prop-item"><label>Y (local mm)</label><input type="number" step="0.1" value="${pos.y}" onchange="App.setCompSilkPos(${obj.id}, '${sel.field}', null, parseFloat(this.value))"></div>`;
            html += `<div class="prop-item"><label>Rotation (°)</label><input type="number" step="15" value="${rot}" onchange="App.setCompSilkRot(${obj.id}, '${sel.field}', parseFloat(this.value))"></div>`;
            html += `<div class="prop-item"><label>Font size (mm)</label><input type="number" step="0.1" min="0.3" placeholder="auto" value="${fsize}" onchange="App.setCompSilkFont(${obj.id}, '${sel.field}', this.value === '' ? null : parseFloat(this.value))"></div>`;
            html += `<div class="prop-item"><label>Tip</label><span style="font-size:11px;color:#888">Drag the text on the board to move it. Rotation is an offset relative to the part; empty font size uses auto.</span></div>`;
        } else if (obj.type && ComponentDefs.get(obj.type)) {
            const def = ComponentDefs.get(obj.type);
            const sizeIdx = obj.size !== undefined ? obj.size : def.defaultSize;
            const isJumper = obj.type === 'jumper';
            const jkind = (isJumper && def.sizes[sizeIdx]) ? def.sizes[sizeIdx].jkind : null;
            html += `<div class="prop-item"><label>Type</label><span>${obj.type}${isJumper ? (jkind === 'wire' ? ' — wire jumper (unplated solder holes)' : ' — 0Ω SMD') : ''}</span></div>`;
            if (def.sizes) {
                const opts = def.sizes.filter((s, i) => !isJumper || s.jkind === jkind).map((s, i) => `<option value="${i}" ${i === sizeIdx ? 'selected' : ''}>${s.name} (${s.width}×${s.height}mm)</option>`).join('');
                html += `<div class="prop-item"><label>Size</label><select onchange="App.updateCompSize(${obj.id}, parseInt(this.value))">${opts}</select></div>`;
            }
            if (isJumper && jkind === 'wire') {
                const spanVal = obj.span !== undefined ? Number(obj.span).toFixed(2) : '10.00';
                html += `<div class="prop-item"><label>Span (mm)</label><input type="number" step="${this.params.gridSize || 1}" min="2" value="${spanVal}" onchange="App.updateJumperSpan(${obj.id}, parseFloat(this.value))"></div>`;
            }
            html += `<div class="prop-item"><label>Label</label><input type="text" value="${obj.label}" onchange="App.updateCompLabel(${obj.id}, this.value)"></div>`;
            html += `<div class="prop-item"><label>Value</label><input type="text" value="${obj.value}" onchange="App.updateCompValue(${obj.id}, this.value)"></div>`;
            html += `<div class="prop-item"><label>Silk</label><span style="font-size:11px;color:#888">Designator and value render on the Silk layer. Drag them on the board to reposition.</span></div>`;
            html += `<div class="prop-item"><label>X (mm)</label><input type="number" step="0.1" value="${obj.x}" onchange="App.moveObj(${obj.id}, parseFloat(this.value), null)"></div>`;
            html += `<div class="prop-item"><label>Y (mm)</label><input type="number" step="0.1" value="${obj.y}" onchange="App.moveObj(${obj.id}, null, parseFloat(this.value))"></div>`;
            html += `<div class="prop-item"><label>Rotation</label><select onchange="App.rotateObj(${obj.id}, parseInt(this.value))"><option ${obj.rotation===0?'selected':''}>0</option><option ${obj.rotation===90?'selected':''}>90</option><option ${obj.rotation===180?'selected':''}>180</option><option ${obj.rotation===270?'selected':''}>270</option></select></div>`;
            html += `<div class="prop-item"><label>3D</label><button type="button" style="width:100%" onclick="Model3D.openFor(${obj.id})">3D preview</button></div>`;
        } else if (obj.width !== undefined && obj.points) {
            html += `<div class="prop-item"><label>Type</label><span>Trace (${obj.points.length} pts)</span></div>`;
            if (segIndex !== undefined) {
                html += `<div class="prop-item" style="background:rgba(0,150,255,0.1);border-radius:3px;padding:4px 6px"><label>Selected</label><span style="color:#4fc3f7">Segment ${segIndex + 1}</span></div>`;
            }
            html += `<div class="prop-item"><label>Default Width (mm)</label><input type="number" step="0.1" value="${obj.width}" onchange="App.traces.find(t=>t.id===${obj.id}).width=parseFloat(this.value);if(!App.traces.find(t=>t.id===${obj.id}).segmentWidths)App.traces.find(t=>t.id===${obj.id}).segmentWidths=new Array(App.traces.find(t=>t.id===${obj.id}).points.length-1).fill(parseFloat(this.value));App.render()"></div>`;
            html += `<div class="prop-item"><label>Layer</label><select onchange="App.traces.find(t=>t.id===${obj.id}).layer=this.value;App.render()"><option ${obj.layer==='top'?'selected':''}>top</option><option ${obj.layer==='bottom'?'selected':''}>bottom</option></select></div>`;
            html += `<div class="prop-item"><label>Net</label><select onchange="App.traces.find(t=>t.id===${obj.id}).net=this.value;App.render()">${App.nets.map(n => `<option ${obj.net===n.name?'selected':''}>${n.name}</option>`).join('')}</select></div>`;
            const segCount = obj.points.length - 1;
            if (segCount > 0) {
                html += `<div class="prop-item"><label>Segment Widths</label><div style="max-height:200px;overflow-y:auto">`;
                for (let si = 0; si < segCount; si++) {
                    const sw = App.getSegmentWidth(obj, si);
                    const startC = App.getPadConstraint(obj, si);
                    const endC = App.getPadConstraint(obj, si + 1);
                    let constraintInfo = '';
                    if (startC) constraintInfo += `<span class="pad-constraint" title="Start: ${startC.label}">⬤${startC.minW}–${startC.maxW}</span>`;
                    if (endC) constraintInfo += `<span class="pad-constraint" title="End: ${endC.label}">⬤${endC.minW}–${endC.maxW}</span>`;
                    const isCurved = obj.curved ? obj.curved[si] : false;
                    const isSelected = (segIndex !== undefined && si === segIndex);
                    const rowStyle = isSelected ? 'background:rgba(0,150,255,0.15);border-radius:3px;padding:2px 4px' : '';
                    html += `<div style="display:flex;align-items:center;gap:4px;margin:3px 0;${rowStyle}">`;
                    html += `<span style="font-size:11px;width:38px">${isSelected ? '▶ ' : ''}Seg ${si+1}</span>`;
                    html += `<input type="number" step="0.1" min="0.1" max="10" value="${sw}" onchange="App.setSegmentWidth(${obj.id},${si},parseFloat(this.value))" style="width:52px;font-size:11px;padding:1px 3px">`;
                    html += `<span style="font-size:10px;color:#888">mm</span>`;
                    if (constraintInfo) html += constraintInfo;
                    html += `<button onclick="App.toggleSegmentCurve(${obj.id},${si})" style="font-size:10px;padding:0 4px;cursor:pointer;margin-left:auto" class="${isCurved?'btn-active':''}">${isCurved ? '↗' : '—'}</button>`;
                    html += `</div>`;
                }
                html += `</div></div>`;
            }
            html += `<div class="prop-item"><label>Hint</label><span style="font-size:11px;color:#888">⬤ = pad constraint. Click segment to select. Double-click to add node. Drag vertices to reshape.</span></div>`;
        } else if (obj.diameter !== undefined) {
            html += `<div class="prop-item"><label>Type</label><span>Solder hole (unplated)</span></div>`;
            html += `<div class="prop-item"><label>Diameter (mm)</label><input type="number" step="0.1" value="${obj.diameter}" onchange="App.vias.find(v=>v.id===${obj.id}).diameter=parseFloat(this.value);App.render()"></div>`;
            html += `<div class="prop-item"><label>Hint</label><span style="font-size:11px;color:#888">Unplated hole — drilled, no copper ring. Solder wires/jumpers by hand.</span></div>`;
            html += `<div class="prop-item"><label>X</label><span>${obj.x.toFixed(2)}</span></div>`;
            html += `<div class="prop-item"><label>Y</label><span>${obj.y.toFixed(2)}</span></div>`;
        } else {
            html = '<p class="hint">No properties available.</p>';
        }
        el.innerHTML = html;
    },

    updateCompLabel(id, value) { const c = this.components.find(c => c.id === id); if (c) { c.label = value; this.saveState(); this.render(); } },
    updateCompValue(id, value) { const c = this.components.find(c => c.id === id); if (c) { c.value = value; this.saveState(); this.render(); } },
    // Silk label/value editing: per-field local offset, rotation offset and font size.
    setCompSilkPos(id, field, x, y) {
        const c = this.components.find(c => c.id === id);
        if (!c) return;
        this.ensureCompSilkLayout(c);
        const pos = field === 'value' ? c.silkValue : c.silkLabel;
        if (x !== null && isFinite(x)) pos.x = x;
        if (y !== null && isFinite(y)) pos.y = y;
        this.saveState(); this.render();
    },
    setCompSilkRot(id, field, rot) {
        const c = this.components.find(c => c.id === id);
        if (!c) return;
        this.ensureCompSilkLayout(c);
        const pos = field === 'value' ? c.silkValue : c.silkLabel;
        // 0 is the default (part-aligned) — keep files lean by not persisting it.
        if (rot !== null && isFinite(rot) && rot !== 0) pos.rotation = rot; else delete pos.rotation;
        this.saveState(); this.render();
    },
    setCompSilkFont(id, field, size) {
        const c = this.components.find(c => c.id === id);
        if (!c) return;
        this.ensureCompSilkLayout(c);
        const pos = field === 'value' ? c.silkValue : c.silkLabel;
        // Empty/invalid means auto sizing — don't persist an override in that case.
        if (size !== null && isFinite(size) && size > 0) pos.fontSize = size; else delete pos.fontSize;
        this.saveState(); this.render();
    },
    updateCompSize(id, sizeIdx) {
        const c = this.components.find(c => c.id === id);
        if (!c) return;
        const def = ComponentDefs.get(c.type);
        if (!def || !def.sizes) return;
        const oldSize = ComponentDefs.getSize(def, c.size !== undefined ? c.size : def.defaultSize);
        const oldPinWorlds = [];
        if (oldSize) {
            const rad = (c.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            for (const pin of oldSize.pins) {
                oldPinWorlds.push({ x: c.x + pin.x * cos - pin.y * sin, y: c.y + pin.x * sin + pin.y * cos });
            }
        }
        c.size = sizeIdx;
        const size = ComponentDefs.getSize(def, sizeIdx);
        if (!size || !size.pins) return;
        c.pins = size.pins.map(p => ({ ...p }));
        if (size.value) c.value = String(size.value);
        const rad = (c.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const newPinWorlds = size.pins.map(pin => ({ x: c.x + pin.x * cos - pin.y * sin, y: c.y + pin.x * sin + pin.y * cos }));
        const tol = 1.5;
        for (const trace of this.traces) {
            for (const pt of trace.points) {
                for (let oi = 0; oi < oldPinWorlds.length; oi++) {
                    const op = oldPinWorlds[oi];
                    if (Math.abs(pt.x - op.x) < tol && Math.abs(pt.y - op.y) < tol) {
                        if (oi < newPinWorlds.length) { pt.x = newPinWorlds[oi].x; pt.y = newPinWorlds[oi].y; }
                        break;
                    }
                }
            }
        }
        this.saveState(); this.render();
    },
    updateJumperSpan(id, span) {
        const c = this.components.find(c => c.id === id);
        if (!c || c.type !== 'jumper') return;
        const def = ComponentDefs.get('jumper');
        const size = def && c.size !== undefined ? ComponentDefs.getSize(def, c.size) : null;
        if (!size || size.jkind !== 'wire') return;
        // App itself is the project object (duck-typed: has .components / .traces).
        ProjectApi.applyJumperSpan(this, id, span);
        this.saveState(); this.render();
    },
    moveObj(id, x, y) { const c = this.components.find(c => c.id === id); if (c) { const oldX = c.x, oldY = c.y; if (x !== null) c.x = x; if (y !== null) c.y = y; this.moveCompWithTraces(c, oldX, oldY); this.saveState(); this.render(); } },
    rotateObj(id, rot) { const c = this.components.find(c => c.id === id); if (c) { this.rotateCompWithTraces(c, rot); this.saveState(); this.render(); } },

    // ---- LED series-resistor calculator ----
    // LED forward voltage (V) — pure math delegated to the DOM-free LedCalc
    // module (also exercised by tests/led-calc.test.js). Returns null for
    // parts that don't take a series resistor (e.g. WS2812B).
    ledVf(value) { return LedCalc.ledVf(value); },

    // Nearest E24 standard resistor value (ohms) to r — delegated to LedCalc.
    nearestE24(r) { return LedCalc.nearestE24(r); },

    // Compact resistance label: 150 -> "150Ω", 1500 -> "1.5kΩ", 4700000 -> "4.7MΩ".
    fmtRes(r) {
        if (!isFinite(r)) return '—';
        if (r >= 1e6) { const v = r / 1e6; return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'MΩ'; }
        if (r >= 1e3) { const v = r / 1e3; return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'kΩ'; }
        return Math.round(r) + 'Ω';
    },

    // Parse a voltage string into volts: "5V" -> 5, "3.3V" -> 3.3, "3V3" -> 3.3,
    // "5" -> 5. Returns null when it can't be read.
    parseVolt(str) {
        if (str === null || str === undefined) return null;
        let s = String(str).trim().toUpperCase();
        if (!s) return null;
        let m = s.match(/^(\d+)V(\d+)$/);            // "3V3" -> 3.3
        if (m) return parseFloat(m[1] + '.' + m[2]);
        m = s.match(/^(\d*\.?\d+)\s*V?$/);           // "5V", "3.3V", "5", "3.3"
        if (m) { const v = parseFloat(m[1]); return isFinite(v) ? v : null; }
        return null;
    },

    // Parse a resistance label into ohms: "150Ω" -> 150, "1.5kΩ" -> 1500, "4.7MΩ" -> 4.7e6.
    parseRes(str) {
        if (str === null || str === undefined) return null;
        let s = String(str).trim().toUpperCase().replace(/Ω|OHM/g, '');
        if (!s) return null;
        let m = s.match(/^(\d*\.?\d+)\s*([KM]?)$/);
        if (!m) return null;
        let v = parseFloat(m[1]);
        if (!isFinite(v)) return null;
        if (m[2] === 'K') v *= 1e3;
        else if (m[2] === 'M') v *= 1e6;
        return v;
    },

    // True when a power symbol represents the VCC supply (label, value, or pin name).
    _isVccSymbol(c) {
        if (String(c.label || '').toUpperCase() === 'VCC') return true;
        if (String(c.value || '').toUpperCase() === 'VCC') return true;
        const p = c.pins && c.pins[0];
        if (p && String(p.name || '').toUpperCase() === 'VCC') return true;
        return false;
    },

    // Find the VCC power symbol that feeds the LED and the LED pin on the VCC side.
    // Returns { vccComp, vccNet, pinIndex, existingResistor, ledFacingPin } or null.
    // pinIndex is the LED pin (0=anode, 1=cathode) that reaches VCC — directly, or
    // through a series resistor (existingResistor, whose ledFacingPin faces the LED).
    findLedVcc(led) {
        const powers = this.components.filter(c => c.type === 'power' && this._isVccSymbol(c));
        if (!powers.length) return null;
        const anodeNet = ProjectApi.getPinNet(this, led.id, 'A');
        const cathodeNet = ProjectApi.getPinNet(this, led.id, 'K');
        let best = null, bestD = Infinity;
        for (const p of powers) {
            const vccNet = ProjectApi.getPinNet(this, p.id, 0) || (p.pins && p.pins[0] && p.pins[0].name) || 'VCC';
            let pinIndex = null, existing = null, facing = -1;
            if (anodeNet && anodeNet === vccNet) pinIndex = 0;
            else if (cathodeNet && cathodeNet === vccNet) pinIndex = 1;
            else {
                const r = this._resistorBridging(led, vccNet, anodeNet, cathodeNet);
                if (r) { pinIndex = r.ledPinIndex; existing = r.resistor; facing = r.ledFacingPin; }
            }
            if (pinIndex === null) continue; // this VCC isn't connected to the LED
            const pw = SchematicView.schemPinWorld(p, 0);
            const lw = SchematicView.schemPinWorld(led, pinIndex);
            if (!pw || !lw) continue;
            const d = Math.hypot(pw.x - lw.x, pw.y - lw.y);
            if (d < bestD) { bestD = d; best = { vccComp: p, vccNet, pinIndex, existingResistor: existing, ledFacingPin: facing }; }
        }
        if (best) return best;
        // No VCC reaches the LED yet: default to the nearest VCC symbol on the anode side.
        let nb = null, nd = Infinity;
        const la = SchematicView.schemPinWorld(led, 0);
        for (const p of powers) {
            const pw = SchematicView.schemPinWorld(p, 0);
            if (!pw || !la) continue;
            const d = Math.hypot(pw.x - la.x, pw.y - la.y);
            if (d < nd) { nd = d; nb = { vccComp: p, vccNet: ProjectApi.getPinNet(this, p.id, 0) || 'VCC', pinIndex: 0, existingResistor: null, ledFacingPin: -1 }; }
        }
        return nb;
    },

    // Find a resistor bridging vccNet and one of the LED pin nets (anode or cathode).
    // Returns { resistor, ledPinIndex, ledFacingPin } for the closest one, or null.
    _resistorBridging(led, vccNet, anodeNet, cathodeNet) {
        if (!vccNet) return null;
        const lw0 = SchematicView.schemPinWorld(led, 0);
        const lw1 = SchematicView.schemPinWorld(led, 1);
        let best = null, bestD = Infinity;
        for (const c of this.components) {
            if (c.type !== 'resistor') continue;
            const n0 = ProjectApi.getPinNet(this, c.id, 0);
            const n1 = ProjectApi.getPinNet(this, c.id, 1);
            let ledPinIndex = -1, ledFacingPin = -1;
            if (n0 === vccNet && n1 === anodeNet) { ledPinIndex = 0; ledFacingPin = 1; }
            else if (n1 === vccNet && n0 === anodeNet) { ledPinIndex = 0; ledFacingPin = 0; }
            else if (n0 === vccNet && n1 === cathodeNet) { ledPinIndex = 1; ledFacingPin = 1; }
            else if (n1 === vccNet && n0 === cathodeNet) { ledPinIndex = 1; ledFacingPin = 0; }
            if (ledPinIndex < 0) continue;
            const w = SchematicView.schemPinWorld(c, ledFacingPin);
            const lw = ledPinIndex === 0 ? lw0 : lw1;
            if (!w || !lw) continue;
            const d = Math.hypot(w.x - lw.x, w.y - lw.y);
            if (d < bestD) { bestD = d; best = { resistor: c, ledPinIndex, ledFacingPin }; }
        }
        return best;
    },

    // Schematic-world polyline for a wire: [pinA, ...waypoints, pinB]. Used to keep a
    // newly placed part from landing on top of an existing wire (which would look like
    // an extra connection). Returns null when the wire has no resolvable ends.
    _schemWirePolyline(tr) {
        if (!tr || !Array.isArray(tr.schemEnds)) return null;
        const pts = [];
        const end = (e) => {
            if (!e || typeof e.compId !== 'number') return null;
            const c = this.components.find(x => x.id === e.compId);
            return c ? SchematicView.schemPinWorld(c, e.pinIndex) : null;
        };
        const pa = end(tr.schemEnds[0]), pb = end(tr.schemEnds[1]);
        if (pa) pts.push(pa);
        if (tr.waypoints) for (const w of tr.waypoints) pts.push({ x: w.x, y: w.y });
        if (pb) pts.push(pb);
        return pts.length >= 2 ? pts : null;
    },

    // True when a resistor centred at (cx,cy) with the given size sits clear of other
    // component bodies AND no existing schematic wire runs through its body.
    _schemSpotClear(cx, cy, sizeIdx, excludeIds) {
        const excl = new Set(excludeIds || []);
        const def = ComponentDefs.get('resistor');
        const size = def ? ComponentDefs.getSize(def, sizeIdx) : null;
        const tmp = { type: 'resistor', schemX: cx, schemY: cy, rotation: 0, size: sizeIdx, pins: (size && size.pins) || [] };
        const body = SchematicView.schemSymbolBounds(tmp, 4);
        for (const c of this.components) {
            if (excl.has(c.id)) continue;
            if (typeof c.schemX !== 'number' || typeof c.schemY !== 'number') continue;
            const ob = SchematicView.schemSymbolBounds(c, 0);
            if (body.minX < ob.maxX && body.maxX > ob.minX && body.minY < ob.maxY && body.maxY > ob.minY) return false;
        }
        for (const tr of this.traces) {
            if (!tr.schemWire) continue;
            const poly = this._schemWirePolyline(tr);
            if (!poly) continue;
            for (let i = 0; i < poly.length - 1; i++) {
                if (SchematicLayout.segHitsBody(poly[i], poly[i + 1], [body])) return false;
            }
        }
        return true;
    },

    // Find a clear schematic spot near `near` for a resistor of the given size.
    _findClearSchemSpot(near, sizeIdx, excludeIds) {
        const cands = [[0, 0], [0, -40], [0, 40], [-40, 0], [40, 0], [0, -80], [0, 80], [-80, 0], [80, 0],
            [60, -60], [-60, 60], [60, 60], [-60, -60], [0, -120], [0, 120], [-120, 0], [120, 0]];
        for (const [dx, dy] of cands) {
            const cx = near.x + dx, cy = near.y + dy;
            if (this._schemSpotClear(cx, cy, sizeIdx, excludeIds)) return { x: cx, y: cy };
        }
        return null;
    },

    // Remove any schematic wire directly joining (aComp,aPin) to (bComp,bPin), either order.
    _removeSchemWireBetween(aComp, aPin, bComp, bPin) {
        const ab = (e, c, p) => !!(e && e.compId === c && e.pinIndex === p);
        this.traces = this.traces.filter(tr => {
            if (!tr.schemWire || !Array.isArray(tr.schemEnds)) return true;
            const e0 = tr.schemEnds[0], e1 = tr.schemEnds[1];
            const hit = (ab(e0, aComp, aPin) && ab(e1, bComp, bPin)) || (ab(e0, bComp, bPin) && ab(e1, aComp, aPin));
            return !hit;
        });
    },

    // Right-click action (schematic view only): size the LED's series resistor from the
    // VCC supply voltage and the LED's forward voltage at a 20 mA target, then make the
    // schematic match:
    //   1. Read VCC from the VCC power symbol (its value, e.g. "5V"/"3.3V"/"3V3").
    //   2. If a series resistor already sits between VCC and the LED and is SMALLER than
    //      the target, insert another resistor in series (value = target − existing).
    //   3. If there is no series resistor, insert one between VCC and the LED pin.
    //   4. The new part is placed in a clear spot and its wires auto-route around bodies,
    //      so no trace runs under a component.
    calcLedResistor(comp) {
        if (!comp || comp.type !== 'led') return;
        if (this.view && this.view.mode !== 'schematic') {
            this.setStatus('LED resistor calculator works in Schematic view — switch to Schematic first.');
            return;
        }
        const vf = this.ledVf(comp.value);
        if (vf === null) { this.setStatus('WS2812B is a smart LED — no series resistor needed.'); return; }
        const iA = 0.020; // 20 mA target (standard for indicator LEDs)
        const info = this.findLedVcc(comp);
        if (!info) { this.setStatus('No VCC supply symbol found. Place a VCC power symbol and wire it toward the LED.'); return; }
        const vccComp = info.vccComp;
        let v = this.parseVolt(vccComp.value);
        if (v === null) {
            const n = (this.nets || []).find(x => x.name === info.vccNet);
            if (n && isFinite(n.voltage)) v = n.voltage;
        }
        if (v === null) {
            const s = prompt(`No VCC voltage set. Enter the VCC voltage (V):`, '5');
            if (s === null) { this.setStatus('LED resistor cancelled.'); return; }
            v = parseFloat(s);
            if (!isFinite(v)) { this.setStatus('Invalid voltage.'); return; }
        }
        const vDrop = v - vf;
        if (vDrop <= 0) { this.setStatus(`VCC ${v}V ≤ LED Vf ${vf}V — no series resistor needed.`); return; }
        const r = LedCalc.seriesResistance(v, vf, iA);
        const rStd = this.nearestE24(r);
        const rLabel = this.fmtRes(rStd);
        const formula = `R = (VCC ${v}V − Vf ${vf}V) / 20mA = ${Math.round(r)}Ω → ${rLabel}`;

        // Case 2: a series resistor is already between VCC and the LED pin.
        if (info.existingResistor) {
            const exOhms = this.parseRes(info.existingResistor.value);
            if (exOhms !== null && exOhms >= rStd) {
                this.setStatus(`${info.existingResistor.label || 'R'} = ${info.existingResistor.value} already ≥ ${rLabel} — no change needed.  (${formula})`);
                return;
            }
            const addR = this.nearestE24(Math.max(10, rStd - (exOhms || 0)));
            const placed = this._placeSeriesResistor(comp, info.pinIndex, { compId: info.existingResistor.id, pinIndex: info.ledFacingPin }, addR);
            if (!placed) { this.setStatus(`Calculated ${rLabel} (${formula}), but couldn't insert it in series. Place a resistor manually.`); return; }
            this.setStatus(`Inserted ${placed.label} = ${this.fmtRes(addR)} in series with ${info.existingResistor.label || 'R'}  (${formula})`);
            return;
        }

        // Case 3: no series resistor — insert one between VCC and the LED pin.
        const placed = this._placeSeriesResistor(comp, info.pinIndex, { compId: vccComp.id, pinIndex: 0 }, rStd);
        if (!placed) { this.setStatus(`Calculated ${rLabel} (${formula}), but couldn't place it. Place and wire a ${rLabel} resistor manually.`); return; }
        this.setStatus(`Placed ${placed.label} = ${rLabel} between VCC and ${comp.label || 'LED'}  (${formula})`);
    },

    // Insert a resistor in series between the LED pin and `otherEnd` (the VCC symbol
    // pin, or an existing resistor's LED-facing pin). The part is placed in a clear
    // schematic spot and both ends are wired with auto-routing that avoids component
    // bodies, so no trace runs under a part. Returns the new component, or null.
    _placeSeriesResistor(led, ledPinIndex, otherEnd, rOhms) {
        const def = ComponentDefs.get('resistor');
        if (!def) return null;
        const sizeIdx = def.defaultSize || 0;
        const size = ComponentDefs.getSize(def, sizeIdx);
        if (!size || !size.pins || size.pins.length < 2) return null;
        const otherComp = this.components.find(c => c.id === otherEnd.compId);
        if (!otherComp) return null;
        const pLed = SchematicView.schemPinWorld(led, ledPinIndex);
        const pOther = SchematicView.schemPinWorld(otherComp, otherEnd.pinIndex);
        if (!pLed || !pOther) return null;
        const mid = { x: (pLed.x + pOther.x) / 2, y: (pLed.y + pOther.y) / 2 };
        const spot = this._findClearSchemSpot(mid, sizeIdx, [led.id, otherComp.id]);
        if (!spot) return null;
        // Break any wire that currently joins the LED pin straight to the other end
        // (a direct VCC wire, or the existing resistor's wire) so the new part sits in
        // series rather than in parallel.
        this._removeSchemWireBetween(led.id, ledPinIndex, otherEnd.compId, otherEnd.pinIndex);
        const boardSpot = (typeof this.findFreeBoardSpot === 'function') ? this.findFreeBoardSpot() : { x: 5, y: 5 };
        const rc = {
            id: this.nextId(), type: 'resistor', x: boardSpot.x, y: boardSpot.y,
            rotation: 0, size: sizeIdx, layer: led.layer || 'top',
            value: this.fmtRes(rOhms), label: 'R' + (this.components.filter(c => c.type === 'resistor').length + 1),
            pins: size.pins.map(p => ({ ...p })), schemX: spot.x, schemY: spot.y
        };
        this.components.push(rc);
        if (typeof this.ensureCompSilkLayout === 'function') this.ensureCompSilkLayout(rc);
        // Wire both ends. The schematic renderer auto-routes these around bodies.
        this.createSchemWire({ compId: rc.id, pinIndex: 0 }, { compId: led.id, pinIndex: ledPinIndex });
        this.createSchemWire({ compId: rc.id, pinIndex: 1 }, { compId: otherEnd.compId, pinIndex: otherEnd.pinIndex });
        // A wire is only created when both ends resolve; if neither landed, roll back.
        const wired = this.traces.some(tr => Array.isArray(tr.schemEnds) && tr.schemEnds.some(e => e && e.compId === rc.id));
        if (!wired) {
            this.components.splice(this.components.indexOf(rc), 1);
            return null;
        }
        this.saveState();
        this.render();
        this.showProperties(rc);
        return rc;
    },

    cloneObject(target) {
        const obj = target.obj;
        if (target.type === 'component') {
            const clone = JSON.parse(JSON.stringify(obj));
            clone.id = this.nextId();
            clone.x += 5;
            clone.label = ComponentDefs.get(clone.type).prefix + (this.components.filter(c => c.type === clone.type).length);
            this.components.push(clone);
        } else if (target.type === 'via') {
            const clone = { ...obj, id: this.nextId(), x: obj.x + 5 };
            this.vias.push(clone);
        } else if (target.type === 'trace') {
            const clone = JSON.parse(JSON.stringify(obj));
            clone.id = this.nextId();
            clone.points = clone.points.map(p => ({ ...p, x: p.x + 5 }));
            this.traces.push(clone);
            if (typeof Plan !== 'undefined' && Plan.wouldCross && Plan.wouldCross(this, clone.points, clone.net)) {
                this.traces.pop();
                this.setStatus('Copy not placed: it would short another net.');
                this.render();
                return;
            }
        }
        this.saveState();
        this.render();
    },

    deleteObject(target) {
        if (target.type === 'compSilk') return; // silk labels are edited, never deleted — no undo state
        if (target.type === 'traceVertex') {
            // Remove only this joint and re-route the trace — never drop the whole trace.
            this.deleteTraceVertex(target.traceId, target.pointIndex);
            this.interaction.selectedObject = null;
            this.interaction.selectedSegment = null;
            if (this.interaction.selectedVertices) this.interaction.selectedVertices = []; // keep every delete path selection-clean
            return; // deleteTraceVertex already saved + rendered (one undo step)
        }
        if (target.type === 'trace' && target.segIndex !== undefined && target.obj) {
            this.deleteTraceSegment(target.obj.id, target.segIndex);
            return;
        }
        const obj = target.obj;
        if (target.type === 'component') {
            const idx = this.components.findIndex(c => c.id === obj.id);
            if (idx !== -1) this.components.splice(idx, 1);
        } else if (target.type === 'via') {
            const idx = this.vias.findIndex(v => v.id === obj.id);
            if (idx !== -1) this.vias.splice(idx, 1);
        } else if (target.type === 'trace') {
            const idx = this.traces.findIndex(t => t.id === obj.id);
            if (idx !== -1) {
                const tr = this.traces[idx];
                if (!tr.schemWire && this._ensureLogicalSchemWire) this._ensureLogicalSchemWire(tr);
                if (tr.schemWire && this.view && this.view.mode === 'board') {
                    this.setStatus('Schematic connection — delete it in schematic view');
                    return;
                }
                this.traces.splice(idx, 1);
            }
        }
        this.interaction.selectedObject = null;
        this.interaction.selectedSegment = null;
        this.saveState();
        this.render();
    },

    newProject() {
        if (!confirm('Start a new project? Current work will be lost.')) return;
        this.traces = []; this.components = []; this.vias = []; this.boardOutline = [];
        this.silkTexts = []; // free silk text labels placed on the board
        this.nets = [ // reset to default nets (drop user-added ones)
            { name: 'VCC', color: '#ff4444' },
            { name: 'GND', color: '#44ff44' },
            { name: 'SIG1', color: '#4488ff' }
        ];
        this.resetInteractionState(); // no stale hover/selection ghosts from the old project
        this.undoStack = []; this.redoStack = []; this.idCounter = 0;
        this.projectMeta = null; // fresh design is not a saved project yet
        if (this.updateNetsList) this.updateNetsList();
        this.saveState(); this.fitToView();
    }
});
