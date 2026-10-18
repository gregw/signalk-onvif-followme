'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store, DEFAULT_SETTINGS} = require('../lib/plugin/store');

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
    const region = (ref, refName) => ({ref, refName, polygon: square});
    await assert.rejects(s.createZone({cameraId: 'nope', geometry: region('rg-1', 'Harbour')}), {status: 404});
    await assert.rejects(s.createZone({cameraId: 'apt'}), {status: 400, message: /region/});
    await assert.rejects(s.createZone({cameraId: 'apt', geometry: {polygon: square}}), {status: 400});
    await assert.rejects(s.createZone({cameraId: 'apt', geometry: {ref: 'rg-1', polygon: square}}), {
        status: 400,
        message: /refName/
    });
    assert.equal(s.state.calibrations.length, 1, 'rejected requests leave no calibration behind');
    const z1 = await s.createZone({cameraId: 'apt', geometry: region('rg-1', 'Harbour')});
    assert.equal('name' in z1, false, 'named by its region');
    await assert.rejects(s.createZone({cameraId: 'apt', geometry: region('rg-1', 'Harbour')}), {status: 409});
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', mode: {type: 'nope'}}), {status: 400});
    assert.equal(z1.mode.type, 'followme');
    assert.equal(z1.geometry.frame, 'absolute');
    assert.equal(z1.priority, 1);
    assert.equal('calibrationId' in z1, false, 'zones use the camera set');
    assert.equal(s.cameraCalibration('apt').id, c.calibrationId);
    assert.equal(s.state.calibrations.length, 1);
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', geometry: {polygon: {type: 'Point'}}}), {status: 400});
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', mode: {type: 'landmark'}}), {status: 400});
    await assert.rejects(s.putZone(z1.id, {cameraId: 'apt', priority: 1.5}), {status: 400});
    await assert.rejects(s.deleteCamera('apt'), {status: 409});

    // Fixed mode: saved without a view, then the view is set; other edits keep it.
    const z2 = await s.createZone({cameraId: 'apt', geometry: region('rg-2', 'Close in'), mode: {type: 'fixed'}});
    assert.equal(z2.priority, 2);
    assert.equal(z2.mode.ptz, null);
    await s.setFixedView(z2.id, {x: 0.1, y: -0.3, zoom: 0});
    await s.putZone(z2.id, {cameraId: 'apt', mode: {type: 'fixed'}, priority: 7});
    assert.deepEqual(s.zone(z2.id).mode.ptz, {x: 0.1, y: -0.3, zoom: 0});
    assert.equal(s.zone(z2.id).geometry.refName, 'Close in');
    assert.equal(s.zone(z2.id).priority, 7);
    await assert.rejects(s.setFixedView(z1.id, {x: 0, y: 0, zoom: 0}), {status: 400});

    await s.putZone(z1.id, {cameraId: 'apt', priority: 3});
    assert.equal(s.zone(z1.id).geometry.ref, 'rg-1', 'geometry kept when not sent');

    // Samples on the camera set.
    const {sample: smp} = await s.addSample(
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

test('one sample per waypoint name per set: a new capture replaces the old, even if moved', async (t) => {
    const dir = tmp(t);
    let now = Date.UTC(2026, 9, 17, 5, 0, 0);
    const s = new Store(dir, {now: () => now}).load();
    const c = await s.putCamera('apt', cam);
    const first = await s.addSample(
        c.calibrationId,
        {waypointId: 'w1', name: 'reef', latitude: -27.4, longitude: 153.2},
        {x: 0.1, y: 0, zoom: 0}
    );
    assert.deepEqual(first.replaced, []);
    await s.addSample(c.calibrationId, {name: 'shark', latitude: -27.41, longitude: 153.2}, {x: 0.2, y: 0, zoom: 0});
    now += 60000;
    // Same name, waypoint moved, different id: replaces.
    const again = await s.addSample(
        c.calibrationId,
        {waypointId: 'w9', name: ' reef ', latitude: -27.405, longitude: 153.21},
        {x: 0.15, y: 0, zoom: 0}
    );
    assert.equal(again.replaced.length, 1);
    assert.equal(again.replaced[0].id, first.sample.id);
    const names = () => s.calibration(c.calibrationId).samples.map((x) => `${x.name}@${x.longitude}`);
    assert.deepEqual(names(), ['shark@153.2', 'reef@153.21']);
    // Case differs: a different name.
    await s.addSample(c.calibrationId, {name: 'Reef', latitude: -27.4, longitude: 153.2}, {x: 0, y: 0, zoom: 0});
    assert.equal(s.calibration(c.calibrationId).samples.length, 3);
    // Unnamed samples never replace each other.
    await s.addSample(c.calibrationId, {latitude: -27.4, longitude: 153.2}, {x: 0, y: 0, zoom: 0});
    await s.addSample(c.calibrationId, {name: '  ', latitude: -27.4, longitude: 153.2}, {x: 0, y: 0, zoom: 0});
    assert.equal(s.calibration(c.calibrationId).samples.length, 5);
});

test('loading drops per zone calibration sets (removed 2026-10-18)', (t) => {
    const dir = tmp(t);
    const smp = {id: 's', name: 'reef', latitude: -27.4, longitude: 153.2, ptz: {x: 0, y: 0, zoom: 0}};
    fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({
            version: 2,
            settings: {holdS: 5},
            cameras: [{id: 'apt', conn: {hostname: 'h'}, calibrationId: 'c1'}],
            zones: [
                {id: 'z1', cameraId: 'apt', priority: 1, geometry: {ref: 'r', refName: 'H'}, calibrationId: 'zc'},
                {id: 'z2', cameraId: 'apt', priority: 2, geometry: {ref: 'r2', refName: 'J'}, calibrationId: null}
            ],
            calibrations: [
                {id: 'c1', owner: {type: 'camera', id: 'apt'}, samples: [smp]},
                {id: 'zc', owner: {type: 'zone', id: 'z1'}, samples: [smp]}
            ]
        })
    );
    const logs = [];
    const s = new Store(dir, {log: (m) => logs.push(m)}).load();
    assert.deepEqual(
        s.state.calibrations.map((c) => c.id),
        ['c1']
    );
    assert.equal(
        s.state.zones.some((z) => 'calibrationId' in z),
        false
    );
    assert.match(logs.join('\n'), /zone z1: dropping its own calibration set/);
});

test('loading keeps only the newest sample per name', (t) => {
    const dir = tmp(t);
    const smp = (id, name, at) => ({
        id,
        name,
        latitude: -27.4,
        longitude: 153.2,
        ptz: {x: 0, y: 0, zoom: 0},
        capturedAt: at
    });
    fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({
            version: 2,
            settings: {holdS: 5},
            cameras: [],
            zones: [],
            calibrations: [
                {
                    id: 'c1',
                    owner: {type: 'camera', id: 'apt'},
                    samples: [
                        smp('a', 'reef', '2026-10-17T05:00:00Z'),
                        smp('b', 'reef', '2026-10-17T05:10:00Z'),
                        smp('c', 'shark', '2026-10-17T05:05:00Z'),
                        smp('d', undefined, '2026-10-17T05:01:00Z'),
                        smp('e', undefined, '2026-10-17T05:02:00Z')
                    ]
                }
            ]
        })
    );
    const logs = [];
    const s = new Store(dir, {log: (m) => logs.push(m)}).load();
    assert.deepEqual(
        s.state.calibrations[0].samples.map((x) => x.id),
        ['b', 'c', 'd', 'e']
    );
    assert.match(logs.join('\n'), /dropped 1 older same-name/);
});

test('export then import round trip: everything but passwords; import replaces; bad files change nothing', async (t) => {
    const s = new Store(tmp(t)).load();
    const c = await s.putCamera('apt', cam);
    await s.putSettings({holdS: 7, followEnabled: true, speed: 0.005});
    const geometry = (ref, refName) => ({ref, refName, polygon: square});
    const z1 = await s.createZone({cameraId: 'apt', geometry: geometry('rg-1', 'Harbour')});
    const z2 = await s.createZone({
        cameraId: 'apt',
        geometry: geometry('rg-2', 'Close'),
        mode: {type: 'fixed'}
    });
    await s.setFixedView(z2.id, {x: 0.1, y: 0.2, zoom: 0.3});
    await s.addSample(c.calibrationId, {name: 'reef', latitude: -27.4, longitude: 153.2}, {x: 0, y: 0, zoom: 0});
    await s.addSample(c.calibrationId, {name: 'pile', latitude: -27.41, longitude: 153.2}, {x: 1, y: 0, zoom: 0});
    const file = JSON.parse(JSON.stringify(s.exportData()));
    assert.equal(file.format, 'signalk-onvif-followme');
    assert.equal(file.version, 2);
    assert.equal(JSON.stringify(file).includes('secret'), false, 'no camera password in the export');
    assert.equal(file.cameras[0].conn.hostname, '10.0.0.5');
    assert.equal('password' in file.cameras[0].conn, false);
    assert.equal(file.settings.holdS, 7);

    // A second server: same camera id with its own password, another camera, other zones.
    const s2 = new Store(tmp(t)).load();
    await s2.putCamera('apt', {...cam, conn: {...cam.conn, hostname: 'old-host', password: 'other'}});
    await s2.putCamera('gone', {conn: {hostname: 'x'}});
    await s2.createZone({cameraId: 'apt', geometry: geometry('rg-9', 'Gone')});
    const res = await s2.importData(file);
    assert.deepEqual(res, {cameras: 1, zones: 2, samples: 2, needPassword: []});
    assert.deepEqual(
        s2.state.cameras.map((x) => x.id),
        ['apt'],
        'cameras replaced'
    );
    assert.equal(s2.camera('apt').conn.hostname, '10.0.0.5');
    assert.equal(s2.camera('apt').conn.password, 'other', 'password kept from this server');
    assert.deepEqual(s2.camera('apt').pose.position, cam.pose.position);
    assert.equal(s2.state.settings.holdS, 7);
    assert.equal(s2.state.settings.followEnabled, true);
    assert.equal(s2.state.settings.speed, 0.005);
    assert.deepEqual(
        s2.state.zones.map((z) => z.geometry.refName),
        ['Harbour', 'Close']
    );
    assert.deepEqual(s2.zone(z2.id).mode.ptz, {x: 0.1, y: 0.2, zoom: 0.3});
    assert.equal(s2.camera('apt').calibrationId, c.calibrationId);
    assert.deepEqual(
        s2.cameraCalibration('apt').samples.map((x) => x.name),
        ['reef', 'pile']
    );

    // A server that never had the camera: imported without a password, flagged.
    const s3 = new Store(tmp(t)).load();
    const r3 = await s3.importData({
        ...file,
        cameras: file.cameras.map((x) => ({...x, conn: {...x.conn, password: 'injected'}}))
    });
    assert.deepEqual(r3.needPassword, ['apt']);
    assert.equal(s3.camera('apt').conn.password, '', 'a password in the file is never imported');

    // Bad files: rejected, nothing changed.
    const before = JSON.stringify(s2.state);
    const bad = (mut, re) => {
        const f = JSON.parse(JSON.stringify(file));
        mut(f);
        return assert.rejects(s2.importData(f), {status: 400, message: re});
    };
    await assert.rejects(s2.importData({hello: 1}), {status: 400, message: /export file/});
    await bad((f) => (f.version = 9), /version 9/);
    await bad((f) => (f.zones[0].cameraId = 'nope'), /not configured/);
    await bad((f) => (f.cameras = []), /not configured/);
    await bad((f) => (f.cameras[0].conn.port = 0), /camera apt: conn.port/);
    await bad((f) => f.cameras.push(f.cameras[0]), /duplicate camera ids/);
    await bad((f) => (f.settings.holdS = -1), /setting holdS/);
    await bad((f) => (f.calibrations[0].samples[0].latitude = 'x'), /latitude/);
    await bad((f) => f.zones.push({...f.zones[0], id: 'dup'}), /two zones for region/);
    await bad((f) => delete f.zones[0].geometry.refName, /refName/);
    assert.equal(JSON.stringify(s2.state), before);

    // An older file with a zone's own set: the set is ignored, the zone kept.
    await s2.importData({
        ...file,
        zones: file.zones.map((z) => ({...z, calibrationId: 'zc'})),
        calibrations: [...file.calibrations, {id: 'zc', owner: {type: 'zone', id: z2.id}, samples: []}]
    });
    assert.equal(s2.state.calibrations.length, 1);
    assert.equal(
        s2.state.zones.some((z) => 'calibrationId' in z),
        false
    );

    // Unknown settings from a newer version are ignored.
    await s2.importData({...file, settings: {...file.settings, futureKnob: 3}});
    assert.equal('futureKnob' in s2.state.settings, false);
});

test('a version 1 file (zones and calibration only) leaves cameras and settings alone', async (t) => {
    const s = new Store(tmp(t)).load();
    const c = await s.putCamera('apt', cam);
    await s.putSettings({holdS: 9});
    const v1 = {
        format: 'signalk-onvif-followme',
        version: 1,
        zones: [
            {
                id: 'z1',
                cameraId: 'apt',
                priority: 1,
                geometry: {ref: 'rg-1', refName: 'Harbour', polygon: square},
                mode: {type: 'followme'},
                calibrationId: null
            }
        ],
        calibrations: [{id: 'cal-1', owner: {type: 'camera', id: 'apt'}, samples: []}]
    };
    const r = await s.importData(v1);
    assert.equal(r.zones, 1);
    assert.equal(s.camera('apt').conn.password, 'secret');
    assert.equal(s.camera('apt').calibrationId, 'cal-1');
    assert.notEqual(s.camera('apt').calibrationId, c.calibrationId);
    assert.equal(s.state.settings.holdS, 9);
});

test('settings: defaults, validation, persisted', async (t) => {
    const dir = tmp(t);
    const s = new Store(dir).load();
    assert.deepEqual(s.state.settings, DEFAULT_SETTINGS);
    await assert.rejects(s.putSettings({holdS: -1}), {status: 400, message: /holdS must be 0..600 s/});
    await assert.rejects(s.putSettings({nope: 1}), {status: 400, message: /unknown setting/});
    await assert.rejects(s.putSettings({holdS: 3, speed: 2}), {status: 400, message: /speed/});
    await assert.rejects(s.putSettings({speed: 0.0005}), {status: 400, message: /speed must be 0.001..1/});
    assert.equal((await s.putSettings({speed: 0.005})).speed, 0.005);
    await s.putSettings({speed: null});
    assert.equal(s.state.settings.holdS, 5, 'a rejected update changes nothing');
    await s.putSettings({holdS: 3, followEnabled: true, speed: 0.4});
    await s.putSettings({speed: null});
    const loaded = new Store(dir).load().state.settings;
    assert.deepEqual(loaded, {...DEFAULT_SETTINGS, holdS: 3, followEnabled: true, speed: null});
});

test('a v2 file with the dropped edgeMarginM setting loads without it', (t) => {
    const dir = tmp(t);
    fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({version: 2, settings: {edgeMarginM: 10, holdS: 7}, cameras: [], zones: [], calibrations: []})
    );
    assert.deepEqual(new Store(dir).load().state.settings, {...DEFAULT_SETTINGS, holdS: 7});
});

test('loading drops old zone names and zones without a region', (t) => {
    const dir = tmp(t);
    const geometry = {frame: 'absolute', ref: 'rg-1', refName: 'Outer Harbour', polygon: square};
    fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({
            version: 2,
            settings: {holdS: 5},
            cameras: [],
            zones: [
                {id: 'z1', name: 'Zone 1', cameraId: 'apt', priority: 1, geometry, mode: {type: 'followme'}},
                {id: 'z2', name: 'Zone 2', cameraId: 'apt', priority: 2, geometry: null, mode: {type: 'followme'}}
            ],
            calibrations: []
        })
    );
    const logs = [];
    const s = new Store(dir, {log: (m) => logs.push(m)}).load();
    assert.deepEqual(
        s.state.zones.map((z) => z.id),
        ['z1']
    );
    assert.equal('name' in s.state.zones[0], false);
    assert.match(logs.join('\n'), /dropping zone z2/);
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
        zones: [
            {
                id: 'z1',
                name: 'Z',
                cameraId: 'apt',
                geometry: {frame: 'absolute', ref: 'rg-1', refName: 'Z', polygon: square},
                mode: {type: 'followme'},
                calibrationId: 'c1'
            }
        ],
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
    assert.equal('calibrationId' in s.zone('z1'), false);
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
