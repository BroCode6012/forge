// src/remote/access-config.js
// ============================================================================
// Where agent access is remembered: <userData>/agent-access.json —
// { enabled, port, token, createdAt }. It lives OUTSIDE the settings schema on
// purpose: main.js needs it before any window exists, and the renderer's
// localStorage/.fvp layers are not readable that early.
//
// Environment overrides (useful headless / for tests, never required):
//   FORGE_AGENT_SERVER=1|0     force on/off
//   FORGE_AGENT_PORT=<n>       port
//   FORGE_AGENT_HOST=<addr>    bind address (loopback or a Tailscale address;
//                              anything else needs FORGE_AGENT_ALLOW_NETWORK=1)
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 47821;
const FILE_NAME = 'agent-access.json';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function generateToken() {
    return `forge_${crypto.randomBytes(32).toString('base64url')}`;
}

function _envFlag(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return null;
    return /^(1|true|on|yes)$/i.test(String(raw));
}

// Tailscale hands out 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6). Those
// only exist inside the user's own private tailnet, so binding there is as
// deliberate — and as narrow — as loopback. A LAN or 0.0.0.0 bind is a different
// decision and has to be asked for explicitly.
function isAllowedBindHost(host) {
    const value = String(host || '').trim().toLowerCase();
    if (!value) return false;
    if (LOOPBACK.has(value)) return true;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (ipv4) {
        const first = Number(ipv4[1]);
        const second = Number(ipv4[2]);
        return first === 100 && second >= 64 && second <= 127;
    }
    if (value.startsWith('fd7a:115c:a1e0')) return true;
    return false;
}

function resolveBindHost() {
    const requested = String(process.env.FORGE_AGENT_HOST || '').trim();
    if (!requested) return '127.0.0.1';
    if (isAllowedBindHost(requested) || _envFlag('FORGE_AGENT_ALLOW_NETWORK') === true) return requested;
    return '127.0.0.1';
}

function _configPath(userDataDir) {
    return path.join(userDataDir, FILE_NAME);
}

function _normalizePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function load(userDataDir) {
    let stored = {};
    try {
        const raw = fs.readFileSync(_configPath(userDataDir), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') stored = parsed;
    } catch (_) { /* first run, or unreadable — fall back to defaults */ }

    const forced = _envFlag('FORGE_AGENT_SERVER');
    const config = {
        enabled: forced === null ? !!stored.enabled : forced,
        port: _normalizePort(process.env.FORGE_AGENT_PORT || stored.port),
        token: typeof stored.token === 'string' && stored.token.length >= 16 ? stored.token : generateToken(),
        host: resolveBindHost(),
        createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : new Date().toISOString(),
        forcedByEnv: forced !== null,
    };
    return config;
}

function save(userDataDir, config) {
    const target = _configPath(userDataDir);
    const payload = {
        enabled: !!config.enabled,
        port: _normalizePort(config.port),
        token: String(config.token || generateToken()),
        createdAt: config.createdAt || new Date().toISOString(),
    };
    const temp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return payload;
}

module.exports = {
    DEFAULT_PORT,
    FILE_NAME,
    generateToken,
    isAllowedBindHost,
    load,
    resolveBindHost,
    save,
};
