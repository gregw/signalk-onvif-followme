#!/usr/bin/env node
'use strict';
/*
 * Measure how the camera moves (ContinuousMove speed curves, resend and speed-change
 * smoothness, zoom during pan, AbsoluteMove speed and chaining), for choosing a smooth follow
 * algorithm. Moves the camera for several minutes, then puts it back where it started.
 *
 *   node tools/motion-probe.js --host 192.0.2.64 [--quick] [--only pan-curve,resend]
 *
 * Writes reports/<timestamp>-motion/motion.md and motion.json (with every sample).
 */

const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {createAdapter, LIBS} = require('../lib/adapter');
const {runMotionProbe, restore, TESTS} = require('../lib/probe/motion');
const {toMotionMarkdown} = require('../lib/probe/motion-report');
const {CONN_OPTIONS, CONN_HELP, connFromArgs} = require('./cli-common');

const HELP = `Usage: node tools/motion-probe.js --host <ip> [options]

Measures how the camera moves and writes a report. Takes about 10 minutes (3 with --quick).
The camera is put back where it started at the end, or on Ctrl-C.

${CONN_HELP}

Probe:
      --lib <name>       ${LIBS.join(' | ')} (default agsh)
      --only <names>     comma separated tests (default all): ${TESTS.join(', ')}
      --quick            fewer velocities in the speed curves
      --home=<x,y,zoom>  where each test starts (default: start pan, tilt within +-0.7, zoom 0.25..0.6);
                         use = so a negative pan is not read as an option
      --chain-rate <n>   abs-chain pan rate to aim for, units/s (default 0.01)
      --out <dir>        report directory (default reports/<timestamp>-motion)`;

async function main() {
    const {values} = parseArgs({
        options: {
            ...CONN_OPTIONS,
            lib: {type: 'string', default: 'agsh'},
            only: {type: 'string'},
            quick: {type: 'boolean', default: false},
            home: {type: 'string'},
            'chain-rate': {type: 'string', default: '0.01'},
            out: {type: 'string'}
        }
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    if (!LIBS.includes(values.lib)) throw new Error(`unknown --lib ${values.lib}`);
    const only = values.only ? new Set(values.only.split(',')) : undefined;
    if (only) for (const n of only) if (!TESTS.includes(n)) throw new Error(`unknown test ${n}`);
    let home;
    if (values.home) {
        const [x, y, zoom] = values.home.split(',').map(Number);
        if (![x, y, zoom].every(Number.isFinite)) throw new Error('--home needs x,y,zoom');
        home = {x, y, zoom};
    }

    const conn = await connFromArgs(values);
    const cam = createAdapter(values.lib);
    await cam.connect(conn);
    const s = await cam.getStatus();
    const start = {x: s.x, y: s.y, zoom: s.zoom};
    console.log(`Start position x=${start.x} y=${start.y} zoom=${start.zoom}`);

    let interrupted = false;
    process.on('SIGINT', () => {
        if (interrupted) process.exit(130);
        interrupted = true;
        console.log('\nInterrupted: stopping and restoring the start position (Ctrl-C again to quit now)');
        restore(cam, start)
            .catch((err) => console.error(`restore failed: ${err.message || err}`))
            .finally(() => process.exit(130));
    });

    let report;
    try {
        report = await runMotionProbe(cam, {
            only,
            quick: values.quick,
            home,
            chainRate: Number(values['chain-rate']),
            log: (l) => console.log(l)
        });
    } finally {
        if (!interrupted) {
            const r = await restore(cam, start);
            console.log(
                `Restored to x=${r.status.x} y=${r.status.y} zoom=${r.status.zoom}${r.settled ? '' : ' (not settled)'}`
            );
        }
    }
    await cam.close().catch(() => {});

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = values.out || path.join(__dirname, '..', 'reports', `${stamp}-motion`);
    fs.mkdirSync(outDir, {recursive: true});
    const md = toMotionMarkdown(report);
    fs.writeFileSync(path.join(outDir, 'motion.md'), md + '\n');
    fs.writeFileSync(path.join(outDir, 'motion.json'), JSON.stringify(report, null, 1) + '\n');
    console.log('\n' + md);
    console.log(`\nReport written to ${outDir}`);
    return 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`motion-probe: ${err.message || err}`);
        process.exit(1);
    }
);
