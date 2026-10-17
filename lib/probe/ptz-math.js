'use strict';
/*
 * Pure helpers for the Phase 0 probe: target selection, readback comparison, settling.
 * No ONVIF or camera knowledge beyond the normalised PtzStatus shape.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Error between commanded and read-back value on one axis.
 * With wrap, the axis is circular over [min,max] (a 360 degree pan reports -1 and 1 as
 * the same heading), so the shorter way round is used.
 * @returns {number|null} absolute error, null if readback missing
 */
function axisError(cmd, got, {min = -1, max = 1, wrap = false} = {}) {
    if (got === null || got === undefined || !Number.isFinite(got)) return null;
    let d = Math.abs(cmd - got);
    if (wrap) {
        const span = max - min;
        d = d % span;
        d = Math.min(d, span - d);
    }
    return d;
}

/**
 * Pick AbsoluteMove targets well inside the absolute space, avoiding the end stops.
 * Pan/tilt at 25% and 75% of range in a box pattern; zoom kept low on most moves so the
 * pan/tilt result is easy to see, with one move at mid zoom.
 * @param {{x: {min, max}, y: {min, max}, zoom?: {min, max}}} space
 */
function pickTargets(space) {
    const at = (r, f) => +(r.min + (r.max - r.min) * f).toFixed(4);
    const z = space.zoom && space.zoom.max > space.zoom.min ? space.zoom : null;
    const zLow = z ? at(z, 0.1) : 0;
    const zMid = z ? at(z, 0.5) : 0;
    return [
        {x: at(space.x, 0.25), y: at(space.y, 0.25), zoom: zLow},
        {x: at(space.x, 0.75), y: at(space.y, 0.25), zoom: zLow},
        {x: at(space.x, 0.75), y: at(space.y, 0.75), zoom: zMid},
        {x: at(space.x, 0.25), y: at(space.y, 0.75), zoom: zLow}
    ];
}

function moved(a, b, eps) {
    for (const k of ['x', 'y', 'zoom']) {
        if (a[k] === null || b[k] === null) continue;
        if (Math.abs(a[k] - b[k]) > eps) return true;
    }
    return false;
}

function isIdle(s) {
    if (!s.moveStatus) return null;
    return !/MOVING/i.test(s.moveStatus);
}

/**
 * Poll status until the position stops changing.
 * Settled when `stableReads` consecutive reads agree within eps and, if the camera reports
 * MoveStatus, it no longer says MOVING. A camera that reports IDLE while still moving is
 * caught by the position check. Keeps at most maxSamples (the most recent) for the report.
 * @param {() => Promise<object>} getStatus
 */
async function waitSettled(
    getStatus,
    {
        pollMs = 300,
        stableReads = 3,
        eps = 0.001,
        timeoutMs = 20000,
        minWaitMs = 0,
        maxSamples = 100,
        wait = sleep,
        now = Date.now
    } = {}
) {
    const t0 = now();
    if (minWaitMs) await wait(minWaitMs);
    const samples = [];
    let prev = null;
    let stable = 0;
    for (;;) {
        const s = await getStatus();
        samples.push({t: now() - t0, x: s.x, y: s.y, zoom: s.zoom, moveStatus: s.moveStatus});
        if (samples.length > maxSamples) samples.shift();
        if (prev && !moved(prev, s, eps)) stable++;
        else stable = 0;
        prev = s;
        if (stable >= stableReads - 1 && isIdle(s) !== false) {
            return {status: s, settled: true, elapsedMs: now() - t0, samples};
        }
        if (now() - t0 > timeoutMs) return {status: s, settled: false, elapsedMs: now() - t0, samples};
        await wait(pollMs);
    }
}

module.exports = {axisError, pickTargets, waitSettled, moved, sleep};
