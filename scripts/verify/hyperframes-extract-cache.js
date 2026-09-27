#!/usr/bin/env node
/**
 * VERIFY: re-rendering reuses already-cut frames, and can never reuse the WRONG
 * ones.
 *
 * Background (measured in the 2026-07-31 render, 44 clips / 265 MB of media):
 * cutting the clips into frames took `videoExtractMs: 74634` -- 75 seconds of
 * every render -- and it was paid again on every single render. The CLI has a
 * persistent cache for exactly this and the cache itself works: in that same
 * log, the first capture attempt reported cacheHits 0 / cacheMisses 48 and the
 * retry on the SAME project dir reported 48 / 0. What never survived was the
 * KEY: `canonicalKeyBlob()` hashed the absolute media path, and every render
 * writes a fresh `yta-hf-<timestamp>` project dir, so the key changed every
 * time. Guaranteed miss, forever, growing with video length.
 *
 * Two things had to be true for the fix to hold, and this file pins both:
 *
 *   1. The key identifies the clip by its BYTES, not its location, so a new
 *      render dir still matches. That is a cache-correctness change, so the
 *      checks below don't just look for the patch -- they pull the real patched
 *      function out of the bundle and RUN it, including the ways it must refuse
 *      to match.
 *   2. The cache is somewhere with room to hold a render. The CLI defaults to a
 *      2 GB dir in the system temp folder, and one render of that project wrote
 *      1.9 GB / 49 entries -- so even with a perfect key it would evict itself
 *      before the next render arrived, and it would do it on the system drive
 *      the CLI's own preflight warns about exhausting.
 *
 * The dangerous regression here is silent in both directions: a broken key just
 * makes renders slow again (no error), and a too-wide key serves stale footage
 * (no error either). Hence the negative cases carry as much weight as the
 * positive one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const PATCH_PATH = path.join(ROOT, 'scripts', 'patch-hyperframes-extract-cache.js');
const CLI_PATH = path.join(ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}`);
        if (detail) console.log(`       ${detail}`);
    }
}

console.log('[verify] hyperframes extract cache');

// Normalized to LF: the anchors below are bare newlines, which never match on a
// CRLF working copy — the gate then reports its own subject as missing and the
// `npm run verify` && chain aborts before every later check. Found 2026-08-28.
const main = fs.readFileSync(MAIN_PATH, 'utf8')
    .split(String.fromCharCode(13)).join('');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

// --- the patch survives a reinstall -----------------------------------------
check(
    'the cache-key patch exists',
    fs.existsSync(PATCH_PATH),
    'scripts/patch-hyperframes-extract-cache.js is gone'
);

check(
    'the patch is re-applied automatically after npm install',
    String(pkg.scripts && pkg.scripts.postinstall || '')
        .includes('patch-hyperframes-extract-cache.js'),
    'postinstall no longer runs the cache patch -- the next `npm install` '
    + 'silently reverts to re-cutting every clip on every render'
);

// --- upstream contract ------------------------------------------------------
if (!fs.existsSync(CLI_PATH)) {
    console.log('  skip hyperframes not installed; cannot verify the CLI contract');
} else {
    const cli = fs.readFileSync(CLI_PATH, 'utf8')
        .split(String.fromCharCode(13)).join('');

    check(
        'the CLI still keys its frame cache through canonicalKeyBlob',
        /computeCacheKey\(input2?\)\s*\{[\s\S]{0,200}canonicalKeyBlob/.test(cli),
        'the cache key is computed somewhere else now; the patch may be a no-op'
    );

    check(
        'the CLI still honours the cache dir + cap we set',
        cli.includes('HYPERFRAMES_EXTRACT_CACHE_DIR')
            && cli.includes('HYPERFRAMES_EXTRACT_CACHE_MAX_MB'),
        'the env overrides main.js sets are gone upstream -- the cache is back '
        + 'in the system temp dir at its own small default cap'
    );

    // The whole reason we override the cap is that the shipped one cannot hold
    // a single render of a real project. If upstream raises it well past that,
    // this fix stops being load-bearing and should be re-reviewed.
    const capMatch = /extractCacheMaxBytes\s*[:=]\s*([0-9]+)\s*\*\s*1024\s*\*\*\s*3/.exec(cli)
        || /extractCacheMaxBytes\s*[:=]\s*([0-9]+)\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/.exec(cli);
    check(
        'the CLI default cap is still too small for one render of a real project',
        capMatch && Number(capMatch[1]) <= 4,
        `CLI default cap is ${capMatch ? capMatch[1] + 'GB' : '(not found)'}; `
        + 'one measured render of this project wrote 1.9GB of frames'
    );

    check(
        'the patched key no longer contains the absolute media path',
        !/blob\s*=\s*\{[\s\S]{0,120}p:\s*input2\.videoPath/.test(cli),
        'canonicalKeyBlob is keying on videoPath again -- every render writes a '
        + 'new project dir, so the cache can never hit across renders'
    );

    check(
        'the patched key identifies the clip by its content',
        cli.includes('function __hfContentIdentity(')
            && /blob\s*=\s*\{[\s\S]{0,120}c:\s*__hfContentIdentity\(/.test(cli),
        'the content-addressed key is missing from the bundle; run '
        + '`npm run patch:hyperframes`'
    );

    // --- the real patched function, executed ---------------------------------
    // Restating the hashing here would let a copy drift into passing while the
    // shipped bundle regressed, so pull the actual code out and run it.
    const fnStart = cli.indexOf('function __hfContentIdentity(');
    const blobStart = cli.indexOf('function canonicalKeyBlob(', fnStart);
    const fnEnd = blobStart >= 0 ? cli.indexOf('\n}\n', blobStart) : -1;
    if (fnStart < 0 || fnEnd < 0) {
        check('the patched key functions are extractable', false,
            'could not slice __hfContentIdentity/canonicalKeyBlob out of the bundle');
    } else {
        const src = cli.slice(fnStart, fnEnd + 2);
        // eslint-disable-next-line no-new-func
        const canonicalKeyBlob = new Function('createHash2', 'require',
            `${src}\nreturn canonicalKeyBlob;`)(require('crypto').createHash, require);

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-hfcache-'));
        const writeClip = (name, bytes) => {
            const p = path.join(tmpRoot, name);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, bytes);
            return p;
        };
        // Stand in for what the CLI actually passes: one clip, one segment.
        const inputFor = (videoPath, over = {}) => {
            const st = fs.statSync(videoPath);
            return {
                videoPath,
                mtimeMs: Math.floor(st.mtimeMs),
                size: st.size,
                mediaStart: 3.5,
                duration: 5,
                fps: 30,
                format: 'jpeg',
                ...over,
            };
        };
        const keyOf = (videoPath, over) => canonicalKeyBlob(inputFor(videoPath, over));

        try {
            const bytesA = Buffer.alloc(64 * 1024, 0xa5);
            const bytesB = Buffer.alloc(64 * 1024, 0x5c); // same LENGTH, different content

            // THE FIX: the same clip in two different render dirs is one entry.
            // The second is given a different timestamp on purpose -- when the
            // project and the app are on different drives the bridge cannot
            // hardlink and physically COPIES the media, which resets it. That
            // case was unfixable while the key depended on path + mtime.
            const renderOne = writeClip('yta-hf-2026-07-31-aaa/media/clip.mp4', bytesA);
            const renderTwo = writeClip('yta-hf-2026-08-01-bbb/media/clip.mp4', bytesA);
            fs.utimesSync(renderTwo, new Date(0), new Date(86400000));
            check(
                'the same clip in a NEW render dir reuses the cached frames',
                keyOf(renderOne) === keyOf(renderTwo),
                'this is the entire fix; a miss here means every render re-cuts '
                + 'every clip from scratch'
            );

            // The failure that would be worst: silently rendering stale footage.
            const swapped = writeClip('swapped/clip.mp4', bytesA);
            const beforeSwap = keyOf(swapped);
            fs.writeFileSync(swapped, bytesB);
            fs.utimesSync(swapped, new Date(0), new Date(0)); // hide the edit
            check(
                'replacing a clip with different footage never reuses old frames',
                keyOf(swapped) !== beforeSwap,
                'DIFFERENT footage produced the SAME cache key -- the render '
                + 'would silently show the wrong clip'
            );

            // Everything that identifies the SEGMENT, not the file, must still
            // split the key -- otherwise scene 4 could get scene 9's frames.
            const seg = writeClip('seg/clip.mp4', bytesA);
            const base = keyOf(seg);
            for (const [label, over] of [
                ['a different start point in the clip', { mediaStart: 9.25 }],
                ['a different segment length', { duration: 8 }],
                ['a different frame rate', { fps: 60 }],
                ['a different pixel format', { format: 'png' }],
                ['a colour transform', { transform: 'hdr-to-sdr' }],
            ]) {
                check(
                    `${label} is still a separate cache entry`,
                    keyOf(seg, over) !== base,
                    'two different cuts of one clip now collide on a single entry'
                );
            }

            // A file it cannot read must fail CLOSED -- back to today's
            // guaranteed-miss behaviour, never to a wider key that could match
            // something else.
            const ghostOne = path.join(tmpRoot, 'render-x/missing.mp4');
            const ghostTwo = path.join(tmpRoot, 'render-y/missing.mp4');
            const unreadable = canonicalKeyBlob({
                videoPath: ghostOne, mtimeMs: 111, size: 4096,
                mediaStart: 0, duration: 5, fps: 30, format: 'jpeg',
            });
            const unreadable2 = canonicalKeyBlob({
                videoPath: ghostTwo, mtimeMs: 111, size: 4096,
                mediaStart: 0, duration: 5, fps: 30, format: 'jpeg',
            });
            // The key is JSON, so a Windows path arrives with escaped separators.
            const asJson = (p) => JSON.stringify(p).slice(1, -1);
            check(
                'an unreadable clip falls back to a miss, never to a wrong hit',
                unreadable !== unreadable2
                    && unreadable.includes(`path:${asJson(ghostOne)}|111`),
                'a file that cannot be hashed no longer falls back to identifying '
                + 'it by path, so unrelated clips could share one cache entry'
            );

            // A way out without a reinstall if this ever misbehaves live.
            const prev = process.env.HF_EXTRACT_CACHE_CONTENT_KEY;
            process.env.HF_EXTRACT_CACHE_CONTENT_KEY = '0';
            try {
                check(
                    'the content key can be switched off at runtime',
                    keyOf(renderOne) !== keyOf(renderTwo),
                    'HF_EXTRACT_CACHE_CONTENT_KEY=0 no longer restores the '
                    + 'original path-based keying'
                );
            } finally {
                if (prev === undefined) delete process.env.HF_EXTRACT_CACHE_CONTENT_KEY;
                else process.env.HF_EXTRACT_CACHE_CONTENT_KEY = prev;
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    }
}

// --- app-side wiring --------------------------------------------------------
check(
    'main.js points the frame cache somewhere with room',
    /HYPERFRAMES_EXTRACT_CACHE_DIR:\s*extractCache\.dir/.test(main)
        && /HYPERFRAMES_EXTRACT_CACHE_MAX_MB:\s*String\(extractCache\.maxMb\)/.test(main),
    'runHyperframesCli no longer sets the cache dir/cap, so it falls back to a '
    + '2GB dir in the system temp folder and evicts itself between renders'
);

check(
    'the cache location is chosen per project, not hardcoded',
    main.includes('resolveExtractCacheSettings(projectDir)'),
    'the cache home is no longer picked from the project being rendered'
);

check(
    'an explicit operator cache dir wins',
    /process\.env\.HYPERFRAMES_EXTRACT_CACHE_DIR\s*\n?\s*\?\s*null/.test(main),
    'a pinned HYPERFRAMES_EXTRACT_CACHE_DIR is being overwritten'
);

// --- the real sizing function, executed -------------------------------------
const rStart = main.indexOf('function resolveExtractCacheSettings(');
const rEnd = rStart >= 0 ? main.indexOf('\n}\n', rStart) : -1;
if (rStart < 0 || rEnd < 0) {
    check('resolveExtractCacheSettings is present in main.js', false,
        'the cache sizing function was removed or renamed');
} else {
    const GB = 1024 ** 3;
    const src = main.slice(rStart, rEnd + 2);

    // Run the real function against a stand-in disk so the cap can be observed
    // at sizes this machine does not happen to have.
    const build = (freeBytes) => {
        const fakeFs = {
            constants: fs.constants,
            statfsSync: () => ({ bavail: Math.floor(freeBytes / 4096), bsize: 4096 }),
            mkdirSync: () => {},
            accessSync: () => {},
        };
        // eslint-disable-next-line no-new-func
        return new Function('fs', 'path', 'app', 'PROJECT_ROOT',
            `${src}\nreturn resolveExtractCacheSettings;`)(
            fakeFs, path, { getPath: () => path.join(os.tmpdir(), 'ud') }, ROOT
        );
    };

    const projectDir = path.join('C:', 'proj', 'hyperframes', 'yta-hf-2026-07-31-x');
    const roomy = build(300 * GB)(projectDir);
    const modest = build(50 * GB)(projectDir);
    const cramped = build(16 * GB)(projectDir);

    check(
        'the cap scales with the drive instead of being one flat number',
        roomy && modest && roomy.maxMb > modest.maxMb,
        `300GB free -> ${roomy && Math.round(roomy.maxMb / 1024)}GB cap, `
        + `50GB free -> ${modest && Math.round(modest.maxMb / 1024)}GB cap`
    );

    check(
        'the cache can hold more than one render of a real project',
        modest && modest.maxMb >= 4096,
        `a 50GB drive would allow only ${modest && Math.round(modest.maxMb / 1024)}GB; `
        + 'one measured render wrote 1.9GB'
    );

    check(
        'the cache never plans to eat the free space it was given',
        roomy && (roomy.maxMb * 1024 * 1024) <= (300 * GB - 15 * GB)
            && modest && (modest.maxMb * 1024 * 1024) <= (50 * GB - 15 * GB),
        'the cap exceeds free space minus the reserve; a long render could fill '
        + 'the drive it is writing the video to'
    );

    check(
        'a nearly-full drive leaves the CLI defaults alone',
        cramped === null,
        'a drive with no room to spare is still being handed a cache; that is '
        + 'how a render runs the disk out mid-capture'
    );

    check(
        'the cache sits beside the render dirs, where housekeeping cannot sweep it',
        roomy && path.basename(roomy.dir).startsWith('.hf-extract-cache')
            && !path.basename(roomy.dir).startsWith('yta-hf-'),
        `chosen dir was ${roomy && roomy.dir}; the bridge prunes old projects by `
        + 'matching /^yta-hf-/, so the cache must not look like one'
    );
}

// --- the assumption the whole payoff rests on -------------------------------
// A content-addressed cache only pays off if the SAME clip really does produce
// the SAME bytes in the next render. Two paths lead there and both must hold:
//   - the bridge hardlinks the normalized clip in from a retained sibling
//     project dir (measured: 55 of 55 clips in the 2026-07-31 render), or
//   - the sibling has been pruned and ffmpeg re-encodes it from scratch.
// The second is the fragile one: adding anything time-varying to the transcode
// (a timestamp tag, a bitexact-off default, a variable preset) would make every
// re-encode a different file, and the frame cache would silently stop hitting
// with no error anywhere. So run the REAL argument builder twice and compare.
const BRIDGE_PATH = path.join(ROOT, 'src', 'render', 'hyperframes-bridge.js');
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) { /* checked below */ }
if (!ffmpegPath || !fs.existsSync(ffmpegPath) || !fs.existsSync(BRIDGE_PATH)) {
    console.log('  skip ffmpeg/bridge unavailable; cannot verify transcode determinism');
} else {
    const bridge = fs.readFileSync(BRIDGE_PATH, 'utf8')
        .split(String.fromCharCode(13)).join('');
    const bStart = bridge.indexOf('const buildArgs = (off) => {');
    const bEnd = bStart >= 0 ? bridge.indexOf('\n    };', bStart) : -1;
    if (bStart < 0 || bEnd < 0) {
        check('the transcode argument builder is extractable', false,
            'buildArgs was renamed or reshaped in hyperframes-bridge.js');
    } else {
        const { execFileSync } = require('child_process');
        const crypto = require('crypto');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-det-'));
        try {
            // eslint-disable-next-line no-new-func
            const buildArgs = new Function('src', 'targetDuration', 'outPath',
                `${bridge.slice(bStart, bEnd + 7)}\nreturn buildArgs;`);
            const src = path.join(tmp, 'src.mp4');
            execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
                '-c:v', 'libx264', '-preset', 'ultrafast', src],
                { stdio: ['ignore', 'ignore', 'pipe'] });

            const hashes = ['a.mp4', 'b.mp4'].map((name) => {
                const out = path.join(tmp, name);
                execFileSync(ffmpegPath, buildArgs(src, 1, out)(0),
                    { stdio: ['ignore', 'ignore', 'pipe'] });
                return crypto.createHash('sha256')
                    .update(fs.readFileSync(out)).digest('hex');
            });

            check(
                're-encoding a clip produces the same bytes, so the cache still hits',
                hashes[0] === hashes[1],
                'the transcode is no longer byte-stable -- once an old render dir is '
                + 'pruned, the clip is rebuilt into a DIFFERENT file and every render '
                + 'goes back to re-cutting frames from scratch, silently'
            );
        } catch (err) {
            check('transcode determinism could be measured', false, String(err.message || err));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
}

console.log(`\n[verify] hyperframes extract cache: ${checks - failures}/${checks} passed`);
if (failures > 0) {
    console.error(`[verify] FAILED (${failures})`);
    process.exit(1);
}
