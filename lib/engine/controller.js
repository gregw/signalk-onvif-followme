'use strict';
/*
 * Move controller: given the PTZ we want now, decide whether to command the camera.
 * Pure: no timers, Signal K or ONVIF; time comes in as `now` (ms). Brief: "Control loop":
 * deadband, min command interval, no overlap.
 *
 *  - Deadband per axis against the last commanded value: an axis within its deadband is
 *    held at the last commanded value; if every axis is within, nothing is sent. Holding
 *    zoom through small range changes avoids zoom (and focus) hunting while panning.
 *  - Min interval between commands.
 *  - waitIdle: optionally do not command while the camera reports MOVING, unless the last
 *    command is older than idleTimeoutMs (a stuck MOVING must not stop following for good).
 *  - Pan differences are taken the short way round (period 2 over [-1, 1]).
 *  - keepaliveMs: when set and nothing has been sent for that long, re-send the last
 *    command even inside the deadband, so the camera's own scan does not resume (used for
 *    fixed zones, which otherwise send once).
 */

const panDiff = (a, b) => {
    const d = Math.abs(a - b) % 2;
    return Math.min(d, 2 - d);
};

/**
 * @param {object} p
 * @param {{x: number, y: number, zoom: number}|null} p.want
 * @param {{ptz: {x: number, y: number, zoom: number}, at: number}|null} p.last last command sent
 * @param {{moveStatus?: string}|null} p.status latest camera status, if polled
 * @param {number} p.now
 * @param {object} p.settings
 * @param {number} p.settings.minIntervalMs
 * @param {number} p.settings.panDeadband
 * @param {number} p.settings.tiltDeadband
 * @param {number} p.settings.zoomDeadband
 * @param {boolean} [p.settings.waitIdle]
 * @param {number} [p.settings.idleTimeoutMs]
 * @param {number} [p.settings.keepaliveMs] re-send interval inside the deadband; 0 or absent = never
 * @returns {{send: {x: number, y: number, zoom: number}|null, reason: string}}
 */
function decide({want, last, status, now, settings}) {
    if (!want) return {send: null, reason: 'no target'};
    if (!last) return {send: {...want}, reason: 'first'};
    const hold = {
        x: panDiff(want.x, last.ptz.x) <= settings.panDeadband,
        y: Math.abs(want.y - last.ptz.y) <= settings.tiltDeadband,
        zoom: Math.abs(want.zoom - last.ptz.zoom) <= settings.zoomDeadband
    };
    if (hold.x && hold.y && hold.zoom) {
        if (settings.keepaliveMs && now - last.at >= settings.keepaliveMs)
            return {send: {...last.ptz}, reason: 'keepalive'};
        return {send: null, reason: 'deadband'};
    }
    if (now - last.at < settings.minIntervalMs) return {send: null, reason: 'interval'};
    if (
        settings.waitIdle &&
        status &&
        /MOVING/i.test(status.moveStatus || '') &&
        now - last.at < (settings.idleTimeoutMs || 10000)
    ) {
        return {send: null, reason: 'moving'};
    }
    return {
        send: {
            x: hold.x ? last.ptz.x : want.x,
            y: hold.y ? last.ptz.y : want.y,
            zoom: hold.zoom ? last.ptz.zoom : want.zoom
        },
        reason: 'move'
    };
}

/**
 * Dead reckon a position ahead by leadS seconds along course over ground. Planar about the
 * position, using WGS84 metres per degree: fine for a few tens of metres of lead.
 * @param {{latitude: number, longitude: number}} pos
 * @param {number|null} cog radians true
 * @param {number|null} sog m/s
 * @param {number} leadS
 * @param {(lat: number) => {lat: number, lon: number}} metresPerDegree
 */
function predict(pos, cog, sog, leadS, metresPerDegree) {
    if (!leadS || cog === null || cog === undefined || !sog || sog < 0.2) return pos;
    const k = metresPerDegree(pos.latitude);
    const d = sog * leadS;
    return {
        latitude: pos.latitude + (d * Math.cos(cog)) / k.lat,
        longitude: pos.longitude + (d * Math.sin(cog)) / k.lon
    };
}

module.exports = {decide, predict, panDiff};
