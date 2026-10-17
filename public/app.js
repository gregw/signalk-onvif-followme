'use strict';
/*
 * ONVIF Follow Me configuration webapp. Plain JS, no framework.
 *
 * Talks to:
 *  - the plugin REST API at /plugins/signalk-onvif-followme (lib/plugin/routes.js)
 *  - the Signal K resources API at /signalk/v2/api/resources/{waypoints,regions}, read
 *    directly so we do not reimplement resource listing (brief: "Endpoints").
 *
 * Wire units are SI (radians, metres); degrees appear only here, at the display edge.
 * The live view is a component with start/stop/setCamera, so a stream view can replace
 * the 4 fps snapshot view without touching capture logic (brief: deferred decision 1).
 */

(function () {
    const API = '/plugins/signalk-onvif-followme';
    const RES = '/signalk/v2/api/resources';
    const $ = (sel) => document.querySelector(sel);
    const deg = (r) => (r * 180) / Math.PI;
    const fmtBearing = (r) => (r === null || r === undefined ? '-' : deg(r).toFixed(1).padStart(5, '0') + '°');
    const fmtRange = (m) =>
        m === null || m === undefined ? '-' : m < 10000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
    const fmtDeg = (r) => (r === null || r === undefined ? '-' : deg(r).toFixed(2) + '°');
    const fmtN = (v, d = 3) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));

    const state = {
        cameras: [],
        zones: [],
        settings: {holdS: 5},
        waypoints: {},
        regions: {},
        cameraId: null,
        calId: null
    };

    // ---- HTTP

    class ApiError extends Error {
        constructor(status, message) {
            super(message);
            this.status = status;
        }
    }

    async function api(method, path, body) {
        const r = await fetch(path.startsWith(RES) ? path : API + path, {
            method,
            credentials: 'same-origin',
            headers: body ? {'Content-Type': 'application/json'} : {},
            body: body ? JSON.stringify(body) : undefined
        });
        if (r.status === 401 || r.status === 403) {
            $('#login').hidden = false;
            setConn('not authorised', 'bad');
            throw new ApiError(r.status, 'not authorised');
        }
        const ct = r.headers.get('content-type') || '';
        const data = ct.includes('json') ? await r.json() : null;
        if (!r.ok) throw new ApiError(r.status, (data && (data.error || data.message)) || `HTTP ${r.status}`);
        return data;
    }

    function setConn(text, cls) {
        const c = $('#conn');
        c.textContent = text;
        c.className = 'pill ' + (cls || '');
    }

    function showError(err) {
        const e = $('#error');
        if (!err) {
            e.hidden = true;
            return;
        }
        e.textContent = err.message || String(err);
        e.hidden = false;
    }

    function msg(sel, text, cls) {
        const m = $(sel);
        m.textContent = text || '';
        m.className = 'msg ' + (cls || '');
    }

    // Resources come back as an object keyed by id from signalk-server 2.33.0 providers.
    // TODO(verify): confirm against a live listResources response; arrays are tolerated too.
    function keyed(data) {
        if (Array.isArray(data)) return Object.fromEntries(data.map((r, i) => [r.id || String(i), r]));
        return data && typeof data === 'object' ? data : {};
    }

    async function loadResources() {
        const [w, r] = await Promise.all([
            api('GET', RES + '/waypoints').catch(() => ({})),
            api('GET', RES + '/regions').catch(() => ({}))
        ]);
        state.waypoints = keyed(w);
        state.regions = keyed(r);
    }

    const wpPos = (w) => {
        const c = w && w.feature && w.feature.geometry && w.feature.geometry.coordinates;
        return Array.isArray(c) ? {latitude: c[1], longitude: c[0]} : null;
    };
    /**
     * Re-read one waypoint from Signal K: it may have been moved in Freeboard since the list
     * was loaded. Updates the cached copy; falls back to it if the read fails.
     */
    async function freshWaypoint(id) {
        try {
            const w = await api('GET', `${RES}/waypoints/${encodeURIComponent(id)}`);
            if (w && w.feature) state.waypoints[id] = {...state.waypoints[id], ...w};
        } catch (err) {
            if (err.status === 401) throw err;
        }
        return state.waypoints[id];
    }

    const byName = (coll) => Object.entries(coll).sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));

    function fillSelect(sel, entries, {blank, selected} = {}) {
        const s = typeof sel === 'string' ? $(sel) : sel;
        s.innerHTML = '';
        if (blank !== undefined) s.append(new Option(blank, ''));
        for (const [value, label] of entries) s.append(new Option(label, value));
        if (selected !== undefined && selected !== null) s.value = selected;
    }

    // ---- Live view (swappable)

    /**
     * 4 fps snapshot view: polls the plugin's snapshot proxy, one request at a time.
     * The period runs from the start of each request, so a slow camera lowers the rate
     * rather than stacking requests. 1 frame per 5 s while the tab is hidden.
     */
    function snapshotView(container, {periodMs = 250} = {}) {
        const img = new Image();
        img.alt = 'camera view';
        let cameraId = null;
        let running = false;
        let timer = null;
        let startedAt = 0;
        const next = () => {
            clearTimeout(timer);
            if (!running || !cameraId) return;
            const wait = document.hidden ? 5000 : Math.max(0, periodMs - (Date.now() - startedAt));
            timer = setTimeout(load, wait);
        };
        function load() {
            if (!running || !cameraId) return;
            startedAt = Date.now();
            img.src = `${API}/camera/${encodeURIComponent(cameraId)}/snapshot?t=${startedAt}`;
        }
        img.onload = () => {
            container.classList.remove('stale');
            next();
        };
        img.onerror = () => {
            container.classList.add('stale');
            next();
        };
        return {
            setCamera(id) {
                cameraId = id;
                container.innerHTML = '';
                if (id) container.append(img);
                else container.innerHTML = '<div class="placeholder">No camera configured</div>';
                if (running) load();
            },
            start() {
                running = true;
                load();
            },
            stop() {
                running = false;
                clearTimeout(timer);
            }
        };
    }

    const view = snapshotView($('#view'));

    // Cross hairs over the view, for centring a waypoint before capture. The choice is a
    // per-browser convenience, so localStorage (which may be unavailable) is fine.
    (function crosshair() {
        const box = $('#crosshairToggle');
        try {
            box.checked = localStorage.getItem('onvif-followme.crosshair') !== 'off';
        } catch {
            // keep the default
        }
        const apply = () => $('.viewwrap').classList.toggle('no-crosshair', !box.checked);
        box.addEventListener('change', () => {
            apply();
            try {
                localStorage.setItem('onvif-followme.crosshair', box.checked ? 'on' : 'off');
            } catch {
                // not persisted; fine
            }
        });
        apply();
    })();

    // ---- Status poll

    let lastStatus = null;
    let statusTimer = null;
    async function pollStatus() {
        clearTimeout(statusTimer);
        if (state.cameraId) {
            try {
                lastStatus = await api('GET', `/camera/${encodeURIComponent(state.cameraId)}/status`);
                $('#status').textContent =
                    `pan ${fmtN(lastStatus.x)}  tilt ${fmtN(lastStatus.y)}  zoom ${fmtN(lastStatus.zoom)}  ` +
                    (lastStatus.moveStatus || '');
                syncZoomSlider();
                setConn('camera connected', 'ok');
            } catch (err) {
                if (err.status !== 401) {
                    $('#status').textContent = `status: ${err.message}`;
                    setConn('camera error', 'bad');
                }
            }
        }
        statusTimer = setTimeout(pollStatus, document.hidden ? 5000 : 1000);
    }

    // ---- Jog: hold to move. Re-sent every second with a 1.5 s camera-side timeout, so a lost
    // release (closed tab, dropped network) stops the camera by itself.

    let jogTimer = null;
    let jogVec = null;
    const speed = () => Number($('#speed').value);

    function sendJog() {
        if (!jogVec || !state.cameraId) return;
        api('POST', `/camera/${encodeURIComponent(state.cameraId)}/move`, {
            mode: 'continuous',
            ...jogVec,
            timeoutMs: 1500
        }).catch(showError);
    }
    function startJog(v) {
        if (!state.cameraId) return;
        jogVec = v;
        sendJog();
        clearInterval(jogTimer);
        jogTimer = setInterval(sendJog, 1000);
    }
    function endJog() {
        if (!jogVec) return;
        jogVec = null;
        clearInterval(jogTimer);
        stopCamera();
    }
    function stopCamera() {
        if (state.cameraId) api('POST', `/camera/${encodeURIComponent(state.cameraId)}/stop`).catch(showError);
    }

    function bindHold(btn, vecFn) {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.setPointerCapture(e.pointerId);
            startJog(vecFn());
        });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, endJog);
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    document.querySelectorAll('[data-jog]').forEach((b) => {
        const [x, y] = b.dataset.jog.split(',').map(Number);
        bindHold(b, () => ({x: x * speed(), y: y * speed(), zoom: 0}));
    });

    // Zoom slider: absolute zoom in the camera's [0, 1] space, keeping the current pan/tilt.
    // While dragging, sends at most every 300 ms plus once on release (moves are serialised
    // per camera in the plugin, so this cannot flood it). It follows the camera's reported
    // zoom, except for 3 s after the user touches it, so it does not jump back mid-zoom.
    const zoomSlider = $('#zoom');
    let zoomUserUntil = 0;
    let zoomSentAt = 0;
    let zoomTimer = null;
    function sendZoom() {
        clearTimeout(zoomTimer);
        if (!state.cameraId || !lastStatus || lastStatus.x === null || lastStatus.y === null) return;
        zoomSentAt = Date.now();
        const body = {mode: 'absolute', x: lastStatus.x, y: lastStatus.y, zoom: Number(zoomSlider.value)};
        api('POST', `/camera/${encodeURIComponent(state.cameraId)}/move`, body).catch(showError);
    }
    zoomSlider.addEventListener('input', () => {
        zoomUserUntil = Date.now() + 3000;
        $('#zoomVal').textContent = Number(zoomSlider.value).toFixed(3);
        const wait = 300 - (Date.now() - zoomSentAt);
        clearTimeout(zoomTimer);
        if (wait <= 0) sendZoom();
        else zoomTimer = setTimeout(sendZoom, wait);
    });
    zoomSlider.addEventListener('change', () => {
        zoomUserUntil = Date.now() + 3000;
        sendZoom();
    });
    function syncZoomSlider() {
        const z = lastStatus && lastStatus.zoom;
        zoomSlider.disabled = z === null || z === undefined;
        if (zoomSlider.disabled || Date.now() < zoomUserUntil) return;
        zoomSlider.value = z;
        $('#zoomVal').textContent = Number(z).toFixed(3);
    }
    $('#stopBtn').addEventListener('click', () => {
        endJog();
        stopCamera();
    });
    $('#speed').addEventListener('input', () => ($('#speedVal').textContent = speed().toFixed(2)));
    window.addEventListener('blur', endJog);

    $('#absForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!state.cameraId) return;
        const f = e.target;
        const body = {mode: 'absolute', x: Number(f.x.value), y: Number(f.y.value), zoom: Number(f.zoom.value)};
        api('POST', `/camera/${encodeURIComponent(state.cameraId)}/move`, body).then(() => showError(null), showError);
    });
    $('#hereBtn').addEventListener('click', () => {
        if (!lastStatus) return;
        const f = $('#absForm');
        f.x.value = lastStatus.x;
        f.y.value = lastStatus.y;
        f.zoom.value = lastStatus.zoom;
    });

    // ---- Camera (collapsed to a one line summary once configured)

    function camera() {
        return state.cameras.find((c) => c.id === state.cameraId) || null;
    }

    function renderCamera() {
        const f = $('#cameraForm');
        const c = camera();
        fillSelect(
            f.poseWaypoint,
            byName(state.waypoints).map(([id, w]) => [id, w.name || id]),
            {blank: '(type below)', selected: c && c.pose.waypointId}
        );
        renderCameraSummary();
        if (!c) {
            $('#cameraDetails').open = true;
            f.password.placeholder = '';
            return;
        }
        f.id.value = c.id;
        f.id.readOnly = true;
        f.name.value = c.name || '';
        f.hostname.value = c.conn.hostname;
        f.port.value = c.conn.port;
        f.username.value = c.conn.username || '';
        f.password.value = '';
        f.password.placeholder = c.conn.passwordSet ? '(unchanged)' : '';
        const p = c.pose.position;
        f.latitude.value = p ? p.latitude : '';
        f.longitude.value = p ? p.longitude : '';
        f.height.value = p ? p.height : 0;
    }

    function renderCameraSummary(status) {
        const c = camera();
        if (!c) return ($('#cameraSummary').textContent = 'Camera: not configured');
        const p = c.pose.position;
        const where = p ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}, ${p.height} m` : 'position not set';
        $('#cameraSummary').textContent =
            `Camera: ${c.name || c.id}  ${c.conn.hostname}:${c.conn.port}  ${where}` + (status ? `  ${status}` : '');
    }

    $('#cameraForm').poseWaypoint.addEventListener('change', (e) => {
        const p = wpPos(state.waypoints[e.target.value]);
        if (!p) return;
        const f = $('#cameraForm');
        f.latitude.value = p.latitude;
        f.longitude.value = p.longitude;
    });

    function cameraBody(f) {
        const num = (v) => (v === '' ? null : Number(v));
        const lat = num(f.latitude.value);
        const lon = num(f.longitude.value);
        return {
            name: f.name.value,
            conn: {
                hostname: f.hostname.value.trim(),
                port: Number(f.port.value || 80),
                username: f.username.value,
                password: f.password.value
            },
            pose: {
                type: 'fixed',
                waypointId: f.poseWaypoint.value || undefined,
                position:
                    lat === null || lon === null
                        ? null
                        : {latitude: lat, longitude: lon, height: num(f.height.value) || 0}
            }
        };
    }

    async function saveCamera() {
        const f = $('#cameraForm');
        const id = f.id.value.trim();
        const saved = await api('PUT', `/cameras/${encodeURIComponent(id)}`, cameraBody(f));
        const i = state.cameras.findIndex((c) => c.id === id);
        if (i >= 0) state.cameras[i] = saved;
        else state.cameras.push(saved);
        const first = !state.cameraId;
        state.cameraId = id;
        renderCamera();
        if (first) view.setCamera(id);
        return saved;
    }

    $('#cameraForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await saveCamera();
            msg('#cameraMsg', 'Saved.', 'ok');
            renderZones();
            renderCalibration();
        } catch (err) {
            msg('#cameraMsg', err.message, 'bad');
        }
    });

    $('#testBtn').addEventListener('click', async () => {
        msg('#cameraMsg', 'Connecting...');
        try {
            if (!state.cameraId) await saveCamera();
            const t = await api('POST', `/cameras/${encodeURIComponent(state.cameraId)}/test`);
            const d = t.device;
            msg(
                '#cameraMsg',
                `Connected: ${d.manufacturer} ${d.model}, firmware ${d.firmwareVersion}, profile ${t.profileToken}`,
                'ok'
            );
        } catch (err) {
            msg('#cameraMsg', err.message, 'bad');
        }
    });

    // ---- Zones (a table; edits save immediately)

    /** A zone is named by its region (name snapshotted when the region was assigned). */
    const zoneName = (z) => (z && z.geometry && z.geometry.refName) || '(no region)';
    const fmtPtz = (v) => (v ? `${fmtN(v.x)}, ${fmtN(v.y)}, ${fmtN(v.zoom)}` : 'not set');
    const cameraZones = () =>
        state.zones.filter((z) => z.cameraId === state.cameraId).sort((a, b) => a.priority - b.priority);

    /** Create an element: `dataset` and hyphenated keys (aria-*) become attributes, the rest properties. */
    function el(tag, props = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === 'dataset') Object.assign(e.dataset, v);
            else if (k.includes('-')) e.setAttribute(k, v);
            else e[k] = v;
        }
        e.append(...kids);
        return e;
    }

    function storeZone(z) {
        const i = state.zones.findIndex((x) => x.id === z.id);
        if (i >= 0) state.zones[i] = z;
        else state.zones.push(z);
        renderZones();
        renderCalibration();
    }

    /**
     * Save one zone's settings. The stored polygon is left as it is (geometry omitted); only
     * the Update button re-copies it from the region.
     */
    async function saveZone(z, changes, done = `Saved ${zoneName(z)}.`) {
        const body = {
            cameraId: z.cameraId,
            priority: z.priority,
            mode: {type: z.mode.type},
            calibrationOverride: !!z.calibrationId,
            ...changes
        };
        try {
            storeZone(await api('PUT', `/zones/${z.id}`, body));
            msg('#zoneMsg', done, 'ok');
        } catch (err) {
            msg('#zoneMsg', err.message, 'bad');
            renderZones();
        }
    }

    const regionGeometry = (id, r) => ({
        frame: 'absolute',
        ref: id,
        refName: r.name || id,
        polygon: r.feature.geometry
    });

    function renderZones() {
        const tbody = $('#zones tbody');
        tbody.innerHTML = '';
        const zones = cameraZones();
        if (!state.cameraId)
            tbody.append(el('tr', {}, el('td', {colSpan: 6, className: 'hint', textContent: 'Save a camera first.'})));
        else if (!zones.length)
            tbody.append(el('tr', {}, el('td', {colSpan: 6, className: 'hint', textContent: 'No zones yet.'})));
        for (const z of zones) {
            const gone = !state.regions[z.geometry.ref];
            const name = el('td', {textContent: zoneName(z) + (gone ? ' (region deleted)' : '')});

            const mode = el('select', {'aria-label': 'mode'});
            mode.append(new Option('Follow', 'followme'), new Option('Fixed', 'fixed'));
            mode.value = z.mode.type;
            mode.onchange = () => saveZone(z, {mode: {type: mode.value}});

            const prio = el('input', {
                type: 'number',
                step: 1,
                value: z.priority,
                className: 'narrow',
                'aria-label': 'priority'
            });
            prio.onchange = () => saveZone(z, {priority: Number(prio.value)});

            const own = el('input', {type: 'checkbox', checked: !!z.calibrationId, 'aria-label': 'own calibration'});
            own.onchange = () => {
                if (!own.checked && !confirm(`Discard ${zoneName(z)}'s own calibration samples?`)) {
                    own.checked = true;
                    return;
                }
                saveZone(z, {calibrationOverride: own.checked});
            };

            const view = el('td', {className: 'view-cell'});
            if (z.mode.type === 'fixed') {
                const set = el('button', {type: 'button', textContent: 'Set', title: 'Use the current camera view'});
                set.onclick = async () => {
                    try {
                        storeZone(await api('POST', `/zones/${z.id}/view`));
                        msg('#zoneMsg', `View set for ${zoneName(z)}.`, 'ok');
                    } catch (err) {
                        msg('#zoneMsg', err.message, 'bad');
                    }
                };
                const go = el('button', {
                    type: 'button',
                    textContent: 'Go',
                    title: 'Go to this view',
                    disabled: !z.mode.ptz
                });
                go.onclick = () =>
                    api('POST', `/zones/${z.id}/view/goto`).catch((err) => msg('#zoneMsg', err.message, 'bad'));
                view.title = `view: ${fmtPtz(z.mode.ptz)}`;
                view.append(set, go);
            } else {
                view.textContent = '-';
            }

            // Update: re-read the region from Signal K and copy its polygon and name in.
            // Highlighted when the cached region differs from the zone's copy.
            const actions = el('td', {className: 'actions'});
            if (!gone) {
                const r = state.regions[z.geometry.ref];
                const stale =
                    (r.name || z.geometry.ref) !== z.geometry.refName ||
                    JSON.stringify(r.feature.geometry) !== JSON.stringify(z.geometry.polygon);
                const upd = el('button', {
                    type: 'button',
                    textContent: 'Update',
                    className: stale ? 'stale' : '',
                    title: stale
                        ? 'The region has been edited since this zone copied it: copy it again'
                        : 'Copy the region polygon and name again from Signal K'
                });
                upd.onclick = () => updateZoneFromRegion(z);
                actions.append(upd);
            }

            const del = el('button', {type: 'button', textContent: '\u2715', title: 'Delete zone', className: 'del'});
            del.onclick = async () => {
                const extra = z.calibrationId ? ' and its own calibration samples' : '';
                if (!confirm(`Delete zone "${zoneName(z)}"${extra}?`)) return;
                try {
                    await api('DELETE', `/zones/${z.id}`);
                    state.zones = state.zones.filter((x) => x.id !== z.id);
                    renderZones();
                    renderCalibration();
                } catch (err) {
                    msg('#zoneMsg', err.message, 'bad');
                }
            };

            actions.append(del);
            tbody.append(
                el(
                    'tr',
                    {dataset: {zone: z.id}},
                    name,
                    el('td', {}, mode),
                    el('td', {}, prio),
                    el('td', {}, own),
                    view,
                    actions
                )
            );
        }

        // Add row: only regions this camera has no zone for.
        const used = new Set(zones.map((z) => z.geometry.ref));
        const free = byName(state.regions).filter(([id]) => !used.has(id));
        fillSelect(
            $('#zoneAdd [name=region]'),
            free.map(([id, r]) => [id, r.name || id]),
            {blank: free.length ? '(choose a region)' : '(all regions used)'}
        );
        $('#zoneAddBtn').disabled = !state.cameraId || !free.length;
        $('#holdS').value = state.settings.holdS;
    }

    async function updateZoneFromRegion(z) {
        let r;
        try {
            r = await api('GET', `${RES}/regions/${encodeURIComponent(z.geometry.ref)}`);
        } catch (err) {
            if (err.status === 404) {
                delete state.regions[z.geometry.ref];
                renderZones();
                return msg('#zoneMsg', `Region ${zoneName(z)} no longer exists; the zone keeps its copy.`, 'bad');
            }
            return msg('#zoneMsg', err.message, 'bad');
        }
        state.regions[z.geometry.ref] = r;
        const g = regionGeometry(z.geometry.ref, r);
        const changed =
            g.refName !== z.geometry.refName || JSON.stringify(g.polygon) !== JSON.stringify(z.geometry.polygon);
        await saveZone(
            z,
            {geometry: g},
            changed ? `Updated ${g.refName} from its region.` : `${g.refName} already matches its region.`
        );
    }

    $('#zoneAddBtn').addEventListener('click', async () => {
        const id = $('#zoneAdd [name=region]').value;
        const region = state.regions[id];
        if (!region) return msg('#zoneMsg', 'Choose a region for the zone.', 'bad');
        try {
            const z = await api('POST', '/zones', {
                cameraId: state.cameraId,
                mode: {type: $('#zoneAdd [name=mode]').value},
                geometry: regionGeometry(id, region)
            });
            storeZone(z);
            msg('#zoneMsg', `Added ${zoneName(z)}.`, 'ok');
        } catch (err) {
            msg('#zoneMsg', err.message, 'bad');
        }
    });

    $('#settingsBtn').addEventListener('click', async () => {
        try {
            state.settings = await api('PUT', '/settings', {holdS: Number($('#holdS').value)});
            msg('#zoneMsg', 'Hold saved.', 'ok');
        } catch (err) {
            msg('#zoneMsg', err.message, 'bad');
        }
    });

    // ---- Follow: switch, live status, tuning

    let followState = null;
    const TUNING = ['leadS', 'minIntervalS', 'panDeadband', 'tiltDeadband', 'zoomDeadband', 'speed', 'staleS'];

    function renderFollow() {
        $('#followToggle').checked = !!state.settings.followEnabled;
        const f = $('#tuningForm');
        for (const k of TUNING) f[k].value = state.settings[k] === null ? '' : state.settings[k];
        f.waitIdle.checked = !!state.settings.waitIdle;
    }

    async function putSettings(body, sel) {
        try {
            state.settings = await api('PUT', '/settings', body);
            renderFollow();
            return true;
        } catch (err) {
            msg(sel, err.message, 'bad');
            renderFollow();
            return false;
        }
    }

    $('#followToggle').addEventListener('change', async (e) => {
        await putSettings({followEnabled: e.target.checked}, '#tuningMsg');
        pollFollow();
    });

    $('#tuningForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = {waitIdle: f.waitIdle.checked};
        for (const k of TUNING) body[k] = f[k].value === '' ? null : Number(f[k].value);
        if (await putSettings(body, '#tuningMsg')) msg('#tuningMsg', 'Tuning saved.', 'ok');
    });

    $('#resumeBtn').addEventListener('click', async () => {
        if (!state.cameraId) return;
        await api('POST', `/follow/${encodeURIComponent(state.cameraId)}/resume`).catch(showError);
        pollFollow();
    });

    let followTimer = null;
    async function pollFollow() {
        clearTimeout(followTimer);
        try {
            followState = await api('GET', '/follow');
            const c = state.cameraId && followState.cameras[state.cameraId];
            let text = 'off';
            if (followState.enabled && c) {
                if (c.zone) {
                    const lastMove = c.last ? `, last ${c.last.ageS.toFixed(1)} s ago` : '';
                    text = `following ${c.zone.name} (${c.zone.mode === 'fixed' ? 'fixed' : 'follow'}): ${c.reason}, ${c.sent} moves${lastMove}`;
                } else text = c.reason;
                if (c.pausedS > 0) text = `paused (manual control) ${Math.ceil(c.pausedS)} s`;
                if (c.pending) text += `; changing to ${c.pending.to ? c.pending.to.name : 'none'}`;
            }
            $('#followStatus').textContent = `Follow: ${text}`;
            $('#resumeBtn').hidden = !(c && c.pausedS > 0);
            const active = c && c.zone ? c.zone.id : null;
            document.querySelectorAll('#zones tbody tr[data-zone]').forEach((tr) => {
                tr.classList.toggle('active', tr.dataset.zone === active);
            });
        } catch (err) {
            if (err.status !== 401) $('#followStatus').textContent = `Follow: ${err.message}`;
        }
        followTimer = setTimeout(pollFollow, document.hidden ? 5000 : 1000);
    }

    // ---- Follow live pop-up: the loop's view of the boat, zone and camera, twice a second

    const knots = (ms) => ms * 1.943844;
    let liveTimer = null;

    /** Plain words for what the loop is doing (or why not). */
    function explain(f, c) {
        if (!f.enabled) return ['bad', 'Following is off. Press Start following.'];
        if (!c) return ['bad', 'No camera configured.'];
        if (c.pausedS > 0) return ['bad', `Paused by manual control for ${Math.ceil(c.pausedS)} s more.`];
        const r = c.reason;
        if (r === 'no position yet') return ['bad', 'No position received for this vessel (navigation.position).'];
        if (r === 'position stale') return ['bad', `Position is stale: nothing for over ${f.staleS} s.`];
        if (r === 'outside (hold)') {
            const to = c.pending && c.pending.to ? c.pending.to.name : 'a zone';
            return ['', `Entering ${to}: waiting out the ${f.holdS} s hold.`];
        }
        if (r === 'outside all zones') return ['', 'Boat is outside all zones: camera released to its own scan.'];
        if (r.startsWith('cannot aim')) return ['bad', r.replace('cannot aim: ', 'Cannot aim: ') + '.'];
        if (r.startsWith('error')) return ['bad', `Camera ${r}.`];
        if (c.zone) {
            const what = c.zone.mode === 'fixed' ? 'holding the fixed view' : 'following the boat';
            const why =
                {
                    move: 'moving',
                    deadband: 'within deadband',
                    interval: 'waiting min interval',
                    moving: 'waiting for idle',
                    first: 'first move',
                    keepalive: 'refreshing the view'
                }[r] || r;
            return ['ok', `In ${c.zone.name}: ${what} (${why}).`];
        }
        return ['', r];
    }

    function renderLive(f) {
        const c = state.cameraId ? f.cameras[state.cameraId] : null;
        const [cls, text] = explain(f, c);
        const h = $('#liveHeadline');
        h.textContent = text;
        h.className = 'headline ' + cls;
        $('#liveToggle').textContent = f.enabled ? 'Stop following' : 'Start following';
        $('#liveToggle').className = f.enabled ? '' : 'primary';
        $('#liveResume').hidden = !(c && c.pausedS > 0);
        const fix = f.fix;
        $('#lvPos').textContent = fix ? `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}` : 'none';
        $('#lvAge').textContent = fix ? `${fix.ageS.toFixed(1)} s` : '-';
        $('#lvCogSog').textContent =
            (f.cog ? `${fmtBearing(f.cog.value)}` : '-') +
            ' / ' +
            (f.sog ? `${knots(f.sog.value).toFixed(1)} kn` : '-') +
            (f.leadS ? `  (aiming ${f.leadS} s ahead)` : '');
        $('#lvBrg').textContent =
            c && c.range !== null ? `bearing ${fmtBearing(c.bearing)}  range ${fmtRange(c.range)}` : '-';
        $('#lvIn').textContent =
            c && c.inZones.length ? c.inZones.map((z) => `${z.name} (p${z.priority})`).join(', ') : 'none';
        $('#lvZone').textContent =
            c && c.zone
                ? `${c.zone.name} (${c.zone.mode === 'fixed' ? 'fixed' : 'follow'}, p${c.zone.priority})`
                : 'none';
        $('#lvPending').textContent =
            c && c.pending
                ? `to ${c.pending.to ? c.pending.to.name : 'none (release)'} in ${c.pending.remainingS.toFixed(1)} s`
                : 'no';
        $('#lvReason').textContent = c ? `${c.reason}, ${c.sent} moves sent` : '-';
        const ptz = (v) => (v ? `pan ${fmtN(v.x)}  tilt ${fmtN(v.y)}  zoom ${fmtN(v.zoom)}` : '-');
        $('#lvWant').textContent = c ? ptz(c.want) : '-';
        $('#lvLast').textContent = c && c.last ? `${ptz(c.last)}  ${c.last.ageS.toFixed(1)} s ago` : '-';
        $('#lvCam').textContent = lastStatus ? `${ptz(lastStatus)}  ${lastStatus.moveStatus || ''}` : '-';
    }

    async function pollLive() {
        clearTimeout(liveTimer);
        if (!$('#liveDlg').open) return;
        try {
            renderLive(await api('GET', '/follow'));
        } catch (err) {
            $('#liveHeadline').textContent = err.message;
        }
        liveTimer = setTimeout(pollLive, 500);
    }

    $('#liveBtn').addEventListener('click', () => {
        $('#liveDlg').showModal();
        pollLive();
    });
    $('#liveClose').addEventListener('click', () => $('#liveDlg').close());
    $('#liveDlg').addEventListener('close', () => clearTimeout(liveTimer));
    $('#liveToggle').addEventListener('click', async () => {
        await putSettings({followEnabled: !state.settings.followEnabled}, '#tuningMsg');
        pollLive();
        pollFollow();
    });
    $('#liveResume').addEventListener('click', async () => {
        if (state.cameraId) await api('POST', `/follow/${encodeURIComponent(state.cameraId)}/resume`).catch(showError);
        pollLive();
    });

    // ---- Export / import of zones and calibration (import replaces)

    $('#exportBtn').href = `${API}/export`;

    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch {
            return msg('#zoneMsg', `${file.name} is not JSON.`, 'bad');
        }
        const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
        const count = (d) =>
            (d.version === 1 ? '' : `${plural((d.cameras || []).length, 'camera')}, settings, `) +
            `${plural((d.zones || []).length, 'zone')} and ` +
            plural(
                (d.calibrations || []).reduce((n, c) => n + ((c && c.samples) || []).length, 0),
                'calibration sample'
            );
        let now = {cameras: state.cameras, zones: state.zones, calibrations: []};
        try {
            now = await api('GET', '/export');
        } catch {
            // counts only; carry on
        }
        if (data.version === 1) now = {...now, version: 1};
        const what = data.version === 1 ? '' : ' (camera passwords are kept)';
        if (!confirm(`Replace ${count(now)} with ${count(data)} from ${file.name}${what}?`)) return;
        try {
            const r = await api('POST', '/import', data);
            await reloadState();
            const cams = r.cameras !== undefined ? `${plural(r.cameras, 'camera')}, ` : '';
            const pw = r.needPassword && r.needPassword.length;
            msg(
                '#zoneMsg',
                `Imported ${cams}${plural(r.zones, 'zone')} and ${plural(r.samples, 'sample')} from ${file.name}.` +
                    (pw ? ` Set the password for camera ${r.needPassword.join(', ')} in the camera settings.` : ''),
                pw ? 'bad' : 'ok'
            );
            if (pw) $('#cameraDetails').open = true;
        } catch (err) {
            msg('#zoneMsg', err.message, 'bad');
        }
    });

    async function reloadState() {
        const s = await api('GET', '/state');
        state.cameras = s.cameras;
        state.zones = s.zones;
        state.settings = s.settings;
        state.calId = null;
        if (!state.cameras.some((c) => c.id === state.cameraId)) {
            state.cameraId = state.cameras.length ? state.cameras[0].id : null;
            $('#cameraForm').id.readOnly = false;
            view.setCamera(state.cameraId);
        }
        renderCamera();
        renderZones();
        renderCalibration();
        renderFollow();
    }

    // ---- Calibration
    // The set being captured into: the camera's, or a zone's own override set.

    function calSets() {
        const c = camera();
        if (!c || !c.calibrationId) return [];
        return [
            {id: c.calibrationId, label: `Camera ${c.name || c.id}`},
            ...cameraZones()
                .filter((z) => z.calibrationId)
                .map((z) => ({id: z.calibrationId, label: `Zone ${zoneName(z)} (own)`}))
        ];
    }

    function calTarget() {
        const sets = calSets();
        return sets.find((x) => x.id === state.calId) || sets[0] || null;
    }

    function renderCalSets() {
        const t = calTarget();
        state.calId = t ? t.id : null;
        fillSelect(
            $('#calForm').set,
            calSets().map((x) => [x.id, x.label]),
            {selected: state.calId}
        );
    }

    $('#calForm').set.addEventListener('change', (e) => {
        state.calId = e.target.value;
        renderCalibration();
    });

    function renderWaypointSelect() {
        const f = $('#calForm');
        const prev = f.waypoint.value;
        const options = byName(state.waypoints).map(([id, w]) => [id, w.name || id]);
        fillSelect(f.waypoint, options, {blank: '(choose a waypoint)', selected: prev});
        const a = $('#aimForm').waypoint;
        fillSelect(a, options, {blank: '(choose a waypoint)', selected: a.value});
        updateWpInfo();
    }

    // ---- Test aim: what the camera would do with the boat at a waypoint

    async function testAim() {
        const id = $('#aimForm').waypoint.value;
        if (!id || !state.cameraId) return;
        msg('#aimMsg', 'Aiming...');
        try {
            const w = await freshWaypoint(id);
            const p = wpPos(w);
            if (!p) return msg('#aimMsg', 'Waypoint has no position.', 'bad');
            const r = await api('POST', `/cameras/${encodeURIComponent(state.cameraId)}/aim-test`, p);
            const where = `bearing ${fmtBearing(r.bearing)}  range ${fmtRange(r.range)}`;
            if (!r.zone) {
                msg(
                    '#aimMsg',
                    `${w.name || id}: outside all zones, the camera would be released (not moved). ${where}`
                );
                return;
            }
            const o = r.outside || {};
            const flags = [o.pan && 'pan extrapolated', o.tilt && 'tilt held', o.zoom && 'zoom held'].filter(Boolean);
            msg(
                '#aimMsg',
                `${w.name || id}: zone ${r.zone.name} (${r.zone.mode === 'fixed' ? 'fixed' : 'follow'})  ` +
                    `pan ${fmtN(r.ptz.x)} tilt ${fmtN(r.ptz.y)} zoom ${fmtN(r.ptz.zoom)}  ${where}` +
                    (flags.length ? `  (${flags.join(', ')}: outside the calibrated range)` : ''),
                flags.length ? 'bad' : 'ok'
            );
        } catch (err) {
            msg('#aimMsg', `${err.message}`, 'bad');
        }
    }

    $('#aimForm').waypoint.addEventListener('change', testAim);
    $('#aimForm').addEventListener('submit', (e) => {
        e.preventDefault();
        testAim();
    });

    const zoneNames = (ids) =>
        ids
            .map((id) => state.zones.find((z) => z.id === id))
            .filter(Boolean)
            .map(zoneName)
            .join(', ') || 'none';

    async function updateWpInfo() {
        const f = $('#calForm');
        const w = state.waypoints[f.waypoint.value];
        const p = wpPos(w);
        if (!p) return ($('#wpInfo').textContent = '');
        const q = new URLSearchParams({latitude: p.latitude, longitude: p.longitude});
        if (state.cameraId) q.set('cameraId', state.cameraId);
        try {
            const g = await api('GET', `/geometry?${q}`);
            $('#wpInfo').textContent =
                `bearing ${fmtBearing(g.bearing)}  range ${fmtRange(g.range)}  ` +
                `down ${fmtDeg(g.depression)}  zones: ${zoneNames(g.zones)}`;
        } catch (err) {
            $('#wpInfo').textContent = err.message;
        }
    }

    $('#calForm').waypoint.addEventListener('change', updateWpInfo);
    $('#refreshWpBtn').addEventListener('click', async () => {
        await loadResources();
        renderWaypointSelect();
        renderCamera();
        renderZones();
    });

    $('#calForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const id = f.waypoint.value;
        const t = calTarget();
        if (!t) return msg('#calMsg', 'Save a camera first.', 'bad');
        if (!id) return msg('#calMsg', 'Choose a waypoint.', 'bad');
        try {
            const p = wpPos(await freshWaypoint(id));
            if (!p) return msg('#calMsg', 'Waypoint has no position.', 'bad');
            const s = await api('POST', `/calibration/${t.id}`, {
                waypointId: id,
                name: state.waypoints[id].name,
                latitude: p.latitude,
                longitude: p.longitude
            });
            const warn = s.moveStatus && /MOVING/.test(s.moveStatus) ? ' (camera was still moving)' : '';
            const again = s.replaced ? ', replacing the previous capture' : '';
            msg(
                '#calMsg',
                `Captured ${s.name || id}: pan ${fmtN(s.ptz.x)} tilt ${fmtN(s.ptz.y)} zoom ${fmtN(s.ptz.zoom)}${again}${warn}`,
                warn ? 'bad' : 'ok'
            );
            renderCalibration();
        } catch (err) {
            msg('#calMsg', err.message, 'bad');
        }
    });

    async function renderCalibration() {
        renderCalSets();
        const tbody = $('#samples tbody');
        const t = calTarget();
        $('#captureBtn').disabled = !t;
        if (!t) {
            tbody.innerHTML = '<tr><td colspan="7" class="hint">Save a camera first.</td></tr>';
            return;
        }
        let cal;
        try {
            cal = await api('GET', `/calibration/${t.id}`);
        } catch (err) {
            return msg('#calMsg', err.message, 'bad');
        }
        tbody.innerHTML = '';
        if (!cal.samples.length) tbody.innerHTML = '<tr><td colspan="7" class="hint">No samples yet.</td></tr>';
        // Sorted by bearing so a monotonic pan(bearing) is visible at a glance.
        const rows = [...cal.samples].sort((a, b) => (a.bearing ?? 0) - (b.bearing ?? 0));
        for (const s of rows) {
            const tr = el('tr', {title: `down ${fmtDeg(s.depression)}, zones: ${zoneNames(s.zones)}`});
            const cells = [
                s.name || s.waypointId || '',
                fmtBearing(s.bearing),
                fmtRange(s.range),
                fmtN(s.ptz.x),
                fmtN(s.ptz.y),
                fmtN(s.ptz.zoom)
            ];
            for (const c of cells) tr.append(el('td', {textContent: c}));
            const go = el('button', {type: 'button', textContent: 'Go to'});
            go.onclick = () => api('POST', `/calibration/${t.id}/${s.id}/goto`).catch(showError);
            const del = el('button', {type: 'button', textContent: '\u2715', title: 'Delete sample', className: 'del'});
            del.onclick = async () => {
                if (!confirm(`Delete sample ${s.name || ''}?`)) return;
                await api('DELETE', `/calibration/${t.id}/${s.id}`).catch(showError);
                renderCalibration();
            };
            tr.append(el('td', {className: 'actions'}, go, del));
            tbody.append(tr);
        }
        if (!cal.cameraPosition) msg('#calMsg', 'Set the camera position to see bearing and range.', 'bad');
    }

    // ---- Start

    async function init() {
        try {
            const s = await api('GET', '/state');
            state.cameras = s.cameras;
            state.zones = s.zones;
            state.settings = s.settings;
            state.cameraId = s.cameras.length ? s.cameras[0].id : null;
            setConn(state.cameraId ? 'connecting' : 'no camera', '');
        } catch (err) {
            if (err.status !== 401 && err.status !== 403) showError(err);
            return;
        }
        await loadResources();
        renderCamera();
        renderZones();
        renderWaypointSelect();
        renderCalibration();
        renderFollow();
        view.setCamera(state.cameraId);
        view.start();
        pollStatus();
        pollFollow();
    }

    init();
})();
