/**
 * retrievability-rescue.js
 *
 * Upstream rescue for UN-FINDABLE visual intents. The Visual Planner sometimes commits a
 * scene to footage that no stock/web source can actually return:
 *   • a proprietary / invented product only the maker's own video would show
 *       ("Right Grip wrench bolt contact")
 *   • a meta-reference that isn't real-world footage at all
 *       ("Made in USA investigation thumbnail", "previous video", a screenshot)
 *   • a hyper-specific manufacturing close-up generic libraries don't carry
 *       ("boot welt stitching detail")
 * Downstream, the downloader then burns the ENTIRE per-scene budget (6–9 min observed)
 * hunting footage that does not exist, and the scene fails with "no media found".
 *
 * This pass asks the AI to JUDGE searchability across all download-lane scenes in ONE
 * batched call and, for the un-findable ones ONLY, rewrite the query into a findable,
 * topically-honest B-roll phrase (generic subject + action + setting). It uses NO hardcoded
 * word lists — the model decides what is / isn't stock-searchable. The narration still
 * carries the specifics, so the B-roll only has to be topically honest, not literal.
 *
 * The planner's own `retrievability` tag is unreliable for this (it labelled real failures
 * "easy"), which is exactly why searchability is delegated to the model here rather than a
 * threshold. Runs in the orchestrator (Step 4.8) after the Media Intent Controller + search
 * keyword split, so its query rewrites are final. Disable with RETRIEVABILITY_RESCUE=off.
 */

const { callAIJson } = require('../brain/strict-json');

/**
 * The background query of a TEMPLATE CARD, if that is what this scene is.
 *
 * Two shapes reach the downloader, and until now only one of them was judged
 * here: a normal footage scene (searched by stockQuery/searchKeyword/keyword),
 * and a template card, whose background is searched by `templateBgQuery`. Cards
 * were excluded outright, and that exclusion had a measured price.
 *
 * When the orchestrator rejects a data chart it turns the chart into a template
 * card and seeds the background search with the chart's own title. "Coefficient
 * of Performance" is a metric, not a thing a camera can point at — so the scene
 * spends its whole budget proving that stock libraries carry no footage of a
 * metric. On the 2026-07-31 build five such scenes did exactly that, at 225
 * seconds each, and took five of the nine coverage-rescue slots with them.
 *
 * A card background is real footage from a real search. It faces the identical
 * un-findable-query failure, so it belongs in the identical judgement.
 */
function _templateBgQuery(scene) {
    if (!scene || scene.fullscreenMG || !scene.templateHint) return '';
    return String(scene.templateBgQuery || '').trim();
}

function _downloadLaneScenes(scenes) {
    return (scenes || []).filter((s) => {
        if (!s) return false;
        if (s.fullscreenMG) return false;
        const lane = s.mediaIntent?.lane;
        if (lane === 'skip') return false;
        if (s.templateHint) return !!_templateBgQuery(s);
        if (lane === 'template') return false;
        return !!(s.stockQuery || s.searchKeyword || s.keyword);
    });
}

function _shortText(text, words = 14) {
    return String(text || '').replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, words).join(' ');
}

async function applyRetrievabilityRescue(scenes, scriptContext = {}, options = {}) {
    const changes = [];
    const tag = options.label ? `Retrievability Rescue · ${options.label}` : 'Retrievability Rescue';
    let lane = _downloadLaneScenes(scenes);
    // Delta mode: re-judge ONLY the scenes whose downloader query changed after
    // this pass last ran (a later stage can invent brand-new queries this pass
    // never saw). Same model, same prompt, smaller row set.
    if (options.onlyIndices) {
        const only = options.onlyIndices instanceof Set
            ? options.onlyIndices
            : new Set(options.onlyIndices);
        lane = lane.filter((s) => only.has(s.index));
    }
    if (lane.length === 0) return { changes, rescued: [] };

    const rows = lane
        .map((s) => ({
            i: s.index,
            type: s.mediaType || 'video',
            q: String(_templateBgQuery(s) || s.stockQuery || s.searchKeyword || s.keyword || '').slice(0, 80),
            n: _shortText(s.text),
        }))
        .filter((r) => r.q);
    if (rows.length === 0) return { changes, rescued: [] };

    const topic = scriptContext.summary || scriptContext.videoTitle || scriptContext.title || '';
    const niche = scriptContext.nicheId || 'general';

    const prompt = `You are a STOCK-FOOTAGE SEARCHABILITY judge for a faceless video.
Video topic: "${topic}"  |  niche: ${niche}

Below are per-scene B-roll search queries (q) with the scene narration (n). MOST queries are
fine — leave them alone. Flag ONLY queries a real stock/web search (Pexels, Pixabay, Bing,
YouTube) would almost certainly FAIL to return usable footage for, because the query:
  • names a proprietary / branded / invented product only that company's own video would show,
  • references another video, a "thumbnail", a "previous video", a screenshot, a UI, or any
    meta artifact that is not real-world footage,
  • demands a hyper-specific manufacturing / engineering close-up generic libraries don't carry.

For EACH flagged scene, rewrite it into a FINDABLE, topically-honest B-roll phrase (3-5 words):
keep the generic visible subject + action + setting, DROP the un-findable qualifier (proprietary
name, meta/thumbnail reference, hyper-specific detail). The narration carries the specifics, so
the B-roll only has to be topically honest, not literal. Prefer concrete, filmable subjects.

SCENES:
${rows.map((r) => `#${r.i} [${r.type}] q="${r.q}" n="${r.n}"`).join('\n')}

Return JSON: {"rescued":[{"i":<index>,"q":"<new findable query>","type":"video|image","why":"<short reason>"}]}
Only include scenes you actually rewrote. If everything is findable, return {"rescued":[]}.`;

    let parsed;
    try {
        parsed = await callAIJson(prompt, {
            label: options.label ? `retrievability-rescue-${options.label}` : 'retrievability-rescue',
            maxRetries: 1,
            maxTokens: 1100,
            temperature: 0.2,
            taskType: 'planner-small',
            systemPrompt:
                'You judge whether B-roll search queries are findable in real stock/web libraries and rewrite ONLY the un-findable ones into generic, findable, topically-honest phrases. Be conservative — most queries are fine. Output strict JSON only.',
        });
    } catch (e) {
        console.log(`   [${tag}] skipped (${e.message})`);
        return { changes, rescued: [] };
    }

    const rescued = Array.isArray(parsed?.rescued) ? parsed.rescued : [];
    if (rescued.length === 0) {
        if (options.log !== false) console.log(`   [${tag}] reviewed ${rows.length} scene(s) — all findable`);
        return { changes, rescued: [] };
    }

    const byIndex = new Map(lane.map((s) => [s.index, s]));
    const applied = [];
    for (const r of rescued) {
        const scene = byIndex.get(Number(r.i));
        if (!scene) continue;
        const newQ = String(r.q || '').replace(/^["']|["']$/g, '').trim();
        if (!newQ || newQ.length < 3) continue;
        const cardBg = _templateBgQuery(scene);
        const before = cardBg || scene.stockQuery || scene.searchKeyword || scene.keyword || '';
        if (newQ.toLowerCase() === String(before).toLowerCase()) continue;

        // A template card searches by ONE field and has no locked lane to
        // unlock, so rewriting that field is the entire change. Deliberately
        // narrower than the footage path below: writing the downloader keyword
        // fields here would turn a card into a footage scene, which is a
        // different decision than the one this pass is allowed to make.
        if (cardBg) {
            scene.templateBgQuery = newQ;
            scene._retrievabilityRescued = { before, after: newQ, why: r.why || '' };
            applied.push({ index: scene.index, before, after: newQ, why: r.why || '' });
            changes.push(`S${scene.index}: unfindable card background "${before}" → findable "${newQ}" (${r.why || 'rescue'})`);
            continue;
        }

        // Rewrite every downloader-facing query to the findable phrase (the narration keeps
        // the specifics). Relax an unfindable internal-only lock so downstream stops treating
        // the scene as exact-only.
        scene.stockQuery = newQ;
        scene.searchKeyword = newQ;
        scene.keyword = newQ;
        scene.webQuery = newQ;
        if (scene.retrievability === 'internal-only') scene.retrievability = 'easy';
        if (r.type === 'image' || r.type === 'video') scene.mediaType = r.type;

        // Unlock the source. The query is now generic, stock-findable B-roll — but a scene the
        // planner had locked to youtube (internal-only/real-demo) would STILL fail despite the
        // findable phrase, because stock was never allowed. Relax the lane so stock providers
        // can serve it (video → prefer stock; image → keep web-image, both via soft fallback).
        const isImg = scene.mediaType === 'image';
        if (!isImg) scene.sourceHint = 'stock';
        if (scene.mediaIntent) {
            scene.mediaIntent.strength = 'soft';
            if (!isImg) scene.mediaIntent.sourceHint = 'stock';
            if (scene.mediaIntent.policy) {
                scene.mediaIntent.policy.allowStockFallback = true;
                scene.mediaIntent.policy.allowProviderFallback = true;
                scene.mediaIntent.policy.allowTypeFallback = true;
                scene.mediaIntent.policy.allowedSources = null;
                scene.mediaIntent.policy.allowedSourcesByType = null;
                if (!isImg) scene.mediaIntent.policy.sourceHint = 'stock';
            }
        }
        scene._retrievabilityRescued = { before, after: newQ, why: r.why || '' };

        applied.push({ index: scene.index, before, after: newQ, why: r.why || '' });
        changes.push(`S${scene.index}: unfindable "${before}" → findable "${newQ}" (${r.why || 'rescue'})`);
    }

    if (options.log !== false) {
        console.log(`   [${tag}] rewrote ${applied.length}/${rows.length} unfindable scene quer${applied.length === 1 ? 'y' : 'ies'} into findable B-roll`);
    }
    return { changes, rescued: applied };
}

module.exports = { applyRetrievabilityRescue };
