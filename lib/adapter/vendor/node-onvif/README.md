# Vendored node-onvif

Copied unmodified from `signalk-onvif-camera` 1.3.2 (`dist/lib/modules/*.js`, `dist/lib/config/defaults.js`),
https://github.com/KEGustafsson/signalk-onvif-camera, which itself vendors and extends node-onvif by Futomi Hatano.

MIT licence, see `LICENSE` in this directory:
Copyright (c) 2016 - 2018 Futomi Hatano, Copyright (c) 2022 Karl-Erik Gustafsson.

Used only by `lib/adapter/node-onvif.js` as the Phase 0 fallback and comparison backend.
Requires `xml2js`; the optional `html` pretty printer is not installed.
