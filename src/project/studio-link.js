'use strict';

/**
 * Forge's link to Studio, the shared folder where every video lives.
 *
 * Quill finishes a script and a voiceover into a Studio video folder; Forge
 * picks that voiceover up instead of the creator importing an audio file by
 * hand, and puts what it renders back.
 *
 * Every export is best-effort and never throws. Forge built videos long before
 * Studio existed and must keep doing so: no Studio folder, no link, or any
 * error at all simply means Forge behaves exactly as it always has.
 */

const fs = require('fs');
const path = require('path');

const STUDIO_ROOT = process.env.STUDIO_ROOT || 'D:\\Youtube\\Studio';
const LINK_FILE = '.studio-link.json';
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);

function lib() {
    try {
        const libDir = path.join(STUDIO_ROOT, '_lib');
        if (!fs.existsSync(path.join(libDir, 'studio.js'))) return null;
        return require(path.join(libDir, 'studio.js'));
    } catch (_) {
        return null;
    }
}

function readLink(projectDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(projectDir, LINK_FILE), 'utf8'));
        return raw && raw.videoDir && fs.existsSync(path.join(raw.videoDir, 'project.json'))
            ? raw.videoDir : null;
    } catch (_) {
        return null;
    }
}

function writeLink(projectDir, videoDir, project) {
    try {
        fs.writeFileSync(path.join(projectDir, LINK_FILE), JSON.stringify({
            videoDir,
            projectId: project ? project.id : null,
            idea: project ? (project.idea || {}).text : null,
            linkedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
    } catch (_) { /* the link is a convenience, not a requirement */ }
}

function hasOwnAudio(inputPath) {
    try {
        return fs.readdirSync(inputPath).some((f) =>
            AUDIO_EXT.has(path.extname(f).toLowerCase()) && !f.endsWith('.cleaned.mp3'));
    } catch (_) {
        return false;
    }
}

/** Studio videos whose voiceover is done and whose Forge stage has not started. */
function waitingForForge() {
    const studio = lib();
    if (!studio) return [];
    const out = [];
    try {
        for (const { folder } of studio.iterChannels()) {
            for (const project of studio.listProjects(folder)) {
                const stages = project.stages || {};
                const quill = stages.quill || {};
                const forge = stages.forge || {};
                if (project.line !== 'quill-forge') continue;
                if (quill.state !== 'voiceover-ready') continue;
                if (forge.state && forge.state !== 'pending') continue;
                if (!studio.latestAsset(project._dir, 'voiceover')) continue;
                out.push(project);
            }
        }
    } catch (_) { /* fall through to an empty list */ }
    return out;
}

/**
 * Decide which Studio video this build is for and stage its files into the
 * Forge project's input folder.
 *
 * An audio file the creator imported by hand ALWAYS wins — Studio only fills
 * an empty input folder, so pressing Build can never quietly swap his audio.
 * Returns null when there is nothing to do.
 */
function prepareBuild({ projectDir, inputPath }) {
    const studio = lib();
    if (!studio || !projectDir || !inputPath) return null;
    try {
        let videoDir = (process.env.STUDIO_VIDEO_DIR || '').trim() || readLink(projectDir);
        if (videoDir && !fs.existsSync(path.join(videoDir, 'project.json'))) videoDir = null;

        if (!videoDir) {
            if (hasOwnAudio(inputPath)) return null;
            const waiting = waitingForForge();
            if (waiting.length !== 1) {
                if (waiting.length > 1) {
                    console.log(`[Studio] ${waiting.length} videos are waiting for Forge — `
                        + 'import the one you want, or set STUDIO_VIDEO_DIR.');
                }
                return null;
            }
            videoDir = waiting[0]._dir;
        }

        const project = studio.readProject(videoDir);
        if (!project) return null;

        const voice = studio.latestAsset(videoDir, 'voiceover');
        if (!voice) return null;

        fs.mkdirSync(inputPath, { recursive: true });
        const audioFileName = path.basename(voice);
        const staged = path.join(inputPath, audioFileName);
        if (!fs.existsSync(staged) || fs.statSync(staged).size !== fs.statSync(voice).size) {
            fs.copyFileSync(voice, staged);
        }

        // The script rides along beside the narration. Forge still derives its
        // own timings by transcribing the audio; this is the writer's copy.
        const script = studio.latestAsset(videoDir, 'script');
        if (script) {
            try { fs.copyFileSync(script, path.join(inputPath, 'studio-script.txt')); } catch (_) {}
        }

        writeLink(projectDir, videoDir, project);
        try {
            studio.updateStage(videoDir, 'forge', {
                state: 'building',
                status: 'editing',
                data: { forge_project: projectDir, audio: audioFileName },
                note: 'build started',
            });
        } catch (_) {}

        console.log(`[Studio] Building "${project.title || (project.idea || {}).text}" `
            + `from ${videoDir}`);
        return { videoDir, audioFileName, project };
    } catch (err) {
        console.warn(`[Studio] link skipped: ${err.message}`);
        return null;
    }
}

/**
 * Put a finished render back into Studio. A partial (In/Out) render is a
 * working copy and goes to renders/; a whole-timeline render is the
 * deliverable and goes to final/.
 */
function recordRender({ projectDir, outputPath, partial }) {
    const studio = lib();
    if (!studio || !outputPath) return null;
    try {
        const videoDir = (process.env.STUDIO_VIDEO_DIR || '').trim() || readLink(projectDir);
        if (!videoDir || !fs.existsSync(path.join(videoDir, 'project.json'))) return null;
        if (!fs.existsSync(outputPath)) return null;

        const kind = partial ? 'renders' : 'final';
        const rel = studio.attachAsset(videoDir, kind, outputPath, { app: 'forge' });
        studio.updateStage(videoDir, 'forge', {
            state: partial ? 'render-preview' : 'rendered',
            status: partial ? 'editing' : 'rendered',
            files: [rel],
            data: { last_render: rel, rendered_at: new Date().toISOString() },
            note: partial ? 'partial render' : 'final render',
        });
        console.log(`[Studio] ${partial ? 'Preview' : 'Final video'} saved to ${kind}/`);
        return rel;
    } catch (err) {
        console.warn(`[Studio] could not record the render: ${err.message}`);
        return null;
    }
}

/**
 * Which channel, and which niche, this Forge project belongs to.
 *
 * The footage library is keyed by niche, and the niche lives on the CHANNEL
 * (`_channel.json`), not on the video — `project.json` has no niche field. So
 * this walks video folder -> parent channel folder and reads both.
 *
 * Best-effort like everything else here: a Forge project with no Studio link at
 * all simply reports nothing, and the caller carries on without a library.
 *
 * @returns {{videoDir:string, channelDir:string, channelSlug:string,
 *            vaultId:(number|null), niche:string, videoId:string,
 *            title:string}|null}
 */
function resolveContext({ projectDir } = {}) {
    try {
        const videoDir = (process.env.STUDIO_VIDEO_DIR || '').trim() || readLink(projectDir);
        if (!videoDir || !fs.existsSync(path.join(videoDir, 'project.json'))) return null;

        const project = JSON.parse(fs.readFileSync(path.join(videoDir, 'project.json'), 'utf8'));
        const channelDir = path.dirname(videoDir);

        let channel = {};
        try {
            channel = JSON.parse(fs.readFileSync(path.join(channelDir, '_channel.json'), 'utf8'));
        } catch (_) { /* a channel folder with no meta still gives us its slug */ }

        const vaultId = Number(channel.vault_id ?? (project.channel || {}).vault_id);
        return {
            videoDir,
            channelDir,
            channelSlug: String(channel.slug || (project.channel || {}).slug || path.basename(channelDir)),
            vaultId: Number.isFinite(vaultId) ? vaultId : null,
            niche: String(channel.niche || '').trim(),
            videoId: String(project.id || path.basename(videoDir)),
            title: String(project.title || (project.idea || {}).text || ''),
        };
    } catch (_) {
        return null;
    }
}
module.exports = { lib, prepareBuild, recordRender, waitingForForge, resolveContext };
