const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');
const { firstThumbUrl } = require('./preview-thumb');

class PexelsImageProvider extends BaseProvider {
    constructor() {
        super('Pexels Images', 'image');
    }

    isAvailable() {
        return !!config.pexels?.apiKey;
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        const response = await axios.get('https://api.pexels.com/v1/search', {
            params: {
                query: keyword,
                per_page: 20,
                orientation: 'landscape',
            },
            headers: { Authorization: config.pexels.apiKey },
            timeout: 15000,
        });

        const photos = Array.isArray(response.data?.photos) ? response.data.photos : [];
        return photos.map(photo => ({
            id: `pexels-img-${photo.id}`,
            url: photo.src?.large2x || photo.src?.large || photo.src?.original,
            width: Number(photo.width || 0),
            height: Number(photo.height || 0),
            title: photo.alt || photo.url || `Pexels image ${photo.id}`,
            _provider: 'pexels',
            // Always a smaller rendition than the `large2x/large/original` the
            // candidate itself points at, so screening never pre-pays for it.
            _thumbUrl: firstThumbUrl(photo.src?.medium, photo.src?.small, photo.src?.tiny),
        })).filter(item => item.url);
    }
}

module.exports = PexelsImageProvider;
