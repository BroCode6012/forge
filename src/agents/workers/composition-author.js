/**
 * Composition Author Worker
 *
 * The editor agent's generative MG pass: instead of rendering template /
 * fullscreen-MG scenes through fixed canned markup, the agent AUTHORS a
 * bespoke composition (html/css/gsap) per scene via hf-template-author
 * (skill pack: skills/hyperframes-template/). Runs at render-prep time on
 * the FINAL plan — durations and theme are settled, and the attached
 * `_authoredComposition` lands on the exact objects the HyperFrames bridge
 * reads (plan.templateScenes / plan.mgScenes).
 *
 * Scope: templates + fullscreen MGs + overlay MGs (overlays added June 12
 * under OVERLAY MODE rules — transparent stage, coverage budget, no media).
 * Map charts are excluded — they have their own dedicated builder
 * (map-hf-builder). Branded/system overlays (subscribe CTA, listicle
 * counter, captions) keep their dedicated renderers.
 *
 * Graceful degradation: any scene the author fails on simply keeps the
 * fixed-template renderer. Nothing ships empty.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    authorCompositions,
    normalizeAuthoredTimeline,
    validateComposition,
} = require('../../render/hf-template-author');
const {
    clearAuthoredComposition,
    prefersFixedRenderer,
} = require('../../render/authored-composition-policy');
let directSceneEffects = null;
try { ({ directSceneEffects } = require('./effects-director')); } catch (_) { directSceneEffects = null; }
let directTransitions = null;
try { ({ directTransitions } = require('./transition-director')); } catch (_) { directTransitions = null; }
let directIcons = null;
try { ({ directIcons } = require('./icon-director')); } catch (_) { directIcons = null; }
let directKeywordGlow = null;
try { ({ directKeywordGlow } = require('./keyword-glow')); } catch (_) { directKeywordGlow = null; }
let authorCharacterScenes = null;
try { ({ authorCharacterScenes } = require('../../render/hf-character-rig')); } catch (_) { authorCharacterScenes = null; }

// Types that keep their dedicated renderer in v1.
const EXCLUDED_TYPES = new Set([
    'map-chart', 'mapchart', 'explainerimage', 'explainer-image', 'explainer',
    // media-dependent templates (need real photo/video assets):
    'image-showcase', 'imageshowcase', 'person-intro', 'personintro',
    'split-screen', 'splitscreen',
]);

// Overlay types that keep their dedicated renderer: branded/system elements.
// NOTE: listicle-counter is NOT excluded — for listicle videos the counter MGs are
// created structurally (timed to spokenTime) and the editor AUTHORS them here with its
// HyperFrames creativity (forced on listicle item scenes), so they look bespoke + on-brand.
const OVERLAY_EXCLUDED_TYPES = new Set([
    'subscribe-cta', 'subscribecta',
    'progress-tracker', 'progresstracker', 'caption',
]);

function overlaysDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_AUTHOR_OVERLAYS || '').trim());
}

function toSec(v, dflt = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
}

function visualDurationSeconds(mg, fallback = 5) {
    const rangeSourceDuration = Number(mg?._renderRangeClip?.sourceDuration);
    if (Number.isFinite(rangeSourceDuration) && rangeSourceDuration > 0) {
        return Math.max(1.2, Math.min(20, rangeSourceDuration));
    }
    const start = toSec(mg?.startTime, toSec(mg?.start, 0));
    const end = toSec(mg?.endTime, toSec(mg?.end, NaN));
    if (Number.isFinite(end) && end > start) {
        return Math.max(1.2, Math.min(20, end - start));
    }
    const duration = [
        mg?._hfTiming?.duration,
        mg?.durationSeconds,
        mg?.displayDuration,
        mg?.templateDuration,
        mg?.visualDuration,
        mg?.duration,
    ]
        .map(value => Number(value))
        .find(value => Number.isFinite(value) && value > 0 && value <= 20);
    return Math.max(1.2, Math.min(20, duration || fallback));
}

function normType(mg) {
    // templateType is a BOOLEAN flag on templateScenes (the actual type lives
    // in mg.type, e.g. "keyTakeaway") — only accept string-valued fields.
    const cand = [mg.templateType, mg.type, mg.mgType].find(v => typeof v === 'string' && v.trim());
    return String(cand || '')
        .replace(/_/g, '-')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // camelCase → kebab for the exclusion set
        .toLowerCase();
}

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_TEMPLATE_AUTHOR || '').trim());
}

function ownerSceneOf(plan, mg) {
    const start = toSec(mg.startTime), end = toSec(mg.endTime, start + 4);
    const mid = (start + end) / 2;
    return (plan.scenes || []).find(s => s && toSec(s.startTime) <= mid && toSec(s.endTime) >= mid) || null;
}

function ownerNarration(plan, mg) {
    const owner = ownerSceneOf(plan, mg);
    return owner ? String(owner.text || '').slice(0, 400) : '';
}

// ── Asset pipe (v9): real images the author may place in the composition ──
// Token contract: the brief lists `__HF_ASSET_i__` placeholders; the author
// uses the token verbatim as src/url; the bridge substitutes the real copied
// media path at render time (mg._authoredAssets carries the absolute paths).
// Images only in v9 — <video> needs runtime seek-sync the authored path
// doesn't have yet.
const AUTHOR_IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function nearestFootageScene(plan, mg) {
    const start = toSec(mg.startTime), end = toSec(mg.endTime, start + 4);
    const mid = (start + end) / 2;
    let best = null, bestDist = 12.01; // only within 12s — same story beat
    for (const s of (plan.scenes || [])) {
        if (!s || !s.mediaFile) continue;
        const dist = Math.max(0, Math.max(toSec(s.startTime) - mid, mid - toSec(s.endTime)));
        if (dist < bestDist) { best = s; bestDist = dist; }
    }
    return best;
}

function resolveBriefAssets(plan, mg) {
    const out = [];
    const seen = new Set();
    const push = (file, desc) => {
        if (!file || out.length >= 2) return;
        const abs = String(file);
        const ext = path.extname(abs).toLowerCase();
        if (!AUTHOR_IMG_EXTS.has(ext)) return;
        if (seen.has(abs)) return;
        try { if (!fs.existsSync(abs)) return; } catch (_) { return; }
        seen.add(abs);
        out.push({
            token: `__HF_ASSET_${out.length}__`,
            path: abs,
            kind: 'image',
            desc: String(desc || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        });
    };
    // 1) the MG's own media (templates usually carry one after Step 6.5).
    // If explicit template media exists but is a video, do not fall through to
    // a random neighboring image: a text/design-only authored card is better
    // than showing the wrong subject.
    const ownMedia = [
        mg.mediaFile,
        mg.templateMediaFile,
        mg.mgData?.templateMediaFile,
        mg.templateMedia,
        mg.imageFile,
        mg.mgData?.mediaFile,
    ];
    const hasExplicitTemplateMedia = Boolean(mg.templateMediaFile || mg.mgData?.templateMediaFile || mg.templateMedia);
    for (const f of ownMedia) {
        push(f, mg.keyword || mg.templateText || mg.text);
    }
    if (hasExplicitTemplateMedia) return out;
    // 2) the footage at/near this beat (owner scene, else nearest within 12s)
    const owner = ownerSceneOf(plan, mg) || nearestFootageScene(plan, mg);
    if (owner) push(owner.mediaFile, `${owner.keyword || ''} — footage of this story beat (${String(owner.text || '').slice(0, 60)})`);
    return out;
}

// ── Subject fetch (v9.1): briefs with NO image get one fetched on demand ──
// When the beat's own text names a Director-tagged entity (person/org/place)
// and the footage pipeline left nothing nearby, pull ONE subject photo from
// the web-image providers so the author can build a subject board instead of
// a designed-background-only card. Entity choice is upstream-owned
// (scriptContext.entities) — no per-niche or per-word hardcoding here.
function subjectFetchDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_AUTHOR_SUBJECT_FETCH || '').trim());
}

function planPublicDir(plan, opts = {}) {
    for (const s of (plan.scenes || [])) {
        if (s && s.mediaFile) {
            try { if (fs.existsSync(s.mediaFile)) return path.dirname(String(s.mediaFile)); } catch (_) { /* next */ }
        }
    }
    if (opts.projectDir) return String(opts.projectDir);
    return path.join(process.cwd(), 'public');
}

async function enrichBriefsWithSubjectImages(briefs, plan, opts = {}) {
    if (subjectFetchDisabled() || !briefs.length) return 0;
    let fetcher;
    try { fetcher = require('../../media/subject-image-fetcher'); } catch (_) { return 0; }
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const sc = plan.scriptContext || {};
    const destDir = path.join(planPublicDir(plan, opts), 'authored-assets');
    let fetched = 0;
    for (const brief of briefs) {
        if (brief.kind === 'overlay') continue; // overlays never place images
        if (brief.assets && brief.assets.length) continue;
        const beatText = [brief.text, brief.subtext, brief.narration,
            ...(brief.items || []).map(i => `${i.label || ''} ${i.value || ''}`)].join(' ');
        const subject = fetcher.pickSubjectEntity(beatText, sc);
        if (!subject) continue; // abstract beat — designed background is correct
        try {
            const file = await fetcher.fetchSubjectImage({ query: subject.name, destDir, log });
            if (file) {
                brief.assets.push({
                    token: '__HF_ASSET_0__',
                    path: file,
                    kind: 'image',
                    desc: `photo of ${subject.name} (${subject.type || 'subject'} this beat is about)`,
                });
                fetched++;
            }
        } catch (e) {
            log(`  ⚠️ [Subject Image] skipped "${subject.name}": ${String(e.message || e).slice(0, 80)}`);
        }
    }
    if (fetched) log(`  📸 [Composition Author] fetched ${fetched} subject image(s) for asset-less beats`);
    return fetched;
}

function itemsOf(mg) {
    const raw = mg.items || mg.templateData?.items || mg.mgData?.items || [];
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 8).map(it => (typeof it === 'string' ? { label: it } : { label: it.label || it.text || '', value: it.value || '' }));
}

function buildBrief(plan, mg, index, kind) {
    const sc = plan.scriptContext || {};
    const type = normType(mg);
    // ns is CONTENT-derived, not index-derived: post-build plan mutations
    // (orchestrator merges/disables) shift array indexes, which made every
    // downstream brief a cache MISS at render-prep — the whole video was
    // silently authored twice per build.
    const nsSlug = crypto.createHash('sha1')
        .update(`${kind}|${type}|${String(mg.templateText || mg.text || '').slice(0, 80)}`)
        .digest('hex').slice(0, 6);
    return {
        ns: `auth-${type.replace(/[^a-z0-9-]/g, '') || 'comp'}-${nsSlug}`,
        // TRUE duration — the old Math.max(2,…) floor lied to the agent: it
        // choreographed exits for 2.0s inside a 1.6s window, so every
        // micro-scene hard-cut mid-animation instead of exiting.
        duration: visualDurationSeconds(mg),
        kind,
        type,
        text: String(mg.templateText || mg.text || '').slice(0, 220),
        subtext: String(mg.templateSubtext || mg.subtext || '').slice(0, 300),
        // NOTE: mg.kicker/mg.eyebrow are deliberately NOT passed — canned
        // category labels ("KEY TAKEAWAY") read as AI-generated, and the
        // author printed them verbatim as eyebrow micro-headlines.
        items: itemsOf(mg),
        narration: ownerNarration(plan, mg),
        // Overlays float on live footage — they never place images (the
        // footage IS the image) and carry their position zone for anchoring.
        assets: kind === 'overlay' ? [] : resolveBriefAssets(plan, mg),
        position: String(mg.position || '').toLowerCase() || (kind === 'overlay' ? 'bottom' : ''),
        themeId: sc.themeId || plan.themeId || 'standard',
        nicheId: sc.nicheId || '',
        styleProfile: sc.styleProfile || null,
        directives: sc._directives || null,
    };
}

/**
 * Author compositions for every eligible template/fullscreen-MG item in the
 * plan and attach `_authoredComposition` in place. Safe to call repeatedly —
 * the per-project cache makes unchanged scenes free.
 */
async function authorPlanCompositions(plan, opts = {}) {
    if (!plan || isDisabled()) return { authored: 0, eligible: 0, skipped: true };
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const forceRefresh = /^(1|true|on|yes)$/i.test(String(process.env.HF_AUTHOR_REFRESH || '').trim());
    const openMode = Boolean(opts.openMode) && !forceRefresh;
    const fastTest = opts.fastTest === true;
    const graphicsOnly = opts.graphicsOnly === true;

    // Effects director rides along with the author pass (same call sites:
    // build Step 7.6 + render-prep). One batch reasoning call; recipes
    // persist into video-plan.json so reruns cost nothing.
    if (!openMode && !graphicsOnly && directSceneEffects) {
        try { await directSceneEffects(plan, { log, projectDir: opts.projectDir }); }
        catch (e) { log(`  ⚠️ [FX Director] skipped: ${String(e.message || e).slice(0, 100)}`); }
    }

    // Transition director rides along the same way: one batch reasoning call
    // that assigns motivated transitions per footage boundary, overriding the
    // algorithmic 70/30 pass (which remains the fallback floor).
    if (!openMode && !graphicsOnly && directTransitions) {
        try { await directTransitions(plan, { log, projectDir: opts.projectDir }); }
        catch (e) { log(`  ⚠️ [Transition Director] skipped: ${String(e.message || e).slice(0, 100)}`); }
    }

    // Explainer icon moments over footage (photo cutouts / authored SVGs),
    // word-synced, sparse. Same pattern: 1 batch call, disk cache.
    if (!openMode && !graphicsOnly && directIcons && !fastTest) {
        try { await directIcons(plan, { log, projectDir: opts.projectDir }); }
        catch (e) { log(`  ⚠️ [Icon Director] skipped: ${String(e.message || e).slice(0, 100)}`); }
    }

    if (!openMode && fastTest) {
        log('  ⚡ [Composition Author] Fast Test: icon/subject asset searches and bespoke overlay authoring are skipped; stage authoring and Motion QA remain active');
    }

    // Keyword-glow word-emphasis overlays (OPENMONTAGE-BORROW-PLAN #18). Deterministic,
    // OPT-IN (HF_KEYWORD_GLOW=1). On open, the saved plan already carries _keywordGlow.
    if (!openMode && !graphicsOnly && directKeywordGlow) {
        try { await directKeywordGlow(plan, { log, projectDir: opts.projectDir }); }
        catch (e) { log(`  ⚠️ [Keyword Glow] skipped: ${String(e.message || e).slice(0, 100)}`); }
    }

    // Character MGs for no-footage scenes (OPENMONTAGE-BORROW-PLAN #19). OPT-IN
    // (HF_CHARACTER_MG=1). Runs BEFORE the mgScenes authoring loop below so the
    // pushed character comps are already validated + attached. On open, the saved
    // plan already carries them (skipped here).
    if (!openMode && !graphicsOnly && authorCharacterScenes) {
        try { authorCharacterScenes(plan, { log }); }
        catch (e) { log(`  ⚠️ [Character MG] skipped: ${String(e.message || e).slice(0, 100)}`); }
    }

    // Saved-project reuse (June 12): the plan PERSISTS authored comps —
    // reopening a saved project must cost ZERO AI calls regardless of any
    // prompt/theme/version changes since the save. Pipeline upgrades apply
    // on the next BUILD (fresh plan, no comps yet), or set
    // HF_AUTHOR_REFRESH=1 to force a re-author on open.
    let invalidSaved = 0;
    const hasSavedComp = (mg) => {
        if (!mg || !mg._authoredComposition?.html || !mg._authoredComposition?.timeline) return false;
        const duration = visualDurationSeconds(mg);
        const ns = String(mg._authoredNs || mg._authoredComposition.ns || '').trim();
        if (!ns) {
            clearAuthoredComposition(mg);
            invalidSaved++;
            return false;
        }
        const validation = validateComposition(
            mg._authoredComposition,
            ns,
            duration,
            mg._authoredAssets || [],
            null
        );
        if (!validation.ok) {
            clearAuthoredComposition(mg);
            invalidSaved++;
            return false;
        }
        mg._authoredComposition.timeline = normalizeAuthoredTimeline(
            validation.timeline,
            duration
        );
        return true;
    };
    let reused = 0;
    let fixedOverrides = 0;
    const skipForExplicitOverride = (mg) => {
        if (!prefersFixedRenderer(mg)) return false;
        clearAuthoredComposition(mg);
        fixedOverrides++;
        return true;
    };

    const candidates = [];
    (plan.templateScenes || []).forEach((mg, i) => {
        if (!mg || mg.disabled) return;
        if (EXCLUDED_TYPES.has(normType(mg))) return;
        if (skipForExplicitOverride(mg)) return;
        if (hasSavedComp(mg) && !forceRefresh) { reused++; return; }
        candidates.push({ mg, kind: 'template', index: candidates.length });
    });
    (plan.mgScenes || []).forEach((mg) => {
        if (!mg || mg.disabled) return;
        if (EXCLUDED_TYPES.has(normType(mg))) return;
        if (skipForExplicitOverride(mg)) return;
        if (hasSavedComp(mg) && !forceRefresh) { reused++; return; }
        candidates.push({ mg, kind: 'fullscreen', index: candidates.length });
    });
    // Overlay MGs (June 12): authored like everything else, under OVERLAY
    // MODE rules (transparent stage, coverage budget). HF_AUTHOR_OVERLAYS=0
    // reverts them to the legacy/agentic-spec renderers.
    if (!overlaysDisabled() && !fastTest) {
        (plan.motionGraphics || []).forEach((mg) => {
            if (!mg || mg.disabled) return;
            const t = normType(mg);
            if (EXCLUDED_TYPES.has(t) || OVERLAY_EXCLUDED_TYPES.has(t)) return;
            if (skipForExplicitOverride(mg)) return;
            if (hasSavedComp(mg) && !forceRefresh) { reused++; return; }
            candidates.push({ mg, kind: 'overlay', index: candidates.length });
        });
    }

    if (reused > 0) log(`  ♻️ [Composition Author] ${reused} composition(s) reused from the saved project (opens are read-only; rebuild or HF_AUTHOR_REFRESH=1 to re-author)`);
    if (invalidSaved > 0) {
        log(`  🛡️ [Composition Author] rejected ${invalidSaved} stale/unsafe saved composition(s); safe fallback or re-authoring will be used`);
    }
    if (fixedOverrides > 0) {
        log(`  [Composition Author] ${fixedOverrides} explicit graphic override(s) kept on the deterministic renderer`);
    }
    if (candidates.length === 0) return {
        authored: 0,
        eligible: 0,
        reused,
        fixedOverrides,
        invalidSaved,
    };
    log(`  🎨 [Composition Author] ${candidates.length} eligible scene(s) (templates + fullscreen MGs + overlays; maps excluded)`);

    const briefs = candidates.map(c => buildBrief(plan, c.mg, c.index, c.kind));
    // Two scenes with identical type+text would collide on the content ns —
    // disambiguate the duplicates (stable as long as plan order is stable).
    const nsSeen = new Map();
    for (const b of briefs) {
        const n = nsSeen.get(b.ns) || 0;
        nsSeen.set(b.ns, n + 1);
        if (n > 0) b.ns = `${b.ns}-${n + 1}`;
    }
    // ── Stage-visual chains: when graphics run back-to-back (gap ≤ 0.35s)
    // the bridge renders the boundary seamlessly (no container pop), so the
    // AUTHOR must design chained comps as pages of ONE design system — same
    // calm background construction, content swaps. Flags ride the brief.
    {
        const stage = candidates
            .map((c, bi) => ({ bi, kind: c.kind, start: toSec(c.mg.startTime), end: toSec(c.mg.endTime, toSec(c.mg.startTime) + 4) }))
            .filter(s => s.kind !== 'overlay')
            .sort((a, b) => a.start - b.start);
        for (let w = 1; w < stage.length; w++) {
            const prev = stage[w - 1], cur = stage[w];
            if (cur.start - prev.end <= 0.35 && cur.start - prev.end >= -0.5) {
                briefs[prev.bi].chainNext = true;
                briefs[cur.bi].chainPrev = { text: String(briefs[prev.bi].text || '').slice(0, 80) };
            }
        }
    }
    if (!fastTest && !openMode && !graphicsOnly) {
        try { await enrichBriefsWithSubjectImages(briefs, plan, opts); }
    catch (e) { log(`  ⚠️ [Subject Image] enrichment skipped: ${String(e.message || e).slice(0, 100)}`); }
    }
    const results = await authorCompositions(briefs, { projectDir: opts.projectDir, log, openMode: Boolean(opts.openMode) });

    let authored = 0;
    results.forEach((r, i) => {
        if (r.composition) {
            candidates[i].mg._authoredComposition = r.composition;
            candidates[i].mg._authoredNs = r.brief.ns;
            // Bridge substitutes __HF_ASSET_i__ tokens with these at render.
            candidates[i].mg._authoredAssets = r.brief.assets || [];
            authored++;
        }
    });
    log(`  ✅ [Composition Author] attached ${authored}/${candidates.length} authored compositions`);
    return { authored, eligible: candidates.length, fixedOverrides, invalidSaved };
}

module.exports = {
    authorPlanCompositions,
    buildBrief,
    enrichBriefsWithSubjectImages,
    visualDurationSeconds,
    EXCLUDED_TYPES,
    OVERLAY_EXCLUDED_TYPES,
};
