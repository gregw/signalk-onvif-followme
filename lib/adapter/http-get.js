'use strict';
/*
 * HTTP GET with Basic or Digest auth, for snapshot URIs.
 *
 * ONVIF snapshot URIs are plain HTTP, outside SOAP, and cameras protect them with
 * whatever their web server uses: nothing, Basic, or Digest (RFC 7616, usually MD5
 * with qop=auth). Node's fetch does not do Digest, so this does it by hand: try
 * unauthenticated, then answer the 401 challenge.
 *
 * Cameras commonly serve HTTPS with a self-signed certificate (the VIP G28 returns an
 * https:// snapshot URI). allowSelfSigned skips certificate verification for that request;
 * the caller decides when (BaseAdapter only allows it for the camera's own host).
 * `tlsAuthorized` in the result says whether the certificate actually verified.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

/**
 * @param {string} url
 * @param {{headers?: object, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
function rawGet(url, {headers = {}, timeoutMs = 10000, allowSelfSigned = false} = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const opts = {headers, timeout: timeoutMs};
        if (isHttps && allowSelfSigned) opts.rejectUnauthorized = false;
        const req = lib.get(u, opts, (res) => {
            const chunks = [];
            const tlsAuthorized = isHttps ? res.socket.authorized === true : null;
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
                resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), tlsAuthorized})
            );
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms: ${u.host}`)));
        req.on('error', reject);
    });
}

/** Parse `Digest realm="x", nonce="y", qop="auth"` into an object. */
function parseChallenge(header) {
    const out = {};
    const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
    let m;
    while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    return out;
}

function hash(alg, s) {
    return crypto.createHash(alg).update(s).digest('hex');
}

/**
 * Build a Digest Authorization header value.
 * @param {object} p
 */
function digestHeader({challenge, method, uri, username, password, cnonce, nc = '00000001'}) {
    const c = parseChallenge(challenge);
    const alg = (c.algorithm || 'MD5').toUpperCase();
    const h = alg.startsWith('SHA-256') ? 'sha256' : 'md5';
    cnonce = cnonce || crypto.randomBytes(8).toString('hex');
    let ha1 = hash(h, `${username}:${c.realm}:${password}`);
    if (alg.endsWith('-SESS')) ha1 = hash(h, `${ha1}:${c.nonce}:${cnonce}`);
    const ha2 = hash(h, `${method}:${uri}`);
    const qop = c.qop
        ? c.qop
              .split(',')
              .map((q) => q.trim())
              .find((q) => q === 'auth')
        : undefined;
    const response = qop
        ? hash(h, `${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : hash(h, `${ha1}:${c.nonce}:${ha2}`);
    const parts = [
        `username="${username}"`,
        `realm="${c.realm}"`,
        `nonce="${c.nonce}"`,
        `uri="${uri}"`,
        `algorithm=${c.algorithm || 'MD5'}`,
        `response="${response}"`
    ];
    if (c.opaque !== undefined) parts.push(`opaque="${c.opaque}"`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    return 'Digest ' + parts.join(', ');
}

/**
 * GET a URL, answering a Basic or Digest 401 challenge if one comes back.
 * @param {string} url
 * @param {{username?: string, password?: string, timeoutMs?: number, allowSelfSigned?: boolean}} [opts]
 * @returns {Promise<{status: number, headers: object, body: Buffer, auth: 'none'|'basic'|'digest', tlsAuthorized: boolean|null}>}
 */
async function getWithAuth(url, {username, password, timeoutMs, allowSelfSigned} = {}) {
    const first = await rawGet(url, {timeoutMs, allowSelfSigned});
    if (first.status !== 401 || !username) return {...first, auth: 'none'};
    const www = [].concat(first.headers['www-authenticate'] || []);
    const digest = www.find((h) => /^digest/i.test(h));
    const u = new URL(url);
    let authorization;
    let auth;
    if (digest) {
        authorization = digestHeader({
            challenge: digest,
            method: 'GET',
            uri: u.pathname + u.search,
            username,
            password
        });
        auth = 'digest';
    } else {
        authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
        auth = 'basic';
    }
    const second = await rawGet(url, {headers: {Authorization: authorization}, timeoutMs, allowSelfSigned});
    return {...second, auth};
}

module.exports = {getWithAuth, digestHeader, parseChallenge};
