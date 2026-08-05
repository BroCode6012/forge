// Style Studio — conversational style analyst UI
// Persistent Gemini chat session with reference video(s) + live profile preview

const api = window.electronAPI;

const state = {
    sessionId: null,
    videos: [],
    profile: null,
    busy: false,
    saveDir: null,
    audio: null, // { path, name, size }
    transcript: null, // { duration, language, segments }
    transcribing: false,
};

// ---------- DOM refs ----------
const $ = id => document.getElementById(id);

const els = {
    subtitle: $('subtitle'),
    thinkingMode: $('thinking-mode'),
    codeAccess: $('code-access'),
    btnNewSession: $('btn-new-session'),
    btnEndSession: $('btn-end-session'),
    // Restore banner
    restoreBanner: $('restore-banner'),
    restoreTitle: $('restore-title'),
    restoreDetail: $('restore-detail'),
    btnRestore: $('btn-restore'),
    btnDiscardSaved: $('btn-discard-saved'),

    videoList: $('video-list'),
    videoEmpty: $('video-empty'),
    videoCountBadge: $('video-count-badge'),
    videoUrlInput: $('video-url-input'),
    videoUrlsMulti: $('video-urls-multi'),
    inputMode: $('input-mode'),
    btnBrowseVideo: $('btn-browse-video'),
    btnAddVideo: $('btn-add-video'),
    audioCard: $('audio-card'),
    audioName: $('audio-name'),
    audioMeta: $('audio-meta'),
    audioMetaText: $('audio-meta-text'),
    audioStatusBadge: $('audio-status-badge'),
    btnBrowseAudio: $('btn-browse-audio'),
    btnTranscribeAudio: $('btn-transcribe-audio'),

    chatContextBar: $('chat-context-bar'),
    chatMessages: $('chat-messages'),
    chatEmpty: $('chat-empty'),
    chatQuickActions: $('chat-quick-actions'),
    chatInput: $('chat-input'),
    chatSend: $('chat-send'),

    profileContent: $('profile-content'),
    profileStatus: $('profile-status'),
    profileNameInput: $('profile-name-input'),
    btnExtractProfile: $('btn-extract-profile'),
    btnSaveProfile: $('btn-save-profile'),

    progressOverlay: $('progress-overlay'),
    progressMsg: $('progress-msg'),
    progressPct: $('progress-pct'),

    toast: $('toast'),
};

// ---------- helpers ----------
function showProgress(msg, pct) {
    els.progressMsg.textContent = msg || 'Working...';
    els.progressPct.textContent = pct != null ? `${Math.round(pct)}%` : '';
    els.progressOverlay.classList.add('active');
}
function hideProgress() {
    els.progressOverlay.classList.remove('active');
}

let _toastTimer = null;
function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.className = '';
    els.toast.classList.add('show');
    if (kind) els.toast.classList.add(kind);
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { els.toast.classList.remove('show'); }, 4000);
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Render markdown-lite: code blocks, inline code, bold, line breaks
function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    // Fenced code blocks
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre>${code}</pre>`);
    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Bold
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    return html;
}

function setBusy(busy) {
    state.busy = busy;
    els.chatInput.disabled = busy || !state.sessionId;
    els.chatSend.disabled = busy || !state.sessionId;
    els.btnAddVideo.disabled = busy;
    els.btnExtractProfile.disabled = busy || !state.sessionId;
    els.btnSaveProfile.disabled = busy || !state.profile;
    els.btnEndSession.disabled = busy || !state.sessionId;
    els.btnNewSession.disabled = busy;
    // Can't change analysis mode or input mode mid-session
    if (els.thinkingMode) els.thinkingMode.disabled = busy || !!state.sessionId;
    if (els.inputMode) els.inputMode.disabled = busy || !!state.sessionId;
}

// ---------- video sidebar ----------
function renderVideos() {
    els.videoCountBadge.textContent = state.videos.length;
    if (state.videos.length === 0) {
        els.videoList.innerHTML = `
            <div id="video-empty">
                <span class="icon"><svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><rect x="5" y="7" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="m13 11 6 4-6 4v-8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></span>
                Add a YouTube URL or local video file below to start a session.
            </div>`;
        return;
    }
    els.videoList.innerHTML = state.videos.map((v, i) => {
        const dur = v.duration ? `${Math.floor(v.duration / 60)}:${String(v.duration % 60).padStart(2, '0')}` : '?:??';
        const src = v.sourceUrl || '(local file)';
        const statusIcon = v.analyzed === false ? '!' : v.analyzed === true ? 'OK' : '...';
        const statusClass = v.analyzed === false ? 'failed' : v.analyzed === true ? 'ok' : 'pending';
        const statusTip = v.analyzed === false ? `Analysis failed: ${escapeHtml(v.analysisError || 'unknown error')}` : v.analyzed === true ? 'Analyzed' : 'Pending';
        const errorBlock = v.analyzed === false
            ? `<div class="video-error" title="${statusTip}">
                   <span class="video-error-msg">${escapeHtml(v.analysisError || 'analysis failed')}</span>
                   <button class="video-retry-btn" data-retry-idx="${i}">Retry</button>
               </div>`
            : '';
        return `
            <div class="video-card ${statusClass}">
                <div class="title">
                    <span class="video-status ${statusClass}" title="${statusTip}">${statusIcon}</span>
                    ${escapeHtml(v.title)}
                </div>
                <div class="meta">
                    <span class="duration">${dur}</span>
                    <span>·</span>
                    <span>video #${i + 1}</span>
                </div>
                <div class="source">${escapeHtml(src)}</div>
                ${errorBlock}
            </div>`;
    }).join('');
    // Wire retry buttons (delegated-style, rebuilt each render)
    els.videoList.querySelectorAll('.video-retry-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.getAttribute('data-retry-idx'), 10);
            retryVideoAnalysis(idx);
        });
    });
}

async function retryVideoAnalysis(idx) {
    if (!state.sessionId) {
        toast('No active session', 'error');
        return;
    }
    if (state.busy) return;
    const message = `retry video ${idx + 1}`;
    addMessage('user', message);
    setBusy(true);
    showTyping();
    try {
        const res = await api.styleStudioChat(state.sessionId, message);
        hideTyping();
        if (res?.error) throw new Error(res.error);
        addMessage('model', res.reply || '(no response)');
        if (res.retried && res.videos) {
            state.videos = res.videos;
            renderVideos();
            updateContextBar();
            if (res.retriedVideo?.analyzed) {
                toast(`Video #${(res.retriedVideo.index ?? idx) + 1} analyzed successfully`, 'success');
            } else {
                toast(`Re-analysis of video #${(res.retriedVideo?.index ?? idx) + 1} failed again`, 'error');
            }
        }
    } catch (e) {
        hideTyping();
        addMessage('model', `Error: ${e.message}`);
        toast(`Retry failed: ${e.message}`, 'error');
    } finally {
        setBusy(false);
    }
}

// ---------- chat ----------
function clearChatEmpty() {
    if (els.chatEmpty && els.chatEmpty.parentNode) {
        els.chatEmpty.parentNode.removeChild(els.chatEmpty);
    }
}

function addMessage(role, text, opts) {
    clearChatEmpty();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const avatar = role === 'user' ? 'U' : 'AI';
    wrap.innerHTML = `
        <div class="msg-avatar">${avatar}</div>
        <div class="msg-bubble">${renderMarkdown(text)}</div>
    `;
    els.chatMessages.appendChild(wrap);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    return wrap;
}

let _typingEl = null;
function showTyping() {
    if (_typingEl) return;
    _typingEl = document.createElement('div');
    _typingEl.className = 'typing';
    _typingEl.innerHTML = `<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>`;
    els.chatMessages.appendChild(_typingEl);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}
function hideTyping() {
    if (_typingEl && _typingEl.parentNode) _typingEl.parentNode.removeChild(_typingEl);
    _typingEl = null;
}

function clearChat() {
    els.chatMessages.innerHTML = '';
}

async function updateContextBar() {
    if (!state.sessionId) {
        els.chatContextBar.textContent = 'No active session — drop a reference video to begin.';
        return;
    }
    const totalDur = state.videos.reduce((s, v) => s + (v.duration || 0), 0);
    const m = Math.floor(totalDur / 60);
    const s = totalDur % 60;
    const mode = state.modeLabel || 'Standard';

    // Check memory count
    let memoryBadge = '';
    try {
        const memRes = await api.styleStudioLoadMemory?.();
        const count = (memRes?.memories || []).length;
        if (count > 0) {
            memoryBadge = ` · <span style="color:var(--pass);font-size:10px" title="Patterns learned from past videos">🧠 ${count} learned</span>`;
        }
    } catch (e) {}

    els.chatContextBar.innerHTML = `
        <span class="video-count">${state.videos.length} video(s)</span>
        loaded — total ${m}:${String(s).padStart(2, '0')}
        · <span style="color:var(--accent)">${mode}</span>${memoryBadge}
        <span class="session-id">· ${state.sessionId}</span>
    `;
}

// ---------- profile sidebar ----------
function renderProfile() {
    if (!state.profile || Object.keys(state.profile).length === 0) {
        els.profileContent.innerHTML = `
            <div id="profile-empty">
                <span class="icon"><svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><circle cx="15" cy="15" r="9" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"/><path d="M15 10v10M10 15h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
                No profile extracted yet.<br><br>
                Chat with the agent, then click <strong>Extract Profile</strong> below or say "extract profile" in chat.
            </div>`;
        els.profileStatus.textContent = '—';
        els.btnSaveProfile.disabled = true;
        return;
    }

    const p = state.profile;
    els.profileStatus.textContent = 'ready';
    els.btnSaveProfile.disabled = state.busy;

    const html = [];

    if (p.summary) {
        html.push(`
            <div class="profile-section">
                <div class="section-label">Summary</div>
                <div style="font-size:11px;color:var(--text2);line-height:1.5">${escapeHtml(p.summary)}</div>
            </div>`);
    }

    if (p.pacing) {
        const rows = [];
        if (p.pacing.avgSceneDuration) rows.push(`<div class="profile-row"><span class="key">Avg scene</span><span class="val">${p.pacing.avgSceneDuration}s</span></div>`);
        if (p.pacing.cutsPerMinute) rows.push(`<div class="profile-row"><span class="key">Cuts/min</span><span class="val">${p.pacing.cutsPerMinute}</span></div>`);
        if (p.pacing.rhythm) rows.push(`<div class="profile-row"><span class="key">Rhythm</span><span class="val">${escapeHtml(p.pacing.rhythm)}</span></div>`);
        if (p.pacing.hookDuration) rows.push(`<div class="profile-row"><span class="key">Hook</span><span class="val">${p.pacing.hookDuration}s</span></div>`);
        // Pacing segments
        if (Array.isArray(p.pacing.segments) && p.pacing.segments.length > 0) {
            rows.push(`<div style="margin-top:6px;font-size:9px;font-weight:700;color:var(--text3);letter-spacing:0.7px;text-transform:uppercase;margin-bottom:4px;">Pacing Flow</div>`);
            for (const seg of p.pacing.segments) {
                const t0 = Math.round(seg.startTime || 0);
                const t1 = Math.round(seg.endTime || 0);
                const energyColor = seg.energy === 'high' ? 'var(--reject)' : seg.energy === 'low' ? 'var(--pass)' : 'var(--warn)';
                rows.push(`<div style="font-size:10px;color:var(--text2);padding:2px 0;display:flex;justify-content:space-between;align-items:center;">
                    <span>${escapeHtml(seg.label || '?')} <span style="color:var(--text3)">${t0}-${t1}s</span></span>
                    <span style="color:${energyColor};font-weight:600;font-size:9px">${seg.cutsPerMinute ? seg.cutsPerMinute + ' cpm' : ''} ${escapeHtml(seg.energy || '')}</span>
                </div>`);
            }
        }
        if (rows.length) html.push(`<div class="profile-section"><div class="section-label">Pacing</div>${rows.join('')}</div>`);
    }

    if (p.colorPalette) {
        const cp = p.colorPalette;
        const swatch = (color) => {
            const raw = String(color || '').trim();
            if (!raw) return '—';
            const safeColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)
                ? raw
                : null;
            return `${safeColor ? `<span class="color-swatch" style="background-color:${safeColor}"></span>` : ''}${escapeHtml(raw)}`;
        };
        const rows = [];
        if (cp.primary)   rows.push(`<div class="profile-row"><span class="key">Primary</span><span class="val">${swatch(cp.primary)}</span></div>`);
        if (cp.secondary) rows.push(`<div class="profile-row"><span class="key">Secondary</span><span class="val">${swatch(cp.secondary)}</span></div>`);
        if (cp.accent)    rows.push(`<div class="profile-row"><span class="key">Accent</span><span class="val">${swatch(cp.accent)}</span></div>`);
        if (cp.text)      rows.push(`<div class="profile-row"><span class="key">Text</span><span class="val">${swatch(cp.text)}</span></div>`);
        if (cp.mood)      rows.push(`<div class="profile-row"><span class="key">Mood</span><span class="val">${escapeHtml(cp.mood)}</span></div>`);
        if (rows.length) html.push(`<div class="profile-section"><div class="section-label">Color Palette</div>${rows.join('')}</div>`);
    }

    if (p.motionGraphics) {
        const m = p.motionGraphics;
        const rows = [];
        if (m.density) rows.push(`<div class="profile-row"><span class="key">Density</span><span class="val">${escapeHtml(m.density)}</span></div>`);
        if (m.frequencyPerMinute != null) rows.push(`<div class="profile-row"><span class="key">Per minute</span><span class="val">${m.frequencyPerMinute}</span></div>`);
        if (m.placementPattern) rows.push(`<div class="profile-row"><span class="key">Placement</span><span class="val">${escapeHtml(m.placementPattern)}</span></div>`);
        if (m.preferredTypes && m.preferredTypes.length) {
            rows.push(`<div class="profile-row"><span class="key">Preferred</span><span class="val" style="font-size:10px">${escapeHtml(m.preferredTypes.slice(0, 6).join(', '))}</span></div>`);
        }
        if (rows.length) html.push(`<div class="profile-section"><div class="section-label">Motion Graphics</div>${rows.join('')}</div>`);
    }

    if (p.audio) {
        const a = p.audio;
        const rows = [];
        if (a.musicStyle) rows.push(`<div class="profile-row"><span class="key">Music</span><span class="val">${escapeHtml(a.musicStyle)}</span></div>`);
        if (a.musicEnergy) rows.push(`<div class="profile-row"><span class="key">Energy</span><span class="val">${escapeHtml(a.musicEnergy)}</span></div>`);
        if (a.voiceToMusicRatio) rows.push(`<div class="profile-row"><span class="key">Mix</span><span class="val">${escapeHtml(a.voiceToMusicRatio)}</span></div>`);
        if (a.sfxDensity) rows.push(`<div class="profile-row"><span class="key">SFX</span><span class="val">${escapeHtml(a.sfxDensity)}</span></div>`);
        if (rows.length) html.push(`<div class="profile-section"><div class="section-label">Audio</div>${rows.join('')}</div>`);
    }

    if (p.typography) {
        const t = p.typography;
        const rows = [];
        if (t.sizeStyle) rows.push(`<div class="profile-row"><span class="key">Size</span><span class="val">${escapeHtml(t.sizeStyle)}</span></div>`);
        if (t.fontFeel) rows.push(`<div class="profile-row"><span class="key">Feel</span><span class="val">${escapeHtml(t.fontFeel)}</span></div>`);
        if (t.animationType) rows.push(`<div class="profile-row"><span class="key">Animation</span><span class="val">${escapeHtml(t.animationType)}</span></div>`);
        if (rows.length) html.push(`<div class="profile-section"><div class="section-label">Typography</div>${rows.join('')}</div>`);
    }

    if (Array.isArray(p.systemNotes) && p.systemNotes.length > 0) {
        const important = p.systemNotes.filter(n => n.priority === 'important').slice(0, 5);
        if (important.length > 0) {
            const items = important.map(n =>
                `<div style="font-size:10px;color:var(--text2);line-height:1.4;margin-bottom:6px;">
                    <strong style="color:var(--accent);font-size:9px;text-transform:uppercase">${escapeHtml(n.area)}</strong><br>
                    ${escapeHtml(n.gap || n.observation || '')}
                </div>`
            ).join('');
            html.push(`<div class="profile-section"><div class="section-label">System Gaps</div>${items}</div>`);
        }
    }

    els.profileContent.innerHTML = html.join('') || '<div id="profile-empty">Profile extracted but empty.</div>';
}

// ---------- actions ----------

async function handleStartSession() {
    const isMulti = els.inputMode?.value === 'multi';
    let urls = [];

    if (isMulti) {
        urls = (els.videoUrlsMulti?.value || '').split('\n').map(u => u.trim()).filter(Boolean);
        if (urls.length === 0) {
            toast('Enter at least one URL in the multi-URL field', 'error');
            return;
        }
        if (urls.length > 6) {
            toast('Maximum 6 videos per session', 'error');
            return;
        }
    } else {
        const input = els.videoUrlInput.value.trim();
        if (!input) {
            toast('Enter a YouTube URL or local file path first', 'error');
            return;
        }
        urls = [input];
    }

    const thinkingMode = els.thinkingMode?.value || 'off';
    const codeAccess = els.codeAccess?.checked !== false;
    const modeLabel = thinkingMode === 'off' ? 'Standard' : thinkingMode === 'high' ? 'Deep Analysis' : 'Balanced';

    setBusy(true);
    showProgress(`Starting session with ${urls.length} video(s)...`, 5);

    try {
        // Start session with first URL
        const res = await api.styleStudioStart(urls[0], { thinkingMode, codeAccess });
        if (res?.error) throw new Error(res.error);

        state.sessionId = res.sessionId;
        state.videos = res.videos || [];
        state.profile = null;
        state.modeLabel = modeLabel;

        renderVideos();
        updateContextBar();
        clearChat();
        addMessage('user', `Watch this reference video and brief me.`);
        addMessage('model', res.initialMessage || '(no response)');

        // Add remaining URLs sequentially
        for (let i = 1; i < urls.length; i++) {
            showProgress(`Adding video ${i + 1}/${urls.length}...`, Math.round((i / urls.length) * 80) + 10);
            try {
                const addRes = await api.styleStudioAddVideo(state.sessionId, urls[i]);
                if (addRes?.error) {
                    addMessage('model', `Failed to add video ${i + 1}: ${addRes.error}`);
                    continue;
                }
                state.videos = addRes.videos || state.videos;
                renderVideos();
                updateContextBar();
                addMessage('user', `Added video ${i + 1} — brief me.`);
                addMessage('model', addRes.message || '(no response)');
            } catch (e) {
                addMessage('model', `Failed to add video ${i + 1}: ${e.message}`);
            }
        }

        renderProfile();
        els.chatInput.placeholder = 'Ask anything about the video(s)...';
        els.chatQuickActions.style.display = 'flex';
        els.btnAddVideo.textContent = '+ Add Video';
        els.videoUrlInput.value = '';
        if (els.videoUrlsMulti) els.videoUrlsMulti.value = '';

        toast(`Session started with ${state.videos.length} video(s)`, 'success');
    } catch (e) {
        toast(`Failed to start session: ${e.message}`, 'error');
        console.error(e);
    } finally {
        hideProgress();
        setBusy(false);
        els.chatInput.focus();
    }
}

async function handleAddVideo() {
    if (!state.sessionId) {
        return handleStartSession();
    }

    const input = els.videoUrlInput.value.trim();
    if (!input) {
        toast('Enter a video URL or path first', 'error');
        return;
    }

    setBusy(true);
    showProgress('Adding video to session...', 10);

    try {
        const res = await api.styleStudioAddVideo(state.sessionId, input);
        if (res?.error) throw new Error(res.error);

        state.videos = res.videos || state.videos;
        renderVideos();
        updateContextBar();
        addMessage('user', `Added another reference video — brief me on this one.`);
        addMessage('model', res.message || '(no response)');

        els.videoUrlInput.value = '';
        toast('Video added', 'success');
    } catch (e) {
        toast(`Failed to add video: ${e.message}`, 'error');
    } finally {
        hideProgress();
        setBusy(false);
    }
}

async function handleSendMessage() {
    const message = els.chatInput.value.trim();
    if (!message || !state.sessionId || state.busy) return;

    addMessage('user', message);
    els.chatInput.value = '';
    autoresizeInput();

    setBusy(true);
    showTyping();

    try {
        const res = await api.styleStudioChat(state.sessionId, message);
        hideTyping();
        if (res?.error) throw new Error(res.error);
        const replyEl = addMessage('model', res.reply || '(no response)');

        // Show a subtle badge if code context was injected
        if (res.codeContextUsed) {
            const badge = document.createElement('div');
            badge.className = 'code-context-badge';
            badge.textContent = '{ } code context attached';
            if (replyEl) replyEl.appendChild(badge);
        }

        // Show memory action badge
        if (res.memoryAction) {
            showMemoryBadge(replyEl, res.memoryAction);
        }

        // If this was a retry, refresh video sidebar with updated status
        if (res.retried && res.videos) {
            state.videos = res.videos;
            renderVideos();
            updateContextBar();
            if (res.retriedVideo?.analyzed) {
                toast(`Video #${res.retriedVideo.index + 1} analyzed successfully`, 'success');
            } else {
                toast(`Re-analysis of video #${(res.retriedVideo?.index ?? 0) + 1} failed again`, 'error');
            }
        }

        // If user said "extract profile" / similar, try parsing it
        if (/extract\s*profile|emit\s*profile|final\s*profile/i.test(message)) {
            tryParseProfileFromReply(res.reply);
        }
    } catch (e) {
        hideTyping();
        addMessage('model', `Error: ${e.message}`);
        toast(e.message, 'error');
    } finally {
        setBusy(false);
        els.chatInput.focus();
    }
}

function tryParseProfileFromReply(reply) {
    if (!reply) return;
    // Look for fenced JSON block first
    const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
    let candidate = fenced ? fenced[1] : null;

    if (!candidate) {
        const first = reply.indexOf('{');
        const last = reply.lastIndexOf('}');
        if (first !== -1 && last > first) candidate = reply.slice(first, last + 1);
    }

    if (!candidate) return;
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && (parsed.pacing || parsed.motionGraphics || parsed.colorPalette)) {
            state.profile = parsed;
            renderProfile();
            toast('Profile parsed from chat reply', 'success');
        }
    } catch (e) {
        // Not parseable — ignore
    }
}

async function handleExtractProfile() {
    if (!state.sessionId || state.busy) return;

    setBusy(true);
    showProgress('Asking agent to extract structured profile...', 30);
    addMessage('user', 'Extract the final structured profile.');
    showTyping();

    try {
        const res = await api.styleStudioExtractProfile(state.sessionId);
        hideTyping();
        if (res?.error) throw new Error(res.error);

        state.profile = res.profile || res;
        renderProfile();
        addMessage('model', '✓ Profile extracted. Review it on the right, then click **Save Profile** to write it to your project.');
        toast('Profile extracted', 'success');
    } catch (e) {
        hideTyping();
        addMessage('model', `Failed to extract profile: ${e.message}`);
        toast(e.message, 'error');
    } finally {
        hideProgress();
        setBusy(false);
    }
}

async function handleSaveProfile() {
    if (!state.profile || !state.sessionId) return;

    const name = els.profileNameInput.value.trim() ||
                 (state.videos.length > 1 ? 'Channel Style' : (state.videos[0]?.title || 'Studio Profile'));

    setBusy(true);
    try {
        const res = await api.styleStudioSaveProfile(state.sessionId, name);
        if (res?.error) throw new Error(res.error);
        toast(`Saved: ${res.savedPath || name}`, 'success');
        addMessage('model', `✓ Saved profile as **${name}**.`);
    } catch (e) {
        toast(`Save failed: ${e.message}`, 'error');
    } finally {
        setBusy(false);
    }
}

async function handleEndSession() {
    if (!state.sessionId) return;
    if (!confirm('End this session? Uploaded videos will be deleted from Gemini.')) return;

    setBusy(true);
    try {
        await api.styleStudioEndSession(state.sessionId);
    } catch (e) {
        console.error(e);
    }
    state.sessionId = null;
    state.videos = [];
    state.profile = null;
    renderVideos();
    renderProfile();
    updateContextBar();
    clearChat();
    els.chatMessages.innerHTML = `
        <div class="chat-empty" id="chat-empty">
            <span class="big-icon"><svg width="46" height="46" viewBox="0 0 46 46" fill="none" aria-hidden="true"><path d="M23 6v34M6 23h34M11 11l24 24M35 11 11 35" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="23" cy="23" r="5" stroke="currentColor" stroke-width="1.4"/></svg></span>
            <h2>Session ended</h2>
            <p>Add another reference video to start a new conversation.</p>
        </div>`;
    els.chatEmpty = $('chat-empty');
    els.chatQuickActions.style.display = 'none';
    els.btnAddVideo.textContent = 'Start Session';
    els.chatInput.placeholder = 'Start a session first to chat...';
    setBusy(false);
}

async function handleNewSession() {
    if (state.sessionId) {
        await handleEndSession();
    }
    els.videoUrlInput.focus();
}

async function handleBrowseVideo() {
    try {
        const path = await api.pickVideoFile?.();
        if (path) els.videoUrlInput.value = path;
    } catch (e) {
        toast('Browse not available — paste a path instead', 'error');
    }
}

// ---------- audio / transcription ----------

function _formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function _formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderAudioCard() {
    if (!els.audioCard) return;
    const a = state.audio;
    const t = state.transcript;

    if (!a) {
        els.audioCard.classList.add('empty');
        els.audioName.textContent = 'No audio loaded';
        els.audioMetaText.textContent = 'Pick an MP3/WAV, then transcribe';
        els.btnTranscribeAudio.disabled = true;
        els.audioStatusBadge.textContent = '—';
        return;
    }

    els.audioCard.classList.remove('empty');
    els.audioName.textContent = a.name || a.path;

    if (state.transcribing) {
        els.audioMetaText.innerHTML = `<span class="warn">Transcribing…</span>`;
        els.audioStatusBadge.textContent = '…';
        els.btnTranscribeAudio.disabled = true;
        return;
    }

    const bits = [];
    if (a.size) bits.push(_formatBytes(a.size));
    if (t) {
        bits.push(`<span class="ok">${_formatDuration(t.duration)}</span>`);
        bits.push(`${t.segments} seg`);
        if (t.language && t.language !== 'unknown') bits.push(t.language.toUpperCase());
        els.audioStatusBadge.textContent = '✓';
    } else {
        bits.push(`<span class="warn">not transcribed</span>`);
        els.audioStatusBadge.textContent = '!';
    }
    els.audioMetaText.innerHTML = bits.join(' · ');
    els.btnTranscribeAudio.disabled = false;
}

async function handleBrowseAudio() {
    try {
        const pick = await api.styleStudioPickAudio?.();
        if (!pick || pick.error) {
            if (pick?.error) toast(pick.error, 'error');
            return;
        }
        state.audio = pick;
        // Picking a new file invalidates any previous transcript display
        state.transcript = null;
        renderAudioCard();
    } catch (e) {
        toast('Could not pick audio', 'error');
    }
}

async function handleTranscribeAudio() {
    if (!state.audio || state.transcribing) return;
    state.transcribing = true;
    renderAudioCard();
    showProgress('Transcribing audio with Whisper…', 5);
    try {
        const res = await api.styleStudioTranscribeAudio?.(state.audio.path, {});
        if (!res || res.error) {
            toast(res?.error || 'Transcription failed', 'error');
            state.transcript = null;
        } else {
            state.transcript = {
                duration: res.duration,
                language: res.language,
                segments: res.segments,
                path: res.path,
            };
            toast(`Transcribed — ${res.segments} segments, ${_formatDuration(res.duration)}`, 'success');

            // Phase 1: if a session is active, auto-run script analysis now
            // that a transcript exists. Drops the brief into the chat so the
            // user sees what the Director concluded about their project.
            if (state.sessionId && api.styleStudioAnalyzeScript) {
                try {
                    showProgress('Phase 1: analyzing script + topic research…', 30);
                    addMessage('user', 'Analyze my project transcript and do topic research (Phase 1).');
                    const ar = await api.styleStudioAnalyzeScript(state.sessionId);
                    if (ar?.ok && ar.analysis) {
                        const a = ar.analysis;
                        const lines = [];
                        if (a.summary)    lines.push(`**Summary:** ${a.summary}`);
                        if (a.topic)      lines.push(`**Topic:** ${a.topic}`);
                        if (a.format)     lines.push(`**Format:** ${a.format}${a.formatEvidence ? ` — *${a.formatEvidence}*` : ''}`);
                        if (a.niche)      lines.push(`**Niche:** \`${a.niche}\`${a.nicheReason ? ` — ${a.nicheReason}` : ''}`);
                        if (a.tone || a.pacing) lines.push(`**Tone/Pacing:** ${[a.tone, a.pacing].filter(Boolean).join(' · ')}${a.pacingNotes ? ` — ${a.pacingNotes}` : ''}`);
                        if (a.hookEnd != null)  lines.push(`**Hook ends:** ${a.hookEnd}s`);
                        if (a.ctaStart != null) lines.push(`**CTA starts:** ${a.ctaStart}s`);
                        if (Array.isArray(a.keyTopics) && a.keyTopics.length) lines.push(`**Key topics:** ${a.keyTopics.join('; ')}`);
                        if (Array.isArray(a.entities) && a.entities.length) {
                            lines.push(`**Entities (${a.entities.length}):** ${a.entities.slice(0, 12).map(e => `${e.name} (${e.type})`).join(', ')}${a.entities.length > 12 ? '…' : ''}`);
                        }
                        if (Array.isArray(a.factChecks) && a.factChecks.length) {
                            lines.push(`**Fact checks:**\n${a.factChecks.map(f => `- [${f.verdict}] ${f.claim}${f.note ? ` — ${f.note}` : ''}`).join('\n')}`);
                        }
                        if (Array.isArray(a.transcriptErrors) && a.transcriptErrors.length) {
                            lines.push(`**Transcript errors flagged:**\n${a.transcriptErrors.map(e => `- @${e.at}s "${e.heard}" → "${e.shouldBe}" (${e.confidence})`).join('\n')}`);
                        }
                        if (a.notes) lines.push(`**Notes:** ${a.notes}`);
                        addMessage('model', `**Phase 1 brief saved.** Attached to every future turn.\n\n${lines.join('\n\n')}`);
                    } else {
                        addMessage('model', `(Phase 1 failed: ${ar?.error || 'unknown'})`);
                    }
                } catch (e) {
                    addMessage('model', `(Phase 1 error: ${e.message})`);
                } finally {
                    hideProgress();
                }
            }
        }
    } catch (e) {
        toast(`Transcription error: ${e.message}`, 'error');
    } finally {
        state.transcribing = false;
        hideProgress();
        renderAudioCard();
    }
}

async function refreshTranscriptInfo() {
    try {
        const info = await api.styleStudioGetTranscriptInfo?.();
        if (info?.exists) {
            state.transcript = {
                duration: info.duration,
                language: info.language,
                segments: info.segments,
                path: info.path,
            };
            renderAudioCard();
        }
    } catch (_) {}
}

// ---------- input wiring ----------
function autoresizeInput() {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(140, els.chatInput.scrollHeight) + 'px';
}

els.chatInput.addEventListener('input', autoresizeInput);
els.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
    }
});
els.chatSend.addEventListener('click', handleSendMessage);

els.btnAddVideo.addEventListener('click', handleAddVideo);
els.btnBrowseVideo.addEventListener('click', handleBrowseVideo);
els.btnNewSession.addEventListener('click', handleNewSession);
els.btnEndSession.addEventListener('click', handleEndSession);
els.btnExtractProfile.addEventListener('click', handleExtractProfile);
els.btnSaveProfile.addEventListener('click', handleSaveProfile);
if (els.btnBrowseAudio) els.btnBrowseAudio.addEventListener('click', handleBrowseAudio);
if (els.btnTranscribeAudio) els.btnTranscribeAudio.addEventListener('click', handleTranscribeAudio);

// Transcription progress stream from main
if (api.onStyleStudioTranscribeProgress) {
    api.onStyleStudioTranscribeProgress((data) => {
        if (data?.message) showProgress(data.message, data.percent);
        if (data?.percent >= 100) hideProgress();
    });
}

els.videoUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddVideo();
});

// Input mode toggle: single vs multi
if (els.inputMode) {
    els.inputMode.addEventListener('change', () => {
        const isMulti = els.inputMode.value === 'multi';
        els.videoUrlInput.style.display = isMulti ? 'none' : 'block';
        if (els.videoUrlsMulti) els.videoUrlsMulti.style.display = isMulti ? 'block' : 'none';
        if (els.btnBrowseVideo) els.btnBrowseVideo.style.display = isMulti ? 'none' : '';
    });
}

// Code access toggle — can be changed mid-session
if (els.codeAccess) {
    els.codeAccess.addEventListener('change', () => {
        if (state.sessionId) {
            api.styleStudioSetCodeAccess?.(state.sessionId, els.codeAccess.checked);
            toast(`Code access ${els.codeAccess.checked ? 'enabled' : 'disabled'}`, 'success');
        }
    });
}

// Quick action buttons
document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const msg = btn.getAttribute('data-msg');
        if (!msg || !state.sessionId || state.busy) return;
        els.chatInput.value = msg;
        handleSendMessage();
    });
});

// Listen for progress updates from the main process
if (api.onStyleStudioProgress) {
    api.onStyleStudioProgress((data) => {
        if (data?.message) showProgress(data.message, data.percent);
        if (data?.percent >= 100) hideProgress();
    });
}

// ---------- session restore ----------

async function checkSavedSession() {
    try {
        const saved = await api.styleStudioCheckSaved?.();
        if (!saved || !saved.sessionId) return;

        const videoCount = (saved.videos || []).length;
        const msgCount = (saved.chatMessages || []).length;
        const ageMin = saved.age || 0;
        const ageLabel = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
        const expiredLabel = saved.videosExpired ? ' (videos need re-upload)' : '';
        const firstTitle = saved.videos?.[0]?.title || 'Unknown';

        els.restoreTitle.textContent = `Previous session: "${firstTitle}"`;
        els.restoreDetail.textContent = `${videoCount} video(s), ${msgCount} messages, started ${ageLabel}${expiredLabel}`;
        els.restoreBanner.classList.add('active');
    } catch (e) {
        console.error('[StyleStudio] checkSavedSession:', e);
    }
}

async function handleRestore() {
    els.restoreBanner.classList.remove('active');
    setBusy(true);
    showProgress('Restoring previous session...', 5);

    try {
        const res = await api.styleStudioRestore?.();
        if (res?.error) throw new Error(res.error);

        state.sessionId = res.sessionId;
        state.videos = res.videos || [];
        state.profile = res.profile && Object.keys(res.profile).length > 0 ? res.profile : null;
        state.modeLabel = res.thinkingMode === 'off' ? 'Standard' : res.thinkingMode === 'high' ? 'Deep Analysis' : 'Balanced';

        renderVideos();
        updateContextBar();
        clearChat();

        // Replay saved chat messages into the UI
        const msgs = res.chatMessages || [];
        for (const m of msgs) {
            addMessage(m.role, m.text);
        }

        // Add a system note about the restore
        addMessage('model', '(Session restored from disk. Gemini context has been rebuilt — you can continue chatting normally.)');

        renderProfile();
        els.chatInput.placeholder = 'Ask anything about the video(s)...';
        els.chatQuickActions.style.display = 'flex';
        els.btnAddVideo.textContent = '+ Add Video';

        // Restore settings
        if (els.thinkingMode && res.thinkingMode) {
            els.thinkingMode.value = res.thinkingMode;
        }
        if (els.codeAccess) {
            els.codeAccess.checked = res.codeAccess !== false;
        }

        toast(`Session restored (${msgs.length} messages)`, 'success');
    } catch (e) {
        toast(`Restore failed: ${e.message}`, 'error');
        console.error(e);
    } finally {
        hideProgress();
        setBusy(false);
        els.chatInput.focus();
    }
}

async function handleDiscardSaved() {
    els.restoreBanner.classList.remove('active');
    try {
        await api.styleStudioDiscardSaved?.();
        toast('Saved session discarded', 'success');
    } catch (e) {
        console.error(e);
    }
}

// Restore banner event listeners
if (els.btnRestore) els.btnRestore.addEventListener('click', handleRestore);
if (els.btnDiscardSaved) els.btnDiscardSaved.addEventListener('click', handleDiscardSaved);

// ---------- memory badge in chat ----------

function showMemoryBadge(msgEl, action) {
    if (!action || !msgEl) return;
    const badge = document.createElement('div');
    badge.className = 'memory-badge';
    if (action.type === 'saved') {
        badge.textContent = `💾 Saved to memory: "${action.text.substring(0, 60)}${action.text.length > 60 ? '...' : ''}"`;
    } else if (action.type === 'deleted') {
        badge.textContent = `🗑 Memory entry #${action.index + 1} deleted`;
    } else if (action.type === 'list') {
        badge.textContent = `📋 ${(action.memories || []).length} memory entries`;
    }
    const lastMsg = msgEl.parentNode?.lastElementChild;
    if (lastMsg) lastMsg.appendChild(badge);
}

// Init
renderVideos();
renderProfile();
renderAudioCard();
refreshTranscriptInfo(); // pull existing transcription.json if it exists
updateContextBar();
checkSavedSession(); // Check for saved session on load
console.log('[StyleStudio] UI initialized');
