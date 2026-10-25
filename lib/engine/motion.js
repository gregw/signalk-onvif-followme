'use strict';
/*
 * How a followme zone moves the camera toward the aim (wiki/decisions.md, "Motion"). Pure: no
 * Signal K or ONVIF imports.
 *
 * A zone's mode.motion is {type, ...params}; a parameter it leaves out takes the default:
 *  - deadband: the original loop (engine/controller decide). Aims leadS ahead and sends an
 *    AbsoluteMove when an axis drifts past its deadband, at most every minIntervalS, at one
 *    speed for all axes. Defaults are the global settings of the same names.
 *  - paced: an AbsoluteMove every tick to where the boat will be lookaheadS ahead, each axis
 *    at the speed that gets there in lookaheadS. The next tick re-targets before the camera
 *    arrives, so the camera moves continuously and changes speed only as the boat's bearing
 *    rate changes; a lag of e closes at e / lookaheadS per second. Defaults: PACED.
 *
 * Speeds are in the ONVIF generic speed space 0..1; rates in normalised position units per
 * second. A camera's speed table maps one to the other (motion probe, wiki/phase0.md).
 */

/** Deadband parameters: each defaults to the global setting of the same name. */
const DEADBAND_PARAMS = ['leadS', 'minIntervalS', 'panDeadband', 'tiltDeadband', 'zoomDeadband', 'speed', 'waitIdle'];

const num =
    (lo, hi, unit = '') =>
    (v) =>
        typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
            ? null
            : `must be ${lo}..${hi}${unit && ' ' + unit}`;

/** Paced parameters: [default, check]. */
const PACED = {
    lookaheadS: [2, num(0.5, 10, 's')],
    maxSpeed: [1, num(0.001, 1)],
    zoomDeadband: [0.02, num(0, 1)],
    // TODO(verify): AbsoluteMove zoom speed against zoom rate was not measured (motion probe
    // measured pan only); 1 is the fastest.
    zoomSpeed: [1, num(0.001, 1)]
};

/**
 * AbsoluteMove pan speed to rate, measured by tools/motion-probe.js on the Phase 0 camera at
 * zoom 0.25 and 0.8 (identical: AbsoluteMove speed does not depend on zoom), reports
 * 2026-10-25T21-31-31-267Z-motion and 2026-10-25T21-42-45-928Z-motion. The 1.0 entry is the
 * clean fit at zoom 0.8; between 0.1 and 1 the line is interpolated (0.3 was too fast to fit:
 * at least 0.21). Tilt uses the same table: TODO(verify) tilt AbsoluteMove rates (only
 * ContinuousMove tilt was measured, and it matched pan).
 * @type {[number, number][]} [speed, units/s], increasing
 */
const DEFAULT_SPEED_TABLE = [
    [0, 0],
    [0.003, 0.0017],
    [0.01, 0.0104],
    [0.03, 0.0343],
    [0.1, 0.119],
    [1, 0.447]
];

/** The lowest speed sent: ONVIF speed 0 is not a slow move. */
const MIN_SPEED = 0.001;

/**
 * Check a speed table: at least two [speed, rate] pairs, both increasing, speeds in [0, 1].
 * @returns {string|null} error
 */
function checkSpeedTable(t) {
    if (!Array.isArray(t) || t.length < 2) return 'must be at least two [speed, rate] pairs';
    for (let i = 0; i < t.length; i++) {
        const p = t[i];
        if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v)))
            return `entry ${i} must be [speed, rate]`;
        if (p[0] < 0 || p[0] > 1 || p[1] < 0) return `entry ${i}: speed 0..1, rate >= 0`;
        if (i && (p[0] <= t[i - 1][0] || p[1] <= t[i - 1][1])) return `entry ${i}: speed and rate must increase`;
    }
    return null;
}

/**
 * The speed that moves at `rate` units/s: piecewise linear through the table, through the
 * origin below its first entry, and its last speed above its last rate.
 */
function speedFor(rate, table = DEFAULT_SPEED_TABLE) {
    const r = Math.abs(rate);
    let prev = [0, 0];
    for (const p of table) {
        if (r <= p[1]) return p[1] === prev[1] ? p[0] : prev[0] + ((r - prev[1]) * (p[0] - prev[0])) / (p[1] - prev[1]);
        prev = p;
    }
    return table[table.length - 1][0];
}

/**
 * Check a zone's motion object. Deadband overrides are checked by `checkSetting` (the global
 * settings' checks); paced ones by PACED. Unknown keys are refused, not ignored.
 * @param {object|null|undefined} m
 * @param {(key: string, value: any) => string|null} checkSetting
 * @returns {{motion: object|null, error: string|null}} the motion to store (null: deadband,
 *   all defaults) or an error
 */
function checkMotion(m, checkSetting) {
    if (m === undefined || m === null) return {motion: null, error: null};
    if (typeof m !== 'object') return {motion: null, error: 'motion must be an object'};
    const {type, ...params} = m;
    const out = {type};
    if (type === 'deadband') {
        for (const [k, v] of Object.entries(params)) {
            if (!DEADBAND_PARAMS.includes(k)) return {motion: null, error: `motion.${k} is not a deadband parameter`};
            if (v === undefined || v === null) continue;
            const err = checkSetting(k, v);
            if (err) return {motion: null, error: `motion.${k} ${err}`};
            out[k] = v;
        }
        return {motion: out, error: null};
    }
    if (type === 'paced') {
        for (const [k, v] of Object.entries(params)) {
            if (!PACED[k]) return {motion: null, error: `motion.${k} is not a paced parameter`};
            if (v === undefined || v === null) continue;
            const err = PACED[k][1](v);
            if (err) return {motion: null, error: `motion.${k} ${err}`};
            out[k] = v;
        }
        return {motion: out, error: null};
    }
    return {motion: null, error: `motion.type '${type}' not supported`};
}

/**
 * A zone's motion with every parameter filled in.
 * @param {object|null|undefined} motion zone's mode.motion
 * @param {object} settings global settings (deadband defaults)
 * @returns {{type: string, params: object}}
 */
function resolveMotion(motion, settings) {
    const type = (motion && motion.type) || 'deadband';
    const given = motion || {};
    const params = {};
    if (type === 'paced') {
        for (const [k, [d]] of Object.entries(PACED)) params[k] = given[k] ?? d;
    } else {
        for (const k of DEADBAND_PARAMS) params[k] = given[k] ?? settings[k];
    }
    return {type, params};
}

/** Signed shortest pan difference b - a, pan wrapping over [-1, 1]. */
function panDelta(a, b) {
    let d = (b - a) % 2;
    if (d > 1) d -= 2;
    if (d < -1) d += 2;
    return d;
}

/**
 * One paced tick.
 * @param {object} p
 * @param {{x: number, y: number, zoom: number}} p.want aim at the boat lookaheadS ahead
 * @param {{x: number, y: number}|null} p.from where the camera is (status), else where it was
 *   last sent; null: unknown (first move), go at maxSpeed
 * @param {number|null} p.lastZoom zoom last sent, null if none
 * @param {object} p.params resolved paced parameters
 * @param {[number, number][]} [p.table] the camera's speed table
 * @returns {{send: {x: number, y: number, zoom: number}, speed: {x: number, y: number, zoom: number}, rate: {x: number, y: number}|null, reason: string}}
 */
function paced({want, from, lastZoom, params, table = DEFAULT_SPEED_TABLE}) {
    const zoom =
        lastZoom !== null && lastZoom !== undefined && Math.abs(want.zoom - lastZoom) <= params.zoomDeadband
            ? lastZoom
            : want.zoom;
    const send = {x: want.x, y: want.y, zoom};
    if (!from) {
        const s = params.maxSpeed;
        return {send, speed: {x: s, y: s, zoom: params.zoomSpeed}, rate: null, reason: 'first'};
    }
    const rate = {
        x: Math.abs(panDelta(from.x, want.x)) / params.lookaheadS,
        y: Math.abs(want.y - from.y) / params.lookaheadS
    };
    const sp = (r) => Math.min(params.maxSpeed, Math.max(MIN_SPEED, speedFor(r, table)));
    return {send, speed: {x: sp(rate.x), y: sp(rate.y), zoom: params.zoomSpeed}, rate, reason: 'paced'};
}

module.exports = {
    DEADBAND_PARAMS,
    PACED,
    DEFAULT_SPEED_TABLE,
    MIN_SPEED,
    checkSpeedTable,
    checkMotion,
    resolveMotion,
    speedFor,
    panDelta,
    paced
};
