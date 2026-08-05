#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the two render-speed fixes landed 2026-07-30, both of which are
 * silent when they break — they cost time or ship wrong footage, and nothing throws.
 *
 * A) CROSS-BUILD NORMALIZED-MEDIA REUSE (src/render/hyperframes-bridge.js)
 *    The `.normmeta` disk cache had never once hit: generateHyperframesProject mints a
 *    fresh `yta-hf-<stamp>` dir per build, so `fs.existsSync(outPath)` was always tested
 *    against an empty directory. Every build re-encoded clips byte-identical to ones
 *    written minutes earlier — ~73s for a Motion QA second pass, ~24s for the MG clips the
 *    preview had already normalized (measured: sha256 36/36 identical across passes).
 *    _seedNormalizedFromSibling hardlinks them in from the dirs the keep-N prune retains.
 *
 *    The dangerous half is staleness. The cache key identifies its source by PATH, not by
 *    content, while scene Retry (qa-replacer) overwrites public/scene-N-asset.* IN PLACE.
 *    A seed that ignored that would put PRE-RETRY FOOTAGE in the delivered video — not a
 *    subtle artifact, the wrong clip. Hence the mtime guard, and hence this gate.
 *
 * B) LANGUAGE-SCOPED FONT EMBEDDING (same file, buildFontFaces)
 *    The two Korean CJK faces are 10.9 MB of the 11.1 MB in assets/fonts, and every capture
 *    worker uploaded and parsed them at session start even for English renders. The gate is
 *    derived from the language registry, NOT a filename list — and languages.js stores
 *    CSS-ready values ('"Noto Sans KR"') while the bridge derives bare family names, so a
 *    comparison that forgets to strip quotes silently matches nothing and gates nothing.
 *    That is the specific failure this section exists to catch.
 *
 *    It is an EMISSION guard only. The files must stay on disk: ui/js/mg-theme-bridge.js
 *    calls resolveLanguageFonts() and ui/index.html declares its own @font-face rules
 *    against them, so deleting them would break Korean in the app window.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let checks = 0;
let failures = 0;

function ok(cond, msg) {
    checks++;
    if (cond) { console.log(`  ✅ ${msg}`); return; }
    failures++;
    console.log(`  ❌ ${msg}`);
}

// ---------------------------------------------------------------------------------------
// A) cross-build normalized-media seed
// ---------------------------------------------------------------------------------------
console.log('\n=== Cross-build normalized-media reuse ===');

const bridge = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge.js'));
ok(
    typeof bridge._seedNormalizedFromSibling === 'function',
    '_seedNormalizedFromSibling is exported for verification'
);

const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'render', 'hyperframes-bridge.js'), 'utf8');
ok(
    bridgeSrc.includes('_seedNormalizedFromSibling(src, mediaDir, outName, outPath, key)'),
    'copyAsset consults the sibling seed before paying for a transcode'
);
ok(
    /if \(srcMtime > st\.mtimeMs\) continue;/.test(bridgeSrc),
    'the seed refuses any candidate older than the source it claims to encode (Retry guard)'
);
ok(
    bridgeSrc.includes('|video|${toSeconds(options.duration, 3).toFixed(3)}|${toSeconds(options.startOffset, 0).toFixed(3)}'),
    'the normmeta cache key string is unchanged (THE REFACTOR RULE)'
);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-verify-hfseed-'));
try {
    const hfRoot = path.join(tmpRoot, 'hyperframes');
    const srcFile = path.join(tmpRoot, 'scene-1-asset.mp4');
    const KEY = `${path.resolve(srcFile)}|video|5.000|0.000`;
    const MIN_VALID_VIDEO_BYTES = 4096;

    const mkProject = (name, opts = {}) => {
        const dir = path.join(hfRoot, name);
        fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
        if (opts.withMedia) {
            const f = path.join(dir, 'media', 'scene-1.mp4');
            fs.writeFileSync(f, Buffer.alloc(opts.size ?? 50_000, 7));
            fs.writeFileSync(`${f}.normmeta`, opts.key ?? KEY);
        }
        return dir;
    };

    const attempt = ({ sibling = {}, retryAfterBuild = false } = {}) => {
        fs.rmSync(hfRoot, { recursive: true, force: true });
        fs.writeFileSync(srcFile, Buffer.alloc(50_000, 7));
        const old = (Date.now() - 600_000) / 1000;
        fs.utimesSync(srcFile, old, old);
        mkProject('yta-hf-2026-01-01T00-00-00-000Z-1-aaaa', sibling);
        if (retryAfterBuild) {
            // qa-replacer unlinks + copies new bytes to the SAME path after that build ran.
            const later = (Date.now() + 5_000) / 1000;
            fs.writeFileSync(srcFile, Buffer.alloc(50_000, 42));
            fs.utimesSync(srcFile, later, later);
        }
        const cur = mkProject('yta-hf-2026-01-01T00-00-01-000Z-1-bbbb');
        const mediaDir = path.join(cur, 'media');
        const outPath = path.join(mediaDir, 'scene-1.mp4');
        const seeded = bridge._seedNormalizedFromSibling(srcFile, mediaDir, 'scene-1.mp4', outPath, KEY);
        return { seeded, exists: fs.existsSync(outPath) };
    };

    let r = attempt({ sibling: { withMedia: true } });
    ok(r.seeded === true && r.exists, 'seeds from a matching sibling build');

    r = attempt({ sibling: { withMedia: true, key: 'OTHER|video|9.000|0.000' } });
    ok(!r.seeded && !r.exists, 'refuses a sibling whose cache key differs (duration/offset changed)');

    r = attempt({ sibling: { withMedia: true, size: 100 } });
    ok(!r.seeded && !r.exists, `refuses a truncated sibling (< ${MIN_VALID_VIDEO_BYTES} bytes)`);

    r = attempt({ sibling: { withMedia: true }, retryAfterBuild: true });
    ok(!r.seeded && !r.exists, 'refuses a sibling older than the source — the scene-Retry case');

    r = attempt({ sibling: {} });
    ok(!r.seeded && !r.exists, 'no sibling media -> falls through to a real transcode');

    // Hardlink semantics: the seeded clip must outlive the prune, and must never write back
    // through a shared inode into public/.
    fs.rmSync(hfRoot, { recursive: true, force: true });
    fs.writeFileSync(srcFile, Buffer.alloc(50_000, 7));
    const old = (Date.now() - 600_000) / 1000;
    fs.utimesSync(srcFile, old, old);
    const sib = mkProject('yta-hf-2026-01-01T00-00-00-000Z-1-aaaa', { withMedia: true });
    const cur = mkProject('yta-hf-2026-01-01T00-00-02-000Z-1-cccc');
    const outPath = path.join(cur, 'media', 'scene-1.mp4');
    bridge._seedNormalizedFromSibling(srcFile, path.join(cur, 'media'), 'scene-1.mp4', outPath, KEY);
    const srcSizeBefore = fs.statSync(srcFile).size;
    fs.rmSync(sib, { recursive: true, force: true });
    ok(
        fs.existsSync(outPath) && fs.statSync(outPath).size === 50_000,
        'the seeded clip survives the keep-N prune deleting its sibling dir'
    );
    ok(fs.statSync(srcFile).size === srcSizeBefore, 'the original source in public/ is untouched');
    ok(
        fs.readFileSync(`${outPath}.normmeta`, 'utf8') === KEY,
        'the seed writes its own .normmeta so the next pass reuses in-dir'
    );
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------
// B) language-scoped font embedding
// ---------------------------------------------------------------------------------------
console.log('\n=== Language-scoped font embedding ===');

ok(
    bridgeSrc.includes('function buildFontFaces(dirs, mediaDir, plan)')
        && bridgeSrc.includes('buildFontFaces(dirs, mediaDir, plan)'),
    'buildFontFaces receives the plan so it can see the active language'
);
ok(
    bridgeSrc.includes(`String(raw).replace(/["']/g, '').trim().toLowerCase()`),
    'language font families are quote-stripped before comparison (else the gate silently no-ops)'
);
ok(
    !/BlackHanSans-Regular\.ttf|NotoSansKR-VariableFont/.test(bridgeSrc),
    'the gate is derived from the language registry, not a hardcoded filename list'
);

const { LANGUAGES } = require(path.join(ROOT, 'src', 'data', 'languages'));
const gateFor = (activeLang) => {
    const scoped = new Set();
    const wanted = new Set();
    for (const [code, def] of Object.entries(LANGUAGES || {})) {
        for (const list of Object.values(def?.fontOverrides || {})) {
            for (const raw of list || []) {
                const fam = String(raw).replace(/["']/g, '').trim().toLowerCase();
                if (!fam || /^(sans-serif|serif|monospace|cursive|fantasy|system-ui)$/.test(fam)) continue;
                scoped.add(fam);
                if (code.toLowerCase() === String(activeLang).toLowerCase()) wanted.add(fam);
            }
        }
    }
    return (family) => scoped.has(family.toLowerCase()) && !wanted.has(family.toLowerCase());
};

const skipInEnglish = gateFor('en');
const skipInKorean = gateFor('ko');
ok(skipInEnglish('Noto Sans KR') && skipInEnglish('Black Han Sans'), 'English renders skip both CJK faces');
ok(!skipInKorean('Noto Sans KR') && !skipInKorean('Black Han Sans'), 'Korean renders keep both CJK faces');
ok(gateFor('')('Noto Sans KR'), 'an absent language still skips CJK (English is the default)');

const fontDir = path.join(ROOT, 'assets', 'fonts');
if (fs.existsSync(fontDir)) {
    const SPECIAL = { NotoSansKR: 'Noto Sans KR', BlackHanSans: 'Black Han Sans' };
    let kept = 0;
    let skippedBytes = 0;
    let keptBytes = 0;
    for (const file of fs.readdirSync(fontDir)) {
        if (!/\.(woff2?|ttf|otf)$/i.test(file)) continue;
        const m = file.replace(/\.(woff2?|ttf|otf)$/i, '').match(/^([A-Za-z]+)[-_]?(\d{3}|Regular|VariableFont.*)?$/);
        if (!m) continue;
        const family = SPECIAL[m[1]] || m[1].replace(/([a-z])([A-Z])/g, '$1 $2');
        const size = fs.statSync(path.join(fontDir, file)).size;
        if (skipInEnglish(family)) skippedBytes += size;
        else { kept++; keptBytes += size; }
    }
    ok(kept > 0, `Latin theme fonts still embed in an English render (${kept} files)`);
    ok(
        skippedBytes > keptBytes,
        `the skipped payload is the bulk of assets/fonts (${(skippedBytes / 1048576).toFixed(1)} MB skipped vs ${(keptBytes / 1048576).toFixed(1)} MB kept)`
    );

    // The files must remain on disk — the app window still resolves them directly.
    ok(
        fs.readdirSync(fontDir).some(f => /NotoSansKR|BlackHanSans/i.test(f)),
        'the CJK font files remain on disk (the app window @font-faces them directly)'
    );
}

console.log(`\n[render-media-reuse] ${checks - failures}/${checks} checks passed`);
if (failures) {
    console.log(`[render-media-reuse] FAILED — ${failures} check(s)\n`);
    process.exit(1);
}
console.log('[render-media-reuse] OK\n');
