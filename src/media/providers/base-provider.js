const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../settings/config');
const { normalizeUrlForDedup } = require('../../util/url-utils');
const { createByteLimitTransform, requestSafeStream } = require('../../security/safe-download');

// In Electron renderer/preload context axios auto-picks the XHR adapter (XMLHttpRequest is defined),
// which returns ArrayBuffer instead of a Node.js stream — .pipe() fails and User-Agent/Referer are blocked.
// Force the Node.js http adapter so downloads always stream correctly regardless of which process calls us.
// axios v1.x accepts the adapter name as a string ('http' | 'xhr' | 'fetch').
const _HTTP_ADAPTER = 'http';

// Domains known to serve watermarked preview images
const WATERMARK_DOMAINS = [
    'shutterstock.com', 'gettyimages.com', 'istockphoto.com', 'dreamstime.com',
    '123rf.com', 'depositphotos.com', 'alamy.com', 'bigstockphoto.com',
    'stock.adobe.com', 'vectorstock.com', 'canstockphoto.com',
    'photodune.net', 'pond5.com', 'dissolve.com', 'storyblocks.com',
];

// URL path fragments indicating watermarked/preview versions
const WATERMARK_URL_PATTERNS = [
    'watermark', '/preview/', '/comp/', '/sample/', '/wm_', '/_wm',
    '/thumb/', 'stock-photo-', '/editorial-',
];

// Preferred image dimensions. NOT a floor — see filterResults(): an image below
// this is de-ranked to the back of the queue, never discarded. Retrieval is a
// capability floor ("find something for every scene in every niche"); resolution
// is a preference. A soft 640x507 photo beats a black frame.
const MIN_IMAGE_WIDTH = 1280;
const MIN_IMAGE_HEIGHT = 720;

// Ceiling for a still, expressed as a COVER box (see _sanitizeImage).
// 1.5x the 1920x1080 render frame. Unlike video — which the render transcode caps
// at 1080p before anything can magnify it — stills really do get blown up: Ken Burns
// is hard-gated to images (up to ~1.24x) and a zoom-punch transition stacks up to
// 1.16x on top, so the worst realistic case shows a still at ~1.44x. 2880x1620
// covers that ceiling with margin. It is deliberately generous: on a real 40-image
// project exactly ONE file exceeded it, so a tighter box would buy almost nothing
// while risking a visibly soft frame.
const STILL_COVER_WIDTH = 2880;
const STILL_COVER_HEIGHT = 1620;

// Pixel formats we can PROVE carry no alpha channel.
// This is an allowlist on purpose. Anything not on it — a new format, an unparsable
// banner, or `pal8`, whose transparency lives in an optional tRNS chunk and is
// genuinely undecidable from the format name — falls back to PNG, which is exactly
// what this function has always done. An unknown format therefore costs disk, never
// correctness: the failure mode is "we kept the big lossless file", not "we flattened
// someone's transparency onto black".
const OPAQUE_PIX_FMTS = new Set([
    'rgb24', 'bgr24', 'rgb0', 'bgr0', '0rgb', '0bgr',
    'rgb48', 'rgb48be', 'rgb48le', 'bgr48', 'bgr48be', 'bgr48le',
    'rgb444be', 'rgb444le', 'rgb555be', 'rgb555le', 'rgb565be', 'rgb565le',
    'bgr444be', 'bgr444le', 'bgr555be', 'bgr555le', 'bgr565be', 'bgr565le',
    'rgb4', 'rgb8', 'bgr4', 'bgr8', 'monob', 'monow',
    'yuv410p', 'yuv411p', 'yuv420p', 'yuv422p', 'yuv440p', 'yuv444p',
    'yuvj411p', 'yuvj420p', 'yuvj422p', 'yuvj440p', 'yuvj444p',
    'gbrp', 'gbrp9be', 'gbrp9le', 'gbrp10be', 'gbrp10le',
    'gbrp12be', 'gbrp12le', 'gbrp14be', 'gbrp14le', 'gbrp16be', 'gbrp16le',
]);

function _isOpaquePixFmt(pixFmt) {
    if (!pixFmt) return false;
    // gray / gray8 / gray10le / gray16be … all opaque. `ya8` and `ya16` are the
    // grayscale-WITH-alpha formats and deliberately do not match this pattern.
    if (/^gray(\d{1,2}(be|le)?)?$/.test(pixFmt)) return true;
    return OPAQUE_PIX_FMTS.has(pixFmt);
}

function _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            }, { once: true });
        }
    });
}

function _isTransientDownloadError(err) {
    const text = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
    return [
        'econnreset',
        'econnaborted',
        'etimedout',
        'eai_again',
        'enotfound',
        'socket hang up',
        'timeout',
        'network',
        'read aborted',
        'aborted',
        'stream has been aborted',
        'maxcontentlength',
        'http 429',
        'status code 429',
        'status code 500',
        'status code 502',
        'status code 503',
        'status code 504',
    ].some(pattern => text.includes(pattern));
}

function _isAbortSignalLike(signal) {
    return !!signal
        && typeof signal === 'object'
        && typeof signal.addEventListener === 'function'
        && typeof signal.removeEventListener === 'function'
        && 'aborted' in signal;
}

class BaseProvider {
    constructor(name, mediaType) {
        this.name = name;
        this.mediaType = mediaType; // 'video' or 'image'
        this.downloadedIds = new Set();
    }

    /**
     * Check if this provider is available (e.g., API key configured)
     * Override in subclasses
     */
    isAvailable() {
        return true;
    }

    /**
     * Search for media matching keyword
     * Override in subclasses
     * @returns {Array<{id: string, url: string, width?: number, height?: number}>}
     */
    async search(keyword) {
        return [];
    }

    /**
     * Pick first result not already downloaded (dedup by both ID and URL)
     */
    /**
     * Pick first result not already downloaded (dedup by both ID and URL).
     * @param {Array} results - search results
     * @param {Function} [isOverused] - optional callback(url) → boolean, checks global reuse count
     */
    pickUnused(results, isOverused) {
        // Pass 1: find truly unused result
        for (const result of results) {
            const urlKey = result.url ? normalizeUrlForDedup(result.url) : '';
            if (!this.downloadedIds.has(result.id) && !this.downloadedIds.has(urlKey)) {
                this.downloadedIds.add(result.id);
                if (urlKey) this.downloadedIds.add(urlKey);
                return result;
            }
        }
        // Pass 2: all locally used — find one that's NOT globally overused
        if (isOverused) {
            for (const result of results) {
                const url = result._directVideoUrl || result.url;
                if (!isOverused(url)) {
                    return result;
                }
            }
        }
        // Pass 3: everything is used and overused — last resort
        if (results.length > 0) {
            console.log(`  ⚠️ [${this.name}] All results used & overused, reusing least recent`);
            // Walk back past the undersized reserve tail filterResults parks at the
            // end. Without this, "pick last" would mean "pick the smallest" — the
            // exact inversion of the size preference, in the one branch where the
            // pick is already a compromise.
            for (let i = results.length - 1; i >= 0; i--) {
                if (results[i] && !results[i]._undersized) return results[i];
            }
            return results[results.length - 1]; // pick last (least likely to be the repeated one)
        }
        return null;
    }

    /**
     * Download a file from URL to outputPath
     */
    async download(url, outputPath, opts = {}) {
        const attempts = Math.max(1, Math.min(6, Number(opts.downloadRetries || config.network?.mediaDownloadRetries || 2) || 2));
        const abortSignal = _isAbortSignalLike(opts.abortSignal) ? opts.abortSignal : null;
        // Referer fallbacks — some image hosts (ebay, people.com, bookshop, etc.) 403 a
        // cross-origin google referer. On a 403 we retry with the host's own origin, then
        // with no referer at all, before giving up. undefined === default google referer.
        const referers = [undefined];
        try { referers.push(new URL(url).origin + '/'); } catch (_) {}
        referers.push('');
        let refIdx = 0;
        let lastErr = null;
        const maxIters = attempts + referers.length;
        for (let attempt = 1; attempt <= maxIters; attempt++) {
            try {
                return await this._downloadOnce(url, outputPath, { ...opts, referer: referers[Math.min(refIdx, referers.length - 1)] });
            } catch (err) {
                lastErr = err;
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
                const is403 = err?.response?.status === 403 || /\b403\b/.test(String(err.message || ''));
                if (is403 && refIdx < referers.length - 1 && !abortSignal?.aborted) {
                    refIdx++;
                    console.log(`  [${this.name}] 403 on download — retrying with ${refIdx === 1 ? 'host-origin' : 'no'} referer`);
                    continue;
                }
                if (abortSignal?.aborted || !_isTransientDownloadError(err) || attempt >= maxIters) {
                    throw err;
                }
                const delay = config.network?.lowBandwidth
                    ? [2500, 7000, 15000, 25000][Math.min(attempt - 1, 3)]
                    : [1200, 4000][Math.min(attempt - 1, 1)];
                console.log(`  [${this.name}] transient download failure ${attempt}/${maxIters}: ${err.message}; retrying in ${Math.round(delay / 1000)}s`);
                await _sleep(delay, abortSignal);
            }
        }
        throw lastErr || new Error('download failed');
    }

    async _downloadOnce(url, outputPath, opts = {}) {
        const abortSignal = _isAbortSignalLike(opts.abortSignal) ? opts.abortSignal : null;
        if (abortSignal?.aborted) {
            throw new Error('aborted before request');
        }
        const timeoutMs = Math.max(10_000, Number(opts.timeoutMs || config.network?.mediaDownloadTimeoutMs || 45_000) || 45_000);
        const maxBytes = Number(opts.maxBytes) || (
            /\.(?:jpe?g|png|webp|bmp|gif)$/i.test(outputPath)
                ? 80 * 1024 * 1024
                : 2 * 1024 * 1024 * 1024
        );
        const response = await requestSafeStream(url, {
            method: 'GET',
            adapter: _HTTP_ADAPTER, // force Node.js http adapter (avoids XHR adapter in Electron renderer)
            timeout: timeoutMs,
            signal: abortSignal || undefined,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,video/*,*/*;q=0.8',
                // Referer is a fallback strategy (see download()): some hosts 403 a cross-origin
                // google referer, so we may retry with the host's own origin or no referer at all.
                ...(opts.referer === undefined
                    ? { 'Referer': 'https://www.google.com/' }
                    : (opts.referer ? { 'Referer': opts.referer } : {})),
            },
        }, { maxRedirects: 5, maxBytes });

        // Check content-type — reject HTML error pages
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
            throw new Error(`Server returned ${contentType} instead of media`);
        }

        const writer = fs.createWriteStream(outputPath);
        const limiter = createByteLimitTransform(maxBytes);
        response.data.pipe(limiter).pipe(writer);
        limiter.on('error', (error) => {
            try { response.data.destroy(error); } catch (_) {}
            try { writer.destroy(error); } catch (_) {}
        });

        // If the caller aborts mid-stream, tear the stream down and delete the partial file.
        const onAbort = () => {
            try { response.data.destroy(new Error('aborted mid-stream')); } catch (_) {}
            try { writer.destroy(new Error('aborted mid-stream')); } catch (_) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        };
        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
            };
            writer.on('finish', () => {
                cleanup();
                if (abortSignal?.aborted) {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
                    reject(new Error('aborted'));
                    return;
                }
                // Validate file size — reject tiny/empty files
                const stat = fs.statSync(outputPath);
                if (stat.size < 5000) {
                    fs.unlinkSync(outputPath);
                    reject(new Error(`Downloaded file too small (${stat.size} bytes), likely not a valid media file`));
                } else {
                    // Sanitize images to PNG via ffmpeg
                    const finalPath = this._sanitizeImage(outputPath);
                    resolve(finalPath);
                }
            });
            writer.on('error', (err) => { cleanup(); reject(err); });
        });
    }

    /**
     * Read dimensions + pixel format out of ffmpeg's own stream banner.
     *
     * We deliberately do NOT use ffprobe: _sanitizeImage only ever resolves the
     * ffmpeg binary (FFMPEG_PATH / the pinned Windows path), and installs exist
     * that ship one without the other. Asking ffmpeg to open a file with no output
     * makes it print the banner and exit non-zero — that non-zero is expected, so
     * we read stderr rather than the exit status.
     *
     * spawnSync, not execSync, because execSync throws away stderr on a non-zero
     * exit and the banner is the entire point of the call.
     *
     * Returns null whenever anything is unclear. Every caller treats null as
     * "keep the old PNG behaviour".
     */
    _probeImage(filePath, ffmpeg) {
        try {
            const res = spawnSync(ffmpeg, ['-hide_banner', '-i', filePath], {
                encoding: 'utf8', timeout: 15000, windowsHide: true,
            });
            const line = String(res.stderr || '').split('\n').find(l => l.includes('Video:'));
            if (!line) return null;

            // "Stream #0:0: Video: png, rgb24(pc, gbr/unknown/unknown), 1880x1253 [SAR …]"
            const fmt = line.match(/Video:\s*[^,]+,\s*([a-z0-9]+)/i);
            const dim = line.match(/\b(\d{2,5})x(\d{2,5})\b/);
            if (!fmt || !dim) return null;

            return {
                pixFmt: fmt[1].toLowerCase(),
                width: Number(dim[1]),
                height: Number(dim[2]),
            };
        } catch (_) {
            return null;
        }
    }

    /**
     * Re-encode a downloaded image through ffmpeg.
     * Returns the final file path (may differ from input if the extension changed).
     *
     * WHY THIS EXISTS AT ALL (unchanged): web images, especially scraped ones, are
     * routinely WebP or AVIF wearing a .jpg extension, or carry broken headers.
     * Pushing every one through ffmpeg guarantees the bytes and the extension agree
     * before anything downstream tries to decode them.
     *
     * WHAT CHANGED: it used to write PNG unconditionally, which is lossless and
     * therefore enormous — a photo has no flat regions for PNG to compress, so this
     * step INFLATED most downloads. Measured on a real 40-image project: 131.3 MB of
     * PNG, one single photo at 22.2 MB.
     *
     * Now: provably-opaque images become JPEG at -q:v 2; everything else stays PNG.
     * Same real project, same 34 opaque images:
     *
     *     PNG (before)   131.3 MB
     *     JPEG -q:v 2     18.6 MB      7.1x smaller, average PSNR 50.0 dB
     *
     * 50 dB is well inside visually-lossless territory for photographic content, and
     * these images then get scaled, graded, grain-overlaid and re-encoded by the video
     * render anyway — that final encode is a far bigger quality term than this step.
     *
     * On chroma: we do NOT pass -pix_fmt. ffmpeg's mjpeg encoder already picks 4:4:4
     * for an RGB source (verified: the output reports yuvj444p, and forcing yuvj444p
     * produces a byte-identical file). That matters because the web-image lane
     * deliberately fetches images with text baked into them, and 4:2:0 smears coloured
     * text edges. Letting it auto-select also keeps a 4:2:0 source at 4:2:0 instead of
     * paying to upsample chroma that was never there.
     *
     * Transparency is never guessed — see OPAQUE_PIX_FMTS. Unknown or undecidable
     * (notably pal8, whose tRNS chunk is invisible from the format name) keeps PNG.
     */
    _sanitizeImage(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) return filePath;

        const ffmpeg = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
        if (!fs.existsSync(ffmpeg)) return filePath;

        const probe = this._probeImage(filePath, ffmpeg);
        const opaque = !!probe && _isOpaquePixFmt(probe.pixFmt);
        const outExt = opaque ? '.jpg' : '.png';
        const tmpPath = `${filePath}.sanitize${outExt}`;

        // COVER, not fit: scale by max(boxW/w, boxH/h) so the still still fills a
        // 16:9 frame after cropping. Only ever shrinks — the guard requires BOTH
        // dimensions to exceed the box, so a tall or wide image is never touched and
        // nothing is ever upscaled.
        const args = ['-y', '-i', filePath, '-frames:v', '1'];
        if (probe && probe.width > STILL_COVER_WIDTH && probe.height > STILL_COVER_HEIGHT) {
            const factor = Math.max(STILL_COVER_WIDTH / probe.width, STILL_COVER_HEIGHT / probe.height);
            const even = (n) => Math.max(2, Math.round(n / 2) * 2);
            args.push('-vf', `scale=${even(probe.width * factor)}:${even(probe.height * factor)}:flags=lanczos`);
        }
        if (opaque) args.push('-q:v', '2');
        args.push(tmpPath);

        try {
            const res = spawnSync(ffmpeg, args, { stdio: 'pipe', timeout: 20000, windowsHide: true });
            if (res.error) throw res.error;

            if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                const finalPath = filePath.replace(/\.[^.]+$/, outExt);
                fs.copyFileSync(tmpPath, finalPath);
                fs.unlinkSync(tmpPath);
                if (finalPath !== filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                console.log(`  🔧 Sanitized to ${opaque ? 'JPEG' : 'PNG'}: ${path.basename(finalPath)}`);
                return finalPath;
            } else {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                return filePath;
            }
        } catch (e) {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            return filePath;
        }
    }

    /**
     * Check if a URL likely points to a watermarked image from a stock site
     */
    isWatermarked(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        for (const domain of WATERMARK_DOMAINS) {
            if (lower.includes(domain)) return true;
        }
        for (const pattern of WATERMARK_URL_PATTERNS) {
            if (lower.includes(pattern)) return true;
        }
        return false;
    }

    /**
     * Is this image below the preferred resolution? A PREFERENCE test, not a
     * reject test — filterResults uses it to sort, not to drop.
     *
     * Unknown dimensions deliberately answer "no". Bing and Brave — the two
     * keyless providers that carry the long tail of retrieval — usually report
     * no size at all, and Pexels/Pixabay report the ORIGINAL's size while
     * serving a smaller rendition. Treating "unknown" as small would demote
     * exactly the providers that find the hard scenes, for a reason that has
     * nothing to do with pixels.
     */
    isTooSmall(result) {
        if (this.mediaType !== 'image') return false;
        if (!result || !result.width || !result.height) return false; // unknown size → neutral
        return result.width < MIN_IMAGE_WIDTH || result.height < MIN_IMAGE_HEIGHT;
    }

    /**
     * Drop unusable results (watermarked) and DE-RANK undersized ones.
     * Called by footage-manager after search().
     *
     * Small images are moved to the back of the queue, not removed: everything
     * downstream (the race pool cut at footage-manager, pickUnused, the hunter
     * rank) reads this list as a priority order and takes from the front, so a
     * full-size image wins whenever one exists — but when the only thing on the
     * web for a scene is a 640px photo, the scene still gets media instead of
     * nothing. Watermarks stay a hard reject: a watermarked frame is unusable
     * at any resolution.
     *
     * Order among the accepted (full-size) group is untouched, so a search that
     * turns up no small images returns exactly what it returned before.
     */
    filterResults(results) {
        if (!Array.isArray(results)) return [];
        const preferred = [];
        const reserve = [];
        for (const r of results) {
            if (!r) continue;
            if (this.isWatermarked(r.url)) continue;
            if (this.isTooSmall(r)) {
                r._undersized = true;
                reserve.push(r);
            } else {
                preferred.push(r);
            }
        }
        if (!reserve.length) return preferred;
        console.log(`  ↓ [${this.name}] ${reserve.length} small image(s) moved to the back of the queue (reserve — used only if nothing bigger works)`);
        return preferred.concat(reserve);
    }

    /**
     * Reset the downloaded IDs tracker
     */
    reset() {
        this.downloadedIds.clear();
    }
}

module.exports = BaseProvider;
