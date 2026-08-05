'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { generateHyperframesProject } = require('../../render/hyperframes-bridge');
const { prefersFixedRenderer } = require('../../render/authored-composition-policy');
const {
    captureProofSnapshots,
    resolveHyperframesCli,
} = require('../workers/motion-qa-agent');
const { authorPlanCompositions } = require('../workers/composition-author');
const registry = require('./capabilities/registry');
const {
    overlaps,
    scopeRange,
    visualMatchesRefs,
    windowOf,
} = require('./scope-utils');

const RISK_WEIGHT = Object.freeze({
    low: 0,
    moderate: 1,
    expensive: 2,
    structural: 3,
});

function _toolSpec(capabilityId, action) {
    return registry.getCapability(capabilityId)?.manifest?.tools?.find((tool) => (
        tool.action === action
    )) || null;
}

function _hasVisualImpact(operation) {
    return _toolSpec(
        String(operation?.capabilityId || ''),
        String(operation?.action || '')
    )?.visualImpact === true;
}

function _isSafeRepairAction(capabilityId, action) {
    const tool = _toolSpec(capabilityId, action);
    return tool?.visualRepair === true && tool.action === tool.canonicalAction;
}

function _visualRepairTool(tool) {
    if (!tool || !Array.isArray(tool.visualRepairFields) || !tool.visualRepairFields.length) {
        return tool;
    }
    const allowed = new Set(tool.visualRepairFields);
    const args = _clone(tool.args);
    args.properties = Object.fromEntries(
        Object.entries(args.properties || {})
            .filter(([key]) => allowed.has(key))
    );
    args.required = (args.required || []).filter((key) => allowed.has(key));
    args.anyOfRequired = (args.anyOfRequired || [])
        .map((group) => group.filter((key) => allowed.has(key)))
        .filter((group) => group.length);
    return {
        ...tool,
        args,
    };
}

function _boundedRepairInvocation(invocation, capabilityId, action) {
    const tool = _toolSpec(capabilityId, action);
    if (!tool || !Array.isArray(tool.visualRepairFields) || !tool.visualRepairFields.length) {
        return invocation;
    }
    const allowed = new Set(tool.visualRepairFields);
    return {
        ...invocation,
        args: Object.fromEntries(
            Object.entries(invocation?.args || {})
                .filter(([key]) => allowed.has(key))
        ),
    };
}

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _compactText(value, max = 500) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function _safeToken(value, fallback = 'visual-qa') {
    const token = String(value || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96);
    return token || fallback;
}

function _inside(parent, child) {
    const root = path.resolve(parent);
    const target = path.resolve(child);
    const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
    const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
    return targetKey !== rootKey && targetKey.startsWith(`${rootKey}${path.sep}`);
}

function _removeContained(parent, child) {
    if (!_inside(parent, child)) return;
    try {
        fs.rmSync(path.resolve(child), { recursive: true, force: true });
    } catch (_) { }
}

function shouldRunVisualQa({ effort, operations, options = {} }) {
    if (options.visualQa === false) return false;
    if (/^(0|false|off|no)$/i.test(String(process.env.AGENT_VISUAL_QA || '').trim())) return false;
    const forced = /^(1|true|on|yes|always)$/i.test(String(process.env.AGENT_VISUAL_QA || '').trim());
    const exactVisualRegeneration = (operations || []).some((operation) => (
        operation?.capabilityId === 'graphics'
        && operation?.action === 'regenerate'
        && operation?.scope?.kind === 'visual'
    ));
    if (!forced && effort !== 'smart' && !exactVisualRegeneration) return false;
    return (operations || []).some(_hasVisualImpact);
}

function _identity(item, index, prefix) {
    return String(item?.clipId || item?.id || `${prefix}-${index}`);
}

function _changedVisualEntries(beforePlan, afterPlan) {
    const changed = [];
    for (const collection of ['motionGraphics', 'mgScenes', 'templateScenes']) {
        const beforeItems = new Map(
            (beforePlan?.[collection] || []).map((item, index) => [
                _identity(item, index, collection),
                item,
            ])
        );
        (afterPlan?.[collection] || []).forEach((visual, index) => {
            if (!visual || visual.disabled === true) return;
            const id = _identity(visual, index, collection);
            const before = beforeItems.get(id);
            if (!before || JSON.stringify(before) !== JSON.stringify(visual)) {
                changed.push({ collection, index, id, visual });
            }
        });
    }
    return changed;
}

function _renderContractFailures(beforePlan, renderPlan, operations, manifest) {
    if (!(operations || []).some((operation) => operation?.capabilityId === 'graphics')) return [];
    const graphics = Array.isArray(manifest?.graphics) ? manifest.graphics : [];
    const failures = [];
    for (const entry of _changedVisualEntries(beforePlan, renderPlan)) {
        if (!prefersFixedRenderer(entry.visual)) continue;
        const rendered = graphics.find((graphic) => (
            String(graphic?.sourceClipId || '') === String(entry.id)
        ));
        if (!rendered) {
            failures.push(`${entry.id} was not present in the generated graphics manifest`);
            continue;
        }
        if (rendered.authored === true || rendered.fixedRendererOverride !== true) {
            failures.push(`${entry.id} still used an authored composition instead of the explicit Agent edit`);
        }
        const target = entry.visual?.mgData && typeof entry.visual.mgData === 'object'
            ? { ...entry.visual, ...entry.visual.mgData }
            : entry.visual;
        const expectedTransparent = target.transparentBackground === true
            || target.backgroundMode === 'transparent'
            || target.cardStyle === 'transparent';
        if (expectedTransparent && rendered.transparentBackground !== true) {
            failures.push(`${entry.id} lost its transparent-background edit during rendering`);
        }
        if (
            typeof target.accentRuleVisible === 'boolean'
            && rendered.accentRuleVisible !== target.accentRuleVisible
        ) {
            failures.push(
                `${entry.id} rendered accent-rule visibility "${rendered.accentRuleVisible}" instead of "${target.accentRuleVisible}"`
            );
        }
        if (target.timingManual === true) {
            const expectedDuration = windowOf(target, 0.5).endTime - windowOf(target, 0.5).startTime;
            if (Math.abs((Number(rendered.duration) || 0) - expectedDuration) > 0.02) {
                failures.push(
                    `${entry.id} rendered duration "${rendered.duration}" instead of "${expectedDuration}"`
                );
            }
        }
        const expectedAnimation = String(target.animation || '').trim();
        if (
            expectedAnimation
            && (target.animationManual === true || target.variantManual === true)
            && String(rendered.animation || '').trim() !== expectedAnimation
        ) {
            failures.push(
                `${entry.id} rendered animation "${rendered.animation || 'none'}" instead of "${expectedAnimation}"`
            );
        }
        const expectedTextColor = String(target.colors?.text || '').replace(/\s+/g, '').toLowerCase();
        const renderedTextColor = String(rendered.textColor || '').replace(/\s+/g, '').toLowerCase();
        if (expectedTextColor && renderedTextColor !== expectedTextColor) {
            failures.push(
                `${entry.id} rendered text color "${rendered.textColor || 'unset'}" instead of "${target.colors.text}"`
            );
        }
    }
    return [...new Set(failures)];
}

function _assertRenderedContracts(beforePlan, renderPlan, operations, manifest) {
    const failures = _renderContractFailures(beforePlan, renderPlan, operations, manifest);
    if (!failures.length) return;
    const error = new Error(`Rendered edit contract failed: ${failures.join('; ')}`);
    error.code = 'AGENT_RENDER_CONTRACT_FAILED';
    error.failures = failures;
    throw error;
}

function _changedWindows(beforePlan, afterPlan) {
    const windows = [];
    const beforeScenes = new Map(
        (beforePlan?.scenes || [])
            .filter((scene) => scene && !scene.isMGScene)
            .map((scene, index) => [_identity(scene, index, 'scene'), scene])
    );
    (afterPlan?.scenes || [])
        .filter((scene) => scene && !scene.isMGScene && scene.disabled !== true)
        .forEach((scene, index) => {
            const before = beforeScenes.get(_identity(scene, index, 'scene'));
            if (!before || JSON.stringify(before) !== JSON.stringify(scene)) {
                windows.push({
                    id: String(scene.clipId || `scene-${index}`),
                    phase: 'edited-clip',
                    collection: 'scenes',
                    index,
                    item: scene,
                    ...windowOf(scene),
                });
            }
        });

    for (const collection of ['motionGraphics', 'mgScenes', 'templateScenes']) {
        const beforeItems = new Map(
            (beforePlan?.[collection] || []).map((item, index) => [
                _identity(item, index, collection),
                item,
            ])
        );
        (afterPlan?.[collection] || []).forEach((item, index) => {
            if (!item || item.disabled === true) return;
            const before = beforeItems.get(_identity(item, index, collection));
            if (!before || JSON.stringify(before) !== JSON.stringify(item)) {
                windows.push({
                    id: String(item.id || `${collection}-${index}`),
                    phase: 'edited-graphic',
                    collection,
                    index,
                    item,
                    ...windowOf(item, collection === 'templateScenes' ? 4 : 3),
                });
            }
        });
    }
    return windows;
}

function representativeProofTimes(beforePlan, afterPlan, scope, operations, limit = 4) {
    const totalDuration = Math.max(
        Number(afterPlan?.totalDuration) || 0,
        ...(afterPlan?.scenes || []).map((scene) => windowOf(scene).endTime)
    );
    const candidates = [];
    const addWindow = (id, phase, startValue, endValue, weight = 1) => {
        const start = Math.max(0, Number(startValue) || 0);
        const end = Math.max(start, Number(endValue) || start);
        const duration = Math.max(0, end - start);
        const time = duration > 0.18
            ? start + Math.min(duration * 0.5, Math.max(0.12, duration - 0.08))
            : start;
        candidates.push({
            id: _compactText(id || 'timeline', 120),
            phase: _compactText(phase || 'proof', 80),
            time: Math.min(Math.max(0, totalDuration - 0.02), Math.max(0, time)),
            weight,
        });
    };

    for (const ref of (scope?.visualRefs || [])) {
        addWindow(ref.id, 'selected-graphic', ref.startTime, ref.endTime, 8);
    }
    for (const ref of (scope?.clipRefs || [])) {
        addWindow(ref.clipId, 'selected-clip', ref.startTime, ref.endTime, 7);
    }
    if (!candidates.length && scope?.kind !== 'project') {
        const range = scopeRange(scope, afterPlan);
        addWindow(scope?.label, 'selected-range', range.fromSec, range.toSec, 6);
        if (Number(scope?.currentTime) >= range.fromSec && Number(scope?.currentTime) <= range.toSec) {
            candidates.push({
                id: _compactText(scope?.label || 'playhead', 120),
                phase: 'playhead',
                time: Number(scope.currentTime),
                weight: 9,
            });
        }
    }
    const scopedRange = scope?.kind === 'project' ? null : scopeRange(scope, afterPlan);
    for (const item of _changedWindows(beforePlan, afterPlan)) {
        if (scope?.kind === 'visual') {
            if (
                item.phase !== 'edited-graphic'
                || !visualMatchesRefs(
                    item.item,
                    scope.visualRefs,
                    item.collection,
                    item.index
                )
            ) continue;
        } else if (
            scopedRange
            && !overlaps(item.item, scopedRange.fromSec, scopedRange.toSec)
        ) {
            continue;
        }
        addWindow(item.id, item.phase, item.startTime, item.endTime, item.phase === 'edited-graphic' ? 6 : 4);
    }
    if ((operations || []).some((operation) => operation.capabilityId === 'transitions')) {
        for (const [index, transition] of (afterPlan?.transitions || []).entries()) {
            const at = Number(transition?.startTime ?? transition?.at);
            if (!Number.isFinite(at)) continue;
            candidates.push({
                id: `transition-${index}`,
                phase: 'transition',
                time: Math.max(0, Math.min(totalDuration, at)),
                weight: 5,
            });
        }
    }
    if (!candidates.length && totalDuration > 0) {
        candidates.push(
            { id: 'timeline', phase: 'opening', time: Math.min(0.5, totalDuration * 0.08), weight: 2 },
            { id: 'timeline', phase: 'middle', time: totalDuration * 0.5, weight: 1 },
            { id: 'timeline', phase: 'ending', time: Math.max(0, totalDuration - 0.25), weight: 1 }
        );
    }

    const seen = new Set();
    return candidates
        .sort((left, right) => right.weight - left.weight || left.time - right.time)
        .map(({ weight, ...candidate }) => ({
            ...candidate,
            time: Number(Math.max(0, candidate.time).toFixed(3)),
        }))
        .filter((candidate) => {
            const key = candidate.time.toFixed(2);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, Math.max(1, Math.min(6, Number(limit) || 4)));
}

function analyzePngFrame(filePath) {
    const image = PNG.sync.read(fs.readFileSync(filePath));
    const pixelCount = image.width * image.height;
    if (!pixelCount) throw new Error('Rendered frame has no pixels');
    const step = Math.max(1, Math.floor(Math.sqrt(pixelCount / 180_000)));
    let samples = 0;
    let visible = 0;
    let dark = 0;
    let bright = 0;
    let sum = 0;
    let sumSquares = 0;
    for (let y = 0; y < image.height; y += step) {
        for (let x = 0; x < image.width; x += step) {
            const offset = (y * image.width + x) * 4;
            const alpha = image.data[offset + 3] / 255;
            samples++;
            if (alpha < 0.02) continue;
            visible++;
            const luma = (
                image.data[offset] * 0.2126
                + image.data[offset + 1] * 0.7152
                + image.data[offset + 2] * 0.0722
            ) * alpha;
            sum += luma;
            sumSquares += luma * luma;
            if (luma <= 8) dark++;
            if (luma >= 247) bright++;
        }
    }
    const divisor = Math.max(1, visible);
    const meanLuma = sum / divisor;
    const variance = Math.max(0, (sumSquares / divisor) - meanLuma * meanLuma);
    return {
        width: image.width,
        height: image.height,
        visibleRatio: Number((visible / Math.max(1, samples)).toFixed(4)),
        darkRatio: Number((dark / divisor).toFixed(4)),
        brightRatio: Number((bright / divisor).toFixed(4)),
        meanLuma: Number(meanLuma.toFixed(2)),
        lumaStdDev: Number(Math.sqrt(variance).toFixed(2)),
    };
}

function _localFrameReview(files) {
    const findings = [];
    const frames = files.map((entry, index) => {
        let metrics = null;
        try {
            if (path.extname(entry.file).toLowerCase() === '.png') {
                metrics = analyzePngFrame(entry.file);
                if (metrics.visibleRatio < 0.05) {
                    findings.push({
                        severity: 'error',
                        code: 'transparent-frame',
                        frameIndex: index,
                        message: `Proof frame ${index + 1} is almost fully transparent.`,
                    });
                } else if (metrics.darkRatio > 0.995 && metrics.lumaStdDev < 2) {
                    findings.push({
                        severity: 'warning',
                        code: 'near-black-frame',
                        frameIndex: index,
                        message: `Proof frame ${index + 1} is nearly uniform black and needs visual review.`,
                    });
                } else if (metrics.brightRatio > 0.995 && metrics.lumaStdDev < 2) {
                    findings.push({
                        severity: 'warning',
                        code: 'near-white-frame',
                        frameIndex: index,
                        message: `Proof frame ${index + 1} is nearly uniform white and needs visual review.`,
                    });
                }
            }
        } catch (error) {
            findings.push({
                severity: 'error',
                code: 'unreadable-frame',
                frameIndex: index,
                message: `Proof frame ${index + 1} could not be inspected: ${_compactText(error.message, 180)}`,
            });
        }
        return {
            id: entry.id,
            phase: entry.phase,
            time: Number(entry.time) || 0,
            file: entry.file,
            metrics,
        };
    });
    const hard = findings.filter((finding) => finding.severity === 'error').length;
    return {
        status: hard === frames.length && frames.length ? 'block' : (findings.length ? 'warn' : 'pass'),
        findings,
        frames,
    };
}

function _publicManifests(scope) {
    return registry.listManifests()
        .filter((manifest) => manifest.scopes.includes(scope?.kind))
        .map((manifest) => ({
            id: manifest.id,
            specialist: manifest.specialist,
            description: manifest.description,
            tools: (manifest.tools || []).filter((tool) => (
                tool.visualRepair === true
                && tool.action === tool.canonicalAction
            )).map(_visualRepairTool),
            scopes: manifest.scopes,
            vocabulary: manifest.vocabulary || {},
        }))
        .filter((manifest) => manifest.tools.length);
}

async function _reviewWithVision({
    files,
    localReview,
    request,
    scope,
    operations,
    plan,
}) {
    let provider;
    try {
        provider = require('../../brain/ai-provider');
    } catch (_) {
        return {
            available: false,
            verdict: localReview.status === 'block' ? 'block' : 'pass',
            summary: 'Vision provider unavailable; local rendered-frame checks completed.',
            findings: localReview.findings,
            invocations: [],
        };
    }
    if (!provider.isVisionAIAvailable()) {
        return {
            available: false,
            verdict: localReview.status === 'block' ? 'block' : 'pass',
            summary: 'Vision provider unavailable; local rendered-frame checks completed.',
            findings: localReview.findings,
            invocations: [],
        };
    }

    const frames = files.slice(0, 4).map((entry) => ({
        base64: fs.readFileSync(entry.file).toString('base64'),
        mimeType: path.extname(entry.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
        timestamp: entry.time,
    }));
    const prompt = `You are the rendered-frame Quality Observer inside an autonomous professional video editor.

The user approved this exact edit:
${String(request?.originalText || request?.text || '')}

Approved scope:
${JSON.stringify(scope)}

Completed specialist work:
${JSON.stringify((operations || []).map((operation) => ({
        capabilityId: operation.capabilityId,
        specialist: operation.specialist,
        action: operation.action,
        description: operation.description,
    })))}

Proof-frame labels and local pixel metrics:
${JSON.stringify(localReview.frames.map((frame, index) => ({
        frameIndex: index,
        id: frame.id,
        phase: frame.phase,
        time: frame.time,
        metrics: frame.metrics,
    })))}

Live repair capabilities:
${JSON.stringify(_publicManifests(scope))}

First verify that the user's approved visible outcome is actually present in
the rendered proof. A metadata/property update with no perceptible result is
not proof of success. If the requested effect is present but too weak to
visibly satisfy an explicit corrective request, propose only the smallest
declared property/intensity repair that preserves everything else.

Then judge clear production defects visible in the supplied proof frames:
- blank, missing, broken, or incorrectly framed media
- clipped, unreadable, or low-contrast text against the actual footage
- accidental graphic collisions or unsafe placement
- extreme visual effects that destroy legibility
- broken transition frames
- motion/zoom that exposes black borders or visibly harms composition

Do not redesign good work. Preserve copy, facts, story, media choice, colors, theme, audio, and pacing unless the user's request explicitly changed them.
If a safe repair is needed, return at most 2 invocations using only the declared live capability ids, tool actions, and argument schemas. Never replace media, rewrite text, restructure pacing, disable captions, hide clips, or broaden the scope.
Use "block" only for a clear severe defect that cannot be safely repaired with the declared capabilities.

Return strict JSON:
{
  "verdict": "pass|repair|block",
  "summary": "short evidence-based result",
  "findings": [
    {
      "severity": "info|warning|error",
      "frameIndex": 0,
      "code": "short-code",
      "message": "concrete visible issue"
    }
  ],
  "invocations": [
    {
      "capabilityId": "declared id",
      "action": "declared tool action",
      "args": {},
      "description": "safe repair"
    }
  ]
}`;
    try {
        const raw = await provider.callVideoAI(prompt, frames, {
            maxTokens: 1_200,
            taskType: 'editor-visual-qa',
        });
        const { parseJsonObject } = require('../../brain/strict-json');
        const parsed = parseJsonObject(raw);
        const verdict = ['pass', 'repair', 'block'].includes(parsed?.verdict)
            ? parsed.verdict
            : 'pass';
        return {
            available: true,
            verdict,
            summary: _compactText(parsed?.summary || '', 700),
            findings: (Array.isArray(parsed?.findings) ? parsed.findings : [])
                .slice(0, 12)
                .map((finding) => ({
                    severity: ['info', 'warning', 'error'].includes(finding?.severity)
                        ? finding.severity
                        : 'warning',
                    frameIndex: Math.max(0, Math.min(files.length - 1, Number(finding?.frameIndex) || 0)),
                    code: _safeToken(finding?.code, 'visual-finding').slice(0, 80),
                    message: _compactText(finding?.message, 500),
                }))
                .filter((finding) => finding.message),
            invocations: Array.isArray(parsed?.invocations)
                ? parsed.invocations.slice(0, 2)
                : [],
        };
    } catch (error) {
        return {
            available: true,
            verdict: localReview.status === 'block' ? 'block' : 'pass',
            summary: `Vision critique was unavailable after rendering: ${_compactText(error.message, 240)}`,
            findings: localReview.findings,
            invocations: [],
            error: _compactText(error.message, 500),
        };
    }
}

function _normalizeRepairOperations(invocations, context) {
    const operations = [];
    const rejected = [];
    for (const [index, invocation] of (invocations || []).entries()) {
        const capabilityId = String(invocation?.capabilityId || invocation?.capability || '');
        const action = String(invocation?.action || '');
        if (!_isSafeRepairAction(capabilityId, action)) {
            rejected.push(`${capabilityId || 'unknown'}:${action || 'unknown'} is not an allowed visual repair`);
            continue;
        }
        const boundedInvocation = _boundedRepairInvocation(
            invocation,
            capabilityId,
            action
        );
        const normalized = registry.tryNormalizeInvocation(boundedInvocation, {
            request: context.request,
            plan: context.plan,
            existingOperations: context.existingOperations,
            log: context.log,
        });
        if (!normalized.operation) {
            rejected.push(_compactText(normalized.error?.message, 240));
            continue;
        }
        let scoped;
        try {
            scoped = registry.validateOperation({
                ...normalized.operation,
                operationId: `visual-repair-${context.pass}-${index + 1}`,
                scope: _clone(context.request.scope),
                description: _compactText(
                    boundedInvocation.description || normalized.operation.description,
                    500
                ),
            }, {
                request: { scope: context.request.scope },
            });
        } catch (error) {
            rejected.push(_compactText(error.message, 240));
            continue;
        }
        if ((RISK_WEIGHT[scoped.risk] ?? 1) > RISK_WEIGHT.moderate) {
            rejected.push(`${scoped.specialist} proposed a repair above the allowed risk`);
            continue;
        }
        operations.push(scoped);
    }
    return { operations, rejected };
}

function _persistEvidence(projectDir, transactionId, pass, frames) {
    if (!projectDir || !frames.length) return [];
    const root = path.resolve(projectDir, '.yta', 'agent', 'visual-evidence');
    if (!_inside(projectDir, root)) return [];
    fs.mkdirSync(root, { recursive: true });
    const evidenceDir = path.join(root, `${_safeToken(transactionId)}-pass-${pass}`);
    _removeContained(root, evidenceDir);
    fs.mkdirSync(evidenceDir, { recursive: true });
    const saved = [];
    for (const [index, frame] of frames.entries()) {
        const ext = ['.png', '.jpg', '.jpeg'].includes(path.extname(frame.file).toLowerCase())
            ? path.extname(frame.file).toLowerCase()
            : '.png';
        const filename = `frame-${String(index + 1).padStart(2, '0')}${ext}`;
        const target = path.join(evidenceDir, filename);
        fs.copyFileSync(frame.file, target);
        saved.push({
            id: frame.id,
            phase: frame.phase,
            time: frame.time,
            relativePath: path.relative(projectDir, target),
            metrics: frame.metrics,
        });
    }
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({
                name: entry.name,
                path: path.join(root, entry.name),
                mtime: fs.statSync(path.join(root, entry.name)).mtimeMs,
            }))
            .sort((left, right) => right.mtime - left.mtime);
        for (const stale of entries.slice(12)) _removeContained(root, stale.path);
    } catch (_) { }
    return saved;
}

async function runVisualObserver({
    beforePlan,
    plan,
    request,
    operations,
    transactionId,
    pass = 1,
    options = {},
}) {
    if (!shouldRunVisualQa({ effort: request?.effort, operations, options })) {
        return {
            status: 'skipped',
            verdict: 'pass',
            reason: request?.effort === 'smart' ? 'no-visual-operations' : 'fast-mode',
            frameCount: 0,
            frames: [],
            findings: [],
            repairOperations: [],
            rejectedRepairs: [],
        };
    }
    if (!options.projectDir || !options.appRoot) {
        return {
            status: 'skipped',
            verdict: 'pass',
            reason: 'render-context-unavailable',
            frameCount: 0,
            frames: [],
            findings: [],
            repairOperations: [],
            rejectedRepairs: [],
        };
    }

    const dependencies = options.visualQaDeps || {};
    const generateProject = dependencies.generateProject || generateHyperframesProject;
    const captureSnapshots = dependencies.captureSnapshots || captureProofSnapshots;
    const reviewFrames = dependencies.reviewFrames || _reviewWithVision;
    const renderPlan = _clone(plan);
    const proof = representativeProofTimes(beforePlan, plan, request.scope, operations, 4);
    const projectRoot = path.resolve(options.projectDir);
    const runRoot = path.resolve(
        projectRoot,
        '.yta',
        'agent',
        'visual-runs',
        `${_safeToken(transactionId)}-pass-${pass}`
    );
    if (!_inside(projectRoot, runRoot)) {
        throw new Error('Visual QA run path escaped the project');
    }
    fs.mkdirSync(runRoot, { recursive: true });

    let generated = null;
    try {
        options.progress?.(
            'visual-render',
            `Rendering ${proof.length} representative proof frame${proof.length === 1 ? '' : 's'}...`,
            pass === 1 ? 86 : 93
        );
        if (!dependencies.generateProject) {
            await authorPlanCompositions(renderPlan, {
                projectDir: options.projectDir,
                openMode: true,
                log: (message) => options.log?.(`[Visual QA]${message}`),
            });
        }
        generated = await generateProject({
            plan: renderPlan,
            projectDir: options.projectDir,
            appRoot: options.appRoot,
            tempDir: options.tempDir,
            publicDir: options.publicDir,
            inputDir: options.inputDir,
            outputRoot: runRoot,
            options: {
                agentVisualQa: true,
                transactionId,
                pass,
            },
        });
        const cli = dependencies.cli || resolveHyperframesCli(options.appRoot);
        const manifest = generated?.motionManifestPath && fs.existsSync(generated.motionManifestPath)
            ? JSON.parse(fs.readFileSync(generated.motionManifestPath, 'utf8'))
            : {};
        _assertRenderedContracts(beforePlan, renderPlan, operations, manifest);
        const snapshots = await captureSnapshots({
            cli,
            projectDir: generated.projectDir,
            appRoot: options.appRoot,
            manifest,
            proof,
            browserPath: options.browserPath,
            onProcess: options.onProcess,
            isCancelled: options.isCancelled,
        });
        if (!snapshots?.files?.length) {
            return {
                status: 'skipped',
                verdict: 'pass',
                reason: _compactText(
                    snapshots?.result?.stderr
                    || snapshots?.result?.stdout
                    || 'proof-frame-capture-unavailable',
                    500
                ),
                frameCount: 0,
                frames: [],
                findings: [],
                repairOperations: [],
                rejectedRepairs: [],
            };
        }

        const localReview = _localFrameReview(snapshots.files);
        options.progress?.(
            'visual-critique',
            'Inspecting rendered proof frames for framing, collisions, legibility, and broken motion...',
            pass === 1 ? 89 : 96
        );
        const review = await reviewFrames({
            files: snapshots.files,
            localReview,
            request,
            scope: request.scope,
            operations,
            plan: renderPlan,
        });
        const normalized = _normalizeRepairOperations(review.invocations, {
            request,
            plan,
            existingOperations: operations,
            pass,
            log: options.log,
        });
        const frames = _persistEvidence(
            options.projectDir,
            transactionId,
            pass,
            localReview.frames
        );
        const findings = [
            ...localReview.findings,
            ...(review.available ? review.findings || [] : []),
        ].filter((finding, index, all) => (
            all.findIndex((candidate) => (
                candidate.code === finding.code
                && candidate.frameIndex === finding.frameIndex
                && candidate.message === finding.message
            )) === index
        ));
        const verdict = review.verdict === 'block' || localReview.status === 'block'
            ? 'block'
            : normalized.operations.length
                ? 'repair'
                : review.verdict === 'repair'
                    ? ((review.findings || []).length
                        ? 'warn'
                        : 'pass')
                    : 'pass';
        return {
            status: verdict,
            verdict,
            pass,
            visionUsed: review.available === true,
            summary: review.summary || (
                verdict === 'pass'
                    ? 'Rendered proof frames passed visual inspection.'
                    : 'Rendered proof frames need attention.'
            ),
            frameCount: frames.length,
            frames,
            findings,
            repairOperations: normalized.operations,
            rejectedRepairs: normalized.rejected,
        };
    } catch (error) {
        if (error?.code === 'AGENT_RENDER_CONTRACT_FAILED') {
            const findings = (error.failures || [error.message]).map((message) => ({
                severity: 'error',
                code: 'render-contract-mismatch',
                frameIndex: 0,
                message: _compactText(message, 500),
            }));
            return {
                status: 'block',
                verdict: 'block',
                reason: _compactText(error.message, 500),
                summary: `The generated preview did not contain the requested edit: ${_compactText(error.message, 300)}`,
                frameCount: 0,
                frames: [],
                findings,
                repairOperations: [],
                rejectedRepairs: [],
            };
        }
        return {
            status: 'skipped',
            verdict: 'pass',
            reason: _compactText(error.message, 500),
            summary: `Rendered-frame inspection could not run: ${_compactText(error.message, 300)}`,
            frameCount: 0,
            frames: [],
            findings: [],
            repairOperations: [],
            rejectedRepairs: [],
        };
    } finally {
        _removeContained(projectRoot, runRoot);
    }
}

module.exports = {
    _renderContractFailures,
    analyzePngFrame,
    representativeProofTimes,
    runVisualObserver,
    shouldRunVisualQa,
};
