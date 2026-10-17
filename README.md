# signalk-onvif-followme

Signal K plugin (in progress) that aims a fixed ONVIF PTZ camera at a Signal K position while it is inside a visibility zone. See `wiki/signalk-onvif-followme-brief.md`.

## Status: Phase 0

Command line camera capability tests only. No plugin yet.

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
