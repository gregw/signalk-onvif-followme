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

    const state = {cameras: [], zones: [], waypoints: {}, regions: {}, cameraId: null, zoneId: null};

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
    document.querySelectorAll('[data-zoom]').forEach((b) => {
        const z = Number(b.dataset.zoom);
        bindHold(b, () => ({x: 0, y: 0, zoom: z * speed()}));
    });
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

    // ---- Camera form

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
        if (!c) {
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

    // ---- Zone form

    function zone() {
        return state.zones.find((z) => z.id === state.zoneId) || null;
    }

    function renderZones() {
        const f = $('#zoneForm');
        fillSelect(
            f.zone,
            state.zones.map((z) => [z.id, z.name]),
            {blank: '(new zone)', selected: state.zoneId || ''}
        );
        const z = zone();
        fillSelect(
            f.region,
            byName(state.regions).map(([id, r]) => [id, r.name || id]),
            {blank: '(none yet)', selected: z && z.geometry ? z.geometry.ref || '' : ''}
        );
        f.name.value = z ? z.name : 'Zone ' + (state.zones.length + 1);
        $('#zoneDeleteBtn').disabled = !z;
        const g = z && z.geometry;
        msg(
            '#zoneMsg',
            g
                ? `Polygon: ${g.refName || g.ref || 'inline'} (${g.polygon.type}), copied when saved`
                : z
                  ? 'No region assigned'
                  : ''
        );
    }

    $('#zoneForm').zone.addEventListener('change', (e) => {
        state.zoneId = e.target.value || null;
        renderZones();
        renderCalibration();
    });

    async function saveZone(body) {
        const z = state.zoneId ? await api('PUT', `/zones/${state.zoneId}`, body) : await api('POST', '/zones', body);
        const i = state.zones.findIndex((x) => x.id === z.id);
        if (i >= 0) state.zones[i] = z;
        else state.zones.push(z);
        state.zoneId = z.id;
        renderZones();
        renderCalibration();
        return z;
    }

    $('#zoneForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        if (!state.cameraId) return msg('#zoneMsg', 'Save a camera first.', 'bad');
        const regionId = f.region.value;
        const region = state.regions[regionId];
        const body = {
            name: f.name.value,
            cameraId: state.cameraId,
            geometry: region
                ? {frame: 'absolute', ref: regionId, refName: region.name, polygon: region.feature.geometry}
                : zone()
                  ? zone().geometry
                  : null
        };
        try {
            await saveZone(body);
            msg('#zoneMsg', 'Saved. ' + $('#zoneMsg').textContent, 'ok');
        } catch (err) {
            msg('#zoneMsg', err.message, 'bad');
        }
    });

    $('#zoneDeleteBtn').addEventListener('click', async () => {
        const z = zone();
        if (!z || !confirm(`Delete zone "${z.name}" and its calibration samples?`)) return;
        try {
            await api('DELETE', `/zones/${z.id}`);
            state.zones = state.zones.filter((x) => x.id !== z.id);
            state.zoneId = state.zones.length ? state.zones[0].id : null;
            renderZones();
            renderCalibration();
        } catch (err) {
            msg('#zoneMsg', err.message, 'bad');
        }
    });

    // ---- Calibration

    function renderWaypointSelect() {
        const f = $('#calForm');
        const prev = f.waypoint.value;
        fillSelect(
            f.waypoint,
            byName(state.waypoints).map(([id, w]) => [id, w.name || id]),
            {blank: '(choose a waypoint)', selected: prev}
        );
        updateWpInfo();
    }

    async function updateWpInfo() {
        const f = $('#calForm');
        const w = state.waypoints[f.waypoint.value];
        const p = wpPos(w);
        if (!p) return ($('#wpInfo').textContent = '');
        const q = new URLSearchParams({latitude: p.latitude, longitude: p.longitude});
        if (state.cameraId) q.set('cameraId', state.cameraId);
        try {
            const g = await api('GET', `/geometry?${q}`);
            const inZone = state.zoneId ? (g.zones.includes(state.zoneId) ? 'inside zone' : 'outside zone') : '';
            $('#wpInfo').textContent =
                `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}  bearing ${fmtBearing(g.bearing)}  ` +
                `range ${fmtRange(g.range)}  ${inZone}`;
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
        const p = wpPos(state.waypoints[id]);
        if (!state.cameraId) return msg('#calMsg', 'Save a camera first.', 'bad');
        if (!p) return msg('#calMsg', 'Choose a waypoint.', 'bad');
        try {
            // Samples belong to a zone. If there is none yet, create one without a region;
            // the region can be assigned later in the Zone panel.
            if (!state.zoneId) {
                await saveZone({name: $('#zoneForm').name.value || 'Zone 1', cameraId: state.cameraId, geometry: null});
            }
            const s = await api('POST', `/calibration/${state.zoneId}`, {
                waypointId: id,
                name: state.waypoints[id].name,
                latitude: p.latitude,
                longitude: p.longitude
            });
            const warn = s.moveStatus && /MOVING/.test(s.moveStatus) ? ' (camera was still moving)' : '';
            msg(
                '#calMsg',
                `Captured ${s.name || id}: pan ${fmtN(s.ptz.x)} tilt ${fmtN(s.ptz.y)} zoom ${fmtN(s.ptz.zoom)}${warn}`,
                warn ? 'bad' : 'ok'
            );
            renderCalibration();
        } catch (err) {
            msg('#calMsg', err.message, 'bad');
        }
    });

    async function renderCalibration() {
        const tbody = $('#samples tbody');
        $('#captureBtn').disabled = !state.cameraId;
        if (!state.zoneId) {
            tbody.innerHTML = state.cameraId
                ? '<tr><td colspan="9" class="hint">No samples yet. The first capture also creates a zone.</td></tr>'
                : '<tr><td colspan="9" class="hint">Save a camera first.</td></tr>';
            return;
        }
        let cal;
        try {
            cal = await api('GET', `/calibration/${state.zoneId}`);
        } catch (err) {
            return msg('#calMsg', err.message, 'bad');
        }
        tbody.innerHTML = '';
        if (!cal.samples.length) tbody.innerHTML = '<tr><td colspan="9" class="hint">No samples yet.</td></tr>';
        // Sorted by bearing so a monotonic pan(bearing) is visible at a glance.
        const rows = [...cal.samples].sort((a, b) => (a.bearing ?? 0) - (b.bearing ?? 0));
        for (const s of rows) {
            const tr = document.createElement('tr');
            const cells = [
                s.name || s.waypointId || '',
                fmtBearing(s.bearing),
                fmtRange(s.range),
                fmtDeg(s.depression),
                s.inZone === null ? '-' : s.inZone ? 'yes' : 'no',
                fmtN(s.ptz.x),
                fmtN(s.ptz.y),
                fmtN(s.ptz.zoom)
            ];
            for (const c of cells) {
                const td = document.createElement('td');
                td.textContent = c;
                tr.append(td);
            }
            const td = document.createElement('td');
            const go = document.createElement('button');
            go.textContent = 'Go to';
            go.onclick = () => api('POST', `/calibration/${state.zoneId}/${s.id}/goto`).catch(showError);
            const del = document.createElement('button');
            del.textContent = 'Delete';
            del.onclick = async () => {
                if (!confirm(`Delete sample ${s.name || ''}?`)) return;
                await api('DELETE', `/calibration/${state.zoneId}/${s.id}`).catch(showError);
                renderCalibration();
            };
            td.append(go, del);
            tr.append(td);
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
            state.cameraId = s.cameras.length ? s.cameras[0].id : null;
            state.zoneId = s.zones.length ? s.zones[0].id : null;
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
        view.setCamera(state.cameraId);
        view.start();
        pollStatus();
    }

    init();
})();
