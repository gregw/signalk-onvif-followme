'use strict';
/*
 * Pure helpers for the motion probe: rates from timed GetStatus samples. No ONVIF or camera
 * knowledge beyond the normalised PtzStatus shape. Samples are {t (ms), x, y, zoom}; t is our
 * clock at the middle of the GetStatus round trip, never the camera's UtcTime (wiki/phase0.md:
 * it runs an hour off).
 */

/** Pan is circular over [-1, 1]: unwrap a sequence so neighbours differ by less than 1. */
function unwrapSeries(values) {
    const out = [];
    for (const v of values) {
        if (v === null || v === undefined) {
            out.push(null);
            continue;
        }
        const prev = out.length ? out[out.length - 1] : null;
        out.push(prev === null ? v : v + 2 * Math.round((prev - v) / 2));
    }
    return out;
}

/** Axis values of samples, pan unwrapped. */
function axisValues(samples, axis) {
    const v = samples.map((s) => s[axis]);
    return axis === 'x' ? unwrapSeries(v) : v;
}

/**
 * Least squares rate (units/s) of one axis over samples with t in [fromMs, toMs].
 * @returns {{rate: number|null, n: number, rms: number|null}} rms residual in units
 */
function fitRate(samples, axis, fromMs = -Infinity, toMs = Infinity) {
    const vals = axisValues(samples, axis);
    const pts = samples
        .map((s, i) => ({t: s.t / 1000, v: vals[i]}))
        .filter((p, i) => p.v !== null && samples[i].t >= fromMs && samples[i].t <= toMs);
    const n = pts.length;
    if (n < 3) return {rate: null, n, rms: null};
    const mt = pts.reduce((a, p) => a + p.t, 0) / n;
    const mv = pts.reduce((a, p) => a + p.v, 0) / n;
    const stt = pts.reduce((a, p) => a + (p.t - mt) ** 2, 0);
    if (stt === 0) return {rate: null, n, rms: null};
    const rate = pts.reduce((a, p) => a + (p.t - mt) * (p.v - mv), 0) / stt;
    const rms = Math.sqrt(pts.reduce((a, p) => a + (p.v - mv - rate * (p.t - mt)) ** 2, 0) / n);
    return {rate, n, rms};
}

/**
 * Rate between consecutive samples (units/s), at the midpoint time. Pairs with no change in
 * position are kept (rate 0): they show how often GetStatus actually updates.
 * @returns {{t: number, rate: number}[]}
 */
function rateSeries(samples, axis) {
    const vals = axisValues(samples, axis);
    const out = [];
    for (let i = 1; i < samples.length; i++) {
        if (vals[i] === null || vals[i - 1] === null) continue;
        const dt = (samples[i].t - samples[i - 1].t) / 1000;
        if (dt <= 0) continue;
        out.push({t: (samples[i].t + samples[i - 1].t) / 2, rate: (vals[i] - vals[i - 1]) / dt});
    }
    return out;
}

/** Time (ms) of the first sample that has moved more than eps from the first, or null. */
function firstMotion(samples, axis, eps = 0.001) {
    const vals = axisValues(samples, axis);
    const v0 = vals.find((v) => v !== null);
    for (let i = 0; i < samples.length; i++) {
        if (vals[i] !== null && Math.abs(vals[i] - v0) > eps) return samples[i].t;
    }
    return null;
}

/**
 * Smoothness of a run expected to move at a steady rate: per-step rates (over windowMs, so
 * GetStatus quantisation does not dominate) between fromMs and toMs, against the fitted rate.
 * A dip is a window whose rate is below `dipFraction` of the fitted rate.
 * @returns {{rate: number|null, minRate: number|null, maxRate: number|null, dips: number[], windows: number}}
 *   dips: window start times (ms)
 */
function steadiness(samples, axis, fromMs, toMs, {windowMs = 500, dipFraction = 0.5} = {}) {
    const {rate} = fitRate(samples, axis, fromMs, toMs);
    const vals = axisValues(samples, axis);
    const inRange = samples
        .map((s, i) => ({t: s.t, v: vals[i]}))
        .filter((p) => p.v !== null && p.t >= fromMs && p.t <= toMs);
    const rates = [];
    const dips = [];
    let j = 0;
    for (let i = 0; i < inRange.length; i++) {
        while (j < inRange.length && inRange[j].t - inRange[i].t < windowMs) j++;
        if (j >= inRange.length) break;
        const r = (inRange[j].v - inRange[i].v) / ((inRange[j].t - inRange[i].t) / 1000);
        rates.push(r);
        if (rate !== null && Math.abs(rate) > 0 && r / rate < dipFraction) dips.push(inRange[i].t);
    }
    return {
        rate,
        minRate: rates.length ? Math.min(...rates) : null,
        maxRate: rates.length ? Math.max(...rates) : null,
        dips,
        windows: rates.length
    };
}

/**
 * Ramp: from a command at t0 (ms) to a new steady rate `target`, the first time the
 * windowed rate is within `frac` of it.
 * @returns {number|null} ms after t0
 */
function rampTime(samples, axis, t0, target, {windowMs = 400, frac = 0.1} = {}) {
    const vals = axisValues(samples, axis);
    const pts = samples.map((s, i) => ({t: s.t, v: vals[i]})).filter((p) => p.v !== null && p.t >= t0);
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
        while (j < pts.length && pts[j].t - pts[i].t < windowMs) j++;
        if (j >= pts.length) return null;
        const r = (pts[j].v - pts[i].v) / ((pts[j].t - pts[i].t) / 1000);
        if (Math.abs(r - target) <= Math.abs(target) * frac) return pts[i].t - t0;
    }
    return null;
}

/**
 * Group measured rates into distinct levels: sorted |rate|, a new level when a rate is more
 * than `tol` (relative) above the previous level's first value. Few levels over many
 * commanded velocities means the camera quantises its speed.
 * @param {{v: number, rate: number|null}[]} curve
 * @returns {{rate: number, vs: number[]}[]}
 */
function speedLevels(curve, tol = 0.08) {
    const pts = curve
        .filter((c) => c.rate !== null)
        .map((c) => ({v: c.v, r: Math.abs(c.rate)}))
        .sort((a, b) => a.r - b.r);
    const levels = [];
    for (const p of pts) {
        const last = levels[levels.length - 1];
        if (last && p.r <= last.rate * (1 + tol) + 1e-6) last.vs.push(p.v);
        else levels.push({rate: p.r, vs: [p.v]});
    }
    return levels;
}

/** Percentiles of a list of numbers. */
function percentiles(values, ps = [0.5, 0.95, 1]) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return ps.map(() => null);
    return ps.map((p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]);
}

module.exports = {unwrapSeries, fitRate, rateSeries, firstMotion, steadiness, rampTime, speedLevels, percentiles};
