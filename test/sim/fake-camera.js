'use strict';
/*
 * Fake ONVIF camera implementing the CameraAdapter interface on a clock.
 *
 * mode:
 *  'honest'   AbsoluteMove reaches the target, ContinuousMove moves until Stop or timeout
 *  'ack-only' accepts every move, never changes position
 *  'no-pos'   GetStatus has no Position
 *
 * clock: () => ms. Tests pass a virtual clock; the dev server uses Date.now.
 */

const SPEED = 0.001; // normalised units per ms

function fakeCamera(mode = 'honest', {clock = Date.now, start = {x: 0.1, y: 0, zoom: 0}} = {}) {
    const pos = {...start};
    let target = null;
    let vel = null;
    let velUntil = Infinity;
    let last = clock();
    const calls = [];

    function advance() {
        const now = clock();
        let dt = now - last;
        last = now;
        if (mode === 'ack-only') return;
        if (vel) {
            const moveDt = Math.max(0, Math.min(dt, velUntil - (now - dt)));
            pos.x = Math.max(-1, Math.min(1, pos.x + vel.x * SPEED * moveDt));
            pos.y = Math.max(-1, Math.min(1, pos.y + vel.y * SPEED * moveDt));
            pos.zoom = Math.max(0, Math.min(1, pos.zoom + vel.zoom * SPEED * moveDt));
            if (now >= velUntil) vel = null;
        } else if (target) {
            for (const k of ['x', 'y', 'zoom']) {
                const d = target[k] - pos[k];
                pos[k] += Math.sign(d) * Math.min(Math.abs(d), SPEED * dt);
            }
        }
    }

    const adapter = {
        lib: 'fake-' + mode,
        lastRaw: null,
        lastRequest: null,
        profileToken: null,
        calls,
        connected: false,
        failConnect: null,
        async connect(conn) {
            calls.push(['connect', conn && conn.hostname]);
            if (adapter.failConnect) throw new Error(adapter.failConnect);
            adapter.connected = true;
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
            calls.push(['getStatus']);
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
            calls.push(['absoluteMove', p]);
            vel = null;
            target = {...p};
        },
        async relativeMove(d) {
            advance();
            calls.push(['relativeMove', d]);
            vel = null;
            target = {x: pos.x + d.x, y: pos.y + d.y, zoom: pos.zoom + d.zoom};
        },
        async continuousMove(v, timeoutMs) {
            advance();
            calls.push(['continuousMove', v, timeoutMs]);
            target = null;
            vel = v;
            velUntil = timeoutMs ? clock() + timeoutMs : Infinity;
        },
        async stop() {
            advance();
            calls.push(['stop']);
            vel = null;
            target = null;
        },
        async fetchSnapshot() {
            calls.push(['fetchSnapshot']);
            return {
                uri: 'http://fake/snap.jpg',
                status: 200,
                contentType: 'image/jpeg',
                auth: 'digest',
                tlsAuthorized: null,
                body: FAKE_JPEG
            };
        },
        async getStreamUri() {
            return 'rtsp://fake/1';
        },
        async close() {
            adapter.connected = false;
        }
    };
    return {adapter, pos};
}

// Smallest valid JPEG: a 1x1 grey pixel.
const FAKE_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64'
);

/** Virtual clock for tests: wait() advances time instantly. */
function virtualClock() {
    let t = 0;
    return {now: () => t, wait: async (ms) => void (t += ms)};
}

module.exports = {fakeCamera, virtualClock, FAKE_JPEG};
