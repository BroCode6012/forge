// ui/js/remote-control.js
// ============================================================================
// The window half of agent remote control. The main process forwards an outside
// agent's request here (`remote-command`) and this answers on the same id.
//
// Rule of the file: an agent presses the SAME controls a human does.
// - settings are written into their real DOM controls and the app's own change
//   handlers run, so persistence and every dependent UI sync happen as usual
// - a build calls generateVideo(), a render calls renderVideo(), a cancel calls
//   cancelProcess() — no parallel build path exists to fall out of date
// Long jobs are started, not awaited: the reply comes back immediately with a
// job id and the agent polls forge_get_status.
//
// Loaded after app.js in ui/index.html, so state/elements/generateVideo/... are
// the live objects from the editor.
// ============================================================================
(() => {
    'use strict';

    let jobSeq = 0;
    let lastJob = null;

    const api = () => window.electronAPI;

    function fire(el, type) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
    }

    function plain(value) {
        // Everything crossing IPC must be structured-clone safe.
        return JSON.parse(JSON.stringify(value === undefined ? {} : value));
    }

    function beginJob(kind) {
        lastJob = {
            id: `job-${Date.now().toString(36)}-${++jobSeq}`,
            kind,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
            outputPath: null,
        };
        return lastJob;
    }

    function finishJob(job, result) {
        if (!job) return;
        job.finishedAt = new Date().toISOString();
        if (result?.success) {
            job.status = 'succeeded';
            if (result.outputPath) job.outputPath = result.outputPath;
            if (result.elapsed) job.elapsed = result.elapsed;
            if (Number.isFinite(result.scenes)) job.scenes = result.scenes;
        } else if (result?.cancelled) {
            job.status = 'cancelled';
            job.error = 'Cancelled';
        } else {
            job.status = 'failed';
            job.error = String(result?.error || 'Unknown error');
        }
    }

    function managedSettings() {
        const schema = window.SETTINGS_SCHEMA;
        if (!schema?.SETTINGS) return [];
        return schema.SETTINGS.filter((setting) => setting.el && !setting.deprecated);
    }

    function describeControl(el) {
        if (el.tagName === 'SELECT') {
            return {
                type: 'choice',
                allowed: Array.from(el.options).map((option) => ({
                    value: option.value,
                    label: (option.textContent || '').trim().slice(0, 140),
                })),
            };
        }
        if (el.type === 'checkbox') return { type: 'boolean' };
        return { type: 'text' };
    }

    function readSettings() {
        const settings = {};
        const fields = {};
        for (const setting of managedSettings()) {
            const el = document.getElementById(setting.el);
            if (!el) continue;
            settings[setting.key] = el.type === 'checkbox' ? !!el.checked : el.value;
            fields[setting.key] = { group: setting.group || 'Build', ...describeControl(el) };
        }
        settings.videoTitle = state.videoTitle || '';
        fields.videoTitle = { group: 'Project', type: 'text' };
        settings.aiInstructions = state.aiInstructions || '';
        fields.aiInstructions = {
            group: 'Project',
            type: 'text',
            note: 'Plain-English orders that steer the whole build, e.g. "cinematic, no text cards".',
        };
        return { settings, fields };
    }

    function writeSettings(input) {
        const applied = {};
        const rejected = [];
        for (const [key, value] of Object.entries(input || {})) {
            if (key === 'videoTitle' || key === 'aiInstructions') {
                const el = key === 'videoTitle' ? elements.videoTitle : elements.aiInstructions;
                if (!el) { rejected.push(`${key}: this control is not available`); continue; }
                el.value = String(value ?? '');
                fire(el, 'input');
                fire(el, 'change');
                applied[key] = el.value;
                continue;
            }
            const setting = managedSettings().find((entry) => entry.key === key);
            if (!setting) { rejected.push(`${key}: unknown setting`); continue; }
            const el = document.getElementById(setting.el);
            if (!el) { rejected.push(`${key}: this control is not available`); continue; }
            if (el.type === 'checkbox') {
                el.checked = value === true || value === 'true';
                fire(el, 'change');
                applied[key] = el.checked;
                continue;
            }
            const next = String(value ?? '');
            if (el.tagName === 'SELECT') {
                const allowed = Array.from(el.options).map((option) => option.value);
                if (!allowed.includes(next)) {
                    rejected.push(`${key}: "${next}" is not one of ${allowed.join(', ')}`);
                    continue;
                }
            }
            el.value = next;
            fire(el, 'input');
            fire(el, 'change');
            applied[key] = el.value;
        }
        return { applied, rejected };
    }

    function status() {
        const progress = state.lastProgress
            ? {
                percent: state.lastProgress.percent,
                step: state.lastProgress.message || '',
                secondsAgo: Math.round((Date.now() - state.lastProgress.at) / 1000),
            }
            : null;
        return {
            projectOpen: !!state.hasProject,
            videoTitle: state.videoTitle || '',
            narration: state.audioFile ? { name: state.audioFile.name, path: state.audioFile.path } : null,
            plan: state.videoPlan
                ? { scenes: state.scenes.length, seconds: Math.round(state.totalDuration || 0) }
                : null,
            busy: !!state.isProcessing,
            progress,
            lastJob,
            inOutMarks: { in: state.inPoint, out: state.outPoint },
            canBuild: !!(state.hasProject && state.audioFile?.path && !state.isProcessing),
            canRender: !!(state.videoPlan && !state.isProcessing),
        };
    }

    async function startBuild(args) {
        if (state.isProcessing) return { started: false, error: 'A build or render is already running' };
        if (!state.hasProject) return { started: false, error: 'No project is open' };
        if (!state.audioFile?.path) return { started: false, error: 'Import the narration first with forge_import_narration' };

        const repeatFrom = String(args?.repeatFrom || '');
        let repeatStep = false;
        if (repeatFrom) {
            if (!state.videoPlan) return { started: false, error: 'Nothing to repeat yet — run a full build first (omit repeatFrom)' };
            const el = elements.repeatFromStep;
            if (!el) return { started: false, error: 'The Repeat From Step control is not available' };
            const allowed = Array.from(el.options).map((option) => option.value);
            if (!allowed.includes(repeatFrom)) {
                return { started: false, error: `repeatFrom must be one of ${allowed.join(', ')}` };
            }
            el.value = repeatFrom;
            fire(el, 'change');
            if (elements.forceFreshFootage) {
                elements.forceFreshFootage.checked = repeatFrom === 'media' && !!args?.forceFreshFootage;
                fire(elements.forceFreshFootage, 'change');
            }
            repeatStep = true;
        }

        const job = beginJob(repeatFrom ? `build (repeat from ${repeatFrom})` : 'build');
        Promise.resolve(generateVideo(repeatStep ? { repeatStep: true } : {}))
            .then((result) => finishJob(job, result))
            .catch((error) => finishJob(job, { success: false, error: error?.message || String(error) }));
        return { started: true, jobId: job.id, kind: job.kind };
    }

    async function startRender(args) {
        if (state.isProcessing) return { started: false, error: 'A build or render is already running' };
        if (!state.videoPlan) return { started: false, error: 'No video plan yet — run forge_start_build first' };
        const section = args?.section === 'in-out' ? 'in-out' : 'full';
        if (section === 'full' && (state.inPoint !== null || state.outPoint !== null)) {
            clearInOutPoints();
        }
        const job = beginJob(section === 'in-out' ? 'render (In/Out section)' : 'render');
        Promise.resolve(renderVideo())
            .then((result) => finishJob(job, result))
            .catch((error) => finishJob(job, { success: false, error: error?.message || String(error) }));
        return { started: true, jobId: job.id, kind: job.kind };
    }

    const commands = {
        status: async () => status(),
        get_settings: async () => readSettings(),
        update_settings: async (args) => {
            if (state.isProcessing) return { applied: {}, rejected: ['a build or render is running'] };
            return writeSettings(args?.settings);
        },
        start_build: (args) => startBuild(args),
        render: (args) => startRender(args),
        cancel: async () => {
            if (!state.isProcessing) return { message: 'Nothing was running' };
            await cancelProcess();
            return { message: 'Cancellation requested' };
        },
        adopt_audio: async (args) => {
            const name = String(args?.name || '');
            const audioPath = String(args?.path || '');
            if (!name || !audioPath) return { adopted: false, error: 'name and path are required' };
            adoptImportedAudio(name, audioPath);
            return { adopted: true };
        },
        save_project: async () => {
            if (!state.hasProject || !state.videoPlan) return { saved: false, reason: 'nothing to save' };
            const result = await saveProject(true);
            return { saved: !!result?.success, error: result?.error || null };
        },
    };

    function init() {
        const bridge = api();
        if (!bridge?.onRemoteCommand || !bridge?.remoteCommandResult) return;
        bridge.onRemoteCommand(async (payload) => {
            const requestId = payload?.requestId;
            if (!requestId) return;
            const handler = commands[payload?.command];
            try {
                if (!handler) throw new Error(`Unknown window command: ${payload?.command}`);
                const result = await handler(payload.args || {});
                await bridge.remoteCommandResult({ requestId, result: plain(result) });
            } catch (error) {
                await bridge.remoteCommandResult({ requestId, error: String(error?.message || error) });
            }
        });
        console.log('[Remote] window command bridge ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
