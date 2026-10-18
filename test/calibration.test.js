'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCalibration, fitLine, unwrapPan, wrapPan} = require('../lib/engine/calibration');
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

test('beyond the nearest samples every axis extrapolates and is flagged', () => {
    const cal = buildCalibration(
        CAM,
        [at(180, 500), at(200, 1000)].map((p) => sample(p))
    );
    const t = at(220, 2500);
    const a = cal.aim(t);
    const want = trueCamera(t);
    near(a.x, want.x, 0.002, 'pan extrapolated');
    near(a.y, want.y, 0.002, 'tilt extrapolated in depression');
    near(a.zoom, want.zoom, 0.002, 'zoom extrapolated');
    assert.deepEqual(a.outside, {pan: true, tilt: true, zoom: true});
});

test('least squares line: worked values', () => {
    const pts = [
        {x: 190, y: 0},
        {x: 200, y: 0.06},
        {x: 210, y: 0.1}
    ];
    // mean (200, 0.16 / 3); Sxy = 10 * 0.16 / 3 + 10 * (0.1 - 0.16 / 3) = 1; Sxx = 200.
    const line = fitLine(pts);
    near(line.slope, 0.005, 1e-12, 'slope');
    near(line.at(205), 0.16 / 3 + 0.025, 1e-12, 'at 205');
    assert.deepEqual([line.min, line.max], [190, 210]);
    near(fitLine(pts, 0.01).at(200), 0.16 / 3, 1e-12, 'fixed slope keeps the mean');
    near(fitLine([{x: 5, y: 0.3}]).at(9), 0.3, 1e-12, 'one point is flat');
});

test('only the 3 samples nearest the target count: a bad near sample stays local', () => {
    // Far samples on the true camera, plus one 190 m out that is 0.012 pan (about 2 degrees) off,
    // between them in bearing. The old bearing-order model interpolated through it for every
    // target at bearings 211 to 228, at any range.
    const far = [at(201, 6300), at(211, 2650), at(228, 3130), at(235, 1380)].map((p, i) => ({
        ...sample(p),
        name: `far${i}`
    }));
    const p = at(217.6, 190);
    const t = trueCamera(p);
    const bad = {...p, name: 'bad', ptz: {...t, x: t.x + 0.012}};
    const cal = buildCalibration(CAM, [...far, bad]);

    const boat = at(224, 2750);
    const a = cal.aim(boat);
    assert.deepEqual([...a.neighbours].sort(), ['far1', 'far2', 'far3']);
    near(a.x, trueCamera(boat).x, 0.0005, 'far target unaffected by the bad sample');

    const close = cal.aim(at(216, 220));
    assert.ok(close.neighbours.includes('bad'), 'a target near it does use it');
    assert.equal(buildCalibration(CAM, [...far, bad], {neighbours: 2}).aim(boat).neighbours.length, 2);
});

test('neighbours on one bearing keep the slope through all samples', () => {
    // Three samples down one radial: their bearings cannot fix a pan slope.
    const radial = [at(200, 1000), at(200, 1500), at(200, 2000)];
    const wide = [at(150, 1500), at(250, 1500)];
    const cal = buildCalibration(
        CAM,
        [...radial, ...wide].map((p) => sample(p))
    );
    const t = at(203, 1500);
    const a = cal.aim(t);
    near(a.x, trueCamera(t).x, 0.0005, 'pan from the global slope');
    near(a.y, trueCamera(t).y, 0.002, 'tilt still local');
    assert.equal(a.outside.pan, true);
    assert.equal(a.outside.zoom, false);
});

test('needs two bearings; zero height uses range for tilt', () => {
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
