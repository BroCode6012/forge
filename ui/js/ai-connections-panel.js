// ui/js/ai-connections-panel.js
// ============================================================================
// AI settings > AI Connections. Three job pickers (Thinking / Everyday / Eyes),
// the list of saved connections, and the add/edit form with a Test button.
//
// Everything shown comes from the main process (ai-connections-get). Keys only
// travel one way: typed into the form, sent to main, encrypted there. The panel
// never receives one back — a saved connection just says "key saved".
// All text is set with textContent; nothing from a server or a user is parsed
// as HTML.
// ============================================================================
(() => {
    'use strict';

    const ui = {};
    let view = null;
    let editingId = null;

    const byId = (id) => document.getElementById(id);
    const api = () => window.electronAPI;

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === 'text') node.textContent = value;
            else if (key === 'style') node.setAttribute('style', value);
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value);
        }
        for (const child of children) if (child) node.appendChild(child);
        return node;
    }

    function status(text, tone = 'info') {
        if (!ui.status) return;
        ui.status.textContent = text || '';
        ui.status.style.color = tone === 'error' ? '#f87171' : tone === 'ok' ? '#4ade80' : '';
    }

    function connectionName(id) {
        if (!id || id === view.meta.builtIn) return 'Built-in setup';
        return view.connections.find((c) => c.id === id)?.label || 'Built-in setup';
    }

    // ── jobs ────────────────────────────────────────────────────────────────
    function jobSelect(job, slot) {
        const select = el('select', { 'data-job': job.id, 'data-slot': slot, style: 'flex:1;min-width:0' });
        const current = view.jobs[job.id]?.[slot] || '';
        const options = slot === 'primary'
            ? [['', 'Built-in setup (AI Provider below)']]
            : [['', 'No backup'], [view.meta.builtIn, 'Built-in setup (AI Provider below)']];
        for (const conn of view.connections) {
            const usable = !job.vision || conn.visionModel || conn.canSee;
            options.push([conn.id, usable ? conn.label : `${conn.label} — cannot see images yet`]);
        }
        for (const [value, label] of options) {
            const option = el('option', { value, text: label });
            if (value === current || (value === '' && !current)) option.selected = true;
            select.appendChild(option);
        }
        select.addEventListener('change', async () => {
            const response = await api().aiConnectionsSave({ action: 'jobs', jobs: { [job.id]: { [slot]: select.value } } });
            if (!response.ok) status((response.problems || ['could not save']).join('; '), 'error');
            else status(`${job.label} → ${connectionName(select.value)}`, 'ok');
            render(response.view);
        });
        return select;
    }

    function renderJobs() {
        ui.jobs.replaceChildren();
        for (const job of view.meta.jobs) {
            const row = el('div', { style: 'margin-bottom:8px' }, [
                el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:6px' }, [
                    el('strong', { text: job.label, style: 'font-size:12px' }),
                ]),
                el('small', { class: 'ai-instructions-hint', text: job.hint }),
                el('div', { style: 'display:flex;gap:6px;margin-top:4px;align-items:center' }, [
                    jobSelect(job, 'primary'),
                    el('span', { text: 'backup', style: 'font-size:10px;opacity:0.7' }),
                    jobSelect(job, 'backup'),
                ]),
            ]);
            ui.jobs.appendChild(row);
        }
    }

    // ── saved connections ───────────────────────────────────────────────────
    function renderList() {
        ui.list.replaceChildren();
        if (!view.connections.length) {
            ui.list.appendChild(el('small', { class: 'ai-instructions-hint', text: 'No connections yet.' }));
            return;
        }
        for (const conn of view.connections) {
            const test = conn.lastTest;
            const badge = !test ? 'not tested yet' : test.ok ? `✅ worked ${new Date(test.at).toLocaleString()}` : `❌ failed ${new Date(test.at).toLocaleString()}`;
            const sees = conn.visionModel ? `sees images with ${conn.visionModel}` : conn.canSee ? 'sees images' : 'text only (not confirmed to see images)';
            const card = el('div', { style: 'padding:6px 8px;border:1px solid #2f2f2f;border-radius:6px;margin-bottom:6px' }, [
                el('div', { style: 'display:flex;justify-content:space-between;gap:6px' }, [
                    el('strong', { text: conn.label, style: 'font-size:12px' }),
                    el('span', { text: badge, style: 'font-size:10px;opacity:0.8' }),
                ]),
                el('small', { class: 'ai-instructions-hint', text: `${conn.baseUrl} · ${conn.textModel || conn.visionModel} · ${sees} · key ${conn.hasKey ? `saved (${conn.keyProtection})` : 'none'}` }),
                el('div', { style: 'display:flex;gap:6px;margin-top:4px' }, [
                    el('button', { class: 'btn-small', text: 'Test', style: 'padding:2px 8px;font-size:10px', onclick: () => runTest({ id: conn.id }, true) }),
                    el('button', { class: 'btn-small', text: 'Edit', style: 'padding:2px 8px;font-size:10px', onclick: () => openForm(conn) }),
                    el('button', { class: 'btn-small', text: 'Delete', style: 'padding:2px 8px;font-size:10px', onclick: () => removeConnection(conn) }),
                ]),
            ]);
            ui.list.appendChild(card);
        }
    }

    // ── form ────────────────────────────────────────────────────────────────
    function fillPresets() {
        ui.preset.replaceChildren();
        for (const preset of view.meta.presets) ui.preset.appendChild(el('option', { value: preset.id, text: preset.label }));
    }

    function applyPreset(presetId, { keepUrl = false } = {}) {
        const preset = view.meta.presets.find((p) => p.id === presetId) || view.meta.presets[view.meta.presets.length - 1];
        ui.presetNote.textContent = preset.note || '';
        ui.auth.value = preset.auth;
        if (!keepUrl) {
            ui.url.value = '';
            ui.url.placeholder = preset.baseUrl || 'https://…/v1';
        }
        ui.key.placeholder = preset.needsKey ? 'paste the key' : 'no key needed';
    }

    function openForm(conn = null) {
        editingId = conn ? conn.id : null;
        ui.form.classList.remove('hidden');
        ui.testResult.replaceChildren();
        ui.preset.value = conn ? conn.preset : view.meta.presets[0].id;
        applyPreset(ui.preset.value, { keepUrl: !!conn });
        ui.label.value = conn ? conn.label : '';
        ui.url.value = conn ? conn.baseUrl : '';
        ui.key.value = '';
        if (conn) ui.key.placeholder = conn.hasKey ? 'key saved — leave empty to keep it' : 'paste the key';
        ui.model.value = conn ? conn.textModel : '';
        ui.visionModel.value = conn ? conn.visionModel : '';
        ui.auth.value = conn ? conn.auth : ui.auth.value;
        ui.concurrency.value = conn ? conn.maxConcurrency : 8;
        ui.label.focus();
    }

    function closeForm() {
        editingId = null;
        ui.form.classList.add('hidden');
        ui.key.value = '';
    }

    function formValues() {
        return {
            id: editingId || undefined,
            preset: ui.preset.value,
            label: ui.label.value.trim(),
            baseUrl: ui.url.value.trim(),
            apiKey: ui.key.value,
            textModel: ui.model.value.trim(),
            visionModel: ui.visionModel.value.trim(),
            auth: ui.auth.value,
            maxConcurrency: Number(ui.concurrency.value) || 8,
        };
    }

    function showTest(result, problems) {
        ui.testResult.replaceChildren();
        if (problems && problems.length) {
            ui.testResult.appendChild(el('small', { style: 'color:#f87171', text: `Fix first: ${problems.join('; ')}` }));
            return;
        }
        for (const step of result.steps || []) {
            ui.testResult.appendChild(el('div', { style: 'font-size:11px;margin-top:2px' }, [
                el('span', { text: `${step.ok ? '✅' : '❌'} ${step.name}: ` }),
                el('span', { text: `${step.detail}${Number.isFinite(step.ms) ? ` (${(step.ms / 1000).toFixed(1)}s)` : ''}`, style: 'opacity:0.85' }),
            ]));
        }
        ui.testResult.appendChild(el('div', {
            style: `font-size:11px;margin-top:4px;font-weight:600;color:${result.ok ? '#4ade80' : '#f87171'}`,
            text: result.ok
                ? `Ready to use${result.canSee ? ' — it can do Thinking, Everyday and Eyes' : ' — for Thinking and Everyday (it did not pass the picture test)'}.`
                : 'Not usable yet — see the steps above.',
        }));
    }

    async function runTest(connection, fromList = false) {
        status('Testing… (a cold server can take a minute to wake up)');
        if (!fromList) ui.testResult.replaceChildren(el('small', { class: 'ai-instructions-hint', text: 'Testing…' }));
        try {
            const response = await api().aiConnectionsTest({ connection });
            if (!fromList) showTest(response.result || {}, response.problems);
            if (response.view) render(response.view);
            const ok = response.ok && response.result?.ok;
            status(ok ? 'Test passed.' : `Test failed${response.problems ? `: ${response.problems.join('; ')}` : ' — open Edit to see each step.'}`, ok ? 'ok' : 'error');
            if (fromList && response.result) {
                const conn = view.connections.find((c) => c.id === connection.id);
                if (conn) {
                    openForm(conn);
                    showTest(response.result);
                }
            }
        } catch (error) {
            status(`Test could not run: ${error.message}`, 'error');
        }
    }

    async function save() {
        const response = await api().aiConnectionsSave({ action: 'save', connection: formValues() });
        if (!response.ok) {
            status(`Not saved: ${(response.problems || ['unknown problem']).join('; ')}`, 'error');
            return;
        }
        render(response.view);
        closeForm();
        status('Saved. Press Test on it, then choose it for a job above.', 'ok');
    }

    async function removeConnection(conn) {
        if (!confirm(`Delete "${conn.label}"? Jobs using it go back to the built-in setup.`)) return;
        const response = await api().aiConnectionsSave({ action: 'delete', id: conn.id });
        render(response.view);
        status(response.ok ? `Deleted "${conn.label}".` : 'Could not delete it.', response.ok ? 'ok' : 'error');
    }

    function render(next) {
        if (next) view = next;
        if (!view) return;
        renderJobs();
        renderList();
    }

    async function init() {
        ui.group = byId('ai-connections-group');
        if (!ui.group || !api()?.aiConnectionsGet) return;
        ui.jobs = byId('ai-connections-jobs');
        ui.list = byId('ai-connections-list');
        ui.form = byId('ai-connections-form');
        ui.status = byId('ai-connections-status');
        ui.preset = byId('ai-conn-preset');
        ui.presetNote = byId('ai-conn-preset-note');
        ui.label = byId('ai-conn-label');
        ui.url = byId('ai-conn-url');
        ui.key = byId('ai-conn-key');
        ui.model = byId('ai-conn-model');
        ui.visionModel = byId('ai-conn-vision-model');
        ui.auth = byId('ai-conn-auth');
        ui.concurrency = byId('ai-conn-concurrency');
        ui.testResult = byId('ai-conn-test-result');

        try {
            view = await api().aiConnectionsGet();
        } catch (error) {
            status(`Could not load AI connections: ${error.message}`, 'error');
            return;
        }
        fillPresets();
        render();
        if (!view.meta.encryption) status('Note: this PC cannot encrypt saved keys, so they are stored unencrypted in your user folder.');

        ui.preset.addEventListener('change', () => applyPreset(ui.preset.value));
        byId('ai-connections-add')?.addEventListener('click', () => openForm(null));
        byId('ai-conn-cancel')?.addEventListener('click', closeForm);
        byId('ai-conn-save')?.addEventListener('click', save);
        byId('ai-conn-test')?.addEventListener('click', () => runTest(formValues()));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
