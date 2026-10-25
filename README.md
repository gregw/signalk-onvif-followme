# signalk-onvif-followme

<img src="https://raw.githubusercontent.com/gregw/signalk-onvif-followme/main/public/icon.svg" alt="ONVIF Follow Me logo: a yacht in an SLR focusing screen" width="128" align="right">

A Signal K server plugin that turns a fixed pan-tilt-zoom webcam into a camera that follows one particular boat. The camera is mounted ashore (a balcony, a clubhouse, a headland) and speaks ONVIF; the boat is the Signal K server's own vessel, whose GPS position reaches the server as `navigation.position`. While that boat is inside one of the zones you draw on the chart in Freeboard, the plugin works out the bearing and range from the camera to the boat and steers the camera to keep it in view, panning as it sails past and zooming as it comes closer or moves away. When the boat leaves every zone the camera is released back to its own scan. A zone can instead hold one fixed wide view, for places where the boat is too close for smooth panning.

The camera is calibrated by pointing it at a few waypoints and capturing where it was looking, so no measurements of the mount are needed. The original brief and the design decisions made since are in the [wiki](https://github.com/gregw/signalk-onvif-followme/wiki).

![Freeboard with the zones and calibration waypoints on the left; the plugin's webapp with the live camera view, calibration samples and zones on the right](https://raw.githubusercontent.com/gregw/signalk-onvif-followme/main/docs/screenshot.jpg)

## Status

Minimally tested in the wild: one shore camera following one boat. It appears functional, but expect rough edges. Only the `agsh` backend (the default) has been used with a real camera; the others are untested in the plugin.

Working: camera connection, calibration, zones from Freeboard regions, the follow loop with tuning, and export/import of the configuration, all through the webapp at `/signalk-onvif-followme/`. Following is switched on and watched from the webapp's **Follow live** pop-up.

## Install

Requires Node 22 or later and Signal K server 2.x. Install **ONVIF Follow Me** from the Signal K app store, or from the command line in your Signal K configuration directory:

```sh
npm install signalk-onvif-followme
```

Restart the server, enable the plugin, then open the webapp. In outline:

1. **Camera:** connection details and the camera's position and height, set from a waypoint. **New camera** adds another; the picker in the header then chooses which one the page shows.
2. **Calibration:** pick a waypoint, centre it under the cross hairs, Capture. Repeat around the area the boat uses. **Test** aims as if the boat were at a waypoint and names the samples it used. Inside the calibrated area the aim is interpolated in the smallest triangle of samples around the target; outside, it is fitted from the 3 nearest. Landmarks whose charted position you trust beat chart symbols, and far landmarks forgive a few metres of error that near ones do not.
3. **Zones:** draw regions in Freeboard, then add each to a camera. A zone's mode is **Deadband** (move when the aim drifts past a deadband; the original), **Paced** (a move every second at the speed that keeps up with the boat, for smooth panning) or **Fixed** (one stored view). The gear button beside a follow zone opens its motion settings; blank fields use the defaults.
4. **Follow:** switch on, and watch it in **Follow live**.

## Camera tools

Command line tools to check what a camera and the ONVIF libraries actually do, without the plugin or a Signal K server. They are useful before relying on a new camera, or when trying a different backend. Run them from a clone of the repository.

```sh
npm install
npm test

# Full probe through every backend (moves the camera, then puts it back)
node tools/ptz-probe.js --host 192.0.2.64 --lib all

# Non-moving probe through the default backend
node tools/ptz-probe.js --host 192.0.2.64 --no-move

# Ad hoc commands
node tools/ptz.js --host 192.0.2.64 info
node tools/ptz.js --host 192.0.2.64 status
node tools/ptz.js --host 192.0.2.64 abs 0.2 -0.1 0
node tools/ptz.js --host 192.0.2.64 jog 0.3 0 0 1000
node tools/ptz.js --host 192.0.2.64 snapshot snap.jpg

# How the camera moves: speed curves, smoothness of resent and chained moves (about 10 minutes)
node tools/motion-probe.js --host 192.0.2.64
```

Username and password are prompted for on the terminal (`--user` skips the username prompt). The probe writes `reports/<timestamp>/report.md`, `report.json` (with every raw SOAP response) and a snapshot per library. Exit code 2 means the camera failed the AbsoluteMove test (test 5), which the plugin depends on. The motion probe writes `reports/<timestamp>-motion/motion.md` and `motion.json` (with every GetStatus sample).

## Debugging the aim

Turn on "Enable debug" for the plugin (Server, Plugin Config). While following is on, each tick then logs one line per camera, `signalk-onvif-followme aim {...}`, with the fix, COG and SOG, the predicted target, the zone and any pending zone change, the aim (`method` triangle or nearest, `neighbours`, `weights`, `raw` unclamped and clamped PTZ, bearing and range) and the PTZ sent, if any. Angles are radians, distances metres. To keep a race's log:

```sh
journalctl -u signalk --since "2026-10-23 17:30" --until "2026-10-23 20:00" -o cat | grep ' aim {' > race.log
```

## Adapter backends

The plugin's one option, **ONVIF library**, picks the backend; the tools take it as `--lib`.

| Backend | Library | Role | Used with a real camera in the plugin |
|---|---|---|---|
| `agsh` | `onvif` 0.8.3 (agsh/onvif) | default | yes |
| `agsh-rc` | `onvif` 1.0.0-rc.3, installed as `onvif-rc` | watch only | no |
| `node-onvif` | node-onvif vendored from signalk-onvif-camera 1.3.2 | fallback / comparison | no |

## Licence

Apache-2.0. `lib/adapter/vendor/node-onvif` is MIT, see its `LICENSE` and `README.md`.
