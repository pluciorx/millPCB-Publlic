// ============================================================
// Example Projects — starter circuits for makers
// ============================================================

const Examples = {
    list: [
        { id: 'led-blink-esp32', name: 'LED Blink (ESP32)' },
        { id: 'led-blink-uno', name: 'LED Blink (Arduino Uno)' },
        { id: 'led-switch-esp8266', name: 'Switch + LED (ESP8266)' },
        { id: 'ne555-heart', name: 'NE555 Blinking Heart' }
    ],

    build(id) {
        switch (id) {
            case 'led-blink-esp32': return this._ledBlinkEsp32();
            case 'led-blink-uno': return this._ledBlinkUno();
            case 'led-switch-esp8266': return this._switchLedEsp8266();
            case 'ne555-heart': return this._ne555Heart();
            default: throw new Error('Unknown example: ' + id);
        }
    },

    _sizeIdx(type, names) {
        const def = ComponentDefs.get(type);
        const list = Array.isArray(names) ? names : [names];
        for (let n = 0; n < list.length; n++) {
            const i = def.sizes.findIndex(s => s.name === list[n]);
            if (i >= 0) return i;
        }
        return def.defaultSize;
    },

    _clonePins(type, sizeIdx) {
        const def = ComponentDefs.get(type);
        const size = ComponentDefs.getSize(def, sizeIdx !== undefined ? sizeIdx : def.defaultSize);
        return size.pins.map(p => ({ ...p }));
    },

    _pinPos(comp, pinIndex) {
        const pin = comp.pins[pinIndex];
        if (!pin) return null;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        return {
            x: comp.x + pin.x * cos - pin.y * sin,
            y: comp.y + pin.x * sin + pin.y * cos
        };
    },

    _pinByName(comp, name) {
        const idx = comp.pins.findIndex(p => p.name === name);
        return idx >= 0 ? this._pinPos(comp, idx) : null;
    },

    _heartPoint(t, sx, sy) {
        const hx = 16 * Math.pow(Math.sin(t), 3);
        const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        return { x: +(hx * sx).toFixed(2), y: +(hy * sy).toFixed(2) };
    },

    _heartOutline(sx, sy, n) {
        const outline = [];
        for (let i = 0; i < n; i++) outline.push(this._heartPoint((i / n) * Math.PI * 2, sx, sy));
        return outline;
    },

    _heartLedSites(sx, sy, scale, count) {
        const M = 400;
        const raw = [];
        for (let i = 0; i < M; i++) raw.push(this._heartPoint((i / M) * Math.PI * 2, sx * scale, sy * scale));
        const dist = [0];
        for (let i = 1; i <= M; i++) {
            const a = raw[(i - 1) % M], b = raw[i % M];
            dist[i] = dist[i - 1] + Math.hypot(a.x - b.x, a.y - b.y);
        }
        const L = dist[M];
        const sites = [];
        for (let k = 0; k < count; k++) {
            const target = (k * L) / count;
            let j = 0;
            while (j < M && dist[j] < target) j++;
            const p = raw[j % M];
            if (Math.abs(p.x) < 2 && p.y < -5) continue;
            sites.push({
                x: +p.x.toFixed(2),
                y: +p.y.toFixed(2),
                rotation: Math.round(Math.atan2(p.y, p.x) * 180 / Math.PI)
            });
        }
        return sites;
    },

    _trace(id, p1, p2, net, width) {
        return { id, points: [p1, p2], width: width || 0.5, layer: 'top', net, schemWire: true };
    },

    _ledBlinkEsp32() {
        const esp = {
            id: 1, type: 'esp32_devkit', x: -10, y: 0, rotation: 0, size: 0,
            value: 'ESP32 DevKitC', label: 'U1',
            pins: this._clonePins('esp32_devkit', 0)
        };
        const rLedSize = this._sizeIdx('resistor', ['220\u03a9 0805', 'TH 1/4W', '0805']);
        const ledSize = this._sizeIdx('led', ['5mm Red', 'TH 5mm']);
        const r1 = {
            id: 2, type: 'resistor', x: 18, y: 0, rotation: 0, size: rLedSize,
            value: '220\u2126', label: 'R1',
            pins: this._clonePins('resistor', rLedSize)
        };
        const d1 = {
            id: 3, type: 'led', x: 32, y: 0, rotation: 0, size: ledSize,
            value: 'LED-RED', label: 'D1',
            pins: this._clonePins('led', ledSize)
        };
        const gnd = {
            id: 4, type: 'gnd', x: 46, y: 8, rotation: 0, size: 0,
            value: 'GND', label: '',
            pins: this._clonePins('gnd', 0)
        };

        const gpio2 = this._pinByName(esp, 'GPIO2');
        const traces = [];
        if (gpio2) traces.push(this._trace(1, gpio2, this._pinPos(r1, 0), 'GPIO2'));
        traces.push(this._trace(2, this._pinPos(r1, 1), this._pinPos(d1, 0), 'GPIO2'));
        traces.push(this._trace(3, this._pinPos(d1, 1), this._pinPos(gnd, 0), 'GND'));

        return {
            board: { width: 100, height: 80, thickness: 1.2, copperWeight: 1, material: 'FR4' },
            components: [esp, r1, d1, gnd],
            traces,
            vias: [],
            boardOutline: [],
            silkTexts: [],
            nets: [
                { name: 'VCC', color: '#ff4444' },
                { name: 'GND', color: '#44ff44' },
                { name: 'GPIO2', color: '#ffaa00' }
            ],
            idCounter: 4
        };
    },

    _ledBlinkUno() {
        const uno = {
            id: 1, type: 'arduino_uno', x: 0, y: 0, rotation: 0, size: 0,
            value: 'Arduino Uno R3', label: 'U1',
            pins: this._clonePins('arduino_uno', 0)
        };
        const rLedSize = this._sizeIdx('resistor', ['220\u03a9 0805', 'TH 1/4W', '0805']);
        const ledSize = this._sizeIdx('led', ['0805 Red', '0805', 'TH 5mm']);
        const r1 = {
            id: 2, type: 'resistor', x: 42, y: -26, rotation: 90, size: rLedSize,
            value: '220\u2126', label: 'R1',
            pins: this._clonePins('resistor', rLedSize)
        };
        const d1 = {
            id: 3, type: 'led', x: 42, y: -14, rotation: 90, size: ledSize,
            value: 'LED-RED', label: 'D1',
            pins: this._clonePins('led', ledSize)
        };
        const gnd = {
            id: 4, type: 'gnd', x: 42, y: -2, rotation: 0, size: 0,
            value: 'GND', label: '',
            pins: this._clonePins('gnd', 0)
        };

        const d13 = this._pinByName(uno, 'D13');
        const traces = [
            this._trace(1, d13, this._pinPos(r1, 0), 'D13'),
            this._trace(2, this._pinPos(r1, 1), this._pinPos(d1, 0), 'D13'),
            this._trace(3, this._pinPos(d1, 1), this._pinPos(gnd, 0), 'GND')
        ];

        return {
            board: { width: 120, height: 90, thickness: 1.2, copperWeight: 1, material: 'FR4' },
            components: [uno, r1, d1, gnd],
            traces,
            vias: [],
            boardOutline: [],
            silkTexts: [],
            nets: [
                { name: 'VCC', color: '#ff4444' },
                { name: 'GND', color: '#44ff44' },
                { name: 'D13', color: '#4488ff' }
            ],
            idCounter: 4
        };
    },

    _switchLedEsp8266() {
        const nodemcu = {
            id: 1, type: 'esp8266_nodemcu', x: -8, y: 0, rotation: 0, size: 0,
            value: 'NodeMCU ESP8266', label: 'U1',
            pins: this._clonePins('esp8266_nodemcu', 0)
        };
        const swSize = this._sizeIdx('switch', ['SPST 6mm']);
        const fuseSize = this._sizeIdx('fuse', ['0805']);
        const sw = {
            id: 2, type: 'switch', x: 20, y: -12, rotation: 0, size: swSize,
            value: 'SW-SPST', label: 'SW1',
            pins: this._clonePins('switch', swSize)
        };
        const f1 = {
            id: 3, type: 'fuse', x: 20, y: 0, rotation: 90, size: fuseSize,
            value: '500mA', label: 'F1',
            pins: this._clonePins('fuse', fuseSize)
        };
        const rLedSize = this._sizeIdx('resistor', ['220\u03a9 0805', 'TH 1/4W', '0805']);
        const ledSize = this._sizeIdx('led', ['5mm Red', 'TH 5mm']);
        const r1 = {
            id: 4, type: 'resistor', x: 20, y: 12, rotation: 90, size: rLedSize,
            value: '220\u2126', label: 'R1',
            pins: this._clonePins('resistor', rLedSize)
        };
        const d1 = {
            id: 5, type: 'led', x: 20, y: 24, rotation: 90, size: ledSize,
            value: 'LED-RED', label: 'D1',
            pins: this._clonePins('led', ledSize)
        };
        const gnd = {
            id: 6, type: 'gnd', x: 34, y: 24, rotation: 0, size: 0,
            value: 'GND', label: '',
            pins: this._clonePins('gnd', 0)
        };

        const d4 = this._pinByName(nodemcu, 'D4');
        const traces = [
            this._trace(1, d4, this._pinPos(sw, 0), 'LED_NET'),
            this._trace(2, this._pinPos(sw, 1), this._pinPos(f1, 0), 'LED_NET'),
            this._trace(3, this._pinPos(f1, 1), this._pinPos(r1, 0), 'LED_NET'),
            this._trace(4, this._pinPos(r1, 1), this._pinPos(d1, 0), 'LED_NET'),
            this._trace(5, this._pinPos(d1, 1), this._pinPos(gnd, 0), 'GND')
        ];

        return {
            board: { width: 100, height: 80, thickness: 1.2, copperWeight: 1, material: 'FR4' },
            components: [nodemcu, sw, f1, r1, d1, gnd],
            traces,
            vias: [],
            boardOutline: [],
            silkTexts: [],
            nets: [
                { name: 'VCC', color: '#ff4444' },
                { name: 'GND', color: '#44ff44' },
                { name: 'LED_NET', color: '#4488ff' }
            ],
            idCounter: 6
        };
    },

    _ne555Heart() {
        const sx = 1.85, sy = 1.7;
        const outline = this._heartOutline(sx, sy, 72);
        const thRes = this._sizeIdx('resistor', ['TH 1/4W']);
        const led3 = this._sizeIdx('led', ['3mm Red', 'TH 3mm']);
        const cap10u = this._sizeIdx('capacitor', ['10\u00b5F Electrolytic 5mm']);
        const cap100n = this._sizeIdx('capacitor', ['100nF 0805']);

        const u1 = { id: 1, type: 'ic', x: 0, y: 1, rotation: 0, size: 0, value: 'NE555', label: 'U1', schemX: 0, schemY: 0, pins: this._clonePins('ic', 0) };
        const j1 = { id: 10, type: 'connector', x: 0, y: -11, rotation: 180, size: 0, value: 'POWER', label: 'J1', schemX: -80, schemY: -140, pins: this._clonePins('connector', 0) };
        const r1 = { id: 2, type: 'resistor', x: 11, y: -2.81, rotation: 0, size: thRes, value: '10k\u2126', label: 'R1', schemX: 220, schemY: -120, pins: this._clonePins('resistor', thRes) };
        const r2 = { id: 3, type: 'resistor', x: 11, y: 2.27, rotation: 0, size: thRes, value: '100k\u2126', label: 'R2', schemX: 340, schemY: 80, pins: this._clonePins('resistor', thRes) };
        const c1 = { id: 4, type: 'capacitor', x: 7, y: 11, rotation: 0, size: cap10u, value: '10\u00b5F', label: 'C1', schemX: 220, schemY: 140, pins: this._clonePins('capacitor', cap10u) };
        const c2 = { id: 5, type: 'capacitor', x: 6.8, y: 4.81, rotation: 0, size: cap100n, value: '100nF', label: 'C2', schemX: 180, schemY: -90, pins: this._clonePins('capacitor', cap100n) };
        const sites = this._heartLedSites(sx, sy, 0.82, 16);
        const leds = sites.map((s, i) => ({
            id: 20 + i, type: 'led', x: s.x, y: s.y, rotation: s.rotation, size: led3,
            value: 'LED-RED', label: 'D' + (i + 1),
            schemX: Math.round(s.x * 9) - 280,
            schemY: Math.round(s.y * 9),
            schemRotation: 0,
            pins: this._clonePins('led', led3)
        }));
        const rLed = { id: 6, type: 'resistor', x: -11, y: 2.27, rotation: 0, size: thRes, value: '220\u2126', label: 'R3', schemX: -140, schemY: 0, pins: this._clonePins('resistor', thRes) };
        const gndTp = { id: 11, type: 'gnd', x: 0, y: 16, rotation: 0, size: 0, value: 'GND', label: '', schemX: -280, schemY: 260, pins: this._clonePins('gnd', 0) };

        const traces = [];
        const vias = [{ id: 80, x: 5.5, y: -8, diameter: 1.0 }];
        let tid = 1;
        function tr(pts, net, layer, schemWire) {
            if (!pts[0] || !pts[1]) return;
            traces.push({ id: tid++, points: pts, width: 0.5, layer: layer || 'top', net, schemWire: schemWire !== false });
        }

        const u1dis = this._pinByName(u1, 'DIS');
        const u1thr = this._pinByName(u1, 'THR');
        const u1trig = this._pinByName(u1, 'TRIG');
        const u1out = this._pinByName(u1, 'OUT');
        const u1vcc = this._pinByName(u1, 'VCC');
        const u1gnd = this._pinByName(u1, 'GND');
        const u1rst = this._pinByName(u1, 'RST');
        const u1cv = this._pinByName(u1, 'CV');
        const viaP = { x: 5.5, y: -8 };
        const r1p0 = this._pinPos(r1, 0), r1p1 = this._pinPos(r1, 1);
        const r2p0 = this._pinPos(r2, 0), r2p1 = this._pinPos(r2, 1);
        const r3p0 = this._pinPos(rLed, 0), r3p1 = this._pinPos(rLed, 1);
        const c1neg = this._pinPos(c1, 0), c1pos = this._pinPos(c1, 1);
        const c2p0 = this._pinPos(c2, 0), c2p1 = this._pinPos(c2, 1);
        const gndP = this._pinPos(gndTp, 0);

        // Timing east of U1 (top); TRIG wrap and RST stay off the pin columns
        tr([r1p1, { x: r1p1.x, y: u1dis.y }, u1dis], 'DIS_NET');
        tr([u1dis, { x: r2p0.x, y: u1dis.y }, r2p0], 'DIS_NET');
        tr([r2p1, { x: r2p1.x, y: 0.4 }, { x: 9.4, y: 0.4 }, { x: 9.4, y: u1thr.y }, u1thr], 'TRIG_THR', 'bottom');
        tr([u1thr, { x: 9.4, y: u1thr.y }, { x: 9.4, y: 0.4 }, { x: -6.2, y: 0.4 }, { x: -6.2, y: u1trig.y }, u1trig], 'TRIG_THR', 'bottom', false);
        tr([u1thr, { x: 5.2, y: u1thr.y }, { x: 5.2, y: 9.2 }, { x: c1pos.x, y: 9.2 }, c1pos], 'TRIG_THR');
        tr([u1cv, c2p0], 'CV_NET', 'bottom');
        tr([u1out, r3p1], 'OUT_NET');

        const anodes = leds.map(d => this._pinByName(d, 'A'));
        const cathodes = leds.map(d => this._pinByName(d, 'K'));
        let nearest = 0, nearestD = 1e9;
        for (let i = 0; i < anodes.length; i++) {
            const d = Math.hypot(anodes[i].x - r3p0.x, anodes[i].y - r3p0.y);
            if (d < nearestD) { nearestD = d; nearest = i; }
        }
        rLed.schemX = leds[nearest].schemX + 90;
        rLed.schemY = leds[nearest].schemY;
        gndTp.schemX = leds[7].schemX;
        gndTp.schemY = leds[7].schemY + 80;
        tr([r3p0, anodes[nearest]], 'LED_NET');
        for (let i = 0; i < anodes.length - 1; i++) tr([anodes[i], anodes[i + 1]], 'LED_NET');

        tr([this._pinPos(j1, 0), viaP], 'VCC', 'top', false);
        tr([viaP, { x: 5.5, y: u1vcc.y }, u1vcc], 'VCC', 'bottom', false);
        tr([this._pinPos(j1, 0), u1vcc], 'VCC', 'bottom');
        tr([u1vcc, r1p0], 'VCC', 'bottom');
        tr([u1rst, { x: -8.5, y: u1rst.y }, { x: -8.5, y: -6 }, { x: u1vcc.x, y: -6 }, u1vcc], 'VCC', 'top', false);

        tr([u1gnd, { x: u1gnd.x, y: -4.5 }, { x: -14, y: -4.5 }, { x: -14, y: cathodes[cathodes.length - 1].y }, cathodes[cathodes.length - 1]], 'GND', 'bottom', false);
        tr([this._pinPos(j1, 1), u1gnd], 'GND', 'bottom');
        tr([this._pinPos(j1, 1), { x: this._pinPos(j1, 1).x, y: cathodes[cathodes.length - 1].y }, cathodes[cathodes.length - 1]], 'GND', 'bottom', false);
        tr([c1neg, cathodes[6]], 'GND', 'bottom', false);
        tr([c2p1, { x: c2p1.x, y: c1neg.y }, c1neg], 'GND', 'bottom');
        tr([gndP, cathodes[7]], 'GND', 'bottom');
        for (let i = 0; i < cathodes.length - 1; i++) tr([cathodes[i], cathodes[i + 1]], 'GND', 'bottom');

        const maxId = [u1, r1, r2, c1, c2, rLed, j1, gndTp, ...leds].reduce((m, c) => Math.max(m, c.id), 91);
        return {
            board: { width: 68, height: 64, thickness: 1.2, copperWeight: 1, material: 'FR4' },
            components: [u1, r1, r2, c1, c2, rLed, j1, gndTp, ...leds],
            traces, vias, boardOutline: outline,
            silkTexts: [
                { id: 90, text: 'NE555 HEART', x: 0, y: -1, size: 1.4, rotation: 0, layer: 'silkTop' },
                { id: 91, text: 'millPCB', x: 0, y: 8, size: 1.2, rotation: 0, layer: 'silkBottom' }
            ],
            nets: [
                { name: 'VCC', color: '#ff4444' },
                { name: 'GND', color: '#44ff44' },
                { name: 'DIS_NET', color: '#ffaa00' },
                { name: 'TRIG_THR', color: '#aa66ff' },
                { name: 'CV_NET', color: '#66ccff' },
                { name: 'OUT_NET', color: '#4488ff' },
                { name: 'LED_NET', color: '#ff66aa' }
            ],
            idCounter: maxId
        };
    }
};
