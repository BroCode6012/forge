/*
 * RENDITION PICKER — "take the smallest file that still fills the frame"
 *
 * WHY THIS EXISTS
 * Stock APIs hand back the same clip in several sizes. Both stock video providers
 * used to grab the LARGEST one unconditionally. That was pure waste, and provably
 * so: every scene video passes through
 *
 *     scale=1920:1080:force_original_aspect_ratio=decrease
 *
 * in `render/hyperframes-bridge.js:transcodeVideoForHyperframes` BEFORE anything
 * else touches it. That filter fits the source inside a 1920x1080 box, so a
 * 3840x2160 master is downscaled to exactly 1920x1080 and every pixel above that
 * is discarded by ffmpeg. Nothing downstream can recover them either — Ken Burns
 * is hard-gated to images, and the zoom-punch / zoom-pull motion transitions
 * (max 1.16x / 1.14x) run on the ALREADY-CAPPED 1080p frame, so a bigger download
 * cannot make them sharper.
 *
 * Measured on a real project: four Pexels clips, all 3840x2160, totalling 984 MB,
 * backing 21.4 seconds of finished video. One 539 MB file was used for a 5.2 s cut.
 *
 * WHAT IT COSTS — MEASURED, NOT ASSUMED
 * The saving is NOT free, and it would be dishonest to pretend otherwise. Downscaling
 * a 4K master to 1080 supersamples it, which beats the site's own direct 1080 encode.
 * Pexels clip 9338500, every rung pushed through the exact transcode above and scored
 * against a lossless 4K->1080 reference:
 *
 *     source rung     download     PSNR vs best possible
 *     3840x2160        97 MB            42.0 dB
 *     2560x1440        48 MB            40.1 dB
 *     1920x1080        24 MB            38.1 dB
 *
 * So 4x the bytes buys 3.9 dB. For scale, re-encoding the SAME source at crf 12
 * instead of crf 18 scores 43.6 dB — i.e. the crf-18 transcode is a bigger quality
 * term than the source resolution, and no rung can get past it. 3.9 dB is visible in
 * a paused 200%-zoom A/B and essentially invisible in a 5-second moving shot that
 * then takes a film grade, a baked grain overlay and a transition on top.
 *
 * 1080 is the default because that is where the trade turns bad. If you decide the
 * sharpness is worth it, STOCK_VIDEO_MAX_HEIGHT=1440 recovers half the gap for half
 * the extra bytes — but raise the transcode target with it or ffmpeg just throws the
 * extra rows away again and you pay for nothing.
 *
 * THE RULE
 * A rendition is "render ready" when the fit-inside step would not have to UPSCALE
 * it, i.e. width >= 1920 OR height >= 1080. (Fit-inside scales by
 * min(1920/w, 1080/h); that is <= 1 exactly when one of those two holds — which is
 * why a 4:3 source qualifies on height alone and a 2.35:1 source on width alone.)
 * Among the render-ready ones we take the SMALLEST. If none qualify — the clip was
 * only ever uploaded at 720p — we fall back to the largest available, which is
 * exactly the old behaviour. This is a capability floor, never a ceiling: the cap
 * can only ever make us download a file we would have thrown pixels away from, and
 * can never remove a clip from the running.
 *
 * NO TOLERANCE ON PURPOSE. It is tempting to accept "close enough" renditions
 * (a 1706x960 that needs a 12% upscale) because the next rung up is often 4x the
 * bytes. We don't, because we are already spending real quality above and an upscale
 * would spend more. The strict test costs nothing in practice: Pexels ships an exact
 * 1920x1080 for anything uploaded above it, so it lands on the cheap rung anyway.
 *
 * OVERRIDE: STOCK_VIDEO_MAX_HEIGHT. 0 disables the picker entirely (largest wins,
 * exactly the old behaviour). 1440 buys back half the quality gap. Whatever you set,
 * the render transcode target must move with it or ffmpeg discards the extra rows.
 */

'use strict';

// Mirrors the scale filter in render/hyperframes-bridge.js:transcodeVideoForHyperframes.
// If that filter changes, change these (or set STOCK_VIDEO_MAX_HEIGHT).
const RENDER_BOX_WIDTH = 1920;
const RENDER_BOX_HEIGHT = 1080;

function _renderBox() {
    const raw = process.env.STOCK_VIDEO_MAX_HEIGHT;
    if (raw === undefined || raw === '') return { w: RENDER_BOX_WIDTH, h: RENDER_BOX_HEIGHT };
    const h = Number(raw);
    if (!Number.isFinite(h) || h <= 0) return null; // explicitly uncapped
    return { w: Math.round(h * (16 / 9)), h: Math.floor(h) };
}

function _area(c) {
    return (Number(c?.width) || 0) * (Number(c?.height) || 0);
}

/**
 * Pick the cheapest rendition that still fills the render frame.
 *
 * @param {Array<{width?:number|string, height?:number|string}>} candidates
 *        Renditions of ONE clip. Extra fields are preserved — the chosen object is
 *        returned as-is, so callers keep reporting the dimensions they actually got.
 * @param {{ prefer?: (c:any) => boolean }} [opts]
 *        `prefer` marks renditions that win ties regardless of size (used for mp4 over
 *        webm/mov: a non-mp4 that is 5 MB smaller is not worth a container gamble).
 * @returns {any|null} the chosen rendition, or null if `candidates` is empty.
 */
function pickRenderRendition(candidates, opts = {}) {
    const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
    if (!list.length) return null;

    const prefer = typeof opts.prefer === 'function' ? opts.prefer : null;
    // Preferred containers form their own pool. We only drop back to the
    // non-preferred pool when the preferred one has nothing at all.
    const pool = prefer && list.some(prefer) ? list.filter(prefer) : list;

    const box = _renderBox();
    if (!box) return pool.slice().sort((a, b) => _area(b) - _area(a))[0]; // uncapped: largest wins

    const ready = pool.filter((c) => {
        const w = Number(c.width) || 0;
        const h = Number(c.height) || 0;
        return w >= box.w || h >= box.h;
    });

    if (ready.length) return ready.sort((a, b) => _area(a) - _area(b))[0]; // smallest that qualifies
    return pool.slice().sort((a, b) => _area(b) - _area(a))[0];            // nothing qualifies: largest
}

module.exports = { pickRenderRendition };
