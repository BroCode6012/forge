const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');
const { pickRenderRendition } = require('./rendition-picker');
const { firstThumbUrl, midPreviewFrame } = require('./preview-thumb');

class PexelsVideoProvider extends BaseProvider {
    constructor() {
        super('Pexels Videos', 'video');
    }

    isAvailable() {
        return !!config.pexels?.apiKey;
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        const response = await axios.get('https://api.pexels.com/videos/search', {
            params: {
                query: keyword,
                per_page: 20,
                orientation: 'landscape',
            },
            headers: { Authorization: config.pexels.apiKey },
            timeout: 15000,
        });

        const videos = Array.isArray(response.data?.videos) ? response.data.videos : [];
        return videos.map(video => {
            const files = Array.isArray(video.video_files) ? video.video_files : [];
            // Smallest rendition that still fills the 1920x1080 render frame, not the
            // biggest one on offer — Pexels serves the same clip up to 4K and the render
            // transcode throws every pixel above 1080p away. See ./rendition-picker.js.
            const best = pickRenderRendition(
                files.filter(f => f?.link),
                { prefer: f => String(f.file_type || '').includes('mp4') },
            );
            if (!best?.link) return null;
            return {
                id: `pexels-${video.id}`,
                url: best.link,
                width: Number(best.width || video.width || 0),
                height: Number(best.height || video.height || 0),
                duration: Number(video.duration || 0),
                title: video.url || `Pexels video ${video.id}`,
                _provider: 'pexels',
                _directVideoUrl: best.link,
                // Pexels ships in-clip stills for free. Publishing one lets the
                // thumbnail screen see this clip before we download it.
                _thumbUrl: firstThumbUrl(
                    midPreviewFrame(video.video_pictures),
                    video.image,
                ),
            };
        }).filter(Boolean);
    }
}

module.exports = PexelsVideoProvider;
