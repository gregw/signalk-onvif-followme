'use strict';
/*
 * REST endpoints, mounted by the server at /plugins/signalk-onvif-followme (registerWithRouter,
 * signalk-server 2.33.0 dist/interfaces/plugins.js:927-933). With security on, routes not
 * registered through router.access() are admin only (dist/tokensecurity.js:341-362), which
 * is right for a configuration tool that moves hardware and holds camera credentials.
 * Avoid '/config': the server registers its own GET /config on this router.
 *
 * Wire units are SI: bearings and angles in radians, ranges in metres. PTZ values are in the
 * camera's normalised space. Lat/lon in degrees as in Signal K positions.
 *
 *   GET    /state                              settings, cameras (passwords redacted), zones
 *   PUT    /settings                           {holdS} zone switching hold time
 *   PUT    /cameras/:id                        create or update a camera
 *   DELETE /cameras/:id
 *   POST   /cameras/:id/test                   (re)connect; device info and status
 *   GET    /camera/:id/status                  normalised PTZ
 *   POST   /camera/:id/move                    {mode: continuous|relative|absolute, x, y, zoom, timeoutMs?}
 *   POST   /camera/:id/stop
 *   GET    /camera/:id/snapshot                JPEG bytes
 *   GET    /zones   POST /zones   PUT /zones/:id   DELETE /zones/:id
 *   POST   /zones/:id/view                     fixed mode: store the camera's current PTZ as the view
 *   POST   /zones/:id/view/goto                fixed mode: AbsoluteMove to the stored view
 *   GET    /calibration/:calId                 samples with derived bearing, range, depression, zones
 *   POST   /calibration/:calId                 capture: {waypointId?, name?, latitude, longitude} + GetStatus;
 *                                              replaces any sample with the same name ({replaced: n})
 *   DELETE /calibration/:calId/:sampleId
 *   POST   /calibration/:calId/:sampleId/goto  AbsoluteMove to the sample's PTZ
 *
 * Calibration sets are addressed by id: camera.calibrationId (the default for its zones) or
 * zone.calibrationId (a zone's override, null when it uses the camera's).
 *   GET    /export                             zones and calibration as a JSON download
 *   POST   /import                             replace all zones and calibration from an export
 *   GET    /geometry?cameraId&latitude&longitude  bearing, range, depression, zones containing the point
 *   POST   /cameras/:id/aim-test               {latitude, longitude}: pick the zone (no hold) and move the
 *                                              camera as followme would for a target there; outside all
 *                                              zones nothing moves
 */

const {HttpError, Store} = require('./store');
const geo = require('../engine/geometry');
const {aimOnce, AimError} = require('../engine/aimer');

const CAMERA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Bearing, range and depression from a camera pose to a point; nulls if the pose is unset. */
function derive(camera, p) {
    const pos = camera && camera.pose && camera.pose.position;
    if (!pos) return {bearing: null, range: null, depression: null};
    const {bearing, range} = geo.bearingRange(pos, p);
    return {bearing, range, depression: geo.depression(pos.height || 0, range)};
}

/**
 * @param {object} router express style router
 * @param {() => {store: import('./store').Store, cameras: import('./cameras').CameraManager} | null} running
 */
function addRoutes(router, running) {
    const h = (fn) => async (req, res) => {
        const ctx = running();
        if (!ctx) return res.status(503).json({error: 'plugin not running'});
        try {
            const out = await fn(ctx, req, res);
            if (out !== undefined && !res.headersSent) res.json(out);
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            if (!res.headersSent) res.status(status).json({error: err.message || String(err)});
        }
    };
    const ok = {ok: true};

    router.get(
        '/state',
        h(({store}) => ({
            settings: store.state.settings,
            cameras: store.state.cameras.map(Store.publicCamera),
            zones: store.state.zones
        }))
    );

    router.get(
        '/export',
        h(({store}, req, res) => {
            const day = new Date(store.now()).toISOString().slice(0, 10);
            res.set('Content-Disposition', `attachment; filename="onvif-followme-${day}.json"`);
            res.set('Content-Type', 'application/json');
            res.send(JSON.stringify(store.exportData(), null, 2));
        })
    );

    router.post(
        '/import',
        h(({store}, req) => store.importData(req.body))
    );

    router.put(
        '/settings',
        h(({store}, req) => store.putSettings(req.body))
    );

    router.put(
        '/cameras/:id',
        h(async ({store, cameras}, req) => {
            if (!CAMERA_ID.test(req.params.id)) throw new HttpError(400, 'camera id: letters, digits, - and _, max 32');
            const cam = await store.putCamera(req.params.id, req.body);
            cameras.forget(req.params.id);
            return cam;
        })
    );

    router.delete(
        '/cameras/:id',
        h(async ({store, cameras}, req) => {
            await store.deleteCamera(req.params.id);
            cameras.forget(req.params.id);
            return ok;
        })
    );

    router.post(
        '/cameras/:id/test',
        h(({store, cameras}, req) => cameras.test(store.camera(req.params.id)))
    );

    router.post(
        '/cameras/:id/aim-test',
        h(async ({store, cameras}, req) => {
            const camera = store.camera(req.params.id);
            const body = req.body || {};
            const target = {latitude: Number(body.latitude), longitude: Number(body.longitude)};
            if (!Number.isFinite(target.latitude) || !Number.isFinite(target.longitude)) {
                throw new HttpError(400, 'latitude and longitude are required');
            }
            let result;
            try {
                result = aimOnce({
                    target,
                    zones: store.state.zones.filter((z) => z.cameraId === camera.id),
                    cameraPosition: camera.pose.position,
                    samplesFor: (z) => store.zoneCalibration(z.id).samples
                });
            } catch (err) {
                if (err instanceof AimError) throw new HttpError(409, err.message);
                throw err;
            }
            const where = derive(camera, target);
            if (!result.zone) return {zone: null, moved: false, ...where};
            const {x, y, zoom} = result.ptz;
            await cameras.move(camera, {mode: 'absolute', x, y, zoom});
            return {
                zone: {id: result.zone.id, name: result.zone.geometry.refName, mode: result.zone.mode.type},
                ptz: {x, y, zoom},
                outside: result.ptz.outside || null,
                moved: true,
                ...where
            };
        })
    );

    router.get(
        '/camera/:id/status',
        h(({store, cameras}, req) => cameras.status(store.camera(req.params.id)))
    );

    router.post(
        '/camera/:id/move',
        h(async ({store, cameras}, req) => {
            await cameras.move(store.camera(req.params.id), req.body);
            return ok;
        })
    );

    router.post(
        '/camera/:id/stop',
        h(async ({store, cameras}, req) => {
            await cameras.stop(store.camera(req.params.id));
            return ok;
        })
    );

    router.get(
        '/camera/:id/snapshot',
        h(async ({store, cameras}, req, res) => {
            const s = await cameras.snapshot(store.camera(req.params.id));
            res.set('Content-Type', s.contentType);
            res.set('Cache-Control', 'no-store');
            res.send(s.body);
        })
    );

    router.get(
        '/zones',
        h(({store}) => store.state.zones)
    );
    router.post(
        '/zones',
        h(({store}, req) => store.createZone(req.body))
    );
    router.put(
        '/zones/:id',
        h(({store}, req) => store.putZone(req.params.id, req.body))
    );
    router.delete(
        '/zones/:id',
        h(async ({store}, req) => {
            await store.deleteZone(req.params.id);
            return ok;
        })
    );

    router.post(
        '/zones/:id/view',
        h(async ({store, cameras}, req) => {
            const zone = store.zone(req.params.id);
            if (zone.mode.type !== 'fixed') throw new HttpError(400, 'zone is not in fixed mode');
            const status = await cameras.status(store.camera(zone.cameraId));
            if (status.x === null || status.y === null)
                throw new HttpError(502, 'camera reported no pan/tilt position');
            return store.setFixedView(zone.id, {
                x: status.x,
                y: status.y,
                zoom: status.zoom === null ? 0 : status.zoom
            });
        })
    );

    router.post(
        '/zones/:id/view/goto',
        h(async ({store, cameras}, req) => {
            const zone = store.zone(req.params.id);
            if (zone.mode.type !== 'fixed' || !zone.mode.ptz) throw new HttpError(400, 'zone has no fixed view');
            await cameras.move(store.camera(zone.cameraId), {mode: 'absolute', ...zone.mode.ptz});
            return ok;
        })
    );

    router.get(
        '/calibration/:calId',
        h(({store}, req) => {
            const cal = store.calibration(req.params.calId);
            const camera = store.calibrationCamera(cal);
            const zones = store.state.zones.filter((z) => z.cameraId === camera.id && z.geometry);
            return {
                id: cal.id,
                owner: cal.owner,
                cameraId: camera.id,
                cameraPosition: camera.pose.position,
                samples: cal.samples.map((s) => ({
                    ...s,
                    ...derive(camera, s),
                    zones: zones.filter((z) => geo.pointInPolygon(s, z.geometry.polygon)).map((z) => z.id)
                }))
            };
        })
    );

    router.post(
        '/calibration/:calId',
        h(async ({store, cameras}, req) => {
            const cal = store.calibration(req.params.calId);
            const camera = store.calibrationCamera(cal);
            const status = await cameras.status(camera);
            if (status.x === null || status.y === null)
                throw new HttpError(502, 'camera reported no pan/tilt position');
            const ptz = {x: status.x, y: status.y, zoom: status.zoom === null ? 0 : status.zoom};
            const {sample, replaced} = await store.addSample(cal.id, req.body || {}, ptz);
            return {...sample, ...derive(camera, sample), moveStatus: status.moveStatus, replaced: replaced.length};
        })
    );

    router.delete(
        '/calibration/:calId/:sampleId',
        h(async ({store}, req) => {
            await store.deleteSample(req.params.calId, req.params.sampleId);
            return ok;
        })
    );

    router.post(
        '/calibration/:calId/:sampleId/goto',
        h(async ({store, cameras}, req) => {
            const cal = store.calibration(req.params.calId);
            const s = store.sample(cal.id, req.params.sampleId);
            await cameras.move(store.calibrationCamera(cal), {mode: 'absolute', ...s.ptz});
            return ok;
        })
    );

    router.get(
        '/geometry',
        h(({store}, req) => {
            const p = {latitude: Number(req.query.latitude), longitude: Number(req.query.longitude)};
            if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) {
                throw new HttpError(400, 'latitude and longitude query parameters are required');
            }
            const camera = req.query.cameraId ? store.camera(req.query.cameraId) : null;
            const zones = store.state.zones
                .filter((z) => z.geometry && geo.pointInPolygon(p, z.geometry.polygon))
                .map((z) => z.id);
            return {...derive(camera, p), zones};
        })
    );
}

module.exports = {addRoutes, derive};
