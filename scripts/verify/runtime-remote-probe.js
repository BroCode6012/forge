#!/usr/bin/env node
// scripts/verify/runtime-remote-probe.js
// ============================================================================
// Runtime proof for agent remote control: boots the REAL app (through
// runtime-harness.js) and then drives it from outside over HTTP exactly as
// Claude Code / Muse / any other agent would — no Electron internals, no
// renderer shortcuts. It checks that
//   - the access switch really opens and closes the door
//   - MCP handshake + tools/list + tools/call work end to end
//   - a setting written by an agent lands in the real control AND in app state
//   - narration imported by an agent becomes the editor's narration
//   - impossible requests are refused with an explanation
//   - a rendered file downloads, and only from the project's output folder
// ============================================================================
'use strict';

const puppeteer = require('puppeteer-core');

const browserWSEndpoint = process.argv[2];
if (!browserWSEndpoint) {
    console.error('usage: node scripts/verify/runtime-remote-probe.js <browserWsEndpoint>');
    process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
    const pages = await browser.pages();
    const page = pages.find((candidate) => /ui\/index\.html/i.test(candidate.url()));
    if (!page) throw new Error('main renderer page not found');
    await wait(1500);

    // The app tells us where it listens and with which key — the same call the
    // Agent access panel makes. Nothing is hardcoded here.
    const status = await page.evaluate(() => window.electronAPI.remoteAccessStatus());
    ok('the app reports agent access running', status.enabled === true && status.running === true, JSON.stringify(status));
    ok('it listens on loopback only', status.host === '127.0.0.1');
    ok('it generated a strong access key', /^forge_[A-Za-z0-9_-]{40,}$/.test(status.token || ''));

    const base = status.baseUrl;
    const auth = { Authorization: `Bearer ${status.token}`, 'Content-Type': 'application/json' };
    let rpcId = 0;
    const mcp = async (method, params) => {
        const response = await fetch(status.mcpUrl, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        });
        return response.json();
    };
    const call = async (name, args = {}) => {
        const reply = await mcp('tools/call', { name, arguments: args });
        if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
        return reply.result;
    };
    const value = (result) => result.structuredContent;

    // ── the door ────────────────────────────────────────────────────────────
    const anonymous = await fetch(`${base}/api/tools`);
    ok('an agent without the key is refused by the live app', anonymous.status === 401);
    const browserish = await fetch(`${base}/api/tools`, { headers: { ...auth, Origin: 'https://evil.example' } });
    ok('a web page is refused even with the key', browserish.status === 403);

    // ── MCP handshake ───────────────────────────────────────────────────────
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'runtime-probe', version: '1' } });
    ok('MCP initialize succeeds against the live app', init.result?.serverInfo?.name === 'forge', JSON.stringify(init).slice(0, 200));
    ok('the app sends the workflow instructions', /forge_start_build/.test(init.result?.instructions || ''));
    const list = await mcp('tools/list', {});
    const toolNames = (list.result?.tools || []).map((tool) => tool.name);
    ok('the agent can see the tools', toolNames.includes('forge_get_status') && toolNames.includes('forge_start_build'), toolNames.join(','));

    // ── status ──────────────────────────────────────────────────────────────
    const first = value(await call('forge_get_status'));
    ok('status reaches the live window', first.window?.ready === true, JSON.stringify(first).slice(0, 300));
    ok('status names the open project', !!first.project?.name && first.project.isEmptyWorkspace === false);
    ok('status reports idle before anything runs', first.busy === 'idle' && first.window.busy === false);
    ok('status reports the existing plan', first.window.plan?.scenes >= 1, JSON.stringify(first.window.plan));

    // ── settings round trip ─────────────────────────────────────────────────
    const settings = value(await call('forge_get_settings'));
    ok('the agent can read the real settings', typeof settings.settings?.buildTheme === 'string', JSON.stringify(settings.settings || {}).slice(0, 200));
    const themeChoices = (settings.fields?.buildTheme?.allowed || []).map((choice) => choice.value);
    ok('the agent is told the allowed values', themeChoices.includes('crime') && themeChoices.includes('history'), themeChoices.join(','));

    const chosenTheme = themeChoices.find((choice) => choice === 'history') || themeChoices[1];
    const updated = value(await call('forge_update_settings', {
        settings: {
            videoTitle: 'Agent wrote this title',
            aiInstructions: 'cinematic, no text cards',
            buildTheme: chosenTheme,
        },
    }));
    ok('the update reports what it applied', updated.applied?.videoTitle === 'Agent wrote this title', JSON.stringify(updated));

    const landed = await page.evaluate(() => ({
        titleControl: document.getElementById('video-title')?.value,
        instructionsControl: document.getElementById('ai-instructions')?.value,
        themeControl: document.getElementById('build-theme')?.value,
    }));
    ok('the title landed in the real control', landed.titleControl === 'Agent wrote this title', JSON.stringify(landed));
    ok('the AI instructions landed in the real control', landed.instructionsControl === 'cinematic, no text cards');
    ok('the theme landed in the real control', landed.themeControl === chosenTheme);

    const readBack = value(await call('forge_get_settings'));
    ok('reading back returns what the agent wrote', readBack.settings.videoTitle === 'Agent wrote this title' && readBack.settings.buildTheme === chosenTheme);

    const badValue = await call('forge_update_settings', { settings: { buildTheme: 'neon-disco' } });
    ok('an impossible value is refused with the allowed list', badValue.isError === true && /not one of/.test(badValue.content[0].text), badValue.content[0].text.slice(0, 160));
    const stillChosen = await page.evaluate(() => document.getElementById('build-theme')?.value);
    ok('the refused value never touched the app', stillChosen === chosenTheme);

    // ── projects + narration ────────────────────────────────────────────────
    const projects = value(await call('forge_list_projects'));
    ok('the agent can list projects', Array.isArray(projects.projects));

    const noNarration = await call('forge_start_build', {});
    ok('building without narration is refused, with the next step named', noNarration.isError === true && /forge_import_narration/.test(noNarration.content[0].text), noNarration.content[0].text.slice(0, 160));

    const narrationSource = process.env.YTA_PROBE_NARRATION;
    const imported = value(await call('forge_import_narration', { path: narrationSource }));
    ok('the agent can import narration by path', imported.ok === true && /\.wav$/i.test(imported.narration.name), JSON.stringify(imported).slice(0, 200));
    await wait(400);
    const afterImport = value(await call('forge_get_status'));
    ok('the imported narration became the editor narration', /\.wav$/i.test(afterImport.window.narration?.name || ''), JSON.stringify(afterImport.window.narration));
    ok('the app now says it can build', afterImport.window.canBuild === true);
    const narrationOnDisk = await page.evaluate(() => document.getElementById('audio-name')?.textContent || '');
    ok('the narration is visible in the window', /\.wav$/i.test(narrationOnDisk), narrationOnDisk);

    const bothInputs = await call('forge_import_narration', { path: narrationSource, url: 'https://example.com/a.mp3' });
    ok('an ambiguous import is refused', bothInputs.isError === true && /exactly one/.test(bothInputs.content[0].text));
    const privateUrl = await call('forge_import_narration', { url: 'http://127.0.0.1:9/secret.mp3' });
    ok('a private-address download is refused', privateUrl.isError === true && /private|reserved|not an MP3|Download failed/i.test(privateUrl.content[0].text), privateUrl.content[0].text.slice(0, 160));

    // ── logs, videos, downloads ─────────────────────────────────────────────
    const log = value(await call('forge_get_build_log', { lines: 5 }));
    ok('the build log tool answers even with no log yet', log.ok === true);

    const videos = value(await call('forge_list_videos'));
    ok('the rendered video is listed', videos.videos.some((video) => video.name === 'probe-render.mp4'), JSON.stringify(videos).slice(0, 200));
    const download = await fetch(`${base}/files/probe-render.mp4`, { headers: { Authorization: `Bearer ${status.token}` } });
    const downloaded = await download.text();
    ok('the agent can download the rendered file', download.status === 200 && downloaded === 'probe-mp4-bytes', `${download.status} ${downloaded.slice(0, 40)}`);
    const outsideProject = await fetch(`${base}/files/${encodeURIComponent('..\\secret.mp4')}`, { headers: { Authorization: `Bearer ${status.token}` } });
    ok('a file outside the project is refused', outsideProject.status === 404);

    const cancelIdle = value(await call('forge_cancel'));
    ok('cancelling with nothing running is harmless', cancelIdle.cancelled === false);

    // ── the switch really closes the door ───────────────────────────────────
    await page.evaluate(() => window.electronAPI.remoteAccessSet({ enabled: false }));
    await wait(500);
    let closed = false;
    try {
        const afterOff = await fetch(`${base}/health`);
        closed = !afterOff.ok;
    } catch (_) {
        closed = true;
    }
    ok('turning agent access off stops answering', closed);

    const reopened = await page.evaluate(() => window.electronAPI.remoteAccessSet({ enabled: true }));
    await wait(500);
    const afterOn = await fetch(`${reopened.status.baseUrl}/health`);
    ok('turning it back on works', afterOn.status === 200);

    const rotated = await page.evaluate(() => window.electronAPI.remoteAccessSet({ rotateToken: true }));
    await wait(300);
    const withOldKey = await fetch(`${reopened.status.baseUrl}/api/tools`, { headers: { Authorization: `Bearer ${status.token}` } });
    ok('a new key locks out the old one', withOldKey.status === 401);
    const withNewKey = await fetch(`${rotated.status.baseUrl}/api/tools`, { headers: { Authorization: `Bearer ${rotated.status.token}` } });
    ok('the new key works', withNewKey.status === 200);

    // Leave the app as we found it.
    await page.evaluate(() => window.electronAPI.remoteAccessSet({ enabled: false }));

    console.log(`\n${fail ? '❌' : '✅'} runtime remote control: ${pass} passed, ${fail} failed`);
    await browser.disconnect();
    process.exit(fail ? 1 : 0);
})().catch((error) => {
    console.error(`[runtime-remote-probe] ${error.stack || error.message}`);
    process.exit(1);
});
