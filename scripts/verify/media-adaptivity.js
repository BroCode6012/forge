#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the two media-download fixes from the 2026-07-29 build
 * diagnosis. Both exist to serve one rule the user set out loud:
 *
 *   "every fix should be niche topic adaptable — the fix should touch the
 *    smartness of the media downloading agent, not a one niche solution."
 *
 * That rule bans TWO shapes, not one: no `if (niche === 'x')` anywhere, AND no
 * flat global constant either. A single number applied to every topic is a
 * one-niche solution wearing a disguise. So the checks below do not merely
 * assert "the module returns a number" — they assert the SAME code returns
 * DIFFERENT answers for different topics, driven by data that already exists.
 *
 * FIX 1 — ADAPTIVE DOWNLOAD PATIENCE (src/media/download-patience.js)
 *    The per-candidate timeout was one app-wide constant, and in the user's
 *    .env it was 0 = "wait forever". One slow pull could eat a whole scene, so
 *    every rescue rung behind it (simplified retries, niche fallback,
 *    controlled stock) found 2 seconds left and refused to run — 26 times in
 *    that build, alongside 34 deadline-grace extensions. Patience is now built
 *    from measured download cost x the topic's own ranking of that provider x
 *    the provider's live record, hard-clamped to a share of the scene's
 *    remaining time so the ladder behind it always has a real window.
 *
 * FIX 2 — A LADDER THAT ADVANCES AND LEARNS (src/media/provider-scoreboard.js
 *    + getSmartPriority in src/media/footage-manager.js)
 *    (a) The niche `footagePriority` post-filter was a hard ALLOWLIST. Since
 *        every one of the ~21 niches lists only `pexels, pixabay` for images,
 *        Brave was deleted from every topic in the app and was unreachable
 *        deterministically; Bing only survived via a hardcoded rescue line.
 *        A preference had become a capability ceiling. Now: demote, never
 *        delete. Real bans (excludeVideoProviders, the disabled list, the UI
 *        switch) still remove providers.
 *    (b) Nothing in the system noticed outcomes. Pixabay was opened 7 times and
 *        won 0 scenes; it still went first. The scoreboard is the in-run
 *        memory that fixes that, as a BOUNDED correction — the Media Agent
 *        keeps per-scene authority.
 *
 * No network, no AWS, no Electron. Pure module-level assertions.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
let checks = 0;
const pending = []; // async checks; the summary waits on these before exiting
function check(label, fn) {
    checks++;
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            pending.push(r.then(
                () => console.log(`  ✓ ${label}`),
                (err) => { failures++; console.log(`  ✗ ${label}\n      ${err.message}`); },
            ));
            return;
        }
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

// Env must not leak in from the developer's shell — these three vars are
// exactly what made Fix 1 a no-op in the first place.
delete process.env.FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS;
delete process.env.IMAGE_RACE_CANDIDATE_TIMEOUT_MS;
delete process.env.STORYBLOCKS_RACE_CANDIDATE_TIMEOUT_MS;

const patience = require(path.join(ROOT, 'src', 'media', 'download-patience.js'));
const scoreboard = require(path.join(ROOT, 'src', 'media', 'provider-scoreboard.js'));
const { getNiche } = require(path.join(ROOT, 'src', 'data', 'niches.js'));

const ms = (p) => p.ms;
const resolve = (opts) => patience.resolveCandidatePatienceMs(opts);

function freshState() {
    patience.reset();
    scoreboard.reset();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1/9] Fix 1 — patience is per-topic, not one global number');
// ─────────────────────────────────────────────────────────────────────────────

// The anchor pair is DERIVED, not hardcoded. Two topics qualify when they rank
// youtube and pexels in opposite orders. Deriving it means this gate keeps
// working when the niche data is re-tuned (it broke once already, when the six
// news.* niches were flipped to youtube-first) — and, more importantly, the
// derivation itself is the assertion: if no such pair exists, every topic wants
// the same thing and the per-topic mechanism has nothing to act on.
const { getNicheIds } = require(path.join(ROOT, 'src', 'data', 'niches.js'));
const _rank = (nicheId, provider) => {
    const order = (getNiche(nicheId)?.footagePriority?.video || []).map(p => String(p).toLowerCase());
    const i = order.indexOf(provider);
    return i < 0 ? Infinity : i;
};
let ANCHOR_YT = null;   // a topic that prefers youtube over pexels
let ANCHOR_STOCK = null; // a topic that prefers pexels over youtube
for (const id of getNicheIds()) {
    const yt = _rank(id, 'youtube');
    const px = _rank(id, 'pexels');
    if (!Number.isFinite(yt) || !Number.isFinite(px)) continue;
    if (!ANCHOR_YT && yt < px) ANCHOR_YT = id;
    if (!ANCHOR_STOCK && px < yt) ANCHOR_STOCK = id;
}

check('the niche data still disagrees about providers (or there is nothing to adapt to)', () => {
    assert.ok(ANCHOR_YT && ANCHOR_STOCK,
        `no two topics rank youtube and stock in opposite orders. Either niches.js has been `
        + `flattened to one universal ordering — in which case the per-topic patience mechanism `
        + `has nothing to act on and this whole fix is inert — or the providers were renamed. `
        + `Found: youtube-first=${ANCHOR_YT}, stock-first=${ANCHOR_STOCK}`);
    console.log(`      (anchors: ${ANCHOR_YT} prefers youtube, ${ANCHOR_STOCK} prefers stock)`);
});

check('the SAME provider gets different patience on different topics', () => {
    freshState();
    const a = ms(resolve({ mediaType: 'video', providerKey: 'youtube', nicheId: ANCHOR_YT }));
    const b = ms(resolve({ mediaType: 'video', providerKey: 'youtube', nicheId: ANCHOR_STOCK }));
    assert.ok(a > b,
        `youtube patience should be larger on the topic that ranks it higher: `
        + `${ANCHOR_YT}=${a}ms vs ${ANCHOR_STOCK}=${b}ms`);
});

check('and the preference flips with the topic', () => {
    freshState();
    const ytTopicYoutube = ms(resolve({ mediaType: 'video', providerKey: 'youtube', nicheId: ANCHOR_YT }));
    const ytTopicPexels = ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: ANCHOR_YT }));
    const stTopicYoutube = ms(resolve({ mediaType: 'video', providerKey: 'youtube', nicheId: ANCHOR_STOCK }));
    const stTopicPexels = ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: ANCHOR_STOCK }));
    assert.ok(ytTopicYoutube > ytTopicPexels,
        `on ${ANCHOR_YT} youtube(${ytTopicYoutube}) should beat pexels(${ytTopicPexels})`);
    assert.ok(stTopicPexels > stTopicYoutube,
        `on ${ANCHOR_STOCK} pexels(${stTopicPexels}) should beat youtube(${stTopicYoutube})`);
});

check('the ranking it reads is real data, not a table in this module', () => {
    // The whole point of "no hardcoding": the per-topic answer must come from
    // niches.js. Reordering a niche's footagePriority must change patience
    // without anyone touching download-patience.js.
    // Normalized to LF: the anchors below are bare newlines, which never match on a
    // CRLF working copy — the gate then reports its own subject as missing and the
    // `npm run verify` && chain aborts before every later check. Found 2026-08-28.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'media', 'download-patience.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(/getNiche\(nicheId\)\?\.footagePriority/.test(src),
        'patience must read the ranking from niches.js, not carry its own copy');

    // Scoped to the ranking function only. Elsewhere in the file a provider name
    // is legitimate — `_envOverride` reads the pre-existing
    // STORYBLOCKS_RACE_CANDIDATE_TIMEOUT_MS setting, which is a user-facing knob,
    // not a built-in preference. Inside _topicRank a provider literal WOULD be a
    // preference, and that is what must never appear.
    const fn = src.slice(src.indexOf('function _topicRank('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.length > 50 && body.length < 2000, 'could not isolate _topicRank body');
    const knownProviders = new Set();
    for (const id of getNicheIds()) {
        const n = getNiche(id)?.footagePriority || {};
        for (const list of [n.video, n.image]) {
            for (const p of (list || [])) knownProviders.add(String(p).toLowerCase());
        }
    }
    for (const provider of knownProviders) {
        assert.ok(!new RegExp(`['"]${provider}['"]`, 'i').test(body),
            `_topicRank names the provider "${provider}" — provider preferences belong in `
            + `niches.js, not baked into the mechanism`);
    }
});

check('no niche is hardcoded anywhere in either new module', () => {
    for (const f of ['download-patience.js', 'provider-scoreboard.js']) {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'media', f), 'utf8')
            .split(String.fromCharCode(13)).join('');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const offenders = code.match(/(nicheId|niche)\s*===\s*['"]/g) || [];
        assert.strictEqual(offenders.length, 0,
            `${f} branches on a specific niche: ${offenders.join(', ')}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2/9] Fix 1 — the scene-share clamp keeps the rescue ladder alive');
// ─────────────────────────────────────────────────────────────────────────────

check('one candidate can never eat the whole scene budget', () => {
    freshState();
    // THE AUG-5 CORRECTION. This check used to assert the share clamp flatly,
    // with a hardcoded 40s. But reserving 45% of the clock for a rescue rung
    // only protects the scene while that rung can itself finish. Below the
    // measured one-candidate minimum the reservation protects nothing and the
    // budget in front of it is a scheduled loss — that is how YouTube got 56s
    // against a ~60s minimum on scene after scene and won nothing all build.
    //
    // So the rule has two halves, and both are checked here. The line between
    // them is measured, not written down, so this test derives it instead of
    // naming a number.
    const minViable = resolve({
        mediaType: 'video', providerKey: 'youtube', nicheId: 'explainer.diy',
    }).minViableMs;

    // (i) While a share still buys a whole candidate, the share is the cap.
    const roomy = Math.ceil((minViable / patience.MAX_SCENE_SHARE) * 1.5);
    const shared = resolve({
        mediaType: 'video', providerKey: 'youtube', nicheId: 'explainer.diy',
        remainingSceneMs: roomy,
    });
    assert.ok(shared.ms <= Math.ceil(roomy * patience.MAX_SCENE_SHARE),
        `patience ${shared.ms}ms exceeds ${patience.MAX_SCENE_SHARE * 100}% of the ${roomy}ms left`);
    assert.ok(roomy - shared.ms >= minViable,
        `only ${roomy - shared.ms}ms would be left, less than the ${minViable}ms a rescue rung needs to finish`);
    assert.strictEqual(shared.lastChance, false, 'the share was still affordable — this is not a last chance');

    // (ii) Once it does not, the scene has room for exactly one real attempt,
    // and the honest move is to spend what is left on it rather than hand out a
    // budget the module has already computed to be too short to reach a verdict.
    const tight = Math.round(minViable * 1.2);
    const last = resolve({
        mediaType: 'video', providerKey: 'youtube', nicheId: 'explainer.diy',
        remainingSceneMs: tight,
    });
    assert.strictEqual(last.lastChance, true,
        'the scene-share clamp is back to cutting below the one-candidate minimum');
    assert.ok(last.ms <= tight, `last-chance budget ${last.ms}ms exceeds the ${tight}ms the scene has left`);
    assert.ok(last.ms >= Math.min(tight, minViable),
        `last-chance budget ${last.ms}ms is under the ${minViable}ms needed to reach a verdict`);
});

check('the clamp only bites when the scene is actually short on time', () => {
    freshState();
    const roomy = ms(resolve({
        mediaType: 'video', providerKey: 'youtube', nicheId: 'explainer.diy',
        remainingSceneMs: 600_000,
    }));
    const unbounded = ms(resolve({
        mediaType: 'video', providerKey: 'youtube', nicheId: 'explainer.diy',
    }));
    assert.strictEqual(roomy, unbounded,
        `a scene with 10 minutes left should not be clamped (${roomy} vs ${unbounded})`);
});

check('patience always stays inside the sanity rails', () => {
    freshState();
    for (const mediaType of ['video', 'image']) {
        for (const nicheId of ['explainer.diy', 'news.politics', 'explainer.nature', undefined]) {
            for (const providerKey of ['youtube', 'pexels', 'pixabay', 'brave', 'bing', 'reddit', 'storyblocks']) {
                const got = ms(resolve({ mediaType, providerKey, nicheId }));
                assert.ok(got >= patience.FLOOR_MS[mediaType] && got <= patience.CEILING_MS[mediaType],
                    `${mediaType}/${nicheId}/${providerKey} = ${got}ms is outside `
                    + `[${patience.FLOOR_MS[mediaType]}, ${patience.CEILING_MS[mediaType]}]`);
            }
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3/9] Fix 1 — it learns from this run, and env still wins');
// ─────────────────────────────────────────────────────────────────────────────

check('a provider that downloads fast stops being given the bootstrap timeout', () => {
    freshState();
    const before = ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: 'explainer.diy' }));
    for (let i = 0; i < 6; i++) {
        patience.recordDownload({ mediaType: 'video', providerKey: 'pexels', ms: 6_000 });
    }
    const after = ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: 'explainer.diy' }));
    assert.ok(after < before, `measured-fast provider should shrink: ${before}ms -> ${after}ms`);
});

check('a provider with a genuinely slow tail is not strangled', () => {
    freshState();
    // Mostly quick, but this provider really does take 50s sometimes. Patience
    // must stay above the slowest download we have actually SEEN succeed,
    // otherwise we would start killing working downloads — the opposite of the
    // "zero not-found scenes" goal.
    const observed = [5_000, 6_000, 6_500, 7_000, 50_000];
    observed.forEach(d => patience.recordDownload({ mediaType: 'video', providerKey: 'youtube', ms: d }));
    const got = ms(resolve({ mediaType: 'video', providerKey: 'youtube', nicheId: 'explainer.diy' }));
    assert.ok(got >= Math.max(...observed),
        `patience ${got}ms is below the slowest successful download seen (${Math.max(...observed)}ms)`);
});

check('failures are NOT sampled (a stall must not inflate patience forever)', () => {
    freshState();
    const src = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(/_assertDownloadedFile[\s\S]{0,900}?downloadPatience\.recordDownload/.test(src),
        'recordDownload must be called only after the download is asserted good');
});

check('env: empty means adaptive, a number means fixed, 0 means disabled', () => {
    freshState();
    const adaptive = ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: 'explainer.diy' }));

    process.env.FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS = '';
    assert.strictEqual(ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: 'explainer.diy' })), adaptive,
        'an empty env var must behave exactly like an unset one');

    process.env.FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS = '90000';
    assert.strictEqual(ms(resolve({ mediaType: 'video', providerKey: 'pexels', nicheId: 'explainer.diy' })), 90_000,
        'an explicit number must be honoured verbatim (back-compat)');

    process.env.FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS = '0';
    const lines = [];
    const off = resolve({
        mediaType: 'video', providerKey: 'pexels', nicheId: 'explainer.diy',
        log: (m) => lines.push(m),
    });
    assert.strictEqual(off.ms, 0, '0 must still mean "no per-candidate cap"');
    assert.strictEqual(off.disabled, true, '0 must be reported as disabled');
    assert.ok(lines.some(l => /DISABLED/.test(l)),
        'disabling patience must warn loudly — this is the setting that swallowed whole scenes');

    delete process.env.FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS;
});

// The Aug-1 build ran with patience DISABLED while this gate reported green.
// The reason: it read the repo .env and nothing else. config.js loads a SECOND
// .env — the per-user one under the Electron userData dir — and loads it with
// `override: true`, so it BEATS the repo file. Cleaning the repo .env therefore
// proves nothing about what a build actually runs with. Checking one layer of a
// three-layer stack is not a gate; it is a false green.
const PATIENCE_ENV_KEYS = [
    'FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS',
    'IMAGE_RACE_CANDIDATE_TIMEOUT_MS',
    'STORYBLOCKS_RACE_CANDIDATE_TIMEOUT_MS',
];

// Mirror of Electron's app.getPath('userData'), computed without Electron so
// this stays a pure-Node gate. main.js: USER_ENV_PATH = <userData>/.env.
function _electronUserDataDir() {
    const os = require('os');
    const pkg = require(path.join(ROOT, 'package.json'));
    const appName = pkg.productName || pkg.name;
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', appName);
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

// Every .env a real build reads, weakest first. The last one wins.
function _envLayers() {
    const repo = path.join(ROOT, '.env');
    const user = process.env.YTA_USER_ENV_PATH
        ? path.resolve(process.env.YTA_USER_ENV_PATH)
        : path.join(_electronUserDataDir(), '.env');
    const layers = [{ label: 'repo .env', file: repo }];
    if (path.resolve(user) !== path.resolve(repo)) {
        layers.push({ label: 'user .env (config.js loads this with override:true — it WINS)', file: user });
    }
    return layers;
}

// Read the value the way dotenv and download-patience.js actually read it,
// instead of pattern-matching the raw line. An earlier version of this check
// only rejected a line ENDING in `= 0`, which let three spellings of the same
// disaster through: `=0  # off` (dotenv strips the inline comment and hands back
// 0), `="0"` (dotenv strips the quotes), and `=-1` (parseInt gives -1, and the
// runtime disables patience on ANY value <= 0, not just zero).
function _parseEnvValue(line) {
    let v = line.slice(line.indexOf('=') + 1).trim();
    const quoted = /^(['"])([\s\S]*?)\1/.exec(v);
    if (quoted) return quoted[2].trim();
    v = v.split(/\s+#/)[0];          // dotenv drops inline comments on unquoted values
    return v.trim();
}

check('no .env layer on this machine is forcing 0 (repo AND user-level)', () => {
    const layers = _envLayers();
    const seen = [];
    for (const layer of layers) {
        if (!fs.existsSync(layer.file)) continue;   // fresh clone / CI — nothing to check
        seen.push(layer.label);
        const raw = fs.readFileSync(layer.file, 'utf8')
            .split(String.fromCharCode(13)).join('');
        for (const name of PATIENCE_ENV_KEYS) {
            const active = raw.split(/\r?\n/).filter(l => new RegExp(`^\\s*${name}\\s*=`).test(l));
            for (const line of active) {
                const value = _parseEnvValue(line);
                if (value === '') continue;   // empty is the adaptive default — the whole point
                const n = parseInt(value, 10);
                if (!Number.isFinite(n)) continue;  // unparseable is ignored by the runtime too
                assert.ok(n > 0,
                    `${name} resolves to ${n} in the ${layer.label} (${layer.file}) — any value <= 0 `
                    + `disables per-download patience and lets one slow download starve the whole `
                    + `rescue ladder. Leave it empty for adaptive.`);
            }
        }
    }
    console.log(`      (layers checked: ${seen.length ? seen.join(' + ') : 'none present'})`);
});

check('this gate still covers every .env layer config.js loads', () => {
    // If someone adds a fourth layer, or makes the project .env able to carry
    // these keys, the check above silently goes back to being a false green.
    // Fail loudly instead of letting that happen quietly.
    const cfg = fs.readFileSync(path.join(ROOT, 'src', 'settings', 'config.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    const head = cfg.slice(0, cfg.indexOf('const PROJECT_DIR'));
    const dotenvLoads = (head.match(/require\(['"]dotenv['"]\)\.config\(/g) || []).length;
    assert.strictEqual(dotenvLoads, 2,
        `config.js now performs ${dotenvLoads} dotenv.config() loads, not the 2 this gate mirrors `
        + `(repo .env, then YTA_USER_ENV_PATH with override:true). Teach _envLayers() the new one.`);
    assert.ok(/YTA_USER_ENV_PATH/.test(head) && /override:\s*true/.test(head),
        'the user-level override layer disappeared from config.js — _envLayers() is now describing '
        + 'a stack that no longer exists');

    // The third layer (the project .env) is key-filtered: it can only set keys in
    // PROJECT_OVERRIDE_KEYS. None of the patience keys are in that set, which is
    // the only reason this gate can ignore per-project files it cannot enumerate.
    const projectKeys = new Set([
        ...require(path.join(ROOT, 'src', 'settings', 'schema.js')).projectEnvVars(),
    ]);
    const operational = (head.match(/const OPERATIONAL_OVERRIDE_KEYS = \[([\s\S]*?)\]/) || [, ''])[1];
    for (const name of PATIENCE_ENV_KEYS) {
        assert.ok(!projectKeys.has(name) && !operational.includes(name),
            `${name} became project-overridable. A project .env can now disable patience and this `
            + `gate cannot see it — either drop it from the override set, or make the runtime refuse `
            + `a non-positive value instead of trusting the file.`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4/9] Fix 2a — topic preference demotes, it does not delete');
// ─────────────────────────────────────────────────────────────────────────────

const footage = require(path.join(ROOT, 'src', 'media', 'footage-manager.js'));
const getSmartPriority = footage._getSmartPriority;

check('getSmartPriority is reachable for verification', () => {
    assert.strictEqual(typeof getSmartPriority, 'function',
        'footage-manager must export _getSmartPriority so this gate can assert on real output');
});

check('a provider no niche lists is still reachable on every topic', () => {
    // Every niche lists only pexels+pixabay for images. Under the old allowlist
    // that deleted brave from all ~21 topics, permanently.
    const NICHES = ['explainer.diy', 'explainer.nature', 'explainer.crime', 'news.politics', 'news.military'];
    for (const nicheId of NICHES) {
        const order = getSmartPriority(null, 'image', { nicheId });
        assert.ok(order.includes('brave'),
            `brave was deleted from the image ladder on ${nicheId} — a preference must not become a ban. Got: ${order.join(' > ')}`);
    }
});

check('but the topic still gets what it asked for, first', () => {
    const order = getSmartPriority(null, 'video', { nicheId: 'explainer.diy' });
    const declared = (getNiche('explainer.diy').footagePriority.video || []).map(String);
    assert.deepStrictEqual(order.slice(0, declared.length), declared,
        `the topic's declared order must still lead. Declared ${declared.join(' > ')}, got ${order.join(' > ')}`);
});

check('real bans still delete', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    const body = src.slice(src.indexOf('function getSmartPriority'), src.indexOf('// ============ PROVIDER MANAGEMENT'));
    assert.ok(/excludeVideoProviders[\s\S]{0,300}?order\.filter\(p => !excluded\.has\(p\)\)/.test(body),
        'niche excludeVideoProviders must still remove providers outright');
    assert.ok(/order\.filter\(p => !DISABLED_VIDEO_PROVIDER_KEYS\.has\(p\)\)/.test(body),
        'the disabled-provider list must still remove providers outright');
});

check('the hardcoded bing rescue is gone (it is no longer needed)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(!/allowedSet\.add\(\s*['"]bing['"]\s*\)/.test(src),
        'a per-provider hardcoded rescue is exactly the one-niche shape this fix removes');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5/9] Fix 2b — the scoreboard learns, but stays bounded');
// ─────────────────────────────────────────────────────────────────────────────

check('an unproven provider sits at neutral, so one coin flip changes nothing', () => {
    freshState();
    assert.strictEqual(scoreboard.winRate('video', 'reddit'), 0.5,
        'a provider with no record must be neutral (Laplace smoothing)');
    scoreboard.recordOpen('video', 'reddit');
    scoreboard.recordLoss('video', 'reddit', 'one bad scene');
    const order = ['reddit', 'pexels', 'youtube'];
    const out = scoreboard.adjustOrder(order, 'video');
    assert.deepStrictEqual(out.order, order, 'one loss is noise and must not reorder the build');
    assert.strictEqual(out.moved.length, 0);
});

check('a provider that keeps losing sinks; one that keeps winning rises', () => {
    freshState();
    for (let i = 0; i < 6; i++) {
        scoreboard.recordOpen('video', 'pixabay');
        scoreboard.recordLoss('video', 'pixabay', 'no usable candidate');
        scoreboard.recordOpen('video', 'pexels');
        scoreboard.recordWin('video', 'pexels');
    }
    const out = scoreboard.adjustOrder(['pixabay', 'pexels', 'youtube', 'reddit'], 'video');
    assert.ok(out.order.indexOf('pexels') < out.order.indexOf('pixabay'),
        `the 6-for-6 provider must outrank the 0-for-6 one. Got ${out.order.join(' > ')}`);
    assert.ok(out.moved.length > 0, 'a real re-rank must be reported so the log explains itself');
});

check('nothing moves more than MAX_SHIFT places (the Media Agent stays the authority)', () => {
    freshState();
    for (let i = 0; i < 8; i++) {
        scoreboard.recordOpen('video', 'pixabay');
        scoreboard.recordLoss('video', 'pixabay', 'dud');
    }
    for (const p of ['pexels', 'youtube', 'reddit', 'bing']) {
        for (let i = 0; i < 8; i++) {
            scoreboard.recordOpen('video', p);
            scoreboard.recordWin('video', p);
        }
    }
    const input = ['pixabay', 'pexels', 'youtube', 'reddit', 'bing'];
    const out = scoreboard.adjustOrder(input, 'video');
    input.forEach((p, from) => {
        const to = out.order.indexOf(p);
        assert.ok(Math.abs(to - from) <= scoreboard.MAX_SHIFT,
            `${p} moved ${Math.abs(to - from)} places (max ${scoreboard.MAX_SHIFT}): ${input.join(' > ')} -> ${out.order.join(' > ')}`);
    });
});

check('no provider is ever dropped — the result is always a permutation', () => {
    freshState();
    for (let i = 0; i < 9; i++) {
        scoreboard.recordOpen('image', 'pexels');
        scoreboard.recordLoss('image', 'pexels', 'dud');
    }
    const input = ['pexels', 'pixabay', 'bing', 'brave'];
    const out = scoreboard.adjustOrder(input, 'image');
    assert.deepStrictEqual([...out.order].sort(), [...input].sort(),
        `the scoreboard must never ban a provider. ${input.join(' > ')} -> ${out.order.join(' > ')}`);
});

check('the scoreboard is per-run memory, not a persisted file', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'media', 'provider-scoreboard.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(!/require\(['"]fs['"]\)/.test(src),
        'evidence learned on one topic must not silently steer the next build');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6/9] Both fixes are actually wired into the download path');
// ─────────────────────────────────────────────────────────────────────────────

const FM = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');

check('footage-manager requires both new modules', () => {
    assert.ok(/require\(['"]\.\/provider-scoreboard['"]\)/.test(FM), 'provider-scoreboard not required');
    assert.ok(/require\(['"]\.\/download-patience['"]\)/.test(FM), 'download-patience not required');
});

check('the race timeout comes from adaptive patience, not a constant', () => {
    assert.ok(/racePerCandidateTimeoutMs\s*=\s*patience\.ms/.test(FM),
        'the per-candidate race timeout must be resolved through download-patience');
    // The live clock must be an INPUT, not a constant. It may be floored by the
    // in-flight grace (a race that has already started downloading gets its
    // protected window counted as time it still has), but the reading itself has
    // to come from remainingMs() or the clamp is measuring nothing.
    const arg = (FM.match(/resolveCandidatePatienceMs\(\{[\s\S]{0,400}?\n\s*\}\)/) || [])[0] || '';
    const line = (arg.match(/remainingSceneMs:[^\n]*/) || [])[0] || '';
    assert.ok(/remainingMs\(\)/.test(line),
        `the scene clamp only works if the live remaining scene time is passed in (got: ${line.trim() || 'nothing'})`);
    assert.ok(!/remainingSceneMs:\s*\d/.test(line),
        `the remaining scene time is a hardcoded number (${line.trim()})`);
    assert.ok(/resolveCandidatePatienceMs\(\{[\s\S]{0,400}?nicheId:\s*scriptContextRef\?\.nicheId/.test(FM),
        'the topic is what makes it per-niche — it must be passed in');
});

check('the ladder records opens, wins and losses', () => {
    assert.ok(/providerScoreboard\.recordOpen\(/.test(FM), 'opens are not recorded');
    assert.ok(/providerScoreboard\.recordWin\(/.test(FM), 'wins are not recorded');
    assert.ok(/providerScoreboard\.recordLoss\(/.test(FM), 'losses are not recorded');
});

check('the ladder says out loud which providers it never opened', () => {
    assert.ok(/\[Provider Ladder\][\s\S]{0,200}?Never opened/.test(FM),
        'silent early exits are how "0 footage found" stayed invisible for 8 scenes');
    assert.ok(/const bailOut = \(why\)/.test(FM), 'every early return from the ladder must go through bailOut');
});

check('the scoreboard is applied to the resolved order before the ladder runs', () => {
    assert.ok(/providerScoreboard\.adjustOrder\(priorityOrder,\s*mediaType\)/.test(FM),
        'the learned order is never applied');
    assert.ok(/\[Provider Scoreboard\]/.test(FM),
        'a re-rank must be logged, so a build log explains its own ordering');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7/9] Fix 3 — a dud is never recorded as a win, and there is a road back');
// ─────────────────────────────────────────────────────────────────────────────
//
// The Jul-29 build printed "Final media audit: 0 missing scenes" seven minutes
// after eight scenes lost their visual. Every one of the three causes was
// invisible to a DIFFERENT check, which is why one shared classifier now owns
// the answer — the audit and the rescue physically cannot disagree.

const coverage = require(path.join(ROOT, 'src', 'media', 'scene-coverage.js'));
const rescue = require(path.join(ROOT, 'src', 'media', 'coverage-rescue.js'));
const BV = fs.readFileSync(path.join(ROOT, 'src', 'pipeline', 'build-video.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');

const sc = (over = {}) => ({ index: 1, startTime: 10, endTime: 20, ...over });

check('a placeholder card is NOT counted as covered', () => {
    // It has a mediaFile, which is exactly why every `!scene.mediaFile` test in
    // the codebase called it solved.
    const v = coverage.classifyScene(sc({
        mediaFile: '/tmp/scene-1.png',
        mediaDownloadStatus: 'agenticGraphicFallback',
        sourceProvider: 'Agentic Visual Fallback',
    }));
    assert.equal(v.covered, false, 'a give-up card must never read as coverage');
    assert.equal(v.kind, 'placeholder');
});

check('real footage IS counted as covered', () => {
    const v = coverage.classifyScene(sc({ mediaFile: '/tmp/scene-1.mp4', sourceProvider: 'YouTube' }));
    assert.equal(v.covered, true);
    assert.equal(v.kind, 'footage');
});

check('a scene whose fullscreen graphic was disabled is found, not hidden by its own flag', () => {
    const scene = sc({ fullscreenMG: 'statCard: 40%' });
    // The graphic exists but was disabled after Step 5 — the exact sequence that
    // orphaned six scenes.
    const withDisabled = coverage.classifyScene(scene, {
        graphics: [{ type: 'statCard', startTime: 10, endTime: 20, disabled: true }],
    });
    assert.equal(withDisabled.covered, false, 'a disabled graphic must not count as coverage');
    assert.equal(withDisabled.kind, 'orphaned-graphic');
    // Same scene, graphic alive -> covered. The flag is not what decides it.
    const withLive = coverage.classifyScene(scene, {
        graphics: [{ type: 'statCard', startTime: 10, endTime: 20 }],
    });
    assert.equal(withLive.covered, true);
    assert.equal(withLive.kind, 'graphic-owner');
});

check('a graphic that only covers part of the scene does not count', () => {
    const v = coverage.classifyScene(sc({ fullscreenMG: 'quoteCard' }), {
        graphics: [{ type: 'quoteCard', startTime: 10, endTime: 14 }], // 4s of a 10s scene
    });
    assert.equal(v.covered, false, '6 seconds of blank is still blank');
});

check('a skipped lane that nothing filled is found', () => {
    const v = coverage.classifyScene(sc({ mediaIntent: { lane: 'templateBackground', policy: { download: 'skip' } } }));
    assert.equal(v.covered, false);
    assert.equal(v.kind, 'skipped-lane');
});

check('the old audit shape would have missed all three (proof the gate is worth having)', () => {
    const scenes = [
        sc({ index: 1, mediaFile: '/tmp/a.png', mediaDownloadStatus: 'agenticGraphicFallback' }),
        sc({ index: 2, fullscreenMG: 'statCard: 40%' }),
        sc({ index: 3, mediaIntent: { lane: 'templateBackground', policy: { download: 'skip' } } }),
    ];
    const oldAudit = scenes.filter(s => !s.mediaFile && !s.isMGScene && !s.fullscreenMG);
    const now = coverage.findUncovered(scenes, { graphics: [] });
    assert.equal(oldAudit.length, 1, 'sanity: the old shape only ever saw the third one');
    assert.equal(now.length, 3, 'the classifier must see all three');
});

check('the pipeline audit and the rescue read the SAME module', () => {
    assert.ok(/require\(['"]\.\.\/media\/coverage-rescue['"]\)/.test(BV),
        'build-video must call the coverage rescue');
    assert.ok(/require\(['"]\.\.\/media\/scene-coverage['"]\)/.test(BV),
        'build-video must report coverage through the shared classifier');
    const rescueSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'coverage-rescue.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(/require\(['"]\.\/scene-coverage['"]\)/.test(rescueSrc),
        'the rescue must classify with the same module the audit reports from');
    assert.ok(!/!\s*scene\.mediaFile\s*&&\s*!scene\.isMGScene\s*&&\s*!scene\.fullscreenMG/.test(BV),
        'the old blind audit shape is back in build-video');
});

check('the give-up card never paints its engineering reason into the video', () => {
    // "scene download timed out after 15.2 min" was rendered on screen, in the
    // finished video, five times.
    const fmSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    const start = fmSrc.indexOf('function createAgenticGraphicFallback');
    assert.ok(start > 0, 'createAgenticGraphicFallback not found');
    const body = fmSrc.slice(start, start + 6000);
    const chips = body.match(/const chips = \[[\s\S]{0,400}?\]/);
    assert.ok(chips, 'could not locate the on-card chip list');
    assert.ok(!/\breason\b/.test(chips[0]),
        'the failure reason is being drawn onto the card again — it belongs in the log, not the video');
});

check('every fallback site records a placeholder, not an acceptance', () => {
    const fmSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    // There are two — the exhausted-providers path and the scene-timeout path.
    // Both recorded 'accepted'; that is the bug that made the failure a win.
    const sites = [...fmSrc.matchAll(/key:\s*'agentic-visual-fallback'/g)];
    assert.ok(sites.length >= 2, `expected both fallback record sites (found ${sites.length})`);
    for (const site of sites) {
        const block = fmSrc.slice(site.index, site.index + 1200);
        const status = block.match(/^\s*status:\s*'([a-zA-Z]+)'/m);
        assert.ok(status, 'a fallback record site has no status field');
        assert.equal(status[1], 'placeholder',
            `a give-up card is being recorded as '${status[1]}' — that is the original bug`);
    }
});

check('placeholders are excluded from the readiness count', () => {
    const fmSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    const line = fmSrc.match(/const readyBeforeContinuity\s*=[\s\S]{0,400}?;/);
    assert.ok(line, 'readiness math not found');
    assert.ok(!/agenticGraphicFallback/.test(line[0]),
        'counting the give-up card as ready is how a build reported 100% while shipping blanks');
    assert.ok(!/agenticGraphicFallback/.test((BV.match(/const providerReady\s*=[\s\S]{0,400}?;/) || [''])[0]),
        'the pipeline "Media truth" line must not count placeholders as ready either');
});

check('the rescue budget is measured, not a constant', () => {
    const rescueSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'coverage-rescue.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(/resolveCandidatePatienceMs/.test(rescueSrc),
        'the rescue must take its time budget from the adaptive patience this run measured');
    // And it must actually MOVE when the run's measurements move. Same scene,
    // same topic — only the observed download cost differs.
    freshState();
    const scene = { mediaType: 'video', startTime: 0, endTime: 8 };
    const fast = rescue._sceneBudgetMs(scene, ANCHOR_YT);
    for (let i = 0; i < 8; i++) patience.recordDownload({ mediaType: 'video', providerKey: 'youtube', ms: 90_000 });
    const slow = rescue._sceneBudgetMs(scene, ANCHOR_YT);
    assert.ok(slow > fast,
        `a run where downloads measured slower must earn a longer rescue budget (${fast}ms -> ${slow}ms)`);
    assert.ok(slow <= rescue.SCENE_BUDGET_CEILING_MS, 'the budget must stay inside its rail');
    freshState();
});

check('the rescue opens every source — the locked lane is what failed', () => {
    const scene = sc({
        keyword: 'root cellar',
        mediaIntent: {
            lane: 'webImage',
            policy: { download: 'skip', allowedSources: ['bing'], allowedSourcesByType: { image: ['bing'] } },
        },
    });
    rescue._prepareForRescue(scene, 'skipped-lane');
    assert.equal(scene.mediaIntent.policy.download, 'require');
    assert.equal(scene.mediaIntent.policy.allowedSources, undefined, 'the failed lane must not still be locked');
    assert.equal(scene.mediaIntent.policy.allowedSourcesByType, undefined);
});

check('a rescued orphan loses the graphic marker that would hide its footage', () => {
    const scene = sc({ fullscreenMG: 'statCard: 40%', keyword: 'stock market floor' });
    rescue._prepareForRescue(scene, 'orphaned-graphic');
    assert.ok(!scene.fullscreenMG,
        'leaving the marker set means framing and the V1 carve keep skipping the scene, so the footage never shows');
});

check('a map scene keeps its lane — a rescue must not put a stock photo where a map goes', () => {
    const scene = sc({ keyword: 'ukraine', mediaIntent: { lane: 'mapImage', policy: { download: 'skip', allowedSources: ['map'] } } });
    rescue._prepareForRescue(scene, 'skipped-lane');
    assert.equal(scene.mediaIntent.lane, 'mapImage');
    assert.deepEqual(scene.mediaIntent.policy.allowedSources, ['map']);
});

check('a scene with no searchable subject is left alone, not filled with something arbitrary', () => {
    const scene = sc({ fullscreenMG: 'quoteCard' }); // no keyword, no text, no queries
    const before = JSON.stringify(scene);
    const restore = rescue._prepareForRescue(scene, 'orphaned-graphic');
    assert.equal(restore, null, 'no subject must mean no rescue');
    assert.equal(JSON.stringify(scene), before, 'and the scene must be left exactly as found');
});

check('a failed rescue puts the placeholder back — no scene ends up worse off', async () => {
    const scene = sc({
        index: 4, keyword: 'root cellar',
        mediaFile: '/tmp/scene-4.png', mediaExtension: '.png',
        mediaDownloadStatus: 'agenticGraphicFallback', sourceProvider: 'Agentic Visual Fallback',
    });
    const snapshot = JSON.stringify(scene);
    const result = await rescue.rescueUncovered({
        scenes: [scene], graphics: [], scriptContext: {}, nicheId: ANCHOR_YT,
        downloadAllMedia: async (list) => ({ scenes: list, stats: {} }), // finds nothing
        log: () => {},
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.rescued, 0);
    assert.equal(JSON.stringify(scene), snapshot, 'the original placeholder must be restored byte for byte');
});

check('a successful rescue is reported as footage, by the same classifier', async () => {
    const scene = sc({
        index: 5, keyword: 'root cellar',
        mediaFile: '/tmp/scene-5.png', mediaDownloadStatus: 'agenticGraphicFallback',
        sourceProvider: 'Agentic Visual Fallback',
    });
    const result = await rescue.rescueUncovered({
        scenes: [scene], graphics: [], scriptContext: {}, nicheId: ANCHOR_YT,
        downloadAllMedia: async (list) => {
            for (const s of list) {
                s.mediaFile = '/tmp/scene-5.mp4';
                s.mediaExtension = '.mp4';
                s.sourceProvider = 'YouTube';
                s.mediaDownloadStatus = 'directAccepted';
            }
            return { scenes: list, stats: {} };
        },
        log: () => {},
    });
    assert.equal(result.rescued, 1);
    assert.equal(coverage.classifyScene(scene, { graphics: [] }).kind, 'footage');
});

check('the rescue must not wipe the run dedup state, or two scenes get the same clip', () => {
    const rescueSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'coverage-rescue.js'), 'utf8')
        .split(String.fromCharCode(13)).join('');
    assert.ok(/preserveCache:\s*true/.test(rescueSrc),
        'without preserveCache the download clears the used-URL/hash sets and the rescue can hand a scene '
        + 'the exact clip another scene is already showing');
});

check('the sweep sees scenes that never joined the base track', () => {
    // fullscreenMG and download:'skip' scenes are filtered out BEFORE Step 5, so
    // they are absent from scenesWithMedia entirely. A sweep that only looked at
    // that array would be blind to the two biggest causes of a blank scene.
    assert.ok(/partitionTrackMembership\(scenesWithMedia, scenesWithKeywords\)/.test(BV),
        'the sweep universe must include scenes excluded from the download set');
    // Membership is by scene NUMBER. The MG and template carves rebuild the track
    // out of `{ ...scene }` copies, so an identity test calls every live scene
    // off-track and the merge below re-appends the whole track onto itself.
    assert.ok(/const offTrack = \(candidateScenes \|\| \[\]\)\.filter/.test(BV),
        'partitionTrackMembership must build the off-track list from the candidate scenes');
    assert.ok(/onTrackNumbers\.has\(no\)/.test(BV),
        'track membership must be resolved by scene number, not object identity');
    assert.ok(/rescueUncovered\(\{[\s\S]{0,400}?scenes:\s*sweepUniverse/.test(BV),
        'the rescue must be handed the full universe, not just the download set');
    // The merge itself is asserted structurally rather than by its log wording:
    // this used to pin the exact sentence "merged N rescued scene(s)", which
    // failed the moment the borrow rung was added and the line was reworded to
    // cover both refill paths. The wording is cosmetic; the assignment is not.
    const merge = BV.slice(BV.indexOf('const joined = offTrack.filter'));
    const mergeBlock = merge.slice(0, 600);
    assert.ok(/scenesWithMedia\s*=\s*\[\s*\.\.\.scenesWithMedia,\s*\.\.\.joined\s*\]/.test(mergeBlock),
        'a refilled off-track scene must be merged back onto the base track or nothing draws it');
    // Both ways a scene can gain footage after the download have to open this
    // gate. A borrow that fills an off-track scene and never merges it is a
    // silent blank — the same defect the rescue merge was written to prevent.
    const gate = BV.slice(Math.max(0, BV.indexOf('const joined = offTrack.filter') - 400),
        BV.indexOf('const joined = offTrack.filter'));
    assert.ok(/rescueResult[\s\S]{0,80}rescued > 0/.test(gate) && /borrowResult[\s\S]{0,80}borrowed > 0/.test(gate),
        'the merge must fire for a borrowed scene as well as a rescued one');
});

check('the sweep runs after graphics are final and before the plan is built', () => {
    const director = BV.indexOf('Motion Director failed');
    const sweep = BV.indexOf('Coverage sweep: the honest final audit');
    const planStep = BV.indexOf('assignFinalSceneIndices(scenesWithMedia)');
    assert.ok(director > 0 && sweep > 0 && planStep > 0, 'could not locate the pipeline landmarks');
    assert.ok(sweep > director,
        'running before the Motion Director means a graphic can still be removed after the sweep looked');
    assert.ok(sweep < planStep,
        'running after index assignment means a rescued scene never reaches the plan');
});

check('presenter holds are excluded — their visual is not the footage system\'s job', () => {
    assert.ok(/!s\._presenterAnchor && !s\.presenterInsert/.test(BV),
        'handing a talking-head presenter hold a stock clip would be worse than the blank it replaced');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8/9] Fix 4 — ask for the thing you actually want');
// ─────────────────────────────────────────────────────────────────────────────
//
// Three separate defects, one symptom: the shop was asked for half a name, and
// then the judge graded the delivery against that same half a name.
//   4A  "root cellar" was cut to "root" (the end taken off), "aerial view" was
//       cut to "aerial" (a word deleted out of the middle), and the YouTube core
//       rung cut the same phrase in half a third time.
//   4B  the shortened query was handed to the vision judge AS THE STANDARD, so a
//       perfect root-cellar clip was rejected for "not matching root".
//   4C  the findability judge ran 29 seconds BEFORE Template Rhythm invented 13
//       brand-new queries it never saw.
//
// The rule the fix has to satisfy is the user's: one global mechanism, no niche
// branch, no flat constant, and it must LEARN inside the run. So "root cellar"
// must be protected on a homestead script and "Strait of Hormuz" on a
// geopolitics one WITHOUT either phrase existing anywhere in the source.

const atoms = require(path.join(ROOT, 'src', 'media', 'phrase-atoms.js'));
const kw = require(path.join(ROOT, 'src', 'media', 'search-keywords.js'));
const PA_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'phrase-atoms.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const RESCUE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'retrievability-rescue.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const VISION_SRC = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'ai-vision.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const CLIP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'clip-analyzer.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');

// Two independently-authored scenes that both talk about the same thing. No
// niche, no theme, no word list — just a script.
const homestead = [
    { index: 1, text: 'The root cellar kept food cold all winter without any electricity.',
      stockQuery: 'thermometer inside dark earthen root cellar', mediaType: 'video' },
    { index: 2, text: 'Every family dug a root cellar before the first frost.',
      stockQuery: 'stone steps down into root cellar', mediaType: 'video' },
];

check('a compound noun is learned from the script, never from a list in the code', () => {
    // One scene, and its own narration never mentions the pair — a single
    // unsupported sighting is not evidence, so nothing is protected yet.
    atoms.resetPhraseMemory();
    const unsupported = { index: 1, text: 'Winter came early that year.',
        stockQuery: 'thermometer inside dark earthen root cellar', mediaType: 'video' };
    const cold = atoms.collectAtoms(unsupported, {}).map((a) => a.key);
    assert.ok(!cold.includes('root cellar'),
        'one unsupported sighting must not create an atom, or long prose would freeze into fake names');

    // Two scenes, written independently, both reaching for the same pair.
    atoms.resetPhraseMemory();
    atoms.observeScenes([
        unsupported,
        { index: 2, text: 'Every family dug one before the first frost.',
          stockQuery: 'stone steps down into root cellar', mediaType: 'video' },
    ]);
    const crossScene = atoms.collectAtoms(unsupported, {}).map((a) => a.key);
    assert.ok(crossScene.includes('root cellar'),
        'two independently-authored scenes agreeing on a pair is the evidence that makes it a name');

    // Or one scene whose HUMAN-written narration says the same thing its query
    // says — the narration existed before any query, so it is a second witness.
    atoms.resetPhraseMemory();
    atoms.observeScenes([homestead[0]]);
    const narrated = atoms.collectAtoms(homestead[0], {}).map((a) => a.key);
    assert.ok(narrated.includes('root cellar'),
        'narration agreeing with the query is independent corroboration');
});

check('the SAME code protects a different topic\'s phrase with zero source changes', () => {
    // If this passed only for the homestead wording, the fix would be a word
    // list in disguise. Same function, different vocabulary, no edit anywhere.
    atoms.resetPhraseMemory();
    atoms.observeScenes([
        { index: 1, text: 'Tankers crawl through the Strait of Hormuz every single day.',
          stockQuery: 'oil tanker crossing Strait of Hormuz', mediaType: 'video' },
        { index: 2, text: 'Closing the Strait of Hormuz would move the global oil price overnight.',
          stockQuery: 'naval patrol Strait of Hormuz', mediaType: 'video' },
    ]);
    const keys = atoms.collectAtoms({ index: 1, stockQuery: 'oil tanker crossing Strait of Hormuz' }, {})
        .map((a) => a.key.toLowerCase());
    assert.ok(keys.some((k) => k.includes('strait') && k.includes('hormuz')),
        'a geopolitics compound noun must survive on the identical mechanism');
});

check('no phrase dictionary, and promotion counts SOURCES not sightings', () => {
    // A hardcoded multi-word list is the exact shape the user banned. The only
    // literal word set allowed here is GLUE, and every member is one word.
    const glue = PA_SRC.match(/const GLUE = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(glue, 'GLUE set not found');
    assert.ok(!/['"][a-z]+ [a-z]/i.test(glue[1]),
        'a multi-word entry in GLUE would be a phrase dictionary sneaking in');
    assert.ok(/_pairSources[\s\S]{0,400}?\.size >= PROMOTE_AT/.test(PA_SRC),
        'promotion must count distinct SOURCES — the orchestrator copies one sentence into three '
        + 'query fields, so counting sightings would promote every pair on every scene');
    assert.ok(/rememberPhraseWin/.test(PA_SRC) && /_pairWon/.test(PA_SRC),
        'a phrase that actually produced footage must be remembered for the rest of the run');
});

check('a scene cannot corroborate itself', () => {
    // The bug that made the first build of this fix chain a whole sentence into
    // one "atom": the query being trimmed was observed anonymously, so it counted
    // as a second independent source for its own words.
    atoms.resetPhraseMemory();
    const solo = { index: 7, text: 'A quiet morning on the farm.',
        stockQuery: 'thermometer inside dark earthen root cellar', mediaType: 'video' };
    const keys = atoms.collectAtoms(solo, {}).map((a) => a.key);
    assert.ok(!keys.includes('thermometer inside dark earthen'),
        'one scene observed twice must not out-vote the two-source rule');
});

check('the trim keeps the name whole instead of taking the end off', () => {
    atoms.resetPhraseMemory();
    atoms.observeScenes(homestead);
    const out = String(kw.trimSearchKeyword('thermometer inside dark earthen root cellar', homestead[0], { maxWords: 5 }));
    const low = out.toLowerCase();
    assert.ok(/root cellar/.test(low), `the phrase the scene is about was cut in half: "${out}"`);
    assert.ok(low.split(/\s+/).length <= 6, `query got longer instead of shorter: "${out}"`);
});

check('the noise stripper cannot delete a content word out of the middle', () => {
    // The Jul-29 log: "aerial view vast landscape farmland" shipped as
    // "aerial vast landscape farmland". A scene always carries its own query
    // field in the real pipeline, so the narration can vouch for the phrase.
    atoms.resetPhraseMemory();
    const scene = { index: 3, text: 'An aerial view of the valley below.',
        stockQuery: 'aerial view vast landscape farmland', mediaType: 'video' };
    atoms.observeScenes([scene]);
    const out = String(kw.trimSearchKeyword('aerial view vast landscape farmland', scene, { maxWords: 5 })).toLowerCase();
    assert.ok(/view/.test(out), `"view" was deleted from the middle of the request: "${out}"`);
});

check('4B — the judge is told what was ACTUALLY requested, not the shortened query', () => {
    assert.ok(/const fullVisualIntent = _fallbackText\(/.test(FM),
        'the full request must be captured BEFORE the keyword is overwritten by the trimmed form');
    const capture = FM.indexOf('const fullVisualIntent = _fallbackText(');
    const overwrite = FM.indexOf('trimSearchKeyword', capture);
    assert.ok(capture > 0 && overwrite > capture,
        'capturing after the trim would just copy the mangled query');
    const wired = (FM.match(/visualIntent:\s*fullVisualIntent/g) || []).length;
    assert.ok(wired >= 6,
        `only ${wired} vision/clip context object(s) carry the full request — every judge must get it`);
    assert.ok(/WHAT WAS ACTUALLY REQUESTED/.test(VISION_SRC),
        'the frame scorer never sees the full request');
    assert.ok((CLIP_SRC.match(/_requestedVisualLine\(context, keyword\)/g) || []).length === 3,
        'all three clip-analysis prompts (analyze, find segment, validate window) must get it');
    assert.ok(/=== String\(keyword \|\| ''\)\.trim\(\)\.toLowerCase\(\)\) return '';/.test(CLIP_SRC),
        'when the request and the keyword are identical the extra line must be suppressed, '
        + 'so unchanged prompts stay byte-identical');
});

check('4B did not cold-start every project\'s vision cache', () => {
    // The full request is DERIVED from the scene — and the cache scope already
    // keys on both of its inputs (the scene's own text and the keyword). So the
    // judge reads more, but two clips that share a cache entry still share the
    // same full request. Adding visualIntent to the scope would change the scope
    // hash of every entry ever written and re-bill the lot for nothing.
    const scope = FM.match(/const _visionCacheScope = visionCache\.makeScope[\s\S]{0,700}?\}\) : null;/);
    assert.ok(scope, '_visionCacheScope not found');
    assert.ok(/sceneText:/.test(scope[0]) && /keyword,/.test(scope[0]),
        'the scope must still key on the two fields the full request is derived from');
    assert.ok(!/visualIntent/.test(scope[0]),
        'adding visualIntent to the vision cache scope invalidates every cached verdict in every '
        + 'project — only do it if the full request can vary while scene text AND keyword stay identical');
});

check('4C — findability re-judges the queries invented after it first ran', () => {
    assert.ok(/options\.onlyIndices/.test(RESCUE_SRC),
        'the rescue must support a delta pass, or the re-check re-bills every scene');
    assert.ok(/Step 4\.87: Findability re-check/.test(BV), 'the re-check step is not wired into the build');
    const snapshot = BV.indexOf('_preDownloadQuerySnapshot');
    const rhythm = BV.indexOf('Step 4.85: Editor Agent Template Rhythm');
    const recheck = BV.indexOf('Step 4.87: Findability re-check');
    const download = BV.indexOf('const mediaDownloadScenes = scenesWithKeywords.filter');
    assert.ok(snapshot > 0 && rhythm > 0 && recheck > 0 && download > 0, 'pipeline landmarks not found');
    assert.ok(snapshot < rhythm, 'the snapshot must be taken before anything can rewrite a query');
    assert.ok(recheck > rhythm, 're-checking before Template Rhythm is the bug being fixed');
    assert.ok(recheck < download, 'a query judged after the download set is built is judged too late');
    assert.ok(/if \(changedIdx\.size > 0\)/.test(BV),
        'an unchanged script must cost zero extra AI calls');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9/9] Fix 5 — read your own handwriting');
// ─────────────────────────────────────────────────────────────────────────────
//
// Scene 59 of the Jul-29 build (explainer.diy, earth-tube cooling) asked, in its
// own brief, for "Cross-section diagram ... temperature indicators ... soil
// layers". The run then:
//   5(i)   deleted the word "diagram" from the YouTube search,
//   5(ii)  found two candidates that matched the brief line-for-line,
//   5(iii) demoted both 7 -> 5 for being diagrams, against an accept floor of 6,
// and shipped the scene with NO MEDIA. The system rejected the thing it had
// itself gone looking for.
//
// The old demotion was `Math.min(6, base - 2)` — a FLATTENING, not a demotion:
// 8, 9 and 10 all squashed to exactly 6 and passed, while a plain 7 became 5 and
// died. The most common good score was the only one that could not survive.
//
// The rule stays the user's: one global mechanism, no niche branch, no flat
// constant, and it must learn inside the run. So "did this scene ask for a
// drawn explanation?" is answered ONLY from the scene's own request fields —
// never from a niche id and never from a word list of topics.

const pkg = require(path.join(ROOT, 'src', 'media', 'packaging-intent.js'));
const rules = require(path.join(ROOT, 'src', 'media', 'relevant-person-rules.js'));
const PKG_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'packaging-intent.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const SEG_SRC = fs.readFileSync(path.join(ROOT, 'src', 'agents', 'smart-segment.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const HUNTER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'media-hunter.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const SANITY_SRC = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'vision-score-sanity.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const NICHES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'data', 'niches.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const AIP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'brain', 'ai-provider.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');
const KW_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'search-keywords.js'), 'utf8')
    .split(String.fromCharCode(13)).join('');

// The scene that lost its footage, and a neighbour that never asked for a
// diagram. Same niche, same script, same code path — only the brief differs.
const asksForDiagram = {
    index: 59,
    text: 'Buried pipes pull heat out of the air before it ever reaches the house.',
    visualIntent: 'Cross-section diagram of an earth tube system with temperature indicators and soil layers',
    stockQuery: 'earth tube diagram cross section',
    mediaType: 'video',
};
const asksForRawFootage = {
    index: 60,
    text: 'Crews dug the trench by hand across the whole property.',
    visualIntent: 'Workers laying clay pipe in an open trench',
    stockQuery: 'clay pipe trench excavation',
    mediaType: 'video',
};

check('the demotion is monotonic — a better clip can no longer score worse', () => {
    // The whole bug in one assertion. Under the old ceiling, 7 -> 5 (dead) while
    // 8, 9 and 10 all -> 6 (alive). Ordering has to survive the penalty.
    pkg.reset();
    const { penalty } = pkg.packagingPenalty(['graphic', 'text']);
    const scores = [7, 8, 9, 10].map((s) => Math.max(0, s - penalty));
    for (let i = 1; i < scores.length; i++) {
        assert.ok(scores[i] > scores[i - 1],
            `a ${[7, 8, 9, 10][i]}/10 must outrank a ${[7, 8, 9, 10][i - 1]}/10 after the penalty, got `
            + `${scores.join(',')} — that is the flattening that killed scene 59`);
    }
    assert.ok(!/Math\.min\(\s*6\s*,\s*Math\.max\(\s*0\s*,\s*\w+\s*-\s*2\s*\)\s*\)/.test(SEG_SRC),
        'the min(6, base-2) ceiling is back — it squashes 8/9/10 onto the pass mark and drops 7 below it');
});

check('severity is graded, not one flat number', () => {
    // A flat constant is banned as hard as a niche branch. A presenter talking to
    // camera is a worse miss than a caption, and both are worse than nothing.
    pkg.reset();
    const text = pkg.packagingPenalty(['text']).penalty;
    const graphic = pkg.packagingPenalty(['graphic']).penalty;
    const presenter = pkg.packagingPenalty(['presenter']).penalty;
    const stacked = pkg.packagingPenalty(['graphic', 'text']).penalty;
    assert.ok(presenter > graphic && graphic > text,
        `severity must be ordered presenter > graphic > text, got ${presenter}/${graphic}/${text}`);
    assert.ok(stacked > graphic, 'two packaging layers must cost more than one');
    assert.strictEqual(pkg.packagingPenalty([]).penalty, 0, 'a clean clip must never be penalised');
});

check('a layer the scene ASKED FOR stops counting as a defect', () => {
    const desc = 'Animated cross-section diagram of an underground pipe with labelled soil layers and temperature readings';
    const asked = rules.classifyStrictRawVisual(desc, 'earth tube diagram', asksForDiagram.text, {
        scene: asksForDiagram, visualIntent: asksForDiagram.visualIntent,
        mediaHunter: { strictRaw: true, allowGraphics: false },
    });
    assert.strictEqual(asked.reject, false,
        'the scene asked for a cross-section diagram and we rejected it for being a cross-section diagram');

    const notAsked = rules.classifyStrictRawVisual(desc, 'clay pipe trench', asksForRawFootage.text, {
        scene: asksForRawFootage, visualIntent: asksForRawFootage.visualIntent,
        mediaHunter: { strictRaw: true, allowGraphics: false },
    });
    assert.strictEqual(notAsked.reject, true,
        'a scene that wanted real trench footage must still refuse a diagram — the gate is not disabled, '
        + 'it is targeted');
});

check('narration alone is NOT a request — only request fields count as evidence', () => {
    // The narration says "diagram" out loud, but nothing ever ASKED for one. If
    // spoken words counted, every script that mentions a chart would switch its
    // own quality gate off. The same exclusion is why the renderer's overlay
    // hints (templateHint / fullscreenMG) are ignored here: they describe the
    // graphic we DRAW, not the footage we BUY.
    const spoken = pkg.detectRequestedPackaging({
        scene: { index: 5, text: 'Engineers drew a diagram of the whole schematic system on the wall.' },
    });
    assert.strictEqual(spoken.graphic, false,
        'narration mentioning a diagram must not be read as a request for one');

    const requested = pkg.detectRequestedPackaging({
        scene: { index: 5, text: 'Engineers drew it on the wall.' },
        visualIntent: 'Cross-section diagram of the system',
    });
    assert.strictEqual(requested.graphic, true, 'the planner naming the shot IS the request');
});

check('no niche is named anywhere in the mechanism', () => {
    // The exact shape the user banned. If any niche id appears, this stopped
    // being a global fix and became a special case for one channel.
    // Prose in a comment can say "a DIY explainer" — what matters is that no
    // niche id survives into anything that RUNS.
    const code = PKG_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const nicheIds = Object.keys(require(path.join(ROOT, 'src', 'data', 'niches.js')).NICHES || {});
    assert.ok(nicheIds.length > 5, 'niche registry not readable — the check would pass vacuously');
    for (const id of nicheIds) {
        assert.ok(!code.includes(id),
            `packaging-intent.js names the niche "${id}" in live code — that is a one-niche solution in disguise`);
    }
    assert.ok(!/\bproductionMode|themeId|BUILD_NICHE|\bniche\b/.test(code),
        'the decision must come from the scene request only, not from the topic or build-wide switches');
});

check('the relief is LEARNED in-run, and never lets a presenter through', () => {
    // Some topics simply have no clean raw footage. Rather than a constant
    // "be 1 point nicer", the softening only appears after the run itself has
    // shown that almost every candidate for this build is packaged.
    pkg.reset();
    assert.strictEqual(pkg.packagingRelief(), 0, 'relief must not exist before any evidence');
    for (let i = 0; i < pkg.MIN_LEARN_OBSERVATIONS - 1; i++) pkg.noteGateObservation(true);
    assert.strictEqual(pkg.packagingRelief(), 0,
        'a handful of packaged clips is noise, not proof the topic is unfilmable');

    pkg.reset();
    for (let i = 0; i < pkg.STRONG_LEARN_OBSERVATIONS + 4; i++) pkg.noteGateObservation(true);
    assert.ok(pkg.packagingRelief() > 0,
        'after a whole run of nothing but packaged candidates the bar has to bend, or the scene ships blank');

    // ...but not for a talking head. A presenter is never what a faceless video
    // wants, however unfilmable the topic turns out to be.
    const pres = pkg.packagingPenalty(['presenter']);
    assert.ok(pres.penalty >= 3,
        `full relief let a presenter down to ${pres.penalty} — a talking head must stay firmly rejected`);

    pkg.reset();
    for (let i = 0; i < pkg.STRONG_LEARN_OBSERVATIONS + 4; i++) pkg.noteGateObservation(false);
    assert.strictEqual(pkg.packagingRelief(), 0,
        'a run that keeps finding clean footage must keep the full standard');
});

check('the word is kept in the search when the scene asked for it, stripped when it did not', () => {
    // 5(i): "diagram", "cross-section" and "schematic" were deleted from every
    // YouTube query in the app — including the two scenes whose subject WAS a
    // diagram. Now the same one function decides per scene.
    const asked = kw.buildYouTubeQuery('ground coupled heat exchanger diagram', asksForDiagram);
    assert.ok(/diagram/i.test(asked), `the requested artefact was deleted from its own search: "${asked}"`);

    const notAsked = kw.buildYouTubeQuery('clay pipe trench excavation diagram', asksForRawFootage);
    assert.ok(!/diagram/i.test(notAsked),
        `"diagram" survived on a scene that wanted raw trench footage: "${notAsked}"`);

    // Words naming a non-video MEDIUM ("photo", "image") are still stripped
    // unconditionally — a YouTube search for a photo is just a worse search.
    const medium = kw.buildYouTubeQuery('photo of amish barn raising', asksForDiagram);
    assert.ok(!/\bphoto\b/i.test(medium), `"photo" must never survive into a video search: "${medium}"`);
});

check('the query cannot be its own justification for keeping its own words', () => {
    // The trap this fix walked into once already: if the filter reads the query
    // it is editing as evidence of what was requested, every word justifies
    // itself and the filter becomes a permanent no-op.
    assert.ok(/ignoreQuery/.test(PKG_SRC), 'packaging-intent.js has no ignoreQuery escape');
    assert.ok(/ignoreQuery:\s*true/.test(KW_SRC),
        'buildYouTubeQuery is EDITING the query — it must not treat that query as the request');
    const self = pkg.detectRequestedPackaging({
        keyword: 'clay pipe trench excavation diagram',
        scene: asksForRawFootage,
        ignoreQuery: true,
    });
    assert.strictEqual(self.graphic, false,
        'a stray word in the query being trimmed must not authorise itself to stay');
});

check('the niche-level YouTube strip defers to the scene, and is unchanged without one', () => {
    // niches.js is the DATA layer — it must not require the mechanism. It reads
    // the profile the hunter already attached, so a scene with no profile behaves
    // exactly as it did before this fix.
    const { rewriteQuery } = require(path.join(ROOT, 'src', 'data', 'niches.js'));
    const bare = rewriteQuery('earth tube diagram cross section', 'explainer.diy', 'youtube', { index: 1 });
    assert.ok(!/diagram/i.test(bare),
        `no profile attached must mean byte-identical old behaviour, got "${bare}"`);
    const withProfile = rewriteQuery('earth tube diagram cross section', 'explainer.diy', 'youtube', {
        index: 1, _mediaHunterProfile: { requestedPackaging: { graphic: true } },
    });
    assert.ok(/diagram/i.test(withProfile),
        `the scene's own profile asked for a diagram and the niche layer deleted it: "${withProfile}"`);
    assert.ok(!/require\(.*packaging-intent/.test(NICHES_SRC),
        'the data layer must stay dependency-free — it reads the resolved profile, it does not compute it');
});

check('strictRaw stays ON — only the requested layer is excused', () => {
    // The lazy fix is to flip allowGraphics. That one boolean also controls dense
    // frame sampling, the avoid-list, the defect clamp and ~25 other call sites,
    // so flipping it would quietly switch off half the quality gate. The fix adds
    // a NEW field beside it instead.
    assert.ok(/strictRaw\s*=\s*mediaType === 'video' && realVideoLane && !allowGraphics/.test(HUNTER_SRC),
        'the strictRaw definition changed — check nothing started disabling the whole gate');
    assert.ok(/requestedPackaging/.test(HUNTER_SRC),
        'media-hunter must resolve the scene request once and carry it on the profile');
    assert.ok(/requestedPackaging,/.test(HUNTER_SRC),
        'the resolved request must be returned on the profile or no downstream judge can see it');
});

check('the avoid-list stops telling the searcher to dodge the thing it was sent for', () => {
    assert.ok(/!requestedPackaging\.graphic \? TEXT_HEAVY_AVOID_TERMS/.test(HUNTER_SRC),
        'a scene whose brief IS a chart must not carry "chart" in its own avoid list');
});

check('all three clip judges drop the blanket graphic rejection — and only that', () => {
    const rejectionLines = (CLIP_SRC.match(/strictRaw && !mediaHunter\.allowGraphics && !wantsGraphic/g) || []).length;
    assert.strictEqual(rejectionLines, 3,
        `expected the rejection rule guarded on all 3 clip prompts (analyze / find segment / validate window), found ${rejectionLines}`);
    assert.ok((CLIP_SRC.match(/REQUESTED_GRAPHIC_RULE/g) || []).length === 4,
        'each of the 3 prompts needs the positive replacement instruction (plus its definition)');
    assert.ok(/REQUESTED_GRAPHIC_RULE = '[^']*anchors, presenters/.test(CLIP_SRC),
        'the replacement rule must still reject broadcast packaging — it is a swap, not an amnesty');
    // Sampling density is NOT a prompt gate. Leaving it alone keeps the frame
    // budget identical for every scene.
    assert.ok(/if \(hunter\.strictRaw && !hunter\.allowGraphics\) return true;/.test(CLIP_SRC),
        'the frame-sampling density check must stay untouched — it is not a quality rule');
});

check('a requested diagram is capped, not exempted, and branding is never excused', () => {
    // The scorer's own words used to be clamped to 4/10 whenever they admitted
    // any lettering. A drawn explanation IS lettering — dimensions, layer names,
    // temperatures. So the cap lifts for a scene that asked for one. It is still
    // a cap: a channel logo or a news ticker is never something anybody asked for.
    assert.ok(/REQUESTED_GRAPHIC_CAP\s*=\s*7/.test(SANITY_SRC), 'the requested-graphic cap is missing');
    assert.ok(/BRANDING_DEFECT_RE/.test(SANITY_SRC) && /!BRANDING_DEFECT_RE\.test\(m\[0\]\)/.test(SANITY_SRC),
        'broadcast branding must keep the hard cap even on a scene that asked for a diagram');
    assert.ok(/const DEFECT_CAP = 4;/.test(SANITY_SRC), 'the default cap must not have moved for everyone else');
    assert.ok(/clampSelfReportedDefects\(result, context\)/.test(SEG_SRC),
        'the clamp cannot see the request unless the gate passes it the context');
});

check('5(ii) — a busy rented GPU is benched for seconds, not declared dead for 30', () => {
    // 31 "model unavailable" events in one build. With ONE self-hosted box, ONE
    // model and ONE key, a 429 means the queue is full — not that the key is
    // spent. The old flat 30s bench emptied the pool and every waiting scene fell
    // through to paid Bedrock.
    assert.ok(/_isSelfHostedVisionRuntime/.test(AIP_SRC), 'no way to tell our own box from a hosted quota');
    assert.ok(/VISION_BACKPRESSURE_STATUSES/.test(AIP_SRC) && /429/.test(AIP_SRC),
        'busy statuses (429/503/529) must be recognised as backpressure');
    assert.ok(/selfHostedBusy[\s\S]{0,200}?QWEN_VISION_BUSY_COOLDOWN_MS/.test(AIP_SRC),
        'a busy self-hosted box must get its own short cooldown');
    assert.ok(/QWEN_VISION_COOLDOWN_MS, 10\) \|\| 30_000/.test(AIP_SRC),
        'a genuinely rate-limited HOSTED key must keep the long 30s bench');
    assert.ok(/QWEN_VISION_BUSY_RETRIES/.test(AIP_SRC) && /QWEN_VISION_BUSY_BACKOFF_MS/.test(AIP_SRC),
        'the retry ladder must wait longer on a busy box instead of giving up in 1.5s');
    // A hosted quota must NOT be softened — that is a real permanent exhaustion.
    assert.ok(AIP_SRC.includes('aliyuncs') && AIP_SRC.includes('dashscope'),
        'hosted vision endpoints must be excluded from the self-hosted backpressure path — a real '
        + 'hosted quota exhaustion is permanent and must keep the long bench');
});

// ─────────────────────────────────────────────────────────────────────────────
Promise.all(pending).then(() => {
    console.log(`\n${failures === 0 ? '✅' : '❌'} media adaptivity: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) process.exit(1);
});
