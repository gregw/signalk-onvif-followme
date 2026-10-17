'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {selectZone, initialState} = require('../lib/engine/zones');
const {metresPerDegree} = require('../lib/engine/geometry');

// Two 1000 m squares on the same parallel, overlapping by 200 m: A spans x 0..1000 m,
// B spans x 800..1800 m, both y -500..500 m, about an origin at -27.4, 153.0.
const O = {latitude: -27.4, longitude: 153.0};
const k = metresPerDegree(O.latitude);
const at = (x, y = 0) => ({latitude: O.latitude + y / k.lat, longitude: O.longitude + x / k.lon});
const square = (x0, x1) => {
    const c = [at(x0, 500), at(x1, 500), at(x1, -500), at(x0, -500), at(x0, 500)].map((p) => [p.longitude, p.latitude]);
    return {type: 'Polygon', coordinates: [c]};
};
const A = {id: 'A', priority: 2, geometry: {polygon: square(0, 1000)}};
const B = {id: 'B', priority: 1, geometry: {polygon: square(800, 1800)}};
const NOGEO = {id: 'N', priority: 0, geometry: null};
const ZONES = [A, B, NOGEO];

function run(steps, {marginM = 10, holdMs = 5000} = {}) {
    let s = initialState();
    const out = [];
    for (const [t, x] of steps) {
        s = selectZone(s, {position: at(x), zones: ZONES, marginM, holdMs, now: t * 1000});
        out.push(s.activeId);
    }
    return out;
}

test('enter needs margin inside and the hold time', () => {
    // At x=-5 (outside), x=5 (inside by 5 m, less than the 10 m margin), then x=50 for 5 s.
    assert.deepEqual(
        run([
            [0, -5],
            [1, 5],
            [2, 50],
            [4, 50],
            [7, 50]
        ]),
        [null, null, null, null, 'A']
    );
});

test('jitter across an edge never switches', () => {
    // Active in A, then oscillate +-8 m about A's west edge (inside the 10 m band).
    const steps = [
        [0, 100],
        [5, 100]
    ];
    for (let t = 6; t < 30; t++) steps.push([t, t % 2 ? -8 : 8]);
    const out = run(steps);
    assert.ok(
        out.slice(1).every((id) => id === 'A'),
        out.join(',')
    );
});

test('leaving needs margin outside held for the hold time, then releases', () => {
    const out = run([
        [0, 100],
        [5, 100],
        [6, -20],
        [9, -20],
        [11, -20]
    ]);
    assert.deepEqual(out, [null, 'A', 'A', 'A', null]);
});

test('flip-flop restarts the hold', () => {
    const out = run([
        [0, 100],
        [5, 100],
        [6, -20],
        [9, 100],
        [10, -20],
        [14, -20],
        [15, -20]
    ]);
    assert.deepEqual(out, [null, 'A', 'A', 'A', 'A', 'A', null]);
});

test('sticky in an overlap; switch only after leaving the active zone', () => {
    // Into A, then into the overlap (B has better priority): stay A. Leave A east: B.
    const out = run([
        [0, 500],
        [5, 500],
        [6, 900],
        [20, 900],
        [21, 1050],
        [26, 1050]
    ]);
    assert.deepEqual(out, [null, 'A', 'A', 'A', 'A', 'B']);
});

test('entering an overlap from outside both takes the lowest priority number', () => {
    // From the north, straight into the overlap strip.
    let s = initialState();
    const p = (y) => ({latitude: O.latitude + y / k.lat, longitude: O.longitude + 900 / k.lon});
    s = selectZone(s, {position: p(600), zones: ZONES, marginM: 10, holdMs: 0, now: 0});
    assert.equal(s.activeId, null);
    s = selectZone(s, {position: p(400), zones: ZONES, marginM: 10, holdMs: 0, now: 1000});
    assert.equal(s.activeId, 'B');
    assert.equal(s.changed, true);
});

test('active zone deleted: re-evaluated from scratch; zones without geometry never match', () => {
    let s = {activeId: 'gone', pending: null};
    s = selectZone(s, {position: at(500), zones: ZONES, marginM: 10, holdMs: 0, now: 0});
    assert.equal(s.activeId, 'A');
});
