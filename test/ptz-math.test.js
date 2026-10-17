'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {axisError, pickTargets, waitSettled} = require('../lib/probe/ptz-math');

test('axisError: plain, wrapped, missing', () => {
    assert.ok(Math.abs(axisError(0.5, 0.48) - 0.02) < 1e-12);
    assert.ok(Math.abs(axisError(0.99, -0.99) - 1.98) < 1e-12);
    assert.ok(Math.abs(axisError(0.99, -0.99, {min: -1, max: 1, wrap: true}) - 0.02) < 1e-12);
    assert.equal(axisError(0.5, null), null);
});

test('pickTargets stays inside the space and away from end stops', () => {
    const t = pickTargets({x: {min: -1, max: 1}, y: {min: -1, max: 1}, zoom: {min: 0, max: 1}});
    assert.equal(t.length, 4);
    assert.deepEqual(t[0], {x: -0.5, y: -0.5, zoom: 0.1});
    assert.deepEqual(t[2], {x: 0.5, y: 0.5, zoom: 0.5});
    for (const p of t) {
        assert.ok(Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5);
    }
});

function clock() {
    let t = 0;
    return {now: () => t, wait: async (ms) => void (t += ms)};
}

test('waitSettled waits for stable position and non-MOVING status', async () => {
    const seq = [
        {x: 0, y: 0, zoom: 0, moveStatus: 'MOVING'},
        {x: 0.2, y: 0, zoom: 0, moveStatus: 'MOVING'},
        {x: 0.4, y: 0, zoom: 0, moveStatus: 'MOVING'},
        {x: 0.4, y: 0, zoom: 0, moveStatus: 'MOVING'},
        {x: 0.4, y: 0, zoom: 0, moveStatus: 'IDLE'},
        {x: 0.4, y: 0, zoom: 0, moveStatus: 'IDLE'}
    ];
    let i = 0;
    const c = clock();
    const r = await waitSettled(async () => seq[Math.min(i++, seq.length - 1)], {...c, pollMs: 100});
    assert.equal(r.settled, true);
    assert.equal(r.status.x, 0.4);
    assert.equal(r.status.moveStatus, 'IDLE');
    assert.equal(i, 5);
});

test('waitSettled times out on a camera that never stops', async () => {
    let x = 0;
    const c = clock();
    const r = await waitSettled(async () => ({x: (x += 0.01), y: 0, zoom: 0}), {...c, pollMs: 100, timeoutMs: 1000});
    assert.equal(r.settled, false);
});
