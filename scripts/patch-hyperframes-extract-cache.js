#!/usr/bin/env node
/**
 * Patch hyperframes' extracted-frame cache key so it survives a new render dir.
 *
 * WHY
 * ---
 * Extracting frames from the scene clips is one of the most expensive phases of
 * a render (measured 2026-07-31: `videoExtractMs: 74634` for 44 clips / 265 MB).
 * The CLI already has a persistent cache for exactly this, and it works -- but
 * it can never be hit twice, because `canonicalKeyBlob()` puts the ABSOLUTE
 * MEDIA PATH in the key:
 *
 *     const blob = { p: input2.videoPath, m: input2.mtimeMs, s: ..., ... };
 *
 * Every render writes a brand-new project directory
 * (`<project>/hyperframes/yta-hf-<iso>-<pid>-<rand>/media/...`), so `p` is
 * different every single time -- and when the bridge cannot hardlink the media
 * across volumes it copies it, which resets `m` as well.
 *
 * Proof from that same render, with no code change in between:
 *   - first capture attempt : cacheHits 0,  cacheMisses 48
 *   - retry, SAME project dir: cacheHits 48, cacheMisses 0
 * The cache is healthy. It is the key that is unstable.
 *
 * THE FIX
 * -------
 * Identify the clip by WHAT IT IS instead of WHERE IT SITS: replace `p` + `m`
 * with a sha256 of the file's own bytes. Everything else in the key (segment
 * start, duration, fps, pixel format, HDR transform) is untouched.
 *
 * This is strictly MORE correct than what it replaces, not merely faster:
 * path+mtime+size was only ever a *proxy* for "is this the same content", and
 * a bad one -- a file rewritten in place with the same length and a restored
 * mtime is a false HIT today, serving stale frames. Content cannot lie.
 * Two genuinely identical clips now correctly share one extraction.
 *
 * Cost: measured 821 ms to sha256 all 44 videos (265 MB) of a real project --
 * about 1% of the 74.6 s it saves. Files are hashed whole up to 256 MB; beyond
 * that a head/middle/tail sample is used so one enormous file cannot dominate
 * the render. The two schemes carry different key prefixes and so can never be
 * confused for one another.
 *
 * SAFETY
 * ------
 * - Any failure to read the file falls back to `path:<videoPath>|<mtimeMs>` --
 *   byte-for-byte the ORIGINAL identity. A failure can therefore only ever
 *   reproduce today's behaviour (a guaranteed miss). It can never widen the
 *   key, which is the only way this could serve the wrong frames.
 * - `HF_EXTRACT_CACHE_CONTENT_KEY=0` restores the original keying at runtime,
 *   with no reinstall, if this ever needs to be switched off mid-session.
 * - The blob shape changes, so pre-existing cache entries simply stop matching
 *   and age out through the CLI's own GC. They cannot be mismatched into.
 *
 * Idempotent. Safe to run repeatedly. Exits non-zero only if the target file
 * exists but matches neither the original nor the patched shape (i.e. the
 * dependency changed and a human needs to re-check this).
 */

const fs = require('fs');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', 'node_modules', 'hyperframes', 'dist', 'cli.js');

const ORIGINAL = `function canonicalKeyBlob(input2) {
  const durationForKey = Number.isFinite(input2.duration) ? input2.duration : -1;
  const blob = {
    p: input2.videoPath,
    m: input2.mtimeMs,
    s: input2.size,
    ms: input2.mediaStart,
    d: durationForKey,
    f: input2.fps,
    fmt: input2.format
  };
  if (input2.transform !== void 0) blob.t = input2.transform;
  return JSON.stringify(blob);
}`;

const PATCHED = `function __hfContentIdentity(videoPath, size, mtimeMs) {
  const pathIdentity = \`path:\${videoPath}|\${mtimeMs}\`;
  if (process.env.HF_EXTRACT_CACHE_CONTENT_KEY === "0") return pathIdentity;
  const memo = __hfContentIdentity._memo || (__hfContentIdentity._memo = /* @__PURE__ */ new Map());
  const memoKey = \`\${videoPath}\\0\${size}\\0\${mtimeMs}\`;
  const seen = memo.get(memoKey);
  if (seen !== void 0) return seen;
  const WHOLE_FILE_MAX = 256 * 1024 * 1024;
  const CHUNK = 8 * 1024 * 1024;
  let identity = pathIdentity;
  let fd;
  const nodeFs = require("fs");
  try {
    const hash = createHash2("sha256");
    hash.update(\`\${size}\\0\`);
    fd = nodeFs.openSync(videoPath, "r");
    if (size <= WHOLE_FILE_MAX) {
      const buf = Buffer.allocUnsafe(Math.min(size, CHUNK) || 1);
      let pos = 0;
      while (pos < size) {
        const n = nodeFs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        if (n <= 0) break;
        hash.update(buf.subarray(0, n));
        pos += n;
      }
      if (pos !== size) throw new Error("short read");
      identity = \`sha256:\${hash.digest("hex")}\`;
    } else {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (const offset of [0, Math.floor(size / 2), size - CHUNK]) {
        const n = nodeFs.readSync(fd, buf, 0, CHUNK, offset);
        if (n !== CHUNK) throw new Error("short read");
        hash.update(buf.subarray(0, n));
      }
      identity = \`sha256-headmidtail8m:\${hash.digest("hex")}\`;
    }
  } catch {
    identity = pathIdentity;
  } finally {
    if (fd !== void 0) {
      try {
        nodeFs.closeSync(fd);
      } catch {
      }
    }
  }
  memo.set(memoKey, identity);
  return identity;
}
function canonicalKeyBlob(input2) {
  const durationForKey = Number.isFinite(input2.duration) ? input2.duration : -1;
  const blob = {
    c: __hfContentIdentity(input2.videoPath, input2.size, input2.mtimeMs),
    s: input2.size,
    ms: input2.mediaStart,
    d: durationForKey,
    f: input2.fps,
    fmt: input2.format
  };
  if (input2.transform !== void 0) blob.t = input2.transform;
  return JSON.stringify(blob);
}`;

function main() {
    if (!fs.existsSync(CLI_PATH)) {
        // Dependencies not installed yet — nothing to do, and not an error.
        console.log('[patch-hyperframes-cache] hyperframes CLI not present; skipping.');
        return 0;
    }

    const source = fs.readFileSync(CLI_PATH, 'utf8');

    if (source.includes(PATCHED)) {
        console.log('[patch-hyperframes-cache] already patched (content-addressed extract cache).');
        return 0;
    }

    if (!source.includes(ORIGINAL)) {
        console.error('[patch-hyperframes-cache] FAILED: neither the original nor the patched');
        console.error('  canonicalKeyBlob() was found in node_modules/hyperframes/dist/cli.js.');
        console.error('  The dependency almost certainly changed. Re-check whether the extract');
        console.error('  cache key still contains the absolute media path (which makes it miss');
        console.error('  on every render), then update this script.');
        return 1;
    }

    const patched = source.replace(ORIGINAL, PATCHED);
    if (patched === source) {
        console.error('[patch-hyperframes-cache] FAILED: replacement produced no change.');
        return 1;
    }

    fs.writeFileSync(CLI_PATH, patched);
    console.log('[patch-hyperframes-cache] applied: extracted-frame cache is now keyed on the');
    console.log('  clip\'s own bytes instead of its absolute path, so a re-render reuses frames');
    console.log('  instead of re-running ffmpeg over every clip.');
    return 0;
}

process.exit(main());
