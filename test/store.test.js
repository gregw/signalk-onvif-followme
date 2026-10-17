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

test('zones: geometry snapshot, priority, modes, calibration override, cascade delete', async (t) => {
    const dir = tmp(t);
    const s = new Store(dir, {now: () => Date.UTC(2026, 9, 17)}).load();
    const c = await s.putCamera('apt', cam);
    assert.ok(c.calibrationId, 'camera owns a calibration set');
    await assert.rejects(s.createZone({cameraId: 'nope'}), {status: 404});
    const z1 = await s.createZone({
        name: 'Harbour',
        cameraId: 'apt',
        geometry: {ref: 'rg-1', refName: 'Harbour', polygon: square}
    });
    assert.equal(z1.mode.type, 'followme');
    assert.equal(z1.geometry.frame, 'absolute');
    assert.equal(z1.priority, 1);
    assert.equal(z1.calibrationId, null, 'uses the camera set by default');
    assert.equal(s.zoneCalibration(z1.id).id, c.calibrationId);
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', geometry: {polygon: {type: 'Point'}}}), {status: 400});
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', mode: {type: 'landmark'}}), {status: 400});
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', priority: 1.5}), {status: 400});
    await assert.rejects(s.deleteCamera('apt'), {status: 409});

    // Fixed mode: saved without a view, then the view is set; other edits keep it.
    const z2 = await s.createZone({name: 'Close in', cameraId: 'apt', mode: {type: 'fixed'}});
    assert.equal(z2.priority, 2);
    assert.equal(z2.mode.ptz, null);
    await s.setFixedView(z2.id, {x: 0.1, y: -0.3, zoom: 0});
    await s.putZone(z2.id, {name: 'Close in 2', cameraId: 'apt', mode: {type: 'fixed'}});
    assert.deepEqual(s.zone(z2.id).mode.ptz, {x: 0.1, y: -0.3, zoom: 0});
    assert.equal(s.zone(z2.id).geometry, null);
    await assert.rejects(s.setFixedView(z1.id, {x: 0, y: 0, zoom: 0}), {status: 400});

    // Override on, sample into it, override off drops it.
    await s.putZone(z1.id, {cameraId: 'apt', calibrationOverride: true});
    const ov = s.zone(z1.id).calibrationId;
    assert.ok(ov && ov !== c.calibrationId);
    assert.equal(s.zone(z1.id).geometry.ref, 'rg-1', 'geometry kept when not sent');
    await s.addSample(ov, {latitude: -27.4, longitude: 153.2}, {x: 0, y: 0, zoom: 0});
    await s.putZone(z1.id, {cameraId: 'apt', calibrationOverride: false});
    assert.equal(s.zone(z1.id).calibrationId, null);
    assert.equal(
        s.state.calibrations.some((x) => x.id === ov),
        false
    );

    // Samples on the camera set.
    const smp = await s.addSample(
        c.calibrationId,
        {waypointId: 'wp1', name: 'Pile', latitude: -27.4, longitude: 153.2},
        {x: 0.1, y: -0.2, zoom: 0.3}
    );
    assert.deepEqual(smp.ptz, {x: 0.1, y: -0.2, zoom: 0.3});
    assert.equal(smp.capturedAt, '2026-10-17T00:00:00.000Z');
    assert.equal('bearing' in smp, false, 'derived values are not stored');
    await assert.rejects(s.addSample(c.calibrationId, {latitude: 'x', longitude: 1}, {x: 0, y: 0, zoom: 0}), {
        status: 400
    });

    const s2 = new Store(dir).load();
    assert.equal(s2.calibration(c.calibrationId).samples.length, 1);
    assert.equal(s2.calibrationCamera(s2.calibration(c.calibrationId)).id, 'apt');
    await s2.deleteSample(c.calibrationId, smp.id);
    await s2.deleteZone(z1.id);
    await s2.deleteZone(z2.id);
    await s2.deleteCamera('apt');
    assert.deepEqual(s2.state.calibrations, []);
});

test('settings: defaults, validation, persisted', async (t) => {
    const dir = tmp(t);
    const s = new Store(dir).load();
    assert.deepEqual(s.state.settings, {edgeMarginM: 10, holdS: 5});
    await assert.rejects(s.putSettings({edgeMarginM: -1}), {status: 400});
    await s.putSettings({holdS: 3});
    assert.deepEqual(new Store(dir).load().state.settings, {edgeMarginM: 10, holdS: 3});
});

test('migrates a version 1 state file: zone samples move to the camera set', async (t) => {
    const dir = tmp(t);
    const v1 = {
        version: 1,
        cameras: [
            {
                id: 'apt',
                name: 'A',
                conn: {hostname: 'h', port: 80, username: '', password: 'p'},
                pose: {type: 'fixed', position: null}
            }
        ],
        zones: [{id: 'z1', name: 'Z', cameraId: 'apt', geometry: null, mode: {type: 'followme'}, calibrationId: 'c1'}],
        calibrations: [
            {
                id: 'c1',
                zoneId: 'z1',
                samples: [{id: 's1', latitude: -27.4, longitude: 153.2, ptz: {x: 0, y: 0, zoom: 0}}]
            }
        ]
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(v1));
    const logs = [];
    const s = new Store(dir, {log: (m) => logs.push(m)}).load();
    await s.save();
    assert.equal(s.state.version, 2);
    const camCal = s.calibration(s.camera('apt').calibrationId);
    assert.deepEqual(camCal.owner, {type: 'camera', id: 'apt'});
    assert.equal(camCal.samples[0].id, 's1');
    assert.equal(s.zone('z1').calibrationId, null);
    assert.equal(s.zone('z1').priority, 1);
    assert.match(logs[0], /migrated/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).version, 2);
});

test('corrupt state file starts empty instead of throwing', (t) => {
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
    const logs = [];
    const s = new Store(dir, {log: (m) => logs.push(m)}).load();
    assert.deepEqual(s.state.cameras, []);
    assert.match(logs[0], /unreadable/);
});
