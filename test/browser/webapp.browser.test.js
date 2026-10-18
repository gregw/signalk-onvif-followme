'use strict';
/*
 * Webapp in real headless Chromium (Playwright) against the plugin behind the stand-in
 * server (test/sim/dev-server.js) with a fake camera and fixture waypoints/regions.
 * Screenshots go to $SHOT_DIR when set, for eyeballing layout.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {chromium} = require('playwright');
const {startDevServer, DEFAULT_RESOURCES} = require('../sim/dev-server');

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

    // Camera, with its position taken from a waypoint. The settings start open when there is
    // no camera, and are a one line summary otherwise.
    assert.equal(await page.locator('#cameraDetails').getAttribute('open'), '');
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
    await page
        .locator('#cameraSummary', {hasText: 'Camera: Apartment  192.0.2.64:80  -27.40000, 153.19000, 30 m'})
        .waitFor();

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

    // Zone from a Freeboard region, added from the table's last row.
    await page.locator('#zoneAdd [name=region]').selectOption({label: 'Harbour'});
    await page.click('#zoneAddBtn');
    await page.locator('#zoneMsg', {hasText: 'Added Harbour'}).waitFor();
    const zrow = page.locator('#zones tbody tr', {hasText: 'Harbour'});
    assert.equal(await zrow.locator('[aria-label=mode]').inputValue(), 'followme');
    assert.equal(await zrow.locator('[aria-label=priority]').inputValue(), '1');
    // Harbour is used, so the add row no longer offers it.
    assert.equal(await page.locator('#zoneAdd [name=region] option', {hasText: 'Harbour'}).count(), 0);

    // Calibrate: go to a known PTZ, pick a waypoint, capture.
    await page.fill('#absForm [name=x]', '0.25');
    await page.fill('#absForm [name=y]', '-0.1');
    await page.fill('#absForm [name=zoom]', '0.2');
    await page.click('#absForm button[type=submit]');
    await page.locator('#status', {hasText: 'pan 0.250  tilt -0.100  zoom 0.200'}).waitFor();
    await page.locator('#calForm [name=waypoint]').selectOption({label: 'Pile 7'});
    await page.locator('#wpInfo', {hasText: 'bearing 090.0'}).waitFor();
    await page.locator('#wpInfo', {hasText: 'zones: Harbour'}).waitFor();
    assert.equal(await page.locator('#calForm select').count(), 1, 'one waypoint selector');
    // Capture and Test sit on the selector's row.
    const sb = await page.locator('#calForm [name=waypoint]').boundingBox();
    for (const b of ['#captureBtn', '#aimBtn']) {
        const bb = await page.locator(b).boundingBox();
        assert.ok(bb.x > sb.x + sb.width - 1 && bb.y < sb.y + sb.height && bb.y + bb.height > sb.y, `${b} beside`);
    }
    await page.click('#captureBtn');
    await page.locator('#calMsg', {hasText: 'Captured Pile 7: pan 0.250 tilt -0.100 zoom 0.200'}).waitFor();
    // Capturing the same waypoint again replaces the first sample.
    await page.click('#captureBtn');
    await page.locator('#calMsg', {hasText: 'replacing the previous capture'}).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#samples tbody tr').length === 1);
    const row = page.locator('#samples tbody tr', {hasText: 'Pile 7'});
    await row.waitFor();
    const cells = await row.locator('td').allTextContents();
    assert.equal(cells[1], '090.0°');
    assert.equal(cells[2], '989 m');
    assert.equal(cells[3], '0.250');
    assert.match(await row.getAttribute('title'), /zones: Harbour/);
    // Calibration sits to the right of the camera view.
    const vb = await page.locator('#viewPanel').boundingBox();
    const cb = await page.locator('#calPanel').boundingBox();
    assert.ok(cb.x > vb.x + vb.width - 1 && Math.abs(cb.y - vb.y) < 2, 'calibration right of view');
    const zb = await page.locator('#zonePanel').boundingBox();
    assert.ok(zb.x > vb.x + vb.width - 1 && zb.y > cb.y + cb.height - 1, 'zones right of view, below calibration');
    await shot(page, 'desktop');

    // Go to the sample from elsewhere; it selects the sample's waypoint again.
    await page.locator('#calForm [name=waypoint]').selectOption({label: '(choose a waypoint)'});
    await page.fill('#absForm [name=x]', '-0.5');
    await page.click('#absForm button[type=submit]');
    await page.locator('#status', {hasText: 'pan -0.500'}).waitFor();
    await row.locator('text=Go to').click();
    await page.locator('#status', {hasText: 'pan 0.250'}).waitFor();
    assert.equal(await page.locator('#calForm [name=waypoint] option:checked').textContent(), 'Pile 7');
    await page.locator('#wpInfo', {hasText: 'bearing 090.0'}).waitFor();

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
    assert.equal(await page.locator('#cameraDetails').getAttribute('open'), null, 'collapsed once configured');
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

        // A new zone needs a region.
        await page.click('#zoneAddBtn');
        await page.locator('#zoneMsg', {hasText: 'Choose a region'}).waitFor();
        // Fixed mode zone: add, jog somewhere, use current view, go back to it.
        await page.locator('#zoneAdd [name=region]').selectOption({label: 'Close in'});
        await page.locator('#zoneAdd [name=mode]').selectOption('fixed');
        await page.click('#zoneAddBtn');
        const zrow = page.locator('#zones tbody tr', {hasText: 'Close in'});
        await zrow.waitFor();
        await page.waitForFunction(() =>
            /view: not set/.test(document.querySelector('#zones tbody td.view-cell').title)
        );
        assert.equal(await zrow.locator('button[title="Go to this view"]').isDisabled(), true);
        await page.fill('#absForm [name=x]', '-0.3');
        await page.fill('#absForm [name=y]', '0.2');
        await page.fill('#absForm [name=zoom]', '0');
        await page.click('#absForm button[type=submit]');
        await page.locator('#status', {hasText: 'pan -0.300  tilt 0.200'}).waitFor();
        await page.locator('#status', {hasText: 'IDLE'}).waitFor();
        await zrow.locator('button[title="Use the current camera view"]').click();
        await page.waitForFunction(() =>
            /view: -0\.300, 0\.200, 0\.000/.test(document.querySelector('#zones tbody td.view-cell').title)
        );
        await page.fill('#absForm [name=x]', '0.4');
        await page.click('#absForm button[type=submit]');
        await page.locator('#status', {hasText: 'pan 0.400'}).waitFor();
        await zrow.locator('button[title="Go to this view"]').click();
        await page.locator('#status', {hasText: 'pan -0.300'}).waitFor();

        // Priority edits save immediately.
        await zrow.locator('[aria-label=priority]').fill('5');
        await zrow.locator('[aria-label=priority]').press('Tab');
        await page.locator('#zoneMsg', {hasText: 'Saved Close in'}).waitFor();

        assert.equal(await zrow.locator('input[type=checkbox]').count(), 0, 'no Own checkbox');

        // Hold setting.
        await page.fill('#holdS', '3');
        await page.click('#settingsBtn');
        await page.locator('#zoneMsg', {hasText: 'Hold saved'}).waitFor();
        st = await (await fetch(fresh.api + '/state')).json();
        assert.equal(st.settings.holdS, 3);
        assert.equal(st.zones[0].mode.type, 'fixed');
        assert.equal(st.zones[0].priority, 5);
        assert.deepEqual(st.zones[0].mode.ptz, {x: -0.3, y: 0.2, zoom: 0});
        if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'fixed.png'), fullPage: true});
        assert.deepEqual(errors, []);
    } finally {
        await ctx.close();
        await fresh.close();
    }
});

test('test aim at any waypoint, re-read each time it is tested; capture re-reads too', async () => {
    const resources = JSON.parse(JSON.stringify(DEFAULT_RESOURCES));
    const move = (id, lon, lat) => (resources.waypoints[id].feature.geometry.coordinates = [lon, lat]);
    const fresh = await startDevServer({resources});
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
    try {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(fresh.url);
        const cf = page.locator('#cameraForm');
        await cf.locator('[name=hostname]').fill('192.0.2.64');
        await cf.locator('[name=poseWaypoint]').selectOption({label: 'Camera'});
        await cf.locator('[name=height]').fill('30');
        await page.click('text=Save camera');
        await page.locator('#cameraMsg', {hasText: 'Saved'}).waitFor();
        await page.locator('#zoneAdd [name=region]').selectOption({label: 'Harbour'});
        await page.click('#zoneAddBtn');
        await page.locator('#zoneMsg', {hasText: 'Added Harbour'}).waitFor();

        // Two samples at different pans.
        const goto = async (x) => {
            await page.fill('#absForm [name=x]', String(x));
            await page.fill('#absForm [name=y]', '-0.2');
            await page.fill('#absForm [name=zoom]', '0.3');
            await page.click('#absForm button[type=submit]');
            await page.locator('#status', {hasText: `pan ${x.toFixed(3)}`}).waitFor();
            await page.locator('#status', {hasText: 'IDLE'}).waitFor();
        };
        await goto(0.1);
        await page.locator('#calForm [name=waypoint]').selectOption({label: 'Pile 7'});
        await page.click('#captureBtn');
        await page.locator('#calMsg', {hasText: 'Captured Pile 7'}).waitFor();
        // Moved in Freeboard after the page loaded: capture must use the new position.
        move('wp-mouth', 153.205, -27.41);
        await goto(0.4);
        await page.locator('#calForm [name=waypoint]').selectOption({label: 'Harbour mouth'});
        await page.click('#captureBtn');
        await page.locator('#calMsg', {hasText: 'Captured Harbour mouth'}).waitFor();
        const st = await (await fetch(fresh.api + '/state')).json();
        const cal = await (await fetch(`${fresh.api}/calibration/${st.cameras[0].calibrationId}`)).json();
        assert.equal(cal.samples.find((s) => s.name === 'Harbour mouth').longitude, 153.205);

        // Test aim at a waypoint that is not a calibration point, inside the zone.
        resources.waypoints['wp-test'] = {
            name: 'Test boat',
            feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [153.2, -27.405]}}
        };
        await page.click('#refreshWpBtn');
        // Test looks active for a waypoint that is not a calibration point, not for one that is.
        const aimPrimary = () => page.locator('#aimBtn').evaluate((b) => b.classList.contains('primary'));
        await page.locator('#calForm [name=waypoint]').selectOption({label: 'Pile 7'});
        assert.equal(await aimPrimary(), false, 'Test plain on a calibration waypoint');
        await page.locator('#calForm [name=waypoint]').selectOption({label: 'Test boat'});
        assert.equal(await aimPrimary(), true, 'Test active on another waypoint');
        assert.equal(
            await page.locator('#aimBtn').evaluate((b) => getComputedStyle(b).backgroundColor),
            await page.locator('#captureBtn').evaluate((b) => getComputedStyle(b).backgroundColor),
            'Test styled like Capture'
        );
        await page.click('#aimBtn');
        await page.locator('#aimMsg', {hasText: 'Test boat: zone Harbour (follow)'}).waitFor();
        const pan1 = Number(/pan (-?[\d.]+)/.exec(await page.locator('#aimMsg').textContent())[1]);
        assert.ok(pan1 > 0.1 && pan1 < 0.4, `pan between the samples: ${pan1}`);
        await page.locator('#status', {hasText: `pan ${pan1.toFixed(3)}`}).waitFor();

        // Moved outside the zone in Freeboard; Test again re-reads it.
        move('wp-test', 153.3, -27.3);
        await page.click('#aimBtn');
        await page.locator('#aimMsg', {hasText: 'Test boat: outside all zones'}).waitFor();
        // And back inside, nearer the second sample.
        move('wp-test', 153.205, -27.409);
        await page.click('#aimBtn');
        await page.locator('#aimMsg', {hasText: 'zone Harbour'}).waitFor();
        const pan2 = Number(/pan (-?[\d.]+)/.exec(await page.locator('#aimMsg').textContent())[1]);
        assert.ok(pan2 > pan1, `moved towards the 0.4 sample: ${pan1} -> ${pan2}`);
        // Region edited in Freeboard: Update is highlighted after a reload, other zone edits do
        // not touch the stored polygon, Update copies the new polygon and name.
        const zrow = page.locator('#zones tbody tr').first();
        const upd = zrow.locator('button', {hasText: 'Update'});
        assert.equal(await upd.getAttribute('class'), '');
        const rg = resources.regions['rg-harbour'];
        const oldPolygon = JSON.parse(JSON.stringify(rg.feature.geometry));
        rg.name = 'Harbour West';
        rg.feature.geometry.coordinates[0][1][0] = 153.212;
        await page.click('#refreshWpBtn');
        await page.waitForFunction(() => document.querySelector('#zones tbody tr button.stale'));
        await zrow.locator('[aria-label=priority]').fill('3');
        await zrow.locator('[aria-label=priority]').press('Tab');
        await page.locator('#zoneMsg', {hasText: 'Saved Harbour'}).waitFor();
        let zs = (await (await fetch(fresh.api + '/state')).json()).zones;
        assert.deepEqual(zs[0].geometry.polygon, oldPolygon, 'priority edit kept the stored polygon');
        assert.equal(zs[0].priority, 3);
        await zrow.locator('button', {hasText: 'Update'}).click();
        await page.locator('#zoneMsg', {hasText: 'Updated Harbour West from its region'}).waitFor();
        zs = (await (await fetch(fresh.api + '/state')).json()).zones;
        assert.equal(zs[0].geometry.refName, 'Harbour West');
        assert.equal(zs[0].geometry.polygon.coordinates[0][1][0], 153.212);
        assert.equal(zs[0].priority, 3);
        await page.locator('#zones tbody tr', {hasText: 'Harbour West'}).waitFor();
        assert.equal(await page.locator('#zones tbody tr button.stale').count(), 0);
        await page.locator('#zones tbody tr button', {hasText: 'Update'}).click();
        await page.locator('#zoneMsg', {hasText: 'already matches its region'}).waitFor();
        // Region deleted: no Update button, the zone keeps its copy.
        delete resources.regions['rg-harbour'];
        await page.click('#refreshWpBtn');
        await page.locator('#zones tbody tr', {hasText: 'Harbour West (region deleted)'}).waitFor();
        assert.equal(await page.locator('#zones tbody tr button', {hasText: 'Update'}).count(), 0);
        resources.regions['rg-harbour'] = rg;
        await page.click('#refreshWpBtn');

        // Export downloads zones and calibration; importing a file with no zones empties them
        // after confirmation; importing the export restores them.
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
        assert.match(dl.suggestedFilename(), /^onvif-followme-.*\.json$/);
        const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
        assert.equal(exported.zones.length, 1);
        assert.equal(exported.cameras.length, 1);
        assert.equal('password' in exported.cameras[0].conn, false);
        const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-'));
        const empty = path.join(dir, 'empty.json');
        fs.writeFileSync(empty, JSON.stringify({...exported, zones: [], calibrations: []}));
        let dialog = '';
        page.on('dialog', (d) => {
            dialog = d.message();
            d.accept();
        });
        await page.setInputFiles('#importFile', empty);
        await page.locator('#zoneMsg', {hasText: 'Imported 1 camera, 0 zones and 0 samples'}).waitFor();
        assert.match(
            dialog,
            /Replace 1 camera, settings, 1 zone and 2 calibration samples with 1 camera, settings, 0 zones and 0 calibration samples from empty.json \(camera passwords are kept\)/
        );
        await page.locator('#zones', {hasText: 'No zones yet'}).waitFor();
        await page.locator('#samples', {hasText: 'No samples yet'}).waitFor();
        const back = path.join(dir, 'back.json');
        fs.writeFileSync(back, JSON.stringify(exported));
        await page.setInputFiles('#importFile', back);
        await page.locator('#zoneMsg', {hasText: 'Imported 1 camera, 1 zone and 2 samples'}).waitFor();
        await page.locator('#samples tbody tr', {hasText: 'Harbour mouth'}).waitFor();
        await page.locator('#zones tbody tr', {hasText: 'Harbour West'}).waitFor();
        fs.rmSync(dir, {recursive: true, force: true});

        if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'aim.png'), fullPage: true});
        assert.deepEqual(errors, []);
    } finally {
        await ctx.close();
        await fresh.close();
    }
});

test('follow: switch on, boat enters a zone, camera aims, manual jog pauses, resume', async () => {
    const fresh = await startDevServer();
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
    try {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const post = (p, b) =>
            fetch(fresh.api + p, {
                method: p.startsWith('/settings') || p.startsWith('/cameras/') ? 'PUT' : 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(b)
            }).then((r) => r.json());
        // Camera at -27.4, 153.19, 30 m; Harbour zone east of it; fixed view zone Close in.
        await post('/cameras/cam', {
            conn: {hostname: 'h'},
            pose: {position: {latitude: -27.4, longitude: 153.19, height: 30}}
        });
        const st = await (await fetch(fresh.api + '/state')).json();
        const calId = st.cameras[0].calibrationId;
        const R = DEFAULT_RESOURCES.regions['rg-harbour'];
        await post('/zones', {
            cameraId: 'cam',
            geometry: {ref: 'rg-harbour', refName: 'Harbour', polygon: R.feature.geometry}
        });
        for (const [lat, lon, x] of [
            [-27.398, 153.2, 0.1],
            [-27.41, 153.21, 0.4]
        ]) {
            await fetch(fresh.api + '/camera/cam/move', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode: 'absolute', x, y: -0.2, zoom: 0.3})
            });
            await new Promise((r) => setTimeout(r, 600));
            await post(`/calibration/${calId}`, {latitude: lat, longitude: lon});
        }
        await post('/follow/cam/resume', {});
        await post('/settings', {holdS: 0, leadS: 0, minIntervalS: 0.5});

        await page.goto(fresh.url);
        await page.locator('#followStatus', {hasText: 'Follow: off'}).waitFor();

        // Follow live: explains why nothing happens, and starts following.
        await page.click('#liveBtn');
        await page.locator('#liveHeadline', {hasText: 'Following is off. Press Start following.'}).waitFor();
        await page.click('#liveToggle');
        await page.locator('#liveHeadline', {hasText: 'No position received'}).waitFor();
        assert.equal(await page.isChecked('#followToggle'), true);
        fresh.boat(-27.3, 153.0, (270 * Math.PI) / 180, 3);
        await page.locator('#liveHeadline', {hasText: 'outside all zones'}).waitFor();
        await page.locator('#lvCogSog', {hasText: '270.0\u00b0 / 5.8 kn'}).waitFor();
        fresh.boat(-27.404, 153.205);
        await page.locator('#liveHeadline', {hasText: 'In Harbour: following the boat'}).waitFor();
        await page.locator('#lvIn', {hasText: 'Harbour (p1)'}).waitFor();
        await page.locator('#lvZone', {hasText: 'Harbour (follow, p1)'}).waitFor();
        await page.locator('#lvLast', {hasText: 's ago'}).waitFor();
        if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'live.png')});
        await page.click('#liveClose');

        await page.locator('#followStatus', {hasText: 'following Harbour (follow)'}).waitFor();
        await page.waitForFunction(() => document.querySelector('#zones tbody tr.active'));
        const cam = () => fresh.cameras[fresh.cameras.length - 1].adapter;
        const moved = () => cam().calls.filter((c) => c[0] === 'absoluteMove').length;
        const n = moved();
        assert.ok(n >= 1);
        // Keep the fix fresh while it moves along.
        const timer = setInterval(() => fresh.boat(-27.404, 153.207), 500);
        try {
            // Manual jog pauses following; Resume ends the pause.
            await page.locator('[data-jog="1,0"]').hover();
            await page.mouse.down();
            await page.waitForTimeout(300);
            await page.mouse.up();
            await page.locator('#followStatus', {hasText: 'paused (manual control)'}).waitFor();
            const m = moved();
            await page.waitForTimeout(1200);
            assert.equal(moved(), m, 'no follow moves while paused');
            await page.click('#resumeBtn');
            await page.locator('#followStatus', {hasText: 'following Harbour'}).waitFor();
            // The follow loop ticks every 1 s: allow a couple of ticks.
            for (let i = 0; i < 30 && moved() <= m; i++) await new Promise((r) => setTimeout(r, 100));
            assert.ok(moved() > m, 'following again after resume');
        } finally {
            clearInterval(timer);
        }

        // Tuning saves.
        await page.click('#tuningDetails summary');
        await page.fill('#tuningForm [name=leadS]', '3');
        await page.fill('#tuningForm [name=speed]', '0.5');
        await page.click('#tuningForm button[type=submit]');
        await page.locator('#tuningMsg', {hasText: 'Tuning saved'}).waitFor();
        const s2 = (await (await fetch(fresh.api + '/state')).json()).settings;
        assert.equal(s2.leadS, 3);
        assert.equal(s2.speed, 0.5);
        assert.equal(s2.followEnabled, true);
        await page.fill('#tuningForm [name=speed]', '');
        await page.click('#tuningForm button[type=submit]');
        await page.locator('#tuningMsg', {hasText: 'Tuning saved'}).waitFor();
        assert.equal((await (await fetch(fresh.api + '/state')).json()).settings.speed, null);

        // Switch off.
        await page.uncheck('#followToggle');
        await page.locator('#followStatus', {hasText: 'Follow: off'}).waitFor();
        await page.waitForFunction(() => !document.querySelector('#zones tbody tr.active'));
        if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'follow.png'), fullPage: true});
        assert.deepEqual(errors, []);
    } finally {
        await ctx.close();
        await fresh.close();
    }
});
