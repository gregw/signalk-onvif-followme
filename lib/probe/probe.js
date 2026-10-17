'use strict';
/*
 * Phase 0 camera capability probe (brief: "Phase 0").
 *
 * Runs the numbered tests against one CameraAdapter and returns a report object.
 * Every adapter call is recorded with its arguments and raw response XML, so the
 * report shows what the camera actually said, not just pass/fail.
 *
 * Test 5 (AbsoluteMove honoured on readback) is the gate: if it fails, do not build
 * the plugin on absolute positioning.
 */

const {axisError, pickTargets, waitSettled, moved, sleep} = require('./ptz-math');

const TESTS = [
    [1, 'Connect and GetDeviceInformation'],
    [2, 'GetProfiles and PTZ GetConfigurations'],
    [3, 'PTZ GetConfigurationOptions (spaces and limits)'],
    [4, 'GetStatus reports Position'],
    [5, 'AbsoluteMove tracked by readback (gate)'],
    [6, 'ContinuousMove and Stop'],
    [7, 'GetSnapshotUri and fetch JPEG'],
    [8, 'RelativeMove (optional)'],
    [9, 'GetStreamUri (optional)']
];

const isJpeg = (b) => b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

function pickSpace(spaces, name, preferSuffix) {
    const all = spaces.filter((s) => s.name === name);
    return all.find((s) => s.uri && s.uri.endsWith(preferSuffix)) || all[0];
}

/**
 * @param {import('../adapter').CameraAdapter} adapter
 * @param {import('../adapter').CameraConn} conn
 * @param {object} [opts]
 * @param {Set<number>} [opts.only] test ids to run (connect always runs)
 * @param {boolean} [opts.noMove] skip tests that move the camera
 * @param {number} [opts.tol] max abs readback error per axis, normalised units
 * @param {number} [opts.settleTimeoutMs]
 * @param {(line: string) => void} [opts.log]
 * @param {(ms: number) => Promise<void>} [opts.wait] injectable for tests
 * @param {() => number} [opts.now] injectable for tests
 */
async function runProbe(adapter, conn, opts = {}) {
    const {
        only,
        noMove = false,
        tol = 0.02,
        settleTimeoutMs = 20000,
        log = () => {},
        wait = sleep,
        now = Date.now
    } = opts;
    const report = {
        lib: adapter.lib,
        startedAt: new Date().toISOString(),
        conn: {hostname: conn.hostname, port: conn.port || 80, username: conn.username},
        options: {noMove, tol, settleTimeoutMs},
        tests: [],
        capabilities: {},
        gate: null,
        snapshot: null
    };
    const cap = report.capabilities;
    let current = null;
    let movedCamera = false;

    async function call(method, ...args) {
        const entry = {call: method, args, raw: null};
        current.calls.push(entry);
        adapter.lastRaw = null;
        adapter.lastRequest = null;
        try {
            const r = await adapter[method](...args);
            entry.raw = adapter.lastRaw;
            entry.request = redactSecurity(adapter.lastRequest);
            if (r !== undefined && !Buffer.isBuffer(r) && !(r && Buffer.isBuffer(r.body))) entry.result = r;
            if (/Move$/.test(method)) movedCamera = true;
            return r;
        } catch (err) {
            entry.raw = (err && err.raw) || adapter.lastRaw;
            entry.request = redactSecurity(adapter.lastRequest);
            entry.error = String((err && err.message) || err);
            throw err;
        }
    }

    const settle = (extra = {}) =>
        waitSettled(() => call('getStatus'), {timeoutMs: settleTimeoutMs, wait, now, minWaitMs: 500, ...extra});

    async function test(id, fn, quiet = false) {
        const name = TESTS.find((t) => t[0] === id)[1];
        current = {id, name, result: 'SKIP', summary: '', details: {}, calls: []};
        report.tests.push(current);
        if (only && !only.has(id) && id !== 1) {
            current.summary = 'not selected';
            return;
        }
        if (!quiet) log(`[${adapter.lib}] ${id}. ${name} ...`);
        try {
            const r = await fn(current.details);
            current.result = r.result;
            current.summary = r.summary;
        } catch (err) {
            current.result = 'FAIL';
            current.summary = `error: ${(err && err.message) || err}`;
        }
        if (!quiet) log(`[${adapter.lib}] ${id}. ${current.result}  ${current.summary}`);
    }

    const skip = (summary) => ({result: 'SKIP', summary});
    const needMove = () => (noMove ? skip('--no-move') : null);

    await test(1, async (d) => {
        await call('connect', conn);
        const info = await call('getDeviceInformation');
        d.deviceInformation = info;
        d.profileToken = adapter.profileToken;
        cap.device = info;
        return {result: 'PASS', summary: `${info.manufacturer} ${info.model} fw ${info.firmwareVersion}`};
    });
    const connected = report.tests[0].result === 'PASS';
    if (!connected) {
        for (const [id] of TESTS.slice(1)) {
            await test(id, async () => skip('connect failed'), true);
        }
        return finish();
    }

    let configToken = null;
    await test(2, async (d) => {
        const profiles = await call('getProfiles');
        d.profiles = profiles;
        const chosen = profiles.find((p) => p.token === adapter.profileToken);
        d.chosenProfile = chosen;
        let configs = [];
        try {
            configs = await call('getPtzConfigurations');
        } catch (err) {
            d.ptzConfigurationsError = String(err.message || err);
        }
        d.ptzConfigurations = configs;
        configToken = (chosen && chosen.ptzConfigurationToken) || (configs[0] && configs[0].token) || null;
        cap.profileToken = adapter.profileToken;
        cap.ptzConfigurationToken = configToken;
        cap.ptzConfigurations = configs;
        if (!chosen || !chosen.ptzConfigurationToken) {
            return {result: 'FAIL', summary: `profile ${adapter.profileToken} has no PTZConfiguration`};
        }
        return {
            result: configs.length ? 'PASS' : 'FAIL',
            summary: `${profiles.length} profiles; using ${adapter.profileToken} (PTZ config ${configToken}); ${configs.length} PTZ configs`
        };
    });

    // Default to the ONVIF generic spaces if the camera does not tell us.
    let absSpace = {x: {min: -1, max: 1}, y: {min: -1, max: 1}, zoom: {min: 0, max: 1}, source: 'assumed generic'};
    await test(3, async (d) => {
        if (!configToken) return skip('no PTZ configuration token');
        const o = await call('getPtzConfigurationOptions', configToken);
        d.options = o;
        cap.spaces = o.spaces;
        cap.ptzTimeout = o.ptzTimeout;
        const pt = pickSpace(o.spaces, 'AbsolutePanTiltPositionSpace', 'PositionGenericSpace');
        const z = pickSpace(o.spaces, 'AbsoluteZoomPositionSpace', 'PositionGenericSpace');
        if (pt) absSpace = {x: pt.x, y: pt.y, zoom: z ? z.x : absSpace.zoom, source: 'GetConfigurationOptions'};
        cap.absoluteSpace = {panTilt: pt || null, zoom: z || null};
        const names = [...new Set(o.spaces.map((s) => s.name))].join(', ');
        if (!pt) return {result: 'FAIL', summary: `no AbsolutePanTiltPositionSpace; spaces: ${names}`};
        const fmt = (r) => (r ? `[${r.min},${r.max}]` : '?');
        return {
            result: 'PASS',
            summary: `abs pan ${fmt(pt.x)} tilt ${fmt(pt.y)} zoom ${fmt(z && z.x)}; spaces: ${names}`
        };
    });
    report.capabilities.commandSpace = absSpace;

    let initial = null;
    await test(4, async (d) => {
        const s = await call('getStatus');
        d.status = s;
        cap.statusPosition = {x: s.x !== null, y: s.y !== null, zoom: s.zoom !== null, moveStatus: s.moveStatus};
        if (s.x === null || s.y === null) return {result: 'FAIL', summary: 'GetStatus has no PanTilt Position'};
        initial = s;
        const outside = ['x', 'y', 'zoom'].filter((k) => {
            const r = absSpace[k];
            return s[k] !== null && r && (s[k] < r.min - 1e-6 || s[k] > r.max + 1e-6);
        });
        return {
            result: 'PASS',
            summary:
                `x=${s.x} y=${s.y} zoom=${s.zoom === null ? 'not reported' : s.zoom} moveStatus=${s.moveStatus}` +
                (outside.length ? `; WARNING ${outside} outside command space` : '')
        };
    });

    await test(5, async (d) => {
        const n = needMove();
        if (n) return n;
        if (!initial) return skip('no status position to compare against');
        const targets = pickTargets(absSpace);
        d.targets = [];
        let worst = 0;
        let anyMoved = false;
        let prev = initial;
        for (const t of targets) {
            await call('absoluteMove', t);
            const r = await settle();
            const s = r.status;
            const err = {x: axisError(t.x, s.x), y: axisError(t.y, s.y), zoom: axisError(t.zoom, s.zoom)};
            const ok =
                ['x', 'y'].every((k) => err[k] !== null && err[k] <= tol) && (err.zoom === null || err.zoom <= tol);
            if (moved(prev, s, tol)) anyMoved = true;
            prev = s;
            worst = Math.max(worst, ...Object.values(err).filter((v) => v !== null));
            d.targets.push({
                target: t,
                readback: s,
                error: err,
                ok,
                settled: r.settled,
                settleMs: r.elapsedMs,
                samples: r.samples
            });
            log(
                `    target ${JSON.stringify(t)} -> x=${s.x} y=${s.y} zoom=${s.zoom} ` +
                    `err=${JSON.stringify(err)} ${ok ? 'ok' : 'MISS'} (${r.settled ? 'settled' : 'NOT settled'} ${r.elapsedMs}ms)`
            );
        }
        const pass = d.targets.every((t) => t.ok);
        report.gate = {absoluteMoveHonoured: pass, worstError: +worst.toFixed(4), anyMoved, tol};
        if (pass)
            return {
                result: 'PASS',
                summary: `${targets.length}/${targets.length} targets within ${tol} (worst ${worst.toFixed(4)})`
            };
        const hits = d.targets.filter((t) => t.ok).length;
        return {
            result: 'FAIL',
            summary: anyMoved
                ? `${hits}/${targets.length} targets within ${tol}, worst ${worst.toFixed(4)}`
                : 'readback never changed: AbsoluteMove ACKed but not executed (or status is stale)'
        };
    });

    await test(6, async (d) => {
        const n = needMove();
        if (n) return n;
        const start = (await settle()).status;
        if (start.x === null) return skip('no status position');
        // Move towards the middle so we do not run into an end stop.
        const mid = (absSpace.x.min + absSpace.x.max) / 2;
        const v = {x: start.x > mid ? -0.3 : 0.3, y: 0, zoom: 0};
        d.start = start;
        d.velocity = v;
        await call('continuousMove', v);
        await wait(1500);
        const during = await call('getStatus');
        await call('stop');
        const atStop = await call('getStatus');
        const after = (await settle()).status;
        await wait(1500);
        const later = await call('getStatus');
        Object.assign(d, {during, atStop, after, later});
        const dx = during.x - start.x;
        const coast = Math.abs(after.x - atStop.x);
        const drift = Math.abs(later.x - after.x);
        d.panDeltaWhileMoving = dx;
        d.coastAfterStop = coast;
        d.driftAfterSettle = drift;
        const movedAsCommanded = Math.sign(dx) === Math.sign(v.x) && Math.abs(dx) > 0.002;
        const stopped = drift <= 0.002;
        cap.continuousMove = {
            moves: movedAsCommanded,
            stops: stopped,
            panDelta1500ms: +dx.toFixed(4),
            coast: +coast.toFixed(4)
        };
        if (!movedAsCommanded)
            return {result: 'FAIL', summary: `pan did not move as commanded (delta ${dx.toFixed(4)} for v=${v.x})`};
        if (!stopped)
            return {result: 'FAIL', summary: `still moving after Stop (drift ${drift.toFixed(4)} over 1.5 s)`};
        return {
            result: 'PASS',
            summary: `pan moved ${dx.toFixed(4)} in 1.5 s at v=${v.x}; coasted ${coast.toFixed(4)} after Stop; then still`
        };
    });

    await test(7, async (d) => {
        const snap = await call('fetchSnapshot');
        d.uri = snap.uri;
        d.status = snap.status;
        d.contentType = snap.contentType;
        d.auth = snap.auth;
        d.tlsAuthorized = snap.tlsAuthorized;
        d.bytes = snap.body.length;
        cap.snapshot = {
            uriHost: safeHost(snap.uri),
            auth: snap.auth,
            status: snap.status,
            contentType: snap.contentType
        };
        if (snap.status !== 200) return {result: 'FAIL', summary: `HTTP ${snap.status} (auth tried: ${snap.auth})`};
        if (!isJpeg(snap.body)) return {result: 'FAIL', summary: `HTTP 200 but not a JPEG (${snap.contentType})`};
        report.snapshot = snap.body;
        const tls = snap.tlsAuthorized === false ? ', self-signed TLS accepted' : '';
        return {result: 'PASS', summary: `${snap.body.length} byte JPEG, auth ${snap.auth}${tls}`};
    });

    await test(8, async (d) => {
        const n = needMove();
        if (n) return n;
        const start = (await settle()).status;
        if (start.x === null) return skip('no status position');
        const mid = (absSpace.x.min + absSpace.x.max) / 2;
        const step = start.x > mid ? -0.05 : 0.05;
        await call('relativeMove', {x: step, y: 0, zoom: 0});
        const end = (await settle()).status;
        const dx = end.x - start.x;
        Object.assign(d, {start, step, end, panDelta: dx});
        cap.relativeMove = {step, panDelta: +dx.toFixed(4)};
        if (Math.abs(dx) < 0.002) return {result: 'FAIL', summary: `no movement for x step ${step}`};
        const ok = Math.abs(dx - step) <= tol;
        return {
            result: ok ? 'PASS' : 'INFO',
            summary: `step ${step} moved pan ${dx.toFixed(4)}` + (ok ? '' : ' (moves, but not in position units)')
        };
    });

    await test(9, async (d) => {
        const uri = await call('getStreamUri');
        d.uri = uri;
        cap.streamUri = {scheme: uri ? uri.split(':')[0] : null, host: safeHost(uri)};
        return uri ? {result: 'PASS', summary: redact(uri)} : {result: 'FAIL', summary: 'no URI'};
    });

    if (movedCamera && initial) {
        current = {
            id: 'restore',
            name: 'Restore starting position',
            result: 'INFO',
            summary: '',
            details: {},
            calls: []
        };
        report.tests.push(current);
        try {
            await call('absoluteMove', {x: initial.x, y: initial.y, zoom: initial.zoom === null ? 0 : initial.zoom});
            const r = await settle();
            current.summary = `back at x=${r.status.x} y=${r.status.y} zoom=${r.status.zoom}`;
        } catch (err) {
            current.summary = `restore failed: ${err.message || err}`;
        }
        log(`[${adapter.lib}] restore: ${current.summary}`);
    }

    return finish();

    function finish() {
        report.finishedAt = new Date().toISOString();
        return report;
    }
}

function safeHost(uri) {
    try {
        return new URL(uri).host;
    } catch {
        return null;
    }
}

/** Drop the WS-Security header (username, nonce and an offline-crackable PasswordDigest). */
function redactSecurity(body) {
    if (typeof body !== 'string') return body;
    return body.replace(/<(\w+:)?Security\b[\s\S]*?<\/(\w+:)?Security>/g, '<Security>redacted</Security>');
}

/** Strip any user:pass@ from a URI before printing it. */
function redact(uri) {
    return String(uri).replace(/\/\/[^/@]*@/, '//***@');
}

module.exports = {runProbe, TESTS, redact, redactSecurity};
