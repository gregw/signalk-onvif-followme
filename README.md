# signalk-onvif-followme

A Signal K server plugin that turns a fixed pan-tilt-zoom webcam into a camera that follows one particular boat. The camera is mounted ashore (a balcony, a clubhouse, a headland) and speaks ONVIF; the boat is the Signal K server's own vessel, whose GPS position reaches the server as `navigation.position`. While that boat is inside one of the zones you draw on the chart in Freeboard, the plugin works out the bearing and range from the camera to the boat and steers the camera to keep it in view, panning as it sails past and zooming as it comes closer or moves away. When the boat leaves every zone the camera is released back to its own scan. A zone can instead hold one fixed wide view, for places where the boat is too close for smooth panning.

The camera is calibrated by pointing it at a few waypoints and capturing where it was looking, so no measurements of the mount are needed. The project brief is in `wiki/signalk-onvif-followme-brief.md`; decisions made since are in `wiki/decisions.md`.

## Status

Working: camera connection, calibration, zones from Freeboard regions, follow loop with tuning, and export/import of the configuration, all through the webapp at `/signalk-onvif-followme/`. Following is switched on and watched from the webapp's **Follow live** pop-up.

## Phase 0 camera tools

Command line tests and commands for an ONVIF camera, used to prove the camera before the plugin was built.

```sh
npm install
npm test

# Full probe through every backend (moves the camera, then puts it back)
node tools/ptz-probe.js --host 192.0.2.64 --lib all

# Non-moving probe through the primary backend
node tools/ptz-probe.js --host 192.0.2.64 --no-move

# Ad hoc commands
node tools/ptz.js --host 192.0.2.64 info
node tools/ptz.js --host 192.0.2.64 status
node tools/ptz.js --host 192.0.2.64 abs 0.2 -0.1 0
node tools/ptz.js --host 192.0.2.64 jog 0.3 0 0 1000
node tools/ptz.js --host 192.0.2.64 snapshot snap.jpg
```

Username and password are prompted for on the terminal (`--user` skips the username prompt). The probe writes `reports/<timestamp>/report.md`, `report.json` (with every raw SOAP response) and a snapshot per library. Exit code 2 means the AbsoluteMove gate (test 5) failed.

## Adapter backends

| `--lib` | Library | Role |
|---|---|---|
| `agsh` | `onvif` 0.8.3 (agsh/onvif) | primary |
| `agsh-rc` | `onvif` 1.0.0-rc.3, installed as `onvif-rc` | watch only |
| `node-onvif` | node-onvif vendored from signalk-onvif-camera 1.3.2 | fallback / comparison |

## Licence

Apache-2.0. `lib/adapter/vendor/node-onvif` is MIT, see its `LICENSE` and `README.md`.
