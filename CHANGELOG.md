# Changelog

Notable changes to signalk-onvif-followme. Versions follow [semver](https://semver.org/); prereleases (`-dev.N`) are published under the npm `dev` tag.

## Unreleased

- README shows the plugin logo.

## 0.2.1 (2026-10-20)

- New plugin icon: a yacht in an SLR focusing screen.
- README: status from first use, install instructions, camera tools and a screenshot.

## 0.2.0 (2026-10-19)

Calibration rework.

- Calibration: one waypoint selector, with Capture and Test beside it.
- Calibration: aiming at a target interpolates within the smallest triangle of samples that contains it.
- Calibration: Test shows as active for a waypoint that is not a sample.
- Calibration: the samples table scrolls past 10 rows and keeps its header in view.
- Removed per zone calibration sets (the Own checkbox). Calibration is per camera.

## 0.1.1 (2026-10-18)

Development release.

- Follow loop ticks every 1 s instead of every 250 ms.

## 0.1.0 (2026-10-17)

First development release.

- Signal K plugin with a configuration webapp.
- ONVIF PTZ camera adapter, and a PTZ capability probe tool.
- Webapp: camera snapshot view at 4 fps with cross hairs, a zoom slider, and Go to with full precision PTZ values.
- Zones: named by their region, with priority, fixed mode, switching hysteresis and a hold time. Fixed zones re-send their view every hold time.
- Calibration per camera, one sample per waypoint name. Test aims the camera at any waypoint.
- Follow loop aims the camera at own vessel while it is in a zone. Follow stays on across plugin restarts.
- Follow live pop-up in the webapp.
- Export and import of all configuration except camera passwords.
