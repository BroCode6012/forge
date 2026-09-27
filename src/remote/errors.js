// src/remote/errors.js
// ============================================================================
// One error type for everything a remote tool can refuse. The `code` decides the
// HTTP status on the REST route; over MCP every one of them becomes a tool result
// with isError:true, so the agent reads the message and can correct itself.
// ============================================================================
'use strict';

const HTTP_STATUS = Object.freeze({
    bad_request: 400,
    not_found: 404,
    conflict: 409,
    unavailable: 503,
    internal: 500,
});

class RemoteToolError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'RemoteToolError';
        this.code = Object.prototype.hasOwnProperty.call(HTTP_STATUS, code) ? code : 'internal';
        if (details !== undefined) this.details = details;
    }

    get httpStatus() {
        return HTTP_STATUS[this.code] || 500;
    }
}

function toRemoteError(error) {
    if (error instanceof RemoteToolError) return error;
    return new RemoteToolError('internal', error?.message || String(error || 'Unknown error'));
}

module.exports = { RemoteToolError, toRemoteError };
