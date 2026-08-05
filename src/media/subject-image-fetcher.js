/**
 * Subject Image Fetcher
 *
 * On-demand single-image fetch for the composition author (v9 asset pipe):
 * when a template/fullscreen-MG beat names an entity (Director-tagged in
 * scriptContext.entities) but the footage pipeline left no image for that
 * beat, fetch ONE subject photo from the live web-image providers
 * (Bing → Brave) so the author can build a subject-board / photo-panel
 * composition instead of a designed-background-only card.
 *
 * Deterministic disk cache: <destDir>/subject-<slug>.png — the same entity
 * across scenes (and across project reopens) downloads exactly once.
 * Provider downloads inherit base-provider floors (size check, PNG
 * sanitize, watermark-hostile headers).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BingImageProvider = require('./providers/bing-image');
const BraveImageProvider = require('./providers/brave-image');

let _providers = null;
function getProviders() {
    if (!_providers) {
        _providers = [new BingImageProvider(), new BraveImageProvider()]
            .filter(p => { try { return p.isAvailable(); } catch (_) { return false; } });
    }
    return _providers;
}

function slugify(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * fetchSubjectImage({ query, destDir }) → absolute png path or null.
 * Never throws — graceful degradation (the author just designs without it).
 */
async function fetchSubjectImage({ query, destDir, log = console.log }) {
    const q = String(query || '').trim();
    if (!q || !destDir) return null;
    const slug = slugify(q);
    if (!slug) return null;
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) { /* exists */ }

    // Probe every extension the sanitizer can emit, not just .png. The download
    // below asks for `subject-<slug>.png`, but base-provider._sanitizeImage returns
    // a possibly-different path — an opaque image comes back as .jpg. A .png-only
    // probe would therefore never hit the cache and would silently re-download and
    // re-score the same subject on every run.
    for (const cachedExt of ['.png', '.jpg']) {
        const cached = path.join(destDir, `subject-${slug}${cachedExt}`);
        if (fs.existsSync(cached)) return cached;
    }

    for (const provider of getProviders()) {
        let results = [];
        try { results = await provider.search(q); } catch (e) {
            log(`  ⚠️ [Subject Image] ${provider.name} search failed for "${q}": ${String(e.message || e).slice(0, 80)}`);
            continue;
        }
        if (!Array.isArray(results) || !results.length) continue;
        // Prefer larger results when dimensions are known (subject photos go
        // in big framed panels — thumbnails pixelate). Watermarked stock
        // previews are rejected up front (bg-removal turns them into ghosts).
        const ranked = [...results]
            .filter(r => r && r.url && !(typeof provider.isWatermarked === 'function' && provider.isWatermarked(r.url)))
            .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
        for (const r of ranked.slice(0, 4)) {
            if (!r || !r.url) continue;
            try {
                const finalPath = await provider.download(r.url, path.join(destDir, `subject-${slug}.png`), { timeoutMs: 30000 });
                if (finalPath && fs.existsSync(finalPath)) {
                    log(`  📸 [Subject Image] "${q}" → ${path.basename(finalPath)} (${provider.name})`);
                    return finalPath;
                }
            } catch (_) { /* next result */ }
        }
    }
    return null;
}

/**
 * Pick the subject entity for a beat: the Director-tagged entity that
 * appears in the beat's own text, ranked person > org > event > place
 * (people are what the footage pipeline most often misses), then by name
 * specificity. Returns { name, type } or null.
 */
const TYPE_RANK = { person: 0, people: 0, org: 1, organization: 1, event: 2, place: 3 };

function pickSubjectEntity(beatText, scriptContext = {}) {
    const text = String(beatText || '').toLowerCase();
    if (!text.trim()) return null;
    const entities = Array.isArray(scriptContext.entities) ? scriptContext.entities : [];
    const types = scriptContext.entityTypes || {};
    const hits = [];
    for (const ent of entities) {
        const name = String(ent || '').trim();
        if (name.length < 3) continue;
        const lower = name.toLowerCase();
        let matched = false;
        try {
            matched = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
        } catch (_) { matched = text.includes(lower); }
        if (!matched) continue;
        const type = String(types[lower] || '').toLowerCase();
        hits.push({ name, type, rank: TYPE_RANK[type] ?? 4 });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.rank - b.rank || b.name.length - a.name.length);
    return hits[0];
}

module.exports = { fetchSubjectImage, pickSubjectEntity, slugify };
