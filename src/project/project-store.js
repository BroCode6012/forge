'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const timelineContract = require('./timeline-contract');

const PROJECT_FILE_VERSION = 2;
const PROJECT_MARKER_FILE = '.yta-project.json';
const PROJECT_MARKER_TYPE = 'yta-empire-webgl-project';
const PROJECT_MARKER_VERSION = 1;

function _isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function _isVideoPlanShape(plan) {
    if (!_isObject(plan) || !Array.isArray(plan.scenes)) return false;

    const hasDuration = Number.isFinite(Number(plan.totalDuration)) && Number(plan.totalDuration) >= 0;
    const hasFps = Number.isFinite(Number(plan.fps)) && Number(plan.fps) > 0;
    const hasKnownCollections = [
        'mgScenes',
        'motionGraphics',
        'overlayScenes',
        'sfxClips',
        'templateScenes',
        'transitions',
    ].some((key) => Array.isArray(plan[key]));
    const hasKnownContext = _isObject(plan.scriptContext)
        || typeof plan.audioFile === 'string'
        || typeof plan.audioPath === 'string';
    const hasSceneShape = plan.scenes.some((scene) => (
        _isObject(scene)
        && (
            Number.isFinite(Number(scene.startTime))
            || Number.isFinite(Number(scene.endTime))
            || typeof scene.text === 'string'
            || typeof scene.mediaFile === 'string'
        )
    ));

    return hasDuration || hasFps || hasKnownCollections || hasKnownContext || hasSceneShape;
}

function _isProjectEnvelopeShape(value) {
    return _isObject(value) && _isVideoPlanShape(value.videoPlan);
}

function _isProjectMarkerShape(value) {
    return _isObject(value)
        && value.type === PROJECT_MARKER_TYPE
        && Number.isInteger(Number(value.version))
        && Number(value.version) >= 1;
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

function _pathsEqual(leftPath, rightPath) {
    const left = path.resolve(leftPath);
    const right = path.resolve(rightPath);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

function _expectedFvpPath(projectDir) {
    const name = path.basename(path.resolve(projectDir)) || 'project';
    return path.join(projectDir, `${name}.fvp`);
}

function resolveProjectFilePath({ projectDir, preferredFvpPath } = {}) {
    const root = path.resolve(projectDir);
    if (preferredFvpPath) {
        const preferred = path.resolve(preferredFvpPath);
        if (!_isPathWithin(root, preferred)) {
            throw new Error(`Project file must stay inside the project directory: ${preferred}`);
        }
        if (fs.existsSync(preferred) && fs.statSync(preferred).isFile()) return preferred;
    }

    const expected = _expectedFvpPath(root);
    if (fs.existsSync(expected) && fs.statSync(expected).isFile()) return expected;

    if (fs.existsSync(root)) {
        const candidates = fs.readdirSync(root)
            .filter((name) => name.toLowerCase().endsWith('.fvp'))
            .map((name) => {
                const filePath = path.join(root, name);
                try {
                    const stat = fs.statSync(filePath);
                    return stat.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : null;
                } catch (_) {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
        if (candidates.length) return candidates[0].filePath;
    }

    return preferredFvpPath
        ? path.resolve(preferredFvpPath)
        : expected;
}

function _readJson(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return null;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { filePath, data, mtimeMs: stat.mtimeMs, error: null };
    } catch (error) {
        return { filePath, data: null, mtimeMs: 0, error };
    }
}

function validateProjectFile({ filePath, projectDir } = {}) {
    if (!filePath) {
        return { valid: false, code: 'PROJECT_FILE_MISSING', error: 'No .fvp project file was selected.' };
    }

    const resolvedFile = path.resolve(String(filePath));
    const root = projectDir ? path.resolve(String(projectDir)) : path.dirname(resolvedFile);
    if (path.extname(resolvedFile).toLowerCase() !== '.fvp') {
        return {
            valid: false,
            code: 'PROJECT_FILE_EXTENSION',
            error: 'The selected file is not a .fvp project file.',
            filePath: resolvedFile,
        };
    }
    if (!_isPathWithin(root, resolvedFile) || !_pathsEqual(path.dirname(resolvedFile), root)) {
        return {
            valid: false,
            code: 'PROJECT_FILE_OUTSIDE_ROOT',
            error: 'The selected .fvp file must be in the project folder.',
            filePath: resolvedFile,
        };
    }
    if (!fs.existsSync(resolvedFile)) {
        return {
            valid: false,
            code: 'PROJECT_FILE_NOT_FOUND',
            error: 'The selected .fvp project file does not exist.',
            filePath: resolvedFile,
        };
    }

    const read = _readJson(resolvedFile);
    if (read?.error || !read?.data) {
        return {
            valid: false,
            code: 'PROJECT_FILE_CORRUPT',
            error: `The selected .fvp file could not be read: ${read?.error?.message || 'invalid JSON'}`,
            filePath: resolvedFile,
        };
    }

    if (_isProjectEnvelopeShape(read.data)) {
        return {
            valid: true,
            filePath: resolvedFile,
            projectDir: root,
            envelope: read.data,
            videoPlan: read.data.videoPlan,
            legacyDirectPlan: false,
        };
    }
    if (_isVideoPlanShape(read.data)) {
        return {
            valid: true,
            filePath: resolvedFile,
            projectDir: root,
            envelope: null,
            videoPlan: read.data,
            legacyDirectPlan: true,
        };
    }

    return {
        valid: false,
        code: 'PROJECT_FILE_SHAPE',
        error: 'The selected .fvp file is not a valid YTA Empire project file.',
        filePath: resolvedFile,
    };
}

function inspectProjectDirectory({ projectDir, preferredFvpPath } = {}) {
    if (!projectDir) {
        return {
            valid: false,
            code: 'PROJECT_DIRECTORY_MISSING',
            error: 'No project folder was selected.',
        };
    }

    const root = path.resolve(String(projectDir));
    try {
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            return {
                valid: false,
                code: 'PROJECT_DIRECTORY_NOT_FOUND',
                error: 'The selected project folder does not exist.',
                projectDir: root,
            };
        }
    } catch (error) {
        return {
            valid: false,
            code: 'PROJECT_DIRECTORY_UNREADABLE',
            error: `The selected project folder could not be read: ${error.message}`,
            projectDir: root,
        };
    }

    if (preferredFvpPath) {
        const preferred = validateProjectFile({
            filePath: preferredFvpPath,
            projectDir: root,
        });
        if (!preferred.valid) {
            return {
                ...preferred,
                projectDir: root,
            };
        }
    }

    const markerPath = path.join(root, PROJECT_MARKER_FILE);
    const markerRead = fs.existsSync(markerPath) ? _readJson(markerPath) : null;
    const marker = markerRead?.data;
    const markerValid = !markerRead?.error && _isProjectMarkerShape(marker);

    const fvpCandidates = [];
    const seenFvpPaths = new Set();
    const addFvpCandidate = (candidate) => {
        if (!candidate) return;
        const resolved = path.resolve(candidate);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seenFvpPaths.has(key)) return;
        seenFvpPaths.add(key);
        fvpCandidates.push(resolved);
    };

    if (preferredFvpPath) addFvpCandidate(preferredFvpPath);
    if (markerValid && typeof marker.projectFile === 'string' && marker.projectFile) {
        const markerFileName = path.basename(marker.projectFile);
        if (markerFileName === marker.projectFile && /\.fvp$/i.test(markerFileName)) {
            addFvpCandidate(path.join(root, markerFileName));
        }
    }
    addFvpCandidate(_expectedFvpPath(root));

    let rootEntries = [];
    try {
        rootEntries = fs.readdirSync(root, { withFileTypes: true });
        rootEntries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.fvp'))
            .map((entry) => {
                const filePath = path.join(root, entry.name);
                let mtimeMs = 0;
                try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) { }
                return { filePath, mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
            .forEach(({ filePath }) => addFvpCandidate(filePath));
    } catch (error) {
        return {
            valid: false,
            code: 'PROJECT_DIRECTORY_UNREADABLE',
            error: `The selected project folder could not be inspected: ${error.message}`,
            projectDir: root,
        };
    }

    let validProjectFile = null;
    let invalidFvpCount = 0;
    for (const candidate of fvpCandidates) {
        if (!fs.existsSync(candidate)) continue;
        const checked = validateProjectFile({ filePath: candidate, projectDir: root });
        if (checked.valid) {
            validProjectFile = checked;
            break;
        }
        invalidFvpCount += 1;
    }

    let planEvidence = null;
    for (const relativePath of [
        path.join('public', 'video-plan.json'),
        path.join('temp', 'video-plan.json'),
    ]) {
        const planPath = path.join(root, relativePath);
        if (!fs.existsSync(planPath)) continue;
        const read = _readJson(planPath);
        if (!read?.error && _isVideoPlanShape(read?.data)) {
            planEvidence = { filePath: planPath, videoPlan: read.data };
            break;
        }
    }

    const valid = markerValid || Boolean(validProjectFile) || Boolean(planEvidence);
    if (!valid) {
        let error = 'This folder is not a YTA Empire project.';
        if (markerRead?.error || (marker && !markerValid)) {
            error = 'This folder contains an invalid or corrupted YTA project marker.';
        } else if (invalidFvpCount > 0) {
            error = 'This folder contains a .fvp file, but it is not a valid YTA Empire project file.';
        }
        return {
            valid: false,
            code: 'NOT_YTA_PROJECT',
            error: `${error} Choose a folder containing ${PROJECT_MARKER_FILE}, a valid .fvp file, or a valid public/video-plan.json.`,
            projectDir: root,
            markerPath,
        };
    }

    return {
        valid: true,
        projectDir: root,
        projectFile: validProjectFile?.filePath || null,
        markerPath,
        marker: markerValid ? marker : null,
        legacy: !markerValid,
        evidence: markerValid
            ? 'marker'
            : validProjectFile
                ? 'fvp'
                : 'video-plan',
    };
}

function writeProjectMarker({ projectDir, projectName, projectFile } = {}) {
    const rawProjectDir = String(projectDir || '').trim();
    if (!rawProjectDir) {
        throw new Error('Cannot write project marker because the project folder was not provided');
    }
    const root = path.resolve(rawProjectDir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error('Cannot write project marker because the project folder does not exist');
    }

    const markerPath = path.join(root, PROJECT_MARKER_FILE);
    const existingRead = fs.existsSync(markerPath) ? _readJson(markerPath) : null;
    const existing = _isProjectMarkerShape(existingRead?.data) ? existingRead.data : null;
    const now = new Date().toISOString();
    const resolvedProjectFile = projectFile ? path.resolve(projectFile) : null;
    const marker = {
        type: PROJECT_MARKER_TYPE,
        version: PROJECT_MARKER_VERSION,
        projectFileVersion: PROJECT_FILE_VERSION,
        name: String(projectName || existing?.name || path.basename(root) || 'Project').trim(),
        projectFile: resolvedProjectFile && _pathsEqual(path.dirname(resolvedProjectFile), root)
            ? path.basename(resolvedProjectFile)
            : (existing?.projectFile || null),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    _atomicWriteJson(markerPath, marker);
    return { markerPath, marker };
}

function initializeProject({ projectDir, projectName, settings } = {}) {
    const rawProjectDir = String(projectDir || '').trim();
    if (!rawProjectDir) throw new Error('Project directory is required');
    const root = path.resolve(rawProjectDir);
    fs.mkdirSync(root, { recursive: true });

    const existingEntries = fs.readdirSync(root);
    if (existingEntries.length > 0) {
        const error = new Error('The new project folder must be empty');
        error.code = 'PROJECT_DIRECTORY_NOT_EMPTY';
        throw error;
    }

    return saveProjectState({
        projectDir: root,
        publicDir: path.join(root, 'public'),
        tempDir: path.join(root, 'temp'),
        projectName,
        settings: _isObject(settings) ? settings : {},
        videoPlan: {
            fps: 30,
            totalDuration: 0,
            scenes: [],
            mgScenes: [],
            overlayScenes: [],
            sfxClips: [],
            transitions: [],
        },
    });
}

function _isValidProjectName(projectName) {
    const value = String(projectName || '').trim();
    const windowsStem = value.split('.')[0];
    const reservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(windowsStem);
    return Boolean(value)
        && value.length <= 120
        && !/[<>:"/\\|?*\x00-\x1F]/.test(value)
        && !/[. ]$/.test(value)
        && !reservedWindowsName
        && value !== '.'
        && value !== '..';
}

function createProjectAtLocation({ location, projectName, locationMode } = {}) {
    const rawLocation = String(location || '').trim();
    if (!rawLocation) {
        return { success: false, error: 'Choose a folder for the project location.' };
    }

    const selectedLocation = path.resolve(rawLocation);
    if (!fs.existsSync(selectedLocation) || !fs.statSync(selectedLocation).isDirectory()) {
        return { success: false, error: 'Choose an existing folder for the project location.' };
    }

    const mode = locationMode === 'create-subfolder'
        ? 'create-subfolder'
        : 'selected-folder';
    const requestedName = String(projectName || '').trim();
    let targetDir = selectedLocation;
    let effectiveProjectName = path.basename(selectedLocation);

    if (mode === 'selected-folder' && !effectiveProjectName) {
        return {
            success: false,
            error: 'Choose a named folder instead of a drive root for the project.',
        };
    }

    if (mode === 'create-subfolder') {
        if (!_isValidProjectName(requestedName)) {
            return {
                success: false,
                error: 'Enter a valid Windows-compatible project name (maximum 120 characters).',
            };
        }
        if (path.basename(selectedLocation).localeCompare(requestedName, undefined, { sensitivity: 'accent' }) === 0) {
            return {
                success: false,
                code: 'NESTED_DUPLICATE_PROJECT_NAME',
                error: 'The selected folder already has this project name. Choose “Use selected folder” to avoid creating a duplicated nested folder.',
            };
        }
        targetDir = path.join(selectedLocation, requestedName);
        effectiveProjectName = requestedName;
    }

    let createdDirectory = false;
    try {
        if (fs.existsSync(targetDir)) {
            if (!fs.statSync(targetDir).isDirectory()) {
                return { success: false, error: 'The project destination is not a folder.' };
            }
            const existingProject = inspectProjectDirectory({ projectDir: targetDir });
            if (existingProject.valid) {
                return {
                    success: false,
                    existingProject: true,
                    error: 'A YTA Empire project already exists in this folder. Use Open Project instead.',
                };
            }
            if (fs.readdirSync(targetDir).length > 0) {
                return {
                    success: false,
                    code: 'PROJECT_DIRECTORY_NOT_EMPTY',
                    error: mode === 'selected-folder'
                        ? 'The selected folder is not empty. Choose an empty folder, or use “Create a new folder inside” to keep existing files untouched.'
                        : 'The destination folder already exists and is not empty. Choose another project name or location.',
                };
            }
        } else {
            fs.mkdirSync(targetDir);
            createdDirectory = true;
        }

        const initialized = initializeProject({
            projectDir: targetDir,
            projectName: effectiveProjectName,
        });
        return {
            success: true,
            projectDir: targetDir,
            projectFile: initialized.fvpPath,
            projectName: effectiveProjectName,
            locationMode: mode,
        };
    } catch (error) {
        if (createdDirectory
            && _pathsEqual(path.dirname(targetDir), selectedLocation)
            && fs.existsSync(targetDir)) {
            try {
                fs.rmSync(targetDir, { recursive: true, force: true });
            } catch (_) { }
        }
        return {
            success: false,
            error: `Could not create the project: ${error.message}`,
        };
    }
}

function _planHash(plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
    return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function _planTimestamp(envelope, fallbackMtimeMs) {
    const parsed = Date.parse(envelope?.planSavedAt || envelope?.savedAt || '');
    return Number.isFinite(parsed) ? parsed : fallbackMtimeMs;
}

function _atomicWriteJson(filePath, value) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });

    const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const tempPath = `${resolved}.tmp-${nonce}`;
    const backupPath = `${resolved}.bak-${nonce}`;
    const json = `${JSON.stringify(value, null, 2)}\n`;

    let fd = null;
    let backupCreated = false;
    try {
        fd = fs.openSync(tempPath, 'wx');
        fs.writeFileSync(fd, json, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;

        if (fs.existsSync(resolved)) {
            fs.renameSync(resolved, backupPath);
            backupCreated = true;
        }
        fs.renameSync(tempPath, resolved);
        if (backupCreated) {
            try { fs.unlinkSync(backupPath); } catch (_) { }
        }
    } catch (error) {
        if (fd != null) {
            try { fs.closeSync(fd); } catch (_) { }
        }
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { }
        if (backupCreated && !fs.existsSync(resolved) && fs.existsSync(backupPath)) {
            try { fs.renameSync(backupPath, resolved); } catch (_) { }
        }
        throw error;
    }
}

function loadProjectState({
    projectDir,
    publicDir,
    tempDir,
    preferredFvpPath,
} = {}) {
    const root = path.resolve(projectDir);
    const fvpPath = resolveProjectFilePath({ projectDir: root, preferredFvpPath });
    const fvpRead = fs.existsSync(fvpPath) ? _readJson(fvpPath) : null;
    const envelope = fvpRead?.data && typeof fvpRead.data === 'object' ? fvpRead.data : null;
    const warnings = [];
    if (fvpRead?.error) warnings.push(`Could not read ${path.basename(fvpPath)}: ${fvpRead.error.message}`);

    const candidates = [];
    const addPlanCandidate = (kind, read, priority) => {
        if (!read) return;
        if (read.error) {
            warnings.push(`Could not read ${kind}: ${read.error.message}`);
            return;
        }
        if (!read.data || typeof read.data !== 'object' || Array.isArray(read.data)) {
            warnings.push(`${kind} does not contain a plan object`);
            return;
        }
        candidates.push({
            kind,
            filePath: read.filePath,
            plan: read.data,
            timestamp: read.mtimeMs,
            priority,
        });
    };

    const publicPlanPath = path.join(publicDir, 'video-plan.json');
    const tempPlanPath = path.join(tempDir, 'video-plan.json');
    addPlanCandidate('public/video-plan.json', fs.existsSync(publicPlanPath) ? _readJson(publicPlanPath) : null, 2);
    addPlanCandidate('temp/video-plan.json', fs.existsSync(tempPlanPath) ? _readJson(tempPlanPath) : null, 1);

    if (envelope?.videoPlan && typeof envelope.videoPlan === 'object' && !Array.isArray(envelope.videoPlan)) {
        candidates.push({
            kind: '.fvp',
            filePath: fvpPath,
            plan: envelope.videoPlan,
            timestamp: _planTimestamp(envelope, fvpRead?.mtimeMs || 0),
            priority: 3,
        });
    } else if (_isVideoPlanShape(envelope)) {
        candidates.push({
            kind: '.fvp (legacy plan)',
            filePath: fvpPath,
            plan: envelope,
            timestamp: fvpRead?.mtimeMs || 0,
            priority: 3,
        });
    }

    // A mirror holding the same plan as the .fvp came FROM that .fvp, so it must
    // not outrank it. It otherwise always does: the .fvp candidate is timestamped
    // by when its plan was stamped (planSavedAt), while the mirrors carry the
    // mtime of a file the same save wrote — and fsynced — a few milliseconds
    // later. Raw timestamps therefore make every fresh save look like the copies
    // are newer than the original, and the priority tie-break below could never
    // fire in the one case it exists for. Matching content is the exact signal
    // for "same save", so use it instead of a time window: a mirror that a later
    // build genuinely rewrote holds a DIFFERENT plan, keeps its own mtime, and
    // still wins on recency.
    const fvpCandidate = candidates.find(c => c.priority === 3);
    if (fvpCandidate) {
        const fvpHash = _planHash(fvpCandidate.plan);
        for (const candidate of candidates) {
            if (candidate === fvpCandidate) continue;
            if (_planHash(candidate.plan) === fvpHash) candidate.timestamp = fvpCandidate.timestamp;
        }
    }

    candidates.sort((a, b) => b.timestamp - a.timestamp || b.priority - a.priority);
    const selected = candidates[0] || null;
    if (!selected) {
        return {
            version: envelope?.version || PROJECT_FILE_VERSION,
            savedAt: envelope?.savedAt || null,
            planSavedAt: envelope?.planSavedAt || null,
            revision: Number(envelope?.revision) || 0,
            settings: envelope?.settings || null,
            videoPlan: null,
            planHash: null,
            source: null,
            fvpPath,
            needsReconcile: false,
            warnings,
        };
    }

    const selectedHash = _planHash(selected.plan);
    const mirrorReads = [
        fvpRead && (envelope?.videoPlan || _isVideoPlanShape(envelope))
            ? { name: '.fvp', plan: envelope.videoPlan || envelope, error: fvpRead.error }
            : null,
        fs.existsSync(publicPlanPath) ? { name: 'public/video-plan.json', ..._readJson(publicPlanPath) } : null,
        fs.existsSync(tempPlanPath) ? { name: 'temp/video-plan.json', ..._readJson(tempPlanPath) } : null,
    ];
    const needsReconcile = mirrorReads.length !== 3 || mirrorReads.some((mirror) => (
        !mirror || mirror.error || _planHash(mirror.plan || mirror.data) !== selectedHash
    ));

    return {
        version: envelope?.version || PROJECT_FILE_VERSION,
        savedAt: envelope?.savedAt || null,
        planSavedAt: envelope?.planSavedAt || null,
        revision: Number(envelope?.revision) || 0,
        settings: envelope?.settings || null,
        videoPlan: selected.plan,
        planHash: selectedHash,
        source: selected.kind,
        fvpPath,
        needsReconcile,
        warnings,
    };
}

function saveProjectState({
    projectDir,
    publicDir,
    tempDir,
    preferredFvpPath,
    projectName,
    settings,
    videoPlan,
    revision,
    expectedRevision,
} = {}) {
    if (!videoPlan || typeof videoPlan !== 'object' || Array.isArray(videoPlan)) {
        throw new Error('Project save requires a video plan object');
    }
    const normalizedPlan = timelineContract.withContinuityHolds(videoPlan);

    const fvpPath = resolveProjectFilePath({ projectDir, preferredFvpPath });
    if (expectedRevision !== undefined && expectedRevision !== null) {
        const currentRead = fs.existsSync(fvpPath) ? _readJson(fvpPath) : null;
        const currentRevision = Number(currentRead?.data?.revision) || 0;
        if (currentRevision !== Number(expectedRevision)) {
            const error = new Error(`Project revision conflict: expected ${expectedRevision}, found ${currentRevision}`);
            error.code = 'PROJECT_REVISION_CONFLICT';
            error.currentRevision = currentRevision;
            throw error;
        }
    }
    // Commit mirrors first. The envelope timestamp is captured afterwards so a
    // freshly saved .fvp remains authoritative without trusting its filesystem
    // mtime (which can be changed by copying or touching a stale file).
    _atomicWriteJson(path.join(publicDir, 'video-plan.json'), normalizedPlan);
    _atomicWriteJson(path.join(tempDir, 'video-plan.json'), normalizedPlan);

    const now = new Date().toISOString();
    const envelope = {
        version: PROJECT_FILE_VERSION,
        savedAt: now,
        planSavedAt: now,
        revision: Math.max(0, Number(revision) || 0) + 1,
        settings: settings && typeof settings === 'object' ? settings : {},
        videoPlan: normalizedPlan,
        planHash: _planHash(normalizedPlan),
    };

    // The .fvp envelope is the final commit.
    _atomicWriteJson(fvpPath, envelope);
    writeProjectMarker({
        projectDir,
        projectName,
        projectFile: fvpPath,
    });

    return {
        ...envelope,
        fvpPath,
        source: '.fvp',
        needsReconcile: false,
        warnings: [],
    };
}

function reconcileProjectState(options = {}) {
    const loaded = loadProjectState(options);
    if (!loaded.videoPlan || !loaded.needsReconcile) return loaded;
    const saved = saveProjectState({
        ...options,
        preferredFvpPath: loaded.fvpPath,
        settings: loaded.settings || {},
        videoPlan: loaded.videoPlan,
        revision: loaded.revision,
    });
    return {
        ...saved,
        source: `reconciled:${loaded.source}`,
        warnings: loaded.warnings,
    };
}

module.exports = {
    PROJECT_FILE_VERSION,
    PROJECT_MARKER_FILE,
    PROJECT_MARKER_TYPE,
    PROJECT_MARKER_VERSION,
    atomicWriteJson: _atomicWriteJson,
    createProjectAtLocation,
    initializeProject,
    inspectProjectDirectory,
    loadProjectState,
    reconcileProjectState,
    resolveProjectFilePath,
    saveProjectState,
    validateProjectFile,
    writeProjectMarker,
};
