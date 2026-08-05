const STOPWORDS = new Set([
    'about', 'above', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are', 'around',
    'because', 'been', 'before', 'being', 'between', 'both', 'but', 'can', 'could', 'did', 'does',
    'done', 'each', 'for', 'from', 'has', 'have', 'having', 'here', 'into', 'its', 'just', 'like',
    'look', 'looks', 'made', 'make', 'many', 'more', 'most', 'next', 'not', 'now', 'off', 'only',
    'other', 'over', 'same', 'scene', 'show', 'showing', 'shows', 'that', 'the', 'their', 'them',
    'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'used', 'very', 'video',
    'visual', 'want', 'with', 'within', 'without', 'would', 'your',
]);

// Map/chart/diagram imagery with baked-in labels is the classic web-image
// defect: vision correctly zeroes it, then the anchor bump used to rescue it
// because the LABELS contain the scene keywords ("Persian Gulf shipping
// density map" matches anchors persian/gulf/shipping → 0/10 bumped to 6/10
// and a labeled heatmap shipped as scene footage). Keyword overlap on
// cartography is evidence AGAINST usability, not for it — never bump these.
const HARD_NEGATIVE_RE = /\b(unrelated|wrong subject|wrong video|does not show|doesn't show|not visible|not identifiable|instead of|rather than|presenter|host|talking head|webcam|picture[-\s]?in[-\s]?picture|studio desk|news anchor|editorial text overlay|watermark|large logo|ai[-\s]?generated|cartoon|clipart|illustration|slideshow|slide show|ken[-\s]?burns|\w* ?map\b|cartograph\w*|chart|diagram|infographic|heatmap|heat map|legend|labels?\b|labeled|labelled|annotat\w+|text overlay|overlaid text|on[-\s]?screen text|screenshot)\b/i;

const MANDATORY_GENERIC_TOKENS = new Set([
    'background', 'broll', 'clean', 'close', 'context', 'frame', 'footage', 'full',
    'fullscreen', 'generic', 'image', 'inside', 'literal', 'main', 'modern', 'object',
    'photo', 'real', 'scene', 'shot', 'show', 'showing', 'shows', 'simple', 'still',
    'subject', 'target', 'template', 'video', 'view', 'visible', 'wide',
]);

const NEGATION_WORDS = new Set([
    'without', 'lack', 'lacks', 'lacking', 'missing', 'absent', 'never',
]);

const NEGATION_SUPPORT_WORDS = new Set([
    'show', 'shows', 'shown', 'showing', 'display', 'displays', 'displayed',
    'visible', 'seen', 'present', 'include', 'includes', 'included',
    'contain', 'contains', 'contained', 'have', 'has', 'had',
]);

function _short(value, max = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _tokenForm(value) {
    let token = String(value || '').toLowerCase().trim();
    token = token.replace(/^[-_]+|[-_]+$/g, '');
    if (!token || token.length < 3 || STOPWORDS.has(token)) return '';
    if (/^\d+$/.test(token)) return '';
    if (token.endsWith("'s")) token = token.slice(0, -2);
    if (token.endsWith('ies') && token.length > 5) token = `${token.slice(0, -3)}y`;
    else if (token.endsWith('s') && token.length > 4 && !token.endsWith('ss')) token = token.slice(0, -1);
    if (!token || token.length < 3 || STOPWORDS.has(token)) return '';
    return token;
}

function _expandedWords(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\bdoesn['’]?t\b/g, 'does not')
        .replace(/\bdon['’]?t\b/g, 'do not')
        .replace(/\bdidn['’]?t\b/g, 'did not')
        .replace(/\bcan['’]?t\b/g, 'can not')
        .replace(/\bwon['’]?t\b/g, 'will not')
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .map(word => word.replace(/^[-_']+|[-_']+$/g, ''))
        .filter(Boolean);
}

function _wordEntries(value) {
    return _expandedWords(value).map(raw => ({
        raw,
        form: _tokenForm(raw),
    }));
}

function _hasNegationBefore(entries, index) {
    const start = Math.max(0, index - 8);
    const before = entries.slice(start, index);
    const raws = before.map(entry => entry.raw);
    if (raws.some(word => NEGATION_WORDS.has(word))) return true;

    const noIndex = raws.lastIndexOf('no');
    if (noIndex >= 0 && raws.length - noIndex <= 4) {
        const afterNo = raws[noIndex + 1] || '';
        if (!/^(people|person|man|woman|men|women|one|body)$/.test(afterNo)) return true;
    }

    const notIndex = raws.lastIndexOf('not');
    if (notIndex >= 0) {
        const afterNot = raws.slice(notIndex + 1);
        const articleNegation = /^(a|an|the|this|that|from|in|of|part|related|relevant|matching|actually)$/.test(afterNot[0] || '');
        if (afterNot.length <= 6 && (afterNot.length === 0 || articleNegation || afterNot.some(word => NEGATION_SUPPORT_WORDS.has(word)))) {
            return true;
        }
    }

    return false;
}

function _hasNegationAfter(entries, index) {
    const after = entries.slice(index + 1, index + 7).map(entry => entry.raw);
    const text = after.join(' ');
    return /\b(not visible|not shown|not seen|not present|missing|absent|lacking)\b/.test(text);
}

function _termIsNegated(description, tokens, hits = []) {
    const relevant = hits.length ? hits : tokens;
    if (!relevant.length) return false;
    const wanted = new Set(relevant);
    const entries = _wordEntries(description);
    for (let i = 0; i < entries.length; i++) {
        if (!wanted.has(entries[i].form)) continue;
        if (_hasNegationBefore(entries, i) || _hasNegationAfter(entries, i)) return true;
    }
    return false;
}

function _tokens(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .map(_tokenForm)
        .filter(Boolean);
}

function _mandatoryTokens(value) {
    return _tokens(value).filter(token => !MANDATORY_GENERIC_TOKENS.has(token));
}

function _pushParts(parts, value) {
    if (Array.isArray(value)) {
        for (const item of value) _pushParts(parts, item);
        return;
    }
    if (value !== undefined && value !== null && String(value).trim()) {
        parts.push(String(value));
    }
}

// ── Anchor tiers ──
// Not every word in the brief is an anchor. The curated fields below are LISTS
// of concrete things the scene needs ("thermometer", "trench", "emblem"); the
// prose fields one level down are SENTENCES written for a human, and every verb,
// adverb and connective in them ("conveying", "adding", "placed", "beside",
// "while") tokenizes into something almost any description echoes back. Counting
// both tiers equally is how a 3/10 press thumbnail collected six "anchors"
// (close-up, clean, conveying, institutional, authority, adding) and passed.
// The split is structural, not a word list — it holds for every niche and every
// topic because the inputs are the scene's own brief.
function _strongTargetParts(keyword, context = {}) {
    const agent = context?.mediaAgent || {};
    const parts = [];
    _pushParts(parts, keyword);
    _pushParts(parts, context?.literalRequiredObjects);
    _pushParts(parts, context?.subjectAnchors);
    _pushParts(parts, context?.mustShow);
    _pushParts(parts, context?.mandatoryVisible);
    _pushParts(parts, context?.mandatoryIdentity);
    _pushParts(parts, agent?.target);
    _pushParts(parts, agent?.literalRequiredObjects);
    _pushParts(parts, agent?.subjectAnchors);
    _pushParts(parts, agent?.mustShow);
    _pushParts(parts, agent?.mandatoryVisible);
    _pushParts(parts, agent?.mandatoryIdentity);
    return parts;
}

function _weakTargetParts(context = {}) {
    const agent = context?.mediaAgent || {};
    const hunter = context?.mediaHunter || {};
    const parts = [];
    _pushParts(parts, context?.visualIntent);
    _pushParts(parts, agent?.viewerNeed);
    _pushParts(parts, hunter?.targetDescription);
    _pushParts(parts, hunter?.prefer);
    return parts;
}

function _mandatoryParts(context = {}) {
    const agent = context?.mediaAgent || {};
    const hunter = context?.mediaHunter || {};
    const identityMode = String(agent?.identityEvidenceMode || hunter?.identityEvidenceMode || '').toLowerCase();
    const parts = [];
    _pushParts(parts, context?.mandatoryVisible);
    _pushParts(parts, agent?.mandatoryVisible);
    _pushParts(parts, hunter?.mandatoryVisible);
    if (!/source-proven/.test(identityMode)) {
        _pushParts(parts, context?.mandatoryIdentity);
        _pushParts(parts, agent?.mandatoryIdentity);
        _pushParts(parts, hunter?.mandatoryIdentity);
    }
    _pushParts(parts, context?.literalRequiredObjects);
    _pushParts(parts, context?.mustShow);
    _pushParts(parts, agent?.literalRequiredObjects);
    _pushParts(parts, agent?.mustShow);
    return parts;
}

function _hardMandatoryParts(context = {}) {
    const agent = context?.mediaAgent || {};
    const hunter = context?.mediaHunter || {};
    const parts = [];
    _pushParts(parts, context?.mandatoryVisible);
    _pushParts(parts, context?.mandatoryIdentity);
    _pushParts(parts, context?.literalRequiredObjects);
    _pushParts(parts, agent?.mandatoryVisible);
    _pushParts(parts, agent?.mandatoryIdentity);
    _pushParts(parts, agent?.literalRequiredObjects);
    _pushParts(parts, hunter?.mandatoryVisible);
    _pushParts(parts, hunter?.mandatoryIdentity);
    return parts;
}

function _hasNegatedHardMandatory(description, context = {}) {
    const descTokens = new Set(_tokens(description));
    for (const part of _hardMandatoryParts(context)) {
        const tokens = _mandatoryTokens(part);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        if (hits.length >= Math.min(2, tokens.length) && _termIsNegated(description, tokens, hits)) return true;
    }
    return false;
}

function _mandatoryCoverage(description, context = {}) {
    const parts = _mandatoryParts(context)
        .map(part => String(part || '').replace(/\s+/g, ' ').trim())
        .filter(part => part.length >= 3);
    if (parts.length === 0) return { ok: true, matched: [], required: [] };

    const descTokens = new Set(_tokens(description));
    const required = [];
    const matched = [];

    for (const part of parts) {
        const tokens = _mandatoryTokens(part);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        const need = tokens.length <= 3
            ? Math.min(2, tokens.length)
            : Math.min(4, Math.max(2, Math.ceil(tokens.length * 0.45)));
        const negated = hits.length > 0 && _termIsNegated(description, tokens, hits);
        required.push({ part, tokens, hits, need, negated });
        if (hits.length >= need && !negated) matched.push({ part, hits });
    }

    if (required.length === 0) return { ok: true, matched: [], required: [] };
    const primaryRequired = required.some(item => item.tokens.length >= 3)
        ? required.filter(item => item.tokens.length >= 3)
        : required;
    const primaryMatched = matched.filter(hit => primaryRequired.some(item => item.part.toLowerCase() === hit.part.toLowerCase()));
    return {
        ok: primaryMatched.length > 0,
        matched: primaryMatched,
        required: primaryRequired,
    };
}

function _uniqueTokens(parts, exclude = null) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        // MANDATORY_GENERIC_TOKENS was only ever applied to mandatory coverage,
        // so "visible", "clean", "close", "background", "image", "view" and
        // "shot" still counted as anchors here — words that describe no subject
        // at all and appear in nearly every vision description.
        for (const token of _mandatoryTokens(part)) {
            if (seen.has(token)) continue;
            if (exclude && exclude.has(token)) continue;
            seen.add(token);
            out.push(token);
            if (out.length >= 36) return out;
        }
    }
    return out;
}

function _descriptionCoverage(description, keyword, context = {}) {
    const strong = _uniqueTokens(_strongTargetParts(keyword, context));
    const weak = _uniqueTokens(_weakTargetParts(context), new Set(strong));
    const target = strong.concat(weak).slice(0, 36);
    const descTokens = new Set(_tokens(description));
    const matchedStrong = strong.filter(token => descTokens.has(token));
    const matchedWeak = weak.filter(token => descTokens.has(token));
    const matched = matchedStrong.concat(matchedWeak);
    const ratio = target.length ? matched.length / Math.min(target.length, 10) : 0;
    return { target, matched, matchedStrong, matchedWeak, strong, weak, ratio };
}

// This helper rescues ONE thing: a scorecard the judge produced but we could not
// read a number out of. It is not a second opinion on a number we CAN read.
//
// It drifted into being one. A caller widened `triggerScore` to "accept line
// minus 1" so borderline clips could reach deeper analysis, but the race gate is
// a hard `score < minimum` compare, so the same caller had to set the lift to
// the accept line itself for the rescue to have any effect at all — and the two
// together turned "unreadable scorecard" into "anything the judge disliked,
// promoted to a pass on word overlap". One 67-scene build produced 28 rescues
// against exactly 1 unreadable scorecard: 27 real judgments of 1, 3, 4 and 5 out
// of 10 were lifted to precisely the pass mark, twice by stacking two rescues
// (1 -> 5 -> 6). A 200x200, 6KB press thumbnail shipped as scene footage.
//
// A readable score is the judge doing its job. It stands.
function applyVisionScoreSanity(result, keyword, context = {}, options = {}) {
    if (!result) return result;
    // Never lift a score that was already lifted — that is how 1/10 reached the
    // pass mark in two hops, each hop individually looking reasonable.
    if (result.scoreSanity?.adjusted) return result;
    const score = Number(result.score ?? result.bestScore ?? 0);
    const triggerScore = Number.isFinite(Number(options.triggerScore)) ? Number(options.triggerScore) : 2;
    const parseError = !!result.parseError || (!!result.errorMessage && /missing numeric score|parse/i.test(String(result.errorMessage)));
    if (!parseError) return result;
    if (score > triggerScore) return result;

    const description = String(result.description || '').trim();
    if (description.length < 12) return result;
    if (HARD_NEGATIVE_RE.test(description)) return result;
    if (_hasNegatedHardMandatory(description, context)) return result;

    const mandatoryCoverage = _mandatoryCoverage(description, context);
    if (!mandatoryCoverage.ok) return result;

    const coverage = _descriptionCoverage(description, keyword, context);
    // The rescue has to rest on the scene's concrete subjects. Prose overlap
    // alone is not evidence: "conveying, adding, beside, while" match almost
    // anything. When the brief lists fewer than two concrete subjects, all of
    // them must appear — there is nothing else to lean on.
    const needStrong = Math.min(2, coverage.strong.length);
    if (needStrong === 0 || coverage.matchedStrong.length < needStrong) return result;
    const enoughMatches = coverage.matched.length >= 3
        || (coverage.matched.length >= 2 && coverage.target.length <= 7)
        || coverage.ratio >= 0.35;
    if (!enoughMatches) return result;
    if (_termIsNegated(description, coverage.target, coverage.matched)) return result;

    const floor = Math.max(
        1,
        Math.min(10, Number.isFinite(Number(options.floor)) ? Number(options.floor) : 5)
    );
    const adjustedScore = Math.max(score || 0, floor);
    if (adjustedScore <= score) return result;

    const reason = `description matches scene anchors: ${coverage.matched.slice(0, 6).join(', ')}`;
    return {
        ...result,
        score: adjustedScore,
        bestScore: result.bestScore !== undefined ? adjustedScore : result.bestScore,
        rawScoreBeforeSanity: score || 0,
        scoreSanity: {
            adjusted: true,
            from: score || 0,
            to: adjustedScore,
            reason,
            matched: coverage.matched.slice(0, 10),
            target: coverage.target.slice(0, 12),
            parseError,
        },
        description: `${description} [score sanity: ${_short(reason, 100)}; ${score || 0}->${adjustedScore}]`,
    };
}

// ── Self-reported defect clamp ──
// The scoring rubric caps burned-in broadcast packaging (banners, tickers,
// channel logos, captions) at 3-4, but models routinely describe the defect
// IN THEIR OWN WORDS and still emit 7/10 ("missile launch with visible news
// graphics ('13' logo) — 7/10"). When the description admits the defect, the
// number is clamped deterministically. Global, all niches, zero AI cost.
const SELF_DEFECT_RE = /(?<!\bno )(?<!\bnot )(?<!\bwithout )(?<!\bfree of )\b(news[- ](?:graphics?|banner|ticker|bug|overlay|strap)|channel (?:logo|bug|branding)|station (?:logo|branding)|broadcast (?:graphics?|overlay|packaging)|lower[- ]third|news ticker|ticker tape|burned[- ]in (?:text|caption|subtitle|graphics?)|on[- ]?screen (?:text|caption|headline)|caption (?:bar|strip)|(?:arabic|foreign(?:[- ]language)?) (?:text|caption|subtitle)|(?:large|prominent|heavy|visible) watermark)\b/i;
const DEFECT_CAP = 4;

// Broadcast branding — a channel logo, an agency stamp, a news ticker. Nobody
// ever asks for these, so they keep the hard cap no matter what the scene
// requested. Everything else SELF_DEFECT_RE catches is lettering, and lettering
// is what a drawn explanation is made of.
const BRANDING_DEFECT_RE = /\b(news[- ](?:graphics?|banner|ticker|bug|overlay|strap)|channel (?:logo|bug|branding)|station (?:logo|branding)|broadcast (?:graphics?|overlay|packaging)|lower[- ]third|news ticker|ticker tape|watermark)\b/i;
// Cap for lettering on a scene that explicitly asked for a diagram/schematic.
// Still a cap, not an exemption: a labelled diagram sits above the accept floor
// but below clean footage, exactly like the packaging penalty one level up.
const REQUESTED_GRAPHIC_CAP = 7;

function clampSelfReportedDefects(result, context = {}) {
    if (!result) return result;
    const score = Number(result.score ?? result.bestScore ?? 0);
    if (!(score > DEFECT_CAP)) return result;
    const description = String(result.description || '');
    const m = description.match(SELF_DEFECT_RE);
    if (!m) return result;

    // A scene whose own brief is "cross-section diagram with temperature
    // indicators and soil layers" has ASKED for writing on the picture. Clamping
    // it to 4 for having labels is the same self-defeating loop that left that
    // scene with no media at all — one level further down. Branding is exempt
    // from the exemption.
    const wantsGraphic = !!context?.mediaHunter?.requestedPackaging?.graphic;
    const cap = (wantsGraphic && !BRANDING_DEFECT_RE.test(m[0])) ? REQUESTED_GRAPHIC_CAP : DEFECT_CAP;
    if (!(score > cap)) return result;

    return {
        ...result,
        score: cap,
        bestScore: result.bestScore !== undefined ? cap : result.bestScore,
        rawScoreBeforeSanity: score,
        scoreSanity: {
            adjusted: true,
            from: score,
            to: cap,
            reason: `description self-reports broadcast packaging ("${m[0]}")`,
        },
        description: `${description} [defect clamp: "${m[0]}" → ${cap}/10]`,
    };
}

module.exports = {
    applyVisionScoreSanity,
    clampSelfReportedDefects,
};
