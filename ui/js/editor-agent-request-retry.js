(function initEditorAgentRequestRetry(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EditorAgentRequestRetry = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
    'use strict';

    function normalizedVersion(value = {}) {
        const revision = Number(value.revision);
        return {
            revision: Number.isFinite(revision) ? revision : null,
            planHash: String(value.planHash || ''),
        };
    }

    async function planWithConflictRetry({
        invoke,
        payload,
        getVersion,
        onConflict,
        maxAttempts = 3,
    } = {}) {
        if (typeof invoke !== 'function') {
            throw new TypeError('Agent planning retry requires an invoke function');
        }
        const attemptsLimit = Math.max(1, Math.min(4, Math.trunc(Number(maxAttempts) || 3)));
        const basePayload = payload && typeof payload === 'object' ? { ...payload } : {};
        let version = normalizedVersion(typeof getVersion === 'function' ? getVersion() : {});
        let result = null;

        for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
            result = await invoke({
                ...basePayload,
                projectRevision: version.revision,
                planHash: version.planHash,
            });
            if (result?.success || result?.conflict !== true) {
                return result && typeof result === 'object'
                    ? { ...result, conflictRetries: attempt - 1 }
                    : result;
            }
            if (attempt >= attemptsLimit || result.retryable === false) return result;

            const nextVersion = normalizedVersion(result);
            if (nextVersion.revision === null && !nextVersion.planHash) return result;
            version = nextVersion;
            if (typeof onConflict === 'function') {
                await onConflict({
                    attempt,
                    nextAttempt: attempt + 1,
                    maxAttempts: attemptsLimit,
                    version: { ...version },
                    result,
                });
            }
        }
        return result;
    }

    return {
        normalizedVersion,
        planWithConflictRetry,
    };
});
