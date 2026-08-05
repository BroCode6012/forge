#!/usr/bin/env node
// scripts/vision-judge-status.js
// ============================================================================
// Answers ONE question, in plain language: which model will actually judge my
// footage on the next build, and which file decided that?
//
// Why this exists: the judge is chosen by four stacked layers, and it has now
// silently been the wrong one twice in two days — once because the UI dropdown
// never reached the build child (fixed with YTA_ENV_LOCK), once because the
// configured model 403'd on every call and the chain quietly fell through to a
// stand-in that rejected good footage. Both times the build looked normal and
// just produced empty scenes.
//
// Reading one .env proves nothing. This reads all of them, in the real order,
// with the real per-layer rules, and says who won.
//
// Prints model ids, file paths and which layer set a key. Only ever prints
// values for the vision-routing keys listed in WATCH — no credentials.
//
// Run:  node scripts/vision-judge-status.js
//       node scripts/vision-judge-status.js "C:\path\to\project"
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
const WATCH = ['VISION_BACKEND', 'VISION_BEDROCK_PRIMARY_MODEL', 'VISION_PROVIDER',
    'BEDROCK_VISION_CLAUDE_MODEL', 'VISION_FALLBACK_ORDER', 'VISION_EXCLUDE_QWEN'];

// The project layer is keyed off DOTENV_PATH (not a project dir) and is filtered
// to PROJECT_OVERRIDE_KEYS. Set it before config.js loads so this report and the
// real resolution see the same layers.
const projectDir = process.argv[2] || process.env.PROJECT_DIR || '';
if (projectDir && !process.env.DOTENV_PATH) {
    const p = path.join(projectDir, '.env');
    if (fs.existsSync(p)) process.env.DOTENV_PATH = p;
}

const config = require(path.join(ROOT, 'src', 'settings', 'config.js'));
const ai = require(path.join(ROOT, 'src', 'brain', 'ai-provider.js'));

// config.js builds PROJECT_OVERRIDE_KEYS from the schema plus a short list of
// operational download-tuning keys, and does not export it. Derive the same set
// from the schema — the operational half contains no vision-routing key, so for
// everything in WATCH this is exact.
const PROJECT_OVERRIDE_KEYS = new Set(require(path.join(ROOT, 'src', 'settings', 'schema.js')).projectEnvVars());

const userEnvPath = process.env.YTA_USER_ENV_PATH
    || path.join(process.env.APPDATA || process.env.HOME || '', 'yta-empire-webgl', '.env');

// Weakest first, exactly as src/settings/config.js applies them. `filtered` mirrors
// the project layer's rule: only PROJECT_OVERRIDE_KEYS with a non-empty value land.
const layers = [
    { name: 'repo .env', file: path.join(ROOT, '.env') },
    { name: 'user .env (beats repo — loaded with override)', file: userEnvPath },
    { name: 'project .env (only build settings)', file: process.env.DOTENV_PATH || '', filtered: true },
];

console.log('\nWho decides which model judges your footage');
console.log('(later layers beat earlier ones)\n');

const winner = {};
for (const layer of layers) {
    if (!layer.file) continue;
    const exists = fs.existsSync(layer.file);
    let parsed = {};
    if (exists) { try { parsed = dotenv.parse(fs.readFileSync(layer.file)); } catch (_) {} }

    console.log(`  ${exists ? '📄' : '— '} ${layer.name}`);
    console.log(`     ${layer.file}${exists ? '' : '   (not present)'}`);
    if (!exists) { console.log(''); continue; }

    let printed = 0;
    for (const k of WATCH) {
        const v = parsed[k];
        if (v === undefined || String(v).trim() === '') continue;
        // A project-layer key outside PROJECT_OVERRIDE_KEYS is read and DISCARDED.
        // Showing it as a winner would be a lie — that is exactly the class of
        // wrong-by-omission this script exists to stop.
        const applies = !layer.filtered || (PROJECT_OVERRIDE_KEYS && PROJECT_OVERRIDE_KEYS.has(k));
        console.log(`       ${k} = ${v}${applies ? '' : '   ⚠️ ignored (not a project-overridable setting)'}`);
        if (applies) winner[k] = layer.name;
        printed++;
    }
    if (!printed) console.log('       (sets none of the vision-judge keys)');
    console.log('');
}

// The top layer: what the UI picked for this build. Only present inside a real
// build child, but say so either way so the ordering is never a mystery.
const lock = String(process.env.YTA_ENV_LOCK || '').split(',').map((s) => s.trim()).filter(Boolean);
const lockedWatch = lock.filter((k) => WATCH.includes(k));
console.log(`  ${lockedWatch.length ? '🔒' : '— '} this build's choices in the app (beats every file)`);
if (lockedWatch.length) {
    for (const k of lockedWatch) { console.log(`       ${k} = ${process.env[k]}`); winner[k] = 'your choice in the app'; }
} else {
    console.log('       (none — you are running this outside a build, so the files decide)');
}

const backend = config.resolveVisionBackend();
let chain = [];
try { chain = ai.getVisionProviderChain(); } catch (e) { console.log(`\n  chain error: ${e.message}`); }

const from = (k, fallback) => winner[k] ? `set by ${winner[k]}` : fallback;
console.log('\n  ─────────────────────────────────────────────────────────────');
console.log(`  Vision backend : ${backend}   (${from('VISION_BACKEND', 'built-in default')})`);
if (backend === 'bedrock') {
    console.log(`  THE JUDGE      : ${process.env.BEDROCK_VISION_CLAUDE_MODEL}`);
    console.log(`                   (${from('VISION_BEDROCK_PRIMARY_MODEL', 'built-in default in src/settings/config.js')})`);
} else {
    console.log(`  THE JUDGE      : ${chain[0] || '(none)'}`);
}
console.log(`  backups        : ${chain.slice(1).join(' → ') || '(none)'}`);
console.log('  ─────────────────────────────────────────────────────────────');
console.log('\n  Does that judge actually work on this account?');
console.log('     node scripts/bedrock-vision-probe.js     ← can we call it at all');
console.log('     node scripts/vision-judge-bench.js       ← does it judge footage well');
console.log('');
