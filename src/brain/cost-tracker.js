/**
 * Per-run AI cost tracker.
 *
 * Every AI call (text or vision) reports token usage; this module prices that usage
 * from a flexible registry and accumulates per-run totals broken down by provider,
 * model, and task. Designed so adding a NEW provider is a one-liner: just add its
 * model price below (or via config) and call recordUsage() from the provider fn.
 *
 * Prices are USD per 1,000,000 tokens. Override the defaults (recommended for
 * accuracy — Bedrock region rates and the AiLink proxy rate are yours to set):
 *   • env COST_PRICES = '{"gpt-5.5":{"in":1.25,"out":10,"cachedIn":0.125}}'
 *   • or a cost-prices.json file in the project dir (PROJECT_DIR), same shape.
 * Model keys match by exact id OR substring (so "us.anthropic.claude-sonnet-4-6-v1:0"
 * resolves via the "claude-sonnet-4-6" entry). Any model with NO price is still
 * COUNTED (tokens tracked) and flagged in the report so you know to add its rate.
 *
 * Disable with COST_TRACKER=off.
 */

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// WHY a call was made, for the report only. A caller wraps its work in
// withCostPurpose('race-candidate', () => ...) and every AI call made inside it —
// however deep, across awaits — is also counted under `byPurpose` as
// "<task>:<purpose>". It never touches routing, the taskType, or the byTask
// numbers: "vision" stays one line in byTask exactly as before, and byPurpose
// says which part of the build those vision calls were spent on. The innermost
// label wins, so a stage can refine the label its caller set.
const _purposeStore = new AsyncLocalStorage();
function withCostPurpose(purpose, fn) {
    const label = String(purpose || '').trim();
    if (!label || typeof fn !== 'function') return fn();
    return _purposeStore.run(label, fn);
}
function currentCostPurpose() {
    return _purposeStore.getStore() || '';
}

// USD per 1M tokens. cachedIn = rate for cached input tokens (defaults to in if unset).
// These are starting estimates — set your real rates via COST_PRICES / cost-prices.json.
const DEFAULT_PRICES = {
    // AiLink proxy (GPT-5.5) — DERIVED from the AiLink usage dashboard
    // ($96.94 / 1.75M tokens ≈ $55/1M blended; row algebra ≈ $35 in / $210 out /
    // $3.5 cached). This proxy is EXPENSIVE (~20-25× raw GPT-5 rates) — CONFIRM the
    // exact per-token rate and adjust. NOTE: log-replay can't see cached tokens, so a
    // replay over-prices AiLink input; the LIVE build captures cached correctly.
    'gpt-5.5':                  { in: 35.00, out: 210.00, cachedIn: 3.50 },
    // Anthropic (via Bedrock)
    'claude-sonnet-4-6':        { in: 3.00, out: 15.00, cachedIn: 0.30 },
    'claude-haiku-4-5':         { in: 1.00, out: 5.00,  cachedIn: 0.10 },
    // Claude via the APlink relay (aplink.top) — ¥1.6/¥8 per 1M ≈ $0.22/$1.11.
    'claude-opus-4-6':          { in: 0.22, out: 1.11 },
    'claude-3-5-haiku':         { in: 1.00, out: 5.00,  cachedIn: 0.10 },
    // DeepSeek (via Bedrock) — official US-East rate from AWS pricing page
    'deepseek.v3':              { in: 0.62, out: 1.85 },
    'v3.2':                     { in: 0.62, out: 1.85 },   // shortened bedrock log name
    'deepseek':                 { in: 0.62, out: 1.85 },
    // Amazon Nova (vision fallback)
    'nova-lite':                { in: 0.06, out: 0.24 },
    'nova-pro':                 { in: 0.80, out: 3.20 },
    // Qwen3-VL-235B (via Bedrock, vision) — calibrated to AWS Cost Explorer actuals
    // for this build ($5.19 in / $0.34 out over ~9.7M in / ~128K out tokens).
    'qwen3-vl':                 { in: 0.53, out: 2.66 },
    'qwen-vl':                  { in: 0.53, out: 2.66 },
    'qwen':                     { in: 0.53, out: 2.66 },
    // xAI Grok (via Vertex)
    'grok-4':                   { in: 3.00, out: 15.00 },
};

function _loadOverrides() {
    let prices = { ...DEFAULT_PRICES };
    // env JSON
    try {
        if (process.env.COST_PRICES) {
            const parsed = JSON.parse(process.env.COST_PRICES);
            if (parsed && typeof parsed === 'object') prices = { ...prices, ...parsed };
        }
    } catch (e) { console.warn(`[Cost] COST_PRICES env is not valid JSON — ignored (${e.message})`); }
    // project file
    try {
        const dir = process.env.PROJECT_DIR || process.cwd();
        const file = path.join(dir, 'cost-prices.json');
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (parsed && typeof parsed === 'object') prices = { ...prices, ...parsed };
        }
    } catch (e) { console.warn(`[Cost] cost-prices.json ignored (${e.message})`); }
    return prices;
}

let _prices = _loadOverrides();
function reloadPrices() { _prices = _loadOverrides(); }

function _priceFor(model) {
    const key = String(model || '').toLowerCase();
    if (!key) return null;
    if (_prices[key]) return _prices[key];                       // exact
    for (const [pat, price] of Object.entries(_prices)) {        // substring
        if (pat && key.includes(pat.toLowerCase())) return price;
    }
    return null;
}

// ── accumulator ────────────────────────────────────────────────────────────
function _fresh() {
    return { calls: 0, inTokens: 0, outTokens: 0, cachedInTokens: 0, reasoningTokens: 0, usd: 0 };
}
let _run = {
    startedAt: Date.now(),
    total: _fresh(),
    byProvider: {},   // "ailink" -> bucket
    byModel: {},      // "ailink:gpt-5.5" -> bucket
    byTask: {},       // "planner-large" -> bucket
    byPurpose: {},    // "vision:race-candidate" -> bucket (only calls made inside withCostPurpose)
    unpriced: {},     // "model" -> { calls, inTokens, outTokens }
};

function _bucket(map, key) { return (map[key] = map[key] || _fresh()); }
function _add(b, inTok, outTok, cachedIn, reasoning, usd) {
    b.calls++; b.inTokens += inTok; b.outTokens += outTok;
    b.cachedInTokens += cachedIn; b.reasoningTokens += reasoning; b.usd += usd;
}

function resetCosts() {
    _run = { startedAt: Date.now(), total: _fresh(), byProvider: {}, byModel: {}, byTask: {}, byPurpose: {}, unpriced: {} };
    reloadPrices();
}

/**
 * Record one AI call's usage. Pass the provider's NATIVE usage object — field names
 * are normalized (prompt_tokens|inputTokens, completion_tokens|outputTokens, …).
 * @param {{provider:string, model:string, taskType?:string, kind?:string, usage:object}} entry
 */
function recordUsage(entry = {}) {
    if (String(process.env.COST_TRACKER || 'on').toLowerCase() === 'off') return;
    const u = entry.usage || {};
    const inTok = Number(u.prompt_tokens ?? u.inputTokens ?? u.input_tokens ?? 0) || 0;
    const outTok = Number(u.completion_tokens ?? u.outputTokens ?? u.output_tokens ?? 0) || 0;
    const cachedIn = Number(u.prompt_tokens_details?.cached_tokens ?? u.cachedInputTokens ?? u.cacheReadInputTokens ?? 0) || 0;
    const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? u.reasoningTokens ?? 0) || 0;
    if (inTok === 0 && outTok === 0) return;

    const provider = String(entry.provider || 'unknown').toLowerCase();
    const model = String(entry.model || 'unknown');
    const task = String(entry.taskType || entry.kind || 'general');

    const price = _priceFor(model);
    let usd = 0;
    if (price) {
        const billedIn = Math.max(0, inTok - cachedIn);
        const cachedRate = price.cachedIn != null ? price.cachedIn : price.in;
        usd = (billedIn * price.in + cachedIn * cachedRate + outTok * price.out) / 1_000_000;
    } else {
        const ub = _bucket(_run.unpriced, model);
        ub.calls++; ub.inTokens += inTok; ub.outTokens += outTok;
    }

    _add(_run.total, inTok, outTok, cachedIn, reasoning, usd);
    _add(_bucket(_run.byProvider, provider), inTok, outTok, cachedIn, reasoning, usd);
    _add(_bucket(_run.byModel, `${provider}:${model}`), inTok, outTok, cachedIn, reasoning, usd);
    _add(_bucket(_run.byTask, task), inTok, outTok, cachedIn, reasoning, usd);
    const purpose = currentCostPurpose();
    _add(_bucket(_run.byPurpose, `${task}:${purpose || 'unlabelled'}`), inTok, outTok, cachedIn, reasoning, usd);
}

function getCostReport() {
    return JSON.parse(JSON.stringify({ ..._run, elapsedSec: (Date.now() - _run.startedAt) / 1000 }));
}

const _usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const _k = (n) => (Number(n) || 0).toLocaleString('en-US');

function logCostReport(log = console.log) {
    const r = _run;
    log(`\n══ 💰 AI Cost Report (this run) ══════════════════════════════════`);
    log(`   TOTAL: ${_usd(r.total.usd)}  ·  ${r.total.calls} calls  ·  in ${_k(r.total.inTokens)} (cached ${_k(r.total.cachedInTokens)}) / out ${_k(r.total.outTokens)} tokens`);
    const rows = Object.entries(r.byModel).sort((a, b) => b[1].usd - a[1].usd);
    if (rows.length) {
        log(`   By model:`);
        for (const [name, b] of rows) {
            log(`     ${name.padEnd(34)} ${_usd(b.usd).padStart(11)}  (${b.calls} calls · in ${_k(b.inTokens)} / out ${_k(b.outTokens)})`);
        }
    }
    const tasks = Object.entries(r.byTask).sort((a, b) => b[1].usd - a[1].usd);
    if (tasks.length) {
        log(`   By task:`);
        for (const [name, b] of tasks) log(`     ${name.padEnd(22)} ${_usd(b.usd).padStart(11)}  (${b.calls})`);
    }
    const purposes = Object.entries(r.byPurpose || {}).sort((a, b) => b[1].calls - a[1].calls);
    if (purposes.some(([name]) => !name.endsWith(':unlabelled'))) {
        log(`   By purpose (what the calls were for):`);
        for (const [name, b] of purposes) log(`     ${name.padEnd(34)} ${_usd(b.usd).padStart(11)}  (${b.calls})`);
    }
    const unpriced = Object.entries(r.unpriced);
    if (unpriced.length) {
        log(`   ⚠️  No price set (tokens counted, $ not — add to COST_PRICES / cost-prices.json):`);
        for (const [model, b] of unpriced) log(`     ${model}  —  ${b.calls} calls, in ${_k(b.inTokens)} / out ${_k(b.outTokens)} tokens`);
    }
    log(`══════════════════════════════════════════════════════════════════\n`);
}

function writeCostReport(filePath) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(getCostReport(), null, 2), 'utf8');
        return true;
    } catch (e) { console.warn(`[Cost] could not write report: ${e.message}`); return false; }
}

module.exports = { recordUsage, resetCosts, getCostReport, logCostReport, writeCostReport, reloadPrices, withCostPurpose, currentCostPurpose, DEFAULT_PRICES };
