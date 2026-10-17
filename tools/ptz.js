#!/usr/bin/env node
'use strict';
/*
 * Ad hoc PTZ commands through the CameraAdapter, for poking the camera by hand.
 *
 *   node tools/ptz.js --host 192.0.2.64 status
 *   node tools/ptz.js --host 192.0.2.64 abs 0.1 -0.2 0
 *   node tools/ptz.js --host 192.0.2.64 jog 0.3 0 0 1000
 */

const fs = require('node:fs');
const {parseArgs} = require('node:util');
const {createAdapter, LIBS} = require('../lib/adapter');
const {waitSettled} = require('../lib/probe/ptz-math');
const {CONN_OPTIONS, CONN_HELP, connFromArgs} = require('./cli-common');

const HELP = `Usage: node tools/ptz.js --host <ip> [options] <command> [args]

Commands:
  info                    device information, profiles, PTZ configurations and spaces
  status                  current normalised pan/tilt/zoom
  abs <x> <y> <zoom>      AbsoluteMove, then wait for settle and print readback
  rel <dx> <dy> <dzoom>   RelativeMove, then settle and print readback
  jog <vx> <vy> <vz> [ms] ContinuousMove for ms (default 1000), then Stop
  stop                    Stop
  snapshot [file]         fetch a JPEG (default snapshot.jpg)
  stream                  print the RTSP stream URI

${CONN_HELP}
      --lib <name>       ${LIBS.join(' | ')} (default agsh)
      --raw              print the raw XML of the last response`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // parseArgs would read "-0.2" as an option; shield negative numbers as positionals.
    const NEG = '\u0000neg';
    const argv = process.argv.slice(2).map((a) => (/^-(\d|\.\d)/.test(a) ? NEG + a : a));
    const parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {...CONN_OPTIONS, lib: {type: 'string', default: 'agsh'}, raw: {type: 'boolean', default: false}}
    });
    const values = parsed.values;
    const positionals = parsed.positionals.map((a) => (a.startsWith(NEG) ? a.slice(NEG.length) : a));
    if (values.help || positionals.length === 0) {
        console.log(HELP);
        return 0;
    }
    const [cmd, ...args] = positionals;
    const n = (i, d) => (args[i] === undefined ? d : Number(args[i]));
    const conn = await connFromArgs(values);
    const cam = createAdapter(values.lib);
    await cam.connect(conn);
    const show = (o) => console.log(JSON.stringify(o, null, 2));
    const settled = async () => {
        const r = await waitSettled(() => cam.getStatus(), {minWaitMs: 500});
        show({...r.status, settled: r.settled, settleMs: r.elapsedMs});
    };
    try {
        switch (cmd) {
            case 'info': {
                show({profileToken: cam.profileToken, device: await cam.getDeviceInformation()});
                show(await cam.getProfiles());
                const configs = await cam.getPtzConfigurations();
                show(configs);
                for (const c of configs) show(await cam.getPtzConfigurationOptions(c.token));
                break;
            }
            case 'status':
                show(await cam.getStatus());
                break;
            case 'abs':
                await cam.absoluteMove({x: n(0, 0), y: n(1, 0), zoom: n(2, 0)});
                await settled();
                break;
            case 'rel':
                await cam.relativeMove({x: n(0, 0), y: n(1, 0), zoom: n(2, 0)});
                await settled();
                break;
            case 'jog':
                await cam.continuousMove({x: n(0, 0), y: n(1, 0), zoom: n(2, 0)});
                await sleep(n(3, 1000));
                await cam.stop();
                await settled();
                break;
            case 'stop':
                await cam.stop();
                break;
            case 'snapshot': {
                const s = await cam.fetchSnapshot();
                const file = args[0] || 'snapshot.jpg';
                if (s.status === 200) fs.writeFileSync(file, s.body);
                show({status: s.status, contentType: s.contentType, auth: s.auth, bytes: s.body.length, file});
                break;
            }
            case 'stream':
                console.log(await cam.getStreamUri());
                break;
            default:
                throw new Error(`unknown command '${cmd}'`);
        }
    } finally {
        if (values.raw && cam.lastRaw) console.log(cam.lastRaw);
        await cam.close().catch(() => {});
    }
    return 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`ptz: ${err.message || err}`);
        if (err.raw) console.error(err.raw);
        process.exit(1);
    }
);
