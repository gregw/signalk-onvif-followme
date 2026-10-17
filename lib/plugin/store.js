'use strict';
/*
 * Persistent plugin state: cameras, zones, calibration sets.
 *
 * Kept in <plugin data dir>/state.json (app.getDataDirPath(), signalk-server 2.33.0
 * dist/interfaces/plugins.js:768), not in the plugin options file: the admin UI's plugin
 * config form rewrites that file on submit, which would discard webapp-edited state.
 * Writes are atomic (temp file, fsync, rename) and serialised, so a brownout leaves either
 * the old or the new file, never a torn one.
 *
 * Camera passwords are stored here (the plugin must log in), but never leave the plugin:
 * public views carry `passwordSet` instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const empty = () => ({version: VERSION, cameras: [], zones: [], calibrations: []});

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const bad = (msg) => new HttpError(400, msg);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const optStr = (v, name) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw bad(`${name} must be a string`);
    return v;
};

/** Validate and normalise a position {latitude, longitude, height?}. */
function position(p, name) {
    if (!p || !isNum(p.latitude) || !isNum(p.longitude)) throw bad(`${name} needs numeric latitude and longitude`);
    if (Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) throw bad(`${name} out of range`);
    if (p.height !== undefined && p.height !== null && !isNum(p.height)) throw bad(`${name}.height must be a number`);
    return {latitude: p.latitude, longitude: p.longitude, height: isNum(p.height) ? p.height : 0};
}

function ptz(v) {
    if (!v || !isNum(v.x) || !isNum(v.y) || !isNum(v.zoom)) throw bad('ptz needs numeric x, y, zoom');
    return {x: v.x, y: v.y, zoom: v.zoom};
}

class Store {
    /**
     * @param {string} dir plugin data directory
     * @param {{now?: () => number, log?: (msg: string) => void}} [opts]
     */
    constructor(dir, {now = Date.now, log = () => {}} = {}) {
        this.file = path.join(dir, 'state.json');
        this.now = now;
        this.log = log;
        this.state = empty();
        this._writing = Promise.resolve();
    }

    load() {
        try {
            const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (s && s.version === VERSION) this.state = {...empty(), ...s};
            else this.log(`state.json version ${s && s.version} not understood; starting empty`);
        } catch (err) {
            if (err.code !== 'ENOENT') this.log(`state.json unreadable (${err.message}); starting empty`);
        }
        return this;
    }

    /** Serialised atomic save. Resolves when this state is on disk. */
    save() {
        const json = JSON.stringify(this.state, null, 2);
        const run = async () => {
            const tmp = `${this.file}.${process.pid}.tmp`;
            const fh = await fs.promises.open(tmp, 'w');
            try {
                await fh.writeFile(json);
                await fh.sync();
            } finally {
                await fh.close();
            }
            await fs.promises.rename(tmp, this.file);
        };
        this._writing = this._writing.then(run, run);
        return this._writing;
    }

    // Cameras

    camera(id) {
        const c = this.state.cameras.find((x) => x.id === id);
        if (!c) throw new HttpError(404, `no camera ${id}`);
        return c;
    }

    static publicCamera(c) {
        const {password, ...conn} = c.conn;
        return {...c, conn: {...conn, passwordSet: !!password}};
    }

    /**
     * Create or update a camera. A missing or empty conn.password keeps the stored one.
     * @returns {Promise<object>} the stored camera (public view)
     */
    async putCamera(id, body) {
        if (!body || typeof body !== 'object') throw bad('body must be an object');
        const old = this.state.cameras.find((x) => x.id === id);
        const conn = body.conn || {};
        const hostname = optStr(conn.hostname, 'conn.hostname');
        if (!hostname) throw bad('conn.hostname is required');
        const port = conn.port === undefined || conn.port === '' ? 80 : Number(conn.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('conn.port must be 1..65535');
        const password = optStr(conn.password, 'conn.password') ?? (old ? old.conn.password : undefined);
        const pose = body.pose || {};
        if (pose.type !== undefined && pose.type !== 'fixed') throw bad(`pose.type '${pose.type}' not supported yet`);
        const cam = {
            id,
            name: optStr(body.name, 'name') || id,
            conn: {
                hostname,
                port,
                username: optStr(conn.username, 'conn.username') || '',
                password: password || '',
                profileToken: optStr(conn.profileToken, 'conn.profileToken')
            },
            pose: {
                type: 'fixed',
                position: pose.position ? position(pose.position, 'pose.position') : null,
                waypointId: optStr(pose.waypointId, 'pose.waypointId')
            }
        };
        if (old) Object.assign(old, cam);
        else this.state.cameras.push(cam);
        await this.save();
        return Store.publicCamera(cam);
    }

    async deleteCamera(id) {
        this.camera(id);
        if (this.state.zones.some((z) => z.cameraId === id)) throw new HttpError(409, `camera ${id} is used by a zone`);
        this.state.cameras = this.state.cameras.filter((c) => c.id !== id);
        await this.save();
    }

    // Zones

    zone(id) {
        const z = this.state.zones.find((x) => x.id === id);
        if (!z) throw new HttpError(404, `no zone ${id}`);
        return z;
    }

    /**
     * Zone geometry: the region's GeoJSON Polygon/MultiPolygon geometry is snapshotted into
     * `polygon` so editing or deleting the region later does not change the zone (brief,
     * "Data model"). `ref` remembers which region it came from.
     */
    static geometry(g) {
        if (g === undefined || g === null) return null;
        if (g.frame !== undefined && g.frame !== 'absolute') throw bad(`geometry.frame '${g.frame}' not supported yet`);
        const p = g.polygon;
        if (!p || (p.type !== 'Polygon' && p.type !== 'MultiPolygon') || !Array.isArray(p.coordinates)) {
            throw bad('geometry.polygon must be a GeoJSON Polygon or MultiPolygon geometry');
        }
        return {
            frame: 'absolute',
            ref: optStr(g.ref, 'geometry.ref'),
            refName: optStr(g.refName, 'geometry.refName'),
            polygon: p
        };
    }

    async createZone(body) {
        return this.putZone(crypto.randomUUID(), body, true);
    }

    async putZone(id, body, create = false) {
        if (!body || typeof body !== 'object') throw bad('body must be an object');
        const old = this.state.zones.find((z) => z.id === id);
        if (!old && !create) throw new HttpError(404, `no zone ${id}`);
        this.camera(body.cameraId);
        const mode = body.mode || {type: 'followme'};
        if (mode.type !== 'followme') throw bad(`mode.type '${mode.type}' not supported yet`);
        const zone = {
            id,
            name: optStr(body.name, 'name') || 'Zone',
            cameraId: body.cameraId,
            geometry: Store.geometry(body.geometry),
            mode: {
                type: 'followme',
                target: {context: 'self', path: 'navigation.position'},
                gateSubject: 'target'
            },
            calibrationId: old ? old.calibrationId : crypto.randomUUID()
        };
        if (old) Object.assign(old, zone);
        else {
            this.state.zones.push(zone);
            this.state.calibrations.push({id: zone.calibrationId, zoneId: id, samples: []});
        }
        await this.save();
        return zone;
    }

    async deleteZone(id) {
        const z = this.zone(id);
        this.state.zones = this.state.zones.filter((x) => x.id !== id);
        this.state.calibrations = this.state.calibrations.filter((c) => c.id !== z.calibrationId);
        await this.save();
    }

    // Calibration

    calibration(zoneId) {
        const z = this.zone(zoneId);
        let cal = this.state.calibrations.find((c) => c.id === z.calibrationId);
        if (!cal) {
            cal = {id: z.calibrationId, zoneId, samples: []};
            this.state.calibrations.push(cal);
        }
        return cal;
    }

    /**
     * Store a sample: coordinate plus PTZ only (bearing and range are derived on read).
     * The waypoint id is kept as a label; the sample does not depend on it.
     */
    async addSample(zoneId, {waypointId, name, latitude, longitude}, ptzValue) {
        const cal = this.calibration(zoneId);
        const p = position({latitude, longitude}, 'sample');
        const sample = {
            id: crypto.randomUUID(),
            waypointId: optStr(waypointId, 'waypointId'),
            name: optStr(name, 'name'),
            latitude: p.latitude,
            longitude: p.longitude,
            ptz: ptz(ptzValue),
            capturedAt: new Date(this.now()).toISOString()
        };
        cal.samples.push(sample);
        await this.save();
        return sample;
    }

    sample(zoneId, sampleId) {
        const s = this.calibration(zoneId).samples.find((x) => x.id === sampleId);
        if (!s) throw new HttpError(404, `no sample ${sampleId}`);
        return s;
    }

    async deleteSample(zoneId, sampleId) {
        const cal = this.calibration(zoneId);
        this.sample(zoneId, sampleId);
        cal.samples = cal.samples.filter((s) => s.id !== sampleId);
        await this.save();
    }
}

module.exports = {Store, HttpError, position, ptz};
