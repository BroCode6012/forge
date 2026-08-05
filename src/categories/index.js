// src/categories/index.js
// ============================================================================
// Category registry — the production-TYPE axis (orthogonal to niche + format):
//   faceless · talkingHead.
// A category declares how the video is PRODUCED (presenter vs not, where footage
// comes from) + which formats it allows. Adding a category = drop a descriptor
// file here and list it below.
//
// resolveMode() replaces the old hardcoded directors-brief ternary
// (`… ? 'talkingHead' : 'faceless'`). Because every downstream guard is a string
// compare against 'talkingHead', any id that isn't 'talkingHead' flows through the
// faceless code paths untouched, so faceless + talkingHead stay byte-identical.
// ============================================================================
'use strict';

const faceless = require('./faceless');
const talkingHead = require('./talking-head');

const CATEGORIES = [faceless, talkingHead];
const BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// lowercased alias (incl. the id itself) → canonical id
const ALIAS = {};
for (const c of CATEGORIES) {
    for (const a of [c.id, ...(c.aliases || [])]) ALIAS[String(a).toLowerCase()] = c.id;
}

// Resolve a raw BUILD_PRODUCTION_MODE value to a canonical category id.
// Unknown / empty → 'faceless' (preserves the historical default + fallback).
function resolveMode(raw) {
    const key = String(raw || '').trim().toLowerCase();
    return ALIAS[key] || 'faceless';
}

function get(id) {
    return BY_ID[id] || faceless;
}

function getCategoryIds() {
    return CATEGORIES.map((c) => c.id);
}

function allowedFormats(id) {
    return (BY_ID[id] || faceless).allowedFormats;
}

module.exports = { CATEGORIES, BY_ID, resolveMode, get, getCategoryIds, allowedFormats };
