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
