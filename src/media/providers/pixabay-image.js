const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');
const { firstThumbUrl } = require('./preview-thumb');

class PixabayImageProvider extends BaseProvider {
    constructor() {
        super('Pixabay Images', 'image');
    }

    isAvailable() {
        return !!config.pixabay?.apiKey;
    }

    async _query(keyword, { wide = false } = {}) {
        const params = {
            key: config.pixabay.apiKey,
            q: keyword,
            per_page: 20,
            image_type: 'photo',
            safesearch: 'true',
        };
        if (!wide) {
            params.orientation = 'horizontal';
            params.min_width = 1280;
        }
        const response = await axios.get('https://pixabay.com/api/', { params, timeout: 15000 });
        return Array.isArray(response.data?.hits) ? response.data.hits : [];
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        // Prefer big: ask for landscape >=1280px first. Pixabay filters SERVER-side,
        // so those constraints don't just re-rank the shelf — they hide it. When the
        // narrow ask comes back empty the scene would otherwise get nothing from
        // Pixabay at all, so widen and ask again. Small/portrait results are de-ranked
        // downstream by base-provider.filterResults, never rejected. The first ask is
        // unchanged, so a keyword that already had big landscape hits behaves exactly
        // as before and costs exactly one request.
        let hits = await this._query(keyword);
        if (!hits.length) {
            hits = await this._query(keyword, { wide: true });
            if (hits.length) console.log(`  ↻ [Pixabay Images] no large landscape hits for "${keyword}" — widened the search (${hits.length} found)`);
        }

        return hits.map(hit => ({
            id: `pixabay-img-${hit.id}`,
            url: hit.largeImageURL || hit.webformatURL,
            width: Number(hit.imageWidth || hit.webformatWidth || 0),
            height: Number(hit.imageHeight || hit.webformatHeight || 0),
            title: hit.tags || `Pixabay image ${hit.id}`,
            _provider: 'pixabay',
            // `webformatURL` only counts as a cheap preview when the candidate
            // itself is the large original — otherwise it IS the candidate, and
            // screening it would download the exact bytes we meant to defer.
            _thumbUrl: firstThumbUrl(
                hit.previewURL,
                hit.largeImageURL ? hit.webformatURL : '',
            ),
        })).filter(item => item.url);
    }
}

module.exports = PixabayImageProvider;
