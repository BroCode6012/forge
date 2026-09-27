// src/remote/openapi.js
// ============================================================================
// OpenAPI 3.1 description of the REST routes, generated from the same tool
// catalog as MCP. Agents that take "an API" instead of an MCP server (Muse's
// raw-API connector, ChatGPT actions, n8n, Zapier...) import this document.
// ============================================================================
'use strict';

const { TOOLS, SERVER_INSTRUCTIONS } = require('./tools');

function buildOpenApi({ serverUrl = '', version = '1.0.0' } = {}) {
    const paths = {};
    for (const tool of TOOLS) {
        paths[`/api/tools/${tool.name}`] = {
            post: {
                operationId: tool.name,
                summary: tool.title,
                description: tool.description,
                requestBody: {
                    required: false,
                    content: { 'application/json': { schema: tool.inputSchema } },
                },
                responses: {
                    200: { description: 'Done', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                    400: { description: 'Invalid arguments', content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } } },
                    401: { description: 'Missing or wrong access key' },
                    404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } } },
                    409: { description: 'Not possible right now (e.g. a build is running)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } } },
                    503: { description: 'The Forge window is not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } } },
                },
            },
        };
    }
    paths['/files/{name}'] = {
        get: {
            operationId: 'forge_download_video',
            summary: 'Download a rendered video',
            description: 'Downloads a file listed by forge_list_videos. Supports HTTP Range requests.',
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
                200: { description: 'The file', content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } } },
                206: { description: 'Partial content' },
                404: { description: 'No such file' },
            },
        },
    };

    const doc = {
        openapi: '3.1.0',
        info: {
            title: 'Forge remote control',
            version,
            description: SERVER_INSTRUCTIONS,
        },
        paths,
        components: {
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', description: 'The access key shown in Forge > AI settings > Agent access.' },
            },
            schemas: {
                Success: {
                    type: 'object',
                    properties: { ok: { const: true }, result: { type: 'object' } },
                    required: ['ok', 'result'],
                },
                Failure: {
                    type: 'object',
                    properties: { ok: { const: false }, error: { type: 'string' }, code: { type: 'string' } },
                    required: ['ok', 'error'],
                },
            },
        },
        security: [{ bearerAuth: [] }],
    };
    if (serverUrl) doc.servers = [{ url: serverUrl }];
    return doc;
}

module.exports = { buildOpenApi };
