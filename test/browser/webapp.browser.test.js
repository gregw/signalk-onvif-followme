'use strict';
/*
 * Webapp in real headless Chromium (Playwright) against the plugin behind the stand-in
 * server (test/sim/dev-server.js) with a fake camera and fixture waypoints/regions.
 * Screenshots go to $SHOT_DIR when set, for eyeballing layout.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');

const SHOT_DIR = process.env.SHOT_DIR;
let browser;
let srv;

test.before(async () => {
    browser = await chromium.launch();
    srv = await startDevServer();
});
test.after(async () => {
    await browser?.close();
    await srv?.close();
});

async function shot(page, name) {
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, name + '.png'), fullPage: true});
}

const lastCam = () => srv.cameras[srv.cameras.length - 1].adapter;

test('configure camera, live view, jog, zone, calibrate by waypoint', async () => {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.locator('#conn', {hasText: 'no camera'}).waitFor();

    // Camera, with its position taken from a waypoint.
    const cf = page.locator('#cameraForm');
    await cf.locator('[name=name]').fill('Apartment');
    await cf.locator('[name=hostname]').fill('192.0.2.64');
    await cf.locator('[name=username]').fill('admin');
    await cf.locator('[name=password]').fill('pw');
    await cf.locator('[name=poseWaypoint]').selectOption({label: 'Camera'});
    assert.equal(await cf.locator('[name=latitude]').inputValue(), '-27.4');
    await cf.locator('[name=height]').fill('30');
    await page.click('text=Save camera');
    await page.locator('#cameraMsg', {hasText: 'Saved'}).waitFor();
    assert.equal(await cf.locator('[name=password]').getAttribute('placeholder'), '(unchanged)');
    await page.click('#testBtn');
    await page.locator('#cameraMsg', {hasText: 'Connected: Fake honest'}).waitFor();

    // Live view and status.
    await page.waitForFunction(() => {
        const img = document.querySelector('#view img');
        return img && img.complete && img.naturalWidth > 0;
    });
    await page.locator('#status', {hasText: 'pan 0.'}).waitFor();
    await page.locator('#conn', {hasText: 'camera connected'}).waitFor();

    // Cross hairs centred on the image, toggled off and on.
    const imgBox = await page.locator('#view img').boundingBox();
    const dot = await page.locator('#centreDot').boundingBox();
    assert.ok(Math.abs(dot.x + dot.width / 2 - (imgBox.x + imgBox.width / 2)) <= 1, 'dot centred horizontally');
    assert.ok(Math.abs(dot.y + dot.height / 2 - (imgBox.y + imgBox.height / 2)) <= 1, 'dot centred vertically');
    assert.equal(await page.locator('#crosshair').isVisible(), true);
    await page.locator('#crosshairToggle').uncheck();
    assert.equal(await page.locator('#crosshair').isVisible(), false);
    await page.locator('#crosshairToggle').check();
    assert.equal(await page.locator('#centreDot').isVisible(), true);

    // About 4 snapshots a second, never more.
    const snaps = () => lastCam().calls.filter((c) => c[0] === 'fetchSnapshot').length;
    const n0 = snaps();
    await page.waitForTimeout(2000);
    const rate = (snaps() - n0) / 2;
    assert.ok(rate >= 3 && rate <= 4.5, `snapshot rate ${rate}/s`);

    // Hold right: continuous move with a camera-side timeout, then Stop on release.
    const right = page.locator('[data-jog="1,0"]');
    await right.hover();
    await page.mouse.down();
    await page.waitForTimeout(1300);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const calls = lastCam().calls.map((c) => c[0]);
    const cont = lastCam().calls.filter((c) => c[0] === 'continuousMove');
    assert.ok(cont.length >= 2, `jog re-sent while held (${cont.length})`);
    assert.deepEqual(cont[0][1], {x: 0.3, y: 0, zoom: 0});
    assert.equal(cont[0][2], 1500);
    assert.equal(calls[calls.length - 1] === 'stop' || calls.includes('stop'), true);

    // Zone from a Freeboard region.
    const zf = page.locator('#zoneForm');
    await zf.locator('[name=region]').selectOption({label: 'Harbour'});
    await page.click('text=Save zone');
    await page.locator('#zoneMsg', {hasText: 'Saved'}).waitFor();
    await page.locator('#zoneMsg', {hasText: 'Polygon copied from region "Harbour"'}).waitFor();
    assert.match(await page.locator('#zoneForm [name=zone] option:checked').textContent(), /^Harbour \(follow, p1\)$/);

    // Calibrate: go to a known PTZ, pick a waypoint, capture.
    await page.fill('#absForm [name=x]', '0.25');
    await page.fill('#absForm [name=y]', '-0.1');
    await page.fill('#absForm [name=zoom]', '0.2');
    await page.click('#absForm button[type=submit]');
    await page.locator('#status', {hasText: 'pan 0.250  tilt -0.100  zoom 0.200'}).waitFor();
    await page.locator('#calForm [name=waypoint]').selectOption({label: 'Pile 7'});
    await page.locator('#wpInfo', {hasText: 'bearing 090.0'}).waitFor();
    await page.locator('#wpInfo', {hasText: 'zones: Harbour'}).waitFor();
    await page.locator('#calTarget', {hasText: 'Calibrating camera "Apartment"'}).waitFor();
    await page.click('#captureBtn');
    await page.locator('#calMsg', {hasText: 'Captured Pile 7: pan 0.250 tilt -0.100 zoom 0.200'}).waitFor();
    const row = page.locator('#samples tbody tr', {hasText: 'Pile 7'});
    await row.waitFor();
    const cells = await row.locator('td').allTextContents();
    assert.equal(cells[1], '090.0°');
    assert.equal(cells[2], '989 m');
    assert.equal(cells[4], 'Harbour');
    assert.equal(cells[5], '0.250');
    await shot(page, 'desktop');

    // Go to the sample from elsewhere.
    await page.fill('#absForm [name=x]', '-0.5');
    await page.click('#absForm button[type=submit]');
    await page.locator('#status', {hasText: 'pan -0.500'}).waitFor();
    await row.locator('text=Go to').click();
    await page.locator('#status', {hasText: 'pan 0.250'}).waitFor();

    // Here then Go to, with more decimals than 0.001 steps (the camera reports e.g.
    // 0.8614444444444445): the form must accept them.
    await fetch(srv.api + '/camera/camera1/move', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mode: 'absolute', x: 0.12345, y: -0.06789, zoom: 0.1})
    });
    await page.locator('#status', {hasText: 'pan 0.123  tilt -0.068'}).waitFor();
    await page.locator('#status', {hasText: 'IDLE'}).waitFor();
    await page.click('#hereBtn');
    assert.equal(await page.inputValue('#absForm [name=x]'), '0.1235');
    await fetch(srv.api + '/camera/camera1/move', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mode: 'absolute', x: -0.4, y: 0, zoom: 0})
    });
    await page.locator('#status', {hasText: 'pan -0.400'}).waitFor();
    await page.click('#absForm button[type=submit]');
    await page.locator('#status', {hasText: 'pan 0.123  tilt -0.068'}).waitFor();
    const back = await (await fetch(srv.api + '/camera/camera1/status')).json();
    assert.equal(back.x, 0.1235);
    assert.equal(back.y, -0.0679);
    assert.equal(await page.evaluate(() => document.querySelector('#absForm').checkValidity()), true);

    // Zoom slider follows the camera, and moving it zooms without changing pan/tilt.
    await page.locator('#zoomVal', {hasText: '0.100'}).waitFor();
    assert.equal(await page.inputValue('#zoom'), '0.1');
    const before = await (await fetch(srv.api + '/camera/camera1/status')).json();
    await page.locator('#zoom').fill('0.6');
    await page.locator('#status', {hasText: 'zoom 0.600'}).waitFor();
    await page.locator('#status', {hasText: 'IDLE'}).waitFor();
    const after = await (await fetch(srv.api + '/camera/camera1/status')).json();
    assert.equal(after.zoom, 0.6);
    assert.equal(after.x, before.x);
    assert.equal(after.y, before.y);

    // Reload: state persisted in the plugin.
    await page.reload();
    await page.locator('#samples tbody tr', {hasText: 'Pile 7'}).waitFor();
    assert.equal(await cf.locator('[name=hostname]').inputValue(), '192.0.2.64');
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('phone width: no horizontal scroll', async () => {
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
    const page = await ctx.newPage();
    await page.goto(srv.url);
    await page.locator('#samples tbody tr').first().waitFor();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `page overflows by ${over}px`);
    await shot(page, 'phone');
    await ctx.close();
});

test('not logged in shows the login banner', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // The page itself loads; the plugin API refuses, as signalk-server does when not logged in.
    await page.route('**/plugins/**', (r) => r.fulfill({status: 401, body: ''}));
    await page.goto(srv.url);
    await page.locator('#login').waitFor({state: 'visible'});
    await page.locator('#conn', {hasText: 'not authorised'}).waitFor();
    await ctx.close();
});

test('capture without any zone goes to the camera set; fixed zone view; override; settings', async () => {
    const fresh = await startDevServer();
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
    try {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(fresh.url);
        await page.locator('#conn', {hasText: 'no camera'}).waitFor();
        assert.equal(await page.locator('#captureBtn').isDisabled(), true);
        const cf = page.locator('#cameraForm');
        await cf.locator('[name=hostname]').fill('192.0.2.64');
        await cf.locator('[name=poseWaypoint]').selectOption({label: 'Camera'});
        await page.click('text=Save camera');
        await page.locator('#cameraMsg', {hasText: 'Saved'}).waitFor();
        assert.equal(await page.locator('#captureBtn').isDisabled(), false);

        await page.locator('#calForm [name=waypoint]').selectOption({label: 'Pile 7'});
        await page.locator('#wpInfo', {hasText: 'zones: none'}).waitFor();
        await page.click('#captureBtn');
        await page.locator('#calMsg', {hasText: 'Captured Pile 7'}).waitFor();
        await page.locator('#samples tbody tr', {hasText: 'Pile 7'}).waitFor();
        let st = await (await fetch(fresh.api + '/state')).json();
        assert.equal(st.zones.length, 0, 'no zone created');

        // Fixed mode zone: save, jog somewhere, use current view, go back to it.
        const zf = page.locator('#zoneForm');
        await zf.locator('[name=mode]').selectOption('fixed');
        // A new zone needs a region; it is named after it.
        await page.click('text=Save zone');
        await page.locator('#zoneMsg', {hasText: 'Choose a region'}).waitFor();
        await zf.locator('[name=region]').selectOption({label: 'Close in'});
        assert.equal(await page.locator('#fixedView').isVisible(), true);
        assert.equal(await page.locator('#viewSetBtn').isDisabled(), true);
        await page.click('text=Save zone');
        await page.locator('#zoneMsg', {hasText: 'Saved'}).waitFor();
        await page.fill('#absForm [name=x]', '-0.3');
        await page.fill('#absForm [name=y]', '0.2');
        await page.fill('#absForm [name=zoom]', '0');
        await page.click('#absForm button[type=submit]');
        await page.locator('#status', {hasText: 'pan -0.300  tilt 0.200'}).waitFor();
        await page.locator('#status', {hasText: 'IDLE'}).waitFor();
        await page.click('#viewSetBtn');
        await page.locator('#viewInfo', {hasText: 'pan -0.300 tilt 0.200 zoom 0.000'}).waitFor();
        await page.fill('#absForm [name=x]', '0.4');
        await page.click('#absForm button[type=submit]');
        await page.locator('#status', {hasText: 'pan 0.400'}).waitFor();
        await page.click('#viewGotoBtn');
        await page.locator('#status', {hasText: 'pan -0.300'}).waitFor();

        // Override: the calibration panel switches to the zone's own (empty) set.
        await zf.locator('[name=override]').check();
        await page.click('text=Save zone');
        await page.locator('#calTarget', {hasText: 'zone "Close in" (override)'}).waitFor();
        await page.locator('#samples', {hasText: 'No samples yet'}).waitFor();
        await zf.locator('[name=override]').uncheck();
        await page.click('text=Save zone');
        await page.locator('#samples tbody tr', {hasText: 'Pile 7'}).waitFor();

        // Switching settings.
        await zf.locator('[name=holdS]').fill('3');
        await page.click('#settingsBtn');
        await page.locator('#zoneMsg', {hasText: 'switching settings saved'}).waitFor();
        st = await (await fetch(fresh.api + '/state')).json();
        assert.deepEqual(st.settings, {holdS: 3});
        assert.equal(st.zones[0].mode.type, 'fixed');
        assert.deepEqual(st.zones[0].mode.ptz, {x: -0.3, y: 0.2, zoom: 0});
        if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'fixed.png'), fullPage: true});
        assert.deepEqual(errors, []);
    } finally {
        await ctx.close();
        await fresh.close();
    }
});
