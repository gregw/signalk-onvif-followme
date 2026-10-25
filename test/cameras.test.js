'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {CameraManager} = require('../lib/plugin/cameras');
const {fakeCamera} = require('./sim/fake-camera');

const cam = {
    id: 'c1',
    conn: {hostname: 'h', port: 80, username: 'u', password: 'p'},
    pose: {type: 'fixed', position: null}
};

function manager(opts = {}) {
    const made = [];
    let t = 0;
    const m = new CameraManager({
        createAdapter: () => {
            const f = fakeCamera('honest', {clock: () => t});
            if (opts.failConnect) f.adapter.failConnect = opts.failConnect;
            made.push(f.adapter);
            return f.adapter;
        },
        now: () => t,
        retryMs: 5000
    });
    return {m, made, tick: (ms) => (t += ms)};
}

test('connects lazily once and reuses the adapter', async () => {
    const {m, made} = manager();
    await m.status(cam);
    await m.move(cam, {mode: 'absolute', x: 0.5, y: 0, zoom: 0});
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].calls.find((c) => c[0] === 'absoluteMove')[1], {x: 0.5, y: 0, zoom: 0});
});

test('commands run one at a time in order', async () => {
    const {m, made} = manager();
    await m.status(cam);
    const a = made[0];
    const order = [];
    const orig = a.absoluteMove;
    a.absoluteMove = async (p) => {
        order.push('start ' + p.x);
        await new Promise((r) => setTimeout(r, 20));
        order.push('end ' + p.x);
        return orig(p);
    };
    await Promise.all([
        m.move(cam, {mode: 'absolute', x: 1, y: 0, zoom: 0}),
        m.move(cam, {mode: 'absolute', x: 2, y: 0, zoom: 0})
    ]);
    assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('continuous move always carries a timeout', async () => {
    const {m, made} = manager();
    await m.move(cam, {mode: 'continuous', x: 0.3, y: 0, zoom: 0});
    assert.equal(made[0].calls.find((c) => c[0] === 'continuousMove')[2], 2000);
    await assert.rejects(m.move(cam, {mode: 'continuous', x: 0.3, y: 0, zoom: 0, timeoutMs: 60000}), {status: 400});
    await assert.rejects(m.move(cam, {mode: 'warp', x: 0, y: 0, zoom: 0}), {status: 400});
    await assert.rejects(m.move(cam, {mode: 'absolute', x: 'a', y: 0, zoom: 0}), {status: 400});
});

test('a failed request drops the adapter so the next call reconnects', async () => {
    const {m, made} = manager();
    await m.status(cam);
    made[0].getStatus = async () => {
        throw new Error('socket hang up');
    };
    await assert.rejects(m.status(cam), {status: 502, message: /socket hang up/});
    await m.status(cam);
    assert.equal(made.length, 2);
});

test('connect failure fails fast within retryMs, then retries', async () => {
    const {m, made, tick} = manager({failConnect: 'ECONNREFUSED'});
    await assert.rejects(m.status(cam), {status: 502, message: /ECONNREFUSED/});
    await assert.rejects(m.status(cam), {status: 502});
    assert.equal(made.length, 1, 'no second connect attempt inside the window');
    tick(6000);
    await assert.rejects(m.status(cam));
    assert.equal(made.length, 2);
});

test('changed connection config replaces the adapter; concurrent snapshots share a fetch', async () => {
    const {m, made} = manager();
    await m.status(cam);
    await m.status({...cam, conn: {...cam.conn, hostname: 'h2'}});
    assert.equal(made.length, 2);
    assert.equal(made[0].connected, false);
    const [a, b] = await Promise.all([m.snapshot(cam), m.snapshot(cam)]);
    assert.equal(a, b);
    assert.equal(made[2].calls.filter((c) => c[0] === 'fetchSnapshot').length, 1);
    assert.equal(a.contentType, 'image/jpeg');
});

test('absolute move speed: one for all axes, or per axis; validated', async () => {
    const {m, made} = manager();
    await m.move(cam, {mode: 'absolute', x: 0.5, y: 0, zoom: 0, speed: 0.2});
    await m.move(cam, {mode: 'absolute', x: 0.5, y: 0, zoom: 0, speed: {x: 0.01, y: 0.03, zoom: 1}});
    const sent = made[0].calls.filter((c) => c[0] === 'absoluteMove').map((c) => c[2]);
    assert.deepEqual(sent, [
        {x: 0.2, y: 0.2, zoom: 0.2},
        {x: 0.01, y: 0.03, zoom: 1}
    ]);
    for (const speed of [0, 2, {x: 0.1, y: 0.1}, {x: 0.1, y: 0, zoom: 1}, 'fast']) {
        await assert.rejects(m.move(cam, {mode: 'absolute', x: 0, y: 0, zoom: 0, speed}), /speed must be 0..1/);
    }
});
