'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runProbe} = require('../lib/probe/probe');

/**
 * Fake camera on a virtual clock. mode:
 *  'honest'   AbsoluteMove reaches the target, ContinuousMove moves until Stop
 *  'ack-only' accepts every move, never changes position
 *  'no-pos'   GetStatus has no Position
 */
function fakeCamera(mode = 'honest') {
    let t = 0;
    const pos = {x: 0.1, y: 0.0, zoom: 0.0};
    let target = null;
    let vel = null;
    const SPEED = 0.001; // units per ms
    function advance() {
        // Called on every status read; integrate motion since the last read.
        const dt = t - (advance.last || 0);
        advance.last = t;
        if (mode === 'ack-only') return;
        if (vel) {
            pos.x += vel.x * SPEED * dt;
        } else if (target) {
            for (const k of ['x', 'y', 'zoom']) {
                const d = target[k] - pos[k];
                const step = Math.sign(d) * Math.min(Math.abs(d), SPEED * dt);
                pos[k] += step;
            }
        }
    }
    const adapter = {
        lib: 'fake-' + mode,
        lastRaw: null,
        profileToken: null,
        async connect() {
            this.profileToken = 'P0';
        },
        async getDeviceInformation() {
            return {manufacturer: 'Fake', model: mode, firmwareVersion: '1'};
        },
        async getProfiles() {
            return [{token: 'P0', name: 'main', ptzConfigurationToken: 'PTZ0', ptzNodeToken: 'N0'}];
        },
        async getPtzConfigurations() {
            return [{token: 'PTZ0', name: 'ptz'}];
        },
        async getPtzConfigurationOptions() {
            const g = 'http://www.onvif.org/ver10/tptz/';
            return {
                spaces: [
                    {
                        name: 'AbsolutePanTiltPositionSpace',
                        uri: g + 'PanTiltSpaces/PositionGenericSpace',
                        x: {min: -1, max: 1},
                        y: {min: -1, max: 1}
                    },
                    {name: 'AbsoluteZoomPositionSpace', uri: g + 'ZoomSpaces/PositionGenericSpace', x: {min: 0, max: 1}}
                ]
            };
        },
        async getStatus() {
            advance();
            this.lastRaw = '<status/>';
            if (mode === 'no-pos') return {x: null, y: null, zoom: null, moveStatus: 'IDLE'};
            const moving = vel || (target && ['x', 'y', 'zoom'].some((k) => Math.abs(target[k] - pos[k]) > 1e-9));
            return {
                x: +pos.x.toFixed(4),
                y: +pos.y.toFixed(4),
                zoom: +pos.zoom.toFixed(4),
                moveStatus: moving ? 'MOVING' : 'IDLE'
            };
        },
        async absoluteMove(p) {
            advance();
            vel = null;
            target = {...p};
        },
        async relativeMove(d) {
            advance();
            vel = null;
            target = {x: pos.x + d.x, y: pos.y + d.y, zoom: pos.zoom + d.zoom};
        },
        async continuousMove(v) {
            advance();
            target = null;
            vel = v;
        },
        async stop() {
            advance();
            vel = null;
            target = null;
        },
        async fetchSnapshot() {
            return {
                uri: 'http://fake/snap.jpg',
                status: 200,
                contentType: 'image/jpeg',
                auth: 'digest',
                body: Buffer.from([0xff, 0xd8, 0, 0])
            };
        },
        async getStreamUri() {
            return 'rtsp://fake/1';
        },
        async close() {}
    };
    const wait = async (ms) => void (t += ms);
    return {adapter, wait, now: () => t};
}

const result = (r, id) => r.tests.find((t) => t.id === id).result;

test('honest camera passes every test and is restored', async () => {
    const {adapter, wait, now} = fakeCamera('honest');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9])
        assert.equal(result(r, id), 'PASS', `test ${id}: ${JSON.stringify(r.tests.find((t) => t.id === id).summary)}`);
    assert.equal(r.gate.absoluteMoveHonoured, true);
    const restore = r.tests.find((t) => t.id === 'restore');
    assert.match(restore.summary, /x=0.1 y=0 zoom=0/);
    assert.ok(r.snapshot.length === 4);
});

test('ACK-only camera fails the gate with a clear reason', async () => {
    const {adapter, wait, now} = fakeCamera('ack-only');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    assert.equal(result(r, 5), 'FAIL');
    assert.equal(r.gate.absoluteMoveHonoured, false);
    assert.equal(r.gate.anyMoved, false);
    assert.match(r.tests.find((t) => t.id === 5).summary, /never changed/);
    assert.equal(result(r, 6), 'FAIL');
});

test('camera without status Position fails test 4 and skips moves', async () => {
    const {adapter, wait, now} = fakeCamera('no-pos');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    assert.equal(result(r, 4), 'FAIL');
    assert.equal(result(r, 5), 'SKIP');
    assert.equal(
        r.tests.find((t) => t.id === 'restore'),
        undefined
    );
});

test('--no-move and --only', async () => {
    const {adapter, wait, now} = fakeCamera('honest');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now, noMove: true, only: new Set([4, 5, 7])});
    assert.equal(result(r, 1), 'PASS');
    assert.equal(result(r, 2), 'SKIP');
    assert.equal(result(r, 4), 'PASS');
    assert.equal(result(r, 5), 'SKIP');
    assert.equal(result(r, 7), 'PASS');
});

test('connect failure skips the rest', async () => {
    const {adapter, wait, now} = fakeCamera('honest');
    adapter.connect = async () => {
        throw new Error('ECONNREFUSED');
    };
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    assert.equal(result(r, 1), 'FAIL');
    assert.match(r.tests[0].summary, /ECONNREFUSED/);
    assert.ok(r.tests.slice(1).every((t) => t.result === 'SKIP'));
});

test('redactSecurity removes the WS-Security header', () => {
    const {redactSecurity} = require('../lib/probe/probe');
    const body =
        '<s:Envelope><s:Header><wsse:Security xmlns:wsse="x"><wsse:UsernameToken><wsse:Username>admin</wsse:Username>' +
        '<wsse:Password Type="#PasswordDigest">abc=</wsse:Password></wsse:UsernameToken></wsse:Security></s:Header>' +
        '<s:Body><GetStatus/></s:Body></s:Envelope>';
    const r = redactSecurity(body);
    assert.doesNotMatch(r, /admin|abc=/);
    assert.match(r, /<s:Body><GetStatus\/><\/s:Body>/);
    assert.equal(redactSecurity(null), null);
});
