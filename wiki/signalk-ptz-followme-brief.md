# signalk-ptz-followme — Build Brief

**Status:** greenfield. Package name provisional (`signalk-ptz-followme`); set the display `name` separately when finalised.

## Goal

A fixed (shore-mounted) ONVIF PTZ camera auto-aims at a SignalK position (own vessel) whenever that vessel is inside a defined visibility polygon, using a per-polygon calibration to map position to PTZ. Build the **followme** mode. Structure config and data so other targeting modes and camera poses slot in later without rework.

## Non-negotiable constraints

- **Greenfield.** Do not fork `signalk-onvif-camera`. You may borrow specific code from it (it is MIT; attribute in source headers): ONVIF connect/auth, snapshot handling, jog/live-view webapp bits. Do not adopt its architecture or config schema wholesale.
- **All camera I/O goes through a thin adapter.** Behind it initially: the `onvif` package (agsh/onvif), pinned to **0.8.3** (current stable, published 2026-09-07). A 1.0.0 release-candidate line exists (1.0.0-rc.3, 2026-09-24); treat it as watch-only and do not adopt an RC in this build. No ONVIF-aware code anywhere except inside the adapter, so the library stays swappable, and Phase 0 is what decides whether agsh actually drives this camera or a fallback is needed.
- **Only followme is implemented,** but `mode` is one variant of a tagged union, and mode + calibration + camera are bound to a polygon (a "zone").
- **Polygons are earth-fixed lat/lon for now.** Leave a `frame` seam for relative polygons later. Never assume a polygon is always absolute.

## Phase 0 (the priority): command-line camera and library capability tests

Build this first, as standalone CLI tools, and get it passing before any plugin, calibration, or mapping code exists. The camera firmware, not the library, is the real unknown, and everything downstream assumes absolute positioning plus PTZ readback work. Prove that against the actual camera before building on it.

Structure:

- Standalone CLI, no Signal K and no plugin. Lives in `tools/` (or `scripts/`), runnable from the shell with camera host/port/credentials via args or env.
- Built on the same `CameraAdapter` interface the plugin will use, so the CLI is the adapter's first consumer and the adapter is proven before the plugin depends on it.
- Run the suite through agsh `onvif` 0.8.3 as primary, but make the library selectable so the same tests can run through node-onvif as a fallback comparison. Decide the library from results, not in advance. (signalk-onvif-camera 1.3.2 vendors a working node-onvif with the full PTZ surface, so it is both a ready node-onvif path and a reference for the exact SOAP envelopes; MIT, attribute.)

Tests, each reporting pass/fail plus the raw response:

1. Connect and GetDeviceInformation: reachability, auth, correct ONVIF service port (often 80, sometimes 8000/2020).
2. GetProfiles / GetConfigurations: profile-token discovery; confirm a PTZ configuration exists.
3. GetConfigurationOptions: capture the PTZ coordinate spaces and limits (pan/tilt/zoom ranges). The calibration model must know the normalised space it commands in.
4. GetStatus: does it return a Position (the StatusPosition capability)? Log the actual reported ranges.
5. **AbsoluteMove (make-or-break):** command several targets, let the mount settle, read back via GetStatus, and confirm the readback tracks the commanded position rather than just ACKing. Some firmwares accept AbsoluteMove and only do relative or preset moves underneath.
6. ContinuousMove + Stop: press/hold semantics, needed for the jog-and-capture calibration UI.
7. GetSnapshotUri and fetch one JPEG: confirms the 1 fps snapshot path and whatever auth the snapshot URL needs.
8. Optional now, decision-relevant later: RelativeMove (Frigate-style fine centering) and GetStreamUri (the deferred stream-vs-snapshot live view).

Output a short capability report: what the camera honours, the PTZ coordinate spaces and limits, and which library drove it cleanly. That report is the input to the calibration and aiming design.

**Gate:** if test 5 fails (AbsoluteMove not honoured on readback), stop and rethink the approach (preset-based aiming, or Frigate visual centering) before building the plugin. Do not start plugin or mapping work until Phase 0 passes.

## Module layout

- `adapter/onvif` — thin wrapper over agsh `onvif`. The only ONVIF-aware code.
- `engine/` — pure logic, no SignalK or ONVIF imports, unit-testable:
  - `geometry` — bearing/range from camera to a point; point-in-polygon; bearing unwrap.
  - `calibration` — polar interpolation: `pan(bearing)`, `tilt(range)`, `zoom(range)`.
  - `aimer` — (target, cameraPose, calibration) to normalised PTZ.
  - `controller` — gate, deadband, min-interval, no-overlap.
- `plugin/` — SignalK glue: subscriptions, resources access, config persistence, router, static serving.
- `webapp/` — calibration and config UI (plain HTML/JS).

Keep `engine/` decoupled from `plugin/` and `adapter/`. This is what makes the feature portable if it is ever upstreamed as a module.

## ONVIF adapter interface

```ts
interface CameraAdapter {
  connect(conn): Promise<void>
  getStatus(): Promise<{ x: number, y: number, zoom: number, moveStatus?: string }>  // normalised
  absoluteMove(p: { x: number, y: number, zoom: number }): Promise<void>
  continuousMove(v: { x: number, y: number, zoom: number }): Promise<void>            // jog
  stop(): Promise<void>
  getSnapshotUri(): Promise<string>
  getStreamUri?(): Promise<string>   // reserved for the deferred stream option
}
```

Normalised space is whatever GetStatus returns (usually pan/tilt in [-1,1], zoom in [0,1]). Calibration is learned and commanded in that same space. Confirm agsh method names and param/response shapes against the installed 0.8.x before relying on them.

## Data model

**Camera:**
```jsonc
{
  "id": "apartment",
  "conn": { "hostname": "", "port": 80, "username": "", "password": "", "profileToken": "" },
  "pose": { "type": "fixed", "position": { "latitude": 0, "longitude": 0, "height": 0 } }
  // pose.type reserved: 'vessel' (onboard) later
}
```

**Zone** (the organising unit; the polygon binds mode + calibration + camera):
```jsonc
{
  "id": "harbour-mouth",
  "name": "Harbour mouth",
  "cameraId": "apartment",
  "geometry": { "frame": "absolute", "ref": "<regionId>", "polygon": [[lon, lat]] },
  "mode": {
    "type": "followme",
    "target": { "context": "self", "path": "navigation.position" },
    "gateSubject": "target"
  },
  "calibrationId": "harbour-mouth-cal"
}
```
- `mode` is a tagged union; only `followme` is handled now.
- `gateSubject` names which position the polygon test uses: `target` for followme (the boat); `observer` reserved for landmark-style modes where own position gates and a fixed point is aimed at.
- `geometry`: prefer authoring the polygon as a SignalK `regions` resource (drawable in Freeboard) referenced by `ref`. On assignment, snapshot the coordinates into `polygon` so a later edit or delete of the region does not silently break the zone. Inline `polygon` without a `ref` is an allowed fallback. This mirrors the waypoint-snapshot approach used for calibration.
- `frame:'absolute'` now; `'relative'` reserved.

**Calibration set:**
```jsonc
{
  "id": "harbour-mouth-cal",
  "zoneId": "harbour-mouth",
  "samples": [
    { "waypointId": "<uuid>", "latitude": 0, "longitude": 0, "ptz": { "x": 0, "y": 0, "zoom": 0 } }
  ]
}
```
- Store coordinate plus PTZ only. Derive `(bearing, range)` per sample at load from the zone camera's position; do not store them.
- The waypoint is an ephemeral authoring handle. The sample is self-contained on its coordinate once captured, so a deleted or moved waypoint does not invalidate it.
- Interpolation: convert each sample to `(bearing, range)` relative to the camera, then fit `pan(bearing)`, `tilt(range)`, `zoom(range)` as 1D curves. Unwrap bearing so an arc crossing 000 does not sweep the long way through south. If a level-mount assumption proves too strong later, upgrade to 2D barycentric interpolation in `(bearing, range)`; keep 1D as the default.

Persist cameras, zones, and calibration via the plugin options store. Editing is through the webapp, not hand-edited JSON.

## Control loop (followme)

- Subscribe to the target path (self `navigation.position`) via the server's self stream.
- On each fix, find zones whose `gateSubject` position (here the boat) is inside the zone polygon (point-in-polygon in lat/lon). If none match, do nothing; the camera's own inactivity timeout resumes its scan.
- For a matched zone, compute target PTZ from that zone's calibration and camera pose. If several zones for one camera match, pick by a defined priority (see deferred decisions).
- **Deadband:** if target PTZ is within epsilon of the last commanded value (or GetStatus readback) for that camera, skip the move. This is the "coordinates unchanged, stop moving" behaviour, and it is range-adaptive for free (a large boat move at long range is a sub-epsilon pan change).
- **Min command interval** per camera. Never issue an AbsoluteMove while one is in flight for that camera.
- **Release, not hold:** no keepalive initially. A near-stationary boat is allowed to fall back to the camera's scan. Add a hold/keepalive (re-send inside an interval shorter than the camera's scan-resume timeout) only if scan-away on slow boats proves annoying on the water.

## Webapp (calibration and config)

- List and edit cameras and zones; assign camera + mode + region to a zone.
- Calibration capture: select or drop a waypoint (read waypoints from the core resources API in the browser), jog the camera live, press capture. The plugin reads GetStatus plus the waypoint coordinate and stores a sample.
- **Live view behind a seam.** Implement 1 fps snapshot polling first (poll a plugin-proxied snapshot into an `<img>`). Keep the view component swappable so the stream option (reuse the other plugin's stream plus PTZ controls) can replace it later without touching capture logic. This is a deferred decision.
- Plain HTML/JS, no framework. This is dock/anchor setup tooling; do not harden it for race-time flaky networks.

## Endpoints (plugin router, mounted at `/plugins/<id>`)

```
GET    /camera/:id/status              -> normalised PTZ
POST   /camera/:id/move                -> { mode:'continuous'|'relative', x, y, zoom }
POST   /camera/:id/stop
GET    /camera/:id/snapshot            -> proxied JPEG bytes
GET    /zones,  POST /zones,  PUT /zones/:id,  DELETE /zones/:id
GET    /calibration/:zoneId
POST   /calibration/:zoneId            -> capture (reads GetStatus + waypoint coord)
DELETE /calibration/:zoneId/:sampleId
```

Read waypoints and regions from the core resources REST API directly in the browser rather than reimplementing listing. Only the writes that touch plugin state (zones, calibration) go to the plugin router.

## Verify, do not assume (confirm on the installed versions)

Treat these as unverified until checked against the installed server and library, per project rules on not hallucinating APIs:

- Resources API: `listResources` / `getResource` names and signatures, and the v2 REST paths for `waypoints` and `regions`.
- Plugin router registration hook and mount path; static serving from `public/`.
- Plugin options persistence API.
- Self subscription: `getSelfBus` vs `getSelfStream`, and the delta shape/timestamp (`getSelfBus` is expected to carry a timestamp; log one to confirm).
- agsh `onvif`: `getStatus` / `absoluteMove` / `continuousMove` / `stop` / `getSnapshotUri` names and shapes on 0.8.3.
- `navigation.attitude` path (only needed when the onboard/vessel pose lands later).

## Out of scope for v1, but must not be designed out

- **Other modes** (landmark, AIS): keep the `mode` union and `gateSubject` in place.
- **Onboard/moving camera pose:** `camera.pose.type` reserved. It needs a heading-plus-attitude transform and a vessel-frame calibration, a different calibration mode. Do not fold it into the fixed-camera model.
- **Relative polygons:** `geometry.frame` reserved.
- **Phone target:** another target context; the `target` descriptor already allows it.
- **Frigate / WebRTC fine-centering and stream-based live view:** deferred; snapshot path first.

## Deferred decisions (leave seams, do not resolve now)

1. Calibration live view: 1 fps snapshot vs reuse of the other plugin's stream plus PTZ controls. Build snapshot first behind a swappable view seam.
2. Multiple zones matching one camera: define a priority rule when it first bites.
3. 1D separable vs 2D barycentric calibration: ship 1D; keep the upgrade path.

## Borrowing from signalk-onvif-camera (MIT)

Permitted with attribution in source headers: ONVIF connect/auth, snapshot URI handling, and the jog/live-view UI. Note that 1.3.2 vendors node-onvif in `dist/lib` with the full PTZ surface (AbsoluteMove, GetStatus, ContinuousMove, RelativeMove, presets, GetSnapshotUri), so it is both the node-onvif fallback and the SOAP-envelope reference for Phase 0. If you mirror anything for future convergence, mirror only the camera-connection config shape and snapshot conventions; keep zone, mode, and calibration config ours.
