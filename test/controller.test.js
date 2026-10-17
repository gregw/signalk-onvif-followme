'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {decide, predict, panDiff} = require('../lib/engine/controller');
const {metresPerDegree, bearingRange} = require('../lib/engine/geometry');

const S = {minIntervalMs: 1000, panDeadband: 0.003, tiltDeadband: 0.003, zoomDeadband: 0.02};
const last = (x, y, zoom, at = 0) => ({ptz: {x, y, zoom}, at});

test('first command goes out; no target sends nothing', () => {
    assert.deepEqual(decide({want: {x: 0.1, y: 0, zoom: 0.2}, last: null, now: 0, settings: S}).send, {
        x: 0.1,
        y: 0,
        zoom: 0.2
    });
    assert.equal(decide({want: null, last: null, now: 0, settings: S}).reason, 'no target');
});

test('deadband per axis: small changes held, all small sends nothing', () => {
    const l = last(0.1, -0.2, 0.3);
    assert.equal(decide({want: {x: 0.102, y: -0.201, zoom: 0.31}, last: l, now: 5000, settings: S}).reason, 'deadband');
    const d = decide({want: {x: 0.2, y: -0.201, zoom: 0.31}, last: l, now: 5000, settings: S});
    assert.deepEqual(d.send, {x: 0.2, y: -0.2, zoom: 0.3}, 'tilt and zoom held at the last commanded values');
});

test('min interval and waitIdle', () => {
    const l = last(0, 0, 0, 1000);
    const want = {x: 0.5, y: 0, zoom: 0};
    assert.equal(decide({want, last: l, now: 1500, settings: S}).reason, 'interval');
    assert.equal(decide({want, last: l, now: 2000, settings: S}).reason, 'move');
    const W = {...S, waitIdle: true, idleTimeoutMs: 10000};
    const moving = {moveStatus: 'panTilt=MOVING zoom=IDLE'};
    assert.equal(decide({want, last: l, status: moving, now: 3000, settings: W}).reason, 'moving');
    assert.equal(
        decide({want, last: l, status: moving, now: 11001, settings: W}).reason,
        'move',
        'stuck MOVING times out'
    );
    assert.equal(
        decide({want, last: l, status: {moveStatus: 'panTilt=IDLE zoom=IDLE'}, now: 3000, settings: W}).reason,
        'move'
    );
});

test('pan difference is the short way round the +-1 seam', () => {
    assert.ok(Math.abs(panDiff(0.999, -0.999) - 0.002) < 1e-12);
    assert.equal(
        decide({want: {x: -0.999, y: 0, zoom: 0}, last: last(0.999, 0, 0), now: 5000, settings: S}).reason,
        'deadband'
    );
});

test('predict: dead reckons leadS along COG, ignores slow or missing motion', () => {
    const p = {latitude: -27.35, longitude: 153.25};
    const q = predict(p, Math.PI / 2, 5, 2, metresPerDegree); // 10 m east
    const br = bearingRange(p, q);
    assert.ok(Math.abs(br.range - 10) < 0.01, `range ${br.range}`);
    assert.ok(Math.abs((br.bearing * 180) / Math.PI - 90) < 0.01);
    assert.equal(predict(p, 1, 0.1, 2, metresPerDegree), p);
    assert.equal(predict(p, null, 5, 2, metresPerDegree), p);
    assert.equal(predict(p, 1, 5, 0, metresPerDegree), p);
});
