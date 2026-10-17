'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../lib/engine/geometry');

const dms = (d, m, s) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);
const deg = (r) => (r * 180) / Math.PI;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('Vincenty inverse: Flinders Peak to Buninyong (Geoscience Australia worked example)', () => {
    const flinders = {latitude: dms(-37, 57, 3.7203), longitude: dms(144, 25, 29.5244)};
    const buninyong = {latitude: dms(-37, 39, 10.1561), longitude: dms(143, 55, 35.3839)};
    const r = g.inverse(flinders, buninyong);
    near(r.range, 54972.271, 0.001, 'distance m');
    near(deg(r.bearing), dms(306, 52, 5.37), 0.01 / 3600, 'initial bearing');
    // Published reverse azimuth 127 10 25.07 is final bearing + 180.
    near(deg(r.finalBearing), dms(127, 10, 25.07) + 180, 0.01 / 3600, 'final bearing');
});

test('one degree of longitude on the equator is A*pi/180, bearing due east', () => {
    const r = g.bearingRange({latitude: 0, longitude: 10}, {latitude: 0, longitude: 11});
    near(r.range, (6378137 * Math.PI) / 180, 0.001, 'range');
    near(deg(r.bearing), 90, 1e-9, 'bearing');
});

test('bearings are in [0, 2pi): due west and due north', () => {
    const p = {latitude: -27.5, longitude: 153.2};
    near(deg(g.bearingRange(p, {latitude: -27.5, longitude: 153.19}).bearing), 270, 0.01, 'west');
    near(deg(g.bearingRange(p, {latitude: -27.49, longitude: 153.2}).bearing), 0, 1e-9, 'north');
    assert.deepEqual(g.bearingRange(p, p), {bearing: 0, range: 0});
});

test('depression angle', () => {
    near(deg(g.depression(20, 20)), 45, 1e-12, '45');
    near(deg(g.depression(30, 1000)), 1.7184, 1e-4, '30 m at 1 km');
});

test('unwrap keeps an arc across north continuous', () => {
    const b = [350, 355, 2, 10].map((d) => (d * Math.PI) / 180);
    const u = g.unwrapAll(b).map(deg);
    near(u[0], -10, 1e-9, '350');
    near(u[2], 2, 1e-9, '2');
    near(u[3], 10, 1e-9, '10');
    for (let i = 1; i < u.length; i++) assert.ok(u[i] > u[i - 1]);
    near(deg(g.unwrap(Math.PI / 18, 2 * Math.PI - Math.PI / 18)), 370, 1e-9, 'unwrap about 350');
});

test('pointInPolygon: ring, Polygon with hole, MultiPolygon', () => {
    const ring = [
        [153.0, -27.0],
        [153.1, -27.0],
        [153.1, -27.1],
        [153.0, -27.1],
        [153.0, -27.0]
    ];
    const hole = [
        [153.04, -27.04],
        [153.06, -27.04],
        [153.06, -27.06],
        [153.04, -27.06],
        [153.04, -27.04]
    ];
    const at = (longitude, latitude) => ({latitude, longitude});
    assert.equal(g.pointInPolygon(at(153.02, -27.02), ring), true);
    assert.equal(g.pointInPolygon(at(153.2, -27.02), ring), false);
    const poly = {type: 'Polygon', coordinates: [ring, hole]};
    assert.equal(g.pointInPolygon(at(153.02, -27.02), poly), true);
    assert.equal(g.pointInPolygon(at(153.05, -27.05), poly), false);
    const multi = {type: 'MultiPolygon', coordinates: [[ring], [ring.map(([x, y]) => [x + 1, y])]]};
    assert.equal(g.pointInPolygon(at(154.05, -27.05), multi), true);
    assert.equal(g.pointInPolygon(at(153.5, -27.05), multi), false);
    assert.equal(g.pointInPolygon(at(153.05, -27.05), null), false);
});

test('signedDistanceToEdge: inside positive, outside negative, agrees with Vincenty', () => {
    const sq = {
        type: 'Polygon',
        coordinates: [
            [
                [153.0, -27.39],
                [153.02, -27.39],
                [153.02, -27.41],
                [153.0, -27.41],
                [153.0, -27.39]
            ]
        ]
    };
    const centre = {latitude: -27.4, longitude: 153.01};
    const east = g.inverse(centre, {latitude: -27.4, longitude: 153.02}).range; // 989.0 m
    near(g.signedDistanceToEdge(centre, sq), east, 0.5, 'centre to east edge');
    const outside = {latitude: -27.4, longitude: 153.03};
    near(
        g.signedDistanceToEdge(outside, sq),
        -g.inverse(outside, {latitude: -27.4, longitude: 153.02}).range,
        0.5,
        'outside'
    );
    // Hole: just inside the hole is outside the zone.
    const withHole = {
        type: 'Polygon',
        coordinates: [
            sq.coordinates[0],
            [
                [153.005, -27.395],
                [153.015, -27.395],
                [153.015, -27.405],
                [153.005, -27.405],
                [153.005, -27.395]
            ]
        ]
    };
    assert.ok(g.signedDistanceToEdge(centre, withHole) < 0);
    assert.equal(g.signedDistanceToEdge(centre, null), null);
});
