'use strict';
/*
 * Markdown summary of a motion probe report (lib/probe/motion.js). Rates are normalised
 * units per second of the camera's default spaces; degrees are not shown because the unit to
 * degree mapping is not known from the camera (the calibration fit suggests about 180 degrees
 * per pan unit, but that is our estimate, not a camera fact).
 */

const f = (x, d = 4) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));

function curveTable(name, c) {
    if (!c || c.error) return [`### ${name}`, '', c ? `Error: ${c.error}` : 'Not run.', ''];
    const lines = [`### ${name}`, '', '| velocity | rate /s | start ms | -v/+v |', '|---|---|---|---|'];
    for (const r of c.runs.filter((x) => x.v > 0)) {
        const n = c.runs.find((x) => x.v === -r.v);
        const asym = c.asymmetry.find((a) => a.v === r.v);
        const acc = (x) => (x && x.withAccel ? '*' : '');
        lines.push(
            `| ${r.v} | ${f(r.rate)}${acc(r)} / ${f(n && n.rate)}${acc(n)} | ${r.startMs ?? '-'} / ${(n && n.startMs) ?? '-'} | ${f(asym && asym.ratio, 2)} |`
        );
    }
    if (c.runs.some((x) => x.withAccel))
        lines.push('', '\\* too fast for a clean fit: includes acceleration, so a lower bound.');
    lines.push('', `Distinct speed levels (within 8%): ${c.levels.length} over ${c.runs.length / 2} velocities.`);
    for (const l of c.levels) lines.push(`- ${f(l.rate)} /s at v = ${l.vs.join(', ')}`);
    lines.push('');
    return lines;
}

function toMotionMarkdown(r) {
    const t = r.tests;
    const lines = [
        '# Motion probe',
        '',
        `Started ${r.startedAt}, finished ${r.finishedAt}, library ${r.lib}.`,
        `Start position x=${r.start.x} y=${r.start.y} zoom=${r.start.zoom}; home x=${f(r.home.x)} y=${f(r.home.y)} zoom=${f(r.home.zoom)}.`,
        `GetStatus: ${r.getStatus.calls} calls, round trip p50 ${r.getStatus.rttMs.p50} ms, p95 ${r.getStatus.rttMs.p95} ms, max ${r.getStatus.rttMs.max} ms; unchanged pan between consecutive reads while panning: ${r.getStatus.staleWhileMoving === undefined || r.getStatus.staleWhileMoving === null ? '-' : (100 * r.getStatus.staleWhileMoving).toFixed(0) + '%'}.`,
        '',
        '## ContinuousMove velocity to rate',
        '',
        ...curveTable('Pan', t['pan-curve']),
        ...curveTable('Tilt', t['tilt-curve']),
        ...curveTable('Zoom', t['zoom-curve']),
        '## Timing',
        ''
    ];
    const rs = t.resend;
    if (rs && !rs.error) {
        lines.push(
            `- Resend every 1 s at v=${rs.v}: rate ${f(rs.rate)}/s; 500 ms window rates ${f(rs.minRate)} to ${f(rs.maxRate)}; windows below half the rate: ${rs.dips.length} of ${rs.windows}.`
        );
    }
    const st = t.step;
    if (st && !st.error) {
        lines.push(
            `- Step v=${st.v} to ${2 * st.v}: rate ${f(st.before)} to ${f(st.after)}/s, within 10% of the new rate after ${st.rampMs ?? '-'} ms.`
        );
    }
    const zp = t['zoom-during-pan'];
    if (zp && !zp.error) {
        for (const k of ['pan+zoom', 'zoom-only']) {
            const o = zp[k];
            lines.push(
                `- Zoom during pan, ${k}: pan ${f(o.panBefore)} before, ${f(o.panDuring)} during, ${f(o.panAfter)} after; zoom ${f(o.zoomDuring)}/s during.`
            );
        }
    }
    lines.push('', '## AbsoluteMove', '');
    const as = t['abs-speed'];
    if (as && !as.error) {
        lines.push(
            'Pan move at each speed (generic speed space):',
            '',
            '| speed | distance | rate /s | arrived ms |',
            '|---|---|---|---|'
        );
        for (const x of as.runs) lines.push(`| ${x.speed} | ${x.dist} | ${f(x.rate)} | ${x.arriveMs ?? '> 20000'} |`);
        lines.push('');
    }
    const ch = t['abs-chain'];
    if (ch && !ch.error) {
        lines.push(
            `Chained moves every 1 s at speed ${ch.speed}, ${f(ch.stepUnits)} units each: rate ${f(ch.rate)}/s; 500 ms window rates ${f(ch.minRate)} to ${f(ch.maxRate)}; windows below half the rate: ${ch.dips.length} of ${ch.windows}.`
        );
    }
    for (const [name, v] of Object.entries(t)) if (v && v.error) lines.push(`- ${name}: error ${v.error}`);
    return lines.join('\n');
}

module.exports = {toMotionMarkdown};
