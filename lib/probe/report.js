'use strict';
/*
 * Render probe reports as a short markdown capability report, plus a JSON form with
 * the full raw responses. Credentials never appear: the report carries only the
 * username, and URIs are redacted of any embedded user:pass.
 */

const {TESTS, redact} = require('./probe');

function fmtRange(r) {
    return r && r.min !== null && r.min !== undefined ? `[${r.min}, ${r.max}]` : 'n/a';
}

/** @param {object[]} reports one per library run */
function toMarkdown(reports) {
    const out = [];
    const first = reports.find((r) => r.capabilities.device) || reports[0];
    const dev = first.capabilities.device || {};
    out.push(`# PTZ capability report`);
    out.push('');
    out.push(`- Camera: ${dev.manufacturer || '?'} ${dev.model || '?'}, firmware ${dev.firmwareVersion || '?'}`);
    out.push(`- Host: ${first.conn.hostname}:${first.conn.port}`);
    out.push(`- Run: ${first.startedAt}`);
    out.push('');

    out.push('## Results by library');
    out.push('');
    out.push(`| Test | ${reports.map((r) => r.lib).join(' | ')} |`);
    out.push(`|---|${reports.map(() => '---').join('|')}|`);
    for (const [id, name] of TESTS) {
        const cells = reports.map((r) => {
            const t = r.tests.find((x) => x.id === id);
            return t ? t.result : '';
        });
        out.push(`| ${id}. ${name} | ${cells.join(' | ')} |`);
    }
    out.push('');

    for (const r of reports) {
        const c = r.capabilities;
        out.push(`## ${r.lib}`);
        out.push('');
        for (const t of r.tests) out.push(`- **${t.id}. ${t.result}** ${t.name}: ${redact(t.summary)}`);
        out.push('');
        if (r.gate) {
            out.push(
                `Gate (test 5): AbsoluteMove ${r.gate.absoluteMoveHonoured ? 'HONOURED' : 'NOT honoured'}, ` +
                    `worst readback error ${r.gate.worstError} (tol ${r.gate.tol}).`
            );
            out.push('');
        }
        if (c.absoluteSpace && c.absoluteSpace.panTilt) {
            const pt = c.absoluteSpace.panTilt;
            const z = c.absoluteSpace.zoom;
            let line = `Command space: pan ${fmtRange(pt.x)}, tilt ${fmtRange(pt.y)} (${pt.uri})`;
            if (z) line += `, zoom ${fmtRange(z.x)} (${z.uri})`;
            out.push(line, '');
        }
        if (c.spaces) {
            out.push('| Space | URI | X | Y |');
            out.push('|---|---|---|---|');
            for (const s of c.spaces) out.push(`| ${s.name} | ${s.uri} | ${fmtRange(s.x)} | ${fmtRange(s.y)} |`);
            out.push('');
        }
        if (c.statusPosition) {
            const sp = c.statusPosition;
            out.push(`GetStatus reports: pan ${sp.x}, tilt ${sp.y}, zoom ${sp.zoom}, moveStatus ${sp.moveStatus}`);
            out.push('');
        }
        const t5 = r.tests.find((t) => t.id === 5);
        if (t5 && t5.details.targets) {
            out.push('| Target (x, y, zoom) | Readback | Error | OK | Settle ms |');
            out.push('|---|---|---|---|---|');
            for (const t of t5.details.targets) {
                const p = (v) => `${v.x}, ${v.y}, ${v.zoom}`;
                const e = Object.values(t.error)
                    .map((v) => (v === null ? '-' : v.toFixed(4)))
                    .join(', ');
                out.push(`| ${p(t.target)} | ${p(t.readback)} | ${e} | ${t.ok ? 'yes' : 'NO'} | ${t.settleMs} |`);
            }
            out.push('');
        }
    }
    return out.join('\n');
}

/** JSON-safe copy without the snapshot bytes. */
function toJson(reports) {
    return JSON.stringify(
        reports.map(({snapshot, ...r}) => ({...r, snapshotBytes: snapshot ? snapshot.length : 0})),
        null,
        2
    );
}

module.exports = {toMarkdown, toJson};
