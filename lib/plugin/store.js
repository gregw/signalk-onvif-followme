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
 * Calibration (wiki/decisions.md): every camera owns one calibration set, used by all its
 * zones (per zone override sets were removed on 2026-10-18). Within a set there is at most one sample per waypoint name: a new capture replaces the old one,
 * even if the waypoint has moved.
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
const EXPORT_FORMAT = 'signalk-onvif-followme';
const EXPORT_VERSION = 2; // 1: zones and calibration only; 2: also cameras (no password) and settings
const CAMERA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/**
 * Global settings: zone switching and follow motion tuning (wiki/decisions.md). Each entry
 * is [default, check]; check returns an error message or null. speed null = camera default.
 */
const SETTINGS = {
    holdS: [5, (v) => num(v, 0, 600, 's')],
    followEnabled: [false, (v) => (typeof v === 'boolean' ? null : 'must be true or false')],
    leadS: [2, (v) => num(v, 0, 30, 's')],
    minIntervalS: [1, (v) => num(v, 0.1, 60, 's')],
    panDeadband: [0.003, (v) => num(v, 0, 0.5, '')],
    tiltDeadband: [0.003, (v) => num(v, 0, 0.5, '')],
    zoomDeadband: [0.02, (v) => num(v, 0, 1, '')],
    speed: [null, (v) => (v === null ? null : num(v, 0.001, 1, ''))],
    waitIdle: [false, (v) => (typeof v === 'boolean' ? null : 'must be true or false')],
    staleS: [10, (v) => num(v, 1, 600, 's')]
};
function num(v, lo, hi, unit) {
    return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
        ? null
        : `must be ${lo}..${hi}${unit && ' ' + unit}`;
}
const DEFAULT_SETTINGS = Object.fromEntries(Object.entries(SETTINGS).map(([k, [d]]) => [k, d]));
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

/** Keep the newest sample per name (by capturedAt, then position in the list); unnamed all kept. */
function latestPerName(samples) {
    const newest = new Map();
    samples.forEach((s, i) => {
        if (!s.name) return;
        const prev = newest.get(s.name);
        if (!prev || String(s.capturedAt || '') >= String(samples[prev].capturedAt || '')) newest.set(s.name, i);
    });
    return samples.filter((s, i) => !s.name || newest.get(s.name) === i);
}

/**
 * Upgrade older state files in place. Returns the upgraded state, or null if unknown.
 * v1 -> v2: calibration moved from per zone to per camera.
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
        const {calibrationId, ...rest} = z;
        out.zones.push({...rest, priority: i + 1});
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
        // Only known, valid settings (drops e.g. edgeMarginM, briefly present on 2026-10-17).
        const settings = {...DEFAULT_SETTINGS};
        for (const [k, [, check]] of Object.entries(SETTINGS)) {
            if (s.settings && k in s.settings && !check(s.settings[k])) settings[k] = s.settings[k];
        }
        this.state = {...empty(), ...s, settings};
        // Zones are named by their region (2026-10-17): drop the old free text name, and any
        // zone without a region, which can no longer be shown or edited.
        let tidied = false;
        this.state.zones = this.state.zones.filter((z) => {
            if ('name' in z) {
                delete z.name;
                tidied = true;
            }
            // Per zone calibration sets were removed (2026-10-18): the camera's set is used.
            if ('calibrationId' in z) {
                if (z.calibrationId) this.log(`state.json: zone ${z.id}: dropping its own calibration set`);
                delete z.calibrationId;
                tidied = true;
            }
            if (z.geometry && z.geometry.ref) return true;
            this.log(`state.json: dropping zone ${z.id} with no region`);
            tidied = true;
            return false;
        });
        const sets = this.state.calibrations.length;
        this.state.calibrations = this.state.calibrations.filter((c) => c.owner && c.owner.type === 'camera');
        if (this.state.calibrations.length !== sets) tidied = true;
        for (const cal of this.state.calibrations) {
            const n = cal.samples.length;
            cal.samples = latestPerName(cal.samples);
            if (cal.samples.length !== n) {
                this.log(
                    `state.json: calibration ${cal.id}: dropped ${n - cal.samples.length} older same-name samples`
                );
                tidied = true;
            }
        }
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

    /** Partial update of global settings; every value is checked before any is applied. */
    async putSettings(body) {
        if (!body || typeof body !== 'object') throw bad('body must be an object');
        const s = {...this.state.settings};
        for (const [k, v] of Object.entries(body)) {
            if (!SETTINGS[k]) throw bad(`unknown setting ${k}`);
            const err = SETTINGS[k][1](v);
            if (err) throw bad(`${k} ${err}`);
            s[k] = v;
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
    /**
     * Validate a camera body into a stored camera record (without calibrationId).
     * A missing or empty conn.password falls back to `keepPassword`.
     */
    static cameraRecord(id, body, keepPassword = '') {
        if (typeof id !== 'string' || !CAMERA_ID.test(id)) throw bad('camera id: letters, digits, - and _, max 32');
        if (!body || typeof body !== 'object') throw bad('body must be an object');
        const conn = body.conn || {};
        const hostname = optStr(conn.hostname, 'conn.hostname');
        if (!hostname) throw bad('conn.hostname is required');
        const port = conn.port === undefined || conn.port === '' ? 80 : Number(conn.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('conn.port must be 1..65535');
        const password = optStr(conn.password, 'conn.password') ?? keepPassword;
        const pose = body.pose || {};
        if (pose.type !== undefined && pose.type !== 'fixed') throw bad(`pose.type '${pose.type}' not supported yet`);
        return {
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
    }

    async putCamera(id, body) {
        const old = this.state.cameras.find((x) => x.id === id);
        const cam = Store.cameraRecord(id, body, old ? old.conn.password : '');
        let calibrationId = old && old.calibrationId;
        if (!calibrationId) {
            const cal = newCalibration({type: 'camera', id});
            this.state.calibrations.push(cal);
            calibrationId = cal.id;
        }
        cam.calibrationId = calibrationId;
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
        const zone = {id, cameraId: body.cameraId, priority, geometry, mode};
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
        await this.save();
    }

    // Export / import: all configuration except camera passwords (wiki/decisions.md).

    exportData() {
        return {
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            exportedAt: new Date(this.now()).toISOString(),
            settings: this.state.settings,
            cameras: this.state.cameras.map((c) => {
                const {password, ...conn} = c.conn;
                return {...c, conn};
            }),
            zones: this.state.zones,
            calibrations: this.state.calibrations
        };
    }

    /**
     * Replace the configuration with the file's. Version 2: cameras, settings, zones and
     * calibration. Version 1 (older files): zones and calibration only; cameras and settings
     * stay. Everything is validated first; on any error nothing changes. Camera passwords are
     * never in the file: each camera keeps the password stored here under the same id, and a
     * camera new to this server has none (listed in needPassword). Zones must name cameras in
     * the resulting configuration. Cameras with no calibration set in the file get an empty one.
     * @returns {Promise<{cameras: number, zones: number, samples: number, needPassword: string[]}>}
     */
    async importData(data) {
        if (!data || data.format !== EXPORT_FORMAT) throw bad(`not a ${EXPORT_FORMAT} export file`);
        if (data.version !== 1 && data.version !== 2) throw bad(`export version ${data.version} not supported`);
        if (!Array.isArray(data.zones) || !Array.isArray(data.calibrations))
            throw bad('zones and calibrations must be arrays');
        const fail = (msg) => {
            throw bad(`import: ${msg}`);
        };

        // Cameras and settings: from the file (v2) or as they are (v1).
        let cameras = this.state.cameras.map((c) => ({...c}));
        let settings = this.state.settings;
        if (data.version === 2) {
            if (!Array.isArray(data.cameras)) fail('cameras must be an array');
            if (!data.settings || typeof data.settings !== 'object') fail('settings must be an object');
            cameras = data.cameras.map((c, i) => {
                if (!c || typeof c.id !== 'string') fail(`cameras[${i}] has no id`);
                const here = this.state.cameras.find((x) => x.id === c.id);
                try {
                    // The file's password, if someone added one, is ignored: never imported.
                    const body = {...c, conn: {...(c.conn || {}), password: undefined}};
                    return Store.cameraRecord(c.id, body, here ? here.conn.password : '');
                } catch (err) {
                    fail(`camera ${c.id}: ${err.message}`);
                }
            });
            if (new Set(cameras.map((c) => c.id)).size !== cameras.length) fail('duplicate camera ids');
            settings = {...DEFAULT_SETTINGS};
            for (const [k, v] of Object.entries(data.settings)) {
                if (!SETTINGS[k]) continue; // from a newer version: ignored
                const err = SETTINGS[k][1](v);
                if (err) fail(`setting ${k} ${err}`);
                settings[k] = v;
            }
        }
        const hasCamera = (id) => cameras.some((c) => c.id === id);

        // Sets owned by a zone (files from before 2026-10-18) are ignored.
        const calibrations = data.calibrations.flatMap((c, i) => {
            if (!c || !optStr(c.id, `calibrations[${i}].id`)) fail(`calibrations[${i}] has no id`);
            const o = c.owner || {};
            if (o.type === 'zone') return [];
            if (o.type !== 'camera') fail(`calibration ${c.id} has no owner`);
            if (!Array.isArray(c.samples)) fail(`calibration ${c.id} has no samples array`);
            const samples = c.samples.map((smp, j) => {
                const where = `calibration ${c.id} sample ${j}`;
                const p = position(smp, where);
                const label = optStr(smp.name, `${where}.name`);
                return {
                    id: optStr(smp.id, `${where}.id`) || crypto.randomUUID(),
                    waypointId: optStr(smp.waypointId, `${where}.waypointId`),
                    name: label && label.trim() ? label.trim() : undefined,
                    latitude: p.latitude,
                    longitude: p.longitude,
                    ptz: ptz(smp.ptz, `${where}.ptz`),
                    capturedAt: optStr(smp.capturedAt, `${where}.capturedAt`)
                };
            });
            return [{id: c.id, owner: {type: o.type, id: o.id}, samples: latestPerName(samples)}];
        });
        const calById = new Map(calibrations.map((c) => [c.id, c]));
        if (calById.size !== calibrations.length) fail('duplicate calibration ids');

        const seen = new Set();
        const zones = data.zones.map((z, i) => {
            if (!z || !optStr(z.id, `zones[${i}].id`)) fail(`zones[${i}] has no id`);
            if (!hasCamera(z.cameraId)) fail(`zone ${z.id} is for camera '${z.cameraId}', which is not configured`);
            if (!Number.isInteger(z.priority)) fail(`zone ${z.id} priority must be an integer`);
            const geometry = Store.geometry(z.geometry);
            const key = `${z.cameraId}/${geometry.ref}`;
            if (seen.has(key)) fail(`two zones for region ${geometry.refName} on camera ${z.cameraId}`);
            seen.add(key);
            return {
                id: z.id,
                cameraId: z.cameraId,
                priority: z.priority,
                geometry,
                mode: Store.mode(z.mode, null)
            };
        });
        const zoneIds = new Set(zones.map((z) => z.id));
        if (zoneIds.size !== zones.length) fail('duplicate zone ids');
        const cameraSets = new Map();
        for (const c of calibrations) {
            if (!hasCamera(c.owner.id)) {
                fail(`calibration ${c.id} is for camera '${c.owner.id}', which is not configured`);
            }
            if (cameraSets.has(c.owner.id)) fail(`two calibration sets for camera ${c.owner.id}`);
            cameraSets.set(c.owner.id, c);
        }

        // Validated: swap in.
        for (const cam of cameras) {
            let cal = cameraSets.get(cam.id);
            if (!cal) {
                cal = newCalibration({type: 'camera', id: cam.id});
                calibrations.push(cal);
            }
            cam.calibrationId = cal.id;
        }
        this.state.cameras = cameras;
        this.state.settings = settings;
        this.state.zones = zones;
        this.state.calibrations = calibrations;
        await this.save();
        return {
            cameras: cameras.length,
            zones: zones.length,
            samples: calibrations.reduce((n, c) => n + c.samples.length, 0),
            needPassword: cameras.filter((c) => !c.conn.password).map((c) => c.id)
        };
    }

    // Calibration

    calibration(id) {
        const cal = this.state.calibrations.find((c) => c.id === id);
        if (!cal) throw new HttpError(404, `no calibration ${id}`);
        return cal;
    }

    /** The camera a calibration set belongs to. */
    calibrationCamera(cal) {
        return this.camera(cal.owner.id);
    }

    /** A camera's calibration set, used by all its zones. */
    cameraCalibration(cameraId) {
        return this.calibration(this.camera(cameraId).calibrationId);
    }

    /**
     * Store a sample: coordinate plus PTZ only (bearing and range are derived on read).
     * The waypoint id is kept as a label; the sample does not depend on it.
     * Any earlier sample in this set with the same (trimmed) name is replaced, wherever it
     * was: the waypoint may have been moved to correct it. Unnamed samples never match.
     * @returns {Promise<{sample: object, replaced: object[]}>}
     */
    async addSample(calId, {waypointId, name, latitude, longitude}, ptzValue) {
        const cal = this.calibration(calId);
        const p = position({latitude, longitude}, 'sample');
        const label = optStr(name, 'name');
        const sample = {
            id: crypto.randomUUID(),
            waypointId: optStr(waypointId, 'waypointId'),
            name: label === undefined ? undefined : label.trim() || undefined,
            latitude: p.latitude,
            longitude: p.longitude,
            ptz: ptz(ptzValue),
            capturedAt: new Date(this.now()).toISOString()
        };
        const replaced = sample.name ? cal.samples.filter((s) => s.name === sample.name) : [];
        cal.samples = cal.samples.filter((s) => !replaced.includes(s));
        cal.samples.push(sample);
        await this.save();
        return {sample, replaced};
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
