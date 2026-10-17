'use strict';
/*
 * Persistent plugin state: cameras, zones, calibration sets, zone switching settings.
 *
 * Kept in <plugin data dir>/state.json (app.getDataDirPath(), signalk-server 2.33.0
 * dist/interfaces/plugins.js:768), not in the plugin options file: the admin UI's plugin
 * config form rewrites that file on submit, which would discard webapp-edited state.
 * Writes are atomic (temp file, fsync, rename) and serialised, so a brownout leaves either
 * the old or the new file, never a torn one.
 *
 * Camera passwords are stored here (the plugin must log in), but never leave the plugin:
 * public views carry `passwordSet` instead.
 *
 * Calibration (wiki/decisions.md): every camera owns a calibration set. A zone uses its
 * camera's set unless it has its own override set (zone.calibrationId not null).
 *
 * Zones are named by their region: geometry.refName, snapshotted with the polygon. A zone
 * must have a region, and a camera has at most one zone per region.
 *
 * Zone modes (tagged union on mode.type):
 *  - followme: aim at the target position through the calibration.
 *  - fixed:    one stored view {x, y, zoom} for any target position inside the zone.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 2;
const DEFAULT_SETTINGS = {holdS: 5};
const empty = () => ({version: VERSION, settings: {...DEFAULT_SETTINGS}, cameras: [], zones: [], calibrations: []});

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

function ptz(v, name = 'ptz') {
    if (!v || !isNum(v.x) || !isNum(v.y) || !isNum(v.zoom)) throw bad(`${name} needs numeric x, y, zoom`);
    return {x: v.x, y: v.y, zoom: v.zoom};
}

const newCalibration = (owner) => ({id: crypto.randomUUID(), owner, samples: []});

/**
 * Upgrade older state files in place. Returns the upgraded state, or null if unknown.
 * v1 -> v2: calibration moved from per zone to per camera with optional zone override.
 * Samples from each v1 zone set are merged into its camera's new set, since v1 never had
 * a reason to calibrate per zone deliberately. Zones get a priority by their order.
 */
function migrate(s, log) {
    if (!s || typeof s !== 'object') return null;
    if (s.version === VERSION) return s;
    if (s.version !== 1) return null;
    const out = {...empty(), cameras: s.cameras || [], zones: [], calibrations: []};
    for (const c of out.cameras) {
        const cal = newCalibration({type: 'camera', id: c.id});
        c.calibrationId = cal.id;
        out.calibrations.push(cal);
    }
    (s.zones || []).forEach((z, i) => {
        const old = (s.calibrations || []).find((c) => c.id === z.calibrationId);
        const cam = out.cameras.find((c) => c.id === z.cameraId);
        const camCal = cam && out.calibrations.find((c) => c.id === cam.calibrationId);
        if (old && camCal) camCal.samples.push(...old.samples);
        out.zones.push({...z, priority: i + 1, calibrationId: null});
    });
    log(`state.json migrated from version 1 to ${VERSION}`);
    return out;
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
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') this.log(`state.json unreadable (${err.message}); starting empty`);
            return this;
        }
        const s = migrate(raw, this.log);
        if (!s) {
            this.log(`state.json version ${raw && raw.version} not understood; starting empty`);
            return this;
        }
        // Only known settings: drops edgeMarginM, briefly present in v2 files on 2026-10-17.
        const holdS = s.settings && isNum(s.settings.holdS) ? s.settings.holdS : DEFAULT_SETTINGS.holdS;
        this.state = {...empty(), ...s, settings: {holdS}};
        // Zones are named by their region (2026-10-17): drop the old free text name, and any
        // zone without a region, which can no longer be shown or edited.
        let tidied = false;
        this.state.zones = this.state.zones.filter((z) => {
            if ('name' in z) {
                delete z.name;
                tidied = true;
            }
            if (z.geometry && z.geometry.ref) return true;
            this.log(`state.json: dropping zone ${z.id} with no region`);
            tidied = true;
            return false;
        });
        if (s !== raw || tidied)
            this.save().catch((err) => this.log(`state.json save after migration failed: ${err.message}`));
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

    // Settings

    /** Zone switching hysteresis: hold time in seconds (wiki/decisions.md). */
    async putSettings(body) {
        const s = {...this.state.settings};
        if (body && body.holdS !== undefined) {
            if (!isNum(body.holdS) || body.holdS < 0 || body.holdS > 600) throw bad('holdS must be 0..600 s');
            s.holdS = body.holdS;
        }
        this.state.settings = s;
        await this.save();
        return s;
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
     * A new camera gets an empty calibration set.
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
        let calibrationId = old && old.calibrationId;
        if (!calibrationId) {
            const cal = newCalibration({type: 'camera', id});
            this.state.calibrations.push(cal);
            calibrationId = cal.id;
        }
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
            },
            calibrationId
        };
        if (old) Object.assign(old, cam);
        else this.state.cameras.push(cam);
        await this.save();
        return Store.publicCamera(cam);
    }

    async deleteCamera(id) {
        const c = this.camera(id);
        if (this.state.zones.some((z) => z.cameraId === id)) throw new HttpError(409, `camera ${id} is used by a zone`);
        this.state.cameras = this.state.cameras.filter((x) => x.id !== id);
        this.state.calibrations = this.state.calibrations.filter((x) => x.id !== c.calibrationId);
        await this.save();
    }

    // Zones

    zone(id) {
        const z = this.state.zones.find((x) => x.id === id);
        if (!z) throw new HttpError(404, `no zone ${id}`);
        return z;
    }

    /**
     * Zone geometry from a Signal K region: its GeoJSON Polygon/MultiPolygon geometry and name
     * are snapshotted into `polygon` and `refName`, so editing or deleting the region later
     * does not change the zone (brief, "Data model"). `ref` is the region id. Required.
     */
    static geometry(g) {
        if (!g || typeof g !== 'object') throw bad('a zone needs a region (geometry)');
        if (!optStr(g.ref, 'geometry.ref')) throw bad('geometry.ref (region id) is required');
        if (!optStr(g.refName, 'geometry.refName')) throw bad('geometry.refName (region name) is required');
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

    /** Mode tagged union. A fixed zone may be saved before its view is captured (ptz null). */
    static mode(m, old) {
        const type = (m && m.type) || 'followme';
        const target = {context: 'self', path: 'navigation.position'};
        if (type === 'followme') return {type, target, gateSubject: 'target'};
        if (type === 'fixed') {
            const keep = old && old.type === 'fixed' ? old.ptz : null;
            const v = m.ptz === undefined ? keep : m.ptz === null ? null : ptz(m.ptz, 'mode.ptz');
            return {type, target, gateSubject: 'target', ptz: v};
        }
        throw bad(`mode.type '${type}' not supported`);
    }

    async createZone(body) {
        return this.putZone(crypto.randomUUID(), body, true);
    }

    /**
     * Create or update a zone.
     * priority: lower number wins when entering an overlap; default after the last zone.
     * calibrationOverride: true gives the zone its own calibration set (kept while true);
     * false drops it and the zone uses its camera's set.
     */
    async putZone(id, body, create = false) {
        if (!body || typeof body !== 'object') throw bad('body must be an object');
        const old = this.state.zones.find((z) => z.id === id);
        if (!old && !create) throw new HttpError(404, `no zone ${id}`);
        this.camera(body.cameraId);
        let priority = body.priority;
        if (priority === undefined || priority === null || priority === '') {
            priority = old ? old.priority : Math.max(0, ...this.state.zones.map((z) => z.priority || 0)) + 1;
        }
        if (!Number.isInteger(priority)) throw bad('priority must be an integer');
        const geometry = body.geometry === undefined && old ? old.geometry : Store.geometry(body.geometry);
        const clash = this.state.zones.find(
            (z) => z.id !== id && z.cameraId === body.cameraId && z.geometry.ref === geometry.ref
        );
        if (clash)
            throw new HttpError(409, `camera ${body.cameraId} already has a zone for region ${geometry.refName}`);
        const mode = Store.mode(body.mode, old && old.mode);
        // All validation is above: nothing below may throw, so a rejected request changes nothing.
        const wantOverride =
            body.calibrationOverride === undefined ? !!(old && old.calibrationId) : !!body.calibrationOverride;
        let calibrationId = old ? old.calibrationId : null;
        if (wantOverride && !calibrationId) {
            const cal = newCalibration({type: 'zone', id});
            this.state.calibrations.push(cal);
            calibrationId = cal.id;
        } else if (!wantOverride && calibrationId) {
            this.state.calibrations = this.state.calibrations.filter((c) => c.id !== calibrationId);
            calibrationId = null;
        }
        const zone = {
            id,
            cameraId: body.cameraId,
            priority,
            geometry,
            mode,
            calibrationId
        };
        if (old) Object.assign(old, zone);
        else this.state.zones.push(zone);
        await this.save();
        return zone;
    }

    /** Set a fixed zone's view (e.g. from the camera's current status). */
    async setFixedView(zoneId, ptzValue) {
        const z = this.zone(zoneId);
        if (z.mode.type !== 'fixed') throw bad(`zone ${zoneId} is not in fixed mode`);
        z.mode.ptz = ptz(ptzValue);
        await this.save();
        return z;
    }

    async deleteZone(id) {
        const z = this.zone(id);
        this.state.zones = this.state.zones.filter((x) => x.id !== id);
        if (z.calibrationId) this.state.calibrations = this.state.calibrations.filter((c) => c.id !== z.calibrationId);
        await this.save();
    }

    // Calibration

    calibration(id) {
        const cal = this.state.calibrations.find((c) => c.id === id);
        if (!cal) throw new HttpError(404, `no calibration ${id}`);
        return cal;
    }

    /** The camera a calibration set belongs to (directly, or through its zone). */
    calibrationCamera(cal) {
        if (cal.owner.type === 'camera') return this.camera(cal.owner.id);
        return this.camera(this.zone(cal.owner.id).cameraId);
    }

    /** The calibration set a zone uses: its override, or its camera's. */
    zoneCalibration(zoneId) {
        const z = this.zone(zoneId);
        return this.calibration(z.calibrationId || this.camera(z.cameraId).calibrationId);
    }

    /**
     * Store a sample: coordinate plus PTZ only (bearing and range are derived on read).
     * The waypoint id is kept as a label; the sample does not depend on it.
     */
    async addSample(calId, {waypointId, name, latitude, longitude}, ptzValue) {
        const cal = this.calibration(calId);
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

    sample(calId, sampleId) {
        const s = this.calibration(calId).samples.find((x) => x.id === sampleId);
        if (!s) throw new HttpError(404, `no sample ${sampleId}`);
        return s;
    }

    async deleteSample(calId, sampleId) {
        const cal = this.calibration(calId);
        this.sample(calId, sampleId);
        cal.samples = cal.samples.filter((s) => s.id !== sampleId);
        await this.save();
    }
}

module.exports = {Store, HttpError, position, ptz, migrate, DEFAULT_SETTINGS};
