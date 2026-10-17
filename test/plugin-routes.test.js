'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {startDevServer} = require('./sim/dev-server');

let srv;
test.before(async () => {
    srv = await startDevServer();
});
test.after(() => srv.close());

async function call(method, p, body) {
    const r = await fetch(srv.api + p, {
        method,
        headers: body ? {'Content-Type': 'application/json'} : {},
        body: body ? JSON.stringify(body) : undefined
    });
    const ct = r.headers.get('content-type') || '';
    return {status: r.status, ct, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer())};
}

/** Poll status until the fake camera reports IDLE. */
async function settle() {
    for (let i = 0; i < 100; i++) {
        const st = await call('GET', '/camera/apt/status');
        if (st.body.moveStatus === 'IDLE') return st.body;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('camera did not settle');
}

const CAMERA = {
    name: 'Apartment',
    conn: {hostname: '192.0.2.64', port: 80, username: 'admin', password: 'pw'},
    pose: {type: 'fixed', position: {latitude: -27.4, longitude: 153.19, height: 30}}
};

test('camera CRUD never returns the password', async () => {
    const put = await call('PUT', '/cameras/apt', CAMERA);
    assert.equal(put.status, 200);
    assert.equal(put.body.conn.password, undefined);
    assert.equal(put.body.conn.passwordSet, true);
    const st = await call('GET', '/state');
    assert.doesNotMatch(JSON.stringify(st.body), /"pw"/);
    assert.equal((await call('PUT', '/cameras/bad id!', CAMERA)).status, 400);
});

test('camera control: test, status, move, stop, snapshot', async () => {
    const t = await call('POST', '/cameras/apt/test');
    assert.equal(t.status, 200);
    assert.equal(t.body.device.manufacturer, 'Fake');
    assert.equal(typeof t.body.status.x, 'number');
    assert.equal((await call('POST', '/camera/apt/move', {mode: 'continuous', x: 0.2, y: 0, zoom: 0})).status, 200);
    assert.equal((await call('POST', '/camera/apt/stop')).status, 200);
    assert.equal((await call('POST', '/camera/apt/move', {mode: 'sideways', x: 0, y: 0, zoom: 0})).status, 400);
    const snap = await call('GET', '/camera/apt/snapshot');
    assert.equal(snap.status, 200);
    assert.equal(snap.ct, 'image/jpeg');
    assert.equal(snap.body[0], 0xff);
    assert.equal((await call('GET', '/camera/nope/status')).status, 404);
});

test('zone, capture into the camera set, derived bearing/range, goto, geometry query', async () => {
    const polygon = {
        type: 'Polygon',
        coordinates: [
            [
                [153.195, -27.395],
                [153.215, -27.395],
                [153.215, -27.415],
                [153.195, -27.415],
                [153.195, -27.395]
            ]
        ]
    };
    const z = await call('POST', '/zones', {name: 'Harbour', cameraId: 'apt', geometry: {ref: 'rg-harbour', polygon}});
    assert.equal(z.status, 200);
    const zoneId = z.body.id;
    const st = await call('GET', '/state');
    const calId = st.body.cameras.find((c) => c.id === 'apt').calibrationId;
    assert.deepEqual(st.body.settings, {holdS: 5});

    await call('POST', '/camera/apt/move', {mode: 'absolute', x: 0.25, y: -0.1, zoom: 0.2});
    await settle();
    const cap = await call('POST', `/calibration/${calId}`, {
        waypointId: 'wp-pile',
        name: 'Pile 7',
        latitude: -27.4,
        longitude: 153.2
    });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));
    assert.deepEqual(cap.body.ptz, {x: 0.25, y: -0.1, zoom: 0.2});
    // Due east of the camera along the same parallel: geodesic bearing 90.002 degrees (southern hemisphere), 989.01 m.
    assert.ok(Math.abs((cap.body.bearing * 180) / Math.PI - 90) < 0.01, `bearing ${cap.body.bearing}`);
    assert.ok(Math.abs(cap.body.range - 989.01) < 0.01, `range ${cap.body.range}`);

    const cal = await call('GET', `/calibration/${calId}`);
    assert.deepEqual(cal.body.owner, {type: 'camera', id: 'apt'});
    assert.equal(cal.body.samples.length, 1);
    assert.deepEqual(cal.body.samples[0].zones, [zoneId]);
    assert.ok(cal.body.samples[0].depression > 0);

    await call('POST', '/camera/apt/move', {mode: 'absolute', x: -0.5, y: 0, zoom: 0});
    assert.equal((await call('POST', `/calibration/${calId}/${cap.body.id}/goto`)).status, 200);
    const fake = srv.cameras[srv.cameras.length - 1].adapter;
    assert.deepEqual(fake.calls.filter((c) => c[0] === 'absoluteMove').pop()[1], {x: 0.25, y: -0.1, zoom: 0.2});

    const geo = await call('GET', '/geometry?cameraId=apt&latitude=-27.4&longitude=153.2');
    assert.deepEqual(geo.body.zones, [zoneId]);
    const outside = await call('GET', '/geometry?cameraId=apt&latitude=-27.3&longitude=153.2');
    assert.deepEqual(outside.body.zones, []);
    assert.equal((await call('GET', '/geometry?latitude=x')).status, 400);

    // Override set for the zone.
    const ov = await call('PUT', `/zones/${zoneId}`, {name: 'Harbour', cameraId: 'apt', calibrationOverride: true});
    assert.ok(ov.body.calibrationId && ov.body.calibrationId !== calId);
    const ovCal = await call('GET', `/calibration/${ov.body.calibrationId}`);
    assert.deepEqual(ovCal.body.owner, {type: 'zone', id: zoneId});
    assert.equal(ovCal.body.samples.length, 0);

    assert.equal((await call('DELETE', `/calibration/${calId}/${cap.body.id}`)).status, 200);
    assert.equal((await call('DELETE', '/cameras/apt')).status, 409);
    assert.equal((await call('DELETE', `/zones/${zoneId}`)).status, 200);
});

test('fixed mode zone: capture the current view and go back to it', async () => {
    const z = await call('POST', '/zones', {name: 'Close', cameraId: 'apt', mode: {type: 'fixed'}});
    assert.equal(z.body.mode.ptz, null);
    assert.equal((await call('POST', `/zones/${z.body.id}/view/goto`)).status, 400);
    await call('POST', '/camera/apt/move', {mode: 'absolute', x: -0.2, y: 0.1, zoom: 0});
    await settle();
    const v = await call('POST', `/zones/${z.body.id}/view`);
    assert.deepEqual(v.body.mode.ptz, {x: -0.2, y: 0.1, zoom: 0});
    await call('POST', '/camera/apt/move', {mode: 'absolute', x: 0.5, y: 0, zoom: 0});
    assert.equal((await call('POST', `/zones/${z.body.id}/view/goto`)).status, 200);
    const fake = srv.cameras[srv.cameras.length - 1].adapter;
    assert.deepEqual(fake.calls.filter((c) => c[0] === 'absoluteMove').pop()[1], {x: -0.2, y: 0.1, zoom: 0});
    assert.equal((await call('PUT', '/settings', {holdS: 3})).body.holdS, 3);
    assert.equal((await call('PUT', '/settings', {holdS: 'x'})).status, 400);
    await call('DELETE', `/zones/${z.body.id}`);
});

test('stopped plugin answers 503', async () => {
    srv.plugin.stop();
    try {
        assert.equal((await call('GET', '/state')).status, 503);
    } finally {
        srv.plugin.start({});
    }
});
