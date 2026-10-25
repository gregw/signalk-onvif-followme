'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/probe/motion-math');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
/** Samples every stepMs of f(t ms) on one axis. */
const series = (f, toMs, stepMs = 100, axis = 'x') =>
    Array.from({length: Math.floor(toMs / stepMs) + 1}, (_, i) => ({
        t: i * stepMs,
        x: 0,
        y: 0,
        zoom: 0,
        [axis]: f(i * stepMs)
    }));

test('unwrapSeries: pan through the +-1 seam stays continuous', () => {
    assert.deepEqual(
        M.unwrapSeries([0.98, 0.99, -0.99, -0.98]).map((v) => +v.toFixed(2)),
        [0.98, 0.99, 1.01, 1.02]
    );
    assert.deepEqual(M.unwrapSeries([0.5, null, 0.6]), [0.5, null, 0.6]);
});

test('fitRate: worked values, window, seam, too few points', () => {
    const s = series((t) => 0.1 + 0.02 * (t / 1000), 3000);
    const r = M.fitRate(s, 'x');
    near(r.rate, 0.02, 1e-12, 'rate');
    near(r.rms, 0, 1e-12, 'rms');
    // Still for 1 s, then 0.05 units/s: the window after 1 s sees only the motion.
    const s2 = series((t) => (t < 1000 ? 0 : 0.05 * ((t - 1000) / 1000)), 4000);
    near(M.fitRate(s2, 'x', 1000).rate, 0.05, 1e-12, 'windowed');
    // Through the seam at 0.1 units/s.
    const s3 = series((t) => {
        const v = 0.95 + 0.1 * (t / 1000);
        return v > 1 ? v - 2 : v;
    }, 2000);
    near(M.fitRate(s3, 'x').rate, 0.1, 1e-9, 'seam');
    assert.equal(M.fitRate(s.slice(0, 2), 'x').rate, null);
});

test('firstMotion and rampTime', () => {
    const s = series((t) => (t < 300 ? 0 : 0.01 * ((t - 300) / 100)), 2000);
    assert.equal(M.firstMotion(s, 'x'), 400);
    // Rate 0.02/s to 0.06/s at 1000 ms, reaching it linearly over 500 ms.
    const pos = (t) => {
        if (t <= 1000) return 0.02 * (t / 1000);
        const a = (0.06 - 0.02) / 0.5; // units/s^2
        const dt = Math.min((t - 1000) / 1000, 0.5);
        const ramped = 0.02 * dt + (a * dt * dt) / 2;
        return 0.02 + ramped + 0.06 * Math.max(0, (t - 1500) / 1000);
    };
    const ramp = M.rampTime(series(pos, 4000, 50), 'x', 1000, 0.06, {windowMs: 200});
    assert.ok(ramp >= 300 && ramp <= 500, `ramp ${ramp}`);
});

test('steadiness: a hitch every second shows as dips', () => {
    const steady = M.steadiness(
        series((t) => 0.03 * (t / 1000), 8000),
        'x',
        1000,
        8000
    );
    near(steady.rate, 0.03, 1e-9, 'steady rate');
    assert.equal(steady.dips.length, 0);
    // Stops for 300 ms after each whole second, faster in between to keep up.
    const hitch = (t) => {
        const k = Math.floor(t / 1000);
        const f = t / 1000 - k;
        return 0.03 * (k + Math.max(0, (f - 0.3) / 0.7));
    };
    const h = M.steadiness(series(hitch, 8000, 50), 'x', 1000, 8000, {windowMs: 250});
    near(h.rate, 0.03, 0.002, 'mean rate unchanged');
    assert.ok(h.dips.length > 0, 'dips found');
    near(h.minRate, 0, 1e-9, 'stopped windows');
});

test('speedLevels: quantised speeds collapse, linear ones do not', () => {
    const linear = [0.01, 0.02, 0.05, 0.1].map((v) => ({v, rate: v / 6}));
    assert.equal(M.speedLevels(linear).length, 4);
    const stepped = [
        {v: 0.01, rate: 0.01},
        {v: 0.02, rate: 0.0102},
        {v: 0.05, rate: 0.04},
        {v: 0.1, rate: 0.041},
        {v: 0.2, rate: null}
    ];
    assert.deepEqual(M.speedLevels(stepped), [
        {rate: 0.01, vs: [0.01, 0.02]},
        {rate: 0.04, vs: [0.05, 0.1]}
    ]);
});

test('percentiles', () => {
    assert.deepEqual(M.percentiles([5, 1, 3, 2, 4]), [3, 5, 5]);
    assert.deepEqual(M.percentiles([]), [null, null, null]);
});
