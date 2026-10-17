'use strict';
// @ts-check
/*
 * CameraAdapter: the only seam through which anything talks to a camera.
 *
 * Nothing outside lib/adapter/ may know about ONVIF. Backends:
 *  - 'agsh'       onvif 0.8.3 (agsh/onvif, callback Cam API). Primary.
 *  - 'agsh-rc'    onvif 1.0.0-rc.3 (installed as onvif-rc, promise Onvif API). Watch only.
 *  - 'node-onvif' node-onvif as vendored by signalk-onvif-camera 1.3.2 (lib/adapter/vendor/node-onvif).
 *
 * Each backend uses its library to build, authenticate and send the SOAP request, then
 * normalises the raw response XML with onvif-xml.js so all backends return identical
 * shapes. `lastRaw` always holds the raw XML of the most recent response.
 *
 * Normalised PTZ space is whatever the camera's default absolute spaces are (usually
 * pan/tilt in [-1,1], zoom in [0,1]). The adapter does not rescale.
 */

/**
 * @typedef {object} CameraConn
 * @property {string} hostname
 * @property {number} [port] ONVIF device service port, default 80
 * @property {string} [username]
 * @property {string} [password]
 * @property {string} [profileToken] media profile to drive; default the first one with a PTZ configuration
 * @property {number} [timeoutMs] per request, default 10000
 */

/**
 * @typedef {object} PtzVector
 * @property {number} x pan
 * @property {number} y tilt
 * @property {number} zoom
 */

/**
 * @typedef {object} PtzStatus
 * @property {number|null} x pan, null if the camera did not report it
 * @property {number|null} y tilt, null if not reported
 * @property {number|null} zoom null if not reported
 * @property {string} [moveStatus] e.g. 'IDLE', 'MOVING', or 'panTilt=IDLE zoom=IDLE'
 * @property {string} [error]
 * @property {string} [utcTime]
 */

/**
 * @typedef {object} Profile
 * @property {string} token
 * @property {string} [name]
 * @property {string|null} ptzConfigurationToken
 * @property {string|null} ptzNodeToken
 * @property {string} [encoding]
 * @property {{width: number|null, height: number|null}} [resolution]
 */

/**
 * @typedef {object} CameraAdapter
 * @property {string} lib backend name
 * @property {string|null} lastRaw raw XML of the most recent response
 * @property {string|null} profileToken profile in use after connect
 * @property {(conn: CameraConn) => Promise<void>} connect
 * @property {() => Promise<PtzStatus>} getStatus
 * @property {(p: PtzVector, speed?: PtzVector) => Promise<void>} absoluteMove
 * @property {(v: PtzVector, timeoutMs?: number) => Promise<void>} continuousMove velocity, jog
 * @property {(d: PtzVector) => Promise<void>} relativeMove translation
 * @property {() => Promise<void>} stop
 * @property {() => Promise<string>} getSnapshotUri
 * @property {() => Promise<{status: number, contentType: string|undefined, auth: string, body: Buffer}>} fetchSnapshot
 * @property {() => Promise<string>} getStreamUri RTSP; reserved for the deferred stream option
 * @property {() => Promise<object>} getDeviceInformation discovery, used by Phase 0
 * @property {() => Promise<Profile[]>} getProfiles discovery
 * @property {() => Promise<object[]>} getPtzConfigurations discovery
 * @property {(configToken: string) => Promise<{spaces: object[], ptzTimeout?: object}>} getPtzConfigurationOptions discovery
 * @property {() => Promise<void>} close
 */

const LIBS = {
    agsh: () => require('./agsh'),
    'agsh-rc': () => require('./agsh-rc'),
    'node-onvif': () => require('./node-onvif')
};

/**
 * @param {string} lib one of Object.keys(LIBS)
 * @returns {CameraAdapter}
 */
function createAdapter(lib) {
    const load = LIBS[lib];
    if (!load) throw new Error(`unknown adapter lib '${lib}', expected one of ${Object.keys(LIBS).join(', ')}`);
    const Impl = load();
    return new Impl();
}

module.exports = {createAdapter, LIBS: Object.keys(LIBS)};
