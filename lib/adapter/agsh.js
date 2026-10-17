'use strict';
/*
 * CameraAdapter backend over agsh/onvif 0.8.3 (npm 'onvif', MIT).
 *
 * Uses the callback Cam API, not onvif/promises: the promise wrapper resolves with the
 * parsed data only and drops the raw XML that each callback receives as its third
 * argument. Method names and option shapes checked against node_modules/onvif/lib/ptz.js
 * and media.js at 0.8.3. Media2 is used automatically when the camera advertises it.
 */

const {BaseAdapter} = require('./base');

class AgshAdapter extends BaseAdapter {
    constructor(module = require('onvif'), lib = 'agsh') {
        super(lib);
        this._Cam = module.Cam;
        this.cam = null;
    }

    _call(fn) {
        return new Promise((resolve, reject) => {
            fn((err, _data, xml) => {
                if (err) {
                    if (xml && typeof err === 'object') err.raw = xml;
                    reject(err);
                } else resolve(xml);
            });
        });
    }

    async _rawConnect(conn) {
        this.cam = new this._Cam({
            hostname: conn.hostname,
            port: conn.port,
            username: conn.username,
            password: conn.password,
            timeout: conn.timeoutMs,
            autoconnect: false
        });
        this.cam.on('error', () => {});
        this.cam.on('rawRequest', (body) => (this.lastRequest = body));
        await this._call((cb) => this.cam.connect(cb));
    }

    _rawDeviceInformation() {
        return this._call((cb) => this.cam.getDeviceInformation(cb));
    }

    _rawProfiles() {
        return this._call((cb) => this.cam.getProfiles(cb));
    }

    _rawPtzConfigurations() {
        return this._call((cb) => this.cam.getConfigurations(cb));
    }

    _rawPtzConfigurationOptions(token) {
        return this._call((cb) => this.cam.getConfigurationOptions(token, cb));
    }

    _rawStatus(profileToken) {
        return this._call((cb) => this.cam.getStatus({profileToken}, cb));
    }

    _rawAbsoluteMove(profileToken, p, speed) {
        return this._call((cb) => this.cam.absoluteMove({profileToken, x: p.x, y: p.y, zoom: p.zoom, speed}, cb));
    }

    _rawRelativeMove(profileToken, d) {
        return this._call((cb) => this.cam.relativeMove({profileToken, x: d.x, y: d.y, zoom: d.zoom}, cb));
    }

    _rawContinuousMove(profileToken, v, timeoutMs) {
        return this._call((cb) =>
            this.cam.continuousMove({profileToken, x: v.x, y: v.y, zoom: v.zoom, timeout: timeoutMs}, cb)
        );
    }

    _rawStop(profileToken) {
        return this._call((cb) => this.cam.stop({profileToken}, cb));
    }

    _rawSnapshotUri(profileToken) {
        return this._call((cb) => this.cam.getSnapshotUri({profileToken}, cb));
    }

    _rawStreamUri(profileToken) {
        return this._call((cb) => this.cam.getStreamUri({profileToken, protocol: 'RTSP'}, cb));
    }
}

module.exports = AgshAdapter;
