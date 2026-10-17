'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runProbe} = require('../lib/probe/probe');
const {fakeCamera: makeFake, virtualClock} = require('./sim/fake-camera');

function fakeCamera(mode) {
    const clock = virtualClock();
    const {adapter} = makeFake(mode, {clock: clock.now});
    return {adapter, wait: clock.wait, now: clock.now};
}

const result = (r, id) => r.tests.find((t) => t.id === id).result;

test('honest camera passes every test and is restored', async () => {
    const {adapter, wait, now} = fakeCamera('honest');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9])
        assert.equal(result(r, id), 'PASS', `test ${id}: ${JSON.stringify(r.tests.find((t) => t.id === id).summary)}`);
    assert.equal(r.gate.absoluteMoveHonoured, true);
    const restore = r.tests.find((t) => t.id === 'restore');
    assert.match(restore.summary, /x=0.1 y=0 zoom=0/);
    assert.equal(r.snapshot[0], 0xff);
    assert.equal(r.snapshot[1], 0xd8);
});

test('ACK-only camera fails the gate with a clear reason', async () => {
    const {adapter, wait, now} = fakeCamera('ack-only');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    assert.equal(result(r, 5), 'FAIL');
    assert.equal(r.gate.absoluteMoveHonoured, false);
    assert.equal(r.gate.anyMoved, false);
    assert.match(r.tests.find((t) => t.id === 5).summary, /never changed/);
    assert.equal(result(r, 6), 'FAIL');
});

test('camera without status Position fails test 4 and skips moves', async () => {
    const {adapter, wait, now} = fakeCamera('no-pos');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    assert.equal(result(r, 4), 'FAIL');
    assert.equal(result(r, 5), 'SKIP');
    assert.equal(
        r.tests.find((t) => t.id === 'restore'),
        undefined
    );
});

test('--no-move and --only', async () => {
    const {adapter, wait, now} = fakeCamera('honest');
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now, noMove: true, only: new Set([4, 5, 7])});
    assert.equal(result(r, 1), 'PASS');
    assert.equal(result(r, 2), 'SKIP');
    assert.equal(result(r, 4), 'PASS');
    assert.equal(result(r, 5), 'SKIP');
    assert.equal(result(r, 7), 'PASS');
});

test('connect failure skips the rest', async () => {
    const {adapter, wait, now} = fakeCamera('honest');
    adapter.connect = async () => {
        throw new Error('ECONNREFUSED');
    };
    const r = await runProbe(adapter, {hostname: 'fake'}, {wait, now});
    assert.equal(result(r, 1), 'FAIL');
    assert.match(r.tests[0].summary, /ECONNREFUSED/);
    assert.ok(r.tests.slice(1).every((t) => t.result === 'SKIP'));
});

test('redactSecurity removes the WS-Security header', () => {
    const {redactSecurity} = require('../lib/probe/probe');
    const body =
        '<s:Envelope><s:Header><wsse:Security xmlns:wsse="x"><wsse:UsernameToken><wsse:Username>admin</wsse:Username>' +
        '<wsse:Password Type="#PasswordDigest">abc=</wsse:Password></wsse:UsernameToken></wsse:Security></s:Header>' +
        '<s:Body><GetStatus/></s:Body></s:Envelope>';
    const r = redactSecurity(body);
    assert.doesNotMatch(r, /admin|abc=/);
    assert.match(r, /<s:Body><GetStatus\/><\/s:Body>/);
    assert.equal(redactSecurity(null), null);
});
