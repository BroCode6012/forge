/**
 * Forge - sandboxed Electron preload.
 *
 * No application modules are loaded here. Renderers receive a role-scoped,
 * structured-clone-safe IPC surface through contextBridge.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const roleArg = process.argv.find((arg) => arg.startsWith('--yta-window-role='));
const windowRole = roleArg ? roleArg.slice('--yta-window-role='.length) : 'unknown';
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, { replace = false } = {}) {
    return (callback) => {
        if (typeof callback !== 'function') throw new TypeError(`Listener for ${channel} must be a function`);
        if (replace) ipcRenderer.removeAllListeners(channel);
        const listener = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    };
}

const fullApi = {
    importAudioFile: async (file) => {
        const sourcePath = webUtils.getPathForFile(file);
        if (!sourcePath) return { success: false, error: 'The selected file has no native path' };
        return ipcRenderer.invoke('import-audio-file', sourcePath);
    },
    copyPresenterImage: invoke('copy-presenter-image'),
    runBuild: invoke('run-build'),
    setAiProvider: invoke('set-ai-provider'),
    loadVideoPlan: invoke('load-video-plan'),
    loadTestMgPlan: invoke('load-test-mg-plan'),
    saveVideoPlan: invoke('save-video-plan'),
    qaPreCropMedia: (payload) => ipcRenderer.invoke('qa-pre-crop-media', payload || {}),
    saveQAResults: invoke('save-qa-results'),
    loadQAResults: invoke('load-qa-results'),
    pushPlanToMain: invoke('push-plan-to-main'),
    onQAPlanUpdated: subscribe('qa-plan-updated'),
    agentPlan: (payload) => ipcRenderer.invoke('agent-plan', payload || {}),
    agentExecute: (payload) => ipcRenderer.invoke('agent-execute', payload || {}),
    agentUndo: invoke('agent-undo'),
    agentRedo: invoke('agent-redo'),
    agentHistory: invoke('agent-history'),
    agentSession: invoke('agent-session'),
    agentNewSession: invoke('agent-new-session'),
    agentCapabilities: invoke('agent-capabilities'),
    onAgentProgress: subscribe('agent-progress', { replace: true }),
    onAgentPlanUpdated: subscribe('agent-plan-updated'),
    getSceneVideoPath: invoke('get-scene-video-path'),
    getSceneMediaPath: invoke('get-scene-media-path'),
    sceneAction: (payload) => ipcRenderer.invoke('scene-action', payload || {}),
    onSceneActionProgress: subscribe('scene-action-progress', { replace: true }),
    qaPreviewOrder: (text) => ipcRenderer.invoke('qa-preview-order', { text }),
    qaApplyOrder: (text) => ipcRenderer.invoke('qa-apply-order', { text }),
    qaUndo: invoke('qa-undo'),
    openExternal: invoke('open-external'),
    getAudioPath: invoke('get-audio-path'),
    getFileUrl: invoke('get-file-url'),
    getCountryGeoJSON: invoke('get-country-geojson'),
    openOutputFolder: invoke('open-output-folder'),
    openProjectLogs: invoke('open-project-logs'),
    tailProjectLogs: invoke('tail-project-logs'),
    getCurrentLogFile: invoke('get-current-log-file'),
    openFile: invoke('open-file'),
    selectFile: invoke('select-file'),
    selectFolder: invoke('select-folder'),
    onBuildProgress: subscribe('build-progress'),
    onBuildEvent: subscribe('build-event'),
    onRenderProgress: subscribe('render-progress'),
    onMenuUndo: subscribe('menu-undo'),
    onMenuCopy: subscribe('menu-copy'),
    onMenuPaste: subscribe('menu-paste'),
    onMenuSave: subscribe('menu-save'),
    onMenuDelete: subscribe('menu-delete'),
    onMenuSelectAll: subscribe('menu-select-all'),
    onMenuNew: subscribe('menu-new'),
    writeClipboardText: (text) => ipcRenderer.invoke('clipboard-write-text', String(text ?? '')),
    readClipboardText: invoke('clipboard-read-text'),
    showNotification: invoke('show-notification'),
    cancelProcess: invoke('cancel-process'),
    getSfxPath: invoke('get-sfx-path'),
    scanOverlays: invoke('scan-overlays'),
    getOverlayUrl: invoke('get-overlay-url'),
    scanBackgrounds: invoke('scan-backgrounds'),
    getBackgroundUrl: invoke('get-background-url'),
    createDesktopShortcut: invoke('create-desktop-shortcut'),
    getProjectInfo: invoke('get-project-info'),
    launchNewInstance: invoke('launch-new-instance'),
    openExistingProject: invoke('open-existing-project'),
    openExistingProjectFolder: invoke('open-existing-project-folder'),
    openExistingProjectFile: invoke('open-existing-project-file'),
    startupCreateProject: invoke('startup-create-project'),
    startupOpenProjectFolder: invoke('startup-open-project-folder'),
    startupOpenProjectFile: invoke('startup-open-project-file'),
    startupCancel: invoke('startup-cancel'),
    registerFvpAssociation: invoke('register-fvp-association'),
    qwenPoolStatus: invoke('qwen-pool-status'),
    qwenPoolReset: invoke('qwen-pool-reset'),
    qwenVisionKeysStatus: invoke('qwen-vision-keys-status'),
    qwenVisionKeysSave: (payload) => ipcRenderer.invoke('qwen-vision-keys-save', payload || {}),
    visionHealthStatus: invoke('vision-health-status'),
    visionHealthLiveCheck: (options) => ipcRenderer.invoke('vision-health-live-check', options || {}),
    getVisionBackend: invoke('get-vision-backend'),
    setVisionBackend: invoke('set-vision-backend'),
    lightningPoolList: invoke('lightning-pool-list'),
    lightningPoolAdd: (account) => ipcRenderer.invoke('lightning-pool-add', account || {}),
    lightningPoolRemove: invoke('lightning-pool-remove'),
    lightningPoolReset: invoke('lightning-pool-reset'),
    lightningPoolUpdate: (id, patch) => ipcRenderer.invoke('lightning-pool-update', { id, patch }),
    lightningPoolGetActive: invoke('lightning-pool-get-active'),
    lightningPoolSetActive: invoke('lightning-pool-set-active'),
    lightningProvision: invoke('lightning-provision'),
    lightningCheck: invoke('lightning-check'),
    lightningValidate: (account) => ipcRenderer.invoke('lightning-validate', account || {}),
    onLightningProvisionProgress: subscribe('lightning-provision-progress'),
    openFootageResources: invoke('open-footage-resources'),
    footageResourcesGet: invoke('footage-resources-get'),
    footageResourcesSet: (payload) => ipcRenderer.invoke('footage-resources-set', payload || {}),
    resourceEnvStatus: invoke('resource-env-status'),
    resourceEnvSave: (payload) => ipcRenderer.invoke('resource-env-save', payload || {}),
    resourceEnvClean: invoke('resource-env-clean'),
    resourceEnvLiveCheck: (options) => ipcRenderer.invoke('resource-env-live-check', options || {}),
    cloudAccountSlotsStatus: invoke('cloud-account-slots-status'),
    cloudAccountSlotsSave: (payload) => ipcRenderer.invoke('cloud-account-slots-save', payload || {}),
    cloudAccountSlotCheck: (payload) => ipcRenderer.invoke('cloud-account-slot-check', payload || {}),
    onFootageResourcesUpdated: subscribe('footage-resources-updated', { replace: true }),
    learnStyle: invoke('learn-style'),
    learnStyleMulti: invoke('learn-style-multi'),
    compareStyle: invoke('compare-style'),
    scanStyleProfiles: invoke('scan-style-profiles'),
    pickVideoFile: invoke('pick-video-file'),
    onLearnStyleProgress: subscribe('learn-style-progress', { replace: true }),
    saveProjectFile: invoke('save-project-file'),
    loadProjectFile: invoke('load-project-file'),
    getRecentProjects: invoke('get-recent-projects'),
    addRecentProject: invoke('add-recent-project'),
    startWebGLExport: invoke('start-webgl-export'),
    sendExportFramesBatch: invoke('export-frames-batch'),
    finishWebGLExport: invoke('finish-webgl-export'),
    cancelWebGLExport: invoke('cancel-webgl-export'),
    hyperframesGenerateProject: (payload) => ipcRenderer.invoke('hyperframes-generate-project', payload || {}),
    hyperframesRender: (payload) => ipcRenderer.invoke('hyperframes-render', payload || {}),
    openQAStudio: invoke('open-qa-studio'),
    openQAChat: invoke('open-qa-chat'),
    openStyleStudio: invoke('open-style-studio'),
    styleStudioStart: invoke('style-studio-start'),
    styleStudioAddVideo: invoke('style-studio-add-video'),
    styleStudioChat: invoke('style-studio-chat'),
    styleStudioAnalyzeScript: invoke('style-studio-analyze-script'),
    styleStudioExtractProfile: invoke('style-studio-extract-profile'),
    styleStudioSaveProfile: invoke('style-studio-save-profile'),
    styleStudioEndSession: invoke('style-studio-end-session'),
    styleStudioSessionInfo: invoke('style-studio-session-info'),
    styleStudioSetCodeAccess: invoke('style-studio-set-code-access'),
    styleStudioSetProjectContext: invoke('style-studio-set-project-context'),
    styleStudioCheckSaved: invoke('style-studio-check-saved'),
    styleStudioRestore: invoke('style-studio-restore'),
    styleStudioDiscardSaved: invoke('style-studio-discard-saved'),
    styleStudioLoadMemory: invoke('style-studio-load-memory'),
    styleStudioSaveMemory: invoke('style-studio-save-memory'),
    styleStudioDeleteMemory: invoke('style-studio-delete-memory'),
    styleStudioClearMemory: invoke('style-studio-clear-memory'),
    styleStudioPickAudio: invoke('style-studio-pick-audio'),
    styleStudioTranscribeAudio: invoke('style-studio-transcribe-audio'),
    styleStudioGetTranscriptInfo: invoke('style-studio-get-transcript-info'),
    onStyleStudioTranscribeProgress: subscribe('style-studio-transcribe-progress', { replace: true }),
    onStyleStudioProgress: subscribe('style-studio-progress', { replace: true }),
    qaAgentInitLog: invoke('qa-agent-init-log'),
    qaAgentSetProvider: invoke('qa-agent-set-provider'),
    qaAgentAnalyzeScene: invoke('qa-agent-analyze-scene'),
    qaAgentLog: invoke('qa-agent-log'),
    qaReplaceSceneMedia: invoke('qa-replace-scene-media'),
    onQAReplaceProgress: subscribe('qa-replacer-progress', { replace: true }),
    qaChatGetNicheList: invoke('qa-chat-niches'),
    qaChatSend: invoke('qa-chat-send'),
    // Agent remote control (MCP / REST). The main process forwards an outside
    // agent's request here; ui/js/remote-control.js answers on the same id.
    onRemoteCommand: subscribe('remote-command', { replace: true }),
    remoteCommandResult: (payload) => ipcRenderer.invoke('remote-command-result', payload || {}),
    remoteAccessStatus: invoke('remote-access-status'),
    remoteAccessSet: (payload) => ipcRenderer.invoke('remote-access-set', payload || {}),
    // AI Connections: keys go in, never come back out.
    aiConnectionsGet: invoke('ai-connections-get'),
    aiConnectionsSave: (payload) => ipcRenderer.invoke('ai-connections-save', payload || {}),
    aiConnectionsTest: (payload) => ipcRenderer.invoke('ai-connections-test', payload || {}),
};

const ROLE_METHODS = Object.freeze({
    startup: [
        'startupCreateProject', 'startupOpenProjectFolder', 'startupOpenProjectFile', 'startupCancel',
    ],
    'footage-resources': [
        'footageResourcesGet', 'footageResourcesSet',
        'qwenPoolStatus', 'qwenPoolReset', 'qwenVisionKeysStatus', 'qwenVisionKeysSave',
        'visionHealthStatus', 'visionHealthLiveCheck',
        'resourceEnvStatus', 'resourceEnvSave', 'resourceEnvClean', 'resourceEnvLiveCheck',
        'cloudAccountSlotsStatus', 'cloudAccountSlotsSave', 'cloudAccountSlotCheck',
    ],
    'qa-studio': [
        'loadVideoPlan', 'loadProjectFile', 'getProjectInfo',
        'loadQAResults', 'saveQAResults', 'pushPlanToMain', 'saveVideoPlan',
        'qaPreCropMedia', 'getSceneMediaPath', 'getFileUrl', 'getBackgroundUrl', 'getCountryGeoJSON',
        'startWebGLExport', 'sendExportFramesBatch', 'finishWebGLExport', 'cancelWebGLExport',
        'cancelProcess', 'qaAgentInitLog', 'qaAgentSetProvider', 'qaAgentAnalyzeScene',
        'qaAgentLog', 'qaReplaceSceneMedia', 'onQAReplaceProgress', 'qaChatSend',
    ],
    'qa-chat': [
        'loadVideoPlan', 'qaChatGetNicheList', 'qaChatSend',
    ],
    'style-studio': [
        'pickVideoFile',
        'styleStudioStart', 'styleStudioAddVideo', 'styleStudioChat',
        'styleStudioAnalyzeScript', 'styleStudioExtractProfile', 'styleStudioSaveProfile',
        'styleStudioEndSession', 'styleStudioSessionInfo', 'styleStudioSetCodeAccess',
        'styleStudioSetProjectContext', 'styleStudioCheckSaved', 'styleStudioRestore',
        'styleStudioDiscardSaved', 'styleStudioLoadMemory', 'styleStudioSaveMemory',
        'styleStudioDeleteMemory', 'styleStudioClearMemory', 'styleStudioPickAudio',
        'styleStudioTranscribeAudio', 'styleStudioGetTranscriptInfo',
        'onStyleStudioTranscribeProgress', 'onStyleStudioProgress',
    ],
});

const allowedMethods = windowRole === 'main'
    ? Object.keys(fullApi)
    : (ROLE_METHODS[windowRole] || []);
const publicApi = Object.fromEntries(
    allowedMethods
        .filter((name) => typeof fullApi[name] === 'function')
        .map((name) => [name, fullApi[name]])
);

contextBridge.exposeInMainWorld('electronAPI', publicApi);
