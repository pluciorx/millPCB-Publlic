// ============================================================
// KiCad Footprint Library Loader
// Loads .kicad_mod files from /libs/ and merges them into the
// existing ComponentDefs categories, replacing hardcoded sizes
// with accurate dimensions from official KiCad footprints.
//
// Requires: kicad-import.js (provides _parseFootprint)
// ============================================================

function _lib(file, cat, label, extra) {
    return Object.assign({ file: file, cat: cat, label: label }, extra || {});
}
const _R0805 = 'libs/resistors/R_0805_2012Metric.kicad_mod';
const _C0805 = 'libs/capacitors/C_0805_2012Metric.kicad_mod';
const _LED5 = 'libs/leds/LED_D5.0mm.kicad_mod';
const _LED3 = 'libs/leds/LED_D3.0mm.kicad_mod';
const _AK = { pinNames: { 1: 'A', 2: 'K' } };
const _TO92 = { pinNames: { 1: 'E', 2: 'B', 3: 'C' } };
const _SOT23NPN = { pinNames: { 1: 'B', 2: 'E', 3: 'C' } };
const _TO220NPN = { pinNames: { 1: 'B', 2: 'C', 3: 'E' } };
const _TO220MOS = { pinNames: { 1: 'G', 2: 'D', 3: 'S' } };

const LibsLoader = {
    manifest: [
        // Resistors â€” 10 common values on KiCad 0805, plus packages
        _lib(_R0805, 'resistor', '10\u03a9 0805', { value: '10\u03a9' }),
        _lib(_R0805, 'resistor', '100\u03a9 0805', { value: '100\u03a9' }),
        _lib(_R0805, 'resistor', '220\u03a9 0805', { value: '220\u03a9' }),
        _lib(_R0805, 'resistor', '330\u03a9 0805', { value: '330\u03a9' }),
        _lib(_R0805, 'resistor', '1k\u03a9 0805', { value: '1k\u03a9' }),
        _lib(_R0805, 'resistor', '4.7k\u03a9 0805', { value: '4.7k\u03a9' }),
        _lib(_R0805, 'resistor', '10k\u03a9 0805', { value: '10k\u03a9' }),
        _lib(_R0805, 'resistor', '22k\u03a9 0805', { value: '22k\u03a9' }),
        _lib(_R0805, 'resistor', '100k\u03a9 0805', { value: '100k\u03a9' }),
        _lib(_R0805, 'resistor', '1M\u03a9 0805', { value: '1M\u03a9' }),
        { file: 'libs/resistors/R_0402_1005Metric.kicad_mod', cat: 'resistor', label: '0402' },
        { file: 'libs/resistors/R_0603_1608Metric.kicad_mod', cat: 'resistor', label: '0603' },
        { file: 'libs/resistors/R_0805_2012Metric.kicad_mod', cat: 'resistor', label: '0805' },
        { file: 'libs/resistors/R_1206_3216Metric.kicad_mod', cat: 'resistor', label: '1206' },
        { file: 'libs/resistors/R_1210_3225Metric.kicad_mod', cat: 'resistor', label: '1210' },
        { file: 'libs/resistors/R_Axial_DIN0204_L3.6mm_D1.6mm_P5.08mm_Horizontal.kicad_mod', cat: 'resistor', label: 'TH 1/4W' },
        // Capacitors â€” 10 common values on KiCad footprints
        _lib(_C0805, 'capacitor', '22pF 0805', { value: '22pF' }),
        _lib(_C0805, 'capacitor', '100pF 0805', { value: '100pF' }),
        _lib(_C0805, 'capacitor', '1nF 0805', { value: '1nF' }),
        _lib(_C0805, 'capacitor', '10nF 0805', { value: '10nF' }),
        _lib(_C0805, 'capacitor', '100nF 0805', { value: '100nF' }),
        _lib(_C0805, 'capacitor', '1\u00b5F 0805', { value: '1\u00b5F' }),
        _lib(_C0805, 'capacitor', '10\u00b5F 0805', { value: '10\u00b5F' }),
        _lib('libs/capacitors/CP_Radial_D5.0mm_P2.50mm.kicad_mod', 'capacitor', '10\u00b5F Electrolytic 5mm', { value: '10\u00b5F' }),
        _lib('libs/capacitors/CP_Radial_D8.0mm_P3.50mm.kicad_mod', 'capacitor', '100\u00b5F Electrolytic 8mm', { value: '100\u00b5F' }),
        _lib('libs/capacitors/CP_Radial_D8.0mm_P3.50mm.kicad_mod', 'capacitor', '470\u00b5F Electrolytic 8mm', { value: '470\u00b5F' }),
        { file: 'libs/capacitors/C_0402_1005Metric.kicad_mod', cat: 'capacitor', label: '0402' },
        { file: 'libs/capacitors/C_0603_1608Metric.kicad_mod', cat: 'capacitor', label: '0603' },
        { file: 'libs/capacitors/C_0805_2012Metric.kicad_mod', cat: 'capacitor', label: '0805' },
        { file: 'libs/capacitors/C_1206_3216Metric.kicad_mod', cat: 'capacitor', label: '1206' },
        { file: 'libs/capacitors/CP_Radial_D5.0mm_P2.50mm.kicad_mod', cat: 'capacitor', label: 'TH Electrolytic 5mm' },
        { file: 'libs/capacitors/CP_Radial_D8.0mm_P3.50mm.kicad_mod', cat: 'capacitor', label: 'TH Electrolytic 8mm' },
        // ICs â€” KiCad DIP/SOIC + pin names from KiCad Device/74xx/Timer/ATmega symbols
        _lib('libs/ics/DIP-8_W7.62mm.kicad_mod', 'ic', 'NE555 DIP-8', { value: 'NE555', pinNames: { 1: 'GND', 2: 'TRIG', 3: 'OUT', 4: 'RST', 5: 'CV', 6: 'THR', 7: 'DIS', 8: 'VCC' } }),
        _lib('libs/ics/DIP-8_W7.62mm.kicad_mod', 'ic', 'LM358 DIP-8', { value: 'LM358', pinNames: { 1: 'OUTA', 2: 'INA-', 3: 'INA+', 4: 'GND', 5: 'INB+', 6: 'INB-', 7: 'OUTB', 8: 'VCC' } }),
        _lib('libs/ics/DIP-14_W7.62mm.kicad_mod', 'ic', 'LM324 DIP-14', { value: 'LM324', pinNames: { 1: 'OUT1', 2: 'IN1-', 3: 'IN1+', 4: 'VCC', 5: 'IN2+', 6: 'IN2-', 7: 'OUT2', 8: 'OUT3', 9: 'IN3-', 10: 'IN3+', 11: 'GND', 12: 'IN4+', 13: 'IN4-', 14: 'OUT4' } }),
        _lib('libs/ics/DIP-14_W7.62mm.kicad_mod', 'ic', '74HC00 DIP-14', { value: '74HC00', pinNames: { 1: '1A', 2: '1B', 3: '1Y', 4: '2A', 5: '2B', 6: '2Y', 7: 'GND', 8: '3Y', 9: '3A', 10: '3B', 11: '4Y', 12: '4A', 13: '4B', 14: 'VCC' } }),
        _lib('libs/ics/DIP-14_W7.62mm.kicad_mod', 'ic', '74HC14 DIP-14', { value: '74HC14', pinNames: { 1: '1A', 2: '1Y', 3: '2A', 4: '2Y', 5: '3A', 6: '3Y', 7: 'GND', 8: '4Y', 9: '4A', 10: '5Y', 11: '5A', 12: '6Y', 13: '6A', 14: 'VCC' } }),
        _lib('libs/ics/DIP-16_W7.62mm.kicad_mod', 'ic', '74HC595 DIP-16', { value: '74HC595', pinNames: { 1: 'QB', 2: 'QC', 3: 'QD', 4: 'QE', 5: 'QF', 6: 'QG', 7: 'QH', 8: 'GND', 9: 'QH\'', 10: 'SRCLR', 11: 'SRCLK', 12: 'RCLK', 13: 'OE', 14: 'SER', 15: 'QA', 16: 'VCC' } }),
        _lib('libs/ics/DIP-18_W7.62mm.kicad_mod', 'ic', 'ULN2803 DIP-18', { value: 'ULN2803A', pinNames: { 1: 'IN1', 2: 'IN2', 3: 'IN3', 4: 'IN4', 5: 'IN5', 6: 'IN6', 7: 'IN7', 8: 'IN8', 9: 'GND', 10: 'COM', 11: 'OUT8', 12: 'OUT7', 13: 'OUT6', 14: 'OUT5', 15: 'OUT4', 16: 'OUT3', 17: 'OUT2', 18: 'OUT1' } }),
        _lib('libs/ics/DIP-28_W7.62mm.kicad_mod', 'ic', 'ATmega328P DIP-28', { value: 'ATmega328P', pinNames: { 1: 'RST', 2: 'RX', 3: 'TX', 4: 'D2', 5: 'D3', 6: 'D4', 7: 'VCC', 8: 'GND', 9: 'XTAL1', 10: 'XTAL2', 11: 'D5', 12: 'D6', 13: 'D7', 14: 'D8', 15: 'D9', 16: 'D10', 17: 'D11', 18: 'D12', 19: 'D13', 20: 'AVCC', 21: 'AREF', 22: 'GND', 23: 'A0', 24: 'A1', 25: 'A2', 26: 'A3', 27: 'A4', 28: 'A5' } }),
        _lib('libs/ics/SOIC-16_3.9x9.9mm_P1.27mm.kicad_mod', 'ic', 'CH340C SOIC-16', { value: 'CH340C', pinNames: { 1: 'VCC', 2: 'UD+', 3: 'UD-', 4: 'GND', 5: 'XI', 6: 'XO', 7: 'RTS', 8: 'DTR', 9: 'DCD', 10: 'RI', 11: 'DSR', 12: 'CTS', 13: 'TXD', 14: 'RXD', 15: 'R232', 16: 'V3' } }),
        _lib('libs/ics/DIP-8_W7.62mm.kicad_mod', 'ic', '24LC256 DIP-8', { value: '24LC256', pinNames: { 1: 'A0', 2: 'A1', 3: 'A2', 4: 'GND', 5: 'SDA', 6: 'SCL', 7: 'WP', 8: 'VCC' } }),
        { file: 'libs/ics/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod', cat: 'ic', label: 'SOIC-8' },
        { file: 'libs/ics/SOIC-16_3.9x9.9mm_P1.27mm.kicad_mod', cat: 'ic', label: 'SOIC-16' },
        { file: 'libs/ics/DIP-8_W7.62mm.kicad_mod', cat: 'ic', label: 'DIP-8' },
        { file: 'libs/ics/DIP-14_W7.62mm.kicad_mod', cat: 'ic', label: 'DIP-14' },
        // Transistors (NPN) â€” KiCad TO-92 / SOT-23 / TO-220
        _lib('libs/transistors/TO-92.kicad_mod', 'transistor', '2N2222 TO-92', Object.assign({ value: '2N2222' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'transistor', '2N3904 TO-92', Object.assign({ value: '2N3904' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'transistor', 'BC547 TO-92', Object.assign({ value: 'BC547' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'transistor', 'BC337 TO-92', Object.assign({ value: 'BC337' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'transistor', '2N4401 TO-92', Object.assign({ value: '2N4401' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'transistor', 'S8050 TO-92', Object.assign({ value: 'S8050' }, _TO92)),
        _lib('libs/transistors/SOT-23.kicad_mod', 'transistor', 'MMBT2222 SOT-23', Object.assign({ value: 'MMBT2222' }, _SOT23NPN)),
        _lib('libs/transistors/SOT-23.kicad_mod', 'transistor', 'MMBT3904 SOT-23', Object.assign({ value: 'MMBT3904' }, _SOT23NPN)),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'transistor', 'TIP120 TO-220', Object.assign({ value: 'TIP120' }, _TO220NPN)),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'transistor', 'TIP31 TO-220', Object.assign({ value: 'TIP31' }, _TO220NPN)),
        // PNP
        _lib('libs/transistors/TO-92.kicad_mod', 'pnp', '2N3906 TO-92', Object.assign({ value: '2N3906' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'pnp', '2N2907 TO-92', Object.assign({ value: '2N2907' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'pnp', 'BC557 TO-92', Object.assign({ value: 'BC557' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'pnp', 'BC327 TO-92', Object.assign({ value: 'BC327' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'pnp', '2N4403 TO-92', Object.assign({ value: '2N4403' }, _TO92)),
        _lib('libs/transistors/TO-92.kicad_mod', 'pnp', 'S8550 TO-92', Object.assign({ value: 'S8550' }, _TO92)),
        _lib('libs/transistors/SOT-23.kicad_mod', 'pnp', 'MMBT2907 SOT-23', Object.assign({ value: 'MMBT2907' }, _SOT23NPN)),
        _lib('libs/transistors/SOT-23.kicad_mod', 'pnp', 'MMBT3906 SOT-23', Object.assign({ value: 'MMBT3906' }, _SOT23NPN)),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'pnp', 'TIP32 TO-220', Object.assign({ value: 'TIP32' }, _TO220NPN)),
        // MOSFETs
        _lib('libs/transistors/TO-92.kicad_mod', 'mosfet', '2N7000 N-ch TO-92', { value: '2N7000', pinNames: { 1: 'S', 2: 'G', 3: 'D' } }),
        _lib('libs/transistors/SOT-23.kicad_mod', 'mosfet', '2N7002 N-ch SOT-23', { value: '2N7002', pinNames: { 1: 'G', 2: 'S', 3: 'D' } }),
        _lib('libs/transistors/SOT-23.kicad_mod', 'mosfet', 'AO3400 N-ch SOT-23', { value: 'AO3400', pinNames: { 1: 'G', 2: 'S', 3: 'D' } }),
        _lib('libs/transistors/SOT-23.kicad_mod', 'mosfet', 'AO3401 P-ch SOT-23', { value: 'AO3401', pinNames: { 1: 'G', 2: 'S', 3: 'D' } }),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'mosfet', 'IRLZ44N N-ch TO-220', Object.assign({ value: 'IRLZ44N' }, _TO220MOS)),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'mosfet', 'IRF540 N-ch TO-220', Object.assign({ value: 'IRF540' }, _TO220MOS)),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'mosfet', 'IRF9540 P-ch TO-220', Object.assign({ value: 'IRF9540' }, _TO220MOS)),
        // LDOs
        _lib('libs/ics/SOT-223-3_TabPin2.kicad_mod', 'ldo', 'AMS1117 SOT-223', { value: 'AMS1117-3.3', pinNames: { 1: 'GND', 2: 'VOUT', 3: 'VIN' } }),
        _lib('libs/ics/SOT-223-3_TabPin2.kicad_mod', 'ldo', 'LM1117 SOT-223', { value: 'LM1117-3.3', pinNames: { 1: 'GND', 2: 'VOUT', 3: 'VIN' } }),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'ldo', 'LM7805 TO-220', { value: 'LM7805', pinNames: { 1: 'VIN', 2: 'GND', 3: 'VOUT' } }),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'ldo', 'LM7812 TO-220', { value: 'LM7812', pinNames: { 1: 'VIN', 2: 'GND', 3: 'VOUT' } }),
        _lib('libs/transistors/TO-220-3_Horizontal_TabDown.kicad_mod', 'ldo', 'LM317 TO-220', { value: 'LM317', pinNames: { 1: 'ADJ', 2: 'VOUT', 3: 'VIN' } }),
        _lib('libs/transistors/TO-92.kicad_mod', 'ldo', 'MCP1700 TO-92', { value: 'MCP1700-3.3', pinNames: { 1: 'VIN', 2: 'GND', 3: 'VOUT' } }),
        _lib('libs/transistors/SOT-23.kicad_mod', 'ldo', 'HT7333 SOT-23', { value: 'HT7333', pinNames: { 1: 'GND', 2: 'VIN', 3: 'VOUT' } }),
        // Diodes
        _lib('libs/diodes/D_DO-35_SOD27_P7.62mm_Horizontal.kicad_mod', 'diode', '1N4148 DO-35', Object.assign({ value: '1N4148' }, _AK)),
        _lib('libs/diodes/D_DO-41_SOD81_P7.62mm_Horizontal.kicad_mod', 'diode', '1N4001 DO-41', Object.assign({ value: '1N4001' }, _AK)),
        _lib('libs/diodes/D_DO-41_SOD81_P7.62mm_Horizontal.kicad_mod', 'diode', '1N4007 DO-41', Object.assign({ value: '1N4007' }, _AK)),
        _lib('libs/diodes/D_DO-41_SOD81_P7.62mm_Horizontal.kicad_mod', 'diode', '1N5819 DO-41', Object.assign({ value: '1N5819' }, _AK)),
        _lib('libs/diodes/D_DO-201_P12.70mm_Horizontal.kicad_mod', 'diode', '1N5408 DO-201', Object.assign({ value: '1N5408' }, _AK)),
        _lib('libs/diodes/D_SOD-323.kicad_mod', 'diode', 'BAT54 SOD-323', Object.assign({ value: 'BAT54' }, _AK)),
        _lib('libs/diodes/D_SMA.kicad_mod', 'diode', 'SS14 SMA', Object.assign({ value: 'SS14' }, _AK)),
        _lib('libs/diodes/D_SOD-123.kicad_mod', 'diode', '1N4148 SOD-123', Object.assign({ value: '1N4148' }, _AK)),
        _lib('libs/diodes/D_DO-35_SOD27_P7.62mm_Horizontal.kicad_mod', 'diode', 'BZX55C5V1 DO-35', Object.assign({ value: 'BZX55C5V1' }, _AK)),
        _lib('libs/diodes/D_DO-41_SOD81_P7.62mm_Horizontal.kicad_mod', 'diode', 'UF4007 DO-41', Object.assign({ value: 'UF4007' }, _AK)),
        { file: 'libs/diodes/D_SOD-323.kicad_mod', cat: 'diode', label: 'SOD-323', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/diodes/D_SOD-123.kicad_mod', cat: 'diode', label: 'SOD-123', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/diodes/D_SMA.kicad_mod', cat: 'diode', label: 'SMA (DO-214)', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/diodes/D_SMB.kicad_mod', cat: 'diode', label: 'SMB (DO-219)', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/diodes/D_DO-41_SOD81_P7.62mm_Horizontal.kicad_mod', cat: 'diode', label: 'DO-41 (TH)', pinNames: { 1: 'A', 2: 'K' } },
        // Connectors
        { file: 'libs/connectors/USB_C_Receptacle_GCT_USB4085.kicad_mod', cat: 'connector', label: 'USB-C' },
        { file: 'libs/connectors/BarrelJack.kicad_mod', cat: 'connector', label: 'Barrel jack', pinNames: { 1: 'TIP', 2: 'SLEEVE', 3: 'SW' } },
        { file: 'libs/connectors/PinHeader_2x03_P2.54mm_Vertical.kicad_mod', cat: 'connector', label: '2\u00d73 2.54mm' },
        { file: 'libs/connectors/PinHeader_2x04_P2.54mm_Vertical.kicad_mod', cat: 'connector', label: '2\u00d74 2.54mm' },
        { file: 'libs/connectors/PinHeader_2x05_P2.54mm_Vertical.kicad_mod', cat: 'connector', label: '2\u00d75 2.54mm' },
        // Inductors
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '1\u03bcH 0805', { value: '1\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '2.2\u03bcH 0805', { value: '2.2\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '4.7\u03bcH 0805', { value: '4.7\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '10\u03bcH 0805', { value: '10\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '22\u03bcH 0805', { value: '22\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '47\u03bcH 0805', { value: '47\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '100\u03bcH 0805', { value: '100\u03bcH' }),
        _lib('libs/inductors/L_0805_2012Metric.kicad_mod', 'inductor', '220\u03bcH 0805', { value: '220\u03bcH' }),
        { file: 'libs/inductors/L_0402_1005Metric.kicad_mod', cat: 'inductor', label: '0402' },
        { file: 'libs/inductors/L_0603_1608Metric.kicad_mod', cat: 'inductor', label: '0603' },
        { file: 'libs/inductors/L_0805_2012Metric.kicad_mod', cat: 'inductor', label: '0805' },
        { file: 'libs/inductors/L_1206_3216Metric.kicad_mod', cat: 'inductor', label: '1206' },
        // LEDs
        _lib(_LED5, 'led', '5mm Red', Object.assign({ value: 'LED-RED' }, _AK)),
        _lib(_LED5, 'led', '5mm Green', Object.assign({ value: 'LED-GRN' }, _AK)),
        _lib(_LED5, 'led', '5mm Blue', Object.assign({ value: 'LED-BLU' }, _AK)),
        _lib(_LED5, 'led', '5mm Yellow', Object.assign({ value: 'LED-YEL' }, _AK)),
        _lib(_LED5, 'led', '5mm White', Object.assign({ value: 'LED-WHT' }, _AK)),
        _lib(_LED3, 'led', '3mm Red', Object.assign({ value: 'LED-RED' }, _AK)),
        _lib('libs/leds/LED_0805_2012Metric.kicad_mod', 'led', '0805 Red', Object.assign({ value: 'LED-RED' }, _AK)),
        _lib('libs/leds/LED_0603_1608Metric.kicad_mod', 'led', '0603 Red', Object.assign({ value: 'LED-RED' }, _AK)),
        _lib('libs/leds/LED_1206_3216Metric.kicad_mod', 'led', '1206 Red', Object.assign({ value: 'LED-RED' }, _AK)),
        _lib('libs/leds/LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm.kicad_mod', 'led', 'WS2812B', { value: 'WS2812B', pinNames: { 1: 'DIN', 2: 'VDD', 3: 'GND', 4: 'DOUT' } }),
        { file: 'libs/leds/LED_0603_1608Metric.kicad_mod', cat: 'led', label: '0603', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/leds/LED_0805_2012Metric.kicad_mod', cat: 'led', label: '0805', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/leds/LED_1206_3216Metric.kicad_mod', cat: 'led', label: '1206', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/leds/LED_D3.0mm.kicad_mod', cat: 'led', label: 'TH 3mm', pinNames: { 1: 'A', 2: 'K' } },
        { file: 'libs/leds/LED_D5.0mm.kicad_mod', cat: 'led', label: 'TH 5mm', pinNames: { 1: 'A', 2: 'K' } },
        // Switches
        { file: 'libs/switches/SW_SPST_6mm.kicad_mod', cat: 'switch', label: 'SPST 6mm' },
        { file: 'libs/switches/SW_PUSH_6mm.kicad_mod', cat: 'switch', label: 'Tact 6mm' },
        // Fuses
        { file: 'libs/misc/Fuse_0805_2012Metric.kicad_mod', cat: 'fuse', label: '0805' },
        { file: 'libs/misc/Fuse_Holder_5x20.kicad_mod', cat: 'fuse', label: 'TH 5x20' },
        // Crystals
        { file: 'libs/misc/Crystal_HC49-U_Vertical.kicad_mod', cat: 'crystal', label: 'HC-49S' },
        { file: 'libs/misc/Crystal_SMD_Abracon_ABM3-2Pin_5.0x3.2mm.kicad_mod', cat: 'crystal', label: 'SMD 5x3.2' },
        // Misc
        { file: 'libs/misc/MountingHole_3.2mm_M3.kicad_mod', cat: 'misc', label: 'Mounting Hole M3' },
        { file: 'libs/misc/Potentiometer_Vishay_43_Horizontal.kicad_mod', cat: 'misc', label: 'Pot Vishay 43' },
        { file: 'libs/misc/Display_Window_22x14.kicad_mod', cat: 'misc', label: 'Display Window 22x14' },
        // Dev kits â€” official KiCad Module.pretty + Espressif libraries
        { file: 'libs/modules/Arduino_UNO_R3.kicad_mod', cat: 'arduino_uno', label: 'Uno R3', pinNames: {
            1: 'NC', 2: 'IOREF', 3: 'RST', 4: '3V3', 5: '5V', 6: 'GND', 7: 'GND', 8: 'VIN',
            9: 'A0', 10: 'A1', 11: 'A2', 12: 'A3', 13: 'A4', 14: 'A5',
            15: 'D0', 16: 'D1', 17: 'D2', 18: 'D3', 19: 'D4', 20: 'D5', 21: 'D6', 22: 'D7',
            23: 'D8', 24: 'D9', 25: 'D10', 26: 'D11', 27: 'D12', 28: 'D13',
            29: 'GND', 30: 'AREF', 31: 'A4', 32: 'A5'
        }},
        { file: 'libs/modules/Arduino_Nano.kicad_mod', cat: 'arduino_nano', label: 'Nano', pinNames: {
            1: 'D1', 2: 'D0', 3: 'RST', 4: 'GND', 5: 'D2', 6: 'D3', 7: 'D4', 8: 'D5', 9: 'D6',
            10: 'D7', 11: 'D8', 12: 'D9', 13: 'D10', 14: 'D11', 15: 'D12', 16: 'D13',
            17: '3V3', 18: 'AREF', 19: 'A0', 20: 'A1', 21: 'A2', 22: 'A3', 23: 'A4', 24: 'A5',
            25: 'A6', 26: 'A7', 27: '5V', 28: 'RST', 29: 'GND', 30: 'VIN'
        }},
        { file: 'libs/modules/ESP32-DevKitC.kicad_mod', cat: 'esp32_devkit', label: 'DevKitC' },
        { file: 'libs/modules/ESP32-S3-DevKitC.kicad_mod', cat: 'esp32s3_devkit', label: 'S3-DevKitC' },
        { file: 'libs/modules/ESP32-S2-DevKitC-1.kicad_mod', cat: 'esp32s2_mini', label: 'S2 DevKitC' },
        { file: 'libs/modules/WEMOS_S2_mini.kicad_mod', cat: 'esp32s2_mini', label: 'S2 mini', pinNames: {
            1: 'RST', 2: 'IO3', 3: 'IO5', 4: 'IO7', 5: 'IO9', 6: 'IO11', 7: 'IO13', 8: '3V3',
            9: '5V', 10: 'GND', 11: 'IO16', 12: 'IO18', 13: 'IO33', 14: 'IO35', 15: 'RX', 16: 'TX',
            17: 'IO1', 18: 'IO2', 19: 'IO4', 20: 'IO6', 21: 'IO8', 22: 'IO10', 23: 'IO12', 24: 'IO14',
            25: 'IO40', 26: 'IO39', 27: 'IO38', 28: 'IO37', 29: 'IO36', 30: 'IO34', 31: 'IO21', 32: 'IO17'
        }},
        { file: 'libs/modules/Arduino_Nano_ESP32.kicad_mod', cat: 'esp32s3_nano', label: 'S3 Nano', pinNames: {
            1: 'D1', 2: 'D0', 3: 'RST', 4: 'GND', 5: 'D2', 6: 'D3', 7: 'D4', 8: 'D5', 9: 'D6',
            10: 'D7', 11: 'D8', 12: 'D9', 13: 'D10', 14: 'D11', 15: 'D12', 16: 'D13',
            17: '3V3', 18: 'B0', 19: 'A0', 20: 'A1', 21: 'A2', 22: 'A3', 23: 'A4', 24: 'A5',
            25: 'A6', 26: 'A7', 27: '5V', 28: 'B1', 29: 'GND', 30: 'VIN'
        }},
        { file: 'libs/modules/WEMOS_D1_mini.kicad_mod', cat: 'esp8266_nodemcu', label: 'D1 mini', pinNames: {
            1: 'RST', 2: 'A0', 3: 'D0', 4: 'D5', 5: 'D6', 6: 'D7', 7: 'D8', 8: '3V3',
            9: '5V', 10: 'GND', 11: 'D4', 12: 'D3', 13: 'D2', 14: 'D1', 15: 'RX', 16: 'TX'
        }},
        { file: 'libs/modules/RaspberryPi_Pico_THT.kicad_mod', cat: 'rpi_pico', label: 'Pico THT', pinNames: {
            1: 'GP0', 2: 'GP1', 3: 'GND', 4: 'GP2', 5: 'GP3', 6: 'GP4', 7: 'GP5', 8: 'GND',
            9: 'GP6', 10: 'GP7', 11: 'GP8', 12: 'GP9', 13: 'GND', 14: 'GP10', 15: 'GP11', 16: 'GP12',
            17: 'GP13', 18: 'GND', 19: 'GP14', 20: 'GP15', 21: 'GP16', 22: 'GP17', 23: 'GND', 24: 'GP18',
            25: 'GP19', 26: 'GP20', 27: 'GP21', 28: 'GND', 29: 'GP22', 30: 'RUN', 31: 'GP26', 32: 'GP27',
            33: 'GND', 34: 'GP28', 35: 'ADC_REF', 36: '3V3', 37: '3V3_EN', 38: 'GND', 39: 'VSYS', 40: 'VBUS'
        }}
    ],

    _embedded: false,
    _loaded: false,
    _failures: [],

    applyEmbed() {
        if (this._embedded) return;
        this._embedded = true;
        if (typeof KicadLibEmbed === 'undefined' || !KicadLibEmbed.entries) return;
        const byCat = {};
        KicadLibEmbed.entries.forEach(e => {
            if (!e || !e.size) return;
            if (!byCat[e.cat]) byCat[e.cat] = [];
            if (e.value && !e.size.value) e.size.value = e.value;
            byCat[e.cat].push(e.size);
        });
        this._mergeCats(byCat, true);
        this._syncPlacedPins();
        console.info('[LibsLoader] Applied embedded KiCad footprints (' + KicadLibEmbed.entries.length + ')');
    },

    _mergeCats(byCat, quiet) {
        for (const cat of Object.keys(byCat)) {
            const loaded = byCat[cat];
            if (!ComponentDefs.defs[cat]) {
                if (cat === 'misc') {
                    const thIdx = loaded.findIndex(s => s.th);
                    ComponentDefs.defs['misc'] = {
                        prefix: 'H', defaultValue: 'Misc', sizes: loaded, defaultSize: thIdx >= 0 ? thIdx : 0, kicadSourced: true
                    };
                }
                continue;
            }
            const def = ComponentDefs.defs[cat];
            loaded.forEach(sz => {
                const i = def.sizes.findIndex(s => s.name === sz.name);
                if (i >= 0) {
                    const keepVal = sz.value || def.sizes[i].value;
                    const keepCh = def.sizes[i].channel;
                    def.sizes[i] = Object.assign({}, def.sizes[i], sz);
                    if (keepVal) def.sizes[i].value = keepVal;
                    if (keepCh) def.sizes[i].channel = keepCh;
                } else {
                    def.sizes.push(sz);
                }
            });
            def.kicadSourced = true;
            if (def.defaultSize >= def.sizes.length) def.defaultSize = 0;
            if (!quiet) {
                console.info('[LibsLoader] ' + cat + ': sizes=[' + def.sizes.map(s => s.name + (s.th ? '(TH)' : '')).join(', ') + ']');
            }
        }
    },

    // Load all footprint files and merge into ComponentDefs.
    async load() {
        this.applyEmbed();
        if (this._loaded) return;
        this._loaded = true;

        const fileCache = {};
        const fetchFile = (file) => {
            if (!fileCache[file]) {
                fileCache[file] = fetch(file).then(r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                });
            }
            return fileCache[file];
        };

        const results = await Promise.allSettled(
            this.manifest.map(entry => fetchFile(entry.file).then(text => ({ entry, text })))
        );

        const byCat = {};
        results.forEach((result, i) => {
            const entry = this.manifest[i];
            if (result.status === 'rejected') {
                this._failures.push({ file: entry.file, error: result.reason });
                console.warn('[LibsLoader] Failed to load:', entry.file, result.reason);
                return;
            }
            try {
                const fp = KicadImport._parseFootprint(result.value.text);
                if (!fp) throw new Error('Parse returned null');
                const size = this._buildSize(fp, entry);
                if (!byCat[entry.cat]) byCat[entry.cat] = [];
                byCat[entry.cat].push(size);
            } catch (e) {
                this._failures.push({ file: entry.file, error: e });
                console.warn('[LibsLoader] Parse error:', entry.file, e);
            }
        });

        this._mergeCats(byCat);

        const total = this.manifest.length - this._failures.length;
        console.info('[LibsLoader] Loaded ' + total + '/' + this.manifest.length + ' KiCad footprints');
        this._syncPlacedPins();
        if (typeof App !== 'undefined' && App.setStatus) {
            App.setStatus('Loaded ' + total + ' KiCad footprint(s) from /libs/');
        }
        if (typeof App !== 'undefined' && App.render) App.render();
    },

    _syncPlacedPins() {
        if (typeof App === 'undefined' || !App.components) return;
        App.components.forEach(comp => {
            const size = App.getCompSize ? App.getCompSize(comp) : null;
            if (size && size.pins && size.pins.length) {
                const oldLen = (comp.pins && comp.pins.length) || 0;
                if (oldLen !== size.pins.length) {
                    comp.pins = size.pins.map(p => ({ ...p }));
                } else {
                    size.pins.forEach((p, i) => {
                        if (!comp.pins[i]) comp.pins[i] = { ...p };
                        else {
                            comp.pins[i].x = p.x;
                            comp.pins[i].y = p.y;
                            if (p.name) comp.pins[i].name = p.name;
                        }
                    });
                }
            }
        });
    },

    // Build a size definition from a parsed footprint + manifest entry.
    _buildSize(fp, entry) {
        const pads = (fp.pads || []).filter(p => p.num && String(p.num) !== '""' && p.type !== 'np_thru_hole');
        const bbox = fp.bbox;
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;

        const ordered = pads.slice().sort((a, b) => {
            const na = /^\d+$/.test(a.num) ? parseInt(a.num, 10) : Infinity;
            const nb = /^\d+$/.test(b.num) ? parseInt(b.num, 10) : Infinity;
            if (na !== nb) return na - nb;
            return a.num.localeCompare(b.num);
        });

        const pinNames = Object.assign({}, entry.pinNames || {});
        if (fp.texts && fp.texts.length) {
            ordered.forEach(p => {
                const num = parseInt(p.num, 10);
                if (pinNames[num] !== undefined) return;
                let best = null, bestD = 6.0;
                fp.texts.forEach(t => {
                    const d = Math.hypot(t.x - p.x, t.y - p.y);
                    if (d < bestD) { bestD = d; best = t.text; }
                });
                if (best) pinNames[num] = best;
            });
        }
        const pins = ordered.map(p => {
            const num = parseInt(p.num, 10);
            const name = (pinNames[num] !== undefined) ? pinNames[num] : p.num;
            return { x: +(p.x - cx).toFixed(3), y: +(p.y - cy).toFixed(3), name: KicadImport._kxShortPinName(name) || String(name) };
        });

        const fabSize = KicadImport._fabBodySize(fp);
        const gfxBox = () => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const add = (x, y) => {
                if (typeof x !== 'number' || typeof y !== 'number') return;
                if (x < minX) minX = x; if (y < minY) minY = y;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y;
            };
            (fp.silk || []).concat(fp.fab || []).forEach(g => KicadImport._gfxAccumulate(g, add));
            if (!isFinite(minX)) return null;
            return { width: maxX - minX, height: maxY - minY };
        };
        const outline = gfxBox();
        const width = (outline && outline.width > 4) ? outline.width : (fabSize ? fabSize.width : Math.max(bbox.maxX - bbox.minX, 0.5));
        const height = (outline && outline.height > 4) ? outline.height : (fabSize ? fabSize.height : Math.max(bbox.maxY - bbox.minY, 0.5));
        const th = pads.some(p => p.type === 'thru_hole');

        const shiftG = (g) => {
            const o = { ...g };
            if (o.x1 != null) o.x1 = +(o.x1 - cx).toFixed(3);
            if (o.y1 != null) o.y1 = +(o.y1 - cy).toFixed(3);
            if (o.x2 != null) o.x2 = +(o.x2 - cx).toFixed(3);
            if (o.y2 != null) o.y2 = +(o.y2 - cy).toFixed(3);
            if (o.x != null) o.x = +(o.x - cx).toFixed(3);
            if (o.y != null) o.y = +(o.y - cy).toFixed(3);
            if (o.pts) o.pts = o.pts.map(pt => ({ x: +(pt.x - cx).toFixed(3), y: +(pt.y - cy).toFixed(3) }));
            return o;
        };

        const kicad = {
            name: fp.name, layer: fp.layer, attr: fp.attr, cx, cy,
            pads: (fp.pads || []).map(p => ({
                num: p.num, type: p.type, shape: p.shape,
                x: +(p.x - cx).toFixed(3), y: +(p.y - cy).toFixed(3), rot: p.rot || 0,
                w: p.w, h: p.h, drill: p.drill || 0, drillOval: p.drillOval
            })),
            fab: (fp.fab || []).map(shiftG),
            silk: (fp.silk || []).map(shiftG),
            texts: (fp.texts || []).map(t => ({ ...t, x: +(t.x - cx).toFixed(3), y: +(t.y - cy).toFixed(3) }))
        };

        return { name: entry.label, width: +width.toFixed(3), height: +height.toFixed(3), th, pins, kicad, value: entry.value };
    },

    // Get failure report.
    getFailures() { return this._failures.slice(); }
};
