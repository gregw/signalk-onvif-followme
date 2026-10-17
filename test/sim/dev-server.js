'use strict';
/*
 * Minimal HTTP server standing in for signalk-server, for route and browser tests:
 *  - serves public/ at /signalk-onvif-followme/ (as dist/interfaces/webapps.js does)
 *  - mounts the plugin's registerWithRouter routes at /plugins/signalk-onvif-followme
 *    on a tiny express-compatible router (the parts the plugin uses: params, query,
 *    JSON body, res.status/json/send/set)
 *  - serves GET /signalk/v2/api/resources/{waypoints,regions}[/:id] from fixtures, as an
 *    object keyed by id
 * The plugin runs against fake cameras (test/sim/fake-camera.js) in a temp data dir.
 *
 * Run standalone for manual poking: node test/sim/dev-server.js [port]
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pluginFactory = require('../..');
const {fakeCamera} = require('./fake-camera');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const PLUGIN_ID = 'signalk-onvif-followme';
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};

/** Express-like router: enough for registerWithRouter. */
function makeRouter() {
    const routes = [];
    const add = (method) => (p, handler) => {
        const names = [];
        const re = new RegExp('^' + p.replace(/:(\w+)/g, (_m, n) => (names.push(n), '([^/]+)')) + '/?$');
        routes.push({method, re, names, handler});
    };
    const router = {get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), routes};
    router.dispatch = async (req, res, subPath) => {
        for (const r of routes) {
            if (r.method !== req.method) continue;
            const m = r.re.exec(subPath);
            if (!m) continue;
            req.params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
            await r.handler(req, res);
            return true;
        }
        return false;
    };
    return router;
}

/** Add the express response helpers the plugin uses. */
function wrapRes(res) {
    res.status = (code) => ((res.statusCode = code), res);
    res.set = (k, v) => (res.setHeader(k, v), res);
    res.json = (o) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(o));
    };
    res.send = (b) => res.end(b);
    return res;
}

function readJson(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : undefined);
            } catch {
                resolve(undefined);
            }
        });
    });
}

const DEFAULT_RESOURCES = {
    waypoints: {
        'wp-pile': {name: 'Pile 7', feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [153.2, -27.4]}}},
        'wp-mouth': {
            name: 'Harbour mouth',
            feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [153.21, -27.41]}}
        },
        'wp-cam': {name: 'Camera', feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [153.19, -27.4]}}}
    },
    regions: {
        'rg-close': {
            name: 'Close in',
            feature: {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [153.19, -27.398],
                            [153.194, -27.398],
                            [153.194, -27.402],
                            [153.19, -27.402],
                            [153.19, -27.398]
                        ]
                    ]
                }
            }
        },
        'rg-harbour': {
            name: 'Harbour',
            feature: {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [153.195, -27.395],
                            [153.215, -27.395],
                            [153.215, -27.415],
                            [153.195, -27.415],
                            [153.195, -27.395]
                        ]
                    ]
                }
            }
        }
    }
};

async function startDevServer({port = 0, resources = DEFAULT_RESOURCES, cameraMode = 'honest', clock = Date.now} = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onvif-followme-'));
    const cameras = [];
    const app = {
        debug: () => {},
        error: (m) => console.error(m),
        getDataDirPath: () => dataDir,
        setPluginStatus: () => {},
        setPluginError: () => {}
    };
    const plugin = pluginFactory(app, {
        createAdapter: () => {
            const c = fakeCamera(cameraMode, {clock});
            cameras.push(c);
            return c.adapter;
        }
    });
    const router = makeRouter();
    plugin.registerWithRouter(router);
    plugin.start({});
    let failWith = null;

    const server = http.createServer(async (req, res) => {
        wrapRes(res);
        const url = new URL(req.url, 'http://x');
        req.query = Object.fromEntries(url.searchParams);
        if (failWith) return res.status(failWith).end();
        const prefix = `/plugins/${PLUGIN_ID}`;
        if (url.pathname.startsWith(prefix + '/')) {
            req.body = req.method === 'GET' ? undefined : await readJson(req);
            const handled = await router.dispatch(req, res, url.pathname.slice(prefix.length));
            if (!handled) res.status(404).json({error: 'no route'});
            return;
        }
        const m = /^\/signalk\/v2\/api\/resources\/(\w+)(?:\/([^/]+))?$/.exec(url.pathname);
        if (m && req.method === 'GET') {
            const coll = resources[m[1]];
            if (!coll) return res.status(404).json({error: 'no provider'});
            if (!m[2]) return res.json(coll);
            return coll[m[2]] ? res.json(coll[m[2]]) : res.status(404).json({error: 'not found'});
        }
        if (url.pathname === `/${PLUGIN_ID}`) return res.status(301).set('Location', `/${PLUGIN_ID}/`).end();
        if (url.pathname.startsWith(`/${PLUGIN_ID}/`)) {
            const rel = url.pathname.slice(PLUGIN_ID.length + 2) || 'index.html';
            const file = path.join(PUBLIC, path.normalize(rel));
            if (!file.startsWith(PUBLIC)) return res.status(403).end();
            return fs.readFile(file, (err, buf) => {
                if (err) return res.status(404).end();
                res.set('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
                res.end(buf);
            });
        }
        res.status(404).end();
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base,
        url: `${base}/${PLUGIN_ID}/`,
        api: `${base}/plugins/${PLUGIN_ID}`,
        plugin,
        cameras,
        dataDir,
        setFail(status) {
            failWith = status;
        },
        async close() {
            plugin.stop();
            await new Promise((resolve) => server.close(resolve));
            fs.rmSync(dataDir, {recursive: true, force: true});
        }
    };
}

module.exports = {startDevServer, makeRouter, DEFAULT_RESOURCES};

if (require.main === module) {
    startDevServer({port: Number(process.argv[2] || 3400)}).then((s) => console.log('webapp at', s.url));
}
