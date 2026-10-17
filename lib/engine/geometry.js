'use strict';
/*
 * Pure geometry for aiming: bearing and range from the camera, point in polygon, bearing
 * unwrap. No Signal K or ONVIF imports.
 *
 * Units: angles in radians, distances in metres. Bearings are true, clockwise from north,
 * in [0, 2*PI). Positions are {latitude, longitude} in degrees, as Signal K
 * navigation.position and resource coordinates are; polygons are GeoJSON [lon, lat] rings.
 */

const TWO_PI = 2 * Math.PI;
const rad = (d) => (d * Math.PI) / 180;

// WGS84
const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);

/** Normalise an angle to [0, 2*PI). */
function wrap2pi(a) {
    const r = a % TWO_PI;
    return r < 0 ? r + TWO_PI : r;
}

/**
 * Vincenty inverse on the WGS84 ellipsoid: geodesic distance and initial bearing from p1 to p2.
 * Accurate to well under a millimetre. Fails to converge only for nearly antipodal points,
 * which a shore camera never sees; then it throws.
 * @param {{latitude: number, longitude: number}} p1 degrees
 * @param {{latitude: number, longitude: number}} p2 degrees
 * @returns {{range: number, bearing: number, finalBearing: number}} metres, radians
 */
function inverse(p1, p2) {
    const L = rad(p2.longitude - p1.longitude);
    const U1 = Math.atan((1 - F) * Math.tan(rad(p1.latitude)));
    const U2 = Math.atan((1 - F) * Math.tan(rad(p2.latitude)));
    const sinU1 = Math.sin(U1);
    const cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2);
    const cosU2 = Math.cos(U2);

    let lambda = L;
    let sinLambda, cosLambda, sinSigma, cosSigma, sigma, cosSqAlpha, cos2SigmaM;
    for (let i = 0; i < 200; i++) {
        sinLambda = Math.sin(lambda);
        cosLambda = Math.cos(lambda);
        const t = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
        sinSigma = Math.sqrt(cosU2 * sinLambda * (cosU2 * sinLambda) + t * t);
        if (sinSigma === 0) return {range: 0, bearing: 0, finalBearing: 0}; // coincident
        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
        sigma = Math.atan2(sinSigma, cosSigma);
        const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
        cosSqAlpha = 1 - sinAlpha * sinAlpha;
        cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0; // equatorial line
        const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
        const prev = lambda;
        lambda =
            L +
            (1 - C) *
                F *
                sinAlpha *
                (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
        if (Math.abs(lambda - prev) < 1e-12) {
            const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
            const AA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
            const BB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
            const deltaSigma =
                BB *
                sinSigma *
                (cos2SigmaM +
                    (BB / 4) *
                        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
                            (BB / 6) *
                                cos2SigmaM *
                                (-3 + 4 * sinSigma * sinSigma) *
                                (-3 + 4 * cos2SigmaM * cos2SigmaM)));
            const range = B * AA * (sigma - deltaSigma);
            const bearing = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
            const finalBearing = Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda);
            return {range, bearing: wrap2pi(bearing), finalBearing: wrap2pi(finalBearing)};
        }
    }
    throw new Error('Vincenty inverse did not converge (nearly antipodal points)');
}

/**
 * Bearing and range from an observer (the camera) to a target.
 * @returns {{bearing: number, range: number}} radians true, metres
 */
function bearingRange(from, to) {
    const {bearing, range} = inverse(from, to);
    return {bearing, range};
}

/**
 * Angle below horizontal from a camera at `height` metres above the target's plane to a target
 * at `range` metres. Flat earth: at the ranges a shore camera sees (a few km), curvature and
 * refraction change this by well under 0.01 degrees.
 */
function depression(height, range) {
    return Math.atan2(height, range);
}

/**
 * Unwrap a bearing to lie within PI of a reference, so a set of bearings crossing 000 stays
 * continuous (350 and 010 degrees become 350 and 370, not 350 and 10).
 */
function unwrap(bearing, ref) {
    return ref + (wrap2pi(bearing - ref + Math.PI) - Math.PI);
}

/**
 * Unwrap a list of bearings about their circular mean.
 * @param {number[]} bearings radians
 * @returns {number[]} same order, continuous
 */
function unwrapAll(bearings) {
    if (bearings.length === 0) return [];
    const s = bearings.reduce((a, b) => a + Math.sin(b), 0);
    const c = bearings.reduce((a, b) => a + Math.cos(b), 0);
    const mean = Math.atan2(s, c);
    return bearings.map((b) => unwrap(b, mean));
}

/** Ray casting point in ring. `ring` is [[lon, lat], ...], closed or not. */
function inRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Point in a GeoJSON Polygon or MultiPolygon geometry (outer ring minus holes), or in a bare
 * ring of [lon, lat] pairs. Planar in lon/lat, which is fine for harbour-sized polygons that
 * do not cross the antimeridian.
 * @param {{latitude: number, longitude: number}} p degrees
 * @param {object|number[][]} geom {type:'Polygon'|'MultiPolygon', coordinates} or a ring
 */
function pointInPolygon(p, geom) {
    const {longitude: lon, latitude: lat} = p;
    const inPoly = (rings) =>
        rings.length > 0 && inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h));
    if (Array.isArray(geom)) return inRing(lon, lat, geom);
    if (!geom || !Array.isArray(geom.coordinates)) return false;
    if (geom.type === 'Polygon') return inPoly(geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.some(inPoly);
    return false;
}

module.exports = {inverse, bearingRange, depression, unwrap, unwrapAll, pointInPolygon, wrap2pi};
