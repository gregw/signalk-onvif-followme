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
    return settleCam('apt');
}
async function settleCam(id) {
    for (let i = 0; i < 100; i++) {
        const st = await call('GET', `/camera/${id}/status`);
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
    assert.deepEqual(st.body.motion.paced, {lookaheadS: 2, maxSpeed: 1, zoomDeadband: 0.02, zoomSpeed: 1});
    assert.ok(st.body.motion.deadband.includes('panDeadband'));
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
    const z = await call('POST', '/zones', {
        cameraId: 'apt',
        geometry: {ref: 'rg-harbour', refName: 'Harbour', polygon}
    });
    assert.equal(z.status, 200);
    const zoneId = z.body.id;
    const st = await call('GET', '/state');
    const calId = st.body.cameras.find((c) => c.id === 'apt').calibrationId;
    assert.equal(st.body.settings.holdS, 5);
    assert.equal(st.body.settings.followEnabled, false);

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
    assert.equal(cap.body.replaced, 0);
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

    const upd = await call('PUT', `/zones/${zoneId}`, {cameraId: 'apt', priority: 4});
    assert.equal(upd.body.geometry.refName, 'Harbour');
    assert.equal('calibrationId' in upd.body, false, 'zones use the camera set');

    assert.equal((await call('DELETE', `/calibration/${calId}/${cap.body.id}`)).status, 200);
    assert.equal((await call('DELETE', '/cameras/apt')).status, 409);
    assert.equal((await call('DELETE', `/zones/${zoneId}`)).status, 200);
});

test('fixed mode zone: capture the current view and go back to it', async () => {
    const polygon = {
        type: 'Polygon',
        coordinates: [
            [
                [153.19, -27.39],
                [153.2, -27.39],
                [153.2, -27.4],
                [153.19, -27.39]
            ]
        ]
    };
    assert.equal((await call('POST', '/zones', {cameraId: 'apt', mode: {type: 'fixed'}})).status, 400);
    const z = await call('POST', '/zones', {
        cameraId: 'apt',
        mode: {type: 'fixed'},
        geometry: {ref: 'rg-close', refName: 'Close in', polygon}
    });
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

test('aim test: zone choice, calibration aim, fixed view, outside, errors', async () => {
    await call('PUT', '/cameras/aim', {...CAMERA, conn: {...CAMERA.conn, hostname: 'aimcam'}});
    const st = await call('GET', '/state');
    const calId = st.body.cameras.find((c) => c.id === 'aim').calibrationId;
    const sq = (lon0, lat0, d) => ({
        type: 'Polygon',
        coordinates: [
            [
                [lon0, lat0],
                [lon0 + d, lat0],
                [lon0 + d, lat0 - d],
                [lon0, lat0 - d],
                [lon0, lat0]
            ]
        ]
    });
    // Camera at -27.4, 153.19. Follow zone east of it; small fixed zone inside, higher priority.
    const follow = await call('POST', '/zones', {
        cameraId: 'aim',
        geometry: {ref: 'r-f', refName: 'East', polygon: sq(153.195, -27.38, 0.04)}
    });
    const fixed = await call('POST', '/zones', {
        cameraId: 'aim',
        priority: 0,
        mode: {type: 'fixed'},
        geometry: {ref: 'r-x', refName: 'Close', polygon: sq(153.195, -27.398, 0.004)}
    });

    // Too few samples for followme.
    let r = await call('POST', '/cameras/aim/aim-test', {latitude: -27.39, longitude: 153.21});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /at least 2/);

    // Two samples: pan 0 at bearing ~45, pan 0.5 at bearing ~135 (east side).
    const cam = () => srv.cameras[srv.cameras.length - 1].adapter;
    for (const [lat, lon, x] of [
        [-27.39, 153.2, 0],
        [-27.41, 153.2, 0.5]
    ]) {
        await call('POST', '/camera/aim/move', {mode: 'absolute', x, y: -0.2, zoom: 0.3});
        await settleCam('aim');
        await call('POST', `/calibration/${calId}`, {latitude: lat, longitude: lon});
    }
    r = await call('POST', '/cameras/aim/aim-test', {latitude: -27.4, longitude: 153.205});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.zone.name, 'East');
    assert.equal(r.body.moved, true);
    assert.ok(r.body.ptz.x > 0.2 && r.body.ptz.x < 0.3, `due east between the samples: ${r.body.ptz.x}`);
    assert.deepEqual(
        cam()
            .calls.filter((c) => c[0] === 'absoluteMove')
            .pop()[1],
        r.body.ptz
    );

    // Fixed zone wins by priority; no view yet is an error, then its view.
    r = await call('POST', '/cameras/aim/aim-test', {latitude: -27.4, longitude: 153.197});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no view/);
    await call('POST', '/camera/aim/move', {mode: 'absolute', x: -0.7, y: 0.1, zoom: 0});
    await settleCam('aim');
    await call('POST', `/zones/${fixed.body.id}/view`);
    r = await call('POST', '/cameras/aim/aim-test', {latitude: -27.4, longitude: 153.197});
    assert.equal(r.body.zone.name, 'Close');
    assert.deepEqual(r.body.ptz, {x: -0.7, y: 0.1, zoom: 0});

    // Outside every zone: nothing moves.
    const n = cam().calls.length;
    r = await call('POST', '/cameras/aim/aim-test', {latitude: -27.3, longitude: 153.0});
    assert.deepEqual([r.body.zone, r.body.moved], [null, false]);
    assert.equal(cam().calls.filter((c, i) => i >= n && c[0] === 'absoluteMove').length, 0);
    assert.equal((await call('POST', '/cameras/aim/aim-test', {latitude: 'x'})).status, 400);

    await call('DELETE', `/zones/${follow.body.id}`);
    await call('DELETE', `/zones/${fixed.body.id}`);
});

test('export download and import replace over HTTP', async () => {
    const r = await fetch(srv.api + '/export');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="onvif-followme-\d{4}-\d{2}-\d{2}\.json"/);
    const file = await r.json();
    assert.equal(file.format, 'signalk-onvif-followme');
    const imp = await call('POST', '/import', file);
    assert.equal(imp.status, 200);
    assert.equal(imp.body.zones, file.zones.length);
    assert.equal(imp.body.cameras, file.cameras.length);
    assert.deepEqual(imp.body.needPassword, []);
    assert.equal(JSON.stringify(file).includes('"pw"'), false, 'no password in the export');
    assert.equal((await call('POST', '/import', {format: 'x'})).status, 400);
});

test('stopped plugin answers 503', async () => {
    srv.plugin.stop();
    try {
        assert.equal((await call('GET', '/state')).status, 503);
    } finally {
        srv.plugin.start({});
    }
});

test('follow on survives a plugin restart (server stop and start)', async () => {
    assert.equal((await call('PUT', '/settings', {followEnabled: true})).status, 200);
    srv.plugin.stop();
    srv.plugin.start({}); // reloads state.json from the data dir, as a server start does
    const f = await call('GET', '/follow');
    assert.equal(f.body.enabled, true);
    await call('PUT', '/settings', {followEnabled: false});
});
