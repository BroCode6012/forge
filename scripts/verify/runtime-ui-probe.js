// scripts/verify/runtime-ui-probe.js
// Attaches to the LIVE Electron renderer over CDP (DevTools :9223) and verifies the
// P2 settings schema + tabbed settings UI at runtime: schema/SettingsIO loaded, all
// tabs + panels present, exactly one active, a real tab-switch works, workspace
// indicator, and no leaked deprecated/special controls. Read-only except one click.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BROWSER_WS = process.argv[2];
if (!BROWSER_WS) { console.error('usage: node runtime-ui-probe.js <browserWsEndpoint>'); process.exit(2); }
// Remember the last step announced, so a watchdog kill names where it died.
// Without it the only output is "exceeded N seconds" — no failing check, no
// step, nothing to act on, which is the least useful thing a gate can say.
let lastStep = 'startup';
const baseLog = console.log.bind(console);
console.log = (...args) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('[ui-probe] ')) lastStep = first.slice('[ui-probe] '.length);
  baseLog(...args);
};
// A hang guard, not a performance budget. Every individual step already carries
// its own timeout, so this only has to stop a wedged run from hanging the suite
// forever. It sat at 140s while this probe grew to drive ~10 live Editor Agent
// round-trips, so a slow model reply killed the whole report — every check lost
// to something that was not a defect. It stays under the harness's own 240s cap
// so the probe is still the one that gets to explain itself.
const watchdog = setTimeout(() => {
  console.error(`PROBE ERROR runtime UI probe exceeded 210 seconds (last step: ${lastStep})`);
  process.exit(4);
}, 210_000);
const withTimeout = (promise, label, ms = 15_000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
]);
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// `accept` lets a caller keep reading until the preview clock has actually been
// driven. The first successful read is not automatically an answer: a preview
// frame that has just been attached reports 0 because nothing has driven it yet,
// which is indistinguishable from a preview that is stuck — and taking that
// first sample failed a playback that was working. Whatever the deadline
// produces is still returned, so a genuinely stuck preview keeps failing.
async function readHyperframesPreviewTime(page, timeoutMs = 5_000, accept = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let last = 0;
  while (Date.now() < deadline) {
    const frame = page.frames().filter(candidate => candidate.url().startsWith('hf-preview://project/')).at(-1);
    if (frame) {
      try {
        last = await frame.evaluate(() => Number(
          document.getElementById('yta-hyperframes')?.dataset.previewTime || 0
        ));
        if (!accept || accept(last)) return last;
      } catch (error) {
        lastError = error;
      }
    }
    await wait(100);
  }
  if (lastError && !last) throw lastError;
  return last;
}

async function readHyperframesSceneVisual(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const frame = page.frames().filter(candidate => candidate.url().startsWith('hf-preview://project/')).at(-1);
    if (frame) {
      try {
        last = await frame.evaluate(() => {
          const root = document.getElementById('yta-hyperframes');
          const scene = document.querySelector('.hf-scene');
          const frameEl = scene?.querySelector('.hf-scene-frame');
          const media = scene?.querySelector('.hf-scene-media');
          const graphics = [...document.querySelectorAll('.hf-mg')];
          const lowerThird = document.querySelector('.hf-type-lower-third');
          const styledLowerThirdRange = lowerThird?.querySelector('.hf-agentic-text-range');
          const headline = document.querySelector('.hf-type-headline');
          const headlineTitle = headline?.querySelector('.hf-agentic-title, .hf-title');
          const headlineCard = headline?.querySelector('.hf-agentic-copy, .hf-copy-shell');
          const headlineAccentRule = headline?.querySelector('.hf-agentic-rule');
          const headlineWordCascadeWords = [
            ...(headline?.querySelectorAll('.hf-agentic-word-cascade .hf-agentic-word') || []),
          ];
          const sceneIcon = scene?.querySelector('.hf-scene-icon');
          return {
            sceneCount: document.querySelectorAll('.hf-scene').length,
            backdropCount: scene?.querySelectorAll('.hf-scene-floatbg').length || 0,
            grainCount: scene?.querySelectorAll('.hf-fx-grain').length || 0,
            vignetteCount: scene?.querySelectorAll('.hf-fx-vig').length || 0,
            fogCount: scene?.querySelectorAll('.hf-fx-foga, .hf-fx-fogb').length || 0,
            scratchCount: scene?.querySelectorAll('.hf-fx-scratch').length || 0,
            lowerThirdText: lowerThird?.textContent?.replace(/\s+/g, ' ').trim() || '',
            lowerThirdStyle: lowerThird?.dataset?.hfStyle || '',
            lowerThirdVariant: lowerThird?.dataset?.hfVariant || '',
            lowerThirdStyledText: styledLowerThirdRange?.textContent?.replace(/\s+/g, ' ').trim() || '',
            lowerThirdStyledColor: styledLowerThirdRange
              ? getComputedStyle(styledLowerThirdRange).color
              : '',
            lowerThirdStyledColorToken: styledLowerThirdRange?.dataset?.hfTextRangeColor || '',
            headlineText: headlineTitle?.textContent?.replace(/\s+/g, ' ').trim() || '',
            headlineColor: headlineTitle ? getComputedStyle(headlineTitle).color : '',
            headlineBackground: headlineCard ? getComputedStyle(headlineCard).backgroundColor : '',
            headlineClass: headline?.className || '',
            headlineVariant: headline?.dataset?.hfVariant || '',
            headlineAnimation: headline?.dataset?.hfAnimation || '',
            headlineWordCascadeCount: headlineWordCascadeWords.length,
            headlineWordCascadeOpacities: headlineWordCascadeWords.map((word) => (
              Number.parseFloat(getComputedStyle(word).opacity)
            )),
            headlineWordCascadeTransforms: headlineWordCascadeWords.map((word) => (
              getComputedStyle(word).transform
            )),
            headlineAccentRuleDisplay: headlineAccentRule
              ? getComputedStyle(headlineAccentRule).display
              : '',
            sceneIconCount: scene?.querySelectorAll('.hf-scene-icon').length || 0,
            sceneIconColor: sceneIcon ? getComputedStyle(sceneIcon).color : '',
            sceneIconWidth: sceneIcon ? Number.parseFloat(getComputedStyle(sceneIcon).width) : 0,
            sceneIconClass: sceneIcon?.className || '',
            graphicCount: graphics.length,
            visibleGraphicCount: graphics.filter((graphic) => Number(getComputedStyle(graphic).opacity) > 0.01).length,
            // Motion transitions animate scene containers directly and therefore
            // intentionally have no .hf-transition overlay element.
            transitionCount: Number(root?.dataset.visibleTransitionCount || 0),
            motionTransitionCount: Number(root?.dataset.motionTransitionCount || 0),
            overlayTransitionCount: Number(root?.dataset.overlayTransitionCount || 0),
            frameTransform: frameEl ? getComputedStyle(frameEl).transform : null,
            mediaObjectFit: media ? getComputedStyle(media).objectFit : null,
            mediaSrc: media?.getAttribute('src') || null,
            mediaWidth: Number(media?.naturalWidth || media?.videoWidth || 0),
            mediaHeight: Number(media?.naturalHeight || media?.videoHeight || 0),
          };
        });
        if (last?.sceneCount) return last;
      } catch (_) { }
    }
    await wait(120);
  }
  return last;
}

async function waitForHyperframesVisual(page, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readHyperframesSceneVisual(page, 1_000);
    if (last && accept(last)) return last;
    await wait(180);
  }
  return last;
}

async function planAndApplyAgent(page, text, label) {
  await withTimeout(page.waitForFunction(() => (
    document.getElementById('agent-input')?.disabled === false
      && document.getElementById('agent-send')?.disabled === false
  ), { timeout: 15_000 }), `${label} composer ready`, 20_000);
  await withTimeout(page.evaluate((request) => {
    const input = document.getElementById('agent-input');
    input.value = request;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('agent-send')?.click();
  }, text), `${label} request`);
  try {
    await withTimeout(page.waitForFunction(() => (
      !!document.querySelector('.agent-plan-card')
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), `${label} plan`, 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      sendDisabled: document.getElementById('agent-send')?.disabled === true,
      inputValue: document.getElementById('agent-input')?.value || '',
      scope: document.getElementById('agent-scope-chip')?.textContent?.trim() || '',
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-plan-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
    })).catch(() => null);
    throw new Error(`${label} plan timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const requestError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (requestError) throw new Error(`${label} planning failed: ${requestError}`);
  const planText = await page.$eval('.agent-plan-card', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  await withTimeout(page.evaluate(() => {
    const button = document.querySelector('.agent-plan-card .agent-plan-actions .primary');
    if (!button) {
      const card = document.querySelector('.agent-plan-card');
      throw new Error(`Agent returned a non-executable plan: ${card?.textContent?.replace(/\s+/g, ' ').trim() || 'unknown plan'}`);
    }
    button.click();
  }), `${label} apply`);
  await withTimeout(page.waitForFunction(() => (
    (
      !document.querySelector('.agent-plan-card')
        && document.getElementById('agent-input')?.disabled === false
    )
      || !!document.querySelector('.agent-message.error')
  ), { timeout: 40_000 }), `${label} completion`, 45_000);
  const applyError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (applyError) {
    const diagnostic = await page.evaluate(async () => ({
      scope: window.EditorAgentHost?.getScopeSnapshot?.() || null,
      session: await window.electronAPI?.agentSession?.(),
      transitions: state.videoPlan?.transitions || [],
      sceneTransitions: (state.videoPlan?.scenes || []).map((scene) => ({
        clipId: scene?.clipId || '',
        transition: scene?.transition || null,
        transitionType: scene?.transitionType || '',
        transitionIn: scene?.transitionIn || '',
      })),
    })).catch(() => null);
    throw new Error(`${label} apply failed: ${applyError}; diagnostic=${JSON.stringify(diagnostic)}`);
  }
  return planText;
}

async function waitForPageState(page, evaluator, {
  label = 'page state',
  timeoutMs = 30_000,
  argument = undefined,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(evaluator, argument)) return;
    } catch (error) {
      lastError = error;
    }
    await wait(120);
  }
  throw lastError || new Error(`${label} timed out`);
}

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS, defaultViewport: null, protocolTimeout: 30_000 });
  let page = null;
  const pageDeadline = Date.now() + 20_000;
  while (!page && Date.now() < pageDeadline) {
    const pages = await withTimeout(browser.pages(), 'browser.pages');
    const matches = pages.filter(p => !p.isClosed() && /ui\/index\.html/i.test(p.url()));
    page = matches[matches.length - 1] || null;
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!page) { console.error('renderer page not found'); process.exit(2); }
  page.setDefaultTimeout(10_000);
  await withTimeout(page.waitForSelector('.settings-tabs .stab-btn', { timeout: 20_000 }), 'renderer readiness', 25_000);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const readyPages = await withTimeout(browser.pages(), 'ready browser.pages');
  const readyMatches = readyPages.filter(p => !p.isClosed() && /ui\/index\.html/i.test(p.url()));
  page = readyMatches[readyMatches.length - 1] || page;
  page.setDefaultTimeout(10_000);
  // Ready means "app.js finished and the project is loaded", not "the markup
  // parsed". The tab buttons waited for above live in index.html, so they exist
  // before app.js has built anything — the fixed sleep after them covered the
  // gap on a warm machine and intermittently did not on a cold one. The first
  // check to touch the app's state then died with a bare "state is not defined"
  // that named no step and looked like a product fault.
  await waitForPageState(page, () => (
    typeof state === 'object'
      && state !== null
      && Array.isArray(state.videoPlan?.scenes)
      && state.videoPlan.scenes.length > 0
  ), { label: 'renderer app state', timeoutMs: 25_000 });

  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

  // 1. Core renderer globals loaded (proves schema.js + settings-io.js loaded before app.js)
  console.log('[ui-probe] globals');
  const globals = await withTimeout(page.evaluate(() => ({
    schema: typeof window.SETTINGS_SCHEMA === 'object' && Array.isArray(window.SETTINGS_SCHEMA.SETTINGS),
    schemaCount: window.SETTINGS_SCHEMA ? window.SETTINGS_SCHEMA.SETTINGS.length : 0,
    settingsIO: !!(window.SettingsIO && typeof window.SettingsIO.collect === 'function' && typeof window.SettingsIO.apply === 'function'),
    appLoaded: document.readyState === 'complete'
      && typeof window.electronAPI?.loadProjectFile === 'function'
      && document.querySelectorAll('.settings-tabs .stab-btn').length === 5,
  })), 'globals');
  check('SETTINGS_SCHEMA loaded', globals.schema, `${globals.schemaCount} settings`);
  check('SettingsIO loaded (collect+apply)', globals.settingsIO);
  check('app.js executed (window fns present)', globals.appLoaded);
  const liveCapabilities = await withTimeout(
    page.evaluate(() => window.electronAPI.agentCapabilities()),
    'live capability catalog'
  );
  check('Editor Agent publishes live versioned worker contracts',
    liveCapabilities?.success === true
      && liveCapabilities.contractVersion === 2
      && liveCapabilities.capabilityCount === 10
      && liveCapabilities.toolCount >= 60
      && liveCapabilities.capabilities.every((capability) => (
        capability.contractVersion === 2
          && capability.tools?.length === capability.actions?.length
          && /^[a-f0-9]{64}$/.test(capability.contractHash || '')
      )),
    JSON.stringify({
      contractVersion: liveCapabilities?.contractVersion,
      capabilityCount: liveCapabilities?.capabilityCount,
      toolCount: liveCapabilities?.toolCount,
    }));

  // 2. Tab bar + panels structure
  console.log('[ui-probe] tabs');
  const tabs = await withTimeout(page.evaluate(() => {
    const btns = [...document.querySelectorAll('.settings-tabs .stab-btn')].map(b => ({ id: b.dataset.stab, active: b.classList.contains('active'), label: (b.textContent || '').trim() }));
    const panels = [...document.querySelectorAll('.stab-panel')].map(p => ({ id: p.dataset.stab, active: p.classList.contains('active'), display: getComputedStyle(p).display }));
    return { btns, panels };
  }), 'tabs');
  check('5 tab buttons present', tabs.btns.length === 5, tabs.btns.map(b => b.id).join(','));
  check('5 tab panels present', tabs.panels.length === 5, tabs.panels.map(p => p.id).join(','));
  const activeBtns = tabs.btns.filter(b => b.active);
  check('exactly one tab active', activeBtns.length === 1, activeBtns.map(b => b.id).join(','));
  const visiblePanels = tabs.panels.filter(p => p.display !== 'none');
  check('exactly one panel visible', visiblePanels.length === 1, visiblePanels.map(p => p.id).join(','));
  check('active btn matches visible panel', activeBtns[0] && visiblePanels[0] && activeBtns[0].id === visiblePanels[0].id, `${activeBtns[0]?.id} vs ${visiblePanels[0]?.id}`);

  // 3. Every panel referenced by a button, and vice-versa (no orphans)
  const btnIds = new Set(tabs.btns.map(b => b.id));
  const panelIds = new Set(tabs.panels.map(p => p.id));
  const orphanBtns = [...btnIds].filter(id => !panelIds.has(id));
  const orphanPanels = [...panelIds].filter(id => !btnIds.has(id));
  check('no orphan tabs/panels', orphanBtns.length === 0 && orphanPanels.length === 0, `orphanBtns=${orphanBtns} orphanPanels=${orphanPanels}`);

  // 3b. Fully-tabbed: no settings .panel-section may sit OUTSIDE a .stab-panel in the
  // left panel. Only the top Import Audio importer and the bottom action buttons are
  // allowed outside the tabs — everything else must live in a tab (no leftover scroll).
  console.log('[ui-probe] layout');
  const stray = await withTimeout(page.evaluate(() => {
    const panel = document.getElementById('left-panel');
    if (!panel) return { err: 'no #left-panel' };
    const out = [];
    for (const sec of panel.querySelectorAll(':scope > .panel-section')) {
      // The tab container itself is a .panel-section — it's SUPPOSED to be a direct child.
      if (sec.classList.contains('settings-tabbed')) continue;
      // A section is "settings" if it holds a control the user can actually see
      // and touch. The narration dropzone owns a hidden <input type="file"> that
      // the whole card acts as the click target for — machinery, not a setting.
      //
      // This used to be an allowlist on the heading text ("Import Audio"), so
      // renaming that heading to "Import narration" reported the importer as a
      // stray settings section and failed a layout that had not moved a pixel.
      // A gate pinned to a human-facing label breaks on copy edits and says
      // nothing about the thing it exists to protect. Visibility is the real
      // question, and it keeps the gate honest the other way too: drop a live
      // dropdown into that card tomorrow and it is flagged, heading or no.
      const hasControls = Array.from(sec.querySelectorAll('input,select,textarea'))
        .some((el) => el.getClientRects().length > 0);
      const h3 = (sec.querySelector('h3')?.textContent || '').trim();
      if (hasControls) out.push(h3 || sec.className);
    }
    return { stray: out };
  }), 'layout');
  check('fully tabbed (no settings section outside tabs)', stray.stray && stray.stray.length === 0, stray.err || (stray.stray.length ? 'stray: ' + stray.stray.join(' | ') : 'none'));

  // 4. Real interaction: click a non-active tab and confirm the switch
  const target = tabs.btns.find(b => !b.active);
  let switchOk = false, switchDetail = '';
  if (target) {
    console.log('[ui-probe] interaction');
    await withTimeout(page.evaluate((targetId) => {
      const button = document.querySelector(`.stab-btn[data-stab="${targetId}"]`);
      if (!button) throw new Error(`tab button not found: ${targetId}`);
      button.click();
    }, target.id), 'tab click');
    await new Promise(r => setTimeout(r, 150));
    const after = await withTimeout(page.evaluate((tid) => {
      const btn = document.querySelector(`.stab-btn[data-stab="${tid}"]`);
      const panel = document.querySelector(`.stab-panel[data-stab="${tid}"]`);
      const activeBtnCount = document.querySelectorAll('.settings-tabs .stab-btn.active').length;
      const visPanels = [...document.querySelectorAll('.stab-panel')].filter(p => getComputedStyle(p).display !== 'none').length;
      return { btnActive: btn?.classList.contains('active'), panelVisible: panel && getComputedStyle(panel).display !== 'none', activeBtnCount, visPanels };
    }, target.id), 'tab state');
    switchOk = after.btnActive && after.panelVisible && after.activeBtnCount === 1 && after.visPanels === 1;
    switchDetail = `clicked=${target.id} active=${after.btnActive} visible=${after.panelVisible} activeCount=${after.activeBtnCount} visCount=${after.visPanels}`;
  }
  check('tab switch works (click → single active/visible)', switchOk, switchDetail);

  // 5. All schema element-settings actually exist in the DOM (schema ↔ HTML parity)
  console.log('[ui-probe] schema parity');
  const domParity = await withTimeout(page.evaluate(() => {
    const S = window.SETTINGS_SCHEMA.SETTINGS;
    const missing = [];
    // Deprecated controls are intentionally pruned from the DOM — only live ones must exist.
    for (const s of S) { if (s.el && !s.deprecated && !document.getElementById(s.el)) missing.push(s.key + '#' + s.el); }
    return { missing };
  }), 'schema parity');
  check('all schema-backed controls exist in DOM', domParity.missing.length === 0, domParity.missing.join(', ') || 'none missing');

  // 6. SettingsIO round-trip on the live DOM (collect → mutate → apply → collect)
  console.log('[ui-probe] settings collect');
  const roundTrip = await withTimeout(page.evaluate(() => {
    const before = window.SettingsIO.collect(null);
    const keys = Object.keys(before);
    return { keyCount: keys.length, sample: keys.slice(0, 6) };
  }), 'settings collect');
  check('SettingsIO.collect returns managed settings', roundTrip.keyCount > 0, `${roundTrip.keyCount} keys e.g. ${roundTrip.sample.join(',')}`);

  // 7. Agentic SFX owns the track: no manual settings, no fake music row,
  // and the editor preserves the build-authored cue and level.
  console.log('[ui-probe] sound surface');
  const soundSurface = await withTimeout(page.evaluate(() => ({
    noManualControls: !document.getElementById('sfx-enabled')
      && !document.getElementById('btn-download-sfx')
      && !document.getElementById('sfx-volume'),
    noFakeMusicTrack: !document.querySelector('[data-track="music-track"]'),
    exactBuildCue: state.sfxClips.length === 1
      && state.sfxClips[0].file === 'sfx-fade.mp3'
      && Math.abs(state.sfxClips[0].volume - 0.24) < 0.0001,
    sfxTrackReadOnly: !document.querySelector('[data-track="sfx-track"] .track-mute-btn'),
  })), 'sound surface');
  check('manual SFX controls removed', soundSurface.noManualControls);
  check('fake empty Music track removed', soundSurface.noFakeMusicTrack);
  check('editor preserves build-authored SFX cue and level', soundSurface.exactBuildCue);
  check('build-authored SFX track has no fake mute control', soundSurface.sfxTrackReadOnly);

  // 8. Production-mode matrix: controls, tabs, and source routing must match the
  // actual pipeline selected by each mode.
  console.log('[ui-probe] production modes');
  const modeMatrix = await withTimeout(page.evaluate(() => {
    const visible = (id) => {
      const el = document.getElementById(id);
      return !!el && getComputedStyle(el).display !== 'none';
    };
    const setMode = (value) => {
      const el = document.getElementById('build-production-mode');
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setMode('faceless');
    const faceless = {
      format: visible('format-group'),
      presenter: visible('presenter-image-row'),
      audioImporter: visible('audio-import-card'),
      generatorToggle: visible('veo-ai-video-enabled'),
      fallback: visible('fallback-media-settings'),
    };

    setMode('talkingHead');
    const talkingHead = {
      presenter: visible('presenter-image-row'),
      format: visible('format-group'),
    };

    setMode('faceless');
    return { faceless, talkingHead };
  }), 'production mode matrix');
  check('faceless shows B-roll controls only', modeMatrix.faceless.format
    && !modeMatrix.faceless.presenter
    && modeMatrix.faceless.generatorToggle
    && modeMatrix.faceless.fallback, JSON.stringify(modeMatrix.faceless));
  check('talking-head exposes presenter controls', modeMatrix.talkingHead.presenter
    && modeMatrix.talkingHead.format, JSON.stringify(modeMatrix.talkingHead));

  const sourceImporter = await withTimeout(page.evaluate(() => ({
    hasAudio: !!state.audioFile,
    dropDisplay: getComputedStyle(document.getElementById('drop-zone')).display,
    dropInlineDisplay: document.getElementById('drop-zone').style.display,
    cardHeight: document.getElementById('audio-import-card')?.getBoundingClientRect().height || 0,
  })), 'source importer');
  check('audio importer remains visible when no narration is loaded',
    sourceImporter.hasAudio || (sourceImporter.dropDisplay !== 'none' && sourceImporter.cardHeight > 90),
    JSON.stringify(sourceImporter));

  // Playback regression: selecting a non-zero ruler position must remain the
  // playback start. The old code let the narration element report currentTime=0
  // on its first frame while the seek was still pending, which reset the ruler.
  console.log('[ui-probe] nonzero playback');
  await withTimeout(page.waitForFunction(() => {
    const audio = document.getElementById('preview-audio');
    return !!audio?.src && audio.readyState >= 1 && Number(audio.duration) > 2;
  }, { timeout: 15_000 }), 'preview audio readiness', 18_000);
  await page.select('#renderer-select', 'hyperframes');
  try {
    const deadline = Date.now() + 50_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = await page.evaluate(() => (
        state.hyperframesPreview?.active === true
          && state.hyperframesPreview?.frameReady === true
      ));
      if (!ready) await wait(150);
    }
    if (!ready) throw new Error('HyperFrames preview readiness timed out');
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      state: state.hyperframesPreview,
      frameSrc: document.getElementById('hyperframes-preview-frame')?.getAttribute('src') || '',
      frameClasses: document.getElementById('hyperframes-preview-frame')?.className || '',
    }));
    console.error('[ui-probe] HyperFrames readiness diagnostic', JSON.stringify({
      ...diagnostic,
      childFrames: page.frames().map((frame) => frame.url()),
    }));
    throw error;
  }
  const requestedPlaybackTarget = Number(process.env.YTA_RUNTIME_PLAYBACK_TARGET);
  const playbackTarget = Number.isFinite(requestedPlaybackTarget) && requestedPlaybackTarget > 0
    ? requestedPlaybackTarget
    : 1.15;
  const playbackBefore = await withTimeout(page.evaluate(async (target) => {
    stopPlayback();
    await seekToTime(target);
    return {
      stateTime: state.currentTime,
      audioTime: elements.previewAudio.currentTime,
    };
  }, playbackTarget), 'nonzero seek');
  await page.keyboard.press('Space');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // Read the preview clock while it is still playing. Stopping is allowed to
  // park the preview back at its idle position, so reading afterwards measured
  // the stop rather than the play, and reported 0 for a playback whose every
  // other signal was correct.
  const previewTime = await withTimeout(
    readHyperframesPreviewTime(page, 5_000, (value) => value > playbackTarget),
    'HyperFrames playback time'
  );
  const playbackAfter = await withTimeout(page.evaluate(() => {
    const result = {
      stateTime: state.currentTime,
      audioTime: elements.previewAudio.currentTime,
      playing: state.isPlaying,
      starting: state.playbackStarting,
      playbackFrame: state.playbackAnimationFrame,
      lastPlaybackAgeMs: performance.now() - state.lastPlaybackTime,
    };
    stopPlayback();
    return result;
  }), 'nonzero playback state');
  check('HyperFrames Play preserves a selected nonzero timeline position',
    Math.abs(playbackBefore.stateTime - playbackTarget) < 0.08
      && playbackBefore.audioTime > playbackTarget - 0.2
      && playbackAfter.playing === true
      && playbackAfter.starting === false
      && playbackAfter.stateTime > playbackTarget + 0.15
      && playbackAfter.audioTime > playbackTarget + 0.1
      && previewTime > playbackTarget,
    JSON.stringify({ target: playbackTarget, before: playbackBefore, after: playbackAfter, previewTime }));

  const screenshotDir = String(process.env.YTA_UI_SCREENSHOT_DIR || '').trim();
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const captureMode = async (name, mode, scrollTarget, tabName = 'setup') => {
      await page.evaluate(({ mode, scrollTarget, tabName }) => {
        const modeSelect = document.getElementById('build-production-mode');
        modeSelect.value = mode;
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector(`.stab-btn[data-stab="${tabName}"]`)?.click();
        const left = document.getElementById('left-panel');
        if (left) left.scrollTop = 0;
        if (left && scrollTarget) {
          const target = document.getElementById(scrollTarget);
          if (target) left.scrollTop = Math.max(0, target.offsetTop - 12);
        }
      }, { mode, scrollTarget, tabName });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: false });
    };
    await captureMode('faceless', 'faceless');
    await captureMode('talking-head', 'talkingHead');
    await page.evaluate(() => {
      const modeSelect = document.getElementById('build-production-mode');
      modeSelect.value = 'faceless';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // 9. Workspace indicator
  console.log('[ui-probe] workspace');
  const ws = await withTimeout(page.evaluate(() => {
    const el = document.getElementById('project-name-label')
      || document.getElementById('project-name')
      || document.querySelector('[data-project-name]');
    const txt = document.body.innerText;
    return { projName: el ? el.textContent.trim() : null, hasNoProjectHint: /No project|click New Project/i.test(txt) };
  }), 'workspace');
  check('workspace/project indicator present', ws.hasNoProjectHint || !!ws.projName, `projName="${ws.projName}"`);

  // 10. Integrated Editor Agent: live selection scope, preview card, apply, and
  // transaction-safe undo all work in the real Electron renderer.
  console.log('[ui-probe] editor agent');
  const agentSurface = await withTimeout(page.evaluate(() => {
    selectClip(0);
    window.EditorAgentHost?.setScopeMode?.('selection');
    document.getElementById('btn-agent')?.click();
    return {
      agentButton: !!document.getElementById('btn-agent'),
      qaButtonsRemoved: !document.getElementById('btn-qa-studio') && !document.getElementById('btn-qa-chat'),
      paneVisible: getComputedStyle(document.getElementById('agent-pane')).display !== 'none',
      scope: document.getElementById('agent-scope-chip')?.textContent.trim(),
      scopeModeControl: !!document.getElementById('agent-scope-mode'),
    };
  }), 'editor agent surface');
  check('Editor Agent replaces QA Studio buttons and opens in the main dock',
    agentSurface.agentButton
      && agentSurface.qaButtonsRemoved
      && agentSurface.paneVisible
      && agentSurface.scopeModeControl
      && /selected clip/i.test(agentSurface.scope),
    JSON.stringify(agentSurface));
  const agentVisualContext = await withTimeout(
    page.evaluate(() => window.EditorAgentHost?.getVisualContext?.()),
    'Editor Agent exact playhead frame context'
  );
  check('Editor Agent can target the exact visible preview frame',
    agentVisualContext?.captureRequested === true
      && agentVisualContext?.renderer === 'hyperframes'
      && agentVisualContext?.rect?.width >= 64
      && agentVisualContext?.rect?.height >= 36,
    JSON.stringify(agentVisualContext));

  const composedSceneScope = await withTimeout(page.evaluate(() => {
    const select = document.getElementById('agent-scope-mode');
    select.value = 'scene';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const scope = window.EditorAgentHost?.getScopeSnapshot?.();
    return {
      selectedMode: select.value,
      scopeMode: scope?.scopeMode,
      label: scope?.label,
      clipIds: (scope?.clipRefs || []).map((ref) => ref.clipId),
      visualIds: (scope?.visualRefs || []).map((ref) => ref.id),
      iconIds: (scope?.iconRefs || []).map((ref) => ref.id),
    };
  }), 'whole scene Agent scope');
  check('Whole scene scope includes footage, overlapping graphics, and embedded icons',
    composedSceneScope.selectedMode === 'scene'
      && composedSceneScope.scopeMode === 'scene'
      && composedSceneScope.clipIds.includes('runtime-scene-0')
      && composedSceneScope.visualIds.includes('runtime-lower-third')
      && composedSceneScope.iconIds.includes('runtime-scene-0:icon:0'),
    JSON.stringify(composedSceneScope));

  const sceneIconPlanText = await planAndApplyAgent(
    page,
    'Make the scene icon red and move it to the top left',
    'whole-scene icon edit'
  );
  await waitForPageState(page, () => {
    const icon = state.videoPlan?.scenes?.[0]?._iconMoments?.[0];
    return icon?.color === '#ef4444' && icon?.position === 'top-left';
  }, {
    label: 'whole-scene icon state',
    timeoutMs: 30_000,
  });
  await page.evaluate(async () => {
    await seekToTime(0.6);
  });
  const sceneIconVisual = await waitForHyperframesVisual(page, (visual) => (
    visual.sceneIconCount === 1
      && visual.sceneIconColor === 'rgb(239, 68, 68)'
      && /hf-icon-pos-top-left/.test(visual.sceneIconClass)
  ));
  check('Whole scene Agent edits the real rendered scene icon without touching other layers',
    /Scene Icon Editor/i.test(sceneIconPlanText)
      && !/Framing Editor/i.test(sceneIconPlanText)
      && !/Motion Graphics Editor/i.test(sceneIconPlanText)
      && sceneIconVisual?.sceneIconCount === 1
      && sceneIconVisual.sceneIconColor === 'rgb(239, 68, 68)'
      && /hf-icon-pos-top-left/.test(sceneIconVisual.sceneIconClass),
    JSON.stringify({ plan: sceneIconPlanText, visual: sceneIconVisual }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'whole-scene icon undo');
  await waitForPageState(page, () => {
    const icon = state.videoPlan?.scenes?.[0]?._iconMoments?.[0];
    return !icon?.color && icon?.position === 'top-right';
  }, {
    label: 'whole-scene icon undo state',
    timeoutMs: 30_000,
  });

  await withTimeout(page.evaluate(() => {
    const select = document.getElementById('agent-scope-mode');
    select.value = 'selection';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }), 'restore selection Agent scope');

  await withTimeout(page.evaluate(() => {
    const input = document.getElementById('agent-input');
    input.value = 'Make this selection fullscreen';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('agent-send')?.click();
  }), 'editor agent request');
  try {
    await withTimeout(page.waitForFunction(() => (
      !!document.querySelector('.agent-plan-card .agent-plan-actions .primary')
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 20_000 }), 'editor agent plan card', 25_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      sendDisabled: document.getElementById('agent-send')?.disabled === true,
      inputValue: document.getElementById('agent-input')?.value || '',
      scope: document.getElementById('agent-scope-chip')?.textContent?.trim() || '',
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-plan-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
      hasAgentPlanApi: typeof window.electronAPI?.agentPlan === 'function',
    })).catch(() => null);
    throw new Error(`Editor Agent plan card timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const agentRequestError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (agentRequestError) {
    throw new Error(`Editor Agent planning failed: ${agentRequestError}`);
  }
  console.log('[ui-probe] editor agent plan ready');
  const planCardText = await page.$eval('.agent-plan-card', (el) => el.textContent);
  check('Editor Agent shows an explicit plan before editing',
    /Proposed edit/i.test(planCardText) && /fullscreen/i.test(planCardText),
    planCardText.replace(/\s+/g, ' ').trim());

  await withTimeout(page.evaluate(() => {
    const button = document.querySelector('.agent-plan-card .agent-plan-actions .primary');
    if (!button) throw new Error('Agent Apply button disappeared');
    button.click();
  }), 'editor agent apply click');
  console.log('[ui-probe] editor agent apply clicked');
  try {
    await withTimeout(page.waitForFunction(() => (
      (
        state.videoPlan?.scenes?.[0]?.framing === 'fullscreen'
          && !document.querySelector('.agent-plan-card')
          && document.getElementById('agent-input')?.disabled === false
          && document.getElementById('agent-undo')?.disabled === false
      )
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), 'editor agent apply', 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      framing: state.videoPlan?.scenes?.[0]?.framing || null,
      editorFraming: state.scenes?.[0]?.framing || null,
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      planCardPresent: !!document.querySelector('.agent-plan-card'),
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
    })).catch(() => null);
    throw new Error(`Editor Agent apply timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const agentApplyError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (agentApplyError) {
    throw new Error(`Editor Agent apply failed: ${agentApplyError}`);
  }
  console.log('[ui-probe] editor agent applied');
  const agentApplied = await page.evaluate(() => ({
    planFraming: state.videoPlan?.scenes?.[0]?.framing,
    editorFraming: state.scenes?.[0]?.framing,
    scale: state.videoPlan?.scenes?.[0]?.scale,
    posX: state.videoPlan?.scenes?.[0]?.posX,
    posY: state.videoPlan?.scenes?.[0]?.posY,
    fitMode: state.videoPlan?.scenes?.[0]?.fitMode,
    background: state.videoPlan?.scenes?.[0]?.background,
    borderRadius: state.videoPlan?.scenes?.[0]?.borderRadius,
    shadow: state.videoPlan?.scenes?.[0]?.shadow,
    undoEnabled: document.getElementById('agent-undo')?.disabled === false,
  }));
  check('Editor Agent applies the scoped edit and updates the live editor',
    agentApplied.planFraming === 'fullscreen'
      && agentApplied.editorFraming === 'fullscreen'
      && agentApplied.scale === 1
      && agentApplied.posX === 0
      && agentApplied.posY === 0
      && agentApplied.fitMode === 'cover'
      && agentApplied.background === 'none'
      && agentApplied.borderRadius === 0
      && agentApplied.shadow === 0
      && agentApplied.undoEnabled,
    JSON.stringify(agentApplied));
  const agentHyperframesVisual = await waitForHyperframesVisual(page, (visual) => (
    visual.sceneCount > 0
      && visual.backdropCount === 0
      && (visual.frameTransform === 'none'
        || visual.frameTransform === 'matrix(1, 0, 0, 1, 0, 0)')
      && visual.mediaObjectFit === 'cover'
  ));
  check('HyperFrames preview renders fullscreen without the old blurred inset',
    agentHyperframesVisual?.sceneCount > 0
      && agentHyperframesVisual.backdropCount === 0
      && (agentHyperframesVisual.frameTransform === 'none'
        || agentHyperframesVisual.frameTransform === 'matrix(1, 0, 0, 1, 0, 0)')
      && agentHyperframesVisual.mediaObjectFit === 'cover',
    JSON.stringify(agentHyperframesVisual));

  await withTimeout(page.evaluate(() => {
    const button = document.getElementById('agent-undo');
    if (!button || button.disabled) throw new Error('Agent Undo button is unavailable');
    button.click();
  }), 'editor agent undo click');
  console.log('[ui-probe] editor agent undo clicked');
  try {
    await withTimeout(page.waitForFunction(() => (
      (
        state.videoPlan?.scenes?.[0]?.framing !== 'fullscreen'
          && document.getElementById('agent-input')?.disabled === false
          && document.getElementById('agent-redo')?.disabled === false
      )
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), 'editor agent undo', 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      framing: state.videoPlan?.scenes?.[0]?.framing || null,
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      undoDisabled: document.getElementById('agent-undo')?.disabled === true,
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
    })).catch(() => null);
    throw new Error(`Editor Agent undo timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const agentUndoError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (agentUndoError) {
    throw new Error(`Editor Agent undo failed: ${agentUndoError}`);
  }
  console.log('[ui-probe] editor agent undone');
  const agentUndone = await page.evaluate(() => ({
    planFraming: state.videoPlan?.scenes?.[0]?.framing || null,
    editorFraming: state.scenes?.[0]?.framing || null,
    scale: state.videoPlan?.scenes?.[0]?.scale,
    posX: state.videoPlan?.scenes?.[0]?.posX,
    posY: state.videoPlan?.scenes?.[0]?.posY,
    fitMode: state.videoPlan?.scenes?.[0]?.fitMode,
    background: state.videoPlan?.scenes?.[0]?.background,
    redoEnabled: document.getElementById('agent-redo')?.disabled === false,
  }));
  check('Editor Agent undo restores the exact previous project state',
    agentUndone.planFraming === 'cinematic'
      && agentUndone.editorFraming === 'cinematic'
      && agentUndone.scale === 0.75
      && agentUndone.posX === 8
      && agentUndone.posY === -4
      && agentUndone.fitMode === 'contain'
      && agentUndone.background === 'blur'
      && agentUndone.redoEnabled,
    JSON.stringify(agentUndone));

  await withTimeout(page.evaluate(() => {
    const button = document.getElementById('agent-redo');
    if (!button || button.disabled) throw new Error('Agent Redo button is unavailable');
    button.click();
  }), 'editor agent redo click');
  console.log('[ui-probe] editor agent redo clicked');
  try {
    await withTimeout(page.waitForFunction(() => (
      (
        state.videoPlan?.scenes?.[0]?.framing === 'fullscreen'
          && state.videoPlan?.scenes?.[0]?.scale === 1
          && document.getElementById('agent-input')?.disabled === false
          && document.getElementById('agent-undo')?.disabled === false
      )
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), 'editor agent redo', 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      framing: state.videoPlan?.scenes?.[0]?.framing || null,
      scale: state.videoPlan?.scenes?.[0]?.scale ?? null,
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      redoDisabled: document.getElementById('agent-redo')?.disabled === true,
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
    })).catch(() => null);
    throw new Error(`Editor Agent redo timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const agentRedoError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (agentRedoError) {
    throw new Error(`Editor Agent redo failed: ${agentRedoError}`);
  }
  console.log('[ui-probe] editor agent redone');
  check('Editor Agent redo reapplies the complete visual transaction', true);

  await withTimeout(page.evaluate(() => {
    const button = document.getElementById('agent-undo');
    if (!button || button.disabled) throw new Error('Agent Undo button is unavailable after redo');
    button.click();
  }), 'editor agent second undo');
  console.log('[ui-probe] editor agent second undo clicked');
  try {
    await withTimeout(page.waitForFunction(() => (
      (
        state.videoPlan?.scenes?.[0]?.framing === 'cinematic'
          && document.getElementById('agent-input')?.disabled === false
      )
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), 'editor agent second undo state', 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      framing: state.videoPlan?.scenes?.[0]?.framing || null,
      scale: state.videoPlan?.scenes?.[0]?.scale ?? null,
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      undoDisabled: document.getElementById('agent-undo')?.disabled === true,
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
    })).catch(() => null);
    throw new Error(`Editor Agent second undo timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const agentSecondUndoError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (agentSecondUndoError) {
    throw new Error(`Editor Agent second undo failed: ${agentSecondUndoError}`);
  }
  console.log('[ui-probe] editor agent second undo complete');

  const beforeCutVisual = await readHyperframesSceneVisual(page);
  check('runtime fixture starts with a visible transition and film grain',
    beforeCutVisual?.transitionCount > 0 && beforeCutVisual?.grainCount > 0,
    JSON.stringify(beforeCutVisual));

  console.log('[ui-probe] hard cuts agent');
  const hardCutsPlanText = await planAndApplyAgent(page, 'Use hard cuts for this selection', 'hard cuts');
  console.log(`[ui-probe] hard cuts applied: ${hardCutsPlanText}`);
  try {
    await withTimeout(page.waitForFunction(() => (
      (
        state.videoPlan?.scenes?.[0]?.transition?.type === 'cut'
          && state.videoPlan?.transitions?.every((transition) => transition.type === 'cut')
      )
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), 'hard cuts state', 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      sceneTransitions: state.videoPlan?.scenes?.map((scene) => ({
        clipId: scene.clipId,
        transition: scene.transition,
        transitionType: scene.transitionType,
      })) || [],
      transitions: state.videoPlan?.transitions || [],
      selectedClipIndices: state.selectedClipIndices || [],
      selectedClipIndex: state.selectedClipIndex,
      scope: window.EditorAgentHost?.getScopeSnapshot?.() || null,
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
    })).catch(() => null);
    throw new Error(`Hard cuts state timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  await wait(500);
  const hardCutVisual = await waitForHyperframesVisual(page, (visual) => visual.transitionCount === 0);
  check('Hard-cuts action clears scene metadata and the HyperFrames transition lane',
    hardCutVisual?.transitionCount === 0,
    JSON.stringify(hardCutVisual));

  await withTimeout(page.evaluate(() => {
    const button = document.getElementById('agent-undo');
    if (!button || button.disabled) throw new Error('Hard-cuts Undo button is unavailable');
    button.click();
  }), 'hard cuts undo');
  console.log('[ui-probe] hard cuts undo clicked');
  try {
    await withTimeout(page.waitForFunction(() => (
      (
        state.videoPlan?.transitions?.some((transition) => transition.type === 'wipe-left')
          && document.getElementById('agent-input')?.disabled === false
      )
        || !!document.querySelector('.agent-message.error')
    ), { timeout: 25_000 }), 'hard cuts undo state', 30_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      transitions: state.videoPlan?.transitions || [],
      status: document.getElementById('agent-status-text')?.textContent?.trim() || '',
      inputDisabled: document.getElementById('agent-input')?.disabled === true,
      undoDisabled: document.getElementById('agent-undo')?.disabled === true,
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
    })).catch(() => null);
    throw new Error(`Hard cuts undo timed out: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  const hardCutsUndoError = await page.$eval(
    '.agent-message.error',
    (el) => el.textContent.replace(/\s+/g, ' ').trim()
  ).catch(() => '');
  if (hardCutsUndoError) throw new Error(`Hard cuts undo failed: ${hardCutsUndoError}`);
  console.log('[ui-probe] hard cuts undone');

  console.log('[ui-probe] precise transition agent');
  const transitionScope = await withTimeout(page.evaluate(() => {
    const marker = document.querySelector('.transition-marker[data-transition-index="0"]');
    if (!marker) throw new Error('Transition marker is unavailable after undo');
    marker.click();
    return {
      selectedTransitionIndex: state.selectedTransitionIndex,
      scope: window.EditorAgentHost?.getScopeSnapshot?.() || null,
    };
  }), 'select transition marker');
  check('Transition marker exposes an exact two-clip Agent scope',
    transitionScope.selectedTransitionIndex === 0
      && /selected transition/i.test(transitionScope.scope?.label || '')
      && transitionScope.scope?.clipRefs?.length === 2,
    JSON.stringify(transitionScope));
  const preciseTransitionPlan = await planAndApplyAgent(
    page,
    'Change this transition to whip right and set it to 0.2 seconds',
    'precise transition'
  );
  await waitForPageState(page, () => {
    const transition = state.videoPlan?.transitions?.[0];
    return transition?.type === 'whip-right'
      && Math.abs(Number(transition.duration) - 0.2) < 0.001
      && state.videoPlan?.scenes?.[1]?.transitionType === 'whip-right';
  }, {
    label: 'precise transition state',
    timeoutMs: 30_000,
  });
  const preciseTransitionState = await page.evaluate(() => ({
    transition: state.videoPlan.transitions[0],
    incomingSceneTransition: state.videoPlan.scenes[1].transition,
    selectedTransitionIndex: state.selectedTransitionIndex,
  }));
  check('Transition Agent edits only the selected boundary type and duration',
    /Transition Editor/i.test(preciseTransitionPlan)
      && preciseTransitionState.transition.type === 'whip-right'
      && Math.abs(Number(preciseTransitionState.transition.duration) - 0.2) < 0.001
      && preciseTransitionState.incomingSceneTransition?.type === 'whip-right',
    JSON.stringify({ plan: preciseTransitionPlan, state: preciseTransitionState }));
  await withTimeout(page.evaluate(() => {
    const button = document.getElementById('agent-undo');
    if (!button || button.disabled) throw new Error('Precise-transition Undo button is unavailable');
    button.click();
  }), 'precise transition undo');
  await waitForPageState(page, () => (
    state.videoPlan?.transitions?.[0]?.type === 'wipe-left'
      && document.getElementById('agent-input')?.disabled === false
  ), {
    label: 'precise transition undo state',
    timeoutMs: 30_000,
  });
  await page.evaluate(() => selectClip(0));

  console.log('[ui-probe] no-grain agent');
  await planAndApplyAgent(page, 'Remove film grain from this selection', 'no-grain');
  await withTimeout(page.waitForFunction(() => {
    const scene = state.videoPlan?.scenes?.[0];
    return scene?._directiveEffect?.blockedEffects?.includes('grain')
      && !scene?._effectRecipe?.some((entry) => entry.id === 'grain')
      && scene?._effectRecipe?.some((entry) => entry.id === 'vignette');
  }, { timeout: 25_000 }), 'no-grain state', 30_000);
  await wait(500);
  const noGrainVisual = await waitForHyperframesVisual(page, (visual) => visual.grainCount === 0);
  const noGrainState = await page.evaluate(() => ({
    projectTextureCount: state.videoPlan?._hfBaseLook?.texture?.length || 0,
    selectedEffects: state.videoPlan?.scenes?.[0]?.effects || [],
    selectedRecipe: state.videoPlan?.scenes?.[0]?._effectRecipe || [],
    blockedEffects: state.videoPlan?.scenes?.[0]?._directiveEffect?.blockedEffects || [],
  }));
  check('Remove-grain action removes only grain and preserves the rest of the scoped look',
    noGrainVisual?.grainCount === 0
      && noGrainState.projectTextureCount > 0
      && noGrainState.blockedEffects.includes('grain')
      && !noGrainState.selectedEffects.includes('grain')
      && noGrainState.selectedEffects.includes('vignette'),
    JSON.stringify({ visual: noGrainVisual, state: noGrainState }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'no-grain undo');
  await withTimeout(page.waitForFunction(() => (
    state.videoPlan?.scenes?.[0]?._effectRecipe?.some((entry) => entry.id === 'grain')
  ), { timeout: 25_000 }), 'no-grain undo state', 30_000);

  console.log('[ui-probe] scoped audio agent');
  const visualLookBeforeAudio = await page.evaluate(() => JSON.stringify(
    state.videoPlan?.scenes?.[0]?._effectRecipe || []
  ));
  const audioPlanText = await planAndApplyAgent(
    page,
    'Set sound effects volume to 40 percent',
    'scoped audio'
  );
  await waitForPageState(page, () => (
    Math.abs(Number(state.videoPlan?.sfxClips?.[0]?.volume) - 0.4) < 0.001
      && Math.abs(Number(state.sfxClips?.[0]?.volume) - 0.4) < 0.001
  ), {
    label: 'scoped audio state',
    timeoutMs: 30_000,
  });
  const audioState = await page.evaluate(() => ({
    planVolume: state.videoPlan?.sfxClips?.[0]?.volume,
    editorVolume: state.sfxClips?.[0]?.volume,
    visualLook: JSON.stringify(state.videoPlan?.scenes?.[0]?._effectRecipe || []),
    result: [...document.querySelectorAll('.agent-result-card')].at(-1)?.textContent
      ?.replace(/\s+/g, ' ').trim() || '',
  }));
  check('Audio Agent remixes only the build-authored SFX cue in the active scope',
    /Audio Editor/i.test(audioPlanText)
      && !/Effects Agent/i.test(audioPlanText)
      && /sound effect/i.test(audioState.result)
      && Math.abs(Number(audioState.planVolume) - 0.4) < 0.001
      && Math.abs(Number(audioState.editorVolume) - 0.4) < 0.001
      && audioState.visualLook === visualLookBeforeAudio,
    JSON.stringify({ plan: audioPlanText, state: audioState }));
  await withTimeout(page.evaluate(() => {
    const button = document.getElementById('agent-undo');
    if (!button || button.disabled) throw new Error('Audio Undo button is unavailable');
    button.click();
  }), 'scoped audio undo');
  await waitForPageState(page, () => (
    Math.abs(Number(state.videoPlan?.sfxClips?.[0]?.volume) - 0.24) < 0.001
  ), {
    label: 'scoped audio undo state',
    timeoutMs: 30_000,
  });

  console.log('[ui-probe] in-place graphic content agent');
  const lowerThirdBefore = await page.evaluate(() => {
    const graphic = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third');
    return graphic ? {
      count: state.videoPlan.motionGraphics.length,
      id: graphic.id,
      type: graphic.type,
      text: graphic.text,
      subtext: graphic.subtext,
      startTime: graphic.startTime,
      duration: graphic.duration,
      position: graphic.position,
      style: graphic.style,
      subType: graphic.subType,
      animation: graphic.animation,
      overlayShadowStrength: graphic.overlayShadowStrength,
      colors: graphic.colors,
    } : null;
  });
  const lowerThirdPlanText = await planAndApplyAgent(
    page,
    'edit the lower third to keep only the 300$',
    'in-place lower-third content'
  );
  await waitForPageState(page, () => {
    const graphic = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third');
    return graphic?.text === '$300' && graphic?.subtext === '';
  }, {
    label: 'in-place lower-third content state',
    timeoutMs: 30_000,
  });
  const lowerThirdAfter = await page.evaluate(() => {
    const graphic = state.videoPlan.motionGraphics.find((item) => item.id === 'runtime-lower-third');
    return {
      count: state.videoPlan.motionGraphics.length,
      id: graphic.id,
      type: graphic.type,
      text: graphic.text,
      subtext: graphic.subtext,
      startTime: graphic.startTime,
      duration: graphic.duration,
      position: graphic.position,
      style: graphic.style,
      subType: graphic.subType,
      animation: graphic.animation,
      overlayShadowStrength: graphic.overlayShadowStrength,
      colors: graphic.colors,
    };
  });
  const lowerThirdResultText = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.agent-result-card')];
    return cards.length
      ? cards[cards.length - 1].textContent.replace(/\s+/g, ' ').trim()
      : '';
  });
  const lowerThirdVisual = await waitForHyperframesVisual(page, (visual) => (
    visual.lowerThirdText === '$300'
  ));
  const lowerThirdDesignBefore = { ...lowerThirdBefore };
  const lowerThirdDesignAfter = { ...lowerThirdAfter };
  delete lowerThirdDesignBefore.text;
  delete lowerThirdDesignBefore.subtext;
  delete lowerThirdDesignAfter.text;
  delete lowerThirdDesignAfter.subtext;
  check('Graphic content edit preserves the original lower-third design and changes only its copy',
    /Motion Graphics Editor/i.test(lowerThirdPlanText)
      && /in-place graphic text edit/i.test(lowerThirdPlanText)
      && /Inspected live/i.test(lowerThirdPlanText)
      && !/\bno\b.{0,32}\b(?:changes?|edits?|updates?|work|actions?)\b.{0,32}\b(?:needed|required|necessary)\b/i.test(lowerThirdPlanText)
      && !/\balready\b.{0,40}\b(?:queued|applied|updated|done|complete(?:d)?)\b/i.test(lowerThirdPlanText)
      && /Edit verified/i.test(lowerThirdResultText)
      && /Quality Guard/i.test(lowerThirdResultText)
      && /scope protected/i.test(lowerThirdResultText)
      && lowerThirdAfter.count === lowerThirdBefore.count
      && JSON.stringify(lowerThirdDesignAfter) === JSON.stringify(lowerThirdDesignBefore)
      && lowerThirdAfter.text === '$300'
      && lowerThirdAfter.subtext === ''
      && lowerThirdVisual?.lowerThirdText === '$300',
    JSON.stringify({
      plan: lowerThirdPlanText,
      result: lowerThirdResultText,
      before: lowerThirdBefore,
      after: lowerThirdAfter,
      visual: lowerThirdVisual,
    }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'in-place lower-third undo');
  await waitForPageState(page, (originalText) => (
    state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third')?.text === originalText
  ), {
    label: 'in-place lower-third undo state',
    timeoutMs: 30_000,
    argument: lowerThirdBefore.text,
  });

  console.log('[ui-probe] selective in-place graphic text color');
  // Find the clip and click it in the same breath, and keep doing it until the
  // app confirms the selection.
  //
  // The timeline is rebuilt with innerHTML, so the element a query returns can be
  // detached before the click lands — the click then goes to a node that is no
  // longer on the page and nothing happens, silently. The previous edit in this
  // suite rewrites the lower-third's text, which triggers exactly that rebuild,
  // so a single click here was a coin flip and the timeout that followed blamed
  // the selection instead of the race.
  await waitForPageState(page, () => {
    if (state.selectedMgIndex === 0) return true;
    const graphicClip = document.querySelector('.mg-clip[data-mg-index="0"]');
    if (!graphicClip) return false;
    graphicClip.click();
    return state.selectedMgIndex === 0;
  }, { label: 'selected lower-third Agent scope', timeoutMs: 15_000 });

  await planAndApplyAgent(
    page,
    'make the lower third say 50 Years',
    'prepare selective lower-third text'
  );
  await waitForPageState(page, () => (
    state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third')?.text === '50 Years'
  ), {
    label: 'prepare selective lower-third state',
    timeoutMs: 30_000,
  });
  const styleBefore = await page.evaluate(() => {
    const graphic = state.videoPlan.motionGraphics.find((item) => item.id === 'runtime-lower-third');
    return {
      count: state.videoPlan.motionGraphics.length,
      graphic: JSON.parse(JSON.stringify(graphic)),
    };
  });
  const stylePlanText = await planAndApplyAgent(
    page,
    'change te color of this lower third into red',
    'selective lower-third text color'
  );
  await waitForPageState(page, () => {
    const graphic = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third');
    return graphic?.textStyleRanges?.some((range) => (
      range.match === '50 Years' && range.color === '#ef4444'
    ));
  }, {
    label: 'selective lower-third text color state',
    timeoutMs: 30_000,
  });
  await page.evaluate(async () => {
    await seekToTime(0.8);
  });
  const styleVisual = await waitForHyperframesVisual(page, (visual) => (
    visual.lowerThirdStyledText === '50 Years'
      && visual.lowerThirdStyledColorToken === '#ef4444'
  ));
  const styleAfter = await page.evaluate(() => {
    const graphic = state.videoPlan.motionGraphics.find((item) => item.id === 'runtime-lower-third');
    return {
      count: state.videoPlan.motionGraphics.length,
      graphic: JSON.parse(JSON.stringify(graphic)),
    };
  });
  const styleResultText = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.agent-result-card')];
    return cards.length
      ? cards[cards.length - 1].textContent.replace(/\s+/g, ' ').trim()
      : '';
  });
  const styleInvariantBefore = JSON.parse(JSON.stringify(styleBefore.graphic));
  const styleInvariantAfter = JSON.parse(JSON.stringify(styleAfter.graphic));
  delete styleInvariantBefore.textStyleRanges;
  delete styleInvariantAfter.textStyleRanges;
  check('Text-color Agent edit changes only the requested words and preserves the lower third',
    /Motion Graphics Editor/i.test(stylePlanText)
      && !/Effects Agent/i.test(stylePlanText)
      && /in-place graphic style edit/i.test(stylePlanText)
      && /Edit verified/i.test(styleResultText)
      && styleAfter.count === styleBefore.count
      && styleAfter.graphic.id === styleBefore.graphic.id
      && styleAfter.graphic.text === '50 Years'
      && JSON.stringify(styleInvariantAfter) === JSON.stringify(styleInvariantBefore)
      && styleAfter.graphic.textStyleRanges?.length === 1
      && styleAfter.graphic.textStyleRanges[0].match === '50 Years'
      && styleAfter.graphic.textStyleRanges[0].color === '#ef4444'
      && styleVisual?.lowerThirdStyledText === '50 Years'
      && styleVisual?.lowerThirdStyledColorToken === '#ef4444'
      && styleVisual?.lowerThirdStyledColor === 'rgb(239, 68, 68)',
    JSON.stringify({
      plan: stylePlanText,
      result: styleResultText,
      before: styleBefore,
      after: styleAfter,
      visual: styleVisual,
    }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'selective color undo');
  await waitForPageState(page, () => {
    const graphic = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third');
    return graphic?.text === '50 Years' && !graphic?.textStyleRanges?.length;
  }, {
    label: 'selective color undo state',
    timeoutMs: 30_000,
  });
  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'selective text preparation undo');
  await waitForPageState(page, (originalText) => (
    state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third')?.text === originalText
  ), {
    label: 'selective text preparation undo state',
    timeoutMs: 30_000,
    argument: lowerThirdBefore.text,
  });

  console.log('[ui-probe] dynamic effects agent');
  const effectsPlanText = await planAndApplyAgent(page, 'Add subtle fog', 'dynamic effects');
  await waitForPageState(page, () => (
    state.videoPlan?.scenes?.[0]?._effectRecipe?.some((entry) => entry.id === 'fogDrift')
  ), {
    label: 'dynamic effects state',
    timeoutMs: 30_000,
  });
  await page.evaluate(async () => {
    await seekToTime(Math.min(state.totalDuration, state.videoPlan.scenes[0].startTime + 0.3));
  });
  const effectsVisual = await waitForHyperframesVisual(page, (visual) => visual.fogCount >= 2);
  check('Effects Agent discovers, applies, and renders a non-preset effect',
    /Effects Agent/i.test(effectsPlanText)
      && effectsVisual?.fogCount >= 2,
    JSON.stringify({ plan: effectsPlanText, visual: effectsVisual }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'dynamic effects undo');
  await waitForPageState(page, () => (
    !state.videoPlan?.scenes?.[0]?._effectRecipe?.some((entry) => entry.id === 'fogDrift')
  ), {
    label: 'dynamic effects undo state',
    timeoutMs: 30_000,
  });

  console.log('[ui-probe] structural pacing agent');
  const pacingBefore = await page.evaluate(() => {
    const longestIndex = state.scenes.reduce((bestIndex, scene, index, scenes) => {
      if (scene?.isMGScene) return bestIndex;
      const duration = Number(scene.endTime) - Number(scene.startTime);
      const best = scenes[bestIndex];
      const bestDuration = best ? Number(best.endTime) - Number(best.startTime) : -1;
      return duration > bestDuration ? index : bestIndex;
    }, 0);
    selectClip(longestIndex);
    return {
      sceneCount: state.videoPlan.scenes.length,
      duration: state.videoPlan.totalDuration,
      selectedClipId: state.scenes[state.selectedClipIndex]?.clipId,
      from: state.scenes[state.selectedClipIndex]?.startTime,
      to: state.scenes[state.selectedClipIndex]?.endTime,
    };
  });
  const pacingPlanText = await planAndApplyAgent(page, 'Make this selected part faster paced', 'structural pacing');
  await waitForPageState(page, (beforeCount) => (
    state.videoPlan?.scenes?.length > beforeCount
      && state.scenes?.filter((scene) => !scene.isMGScene).length > beforeCount
  ), {
    label: 'structural pacing state',
    timeoutMs: 35_000,
    argument: pacingBefore.sceneCount,
  });
  const pacingAfter = await page.evaluate(({ from, to }) => {
    const scenes = state.videoPlan.scenes;
    const affected = scenes.filter((scene) => scene.startTime >= from - 0.01 && scene.endTime <= to + 0.01);
    const ids = scenes.map((scene) => scene.clipId);
    const words = affected.flatMap((scene) => scene.words || []).map((word) => `${word.word}@${word.start}`);
    return {
      sceneCount: scenes.length,
      editorSceneCount: state.scenes.filter((scene) => !scene.isMGScene).length,
      duration: state.videoPlan.totalDuration,
      uniqueIds: new Set(ids).size === ids.length,
      uniqueWords: new Set(words).size === words.length,
      cutCount: (state.videoPlan.transitions || []).filter((transition) => (
        transition.startTime >= from - 0.01
          && transition.startTime <= to + 0.01
          && transition.type === 'cut'
      )).length,
      selectedCount: state.selectedClipIndices.length,
      timelineClips: document.querySelectorAll('.timeline-clip[data-index]').length,
    };
  }, pacingBefore);
  check('Agent performs a structural re-cut and rehydrates the live timeline',
    /STRUCTURAL risk/i.test(pacingPlanText)
      && pacingAfter.sceneCount > pacingBefore.sceneCount
      && pacingAfter.editorSceneCount === pacingAfter.sceneCount
      && pacingAfter.duration === pacingBefore.duration
      && pacingAfter.uniqueIds
      && pacingAfter.uniqueWords
      && pacingAfter.cutCount > 0
      && pacingAfter.selectedCount > 0
      && pacingAfter.timelineClips >= pacingAfter.sceneCount,
    JSON.stringify({ plan: pacingPlanText, before: pacingBefore, after: pacingAfter }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'structural pacing undo');
  await waitForPageState(page, (beforeCount) => (
    state.videoPlan?.scenes?.length === beforeCount
      && state.videoPlan.scenes.some((scene) => scene.clipId === 'runtime-scene-1')
  ), {
    label: 'structural pacing undo state',
    timeoutMs: 35_000,
    argument: pacingBefore.sceneCount,
  });

  console.log('[ui-probe] motion graphics agent');
  await page.evaluate(() => selectClip(0));
  const graphicsPlanText = await planAndApplyAgent(page, 'Add an animated text treatment', 'motion graphics');
  await waitForPageState(page, () => (
    state.videoPlan?.motionGraphics?.some((graphic) => (
      graphic.type === 'kineticText' && graphic.selectionMode === 'editor-agent'
    ))
  ), {
    label: 'motion graphics state',
    timeoutMs: 35_000,
  });
  const graphicsState = await page.evaluate(async () => {
    const graphic = state.videoPlan.motionGraphics.find((item) => (
      item.type === 'kineticText' && item.selectionMode === 'editor-agent'
    ));
    await seekToTime(Math.min(state.totalDuration, graphic.startTime + 0.2));
    return {
      type: graphic.type,
      startTime: graphic.startTime,
      duration: graphic.duration,
      timelineMgCount: document.querySelectorAll('.timeline-clip.mg-clip').length,
    };
  });
  await wait(700);
  const graphicsVisual = await waitForHyperframesVisual(page, (visual) => visual.graphicCount > 0);
  check('Agent creates a renderable motion graphic in the plan, timeline, and preview',
    /graphic edit/i.test(graphicsPlanText)
      && graphicsState.type === 'kineticText'
      && graphicsState.duration > 0
      && graphicsState.timelineMgCount > 0
      && graphicsVisual?.graphicCount > 0,
    JSON.stringify({ plan: graphicsPlanText, state: graphicsState, visual: graphicsVisual }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'motion graphics undo');
  await waitForPageState(page, () => (
    !state.videoPlan?.motionGraphics?.some((graphic) => graphic.selectionMode === 'editor-agent')
  ), {
    label: 'motion graphics undo state',
    timeoutMs: 35_000,
  });

  console.log('[ui-probe] replacement media agent');
  const mediaBefore = await page.evaluate(() => {
    selectClip(0);
    return state.videoPlan.scenes[0].mediaFile;
  });
  const mediaPlanText = await planAndApplyAgent(page, 'Find a better alternative for this media', 'replacement media');
  await waitForPageState(page, () => (
    /^agent-assets\//.test(state.videoPlan?.scenes?.[0]?.mediaFile || '')
      && /^agent-assets\//.test(state.scenes?.[0]?.mediaFile || '')
  ), {
    label: 'replacement media state',
    timeoutMs: 40_000,
  });
  const mediaAfter = await page.evaluate(async () => {
    await seekToTime(Math.min(state.totalDuration, state.videoPlan.scenes[0].startTime + 0.3));
    return {
      planMedia: state.videoPlan.scenes[0].mediaFile,
      editorMedia: state.scenes[0].mediaFile,
      provider: state.videoPlan.scenes[0].sourceProvider,
      query: state.videoPlan.scenes[0].searchKeyword,
    };
  });
  await wait(700);
  const mediaVisual = await waitForHyperframesVisual(page, (visual) => (
    visual.mediaWidth === 800 && visual.mediaHeight === 450
  ));
  check('Agent commits replacement media and reloads it in HyperFrames',
    /EXPENSIVE risk/i.test(mediaPlanText)
      && /^agent-assets\//.test(mediaAfter.planMedia)
      && mediaAfter.editorMedia === mediaAfter.planMedia
      && mediaAfter.provider === 'runtime-test-fixture'
      && /runtime fixture/i.test(mediaAfter.query)
      && mediaVisual?.mediaWidth === 800
      && mediaVisual?.mediaHeight === 450,
    JSON.stringify({ plan: mediaPlanText, before: mediaBefore, after: mediaAfter, visual: mediaVisual }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'replacement media undo');
  await waitForPageState(page, (original) => (
    state.videoPlan?.scenes?.[0]?.mediaFile === original
      && state.scenes?.[0]?.mediaFile === original
  ), {
    label: 'replacement media undo state',
    timeoutMs: 35_000,
    argument: mediaBefore,
  });

  console.log('[ui-probe] compound whole-scene agent');
  const compoundBefore = await withTimeout(page.evaluate(async () => {
    selectClip(0);
    window.EditorAgentHost?.setScopeMode?.('scene');
    const headline = {
      id: 'runtime-headline',
      clipId: 'runtime-headline',
      type: 'headline',
      category: 'overlay',
      text: 'Runtime headline',
      subtext: '',
      startTime: 0.1,
      duration: 1.2,
      position: 'center',
      sceneIndex: 0,
      sourceSceneIndex: 0,
      style: 'editorial-light',
      subType: 'standard',
      animation: 'springScale',
      overlayShadowStrength: 0.55,
      colors: {
        primary: '#bc641c',
        accent: '#f5ead6',
        text: '#1f2937',
        background: 'rgba(245,234,214,0.82)',
      },
    };
    state.motionGraphics = (state.motionGraphics || []).filter((item) => item.id !== headline.id);
    state.motionGraphics.push(headline);
    renderTimeline();
    loadActiveScenes();
    const saved = await saveProject(true);
    if (!saved?.success) throw new Error(saved?.error || 'Could not persist runtime headline fixture');
    await refreshHyperframesPreview({ force: true });
    notifyAgentContextChanged();
    return {
      headline: JSON.parse(JSON.stringify(
        state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline')
      )),
      lowerThird: JSON.parse(JSON.stringify(
        state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third')
      )),
      recipe: JSON.parse(JSON.stringify(state.videoPlan?.scenes?.[0]?._effectRecipe || [])),
      scope: window.EditorAgentHost?.getScopeSnapshot?.(),
    };
  }), 'prepare compound whole-scene fixture', 35_000);
  check('Compound scene fixture exposes the semantic headline beside sibling layers',
    compoundBefore.scope?.scopeMode === 'scene'
      && compoundBefore.scope?.visualRefs?.some((ref) => ref.id === 'runtime-headline')
      && compoundBefore.scope?.visualRefs?.some((ref) => ref.id === 'runtime-lower-third')
      && compoundBefore.scope?.iconRefs?.length === 1,
    JSON.stringify(compoundBefore.scope));

  console.log('[ui-probe] dynamically discovered word-cascade animation');
  const wordCascadePlanText = await planAndApplyAgent(
    page,
    'Give the headline a word cascade animation',
    'word cascade animation'
  );
  await waitForPageState(page, () => (
    state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline')?.animation
      === 'wordCascade'
  ), {
    label: 'word cascade animation state',
    timeoutMs: 30_000,
  });
  // The claim under test is "the words do not arrive together". That is a claim
  // about the entrance WINDOW, not about one instant, so scan the window instead
  // of betting the whole check on a single seek.
  //
  // A seek pauses the timeline, so polling at one time cannot help: the frame is
  // frozen and the two words read the same opacity forever. Landing a few
  // milliseconds before the stagger opens therefore failed a green product — the
  // canvas-renderer half of this very check kept passing while the page half
  // flipped run to run. Scanning is also the stricter reading: a headline whose
  // words truly pop in together now fails at every point in the window, not just
  // at 0.36s.
  let wordCascadeMid = null;
  for (const at of [0.36, 0.30, 0.42, 0.33, 0.39, 0.45, 0.48]) {
    await page.evaluate(async (time) => {
      await seekToTime(time);
    }, at);
    const visual = await waitForHyperframesVisual(page, (candidate) => (
      candidate.headlineAnimation === 'wordCascade'
        && candidate.headlineWordCascadeCount === 2
    ));
    if (visual) wordCascadeMid = visual;
    if (new Set(visual?.headlineWordCascadeOpacities || []).size > 1) break;
  }
  await page.evaluate(async () => {
    await seekToTime(0.9);
  });
  const wordCascadeLate = await waitForHyperframesVisual(page, (visual) => (
    visual.headlineAnimation === 'wordCascade'
      && visual.headlineWordCascadeOpacities.every((opacity) => opacity > 0.98)
  ));
  const wordCascadeRuntime = await page.evaluate(() => {
    const renderer = new window.MGRenderer({
      createOrUpdate: (id, canvas) => ({ id, width: canvas.width, height: canvas.height }),
    }, 30);
    renderer.setPreviewScale(0.25);
    const graphic = {
      type: 'headline',
      text: 'Runtime headline',
      subtext: '',
      position: 'center',
      style: 'clean',
      subType: 'standard',
      animation: 'wordCascade',
      duration: 2,
      _totalFrames: 60,
      _animationSpeed: 1,
    };
    const countAlphaPixels = () => {
      const data = renderer._ctx.getImageData(
        0,
        0,
        renderer._canvas.width,
        renderer._canvas.height
      ).data;
      let count = 0;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 4) count++;
      }
      return count;
    };
    const earlyState = renderer._computeAnimation(
      'wordCascade',
      4,
      30,
      window.AnimationUtils.computeAnimationState(4, 30, graphic),
      graphic
    );
    renderer.renderMG(graphic, 4, { themeId: 'standard' });
    const earlyPixels = countAlphaPixels();
    renderer.renderMG(graphic, 28, { themeId: 'standard' });
    const latePixels = countAlphaPixels();
    const registered = typeof renderer._animComputers.wordCascade === 'function';
    renderer.destroy();
    return {
      animation: state.videoPlan?.motionGraphics?.find(
        (item) => item.id === 'runtime-headline'
      )?.animation || '',
      registryAnimations: window._mgRegistry?.getAnimationsForCategory?.('headline') || [],
      canvasRenderer: {
        registered,
        earlyPixels,
        latePixels,
        hasCascadeState: Boolean(earlyState.wordCascade),
      },
    };
  });
  check('A new registry animation is discovered, executed, and rendered without a router command edit',
    /Motion Graphics Editor/i.test(wordCascadePlanText)
      && !/needs a stronger editing tool/i.test(wordCascadePlanText)
      && wordCascadeRuntime.animation === 'wordCascade'
      && wordCascadeRuntime.registryAnimations.includes('wordCascade')
      && wordCascadeRuntime.canvasRenderer.registered
      && wordCascadeRuntime.canvasRenderer.hasCascadeState
      && wordCascadeRuntime.canvasRenderer.earlyPixels > 0
      && wordCascadeRuntime.canvasRenderer.latePixels > wordCascadeRuntime.canvasRenderer.earlyPixels
      && wordCascadeMid?.headlineWordCascadeCount === 2
      && new Set(wordCascadeMid?.headlineWordCascadeOpacities || []).size > 1
      && wordCascadeLate?.headlineWordCascadeOpacities?.every((opacity) => opacity > 0.98),
    JSON.stringify({
      plan: wordCascadePlanText,
      runtime: wordCascadeRuntime,
      mid: wordCascadeMid,
      late: wordCascadeLate,
    }));
  await withTimeout(
    page.evaluate(() => document.getElementById('agent-undo')?.click()),
    'word cascade animation undo'
  );
  await waitForPageState(page, (before) => {
    const headline = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline');
    return headline?.animation === before.headline.animation;
  }, {
    label: 'word cascade animation undo state',
    timeoutMs: 30_000,
    argument: compoundBefore,
  });

  console.log('[ui-probe] isolated headline duration agent');
  const durationMediaBefore = await page.evaluate(() => (
    state.videoPlan?.scenes?.[0]?.mediaFile || ''
  ));
  const durationPlanText = await planAndApplyAgent(
    page,
    'edit the duration of the headling make it shorter',
    'isolated headline duration'
  );
  await waitForPageState(page, (before) => {
    const headline = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline');
    return headline
      && Number(headline.duration) < Number(before.headline.duration)
      && headline.startTime === before.headline.startTime;
  }, {
    label: 'isolated headline duration state',
    timeoutMs: 30_000,
    argument: compoundBefore,
  });
  const durationAfter = await page.evaluate(() => ({
    headline: JSON.parse(JSON.stringify(
      state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline')
    )),
    mediaFile: state.videoPlan?.scenes?.[0]?.mediaFile || '',
  }));
  check('Headline duration edit does not revive the previously completed Media Editor task',
    /Motion Graphics Editor/i.test(durationPlanText)
      && !/Media Editor/i.test(durationPlanText)
      && Math.abs(Number(durationAfter.headline.duration) - Number(compoundBefore.headline.duration) * 0.65) < 0.002
      && durationAfter.headline.startTime === compoundBefore.headline.startTime
      && durationAfter.headline.text === compoundBefore.headline.text
      && durationAfter.mediaFile === durationMediaBefore,
    JSON.stringify({
      plan: durationPlanText,
      before: compoundBefore.headline,
      after: durationAfter,
    }));
  await withTimeout(
    page.evaluate(() => document.getElementById('agent-undo')?.click()),
    'isolated headline duration undo'
  );
  try {
    await waitForPageState(page, (before) => {
      const headline = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline');
      return headline
        && Math.abs(Number(headline.duration) - Number(before.headline.duration)) < 0.002
        && headline.startTime === before.headline.startTime
        && headline.text === before.headline.text
        && headline.animation === before.headline.animation;
    }, {
      label: 'isolated headline duration undo state',
      timeoutMs: 30_000,
      argument: compoundBefore,
    });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      headline: state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline') || null,
      version: window.EditorAgentHost?.getProjectVersion?.() || null,
      messages: [...document.querySelectorAll('#agent-messages .agent-message, #agent-messages .agent-result-card')]
        .slice(-5)
        .map((el) => ({
          className: el.className,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        })),
    })).catch(() => null);
    throw new Error(`Isolated headline duration undo mismatch: ${JSON.stringify(diagnostic)} (${error.message})`);
  }

  const compoundPlanText = await planAndApplyAgent(
    page,
    'give it a scratch effect, remove the decorative accent bar from the headline, make it without background in a white color, and give it a typewriter animation',
    'compound whole-scene edit'
  );
  await waitForPageState(page, () => {
    const scene = state.videoPlan?.scenes?.[0];
    const headline = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline');
    return scene?._effectRecipe?.some((effect) => effect.id === 'filmScratches')
      && headline?.type === 'headline'
      && headline?.transparentBackground === true
      && headline?.colors?.text === '#ffffff'
      && headline?.animation === 'typewriter'
      && headline?.subType === 'typewriter'
      && headline?.accentRuleVisible === false;
  }, {
    label: 'compound whole-scene state',
    timeoutMs: 30_000,
  });
  await page.evaluate(async () => {
    await seekToTime(0.6);
  });
  const compoundVisual = await waitForHyperframesVisual(page, (visual) => (
    visual.scratchCount > 0
      && visual.headlineText === 'Runtime headline'
      && visual.headlineColor === 'rgb(255, 255, 255)'
      && visual.headlineBackground === 'rgba(0, 0, 0, 0)'
      && visual.headlineVariant === 'typewriter'
      && visual.headlineAnimation === 'typewriter'
      && visual.headlineAccentRuleDisplay === 'none'
  ));
  const compoundAfter = await page.evaluate(() => ({
    headline: JSON.parse(JSON.stringify(
      state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline')
    )),
    lowerThird: JSON.parse(JSON.stringify(
      state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-lower-third')
    )),
    scratchEffect: JSON.parse(JSON.stringify(
      state.videoPlan?.scenes?.[0]?._effectRecipe?.find((effect) => effect.id === 'filmScratches')
    )),
    icon: JSON.parse(JSON.stringify(state.videoPlan?.scenes?.[0]?._iconMoments?.[0])),
  }));
  check('Whole scene Agent coordinates effects and semantic headline editing without touching sibling layers',
    /Effects Agent/i.test(compoundPlanText)
      && /Motion Graphics Editor/i.test(compoundPlanText)
      && !/needs a stronger editing tool/i.test(compoundPlanText)
      && compoundAfter.headline.id === compoundBefore.headline.id
      && compoundAfter.headline.type === 'headline'
      && compoundAfter.headline.text === compoundBefore.headline.text
      && compoundAfter.headline.transparentBackground === true
      && compoundAfter.headline.colors?.text === '#ffffff'
      && compoundAfter.headline.animation === 'typewriter'
      && compoundAfter.headline.subType === 'typewriter'
      && compoundAfter.headline.accentRuleVisible === false
      && compoundAfter.scratchEffect?.id === 'filmScratches'
      && compoundAfter.scratchEffect?.color == null
      && JSON.stringify(compoundAfter.lowerThird) === JSON.stringify(compoundBefore.lowerThird)
      && !compoundAfter.icon?.color
      && compoundAfter.icon?.position === 'top-right'
      && compoundVisual?.scratchCount > 0
      && compoundVisual?.headlineColor === 'rgb(255, 255, 255)'
      && compoundVisual?.headlineBackground === 'rgba(0, 0, 0, 0)'
      && compoundVisual?.headlineAccentRuleDisplay === 'none',
    JSON.stringify({
      plan: compoundPlanText,
      before: compoundBefore,
      after: compoundAfter,
      visual: compoundVisual,
    }));

  await withTimeout(page.evaluate(() => document.getElementById('agent-undo')?.click()), 'compound whole-scene undo');
  await waitForPageState(page, (before) => {
    const scene = state.videoPlan?.scenes?.[0];
    const headline = state.videoPlan?.motionGraphics?.find((item) => item.id === 'runtime-headline');
    return JSON.stringify(headline) === JSON.stringify(before.headline)
      && JSON.stringify(scene?._effectRecipe || []) === JSON.stringify(before.recipe);
  }, {
    label: 'compound whole-scene undo state',
    timeoutMs: 30_000,
    argument: compoundBefore,
  });

  console.log('[ui-probe] persistent agent memory');
  const storedAgentSession = await withTimeout(
    page.evaluate(() => window.electronAPI.agentSession()),
    'agent session load'
  );
  check('Editor Agent conversation and last edit context persist in the project',
    storedAgentSession?.success === true
      && storedAgentSession.session?.turns?.length >= 4
      && storedAgentSession.session?.context?.lastExecution?.transactionId
      && storedAgentSession.session?.context?.lastExecution?.capabilityIds?.length > 0,
    JSON.stringify(storedAgentSession));

  const oldSessionId = storedAgentSession.session.id;
  await withTimeout(
    page.evaluate(() => document.getElementById('agent-new-chat')?.click()),
    'new agent conversation click'
  );
  await waitForPageState(page, () => (
    document.getElementById('agent-input')?.disabled === false
      && !!document.querySelector('#agent-messages .agent-welcome')
  ), {
    label: 'new agent conversation state',
    timeoutMs: 15_000,
  });
  const newAgentSession = await withTimeout(
    page.evaluate(() => window.electronAPI.agentSession()),
    'new agent session load'
  );
  check('New conversation clears chat memory without touching edit history',
    newAgentSession?.success === true
      && newAgentSession.session?.id !== oldSessionId
      && newAgentSession.session?.turns?.length === 0
      && await page.$eval('#agent-messages .agent-welcome', (element) => !!element),
    JSON.stringify(newAgentSession));

  console.log('[ui-probe] new project location modes');
  const newProjectDialog = await withTimeout(page.evaluate(() => {
    showNewProjectDialog();
    const selectedMode = document.querySelector('input[name="np-location-mode"][value="selected-folder"]');
    const subfolderMode = document.querySelector('input[name="np-location-mode"][value="create-subfolder"]');
    const nameInput = document.getElementById('np-name');
    const defaultState = {
      selectedChecked: selectedMode?.checked === true,
      nameDisabled: nameInput?.disabled === true,
      locationLabel: document.getElementById('np-location-label')?.textContent.trim(),
    };
    subfolderMode.checked = true;
    subfolderMode.dispatchEvent(new Event('change', { bubbles: true }));
    const subfolderState = {
      nameDisabled: nameInput?.disabled === true,
      nameValue: nameInput?.value,
      locationLabel: document.getElementById('np-location-label')?.textContent.trim(),
      hint: document.getElementById('np-name-hint')?.textContent.trim(),
    };
    document.getElementById('np-cancel')?.click();
    return {
      defaultState,
      subfolderState,
      dialogClosed: !document.getElementById('new-project-dialog'),
    };
  }), 'new project location modes');
  check('New Project defaults to using the selected folder without nesting',
    newProjectDialog.defaultState.selectedChecked
      && newProjectDialog.defaultState.nameDisabled
      && newProjectDialog.defaultState.locationLabel === 'Final Project Folder',
    JSON.stringify(newProjectDialog.defaultState));
  check('New Project can explicitly create a named folder inside a parent',
    !newProjectDialog.subfolderState.nameDisabled
      && newProjectDialog.subfolderState.nameValue === 'Untitled Project'
      && newProjectDialog.subfolderState.locationLabel === 'Parent Location'
      && /creates a new folder/i.test(newProjectDialog.subfolderState.hint)
      && newProjectDialog.dialogClosed,
    JSON.stringify(newProjectDialog.subfolderState));

  // Report
  console.log('\n=== RUNTIME UI PROBE ===');
  let allPass = true;
  for (const r of results) { const s = r.pass ? 'PASS' : 'FAIL'; if (!r.pass) allPass = false; console.log(`[${s}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`); }
  console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'} (${results.filter(r => r.pass).length}/${results.length})`);

  await browser.disconnect();
  clearTimeout(watchdog);
  process.exit(allPass ? 0 : 1);
})().catch(e => { clearTimeout(watchdog); console.error('PROBE ERROR', e.message); process.exit(3); });
