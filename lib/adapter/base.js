'use strict';
/*
 * Shared CameraAdapter behaviour. Backends subclass and implement the _raw* methods,
 * each of which sends one ONVIF request through the backend's library and resolves to
 * the raw response XML (or undefined for moves that return an empty response).
 */

const xml = require('./onvif-xml');
const {getWithAuth} = require('./http-get');

class BaseAdapter {
    constructor(lib) {
        this.lib = lib;
        /** @type {string|null} */
        this.lastRaw = null;
        /** @type {string|null} raw SOAP request of the most recent call, where the backend exposes it */
        this.lastRequest = null;
        /** @type {string|null} */
        this.profileToken = null;
        this.conn = null;
    }

    async connect(conn) {
        this.conn = {port: 80, timeoutMs: 10000, ...conn};
        await this._rawConnect(this.conn);
        const profiles = await this.getProfiles();
        if (this.conn.profileToken) {
            if (!profiles.some((p) => p.token === this.conn.profileToken)) {
                throw new Error(`profile '${this.conn.profileToken}' not found; have ${profiles.map((p) => p.token)}`);
            }
            this.profileToken = this.conn.profileToken;
        } else {
            const ptz = profiles.find((p) => p.ptzConfigurationToken);
            this.profileToken = (ptz || profiles[0] || {}).token || null;
        }
        if (!this.profileToken) throw new Error('camera reported no media profiles');
    }

    async _keep(promise) {
        const raw = await promise;
        if (typeof raw === 'string') this.lastRaw = raw;
        return raw;
    }

    async getDeviceInformation() {
        return xml.deviceInformation(await this._keep(this._rawDeviceInformation()));
    }

    async getProfiles() {
        return xml.profiles(await this._keep(this._rawProfiles()));
    }

    async getPtzConfigurations() {
        return xml.ptzConfigurations(await this._keep(this._rawPtzConfigurations()));
    }

    async getPtzConfigurationOptions(configToken) {
        return xml.ptzConfigurationOptions(await this._keep(this._rawPtzConfigurationOptions(configToken)));
    }

    async getStatus() {
        return xml.ptzStatus(await this._keep(this._rawStatus(this.profileToken)));
    }

    async absoluteMove(p, speed) {
        await this._keep(this._rawAbsoluteMove(this.profileToken, p, speed));
    }

    async relativeMove(d) {
        await this._keep(this._rawRelativeMove(this.profileToken, d));
    }

    async continuousMove(v, timeoutMs) {
        await this._keep(this._rawContinuousMove(this.profileToken, v, timeoutMs));
    }

    async stop() {
        await this._keep(this._rawStop(this.profileToken));
    }

    async getSnapshotUri() {
        return xml.mediaUri(await this._keep(this._rawSnapshotUri(this.profileToken)));
    }

    async getStreamUri() {
        return xml.mediaUri(await this._keep(this._rawStreamUri(this.profileToken)));
    }

    async fetchSnapshot() {
        // The URI is fixed per profile, so ask once per connection, not once per frame.
        const uri = this._snapshotUri || (this._snapshotUri = await this.getSnapshotUri());
        if (!uri) throw new Error('camera returned no snapshot URI');
        // Accept a self-signed certificate only from the camera we connected to. Digest auth
        // means the password itself is not sent, but Basic would be, so never widen this.
        const allowSelfSigned = new URL(uri).hostname === this.conn.hostname;
        const r = await getWithAuth(uri, {
            username: this.conn.username,
            password: this.conn.password,
            timeoutMs: this.conn.timeoutMs,
            allowSelfSigned
        });
        return {
            uri,
            status: r.status,
            contentType: r.headers['content-type'],
            auth: r.auth,
            tlsAuthorized: r.tlsAuthorized,
            body: r.body
        };
    }

    async close() {
        if (this._rawClose) await this._rawClose();
    }
}

module.exports = {BaseAdapter};
