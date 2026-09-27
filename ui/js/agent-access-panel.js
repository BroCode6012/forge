// ui/js/agent-access-panel.js
// ============================================================================
// The switch and the credentials for agent remote control (AI settings > Agent
// access). Everything it shows comes from the main process
// (remote-access-status); this file never invents an address or a key.
// ============================================================================
(() => {
    'use strict';

    const ui = {};
    let current = null;
    let keyVisible = false;

    const byId = (id) => document.getElementById(id);

    function setStatusLine(text) {
        if (ui.status) ui.status.textContent = text;
    }

    function render(status) {
        current = status || null;
        if (!current) return;
        if (ui.toggle) {
            ui.toggle.checked = !!current.enabled;
            ui.toggle.disabled = !!current.forcedByEnv;
        }
        ui.details?.classList.toggle('hidden', !current.enabled);
        if (ui.url) ui.url.value = current.mcpUrl || '';
        if (ui.key) {
            ui.key.value = current.token || '';
            ui.key.type = keyVisible ? 'text' : 'password';
        }
        if (ui.showKey) ui.showKey.textContent = keyVisible ? 'Hide key' : 'Show key';
        if (current.error) {
            setStatusLine(`⚠️ ${current.error}`);
        } else if (current.enabled && current.running) {
            setStatusLine(`● Listening on ${current.baseUrl} — MCP at /mcp, REST at /api/tools, schema at /openapi.json. Keep this window open while an agent is working.`);
        } else if (current.enabled) {
            setStatusLine('Starting…');
        } else {
            setStatusLine('Off.');
        }
    }

    async function refresh() {
        try {
            render(await window.electronAPI.remoteAccessStatus());
        } catch (error) {
            setStatusLine(`Could not read agent access: ${error.message}`);
        }
    }

    async function push(payload) {
        try {
            const response = await window.electronAPI.remoteAccessSet(payload);
            render(response?.status);
            if (response?.error) showToast(`Agent access: ${response.error}`, 'error');
        } catch (error) {
            showToast(`Agent access: ${error.message}`, 'error');
        }
    }

    async function copy(text, label) {
        if (!text) return;
        try {
            await window.electronAPI.writeClipboardText(text);
            showToast(`${label} copied`, 'success');
        } catch (error) {
            showToast(`Could not copy: ${error.message}`, 'error');
        }
    }

    function init() {
        ui.group = byId('agent-access-group');
        if (!ui.group || !window.electronAPI?.remoteAccessStatus) return;
        ui.toggle = byId('agent-access-toggle');
        ui.details = byId('agent-access-details');
        ui.url = byId('agent-access-url');
        ui.key = byId('agent-access-key');
        ui.status = byId('agent-access-status');
        ui.showKey = byId('agent-access-show-key');

        ui.toggle?.addEventListener('change', () => push({ enabled: !!ui.toggle.checked }));
        byId('agent-access-copy-url')?.addEventListener('click', () => copy(current?.mcpUrl, 'Address'));
        byId('agent-access-copy-key')?.addEventListener('click', () => copy(current?.token, 'Access key'));
        ui.showKey?.addEventListener('click', () => {
            keyVisible = !keyVisible;
            render(current);
        });
        byId('agent-access-copy-command')?.addEventListener('click', () => {
            if (!current?.mcpUrl) return;
            copy(
                `claude mcp add --transport http forge ${current.mcpUrl} --header "Authorization: Bearer ${current.token}"`,
                'Claude Code command'
            );
        });
        byId('agent-access-rotate')?.addEventListener('click', () => {
            if (!confirm('Create a new access key? Agents using the old key stop working until you give them the new one.')) return;
            push({ rotateToken: true });
        });

        refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
