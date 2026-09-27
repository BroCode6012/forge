#!/usr/bin/env node
// scripts/verify/remote-control.js
// ============================================================================
// The gate for agent remote control (MCP + REST). It proves, without Electron:
//   A  the tool catalog is well formed and every tool has an implementation
//   B  argument validation refuses what it should
//   C  the MCP protocol layer answers correctly (handshake, list, call, errors)
//   D  the control service refuses impossible requests (busy, no project, ...)
//   E  the HTTP front door is closed: no key -> 401, browser Origin -> 403,
//      oversized body -> 413, downloads confined, Range honored
//   F  the app is actually wired to it (main.js / preload.js / index.html /
//      the window bridge reusing the real Build/Render/Cancel functions)
//   G  access config defaults to OFF and to a loopback bind
// ============================================================================
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { TOOLS, getTool, validateArgs, toMcpTool, SERVER_INSTRUCTIONS } = require(path.join(ROOT, 'src/remote/tools'));
const { handleMcpPayload, negotiateProtocolVersion } = require(path.join(ROOT, 'src/remote/mcp'));
const { createControlService } = require(path.join(ROOT, 'src/remote/control-service'));
const { createRemoteServer } = require(path.join(ROOT, 'src/remote/server'));
const { buildOpenApi } = require(path.join(ROOT, 'src/remote/openapi'));
const { RemoteToolError } = require(path.join(ROOT, 'src/remote/errors'));
const accessConfig = require(path.join(ROOT, 'src/remote/access-config'));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// ── A. catalog ──────────────────────────────────────────────────────────────
console.log('\n=== A. tool catalog ===');
{
    const names = TOOLS.map((tool) => tool.name);
    ok('tool names are unique', new Set(names).size === names.length);
    ok('tool names are MCP-legal', names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
    ok('every tool is namespaced forge_', names.every((name) => name.startsWith('forge_')));
    ok('every tool has a title and a real description', TOOLS.every((tool) => tool.title && String(tool.description || '').length > 40));
    ok('every inputSchema is a closed object schema', TOOLS.every((tool) => (
        tool.inputSchema?.type === 'object' && tool.inputSchema.additionalProperties === false
    )));
    const readOnly = new Set(TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.name));
    ok('status/list/log tools are marked read-only', ['forge_get_status', 'forge_list_projects', 'forge_get_settings', 'forge_get_build_log', 'forge_list_videos'].every((name) => readOnly.has(name)));
    ok('no write tool claims read-only', !readOnly.has('forge_start_build') && !readOnly.has('forge_update_settings') && !readOnly.has('forge_render_video'));
    ok('cancel is flagged destructive', getTool('forge_cancel').destructive === true);
    const mcpShape = toMcpTool(TOOLS[0]);
    ok('MCP tool shape carries name/description/inputSchema/annotations', !!(mcpShape.name && mcpShape.description && mcpShape.inputSchema && mcpShape.annotations));
    ok('server instructions describe the build->render order', /forge_start_build[\s\S]*forge_render_video/.test(SERVER_INSTRUCTIONS));
}

// ── B. argument validation ──────────────────────────────────────────────────
console.log('\n=== B. argument validation ===');
{
    const openProject = getTool('forge_open_project');
    ok('missing required argument is caught', validateArgs(openProject, {}).some((problem) => /required/.test(problem)));
    ok('valid argument passes', validateArgs(openProject, { path: 'D:/projects/one' }).length === 0);
    ok('unknown argument is caught', validateArgs(openProject, { path: 'x', nope: 1 }).some((problem) => /unknown argument/.test(problem)));
    ok('wrong type is caught', validateArgs(openProject, { path: 42 }).some((problem) => /must be a string/.test(problem)));
    const build = getTool('forge_start_build');
    ok('enum is enforced', validateArgs(build, { repeatFrom: 'nope' }).some((problem) => /must be one of/.test(problem)));
    ok('enum accepts a listed value', validateArgs(build, { repeatFrom: 'media', forceFreshFootage: true }).length === 0);
    const log = getTool('forge_get_build_log');
    ok('numeric bounds are enforced', validateArgs(log, { lines: 5000 }).some((problem) => /at most/.test(problem)));
    ok('integers reject decimals', validateArgs(log, { lines: 2.5 }).some((problem) => /whole number/.test(problem)));
    const settings = getTool('forge_update_settings');
    ok('object argument is accepted', validateArgs(settings, { settings: { buildTheme: 'crime' } }).length === 0);
    ok('array instead of object is caught', validateArgs(settings, { settings: ['crime'] }).some((problem) => /must be a object|must be an object/.test(problem)));
    ok('long strings are caught', validateArgs(openProject, { path: 'x'.repeat(2000) }).some((problem) => /too long/.test(problem)));
}

// ── C. MCP protocol ─────────────────────────────────────────────────────────
console.log('\n=== C. MCP protocol ===');
{
    const calls = [];
    const ctx = {
        serverInfo: { name: 'forge', version: '1.0.0' },
        instructions: SERVER_INSTRUCTIONS,
        callTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'forge_cancel') throw new RemoteToolError('conflict', 'nothing to cancel');
            return { ok: true, echoed: args };
        },
    };
    const rpc = (method, params, id = 1) => handleMcpPayload({ jsonrpc: '2.0', id, method, params }, ctx);

    (async () => {
        const init = await rpc('initialize', { protocolVersion: '2025-03-26' });
        ok('initialize echoes a supported protocol version', init.result.protocolVersion === '2025-03-26');
        ok('initialize advertises tools capability', !!init.result.capabilities.tools);
        ok('initialize returns the workflow instructions', /forge_import_narration/.test(init.result.instructions));
        const unknownVersion = await rpc('initialize', { protocolVersion: '1999-01-01' });
        ok('unknown protocol version falls back to the newest', unknownVersion.result.protocolVersion === negotiateProtocolVersion(''));

        const list = await rpc('tools/list', {});
        ok('tools/list returns every tool', list.result.tools.length === TOOLS.length);

        const call = await rpc('tools/call', { name: 'forge_get_status', arguments: {} });
        ok('tools/call returns text content', call.result.content[0].type === 'text' && call.result.content[0].text.includes('"ok"'));
        ok('tools/call returns structuredContent', call.result.structuredContent.ok === true);
        ok('tools/call is not an error on success', call.result.isError === false);

        const badTool = await rpc('tools/call', { name: 'forge_nope', arguments: {} });
        ok('unknown tool is a JSON-RPC invalid-params error', badTool.error?.code === -32602);

        const badArgs = await rpc('tools/call', { name: 'forge_open_project', arguments: {} });
        ok('invalid arguments come back as a tool error the model can read', badArgs.result?.isError === true && /Invalid arguments/.test(badArgs.result.content[0].text));
        ok('invalid arguments never reach the implementation', !calls.some((entry) => entry.name === 'forge_open_project'));

        const refused = await rpc('tools/call', { name: 'forge_cancel', arguments: {} });
        ok('a refusal is reported as isError with its message', refused.result.isError === true && /nothing to cancel/.test(refused.result.content[0].text));

        const ping = await rpc('ping', {});
        ok('ping answers', ping.result && Object.keys(ping.result).length === 0);

        const unknownMethod = await rpc('resources/list', {});
        ok('unsupported method is method-not-found', unknownMethod.error?.code === -32601);

        const notification = await handleMcpPayload({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx);
        ok('notifications get no reply', notification === null);

        const batch = await handleMcpPayload([
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ], ctx);
        ok('a batch answers only the requests', Array.isArray(batch) && batch.length === 2);

        const malformed = await handleMcpPayload({ id: 3, method: 'ping' }, ctx);
        ok('a non-JSON-RPC message is rejected', malformed.error?.code === -32600);

        await runControlServiceChecks();
    })().catch((error) => {
        fail++;
        console.log(`  ❌ MCP checks threw — ${error.message}`);
        finish();
    });
}

// ── D. control service ──────────────────────────────────────────────────────
function makeService(overrides = {}) {
    const calls = [];
    const deps = {
        getProject: () => ({ dir: 'D:/projects/demo', name: 'demo', isDefaultWorkspace: false }),
        getBusy: () => null,
        askRenderer: async (command, args) => {
            calls.push({ command, args });
            if (command === 'status') return { projectOpen: true, busy: false };
            if (command === 'get_settings') return { settings: { buildTheme: 'crime' }, fields: {} };
            if (command === 'update_settings') return { applied: args.settings, rejected: [] };
            if (command === 'start_build') return { started: true, jobId: 'job-1', kind: 'build' };
            if (command === 'render') return { started: true, jobId: 'job-2' };
            if (command === 'cancel') return { message: 'Cancellation requested' };
            return {};
        },
        listRecentProjects: async () => [{ path: 'D:/projects/demo', name: 'demo', lastOpened: '2026-09-01T00:00:00.000Z' }],
        openProject: async () => ({ success: true, projectDir: 'D:/projects/demo' }),
        createProject: async () => ({ success: true, projectDir: 'D:/projects/new', projectName: 'new' }),
        importNarrationFromPath: async (p) => ({ success: true, path: p, name: path.basename(p), bytes: 1024 }),
        importNarrationFromUrl: async () => ({ success: true, path: 'D:/projects/demo/input/n.mp3', name: 'n.mp3' }),
        readBuildLog: async () => ({ file: 'D:/projects/demo/logs/build-summary-1.log', lines: ['one', 'two'] }),
        listVideos: async () => [{ name: 'hyperframes-1.mp4', bytes: 10, downloadPath: '/files/hyperframes-1.mp4' }],
        getServerInfo: () => ({ host: '127.0.0.1', port: 47821, enabled: true }),
        ...overrides,
    };
    return { service: createControlService(deps), calls, deps };
}

async function expectRefusal(label, promise, matcher) {
    try {
        await promise;
        ok(label, false, 'it was allowed');
    } catch (error) {
        ok(label, error instanceof RemoteToolError && matcher.test(error.message), error.message);
    }
}

async function runControlServiceChecks() {
    console.log('\n=== D. control service ===');
    const { service, calls } = makeService();
    const handlerNames = Object.keys(service.handlers).sort();
    ok('every catalogued tool has an implementation', JSON.stringify(handlerNames) === JSON.stringify(TOOLS.map((tool) => tool.name).sort()));

    const status = await service.callTool('forge_get_status', {});
    ok('status reports the open project and idle state', status.project.name === 'demo' && status.busy === 'idle' && status.window.ready === true);

    const projects = await service.callTool('forge_list_projects', {});
    ok('the open project is marked in the project list', projects.projects[0].isOpen === true);

    const build = await service.callTool('forge_start_build', { repeatFrom: 'media', forceFreshFootage: true });
    ok('start_build forwards the repeat options to the window', calls.some((entry) => entry.command === 'start_build' && entry.args.repeatFrom === 'media' && entry.args.forceFreshFootage === true));
    ok('start_build tells the agent to poll', /poll forge_get_status/.test(build.message));

    const render = await service.callTool('forge_render_video', {});
    ok('render defaults to the full video', calls.some((entry) => entry.command === 'render' && entry.args.section === 'full'));
    ok('render returns a job id', render.jobId === 'job-2');

    const imported = await service.callTool('forge_import_narration', { path: 'D:/audio/story.mp3' });
    ok('import tells the window to adopt the audio', calls.some((entry) => entry.command === 'adopt_audio' && entry.args.name === 'story.mp3'));
    ok('import returns the next step', /forge_start_build/.test(imported.message));

    await expectRefusal('import refuses both path and url', service.callTool('forge_import_narration', { path: 'a.mp3', url: 'https://x/a.mp3' }), /exactly one/);
    await expectRefusal('import refuses neither path nor url', service.callTool('forge_import_narration', {}), /exactly one/);

    const busy = makeService({ getBusy: () => 'build' }).service;
    await expectRefusal('a second build is refused while one runs', busy.callTool('forge_start_build', {}), /is running right now/);
    await expectRefusal('render is refused while a build runs', busy.callTool('forge_render_video', {}), /is running right now/);
    await expectRefusal('settings are refused while a build runs', busy.callTool('forge_update_settings', { settings: { buildTheme: 'crime' } }), /is running right now/);
    await expectRefusal('switching project is refused while a build runs', busy.callTool('forge_open_project', { path: 'D:/x' }), /is running right now/);
    await expectRefusal('import is refused while a build runs', busy.callTool('forge_import_narration', { path: 'a.mp3' }), /is running right now/);
    const busyStatus = await busy.callTool('forge_get_status', {});
    ok('status still answers while busy', busyStatus.busy === 'build');

    const empty = makeService({ getProject: () => ({ dir: 'D:/workspace', name: 'workspace', isDefaultWorkspace: true }) }).service;
    await expectRefusal('building without a project is refused', empty.callTool('forge_start_build', {}), /No project is open/);
    await expectRefusal('importing without a project is refused', empty.callTool('forge_import_narration', { path: 'a.mp3' }), /No project is open/);
    const emptyList = await empty.callTool('forge_list_projects', {});
    ok('the empty workspace is not reported as an open project', emptyList.openProject === null);

    const rejecting = makeService({
        askRenderer: async (command, args) => {
            if (command === 'update_settings') return { applied: {}, rejected: ['buildTheme: "neon" is not one of crime, history'] };
            return command === 'status' ? {} : {};
        },
    }).service;
    await expectRefusal('a rejected setting value is reported back', rejecting.callTool('forge_update_settings', { settings: { buildTheme: 'neon' } }), /not one of/);
    await expectRefusal('an empty settings object is refused', service.callTool('forge_update_settings', { settings: {} }), /at least one key/);

    const deaf = makeService({ askRenderer: async () => { throw new Error('no answer within 8s'); } }).service;
    await expectRefusal('a closed window is reported as unavailable', deaf.callTool('forge_get_settings', {}), /did not answer/);
    const deafStatus = await deaf.callTool('forge_get_status', {});
    ok('status survives a closed window', deafStatus.window.ready === false);

    const idleCancel = await makeService({ getBusy: () => null }).service.callTool('forge_cancel', {});
    ok('cancel with nothing running says so', idleCancel.cancelled === false && /Nothing was running/.test(idleCancel.message));

    const log = await service.callTool('forge_get_build_log', { lines: 2 });
    ok('the build log comes back with its file', log.lines.length === 2 && /build-summary/.test(log.file));

    const videos = await service.callTool('forge_list_videos', {});
    ok('rendered videos carry a download path', videos.videos[0].downloadPath === '/files/hyperframes-1.mp4');

    await expectRefusal('an unknown tool is refused', service.callTool('forge_nope', {}), /Unknown tool/);

    await runHttpChecks();
}

// ── E. HTTP front door ──────────────────────────────────────────────────────
async function runHttpChecks() {
    console.log('\n=== E. HTTP front door ===');
    const TOKEN = 'forge_test_key_0123456789';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remote-'));
    const videoFile = path.join(tempDir, 'video.mp4');
    fs.writeFileSync(videoFile, 'abcdefghij');
    const secretFile = path.join(tempDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'nope');

    const seen = [];
    const server = createRemoteServer({
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        serverInfo: { name: 'forge', version: 'test' },
        instructions: SERVER_INSTRUCTIONS,
        callTool: async (name, args) => {
            seen.push({ name, args });
            if (name === 'forge_cancel') throw new RemoteToolError('conflict', 'a build is running');
            return { ok: true, name };
        },
        resolveDownload: (name) => {
            if (name !== 'video.mp4') return null;
            return { filePath: videoFile, fileName: name, size: 10, contentType: 'video/mp4' };
        },
    });

    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const rpc = (method, params, id = 1) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

    try {
        ok('the server binds to loopback', server.host === '127.0.0.1' && Number.isInteger(server.port));

        const health = await fetch(`${base}/health`);
        ok('/health needs no key', health.status === 200 && (await health.json()).mcp === '/mcp');

        const noKey = await fetch(`${base}/api/tools`);
        ok('no key is refused', noKey.status === 401);
        ok('the refusal asks for a bearer key', /Bearer/.test(noKey.headers.get('www-authenticate') || ''));

        const wrongKey = await fetch(`${base}/api/tools`, { headers: { Authorization: 'Bearer forge_wrong_key_000000' } });
        ok('a wrong key is refused', wrongKey.status === 401);

        const headerKey = await fetch(`${base}/api/tools`, { headers: { 'X-Forge-Key': TOKEN } });
        ok('the X-Forge-Key header also works', headerKey.status === 200);

        const browser = await fetch(`${base}/api/tools`, { headers: { ...auth, Origin: 'https://evil.example' } });
        ok('a request from a web page is refused even with the key', browser.status === 403);

        const listed = await (await fetch(`${base}/api/tools`, { headers: auth })).json();
        ok('REST lists every tool', listed.tools.length === TOOLS.length);

        const called = await fetch(`${base}/api/tools/forge_get_status`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
        ok('REST calls a tool', called.status === 200 && (await called.json()).result.name === 'forge_get_status');

        const restBadArgs = await fetch(`${base}/api/tools/forge_open_project`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
        ok('REST validates arguments', restBadArgs.status === 400);

        const restUnknown = await fetch(`${base}/api/tools/forge_nope`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
        ok('REST rejects an unknown tool', restUnknown.status === 404);

        const restRefused = await fetch(`${base}/api/tools/forge_cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
        ok('a refusal keeps its meaning over REST (409)', restRefused.status === 409);

        const restGet = await fetch(`${base}/api/tools/forge_get_status`, { headers: auth });
        ok('REST tool routes are POST only', restGet.status === 405);

        const mcpInit = await (await fetch(`${base}/mcp`, rpc('initialize', { protocolVersion: '2025-06-18' }))).json();
        ok('MCP initialize works over HTTP', mcpInit.result.serverInfo.name === 'forge');

        const mcpCall = await (await fetch(`${base}/mcp`, rpc('tools/call', { name: 'forge_list_videos', arguments: {} }, 2))).json();
        ok('MCP tools/call works over HTTP', mcpCall.result.structuredContent.name === 'forge_list_videos');

        const mcpNotification = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        ok('a notification is accepted with 202 and no body', mcpNotification.status === 202);

        const mcpGet = await fetch(`${base}/mcp`, { headers: auth });
        ok('GET /mcp is not an open stream', mcpGet.status === 405);

        const badJson = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{oops' });
        ok('broken JSON returns a parse error', badJson.status === 400 && (await badJson.json()).error.code === -32700);

        const wrongType = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...auth }, body: '{}' });
        ok('non-JSON bodies are refused', wrongType.status === 415);

        const huge = await fetch(`${base}/api/tools/forge_get_status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }),
        }).catch(() => ({ status: 413 }));
        ok('an oversized body is rejected', huge.status === 413 || huge.status === 400);

        const schema = await fetch(`${base}/openapi.json`);
        const schemaBody = await schema.json();
        ok('the OpenAPI document is importable without a key', schema.status === 200 && schemaBody.openapi.startsWith('3.1'));
        ok('the OpenAPI document covers every tool', TOOLS.every((tool) => schemaBody.paths[`/api/tools/${tool.name}`]));
        ok('the OpenAPI document declares bearer auth', !!schemaBody.components.securitySchemes.bearerAuth);

        const download = await fetch(`${base}/files/video.mp4`, { headers: auth });
        ok('a rendered video downloads', download.status === 200 && (await download.text()) === 'abcdefghij');

        const ranged = await fetch(`${base}/files/video.mp4`, { headers: { ...auth, Range: 'bytes=2-4' } });
        ok('downloads support Range', ranged.status === 206 && (await ranged.text()) === 'cde');

        const traversal = await fetch(`${base}/files/${encodeURIComponent('../secret.txt')}`, { headers: auth });
        ok('path traversal is refused', traversal.status === 404);

        const unlistedFile = await fetch(`${base}/files/secret.txt`, { headers: auth });
        ok('a file outside the allowlist is refused', unlistedFile.status === 404);

        const anonDownload = await fetch(`${base}/files/video.mp4`);
        ok('downloads need the key too', anonDownload.status === 401);

        server.setToken('forge_rotated_key_987654321');
        const afterRotation = await fetch(`${base}/api/tools`, { headers: auth });
        ok('the old key stops working after rotation', afterRotation.status === 401);
        const withNewKey = await fetch(`${base}/api/tools`, { headers: { Authorization: 'Bearer forge_rotated_key_987654321' } });
        ok('the new key works after rotation', withNewKey.status === 200);
    } finally {
        await server.stop();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    runWiringChecks();
    runAccessConfigChecks();
    finish();
}

// ── F. wiring ───────────────────────────────────────────────────────────────
function runWiringChecks() {
    console.log('\n=== F. app wiring ===');
    const main = read('main.js');
    const preload = read('preload.js');
    const html = read('ui/index.html');
    const app = read('ui/js/app.js');
    const bridge = read('ui/js/remote-control.js');
    const panel = read('ui/js/agent-access-panel.js');

    ok('main.js starts the server from the saved setting', main.includes('_startRemoteControlServer()'));
    ok('main.js stops the server on quit', main.includes('void _stopRemoteControlServer();'));
    ok('main.js answers window commands', main.includes("ipcMain.handle('remote-command-result'"));
    ok('main.js exposes access status + switch', main.includes("ipcMain.handle('remote-access-status'") && main.includes("ipcMain.handle('remote-access-set'"));
    ok('window replies are bound to the main window', main.includes('event.sender.id !== mainWindow.webContents.id'));
    ok('window replies are size-bounded', main.includes('_boundedPlainObject(payload.result ?? {}, 2 * 1024 * 1024)'));
    ok('downloads are confined to the project output folder', main.includes('_resolveExistingFileWithin([OUTPUT_PATH]'));
    ok('narration import has ONE implementation', main.includes('async function _importNarrationFile(sourcePath)')
        && main.includes("ipcMain.handle('import-audio-file', async (_event, sourcePath) => _importNarrationFile(sourcePath));")
        && main.includes('importNarrationFromPath: async (sourcePath) => _importNarrationFile(sourcePath)'));
    ok('URL narration import goes through the SSRF-hardened downloader', main.includes("require('./src/security/safe-download')") && main.includes('requestSafeStream'));
    ok('the agent server never runs in a second project window', main.includes('if (_isProjectChildInstance)'));

    ok('preload exposes the command channel', preload.includes("onRemoteCommand: subscribe('remote-command'") && preload.includes("remoteCommandResult:"));
    ok('preload exposes the access controls', preload.includes('remoteAccessStatus:') && preload.includes('remoteAccessSet:'));

    ok('index.html loads the window bridge and the panel', html.includes('js/remote-control.js') && html.includes('js/agent-access-panel.js'));
    ok('the access switch exists in the UI', html.includes('id="agent-access-toggle"') && html.includes('id="agent-access-key"'));

    // The whole point: an agent presses the same controls a human does.
    ok('the bridge builds through the real generateVideo()', /generateVideo\(repeatStep \? \{ repeatStep: true \} : \{\}\)/.test(bridge));
    ok('the bridge renders through the real renderVideo()', bridge.includes('Promise.resolve(renderVideo())'));
    ok('the bridge cancels through the real cancelProcess()', bridge.includes('await cancelProcess();'));
    ok('the bridge adopts audio through the real import path', bridge.includes('adoptImportedAudio(name, audioPath)'));
    ok('the bridge writes settings into the real controls', bridge.includes("fire(el, 'change')") && bridge.includes('window.SETTINGS_SCHEMA'));
    ok('the bridge never spawns its own build', !/runBuild\(/.test(bridge) && !/hyperframesRender\(/.test(bridge));
    ok('the bridge refuses unknown values against the live options', bridge.includes('is not one of'));
    ok('long jobs answer immediately with a job id', bridge.includes('return { started: true, jobId: job.id'));

    ok('app.js shares the audio-adoption path', app.includes('function adoptImportedAudio(name, filePath)') && app.includes('adoptImportedAudio(file.name, filePath);'));
    ok('generateVideo reports its outcome', app.includes('return { success: true, elapsed: genTime, scenes: state.scenes.length };'));
    ok('renderVideo reports its outcome', app.includes("return { success: true, outputPath: result.outputPath || '', elapsed: renderTime };"));
    ok('the progress bar text is readable by an agent', app.includes('state.lastProgress = { percent, message'));

    ok('the panel reads its address and key from main', panel.includes('remoteAccessStatus()') && !/47821/.test(panel));
    ok('the panel can hand out a ready Claude Code command', panel.includes('claude mcp add --transport http forge'));
}

// ── G. access config ────────────────────────────────────────────────────────
function runAccessConfigChecks() {
    console.log('\n=== G. access config ===');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-access-'));
    const previous = { ...process.env };
    try {
        delete process.env.FORGE_AGENT_SERVER;
        delete process.env.FORGE_AGENT_PORT;
        delete process.env.FORGE_AGENT_HOST;

        const fresh = accessConfig.load(dir);
        ok('agent access is OFF until the user turns it on', fresh.enabled === false);
        ok('a fresh install gets a strong key', /^forge_[A-Za-z0-9_-]{40,}$/.test(fresh.token));
        ok('the default bind is loopback', fresh.host === '127.0.0.1');
        ok('the default port is the documented one', fresh.port === accessConfig.DEFAULT_PORT);

        accessConfig.save(dir, { ...fresh, enabled: true, port: 50000 });
        const reloaded = accessConfig.load(dir);
        ok('the switch and port survive a restart', reloaded.enabled === true && reloaded.port === 50000);
        ok('the key survives a restart', reloaded.token === fresh.token);
        ok('the key file is written next to the app settings', fs.existsSync(path.join(dir, accessConfig.FILE_NAME)));

        accessConfig.save(dir, { ...reloaded, port: 99999 });
        ok('an impossible port falls back to the default', accessConfig.load(dir).port === accessConfig.DEFAULT_PORT);

        process.env.FORGE_AGENT_SERVER = '0';
        ok('the environment can force it off', accessConfig.load(dir).enabled === false);
        process.env.FORGE_AGENT_SERVER = '1';
        const forced = accessConfig.load(dir);
        ok('the environment can force it on', forced.enabled === true && forced.forcedByEnv === true);
        delete process.env.FORGE_AGENT_SERVER;

        ok('loopback is an allowed bind', accessConfig.isAllowedBindHost('127.0.0.1') && accessConfig.isAllowedBindHost('::1'));
        ok('a Tailscale address is an allowed bind', accessConfig.isAllowedBindHost('100.101.102.103'));
        ok('a LAN address is not an allowed bind', !accessConfig.isAllowedBindHost('192.168.1.10'));
        ok('every-interface is not an allowed bind', !accessConfig.isAllowedBindHost('0.0.0.0'));
        process.env.FORGE_AGENT_HOST = '192.168.1.10';
        ok('a LAN bind is ignored unless explicitly allowed', accessConfig.resolveBindHost() === '127.0.0.1');
        process.env.FORGE_AGENT_ALLOW_NETWORK = '1';
        ok('a LAN bind is possible only with the explicit override', accessConfig.resolveBindHost() === '192.168.1.10');

        const doc = buildOpenApi({ serverUrl: 'http://127.0.0.1:47821' });
        ok('the OpenAPI document names the server', doc.servers[0].url === 'http://127.0.0.1:47821');
    } finally {
        for (const key of ['FORGE_AGENT_SERVER', 'FORGE_AGENT_PORT', 'FORGE_AGENT_HOST', 'FORGE_AGENT_ALLOW_NETWORK']) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function finish() {
    console.log(`\n${fail ? '❌' : '✅'} remote control: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

assert.ok(TOOLS.length > 0, 'the tool catalog must not be empty');
