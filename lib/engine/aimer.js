'use strict';
/*
 * Aimer: (target, zone, camera pose, calibration samples) -> normalised PTZ.
 * Pure: no Signal K or ONVIF imports. Zone choice is engine/zones.js; this resolves what a
 * chosen zone means for one target position.
 *
 *  - fixed zone:    its stored view, whatever the target position.
 *  - followme zone: the calibration model (engine/calibration.js) at the target.
 */

const {buildCalibration} = require('./calibration');
const {bearingRange} = require('./geometry');
const {selectZone, initialState} = require('./zones');

class AimError extends Error {}

/**
 * @param {object} p
 * @param {{latitude: number, longitude: number}} p.target
 * @param {object} p.zone
 * @param {{latitude: number, longitude: number, height?: number}|null} p.cameraPosition
 * @param {object[]} p.samples calibration samples the zone uses
 * @returns {{x: number, y: number, zoom: number, bearing?: number, range?: number, outside?: object}}
 * @throws {AimError} when the zone cannot produce an aim (no view, no position, too few samples)
 */
function aimZone({target, zone, cameraPosition, samples}) {
    if (zone.mode.type === 'fixed') {
        if (!zone.mode.ptz) throw new AimError(`fixed zone ${zone.geometry.refName} has no view set`);
        const where = cameraPosition ? bearingRange(cameraPosition, target) : {};
        return {...zone.mode.ptz, ...where};
    }
    if (!cameraPosition) throw new AimError('camera position is not set');
    let model;
    try {
        model = buildCalibration(cameraPosition, samples);
    } catch (err) {
        throw new AimError(`${err.message} (have ${samples.length})`);
    }
    return model.aim(target);
}

/**
 * One-off aim for a single position: the zone the target is in now (no hold, no history),
 * then aimZone. Used by the webapp's test aim; the follow loop keeps selector state instead.
 * @returns {{zone: object|null, ptz: object|null}}
 */
function aimOnce({target, zones, cameraPosition, samplesFor}) {
    const sel = selectZone(initialState(), {position: target, zones, holdMs: 0, now: 0});
    const zone = zones.find((z) => z.id === sel.activeId) || null;
    if (!zone) return {zone: null, ptz: null};
    return {zone, ptz: aimZone({target, zone, cameraPosition, samples: samplesFor(zone)})};
}

module.exports = {aimZone, aimOnce, AimError};
