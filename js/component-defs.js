// ============================================================
// Component Definitions (footprint + symbol data)
// All dimensions in mm. Pin positions relative to component center.
// Sourced from standard manufacturer datasheets:
//   - SMD: IPC-7351 recommended land patterns
//   - TH LEDs: 1.6mm lead pitch (standard narrow-lead round LED)
//   - SOIC: 1.27mm pin pitch (50 mil), JEDEC standard
//   - DIP: 2.54mm pin pitch, 7.62mm row spacing (300 mil)
//   - TO-92: 1.27mm pin pitch | TO-220: 2.54mm pin pitch
// ============================================================

function _smd2(name, w, h, extra) {
    const hx = +(w * 0.5).toFixed(3);
    return Object.assign({ name, width: w, height: h, pins: [{ x: -hx, y: 0, name: '1' }, { x: hx, y: 0, name: '2' }] }, extra || {});
}
function _dip(n, pinNames) {
    const cols = n / 2, pitch = 2.54, row = 7.62;
    const pins = [];
    const y0 = -((cols - 1) * pitch) / 2;
    for (let i = 0; i < cols; i++) pins.push({ x: -row / 2, y: +(y0 + i * pitch).toFixed(3), name: (pinNames && pinNames[i + 1]) || String(i + 1) });
    for (let i = 0; i < cols; i++) {
        const num = cols + 1 + i;
        pins.push({ x: row / 2, y: +(y0 + (cols - 1 - i) * pitch).toFixed(3), name: (pinNames && pinNames[num]) || String(num) });
    }
    return { width: +(row + 2.2).toFixed(3), height: +((cols - 1) * pitch + 3).toFixed(3), th: true, pins };
}
function _hdr(rows, cols, pitch, kind) {
    rows = rows === 2 ? 2 : 1;
    cols = Math.max(1, Math.min(16, cols | 0));
    pitch = pitch || 2.54;
    const female = kind === 'female';
    const pins = [];
    const x0 = -((cols - 1) * pitch) / 2;
    const y0 = -((rows - 1) * pitch) / 2;
    let n = 1;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            pins.push({ x: +(x0 + c * pitch).toFixed(3), y: +(y0 + r * pitch).toFixed(3), name: String(n++) });
        }
    }
    return {
        name: (female ? 'Female ' : '') + rows + '\u00d7' + cols + ' ' + pitch + 'mm',
        width: +((cols - 1) * pitch + pitch).toFixed(3),
        height: +((rows - 1) * pitch + pitch).toFixed(3),
        th: true, rows, cols, pitch, hdrKind: female ? 'female' : 'male', pins
    };
}
// Through-hole slide DIP switch: one switch per position, pins 2.54mm apart,
// rows 7.62mm apart (same grid as a DIP IC).
function _dipsw(positions) {
    const n = Math.max(1, Math.min(12, positions | 0));
    const pitch = 2.54, row = 7.62;
    const y0 = -((n - 1) * pitch) / 2;
    const pins = [];
    for (let i = 0; i < n; i++) {
        const y = +(y0 + i * pitch).toFixed(3);
        pins.push({ x: -row / 2, y: y, name: (i + 1) + 'a' });
        pins.push({ x: row / 2, y: y, name: (i + 1) + 'b' });
    }
    return {
        name: 'DIP ' + n,
        width: 9.8,
        height: +((n - 1) * pitch + 4.5).toFixed(3),
        th: true, dipsw: n, pins
    };
}
function _to92(pins) {
    return { width: 4.5, height: 4.5, th: true, pins };
}
function _to220(pins) {
    return { width: 10.0, height: 4.5, th: true, pins };
}
function _sot23(pins) {
    return { width: 2.9, height: 1.3, pins };
}

const ComponentDefs = {
    defs: {
        resistor: { prefix: 'R', defaultValue: '10k\u2126', sizes: [
            _smd2('10\u03a9 0805', 2.0, 1.25, { value: '10\u03a9' }),
            _smd2('100\u03a9 0805', 2.0, 1.25, { value: '100\u03a9' }),
            _smd2('220\u03a9 0805', 2.0, 1.25, { value: '220\u03a9' }),
            _smd2('330\u03a9 0805', 2.0, 1.25, { value: '330\u03a9' }),
            _smd2('1k\u03a9 0805', 2.0, 1.25, { value: '1k\u03a9' }),
            _smd2('4.7k\u03a9 0805', 2.0, 1.25, { value: '4.7k\u03a9' }),
            _smd2('10k\u03a9 0805', 2.0, 1.25, { value: '10k\u03a9' }),
            _smd2('22k\u03a9 0805', 2.0, 1.25, { value: '22k\u03a9' }),
            _smd2('100k\u03a9 0805', 2.0, 1.25, { value: '100k\u03a9' }),
            _smd2('1M\u03a9 0805', 2.0, 1.25, { value: '1M\u03a9' }),
            // TH axial 1/4W: 7.62mm lead-to-lead (3/10 inch) — standard for milling
            { name: 'TH 1/4W', width: 6.3, height: 3.2, pins: [{ x: -3.81, y: 0, name: '1' }, { x: 3.81, y: 0, name: '2' }] },
            // TH axial 1/2W: 9.525mm lead-to-lead (3/8 inch)
            { name: 'TH 1/2W', width: 9.0, height: 4.5, pins: [{ x: -4.76, y: 0, name: '1' }, { x: 4.76, y: 0, name: '2' }] },
            // SMD (largest to smallest)
            { name: '1210', width: 3.2, height: 2.5, pins: [{ x: -1.6, y: 0, name: '1' }, { x: 1.6, y: 0, name: '2' }] },
            { name: '1206', width: 3.2, height: 1.6, pins: [{ x: -1.6, y: 0, name: '1' }, { x: 1.6, y: 0, name: '2' }] },
            { name: '0805', width: 2.0, height: 1.25, pins: [{ x: -1.0, y: 0, name: '1' }, { x: 1.0, y: 0, name: '2' }] },
            { name: '0603', width: 1.6, height: 0.8, pins: [{ x: -0.8, y: 0, name: '1' }, { x: 0.8, y: 0, name: '2' }] },
            { name: '0402', width: 1.0, height: 0.5, pins: [{ x: -0.5, y: 0, name: '1' }, { x: 0.5, y: 0, name: '2' }] }
        ], defaultSize: 10 },

        capacitor: { prefix: 'C', defaultValue: '100nF', sizes: [
            _smd2('22pF 0805', 2.0, 1.25, { value: '22pF' }),
            _smd2('100pF 0805', 2.0, 1.25, { value: '100pF' }),
            _smd2('1nF 0805', 2.0, 1.25, { value: '1nF' }),
            _smd2('10nF 0805', 2.0, 1.25, { value: '10nF' }),
            _smd2('100nF 0805', 2.0, 1.25, { value: '100nF' }),
            _smd2('1\u00b5F 0805', 2.0, 1.25, { value: '1\u00b5F' }),
            _smd2('10\u00b5F 0805', 2.0, 1.25, { value: '10\u00b5F' }),
            { name: '10\u00b5F Electrolytic 5mm', value: '10\u00b5F', width: 5.0, height: 5.0, th: true, pins: [{ x: -1.25, y: 0, name: '-' }, { x: 1.25, y: 0, name: '+' }] },
            { name: '100\u00b5F Electrolytic 8mm', value: '100\u00b5F', width: 8.0, height: 10.0, th: true, pins: [{ x: -1.75, y: 0, name: '-' }, { x: 1.75, y: 0, name: '+' }] },
            { name: '470\u00b5F Electrolytic 8mm', value: '470\u00b5F', width: 8.0, height: 10.0, th: true, pins: [{ x: -1.75, y: 0, name: '-' }, { x: 1.75, y: 0, name: '+' }] },
            // TH ceramic disc: 5mm body, 2.54mm lead pitch — standard for milling
            { name: 'TH Ceramic 5mm', width: 5.0, height: 5.0, pins: [{ x: -1.27, y: 0, name: '1' }, { x: 1.27, y: 0, name: '2' }] },
            // TH electrolytic: 8mm case, 5.08mm lead pitch
            { name: 'TH Electrolytic 8mm', width: 8.0, height: 10.0, pins: [{ x: -2.54, y: 0, name: '1' }, { x: 2.54, y: 0, name: '2' }] },
            // SMD (largest to smallest)
            { name: '1206', width: 3.2, height: 1.6, pins: [{ x: -1.6, y: 0, name: '1' }, { x: 1.6, y: 0, name: '2' }] },
            { name: '0805', width: 2.0, height: 1.25, pins: [{ x: -1.0, y: 0, name: '1' }, { x: 1.0, y: 0, name: '2' }] },
            { name: '0603', width: 1.6, height: 0.8, pins: [{ x: -0.8, y: 0, name: '1' }, { x: 0.8, y: 0, name: '2' }] },
            { name: '0402', width: 1.0, height: 0.5, pins: [{ x: -0.5, y: 0, name: '1' }, { x: 0.5, y: 0, name: '2' }] }
        ], defaultSize: 4 },

        led: { prefix: 'D', defaultValue: 'LED-RED', sizes: [
            { name: '5mm Red', value: 'LED-RED', width: 5.2, height: 5.2, th: true, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '5mm Green', value: 'LED-GRN', width: 5.2, height: 5.2, th: true, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '5mm Blue', value: 'LED-BLU', width: 5.2, height: 5.2, th: true, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '5mm Yellow', value: 'LED-YEL', width: 5.2, height: 5.2, th: true, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '5mm White', value: 'LED-WHT', width: 5.2, height: 5.2, th: true, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '3mm Red', value: 'LED-RED', width: 3.2, height: 3.2, th: true, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '0805 Red', value: 'LED-RED', width: 2.0, height: 1.25, pins: [{ x: -1.0, y: 0, name: 'A' }, { x: 1.0, y: 0, name: 'K' }] },
            { name: '0603 Red', value: 'LED-RED', width: 1.6, height: 0.8, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            { name: '1206 Red', value: 'LED-RED', width: 3.2, height: 1.6, pins: [{ x: -1.6, y: 0, name: 'A' }, { x: 1.6, y: 0, name: 'K' }] },
            { name: 'WS2812B', value: 'WS2812B', width: 5.0, height: 5.0, pins: [
                { x: -1.6, y: 1.6, name: 'DIN' }, { x: 1.6, y: 1.6, name: 'VDD' },
                { x: 1.6, y: -1.6, name: 'GND' }, { x: -1.6, y: -1.6, name: 'DOUT' }
            ]},
            // TH round LED 5mm: 1.6mm standard narrow-lead pitch — standard for milling
            { name: 'TH 5mm', width: 5.2, height: 5.2, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            // TH round LED 3mm: 1.6mm standard narrow-lead pitch
            { name: 'TH 3mm', width: 3.2, height: 3.2, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] },
            // SMD (largest to smallest)
            { name: '1206', width: 3.2, height: 1.6, pins: [{ x: -1.6, y: 0, name: 'A' }, { x: 1.6, y: 0, name: 'K' }] },
            { name: '0805', width: 2.0, height: 1.25, pins: [{ x: -1.0, y: 0, name: 'A' }, { x: 1.0, y: 0, name: 'K' }] },
            { name: '0603', width: 1.6, height: 0.8, pins: [{ x: -0.8, y: 0, name: 'A' }, { x: 0.8, y: 0, name: 'K' }] }
        ], defaultSize: 0 },

        ic: { prefix: 'U', defaultValue: 'NE555', sizes: [
            Object.assign({ name: 'NE555 DIP-8', value: 'NE555' }, _dip(8, {
                1: 'GND', 2: 'TRIG', 3: 'OUT', 4: 'RST', 5: 'CV', 6: 'THR', 7: 'DIS', 8: 'VCC'
            })),
            Object.assign({ name: 'LM358 DIP-8', value: 'LM358' }, _dip(8, {
                1: 'OUTA', 2: 'INA-', 3: 'INA+', 4: 'GND', 5: 'INB+', 6: 'INB-', 7: 'OUTB', 8: 'VCC'
            })),
            Object.assign({ name: 'LM324 DIP-14', value: 'LM324' }, _dip(14, {
                1: 'OUT1', 2: 'IN1-', 3: 'IN1+', 4: 'VCC', 5: 'IN2+', 6: 'IN2-', 7: 'OUT2',
                8: 'OUT3', 9: 'IN3-', 10: 'IN3+', 11: 'GND', 12: 'IN4+', 13: 'IN4-', 14: 'OUT4'
            })),
            Object.assign({ name: '74HC00 DIP-14', value: '74HC00' }, _dip(14, {
                1: '1A', 2: '1B', 3: '1Y', 4: '2A', 5: '2B', 6: '2Y', 7: 'GND',
                8: '3Y', 9: '3A', 10: '3B', 11: '4Y', 12: '4A', 13: '4B', 14: 'VCC'
            })),
            Object.assign({ name: '74HC14 DIP-14', value: '74HC14' }, _dip(14, {
                1: '1A', 2: '1Y', 3: '2A', 4: '2Y', 5: '3A', 6: '3Y', 7: 'GND',
                8: '4Y', 9: '4A', 10: '5Y', 11: '5A', 12: '6Y', 13: '6A', 14: 'VCC'
            })),
            Object.assign({ name: '74HC595 DIP-16', value: '74HC595' }, _dip(16, {
                1: 'QB', 2: 'QC', 3: 'QD', 4: 'QE', 5: 'QF', 6: 'QG', 7: 'QH', 8: 'GND',
                9: 'QH\'', 10: 'SRCLR', 11: 'SRCLK', 12: 'RCLK', 13: 'OE', 14: 'SER', 15: 'QA', 16: 'VCC'
            })),
            Object.assign({ name: 'ULN2803 DIP-18', value: 'ULN2803A' }, _dip(18, {
                1: 'IN1', 2: 'IN2', 3: 'IN3', 4: 'IN4', 5: 'IN5', 6: 'IN6', 7: 'IN7', 8: 'IN8', 9: 'GND',
                10: 'COM', 11: 'OUT8', 12: 'OUT7', 13: 'OUT6', 14: 'OUT5', 15: 'OUT4', 16: 'OUT3', 17: 'OUT2', 18: 'OUT1'
            })),
            Object.assign({ name: 'ATmega328P DIP-28', value: 'ATmega328P' }, _dip(28, {
                1: 'RST', 2: 'RX', 3: 'TX', 4: 'D2', 5: 'D3', 6: 'D4', 7: 'VCC', 8: 'GND',
                9: 'XTAL1', 10: 'XTAL2', 11: 'D5', 12: 'D6', 13: 'D7', 14: 'D8',
                15: 'D9', 16: 'D10', 17: 'D11', 18: 'D12', 19: 'D13', 20: 'AVCC',
                21: 'AREF', 22: 'GND', 23: 'A0', 24: 'A1', 25: 'A2', 26: 'A3', 27: 'A4', 28: 'A5'
            })),
            Object.assign({ name: 'CH340C SOIC-16', value: 'CH340C' }, { width: 9.9, height: 3.9, pins: [
                { x: -4.95, y: -4.445, name: 'VCC' }, { x: -4.95, y: -3.175, name: 'UD+' }, { x: -4.95, y: -1.905, name: 'UD-' }, { x: -4.95, y: -0.635, name: 'GND' },
                { x: -4.95, y: 0.635, name: 'XI' }, { x: -4.95, y: 1.905, name: 'XO' }, { x: -4.95, y: 3.175, name: 'RTS' }, { x: -4.95, y: 4.445, name: 'DTR' },
                { x: 4.95, y: 4.445, name: 'DCD' }, { x: 4.95, y: 3.175, name: 'RI' }, { x: 4.95, y: 1.905, name: 'DSR' }, { x: 4.95, y: 0.635, name: 'CTS' },
                { x: 4.95, y: -0.635, name: 'TXD' }, { x: 4.95, y: -1.905, name: 'RXD' }, { x: 4.95, y: -3.175, name: 'R232' }, { x: 4.95, y: -4.445, name: 'V3' }
            ]}),
            Object.assign({ name: '24LC256 DIP-8', value: '24LC256' }, _dip(8, {
                1: 'A0', 2: 'A1', 3: 'A2', 4: 'GND', 5: 'SDA', 6: 'SCL', 7: 'WP', 8: 'VCC'
            })),
            // Generic packages (KiCad geometry overlays matching names)
            Object.assign({ name: 'DIP-8' }, _dip(8)),
            Object.assign({ name: 'DIP-14' }, _dip(14)),
            // SOIC-16 (narrow): 9.9x3.9mm body, 1.27mm pin pitch
            { name: 'SOIC-16', width: 9.9, height: 3.9, pins: [
                { x: -4.95, y: -4.445, name: '1' }, { x: -4.95, y: -3.175, name: '2' }, { x: -4.95, y: -1.905, name: '3' }, { x: -4.95, y: -0.635, name: '4' },
                { x: -4.95, y: 0.635, name: '5' }, { x: -4.95, y: 1.905, name: '6' }, { x: -4.95, y: 3.175, name: '7' }, { x: -4.95, y: 4.445, name: '8' },
                { x: 4.95, y: -4.445, name: '9' }, { x: 4.95, y: -3.175, name: '10' }, { x: 4.95, y: -1.905, name: '11' }, { x: 4.95, y: -0.635, name: '12' },
                { x: 4.95, y: 0.635, name: '13' }, { x: 4.95, y: 1.905, name: '14' }, { x: 4.95, y: 3.175, name: '15' }, { x: 4.95, y: 4.445, name: '16' }
            ]},
            // SOIC-8 (narrow): 4.9x3.9mm body, 1.27mm pin pitch (JEDEC MO-153)
            { name: 'SOIC-8', width: 4.9, height: 3.9, pins: [
                { x: -2.45, y: -1.905, name: '1' }, { x: -2.45, y: -0.635, name: '2' }, { x: -2.45, y: 0.635, name: '3' }, { x: -2.45, y: 1.905, name: '4' },
                { x: 2.45, y: -1.905, name: '5' }, { x: 2.45, y: -0.635, name: '6' }, { x: 2.45, y: 0.635, name: '7' }, { x: 2.45, y: 1.905, name: '8' }
            ]},
            // SOT-23: 2.9x1.3mm, 0.95mm pitch (JEDEC MO-178)
            { name: 'SOT-23', width: 2.9, height: 1.3, pins: [
                { x: -0.95, y: -0.65, name: '1' }, { x: 0.95, y: -0.65, name: '2' }, { x: 0, y: 0.65, name: '3' }
            ]}
        ], defaultSize: 0 },

        connector: { prefix: 'J', defaultValue: 'HDR', sizes: [
            _hdr(1, 2, 2.54), _hdr(1, 4, 2.54), _hdr(1, 8, 2.54),
            _hdr(2, 3, 2.54), _hdr(2, 5, 2.54), _hdr(2, 8, 2.54),
            { name: 'USB-C', width: 9.0, height: 3.1, pins: [
                { x: -3.5, y: -1.0, name: '1' }, { x: -1.2, y: -1.0, name: '2' }, { x: 1.2, y: -1.0, name: '3' }, { x: 3.5, y: -1.0, name: '4' }
            ]},
            { name: 'Barrel jack', value: 'BARREL', width: 14.0, height: 9.0, th: true, pins: [
                { x: -4.0, y: 0, name: 'TIP' }, { x: 0, y: 0, name: 'SLEEVE' }, { x: 4.0, y: 0, name: 'SW' }
            ]}
        ], defaultSize: 0 },
        inductor: { prefix: 'L', defaultValue: '10\u03bcH', sizes: [
            _smd2('1\u03bcH 0805', 2.0, 1.25, { value: '1\u03bcH' }),
            _smd2('2.2\u03bcH 0805', 2.0, 1.25, { value: '2.2\u03bcH' }),
            _smd2('4.7\u03bcH 0805', 2.0, 1.25, { value: '4.7\u03bcH' }),
            _smd2('10\u03bcH 0805', 2.0, 1.25, { value: '10\u03bcH' }),
            _smd2('22\u03bcH 0805', 2.0, 1.25, { value: '22\u03bcH' }),
            _smd2('47\u03bcH 0805', 2.0, 1.25, { value: '47\u03bcH' }),
            _smd2('100\u03bcH 0805', 2.0, 1.25, { value: '100\u03bcH' }),
            _smd2('220\u03bcH 0805', 2.0, 1.25, { value: '220\u03bcH' }),
            { name: '10\u03bcH TH 5mm', value: '10\u03bcH', width: 5.0, height: 5.0, th: true, pins: [{ x: -1.27, y: 0, name: '1' }, { x: 1.27, y: 0, name: '2' }] },
            { name: '100\u03bcH TH 5mm', value: '100\u03bcH', width: 5.0, height: 5.0, th: true, pins: [{ x: -1.27, y: 0, name: '1' }, { x: 1.27, y: 0, name: '2' }] },
            // TH power inductor: 5mm body, 2.54mm lead pitch — standard for milling
            { name: 'TH 5mm', width: 5.0, height: 5.0, pins: [{ x: -1.27, y: 0, name: '1' }, { x: 1.27, y: 0, name: '2' }] },
            // SMD (largest to smallest)
            { name: '1206', width: 3.2, height: 1.6, pins: [{ x: -1.6, y: 0, name: '1' }, { x: 1.6, y: 0, name: '2' }] },
            { name: '0805', width: 2.0, height: 1.25, pins: [{ x: -1.0, y: 0, name: '1' }, { x: 1.0, y: 0, name: '2' }] },
            { name: '0603', width: 1.6, height: 0.8, pins: [{ x: -0.8, y: 0, name: '1' }, { x: 0.8, y: 0, name: '2' }] },
            { name: '0402', width: 1.0, height: 0.5, pins: [{ x: -0.5, y: 0, name: '1' }, { x: 0.5, y: 0, name: '2' }] }
        ], defaultSize: 0 },

        diode: { prefix: 'D', defaultValue: '1N4148', sizes: [
            { name: '1N4148 DO-35', value: '1N4148', width: 5.2, height: 2.0, th: true, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            { name: '1N4001 DO-41', value: '1N4001', width: 6.5, height: 2.6, th: true, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            { name: '1N4007 DO-41', value: '1N4007', width: 6.5, height: 2.6, th: true, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            { name: '1N5819 DO-41', value: '1N5819', width: 6.5, height: 2.6, th: true, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            { name: '1N5408 DO-201', value: '1N5408', width: 9.5, height: 5.3, th: true, pins: [{ x: -6.35, y: 0, name: 'A' }, { x: 6.35, y: 0, name: 'K' }] },
            { name: 'BAT54 SOD-323', value: 'BAT54', width: 1.7, height: 0.8, pins: [{ x: -0.85, y: 0, name: 'A' }, { x: 0.85, y: 0, name: 'K' }] },
            { name: 'SS14 SMA', value: 'SS14', width: 4.4, height: 2.3, pins: [{ x: -2.0, y: 0, name: 'A' }, { x: 2.0, y: 0, name: 'K' }] },
            { name: '1N4148 SOD-123', value: '1N4148', width: 2.9, height: 1.3, pins: [{ x: -1.45, y: 0, name: 'A' }, { x: 1.45, y: 0, name: 'K' }] },
            { name: 'BZX55C5V1 DO-35', value: 'BZX55C5V1', width: 5.2, height: 2.0, th: true, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            { name: 'UF4007 DO-41', value: 'UF4007', width: 6.5, height: 2.6, th: true, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            // DO-41 TH axial (1N400x): 6.5x2.6mm body, 7.62mm lead pitch — standard for milling
            { name: 'DO-41 (TH)', width: 6.5, height: 2.6, pins: [{ x: -3.81, y: 0, name: 'A' }, { x: 3.81, y: 0, name: 'K' }] },
            // SMB / DO-219AA: 4.6x2.6mm body, 4.5mm pad pitch
            { name: 'SMB (DO-219)', width: 4.6, height: 2.6, pins: [{ x: -2.25, y: 0, name: 'A' }, { x: 2.25, y: 0, name: 'K' }] },
            // SMA / DO-214AA: 4.4x2.3mm body, 4.0mm pad pitch
            { name: 'SMA (DO-214)', width: 4.4, height: 2.3, pins: [{ x: -2.0, y: 0, name: 'A' }, { x: 2.0, y: 0, name: 'K' }] },
            // SOD-123: 2.9x1.3mm (JEDEC)
            { name: 'SOD-123', width: 2.9, height: 1.3, pins: [{ x: -1.45, y: 0, name: 'A' }, { x: 1.45, y: 0, name: 'K' }] },
            // SOD-323: 1.7x0.8mm (JEDEC)
            { name: 'SOD-323', width: 1.7, height: 0.8, pins: [{ x: -0.85, y: 0, name: 'A' }, { x: 0.85, y: 0, name: 'K' }] }
        ], defaultSize: 0 },

        transistor: { prefix: 'Q', defaultValue: '2N2222', sizes: [
            Object.assign({ name: '2N2222 TO-92', value: '2N2222' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: '2N3904 TO-92', value: '2N3904' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'BC547 TO-92', value: 'BC547' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'MMBT2222 SOT-23', value: 'MMBT2222' }, _sot23([
                { x: -0.95, y: 0.65, name: 'B' }, { x: 0, y: -0.65, name: 'C' }, { x: 0.95, y: 0.65, name: 'E' }
            ])),
            Object.assign({ name: 'TIP120 TO-220', value: 'TIP120' }, _to220([
                { x: -2.54, y: 2.0, name: 'B' }, { x: 0, y: 2.0, name: 'C' }, { x: 2.54, y: 2.0, name: 'E' }
            ])),
            Object.assign({ name: 'BC337 TO-92', value: 'BC337' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: '2N4401 TO-92', value: '2N4401' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'S8050 TO-92', value: 'S8050' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'TIP31 TO-220', value: 'TIP31' }, _to220([
                { x: -2.54, y: 2.0, name: 'B' }, { x: 0, y: 2.0, name: 'C' }, { x: 2.54, y: 2.0, name: 'E' }
            ])),
            Object.assign({ name: 'MMBT3904 SOT-23', value: 'MMBT3904' }, _sot23([
                { x: -0.95, y: 0.65, name: 'B' }, { x: 0, y: -0.65, name: 'C' }, { x: 0.95, y: 0.65, name: 'E' }
            ]))
        ], defaultSize: 0 },

        pnp: { prefix: 'Q', defaultValue: '2N3906', sizes: [
            Object.assign({ name: '2N3906 TO-92', value: '2N3906' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: '2N2907 TO-92', value: '2N2907' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'BC557 TO-92', value: 'BC557' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'MMBT2907 SOT-23', value: 'MMBT2907' }, _sot23([
                { x: -0.95, y: 0.65, name: 'B' }, { x: 0, y: -0.65, name: 'C' }, { x: 0.95, y: 0.65, name: 'E' }
            ])),
            Object.assign({ name: 'BC327 TO-92', value: 'BC327' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: '2N4403 TO-92', value: '2N4403' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'S8550 TO-92', value: 'S8550' }, _to92([
                { x: 0, y: 1.27, name: 'B' }, { x: 1.27, y: 1.27, name: 'C' }, { x: -1.27, y: 1.27, name: 'E' }
            ])),
            Object.assign({ name: 'TIP32 TO-220', value: 'TIP32' }, _to220([
                { x: -2.54, y: 2.0, name: 'B' }, { x: 0, y: 2.0, name: 'C' }, { x: 2.54, y: 2.0, name: 'E' }
            ])),
            Object.assign({ name: 'MMBT3906 SOT-23', value: 'MMBT3906' }, _sot23([
                { x: -0.95, y: 0.65, name: 'B' }, { x: 0, y: -0.65, name: 'C' }, { x: 0.95, y: 0.65, name: 'E' }
            ]))
        ], defaultSize: 0 },

        mosfet: { prefix: 'Q', defaultValue: '2N7000', sizes: [
            Object.assign({ name: '2N7000 N-ch TO-92', value: '2N7000', channel: 'n' }, _to92([
                { x: 0, y: 1.27, name: 'G' }, { x: 1.27, y: 1.27, name: 'D' }, { x: -1.27, y: 1.27, name: 'S' }
            ])),
            Object.assign({ name: '2N7002 N-ch SOT-23', value: '2N7002', channel: 'n' }, _sot23([
                { x: -0.95, y: 0.65, name: 'G' }, { x: 0, y: -0.65, name: 'D' }, { x: 0.95, y: 0.65, name: 'S' }
            ])),
            Object.assign({ name: 'AO3400 N-ch SOT-23', value: 'AO3400', channel: 'n' }, _sot23([
                { x: -0.95, y: 0.65, name: 'G' }, { x: 0, y: -0.65, name: 'D' }, { x: 0.95, y: 0.65, name: 'S' }
            ])),
            Object.assign({ name: 'IRLZ44N N-ch TO-220', value: 'IRLZ44N', channel: 'n' }, _to220([
                { x: -2.54, y: 2.0, name: 'G' }, { x: 0, y: 2.0, name: 'D' }, { x: 2.54, y: 2.0, name: 'S' }
            ])),
            Object.assign({ name: 'IRF540 N-ch TO-220', value: 'IRF540', channel: 'n' }, _to220([
                { x: -2.54, y: 2.0, name: 'G' }, { x: 0, y: 2.0, name: 'D' }, { x: 2.54, y: 2.0, name: 'S' }
            ])),
            Object.assign({ name: 'AO3401 P-ch SOT-23', value: 'AO3401', channel: 'p' }, _sot23([
                { x: -0.95, y: 0.65, name: 'G' }, { x: 0, y: -0.65, name: 'D' }, { x: 0.95, y: 0.65, name: 'S' }
            ])),
            Object.assign({ name: 'IRF9540 P-ch TO-220', value: 'IRF9540', channel: 'p' }, _to220([
                { x: -2.54, y: 2.0, name: 'G' }, { x: 0, y: 2.0, name: 'D' }, { x: 2.54, y: 2.0, name: 'S' }
            ]))
        ], defaultSize: 0 },

        ldo: { prefix: 'U', defaultValue: 'AMS1117-3.3', sizes: [
            { name: 'AMS1117 SOT-223', value: 'AMS1117-3.3', width: 6.5, height: 3.5, pins: [
                { x: -2.3, y: 1.15, name: 'GND' }, { x: 0, y: 1.15, name: 'VOUT' }, { x: 2.3, y: 1.15, name: 'VIN' }
            ]},
            { name: 'LM1117 SOT-223', value: 'LM1117-3.3', width: 6.5, height: 3.5, pins: [
                { x: -2.3, y: 1.15, name: 'GND' }, { x: 0, y: 1.15, name: 'VOUT' }, { x: 2.3, y: 1.15, name: 'VIN' }
            ]},
            { name: 'LM7805 TO-220', value: 'LM7805', width: 10.0, height: 4.5, th: true, pins: [
                { x: -2.54, y: 2.0, name: 'VIN' }, { x: 0, y: 2.0, name: 'GND' }, { x: 2.54, y: 2.0, name: 'VOUT' }
            ]},
            { name: 'LM7812 TO-220', value: 'LM7812', width: 10.0, height: 4.5, th: true, pins: [
                { x: -2.54, y: 2.0, name: 'VIN' }, { x: 0, y: 2.0, name: 'GND' }, { x: 2.54, y: 2.0, name: 'VOUT' }
            ]},
            { name: 'LM317 TO-220', value: 'LM317', width: 10.0, height: 4.5, th: true, pins: [
                { x: -2.54, y: 2.0, name: 'ADJ' }, { x: 0, y: 2.0, name: 'VOUT' }, { x: 2.54, y: 2.0, name: 'VIN' }
            ]},
            { name: 'MCP1700 TO-92', value: 'MCP1700-3.3', width: 4.5, height: 4.5, th: true, pins: [
                { x: -1.27, y: 1.27, name: 'VIN' }, { x: 0, y: 1.27, name: 'GND' }, { x: 1.27, y: 1.27, name: 'VOUT' }
            ]},
            { name: 'HT7333 SOT-23', value: 'HT7333', width: 2.9, height: 1.3, pins: [
                { x: -0.95, y: 0.65, name: 'GND' }, { x: 0.95, y: 0.65, name: 'VIN' }, { x: 0, y: -0.65, name: 'VOUT' }
            ]}
        ], defaultSize: 0 },

        gnd: { prefix: '', defaultValue: 'GND', sizes: [
            { name: 'TP 2.5mm', width: 3.0, height: 3.0, pins: [{ x: 0, y: 0, name: 'GND' }] },
            // Through-hole test point: solder a wire/lead (pad Ø2mm, drill 0.8mm)
            { name: 'TH TP', th: true, width: 3.0, height: 3.0, pins: [{ x: 0, y: 0, name: 'GND' }] },
            // Big through-hole test point for easy soldering (pad Ø4mm, drill 1.2mm)
            { name: 'TH TP XL', th: true, width: 6.0, height: 6.0, padR: 2.0, drillDia: 1.2, pins: [{ x: 0, y: 0, name: 'GND' }] }
        ], defaultSize: 0 },

        power: { prefix: '', defaultValue: 'VCC', sizes: [
            { name: 'TP 2.5mm', width: 3.0, height: 3.0, pins: [{ x: 0, y: 0, name: 'VCC' }] },
            // Through-hole test point: solder a wire/lead (pad Ø2mm, drill 0.8mm)
            { name: 'TH TP', th: true, width: 3.0, height: 3.0, pins: [{ x: 0, y: 0, name: 'VCC' }] },
            // Big through-hole test point for easy soldering (pad Ø4mm, drill 1.2mm)
            { name: 'TH TP XL', th: true, width: 6.0, height: 6.0, padR: 2.0, drillDia: 1.2, pins: [{ x: 0, y: 0, name: 'VCC' }] }
        ], defaultSize: 0 },

        nc: { prefix: 'X', defaultValue: 'NC', sizes: [
            { name: 'Pad 1.6mm', width: 2.0, height: 2.0, pins: [{ x: 0, y: 0, name: 'X' }] }
        ], defaultSize: 0 },

        switch: { prefix: 'SW', defaultValue: 'SW-SPST', sizes: [
            { name: 'SPST 6mm', width: 6.0, height: 5.0, th: true, pins: [{ x: -1.27, y: 0, name: '1' }, { x: 1.27, y: 0, name: '2' }] },
            // 6mm tact: four leads on a 6.5 x 4.5mm rectangle. The two pins of
            // each number are the same contact (standard push-button footprint).
            { name: 'Tact 6mm', width: 6.0, height: 6.0, th: true, push: true, pins: [
                { x: -3.25, y: -2.25, name: '1' }, { x: 3.25, y: -2.25, name: '1' },
                { x: -3.25, y: 2.25, name: '2' }, { x: 3.25, y: 2.25, name: '2' }
            ]}
        ], defaultSize: 0 },

        fuse: { prefix: 'F', defaultValue: '500mA', sizes: [
            _smd2('0603', 1.6, 0.8),
            _smd2('0805', 2.0, 1.25),
            _smd2('1206', 3.2, 1.6),
            { name: 'TH 5x20', width: 20.0, height: 5.2, th: true, pins: [{ x: -10.0, y: 0, name: '1' }, { x: 10.0, y: 0, name: '2' }] }
        ], defaultSize: 1 },

        crystal: { prefix: 'Y', defaultValue: '16MHz', sizes: [
            { name: 'HC-49S', width: 11.0, height: 4.5, th: true, pins: [{ x: -2.54, y: 0, name: '1' }, { x: 2.54, y: 0, name: '2' }] },
            { name: 'SMD 3.2x2.5', width: 3.2, height: 2.5, pins: [{ x: -1.1, y: 0, name: '1' }, { x: 1.1, y: 0, name: '2' }] },
            { name: 'SMD 5x3.2', width: 5.0, height: 3.2, pins: [{ x: -1.7, y: 0, name: '1' }, { x: 1.7, y: 0, name: '2' }] }
        ], defaultSize: 0 },

        arduino_uno: { prefix: 'U', module: true, defaultValue: 'Arduino Uno R3', sizes: [
            // Arduino Uno R3 module ~68.6 x 53.3mm. Digital on top, analog on bottom, power on left.
            { name: 'Uno R3', width: 68, height: 53, th: true, pins: [
                { x: -30, y: -26.5, name: 'D13' }, { x: -24.55, y: -26.5, name: 'D12' }, { x: -19.09, y: -26.5, name: 'D11' },
                { x: -13.64, y: -26.5, name: 'D10' }, { x: -8.18, y: -26.5, name: 'D9' }, { x: -2.73, y: -26.5, name: 'D8' },
                { x: 2.73, y: -26.5, name: 'D7' }, { x: 8.18, y: -26.5, name: 'D6' }, { x: 13.64, y: -26.5, name: 'D5' },
                { x: 19.09, y: -26.5, name: 'D4' }, { x: 24.55, y: -26.5, name: 'D3' }, { x: 30, y: -26.5, name: 'D2' },
                { x: -25, y: 26.5, name: 'A0' }, { x: -15, y: 26.5, name: 'A1' }, { x: -5, y: 26.5, name: 'A2' },
                { x: 5, y: 26.5, name: 'A3' }, { x: 15, y: 26.5, name: 'A4' }, { x: 25, y: 26.5, name: 'A5' },
                { x: -34, y: -19.5, name: 'VIN' }, { x: -34, y: -6.5, name: '5V' }, { x: -34, y: 6.5, name: '3V3' }, { x: -34, y: 19.5, name: 'GND' }
            ]}
        ], defaultSize: 0 },

        arduino_nano: { prefix: 'U', module: true, defaultValue: 'Arduino Nano', sizes: [
            // Arduino Nano ~43 x 18mm. Two rows of 15 pins (2.54mm pitch).
            { name: 'Nano', width: 43, height: 18, th: true, pins: (() => {
                const top = ['D13', 'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'RST', 'D0'];
                const bot = ['A6', 'A7', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'AREF', 'GND', 'GND', 'VIN', 'GND', '5V', '3V3'];
                const pins = [];
                const span = 35.56, x0 = -span / 2, step = span / 14;
                top.forEach((name, i) => pins.push({ x: x0 + i * step, y: -9, name }));
                bot.forEach((name, i) => pins.push({ x: x0 + i * step, y: 9, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        esp32_devkit: { prefix: 'U', module: true, defaultValue: 'ESP32 DevKitC', sizes: [
            // ESP32 DevKitC ~38 x 55mm. Two rows of 15 pins (DevKitC V4 pinout).
            { name: 'DevKitC', width: 38, height: 55, th: true, pins: (() => {
                const left = ['3V3', 'EN', 'GPIO36', 'GPIO39', 'GPIO34', 'GPIO35', 'GPIO32', 'GPIO33', 'GPIO25', 'GPIO26', 'GPIO27', 'GPIO14', 'GPIO12', 'GND', 'GPIO13'];
                const right = ['GND', 'GPIO23', 'GPIO22', 'TX0', 'RX0', 'GPIO21', 'GND', 'GPIO19', 'GPIO18', 'GPIO5', 'GPIO17', 'GPIO16', 'GPIO4', 'GPIO0', 'GPIO2'];
                const pins = [];
                const y0 = -24.5, step = 3.5;
                left.forEach((name, i) => pins.push({ x: -19, y: y0 + i * step, name }));
                right.forEach((name, i) => pins.push({ x: 19, y: y0 + i * step, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        esp32s3_devkit: { prefix: 'U', module: true, defaultValue: 'ESP32-S3-DevKitC', sizes: [
            { name: 'S3-DevKitC', width: 28, height: 55, th: true, pins: (() => {
                const left = ['3V3','3V3','RST','IO4','IO5','IO6','IO7','IO15','IO16','IO17','IO18','IO8','IO3','IO46','IO9','IO10','IO11','IO12','IO13','IO14','5V','GND'];
                const right = ['GND','TX','RX','IO1','IO2','IO42','IO41','IO40','IO39','IO38','IO37','IO36','IO35','IO0','IO45','IO48','IO47','IO21','IO20','IO19','GND','GND'];
                const pins = [];
                const y0 = -26.67, step = 2.54;
                left.forEach((name, i) => pins.push({ x: -11.43, y: y0 + i * step, name }));
                right.forEach((name, i) => pins.push({ x: 11.43, y: y0 + i * step, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        esp32s2_mini: { prefix: 'U', module: true, defaultValue: 'ESP32-S2 mini', sizes: [
            // Lolin S2 mini: D1-mini outer row + inner GPIO row (USB at negative Y).
            { name: 'S2 mini', width: 25.4, height: 34.3, th: true, pins: (() => {
                const y0 = -8.89, step = 2.54;
                const pins = [];
                const Lout = ['RST','IO3','IO5','IO7','IO9','IO11','IO13','3V3'];
                const Lin  = ['IO1','IO2','IO4','IO6','IO8','IO10','IO12','IO14'];
                const Rout = ['5V','GND','IO16','IO18','IO33','IO35','RX','TX'];
                const Rin  = ['IO40','IO39','IO38','IO37','IO36','IO34','IO21','IO17'];
                Lout.forEach((name, i) => pins.push({ x: -11.43, y: y0 + i * step, name }));
                Rout.forEach((name, i) => pins.push({ x:  11.43, y: y0 + i * step, name }));
                Lin.forEach((name, i) => pins.push({ x: -8.89, y: y0 + i * step, name }));
                Rin.forEach((name, i) => pins.push({ x:   8.89, y: y0 + i * step, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        esp32s3_nano: { prefix: 'U', module: true, defaultValue: 'ESP32-S3 Nano', sizes: [
            { name: 'S3 Nano', width: 43, height: 18, th: true, pins: (() => {
                const top = ['D13','D12','D11','D10','D9','D8','D7','D6','D5','D4','D3','D2','GND','RST','D0'];
                const bot = ['A6','A7','A5','A4','A3','A2','A1','A0','B0','GND','GND','VIN','GND','5V','3V3'];
                const pins = [];
                const span = 35.56, x0 = -span / 2, step = span / 14;
                top.forEach((name, i) => pins.push({ x: x0 + i * step, y: -9, name }));
                bot.forEach((name, i) => pins.push({ x: x0 + i * step, y: 9, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        esp8266_nodemcu: { prefix: 'U', module: true, defaultValue: 'Wemos D1 mini', sizes: [
            { name: 'D1 mini', width: 26, height: 35, th: true, pins: (() => {
                const left = ['RST', 'A0', 'D0', 'D5', 'D6', 'D7', 'D8', '3V3'];
                const right = ['5V', 'GND', 'D4', 'D3', 'D2', 'D1', 'RX', 'TX'];
                const pins = [];
                left.forEach((name, i) => pins.push({ x: -11.43, y: -8.89 + i * 2.54, name }));
                right.forEach((name, i) => pins.push({ x: 11.43, y: -8.89 + i * 2.54, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        rpi_pico: { prefix: 'U', module: true, defaultValue: 'Raspberry Pi Pico', sizes: [
            { name: 'Pico THT', width: 21, height: 51, th: true, pins: (() => {
                const left = ['GP0','GP1','GND','GP2','GP3','GP4','GP5','GND','GP6','GP7','GP8','GP9','GND','GP10','GP11','GP12','GP13','GND','GP14','GP15'];
                const right = ['VBUS','VSYS','GND','3V3_EN','3V3','ADC_REF','GP28','GND','GP27','GP26','RUN','GP22','GND','GP21','GP20','GP19','GP18','GND','GP17','GP16'];
                const pins = [];
                left.forEach((name, i) => pins.push({ x: -8.89, y: -24.13 + i * 2.54, name }));
                right.forEach((name, i) => pins.push({ x: 8.89, y: -24.13 + i * 2.54, name }));
                return pins;
            })() }
        ], defaultSize: 0 },

        jumper: { prefix: 'JP', defaultValue: '', sizes: [
            { name: '0Ω 0805', width: 1.27, height: 1.27, pins: [{ x: -0.635, y: 0, name: '1' }, { x: 0.635, y: 0, name: '2' }], jkind: 'smd', value: '0Ω' },
            { name: '0Ω 1206', width: 1.98, height: 1.98, pins: [{ x: -0.99, y: 0, name: '1' }, { x: 0.99, y: 0, name: '2' }], jkind: 'smd', value: '0Ω' },
            { name: 'Wire', width: 2, height: 2, th: true, pins: [{ x: -5, y: 0, name: '1' }, { x: 5, y: 0, name: '2' }], jkind: 'wire', value: 'wire' }
        ], defaultSize: 0 }
    },
    get(type) { return this.defs[type] || null; },
    isModule(type) { return !!(this.defs[type] && this.defs[type].module); },
    makeHeader(rows, cols, pitch, kind) { return _hdr(rows, cols, pitch, kind); },
    ensureHeaderSize(rows, cols, pitch, kind) {
        const sz = _hdr(rows, cols, pitch, kind);
        const def = this.defs.connector;
        if (!def) return 0;
        let i = def.sizes.findIndex(s => s.name === sz.name);
        if (i < 0) { def.sizes.push(sz); i = def.sizes.length - 1; }
        return i;
    },
    makeDipSwitch(positions) { return _dipsw(positions); },
    ensureDipSwitch(positions) {
        const sz = _dipsw(positions);
        const def = this.defs.switch;
        if (!def) return 0;
        let i = def.sizes.findIndex(s => s.name === sz.name);
        if (i < 0) { def.sizes.push(sz); i = def.sizes.length - 1; }
        return i;
    },
    getSize(def, sizeIdx) {
        if (!def || !def.sizes) return null;
        const idx = (sizeIdx !== undefined && sizeIdx >= 0 && sizeIdx < def.sizes.length) ? sizeIdx : def.defaultSize;
        return def.sizes[idx];
    }
};
Object.keys(ComponentDefs.defs).forEach(function (k) {
    if (ComponentDefs.defs[k] && !ComponentDefs.defs[k].key) ComponentDefs.defs[k].key = k;
});
