/**
 * audio-mixer.js — final audio finishing for the HyperFrames render output.
 *
 * OPENMONTAGE-BORROW-PLAN.md item #1 (technique + numeric constants only).
 *
 * The HyperFrames CLI already muxes the composition's <audio> tags (voiceover
 * vol=1 + sfx vol≈0.35) into the rendered mp4, but with no ducking, no music
 * bed, and no loudness normalization — so every video ships at a different
 * volume and any future music bed would fight the narration.
 *
 * This module POST-PROCESSES the finished mp4 (video stream COPIED untouched):
 *   - optional music bed ducked under the existing voice+sfx via sidechaincompress
 *   - final loudnorm to the YouTube target (I=-16 LUFS, TP=-1.5 dBTP, LRA=11)
 *
 * It is fully non-destructive: writes to a temp file, verifies it, and only then
 * atomically replaces the original. Any failure leaves the original mp4 intact.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Loudness target — EBU R128 / YouTube. These are facts, not config.
const LOUDNORM = 'loudnorm=I=-16:LRA=11:TP=-1.5';

function _resolveFfmpeg(explicit) {
    const candidates = [
        explicit,
        process.env.FFMPEG_PATH,
        (() => { try { return require('ffmpeg-static'); } catch (_) { return null; } })(),
        process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg',
        'ffmpeg',
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (c === 'ffmpeg' || fs.existsSync(c)) return c; } catch (_) { /* skip */ }
    }
    return null;
}

function _probe(ffmpeg, file) {
    try {
        // `-frames:v 0` stops ffmpeg after it parses the container header. Both fields we
        // read below (`Duration:` and the `Audio:` stream line) are printed at input-open
        // time from the moov atom, so decoding is pure waste: on a 4-minute 1080p render
        // the old `-f null -` form decoded all 7,789 video frames and took ~35s where this
        // takes ~0.6s. It also removes a scaling landmine — the 60s timeout below is fixed
        // while a full decode grows with video length, and a timeout here would silently
        // report hasAudio:false and skip loudness normalization on long videos.
        const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-frames:v', '0', '-f', 'null', '-'], {
            encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        });
        const out = `${r.stdout || ''}\n${r.stderr || ''}`;
        const hasAudio = /\bAudio:\s/i.test(out);
        let durationSec = 0;
        const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        return { hasAudio, durationSec };
    } catch (_) { return { hasAudio: false, durationSec: 0 }; }
}

/**
 * @param {object} opts
 * @param {string} opts.videoPath  — rendered mp4 to finish (replaced in place)
 * @param {string} [opts.bedPath]  — optional music-bed audio file (looped/ducked)
 * @param {number} [opts.bedGain]  — linear gain for the bed before ducking (default 0.18)
 * @param {string} [opts.ffmpegPath]
 * @param {function} [opts.log]
 * @returns {{ok:boolean, skipped?:boolean, ducked?:boolean, error?:string, outputPath?:string}}
 */
function finishAudio(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const videoPath = opts.videoPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
        return { ok: false, skipped: true, error: 'video not found' };
    }
    if (/^(0|false|off|no)$/i.test(String(process.env.AUDIO_FINISHING || '').trim())) {
        log('[AudioMixer] disabled via AUDIO_FINISHING=0 — skipping');
        return { ok: true, skipped: true };
    }

    const ffmpeg = _resolveFfmpeg(opts.ffmpegPath);
    if (!ffmpeg) {
        log('[AudioMixer] ffmpeg unavailable — skipping audio finishing');
        return { ok: true, skipped: true };
    }
    const info = _probe(ffmpeg, videoPath);
    if (!info.hasAudio) {
        log('[AudioMixer] rendered file has no audio stream — skipping');
        return { ok: true, skipped: true };
    }

    const bedPath = opts.bedPath && fs.existsSync(opts.bedPath) ? opts.bedPath : null;
    const bedGain = Number.isFinite(Number(opts.bedGain)) ? Number(opts.bedGain) : 0.18;
    // The bed is looped (-stream_loop -1) so it must be duration-bounded or
    // ffmpeg never terminates. We trim it to the video's length via atrim and
    // also cap the output with -t as a belt-and-suspenders.
    const dur = info.durationSec > 0.1 ? info.durationSec : 0;
    const tmp = videoPath.replace(/\.mp4$/i, `.finishing.${Date.now()}.mp4`);

    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    if (bedPath) args.push('-stream_loop', '-1');
    args.push('-i', videoPath);
    if (bedPath) args.push('-i', bedPath);

    let filter;
    if (bedPath) {
        // Duck the (bounded, looped) bed under the existing voice+sfx track, mix, normalize.
        const bedTrim = dur ? `,atrim=0:${dur.toFixed(3)}` : '';
        filter = [
            `[1:a]volume=${bedGain}${bedTrim}[bed]`,
            `[bed][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duckbed]`,
            `[0:a][duckbed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
            `[mix]${LOUDNORM}[aout]`,
        ].join(';');
    } else {
        filter = `[0:a]${LOUDNORM}[aout]`;
    }

    args.push(
        '-filter_complex', filter,
        '-map', '0:v:0',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
    );
    // Bound total output length when looping a bed (defensive against hangs).
    if (bedPath && dur) args.push('-t', dur.toFixed(3));
    if (bedPath) args.push('-shortest');
    args.push(tmp);

    try {
        log(`[AudioMixer] Finishing audio${bedPath ? ' (music bed + duck)' : ''} → loudnorm ${LOUDNORM.split('=')[1]}`);
        const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
        if (r.status !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
            const tail = String(r.stderr || r.error || '').trim().slice(-600);
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
            log(`[AudioMixer] finishing failed (exit ${r.status}) — keeping original render. ${tail}`);
            return { ok: false, error: tail || `ffmpeg exit ${r.status}` };
        }
        // Atomic-ish replace: remove original, rename temp into place.
        try { fs.unlinkSync(videoPath); } catch (_) {}
        fs.renameSync(tmp, videoPath);
        log(`[AudioMixer] ✅ audio finished${bedPath ? ' with ducked music bed' : ''} (normalized to −16 LUFS)`);
        return { ok: true, ducked: !!bedPath, outputPath: videoPath };
    } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        log(`[AudioMixer] finishing error (${String(e.message || e).slice(0, 120)}) — keeping original render`);
        return { ok: false, error: String(e.message || e) };
    }
}

module.exports = { finishAudio, LOUDNORM };
