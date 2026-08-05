'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    assertToolArgs,
    contractHash,
    normalizeTools,
} = require('./capability-contract');

const CAPABILITY_FILE = /^[a-z0-9][a-z0-9-]*\.js$/i;
const RESERVED_FILES = new Set(['capability-contract.js', 'registry.js', 'smart-router.js']);
const RISK_LEVELS = new Set(['low', 'moderate', 'expensive', 'structural']);

let discovered = null;
let discoveredFingerprint = '';
const registered = new Map();

const WATCHED_PATHS = [
    __dirname,
    path.resolve(__dirname, '..', 'workers'),
    path.resolve(__dirname, '..', '..', 'workers', 'icon-director.js'),
    path.resolve(__dirname, '..', '..', '..', 'render', 'hf-effects.js'),
    path.resolve(__dirname, '..', '..', '..', 'render', 'mg-registry.js'),
    path.resolve(__dirname, '..', '..', '..', 'render', 'graphic-shells.js'),
    path.resolve(__dirname, '..', '..', 'ai-motion-graphics.js'),
    path.resolve(__dirname, '..', '..', 'ai-templates.js'),
    path.resolve(__dirname, '..', '..', '..', 'directives', 'framing-preset.js'),
    path.resolve(__dirname, '..', '..', '..', 'media', 'source-policy.js'),
];

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _watchedFiles() {
    const files = [];
    const visit = (target) => {
        if (!fs.existsSync(target)) return;
        const stat = fs.statSync(target);
        if (stat.isFile()) {
            if (target.endsWith('.js')) files.push(path.resolve(target));
            return;
        }
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
            const child = path.join(target, entry.name);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.resolve(child));
        }
    };
    WATCHED_PATHS.forEach(visit);
    return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function _sourceFingerprint() {
    const hash = crypto.createHash('sha1');
    for (const filePath of _watchedFiles()) {
        const stat = fs.statSync(filePath);
        hash.update(filePath);
        hash.update(String(stat.size));
        hash.update(String(stat.mtimeMs));
    }
    return hash.digest('hex');
}

function _clearWatchedModuleCache() {
    const registryPath = path.resolve(__filename);
    for (const filePath of _watchedFiles()) {
        if (filePath === registryPath) continue;
        try {
            delete require.cache[require.resolve(filePath)];
        } catch (_) { }
    }
}

function _readManifest(capability, source = 'capability') {
    if (!capability || typeof capability !== 'object') {
        throw new Error(`${source} must export a capability object`);
    }
    if (typeof capability.manifest !== 'function') {
        throw new Error(`${source} must export manifest()`);
    }
    if (typeof capability.execute !== 'function') {
        throw new Error(`${source} must export execute()`);
    }
    const manifest = capability.manifest();
    const id = String(manifest?.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
        throw new Error(`${source} has an invalid capability id`);
    }
    const scopes = Array.isArray(manifest.scopes)
        ? [...new Set(manifest.scopes.map((scope) => String(scope || '').trim()).filter(Boolean))]
        : [];
    if (!scopes.length) throw new Error(`${source} must declare at least one scope`);
    const risk = RISK_LEVELS.has(manifest.risk) ? manifest.risk : 'moderate';
    const tools = normalizeTools(
        typeof capability.tools === 'function' ? capability.tools() : manifest.tools,
        {
            specialist: String(manifest.specialist || id),
            scopes,
            risk,
        }
    );
    const declaredActions = Array.isArray(manifest.actions)
        ? [...new Set(manifest.actions.map((action) => String(action || '').trim()).filter(Boolean))]
        : [];
    const actions = tools.length ? tools.map((entry) => entry.action) : declaredActions;
    if (!actions.length) throw new Error(`${source} must declare at least one action`);
    if (tools.length && declaredActions.length) {
        const declared = [...declaredActions].sort();
        const contracted = [...actions].sort();
        if (JSON.stringify(declared) !== JSON.stringify(contracted)) {
            throw new Error(`${source} actions must be generated from its tool contract`);
        }
    }
    const normalized = {
        ..._clone(manifest),
        id,
        specialist: String(manifest.specialist || id),
        actions,
        scopes,
        risk,
        contractVersion: tools.length ? Math.max(2, Number(manifest.contractVersion) || 2) : 1,
        tools,
        directiveKeys: Array.isArray(manifest.directiveKeys)
            ? [...new Set(manifest.directiveKeys.map((key) => String(key || '').trim()).filter(Boolean))]
            : [],
    };
    normalized.contractHash = contractHash({
        id: normalized.id,
        specialist: normalized.specialist,
        scopes: normalized.scopes,
        risk: normalized.risk,
        tools: normalized.tools,
        vocabulary: normalized.vocabulary || {},
        limitations: normalized.limitations || [],
    });
    return normalized;
}

function _discover() {
    const fingerprint = _sourceFingerprint();
    if (discovered && fingerprint === discoveredFingerprint) return discovered;
    if (discovered && fingerprint !== discoveredFingerprint) _clearWatchedModuleCache();
    discovered = new Map();
    const files = fs.readdirSync(__dirname, { withFileTypes: true })
        .filter((entry) => entry.isFile()
            && CAPABILITY_FILE.test(entry.name)
            && !RESERVED_FILES.has(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    for (const filename of files) {
        const modulePath = path.join(__dirname, filename);
        const capability = require(modulePath);
        const manifest = _readManifest(capability, filename);
        if (discovered.has(manifest.id)) {
            throw new Error(`Duplicate Editor Agent capability id: ${manifest.id}`);
        }
        discovered.set(manifest.id, {
            capability,
            manifest,
            source: modulePath,
        });
    }
    discoveredFingerprint = fingerprint;
    return discovered;
}

function _all() {
    const result = new Map(_discover());
    for (const [id, entry] of registered) result.set(id, entry);
    return result;
}

function listCapabilities() {
    return [..._all().values()];
}

function listManifests() {
    return listCapabilities().map((entry) => _clone(entry.manifest));
}

function getCapability(idValue) {
    return _all().get(String(idValue || '').trim()) || null;
}

function registerCapability(capability, options = {}) {
    const manifest = _readManifest(capability, options.source || 'registered capability');
    const existing = getCapability(manifest.id);
    if (existing && options.replace !== true) {
        throw new Error(`Editor Agent capability "${manifest.id}" is already registered`);
    }
    registered.set(manifest.id, {
        capability,
        manifest,
        source: options.source || 'runtime',
    });
    return _clone(manifest);
}

function unregisterCapability(idValue) {
    return registered.delete(String(idValue || '').trim());
}

function reloadCapabilities() {
    _clearWatchedModuleCache();
    discovered = null;
    discoveredFingerprint = '';
    return listManifests();
}

function _scopeKind(operation, context) {
    return String(operation?.scope?.kind || context?.request?.scope?.kind || '');
}

function validateOperation(operation, context = {}) {
    if (!operation || typeof operation !== 'object') throw new Error('Capability operation must be an object');
    const capabilityId = String(operation.capabilityId || '').trim();
    const entry = getCapability(capabilityId);
    if (!entry) throw new Error(`Unknown Editor Agent capability: ${capabilityId || '(empty)'}`);
    const action = String(operation.action || '').trim();
    if (!entry.manifest.actions.includes(action)) {
        throw new Error(`${entry.manifest.specialist} does not expose action "${action || '(empty)'}"`);
    }
    const toolSpec = entry.manifest.tools.find((candidate) => candidate.action === action);
    if (toolSpec) {
        assertToolArgs(
            toolSpec,
            operation.args && typeof operation.args === 'object' ? operation.args : {},
            `${entry.manifest.specialist}.${action}`
        );
    }
    const scope = operation.scope || context?.request?.scope;
    const scopeKind = _scopeKind({ ...operation, scope }, context);
    if (!scope || !entry.manifest.scopes.includes(scopeKind)) {
        throw new Error(`${entry.manifest.specialist} does not support ${scopeKind || 'that'} scope`);
    }
    return {
        ...operation,
        capabilityId: entry.manifest.id,
        specialist: entry.manifest.specialist,
        action,
        args: operation.args && typeof operation.args === 'object' ? _clone(operation.args) : {},
        scope: _clone(scope),
        risk: RISK_LEVELS.has(operation.risk) ? operation.risk : entry.manifest.risk,
        description: String(operation.description || `${entry.manifest.specialist}: ${action}`),
        progress: operation.progress && typeof operation.progress === 'object'
            ? {
                phase: String(operation.progress.phase || entry.manifest.id),
                message: String(operation.progress.message || `${entry.manifest.specialist} is applying the edit...`),
            }
            : {
                phase: entry.manifest.id,
                message: `${entry.manifest.specialist} is applying the edit...`,
            },
    };
}

function tryNormalizeInvocation(invocation, context = {}) {
    try {
        const capabilityId = String(
            invocation?.capabilityId
            || invocation?.capability
            || invocation?.specialistId
            || ''
        ).trim();
        const entry = getCapability(capabilityId);
        if (!entry) throw new Error(`Unknown Editor Agent capability: ${capabilityId || '(empty)'}`);
        const invocationAction = String(invocation?.action || '').trim();
        const inputTool = entry.manifest.tools.find((candidate) => candidate.action === invocationAction);
        if (entry.manifest.tools.length && !inputTool) {
            throw new Error(`${entry.manifest.specialist} does not expose action "${invocationAction || '(empty)'}"`);
        }
        if (inputTool) {
            assertToolArgs(
                inputTool,
                invocation?.args && typeof invocation.args === 'object' ? invocation.args : {},
                `${entry.manifest.specialist}.${invocationAction}`
            );
        }
        if (typeof entry.capability.normalizeInvocation !== 'function') {
            throw new Error(`${entry.manifest.specialist} cannot normalize smart invocations`);
        }
        const operation = entry.capability.normalizeInvocation(invocation, context);
        if (!operation) throw new Error(`${entry.manifest.specialist} rejected that action or scope`);
        return { operation: validateOperation(operation, context), error: null };
    } catch (error) {
        return { operation: null, error };
    }
}

function normalizeInvocation(invocation, context = {}) {
    const result = tryNormalizeInvocation(invocation, context);
    if (!result.operation) throw result.error;
    return result.operation;
}

function planDeterministic(context = {}) {
    const operations = [];
    const claimedDirectiveKeys = [];
    const supported = [];
    const unsupported = [];
    for (const entry of listCapabilities()) {
        if (typeof entry.capability.planFast !== 'function') continue;
        try {
            const planned = entry.capability.planFast(context) || {};
            claimedDirectiveKeys.push(...(planned.claimedDirectiveKeys || []));
            supported.push(...(planned.supported || []));
            unsupported.push(...(planned.unsupported || []));
            for (const operation of (planned.operations || [])) {
                operations.push(validateOperation(operation, context));
            }
        } catch (error) {
            context.log?.(`${entry.manifest.specialist} planning skipped: ${error.message}`);
            unsupported.push(`${entry.manifest.specialist} could not safely plan this request.`);
        }
    }
    return {
        operations,
        claimedDirectiveKeys: [...new Set(claimedDirectiveKeys.filter(Boolean))],
        supported: [...new Set(supported.filter(Boolean))],
        unsupported: [...new Set(unsupported.filter(Boolean))],
    };
}

async function executeCapabilityOperation(plan, operation, options = {}) {
    const validated = validateOperation(operation, { request: { scope: operation?.scope } });
    const entry = getCapability(validated.capabilityId);
    const result = await entry.capability.execute({
        plan,
        operation: validated,
        options,
    });
    return {
        changed: Number(result?.changed) || 0,
        stats: result?.stats && typeof result.stats === 'object' ? result.stats : {},
        assetManifest: result?.assetManifest || null,
        structuralRange: result?.structuralRange || null,
        diagnostics: result?.diagnostics || null,
    };
}

async function recoverCapabilityOperation(plan, operation, error, context = {}) {
    const validated = validateOperation(operation, { request: { scope: operation?.scope } });
    const entry = getCapability(validated.capabilityId);
    if (typeof entry?.capability?.recover !== 'function') return null;
    const raw = await entry.capability.recover({
        plan,
        operation: validated,
        error,
        context,
    });
    if (!raw) return null;

    const candidate = raw.operation || raw.invocation || raw;
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.specialist || candidate.progress || candidate.risk) {
        return validateOperation({
            ...candidate,
            scope: candidate.scope || validated.scope,
        }, {
            request: { scope: candidate.scope || validated.scope },
        });
    }
    const normalized = tryNormalizeInvocation(candidate, {
        request: {
            ...(context.request || {}),
            scope: candidate.scope || validated.scope,
        },
        plan,
        existingOperations: context.completedOperations || [],
        log: context.options?.log,
    });
    if (!normalized.operation) throw normalized.error;
    return normalized.operation;
}

function inspectCapabilities(plan, scope) {
    const inspections = {};
    for (const entry of listCapabilities()) {
        if (typeof entry.capability.inspect !== 'function') continue;
        try {
            inspections[entry.manifest.id] = entry.capability.inspect(plan, scope);
        } catch (_) { }
    }
    return inspections;
}

module.exports = {
    executeCapabilityOperation,
    getCapability,
    inspectCapabilities,
    listCapabilities,
    listManifests,
    normalizeInvocation,
    planDeterministic,
    recoverCapabilityOperation,
    registerCapability,
    reloadCapabilities,
    tryNormalizeInvocation,
    unregisterCapability,
    validateOperation,
};
