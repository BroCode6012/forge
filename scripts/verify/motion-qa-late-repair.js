#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    motionQaPassPolicy,
    runMotionQa,
} = require('../../src/agents/workers/motion-qa-agent');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-motion-qa-late-repair-'));
const originalFlag = process.env.HF_MOTION_QA;
delete process.env.HF_MOTION_QA;

async function main() {
    const plan = {
        fps: 30,
        totalDuration: 10,
        scenes: [{ index: 0, startTime: 0, endTime: 10 }],
        mgScenes: [],
        templateScenes: [{
            id: 'late-layout-card',
            type: 'statCard',
            text: '$300 System',
            startTime: 0,
            endTime: 4,
            duration: 4,
            _authoredNs: 'auth-late-layout',
            _authoredComposition: {
                html: '<div id="auth-late-layout-root">$300</div>',
                css: '',
                timeline: 'tl.to("#auth-late-layout-root",{opacity:1,duration:0.2},0);',
            },
        }],
        motionGraphics: [{
            id: 'late-contrast-counter',
            type: 'statCounter',
            text: '200 years',
            startTime: 5,
            endTime: 8,
            duration: 3,
            adaptiveContrast: true,
            contrastProtection: 'strong',
            _authoredNs: 'auth-late-contrast',
            _authoredComposition: {
                html: '<div id="auth-late-contrast-number">200</div>',
                css: '#auth-late-contrast-number{color:#777}',
                timeline: 'tl.to("#auth-late-contrast-number",{opacity:1,duration:0.2},0);',
            },
        }],
    };

    const generated = [];
    const diagnosticsCalls = [];
    const result = await runMotionQa({
        plan,
        appRoot: process.cwd(),
        reportDir: testRoot,
        quick: true,
        log: () => {},
        generateProject: async (_currentPlan, pass) => {
            const projectDir = path.join(testRoot, `pass-${pass}`);
            fs.mkdirSync(projectDir, { recursive: true });
            const indexPath = path.join(projectDir, 'index.html');
            fs.writeFileSync(indexPath, '<script>window.__timelines = {};</script>', 'utf8');
            generated.push(pass);
            return { projectDir, indexPath };
        },
        diagnosticsRunner: async ({ project }) => {
            const pass = Number(path.basename(project.projectDir).replace('pass-', ''));
            diagnosticsCalls.push(pass);
            const manifest = {
                graphics: [
                    {
                        id: 'mg-0-stat-card',
                        sourceGroup: 'templateScenes',
                        sourceIndex: 0,
                        sourceClipId: 'late-layout-card',
                        authored: Boolean(plan.templateScenes[0]._authoredComposition),
                        authoredNs: plan.templateScenes[0]._authoredNs || '',
                    },
                    {
                        id: 'mg-1-stat-counter',
                        sourceGroup: 'motionGraphics',
                        sourceIndex: 0,
                        sourceClipId: 'late-contrast-counter',
                        authored: Boolean(plan.motionGraphics[0]._authoredComposition),
                        authoredNs: plan.motionGraphics[0]._authoredNs || '',
                    },
                ],
            };
            const findings = pass === 1
                ? [{
                    severity: 'error',
                    code: 'layout_readable_text_outside_frame',
                    section: 'layout',
                    selector: '#auth-late-layout-root',
                    message: 'Authored layout extends outside the frame.',
                }]
                : pass === 2
                    ? [{
                        severity: 'error',
                        code: 'contrast_aa_failure',
                        section: 'contrast',
                        selector: '#auth-late-contrast-number',
                        message: 'Contrast is 1.14:1; WCAG AA requires 3:1.',
                    }]
                    : [];
            return {
                findings,
                manifest,
                vision: { repairs: [] },
                summary: {},
            };
        },
    });

    const policy = motionQaPassPolicy(true);
    assert.ok(policy.hardPassCap >= 3, 'quick Motion QA must allow a late deterministic repair plus verification');
    assert.deepStrictEqual(generated, [1, 2, 3], 'late pass-2 repair must trigger one verified pass-3 regeneration');
    assert.deepStrictEqual(diagnosticsCalls, [1, 2, 3]);
    assert.strictEqual(result.hardFail, false, 'verified late repair must not leave the render hard-failed');
    assert.strictEqual(result.report.status, 'pass');
    assert.ok(result.report.repairs.some((repair) => repair.code === 'safe_layout_fallback'));
    assert.ok(result.report.repairs.some((repair) => repair.code === 'authored_contrast_fallback'));
    assert.strictEqual(plan.motionGraphics[0]._authoredComposition, undefined);

    console.log('✅ Motion QA late-repair extension passed');
}

main()
    .finally(() => {
        if (originalFlag === undefined) delete process.env.HF_MOTION_QA;
        else process.env.HF_MOTION_QA = originalFlag;
        const resolved = path.resolve(testRoot);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-motion-qa-late-repair-')) {
            throw new Error(`Refusing to clean unsafe late-repair test directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    })
    .catch((error) => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
