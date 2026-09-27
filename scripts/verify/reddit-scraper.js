#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT = path.resolve(__dirname, '..', '..');
const RedditVideoProvider = require(path.join(ROOT, 'src/media/providers/reddit-video.js'));
const failures = [];
const checks = [];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function check(label, fn) {
    try {
        const note = await fn();
        checks.push(`  ✓ ${label}${note ? ` — ${note}` : ''}`);
    } catch (error) {
        failures.push(`  ✗ ${label}\n      ${error.message}`);
    }
}

function post({
    id,
    subreddit = 'videos',
    slug = 'sample',
    title = 'Sample video',
    target = '',
    duration = '',
    score = '100 points',
    classes = '',
}) {
    return `<div class=" search-result search-result-link ${classes}" data-fullname="t3_${id}">
        <a href="/r/${subreddit}/comments/${id}/${slug}/" class="may-blank thumbnail">
            ${duration ? `<div class="duration-overlay">${duration}</div>` : ''}
        </a>
        <div>
            <header class="search-result-header">
                <a class="search-title may-blank" href="https://old.reddit.com/r/${subreddit}/comments/${id}/${slug}/">${title}</a>
            </header>
            <div class="search-result-meta">
                <span class="search-score">${score}</span>
                <a class="search-subreddit-link may-blank" href="https://old.reddit.com/r/${subreddit}/">r/${subreddit}</a>
            </div>
            ${target ? `<div class="search-result-footer"><a class="search-link may-blank" href="${target}">${target}</a></div>` : ''}
        </div>
    </div>`;
}

function page(contents, subredditContents = '') {
    return `<!doctype html><html><body class="combined-search-page search-page">
        <div class="listing search-result-listing">${subredditContents}</div>
        <div class="listing search-result-listing">
            <header><span class="search-header-label">posts</span></header>
            <div class="contents">${contents}</div>
        </div>
    </body></html>`;
}

const fullHtml = page([
    post({
        id: 'abc123',
        subreddit: 'oddlysatisfying',
        slug: 'long_rally',
        title: 'A &quot;long&quot; tennis rally',
        target: 'https://v.redd.it/video123',
        duration: '0:54',
        score: '11,652 points',
    }),
    post({
        id: 'gif456',
        subreddit: 'sports',
        slug: 'table_tennis',
        title: 'Table tennis rally',
        target: 'https://i.imgur.com/rally.gifv',
        score: '724 points',
    }),
    post({
        id: 'img789',
        title: 'Still image',
        target: 'https://i.redd.it/still.jpeg',
        score: '900 points',
    }),
    post({
        id: 'low111',
        title: 'Low score video',
        target: 'https://v.redd.it/lowvideo',
        duration: '0:20',
        score: '2 points',
    }),
    post({
        id: 'nsfw22',
        title: 'Hidden video',
        target: 'https://v.redd.it/hiddenvideo',
        duration: '0:20',
        score: '500 points',
        classes: 'over18',
    }),
].join(''));

const strippedHtml = page('', `
    <div class=" search-result search-result-subreddit " data-fullname="t5_test">
        <a class="search-title" href="/r/tennis/">tennis</a>
    </div>
`);

(async () => {
    await check('the scraper has no JSON discovery endpoint or permalink fan-out', () => {
        const source = fs.readFileSync(path.join(ROOT, 'src/media/providers/reddit-video.js'), 'utf8');
        assert(!/search\.json|comments\/[^'"`]*\.json/.test(source),
            'JSON discovery or per-post JSON resolution returned');
        assert(/https:\/\/old\.reddit\.com\/search/.test(source),
            'old.reddit search endpoint is not wired');
        assert(/const \{ execFileSync \} = require\('child_process'\)/.test(source),
            'execFileSync is still used without an import');
        return 'single old.reddit HTML request';
    });

    await check('old.reddit cards become canonical video candidates', () => {
        const provider = new RedditVideoProvider();
        const inspection = provider._inspectOldRedditHtml(fullHtml);
        const results = provider._parseOldRedditResults(inspection.postBlocks);

        assert(inspection.postBlocks.length === 5,
            `expected 5 post cards, got ${inspection.postBlocks.length}`);
        assert(results.length === 2,
            `expected Reddit video + Imgur video, got ${results.length}`);

        const reddit = results.find(result => result.id === 'reddit-abc123');
        const imgur = results.find(result => result.id === 'reddit-gif456');
        assert(reddit, 'Reddit-hosted video was not parsed');
        assert(reddit.url === 'https://www.reddit.com/r/oddlysatisfying/comments/abc123/long_rally/',
            `Reddit video did not use its canonical permalink: ${reddit.url}`);
        assert(reddit.duration === 54, `duration parsed as ${reddit.duration}, expected 54`);
        assert(reddit._score === 11652, `score parsed as ${reddit._score}, expected 11652`);
        assert(reddit.title === 'A "long" tennis rally', `HTML title was not decoded: ${reddit.title}`);
        assert(reddit._subreddit === 'oddlysatisfying', `subreddit parsed as ${reddit._subreddit}`);
        assert(imgur?.url === 'https://i.imgur.com/rally.gifv',
            `external video target was not preserved: ${imgur?.url}`);
        return 'video metadata extracted; images, NSFW, and score<3 rejected';
    });

    await check('a stripped 200 response is detected structurally', () => {
        const provider = new RedditVideoProvider();
        const inspection = provider._inspectOldRedditHtml(strippedHtml);
        assert(inspection.isSearchPage, 'fixture was not recognized as an old.reddit search page');
        assert(inspection.subredditCount === 1, `subreddit count is ${inspection.subredditCount}`);
        assert(inspection.postBlocks.length === 0, 'stripped page unexpectedly contains posts');
        assert(inspection.looksStripped, 'empty posts + live subreddit results was not flagged');
        return 'empty posts group + subreddit result';
    });

    await check('a stripped response gets one paced retry, then parses the recovered page', async () => {
        const provider = new RedditVideoProvider();
        provider._throttle = async () => true;
        const originalGet = axios.get;
        const calls = [];
        axios.get = async (url, options) => {
            calls.push({ url, options });
            return {
                data: calls.length === 1 ? strippedHtml : fullHtml,
                headers: {},
            };
        };

        try {
            const results = await provider._searchHtml('tennis rally');
            assert(calls.length === 2, `expected exactly 2 requests, got ${calls.length}`);
            assert(calls.every(call => call.url === 'https://old.reddit.com/search'),
                `unexpected endpoint: ${calls.map(call => call.url).join(', ')}`);
            assert(calls[0].options?.params?.q === 'tennis rally', 'query was not sent to old.reddit');
            assert(results.length === 2, `recovered page returned ${results.length} videos`);
        } finally {
            axios.get = originalGet;
        }
        return 'one retry, no JSON fallback';
    });

    await check('two stripped responses enter cooldown instead of hammering variants', async () => {
        const provider = new RedditVideoProvider();
        provider._throttle = async () => true;
        const originalGet = axios.get;
        let calls = 0;
        axios.get = async () => {
            calls++;
            return { data: strippedHtml, headers: {} };
        };

        try {
            const results = await provider._searchHtml('tennis serve');
            assert(results === null, `expected blocked scrape to return null, got ${JSON.stringify(results)}`);
            assert(calls === 2, `expected one retry before cooldown, got ${calls} requests`);
            assert(provider._cooldownRemainingMs() > 0, 'silent stripping did not start a cooldown');
        } finally {
            axios.get = originalGet;
        }
        return '2 requests max, then cooldown';
    });

    await check('parallel callers cannot race through the request gap', async () => {
        const provider = new RedditVideoProvider();
        provider._minRequestGap = 30;
        provider._lastRequestTime = 0;
        const startedAt = Date.now();
        const times = await Promise.all([0, 1, 2].map(async () => {
            assert(await provider._throttle(), 'throttle unexpectedly refused a request');
            return Date.now() - startedAt;
        }));

        const firstGap = times[1] - times[0];
        const secondGap = times[2] - times[1];
        assert(firstGap >= 20 && secondGap >= 20,
            `request starts were not serialized: ${times.join('ms, ')}ms`);
        return `starts at ${times.join('ms, ')}ms`;
    });

    console.log('\nReddit scraper verification\n');
    checks.forEach(line => console.log(line));
    if (failures.length > 0) {
        console.log('\nFAILED:');
        failures.forEach(line => console.log(line));
        console.log(`\n${failures.length} of ${failures.length + checks.length} checks failed.\n`);
        process.exit(1);
    }
    console.log(`\n${checks.length} checks passed.\n`);
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
