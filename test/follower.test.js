'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store} = require('../lib/plugin/store');
const {CameraManager} = require('../lib/plugin/cameras');
const {Follower} = require('../lib/plugin/follower');
const {fakeCamera} = require('./sim/fake-camera');
const g = require('../lib/engine/geometry');
const {wrapPan} = require('../lib/engine/calibration');

const TICK = 1000;
const CAM = {latitude: -27.35, longitude: 153.25, height: 30};
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
function at(bearingDeg, range) {
    const k = g.metresPerDegree(CAM.latitude);
    return {
        latitude: CAM.latitude + (range * Math.cos(rad(bearingDeg))) / k.lat,
        longitude: CAM.longitude + (range * Math.sin(rad(bearingDeg))) / k.lon
    };
}
// Synthetic camera, as in calibration.test.js.
function truePtz(p) {
    const {bearing, range} = g.bearingRange(CAM, p);
    return {
        x: wrapPan((deg(bearing) - 200) / 180),
        y: -deg(g.depression(CAM.height, range)) / 45,
        zoom: Math.min(1, range / 3000)
    };
}
function ring(points) {
    const c = points.map((p) => [p.longitude, p.latitude]);
    return {type: 'Polygon', coordinates: [[...c, c[0]]]};
}

async function setup(t, opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    let now = 1_000_000;
    const clock = () => now;
    const store = new Store(dir, {now: clock}).load();
    const cam = await store.putCamera('c1', {conn: {hostname: 'h'}, pose: {position: CAM}});
    for (const p of [at(160, 400), at(190, 1200), at(220, 800), at(250, 2000)]) {
        await store.addSample(cam.calibrationId, {latitude: p.latitude, longitude: p.longitude}, truePtz(p));
    }
    // Follow zone: a wedge 150..260 degrees, 300..2500 m. Fixed zone: close in, 300..450 m, 190..210.
    const wedge = [at(150, 300), at(150, 2500), at(205, 2600), at(260, 2500), at(260, 300)];
    await store.createZone({
        cameraId: 'c1',
        priority: 2,
        geometry: {ref: 'r-f', refName: 'Wedge', polygon: ring(wedge)}
    });
    const fixed = await store.createZone({
        cameraId: 'c1',
        priority: 1,
        mode: {type: 'fixed'},
        geometry: {
            ref: 'r-x',
            refName: 'Close',
            polygon: ring([at(190, 300), at(190, 450), at(210, 450), at(210, 300)])
        }
    });
    await store.setFixedView(fixed.id, {x: 0.05, y: -0.5, zoom: 0});

    const fakes = [];
    const cameras = new CameraManager({
        createAdapter: () => {
            const f = fakeCamera('honest', {clock});
            fakes.push(f.adapter);
            return f.adapter;
        },
        now: clock
    });
    let deliver = null;
    const app = {
        subscriptionmanager: {
            subscribe: (cmd, unsubs, onErr, onDelta) => {
                assert.equal(cmd.context, 'vessels.self');
                assert.deepEqual(
                    cmd.subscribe.map((s) => s.path),
                    ['navigation.position', 'navigation.courseOverGroundTrue', 'navigation.speedOverGround']
                );
                deliver = onDelta;
                unsubs.push(() => (deliver = null));
            }
        }
    };
    const follower = new Follower({app, store, cameras, now: clock, tickMs: TICK, ...opts});
    follower.start();
    t.after(() => follower.stop());
    const fix = (p, cog = null, sog = null) => {
        const values = [{path: 'navigation.position', value: p}];
        if (cog !== null) values.push({path: 'navigation.courseOverGroundTrue', value: cog});
        if (sog !== null) values.push({path: 'navigation.speedOverGround', value: sog});
        deliver({context: 'vessels.urn:x', updates: [{values}]});
    };
    // Advance the clock a tick at a time, awaiting each tick.
    const run = async (ms, each) => {
        for (let t0 = 0; t0 < ms; t0 += TICK) {
            now += TICK;
            if (each) each(now);
            await follower.tick();
        }
    };
    const moves = () => fakes.flatMap((a) => a.calls.filter((c) => c[0] === 'absoluteMove').map((c) => c[1]));
    return {store, follower, fix, run, moves, clock, setNow: (v) => (now = v), fixed};
}

test('off by default: nothing moves', async (t) => {
    const {follower, fix, run, moves} = await setup(t);
    fix(at(200, 1000));
    await run(3000);
    assert.equal(moves().length, 0);
    assert.equal(follower.status().cameras.c1.reason, 'off');
    assert.equal(follower.status().cameras.c1.zone, null);
});

test('follows a moving boat: hold on entry, at most one move per interval, aims at the boat', async (t) => {
    const {store, follower, fix, run, moves} = await setup(t);
    await store.putSettings({followEnabled: true, leadS: 0});
    // Boat at 5 m/s along the 1000 m arc from 170 to 240 degrees (1000 m arc ~ 17.5 m per degree).
    let b = 170;
    const step = () => {
        b += ((5 / 17.45) * TICK) / 1000; // per tick
        fix(at(b, 1000));
    };
    await run(4500, step);
    assert.equal(moves().length, 0, 'inside the hold time');
    const st = follower.status().cameras.c1;
    assert.equal(st.zone, null);
    assert.equal(st.reason, 'outside (hold)');
    assert.equal(st.pending.to.name, 'Wedge');
    assert.ok(st.pending.remainingS > 0 && st.pending.remainingS <= 1, `hold left ${st.pending.remainingS}`);
    assert.deepEqual(
        st.inZones.map((z) => z.name),
        ['Wedge']
    );
    assert.ok(Math.abs(st.range - 1000) < 1, `range ${st.range}`);
    await run(30000, step);
    const ms = moves();
    // 5 m/s at 1000 m is 0.29 deg/s, 0.0016 pan units/s: the 0.003 deadband is crossed about
    // every 1.9 s, so at a 1 s tick the camera moves every 2 s, in ~0.6 deg steps.
    assert.ok(ms.length >= 13 && ms.length <= 17, `one move per 2 s: ${ms.length}`);
    for (let i = 1; i < ms.length; i++) {
        const step = Math.abs(ms[i].x - ms[i - 1].x);
        assert.ok(step > 0.003 && step < 0.005, `pan step ${step}`);
    }
    const last = ms[ms.length - 1];
    const want = truePtz(at(b, 1000));
    assert.ok(Math.abs(last.x - want.x) < 0.01, `pan ${last.x} vs ${want.x}`);
    assert.ok(Math.abs(last.y - want.y) < 0.005, `tilt ${last.y} vs ${want.y}`);
    // Constant range: zoom never changes after the first move (deadband).
    assert.equal(new Set(ms.map((m) => m.zoom)).size, 1);
});

test('a timer firing slightly early does not skip a 1 s move', async (t) => {
    const {store, fix, moves, follower, setNow, clock} = await setup(t);
    await store.putSettings({followEnabled: true, leadS: 0, holdS: 0, minIntervalS: 1});
    // A fast pan (2 deg per tick, well past the deadband) on ticks 999 ms apart.
    for (let i = 0; i < 6; i++) {
        setNow(clock() + 999);
        fix(at(180 + 2 * i, 1000));
        await follower.tick();
    }
    assert.equal(moves().length, 6);
});

test('lead: aims ahead along COG/SOG', async (t) => {
    const {store, fix, run, moves} = await setup(t);
    await store.putSettings({followEnabled: true, leadS: 4, holdS: 0});
    const p = at(200, 1000);
    // Heading 290 true at 5 m/s: 20 m ahead.
    fix(p, rad(290), 5);
    await run(TICK);
    const ahead = g.metresPerDegree(p.latitude);
    const q = {
        latitude: p.latitude + (20 * Math.cos(rad(290))) / ahead.lat,
        longitude: p.longitude + (20 * Math.sin(rad(290))) / ahead.lon
    };
    assert.ok(Math.abs(moves()[0].x - truePtz(q).x) < 0.002, `${moves()[0].x} vs ${truePtz(q).x}`);
});

test('fixed zone: its view, then the same view again every hold time', async (t) => {
    const {store, follower, fix, run, moves} = await setup(t);
    await store.putSettings({followEnabled: true, holdS: 2, leadS: 0});
    const view = {x: 0.05, y: -0.5, zoom: 0};
    // Entry hold 2 s, first move, then keepalive every 2 s while the boat moves about inside.
    let i = 0;
    await run(9000, () => fix(at(195 + (i++ % 8), 380)));
    const ms = moves();
    assert.ok(ms.length >= 3 && ms.length <= 4, `view then keepalives: ${ms.length}`);
    for (const m of ms) assert.deepEqual(m, view);
    assert.match(follower.status().cameras.c1.reason, /keepalive|deadband/);
});

test('leaving all zones releases after the hold; stale position stops; manual pause blocks', async (t) => {
    const {store, follower, fix, run, moves} = await setup(t);
    await store.putSettings({followEnabled: true, holdS: 2, leadS: 0, staleS: 3});
    fix(at(200, 1000));
    await run(2500);
    assert.ok(moves().length >= 1);
    // Outside: during the hold the zone stays active (still following), then it releases
    // and nothing more is sent.
    fix(at(100, 1000));
    await run(1000);
    assert.equal(follower.status().cameras.c1.zone.name, 'Wedge');
    assert.equal(follower.status().cameras.c1.pending.to, null, 'release pending');
    assert.deepEqual(follower.status().cameras.c1.inZones, []);
    await run(1500);
    assert.equal(follower.status().cameras.c1.reason, 'outside all zones');
    assert.equal(follower.status().cameras.c1.zone, null);
    const released = moves().length;
    await run(3000, () => fix(at(100, 1000)));
    assert.equal(moves().length, released, 'nothing sent once released');
    // Back in, then the fixes stop: stale.
    fix(at(220, 1500));
    await run(4000);
    assert.equal(follower.status().cameras.c1.reason, 'position stale');
    // Manual pause.
    fix(at(220, 1500));
    follower.pause('c1', 5000);
    const m = moves().length;
    await run(2000, () => fix(at(225, 1500)));
    assert.equal(moves().length, m);
    assert.match(follower.status().cameras.c1.reason, /paused/);
    follower.resume('c1');
    await run(500, () => fix(at(225, 1500)));
    assert.equal(moves().length, m + 1);
});

test('bad deltas are ignored, never thrown', async (t) => {
    const {follower, fix} = await setup(t);
    follower.onDelta(null);
    follower.onDelta({updates: [{values: [{path: 'navigation.position', value: {latitude: 'x'}}]}]});
    assert.equal(follower.fix, null);
    fix(at(200, 1000));
    assert.ok(follower.fix);
});

test('trace: one record per camera per tick while enabled, with the aim and what was sent', async (t) => {
    let on = true;
    const records = [];
    const trace = {enabled: () => on, write: (r) => records.push(r)};
    const {store, fix, run, moves} = await setup(t, {trace});
    await run(2000);
    assert.equal(records.length, 0, 'nothing while following is off');

    await store.putSettings({followEnabled: true, leadS: 0, holdS: 0});
    const p = at(200, 1000);
    fix(p, rad(290), 5);
    await run(TICK);
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.camera, 'c1');
    assert.equal(r.reason, 'first');
    assert.deepEqual(r.fix, {...p, ageS: 1});
    assert.deepEqual(r.cog, {value: rad(290), ageS: 1});
    assert.deepEqual(r.zone.name, 'Wedge');
    assert.equal(r.pending, null);
    assert.deepEqual(r.target, p, 'no lead');
    assert.equal(r.aim.method, 'triangle');
    assert.equal(r.aim.neighbours.length, 3);
    assert.equal(r.aim.weights.view.length, 3);
    assert.ok(Math.abs(r.aim.range - 1000) < 1);
    assert.deepEqual(r.send, moves()[0]);
    assert.equal(r.last, null);
    assert.ok(!Number.isNaN(Date.parse(r.t)));

    await run(TICK);
    assert.equal(records[1].reason, 'deadband');
    assert.equal(records[1].send, null);
    assert.deepEqual(records[1].last, {...moves()[0], ageS: 1});

    // Outside every zone: still a record, with no zone and no aim.
    fix(at(90, 1000));
    await run(TICK);
    const out = records[2];
    assert.equal(out.zone, null);
    assert.equal(out.aim, undefined);
    assert.equal(out.reason, 'outside all zones');

    on = false;
    await run(3000);
    assert.equal(records.length, 3, 'nothing once disabled');
});
