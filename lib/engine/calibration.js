'use strict';
/*
 * Calibration model: from captured samples (position + PTZ) to pan, tilt and zoom at a target
 * (wiki/decisions.md). Pure: no Signal K or ONVIF imports.
 *
 * Inside: the smallest triangle of samples on the chart (a plane about the camera) that
 * contains the target, smallest by perimeter: by area, a long thin sliver between far samples
 * can win over a compact triangle around the target, and barycentric interpolation of its three samples' PTZ. The weights are
 * taken in the camera's view angles: unwrapped bearing against depression (range when the
 * camera height is 0) for pan and tilt, bearing against range for zoom. For a camera whose pan
 * is linear in bearing and tilt linear in depression that is exact. Triangle edges are not
 * straight in those planes, so near an edge a weight can be slightly negative. A triangle with a
 * corner close to the camera is badly distorted in them (from 66 m out, edges to two 1 km samples
 * sweep 50 degrees of bearing), and its view angle weights extrapolate far beyond the corners:
 * -0.56 on one corner drove a real zoom to 0, below all three. So when any view angle weight is
 * below -WEIGHT_TOL that axis uses the chart weights, which are never negative inside the
 * triangle, and zoom is held within its corners' range. The choice is on
 * the chart, not in view angles: depression squeezes the far field, so the smallest triangle
 * by view angle spans tens of degrees of bearing between far samples. The aim steps when the
 * target crosses into a different smallest triangle.
 *
 * Outside every triangle: the NEIGHBOURS samples at the smallest geodesic distance from the
 * target, and each axis fitted with a least squares straight line through them:
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

/** View angle weights more negative than this are extrapolating: use the chart weights. */
const WEIGHT_TOL = 0.05;

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
 * Barycentric weights of (x, y) in the triangle a, b, c; null if it is degenerate.
 * @returns {number[]|null} three weights summing to 1, all >= 0 inside
 */
function barycentric(a, b, c, x, y) {
    const area2 = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area2) < 1e-15) return null;
    const wb = ((x - a.x) * (c.y - a.y) - (c.x - a.x) * (y - a.y)) / area2;
    const wc = ((b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y)) / area2;
    return [1 - wb - wc, wb, wc];
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

    /** Chart plane about the camera: metres east and north. */
    const plane = (bearing, range) => ({x: range * Math.sin(bearing), y: range * Math.cos(bearing)});
    const charted = derived.map((d) => ({d, ...plane(d.bearing, d.range)}));

    /**
     * The triangle of samples on the chart with the smallest perimeter containing the target.
     * @returns {{vertices: object[], weights: number[]}|null} weights in the chart plane
     */
    function triangle(bearing, range) {
        const {x: tx, y: ty} = plane(bearing, range);
        const pts = charted;
        let best = null;
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                for (let k = j + 1; k < pts.length; k++) {
                    const [a, b, c] = [pts[i], pts[j], pts[k]];
                    const perimeter =
                        Math.hypot(b.x - a.x, b.y - a.y) +
                        Math.hypot(c.x - b.x, c.y - b.y) +
                        Math.hypot(a.x - c.x, a.y - c.y);
                    if (best && perimeter >= best.perimeter) continue;
                    const w = barycentric(a, b, c, tx, ty);
                    if (!w || Math.min(...w) < -1e-9) continue;
                    best = {perimeter, vertices: [a.d, b.d, c.d], weights: w};
                }
            }
        }
        return best;
    }

    /**
     * The aim, clamped to the camera's spaces, with how it was made (for the debug log):
     * method 'triangle' or 'nearest', the unclamped ptz, and for a triangle its weights on the
     * chart and as used (view for pan and tilt, zoom), in neighbours order.
     */
    function result(bearing, range, ptz, outside, used, method, weights = null) {
        return {
            x: clamp(wrapPan(ptz.x), -1, 1),
            y: clamp(ptz.y, -1, 1),
            zoom: clamp(ptz.zoom, 0, 1),
            bearing: wrap2pi(bearing),
            range,
            depression: depression(h, range),
            outside,
            neighbours: used.map((d) => d.sample.name || d.sample.id || null),
            method,
            raw: ptz,
            weights
        };
    }

    function aim(target) {
        const {bearing, range} = bearingRange(cameraPos, target);
        const tri = triangle(bearing, range);
        if (tri) {
            const [v0] = tri.vertices;
            // Pans unwrapped about the first vertex, in case the triangle spans the +-1 seam.
            const pans = tri.vertices.map((v) => v.ptz.x + 2 * Math.round((v0.ptz.x - v.ptz.x) / 2));
            const blend = (w, f) => tri.vertices.reduce((s, v, i) => s + w[i] * f(v, i), 0);
            /**
             * Weights of the same triangle in (bearing, f(range)); the chart ones if degenerate
             * or extrapolating (a weight below -WEIGHT_TOL).
             */
            const weightsBy = (f) => {
                const [a, b, c] = tri.vertices.map((v) => ({x: unwrap(v.bearing, bearing), y: f(v.range)}));
                const w = barycentric(a, b, c, bearing, f(range));
                return w && Math.min(...w) >= -WEIGHT_TOL ? w : tri.weights;
            };
            const wView = weightsBy(tiltX);
            const wZoom = weightsBy((r) => r);
            const zooms = tri.vertices.map((v) => v.ptz.zoom);
            const ptz = {
                x: blend(wView, (v, i) => pans[i]),
                y: blend(wView, (v) => v.ptz.y),
                zoom: clamp(
                    blend(wZoom, (v) => v.ptz.zoom),
                    Math.min(...zooms),
                    Math.max(...zooms)
                )
            };
            return result(bearing, range, ptz, {pan: false, tilt: false, zoom: false}, tri.vertices, 'triangle', {
                chart: tri.weights,
                view: wView,
                zoom: wZoom
            });
        }
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
        return result(
            bearing,
            range,
            {x: pan.value, y: tilt.value, zoom: zoom.value},
            {pan: pan.outside, tilt: tilt.outside, zoom: zoom.outside},
            near,
            'nearest'
        );
    }

    return {aim, samples: samples.length};
}

module.exports = {buildCalibration, fitLine, unwrapPan, wrapPan, NEIGHBOURS};
