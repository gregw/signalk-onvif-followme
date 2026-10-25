'use strict';
/*
 * Motion probe: how the camera moves, for choosing a smooth follow algorithm.
 *
 * Every test starts from a home position reached by AbsoluteMove and settled, records timed
 * GetStatus samples while it commands the camera, and stops the camera at the end. Rates are
 * in normalised units per second of the camera's default spaces (pan/tilt PositionGenericSpace,
 * zoom PositionGenericSpace; wiki/phase0.md). The caller restores the start position.
 *
 * Tests:
 *  pan-curve, tilt-curve, zoom-curve  ContinuousMove velocity to measured rate, both ways:
 *                                     linearity, quantised speed levels, start latency
 *  resend           the same ContinuousMove re-sent every second: does each resend hitch?
 *  step             velocity doubled mid-move: how long the camera takes to the new rate
 *  zoom-during-pan  while panning, a ContinuousMove with pan and zoom, then one with zoom only
 *                   (PanTilt omitted): does pan keep its rate?
 *  abs-speed        AbsoluteMove speed (generic speed space 0..1) to measured pan rate
 *  abs-chain        AbsoluteMoves re-targeted every second, each to where the previous would
 *                   reach in a second: does the camera pause between them?
 *
 * GetStatus is the only position source. How far it lags the real mount while moving is not
 * measured here (TODO(verify): needs image timing); its round trip time and how often its
 * value changes while moving are.
 */

const {waitSettled, sleep} = require('./ptz-math');
const M = require('./motion-math');

const TESTS = ['pan-curve', 'tilt-curve', 'zoom-curve', 'resend', 'step', 'zoom-during-pan', 'abs-speed', 'abs-chain'];

const VELS = {
    x: [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1],
    y: [0.02, 0.05, 0.1, 0.2, 0.5, 1],
    zoom: [0.05, 0.1, 0.2, 0.5, 1]
};
const QUICK_VELS = {x: [0.02, 0.05, 0.1, 0.3, 1], y: [0.05, 0.2, 1], zoom: [0.1, 1]};
const ABS_SPEEDS = [0.003, 0.01, 0.03, 0.1, 0.3, 1];

/** How far each axis may travel from home in one run (units), and the run time limit (ms). */
const TRAVEL = {x: 0.3, y: 0.15, zoom: 0.2};
const RUN = {maxMs: 6000};
/**
 * End stops of the default spaces (wiki/phase0.md): a run stops this far short of them so a
 * fast velocity is not measured against the stop. Pan wraps, so it has none.
 */
const LIMITS = {y: [-1, 1], zoom: [0, 1]};
const LIMIT_MARGIN = 0.03;
/** Samples before this long after first motion are acceleration, left out of rate fits. */
const ACCEL_SKIP_MS = 400;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {import('../adapter').CameraAdapter} adapter connected
 * @param {object} [opts]
 * @param {Set<string>} [opts.only] test names to run (default all)
 * @param {boolean} [opts.quick] fewer velocities
 * @param {{x: number, y: number, zoom: number}} [opts.home] default: start pan, tilt clamped
 *   to [-0.7, 0.7] so tilt runs have room both ways, start zoom clamped to [0.25, 0.6]
 * @param {number} [opts.pollMs] min time between GetStatus calls
 * @param {number} [opts.chainRate] abs-chain target pan rate, units/s
 * @param {(line: string) => void} [opts.log]
 * @param {(ms: number) => Promise<void>} [opts.wait]
 * @param {() => number} [opts.now]
 * @returns {Promise<object>} report
 */
async function runMotionProbe(adapter, opts = {}) {
    const {
        only = new Set(TESTS),
        quick = false,
        pollMs = 100,
        chainRate = 0.01,
        log = () => {},
        wait = sleep,
        now = Date.now
    } = opts;
    const vels = quick ? QUICK_VELS : VELS;
    const rtts = [];

    const status = async () => {
        const t0 = now();
        const s = await adapter.getStatus();
        const t1 = now();
        rtts.push(t1 - t0);
        return {...s, mid: (t0 + t1) / 2};
    };
    const start = await status();
    if (![start.x, start.y, start.zoom].every(Number.isFinite)) {
        throw new Error('GetStatus has no position: cannot measure motion');
    }
    const home = opts.home || {
        x: start.x,
        y: clamp(start.y, -0.7, 0.7),
        zoom: clamp(start.zoom, 0.25, 0.6)
    };
    const report = {
        startedAt: new Date(now()).toISOString(),
        lib: adapter.lib,
        start: {x: start.x, y: start.y, zoom: start.zoom},
        home,
        options: {quick, pollMs, chainRate},
        tests: {}
    };

    const settle = () => waitSettled(() => adapter.getStatus(), {wait, now, minWaitMs: 300, timeoutMs: 30000});
    async function goHome() {
        await adapter.absoluteMove(home);
        return settle();
    }

    /**
     * Sample GetStatus every pollMs while running scheduled actions.
     * @param {{at: number, label: string, run: () => Promise<void>}[]} actions at: ms from start
     * @param {number} maxMs
     * @param {(samples: object[], t: number) => boolean} [done] checked after each sample
     */
    async function record(actions, maxMs, done = () => false) {
        const t0 = now();
        const samples = [];
        const events = [];
        const queue = [...actions].sort((a, b) => a.at - b.at);
        for (;;) {
            while (queue.length && now() - t0 >= queue[0].at) {
                const a = queue.shift();
                const at = now() - t0;
                await a.run();
                events.push({t: at, label: a.label});
            }
            const s = await status();
            samples.push({t: s.mid - t0, x: s.x, y: s.y, zoom: s.zoom, moveStatus: s.moveStatus});
            const t = now() - t0;
            if ((t >= maxMs && !queue.length) || done(samples, t)) break;
            const nextAction = queue.length ? queue[0].at - t : Infinity;
            await wait(Math.max(0, Math.min(pollMs, nextAction)));
        }
        await adapter.stop();
        return {samples, events};
    }

    const nearLimit = (axis, v) =>
        !!LIMITS[axis] && (v <= LIMITS[axis][0] + LIMIT_MARGIN || v >= LIMITS[axis][1] - LIMIT_MARGIN);
    const travelled = (samples, axis) => {
        const v = M.unwrapSeries(samples.map((s) => s[axis]));
        return Math.abs(v[v.length - 1] - v[0]);
    };

    async function curve(axis) {
        const out = [];
        for (const v of vels[axis]) {
            for (const dir of [1, -1]) {
                await goHome();
                const cmd = {x: 0, y: 0, zoom: 0, [axis]: dir * v};
                const {samples} = await record(
                    [{at: 0, label: 'continuous', run: () => adapter.continuousMove(cmd, RUN.maxMs + 2000)}],
                    RUN.maxMs,
                    (s) => travelled(s, axis) >= TRAVEL[axis] || nearLimit(axis, s[s.length - 1][axis])
                );
                const first = M.firstMotion(samples, axis);
                // A fast run may end before three reads past the acceleration: then fit from first
                // motion, acceleration included, and say so.
                let fit =
                    first === null ? {rate: null, n: 0, rms: null} : M.fitRate(samples, axis, first + ACCEL_SKIP_MS);
                const withAccel = fit.rate === null && first !== null;
                if (withAccel) fit = M.fitRate(samples, axis, first);
                out.push({v: dir * v, rate: fit.rate, startMs: first, n: fit.n, rms: fit.rms, withAccel});
                log(
                    `  ${axis} v=${(dir * v).toFixed(3)} rate=${fit.rate === null ? '-' : fit.rate.toFixed(4)}/s start=${first ?? '-'}ms`
                );
            }
        }
        const pos = out.filter((c) => c.v > 0);
        return {
            runs: out,
            levels: M.speedLevels(pos),
            asymmetry: pos.map((p) => {
                const n = out.find((c) => c.v === -p.v);
                return {v: p.v, ratio: p.rate && n && n.rate ? Math.abs(n.rate / p.rate) : null};
            })
        };
    }

    /** Mid pan velocity for the timing tests: the curve's v nearest 0.03 units/s, else 0.1. */
    const midV = () => {
        const runs = report.tests['pan-curve'] && report.tests['pan-curve'].runs.filter((r) => r.v > 0 && r.rate);
        if (!runs || !runs.length) return 0.1;
        return runs.reduce((b, r) => (Math.abs(r.rate - 0.03) < Math.abs(b.rate - 0.03) ? r : b)).v;
    };

    async function resend() {
        const v = midV();
        await goHome();
        const cmd = {x: v, y: 0, zoom: 0};
        const actions = [];
        for (let at = 0; at <= 7000; at += 1000)
            actions.push({at, label: 'continuous', run: () => adapter.continuousMove(cmd, 3000)});
        const {samples, events} = await record(actions, 8000);
        const st = M.steadiness(samples, 'x', 1500, 8000);
        log(
            `  resend v=${v} rate=${st.rate && st.rate.toFixed(4)} window rates ${st.minRate && st.minRate.toFixed(4)}..${st.maxRate && st.maxRate.toFixed(4)} dips ${st.dips.length}`
        );
        return {v, ...st, events, samples};
    }

    async function step() {
        const v = midV();
        await goHome();
        const {samples, events} = await record(
            [
                {at: 0, label: `continuous ${v}`, run: () => adapter.continuousMove({x: v, y: 0, zoom: 0}, 5000)},
                {
                    at: 3000,
                    label: `continuous ${2 * v}`,
                    run: () => adapter.continuousMove({x: 2 * v, y: 0, zoom: 0}, 5000)
                }
            ],
            6000
        );
        const t1 = events[1].t;
        const before = M.fitRate(samples, 'x', 1500, t1).rate;
        const after = M.fitRate(samples, 'x', t1 + 1500, 6000).rate;
        const ramp = after === null ? null : M.rampTime(samples, 'x', t1, after);
        log(
            `  step ${v} -> ${2 * v}: ${before && before.toFixed(4)} -> ${after && after.toFixed(4)}/s, ramp ${ramp}ms`
        );
        return {v, before, after, rampMs: ramp, events, samples};
    }

    async function zoomDuringPan() {
        const v = midV();
        const out = {};
        for (const variant of ['pan+zoom', 'zoom-only']) {
            await goHome();
            const zcmd = variant === 'pan+zoom' ? {x: v, y: 0, zoom: 0.3} : {zoom: 0.3};
            const zstop = variant === 'pan+zoom' ? {x: v, y: 0, zoom: 0} : {zoom: 0};
            const {samples, events} = await record(
                [
                    {at: 0, label: 'pan', run: () => adapter.continuousMove({x: v, y: 0, zoom: 0}, 7000)},
                    {at: 2000, label: variant, run: () => adapter.continuousMove(zcmd, 7000)},
                    {at: 3000, label: 'zoom stop', run: () => adapter.continuousMove(zstop, 7000)}
                ],
                5000
            );
            const [, tz, ts] = events.map((e) => e.t);
            const r = (a, b) => M.fitRate(samples, 'x', a, b).rate;
            out[variant] = {
                panBefore: r(800, tz),
                panDuring: r(tz + 200, ts),
                panAfter: r(ts + 200, 5000),
                zoomDuring: M.fitRate(samples, 'zoom', tz + 200, ts).rate,
                events,
                samples
            };
            const o = out[variant];
            const f = (x) => (x === null ? '-' : x.toFixed(4));
            log(`  ${variant}: pan ${f(o.panBefore)} / ${f(o.panDuring)} / ${f(o.panAfter)}, zoom ${f(o.zoomDuring)}`);
        }
        return {v, ...out};
    }

    async function absSpeed() {
        const out = [];
        for (const sp of ABS_SPEEDS) {
            // Long enough at fast speeds for several GetStatus reads during the move.
            const dist = sp >= 0.3 ? 0.3 : 0.1;
            await goHome();
            const to = {...home, x: home.x + dist};
            const {samples} = await record(
                [{at: 0, label: 'absolute', run: () => adapter.absoluteMove(to, {x: sp, y: sp, zoom: sp})}],
                20000,
                (s) => Math.abs(M.unwrapSeries(s.map((q) => q.x)).at(-1) - home.x - dist) < 0.002
            );
            // Rate over the middle of the move: from 20% to 80% of the distance.
            const xs = M.unwrapSeries(samples.map((q) => q.x));
            const tAt = (f) => {
                const i = xs.findIndex((x) => Math.abs(x - home.x) >= f * dist);
                return i < 0 ? null : samples[i].t;
            };
            // A slow speed may not get that far in 20 s: then from first motion to the end.
            const a = tAt(0.2);
            const b = tAt(0.8);
            const first = M.firstMotion(samples, 'x');
            const fit =
                a !== null && b !== null && b > a
                    ? M.fitRate(samples, 'x', a, b)
                    : first === null
                      ? {rate: null}
                      : M.fitRate(samples, 'x', first + ACCEL_SKIP_MS);
            const arrived = tAt(0.98);
            out.push({speed: sp, dist, rate: fit.rate, arriveMs: arrived});
            log(
                `  abs speed ${sp}: rate ${fit.rate === null ? '-' : fit.rate.toFixed(4)}/s, arrived ${arrived ?? '>20000'}ms`
            );
        }
        return {runs: out};
    }

    async function absChain() {
        // The speed whose measured AbsoluteMove rate is nearest chainRate; else 0.03.
        const runs = report.tests['abs-speed'] && report.tests['abs-speed'].runs.filter((r) => r.rate);
        const pick =
            runs && runs.length
                ? runs.reduce((b, r) => (Math.abs(r.rate - chainRate) < Math.abs(b.rate - chainRate) ? r : b))
                : null;
        const sp = pick ? pick.speed : 0.03;
        const stepUnits = pick ? pick.rate : chainRate;
        await goHome();
        const actions = [];
        for (let k = 0; k < 8; k++) {
            const to = {...home, x: home.x + (k + 1) * stepUnits};
            actions.push({
                at: k * 1000,
                label: `absolute +${(k + 1) * stepUnits}`,
                run: () => adapter.absoluteMove(to, {x: sp, y: sp, zoom: sp})
            });
        }
        const {samples, events} = await record(actions, 9000);
        const st = M.steadiness(samples, 'x', 1000, 8000);
        log(
            `  chain speed ${sp} step ${stepUnits.toFixed(4)}: rate ${st.rate && st.rate.toFixed(4)}, window rates ${st.minRate && st.minRate.toFixed(4)}..${st.maxRate && st.maxRate.toFixed(4)}, dips ${st.dips.length}`
        );
        return {speed: sp, stepUnits, ...st, events, samples};
    }

    const run = {
        'pan-curve': () => curve('x'),
        'tilt-curve': () => curve('y'),
        'zoom-curve': () => curve('zoom'),
        resend,
        step,
        'zoom-during-pan': zoomDuringPan,
        'abs-speed': absSpeed,
        'abs-chain': absChain
    };
    for (const name of TESTS) {
        if (!only.has(name)) continue;
        log(`${name}`);
        try {
            report.tests[name] = await run[name]();
        } catch (err) {
            report.tests[name] = {error: err.message || String(err)};
            log(`  error: ${err.message || err}`);
            await adapter.stop().catch(() => {});
        }
    }

    const [p50, p95, max] = M.percentiles(rtts);
    report.getStatus = {calls: rtts.length, rttMs: {p50, p95, max}};
    // While panning steadily (resend), how often consecutive GetStatus reads return the same pan.
    const rs = report.tests.resend;
    if (rs && rs.samples) {
        const moving = rs.samples.filter((s) => s.t > 1500);
        let same = 0;
        for (let i = 1; i < moving.length; i++) if (moving[i].x === moving[i - 1].x) same++;
        report.getStatus.staleWhileMoving = moving.length > 1 ? same / (moving.length - 1) : null;
    }
    report.finishedAt = new Date(now()).toISOString();
    return report;
}

/** Move back to where the probe found the camera and wait for it to settle. */
async function restore(adapter, start, {wait = sleep, now = Date.now} = {}) {
    await adapter.stop().catch(() => {});
    await adapter.absoluteMove(start);
    return waitSettled(() => adapter.getStatus(), {wait, now, minWaitMs: 300, timeoutMs: 30000});
}

module.exports = {runMotionProbe, restore, TESTS, VELS, ABS_SPEEDS};
