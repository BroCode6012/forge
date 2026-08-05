#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    PROJECT_MARKER_FILE,
    PROJECT_MARKER_TYPE,
    createProjectAtLocation,
    initializeProject,
    inspectProjectDirectory,
    loadProjectState,
    reconcileProjectState,
    resolveProjectFilePath,
    saveProjectState,
    validateProjectFile,
    writeProjectMarker,
} = require('../../src/project/project-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-project-store-'));
const publicDir = path.join(root, 'public');
const tempDir = path.join(root, 'temp');
const options = { projectDir: root, publicDir, tempDir };

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertPlanEverywhere(expectedPlan, fvpPath) {
    assert.deepStrictEqual(readJson(path.join(publicDir, 'video-plan.json')), expectedPlan);
    assert.deepStrictEqual(readJson(path.join(tempDir, 'video-plan.json')), expectedPlan);
    assert.deepStrictEqual(readJson(fvpPath).videoPlan, expectedPlan);
}

function cleanup() {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(root);
    const relative = path.relative(tempRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !path.basename(resolved).startsWith('yta-project-store-')) {
        throw new Error(`Refusing to clean unexpected test path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

try {
    assert.strictEqual(
        inspectProjectDirectory({ projectDir: root }).valid,
        false,
        'an arbitrary empty folder must not be accepted as a project'
    );

    const randomDir = path.join(root, 'random-folder');
    fs.mkdirSync(randomDir);
    fs.writeFileSync(path.join(randomDir, 'notes.txt'), 'not a project');
    const randomInspection = inspectProjectDirectory({ projectDir: randomDir });
    assert.strictEqual(randomInspection.valid, false);
    assert.strictEqual(randomInspection.code, 'NOT_YTA_PROJECT');

    const initializedDir = path.join(root, 'initialized-project');
    fs.mkdirSync(initializedDir);
    const initialized = initializeProject({
        projectDir: initializedDir,
        projectName: 'Initialized Project',
    });
    assert.ok(fs.existsSync(initialized.fvpPath));
    assert.ok(fs.existsSync(path.join(initializedDir, PROJECT_MARKER_FILE)));
    assert.strictEqual(
        readJson(path.join(initializedDir, PROJECT_MARKER_FILE)).type,
        PROJECT_MARKER_TYPE
    );
    const initializedInspection = inspectProjectDirectory({ projectDir: initializedDir });
    assert.strictEqual(initializedInspection.valid, true);
    assert.strictEqual(initializedInspection.evidence, 'marker');
    assert.strictEqual(initializedInspection.projectFile, initialized.fvpPath);
    assert.strictEqual(
        validateProjectFile({
            filePath: initialized.fvpPath,
            projectDir: initializedDir,
        }).valid,
        true
    );

    const badPreferredFvp = path.join(initializedDir, 'broken.fvp');
    fs.writeFileSync(badPreferredFvp, '{broken json');
    assert.strictEqual(
        inspectProjectDirectory({
            projectDir: initializedDir,
            preferredFvpPath: badPreferredFvp,
        }).valid,
        false,
        'explicitly selecting a corrupt .fvp must fail even if its folder is a project'
    );

    const legacyFvpDir = path.join(root, 'legacy-fvp-project');
    fs.mkdirSync(legacyFvpDir);
    const legacyFvpPath = path.join(legacyFvpDir, 'legacy.fvp');
    fs.writeFileSync(legacyFvpPath, JSON.stringify({
        version: 1,
        videoPlan: {
            totalDuration: 2,
            scenes: [{ startTime: 0, endTime: 2, text: 'legacy' }],
        },
    }));
    const legacyFvpInspection = inspectProjectDirectory({ projectDir: legacyFvpDir });
    assert.strictEqual(legacyFvpInspection.valid, true);
    assert.strictEqual(legacyFvpInspection.legacy, true);
    assert.strictEqual(legacyFvpInspection.evidence, 'fvp');

    const legacyPlanDir = path.join(root, 'legacy-plan-project');
    const legacyPlanPath = path.join(legacyPlanDir, 'public', 'video-plan.json');
    fs.mkdirSync(path.dirname(legacyPlanPath), { recursive: true });
    fs.writeFileSync(legacyPlanPath, JSON.stringify({
        fps: 30,
        totalDuration: 0,
        scenes: [],
    }));
    const legacyPlanInspection = inspectProjectDirectory({ projectDir: legacyPlanDir });
    assert.strictEqual(legacyPlanInspection.valid, true);
    assert.strictEqual(legacyPlanInspection.legacy, true);
    assert.strictEqual(legacyPlanInspection.evidence, 'video-plan');

    const markerOnlyDir = path.join(root, 'marker-only-project');
    fs.mkdirSync(markerOnlyDir);
    writeProjectMarker({ projectDir: markerOnlyDir, projectName: 'Marker Only' });
    assert.strictEqual(
        inspectProjectDirectory({ projectDir: markerOnlyDir }).valid,
        true,
        'the project marker is authoritative even before media exists'
    );

    const malformedDir = path.join(root, 'malformed-project');
    fs.mkdirSync(malformedDir);
    fs.writeFileSync(path.join(malformedDir, 'malformed.fvp'), JSON.stringify({ hello: 'world' }));
    assert.strictEqual(
        inspectProjectDirectory({ projectDir: malformedDir }).valid,
        false,
        'a random JSON file renamed to .fvp must not be accepted'
    );

    const directProjectDir = path.join(root, 'direct-project-folder');
    fs.mkdirSync(directProjectDir);
    const directCreated = createProjectAtLocation({
        location: directProjectDir,
        projectName: 'Ignored Name',
        locationMode: 'selected-folder',
    });
    assert.strictEqual(directCreated.success, true);
    assert.strictEqual(directCreated.projectDir, directProjectDir);
    assert.strictEqual(directCreated.projectName, 'direct-project-folder');
    assert.strictEqual(
        fs.existsSync(path.join(directProjectDir, 'Ignored Name')),
        false,
        'using the selected folder must never create a nested project directory'
    );

    const parentDir = path.join(root, 'project-parent');
    fs.mkdirSync(parentDir);
    const childCreated = createProjectAtLocation({
        location: parentDir,
        projectName: 'Child Project',
        locationMode: 'create-subfolder',
    });
    assert.strictEqual(childCreated.success, true);
    assert.strictEqual(childCreated.projectDir, path.join(parentDir, 'Child Project'));
    assert.strictEqual(
        inspectProjectDirectory({ projectDir: childCreated.projectDir }).valid,
        true
    );

    const duplicateParent = path.join(root, 'Duplicate Project');
    fs.mkdirSync(duplicateParent);
    const duplicateNested = createProjectAtLocation({
        location: duplicateParent,
        projectName: 'duplicate project',
        locationMode: 'create-subfolder',
    });
    assert.strictEqual(duplicateNested.success, false);
    assert.strictEqual(duplicateNested.code, 'NESTED_DUPLICATE_PROJECT_NAME');

    const reservedName = createProjectAtLocation({
        location: parentDir,
        projectName: 'CON',
        locationMode: 'create-subfolder',
    });
    assert.strictEqual(reservedName.success, false);
    assert.strictEqual(fs.existsSync(path.join(parentDir, 'CON')), false);

    const nonEmptyNewDir = path.join(root, 'non-empty-new-project');
    fs.mkdirSync(nonEmptyNewDir);
    fs.writeFileSync(path.join(nonEmptyNewDir, 'keep-me.txt'), 'existing user file');
    const nonEmptyCreate = createProjectAtLocation({
        location: nonEmptyNewDir,
        locationMode: 'selected-folder',
    });
    assert.strictEqual(nonEmptyCreate.success, false);
    assert.strictEqual(nonEmptyCreate.code, 'PROJECT_DIRECTORY_NOT_EMPTY');
    assert.strictEqual(fs.readFileSync(path.join(nonEmptyNewDir, 'keep-me.txt'), 'utf8'), 'existing user file');

    const existingProjectCreate = createProjectAtLocation({
        location: directProjectDir,
        locationMode: 'selected-folder',
    });
    assert.strictEqual(existingProjectCreate.success, false);
    assert.strictEqual(existingProjectCreate.existingProject, true);

    const planA = {
        totalDuration: 8,
        scenes: [{ index: 0, startTime: 0, endTime: 8, text: 'plan-a' }],
    };
    const settings = { buildTheme: 'history', videoTitle: 'Persistence Test' };
    const savedA = saveProjectState({ ...options, settings, videoPlan: planA });

    assert.strictEqual(savedA.revision, 1);
    assert.ok(fs.existsSync(savedA.fvpPath));
    assert.ok(fs.existsSync(path.join(root, PROJECT_MARKER_FILE)));
    assertPlanEverywhere(planA, savedA.fvpPath);

    const loadedA = loadProjectState(options);
    assert.deepStrictEqual(loadedA.videoPlan, planA);
    assert.deepStrictEqual(loadedA.settings, settings);
    assert.strictEqual(loadedA.source, '.fvp');
    assert.strictEqual(loadedA.needsReconcile, false);

    // A mirror written by the SAME save must never outrank the .fvp it was
    // copied from, no matter how far its mtime lands ahead. This is not
    // hypothetical: the .fvp candidate is dated by planSavedAt, stamped before
    // any file is written, while the mirrors carry the mtime of files the same
    // save wrote and fsynced afterwards — so the mirrors are ALWAYS a little
    // newer, and under disk contention (a full `npm run verify` run) enough so
    // that the loader reported temp/video-plan.json as the source of a plan it
    // had just saved. Forcing the gap makes that race deterministic instead of
    // leaving it to how busy the disk is.
    const sameSaveMirrors = [
        path.join(publicDir, 'video-plan.json'),
        path.join(tempDir, 'video-plan.json'),
    ];
    const slowFsync = new Date(Date.now() + 3000);
    for (const mirror of sameSaveMirrors) fs.utimesSync(mirror, slowFsync, slowFsync);

    const afterSlowWrite = loadProjectState(options);
    assert.strictEqual(afterSlowWrite.source, '.fvp');
    assert.deepStrictEqual(afterSlowWrite.videoPlan, planA);
    assert.strictEqual(afterSlowWrite.needsReconcile, false);

    // Simulate a build writing a newer public plan while the old .fvp remains.
    const planB = {
        totalDuration: 12,
        scenes: [{ index: 0, startTime: 0, endTime: 12, text: 'newer-build-plan' }],
    };
    const publicPlanPath = path.join(publicDir, 'video-plan.json');
    fs.writeFileSync(publicPlanPath, JSON.stringify(planB, null, 2));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(publicPlanPath, future, future);
    const touchedStaleFvp = new Date(Date.now() + 20_000);
    fs.utimesSync(savedA.fvpPath, touchedStaleFvp, touchedStaleFvp);

    const divergent = loadProjectState(options);
    assert.strictEqual(divergent.source, 'public/video-plan.json');
    assert.deepStrictEqual(divergent.videoPlan, planB);
    assert.strictEqual(divergent.needsReconcile, true);
    assert.deepStrictEqual(divergent.settings, settings);

    const reconciled = reconcileProjectState(options);
    assert.strictEqual(reconciled.revision, 2);
    assert.ok(reconciled.source.startsWith('reconciled:public/video-plan.json'));
    assertPlanEverywhere(planB, reconciled.fvpPath);
    assert.deepStrictEqual(readJson(reconciled.fvpPath).settings, settings);

    // A plan-only save must preserve project-scoped settings.
    const planC = {
        totalDuration: 15,
        scenes: [{ index: 0, startTime: 0, endTime: 15, text: 'qa-updated-plan' }],
    };
    const current = loadProjectState(options);
    const savedC = saveProjectState({
        ...options,
        preferredFvpPath: current.fvpPath,
        settings: current.settings,
        videoPlan: planC,
        revision: current.revision,
        expectedRevision: current.revision,
    });
    assert.strictEqual(savedC.revision, 3);
    assertPlanEverywhere(planC, savedC.fvpPath);
    assert.deepStrictEqual(readJson(savedC.fvpPath).settings, settings);

    assert.throws(() => saveProjectState({
        ...options,
        preferredFvpPath: savedC.fvpPath,
        settings,
        videoPlan: planA,
        revision: savedC.revision,
        expectedRevision: savedC.revision - 1,
    }), (error) => error?.code === 'PROJECT_REVISION_CONFLICT');
    assertPlanEverywhere(planC, savedC.fvpPath);

    // A corrupt mirror is ignored, reported, and repaired from a valid source.
    const tempPlanPath = path.join(tempDir, 'video-plan.json');
    fs.writeFileSync(tempPlanPath, '{broken json');
    fs.utimesSync(tempPlanPath, future, future);
    const corrupt = loadProjectState(options);
    assert.deepStrictEqual(corrupt.videoPlan, planC);
    assert.strictEqual(corrupt.needsReconcile, true);
    assert.ok(corrupt.warnings.some((warning) => warning.includes('temp/video-plan.json')));
    const repaired = reconcileProjectState(options);
    assertPlanEverywhere(planC, repaired.fvpPath);

    // If the canonical folder-named file is absent, choose the newest legacy .fvp.
    const canonical = resolveProjectFilePath(options);
    const legacy = path.join(root, 'legacy-project.fvp');
    fs.renameSync(canonical, legacy);
    assert.strictEqual(resolveProjectFilePath(options), legacy);

    const leftovers = fs.readdirSync(root, { recursive: true })
        .filter((name) => /\.tmp-|\.bak-/.test(String(name)));
    assert.deepStrictEqual(leftovers, []);

    console.log('✅ unified project store migration/reconciliation checks passed');
} finally {
    cleanup();
}
