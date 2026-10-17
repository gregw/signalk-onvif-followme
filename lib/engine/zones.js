'use strict';
/*
 * Zone selection with hysteresis, for one camera (wiki/decisions.md, "Zone switching").
 * Pure: no Signal K, ONVIF or timers; time comes in as `now` (ms).
 *
 * Rules:
 *  - Stay: the active zone is kept while the target is inside it, even when the target is
 *    also inside another (higher priority) zone. Sticky overlaps: drawing neighbouring
 *    zones to overlap gives zone to zone hysteresis.
 *  - Choose: otherwise, among zones containing the target, the lowest priority number
 *    wins; ties by id for determinism.
 *  - Hold: any change of active zone, including release to none and entry from none,
 *    happens only after the same desired outcome has held for holdMs. A flip-flop restarts
 *    the hold. This absorbs GPS jitter at an outer edge and single bad fixes.
 *  - Zones without geometry never match.
 */

const {pointInPolygon} = require('./geometry');

/**
 * @typedef {object} SelectorState
 * @property {string|null} activeId
 * @property {{id: string|null, since: number}|null} pending desired change waiting out the hold
 */

/** @returns {SelectorState} */
function initialState() {
    return {activeId: null, pending: null};
}

/**
 * @param {SelectorState} prev
 * @param {object} input
 * @param {{latitude: number, longitude: number}} input.position target position
 * @param {{id: string, priority: number, geometry: {polygon: object}|null}[]} input.zones this camera's zones
 * @param {number} input.holdMs
 * @param {number} input.now ms
 * @returns {SelectorState & {changed: boolean, desiredId: string|null}}
 */
function selectZone(prev, {position, zones, holdMs, now}) {
    const inside = (z) => !!z.geometry && pointInPolygon(position, z.geometry.polygon);

    let desiredId = null;
    const active = prev.activeId ? zones.find((z) => z.id === prev.activeId) : null;
    if (active && inside(active)) {
        desiredId = active.id;
    } else {
        const containing = zones
            .filter(inside)
            .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        desiredId = containing.length ? containing[0].id : null;
    }

    if (desiredId === prev.activeId) return {activeId: prev.activeId, pending: null, changed: false, desiredId};
    const since = prev.pending && prev.pending.id === desiredId ? prev.pending.since : now;
    if (now - since >= holdMs) return {activeId: desiredId, pending: null, changed: true, desiredId};
    return {activeId: prev.activeId, pending: {id: desiredId, since}, changed: false, desiredId};
}

module.exports = {selectZone, initialState};
