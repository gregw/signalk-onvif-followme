'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runMotionProbe, restore} = require('../lib/probe/motion');
const {toMotionMarkdown} = require('../lib/probe/motion-report');
const {fakeCamera, virtualClock} = require('./sim/fake-camera');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const START = {x: -0.5, y: 0.2, zoom: 0.3};

// The fake moves at v units/s for a ContinuousMove velocity v, and at speed units/s for an
// AbsoluteMove speed (test/sim/fake-camera.js), so every rate here has a known answer.
test('motion probe on the fake camera measures its known rates', async () => {
    const clock = virtualClock();
    const {adapter} = fakeCamera('honest', {clock: clock.now, start: START});
    const r = await runMotionProbe(adapter, {quick: true, wait: clock.wait, now: clock.now});
    assert.deepEqual(r.home, {x: -0.5, y: 0.2, zoom: 0.3});

    const pan = r.tests['pan-curve'];
    for (const run of pan.runs.filter((x) => Math.abs(x.v) <= 0.3)) near(run.rate, run.v, 0.002, `pan v=${run.v}`);
    assert.equal(pan.levels.length, 5, 'linear: one level per velocity');
    for (const run of r.tests['tilt-curve'].runs.filter((x) => Math.abs(x.v) <= 0.2))
        near(run.rate, run.v, 0.002, `tilt v=${run.v}`);

    const rs = r.tests.resend;
    near(rs.rate, rs.v, 0.002, 'resend rate');
    assert.equal(rs.dips.length, 0, 'no hitch on resend');
    const st = r.tests.step;
    near(st.before, st.v, 0.002, 'step before');
    near(st.after, 2 * st.v, 0.002, 'step after');
    assert.ok(st.rampMs <= 200, `ramp ${st.rampMs}`);

    for (const k of ['pan+zoom', 'zoom-only']) {
        const o = r.tests['zoom-during-pan'][k];
        near(o.panDuring, o.panBefore, 0.002, `${k}: pan keeps its rate`);
        near(o.zoomDuring, 0.3, 0.002, `${k}: zoom moves`);
    }

    const abs = r.tests['abs-speed'].runs;
    for (const x of abs) near(x.rate, x.speed, Math.max(0.002, x.speed * 0.05), `abs speed ${x.speed}`);
    assert.equal(abs.find((x) => x.speed === 0.003).arriveMs, null, '0.1 units at 0.003/s takes 33 s');
    const ch = r.tests['abs-chain'];
    assert.equal(ch.speed, 0.01);
    near(ch.rate, 0.01, 0.0005, 'chain rate');
    assert.equal(ch.dips.length, 0, 'chain is seamless on the fake');

    assert.equal(r.getStatus.staleWhileMoving, 0);
    const md = toMotionMarkdown(r);
    assert.match(md, /Distinct speed levels \(within 8%\): 5 over 5 velocities/);
    assert.match(md, /windows below half the rate: 0 of/);

    const back = await restore(adapter, START, {wait: clock.wait, now: clock.now});
    assert.deepEqual({x: back.status.x, y: back.status.y, zoom: back.status.zoom}, START);
});

test('a camera that hitches after every ContinuousMove shows dips on resend', async () => {
    const clock = virtualClock();
    const {adapter: fake} = fakeCamera('honest', {clock: clock.now, start: START});
    // Each ContinuousMove stops the mount for 400 ms before the new velocity takes effect.
    let pending = null;
    const adapter = Object.create(fake);
    adapter.continuousMove = async (v, t) => {
        await fake.continuousMove({x: 0, y: 0, zoom: 0}, t);
        pending = {v, t, at: clock.now() + 400};
    };
    adapter.getStatus = async () => {
        if (pending && clock.now() >= pending.at) {
            await fake.continuousMove(pending.v, pending.t);
            pending = null;
        }
        return fake.getStatus();
    };
    adapter.stop = async () => {
        pending = null;
        return fake.stop();
    };
    const r = await runMotionProbe(adapter, {only: new Set(['resend']), wait: clock.wait, now: clock.now});
    const rs = r.tests.resend;
    assert.ok(rs.dips.length > 0, `dips ${rs.dips.length}`);
    assert.ok(rs.rate < rs.v * 0.7, `mean rate ${rs.rate} below commanded ${rs.v}`);
});

test('a camera with no position is refused before it moves', async () => {
    const clock = virtualClock();
    const {adapter} = fakeCamera('no-pos', {clock: clock.now});
    await assert.rejects(runMotionProbe(adapter, {wait: clock.wait, now: clock.now}), /no position/);
    assert.equal(adapter.calls.filter((c) => /Move/.test(c[0])).length, 0);
});
