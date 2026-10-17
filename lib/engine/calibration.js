'use strict';
/*
 * Calibration model: from captured samples (position + PTZ) to pan(bearing), tilt(depression)
 * and zoom(range), 1D piecewise linear (brief: "Interpolation"; wiki/decisions.md).
 * Pure: no Signal K or ONVIF imports.
 *
 *  - pan(bearing): samples sorted by bearing, unwrapped about their circular mean so an arc
 *    across north is continuous. Pan values are unwrapped too (period 2 over [-1, 1]), in
 *    case the camera pans continuously through its +-1 seam; a camera that does not wrap
 *    never has adjacent samples a whole half range apart, so this is harmless there.
 *    Outside the sampled arc: linear extrapolation from the end segment (flagged).
 *  - tilt(depression): depression = atan(height / range), the angle below horizontal. For
 *    a level mount tilt follows it almost linearly, far more than it follows range. With a
 *    zero camera height, range is the abscissa instead. Outside: clamped (flagged).
 *  - zoom(range): outside: clamped (flagged).
 * Samples with equal abscissae are averaged. Output is clamped to pan/tilt [-1, 1], zoom
 * [0, 1], the normalised spaces found in Phase 0 (wiki/phase0.md).
 */

const {bearingRange, depression, unwrapAll, unwrap, wrap2pi} = require('./geometry');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Collapse equal x into their mean y; returns points sorted by x. */
function merge(points) {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const out = [];
    for (const p of sorted) {
        const last = out[out.length - 1];
        if (last && Math.abs(last.x - p.x) < 1e-12) {
            last.ys.push(p.y);
            last.y = last.ys.reduce((s, v) => s + v, 0) / last.ys.length;
        } else {
            out.push({x: p.x, y: p.y, ys: [p.y]});
        }
    }
    return out.map(({x, y}) => ({x, y}));
}

/**
 * Piecewise linear interpolation through sorted points.
 * @param {'extrapolate'|'clamp'} outside behaviour beyond the end points
 * @returns {{value: number, outside: boolean}}
 */
function interp(pts, x, outside) {
    if (pts.length === 1) return {value: pts[0].y, outside: x !== pts[0].x};
    let i = 1;
    while (i < pts.length - 1 && x > pts[i].x) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const out = x < pts[0].x || x > pts[pts.length - 1].x;
    if (out && outside === 'clamp') return {value: x < pts[0].x ? pts[0].y : pts[pts.length - 1].y, outside: true};
    return {value: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x), outside: out};
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

/**
 * Build a calibration model.
 * @param {{latitude: number, longitude: number, height?: number}} cameraPos
 * @param {{latitude: number, longitude: number, ptz: {x: number, y: number, zoom: number}}[]} samples
 * @returns {{aim: (target: {latitude: number, longitude: number}) => object, samples: number}}
 * @throws if there are fewer than 2 samples at distinct bearings
 */
function buildCalibration(cameraPos, samples) {
    const h = cameraPos.height || 0;
    const derived = samples.map((s) => {
        const {bearing, range} = bearingRange(cameraPos, s);
        return {bearing, range, ptz: s.ptz};
    });

    // Pan: sort by unwrapped bearing, then unwrap pan along that order.
    const ub = unwrapAll(derived.map((d) => d.bearing));
    const ref = derived.length ? ub.reduce((s, v) => s + v, 0) / ub.length : 0;
    const byBearing = derived.map((d, i) => ({x: ub[i], pan: d.ptz.x})).sort((a, b) => a.x - b.x);
    const pans = unwrapPan(byBearing.map((p) => p.pan));
    const panPts = merge(byBearing.map((p, i) => ({x: p.x, y: pans[i]})));
    if (panPts.length < 2) throw new Error('calibration needs at least 2 samples at different bearings');

    const tiltX = (range) => (h > 0 ? depression(h, range) : range);
    const tiltPts = merge(derived.map((d) => ({x: tiltX(d.range), y: d.ptz.y})));
    const zoomPts = merge(derived.map((d) => ({x: d.range, y: d.ptz.zoom})));

    function aim(target) {
        const {bearing, range} = bearingRange(cameraPos, target);
        const b = unwrap(bearing, ref);
        const pan = interp(panPts, b, 'extrapolate');
        const tilt = interp(tiltPts, tiltX(range), 'clamp');
        const zoom = interp(zoomPts, range, 'clamp');
        return {
            x: clamp(wrapPan(pan.value), -1, 1),
            y: clamp(tilt.value, -1, 1),
            zoom: clamp(zoom.value, 0, 1),
            bearing: wrap2pi(bearing),
            range,
            depression: depression(h, range),
            outside: {pan: pan.outside, tilt: tilt.outside, zoom: zoom.outside}
        };
    }

    return {aim, samples: samples.length};
}

module.exports = {buildCalibration, interp, merge, unwrapPan, wrapPan};
