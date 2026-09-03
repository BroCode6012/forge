/**
 * Map Provider — Downloads static map images for mapChart MGs.
 * Provider order:
 *   1. MapTiler (primary) — tile-stitching from free tile API (100K tiles/month)
 *   2. Geoapify (fallback) — static map API (free 3,000 req/day)
 *
 * MapTiler's static maps API requires a paid plan, so we download individual
 * 512×512 tiles and stitch them into a 1920×1080 image using @napi-rs/canvas.
 *
 * Geocoding: MapTiler free tier includes geocoding (100K req/day).
 * Converts city/landmark names → exact lat/lng with dynamic zoom.
 *
 * Usage: downloadMapForMG(mg, scriptContext, tempDir) → saves PNG, sets mg.mapImageFile
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../settings/config');
const { isCanvasSafeImage } = require('../util/image-bytes');
const { getPack: getMapStylePack } = require('./map-style-packs');

// ── Geocoding cache (avoids repeat API calls within same build) ──
const _geocodeCache = new Map();

// ── MapTiler tile cache (avoids re-downloading identical tiles across maps) ──
// Keyed by `${style}/${z}/${x}/${y}`. Stores raw PNG Buffer. Cleared between builds.
const _tileCache = new Map();

// ── Non-place entity filter ──
// These entities should NEVER reach the geocoder — they're not locations and
// cause garbage matches (e.g. "Houthi forces" → Albania, "Maersk" → Denmark,
// "Hapag-Lloyd" → Alberta). When a non-place slips through, OSM fetches wrong
// country boundaries and the final map is polluted with unrelated regions.
const NON_PLACE_SUFFIX_RE = /\b(Inc|Inc\.|Ltd|Ltd\.|LLC|PLC|Corp|Corp\.|Corporation|Co\.|Company|Companies|AG|SA|GmbH|BV|NV|Holding|Holdings|Group|Groups?|Shipping|Lines?|Airlines?|Motors?|Industries|Solutions|Technologies|Services|Partners|Ventures|Capital)\b/i;
const NON_PLACE_WORD_RE  = /\b(forces|militia|militant|militants|rebels|rebel|insurgents?|fighters|battalion|brigade|regiment|corps|coalition|alliance|cartel|faction|syndicate|terrorists?|party|parties|government|governments|administration|administrations|agency|agencies|ministry|ministries|committee|committees|council|councils|union|unions|organization|organizations|association|associations|federation|confederation|conglomerate|powers|players|actors|stakeholders)\b/i;
const GENERIC_GLOBAL_RE  = /^(world|global|globe|earth|international|worldwide|everywhere|nowhere|abroad)$/i;

// Known placeholder coordinates used by our various geocoders when they fail
// to find a real match. (0,0) is the classic null-island. (0,20) has appeared
// as a mid-Atlantic fallback in the MapTiler path. Anything exact-match to
// these is never a real intended location — we treat it as a bogus stop.
const PLACEHOLDER_COORDS = [
    { lon: 0,    lat: 0 },
    { lon: 0,    lat: 20 },
    { lon: 20,   lat: 0 },
];
function _looksLikePlaceholderCoord(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return true;
    for (const p of PLACEHOLDER_COORDS) {
        if (Math.abs(lon - p.lon) < 0.01 && Math.abs(lat - p.lat) < 0.01) return true;
    }
    return false;
}

function isLikelyPlace(name, entityTypes) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2) return false;

    // 1. Trust the AI Director's tagging when present
    const tag = entityTypes && entityTypes[trimmed.toLowerCase()];
    if (tag === 'place') return true;
    if (tag === 'person' || tag === 'org' || tag === 'event') return false;

    // 2. Untagged: apply heuristics
    if (GENERIC_GLOBAL_RE.test(trimmed)) return false;     // "World", "Earth", etc.
    if (NON_PLACE_SUFFIX_RE.test(trimmed)) return false;   // Company suffixes
    if (NON_PLACE_WORD_RE.test(trimmed)) return false;     // Groups / orgs / institutions

    return true;
}

function filterPlaces(names, entityTypes, context = 'entities') {
    if (!Array.isArray(names) || names.length === 0) return names || [];
    const kept = [];
    const dropped = [];
    for (const n of names) {
        if (isLikelyPlace(n, entityTypes)) kept.push(n);
        else dropped.push(n);
    }
    if (dropped.length > 0) {
        console.log(`      🚫 Filtered ${dropped.length} non-place ${context}: ${dropped.join(', ')}`);
    }
    return kept;
}

// ── MapTiler style mapping (primary) ──
const MAPTILER_STYLE_MAP = {
    dark:      'dataviz-dark',
    natural:   'outdoor-v2',
    satellite: 'satellite',
    light:     'dataviz-light',
    political: 'streets-v2',
};

// ── Geoapify style mapping (fallback) ──
const GEOAPIFY_STYLE_MAP = {
    dark:      'dark-matter-brown',
    natural:   'osm-liberty',
    satellite: 'dark-matter',
    light:     'positron',
    political: 'osm-bright',
};

// Country/region center coordinates [lon, lat, zoom]
const GEO_COORDS = {
    'China': [104, 35, 4], 'United States': [-98, 39, 3.5], 'USA': [-98, 39, 3.5], 'US': [-98, 39, 3.5],
    'India': [78, 22, 4], 'Japan': [138, 36, 5], 'Germany': [10.5, 51.2, 5.5],
    'United Kingdom': [-2, 54, 5], 'UK': [-2, 54, 5], 'France': [2.2, 46.2, 5.5],
    'Brazil': [-51, -10, 3.5], 'Italy': [12.5, 42.5, 5.5], 'Canada': [-106, 56, 3],
    'Russia': [100, 60, 2.5], 'South Korea': [128, 36, 6], 'Australia': [134, -25, 3.5],
    'Spain': [-3.7, 40.4, 5.5], 'Mexico': [-102, 23, 4.5], 'Indonesia': [118, -2, 4],
    'Norway': [9, 62, 4.5], 'Turkey': [35, 39, 5.5], 'Saudi Arabia': [45, 24, 5],
    'South Africa': [25, -29, 5], 'Argentina': [-64, -34, 3.5], 'Nigeria': [8, 10, 5],
    'Egypt': [30, 27, 5.5], 'Thailand': [101, 15, 5.5], 'Vietnam': [108, 16, 5.5],
    'Taiwan': [121, 24, 7], 'Pakistan': [70, 30, 5], 'Philippines': [122, 13, 5.5],
    'Iran': [53, 32, 5], 'Iraq': [44, 33, 5.5], 'Israel': [35, 31.5, 7],
    'Ukraine': [32, 49, 5], 'Poland': [20, 52, 5.5], 'Sweden': [16, 62, 4.5],
    'Singapore': [104, 1.3, 10], 'Malaysia': [102, 4, 5.5], 'Colombia': [-74, 4, 5],
    'Chile': [-71, -33, 4], 'Peru': [-76, -10, 5], 'Venezuela': [-66, 8, 5.5],
    'Algeria': [3, 28, 4.5], 'Libya': [18, 27, 5], 'Morocco': [-6, 32, 5.5],
    'Kenya': [38, 0, 5.5], 'Ethiopia': [39, 9, 5], 'Tanzania': [35, -6, 5.5],
    'Congo': [25, -3, 5], 'Angola': [18, -12, 5], 'Ghana': [-1.5, 8, 6],
    'Afghanistan': [66, 34, 5.5], 'Bangladesh': [90, 24, 6.5],
    'North Korea': [127, 40, 6], 'Myanmar': [96, 20, 5.5],
    'New Zealand': [174, -41, 5], 'Finland': [26, 64, 5],
    'Greece': [22, 39, 6], 'Portugal': [-8, 39.5, 6],
    'Netherlands': [5, 52, 7], 'Belgium': [4.4, 50.8, 7],
    'Switzerland': [8.2, 46.8, 7], 'Austria': [14.5, 47.5, 6.5],
    'Czech Republic': [15.5, 49.8, 6.5], 'Romania': [25, 46, 6],
    'Hungary': [19, 47, 6.5], 'Denmark': [10, 56, 6],
    'Shanghai': [121.47, 31.23, 9], 'Rotterdam': [4.48, 51.92, 9],
    'Cuba': [-79, 22, 6.5], 'Jamaica': [-77, 18, 8],
    'Qatar': [51, 25.3, 8], 'UAE': [54, 24, 6.5], 'Kuwait': [48, 29.5, 8],
    'Oman': [57, 21, 6], 'Yemen': [48, 15.5, 6], 'Jordan': [36, 31, 7],
    'Lebanon': [35.8, 33.9, 8], 'Syria': [38, 35, 6.5],
    'Europe': [15, 50, 3.5], 'Asia': [90, 35, 2], 'Africa': [20, 5, 2.5],
    'Middle East': [45, 28, 4], 'South America': [-60, -15, 2.5],
    'North America': [-100, 45, 2.5], 'World': [0, 20, 1],
    'Earth': [0, 20, 1], 'Globe': [0, 20, 1],
    // Sub-continents / regions — tighter than continents, often the right establishing shot
    'Southeast Asia': [110, 10, 3.5], 'East Asia': [120, 35, 3.5],
    'South Asia': [80, 22, 3.5], 'Central Asia': [70, 45, 3.5],
    'Western Europe': [5, 48, 4.5], 'Eastern Europe': [28, 50, 4],
    'Northern Europe': [18, 62, 3.5], 'Southern Europe': [15, 42, 4.5],
    'Scandinavia': [18, 64, 3.5], 'Balkans': [22, 43, 5], 'Caucasus': [45, 42, 5.5],
    'North Africa': [10, 28, 3.5], 'West Africa': [-5, 10, 4],
    'East Africa': [38, 0, 4], 'Southern Africa': [25, -22, 3.5],
    'Sub-Saharan Africa': [20, -5, 2.8],
    'Central America': [-85, 14, 4.5], 'Caribbean': [-75, 17, 4.5],
    'Latin America': [-70, -10, 2.8], 'Oceania': [145, -25, 2.8],
    'Arabian Peninsula': [46, 23, 4], 'Horn of Africa': [44, 8, 5],
    'Cape of Good Hope': [18.47, -34.36, 6.5], 'Good Hope': [18.47, -34.36, 6.5],
    'Indian Subcontinent': [78, 22, 3.8],
    // Seas / gulfs / straits — often the BEST establishing frame for coastal stories
    'Red Sea': [38, 20, 4.5], 'Gulf of Aden': [48, 12.5, 5.5],
    'Persian Gulf': [52, 27, 5], 'Arabian Sea': [64, 15, 4],
    'Gulf of Oman': [58, 24, 6], 'Strait of Hormuz': [56, 26.5, 7.5],
    'Bab-el-Mandeb': [43.3, 12.6, 7.5], 'Bab el-Mandeb': [43.3, 12.6, 7.5],
    'Mediterranean': [18, 37, 3.8], 'Mediterranean Sea': [18, 37, 3.8],
    'Black Sea': [35, 43.5, 5], 'Caspian Sea': [51, 41.5, 4.8],
    'Baltic Sea': [19, 58, 4.5], 'North Sea': [3, 56, 4.8],
    'South China Sea': [115, 15, 3.8], 'East China Sea': [125, 30, 4.5],
    'Sea of Japan': [135, 40, 4.5], 'Bay of Bengal': [88, 15, 4],
    'Gulf of Mexico': [-90, 25, 4.5], 'Gulf of Guinea': [3, 3, 4.5],
    // Oceans (rarely the right choice but completeness)
    'Pacific Ocean': [-160, 0, 2], 'Atlantic Ocean': [-30, 15, 2.2],
    'Indian Ocean': [75, -10, 2.2], 'Arctic Ocean': [0, 85, 2],
    'Southern Ocean': [0, -65, 2],
};

function _routeDetourAlias(name) {
    const lower = String(name || '').toLowerCase().trim();
    if (/^(africa|around africa|african route|cape route|cape of good hope route)$/.test(lower)) {
        return 'Cape of Good Hope';
    }
    return null;
}

function _routeDetourPoint(pt) {
    const alias = _routeDetourAlias(pt?.name);
    const coords = alias ? GEO_COORDS[alias] : null;
    if (!coords) return pt;
    return {
        ...pt,
        name: alias,
        lon: coords[0],
        lat: coords[1],
        detourFor: pt.name,
    };
}

function _withDistributedRouteTimes(points, startTime, endTime) {
    if (!Array.isArray(points) || points.length === 0) return points || [];
    const st = Number.isFinite(startTime) ? startTime : Number(points[0]?.startTime) || 0;
    const et = Number.isFinite(endTime) && endTime > st ? endTime : Math.max(st + 2, Number(points[points.length - 1]?.endTime) || st + 2);
    const step = points.length > 1 ? (et - st) / (points.length - 1) : et - st;
    return points.map((p, i) => ({
        ...p,
        startTime: st + step * i,
        endTime: i === points.length - 1 ? et : Math.min(et, st + step * (i + 1)),
    }));
}

function _expandKnownMaritimeRoute(points) {
    if (!Array.isArray(points) || points.length !== 2) return points;
    const first = points[0];
    const last = points[1];
    const firstEast = /\b(shanghai|china|asia|east asia|southeast asia|south asia)\b/i.test(String(first.name || ''));
    const lastEast = /\b(shanghai|china|asia|east asia|southeast asia|south asia)\b/i.test(String(last.name || ''));
    const firstEurope = /\b(rotterdam|netherlands|europe|western europe)\b/i.test(String(first.name || ''));
    const lastEurope = /\b(rotterdam|netherlands|europe|western europe)\b/i.test(String(last.name || ''));
    if (!((firstEast && lastEurope) || (firstEurope && lastEast))) return points;
    const suez = GEO_COORDS['Suez Canal'];
    if (!suez) return points;
    const start = Math.min(Number(first.startTime) || 0, Number(last.startTime) || 0);
    const end = Math.max(Number(first.endTime) || start + 2, Number(last.endTime) || start + 2);
    return _withDistributedRouteTimes([
        first,
        { name: 'Suez Canal', lon: suez[0], lat: suez[1], startTime: start, endTime: end },
        last,
    ], start, end);
}

function _routeEntitiesForMapScene(mapScene, entities) {
    if (!mapScene || mapScene.mapMode !== 'route' || !Array.isArray(entities)) return entities;
    const subjects = Array.isArray(mapScene.subjects) ? mapScene.subjects : [];
    const nonRegionCount = subjects.filter(s => s && s.kind !== 'region').length;
    if (nonRegionCount < 2) return entities;
    const subjectByName = new Map(subjects.map(s => [String(s.name || '').toLowerCase().trim(), s]));
    const rewritten = [];
    const notes = [];
    const seen = new Set();
    for (const name of entities) {
        const key = String(name || '').toLowerCase().trim();
        const subj = subjectByName.get(key);
        const alias = subj?.kind === 'region' ? _routeDetourAlias(name) : null;
        const finalName = alias || name;
        const finalKey = String(finalName || '').toLowerCase().trim();
        if (finalKey && !seen.has(finalKey)) {
            seen.add(finalKey);
            rewritten.push(finalName);
        }
        if (alias) notes.push(`${name} -> ${alias}`);
    }
    if (notes.length) {
        console.log(`      🧭 Route detour resolved: ${notes.join(', ')}`);
    }
    return rewritten;
}

/**
 * Download a file via HTTPS, following redirects. Returns Buffer.
 */
function httpsDownload(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsDownload(res.headers.location, timeout).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

/**
 * HTTPS GET with a User-Agent header (Wikipedia requires one; MapTiler accepts it).
 * Returns Buffer. Follows redirects.
 */
function httpsGetWithUA(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const opts = {
            timeout,
            headers: { 'User-Agent': 'YTA-Empire/1.0 (video-gen)' },
        };
        const req = https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsGetWithUA(res.headers.location, timeout).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

/**
 * Wikipedia coordinate lookup. Uses the search generator to find the best-matching
 * article title for a place name, then reads the coordinates property. Returns
 * { lon, lat, zoom, type, name, geoName, fullName } or null.
 *
 * Deterministic (same query → same article), free, no API key. Handles any named
 * place that has a Wikipedia article — which is basically every geopolitical
 * location, strait, landmark, city, region on Earth.
 */
async function geocodeViaWikipedia(placeName) {
    if (!placeName) return null;
    try {
        const q = encodeURIComponent(placeName.trim());
        // generator=search finds the best article for loose queries like
        // "The Bab-el-Mandeb Strait" (exact title is "Bab-el-Mandeb"); prop=coordinates
        // returns the canonical lat/lon from the article infobox.
        const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=coordinates%7Cpageprops&generator=search&gsrsearch=${q}&gsrlimit=3&redirects=1&ppprop=wikibase-shortdesc`;
        const buf = await httpsGetWithUA(url, 6000);
        const data = JSON.parse(buf.toString());
        const pages = data && data.query && data.query.pages;
        if (!pages) return null;

        // Pick the first page that has coordinates (search results ordered by relevance)
        const ordered = Object.values(pages).sort((a, b) => (a.index || 999) - (b.index || 999));
        for (const page of ordered) {
            const c = page.coordinates && page.coordinates[0];
            if (!c || typeof c.lat !== 'number' || typeof c.lon !== 'number') continue;

            // Decide zoom from article short description. Rough heuristic:
            //   country → 5, region/state → 6, city → 9, landmark/strait → 7
            const desc = (page.pageprops && page.pageprops['wikibase-shortdesc'] || '').toLowerCase();
            let zoom = 7, type = 'landmark';
            if (/\bcountry\b|\bsovereign state\b/.test(desc))      { zoom = 5; type = 'country'; }
            else if (/\bregion\b|\bprovince\b|\bstate\b|\barea\b/.test(desc))  { zoom = 6; type = 'region'; }
            else if (/\bcity\b|\bcapital\b|\btown\b|\bmunicipality\b/.test(desc)) { zoom = 9; type = 'city'; }
            else if (/\bstrait\b|\bchannel\b|\bsea\b|\bbay\b|\bgulf\b|\bocean\b/.test(desc)) { zoom = 6; type = 'region'; }

            return {
                lon: c.lon,
                lat: c.lat,
                zoom,
                type,
                name: placeName,
                geoName: page.title || placeName,
                fullName: page.title || placeName,
            };
        }
        return null;
    } catch (err) {
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════
// Geocoding — MapTiler free tier (100K req/day)
// Converts "Berlin", "Tokyo Tower", "Sahara Desert" → exact lon/lat
// ══════════════════════════════════════════════════════════════════

/**
 * Geocode a place name → { lon, lat, type, name, zoom }.
 * type: 'city' | 'country' | 'region' | 'landmark' | 'unknown'
 * zoom: suggested zoom level based on place type.
 * Returns null if geocoding fails or no results.
 */
async function geocodePlace(placeName, apiKey) {
    if (!placeName) return null;

    const cacheKey = placeName.trim().toLowerCase();
    if (_geocodeCache.has(cacheKey)) return _geocodeCache.get(cacheKey);

    // Check hardcoded coords first (instant, no API call) — case-insensitive
    const hardcoded = GEO_COORDS[placeName] || GEO_COORDS[placeName.charAt(0).toUpperCase() + placeName.slice(1).toLowerCase()]
        || Object.entries(GEO_COORDS).find(([k]) => k.toLowerCase() === cacheKey)?.[1];
    if (hardcoded) {
        const result = { lon: hardcoded[0], lat: hardcoded[1], zoom: hardcoded[2] || 5, type: 'country', name: placeName };
        _geocodeCache.set(cacheKey, result);
        return result;
    }

    // Normalize common wrapper words the AI planner adds ("The X Strait", "X Sea", ...)
    // and retry hardcoded lookup before hitting MapTiler. Without this, named bodies of
    // water and chokepoints fall through to the API which often returns random POIs
    // (e.g. "The Bab-el-Mandeb Strait" → a Montana street).
    const normalized = cacheKey
        .replace(/^the\s+/i, '')
        .replace(/\s+(strait|sea|bay|gulf|ocean|channel|river|lake|peninsula|canal|island|islands)$/i, '')
        .trim();
    if (normalized && normalized !== cacheKey) {
        const norm = Object.entries(GEO_COORDS).find(([k]) => k.toLowerCase() === normalized)?.[1];
        if (norm) {
            const result = { lon: norm[0], lat: norm[1], zoom: norm[2] || 5, type: 'region', name: placeName };
            _geocodeCache.set(cacheKey, result);
            return result;
        }
    }
    // Substring fallback: "Bab-el-Mandeb" inside "The Bab-el-Mandeb Strait"
    const substring = Object.entries(GEO_COORDS).find(([k]) => {
        const lk = k.toLowerCase();
        return lk.length >= 5 && cacheKey.includes(lk);
    })?.[1];
    if (substring) {
        const result = { lon: substring[0], lat: substring[1], zoom: substring[2] || 5, type: 'region', name: placeName };
        _geocodeCache.set(cacheKey, result);
        return result;
    }

    // Wikipedia/Wikidata lookup. Deterministic, free, no key — pulls canonical
    // coordinates from the matching article's infobox. Sits between the hardcoded
    // dict and MapTiler so obscure-but-named places ("Bab-el-Mandeb Strait",
    // "Khyber Pass", "DMZ Korea") resolve correctly before we risk a MapTiler
    // street-POI false positive.
    const wiki = await geocodeViaWikipedia(placeName);
    if (wiki) {
        _geocodeCache.set(cacheKey, wiki);
        return wiki;
    }

    if (!apiKey) {
        _geocodeCache.set(cacheKey, null);
        return null;
    }

    try {
        const query = encodeURIComponent(placeName.trim());
        // Request multiple results and prefer city/country over street-level matches
        const url = `https://api.maptiler.com/geocoding/${query}.json?key=${apiKey}&limit=5&language=en`;
        const buf = await httpsDownload(url, 8000);
        const data = JSON.parse(buf.toString());

        if (!data.features || data.features.length === 0) {
            _geocodeCache.set(cacheKey, null);
            return null;
        }

        // Prefer city/country/region over street-level results
        // MapTiler sometimes returns a street named "Tokyo" before the city Tokyo
        const RANK = { country: 1, region: 2, subregion: 3, county: 4, municipality: 5, city: 5, town: 6, village: 7, neighbourhood: 8, poi: 9, address: 10 };
        const ranked = data.features.map(f => {
            const pt = f.place_type?.[0] || f.properties?.place_type?.[0] || 'address';
            return { feat: f, rank: RANK[pt] || 10, placeType: pt };
        }).sort((a, b) => a.rank - b.rank);

        // If best result is still a street/POI and the original query had no numbers
        // (not an address), take it but bump zoom down to reasonable level
        let feat = ranked[0].feat;
        const bestType = ranked[0].placeType;
        if ((bestType === 'address' || bestType === 'poi') && ranked.length > 1) {
            // Check if there's a city/region result anywhere
            const better = ranked.find(r => r.rank <= 7);
            if (better) feat = better.feat;
        }
        const [lon, lat] = feat.center || feat.geometry?.coordinates || [0, 0];
        const placeType = feat.place_type?.[0] || feat.properties?.place_type?.[0] || 'unknown';

        // Map MapTiler place_type → zoom level
        const ZOOM_BY_TYPE = {
            'country':       5,
            'region':        7,
            'subregion':     8,
            'county':        9,
            'municipality':  10,
            'city':          11,
            'town':          11,
            'village':       13,
            'neighbourhood': 14,
            'address':       15,
            'poi':           14,
            'landmark':      14,
        };

        // Cap zoom at 12 for video maps — higher zooms show too much street detail
        const rawZoom = ZOOM_BY_TYPE[placeType] || 10;
        const zoom = Math.min(rawZoom, 12);
        const type = ['country'].includes(placeType) ? 'country'
            : ['region', 'subregion', 'county'].includes(placeType) ? 'region'
            : ['city', 'town', 'municipality'].includes(placeType) ? 'city'
            : ['poi', 'landmark', 'address', 'neighbourhood', 'village'].includes(placeType) ? 'landmark'
            : 'unknown';

        const result = {
            lon, lat, zoom, type,
            name: placeName,  // Always preserve the user's original query name
            geoName: feat.text || feat.place_name || placeName,
            fullName: feat.place_name || placeName,
        };
        _geocodeCache.set(cacheKey, result);
        return result;
    } catch (err) {
        console.log(`      ⚠️ Geocode failed for "${placeName}": ${err.message}`);
        _geocodeCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Geocode multiple place names in parallel. Returns array of results (nulls filtered out).
 */
async function geocodePlaces(placeNames, apiKey) {
    const results = await Promise.all(
        placeNames.map(name => geocodePlace(name, apiKey))
    );
    return results.filter(Boolean);
}

/**
 * Compute map center and zoom from a list of entity names.
 * Uses geocoding for precise coordinates when API key is available.
 * Falls back to hardcoded GEO_COORDS dictionary.
 */
async function computeMapView(entities, apiKey, opts = {}) {
    // Try geocoding first if we have an API key
    let resolved = [];
    if (apiKey && entities.length > 0) {
        const geocoded = await geocodePlaces(entities, apiKey);
        resolved = geocoded.map(g => ({
            name: g.name,
            coords: [g.lon, g.lat, g.zoom],
            type: g.type,
            fullName: g.fullName,
        }));
    }

    // Fall back to hardcoded for any entities not geocoded
    if (resolved.length === 0) {
        resolved = entities
            .map(e => ({ name: e, coords: GEO_COORDS[e], type: 'country' }))
            .filter(r => r.coords);
    }

    if (resolved.length === 0) {
        return { lon: 0, lat: 20, zoom: 2, pins: [] };
    }

    // ── Geocode outlier guard ──
    // Nominatim occasionally returns a confident-but-wrong match for an
    // ambiguous phrase (e.g. "Regional Powers" → a Nova Scotia island).
    // When one point lies far outside the cluster formed by the rest, drop
    // it so the bbox reflects the actual story. Only triggers when we have
    // 3+ resolved points AND the cluster is reasonably tight (medDist<30°);
    // intentional long-haul scenes (Shanghai→Rotterdam, ~100°) are never
    // affected because medDist is naturally huge there.
    if (resolved.length >= 3) {
        const median = (arr) => {
            const s = arr.slice().sort((a, b) => a - b);
            return s[Math.floor(s.length / 2)];
        };
        const medLon = median(resolved.map(r => r.coords[0]));
        const medLat = median(resolved.map(r => r.coords[1]));
        const dists = resolved.map(r => Math.hypot(r.coords[0] - medLon, r.coords[1] - medLat));
        const medDist = median(dists);
        if (medDist < 30) {
            const threshold = Math.max(4 * medDist, 20);
            const keep = [];
            const dropped = [];
            for (let i = 0; i < resolved.length; i++) {
                if (dists[i] > threshold) dropped.push({ name: resolved[i].name, dist: dists[i] });
                else keep.push(resolved[i]);
            }
            if (dropped.length && keep.length >= 2) {
                console.log(`      🚫 Dropped ${dropped.length} geocode outlier(s) from framing: ${dropped.map(d => `${d.name} (${d.dist.toFixed(0)}° from cluster)`).join(', ')} [medDist=${medDist.toFixed(1)}°, threshold=${threshold.toFixed(1)}°, kept=${keep.length}/${resolved.length}]`);
                resolved = keep;
            }
        }
    }

    // Build pin data for the renderer
    const pins = resolved.map((r, i) => ({
        name: r.name,
        fullName: r.fullName || r.name,
        lon: r.coords[0],
        lat: r.coords[1],
        type: r.type || 'country',
        zoom: r.coords[2] || 5,
    }));

    if (resolved.length === 1) {
        const c = resolved[0].coords;
        return { lon: c[0], lat: c[1], zoom: c[2] || 5, pins };
    }

    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    for (const { coords: [lon, lat] } of resolved) {
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }

    const maxSpan = Math.max(maxLon - minLon, maxLat - minLat);

    let zoom;
    if (maxSpan > 200) zoom = 2;
    else if (maxSpan > 100) zoom = 2;
    else if (maxSpan > 60) zoom = 2.5;
    else if (maxSpan > 30) zoom = 3;
    else if (maxSpan > 15) zoom = 4;
    else if (maxSpan > 8) zoom = 5;
    else if (maxSpan > 4) zoom = 6;
    else zoom = 7;

    // When entities span the whole globe (zoom <= 2), older single-subject
    // locator maps bias center toward the primary entity. Multi-place route /
    // region / comparison maps need the true bbox center so the full overview
    // remains visible if the big-map path falls back to a standard image.
    const primary = resolved[0].coords;
    const preferBboxCenter = !!opts.preferBboxCenter;
    let centerLon, centerLat;
    if (zoom <= 2 && !preferBboxCenter) {
        const geoLon = (minLon + maxLon) / 2;
        const geoLat = (minLat + maxLat) / 2;
        centerLon = primary[0] * 0.6 + geoLon * 0.4;
        centerLat = primary[1] * 0.6 + geoLat * 0.4;
    } else {
        centerLon = (minLon + maxLon) / 2;
        centerLat = (minLat + maxLat) / 2;
    }

    return { lon: centerLon, lat: centerLat, zoom, pins };
}

// ══════════════════════════════════════════════════════════════════
// MapTiler Tile Stitcher — downloads 512px tiles and composites
// into a single 1920×1080 image using @napi-rs/canvas
// ══════════════════════════════════════════════════════════════════

const TILE_SIZE = 512;   // MapTiler serves 512px tiles
const OUT_W = 1920;
const OUT_H = 1080;

/** Convert lon/lat to fractional tile coordinates at a given zoom */
function lonLatToTile(lon, lat, zoom) {
    const z = Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * z;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * z;
    return { x, y };
}

/**
 * Calculate which tiles we need and where to place them on the canvas.
 * Returns { tiles: [{z, x, y, destX, destY}], ... }
 */
function computeTileGrid(view, width = OUT_W, height = OUT_H) {
    // Use integer zoom for tiles (MapTiler tiles only exist at integer zooms)
    // Minimum z=2 to avoid world-wrap duplication at very low zooms
    const z = Math.max(2, Math.floor(view.zoom));
    const maxTile = Math.pow(2, z);

    // Center tile position (fractional)
    const center = lonLatToTile(view.lon, view.lat, z);

    // How many pixels from center to edge
    const halfW = width / 2;
    const halfH = height / 2;

    // Pixel offset of center within its tile
    const centerPixelX = center.x * TILE_SIZE;
    const centerPixelY = center.y * TILE_SIZE;

    // Top-left pixel in the global tile-pixel space
    const originX = centerPixelX - halfW;
    const originY = centerPixelY - halfH;

    // Which tiles cover this region
    const tileMinX = Math.floor(originX / TILE_SIZE);
    const tileMinY = Math.floor(originY / TILE_SIZE);
    const tileMaxX = Math.floor((originX + width - 1) / TILE_SIZE);
    const tileMaxY = Math.floor((originY + height - 1) / TILE_SIZE);

    const tiles = [];
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        for (let tx = tileMinX; tx <= tileMaxX; tx++) {
            // Wrap X for world maps, clamp Y
            const wrappedX = ((tx % maxTile) + maxTile) % maxTile;
            if (ty < 0 || ty >= maxTile) continue;

            // Where to draw this tile on our canvas
            const destX = tx * TILE_SIZE - originX;
            const destY = ty * TILE_SIZE - originY;

            tiles.push({ z, x: wrappedX, y: ty, destX: Math.round(destX), destY: Math.round(destY) });
        }
    }

    return { tiles, z };
}

/**
 * Download a single MapTiler tile. Returns Buffer (PNG).
 * Uses @2x retina tiles (512px native) for crisp 1920×1080 output.
 */
function downloadTile(style, z, x, y, apiKey) {
    const cacheKey = `${style}/${z}/${x}/${y}`;
    if (_tileCache.has(cacheKey)) {
        return Promise.resolve(_tileCache.get(cacheKey));
    }
    // @2x suffix gives 512px retina tiles on the free tier
    const url = `https://api.maptiler.com/maps/${style}/${z}/${x}/${y}@2x.png?key=${apiKey}`;
    return httpsDownload(url, 10000).then(buf => {
        _tileCache.set(cacheKey, buf);
        return buf;
    });
}

/**
 * Stitch MapTiler tiles into a 1920×1080 PNG. Returns Buffer.
 * Uses @napi-rs/canvas for compositing.
 */
async function stitchMapTilerTiles(view, mapStyle, apiKey, outW, outH) {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const style = MAPTILER_STYLE_MAP[mapStyle] || MAPTILER_STYLE_MAP.dark;
    const canvasW = outW || OUT_W;
    const canvasH = outH || OUT_H;

    const { tiles, z } = computeTileGrid(view, canvasW, canvasH);
    const cachedCount = tiles.filter(t => _tileCache.has(`${style}/${t.z}/${t.x}/${t.y}`)).length;
    console.log(`      MapTiler: stitching ${tiles.length} tiles at z=${z} ${canvasW}×${canvasH} (${style})${cachedCount > 0 ? ` [${cachedCount} cached]` : ''}`);

    // Download all tiles in parallel (batched to avoid hammering)
    const BATCH_SIZE = 6;
    const tileImages = new Map();

    for (let i = 0; i < tiles.length; i += BATCH_SIZE) {
        const batch = tiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(async (t) => {
                const key = `${t.z}/${t.x}/${t.y}`;
                const buf = await downloadTile(style, t.z, t.x, t.y, apiKey);
                // @napi-rs/canvas SEGFAULTS on formats it cannot decode (exit 139, no
                // exception) — a tile server erroring into non-image bytes must not take
                // the build down. The allSettled below logs this as a normal tile failure.
                if (!isCanvasSafeImage(buf)) throw new Error('tile bytes are not safe to decode');
                const img = await loadImage(buf);
                tileImages.set(key, { img, tile: t });
            })
        );
        // Log failures
        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'rejected') {
                const t = batch[j];
                console.log(`      ⚠️ Tile ${t.z}/${t.x}/${t.y} failed: ${results[j].reason?.message}`);
            }
        }
    }

    if (tileImages.size === 0) {
        throw new Error('No tiles downloaded');
    }

    console.log(`      Downloaded ${tileImages.size}/${tiles.length} tiles`);

    // Stitch onto canvas
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');

    // Fill background matching the map style (covers missing/OOB tiles)
    const BG_COLORS = {
        dark: '#1a1a2e', natural: '#b5d0d0', satellite: '#0b1026',
        light: '#e8e8e8', political: '#aad3df',
    };
    ctx.fillStyle = BG_COLORS[mapStyle] || '#1a1a2e';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Draw tiles (512px native from MapTiler /512/ endpoint)
    for (const tile of tiles) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const entry = tileImages.get(key);
        if (!entry) continue;
        ctx.drawImage(entry.img, tile.destX, tile.destY, TILE_SIZE, TILE_SIZE);
    }

    return canvas.toBuffer('image/png');
}

// ── Geoapify URL builder (fallback) ──

function buildGeoapifyUrl(view, mapStyle, apiKey) {
    const style = GEOAPIFY_STYLE_MAP[mapStyle] || GEOAPIFY_STYLE_MAP.dark;
    return `https://maps.geoapify.com/v1/staticmap?style=${style}&width=1920&height=1080&center=lonlat:${view.lon},${view.lat}&zoom=${view.zoom}&apiKey=${apiKey}`;
}

/**
 * Extract location names from an MG's own payload (mg.text + mg.subtext).
 *
 * Slice 3 note: this is now a NARROW legacy-only fallback, used when the
 * caller did not supply a compiled MapScene (src/map-compiler.js) and the
 * planner also produced no waypoints. MapScene.subjects is the authoritative
 * input for Slice 3+; this helper only parses what the MG payload itself
 * claims, without scanning the GEO_COORDS dictionary or dumping
 * scriptContext.entities across unrelated scenes.
 *
 * Supported inputs (in order tried, first non-empty wins):
 *   1. Subtext "Place: label, Place: label" pairs (and meta-directive keys
 *      like "Region: Middle East" where the value is the place).
 *   2. Meta-directive text like "Zoom on Persian Gulf" — strip the verb
 *      prefix, use the remainder as a single place.
 */
function extractEntities(mg, scriptContext) {
    const entityTypes = scriptContext?.entityTypes || {};

    const META_KEY_RE = /^(region|zoom|pan|view|map|focus|overview|closeup|close-up|highlight|scene|labels?)$/i;
    const META_PREFIX_RE = /^(zoom\s+(?:on|in(?:to)?|to)|pan\s+(?:to|across)|view\s+of|focus\s+on|overview\s+of|highlight(?:ing)?|map\s+of|region:?)\s+/i;

    const stripMetaPrefix = (s) => {
        if (!s) return '';
        let out = String(s).trim();
        for (let i = 0; i < 2; i++) {
            const stripped = out.replace(META_PREFIX_RE, '').trim();
            if (stripped === out) break;
            out = stripped;
        }
        return out;
    };

    // 1. Parse subtext "Location: value" pairs.
    let entities = [];
    const subtext = mg.subtext || '';
    if (subtext) {
        const pairs = subtext.split(',').map(s => s.trim()).filter(Boolean);
        for (const pair of pairs) {
            const colonIdx = pair.indexOf(':');
            if (colonIdx > 0) {
                const key = pair.substring(0, colonIdx).trim();
                const val = pair.substring(colonIdx + 1).trim();
                if (META_KEY_RE.test(key)) {
                    if (val && val.length >= 2 && val.split(/\s+/).length <= 6) {
                        entities.push(val);
                    }
                } else if (key.length >= 2 && key.split(/\s+/).length <= 6) {
                    entities.push(key);
                }
            }
        }
    }
    let filtered = filterPlaces(entities, entityTypes, 'entities');
    if (filtered.length > 0) return filtered;

    // 2. If mg.text is a meta-directive like "Zoom on Persian Gulf", strip the
    //    prefix and use the remainder as a single place.
    const textStripped = stripMetaPrefix(mg.text || '');
    if (textStripped && textStripped !== (mg.text || '').trim()) {
        const wordCount = textStripped.split(/\s+/).length;
        if (wordCount >= 1 && wordCount <= 4) {
            filtered = filterPlaces([textStripped], entityTypes, 'entities');
            if (filtered.length > 0) return filtered;
        }
    }

    // No dictionary scan, no scriptContext.entities dump (Slice 3: removed).
    return [];
}

/**
 * Slice 5b: generate cameraPlan.stops from materialized waypoints + geocoded
 * coordinates. Flag-gated behind USE_CAMERA_PLAN_STOPS. When the flag is off,
 * or any validation fails, stops remain null and the renderer falls back to
 * its legacy bbox-fit / per-mode camera path (unchanged today).
 *
 * Shape (per stop): { subjectId, lon, lat, zoom, tilt, bearing, orbit,
 *                     startTime, endTime, dwellSec, easeIn, label }
 *
 * Sources:
 *   - timing + camera intent  → mg._mapWaypoints (from _materializeWaypoints…)
 *   - lon/lat                 → mg._wpCoords (big-map) ?? view.pins (standard)
 *                               ?? mapScene.geometry.pins
 *   - subjectId               → mapScene.subjects[].id (name-match)
 */
// Project provider coords exactly like MGRenderer's big-map camera path so
// generated overview stops fit the actual downloaded image, not rough degrees.
function _projectCoordToMapPixel(lon, lat, mapView, bigMapSize) {
    if (!mapView || !bigMapSize) return null;
    const imgW = Number(bigMapSize.w);
    const imgH = Number(bigMapSize.h);
    if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) return null;

    const z = Math.max(2, Math.floor(Number(mapView.zoom) || 2));
    const n = Math.pow(2, z);
    const projectX = (xLon) => ((xLon + 180) / 360) * n * TILE_SIZE;
    const projectY = (yLat) => {
        const latRad = yLat * Math.PI / 180;
        return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;
    };

    const originX = projectX(Number(mapView.lon)) - imgW / 2;
    const originY = projectY(Number(mapView.lat)) - imgH / 2;
    return { x: projectX(lon) - originX, y: projectY(lat) - originY };
}

function _fitEstablishZoomFromPixels(coords, opts = {}) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const bigMapSize = opts.bigMapSize || null;
    const mapView = opts.mapView || null;
    const imgW = Number(bigMapSize?.w);
    const imgH = Number(bigMapSize?.h);
    if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) return null;

    const pixels = coords
        .map(c => _projectCoordToMapPixel(c.lon, c.lat, mapView, bigMapSize))
        .filter(Boolean);
    if (pixels.length < 2) return null;

    const xs = pixels.map(p => p.x);
    const ys = pixels.map(p => p.y);
    const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs));
    const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));

    const frameW = Number(opts.frameW) || OUT_W;
    const frameH = Number(opts.frameH) || OUT_H;
    const headroom = opts.mode === 'route' ? 1.6 : 1.5;
    const paddedFit = Math.min(frameW / (spanX * headroom), frameH / (spanY * headroom));
    const endpointFit = Math.min(frameW / spanX, frameH / spanY);
    const fillFrame = Math.max(frameW / imgW, frameH / imgH);

    // Prefer padding, but the IMAGE MUST FILL THE FRAME (no black bars).
    // When the bigMap is tall/skinny relative to the span, endpointFit can be
    // smaller than fillFrame — capping to endpointFit there leaves the scaled
    // image smaller than the frame (black bar on whichever axis is exposed).
    // fillFrame is a hard floor; endpointFit is only a soft ceiling when it
    // doesn't violate the floor.
    let zoom = Math.max(paddedFit, fillFrame);
    if (zoom > endpointFit && endpointFit >= fillFrame) zoom = endpointFit;
    zoom = Math.max(zoom, fillFrame);
    if (!Number.isFinite(zoom) || zoom <= 0) return null;
    return Math.max(0.25, Math.min(1.3, zoom));
}

// Compute a single "establish" stop for region / comparison modes: a held
// wide frame centered on the bbox of all valid subject coords.
function _buildEstablishStop(mapScene, waypoints, findCoord, subjectByName, opts = {}) {
    // Collect valid coords for all subjects in the scene (not just waypoints
    // — we want EVERY subject represented in the wide frame).
    const coords = [];
    for (const subj of (mapScene.subjects || [])) {
        if (!subj || !subj.name) continue;
        const c = findCoord(subj.name);
        if (!c) continue;
        if (_looksLikePlaceholderCoord(c.lon, c.lat)) continue;
        coords.push({ name: subj.name, lon: c.lon, lat: c.lat, id: subj.id });
    }
    if (coords.length < 2) return null;

    // Bounding box.
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const c of coords) {
        if (c.lon < minLon) minLon = c.lon;
        if (c.lon > maxLon) maxLon = c.lon;
        if (c.lat < minLat) minLat = c.lat;
        if (c.lat > maxLat) maxLat = c.lat;
    }
    const maxSpan = Math.max(maxLon - minLon, maxLat - minLat);
    // Fallback span-to-zoom buckets. Big-map renders override this below with
    // pixel-fit zoom so wide regions do not crop off endpoints.
    const isRoute = opts.mode === 'route';
    // Routes widen by one step so the arc/corridor has breathing room and the
    // viewer can read the full journey — not just the endpoints.
    let zoom;
    if (maxSpan > 60)      zoom = isRoute ? 0.75 : 0.85;
    else if (maxSpan > 30) zoom = isRoute ? 0.9  : 1.0;
    else if (maxSpan > 15) zoom = isRoute ? 1.0  : 1.1;
    else if (maxSpan > 8)  zoom = isRoute ? 1.1  : 1.2;
    else                   zoom = isRoute ? 1.2  : 1.3;
    zoom = _fitEstablishZoomFromPixels(coords, opts) ?? zoom;

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;

    // Scene-level timing: span from the first waypoint's start to the last
    // waypoint's end so the establish shot holds for the full MG duration.
    const starts = waypoints.map(w => Number(w.startTime)).filter(Number.isFinite);
    const ends   = waypoints.map(w => Number(w.endTime)).filter(Number.isFinite);
    const startTime = starts.length ? Math.min(...starts) : 0;
    const endTime   = ends.length   ? Math.max(...ends)   : Math.max(2, (mapScene.duration || 6));
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return null;

    // Primary subject drives the stop's id (if present) — lets the renderer
    // still know who this frame "belongs to" for label activation.
    const primarySubj = (mapScene.subjects || []).find(s => s && s.role === 'primary')
                     || (mapScene.subjects || [])[0]
                     || null;

    return {
        subjectId: primarySubj?.id || null,
        lon: centerLon,
        lat: centerLat,
        zoom,
        tilt: 0,
        bearing: 0,
        orbit: 0,
        startTime,
        endTime,
        dwellSec: endTime - startTime,
        easeIn: 'smooth',
        label: coords.map(c => c.name).join(' + '),
    };
}

function _buildCameraPlanStops(mapScene, mg, view) {
    if (String(process.env.USE_CAMERA_PLAN_STOPS || '').toLowerCase() !== 'true') {
        return null;
    }
    if (!mapScene || !Array.isArray(mapScene.subjects) || mapScene.subjects.length === 0) {
        return null;
    }

    const waypoints = Array.isArray(mg._mapWaypoints) ? mg._mapWaypoints : [];
    if (waypoints.length === 0) {
        console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} SKIPPED (no waypoints)`);
        return null;
    }

    // Case-insensitive name → {lon,lat} lookup from every available source.
    const coordLookup = new Map();
    const addLookup = (name, lon, lat) => {
        if (!name || typeof lon !== 'number' || typeof lat !== 'number') return;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const key = String(name).toLowerCase().trim();
        if (!key) return;
        if (!coordLookup.has(key)) coordLookup.set(key, { lon, lat });
    };
    if (Array.isArray(mg._wpCoords)) {
        for (const c of mg._wpCoords) addLookup(c.name, c.lon, c.lat);
    }
    if (view && Array.isArray(view.pins)) {
        for (const p of view.pins) addLookup(p.name, p.lon, p.lat);
    }
    if (mapScene.geometry && Array.isArray(mapScene.geometry.pins)) {
        for (const p of mapScene.geometry.pins) addLookup(p.name, p.lon, p.lat);
    }

    const findCoord = (name) => {
        const lower = String(name || '').toLowerCase().trim();
        if (!lower) return null;
        if (coordLookup.has(lower)) return coordLookup.get(lower);
        // Loose contains-match (mirrors the big-map wpCoords lookup policy).
        for (const [k, v] of coordLookup) {
            if (k.includes(lower) || lower.includes(k)) return v;
        }
        return null;
    };

    const subjectByName = new Map();
    for (const s of mapScene.subjects) {
        if (s && s.name) subjectByName.set(String(s.name).toLowerCase().trim(), s);
    }

    // ── Region / comparison mode: collapse to ONE bbox-centered establish stop ──
    // Per-subject sequential stops on a multi-continent region-highlight scene
    // produces a pan (Asia→Europe) that looks like the map is sliding off-frame.
    // The editorial intent for "between Asia and Europe" / "compare X and Y" is
    // a single held-wide frame showing BOTH subjects simultaneously. Collapse.
    const mode = mapScene.mapMode;
    if ((mode === 'region' || mode === 'comparison') && waypoints.length >= 2) {
        const collapsed = _buildEstablishStop(mapScene, waypoints, findCoord, subjectByName, {
            mode,
            mapView: view,
            bigMapSize: mg._bigMapSize || null,
            frameW: OUT_W,
            frameH: OUT_H,
        });
        if (collapsed) {
            const framing = mapScene.cameraPlan?.framing || '?';
            console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} mode=${mode} stops=1 framing=${framing} (establish-shot, ${waypoints.length} subjects wide, zoom=${collapsed.zoom.toFixed(2)}, dwell=${collapsed.dwellSec.toFixed(1)}s)`);
            return [collapsed];
        }
        // If the collapse failed (all coords invalid, etc.) fall through to the
        // per-subject path, which will either produce something or reject.
        console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} mode=${mode} establish-collapse failed — falling through to per-subject path`);
    }

    // ── Route mode: authored corridor overview for long-haul routes ──
    // For cross-continent routes (Shanghai→Rotterdam ~116° span) we want ONE
    // held corridor-overview camera stop that shows the full journey at a
    // glance, plus a dashed route line that animates through every waypoint
    // inside that stable frame. Previously this branch returned null so the
    // renderer's legacy bbox-fit at MGRenderer.js:3898 composed the shot — an
    // intentional fallback that worked but left the shot accidental rather
    // than authored. Now we build an explicit establish stop here and emit a
    // separate route-geometry array (_mapRouteGeometry) so the route line
    // still draws through all endpoints without forcing camera motion.
    //
    // Short/local routes can keep per-subject stops for legacy/manual plans,
    // but MapScene.cameraPlan.framing is authoritative. If the compiler asked
    // for held-wide, keep the full route in one stable frame even when the
    // route span is small enough that the old local-route heuristic would pan.
    //
    // Detour geography ("around Africa") is typically tagged kind='region'
    // (continents, seas, broad areas). When we have ≥2 country/city/waterbody
    // anchors, regions are excluded from the FRAMING bbox so the corridor
    // center/zoom reflects the actual path — not the detour reference. They
    // remain in mapScene.subjects so pins, labels, and route geometry still
    // include them; only the camera bbox ignores them.
    const ROUTE_CORRIDOR_SPAN_DEG = 15;
    if (mode === 'route' && waypoints.length >= 2) {
        let rMinLon = Infinity, rMaxLon = -Infinity, rMinLat = Infinity, rMaxLat = -Infinity;
        let rValidCount = 0;
        for (const wp of waypoints) {
            const c = findCoord(wp.name);
            if (!c || _looksLikePlaceholderCoord(c.lon, c.lat)) continue;
            if (c.lon < rMinLon) rMinLon = c.lon;
            if (c.lon > rMaxLon) rMaxLon = c.lon;
            if (c.lat < rMinLat) rMinLat = c.lat;
            if (c.lat > rMaxLat) rMaxLat = c.lat;
            rValidCount++;
        }
        const routeSpan = rValidCount >= 2 ? Math.max(rMaxLon - rMinLon, rMaxLat - rMinLat) : 0;
        const requestedHeldWide = String(mapScene.cameraPlan?.framing || '').toLowerCase() === 'held-wide';

        if (routeSpan > ROUTE_CORRIDOR_SPAN_DEG || (requestedHeldWide && rValidCount >= 2)) {
            // Split subjects into framing anchors vs. excluded broad regions.
            const nonRegionCount = (mapScene.subjects || []).filter(s => s && s.kind !== 'region').length;
            const framingSubjects = [];
            const excludedFromFraming = [];
            const detourFraming = [];
            for (const subj of (mapScene.subjects || [])) {
                if (!subj || !subj.name) continue;
                if (subj.kind === 'region' && nonRegionCount >= 2) {
                    const alias = _routeDetourAlias(subj.name);
                    if (alias) {
                        framingSubjects.push({ ...subj, id: 'cape-of-good-hope', name: alias, kind: 'place' });
                        detourFraming.push(`${subj.name}->${alias}`);
                        continue;
                    }
                    excludedFromFraming.push(subj.name);
                    continue;
                }
                framingSubjects.push(subj);
            }
            const framingScene = Object.assign({}, mapScene, { subjects: framingSubjects });

            // Build the single corridor-overview stop. _buildEstablishStop
            // uses route-specific headroom (1.6x) so the arc has breathing
            // room, and its pixel-fit path keeps endpoints inside the frame.
            const corridor = _buildEstablishStop(
                framingScene, waypoints, findCoord, subjectByName,
                { mode: 'route', mapView: view, bigMapSize: mg._bigMapSize || null, frameW: OUT_W, frameH: OUT_H }
            );

            if (corridor) {
                // Extend the stop to cover the FULL scene timeline so the
                // camera holds steady while the route line animates through
                // it. Without this, _buildEstablishStop uses the first/last
                // waypoint start/end — which is fine but we want to be
                // explicit that this is a single-stop establish.
                const wpStarts = waypoints.map(w => Number(w.startTime)).filter(Number.isFinite);
                const wpEnds   = waypoints.map(w => Number(w.endTime)).filter(Number.isFinite);
                if (wpStarts.length) corridor.startTime = Math.min(...wpStarts);
                if (wpEnds.length)   corridor.endTime   = Math.max(...wpEnds);
                corridor.dwellSec = corridor.endTime - corridor.startTime;

                // Route geometry — partition waypoints into the SAME semantic
                // groups the framing split uses, so the dashed route line tells
                // the same story the camera does:
                //   • primary route anchors   → real path (drawn as main dashed line)
                //   • corridor anchors        → waterways/cities on the path (primary)
                //   • detour / alternate      → regions mentioned as alt routes
                //                               ("around Africa") — stored separately
                //                               in _mapAlternateRouteGeometry for
                //                               possible future alt-path rendering,
                //                               NEVER appended to the primary dashed
                //                               line
                //   • display-only labels     → pins only (never in route geometry)
                //
                // Mirrors the framing rule exactly: region-kind subjects are moved
                // to the alternate bucket only when ≥2 non-region anchors exist.
                // That prevents a single city + continent scene from being wrongly
                // split. If the framing decided to keep regions in (nonRegion<2),
                // they also stay in the primary path.
                const primaryRouteGeom = [];
                const alternateRouteGeom = [];
                const excludedFromPrimaryRoute = [];
                for (const wp of waypoints) {
                    const c = findCoord(wp.name);
                    if (!c || _looksLikePlaceholderCoord(c.lon, c.lat)) continue;
                    const st = Number(wp.startTime);
                    const et = Number(wp.endTime);
                    if (!Number.isFinite(st) || !Number.isFinite(et) || et <= st) continue;
                    const subj = subjectByName.get(String(wp.name || '').toLowerCase().trim()) || null;
                    const isRegion = !!(subj && subj.kind === 'region');
                    const pt = { name: wp.name, lon: c.lon, lat: c.lat, startTime: st, endTime: et };
                    if (isRegion && nonRegionCount >= 2) {
                        alternateRouteGeom.push(_routeDetourPoint(pt));
                        excludedFromPrimaryRoute.push(wp.name);
                    } else {
                        primaryRouteGeom.push(pt);
                    }
                }
                const expandedPrimaryRouteGeom = primaryRouteGeom.length >= 2
                    ? _expandKnownMaritimeRoute(primaryRouteGeom)
                    : primaryRouteGeom;
                if (expandedPrimaryRouteGeom.length >= 2) {
                    mg._mapRouteGeometry = expandedPrimaryRouteGeom;
                }
                if (alternateRouteGeom.length >= 1 && expandedPrimaryRouteGeom.length >= 2) {
                    const altStart = expandedPrimaryRouteGeom[0];
                    const altEnd = expandedPrimaryRouteGeom[expandedPrimaryRouteGeom.length - 1];
                    mg._mapAlternateRouteGeometry = _withDistributedRouteTimes(
                        [altStart, ...alternateRouteGeom, altEnd],
                        corridor.startTime,
                        corridor.endTime
                    );
                }

                const excludedLabel = excludedFromFraming.length > 0
                    ? `, excluded-from-framing=[${excludedFromFraming.join(', ')}]`
                    : '';
                const detourLabel = detourFraming.length > 0
                    ? `, detour-framing=[${detourFraming.join(', ')}]`
                    : '';
                const routeFraming = requestedHeldWide ? 'held-wide-route' : 'route-corridor';
                const routeReason = requestedHeldWide
                    ? `compiler-held-wide, span=${routeSpan.toFixed(0)}°`
                    : `span=${routeSpan.toFixed(0)}°`;
                console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} mode=route framing=${routeFraming} (${routeReason}, ${rValidCount} anchors → 1 corridor stop, center=[${corridor.lon.toFixed(1)},${corridor.lat.toFixed(1)}] zoom=${corridor.zoom.toFixed(2)}${excludedLabel}${detourLabel})`);
                if (excludedFromPrimaryRoute.length > 0) {
                    console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} excluded-from-primary-route=[${excludedFromPrimaryRoute.join(', ')}]`);
                }
                if (expandedPrimaryRouteGeom.length >= 2) {
                    console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} route geometry retained: ${expandedPrimaryRouteGeom.length} points for dashed path (${expandedPrimaryRouteGeom.map(p => p.name).join(' -> ')})`);
                }
                if (mg._mapAlternateRouteGeometry?.length > 0) {
                    console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} alternate-route-candidates=[${alternateRouteGeom.map(p => p.name).join(', ')}] alt-path=(${mg._mapAlternateRouteGeometry.map(p => p.name).join(' -> ')})`);
                }
                console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} final stops count=1 (corridor)`);
                return [corridor];
            }
            console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} mode=route corridor build failed (no valid framing coords) — falling back to null (legacy bbox-fit)`);
            return null;
        } else if (rValidCount >= 2) {
            console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} mode=route framing=local-route (span=${routeSpan.toFixed(0)}° ≤${ROUTE_CORRIDOR_SPAN_DEG}°) — per-subject stops`);
        }
    }

    const stops = [];
    const dropped = [];    // per-waypoint reasons, logged at the end
    for (const wp of waypoints) {
        // Defense-in-depth: the compiler filters editorial labels from
        // mapScene.subjects, but a bogus wp.name could still arrive via
        // legacy _mapWaypoints. Require the waypoint name to match an
        // authoritative subject (case-insensitive) — unknown names drop.
        const subj = subjectByName.get(String(wp.name || '').toLowerCase().trim()) || null;
        if (!subj) { dropped.push(`"${wp.name}" (not in mapScene.subjects)`); continue; }

        const coord = findCoord(wp.name);
        if (!coord)                                             { dropped.push(`"${wp.name}" (no coord)`); continue; }
        if (_looksLikePlaceholderCoord(coord.lon, coord.lat))   { dropped.push(`"${wp.name}" (placeholder coord [${coord.lon},${coord.lat}])`); continue; }

        const zoom = Number(wp.zoom);
        if (!Number.isFinite(zoom) || zoom <= 0) { dropped.push(`"${wp.name}" (bad zoom)`); continue; }

        const startTime = Number(wp.startTime);
        const endTime   = Number(wp.endTime);
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
            dropped.push(`"${wp.name}" (bad timing)`); continue;
        }

        stops.push({
            subjectId: subj.id || null,
            lon: coord.lon,
            lat: coord.lat,
            zoom,
            tilt:    (wp.tilt    != null && Number.isFinite(Number(wp.tilt)))    ? Number(wp.tilt)    : 0,
            bearing: (wp.bearing != null && Number.isFinite(Number(wp.bearing))) ? Number(wp.bearing) : 0,
            orbit:   (wp.orbit   != null && Number.isFinite(Number(wp.orbit)))   ? Number(wp.orbit)   : 0,
            startTime,
            endTime,
            dwellSec: endTime - startTime,
            easeIn: 'smooth',
            label: wp.name || null,
        });
    }

    if (dropped.length > 0) {
        console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} dropped ${dropped.length} waypoint(s): ${dropped.join(', ')}`);
    }
    if (stops.length === 0) {
        console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} REJECTED (no valid stops survived) — falling back to null`);
        return null;
    }
    // Mode-specific sanity: route + comparison need ≥2 real endpoints. If the
    // filter stripped us below that, drop stops entirely and let the renderer
    // fall back to its bbox-fit safety net (single known-good pin = locator
    // framing anyway). This prevents a broken route-pan between one real
    // subject and a bogus/missing endpoint.
    if ((mode === 'route' || mode === 'comparison') && stops.length < 2) {
        console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} REJECTED (mode=${mode} needs ≥2 stops, got ${stops.length}) — falling back to null`);
        return null;
    }

    const avgDwell = stops.reduce((a, s) => a + s.dwellSec, 0) / stops.length;
    const framing = mapScene.cameraPlan?.framing || '?';
    console.log(`      🎥 cameraPlan.stops: scene=${mapScene.sceneIndex} mode=${mapScene.mapMode} stops=${stops.length} framing=${framing} (dwell avg=${avgDwell.toFixed(1)}s)`);
    return stops;
}

/**
 * Populate the MapScene.geometry + renderAssets artifacts after a successful
 * download. Slice 4 consumes these to drive the renderer without reading the
 * legacy mg._mapView / mg._mapPins side-channels.
 */
function _populateMapSceneAssets(mapScene, mg, view) {
    if (!mapScene) return;
    mapScene.geometry = {
        center: { lon: view.lon, lat: view.lat },
        zoom: view.zoom,
        pins: Array.isArray(view.pins) ? view.pins : [],
    };
    // Slice 5b: flag-gated cameraPlan.stops generation. Writes into the
    // existing cameraPlan slot that the compiler leaves as { framing, stops: null }.
    // When the flag is off, or validation fails, stops stay null and the
    // renderer's legacy bbox-fit / per-mode camera path runs unchanged.
    if (mapScene.cameraPlan) {
        mapScene.cameraPlan.stops = _buildCameraPlanStops(mapScene, mg, view);
    }
    // renderAssets is the full, self-contained snapshot the renderer will read
    // once Phase B lands. Mirror every legacy side-channel field here so the
    // renderer has no reason to reach for mg._mapWaypoints / mg._mapView / etc.
    // Values are captured by reference — no deep clones — which matches how the
    // legacy fields were shared too.
    mapScene.renderAssets = {
        mapImageFile: mg.mapImageFile || null,
        bigMapSize:   mg._bigMapSize    || null,
        osmBoundaries: mg._osmBoundaries || null,
        mapView:      mg._mapView       || view,
        waypoints:    Array.isArray(mg._mapWaypoints) ? mg._mapWaypoints : null,
        wpCoords:     Array.isArray(mg._wpCoords)     ? mg._wpCoords     : null,
        swarms:       Array.isArray(mg._mapSwarms)    ? mg._mapSwarms    : null,
        icons:        mg._mapIcons      || null,
        routePath:    !!mg._mapRoutePath,
        routeGeometry: Array.isArray(mg._mapRouteGeometry) ? mg._mapRouteGeometry : null,
        alternateRouteGeometry: Array.isArray(mg._mapAlternateRouteGeometry) ? mg._mapAlternateRouteGeometry : null,
        bigMap:       !!mg._mapBigMap,
        stylePackId:  mg.mapStylePack || null,
    };
}

/**
 * Slice 4: deterministic waypoint materializer. Replaces the deleted AI map
 * planner by projecting MapScene.subjects + mapMode onto the legacy waypoint
 * fields the renderer still reads (mg._mapWaypoints, mg._mapBigMap,
 * mg._mapRoutePath). No AI, no narration parsing — choreography is derived
 * from the compiler's canonical subject list in the order it produced them.
 *
 * Mode behavior (tuned for calmer camera — user feedback: remove aggressive
 * zoom-toward-subject choreography):
 *   - locator:    held-wide across all subjects (z=1.2, gentle pan only).
 *   - route:      held-wide across all subjects (z=1.4, no tilt);
 *                 also sets mg._mapRoutePath so the renderer draws the arc.
 *   - region:     first wide (z=1.0), subsequent slightly tighter (z=1.3).
 *   - comparison: held-wide across all subjects (z=1.3, no tilt).
 * Tilt is null in every mode — the old 0.15 tilt on locator/region tight
 * shots added "dolly-in" feel that read as unnecessary motion.
 */
function _materializeWaypointsFromMapScene(mg, mapScene) {
    if (!mapScene) return;
    const subjects = Array.isArray(mapScene.subjects) ? mapScene.subjects : [];
    if (subjects.length === 0) return;

    const mode = mapScene.mapMode || 'locator';
    const duration = Math.max(2, mg.duration || 8);
    const perWp = Math.max(2, duration / subjects.length);

    const zoomFor = (i) => {
        if (mode === 'route')      return 1.4;
        if (mode === 'comparison') return 1.3;
        if (mode === 'region')     return i === 0 ? 1.0 : 1.3;
        return 1.2; // locator: all subjects at the same wide zoom
    };
    const tiltFor = (_i) => null; // all modes: no tilt/dolly

    const waypoints = subjects.map((s, i) => ({
        name: s.name,
        startTime: Math.min(i * perWp, Math.max(0, duration - 1)),
        endTime: Math.min((i + 1) * perWp, duration),
        zoom: zoomFor(i),
        tilt: tiltFor(i),
        bearing: null,
        orbit: null,
        icon: null,
    }));

    mg._mapWaypoints = waypoints;
    mg._mapBigMap = true;
    mg._mapRoutePath = mode === 'route';

    console.log(`      🧭 Materialized ${waypoints.length} waypoint(s) from MapScene (${mode}): ${waypoints.map(w => `${w.name} z${w.zoom}`).join(', ')}`);
}

/**
 * Download a static map image for a mapChart MG.
 * Tries MapTiler (tile stitching) first, then Geoapify (static API).
 * Now with geocoding: resolves city/landmark names → exact coordinates.
 *
 * Slice 6B entity resolution:
 *   1. scene._mapScene.subjects (from src/map-compiler.js) — authoritative.
 *   2. extractEntities(mg, scriptContext) — narrow payload-only fallback when
 *      the compiler didn't produce subjects (e.g. a raw mapChart MG with no
 *      compiled MapScene).
 *
 * The `scenes` argument (optional) is the list of compiled scenes; we look up
 * the owning scene by mg.sceneIndex to find its attached MapScene.
 */
async function downloadMapForMG(mg, scriptContext, tempDir, scenes) {
    const maptilerKey = config.maptiler?.apiKey;
    const geoapifyKey = config.geoapify?.apiKey;

    if (!maptilerKey && !geoapifyKey) {
        console.log('   ⚠️ No map API key configured (set MAPTILER_API_KEY or GEOAPIFY_API_KEY)');
        console.log('      mapChart will use Canvas2D fallback');
        return false;
    }

    const entityTypes = scriptContext?.entityTypes || {};

    // Slice 3: look up the authoritative MapScene.
    // Precedence:
    //   1. mg._mapScene — set by build-video when adjacent map MGs are merged
    //      across multiple scenes (multi-scene route). Covers the full span.
    //   2. scene._mapScene — single-scene map from the compiler.
    const ownerScene = (Array.isArray(scenes) && mg.sceneIndex != null)
        ? scenes.find(s => s && s.index === mg.sceneIndex) || null
        : null;
    const mapScene = mg._mapScene || ownerScene?._mapScene || null;

    // Slice 4 prep for Phase B: pin the resolved MapScene back onto the MG
    // itself, so downstream (build-video merge-back, video-plan.json, renderer)
    // always finds it on mg._mapScene without having to re-walk the scenes
    // array. Single-scene MGs previously only had it on the owning scene.
    if (mapScene && mg._mapScene !== mapScene) {
        mg._mapScene = mapScene;
    }

    // Slice 4: materialize deterministic waypoints from MapScene.subjects BEFORE
    // the big-map / pin logic runs. Previously the AI map planner populated
    // mg._mapWaypoints in a separate pipeline step; now the provider owns it.
    // Skip if waypoints were already attached (e.g. UI Map Test manual override).
    if (mapScene && !Array.isArray(mg._mapWaypoints)) {
        _materializeWaypointsFromMapScene(mg, mapScene);
    }

    let entities;
    if (mapScene && Array.isArray(mapScene.subjects) && mapScene.subjects.length > 0) {
        // Authoritative path: MapScene subjects are canonicalized + capped per mode.
        entities = mapScene.subjects.map(s => s.name).filter(Boolean);
        entities = _routeEntitiesForMapScene(mapScene, entities);
        console.log(`      🧭 MapScene (${mapScene.mapMode}, ${mapScene.mapPurpose}): ${entities.join(', ')}`);
    } else {
        // Compiler produced no subjects — narrow payload-only fallback.
        entities = extractEntities(mg, scriptContext);
        if (entities.length > 0) {
            console.log(`      📝 Payload fallback (no MapScene subjects): ${entities.join(', ')}`);
        }
    }

    // Use geocoding for precise coordinates (async — MapTiler free tier)
    const preferBboxCenter = !!(mapScene && ['route', 'region', 'comparison'].includes(mapScene.mapMode));
    const view = await computeMapView(entities, maptilerKey, { preferBboxCenter });
    const mapStyle = mg.mapStyle || 'dark';
    const filename = `map-${mapStyle}-${Date.now()}.png`;
    const filePath = path.join(tempDir, filename);

    console.log(`   🗺️ Downloading map: ${mapStyle} style, center=[${view.lon.toFixed(1)},${view.lat.toFixed(1)}], zoom=${view.zoom}`);
    console.log(`      Entities: ${entities.length > 0 ? entities.join(', ') : '(none — world view)'}`);
    if (view.pins?.length) {
        for (const pin of view.pins) {
            console.log(`      📍 ${pin.name} (${pin.type}) → [${pin.lon.toFixed(2)}, ${pin.lat.toFixed(2)}] z${pin.zoom}`);
        }
    }

    // Fetch OSM boundary polygons for country + city highlighting
    try {
        const boundaryNames = new Set(entities);
        // Extract country names from geocoded pin fullNames + add city names
        if (view.pins?.length) {
            for (const pin of view.pins) {
                // Add the city/location name itself
                if (pin.name) boundaryNames.add(pin.name);
                const parts = (pin.fullName || '').split(',').map(s => s.trim());
                // Last part is the country
                if (parts.length > 1) boundaryNames.add(parts[parts.length - 1]);
            }
        }
        if (boundaryNames.size > 0) {
            const osmBounds = await fetchOSMBoundaries([...boundaryNames]);
            if (osmBounds.length > 0) {
                mg._osmBoundaries = osmBounds;
                console.log(`      🗺️ OSM boundaries: ${osmBounds.map(b => b.name).join(', ')}`);
            }
        }
    } catch (e) {
        console.log(`      ⚠️ OSM boundary fetch failed: ${e.message}`);
    }

    // ── Big map mode: single large tile for waypoint animations ──
    const useBigMap = mg._mapBigMap && mg._mapWaypoints && mg._mapWaypoints.length > 0 && view.pins?.length > 0;

    if (useBigMap && maptilerKey) {
        try {
            // Compute bounding box of all waypoint + swarm locations
            const wpCoords = [];
            const _addCoord = (name) => {
                if (wpCoords.some(c => c.name.toLowerCase() === name.toLowerCase())) return;
                const lower = name.toLowerCase();
                let pin = view.pins.find(p => p.name.toLowerCase() === lower)
                    || view.pins.find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));
                if (!pin) {
                    const alias = _routeDetourAlias(name);
                    const aliasLower = alias ? alias.toLowerCase() : '';
                    if (aliasLower) {
                        pin = view.pins.find(p => p.name.toLowerCase() === aliasLower)
                            || view.pins.find(p => p.name.toLowerCase().includes(aliasLower) || aliasLower.includes(p.name.toLowerCase()));
                    }
                }
                if (pin) wpCoords.push({ name, lon: pin.lon, lat: pin.lat, resolvedName: pin.name });
            };
            for (const wp of mg._mapWaypoints) _addCoord(wp.name);
            if (mg._mapSwarms) {
                for (const sw of mg._mapSwarms) {
                    for (const loc of sw.locations) _addCoord(loc.name);
                }
            }

            if (wpCoords.length > 0) {
                const wpLons = wpCoords.map(w => w.lon);
                const wpLats = wpCoords.map(w => w.lat);
                const centerLon = (Math.min(...wpLons) + Math.max(...wpLons)) / 2;
                const centerLat = (Math.min(...wpLats) + Math.max(...wpLats)) / 2;

                // ── Tile zoom + canvas size ──
                // Pick tile zoom from the TIGHTEST close-up (most demanding for
                // sharpness), then size the canvas so the WIDEST camera shot
                // still fits. Step tile zoom down if canvas would exceed cap.
                // Derivation: on-screen pixels-per-degree at camZoom = 1920*camZoom/80.
                // Tile pixels-per-degree at tile zoom z = 512*2^z/360.
                // Crisp when z ≥ log2(1920 * camZoom * 360 / (80 * 512)) = log2(16.875 * camZoom).
                const HARD_MAX_W = 9216;
                const HARD_MAX_H = 5184;
                const MIN_W = 1920;
                const MIN_H = 1080;
                const TARGET_AR = 16 / 9;

                const camZooms = mg._mapWaypoints.map(w => w.zoom ?? 1.0);
                const minWpZoom = Math.min(...camZooms);
                const maxWpZoom = Math.max(...camZooms);

                const tileZoomForCam = (cz) => Math.ceil(Math.log2(1920 * cz * 360 / (80 * 512)));
                let bigZoom = Math.max(3, Math.min(tileZoomForCam(maxWpZoom), 7));
                // Style-pack extra-detail bump: invasions/editorial packs request +1 zoom
                // for crisper tiles on wide shots. Hard-cap stays at 7 so we don't blow
                // past MapTiler's useful tile resolution.
                const _pack = getMapStylePack(mg.mapStylePack || null);
                if (_pack && _pack.extraDetail && bigZoom < 7) {
                    bigZoom += 1;
                    console.log(`      🔎 Pack "${_pack.id}" requested extraDetail → bigZoom bumped to ${bigZoom}`);
                }

                const cosLat = Math.max(0.1, Math.cos(centerLat * Math.PI / 180));
                const wideShotLonSpan = 80 / minWpZoom;
                const bboxLonSpan = Math.max(...wpLons) - Math.min(...wpLons);
                const bboxLatSpan = Math.max(...wpLats) - Math.min(...wpLats);

                let BIG_W, BIG_H;
                while (true) {
                    const pxPerDegLon = 512 * Math.pow(2, bigZoom) / 360;
                    const pxPerDegLat = pxPerDegLon / cosLat;

                    const neededLonSpan = Math.max(wideShotLonSpan, bboxLonSpan * 1.3);
                    const neededLatSpan = Math.max(wideShotLonSpan * 9 / 16, bboxLatSpan * 1.3);

                    let w = Math.ceil(neededLonSpan * pxPerDegLon);
                    let h = Math.ceil(neededLatSpan * pxPerDegLat);

                    // Force 16:9 by growing the narrower dimension
                    if (w / h > TARGET_AR) h = Math.ceil(w / TARGET_AR);
                    else w = Math.ceil(h * TARGET_AR);

                    w = Math.max(MIN_W, w);
                    h = Math.max(MIN_H, h);

                    if (w <= HARD_MAX_W && h <= HARD_MAX_H) {
                        BIG_W = w;
                        BIG_H = h;
                        break;
                    }
                    if (bigZoom <= 3) {
                        BIG_W = Math.min(w, HARD_MAX_W);
                        BIG_H = Math.min(h, HARD_MAX_H);
                        break;
                    }
                    bigZoom--;
                }

                // Round up to whole tiles (512 px) so stitching has no partial edges,
                // then re-clamp to cap.
                const roundUp = (n, step) => Math.ceil(n / step) * step;
                BIG_W = Math.min(HARD_MAX_W, roundUp(BIG_W, 512));
                BIG_H = Math.min(HARD_MAX_H, roundUp(BIG_H, 512));

                const bigView = { lon: centerLon, lat: centerLat, zoom: bigZoom, pins: view.pins };

                const tilesEstimate = Math.ceil(BIG_W / 512) * Math.ceil(BIG_H / 512);
                console.log(`      Big map: ${BIG_W}×${BIG_H} tileZ=${bigZoom} (~${tilesEstimate} tiles) camZoom[${minWpZoom.toFixed(1)}→${maxWpZoom.toFixed(1)}] center [${centerLon.toFixed(1)},${centerLat.toFixed(1)}]`);
                const buffer = await stitchMapTilerTiles(bigView, mapStyle, maptilerKey, BIG_W, BIG_H);

                if (buffer.length > 5000) {
                    fs.writeFileSync(filePath, buffer);
                    mg.mapImageFile = filename;
                    mg._mapView = bigView;
                    mg._mapPins = view.pins;
                    mg._bigMapSize = { w: BIG_W, h: BIG_H };
                    mg._wpCoords = wpCoords;
                    _populateMapSceneAssets(mapScene, mg, bigView);
                    console.log(`   ✅ Big map saved: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
                    return true;
                }
                console.log(`      ⚠️ Big map too small (${buffer.length} bytes) — falling back to standard`);
            }
        } catch (err) {
            console.log(`      ⚠️ Big map download failed: ${err.message} — falling back to standard`);
        }
    }

    // Provider 1: MapTiler tile stitching (standard single view)
    if (maptilerKey) {
        try {
            console.log(`      Trying MapTiler (tile stitching)...`);
            const buffer = await stitchMapTilerTiles(view, mapStyle, maptilerKey);

            if (buffer.length < 5000) {
                console.log(`      ⚠️ MapTiler: stitched image too small (${buffer.length} bytes) — skipping`);
            } else {
                fs.writeFileSync(filePath, buffer);
                mg.mapImageFile = filename;
                mg._mapView = view;
                if (view.pins?.length) mg._mapPins = view.pins;
                _populateMapSceneAssets(mapScene, mg, view);
                console.log(`   ✅ Map saved via MapTiler: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
                return true;
            }
        } catch (err) {
            console.log(`      ⚠️ MapTiler failed: ${err.message}`);
        }
    }

    // Provider 2: Geoapify static API (fallback)
    if (geoapifyKey) {
        try {
            console.log(`      Trying Geoapify (static API)...`);
            const url = buildGeoapifyUrl(view, mapStyle, geoapifyKey);
            const buffer = await httpsDownload(url);

            if (buffer.length < 5000) {
                console.log(`      ⚠️ Geoapify: image too small (${buffer.length} bytes) — skipping`);
            } else {
                fs.writeFileSync(filePath, buffer);
                mg.mapImageFile = filename;
                mg._mapView = view;
                if (view.pins?.length) mg._mapPins = view.pins;
                _populateMapSceneAssets(mapScene, mg, view);
                console.log(`   ✅ Map saved via Geoapify: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
                return true;
            }
        } catch (err) {
            console.log(`      ⚠️ Geoapify failed: ${err.message}`);
        }
    }

    console.log('   ⚠️ All map providers failed — will use Canvas2D fallback');
    return false;
}

/**
 * Download maps for all mapChart MGs in a list.
 * `scenes` (optional) is threaded through so each MG can resolve its
 * authoritative MapScene via mg.sceneIndex — Slice 3 of the map rebuild.
 */
async function downloadMapsForMGs(allMGs, scriptContext, tempDir, scenes) {
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length === 0) return 0;

    let downloaded = 0;
    for (const mg of mapMGs) {
        const ok = await downloadMapForMG(mg, scriptContext, tempDir, scenes);
        if (ok) downloaded++;
    }
    return downloaded;
}

// ══════════════════════════════════════════════════════════════════
// OSM Boundary Fetcher — Nominatim API
// MapTiler renders OSM data, so Nominatim polygons align PERFECTLY
// with the tile borders (unlike Natural Earth which is offset).
// ══════════════════════════════════════════════════════════════════

const _osmBoundaryCache = new Map();

/**
 * Fetch the OSM boundary polygon for a country/region via Nominatim.
 * Returns GeoJSON Feature with geometry (Polygon/MultiPolygon) or null.
 *
 * Nominatim usage policy: max 1 req/sec, must include User-Agent.
 * We cache aggressively so repeated calls for the same place are instant.
 */
// Decimate a GeoJSON Polygon/MultiPolygon so total vertex count stays under
// `maxPoints`. Uniform stride per ring preserves overall shape while bounding
// the per-frame stroke/clip cost of pathologically detailed borders. Rings are
// never reduced below 4 points (keeps a closed shape).
function _capFeaturePoints(feature, maxPoints) {
    try {
        const geom = feature && feature.geometry;
        if (!geom) return feature;
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null;
        if (!polys) return feature;
        let total = 0;
        for (const poly of polys) for (const ring of poly) total += ring.length;
        if (total <= maxPoints) return feature;
        const stride = Math.ceil(total / maxPoints);
        const thin = (ring) => {
            if (ring.length <= 6) return ring;
            const out = [];
            for (let i = 0; i < ring.length; i += stride) out.push(ring[i]);
            const last = ring[ring.length - 1];
            if (out[out.length - 1] !== last) out.push(last); // keep ring closed
            return out.length >= 4 ? out : ring;
        };
        const newPolys = polys.map(poly => poly.map(thin));
        const newGeom = geom.type === 'Polygon'
            ? { type: 'Polygon', coordinates: newPolys[0] }
            : { type: 'MultiPolygon', coordinates: newPolys };
        return { ...feature, geometry: newGeom };
    } catch (_) {
        return feature;
    }
}

async function fetchOSMBoundary(placeName) {
    if (!placeName) return null;
    const cacheKey = placeName.trim().toLowerCase();
    if (_osmBoundaryCache.has(cacheKey)) return _osmBoundaryCache.get(cacheKey);

    // Nominatim aliases for common abbreviations
    const ALIASES = {
        'usa': 'United States of America', 'us': 'United States of America',
        'united states': 'United States of America',
        'uk': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom',
        'uae': 'United Arab Emirates', 'south korea': 'Republic of Korea',
        'north korea': "Democratic People's Republic of Korea",
        'czech republic': 'Czechia', 'russia': 'Russian Federation',
    };
    const query = ALIASES[cacheKey] || placeName.trim();

    // Helper: fetch from Nominatim with given URL
    const _fetchNominatim = (url) => new Promise((resolve, reject) => {
        const urlObj = new (require('url').URL)(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            headers: { 'User-Agent': 'YTAEmpire/1.0 (video-generator)' },
            timeout: 12000,
        };
        const req = require('https').get(options, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });

    // Pick the largest polygon from a multi-feature response. "Largest"
    // is a rough proxy for "the intended geographic entity" — Nominatim's
    // first result can be a same-named tiny town when the real target is
    // a continent/region relation.
    const _pickBestPoly = (data) => {
        if (!data?.features?.length) return null;
        let best = null;
        let bestSize = -1;
        for (const feat of data.features) {
            if (!feat || !feat.geometry) continue;
            const t = feat.geometry.type;
            if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
            const size = JSON.stringify(feat.geometry).length;
            if (size > bestSize) { best = feat; bestSize = size; }
        }
        return best;
    };
    const _extractPoly = (data) => {
        if (!data?.features?.length) return null;
        const feat = data.features[0];
        return (feat.geometry && (feat.geometry.type === 'Polygon' || feat.geometry.type === 'MultiPolygon')) ? feat : null;
    };

    // Continents: Nominatim's country/city feature types miss them entirely,
    // and the unrestricted first-result is often a same-named small town.
    // Recognize continent names and widen the search so we pick the big
    // polygon relation instead.
    const CONTINENT_NAMES = new Set([
        'asia', 'europe', 'africa', 'oceania', 'antarctica',
        'south america', 'north america', 'australia', 'eurasia',
    ]);
    const isContinent = CONTINENT_NAMES.has(cacheKey);

    try {
        const encoded = encodeURIComponent(query);
        // Hi-fidelity borders: 0.0002 keeps coastlines/borders crisp (≈5× the
        // detail of the old 0.001). A point cap below decimates pathological
        // giants (Russia/Canada) so render perf stays bounded.
        const base = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=geojson&polygon_geojson=1&polygon_threshold=0.00008&limit=1`;
        const wideBase = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=geojson&polygon_geojson=1&polygon_threshold=0.01&limit=10`;

        let feat = null;
        if (isContinent) {
            // Continents: go straight to widened search + pick-largest-polygon.
            feat = _pickBestPoly(await _fetchNominatim(wideBase));
        } else {
            // 1. Try country first
            feat = _extractPoly(await _fetchNominatim(`${base}&featuretype=country`));

            // 2. Try city (gets municipal boundary, not province)
            if (!feat) {
                await new Promise(r => setTimeout(r, 1100)); // rate limit
                feat = _extractPoly(await _fetchNominatim(`${base}&featuretype=city`));
            }

            // 3. Unrestricted fallback (landmarks, regions, etc.)
            if (!feat) {
                await new Promise(r => setTimeout(r, 1100));
                feat = _extractPoly(await _fetchNominatim(base));
            }

            // 4. Last-resort widened pick-largest — same-named small towns
            // can shadow a real region relation at limit=1.
            if (!feat) {
                await new Promise(r => setTimeout(r, 1100));
                feat = _pickBestPoly(await _fetchNominatim(wideBase));
            }
        }

        if (feat) {
            feat = _capFeaturePoints(feat, 22000); // bound render cost on giant polygons
            _osmBoundaryCache.set(cacheKey, feat);
            const level = feat.properties?.type || feat.properties?.osm_type || 'unknown';
            console.log(`      [OSM] Boundary for "${placeName}": ${feat.geometry.type} (${level}, ${JSON.stringify(feat.geometry).length} bytes${isContinent ? ', continent' : ''})`);
            return feat;
        }

        console.log(`      [OSM] No polygon found for "${placeName}"${isContinent ? ' (continent)' : ''}`);
        _osmBoundaryCache.set(cacheKey, null);
        return null;
    } catch (err) {
        console.log(`      ⚠️ OSM boundary fetch failed for "${placeName}": ${err.message}`);
        _osmBoundaryCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Fetch OSM boundaries for multiple places (sequential — Nominatim 1 req/sec policy).
 * Returns array of { name, feature } objects (nulls filtered out).
 */
async function fetchOSMBoundaries(placeNames) {
    const results = [];
    for (let i = 0; i < placeNames.length; i++) {
        const feat = await fetchOSMBoundary(placeNames[i]);
        if (feat) {
            results.push({ name: placeNames[i], feature: feat });
        }
        // Respect Nominatim rate limit: 1 req/sec (skip delay for cached results)
        if (i < placeNames.length - 1 && !_osmBoundaryCache.has(placeNames[i + 1]?.trim().toLowerCase())) {
            await new Promise(r => setTimeout(r, 1100));
        }
    }
    return results;
}

module.exports = {
    downloadMapForMG, downloadMapsForMGs, computeMapView, GEO_COORDS,
    stitchMapTilerTiles, MAPTILER_STYLE_MAP, GEOAPIFY_STYLE_MAP,
    geocodePlace, geocodePlaces, geocodeViaWikipedia, fetchOSMBoundary, fetchOSMBoundaries,
    extractEntities, isLikelyPlace, filterPlaces,
};
