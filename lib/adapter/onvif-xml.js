'use strict';
/*
 * Normalise raw ONVIF SOAP responses into the adapter's plain shapes.
 *
 * Every backend hands its raw response XML to these functions, so the normalised
 * output is identical whichever library sent the request. The libraries each have
 * their own parsed shapes (and agsh 0.8.3 getStatus silently defaults a missing
 * Position to 0), so reading the XML ourselves is what lets Phase 0 tell "camera
 * did not report a position" apart from "camera is at 0,0".
 *
 * Element names follow the ONVIF ver10 schema (tt:) and ver10 media / ver20 ptz
 * WSDLs. Namespace prefixes are stripped, so tt:PanTilt and PanTilt match alike.
 */

const xml2js = require('xml2js');

const PARSE_OPTS = {
    tagNameProcessors: [xml2js.processors.stripPrefix],
    attrNameProcessors: [xml2js.processors.stripPrefix],
    explicitArray: true
};

/** @param {string} xml */
async function parseXml(xml) {
    return xml2js.parseStringPromise(xml, PARSE_OPTS);
}

function kids(node, name) {
    if (!node || typeof node !== 'object') return [];
    const v = node[name];
    return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

function kid(node, ...path) {
    let n = node;
    for (const name of path) {
        n = kids(n, name)[0];
        if (n === undefined) return undefined;
    }
    return n;
}

function text(node) {
    if (node === undefined || node === null) return undefined;
    if (typeof node === 'string') return node.trim();
    if (typeof node._ === 'string') return node._.trim();
    return undefined;
}

function attr(node, name) {
    return node && node.$ ? node.$[name] : undefined;
}

function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

async function body(xml) {
    const doc = await parseXml(xml);
    return kid(doc, 'Envelope', 'Body');
}

function range(node) {
    if (!node) return undefined;
    return {min: num(text(kid(node, 'Min'))), max: num(text(kid(node, 'Max')))};
}

/**
 * @param {string} xml GetDeviceInformationResponse
 */
async function deviceInformation(xml) {
    const r = kid(await body(xml), 'GetDeviceInformationResponse');
    return {
        manufacturer: text(kid(r, 'Manufacturer')),
        model: text(kid(r, 'Model')),
        firmwareVersion: text(kid(r, 'FirmwareVersion')),
        serialNumber: text(kid(r, 'SerialNumber')),
        hardwareId: text(kid(r, 'HardwareId'))
    };
}

/**
 * Media1 GetProfilesResponse (trt:Profiles) or Media2 (tr2:Profiles with Configurations).
 * @param {string} xml
 */
async function profiles(xml) {
    const r = kid(await body(xml), 'GetProfilesResponse');
    return kids(r, 'Profiles').map((p) => {
        const conf = kid(p, 'Configurations');
        const ptz = kid(p, 'PTZConfiguration') || kid(conf, 'PTZ');
        const enc = kid(p, 'VideoEncoderConfiguration') || kid(conf, 'VideoEncoder');
        const res = kid(enc, 'Resolution');
        return {
            token: attr(p, 'token'),
            name: text(kid(p, 'Name')),
            ptzConfigurationToken: ptz ? attr(ptz, 'token') : null,
            ptzNodeToken: ptz ? text(kid(ptz, 'NodeToken')) : null,
            encoding: enc ? text(kid(enc, 'Encoding')) : undefined,
            resolution: res ? {width: num(text(kid(res, 'Width'))), height: num(text(kid(res, 'Height')))} : undefined
        };
    });
}

function limits(node) {
    const r = kid(node, 'Range');
    if (!r) return undefined;
    return {uri: text(kid(r, 'URI')), x: range(kid(r, 'XRange')), y: range(kid(r, 'YRange'))};
}

/**
 * PTZ GetConfigurationsResponse.
 * @param {string} xml
 */
async function ptzConfigurations(xml) {
    const r = kid(await body(xml), 'GetConfigurationsResponse');
    return kids(r, 'PTZConfiguration').map((c) => ({
        token: attr(c, 'token'),
        name: text(kid(c, 'Name')),
        nodeToken: text(kid(c, 'NodeToken')),
        defaultAbsolutePanTiltPositionSpace: text(kid(c, 'DefaultAbsolutePantTiltPositionSpace')),
        defaultAbsoluteZoomPositionSpace: text(kid(c, 'DefaultAbsoluteZoomPositionSpace')),
        defaultContinuousPanTiltVelocitySpace: text(kid(c, 'DefaultContinuousPanTiltVelocitySpace')),
        defaultPTZTimeout: text(kid(c, 'DefaultPTZTimeout')),
        panTiltLimits: limits(kid(c, 'PanTiltLimits')),
        zoomLimits: limits(kid(c, 'ZoomLimits'))
    }));
}

/**
 * PTZ GetConfigurationOptionsResponse, flattened to a list of spaces.
 * Space names are the ONVIF element names, e.g. AbsolutePanTiltPositionSpace.
 * @param {string} xml
 */
async function ptzConfigurationOptions(xml) {
    const o = kid(await body(xml), 'GetConfigurationOptionsResponse', 'PTZConfigurationOptions');
    const spacesNode = kid(o, 'Spaces');
    const spaces = [];
    if (spacesNode) {
        for (const name of Object.keys(spacesNode)) {
            if (name === '$' || name === 'Extension') continue;
            for (const s of kids(spacesNode, name)) {
                spaces.push({
                    name,
                    uri: text(kid(s, 'URI')),
                    x: range(kid(s, 'XRange')),
                    y: range(kid(s, 'YRange'))
                });
            }
        }
    }
    return {spaces, ptzTimeout: range(kid(o, 'PTZTimeout'))};
}

/**
 * PTZ GetStatusResponse. Any axis the camera did not report is null, never 0.
 * @param {string} xml
 * @returns {Promise<import('./index').PtzStatus>}
 */
async function ptzStatus(xml) {
    const s = kid(await body(xml), 'GetStatusResponse', 'PTZStatus');
    const pos = kid(s, 'Position');
    const pt = kid(pos, 'PanTilt');
    const z = kid(pos, 'Zoom');
    const ms = kid(s, 'MoveStatus');
    let moveStatus;
    if (ms !== undefined) {
        moveStatus = text(ms);
        if (moveStatus === undefined) {
            const p = text(kid(ms, 'PanTilt'));
            const zz = text(kid(ms, 'Zoom'));
            moveStatus = [p && `panTilt=${p}`, zz && `zoom=${zz}`].filter(Boolean).join(' ') || undefined;
        }
    }
    return {
        x: num(attr(pt, 'x')),
        y: num(attr(pt, 'y')),
        zoom: num(attr(z, 'x')),
        moveStatus,
        error: text(kid(s, 'Error')),
        utcTime: text(kid(s, 'UtcTime'))
    };
}

/** @param {string} xml GetSnapshotUriResponse or GetStreamUriResponse */
async function mediaUri(xml) {
    const b = await body(xml);
    const r = kid(b, 'GetSnapshotUriResponse') || kid(b, 'GetStreamUriResponse');
    // Media1 wraps in MediaUri/Uri, Media2 returns Uri directly.
    return text(kid(r, 'MediaUri', 'Uri')) || text(kid(r, 'Uri'));
}

module.exports = {
    parseXml,
    deviceInformation,
    profiles,
    ptzConfigurations,
    ptzConfigurationOptions,
    ptzStatus,
    mediaUri
};
