'use strict';
/*
 * CameraAdapter backend over node-onvif, as vendored in lib/adapter/vendor/node-onvif.
 *
 * Copied from signalk-onvif-camera 1.3.2 dist/lib (MIT; Copyright (c) 2016-2018 Futomi
 * Hatano, (c) 2022 Karl-Erik Gustafsson; see vendor/node-onvif/LICENSE). Uses the
 * per-service objects (device.services.ptz etc.), not the higher level ptzMove, so every
 * call maps one to one onto an ONVIF operation. Each service method resolves to
 * {soap, formatted, converted, data}; `soap` is the raw response XML.
 *
 * Quirks from the vendored source (modules/service-ptz.js):
 *  - absoluteMove and relativeMove always send Zoom; continuousMove omits Zoom when 0.
 *  - continuousMove Timeout is whole seconds.
 *  - Vector keys are x, y, z (not zoom).
 */

const {BaseAdapter} = require('./base');
const OnvifDevice = require('./vendor/node-onvif/modules/device');

class NodeOnvifAdapter extends BaseAdapter {
    constructor() {
        super('node-onvif');
        this.dev = null;
    }

    async _soap(promise) {
        const r = await promise;
        return r && r.soap;
    }

    _ptz() {
        if (!this.dev.services.ptz) throw new Error('camera did not advertise a PTZ service');
        return this.dev.services.ptz;
    }

    async _rawConnect(conn) {
        this.dev = new OnvifDevice({
            xaddr: `http://${conn.hostname}:${conn.port}/onvif/device_service`,
            user: conn.username,
            pass: conn.password
        });
        await this.dev.init();
    }

    _rawDeviceInformation() {
        return this._soap(this.dev.services.device.getDeviceInformation());
    }

    _rawProfiles() {
        return this._soap(this.dev.services.media.getProfiles());
    }

    _rawPtzConfigurations() {
        return this._soap(this._ptz().getConfigurations());
    }

    _rawPtzConfigurationOptions(ConfigurationToken) {
        return this._soap(this._ptz().getConfigurationOptions({ConfigurationToken}));
    }

    _rawStatus(ProfileToken) {
        return this._soap(this._ptz().getStatus({ProfileToken}));
    }

    _rawAbsoluteMove(ProfileToken, p, speed) {
        const params = {ProfileToken, Position: {x: p.x, y: p.y, z: p.zoom}};
        if (speed) params.Speed = {x: speed.x, y: speed.y, z: speed.zoom};
        return this._soap(this._ptz().absoluteMove(params));
    }

    _rawRelativeMove(ProfileToken, d) {
        return this._soap(this._ptz().relativeMove({ProfileToken, Translation: {x: d.x, y: d.y, z: d.zoom}}));
    }

    _rawContinuousMove(ProfileToken, v, timeoutMs) {
        const params = {ProfileToken, Velocity: {x: v.x, y: v.y, z: v.zoom}};
        if (timeoutMs) params.Timeout = Math.max(1, Math.round(timeoutMs / 1000));
        return this._soap(this._ptz().continuousMove(params));
    }

    _rawStop(ProfileToken) {
        return this._soap(this._ptz().stop({ProfileToken, PanTilt: true, Zoom: true}));
    }

    _rawSnapshotUri(ProfileToken) {
        return this._soap(this.dev.services.media.getSnapshotUri({ProfileToken}));
    }

    _rawStreamUri(ProfileToken) {
        return this._soap(this.dev.services.media.getStreamUri({ProfileToken, Protocol: 'RTSP'}));
    }
}

module.exports = NodeOnvifAdapter;
