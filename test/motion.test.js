'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/engine/motion');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const SETTINGS = {
    leadS: 2,
    minIntervalS: 1,
    panDeadband: 0.003,
    tiltDeadband: 0.003,
    zoomDeadband: 0.02,
    speed: null,
    waitIdle: false,
    holdS: 5
};
const checkSetting = (k, v) => (typeof v === 'number' && v >= 0 && v <= 60 ? null : 'bad');

test('speedFor: worked values through the measured table', () => {
    near(m.speedFor(0.0104), 0.01, 1e-12, 'table entry');
    near(m.speedFor(0.0343), 0.03, 1e-12, 'table entry');
    // Halfway in rate between 0.0104 and 0.0343 is halfway in speed.
    near(m.speedFor((0.0104 + 0.0343) / 2), 0.02, 1e-12, 'interpolated');
    // Below the first entry: through the origin.
    near(m.speedFor(0.00085), 0.0015, 1e-12, 'below first');
    near(m.speedFor(-0.0104), 0.01, 1e-12, 'sign ignored');
    assert.equal(m.speedFor(5), 1, 'beyond the table: fastest');
    near(
        m.speedFor(0.5, [
            [0.5, 1],
            [1, 2]
        ]),
        0.25,
        1e-12,
        'custom table, origin segment'
    );
});

test('checkSpeedTable', () => {
    assert.equal(m.checkSpeedTable(m.DEFAULT_SPEED_TABLE), null);
    assert.match(m.checkSpeedTable([[0.1, 0.1]]), /two/);
    assert.match(
        m.checkSpeedTable([
            [0.1, 0.1],
            [0.05, 0.2]
        ]),
        /increase/
    );
    assert.match(
        m.checkSpeedTable([
            [0.1, 0.1],
            [2, 0.2]
        ]),
        /speed 0..1/
    );
    assert.match(
        m.checkSpeedTable([
            [0.1, 0.1],
            ['a', 0.2]
        ]),
        /\[speed, rate\]/
    );
});

test('checkMotion: absent, deadband overrides, paced, refusals', () => {
    assert.deepEqual(m.checkMotion(undefined, checkSetting), {motion: null, error: null});
    assert.deepEqual(m.checkMotion({type: 'deadband', panDeadband: 0.006, speed: null}, checkSetting), {
        motion: {type: 'deadband', panDeadband: 0.006},
        error: null
    });
    assert.deepEqual(m.checkMotion({type: 'paced', lookaheadS: 3}, checkSetting), {
        motion: {type: 'paced', lookaheadS: 3},
        error: null
    });
    assert.match(m.checkMotion({type: 'paced', panDeadband: 0.1}, checkSetting).error, /not a paced parameter/);
    assert.match(m.checkMotion({type: 'deadband', lookaheadS: 2}, checkSetting).error, /not a deadband parameter/);
    assert.match(m.checkMotion({type: 'paced', lookaheadS: 0.1}, checkSetting).error, /lookaheadS must be 0.5..10/);
    assert.match(m.checkMotion({type: 'deadband', leadS: 99}, checkSetting).error, /leadS bad/);
    assert.match(m.checkMotion({type: 'warp'}, checkSetting).error, /not supported/);
    assert.match(m.checkMotion('fast', checkSetting).error, /object/);
});

test('resolveMotion: defaults from the global settings or PACED', () => {
    assert.deepEqual(m.resolveMotion(null, SETTINGS), {
        type: 'deadband',
        params: {
            leadS: 2,
            minIntervalS: 1,
            panDeadband: 0.003,
            tiltDeadband: 0.003,
            zoomDeadband: 0.02,
            speed: null,
            waitIdle: false
        }
    });
    assert.equal(m.resolveMotion({type: 'deadband', panDeadband: 0.01}, SETTINGS).params.panDeadband, 0.01);
    assert.deepEqual(m.resolveMotion({type: 'paced', maxSpeed: 0.3}, SETTINGS), {
        type: 'paced',
        params: {lookaheadS: 2, maxSpeed: 0.3, zoomDeadband: 0.02, zoomSpeed: 1}
    });
});

test('panDelta: shortest way round the +-1 seam', () => {
    near(m.panDelta(0.2, 0.5), 0.3, 1e-12, 'plain');
    near(m.panDelta(0.95, -0.95), 0.1, 1e-12, 'across the seam forwards');
    near(m.panDelta(-0.95, 0.95), -0.1, 1e-12, 'across the seam backwards');
});

test('paced: a worked tick', () => {
    const params = m.resolveMotion({type: 'paced'}, SETTINGS).params;
    // Boat 0.0208 units ahead in pan over 2 s lookahead: 0.0104 units/s, speed 0.01. Tilt 0.0686
    // units in 2 s: 0.0343 units/s, speed 0.03.
    const d = m.paced({
        want: {x: 0.5208, y: 0.8686, zoom: 0.51},
        from: {x: 0.5, y: 0.8},
        lastZoom: 0.5,
        params
    });
    assert.equal(d.reason, 'paced');
    near(d.rate.x, 0.0104, 1e-12, 'pan rate');
    near(d.speed.x, 0.01, 1e-9, 'pan speed');
    near(d.speed.y, 0.03, 1e-9, 'tilt speed');
    assert.equal(d.speed.zoom, 1);
    assert.deepEqual(d.send, {x: 0.5208, y: 0.8686, zoom: 0.5}, 'zoom within its deadband holds');
    // Zoom past its deadband moves; a far target is capped at maxSpeed; a still one at MIN_SPEED.
    const far = m.paced({
        want: {x: -0.9, y: 0.8, zoom: 0.6},
        from: {x: 0.5, y: 0.8},
        lastZoom: 0.5,
        params: {...params, maxSpeed: 0.3}
    });
    assert.equal(far.send.zoom, 0.6);
    assert.equal(far.speed.x, 0.3, 'capped');
    assert.equal(far.speed.y, m.MIN_SPEED, 'no tilt change');
    // Across the seam: 0.98 to -0.98 is 0.04 units, not 1.96.
    near(
        m.paced({want: {x: -0.98, y: 0, zoom: 0}, from: {x: 0.98, y: 0}, lastZoom: 0, params}).rate.x,
        0.02,
        1e-12,
        'seam'
    );
});

test('paced: first move goes at maxSpeed', () => {
    const params = {...m.resolveMotion({type: 'paced'}, SETTINGS).params, maxSpeed: 0.5};
    const d = m.paced({want: {x: 0.1, y: 0.2, zoom: 0.3}, from: null, lastZoom: null, params});
    assert.equal(d.reason, 'first');
    assert.deepEqual(d.speed, {x: 0.5, y: 0.5, zoom: 1});
    assert.deepEqual(d.send, {x: 0.1, y: 0.2, zoom: 0.3});
});
