// src/remote/mcp.js
// ============================================================================
// Model Context Protocol (JSON-RPC 2.0) message handling for Forge's remote
// control — transport-free. server.js feeds it the parsed body of a
// `POST /mcp` (Streamable HTTP transport) and writes back what it returns.
//
// Stateless on purpose: no session ids, no server-initiated messages, no SSE
// stream. Every request carries everything needed, so it survives an app
// restart, a tunnel reconnect, or an agent that never sends `initialized`.
//
// Implemented: initialize, ping, tools/list, tools/call, and notifications
// (accepted, no reply). Anything else is JSON-RPC "method not found".
// ============================================================================
'use strict';

const { TOOLS, getTool, toMcpTool, validateArgs } = require('./tools');
const { toRemoteError } = require('./errors');

// Newest first. An unknown requested version gets our newest; the client then
// decides whether it can speak it (spec behavior).
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

const JSONRPC = Object.freeze({
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
});

function _isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _error(id, code, message) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function _result(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function negotiateProtocolVersion(requested) {
    const wanted = String(requested || '');
    return SUPPORTED_PROTOCOL_VERSIONS.includes(wanted) ? wanted : SUPPORTED_PROTOCOL_VERSIONS[0];
}

// A tool's plain JSON result, wrapped the way every MCP client can read it:
// text for older clients, structuredContent for 2025-06-18+ clients.
function toolResult(value, isError = false) {
    const payload = value === undefined ? { ok: !isError } : value;
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: _isObject(payload) ? payload : { value: payload },
        isError: !!isError,
    };
}

async function _handleOne(message, ctx) {
    if (!_isObject(message) || message.jsonrpc !== '2.0') {
        return _error(_isObject(message) ? message.id : null, JSONRPC.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 message');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;
    // A response or a notification from the client: nothing to answer.
    if (typeof message.method !== 'string') return null;
    if (!hasId) return null;

    const { id, method } = message;
    const params = _isObject(message.params) ? message.params : {};
    switch (method) {
        case 'initialize':
            return _result(id, {
                protocolVersion: negotiateProtocolVersion(params.protocolVersion),
                capabilities: { tools: { listChanged: false } },
                serverInfo: ctx.serverInfo,
                instructions: ctx.instructions,
            });
        case 'ping':
            return _result(id, {});
        case 'tools/list':
            return _result(id, { tools: TOOLS.map(toMcpTool) });
        case 'tools/call': {
            const tool = getTool(params.name);
            if (!tool) return _error(id, JSONRPC.INVALID_PARAMS, `Unknown tool: ${String(params.name || '')}`);
            const args = params.arguments === undefined ? {} : params.arguments;
            // Bad arguments come back as a tool error, not a protocol error, so the
            // model sees the message and retries with corrected input.
            const problems = validateArgs(tool, args);
            if (problems.length) {
                return _result(id, toolResult({ ok: false, error: `Invalid arguments: ${problems.join('; ')}` }, true));
            }
            try {
                const value = await ctx.callTool(tool.name, args, { transport: 'mcp' });
                return _result(id, toolResult(value, false));
            } catch (error) {
                const remote = toRemoteError(error);
                return _result(id, toolResult({ ok: false, error: remote.message, code: remote.code }, true));
            }
        }
        default:
            return _error(id, JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
}

// payload = the parsed JSON body (one message or a batch array).
// Returns the JSON to send back, or null when there is nothing to answer
// (notifications only -> the transport replies 202 Accepted).
async function handleMcpPayload(payload, ctx) {
    if (Array.isArray(payload)) {
        if (!payload.length) return _error(null, JSONRPC.INVALID_REQUEST, 'Empty batch');
        const replies = [];
        for (const message of payload) {
            const reply = await _handleOne(message, ctx);
            if (reply) replies.push(reply);
        }
        return replies.length ? replies : null;
    }
    return _handleOne(payload, ctx);
}

module.exports = {
    JSONRPC,
    SUPPORTED_PROTOCOL_VERSIONS,
    handleMcpPayload,
    negotiateProtocolVersion,
    toolResult,
};
