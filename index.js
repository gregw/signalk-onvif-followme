'use strict';
/*
 * signalk-onvif-followme: Signal K server plugin entry point.
 *
 * Phase 1: configuration and calibration only, no auto-aiming yet.
 *
 * Layers (keep them distinct):
 *  - Data model paths consumed: none yet (followme will read self navigation.position).
 *  - Data model paths published: none.
 *  - REST endpoints: /plugins/signalk-onvif-followme/* (lib/plugin/routes.js), admin only
 *    when security is on.
 *  - Resources read: waypoints and regions, by the webapp directly from
 *    /signalk/v2/api/resources/{waypoints,regions} (dist/api/resources/index.js).
 *  - Internal plugin state: cameras, zones, calibration in <data dir>/state.json
 *    (lib/plugin/store.js); one CameraAdapter per camera (lib/plugin/cameras.js).
 *
 * The webapp in public/ is served by the server at /signalk-onvif-followme/
 * (dist/interfaces/webapps.js mountWebModules).
 */

const {Store} = require('./lib/plugin/store');
const {CameraManager} = require('./lib/plugin/cameras');
const {addRoutes} = require('./lib/plugin/routes');
const {createAdapter, LIBS} = require('./lib/adapter');

const PLUGIN_ID = 'signalk-onvif-followme';

module.exports = function (app, deps = {}) {
    const plugin = {
        id: PLUGIN_ID,
        name: 'ONVIF Follow Me',
        description: 'Aim a fixed ONVIF PTZ camera at your vessel while it is inside a zone. Configure in the webapp.'
    };

    // The only option here is the backend; cameras, zones and calibration are edited in the
    // webapp and stored separately (see lib/plugin/store.js for why).
    plugin.schema = {
        type: 'object',
        description: 'Cameras, zones and calibration are configured in the ONVIF Follow Me webapp.',
        properties: {
            lib: {type: 'string', title: 'ONVIF library', enum: LIBS, default: 'agsh'}
        }
    };

    let ctx = null;

    plugin.start = function (options = {}) {
        const log = (m) => app.debug(m);
        const store = new Store(app.getDataDirPath(), {log}).load();
        const cameras = new CameraManager({
            createAdapter: deps.createAdapter || createAdapter,
            lib: LIBS.includes(options.lib) ? options.lib : 'agsh',
            log
        });
        ctx = {store, cameras};
        const n = store.state.cameras.length;
        app.setPluginStatus(`Started: ${n} camera${n === 1 ? '' : 's'}, ${store.state.zones.length} zones`);
    };

    plugin.stop = function () {
        if (ctx) ctx.cameras.closeAll();
        ctx = null;
    };

    // Handlers read ctx per request: the router outlives start/stop cycles.
    plugin.registerWithRouter = function (router) {
        addRoutes(router, () => ctx);
    };

    return plugin;
};
