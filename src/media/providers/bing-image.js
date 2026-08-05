const axios = require('axios');
const BaseProvider = require('./base-provider');
const { firstThumbUrl } = require('./preview-thumb');

const SEARCH_URL = 'https://www.bing.com/images/search';
const ASYNC_SEARCH_URL = 'https://www.bing.com/images/async';
const MAX_RESULTS = 24;

// Bias results toward real photographs. Bing's `photo-photo` content filter excludes the
// clip-art / line-drawing / digital-painting / typographic-collage classes that the vision
// gate rejects as "EDITORIAL TEXT OVERLAY" (album-cover art, promo posters, book covers,
// stylized wallpapers). This is mechanical query hygiene — like imagesize-large — not
// niche/content vocabulary. BING_PHOTO_FILTER=0 reverts to unfiltered (graphics included).
const PHOTO_QFT = process.env.BING_PHOTO_FILTER === '0' ? '' : '+filterui:photo-photo';
const QFT = `+filterui:imagesize-large${PHOTO_QFT}`;
// Fallback query for when the large-only ask finds nothing: keep the photograph
// filter (that's content hygiene), drop the size filter (that's a preference).
// Bing's size filter is applied server-side, so a rare subject that only exists
// as a small web photo is invisible to us otherwise — and that is a retrieval
// hole, not a quality decision. Anything small that comes back is de-ranked to
// the reserve tail by base-provider.filterResults, never rejected.
const QFT_ANY_SIZE = PHOTO_QFT;

function decodeHtml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function cleanUrl(value) {
    const url = String(value || '').trim().replace(/\{width\}/g, '1600').replace(/\{height\}/g, '900');
    if (!/^https?:\/\//i.test(url)) return '';
    if (/\.(svg|gif)(?:[?#]|$)/i.test(url)) return '';
    if (/base64,|data:image/i.test(url)) return '';
    return url;
}

function parseBingImageResults(html) {
    const results = [];
    const seen = new Set();

    const add = (item = {}) => {
        const url = cleanUrl(item.murl || item.mediaUrl || item.url);
        if (!url || seen.has(url)) return;
        seen.add(url);
        // `turl` is Bing's own cached thumbnail — small, fast, and served from
        // bing.net rather than the origin host, so the pre-download screen can
        // look at this candidate without touching the full-size image.
        const thumb = firstThumbUrl(item.turl, item.thumbnailUrl);
        results.push({
            id: `bing:${url}`,
            url,
            width: Number(item.w || item.width || 0) || undefined,
            height: Number(item.h || item.height || 0) || undefined,
            title: String(item.t || item.title || '').trim(),
            sourcePage: item.purl || item.sourcePage || '',
            _provider: 'bing',
            _thumbUrl: thumb && thumb !== url ? thumb : '',
        });
    };

    for (const match of String(html || '').matchAll(/<a\b[^>]*\bm="([^"]+)"[^>]*>/gi)) {
        const attr = decodeHtml(match[1]);
        if (!attr.includes('"murl"')) continue;
        try {
            add(JSON.parse(attr));
        } catch (_) {
            const murl = attr.match(/"murl"\s*:\s*"([^"]+)"/i)?.[1];
            const title = attr.match(/"t"\s*:\s*"([^"]+)"/i)?.[1];
            add({ murl, title });
        }
        if (results.length >= MAX_RESULTS) return results;
    }

    for (const match of String(html || '').matchAll(/&quot;murl&quot;\s*:\s*&quot;([^&]+)&quot;/gi)) {
        add({ murl: decodeHtml(match[1]) });
        if (results.length >= MAX_RESULTS) break;
    }

    return results;
}

class BingImageProvider extends BaseProvider {
    constructor() {
        super('Bing Images', 'image');
    }

    isAvailable() {
        return process.env.BING_IMAGES_DISABLED !== '1';
    }

    async search(keyword) {
        const q = String(keyword || '').trim();
        if (!q) return [];

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        };

        // Prefer big: large-only first. Only if that comes back completely empty
        // do we re-ask without the size filter — so the common case costs the same
        // requests it always did and returns the same results in the same order.
        let results = await this._fetch(q, QFT, headers);
        if (results.length === 0 && QFT_ANY_SIZE !== QFT) {
            results = await this._fetch(q, QFT_ANY_SIZE, headers);
            if (results.length) console.log(`  ↻ [Bing Images] no large images for "${q}" — retried without the size filter (${results.length} found)`);
        }

        return results.slice(0, MAX_RESULTS);
    }

    async _fetch(q, qft, headers) {
        const response = await axios.get(ASYNC_SEARCH_URL, {
            params: {
                q,
                first: 0,
                count: MAX_RESULTS + 12,
                relp: MAX_RESULTS + 12,
                scenario: 'ImageBasicHover',
                datsrc: 'I',
                layout: 'RowBased',
                mmasync: 1,
                mkt: 'en-US',
                cc: 'US',
                safeSearch: 'Moderate',
                qft,
            },
            timeout: 20_000,
            headers,
        });

        let results = parseBingImageResults(response.data);
        if (results.length === 0) {
            const fallback = await axios.get(SEARCH_URL, {
                params: {
                    q,
                    first: 1,
                    count: MAX_RESULTS,
                    safeSearch: 'Moderate',
                    qft,
                    form: 'HDRSC2',
                    mkt: 'en-US',
                    cc: 'US',
                },
                timeout: 20_000,
                headers,
            });
            results = parseBingImageResults(fallback.data);
        }

        return results.slice(0, MAX_RESULTS);
    }
}

module.exports = BingImageProvider;
module.exports.parseBingImageResults = parseBingImageResults;
