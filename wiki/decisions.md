# Design decisions

Decisions made after the brief, with the reason. The brief stays as written; where this file
differs, this file wins.

## 2026-10-17: Plugin state outside the options store

State (cameras, zones, calibration, settings) lives in `<plugin data dir>/state.json`, not
the plugin options file the brief names. The admin UI's plugin config form rewrites the
options file on submit, which could discard webapp-edited state. Atomic writes as before.

## 2026-10-17: Calibration per camera, with optional zone override

The brief binds calibration to a zone. Since the camera is fixed, pan(bearing) is the same
physical relationship in every zone, so per-zone sets would mean re-capturing the same
landmarks. Every camera owns a calibration set used by all its zones; a zone may opt into
its own set (`calibrationOverride`) when a local fit aims better. Samples stay
coordinate + PTZ only, derived bearing/range on read.

## 2026-10-17: Zone modes: followme and fixed

`mode` is a tagged union. Besides `followme`, a `fixed` zone has one stored view
`{x, y, zoom}` used for any target position inside it: a wide view where following would
pan too jerkily (target too close to the camera). The view is captured from the camera's
current position in the webapp.

## 2026-10-17: Overlapping zones and hysteresis

Resolves the brief's deferred decision 2. Per camera (lib/engine/zones.js):

- Sticky: the active zone stays active while the target is inside it, even if it is also
  inside another zone. Drawing neighbouring zones to overlap is the zone to zone hysteresis.
- Priority: entering from outside, or after leaving the active zone, the matching zone with
  the lowest `priority` number wins (ties by id).
- Hold: any change, including entry from and release to no zone, only after the same outcome
  has held for `holdS` (default 5 s). A flip-flop restarts the hold. This covers what
  overlaps cannot: jitter at an outer edge (zone to no zone) and single bad fixes.
- Zones without a polygon never match.

`holdS` is a global setting, editable in the webapp.

An edge margin (enter only when inside by N metres, leave only when outside by N) was
implemented and dropped the same day: overlaps already give zone to zone hysteresis, and the
hold covers the outer edge and bad fixes.

## 2026-10-17: Zones are named by their region

A zone has no name of its own: it shows its region's name, snapshotted with the polygon
(`geometry.refName`), so renaming the region in Freeboard does not rename the zone until
the zone is saved again. A region is therefore required, and a camera has at most one zone
per region. Saving a zone re-copies the region's current polygon and name; if the region
was deleted in Freeboard, the copy is kept. Older state files lose their free text zone
names on load, and any zone without a region is dropped (logged).

## 2026-10-17: Calibration model (lib/engine/calibration.js)

1D piecewise linear, as the brief says, with two refinements:

- tilt is interpolated against the depression angle atan(height / range), not range. For a
  level mount tilt is close to linear in that angle and strongly non-linear in range, so
  fewer samples are needed. With camera height 0 it falls back to range.
- pan is unwrapped across north (bearings) and across the camera's +-1 seam (pan values),
  so a sampled arc through either stays continuous.

Outside the sampled arc pan extrapolates linearly from the end segment; tilt and zoom hold
the end values. Both are flagged in the result. Two samples at distinct bearings minimum.

## 2026-10-17: Test aim

`POST /cameras/:id/aim-test` picks the zone for a single position (containment, then
priority; no hold) and moves the camera as followme would. The webapp offers every
waypoint and re-reads it from Signal K on each test (and on each capture), so a waypoint
can be moved in Freeboard and tested again without reloading.

## 2026-10-17: Export and import

From the webapp, not the admin UI plugin config (a schema form: no file transfer, and
submitting it restarts the plugin and rewrites the options file). The file holds zones and
calibration sets only: no cameras, credentials or settings. Import replaces all zones and
calibration after a confirmation naming what is lost; the file is fully validated first
(zones must name cameras configured here) and applied in one atomic save.
