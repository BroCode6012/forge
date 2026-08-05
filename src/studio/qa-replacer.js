/**
 * QA Replacer — surgical scene replacement triggered by QA Studio "Apply Fixes".
 *
 * Given a flagged scene with qaReplacementKeyword + qaReplacementSource,
 * downloads new footage using the existing footage-manager pipeline,
 * then replaces the scene's media asset. Same-type replacements keep the path;
 * manual fallback retries may switch extensions and update the scene metadata.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { sanitizeSourceHint } = require('../media/source-policy');
const { requestSafeBuffer } = require('../security/safe-download');

function _isPathWithin(rootPath, candidatePath) {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    if (process.platform === 'win32') {
        const rootLower = root.toLowerCase();
        const candidateLower = candidate.toLowerCase();
        return candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep);
    }
    return candidate === root || candidate.startsWith(root + path.sep);
}

function _resolveAllowedMediaDestination(mediaFile) {
    const projectDir = path.resolve(process.env.PROJECT_DIR || process.cwd());
    const roots = [
        path.join(projectDir, 'public'),
        path.join(projectDir, 'temp'),
        path.join(projectDir, 'assets'),
    ].filter((root) => fs.existsSync(root));
    const candidates = path.isAbsolute(String(mediaFile || ''))
        ? [String(mediaFile)]
        : roots.map((root) => path.join(root, String(mediaFile || '')));

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
            const realCandidate = fs.realpathSync.native(candidate);
            const allowed = roots.some((root) => _isPathWithin(fs.realpathSync.native(root), realCandidate));
            if (allowed) return realCandidate;
        } catch (_) {
            // Try the next candidate.
        }
    }
    return null;
}

function _normalizeMediaExtension(ext, mediaType = 'video') {
    const clean = String(ext || '').trim().toLowerCase();
    const allowed = new Set(['.mp4', '.mov', '.mkv', '.webm', '.jpg', '.jpeg', '.png', '.webp']);
    if (allowed.has(clean)) return clean;
    return mediaType === 'image' ? '.jpg' : '.mp4';
}

function _resolveReplacementTarget(existingMediaFile, downloadedExt, mediaType, allowExtensionChange) {
    const existingExt = path.extname(existingMediaFile).toLowerCase();
    const nextExt = _normalizeMediaExtension(downloadedExt, mediaType);
    if (!allowExtensionChange || existingExt === nextExt) return existingMediaFile;
    return path.join(
        path.dirname(existingMediaFile),
        `${path.basename(existingMediaFile, existingExt)}${nextExt}`
    );
}

function _updateSceneReplacementMetadata(scene, result, targetPath, keyword, sourceHint, requestedMediaType) {
    if (!scene) return;
    const ext = _normalizeMediaExtension(result?.ext || path.extname(targetPath), requestedMediaType);
    const actualMediaType = result?.mediaType
        || (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? 'image' : 'video');
    const provider = result?.provider || 'QA Media Replacement';
    const visionScore = Number(result?.visionScore);
    const width = Number(result?.mediaWidth ?? result?.width);
    const height = Number(result?.mediaHeight ?? result?.height);

    scene.mediaFile = targetPath;
    if (Object.prototype.hasOwnProperty.call(scene, 'mediaPath')) scene.mediaPath = targetPath;
    if (Object.prototype.hasOwnProperty.call(scene, 'assetFile')) scene.assetFile = targetPath;
    if (Object.prototype.hasOwnProperty.call(scene, 'assetPath')) scene.assetPath = targetPath;
    scene.mediaExtension = ext;
    scene.mediaType = actualMediaType;
    scene.sourceProvider = provider;
    scene.mediaDownloadStatus = 'accepted';
    scene.keyword = keyword;
    scene.searchKeyword = keyword;
    if (sourceHint) scene.sourceHint = sourceHint;
    if (Number.isFinite(visionScore)) scene.visionScore = visionScore;
    else delete scene.visionScore;

    if (width > 0 && height > 0) {
        scene.mediaWidth = width;
        scene.mediaHeight = height;
        scene.aspectRatio = width / height;
        scene.isVertical = height > width;
    }

    if (scene.mediaDiagnostics) {
        scene.mediaDiagnostics.final = {
            ...(scene.mediaDiagnostics.final || {}),
            status: 'accepted',
            provider,
            path: targetPath,
            mediaType: actualMediaType,
            visionScore: Number.isFinite(visionScore) ? visionScore : undefined,
            reason: Number.isFinite(visionScore)
                ? `manual retry accepted at ${visionScore}/10`
                : 'manual retry accepted',
        };
        scene.mediaDiagnostics.completedAt = new Date().toISOString();
    }
    scene._retryReplacement = {
        at: new Date().toISOString(),
        keyword,
        provider,
        mediaType: actualMediaType,
    };
}

// Lazy-require to avoid loading heavy provider modules until needed
let _footageManagerLoaded = false;
let _downloadMedia, _initProviders;

function _ensureLoaded() {
    if (_footageManagerLoaded) return;
    const fm = require('../media/footage-manager');
    _downloadMedia  = fm.downloadMedia;
    _initProviders  = fm.initProviders;
    _footageManagerLoaded = true;
}

/**
 * Replace a single scene's media file using AI-suggested keyword + source.
 *
 * @param {Object} params
 * @param {string} params.mediaFile         - Absolute path to the current scene file (will be overwritten)
 * @param {string} params.keyword           - qaReplacementKeyword from QA result
 * @param {string} params.sourceHint        - qaReplacementSource (storyblocks/youtube/reddit/...)
 * @param {string} params.mediaType         - 'video' | 'image'
 * @param {number} params.sceneDuration     - Scene duration in seconds
 * @param {Object} params.scriptContext     - Full scriptContext from video-plan.json (for provider context)
 * @param {Function} [params.onProgress]    - (message: string) => void
 * @returns {Promise<{success: boolean, newFile?: string, error?: string}>}
 */
async function replaceSceneMedia({
    mediaFile,
    keyword,
    sourceHint,
    mediaType = 'video',
    sceneDuration = 8,
    scriptContext = {},
    scene = null,
    onProgress,
    allowExtensionChange = false,
}) {
    const log = onProgress || (() => {});
    const allowedMediaFile = _resolveAllowedMediaDestination(mediaFile);
    if (!allowedMediaFile) {
        return { success: false, error: 'Replacement destination must be an existing media file inside the active project' };
    }
    mediaFile = allowedMediaFile;
    _ensureLoaded();
    const ext = mediaType === 'video' ? '.mp4' : '.jpg';
    const tmpBase = 'qa-replacement-' + Date.now();
    const safeSourceHint = sanitizeSourceHint(sourceHint || '', mediaType === 'image' ? 'web-image' : 'youtube') || '';

    try {
        // Init providers with script context (sets API keys, niche, etc.)
        _initProviders(scriptContext);
        log(`Searching "${keyword}" via ${sourceHint || 'default'}…`);

        // Temporarily lower clip reject threshold for QA replacements —
        // the QA agent already verified what we need, so be more permissive than the build pipeline
        const origThreshold = process.env.CLIP_ANALYZER_REJECT_THRESHOLD;
        let downloaded = null;
        try {
            process.env.CLIP_ANALYZER_REJECT_THRESHOLD = '2';

            if (scene) {
                delete scene._aborted;
                delete scene._abortSignal;
                delete scene._timeoutFired;
                delete scene._inFlightCandidate;
                delete scene._inFlightCandidateReason;
                delete scene._inFlightCandidateReasons;
                delete scene._inFlightCandidateCount;
                delete scene._inFlightCandidateSince;
            }

            downloaded = await _downloadMedia(
                keyword,
                mediaType,
                tmpBase,
                sceneDuration,
                safeSourceHint,
                scriptContext.nicheId || '',
                scene || null
            );
        } finally {
            if (origThreshold !== undefined) process.env.CLIP_ANALYZER_REJECT_THRESHOLD = origThreshold;
            else delete process.env.CLIP_ANALYZER_REJECT_THRESHOLD;
        }

        // downloadMedia returns { path, ext, provider, visionScore, ... } — extract the file path
        const downloadedPath = downloaded?.path || downloaded;

        if (!downloadedPath || typeof downloadedPath !== 'string') {
            const err = `No result for "${keyword}" — all providers failed or clip rejected by vision scoring`;
            console.error('[QA Replacer]', err, '| raw result:', downloaded);
            return { success: false, error: err };
        }
        if (!fs.existsSync(downloadedPath)) {
            const err = `Downloaded path does not exist on disk: ${downloadedPath}`;
            console.error('[QA Replacer]', err);
            return { success: false, error: err };
        }

        const downloadedExt = downloaded?.ext || path.extname(downloadedPath) || ext;
        const targetPath = _resolveReplacementTarget(
            mediaFile,
            downloadedExt,
            downloaded?.mediaType || mediaType,
            allowExtensionChange
        );
        log(`Downloaded → ${path.basename(downloadedPath)} (score: ${downloaded?.visionScore ?? '?'}), replacing ${path.basename(mediaFile)}…`);
        console.log('[QA Replacer] Copying:', downloadedPath, '→', targetPath);

        // Ensure destination directory exists
        const destDir = path.dirname(targetPath);
        if (!fs.existsSync(destDir)) {
            const err = `Destination folder does not exist: ${destDir}`;
            console.error('[QA Replacer]', err);
            return { success: false, error: err };
        }

        // Use copy+delete instead of rename to handle cross-drive moves (D:\temp → C:\public)
        //
        // Unlink the target FIRST rather than copying over it. Generated HyperFrames
        // project dirs hardlink this file instead of duplicating it (see
        // render/hyperframes-bridge.js:linkOrCopy), and a copy onto an existing path
        // writes through the shared inode — so replacing a scene's footage would silently
        // rewrite the media inside every preview/render folder that still references the
        // old clip, including one mid-capture. Unlinking drops just this directory entry
        // and leaves those builds intact; the copy then creates a fresh, unshared file.
        try { fs.unlinkSync(targetPath); } catch (_) { /* absent or busy — copy still lands */ }
        fs.copyFileSync(downloadedPath, targetPath);
        const copied = fs.statSync(targetPath);
        if (!copied.isFile() || copied.size <= 0) {
            throw new Error(`Replacement copy is empty: ${targetPath}`);
        }
        try { fs.unlinkSync(downloadedPath); } catch (_) { /* temp cleanup — non-fatal */ }
        if (targetPath !== mediaFile) {
            try { fs.unlinkSync(mediaFile); } catch (_) { /* old fallback cleanup — non-fatal */ }
        }

        _updateSceneReplacementMetadata(
            scene,
            downloaded,
            targetPath,
            keyword,
            safeSourceHint,
            mediaType
        );

        log(`Replaced ${path.basename(targetPath)} ✓`);
        console.log('[QA Replacer] ✅ Success:', targetPath);
        return {
            success: true,
            newFile: targetPath,
            ext: _normalizeMediaExtension(downloadedExt, mediaType),
            mediaType: scene?.mediaType || downloaded?.mediaType || mediaType,
            provider: downloaded?.provider || scene?.sourceProvider || 'QA Media Replacement',
            visionScore: Number.isFinite(Number(downloaded?.visionScore)) ? Number(downloaded.visionScore) : undefined,
            mediaWidth: Number(downloaded?.mediaWidth ?? downloaded?.width) || 0,
            mediaHeight: Number(downloaded?.mediaHeight ?? downloaded?.height) || 0,
        };

    } catch (err) {
        console.error('[QA Replacer] Error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Re-screenshot an articleHighlight MG by searching for a new article URL
 * and taking a fresh thum.io screenshot, overwriting the existing image file.
 *
 * @param {Object} params
 * @param {string} params.imageFile       - Absolute path to the existing article PNG (will be overwritten)
 * @param {string} params.keyword         - New search keyword (from QA replacement suggestion)
 * @param {string} params.headline        - MG headline text (used as fallback search query)
 * @param {string} params.subtext         - MG subtext (improves article search accuracy)
 * @param {Function} [params.onProgress]  - (message: string) => void
 * @returns {Promise<{success: boolean, articleUrl?: string, error?: string}>}
 */
async function rescreenhotArticle({ imageFile, keyword, headline, subtext, mgScene, onProgress }) {
    const log = onProgress || (() => {});
    const fs   = require('fs');
    const path = require('path');

    try {
        const articleImage = require('../media/article-image');
        const searchTerm = keyword || headline || '';
        if (!searchTerm) return { success: false, error: 'No search keyword or headline provided' };

        // Ensure destination exists before downloading
        const destDir = path.dirname(imageFile);
        if (!fs.existsSync(destDir)) return { success: false, error: `Destination folder missing: ${destDir}` };

        // Try up to 3 different article URLs — skip ones that produce error/blank screenshots
        log(`Searching for article: "${searchTerm}"…`);
        const { items: searchItems } = await _searchMultipleArticles(articleImage, searchTerm, subtext || '');
        if (!searchItems || searchItems.length === 0) return { success: false, error: `No article found for "${searchTerm}"` };

        let savedData = null;
        let usedUrl   = null;

        for (const articleUrl of searchItems) {
            log(`Trying: ${articleUrl.substring(0, 70)}…`);
            const screenshotUrl = articleImage.getScreenshotUrl(articleUrl);

            let response = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    if (attempt > 1) log(`thum.io timed out — retrying…`);
                    response = await requestSafeBuffer(screenshotUrl, {
                        method: 'GET',
                        adapter: 'http',
                        timeout: 90000,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                    }, { maxRedirects: 5, maxBytes: 40 * 1024 * 1024 });
                    break;
                } catch (_) { if (attempt === 2) { response = null; } }
            }

            if (!response?.data || response.data.byteLength < 10000) {
                log(`Too small or no response — skipping`);
                continue;
            }

            // Heuristic: a mostly-white/blank image is probably an error/paywall page.
            // Check: if file is tiny (<30KB) it's likely a placeholder — skip it.
            if (response.data.byteLength < 30000) {
                log(`Screenshot too small (${Math.round(response.data.byteLength/1024)}KB) — likely error page, skipping`);
                continue;
            }

            savedData = Buffer.from(response.data);
            usedUrl   = articleUrl;
            break;
        }

        if (!savedData) return { success: false, error: 'All candidate articles produced error/blank screenshots' };

        fs.writeFileSync(imageFile, savedData);
        log(`Article screenshot saved → ${path.basename(imageFile)} ✓`);
        console.log('[QA Replacer] ✅ Article re-screenshot:', imageFile, '| URL:', usedUrl);

        // Always clear stale highlight boxes — they were analyzed for the OLD article image.
        // New boxes will be re-analyzed by QA Studio after compositor reloads the new image.
        if (mgScene) {
            delete mgScene.highlightBoxes;
            log('Cleared stale highlight boxes (will re-analyze on next QA run)');
        }

        return { success: true, articleUrl: usedUrl };

    } catch (err) {
        console.error('[QA Replacer] rescreenhotArticle error:', err);
        return { success: false, error: err.message };
    }
}

// Collect multiple candidate article URLs for fallback iteration
async function _searchMultipleArticles(articleImage, keyword, subtext) {
    const { searchWeb } = require('../media/web-search-client');
    const SKIP_DOMAINS = require('../media/article-image').__SKIP_DOMAINS || [];

    try {
        const { items } = await searchWeb(`${keyword} news article`, {
            num: 8,
            timeout: 15000,
            providerOrder: ['tavily', 'googleCSE'],
        });
        const urls = items
            .map(i => i.link || '')
            .filter(u => u && !SKIP_DOMAINS.some(d => u.toLowerCase().includes(d)));
        if (urls.length > 0) return { items: urls };
    } catch (_) {}

    // Fallback: single URL from existing helper
    const url = await articleImage.findArticleUrl(keyword, subtext);
    return { items: url ? [url] : [] };
}

module.exports = {
    replaceSceneMedia,
    rescreenhotArticle,
    _resolveReplacementTarget,
    _updateSceneReplacementMetadata,
};
