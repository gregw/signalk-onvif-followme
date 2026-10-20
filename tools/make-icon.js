'use strict';
/*
 * Generates public/icon.svg: an SLR viewfinder focusing screen (scaled crosshair, grid
 * marks, double centre circle) with a yacht in the centre. The script lays out the ticks;
 * edit it rather than the SVG. Usage: node tools/make-icon.js [output] (default public/icon.svg).
 */

const fs = require('node:fs');
const path = require('node:path');

function makeIconSvg() {
    const cx = 256,
        cy = 248,
        R1 = 104,
        R2 = 90,
        step = 14;
    const ticks = [];
    for (let i = 1; cx + i * step <= 466; i++) {
        const len = i % 4 === 0 ? 11 : 6;
        if (i * step <= R1 + 4) continue;
        for (const s of [-1, 1]) ticks.push(`M${cx + s * i * step} ${cy - len}v${2 * len}`);
    }
    for (let i = 1; cy + i * step <= 392; i++) {
        const len = i % 4 === 0 ? 11 : 6;
        if (i * step <= R1 + 4) continue;
        for (const s of [-1, 1]) ticks.push(`M${cx - len} ${cy + s * i * step}h${2 * len}`);
    }
    const plus = [
        [52, 112],
        [460, 112],
        [52, 384],
        [460, 384]
    ].map(([x, y]) => `M${x - 10} ${y}h20M${x} ${y - 10}v20`);
    const edge = [
        [156, 104],
        [356, 104],
        [156, 392],
        [356, 392]
    ]
        .map(([x, y]) => `M${x} ${y - 8}v16`)
        .concat(
            [
                [40, 180],
                [40, 316],
                [472, 180],
                [472, 316]
            ].map(([x, y]) => `M${x - 8} ${y}h16`)
        );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>ONVIF Follow Me</title>
  <defs>
    <radialGradient id="screen" cx="50%" cy="48%" r="62%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.45" stop-color="#d9eefb"/>
      <stop offset="1" stop-color="#7fc0ea"/>
    </radialGradient>
  </defs>

  <!-- Focusing screen with locating tab -->
  <rect x="290" y="410" width="44" height="24" rx="4" fill="#9fd0f0" stroke="#2c5677" stroke-width="4"/>
  <rect x="12" y="78" width="488" height="340" rx="20" fill="url(#screen)" stroke="#2c5677" stroke-width="5"/>

  <g fill="none" stroke="#1d3c58" stroke-linecap="round">
    <!-- Crosshair, stopping at the centre circle -->
    <path d="M36 ${cy}H${cx - R1}M${cx + R1} ${cy}H476M${cx} 100V${cy - R1}M${cx} ${cy + R1}V396" stroke-width="4"/>
    <!-- Scale ticks -->
    <path d="${ticks.join('')}" stroke-width="3.5"/>
    <!-- Grid marks -->
    <path d="${plus.join('')}${edge.join('')}" stroke-width="3.5"/>
    <!-- Centre focusing circles -->
    <circle cx="${cx}" cy="${cy}" r="${R1}" stroke-width="5"/>
    <circle cx="${cx}" cy="${cy}" r="${R2}" stroke-width="3.5"/>
  </g>

  <!-- Yacht -->
  <g fill="#1d3c58">
    <rect x="257" y="174" width="5" height="114" rx="2"/>
    <path d="M267 178 Q294 232 323 282 L267 282 Z"/>
    <path d="M252 190 L252 282 L206 282 Q226 236 252 190 Z"/>
    <path d="M196 290 L328 290 Q320 312 294 317 L226 317 Q206 312 196 290 Z"/>
  </g>
  <path d="M214 326 q10.5 -7 21 0 t21 0 t21 0 t21 0" fill="none" stroke="#1f7fd0"
        stroke-width="6" stroke-linecap="round"/>
</svg>
`;
    return svg;
}

module.exports = {makeIconSvg};

if (require.main === module) {
    const out = process.argv[2] || path.join(__dirname, '..', 'public', 'icon.svg');
    fs.writeFileSync(out, makeIconSvg());
}
