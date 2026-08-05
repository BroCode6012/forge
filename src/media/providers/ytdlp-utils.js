const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const config = require('../../settings/config');

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('yt-dlp aborted'));
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('yt-dlp aborted'));
            }, { once: true });
        }
    });
}

function errorText(error) {
    const raw = [
        error?.message || '',
        error?.stderr || '',
        error?.stdout || '',
    ].filter(Boolean).join('\n');
    // yt-dlp emits Unicode curly quotes (U+2018/U+2019/U+201C/U+201D) in error
    // messages — normalize to ASCII so byte-exact `.includes()` pattern matching
    // works regardless of how the terminal encodes them.
    return raw
        .replace(/[\u2018\u2019\u02BC\u02B9\u02BB]/g, "'")
        .replace(/[\u201C\u201D]/g, '"');
}

function summarizeYtdlpError(error, maxLength = 180) {
    const text = errorText(error)
        .replace(/\s+/g, ' ')
        .replace(/Command failed:.*?(?=ERROR:|WARNING:|$)/i, '')
        .trim();
    if (!text) return error?.code ? `exit code ${error.code}` : 'unknown yt-dlp error';
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function isPermanentYtdlpError(error) {
    const text = errorText(error).toLowerCase();
    return [
        'video unavailable',
        'this video is unavailable',
        'this video is not available',
        'video is not available',
        'private video',
        'has been removed',
        'removed for violating',
        'does not exist',
        'video not found',
        'http error 404',
        'unsupported url',
        'sign in to confirm your age',
        // Bot challenge — retrying without cookies hits the SAME wall every time,
        // burning the per-scene deadline. Bail fast so the loop moves to the next
        // candidate and ultimately to the outer source-hint fallback (reddit / storyblocks).
        // (errorText() normalizes curly apostrophes to ASCII before this match runs.)
        "sign in to confirm you're not a bot",
        'confirm you are not a bot',
        'use --cookies-from-browser or --cookies',
        'age-restricted',
        'members-only',
        'copyright',
        'blocked in your country',
        'premiere has not begun',
        'no video formats found',
        'requested format is not available',
        'unable to extract uploader id',
    ].some(pattern => text.includes(pattern));
}

function isTransientYtdlpError(error) {
    if (isPermanentYtdlpError(error)) return false;

    const text = errorText(error).toLowerCase();
    const code = error?.code;
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(code)) {
        return true;
    }
    if (typeof code === 'number' && code !== 0) {
        return true;
    }

    return [
        'timed out',
        'timeout',
        'temporarily unavailable',
        'try again',
        'unable to download webpage',
        'unable to connect',
        'network is unreachable',
        'connection reset',
        'read econnreset',
        'http error 429',
        'too many requests',
        'http error 500',
        'http error 502',
        'http error 503',
        'http error 504',
        'fragment not found',
        'incompleteread',
        'being used by another process',
        'resource temporarily unavailable',
        'spawn',
    ].some(pattern => text.includes(pattern));
}

function _isLocalCandidate(candidate) {
    return path.isAbsolute(candidate) || /[\\/]/.test(candidate);
}

function _dedupe(values) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        if (!value) continue;
        const key = String(value).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}

function findYtdlp(opts = {}) {
    const logPrefix = opts.logPrefix || 'yt-dlp';
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const projectDir = process.env.PROJECT_DIR || '';
    const candidates = _dedupe([
        config.youtube?.ytdlpPath || null,
        path.join(repoRoot, 'yt-dlp', bin),
        path.join(repoRoot, bin),
        process.cwd() ? path.join(process.cwd(), 'yt-dlp', bin) : null,
        process.cwd() ? path.join(process.cwd(), bin) : null,
        projectDir ? path.join(projectDir, 'yt-dlp', bin) : null,
        projectDir ? path.join(projectDir, bin) : null,
        'yt-dlp',
    ].filter(Boolean));

    for (const candidate of candidates) {
        try {
            if (_isLocalCandidate(candidate)) {
                if (fs.existsSync(candidate)) {
                    console.log(`  [${logPrefix}] yt-dlp found: ${candidate}`);
                    return candidate;
                }
                continue;
            }

            execFileSync(candidate, ['--version'], {
                timeout: Math.max(5000, Number(config.network?.ytdlpCheckTimeoutMs || 15000)),
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            console.log(`  [${logPrefix}] yt-dlp found in PATH`);
            return candidate;
        } catch (_) {
            // Try next candidate.
        }
    }

    return null;
}

function _scaledTimeout(timeout, file = '') {
    const n = Number(timeout);
    if (!Number.isFinite(n) || n <= 0) return timeout;
    const scale = Math.max(1, Number(config.network?.ytdlpTimeoutScale || 1));
    const minTimeout = /yt-dlp(?:\.exe)?$/i.test(path.basename(String(file || '')))
        ? (config.network?.lowBandwidth ? 60_000 : 30_000)
        : 0;
    return Math.ceil(Math.min(10 * 60_000, Math.max(minTimeout, n * scale)));
}

// Inject auth cookies into every yt-dlp invocation. Without these, YouTube
// returns "Sign in to confirm you're not a bot" for stream-URL resolution,
// metadata fetch, AND download — three failure layers per candidate, each
// retried by execYtdlpWithRetry, burning the per-scene deadline.
//
// Skips injection when the args ALREADY contain --cookies/--cookies-from-browser
// (some callers may pass their own) and when the file isn't yt-dlp (defensive —
// these utils are sometimes given ffmpeg/ffprobe paths in other code paths).
let _ytdlpCookieArgsCache = null;
let _ytdlpCookieArgsLogged = false;
function _getYtdlpCookieArgs() {
    if (_ytdlpCookieArgsCache !== null) return _ytdlpCookieArgsCache;
    const cfg = config.youtube || {};
    const cookiesFile = String(cfg.cookiesFile || '').trim();
    const cookiesFromBrowser = String(cfg.cookiesFromBrowser || '').trim();
    if (cookiesFile) {
        if (!fs.existsSync(cookiesFile)) {
            if (!_ytdlpCookieArgsLogged) {
                console.log(`  [yt-dlp] WARNING: YTDLP_COOKIES_FILE points to missing file: ${cookiesFile}`);
                _ytdlpCookieArgsLogged = true;
            }
            _ytdlpCookieArgsCache = [];
            return _ytdlpCookieArgsCache;
        }
        _ytdlpCookieArgsCache = ['--cookies', cookiesFile];
    } else if (cookiesFromBrowser) {
        _ytdlpCookieArgsCache = ['--cookies-from-browser', cookiesFromBrowser];
    } else {
        _ytdlpCookieArgsCache = [];
    }
    if (!_ytdlpCookieArgsLogged && _ytdlpCookieArgsCache.length) {
        const safe = cookiesFile ? `file=${path.basename(cookiesFile)}` : `browser=${cookiesFromBrowser}`;
        console.log(`  [yt-dlp] cookie auth enabled (${safe})`);
        _ytdlpCookieArgsLogged = true;
    }
    return _ytdlpCookieArgsCache;
}

function _injectCookieArgs(file, args) {
    if (!Array.isArray(args)) return args;
    // Only inject for yt-dlp itself.
    if (file && !/yt-dlp(?:\.exe)?$/i.test(path.basename(String(file)))) return args;
    // Don't double-inject if caller already passed cookie flags.
    const argList = args.map(a => String(a || '').toLowerCase());
    if (argList.includes('--cookies') || argList.includes('--cookies-from-browser')) return args;
    const cookieArgs = _getYtdlpCookieArgs();
    if (cookieArgs.length === 0) return args;
    return [...cookieArgs, ...args];
}

function _hasArg(args, flag) {
    const needle = String(flag || '').toLowerCase();
    return (args || []).some(arg => {
        const text = String(arg || '').toLowerCase();
        return text === needle || text.startsWith(`${needle}=`);
    });
}

function _injectResilienceArgs(file, args) {
    if (!Array.isArray(args)) return args;
    if (file && !/yt-dlp(?:\.exe)?$/i.test(path.basename(String(file)))) return args;

    const extra = [];
    const addPair = (flag, value) => {
        if (_hasArg(args, flag) || _hasArg(extra, flag)) return;
        extra.push(flag, String(value));
    };

    // Retries + socket timeout are cheap and help EVERY call.
    addPair('--retries', process.env.YTDLP_RETRIES || '5');
    addPair('--fragment-retries', process.env.YTDLP_FRAGMENT_RETRIES || '5');
    addPair('--extractor-retries', process.env.YTDLP_EXTRACTOR_RETRIES || '3');
    addPair('--socket-timeout', process.env.YTDLP_SOCKET_TIMEOUT || '30');

    // Sleep pacing prevents rate-limit bans on real DOWNLOADS, but it must NOT be
    // applied to extraction-only calls (search / metadata / stream-URL). Those make
    // several HTTP requests while resolving, and --sleep-requests sleeps between EACH
    // one — pushing the call past its 20-30s timeout, so the process is killed with no
    // stderr ("unknown yt-dlp error"), retried, and the whole media phase crawls
    // (this was the 5-hour build's YouTube bleed). Pace downloads only.
    const argList = (args || []).map(a => String(a || '').toLowerCase());
    const EXTRACTION_FLAGS = new Set([
        '--flat-playlist', '--dump-json', '-j', '--dump-single-json', '-jj',
        '--get-url', '-g', '--get-id', '--get-title', '--get-duration',
        '--get-filename', '--no-download', '--skip-download', '--simulate', '-s', '--print',
    ]);
    const isExtractionOnly = argList.some(a => EXTRACTION_FLAGS.has(a));
    if (!isExtractionOnly) {
        addPair('--sleep-requests', process.env.YTDLP_SLEEP_REQUESTS || '1');
        addPair('--sleep-interval', process.env.YTDLP_SLEEP_INTERVAL || '2');
        addPair('--max-sleep-interval', process.env.YTDLP_MAX_SLEEP_INTERVAL || '6');
    }

    return extra.length ? [...extra, ...args] : args;
}

function _createYtdlpTempEnv(file, baseEnv = process.env) {
    if (process.platform !== 'win32' || !/yt-dlp(?:\.exe)?$/i.test(path.basename(String(file || '')))) {
        return { env: baseEnv, tempDir: null };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
    return {
        env: {
            ...baseEnv,
            TEMP: tempDir,
            TMP: tempDir,
        },
        tempDir,
    };
}

function execFileCapture(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        const finalArgs = _injectResilienceArgs(file, _injectCookieArgs(file, args));
        const temp = _createYtdlpTempEnv(file, options.env || process.env);
        const execOptions = {
            maxBuffer: 10 * 1024 * 1024,
            ...options,
            timeout: _scaledTimeout(options.timeout, file),
            env: temp.env,
        };
        execFile(file, finalArgs, execOptions, (error, stdout, stderr) => {
            if (temp.tempDir) {
                try { fs.rmSync(temp.tempDir, { recursive: true, force: true }); } catch (_) {}
            }
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function execYtdlpWithRetry(file, args, options = {}, retryOptions = {}) {
    const attempts = Math.max(1, retryOptions.attempts || (config.network?.lowBandwidth ? 4 : 3));
    const delays = retryOptions.delays || (config.network?.lowBandwidth ? [3000, 9000, 20000, 35000] : [2000, 6000, 15000]);
    const label = retryOptions.label || 'yt-dlp';
    const beforeAttempt = retryOptions.beforeAttempt;
    const signal = retryOptions.signal || options.signal;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) throw new Error('yt-dlp aborted');
        if (beforeAttempt) await beforeAttempt(attempt);

        try {
            return await execFileCapture(file, args, options);
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
                throw error;
            }
            const permanent = isPermanentYtdlpError(error);
            const transient = isTransientYtdlpError(error);
            const canRetry = !permanent && transient && attempt < attempts;

            if (!canRetry) {
                throw error;
            }

            const delay = delays[Math.min(attempt - 1, delays.length - 1)];
            console.log(`  [yt-dlp] ${label} transient failure ${attempt}/${attempts}: ${summarizeYtdlpError(error)}; retrying in ${Math.round(delay / 1000)}s`);
            await sleep(delay, signal);
        }
    }

    throw new Error('yt-dlp retry loop ended unexpectedly');
}

function normalizeMaxHeight(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function heightFilter(maxHeight) {
    const h = normalizeMaxHeight(maxHeight);
    return h ? `[height<=${h}]` : '';
}

// The trailing bare `best` is a capability floor, not an oversight. Every selector
// above it carries the [height<=N] filter, so a video whose streams are ALL taller
// than the cap has no match and yt-dlp aborts with "Requested format is not
// available" — a height cap would then be silently removing candidates from the
// running instead of just making them cheaper. The uncapped rung can only ever fire
// after all the capped ones missed, so it costs nothing in the normal case.
function buildBestVideoFormat(maxHeight = null) {
    const h = heightFilter(maxHeight);
    const formats = [
        `bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo${h}+bestaudio`,
        `best${h}[ext=mp4]`,
        `best${h}`,
    ];
    if (h) formats.push('best');
    return formats.join('/');
}

function buildBestVideoOnlyFormat(maxHeight = null) {
    const h = heightFilter(maxHeight);
    const formats = [
        `bestvideo${h}[ext=mp4]`,
        `bestvideo${h}`,
        `best${h}[ext=mp4]`,
        `best${h}`,
    ];
    if (h) formats.push('best');
    return formats.join('/');
}

function describeMaxHeight(maxHeight = null) {
    const h = normalizeMaxHeight(maxHeight);
    return h ? `<=${h}p` : 'best available/no height cap';
}

module.exports = {
    findYtdlp,
    execYtdlpWithRetry,
    isPermanentYtdlpError,
    isTransientYtdlpError,
    summarizeYtdlpError,
    normalizeMaxHeight,
    buildBestVideoFormat,
    buildBestVideoOnlyFormat,
    describeMaxHeight,
    getYtdlpCookieArgs: _getYtdlpCookieArgs,
};
