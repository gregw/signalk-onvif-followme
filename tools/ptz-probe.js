#!/usr/bin/env node
'use strict';
/*
 * Phase 0: run the PTZ capability tests against a camera through one or more adapter
 * libraries and write a capability report.
 *
 *   node tools/ptz-probe.js --host 192.0.2.64 [--lib agsh|agsh-rc|node-onvif|all] [--no-move]
 *
 * Writes reports/<timestamp>/report.md, report.json (with raw XML) and snapshot-<lib>.jpg.
 */

const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {createAdapter, LIBS} = require('../lib/adapter');
const {runProbe, TESTS} = require('../lib/probe/probe');
const {toMarkdown, toJson} = require('../lib/probe/report');
const {CONN_OPTIONS, CONN_HELP, connFromArgs} = require('./cli-common');

const HELP = `Usage: node tools/ptz-probe.js --host <ip> [options]

Runs the Phase 0 ONVIF PTZ tests and writes a capability report.

${CONN_HELP}

Probe:
      --lib <name>       ${LIBS.join(' | ')} | all (default agsh)
      --only <ids>       comma separated test ids, e.g. 4,5 (connect always runs)
      --no-move          skip tests that move the camera (5, 6, 8)
      --tol <n>          max readback error per axis, normalised units (default 0.02)
      --settle <ms>      max wait for the mount to settle per move (default 20000)
      --out <dir>        report directory (default reports/<timestamp>)
      --verbose          print raw XML of every call

Tests:
${TESTS.map(([id, name]) => `  ${id}. ${name}`).join('\n')}`;

async function main() {
    const {values} = parseArgs({
        options: {
            ...CONN_OPTIONS,
            lib: {type: 'string', default: 'agsh'},
            only: {type: 'string'},
            'no-move': {type: 'boolean', default: false},
            tol: {type: 'string', default: '0.02'},
            settle: {type: 'string', default: '20000'},
            out: {type: 'string'},
            verbose: {type: 'boolean', default: false}
        }
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const libs = values.lib === 'all' ? LIBS : values.lib.split(',');
    for (const l of libs) if (!LIBS.includes(l)) throw new Error(`unknown --lib ${l}`);
    const conn = await connFromArgs(values);
    const only = values.only ? new Set(values.only.split(',').map(Number)) : undefined;

    const reports = [];
    for (const lib of libs) {
        const adapter = createAdapter(lib);
        const report = await runProbe(adapter, conn, {
            only,
            noMove: values['no-move'],
            tol: Number(values.tol),
            settleTimeoutMs: Number(values.settle),
            log: (l) => console.log(l)
        });
        await adapter.close().catch(() => {});
        if (values.verbose) {
            for (const t of report.tests) {
                for (const c of t.calls) {
                    console.log(`--- ${lib} ${t.id} ${c.call} ${c.error ? 'ERROR ' + c.error : ''}`);
                    if (c.raw) console.log(c.raw);
                }
            }
        }
        reports.push(report);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = values.out || path.join(__dirname, '..', 'reports', stamp);
    fs.mkdirSync(outDir, {recursive: true});
    const md = toMarkdown(reports);
    fs.writeFileSync(path.join(outDir, 'report.md'), md + '\n');
    fs.writeFileSync(path.join(outDir, 'report.json'), toJson(reports) + '\n');
    for (const r of reports) {
        if (r.snapshot) fs.writeFileSync(path.join(outDir, `snapshot-${r.lib}.jpg`), r.snapshot);
    }
    console.log('\n' + md);
    console.log(`\nReport written to ${outDir}`);
    const gateFailed = reports.some((r) => r.gate && !r.gate.absoluteMoveHonoured);
    return gateFailed ? 2 : 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`ptz-probe: ${err.message || err}`);
        process.exit(1);
    }
);
