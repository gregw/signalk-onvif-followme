'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store} = require('../lib/plugin/store');

function tmp(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    t.after(() => fs.rmSync(d, {recursive: true, force: true}));
    return d;
}

const cam = {
    name: 'Apartment',
    conn: {hostname: '10.0.0.5', port: 80, username: 'u', password: 'secret'},
    pose: {type: 'fixed', position: {latitude: -27.4, longitude: 153.19, height: 30}}
};
const square = {
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

test('cameras: create, password kept on update, redacted in public view, survives reload', async (t) => {
    const dir = tmp(t);
    const s = new Store(dir).load();
    const pub = await s.putCamera('apt', cam);
    assert.equal(pub.conn.password, undefined);
    assert.equal(pub.conn.passwordSet, true);
    await s.putCamera('apt', {...cam, conn: {...cam.conn, password: '', hostname: '10.0.0.6'}});
    const s2 = new Store(dir).load();
    assert.equal(s2.camera('apt').conn.password, 'secret');
    assert.equal(s2.camera('apt').conn.hostname, '10.0.0.6');
    assert.deepEqual(s2.camera('apt').pose.position, {latitude: -27.4, longitude: 153.19, height: 30});
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('cameras: validation errors are 400', async (t) => {
    const s = new Store(tmp(t)).load();
    await assert.rejects(s.putCamera('a', {conn: {}}), {status: 400, message: /hostname/});
    await assert.rejects(s.putCamera('a', {conn: {hostname: 'h', port: 99999}}), {status: 400});
    await assert.rejects(s.putCamera('a', {conn: {hostname: 'h'}, pose: {position: {latitude: 91, longitude: 0}}}), {
        status: 400
    });
    await assert.rejects(s.putCamera('a', {conn: {hostname: 'h'}, pose: {type: 'vessel'}}), {status: 400});
});

test('zones and calibration: snapshot geometry, samples, cascade delete', async (t) => {
    const dir = tmp(t);
    const s = new Store(dir, {now: () => Date.UTC(2026, 9, 17)}).load();
    await s.putCamera('apt', cam);
    await assert.rejects(s.createZone({cameraId: 'nope'}), {status: 404});
    const z = await s.createZone({
        name: 'Harbour',
        cameraId: 'apt',
        geometry: {ref: 'rg-1', refName: 'Harbour', polygon: square}
    });
    assert.equal(z.mode.type, 'followme');
    assert.equal(z.geometry.frame, 'absolute');
    await assert.rejects(s.putZone(z.id, {cameraId: 'apt', geometry: {polygon: {type: 'Point'}}}), {status: 400});
    await assert.rejects(s.deleteCamera('apt'), {status: 409});

    const smp = await s.addSample(
        z.id,
        {waypointId: 'wp1', name: 'Pile', latitude: -27.4, longitude: 153.2},
        {x: 0.1, y: -0.2, zoom: 0.3}
    );
    assert.deepEqual(smp.ptz, {x: 0.1, y: -0.2, zoom: 0.3});
    assert.equal(smp.capturedAt, '2026-10-17T00:00:00.000Z');
    assert.equal('bearing' in smp, false, 'derived values are not stored');
    await assert.rejects(s.addSample(z.id, {latitude: 'x', longitude: 1}, {x: 0, y: 0, zoom: 0}), {status: 400});

    const s2 = new Store(dir).load();
    assert.equal(s2.calibration(z.id).samples.length, 1);
    await s2.deleteSample(z.id, smp.id);
    assert.equal(s2.calibration(z.id).samples.length, 0);
    await s2.deleteZone(z.id);
    assert.equal(s2.state.calibrations.length, 0);
    await s2.deleteCamera('apt');
    assert.equal(s2.state.cameras.length, 0);
});

test('corrupt state file starts empty instead of throwing', (t) => {
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
    const logs = [];
    const s = new Store(dir, {log: (m) => logs.push(m)}).load();
    assert.deepEqual(s.state.cameras, []);
    assert.match(logs[0], /unreadable/);
});
