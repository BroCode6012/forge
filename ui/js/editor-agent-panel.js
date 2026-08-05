(() => {
    'use strict';

    let initialized = false;
    let busy = false;
    let conversation = [];
    let currentScope = null;
    let currentSessionId = '';
    let sessionSyncTimer = null;
    let sessionSyncInFlight = false;
    let liveCapabilities = [];

    const ui = {};

    function byId(id) {
        return document.getElementById(id);
    }

    function setStatus(text, mode = 'ready') {
        if (!ui.pane) return;
        ui.pane.classList.toggle('is-working', mode === 'working');
        ui.pane.classList.toggle('has-error', mode === 'error');
        if (ui.statusText) ui.statusText.textContent = text;
    }

    function activateTab(name) {
        const agentActive = name === 'agent';
        ui.agentTab?.classList.toggle('active', agentActive);
        ui.inspectorTab?.classList.toggle('active', !agentActive);
        ui.agentTab?.setAttribute('aria-selected', String(agentActive));
        ui.inspectorTab?.setAttribute('aria-selected', String(!agentActive));
        ui.pane?.classList.toggle('active', agentActive);
        ui.inspectorPane?.classList.toggle('active', !agentActive);
        byId('btn-agent')?.classList.toggle('agent-open', agentActive);
        if (agentActive) {
            refreshScope();
            setTimeout(() => ui.input?.focus(), 0);
        }
    }

    function open() {
        activateTab('agent');
    }

    function openWithCurrentScope() {
        refreshScope();
        open();
    }

    function _scopeTitle(scope) {
        if (!scope) return 'Whole project';
        const suffix = scope.contiguous === false ? ' (non-contiguous)' : '';
        return `${scope.label || 'Whole project'}${suffix}`;
    }

    function refreshScope() {
        currentScope = window.EditorAgentHost?.getScopeSnapshot?.() || {
            kind: 'project',
            scopeMode: 'project',
            label: 'Whole project',
            clipRefs: [],
            visualRefs: [],
            iconRefs: [],
        };
        if (ui.scopeMode) {
            const mode = window.EditorAgentHost?.getScopeMode?.()
                || currentScope.scopeMode
                || 'selection';
            if (ui.scopeMode.value !== mode) ui.scopeMode.value = mode;
        }
        if (ui.scopeChip) {
            ui.scopeChip.textContent = _scopeTitle(currentScope);
            ui.scopeChip.title = currentScope.scopeMode === 'project'
                ? 'The request will target the whole project.'
                : `Agent target: ${_scopeTitle(currentScope)}. ${
                    currentScope.scopeMode === 'scene'
                        ? 'The Agent can inspect the footage, overlapping graphics, and scene icons together.'
                        : 'Only the active selection is explicitly targeted.'
                }`;
        }
    }

    function clonePlain(value, fallback) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_) {
            return fallback;
        }
    }

    function scrollToBottom() {
        if (!ui.messages) return;
        ui.messages.scrollTop = ui.messages.scrollHeight;
    }

    function removeWelcome() {
        ui.messages?.querySelector('.agent-welcome')?.remove();
    }

    function appendMessage(role, text, { error = false } = {}) {
        removeWelcome();
        const message = document.createElement('div');
        message.className = `agent-message ${role}${error ? ' error' : ''}`;
        message.textContent = String(text || '');
        ui.messages.appendChild(message);
        scrollToBottom();
        return message;
    }

    function _suggestionLabel(example, specialist = '') {
        const clean = String(example || '').replace(/[.!?]+$/g, '').trim();
        if (clean.length <= 34) return clean;
        const shortSpecialist = String(specialist || '').replace(/\s+(?:Editor|Agent)$/i, '').trim();
        return shortSpecialist ? `${shortSpecialist} edit` : `${clean.slice(0, 31)}...`;
    }

    function _liveSuggestions() {
        const suggestions = [];
        const usedCapabilities = new Set();
        for (const capability of liveCapabilities) {
            const example = (capability.examples || []).find(Boolean)
                || (capability.tools || []).flatMap((tool) => tool.examples || []).find(Boolean);
            if (!example || usedCapabilities.has(capability.id)) continue;
            usedCapabilities.add(capability.id);
            suggestions.push([
                _suggestionLabel(example, capability.specialist),
                String(example),
            ]);
            if (suggestions.length >= 6) break;
        }
        return suggestions.length ? suggestions : [
            ['Faster pace', 'Make this selection faster paced'],
            ['Replace media', 'Find a better alternative for this media'],
            ['Add animated text', 'Add an animated text treatment'],
            ['Cold threatening look', 'Make this cold and threatening'],
            ['Remove vignette only', 'Remove the vignette but keep the grade'],
            ['Clear effects, keep grade', 'Clear all effects but keep the grade'],
        ];
    }

    async function syncCapabilities() {
        if (!window.electronAPI?.agentCapabilities) return;
        try {
            const result = await window.electronAPI.agentCapabilities();
            if (!result?.success || !Array.isArray(result.capabilities)) return;
            liveCapabilities = result.capabilities;
            if (ui.messages?.querySelector('.agent-welcome')) renderWelcome();
        } catch (_) {
            // Capability discovery must never block the editing UI.
        }
    }

    function renderWelcome(titleText = 'Edit by asking', bodyText = '') {
        ui.messages.replaceChildren();
        const welcome = document.createElement('div');
        welcome.className = 'agent-welcome';
        const mark = document.createElement('div');
        mark.className = 'agent-welcome-mark';
        mark.textContent = '✦';
        const title = document.createElement('h3');
        title.textContent = titleText;
        const body = document.createElement('p');
        const liveToolCount = liveCapabilities.reduce(
            (sum, capability) => sum + (capability.tools?.length || 0),
            0
        );
        body.textContent = bodyText || (
            liveCapabilities.length
                ? `${liveCapabilities.length} live specialists and ${liveToolCount} verified editing tools are available. Select a scope, then describe the result you want.`
                : 'Select clips or set In/Out points, then describe the result you want. Agent inspects live specialists, plans first, verifies every attempt, and recovers safely when possible.'
        );
        const suggestions = document.createElement('div');
        suggestions.className = 'agent-suggestions';
        for (const [label, prompt] of _liveSuggestions()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.agentPrompt = prompt;
            suggestions.appendChild(button);
        }
        welcome.append(mark, title, body, suggestions);
        ui.messages.appendChild(welcome);
    }

    function renderStoredSession(session) {
        const turns = Array.isArray(session?.turns) ? session.turns : [];
        currentSessionId = String(session?.id || '');
        conversation = turns
            .filter((turn) => turn?.role === 'user' || turn?.role === 'model')
            .map((turn) => ({ role: turn.role, text: String(turn.text || '') }))
            .filter((turn) => turn.text);
        if (!turns.length) {
            renderWelcome();
            return;
        }
        ui.messages.replaceChildren();
        turns.forEach((turn) => {
            if (turn?.role !== 'user' && turn?.role !== 'model') return;
            appendMessage(turn.role, turn.text || '');
        });
    }

    async function syncSession({ force = false } = {}) {
        if (sessionSyncInFlight || !window.electronAPI?.agentSession) return;
        if (!window.EditorAgentHost?.hasProject?.()) {
            currentSessionId = '';
            return;
        }
        sessionSyncInFlight = true;
        try {
            const result = await window.electronAPI.agentSession();
            if (!result?.success || !result.session) return;
            if (force || !currentSessionId || currentSessionId !== result.session.id) {
                renderStoredSession(result.session);
            }
        } catch (_) {
            // Conversation persistence must never block editing.
        } finally {
            sessionSyncInFlight = false;
        }
    }

    function scheduleSessionSync() {
        clearTimeout(sessionSyncTimer);
        sessionSyncTimer = setTimeout(() => syncSession(), 120);
    }

    function appendResultAction(label, handler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-result-action';
        button.textContent = label;
        button.addEventListener('click', handler);
        ui.messages.appendChild(button);
        scrollToBottom();
        return button;
    }

    function _appendTextRow(parent, className, text) {
        if (!text) return null;
        const row = document.createElement('div');
        row.className = className;
        row.textContent = text;
        parent.appendChild(row);
        return row;
    }

    function _diffEvidence(diff = {}) {
        const parts = [];
        const sceneDelta = Number(diff.scenesAfter) - Number(diff.scenesBefore);
        if (sceneDelta) parts.push(`${sceneDelta > 0 ? '+' : ''}${sceneDelta} timeline beat${Math.abs(sceneDelta) === 1 ? '' : 's'}`);
        if (diff.mediaChanged) parts.push(`${diff.mediaChanged} media change${diff.mediaChanged === 1 ? '' : 's'}`);
        const graphicChanges = Number(diff.graphicsAdded) + Number(diff.graphicsRemoved) + Number(diff.graphicsUpdated);
        if (graphicChanges) parts.push(`${graphicChanges} graphic change${graphicChanges === 1 ? '' : 's'}`);
        if (diff.effectsChanged) parts.push(`${diff.effectsChanged} look change${diff.effectsChanged === 1 ? '' : 's'}`);
        if (diff.framingChanged) parts.push(`${diff.framingChanged} framing change${diff.framingChanged === 1 ? '' : 's'}`);
        if (diff.timelinePropertiesChanged) parts.push(`${diff.timelinePropertiesChanged} clip setup change${diff.timelinePropertiesChanged === 1 ? '' : 's'}`);
        if (diff.transitionsChanged) parts.push('transition structure updated');
        if (diff.captionsChanged) parts.push('caption design updated');
        else if (diff.subtitlesChanged) parts.push('subtitle setting updated');
        if (diff.sfxChanged) parts.push(`${diff.sfxChanged} sound-effect change${diff.sfxChanged === 1 ? '' : 's'}`);
        if (diff.audioChanged && !diff.subtitlesChanged) parts.push('audio mix updated');
        return parts;
    }

    function appendExecutionResult(result) {
        removeWelcome();
        const card = document.createElement('div');
        card.className = 'agent-result-card';
        const recoveries = Array.isArray(result.recoveries) ? result.recoveries : [];
        _appendTextRow(
            card,
            'agent-result-kicker',
            recoveries.length ? 'Edit recovered and verified' : 'Edit verified'
        );
        _appendTextRow(card, 'agent-result-summary', result.summary || 'Edit applied.');

        const operationResults = Array.isArray(result.operationResults) ? result.operationResults : [];
        if (operationResults.length) {
            const steps = document.createElement('div');
            steps.className = 'agent-result-steps';
            operationResults.forEach((operation) => {
                const step = document.createElement('div');
                step.className = 'agent-result-step';
                const mark = document.createElement('span');
                mark.className = 'agent-result-step-mark';
                mark.textContent = operation.status === 'completed-after-recovery' ? '↻' : '✓';
                const text = document.createElement('span');
                text.textContent = `${operation.specialist}: ${operation.description}`;
                step.append(mark, text);
                steps.appendChild(step);
            });
            card.appendChild(steps);
        }

        if (recoveries.length) {
            const recoveryList = document.createElement('div');
            recoveryList.className = 'agent-result-recoveries';
            recoveries.forEach((recovery) => {
                const row = document.createElement('div');
                row.className = 'agent-result-recovery';
                row.textContent = `Recovered automatically: ${recovery.fromCapabilityId} → ${recovery.toCapabilityId}`
                    + (recovery.description ? ` · ${recovery.description}` : '');
                recoveryList.appendChild(row);
            });
            card.appendChild(recoveryList);
        }

        const evidence = _diffEvidence(result.diff);
        if (evidence.length) {
            _appendTextRow(card, 'agent-result-evidence', `Changed: ${evidence.join(' · ')}`);
        }
        const quality = result.qualityReport || {};
        const warnings = Array.isArray(quality.findings) ? quality.findings.length : 0;
        const repairs = Number(quality.automaticRepairCount) || 0;
        const verificationPasses = Array.isArray(quality.repairPasses)
            ? quality.repairPasses.length
            : 1;
        _appendTextRow(
            card,
            'agent-result-quality',
            `Quality Guard ${quality.status || 'passed'}`
                + ` · ${verificationPasses} verification pass${verificationPasses === 1 ? '' : 'es'}`
                + (repairs ? ` · ${repairs} automatic repair${repairs === 1 ? '' : 's'}` : '')
                + (warnings ? ` · ${warnings} advisory finding${warnings === 1 ? '' : 's'}` : '')
                + (result.diff?.scopeLeakCount === 0 ? ' · scope protected' : '')
        );

        const visualQa = result.visualQa || {};
        if (visualQa.status && visualQa.status !== 'skipped') {
            const visualPasses = Array.isArray(visualQa.passes) ? visualQa.passes.length : 1;
            const checked = Number(visualQa.totalFramesChecked ?? visualQa.frameCount) || 0;
            const visualRepairs = Number(visualQa.repairCount) || 0;
            const visualFindings = Array.isArray(visualQa.findings) ? visualQa.findings.length : 0;
            _appendTextRow(
                card,
                'agent-result-quality',
                `Visual Observer ${visualQa.status}`
                    + (checked ? ` · ${checked} rendered proof frame${checked === 1 ? '' : 's'}` : '')
                    + ` · ${visualPasses} visual pass${visualPasses === 1 ? '' : 'es'}`
                    + (visualQa.visionUsed ? ' · vision critique' : ' · local frame checks')
                    + (visualRepairs ? ` · ${visualRepairs} safe repair${visualRepairs === 1 ? '' : 's'}` : '')
                    + (visualFindings ? ` · ${visualFindings} finding${visualFindings === 1 ? '' : 's'}` : '')
            );
            if (visualQa.summary) {
                _appendTextRow(card, 'agent-result-evidence', visualQa.summary);
            }
        }

        const actions = document.createElement('div');
        actions.className = 'agent-plan-actions';
        const undoButton = document.createElement('button');
        undoButton.type = 'button';
        undoButton.textContent = 'Undo this edit';
        undoButton.addEventListener('click', undo);
        actions.appendChild(undoButton);
        card.appendChild(actions);
        ui.messages.appendChild(card);
        scrollToBottom();
        return card;
    }

    function setBusy(next, message = '') {
        busy = next;
        if (ui.send) ui.send.disabled = next;
        if (ui.input) ui.input.disabled = next;
        if (ui.composer) ui.composer.classList.toggle('is-busy', next);
        if (next) setStatus(message || 'Working', 'working');
        else if (!ui.pane?.classList.contains('has-error')) setStatus('Ready', 'ready');
    }

    function setProgress(percent, text) {
        if (!ui.progress) return;
        ui.progress.classList.remove('hidden');
        if (ui.progressFill) ui.progressFill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
        if (ui.progressText) ui.progressText.textContent = text || 'Working...';
    }

    function clearProgress(delay = 0) {
        setTimeout(() => {
            ui.progress?.classList.add('hidden');
            if (ui.progressFill) ui.progressFill.style.width = '0%';
        }, delay);
    }

    function _listText(items) {
        return (items || []).filter(Boolean).join(', ');
    }

    function _contradictsPendingPlan(text) {
        const value = String(text || '').trim();
        if (!value) return false;
        return (
            /\bno\b.{0,32}\b(?:changes?|edits?|updates?|work|actions?)\b.{0,32}\b(?:needed|required|necessary)\b/i.test(value)
            || /\bnothing\b.{0,32}\b(?:change|edit|update|do|apply)\b/i.test(value)
            || /\balready\b.{0,40}\b(?:satisfied|updated|queued|applied|done|complete(?:d)?|handled|changed)\b/i.test(value)
        );
    }

    function _planSummary(plan) {
        const proposed = String(plan?.summary || '').trim();
        if (!plan?.executable || !_contradictsPendingPlan(proposed)) {
            return proposed || 'Agent edit';
        }
        const descriptions = [...new Set(
            (plan.operations || []).map((operation) => String(operation?.description || '').trim()).filter(Boolean)
        )];
        if (descriptions.length === 1) {
            return `Ready to apply: ${descriptions[0]}.`;
        }
        return 'Ready to apply the proposed edit.';
    }

    function appendPlanCard(plan) {
        removeWelcome();
        const card = document.createElement('div');
        card.className = 'agent-plan-card';

        const kicker = document.createElement('div');
        kicker.className = 'agent-plan-kicker';
        kicker.textContent = plan.executable
            ? 'Proposed edit'
            : (plan.alreadySatisfied ? 'Already satisfied' : 'Needs a stronger editing tool');
        card.appendChild(kicker);

        const summary = document.createElement('div');
        summary.className = 'agent-plan-summary';
        summary.textContent = _planSummary(plan);
        card.appendChild(summary);

        const meta = document.createElement('div');
        meta.className = 'agent-plan-meta';
        const supported = _listText(plan.supported);
        const scope = plan.scope?.label || currentScope?.label || 'Whole project';
        const specialists = _listText(
            plan.specialists
            || (plan.operations || []).map((operation) => operation.specialist)
        );
        meta.textContent = `${scope}${specialists ? ` · Agents: ${specialists}` : ''}`;
        card.appendChild(meta);

        if (supported) {
            const changes = document.createElement('div');
            changes.className = 'agent-plan-meta';
            changes.textContent = plan.alreadySatisfied
                ? `Current state: ${supported}`
                : `Will change: ${supported}`;
            card.appendChild(changes);
        }

        if (plan.inspection?.capabilityIds?.length) {
            const inspected = document.createElement('div');
            inspected.className = 'agent-plan-inspection';
            inspected.textContent = `Inspected live ${plan.inspection.capabilityIds.join(', ')} state`
                + (plan.inspection.targetCount ? ` across ${plan.inspection.targetCount} target${plan.inspection.targetCount === 1 ? '' : 's'}` : '');
            card.appendChild(inspected);
        }

        if (plan.visualGrounding?.screenshotUsed) {
            const grounding = document.createElement('div');
            grounding.className = 'agent-plan-inspection';
            const time = Number(plan.visualGrounding.frameTime) || 0;
            const confidence = Math.round((Number(plan.visualGrounding.confidence) || 0) * 100);
            grounding.textContent = plan.visualGrounding.status === 'grounded'
                ? `Looked at the exact preview frame at ${time.toFixed(2)}s · ${plan.visualGrounding.summary}`
                    + (confidence ? ` · ${confidence}% match` : '')
                : `Looked at the exact preview frame at ${time.toFixed(2)}s · ${plan.visualGrounding.message || plan.visualGrounding.summary}`;
            card.appendChild(grounding);
        }

        if (plan.contextResolution?.applied) {
            const context = document.createElement('div');
            context.className = 'agent-plan-context';
            context.textContent = plan.contextResolution.note || 'Continued the previous editing context.';
            card.appendChild(context);
        }

        if (plan.executable) {
            const autonomy = document.createElement('div');
            autonomy.className = 'agent-plan-autonomy';
            autonomy.textContent = plan.effort === 'smart'
                ? 'After approval: isolated specialist attempts → scope verification → Quality Guard → rendered proof frames → bounded visual self-repair → one undoable commit.'
                : 'After approval: isolated attempt → scope verification → safe recovery if needed → Quality Guard → one undoable commit.';
            card.appendChild(autonomy);
        }

        if (Array.isArray(plan.operations) && plan.operations.length) {
            const steps = document.createElement('ol');
            steps.className = 'agent-plan-steps';
            plan.operations.forEach((operation) => {
                const step = document.createElement('li');
                step.textContent = `${operation.specialist}: ${operation.description}`;
                if (operation.dependsOn?.length) {
                    step.title = `Runs after: ${operation.dependsOn.join(', ')}`;
                }
                steps.appendChild(step);
            });
            card.appendChild(steps);
        }

        if (plan.estimatedWork) {
            const estimate = document.createElement('div');
            estimate.className = 'agent-plan-meta';
            const parts = [];
            if (plan.estimatedWork.pacing) parts.push('re-cut selected structure');
            if (plan.estimatedWork.mediaReplacements) {
                parts.push(`${plan.estimatedWork.mediaReplacements} media replacement${plan.estimatedWork.mediaReplacements === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.graphicEdits) {
                parts.push(`up to ${plan.estimatedWork.graphicEdits} graphic edit${plan.estimatedWork.graphicEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.graphicContentEdits) {
                parts.push(`${plan.estimatedWork.graphicContentEdits} in-place graphic text edit${plan.estimatedWork.graphicContentEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.graphicStyleEdits) {
                parts.push(`${plan.estimatedWork.graphicStyleEdits} in-place graphic style edit${plan.estimatedWork.graphicStyleEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.effectsEdits) {
                parts.push(`${plan.estimatedWork.effectsEdits} look target${plan.estimatedWork.effectsEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.framingEdits) {
                parts.push(`${plan.estimatedWork.framingEdits} framing target${plan.estimatedWork.framingEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.transitionEdits) {
                parts.push(`${plan.estimatedWork.transitionEdits} transition target${plan.estimatedWork.transitionEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.audioEdits) {
                parts.push(`${plan.estimatedWork.audioEdits} audio target${plan.estimatedWork.audioEdits === 1 ? '' : 's'}`);
            }
            if (plan.estimatedWork.captionEdits) {
                parts.push('caption design');
            }
            if (plan.estimatedWork.timelineEdits) {
                parts.push(`${plan.estimatedWork.timelineEdits} clip setup target${plan.estimatedWork.timelineEdits === 1 ? '' : 's'}`);
            }
            estimate.textContent = `${String(plan.risk || 'low').toUpperCase()} risk${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
            card.appendChild(estimate);
        }

        if (plan.unsupported?.length) {
            const warning = document.createElement('div');
            warning.className = 'agent-plan-warning';
            warning.textContent = `Not included in this edit: ${plan.unsupported.join(' ')}`;
            card.appendChild(warning);
        } else if (plan.alreadySatisfied) {
            const warning = document.createElement('div');
            warning.className = 'agent-plan-meta';
            warning.textContent = 'The current project already matches this request, so nothing will be changed.';
            card.appendChild(warning);
        }

        if (plan.executable) {
            const actions = document.createElement('div');
            actions.className = 'agent-plan-actions';

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', () => {
                card.remove();
                appendMessage('model', 'Plan cancelled. Nothing was changed.');
            });

            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'primary';
            apply.textContent = plan.risk === 'structural' || plan.risk === 'expensive'
                ? 'Run edit'
                : 'Apply edit';
            apply.addEventListener('click', async () => {
                cancel.disabled = true;
                apply.disabled = true;
                await executePlan(plan.planId, card);
            });

            actions.append(cancel, apply);
            card.appendChild(actions);
        }

        ui.messages.appendChild(card);
        scrollToBottom();
    }

    async function refreshHistoryButtons() {
        if (!window.electronAPI?.agentHistory) return;
        try {
            const result = await window.electronAPI.agentHistory();
            if (!result?.success) return;
            if (ui.undo) ui.undo.disabled = !result.undo?.length;
            if (ui.redo) ui.redo.disabled = !result.redo?.length;
        } catch (_) { }
    }

    async function executePlan(planId, card) {
        if (busy) return;
        setBusy(true, 'Applying edit');
        setProgress(5, 'Starting Agent transaction...');
        try {
            const result = await window.electronAPI.agentExecute({ planId });
            if (!result?.success) {
                const visualReason = result?.visualQa?.summary
                    ? ` Visual Observer: ${result.visualQa.summary}`
                    : '';
                throw new Error(`${result?.error || 'Agent could not apply this edit'}${visualReason}`);
            }
            if (result.sessionId) currentSessionId = result.sessionId;
            card?.remove();
            const stats = result.stats || {};
            const changed = Number(stats.perSceneChanged) || Number(stats.fixed) || 0;
            const resultParts = [];
            if (stats.pacingSplits) resultParts.push(`${stats.pacingSplits} new cut${stats.pacingSplits === 1 ? '' : 's'}`);
            if (stats.pacingMerges) resultParts.push(`${stats.pacingMerges} merged cut${stats.pacingMerges === 1 ? '' : 's'}`);
            if (stats.mediaReplaced) resultParts.push(`${stats.mediaReplaced} media replacement${stats.mediaReplaced === 1 ? '' : 's'}`);
            if (stats.graphicsAdded) resultParts.push(`${stats.graphicsAdded} graphic${stats.graphicsAdded === 1 ? '' : 's'} added`);
            if (stats.graphicsRemoved) resultParts.push(`${stats.graphicsRemoved} graphic${stats.graphicsRemoved === 1 ? '' : 's'} removed`);
            if (stats.graphicsContentEdited) resultParts.push(`${stats.graphicsContentEdited} graphic text edit${stats.graphicsContentEdited === 1 ? '' : 's'}`);
            if (stats.graphicsStyleEdited) resultParts.push(`${stats.graphicsStyleEdited} graphic style edit${stats.graphicsStyleEdited === 1 ? '' : 's'}`);
            if (stats.effectScenesChanged) resultParts.push(`${stats.effectScenesChanged} look target${stats.effectScenesChanged === 1 ? '' : 's'} updated`);
            if (stats.effectsAdded) resultParts.push(`${stats.effectsAdded} effect${stats.effectsAdded === 1 ? '' : 's'} added`);
            if (stats.effectsRemoved) resultParts.push(`${stats.effectsRemoved} effect${stats.effectsRemoved === 1 ? '' : 's'} removed`);
            if (stats.effectsTuned) resultParts.push(`${stats.effectsTuned} effect${stats.effectsTuned === 1 ? '' : 's'} tuned`);
            if (stats.effectPropertiesChanged) resultParts.push(`${stats.effectPropertiesChanged} effect propert${stats.effectPropertiesChanged === 1 ? 'y' : 'ies'} updated`);
            if (stats.gradesChanged) resultParts.push(`${stats.gradesChanged} color grade${stats.gradesChanged === 1 ? '' : 's'} changed`);
            if (stats.presetsApplied) resultParts.push(`${stats.presetsApplied} look preset${stats.presetsApplied === 1 ? '' : 's'} applied`);
            if (stats.framingChanged) resultParts.push(`${stats.framingChanged} framing target${stats.framingChanged === 1 ? '' : 's'} updated`);
            if (stats.transitionsChanged || stats.transitionScenesChanged) {
                const transitions = Math.max(Number(stats.transitionsChanged) || 0, Number(stats.transitionScenesChanged) || 0);
                resultParts.push(`${transitions} transition${transitions === 1 ? '' : 's'} updated`);
            }
            if (stats.subtitlesChanged) resultParts.push('subtitles updated');
            else if (stats.captionsChanged) resultParts.push('caption design updated');
            if (stats.clipMotionChanged) resultParts.push(`${stats.clipMotionChanged} image motion target${stats.clipMotionChanged === 1 ? '' : 's'} updated`);
            if (stats.sourceOffsetsChanged) resultParts.push(`${stats.sourceOffsetsChanged} source offset${stats.sourceOffsetsChanged === 1 ? '' : 's'} updated`);
            if (stats.clipTracksChanged) resultParts.push(`${stats.clipTracksChanged} clip track${stats.clipTracksChanged === 1 ? '' : 's'} updated`);
            if (stats.clipVisibilityChanged) resultParts.push(`${stats.clipVisibilityChanged} clip visibility target${stats.clipVisibilityChanged === 1 ? '' : 's'} updated`);
            if (stats.narrationVolumeChanged) resultParts.push('narration mix updated');
            if (stats.musicVolumeChanged) resultParts.push('background-music mix updated');
            if (stats.musicRemoved) resultParts.push('background music removed');
            if (stats.sfxVolumeChanged) {
                resultParts.push(`${stats.sfxVolumeChanged} sound effect${stats.sfxVolumeChanged === 1 ? '' : 's'} remixed`);
            }
            if (stats.sfxRemoved) {
                resultParts.push(`${stats.sfxRemoved} sound effect${stats.sfxRemoved === 1 ? '' : 's'} removed`);
            }
            result.summary = `${result.summary || 'Edit applied.'}${resultParts.length
                ? ` ${resultParts.join(', ')}.`
                : (changed ? ` Updated ${changed} timeline item${changed === 1 ? '' : 's'}.` : '')}`;
            appendExecutionResult(result);
            if (result.sessionWarning) {
                appendMessage('model', result.sessionWarning, { error: true });
            }
            await refreshHistoryButtons();
            clearProgress(700);
        } catch (error) {
            appendMessage('model', error.message, { error: true });
            setStatus('Edit failed', 'error');
            clearProgress(900);
        } finally {
            setBusy(false);
        }
    }

    async function send() {
        if (busy) return;
        const text = String(ui.input?.value || '').trim();
        if (!text) return;
        if (!window.EditorAgentHost?.hasProject?.()) {
            open();
            appendMessage('model', 'Open or generate a project first, then I can inspect and edit its timeline.', { error: true });
            return;
        }

        refreshScope();
        currentScope = window.EditorAgentHost?.getScopeSnapshot?.() || currentScope;
        const scopeAtSubmit = clonePlain(currentScope, currentScope);
        ui.input.value = '';
        appendMessage('user', text);
        conversation.push({ role: 'user', text });
        const historyAtSubmit = clonePlain(conversation, [...conversation]);
        setBusy(true, ui.effort?.value === 'smart' ? 'Thinking deeply' : 'Planning edit');
        const effort = ui.effort?.value || 'fast';
        setProgress(5, effort === 'smart' ? 'Capturing the exact playhead frame...' : 'Matching editing rules...');

        try {
            const visualContext = effort === 'smart'
                ? await window.EditorAgentHost?.getVisualContext?.()
                : null;
            setProgress(8, effort === 'smart' ? 'Understanding the request and visible frame...' : 'Matching editing rules...');
            const requestPayload = {
                text,
                effort,
                scope: scopeAtSubmit,
                history: historyAtSubmit,
                visualContext,
            };
            const retryApi = window.EditorAgentRequestRetry;
            const result = retryApi?.planWithConflictRetry
                ? await retryApi.planWithConflictRetry({
                    invoke: (payload) => window.electronAPI.agentPlan(payload),
                    payload: requestPayload,
                    // Read the version after visual capture. Preview QA/autosave
                    // may legitimately commit while the screenshot is being made.
                    getVersion: () => window.EditorAgentHost?.getProjectVersion?.() || {},
                    maxAttempts: 3,
                    onConflict: async () => {
                        setProgress(9, 'Project updated — revalidating the same selected clip...');
                        await new Promise((resolve) => setTimeout(resolve, 40));
                    },
                })
                : await (async () => {
                    const version = window.EditorAgentHost?.getProjectVersion?.() || {};
                    return window.electronAPI.agentPlan({
                        ...requestPayload,
                        projectRevision: version.revision,
                        planHash: version.planHash,
                    });
                })();
            if (!result?.success) {
                throw new Error(result?.error || 'Agent request failed');
            }
            if (result.sessionId) currentSessionId = result.sessionId;
            if (result.kind === 'answer') {
                appendMessage('model', result.answer || '(No answer)');
                conversation.push({ role: 'model', text: result.answer || '(No answer)' });
            } else {
                appendPlanCard(result);
                conversation.push({
                    role: 'model',
                    text: `${result.summary || 'Proposed edit'}${result.executable ? '' : ' (not executable yet)'}`,
                });
            }
            clearProgress(250);
        } catch (error) {
            appendMessage('model', error.message, { error: true });
            setStatus('Request failed', 'error');
            clearProgress(900);
        } finally {
            setBusy(false);
        }
    }

    async function undo() {
        if (busy || !window.electronAPI?.agentUndo) return;
        setBusy(true, 'Undoing Agent edit');
        setProgress(25, 'Restoring the previous project state...');
        try {
            const result = await window.electronAPI.agentUndo();
            if (!result?.success) throw new Error(result?.error || 'Nothing to undo');
            appendMessage('model', `Undid: ${result.summary || 'last Agent edit'}.`);
            await refreshHistoryButtons();
            clearProgress(500);
        } catch (error) {
            appendMessage('model', error.message, { error: true });
            setStatus('Undo stopped', 'error');
            clearProgress(900);
        } finally {
            setBusy(false);
        }
    }

    async function redo() {
        if (busy || !window.electronAPI?.agentRedo) return;
        setBusy(true, 'Redoing Agent edit');
        setProgress(25, 'Restoring the Agent transaction...');
        try {
            const result = await window.electronAPI.agentRedo();
            if (!result?.success) throw new Error(result?.error || 'Nothing to redo');
            appendMessage('model', `Restored: ${result.summary || 'Agent edit'}.`);
            await refreshHistoryButtons();
            clearProgress(500);
        } catch (error) {
            appendMessage('model', error.message, { error: true });
            setStatus('Redo stopped', 'error');
            clearProgress(900);
        } finally {
            setBusy(false);
        }
    }

    async function newConversation() {
        if (busy) return;
        setBusy(true, 'Starting new conversation');
        try {
            if (window.EditorAgentHost?.hasProject?.() && window.electronAPI?.agentNewSession) {
                const result = await window.electronAPI.agentNewSession();
                if (!result?.success) throw new Error(result?.error || 'Could not start a new conversation');
                renderStoredSession(result.session);
            } else {
                currentSessionId = '';
                conversation = [];
                renderWelcome(
                    'New conversation',
                    'Your project edit history is preserved. This only clears the chat memory.'
                );
            }
            setStatus('Ready');
            ui.input?.focus();
        } catch (error) {
            appendMessage('model', error.message, { error: true });
            setStatus('New chat failed', 'error');
        } finally {
            setBusy(false);
        }
    }

    function bind() {
        if (initialized) return;
        initialized = true;
        ui.pane = byId('agent-pane');
        ui.inspectorPane = byId('inspector-pane');
        ui.agentTab = byId('dock-tab-agent');
        ui.inspectorTab = byId('dock-tab-inspector');
        ui.statusText = byId('agent-status-text');
        ui.scopeMode = byId('agent-scope-mode');
        ui.scopeChip = byId('agent-scope-chip');
        ui.messages = byId('agent-messages');
        ui.progress = byId('agent-progress');
        ui.progressFill = byId('agent-progress-fill');
        ui.progressText = byId('agent-progress-text');
        ui.composer = document.querySelector('.agent-composer');
        ui.input = byId('agent-input');
        ui.effort = byId('agent-effort');
        ui.send = byId('agent-send');
        ui.undo = byId('agent-undo');
        ui.redo = byId('agent-redo');
        ui.newChat = byId('agent-new-chat');

        ui.agentTab?.addEventListener('click', () => activateTab('agent'));
        ui.inspectorTab?.addEventListener('click', () => activateTab('inspector'));
        ui.send?.addEventListener('click', send);
        ui.undo?.addEventListener('click', undo);
        ui.redo?.addEventListener('click', redo);
        ui.newChat?.addEventListener('click', newConversation);
        ui.scopeMode?.addEventListener('change', () => {
            window.EditorAgentHost?.setScopeMode?.(ui.scopeMode.value);
            refreshScope();
            scheduleSessionSync();
        });
        ui.input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
            }
        });
        ui.messages?.addEventListener('click', (event) => {
            const suggestion = event.target.closest('[data-agent-prompt]');
            if (!suggestion || busy) return;
            ui.input.value = suggestion.dataset.agentPrompt || '';
            ui.input.focus();
        });
        window.addEventListener('yta:agent-context-changed', () => {
            refreshScope();
            scheduleSessionSync();
        });
        window.electronAPI?.onAgentProgress?.((progress) => {
            setProgress(progress?.percent, progress?.message);
            if (progress?.phase === 'complete') clearProgress(700);
        });

        refreshScope();
        refreshHistoryButtons();
        syncCapabilities();
        syncSession();
    }

    window.EditorAgentPanel = {
        open,
        openWithCurrentScope,
        refreshScope,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
})();
