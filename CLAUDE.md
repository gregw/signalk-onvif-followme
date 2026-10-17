# CLAUDE.md

Conduct rules for this repository. The project brief is in `wiki/signalk-onvif-followme-brief.md`; read it before starting any task. Phase 0 findings and verified versions are in `wiki/phase0.md`. Decisions made since the brief are in `wiki/decisions.md`; where it differs from the brief, it wins.

## Verify, don't assert

- Never state a Signal K API, data path, unit, npm package version, ONVIF operation or element, or Node API from memory. Check the signalk-server source, the ONVIF WSDL/schema, or the installed package source first, and cite where you checked.
- The brief's version and API statements are claims to confirm, not facts. Record what was confirmed, and against what, in `wiki/phase0.md`.
- If you can't verify something, say so plainly and mark it `TODO(verify)` in code. Don't hedge silently.
- Don't build on an unverified premise. If an earlier assumption turns out wrong, say so and unwind what depended on it.

## Camera discipline

- All camera I/O goes through `lib/adapter/` (`CameraAdapter`). No ONVIF-aware code anywhere else.
- Normalised PTZ space is whatever the camera's default absolute spaces are. Never rescale silently; say which space a value is in.
- A missing value from the camera is `null`, never a default 0. Several libraries default missing fields to 0; do not inherit that.
- The real camera is the test of record for camera behaviour. Fakes test our logic, not the firmware.
- Moving the camera is allowed. Tools that move it should restore the starting position when done.
- Credentials are prompted for on the terminal. Never put them in files, args, logs, reports or commits.

## Signal K discipline

- Always be explicit about which layer you mean: **data model path**, **REST endpoint**, **WebSocket PUT handler**, or **internal plugin state**. Never blur them.
- Use SI units everywhere internally and on the wire: radians, m/s, metres, seconds. Convert to degrees and nm only at the UI edge.
- Target Node 22 (the boat computer is pinned to 22.22.2). Don't use language or runtime features newer than that.
- Never run `npm` inside `~/.signalk`.

## Design

- Prefer adapter interfaces and explicit seams for decisions that are deferred (see the brief's deferred decisions).
- Keep `engine/` pure: no Signal K or ONVIF imports.
- Correctness before elegance. Refactor only when it materially improves structure or reliability.
- Webapp: plain HTML, CSS and JS with no framework. This is dock setup tooling; do not harden it for flaky race-time networks.
- Plain JS with JSDoc types; no build step.

## Testing and done-ness

- Every change comes with tests (`npm test`, `node --test`). Run them before claiming anything works.
- Geometry and calibration maths get unit tests with known worked values.
- Camera behaviour claims need a run against the real camera (`tools/ptz-probe.js`), with the report quoted.
- UI changes involving layout or rendering must be checked in a real headless browser (Playwright with Chromium), not reasoned about.

## Communication and git

- Be concise and direct. Be critical in reviews rather than polite.
- No em dash characters in docs, code comments or commit messages.
- Small, focused commits. Don't push, publish or tag without asking.
- Ask when a decision is genuinely Greg's (scope, UX, data semantics). Otherwise make the conventional choice and say what you chose.
