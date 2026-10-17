'use strict';
/*
 * CameraAdapter backend over agsh/onvif 1.0.0-rc.3 (installed under the alias 'onvif-rc', MIT).
 *
 * Watch only: this is a release candidate, here so Phase 0 can compare it with 0.8.3.
 * Uses the native promise Onvif class (not the compatibility Cam shim). Raw XML comes
 * from Onvif#lastResponseXml, set on every response (build/onvif.js). Signatures checked
 * against node_modules/onvif-rc/build/{onvif,ptz,media,device}.d.ts.
 * Note continuousMove timeout is milliseconds here (rendered as PT<ms/1000>S).
 */

const {BaseAdapter} = require('./base');

class AgshRcAdapter extends BaseAdapter {
    constructor() {
        super('agsh-rc');
        this.cam = null;
    }

    async _xml(promise) {
        try {
            await promise;
        } catch (err) {
            if (this.cam && this.cam.lastResponseXml && typeof err === 'object') err.raw = this.cam.lastResponseXml;
            throw err;
        }
        return this.cam.lastResponseXml;
    }

    async _rawConnect(conn) {
        const {Onvif} = require('onvif-rc');
        this.cam = new Onvif({
            hostname: conn.hostname,
            port: conn.port,
            username: conn.username,
            password: conn.password,
            timeout: conn.timeoutMs,
            autoConnect: false
        });
        // An EventEmitter 'error' with no listener throws; the probe reports errors from the promises.
        this.cam.on('error', () => {});
        this.cam.on('requestBody', (body) => (this.lastRequest = body));
        await this.cam.connect();
    }

    _rawDeviceInformation() {
        return this._xml(this.cam.device.getDeviceInformation());
    }

    _rawProfiles() {
        return this._xml(this.cam.media.getProfiles());
    }

    _rawPtzConfigurations() {
        return this._xml(this.cam.ptz.getConfigurations());
    }

    _rawPtzConfigurationOptions(configurationToken) {
        return this._xml(this.cam.ptz.getConfigurationOptions({configurationToken}));
    }

    _rawStatus(profileToken) {
        return this._xml(this.cam.ptz.getStatus({profileToken}));
    }

    _rawAbsoluteMove(profileToken, p, speed) {
        return this._xml(this.cam.ptz.absoluteMove({profileToken, position: {x: p.x, y: p.y, zoom: p.zoom}, speed}));
    }

    _rawRelativeMove(profileToken, d) {
        return this._xml(this.cam.ptz.relativeMove({profileToken, translation: {x: d.x, y: d.y, zoom: d.zoom}}));
    }

    _rawContinuousMove(profileToken, v, timeoutMs) {
        return this._xml(
            this.cam.ptz.continuousMove({profileToken, velocity: {x: v.x, y: v.y, zoom: v.zoom}, timeout: timeoutMs})
        );
    }

    _rawStop(profileToken) {
        return this._xml(this.cam.ptz.stop({profileToken}));
    }

    _rawSnapshotUri(profileToken) {
        return this._xml(this.cam.media.getSnapshotUri({profileToken}));
    }

    _rawStreamUri(profileToken) {
        return this._xml(this.cam.media.getStreamUri({profileToken, protocol: 'RTSP'}));
    }
}

module.exports = AgshRcAdapter;
