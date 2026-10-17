'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const {getWithAuth, digestHeader, parseChallenge} = require('../lib/adapter/http-get');

test('digestHeader matches the RFC 2617 section 3.5 worked example', () => {
    const h = digestHeader({
        challenge:
            'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
        method: 'GET',
        uri: '/dir/index.html',
        username: 'Mufasa',
        password: 'Circle Of Life',
        cnonce: '0a4f113b'
    });
    assert.equal(parseChallenge(h).response, '6629fae49393a05397450978507c4ef1');
    assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
});

function startServer(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
    });
}

test('getWithAuth answers a Digest challenge', async (t) => {
    const realm = 'cam';
    const nonce = 'abc123';
    const srv = await startServer((req, res) => {
        const a = req.headers.authorization;
        if (!a) {
            res.writeHead(401, {'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"`});
            return res.end();
        }
        const p = parseChallenge(a);
        const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
        const expect = md5(`${md5(`u:${realm}:pw`)}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${md5(`GET:${p.uri}`)}`);
        if (p.response !== expect) {
            res.writeHead(403);
            return res.end();
        }
        res.writeHead(200, {'Content-Type': 'image/jpeg'});
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    });
    t.after(() => srv.close());
    const r = await getWithAuth(`http://127.0.0.1:${srv.address().port}/snap.jpg?ch=1`, {
        username: 'u',
        password: 'pw'
    });
    assert.equal(r.status, 200);
    assert.equal(r.auth, 'digest');
    assert.equal(r.body[0], 0xff);
});

test('getWithAuth falls back to Basic and passes through unauthenticated', async (t) => {
    const srv = await startServer((req, res) => {
        if (req.url === '/open') return res.end('ok');
        const ok = req.headers.authorization === 'Basic ' + Buffer.from('u:pw').toString('base64');
        res.writeHead(ok ? 200 : 401, ok ? {} : {'WWW-Authenticate': 'Basic realm="cam"'});
        res.end(ok ? 'img' : '');
    });
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.address().port}`;
    const b = await getWithAuth(`${base}/snap`, {username: 'u', password: 'pw'});
    assert.equal(b.status, 200);
    assert.equal(b.auth, 'basic');
    const o = await getWithAuth(`${base}/open`, {username: 'u', password: 'pw'});
    assert.equal(o.auth, 'none');
    assert.equal(o.body.toString(), 'ok');
});
