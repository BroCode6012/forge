#!/usr/bin/env node
'use strict';

/**
 * One-shot codemod: viewport-relative font sizes -> stage-relative pixels.
 *
 * The HyperFrames composition is a FIXED 1920x1080 element. The final render
 * captures it in a 1920-wide viewport, so `3.2vw` resolves to 61.44px. The
 * in-app preview drops the same element into a much narrower iframe and scales
 * it with a CSS transform, so `vw` there resolves against the IFRAME width
 * (~900px) -> 28.8px -> the clamp floor wins instead.
 *
 * Net effect: every clamp(min, Nvw, max) headline rendered at roughly half size
 * in the preview while the real render was correct. Text looked lost in an
 * oversized box, which is exactly the "AI slop" signature we are hunting - and
 * it was an artifact of the preview, not the design.
 *
 * Substituting the 1920-equivalent pixel value is behaviour-preserving for the
 * render (identical resolved value) and makes the preview finally agree with it.
 *
 * Run once; the permanent guard is scripts/verify/stage-relative-units.js.
 */

const fs = require('fs');
const path = require('path');

const STAGE_WIDTH = 1920;
const target = path.join(__dirname, '..', 'src', 'render', 'hyperframes-bridge.js');

const before = fs.readFileSync(target, 'utf8');
const hits = [];

// Only inside clamp(): that is where every font-size lives. Deliberately does
// NOT touch the preview runtime's `100vw` body sizing, which is a real viewport
// measurement and must stay viewport-relative.
const after = before.replace(
    /clamp\(\s*([^,()]+?)\s*,\s*(\d+(?:\.\d+)?)vw\s*,\s*([^,()]+?)\s*\)/g,
    (whole, min, vw, max) => {
        const px = (Number(vw) * STAGE_WIDTH) / 100;
        const rounded = Number(px.toFixed(2));
        hits.push({ from: whole, vw: `${vw}vw`, px: `${rounded}px` });
        return `clamp(${min}, ${rounded}px, ${max})`;
    }
);

if (!hits.length) {
    console.log('nothing to convert - already stage-relative');
    process.exit(0);
}

fs.writeFileSync(target, after, 'utf8');
console.log(`converted ${hits.length} viewport-relative size(s) to stage pixels\n`);
for (const h of hits) console.log(`  ${h.vw.padEnd(8)} -> ${h.px.padEnd(10)} in  ${h.from}`);
