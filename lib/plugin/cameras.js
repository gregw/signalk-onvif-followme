'use strict';
/*
 * CameraManager: owns one CameraAdapter per configured camera.
 *
 *  - Connects lazily on first use, and again after any error (the adapter is dropped, so
 *    a camera reboot or network drop recovers on the next request).
 *  - After a failed connect, requests fail fast with the same error for `retryMs` instead
 *    of each waiting out a full timeout.
 *  - PTZ commands for one camera run strictly one at a time (brief: never overlap moves).
 *  - Snapshots are not queued behind PTZ commands, but concurrent snapshot requests share
 *    one fetch, so a 1 fps poll cannot pile up against a slow camera.
 *  - A changed connection config (host, port, credentials, profile) replaces the adapter.
 */

const {HttpError} = require('./store');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

class CameraManager {
    /**
     * @param {object} opts
     * @param {(lib: string) => import('../adapter').CameraAdapter} opts.createAdapter
     * @param {string} [opts.lib] adapter backend, default 'agsh'
     * @param {number} [opts.retryMs] fail fast window after a connect failure
     * @param {() => number} [opts.now]
     * @param {(msg: string) => void} [opts.log]
     */
    constructor({createAdapter, lib = 'agsh', retryMs = 5000, now = Date.now, log = () => {}}) {
        this.createAdapter = createAdapter;
        this.lib = lib;
        this.retryMs = retryMs;
        this.now = now;
        this.log = log;
        /** @type {Map<string, object>} */
        this.entries = new Map();
    }

    _entry(cam) {
        const key = JSON.stringify(cam.conn);
        let e = this.entries.get(cam.id);
        if (e && e.key !== key) {
            this._drop(e);
            e = null;
        }
        if (!e) {
            e = {key, adapter: null, connecting: null, failedAt: 0, error: null, queue: Promise.resolve(), snap: null};
            this.entries.set(cam.id, e);
        }
        return e;
    }

    _drop(e) {
        if (e.adapter) e.adapter.close().catch(() => {});
        e.adapter = null;
        e.connecting = null;
    }

    async _connected(cam, e) {
        if (e.adapter) return e.adapter;
        if (e.error && this.now() - e.failedAt < this.retryMs) throw e.error;
        if (!e.connecting) {
            const adapter = this.createAdapter(this.lib);
            e.connecting = adapter.connect({...cam.conn}).then(
                () => {
                    e.adapter = adapter;
                    e.connecting = null;
                    e.error = null;
                    this.log(
                        `camera ${cam.id}: connected (${cam.conn.hostname}:${cam.conn.port}, profile ${adapter.profileToken})`
                    );
                    return adapter;
                },
                (err) => {
                    e.connecting = null;
                    e.error = new HttpError(502, `camera ${cam.id} connect failed: ${err.message || err}`);
                    e.failedAt = this.now();
                    adapter.close().catch(() => {});
                    throw e.error;
                }
            );
        }
        return e.connecting;
    }

    /** Run fn(adapter) after any earlier command for this camera has finished. */
    run(cam, fn) {
        const e = this._entry(cam);
        const job = e.queue.then(async () => {
            const adapter = await this._connected(cam, e);
            try {
                return await fn(adapter);
            } catch (err) {
                // Unknown state after a failed request: reconnect next time.
                if (e.adapter === adapter) this._drop(e);
                if (err instanceof HttpError) throw err;
                throw new HttpError(502, `camera ${cam.id}: ${err.message || err}`);
            }
        });
        e.queue = job.catch(() => {});
        return job;
    }

    /** Connect (or reconnect) and report what the camera says about itself. */
    async test(cam) {
        const e = this._entry(cam);
        e.error = null;
        this._drop(e);
        return this.run(cam, async (a) => ({
            profileToken: a.profileToken,
            device: await a.getDeviceInformation(),
            status: await a.getStatus()
        }));
    }

    status(cam) {
        return this.run(cam, (a) => a.getStatus());
    }

    /**
     * @param {object} cam
     * @param {{mode: string, x: number, y: number, zoom: number, timeoutMs?: number}} m
     *   continuous: velocity; the camera stops by itself after timeoutMs (default 2000) so a
     *   lost "release" can never leave it spinning. relative: translation. absolute: position.
     */
    async move(cam, m) {
        if (!m || !isNum(m.x) || !isNum(m.y) || !isNum(m.zoom))
            throw new HttpError(400, 'move needs numeric x, y, zoom');
        const v = {x: m.x, y: m.y, zoom: m.zoom};
        if (m.mode === 'continuous') {
            const t = m.timeoutMs === undefined ? 2000 : Number(m.timeoutMs);
            if (!isNum(t) || t < 100 || t > 10000) throw new HttpError(400, 'timeoutMs must be 100..10000');
            return this.run(cam, (a) => a.continuousMove(v, t));
        }
        if (m.mode === 'relative') return this.run(cam, (a) => a.relativeMove(v));
        if (m.mode === 'absolute') return this.run(cam, (a) => a.absoluteMove(v));
        throw new HttpError(400, `mode must be continuous, relative or absolute`);
    }

    stop(cam) {
        return this.run(cam, (a) => a.stop());
    }

    /** @returns {Promise<{contentType: string, body: Buffer}>} */
    snapshot(cam) {
        const e = this._entry(cam);
        if (!e.snap) {
            e.snap = (async () => {
                const a = await this._connected(cam, e);
                let s;
                try {
                    s = await a.fetchSnapshot();
                } catch (err) {
                    throw new HttpError(502, `camera ${cam.id} snapshot: ${err.message || err}`);
                }
                if (s.status !== 200) throw new HttpError(502, `camera ${cam.id} snapshot: HTTP ${s.status}`);
                return {contentType: s.contentType || 'image/jpeg', body: s.body};
            })().finally(() => {
                e.snap = null;
            });
        }
        return e.snap;
    }

    forget(id) {
        const e = this.entries.get(id);
        if (e) this._drop(e);
        this.entries.delete(id);
    }

    closeAll() {
        for (const id of [...this.entries.keys()]) this.forget(id);
    }
}

module.exports = {CameraManager};
