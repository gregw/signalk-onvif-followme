'use strict';
/*
 * Follow loop (brief: "Control loop (followme)").
 *
 * Data model paths consumed (self vessel, via app.subscriptionmanager.subscribe, as in
 * signalk-nemesis lib/waypoint.js on the same server): navigation.position ({latitude,
 * longitude} degrees), navigation.courseOverGroundTrue (rad), navigation.speedOverGround
 * (m/s). Fix age is measured from receipt, not the delta timestamp.
 *
 * Every tickMs (default 1 s: the GPS fix rate, and as often as the camera should move),
 * per camera, unless following is off, paused by a manual command, or the fix is stale:
 *  1. zone: engine/zones selectZone on the actual position (sticky, priority, hold).
 *  2. aim: engine/aimer on the position predicted leadS ahead along COG/SOG.
 *  3. move: engine/controller decide (deadband per axis, min interval, optional waitIdle),
 *     then AbsoluteMove (with the optional speed). A fixed zone re-sends its view every
 *     holdS (keepalive) so the camera's scan does not resume.
 * Outside all zones nothing is sent: the camera's own scan takes over (brief: release,
 * not hold). Moves for one camera never overlap: a tick is skipped while the previous one
 * is still running, and CameraManager serialises commands anyway.
 */

const {selectZone, initialState} = require('../engine/zones');
const {aimZone, AimError} = require('../engine/aimer');
const {decide, predict} = require('../engine/controller');
const {metresPerDegree, bearingRange, pointInPolygon} = require('../engine/geometry');

const PATHS = ['navigation.position', 'navigation.courseOverGroundTrue', 'navigation.speedOverGround'];
const STATUS_POLL_MS = 1000;
const MOTION_STALE_MS = 5000;

class Follower {
    /**
     * @param {object} opts
     * @param {object} opts.app Signal K app (subscriptionmanager, error)
     * @param {import('./store').Store} opts.store
     * @param {import('./cameras').CameraManager} opts.cameras
     * @param {() => number} [opts.now]
     * @param {number} [opts.tickMs]
     * @param {(msg: string) => void} [opts.log]
     */
    constructor({app, store, cameras, now = Date.now, tickMs = 1000, log = () => {}}) {
        this.app = app;
        this.store = store;
        this.cameras = cameras;
        this.now = now;
        this.tickMs = tickMs;
        this.log = log;
        this.fix = null; // {position, at}
        this.cog = null; // {value, at}
        this.sog = null;
        this.per = new Map(); // cameraId -> per camera state
        this.unsubscribes = [];
        this.timer = null;
    }

    start() {
        if (this.app && this.app.subscriptionmanager) {
            this.app.subscriptionmanager.subscribe(
                {context: 'vessels.self', subscribe: PATHS.map((path) => ({path, policy: 'instant'}))},
                this.unsubscribes,
                (err) => this.log(`subscription error: ${err}`),
                (delta) => this.onDelta(delta)
            );
        }
        this.timer = setInterval(() => this.tick(), this.tickMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        this.unsubscribes.forEach((f) => f());
        this.unsubscribes = [];
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Take position, COG and SOG from a self delta. Never throws into the server. */
    onDelta(delta) {
        try {
            const at = this.now();
            for (const u of (delta && delta.updates) || []) {
                for (const v of u.values || []) {
                    if (v.path === 'navigation.position') {
                        const p = v.value;
                        if (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
                            this.fix = {position: {latitude: p.latitude, longitude: p.longitude}, at};
                        }
                    } else if (v.path === 'navigation.courseOverGroundTrue' && Number.isFinite(v.value)) {
                        this.cog = {value: v.value, at};
                    } else if (v.path === 'navigation.speedOverGround' && Number.isFinite(v.value)) {
                        this.sog = {value: v.value, at};
                    }
                }
            }
        } catch (err) {
            this.log(`delta ignored: ${err.message}`);
        }
    }

    _state(id) {
        let s = this.per.get(id);
        if (!s) {
            s = {
                sel: initialState(),
                last: null,
                status: null,
                statusAt: 0,
                busy: false,
                pausedUntil: 0,
                reason: 'starting',
                zoneId: null,
                want: null,
                error: null,
                sent: 0
            };
            this.per.set(id, s);
        }
        return s;
    }

    /** A manual command (jog, go to, test aim) pauses following on that camera. */
    pause(cameraId, ms = 30000) {
        const s = this._state(cameraId);
        s.pausedUntil = this.now() + ms;
        s.last = null; // the camera is somewhere else now: next follow command always goes out
    }

    resume(cameraId) {
        this._state(cameraId).pausedUntil = 0;
    }

    /** One pass over all cameras. Resolves when this pass's work is done (tests await it). */
    tick() {
        const jobs = [];
        for (const cam of this.store.state.cameras) {
            const s = this._state(cam.id);
            if (s.busy) continue;
            s.busy = true;
            jobs.push(
                this._tickCamera(cam, s)
                    .catch((err) => this._reason(cam, s, `error: ${err.message || err}`))
                    .finally(() => {
                        s.busy = false;
                    })
            );
        }
        return Promise.all(jobs);
    }

    _reason(cam, s, reason) {
        if (reason !== s.reason && !/^(deadband|interval|moving)$/.test(reason)) {
            this.log(`camera ${cam.id}: ${reason}`);
        }
        s.reason = reason;
    }

    async _tickCamera(cam, s) {
        const now = this.now();
        const st = this.store.state.settings;
        if (!st.followEnabled) {
            // Off: forget zone and last move, so switching on starts clean (entry hold and all).
            s.last = null;
            s.sel = initialState();
            s.zoneId = null;
            s.want = null;
            return this._reason(cam, s, 'off');
        }
        if (now < s.pausedUntil) return this._reason(cam, s, 'paused (manual control)');
        if (!this.fix) return this._reason(cam, s, 'no position yet');
        if (now - this.fix.at > st.staleS * 1000) {
            s.last = null;
            return this._reason(cam, s, 'position stale');
        }

        const zones = this.store.state.zones.filter((z) => z.cameraId === cam.id);
        const prevZone = s.sel.activeId;
        s.sel = selectZone(s.sel, {position: this.fix.position, zones, holdMs: st.holdS * 1000, now});
        s.zoneId = s.sel.activeId;
        if (s.sel.activeId !== prevZone) s.last = null; // new zone or released: start fresh
        const zone = zones.find((z) => z.id === s.sel.activeId);
        if (!zone) {
            s.want = null;
            return this._reason(cam, s, s.sel.pending ? 'outside (hold)' : 'outside all zones');
        }

        const fresh = (m) => m && now - m.at <= MOTION_STALE_MS;
        const target = predict(
            this.fix.position,
            fresh(this.cog) ? this.cog.value : null,
            fresh(this.sog) ? this.sog.value : null,
            st.leadS,
            metresPerDegree
        );
        let want;
        try {
            want = aimZone({
                target,
                zone,
                cameraPosition: cam.pose.position,
                samples: this.store.zoneCalibration(zone.id).samples
            });
        } catch (err) {
            if (err instanceof AimError) return this._reason(cam, s, `cannot aim: ${err.message}`);
            throw err;
        }
        s.want = {x: want.x, y: want.y, zoom: want.zoom};

        if (st.waitIdle && now - s.statusAt >= STATUS_POLL_MS) {
            s.status = await this.cameras.status(cam);
            s.statusAt = now;
        }
        const d = decide({
            want: s.want,
            last: s.last,
            status: st.waitIdle ? s.status : null,
            now,
            settings: {
                // Half a tick of slack: timer jitter must not make a 1 s interval at a 1 s
                // tick skip every other tick. The interval is effectively whole ticks.
                minIntervalMs: st.minIntervalS * 1000 - this.tickMs / 2,
                panDeadband: st.panDeadband,
                tiltDeadband: st.tiltDeadband,
                zoomDeadband: st.zoomDeadband,
                waitIdle: st.waitIdle,
                idleTimeoutMs: 10000,
                // Fixed zone: re-send the view every hold time (at least 1 s) so the camera's
                // own scan does not take over while the boat stays in the zone.
                keepaliveMs: zone.mode.type === 'fixed' ? Math.max(st.holdS, 1) * 1000 : 0
            }
        });
        if (d.send) {
            await this.cameras.move(cam, {mode: 'absolute', ...d.send, speed: st.speed});
            s.last = {ptz: d.send, at: now};
            s.sent++;
        }
        this._reason(cam, s, d.reason);
    }

    /**
     * Snapshot for the webapp (and diagnosis). Wire units SI: radians, metres, m/s, seconds.
     * Per camera: what the loop decided last tick, the zone and any pending change with the
     * hold time left, the zones the fix is in right now, bearing and range from the camera.
     */
    status() {
        const now = this.now();
        const st = this.store.state.settings;
        const age = (m) => (m ? (now - m.at) / 1000 : null);
        const zoneInfo = (z) =>
            z ? {id: z.id, name: z.geometry.refName, mode: z.mode.type, priority: z.priority} : null;
        return {
            enabled: st.followEnabled,
            holdS: st.holdS,
            leadS: st.leadS,
            staleS: st.staleS,
            fix: this.fix && {...this.fix.position, ageS: age(this.fix)},
            cog: this.cog && {value: this.cog.value, ageS: age(this.cog)},
            sog: this.sog && {value: this.sog.value, ageS: age(this.sog)},
            cameras: Object.fromEntries(
                this.store.state.cameras.map((cam) => {
                    const s = this._state(cam.id);
                    const zones = this.store.state.zones.filter((z) => z.cameraId === cam.id);
                    const pos = cam.pose.position;
                    const fix = this.fix && this.fix.position;
                    const p = s.sel.pending;
                    return [
                        cam.id,
                        {
                            reason: s.reason,
                            zone: zoneInfo(zones.find((z) => z.id === s.zoneId)),
                            pending: p && {
                                to: p.id ? zoneInfo(zones.find((z) => z.id === p.id)) : null,
                                remainingS: Math.max(0, st.holdS - (now - p.since) / 1000)
                            },
                            inZones: fix
                                ? zones
                                      .filter((z) => z.geometry && pointInPolygon(fix, z.geometry.polygon))
                                      .map(zoneInfo)
                                : [],
                            ...(pos && fix ? bearingRange(pos, fix) : {bearing: null, range: null}),
                            want: s.want,
                            last: s.last && {...s.last.ptz, ageS: (now - s.last.at) / 1000},
                            sent: s.sent,
                            pausedS: Math.max(0, (s.pausedUntil - now) / 1000)
                        }
                    ];
                })
            )
        };
    }
}

module.exports = {Follower, PATHS};
