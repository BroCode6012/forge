/**
 * Icon Provider — Downloads icons for MGs and map waypoints.
 *
 * Provider chain (all free / free-tier):
 *   1. Iconify API — free, no key, 100k+ icons (Material Design, FontAwesome, etc.)
 *   2. Flaticon API — free trial, search by keyword, colored PNG icons
 *   3. Freepik API — AI text-to-icon generation, 5€ free credits
 *   4. Image search fallback — Google Images scrape with "icon transparent" query
 *
 * SVG icons (Iconify) are rasterized to PNG via @napi-rs/canvas for map rendering.
 * All icons are cached in temp/icons/ by keyword hash.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { isCanvasSafeImage } = require('../util/image-bytes');
const config = require('../settings/config');

// ── Cache ──
let _iconCacheDir = null;
function getIconCacheDir() {
    if (!_iconCacheDir) {
        _iconCacheDir = path.join(config.paths?.temp || path.join(__dirname, '..', '..', 'temp'), 'icons');
        if (!fs.existsSync(_iconCacheDir)) fs.mkdirSync(_iconCacheDir, { recursive: true });
    }
    return _iconCacheDir;
}

function getCachePath(keyword) {
    const hash = crypto.createHash('md5').update(keyword.toLowerCase().trim()).digest('hex').substring(0, 12);
    return path.join(getIconCacheDir(), `${hash}.png`);
}

function getCachedIcon(keyword) {
    const p = getCachePath(keyword);
    return (fs.existsSync(p) && fs.statSync(p).size > 500) ? p : null;
}

// ── Shared HTTP helper ──
function httpGet(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpGet(res.headers.location, timeout).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
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

// Preferred icon sets (clean, consistent style for map overlays).
// Phosphor-filled and Solar-bold have soft rounded geometry + consistent stroke weight
// that reads MUCH better at small map-overlay sizes than MDI's utilitarian glyphs.
// Order: pretty-filled first, utilitarian fallbacks last.
const PREFERRED_PREFIXES = ['ph', 'solar', 'tabler', 'lucide', 'carbon', 'mdi', 'ic'];

// ── Icon synonym map ──
// Iconify's first match for certain words is terrible (e.g. "port" → mdi:usb-port,
// "trade" → mdi:trademark). When a keyword appears here, skip Iconify search and
// use this exact iconId instead. Keys are lowercased; check singular+plural.
//
// All primary entries use Phosphor-filled (`ph:*-fill`) — soft rounded geometry,
// consistent stroke weight, modern look. These read MUCH better as small map
// overlays than MDI's utilitarian glyphs. If a ph:* icon 404s, the downloader
// falls back to Iconify search (see downloadFromIconify).
const ICON_SYNONYMS = {
    // Maritime / shipping
    'port':        'ph:anchor-fill',
    'ports':       'ph:anchor-fill',
    'harbor':      'ph:anchor-fill',
    'harbors':     'ph:anchor-fill',
    'harbour':     'ph:anchor-fill',
    'harbours':    'ph:anchor-fill',
    'dock':        'ph:anchor-fill',
    'docks':       'ph:anchor-fill',
    'shipping':    'ph:boat-fill',
    'ship':        'ph:boat-fill',
    'ships':       'ph:boat-fill',
    'vessel':      'ph:boat-fill',
    'vessels':     'ph:boat-fill',
    'cargo':       'ph:package-fill',
    'freight':     'ph:package-fill',
    'container':   'ph:package-fill',
    'containers':  'ph:package-fill',
    'tanker':      'ph:boat-fill',
    'naval':       'ph:anchor-fill',
    'navy':        'ph:anchor-fill',
    'maritime':    'ph:anchor-fill',
    // Trade / commerce
    'trade':       'ph:handshake-fill',
    'trades':      'ph:handshake-fill',
    'trading':     'ph:handshake-fill',
    'commerce':    'ph:handshake-fill',
    'deal':        'ph:handshake-fill',
    'deals':       'ph:handshake-fill',
    'agreement':   'ph:handshake-fill',
    'treaty':      'ph:handshake-fill',
    'alliance':    'ph:handshake-fill',
    'partnership': 'ph:handshake-fill',
    // Conflict / military
    'war':         'ph:sword-fill',
    'battle':      'ph:sword-fill',
    'conflict':    'ph:sword-fill',
    'attack':      'ph:sword-fill',
    'strike':      'ph:sword-fill',
    'combat':      'ph:sword-fill',
    'military':    'ph:shield-fill',
    'army':        'ph:shield-fill',
    'troops':      'ph:users-three-fill',
    'forces':      'ph:shield-fill',
    'missile':     'ph:rocket-launch-fill',
    'missiles':    'ph:rocket-launch-fill',
    'rocket':      'ph:rocket-launch-fill',
    'drone':       'ph:drone-fill',
    'drones':      'ph:drone-fill',
    'bomb':        'ph:bomb-fill',
    'bombing':     'ph:bomb-fill',
    'explosion':   'ph:bomb-fill',
    // 'tank' has no Phosphor equivalent — Iconify search falls through to tabler:tank, which looks great

    // Energy / resources
    'oil':         'ph:drop-fill',
    'gas':         'ph:gas-can-fill',
    'pipeline':    'ph:pipe-fill',
    'pipelines':   'ph:pipe-fill',
    'fuel':        'ph:gas-pump-fill',
    'energy':      'ph:lightning-fill',
    'power':       'ph:lightning-fill',
    'electricity': 'ph:lightning-fill',
    'refinery':    'ph:factory-fill',
    'coal':        'ph:diamond-fill',
    'mining':      'ph:mountains-fill',
    'mine':        'ph:mountains-fill',
    // Finance / economy
    'money':       'ph:money-fill',
    'cash':        'ph:money-fill',
    'dollar':      'ph:currency-dollar-fill',
    'dollars':     'ph:currency-dollar-fill',
    'euro':        'ph:currency-eur-fill',
    'economy':     'ph:chart-line-up-fill',
    'economic':    'ph:chart-line-up-fill',
    'market':      'ph:chart-line-up-fill',
    'markets':     'ph:chart-line-up-fill',
    'stock':       'ph:chart-line-up-fill',
    'stocks':      'ph:chart-line-up-fill',
    'bank':        'ph:bank-fill',
    'banks':       'ph:bank-fill',
    'banking':     'ph:bank-fill',
    'tax':         'ph:coins-fill',
    'taxes':       'ph:coins-fill',
    'tariff':      'ph:coins-fill',
    'tariffs':     'ph:coins-fill',
    'sanction':    'ph:prohibit-fill',
    'sanctions':   'ph:prohibit-fill',
    // Politics / government
    'election':    'ph:check-square-fill',
    'elections':   'ph:check-square-fill',
    'vote':        'ph:check-square-fill',
    'votes':       'ph:check-square-fill',
    'voting':      'ph:check-square-fill',
    'government':  'ph:bank-fill',
    'parliament':  'ph:bank-fill',
    'congress':    'ph:bank-fill',
    'senate':      'ph:bank-fill',
    'president':   'ph:user-circle-fill',
    'law':         'ph:gavel-fill',
    'legal':       'ph:gavel-fill',
    'court':       'ph:gavel-fill',
    'judge':       'ph:gavel-fill',
    'policy':      'ph:file-text-fill',
    // People / groups
    'people':      'ph:users-three-fill',
    'population':  'ph:users-three-fill',
    'crowd':       'ph:users-three-fill',
    'protest':     'ph:megaphone-fill',
    'protests':    'ph:megaphone-fill',
    'protestors':  'ph:megaphone-fill',
    'refugee':     'ph:users-three-fill',
    'refugees':    'ph:users-three-fill',
    'migrants':    'ph:users-three-fill',
    // Places / infrastructure
    'city':        'ph:buildings-fill',
    'cities':      'ph:buildings-fill',
    'capital':     'ph:buildings-fill',
    'border':      'ph:divide-fill',
    'borders':     'ph:divide-fill',
    'airport':     'ph:airplane-fill',
    'airports':    'ph:airplane-fill',
    'flight':      'ph:airplane-fill',
    'flights':     'ph:airplane-fill',
    'airplane':    'ph:airplane-fill',
    'factory':     'ph:factory-fill',
    'factories':   'ph:factory-fill',
    'school':      'ph:graduation-cap-fill',
    'schools':     'ph:graduation-cap-fill',
    'hospital':    'ph:first-aid-kit-fill',
    'hospitals':   'ph:first-aid-kit-fill',
    // Generic nav/markers (fallback-safe)
    'location':    'ph:map-pin-fill',
    'place':       'ph:map-pin-fill',
    'target':      'ph:target-fill',
    'destination': 'ph:flag-fill',
    'start':       'ph:flag-banner-fill',
    'route':       'ph:path-fill',
    'flag':        'ph:flag-fill',
    'pin':         'ph:map-pin-fill',
    // Tech / comms
    'internet':    'ph:globe-fill',
    'data':        'ph:database-fill',
    'server':      'ph:hard-drives-fill',
    'phone':       'ph:device-mobile-fill',
    'satellite':   'ph:radio-fill',
    'signal':      'ph:wifi-high-fill',
    // Food / agriculture
    'wheat':       'ph:plant-fill',
    'food':        'ph:bowl-food-fill',
    'agriculture': 'ph:plant-fill',
    'farm':        'ph:plant-fill',
    // Industry / tech
    'technology':  'ph:cpu-fill',
    'chip':        'ph:cpu-fill',
    'chips':       'ph:cpu-fill',
    'semiconductor':'ph:cpu-fill',
    'nuclear':     'ph:atom-fill',
    'steel':       'ph:hammer-fill',
    'gold':        'ph:coin-vertical-fill',
    'diamond':     'ph:diamond-fill',
};

// Iconify IDs that are NEVER useful for geopolitical/news maps.
// When Iconify search returns these as top hits, skip them and try next result.
const ICON_BLACKLIST = new Set([
    'mdi:usb-port',
    'mdi:trademark',
    'mdi:registered-trademark',
    'mdi:copyright',
    'mdi:port-scan',
    'mdi:ethernet',
]);

// ══════════════════════════════════════════════════════════════
// Provider 1: Iconify API — free, no API key, 100k+ icons
// ══════════════════════════════════════════════════════════════

async function searchIconify(keyword) {
    try {
        const url = `https://api.iconify.design/search?query=${encodeURIComponent(keyword)}&limit=10`;
        const buf = await httpGet(url);
        const result = JSON.parse(buf.toString());
        if (!result.icons || result.icons.length === 0) return null;

        // Drop known-bad matches (USB ports, trademarks, etc.)
        let icons = result.icons.filter(id => !ICON_BLACKLIST.has(id));
        if (icons.length === 0) return null;

        // Sort: prefer our preferred sets
        icons.sort((a, b) => {
            const idxA = PREFERRED_PREFIXES.indexOf(a.split(':')[0]);
            const idxB = PREFERRED_PREFIXES.indexOf(b.split(':')[0]);
            return (idxA >= 0 ? idxA : 100) - (idxB >= 0 ? idxB : 100);
        });

        return icons;
    } catch (e) {
        return null;
    }
}

/**
 * Try to fetch + rasterize a single Iconify iconId. Returns PNG buffer or null.
 * Split out so both the synonym path and the search-fallback path can reuse it.
 */
async function _fetchAndRasterize(iconId, keyword, tag) {
    const [prefix, name] = iconId.split(':');
    if (!prefix || !name) return null;

    try {
        // Download SVG with white fill for dark map backgrounds
        const svgUrl = `https://api.iconify.design/${prefix}/${name}.svg?height=128&color=white`;
        const svgBuf = await httpGet(svgUrl);
        // Guard the RAW BYTES, not the data: URI built from them — @napi-rs/canvas
        // SEGFAULTS (exit 139, no exception) on anything it cannot decode, and a
        // data: URI string sniffs as an unreadable path, which fails open.
        if (!isCanvasSafeImage(svgBuf)) return null;
        const svgStr = svgBuf.toString();
        if (!svgStr.includes('<svg')) return null;

        // Rasterize SVG → PNG using @napi-rs/canvas
        try {
            const { createCanvas, loadImage } = require('@napi-rs/canvas');
            const SIZE = 128;
            const canvas = createCanvas(SIZE, SIZE);
            const ctx = canvas.getContext('2d');

            // Convert SVG to data URI for loadImage
            const svgB64 = Buffer.from(svgStr).toString('base64');
            const dataUri = `data:image/svg+xml;base64,${svgB64}`;
            const img = await loadImage(dataUri);

            // Draw centered, maintaining aspect ratio
            const scale = Math.min(SIZE / img.width, SIZE / img.height) * 0.85;
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);

            const pngBuf = canvas.toBuffer('image/png');
            if (pngBuf.length > 200) {
                console.log(`      ✅ Iconify: "${keyword}" → ${iconId}${tag ? ` [${tag}]` : ''} (${(pngBuf.length / 1024).toFixed(0)} KB)`);
                return pngBuf;
            }
        } catch (canvasErr) {
            // No @napi-rs/canvas available — save raw SVG as fallback
            console.log(`      ✅ Iconify: "${keyword}" → ${iconId}${tag ? ` [${tag}]` : ''} (SVG, no rasterizer)`);
            return svgBuf;
        }
    } catch (err) {
        // Silent — caller decides whether to try fallback or give up
    }
    return null;
}

/**
 * Download SVG from Iconify, rasterize to PNG via @napi-rs/canvas.
 * Tries synonym map first, then Iconify search as fallback if synonym 404s.
 */
async function downloadFromIconify(keyword) {
    // 1. Check synonym map first (skip search for known-bad keywords like "port" → usb-port).
    //    If full keyword misses (e.g. "oil barrel"), try each whitespace-separated
    //    word so "oil barrel" → "oil" hits ph:drop-fill.
    const k = (keyword && typeof keyword === 'string') ? keyword.toLowerCase().trim() : null;
    let synonymId = k ? ICON_SYNONYMS[k] : null;
    let synonymSource = k;
    if (!synonymId && k && k.includes(' ')) {
        for (const word of k.split(/\s+/)) {
            if (ICON_SYNONYMS[word]) { synonymId = ICON_SYNONYMS[word]; synonymSource = word; break; }
        }
    }

    if (synonymId) {
        const tag = synonymSource === k ? 'synonym' : `synonym:${synonymSource}`;
        const buf = await _fetchAndRasterize(synonymId, keyword, tag);
        if (buf) return buf;
        // Synonym icon didn't exist or failed — fall through to search
        console.log(`      ↻ Synonym "${synonymId}" unavailable, searching Iconify for "${keyword}"`);
    }

    // 2. Fall back to Iconify search (sorted by PREFERRED_PREFIXES)
    const icons = await searchIconify(keyword);
    if (!icons || icons.length === 0) return null;

    // Try up to 3 top hits in case one is broken
    for (let i = 0; i < Math.min(3, icons.length); i++) {
        const buf = await _fetchAndRasterize(icons[i], keyword, i === 0 ? 'search' : `search#${i + 1}`);
        if (buf) return buf;
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
// Provider 2: Flaticon API — search for colored PNG icons
// ══════════════════════════════════════════════════════════════

let _flaticonToken = null;
let _flaticonTokenExpiry = 0;

async function getFlatIconToken() {
    const apiKey = config.flaticon?.apiKey;
    if (!apiKey) return null;
    if (_flaticonToken && Date.now() < _flaticonTokenExpiry) return _flaticonToken;

    try {
        const postData = JSON.stringify({});
        const url = new URL('https://api.flaticon.com/v3/app/authentication');
        const options = {
            hostname: url.hostname, path: url.pathname,
            method: 'POST', timeout: 8000,
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': postData.length },
        };
        const resp = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(postData);
            req.end();
        });
        _flaticonToken = resp?.data?.token;
        _flaticonTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
        return _flaticonToken;
    } catch (err) {
        console.log(`      ⚠️ Flaticon auth failed: ${err.message}`);
        return null;
    }
}

async function downloadFromFlaticon(keyword) {
    const token = await getFlatIconToken();
    if (!token) return null;

    try {
        const searchUrl = `https://api.flaticon.com/v3/search/icons/priority?q=${encodeURIComponent(keyword)}&limit=5&styleColor=color&styleShape=fill`;
        const buf = await httpGet(searchUrl);
        // Note: Flaticon requires auth header — use https.get with headers
        const url = new URL(searchUrl);
        const resp = await new Promise((resolve, reject) => {
            const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, headers: { 'Authorization': `Bearer ${token}` }, timeout: 8000 }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });

        const icons = resp?.data;
        if (!icons || icons.length === 0) return null;

        const icon = icons[0];
        const pngUrl = icon.images?.['128'] || icon.images?.['64'] || icon.images?.['256'] || icon.images?.['512'];
        if (!pngUrl) return null;

        const imgBuf = await httpGet(pngUrl, 10000);
        if (imgBuf.length > 500) {
            console.log(`      ✅ Flaticon: "${keyword}" → ${icon.description || 'icon'} (${(imgBuf.length / 1024).toFixed(0)} KB)`);
            return imgBuf;
        }
    } catch (err) {
        console.log(`      ⚠️ Flaticon failed for "${keyword}": ${err.message}`);
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
// Provider 3: Freepik API — AI text-to-icon generation
// ══════════════════════════════════════════════════════════════

async function downloadFromFreepik(keyword) {
    const apiKey = config.freepik?.apiKey;
    if (!apiKey) return null;

    try {
        const postData = JSON.stringify({ prompt: `${keyword} icon, flat design, simple, clean`, style: 'flat' });
        const options = {
            hostname: 'api.freepik.com', path: '/v1/ai/text-to-icon',
            method: 'POST', timeout: 20000,
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        };

        const resp = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(postData);
            req.end();
        });

        const result = resp?.data;
        if (!result) return null;

        const imageUrl = (Array.isArray(result) ? result[0]?.url : result?.url) || (Array.isArray(result) ? result[0]?.image : null);
        if (!imageUrl) return null;

        if (imageUrl.startsWith('data:')) {
            const base64 = imageUrl.split(',')[1];
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 500) {
                console.log(`      ✅ Freepik AI: "${keyword}" (${(buf.length / 1024).toFixed(0)} KB)`);
                return buf;
            }
        } else {
            const imgBuf = await httpGet(imageUrl, 10000);
            if (imgBuf.length > 500) {
                console.log(`      ✅ Freepik AI: "${keyword}" (${(imgBuf.length / 1024).toFixed(0)} KB)`);
                return imgBuf;
            }
        }
    } catch (err) {
        console.log(`      ⚠️ Freepik failed for "${keyword}": ${err.message}`);
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
// Provider 4: Image search fallback — scrape transparent icons
// ══════════════════════════════════════════════════════════════

const SEARCH_UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

async function downloadFromImageSearch(keyword) {
    const query = `${keyword} icon flat transparent PNG`;
    const encoded = encodeURIComponent(query);
    const url = `https://www.google.com/search?q=${encoded}&tbm=isch&tbs=ic:trans,isz:m`;
    const ua = SEARCH_UAS[Math.floor(Math.random() * SEARCH_UAS.length)];

    try {
        const resp = await new Promise((resolve, reject) => {
            const req = https.get(url, { headers: { 'User-Agent': ua }, timeout: 10000 }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString()));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });

        // Extract image URLs from Google Images HTML
        const imgUrls = [];
        const dataRegex = /\["(https?:\/\/[^"]+\.(?:png|webp)(?:\?[^"]*)?)",\s*\d+,\s*\d+/gi;
        let match;
        while ((match = dataRegex.exec(resp)) !== null && imgUrls.length < 5) {
            const imgUrl = match[1];
            if (!imgUrl.includes('gstatic.com') && !imgUrl.includes('google.com')) {
                imgUrls.push(imgUrl);
            }
        }

        for (const imgUrl of imgUrls.slice(0, 3)) {
            try {
                const imgBuf = await httpGet(imgUrl, 8000);
                if (imgBuf.length > 1000 && imgBuf.length < 5 * 1024 * 1024) {
                    console.log(`      ✅ Image search: "${keyword}" (${(imgBuf.length / 1024).toFixed(0)} KB)`);
                    return imgBuf;
                }
            } catch (_) { /* try next */ }
        }
    } catch (err) {
        console.log(`      ⚠️ Image search failed for "${keyword}": ${err.message}`);
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
// Main API
// ══════════════════════════════════════════════════════════════

/**
 * Download an icon for a keyword. Tries providers in order, caches result.
 * @param {string} keyword - Icon keyword (e.g., "oil barrel", "military tank")
 * @returns {Promise<string|null>} Path to cached PNG file, or null
 */
async function downloadMapIcon(keyword) {
    if (!keyword || keyword === 'none') return null;
    keyword = keyword.trim();

    // Check cache
    const cached = getCachedIcon(keyword);
    if (cached) {
        console.log(`      📦 Icon cached: "${keyword}"`);
        return cached;
    }

    console.log(`      🔍 Downloading icon: "${keyword}"`);
    const cachePath = getCachePath(keyword);

    // Provider chain
    let buffer = await downloadFromIconify(keyword);
    if (!buffer) buffer = await downloadFromFlaticon(keyword);
    if (!buffer) buffer = await downloadFromFreepik(keyword);
    if (!buffer) buffer = await downloadFromImageSearch(keyword);

    if (buffer && buffer.length > 200) {
        fs.writeFileSync(cachePath, buffer);
        return cachePath;
    }

    console.log(`      ⚠️ No icon found for "${keyword}"`);
    return null;
}

/**
 * Download icons for all waypoints in a mapChart MG.
 * Each waypoint should have an `icon` field (keyword string).
 * Returns a map keyed by BOTH waypoint name AND icon keyword → file path.
 * This ensures the renderer can match by pin label (location name).
 */
async function downloadWaypointIcons(mg) {
    const waypoints = mg._mapWaypoints;
    if (!waypoints || waypoints.length === 0) return {};

    const iconMap = {};
    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (!wp.icon || wp.icon === 'none') continue;
        const iconPath = await downloadMapIcon(wp.icon);
        if (iconPath) {
            // Key by waypoint name (matches pin.label in renderer)
            iconMap[wp.name] = iconPath;
            // Also store the icon path on the waypoint itself for direct access
            wp._iconFile = iconPath;
        }
    }
    return iconMap;
}

// ── Legacy API for animatedIcons MG type ──

async function searchIcons(keyword, limit = 10) {
    return (await searchIconify(keyword)) || [];
}

async function downloadIcon(iconId, outputPath) {
    try {
        const [prefix, name] = iconId.split(':');
        if (!prefix || !name) return false;
        const svgBuf = await httpGet(`https://api.iconify.design/${prefix}/${name}.svg?height=auto`);
        const svgStr = svgBuf.toString();
        if (!svgStr.includes('<svg')) return false;
        fs.writeFileSync(outputPath, svgStr);
        return true;
    } catch (e) {
        return false;
    }
}

async function downloadAllIcons(motionGraphics, tempDir) {
    const iconMGs = motionGraphics.filter(mg => mg.type === 'animatedIcons');
    if (iconMGs.length === 0) return 0;

    let downloaded = 0;
    const usedIconIds = new Set();

    for (const mg of iconMGs) {
        if (!mg.icons || mg.icons.length === 0) continue;
        for (const icon of mg.icons) {
            const keyword = icon.keyword;
            if (!keyword) continue;
            try {
                const results = await searchIcons(keyword, 5);
                if (results.length === 0) { console.log(`  No icons found for "${keyword}", skipping`); continue; }
                let picked = results.find(id => !usedIconIds.has(id)) || results[0];
                const filename = icon.file || `icon-${mg.sceneIndex || 0}-${mg.icons.indexOf(icon)}.svg`;
                const outputPath = path.join(tempDir, filename);
                const success = await downloadIcon(picked, outputPath);
                if (success) { icon.file = filename; icon._iconId = picked; usedIconIds.add(picked); downloaded++; console.log(`  ✓ ${keyword} → ${picked} → ${filename}`); }
            } catch (e) { console.warn(`  Failed to get icon for "${keyword}":`, e.message); }
        }
        mg.icons = mg.icons.filter(icon => icon.file);
    }
    return downloaded;
}

module.exports = {
    // Map waypoint icons (new)
    downloadMapIcon, downloadWaypointIcons, getCachedIcon,
    // Legacy animatedIcons API
    searchIcons, downloadIcon, downloadAllIcons,
};
