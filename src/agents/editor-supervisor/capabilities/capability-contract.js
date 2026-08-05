'use strict';

const crypto = require('crypto');

const VALUE_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function object(properties = {}, options = {}) {
    return {
        type: 'object',
        properties,
        additionalProperties: options.additionalProperties === true,
        ...(Array.isArray(options.required) && options.required.length
            ? { required: [...new Set(options.required.map(String))] }
            : {}),
        ...(Array.isArray(options.anyOfRequired) && options.anyOfRequired.length
            ? {
                anyOfRequired: options.anyOfRequired
                    .map((group) => Array.isArray(group) ? [...new Set(group.map(String))] : [])
                    .filter((group) => group.length),
            }
            : {}),
        ...(Number.isFinite(Number(options.minProperties))
            ? { minProperties: Math.max(0, Number(options.minProperties)) }
            : {}),
        ...(options.description ? { description: String(options.description) } : {}),
    };
}

function string(options = {}) {
    return {
        type: 'string',
        ...(Array.isArray(options.enum) ? { enum: [...new Set(options.enum.map(String))] } : {}),
        ...(Number.isFinite(Number(options.minLength)) ? { minLength: Math.max(0, Number(options.minLength)) } : {}),
        ...(Number.isFinite(Number(options.maxLength)) ? { maxLength: Math.max(0, Number(options.maxLength)) } : {}),
        ...(options.format ? { format: String(options.format) } : {}),
        ...(options.description ? { description: String(options.description) } : {}),
    };
}

function number(options = {}) {
    return {
        type: 'number',
        ...(Number.isFinite(Number(options.min)) ? { minimum: Number(options.min) } : {}),
        ...(Number.isFinite(Number(options.max)) ? { maximum: Number(options.max) } : {}),
        ...(options.description ? { description: String(options.description) } : {}),
    };
}

function integer(options = {}) {
    return {
        ...number(options),
        type: 'integer',
    };
}

function boolean(options = {}) {
    return {
        type: 'boolean',
        ...(options.description ? { description: String(options.description) } : {}),
    };
}

function array(items, options = {}) {
    return {
        type: 'array',
        items,
        ...(Number.isFinite(Number(options.minItems)) ? { minItems: Math.max(0, Number(options.minItems)) } : {}),
        ...(Number.isFinite(Number(options.maxItems)) ? { maxItems: Math.max(0, Number(options.maxItems)) } : {}),
        ...(options.uniqueItems === true ? { uniqueItems: true } : {}),
        ...(options.description ? { description: String(options.description) } : {}),
    };
}

function tool(action, description, args = object(), options = {}) {
    return {
        action: String(action || '').trim(),
        description: String(description || '').trim(),
        args,
        ...(options.canonicalAction ? { canonicalAction: String(options.canonicalAction) } : {}),
        ...(Array.isArray(options.scopes) ? { scopes: options.scopes.map(String) } : {}),
        ...(options.risk ? { risk: String(options.risk) } : {}),
        ...(Array.isArray(options.limitations) ? { limitations: options.limitations.map(String) } : {}),
        ...(Array.isArray(options.examples) ? { examples: options.examples.map(String) } : {}),
        ...(Array.isArray(options.visualTargets) ? { visualTargets: options.visualTargets.map(String) } : {}),
        ...(options.visualRepair === true ? { visualRepair: true } : {}),
        ...(Array.isArray(options.visualRepairFields)
            ? { visualRepairFields: options.visualRepairFields.map(String) }
            : {}),
        ...(options.visualImpact === true || options.visualRepair === true ? { visualImpact: true } : {}),
    };
}

function _normalizeSchema(raw, source) {
    if (!_plainObject(raw)) throw new Error(`${source} must be a schema object`);
    const type = String(raw.type || '').trim();
    if (!VALUE_TYPES.has(type)) throw new Error(`${source} has unsupported schema type "${type || '(empty)'}"`);
    const schema = { ..._clone(raw), type };
    if (type === 'object') {
        schema.properties = {};
        for (const [key, value] of Object.entries(raw.properties || {})) {
            schema.properties[String(key)] = _normalizeSchema(value, `${source}.${key}`);
        }
        schema.additionalProperties = raw.additionalProperties === true;
        schema.required = Array.isArray(raw.required)
            ? [...new Set(raw.required.map(String))]
            : [];
        schema.anyOfRequired = Array.isArray(raw.anyOfRequired)
            ? raw.anyOfRequired
                .map((group) => Array.isArray(group) ? [...new Set(group.map(String))] : [])
                .filter((group) => group.length)
            : [];
    } else if (type === 'array') {
        schema.items = _normalizeSchema(raw.items || string(), `${source}[]`);
    }
    return schema;
}

function normalizeTools(rawTools, defaults = {}) {
    if (!Array.isArray(rawTools) || !rawTools.length) return [];
    const seen = new Set();
    return rawTools.map((raw, index) => {
        if (!_plainObject(raw)) throw new Error(`tool #${index + 1} must be an object`);
        const action = String(raw.action || '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(action)) {
            throw new Error(`tool #${index + 1} has invalid action "${action || '(empty)'}"`);
        }
        if (seen.has(action)) throw new Error(`duplicate tool action "${action}"`);
        seen.add(action);
        const scopes = Array.isArray(raw.scopes) && raw.scopes.length
            ? [...new Set(raw.scopes.map(String))]
            : [...(defaults.scopes || [])];
        return {
            action,
            canonicalAction: String(raw.canonicalAction || action),
            description: String(raw.description || action),
            args: _normalizeSchema(raw.args || object(), `${defaults.specialist || 'capability'}.${action}.args`),
            scopes,
            risk: String(raw.risk || defaults.risk || 'moderate'),
            limitations: Array.isArray(raw.limitations)
                ? [...new Set(raw.limitations.map(String).filter(Boolean))]
                : [],
            examples: Array.isArray(raw.examples)
                ? [...new Set(raw.examples.map(String).filter(Boolean))]
                : [],
            visualTargets: Array.isArray(raw.visualTargets)
                ? [...new Set(raw.visualTargets.map(String).filter(Boolean))]
                : [],
            visualRepair: raw.visualRepair === true,
            visualRepairFields: Array.isArray(raw.visualRepairFields)
                ? [...new Set(raw.visualRepairFields.map(String).filter(Boolean))]
                : [],
            visualImpact: raw.visualImpact === true || raw.visualRepair === true,
        };
    });
}

function _validate(schema, value, path, errors) {
    if (schema.type === 'object') {
        if (!_plainObject(value)) {
            errors.push(`${path} must be an object`);
            return;
        }
        const keys = Object.keys(value);
        if (Number.isFinite(Number(schema.minProperties)) && keys.length < Number(schema.minProperties)) {
            errors.push(`${path} needs at least ${schema.minProperties} field(s)`);
        }
        for (const required of (schema.required || [])) {
            if (!Object.prototype.hasOwnProperty.call(value, required)) {
                errors.push(`${path}.${required} is required`);
            }
        }
        if ((schema.anyOfRequired || []).length) {
            const matched = schema.anyOfRequired.some((group) => (
                group.every((key) => Object.prototype.hasOwnProperty.call(value, key))
            ));
            if (!matched) {
                errors.push(`${path} needs one of: ${schema.anyOfRequired.map((group) => group.join('+')).join(' | ')}`);
            }
        }
        for (const [key, child] of Object.entries(value)) {
            const childSchema = schema.properties?.[key];
            if (!childSchema) {
                if (schema.additionalProperties !== true) errors.push(`${path}.${key} is not supported`);
                continue;
            }
            _validate(childSchema, child, `${path}.${key}`, errors);
        }
        return;
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            errors.push(`${path} must be an array`);
            return;
        }
        if (Number.isFinite(Number(schema.minItems)) && value.length < Number(schema.minItems)) {
            errors.push(`${path} needs at least ${schema.minItems} item(s)`);
        }
        if (Number.isFinite(Number(schema.maxItems)) && value.length > Number(schema.maxItems)) {
            errors.push(`${path} allows at most ${schema.maxItems} item(s)`);
        }
        if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
            errors.push(`${path} cannot contain duplicate items`);
        }
        value.forEach((item, index) => _validate(schema.items, item, `${path}[${index}]`, errors));
        return;
    }
    if (schema.type === 'string') {
        if (typeof value !== 'string') {
            errors.push(`${path} must be a string`);
            return;
        }
        if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
            errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
        }
        if (Number.isFinite(Number(schema.minLength)) && value.length < Number(schema.minLength)) {
            errors.push(`${path} is too short`);
        }
        if (Number.isFinite(Number(schema.maxLength)) && value.length > Number(schema.maxLength)) {
            errors.push(`${path} is too long`);
        }
        return;
    }
    if (schema.type === 'boolean') {
        if (typeof value !== 'boolean') errors.push(`${path} must be true or false`);
        return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        errors.push(`${path} must be a number`);
        return;
    }
    if (schema.type === 'integer' && !Number.isInteger(numeric)) errors.push(`${path} must be an integer`);
    if (Number.isFinite(Number(schema.minimum)) && numeric < Number(schema.minimum)) {
        errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (Number.isFinite(Number(schema.maximum)) && numeric > Number(schema.maximum)) {
        errors.push(`${path} must be at most ${schema.maximum}`);
    }
}

function validateToolArgs(toolSpec, args) {
    const errors = [];
    _validate(toolSpec.args, _plainObject(args) ? args : {}, 'args', errors);
    return {
        ok: errors.length === 0,
        errors,
    };
}

function assertToolArgs(toolSpec, args, source = '') {
    const result = validateToolArgs(toolSpec, args);
    if (!result.ok) {
        const prefix = source ? `${source}: ` : '';
        throw new Error(`${prefix}${result.errors.join('; ')}`);
    }
    return args;
}

function contractHash(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex');
}

module.exports = {
    array,
    assertToolArgs,
    boolean,
    contractHash,
    integer,
    normalizeTools,
    number,
    object,
    string,
    tool,
    validateToolArgs,
};
