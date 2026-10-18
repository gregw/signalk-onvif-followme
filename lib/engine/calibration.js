'use strict';
/*
 * Calibration model: from captured samples (position + PTZ) to pan, tilt and zoom at a target,
 * fitted locally from the samples nearest the target on the chart (wiki/decisions.md).
 * Pure: no Signal K or ONVIF imports.
 *
 * For each target, take the NEIGHBOURS samples at the smallest geodesic distance from it, then
 * fit each axis with a least squares straight line through them:
 *
 *  - pan against bearing from the camera. Bearings are unwrapped about the target's, so a
 *    neighbourhood across north is continuous; pan values are unwrapped too (period 2 over
 *    [-1, 1]), in case the camera pans continuously through its +-1 seam.
 *  - tilt against depression = atan(height / range), the angle below horizontal. For a level
 *    mount tilt follows it almost linearly. With a zero camera height, range is the abscissa.
 *  - zoom against range.
 *
 * A sample therefore influences only targets near it: a near sample a few metres out no longer
 * bends the aim for everything at its bearing out to the horizon.
 *
 * When the neighbours' abscissae are too close together to fix a slope (MIN_SPREAD), that axis
 * keeps the slope fitted through all samples and fits only its offset locally. Beyond the
 * neighbours' span the line extrapolates and the axis is flagged `outside`. Output is clamped to
 * pan/tilt [-1, 1], zoom [0, 1], the normalised spaces found in Phase 0 (wiki/phase0.md).
 */

const {bearingRange, depression, unwrapAll, unwrap, wrap2pi} = require('./geometry');

const NEIGHBOURS = 3;

const rad = (d) => (d * Math.PI) / 180;

/** Below these neighbour spreads an axis takes its slope from all samples (radians, metres). */
const MIN_SPREAD = {pan: rad(1), tilt: rad(0.02), tiltRange: 20, zoom: 20};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Least squares straight line through points.
 * @param {{x: number, y: number}[]} pts at least one
 * @param {number|null} [slope] a fixed slope: fit only the offset
 * @returns {{at: (x: number) => number, slope: number, min: number, max: number}}
 */
function fitLine(pts, slope = null) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    let k = slope;
    if (k === null) {
        const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
        const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
        k = sxx > 0 ? sxy / sxx : 0;
    }
    const xs = pts.map((p) => p.x);
    return {at: (x) => my + k * (x - mx), slope: k, min: Math.min(...xs), max: Math.max(...xs)};
}

/** Unwrap a sequence of pan values with period 2 so neighbours differ by less than 1. */
function unwrapPan(values) {
    const out = [];
    for (const v of values) {
        if (!out.length) out.push(v);
        else {
            const prev = out[out.length - 1];
            out.push(v + 2 * Math.round((prev - v) / 2));
        }
    }
    return out;
}

/** Fold a pan value back into [-1, 1]. */
function wrapPan(v) {
    let w = ((((v + 1) % 2) + 2) % 2) - 1;
    if (w === -1 && v > 0) w = 1;
    return w;
}

/** Pan points sorted by bearing, both unwrapped: bearings about `ref`, pans along that order. */
function panPoints(derived, ref) {
    const sorted = derived.map((d) => ({x: unwrap(d.bearing, ref), pan: d.ptz.x})).sort((a, b) => a.x - b.x);
    const pans = unwrapPan(sorted.map((p) => p.pan));
    return sorted.map((p, i) => ({x: p.x, y: pans[i]}));
}

/**
 * Build a calibration model.
 * @param {{latitude: number, longitude: number, height?: number}} cameraPos
 * @param {{latitude: number, longitude: number, name?: string, ptz: {x: number, y: number, zoom: number}}[]} samples
 * @param {{neighbours?: number}} [opts]
 * @returns {{aim: (target: {latitude: number, longitude: number}) => object, samples: number}}
 * @throws if there are fewer than 2 samples at distinct bearings
 */
function buildCalibration(cameraPos, samples, {neighbours = NEIGHBOURS} = {}) {
    const h = cameraPos.height || 0;
    const tiltX = (range) => (h > 0 ? depression(h, range) : range);
    const derived = samples.map((s) => {
        const {bearing, range} = bearingRange(cameraPos, s);
        return {sample: s, bearing, range, ptz: s.ptz};
    });

    // Slopes through all samples: the fallback for a neighbourhood too narrow to fix its own.
    const ub = unwrapAll(derived.map((d) => d.bearing));
    const ref = derived.length ? ub.reduce((s, v) => s + v, 0) / ub.length : 0;
    const allPan = panPoints(derived, ref);
    if (allPan.length < 2 || allPan[allPan.length - 1].x - allPan[0].x < 1e-9) {
        throw new Error('calibration needs at least 2 samples at different bearings');
    }
    const global = {
        pan: fitLine(allPan).slope,
        tilt: fitLine(derived.map((d) => ({x: tiltX(d.range), y: d.ptz.y}))).slope,
        zoom: fitLine(derived.map((d) => ({x: d.range, y: d.ptz.zoom}))).slope
    };

    /** One axis fitted through the neighbours, with the global slope if they are too close. */
    function axis(pts, x, minSpread, globalSlope) {
        let line = fitLine(pts);
        if (line.max - line.min < minSpread) line = fitLine(pts, globalSlope);
        return {value: line.at(x), outside: x < line.min - 1e-12 || x > line.max + 1e-12};
    }

    function aim(target) {
        const {bearing, range} = bearingRange(cameraPos, target);
        const near = derived
            .map((d) => ({d, dist: bearingRange(target, d.sample).range}))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, neighbours)
            .map((n) => n.d);

        const pan = axis(panPoints(near, bearing), bearing, MIN_SPREAD.pan, global.pan);
        const tilt = axis(
            near.map((d) => ({x: tiltX(d.range), y: d.ptz.y})),
            tiltX(range),
            h > 0 ? MIN_SPREAD.tilt : MIN_SPREAD.tiltRange,
            global.tilt
        );
        const zoom = axis(
            near.map((d) => ({x: d.range, y: d.ptz.zoom})),
            range,
            MIN_SPREAD.zoom,
            global.zoom
        );
        return {
            x: clamp(wrapPan(pan.value), -1, 1),
            y: clamp(tilt.value, -1, 1),
            zoom: clamp(zoom.value, 0, 1),
            bearing: wrap2pi(bearing),
            range,
            depression: depression(h, range),
            outside: {pan: pan.outside, tilt: tilt.outside, zoom: zoom.outside},
            neighbours: near.map((d) => d.sample.name || d.sample.id || null)
        };
    }

    return {aim, samples: samples.length};
}

module.exports = {buildCalibration, fitLine, unwrapPan, wrapPan, NEIGHBOURS};
