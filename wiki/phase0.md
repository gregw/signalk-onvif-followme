# Phase 0: verification log and findings

## Brief assumptions checked (2026-10-17)

| Claim in brief | Checked against | Result |
|---|---|---|
| `onvif` (agsh) latest stable is 0.8.3, published 2026-09-07 | `npm view onvif time dist-tags` | Confirmed. Deps: `xml2js ^0.6.2`; engines node >=14. Ships a `promises/` wrapper. |
| 1.0.0-rc.3 published 2026-09-24, RC only | same | Confirmed, no 1.0.0 final. TypeScript rewrite, new promise `Onvif` class plus a `compatibility/` Cam shim; uses `fast-xml-parser`; node >=18. |
| agsh method names getStatus/absoluteMove/continuousMove/stop/getSnapshotUri | `node_modules/onvif/lib/ptz.js`, `media.js` at 0.8.3 | Confirmed on `Cam.prototype`, callback style `(err, data, xml)`. |
| signalk-onvif-camera 1.3.2 vendors node-onvif with full PTZ surface, MIT | tarball `dist/lib/modules/service-ptz.js`, `LICENSE` | Confirmed: AbsoluteMove, RelativeMove, ContinuousMove, Stop, GetStatus, presets, Get{Snapshot,Stream}Uri. MIT, (c) Futomi Hatano, Karl-Erik Gustafsson. |
| npm `node-onvif` as fallback | `npm view node-onvif` | 0.1.7, last modified 2022. The vendored copy is the better fallback. |

Brief over-absolute points relaxed: the rc line is included as a third, watch-only backend (`agsh-rc`) so the library decision rests on results, not on the version rule.

## Library quirks found reading the source

- agsh 0.8.3 `getStatus` defaults a missing Position to 0 (`res.position?.panTilt?.$?.x ?? 0`). The adapter therefore normalises from raw XML (`lib/adapter/onvif-xml.js`), where missing is `null`.
- agsh `onvif/promises` resolves with the parsed data only and drops the raw XML, so the adapter uses the callback API.
- agsh 0.8.3 uses Media2 automatically when advertised; profile parsing handles both Media1 and Media2 shapes.
- rc.3 `continuousMove` timeout is milliseconds; vendored node-onvif `Timeout` is whole seconds.
- Vendored node-onvif `absoluteMove` always sends Zoom; `continuousMove` omits Zoom when 0. Vector key is `z`, not `zoom`.
- ONVIF schema spells `DefaultAbsolutePantTiltPositionSpace` (sic).

## Camera

- VIP G28_VSIPPTZ-4IRC-I, ONVIF 23.06 (V3.1.0.1664296), at 192.0.2.64.
- ONVIF device service on port 80, `/onvif/device_service` (unauthenticated GetSystemDateAndTime answers; 8000/8080/2020/8899/5000 closed).
- Camera clock is NTP, matched local UTC within seconds (WS-Security digest is clock sensitive).
- Without credentials all three backends get a 401 at connect, as expected.
- GetDeviceInformation: manufacturer "General", model G28_VSIPPTZ-4IRC-I, firmware 3.200.101B000.0.R, build 2024-12-11.
  The RTSP path `/cam/realmonitor?channel=1&subtype=0` matches Dahua's URL scheme, so this is probably a Dahua OEM
  (inference from the URL only, not verified).
- Services (GetServices): device, media (ver10), media2 (ver20), ptz (ver20), imaging, analytics, events, deviceIO,
  all plain http on port 80.

## Probe run 1 (2026-10-17T03:32Z, reports/2026-10-17T03-33-37-511Z)

| Test | agsh 0.8.3 | agsh-rc 1.0.0-rc.3 | node-onvif (vendored) |
|---|---|---|---|
| 1 Connect, GetDeviceInformation | PASS | PASS | PASS |
| 2 Profiles, PTZ configurations | PASS | FAIL | PASS |
| 3 Configuration options | PASS | FAIL | PASS |
| 4 GetStatus Position | PASS | FAIL | PASS |
| 5 AbsoluteMove readback (gate) | **PASS** | SKIP | **PASS** |
| 6 ContinuousMove + Stop | PASS | FAIL | PASS |
| 7 Snapshot | FAIL (TLS) | FAIL (TLS) | FAIL (TLS) |
| 8 RelativeMove | PASS | FAIL | PASS |
| 9 GetStreamUri | PASS | PASS | PASS |

**Gate passed.** AbsoluteMove is honoured and GetStatus reads back the real position: the settle samples show the
mount travelling through intermediate values (e.g. -0.359, 0.115, 0.453, then 0.5), not an echo of the command.
Final readback equals the commanded value exactly (error 0.0000 on all 4 targets, both libraries).

Findings for the calibration and controller design:

- Profile `MediaProfile00000`, PTZ configuration `00000`, 3 profiles.
- Command space: pan [-1, 1], tilt [-1, 1] (PositionGenericSpace), zoom [0, 1] (ZoomSpaces PositionGenericSpace).
  The mapping of [-1, 1] to degrees is not known yet; calibration is in this normalised space anyway.
- GetStatus reports pan, tilt and zoom. MoveStatus is per axis (`panTilt=... zoom=...`).
- Timing: the position reaches the target in about 1.5 to 2 s for a 1.0 pan move, but MoveStatus stays MOVING for
  another 2 to 3 s. Full settle (IDLE) took 3.3 to 5.3 s. The controller's "no overlap" rule should key on
  MoveStatus IDLE, and the min command interval should be at least that long, or AbsoluteMove must be safe to
  supersede mid-move (untested).
- ContinuousMove at v=0.3 pans about 0.05 units/s; Stop is immediate (coast 0.0000 to 0.0003).
- RelativeMove in TranslationGenericSpace moves in position units (step 0.05 gave 0.0500).
- The camera also offers `TranslationSpaceFov` for RelativeMove: field-of-view relative translation, directly useful
  for Frigate-style "centre this pixel" fine correction later.
- Snapshot URI is `https://192.0.2.64/onvif/snapshot?channel=1&subtype=0` with a self-signed certificate and MD5
  Digest auth. The same path also answers on plain http with the same Digest challenge. The adapter now
  accepts a self-signed certificate only when the snapshot host is the camera's own hostname (see run 2).
- Stream URI: `rtsp://192.0.2.64:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif`.
- GetStatus `UtcTime` is one hour ahead of real UTC (04:32Z reported at 03:32Z): the camera appears to apply DST to
  its "UTC". Never use camera timestamps; use our own clock.
- agsh-rc 1.0.0-rc.3: profiles work, then every PTZ request fails with "socket hang up" (cause found in run 2).

Library decision: agsh `onvif` 0.8.3 primary, as the brief proposed, now on evidence. Vendored node-onvif is an
equally working fallback on this camera. rc.3 does not drive this camera's PTZ.

## Probe run 2 (2026-10-17T03:39Z, reports/2026-10-17T03-39-10-821Z, `--only 4,7 --no-move`)

- Test 7 snapshot: PASS on all three backends. About 448 KB JPEG, Digest auth, self-signed TLS accepted.
- Test 4: PASS on agsh and node-onvif; rc.3 still fails with "socket hang up".
- rc.3 cause, from the captured request: the PTZ body is `<GetStatus xmlns="undefined">`. In
  `node_modules/onvif-rc/build/ptz.js:31` the PTZ class calls `super(onvif, 'PTZ')`, but `service.js` keys
  `XMLNS` by lowercase `ptz`, so the namespace lookup gives undefined. The camera drops the connection.
  This is an upstream bug in 1.0.0-rc.3 and does not depend on the camera. Not patched locally.

**Phase 0 complete.** Every brief test passes on agsh 0.8.3 and on the vendored node-onvif.
