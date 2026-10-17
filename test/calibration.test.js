'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCalibration, unwrapPan, wrapPan} = require('../lib/engine/calibration');
const {aimZone, aimOnce, AimError} = require('../lib/engine/aimer');
const g = require('../lib/engine/geometry');

const CAM = {latitude: -27.35, longitude: 153.25, height: 30};
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

/** A point at bearing (degrees true) and range (m) from the camera, via local metres per degree. */
function at(bearingDeg, range) {
    const k = g.metresPerDegree(CAM.latitude);
    return {
        latitude: CAM.latitude + (range * Math.cos(rad(bearingDeg))) / k.lat,
        longitude: CAM.longitude + (range * Math.sin(rad(bearingDeg))) / k.lon
    };
}

/**
 * Synthetic level-mounted camera: pan 1 unit per 180 degrees with its 0 at `panZeroDeg`,
 * wrapping at +-1; tilt -1 per 45 degrees down; zoom proportional to range up to 3 km.
 */
function trueCamera(p, panZeroDeg = 200) {
    const {bearing, range} = g.bearingRange(CAM, p);
    return {
        x: wrapPan((deg(bearing) - panZeroDeg) / 180),
        y: -deg(g.depression(CAM.height, range)) / 45,
        zoom: Math.min(1, range / 3000)
    };
}
const sample = (p, panZeroDeg) => ({...p, ptz: trueCamera(p, panZeroDeg)});

test('reproduces a linear camera between samples', () => {
    const pts = [at(150, 400), at(180, 1500), at(210, 800), at(250, 2500)];
    const cal = buildCalibration(
        CAM,
        pts.map((p) => sample(p))
    );
    for (const [b, r] of [
        [165, 600],
        [200, 1200],
        [240, 2000]
    ]) {
        const t = at(b, r);
        const a = cal.aim(t);
        const want = trueCamera(t);
        near(a.x, want.x, 0.002, `pan at ${b}`);
        near(a.y, want.y, 0.002, `tilt at ${r} m`);
        near(a.zoom, want.zoom, 0.002, `zoom at ${r} m`);
        assert.deepEqual(a.outside, {pan: false, tilt: false, zoom: false});
    }
});

test('an arc across north stays continuous', () => {
    const pts = [at(330, 500), at(350, 900), at(10, 1300), at(30, 1700)];
    const cal = buildCalibration(
        CAM,
        pts.map((p) => sample(p, 0))
    );
    const t = at(0, 1100);
    near(cal.aim(t).x, trueCamera(t, 0).x, 0.002, 'pan at 000');
});

test('pan continuing through the camera +-1 seam', () => {
    // Pan zero at 200 degrees: the seam (pan +-1) is at bearing 020.
    const pts = [at(0, 500), at(15, 900), at(25, 1300), at(40, 1700)];
    const cal = buildCalibration(
        CAM,
        pts.map((p) => sample(p))
    );
    for (const b of [10, 18, 22, 30]) {
        const t = at(b, 1000);
        const got = cal.aim(t).x;
        const want = trueCamera(t).x;
        const d = Math.abs(got - want);
        assert.ok(Math.min(d, 2 - d) < 0.003, `pan at ${b}: ${got} vs ${want}`);
    }
    assert.deepEqual(unwrapPan([0.9, 0.98, -0.95, -0.9]), [0.9, 0.98, 1.05, 1.1]);
});

test('outside the samples: pan extrapolates, tilt and zoom clamp, all flagged', () => {
    const cal = buildCalibration(
        CAM,
        [at(180, 500), at(200, 1000)].map((p) => sample(p))
    );
    const t = at(220, 3000);
    const a = cal.aim(t);
    near(a.x, trueCamera(t).x, 0.002, 'pan extrapolated');
    near(a.zoom, trueCamera(at(200, 1000)).zoom, 1e-9, 'zoom clamped to the far sample');
    assert.deepEqual(a.outside, {pan: true, tilt: true, zoom: true});
});

test('needs two bearings; equal bearings are averaged; zero height uses range for tilt', () => {
    assert.throws(() => buildCalibration(CAM, [sample(at(180, 500))]), /at least 2/);
    assert.throws(() => buildCalibration(CAM, [sample(at(180, 500)), sample(at(180, 900))]), /at least 2/);
    const flat = {...CAM, height: 0};
    const s = [
        {...at(180, 500), ptz: {x: 0, y: -0.2, zoom: 0.1}},
        {...at(200, 1500), ptz: {x: 0.1, y: -0.1, zoom: 0.5}}
    ];
    const a = buildCalibration(flat, s).aim(at(190, 1000));
    near(a.y, -0.15, 0.01, 'tilt by range');
});

test('aimer: fixed zone uses its view, followme uses calibration, outside is no zone', () => {
    const square = (b, r, d) => {
        const c = at(b, r);
        return {
            type: 'Polygon',
            coordinates: [
                [
                    [c.longitude - d, c.latitude + d],
                    [c.longitude + d, c.latitude + d],
                    [c.longitude + d, c.latitude - d],
                    [c.longitude - d, c.latitude - d],
                    [c.longitude - d, c.latitude + d]
                ]
            ]
        };
    };
    const follow = {
        id: 'f',
        priority: 2,
        mode: {type: 'followme'},
        geometry: {refName: 'F', polygon: square(200, 1000, 0.01)}
    };
    const fixed = {
        id: 'x',
        priority: 1,
        mode: {type: 'fixed', ptz: {x: 0.5, y: -0.5, zoom: 0}},
        geometry: {refName: 'X', polygon: square(200, 300, 0.002)}
    };
    const samples = [at(180, 500), at(200, 1000), at(220, 1500)].map((p) => sample(p));
    const args = {zones: [follow, fixed], cameraPosition: CAM, samplesFor: () => samples};

    const inFollow = aimOnce({...args, target: at(205, 1100)});
    assert.equal(inFollow.zone.id, 'f');
    near(inFollow.ptz.x, trueCamera(at(205, 1100)).x, 0.002, 'follow pan');

    const inFixed = aimOnce({...args, target: at(200, 300)});
    assert.equal(inFixed.zone.id, 'x');
    assert.equal(inFixed.ptz.x, 0.5);

    assert.deepEqual(aimOnce({...args, target: at(90, 5000)}), {zone: null, ptz: null});

    assert.throws(
        () =>
            aimZone({
                target: at(200, 300),
                zone: {...fixed, mode: {type: 'fixed', ptz: null}},
                cameraPosition: CAM,
                samples
            }),
        AimError
    );
    assert.throws(() => aimZone({target: at(200, 1000), zone: follow, cameraPosition: null, samples}), /position/);
    assert.throws(
        () => aimZone({target: at(200, 1000), zone: follow, cameraPosition: CAM, samples: samples.slice(0, 1)}),
        /have 1/
    );
});
