'use strict';
/*
 * Zone selection with hysteresis, for one camera (wiki/decisions.md, "Zone switching").
 * Pure: no Signal K, ONVIF or timers; time comes in as `now` (ms).
 *
 * Rules:
 *  - Enter: a zone is a candidate only when the target is inside it by at least marginM.
 *  - Stay: the active zone is kept while the target is not outside it by marginM or more,
 *    even when the target is also inside another (higher priority) zone. Sticky overlaps.
 *  - Choose: among candidates, lowest priority number wins; ties by id for determinism.
 *  - Hold: any change of active zone, including release to none, happens only after the
 *    same desired outcome has held for holdMs. A flip-flop restarts the hold.
 *  - Zones without geometry never match.
 *
 * The band between "enter" (+margin inside) and "leave" (margin outside) is 2 * marginM
 * wide, which absorbs GPS jitter at a boundary.
 */

const {signedDistanceToEdge} = require('./geometry');

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
 * @param {number} input.marginM
 * @param {number} input.holdMs
 * @param {number} input.now ms
 * @returns {SelectorState & {changed: boolean, desiredId: string|null}}
 */
function selectZone(prev, {position, zones, marginM, holdMs, now}) {
    const dist = new Map();
    const d = (z) => {
        if (!dist.has(z.id)) dist.set(z.id, z.geometry ? signedDistanceToEdge(position, z.geometry.polygon) : null);
        return dist.get(z.id);
    };

    let desiredId = null;
    const active = prev.activeId ? zones.find((z) => z.id === prev.activeId) : null;
    if (active && d(active) !== null && d(active) > -marginM) {
        desiredId = active.id;
    } else {
        const entering = zones
            .filter((z) => d(z) !== null && d(z) >= marginM)
            .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        desiredId = entering.length ? entering[0].id : null;
    }

    if (desiredId === prev.activeId) return {activeId: prev.activeId, pending: null, changed: false, desiredId};
    const since = prev.pending && prev.pending.id === desiredId ? prev.pending.since : now;
    if (now - since >= holdMs) return {activeId: desiredId, pending: null, changed: true, desiredId};
    return {activeId: prev.activeId, pending: {id: desiredId, since}, changed: false, desiredId};
}

module.exports = {selectZone, initialState};
