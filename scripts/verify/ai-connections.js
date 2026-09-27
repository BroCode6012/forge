#!/usr/bin/env node
// scripts/verify/ai-connections.js
// ============================================================================
// Gate for AI Connections — the universal plug. Runs a FAKE OpenAI-compatible
// server on localhost and proves, without spending a cent:
//   A  every text task the router knows belongs to exactly one job
//   B  addresses and connections are checked in plain words
//   C  jobs resolve to the right connections (and to built-in by default)
//   D  the transport talks the protocol: keys, dialect learning, <think>
//      stripping, retries, images, model listing, the Test button
//   E  ai-provider routes through it — text, vision, multi-frame — and
//      leaves built-in jobs on the built-in route
//   F  the store keeps keys encrypted and never hands them to the UI
//   G  the app is wired to it
// ============================================================================
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.COST_TRACKER = 'on';
delete process.env.FORGE_AI_CONNECTIONS;

const connections = require(path.join(ROOT, 'src/brain/connections'));
const transport = require(path.join(ROOT, 'src/brain/connection-transport'));
const { createAiConnectionsStore } = require(path.join(ROOT, 'src/settings/ai-connections-store'));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// ── the fake server ─────────────────────────────────────────────────────────
const seen = [];
let flakyServed = 0;
function reply(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
}
function chat(content, extra = {}) {
    return { choices: [{ message: { content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } };
}
const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        const auth = req.headers.authorization || '';
        const apiKey = req.headers['api-key'] || '';
        seen.push({ url: req.url, method: req.method, body, auth, apiKey });
        const azure = req.url.startsWith('/azure/');
        const open = req.url.startsWith('/open/');
        const authorized = open || (azure ? apiKey === 'secret' : auth === 'Bearer secret');
        if (!authorized) return reply(res, 401, { error: { message: 'invalid api key' } });
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            return reply(res, 200, { data: [{ id: 'mock-text' }, { id: 'mock-vision' }] });
        }
        if (!req.url.endsWith('/chat/completions')) return reply(res, 404, { error: { message: 'not found' } });
        const model = body.model;
        const content = body.messages[body.messages.length - 1].content;
        const images = Array.isArray(content) ? content.filter((part) => part.type === 'image_url') : [];
        if (model === 'strict-tokens' && body.max_tokens !== undefined) {
            return reply(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
        }
        if (model === 'strict-temp' && body.temperature !== undefined && body.temperature !== 1) {
            return reply(res, 400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } });
        }
        if (model === 'flaky' && flakyServed++ === 0) {
            return reply(res, 429, { error: { message: 'slow down' } }, { 'Retry-After': '0' });
        }
        if (model === 'thinker') {
            return reply(res, 200, chat('<think>weighing options at length</think>FINAL ANSWER', { reasoning_content: 'hidden' }));
        }
        if (images.length) {
            if (model === 'mock-text') return reply(res, 400, { error: { message: 'this model does not accept image input' } });
            return reply(res, 200, chat(images.length > 1 ? `saw ${images.length} frames` : 'Red'));
        }
        const text = String(content);
        if (/Reply with exactly the word: READY/.test(text)) return reply(res, 200, chat('READY'));
        return reply(res, 200, chat(`MOCK says: ${text.slice(0, 60)}`));
    });
});

function conn(extra = {}) {
    return {
        id: 'mock', label: 'Mock', preset: 'custom', baseUrl: `${BASE}/v1`, auth: 'bearer', apiKey: 'secret',
        textModel: 'mock-text', visionModel: 'mock-vision', canSee: true, reasoning: false,
        tokenParam: 'auto', temperature: 'auto', maxConcurrency: 4, timeoutMs: 0, ...extra,
    };
}

let BASE = '';

(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    BASE = `http://127.0.0.1:${server.address().port}`;

    // ── A. jobs cover the router ────────────────────────────────────────────
    console.log('\n=== A. jobs cover every text task ===');
    {
        const src = read('src/brain/ai-provider.js');
        const m = /_TEXT_TASK_PROFILES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
        const tasks = m ? [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]) : [];
        ok('the router task list was found', tasks.length >= 10, String(tasks.length));
        const owners = tasks.map((task) => Object.values(connections.JOBS).filter((job) => job.tasks.includes(task)).length);
        ok('every text task belongs to exactly one job', owners.every((n) => n === 1), tasks.filter((_, i) => owners[i] !== 1).join(','));
        ok('the thinking job owns the planner and graphics tasks', ['brain', 'planner-large', 'motion-graphics', 'template'].every((t) => connections.jobForTask(t) === 'thinking'));
        ok('small tasks are everyday', ['utility', 'classifier', 'general'].every((t) => connections.jobForTask(t) === 'everyday'));
        ok('an unknown task lands on everyday, not nowhere', connections.jobForTask('weird') === 'everyday');
        ok('the eyes job is the vision job', connections.JOBS.eyes.vision === true);
        const ids = connections.PRESETS.map((p) => p.id);
        ok('preset ids are unique', new Set(ids).size === ids.length);
        ok('every preset has a valid key mode', connections.PRESETS.every((p) => connections.AUTH_MODES.includes(p.auth)));
        ok('the GPU presets exist', ['modal-vllm', 'digitalocean-vllm', 'cloud-vm-vllm', 'azure-foundry'].every((id) => ids.includes(id)));
    }

    // ── B. plain-English checks ─────────────────────────────────────────────
    console.log('\n=== B. addresses and connections are checked ===');
    {
        ok('a pasted /chat/completions is trimmed off', connections.normalizeBaseUrl(' https://x.modal.run/v1/chat/completions/ ') === 'https://x.modal.run/v1');
        ok('a trailing slash is trimmed', connections.normalizeBaseUrl('http://1.2.3.4:8000/v1/') === 'http://1.2.3.4:8000/v1');
        const problems = connections.validateConnection({ label: '', baseUrl: 'https://<workspace>--x.modal.run/v1', textModel: '', auth: 'bearer', needsKey: true });
        ok('an empty name is reported', problems.some((p) => /name/.test(p)));
        ok('a left-over <placeholder> is reported', problems.some((p) => /placeholders/.test(p)));
        ok('a missing model is reported', problems.some((p) => /model name/.test(p)));
        ok('a missing key is reported when needed', problems.some((p) => /key is missing/.test(p)));
        ok('a good connection passes', connections.validateConnection({ ...conn(), needsKey: true }).length === 0);
        ok('a bad address scheme is reported', connections.validateConnection({ label: 'x', baseUrl: 'ftp://x', textModel: 'm' }).some((p) => /http/.test(p)));
    }

    // ── C. job resolution ───────────────────────────────────────────────────
    console.log('\n=== C. jobs resolve to connections ===');
    {
        connections.setRuntime(null);
        ok('with nothing set, every job is built-in', ['thinking', 'everyday', 'eyes'].every((j) => connections.routeForJob(j) === null));
        connections.setRuntime({
            connections: [conn(), conn({ id: 'second', label: 'Second', visionModel: '', canSee: false })],
            jobs: { thinking: { primary: 'mock', backup: 'second' }, everyday: { primary: 'second', backup: 'builtin' }, eyes: { primary: 'second' } },
        });
        const thinking = connections.routeForJob('thinking');
        ok('thinking uses its primary then its backup', thinking.connections.map((c) => c.id).join(',') === 'mock,second' && thinking.builtInBackup === false);
        const everyday = connections.routeForJob('everyday');
        ok('a built-in backup is honoured', everyday.connections[0].id === 'second' && everyday.builtInBackup === true);
        ok('eyes on a connection that cannot see falls back to built-in', connections.routeForJob('eyes') === null);
        connections.setRuntime({ connections: [conn()], jobs: { thinking: { primary: 'gone' } } });
        ok('a job naming a deleted connection falls back to built-in', connections.routeForJob('thinking') === null);
        connections.setRuntime(null);
        process.env.FORGE_AI_CONNECTIONS = JSON.stringify({ connections: [conn()], jobs: { eyes: { primary: 'mock' } } });
        ok('a build child reads the setup from its environment', connections.routeForJob('eyes')?.connections[0].id === 'mock');
        delete process.env.FORGE_AI_CONNECTIONS;
        ok('the description names each job', /Thinking: built-in setup/.test(connections.describeRuntime()));
    }

    // ── D. transport ────────────────────────────────────────────────────────
    console.log('\n=== D. the transport speaks the protocol ===');
    {
        seen.length = 0;
        const text = await transport.chatText(conn(), { prompt: 'hello there', maxTokens: 50, temperature: 0.2, systemPrompt: 'be brief' });
        const last = seen[seen.length - 1];
        ok('text reaches /chat/completions with a Bearer key', last.url === '/v1/chat/completions' && last.auth === 'Bearer secret');
        ok('the body has model, messages and max_tokens', last.body.model === 'mock-text' && last.body.max_tokens === 50 && last.body.messages[0].role === 'system');
        ok('the reply text comes back', /MOCK says: hello there/.test(text.text));

        await transport.chatText(conn({ id: 'az', baseUrl: `${BASE}/azure/v1`, auth: 'api-key' }), { prompt: 'hi' });
        ok('Azure-style connections send the api-key header', seen[seen.length - 1].apiKey === 'secret' && !seen[seen.length - 1].auth);
        await transport.chatText(conn({ id: 'open', baseUrl: `${BASE}/open/v1`, auth: 'none', apiKey: '' }), { prompt: 'hi' });
        ok('keyless connections send no key', !seen[seen.length - 1].auth && !seen[seen.length - 1].apiKey);

        transport.forgetDialect();
        const strict = conn({ id: 'strict', textModel: 'strict-tokens' });
        const r1 = await transport.chatText(strict, { prompt: 'x', maxTokens: 30 });
        ok('a server that refuses max_tokens is answered with max_completion_tokens', /MOCK says/.test(r1.text) && seen[seen.length - 1].body.max_completion_tokens === 30);
        ok('the dialect is remembered for that connection', transport.learnedDialect('strict').tokenParam === 'max_completion_tokens');
        const before = seen.length;
        await transport.chatText(strict, { prompt: 'again', maxTokens: 30 });
        ok('the next call goes straight to the right spelling (one request)', seen.length - before === 1);

        const temp = conn({ id: 'temp', textModel: 'strict-temp' });
        const r2 = await transport.chatText(temp, { prompt: 'x', temperature: 0.2 });
        ok('a server that refuses temperature is answered without it', /MOCK says/.test(r2.text) && seen[seen.length - 1].body.temperature === undefined);

        const thinker = await transport.chatText(conn({ id: 'think', textModel: 'thinker' }), { prompt: 'x' });
        ok('a leading <think> block is stripped', thinker.text === 'FINAL ANSWER');
        ok('a separate reasoning field is noticed', thinker.hadReasoning === true);

        flakyServed = 0;
        const flaky = await transport.chatText(conn({ id: 'flaky', textModel: 'flaky' }), { prompt: 'x' });
        ok('a 429 is waited out and retried', /MOCK says/.test(flaky.text) && flakyServed === 2);

        const seenImage = await transport.chatVision(conn(), { prompt: 'colour?', images: [{ base64: transport.RED_SQUARE_PNG, mimeType: 'image/png' }] });
        const visionBody = seen[seen.length - 1].body;
        ok('an image travels as an image_url data URL', visionBody.model === 'mock-vision' && /^data:image\/png;base64,/.test(visionBody.messages[0].content[1].image_url.url));
        ok('the vision reply comes back', seenImage.text === 'Red');
        const frames = await transport.chatVision(conn(), { prompt: 'what happens?', images: [{ base64: 'AAAA' }, { base64: 'BBBB' }, { base64: 'CCCC' }] });
        ok('several frames go in ONE request', frames.text === 'saw 3 frames');

        const models = await transport.listModels(conn());
        ok('the server model list is read', models.join(',') === 'mock-text,mock-vision');

        const good = await transport.testConnection(conn());
        ok('Test passes on a working connection', good.ok === true && good.canSee === true, JSON.stringify(good.steps));
        ok('Test explains each step in words', good.steps.length === 3 && good.steps.every((s) => typeof s.detail === 'string' && s.detail.length > 3));
        const wrongKey = await transport.testConnection(conn({ id: 'bad', apiKey: 'nope' }));
        ok('a wrong key is reported as a refused key', wrongKey.ok === false && wrongKey.steps.some((s) => /key was refused/.test(s.detail)));
        const textOnly = await transport.testConnection(conn({ id: 'textonly', visionModel: '' }));
        ok('a text-only model passes for text and is marked unable to see', textOnly.ok === true && textOnly.canSee === false);
        const t0 = Date.now();
        const down = await transport.testConnection(conn({ id: 'down', baseUrl: 'http://127.0.0.1:9/v1' }));
        ok('a switched-off server is reported quickly and in words', down.ok === false && Date.now() - t0 < 10_000 && down.steps.some((s) => /refused the connection|nothing answers/.test(s.detail)), `${Date.now() - t0}ms ${JSON.stringify(down.steps)}`);
    }

    // ── E. ai-provider integration ──────────────────────────────────────────
    console.log('\n=== E. the AI brain routes through connections ===');
    {
        const ai = require(path.join(ROOT, 'src/brain/ai-provider'));
        const costs = require(path.join(ROOT, 'src/brain/cost-tracker'));
        connections.setRuntime(null);
        const builtInRoute = ai.textRouteFor('planner-large');
        ok('with no connections, the built-in route is untouched', !builtInRoute.entries.some((e) => e.connectionId));

        connections.setRuntime({ connections: [conn()], jobs: { thinking: { primary: 'mock' }, eyes: { primary: 'mock' } } });
        const route = ai.textRouteFor('planner-large');
        ok('a thinking task routes to its connection', route.entries.length === 1 && route.entries[0].connectionId === 'mock');
        const everydayRoute = ai.textRouteFor('utility');
        ok('an everyday task left on built-in keeps the built-in route', !everydayRoute.entries.some((e) => e.connectionId));

        costs.resetCosts();
        process.env.AI_INSTRUCTIONS = 'cinematic, no text cards';
        seen.length = 0;
        const answer = await ai.callAI('Plan the scenes please', { taskType: 'planner-large', maxTokens: 200, temperature: 0.3 });
        delete process.env.AI_INSTRUCTIONS;
        ok('callAI returns the connection\'s answer', /^MOCK says:/.test(answer), answer);
        ok('the creator\'s production directives still reach the thinking job', /PRODUCTION DIRECTIVES/.test(JSON.stringify(seen[seen.length - 1].body.messages)));

        seen.length = 0;
        const verdict = await ai.callVisionAI('What colour?', transport.RED_SQUARE_PNG, 'image/png', { maxTokens: 50 });
        ok('callVisionAI is answered by the eyes connection', verdict === 'Red', verdict);
        ok('the vision chain is just that connection', ai.getVisionProviderChain().join(',') === 'connection:mock');
        ok('vision counts as available even with no built-in vision', ai.isVisionAIAvailable() === true);

        // Real pictures: callVideoAI rightly drops frames it cannot decode.
        const frame = { base64: transport.RED_SQUARE_PNG, mimeType: 'image/png' };
        const video = await ai.callVideoAI('Describe', [frame, { ...frame }], { maxTokens: 50 });
        ok('multi-frame checks go to the eyes connection in one request', video === 'saw 2 frames', video);

        const report = costs.getCostReport();
        ok('the cost report counts calls under the connection', Object.keys(report.byProvider).includes('conn:mock'), JSON.stringify(Object.keys(report.byProvider)));

        connections.setRuntime({ connections: [conn()], jobs: { eyes: { primary: 'mock', backup: 'builtin' } } });
        const chain = ai.getVisionProviderChain();
        ok('a built-in backup follows the connection in the vision chain', chain[0] === 'connection:mock');

        // A build is a separate process that only has its environment. Prove the
        // whole path there: env → connections → ai-provider → the server.
        // Async on purpose: a blocking call would freeze this process — and the
        // fake server lives in this process.
        const { execFile } = require('child_process');
        const childOut = await new Promise((resolve) => execFile(process.execPath, ['-e', `
            const ai = require(${JSON.stringify(path.join(ROOT, 'src/brain/ai-provider'))});
            ai.callAI('child build asks', { taskType: 'brain', maxTokens: 100 })
                .then((text) => { console.log('CHILD-RESULT:' + text); process.exit(0); })
                .catch((error) => { console.log('CHILD-ERROR:' + error.message); process.exit(0); });
        `], {
            env: { ...process.env, FORGE_AI_CONNECTIONS: JSON.stringify({ connections: [conn()], jobs: { thinking: { primary: 'mock' } } }) },
            encoding: 'utf8',
            timeout: 60_000,
        }, (error, stdout) => resolve(String(stdout || '') + (error ? `\nCHILD-ERROR:${error.message}` : ''))));
        ok('a build process routes through the connection from its environment', /CHILD-RESULT:MOCK says: child build asks/.test(childOut), childOut.split('\n').filter((l) => /CHILD-/.test(l)).join(' '));

        connections.setRuntime({ connections: [conn()], jobs: { eyes: { primary: 'mock' } } });
        const gpu = await require(path.join(ROOT, 'src/vision/vision-gpu')).ensureReady();
        ok('the rented vision GPU is not woken when Eyes is on a connection', gpu.skipped === true && /AI connection/.test(gpu.reason), JSON.stringify(gpu));
        connections.setRuntime(null);
    }

    // ── F. store ────────────────────────────────────────────────────────────
    console.log('\n=== F. keys are kept safe ===');
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-aiconn-'));
        const fakeCrypto = {
            available: () => true,
            encrypt: (text) => `ENC(${Buffer.from(text).toString('hex')})`,
            decrypt: (data) => Buffer.from(String(data).slice(4, -1), 'hex').toString(),
        };
        try {
            const store = createAiConnectionsStore({ userDataDir: dir, crypto: fakeCrypto });
            const saved = store.saveConnection({ preset: 'modal-vllm', label: 'Modal Qwen', baseUrl: `${BASE}/v1/`, apiKey: 'sk-very-secret', textModel: 'mock-text' });
            ok('a connection saves', saved.ok === true && saved.id === 'modal-qwen', JSON.stringify(saved));
            const onDisk = fs.readFileSync(store.filePath, 'utf8');
            ok('the key is not on disk in the clear', !onDisk.includes('sk-very-secret') && onDisk.includes('ENC('));
            const view = store.publicView();
            ok('the UI view never contains the key', !JSON.stringify(view).includes('sk-very-secret') && view.connections[0].hasKey === true);
            ok('the UI view says the key is encrypted', view.connections[0].keyProtection === 'encrypted');
            ok('the address was cleaned on save', view.connections[0].baseUrl === `${BASE}/v1`);
            store.saveConnection({ id: 'modal-qwen', preset: 'modal-vllm', label: 'Modal Qwen', baseUrl: `${BASE}/v1`, apiKey: '', textModel: 'mock-text' });
            ok('saving with an empty key field keeps the saved key', store.resolved().connections[0].apiKey === 'sk-very-secret');
            ok('resolved() hands AI calls the real key', store.resolved().connections[0].apiKey === 'sk-very-secret');
            const draft = store.draftForTest({ id: 'modal-qwen', baseUrl: `${BASE}/v1`, textModel: 'mock-text' });
            ok('a Test of a saved connection uses the stored key', draft.conn.apiKey === 'sk-very-secret' && draft.problems.length === 0);
            ok('jobs reject a connection that cannot see for Eyes', store.setJobs({ eyes: { primary: 'modal-qwen' } }).ok === false);
            ok('jobs reject an unknown connection', store.setJobs({ thinking: { primary: 'nope' } }).ok === false);
            ok('jobs accept a real connection', store.setJobs({ thinking: { primary: 'modal-qwen', backup: 'builtin' } }).ok === true);
            store.recordTest('modal-qwen', { ok: true, canSee: true, steps: [{ name: 'x', ok: true, detail: 'fine' }], dialect: {} });
            ok('a passing picture test lets it serve Eyes', store.setJobs({ eyes: { primary: 'modal-qwen' } }).ok === true);
            store.saveConnection({ id: 'modal-qwen', preset: 'modal-vllm', label: 'Modal Qwen', baseUrl: `${BASE}/v2`, textModel: 'mock-text' });
            ok('changing the address forgets the old test', store.publicView().connections[0].lastTest === null);
            store.deleteConnection('modal-qwen');
            ok('deleting a connection returns its jobs to built-in', store.publicView().jobs.thinking.primary === '' && store.publicView().jobs.eyes.primary === '');

            const plainStore = createAiConnectionsStore({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'forge-aiconn-plain-')), crypto: { available: () => false, encrypt: () => { throw new Error('no'); }, decrypt: () => { throw new Error('no'); } } });
            plainStore.saveConnection({ preset: 'custom', label: 'Local', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', textModel: 'm' });
            ok('without OS encryption the key still works and is labelled honestly', plainStore.resolved().connections[0].apiKey === 'k' && plainStore.publicView().connections[0].keyProtection === 'not encrypted');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // ── G. wiring ───────────────────────────────────────────────────────────
    console.log('\n=== G. app wiring ===');
    {
        const main = read('main.js');
        const preload = read('preload.js');
        const html = read('ui/index.html');
        const panel = read('ui/js/ai-connections-panel.js');
        ok('main.js loads connections at start-up', main.includes('_applyAiConnections();'));
        ok('main.js exposes get / save / test', ['ai-connections-get', 'ai-connections-save', 'ai-connections-test'].every((c) => main.includes(`ipcMain.handle('${c}'`)));
        ok('keys are encrypted with the OS keychain', main.includes('safeStorage.encryptString'));
        ok('the build receives the setup in ITS environment only', main.includes('buildEnv.FORGE_AI_CONNECTIONS = _aiConnJson;') && !main.includes('process.env.FORGE_AI_CONNECTIONS ='));
        ok('preload exposes the three calls', ['aiConnectionsGet:', 'aiConnectionsSave:', 'aiConnectionsTest:'].every((m) => preload.includes(m)));
        ok('index.html loads the panel', html.includes('js/ai-connections-panel.js') && html.includes('id="ai-connections-group"'));
        ok('the panel never builds HTML from strings', !/innerHTML/.test(panel));
        ok('the panel never asks for a key back', !/apiKey\s*:\s*conn\./.test(panel));
    }

    server.close();
    console.log(`\n${fail ? '❌' : '✅'} AI connections: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((error) => {
    console.error(error);
    server.close();
    process.exit(1);
});
