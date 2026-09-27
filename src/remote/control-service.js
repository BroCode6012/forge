// src/remote/control-service.js
// ============================================================================
// What each tool in src/remote/tools.js actually DOES — the one place that
// decides whether a request is possible right now and who carries it out.
//
// Two kinds of work:
//   main-process    project switching, narration import, logs, rendered files
//   renderer        anything the user would do in the window (settings, Build,
//                   Render, Cancel) — forwarded to ui/js/remote-control.js so an
//                   agent presses exactly the same buttons a human does, and
//                   nothing in the build path needs an agent-only branch.
//
// Every capability arrives through `deps`, so main.js stays a thin adapter and
// the verify harness can drive the whole surface with fakes.
// ============================================================================
'use strict';

const { RemoteToolError } = require('./errors');

const RENDERER_TIMEOUTS = Object.freeze({
    status: 8000,
    get_settings: 8000,
    update_settings: 15000,
    start_build: 30000,
    render: 30000,
    cancel: 30000,
    adopt_audio: 15000,
    save_project: 20000,
});

function _busyError(busy) {
    return new RemoteToolError(
        'conflict',
        `A ${busy} is running right now. Wait for it to finish (poll forge_get_status) or call forge_cancel.`
    );
}

function createControlService(deps) {
    const required = [
        'getProject', 'getBusy', 'askRenderer', 'listRecentProjects', 'openProject',
        'createProject', 'importNarrationFromPath', 'importNarrationFromUrl',
        'readBuildLog', 'listVideos', 'getServerInfo',
    ];
    for (const name of required) {
        if (typeof deps?.[name] !== 'function') throw new Error(`createControlService: missing dependency ${name}`);
    }

    async function ask(command, args = {}) {
        try {
            return await deps.askRenderer(command, args, { timeoutMs: RENDERER_TIMEOUTS[command] || 10000 });
        } catch (error) {
            if (error instanceof RemoteToolError) throw error;
            throw new RemoteToolError('unavailable', `The Forge window did not answer (${error?.message || error}). Make sure the app is open on the user's PC.`);
        }
    }

    function requireIdle() {
        const busy = deps.getBusy();
        if (busy) throw _busyError(busy);
    }

    function requireProject() {
        const project = deps.getProject();
        if (!project || project.isDefaultWorkspace || !project.dir) {
            throw new RemoteToolError('conflict', 'No project is open. Call forge_list_projects, then forge_open_project — or forge_create_project.');
        }
        return project;
    }

    const handlers = {
        async forge_get_status() {
            const project = deps.getProject() || {};
            const busy = deps.getBusy();
            const server = deps.getServerInfo();
            let window = { ready: false, error: 'The Forge window is not responding.' };
            try {
                window = { ready: true, ...(await ask('status')) };
            } catch (error) {
                window = { ready: false, error: error.message };
            }
            return {
                ok: true,
                app: 'Forge',
                busy: busy || 'idle',
                project: {
                    name: project.name || null,
                    folder: project.dir || null,
                    isEmptyWorkspace: !!project.isDefaultWorkspace,
                },
                window,
                server: { host: server.host, port: server.port },
            };
        },

        async forge_list_projects() {
            const project = deps.getProject() || {};
            const recent = await deps.listRecentProjects();
            return {
                ok: true,
                openProject: project.isDefaultWorkspace ? null : { name: project.name, folder: project.dir },
                projects: recent.map((entry) => ({
                    name: entry.name,
                    folder: entry.path,
                    lastOpened: entry.lastOpened || null,
                    isOpen: !!project.dir && String(entry.path).toLowerCase() === String(project.dir).toLowerCase(),
                })),
            };
        },

        async forge_open_project(args) {
            requireIdle();
            // Commit whatever is on screen first; a switch reloads the window.
            try { await ask('save_project'); } catch (_) { /* nothing worth saving */ }
            const result = await deps.openProject(String(args.path));
            if (!result?.success) {
                throw new RemoteToolError(result?.alreadyOpen ? 'conflict' : 'bad_request', result?.error || 'The project could not be opened.');
            }
            return {
                ok: true,
                message: 'Project opened. The window reloads — wait a few seconds, then call forge_get_status.',
                project: { name: result.projectName || null, folder: result.projectDir },
            };
        },

        async forge_create_project(args) {
            requireIdle();
            try { await ask('save_project'); } catch (_) { /* nothing worth saving */ }
            const result = await deps.createProject({ name: String(args.name), parentFolder: args.parentFolder ? String(args.parentFolder) : '' });
            if (!result?.success) throw new RemoteToolError('bad_request', result?.error || 'The project could not be created.');
            return {
                ok: true,
                message: 'Project created and opened. The window reloads — wait a few seconds, then call forge_get_status, then forge_import_narration.',
                project: { name: result.projectName || args.name, folder: result.projectDir },
            };
        },

        async forge_import_narration(args) {
            requireIdle();
            requireProject();
            const hasPath = typeof args.path === 'string' && !!args.path.trim();
            const hasUrl = typeof args.url === 'string' && !!args.url.trim();
            if (hasPath === hasUrl) {
                throw new RemoteToolError('bad_request', 'Give exactly one of "path" (a file on this PC) or "url" (a public https link).');
            }
            const imported = hasPath
                ? await deps.importNarrationFromPath(args.path.trim())
                : await deps.importNarrationFromUrl(args.url.trim());
            if (!imported?.success) throw new RemoteToolError('bad_request', imported?.error || 'The narration could not be imported.');
            // Tell the window about it exactly as the drop zone would.
            await ask('adopt_audio', { name: imported.name, path: imported.path });
            return {
                ok: true,
                message: 'Narration imported. Next: forge_get_settings / forge_update_settings, then forge_start_build.',
                narration: { name: imported.name, path: imported.path, bytes: imported.bytes || null },
            };
        },

        async forge_get_settings() {
            requireProject();
            const settings = await ask('get_settings');
            return { ok: true, ...settings };
        },

        async forge_update_settings(args) {
            requireIdle();
            requireProject();
            const settings = args.settings;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length) {
                throw new RemoteToolError('bad_request', '"settings" must be an object with at least one key from forge_get_settings.');
            }
            const result = await ask('update_settings', { settings });
            if (result?.rejected?.length) {
                throw new RemoteToolError('bad_request', `Could not apply: ${result.rejected.join('; ')}`, result);
            }
            return { ok: true, applied: result?.applied || {}, message: 'Settings updated.' };
        },

        async forge_start_build(args) {
            requireIdle();
            requireProject();
            const result = await ask('start_build', {
                repeatFrom: args.repeatFrom || '',
                forceFreshFootage: !!args.forceFreshFootage,
            });
            if (!result?.started) throw new RemoteToolError('conflict', result?.error || 'The build could not be started.');
            return {
                ok: true,
                started: true,
                jobId: result.jobId,
                kind: result.kind,
                message: 'Build started. It usually takes 20-90 minutes — poll forge_get_status every few minutes.',
            };
        },

        async forge_render_video(args) {
            requireIdle();
            requireProject();
            const result = await ask('render', { section: args.section || 'full' });
            if (!result?.started) throw new RemoteToolError('conflict', result?.error || 'The render could not be started.');
            return {
                ok: true,
                started: true,
                jobId: result.jobId,
                message: 'Render started. Poll forge_get_status, then call forge_list_videos when it is done.',
            };
        },

        async forge_cancel() {
            const busy = deps.getBusy();
            const result = await ask('cancel');
            return {
                ok: true,
                cancelled: !!busy,
                message: busy ? `Cancelling the ${busy}.` : 'Nothing was running.',
                detail: result?.message || null,
            };
        },

        async forge_get_build_log(args) {
            requireProject();
            const lines = Number.isInteger(args.lines) ? args.lines : 80;
            const log = await deps.readBuildLog(lines);
            if (!log || !log.file) {
                return { ok: true, file: null, lines: [], message: 'No build log yet for this project.' };
            }
            return { ok: true, file: log.file, updatedAt: log.updatedAt || null, lines: log.lines };
        },

        async forge_list_videos() {
            requireProject();
            const videos = await deps.listVideos();
            return {
                ok: true,
                count: videos.length,
                videos,
                message: videos.length
                    ? 'Download a file with GET <server>/files/<name> and the same access key.'
                    : 'Nothing rendered yet — run forge_render_video after a build.',
            };
        },
    };

    async function callTool(name, args = {}, meta = {}) {
        const handler = handlers[name];
        if (!handler) throw new RemoteToolError('not_found', `Unknown tool: ${name}`);
        return handler(args || {}, meta);
    }

    return { callTool, handlers };
}

module.exports = { createControlService, RENDERER_TIMEOUTS };
