// src/remote/server.js
// ============================================================================
// The HTTP front door for outside agents. One small node:http server, three
// ways in, all generated from src/remote/tools.js:
//
//   POST /mcp                  Model Context Protocol (Streamable HTTP, JSON replies)
//   GET  /api/tools            REST: the tool list
//   POST /api/tools/<name>     REST: call one tool, JSON body = its arguments
//   GET  /files/<name>         download a rendered video (Range supported)
//   GET  /openapi.json         OpenAPI 3.1 for API-style agents   (no key needed)
//   GET  /health               liveness                            (no key needed)
//
// Guard rails:
//   - binds to 127.0.0.1 by default; tunnels (Tailscale Funnel, cloudflared)
//     reach it through loopback, so nothing has to listen on the network
//   - every route except /health and /openapi.json needs the access key
//     (Authorization: Bearer <key>, or X-Forge-Key: <key>), compared in constant time
//   - any request carrying a browser Origin header is refused, which shuts the
//     DNS-rebinding / malicious-web-page route the MCP spec warns about
//   - 1 MB request bodies, JSON only
//
// No Electron here: main.js injects callTool/resolveDownload, and the verify
// harness drives this server with fakes.
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const { TOOLS, getTool, validateArgs } = require('./tools');
const { handleMcpPayload, JSONRPC } = require('./mcp');
const { buildOpenApi } = require('./openapi');
const { toRemoteError } = require('./errors');

const MAX_BODY_BYTES = 1024 * 1024;

function _digest(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function _presentedKey(req) {
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    if (bearer) return bearer[1].trim();
    const header = req.headers['x-forge-key'];
    return header ? String(header).trim() : '';
}

function _sendJson(res, status, body, extraHeaders = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
    });
    res.end(text);
}

function _readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Request body is larger than 1 MB'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function _readJson(req) {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (type && !type.includes('json')) {
        throw Object.assign(new Error('Send the body as application/json'), { status: 415 });
    }
    const raw = await _readBody(req);
    if (!raw.trim()) return undefined;
    try {
        return JSON.parse(raw);
    } catch (_) {
        throw Object.assign(new Error('The body is not valid JSON'), { status: 400, parse: true });
    }
}

function _parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!match || (!match[1] && !match[2])) return null;
    let start;
    let end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
    return { start, end };
}

function createRemoteServer(options = {}) {
    const {
        host = '127.0.0.1',
        port = 0,
        callTool,
        resolveDownload = () => null,
        serverInfo = { name: 'forge', version: '1.0.0' },
        instructions = '',
        allowedOrigins = [],
        log = () => {},
    } = options;
    if (typeof callTool !== 'function') throw new Error('createRemoteServer needs a callTool function');

    let tokenDigest = options.token ? _digest(options.token) : null;
    const origins = new Set(allowedOrigins);
    let server = null;
    let boundPort = null;

    function authorized(req) {
        const presented = _presentedKey(req);
        if (!presented || !tokenDigest) return false;
        return crypto.timingSafeEqual(_digest(presented), tokenDigest);
    }

    async function runTool(name, args, meta) {
        const started = Date.now();
        try {
            const result = await callTool(name, args, meta);
            log(`[Remote] ${meta.transport} ${name} ok ${Date.now() - started}ms`);
            return result;
        } catch (error) {
            log(`[Remote] ${meta.transport} ${name} refused: ${error?.message || error}`);
            throw error;
        }
    }

    const mcpContext = {
        serverInfo,
        instructions,
        callTool: (name, args, meta) => runTool(name, args, meta),
    };

    async function serveFile(req, res, name) {
        let target = null;
        try {
            target = await resolveDownload(name);
        } catch (_) {
            target = null;
        }
        if (!target || !target.filePath) {
            _sendJson(res, 404, { ok: false, error: 'No such file' });
            return;
        }
        const size = Number(target.size) || fs.statSync(target.filePath).size;
        const baseHeaders = {
            'Content-Type': target.contentType || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${String(target.fileName || name).replace(/["\\\r\n]/g, '_')}"`,
            'X-Content-Type-Options': 'nosniff',
        };
        const range = req.headers.range ? _parseRange(req.headers.range, size) : null;
        if (range === 'invalid') {
            res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${size}` });
            res.end();
            return;
        }
        const start = range ? range.start : 0;
        const end = range ? range.end : size - 1;
        const headers = { ...baseHeaders, 'Content-Length': size ? end - start + 1 : 0 };
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(range ? 206 : 200, headers);
        if (req.method === 'HEAD' || !size) {
            res.end();
            return;
        }
        const stream = fs.createReadStream(target.filePath, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
    }

    async function handle(req, res) {
        const url = new URL(req.url || '/', 'http://forge.invalid');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const method = String(req.method || 'GET').toUpperCase();

        // Browsers always label cross-site requests with Origin; agents do not.
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) {
            _sendJson(res, 403, { ok: false, error: 'Requests from web pages are not allowed' });
            return;
        }

        if (method === 'GET' && (pathname === '/' || pathname === '/health')) {
            _sendJson(res, 200, {
                ok: true,
                name: serverInfo.name,
                version: serverInfo.version,
                mcp: '/mcp',
                api: '/api/tools',
                openapi: '/openapi.json',
            });
            return;
        }
        if (method === 'GET' && pathname === '/openapi.json') {
            const hostHeader = String(req.headers.host || '');
            const serverUrl = /^[A-Za-z0-9.\-:[\]]+$/.test(hostHeader) ? `http://${hostHeader}` : '';
            _sendJson(res, 200, buildOpenApi({ serverUrl, version: serverInfo.version }));
            return;
        }

        if (!authorized(req)) {
            _sendJson(res, 401, { ok: false, error: 'Missing or wrong Forge access key' }, {
                'WWW-Authenticate': 'Bearer realm="forge"',
            });
            return;
        }

        if (pathname === '/mcp') {
            if (method !== 'POST') {
                // Stateless server: no SSE stream to open and no session to delete.
                _sendJson(res, 405, { ok: false, error: 'Use POST' }, { Allow: 'POST' });
                return;
            }
            let payload;
            try {
                payload = await _readJson(req);
            } catch (error) {
                if (error.parse) {
                    _sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSONRPC.PARSE_ERROR, message: error.message } });
                } else {
                    _sendJson(res, error.status || 400, { ok: false, error: error.message });
                }
                return;
            }
            const reply = await handleMcpPayload(payload === undefined ? null : payload, mcpContext);
            if (reply === null) {
                res.writeHead(202, { 'Content-Length': 0 });
                res.end();
                return;
            }
            _sendJson(res, 200, reply);
            return;
        }

        if (pathname === '/api/tools' && method === 'GET') {
            _sendJson(res, 200, {
                ok: true,
                tools: TOOLS.map((tool) => ({
                    name: tool.name,
                    title: tool.title,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    readOnly: !!tool.readOnly,
                    longRunning: !!tool.longRunning,
                })),
            });
            return;
        }

        const toolRoute = /^\/api\/tools\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (toolRoute) {
            if (method !== 'POST') {
                _sendJson(res, 405, { ok: false, error: 'Use POST' }, { Allow: 'POST' });
                return;
            }
            const tool = getTool(toolRoute[1]);
            if (!tool) {
                _sendJson(res, 404, { ok: false, error: `Unknown tool: ${toolRoute[1]}`, code: 'not_found' });
                return;
            }
            let args;
            try {
                args = await _readJson(req);
            } catch (error) {
                _sendJson(res, error.status || 400, { ok: false, error: error.message, code: 'bad_request' });
                return;
            }
            const problems = validateArgs(tool, args);
            if (problems.length) {
                _sendJson(res, 400, { ok: false, error: `Invalid arguments: ${problems.join('; ')}`, code: 'bad_request' });
                return;
            }
            try {
                const result = await runTool(tool.name, args || {}, { transport: 'rest' });
                _sendJson(res, 200, { ok: true, result: result === undefined ? {} : result });
            } catch (error) {
                const remote = toRemoteError(error);
                _sendJson(res, remote.httpStatus, { ok: false, error: remote.message, code: remote.code });
            }
            return;
        }

        const fileRoute = /^\/files\/([^/]+)$/.exec(pathname);
        if (fileRoute && (method === 'GET' || method === 'HEAD')) {
            let name;
            try {
                name = decodeURIComponent(fileRoute[1]);
            } catch (_) {
                _sendJson(res, 400, { ok: false, error: 'Bad file name' });
                return;
            }
            await serveFile(req, res, name);
            return;
        }

        _sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    function start() {
        return new Promise((resolve, reject) => {
            if (server) {
                resolve({ host, port: boundPort });
                return;
            }
            const next = http.createServer((req, res) => {
                handle(req, res).catch((error) => {
                    log(`[Remote] request failed: ${error?.message || error}`);
                    if (!res.headersSent) _sendJson(res, 500, { ok: false, error: 'Internal error' });
                    else res.destroy();
                });
            });
            next.headersTimeout = 15000;
            next.requestTimeout = 120000;
            next.keepAliveTimeout = 5000;
            const onError = (error) => {
                next.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                next.removeListener('error', onError);
                next.on('error', (error) => log(`[Remote] server error: ${error.message}`));
                server = next;
                boundPort = next.address().port;
                resolve({ host, port: boundPort });
            };
            next.once('error', onError);
            next.once('listening', onListening);
            next.listen(port, host);
        });
    }

    function stop() {
        return new Promise((resolve) => {
            if (!server) {
                resolve();
                return;
            }
            const closing = server;
            server = null;
            boundPort = null;
            closing.close(() => resolve());
            if (typeof closing.closeAllConnections === 'function') closing.closeAllConnections();
        });
    }

    return {
        start,
        stop,
        setToken(token) { tokenDigest = token ? _digest(token) : null; },
        get port() { return boundPort; },
        get host() { return host; },
        get running() { return !!server; },
    };
}

module.exports = { createRemoteServer, MAX_BODY_BYTES };
