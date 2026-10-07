// ============================================================
// LED series-resistor helpers — pure, DOM-free, unit-testable.
// Shared by the browser properties panel (App) and node tests.
// Kept out of app-props.js (which references the DOM) so the math
// can be exercised by the node harness without a browser.
// ============================================================
const LedCalc = {
    // LED forward voltage (V) inferred from the value string
    // (LED-RED, LED-BLU, LED-WHT, ...). Returns null for parts that
    // don't take a series resistor (e.g. WS2812B — self-limiting).
    // Color tokens are matched most-specific-first (3.0V blues/whites
    // before 2.0V reds/yellows) so a value naming multiple colors
    // resolves to the dominant one deterministically.
    ledVf(value) {
        const v = String(value || '').toUpperCase();
        if (v.includes('WS2812')) return null;
        if (v.includes('BLU')) return 3.0;   // BLUE
        if (v.includes('WHT')) return 3.0;   // WHITE
        if (v.includes('GRN')) return 2.2;   // GREEN
        if (v.includes('YEL')) return 2.0;   // YELLOW
        if (v.includes('RED')) return 2.0;   // RED
        return 2.0; // sensible default for an unknown indicator LED
    },

    // Nearest E24 standard resistor value (ohms) to r.
    // Scans BOTH the current decade and the next, so values at the top
    // of a decade snap correctly (e.g. r≈1e6 -> 1M, not 910k).
    nearestE24(r) {
        if (!isFinite(r) || r <= 0) return null;
        const e24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
        const exp = Math.floor(Math.log10(r));
        let best = null, bestDiff = Infinity;
        for (const decade of [Math.pow(10, exp - 1), Math.pow(10, exp)]) {
            for (const e of e24) {
                const val = e * decade;
                if (val <= 0) continue;
                const diff = Math.abs(val - r);
                if (diff < bestDiff) { bestDiff = diff; best = val; }
            }
        }
        return best;
    },

    // Ideal series resistance (ohms) for a target current, given the
    // supply voltage, the LED forward voltage, and the target current (A).
    seriesResistance(vcc, vf, current) {
        const i = Number(current);
        if (!isFinite(vcc) || !isFinite(vf) || !isFinite(i) || i <= 0) return null;
        const vDrop = Number(vcc) - Number(vf);
        if (vDrop <= 0) return null; // no headroom — no series resistor needed
        return vDrop / i;
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = LedCalc;
