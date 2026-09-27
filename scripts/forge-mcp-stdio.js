#!/usr/bin/env node
// scripts/forge-mcp-stdio.js
// ============================================================================
// stdio <-> HTTP bridge for agents that can only launch a local MCP command
// (some desktop clients) instead of calling an MCP URL. It adds nothing of its
// own: every message is forwarded verbatim to the running app's /mcp endpoint
// and the reply is written back on stdout.
//
//   node scripts/forge-mcp-stdio.js [--url http://127.0.0.1:47821/mcp] [--key <access key>]
//
// With no arguments it reads the address and key from the app's own
// agent-access.json, so a client config needs no secrets in it.
// Agents that support MCP over HTTP should skip this and use the URL directly:
//   claude mcp add --transport http forge http://127.0.0.1:47821/mcp \
//       --header "Authorization: Bearer <access key>"
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function argValue(flag) {
    const index = process.argv.indexOf(flag);
    return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : '';
}

function readAccessFile() {
    const candidates = [];
    if (process.env.FORGE_AGENT_CONFIG) candidates.push(process.env.FORGE_AGENT_CONFIG);
    const roots = [
        process.env.APPDATA,
        process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : '',
        path.join(os.homedir(), '.config'),
    ].filter(Boolean);
    for (const root of roots) {
        for (const appName of ['yta-empire-webgl', 'Forge']) {
            candidates.push(path.join(root, appName, 'agent-access.json'));
        }
    }
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            if (parsed && typeof parsed.token === 'string') return parsed;
        } catch (_) { /* try the next one */ }
    }
    return null;
}

const stored = readAccessFile();
const url = argValue('--url')
    || process.env.FORGE_AGENT_URL
    || `http://127.0.0.1:${stored?.port || 47821}/mcp`;
const key = argValue('--key') || process.env.FORGE_AGENT_KEY || stored?.token || '';

if (!key) {
    process.stderr.write('[forge-mcp] No access key. Turn on Agent access in Forge (AI settings), then pass --key or set FORGE_AGENT_KEY.\n');
    process.exit(1);
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function forward(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
    }
    const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.id : null;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: text,
        });
        if (response.status === 202) return; // notification accepted, nothing to reply
        const body = await response.text();
        if (!response.ok && !body.trim().startsWith('{') && !body.trim().startsWith('[')) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        if (body.trim()) process.stdout.write(`${body.trim()}\n`);
    } catch (error) {
        if (id === null || id === undefined) return;
        send({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: `Forge is not reachable at ${url} (${error.message}). Is the app open with Agent access ON?` },
        });
    }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void forward(line);
        newline = buffer.indexOf('\n');
    }
});
process.stdin.on('end', () => process.exit(0));
