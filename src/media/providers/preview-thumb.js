/**
 * Preview Thumbnail URL
 *
 * Every provider gets a free preview picture back from its search API — a
 * poster frame, a small variant, a CDN thumb. Publishing it as `_thumbUrl` is
 * what lets the pre-download thumbnail screen LOOK at a candidate before we
 * spend a full download and a vision score on it.
 *
 * `_thumbUrl` is the field name Storyblocks and YouTube already publish; this
 * module exists so the rest of the providers can join that convention without
 * each one re-implementing the same defensive URL picking.
 *
 * Deliberately shape-tolerant. Provider JSON changes without warning, and a
 * missing preview must degrade to "this candidate cannot be screened" — never
 * to a crash, and never to a wrong URL. Anything that is not a plain http(s)
 * URL is ignored.
 *
 * SIZE MATTERS FOR IMAGE PROVIDERS: only publish a genuinely SMALLER preview.
 * Falling back to the full-resolution URL would make the screen download the
 * very bytes it exists to avoid downloading, turning a saving into a cost.
 * No small preview → publish nothing → that candidate is simply unscreened.
 */

function firstThumbUrl(...candidates) {
    for (const raw of candidates) {
        if (!raw || typeof raw !== 'string') continue;
        const url = raw.trim();
        if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
        return url;
    }
    return '';
}

/**
 * Pick a preview frame from a provider's array of in-clip stills.
 *
 * Frame 0 is routinely a fade-in, a black frame, or a title card, so it is the
 * worst single sample of what a clip actually shows. A middle frame is a truer
 * one, for free.
 */
function midPreviewFrame(frames, pick = (f) => f?.picture) {
    if (!Array.isArray(frames) || frames.length === 0) return '';
    const mid = frames[Math.floor(frames.length / 2)];
    return firstThumbUrl(pick(mid), pick(frames[0]));
}

module.exports = { firstThumbUrl, midPreviewFrame };
