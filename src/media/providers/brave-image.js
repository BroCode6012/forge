const axios = require('axios');
const BaseProvider = require('./base-provider');
const config = require('../../settings/config');
const { firstThumbUrl } = require('./preview-thumb');

// Brave Image Search API — the closest official replacement for the retired
// Bing Image Search API (Microsoft retired all Bing Search APIs on 2025-08-11).
// Unlike bing-image.js (which scrapes bing.com/images and gets 403-throttled),
// this is a real keyed API: an independent web index of REAL images (news,
// real-world photos, places, people) — NOT stock. Runs alongside Bing so the
// candidate race has multiple real-web-image sources instead of one fragile
// scraper. Inert until BRAVE_API_KEY is set (isAvailable() === false).
//
// Endpoint:  GET https://api.search.brave.com/res/v1/images/search
// Auth:      header X-Subscription-Token: <key>
// Free tier: ~1 req/sec, ~2k queries/month.
const SEARCH_URL = 'https://api.search.brave.com/res/v1/images/search';
const MAX_RESULTS = 50;

function _cleanImageUrl(value) {
    const url = String(value || '').trim();
    if (!/^https?:\/\//i.test(url)) return '';
    // Skip vector/animated/data formats the renderer can't use as a clean still.
    if (/\.(svg|gif)(?:[?#]|$)/i.test(url)) return '';
    if (/^data:|base64,/i.test(url)) return '';
    return url;
}

class BraveImageProvider extends BaseProvider {
    constructor() {
        super('Brave Images', 'image');
    }

    isAvailable() {
        return !!(config.brave?.apiKey) && process.env.BRAVE_IMAGES_DISABLED !== '1';
    }

    async search(keyword) {
        const q = String(keyword || '').trim();
        const apiKey = config.brave?.apiKey || '';
        if (!q || !apiKey) return [];

        let response;
        try {
            response = await axios.get(SEARCH_URL, {
                params: {
                    q,
                    count: MAX_RESULTS,
                    // Images endpoint accepts off|strict. Default strict; override
                    // with BRAVE_SAFESEARCH=off if news/conflict imagery is filtered.
                    safesearch: (process.env.BRAVE_SAFESEARCH || 'strict').toLowerCase() === 'off' ? 'off' : 'strict',
                    search_lang: process.env.BRAVE_SEARCH_LANG || 'en',
                    country: process.env.BRAVE_COUNTRY || 'us',
                    spellcheck: 1,
                },
                headers: {
                    Accept: 'application/json',
                    'X-Subscription-Token': apiKey,
                },
                timeout: 20_000,
            });
        } catch (err) {
            const status = err?.response?.status;
            // 429 = free-tier rate limit (1 req/sec). Don't crash the race — just
            // yield no candidates this scene; Bing/Storyblocks still compete.
            const label = status === 429 ? 'rate limited (free tier ~1 req/s)'
                : status === 401 || status === 403 ? 'bad/expired BRAVE_API_KEY'
                : (err?.message || 'request failed');
            console.log(`  [Brave Images] search skipped: ${label}`);
            return [];
        }

        const items = Array.isArray(response.data?.results) ? response.data.results : [];
        const results = [];
        const seen = new Set();
        for (const item of items) {
            // Full-res image lives in properties.url; thumbnail.src is the preview.
            const url = _cleanImageUrl(item?.properties?.url || item?.thumbnail?.src);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            // Only a real saving when the candidate resolved to the full-res
            // `properties.url`; when it fell back to the thumbnail, thumb and
            // candidate are the same bytes and there is nothing to defer.
            const thumb = firstThumbUrl(item?.thumbnail?.src);
            results.push({
                id: `brave:${url}`,
                url,
                width: Number(item?.properties?.width || item?.width || 0) || undefined,
                height: Number(item?.properties?.height || item?.height || 0) || undefined,
                title: String(item?.title || '').trim(),
                sourcePage: String(item?.url || item?.source || '').trim(),
                _provider: 'brave',
                _thumbUrl: thumb && thumb !== url ? thumb : '',
            });
            if (results.length >= MAX_RESULTS) break;
        }
        return results;
    }
}

module.exports = BraveImageProvider;
