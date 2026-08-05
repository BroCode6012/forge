// scripts/verify-categories.js
// Proves the category registry is behavior-preserving for faceless + talkingHead:
// resolveMode() must be byte-identical to the OLD directors-brief ternary for every
// input (including the ai-* aliases, which collapse to faceless just like the old
// ternary did). Also checks the registry metadata.
'use strict';
const assert = require('assert');
const cats = require('../src/categories');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// The EXACT old logic from directors-brief.js (pre-P4), reproduced for parity.
function oldResolve(raw) {
    const rawMode = String(raw || 'faceless').trim().toLowerCase();
    return ['talkinghead', 'talking-head', 'talking_head'].includes(rawMode) ? 'talkingHead' : 'faceless';
}

console.log('\n=== resolveMode parity with the old ternary (faceless/talkingHead byte-identical) ===');
const inputs = [
    'faceless', 'Faceless', 'FACELESS', 'b-roll', 'broll',
    'talkingHead', 'talkinghead', 'talking-head', 'talking_head', 'TalkingHead', ' talkingHead ',
    'aiVideos', 'ai-stories', 'AI_STORIES', 'pureai',
    '', ' ', 'garbage', 'documentary', undefined, null, 'listicle',
];
let parityOk = true;
for (const inp of inputs) {
    const got = cats.resolveMode(inp);
    const old = oldResolve(inp);
    if (got !== old) {
        parityOk = false; console.log(`     PARITY BREAK "${inp}": new=${got} old=${old}`);
    }
}
ok('faceless/talkingHead resolution byte-identical to old ternary', parityOk);
ok('ai-* aliases collapse to faceless (AI Videos category removed)',
    cats.resolveMode('ai-stories') === 'faceless' && cats.resolveMode('aiVideos') === 'faceless');
ok('empty/unknown → faceless (historical default preserved)', cats.resolveMode('') === 'faceless' && cats.resolveMode(undefined) === 'faceless' && cats.resolveMode('garbage') === 'faceless');

console.log('\n=== registry metadata ===');
ok('getCategoryIds = [faceless, talkingHead]', JSON.stringify(cats.getCategoryIds()) === JSON.stringify(['faceless', 'talkingHead']));
ok('faceless/talkingHead have no presenter drift', cats.get('faceless').hasPresenter === false && cats.get('talkingHead').hasPresenter === true);
ok('every category declares allowedFormats', cats.CATEGORIES.every(c => Array.isArray(c.allowedFormats) && c.allowedFormats.length));
ok('get(unknown) falls back to faceless descriptor', cats.get('nope').id === 'faceless');

console.log(`\n${fail === 0 ? '✅ ALL CATEGORY CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
