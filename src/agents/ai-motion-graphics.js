const axios = require('axios');
const config = require('../settings/config');
const { callAI } = require('../brain/ai-provider');
const { getTheme, MG_THEME_OVERRIDES } = require('../data/themes');
const { getNiche } = require('../data/niches');
const { MG_REGISTRY } = require('../render/mg-registry');
const { getLanguageBlock } = require('../data/language-helper');
const { pickPack: pickMapPack, DEFAULT_PACK_ID: DEFAULT_MAP_PACK_ID } = require('../map/map-style-packs');
const { validateOverlayHintPlacement } = require('./planner-display-guards');
const { recoverDataPairs } = require('./mg-data-recovery');

// Track placed MG types to avoid repetition
let placedTypes = [];
let lastType = '';
let aiInstructionsRef = '';

// ============ MG CONTEXT TRACKER ============
// Cross-scene awareness: tracks placed MGs to prevent duplicates, ensure variety,
// and provide narrative arc context to downstream decisions.

class MGContextTracker {
    constructor(scenes, scriptContext) {
        this.placed = [];           // { type, text, sceneIndex, startTime }
        this.textHashes = new Set(); // normalized text fingerprints
        this.typeLastSeen = {};      // type → sceneIndex of last placement

        // Build narrative arc from scene positions
        const total = scenes.length;
        this.arcTags = scenes.map((_, i) => {
            const pos = i / Math.max(1, total - 1);
            if (pos <= 0.10) return 'hook';         // first 10%
            if (pos <= 0.25) return 'setup';         // 10-25%
            if (pos <= 0.75) return 'build';         // 25-75% (main body)
            if (pos <= 0.90) return 'climax';        // 75-90%
            return 'conclusion';                      // last 10%
        });

        // Store topic for context
        this.topic = scriptContext?.summary || '';
        this.format = scriptContext?.format || 'documentary';
    }

    /** Get narrative arc tag for a scene */
    getArc(sceneIndex) {
        return this.arcTags[sceneIndex] || 'build';
    }

    /** Record a placed MG */
    record(mg) {
        const entry = { type: mg.type, text: mg.text || '', sceneIndex: mg.sceneIndex, startTime: mg.startTime };
        this.placed.push(entry);
        this.typeLastSeen[mg.type] = mg.sceneIndex;
        this.textHashes.add(this._fingerprint(mg.text));
    }

    /** Check if text is too similar to any recently placed MG */
    isDuplicateText(text) {
        return this.textHashes.has(this._fingerprint(text));
    }

    /** Get scene gap since this type was last used */
    sceneGapSince(type, currentIndex) {
        const last = this.typeLastSeen[type];
        if (last === undefined) return Infinity;
        return currentIndex - last;
    }

    /** Get types placed in the last N scenes */
    recentTypes(currentIndex, window = 3) {
        return this.placed
            .filter(p => currentIndex - p.sceneIndex <= window)
            .map(p => p.type);
    }

    /** Normalize text to a comparable fingerprint (lowercase, no stop words, sorted key words) */
    _fingerprint(text) {
        if (!text) return '';
        const stop = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','that','this','from','by','it','its','has','have','had','be','been','being','not','no','do','does','did']);
        const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
            .filter(w => w.length > 2 && !stop.has(w));
        // Sort so "John won the race" and "the race John won" produce same fingerprint
        return words.sort().join(' ');
    }
}

// ============ SMART TEXT EXTRACTION ============
// Extract the key phrase from scene text — not just first N words, but the most important clause.

function extractKeyPhrase(text, maxWords = 8) {
    if (!text) return '';
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return text.trim();

    // Strategy 1: Find a clause with a strong signal word
    const signalPatterns = [
        /(?:the\s+(?:truth|reality|fact|key|secret|answer|problem|solution)\s+(?:is|was)\s+).{5,60}/i,
        /(?:this\s+(?:is|was|means|changed|proves)\s+).{5,60}/i,
        /(?:known\s+(?:as|for)\s+).{5,60}/i,
        /(?:called\s+).{5,40}/i,
        /(?:because\s+).{5,60}/i,
    ];
    for (const pattern of signalPatterns) {
        const match = text.match(pattern);
        if (match) {
            return match[0].split(/\s+/).slice(0, maxWords).join(' ');
        }
    }

    // Strategy 2: Find a clause after a comma or dash (often the key insight)
    const clauses = text.split(/[,\u2014\u2013—–]/).map(c => c.trim()).filter(c => c.length > 15);
    if (clauses.length >= 2) {
        // Pick the clause with the most "interesting" words (proper nouns, numbers)
        const scored = clauses.map(c => {
            const cWords = c.split(/\s+/);
            let score = 0;
            for (const w of cWords) {
                if (/^\d/.test(w)) score += 3;       // numbers
                if (/^[A-Z][a-z]/.test(w)) score += 2; // proper nouns
                if (w.length > 6) score += 1;          // long words
            }
            return { clause: c, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored[0].clause.split(/\s+/).slice(0, maxWords).join(' ');
    }

    // Strategy 3: Fallback — skip common lead-in words and take from there
    const leadIns = /^(?:and\s+|but\s+|so\s+|then\s+|however\s+|meanwhile\s+|in\s+fact\s+|actually\s+)/i;
    const cleaned = text.replace(leadIns, '');
    return cleaned.split(/\s+/).slice(0, maxWords).join(' ');
}

// Strip stage directions / screenplay annotations that leak into MG text.
// The AI (and VP) sometimes copies narration markers like "[TEXT GLITCHES AND FLICKERS]"
// or "(dramatic pause)" into the display text — those are camera/effect directions,
// not content to render.
function sanitizeMGText(text) {
    if (!text) return '';
    let s = String(text);
    // Strip [ ... ] stage directions (bracket notation — never content).
    s = s.replace(/\[[^\]]*\]/g, ' ');
    // Strip (CUE) / (FX) / (BEAT) / (PAUSE) / (SFX) / (VFX) / (MUSIC) — ALL-CAPS short parentheticals
    // are nearly always stage directions, never content. Don't strip mixed-case ones
    // like "(2023)" or "(the Gulf)".
    s = s.replace(/\(\s*[A-Z][A-Z0-9 _\-\/]{1,30}\s*\)/g, ' ');
    // Common ALL-CAPS stage keywords even without parens at start/end
    s = s.replace(/\b(?:TEXT\s+(?:GLITCHES?|FLICKERS?|CRAWLS?|SCROLLS?|FADES?))\b/gi, ' ');
    s = s.replace(/\b(?:CUT\s+TO|FADE\s+(?:IN|OUT)|DISSOLVE\s+TO|B-?ROLL|VOICEOVER|V\.O\.|O\.S\.|SFX|VFX)\s*:?/gi, ' ');
    // Collapse whitespace
    s = s.replace(/\s+/g, ' ').trim();
    // Strip leading/trailing stray punctuation left behind by the stage-direction strip.
    // Do NOT strip trailing "." — that's a legitimate sentence end.
    s = s.replace(/^[:;,.\-–—\s]+/, '').trim();
    s = s.replace(/[:;,\-–—\s]+$/, '').trim();
    // Strip wrapping quotes/asterisks if they bracket the whole string
    s = s.replace(/^["'*`“”‘’]+|["'*`“”‘’]+$/g, '').trim();
    return s;
}

const WEAK_FOCUS_WORDS = new Set([
    'global', 'trade', 'shipping', 'route', 'routes', 'system', 'share',
    'economy', 'economic', 'market', 'world', 'region', 'thing', 'point',
    'movement', 'moving', 'another', 'second', 'supposed', 'because', 'while', 'this',
    'that', 'these', 'those', 'there', 'their', 'around', 'nearly'
]);

function _focusWords(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9%+\-\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function _titleCaseFocus(value) {
    return _focusWords(value)
        .slice(0, 3)
        .map(word => {
            if (/^[A-Z0-9%+\-]+$/.test(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
}

function _isWeakFocusText(value) {
    const words = _focusWords(value).map(w => w.toLowerCase());
    if (words.length === 0) return true;
    if (words.length === 1) return WEAK_FOCUS_WORDS.has(words[0]);
    if (words.length <= 3 && words.every(w => WEAK_FOCUS_WORDS.has(w))) return true;
    if (/\b(?:share|facts?|data|traffic)\b/i.test(value) && /\bglobal\b/i.test(value)) return true;
    return false;
}

function _pickEditorialFocusPhrase(text) {
    const t = String(text || '');
    const patterns = [
        [/\banother route\b/i, 'Backup Route'],
        [/\bbackup\b/i, 'Backup Route'],
        [/\bsecond system\b/i, 'Second System'],
        [/\bkeeps?\s+global\s+trade\s+moving\b/i, 'Trade Lifeline'],
        [/\bquietly\s+becoming\s+unstable\b/i, 'Route Instability'],
        [/\bshipping\s+choke ?point\b/i, 'Shipping Chokepoint'],
        [/\bchoke ?point\b/i, 'Chokepoint Risk'],
        [/\bsupply chain\b/i, 'Supply Chain'],
        [/\brisk\s+is\s+enough\b/i, 'Risk Alone'],
        [/\bnarrowest\s+point\b/i, 'Narrow Chokepoint'],
        [/\btime\s+savings?\b/i, 'Time Savings'],
        [/\bworst\s+case\b/i, 'Worst Case'],
        [/\befficiency\b/i, 'Efficiency'],
        [/\bdisruption\b/i, 'Disruption'],
        [/\binstability\b/i, 'Instability'],
    ];
    for (const [re, label] of patterns) {
        if (re.test(t)) return label;
    }
    return '';
}

function normalizeFocusWordPayload(raw, scene) {
    const cleaned = sanitizeMGText(raw)
        .replace(/^(?:and|but|so|then|because|while|this|that)\s+/i, '')
        .trim();
    const compact = _titleCaseFocus(cleaned);
    const editorial = _pickEditorialFocusPhrase(scene?.text || '');
    if (!compact || _isWeakFocusText(compact)) {
        return editorial || _titleCaseFocus(extractKeyPhrase(scene?.text || '', 3)) || 'Key Shift';
    }
    if (editorial && /\b(?:share|facts?|data|traffic)\b/i.test(compact)) {
        return editorial;
    }
    return compact;
}

function pickFocusTriggerWord(displayText, scene) {
    const words = _focusWords(displayText);
    if (words.length === 0) return '';
    const sceneWords = Array.isArray(scene?.words) ? scene.words : [];
    for (const word of words) {
        const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!normalized || WEAK_FOCUS_WORDS.has(normalized)) continue;
        if (sceneWords.some(w => String(w.word || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalized))) {
            return word;
        }
    }
    return words.find(w => !WEAK_FOCUS_WORDS.has(w.toLowerCase())) || words[0];
}

function _isDateOnlyStatText(value) {
    const s = sanitizeMGText(value).replace(/\s+/g, ' ').trim();
    if (!s) return false;
    const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const year = '(?:18|19|20|21)\\d{2}';
    const monthYear = new RegExp(`^${month}\\s+${year}$`, 'i');
    const monthDayYear = new RegExp(`^${month}\\s+\\d{1,2},?\\s+${year}$`, 'i');
    const dayMonthYear = new RegExp(`^\\d{1,2}\\s+${month}\\s+${year}$`, 'i');
    if (new RegExp(`^${year}$`).test(s)) return true;
    if (new RegExp(`^q[1-4]\\s+${year}$`, 'i').test(s)) return true;
    if (monthYear.test(s) || monthDayYear.test(s) || dayMonthYear.test(s)) return true;
    if (new RegExp(`^${year}\\s*(?:->|-|–|—|to)\\s*${year}$`, 'i').test(s)) return true;
    return false;
}

function _isYearRangeStatText(value) {
    return /^\d{4}\s*[→\-–—to]+\s*\d{4}$/.test(String(value || '').trim());
}

function _hasNumericPayload(value) {
    const s = String(value || '');
    if (/\d/.test(s)) return true;
    return /\b(?:no\.?|number|rank(?:ed)?|seed|place)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(s);
}

// statCounter stays reserved for genuinely big numbers (100+ / % / scale words).
// A hint that fails that bar is still a number, score or date the planner wanted on
// screen — demote it to an overlay lowerThird instead of dropping the graphic.
// Year ranges are excluded: multi-year spans belong to the timeline path.
function _statHintDemotionTarget(hintContent, sceneText, allowedMGs) {
    if (!Array.isArray(allowedMGs) || !allowedMGs.includes('lowerThird')) return null;
    if (_isYearRangeStatText(hintContent)) return null;
    if (!_hasNumericPayload(hintContent) && !_hasNumericPayload(sceneText)) return null;
    return 'lowerThird';
}

// Mirrors the statCounter gate used by the VP direct-build path.
function _statHintQualifiesAsStat(hintContent, sceneText) {
    if (_isDateOnlyStatText(hintContent)) return false;
    const hintStat = CONTENT_PATTERNS.statistic(String(hintContent || ''));
    const sceneStat = CONTENT_PATTERNS.statistic(String(sceneText || ''));
    return hintStat.score >= 3 || sceneStat.score >= 3;
}

function _typeCapReached(type, alreadyPlaced = placedTypes) {
    if (TYPE_CAPS[type] === undefined) return false;
    return alreadyPlaced.filter(t => t === type).length >= TYPE_CAPS[type];
}

// Classification: full-screen MGs go on V3, overlay MGs stay on MG track
const FULLSCREEN_MG_TYPES = new Set([
    'barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart'
    // NOTE: listicleGrid removed — now handled by ai-templates.js
    // NOTE: kineticText moved to overlay-only (Apr 25) — typography overlay paired with footage/template background
]);

// Default positions by type
const POSITION_MAP = {
    headline: 'center',
    lowerThird: 'bottom-left',
    statCounter: 'center',
    callout: 'center',
    bulletList: 'center-left',
    focusWord: 'center',
    progressBar: 'center',
    barChart: 'center',
    donutChart: 'center',
    comparisonCard: 'center',
    timeline: 'center',
    rankingList: 'center-left',
    kineticText: 'center',
    mapChart: 'center',
    explainer: 'bottom-right',
    typewriter: 'center',
};

// Style themes — must match MotionGraphics.jsx STYLES
const STYLE_NAMES = ['clean', 'bold', 'minimal', 'neon', 'cinematic', 'elegant'];

// Map visual styles — must match MotionGraphics.jsx MAP_VISUAL_STYLES
const MAP_STYLE_NAMES = ['dark', 'natural', 'satellite', 'light', 'political'];

// ============ MAP STYLE PICKER ============
// Picks a map visual style based on script context and MG style

function pickMapStyle(scriptContext, mgStyle) {
    // Check user instructions for explicit map style preference
    if (aiInstructionsRef) {
        const instr = aiInstructionsRef.toLowerCase();
        for (const ms of MAP_STYLE_NAMES) {
            if (instr.includes(ms + ' map') || instr.includes('map style: ' + ms) || instr.includes('map style ' + ms)) return ms;
        }
        if (/natural earth|earth style|terrain/.test(instr)) return 'natural';
        if (/satellite|space|aerial/.test(instr)) return 'satellite';
        if (/light map|white map|bright map/.test(instr)) return 'light';
        if (/political|atlas|classic map/.test(instr)) return 'political';
    }

    if (!scriptContext || !scriptContext.summary) {
        // Match to MG style as fallback
        if (mgStyle === 'neon' || mgStyle === 'elegant') return 'satellite';
        if (mgStyle === 'cinematic') return 'natural';
        return 'dark';
    }

    const summary = (scriptContext.summary + ' ' + (scriptContext.tone || '')).toLowerCase();

    if (/nature|environment|climate|geography|earth|wildlife|forest|ocean/.test(summary)) return 'natural';
    if (/space|satellite|tech|cyber|ai|digital/.test(summary)) return 'satellite';
    if (/education|school|academic|research|study/.test(summary)) return 'light';
    if (/politic|govern|election|diplomacy|nation|geopolitic|war|conflict/.test(summary)) return 'political';

    // Fallback: match to MG style
    if (mgStyle === 'neon' || mgStyle === 'elegant') return 'satellite';
    if (mgStyle === 'cinematic') return 'natural';
    if (mgStyle === 'minimal') return 'light';
    return 'dark';
}

// ============ STYLE PICKER ============
// Gets MG style from unified theme system

function pickStyle(scriptContext) {
    // Check if user instructions specify a style preference (override)
    if (aiInstructionsRef) {
        const instr = aiInstructionsRef.toLowerCase();
        for (const style of ['neon', 'elegant', 'cinematic', 'bold', 'minimal', 'clean']) {
            if (instr.includes(style + ' style') || instr.includes('style: ' + style) || instr.includes('style ' + style)) return style;
        }
    }

    // Get style from unified theme (set by AI Director)
    if (scriptContext && scriptContext.themeId) {
        const theme = getTheme(scriptContext.themeId);
        return theme.mgStyle;
    }

    // Fallback
    return 'clean';
}

// ============ HYBRID MG CANDIDATE GENERATION ============
// Rule-based scoring that narrows the full MG type list to 2-5 best candidates
// per scene. AI then picks from these candidates instead of the full menu.

// Content pattern detectors — each returns a score (0-10) for how well a scene matches
const CONTENT_PATTERNS = {
    // Numbers, percentages, statistics — only when the number IS the point, not incidental
    // Dates, event numbers, ordinals, and contextual numbers are NOT stats
    // statCounter is ONLY for BIG numbers (100+) or numbers with scale words (million, %, etc.)
    statistic: (text) => {
        // Strong: number with unit/scale — "50 million", "3.2 billion", "47%"
        // But NOT "X-time" patterns like "three-time winner" — those are descriptions, not stats
        const scaledNum = text.match(/\d[\d,.]*\s*(%|percent|million|billion|trillion|thousand|hundred)/gi);
        if (scaledNum && scaledNum.length >= 1) return { score: 8, reason: 'scaled number stat' };
        // "X times" only counts if the number is large (100+), not "3 times" or "five times"
        const timesMatch = text.match(/(\d[\d,.]*)\s*(?:times|x\b|fold)/gi);
        if (timesMatch) {
            const hasLargeMultiplier = timesMatch.some(m => {
                const num = parseFloat(m.replace(/[^0-9.]/g, ''));
                return num >= 100;
            });
            if (hasLargeMultiplier) return { score: 8, reason: 'large multiplier stat' };
        }
        // Strong: currency amounts — "$2,000", "€500" (only if >= 100)
        const currMatch = text.match(/[\$€£]\s?(\d[\d,.]+)/);
        if (currMatch) {
            const val = parseFloat(currMatch[1].replace(/,/g, ''));
            if (val >= 100) return { score: 8, reason: 'currency amount' };
        }
        // Medium: number in a stat-presenting context — "reached 500", "grew to 1.4"
        const statCtx = text.match(/\b(?:reached|grew|rose|fell|dropped|cost|earned|spent|lost|gained|increased|decreased|doubled|tripled|totaled|averaged|surpassed|exceeded)\s+(?:to\s+)?[\$€£]?(\d[\d,.]*)\b/i);
        if (statCtx) {
            const val = parseFloat(statCtx[1].replace(/,/g, ''));
            if (val >= 100) return { score: 7, reason: 'number in stat context' };
        }

        // Weak: bare numbers — heavily filtered to avoid false positives
        // ONLY numbers >= 100 qualify (3+ digits = "big number")
        const bareNumbers = text.match(/\b\d[\d,.]+\b/g);
        if (bareNumbers) {
            const significant = bareNumbers.filter(n => {
                const val = parseFloat(n.replace(/,/g, ''));
                const idx = text.indexOf(n);
                const before = text.substring(Math.max(0, idx - 30), idx).toLowerCase();

                // Must be 100+ (3-digit minimum for statCounter)
                if (val < 100) return false;

                // Skip years (1800-2099) and decades ("the 1940s", "1960s")
                if (val >= 1800 && val <= 2099) return false;
                if (/\d{4}s/.test(n)) return false;

                // Skip date-adjacent: "in 1965", "by 1980", "since 1990", "around 1950"
                if (/\b(?:in|by|since|around|during|from|after|before|until)\s*$/.test(before) && val >= 1000 && val <= 2099) return false;

                // Skip ordinal event names: "World War 2", "Season 3", "Part 2", "Chapter 5"
                if (/\b(?:war|season|part|chapter|volume|episode|phase|round|version|act|generation|grade|level)\s*$/i.test(before)) return false;

                // Skip age/rank-like: "at age 15", "ranked 3rd"
                if (/\b(?:age|aged|rank|ranked|number|no\.?)\s*$/i.test(before)) return false;

                // Skip model/designation numbers — numbers that are part of a NAME, not a statistic
                // Hyphen-adjacent: "S-400", "F-35", "MiG-29", "AK-47"
                if (/[-‑]\s*$/.test(before)) return false;
                const after = text.substring(idx + n.length, idx + n.length + 15).toLowerCase();
                if (/^\s*[-‑]/.test(after)) return false;
                // Capitalized word directly before number = likely a name/model: "Bavar 373", "Type 052", "Mirage 2000"
                // Exception: stat verbs ("Reached 500", "Cost 200") are real stats
                const nameBeforeNum = /\b[A-Z][a-zA-Z]+\s*$/.test(before);
                if (nameBeforeNum && !/\b(?:reached|grew|rose|fell|dropped|cost|earned|spent|lost|gained|increased|decreased|totaled|surpassed|exceeded|worth|over|about|nearly)\s*$/i.test(before)) return false;
                // Short uppercase prefix: "S 400", "F 35", "T 72" (1-3 letter designations)
                if (/\b[A-Z]{1,3}\s*$/.test(before) && !/\b(?:OF|IN|AT|TO|BY|OR|AN|ON|IS)\s*$/i.test(before)) return false;
                // Number followed by a proper name = model designation: "373 system", not a stat
                if (/^\s*[A-Z][a-z]/.test(text.substring(idx + n.length, idx + n.length + 15))) {
                    // But allow "500 million", "200 percent" etc.
                    if (!/^\s*(?:million|billion|trillion|thousand|percent|%|times|fold)/i.test(after)) return false;
                }

                return true;
            });
            if (significant.length >= 2) return { score: 5, reason: 'multiple significant numbers' };
            if (significant.length === 1) return { score: 3, reason: 'single significant number' };
        }
        return { score: 0, reason: null };
    },

    // Percentage / completion patterns
    percentage: (text) => {
        if (/\d+\s*(%|percent)/i.test(text)) return { score: 8, reason: 'explicit percentage' };
        if (/\b(nearly|almost|about|roughly|approximately)\s+(half|third|quarter|two.thirds)/i.test(text)) return { score: 5, reason: 'approximate fraction' };
        return { score: 0, reason: null };
    },

    // Ranked / listed items
    ranking: (text) => {
        // Strong ranking signals (number-adjacent)
        if (/\b(top\s+\d+|ranked?\s+#?\d+|number\s+(one|two|three|four|five|\d+)|first\s+place)\b/i.test(text))
            return { score: 7, reason: 'ranking language' };
        // Superlatives only count if near a number or list context (avoid bare "the best way to...")
        if (/\b(biggest|largest|smallest|worst|best|leading)\s+\d/i.test(text))
            return { score: 6, reason: 'superlative + number' };
        return { score: 0, reason: null };
    },

    // Enumerated list / multiple items
    enumeration: (text) => {
        if (/\b(first|second|third|fourth|fifth)\b.*\b(first|second|third|fourth|fifth)\b/i.test(text))
            return { score: 8, reason: 'ordinal enumeration' };
        if (/\b(one|two|three|four|five)\s+(things?|reasons?|ways?|factors?|steps?|points?|tips?)/i.test(text))
            return { score: 7, reason: 'list introduction' };
        // Semicolons or comma-separated items that look like a list
        const semicolons = (text.match(/;/g) || []).length;
        if (semicolons >= 2) return { score: 6, reason: 'semicolon list' };
        return { score: 0, reason: null };
    },

    // Historical / timeline progression
    timeline: (text) => {
        const years = text.match(/\b(1[89]\d{2}|20[0-3]\d)\b/g);
        if (years && new Set(years).size >= 2) return { score: 8, reason: 'multiple distinct years' };
        if (/\b(from\s+\d{4}\s+to\s+\d{4}|over\s+the\s+(past|last|next)\s+\d+\s+(years?|decades?|centuries?))/i.test(text))
            return { score: 7, reason: 'time span language' };
        // A SINGLE date is NOT a timeline — a timeline is a chronological SEQUENCE of
        // multiple points. The old "single year reference → score 3" wrongly proposed
        // a timeline for any scene that merely stamps one date ("March 2026"), which
        // then won the candidate list and rendered as a bogus timeline. Score 0 so a
        // semantically correct type (headline/callout/bulletList) wins instead.
        return { score: 0, reason: null };
    },

    // A SPECIFIC single date/month/year moment (not a multi-point sequence — that's
    // timeline). A date belongs in an overlay lowerThird (or typewriter); a MAJOR
    // pivotal date can escalate to a centered headline/kineticText/typewriter. The
    // AI decides major-vs-routine and the exact type from the candidates below.
    // NEVER a statCounter and NEVER a fullscreen timeline for a single date.
    date: (text) => {
        const monthYear = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{4}\b/i.test(text);
        const fullDate = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?\b/i.test(text);
        const years = text.match(/\b(1[89]\d{2}|20[0-3]\d)\b/g);
        const singleYearOnly = years && new Set(years).size === 1;
        const datedYear = /\b(?:in|by|on|since|during|back in|as of|early|late|mid)\s+(?:19|20)\d{2}\b/i.test(text);
        if (monthYear || fullDate) return { score: 7, reason: 'specific date (month + year)' };
        if (datedYear && singleYearOnly) return { score: 5, reason: 'single dated year' };
        return { score: 0, reason: null };
    },

    // Person / organization introduction
    identity: (text) => {
        // Title + name pattern: "CEO John Smith", "Dr. Jane Doe", "President Biden"
        // NOTE: Title matched case-insensitive, but the NAME must start uppercase (no /i on whole regex)
        if (/\b(?:CEO|CTO|CFO|founder|Founder|president|President|director|Director|professor|Professor|Dr\.|chairman|Chairman|minister|Minister|secretary|Secretary|leader|Leader|coach|Coach|manager|Manager|senator|Senator|governor|Governor|mayor|Mayor|chief|Chief|general|General)\s+[A-Z][a-z]+/.test(text))
            return { score: 8, reason: 'title + name' };
        // Organization patterns — require a proper noun (capitalized, not sentence start)
        if (/\b(company|corporation|organization|agency|institute|university|foundation)\b/i.test(text) && /\s[A-Z][a-z]{2,}/.test(text))
            return { score: 5, reason: 'organization mention' };
        return { score: 0, reason: null };
    },

    // Key thesis / headline moment
    thesis: (text, sceneIndex, totalScenes) => {
        // Opening or closing scene
        if (sceneIndex === 0) return { score: 6, reason: 'opening scene' };
        if (sceneIndex === totalScenes - 1) return { score: 5, reason: 'closing scene' };
        // Strong assertion language
        if (/\b(the (truth|reality|fact|key|secret|answer|problem|solution|question) is|here'?s (why|how|what)|this (is|was|means|changed|proves)|what (this|that|it) means)\b/i.test(text))
            return { score: 7, reason: 'thesis language' };
        return { score: 0, reason: null };
    },

    // Comparison / versus
    comparison: (text) => {
        if (/\b(vs\.?|versus|compared\s+to|unlike|while\s+.+\s+on\s+the\s+other\s+hand|in\s+contrast|difference\s+between)\b/i.test(text))
            return { score: 8, reason: 'comparison language' };
        if (/\b(better|worse|more|less|faster|slower|bigger|smaller|higher|lower)\s+than\b/i.test(text))
            return { score: 5, reason: 'comparative adjective' };
        return { score: 0, reason: null };
    },

    // Quote / testimony / emphasis
    emphasis: (text) => {
        // Direct quotes
        if (/[""][^""]{10,}[""]/.test(text)) return { score: 7, reason: 'direct quote' };
        if (/\b(said|stated|declared|proclaimed|warned|announced|argued|claimed)\b/i.test(text))
            return { score: 5, reason: 'attribution verb' };
        return { score: 0, reason: null };
    },

    // Geographic / location data
    geographic: (text) => {
        // Multiple country/location names
        const locations = text.match(/\b(United States|USA|China|India|Russia|Japan|Germany|France|UK|Brazil|Canada|Australia|Mexico|Europe|Asia|Africa|America|Middle East|[A-Z][a-z]+(?:land|stan|ria|nia|lia|sia))\b/g);
        if (locations && new Set(locations).size >= 2) return { score: 8, reason: 'multiple locations' };
        if (locations && locations.length >= 1) return { score: 4, reason: 'single location' };
        return { score: 0, reason: null };
    },

    // Study / article / research reference
    research: (text) => {
        if (/\b(study|research|report|survey|paper|journal|published|according\s+to|findings?\s+show|data\s+(shows?|suggests?|reveals?))\b/i.test(text))
            return { score: 7, reason: 'research reference' };
        return { score: 0, reason: null };
    },

    // Tools, products, concepts — triggers explainer MG
    conceptual: (text) => {
        if (/\b(app|tool|platform|software|service|product|device|gadget|plugin|extension|API|SDK|library|browser|engine|program)\b/i.test(text))
            return { score: 6, reason: 'tool/product mention' };
        if (/\b(concept|process|system|mechanism|framework|approach|method|technique|strategy|principle|theory|model)\b/i.test(text))
            return { score: 5, reason: 'conceptual language' };
        return { score: 0, reason: null };
    },

    // Dramatic / powerful single-word emphasis
    dramatic: (text) => {
        // Short scenes with strong words
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length <= 8 && /\b(revolutionary|unprecedented|devastating|incredible|impossible|unstoppable|catastrophic|groundbreaking|extraordinary)\b/i.test(text))
            return { score: 7, reason: 'dramatic short statement' };
        return { score: 0, reason: null };
    },
};

// Maps content patterns to best-fit MG types (priority ordered)
const PATTERN_TO_MG_TYPES = {
    statistic:   ['statCounter', 'barChart', 'donutChart', 'progressBar'],
    percentage:  ['progressBar', 'donutChart', 'statCounter'],
    ranking:     ['rankingList', 'barChart', 'lowerThird'],
    enumeration: ['bulletList', 'rankingList', 'timeline'],
    timeline:    ['timeline', 'barChart'],
    // Dates: default to an overlay lowerThird (bottom) or typewriter; a MAJOR
    // pivotal date can escalate to a centered headline/kineticText/typewriter.
    date:        ['lowerThird', 'typewriter', 'kineticText', 'headline'],
    identity:    ['lowerThird', 'callout'],
    thesis:      ['headline', 'kineticText', 'focusWord', 'typewriter'],
    comparison:  ['comparisonCard', 'barChart'],
    emphasis:    ['callout', 'kineticText', 'focusWord', 'typewriter'],
    geographic:  ['mapChart', 'barChart', 'callout'],
    research:    ['callout', 'typewriter', 'bulletList'],
    conceptual:  ['explainer', 'bulletList', 'callout'],
    dramatic:    ['focusWord', 'kineticText', 'headline'],
};

// ============ mgHint PARSER ============
// Parses Visual Planner's mgHint field: "type: content" or "none"
function parseMgHint(mgHint) {
    if (!mgHint || mgHint === 'none' || mgHint === 'null') {
        return { type: null, content: null, isNone: !mgHint || mgHint === 'none' };
    }
    const match = mgHint.match(/^(\w+)\s*:\s*(.+)$/);
    if (!match) return { type: null, content: null, isNone: false };

    const rawType = match[1].trim().toLowerCase();
    const content = match[2].trim();

    // Normalize type names (same aliases as parseResponse typeMap)
    const TYPE_ALIASES = {
        statcounter: 'statCounter', lowerthird: 'lowerThird', focusword: 'focusWord',
        barchart: 'barChart', donutchart: 'donutChart', comparisoncard: 'comparisonCard',
        rankinglist: 'rankingList', kinetictext: 'kineticText', mapchart: 'mapChart',
        progressbar: 'progressBar', bulletlist: 'bulletList',
        headline: 'headline', callout: 'callout', timeline: 'timeline', explainer: 'explainer',
        typewriter: 'typewriter',
    };
    const type = TYPE_ALIASES[rawType] || null;
    return { type, content, isNone: false };
}

function editorAgentOwnsEditing(scriptContextOrCtx = {}) {
    return process.env.EDITOR_AGENT === 'true'
        || scriptContextOrCtx?.editorAgentOwnsEditing === true
        || scriptContextOrCtx?._editorAgentOwnsEditing === true
        || scriptContextOrCtx?.editorOwnsEditing === true;
}

// Per-video caps for certain MG types
const TYPE_CAPS = {
    focusWord: 2,
    headline: 3,
    explainer: 3,
    barChart: 1,
    donutChart: 1,
    comparisonCard: 1,
    timeline: 1,
    rankingList: 1,
    mapChart: 1,
    kineticText: 1,
    typewriter: 2,
};

/**
 * Generate ranked MG candidates for a scene based on content analysis.
 *
 * @param {Object} scene - Scene with text, startTime, endTime
 * @param {number} sceneIndex - Scene position in video
 * @param {number} totalScenes - Total scene count
 * @param {string[]} allowedMGs - Niche-allowed MG types
 * @param {string[]} alreadyPlaced - Types already placed in the video
 * @returns {{ candidates: Array<{type: string, score: number, reason: string}>, patternHits: Array<{pattern: string, score: number, reason: string}>, skipped: Array<{type: string, reason: string}>, shouldSkip: boolean }}
 */
function generateCandidates(scene, sceneIndex, totalScenes, allowedMGs, alreadyPlaced, mgHint, ctx) {
    const text = scene.text || '';
    const duration = (scene.endTime || 0) - (scene.startTime || 0);

    const editorOwnsEditing = editorAgentOwnsEditing(ctx);
    // In Editor Agent mode, VP hints are archived context only; they must not steer MG selection.
    const hint = editorOwnsEditing ? { type: null, content: null, isNone: false } : parseMgHint(mgHint);

    // Very short scenes or empty text → skip
    if (duration < 2.0 || text.trim().length < 15) {
        return { candidates: [], patternHits: [], skipped: [], shouldSkip: true, skipReason: `too short (${duration.toFixed(1)}s / ${text.length} chars)`, hint };
    }

    // Run all pattern detectors
    const patternHits = [];
    for (const [patternName, detector] of Object.entries(CONTENT_PATTERNS)) {
        const result = detector(text, sceneIndex, totalScenes);
        if (result.score > 0) {
            patternHits.push({ pattern: patternName, score: result.score, reason: result.reason });
        }
    }

    // If Visual Planner said "none" AND no strong patterns → skip
    // If hint is "none" but patterns found strong signals, patterns win (safety net)
    if (patternHits.length === 0) {
        if (hint.isNone) {
            return { candidates: [], patternHits: [], skipped: [], shouldSkip: true, skipReason: 'no content patterns + mgHint=none', hint };
        }
        // No patterns but hint suggests a type → let hint inject a candidate below
        if (!hint.type) {
            return { candidates: [], patternHits: [], skipped: [], shouldSkip: true, skipReason: 'no content patterns detected', hint };
        }
    }

    // Aggregate scores per MG type from all matching patterns
    const typeScores = {};
    const typeReasons = {};
    for (const hit of patternHits) {
        const mgTypes = PATTERN_TO_MG_TYPES[hit.pattern] || [];
        for (let rank = 0; rank < mgTypes.length; rank++) {
            const type = mgTypes[rank];
            // Primary match gets full score, secondary gets reduced
            const rankPenalty = rank * 1.5;
            const adjustedScore = Math.max(1, hit.score - rankPenalty);
            typeScores[type] = (typeScores[type] || 0) + adjustedScore;
            if (!typeReasons[type]) typeReasons[type] = [];
            typeReasons[type].push(hit.reason);
        }
    }

    // mgHint boost: if Visual Planner suggested a specific type, boost it significantly
    // This ensures the planner's scene-level context (which sees the full script) influences scoring
    if (hint.type && allowedMGs.includes(hint.type)) {
        // Guard: statCounter hint requires actual big number (100+) or % in the text
        // Reject hints for small numbers like "3-time winner", "5 awards"
        let hintValid = true;
        if (hint.type === 'statCounter') {
            // VP saw the full script — accept a qualifying stat in EITHER the scene text
            // or the hint content itself (e.g. "+$1,000,000 Cost Per Transit", "+1% Cargo Value").
            const sceneStat = CONTENT_PATTERNS.statistic(text);
            const hintStat = hint.content ? CONTENT_PATTERNS.statistic(hint.content) : null;
            const sceneQualifies = sceneStat && sceneStat.score >= 3;
            const hintQualifies  = hintStat  && hintStat.score  >= 3;
            if (hint.content && _isDateOnlyStatText(hint.content)) {
                hintValid = false;
                if (!typeReasons['_rejected']) typeReasons['_rejected'] = [];
                typeReasons['_rejected'].push(`mgHint:statCounter rejected (date/calendar label, not a stat)`);
            }
            if (hintValid && !sceneQualifies && !hintQualifies) {
                hintValid = false;
                if (!typeReasons['_rejected']) typeReasons['_rejected'] = [];
                typeReasons['_rejected'].push(`mgHint:statCounter rejected (no qualifying 100+ number in scene text or hint content)`);
            }
            // Also reject date ranges like "1953 → 1999" — years are not stats
            if (hintValid && hint.content) {
                const contentClean = hint.content.replace(/[,\s]/g, '');
                const yearRangeOnly = /^\d{4}\s*[→\-–—to]+\s*\d{4}$/.test(hint.content.trim());
                if (yearRangeOnly) {
                    hintValid = false;
                    if (!typeReasons['_rejected']) typeReasons['_rejected'] = [];
                    typeReasons['_rejected'].push(`mgHint:statCounter rejected (year range, not a stat)`);
                }
            }
            // Rejected ≠ no graphic: keep the number/score/date, demote the treatment.
            if (!hintValid) {
                const demoted = _statHintDemotionTarget(hint.content, text, allowedMGs);
                if (demoted) {
                    typeReasons['_rejected'].push(`mgHint:statCounter -> ${demoted} (number not statCounter-worthy)`);
                    hint.type = demoted;
                    hint.demotedFrom = 'statCounter';
                    hintValid = true;
                }
            }
        }
        if (hintValid) {
            const HINT_BOOST = 6; // Strong signal — planner saw full script context
            typeScores[hint.type] = (typeScores[hint.type] || 0) + HINT_BOOST;
            if (!typeReasons[hint.type]) typeReasons[hint.type] = [];
            typeReasons[hint.type].push(`mgHint:${hint.type}`);
        }
    }

    // mgHint "none" penalty: reduce all candidates if planner says no MG needed
    const hintNonePenalty = hint.isNone ? 0.6 : 1.0; // 40% reduction

    // Narrative arc bonus: boost certain types for climax/conclusion scenes
    const arc = ctx ? ctx.getArc(sceneIndex) : 'build';

    // Filter: only allowed by niche + not over cap
    const candidates = [];
    const skipped = [];

    // Global guard: statCounter requires the statistic pattern to have fired (score >= 3)
    const statisticHit = patternHits.find(h => h.pattern === 'statistic');
    const hasQualifyingStat = statisticHit && statisticHit.score >= 3;

    // VP hint that passed all its own validators gets cap/pattern-gate exemptions.
    // The planner saw the full script; a per-video "max 3 headlines" rule shouldn't
    // silently drop a scene the planner explicitly earmarked for one.
    const vpPrivileged = !editorOwnsEditing && hint.type && allowedMGs.includes(hint.type)
        && !(typeReasons['_rejected'] || []).some(r => r.startsWith(`mgHint:${hint.type}`));

    for (const [type, rawScore] of Object.entries(typeScores)) {
        const isVPHinted = vpPrivileged && type === hint.type;

        // Block fullscreen MG types — only Visual Planner can assign fullscreen MGs
        // MG engine only creates overlay MGs on footage scenes
        if (!editorOwnsEditing && FULLSCREEN_MG_TYPES.has(type)) {
            skipped.push({ type, reason: 'fullscreen type (only VP can assign)' });
            continue;
        }

        // statCounter MUST have a qualifying statistic pattern — no exceptions
        // This prevents dates, rankings, geographic mentions from triggering statCounter.
        // Exception: VP-hinted statCounter already passed its own validator (scene text OR hint content).
        if (type === 'statCounter' && !hasQualifyingStat && !isVPHinted) {
            skipped.push({ type, reason: 'no qualifying statistic (100+ number)' });
            continue;
        }

        // Not in niche allowed list
        if (!allowedMGs.includes(type)) {
            skipped.push({ type, reason: 'not in niche' });
            continue;
        }

        // Check per-video cap — VP-hinted types are exempt (planner's call, full-script context)
        const capAllowsVPHintBypass = isVPHinted && type !== 'focusWord';
        if (TYPE_CAPS[type] !== undefined && !capAllowsVPHintBypass) {
            const placed = alreadyPlaced.filter(t => t === type).length;
            if (placed >= TYPE_CAPS[type]) {
                skipped.push({ type, reason: `cap reached (${placed}/${TYPE_CAPS[type]})` });
                continue;
            }
        } else if (TYPE_CAPS[type] !== undefined && capAllowsVPHintBypass) {
            const placed = alreadyPlaced.filter(t => t === type).length;
            if (placed >= TYPE_CAPS[type]) {
                if (!typeReasons[type]) typeReasons[type] = [];
                typeReasons[type].push(`vp-hint cap-bypass (${placed}/${TYPE_CAPS[type]})`);
            }
        }

        let score = rawScore * hintNonePenalty;

        // Penalize if same as last placed type (avoid repetition)
        if (alreadyPlaced.length > 0 && alreadyPlaced[alreadyPlaced.length - 1] === type) {
            score *= 0.5; // halve score for consecutive same type
        }

        // Cross-scene proximity penalty: penalize types used in last 3 scenes
        if (ctx) {
            const gap = ctx.sceneGapSince(type, sceneIndex);
            if (gap <= 1) score *= 0.3;       // same or adjacent scene — heavy penalty
            else if (gap <= 2) score *= 0.6;   // 2 scenes ago
            else if (gap <= 3) score *= 0.8;   // 3 scenes ago
        }

        // Arc-based scoring adjustments
        if (arc === 'hook') {
            // Hook: prefer impactful overlay types
            if (type === 'headline' || type === 'focusWord') score *= 1.3;
        } else if (arc === 'climax') {
            // Climax: prefer dramatic types
            if (type === 'focusWord' || type === 'kineticText' || type === 'statCounter') score *= 1.3;
        } else if (arc === 'conclusion') {
            // Conclusion: prefer summary types
            if (type === 'callout' || type === 'headline') score *= 1.2;
        }

        candidates.push({
            type,
            score: Math.round(score * 10) / 10,
            reason: typeReasons[type].join(', ')
        });
    }

    // Sort by score descending, keep top 5
    candidates.sort((a, b) => b.score - a.score);
    const topCandidates = candidates.slice(0, 5);

    return {
        candidates: topCandidates,
        patternHits,
        skipped,
        shouldSkip: topCandidates.length === 0,
        skipReason: topCandidates.length === 0 ? 'all candidates filtered out' : null,
        hint
    };
}

// ============ WORD-ALIGNED TIMING ============
// Finds the exact timestamp when the MG's display text is spoken in the narration.
// Uses Whisper word-level timestamps for precise sync.

function findWordAlignedStart(mgText, scene) {
    if (!scene.words || scene.words.length === 0) return null;
    if (!mgText) return null;

    // Normalize: lowercase, strip punctuation, split into key words
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const mgWords = normalize(mgText).split(/\s+/).filter(w => w.length > 1);
    if (mgWords.length === 0) return null;

    // Normalize scene words for comparison
    const sceneWords = scene.words.map(w => ({
        ...w,
        normalized: normalize(w.word)
    }));

    // Strategy 1: Find the best consecutive match (sliding window)
    let bestScore = 0;
    let bestStart = null;

    for (let i = 0; i < sceneWords.length; i++) {
        let matched = 0;
        for (let j = 0; j < mgWords.length && (i + j) < sceneWords.length; j++) {
            const sw = sceneWords[i + j].normalized;
            const mw = mgWords[j];
            if (sw === mw || sw.includes(mw) || mw.includes(sw)) {
                matched++;
            }
        }
        if (matched > bestScore) {
            bestScore = matched;
            bestStart = sceneWords[i].start;
        }
    }

    // Strategy 2: If consecutive match is weak, find any key word match
    // Prioritize numbers/stats (most important for MG sync)
    if (bestScore < Math.ceil(mgWords.length * 0.4)) {
        const numberWords = mgWords.filter(w => /\d/.test(w));
        const keyWords = numberWords.length > 0 ? numberWords : mgWords;

        for (const sw of sceneWords) {
            for (const kw of keyWords) {
                if (sw.normalized === kw || sw.normalized.includes(kw) || kw.includes(sw.normalized)) {
                    return sw.start;
                }
            }
        }
    }

    return bestScore >= 1 ? bestStart : null;
}

// ============ DECONFLICT OVERLAY MGs ============
// Prevents overlay MGs from overlapping on the MG track.
// Full-screen MGs live on V3, so only overlay MGs need deconfliction.
function deconflictOverlayMGs(allMGs) {
    const overlayMGs = allMGs.filter(mg => mg.category === 'overlay');
    if (overlayMGs.length <= 1) return;

    // Sort by start time
    overlayMGs.sort((a, b) => a.startTime - b.startTime);
    const GAP = 0.15; // small gap between consecutive MGs

    for (let i = 0; i < overlayMGs.length - 1; i++) {
        const current = overlayMGs[i];
        const next = overlayMGs[i + 1];
        const currentEnd = current.startTime + current.duration;

        if (currentEnd > next.startTime - GAP) {
            // ONLY trim the earlier MG's duration — NEVER shift startTime
            // Shifting startTime desyncs MGs from the narration they belong to
            const newDuration = next.startTime - current.startTime - GAP;
            if (newDuration >= 1.0) {
                current.duration = newDuration;
                console.log(`  ⚠️ Trimmed overlay MG "${current.type}" to ${newDuration.toFixed(1)}s (avoid overlap with "${next.type}")`);
            } else {
                // Barely any room — just give current a minimal duration
                current.duration = Math.max(0.8, newDuration);
                console.log(`  ⚠️ Trimmed overlay MG "${current.type}" to ${current.duration.toFixed(1)}s (tight fit before "${next.type}")`);
            }
        }
    }
}

// ============ SMART DURATION ============
// Calculates duration based on content, not just type defaults.
// Accounts for reading time, animation time, and type-specific needs.

function computeSmartDuration(type, text, subtext) {
    const ANIM_OVERHEAD = 0.8; // ~0.5s enter + 0.3s exit
    const HOLD_PADDING = 3.5;  // extra hold time so MG feels present, not rushed
    const WORDS_PER_SEC = 3;   // average reading speed for on-screen text

    const wordCount = (text || '').split(/\s+/).filter(Boolean).length
                    + (subtext ? subtext.split(/\s+/).filter(Boolean).length : 0);
    const readingTime = wordCount / WORDS_PER_SEC;

    // Minimum time per type (generous — lets the viewer absorb)
    const MIN = {
        headline: 5.0,
        lowerThird: 5.0,
        statCounter: 5.5,
        callout: 5.5,
        bulletList: 6.0,
        focusWord: 4.0,
        progressBar: 5.5,
        barChart: 6.0,
        donutChart: 6.0,
        comparisonCard: 5.0,
        timeline: 6.5,
        rankingList: 6.0,
        kineticText: 5.0,
        mapChart: 6.0,
        explainer: 5.0,
        typewriter: 5.0,
    };

    let duration = readingTime + ANIM_OVERHEAD + HOLD_PADDING;

    // Type-specific adjustments
    if (type === 'bulletList') {
        const itemCount = (text || '').split(/[,;]|\d+\.\s/).filter(s => s.trim()).length;
        const staggerTime = itemCount * 0.4;
        duration = Math.max(duration, staggerTime + readingTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'statCounter' || type === 'progressBar') {
        duration = Math.max(duration, 1.5 + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'barChart' || type === 'donutChart' || type === 'rankingList' || type === 'mapChart') {
        const itemCount = (subtext || '').split(',').filter(s => s.includes(':')).length;
        const staggerTime = itemCount * 0.3;
        duration = Math.max(duration, staggerTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'timeline') {
        const eventCount = (subtext || '').split(',').filter(s => s.includes(':')).length;
        const staggerTime = eventCount * 0.4;
        duration = Math.max(duration, staggerTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'typewriter') {
        const charCount = (text || '').length;
        const revealTime = charCount * 0.06; // ~60ms per character
        duration = Math.max(duration, revealTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'kineticText') {
        const kWordCount = (text || '').split(/\s+/).filter(Boolean).length;
        const wordStagger = kWordCount * 0.15;
        duration = Math.max(duration, wordStagger + ANIM_OVERHEAD + HOLD_PADDING);
    }

    // Floor only — no hard ceiling. Caller clamps against the scene duration (for
    // fullscreen MGs) or trusts the AI's `durationSec` pick (for overlays).
    const min = MIN[type] || 5.0;
    return Math.max(min, duration);
}

function fixArticleSubtext(subtext, sceneText, displayText) {
    // Already has pipes → assume correct format, just ensure highlights exist
    if (subtext && subtext.includes('|')) {
        // Check if excerpt part has **highlights**
        const parts = subtext.split('|');
        const excerpt = parts.length >= 4 ? parts.slice(3).join('|') : '';
        if (excerpt && !excerpt.includes('**')) {
            // Has pipe format but no highlights — auto-highlight key phrases in excerpt
            parts[parts.length - 1] = autoHighlight(parts[parts.length - 1]);
            return parts.join('|');
        }
        return subtext;
    }

    // No pipes — build article subtext from scene narration
    const narration = (sceneText || '').trim();
    if (!narration) return subtext || '';

    // Use narration as excerpt, auto-highlight key phrases
    const excerpt = autoHighlight(narration);
    // Try to extract a source hint from the narration
    const sourceMatch = narration.match(/(?:according to|by|from|in)\s+(?:a\s+)?(?:the\s+)?([\w\s]+?)(?:\s+(?:study|report|article|research|survey|analysis|paper|journal|magazine))/i);
    const source = sourceMatch ? sourceMatch[1].trim() : 'Research';

    return `${source}||2024|${excerpt}`;
}

function autoHighlight(text) {
    if (!text || text.includes('**')) return text;
    let result = text;
    // Highlight numbers with context (e.g. "47%", "8 million", "1.4 billion")
    result = result.replace(/(\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?)/gi, (match) => {
        return `**${match.trim()}**`;
    });
    // If no numbers found, highlight capitalized proper nouns (2+ chars, not sentence starters)
    if (!result.includes('**')) {
        const words = result.split(/\s+/);
        let highlighted = 0;
        result = words.map((w, i) => {
            if (i > 0 && /^[A-Z][a-z]{2,}/.test(w) && highlighted < 3) {
                highlighted++;
                return `**${w}**`;
            }
            return w;
        }).join(' ');
    }
    // If still no highlights, pick the 2-3 most important words (longest non-common words)
    if (!result.includes('**')) {
        const common = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','that','this','from','by','has','have','had','will','can','could','would','should','been','being','their','they','them','which','when','where','what','how','who','than','then','also','just','about','into','over','after','before','between','through','during','each','very','most','more','some','only','other','its','these','those','such','both','here','there']);
        const words = result.split(/\s+/);
        const scored = words
            .map((w, i) => ({ w, i, len: w.replace(/[^a-zA-Z]/g, '').length }))
            .filter(x => x.len >= 4 && !common.has(x.w.toLowerCase()))
            .sort((a, b) => b.len - a.len)
            .slice(0, 2);
        if (scored.length > 0) {
            const indices = new Set(scored.map(s => s.i));
            result = words.map((w, i) => indices.has(i) ? `**${w}**` : w).join(' ');
        }
    }
    return result;
}

// ============ RULE-BASED MG BUILDER ============
// When a candidate type is dominant and AI is skipped, build MG from scene text.
// Extracts display text, subtext, and trigger word deterministically.

function buildRuleMG(scene, sceneIndex, type) {
    const text = scene.text || '';
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;

    let displayText = '';
    let subtext = 'none';
    let triggerWord = '';
    const position = POSITION_MAP[type] || 'center';

    switch (type) {
        case 'statCounter': {
            // Find the number and surrounding context
            const match = text.match(/(\b\w+\s+){0,3}(\d[\d,.]*\s*(%|percent|million|billion|trillion|thousand|x\b|times|fold)?)/i);
            if (match) {
                displayText = match[0].trim().split(/\s+/).slice(0, 6).join(' ');
                triggerWord = (match[2] || '').replace(/[^\w]/g, '') || words[Math.floor(words.length / 2)];
            } else {
                displayText = words.slice(0, 5).join(' ');
                triggerWord = words[0];
            }
            break;
        }
        case 'progressBar': {
            const match = text.match(/(\d+)\s*(%|percent)/i);
            if (match) {
                displayText = match[0].trim();
                subtext = match[1]; // The percentage value
                triggerWord = match[1];
            } else {
                displayText = words.slice(0, 5).join(' ');
                triggerWord = words[0];
            }
            break;
        }
        case 'lowerThird': {
            // Find title + name pattern (no /i — name must be uppercase)
            const match = text.match(/\b(?:CEO|CTO|CFO|founder|Founder|president|President|director|Director|professor|Professor|Dr\.|chairman|Chairman|minister|Minister|coach|Coach|manager|Manager)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
            if (match) {
                displayText = match[0].trim();
                triggerWord = match[1].split(/\s/)[0]; // First name
            } else {
                // Find any capitalized name (two consecutive capitalized words, not at sentence start)
                const nameMatch = text.match(/\s([A-Z][a-z]+\s+[A-Z][a-z]+)/);
                displayText = nameMatch ? nameMatch[1] : words.slice(0, 4).join(' ');
                triggerWord = nameMatch ? nameMatch[1].split(/\s/)[0] : words[0];
            }
            break;
        }
        case 'headline': {
            // Extract the most meaningful phrase from the scene
            displayText = extractKeyPhrase(text, 8);
            triggerWord = displayText.split(/\s+/)[0];
            break;
        }
        case 'focusWord': {
            displayText = normalizeFocusWordPayload(_pickEditorialFocusPhrase(text) || extractKeyPhrase(text, 3), scene);
            triggerWord = pickFocusTriggerWord(displayText, scene);
            break;
        }
        case 'callout': {
            displayText = extractKeyPhrase(text, 8);
            triggerWord = displayText.split(/\s+/)[Math.min(2, displayText.split(/\s+/).length - 1)];
            break;
        }
        case 'typewriter': {
            displayText = extractKeyPhrase(text, 10);
            triggerWord = displayText.split(/\s+/)[0];
            break;
        }
        case 'kineticText': {
            displayText = extractKeyPhrase(text, 6);
            triggerWord = displayText.split(/\s+/)[0];
            break;
        }
        case 'comparisonCard': {
            const vsMatch = text.match(/(.{3,30})\s+(?:vs\.?|versus|compared\s+to)\s+(.{3,30})/i);
            if (vsMatch) {
                displayText = vsMatch[0].trim().split(/\s+/).slice(0, 8).join(' ');
                subtext = `${vsMatch[1].trim().split(/\s+/).slice(0, 4).join(' ')}:left,${vsMatch[2].trim().split(/\s+/).slice(0, 4).join(' ')}:right`;
                triggerWord = 'vs';
            } else {
                displayText = words.slice(0, 6).join(' ');
                triggerWord = words[0];
            }
            break;
        }
        default: {
            // Generic fallback for any type
            displayText = words.slice(0, Math.min(8, words.length)).join(' ');
            triggerWord = words[Math.min(2, words.length - 1)];
            break;
        }
    }

    // Find trigger word timestamp — sync MG appearance to when the word is spoken
    let startTime = null;
    if (scene.words && scene.words.length > 0 && triggerWord) {
        const normalized = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
        const wordMatch = scene.words.find(w => w.word.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalized));
        if (wordMatch) {
            // Start animation so MG is readable right as word is spoken
            // Animation entrance takes ~0.4s, so start 0.4s before the word
            startTime = Math.max(scene.startTime, wordMatch.start - 0.4);
        }
    }
    if (startTime === null) {
        // No word match — place at ~25% into the scene (not at the very start)
        const sceneDur = (scene.endTime || 0) - (scene.startTime || 0);
        startTime = scene.startTime + Math.min(sceneDur * 0.25, 1.5);
    }

    const category = FULLSCREEN_MG_TYPES.has(type) ? 'fullscreen' : 'overlay';
    const sceneDur = scene.endTime - scene.startTime;
    // Fullscreen MGs mirror the scene exactly. Overlay MGs use the reading-time
    // heuristic but are clamped to the scene span + 1s bleed so they stay in sync.
    const cappedDuration = category === 'fullscreen'
        ? sceneDur
        : Math.min(computeSmartDuration(type, displayText, subtext), sceneDur + 1.0);

    return {
        id: `mg-${sceneIndex}`,
        type,
        category,
        text: sanitizeMGText(displayText),
        subtext: subtext === 'none' ? '' : sanitizeMGText(subtext),
        startTime,
        duration: cappedDuration,
        position,
        sceneIndex,
        style: 'clean', // overridden later
    };
}

// ============ VP DIRECT-BUILD (skip per-scene AI when VP gave concrete content) ============
// Parses scene.mgHint content directly into a finished overlay MG without calling AI.
// Returns null when hint is missing, fullscreen-only, not allowed by niche, or unparseable.
function buildMGFromHint(scene, sceneIndex, allowedMGs) {
    const hint = parseMgHint(scene.mgHint);
    if (!hint.type || hint.isNone || !hint.content) return null;
    if (!allowedMGs.includes(hint.type)) return null;
    if (FULLSCREEN_MG_TYPES.has(hint.type)) return null; // fullscreens handled by VP fullscreen loop

    let type = hint.type;
    const raw = sanitizeMGText(hint.content);
    if (!raw) return null;

    if (type === 'statCounter' && !_statHintQualifiesAsStat(raw, scene?.text)) {
        type = _statHintDemotionTarget(raw, scene?.text, allowedMGs);
        if (!type) return null;
    }

    let displayText = '';
    let subtext = '';
    let triggerWord = '';

    switch (type) {
        case 'statCounter': {
            displayText = raw.split(/\s+/).slice(0, 6).join(' ');
            const numMatch = raw.match(/\d[\d,.]*/);
            triggerWord = numMatch ? numMatch[0].replace(/,/g, '') : raw.split(/\s+/)[0];
            break;
        }
        case 'progressBar': {
            const pctMatch = raw.match(/(\d+)\s*(%|percent)/i);
            if (pctMatch) {
                displayText = raw;
                subtext = pctMatch[1];
                triggerWord = pctMatch[1];
            } else {
                displayText = raw;
                triggerWord = raw.split(/\s+/)[0];
            }
            break;
        }
        case 'lowerThird': {
            // VP format: "Name, Title" or "Name | Title" or "Name - Title" or plain "Name"
            const parts = raw.split(/\s*[|,]\s*/).map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) {
                displayText = parts[0];
                subtext = parts.slice(1).join(', ');
            } else {
                const dashParts = raw.split(/\s+[-–—]\s+/).map(p => p.trim()).filter(Boolean);
                if (dashParts.length >= 2) {
                    displayText = dashParts[0];
                    subtext = dashParts.slice(1).join(' — ');
                } else {
                    displayText = raw;
                    subtext = '';
                }
            }
            triggerWord = displayText.split(/\s+/)[0];
            break;
        }
        case 'explainer': {
            // VP format: "Query | Label" or plain query
            const parts = raw.split(/\s*\|\s*/).map(p => p.trim()).filter(Boolean);
            displayText = parts[0] || raw;
            subtext = parts.length > 1 ? parts.slice(1).join(' ') : displayText;
            triggerWord = displayText.split(/\s+/)[0];
            break;
        }
        case 'focusWord': {
            displayText = normalizeFocusWordPayload(raw, scene);
            triggerWord = pickFocusTriggerWord(displayText, scene);
            break;
        }
        case 'headline':
        case 'callout':
        case 'kineticText':
        case 'typewriter':
        default: {
            displayText = raw;
            triggerWord = raw.split(/\s+/)[0];
            break;
        }
    }

    if (!displayText) return null;

    // Find startTime via word alignment — same sync logic as buildRuleMG
    let startTime = null;
    if (scene.words && scene.words.length > 0 && triggerWord) {
        const normalized = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalized) {
            const wordMatch = scene.words.find(w => w.word.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalized));
            if (wordMatch) startTime = Math.max(scene.startTime, wordMatch.start - 0.4);
        }
    }
    if (startTime === null) {
        const aligned = findWordAlignedStart(displayText, scene);
        if (aligned !== null) startTime = Math.max(scene.startTime, aligned - 0.4);
    }
    if (startTime === null) {
        const sceneDur = (scene.endTime || 0) - (scene.startTime || 0);
        startTime = scene.startTime + Math.min(sceneDur * 0.25, 1.5);
    }

    const sceneDur = scene.endTime - scene.startTime;
    const heuristic = computeSmartDuration(type, displayText, subtext);
    const duration = Math.max(2.0, Math.min(heuristic, sceneDur + 1.0));

    return {
        id: `mg-${sceneIndex}`,
        type,
        category: 'overlay',
        text: sanitizeMGText(displayText),
        subtext: sanitizeMGText(subtext),
        startTime,
        duration,
        position: POSITION_MAP[type] || 'center',
        sceneIndex,
        style: 'clean', // overridden by caller
        hintSource: true,
    };
}

// ============ VP REVIEW PASS (batched, single AI call for all mgHint=none scenes) ============
// For scenes VP marked as needing no overlay MG, ask the AI to confirm "none" or
// propose a missed overlay. Writes back to scene.mgHint (sets _vpReviewed flag).
async function reviewNoneScenes(scenes, skipIndices, scriptContext, allowedMGs, listicleStartScenes) {
    const targets = [];
    for (let i = 0; i < scenes.length; i++) {
        if (skipIndices.has(i)) continue;
        if (listicleStartScenes && listicleStartScenes.has(i)) continue;
        const parsed = parseMgHint(scenes[i].mgHint);
        const missing = parsed.isNone || (!parsed.type && !parsed.content);
        if (!missing) continue;
        const dur = (scenes[i].endTime || 0) - (scenes[i].startTime || 0);
        if (dur < 2.5) continue;
        if ((scenes[i].text || '').trim().length < 30) continue;
        targets.push(i);
    }
    if (targets.length === 0) return { reviewed: 0, proposed: 0, confirmed: 0 };

    const overlayAllowed = allowedMGs.filter(t => !FULLSCREEN_MG_TYPES.has(t));
    if (overlayAllowed.length === 0) return { reviewed: 0, proposed: 0, confirmed: 0 };

    const niche = getNiche(scriptContext?.nicheId || 'general');
    const lang = scriptContext?.language || 'en';

    let prompt = `You are reviewing ${targets.length} scenes the Visual Planner initially marked as needing no overlay motion graphic. Decide per scene: either CONFIRM "none" (narrative/transitional text with no hookable fact) OR PROPOSE an overlay MG VP missed.

TOPIC: ${scriptContext?.summary || '(not set)'}
NICHE: ${niche.name}
ALLOWED OVERLAY TYPES: ${overlayAllowed.join(', ')}

Type contracts (content format after the colon):
- statCounter: BIG number/percentage/multiplier (100+, %, $, x/fold). content = the stat, e.g. "340%", "$2.5M"
- lowerThird: first mention of a named person/place/org. content = "Name, Title" or "Name"
- headline: thesis sentence worth pinning. content = short headline (≤8 words)
- callout: key insight/takeaway. content = short phrase
- focusWord: 1-3 word editorial punch. Never use generic single words like "Global", "Trade", "Route", "System", or "Economy"; use story meaning like "Backup Route", "Trade Lifeline", "Chokepoint Risk".
- progressBar: percentage completion. content = "X%"
- typewriter: short quote/fact for dramatic reveal. content = the quote
- kineticText: short powerful statement. content = ≤6 words
- explainer: a tool/product/tech/concept discussed. content = "ImageQuery | Label"

Rules:
- Reply with EXACTLY ${targets.length} lines, one per scene, in the listed order.
- Format per line: "<sceneIndex>: none" OR "<sceneIndex>: <type>: <content>"
- Only propose a type from ALLOWED OVERLAY TYPES. Never propose a fullscreen type.
- If the scene text does not contain a concrete fact/name/number/quote/concept, reply "none".
- Text/content must be anchored in the scene narration (no invented facts).

Scenes to review:
`;
    for (const idx of targets) {
        const s = scenes[idx];
        const text = (s.text || '').replace(/\s+/g, ' ').slice(0, 260);
        prompt += `Scene ${idx} (${((s.endTime - s.startTime) || 0).toFixed(1)}s): "${text}"\n`;
    }
    prompt += getLanguageBlock(lang);

    let raw;
    try {
        raw = await callAI(prompt, { taskType: 'motion-graphics' });
    } catch (e) {
        console.log(`  [VP Review] AI call failed: ${e.message} — skipping review pass`);
        return { reviewed: 0, proposed: 0, confirmed: 0 };
    }

    const targetSet = new Set(targets);
    const lines = (raw || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let proposed = 0, confirmed = 0;

    for (const line of lines) {
        const m = line.match(/^(?:scene\s*)?#?(\d+)\s*[:\-)]\s*(.+)$/i);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        if (!targetSet.has(idx)) continue;
        const payload = m[2].trim();

        if (/^none\b/i.test(payload)) {
            scenes[idx]._vpReviewed = 'confirmed-none';
            confirmed++;
            continue;
        }
        const proposal = parseMgHint(payload);
        if (proposal.type && proposal.content && overlayAllowed.includes(proposal.type)) {
            scenes[idx].mgHint = `${proposal.type}: ${proposal.content}`;
            scenes[idx]._vpReviewed = 'proposed';
            proposed++;
        }
    }

    const unparsed = targets.length - proposed - confirmed;
    console.log(`  [VP Review] ${targets.length} none-scenes reviewed → ${proposed} proposed, ${confirmed} confirmed none${unparsed > 0 ? `, ${unparsed} unparsed` : ''}`);
    return { reviewed: targets.length, proposed, confirmed };
}

function buildPrompt(scene, sceneIndex, totalScenes, scriptContext, sceneVisual, candidateTypes, mgHintObj, ctx) {
    const sceneDuration = (scene.endTime - scene.startTime).toFixed(1);

    let prompt = '';

    // Script context
    if (scriptContext && scriptContext.summary) {
        prompt += `VIDEO TOPIC: ${scriptContext.summary}\n`;
    }

    // Niche enforcement — candidates already filtered by niche
    const nicheId = scriptContext?.nicheId || 'general';
    const niche = getNiche(nicheId);
    prompt += `NICHE: "${niche.name}" — You MUST pick from the candidate types listed below. Do NOT use or invent any other types.\n`;

    // Niche-specific MG rules (e.g., news niches mandate lowerThird for locations, typewriter for times)
    if (niche.mgRules?.length) {
        prompt += `\nNICHE MG RULES (MANDATORY — override normal selection):\n`;
        for (const rule of niche.mgRules) {
            prompt += `⚠️ ${rule}\n`;
        }
    }

    // Narrative arc context
    if (ctx) {
        const arc = ctx.getArc(sceneIndex);
        prompt += `NARRATIVE POSITION: ${arc} (${arc === 'hook' ? 'grab attention' : arc === 'setup' ? 'establish context' : arc === 'climax' ? 'peak moment, be dramatic' : arc === 'conclusion' ? 'wrap up, summarize' : 'develop the story'})\n`;

        // Tell AI what was recently placed to avoid repetition
        const recent = ctx.recentTypes(sceneIndex, 4);
        if (recent.length > 0) {
            prompt += `RECENT MGs (avoid repeating): ${recent.join(', ')}\n`;
        }
    }

    // Visual context
    if (sceneVisual && sceneVisual.description !== 'No visual analysis available') {
        let visualNote = `FOOTAGE: ${sceneVisual.description}`;
        if (sceneVisual.hasText) visualNote += ' [has on-screen text]';
        prompt += visualNote + '\n';
    }

    prompt += `\nScene ${sceneIndex + 1}/${totalScenes}: pick the best motion graphic type for this narration.\n`;

    prompt += `\nNARRATION: "${scene.text}"`;
    prompt += `\nSCENE: ${scene.startTime.toFixed(2)}s - ${scene.endTime.toFixed(2)}s (${sceneDuration}s)`;

    // Include word-level timestamps so AI can pick precise trigger word
    if (scene.words && scene.words.length > 0) {
        const wordTimeline = scene.words.map(w => `${w.start.toFixed(2)}:${w.word}`).join(' ');
        prompt += `\nWORD TIMESTAMPS: ${wordTimeline}`;
    }

    // Build type descriptions dynamically based on CANDIDATE types (pre-narrowed)
    const TYPE_DESCRIPTIONS = {
        statCounter: 'statCounter: A BIG number (100+) or percentage is the main point. E.g. "grew by 340%", "5 million users", "$2,500". NOT for small numbers like "3-time winner", "5 awards", "top 10" — those are descriptions, not statistics.',
        progressBar: 'progressBar: A percentage or completion stat. E.g. "78% of people", "nearly half"',
        lowerThird: 'lowerThird: First mention of a person, place, or organization. CRITICAL: The name/entity MUST appear explicitly in the NARRATION text — do NOT use names from context or hints if the narration hasn\'t spoken them yet. The viewer should hear the name BEFORE or AS the lowerThird appears. E.g. "CEO John Smith announced" → text: "John Smith"',
        headline: 'headline: Key thesis or main topic (max 2-3 per video). E.g. opening statement, conclusion',
        bulletList: 'bulletList: 2+ items enumerated. E.g. "first... second... third..."',
        callout: 'callout: Important fact, quote, or insight. E.g. "the key takeaway is..."',
        focusWord: 'focusWord: 1-3 word editorial punch (max 1-2 per video). Never output generic solo words like "Global", "Trade", "Route", "System", or "Economy"; use story meaning like "Backup Route", "Trade Lifeline", "Chokepoint Risk".',
        rankingList: 'rankingList: Items ranked by value (max 1 per video). E.g. "top 5 countries"',
        comparisonCard: 'comparisonCard: Comparing two things (max 1 per video). E.g. "iPhone vs Android"',
        barChart: 'barChart: 3-5 categories with numbers (max 1 per video). E.g. "sales by region"',
        donutChart: 'donutChart: Percentage breakdown (max 1 per video). E.g. "market share"',
        timeline: 'timeline: A chronological SEQUENCE across MULTIPLE distinct dates/eras (max 1 per video). E.g. "from 2010 to 2024", "1991 → 2003 → 2026". A single date stamp like "March 2026" or a list of simultaneous events is NOT a timeline — use headline (for a punchy dated statement) or bulletList (for parallel items) instead.',
        mapChart: `mapChart: Geographic data with locations/regions (max 1 per video).
  VARIANTS (pick best fit via mapVariant field):
  - "locator": Single location spotlight with country highlight + pin (best for "where is X?")
  - "route": Flight arcs between 2+ locations (best for travel, trade routes, military movements)
  - "regionHighlight": Country/region polygon fill (best for "this country...", borders, territories)
  - "comparison": Multiple locations with values side by side (best for rankings, statistics)
  If no mapVariant specified, renderer auto-detects from pin count.
  text: Main topic as title (max 8 words). E.g. "Top oil producers worldwide"
  subtext: MUST list locations with data as "Location: value" pairs, comma-separated.
  IMPORTANT: Use the MOST SPECIFIC location name possible — cities > countries.
  - If narration mentions "Berlin" → use "Berlin" not "Germany"
  - If narration mentions "Silicon Valley" → use "Silicon Valley" not "United States"
  - If narration mentions "Tokyo" → use "Tokyo" not "Japan"
  - Only use country names when no specific city/region is mentioned.
  Example: "Riyadh: 12M bpd, Houston: 11.3M bpd, Moscow: 10.8M bpd, Calgary: 5.3M bpd"
  Use real or approximate data from the narration. If no numbers mentioned, use ranking: "Calgary: #4, Riyadh: #1"`,
        kineticText: 'kineticText: Powerful short statement, word-by-word reveal (max 1 per video). E.g. "The Future Is Now"',
        typewriter: 'typewriter: Character-by-character text reveal with blinking cursor (max 2 per video). Best for quotes, key facts, or dramatic statements. E.g. "He never performed again"',
        explainer: `explainer: Visual explainer for tools, products, or concepts (max 3 per video).
  WHEN: narration discusses a specific tool, product, app, technology, or abstract concept.
  text: search query to find an image of the thing discussed (e.g. "ChatGPT logo", "Tesla Model 3", "blockchain diagram")
  subtext: short label to display below the image (e.g. "ChatGPT", "Tesla Model 3")`,
    };

    const typeDescriptions = candidateTypes
        .map(t => TYPE_DESCRIPTIONS[t])
        .filter(Boolean)
        .map(d => `- ${d}`)
        .join('\n');

    // Include Visual Planner's mgHint as a strong suggestion
    if (mgHintObj && mgHintObj.type && candidateTypes.includes(mgHintObj.type)) {
        prompt += `\nVISUAL PLANNER SUGGESTION: "${mgHintObj.type}: ${mgHintObj.content}" — The planner analyzed the full script and suggests this type. Strongly prefer it unless another type clearly fits better.`;
    }

    prompt += `\n
=== CANDIDATE TYPES (pre-selected based on scene content analysis) ===
Pick the BEST match from these candidates:
${typeDescriptions}
- none: If none of the candidates truly fit this narration

POSITION GUIDE:
- bottom-left: lowerThird, callout
- bottom-right: statCounter, progressBar
- center: headline, focusWord, kineticText, typewriter, comparisonCard, donutChart
- center-left: bulletList, rankingList
- center: barChart, timeline, mapChart — full width
- If footage has on-screen text at center → prefer bottom-left or bottom-right

DATES (a specific date / month / year):
- DEFAULT: a quiet overlay lowerThird (bottom) — or a typewriter — that simply stamps the date. A routine date stays a lowerThird; do not make a big deal of it.
- MAJOR date: if the date is a pivotal moment the story turns on, escalate to a CENTERED kineticText, headline, or typewriter for impact (position: center). You decide whether the date is major from the narration's weight on it.
- NEVER render a date as a statCounter, and NEVER as a fullscreen timeline (a timeline needs MULTIPLE distinct dates).

TIMING — triggerWord:
- Pick the EXACT word from the narration that triggers the MG appearance
- Pick the most meaningful word: the number, the name, the key term
- Example: "revenue grew by 340 percent" + statCounter → triggerWord: 340
- Example: "CEO John Smith announced" + lowerThird → triggerWord: John
- IMPORTANT for lowerThird: text/name MUST be words that appear in the NARRATION. If the narration says "we need to understand how the man who led..." but hasn't named the person yet, do NOT put the person's name as lowerThird text — use "none" instead or pick a different type.`;

    if (placedTypes.length > 0) {
        prompt += `\n\nALREADY PLACED: ${placedTypes.join(', ')}`;
        if (lastType) {
            prompt += ` | LAST: ${lastType} (avoid repeating)`;
        }
    }

    if (aiInstructionsRef) {
        prompt += `\n\nUSER INSTRUCTIONS (follow these preferences):\n${aiInstructionsRef}`;
    }

    const allowedTypesList = [...candidateTypes, 'none'].join('|');
    prompt += `\n\nReply ONLY with these lines (nothing else):
type: <${allowedTypesList}>
text: <display text, max 8 words, extracted from narration>
subtext: <secondary line OR "label1:value1,label2:value2" for charts, or "none">
position: <center|bottom-left|bottom-right|center-left|top-right>
layoutHint: <lower-third|center-stack|cinematic-title|evidence-board|data-focus|split-panel|map-explainer|focus-panel>
safeZone: <auto|center|center-left|center-right|bottom-left|bottom-right|top-left|top-right>
motionIntent: <short creative motion direction for HyperFrames, or "none">
triggerWord: <the exact word from narration that triggers appearance, or "none">
durationSec: <how long the MG should stay on screen, in seconds. Scene is ${sceneDuration}s — an OVERLAY MG can last anywhere from ~3s to the full scene depending on how long the narration supports it. A FULLSCREEN MG (mapChart, explainer, etc.) will cover the whole scene regardless, so any value is fine for those. Pick based on reading time + narration pacing, NOT a fixed cap.>`;
    if (candidateTypes.includes('mapChart')) {
        prompt += `\nmapVariant: <locator|route|regionHighlight|comparison> (ONLY if type is mapChart)`;
    }

    // Language instruction — written last so it overrides default English behavior.
    // Affects: `text` and `subtext` fields (user-facing). `type`/`position`/`triggerWord`
    // stay as machine-readable English keywords because the AI treats them as enums.
    // `triggerWord` must be taken verbatim from narration, so it naturally matches the script language.
    prompt += getLanguageBlock(scriptContext?.language);

    return prompt;
}

// Levenshtein distance — tolerant of Whisper phonetic errors (Bab↔Bob, Mandeb↔Mandeb)
function _levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

// True if `needle` appears in `haystack` either as a substring or as a fuzzy word match
// (Levenshtein ≤ 2 for words ≥4 chars, ≤1 for shorter). Handles Whisper mis-transcriptions.
function _fuzzyWordInText(needle, haystack) {
    const n = needle.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!n) return true;
    const hayLower = haystack.toLowerCase();
    if (hayLower.includes(needle.toLowerCase())) return true;
    if (hayLower.replace(/[^a-z0-9\s]/g, ' ').includes(n)) return true;
    const tolerance = n.length >= 4 ? 2 : 1;
    const words = hayLower.split(/[^a-z0-9]+/).filter(Boolean);
    for (const w of words) {
        if (Math.abs(w.length - n.length) > tolerance) continue;
        if (_levenshtein(w, n) <= tolerance) return true;
    }
    return false;
}

function parseResponse(text, scene, sceneIndex, scriptContext) {
    const lines = text.trim().split('\n');
    let type = 'none';
    let displayText = '';
    let subtext = '';
    let aiPosition = '';
    let layoutHint = '';
    let safeZone = '';
    let motionIntent = '';
    let triggerWord = '';
    let mapVariant = '';
    let aiDurationSec = null;

    const typeMap = {
        'headline': 'headline',
        'lowerthird': 'lowerThird',
        'lower_third': 'lowerThird',
        'lower third': 'lowerThird',
        'statcounter': 'statCounter',
        'stat_counter': 'statCounter',
        'stat counter': 'statCounter',
        'callout': 'callout',
        'bulletlist': 'bulletList',
        'bullet_list': 'bulletList',
        'bullet list': 'bulletList',
        'focusword': 'focusWord',
        'focus_word': 'focusWord',
        'focus word': 'focusWord',
        'progressbar': 'progressBar',
        'progress_bar': 'progressBar',
        'progress bar': 'progressBar',
        'barchart': 'barChart',
        'bar_chart': 'barChart',
        'bar chart': 'barChart',
        'donutchart': 'donutChart',
        'donut_chart': 'donutChart',
        'donut chart': 'donutChart',
        'piechart': 'donutChart',
        'pie_chart': 'donutChart',
        'pie chart': 'donutChart',
        'comparisoncard': 'comparisonCard',
        'comparison_card': 'comparisonCard',
        'comparison card': 'comparisonCard',
        'comparison': 'comparisonCard',
        'vs': 'comparisonCard',
        'timeline': 'timeline',
        'rankinglist': 'rankingList',
        'ranking_list': 'rankingList',
        'ranking list': 'rankingList',
        'ranking': 'rankingList',
        'toplist': 'rankingList',
        'top list': 'rankingList',
        'kinetictext': 'kineticText',
        'kinetic_text': 'kineticText',
        'kinetic text': 'kineticText',
        'kinetic': 'kineticText',
        'mapchart': 'mapChart',
        'map_chart': 'mapChart',
        'map chart': 'mapChart',
        'map': 'mapChart',
        'explainer': 'explainer',
        'typewriter': 'typewriter',
        'type_writer': 'typewriter',
        'type writer': 'typewriter',
        'animatedicons': 'explainer',
        'animated_icons': 'explainer',
        'animated icons': 'explainer',
        'icons': 'explainer',
        'none': 'none'
    };

    for (const line of lines) {
        const lower = line.toLowerCase().trim()
            .replace(/^\*+/, '').replace(/\*+$/, '')  // strip markdown bold
            .replace(/^-\s*/, '').replace(/^\d+\.\s*/, '')  // strip list prefixes
            .trim();

        // Flexible type matching
        const typeMatch = lower.match(/type\s*[:=\-]\s*(.+)/);
        if (typeMatch) {
            const val = typeMatch[1].trim().replace(/['"*]/g, '');
            if (typeMap[val]) type = typeMap[val];
        }

        // Flexible text matching
        const textMatch = lower.match(/^text\s*[:=\-]\s*/);
        if (textMatch) {
            displayText = line.substring(line.search(/[:=\-]\s*/) + 1).trim().replace(/^["'*]+|["'*]+$/g, '');
            displayText = sanitizeMGText(displayText);
        }

        // Flexible subtext matching
        const subMatch = lower.match(/^sub\s*text\s*[:=\-]\s*/);
        if (subMatch) {
            subtext = line.substring(line.search(/[:=\-]\s*/) + 1).trim().replace(/^["'*]+|["'*]+$/g, '');
            if (subtext.toLowerCase() === 'none' || subtext === '-') subtext = '';
            else subtext = sanitizeMGText(subtext);
        }

        // Position (AI-chosen)
        const posMatch = lower.match(/^position\s*[:=\-]\s*(.+)/);
        if (posMatch) {
            aiPosition = posMatch[1].trim().replace(/['"*]/g, '');
        }

        const layoutMatch = lower.match(/^layout\s*-?\s*hint\s*[:=\-]\s*(.+)/) || lower.match(/^layout\s*[:=\-]\s*(.+)/);
        if (layoutMatch) {
            layoutHint = layoutMatch[1].trim().replace(/['"*]/g, '');
        }

        const safeZoneMatch = lower.match(/^safe\s*-?\s*zone\s*[:=\-]\s*(.+)/) || lower.match(/^safezone\s*[:=\-]\s*(.+)/);
        if (safeZoneMatch) {
            safeZone = safeZoneMatch[1].trim().replace(/['"*]/g, '');
        }

        const motionMatch = lower.match(/^motion\s*-?\s*intent\s*[:=\-]\s*(.+)/) || lower.match(/^motion\s*[:=\-]\s*(.+)/);
        if (motionMatch) {
            motionIntent = line.substring(line.search(/[:=\-]\s*/) + 1).trim().replace(/^["'*]+|["'*]+$/g, '');
            if (motionIntent.toLowerCase() === 'none' || motionIntent === '-') motionIntent = '';
        }

        // Trigger word (AI-chosen for timing sync)
        const triggerMatch = lower.match(/^trigger\s*-?\s*word\s*[:=\-]\s*(.+)/);
        if (triggerMatch) {
            triggerWord = triggerMatch[1].trim().replace(/['"*]/g, '');
            if (triggerWord.toLowerCase() === 'none' || triggerWord === '-') triggerWord = '';
        }

        // Map variant (optional, only for mapChart)
        const variantMatch = lower.match(/^map\s*-?\s*variant\s*[:=\-]\s*(.+)/);
        if (variantMatch) {
            const v = variantMatch[1].trim().replace(/['"*]/g, '').toLowerCase();
            const variantMap = { locator: 'locator', route: 'route', regionhighlight: 'regionHighlight', region_highlight: 'regionHighlight', comparison: 'comparison' };
            mapVariant = variantMap[v] || '';
        }

        // AI-picked duration (seconds). Matches "durationSec:", "duration:", "duration sec:".
        const durMatch = lower.match(/^duration\s*-?\s*sec\s*[:=\-]\s*(.+)/) || lower.match(/^duration\s*[:=\-]\s*(.+)/);
        if (durMatch) {
            const raw = durMatch[1].trim().replace(/['"*]/g, '').replace(/s(ec(ond)?s?)?\s*$/i, '').trim();
            const n = parseFloat(raw);
            if (Number.isFinite(n) && n > 0) aiDurationSec = n;
        }
    }

    // Fallback: scan full text for type keywords if parser missed them
    if (type === 'none') {
        const fullLower = text.toLowerCase();
        for (const [key, val] of Object.entries(typeMap)) {
            if (key === 'none') continue;
            const pattern = new RegExp(`(?:suggest|recommend|choose|pick|select|type).*?${key.replace(/\s/g, '\\s*')}`, 'i');
            if (pattern.test(fullLower)) {
                type = val;
                break;
            }
        }
    }

    if (type === 'none') return null;


    // Validate lowerThird: displayed name must be grounded — either in AI-extracted entities
    // (from the script) OR fuzzy-matched in scene text (tolerant of Whisper mis-transcription,
    // e.g. "Bab el-Mandeb" vs Whisper's "Bob -El -Mandeb").
    if (type === 'lowerThird' && displayText) {
        const nameWords = displayText.split(/\s+/).filter(w => w.length > 2 && /^[A-Z]/.test(w));
        let nameInText = nameWords.length === 0;

        if (!nameInText) {
            // 1. Check against AI-extracted entities (source of truth from the script)
            const entities = scriptContext?.entities || [];
            if (entities.length > 0) {
                const displayLower = displayText.toLowerCase().replace(/\[[^\]]*\]/g, '').trim();
                for (const ent of entities) {
                    const entClean = String(ent).toLowerCase().replace(/\[[^\]]*\]/g, '').trim();
                    if (!entClean) continue;
                    if (entClean.includes(displayLower) || displayLower.includes(entClean)) {
                        nameInText = true;
                        break;
                    }
                }
            }

            // 2. Fuzzy match against scene text (handles Whisper phonetic errors)
            if (!nameInText) {
                nameInText = nameWords.some(w => _fuzzyWordInText(w, scene.text));
            }
        }

        if (!nameInText) {
            console.log(`[MG] lowerThird rejected: "${displayText}" not found in scene text "${scene.text.substring(0, 60)}..." (entities checked, fuzzy checked)`);
            return null;
        }
    }

    if (type === 'focusWord') {
        displayText = normalizeFocusWordPayload(displayText || scene.text, scene);
        triggerWord = pickFocusTriggerWord(displayText, scene);
        subtext = '';
    }

    const finalText = displayText || scene.text.substring(0, 40);
    const sceneDuration = scene.endTime - scene.startTime;
    const isOverlay = !FULLSCREEN_MG_TYPES.has(type);

    // Duration rules (no hard caps):
    //   • Fullscreen MG (mapChart, explainer, etc.) → mirrors scene duration exactly.
    //     V3 covers the scene entirely, so the MG must live the whole span.
    //   • Overlay MG → AI's `durationSec` wins. Falls back to reading-time heuristic
    //     (`computeSmartDuration`) if the AI forgot the field. Clamped only to the
    //     scene span + 1s bleed so overlays stay in narration sync.
    let mgDuration;
    if (!isOverlay) {
        mgDuration = sceneDuration;
    } else {
        const heuristic = computeSmartDuration(type, finalText, subtext);
        const picked = (aiDurationSec && aiDurationSec > 0) ? aiDurationSec : heuristic;
        const maxOverlayDuration = sceneDuration + 1.0;
        mgDuration = Math.min(picked, maxOverlayDuration);
        if (mgDuration < 2.0) mgDuration = Math.min(2.0, maxOverlayDuration);
    }

    // === TIMING: Use AI's triggerWord first, fall back to text-based word matching ===
    let wordStart = null;

    // Strategy 1: AI specified a trigger word — find its exact timestamp
    if (triggerWord && scene.words && scene.words.length > 0) {
        const normalTrigger = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const w of scene.words) {
            const normalWord = w.word.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normalWord === normalTrigger || normalWord.includes(normalTrigger) || normalTrigger.includes(normalWord)) {
                wordStart = w.start;
                break;
            }
        }
    }

    // Strategy 2: Fall back to heuristic text-based word matching
    if (wordStart === null) {
        wordStart = findWordAlignedStart(finalText, scene);
    }

    let startTime;
    let finalDuration = mgDuration;
    if (wordStart !== null) {
        // Start animation early so MG is readable right when word is spoken
        // Animation entrance takes ~0.4s
        startTime = Math.max(scene.startTime, wordStart - 0.4);
    } else {
        // No word match — place at ~25% into the scene (not at the very start)
        const sceneDur = scene.endTime - scene.startTime;
        startTime = scene.startTime + Math.min(sceneDur * 0.25, 1.5);
    }

    // === POSITION: Use AI's choice, fall back to type defaults ===
    const validPositions = ['center', 'bottom-left', 'bottom-right', 'center-left', 'top-right', 'top-left'];
    const finalPosition = validPositions.includes(aiPosition) ? aiPosition : (POSITION_MAP[type] || 'center');

    const result = {
        id: `mg-${sceneIndex}`,
        type: type,
        category: FULLSCREEN_MG_TYPES.has(type) ? 'fullscreen' : 'overlay',
        text: sanitizeMGText(finalText),
        subtext: sanitizeMGText(subtext),
        startTime: startTime,
        duration: finalDuration,
        position: finalPosition,
        sceneIndex: sceneIndex,
        style: 'clean' // will be overridden by chosen style
    };
    const validLayouts = ['lower-third', 'center-stack', 'cinematic-title', 'evidence-board', 'data-focus', 'split-panel', 'map-explainer', 'focus-panel'];
    const normalizedLayout = String(layoutHint || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    const validSafeZones = ['auto', 'center', 'center-left', 'center-right', 'bottom-left', 'bottom-right', 'top-left', 'top-right'];
    const normalizedSafeZone = String(safeZone || finalPosition || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    result.agenticComposition = {
        layout: validLayouts.includes(normalizedLayout) ? normalizedLayout : undefined,
        safeZone: validSafeZones.includes(normalizedSafeZone) ? normalizedSafeZone : finalPosition,
        motion: motionIntent ? { reason: sanitizeMGText(motionIntent) } : undefined,
        compositionIntent: motionIntent ? sanitizeMGText(motionIntent) : undefined,
        source: 'ai-editor',
    };
    if (type === 'mapChart' && mapVariant) result.mapVariant = mapVariant;
    return result;
}

// ============ BATCH FALLBACK ============
// NOTE: AI providers moved to shared ai-provider.js module
// If per-scene analysis fails, try a single batch prompt

async function batchFallback(scenes, scriptContext, allowedMGs) {
    const sceneList = scenes.map((s, i) =>
        `${i}: "${s.text.substring(0, 80)}"`
    ).join('\n');

    const topic = scriptContext?.summary || 'unknown';
    const nicheId = scriptContext?.nicheId || 'general';
    const niche = getNiche(nicheId);
    const typesList = (allowedMGs || Object.keys(POSITION_MAP)).join(', ');

    let prompt = `Video about: ${topic}
Niche: "${niche.name}" — ONLY use these MG types: ${typesList}
`;
    if (niche.mgRules?.length) {
        prompt += `\nNICHE MG RULES (MANDATORY):\n`;
        for (const rule of niche.mgRules) prompt += `⚠️ ${rule}\n`;
    }
    prompt += `
Here are the scenes:
${sceneList}

Pick 2-3 scenes that would benefit most from a text overlay. For each, reply with ONE line:
<scene>|<type>|<display text max 8 words>|<position>|<triggerWord>

Allowed types: ${typesList}
For chart/ranking/timeline, add data after triggerWord: <scene>|<type>|<title>|<position>|<triggerWord>|<label1:val1,label2:val2>

Position guide: center (headlines, charts, focus), bottom-left (lowerThird, callout), bottom-right (stats, progress), center-left (lists)
triggerWord: the exact word from narration that should trigger the MG to appear on screen

Only pick the most impactful scenes. Reply with ONLY the lines, nothing else.`;
    if (aiInstructionsRef) {
        prompt += `\n\nUSER INSTRUCTIONS:\n${aiInstructionsRef}`;
    }

    // Language instruction for `display text` field (user-facing). Other pipe-separated
    // fields (type, position, triggerWord) are machine-readable enums — AI keeps them English.
    prompt += getLanguageBlock(scriptContext?.language);

    const rawText = await callAI(prompt, { taskType: 'motion-graphics' });
    console.log(`    [Batch raw]: ${rawText.substring(0, 150).replace(/\n/g, ' | ')}`);

    const results = [];
    const lines = rawText.trim().split('\n');

    for (const line of lines) {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length >= 3) {
            const idx = parseInt(parts[0]);
            const typeRaw = parts[1].toLowerCase().replace(/\s+/g, '');

            const typeMap = {
                'headline': 'headline', 'lowerthird': 'lowerThird',
                'statcounter': 'statCounter', 'callout': 'callout',
                'bulletlist': 'bulletList', 'focusword': 'focusWord',
                'progressbar': 'progressBar', 'barchart': 'barChart',
                'donutchart': 'donutChart', 'piechart': 'donutChart',
                'comparisoncard': 'comparisonCard', 'comparison': 'comparisonCard',
                'timeline': 'timeline', 'rankinglist': 'rankingList',
                'ranking': 'rankingList', 'kinetictext': 'kineticText',
                'kinetic': 'kineticText', 'mapchart': 'mapChart',
                'map': 'mapChart',
                'explainer': 'explainer', 'typewriter': 'typewriter',
                'animatedicons': 'explainer',
                'icons': 'explainer'
            };

            const text = parts[2].replace(/^["']+|["']+$/g, '');
            // Parse position (part 3) and triggerWord (part 4)
            const aiPosition = parts.length >= 4 ? parts[3].trim().replace(/['"]/g, '') : '';
            const triggerWord = parts.length >= 5 ? parts[4].trim().replace(/['"]/g, '') : '';
            // Data for chart types (part 5+)
            const data = parts.length >= 6 ? parts.slice(5).join('|').replace(/^["']+|["']+$/g, '') : '';

            if (!isNaN(idx) && idx >= 0 && idx < scenes.length && typeMap[typeRaw]) {
                const scene = scenes[idx];
                const type = typeMap[typeRaw];
                const finalText = text || scene.text.substring(0, 40);
                const sceneDur = scene.endTime - scene.startTime;
                const isFullscreen = FULLSCREEN_MG_TYPES.has(type);
                // Fullscreen = full scene span. Overlay = heuristic, clamped to scene+1s.
                const mgDuration = isFullscreen
                    ? sceneDur
                    : Math.min(computeSmartDuration(type, finalText, data), sceneDur + 1.0);

                // Timing: AI triggerWord first, then heuristic fallback
                let wordStart = null;
                if (triggerWord && triggerWord.toLowerCase() !== 'none' && scene.words && scene.words.length > 0) {
                    const normalTrigger = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
                    for (const w of scene.words) {
                        const normalWord = w.word.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (normalWord === normalTrigger || normalWord.includes(normalTrigger) || normalTrigger.includes(normalWord)) {
                            wordStart = w.start;
                            break;
                        }
                    }
                }
                if (wordStart === null) {
                    wordStart = findWordAlignedStart(finalText, scene);
                }

                let startTime;
                let finalDuration = mgDuration;
                if (wordStart !== null) {
                    startTime = Math.max(scene.startTime, wordStart - 0.05);
                } else {
                    startTime = scene.startTime + 0.2;
                }

                // Position: AI choice first, then type default
                const validPositions = ['center', 'bottom-left', 'bottom-right', 'center-left', 'top-right', 'top-left'];
                const finalPosition = validPositions.includes(aiPosition) ? aiPosition : (POSITION_MAP[type] || 'center');

                const finalData = data || '';

                results.push({
                    id: `mg-${idx}`,
                    type: type,
                    category: FULLSCREEN_MG_TYPES.has(type) ? 'fullscreen' : 'overlay',
                    text: finalText,
                    subtext: finalData,
                    startTime: startTime,
                    duration: finalDuration,
                    position: finalPosition,
                    sceneIndex: idx,
                    style: 'clean'
                });
                console.log(`    [batch] Scene ${idx} -> ${type}: "${text}" pos:${finalPosition}${wordStart !== null ? ` (synced @${wordStart.toFixed(2)}s)` : ' (centered)'}`);
            }
        }
    }

    return results;
}

// ============ MAIN PROCESSOR ============

async function processMotionGraphics(scenes, scriptContext, visualAnalysis, aiInstructions) {
    console.log('\n  AI is analyzing scenes for motion graphics...');
    console.log(`  Using: ${config.aiProvider.toUpperCase()}\n`);

    placedTypes = [];
    lastType = '';
    aiInstructionsRef = aiInstructions || '';

    if (aiInstructionsRef.includes('=== REFERENCE STYLE PROFILE')) {
        console.log(`  🎨 [MG] Style profile present in instructions: "${scriptContext?.styleProfile?.name || 'unnamed'}"`);
    }

    // Pick style for the entire video
    const mgStyle = pickStyle(scriptContext);
    const mapStyle = pickMapStyle(scriptContext, mgStyle);
    // Pick map style pack (orthogonal overlay look: polygons/route/pins/labels/basemap filter)
    const mapPackUiChoice = process.env.BUILD_MAP_STYLE_PACK || 'auto';
    const mapStylePack = pickMapPack({
        uiChoice: mapPackUiChoice,
        nicheId: scriptContext?.nicheId,
        themeId: scriptContext?.themeId,
    });
    const mapStylePackId = mapStylePack?.id || DEFAULT_MAP_PACK_ID;
    console.log(`  Map Pack: ${mapStylePackId} (ui=${mapPackUiChoice})`);

    // Resolve allowed MG types from niche (content strategy)
    const nicheId = scriptContext?.nicheId || 'general';
    const niche = getNiche(nicheId);
    const allowedMGs = niche.allowedMGs || Object.keys(POSITION_MAP);
    const enforceNicheMgGate = process.env.VP_ENFORCE_NICHE_MG === '1';
    console.log(`  MG Style: ${mgStyle} | Niche: ${niche.name}`);
    console.log(`  Allowed MGs: ${allowedMGs.join(', ')}${enforceNicheMgGate ? '' : ' (VP fullscreen choices bypass niche MG gate)'}\n`);

    // Initialize context tracker for cross-scene awareness
    const ctx = new MGContextTracker(scenes, scriptContext);
    const editorOwnsEditing = editorAgentOwnsEditing(scriptContext);
    ctx.editorOwnsEditing = editorOwnsEditing;
    if (editorOwnsEditing) {
        const rolePolicy = scriptContext?.editorAgentPreserveVPMediaRoles !== false
            ? 'VP fullscreen hints preserved as download-skip/render policy'
            : 'VP mg/fullscreen hints are ignored';
        console.log(`  [Editor Agent] owns MG decisions - ${rolePolicy}`);
    }

    const results = [];

    // Pre-create fullscreen MGs from Visual Planner directives (these scenes have no footage)
    const fullscreenMGSceneIndices = new Set();
    if (!editorOwnsEditing || scriptContext?.editorAgentPreserveVPMediaRoles !== false) {
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        if (!scene.fullscreenMG) continue;

        // Parse "type: content data"
        const colonIdx = scene.fullscreenMG.indexOf(':');
        const mgType = colonIdx > 0 ? scene.fullscreenMG.substring(0, colonIdx).trim() : scene.fullscreenMG.trim();
        const mgContent = colonIdx > 0 ? scene.fullscreenMG.substring(colonIdx + 1).trim() : scene.text;

        if (!FULLSCREEN_MG_TYPES.has(mgType)) {
            console.log(`  Scene ${i}: [fullscreenMG] Unknown type "${mgType}" — skipping`);
            continue;
        }

        // Skip listicleGrid here — it's auto-generated later with proper _listicleItems data
        if (mgType === 'listicleGrid') {
            console.log(`  Scene ${i}: [fullscreenMG] listicleGrid handled by auto-generation (skipping VP duplicate)`);
            continue;
        }

        // Enforce niche filter: skip fullscreen MGs not allowed in this niche
        if (enforceNicheMgGate && !allowedMGs.includes(mgType)) {
            console.log(`  Scene ${i}: [fullscreenMG] "${mgType}" not allowed in niche "${niche.name}" — skipping`);
            continue;
        }

        // For data-required MGs, parse "<Title> | Label1:Val1 | Label2:Val2"
        // into mg.text (title) and mg.subtext (pairs). If no real pairs found,
        // defensively reject (orchestrator should have caught this, but belt-and-suspenders).
        const DATA_MGS = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'bulletList']);
        let mgText = mgContent;
        let mgSubtext = scene.text;
        if (DATA_MGS.has(mgType)) {
            const isBullet = mgType === 'bulletList';
            const readPairs = (raw) => {
                const segs = String(raw || '').split(/\s*\|\s*|\s*;\s*/).map(v => v.trim()).filter(Boolean);
                const firstIsPair = segs.length > 0 && /^[^:]+:\s*[\d.,%$+\-]+/.test(segs[0]);
                const pairSegs = (segs.length > 1 && !firstIsPair) ? segs.slice(1) : segs;
                const pairs = pairSegs.filter(v => /^[^:]+:\s*[\d.,%$+\-]+/.test(v));
                return { segs, firstIsPair, pairSegs, enough: isBullet ? pairSegs.length >= 2 : pairs.length >= 2 };
            };

            let parsed = readPairs(mgContent);
            if (!parsed.enough) {
                // The digits are usually one field away — sitting in this scene's
                // own narration, which the planner simply didn't copy across.
                // Look there before throwing the graphic away. Recovery returns
                // null unless the pairs are unambiguous, so the rejection below
                // still fires unchanged for everything it cannot prove.
                const recovered = recoverDataPairs(scene, mgType, mgContent);
                if (recovered) {
                    console.log(`  Scene ${i}: [fullscreenMG] "${mgType}" data recovered from ${recovered.source} — "${recovered.content}"`);
                    parsed = readPairs(recovered.content);
                }
            }
            if (!parsed.enough) {
                console.log(`  Scene ${i}: [fullscreenMG] "${mgType}" rejected — no real data pairs in "${mgContent.slice(0, 60)}". Skipping (scene will have no MG here).`);
                continue;
            }
            mgText = (!parsed.firstIsPair && parsed.segs.length > 1) ? parsed.segs[0] : '';
            mgSubtext = parsed.pairSegs.join(', ');
        } else if (mgType === 'comparisonCard') {
            if (!/\s+vs\.?\s+|\s+versus\s+/i.test(mgContent)) {
                console.log(`  Scene ${i}: [fullscreenMG] "comparisonCard" rejected — missing "A vs B" pattern in "${mgContent.slice(0, 60)}". Skipping.`);
                continue;
            }
        } else if (mgType === 'mapChart') {
            // Route VP's location:value pairs into subtext so map-provider's
            // entity parser finds them directly. Without this the parser sees
            // narration in subtext, finds no "Place: value" pairs, and falls back
            // to dumping the full script-wide entity list into the geocoder.
            mgText = '';
            mgSubtext = mgContent;
        }

        const duration = scene.endTime - scene.startTime;
        const mg = {
            id: `mg-${i}`,
            type: mgType,
            category: 'fullscreen',
            text: mgText,
            subtext: mgSubtext,
            startTime: scene.startTime,
            duration: duration,
            position: POSITION_MAP[mgType] || 'center',
            sceneIndex: i,
            selectionMode: 'visual-planner',
            isPlannedFullscreen: true,
        };

        if (mgType === 'mapChart') {
            mg.mapStyle = mapStyle;
            mg.mapStylePack = mapStylePackId;
            // Honor VP's mapVariant selection (locator/route/regionHighlight/comparison).
            // Validate against registry — reject anything not in mapChart.types.
            const mapReg = MG_REGISTRY.mapChart;
            const vpVariant = scene.mapVariant;
            if (vpVariant && mapReg?.types?.[vpVariant]) {
                mg.mapVariant = vpVariant;
                mg.subType = vpVariant;
            } else if (mg.mapVariant && mapReg?.types?.[mg.mapVariant]) {
                mg.subType = mg.mapVariant;
            }
        }

        results.push(mg);
        fullscreenMGSceneIndices.add(i);
        placedTypes.push(mgType);
        ctx.record(mg);
        console.log(`  Scene ${i}: [PLANNED FULLSCREEN] ${mgType}: "${mgContent.substring(0, 60)}"`);
    }
    if (fullscreenMGSceneIndices.size > 0) {
        console.log(`  → ${fullscreenMGSceneIndices.size} fullscreen MGs from Visual Planner\n`);
    }

    // Build set of listicle item start scenes — counter MGs handle these, skip in main loop
    } else {
        console.log('  [Editor Agent] VP fullscreen pre-create disabled');
    }

    const listicleStartScenes = new Set();
    if (scriptContext.format === 'listicle' && scriptContext.listicleItems) {
        for (const item of scriptContext.listicleItems) {
            listicleStartScenes.add(item.startSceneIndex);
        }
    }

    // VP REVIEW PASS: legacy mode only. In Editor Agent mode this is an old
    // creative decision path and must stay disabled.
    if (!editorOwnsEditing) {
        try {
            await reviewNoneScenes(scenes, fullscreenMGSceneIndices, scriptContext, allowedMGs, listicleStartScenes);
        } catch (e) {
            console.log(`  [VP Review] pass failed: ${e.message} — continuing with original hints`);
        }
    } else {
        console.log('  [Editor Agent] VP none-review disabled');
    }

    let directBuiltCount = 0;
    let reviewSkippedCount = 0;

    for (let i = 0; i < scenes.length; i++) {
        // Skip scenes that already have a planned fullscreen MG
        if (fullscreenMGSceneIndices.has(i)) continue;

        // Skip listicle item start scenes — counter MGs are added separately
        if (listicleStartScenes.has(i)) {
            console.log(`  Scene ${i}: [LISTICLE ITEM] — skipped (counter MG handles this)`);
            continue;
        }

        const scene = scenes[i];
        const sceneVisual = visualAnalysis ? visualAnalysis.find(v => v.sceneIndex === i) : null;
        const arcTag = ctx.getArc(i);

        // VP review confirmed no MG needed — skip entirely
        if (!editorOwnsEditing && scene._vpReviewed === 'confirmed-none') {
            console.log(`  Scene ${i} [${arcTag}]: [VP-review] confirmed none — skipped`);
            lastType = '';
            reviewSkippedCount++;
            continue;
        }

        // VP DIRECT-BUILD: legacy mode only. Editor Agent mode ignores VP overlay hints.
        const preHint = editorOwnsEditing ? { type: null, content: null } : parseMgHint(scene.mgHint);
        if (!editorOwnsEditing && preHint.type && preHint.content
            && allowedMGs.includes(preHint.type)
            && !FULLSCREEN_MG_TYPES.has(preHint.type)) {
            const capBlockedDirect = preHint.type === 'focusWord' && _typeCapReached('focusWord', placedTypes);
            const placementBlockedReason = capBlockedDirect ? null : validateOverlayHintPlacement(scene, scenes);
            const vpMG = (capBlockedDirect || placementBlockedReason) ? null : buildMGFromHint(scene, i, allowedMGs);
            if (capBlockedDirect) {
                console.log(`  Scene ${i} [${arcTag}]: [VP-direct] focusWord skipped (cap reached ${TYPE_CAPS.focusWord}/${TYPE_CAPS.focusWord})`);
            } else if (placementBlockedReason) {
                console.log(`  Scene ${i} [${arcTag}]: [VP-direct] Rejected "${scene.mgHint}" (${placementBlockedReason})`);
                scene.mgHint = null;
            } else if (vpMG) {
                if (ctx.isDuplicateText(vpMG.text)) {
                    console.log(`  Scene ${i} [${arcTag}]: [VP-direct] Rejected (duplicate text): "${vpMG.text.slice(0, 40)}"`);
                } else {
                    vpMG.selectionMode = scene._vpReviewed === 'proposed' ? 'vp-review' : 'vp-direct';
                    if (vpMG.type === 'explainer') {
                        vpMG.explainerQuery = vpMG.text || '';
                        vpMG.explainerLabel = vpMG.subtext || vpMG.text || '';
                        vpMG.explainerImageFile = null;
                        vpMG.duration = Math.max(vpMG.duration, scene.endTime - vpMG.startTime - 0.2);
                    }
                    if (sceneVisual && sceneVisual.suggestedMGPosition === 'avoid-center' && vpMG.position === 'center') {
                        vpMG.position = 'bottom-left';
                    }
                    const wordAlignedVP = findWordAlignedStart(vpMG.text, scene) !== null;
                    const subTagVP = vpMG.subType ? `:${vpMG.subType}` : '';
                    const modeTagVP = scene._vpReviewed === 'proposed' ? 'VP-REVIEW' : 'VP-DIRECT';
                    console.log(`  Scene ${i} [${arcTag}]: [${modeTagVP}] ${vpMG.type}${subTagVP}: "${vpMG.text}" @${vpMG.startTime.toFixed(2)}s pos:${vpMG.position} ${wordAlignedVP ? '(word-synced)' : '(centered)'}`);
                    placedTypes.push(vpMG.type);
                    lastType = vpMG.type;
                    ctx.record(vpMG);
                    results.push(vpMG);
                    directBuiltCount++;
                }
                continue; // skip hybrid/AI path — VP content was good enough
            }
        }

        console.log(`  Scene ${i} [${arcTag}]: "${scene.text.substring(0, 50)}..."`);

        // ---- HYBRID STEP 1: Rule-based candidate generation (with mgHint from Visual Planner + context tracker) ----
        const candidateResult = generateCandidates(scene, i, scenes.length, allowedMGs, placedTypes, scene.mgHint, ctx);

        // Debug: log mgHint + candidate analysis
        if (candidateResult.hint && (candidateResult.hint.type || candidateResult.hint.isNone)) {
            const hintTag = candidateResult.hint.isNone ? 'none' : `${candidateResult.hint.type}: ${candidateResult.hint.content}`;
            console.log(`    [mgHint]: ${hintTag}`);
        }
        if (candidateResult.patternHits.length > 0) {
            const hitsSummary = candidateResult.patternHits.map(h => `${h.pattern}(${h.score})`).join(', ');
            console.log(`    [Patterns]: ${hitsSummary}`);
        }
        if (candidateResult.skipped.length > 0) {
            const skippedSummary = candidateResult.skipped.map(s => `${s.type}:${s.reason}`).join(', ');
            console.log(`    [Filtered]: ${skippedSummary}`);
        }

        if (candidateResult.shouldSkip) {
            console.log(`    -> Skip: ${candidateResult.skipReason}`);
            lastType = '';
            continue;
        }

        const candidateTypes = candidateResult.candidates.map(c => c.type);
        const candidateSummary = candidateResult.candidates.map(c => `${c.type}(${c.score})`).join(', ');
        console.log(`    [Candidates]: ${candidateSummary}`);

        // ---- HYBRID STEP 2: Deterministic pick if top candidate is dominant ----
        let mg = null;
        let selectionMode = 'ai';
        const topCandidate = candidateResult.candidates[0];
        const secondCandidate = candidateResult.candidates[1];
        const isDominant = topCandidate.score >= 7 && (!secondCandidate || topCandidate.score >= secondCandidate.score * 1.8);

        if (isDominant && candidateTypes.length === 1) {
            // Single strong candidate — skip AI, use deterministic pick
            selectionMode = 'rule';
            console.log(`    [Rule-pick]: ${topCandidate.type} (dominant score ${topCandidate.score}, reason: ${topCandidate.reason})`);
        }

        try {
            if (selectionMode === 'ai') {
                // ---- HYBRID STEP 3: AI picks from narrowed candidates ----
                const prompt = buildPrompt(scene, i, scenes.length, scriptContext, sceneVisual, candidateTypes, candidateResult.hint, ctx);
                const rawText = await callAI(prompt, { taskType: 'motion-graphics' });
                console.log(`    [AI raw]: ${rawText.substring(0, 80).replace(/\n/g, ' | ')}`);
                mg = parseResponse(rawText, scene, i, scriptContext);

                // Enforce candidate list: reject if AI picked outside candidates
                if (mg && !candidateTypes.includes(mg.type)) {
                    console.log(`    -> Rejected "${mg.type}" (not in candidates: ${candidateTypes.join(',')}), falling back to top candidate`);
                    // Fall back to rule-based top candidate
                    mg = null;
                    selectionMode = 'rule-fallback';
                }
            }

            if (selectionMode === 'rule' || selectionMode === 'rule-fallback') {
                // Build MG from top candidate deterministically.
                // Legacy mode may reuse VP mgHint content; Editor Agent mode does not.
                mg = buildRuleMG(scene, i, topCandidate.type);
                if (!editorOwnsEditing && mg && candidateResult.hint?.content && candidateResult.hint.type === topCandidate.type) {
                    // Visual Planner provided display text for this exact type — use it
                    mg.text = mg.type === 'focusWord'
                        ? normalizeFocusWordPayload(candidateResult.hint.content, scene)
                        : candidateResult.hint.content;
                    mg.hintSource = true;
                }
            }

            if (mg) {
                // Block fullscreen MG types on footage scenes in the legacy overlay pass.
                // Editor Agent fullscreen/template decisions are handled by the dedicated editor path.
                if (!editorOwnsEditing && FULLSCREEN_MG_TYPES.has(mg.type)) {
                    console.log(`    -> Rejected "${mg.type}" (fullscreen type on footage scene — handled by fullscreen/template pipeline)`);
                    mg = null;
                }
            }

            if (mg) {
                // Duplicate text rejection — skip if text is too similar to a recent MG
                if (ctx.isDuplicateText(mg.text)) {
                    console.log(`    -> Rejected (duplicate text): "${mg.text.substring(0, 40)}"`);
                    mg = null;
                }
            }

            if (mg) {
                mg.selectionMode = selectionMode; // track for debugging
                if (mg.type === 'mapChart') { mg.mapStyle = mapStyle; mg.mapStylePack = mapStylePackId; }
                if (mg.type === 'mapChart' && mg.mapVariant) mg.subType = mg.mapVariant;

                // Post-process explainer: set search query and label
                if (mg.type === 'explainer') {
                    mg.explainerQuery = mg.text || '';
                    mg.explainerLabel = mg.subtext || mg.text || '';
                    mg.explainerImageFile = null; // populated by explainer-image-provider.js
                    mg.sceneIndex = i;
                    mg.duration = Math.max(mg.duration, scene.endTime - mg.startTime - 0.2);
                }

                // Adjust position if visual analysis suggests avoiding center
                if (sceneVisual && sceneVisual.suggestedMGPosition === 'avoid-center' && mg.position === 'center') {
                    mg.position = 'bottom-left';
                }
                const wordAligned = findWordAlignedStart(mg.text, scene) !== null;
                const modeTag = selectionMode === 'ai' ? 'AI' : selectionMode === 'rule' ? 'RULE' : 'RULE-FB';
                const subTag = mg.subType ? `:${mg.subType}` : '';
                console.log(`    -> [${modeTag}] ${mg.type}${subTag}: "${mg.text}" @${mg.startTime.toFixed(2)}s pos:${mg.position} ${wordAligned ? '(word-synced)' : '(centered)'}`);
                placedTypes.push(mg.type);
                lastType = mg.type;
                ctx.record(mg);
                results.push(mg);
            } else {
                console.log(`    -> No motion graphic`);
                lastType = '';
            }
        } catch (error) {
            console.log(`    MG analysis failed: ${error.message}`);
            lastType = '';
        }
    }

    // Cap all MGs so they don't extend past total video duration
    const totalDuration = scenes.length > 0 ? scenes[scenes.length - 1].endTime : 0;
    for (const mg of results) {
        if (mg.startTime + mg.duration > totalDuration) {
            mg.duration = Math.max(1, totalDuration - mg.startTime);
        }
    }

    deconflictOverlayMGs(results);

    // Auto-insert Subscribe CTA if detected
    if (!editorOwnsEditing && scriptContext && scriptContext.ctaDetected && scriptContext.ctaStartTime !== null) {
        console.log(`\n  📢 CTA detected at ${scriptContext.ctaStartTime.toFixed(1)}s → auto-inserting Subscribe overlay`);

        const ctaMG = {
            type: 'subscribeCTA',
            text: 'Subscribe',
            startTime: scriptContext.ctaStartTime,
            duration: 4.0, // 4 seconds
            position: 'bottom-right',
            sceneIndex: scenes.findIndex(s => s.startTime >= scriptContext.ctaStartTime) || scenes.length - 1,
            style: mgStyle,
            // CTA-specific styling
            ctaStyle: {
                icon: 'bell', // bell icon for subscribe
                animate: 'pulse', // pulse animation
                variant: 'highlight' // highlighted/prominent style
            }
        };

        // Cap to video duration
        if (ctaMG.startTime + ctaMG.duration > totalDuration) {
            ctaMG.duration = Math.max(1, totalDuration - ctaMG.startTime);
        }

        results.push(ctaMG);
        console.log(`    ✅ Subscribe CTA added: ${ctaMG.startTime.toFixed(1)}s → ${(ctaMG.startTime + ctaMG.duration).toFixed(1)}s`);
    }

    // Fallback: if no MGs were generated, try a batch approach
    if (!editorOwnsEditing && results.length === 0 && scenes.length > 0) {
        console.log('\n  No MGs from per-scene analysis. Trying batch fallback...');
        try {
            const batchResults = await batchFallback(scenes, scriptContext, allowedMGs);
            // Filter to allowed types and apply styles
            const filteredBatch = batchResults.filter(mg => allowedMGs.includes(mg.type));
            filteredBatch.forEach(mg => {
                if (mg.type === 'mapChart') { mg.mapStyle = mapStyle; mg.mapStylePack = mapStylePackId; }
                if (mg.type === 'mapChart' && mg.mapVariant) mg.subType = mg.mapVariant;
                if (mg.startTime + mg.duration > totalDuration) {
                    mg.duration = Math.max(1, totalDuration - mg.startTime);
                }
            });
            results.push(...filteredBatch);
            deconflictOverlayMGs(results);
        } catch (e) {
            console.log(`    Batch fallback failed: ${e.message}`);
        }
    }

    // Listicle item counter MGs (overlay on LI track)
    // NOTE: listicleGrid (overview grid) is now handled by ai-templates.js (Step 6.5)
    if (scriptContext.format === 'listicle' && scriptContext.listicleItems) {
        const { generateItemCounterMG } = require('../formats/listicle-format');
        let counterCount = 0;
        const totalItems = scriptContext.listicleItems.length;

        for (const item of scriptContext.listicleItems) {
            const counterMG = generateItemCounterMG(item, scenes, mgStyle);
            if (counterMG) {
                // Attach progress data directly to counter (no separate tracker MG)
                counterMG._progress = { current: item.itemNumber, total: totalItems };
                results.push(counterMG);
                counterCount++;
                const syncSource = item.spokenTime ? 'word-sync' : 'scene-start';
                console.log(`    #${item.itemNumber}: MG@${counterMG.startTime.toFixed(1)}s (scene@${item.startTime.toFixed(1)}s${item.spokenTime ? `, spoken@${item.spokenTime.toFixed(1)}s` : ', no word-sync'}) [${syncSource}]`);
            }
        }
        if (counterCount > 0) {
            console.log(`  [Listicle] Added ${counterCount} listicle item MGs (counter + progress combined)`);
        }

        // Dedup: remove AI-placed overlay MGs that overlap with auto-generated listicle MGs
        // AI often places "Number three" lowerThirds on scenes near item starts
        const listicleTimes = results
            .filter(mg => mg.isListicleCounter || mg.isListicleOverview)
            .map(mg => ({ start: mg.startTime, end: mg.startTime + (mg.duration || 4) }));

        if (listicleTimes.length > 0) {
            const overlapMargin = 3; // seconds
            let removed = 0;
            for (let i = results.length - 1; i >= 0; i--) {
                const mg = results[i];
                if (mg.isListicleCounter || mg.isListicleOverview || mg.selectionMode === 'listicle-counter') continue;
                if (mg.category === 'fullscreen') continue;
                const mgStart = mg.startTime;
                const mgEnd = mgStart + (mg.duration || 3);
                const overlaps = listicleTimes.some(lt =>
                    mgStart < lt.end + overlapMargin && mgEnd > lt.start - overlapMargin
                );
                if (overlaps) {
                    console.log(`    [Listicle] Removed overlapping ${mg.type} "${(mg.text || '').substring(0, 30)}" @${mgStart.toFixed(1)}s (too close to listicle counter)`);
                    results.splice(i, 1);
                    removed++;
                }
            }
            if (removed > 0) {
                console.log(`  [Listicle] Dedup: removed ${removed} AI-placed MGs overlapping with listicle counters`);
            }
        }
    }

    // Log selection summary
    const modeCounts = { ai: 0, rule: 0, 'rule-fallback': 0, 'listicle-counter': 0, 'visual-planner': 0, 'vp-direct': 0, 'vp-review': 0 };
    const typeCounts = {};
    for (const mg of results) {
        const mode = mg.selectionMode || 'ai';
        if (!(mode in modeCounts)) modeCounts[mode] = 0;
        modeCounts[mode]++;
        typeCounts[mg.type] = (typeCounts[mg.type] || 0) + 1;
    }
    console.log(`\n  Motion graphics placed: ${results.length}/${scenes.length} scenes (style: ${mgStyle})`);
    if (results.length > 0) {
        const parts = [
            `AI=${modeCounts.ai}`,
            `Rule=${modeCounts.rule}`,
            `Fallback=${modeCounts['rule-fallback']}`,
        ];
        if (modeCounts['visual-planner']) parts.push(`Planned=${modeCounts['visual-planner']}`);
        if (modeCounts['vp-direct']) parts.push(`VP-Direct=${modeCounts['vp-direct']}`);
        if (modeCounts['vp-review']) parts.push(`VP-Review=${modeCounts['vp-review']}`);
        console.log(`  📊 Selection: ${parts.join(' | ')}`);
        if (directBuiltCount || reviewSkippedCount) {
            console.log(`  📊 VP pipeline: ${directBuiltCount} direct-built, ${reviewSkippedCount} review-confirmed-none`);
        }
        const typeBreakdown = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}(${c})`).join(', ');
        console.log(`  📊 Types: ${typeBreakdown}`);
    }
    console.log('');
    return { motionGraphics: results, mgStyle, mapStyle, mapStylePack: mapStylePackId };
}

module.exports = {
    processMotionGraphics,
    STYLE_NAMES,
    MAP_STYLE_NAMES,
    pickStyle,
    pickMapStyle,
    FULLSCREEN_MG_TYPES,
    generateCandidates,
    buildRuleMG,
    buildMGFromHint,
};
