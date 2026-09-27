#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the vision-backend switch (src/settings/config.js).
 *
 * A) THE BEDROCK OPTION NEVER ACTUALLY ROUTED TO CLAUDE (found 2026-08-04)
 *    resolveVisionBackend()'s 'bedrock' branch set VISION_EXCLUDE_QWEN=1 but left
 *    VISION_PROVIDER at whatever the .env carried — normally 'qwen', for the GPU box.
 *    Excluding qwen then dropped that value from the chain, so the PRIMARY judge slot
 *    silently fell through to the next entry in VISION_PROVIDER_ORDER (bedrock-qwen-vl).
 *    Picking "AWS Bedrock" in the UI therefore never once used Claude. The symptom is
 *    invisible — footage still gets scored, just by a different model than the one the
 *    setting names — so only a gate catches it.
 *
 * B) STACKING OVERRIDES ACROSS A LIVE SWITCH
 *    resolveVisionBackend() is re-runnable (the UI dropdown re-invokes it mid-session).
 *    It restores a raw .env snapshot, _RAW_VISION_ENV, before applying a backend — but
 *    only for keys LISTED in that snapshot. Any override a branch writes without a
 *    snapshot entry survives a switch away and contaminates the next backend. Check 1
 *    below enforces the general rule rather than one key, so a new override added later
 *    fails here instead of in a build.
 *
 * The behavioural checks read no fixed .env values: they compare against the baseline
 * this machine actually has, so the gate passes on any developer's configuration.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Pin the brain for this gate. `_getVisionChain()` inserts the azure-managed seat when
// AI_PROVIDER=azure-managed, so on a machine actually configured that way this file was
// asserting a chain shape the config never promised and failing for a reason that has
// nothing to do with the code under test. It already pins VISION_BACKEND; a gate that
// reads ambient config for the rest is testing the machine, not the software.
// Found 2026-08-29.
process.env.AI_PROVIDER = 'bedrock';


let failures = 0;
let checks = 0;
function check(label, fn) {
    checks++;
    try {
        fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

console.log('\n[vision-backend-routing] vision backend switch\n');

// Read config.js with LF endings no matter how git checked it out. Every structural
// regex below anchors on a bare newline, so on a CRLF working copy the resolver match
// simply returned null — and every check that reads resolverMatch then reported a parse
// failure instead of testing the code, including the anti-stacking rule that is the whole
// point of section 1. A gate that cannot find its subject is a gate that is off. Found
// 2026-08-28 adding the azure-managed backend: its four new overrides went unchecked.
const cfgSrc = fs.readFileSync(path.join(ROOT, 'src', 'settings', 'config.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');

// ── 1. Anti-stacking: every override a branch writes must be in the snapshot ──────────
const snapMatch = cfgSrc.match(/const _RAW_VISION_ENV = \{([\s\S]*?)\n\};/);
const resolverMatch = cfgSrc.match(/function resolveVisionBackend\(\) \{([\s\S]*?)\n\}\nresolveVisionBackend\(\);/);

check('_RAW_VISION_ENV and resolveVisionBackend() are both still present', () => {
    assert.ok(snapMatch, '_RAW_VISION_ENV object not found in config.js');
    assert.ok(resolverMatch, 'resolveVisionBackend() not found in config.js');
});

check('every env override written by a backend branch is in _RAW_VISION_ENV', () => {
    const snapshotKeys = new Set(
        Array.from(snapMatch[1].matchAll(/^\s*([A-Z0-9_]+):/gm)).map((m) => m[1])
    );
    const written = new Set(
        Array.from(resolverMatch[1].matchAll(/process\.env\.([A-Z0-9_]+)\s*=(?!=)/g)).map((m) => m[1])
    );
    assert.ok(written.size > 0, 'no overrides parsed — the regex has drifted from the source');
    const unsnapshotted = [...written].filter((k) => !snapshotKeys.has(k));
    assert.deepStrictEqual(unsnapshotted, [],
        `these overrides survive a backend switch and will stack: ${unsnapshotted.join(', ')}. `
        + 'Add each to _RAW_VISION_ENV so the raw .env value is restored.');
});

// ── 2. Bedrock mode scores on a PANEL and leaves Claude as the backstop ─────────────
//
// The two checks that used to live here demanded a reasoning-tier Claude DEFAULT for
// BEDROCK_VISION_CLAUDE_MODEL. That is the SUPERSEDED RULE described in the header
// above: the branch stopped writing a default on 2026-08-05, when scoring moved to the
// two-model panel and Claude went back to being the emergency backstop it is on every
// other path. The checks were never updated to match, and the CRLF bug fixed above meant
// nobody saw them fail. They are rewritten below, after the resolve, so they assert what
// the branch actually promises and a real regression fails here instead of a stale rule.

// ── 3. Behavioural: resolve for real and compare against THIS machine's baseline ──────
const config = require(path.join(ROOT, 'src', 'settings', 'config.js'));
const ai = require(path.join(ROOT, 'src', 'brain', 'ai-provider.js'));

// config.js resolves once at require time, so read the untouched baseline only after
// forcing a non-bedrock backend — that path restores the raw snapshot.
process.env.VISION_BACKEND = 'aws';
config.resolveVisionBackend();
const BASE = {
    provider: process.env.VISION_PROVIDER,
    claudeModel: process.env.BEDROCK_VISION_CLAUDE_MODEL,
    excludeQwen: process.env.VISION_EXCLUDE_QWEN,
};

process.env.VISION_BACKEND = 'bedrock';
config.resolveVisionBackend();

check('bedrock mode puts a Bedrock provider in the primary slot', () => {
    assert.match(String(process.env.VISION_PROVIDER || ''), /^bedrock/,
        `primary is "${process.env.VISION_PROVIDER}" — a non-Bedrock value here is dropped by `
        + 'VISION_EXCLUDE_QWEN, which hands the primary slot to whatever is next in the order');
});

check('bedrock mode judges footage with a panel, not one model', () => {
    assert.strictEqual(process.env.VISION_PANEL, '1',
        'bedrock mode must score on the two-model panel — no single model this account can '
        + 'call is both accurate and fast enough to judge alone');
    const judges = String(process.env.VISION_PANEL_JUDGES || '').split(',').filter(Boolean);
    assert.ok(judges.length >= 2,
        `the panel needs at least two judges to average — got [${judges.join(', ')}]`);
});

check('bedrock mode does not put a scarce-quota model in the chain primary slot', () => {
    // The descriptive chain (subject position, burned-in text, storyboard windows) is
    // high-volume and not evaluative, so its primary must be a high-RPM model. Promoting
    // Claude here is the 2026-08-05 regression: right answers that arrive at 4-16 frames
    // a minute lose to nearly-right ones that keep up.
    assert.ok(!/claude/i.test(String(process.env.VISION_PROVIDER || '')),
        `the chain primary is "${process.env.VISION_PROVIDER}" — Claude is the scarcest quota `
        + 'on this account and belongs at the tail, not in front of every descriptive call');
});

check('bedrock mode leaves the Claude tier alone unless explicitly told otherwise', () => {
    // The branch deliberately writes nothing here, so the .env value must stand untouched.
    // A default reappearing is the superseded reasoning-tier promotion coming back.
    const forced = process.env.VISION_BEDROCK_PRIMARY_MODEL;
    const expected = forced || BASE.claudeModel;
    assert.strictEqual(process.env.BEDROCK_VISION_CLAUDE_MODEL, expected);
});

check('an Anthropic primary is named by its cross-region inference-profile id', () => {
    // Reads the LIVE resolved value, not a source literal: the branch no longer writes a
    // default, so the old source-scrape matched nothing and threw on [1] of null before it
    // asserted anything at all.
    const def = String(process.env.BEDROCK_VISION_CLAUDE_MODEL || '');
    if (!/anthropic/i.test(def)) return; // a non-Anthropic default is judged elsewhere
    assert.match(def, /^[a-z]{2,3}\.anthropic\./,
        `"${def}" is a bare model id. Anthropic models on Bedrock are INFERENCE_PROFILE-only, `
        + "so a bare id fails with \"on-demand throughput isn't supported\" on every call and the "
        + 'chain quietly falls through to the next judge.');
});

check('the resolved chain leads with Bedrock and keeps a fallback behind it', () => {
    const chain = ai.getVisionProviderChain();
    assert.ok(Array.isArray(chain) && chain.length >= 2, `chain too short: ${JSON.stringify(chain)}`);
    assert.match(chain[0], /^bedrock/, `chain leads with "${chain[0]}"`);
    assert.ok(!chain.includes('qwen'), 'the self-hosted GPU box must not be in the Bedrock chain');
    assert.ok(new Set(chain).size === chain.length, `chain has duplicates: ${chain.join(',')}`);
});

check('switching back to the GPU box restores the raw .env baseline (no stacking)', () => {
    process.env.VISION_BACKEND = 'aws';
    config.resolveVisionBackend();
    assert.strictEqual(process.env.VISION_PROVIDER, BASE.provider, 'VISION_PROVIDER stacked');
    assert.strictEqual(process.env.BEDROCK_VISION_CLAUDE_MODEL, BASE.claudeModel,
        'BEDROCK_VISION_CLAUDE_MODEL stacked — the GPU-box chain would run the expensive '
        + 'primary-tier model on what is only its emergency fallback');
    assert.strictEqual(process.env.VISION_EXCLUDE_QWEN, BASE.excludeQwen,
        'VISION_EXCLUDE_QWEN stacked — the GPU box would stay excluded from its own backend');
});

check('re-selecting bedrock re-applies identically (idempotent)', () => {
    process.env.VISION_BACKEND = 'bedrock';
    config.resolveVisionBackend();
    const first = { p: process.env.VISION_PROVIDER, m: process.env.BEDROCK_VISION_CLAUDE_MODEL };
    config.resolveVisionBackend();
    assert.deepStrictEqual(
        { p: process.env.VISION_PROVIDER, m: process.env.BEDROCK_VISION_CLAUDE_MODEL }, first);
});

// ── 2b. Azure Managed Compute: the brain and the footage judge on ONE endpoint ────────
//
// 2026-08-27: picking "Azure Managed" in the AI Provider dropdown moved the TEXT brain
// only. Vision Backend was a separate setting still reading `lightning`, so the build
// spent five minutes on six doomed Lightning wake-ups ("all accounts exhausted") before
// dumping footage scoring onto a Bedrock account whose token is invalid — every scene a
// placeholder. The pairing is now explicit; this is the gate on it.
process.env.VISION_BACKEND = 'azure-managed';
config.resolveVisionBackend();

check('azure-managed vision leads with azure-managed, not a GPU box', () => {
    assert.strictEqual(process.env.VISION_PROVIDER, 'azure-managed',
        `primary is "${process.env.VISION_PROVIDER}" — the deployment must own seat 0`);
    assert.strictEqual(process.env.VISION_EXCLUDE_QWEN, '1',
        'there is no self-hosted/DashScope Qwen endpoint in this mode, so leaving qwen in '
        + 'the chain puts a dead URL in front of the live judge');
    assert.strictEqual(process.env.VISION_PANEL, '0',
        'the scoring panel is a Bedrock-only fix for Bedrock-only problems and must not '
        + 'follow you onto a path whose primary judge is a dedicated deployment');
});

check('azure-managed starts no GPU machine (that is the whole point)', () => {
    const gpu = require(path.join(ROOT, 'src', 'vision', 'vision-gpu.js'));
    assert.strictEqual(gpu.isConfigured(), false,
        'vision-gpu claims a machine to boot for azure-managed — that is the Lightning '
        + 'wake-up storm coming back');
});

check('the azure-managed chain still keeps a fallback behind it', () => {
    const chain = ai.getVisionProviderChain();
    assert.strictEqual(chain[0], 'azure-managed', `chain leads with ${chain[0]}`);
    assert.ok(chain.length > 1, 'no fallback behind the deployment');
});

check('AI_PROVIDER=azure-managed is the ONE value config.aiProvider honours', () => {
    // AI_PROVIDER is a decoy for every other value — config.aiProvider is pinned to
    // bedrock because the hybrid brains sit BESIDE it through their own task gates.
    // azure-managed REPLACES Bedrock, so _getTextRoute has to see it as primary. While
    // this was hardcoded, the dropdown option could never take effect: requests fell
    // through to the hybrid AZURE_OPENAI_TASK_TYPES gate and 401'd against the wrong
    // endpoint (2026-08-27 headless-build.log).
    const cfgPath = require.resolve(path.join(ROOT, 'src', 'settings', 'config.js'));
    const before = process.env.AI_PROVIDER;
    try {
        for (const [value, expected] of [['azure-managed', 'azure-managed'],
            ['bedrock', 'bedrock'], ['ollama', 'bedrock'], ['', 'bedrock']]) {
            process.env.AI_PROVIDER = value;
            delete require.cache[cfgPath];
            assert.strictEqual(require(cfgPath).aiProvider, expected,
                `AI_PROVIDER="${value}" should resolve config.aiProvider to "${expected}"`);
        }
    } finally {
        if (before === undefined) delete process.env.AI_PROVIDER;
        else process.env.AI_PROVIDER = before;
        delete require.cache[cfgPath];
        require(cfgPath);
    }
});

check('every AI Provider choice reaches the build child AND is locked', () => {
    // Two halves, both required. config.aiProvider reading AI_PROVIDER (checked above)
    // is useless if AI_PROVIDER never arrives: the schema marks aiProvider env:null, so
    // it is not in the settings loop and must be written explicitly.
    //
    // The LOCK half is the subtle one. Only keys in `own` reach YTA_ENV_LOCK, and only
    // locked keys survive the .env stack. applyBrainProvider() writes AI_PROVIDER into
    // the repo .env on every dropdown change, so a choice that is passed conditionally
    // — e.g. 'skip it when it equals the default' — leaves that default as the one value
    // a stale file can overrule: pick Azure Managed, switch back to Bedrock, and the
    // build keeps running on Azure while the UI says Bedrock.
    const buildEnv = require(path.join(ROOT, 'src', 'settings', 'build-env.js'));
    for (const pick of ['azure-managed', 'bedrock', undefined]) {
        const { env } = buildEnv.applyOptionsToEnv({ aiProvider: pick },
            { projectDir: path.join(ROOT, 'temp') });
        const expected = pick || 'bedrock';
        assert.strictEqual(env.AI_PROVIDER, expected,
            `UI picked ${JSON.stringify(pick)} but the child would see ` +
            `${JSON.stringify(env.AI_PROVIDER)}`);
        const locked = String(env[buildEnv.ENV_LOCK_VAR] || '').split(',');
        assert.ok(locked.includes('AI_PROVIDER'),
            `AI_PROVIDER is not in ${buildEnv.ENV_LOCK_VAR} for choice ` +
            `${JSON.stringify(pick)}, so a stale .env line still overrules the dropdown`);
    }
});

check('an azure-managed brain carries the vision backend with it', () => {
    // Azure Managed serves the reasoning model AND the footage judge from ONE endpoint,
    // so the two settings are not independent. ui/js/app.js pairs the dropdowns, but that
    // only fires when a human changes a <select> in the Electron app — a headless build,
    // or a project saved before the Vision Backend control existed, arrives with
    // visionBackend undefined. On 2026-08-29 that shipped a build whose whole text
    // surface ran on the Azure deployment while every frame was offered first to a
    // Lightning pool with no credits left, demoting the live judge to a fallback slot.
    // The derivation therefore has to live in applyOptionsToEnv, which BOTH entry
    // points call — not in the renderer.
    const buildEnv = require(path.join(ROOT, 'src', 'settings', 'build-env.js'));
    const run = (opts) => buildEnv.applyOptionsToEnv(opts, { projectDir: path.join(ROOT, 'temp') }).env;

    const derived = run({ aiProvider: 'azure-managed' });
    assert.strictEqual(derived.VISION_BACKEND, 'azure-managed',
        'an azure-managed brain with no saved vision choice must bring vision with it; '
        + `got ${JSON.stringify(derived.VISION_BACKEND)}`);
    assert.ok(String(derived[buildEnv.ENV_LOCK_VAR] || '').split(',').includes('VISION_BACKEND'),
        'the derived backend is not locked, so the repo .env can still overrule it');

    // A deliberate choice is not a blank to fill.
    assert.strictEqual(run({ aiProvider: 'azure-managed', visionBackend: 'lightning' }).VISION_BACKEND,
        'lightning', 'an explicit vision choice must survive the pairing');

    // And the pairing must not reach past its own brain. Assert on the LOCK, not the
    // value: applyOptionsToEnv returns the merged environment, so an ambient
    // VISION_BACKEND from the repo .env shows through legitimately. The lock list is what
    // says whether THIS build claimed the key.
    const bedrockEnv = run({ aiProvider: 'bedrock' });
    assert.ok(!String(bedrockEnv[buildEnv.ENV_LOCK_VAR] || '').split(',').includes('VISION_BACKEND'),
        'a bedrock brain claimed a vision backend it never asked for');
});

// ── 4. Verdicts stay versioned, so a judge change can be invalidated ──────────────────
check('the vision verdict cache folds its version into every key', () => {
    const cacheSrc = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'vision-cache.js'), 'utf8');
    const ver = cacheSrc.match(/const CACHE_VERSION = String\(process\.env\.VISION_CACHE_VERSION \|\| '([^']+)'\)/);
    assert.ok(ver && ver[1].trim(), 'CACHE_VERSION default missing — a judge change could not be invalidated');
    assert.match(cacheSrc, /return `\$\{CACHE_VERSION\}::\$\{kind\}::/,
        'the cache key no longer starts with CACHE_VERSION, so bumping it would not invalidate anything');
    assert.match(cacheSrc, /_scopeHash\(\{ cacheVersion: CACHE_VERSION/,
        'makeScope no longer folds CACHE_VERSION in');
});

// ── 5. The choice in the UI must actually reach the build child ───────────────────────
//
// THE DEFECT THIS LOCKS OUT (found 2026-08-04)
// The Vision Backend dropdown changed the app and nothing else. Two independent gaps:
//   a) its schema entry had env:null/build:null, so build-env.js never put it in the
//      child's environment at all; and
//   b) config.js loads the user-level .env with override:true, which replaced the
//      inherited value with whatever stale line that file happened to carry.
// The symptom is silent — footage still gets scored, just by the wrong judge — so a
// whole build ran on the backend the creator had switched away from, and only a
// line-by-line reading of the log caught it. Both gaps are checked here: (a) as a
// property of the schema, (b) by actually spawning a child against a planted user .env.

const { execFileSync } = require('child_process');
const os = require('os');
const { SETTINGS } = require(path.join(ROOT, 'src', 'settings', 'schema.js'));
const { applyOptionsToEnv, ENV_LOCK_VAR } = require(path.join(ROOT, 'src', 'settings', 'build-env.js'));

check('the Vision Backend setting is wired to reach the build child', () => {
    const s = SETTINGS.find((x) => x.key === 'visionBackend');
    assert.ok(s, 'the visionBackend setting has disappeared from the schema');
    assert.ok(s.env, 'visionBackend has no env var — the build child would never learn the choice');
    assert.ok(s.build, `visionBackend has build:${s.build} — build-env.js skips it, so the dropdown `
        + 'changes the app only and every build silently uses whatever the .env files say');
});

check('a picked backend lands in the child env and is declared non-overridable', () => {
    const { env } = applyOptionsToEnv(
        { visionBackend: 'bedrock' },
        { projectDir: path.join('X:', 'proj'), baseEnv: {} }
    );
    assert.strictEqual(env.VISION_BACKEND, 'bedrock', 'the child would not inherit the picked backend');
    const locked = String(env[ENV_LOCK_VAR] || '').split(',');
    assert.ok(locked.includes('VISION_BACKEND'),
        `${ENV_LOCK_VAR} does not list VISION_BACKEND, so a stale .env line can still overrule it`);
});

check('the lock is snapshotted before the .env loads and restored after all of them', () => {
    const iSnap = cfgSrc.indexOf('YTA_ENV_LOCK');
    const iRootLoad = cfgSrc.indexOf("require('dotenv').config({ path: appRootEnv");
    const iUserLoad = cfgSrc.indexOf('override: true');
    const iProject = cfgSrc.indexOf('PROJECT_OVERRIDE_KEYS.has(key)');
    const iRestore = cfgSrc.indexOf('for (const [key, value] of _lockedEnv)');
    assert.ok(iSnap > 0 && iRestore > 0, 'the build-choice lock is gone from config.js');
    assert.ok(iSnap < iRootLoad && iSnap < iUserLoad,
        'the snapshot is taken after a .env already loaded — it would capture the file value, not the choice');
    assert.ok(iRestore > iUserLoad && iRestore > iProject,
        'the restore runs before the last .env layer, so that layer still wins');
    assert.ok(iRestore < cfgSrc.indexOf('resolveVisionBackend();\n'),
        'the backend is resolved before the choice is restored — it would resolve the file value');
});

check('a live child ignores a stale user .env and honours the picked backend', () => {
    // The real proof: spawn a child exactly the way a build is spawned, with a user
    // .env planted to disagree. A control run without the lock must come back wrong,
    // otherwise this check proves nothing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-envlock-'));
    const stale = path.join(tmp, '.env');
    fs.writeFileSync(stale, 'VISION_BACKEND=lightning\n');
    const probe = `require(${JSON.stringify(path.join(ROOT, 'src', 'settings', 'config.js'))});`
        + `process.stdout.write('<<'+String(process.env.VISION_BACKEND)+'>>');`;
    const run = (extra) => {
        const env = { ...process.env, YTA_USER_ENV_PATH: stale, VISION_BACKEND: 'bedrock', ...extra };
        delete env.DOTENV_PATH;
        if (!extra || !extra[ENV_LOCK_VAR]) delete env[ENV_LOCK_VAR];
        const out = execFileSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
        return (out.match(/<<(.*?)>>/) || [])[1];
    };
    try {
        assert.strictEqual(run(null), 'lightning',
            'control run did not reproduce the clobber — this check can no longer detect it');
        assert.strictEqual(run({ [ENV_LOCK_VAR]: 'VISION_BACKEND' }), 'bedrock',
            'a stale line in the user .env still beat the backend this build chose');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
});

// ── 6. A dead primary judge must be loud, not silent ──────────────────────────────────
//
// THE DEFECT THIS LOCKS OUT (found 2026-08-04)
// The configured primary, us.anthropic.claude-sonnet-5, returned AccessDenied http=403
// on EVERY call — this account has no entitlement for it. callVisionAI logged one
// warning and fell through to the next provider, so on a build that scores ~2000 frames
// the failure was 2000 identical lines of scroll while the real judging quietly moved to
// a stand-in. Measured on 9 labelled real frames, that stand-in scored 0/3 on footage a
// human would use — which is exactly the "no footage, placeholder card" symptom the
// creator reported. Nothing in the log read like an error.
//
// The gate must do two things, and the SECOND one is the one that can go wrong quietly:
//   a) retire a provider that fails permanently (403 / bad id), once, loudly; and
//   b) NEVER retire one over a transient blip — an over-eager classifier that kills a
//      healthy judge on one timeout is a worse bug than the one it replaced.

check('a permanent entitlement failure is classified as permanent', () => {
    const cases = [
        Object.assign(new Error('is not available for this account'), { name: 'AccessDeniedException' }),
        new Error('Bedrock vision failed: AccessDeniedException http=403'),
        Object.assign(new Error('The provided model identifier is invalid'), { name: 'ValidationException' }),
        new Error("Invocation of model ID anthropic.claude-x with on-demand throughput isn't supported"),
    ];
    for (const err of cases) {
        assert.ok(ai.classifyVisionFailure(err),
            `"${err.message}" was treated as transient — the dead judge stays in the chain and `
            + 'every frame keeps paying a doomed roundtrip before the real score');
    }
});

check('a transient failure never retires a healthy judge', () => {
    const cases = [
        new Error('socket hang up'),
        Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' }),
        new Error('Bedrock vision failed: ServiceUnavailable http=503'),
        new Error('vision request timed out after 90000ms'),
        new Error('Empty vision response'),
        new Error('read ECONNRESET'),
    ];
    for (const err of cases) {
        assert.strictEqual(ai.classifyVisionFailure(err), null,
            `"${err.message}" would permanently retire the primary judge over a blip`);
    }
});

check('the vision chain skips providers proven dead, and never empties itself', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'brain', 'ai-provider.js'), 'utf8');
    assert.match(src, /_visionDead\.has\(p\)/,
        '_getVisionChain no longer drops dead providers — a 403 costs a wasted roundtrip per frame');
    assert.match(src, /if \(live\.length > 0\) return live;\s*\n\s*if \(chain\.length > 0\) return chain;/,
        'the dead-provider filter can now empty the chain. If every judge is dead the caller must '
        + 'still get the REAL error from a real call, not a synthetic "nothing available".');
    assert.match(src, /_markVisionProviderDead\(provider, permanent, i === 0\)/,
        'callVisionAI no longer flags permanent failures — they are silent again');
    assert.ok(typeof ai.getDeadVisionProviders === 'function'
        && Array.isArray(ai.getDeadVisionProviders()),
        'getDeadVisionProviders is gone — nothing can report which judge died');
});

console.log(`\n[vision-backend-routing] ${checks - failures}/${checks} checks passed`);
if (failures) {
    console.log(`[vision-backend-routing] FAILED — ${failures} check(s)\n`);
    process.exit(1);
}
console.log('[vision-backend-routing] OK\n');
