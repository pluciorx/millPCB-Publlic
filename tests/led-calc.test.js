#!/usr/bin/env node
// Automated LED series-resistor math tests (Node, no browser).
// Exercises the pure, DOM-free LedCalc module (js/led-calc.js) that the
// properties-panel LED calculator delegates to. Runs in CI via
// "node tests/led-calc.test.js".
const path = require('path');
const LedCalc = require(path.join(__dirname, '..', 'js', 'led-calc.js'));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', msg);
}
function assertClose(a, b, eps, msg) {
    assert(Math.abs(a - b) <= eps, `${msg} (expected ${b}, got ${a})`);
}

// ---- nearestE24: within-decade snapping --------------------------------
assert(LedCalc.nearestE24(100) === 100, 'nearestE24(100) -> 100 (exact E24)');
assert(LedCalc.nearestE24(140) === 130, 'nearestE24(140) -> 130 (tie-breaks to lower)');
assert(LedCalc.nearestE24(150) === 150, 'nearestE24(150) -> 150 (exact)');
assert(LedCalc.nearestE24(4700000) === 4700000, 'nearestE24(4.7e6) -> 4.7M (exact)');

// ---- nearestE24: top-of-decade fix (the regression this module cures) --
// A single-decade scan floors 1e6 to the 1e5 base and would return 910k;
// the two-decade scan returns the correct 1M. Same for every decade, and a
// value just under the boundary correctly crosses up to the next decade.
assert(LedCalc.nearestE24(10) === 10, 'nearestE24(10) -> 10 (not 9.1)');
assert(LedCalc.nearestE24(100) === 100, 'nearestE24(100) -> 100 (not 91)');
assert(LedCalc.nearestE24(1000) === 1000, 'nearestE24(1000) -> 1k (not 910)');
assert(LedCalc.nearestE24(100000) === 100000, 'nearestE24(1e5) -> 100k (not 91k)');
assert(LedCalc.nearestE24(1e6) === 1e6, 'nearestE24(1e6) -> 1M (not 910k)');
assert(LedCalc.nearestE24(999999) === 1000000, 'nearestE24(999999) -> 1M (crosses into next decade)');

// ---- nearestE24: invalid input ----------------------------------------
assert(LedCalc.nearestE24(0) === null, 'nearestE24(0) -> null');
assert(LedCalc.nearestE24(-5) === null, 'nearestE24(-5) -> null');
assert(LedCalc.nearestE24(NaN) === null, 'nearestE24(NaN) -> null');
assert(LedCalc.nearestE24(Infinity) === null, 'nearestE24(Infinity) -> null');

// ---- ledVf: color classification --------------------------------------
assert(LedCalc.ledVf('LED-RED') === 2.0, 'ledVf RED -> 2.0');
assert(LedCalc.ledVf('LED-GRN') === 2.2, 'ledVf GREEN -> 2.2');
assert(LedCalc.ledVf('LED-YEL') === 2.0, 'ledVf YELLOW -> 2.0');
assert(LedCalc.ledVf('LED-BLU') === 3.0, 'ledVf BLUE -> 3.0');
assert(LedCalc.ledVf('LED-WHT') === 3.0, 'ledVf WHITE -> 3.0');
// WS2812B is self-limiting -> no series resistor.
assert(LedCalc.ledVf('LED-WS2812B') === null, 'ledVf WS2812 -> null');
// Most-specific token wins: a value naming red before blue is a blue LED.
assert(LedCalc.ledVf('LED-RED-BLU') === 3.0, 'ledVf red+blue -> 3.0 (blue checked first)');
// Unknown/empty values fall back to a 2.0V default.
assert(LedCalc.ledVf('LED-AMBER') === 2.0, 'ledVf unknown -> 2.0 default');
assert(LedCalc.ledVf('') === 2.0, 'ledVf empty -> 2.0 default');
assert(LedCalc.ledVf(null) === 2.0, 'ledVf null -> 2.0 default');

// ---- seriesResistance: vDrop / current --------------------------------
assertClose(LedCalc.seriesResistance(5, 2.0, 0.02), 150, 1e-9, '5V red 20mA -> 150');
assertClose(LedCalc.seriesResistance(3.3, 2.0, 0.02), 65, 1e-9, '3.3V red 20mA -> 65');
assert(LedCalc.seriesResistance(2.0, 2.0, 0.02) === null, 'vDrop=0 -> null');
assert(LedCalc.seriesResistance(1.0, 3.0, 0.02) === null, 'vDrop<0 -> null');
assert(LedCalc.seriesResistance(5, 2.0, 0) === null, 'current=0 -> null');
assert(LedCalc.seriesResistance(NaN, 2.0, 0.02) === null, 'vcc=NaN -> null');
assert(LedCalc.seriesResistance(5, 2.0, -0.02) === null, 'negative current -> null');

console.log(`\nled-calc tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
