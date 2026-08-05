const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');
const { pickRenderRendition } = require('./rendition-picker');
const { firstThumbUrl } = require('./preview-thumb');

class PixabayVideoProvider extends BaseProvider {
    constructor() {
        super('Pixabay Videos', 'video');
    }

    isAvailable() {
        return !!config.pixabay?.apiKey;
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        const response = await axios.get('https://pixabay.com/api/videos/', {
            params: {
                key: config.pixabay.apiKey,
                q: keyword,
                per_page: 20,
                orientation: 'horizontal',
                video_type: 'film',
                safesearch: 'true',
            },
            timeout: 15000,
        });

        const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
        return hits.map(hit => {
            const videos = hit.videos || {};
            // `large` is up to 4K on newer uploads and the render transcode caps at 1080p,
            // so take the smallest rung that still fills the frame — usually `medium`
            // when `large` is 4K, and `large` itself otherwise. Order is preserved as the
            // tie-break/fallback so a clip with no dimensions reported behaves as before.
            const best = pickRenderRendition(
                [videos.large, videos.medium, videos.small, videos.tiny].filter(v => v?.url),
            ) || videos.large || videos.medium || videos.small || videos.tiny;
            if (!best?.url) return null;
            return {
                id: `pixabay-${hit.id}`,
                url: best.url,
                width: Number(best.width || 0),
                height: Number(best.height || 0),
                duration: Number(hit.duration || 0),
                title: hit.tags || `Pixabay video ${hit.id}`,
                _provider: 'pixabay',
                _directVideoUrl: best.url,
                // Newer Pixabay responses carry a per-rendition `thumbnail`;
                // older ones only carry `picture_id`, whose poster lives on the
                // Vimeo CDN. Try both so the screen works either way.
                _thumbUrl: firstThumbUrl(
                    best?.thumbnail,
                    videos.large?.thumbnail,
                    videos.medium?.thumbnail,
                    videos.small?.thumbnail,
                    videos.tiny?.thumbnail,
                    hit.picture_id ? `https://i.vimeocdn.com/video/${hit.picture_id}_640x360.jpg` : '',
                ),
            };
        }).filter(Boolean);
    }
}

module.exports = PixabayVideoProvider;
