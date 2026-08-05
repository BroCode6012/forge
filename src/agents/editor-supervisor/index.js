'use strict';

const crypto = require('crypto');
const { directivesFloor } = require('../../directives/directive-compiler');
const { previewOrder, applyOrderToPlan, hasActions } = require('../../directives/directive-actuator');
const { sendMessageWithProject } = require('../../studio/qa-chat-agent');
const { normalizeAgentRequest, normalizePlanId, normalizeScope } = require('./schemas');
const { normalizeEffectDirective } = require('../../directives/effect-preset');
const { planStagedOperations } = require('./operation-planner');
const { executeCapabilityOperation, inspectCapabilities } = require('./capabilities/registry');
const { buildOperationGraph, rebaseScopeAfterStructuralEdit } = require('./operation-graph');
const { hasMeaningfulChange, summarizePlanDiff } = require('./plan-diff');
const { runQualityLoop } = require('./quality-loop');
const { cleanupStage } = require('./transaction-assets');
const { runAutonomousOperations } = require('./autonomous-runner');
const { runVisualObserver } = require('./visual-observer');
const { verifyStableScopeTargets } = require('./scope-utils');
const {
    groundVisualRequest,
    publicVisualGrounding,
} = require('./visual-grounding');

const PLAN_TTL_MS = 15 * 60 * 1000;
const plannedEdits = new Map();

function _clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function _hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function _visualHash(plan) {
    const copy = _clone(plan);
    if (copy?.scriptContext) delete copy.scriptContext._directives;
    for (const scene of (copy?.scenes || [])) {
        if (scene && typeof scene === 'object') delete scene._directiveLock;
    }
    return _hash(copy);
}

function _cleanupPlans(now = Date.now()) {
    for (const [id, plan] of plannedEdits) {
        if (now - plan.createdAt > PLAN_TTL_MS) plannedEdits.delete(id);
    }
}

function _projectContext(plan, scope) {
    const scriptContext = plan?.scriptContext || {};
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    return {
        title: scriptContext.videoTitle || scriptContext.title || plan?.title || '',
        nicheId: scriptContext.nicheId || scriptContext.niche || '',
        format: scriptContext.format || plan?.format || '',
        themeId: scriptContext.themeId || '',
        language: scriptContext.language || '',
        entities: Array.isArray(scriptContext.entities) ? scriptContext.entities.slice(0, 80) : [],
        totalScenes: scenes.length,
        totalDuration: Number(plan?.totalDuration) || Math.max(0, ...scenes.map((scene) => Number(scene.endTime) || 0)),
        activeScope: scope,
        sceneList: scenes.slice(0, 300).map((scene, fallbackIndex) => ({
            i: Number.isFinite(Number(scene.index)) ? Number(scene.index) : fallbackIndex,
            type: scene.mediaType || scene.sourceHint || 'media',
            keyword: scene.keyword || scene.searchKeyword || '',
            text: String(scene.text || '').slice(0, 300),
            startTime: Number(scene.startTime) || 0,
            endTime: Number(scene.endTime) || 0,
            dur: `${Math.max(0, (Number(scene.endTime) || 0) - (Number(scene.startTime) || 0)).toFixed(1)}s`,
        })),
        qaResults: Array.isArray(plan?.qaResults) ? plan.qaResults.slice(0, 300) : [],
        editorInspection: inspectCapabilities(plan, scope),
    };
}

function _inspectionSummary(inspection, scope) {
    const capabilityIds = Object.keys(inspection || {});
    const targetCounts = capabilityIds
        .map((id) => Number(inspection?.[id]?.targetCount ?? inspection?.[id]?.sceneCount))
        .filter(Number.isFinite);
    return {
        scope: scope?.label || scope?.kind || 'Whole project',
        capabilityIds,
        targetCount: targetCounts.length ? Math.max(...targetCounts) : 0,
    };
}

function _compactScope(scope) {
    return {
        kind: scope?.kind || 'project',
        label: scope?.label || 'Whole project',
        fromSec: Number(scope?.fromSec) || 0,
        toSec: Number(scope?.toSec) || 0,
        targetCount: Math.max(
            Number(scope?.clipRefs?.length) || 0,
            Number(scope?.visualRefs?.length) || 0,
            Number(scope?.iconRefs?.length) || 0
        ),
    };
}

function _scopeTargets(scope) {
    if (scope.kind === 'clips' && scope.clipRefs.length) {
        return scope.clipRefs.map((clip) => ({
            kind: 'range',
            from: clip.startTime,
            to: Math.max(clip.endTime, clip.startTime + 0.001),
        }));
    }
    if ((scope.kind === 'range' || scope.kind === 'playhead') && scope.toSec > scope.fromSec) {
        return [{ kind: 'range', from: scope.fromSec, to: scope.toSec }];
    }
    return [];
}

function _copyMetadata(directives) {
    return {
        raw: directives.raw,
        summary: directives.summary,
        overrideHouseRules: true,
    };
}

function _addUnique(list, message) {
    if (message && !list.includes(message)) list.push(message);
}

function _safePerSceneEntries(entries, supported, unsupported) {
    const safeEntries = [];
    for (const entry of (Array.isArray(entries) ? entries : [])) {
        const source = entry?.set || {};
        const set = {};
        if (source.framing) {
            set.framing = source.framing;
            _addUnique(supported, 'explicit scene framing');
        }
        if (source.transition?.type === 'cut' || source.transition?.type === 'none') {
            set.transition = { type: 'cut', duration: 0 };
            _addUnique(supported, 'explicit hard cuts');
        } else if (source.transition) {
            _addUnique(unsupported, 'Only hard-cut scene transitions are safe in the current Agent executor.');
        }
        const effect = normalizeEffectDirective(source.effect);
        if (Object.keys(effect).length) {
            set.effect = effect;
            _addUnique(supported, 'explicit scene look adjustment');
        } else if (source.effect) {
            _addUnique(unsupported, 'That scene effect is not supported by the current render-safe effect vocabulary.');
        }

        for (const field of ['fullscreenMG', 'templateHint']) {
            if (source[field]) {
                _addUnique(unsupported, 'Generating or replacing scene graphics needs the staged visual-generation worker.');
            }
        }
        for (const field of ['mediaType', 'sourceHint', 'keyword']) {
            if (source[field]) {
                _addUnique(unsupported, 'Scene media/search changes need the staged footage replacement worker.');
            }
        }
        if (entry?.remove?.length) {
            _addUnique(unsupported, 'Free-form scene-field removal is not enabled because it can invalidate the render plan.');
        }
        if (Object.keys(set).length) {
            safeEntries.push({
                when: _clone(entry.when),
                set,
                raw: entry.raw,
            });
        }
    }
    return safeEntries;
}

function _hasRenderableMedia(scene) {
    return [
        scene?.mediaFile,
        scene?.mediaPath,
        scene?.localPath,
        scene?.videoFile,
        scene?.videoPath,
        scene?.imageFile,
        scene?.imagePath,
        scene?.assetFile,
        scene?.assetPath,
    ].some(Boolean);
}

function _stageType(value) {
    return String(value || '').split(':')[0].trim().toLowerCase();
}

function _applyPlanSafety(scoped, plan) {
    if (!scoped.directives) return scoped;
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);

    if (scoped.directives.maps?.want === 'none') {
        const unsafeMaps = scenes.filter((scene) => (
            /map/i.test(_stageType(scene.fullscreenMG || scene.templateHint))
            && !_hasRenderableMedia(scene)
        ));
        if (unsafeMaps.length) {
            delete scoped.directives.maps;
            scoped.supported = scoped.supported.filter((item) => item !== 'map removal');
            _addUnique(
                scoped.unsupported,
                `${unsafeMaps.length} map-only scene${unsafeMaps.length === 1 ? '' : 's'} need replacement footage before their maps can be removed safely.`
            );
        }
    }

    const bannedTypes = scoped.directives.graphics?.bannedTypes || [];
    if (bannedTypes.length) {
        const banned = new Set(bannedTypes.map((type) => String(type).toLowerCase()));
        const unsafeGraphics = scenes.filter((scene) => (
            banned.has(_stageType(scene.fullscreenMG))
            || banned.has(_stageType(scene.templateHint))
        ) && !_hasRenderableMedia(scene));
        if (unsafeGraphics.length) {
            delete scoped.directives.graphics;
            scoped.supported = scoped.supported.filter((item) => item !== 'graphic-type removal');
            _addUnique(
                scoped.unsupported,
                `${unsafeGraphics.length} graphic-only scene${unsafeGraphics.length === 1 ? '' : 's'} need replacement media before that graphic type can be removed safely.`
            );
        }
    }

    if (!hasActions(scoped.directives)) scoped.directives = null;
    return scoped;
}

function _scopeDirectives(directives, scope, plan) {
    const supported = [];
    const unsupported = [];
    const scoped = _copyMetadata(directives);

    if (scope.kind === 'visual') {
        if (!hasActions(directives)) {
            return {
                directives: null,
                supported,
                unsupported,
            };
        }
        return {
            directives: null,
            supported,
            unsupported: ['That direct motion-graphic request could not be mapped to a safe in-place edit.'],
        };
    }

    if (scope.kind === 'project') {
        if (directives.transitions?.style === 'hard-cuts' || directives.transitions?.banned?.length) {
            scoped.transitions = {
                ...(directives.transitions.style === 'hard-cuts' ? { style: 'hard-cuts' } : {}),
                ...(directives.transitions.banned?.length ? { banned: [...directives.transitions.banned] } : {}),
            };
            supported.push('hard cuts');
        } else if (directives.transitions) {
            unsupported.push('Motivated transition generation could not be safely staged for this request.');
        }
        if (directives.framing?.force) {
            scoped.framing = { force: directives.framing.force };
            supported.push('framing');
        } else if (directives.framing) {
            unsupported.push('That framing request did not resolve to fullscreen, cinematic, or floating.');
        }
        if (directives.effects) {
            const effect = normalizeEffectDirective(directives.effects);
            if (Object.keys(effect).length) {
                scoped.effects = effect;
                supported.push('render look');
            }
            if (directives.effects.era) {
                unsupported.push('That era-look request could not be safely staged for this scope.');
            }
        }
        if (directives.maps?.want === 'none') {
            scoped.maps = { want: 'none' };
            supported.push('map removal');
        } else if (directives.maps) {
            unsupported.push('Adding or increasing maps requires a generated-media transaction.');
        }
        if (directives.icons?.allow === false) {
            scoped.icons = { allow: false };
            supported.push('icon removal');
        } else if (directives.icons) {
            unsupported.push('Selective icon placement could not be safely staged for this request.');
        }
        if (directives.graphics?.bannedTypes?.length) {
            scoped.graphics = { bannedTypes: [...directives.graphics.bannedTypes] };
            supported.push('graphic-type removal');
        }
        if (directives.graphics && (
            directives.graphics.moreTemplates
            || directives.graphics.fewerTemplates
            || directives.graphics.moreMGs
            || directives.graphics.fewerMGs
            || directives.graphics.numericTreatment
        )) {
            unsupported.push('That graphic generation request could not be safely staged for this scope.');
        }
        if (Array.isArray(directives.perScene) && directives.perScene.length) {
            const entries = _safePerSceneEntries(directives.perScene, supported, unsupported);
            if (entries.length) scoped.perScene = entries;
        }
    } else {
        const set = {};
        if (directives.transitions?.style === 'hard-cuts') {
            set.transition = { type: 'cut', duration: 0 };
            supported.push('hard cuts');
        } else if (directives.transitions) {
            unsupported.push('This transition request cannot yet be translated to a safe scoped edit.');
        }
        if (directives.framing?.force) {
            set.framing = directives.framing.force;
            supported.push(`${directives.framing.force} framing`);
        }
        const effect = normalizeEffectDirective(directives.effects);
        if (Object.keys(effect).length) {
            set.effect = effect;
            supported.push('scoped look adjustment');
        } else if (directives.effects) {
            unsupported.push('That look request needs the effects-planning worker; it was not included.');
        }
        if (directives.maps) unsupported.push('That scoped map edit could not be safely staged.');
        if (directives.icons) unsupported.push('That scoped icon edit could not be safely staged.');
        if (directives.graphics) unsupported.push('That scoped graphic edit could not be safely staged.');
        if (Array.isArray(directives.perScene) && directives.perScene.length) {
            unsupported.push('Explicit time/scene instructions cannot be combined with an active selection yet.');
        }

        const targets = _scopeTargets(scope);
        if (Object.keys(set).length && targets.length) {
            scoped.perScene = targets.map((when) => ({
                when,
                set: _clone(set),
                raw: directives.raw,
            }));
        } else if (Object.keys(set).length) {
            unsupported.push('The active editor scope has no usable timeline range.');
        }
    }

    if (directives.pacing) {
        unsupported.push('That pacing request could not be safely staged as a structural edit.');
    }
    if (directives.footage) {
        unsupported.push('That footage request could not be safely staged as a media transaction.');
    }

    const actionable = hasActions(scoped);
    return _applyPlanSafety({
        directives: actionable ? scoped : null,
        supported,
        unsupported,
    }, plan);
}

function _newPlanId() {
    return `agent-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function _mergeNumericStats(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        if (!Number.isFinite(Number(value))) continue;
        target[key] = (Number(target[key]) || 0) + Number(value);
    }
}

function _mergeAssetManifest(current, incoming) {
    if (!incoming) return current;
    if (!current) return incoming;
    if (
        String(current.transactionId || '') !== String(incoming.transactionId || '')
        || String(current.stagingRoot || '') !== String(incoming.stagingRoot || '')
        || String(current.finalRoot || '') !== String(incoming.finalRoot || '')
    ) {
        throw new Error('Specialist asset stages do not belong to one Agent transaction');
    }
    const assets = new Map();
    for (const asset of [...(current.assets || []), ...(incoming.assets || [])]) {
        assets.set(String(asset.finalPath || asset.relativePath || asset.filename), asset);
    }
    return {
        ...current,
        assets: [...assets.values()],
    };
}

function _mergeRange(current, incoming) {
    if (!incoming) return current;
    const fromSec = Number(incoming.fromSec);
    const toSec = Number(incoming.toSec);
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) return current;
    if (!current) return { fromSec, toSec };
    return {
        fromSec: Math.min(current.fromSec, fromSec),
        toSec: Math.max(current.toSec, toSec),
    };
}

function _mergeQualityReports(first, second) {
    if (!first) return second || null;
    if (!second) return first;
    const firstPasses = Array.isArray(first.repairPasses) ? first.repairPasses : [];
    const secondPasses = Array.isArray(second.repairPasses) ? second.repairPasses : [];
    return {
        ...second,
        repairPasses: [
            ...firstPasses,
            ...secondPasses.map((pass, index) => ({
                ...pass,
                pass: firstPasses.length + index + 1,
            })),
        ],
        automaticRepairCount: (Number(first.automaticRepairCount) || 0)
            + (Number(second.automaticRepairCount) || 0),
    };
}

function _visualQaRollup(passes, repairCount = 0) {
    const list = (passes || []).filter(Boolean);
    const latest = list[list.length - 1] || {
        status: 'skipped',
        verdict: 'pass',
        frameCount: 0,
        frames: [],
        findings: [],
    };
    const unresolvedRepair = latest.status === 'repair';
    return {
        ...latest,
        status: unresolvedRepair ? 'warn' : latest.status,
        passes: list.map((pass) => ({
            pass: pass.pass,
            status: pass.status,
            verdict: pass.verdict,
            visionUsed: pass.visionUsed === true,
            summary: pass.summary || '',
            reason: pass.reason || '',
            frameCount: Number(pass.frameCount) || 0,
            findingCount: Array.isArray(pass.findings) ? pass.findings.length : 0,
            repairCount: Array.isArray(pass.repairOperations) ? pass.repairOperations.length : 0,
        })),
        totalFramesChecked: list.reduce((sum, pass) => sum + (Number(pass.frameCount) || 0), 0),
        repairCount,
    };
}

function _publicSummary(value, request) {
    const summary = String(value || '')
        .split(/\n\s*\nEditing context:/i)[0]
        .trim();
    return summary || request.originalText || request.text;
}

async function planRequest(payload, current) {
    _cleanupPlans();
    const request = normalizeAgentRequest(payload);
    const plan = current?.plan;
    if (!plan || !Array.isArray(plan.scenes)) {
        const error = new Error('Open a generated project before using the editor Agent');
        error.code = 'AGENT_NO_PROJECT';
        throw error;
    }
    const visualGrounding = await groundVisualRequest(request, plan, {
        log: (message) => console.log(`[Editor Agent] ${message}`),
    });
    request.visualGrounding = visualGrounding;
    const groundingPublic = publicVisualGrounding(visualGrounding);

    let compiled;
    if (request.effort === 'fast') {
        const directives = directivesFloor(request.text);
        compiled = {
            directives,
            summary: directives?.summary || request.text,
            hasActions: hasActions(directives),
        };
    } else {
        const scriptContext = plan.scriptContext || {};
        compiled = await previewOrder(request.text, {
            themeId: scriptContext.themeId,
            nicheId: scriptContext.nicheId,
            productionMode: scriptContext.productionMode,
        });
    }

    const inspection = inspectCapabilities(plan, request.scope);
    const staged = await planStagedOperations(compiled.directives, request, plan, {
        visualGrounding,
    });
    const operationGraph = buildOperationGraph(staged.operations);
    const operations = operationGraph.operations;
    const looksLikeEdit = compiled.hasActions
        || !!compiled.directives?.pacing
        || operations.length > 0
        || staged.supported.length > 0
        || staged.unsupported.length > 0;
    if (!looksLikeEdit) {
        if (visualGrounding.required === true) {
            return {
                kind: 'edit',
                executable: false,
                summary: visualGrounding.summary || request.originalText || request.text,
                supported: [],
                unsupported: [visualGrounding.message || 'The visible reference could not be identified safely.'],
                scope: request.scope,
                effort: request.effort,
                contextResolution: request.contextResolution,
                visualGrounding: groundingPublic,
            };
        }
        const history = request.history.length
            ? request.history
            : [{ role: 'user', text: request.text }];
        const answer = await sendMessageWithProject(history, _projectContext(plan, request.scope));
        return {
            kind: 'answer',
            answer,
            scope: request.scope,
            effort: request.effort,
            contextResolution: request.contextResolution,
            visualGrounding: groundingPublic,
        };
    }

    const scoped = _scopeDirectives(staged.directives, request.scope, plan);
    const supported = [...new Set([...(staged.supported || []), ...(scoped.supported || [])])];
    const unsupported = [...new Set([...(staged.unsupported || []), ...(scoped.unsupported || [])])];
    const summary = _publicSummary(
        staged.summary || compiled.summary || request.originalText || request.text,
        request
    );
    if (!scoped.directives && !operations.length) {
        return {
            kind: 'edit',
            executable: false,
            summary,
            supported,
            unsupported,
            scope: request.scope,
            effort: request.effort,
            contextResolution: request.contextResolution,
            visualGrounding: groundingPublic,
        };
    }

    {
        const previewDraft = _clone(plan);
        let hasExternalOperation = false;
        let previewStructuralRange = null;
        const previewResult = await applyOrderToPlan(previewDraft, scoped.directives, { log: () => { } });
        if (previewResult.needsFootage?.length && !operations.some((operation) => operation.capabilityId === 'media')) {
            return {
                kind: 'edit',
                executable: false,
                summary,
                supported: [],
                unsupported: [
                    ...unsupported,
                    'This request needs footage replacement, so no partial edit was prepared.',
                ],
                scope: request.scope,
                effort: request.effort,
                contextResolution: request.contextResolution,
                visualGrounding: groundingPublic,
            };
        }
        for (const operation of operations) {
            if (operation.risk === 'expensive') {
                hasExternalOperation = true;
                continue;
            }
            try {
                const effectiveOperation = previewStructuralRange
                    ? {
                        ...operation,
                        scope: rebaseScopeAfterStructuralEdit(
                            operation.scope,
                            previewDraft,
                            previewStructuralRange
                        ),
                    }
                    : operation;
                const specialistResult = await executeCapabilityOperation(previewDraft, effectiveOperation, {
                    effort: request.effort,
                    preview: true,
                    log: () => { },
                });
                previewStructuralRange = _mergeRange(
                    previewStructuralRange,
                    specialistResult.structuralRange
                );
            } catch (error) {
                if (/\balready\b|\bsatisf(?:y|ied)\b/i.test(String(error.message || ''))) continue;
                return {
                    kind: 'edit',
                    executable: false,
                    summary,
                    supported: [],
                    unsupported: [
                        ...unsupported,
                        `${operation.specialist}: ${error.message}`,
                    ],
                    scope: request.scope,
                    effort: request.effort,
                    contextResolution: request.contextResolution,
                    visualGrounding: groundingPublic,
                };
            }
        }
        if (!hasExternalOperation && _visualHash(previewDraft) === _visualHash(plan)) {
            return {
                kind: 'edit',
                executable: false,
                alreadySatisfied: true,
                summary,
                supported,
                unsupported,
                scope: request.scope,
                effort: request.effort,
                contextResolution: request.contextResolution,
                visualGrounding: groundingPublic,
            };
        }
    }

    const planId = _newPlanId();
    plannedEdits.set(planId, {
        id: planId,
        createdAt: Date.now(),
        request: request.originalText || request.text,
        resolvedRequest: request.text,
        effort: request.effort,
        scope: request.scope,
        summary,
        contextResolution: request.contextResolution,
        visualGrounding: groundingPublic,
        directives: scoped.directives,
        operations,
        operationGraph: operationGraph.stages,
        inspection: _inspectionSummary(inspection, request.scope),
        supported,
        unsupported,
        risk: staged.risk,
        estimatedWork: staged.estimatedWork,
        capabilityIds: staged.capabilityIds,
        specialists: staged.specialists,
        baseRevision: Number(current?.revision) || 0,
        basePlanHash: String(current?.planHash || _hash(plan)),
    });
    return {
        kind: 'edit',
        executable: true,
        planId,
        summary,
        supported,
        unsupported,
        scope: request.scope,
        effort: request.effort,
        contextResolution: request.contextResolution,
        visualGrounding: groundingPublic,
        risk: unsupported.length ? 'partial' : staged.risk,
        estimatedWork: staged.estimatedWork,
        operationGraph: operationGraph.stages,
        inspection: _inspectionSummary(inspection, request.scope),
        capabilityIds: staged.capabilityIds,
        specialists: staged.specialists,
        operations: operations.map((operation) => ({
            operationId: operation.operationId,
            capabilityId: operation.capabilityId,
            specialist: operation.specialist,
            action: operation.action,
            description: operation.description,
            stage: operation.stage,
            dependsOn: operation.dependsOn,
        })),
    };
}

async function executePlanned(planIdValue, current, opts = {}) {
    _cleanupPlans();
    const planId = normalizePlanId(planIdValue);
    const planned = plannedEdits.get(planId);
    if (!planned) {
        const error = new Error('Agent plan expired or no longer exists');
        error.code = 'AGENT_PLAN_EXPIRED';
        throw error;
    }
    const currentRevision = Number(current?.revision) || 0;
    const currentPlanHash = String(current?.planHash || '');
    const versionChanged = (
        currentRevision !== planned.baseRevision
        || currentPlanHash !== planned.basePlanHash
    );
    let versionRebase = null;
    if (versionChanged) {
        const rebaseCheck = opts.allowStableScopeRebase === true
            ? verifyStableScopeTargets(current?.plan, planned.scope, {
                operations: planned.operations,
            })
            : {
                safe: false,
                reason: 'stable-scope rebase was not enabled',
                targetCount: 0,
                missing: [],
                ambiguous: [],
            };
        if (!rebaseCheck.safe) {
            const error = new Error('The project changed after the Agent prepared this edit. Ask the Agent to plan it again.');
            error.code = 'AGENT_PLAN_CONFLICT';
            error.rebaseCheck = rebaseCheck;
            throw error;
        }
        versionRebase = {
            fromRevision: planned.baseRevision,
            toRevision: currentRevision,
            fromPlanHash: planned.basePlanHash,
            toPlanHash: currentPlanHash,
            targetCount: rebaseCheck.targetCount,
        };
        opts.progress?.(
            'validate',
            `Project refreshed; revalidated ${rebaseCheck.targetCount} exact scoped target${rebaseCheck.targetCount === 1 ? '' : 's'} before applying.`,
            14
        );
    }

    const beforePlan = _clone(current.plan);
    let draft = _clone(current.plan);
    const beforeVisualHash = _visualHash(beforePlan);
    let assetManifest = null;
    let operationStats = {
        pacingSplits: 0,
        pacingMerges: 0,
        mediaReplaced: 0,
        graphicsAdded: 0,
        graphicsRemoved: 0,
    };
    let operationResults = [];
    let recoveries = [];
    let decisionLog = versionRebase
        ? [{
            phase: 'version-rebase',
            status: 'revalidated',
            message: `Project revision advanced from ${versionRebase.fromRevision} to ${versionRebase.toRevision}; all ${versionRebase.targetCount} scoped target(s) still resolved exactly once.`,
        }]
        : [];
    let specialistChanged = 0;
    let structuralRange = null;
    let visualQa = null;
    let result = { changed: 0, needsFootage: [], report: null };
    try {
        if (planned.directives) {
            result = await applyOrderToPlan(draft, planned.directives, { log: opts.log });
        }
        if (result.needsFootage?.length && !planned.operations?.some((operation) => operation.capabilityId === 'media')) {
            return {
                success: false,
                blocked: true,
                error: 'This edit requires footage replacement. No media was changed.',
                needsFootage: result.needsFootage,
            };
        }

        const operations = Array.isArray(planned.operations) ? planned.operations : [];
        const autonomous = await runAutonomousOperations(draft, operations, {
            request: planned.resolvedRequest || planned.request,
            originalRequest: planned.request,
            effort: planned.effort,
            transactionId: planned.id,
            options: opts,
        });
        draft = autonomous.plan;
        assetManifest = autonomous.assetManifest;
        structuralRange = autonomous.structuralRange;
        specialistChanged = autonomous.changed;
        operationStats = {
            ...operationStats,
            ...autonomous.stats,
        };
        operationResults = autonomous.operationResults;
        recoveries = autonomous.recoveries;
        decisionLog = autonomous.decisionLog;

        opts.progress?.('quality', 'Running timeline, pacing, and render-contract checks...', 82);
        const guarded = runQualityLoop(draft, {
            beforePlan,
            scope: planned.scope,
            structural: operations.some((operation) => operation.risk === 'structural'),
            affectedRange: structuralRange,
            effort: planned.effort,
        });
        Object.keys(draft).forEach((key) => delete draft[key]);
        Object.assign(draft, guarded.plan);
        result.qualityReport = guarded.report;

        const visualRequest = {
            text: planned.resolvedRequest || planned.request,
            originalText: planned.request,
            effort: planned.effort,
            scope: planned.scope,
        };
        const visualPasses = [];
        let visualRepairCount = 0;
        let observed = await runVisualObserver({
            beforePlan,
            plan: draft,
            request: visualRequest,
            operations,
            transactionId: planned.id,
            pass: 1,
            options: opts,
        });
        visualPasses.push(observed);

        if (observed.repairOperations?.length) {
            opts.progress?.(
                'visual-repair',
                `Rendered-frame inspection found ${observed.repairOperations.length} safe repair${observed.repairOperations.length === 1 ? '' : 's'}. Applying and verifying...`,
                91
            );
            const visualAutonomous = await runAutonomousOperations(
                draft,
                observed.repairOperations,
                {
                    request: planned.resolvedRequest || planned.request,
                    originalRequest: planned.request,
                    effort: planned.effort,
                    transactionId: planned.id,
                    options: opts,
                }
            );
            draft = visualAutonomous.plan;
            assetManifest = _mergeAssetManifest(assetManifest, visualAutonomous.assetManifest);
            structuralRange = _mergeRange(structuralRange, visualAutonomous.structuralRange);
            specialistChanged += visualAutonomous.changed;
            _mergeNumericStats(operationStats, visualAutonomous.stats);
            operationResults.push(...visualAutonomous.operationResults);
            recoveries.push(...visualAutonomous.recoveries);
            decisionLog.push(...visualAutonomous.decisionLog);
            visualRepairCount += visualAutonomous.changed;

            const reguarded = runQualityLoop(draft, {
                beforePlan,
                scope: planned.scope,
                structural: false,
                affectedRange: structuralRange,
                effort: planned.effort,
            });
            draft = reguarded.plan;
            result.qualityReport = _mergeQualityReports(result.qualityReport, reguarded.report);

            observed = await runVisualObserver({
                beforePlan,
                plan: draft,
                request: visualRequest,
                operations: [...operations, ...observed.repairOperations],
                transactionId: planned.id,
                pass: 2,
                options: opts,
            });
            visualPasses.push(observed);
        }

        visualQa = _visualQaRollup(visualPasses, visualRepairCount);
        decisionLog.push({
            phase: 'visual-qa',
            status: visualQa.status,
            message: visualQa.summary
                || `Rendered-frame inspection ${visualQa.status}.`,
        });
        if (visualQa.status === 'block') {
            const error = new Error(
                visualQa.summary
                || 'Rendered-frame verification found a severe defect that could not be repaired safely'
            );
            error.code = 'AGENT_VISUAL_QA_FAILED';
            error.visualQa = visualQa;
            throw error;
        }

        if (_visualHash(draft) === beforeVisualHash) {
            cleanupStage(assetManifest, { projectDir: opts.projectDir });
            return {
                success: false,
                noChange: true,
                error: 'The requested rule is already satisfied; no visible timeline fields changed.',
            };
        }
        const finalDiff = summarizePlanDiff(beforePlan, draft, planned.scope);
        if (planned.scope?.kind !== 'project' && finalDiff.scopeLeakCount > 0) {
            const error = new Error(
                `Agent verification stopped the edit because ${finalDiff.scopeLeakCount} item(s) outside the selected scope changed`
            );
            error.code = 'AGENT_SCOPE_LEAK';
            error.diff = finalDiff;
            throw error;
        }
        result.diff = finalDiff;
    } catch (error) {
        cleanupStage(error.assetManifest || assetManifest, { projectDir: opts.projectDir });
        throw error;
    }

    plannedEdits.delete(planId);
    return {
        success: true,
        planId,
        request: planned.request,
        resolvedRequest: planned.resolvedRequest || planned.request,
        effort: planned.effort,
        summary: planned.summary,
        scope: planned.scope,
        supported: planned.supported,
        unsupported: planned.unsupported,
        beforePlan,
        plan: draft,
        assetManifest,
        qualityReport: result.qualityReport || null,
        visualQa,
        diff: result.diff || summarizePlanDiff(beforePlan, draft, planned.scope),
        inspection: planned.inspection || null,
        operationGraph: planned.operationGraph || [],
        operationResults,
        recoveries,
        decisionLog,
        capabilityIds: planned.capabilityIds || [],
        beforePlanHash: planned.basePlanHash,
        versionRebase,
        stats: {
            perSceneChanged: (Number(result.changed) || 0) + specialistChanged,
            fixed: Array.isArray(result.report?.fixed) ? result.report.fixed.length : 0,
            flagged: Array.isArray(result.report?.unfixable) ? result.report.unfixable.length : 0,
            ...operationStats,
            qualityWarnings: Number(result.qualityReport?.findings?.length) || 0,
            automaticRepairs: Number(result.qualityReport?.automaticRepairCount) || 0,
            visualFramesChecked: Number(visualQa?.totalFramesChecked) || 0,
            visualRepairs: Number(visualQa?.repairCount) || 0,
            visualFindings: Array.isArray(visualQa?.findings) ? visualQa.findings.length : 0,
        },
    };
}

module.exports = {
    executePlanned,
    normalizeScope,
    planRequest,
};
