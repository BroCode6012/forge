// src/remote/tools.js
// ============================================================================
// The ONE catalog of what an outside agent (Claude Code, Meta Muse, ChatGPT,
// n8n, a curl script...) may ask Forge to do. Every transport is generated from
// this list — MCP `tools/list`, the REST routes, and the OpenAPI document — so a
// tool added here shows up everywhere at once and cannot drift between them.
//
// Pure data + a small argument validator. No Electron, no fs: the verify harness
// loads it directly (scripts/verify/remote-control.js).
//
// Each tool:
//   name         MCP-legal id (letters, digits, _ and -), also the REST path segment
//   title        short human label
//   description  written FOR THE AGENT: what it does, when to call it, what comes back
//   inputSchema  JSON Schema (object) — the only shapes validateArgs() understands
//   readOnly     true = never changes anything (MCP readOnlyHint)
//   destructive  true = can throw away work in progress (MCP destructiveHint)
//   longRunning  true = returns immediately and the work continues in the app;
//                poll forge_get_status for the outcome
// ============================================================================
'use strict';

const REPEAT_STEPS = Object.freeze(['visual-planner', 'media', 'motion-graphics']);

const SERVER_INSTRUCTIONS = [
    'Forge turns a narration audio file into a finished faceless YouTube video, and runs on the user\'s own PC.',
    'Typical workflow:',
    '1) forge_get_status — see which project is open and what the app is doing.',
    '2) forge_open_project or forge_create_project — pick the project to work in.',
    '3) forge_import_narration — give it the MP3/WAV narration (a local path or an https URL).',
    '4) Optional: forge_get_settings, then forge_update_settings (video title, AI instructions, theme, niche...).',
    '5) forge_start_build — plans the video, finds footage, authors graphics. It takes roughly 20-90 minutes; poll forge_get_status every 2-5 minutes and read forge_get_build_log when something looks wrong.',
    '6) forge_render_video — renders the final MP4. Poll forge_get_status again.',
    '7) forge_list_videos — where the finished file is, with a download path.',
    'Only one build or render runs at a time. Builds spend the user\'s AI credits, so confirm with the user before starting one.',
    'The Forge app must be open on the user\'s PC for any of this to work.',
].join('\n');

const TOOLS = Object.freeze([
    {
        name: 'forge_get_status',
        title: 'Get Forge status',
        description: 'Start here. Returns the open project, whether narration is loaded, whether a video plan exists (and how many scenes), and what the app is doing right now: idle, building or rendering, with the current step and progress percent. Also returns the outcome of the last build/render an agent started. Poll this while a build or render runs.',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'forge_list_projects',
        title: 'List projects',
        description: 'Lists the user\'s recent Forge projects (name, folder, last opened) and marks the one that is open now.',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'forge_open_project',
        title: 'Open a project',
        description: 'Switches the Forge window to an existing project folder (use a path from forge_list_projects). The current project is saved first. Refused while a build or render is running. The app window reloads; wait a few seconds, then call forge_get_status.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Absolute path of the project folder.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'forge_create_project',
        title: 'Create a project',
        description: 'Creates a new, empty project folder and opens it in the Forge window. By default it is created next to the most recent project. Refused while a build or render is running.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1, maxLength: 120, description: 'Project name; becomes the folder name.' },
                parentFolder: { type: 'string', minLength: 1, maxLength: 1024, description: 'Optional existing folder to create the project in.' },
            },
            required: ['name'],
            additionalProperties: false,
        },
    },
    {
        name: 'forge_import_narration',
        title: 'Import narration audio',
        description: 'Loads the narration (MP3 or WAV) into the open project, replacing any narration already there. Give exactly one of: "path" (a file on the user\'s PC) or "url" (a public https link; private and local network addresses are refused).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Absolute path to an .mp3 or .wav file on this PC.' },
                url: { type: 'string', minLength: 8, maxLength: 2048, description: 'Public https URL of an .mp3 or .wav file.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'forge_get_settings',
        title: 'Get build settings',
        description: 'Returns the current build settings (video title, AI instructions, theme, niche, format, language, AI provider, vision backend...) and, for every setting with fixed choices, the allowed values with their labels. Read this before forge_update_settings.',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'forge_update_settings',
        title: 'Update build settings',
        description: 'Changes build settings exactly as if the user edited them in the app. Pass only the keys you want to change, e.g. {"settings": {"videoTitle": "How Pyramids Were Built", "aiInstructions": "cinematic, no text cards", "buildTheme": "history"}}. Use the keys and allowed values from forge_get_settings. Refused while a build or render is running.',
        inputSchema: {
            type: 'object',
            properties: {
                settings: { type: 'object', description: 'Setting key -> new value.' },
            },
            required: ['settings'],
            additionalProperties: false,
        },
    },
    {
        name: 'forge_start_build',
        title: 'Start a build',
        description: 'Starts building the video from the imported narration: transcription, scene planning, footage search, motion graphics, transitions and sound. Returns as soon as it has started; the build runs in the app for roughly 20-90 minutes, so poll forge_get_status. Omit "repeatFrom" for a full build. To redo only part of a finished build, set "repeatFrom" to "visual-planner" (keep the scene split), "media" (keep the plan, re-pick footage) or "motion-graphics" (rebuild only the graphics). Spends AI credits.',
        longRunning: true,
        inputSchema: {
            type: 'object',
            properties: {
                repeatFrom: { type: 'string', enum: REPEAT_STEPS.slice(), description: 'Optional: repeat from this step instead of a full build.' },
                forceFreshFootage: { type: 'boolean', description: 'Only with repeatFrom "media": re-download every clip instead of reusing cached footage.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'forge_render_video',
        title: 'Render the final video',
        description: 'Renders the current video plan to an MP4 with the HyperFrames renderer. Needs a finished build. Returns as soon as it has started; poll forge_get_status, then call forge_list_videos. "section": "full" (default) renders the whole video and clears any In/Out marks; "in-out" renders only the section between the user\'s In/Out marks.',
        longRunning: true,
        inputSchema: {
            type: 'object',
            properties: {
                section: { type: 'string', enum: ['full', 'in-out'], description: 'What to render. Default "full".' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'forge_cancel',
        title: 'Cancel the running job',
        description: 'Stops the build or render that is running right now. Work done so far on that job is lost (a later build can resume from its checkpoint).',
        destructive: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'forge_get_build_log',
        title: 'Read the build log',
        description: 'Returns the last lines of the newest build summary log for the open project: each pipeline phase and the outcome per scene (found footage, failed, warnings). Use it to explain progress or diagnose a failed build.',
        readOnly: true,
        inputSchema: {
            type: 'object',
            properties: {
                lines: { type: 'integer', minimum: 1, maximum: 500, description: 'How many lines from the end. Default 80.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'forge_list_videos',
        title: 'List rendered videos',
        description: 'Lists the rendered video files of the open project, newest first, with size, time, full path on the PC, and a download path on this server (GET it with the same access key).',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
]);

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function getTool(name) {
    return TOOL_BY_NAME.get(String(name || '')) || null;
}

// MCP `tools/list` shape (2025-06-18). Older clients ignore the fields they do not know.
function toMcpTool(tool) {
    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
            title: tool.title,
            readOnlyHint: !!tool.readOnly,
            destructiveHint: !!tool.destructive,
            idempotentHint: !!tool.readOnly,
            openWorldHint: false,
        },
    };
}

function _typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
    return typeof value;
}

function _matchesType(value, type) {
    const actual = _typeOf(value);
    if (type === 'number') return actual === 'number' || actual === 'integer';
    return actual === type;
}

// Validates arguments against the subset of JSON Schema used above. Returns a list
// of plain-English problems (empty = valid) so the agent can correct itself.
function validateArgs(tool, rawArgs) {
    const schema = tool?.inputSchema || { type: 'object', properties: {} };
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    const problems = [];
    if (_typeOf(args) !== 'object') {
        return ['arguments must be a JSON object'];
    }
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) problems.push(`"${key}" is required`);
    }
    for (const [key, value] of Object.entries(args)) {
        const spec = properties[key];
        if (!spec) {
            if (schema.additionalProperties === false) problems.push(`unknown argument "${key}"`);
            continue;
        }
        if (spec.type && !_matchesType(value, spec.type)) {
            problems.push(`"${key}" must be ${spec.type === 'integer' ? 'a whole number' : `a ${spec.type}`}`);
            continue;
        }
        if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
            problems.push(`"${key}" must be one of: ${spec.enum.join(', ')}`);
        }
        if (typeof value === 'string') {
            if (Number.isFinite(spec.minLength) && value.length < spec.minLength) problems.push(`"${key}" is too short`);
            if (Number.isFinite(spec.maxLength) && value.length > spec.maxLength) problems.push(`"${key}" is too long (max ${spec.maxLength} characters)`);
        }
        if (typeof value === 'number') {
            if (Number.isFinite(spec.minimum) && value < spec.minimum) problems.push(`"${key}" must be at least ${spec.minimum}`);
            if (Number.isFinite(spec.maximum) && value > spec.maximum) problems.push(`"${key}" must be at most ${spec.maximum}`);
        }
    }
    return problems;
}

module.exports = {
    REPEAT_STEPS,
    SERVER_INSTRUCTIONS,
    TOOLS,
    getTool,
    toMcpTool,
    validateArgs,
};
