/**
 * QA Chat App — developer chat interface to interrogate the QA agent's niche knowledge.
 */

'use strict';

const api      = window.electronAPI;
const messages = document.getElementById('messages');
const input    = document.getElementById('msg-input');
const sendBtn  = document.getElementById('btn-send');
const clearBtn = document.getElementById('btn-clear');
const nicheSelect = document.getElementById('niche-select');

// Conversation history for multi-turn context
let history = [];
let sending = false;
let projectContext = null; // loaded from current video plan

// ── Load current project ──
(async function loadProject() {
    const bar = document.getElementById('project-bar');
    try {
        const plan = await window.electronAPI.loadVideoPlan();
        if (!plan || !plan.scriptContext) {
            bar.textContent = 'No project loaded — general niche knowledge mode';
            return;
        }
        const ctx = plan.scriptContext;
        const title  = ctx.title   || ctx.summary || '—';
        const niche  = ctx.nicheId || ctx.niche   || '—';
        const format = ctx.format  || '—';
        const theme  = ctx.themeId || ctx.theme   || '—';

        projectContext = {
            title,
            nicheId:  niche,
            format,
            themeId:  theme,
            entities: ctx.entities || [],
            qaResults: [],  // standalone chat has no QA run results
        };

        bar.innerHTML = `<span>${_esc(title.substring(0, 40))}</span> · niche:<span>${_esc(niche)}</span> · theme:<span>${_esc(theme)}</span>`;

        // Auto-select niche in dropdown if it matches
        if (niche && nicheSelect) {
            for (const opt of nicheSelect.options) {
                if (opt.value === niche) { nicheSelect.value = niche; break; }
            }
        }
    } catch (e) {
        bar.textContent = 'Project unavailable — general mode';
    }
})();

function _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Populate niche dropdown ──
(async function initNicheSelect() {
    const { explainer = [], news = [], other = [] } = await api.qaChatGetNicheList();

    const addGroup = (label, ids) => {
        if (!ids.length) return;
        const grp = document.createElement('optgroup');
        grp.label = label;
        ids.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            grp.appendChild(opt);
        });
        nicheSelect.appendChild(grp);
    };

    addGroup('── Explainer / Documentary ──', explainer);
    addGroup('── Breaking News ──', news);
    addGroup('── Other ──', other);
})().catch((error) => addSysMsg(`Could not load niches: ${error.message}`));

// ── Render helpers ──
function addSysMsg(text) {
    const div = document.createElement('div');
    div.className = 'sys-msg';
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function addMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? 'U' : 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    // Simple inline code detection: `backtick` → <code>
    bubble.innerHTML = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrap.appendChild(avatar);
    const right = document.createElement('div');
    right.appendChild(bubble);
    right.appendChild(meta);
    wrap.appendChild(right);

    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
}

function addTypingIndicator() {
    const wrap = document.createElement('div');
    wrap.className = 'msg agent';
    wrap.id = 'typing';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'AI';

    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('div');
        dot.className = 'typing-dot';
        indicator.appendChild(dot);
    }

    wrap.appendChild(avatar);
    wrap.appendChild(indicator);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return wrap;
}

// ── Send message ──
async function send(text) {
    text = (text || input.value).trim();
    if (!text || sending) return;

    sending = true;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    const focusNiche = nicheSelect.value || null;
    addMessage('user', text);

    history.push({ role: 'user', text });

    const typing = addTypingIndicator();

    try {
        // Merge niche dropdown selection into project context
        const ctx = projectContext
            ? { ...projectContext, nicheId: focusNiche || projectContext.nicheId }
            : { nicheId: focusNiche };
        const reply = await api.qaChatSend(history, ctx);
        typing.remove();
        addMessage('model', reply);
        history.push({ role: 'model', text: reply });
    } catch (err) {
        typing.remove();
        addSysMsg(`Error: ${err.message}`);
        history.pop(); // remove user message from history if it failed
    } finally {
        sending = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

// ── Niche change ──
nicheSelect.addEventListener('change', () => {
    const niche = nicheSelect.value;
    if (niche) {
        addSysMsg(`Focus niche changed to: ${niche} — context updated for next message`);
    }
});

// ── Clear ──
clearBtn.addEventListener('click', () => {
    history = [];
    messages.innerHTML = '<div class="sys-msg">Conversation cleared. Select a niche and start fresh.</div>';
});

// ── Quick prompts ──
document.getElementById('quick-prompts').addEventListener('click', e => {
    const btn = e.target.closest('.quick-btn');
    if (btn) send(btn.dataset.q);
});

// ── Send button ──
sendBtn.addEventListener('click', () => send());

// ── Enter to send (Shift+Enter = newline) ──
input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
    }
});

// ── Auto-resize textarea ──
input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

// ── Welcome ──
addSysMsg('Agent loaded. Select a niche from the dropdown to focus the conversation, or ask a general question.');
