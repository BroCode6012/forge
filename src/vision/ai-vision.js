const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../settings/config');
const { callVisionAI, isVisionAIAvailable, getVisionProviderChain } = require('../brain/ai-provider');

/**
 * Vision AI analysis module.
 * Extracts a frame from each downloaded video (or reads images directly),
 * sends to a vision-capable AI, and returns visual descriptions + suitability assessments.
 */

// ============ FRAME EXTRACTION ============

let ffmpegAvailable = null;

function checkFfmpegAvailable() {
    if (ffmpegAvailable !== null) return ffmpegAvailable;

    try {
        const ffmpegPath = require('ffmpeg-static');
        if (fs.existsSync(ffmpegPath)) {
            ffmpegAvailable = ffmpegPath;
            return ffmpegPath;
        }
    } catch (e) { /* ffmpeg-static not installed */ }

    console.log('  ⚠️ ffmpeg binary not found. Vision analysis for videos will be skipped.');
    console.log('  💡 If using Windows, add a Defender exclusion for node_modules');
    ffmpegAvailable = false;
    return false;
}

/**
 * Extract a single frame from a video at the midpoint.
 * @returns {Promise<string|null>} path to extracted JPEG frame, or null on failure
 */
async function extractFrame(videoPath, outputPath, durationSec) {
    const ffmpegPath = checkFfmpegAvailable();
    if (!ffmpegPath) return null;

    try {
        const midpoint = Math.max(0.5, durationSec / 2);
        await new Promise((resolve, reject) => {
            execFile(ffmpegPath, [
                '-ss', midpoint.toFixed(2),
                '-i', videoPath,
                '-vf', 'scale=1024:-1',
                '-frames:v', '1',
                '-q:v', '2',
                '-y', outputPath
            ], { timeout: 15000, windowsHide: true }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return outputPath;
    } catch (e) {
        return null;
    }
}

/**
 * Get a base64-encoded frame for a scene.
 * For videos: extract mid-point frame. For images: read directly.
 */
async function getSceneFrame(scene, index) {
    const tempDir = config.paths.temp;
    const ext = scene.mediaExtension || '.mp4';
    const mediaPath = scene.mediaFile || path.join(tempDir, `scene-${index}${ext}`);

    if (!fs.existsSync(mediaPath)) return null;

    const isVideo = ext === '.mp4' || ext === '.webm' || ext === '.mov';
    let imagePath;

    if (isVideo) {
        imagePath = path.join(tempDir, `frame-${index}.jpg`);
        const duration = scene.endTime - scene.startTime;
        const result = await extractFrame(mediaPath, imagePath, duration);
        if (!result) return null;
    } else {
        imagePath = mediaPath;
    }

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const fileExt = path.extname(imagePath).toLowerCase();
        const mimeType = fileExt === '.png' ? 'image/png'
            : fileExt === '.webp' ? 'image/webp'
            : 'image/jpeg';
        return { base64, mimeType };
    } catch (e) {
        return null;
    }
}

// ============ VISION PROMPT ============

function buildVisionPrompt(sceneText, videoSummary) {
    return `You are analyzing a frame from stock footage used in a video about: ${videoSummary || 'unknown topic'}

This frame accompanies the narration: "${sceneText}"

Analyze the image and respond in EXACTLY this format (one value per line):
description: <what is visually shown, 1 sentence max 15 words>
suitability: <good, fair, or poor - how well this footage matches the narration>
reason: <why this suitability rating, max 10 words>
colors: <dominant color palette, max 5 words>
mood: <one word: energetic, calm, dark, bright, neutral, dramatic, warm, cool>
hasText: <yes or no - does the image contain visible text or words>
mgPosition: <where to avoid placing text overlays: avoid-center, avoid-top, avoid-bottom, or clear>`;
}

// ============ RESPONSE PARSING ============
// NOTE: Vision AI providers moved to shared ai-provider.js module

function parseVisionResponse(text, sceneIndex) {
    const result = createDefaultAnalysis(sceneIndex);
    const lines = text.trim().split('\n');

    for (const line of lines) {
        const lower = line.toLowerCase().trim();

        if (lower.startsWith('description:')) {
            result.description = line.substring(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('suitability:')) {
            const val = lower.substring(lower.indexOf(':') + 1).trim();
            if (['good', 'fair', 'poor'].includes(val)) {
                result.suitability = val;
            }
        }
        if (lower.startsWith('reason:')) {
            result.suitabilityReason = line.substring(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('colors:')) {
            result.dominantColors = line.substring(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('mood:')) {
            result.mood = line.substring(line.indexOf(':') + 1).trim().toLowerCase().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('hastext:')) {
            const val = lower.substring(lower.indexOf(':') + 1).trim();
            result.hasText = val === 'yes' || val === 'true';
        }
        if (lower.startsWith('mgposition:')) {
            const val = line.substring(line.indexOf(':') + 1).trim().toLowerCase();
            if (['avoid-center', 'avoid-top', 'avoid-bottom', 'clear'].includes(val)) {
                result.suggestedMGPosition = val;
            }
        }
    }

    return result;
}

function createDefaultAnalysis(sceneIndex) {
    return {
        sceneIndex,
        description: 'No visual analysis available',
        suitability: 'fair',
        suitabilityReason: 'Vision analysis skipped',
        dominantColors: 'unknown',
        mood: 'neutral',
        hasText: false,
        suggestedMGPosition: 'clear'
    };
}

// ============ ARTICLE HIGHLIGHT BOUNDING BOXES ============

// Gemini native box_2d prompt (0-1000 scale, most accurate)
function buildGeminiArticlePrompt() {
    return `Look at this news article. Find the main headline text.
Pick the 2-3 most important phrases from that headline (1-3 words each, words that carry the most meaning).
Return their bounding boxes as JSON. Use box_2d format with 0-1000 coordinates [ymin, xmin, ymax, xmax].
Return ONLY the JSON array, nothing else.
Example format: [{"label": "trade deficit", "box_2d": [250, 100, 290, 350]}, {"label": "record high", "box_2d": [250, 400, 290, 600]}]`;
}

// Generic prompt for non-Gemini providers (percentage-based)
function buildGenericArticlePrompt() {
    return `You are looking at a news article screenshot. Your task: find the ARTICLE HEADLINE and output bounding boxes for its key phrases.

STEP 1 — Identify the page structure:
- What is the site name/logo at the top? (e.g. "Yahoo Finance", "Bloomberg", "BBC") — this is the PAGE HEADER, ignore it entirely.
- What navigation tabs or menu items appear? (e.g. "Markets", "Finance", "Politics") — PAGE NAV, ignore.
- What is the main bold article title below the header? THIS is the headline you want.

STEP 2 — The article headline has these characteristics:
- It describes a specific news event or story in a sentence or phrase
- It appears BELOW the site logo and navigation area
- It is the largest/boldest text in the article body (not the site name)
- Examples: "Saudi East-West pipeline hits 7 mln bpd amid Hormuz disruption", "King Khalid orders construction of new oil pipeline", "Iran seizes tanker in Gulf of Oman"

STEP 3 — From the headline you identified, pick 2-3 key phrases (1-4 words each, most newsworthy/specific words).
For each phrase, estimate its bounding box as percentages (0-100) of the full image dimensions.
x = left edge %, y = top edge %, w = width %, h = height %

Output ONLY a JSON array. If the page shows no article headline (only login walls, error pages, dashboards, or pure nav), output [].
Example: [{"label": "pipeline hits", "x": 8, "y": 38, "w": 20, "h": 4}, {"label": "7 mln bpd", "x": 8, "y": 43, "w": 16, "h": 4}]`;
}

function parseArticleVisionResponse(rawText, isBoxFormat) {
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
        const items = JSON.parse(jsonMatch[0]);
        const boxes = [];
        for (const item of items) {
            if (!item.label) continue;
            let x, y, w, h;

            if ((isBoxFormat || item.box_2d) && item.box_2d && item.box_2d.length === 4) {
                // Native box_2d: [ymin, xmin, ymax, xmax] on 0-1000 scale.
                // Qwen/Bedrock can also return this shape when asked, so do not
                // gate it on a Gemini-only provider flag.
                const [ymin, xmin, ymax, xmax] = item.box_2d;
                x = xmin / 10;
                y = ymin / 10;
                w = (xmax - xmin) / 10;
                h = (ymax - ymin) / 10;
            } else if (item.x !== undefined && item.y !== undefined) {
                // Generic percentage format
                x = item.x;
                y = item.y;
                w = item.w || 15;
                h = item.h || 4;
            } else {
                continue;
            }

            // Sanity check only — no hardcoded positional filter.
            // The AI prompt instructs it to skip headers/nav/logos semantically.
            if (x >= 0 && x <= 100 && y >= 0 && y <= 100 && w > 0 && w <= 80 && h > 0 && h <= 30) {
                boxes.push({ text: item.label, x, y, w, h });
            }
        }
        return boxes;
    } catch (err) {
        console.log(`   ⚠️ Failed to parse vision JSON: ${err.message}`);
        return [];
    }
}

/**
 * Analyze an article image to find headline key phrases for highlighting.
 * Uses Gemini native box_2d format when available (most accurate),
 * falls back to generic percentage prompt for other providers.
 * @param {string} imagePath - path to the article image
 * @returns {Array<{text, x, y, w, h}>} bounding boxes as percentages
 */
async function analyzeArticleHighlights(imagePath) {
    if (!fs.existsSync(imagePath)) return [];

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png'
            : ext === '.webp' ? 'image/webp'
            : 'image/jpeg';

        console.log(`   🔍 Asking Vision AI to find headline key phrases...`);

        // Use the shared vision AI dispatcher — same for ALL providers
        const prompt = buildGenericArticlePrompt();
        const rawText = await callVisionAI(prompt, base64, mimeType);

        const boxes = parseArticleVisionResponse(rawText, false);

        if (boxes.length > 0) {
            console.log(`   ✅ Headline highlights: ${boxes.map(b => `"${b.text}"`).join(', ')}`);
            boxes.forEach(b => console.log(`      📍 x:${b.x.toFixed(1)}% y:${b.y.toFixed(1)}% w:${b.w.toFixed(1)}% h:${b.h.toFixed(1)}%`));
        } else {
            console.log(`   ⚠️ Could not locate headline in article image`);
        }

        return boxes;
    } catch (err) {
        console.log(`   ⚠️ Article vision analysis failed: ${err.message}`);
        return [];
    }
}

// ============ VIDEO FRAME SCORING ============

/**
 * Score how well a single video frame matches a keyword.
 * Used by ALL video providers (YouTube, News, future) via smart-segment.js.
 *
 * Scoring Rules:
 * - LITERAL visual matching only (not symbolic/metaphorical)
 * - Penalize: news anchors, talking heads, studio desks, text-heavy screens
 * - Penalize: channel logos, watermarks, AI-generated artifacts
 * - Reward: real-world footage, specific subjects, clean visuals
 *
 * @param {string} base64Image - base64-encoded frame image
 * @param {string} mimeType - image MIME type
 * @param {string} keyword - the search keyword to match against
 * @param {object} context - { sceneText, niche, videoTopic, theme, tone, entities, entityContext }
 * @returns {{ score: number, description: string }} score 1-10, or 0 on failure
 */
async function scoreVideoFrame(base64Image, mimeType, keyword, context) {
    try {
        const hunter = context?.mediaHunter || null;
        const mediaAgent = context?.mediaAgent || null;
        const sourceTitle = String(context?.sourceTitle || '').trim();
        const sourceTitleMayProveIdentity = sourceTitle
            && /source-proven/i.test(String(mediaAgent?.identityEvidenceMode || ''))
            && Array.isArray(mediaAgent?.mandatoryIdentity)
            && mediaAgent.mandatoryIdentity.length > 0;
        const sourceTitleBlock = sourceTitleMayProveIdentity
            ? `\nSOURCE METADATA ONLY (NOT PIXELS / NOT VISIBLE TEXT): "${sourceTitle}". Use this only to establish source-proven identity. Never quote it as text seen in the frame and never use it as evidence of an editorial overlay.`
            : '';
        // What the editor actually asked to see, in full. Providers only accept a
        // short query, so the keyword line further down is a shortened version of
        // this — grading a frame against the shortened form is how a correct clip
        // gets rejected for "not matching" half of a compound noun.
        const requestedVisual = String(context?.visualIntent || '').trim();
        const requestedVisualBlock = requestedVisual && requestedVisual.toLowerCase() !== String(keyword || '').trim().toLowerCase()
            ? `\nWHAT WAS ACTUALLY REQUESTED (the full request; the search keyword below is a shortened form of this): "${requestedVisual}"`
            : '';
        const contextBlock = context
            ? `${context.videoTopic ? `\nVideo topic: "${context.videoTopic}"` : ''}${requestedVisualBlock}${context.sceneText ? `\nScene narration: "${context.sceneText}"` : ''}${context.niche ? `\nContent niche: ${context.niche}` : ''}${context.theme ? `\nVisual theme: ${context.theme}` : ''}${context.tone ? `\nTone: ${context.tone}` : ''}${sourceTitleBlock}${context.entities?.length ? `\nKey entities: ${context.entities.slice(0, 5).join(', ')}` : ''}${context.entityContext?.length ? `\nEntity context for relevance (not search terms): ${context.entityContext.slice(0, 8).join(', ')}` : ''}${context.mediaAgent?.viewerNeed ? `\nMedia agent viewer need: ${context.mediaAgent.viewerNeed}` : ''}${context.mediaAgent?.minimumAcceptable || context.mediaAgent?.searchStrategy?.minimumAcceptable ? `\nMedia agent minimum acceptable: ${context.mediaAgent.minimumAcceptable || context.mediaAgent.searchStrategy.minimumAcceptable}` : ''}${context.mediaAgent?.acceptanceTest ? `\nMedia agent acceptance test: ${context.mediaAgent.acceptanceTest}` : ''}${context.mediaAgent?.mandatoryIdentity?.length ? `\nMANDATORY IDENTITY: ${context.mediaAgent.mandatoryIdentity.slice(0, 8).join(', ')} (${context.mediaAgent.identityEvidenceMode || 'frame-visible'})` : ''}${context.mediaAgent?.mandatoryVisible?.length ? `\nMANDATORY FRAME-VISIBLE ENTITY: ${context.mediaAgent.mandatoryVisible.slice(0, 8).join(', ')}` : ''}${context.mediaAgent?.mustShow?.length ? `\nMedia agent must show: ${context.mediaAgent.mustShow.slice(0, 8).join(', ')}` : ''}${context.mediaAgent?.mustAvoid?.length ? `\nMedia agent must avoid: ${context.mediaAgent.mustAvoid.slice(0, 8).join(', ')}` : ''}`
            : '';
        const hunterBlock = hunter
            ? `

MEDIA HUNTER TARGET:
- Target visual: ${hunter.targetDescription || 'literal usable B-roll'}
- Mode: ${hunter.mode || 'literal'} | strict raw footage: ${hunter.strictRaw ? 'YES' : 'NO'}
${hunter.prefer?.length ? `- Prefer visible: ${hunter.prefer.slice(0, 8).join(', ')}` : ''}
${hunter.avoid?.length ? `- Avoid/reject: ${hunter.avoid.slice(0, 10).join(', ')}` : ''}
${hunter.allowGraphics ? '- Graphics/maps/templates are allowed for this scene.' : ''}
${hunter.allowScreen ? '- Screen/device/interface footage is allowed if it directly fits the scene.' : ''}
${hunter.allowRelevantPeople ? '- Relevant-person exception is enabled: clean footage of the named/relevant subject is allowed if it is not a presenter package.' : ''}

If strict raw footage is YES: score 7+ ONLY for clean live-action footage that visibly matches the target. Do not reward a frame just because text on screen mentions the topic. Anchors, presenters, commentators, picture-in-picture faces, subtitles, lower thirds, charts, infographics, thumbnails, maps/satellite screenshots, route graphics, animated explainers, or studio shots should be capped at 2-3 unless graphics are explicitly allowed. Clean footage of a relevant public figure, official, celebrity, athlete, worker, soldier, or event participant is allowed when that person is the subject/context, not the presenter.`
            : '';
        const mediaType = String(context?.mediaType || '').toLowerCase();
        const sourceHint = String(context?.sourceHint || '').toLowerCase();
        const agentRole = String(context?.mediaAgent?.role || hunter?.mode || '').toLowerCase();
        // When the Media Agent deliberately planned an inherently-TEXTUAL object as the
        // scene's subject (a book/album/movie-poster cover, newspaper, magazine, sign,
        // document, plaque), the rendered cover/title text IS the subject — not an editorial
        // overlay defect. The Agent owns this call; we just honor it so the text cap lifts
        // for THAT scene only. Vision still judges whether the right object is clearly shown.
        const allowEditorialText = Boolean(context?.mediaAgent?.textIsSubject || hunter?.allowEditorialText);
        const overlayVerifiedAbsent = context?.overlayVerifiedAbsent === true;
        const isBackgroundRole = /template-background|generic-broll|background/.test(agentRole);
        const backgroundLiteralBlock = isBackgroundRole
            ? `

TEMPLATE-BACKGROUND / GENERIC B-ROLL — VISIBLE EVIDENCE RULE:
This frame plays behind a UI card or as supporting B-roll. The audience should see the literal setting or visible evidence the Media Agent asked for. A truthful proxy selected by the Media Agent is allowed; arbitrary symbolism is not.

DIRECT ANCHOR PRIORITY:
- The MEDIA AGENT / HUNTER target and "must show" lines are the scene anchors. High scores require those anchors, not just the same general vibe.
- Score 8+ only if the frame visibly contains the main setting or evidence path plus at least one concrete object/action/detail that makes the scene readable.
- If the frame is only a broad related environment, score 5-6 even if it is clean and cinematic.
- If the frame changes the visual subdomain while staying vaguely related (for example, a generic industrial process when the scene asks for a workshop/tool/product context), score 6 max.

DO NOT reward symbolic representation. Examples of WRONG matches that score 2-4 even though they "thematically fit":
- Scene needs "manufacturing facility / factory floor" → frame shows a motorcycle in a garage → 3 (this is a finished product, NOT the act of manufacturing). Do not write "symbolizes durability" — that is metaphor.
- Scene needs "workshop with tools in use" → frame shows a single tool on a wooden table → 4 (no production action, just product-on-table).
- Scene needs "store aisle with shelves of goods" → frame shows the exterior of a store → 4 (wrong angle, no aisle).
- Scene needs "American workshop" → frame shows a hardware store → 6 (right setting family, acceptable retail B-roll).

The deciding test: would the editor say "yes, the viewer can understand the scene from visible evidence/context in this frame" by literally looking at it? If you have to argue the frame only "symbolizes" the topic with no visible evidence, score 4 or lower.

Frames showing FINISHED PRODUCTS in a static/staged way (a single motorcycle, a single watch on a stand, a hero-shot of one tool) are NEVER manufacturing footage. They are product-photography. Score 4 max for any background scene that needs production/process/setting.`
            : '';
        const imageQualityBlock = !(mediaType === 'image' || sourceHint === 'web-image' || /image|still|reference/.test(agentRole))
            ? ''
            : overlayVerifiedAbsent
            ? `

INDEPENDENT PIXEL/OCR RECHECK:
An isolated pixel-only check found NO large editorial headline/banner text in this image. Do not repeat a source caption, provider title, search-result description, filename, or metadata as visible text. Score only the actual pixels and scene relevance.`
            : allowEditorialText
            ? `

TEXTUAL-OBJECT SCENE — the Media Agent planned a textual object (book/album/poster cover, newspaper, magazine, sign, document, plaque) as THIS scene's subject. The cover/title/printed text on that object is NATIVE subject text — it is the WHOLE POINT of the shot, not an editorial overlay defect. Do NOT apply the "EDITORIAL TEXT OVERLAY → max 4" cap here and do NOT emit the "EDITORIAL TEXT OVERLAY:" prefix for text that belongs to the object itself.
Score on whether the frame clearly shows the RIGHT object the Agent asked for (the correct book/album/poster), legible and well-framed → 7-9 for a clean, correct, on-subject object. Still cap (max 4) ONLY if a SEPARATE article header / site watermark / banner was added ON TOP of the object photo by a web page (text about the object, layered over it), or if it is the wrong object entirely.`
            : `

WEB/REFERENCE IMAGE QUALITY — MANDATORY FIRST CHECK:
Before scoring, look at the frame and decide: is there headline/title/banner text RENDERED ON TOP of the image as a graphic layer (the way a blog header, SEO article cover, infographic, or YouTube-style cover does it), where that rendered text is one of the largest visual elements in the frame?

Two categories of on-image text — DO NOT CONFUSE THEM:
(A) NATIVE subject text — text that belongs to the real subject and would be there if you photographed it: an error code shown on the appliance's own screen/control panel, words printed on the product label, brand name on the device, words on a real document, UI/screenshot text inside the device's display, captions on charts/maps, names on tombstones, signs on buildings. This is FINE. Score normally.
(B) EDITORIAL OVERLAY text — text added on top by an article author/designer: a headline like "JENN-AIR ERROR CODES" rendered in large type across the upper half of the image, a title bar, a banner, a "TOP 5 FIXES" cover text, a watermark-style heading, a list of code names rendered as graphics next to a small product photo. This is NEVER fine for B-roll. The image is an article header, not visual evidence.

Supplier/site watermarks or large stamped brand text added by the web page/source are also editorial overlay. A real product logo printed on the object is fine; a source watermark or designed banner sitting on top of the image is not.

The deciding test: would this text be present if a photographer simply took a picture of the real subject? If NO (the text only exists because someone designed an article cover or supplier/source stamp), it is editorial overlay.

IF EDITORIAL OVERLAY IS PRESENT — STRICT OUTPUT CONTRACT:
- Your one-sentence description MUST literally start with the prefix "EDITORIAL TEXT OVERLAY:" (uppercase, exact wording).
- After the prefix, briefly describe what the overlay text says AND what the underlying photo shows.
- Your score MUST be 4 or lower. No exceptions, even if the underlying photo is on-topic.
- Do NOT describe the rendered title as "branding", "label", "logo", "display", or "error code" — those words are reserved for category (A) native subject text. Editorial overlay is its own category.

For appliance/device error-code scenes specifically: the error text must appear on the appliance's own screen or control panel, not as a rendered headline. A photo of an oven with a "JENN-AIR ERROR CODES" title plastered across the top is editorial overlay — NOT a "touchscreen showing an error code".`;

        const prompt = `You are an agentic video editor deciding whether THIS frame works as B-roll for THIS scene.${contextBlock}${hunterBlock}${backgroundLiteralBlock}${imageQualityBlock}

PIXEL-EVIDENCE RULE: A source title, provider caption, search-result description, filename, URL, or prompt text is metadata — it is NOT text visible in the image. Report an editorial text overlay only when the letters themselves are visibly rendered in the supplied pixels.

Search keyword that found this clip (a HINT, not a hard requirement): "${keyword}"

Describe what you LITERALLY see in ONE short sentence (10-15 words max). Note any problems.

THE PRIMARY QUESTION (in this order):
1. Does this frame make sense playing under the SCENE NARRATION above?
2. Does it belong in a video about the VIDEO TOPIC above?
3. Is the keyword a reasonable label for it? (least important — keyword drift is fine if scene fit is strong)

AGENTIC SCORING — think like an editor, not a literal keyword matcher:
- The keyword is what the planner SEARCHED for, not a contract the frame must satisfy.
- If the Media Agent gave a minimum acceptable visual or acceptance test, treat that as the contract for this scene.
- A frame can score 7+ when it truthfully communicates the viewer need through visible evidence/context, even if it is a proxy rather than the perfect literal shot. Evidence means something visible in the frame/source: labels, signs, markings, screens, documents, packaging, facilities, tools, object details, same-category action, or the requested setting/process.
- Do NOT confuse truthful proxy evidence with random symbolism. If the visible subject does not help a viewer understand the scene, keep the score low.
- If the frame isn't a literal keyword match but clearly works as B-roll for the scene narration + video topic, score 6-7. Do not punish keyword drift when scene fit is good.
- Example: keyword="big box store appliance aisle", scene is about durable household goods, frame shows a hardware store tool aisle → score 7 (works as B-roll, same retail-shopping vibe, same scene mood). Do NOT reject for "not literally appliances".
- Example: keyword="Strait of Hormuz cargo", scene is about Iran-US tensions, frame shows generic cargo ship at sea → score 7 (no Hormuz-specific stock exists; this is the right subject for the scene).
- Example: keyword="oil pipeline", scene is about energy infrastructure → frame shows oil refinery → score 7 (related infrastructure, fits scene).

MANDATORY ENTITY RULE:
- If MANDATORY FRAME-VISIBLE ENTITY is listed, that named brand/product/person/org must be visibly identifiable in the frame for a high score.
- Do NOT require a perfect shot: reviews, demos, showroom clips, comparison layouts, hands operating the product, control-panel shots, or partial views can score 7+ if the mandatory entity is identifiable and the scene still works.
- If the mandatory entity is not visible/identifiable, score 4 or lower even if the generic category is right.
- If MANDATORY IDENTITY says source-proven, the source title/page can prove the named identity. In that case, score the frame on whether it shows the requested real-world subject/process/setting; do not cap solely because the logo/name is not readable in this exact frame.

LITERAL VS SYMBOLIC: a circuit board does NOT match "underwater drone" even if drones contain circuits. Symbolic/metaphorical leaps are still wrong. But subject-adjacent footage that fits the scene narration IS right.

VIDEO TOPIC GUARD: if the frame clearly belongs to a DIFFERENT video topic entirely (spaceship for dome-homes video, war-zone explosion for oil-crisis video, cat video for any serious topic) → MAX score 3. This guard is for wrong-video footage, not for keyword drift within the same video.

Examples of CORRECT keyword-drift-but-scene-fit (score 6-8):
- Video topic "buy-it-for-life brands", keyword "appliance aisle", frame shows hardware-store tool wall = 7 (same shopping/retail context, B-roll works)
- Video topic "Iran oil conflict", keyword "Strait of Hormuz", frame shows oil tanker at sea = 7 (right scene, generic subject)
- Video topic "Saudi energy", keyword "oil pipeline", frame shows desert refinery = 7 (right infrastructure family)
- Video topic "9/11 attacks", keyword "Twin Towers", frame shows actual Twin Towers = 10 (exact event)

Examples of WRONG (score 1-4):
- Video topic "dome construction", keyword "wind tunnel test", frame shows airplane in wind tunnel = 2 (wrong subject for the video, not just wrong keyword)
- Video topic "oil crisis", keyword "explosion", frame shows fireworks display = 2 (wrong scene mood entirely)
- Keyword "Iran Strait of Hormuz", frame shows a cat video = 1 (unrelated to any plausible scene)
- Keyword "economic policy", frame shows news anchor at desk = 3 (correct topic, wrong content type — studio talking head)

SPECIFIC EVENT/PERSON RULE: When the keyword references a SPECIFIC identifiable event (e.g. "9/11 towers attack", "Fukushima explosion", "Capitol riot") or a SPECIFIC person (leader, politician, celebrity), demand footage of THAT actual event/person — score 9-10 for exact match, 4-5 for generic related footage.

PERSON KEYWORDS: If the keyword contains a person's name, a photo or portrait of that person IS the correct match — score 7-9. If the keyword is a name and the image shows a person matching the described context (e.g. "King Khalid Saudi Arabia" → man in Saudi royal attire), give benefit of the doubt and score 7+. This is NOT a "talking head" penalty — talking head penalty only applies to NEWS ANCHORS/PRESENTERS.

RELEVANT PERSON RULE: If the scene is about a named/relevant person (leader, official, celebrity, athlete, CEO, worker, soldier, protester), clean footage/photo of that person or role can score 7-9. This is NOT a presenter penalty. The penalty is for anchors, hosts, commentators, studio shots, picture-in-picture faces, or random people explaining the topic.

AUTOMATIC PENALTIES (hard caps, override all other scoring):
- Map/locator/satellite screenshot/route graphic when real footage is needed -> MAX score 2
- Picture-in-picture face, webcam box, presenter inset, or visible host overlay -> MAX score 2
- News anchor / presenter reading news at a studio desk → MAX score 3 (unusable for faceless video)
- YouTuber/presenter/commentator talking to camera or standing in front of subject → MAX score 3 unless they are the named subject of the scene and the footage is clean
- Studio set with desk, microphones, teleprompter → MAX score 3
- Text-heavy screen (headlines, tickers, lower thirds filling >30% of frame) → MAX score 3
${overlayVerifiedAbsent
    ? '- Independent pixel/OCR verification found no editorial overlay. Do not apply an editorial-text cap.'
    : allowEditorialText
    ? '- This is a TEXTUAL-OBJECT scene: a book/album/poster cover, sign, or document is the subject. Its OWN printed/cover text is fine. Cap (max 4) ONLY external article-header/banner/watermark text added ON TOP of the object photo by a web page.'
    : '- Web/reference image with external editorial/title/banner text pasted over the photo → MAX score 4'}
- Large/centered/prominent watermark, channel logo, or agency stamp (e.g., IRNA, AFP, Getty, Reuters logo) → MAX score 3
- Small corner logo/channel bug that does not cover the subject → minor penalty only; clean strong footage can still score 6-8
- Foreign-language text overlay or subtitle burned into the image → MAX score 3
- Still photo with "Ken Burns" border/frame → -2 from base score
- AI-generated or illustrated content when real footage is needed → MAX score 2
- Visibly low-resolution, upscaled, pixelated, or heavily compressed footage → MAX score 4 (broadcast quality bar)

SCORING RUBRIC (think: would I CUT to this frame in this scene?):
- 9-10: Exact event/person match, or perfect scene fit — clean real footage, clearly belongs.
- 7-8: Strong scene fit. Real footage that works as B-roll for the scene narration + video topic, even if the keyword label isn't literal. This is the band where keyword-drift-but-scene-correct lives — reward it.
- 5-6: Usable B-roll for the video topic, weaker scene-specific fit. Minor issues. Editor would consider this if nothing better existed.
- 3-4: Wrong subject for the video topic, OR news anchor/studio talking head, OR matches a word in the keyword but not the scene meaning.
- 1-2: Unrelated to any plausible scene in this video, heavy watermarks/logos, AI-generated, or hard-penalty content.

Reply format (exactly 2 lines):
[your one-sentence description]
[score number]`;

        const response = await callVisionAI(prompt, base64Image, mimeType);
        const lines = response.trim().split('\n').filter(l => l.trim());
        let description = '';
        // null = "not parsed yet" — NEVER 0. Every parse path below clamps with
        // Math.max(1, …), so a successfully parsed score can never BE 0. Using 0
        // as the sentinel made "I could not read the answer" indistinguishable
        // from a real verdict: the caller reported it upward as "vision API
        // unavailable", and one working model rejecting junk could abort an
        // entire footage race. 1 in 5 judged candidates were binned this way.
        let score = null;

        // Parse: last line with a number is the score, everything before is description
        for (let i = lines.length - 1; i >= 0; i--) {
            const rawLine = lines[i].trim();
            // Strict original form FIRST, so every response that parsed before
            // still parses to exactly the same value; the tolerant form only
            // ever rescues lines that used to fall through as unparseable.
            const numMatch = rawLine.match(/^(\d+)$/);
            const parsed = numMatch ? parseInt(numMatch[1]) : _scoreFromScoreLine(rawLine);
            if (parsed !== null) {
                score = Math.min(10, Math.max(1, parsed));
                description = lines.slice(0, i).join(' ').trim();
                break;
            }
        }

        // Fallback: find an explicit score-looking number. Do not grab random
        // visual numbers like "4K", model numbers, years, or quantities.
        if (score === null) {
            const scoreLike = response.match(/(?:score|rating)\D{0,16}(10|[0-9])\s*(?:\/\s*10)?/i)
                || response.match(/(?:^|\n)\s*(10|[0-9])\s*(?:\/\s*10)?\s*$/m);
            if (scoreLike) score = Math.min(10, Math.max(1, parseInt(scoreLike[1])));
            description = lines[0] || response.trim();
        }

        // Last resort before paying for a retry: the model merged both lines and
        // appended the score to its description ("… at dusk. 7" / "… at dusk — 7/10").
        // A punctuation separator is REQUIRED so this can never lift a number out
        // of prose ("7 floors", "Route 66.", "capacity 80,000").
        if (score === null && lines.length) {
            const tail = lines[lines.length - 1].replace(/[*_`]/g, '').trim();
            const merged = tail.match(/[.!?:;—–-]\s*(10|\d)\s*(?:\/\s*10)?\s*[.!]?$/);
            if (merged) {
                score = Math.min(10, Math.max(1, parseInt(merged[1])));
                description = lines.slice(0, -1).join(' ').trim()
                    || tail.slice(0, merged.index).trim();
            }
        }

        if (score === null) {
            // Score-less response (model rambled or quota-degraded into prose).
            // 30 candidates per build were thrown away "unjudged" because this
            // returned parseError without ever retrying. ONE strict retry —
            // same provider chain, format-only nudge — recovers most of them.
            if (description) {
                try {
                    const strict = await callVisionAI(
                        `${prompt}\n\nIMPORTANT: your previous answer omitted the score. Reply with EXACTLY two lines — line 1: one-sentence description; line 2: a single digit score 0-10. Nothing else.`,
                        base64Image, mimeType
                    );
                    const sLines = strict.trim().split('\n').filter(l => l.trim());
                    for (let i = sLines.length - 1; i >= 0; i--) {
                        const rawLine = sLines[i].trim();
                        // Original loose form first (accepts "7 - strong fit"),
                        // then the decoration-tolerant form ("**7**", "7/10").
                        const m = rawLine.match(/^(10|[0-9])\b/);
                        const parsed = m ? parseInt(m[1]) : _scoreFromScoreLine(rawLine);
                        if (parsed !== null) {
                            return {
                                score: Math.min(10, Math.max(1, parsed)),
                                description: sLines.slice(0, i).join(' ').trim() || description,
                                scoreRetried: true,
                            };
                        }
                    }
                } catch (_) { /* fall through to parseError */ }
            }
            // Externally the contract is unchanged: score 0 + parseError true.
            // Callers MUST keep treating this as "not judged", never as "bad" —
            // and never as "the service is down" (that is apiError).
            return {
                score: 0,
                description,
                parseError: true,
                errorMessage: 'vision response missing numeric score',
            };
        }

        return { score, description };
    } catch (err) {
        // A frame no decoder can read is a DEFECT IN THIS CANDIDATE, not an
        // outage. Reporting it as apiError would make callers keep the clip
        // (apiError means "the service broke, don't blame the footage") and a
        // broken image could win its scene. Third distinct outcome, alongside
        // parseError ("not judged") and apiError ("service down").
        if (err?.visionImageUnreadable) {
            return {
                score: 0,
                description: 'Frame could not be decoded by any image reader',
                imageUnreadable: true,
                errorMessage: err?.message?.slice(0, 200) || 'undecodable image',
            };
        }
        // Surface API failures distinctly from "model said this is bad".
        // Callers can detect apiError=true and refuse to reject the clip
        // (the API was broken, not the candidate).
        return { score: 0, description: 'Vision AI error', apiError: true, errorMessage: err?.message?.slice(0, 200) || 'unknown' };
    }
}

/**
 * Read a score out of a single line that is *meant to be* the score line.
 *
 * Tolerates the decoration models actually emit around it — markdown emphasis
 * ("**7**"), list markers ("- 7"), a label ("Score: 7"), the "/10" suffix and
 * trailing punctuation ("7.") — while still refusing any line carrying extra
 * words or digits, so "7 floors", "4K", "2019" and "100" can never be misread
 * as a score.
 *
 * Returns an integer 0-10, or null when the line is not a score line.
 */
function _scoreFromScoreLine(line) {
    const cleaned = String(line || '')
        .replace(/[*_`~#>[\]]/g, '')
        .replace(/^[\s\-•–—]+/, '')
        .trim();
    if (!cleaned) return null;
    const m = cleaned.match(/^(?:(?:final|overall)\s+)?(?:score|rating)?\s*[:=-]?\s*(10|\d)\s*(?:\/\s*10)?\s*[.!]?$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
}

function _parseEditorialOverlayVerification(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        const transcript = String(parsed.text || '').trim();
        const confidence = Math.max(0, Math.min(10, Number(parsed.confidence) || 0));
        const hasTranscript = transcript.length >= 3
            && !/^(?:none|no|n\/a|not present|unreadable)$/i.test(transcript);
        return {
            present: parsed.present === true && confidence >= 7 && hasTranscript,
            text: hasTranscript ? transcript : '',
            confidence,
            raw: text,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Pixel-only OCR confirmation for editorial overlays. This deliberately omits
 * source titles, provider captions, keywords, and scene text so metadata cannot
 * leak into the verdict. A rejection requires both high confidence and an
 * actual transcription of visible letters.
 */
async function verifyEditorialTextOverlay(base64Image, mimeType = 'image/jpeg') {
    try {
        const raw = await callVisionAI(`Inspect ONLY the supplied image pixels.

Question: Is there a large editorial headline, title banner, article-cover caption, or supplier watermark digitally overlaid on top of the underlying photo?

Do not count native text physically belonging to the photographed subject, such as a real sign, product label, device screen, document, map label, or building lettering.
Do not infer or copy any filename, source caption, search-result title, metadata, or prompt wording.

If present=true, transcribe the exact visible overlay letters. If you cannot transcribe at least 3 visible characters, present MUST be false.

Reply with JSON only:
{"present":false,"text":"","confidence":0}`, base64Image, mimeType, { maxTokens: 120 });
        return _parseEditorialOverlayVerification(raw);
    } catch (_) {
        return null;
    }
}

/**
 * Check if vision AI is configured and available for the current provider.
 */
function isVisionAvailable() {
    return isVisionAIAvailable();
}

// ============ MAIN EXPORT ============

async function analyzeSceneVisuals(scenes, scriptContext) {
    console.log('\n👁️ Analyzing downloaded footage with Vision AI...');
    let chain = [];
    try { chain = getVisionProviderChain(); } catch (_) {}
    console.log(`📡 Vision route: ${(chain.length ? chain.join(' → ') : config.aiProvider).toUpperCase()}\n`);

    const results = [];

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const shortText = scene.text ? scene.text.substring(0, 40) : '';
        console.log(`  Scene ${i}: "${shortText}..."`);

        try {
            const frame = await getSceneFrame(scene, i);
            if (!frame) {
                console.log('    ⚠️ No frame to analyze (skipped)');
                results.push(createDefaultAnalysis(i));
                continue;
            }

            const prompt = buildVisionPrompt(scene.text, scriptContext ? scriptContext.summary : '');
            const rawText = await callVisionAI(prompt, frame.base64, frame.mimeType);
            const analysis = parseVisionResponse(rawText, i);

            const icon = analysis.suitability === 'good' ? '✅' : analysis.suitability === 'poor' ? '❌' : '⚠️';
            console.log(`    ${icon} ${analysis.suitability}: "${analysis.description.substring(0, 50)}"`);
            results.push(analysis);
        } catch (error) {
            console.log(`    ⚠️ Vision failed: ${error.message}`);
            results.push(createDefaultAnalysis(i));
        }
    }

    const analyzed = results.filter(r => r.description !== 'No visual analysis available').length;
    const poor = results.filter(r => r.suitability === 'poor').length;
    console.log(`\n📊 Vision analysis: ${analyzed}/${scenes.length} analyzed`);
    if (poor > 0) {
        console.log(`   ⚠️ ${poor} scene(s) with poor footage match`);
    }
    console.log('');

    return results;
}

/**
 * Analyze a single scene's footage with Vision AI.
 * Used by the retry step to re-score replacement footage.
 * @param {Object} scene - Scene object with mediaFile, mediaExtension, text, startTime, endTime
 * @param {number} sceneIndex - Scene index
 * @param {Object} scriptContext - Script context with summary
 * @returns {Object} Vision analysis result
 */
async function analyzeSingleScene(scene, sceneIndex, scriptContext) {
    try {
        const frame = await getSceneFrame(scene, sceneIndex);
        if (!frame) return createDefaultAnalysis(sceneIndex);

        const prompt = buildVisionPrompt(scene.text, scriptContext ? scriptContext.summary : '');
        const rawText = await callVisionAI(prompt, frame.base64, frame.mimeType);
        return parseVisionResponse(rawText, sceneIndex);
    } catch (error) {
        return createDefaultAnalysis(sceneIndex);
    }
}

/**
 * Locate the main subject in a frame so the framing worker can anchor a fill-frame
 * crop and NOT cut off the face. Returns the subject's center as { focusX, focusY }
 * in 0..1 (0=left/top, 1=right/bottom). For a person, points at the FACE/head.
 * Falls back to center on any failure (safe — same as today's behavior).
 */
async function detectSubjectFocus(base64Image, mimeType) {
    const fallback = { focusX: 0.5, focusY: 0.5, ok: false };
    try {
        if (!base64Image) return fallback;
        const prompt = `Look at this image. Find the MAIN SUBJECT — for a person, their FACE/head; for an object, its visual center.
Return ONLY JSON: {"focusX": 0.0-1.0, "focusY": 0.0-1.0}
- focusX: horizontal center of the subject (0=far left, 0.5=center, 1=far right)
- focusY: vertical center of the subject (0=very top, 0.5=middle, 1=very bottom)
For a standing/seated person, focusY is usually 0.15-0.4 (the head sits high). If no clear subject, return {"focusX":0.5,"focusY":0.5}. No prose.`;
        const raw = await callVisionAI(prompt, base64Image, mimeType, { maxTokens: 60 });
        const m = String(raw || '').match(/\{[^}]*\}/);
        if (!m) return fallback;
        const parsed = JSON.parse(m[0]);
        const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
        const fx = clamp(parsed.focusX);
        const fy = clamp(parsed.focusY);
        if (!Number.isFinite(fx) || !Number.isFinite(fy)) return fallback;
        return { focusX: fx, focusY: fy, ok: true };
    } catch (_) {
        return fallback;
    }
}

/**
 * Multi-frame subject focus (OPENMONTAGE-BORROW-PLAN #16). Runs detectSubjectFocus
 * on several frames sampled across a clip so the framing worker can SMOOTH a
 * moving subject (lock or gentle pan) instead of anchoring on one midpoint frame.
 * Sequential (bounds vision load); returns the per-frame samples in time order.
 * @param {Array<{base64:string, mimeType?:string, timestamp?:number}>} frames
 * @returns {Promise<Array<{t:number, focusX:number, focusY:number, ok:boolean}>>}
 */
async function detectSubjectFocusTrajectory(frames) {
    const out = [];
    if (!Array.isArray(frames)) return out;
    for (const f of frames) {
        if (!f || !f.base64) continue;
        const r = await detectSubjectFocus(f.base64, f.mimeType || 'image/jpeg');
        out.push({ t: Number(f.timestamp) || out.length, focusX: r.focusX, focusY: r.focusY, ok: !!r.ok });
    }
    return out;
}

module.exports = {
    analyzeSceneVisuals,
    analyzeSingleScene,
    createDefaultAnalysis,
    analyzeArticleHighlights,
    scoreVideoFrame,
    verifyEditorialTextOverlay,
    _parseEditorialOverlayVerification,
    _scoreFromScoreLine,
    detectSubjectFocus,
    detectSubjectFocusTrajectory,
    isVisionAvailable,
    checkFfmpegAvailable,
};
