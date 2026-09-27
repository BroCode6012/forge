#!/usr/bin/env node
// scripts/verify/runtime-ai-connections-probe.js
// ============================================================================
// Runtime proof for AI Connections: boots the REAL app (runtime-harness.js),
// starts a fake OpenAI-compatible server, and then uses the panel the way a
// person does — fills the form, presses Save, presses Test, picks a job —
// before checking that the key reached the server, never came back to the
// window, and sits encrypted on disk.
// ============================================================================
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const browserWSEndpoint = process.argv[2];
if (!browserWSEndpoint) {
    console.error('usage: node scripts/verify/runtime-ai-connections-probe.js <browserWsEndpoint>');
    process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET = 'probe-secret-7f3a9c';

const received = [];
const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        received.push({ url: req.url, auth: req.headers.authorization || '', body: raw ? JSON.parse(raw) : null });
        const send = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
        };
        if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: { message: 'bad key' } });
        if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'mock-text' }, { id: 'mock-vision' }] });
        const body = JSON.parse(raw);
        const content = body.messages[body.messages.length - 1].content;
        const sawImage = Array.isArray(content) && content.some((part) => part.type === 'image_url');
        send(200, { choices: [{ message: { content: sawImage ? 'Red' : 'READY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    });
});

(async () => {
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const MOCK = `http://127.0.0.1:${mock.address().port}`;

    const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null, protocolTimeout: 120_000 });
    const pages = await browser.pages();
    const page = pages.find((candidate) => /ui\/index\.html/i.test(candidate.url()));
    if (!page) throw new Error('main renderer page not found');
    page.on('dialog', (dialog) => dialog.accept());
    await wait(1500);

    // ── the panel is there ──────────────────────────────────────────────────
    const layout = await page.evaluate(() => ({
        group: !!document.getElementById('ai-connections-group'),
        jobSelects: document.querySelectorAll('#ai-connections-jobs select').length,
        presets: document.querySelectorAll('#ai-conn-preset option').length,
    }));
    ok('the AI Connections panel is in the window', layout.group);
    ok('it shows a primary and a backup picker for each of the 3 jobs', layout.jobSelects === 6, String(layout.jobSelects));
    ok('the presets are offered', layout.presets >= 6, String(layout.presets));

    // ── fill the form and save, like a person ───────────────────────────────
    await page.evaluate(() => {
        document.querySelector('[data-stab="ai"]')?.click?.();
        document.getElementById('ai-connections-add').click();
    });
    await page.evaluate((mockUrl, secret) => {
        const set = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ai-conn-preset', 'custom');
        set('ai-conn-label', 'Probe Mock');
        set('ai-conn-url', `${mockUrl}/v1/chat/completions`);
        set('ai-conn-key', secret);
        set('ai-conn-model', 'mock-text');
        set('ai-conn-vision-model', 'mock-vision');
        set('ai-conn-auth', 'bearer');
        document.getElementById('ai-conn-save').click();
    }, MOCK, SECRET);
    await wait(1200);

    const afterSave = await page.evaluate(async () => ({
        status: document.getElementById('ai-connections-status')?.textContent || '',
        cards: document.querySelectorAll('#ai-connections-list button').length,
        view: await window.electronAPI.aiConnectionsGet(),
    }));
    const saved = afterSave.view.connections.find((c) => c.label === 'Probe Mock');
    ok('Save stores the connection', !!saved && /Saved/.test(afterSave.status), afterSave.status);
    ok('the pasted /chat/completions was trimmed off the address', saved && saved.baseUrl === `${MOCK}/v1`, saved && saved.baseUrl);
    ok('the window is told a key is saved, never the key itself', saved && saved.hasKey === true && !JSON.stringify(afterSave.view).includes(SECRET));
    ok('the key is protected by the OS', saved && saved.keyProtection === 'encrypted', saved && saved.keyProtection);
    ok('the connection appears in the list with Test / Edit / Delete', afterSave.cards >= 3, String(afterSave.cards));

    // ── press Test on the saved card ────────────────────────────────────────
    received.length = 0;
    await page.evaluate(() => {
        const testButton = [...document.querySelectorAll('#ai-connections-list button')].find((b) => b.textContent === 'Test');
        testButton.click();
    });
    let tested = null;
    for (let i = 0; i < 40; i++) {
        await wait(500);
        tested = await page.evaluate(async () => ({
            status: document.getElementById('ai-connections-status')?.textContent || '',
            result: document.getElementById('ai-conn-test-result')?.textContent || '',
            view: await window.electronAPI.aiConnectionsGet(),
        }));
        if (/Test passed|Test failed/.test(tested.status)) break;
    }
    const afterTest = tested.view.connections.find((c) => c.label === 'Probe Mock');
    ok('Test passes against the live server', /Test passed/.test(tested.status), tested.status);
    ok('each step is shown in words', /Reach the server/.test(tested.result) && /Write text/.test(tested.result) && /See a picture/.test(tested.result), tested.result.slice(0, 200));
    ok('the test result is remembered on the connection', afterTest?.lastTest?.ok === true);
    ok('the server received the key from the main process', received.length >= 3 && received.every((r) => r.auth === `Bearer ${SECRET}`));
    ok('the picture really went to the server', received.some((r) => JSON.stringify(r.body || {}).includes('image_url')));

    // ── pick it for a job, like a person ────────────────────────────────────
    await page.evaluate((id) => {
        const select = document.querySelector('#ai-connections-jobs select[data-job="thinking"][data-slot="primary"]');
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, afterTest.id);
    await wait(800);
    const jobs = await page.evaluate(async () => (await window.electronAPI.aiConnectionsGet()).jobs);
    ok('Thinking now runs on the new connection', jobs.thinking.primary === afterTest.id, JSON.stringify(jobs));
    ok('the other jobs stayed on the built-in setup', !jobs.everyday.primary && !jobs.eyes.primary);

    // Optional picture of the panel for a human to look at.
    if (process.env.AI_CONN_PROBE_SHOT) {
        try {
            await page.setViewport({ width: 1600, height: 1400 });
            await wait(600);
            await page.evaluate(() => document.getElementById('ai-connections-group')?.scrollIntoView({ block: 'start' }));
            await wait(300);
            const box = await page.evaluate(() => {
                const group = document.getElementById('ai-connections-group');
                // The settings live in a scrolling sidebar: bring the panel to its top
                // and frame the part of the sidebar that shows it.
                let scroller = group.parentElement;
                while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
                if (scroller) scroller.scrollTop += group.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
                const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
                const rect = group.getBoundingClientRect();
                const top = Math.max(rect.top, view.top, 0);
                const bottom = Math.min(rect.bottom, view.bottom, window.innerHeight);
                return { x: Math.max(0, rect.left), y: top, width: rect.width, height: Math.max(40, bottom - top) };
            });
            await page.screenshot({ path: process.env.AI_CONN_PROBE_SHOT, clip: box });
            console.log(`  (panel screenshot → ${process.env.AI_CONN_PROBE_SHOT})`);
        } catch (error) {
            console.log(`  (panel screenshot skipped: ${error.message})`);
        }
    }

    // ── the file on disk ────────────────────────────────────────────────────
    const userData = process.env.YTA_TEST_USER_DATA_DIR ? path.resolve(process.env.YTA_TEST_USER_DATA_DIR) : '';
    const candidates = userData
        ? [userData, ...[1, 2, 3].map((n) => `${userData}-${n}`)].map((dir) => path.join(dir, 'ai-connections.json'))
        : [];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    const onDisk = file ? fs.readFileSync(file, 'utf8') : '';
    ok('the setup is saved in the user folder', !!file, candidates.join(' | '));
    ok('the key is not on disk in the clear', !!onDisk && !onDisk.includes(SECRET) && /"enc": "safe"/.test(onDisk));

    // ── clean up through the UI ─────────────────────────────────────────────
    await page.evaluate(() => {
        const del = [...document.querySelectorAll('#ai-connections-list button')].find((b) => b.textContent === 'Delete');
        del.click();
    });
    await wait(800);
    const final = await page.evaluate(async () => window.electronAPI.aiConnectionsGet());
    ok('Delete removes it and returns Thinking to built-in', !final.connections.length && !final.jobs.thinking.primary, JSON.stringify(final.jobs));

    console.log(`\n${fail ? '❌' : '✅'} runtime AI connections: ${pass} passed, ${fail} failed`);
    await browser.disconnect();
    mock.close();
    process.exit(fail ? 1 : 0);
})().catch((error) => {
    console.error(`[runtime-ai-connections-probe] ${error.stack || error.message}`);
    mock.close();
    process.exit(1);
});
