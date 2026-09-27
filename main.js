/**
 * Forge - Electron Main Process
 * This file creates the desktop app window and bridges the UI to Node.js
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, protocol, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const { execSync, execFileSync, spawn, exec, execFile } = require('child_process');
const { Readable } = require('stream');
const projectStore = require('./src/project/project-store');

app.enableSandbox();

// Resolve reloadable runtime modules up front so folder moves fail fast and are
// covered by scripts/verify/require-paths.js instead of being swallowed later.
const RUNTIME_CONFIG_MODULE_PATHS = [
    require.resolve('./src/settings/config'),
    require.resolve('./src/brain/ai-provider'),
];

// DevTools protocol is test/development-only. Production launches never expose
// a predictable unauthenticated debugging port.
if (/^(1|true|on)$/i.test(String(process.env.YTA_REMOTE_DEBUG || '').trim())) {
    const requestedPort = Number(process.env.YTA_REMOTE_DEBUG_PORT || 9223);
    const debugPort = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
        ? requestedPort
        : 9223;
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
}

// ========================================
// Project Directory Resolution
// ========================================
// Parse --project=<path> or .fvp file path from command line args
const APP_ROOT = __dirname;  // The app's install directory (code, node_modules, assets)
if (process.env.YTA_TEST_USER_DATA_DIR
    && (
        /^(1|true|on)$/i.test(String(process.env.YTA_REMOTE_DEBUG || '').trim())
        || /^(1|true|on)$/i.test(String(process.env.YTA_ALLOW_TEST_USER_DATA_DIR || '').trim())
    )) {
    app.setPath('userData', path.resolve(process.env.YTA_TEST_USER_DATA_DIR));
}
const USER_DATA_DIR = app.getPath('userData');
const USER_ENV_PATH = path.join(USER_DATA_DIR, '.env');
const DEFAULT_WORKSPACE_DIR = path.join(USER_DATA_DIR, 'workspace');
process.env.YTA_USER_DATA_DIR = USER_DATA_DIR;
process.env.YTA_USER_ENV_PATH = USER_ENV_PATH;
let PROJECT_DIR = DEFAULT_WORKSPACE_DIR;
let PROJECT_FILE_PATH = null;
let hasExplicitProject = false;
let initialProjectOpenError = null;
const _hardenedRendererSessions = new WeakSet();
const _rendererRoles = new Map();
const _selectedFileGrants = new Map();
const _selectedDirectoryGrants = new Map();

const IPC_ROLE_CHANNELS = Object.freeze({
    startup: new Set([
        'startup-create-project',
        'startup-open-project-folder',
        'startup-open-project-file',
        'startup-cancel',
    ]),
    'footage-resources': new Set([
        'footage-resources-get',
        'footage-resources-set',
        'qwen-pool-status',
        'qwen-pool-reset',
        'qwen-vision-keys-status',
        'qwen-vision-keys-save',
        'vision-health-status',
        'vision-health-live-check',
        'resource-env-status',
        'resource-env-save',
        'resource-env-clean',
        'resource-env-live-check',
        'cloud-account-slots-status',
        'cloud-account-slots-save',
        'cloud-account-slot-check',
    ]),
    'qa-studio': new Set([
        'load-video-plan',
        'load-project-file',
        'get-project-info',
        'load-qa-results',
        'save-qa-results',
        'push-plan-to-main',
        'save-video-plan',
        'qa-pre-crop-media',
        'get-scene-media-path',
        'get-file-url',
        'get-background-url',
        'get-country-geojson',
        'start-webgl-export',
        'export-frames-batch',
        'finish-webgl-export',
        'cancel-webgl-export',
        'cancel-process',
        'qa-agent-init-log',
        'qa-agent-set-provider',
        'qa-agent-analyze-scene',
        'qa-agent-log',
        'qa-replace-scene-media',
        'qa-chat-send',
    ]),
    'qa-chat': new Set([
        'load-video-plan',
        'qa-chat-niches',
        'qa-chat-send',
    ]),
    'style-studio': new Set([
        'pick-video-file',
        'style-studio-start',
        'style-studio-add-video',
        'style-studio-chat',
        'style-studio-analyze-script',
        'style-studio-extract-profile',
        'style-studio-save-profile',
        'style-studio-end-session',
        'style-studio-session-info',
        'style-studio-set-code-access',
        'style-studio-set-project-context',
        'style-studio-check-saved',
        'style-studio-restore',
        'style-studio-discard-saved',
        'style-studio-load-memory',
        'style-studio-save-memory',
        'style-studio-delete-memory',
        'style-studio-clear-memory',
        'style-studio-pick-audio',
        'style-studio-transcribe-audio',
        'style-studio-get-transcript-info',
    ]),
});

const _registerIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => _registerIpcHandle(channel, async (event, ...args) => {
    const role = _rendererRoles.get(event.sender.id);
    const allowed = role === 'main' || IPC_ROLE_CHANNELS[role]?.has(channel);
    if (!allowed) {
        console.warn(`[IPC] denied channel="${channel}" sender=${event.sender.id} role=${role || 'unknown'}`);
        throw new Error('IPC channel is not available to this window');
    }
    return listener(event, ...args);
});

function _isTrustedRendererNavigation(rawUrl) {
    try {
        const target = new URL(String(rawUrl || ''));
        if (target.protocol !== 'file:') return false;
        const uiRoot = pathToFileURL(path.join(APP_ROOT, 'ui') + path.sep).href.toLowerCase();
        return target.href.toLowerCase().startsWith(uiRoot);
    } catch (_) {
        return false;
    }
}

function hardenRendererWindow(win, role) {
    const contents = win?.webContents;
    if (!contents) return;
    _rendererRoles.set(contents.id, role);
    contents.once('destroyed', () => {
        _rendererRoles.delete(contents.id);
        _selectedFileGrants.delete(contents.id);
        _selectedDirectoryGrants.delete(contents.id);
    });

    // Renderer windows never need to create child windows. External links use
    // the explicit, validated open-external IPC path instead.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
        if (!_isTrustedRendererNavigation(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());

    const rendererSession = contents.session;
    if (rendererSession && !_hardenedRendererSessions.has(rendererSession)) {
        _hardenedRendererSessions.add(rendererSession);
        rendererSession.setPermissionCheckHandler(() => false);
        rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
        if (typeof rendererSession.setDevicePermissionHandler === 'function') {
            rendererSession.setDevicePermissionHandler(() => false);
        }
    }
}

function _isPathWithin(rootPath, candidatePath) {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    if (process.platform === 'win32') {
        const rootLower = root.toLowerCase();
        const candidateLower = candidate.toLowerCase();
        return candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep);
    }
    return candidate === root || candidate.startsWith(root + path.sep);
}

function _resolveExistingFileWithin(roots, candidatePath) {
    try {
        const resolved = path.resolve(String(candidatePath || ''));
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
        const realCandidate = fs.realpathSync.native(resolved);
        for (const rootPath of roots) {
            if (!rootPath || !fs.existsSync(rootPath)) continue;
            const realRoot = fs.realpathSync.native(rootPath);
            if (_isPathWithin(realRoot, realCandidate)) return realCandidate;
        }
    } catch (_) {
        return null;
    }
    return null;
}

function _grantSelectedFile(event, candidatePath, ttlMs = 30 * 60 * 1000) {
    try {
        const realPath = fs.realpathSync.native(candidatePath);
        if (!fs.statSync(realPath).isFile()) return null;
        let grants = _selectedFileGrants.get(event.sender.id);
        if (!grants) {
            grants = new Map();
            _selectedFileGrants.set(event.sender.id, grants);
        }
        grants.set(process.platform === 'win32' ? realPath.toLowerCase() : realPath, Date.now() + ttlMs);
        return realPath;
    } catch (_) {
        return null;
    }
}

function _resolveGrantedFile(event, candidatePath) {
    try {
        const realPath = fs.realpathSync.native(candidatePath);
        const key = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
        const grants = _selectedFileGrants.get(event.sender.id);
        const expiresAt = grants?.get(key) || 0;
        if (expiresAt < Date.now()) {
            grants?.delete(key);
            return null;
        }
        return fs.statSync(realPath).isFile() ? realPath : null;
    } catch (_) {
        return null;
    }
}

function _grantSelectedDirectory(event, candidatePath, ttlMs = 30 * 60 * 1000) {
    try {
        const realPath = fs.realpathSync.native(candidatePath);
        if (!fs.statSync(realPath).isDirectory()) return null;
        let grants = _selectedDirectoryGrants.get(event.sender.id);
        if (!grants) {
            grants = new Map();
            _selectedDirectoryGrants.set(event.sender.id, grants);
        }
        grants.set(process.platform === 'win32' ? realPath.toLowerCase() : realPath, Date.now() + ttlMs);
        return realPath;
    } catch (_) {
        return null;
    }
}

function _resolveGrantedDirectory(event, candidatePath) {
    try {
        const realPath = fs.realpathSync.native(candidatePath);
        const key = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
        const grants = _selectedDirectoryGrants.get(event.sender.id);
        const expiresAt = grants?.get(key) || 0;
        if (expiresAt < Date.now()) {
            grants?.delete(key);
            return null;
        }
        return fs.statSync(realPath).isDirectory() ? realPath : null;
    } catch (_) {
        return null;
    }
}

function _projectReadableRoots() {
    return [
        INPUT_PATH,
        OUTPUT_PATH,
        TEMP_PATH,
        PUBLIC_PATH,
        path.join(PROJECT_DIR, 'assets'),
        path.join(PROJECT_DIR, 'hyperframes'),
        path.join(PROJECT_DIR, 'logs'),
        path.join(PROJECT_DIR, 'styles'),
        path.join(APP_ROOT, 'assets'),
    ];
}

function _resolveRendererReadableFile(event, candidatePath) {
    return _resolveExistingFileWithin(_projectReadableRoots(), candidatePath)
        || _resolveGrantedFile(event, candidatePath);
}

function _assetUrlForFile(filePath) {
    return `asset:///${filePath.replace(/\\/g, '/')}`;
}

function _isAllowedProjectMediaFile(candidatePath) {
    return Boolean(_resolveExistingFileWithin([
        INPUT_PATH,
        OUTPUT_PATH,
        TEMP_PATH,
        PUBLIC_PATH,
        path.join(PROJECT_DIR, 'assets'),
        path.join(PROJECT_DIR, 'hyperframes'),
    ], candidatePath));
}

function _resolveAllowedMutableProjectMediaFile(candidatePath) {
    const rawPath = String(candidatePath || '').trim();
    if (!rawPath) return null;

    const roots = [
        PUBLIC_PATH,
        TEMP_PATH,
        path.join(PROJECT_DIR, 'assets'),
    ].filter((root) => fs.existsSync(root));
    const candidates = path.isAbsolute(rawPath)
        ? [rawPath]
        : [
            path.resolve(PROJECT_DIR, rawPath),
            ...roots.map((root) => path.resolve(root, rawPath)),
        ];

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
            const realCandidate = fs.realpathSync.native(candidate);
            const isAllowed = roots.some((root) => (
                _isPathWithin(fs.realpathSync.native(root), realCandidate)
            ));
            if (isAllowed) return realCandidate;
        } catch (_) {
            // Try the next candidate.
        }
    }
    return null;
}

function _hyperframesPreviewUrl(indexPath) {
    const previewRoot = path.resolve(PROJECT_DIR, 'hyperframes');
    const resolvedIndex = _resolveExistingFileWithin([previewRoot], indexPath);
    if (!resolvedIndex) {
        throw new Error(`HyperFrames preview escaped its project root: ${path.resolve(indexPath)}`);
    }
    const relative = path.relative(previewRoot, resolvedIndex)
        .split(path.sep)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    return `hf-preview://project/${relative}`;
}

const LOCAL_FILE_CONTENT_TYPES = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
});

function _parseLocalFileByteRange(rawHeader, size) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rawHeader || '').trim());
    if (!match || (!match[1] && !match[2]) || size <= 0) return null;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size) return null;
        end = Math.min(end, size - 1);
        if (end < start) return null;
    }
    return { start, end };
}

function _serveLocalFileRequest(request, filePath) {
    try {
        const method = String(request?.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            return new Response('Method Not Allowed', {
                status: 405,
                headers: { Allow: 'GET, HEAD' },
            });
        }

        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return new Response('Not Found', { status: 404 });
        const size = stat.size;
        const rangeHeader = request?.headers?.get?.('range') || '';
        const requestedRange = rangeHeader ? _parseLocalFileByteRange(rangeHeader, size) : null;
        if (rangeHeader && !requestedRange) {
            return new Response(null, {
                status: 416,
                headers: {
                    'Accept-Ranges': 'bytes',
                    'Content-Range': `bytes */${size}`,
                },
            });
        }

        const start = requestedRange?.start ?? 0;
        const end = requestedRange?.end ?? Math.max(0, size - 1);
        const contentLength = size === 0 ? 0 : end - start + 1;
        const headers = new Headers({
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Content-Length': String(contentLength),
            'Content-Type': LOCAL_FILE_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Expires': '0',
            'Last-Modified': stat.mtime.toUTCString(),
            'Pragma': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
        });
        if (requestedRange) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);

        const body = method === 'HEAD' || size === 0
            ? null
            : Readable.toWeb(fs.createReadStream(filePath, { start, end }));
        return new Response(body, {
            status: requestedRange ? 206 : 200,
            headers,
        });
    } catch (_) {
        return new Response('Not Found', { status: 404 });
    }
}

function _projectSelectionFromLaunchArgs(args = [], additionalData = {}) {
    if (additionalData?.projectDir) {
        const projectDir = path.resolve(String(additionalData.projectDir));
        const projectFile = additionalData.projectFile
            ? path.resolve(String(additionalData.projectFile))
            : null;
        return { projectDir, projectFile };
    }
    for (const rawArg of args) {
        const arg = String(rawArg || '');
        if (arg.startsWith('--project=')) {
            return {
                projectDir: path.resolve(arg.substring('--project='.length)),
                projectFile: null,
            };
        }
        if (/\.fvp$/i.test(arg)) {
            const projectFile = path.resolve(arg);
            return {
                projectDir: path.dirname(projectFile),
                projectFile,
            };
        }
    }
    return null;
}

const initialProjectSelection = _projectSelectionFromLaunchArgs(process.argv);
if (initialProjectSelection) {
    const inspected = projectStore.inspectProjectDirectory({
        projectDir: initialProjectSelection.projectDir,
        preferredFvpPath: initialProjectSelection.projectFile,
    });
    if (inspected.valid) {
        PROJECT_DIR = inspected.projectDir;
        PROJECT_FILE_PATH = inspected.projectFile;
        hasExplicitProject = true;
    } else {
        initialProjectOpenError = inspected.error || 'The requested project is not valid.';
    }
}

// Resolve to absolute path
PROJECT_DIR = path.resolve(PROJECT_DIR);
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
const legacyAppEnvPath = path.join(APP_ROOT, '.env');
if (!fs.existsSync(USER_ENV_PATH) && fs.existsSync(legacyAppEnvPath)) {
    fs.copyFileSync(legacyAppEnvPath, USER_ENV_PATH);
}
// Publish to the process env so any module running in the main process
// (e.g. style-studio-agent) can locate the active project without being passed it.
process.env.PROJECT_DIR = PROJECT_DIR;
process.env.DOTENV_PATH = path.join(PROJECT_DIR, '.env');

let _pendingExternalProjectSelection = null;
const _isProjectChildInstance = process.argv.includes('--yta-project-instance');
const _hasPrimaryInstanceLock = _isProjectChildInstance || app.requestSingleInstanceLock(
    hasExplicitProject
        ? { projectDir: PROJECT_DIR, projectFile: PROJECT_FILE_PATH || '' }
        : {}
);
if (!_hasPrimaryInstanceLock) {
    app.quit();
} else if (!_isProjectChildInstance) {
    app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
        const requestedSelection = _projectSelectionFromLaunchArgs(commandLine, additionalData);
        if (!requestedSelection) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
            return;
        }
        const selection = _validateExistingProjectTarget(
            requestedSelection.projectDir,
            requestedSelection.projectFile
        );
        if (!selection.success) {
            void dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
                type: 'error',
                title: 'Could Not Open Project',
                message: selection.error,
            });
            return;
        }
        if (_pathsEqual(selection.projectDir, PROJECT_DIR)) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
            return;
        }
        if (_pathsEqual(PROJECT_DIR, DEFAULT_WORKSPACE_DIR)) {
            _pendingExternalProjectSelection = selection;
            void _consumePendingExternalProjectSelection();
            return;
        }
        const opened = _spawnProjectInstance(selection.projectDir, {
            projectFile: selection.projectFile,
            validatedProject: selection,
        });
        if (!opened.success && mainWindow && !mainWindow.isDestroyed()) {
            void dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Could Not Open Project',
                message: opened.error || 'The additional project window could not be opened.',
            });
        }
    });
}

// Project-specific paths (isolated per instance)
const PROJECT_ROOT = APP_ROOT; // Keep for code/node_modules references
let INPUT_PATH = path.join(PROJECT_DIR, 'input');
let OUTPUT_PATH = path.join(PROJECT_DIR, 'output');
let TEMP_PATH = path.join(PROJECT_DIR, 'temp');
let PUBLIC_PATH = path.join(PROJECT_DIR, 'public');

// Ensure project subdirectories exist
function ensureProjectDirs() {
    for (const dir of [INPUT_PATH, OUTPUT_PATH, TEMP_PATH, PUBLIC_PATH]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
ensureProjectDirs();

// Derive a human-readable project name from the directory
let PROJECT_NAME = PROJECT_DIR === DEFAULT_WORKSPACE_DIR ? '' : path.basename(PROJECT_DIR);
let CURRENT_LOG_FILE = null;

const _baseConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function getLogsDir(projectDir = PROJECT_DIR) {
    return path.join(projectDir, 'logs');
}

function ensureLogsDir(projectDir = PROJECT_DIR) {
    const logsDir = getLogsDir(projectDir);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    return logsDir;
}

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function stringifyLogArgs(args) {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }).join(' ');
}

function appendProjectLog(level, message) {
    if (!CURRENT_LOG_FILE) return;
    try {
        const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
        fs.appendFileSync(CURRENT_LOG_FILE, line, 'utf8');
    } catch (e) {
        _baseConsole.error('Failed to write project log:', e.message);
    }
}

function initProjectLogger(projectDir = PROJECT_DIR) {
    try {
        const logsDir = ensureLogsDir(projectDir);
        CURRENT_LOG_FILE = path.join(logsDir, `app-${nowStamp()}-${process.pid}.log`);
        appendProjectLog('INFO', `Logger initialized. projectDir=${projectDir}`);
    } catch (e) {
        _baseConsole.error('Failed to initialize project logger:', e.message);
        CURRENT_LOG_FILE = null;
    }
}

function getLatestProjectLogFile(projectDir = PROJECT_DIR) {
    const logsDir = ensureLogsDir(projectDir);
    try {
        const files = fs.readdirSync(logsDir)
            .filter((f) => f.toLowerCase().endsWith('.log'))
            .map((name) => {
                const file = path.join(logsDir, name);
                const stat = fs.statSync(file);
                return { file, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (files.length > 0) {
            return files[0].file;
        }
    } catch (_) {
        // Fall back to current log file below
    }
    return (CURRENT_LOG_FILE && fs.existsSync(CURRENT_LOG_FILE)) ? CURRENT_LOG_FILE : null;
}

// Kill log tail PowerShell windows by matching their window title
function killLogTailWindows() {
    try {
        execSync('taskkill /FI "WINDOWTITLE eq Project Logs - Live" /F', { stdio: 'ignore' });
    } catch (_) { /* no matching window — ignore */ }
}

function tailProjectLogsLive(projectDir = PROJECT_DIR) {
    const logFile = getLatestProjectLogFile(projectDir);
    if (!logFile || !fs.existsSync(logFile)) {
        return { success: false, error: `No log file found in ${getLogsDir(projectDir)}` };
    }

    if (process.platform === 'win32') {
        try {
            // Write a small .ps1 script to temp so we can pass complex commands cleanly.
            // The script writes its own PID to a file so we can track it for cleanup.
            const escaped = logFile.replace(/'/g, "''");
            const scriptFile = path.join(projectDir, 'temp', '_logtail.ps1');

            const psScript = [
                `$Host.UI.RawUI.WindowTitle = 'Project Logs - Live'`,
                `$p = '${escaped}'`,
                `if (-not (Test-Path -LiteralPath $p)) { Write-Host 'Log file not found:' $p -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }`,
                `Write-Host 'Tailing log:' $p -ForegroundColor Cyan; Write-Host ''`,
                `Get-Content -LiteralPath $p -Tail 50 -Wait`,
            ].join('\n');

            // Ensure temp dir exists
            const tempDir = path.join(projectDir, 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            // Write with UTF-8 BOM so PowerShell correctly reads unicode characters (em dash, etc.)
            const BOM = '\uFEFF';
            fs.writeFileSync(scriptFile, BOM + psScript, 'utf8');

            // Use cmd /c start to create a visible console window
            const child = spawn('cmd.exe', [
                '/c', 'start', 'Project Logs',
                'powershell.exe',
                '-NoLogo', '-NoProfile', '-NoExit',
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptFile
            ], {
                detached: true,
                stdio: 'ignore',
                shell: false,
            });
            child.unref();

            return { success: true, logFile };
        } catch (e) {
            return { success: false, error: `Failed to launch log tail: ${e.message}` };
        }
    }

    return { success: false, error: 'Live log tail is currently implemented for Windows only.' };
}

function setupConsoleTee() {
    if (console.__ytaTeePatched) return;
    console.__ytaTeePatched = true;

    console.log = (...args) => {
        _baseConsole.log(...args);
        appendProjectLog('INFO', stringifyLogArgs(args));
    };
    console.warn = (...args) => {
        _baseConsole.warn(...args);
        appendProjectLog('WARN', stringifyLogArgs(args));
    };
    console.error = (...args) => {
        _baseConsole.error(...args);
        appendProjectLog('ERROR', stringifyLogArgs(args));
    };
}

setupConsoleTee();
initProjectLogger(PROJECT_DIR);

function applyProjectDir(projectDir, options = {}) {
    PROJECT_DIR = path.resolve(projectDir);
    PROJECT_FILE_PATH = options.projectFile ? path.resolve(options.projectFile) : null;
    process.env.PROJECT_DIR = PROJECT_DIR;
    process.env.DOTENV_PATH = path.join(PROJECT_DIR, '.env');
    INPUT_PATH = path.join(PROJECT_DIR, 'input');
    OUTPUT_PATH = path.join(PROJECT_DIR, 'output');
    TEMP_PATH = path.join(PROJECT_DIR, 'temp');
    PUBLIC_PATH = path.join(PROJECT_DIR, 'public');
    PROJECT_NAME = PROJECT_DIR === DEFAULT_WORKSPACE_DIR ? '' : path.basename(PROJECT_DIR);
    ensureProjectDirs();
    for (const modulePath of RUNTIME_CONFIG_MODULE_PATHS) {
        delete require.cache[modulePath];
    }

    initProjectLogger(PROJECT_DIR);
    console.log(`📁 Active project set to: ${PROJECT_DIR}`);

    // Wipe accumulated Style Studio chat history on project switch so long
    // Detach in-memory Style Studio sessions so the old project's Gemini context
    // doesn't leak into the new one. The on-disk session stays intact — when the
    // user switches back, Style Studio restores from disk (like ChatGPT projects).
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.clearChatHistory(path.join(PROJECT_DIR, 'styles'));
    } catch (e) {
        console.warn(`[project-switch] Failed to detach studio session: ${e.message}`);
    }
}

let startupWindow = null;
let startupChoiceResolver = null;

function resolveStartupChoice(projectPath) {
    if (startupChoiceResolver) {
        const resolve = startupChoiceResolver;
        startupChoiceResolver = null;
        resolve(projectPath || null);
    }
    if (startupWindow && !startupWindow.isDestroyed()) {
        startupWindow.close();
    }
}

function createStartupWindow() {
    return new Promise((resolve) => {
        startupChoiceResolver = resolve;

        startupWindow = new BrowserWindow({
            width: 860,
            height: 560,
            minWidth: 860,
            minHeight: 560,
            resizable: false,
            maximizable: false,
            minimizable: true,
            fullscreenable: false,
            autoHideMenuBar: true,
            backgroundColor: '#0a0a0a',
            title: 'Forge — Start',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                preload: path.join(__dirname, 'preload.js'),
                additionalArguments: ['--yta-window-role=startup'],
            },
            icon: getWindowIconPath() || undefined
        });

        hardenRendererWindow(startupWindow, 'startup');
        startupWindow.loadFile(path.join(__dirname, 'ui', 'startup.html'));

        startupWindow.on('closed', () => {
            startupWindow = null;
            if (startupChoiceResolver) {
                const pending = startupChoiceResolver;
                startupChoiceResolver = null;
                pending(null);
            }
        });
    });
}

async function promptForExistingProjectPath(parentWindow) {
    const mode = await dialog.showMessageBox(parentWindow || null, {
        type: 'question',
        title: 'Open Project',
        message: 'How do you want to open the project?',
        detail: 'You can open by selecting the project folder, or pick a .fvp project file directly.',
        buttons: ['Project Folder', '.fvp File', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
    });

    if (mode.response === 2) {
        return null;
    }

    if (mode.response === 1) {
        const fileResult = await dialog.showOpenDialog(parentWindow || null, {
            title: 'Open .fvp project file',
            properties: ['openFile'],
            filters: [{ name: 'Project Files', extensions: ['fvp'] }],
        });
        if (fileResult.canceled || !fileResult.filePaths.length) return null;
        return {
            projectDir: path.dirname(fileResult.filePaths[0]),
            projectFile: fileResult.filePaths[0],
        };
    }

    const folderResult = await dialog.showOpenDialog(parentWindow || null, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (folderResult.canceled || !folderResult.filePaths.length) return null;
    return {
        projectDir: folderResult.filePaths[0],
        projectFile: null,
    };
}

async function promptStartupProjectPath() {
    return createStartupWindow();
}

const APP_ICON_ICO = path.join(APP_ROOT, 'assets', 'icon.ico');
const APP_ICON_TASKBAR_PNG = path.join(APP_ROOT, 'assets', 'icon-taskbar.png');
const APP_ICON_PNG = path.join(APP_ROOT, 'assets', 'icon.png');

function getIconSourcePng() {
    if (fs.existsSync(APP_ICON_TASKBAR_PNG)) return APP_ICON_TASKBAR_PNG;
    return fs.existsSync(APP_ICON_PNG) ? APP_ICON_PNG : null;
}

function getIcoIconPath() {
    return fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : null;
}

function getWindowIconPath() {
    const ico = getIcoIconPath();
    if (ico) return ico;
    return getIconSourcePng();
}

function getShortcutIconPath() {
    return getIcoIconPath() || process.execPath;
}

function createWindowsAppShortcuts() {
    if (process.platform !== 'win32') {
        throw new Error('Windows only');
    }

    const shortcutName = 'Forge.lnk';
    const desktopShortcutPath = path.join(app.getPath('desktop'), shortcutName);
    const startMenuProgramsDir = path.join(
        app.getPath('appData'),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs'
    );
    const startMenuShortcutPath = path.join(startMenuProgramsDir, shortcutName);
    fs.mkdirSync(startMenuProgramsDir, { recursive: true });

    const shortcutDetails = {
        target: process.execPath,
        args: app.isPackaged ? '' : '"' + APP_ROOT + '"',
        cwd: APP_ROOT,
        description: 'Forge - AI Video Studio',
        icon: getShortcutIconPath(),
        iconIndex: 0,
        appUserModelId: 'Forge'
    };

    for (const shortcutPath of [desktopShortcutPath, startMenuShortcutPath]) {
        const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
        if (!shell.writeShortcutLink(shortcutPath, operation, shortcutDetails)) {
            throw new Error('Could not create shortcut at ' + shortcutPath);
        }
    }

    const legacyShortcutNames = ['YTA Empire.lnk', 'YTA Empire WEBGL.lnk'];
    const legacyShortcutPaths = legacyShortcutNames.flatMap((legacyName) => [
        path.join(app.getPath('desktop'), legacyName),
        path.join(startMenuProgramsDir, legacyName)
    ]);
    for (const legacyShortcutPath of legacyShortcutPaths) {
        try {
            if (fs.existsSync(legacyShortcutPath)) fs.unlinkSync(legacyShortcutPath);
        } catch (error) {
            console.warn('Could not remove legacy shortcut:', legacyShortcutPath, error.message);
        }
    }

    return { desktopShortcutPath, startMenuShortcutPath };
}

function ensureIcoFromPng() {
    const sourcePngPath = getIconSourcePng();
    if (!sourcePngPath) {
        return;
    }
    if (fs.existsSync(APP_ICON_ICO)) {
        const icoMtime = fs.statSync(APP_ICON_ICO).mtimeMs;
        const srcMtime = fs.statSync(sourcePngPath).mtimeMs;
        if (icoMtime >= srcMtime) {
            return;
        }
    }
    try {
        const png = fs.readFileSync(sourcePngPath);
        // PNG signature + IHDR sanity check
        const pngSig = '89504e470d0a1a0a';
        if (png.length < 24 || png.slice(0, 8).toString('hex') !== pngSig || png.toString('ascii', 12, 16) !== 'IHDR') {
            throw new Error(`${path.basename(sourcePngPath)} is not a valid PNG`);
        }

        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        const widthByte = width >= 256 ? 0 : width;
        const heightByte = height >= 256 ? 0 : height;

        // ICO header + single PNG image entry
        const icoHeader = Buffer.alloc(22);
        icoHeader.writeUInt16LE(0, 0);   // reserved
        icoHeader.writeUInt16LE(1, 2);   // type = icon
        icoHeader.writeUInt16LE(1, 4);   // image count
        icoHeader.writeUInt8(widthByte, 6);
        icoHeader.writeUInt8(heightByte, 7);
        icoHeader.writeUInt8(0, 8);      // color count
        icoHeader.writeUInt8(0, 9);      // reserved
        icoHeader.writeUInt16LE(1, 10);  // planes
        icoHeader.writeUInt16LE(32, 12); // bit count
        icoHeader.writeUInt32LE(png.length, 14);
        icoHeader.writeUInt32LE(22, 18); // offset to image data

        fs.writeFileSync(APP_ICON_ICO, Buffer.concat([icoHeader, png]));
        console.log(`✅ Generated ${APP_ICON_ICO} from ${path.basename(sourcePngPath)}`);
    } catch (e) {
        console.warn(`⚠️ Could not generate icon.ico: ${e.message}`);
    }
}

ensureIcoFromPng();

let mainWindow;
let footageResourcesWindow = null;
let footageResourceState = {
    clipAnalyzer: true,
    footageSources: {
        storyblocks: false,
        pexels: true,
        pixabay: true,
        youtube: true,
        reddit: true,
        bing: true,
        brave: true,
    },
};

function normalizeFootageResourceState(input = {}) {
    const sources = input.footageSources || input.sources || {};
    return {
        clipAnalyzer: input.clipAnalyzer !== false,
        footageSources: {
            storyblocks: sources.storyblocks === true,
            pexels: sources.pexels !== false,
            pixabay: sources.pixabay !== false,
            youtube: sources.youtube !== false,
            reddit: sources.reddit !== false,
            bing: sources.bing !== false,
            brave: sources.brave !== false,
        },
    };
}

function broadcastFootageResourceState() {
    const payload = { ...footageResourceState, updatedAt: new Date().toISOString() };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('footage-resources-updated', payload);
    }
    if (footageResourcesWindow && !footageResourcesWindow.isDestroyed()) {
        footageResourcesWindow.webContents.send('footage-resources-updated', payload);
    }
}

function createFootageResourcesWindow() {
    const htmlFile = path.join(__dirname, 'ui', 'footage-resources.html');
    if (footageResourcesWindow && !footageResourcesWindow.isDestroyed()) {
        footageResourcesWindow.focus();
        return footageResourcesWindow;
    }
    footageResourcesWindow = new BrowserWindow({
        width: 980,
        height: 820,
        minWidth: 760,
        minHeight: 620,
        backgroundColor: '#0a0a0a',
        title: 'Resource Control Center',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: ['--yta-window-role=footage-resources'],
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    hardenRendererWindow(footageResourcesWindow, 'footage-resources');
    footageResourcesWindow.loadFile(htmlFile);
    footageResourcesWindow.on('closed', () => { footageResourcesWindow = null; });
    footageResourcesWindow.webContents.once('did-finish-load', () => {
        if (footageResourcesWindow && !footageResourcesWindow.isDestroyed()) {
            footageResourcesWindow.webContents.send('footage-resources-updated', footageResourceState);
        }
    });
    return footageResourcesWindow;
}

// ========================================
// Create Window
// ========================================
async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: ['--yta-window-role=main'],
        },
        icon: getWindowIconPath() || undefined
    });
    hardenRendererWindow(mainWindow, 'main');

    // Disable caching so CSS/JS changes are picked up immediately
    await mainWindow.webContents.session.clearCache().catch(() => {});
    await mainWindow.webContents.session.clearCodeCaches({}).catch(() => {});

    // Set window title with project name
    if (PROJECT_NAME) {
        mainWindow.setTitle(`Forge — ${PROJECT_NAME}`);
    }

    // Load the UI
    await mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Custom menu - let Ctrl+Z/C/V/S pass through to the renderer
    const sendToRenderer = (channel) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel);
        }
    };
    const menu = Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('menu-save') },
                { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu-new') },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendToRenderer('menu-undo') },
                { type: 'separator' },
                { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendToRenderer('menu-copy') },
                { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendToRenderer('menu-paste') },
                { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendToRenderer('menu-select-all') },
                { label: 'Delete', accelerator: 'Delete', click: () => sendToRenderer('menu-delete') }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Create App Shortcuts', click: async () => {
                        try {
                            createWindowsAppShortcuts();
                            dialog.showMessageBox(mainWindow, {
                                title: 'App Shortcuts Created',
                                message: 'Desktop and Start menu shortcuts created. You can now find Forge in Windows Search.',
                                type: 'info'
                            });
                        } catch (e) {
                            dialog.showMessageBox(mainWindow, { title: 'Error', message: 'Failed to create shortcuts: ' + e.message, type: 'error' });
                        }
                    }
                },
                {
                    label: 'Open Project Logs', click: async () => {
                        const logsDir = ensureLogsDir(PROJECT_DIR);
                        await shell.openPath(logsDir);
                    }
                },
                {
                    label: 'Tail Project Logs (Live)', click: async () => {
                        const result = tailProjectLogsLive(PROJECT_DIR);
                        if (!result.success) {
                            dialog.showMessageBox(mainWindow, {
                                title: 'Log Tail Failed',
                                message: result.error || 'Could not tail project logs.',
                                type: 'error'
                            });
                        }
                    }
                },
                { type: 'separator' },
                { label: 'About', click: () => dialog.showMessageBox(mainWindow, { title: 'Forge', message: 'AI-powered video generator', type: 'info' }) }
            ]
        }
    ]);
    Menu.setApplicationMenu(menu);

    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        console.warn(`[Lifecycle] Main window closed (activeProcess=${activeProcessType || 'none'}).`);
        mainWindow = null;
    });

    mainWindow.on('unresponsive', () => {
        console.error(`[Lifecycle] Main window became unresponsive (activeProcess=${activeProcessType || 'none'}).`);
    });

    mainWindow.webContents.on('render-process-gone', (_event, details = {}) => {
        console.error(
            `[Lifecycle] Main renderer exited: reason=${details.reason || 'unknown'}`
            + ` exitCode=${details.exitCode ?? 'unknown'}`
            + ` activeProcess=${activeProcessType || 'none'}`
        );
    });

    // Forward renderer console messages to main process log (critical for diagnostics)
    mainWindow.webContents.on('console-message', (details) => {
        const level = String(details?.level || 'info').toLowerCase();
        const message = String(details?.message || '');
        const noteworthy = level === 'warning'
            || level === 'error'
            || message.includes('✅')
            || message.includes('❌')
            || message.includes('Restored project')
            || message.includes('No saved project')
            || message.includes('[PreCache]')
            || message.includes('[MGRenderer]');
        if (noteworthy) {
            const prefix = level === 'error'
                ? '[RENDERER ERROR]'
                : level === 'warning'
                    ? '[RENDERER WARN]'
                    : '[RENDERER]';
            console.log(`${prefix} ${message}`);
        }
    });

    console.log('🎬 Forge started');
}

// ========================================
// V2 GPU-Native Export: colocate GPU thread with main process
// Required for EGL/ANGLE D3D11 device access from native addon.
// Enable with EXPORT_V2=1 environment variable.
// ========================================
// --in-process-gpu moves GPU thread into main process so native addon can
// access ANGLE's EGL display for D3D11 shared texture interop.
// --disable-gpu-compositing prevents blank window by using software UI compositing
// while keeping GPU available for WebGL rendering.
// This mode deliberately removes Chromium's normal GPU-process crash boundary.
// Keep it opt-in for the legacy V2 native export only; HyperFrames and the
// regular preview/render paths must retain an out-of-process GPU so a driver
// reset cannot terminate the Electron main process.
const _v2InProcessGpuEnabled = /^(1|true|on)$/i.test(String(process.env.EXPORT_V2 || '').trim());
if (_v2InProcessGpuEnabled) {
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    console.log('[V2] in-process GPU ENABLED (explicit EXPORT_V2 opt-in)');
} else {
    console.log('[V2] in-process GPU disabled; Chromium GPU crash isolation is active');
}

// ========================================
// App Lifecycle
// ========================================
app.setAppUserModelId('Forge');

// Register local-media schemes before app.whenReady. Neither scheme bypasses
// CSP. hf-preview uses a distinct origin from the renderer so its sandboxed
// iframe can load local media without gaining access to preload globals.
protocol.registerSchemesAsPrivileged([
    { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    { scheme: 'hf-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.whenReady().then(async () => {
    if (!_hasPrimaryInstanceLock) return;

    try {
        createWindowsAppShortcuts();
    } catch (error) {
        console.warn('Could not register Windows app shortcuts:', error.message);
    }
    // Register asset:// for project media only. Arbitrary filesystem reads are
    // rejected even if a renderer bug manages to request a crafted URL.
    protocol.handle('asset', (request) => {
        let filePath = request.url.replace(/^asset:\/{2,3}/, '');
        filePath = filePath.replace(/[?#].*$/, '');
        filePath = decodeURIComponent(filePath);
        if (/^[A-Za-z]\//.test(filePath)) {
            filePath = filePath[0] + ':' + filePath.slice(1);
        }
        const allowedRoots = _projectReadableRoots();
        const resolved = _resolveExistingFileWithin(allowedRoots, filePath);
        if (!resolved) {
            return new Response('Forbidden', { status: 403 });
        }
        return _serveLocalFileRequest(request, resolved);
    });

    protocol.handle('hf-preview', (request) => {
        try {
            const url = new URL(request.url);
            if (url.hostname !== 'project') return new Response('Forbidden', { status: 403 });
            const previewRoot = path.resolve(PROJECT_DIR, 'hyperframes');
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const resolved = _resolveExistingFileWithin([previewRoot], path.resolve(previewRoot, relative));
            if (!resolved) {
                return new Response('Forbidden', { status: 403 });
            }
            return _serveLocalFileRequest(request, resolved);
        } catch (_) {
            return new Response('Bad Request', { status: 400 });
        }
    });
    // Premiere-style startup: open straight to the WORKSPACE (default project = app
    // root). The full UI + all settings are usable immediately for review — no folder
    // has to be chosen first. The user creates or opens a named project on demand via
    // the New / Open Project buttons in the header. The empty workspace absorbs
    // the first project; once a named project is open, additional projects launch
    // in separate isolated instances so both can stay open.
    // A --project=<dir> or .fvp launch arg still loads that project directly.
    // (Previously this forced a startup project chooser and quit if none was picked.)

    const lockAcquired = acquireProjectLock();

    if (!lockAcquired) {
        // Another instance is already using this project directory
        const response = await dialog.showMessageBox(null, {
            type: 'warning',
            title: 'Project Already Open',
            message: `This project folder is already open in another window:\n\n${PROJECT_DIR}`,
            detail: 'Choose a different folder to work in, or cancel to quit.',
            buttons: ['Choose Folder', 'Cancel'],
            defaultId: 0
        });

        if (response.response === 0) {
            let replacementOpened = false;
            while (!replacementOpened) {
                const folderResult = await dialog.showOpenDialog(null, {
                    title: 'Choose another YTA Empire project folder',
                    properties: ['openDirectory']
                });
                if (folderResult.canceled || !folderResult.filePaths.length) {
                    app.quit();
                    return;
                }

                const inspected = _validateExistingProjectTarget(folderResult.filePaths[0]);
                if (!inspected.success) {
                    await dialog.showMessageBox(null, {
                        type: 'error',
                        title: 'Not a YTA Empire Project',
                        message: inspected.error,
                    });
                    continue;
                }

                applyProjectDir(inspected.projectDir, { projectFile: inspected.projectFile });
                if (!acquireProjectLock()) {
                    await dialog.showMessageBox(null, {
                        type: 'error',
                        title: 'Could Not Lock Project',
                        message: 'The selected project is already open or is not writable.',
                    });
                    continue;
                }
                hasExplicitProject = true;
                replacementOpened = true;
            }
        } else {
            app.quit();
            return;
        }
    }

    if (hasExplicitProject) {
        try {
            projectStore.writeProjectMarker({
                projectDir: PROJECT_DIR,
                projectFile: PROJECT_FILE_PATH,
            });
        } catch (error) {
            console.warn(`[Projects] Could not update project marker: ${error.message}`);
        }
    }

    // Which AI serves each job (Thinking / Everyday / Eyes), keys decrypted by
    // the OS keychain — must follow app ready for safeStorage.
    _applyAiConnections();
    await createWindow();
    // Agent access, if the user left it on. Never blocks startup.
    void _startRemoteControlServer().catch((error) => console.warn(`[Remote] start failed: ${error.message}`));
    await _consumePendingExternalProjectSelection();
    if (initialProjectOpenError) {
        await dialog.showMessageBox(mainWindow || null, {
            type: 'error',
            title: 'Could Not Open Project',
            message: initialProjectOpenError,
            detail: 'The app opened the empty workspace instead.',
        });
        initialProjectOpenError = null;
    }

    // Auto-probe V2 on startup to log GPU capabilities
    if (typeof _gpuExportAddon !== 'undefined' && _gpuExportAddon && _v2InProcessGpuEnabled) {
        try {
            const probe = _gpuExportAddon.probeAngleD3D11();
            if (probe.ok) {
                console.log('[V2] GPU Probe SUCCESS:');
                console.log('  Renderer:', probe.details?.renderer);
                console.log('  Adapter:', probe.details?.adapterDescription);
                console.log('  LUID:', probe.details?.adapterLuid);
                console.log('  EGL Extensions:', probe.details?.eglExtensions?.length, 'found');
            } else {
                console.log(`[V2] GPU Probe: ${probe.reason} — ${probe.error || ''}`);
            }
        } catch (e) {
            console.log('[V2] GPU Probe error:', e.message);
        }
    }
});

app.on('window-all-closed', () => {
    console.warn(`[Lifecycle] All windows closed (activeProcess=${activeProcessType || 'none'}); quitting.`);
    killLogTailWindows();
    releaseProjectLock();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    console.warn(`[Lifecycle] before-quit (activeProcess=${activeProcessType || 'none'}).`);
    killLogTailWindows();
    releaseProjectLock();
    void _stopRemoteControlServer();
});

app.on('child-process-gone', (_event, details = {}) => {
    const type = details.type || 'unknown';
    const reason = details.reason || 'unknown';
    const level = reason === 'clean-exit' ? 'log' : 'error';
    console[level](
        `[Lifecycle] Electron child exited: type=${type}`
        + ` reason=${reason}`
        + ` exitCode=${details.exitCode ?? 'unknown'}`
        + `${details.serviceName ? ` service=${details.serviceName}` : ''}`
        + ` activeProcess=${activeProcessType || 'none'}`
    );
});

app.on('activate', () => {
    if (!_hasPrimaryInstanceLock) return;
    if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
    }
});

// ========================================
// IPC Handlers (Bridge between UI and Node.js)
// ========================================

// Copy an MP3/WAV into the active project's input/ folder. ONE implementation:
// the drop zone (import-audio-file) and the agent remote control
// (forge_import_narration) both land here, so neither can drift from the other's
// validation, clearing rules, or stale-source recovery.
async function _importNarrationFile(sourcePath) {
    try {
        if (!sourcePath || typeof sourcePath !== 'string') {
            return { success: false, error: 'Source path is missing or invalid' };
        }
        const resolvedSource = fs.realpathSync.native(sourcePath);
        const sourceStat = fs.statSync(resolvedSource);
        const extension = path.extname(resolvedSource).toLowerCase();
        if (!sourceStat.isFile() || !new Set(['.mp3', '.wav']).has(extension)) {
            return { success: false, error: 'Only an existing MP3 or WAV file can be imported' };
        }
        if (sourceStat.size > 4 * 1024 * 1024 * 1024) {
            return { success: false, error: 'Audio file exceeds the 4 GB import limit' };
        }
        const destPath = INPUT_PATH;
        const destFolder = 'project input';
        const fileName = path.basename(resolvedSource);
        const destination = path.join(destPath, fileName);

        // Ensure folder exists
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }

        // Skip copy if source is already in the destination folder
        if (path.resolve(resolvedSource) === path.resolve(destination)) {
            console.log(`✅ Audio already in ${destFolder}, skipping copy`);
            return { success: true, path: destination, name: fileName, bytes: sourceStat.size };
        }

        // Validate the source BEFORE touching the destination. A stale source path (e.g.
        // a public/ copy wiped by a prior build) must never cause us to delete the good
        // copy already sitting in the destination. If the destination already holds this
        // file, treat it as already-present and reuse it instead of failing.
        if (!fs.existsSync(resolvedSource)) {
            if (fs.existsSync(destination)) {
                console.log(`⚠️ Source missing (${sourcePath}) but ${fileName} already in ${destFolder} — reusing existing copy`);
                return { success: true, path: destination, name: fileName };
            }
            return { success: false, error: `Source audio not found: ${sourcePath}` };
        }

        // Clear existing audio files in input (source is confirmed to exist)
        const existingFiles = fs.readdirSync(destPath);
        existingFiles.forEach(file => {
            if (file.endsWith('.mp3') || file.endsWith('.wav')) {
                fs.unlinkSync(path.join(destPath, file));
            }
        });

        // Copy file
        fs.copyFileSync(resolvedSource, destination);
        console.log(`✅ Copied ${fileName} to ${destFolder}`);

        return { success: true, path: destination, name: fileName, bytes: sourceStat.size };
    } catch (error) {
        console.error('❌ Copy failed:', error);
        return { success: false, error: error.message };
    }
}

ipcMain.handle('import-audio-file', async (_event, sourcePath) => _importNarrationFile(sourcePath));

// Copy a chosen presenter image into the ACTIVE project's assets/ folder (talking-head
// mode). Unlike copy-file('input'), this never clears audio and always targets the
// project dir, so the image is project-local and Step 8 can find it. Returns absolute path.
ipcMain.handle('copy-presenter-image', async (event, sourcePath) => {
    try {
        const grantedSource = _resolveGrantedFile(event, sourcePath);
        if (!grantedSource) {
            return { success: false, error: 'Presenter image not found' };
        }
        const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
        const assetsDir = path.join(PROJECT_DIR, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
        const ext = path.extname(grantedSource).toLowerCase();
        if (!allowedExtensions.has(ext)) {
            return { success: false, error: 'Unsupported presenter image type' };
        }
        const destination = path.join(assetsDir, `presenter-source${ext}`);
        fs.copyFileSync(grantedSource, destination);
        console.log(`✅ Copied presenter image to ${destination}`);
        return { success: true, path: destination };
    } catch (error) {
        console.error('❌ Presenter image copy failed:', error);
        return { success: false, error: error.message };
    }
});

// Active child process tracking for cancellation
let activeProcess = null;
let activeProcessType = null; // 'build' or 'render'
let processCancelled = false;
let activeRenderCancelled = false;

ipcMain.handle('cancel-process', async (event) => {

    if (activeProcess && _rendererRoles.get(event.sender.id) === 'main') {
        const type = activeProcessType || 'process';
        const pid = activeProcess.pid;
        console.log(`⛔ Cancelling ${type} (PID: ${pid})...`);
        processCancelled = true;
        if (type === 'render') activeRenderCancelled = true;
        try {
            // Kill entire process tree on Windows
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${pid} /f /t`, (err) => {
                    if (err) console.error('taskkill error:', err.message);
                    else console.log(`taskkill success for PID ${pid}`);
                });
            } else {
                activeProcess.kill('SIGTERM');
            }
        } catch (e) {
            console.error('Error killing process:', e);
            try { activeProcess.kill('SIGKILL'); } catch (_) { }
        }
        return { success: true, message: `${type} cancelled` };
    }

    if (_webglExport && _webglExport.ownerWebContentsId === event.sender.id) {
        const exp = _webglExport;
        exp.cancelled = true;
        _webglExport = null;
        _detachWebglExportOwner(exp);
        await _terminateWebglExport(exp);
        return { success: true, message: 'render cancelled' };
    }

    return { success: true, message: 'No active process' };
});

// Apply the chosen vision backend before the build spawns, so the build child inherits it.
// The GPU MACHINE itself is no longer booted here — it is started JUST-IN-TIME inside the
// build pipeline (src/build-video.js, right before media scoring) and stopped once vision is
// done (src/vision-gpu.js). That keeps the rented GPU off during transcribe/Director/Planner
// (before scoring) and rendering (after) — the model the user asked for, for ALL GPU backends.
async function _prepareVisionForBuild(options) {
    if (options && options.visionBackend) {
        const vb = String(options.visionBackend).toLowerCase();
        const changed = String(process.env.VISION_BACKEND || 'aws').toLowerCase() !== vb;
        process.env.VISION_BACKEND = vb;
        // Record it every time, not only on a change: a project whose .env has never
        // carried the key would otherwise keep no record of the choice at all, and the
        // dropdown would read back a default that does not match what builds are using.
        try { updateEnvFile('VISION_BACKEND', vb); } catch (_) {}
        if (changed) {
            try { require('./src/settings/config').resolveVisionBackend(); } catch (_) {}
        }
    }
}

// Run the build pipeline
ipcMain.handle('run-build', async (event, options) => {
    try {
        console.log('🚀 Starting build with options:', options);

        // Apply the selected AI provider before spawning the build.
        if (options.aiProvider) {
            applyBrainProvider(options.aiProvider);
        }

        // Send progress updates to renderer
        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('build-progress', { percent, message });
            }
        };

        sendProgress(5, '🔑 Preparing build...');

        // Apply the chosen vision backend so the build child inherits it. The GPU machine is
        // started just-in-time inside the pipeline (right before scoring), not here.
        try { await _prepareVisionForBuild(options); } catch (e) { console.warn('vision prep failed:', e.message); }

        // Studio: if this build belongs to a video Quill has finished a voiceover
        // for, take the narration from there instead of a hand-imported file.
        // Audio already sitting in input/ always wins, so this can never swap
        // out something the creator imported himself.
        try {
            const staged = require('./src/project/studio-link')
                .prepareBuild({ projectDir: PROJECT_DIR, inputPath: INPUT_PATH });
            if (staged && !options.audioFileName) options.audioFileName = staged.audioFileName;
        } catch (e) { console.warn('Studio link skipped:', e.message); }

        sendProgress(8, '⚙️ Starting build pipeline...');

        // Run the build script
        return new Promise((resolve, reject) => {
            // options -> child-process env now lives in the schema-driven single
            // source of truth (src/settings/build-env.js), proven byte-identical to
            // the old inline logic by scripts/verify-settings.js.
            const { applyOptionsToEnv } = require('./src/settings/build-env');
            const { env: buildEnv, isSmartAI } = applyOptionsToEnv(options, { projectDir: PROJECT_DIR });
            // AI Connections reach the build through ITS environment only — never
            // through process.env, so ffmpeg / yt-dlp / render children never see keys.
            const _aiConnJson = _aiConnectionsRuntimeJson();
            if (_aiConnJson) {
                buildEnv.FORGE_AI_CONNECTIONS = _aiConnJson;
                console.log(`   🔌 AI jobs: ${aiConnections.describeRuntime()}`);
            }
            console.log(`   🧠 Smart AI: smartAI=${options.smartAI} (${typeof options.smartAI}) → SMART_AI=${buildEnv.SMART_AI}`);
            console.log(`   🎬 Clip Analyzer: ${buildEnv.CLIP_ANALYZER_ENABLED === 'true' ? 'ON' : 'OFF'}`);
            if (buildEnv.BUILD_REPEAT_FROM) console.log(`   🔁 Repeat From Step: ${buildEnv.BUILD_REPEAT_FROM}`);
            if (buildEnv.BUILD_FORCE_FRESH_FOOTAGE === 'true') console.log(`   🆕 Force fresh footage: ON (re-downloading clips, keeping VP plan)`);
            console.log(`   ♻️  Resume Build: ${buildEnv.BUILD_RESUME === 'true' ? `ON (skip completed steps${buildEnv.BUILD_REPEAT_FROM ? ` — repeat from ${buildEnv.BUILD_REPEAT_FROM}` : ''})` : 'OFF (fresh build)'}`);
            if (buildEnv.AI_THINKING && buildEnv.AI_THINKING !== 'off') console.log(`   🧠 AI Thinking: ${buildEnv.AI_THINKING}`);
            // Pass --smart-ai flag as CLI arg for reliability (env vars can be lost on Windows)
            const buildArgs = ['src/pipeline/build-video.js'];
            if (!isSmartAI) buildArgs.push('--dumb');
            const buildProcess = spawn(process.execPath, buildArgs, {
                cwd: APP_ROOT,
                shell: false,
                env: buildEnv
            });
            activeProcess = buildProcess;
            activeProcessType = 'build';
            processCancelled = false;

            let output = '';
            let errorOutput = '';

            // ── Clean build-summary log ──
            // Mirrors the in-app Build Log panel to disk: a readable,
            // phase-grouped, per-scene file written ALONGSIDE the verbose
            // app-*.log. Same logs/ folder; built from the structured events.
            let cleanLogFile = null;
            try {
                const logsDir = ensureLogsDir(PROJECT_DIR);
                cleanLogFile = path.join(logsDir, `build-summary-${nowStamp()}.log`);
                fs.writeFileSync(cleanLogFile, `Build summary — ${new Date().toLocaleString()}\n${'='.repeat(56)}\n`, 'utf8');
                console.log(`📋 Clean build summary → ${cleanLogFile}`);
            } catch (_) { cleanLogFile = null; }
            const _hms = () => new Date().toTimeString().slice(0, 8);
            const _evtIcon = { ok: '✅', fail: '❌', warn: '⚠️', timeout: '⏱️', start: '·', info: '·', done: '✅' };
            // Authoritative phase → progress% map (phase slugs from src/logger.js
            // _phaseId). The on-screen status is driven by these real phase events
            // so it ALWAYS reflects the current step (never stuck on a stale label).
            const PHASE_PROGRESS = {
                clean: 6, audio: 9, preflight: 12, transcribe: 15,
                director: 24, mapassign: 30, visualplanner: 36, orchestrator: 44,
                scout: 46, pool: 48, download: 58,
                framing: 66, mg: 72, 'explainer-images': 74, 'map-images': 75,
                templates: 78, transitions: 80, overlays: 76, sfx: 82,
                plan: 85, 'composition-author': 90, copy: 95,
            };
            let _lastPhasePct = 8;
            const appendCleanEvent = (evt) => {
                if (!cleanLogFile || !evt || typeof evt !== 'object') return;
                try {
                    let line = '';
                    if (evt.t === 'phase') {
                        line = `\n[${_hms()}] ═══ ${evt.label || evt.phase} ═══`;
                    } else if (evt.t === 'scene') {
                        if (evt.status === 'start') return; // keep file to terminal outcomes only
                        const icon = _evtIcon[evt.status] || '·';
                        line = `[${_hms()}]   S${evt.scene} ${icon} ${evt.msg || ''}${evt.detail ? `  (${evt.detail})` : ''}`;
                    } else if (evt.t === 'note') {
                        const icon = _evtIcon[evt.status] || '·';
                        line = `[${_hms()}]   ${icon} ${evt.msg || ''}${evt.scene != null ? ` [S${evt.scene}]` : ''}`;
                    }
                    if (line) fs.appendFileSync(cleanLogFile, line + '\n', 'utf8');
                } catch (_) { /* best-effort */ }
            };

            buildProcess.stdout.on('data', (data) => {
                let text = data.toString();

                // ── Structured Build Log events ──
                // The pipeline emits compact `@@EVT@@<json>` lines (see
                // src/logger.js). Pull them out, forward each to the renderer's
                // in-app Build Log panel, and STRIP them from the text before it
                // hits the terminal/.log echo so the file stays clean.
                if (text.includes('@@EVT@@')) {
                    const keptLines = [];
                    for (const line of text.split('\n')) {
                        const i = line.indexOf('@@EVT@@');
                        if (i === -1) { keptLines.push(line); continue; }
                        // Anything before the sentinel on the same line is real output.
                        const before = line.slice(0, i);
                        if (before.trim()) keptLines.push(before);
                        const jsonStr = line.slice(i + '@@EVT@@'.length).trim();
                        try {
                            const evt = JSON.parse(jsonStr);
                            appendCleanEvent(evt); // mirror to the clean build-summary file
                            // Drive the on-screen status from the REAL current phase so it
                            // never sticks on a stale label. Monotonic (never goes backward).
                            if (evt.t === 'phase' && evt.status === 'start' && evt.label) {
                                const mapped = PHASE_PROGRESS[evt.phase];
                                const pct = Math.max(_lastPhasePct, Number.isFinite(mapped) ? mapped : _lastPhasePct);
                                _lastPhasePct = pct;
                                sendProgress(pct, evt.label);
                            }
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('build-event', evt);
                            }
                        } catch (_) { /* malformed event line — drop it */ }
                    }
                    text = keptLines.join('\n');
                }

                output += text;
                if (text.trim()) console.log(text);

                // Progress + status are now driven AUTHORITATIVELY by the @@EVT@@
                // phase events above (so the label always tracks the real step and
                // never sticks on "Transcribing"). Only the completion sentinel and
                // a couple of long-phase sub-status hints remain here.
                if (text.includes('BUILD COMPLETE')) sendProgress(100, '✅ Build complete!');
                else if (/Rendering frame\s+\d+\s*\/\s*\d+/.test(text)) { const m = text.match(/Rendering frame\s+(\d+)\s*\/\s*(\d+)/); if (m) sendProgress(Math.max(_lastPhasePct, 96), `🎬 Rendering frame ${m[1]}/${m[2]}...`); }

                // Qwen key fully vision-exhausted alert — sentinel emitted by
                // src/ai-provider.js when every model in QWEN_VL_POOL is
                // permanently dead on a specific key. Surface as OS notification
                // + in-app toast so the user knows to swap the key in .env.
                const qwenAlertRe = /QWEN_KEY_VISION_EXHAUSTED\|key=(\d+)(?:\|tail=([A-Za-z0-9_-]+))?\|pool=(\d+)/g;
                let qwenMatch;
                while ((qwenMatch = qwenAlertRe.exec(text)) !== null) {
                    const [, keyIdx, tail, pool] = qwenMatch;
                    const title = 'Qwen Vision Key Exhausted';
                    const tailText = tail ? ` (...${tail})` : '';
                    const body  = `Key ${keyIdx}${tailText} — all ${pool} vision models permanently exhausted. Swap with a fresh key in .env.`;
                    if (Notification.isSupported()) {
                        try { new Notification({ title, body, silent: false }).show(); } catch (_) {}
                    }
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('build-progress', {
                            percent: -1, // sticky alert, don't move progress bar
                            message: `⚠️ ${body}`
                        });
                    }
                }

                const qwenDegradedRe = /QWEN_KEY_VISION_DEGRADED\|key=(\d+)\|tail=([A-Za-z0-9_-]+)\|image=(\d+\/\d+)\|omni=(\d+\/\d+)/g;
                let qwenDegradedMatch;
                while ((qwenDegradedMatch = qwenDegradedRe.exec(text)) !== null) {
                    const [, keyIdx, tail, image, omni] = qwenDegradedMatch;
                    const title = 'Qwen Vision Key Degraded';
                    const body = `Key ${keyIdx} (...${tail}) image ${image}, omni ${omni}. Build can continue, but this key may slow scoring.`;
                    if (Notification.isSupported()) {
                        try { new Notification({ title, body, silent: true }).show(); } catch (_) {}
                    }
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('build-progress', {
                            percent: -1,
                            message: `⚠️ ${body}`
                        });
                    }
                }

                // QWEN_KEY_TEXT_EXHAUSTED handler removed — Qwen is now
                // vision-only, so the text-side sentinel is never emitted.

            });

            buildProcess.stderr.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                // Suppress ffmpeg banner/config noise (always writes to stderr, not a real error)
                if (/^(ffmpeg version|built with gcc|configuration:|lib(av|sw|post)|Input #|Output #|Stream #|Stream mapping|Press \[q\]|size=|frame=|\[out#|Duration:|Metadata:|major_brand|minor_version|compatible_brands|creation_time|handler_name|vendor_id|encoder)/m.test(text.trim())) return;
                console.error(text);
            });

            buildProcess.on('close', (code) => {
                const wasCancelled = processCancelled;
                activeProcess = null;
                activeProcessType = null;
                processCancelled = false;
                if (wasCancelled) {
                    console.log('⛔ Build was cancelled by user');
                    resolve({ success: false, error: 'Cancelled' });
                    return;
                }
                if (code === 0) {
                    resolve({ success: true, output });
                } else {
                    resolve({ success: false, error: errorOutput || 'Build failed' });
                }
            });

            buildProcess.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });
        });

    } catch (error) {
        console.error('❌ Build error:', error);
        return { success: false, error: error.message };
    }
});

// Load video plan
ipcMain.handle('load-video-plan', async () => {
    try {
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (loaded?.videoPlan) {
            console.log(`✅ Loaded unified video plan from ${loaded.source}`);
            return loaded.videoPlan;
        }
        console.log('⚠️ No video plan found');
        return null;
    } catch (error) {
        console.error('❌ Failed to load video plan:', error);
        return null;
    }
});

// Save Video Plan
ipcMain.handle('save-video-plan', async (event, plan, expectedRevision, expectedPlanHash) => {
    try {
        const safePlan = _boundedPlainObject(plan, 32 * 1024 * 1024);
        const saved = await _queueProjectSave(() => (
            _persistUnifiedVideoPlan(safePlan, expectedRevision, expectedPlanHash)
        ));
        console.log(`✅ Unified video plan saved (revision ${saved.revision})`);
        return {
            success: true,
            revision: saved.revision,
            planHash: saved.planHash,
            path: saved.fvpPath,
        };
    } catch (error) {
        console.error('❌ Failed to save plan:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-test-mg-plan', async () => {
    try {
        const testPlanPath = path.join(PUBLIC_PATH, 'test-mg-plan.json');
        if (!fs.existsSync(testPlanPath)) {
            return { success: false, error: 'public/test-mg-plan.json does not exist' };
        }
        return {
            success: true,
            plan: JSON.parse(fs.readFileSync(testPlanPath, 'utf8')),
        };
    } catch (error) {
        return {
            success: false,
            conflict: error.code === 'PROJECT_REVISION_CONFLICT' || error.code === 'PROJECT_PLAN_CONFLICT',
            error: error.message,
        };
    }
});

ipcMain.handle('get-country-geojson', async () => {
    try {
        const geoPath = path.join(APP_ROOT, 'assets', 'geo', 'countries-slim.json');
        const allowed = _resolveExistingFileWithin([path.join(APP_ROOT, 'assets', 'geo')], geoPath);
        if (!allowed) return null;
        return JSON.parse(fs.readFileSync(allowed, 'utf8'));
    } catch (error) {
        console.warn(`[Geo] Could not load country boundaries: ${error.message}`);
        return null;
    }
});

const QA_CROP_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const QA_CROP_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);
const _activeQaCropFiles = new Set();

ipcMain.handle('qa-pre-crop-media', async (event, payload = {}) => {
    const mediaFile = _resolveAllowedMutableProjectMediaFile(payload.mediaFile);
    if (!mediaFile) {
        return { success: false, error: 'Crop target must be an existing file inside project public/temp/assets' };
    }

    const crop = {};
    for (const key of ['cropTop', 'cropBottom', 'cropLeft', 'cropRight']) {
        const value = Number(payload.crop?.[key] || 0);
        if (!Number.isFinite(value) || value < 0 || value > 40) {
            return { success: false, error: `Invalid ${key}: ${payload.crop?.[key]}` };
        }
        crop[key] = value;
    }
    if (crop.cropTop + crop.cropBottom >= 90 || crop.cropLeft + crop.cropRight >= 90) {
        return { success: false, error: 'Crop removes too much of the source frame' };
    }
    if (!Object.values(crop).some((value) => value > 0)) {
        return { success: false, error: 'Crop request does not remove any pixels' };
    }

    const extension = path.extname(mediaFile).toLowerCase();
    const isImage = QA_CROP_IMAGE_EXTENSIONS.has(extension);
    const isVideo = QA_CROP_VIDEO_EXTENSIONS.has(extension);
    if (!isImage && !isVideo) {
        return { success: false, error: `Unsupported QA crop media type: ${extension || '(none)'}` };
    }

    const activeKey = process.platform === 'win32' ? mediaFile.toLowerCase() : mediaFile;
    if (_activeQaCropFiles.has(activeKey)) {
        return { success: false, error: 'This media file is already being cropped' };
    }
    _activeQaCropFiles.add(activeKey);

    const nonce = crypto.randomBytes(5).toString('hex');
    const basePath = mediaFile.slice(0, -extension.length);
    const tempFile = `${basePath}.qa-crop-${nonce}${extension}`;
    const backupFile = `${basePath}.qa-backup-${nonce}${extension}`;
    const horizontal = `${crop.cropLeft}/100-${crop.cropRight}/100`;
    const vertical = `${crop.cropTop}/100-${crop.cropBottom}/100`;
    const cropFilter = [
        `floor(iw*(1-${horizontal})/2)*2`,
        `floor(ih*(1-${vertical})/2)*2`,
        `floor(iw*${crop.cropLeft}/100)`,
        `floor(ih*${crop.cropTop}/100)`,
    ].join(':');
    const args = ['-y', '-i', mediaFile, '-vf', `crop=${cropFilter}`];
    if (isImage) {
        args.push('-frames:v', '1', tempFile);
    } else {
        args.push(
            '-map', '0:v:0',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-crf', '18',
            '-preset', 'fast',
            '-c:a', 'copy'
        );
        if (extension === '.mp4' || extension === '.mov') args.push('-movflags', '+faststart');
        args.push(tempFile);
    }

    try {
        await new Promise((resolve, reject) => {
            const proc = spawn(WEBGL_FFMPEG_PATH, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });
            let stderr = '';
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (error) reject(error);
                else resolve();
            };
            const timeout = setTimeout(async () => {
                await _terminateChildProcess(proc);
                finish(new Error('FFmpeg pre-crop timed out'));
            }, 120_000);
            proc.stderr.on('data', (data) => {
                stderr = (stderr + data.toString()).slice(-32 * 1024);
            });
            proc.once('error', finish);
            proc.once('close', (code) => {
                if (code === 0) finish(null);
                else finish(new Error(`FFmpeg pre-crop failed (code ${code}): ${stderr.slice(-800)}`));
            });
        });
        _assertNonEmptyFile(tempFile, 'Cropped QA media');

        fs.renameSync(mediaFile, backupFile);
        try {
            fs.renameSync(tempFile, mediaFile);
        } catch (error) {
            try { fs.renameSync(backupFile, mediaFile); } catch (_) { }
            throw error;
        }
        try { fs.unlinkSync(backupFile); } catch (error) {
            console.warn(`[QA Crop] Could not remove backup ${backupFile}: ${error.message}`);
        }
        _assertNonEmptyFile(mediaFile, 'Cropped QA media');
        return { success: true, mediaFile };
    } catch (error) {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) { }
        if (!fs.existsSync(mediaFile) && fs.existsSync(backupFile)) {
            try { fs.renameSync(backupFile, mediaFile); } catch (_) { }
        }
        return { success: false, error: error.message };
    } finally {
        _activeQaCropFiles.delete(activeKey);
    }
});

// ── Per-scene timeline actions (Retry footage / CEO edit) ───────────────────
// Runs in the MAIN process (Node) — the SAME context as the real build — so the
// footage-download pipeline behaves identically (no renderer CSP / Accept-Encoding /
// AbortSignal mismatches). Streams progress to the renderer via 'scene-action-progress'.
function _resolveSceneMediaPathMain(scene) {
    const candidates = [];
    if (scene && scene.mediaFile) {
        if (path.isAbsolute(scene.mediaFile)) candidates.push(scene.mediaFile);
        candidates.push(path.join(PUBLIC_PATH, scene.mediaFile), path.join(TEMP_PATH, scene.mediaFile));
    }
    const exts = ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
    const idx = scene?.sourceSceneIndex ?? scene?.index;
    for (const ext of exts) {
        candidates.push(path.join(PUBLIC_PATH, `scene-${idx}-asset${ext}`));
        candidates.push(path.join(PUBLIC_PATH, `scene-${idx}${ext}`));
        candidates.push(path.join(TEMP_PATH, `scene-${idx}${ext}`));
    }
    for (const p of candidates) {
        try {
            if (p && _isAllowedProjectMediaFile(p)) return p;
        } catch (_) {}
    }
    return null;
}

const _projectLockNonce = crypto.randomBytes(16).toString('hex');
const _projectLockStartedAt = new Date().toISOString();

function _readProjectLock(lockFile) {
    try {
        const raw = fs.readFileSync(lockFile, 'utf8').trim();
        if (/^\d+$/.test(raw)) return { pid: Number(raw), legacy: true };
        const parsed = JSON.parse(raw);
        return {
            pid: Number(parsed.pid),
            nonce: String(parsed.nonce || ''),
            startedAt: String(parsed.startedAt || ''),
        };
    } catch (_) {
        return null;
    }
}

function _writeProjectLockExclusive(lockFile, projectDir) {
    fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid,
        nonce: _projectLockNonce,
        startedAt: _projectLockStartedAt,
        projectDir,
    }), { flag: 'wx' });
}

function acquireProjectLock(projectDir = PROJECT_DIR) {
    const resolvedProjectDir = path.resolve(projectDir);
    const lockFile = path.join(resolvedProjectDir, '.lock');
    fs.mkdirSync(resolvedProjectDir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            _writeProjectLockExclusive(lockFile, resolvedProjectDir);
            return true;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                console.error(`[Lock] Cannot acquire ${lockFile}: ${error.message}`);
                return false;
            }

            const existing = _readProjectLock(lockFile);
            if (existing?.pid && Number.isInteger(existing.pid)) {
                try {
                    process.kill(existing.pid, 0);
                    return false;
                } catch (probeError) {
                    if (probeError.code && probeError.code !== 'ESRCH') {
                        console.error(`[Lock] Cannot verify lock owner ${existing.pid}: ${probeError.message}`);
                        return false;
                    }
                }
            }

            try {
                fs.unlinkSync(lockFile);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') {
                    console.error(`[Lock] Cannot remove stale lock ${lockFile}: ${unlinkError.message}`);
                    return false;
                }
            }
        }
    }
    return false;
}

function releaseProjectLock(projectDir = PROJECT_DIR) {
    try {
        const lockFile = path.join(path.resolve(projectDir), '.lock');
        if (!fs.existsSync(lockFile)) return;
        const lock = _readProjectLock(lockFile);
        if (lock?.pid === process.pid && (lock.legacy || lock.nonce === _projectLockNonce)) {
            fs.unlinkSync(lockFile);
        }
    } catch (error) {
        console.warn(`[Lock] Could not release project lock: ${error.message}`);
    }
}

function _closeProjectScopedWindows() {
    for (const win of [footageResourcesWindow, qaStudioWindow, styleStudioWindow]) {
        try {
            if (win && !win.isDestroyed()) win.close();
        } catch (_) { }
    }
}

function _pathsEqual(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
}

function _validateExistingProjectTarget(projectDir, projectFile = null) {
    try {
        const inspected = projectStore.inspectProjectDirectory({
            projectDir,
            preferredFvpPath: projectFile,
        });
        if (!inspected.valid) {
            return {
                success: false,
                invalidProject: true,
                code: inspected.code,
                error: inspected.error || 'The selected folder is not a valid YTA Empire project.',
            };
        }
        return {
            success: true,
            projectDir: inspected.projectDir,
            projectFile: inspected.projectFile,
            inspection: inspected,
        };
    } catch (error) {
        return {
            success: false,
            invalidProject: true,
            error: `The selected project could not be inspected: ${error.message}`,
        };
    }
}

function _writeProjectMarkerForTarget(target) {
    return projectStore.writeProjectMarker({
        projectDir: target.projectDir,
        projectFile: target.projectFile,
    });
}

function _prepareNewProjectTarget(options = {}) {
    return projectStore.createProjectAtLocation(options);
}

async function _switchProjectInPlace(projectDir, options = {}) {
    if (activeProcess || _webglExport) {
        return {
            success: false,
            error: 'Finish or cancel the active build/render before switching projects.',
        };
    }

    const target = options.validatedProject?.success
        ? options.validatedProject
        : _validateExistingProjectTarget(projectDir, options.projectFile);
    if (!target.success) return target;
    const targetDir = target.projectDir;
    const targetProjectFile = target.projectFile;

    const previousDir = PROJECT_DIR;
    const previousProjectFile = PROJECT_FILE_PATH;
    const sameProject = _pathsEqual(targetDir, previousDir);
    if (sameProject) {
        if (targetProjectFile) PROJECT_FILE_PATH = targetProjectFile;
        try {
            _writeProjectMarkerForTarget(target);
        } catch (error) {
            console.warn(`[Projects] Could not update project marker: ${error.message}`);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
        return {
            success: true,
            projectDir: PROJECT_DIR,
            projectFile: PROJECT_FILE_PATH,
            sameProject: true,
        };
    }

    if (!acquireProjectLock(targetDir)) {
        return {
            success: false,
            alreadyOpen: true,
            error: 'This project is already open in another app session.',
        };
    }

    try {
        _writeProjectMarkerForTarget(target);
        releaseProjectLock(previousDir);
        killLogTailWindows();
        _closeProjectScopedWindows();
        _selectedFileGrants.clear();
        _selectedDirectoryGrants.clear();
        applyProjectDir(targetDir, { projectFile: targetProjectFile });
        _addRecentProject(targetDir);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setTitle(PROJECT_NAME ? `Forge — ${PROJECT_NAME}` : 'Forge');
            if (options.reloadRenderer) {
                await mainWindow.loadFile(path.join(APP_ROOT, 'ui', 'index.html'));
            }
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
        return {
            success: true,
            projectDir: PROJECT_DIR,
            projectFile: PROJECT_FILE_PATH,
            reload: options.reloadRenderer !== true,
        };
    } catch (error) {
        releaseProjectLock(targetDir);
        try {
            acquireProjectLock(previousDir);
            applyProjectDir(previousDir, { projectFile: previousProjectFile });
        } catch (_) { }
        return { success: false, error: `Could not switch projects: ${error.message}` };
    }
}

function _spawnProjectInstance(projectDir, options = {}) {
    const target = options.validatedProject?.success
        ? options.validatedProject
        : _validateExistingProjectTarget(projectDir, options.projectFile);
    if (!target.success) return target;
    const targetDir = target.projectDir;
    const targetProjectFile = target.projectFile;

    const args = [
        APP_ROOT,
        targetProjectFile || `--project=${targetDir}`,
        '--yta-project-instance',
    ];
    if (process.argv.includes('--dev')) args.push('--dev');

    const childEnv = { ...process.env };
    // A test/dev debugging port belongs to the current process. Forwarding it
    // would make the second project fight for the same DevTools endpoint.
    delete childEnv.YTA_REMOTE_DEBUG;
    delete childEnv.YTA_REMOTE_DEBUG_PORT;
    if (childEnv.YTA_TEST_USER_DATA_DIR) {
        const childProfile = crypto.createHash('sha1')
            .update(targetDir)
            .digest('hex')
            .slice(0, 12);
        childEnv.YTA_TEST_USER_DATA_DIR = path.join(
            childEnv.YTA_TEST_USER_DATA_DIR,
            `project-child-${childProfile}`
        );
        childEnv.YTA_ALLOW_TEST_USER_DATA_DIR = '1';
    }

    try {
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: 'ignore',
            cwd: APP_ROOT,
            env: childEnv,
        });
        child.unref();
        console.log(`🚀 Opened additional project instance: ${targetDir}`);
        return {
            success: true,
            projectDir: targetDir,
            projectFile: targetProjectFile,
            openedIn: 'new-instance',
            reload: false,
        };
    } catch (error) {
        return { success: false, error: `Could not open another project window: ${error.message}` };
    }
}

async function _openProjectTarget(projectDir, options = {}) {
    const target = options.validatedProject?.success
        ? options.validatedProject
        : _validateExistingProjectTarget(projectDir, options.projectFile);
    if (!target.success) return target;

    if (_pathsEqual(PROJECT_DIR, DEFAULT_WORKSPACE_DIR)) {
        const switched = await _switchProjectInPlace(target.projectDir, {
            ...options,
            projectFile: target.projectFile,
            validatedProject: target,
        });
        if (switched.success) {
            switched.openedIn = 'current-window';
            switched.reload = true;
        }
        return switched;
    }
    if (_pathsEqual(target.projectDir, PROJECT_DIR)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
        return {
            success: true,
            projectDir: PROJECT_DIR,
            projectFile: PROJECT_FILE_PATH,
            openedIn: 'current-window',
            sameProject: true,
            reload: false,
        };
    }
    return _spawnProjectInstance(target.projectDir, {
        ...options,
        projectFile: target.projectFile,
        validatedProject: target,
    });
}

async function _consumePendingExternalProjectSelection() {
    if (!_pendingExternalProjectSelection || !app.isReady() || !mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    const selection = _pendingExternalProjectSelection;
    _pendingExternalProjectSelection = null;
    const result = await _switchProjectInPlace(selection.projectDir, {
        projectFile: selection.projectFile,
        reloadRenderer: true,
    });
    if (!result.success) {
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Could Not Open Project',
            message: result.error || 'The project could not be opened.',
        });
    }
}

ipcMain.handle('scene-action', async (event, payload = {}) => {
    const { kind, sceneIndices = [], sceneRefs = [], action = '', instruction = '' } = payload;
    const send = (sceneIndex, message, clipId) => {
        try { event.sender.send('scene-action-progress', { sceneIndex, clipId, message }); } catch (_) {}
    };
    const result = { success: false, ok: 0, fail: 0, scenes: [], errors: [] };
    let visionBox = null;
    let weStarted = false;
    // Retry vision routing (RETRY_VISION): 'bedrock' (default) keeps one-off scene
    // retries off Lightning/AWS GPU machines. 'auto' may reuse an already-ready box;
    // 'box' explicitly wakes the configured AWS box.
    const retryVisionMode = String(process.env.RETRY_VISION || 'bedrock').toLowerCase();
    const _savedVisionEnv = {};
    const _restoreVisionEnv = () => {
        for (const k of Object.keys(_savedVisionEnv)) {
            if (_savedVisionEnv[k] === undefined) delete process.env[k];
            else process.env[k] = _savedVisionEnv[k];
        }
    };
    try {
        const sceneActions = require('./src/agents/scene-actions');
        visionBox = null;
        try { visionBox = require('./src/vision/vision-box'); } catch (_) {}

        const plan = _loadUnifiedProjectState({ reconcile: true })?.videoPlan;
        if (!plan) return { success: false, error: 'no video plan found' };
        const scenes = plan.scenes || [];
        const scriptContext = plan.scriptContext || {};

        // Retry vision routing — see retryVisionMode above. Decide whether to use the box
        // (only if already running, unless forced) or route to Bedrock. Never boots the box
        // in 'auto' mode.
        weStarted = false;
        let useBoxForRetry = false;
        if (kind === 'retry') {
            if (retryVisionMode === 'box' && visionBox?.isConfigured?.()) {
                send(-1, 'Vision box: starting (RETRY_VISION=box)…');
                const r = await visionBox.ensureReady({ onProgress: (m) => send(-1, `Vision box: ${m}`) });
                if (r.ok) { useBoxForRetry = true; weStarted = !r.alreadyReady; }
                else send(-1, `Vision box not ready (${r.reason}) — using Bedrock`);
            } else if (retryVisionMode !== 'bedrock' && visionBox?.isVisionReady) {
                // 'auto': use the box ONLY if it's already up (free + fast). Never boot it.
                const ready = await visionBox.isVisionReady().catch(() => false);
                if (ready) { useBoxForRetry = true; send(-1, 'Vision: box already running — using it for retry'); }
            }
        }
        if (kind === 'retry' && !useBoxForRetry) {
            // Route the vision chain straight to Bedrock (skip the box) for this retry only.
            for (const k of ['VISION_PROVIDER', 'VISION_FALLBACK_ORDER', 'VISION_EXCLUDE_QWEN']) _savedVisionEnv[k] = process.env[k];
            process.env.VISION_PROVIDER = process.env.RETRY_VISION_PROVIDER || 'bedrock-claude';
            process.env.VISION_FALLBACK_ORDER = 'bedrock-qwen-vl,bedrock-nova';
            process.env.VISION_EXCLUDE_QWEN = '1';
            send(-1, `Vision: using Bedrock (${process.env.VISION_PROVIDER}) for retry — no GPU-box boot needed`);
        }

        const requests = Array.isArray(sceneRefs) && sceneRefs.length
            ? sceneRefs
            : sceneIndices.map((sceneIndex) => ({ sourceSceneIndex: sceneIndex, index: sceneIndex }));
        for (const request of requests) {
            const si = request?.sourceSceneIndex ?? request?.index;
            const clipId = request?.clipId != null ? String(request.clipId) : null;
            const scene = (clipId ? scenes.find((candidate) => String(candidate?.clipId || '') === clipId) : null)
                || scenes.find((candidate) => Number(candidate?.sourceSceneIndex ?? candidate?.index) === Number(si))
                || scenes[si];
            if (!scene) { result.fail++; result.errors.push({ si, clipId, error: 'scene not found' }); continue; }
            const onProgress = (m) => send(si, m, clipId);
            try {
                if (kind === 'retry') {
                    const mediaFilePath = _resolveSceneMediaPathMain(scene);
                    const r = await sceneActions.retrySceneMedia(scene, scriptContext, { mediaFilePath, onProgress });
                    if (r.success) {
                        result.ok++;
                        result.scenes.push({
                            si,
                            clipId,
                            reload: true,
                            keyword: r.keyword,
                            sourceHint: r.sourceHint,
                            scene: r.scene || scene,
                            change: `media replaced via ${r.provider || scene.sourceProvider || 'retry'}`,
                        });
                    }
                    else { result.fail++; result.errors.push({ si, error: r.error }); send(si, `❌ ${r.error}`); }
                } else if (kind === 'ceo') {
                    const arrIdx = scenes.indexOf(scene);
                    const r = await sceneActions.ceoEditScene(action, scene, scriptContext, arrIdx, scenes, { instruction, onProgress });
                    if (r.success) {
                        if (r.scene && clipId && !r.scene.clipId) r.scene.clipId = clipId;
                        result.ok++;
                        result.scenes.push({ si, clipId, scene: r.scene, change: r.change });
                    }
                    else { result.fail++; result.errors.push({ si, error: r.error }); send(si, `❌ ${r.error}`); }
                }
            } catch (e) { result.fail++; result.errors.push({ si, error: e.message }); send(si, `❌ ${e.message}`); }
        }

        // Persist scene changes (framing etc.) back to the plan.
        plan.scenes = scenes;
        _persistUnifiedVideoPlan(plan);

        if (kind === 'retry' && weStarted && visionBox?.stop) {
            send(-1, 'Vision box: stopping (mission done)…');
            await visionBox.stop({ onProgress: (m) => send(-1, `Vision box: ${m}`) }).catch(() => {});
        }
        _restoreVisionEnv();

        result.success = result.ok > 0 || result.fail === 0;
        return result;
    } catch (err) {
        if (kind === 'retry' && weStarted && visionBox?.stop) {
            send(-1, 'Vision box: stopping after error…');
            await visionBox.stop({ onProgress: (m) => send(-1, `Vision box: ${m}`) }).catch(() => {});
            weStarted = false;
        }
        _restoreVisionEnv();
        return { success: false, error: err.message, ...result };
    }
});

// ── Agentic ACTING agent: apply a free-text ORDER to the already-built plan ──
// Compiles the order (directive-compiler) → applies per-scene writes + the
// compliance fixers to the loaded plan (directive-actuator, the same enforcement
// path the build uses) → routes footage changes through the REAL media system →
// persists to both plan copies → refreshes the preview via 'qa-plan-updated'.
ipcMain.handle('qa-preview-order', async (event, payload = {}) => {
    try {
        const { previewOrder } = require('./src/directives/directive-actuator');
        const plan = _loadUnifiedProjectState({ reconcile: true })?.videoPlan;
        const sc = plan?.scriptContext || {};
        const prev = await previewOrder(payload.text || '', { themeId: sc.themeId, nicheId: sc.nicheId, productionMode: sc.productionMode });
        return { ok: true, summary: prev.summary, hasActions: prev.hasActions };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('qa-apply-order', async (event, payload = {}) => {
    const send = (message) => { try { event.sender.send('scene-action-progress', { sceneIndex: -1, message }); } catch (_) {} };
    try {
        const { previewOrder, applyOrderToPlan } = require('./src/directives/directive-actuator');
        const sceneActions = require('./src/agents/scene-actions');
        const plan = _loadUnifiedProjectState({ reconcile: true })?.videoPlan;
        if (!plan) return { success: false, error: 'no video plan found' };

        // Undo snapshot before any mutation.
        try { fs.writeFileSync(path.join(PUBLIC_PATH, '.qa-undo.json'), JSON.stringify(plan)); } catch (_) {}

        send('Interpreting your order…');
        const sc = plan.scriptContext || {};
        const prev = await previewOrder(payload.text || '', { themeId: sc.themeId, nicheId: sc.nicheId, productionMode: sc.productionMode }, { log: send });
        if (!prev.directives || !prev.hasActions) {
            return { success: false, error: 'no actionable order detected', summary: prev.summary };
        }
        send(`Applying: ${prev.summary}`);
        const res = await applyOrderToPlan(plan, prev.directives, { log: send });

        // Route footage changes through the REAL media system (re-download in place).
        let footageRedownloaded = 0;
        for (const nf of (res.needsFootage || [])) {
            const scene = (plan.scenes || []).find(s => Number(s.index) === Number(nf.index));
            if (!scene) continue;
            const mediaFilePath = _resolveSceneMediaPathMain(scene);
            if (nf.keyword) { scene.keyword = nf.keyword; scene.searchKeyword = nf.keyword; }
            if (nf.sourceHint) scene.sourceHint = nf.sourceHint;
            if (nf.mediaType) scene.mediaType = nf.mediaType;
            send(`Re-downloading footage for scene ${nf.index}…`);
            try {
                const r = await sceneActions.retrySceneMedia(scene, sc, { mediaFilePath, onProgress: send });
                if (r && r.success) footageRedownloaded++;
            } catch (e) { send(`Scene ${nf.index} footage retry failed: ${e.message}`); }
        }

        // Persist the unified project state + refresh preview.
        _persistUnifiedVideoPlan(plan);
        try { if (mainWindow) mainWindow.webContents.send('qa-plan-updated', plan); } catch (_) {}

        const rep = res.report || {};
        return {
            success: true,
            summary: prev.summary,
            perSceneChanged: res.changed,
            fixed: (rep.fixed || []).length,
            flagged: (rep.unfixable || []).length,
            footageRedownloaded,
            report: rep,
        };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('qa-undo', async () => {
    try {
        const snap = path.join(PUBLIC_PATH, '.qa-undo.json');
        if (!fs.existsSync(snap)) return { success: false, error: 'nothing to undo' };
        const plan = JSON.parse(fs.readFileSync(snap, 'utf8'));
        _persistUnifiedVideoPlan(plan);
        try { if (mainWindow) mainWindow.webContents.send('qa-plan-updated', plan); } catch (_) {}
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// Integrated editor Agent. This is the versioned replacement for the legacy
// QA-chat acting path above. The legacy handlers remain temporarily for old
// windows/tests, but the main editor only uses these transaction-safe channels.
function _sendAgentPlanUpdate(payload) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent-plan-updated', payload);
        }
    } catch (_) { }
}

function _agentPreviewCaptureRect(value) {
    const rect = value && typeof value === 'object' ? value : {};
    const x = Math.max(0, Math.trunc(Number(rect.x) || 0));
    const y = Math.max(0, Math.trunc(Number(rect.y) || 0));
    const width = Math.max(0, Math.min(4096, Math.trunc(Number(rect.width) || 0)));
    const height = Math.max(0, Math.min(2304, Math.trunc(Number(rect.height) || 0)));
    if (width < 64 || height < 36) return null;
    return { x, y, width, height };
}

async function _captureAgentPlayheadFrame(event, visualContext) {
    const source = visualContext && typeof visualContext === 'object' ? visualContext : {};
    if (source.captureRequested !== true || !event?.sender || event.sender.isDestroyed()) return null;
    const rect = _agentPreviewCaptureRect(source.rect);
    if (!rect) return null;
    try {
        let image = await event.sender.capturePage(rect);
        if (!image || image.isEmpty()) return null;
        const original = image.getSize();
        if (original.width > 1280) {
            const height = Math.max(1, Math.round(original.height * (1280 / original.width)));
            image = image.resize({ width: 1280, height, quality: 'good' });
        }
        const size = image.getSize();
        const jpeg = image.toJPEG(84);
        if (!jpeg.length || jpeg.length > 4 * 1024 * 1024) return null;
        return {
            captured: true,
            imageBase64: jpeg.toString('base64'),
            mimeType: 'image/jpeg',
            currentTime: Math.max(0, Number(source.currentTime) || 0),
            renderer: String(source.renderer || '').slice(0, 80),
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.warn(`[Editor Agent] Playhead screenshot unavailable: ${error.message}`);
        return null;
    }
}

ipcMain.handle('agent-plan', async (_event, rawPayload = {}) => {
    try {
        const payload = _boundedPlainObject(rawPayload, 512 * 1024);
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (!loaded?.videoPlan) return { success: false, error: 'Open a generated project before using Agent' };
        if (payload.planHash && loaded.planHash && payload.planHash !== loaded.planHash) {
            return {
                success: false,
                conflict: true,
                retryable: true,
                code: 'AGENT_PLAN_VERSION_CONFLICT',
                error: 'The project changed. Agent scope was refreshed; send the request again.',
                revision: loaded.revision,
                planHash: loaded.planHash,
            };
        }
        if (payload.projectRevision != null
            && Number(payload.projectRevision) !== Number(loaded.revision || 0)) {
            return {
                success: false,
                conflict: true,
                retryable: true,
                code: 'AGENT_PLAN_VERSION_CONFLICT',
                error: 'The project changed. Agent scope was refreshed; send the request again.',
                revision: loaded.revision,
                planHash: loaded.planHash,
            };
        }
        const sessionStore = require('./src/agents/editor-supervisor/session-store');
        const session = sessionStore.loadSession(PROJECT_DIR);
        const { resolveContextualPayload } = require('./src/agents/editor-supervisor/conversation-context');
        const resolvedPayload = resolveContextualPayload(payload, session, loaded.videoPlan);
        resolvedPayload.history = sessionStore.historyForModel(session, payload.text);
        const { shouldGroundVisualRequest } = require('./src/agents/editor-supervisor/visual-grounding');
        if (shouldGroundVisualRequest(resolvedPayload)) {
            resolvedPayload.visualContext = await _captureAgentPlayheadFrame(
                _event,
                payload.visualContext
            );
        } else {
            resolvedPayload.visualContext = null;
        }
        const supervisor = require('./src/agents/editor-supervisor');
        const result = await supervisor.planRequest(resolvedPayload, {
            plan: loaded.videoPlan,
            revision: loaded.revision,
            planHash: loaded.planHash,
        });
        let savedSession = session;
        try {
            savedSession = sessionStore.recordExchange(PROJECT_DIR, {
                originalRequest: payload.text,
                resolvedRequest: resolvedPayload.text,
                effort: resolvedPayload.effort,
                scope: resolvedPayload.scope,
                result,
            });
        } catch (sessionError) {
            console.warn(`[Editor Agent] Could not persist conversation: ${sessionError.message}`);
        }
        return {
            success: true,
            ...result,
            sessionId: savedSession.id,
            revision: loaded.revision,
            planHash: loaded.planHash,
        };
    } catch (error) {
        return { success: false, error: error.message, code: error.code || null };
    }
});

ipcMain.handle('agent-execute', async (event, rawPayload = {}) => {
    const send = (phase, message, percent) => {
        try {
            event.sender.send('agent-progress', {
                planId: String(rawPayload?.planId || '').slice(0, 160),
                phase,
                message: String(message || '').slice(0, 2_000),
                percent: Math.max(0, Math.min(100, Number(percent) || 0)),
            });
        } catch (_) { }
    };
    try {
        const payload = _boundedPlainObject(rawPayload, 128 * 1024);
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (!loaded?.videoPlan) return { success: false, error: 'No generated video plan found' };

        send('validate', 'Validating project version and active scope...', 10);
        const supervisor = require('./src/agents/editor-supervisor');
        const result = await supervisor.executePlanned(payload.planId, {
            plan: loaded.videoPlan,
            revision: loaded.revision,
            planHash: loaded.planHash,
        }, {
            log: (message) => send('apply', message, 45),
            progress: send,
            projectDir: PROJECT_DIR,
            appRoot: PROJECT_ROOT,
            tempDir: TEMP_PATH,
            publicDir: PUBLIC_PATH,
            inputDir: INPUT_PATH,
            browserPath: findHyperframesBrowserPath(),
            allowStableScopeRebase: true,
        });
        if (!result.success) return result;

        const transactionAssets = require('./src/agents/editor-supervisor/transaction-assets');
        let committedAssetPaths = [];
        let saved;
        try {
            if (result.assetManifest?.assets?.length) {
                send('assets', `Committing ${result.assetManifest.assets.length} staged media asset(s)...`, 97);
                committedAssetPaths = transactionAssets.commitAssets(result.assetManifest, {
                    projectDir: PROJECT_DIR,
                });
            }
            send('save', 'Saving the Agent edit as one undoable transaction...', 98);
            saved = _persistUnifiedVideoPlan(result.plan, loaded.revision, loaded.planHash);
        } catch (commitError) {
            transactionAssets.rollbackCommittedAssets(committedAssetPaths, { projectDir: PROJECT_DIR });
            transactionAssets.cleanupStage(result.assetManifest, { projectDir: PROJECT_DIR });
            throw commitError;
        }
        let transaction;
        try {
            const history = require('./src/agents/editor-supervisor/history-store');
            transaction = history.recordCommit(PROJECT_DIR, {
                request: result.request,
                summary: result.summary,
                scope: result.scope,
                beforePlan: result.beforePlan,
                afterPlan: result.plan,
                beforeRevision: loaded.revision,
                afterRevision: saved.revision,
                beforePlanHash: loaded.planHash,
                afterPlanHash: saved.planHash,
                stats: result.stats,
                diff: result.diff,
                qualityReport: result.qualityReport,
                visualQa: result.visualQa,
                operationGraph: result.operationGraph,
                operationResults: result.operationResults,
                recoveries: result.recoveries,
                decisionLog: result.decisionLog,
                assetManifest: result.assetManifest
                    ? {
                        transactionId: result.assetManifest.transactionId,
                        assets: result.assetManifest.assets.map((asset) => ({
                            relativePath: asset.relativePath,
                            finalPath: asset.finalPath,
                            size: asset.size,
                        })),
                    }
                    : null,
            });
        } catch (historyError) {
            // Never leave an edit committed without its promised undo record.
            try {
                const rolledBack = _persistUnifiedVideoPlan(result.beforePlan, saved.revision, saved.planHash);
                _sendAgentPlanUpdate({
                    videoPlan: rolledBack.videoPlan,
                    revision: rolledBack.revision,
                    planHash: rolledBack.planHash,
                    source: 'editor-agent-rollback',
                });
            } catch (_) { }
            transactionAssets.rollbackCommittedAssets(committedAssetPaths, { projectDir: PROJECT_DIR });
            transactionAssets.cleanupStage(result.assetManifest, { projectDir: PROJECT_DIR });
            return { success: false, error: `Could not create Agent undo history: ${historyError.message}` };
        }
        transactionAssets.cleanupStage(result.assetManifest, { projectDir: PROJECT_DIR });

        _sendAgentPlanUpdate({
            videoPlan: saved.videoPlan,
            revision: saved.revision,
            planHash: saved.planHash,
            source: 'editor-agent',
            transactionId: transaction.id,
        });
        let sessionId = '';
        let sessionWarning = '';
        try {
            const sessionStore = require('./src/agents/editor-supervisor/session-store');
            const session = sessionStore.recordExecution(PROJECT_DIR, {
                request: result.request,
                resolvedRequest: result.resolvedRequest,
                effort: result.effort,
                summary: result.summary,
                scope: result.scope,
                capabilityIds: result.capabilityIds,
                operations: result.operationResults,
                transactionId: transaction.id,
            });
            sessionId = session.id;
        } catch (sessionError) {
            sessionWarning = `Edit succeeded, but Agent conversation memory could not be saved: ${sessionError.message}`;
            console.warn(`[Editor Agent] ${sessionWarning}`);
        }
        send('complete', 'Edit applied. Preview and timeline are updated.', 100);
        return {
            success: true,
            summary: result.summary,
            stats: result.stats,
            unsupported: result.unsupported,
            qualityReport: result.qualityReport,
            visualQa: result.visualQa,
            diff: result.diff,
            inspection: result.inspection,
            operationGraph: result.operationGraph,
            operationResults: result.operationResults,
            recoveries: result.recoveries,
            decisionLog: result.decisionLog,
            versionRebase: result.versionRebase,
            transactionId: transaction.id,
            sessionId,
            sessionWarning,
            revision: saved.revision,
            planHash: saved.planHash,
        };
    } catch (error) {
        return {
            success: false,
            conflict: error.code === 'AGENT_PLAN_CONFLICT'
                || error.code === 'PROJECT_REVISION_CONFLICT'
                || error.code === 'PROJECT_PLAN_CONFLICT',
            error: error.message,
            code: error.code || null,
            visualQa: error.visualQa || null,
        };
    }
});

ipcMain.handle('agent-undo', async () => {
    try {
        const history = require('./src/agents/editor-supervisor/history-store');
        const transaction = history.getUndoCandidate(PROJECT_DIR);
        if (!transaction) return { success: false, error: 'Nothing to undo' };
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (loaded?.planHash !== transaction.afterPlanHash) {
            return {
                success: false,
                conflict: true,
                error: 'The project changed after this Agent edit, so undo was stopped to protect newer work.',
            };
        }
        const saved = _persistUnifiedVideoPlan(transaction.beforePlan, loaded.revision, loaded.planHash);
        history.markUndone(PROJECT_DIR, transaction.id);
        try {
            require('./src/agents/editor-supervisor/session-store').recordActivity(
                PROJECT_DIR,
                `Undid: ${transaction.summary || 'last Agent edit'}.`,
                'undo'
            );
        } catch (_) { }
        _sendAgentPlanUpdate({
            videoPlan: saved.videoPlan,
            revision: saved.revision,
            planHash: saved.planHash,
            source: 'editor-agent-undo',
            transactionId: transaction.id,
        });
        return {
            success: true,
            summary: transaction.summary,
            revision: saved.revision,
            planHash: saved.planHash,
        };
    } catch (error) {
        return { success: false, error: error.message, code: error.code || null };
    }
});

ipcMain.handle('agent-redo', async () => {
    try {
        const history = require('./src/agents/editor-supervisor/history-store');
        const transaction = history.getRedoCandidate(PROJECT_DIR);
        if (!transaction) return { success: false, error: 'Nothing to redo' };
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (loaded?.planHash !== transaction.beforePlanHash) {
            return {
                success: false,
                conflict: true,
                error: 'The project changed after undo, so redo was stopped to protect newer work.',
            };
        }
        const saved = _persistUnifiedVideoPlan(transaction.afterPlan, loaded.revision, loaded.planHash);
        history.markRedone(PROJECT_DIR, transaction.id);
        try {
            require('./src/agents/editor-supervisor/session-store').recordActivity(
                PROJECT_DIR,
                `Restored: ${transaction.summary || 'Agent edit'}.`,
                'redo'
            );
        } catch (_) { }
        _sendAgentPlanUpdate({
            videoPlan: saved.videoPlan,
            revision: saved.revision,
            planHash: saved.planHash,
            source: 'editor-agent-redo',
            transactionId: transaction.id,
        });
        return {
            success: true,
            summary: transaction.summary,
            revision: saved.revision,
            planHash: saved.planHash,
        };
    } catch (error) {
        return { success: false, error: error.message, code: error.code || null };
    }
});

ipcMain.handle('agent-history', async () => {
    try {
        const history = require('./src/agents/editor-supervisor/history-store');
        return { success: true, ...history.listHistory(PROJECT_DIR) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('agent-capabilities', async () => {
    try {
        const registry = require('./src/agents/editor-supervisor/capabilities/registry');
        const capabilities = registry.listManifests();
        return {
            success: true,
            contractVersion: Math.max(0, ...capabilities.map((entry) => Number(entry.contractVersion) || 0)),
            capabilityCount: capabilities.length,
            toolCount: capabilities.reduce((sum, entry) => sum + (entry.tools?.length || 0), 0),
            capabilities,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('agent-session', async () => {
    try {
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (!loaded?.videoPlan) return { success: false, error: 'Open a project to load Agent memory' };
        const sessionStore = require('./src/agents/editor-supervisor/session-store');
        return {
            success: true,
            session: sessionStore.publicSession(sessionStore.loadSession(PROJECT_DIR)),
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('agent-new-session', async () => {
    try {
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (!loaded?.videoPlan) return { success: false, error: 'Open a project before starting an Agent conversation' };
        const sessionStore = require('./src/agents/editor-supervisor/session-store');
        return {
            success: true,
            session: sessionStore.publicSession(sessionStore.startSession(PROJECT_DIR)),
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('vision-box-status', async () => {
    try { return await require('./src/vision/vision-box').status(); }
    catch (e) { return { configured: false, ready: false, reason: e.message }; }
});

// Vision backend selector (dropdown): which backend scores B-roll images.
//   aws — self-hosted GPU box (auto-starts during a build)
//   lightning — Lightning.ai vLLM (you start the Studio + tunnel manually)
//   bedrock — AWS Bedrock vision (always on, no box)
//   azure-managed — Azure Managed Compute deployment (always on, no box); the vision
//     half of the "Azure Managed" AI Provider option, which the dropdown pairs for you
ipcMain.handle('get-vision-backend', async () => {
    return String(process.env.VISION_BACKEND || 'aws').toLowerCase();
});
ipcMain.handle('set-vision-backend', async (event, backend) => {
    const b = String(backend || 'aws').toLowerCase();
    const allowed = ['aws', 'lightning', 'bedrock', 'dashscope', 'azure-managed'];
    if (!allowed.includes(b)) return { ok: false, error: `unknown vision backend: ${b}` };
    try {
        updateEnvFile('VISION_BACKEND', b);          // persist so it survives restart
        process.env.VISION_BACKEND = b;
        // Re-resolve QWEN_* live so the main process (retries) uses the new backend now.
        try { require('./src/settings/config').resolveVisionBackend(); } catch (_) {}
        let note = '';
        if (b === 'aws') note = '🟦 AWS GPU box — it will auto-start when a build needs vision.';
        else if (b === 'lightning') note = process.env.LIGHTNING_API_KEY
            ? '🟨 Lightning — auto-starts the Studio when a build needs vision.'
            : '🟨 Lightning — manual: start the Studio + tunnel, paste the URL into .env (add LIGHTNING_API_KEY to auto-start).';
        else if (b === 'bedrock') note = '☁️ Bedrock — always on, no box to manage.';
        else if (b === 'azure-managed') note = (process.env.AZURE_MANAGED_ENDPOINT && process.env.AZURE_MANAGED_API_KEY)
            ? '🟪 Azure Managed Compute — always on, no box to manage.'
            : '🟪 Azure Managed selected, but AZURE_MANAGED_ENDPOINT / AZURE_MANAGED_API_KEY are not set — vision will fall back to Bedrock.';
        console.log(`👁️  Vision backend switched to: ${b}`);
        return { ok: true, backend: b, note };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ── Lightning account pool (multi-account rotation) — no-code management ──
ipcMain.handle('lightning-pool-list', async () => {
    try { return { ok: true, accounts: require('./src/vision/lightning-rotation').poolDetails() }; }
    catch (e) { return { ok: false, error: e.message, accounts: [] }; }
});
ipcMain.handle('lightning-pool-add', async (event, account) => {
    try { return require('./src/vision/lightning-rotation').addAccount(account || {}); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-remove', async (event, id) => {
    try { return require('./src/vision/lightning-rotation').removeAccount(String(id || '')); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-reset', async (event, id) => {
    try { return require('./src/vision/lightning-rotation').resetCycle(String(id || '')); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-update', async (event, payload) => {
    try { return require('./src/vision/lightning-rotation').updateAccount(String(payload?.id || ''), payload?.patch || {}); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-get-active', async () => {
    try { return { ok: true, id: require('./src/vision/lightning-rotation').getForcedAccount() }; }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-set-active', async (event, id) => {
    try {
        const v = (!id || id === 'auto') ? null : String(id);
        return require('./src/vision/lightning-rotation').setForcedAccount(v);
    } catch (e) { return { ok: false, error: e.message }; }
});
// Provision a Studio from the UI (install vLLM+ninja+serve script + warm model) by running
// tools/provision-lightning-studio.py in the MAIN process and streaming its output to the UI.
ipcMain.handle('lightning-provision', async (event, id) => {
    return new Promise((resolve) => {
        const acctId = String(id || '');
        if (!acctId) return resolve({ ok: false, error: 'no account id' });
        const send = (line) => { try { event.sender.send('lightning-provision-progress', { id: acctId, line }); } catch (_) {} };
        let proc;
        try {
            proc = spawn(process.env.LIGHTNING_PYTHON || 'python', ['tools/provision-lightning-studio.py', acctId], { cwd: APP_ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }
        const emit = (buf) => buf.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) send(l.trim()); });
        proc.stdout.on('data', emit);
        proc.stderr.on('data', emit);
        proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        proc.on('close', (code) => { send(code === 0 ? '✅ Provisioning finished.' : `⚠️ Exited with code ${code}.`); resolve({ ok: code === 0, code }); });
    });
});
// Health-check a Studio: boot on its configured GPU → vision test → stop → report. Streams progress on the
// same channel as provisioning; returns the parsed JSON verdict.
ipcMain.handle('lightning-check', async (event, id) => {
    return new Promise((resolve) => {
        const acctId = String(id || '');
        if (!acctId) return resolve({ ok: false, error: 'no account id' });
        const send = (line) => { try { event.sender.send('lightning-provision-progress', { id: acctId, line }); } catch (_) {} };
        let proc, stdout = '';
        try {
            proc = spawn(process.env.LIGHTNING_PYTHON || 'python', ['tools/check-lightning-studio.py', acctId], { cwd: APP_ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) send(l.trim()); }));
        proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        proc.on('close', () => {
            const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            let res;
            try { res = JSON.parse(last); } catch (_) { res = { ok: false, error: 'bad output: ' + last.slice(0, 200) }; }
            try {
                const rotation = require('./src/vision/lightning-rotation');
                const acct = rotation.loadAccounts().find((item) => item.id === acctId);
                if (acct) {
                    if (res.ok) rotation.markHealthy(acct);
                    else if (res.retryable === false) rotation.markExhausted(acct, res.error || 'Lightning check failed');
                    else rotation.markFailure(acct, res.error || 'Lightning check failed');
                }
            } catch (stateError) {
                send(`Could not update account health: ${stateError.message}`);
            }
            send(res.ok ? '✅ Check PASSED — vision works' : `⚠️ Check failed: ${res.error || (res.steps && res.steps.visionReply) || 'unknown'}`);
            resolve(res);
        });
    });
});
// Validate candidate account creds BEFORE adding (catches teamspace/username/key typos): runs
// lightning-control.py `status`, which resolves the Studio via the SDK without booting anything.
ipcMain.handle('lightning-validate', async (event, account) => {
    return new Promise((resolve) => {
        const a = account || {};
        if (!a.userId || !a.apiKey || !a.studioName) return resolve({ ok: false, error: 'User ID, API Key and Studio name are required' });
        const env = {
            ...process.env, PYTHONIOENCODING: 'utf-8',
            LIGHTNING_USER_ID: String(a.userId), LIGHTNING_API_KEY: String(a.apiKey),
            LIGHTNING_STUDIO_NAME: String(a.studioName), LIGHTNING_TEAMSPACE: String(a.teamspace || ''),
            LIGHTNING_USER: String(a.user || ''), LIGHTNING_ORG: String(a.org || ''),
        };
        let proc, stdout = '';
        try {
            proc = spawn(process.env.LIGHTNING_PYTHON || 'python', ['src/lightning-control.py', 'status'], { cwd: APP_ROOT, env });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        proc.on('close', () => {
            const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            try {
                const r = JSON.parse(last);
                resolve(r.ok ? { ok: true, state: r.state } : { ok: false, error: r.error || 'Studio not found' });
            } catch (_) { resolve({ ok: false, error: 'No response from Lightning — check your User ID / API Key. ' + last.slice(0, 120) }); }
        });
    });
});

// Open a web URL in the user's default browser (Media Log panel link clicks).
ipcMain.handle('open-external', async (event, url) => {
    try {
        if (/^https?:\/\//i.test(String(url || ''))) { await shell.openExternal(url); return { ok: true }; }
        return { ok: false, error: 'not an http(s) url' };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clipboard-write-text', async (event, value) => {
    if (_rendererRoles.get(event.sender.id) !== 'main') {
        return { success: false, error: 'Clipboard access is not available in this window' };
    }
    const text = String(value ?? '').slice(0, 4 * 1024 * 1024);
    clipboard.writeText(text);
    return { success: true, length: text.length };
});

ipcMain.handle('clipboard-read-text', async (event) => {
    if (_rendererRoles.get(event.sender.id) !== 'main') {
        return { success: false, error: 'Clipboard access is not available in this window', text: '' };
    }
    return {
        success: true,
        text: String(clipboard.readText() || '').slice(0, 4 * 1024 * 1024),
    };
});

// ── QA Results persistence ──────────────────────────────────────────────────
// Saves analysis results so closing QA Studio doesn't lose work
ipcMain.handle('save-qa-results', async (event, data) => {
    try {
        const filePath = path.join(TEMP_PATH, 'qa-results.json');
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });
        const safeResults = _boundedPlainObject(data, 8 * 1024 * 1024);
        projectStore.atomicWriteJson(filePath, safeResults);
        return { success: true };
    } catch (error) {
        console.error('❌ Failed to save QA results:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-qa-results', async () => {
    try {
        const filePath = path.join(TEMP_PATH, 'qa-results.json');
        if (!fs.existsSync(filePath)) return { success: true, data: null };
        if (fs.statSync(filePath).size > 8 * 1024 * 1024) {
            throw new Error('QA results file is too large');
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { success: true, data: JSON.parse(raw) };
    } catch (error) {
        console.error('❌ Failed to load QA results:', error.message);
        return { success: true, data: null };
    }
});

function _boundedPlainObject(value, maxBytes = 256 * 1024) {
    const json = JSON.stringify(value == null ? {} : value);
    if (Buffer.byteLength(json, 'utf8') > maxBytes) {
        throw new Error('IPC payload is too large');
    }
    return JSON.parse(json);
}

ipcMain.handle('qa-agent-init-log', async () => {
    const agent = require('./src/studio/qa-studio-agent');
    agent.initLog(PROJECT_DIR);
    return { success: true };
});

ipcMain.handle('qa-agent-set-provider', async (_event, provider, model) => {
    const normalized = String(provider || 'gemini');
    if (!new Set(['gemini', 'qwen', 'qwenOmni']).has(normalized)) {
        throw new Error('Unsupported QA provider');
    }
    const agent = require('./src/studio/qa-studio-agent');
    agent.setProvider(normalized, String(model || '').slice(0, 160));
    return { success: true, provider: normalized };
});

ipcMain.handle('qa-agent-analyze-scene', async (_event, clipPath, sceneInfo, context) => {
    const allowedClip = _resolveExistingFileWithin([TEMP_PATH, OUTPUT_PATH], clipPath);
    if (!allowedClip) {
        throw new Error('QA analysis accepts only generated clips inside project temp/output');
    }
    if (!new Set(['.mp4', '.mov', '.mkv', '.webm']).has(path.extname(allowedClip).toLowerCase())) {
        throw new Error('Unsupported QA clip type');
    }
    const agent = require('./src/studio/qa-studio-agent');
    return agent.analyzeSceneClip(
        allowedClip,
        _boundedPlainObject(sceneInfo, 128 * 1024),
        _boundedPlainObject(context, 256 * 1024)
    );
});

ipcMain.handle('qa-agent-log', async (_event, ...args) => {
    const agent = require('./src/studio/qa-studio-agent');
    agent.qaLog(...args.slice(0, 16).map((value) => String(value).slice(0, 4000)));
    return { success: true };
});

ipcMain.handle('qa-replace-scene-media', async (event, payload = {}) => {
    const mediaFile = _resolveAllowedMutableProjectMediaFile(payload.mediaFile);
    if (!mediaFile) {
        return { success: false, error: 'Replacement target is outside project public/temp/assets' };
    }
    const replacer = require('./src/studio/qa-replacer');
    return replacer.replaceSceneMedia({
        mediaFile,
        keyword: String(payload.keyword || '').slice(0, 500),
        sourceHint: String(payload.sourceHint || '').slice(0, 80),
        mediaType: payload.mediaType === 'image' ? 'image' : 'video',
        sceneDuration: Math.max(1, Math.min(120, Number(payload.sceneDuration) || 8)),
        scriptContext: _boundedPlainObject(payload.scriptContext, 256 * 1024),
        scene: payload.scene ? _boundedPlainObject(payload.scene, 128 * 1024) : null,
        onProgress: (message) => {
            try { event.sender.send('qa-replacer-progress', String(message).slice(0, 2000)); } catch (_) { }
        },
    });
});

ipcMain.handle('qa-chat-niches', async () => {
    const agent = require('./src/studio/qa-chat-agent');
    return agent.getNicheList();
});

ipcMain.handle('qa-chat-send', async (_event, history, projectContext) => {
    const safeHistory = Array.isArray(history)
        ? history.slice(-40).map((item) => ({
            role: item?.role === 'model' ? 'model' : 'user',
            text: String(item?.text || '').slice(0, 12_000),
        }))
        : [];
    const agent = require('./src/studio/qa-chat-agent');
    return agent.sendMessageWithProject(
        safeHistory,
        _boundedPlainObject(projectContext, 256 * 1024)
    );
});

// Push QA-fixed plan into the main window's memory so auto-save picks it up
ipcMain.handle('push-plan-to-main', async (event, payload) => {
    const plan = _boundedPlainObject(payload?.videoPlan || payload, 16 * 1024 * 1024);
    if (!Array.isArray(plan?.scenes)) return { success: false, error: 'Invalid video plan' };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('qa-plan-updated', {
            videoPlan: plan,
            revision: Number(payload?.revision) || null,
            planHash: payload?.planHash || null,
        });
    }
    return { success: true };
});

// ========================================
// Project File (.fvp) Save/Load
// ========================================

// Project file path computed dynamically (PROJECT_DIR may change on lock conflict redirect)
// Named after the project folder (e.g., "My Video Project.fvp")
function getProjectFilePath() {
    return projectStore.resolveProjectFilePath({
        projectDir: PROJECT_DIR,
        preferredFvpPath: PROJECT_FILE_PATH,
    });
}

function _projectStoreOptions() {
    return {
        projectDir: PROJECT_DIR,
        publicDir: PUBLIC_PATH,
        tempDir: TEMP_PATH,
        preferredFvpPath: PROJECT_FILE_PATH,
    };
}

function _loadUnifiedProjectState({ reconcile = true } = {}) {
    const options = _projectStoreOptions();
    const loaded = reconcile
        ? projectStore.reconcileProjectState(options)
        : projectStore.loadProjectState(options);
    if (loaded?.fvpPath) PROJECT_FILE_PATH = loaded.fvpPath;
    for (const warning of loaded?.warnings || []) {
        console.warn(`[ProjectStore] ${warning}`);
    }
    return loaded;
}

function _persistUnifiedProjectState({ settings, videoPlan, revision, expectedRevision } = {}) {
    const saved = projectStore.saveProjectState({
        ..._projectStoreOptions(),
        settings,
        videoPlan,
        revision,
        expectedRevision,
    });
    PROJECT_FILE_PATH = saved.fvpPath;
    _addRecentProject(PROJECT_DIR);
    return saved;
}

function _persistUnifiedVideoPlan(videoPlan, expectedRevision, expectedPlanHash) {
    const current = _loadUnifiedProjectState({ reconcile: false });
    if (expectedRevision !== undefined && expectedRevision !== null
        && Number(expectedRevision) !== Number(current?.revision || 0)) {
        const error = new Error('Project changed since it was loaded');
        error.code = 'PROJECT_REVISION_CONFLICT';
        throw error;
    }
    if (expectedPlanHash && current?.planHash && expectedPlanHash !== current.planHash) {
        const error = new Error('Project plan changed since it was loaded');
        error.code = 'PROJECT_PLAN_CONFLICT';
        throw error;
    }
    return _persistUnifiedProjectState({
        settings: current?.settings || {},
        videoPlan,
        revision: current?.revision || 0,
        expectedRevision: current?.revision || 0,
    });
}
let _projectSaveQueue = Promise.resolve();
function _queueProjectSave(task) {
    const run = _projectSaveQueue.then(task, task);
    _projectSaveQueue = run.catch(() => {});
    return run;
}
const RECENT_PROJECTS_FILE = path.join(USER_DATA_DIR, 'recent-projects.json');
const LEGACY_RECENT_PROJECTS_FILE = path.join(APP_ROOT, 'recent-projects.json');
if (!fs.existsSync(RECENT_PROJECTS_FILE) && fs.existsSync(LEGACY_RECENT_PROJECTS_FILE)) {
    try {
        projectStore.atomicWriteJson(
            RECENT_PROJECTS_FILE,
            JSON.parse(fs.readFileSync(LEGACY_RECENT_PROJECTS_FILE, 'utf8'))
        );
    } catch (error) {
        console.warn(`[Projects] Could not migrate recent-projects.json: ${error.message}`);
    }
}

// Load .fvp project file
ipcMain.handle('load-project-file', async () => {
    console.log('[IPC] load-project-file called, PROJECT_DIR:', PROJECT_DIR);
    try {
        const loaded = _loadUnifiedProjectState({ reconcile: true });
        if (loaded?.videoPlan) {
            console.log(
                `✅ Loaded unified project state from ${loaded.source}`,
                `| revision=${loaded.revision}`,
                `| scenes=${loaded.videoPlan?.scenes?.length || 0}`
            );
            return loaded;
        }
        console.log('⚠️ No .fvp or video-plan.json found in:', PROJECT_DIR);
        return null;
    } catch (error) {
        console.error('❌ Failed to load project file:', error);
        return null;
    }
});

// Get recent projects list (same reader the agent remote control uses)
ipcMain.handle('get-recent-projects', async () => _listRecentProjects());

// Add to recent projects list
ipcMain.handle('add-recent-project', async () => {
    _addRecentProject(PROJECT_DIR);
    return { success: true };
});

function _addRecentProject(projectDir) {
    try {
        if (_pathsEqual(projectDir, DEFAULT_WORKSPACE_DIR)) return;
        if (!projectStore.inspectProjectDirectory({ projectDir }).valid) return;
        let recent = [];
        if (fs.existsSync(RECENT_PROJECTS_FILE)) {
            recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, 'utf8'));
        }
        // Remove duplicate, add to front, keep max 20
        recent = recent.filter(r => r.path !== projectDir);
        const projectName = path.basename(projectDir) || projectDir;
        recent.unshift({ path: projectDir, name: projectName, lastOpened: new Date().toISOString() });
        if (recent.length > 20) recent = recent.slice(0, 20);
        projectStore.atomicWriteJson(RECENT_PROJECTS_FILE, recent);
    } catch (e) {
        console.warn('Could not update recent projects:', e.message);
    }
}

// Get scene media path (video or image) for preview
ipcMain.handle('get-scene-media-path', async (event, sceneIndex, extension, prefix) => {
    try {
        const numericIndex = Number(sceneIndex);
        if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex > 1_000_000) return null;
        const allowedPrefixes = new Set(['scene', 'frame', 'article', 'overlay']);
        const filePrefix = prefix || 'scene';
        if (!allowedPrefixes.has(filePrefix)) return null;
        const allowedExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.jpg', '.jpeg', '.png', '.webp']);
        if (extension && !allowedExtensions.has(String(extension).toLowerCase())) return null;
        // Try with provided extension first, then try common extensions
        const extensions = extension ? [String(extension).toLowerCase()] : ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        for (const ext of extensions) {
            // Try both naming conventions: scene-{i}-asset{ext} (new) and scene-{i}{ext} (legacy)
            const publicAssetPath = path.join(PUBLIC_PATH, `${filePrefix}-${numericIndex}-asset${ext}`);
            if (fs.existsSync(publicAssetPath)) return publicAssetPath;
            const publicPath = path.join(PUBLIC_PATH, `${filePrefix}-${numericIndex}${ext}`);
            if (fs.existsSync(publicPath)) return publicPath;
            const tempPath = path.join(TEMP_PATH, `${filePrefix}-${numericIndex}${ext}`);
            if (fs.existsSync(tempPath)) return tempPath;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get scene media path:', error);
        return null;
    }
});

// Backward compatibility: get scene video path
ipcMain.handle('get-scene-video-path', async (event, sceneIndex) => {
    try {
        const numericIndex = Number(sceneIndex);
        if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex > 1_000_000) return null;
        const extensions = ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        for (const ext of extensions) {
            const publicAssetPath = path.join(PUBLIC_PATH, `scene-${numericIndex}-asset${ext}`);
            if (fs.existsSync(publicAssetPath)) return publicAssetPath;
            const publicPath = path.join(PUBLIC_PATH, `scene-${numericIndex}${ext}`);
            if (fs.existsSync(publicPath)) return publicPath;
            const tempPath = path.join(TEMP_PATH, `scene-${numericIndex}${ext}`);
            if (fs.existsSync(tempPath)) return tempPath;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get scene video path:', error);
        return null;
    }
});

// Get audio path for preview
ipcMain.handle('get-audio-path', async (event, filename) => {
    try {
        if (!filename) return null;
        const safeFilename = path.basename(String(filename));
        if (safeFilename !== String(filename) || !/\.(mp3|wav)$/i.test(safeFilename)) return null;

        // Prefer input/ — it is the STABLE source copy of the audio (written once per
        // build and never cleaned). public/ and temp/ are build outputs that Step 0 wipes,
        // so resolving the canonical audio path to them leaves a dangling reference that
        // breaks the next "Copy audio" on Generate/Repeat (ENOENT). Order: input → public → temp.
        const inputPath = path.join(INPUT_PATH, safeFilename);
        if (fs.existsSync(inputPath)) {
            return inputPath;
        }

        // Check public folder (serving copy)
        const publicPath = path.join(PUBLIC_PATH, safeFilename);
        if (fs.existsSync(publicPath)) {
            return publicPath;
        }

        // Check temp folder
        const tempPath = path.join(TEMP_PATH, safeFilename);
        if (fs.existsSync(tempPath)) {
            return tempPath;
        }

        return null;
    } catch (error) {
        console.error('❌ Failed to get audio path:', error);
        return null;
    }
});



// ========================================
// WebGL2 Compositor Engine - Export IPC
// ========================================

const WEBGL_FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');

// NVENC availability cache (shared with ffmpeg-renderer if loaded)
let _webglNvencAvailable = null;

async function probeNvencForWebGL() {
    if (_webglNvencAvailable !== null) return _webglNvencAvailable;
    try {
        await new Promise((resolve, reject) => {
            execFile(WEBGL_FFMPEG_PATH, [
                '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
                '-c:v', 'h264_nvenc', '-preset', 'p4',
                '-f', 'null', '-'
            ], { timeout: 10000 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        _webglNvencAvailable = true;
        console.log('[WebGL Export] NVENC GPU encoder available');
    } catch {
        _webglNvencAvailable = false;
        console.log('[WebGL Export] NVENC not available, will use CPU (libx264)');
    }
    return _webglNvencAvailable;
}

const WEBGL_EXPORT_MAX_DIMENSION = 4096;
const WEBGL_EXPORT_MAX_FRAME_BYTES = 48 * 1024 * 1024;
const WEBGL_EXPORT_MAX_FRAMES = 2_000_000;
const WEBGL_EXPORT_BATCH_SIZE = 3;
const WEBGL_EXPORT_WRITE_TIMEOUT_MS = 30_000;

// State for the one active WebGL export. The owning renderer is recorded so a
// secondary window cannot inject frames into, finish, or cancel another export.
let _webglExport = null;

function _validateWebglExportOptions(rawOptions = {}) {
    const width = Number(rawOptions.width);
    const height = Number(rawOptions.height);
    const fps = Number(rawOptions.fps);
    const totalFrames = Number(rawOptions.totalFrames);

    if (!Number.isInteger(width) || !Number.isInteger(height)
        || width < 16 || height < 16
        || width > WEBGL_EXPORT_MAX_DIMENSION || height > WEBGL_EXPORT_MAX_DIMENSION
        || width % 2 !== 0 || height % 2 !== 0) {
        throw new Error(`Invalid export dimensions: ${rawOptions.width}x${rawOptions.height}`);
    }
    if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
        throw new Error(`Invalid export frame rate: ${rawOptions.fps}`);
    }
    if (!Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > WEBGL_EXPORT_MAX_FRAMES) {
        throw new Error(`Invalid export frame count: ${rawOptions.totalFrames}`);
    }

    const expectedFrameSize = width * height * 4;
    if (!Number.isSafeInteger(expectedFrameSize) || expectedFrameSize > WEBGL_EXPORT_MAX_FRAME_BYTES) {
        throw new Error(`Export frame buffer is too large: ${expectedFrameSize} bytes`);
    }

    const parseTrim = (value, name) => {
        if (value == null) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24 * 60 * 60) {
            throw new Error(`Invalid ${name}: ${value}`);
        }
        return parsed;
    };
    const audioTrimStartSec = parseTrim(rawOptions.audioTrimStartSec, 'audio trim start');
    const audioTrimEndSec = parseTrim(rawOptions.audioTrimEndSec, 'audio trim end');
    if (audioTrimStartSec != null && audioTrimEndSec != null && audioTrimEndSec <= audioTrimStartSec) {
        throw new Error('Audio trim end must be after trim start');
    }

    return { width, height, fps, totalFrames, expectedFrameSize, audioTrimStartSec, audioTrimEndSec };
}

function _getOwnedWebglExport(event, exportId, allowedStatuses = ['running']) {
    const exp = _webglExport;
    if (!exp || !allowedStatuses.includes(exp.status) || !exp.proc || exp.proc.killed) {
        throw new Error('No active export process');
    }
    if (exp.ownerWebContentsId !== event.sender.id) {
        throw new Error('This renderer does not own the active export');
    }
    if (typeof exportId !== 'string' || exportId !== exp.exportId) {
        throw new Error('Stale or invalid export ID');
    }
    return exp;
}

function _webglFrameBuffer(value, expectedSize) {
    let buffer;
    if (value instanceof ArrayBuffer) {
        buffer = Buffer.from(value);
    } else if (ArrayBuffer.isView(value)) {
        buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
        throw new Error('Frame payload must be an ArrayBuffer or typed array');
    }
    if (buffer.length !== expectedSize) {
        throw new Error(`Frame buffer size mismatch: ${buffer.length} bytes; expected ${expectedSize}`);
    }
    return buffer;
}

function _detachWebglExportOwner(exp) {
    try {
        exp?.ownerSender?.removeListener('destroyed', exp.ownerDestroyedHandler);
    } catch (_) { }
}

async function _terminateChildProcess(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { child.stdin?.destroy(); } catch (_) { }

    const waitForClose = new Promise((resolve) => {
        let timeout = null;
        const onClose = () => {
            if (timeout) clearTimeout(timeout);
            resolve();
        };
        child.once('close', onClose);
        timeout = setTimeout(() => {
            child.removeListener('close', onClose);
            resolve();
        }, 5000);
    });

    if (process.platform === 'win32' && child.pid) {
        const killed = await new Promise((resolve) => {
            execFile(
                'taskkill',
                ['/pid', String(child.pid), '/f', '/t'],
                { windowsHide: true, timeout: 5000 },
                (error) => resolve(!error)
            );
        });
        if (!killed) {
            try { child.kill('SIGTERM'); } catch (_) { }
        }
    } else {
        try { child.kill('SIGTERM'); } catch (_) { }
    }
    await waitForClose;
}

async function _terminateWebglExport(exp) {
    if (!exp) return;
    exp.status = 'cancelled';
    await Promise.all([
        _terminateChildProcess(exp.proc),
        _terminateChildProcess(exp.muxProc),
    ]);
}

function _assertNonEmptyFile(filePath, label) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (_) {
        throw new Error(`${label} was not created`);
    }
    if (!stat.isFile() || stat.size < 1) {
        throw new Error(`${label} is empty`);
    }
}

function _writeWebglChunk(exp, chunk) {
    return new Promise((resolve, reject) => {
        if (_webglExport !== exp || exp.status !== 'running' || exp.proc.killed) {
            reject(new Error('Export process is no longer writable'));
            return;
        }

        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            exp.proc.removeListener('close', onClose);
            exp.proc.stdin.removeListener('error', onError);
            if (error) reject(error);
            else resolve();
        };
        const onClose = (code) => finish(new Error(`FFmpeg closed while writing frames (code ${code})`));
        const onError = (error) => finish(error);
        const timeout = setTimeout(
            () => finish(new Error('Timed out writing frames to FFmpeg')),
            WEBGL_EXPORT_WRITE_TIMEOUT_MS
        );

        exp.proc.once('close', onClose);
        exp.proc.stdin.once('error', onError);
        try {
            exp.proc.stdin.write(chunk, (error) => finish(error || null));
        } catch (error) {
            finish(error);
        }
    });
}

ipcMain.handle('start-webgl-export', async (event, rawOptions = {}) => {
    if (_webglExport) {
        return { success: false, error: 'Another WebGL export is already active' };
    }

    let reservation = null;
    try {
        const options = _validateWebglExportOptions(rawOptions);
        const ownerSender = event.sender;
        const ownerWebContentsId = ownerSender.id;
        reservation = {
            exportId: crypto.randomUUID(),
            status: 'starting',
            cancelled: false,
            ownerSender,
            ownerWebContentsId,
        };
        reservation.ownerDestroyedHandler = () => {
            reservation.cancelled = true;
            if (_webglExport === reservation) {
                _webglExport = null;
                void _terminateWebglExport(reservation);
            }
        };
        ownerSender.once('destroyed', reservation.ownerDestroyedHandler);
        _webglExport = reservation;

        const useGpu = await probeNvencForWebGL();
        if (reservation.cancelled || ownerSender.isDestroyed() || _webglExport !== reservation) {
            throw new Error('Export cancelled before the encoder started');
        }

        const timestamp = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomBytes(3).toString('hex')}`;
        const videoFile = path.join(TEMP_PATH, `webgl-video-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);
        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        const encArgs = useGpu
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M', '-maxrate:v', '24M', '-bufsize:v', '48M']
            : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22'];
        console.log(`[WebGL Export] Starting: ${options.width}x${options.height} @ ${options.fps}fps, ${options.totalFrames} frames, encoder: ${useGpu ? 'NVENC' : 'libx264'}`);

        const ffmpegProc = spawn(WEBGL_FFMPEG_PATH, [
            '-y',
            '-f', 'rawvideo',
            '-pixel_format', 'rgba',
            '-video_size', `${options.width}x${options.height}`,
            '-framerate', String(options.fps),
            '-i', 'pipe:0',
            ...encArgs,
            '-pix_fmt', 'yuv420p',
            '-an',
            videoFile,
        ], {
            stdio: ['pipe', 'ignore', 'pipe'],
            windowsHide: true,
        });

        Object.assign(reservation, {
            ...options,
            status: 'running',
            proc: ffmpegProc,
            videoFile,
            outputFile,
            stderr: '',
            framesAccepted: 0,
            framesWritten: 0,
            bytesWritten: 0,
            lastLogTime: Date.now(),
            lastLogFrames: 0,
            writeChain: Promise.resolve(),
        });
        ffmpegProc.stderr.on('data', (data) => {
            reservation.stderr = (reservation.stderr + data.toString()).slice(-64 * 1024);
        });
        reservation.exitPromise = new Promise((resolve) => {
            ffmpegProc.once('error', (error) => resolve({ code: null, error: error.message }));
            ffmpegProc.once('close', (code, signal) => resolve({ code, signal, error: null }));
        });

        return {
            success: true,
            exportId: reservation.exportId,
            encoder: useGpu ? 'h264_nvenc' : 'libx264',
        };
    } catch (err) {
        console.error('[WebGL Export] start error:', err.message);
        if (reservation) {
            if (_webglExport === reservation) _webglExport = null;
            _detachWebglExportOwner(reservation);
            await _terminateWebglExport(reservation);
        }
        return { success: false, error: err.message };
    }
});

ipcMain.handle('save-project-file', async (_event, data) => _queueProjectSave(async () => {
    try {
        const safeData = _boundedPlainObject(data, 32 * 1024 * 1024);
        const current = _loadUnifiedProjectState({ reconcile: false });
        const expectedRevision = safeData?.expectedRevision;
        const expectedPlanHash = safeData?.expectedPlanHash;
        if (expectedRevision !== undefined && expectedRevision !== null
            && Number(expectedRevision) !== Number(current?.revision || 0)) {
            return {
                success: false,
                conflict: true,
                error: 'Project changed since it was loaded',
                currentRevision: current?.revision || 0,
                currentPlanHash: current?.planHash || null,
            };
        }
        if (expectedPlanHash && current?.planHash && expectedPlanHash !== current.planHash) {
            return {
                success: false,
                conflict: true,
                error: 'Project plan changed since it was loaded',
                currentRevision: current?.revision || 0,
                currentPlanHash: current?.planHash || null,
            };
        }
        const saved = _persistUnifiedProjectState({
            settings: safeData?.settings || {},
            videoPlan: safeData?.videoPlan,
            revision: current?.revision || 0,
            expectedRevision: current?.revision || 0,
        });
        return {
            success: true,
            path: saved.fvpPath,
            revision: saved.revision,
            planHash: saved.planHash,
        };
    } catch (error) {
        console.error('[ProjectStore] Save failed:', error);
        return {
            success: false,
            conflict: error.code === 'PROJECT_REVISION_CONFLICT' || error.code === 'PROJECT_PLAN_CONFLICT',
            error: error.message,
        };
    }
}));

ipcMain.handle('export-frames-batch', async (event, batchPayload = {}) => {
    try {
        const exp = _getOwnedWebglExport(event, batchPayload.exportId);
        const frames = batchPayload.frames;
        if (!Array.isArray(frames) || frames.length < 1 || frames.length > WEBGL_EXPORT_BATCH_SIZE) {
            throw new Error(`Frame batch must contain 1-${WEBGL_EXPORT_BATCH_SIZE} frames`);
        }
        if (exp.framesAccepted + frames.length > exp.totalFrames) {
            throw new Error(`Frame batch exceeds declared total of ${exp.totalFrames}`);
        }

        const firstFrameIndex = exp.framesAccepted;
        const sources = frames.map((entry, index) => {
            const expectedIndex = firstFrameIndex + index;
            if (!entry || !Number.isInteger(entry.frameIndex) || entry.frameIndex !== expectedIndex) {
                throw new Error(`Out-of-order frame: received ${entry?.frameIndex}; expected ${expectedIndex}`);
            }
            return _webglFrameBuffer(entry.buffer, exp.expectedFrameSize);
        });

        const combined = Buffer.allocUnsafe(exp.expectedFrameSize * sources.length);
        for (let index = 0; index < sources.length; index++) {
            sources[index].copy(combined, index * exp.expectedFrameSize);
        }
        exp.framesAccepted += sources.length;

        const writeTask = exp.writeChain.then(async () => {
            await _writeWebglChunk(exp, combined);
            exp.framesWritten += sources.length;
            exp.bytesWritten += combined.length;

            const now = Date.now();
            if (now - exp.lastLogTime >= 1000) {
                const elapsed = (now - exp.lastLogTime) / 1000;
                const recentFrames = exp.framesWritten - exp.lastLogFrames;
                const recentFps = (recentFrames / elapsed).toFixed(1);
                const totalMB = (exp.bytesWritten / (1024 * 1024)).toFixed(0);
                console.log(`[WebGL Export] ${exp.framesWritten}/${exp.totalFrames} frames | ${recentFps} fps recent | ${totalMB} MB written`);
                exp.lastLogTime = now;
                exp.lastLogFrames = exp.framesWritten;
            }
            return { success: true, written: sources.length };
        });
        exp.writeChain = writeTask;
        return await writeTask;
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('finish-webgl-export', async (event, exportId) => {
    let exp = null;
    let timeout = null;
    try {
        exp = _getOwnedWebglExport(event, exportId);
        exp.status = 'finishing';
        await exp.writeChain;
        if (exp.framesAccepted !== exp.totalFrames || exp.framesWritten !== exp.totalFrames) {
            throw new Error(`Incomplete export: received ${exp.framesWritten}/${exp.totalFrames} frames`);
        }

        exp.proc.stdin.end();
        const exitResult = await Promise.race([
            exp.exitPromise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('FFmpeg encoding timeout')), 120_000);
            }),
        ]);
        clearTimeout(timeout);
        timeout = null;

        if (exitResult.error || exitResult.code !== 0) {
            const detail = exp.stderr.trim().slice(-1200);
            throw new Error(exitResult.error || `FFmpeg exited with code ${exitResult.code}${detail ? `\n${detail}` : ''}`);
        }
        _assertNonEmptyFile(exp.videoFile, 'Encoded WebGL video');

        console.log(`[WebGL Export] Video encoded: ${exp.videoFile} (${exp.framesWritten} frames)`);
        exp.status = 'muxing';
        const finalOutput = await _webglMuxAudio(exp);
        if (_webglExport !== exp || exp.status === 'cancelled') {
            throw new Error('Export cancelled');
        }
        _assertNonEmptyFile(finalOutput, 'Final WebGL output');

        exp.status = 'finished';
        if (_webglExport === exp) _webglExport = null;
        _detachWebglExportOwner(exp);
        return { success: true, outputPath: finalOutput };
    } catch (err) {
        if (timeout) clearTimeout(timeout);
        console.error('[WebGL Export] finish error:', err.message);
        if (exp) {
            if (_webglExport === exp) _webglExport = null;
            _detachWebglExportOwner(exp);
            await _terminateWebglExport(exp);
        }
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cancel-webgl-export', async (event, exportId) => {
    const exp = _webglExport;
    if (!exp) return { success: true };
    if (exp.ownerWebContentsId !== event.sender.id) {
        return { success: false, error: 'This renderer does not own the active export' };
    }
    if (typeof exportId !== 'string' || exportId !== exp.exportId) {
        return { success: false, error: 'Stale or invalid export ID' };
    }

    exp.cancelled = true;
    _webglExport = null;
    _detachWebglExportOwner(exp);
    await _terminateWebglExport(exp);
    return { success: true };
});

function sendRenderProgress(percent, message) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const contents = mainWindow.webContents;
    if (!contents || contents.isDestroyed()) return;
    try {
        contents.send('render-progress', { percent, message });
    } catch (error) {
        console.warn(`[HyperFrames] Could not deliver render progress: ${error.message}`);
    }
}

function checkHyperframesNodeRuntime() {
    try {
        const configuredPath = String(
            process.env.HYPERFRAMES_NODE_PATH
            || process.env.HF_MOTION_QA_NODE_PATH
            || ''
        ).trim();
        const command = configuredPath || 'node';
        const version = execFileSync(command, ['-v'], {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const resolvedPath = execFileSync(command, ['-p', 'process.execPath'], {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const major = parseInt(version.replace(/^v/, '').split('.')[0], 10);
        return {
            ok: Number.isFinite(major) && major >= 22,
            version,
            major,
            path: resolvedPath || command,
        };
    } catch (err) {
        return {
            ok: false,
            version: 'not found',
            error: err.message,
        };
    }
}

// HyperFrames' optimized render/capture path REQUIRES Google's chrome-headless-shell.
// A full chrome.exe / brave.exe makes the streaming capture hang on the (15 min)
// protocol timeout instead of rendering. So always prefer the headless-shell that
// HyperFrames downloads into its own browser cache (~/.cache/hyperframes/chrome).
function findHyperframesHeadlessShell() {
    let homeDir = '';
    try { homeDir = require('os').homedir(); } catch (_) { homeDir = process.env.USERPROFILE || ''; }
    if (!homeDir) return null;
    const base = path.join(homeDir, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell');
    try {
        if (!fs.existsSync(base)) return null;
        // Version-agnostic: pick whatever win64-<version> build is present.
        for (const entry of fs.readdirSync(base)) {
            for (const sub of ['chrome-headless-shell-win64', 'chrome-headless-shell-linux64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-mac-arm64']) {
                const exe = path.join(base, entry, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
                if (fs.existsSync(exe)) return exe;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

// An interrupted browser download leaves the headless-shell folder present but
// WITHOUT the executable. That makes HyperFrames fail ("Browser was not found at
// executablePath") AND blocks @puppeteer/browsers from re-downloading ("folder
// exists but executable is missing"). Purge confirmed-broken partials so the next
// render can cleanly re-fetch. Only runs when NO valid install exists.
function purgePartialHyperframesBrowser() {
    let homeDir = '';
    try { homeDir = require('os').homedir(); } catch (_) { homeDir = process.env.USERPROFILE || ''; }
    if (!homeDir) return;
    const base = path.join(homeDir, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell');
    try {
        if (!fs.existsSync(base)) return;
        if (findHyperframesHeadlessShell()) return; // a valid install exists — leave it alone
        for (const entry of fs.readdirSync(base)) {
            const full = path.join(base, entry);
            try {
                fs.rmSync(full, { recursive: true, force: true });
                console.warn(`[HyperFrames] Removed partial/corrupt browser cache: ${full}`);
            } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
}

function findHyperframesBrowserPath() {
    // Prefer the proper headless-shell; a full system browser is only a last resort.
    const headlessShell = findHyperframesHeadlessShell();
    if (headlessShell) return headlessShell;
    const programFiles = process.env.PROGRAMFILES || process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || process.env.LocalAppData;
    const candidates = [
        process.env.HYPERFRAMES_BROWSER_PATH,
        process.env.PRODUCER_HEADLESS_SHELL_PATH,
        process.env.CHROME_PATH,
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : null,
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);

    return candidates.find((candidate) => {
        try {
            return fs.existsSync(candidate);
        } catch (_) {
            return false;
        }
    }) || null;
}

// Pre-render lint gate (OPENMONTAGE-BORROW-PLAN #12). Runs the hyperframes CLI's
// own `lint` validator on the generated project and logs findings BEFORE the
// expensive render. Advisory only — never blocks the render. HF_PRERENDER_LINT=0
// disables. Returns a summary object (or null when skipped/unavailable).
function runHyperframesLint(projectDir) {
    if (/^(0|false|off|no)$/i.test(String(process.env.HF_PRERENDER_LINT || '').trim())) return null;
    const { spawnSync } = require('child_process');
    const localCliJs = path.join(PROJECT_ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');
    if (!fs.existsSync(localCliJs)) return null;
    let r;
    try {
        r = spawnSync('node', [localCliJs, 'lint', projectDir, '--json'], {
            cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: true,
        });
    } catch (e) { console.warn(`[HF-Lint] skipped (${e.message})`); return null; }
    let data = null;
    try { data = JSON.parse(String(r.stdout || '').trim()); } catch (_) { /* non-JSON */ }
    if (!data || !Array.isArray(data.findings)) { return null; }
    const errs = Number(data.errorCount || 0);
    const warns = Number(data.warningCount || 0);
    if (errs === 0 && warns === 0) {
        console.log('[HF-Lint] ✅ composition clean (0 errors, 0 warnings)');
        return { ok: true, errorCount: 0, warningCount: 0 };
    }
    console.warn(`[HF-Lint] ${errs} error(s), ${warns} warning(s) in the generated composition:`);
    for (const f of data.findings.filter((x) => x.severity === 'error' || x.severity === 'warning').slice(0, 20)) {
        console.warn(`[HF-Lint]   ${f.severity === 'error' ? '❌' : '⚠️'} ${f.code}: ${f.message}${f.elementId ? ` (#${f.elementId})` : ''}`);
    }
    return { ok: data.ok !== false, errorCount: errs, warningCount: warns, findings: data.findings };
}

// The CLI guards frame capture with a stall watchdog (HF_DE_STALL_MS, default
// 60s). Its clock starts the moment capture is requested -- BEFORE the workers
// launch their browsers, navigate the page and inject every clip -- and only
// resets on real frame progress. On a heavy project that setup legitimately
// costs more than 60s, so the watchdog fires mid-setup and kills a render that
// was never stalled. Measured 2026-07-31 (79 clips, 4 workers): the four
// workers reported "media + fonts + tailwind ready" at 44s, 45s, 64s and 82s;
// the watchdog aborted at 0/7789 frames and main.js fell all the way back to
// the 1-worker software tier for the whole render. This is deterministic, not
// bad luck: the longer the video, the more clips, the more certain the failure.
//
// Every worker loads every media file, so setup cost tracks the project's own
// media count -- budget from that rather than a flat number, and never go below
// the CLI default. The ceiling bounds how long a genuinely hung capture can
// burn before the fallback tiers take over.
function resolveCaptureStallBudgetMs(projectDir) {
    let mediaCount = 0;
    try {
        mediaCount = fs.readdirSync(path.join(projectDir, 'media')).length;
    } catch (_) { /* no media dir -- the floor still applies */ }
    const budget = 120000 + (mediaCount * 2000);
    return Math.max(180000, Math.min(600000, budget));
}

// Extracting frames from the scene clips is one of the most expensive phases of
// a render (measured 2026-07-31: videoExtractMs 74634 for 44 clips / 265 MB).
// The CLI caches those frames, and the cache works -- but two things stopped it
// from ever paying off across renders:
//
//  1. Its key hashed the ABSOLUTE media path, and every render writes a fresh
//     yta-hf-<timestamp> project dir, so the key changed every time. Proof from
//     that render, with nothing changed in between: the first capture attempt
//     logged cacheHits 0 / cacheMisses 48, and the retry -- on the SAME project
//     dir -- logged 48 / 0. Fixed in scripts/patch-hyperframes-extract-cache.js.
//
//  2. The cache defaults to the OS temp dir with a 2 GB cap, and ONE render of
//     that project produced 1.9 GB of frames. Even with a stable key it would
//     evict itself before the next render could use it -- and it sat on the
//     system drive whose exhaustion the CLI's own preflight warns about.
//
// So place it on the roomiest writable home we have and size the cap from THAT
// drive's free space: a 20-minute video extracts several times the frames a
// 4-minute one does, and the machine rendering it may have any amount of room,
// so a flat number is wrong in both directions. Returns null when nothing has
// space to spare, which leaves the CLI's own defaults untouched.
function resolveExtractCacheSettings(projectDir) {
    const GB = 1024 ** 3;
    const RESERVE_BYTES = 15 * GB;   // headroom we will never plan to spend
    const MIN_USEFUL_BYTES = 4 * GB; // below this a cache cannot hold one render
    const MAX_CAP_BYTES = 64 * GB;

    // Free space on the nearest ancestor that actually exists, so a candidate
    // can be measured before its directory is created.
    const freeBytesNear = (target) => {
        let dir = target;
        for (let i = 0; i < 12; i++) {
            try {
                const st = fs.statfsSync(dir);
                return st.bavail * st.bsize;
            } catch (_) { /* walk up */ }
            const parent = path.dirname(dir);
            if (!parent || parent === dir) break;
            dir = parent;
        }
        return null;
    };

    const candidates = [];
    // The project's own volume: the same drive the media and the render output
    // already live on. Sibling of the yta-hf-* dirs, which the bridge's prune
    // matches by /^yta-hf-/ -- so it is never swept up by housekeeping.
    if (projectDir) candidates.push(path.join(path.dirname(projectDir), '.hf-extract-cache'));
    // The app's own volume. Writable when running from source; inside an asar
    // in a packaged build, where the write test below rejects it.
    candidates.push(path.join(PROJECT_ROOT, '.hf-extract-cache'));
    // Always writable, including packaged builds.
    try { candidates.push(path.join(app.getPath('userData'), 'hf-extract-cache')); } catch (_) {}

    const ranked = candidates
        .map((dir) => ({ dir, free: freeBytesNear(dir) }))
        .filter((c) => Number.isFinite(c.free) && c.free - RESERVE_BYTES >= MIN_USEFUL_BYTES)
        .sort((a, b) => b.free - a.free);

    for (const { dir, free } of ranked) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
        } catch (_) { continue; }  // not writable -- try the next-roomiest
        const capBytes = Math.min(
            MAX_CAP_BYTES,
            free - RESERVE_BYTES,
            Math.max(MIN_USEFUL_BYTES, Math.floor(free * 0.15))
        );
        return { dir, maxMb: Math.floor(capBytes / (1024 ** 2)), freeGb: free / GB };
    }
    return null;
}

function runHyperframesCli(projectDir, outputFile, options = {}) {
    return new Promise((resolve) => {
        const localCliJs = path.join(PROJECT_ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');
        const hasLocalCli = fs.existsSync(localCliJs);
        if (!hasLocalCli) {
            resolve({ success: false, error: 'Bundled HyperFrames CLI is missing; reinstall application dependencies' });
            return;
        }
        const cliCmd = options.nodePath || 'node';
        const workerCountRaw = Number(options.workers);
        const workerCount = Number.isFinite(workerCountRaw) && workerCountRaw > 0
            ? Math.max(1, Math.min(8, Math.floor(workerCountRaw)))
            : 1;
        const browserGpu = options.browserGpu === true;
        // Streaming encode: run the encoder alongside frame capture instead of
        // encoding only after every frame has landed on disk. Measured on a
        // 4m20s / 7789-frame project: capture+encode 833.7s sequential -> 596.9s
        // overlapped, with 845 frames bit-identical and mean PSNR 51.5 dB vs the
        // sequential render (i.e. ordinary encoder variance, not a quality change
        // -- every capture setting is untouched, only the frame delivery route
        // differs). Requires the interleaved distributor, which needs >1 worker,
        // so the 1-worker software fallback tier deliberately stays sequential.
        // Depends on scripts/patch-hyperframes-streaming.js; see that file.
        // Kill switch: HF_STREAMING_ENCODE=0 restores the sequential path.
        const streamingEncodeOff = String(process.env.HF_STREAMING_ENCODE ?? '').trim() === '0'
            || String(process.env.HF_CAPTURE_PARALLEL_STREAM ?? '').trim() === 'false';
        const useStreamingEncode = !streamingEncodeOff && workerCount > 1;
        const args = [
            localCliJs,
            'render',
            projectDir,
            '--output',
            outputFile,
            '--fps',
            String(options.fps || 30),
            '--quality',
            options.quality || 'standard',
            '--workers',
            String(workerCount),
        ];
        const browserPath = findHyperframesBrowserPath();
        if (options.gpu !== false) args.push('--gpu');
        args.push(browserGpu ? '--browser-gpu' : '--no-browser-gpu');
        if (options.strict) args.push('--strict');
        // HDR output policy. Our composition is an sRGB DOM (themes, text,
        // graphics) with stock clips composited into it, bound for an SDR
        // YouTube upload -- but the CLI's default `auto` mode promotes the
        // ENTIRE render to HLG/BT.2020 the moment one downloaded clip carries
        // HDR metadata. That flips the capture plan to `hdr_layered`, which
        // hardcodes forceScreenshot:true and disables streaming encode: one
        // CDP screenshot + a Node-side 16-bit layered composite per frame.
        // Measured 2026-08-15 on a 270-scene / 16,888-frame project where 2 of
        // 131 clips were HDR: 0.33 fps, ~13.7h ETA, then "Target closed".
        // HF_HDR_OUTPUT=auto restores source-driven detection; =hdr forces it.
        const hdrOutput = String(process.env.HF_HDR_OUTPUT || '').trim().toLowerCase();
        if (hdrOutput === 'hdr') args.push('--hdr');
        else if (hdrOutput !== 'auto') args.push('--sdr');

        // Explicit env wins: if the operator pinned a budget, never override it.
        const stallBudgetMs = Number(process.env.HF_DE_STALL_MS) > 0
            ? Math.floor(Number(process.env.HF_DE_STALL_MS))
            : resolveCaptureStallBudgetMs(projectDir);

        // Same rule for the frame cache: a pinned directory is the operator's.
        const extractCache = process.env.HYPERFRAMES_EXTRACT_CACHE_DIR
            ? null
            : resolveExtractCacheSettings(projectDir);

        console.log(`[HyperFrames] Running: ${cliCmd} ${args.join(' ')}`);
        console.log(`[HyperFrames] Browser: ${browserPath || 'HyperFrames default browser resolution'}`);
        console.log(`[HyperFrames] Capture stall budget: ${Math.round(stallBudgetMs / 1000)}s (page setup + between frames)`);
        if (extractCache) {
            console.log(`[HyperFrames] Frame cache: ${extractCache.dir} (cap ${Math.round(extractCache.maxMb / 1024)}GB of ${Math.round(extractCache.freeGb)}GB free)`);
        }
        const workerLabel = workerCount === 1 ? '1 worker' : `${workerCount} workers`;
        sendRenderProgress(18, `[HyperFrames] Rendering ${options.gpu === false ? 'CPU' : 'GPU'} HTML/MG composition (${workerLabel}, browser ${browserGpu ? 'GPU' : 'software'})...`);

        const proc = spawn(cliCmd, args, {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                FORCE_COLOR: '0',
                PRODUCER_MAX_WORKERS: String(workerCount),
                PRODUCER_BROWSER_GPU_MODE: browserGpu ? 'hardware' : 'software',
                PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: String(options.protocolTimeoutMs || 900000),
                PRODUCER_PLAYER_READY_TIMEOUT_MS: String(options.playerReadyTimeoutMs || 180000),
                PRODUCER_RENDER_READY_TIMEOUT_MS: String(options.renderReadyTimeoutMs || 180000),
                // See resolveCaptureStallBudgetMs: the CLI's 60s default is
                // shorter than page setup on a heavy project, which silently
                // demotes every long render to the slowest tier.
                HF_DE_STALL_MS: String(stallBudgetMs),
                // See resolveExtractCacheSettings: the CLI's default cache is a
                // 2GB dir in the system temp folder, and one render of a real
                // project writes ~1.9GB of frames -- so it evicts itself before
                // the next render can reuse anything.
                ...(extractCache ? {
                    HYPERFRAMES_EXTRACT_CACHE_DIR: extractCache.dir,
                    HYPERFRAMES_EXTRACT_CACHE_MAX_MB: String(extractCache.maxMb),
                } : {}),
                ...(useStreamingEncode ? {
                    PRODUCER_ENABLE_STREAMING_ENCODE: 'true',
                    // Default cap is 240s, which silently excluded anything over
                    // 4 minutes -- i.e. almost every real video.
                    PRODUCER_STREAMING_ENCODE_MAX_DURATION_SECONDS: String(
                        options.streamingEncodeMaxSeconds || 36000
                    ),
                    HF_CAPTURE_PARALLEL_STREAM: 'true',
                } : {}),
                ...(browserPath ? {
                    HYPERFRAMES_BROWSER_PATH: browserPath,
                    PRODUCER_HEADLESS_SHELL_PATH: browserPath,
                } : {}),
            },
            windowsHide: true,
        });
        activeProcess = proc;
        activeProcessType = 'render';

        let stdout = '';
        let stderr = '';
        const started = Date.now();
        let lastFrameLogAt = 0;
        let lastFrameLogged = 0;
        let lastFrameProgressAt = 0;
        let sawFrameProgress = false;
        const progressTimer = setInterval(() => {
            const sec = ((Date.now() - started) / 1000).toFixed(0);
            if (!sawFrameProgress) {
                sendRenderProgress(45, `[HyperFrames] Rendering... ${sec}s elapsed`);
            }
        }, 5000);

        const stripAnsi = (value) => String(value || '')
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');

        const appendTail = (current, text) => (current + text).slice(-50000);
        const isCancellationError = () => activeRenderCancelled === true;
        // A stall is a timing verdict, not a capability verdict: the browser and
        // the GPU were fine, capture just never got going in the allotted time.
        // Distinguishing it lets the caller retry with less parallelism instead
        // of dropping the GPU too and taking the slowest path available.
        const sawCaptureStall = () => /capture stalled: no frame progress/i.test(`${stdout}\n${stderr}`);

        const handleCliOutput = (raw, streamName) => {
            const text = raw.toString();
            if (streamName === 'stdout') stdout = appendTail(stdout, text);
            else stderr = appendTail(stderr, text);

            const clean = stripAnsi(text).replace(/\r/g, '\n');
            // The CLI labels this line by capture route: "Streaming frame" on the
            // overlapped streaming path, "Capturing frame" on the sequential disk
            // path (single-worker fallback, or HF_STREAMING_ENCODE=0). Matching
            // only the former left the progress bar frozen on the disk path for
            // the whole capture phase.
            const frameMatches = [...clean.matchAll(/(?:Streaming|Capturing) frame\s+(\d+)\s*\/\s*(\d+)/g)];
            if (frameMatches.length) {
                const lastMatch = frameMatches[frameMatches.length - 1];
                const frame = Number(lastMatch[1]);
                const total = Number(lastMatch[2]);
                const now = Date.now();
                if (Number.isFinite(frame) && Number.isFinite(total) && total > 0) {
                    sawFrameProgress = true;
                    if (now - lastFrameProgressAt >= 1000 || frame === total) {
                        const percent = Math.min(98, Math.max(20, Math.round(20 + (frame / total) * 76)));
                        sendRenderProgress(percent, `[HyperFrames] Rendering frame ${frame}/${total} (${workerLabel}, browser ${browserGpu ? 'GPU' : 'software'})`);
                        lastFrameProgressAt = now;
                    }
                    if (now - lastFrameLogAt >= 5000 || frame - lastFrameLogged >= 250 || frame === total) {
                        console.log(`[HyperFrames] Streaming frame ${frame}/${total}`);
                        lastFrameLogAt = now;
                        lastFrameLogged = frame;
                    }
                }
            }

            const nonFrameLines = clean
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !/Streaming frame\s+\d+\s*\/\s*\d+/.test(line));
            for (const line of nonFrameLines) {
                console.log(`[HyperFrames] ${line}`);
            }
        };

        proc.stdout.on('data', (data) => {
            handleCliOutput(data, 'stdout');
        });
        proc.stderr.on('data', (data) => {
            handleCliOutput(data, 'stderr');
        });
        proc.on('error', (err) => {
            clearInterval(progressTimer);
            activeProcess = null;
            activeProcessType = null;
            if (isCancellationError()) {
                resolve({ success: false, cancelled: true, error: 'Cancelled', stdout, stderr });
                return;
            }
            resolve({ success: false, error: err.message, stdout, stderr });
        });
        proc.on('close', (code) => {
            clearInterval(progressTimer);
            activeProcess = null;
            activeProcessType = null;
            if (isCancellationError()) {
                resolve({ success: false, cancelled: true, error: 'Cancelled', stdout, stderr });
                return;
            }
            if (code === 0 && fs.existsSync(outputFile)) {
                resolve({ success: true, outputPath: outputFile, stdout, stderr });
            } else {
                const tail = `${stdout}\n${stderr}`.trim().slice(-2000);
                resolve({
                    success: false,
                    stalled: sawCaptureStall(),
                    error: `HyperFrames exited with code ${code}${tail ? `\n${tail}` : ''}`,
                    stdout,
                    stderr,
                });
            }
        });
    });
}

function loadHyperframesBridgeFresh() {
    const bridgePath = require.resolve('./src/render/hyperframes-bridge');
    delete require.cache[bridgePath];
    return require(bridgePath);
}

// Agent-authored compositions (templates + fullscreen MGs). Runs on the final
// plan right before the bridge so `_authoredComposition` lands on the exact
// objects the bridge renders. Failures degrade silently to fixed renderers.
async function runCompositionAuthorPass(plan) {
    try {
        if (!plan) return;
        const { authorPlanCompositions } = require('./src/agents/workers/composition-author');
        // openMode: project open / refresh / render-prep must NEVER author —
        // fresh authoring belongs to builds (Step 7.6). HF_AUTHOR_REFRESH=1
        // overrides for an explicit re-author.
        const openMode = !/^(1|true|on|yes)$/i.test(String(process.env.HF_AUTHOR_REFRESH || '').trim());
        await authorPlanCompositions(plan, { projectDir: PROJECT_DIR, openMode, log: (m) => console.log(`[HyperFrames]${m}`) });
    } catch (err) {
        console.warn(`[HyperFrames] composition author pass skipped: ${err.message}`);
    }
}

ipcMain.handle('hyperframes-generate-project', async (_event, payload = {}) => {
    try {
        await runCompositionAuthorPass(payload.plan);
        let previewMotionQa = null;
        if (payload.plan) {
            const { prepareMotionPlan } = require('./src/agents/workers/motion-qa-agent');
            previewMotionQa = prepareMotionPlan(payload.plan, {
                log: (message) => console.log(`[HyperFrames Preview] ${message}`),
            });
            payload.plan.motionQa = {
                version: previewMotionQa.version || 1,
                status: previewMotionQa.status,
                agentic: true,
                stage: 'preview-preflight',
                checkedVisuals: previewMotionQa.checked || 0,
                repairCount: (previewMotionQa.repairs || []).length,
                findingCount: (previewMotionQa.findings || []).length,
            };
        }
        const { generateHyperframesProject } = loadHyperframesBridgeFresh();
        const result = generateHyperframesProject({
            plan: payload.plan,
            projectDir: PROJECT_DIR,
            appRoot: APP_ROOT,
            tempDir: TEMP_PATH,
            publicDir: PUBLIC_PATH,
            inputDir: INPUT_PATH,
            outputRoot: path.join(PROJECT_DIR, 'hyperframes'),
            options: payload.options || {},
        });
        let savedPlan = null;
        const persistMotionQa = payload?.options?.persistMotionQa !== false;
        if ((previewMotionQa?.repairs || []).length > 0 && persistMotionQa) {
            try {
                savedPlan = _persistUnifiedVideoPlan(payload.plan);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('qa-plan-updated', {
                        videoPlan: payload.plan,
                        revision: savedPlan.revision,
                        planHash: savedPlan.planHash,
                        source: 'motion-qa-preview',
                        motionQa: payload.plan.motionQa,
                    });
                }
                console.log(`[HyperFrames Preview] Motion QA persisted ${previewMotionQa.repairs.length} automatic repair(s).`);
            } catch (persistError) {
                console.warn(`[HyperFrames Preview] Motion QA repairs are active in preview but could not be persisted: ${persistError.message}`);
            }
        } else if ((previewMotionQa?.repairs || []).length > 0) {
            const source = String(payload?.options?.previewSource || 'read-only refresh');
            console.log(`[HyperFrames Preview] Motion QA applied ${previewMotionQa.repairs.length} preview-only repair(s) for ${source}; the saved Agent transaction was left unchanged.`);
        }
        console.log(`[HyperFrames] Project generated: ${result.projectDir}`);
        return {
            ...result,
            previewUrl: _hyperframesPreviewUrl(result.indexPath),
            motionQa: previewMotionQa
                ? {
                    version: previewMotionQa.version || 1,
                    status: previewMotionQa.status,
                    checkedVisuals: previewMotionQa.checked || 0,
                    repairCount: (previewMotionQa.repairs || []).length,
                    findingCount: (previewMotionQa.findings || []).length,
                    repairs: previewMotionQa.repairs || [],
                }
                : null,
            revision: savedPlan?.revision || null,
            planHash: savedPlan?.planHash || null,
        };
    } catch (err) {
        console.error('[HyperFrames] Project generation failed:', err.message);
        return { success: false, error: err.message };
    }
});

// Clip a plan down to [startSec, endSec] for a FAST partial HyperFrames render (In/Out
// points). Shifts all timings to start at 0, drops out-of-range items, keeps a transition
// only if both its scenes survive, and trims the narration audio so the section stays in
// sync. Returns a NEW plan object; never mutates the original. Used only when In/Out is set.
async function _clipPlanForRangeLegacy(plan, startSec, endSec) {
    const dur = Math.max(0.1, endSec - startSec);
    const overlaps = (s, e) => Number(e) > startSec + 0.001 && Number(s) < endSec - 0.001;
    const shift = (item) => {
        const s = Number(item.startTime ?? item.start ?? 0);
        const eRaw = item.endTime ?? item.end ?? (item.duration != null ? s + Number(item.duration) : s);
        const e = Number(eRaw);
        const ns = Math.max(0, Math.min(dur, s - startSec));
        const ne = Math.max(ns, Math.min(dur, e - startSec));
        const out = { ...item, startTime: ns, endTime: ne };
        if (item.duration != null) out.duration = Number((ne - ns).toFixed(3)); // bridge derives from start/end anyway
        delete out._hfTiming; // force the bridge to recompute timing
        return out;
    };
    const clipped = { ...plan };
    const keptIdx = new Set();
    if (Array.isArray(plan.scenes)) {
        clipped.scenes = plan.scenes
            .filter(sc => {
                const keep = overlaps(Number(sc.startTime ?? 0), Number(sc.endTime ?? sc.startTime ?? 0));
                if (keep && sc.index != null) keptIdx.add(Number(sc.index));
                return keep;
            })
            .map(shift);
    }
    if (Array.isArray(plan.mgScenes)) {
        clipped.mgScenes = plan.mgScenes
            .filter(sc => overlaps(Number(sc.startTime ?? 0), Number(sc.endTime ?? sc.startTime ?? 0)))
            .map(shift);
    }
    if (Array.isArray(plan.motionGraphics)) {
        clipped.motionGraphics = plan.motionGraphics
            .filter(mg => overlaps(Number(mg.startTime ?? 0), Number(mg.startTime ?? 0) + Number(mg.duration ?? 0)))
            .map(shift);
    }
    // templateScenes (stat cards, key-takeaways, listicle grids, etc.) are a SEPARATE timed
    // array the renderer places by startTime. Without clipping+re-basing them here, a section
    // render leaves them at their ABSOLUTE time → they appear shifted late (out of audio sync)
    // while the full preview is correct. Mirror the mgScenes handling.
    if (Array.isArray(plan.templateScenes)) {
        clipped.templateScenes = plan.templateScenes
            .filter(sc => overlaps(Number(sc.startTime ?? 0), Number(sc.endTime ?? sc.startTime ?? 0)))
            .map(shift);
    }
    if (Array.isArray(plan.sfxClips)) {
        clipped.sfxClips = plan.sfxClips
            .filter(sx => overlaps(Number(sx.startTime ?? 0), Number(sx.startTime ?? 0) + Number(sx.duration ?? 0.5)))
            .map(shift);
    }
    if (Array.isArray(plan.transitions)) {
        clipped.transitions = plan.transitions.filter(t => keptIdx.has(Number(t.fromSceneIndex)) && keptIdx.has(Number(t.toSceneIndex)));
    }
    clipped.totalDuration = dur;

    // Trim the narration audio to the range so it matches the shifted visuals.
    if (plan.audio) {
        const resolved = [PUBLIC_PATH, TEMP_PATH, INPUT_PATH].map(d => path.join(d, plan.audio)).find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
        if (resolved) {
            const outName = `hf-clip-voiceover-${Date.now()}.mp3`;
            const outPath = path.join(TEMP_PATH, outName);
            try {
                await new Promise((resolve, reject) => {
                    const { execFile } = require('child_process');
                    execFile(WEBGL_FFMPEG_PATH, ['-y', '-ss', String(startSec), '-to', String(endSec), '-i', resolved, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', outPath], (err) => err ? reject(err) : resolve());
                });
                clipped.audio = outName; // bridge resolves it from TEMP_PATH
            } catch (e) {
                console.warn(`[HyperFrames] audio trim failed (${e.message}); section may be out of sync`);
            }
        }
    }
    return clipped;
}

async function _clipPlanForRange(plan, startSec, endSec) {
    const { clipPlanForRange } = require('./src/project/plan-range');
    const clipped = clipPlanForRange(plan, startSec, endSec);

    if (!plan.audio) return clipped;
    const resolved = [PUBLIC_PATH, TEMP_PATH, INPUT_PATH]
        .map((directory) => path.join(directory, plan.audio))
        .find((candidate) => {
            try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch (_) { return false; }
        });
    if (!resolved) {
        throw new Error(`Partial render audio was not found: ${plan.audio}`);
    }

    const duration = endSec - startSec;
    const outName = `hf-clip-voiceover-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`;
    const outPath = path.join(TEMP_PATH, outName);
    await new Promise((resolve, reject) => {
        execFile(WEBGL_FFMPEG_PATH, [
            '-y',
            '-ss', String(startSec),
            '-t', String(duration),
            '-i', resolved,
            '-vn',
            '-c:a', 'libmp3lame',
            '-q:a', '4',
            outPath,
        ], { windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    _assertNonEmptyFile(outPath, 'Partial render audio');
    clipped.audio = outName;
    return clipped;
}

ipcMain.handle('hyperframes-render', async (_event, payload = {}) => {
    try {
        activeRenderCancelled = false;
        purgePartialHyperframesBrowser();
        const { generateHyperframesProject } = loadHyperframesBridgeFresh();
        const nodeRuntime = checkHyperframesNodeRuntime();
        if (!nodeRuntime.ok) {
            const versionLabel = nodeRuntime.version || 'unknown';
            const message = `HyperFrames requires Node 22+ for the CLI renderer. Current node is ${versionLabel}. Install/switch to Node 22+, then retry the HyperFrames render.`;
            console.warn(`[HyperFrames] ${message}`);
            sendRenderProgress(0, `[HyperFrames] ${message}`);
            return { success: false, error: message, nodeRuntime };
        }
        console.log(`[HyperFrames] CLI Node runtime: ${nodeRuntime.path} (${nodeRuntime.version})`);
        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputFile = path.join(OUTPUT_PATH, `hyperframes-${stamp}.mp4`);

        // Partial render (In/Out points): clip the plan to the range so HyperFrames renders
        // ONLY that section (fast check) instead of the whole timeline.
        let renderPlan = payload.plan;
        const _opt = payload.options || {};
        const _start = Number(_opt.startSec || 0);
        const _end = Number.isFinite(Number(_opt.endSec)) ? Number(_opt.endSec) : null;
        const _fullDur = Number(payload.plan?.totalDuration || 0);
        const _isPartial = _end != null && _end > _start + 0.05 && ((_start > 0.05) || (_fullDur && _end < _fullDur - 0.05));
        if (_isPartial) {
            sendRenderProgress(6, `[HyperFrames] Partial render ${_start.toFixed(1)}s → ${_end.toFixed(1)}s (clipping to section)...`);
            try { renderPlan = await _clipPlanForRange(payload.plan, _start, _end); }
            catch (e) { throw new Error(`Partial render preparation failed: ${e.message}`); }
        }

        sendRenderProgress(8, '[HyperFrames] Preparing agentic Motion QA...');
        await runCompositionAuthorPass(renderPlan);
        const { runMotionQa } = require('./src/agents/workers/motion-qa-agent');
        const qaBrowserPath = findHyperframesBrowserPath();
        const motionQa = await runMotionQa({
            plan: renderPlan,
            appRoot: APP_ROOT,
            reportDir: PUBLIC_PATH,
            browserPath: qaBrowserPath,
            nodePath: nodeRuntime.path,
            quick: _isPartial,
            log: (message) => console.log(message),
            onProgress: sendRenderProgress,
            isCancelled: () => activeRenderCancelled === true,
            onProcess: (nextProcess, _label, finishedProcess) => {
                if (nextProcess) {
                    activeProcess = nextProcess;
                    activeProcessType = 'render';
                } else if (!finishedProcess || activeProcess === finishedProcess) {
                    activeProcess = null;
                    activeProcessType = null;
                }
            },
            generateProject: async () => generateHyperframesProject({
                plan: renderPlan,
                projectDir: PROJECT_DIR,
                appRoot: APP_ROOT,
                tempDir: TEMP_PATH,
                publicDir: PUBLIC_PATH,
                inputDir: INPUT_PATH,
                outputRoot: path.join(PROJECT_DIR, 'hyperframes'),
                options: {
                    ...(payload.options || {}),
                    onProgress: sendRenderProgress,
                },
            }),
        });
        const project = motionQa.project;
        if (!project?.projectDir) {
            throw new Error('Motion QA did not produce a HyperFrames project');
        }
        if (motionQa.hardFail) {
            const first = (motionQa.report?.findings || []).find((finding) => finding.severity === 'error');
            return {
                success: false,
                error: `Motion QA blocked a broken render${first?.message ? `: ${first.message}` : ''}`,
                projectDir: project.projectDir,
                motionQa: motionQa.report,
            };
        }
        if (motionQa.changed && !_isPartial) {
            try {
                const savedMotionPlan = _persistUnifiedVideoPlan(renderPlan);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('qa-plan-updated', {
                        videoPlan: renderPlan,
                        revision: savedMotionPlan.revision,
                        planHash: savedMotionPlan.planHash,
                    });
                }
                console.log(`[Motion QA] Persisted ${motionQa.report?.repairCount || 0} automatic repair(s) to the project.`);
            } catch (persistError) {
                console.warn(`[Motion QA] Repaired render will continue, but project persistence failed: ${persistError.message}`);
            }
        }

        console.log(`[HyperFrames] Motion-QA project ready: ${project.projectDir}`);
        sendRenderProgress(17, `[Motion QA] ${String(motionQa.report?.status || 'pass').toUpperCase()} — starting renderer...`);

        // Pre-render slideshow/monotony advisory (OPENMONTAGE-BORROW-PLAN #10).
        // Log-only — surfaces monotony before we spend a full render; never blocks.
        try {
            const { scoreSlideshowRisk } = require('./src/agents/scene-risk');
            const sr = scoreSlideshowRisk(renderPlan);
            if (sr.level !== 'ok') {
                console.warn(`[SlideshowRisk] ${sr.level.toUpperCase()} (score ${sr.score}) — ${sr.findings.length} finding(s):`);
                for (const f of sr.findings) console.warn(`[SlideshowRisk]   ${f.severity === 'fail' ? '❌' : '⚠️'} ${f.message}`);
            }
        } catch (_) { /* advisory only */ }

        // Motion QA already ran HyperFrames lint/check/keyframes. Keep the
        // legacy advisory lint only when Motion QA was explicitly disabled.
        if (motionQa.report?.status === 'skipped') {
            try { runHyperframesLint(project.projectDir); } catch (_) { /* advisory only */ }
        }

        const renderOptions = {
            fps: payload.fps || payload.plan?.fps || 30,
            quality: payload.quality || 'standard',
            gpu: payload.gpu !== false,
            workers: payload.workers || 4,
            browserGpu: payload.browserGpu !== false,
            strict: payload.strict === true,
            nodePath: nodeRuntime.path,
        };
        let rendered = await runHyperframesCli(project.projectDir, outputFile, renderOptions);

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        // A capture stall means setup outran its budget, not that the browser or
        // the GPU is unusable -- so step parallelism down one rung and KEEP the
        // GPU rather than collapsing straight to 1-worker software, which is the
        // slowest path we have and used to be where every heavy render ended up.
        if (!rendered.success && rendered.stalled && Number(renderOptions.workers) > 2) {
            console.warn('[HyperFrames] Capture stalled during setup. Retrying with less parallelism (2 workers, browser GPU).');
            sendRenderProgress(22, '[HyperFrames] Capture stalled, retrying with 2 workers...');
            rendered = await runHyperframesCli(project.projectDir, outputFile, {
                ...renderOptions,
                workers: 2,
            });
        }

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        if (!rendered.success && (renderOptions.browserGpu || Number(renderOptions.workers) > 1)) {
            console.warn('[HyperFrames] Fast browser render failed. Retrying stable mode (1 worker, browser software).');
            sendRenderProgress(22, '[HyperFrames] Fast render failed, retrying stable mode...');
            rendered = await runHyperframesCli(project.projectDir, outputFile, {
                ...renderOptions,
                workers: 1,
                browserGpu: false,
            });
        }

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        if (!rendered.success && renderOptions.gpu) {
            console.warn('[HyperFrames] GPU render failed. Retrying without GPU encoding.');
            sendRenderProgress(22, '[HyperFrames] GPU render failed, retrying CPU encode...');
            rendered = await runHyperframesCli(project.projectDir, outputFile, {
                ...renderOptions,
                gpu: false,
                workers: 1,
                browserGpu: false,
            });
        }

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        if (!rendered.success) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        // ── Audio finishing (OPENMONTAGE-BORROW-PLAN #1) ──
        // The CLI muxed voice+sfx crudely (no ducking, no loudnorm, no bed).
        // Post-process the finished mp4: normalize to −16 LUFS and, if a music
        // bed is present, duck it under the narration. Non-destructive: video
        // stream is copied and the original is only replaced on success.
        // Skipped for partial (In/Out) renders — those are quick section checks.
        if (!_isPartial) {
            try {
                sendRenderProgress(99, '[HyperFrames] Finishing audio (loudness + mix)...');
                const { finishAudio } = require('./src/render/audio-mixer');
                let bedPath = null;
                const bedCandidate = renderPlan?.musicBed || process.env.MUSIC_BED_PATH || '';
                if (bedCandidate) {
                    bedPath = [PUBLIC_PATH, TEMP_PATH, INPUT_PATH, '']
                        .map((d) => (d ? path.join(d, bedCandidate) : bedCandidate))
                        .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
                }
                finishAudio({
                    videoPath: rendered.outputPath,
                    bedPath,
                    bedGain: renderPlan?.musicBedGain,
                    log: (m) => console.log(m),
                });
            } catch (e) {
                console.warn(`[HyperFrames] audio finishing skipped (${e.message}) — original render kept`);
            }
        }

        // ── Post-render final review (OPENMONTAGE-BORROW-PLAN #7 + #8 + #9) ──
        // Probe the ACTUAL output (duration/black/audio) + plan (motion-ratio,
        // pacing). Advisory: we never fail a render that produced a file, but we
        // surface the verdict to the UI and logs. FINAL_REVIEW=0 disables.
        let review = null;
        if (!_isPartial) {
            try {
                sendRenderProgress(99, '[HyperFrames] Reviewing final render...');
                const { finalReview } = require('./src/pipeline/final-review');
                review = await finalReview({
                    videoPath: rendered.outputPath,
                    plan: renderPlan,
                    publicDir: PUBLIC_PATH,
                    log: (m) => console.log(m),
                });
            } catch (e) {
                console.warn(`[HyperFrames] final review skipped (${e.message})`);
            }
        }

        // Studio: a whole-timeline render is the deliverable and goes to the
        // video's final/ folder; a partial one is a working copy for renders/.
        try {
            require('./src/project/studio-link').recordRender({
                projectDir: PROJECT_DIR,
                outputPath: rendered.outputPath,
                partial: _isPartial,
            });
        } catch (e) { console.warn('[Studio] record skipped:', e.message); }

        sendRenderProgress(100, '[HyperFrames] Render complete');
        activeRenderCancelled = false;
        return {
            success: true,
            outputPath: rendered.outputPath,
            projectDir: project.projectDir,
            indexPath: project.indexPath,
            review,
            motionQa: motionQa.report,
        };
    } catch (err) {
        activeProcess = null;
        activeProcessType = null;
        activeRenderCancelled = false;
        console.error('[HyperFrames] Render failed:', err.message);
        return { success: false, error: err.message };
    }
});

/**
 * Mux the WebGL-rendered video with the project's audio track + SFX clips.
 * Returns the final output file path.
 */
async function _webglMuxAudio(exp) {
    const planPath = path.join(PUBLIC_PATH, 'video-plan.json');
    let audioFile = null;
    let sfxClips = [];

    if (fs.existsSync(planPath)) {
        try {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
            if (plan.audio) {
                for (const dir of [PUBLIC_PATH, TEMP_PATH, INPUT_PATH]) {
                    const candidate = path.join(dir, plan.audio);
                    if (_isAllowedProjectMediaFile(candidate)) {
                        audioFile = fs.realpathSync.native(candidate);
                        break;
                    }
                }
            }
            // Read SFX clips from plan
            if (Array.isArray(plan.sfxClips) && plan.sfxClips.length > 0) {
                const sfxDir = path.join(__dirname, 'assets', 'sfx');
                for (const clip of plan.sfxClips) {
                    const sfxPath = path.resolve(sfxDir, String(clip.file || ''));
                    let realSfxPath = null;
                    try {
                        const realSfxRoot = fs.realpathSync.native(sfxDir);
                        const candidate = fs.realpathSync.native(sfxPath);
                        if (_isPathWithin(realSfxRoot, candidate) && fs.statSync(candidate).isFile()) {
                            realSfxPath = candidate;
                        }
                    } catch (_) { }
                    if (realSfxPath) {
                        const rawVolume = clip.volume !== undefined ? Number(clip.volume) : 0.35;
                        sfxClips.push({
                            path: realSfxPath,
                            startTime: Math.max(0, Number(clip.startTime) || 0),
                            duration: Math.max(0.01, Number(clip.duration) || 0.5),
                            volume: Number.isFinite(rawVolume) ? Math.max(0, Math.min(2, rawVolume)) : 0.35,
                            inputOffset: 0,
                        });
                    }
                }
            }
        } catch (_) { }
    }

    // If rendering a sub-range (in/out points), filter SFX to that range and adjust timing
    const trimStart = exp.audioTrimStartSec || 0;
    const trimEnd = exp.audioTrimEndSec || Infinity;
    if (trimStart > 0 || trimEnd < Infinity) {
        const before = sfxClips.length;
        sfxClips = sfxClips.filter(sfx => {
            const sfxEnd = sfx.startTime + sfx.duration;
            return sfxEnd > trimStart && sfx.startTime < trimEnd;
        });
        sfxClips = sfxClips.map((sfx) => {
            const originalStart = sfx.startTime;
            const originalEnd = originalStart + sfx.duration;
            const audibleStart = Math.max(originalStart, trimStart);
            const audibleEnd = Math.min(originalEnd, trimEnd);
            return {
                ...sfx,
                inputOffset: Math.max(0, audibleStart - originalStart),
                startTime: Math.max(0, originalStart - trimStart),
                duration: Math.max(0.01, audibleEnd - audibleStart),
            };
        });
        if (before !== sfxClips.length) {
            console.log(`[WebGL Export] SFX trimmed: ${before} → ${sfxClips.length} clips (range ${trimStart.toFixed(1)}s-${trimEnd === Infinity ? 'end' : trimEnd.toFixed(1) + 's'})`);
        }
    }

    const hasSfx = sfxClips.length > 0;

    if (!audioFile && !hasSfx) {
        if (exp.status === 'cancelled') throw new Error('Export cancelled');
        // No audio at all — just copy video
        fs.copyFileSync(exp.videoFile, exp.outputFile);
        _assertNonEmptyFile(exp.outputFile, 'Final WebGL output');
        try { fs.unlinkSync(exp.videoFile); } catch (_) { }
        console.log('[WebGL Export] No audio to mux, video only:', exp.outputFile);
        return exp.outputFile;
    }

    console.log(`[WebGL Export] Muxing audio: VO=${audioFile ? 'yes' : 'no'}, SFX=${sfxClips.length} clips`);

    // Build FFmpeg args with filter_complex for mixing VO + SFX
    const inputArgs = ['-y', '-i', exp.videoFile]; // input 0 = video
    let audioInputIndex = 1;

    // Add VO audio input
    let voIndex = -1;
    if (audioFile) {
        if (exp.audioTrimStartSec != null && exp.audioTrimStartSec > 0) {
            inputArgs.push('-ss', String(exp.audioTrimStartSec));
        }
        inputArgs.push('-t', String(exp.totalFrames / exp.fps));
        inputArgs.push('-i', audioFile);
        voIndex = audioInputIndex++;
    }

    // Add each SFX clip as a separate input with offset
    const sfxIndices = [];
    for (const sfx of sfxClips) {
        if (sfx.inputOffset > 0) inputArgs.push('-ss', String(sfx.inputOffset));
        inputArgs.push('-t', String(sfx.duration));
        inputArgs.push('-i', sfx.path);
        sfxIndices.push(audioInputIndex++);
    }

    let outputArgs;

    if (!hasSfx) {
        // Simple case: just VO, no filter needed
        outputArgs = [
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            exp.outputFile
        ];
    } else {
        // Build filter_complex to mix all audio streams
        const filterParts = [];
        const mixInputs = [];
        let streamIdx = 0;

        // VO stream (or silent placeholder if no VO)
        if (voIndex >= 0) {
            filterParts.push(`[${voIndex}:a]aformat=fltp:44100:stereo,volume=1.0[vo]`);
            mixInputs.push('[vo]');
            streamIdx++;
        }

        // SFX streams — each delayed to its startTime and volume-adjusted
        for (let i = 0; i < sfxClips.length; i++) {
            const sfx = sfxClips[i];
            const idx = sfxIndices[i];
            const label = `sfx${i}`;
            const delayMs = Math.round(sfx.startTime * 1000);
            const vol = sfx.volume.toFixed(2);
            filterParts.push(
                `[${idx}:a]aformat=fltp:44100:stereo,volume=${vol},adelay=${delayMs}|${delayMs}[${label}]`
            );
            mixInputs.push(`[${label}]`);
            streamIdx++;
        }

        // Mix all streams together
        // normalize=0 prevents amix from dividing volume by input count
        // (with 200+ SFX clips, the default normalize=1 makes everything silent)
        const mixCount = mixInputs.length;
        filterParts.push(
            `${mixInputs.join('')}amix=inputs=${mixCount}:duration=longest:dropout_transition=0:normalize=0[aout]`
        );

        const filterComplex = filterParts.join(';');

        outputArgs = [
            '-filter_complex', filterComplex,
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            exp.outputFile
        ];
    }

    return new Promise((resolve, reject) => {
        const muxProc = spawn(WEBGL_FFMPEG_PATH, [
            ...inputArgs,
            ...outputArgs
        ], {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });
        exp.muxProc = muxProc;

        let stderr = '';
        let settled = false;
        const finish = (error, outputPath) => {
            if (settled) return;
            settled = true;
            if (exp.muxProc === muxProc) exp.muxProc = null;
            if (error) reject(error);
            else resolve(outputPath);
        };
        muxProc.stderr.on('data', (d) => {
            stderr = (stderr + d.toString()).slice(-64 * 1024);
        });

        muxProc.on('close', (code) => {
            if (exp.status === 'cancelled') {
                finish(new Error('Export cancelled'));
                return;
            }
            if (code === 0) {
                try {
                    _assertNonEmptyFile(exp.outputFile, 'Final WebGL output');
                    console.log('[WebGL Export] Final output:', exp.outputFile);
                    // Clean up temp video after successful mux
                    try { fs.unlinkSync(exp.videoFile); } catch (_) { }
                    finish(null, exp.outputFile);
                } catch (error) {
                    finish(error);
                }
            } else {
                console.error('[WebGL Export] Mux failed:', stderr.slice(-500));
                // Fallback: use video-only file (rename, don't delete first)
                try { fs.renameSync(exp.videoFile, exp.outputFile); } catch (_) {
                    try { fs.copyFileSync(exp.videoFile, exp.outputFile); } catch (_2) { }
                }
                try {
                    _assertNonEmptyFile(exp.outputFile, 'Video-only WebGL fallback');
                    finish(null, exp.outputFile);
                } catch (error) {
                    finish(error);
                }
            }
        });

        muxProc.on('error', (err) => {
            if (exp.status === 'cancelled') {
                finish(new Error('Export cancelled'));
                return;
            }
            console.error('[WebGL Export] Mux process error:', err.message);
            try { fs.renameSync(exp.videoFile, exp.outputFile); } catch (_) {
                try { fs.copyFileSync(exp.videoFile, exp.outputFile); } catch (_2) { }
            }
            try {
                _assertNonEmptyFile(exp.outputFile, 'Video-only WebGL fallback');
                finish(null, exp.outputFile);
            } catch (fallbackError) {
                finish(fallbackError);
            }
        });
    });
}


// Open output folder
ipcMain.handle('open-output-folder', async () => {
    shell.openPath(OUTPUT_PATH);
});

// Open current project's logs folder
ipcMain.handle('open-project-logs', async () => {
    const logsDir = ensureLogsDir(PROJECT_DIR);
    await shell.openPath(logsDir);
    return { success: true, logsDir };
});

// Tail latest project log in a live PowerShell window
ipcMain.handle('tail-project-logs', async () => {
    return tailProjectLogsLive(PROJECT_DIR);
});

// Get current log file path (for troubleshooting UI)
ipcMain.handle('get-current-log-file', async () => {
    return {
        projectDir: PROJECT_DIR,
        logsDir: getLogsDir(PROJECT_DIR),
        logFile: CURRENT_LOG_FILE,
    };
});

// Open file in default app
ipcMain.handle('open-file', async (event, filePath) => {
    const allowed = _resolveRendererReadableFile(event, filePath);
    if (!allowed) return { success: false, error: 'File is outside the active project' };
    const error = await shell.openPath(allowed);
    return error ? { success: false, error } : { success: true };
});

// Select folder dialog
ipcMain.handle('select-folder', async (event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select folder',
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return _grantSelectedDirectory(event, result.filePaths[0]);
    }
    return null;
});

// Startup chooser actions (custom in-app startup window)
ipcMain.handle('startup-create-project', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Choose an empty folder for the new project',
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const prepared = _prepareNewProjectTarget({
        location: result.filePaths[0],
        projectName: path.basename(result.filePaths[0]),
        locationMode: 'selected-folder',
    });
    if (!prepared.success) return prepared;
    resolveStartupChoice(prepared.projectDir);
    return prepared;
});

ipcMain.handle('startup-open-project-folder', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const inspected = _validateExistingProjectTarget(result.filePaths[0]);
    if (!inspected.success) return inspected;
    resolveStartupChoice(inspected.projectDir);
    return inspected;
});

ipcMain.handle('startup-open-project-file', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Open .fvp project file',
        properties: ['openFile'],
        filters: [{ name: 'Project Files', extensions: ['fvp'] }]
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const fvpPath = result.filePaths[0];
    const inspected = _validateExistingProjectTarget(path.dirname(fvpPath), fvpPath);
    if (!inspected.success) return inspected;
    resolveStartupChoice(inspected.projectDir);
    return inspected;
});

ipcMain.handle('startup-cancel', async () => {
    resolveStartupChoice(null);
    return { success: true, cancelled: true };
});

// Select file dialog
ipcMain.handle('select-file', async (event, options) => {
    const requestedFilters = Array.isArray(options?.filters) ? options.filters.slice(0, 8) : null;
    const filters = requestedFilters?.map((filter) => ({
        name: String(filter?.name || 'Files').slice(0, 80),
        extensions: Array.isArray(filter?.extensions)
            ? filter.extensions
                .slice(0, 20)
                .map((extension) => String(extension).replace(/[^a-z0-9]/gi, '').toLowerCase())
                .filter(Boolean)
            : [],
    })).filter((filter) => filter.extensions.length) || [
        { name: 'Audio Files', extensions: ['mp3', 'wav'] },
    ];
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: typeof options?.title === 'string' ? options.title.slice(0, 120) : undefined,
        filters,
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return _grantSelectedFile(event, result.filePaths[0]);
    }
    return null;
});

// Get file URL for video playback
ipcMain.handle('get-file-url', async (event, filePath) => {
    let candidate = String(filePath || '').trim();
    if (!candidate || candidate.length > 32_768) return null;
    if (/^file:/i.test(candidate)) {
        try {
            candidate = fileURLToPath(candidate);
        } catch (_) {
            return null;
        }
    }
    const allowed = _resolveExistingFileWithin(_projectReadableRoots(), candidate);
    return allowed ? _assetUrlForFile(allowed) : null;
});

// Show OS notification
ipcMain.handle('show-notification', async (event, title, body) => {
    if (Notification.isSupported()) {
        const n = new Notification({
            title: String(title || '').slice(0, 160),
            body: String(body || '').slice(0, 1000),
            silent: false,
        });
        n.show();
    }
});

// Get SFX file path for preview playback
ipcMain.handle('get-sfx-path', async (event, filename) => {
    const safeFilename = path.basename(String(filename || ''));
    if (safeFilename !== String(filename || '') || !/\.(mp3|wav|ogg|m4a)$/i.test(safeFilename)) return null;
    const sfxPath = _resolveExistingFileWithin([path.join(APP_ROOT, 'assets', 'sfx')], path.join(APP_ROOT, 'assets', 'sfx', safeFilename));
    if (sfxPath) return _assetUrlForFile(sfxPath);
    // Fallback: check project's public folder
    const pubPath = _resolveExistingFileWithin([PUBLIC_PATH], path.join(PUBLIC_PATH, safeFilename));
    if (pubPath) return _assetUrlForFile(pubPath);
    return null;
});

// Scan assets/overlays/ folder for available overlay files
ipcMain.handle('scan-overlays', async () => {
    const overlaysDir = path.join(__dirname, 'assets', 'overlays');
    if (!fs.existsSync(overlaysDir)) return [];

    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);
    const files = fs.readdirSync(overlaysDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.has(ext) && !f.startsWith('.');
    });

    return files.map(f => {
        const ext = path.extname(f).toLowerCase();
        const name = path.basename(f, path.extname(f));
        const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
        const fullPath = path.join(overlaysDir, f);
        const stat = fs.statSync(fullPath);
        return {
            filename: f,
            name: name,
            ext: ext,
            mediaType: isVideo ? 'video' : 'image',
            size: stat.size,
            path: fullPath,
        };
    });
});

// Get overlay file URL for preview playback
ipcMain.handle('get-overlay-url', async (event, filename) => {
    const safeFilename = path.basename(String(filename || ''));
    if (safeFilename !== String(filename || '') || !/\.(mp4|webm|mov|jpg|jpeg|png|webp)$/i.test(safeFilename)) return null;
    const overlayPath = _resolveExistingFileWithin(
        [path.join(APP_ROOT, 'assets', 'overlays')],
        path.join(APP_ROOT, 'assets', 'overlays', safeFilename)
    );
    return overlayPath ? _assetUrlForFile(overlayPath) : null;
});

// Scan assets/backgrounds/ folder for available background pattern files
ipcMain.handle('scan-backgrounds', async () => {
    const bgDir = path.join(__dirname, 'assets', 'backgrounds');
    if (!fs.existsSync(bgDir)) {
        fs.mkdirSync(bgDir, { recursive: true });
        return [];
    }

    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);
    const files = fs.readdirSync(bgDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.has(ext) && !f.startsWith('.');
    });

    // Theme tagging convention: "{theme}--{name}.ext"
    // e.g. "history--vintage-paper.jpg" → theme: 'history', name: 'vintage-paper'
    // Files without a theme prefix are available for all themes
    const VALID_THEMES = new Set(['crime', 'history', 'modern', 'minimal', 'standard']);

    return files.map(f => {
        const ext = path.extname(f).toLowerCase();
        let name = path.basename(f, path.extname(f));
        const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
        const fullPath = path.join(bgDir, f);
        const stat = fs.statSync(fullPath);

        // Parse theme prefix: "history--vintage-paper" → theme='history', name='vintage-paper'
        let theme = null;
        const dashIdx = name.indexOf('--');
        if (dashIdx > 0) {
            const prefix = name.substring(0, dashIdx).toLowerCase();
            if (VALID_THEMES.has(prefix)) {
                theme = prefix;
                name = name.substring(dashIdx + 2);
            }
        }

        return {
            filename: f,
            name: name,
            theme: theme,   // null = all themes, or specific theme ID
            ext: ext,
            mediaType: isVideo ? 'video' : 'image',
            size: stat.size,
            path: fullPath,
        };
    });
});

// Get background file URL for preview
ipcMain.handle('get-background-url', async (event, filename) => {
    const safeFilename = path.basename(String(filename || ''));
    if (safeFilename !== String(filename || '') || !/\.(mp4|webm|mov|jpg|jpeg|png|webp|gif)$/i.test(safeFilename)) return null;
    const bgPath = _resolveExistingFileWithin(
        [path.join(APP_ROOT, 'assets', 'backgrounds')],
        path.join(APP_ROOT, 'assets', 'backgrounds', safeFilename)
    );
    return bgPath ? _assetUrlForFile(bgPath) : null;
});

// ========================================
// Multi-Instance / Project Management
// ========================================

// Get info about the current project
ipcMain.handle('get-project-info', async () => {
    return {
        projectDir: PROJECT_DIR,
        projectName: PROJECT_NAME,
        projectFile: getProjectFilePath(),
        appRoot: APP_ROOT,
        isDefaultProject: PROJECT_DIR === DEFAULT_WORKSPACE_DIR
    };
});

// Qwen model pool status + reset (used by UI)
const _qwenExhaustedPath = path.join(USER_DATA_DIR, '.qwen-exhausted-models.json');
function _parseEnvListForUi(raw) {
    return String(raw || '')
        .split(/[,\n;]/)
        .map(v => v.trim())
        .filter(Boolean);
}

function _readEnvValueForUi(envPath, key) {
    try {
        if (!fs.existsSync(envPath)) return '';
        const content = fs.readFileSync(envPath, 'utf8');
        const re = new RegExp(`^${key}=([\\s\\S]*?)$`, 'm');
        const match = content.match(re);
        if (!match) return '';
        let value = String(match[1] || '').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        return value;
    } catch (_) {
        return '';
    }
}

function _envHasKeyForUi(envPath, key) {
    try {
        if (!fs.existsSync(envPath)) return false;
        const content = fs.readFileSync(envPath, 'utf8');
        return new RegExp(`^${key}=`, 'm').test(content);
    } catch (_) {
        return false;
    }
}

function _maskSecretForUi(secret) {
    const value = String(secret || '').trim();
    if (!value) return '';
    if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
    return `${value.slice(0, 4)}...${value.slice(-6)}`;
}

function _qwenVisionKeysForUi() {
    const envPath = USER_ENV_PATH;
    const sharedKeys = _parseEnvListForUi(_readEnvValueForUi(envPath, 'QWEN_VISION_API_KEY'));
    const hasImagePrimary = _envHasKeyForUi(envPath, 'QWEN_IMAGE_API_KEY');
    const hasImageLane = hasImagePrimary || _envHasKeyForUi(envPath, 'QWEN_VL_API_KEY');
    const hasOmniLane = _envHasKeyForUi(envPath, 'QWEN_OMNI_API_KEY');
    const imageRaw = _parseEnvListForUi(hasImageLane ? (hasImagePrimary ? _readEnvValueForUi(envPath, 'QWEN_IMAGE_API_KEY') : _readEnvValueForUi(envPath, 'QWEN_VL_API_KEY')) : '');
    const omniRaw = _parseEnvListForUi(hasOmniLane ? _readEnvValueForUi(envPath, 'QWEN_OMNI_API_KEY') : '');
    const mapKeys = (keys) => keys.map((key, index) => ({
        index,
        tail: key.slice(-6),
        masked: _maskSecretForUi(key),
        length: key.length,
    }));
    return {
        envPath,
        shared: { envKey: 'QWEN_VISION_API_KEY', explicit: sharedKeys.length > 0, keys: mapKeys(sharedKeys) },
        image: { envKey: 'QWEN_IMAGE_API_KEY', explicit: hasImageLane, fallback: hasImageLane ? '' : 'QWEN_VISION_API_KEY', keys: mapKeys(hasImageLane ? imageRaw : sharedKeys) },
        omni: { envKey: 'QWEN_OMNI_API_KEY', explicit: hasOmniLane, fallback: hasOmniLane ? '' : 'QWEN_VISION_API_KEY', keys: mapKeys(hasOmniLane ? omniRaw : sharedKeys) },
        keys: mapKeys(sharedKeys),
    };
}

function _resolveQwenLaneKeysForSave(envPath, lane) {
    const sharedKeys = _parseEnvListForUi(_readEnvValueForUi(envPath, 'QWEN_VISION_API_KEY'));
    if (lane === 'image') {
        const hasImagePrimary = _envHasKeyForUi(envPath, 'QWEN_IMAGE_API_KEY');
        const hasImageLane = hasImagePrimary || _envHasKeyForUi(envPath, 'QWEN_VL_API_KEY');
        const imageKeys = _parseEnvListForUi(hasImagePrimary ? _readEnvValueForUi(envPath, 'QWEN_IMAGE_API_KEY') : _readEnvValueForUi(envPath, 'QWEN_VL_API_KEY'));
        return hasImageLane ? imageKeys : sharedKeys;
    }
    if (lane === 'omni') {
        const hasOmniLane = _envHasKeyForUi(envPath, 'QWEN_OMNI_API_KEY');
        const omniKeys = _parseEnvListForUi(_readEnvValueForUi(envPath, 'QWEN_OMNI_API_KEY'));
        return hasOmniLane ? omniKeys : sharedKeys;
    }
    return sharedKeys;
}

function _applyQwenKeyEdit(baseKeys, edit = {}) {
    const rows = Array.isArray(edit.rows) ? edit.rows : [];
    const additions = _parseEnvListForUi(Array.isArray(edit.additions) ? edit.additions.join(',') : edit.additions);
    const next = [];
    for (let i = 0; i < baseKeys.length; i++) {
        const row = rows.find(r => Number(r.index) === i) || {};
        if (row.remove === true) continue;
        const replacement = String(row.replacement || '').trim();
        next.push(replacement || baseKeys[i]);
    }
    for (const key of additions) next.push(key);
    const deduped = [];
    const seen = new Set();
    for (const key of next.map(k => String(k || '').trim()).filter(Boolean)) {
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(key);
    }
    return deduped;
}

const RESOURCE_ENV_GROUPS = [
    {
        id: 'qwen',
        title: 'Alibaba Qwen Vision',
        description: 'Primary vision lanes: image/VL frame scoring and Omni multimodal clip analysis.',
        fields: [
            { key: 'QWEN_BASE_URL', label: 'DashScope base URL', kind: 'text', importance: 'recommended' },
            { key: 'QWEN_VISION_MODEL', label: 'Image/VL model pool', kind: 'text', importance: 'recommended' },
            { key: 'QWEN_VISION_API_KEY', label: 'Shared fallback key pool', kind: 'secret-list', importance: 'recommended', note: 'Used only when lane-specific keys are not configured.' },
            { key: 'QWEN_IMAGE_API_KEY', label: 'Image/VL key pool', kind: 'secret-list', importance: 'optional', note: 'Leave absent to use the shared fallback pool.' },
            { key: 'QWEN_OMNI_API_KEY', label: 'Omni key pool', kind: 'secret-list', importance: 'optional', note: 'Separate this lane when Omni burns quota faster than image/VL.' },
            { key: 'QWEN_OMNI_MODEL', label: 'Omni HTTP model pool', kind: 'text', importance: 'optional' },
            { key: 'QWEN_OMNI_REALTIME_MODEL', label: 'Omni realtime model pool', kind: 'text', importance: 'optional' },
            { key: 'QWEN_OMNI_HTTP_ENABLED', label: 'Omni HTTP enabled', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_OMNI_REALTIME_ENABLED', label: 'Omni realtime enabled', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_MODEL_SYNC', label: 'Auto-sync model registry', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_MODEL_SYNC_PROBE', label: 'Probe discovered models', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_MODEL_SYNC_INTERVAL_HOURS', label: 'Model sync interval hours', kind: 'number', importance: 'optional' },
            { key: 'QWEN_DYNAMIC_MODEL_POOLS', label: 'Use generated model pools', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_PREFLIGHT', label: 'Preflight keys on build', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_HEALTH_FRESH_MS', label: 'Health cache freshness', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'bedrock',
        title: 'AWS Bedrock',
        description: 'Text AI route plus Bedrock vision fallback. Replace these when you move to a fresh AWS credit account.',
        fields: [
            { key: 'AI_PROVIDER', label: 'Text provider', kind: 'text', importance: 'required' },
            { key: 'BEDROCK_REGION', label: 'Region', kind: 'text', importance: 'required' },
            { key: 'BEDROCK_ACCESS_KEY_ID', label: 'Access key ID', kind: 'secret', importance: 'required' },
            { key: 'BEDROCK_SECRET_ACCESS_KEY', label: 'Secret access key', kind: 'secret', importance: 'required' },
            { key: 'BEDROCK_DIRECTOR_MODEL', label: 'Director model', kind: 'text', importance: 'recommended' },
            { key: 'BEDROCK_PLANNER_MODEL', label: 'Planner model', kind: 'text', importance: 'recommended' },
            { key: 'BEDROCK_UTILITY_MODEL', label: 'Utility model', kind: 'text', importance: 'recommended' },
            { key: 'BEDROCK_FALLBACK_MODEL', label: 'Text fallback model', kind: 'text', importance: 'optional' },
            { key: 'BEDROCK_TASK_TYPES', label: 'Task type allowlist', kind: 'text', importance: 'optional', note: 'Empty means all Bedrock text task types are allowed.' },
            { key: 'BEDROCK_VISION_NOVA_MODEL', label: 'Vision fallback: Nova', kind: 'text', importance: 'optional' },
            { key: 'BEDROCK_VISION_QWEN_MODEL', label: 'Vision fallback: Qwen VL', kind: 'text', importance: 'optional' },
            { key: 'BEDROCK_VISION_CLAUDE_MODEL', label: 'Vision fallback: Claude', kind: 'text', importance: 'optional' },
        ],
    },
    {
        id: 'azure',
        title: 'Azure AI',
        description: 'Azure AI Foundry text brains. Azure Claude and Azure OpenAI-compatible deployments like Grok can replace the Bedrock Sonnet tier; Bedrock remains fallback.',
        fields: [
            { key: 'AZURE_API_KEY', label: 'API key', kind: 'secret', importance: 'required' },
            { key: 'AZURE_ANTHROPIC_BASE_URL', label: 'Claude base URL', kind: 'text', importance: 'optional' },
            { key: 'AZURE_CLAUDE_MODEL', label: 'Claude deployment/model', kind: 'text', importance: 'optional' },
            { key: 'AZURE_TASK_TYPES', label: 'Claude task allowlist', kind: 'text', importance: 'optional', note: 'Claude dropdown fills this with the Sonnet tier.' },
            { key: 'AZURE_OPENAI_ENDPOINT', label: 'OpenAI-compatible endpoint', kind: 'text', importance: 'optional' },
            { key: 'AZURE_OPENAI_MODEL', label: 'OpenAI-compatible deployment/model', kind: 'text', importance: 'optional' },
            { key: 'AZURE_OPENAI_TASK_TYPES', label: 'OpenAI-compatible task allowlist', kind: 'text', importance: 'optional', note: 'Grok dropdown fills this with the Sonnet tier.' },
            { key: 'AZURE_TIMEOUT_MS', label: 'Timeout ms', kind: 'text', importance: 'optional' },
            { key: 'AZURE_OPENAI_TIMEOUT_MS', label: 'OpenAI-compatible timeout ms', kind: 'text', importance: 'optional' },
        ],
    },
    {
        id: 'stock',
        title: 'Stock Footage',
        description: 'Free stock API providers. Storyblocks is suspended unless manually re-enabled later.',
        fields: [
            { key: 'PEXELS_API_KEY', label: 'Pexels API key', kind: 'secret', importance: 'recommended' },
            { key: 'PIXABAY_API_KEY', label: 'Pixabay API key', kind: 'secret', importance: 'recommended' },
            { key: 'STORYBLOCKS_SUBSCRIBED', label: 'Storyblocks subscribed mode', kind: 'toggle', importance: 'optional', note: 'Suspended in source policy until re-enabled.' },
            { key: 'STORYBLOCKS_EMAIL', label: 'Storyblocks email', kind: 'secret', importance: 'optional', note: 'Suspended in source policy until re-enabled.' },
            { key: 'STORYBLOCKS_PASSWORD', label: 'Storyblocks password', kind: 'secret', importance: 'optional', note: 'Suspended in source policy until re-enabled.' },
            { key: 'STORYBLOCKS_COOKIE_FILE', label: 'Cookie file', kind: 'path', importance: 'optional', defaultValue: '.storyblocks-cookies.json' },
            { key: 'STORYBLOCKS_PARALLEL_DOWNLOADS', label: 'Parallel downloads', kind: 'number', importance: 'optional' },
            { key: 'STORYBLOCKS_SEARCH_RESULTS', label: 'Search result limit', kind: 'number', importance: 'optional' },
            { key: 'STORYBLOCKS_RACE_CANDIDATE_TIMEOUT_MS', label: 'Race candidate timeout', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'youtube',
        title: 'YouTube and Reddit Video',
        description: 'yt-dlp, cookies, and social/video search inputs.',
        fields: [
            { key: 'YTDLP_PATH', label: 'yt-dlp executable', kind: 'path', importance: 'recommended' },
            { key: 'YTDLP_COOKIES_FILE', label: 'yt-dlp cookies file', kind: 'path', importance: 'recommended' },
            { key: 'YTDLP_COOKIES_FROM_BROWSER', label: 'Cookie browser fallback', kind: 'text', importance: 'optional' },
            { key: 'YTDLP_CHECK_TIMEOUT_MS', label: 'yt-dlp check timeout', kind: 'number', importance: 'optional' },
            { key: 'YTDLP_TIMEOUT_SCALE', label: 'yt-dlp timeout scale', kind: 'number', importance: 'optional' },
            { key: 'YOUTUBE_API_KEY', label: 'YouTube API key', kind: 'secret', importance: 'optional' },
            { key: 'REDDIT_SEARCH_VARIANTS', label: 'Reddit search variants', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'web-images',
        title: 'Web Images',
        description: 'Reference image search for exact brands, diagrams, product shots, screenshots, maps, and news visuals.',
        fields: [
            { key: 'BRAVE_API_KEY', label: 'Brave Search API key', kind: 'secret', importance: 'recommended' },
            { key: 'BRAVE_COUNTRY', label: 'Brave country', kind: 'text', importance: 'optional' },
            { key: 'BRAVE_SEARCH_LANG', label: 'Brave language', kind: 'text', importance: 'optional' },
            { key: 'BRAVE_SAFESEARCH', label: 'Brave safe search', kind: 'text', importance: 'optional' },
            { key: 'BRAVE_IMAGES_DISABLED', label: 'Disable Brave Images', kind: 'toggle', importance: 'optional' },
            { key: 'BING_IMAGES_DISABLED', label: 'Disable Bing Images', kind: 'toggle', importance: 'optional' },
            { key: 'BING_API_KEY', label: 'Bing API key (legacy)', kind: 'secret', importance: 'optional', note: 'Empty is OK if the current Bing image path is browser/free mode.' },
        ],
    },
    {
        id: 'research-maps-assets',
        title: 'Research, Maps, and Assets',
        description: 'External resources used by director research, map media, icons, and sound effects.',
        fields: [
            { key: 'TAVILY_API_KEY', label: 'Tavily web research', kind: 'secret', importance: 'recommended' },
            { key: 'RAPIDAPI_KEY', label: 'RapidAPI search backend', kind: 'secret', importance: 'optional' },
            { key: 'FREEPIK_API_KEY', label: 'Freepik icons/assets', kind: 'secret', importance: 'optional' },
            { key: 'FREESOUND_API_KEY', label: 'Freesound SFX', kind: 'secret', importance: 'optional' },
            { key: 'GEOAPIFY_API_KEY', label: 'Geoapify maps', kind: 'secret', importance: 'optional' },
            { key: 'MAPTILER_API_KEY', label: 'MapTiler maps', kind: 'secret', importance: 'optional' },
        ],
    },
    {
        id: 'media-performance',
        title: 'Media Agent and Performance',
        description: 'Quality/speed controls for media search, candidate armies, scene concurrency, and referee decisions.',
        fields: [
            { key: 'MEDIA_AGENT_ENABLED', label: 'Media agent enabled', kind: 'toggle', importance: 'optional' },
            { key: 'MEDIA_AGENT_AI', label: 'Media agent AI planning', kind: 'toggle', importance: 'optional' },
            { key: 'FOOTAGE_PARALLEL_RACE', label: 'Parallel race enabled', kind: 'toggle', importance: 'optional' },
            { key: 'FOOTAGE_RACE_CONCURRENCY', label: 'Footage soldiers per batch', kind: 'number', importance: 'optional' },
            { key: 'FOOTAGE_RACE_MAX_BATCHES', label: 'Default footage batches', kind: 'number', importance: 'optional' },
            { key: 'IMAGE_RACE_HARD_LOCK_MAX_BATCHES', label: 'Image batches for locked scenes', kind: 'number', importance: 'optional' },
            { key: 'MEDIA_SCENE_CONCURRENCY', label: 'Scenes in parallel', kind: 'number', importance: 'optional' },
            { key: 'FOOTAGE_AI_REFEREE', label: 'AI referee', kind: 'toggle', importance: 'optional' },
            { key: 'FOOTAGE_AI_REFEREE_TIMEOUT_MS', label: 'AI referee timeout', kind: 'number', importance: 'optional' },
            { key: 'CLIP_ANALYZER_ENABLED', label: 'Clip analyzer env default', kind: 'toggle', importance: 'optional' },
            { key: 'VISION_CACHE', label: 'Vision cache', kind: 'toggle', importance: 'optional' },
        ],
    },
    {
        id: 'build-pipeline',
        title: 'Build Pipeline',
        description: 'Global build switches that affect scene splitting, orchestration, rendering, and editor agent workers.',
        fields: [
            { key: 'USE_SMART_SPLITTER', label: 'Smart splitter', kind: 'toggle', importance: 'recommended' },
            { key: 'USE_SCENE_CLASSES', label: 'Scene classifier', kind: 'toggle', importance: 'optional' },
            { key: 'USE_CAMERA_PLAN_STOPS', label: 'Camera plan stops', kind: 'toggle', importance: 'optional' },
            { key: 'RENDER_GPU_MAX_CONCURRENCY', label: 'Renderer GPU concurrency', kind: 'number', importance: 'optional' },
            { key: 'EDITOR_AGENT', label: 'Editor agent', kind: 'toggle', importance: 'optional' },
            { key: 'EDITOR_AGENT_CONCURRENCY', label: 'Editor agent workers', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'legacy-watch',
        title: 'Legacy Watchlist',
        description: 'Old providers. If these appear in .env they are visible here so they do not hide in the system.',
        fields: [
            { key: 'NVIDIA_API_KEY', label: 'NVIDIA key', kind: 'secret', importance: 'optional', legacy: true },
            { key: 'NVIDIA_API_KEYS', label: 'NVIDIA key pool', kind: 'secret-list', importance: 'optional', legacy: true },
            { key: 'GEMINI_MODEL', label: 'Gemini model', kind: 'text', importance: 'optional', legacy: true },
            { key: 'GEMINI_THINKING', label: 'Gemini thinking', kind: 'toggle', importance: 'optional', legacy: true },
            { key: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Google credentials', kind: 'path', importance: 'optional', legacy: true },
        ],
    },
];

const CLOUD_ACCOUNT_DEFS = {
    bedrock: {
        id: 'bedrock',
        title: 'AWS Bedrock Accounts',
        envPrefix: 'BEDROCK',
        activeKey: 'BEDROCK_ACTIVE_ACCOUNT',
        note: 'The active slot is copied into the normal BEDROCK_* variables used by the real build.',
        fields: [
            { suffix: 'REGION', canonical: 'BEDROCK_REGION', label: 'Region', kind: 'text', required: true, defaultValue: 'us-east-1' },
            { suffix: 'ACCESS_KEY_ID', canonical: 'BEDROCK_ACCESS_KEY_ID', label: 'Access key ID', kind: 'secret', required: true },
            { suffix: 'SECRET_ACCESS_KEY', canonical: 'BEDROCK_SECRET_ACCESS_KEY', label: 'Secret access key', kind: 'secret', required: true },
            { suffix: 'DIRECTOR_MODEL', canonical: 'BEDROCK_DIRECTOR_MODEL', label: 'Director model', kind: 'text' },
            { suffix: 'PLANNER_MODEL', canonical: 'BEDROCK_PLANNER_MODEL', label: 'Planner / VP model', kind: 'text' },
            { suffix: 'UTILITY_MODEL', canonical: 'BEDROCK_UTILITY_MODEL', label: 'Utility model', kind: 'text' },
            { suffix: 'FALLBACK_MODEL', canonical: 'BEDROCK_FALLBACK_MODEL', label: 'Text fallback model', kind: 'text' },
            { suffix: 'TASK_TYPES', canonical: 'BEDROCK_TASK_TYPES', label: 'Allowed task types', kind: 'text' },
            { suffix: 'VISION_NOVA_MODEL', canonical: 'BEDROCK_VISION_NOVA_MODEL', label: 'Vision fallback: Nova', kind: 'text' },
            { suffix: 'VISION_QWEN_MODEL', canonical: 'BEDROCK_VISION_QWEN_MODEL', label: 'Vision fallback: Qwen VL', kind: 'text' },
            { suffix: 'VISION_CLAUDE_MODEL', canonical: 'BEDROCK_VISION_CLAUDE_MODEL', label: 'Vision fallback: Claude', kind: 'text' },
        ],
    },
    azure: {
        id: 'azure',
        title: 'Azure AI Accounts',
        envPrefix: 'AZURE',
        activeKey: 'AZURE_ACTIVE_ACCOUNT',
        note: 'The active slot is copied into Azure Claude and Azure OpenAI variables used by the Sonnet-tier router.',
        fields: [
            { suffix: 'ANTHROPIC_BASE_URL', canonical: 'AZURE_ANTHROPIC_BASE_URL', label: 'Claude base URL', kind: 'text' },
            { suffix: 'API_KEY', canonical: 'AZURE_API_KEY', label: 'API key', kind: 'secret', required: true },
            { suffix: 'CLAUDE_MODEL', canonical: 'AZURE_CLAUDE_MODEL', label: 'Claude deployment/model', kind: 'text', defaultValue: 'claude-sonnet-4-6' },
            { suffix: 'TASK_TYPES', canonical: 'AZURE_TASK_TYPES', label: 'Allowed task types', kind: 'text' },
            { suffix: 'OPENAI_ENDPOINT', canonical: 'AZURE_OPENAI_ENDPOINT', label: 'OpenAI-compatible endpoint', kind: 'text' },
            { suffix: 'OPENAI_MODEL', canonical: 'AZURE_OPENAI_MODEL', label: 'OpenAI-compatible deployment/model', kind: 'text', defaultValue: 'grok-4.3' },
            { suffix: 'OPENAI_TASK_TYPES', canonical: 'AZURE_OPENAI_TASK_TYPES', label: 'OpenAI-compatible task types', kind: 'text' },
            { suffix: 'TIMEOUT_MS', canonical: 'AZURE_TIMEOUT_MS', label: 'Timeout ms', kind: 'text' },
            { suffix: 'OPENAI_TIMEOUT_MS', canonical: 'AZURE_OPENAI_TIMEOUT_MS', label: 'OpenAI-compatible timeout ms', kind: 'text' },
        ],
    },
};

function _resourceEnvPath() {
    return USER_ENV_PATH;
}

function _backupEnvFile(envPath, reason = 'resource-edit') {
    if (!fs.existsSync(envPath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(path.dirname(envPath), `.env.backup-${reason}-${stamp}`);
    fs.copyFileSync(envPath, backupPath);
    return backupPath;
}

function _parseEnvContent(content) {
    const lines = String(content || '').split(/\r?\n/);
    const entries = [];
    const byKey = new Map();
    const duplicates = [];
    const keyCounts = new Map();
    lines.forEach((raw, index) => {
        const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!match) return;
        const key = match[1].trim();
        const value = String(match[2] || '').trim();
        const entry = { key, value, line: index + 1, raw };
        entries.push(entry);
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
        if (byKey.has(key)) {
            duplicates.push({ key, firstLine: byKey.get(key).line, line: index + 1 });
            return;
        }
        byKey.set(key, entry);
    });
    return { lines, entries, byKey, duplicates, keyCounts };
}

function _readParsedEnvForResources() {
    const envPath = _resourceEnvPath();
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    return { envPath, content, ..._parseEnvContent(content) };
}

function _unquoteEnvValue(value) {
    let next = String(value || '').trim();
    if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
        next = next.slice(1, -1);
    }
    return next;
}

function _isTruthyEnvValue(value) {
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function _resourcePathExists(rawValue) {
    const value = _unquoteEnvValue(rawValue);
    if (!value) return false;
    const candidates = [
        value,
        path.resolve(APP_ROOT, value),
        path.resolve(PROJECT_DIR, value),
    ];
    return candidates.some(candidate => {
        try { return fs.existsSync(candidate); } catch (_) { return false; }
    });
}

function _fieldIsSecret(field) {
    return field.kind === 'secret' || field.kind === 'secret-list' || /(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(field.key);
}

function _maskListForResource(raw) {
    const keys = _parseEnvListForUi(_unquoteEnvValue(raw));
    return {
        count: keys.length,
        masked: keys.map(key => _maskSecretForUi(key)),
        tails: keys.map(key => key.slice(-6)),
    };
}

function _resourceFieldStatus(field, parsed) {
    const entry = parsed.byKey.get(field.key);
    const exists = !!entry;
    const raw = exists ? _unquoteEnvValue(entry.value) : '';
    const isEmpty = !String(raw).trim();
    const isSecret = _fieldIsSecret(field);
    const list = field.kind === 'secret-list' ? _maskListForResource(raw) : null;
    const pathExists = field.kind === 'path' && !isEmpty ? _resourcePathExists(raw) : null;
    let status = 'missing';
    if (exists && isEmpty) status = field.importance === 'required' ? 'bad' : 'empty';
    else if (exists && field.kind === 'toggle') status = _isTruthyEnvValue(raw) ? 'on' : 'off';
    else if (exists && pathExists === false) status = field.importance === 'required' || field.importance === 'recommended' ? 'warn' : 'missing-path';
    else if (exists) status = field.legacy ? 'legacy' : 'ok';
    else if (field.defaultValue) status = 'default';
    else if (field.future) status = 'future';

    let displayValue = raw;
    if (field.kind === 'secret-list') {
        displayValue = list.count ? `${list.count} key${list.count === 1 ? '' : 's'} (${list.tails.join(', ')})` : '';
    } else if (isSecret) {
        displayValue = _maskSecretForUi(raw);
    }

    return {
        ...field,
        exists,
        line: entry?.line || null,
        empty: isEmpty,
        secret: isSecret,
        status,
        displayValue,
        editableValue: isSecret ? '' : raw,
        placeholder: isSecret && raw ? `${displayValue} - paste replacement to change` : '',
        list,
        pathExists,
        duplicateCount: parsed.keyCounts.get(field.key) || 0,
    };
}

function _resourceGroupStatus(fields) {
    const bad = fields.some(field => field.status === 'bad');
    const warn = fields.some(field => ['warn', 'legacy'].includes(field.status));
    const hasAny = fields.some(field => field.exists && !field.empty);
    if (bad) return 'bad';
    if (warn) return 'warn';
    if (hasAny) return 'ok';
    return 'empty';
}

function _getResourceEnvStatus() {
    const parsed = _readParsedEnvForResources();
    const knownKeys = new Set();
    const groups = RESOURCE_ENV_GROUPS.map(group => {
        const fields = group.fields.map(field => {
            knownKeys.add(field.key);
            return _resourceFieldStatus(field, parsed);
        });
        return {
            id: group.id,
            title: group.title,
            description: group.description,
            status: _resourceGroupStatus(fields),
            fields,
        };
    });
    for (const entry of parsed.entries) {
        if (/^(BEDROCK|AZURE)_ACTIVE_ACCOUNT$/.test(entry.key) || /^(BEDROCK|AZURE)_ACCOUNT_\d+_/.test(entry.key)) {
            knownKeys.add(entry.key);
        }
    }

    const unmatched = parsed.entries
        .filter(entry => !knownKeys.has(entry.key))
        .map(entry => ({
            key: entry.key,
            line: entry.line,
            empty: !_unquoteEnvValue(entry.value),
            secret: /(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(entry.key),
            displayValue: /(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(entry.key)
                ? _maskSecretForUi(_unquoteEnvValue(entry.value))
                : _unquoteEnvValue(entry.value),
        }));

    const cleanupSuggestions = [];
    if (parsed.duplicates.length) {
        cleanupSuggestions.push(`${parsed.duplicates.length} duplicate env line(s) can be removed safely.`);
    }
    const legacyPresent = groups.find(g => g.id === 'legacy-watch')?.fields.filter(f => f.exists && !f.empty) || [];
    if (legacyPresent.length) {
        cleanupSuggestions.push(`${legacyPresent.length} legacy provider setting(s) are still present.`);
    }
    const intentionalEmpty = groups.flatMap(g => g.fields).filter(f => f.exists && f.empty && f.importance !== 'required');
    if (intentionalEmpty.length) {
        cleanupSuggestions.push(`${intentionalEmpty.length} empty optional/default setting(s) are present. These are kept unless you clear/remove them manually.`);
    }

    return {
        success: true,
        envPath: parsed.envPath,
        projectEnvPath: path.join(PROJECT_DIR, '.env'),
        appRoot: APP_ROOT,
        projectDir: PROJECT_DIR,
        updatedAt: new Date().toISOString(),
        groups,
        unmatched,
        duplicates: parsed.duplicates,
        cleanupSuggestions,
    };
}

function _escapeRegexLiteral(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _setEnvValueInContent(content, key, value) {
    const cleanKey = String(key || '').trim();
    const cleanValue = String(value ?? '');
    const regex = new RegExp(`^\\s*${_escapeRegexLiteral(cleanKey)}\\s*=.*$`, 'm');
    const line = `${cleanKey}=${cleanValue}`;
    if (regex.test(content)) return content.replace(regex, line);
    return `${String(content || '').replace(/\s*$/, '')}\n${line}\n`;
}

function _removeEnvKeyFromContent(content, key) {
    const regex = new RegExp(`^\\s*${_escapeRegexLiteral(key)}\\s*=.*(?:\\r?\\n)?`, 'gm');
    return String(content || '').replace(regex, '');
}

function _cloudProviderDef(provider) {
    const id = String(provider || '').trim().toLowerCase();
    if (!CLOUD_ACCOUNT_DEFS[id]) throw new Error(`Unknown cloud account provider: ${provider}`);
    return CLOUD_ACCOUNT_DEFS[id];
}

function _cloudSlotEnvKey(def, slotId, suffix) {
    return `${def.envPrefix}_ACCOUNT_${Number(slotId)}_${suffix}`;
}

function _cloudActiveSlotId(def, parsed) {
    const raw = _unquoteEnvValue(parsed.byKey.get(def.activeKey)?.value || '');
    const n = parseInt(raw || '1', 10);
    return Number.isFinite(n) && n > 0 ? String(n) : '1';
}

function _cloudSlotIds(def, parsed) {
    const ids = new Set();
    const re = new RegExp(`^${def.envPrefix}_ACCOUNT_(\\d+)_`);
    for (const entry of parsed.entries || []) {
        const match = entry.key.match(re);
        if (match) ids.add(match[1]);
    }
    return [...ids].sort((a, b) => Number(a) - Number(b));
}

function _cloudCanonicalValue(parsed, field) {
    const value = parsed.byKey.get(field.canonical)?.value;
    if (value == null || value === '') return field.defaultValue || '';
    return _unquoteEnvValue(value);
}

function _cloudSlotStoredValue(parsed, def, slotId, suffix) {
    const value = parsed.byKey.get(_cloudSlotEnvKey(def, slotId, suffix))?.value;
    return value == null ? null : _unquoteEnvValue(value);
}

function _cloudFieldForUi(parsed, def, slotId, field, useCanonicalFallback) {
    let raw = _cloudSlotStoredValue(parsed, def, slotId, field.suffix);
    if (raw == null && useCanonicalFallback) raw = _cloudCanonicalValue(parsed, field);
    if (raw == null) raw = field.defaultValue || '';
    const empty = !String(raw || '').trim();
    const secret = field.kind === 'secret';
    return {
        suffix: field.suffix,
        canonical: field.canonical,
        label: field.label,
        kind: field.kind || 'text',
        required: field.required === true,
        secret,
        secretSet: secret && !empty,
        status: field.required && empty ? 'bad' : empty ? 'empty' : 'ok',
        displayValue: secret ? _maskSecretForUi(raw) : raw,
        editableValue: secret ? '' : raw,
        placeholder: secret && raw ? `${_maskSecretForUi(raw)} - paste replacement` : '',
    };
}

function _cloudSlotStatus(fields) {
    if (fields.some(field => field.status === 'bad')) return 'bad';
    if (fields.some(field => field.status === 'ok')) return 'ok';
    return 'empty';
}

function _getCloudAccountStatus() {
    const parsed = _readParsedEnvForResources();
    const providers = Object.values(CLOUD_ACCOUNT_DEFS).map(def => {
        const activeSlotId = _cloudActiveSlotId(def, parsed);
        let ids = _cloudSlotIds(def, parsed);
        const hasStoredSlots = ids.length > 0;
        if (!ids.includes(activeSlotId)) ids.push(activeSlotId);
        if (!ids.length) ids = ['1'];
        ids = [...new Set(ids)].sort((a, b) => Number(a) - Number(b));

        const slots = ids.map(id => {
            const label = _cloudSlotStoredValue(parsed, def, id, 'LABEL') || (hasStoredSlots ? `${def.title.replace(/ Accounts$/, '')} ${id}` : 'Current .env account');
            const useCanonicalFallback = id === activeSlotId || (!hasStoredSlots && id === '1');
            const fields = {};
            for (const field of def.fields) {
                fields[field.suffix] = _cloudFieldForUi(parsed, def, id, field, useCanonicalFallback);
            }
            const fieldList = Object.values(fields);
            const canonicalApplied = id === activeSlotId && def.fields.every(field => {
                const slotVal = fields[field.suffix]?.displayValue || '';
                const canonicalRaw = _cloudCanonicalValue(parsed, field);
                const canonicalDisplay = field.kind === 'secret' ? _maskSecretForUi(canonicalRaw) : canonicalRaw;
                return String(slotVal || '') === String(canonicalDisplay || '');
            });
            return {
                id,
                label,
                active: id === activeSlotId,
                virtual: !hasStoredSlots && id === '1',
                canonicalApplied,
                status: _cloudSlotStatus(fieldList),
                fields,
            };
        });

        return {
            id: def.id,
            title: def.title,
            note: def.note,
            activeSlotId,
            activeKey: def.activeKey,
            fields: def.fields,
            slots,
        };
    });
    return { success: true, envPath: parsed.envPath, updatedAt: new Date().toISOString(), providers };
}

function _cloudPayloadFieldValue(parsed, def, slotId, field, payloadField = {}) {
    if (payloadField.clear === true) return '';
    if (payloadField.keep === true) {
        const stored = _cloudSlotStoredValue(parsed, def, slotId, field.suffix);
        if (stored != null) return stored;
        return _cloudCanonicalValue(parsed, field);
    }
    const value = String(payloadField.value ?? '').trim();
    return value || '';
}

function _normalizeCloudSlotsPayload(providerPayload = {}) {
    const slots = Array.isArray(providerPayload.slots) ? providerPayload.slots : [];
    const normalized = [];
    const seen = new Set();
    for (const slot of slots) {
        const idNum = parseInt(slot?.id, 10);
        if (!Number.isFinite(idNum) || idNum <= 0 || idNum > 99 || seen.has(idNum)) continue;
        seen.add(idNum);
        normalized.push({ ...slot, id: String(idNum) });
    }
    normalized.sort((a, b) => Number(a.id) - Number(b.id));
    return normalized;
}

function _resolvedCloudSlotFromPayload(parsed, def, slotPayload) {
    const slotId = String(slotPayload.id || '1');
    const fields = {};
    for (const field of def.fields) {
        fields[field.suffix] = _cloudPayloadFieldValue(parsed, def, slotId, field, slotPayload.fields?.[field.suffix] || {});
    }
    return {
        id: slotId,
        label: String(slotPayload.label || '').trim() || `${def.title.replace(/ Accounts$/, '')} ${slotId}`,
        fields,
    };
}

function _applyCloudAccountSlots(payload = {}) {
    const envPath = _resourceEnvPath();
    const parsed = _readParsedEnvForResources();
    let content = parsed.content || '';
    const changedKeys = [];
    const providerPayloads = payload.providers && typeof payload.providers === 'object' ? payload.providers : {};

    for (const [providerId, providerPayload] of Object.entries(providerPayloads)) {
        const def = _cloudProviderDef(providerId);
        const slots = _normalizeCloudSlotsPayload(providerPayload);
        if (!slots.length) continue;
        const activeRequested = String(providerPayload.activeSlotId || slots[0].id);
        const activeSlotId = slots.some(slot => slot.id === activeRequested) ? activeRequested : slots[0].id;
        const resolvedSlots = slots.map(slot => _resolvedCloudSlotFromPayload(parsed, def, slot));

        const slotLineRe = new RegExp(`^\\s*${_escapeRegexLiteral(def.envPrefix)}_ACCOUNT_\\d+_[A-Za-z0-9_]+\\s*=.*(?:\\r?\\n)?`, 'gm');
        content = String(content || '').replace(slotLineRe, '');
        content = _removeEnvKeyFromContent(content, def.activeKey);

        content = _setEnvValueInContent(content, def.activeKey, activeSlotId);
        changedKeys.push(def.activeKey);
        for (const slot of resolvedSlots) {
            const labelKey = _cloudSlotEnvKey(def, slot.id, 'LABEL');
            content = _setEnvValueInContent(content, labelKey, slot.label);
            changedKeys.push(labelKey);
            for (const field of def.fields) {
                const envKey = _cloudSlotEnvKey(def, slot.id, field.suffix);
                content = _setEnvValueInContent(content, envKey, slot.fields[field.suffix] || '');
                changedKeys.push(envKey);
            }
        }

        const active = resolvedSlots.find(slot => slot.id === activeSlotId) || resolvedSlots[0];
        for (const field of def.fields) {
            content = _setEnvValueInContent(content, field.canonical, active.fields[field.suffix] || '');
            process.env[field.canonical] = active.fields[field.suffix] || '';
            changedKeys.push(field.canonical);
        }
        process.env[def.activeKey] = activeSlotId;
    }

    fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
    for (const key of changedKeys) {
        const parsedAgain = _parseEnvContent(content);
        const value = parsedAgain.byKey.get(key)?.value;
        if (value != null) process.env[key] = _unquoteEnvValue(value);
    }
    for (const modulePath of RUNTIME_CONFIG_MODULE_PATHS) {
        delete require.cache[modulePath];
    }
    return {
        changedKeys: [...new Set(changedKeys)],
        runtimeConfigRefreshed: true,
        ..._getCloudAccountStatus(),
    };
}

function _applyResourceEnvEdits(envPath, updates = {}, removals = []) {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const changedKeys = [];
    for (const key of removals || []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ''))) continue;
        content = _removeEnvKeyFromContent(content, key);
        delete process.env[key];
        changedKeys.push(key);
    }
    for (const [key, value] of Object.entries(updates || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ''))) continue;
        content = _setEnvValueInContent(content, key, value);
        process.env[key] = String(value ?? '');
        changedKeys.push(key);
    }
    fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
    const qwenChanged = changedKeys.some(key => String(key).startsWith('QWEN_'));
    const runtimeConfigChanged = changedKeys.some(key => /^(AI_PROVIDER|BEDROCK_|AZURE_|QWEN_|BRAVE_|TAVILY_|YTDLP_|STORYBLOCKS_|MEDIA_|FOOTAGE_|IMAGE_|CLIP_ANALYZER_|VISION_)/.test(String(key)));
    if (runtimeConfigChanged) {
        for (const modulePath of RUNTIME_CONFIG_MODULE_PATHS) {
            delete require.cache[modulePath];
        }
    }
    if (qwenChanged && fs.existsSync(_qwenExhaustedPath)) {
        fs.unlinkSync(_qwenExhaustedPath);
    }
    return { changedKeys: [...new Set(changedKeys)], qwenTrackingReset: qwenChanged, runtimeConfigRefreshed: runtimeConfigChanged };
}

function _cleanResourceEnvFile(envPath) {
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const lines = content.split(/\r?\n/);
    const seen = new Set();
    const removed = [];
    const next = [];
    for (const raw of lines) {
        const trimmedLine = raw.replace(/[ \t]+$/g, '');
        const match = trimmedLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!match) {
            next.push(trimmedLine);
            continue;
        }
        const key = match[1].trim();
        if (seen.has(key)) {
            removed.push(key);
            continue;
        }
        seen.add(key);
        next.push(trimmedLine);
    }
    const normalized = next.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
    fs.writeFileSync(envPath, normalized, 'utf8');
    return { removedDuplicates: removed };
}

function _withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'check'} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function _checkResult(id, title, status, detail = '') {
    return { id, title, status, detail };
}

async function _checkBedrockAccountValues(values = {}, timeoutMs = 9000, title = 'AWS Bedrock') {
    const region = values.REGION || process.env.BEDROCK_REGION || 'us-east-1';
    const accessKeyId = values.ACCESS_KEY_ID || process.env.BEDROCK_ACCESS_KEY_ID || '';
    const secretAccessKey = values.SECRET_ACCESS_KEY || process.env.BEDROCK_SECRET_ACCESS_KEY || '';
    const modelId = values.UTILITY_MODEL || values.DIRECTOR_MODEL || process.env.BEDROCK_UTILITY_MODEL || process.env.BEDROCK_DIRECTOR_MODEL || '';
    if (!accessKeyId || !secretAccessKey || !modelId) {
        return _checkResult('bedrock', title, 'warn', 'Missing access key, secret key, or model ID.');
    }
    try {
        const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
        const client = new BedrockRuntimeClient({ region, credentials: { accessKeyId, secretAccessKey } });
        const t0 = Date.now();
        const res = await _withTimeout(client.send(new ConverseCommand({
            modelId,
            messages: [{ role: 'user', content: [{ text: 'Reply with exactly OK.' }] }],
            inferenceConfig: { maxTokens: 12 },
        })), timeoutMs, title);
        const elapsed = Date.now() - t0;
        const usage = res?.usage ? ` input=${res.usage.inputTokens || 0} output=${res.usage.outputTokens || 0}` : '';
        return _checkResult('bedrock', title, 'ok', `${modelId} responded in ${(elapsed / 1000).toFixed(1)}s.${usage}`);
    } catch (e) {
        return _checkResult('bedrock', title, 'bad', e.message || String(e));
    }
}

async function _checkBedrockResource(timeoutMs) {
    return _checkBedrockAccountValues({}, timeoutMs, 'AWS Bedrock');
}

async function _checkBraveResource(timeoutMs) {
    const apiKey = process.env.BRAVE_API_KEY || '';
    if (!apiKey) return _checkResult('brave', 'Brave Images', 'warn', 'BRAVE_API_KEY is empty.');
    try {
        const url = new URL('https://api.search.brave.com/res/v1/images/search');
        url.searchParams.set('q', 'test image');
        url.searchParams.set('count', '1');
        url.searchParams.set('safesearch', 'strict');
        const fetchFn = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
        const res = await _withTimeout(fetchFn(url, {
            headers: {
                Accept: 'application/json',
                'X-Subscription-Token': apiKey,
            },
        }), timeoutMs, 'Brave Images');
        if (!res.ok) {
            return _checkResult('brave', 'Brave Images', res.status === 429 ? 'warn' : 'bad', `HTTP ${res.status}`);
        }
        const json = await res.json().catch(() => ({}));
        const count = Array.isArray(json?.results) ? json.results.length : 0;
        return _checkResult('brave', 'Brave Images', 'ok', `API reachable; ${count} sample result(s).`);
    } catch (e) {
        return _checkResult('brave', 'Brave Images', 'bad', e.message || String(e));
    }
}

function _azureAnthropicBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/anthropic$/i.test(raw)) return raw;
    if (/\/anthropic\/v1\/messages$/i.test(raw)) return raw.replace(/\/v1\/messages$/i, '');
    if (/\/openai\/v1$/i.test(raw)) return raw.replace(/\/openai\/v1$/i, '/anthropic');
    if (/\.services\.ai\.azure\.com\/api\/projects\//i.test(raw)) return raw.replace(/\/api\/projects\/.*$/i, '/anthropic');
    if (/\.services\.ai\.azure\.com$/i.test(raw)) return `${raw}/anthropic`;
    if (/\.openai\.azure\.com$/i.test(raw)) return raw.replace(/\.openai\.azure\.com$/i, '.services.ai.azure.com/anthropic');
    return raw;
}

function _azureOpenAIBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '');
    if (/\/openai\/v1$/i.test(raw)) return raw;
    if (/\.openai\.azure\.com$/i.test(raw)) return `${raw}/openai/v1`;
    if (/\.services\.ai\.azure\.com\/api\/projects\//i.test(raw)) return raw.replace(/\/api\/projects\/.*$/i, '/openai/v1');
    if (/\.services\.ai\.azure\.com$/i.test(raw)) return `${raw}/openai/v1`;
    return raw;
}

function _checkAzureResource() {
    const apiKey = process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || '';
    if (!apiKey) return _checkResult('azure', 'Azure AI', 'warn', 'Incomplete: missing API key.');
    const routes = [];
    if (process.env.AZURE_ANTHROPIC_BASE_URL && process.env.AZURE_CLAUDE_MODEL) routes.push(`Claude:${process.env.AZURE_CLAUDE_MODEL}`);
    if (process.env.AZURE_OPENAI_ENDPOINT && (process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT)) {
        routes.push(`OpenAI:${process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT}`);
    }
    if (!routes.length) {
        return _checkResult('azure', 'Azure AI', 'warn', 'Incomplete: set either Claude base+model or OpenAI endpoint+model.');
    }
    return _checkResult('azure', 'Azure AI', 'ok', `Configured routes: ${routes.join(', ')}.`);
}

async function _checkAzureAccountValues(values = {}, timeoutMs = 9000, title = 'Azure AI') {
    const apiKey = values.API_KEY || process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || '';
    const openAIEndpoint = String(values.OPENAI_ENDPOINT || values.ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
    const openAIModel = values.OPENAI_MODEL || values.OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || '';
    const claudeEndpoint = String(values.ANTHROPIC_BASE_URL || values.CLAUDE_BASE_URL || process.env.AZURE_ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
    const claudeDeployment = values.CLAUDE_MODEL || values.DEPLOYMENT || process.env.AZURE_CLAUDE_MODEL || 'claude-sonnet-4-6';
    const apiVersion = values.ANTHROPIC_VERSION || process.env.AZURE_ANTHROPIC_VERSION || '2023-06-01';
    if (!apiKey) {
        return _checkResult('azure', title, 'warn', 'Incomplete slot: missing API key.');
    }
    if (openAIEndpoint && openAIModel) {
        try {
            const fetchFn = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
            const url = `${_azureOpenAIBaseUrl(openAIEndpoint)}/chat/completions`;
            const t0 = Date.now();
            const res = await _withTimeout(fetchFn(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey,
                },
                body: JSON.stringify({
                    model: openAIModel,
                    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
                    max_tokens: 8,
                }),
            }), timeoutMs, title);
            const elapsed = Date.now() - t0;
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return _checkResult('azure', title, 'bad', `OpenAI HTTP ${res.status}${body ? ` - ${body.slice(0, 180)}` : ''}`);
            }
            return _checkResult('azure', title, 'ok', `${openAIModel} responded in ${(elapsed / 1000).toFixed(1)}s.`);
        } catch (e) {
            return _checkResult('azure', title, 'bad', e.message || String(e));
        }
    }
    if (!claudeEndpoint || !claudeDeployment) {
        return _checkResult('azure', title, 'warn', 'Incomplete slot: set either OpenAI endpoint+model or Claude base+model.');
    }
    try {
        const fetchFn = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
        const url = `${_azureAnthropicBaseUrl(claudeEndpoint)}/v1/messages`;
        const t0 = Date.now();
        const res = await _withTimeout(fetchFn(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': apiVersion,
            },
            body: JSON.stringify({
                model: claudeDeployment,
                messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
                max_tokens: 8,
                stream: false,
            }),
        }), timeoutMs, title);
        const elapsed = Date.now() - t0;
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return _checkResult('azure', title, 'bad', `HTTP ${res.status}${body ? ` - ${body.slice(0, 180)}` : ''}`);
        }
        return _checkResult('azure', title, 'ok', `${claudeDeployment} responded in ${(elapsed / 1000).toFixed(1)}s.`);
    } catch (e) {
        return _checkResult('azure', title, 'bad', e.message || String(e));
    }
}

function _cloudSlotPayloadValues(provider, slotPayload = {}) {
    const def = _cloudProviderDef(provider);
    const parsed = _readParsedEnvForResources();
    const slotId = String(slotPayload.id || slotPayload.slotId || _cloudActiveSlotId(def, parsed));
    const resolved = _resolvedCloudSlotFromPayload(parsed, def, {
        id: slotId,
        label: slotPayload.label || '',
        fields: slotPayload.fields || {},
    });
    return { def, slotId, values: resolved.fields, label: resolved.label };
}

async function _checkCloudAccountSlot(provider, slotPayload = {}, timeoutMs = 9000) {
    const { def, slotId, values, label } = _cloudSlotPayloadValues(provider, slotPayload);
    const title = `${def.title.replace(/ Accounts$/, '')} ${slotId}${label ? ` - ${label}` : ''}`;
    if (def.id === 'bedrock') return _checkBedrockAccountValues(values, timeoutMs, title);
    if (def.id === 'azure') return _checkAzureAccountValues(values, timeoutMs, title);
    return _checkResult(def.id, title, 'warn', 'No checker is wired for this provider.');
}

function _checkLocalResourcePaths() {
    const checks = [];
    const ytdlpPath = process.env.YTDLP_PATH || '';
    checks.push(_checkResult(
        'ytdlp',
        'yt-dlp',
        ytdlpPath && _resourcePathExists(ytdlpPath) ? 'ok' : 'warn',
        ytdlpPath ? (_resourcePathExists(ytdlpPath) ? 'Executable found.' : 'Configured path was not found.') : 'YTDLP_PATH is empty.'
    ));

    const cookies = process.env.YTDLP_COOKIES_FILE || '';
    checks.push(_checkResult(
        'youtube-cookies',
        'YouTube cookies',
        cookies && _resourcePathExists(cookies) ? 'ok' : 'warn',
        cookies ? (_resourcePathExists(cookies) ? 'Cookie file found.' : 'Configured cookie file was not found.') : 'YTDLP_COOKIES_FILE is empty.'
    ));

    const storyblocksCookie = process.env.STORYBLOCKS_COOKIE_FILE || '.storyblocks-cookies.json';
    checks.push(_checkResult(
        'storyblocks',
        'Storyblocks',
        (process.env.STORYBLOCKS_SUBSCRIBED === '1' || process.env.STORYBLOCKS_SUBSCRIBED === 'true') ? 'ok' : 'warn',
        `${_resourcePathExists(storyblocksCookie) ? 'Cookie file found' : 'Cookie file not found'}; subscribed=${process.env.STORYBLOCKS_SUBSCRIBED || 'unset'}.`
    ));
    return checks;
}

async function _runResourceLiveChecks(options = {}) {
    const changedKeys = Array.isArray(options.changedKeys) ? options.changedKeys : [];
    const force = options.force === true;
    const timeoutMs = Math.max(4000, Math.min(20000, Number(options.timeoutMs || 9000) || 9000));
    const checks = [];
    checks.push(..._checkLocalResourcePaths());
    const changed = (prefixes) => force || changedKeys.some(key => prefixes.some(prefix => String(key).startsWith(prefix)));
    const changedOnly = (prefixes) => changedKeys.some(key => prefixes.some(prefix => String(key).startsWith(prefix)));
    if (changed(['BEDROCK_', 'AI_PROVIDER'])) checks.push(await _checkBedrockResource(timeoutMs));
    if (changed(['BRAVE_'])) checks.push(await _checkBraveResource(timeoutMs));
    const azureConfigured = !!(process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_ANTHROPIC_BASE_URL || process.env.AZURE_CLAUDE_MODEL);
    if (changedOnly(['AZURE_']) || (force && azureConfigured)) checks.push(_checkAzureResource());
    if (changed(['QWEN_'])) {
        try {
            const aiProvider = require('./src/brain/ai-provider');
            const status = aiProvider.getQwenVisionStatus();
            checks.push(_checkResult(
                'qwen',
                'Alibaba Qwen Vision',
                Number(status?.image?.available || 0) > 0 || Number(status?.omniHttp?.available || 0) > 0 ? 'ok' : 'warn',
                `Image ${status?.image?.available || 0}/${status?.image?.total || 0}; Omni ${status?.omniHttp?.available || 0}/${status?.omniHttp?.total || 0}. Use Live Probe for real model calls.`
            ));
        } catch (e) {
            checks.push(_checkResult('qwen', 'Alibaba Qwen Vision', 'bad', e.message || String(e)));
        }
    }
    return {
        success: true,
        checkedAt: new Date().toISOString(),
        checks,
        summary: {
            ok: checks.filter(c => c.status === 'ok').length,
            warn: checks.filter(c => c.status === 'warn').length,
            bad: checks.filter(c => c.status === 'bad').length,
        },
    };
}

ipcMain.handle('qwen-pool-status', async () => {
    try {
        if (fs.existsSync(_qwenExhaustedPath)) {
            const data = JSON.parse(fs.readFileSync(_qwenExhaustedPath, 'utf8'));
            // Support role/lane-scoped format ({ text, image, omni }), older
            // role-scoped format ({ text, vision }), multi-key legacy, and old flat format.
            if (data.text || data.image || data.omni || data.vision) {
                let totalExhausted = 0, totalModels = 0;
                for (const roleMap of [data.text || {}, data.image || {}, data.omni || {}, data.vision || {}]) {
                    for (const map of Object.values(roleMap)) {
                        totalExhausted += Object.values(map).filter(v => v === true).length;
                        totalModels += Object.keys(map).length;
                    }
                }
                return { exhausted: totalExhausted, total: totalModels, multiKey: true, roleScoped: true, laneScoped: !!(data.image || data.omni) };
            }
            // Support both old format (flat) and legacy multi-key format (keys: { hash: { ... } })
            if (data.keys) {
                let totalExhausted = 0, totalModels = 0;
                for (const [hash, map] of Object.entries(data.keys)) {
                    totalExhausted += Object.values(map).filter(v => v === true).length;
                    totalModels += Object.keys(map).length;
                }
                return { exhausted: totalExhausted, total: totalModels, multiKey: true };
            }
            const exhausted = Object.values(data).filter(v => v === true).length;
            return { exhausted, total: Object.keys(data).length };
        }
        return { exhausted: 0, total: 0 };
    } catch (e) {
        return { exhausted: 0, total: 0 };
    }
});
ipcMain.handle('qwen-pool-reset', async () => {
    try {
        if (fs.existsSync(_qwenExhaustedPath)) {
            fs.unlinkSync(_qwenExhaustedPath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('qwen-vision-keys-status', async () => {
    try {
        return { success: true, ..._qwenVisionKeysForUi() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('qwen-vision-keys-save', async (_event, payload = {}) => {
    try {
        const envPath = USER_ENV_PATH;
        let saved;
        if (payload?.lanes && typeof payload.lanes === 'object') {
            const imageKeys = _applyQwenKeyEdit(_resolveQwenLaneKeysForSave(envPath, 'image'), payload.lanes.image || {});
            const omniKeys = _applyQwenKeyEdit(_resolveQwenLaneKeysForSave(envPath, 'omni'), payload.lanes.omni || {});
            updateEnvFileAt(envPath, 'QWEN_IMAGE_API_KEY', imageKeys.join(','));
            updateEnvFileAt(envPath, 'QWEN_VL_API_KEY', '');
            updateEnvFileAt(envPath, 'QWEN_OMNI_API_KEY', omniKeys.join(','));
            process.env.QWEN_IMAGE_API_KEY = imageKeys.join(',');
            process.env.QWEN_VL_API_KEY = '';
            process.env.QWEN_OMNI_API_KEY = omniKeys.join(',');
            saved = { image: imageKeys.length, omni: omniKeys.length };
        } else {
            // Legacy UI payload: edit the shared fallback pool only.
            const sharedKeys = _applyQwenKeyEdit(_resolveQwenLaneKeysForSave(envPath, 'shared'), payload);
            updateEnvFileAt(envPath, 'QWEN_VISION_API_KEY', sharedKeys.join(','));
            process.env.QWEN_VISION_API_KEY = sharedKeys.join(',');
            saved = sharedKeys.length;
        }
        if (fs.existsSync(_qwenExhaustedPath)) {
            fs.unlinkSync(_qwenExhaustedPath);
        }

        const aiProvider = require('./src/brain/ai-provider');
        const status = aiProvider.getQwenVisionStatus();
        return { success: true, saved, clearedTracking: true, status, ..._qwenVisionKeysForUi() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('vision-health-status', async () => {
    try {
        const aiProvider = require('./src/brain/ai-provider');
        return { success: true, status: aiProvider.getQwenVisionStatus() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('vision-health-live-check', async (_event, options = {}) => {
    try {
        const aiProvider = require('./src/brain/ai-provider');
        const imageLimit = Math.max(0, Math.min(4, Number(options.imageLimit || 1) || 1));
        const omniLimit = Math.max(0, Math.min(4, Number(options.omniLimit || 1) || 1));
        const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 3) || 3));
        const timeoutMs = Math.max(5000, Math.min(30000, Number(options.timeoutMs || 12000) || 12000));
        const lanes = Array.isArray(options.lanes) && options.lanes.length
            ? options.lanes.filter(lane => ['image', 'omniHttp', 'omniRealtime'].includes(lane))
            : ['image', 'omniHttp'];
        const probe = await aiProvider.refreshQwenVisionHealth({
            lanes,
            imageLimit,
            omniLimit,
            concurrency,
            timeoutMs
        });
        return { success: true, probe, status: aiProvider.getQwenVisionStatus() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-status', async () => {
    try {
        return _getResourceEnvStatus();
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-save', async (_event, payload = {}) => {
    try {
        const envPath = _resourceEnvPath();
        const updates = payload?.updates && typeof payload.updates === 'object' ? payload.updates : {};
        const removals = Array.isArray(payload?.removals) ? payload.removals : [];
        const updateCount = Object.keys(updates).length;
        if (!updateCount && !removals.length) {
            return { success: true, changedKeys: [], skipped: true, ..._getResourceEnvStatus() };
        }
        const backupPath = _backupEnvFile(envPath, 'resource-save');
        const editResult = _applyResourceEnvEdits(envPath, updates, removals);
        return {
            success: true,
            backupPath,
            ...editResult,
            ..._getResourceEnvStatus(),
        };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-clean', async () => {
    try {
        const envPath = _resourceEnvPath();
        const backupPath = _backupEnvFile(envPath, 'resource-clean');
        const cleaned = _cleanResourceEnvFile(envPath);
        return {
            success: true,
            backupPath,
            ...cleaned,
            ..._getResourceEnvStatus(),
        };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-live-check', async (_event, options = {}) => {
    try {
        return await _runResourceLiveChecks(options || {});
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('cloud-account-slots-status', async () => {
    try {
        return _getCloudAccountStatus();
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('cloud-account-slots-save', async (_event, payload = {}) => {
    try {
        const envPath = _resourceEnvPath();
        const backupPath = _backupEnvFile(envPath, 'cloud-accounts');
        const result = _applyCloudAccountSlots(payload || {});
        return { success: true, backupPath, ...result };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('cloud-account-slot-check', async (_event, payload = {}) => {
    try {
        const provider = payload?.provider || '';
        const slot = payload?.slot || {};
        const timeoutMs = Math.max(4000, Math.min(30000, Number(payload?.timeoutMs || 9000) || 9000));
        const check = await _checkCloudAccountSlot(provider, slot, timeoutMs);
        return { success: true, check };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('open-footage-resources', async () => {
    createFootageResourcesWindow();
    return { success: true };
});

ipcMain.handle('footage-resources-get', async () => {
    return { success: true, ...footageResourceState };
});

ipcMain.handle('footage-resources-set', async (_event, payload = {}) => {
    footageResourceState = normalizeFootageResourceState(payload || {});
    broadcastFootageResourceState();
    return { success: true, ...footageResourceState };
});

// ============ STYLE LEARNER IPC ============
// Reference video → Gemini multimodal analysis → structured style profile JSON.
// Profiles live under PROJECT_DIR/styles/ and are picked from a dropdown in build settings.

function _styleProfilesDir() {
    const dir = path.join(PROJECT_DIR, 'styles');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

ipcMain.handle('learn-style', async (event, input) => {
    try {
        if (!input || typeof input !== 'string') {
            return { success: false, error: 'No input provided' };
        }
        const normalizedInput = /^https?:\/\//i.test(input)
            ? input
            : _resolveGrantedFile(event, input);
        if (!normalizedInput) {
            return { success: false, error: 'Reference must be an http(s) URL or a file selected through the picker' };
        }
        const styleLearner = require('./src/studio/style-learner');
        const saveDir = _styleProfilesDir();

        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('learn-style-progress', { percent, message });
            }
        };

        const profile = await styleLearner.analyzeStyle(normalizedInput, {
            saveDir,
            onProgress: sendProgress
        });

        // analyzeStyle attaches savedPath to the returned profile.
        return { success: true, profile, path: profile.savedPath };
    } catch (e) {
        console.error('[learn-style] Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('learn-style-multi', async (event, urls, profileName) => {
    try {
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return { success: false, error: 'No URLs provided' };
        }
        const safeInputs = urls.slice(0, 20).map((input) => {
            if (typeof input !== 'string') return null;
            return /^https?:\/\//i.test(input) ? input : _resolveGrantedFile(event, input);
        }).filter(Boolean);
        if (safeInputs.length !== urls.length) {
            return { success: false, error: 'Every reference must be an http(s) URL or a selected file' };
        }
        const styleLearner = require('./src/studio/style-learner');
        const saveDir = _styleProfilesDir();

        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('learn-style-progress', { percent, message });
            }
        };

        const profile = await styleLearner.analyzeMultiple(safeInputs, {
            name: profileName || undefined,
            saveDir,
            onProgress: sendProgress,
        });

        return { success: true, profile, path: profile.savedPath };
    } catch (e) {
        console.error('[learn-style-multi] Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('compare-style', async (event, profilePath, videoPlan) => {
    try {
        const styleLearner = require('./src/studio/style-learner');
        const allowedProfile = _resolveExistingFileWithin([_styleProfilesDir()], profilePath);
        if (!allowedProfile || path.extname(allowedProfile).toLowerCase() !== '.json') {
            return { success: false, error: 'Style profile must be inside the active project styles folder' };
        }
        const profile = styleLearner.loadStyleProfile(allowedProfile);
        if (!profile) return { success: false, error: 'Could not load style profile' };
        const report = styleLearner.compareWithBuild(profile, videoPlan);
        const formatted = styleLearner.formatComparison(report);
        return { success: true, report: formatted, data: report };
    } catch (e) {
        console.error('[compare-style] Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

// ========================================
// Style Studio Agent — Conversational style analyst
// ========================================
function _sendStudioProgress(window, percent, message) {
    if (window && !window.isDestroyed()) {
        window.webContents.send('style-studio-progress', { percent, message });
    }
}

function _resolveStyleStudioInput(event, input) {
    if (typeof input !== 'string') return null;
    if (/^https?:\/\//i.test(input)) return input.slice(0, 4000);
    return _resolveGrantedFile(event, input);
}

ipcMain.handle('style-studio-start', async (event, input, options) => {
    try {
        const safeInput = _resolveStyleStudioInput(event, input);
        if (!safeInput) {
            return { error: 'Input must be an http(s) URL or a file selected through the picker' };
        }
        const studio = require('./src/studio/style-studio-agent');
        const saveDir = _styleProfilesDir();
        const win = BrowserWindow.fromWebContents(event.sender);

        const result = await studio.startSession(safeInput, {
            saveDir,
            thinkingMode: options?.thinkingMode === 'on' ? 'on' : 'off',
            codeAccess: options?.codeAccess === true,
            onProgress: (pct, msg) => _sendStudioProgress(win, pct, msg),
        });
        return result;
    } catch (e) {
        console.error('[style-studio-start] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-add-video', async (event, sessionId, input) => {
    try {
        const safeInput = _resolveStyleStudioInput(event, input);
        if (!safeInput) return { error: 'Video must be an http(s) URL or a selected file' };
        const studio = require('./src/studio/style-studio-agent');
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await studio.addVideo(String(sessionId || '').slice(0, 160), safeInput, (pct, msg) =>
            _sendStudioProgress(win, pct, msg));
        return result;
    } catch (e) {
        console.error('[style-studio-add-video] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-chat', async (event, sessionId, message) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const result = await studio.chat(
            String(sessionId || '').slice(0, 160),
            String(message || '').slice(0, 20_000)
        );
        return result;
    } catch (e) {
        console.error('[style-studio-chat] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-analyze-script', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const result = await studio.analyzeScript(sessionId);
        return result;
    } catch (e) {
        console.error('[style-studio-analyze-script] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-extract-profile', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const profile = await studio.extractProfile(sessionId);
        return { profile };
    } catch (e) {
        console.error('[style-studio-extract-profile] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-save-profile', async (event, sessionId, name) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const profile = studio.saveProfile(sessionId, name);
        return { savedPath: profile.savedPath, profile };
    } catch (e) {
        console.error('[style-studio-save-profile] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-end-session', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return await studio.endSession(sessionId);
    } catch (e) {
        console.error('[style-studio-end-session] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-session-info', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return studio.getSessionInfo(sessionId);
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-set-code-access', async (event, sessionId, enabled) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return studio.setCodeAccess(sessionId, enabled);
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// Receive live project settings from the renderer so the agent knows the
// user's video title / niche / AI instructions even before the .fvp is saved.
ipcMain.handle('style-studio-set-project-context', async (event, ctx) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.setLiveProjectContext(ctx || {});
        return { ok: true };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// --- Session Persistence ---

ipcMain.handle('style-studio-check-saved', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const saveDir = _styleProfilesDir();
        const saved = studio.loadSavedSession(saveDir);
        return saved; // null if no saved session
    } catch (e) {
        return null;
    }
});

ipcMain.handle('style-studio-restore', async (event) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const saveDir = _styleProfilesDir();
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await studio.restoreSession(saveDir, (pct, msg) =>
            _sendStudioProgress(win, pct, msg));
        return result;
    } catch (e) {
        console.error('[style-studio-restore] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-discard-saved', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.deleteSavedSession(_styleProfilesDir());
        return { ok: true };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// --- Style Studio Memory ---

ipcMain.handle('style-studio-load-memory', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return { memories: studio.loadMemory(_styleProfilesDir()) };
    } catch (e) {
        return { memories: [] };
    }
});

ipcMain.handle('style-studio-save-memory', async (event, text, category) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const memories = studio.saveMemoryEntry(_styleProfilesDir(), text, category || 'user-note');
        return { memories };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-delete-memory', async (event, index) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const memories = studio.deleteMemoryEntry(_styleProfilesDir(), index);
        return { memories };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-clear-memory', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.clearMemory(_styleProfilesDir());
        return { memories: [] };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// --- In-Studio Audio Transcription (Whisper) ---
// Writes to <project>/temp/transcription.json so the Style Studio agent's
// _buildTimestampedTranscriptContext() can pick it up on "plan scenes".

ipcMain.handle('style-studio-pick-audio', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const result = await dialog.showOpenDialog(win, {
            title: 'Choose audio file',
            properties: ['openFile'],
            filters: [
                { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'webm', 'mp4'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return null;
        const audioPath = _grantSelectedFile(event, result.filePaths[0]);
        if (!audioPath) return { error: 'Selected audio file is unavailable' };
        let size = null;
        try { size = fs.statSync(audioPath).size; } catch (_) {}
        return { path: audioPath, name: path.basename(audioPath), size };
    } catch (e) {
        console.error('[style-studio-pick-audio] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-transcribe-audio', async (event, audioPath, options) => {
    try {
        if (!audioPath || typeof audioPath !== 'string') {
            return { error: 'No audio path provided' };
        }
        const allowedAudio = _resolveGrantedFile(event, audioPath)
            || _resolveExistingFileWithin([INPUT_PATH, TEMP_PATH], audioPath);
        if (!allowedAudio || !/\.(mp3|wav|m4a|flac|ogg|opus|aac|webm|mp4)$/i.test(allowedAudio)) {
            return { error: 'Audio file is outside the active project and was not selected through the picker' };
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        const send = (pct, msg) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('style-studio-transcribe-progress', { percent: pct, message: msg });
            }
        };

        send(5, 'Loading Whisper…');
        const { transcribeAudio } = require('./src/pipeline/transcribe');
        const result = await transcribeAudio(allowedAudio, {
            languageHint: typeof options?.languageHint === 'string' ? options.languageHint.slice(0, 20) : null
        });
        send(100, 'Transcription complete');

        // transcribeAudio wrote the JSON to <project>/temp/transcription.json
        const config = require('./src/settings/config');
        const outPath = path.join(config.paths.temp, 'transcription.json');
        return {
            ok: true,
            path: outPath,
            duration: result.duration || 0,
            language: result.language || 'unknown',
            segments: (result.segments || []).length,
            text: (result.text || '').slice(0, 2000)
        };
    } catch (e) {
        console.error('[style-studio-transcribe-audio] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-get-transcript-info', async () => {
    try {
        const config = require('./src/settings/config');
        const p = path.join(config.paths.temp, 'transcription.json');
        if (!fs.existsSync(p)) return { exists: false };
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const st = fs.statSync(p);
        return {
            exists: true,
            path: p,
            duration: j.duration || 0,
            language: j.language || 'unknown',
            segments: (j.segments || []).length,
            mtime: st.mtimeMs
        };
    } catch (e) {
        return { exists: false, error: e.message };
    }
});

// pick-video-file handler is registered later (legacy from style-learner)

ipcMain.handle('scan-style-profiles', async () => {
    try {
        const dir = _styleProfilesDir();
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.style.json'));
        const profiles = [];
        for (const f of files) {
            try {
                const full = path.join(dir, f);
                const json = JSON.parse(fs.readFileSync(full, 'utf8'));
                profiles.push({
                    path: full,
                    name: json.name || f.replace('.style.json', ''),
                    videoDuration: json.videoDuration || null,
                    createdAt: json.createdAt || null
                });
            } catch (e) { /* skip malformed */ }
        }
        // Newest first
        profiles.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return profiles;
    } catch (e) {
        console.error('[scan-style-profiles] Failed:', e);
        return [];
    }
});

ipcMain.handle('pick-video-file', async (event) => {
    try {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || mainWindow, {
            title: 'Choose reference video',
            properties: ['openFile'],
            filters: [
                { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return null;
        return _grantSelectedFile(event, result.filePaths[0]);
    } catch (e) {
        console.error('[pick-video-file] Failed:', e);
        return null;
    }
});

// Create a real project and route it through the hybrid workspace/new-instance lifecycle.
// options: { projectName, location, locationMode }
ipcMain.handle('launch-new-instance', async (event, options) => {
    let selectedLocation;
    let projectName;
    let locationMode;

    if (options?.location) {
        const grantedLocation = _resolveGrantedDirectory(event, options.location);
        if (!grantedLocation) return { success: false, error: 'Project location was not selected through the folder picker' };
        selectedLocation = grantedLocation;
        projectName = String(options.projectName || '').trim();
        locationMode = options.locationMode;
    } else {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose an empty folder for the new project',
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
        selectedLocation = result.filePaths[0];
        projectName = path.basename(selectedLocation);
        locationMode = 'selected-folder';
    }

    const prepared = _prepareNewProjectTarget({
        location: selectedLocation,
        projectName,
        locationMode,
    });
    if (!prepared.success) return prepared;

    const opened = await _openProjectTarget(prepared.projectDir, {
        projectFile: prepared.projectFile,
    });
    return {
        ...opened,
        created: true,
        projectName: prepared.projectName,
        locationMode: prepared.locationMode,
    };
});

// Open an existing project in the current workspace window.
ipcMain.handle('open-existing-project', async () => {
    const selection = await promptForExistingProjectPath(mainWindow);
    if (!selection) return { success: false, cancelled: true };

    return _openProjectTarget(selection.projectDir, {
        projectFile: selection.projectFile,
    });
});

// Open existing project by selecting a folder (no mode prompt)
ipcMain.handle('open-existing-project-folder', async () => {
    const folderResult = await dialog.showOpenDialog(mainWindow, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (folderResult.canceled || !folderResult.filePaths.length) return { success: false, cancelled: true };

    const projectPath = folderResult.filePaths[0];
    return _openProjectTarget(projectPath);
});

// Open existing project by selecting a .fvp file (no mode prompt)
ipcMain.handle('open-existing-project-file', async () => {
    const fileResult = await dialog.showOpenDialog(mainWindow, {
        title: 'Open .fvp project file',
        properties: ['openFile'],
        filters: [{ name: 'Project Files', extensions: ['fvp'] }]
    });
    if (fileResult.canceled || !fileResult.filePaths.length) return { success: false, cancelled: true };

    const projectFile = fileResult.filePaths[0];
    const projectPath = path.dirname(projectFile);
    return _openProjectTarget(projectPath, { projectFile });
});

// ========================================
// Desktop Shortcut & Start Menu
// ========================================
ipcMain.handle('create-desktop-shortcut', async () => {
    try {
        const { desktopShortcutPath, startMenuShortcutPath } = createWindowsAppShortcuts();
        console.log('Desktop shortcut created:', desktopShortcutPath);
        console.log('Start menu shortcut created:', startMenuShortcutPath);
        return { success: true, path: desktopShortcutPath, startMenuPath: startMenuShortcutPath };
    } catch (e) {
        console.error('Failed to create app shortcuts:', e.message);
        return { success: false, error: e.message };
    }
});

// ========================================
// .fvp File Association (Windows)
// ========================================
// Registers .fvp files to open with this app (HKCU — no admin needed)
function registerFvpFileAssociation() {
    if (process.platform !== 'win32') return { success: false, error: 'Only supported on Windows' };

    try {
        const electronExe = process.execPath; // Full path to electron.exe
        const appDir = APP_ROOT;
        // Icon: use custom .ico if available, otherwise electron.exe
        const iconValue = getShortcutIconPath();

        // Write a .reg file and import it (most reliable way to handle Windows registry quoting)
        // In .reg files: backslash = \\, inner quotes = \"
        const regEsc = (p) => p.replace(/\\/g, '\\\\');
        const regQ = (p) => `\\\"${regEsc(p)}\\\"`;  // Quoted path for .reg value
        const openCmd = `${regQ(electronExe)} ${regQ(appDir)} \\\"%1\\\"`;
        const regContent = [
            'Windows Registry Editor Version 5.00',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\.fvp]',
            '@="FacelessVideoProject"',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject]',
            '@="Forge Project"',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject\\DefaultIcon]',
            `@="${regEsc(iconValue)}"`,
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject\\shell\\open\\command]',
            `@="${openCmd}"`,
            ''
        ].join('\r\n');

        const regFile = path.join(APP_ROOT, 'temp', 'fvp-association.reg');
        if (!fs.existsSync(path.dirname(regFile))) fs.mkdirSync(path.dirname(regFile), { recursive: true });
        // .reg files need UTF-16LE BOM to import correctly
        const bom = Buffer.from([0xFF, 0xFE]);
        const content = Buffer.from(regContent, 'utf16le');
        fs.writeFileSync(regFile, Buffer.concat([bom, content]));
        execSync(`reg import "${regFile}"`, { stdio: 'ignore' });
        try { fs.unlinkSync(regFile); } catch (_) { } // Clean up

        console.log('✅ .fvp file association registered');
        return { success: true };
    } catch (e) {
        console.error('❌ Failed to register .fvp file association:', e.message);
        return { success: false, error: e.message };
    }
}

ipcMain.handle('register-fvp-association', async () => {
    return registerFvpFileAssociation();
});

// ========================================
// Helper Functions
// ========================================

// Brain switch: the AI Provider dropdown value maps onto AI_PROVIDER +
// AILINK_TASK_TYPES. process.env is updated LIVE (render-prep authoring in
// this process + child builds inherit it); .env persists across restarts.
function applyBrainProvider(value) {
    const ailinkBrain = value === 'bedrock-ailink';
    const aplinkBrain = value === 'bedrock-aplink';
    const azureBrain = value === 'bedrock-azure';
    const azureOpenAIBrain = value === 'bedrock-azure-grok' || value === 'bedrock-azure-openai';
    // The ONE option that runs both Azure surfaces at once (see azureThinkingTier below).
    const azureSplitBrain = value === 'azure-split';
    // Azure Managed Compute — replaces Bedrock entirely with a single endpoint + two models.
    const azureManagedBrain = value === 'azure-managed';
    const base = azureManagedBrain ? 'azure-managed'
        : (ailinkBrain || aplinkBrain || azureBrain || azureOpenAIBrain || azureSplitBrain) ? 'bedrock' : String(value || 'bedrock');

    // An alt brain (AiLink GPT-5.5 / APlink Claude-Opus-4-6 / Azure Claude Sonnet / Azure Grok)
    // takes over EXACTLY the
    // Bedrock "Sonnet tier" — the high-reasoning editorial tasks (Visual Planner,
    // Director scene-split, effects/icon/transition directors). The DeepSeek default
    // tier and Haiku utility tier ALWAYS stay on Bedrock, and Bedrock stays the
    // automatic fallback for the alt-routed tasks. Only ONE alt brain runs at a time.
    let sonnetTier = 'brain,planner-outline,planner-large,planner-small';
    let defaultTier = 'bedrock default';
    let plannerTier = 'bedrock planner';
    let utilityTier = 'bedrock utility';
    let fallbackTier = 'bedrock fallback';
    let ailinkModel = 'gpt-5.5';
    let aplinkModel = 'claude-opus-4-6';
    let azureModel = 'claude-sonnet-4-6';
    let azureOpenAIModel = 'grok-4.3';
    let amBrainModel = 'deepreinforce-ai--ornith-10-397b';
    let amDefaultModel = 'qwen--qwen38-27b';
    let hasAplinkKey = false;
    try {
        const cfg = require('./src/settings/config');
        const tier = cfg?.bedrock?.plannerTaskTypes;
        if (Array.isArray(tier) && tier.length) sonnetTier = tier.join(',');
        if (cfg?.bedrock?.model) defaultTier = `bedrock:${cfg.bedrock.model}`;
        if (cfg?.bedrock?.plannerModel) plannerTier = `bedrock:${cfg.bedrock.plannerModel}`;
        if (cfg?.bedrock?.utilityModel) utilityTier = `bedrock:${cfg.bedrock.utilityModel}`;
        if (cfg?.bedrock?.fallbackModel) fallbackTier = `bedrock:${cfg.bedrock.fallbackModel}`;
        if (cfg?.ailink?.model) ailinkModel = cfg.ailink.model;
        if (cfg?.aplink?.model) aplinkModel = cfg.aplink.model;
        hasAplinkKey = !!cfg?.aplink?.apiKey;
        if (cfg?.azure?.model) azureModel = cfg.azure.model;
        if (cfg?.azureOpenAI?.model) azureOpenAIModel = cfg.azureOpenAI.model;
        if (cfg?.azureManaged?.brainModel) amBrainModel = cfg.azureManaged.brainModel;
        if (cfg?.azureManaged?.defaultModel) amDefaultModel = cfg.azureManaged.defaultModel;
    } catch (_) {}

    // A gate already widened to `all` means the operator put the WHOLE text surface on
    // that brain (Bedrock unavailable), so re-picking it in the dropdown must not narrow
    // it back to the Sonnet tier and drop the other 6 task types onto Bedrock.
    const tierFor = (cur) => (/^(all|\*)$/i.test(String(cur || '').trim()) ? 'all' : sonnetTier);

    // The split brain is the exception to "only ONE alt brain at a time": it runs BOTH
    // Azure surfaces simultaneously, cut by cost rather than by tier. The reasoning tasks
    // go to the Claude deployment (AZURE_CLAUDE_MODEL, an Opus) and the cheap high-volume
    // ones to the OpenAI-compatible deployment (AZURE_OPENAI_MODEL). Both gates therefore
    // have to be written together — clearing one, as every other option does, would strand
    // its half of the surface on Bedrock.
    const azureThinkingTier = 'brain,planner-outline,planner-large,planner-small,planner-source-audit,review';
    const azureRestTier = 'classifier,general,motion-graphics,template,utility';
    const azureGate = azureSplitBrain ? azureThinkingTier
        : azureBrain ? tierFor(process.env.AZURE_TASK_TYPES)
        : '';
    const azureOpenAIGate = azureSplitBrain ? azureRestTier
        : azureOpenAIBrain ? tierFor(process.env.AZURE_OPENAI_TASK_TYPES)
        : '';

    updateEnvFile('AI_PROVIDER', base);
    // Set the chosen alt brain's task gate; clear the other so only one is active.
    updateEnvFile('AILINK_TASK_TYPES', ailinkBrain ? tierFor(process.env.AILINK_TASK_TYPES) : '');
    updateEnvFile('APLINK_TASK_TYPES', aplinkBrain ? tierFor(process.env.APLINK_TASK_TYPES) : '');
    updateEnvFile('AZURE_TASK_TYPES', azureGate);
    updateEnvFile('AZURE_OPENAI_TASK_TYPES', azureOpenAIGate);
    // Azure Managed replaces Bedrock entirely — clear all hybrid gates.
    updateEnvFile('AILINK_TASK_TYPES', azureManagedBrain ? '' : (ailinkBrain ? tierFor(process.env.AILINK_TASK_TYPES) : ''));
    updateEnvFile('APLINK_TASK_TYPES', azureManagedBrain ? '' : (aplinkBrain ? tierFor(process.env.APLINK_TASK_TYPES) : ''));
    updateEnvFile('AZURE_TASK_TYPES', azureManagedBrain ? '' : azureGate);
    updateEnvFile('AZURE_OPENAI_TASK_TYPES', azureManagedBrain ? '' : azureOpenAIGate);
    process.env.AI_PROVIDER = base;
    process.env.AILINK_TASK_TYPES = azureManagedBrain ? '' : (ailinkBrain ? tierFor(process.env.AILINK_TASK_TYPES) : '');
    process.env.APLINK_TASK_TYPES = azureManagedBrain ? '' : (aplinkBrain ? tierFor(process.env.APLINK_TASK_TYPES) : '');
    process.env.AZURE_TASK_TYPES = azureManagedBrain ? '' : azureGate;
    process.env.AZURE_OPENAI_TASK_TYPES = azureManagedBrain ? '' : azureOpenAIGate;

    const sonnetOwner = azureManagedBrain ? `azure-managed:${amBrainModel}(brain) + ${amDefaultModel}(default/vision)`
        : ailinkBrain ? `ailink:${ailinkModel}`
        : aplinkBrain ? `aplink:${aplinkModel}`
        : azureSplitBrain ? `azure-claude:${azureModel} (thinking) + azure-openai:${azureOpenAIModel} (rest)`
        : azureBrain ? `azure-claude:${azureModel}`
        : azureOpenAIBrain ? `azure-openai:${azureOpenAIModel}`
        : plannerTier;
    console.log(`[Brain Router] dropdown=${value || 'bedrock'} base=${base} sonnetTier=${sonnetOwner} tasks=[${azureSplitBrain ? azureThinkingTier : (azureManagedBrain ? 'azure-managed(all)' : sonnetTier)}]`);
    console.log(`[Brain Router] default=${defaultTier}; utility=${utilityTier}; fallback=${fallbackTier}; AILINK=${ailinkBrain ? sonnetTier : '(off)'}; APLINK=${aplinkBrain ? sonnetTier : '(off)'}; AZURE_CLAUDE=${azureGate || '(off)'}; AZURE_OPENAI=${azureOpenAIGate || '(off)'}; AZURE_MANAGED=${azureManagedBrain ? `${amBrainModel}+${amDefaultModel}` : '(off)'}`);
    if ((azureBrain || azureOpenAIBrain || azureSplitBrain) && hasAplinkKey && !/^(0|false|off|no)$/i.test(String(process.env.AZURE_LARGE_PROMPT_APLINK || 'on').trim())) {
        console.log(`[Brain Router] azure-large-detour=aplink:${aplinkModel} tasks=[${process.env.AZURE_LARGE_PROMPT_APLINK_TASKS || 'planner-large'}] fallback=${plannerTier}`);
    }
}

ipcMain.handle('set-ai-provider', (event, value) => {
    try { applyBrainProvider(value); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
});

function updateEnvFile(key, value) {
    updateEnvFileAt(path.join(PROJECT_DIR, '.env'), key, value);
}

function updateEnvFileAt(envPath, key, value) {
    try {
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        const regex = new RegExp(`^${key}=.*$`, 'm');

        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }

        fs.writeFileSync(envPath, envContent.trim() + '\n');
        console.log(`✅ Updated ${key} in ${path.basename(path.dirname(envPath))}/.env`);
    } catch (error) {
        console.error('Failed to update .env:', error);
    }
}



// ========================================
// QA Studio — Separate Window
// ========================================
let qaStudioWindow = null;

ipcMain.handle('open-qa-studio', async (event, options) => {
    const openChat = options?.openChat || false;
    const htmlFile = path.join(__dirname, 'ui', 'qa-studio.html');
    const query = openChat ? '?chat=1' : '';

    // Re-open: reload the page so it re-reads the latest video-plan.json from disk
    if (qaStudioWindow && !qaStudioWindow.isDestroyed()) {
        qaStudioWindow.loadFile(htmlFile, { query: openChat ? 'chat=1' : '' });
        qaStudioWindow.focus();
        return;
    }
    qaStudioWindow = new BrowserWindow({
        width: 1300,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0a0a0a',
        title: 'QA Studio',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: ['--yta-window-role=qa-studio'],
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    hardenRendererWindow(qaStudioWindow, 'qa-studio');
    qaStudioWindow.loadFile(htmlFile, { query: openChat ? 'chat=1' : '' });
    qaStudioWindow.on('closed', () => { qaStudioWindow = null; });
});

// Agent Chat button → opens QA Studio with chat panel expanded (no separate window)
ipcMain.handle('open-qa-chat', async () => {
    // Redirect to QA Studio with chat auto-opened
    if (qaStudioWindow && !qaStudioWindow.isDestroyed()) {
        // QA Studio already open — just tell it to open chat
        qaStudioWindow.webContents.executeJavaScript(
            `document.getElementById('chat-panel')?.classList.add('open'); document.getElementById('btn-chat-toggle')?.click?.();`
        ).catch(() => {});
        qaStudioWindow.focus();
        return;
    }
    // QA Studio not open — open it with chat=1
    ipcMain.emit('handle-open-qa-studio');
    // Use the handler directly
    const htmlFile = path.join(__dirname, 'ui', 'qa-studio.html');
    qaStudioWindow = new BrowserWindow({
        width: 1300,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0a0a0a',
        title: 'QA Studio',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: ['--yta-window-role=qa-studio'],
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    hardenRendererWindow(qaStudioWindow, 'qa-studio');
    qaStudioWindow.loadFile(htmlFile, { query: 'chat=1' });
    qaStudioWindow.on('closed', () => { qaStudioWindow = null; });
});

// ========================================
// Style Studio — Separate Window
// ========================================
let styleStudioWindow = null;

ipcMain.handle('open-style-studio', async () => {
    const htmlFile = path.join(__dirname, 'ui', 'style-studio.html');

    if (styleStudioWindow && !styleStudioWindow.isDestroyed()) {
        styleStudioWindow.focus();
        return;
    }
    styleStudioWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#0a0a0a',
        title: 'Learner',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: ['--yta-window-role=style-studio'],
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    hardenRendererWindow(styleStudioWindow, 'style-studio');
    styleStudioWindow.loadFile(htmlFile);
    styleStudioWindow.on('closed', () => { styleStudioWindow = null; });
});

// ========================================
// AI Connections (where each AI job runs)
// ========================================
// The data-driven replacement for hand-wiring providers: a connection is an
// address + key + model name on any OpenAI-compatible server (a vLLM on Modal,
// DigitalOcean, AWS…, Azure AI Foundry, OpenRouter, Meta, Ollama), and each job
// — Thinking, Everyday, Eyes — points at one, or at the built-in setup.
// Stored in <userData>/ai-connections.json with keys encrypted by the OS; the
// renderer only ever learns "has a key: yes/no". See src/brain/connections.js.
const aiConnections = require('./src/brain/connections');
const connectionTransport = require('./src/brain/connection-transport');
const { createAiConnectionsStore } = require('./src/settings/ai-connections-store');

let _aiConnectionsStore = null;

function _aiConnStore() {
    if (!_aiConnectionsStore) {
        const { safeStorage } = require('electron');
        _aiConnectionsStore = createAiConnectionsStore({
            userDataDir: USER_DATA_DIR,
            crypto: {
                available: () => {
                    try { return app.isReady() && safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
                },
                encrypt: (text) => safeStorage.encryptString(String(text)).toString('base64'),
                decrypt: (data) => safeStorage.decryptString(Buffer.from(String(data), 'base64')),
            },
        });
    }
    return _aiConnectionsStore;
}

// Push the current setup into this process's own AI calls (editor agent, QA,
// scene actions…). Builds get the same object through their environment.
function _applyAiConnections() {
    try {
        aiConnections.setRuntime(_aiConnStore().resolved());
        console.log(`🔌 AI jobs — ${aiConnections.describeRuntime()}`);
    } catch (error) {
        console.warn(`[AI Connections] could not load: ${error.message}`);
    }
}

function _aiConnectionsRuntimeJson() {
    try {
        return JSON.stringify(_aiConnStore().resolved());
    } catch (_) {
        return '';
    }
}

ipcMain.handle('ai-connections-get', async () => _aiConnStore().publicView());

ipcMain.handle('ai-connections-save', async (_event, payload = {}) => {
    const safe = _boundedPlainObject(payload, 64 * 1024);
    const store = _aiConnStore();
    let result;
    if (safe.action === 'delete') {
        result = store.deleteConnection(String(safe.id || ''));
        connectionTransport.forgetDialect(String(safe.id || ''));
    } else if (safe.action === 'jobs') {
        result = store.setJobs(safe.jobs || {});
    } else {
        result = store.saveConnection(safe.connection || {});
        if (result.ok) connectionTransport.forgetDialect(result.id);
    }
    if (result.ok) _applyAiConnections();
    return { ...result, view: store.publicView() };
});

ipcMain.handle('ai-connections-test', async (_event, payload = {}) => {
    const safe = _boundedPlainObject(payload, 64 * 1024);
    const store = _aiConnStore();
    const { conn, problems, existingId } = store.draftForTest(safe.connection || {});
    if (problems.length) return { ok: false, problems, view: store.publicView() };
    const result = await connectionTransport.testConnection(conn);
    // Only a test of what is actually saved may update what is saved.
    const saved = existingId ? store.load().connections.find((c) => c.id === existingId) : null;
    if (saved && saved.baseUrl === conn.baseUrl && saved.textModel === conn.textModel && saved.visionModel === conn.visionModel) {
        store.recordTest(existingId, result);
        _applyAiConnections();
    }
    return { ok: true, result, view: store.publicView() };
});

// ========================================
// Agent Remote Control (MCP + REST)
// ========================================
// Lets an outside agent — Claude Code, Meta Muse, ChatGPT, n8n, a shell script —
// drive THIS app: open a project, import narration, change settings, build,
// render, read the log, fetch the finished file. OFF until the user turns it on
// (AI settings > Agent access) and every call needs the generated access key.
//
// Anything a human would click is forwarded to the window (ui/js/remote-control.js)
// and runs through the same functions as the buttons, so there is no agent-only
// build path to keep in sync. The transport lives in src/remote/.
const remoteAccessConfig = require('./src/remote/access-config');
const { createControlService } = require('./src/remote/control-service');
const { createRemoteServer } = require('./src/remote/server');
const { SERVER_INSTRUCTIONS: REMOTE_INSTRUCTIONS } = require('./src/remote/tools');

const REMOTE_DOWNLOAD_TYPES = Object.freeze({
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.srt': 'application/x-subrip',
});

let _remoteConfig = null;
let _remoteServer = null;
let _remoteStartError = '';
let _remoteRequestSeq = 0;
const _remoteRendererCalls = new Map();

function _remoteAccess() {
    if (!_remoteConfig) _remoteConfig = remoteAccessConfig.load(USER_DATA_DIR);
    return _remoteConfig;
}

// Ask the main window to do something and wait for its answer. The window owns
// the build/render/settings surface, so this is how every user-facing action is
// reached without duplicating it in the main process.
function _askRendererCommand(command, args = {}, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            reject(new Error('the Forge window is closed'));
            return;
        }
        const requestId = `rc-${Date.now().toString(36)}-${++_remoteRequestSeq}`;
        const timer = setTimeout(() => {
            _remoteRendererCalls.delete(requestId);
            reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        _remoteRendererCalls.set(requestId, { resolve, reject, timer });
        try {
            mainWindow.webContents.send('remote-command', { requestId, command, args });
        } catch (error) {
            clearTimeout(timer);
            _remoteRendererCalls.delete(requestId);
            reject(error);
        }
    });
}

ipcMain.handle('remote-command-result', async (event, payload = {}) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
        return { success: false };
    }
    const pending = _remoteRendererCalls.get(String(payload.requestId || ''));
    if (!pending) return { success: false };
    _remoteRendererCalls.delete(String(payload.requestId));
    clearTimeout(pending.timer);
    if (payload.error) {
        pending.reject(new Error(String(payload.error).slice(0, 500)));
    } else {
        try {
            pending.resolve(_boundedPlainObject(payload.result ?? {}, 2 * 1024 * 1024));
        } catch (error) {
            pending.reject(error);
        }
    }
    return { success: true };
});

function _listRecentProjects() {
    try {
        if (!fs.existsSync(RECENT_PROJECTS_FILE)) return [];
        const recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, 'utf8'));
        if (!Array.isArray(recent)) return [];
        const validRecent = recent.filter((entry) => (
            typeof entry?.path === 'string'
            && !_pathsEqual(entry.path, DEFAULT_WORKSPACE_DIR)
            && projectStore.inspectProjectDirectory({ projectDir: entry.path }).valid
        ));
        if (validRecent.length !== recent.length) {
            projectStore.atomicWriteJson(RECENT_PROJECTS_FILE, validRecent);
        }
        return validRecent;
    } catch (_) {
        return [];
    }
}

function _remoteDefaultProjectParent() {
    const recent = _listRecentProjects();
    for (const entry of recent) {
        const parent = path.dirname(entry.path);
        if (parent && fs.existsSync(parent) && fs.statSync(parent).isDirectory()) return parent;
    }
    return app.getPath('documents');
}

async function _remoteCreateProject({ name, parentFolder }) {
    const parent = parentFolder ? path.resolve(parentFolder) : _remoteDefaultProjectParent();
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        return { success: false, error: `Folder not found: ${parent}` };
    }
    const prepared = _prepareNewProjectTarget({
        location: parent,
        projectName: name,
        locationMode: 'create-subfolder',
    });
    if (!prepared.success) return prepared;
    const opened = await _switchProjectInPlace(prepared.projectDir, {
        projectFile: prepared.projectFile,
        reloadRenderer: true,
    });
    if (!opened.success) return opened;
    return { ...opened, projectName: prepared.projectName || name };
}

function _remoteReadBuildLog(lines) {
    try {
        const logsDir = getLogsDir(PROJECT_DIR);
        if (!fs.existsSync(logsDir)) return null;
        const candidates = fs.readdirSync(logsDir)
            .filter((file) => /^build-summary-.*\.log$/i.test(file))
            .map((file) => {
                const full = path.join(logsDir, file);
                return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
        if (!candidates.length) return null;
        const newest = candidates[0];
        const size = fs.statSync(newest.full).size;
        const readFrom = Math.max(0, size - 512 * 1024);
        const handle = fs.openSync(newest.full, 'r');
        const buffer = Buffer.alloc(size - readFrom);
        try {
            fs.readSync(handle, buffer, 0, buffer.length, readFrom);
        } finally {
            fs.closeSync(handle);
        }
        const all = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.length);
        return {
            file: newest.full,
            updatedAt: new Date(newest.mtime).toISOString(),
            lines: all.slice(-Math.max(1, Math.min(500, Number(lines) || 80))),
        };
    } catch (_) {
        return null;
    }
}

function _remoteListVideos() {
    try {
        if (!fs.existsSync(OUTPUT_PATH)) return [];
        return fs.readdirSync(OUTPUT_PATH)
            .filter((file) => Object.prototype.hasOwnProperty.call(REMOTE_DOWNLOAD_TYPES, path.extname(file).toLowerCase()))
            .map((file) => {
                const full = path.join(OUTPUT_PATH, file);
                const stat = fs.statSync(full);
                return {
                    name: file,
                    bytes: stat.size,
                    megabytes: Math.round((stat.size / (1024 * 1024)) * 10) / 10,
                    modifiedAt: new Date(stat.mtimeMs).toISOString(),
                    path: full,
                    downloadPath: `/files/${encodeURIComponent(file)}`,
                    _mtime: stat.mtimeMs,
                };
            })
            .sort((a, b) => b._mtime - a._mtime)
            .map(({ _mtime, ...video }) => video);
    } catch (_) {
        return [];
    }
}

// Downloads are confined to the active project's output/ folder, by real path,
// with a fixed media allowlist — the same posture as the asset:// protocol.
function _remoteResolveDownload(name) {
    const safeName = path.basename(String(name || ''));
    if (!safeName || safeName !== String(name || '')) return null;
    const contentType = REMOTE_DOWNLOAD_TYPES[path.extname(safeName).toLowerCase()];
    if (!contentType) return null;
    const resolved = _resolveExistingFileWithin([OUTPUT_PATH], path.join(OUTPUT_PATH, safeName));
    if (!resolved) return null;
    return { filePath: resolved, fileName: safeName, size: fs.statSync(resolved).size, contentType };
}

async function _remoteImportNarrationFromUrl(rawUrl) {
    const { requestSafeStream, writeSafeStreamToFile } = require('./src/security/safe-download');
    let tempFile = null;
    try {
        const response = await requestSafeStream(
            rawUrl,
            { timeout: 120000, headers: { 'User-Agent': 'Forge/1.0 (+narration import)' } },
            { maxBytes: 1024 * 1024 * 1024 }
        );
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        const urlExt = path.extname(new URL(response.safeDownload.finalUrl).pathname).toLowerCase();
        let ext = ['.mp3', '.wav'].includes(urlExt) ? urlExt : '';
        if (!ext && /audio\/(mpeg|mp3)/.test(contentType)) ext = '.mp3';
        if (!ext && /audio\/(wav|x-wav|wave|vnd\.wave)/.test(contentType)) ext = '.wav';
        if (!ext) {
            response.data.destroy();
            return { success: false, error: 'That link is not an MP3 or WAV file.' };
        }
        const tempDir = path.join(PROJECT_DIR, 'temp');
        fs.mkdirSync(tempDir, { recursive: true });
        tempFile = path.join(tempDir, `narration-download-${Date.now()}${ext}`);
        await writeSafeStreamToFile(response, tempFile, { maxBytes: 1024 * 1024 * 1024 });
        const imported = await _importNarrationFile(tempFile);
        if (!imported.success) return imported;
        // input/ keeps the downloaded name; the temp copy is no longer needed.
        return { ...imported, name: path.basename(imported.path) };
    } catch (error) {
        return { success: false, error: `Download failed: ${error.message}` };
    } finally {
        if (tempFile) { try { fs.unlinkSync(tempFile); } catch (_) { } }
    }
}

function _remoteServiceDeps() {
    return {
        getProject: () => ({
            dir: PROJECT_DIR,
            name: PROJECT_NAME,
            projectFile: getProjectFilePath(),
            isDefaultWorkspace: _pathsEqual(PROJECT_DIR, DEFAULT_WORKSPACE_DIR),
        }),
        getBusy: () => {
            if (activeProcess) return activeProcessType || 'job';
            if (_webglExport) return 'render';
            return null;
        },
        askRenderer: (command, args, options) => _askRendererCommand(command, args, options),
        listRecentProjects: async () => _listRecentProjects(),
        openProject: async (projectDir) => _switchProjectInPlace(projectDir, { reloadRenderer: true }),
        createProject: async (options) => _remoteCreateProject(options),
        importNarrationFromPath: async (sourcePath) => _importNarrationFile(sourcePath),
        importNarrationFromUrl: async (url) => _remoteImportNarrationFromUrl(url),
        readBuildLog: async (lines) => _remoteReadBuildLog(lines),
        listVideos: async () => _remoteListVideos(),
        getServerInfo: () => ({
            host: _remoteServer ? _remoteServer.host : _remoteAccess().host,
            port: _remoteServer ? _remoteServer.port : _remoteAccess().port,
            enabled: !!_remoteAccess().enabled,
        }),
    };
}

async function _startRemoteControlServer() {
    const config = _remoteAccess();
    _remoteStartError = '';
    if (!config.enabled) return { running: false };
    if (_remoteServer) return { running: true, port: _remoteServer.port };
    if (_isProjectChildInstance) {
        _remoteStartError = 'Agent access runs in the first Forge window only.';
        return { running: false, error: _remoteStartError };
    }
    const service = createControlService(_remoteServiceDeps());
    const server = createRemoteServer({
        host: config.host,
        port: config.port,
        token: config.token,
        callTool: service.callTool,
        resolveDownload: (name) => _remoteResolveDownload(name),
        serverInfo: { name: 'forge', version: app.getVersion() },
        instructions: REMOTE_INSTRUCTIONS,
        log: (line) => console.log(line),
    });
    try {
        const info = await server.start();
        _remoteServer = server;
        console.log(`🔌 Agent access listening on http://${info.host}:${info.port} (MCP: /mcp, API: /api/tools)`);
        return { running: true, port: info.port };
    } catch (error) {
        _remoteStartError = error.code === 'EADDRINUSE'
            ? `Port ${config.port} is already in use — pick another port.`
            : error.message;
        console.warn(`[Remote] could not start agent access: ${_remoteStartError}`);
        return { running: false, error: _remoteStartError };
    }
}

async function _stopRemoteControlServer() {
    if (!_remoteServer) return;
    const server = _remoteServer;
    _remoteServer = null;
    try {
        await server.stop();
        console.log('🔌 Agent access stopped');
    } catch (_) { /* shutting down anyway */ }
    for (const [, pending] of _remoteRendererCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error('agent access stopped'));
    }
    _remoteRendererCalls.clear();
}

function _remoteAccessStatus() {
    const config = _remoteAccess();
    const port = _remoteServer ? _remoteServer.port : config.port;
    const baseUrl = `http://${config.host}:${port}`;
    return {
        enabled: !!config.enabled,
        running: !!_remoteServer,
        host: config.host,
        port,
        token: config.token,
        baseUrl,
        mcpUrl: `${baseUrl}/mcp`,
        apiUrl: `${baseUrl}/api/tools`,
        openApiUrl: `${baseUrl}/openapi.json`,
        forcedByEnv: !!config.forcedByEnv,
        error: _remoteStartError || '',
    };
}

ipcMain.handle('remote-access-status', async () => _remoteAccessStatus());

ipcMain.handle('remote-access-set', async (_event, payload = {}) => {
    const config = _remoteAccess();
    if (typeof payload.enabled === 'boolean') config.enabled = payload.enabled;
    if (payload.rotateToken === true) config.token = remoteAccessConfig.generateToken();
    if (payload.port !== undefined) {
        const port = Number(payload.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return { success: false, error: 'Choose a port between 1024 and 65535.', status: _remoteAccessStatus() };
        }
        config.port = port;
    }
    remoteAccessConfig.save(USER_DATA_DIR, config);
    await _stopRemoteControlServer();
    if (config.enabled) await _startRemoteControlServer();
    else _remoteStartError = '';
    const status = _remoteAccessStatus();
    return { success: !status.error, error: status.error || '', status };
});

// ========================================
// Error Handling
// ========================================
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    // Log more detail — plain objects serialize as {} with console.error
    if (reason instanceof Error) {
        console.error('Unhandled Rejection:', reason.message, reason.stack);
    } else if (reason && typeof reason === 'object') {
        console.error('Unhandled Rejection (object):', JSON.stringify(reason, null, 2));
    } else {
        console.error('Unhandled Rejection:', reason);
    }
});
