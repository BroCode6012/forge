/**
 * Icon Director Worker
 *
 * Explainer icon moments over live footage: ONE batch reasoning call reads
 * every footage scene's narration (with word timings) and decides which
 * scenes EARN a small animated explanation visual — a real cutout photo for
 * concrete things (a ship, a missile, a person) or a self-authored SVG icon
 * for abstract concepts (risk, cost, time, growth). The icon pops in synced
 * to the trigger word, floats through its life, and exits — the classic
 * explainer accent, used sparsely so footage stays the star.
 *
 * Photo lane: Storyblocks search → download → @imgly background removal →
 * transparent PNG (Bing/Brave subject fetch as fallback). Cached on disk by
 * concept slug. SVG lane: the director authors a simple line-style icon in
 * the same call; a strict sanitizer rejects anything but plain vector shapes.
 *
 * Output lands on scene._iconMoments = [{ at, dur, kind, src|svg, position,
 * concept }] which the bridge renders inside the scene wrap. Flag:
 * HF_ICON_DIRECTOR=0 disables. Cost: 1 AI call per build, disk-cached
 * (.hf-icon-cache.json) + photo downloads on first run only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../../brain/ai-provider');
let renderDirectivesBlock = () => '';
try { ({ renderDirectivesBlock } = require('../../directives/directive-compiler')); } catch (_) { /* optional */ }

const POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center-left', 'center-right']);
const MAX_PER_SCENE = 2;

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_ICON_DIRECTOR || '').trim());
}

function toSec(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function slugify(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50); }

// ── SVG sanitizer (the load-bearing part of the svg lane) ──
const SVG_ALLOWED_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'defs', 'lineargradient', 'stop', 'title']);
function sanitizeSvg(svg) {
    const s = String(svg || '').trim();
    if (!s.startsWith('<svg') || !s.endsWith('</svg>') || s.length > 2600) return null;
    if (/<\s*(script|foreignobject|image|use|iframe|animate)/i.test(s)) return null;
    if (/\bhref|xlink|javascript:|data:text/i.test(s)) return null;
    if (/https?:\/\//i.test(s.replace(/\bxmlns(?::[\w-]+)?\s*=\s*("[^"]*"|'[^']*')/gi, ''))) return null;
    if (!/viewBox\s*=/.test(s)) return null;
    for (const m of s.matchAll(/<\s*\/?\s*([a-zA-Z][\w-]*)/g)) {
        if (!SVG_ALLOWED_TAGS.has(m[1].toLowerCase())) return null;
    }
    if (/\son[a-z]+\s*=/i.test(s)) return null;
    return s;
}

function condensedWords(scene) {
    const words = Array.isArray(scene.words) ? scene.words : [];
    const start = toSec(scene.startTime);
    return words.slice(0, 40).map(w => `${w.word}@${Math.max(0, toSec(w.start) - start).toFixed(1)}`).join(' ');
}

function buildPrompt(scenes, themeId, nicheId, accentHex, directives) {
    const directivesBlock = renderDirectivesBlock(directives, 'icons');
    const lines = scenes.map(s =>
        `  ${s.index}: dur=${s.dur.toFixed(1)}s framing=${s.framing}${s.presenter ? ` [PRESENTER decorate=${s.presenter}]` : ''} "${s.text}"${s.wordTimes ? `\n     words: ${s.wordTimes}` : ''}`
    ).join('\n');
    return `You are the explainer-icon director for a YouTube video (theme "${themeId}", niche "${nicheId}").
Small animated visuals can pop in OVER live footage, synced to the word that names them, float briefly, and exit. Used well they make narration concrete; used everywhere they are noise.

FOR EACH footage scene below decide: does any moment EARN an icon? Most scenes should get NONE — assign icons to roughly a quarter of scenes at most, only where the narration names something the footage itself does not clearly show.

EXCEPTION — scenes tagged [PRESENTER] are the on-camera HOST held on screen (a talking-head hold). Decorate these GENEROUSLY, not sparsely: layer word-synced icons / framed photos / cutouts across the hold so the host never sits static — exactly like a modern talking-head edit where graphics slide in over the presenter. decorate=heavy → be liberal (an icon on most key words); decorate=normal → a few; decorate=light → keep it clean.

Three kinds:
- "photo": a real CUTOUT of a concrete OBJECT (vehicle, weapon, product, tool) — background is removed, the object floats. Provide a 2-4 word query for a clean isolated subject. Use ONLY when the subject works isolated.
- "image": a real photograph shown as a small FRAMED picture (kept whole, no background removal) — for places, events, people, documents, scenes where the WHOLE photo carries the information. Provide a 2-4 word photo query.
- "svg": a simple line-style vector icon YOU author for an ABSTRACT concept (cost, risk, time, growth, percentage, route). Rules: viewBox="0 0 100 100", stroke="currentColor", stroke-width 6-8, fill="none" (small accent fills allowed with currentColor), 3-6 shapes, no text elements.
  QUALITY BAR: the icon must be a RECOGNIZABLE PICTOGRAM — a stranger should name it in one second (a gauge, a clock, an anchor, a coin stack, a trending-up arrow, a warning triangle, a crosshair, a padlock). Abstract stroke clusters are worthless — if the concept has no obvious pictogram, represent it with a universally-read symbol (cost→coin/banknote, risk→warning triangle, growth→arrow trending up over bars, time→clock, blockage→crossed circle). Closed silhouettes read better than open paths at 220px.

PLACEMENT: choose a corner/side position away from the frame center (top-left, top-right, bottom-left, bottom-right, center-left, center-right). TIMING: "at" = seconds into the scene when the trigger word lands (use the word timings); duration 1.6-3.5s, must end ≥0.3s before the scene ends.

SCENES:
${lines}

Respond with ONLY JSON mapping scene index to an array (empty array = no icon, the usual answer):
{"3":[{"kind":"svg","concept":"rising cost","at":1.2,"dur":2.4,"position":"top-right","svg":"<svg viewBox=\\"0 0 100 100\\">...</svg>"}],"5":[{"kind":"photo","concept":"container ship","query":"container ship isolated","at":0.8,"dur":2.8,"position":"bottom-left"}],"7":[{"kind":"image","concept":"Suez Canal aerial","query":"suez canal aerial view","at":1.4,"dur":3.0,"position":"top-left"}],"6":[], ...}`;
}

function parseDecisions(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

// ── Cutout quality gate ──
// Background removal on a bad source (watermarked preview, busy collage)
// produces a near-transparent "ghost". Measure the result: the solid subject
// must cover a sane fraction of the canvas or the icon is rejected.
function cutoutLooksUsable(pngPath) {
    let createCanvas, loadImageSync;
    try { ({ createCanvas, Image: loadImageSync } = require('@napi-rs/canvas')); } catch (_) { return true; } // fail open
    try {
        // Sniff the bytes BEFORE handing them to the native decoder. @napi-rs/canvas
        // segfaults the whole process on some malformed/exotic images (0xC0000005
        // ACCESS_VIOLATION — no exception, no catch, the build just dies). The other
        // canvas call sites already guard this way; this one did not. A crash here takes
        // out an entire build, so failing open on an unreadable icon is the cheap side.
        const { isCanvasSafeImage } = require('../../util/image-bytes');
        if (!isCanvasSafeImage(pngPath)) return true;   // fail open, same as a missing module
        const img = new loadImageSync();
        img.src = fs.readFileSync(pngPath);
        const w = Math.max(1, img.width), h = Math.max(1, img.height);
        const cw = Math.min(240, w), ch = Math.min(240, h);
        const canvas = createCanvas(cw, ch);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        const data = ctx.getImageData(0, 0, cw, ch).data;
        let solid = 0, minX = cw, maxX = 0;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            if (data[(y * cw + x) * 4 + 3] > 200) { solid++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
        }
        const frac = solid / (cw * ch);
        const bboxFrac = maxX > minX ? (maxX - minX) / cw : 0;
        return frac >= 0.05 && frac <= 0.7 && bboxFrac >= 0.25;
    } catch (_) { return true; } // measurement failure must not kill the lane
}

// ── Photo lane: web photos first (real subjects), storyblocks fallback,
// bg removal → transparent png → quality gate ──
async function resolvePhotoIcon(query, destDir, log) {
    const slug = slugify(query);
    if (!slug) return null;
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) { /* exists */ }
    const finalPath = path.join(destDir, `icon-${slug}.png`);
    if (fs.existsSync(finalPath)) return finalPath;
    const { removeBg } = require('../../media/explainer-image-provider');

    const tryRaw = async (rawPath) => {
        if (!rawPath || !fs.existsSync(rawPath)) return null;
        try {
            await removeBg(rawPath, finalPath, 60000);
            if (fs.existsSync(finalPath)) {
                if (cutoutLooksUsable(finalPath)) {
                    log(`  🖼️ [Icon Director] photo icon "${query}" → ${path.basename(finalPath)}`);
                    return finalPath;
                }
                log(`  🖼️ [Icon Director] cutout for "${query}" failed the quality gate — trying next source`);
                try { fs.unlinkSync(finalPath); } catch (_) { /* noop */ }
            }
        } catch (_) { /* next source */ }
        return null;
    };

    // 1) web image lane (real photos of the subject; watermarked previews
    //    are filtered inside the fetcher)
    try {
        const { fetchSubjectImage } = require('../../media/subject-image-fetcher');
        const raw = await fetchSubjectImage({ query, destDir, log: () => {} });
        const ok = await tryRaw(raw);
        if (ok) return ok;
        if (raw) { try { fs.unlinkSync(raw); } catch (_) { /* keep cache clean for retry */ } }
    } catch (_) { /* next lane */ }
    // 2) Storyblocks fallback
    try {
        const { searchImage } = require('../../media/explainer-image-provider');
        const hit = await searchImage(query);
        if (hit && hit.url) {
            const BingImageProvider = require('../../media/providers/bing-image');
            const raw = await new BingImageProvider().download(hit.url, path.join(destDir, `icon-${slug}-raw.png`), { timeoutMs: 30000 });
            const ok = await tryRaw(raw);
            if (ok) return ok;
        }
    } catch (_) { /* drop */ }
    return null;
}

// ── Framed-image lane: the photo is kept WHOLE (no background removal) and
// rendered as a small framed picture. Watermark filtering + provider floors
// happen inside the subject fetcher.
async function resolveFramedImage(query, destDir, log) {
    const slug = slugify(query);
    if (!slug) return null;
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) { /* exists */ }
    const finalPath = path.join(destDir, `icon-img-${slug}.png`);
    if (fs.existsSync(finalPath)) return finalPath;
    try {
        const { fetchSubjectImage } = require('../../media/subject-image-fetcher');
        const raw = await fetchSubjectImage({ query, destDir, log: () => {} });
        if (raw && fs.existsSync(raw)) {
            fs.copyFileSync(raw, finalPath);
            log(`  🖼️ [Icon Director] framed image "${query}" → ${path.basename(finalPath)}`);
            return finalPath;
        }
    } catch (_) { /* drop */ }
    return null;
}

/**
 * Decide + resolve explainer icon moments (mutates scene._iconMoments).
 */
async function directIcons(plan, opts = {}) {
    if (!plan || isDisabled()) return { decided: 0, skipped: true };
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const scenes = (plan.scenes || []).filter(s => s && !s.disabled && !s.isMGScene && s.mediaFile);
    if (scenes.length < 2) return { decided: 0 };

    const sc = plan.scriptContext || {};

    // Creator authority: "no icons" order → place none at all, skip the AI call.
    if (sc._directives?.icons?.allow === false) {
        log('  🪄 [Icon Director] "no icons" directive → no icon moments (0 AI calls)');
        return { decided: 0, skipped: true, directive: 'no-icons' };
    }

    // Saved-project reuse: the director already ran for this plan and its
    // moments are persisted on the scenes → opens cost nothing.
    if (scenes.some(s => Array.isArray(s._iconMoments))) {
        const withMoments = scenes.filter(s => Array.isArray(s._iconMoments) && s._iconMoments.length).length;
        log(`  🪄 [Icon Director] icon moments reused from the saved project (${withMoments} scene(s), 0 AI calls)`);
        return { decided: withMoments, cached: true };
    }

    const iconHash = crypto.createHash('sha1')
        .update(JSON.stringify(scenes.map(s => [s.index, String(s.text || '').slice(0, 100)])))
        .digest('hex').slice(0, 16);
    const cachePath = opts.projectDir ? path.join(opts.projectDir, '.hf-icon-cache.json') : null;
    const destDir = (() => {
        for (const s of scenes) { try { if (fs.existsSync(s.mediaFile)) return path.join(path.dirname(String(s.mediaFile)), 'authored-assets'); } catch (_) { /* next */ } }
        return path.join(String(opts.projectDir || process.cwd()), 'authored-assets');
    })();

    const apply = (moments) => {
        let applied = 0;
        for (const scene of scenes) {
            const arr = moments[String(scene.index)];
            if (!Array.isArray(arr)) continue;
            scene._iconMoments = arr;
            if (arr.length) applied++;
        }
        return applied;
    };

    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached && cached.hash === iconHash && cached.moments) {
                // verify cached photo assets still exist
                let ok = true;
                for (const arr of Object.values(cached.moments)) {
                    for (const m of arr) if (m.kind === 'photo' && (!m.src || !fs.existsSync(m.src))) ok = false;
                }
                if (ok) {
                    const applied = apply(cached.moments);
                    log(`  🪄 [Icon Director] icon moments loaded from cache (${applied} scene(s), 0 AI calls)`);
                    return { decided: applied, cached: true };
                }
            }
        } catch (_) { /* stale — fall through */ }
    }

    const brief = scenes.map(s => ({
        index: s.index,
        dur: Math.max(0.5, toSec(s.endTime) - toSec(s.startTime)),
        framing: s.framing || 'fullscreen',
        presenter: s.presenterInsert ? (s.presenterInsert.decorate || 'normal') : null,
        text: String(s.text || '').replace(/\s+/g, ' ').slice(0, 140),
        wordTimes: condensedWords(s),
    }));

    let parsed = null;
    try {
        const text = await callAI(buildPrompt(brief, sc.themeId || 'standard', sc.nicheId || '', null, sc._directives || null), { maxTokens: 3500, temperature: 0.4, taskType: 'brain' });
        parsed = parseDecisions(text);
    } catch (e) {
        log(`  ⚠️ [Icon Director] AI call failed: ${String(e.message || e).slice(0, 110)} — no icon moments`);
        return { decided: 0, failed: true };
    }
    if (!parsed) {
        log('  ⚠️ [Icon Director] unparseable response — no icon moments');
        return { decided: 0, failed: true };
    }

    // Validate + resolve assets
    const momentsOut = {};
    let svgCount = 0, photoCount = 0, dropped = 0;
    for (const scene of scenes) {
        const raw = parsed[String(scene.index)];
        if (!Array.isArray(raw)) continue;
        const dur = Math.max(0.5, toSec(scene.endTime) - toSec(scene.startTime));
        const out = [];
        for (const m of raw.slice(0, MAX_PER_SCENE)) {
            if (!m || !POSITIONS.has(String(m.position))) { dropped++; continue; }
            const at = Math.max(0.15, Math.min(dur - 1.2, toSec(m.at, 0.5)));
            const mDur = Math.max(1.2, Math.min(3.5, Math.min(toSec(m.dur, 2.2), dur - at - 0.3)));
            if (mDur < 1.0) { dropped++; continue; }
            if (m.kind === 'svg') {
                const svg = sanitizeSvg(m.svg);
                if (!svg) { dropped++; continue; }
                out.push({ kind: 'svg', svg, at: +at.toFixed(2), dur: +mDur.toFixed(2), position: m.position, concept: String(m.concept || '').slice(0, 60) });
                svgCount++;
            } else if (m.kind === 'photo' || m.kind === 'image') {
                const q = String(m.query || m.concept || '').trim();
                if (!q) { dropped++; continue; }
                const src = m.kind === 'photo'
                    ? await resolvePhotoIcon(q, destDir, log)
                    : await resolveFramedImage(q, destDir, log);
                if (!src) { dropped++; continue; }
                out.push({ kind: m.kind, src, at: +at.toFixed(2), dur: +mDur.toFixed(2), position: m.position, concept: String(m.concept || q).slice(0, 60) });
                photoCount++;
            } else dropped++;
        }
        momentsOut[String(scene.index)] = out;
    }

    const applied = apply(momentsOut);
    if (cachePath) {
        try { fs.writeFileSync(cachePath, JSON.stringify({ hash: iconHash, moments: momentsOut })); } catch (_) { /* non-fatal */ }
    }
    log(`  🪄 [Icon Director] ${applied} scene(s) got icon moments (${svgCount} svg, ${photoCount} photo/image, ${dropped} dropped) (1 AI call)`);
    return { decided: applied };
}

module.exports = { directIcons, sanitizeSvg };
