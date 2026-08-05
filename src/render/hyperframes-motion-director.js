const { callAIJson } = require('../brain/strict-json');
let MG_REGISTRY = {};
try { ({ MG_REGISTRY = {} } = require('./mg-registry')); } catch (_) { MG_REGISTRY = {}; }
const {
  getGraphicShellCapabilities,
  normalizeGraphicShell,
} = require('./graphic-shells');
const {
  resolveGraphicMediaTreatment,
} = require('./overlay-visual-policy');

// kebab type ('kinetic-text') → camel registry key ('kineticText')
function registryKeyFromType(type) {
  return String(type || '').toLowerCase().replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// The variant palette for a type, straight from the registry (the single source
// of truth). For kineticText these ARE the motions (punch/cascade/wave/…); for
// lowerThird/statCounter/callout they are the looks (glass/ring/stamp/…). The
// Motion Director picks one per beat — that's the human-designer decision.
function variantsForType(type) {
  const reg = MG_REGISTRY[registryKeyFromType(type)];
  if (!reg || !reg.types) return [];
  return Object.keys(reg.types);
}

const LAYOUTS = new Set([
  'lower-third',
  'center-stack',
  'cinematic-title',
  'evidence-board',
  'data-focus',
  'split-panel',
  'map-explainer',
  'focus-panel',
]);

const SAFE_ZONES = new Set([
  'auto',
  'center',
  'center-left',
  'center-right',
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right',
]);

const DENSITIES = new Set(['compact', 'standard', 'spacious']);
const TEXT_STRATEGIES = new Set(['full', 'headline', 'keyword', 'minimal', 'data']);
const MEDIA_TREATMENTS = new Set([
  'transparent',
  'cinematic-background',
  'darken-background',
  'blur-background',
  'image-focus',
  'map-focus',
  'evidence-board',
  'split-background',
]);

function isDisabled() {
  const flags = [
    process.env.HF_MOTION_DIRECTOR,
    process.env.HYPERFRAMES_MOTION_DIRECTOR,
  ].filter(v => v !== undefined && v !== null);
  return flags.some(v => /^(0|false|off|no)$/i.test(String(v).trim()));
}

function logLine(log, method, message) {
  if (log && typeof log[method] === 'function') {
    log[method](message);
    return;
  }
  if (log && typeof log.info === 'function') {
    log.info(message);
    return;
  }
  console.log(message);
}

function truncate(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function token(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || fallback;
}

function pickAllowed(value, allowed, fallback) {
  const normalized = token(value, '');
  return allowed.has(normalized) ? normalized : fallback;
}

function nonEmpty(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function getItemType(item) {
  return token(
    item?.type ||
    item?.mgType ||
    item?.templateType ||
    item?.category ||
    item?.visualType ||
    'graphic',
    'graphic'
  );
}

function getItemText(item) {
  return (
    item?.text ||
    item?.title ||
    item?.label ||
    item?.primaryText ||
    item?.headline ||
    item?.word ||
    item?.content ||
    ''
  );
}

function getItemSubtext(item) {
  return (
    item?.subtext ||
    item?.subtitle ||
    item?.description ||
    item?.secondaryText ||
    item?.body ||
    item?.note ||
    ''
  );
}

function getItemStart(item) {
  const value = item?.startTime ?? item?.start ?? item?.time ?? item?.at;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function getItemDuration(item) {
  const value = item?.duration ?? item?.dur ?? item?.length;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 3;
}

function hasMedia(item) {
  return Boolean(
    item?.mediaFile ||
    item?.mediaPath ||
    item?.templateMediaFile ||
    item?.backgroundMedia ||
    item?.assetPath ||
    item?.mapImage ||
    item?.imagePath ||
    item?.videoPath
  );
}

function sceneIndexOf(scene, fallbackIndex) {
  const value = scene?.index ?? scene?.sceneIndex ?? scene?.originalIndex ?? fallbackIndex;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallbackIndex;
}

function findOwnerScene(item, scenes) {
  const wanted = item?.sceneIndex ?? item?.originalSceneIndex ?? item?.targetSceneIndex;
  if (wanted !== undefined && wanted !== null) {
    const byIndex = scenes.find((scene, index) => sceneIndexOf(scene, index) === Number(wanted));
    if (byIndex) return byIndex;
  }

  const start = getItemStart(item);
  const mid = start + getItemDuration(item) / 2;
  return scenes.find(scene => {
    const sceneStart = Number(scene?.startTime ?? scene?.start ?? 0);
    const sceneEnd = Number(scene?.endTime ?? scene?.end ?? (sceneStart + Number(scene?.duration || 0)));
    return Number.isFinite(sceneStart) && Number.isFinite(sceneEnd) && mid >= sceneStart && mid <= sceneEnd;
  }) || null;
}

function buildItemEnvelope(group, index, item, scenes) {
  const scene = findOwnerScene(item, scenes);
  const type = getItemType(item);
  const role = group === 'templateScenes'
    ? 'template'
    : group === 'mgScenes'
      ? 'fullscreen'
      : 'overlay';
  const existing = item?.agenticComposition || item?.hyperframeComposition || item?.compositionSpec || null;

  const envelope = {
    id: `${group}:${index}`,
    group,
    index,
    role,
    type,
    category: item?.category || '',
    startTime: getItemStart(item),
    duration: getItemDuration(item),
    sceneIndex: item?.sceneIndex ?? item?.originalSceneIndex ?? scene?.index ?? scene?.sceneIndex ?? '',
    text: truncate(getItemText(item), 180),
    subtext: truncate(getItemSubtext(item), 220),
    keyword: truncate(item?.keyword || scene?.keyword || scene?.visualKeyword || '', 160),
    visualIntent: truncate(item?.visualIntent || scene?.visualIntent || scene?.visualDescription || '', 220),
    sceneText: truncate(scene?.text || scene?.narration || scene?.sentence || '', 260),
    sourceHint: truncate(item?.sourceHint || item?.source || scene?.sourceHint || scene?.source || '', 80),
    mediaType: item?.mediaType || scene?.mediaType || '',
    hasMediaAsset: hasMedia(item),
    existingLayout: existing?.layout || '',
    existingSafeZone: existing?.safeZone || item?.position || '',
    existingVariant: item?.variant || item?.templateVariant || '',
    existingStyle: item?.style || item?.themeStyle || '',
    existingAnimation: item?.animation || item?.animationType || '',
    existingShell: item?.graphicShell || existing?.shell || existing?.style?.shell || null,
    existingShellManual: item?.graphicShellManual === true || item?.mgData?.graphicShellManual === true,
    transparentBackground: item?.transparentBackground === true
      || item?.mgData?.transparentBackground === true
      || item?.cardStyle === 'transparent'
      || item?.mgData?.cardStyle === 'transparent',
    accentRuleVisible: item?.accentRuleVisible !== false
      && item?.mgData?.accentRuleVisible !== false,
    variants: variantsForType(type),
  };
  envelope.shellCapabilities = getGraphicShellCapabilities({
    id: envelope.id,
    role,
    type,
    text: envelope.text,
    subtext: envelope.subtext,
    itemCount: Array.isArray(existing?.items) ? existing.items.length : 0,
    density: existing?.density,
    textStrategy: existing?.textStrategy,
    safeZone: envelope.existingSafeZone,
    layout: envelope.existingLayout,
    mood: `${envelope.existingStyle} ${envelope.visualIntent}`,
    transparentBackground: envelope.transparentBackground,
    accentRuleVisible: envelope.accentRuleVisible,
  });
  return envelope;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function stripJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  text = text.replace(/,\s*([}\]])/g, '$1');
  return text;
}

function parseDirectorResponse(raw) {
  const parsed = JSON.parse(stripJson(raw));
  if (Array.isArray(parsed)) return { items: parsed };
  if (Array.isArray(parsed.items)) return parsed;
  if (parsed.id) return { items: [parsed] };
  return { items: [] };
}

function cleanItems(items) {
  return toArray(items)
    .map(value => {
      if (value && typeof value === 'object') {
        const label = truncate(value.label || value.title || value.text || value.name || '', 90);
        const val = truncate(value.value ?? value.rank ?? value.stat ?? value.side ?? '', 40);
        if (!label && !val) return null;
        return val ? { label, value: val } : { label };
      }
      const label = truncate(value, 90);
      return label ? { label } : null;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeSpec(raw, envelope) {
  const style = raw?.style && typeof raw.style === 'object' ? raw.style : {};
  const motion = raw?.motion && typeof raw.motion === 'object'
    ? raw.motion
    : raw?.motionIntent
      ? { reason: raw.motionIntent }
      : {};
  const constraints = raw?.constraints && typeof raw.constraints === 'object' ? raw.constraints : {};

  const title = truncate(nonEmpty(raw?.title) || envelope.text || envelope.keyword || 'Visual', 130);
  const subtitle = truncate(nonEmpty(raw?.subtitle) || envelope.subtext || '', 180);
  const kicker = truncate(nonEmpty(raw?.kicker) || nonEmpty(raw?.label) || '', 60);

  // Variant = the human-designer pick from this type's registry palette
  // (kineticText: the motion; lowerThird/statCounter/callout: the look). Only
  // honored if it's a real variant for this type; else keep whatever existed.
  const allowedVariants = Array.isArray(envelope.variants) ? envelope.variants : [];
  const rawVariant = String(raw?.variant || raw?.subType || '').trim();
  const variant = allowedVariants.includes(rawVariant)
    ? rawVariant
    : (allowedVariants.includes(envelope.existingVariant) ? envelope.existingVariant : '');
  const role = pickAllowed(raw?.role, new Set(['overlay', 'fullscreen', 'template']), envelope.role);
  const requestedMediaTreatment = pickAllowed(
    raw?.mediaTreatment || raw?.media?.treatment,
    MEDIA_TREATMENTS,
    envelope.hasMediaAsset ? 'cinematic-background' : 'transparent'
  );
  const mediaTreatment = resolveGraphicMediaTreatment({
    role,
    type: envelope.type,
    requested: requestedMediaTreatment,
    fallback: envelope.hasMediaAsset ? 'cinematic-background' : 'transparent',
  });
  const shell = normalizeGraphicShell(
    envelope.existingShellManual
      ? envelope.existingShell
      : (raw?.shell || style.shell || envelope.existingShell),
    {
      id: envelope.id,
      role: envelope.role,
      type: envelope.type,
      text: title,
      subtext: subtitle || kicker,
      items: cleanItems(raw?.items || raw?.bullets),
      density: raw?.density || style.density,
      textStrategy: raw?.textStrategy,
      safeZone: raw?.safeZone || envelope.existingSafeZone,
      layout: raw?.layout || envelope.existingLayout,
      mood: `${style.mood || raw?.mood || ''} ${raw?.reason || envelope.visualIntent || ''}`,
      manual: envelope.existingShellManual,
      transparentBackground: envelope.transparentBackground,
      accentRuleVisible: envelope.accentRuleVisible,
    }
  );

  return {
    mode: 'agentic',
    role,
    type: envelope.type,
    variant: variant || undefined,
    layout: pickAllowed(raw?.layout, LAYOUTS, envelope.existingLayout || 'focus-panel'),
    safeZone: pickAllowed(raw?.safeZone, SAFE_ZONES, envelope.existingSafeZone || 'auto'),
    density: pickAllowed(raw?.density, DENSITIES, 'standard'),
    textStrategy: pickAllowed(raw?.textStrategy, TEXT_STRATEGIES, 'headline'),
    kicker: kicker || undefined,
    title,
    subtitle: subtitle || undefined,
    items: cleanItems(raw?.items || raw?.bullets),
    shell,
    media: {
      hasAsset: envelope.hasMediaAsset,
      treatment: mediaTreatment,
    },
    style: {
      mood: truncate(style.mood || raw?.mood || '', 80) || undefined,
      palette: truncate(style.palette || raw?.palette || '', 100) || undefined,
      accent: truncate(style.accent || raw?.accent || '', 40) || undefined,
      typography: truncate(style.typography || raw?.typography || '', 80) || undefined,
      density: pickAllowed(style.density, DENSITIES, pickAllowed(raw?.density, DENSITIES, 'standard')),
      glass: style.glass,
      shadow: style.shadow,
    },
    motion: {
      entrance: truncate(motion.entrance || raw?.entrance || '', 80) || undefined,
      emphasis: truncate(motion.emphasis || raw?.emphasis || '', 80) || undefined,
      exit: truncate(motion.exit || raw?.exit || '', 80) || undefined,
      stagger: truncate(motion.stagger || raw?.stagger || '', 60) || undefined,
      speed: truncate(motion.speed || raw?.speed || '', 40) || undefined,
      reason: truncate(motion.reason || raw?.motionIntent || raw?.reason || '', 180) || undefined,
    },
    constraints: {
      readable: constraints.readable !== false,
      noOverlap: constraints.noOverlap !== false,
      avoidCriticalVisuals: constraints.avoidCriticalVisuals !== false,
      maxTextLines: Number(constraints.maxTextLines || raw?.maxTextLines || 4),
      preserveMeaning: constraints.preserveMeaning !== false,
    },
    source: raw?.source || 'motion-director',
  };
}

function buildPrompt({ projectContext, style, items }) {
  return `You are the Motion Director for a HyperFrames video editor.

Goal: turn rigid motion graphic/template hints into creative but safe structured composition specs.
You are NOT writing HTML/CSS/JS. You are choosing composition intent that the renderer can execute.

Project:
${JSON.stringify(projectContext, null, 2)}

Style context:
${JSON.stringify(style || {}, null, 2)}

Rules:
- Preserve the narration language. Do not translate text.
- Use the scene meaning, role, media, and timing. Old variants/animations are only hints.
- Pick a composition that feels edited by a smart human editor, not a fixed preset.
- Template/fullscreen scenes should feel like real scene explanations, title cards, chapter cards, map explainers, evidence boards, or data moments.
- Overlay MGs must avoid important visual areas and remain readable.
- Keep text concise. If a line is too long, shorten without changing meaning.
- FOOTAGE INTEGRITY: every overlay except focus-word MUST use mediaTreatment "transparent". Normal overlays may use a bounded local text/card plate, but must never darken, blur, tint, vignette, or shade the whole frame.
- focus-word is the only overlay allowed to use a subtle full-frame focus treatment (darken-background, blur-background, image-focus, or cinematic-background).
- Fullscreen/template graphics may use media treatments intentionally: darken/blur for readability, map-focus for maps, and image-focus for evidence.
- Avoid decorative complexity when it hurts clarity.
- "shell" is structural chrome only. It never chooses colors or fonts; the active theme and adaptive-contrast system own those.
- Compose the shell from the exact live dimensions listed on each item. Choose it from the copy length, hierarchy, safe zone, mood, and neighboring visual role—not from a fixed graphic-type template.
- Respect explicit editing state: when transparentBackground is true, use surface "none"; when accentRuleVisible is false, use accent "none".
- Use split hierarchy only when secondary copy is useful. Prefer simple underline/rail/naked structures over decorative boxes unless density or readability needs a surface.
- Vary shell combinations across the video with editorial intent; do not rotate them mechanically and do not force every item into a box.

DATA/LIST FULLSCREEN TYPES NEED REAL CONTENT. If an item's type is bullet-list, ranking-list,
timeline, comparison-card, bar-chart or donut-chart, you MUST return an "items" array with 3-6
concrete entries pulled from that scene's meaning (sceneText/visualIntent) — NOT the title
repeated. Each entry: {"label":"short phrase", "value":"rank/number/side if relevant"}. For
comparison-card give exactly two entries (the two things compared). A bullet-list/timeline/
comparison with no items is broken — if the scene has no real list/comparison to show, you have
chosen the wrong type: switch it to a headline or focus-panel that fits the single idea instead.

VARIANT — your most important creative lever. Each item lists "variants": its real
palette. Pick the ONE that matches the emotional beat of that moment, the way a human
motion designer would — do not default everything to the same variant. What they feel like:
- kineticText: centered=calm/even rise · rise=confident lift · cascade=words fall from above ·
  punch=hard impact on a shocking fact · stamp=heavy slam for a verdict/label · glitch=tense,
  digital, unstable · wave=flowing, smooth narration · pop=playful, energetic.
- lowerThird: bar=default · box=formal · underline=clean/minimal · banner=newsy/breaking ·
  glass=sleek/modern · split=bold accent.
- statCounter: standard=plain number · ticker=financial/live readout · ring=a progress/percentage gauge.
- callout: standard=quote box · minimal=quiet aside · accent=loud emphasis.
- headline: standard · stamp=impact label · typewriter=typed/mono reveal.
Choose a variant that exists in that item's "variants" list. Vary them across the video so the
motion reads as hand-edited. Also set "motion.entrance" consistent with the variant.

Allowed layout values:
${Array.from(LAYOUTS).join(', ')}

Allowed safeZone values:
${Array.from(SAFE_ZONES).join(', ')}

Allowed density values:
${Array.from(DENSITIES).join(', ')}

Allowed textStrategy values:
${Array.from(TEXT_STRATEGIES).join(', ')}

Allowed mediaTreatment values:
${Array.from(MEDIA_TREATMENTS).join(', ')}

Return strict JSON only:
{
  "items": [
    {
      "id": "same id from input",
      "variant": "one of THIS item's listed variants (the design choice)",
      "layout": "one allowed layout",
      "safeZone": "one allowed safeZone",
      "density": "one allowed density",
      "textStrategy": "one allowed textStrategy",
      "kicker": "short label if useful",
      "title": "main visible text",
      "subtitle": "optional support text",
      "items": ["optional short bullets"],
      "shell": {
        "surface": "one allowed surface from this item's shellCapabilities",
        "accent": "one allowed accent",
        "geometry": "one allowed geometry",
        "hierarchy": "one allowed hierarchy",
        "width": "one allowed width",
        "emphasis": "one allowed emphasis"
      },
      "mediaTreatment": "one allowed mediaTreatment",
      "style": {
        "mood": "brief visual mood",
        "palette": "brief palette direction",
        "accent": "accent color/name",
        "typography": "brief type direction",
        "density": "compact|standard|spacious",
        "glass": true,
        "shadow": true
      },
      "motion": {
        "entrance": "brief entrance direction",
        "emphasis": "brief emphasis direction",
        "exit": "brief exit direction",
        "stagger": "brief stagger direction",
        "speed": "slow|normal|fast",
        "reason": "why this motion fits the scene"
      },
      "constraints": {
        "readable": true,
        "noOverlap": true,
        "avoidCriticalVisuals": true,
        "maxTextLines": 4,
        "preserveMeaning": true
      }
    }
  ]
}

Input items:
${JSON.stringify(items, null, 2)}
`;
}

function applySpec(target, spec) {
  // Surface the Director's variant pick onto the MG itself so resolveHyperframeVisual
  // (explicitVariant ← mg.subType/variant) renders the right look/motion. This is how
  // the AI's per-beat design choice reaches the variant CSS + kinetic motion vocab.
  if (spec.variant) {
    target.subType = spec.variant;
    target.variant = spec.variant;
  }
  // Surface structured list/data entries onto the MG so the dedicated fullscreen
  // renderers (bullet-list/ranking/timeline/comparison/charts) have real content
  // instead of rendering the title as a single fake item.
  if (Array.isArray(spec.items) && spec.items.length) {
    target.items = spec.items;
    if (target.mgData && typeof target.mgData === 'object') target.mgData.items = spec.items;
  }
  if (spec.shell && target.graphicShellManual !== true && target?.mgData?.graphicShellManual !== true) {
    target.graphicShell = spec.shell;
    if (target.mgData && typeof target.mgData === 'object') target.mgData.graphicShell = spec.shell;
  }
  const existing = target.agenticComposition && typeof target.agenticComposition === 'object'
    ? target.agenticComposition
    : {};
  target.agenticComposition = {
    ...existing,
    ...spec,
    style: { ...(existing.style || {}), ...(spec.style || {}) },
    motion: { ...(existing.motion || {}), ...(spec.motion || {}) },
    constraints: { ...(existing.constraints || {}), ...(spec.constraints || {}) },
    media: { ...(existing.media || {}), ...(spec.media || {}) },
    source: spec.source || existing.source || 'motion-director',
  };
}

async function applyHyperframesMotionDirector({
  motionGraphics = [],
  mgScenes = [],
  templateScenes = [],
  scenes = [],
  scriptContext = {},
  style = {},
  log = console,
} = {}) {
  if (isDisabled()) {
    logLine(log, 'dim', '[Motion Director] Disabled by environment.');
    return { motionGraphics, mgScenes, templateScenes, applied: 0, skipped: true };
  }

  const groups = { motionGraphics, mgScenes, templateScenes };
  const envelopes = [];
  Object.entries(groups).forEach(([group, list]) => {
    toArray(list).forEach((item, index) => {
      if (!item || item.agenticComposition === false || item.hyperframeComposition === false || item.disableAgenticComposition) return;
      envelopes.push({
        ...buildItemEnvelope(group, index, item, scenes),
        target: item,
      });
    });
  });

  if (!envelopes.length) {
    logLine(log, 'dim', '[Motion Director] No HyperFrames visual items to enrich.');
    return { motionGraphics, mgScenes, templateScenes, applied: 0 };
  }

  const projectContext = {
    title: truncate(scriptContext?.title || scriptContext?.videoTitle || scriptContext?.topic || '', 160),
    niche: scriptContext?.niche || scriptContext?.detectedNiche || '',
    language: scriptContext?.language || scriptContext?.targetLanguage || '',
    theme: style?.themeId || scriptContext?.themeId || '',
    visualMode: 'hyperframes-agentic-composition',
  };

  logLine(log, 'info', `[Motion Director] Enriching ${envelopes.length} HyperFrames visual item(s).`);

  const byId = new Map(envelopes.map(entry => [entry.id, entry]));
  let applied = 0;
  const failures = [];

  for (const part of chunk(envelopes, 18)) {
    const promptItems = part.map(({ target, ...entry }) => entry);
    const prompt = buildPrompt({ projectContext, style, items: promptItems });
    try {
      const maxTokens = Math.min(6500, 1300 + promptItems.length * 280);
      const parsed = await callAIJson(prompt, {
        label: 'Motion Director',
        taskType: 'motion-graphics',
        maxTokens,
        temperature: 0.35,
        maxRetries: 2,
        schemaDescription: '{"items":[{"id":"same id from input","layout":"allowed layout","safeZone":"allowed safeZone","density":"compact|standard|spacious","textStrategy":"full|headline|keyword|minimal|data","title":"text","items":[{"label":"text","value":"optional"}],"shell":{"surface":"allowed","accent":"allowed","geometry":"allowed","hierarchy":"allowed","width":"allowed","emphasis":"allowed"},"mediaTreatment":"allowed media treatment","style":{},"motion":{},"constraints":{}}]}',
        validate(value) {
          if (!value || !Array.isArray(value.items)) return 'items array is required';
          const expected = new Set(promptItems.map(item => item.id));
          const seen = new Set();
          for (const item of value.items) {
            if (!item || typeof item !== 'object') return 'each item must be an object';
            if (!expected.has(item.id)) return `unknown item id: ${item?.id}`;
            seen.add(item.id);
          }
          const missing = [...expected].filter(id => !seen.has(id));
          if (missing.length) return `missing item ids: ${missing.slice(0, 6).join(', ')}`;
          return true;
        },
      });
      for (const rawSpec of parsed.items || []) {
        const id = rawSpec?.id;
        const envelope = byId.get(id);
        if (!envelope) continue;
        const spec = normalizeSpec(rawSpec, envelope);
        applySpec(envelope.target, spec);
        applied += 1;
        logLine(log, 'dim', `[Motion Director] ${id} ${envelope.type}: layout=${spec.layout} shell=${spec.shell.surface}/${spec.shell.accent}/${spec.shell.hierarchy} safe=${spec.safeZone} media=${spec.media.treatment}`);
      }
    } catch (error) {
      failures.push(error?.message || String(error));
      logLine(log, 'warn', `[Motion Director] AI pass failed for ${part.length} item(s): ${error?.message || error}`);
    }
  }

  if (applied < envelopes.length) {
    logLine(log, 'warn', `[Motion Director] Missing ${envelopes.length - applied} AI composition spec(s); strict JSON mode does not generate fallback specs.`);
  }

  logLine(log, 'ok', `[Motion Director] Applied ${applied}/${envelopes.length} AI composition spec(s).`);
  if (failures.length) {
    logLine(log, 'warn', `[Motion Director] Strict JSON failed for ${failures.length} director pass(es); no fallback specs were generated.`);
  }

  return { motionGraphics, mgScenes, templateScenes, applied, failures };
}

module.exports = {
  applyHyperframesMotionDirector,
  buildMotionDirectorPrompt: buildPrompt,
  normalizeMotionDirectorSpec: normalizeSpec,
};
