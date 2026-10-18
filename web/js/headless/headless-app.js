/**
 * ComfyDrawer — HeadlessApp
 *
 * Stand-in for the slice of ComfyUI's `app` that ComfyBridge and the Deck /
 * XYZ Plot gadgets use, on the standalone page. It keeps the open workflows
 * (HeadlessGraphs loaded from user/default/workflows, like the frontend's
 * workflow tabs), saves a workflow back to its file when asked, queues
 * prompts the way the frontend does (control-after-generate, DrawerSeed,
 * rgthree Seed) and keeps node outputs from server events.
 *
 * Edits are never written to the file on their own. Like the frontend, an
 * open workflow with unsaved changes is kept as a draft in localStorage, so
 * a reload (or a phone dropping the page) restores it still unsaved. Tabs
 * and drafts use the frontend's own keys and format (workflow-persistence.js),
 * so ComfyUI and this page in one browser show the same ones.
 *
 * `graph`, `file`, `nodeOutputs` and `saveState` are those of the active
 * workflow, which is what ComfyBridge and the gadgets see.
 *
 * Events (on this EventTarget):
 *   workflow-changed {path, name}           the active workflow changed
 *   tabs-changed                            a workflow was opened or closed
 *   save-state {workflow, state, error?}    '' | modified | saving | saved | conflict | error
 *   queue-error {message}                   a prompt could not be built or was rejected
 */
import { HeadlessGraph } from './headless-graph.js';
import { buildPrompt } from './prompt-builder.js';
import { applyValueControls } from './value-control.js';
import { sanitizeComfyDrawerWorkflowExtra } from '../utils.js';
import { WORKFLOW_PREFIX, readOpenTabs, writeOpenTabs, readDraft, writeDraft, removeDraft } from './workflow-persistence.js';

const WORKFLOW_DIR = 'workflows';
/** The frontend's workflow sidebar index; `favorites` are its bookmarks. */
const INDEX_PATH = '.index.json';
/** Where this page kept tabs and drafts before it shared the frontend's (moved once, then removed). */
const LEGACY_OPEN_KEY = 'comfy-drawer-standalone-open-workflows';
const LEGACY_DRAFT_PREFIX = 'comfy-drawer-standalone-draft:';
const DRAFT_DELAY_MS = 500;
const PRESET_TEXT_KEY = 'pysssss.PresetText.Presets';
const PRESET_TEXT_REGEX = '(?:^|[^\\w])(?<replace>@(?<id>[\\w-]+))';
const RGTHREE_SEED_SPECIAL = new Set([-1, -2, -3]);

const userdataPath = (path) => `/userdata/${encodeURIComponent(`${WORKFLOW_DIR}/${path}`)}`;
/** Display name: file name without folders and without .json. */
export const workflowName = (path) => path.split('/').pop().replace(/\.json$/, '');

export class SaveConflictError extends Error {
    constructor(path) {
        super(`"${path}" was changed elsewhere since it was opened`);
        this.name = 'SaveConflictError';
    }
}

/** One open workflow (a frontend workflow tab). */
export class OpenWorkflow {
    constructor(graph, file, key = WORKFLOW_PREFIX + file.path) {
        this.graph = graph;
        /** @type {{path: string|null, name: string, modified: number|null}} */
        this.file = file;
        /**
         * The frontend's workflow path: "workflows/<file>", or for a workflow
         * never saved "workflows/<name>.json" with no file behind it. Keys
         * the open-tab list and the draft.
         */
        this.key = key;
        this.nodeOutputs = {};
        /**
         * Opened from a draft (which may hold the frontend's structural edits,
         * moved nodes, view): unsaved until saved or reloaded from the file.
         */
        this.fromDraft = false;
        /** '' | modified | saving | saved | conflict | error */
        this.saveState = '';
        this.saving = null;
        this.draftTimer = null;
    }

    /** Unsaved changes: edited since the last save, or never saved at all. */
    get modified() {
        return !this.file.path || this.fromDraft || this.graph.isModified();
    }
}

const readJSON = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};

/** The frontend's getUnconflictedPath: "dir/name (2).json", "(3)", … */
function unconflictedPath(path, taken) {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const [dir, stem, ext] = [path.slice(0, slash), path.slice(slash + 1, dot), path.slice(dot + 1)];
    let candidate = path;
    for (let n = 2; taken.has(candidate); n++) candidate = `${dir}/${stem} (${n}).${ext}`;
    return candidate;
}

export class HeadlessApp extends EventTarget {
    #presetTextInstalled = false;
    #queueing = false;
    /** Nodes whose controls already ran once ("before" mode skips the first queue). */
    #controlRuns = new WeakSet();
    #lastRgthreeSeeds = new Map();
    /** prompt_id → the workflow that queued it, so outputs land in that tab. */
    #promptOwners = new Map();
    #blank = new OpenWorkflow(new HeadlessGraph({ nodes: [], links: [] }, {}), { path: null, name: '', modified: null }, '');

    /**
     * @param {import('../core/standalone-api.js').StandaloneApi} api
     * @param {object} settings - app.ui.settings-like object (StandaloneApi.loadSettings)
     */
    constructor(api, settings) {
        super();
        this.api = api;
        this.ui = { settings };
        this.objectInfo = {};
        this.canvas = null;
        this.runningNodeId = null;
        /** @type {OpenWorkflow[]} */
        this.workflows = [];
        /** @type {OpenWorkflow|null} */
        this.active = null;
        this.extensionManager = { workflow: { activeWorkflow: null } };
    }

    get #current() { return this.active ?? this.#blank; }
    get graph() { return this.#current.graph; }
    get rootGraph() { return this.#current.graph; }
    get file() { return this.#current.file; }
    get nodeOutputs() { return this.#current.nodeOutputs; }
    get saveState() { return this.#current.saveState; }

    async init() {
        const [info, extensions] = await Promise.all([
            this.api.fetchApi('/object_info').then(r => r.json()),
            this.api.fetchApi('/extensions').then(r => (r.ok ? r.json() : [])).catch(() => []),
        ]);
        this.objectInfo = info ?? {};
        this.#presetTextInstalled = extensions.some(p => String(p).endsWith('/presetText.js'));
        this.api.addEventListener('executing', (e) => { this.runningNodeId = e.detail ?? null; });
        this.api.addEventListener('executed', (e) => {
            const id = e.detail?.display_node ?? e.detail?.node;
            if (id == null) return;
            const owner = this.#promptOwners.get(e.detail.prompt_id) ?? this.active;
            if (owner) owner.nodeOutputs[String(id)] = e.detail.output;
        });
        this.api.addEventListener('execution_success', (e) => this.#promptOwners.delete(e.detail?.prompt_id));
        this.api.connect();
        // Leaving the page (or a phone switching apps) writes pending drafts now.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') for (const wf of this.workflows) this.#writeDraft(wf);
        });
    }

    /** Every file under user/default/workflows: [{path, size, modified}]. */
    async listWorkflows() {
        const resp = await this.api.fetchApi(`/userdata?dir=${WORKFLOW_DIR}&recurse=true&full_info=true`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const files = await resp.json();
        return files.filter(f => typeof f?.path === 'string' && !f.path.split('/').pop().startsWith('.'));
    }

    async #readIndex() {
        const resp = await this.api.fetchApi(userdataPath(INDEX_PATH), { cache: 'no-store' });
        if (resp.status === 404) return {};
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return (await resp.json().catch(() => null)) ?? {};
    }

    /** Bookmarked workflow paths (relative to workflows/), shared with the ComfyUI sidebar. */
    async listBookmarks() {
        const index = await this.#readIndex();
        const prefix = `${WORKFLOW_DIR}/`;
        return (index.favorites ?? [])
            .filter(p => typeof p === 'string' && p.startsWith(prefix))
            .map(p => p.slice(prefix.length));
    }

    /** Add or remove a bookmark in the frontend's sidebar index. */
    async setBookmarked(path, bookmarked) {
        const index = await this.#readIndex();
        const key = `${WORKFLOW_DIR}/${path}`;
        const favorites = (index.favorites ?? []).filter(p => p !== key);
        if (bookmarked) favorites.push(key);
        const resp = await this.api.fetchApi(`${userdataPath(INDEX_PATH)}?overwrite=true`, {
            method: 'POST',
            body: JSON.stringify({ ...index, favorites }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    }

    async #load(path) {
        const [resp, files] = await Promise.all([
            this.api.fetchApi(userdataPath(path), { cache: 'no-store' }),
            this.listWorkflows(),
        ]);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const workflow = JSON.parse(await resp.text());
        const modified = files.find(f => f.path === path)?.modified ?? null;
        return { graph: new HeadlessGraph(workflow, this.objectInfo), file: { path, name: workflowName(path), modified } };
    }

    #track(wf) {
        wf.graph.onChange = () => {
            this.#emitSaveState(wf, wf.modified ? 'modified' : '');
            clearTimeout(wf.draftTimer);
            wf.draftTimer = setTimeout(() => this.#writeDraft(wf), DRAFT_DELAY_MS);
        };
    }

    #add(wf) {
        this.#track(wf);
        this.workflows.push(wf);
    }

    /** Open user/default/workflows/<path> (or switch to it when already open). */
    async openWorkflow(path) {
        const open = this.workflows.find(wf => wf.file.path === path);
        if (open) return this.activate(open);
        const { graph, file } = await this.#load(path);
        this.#add(this.#fromFile(graph, file));
        await this.activate(this.workflows.at(-1));
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /** Re-read a workflow from disk, dropping its unsaved changes. */
    async reloadWorkflow(wf) {
        const { graph, file } = await this.#load(wf.file.path);
        wf.graph = graph;
        wf.file = file;
        wf.fromDraft = false;
        wf.nodeOutputs = {};
        this.#track(wf);
        this.#dropDraft(wf);
        this.#emitSaveState(wf, '');
        if (wf === this.active) this.#announceActive();
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /** ComfyUI app.loadGraphData: open workflow JSON as a new unsaved workflow. */
    async loadGraphData(workflow, _clean, _restoreView, name) {
        const file = { path: null, name: String(name || '').replace(/\.[^.]+$/, '') || 'Untitled', modified: null };
        const wf = new OpenWorkflow(new HeadlessGraph(workflow, this.objectInfo), file, await this.#temporaryPath(file.name));
        this.#add(wf);
        wf.saveState = 'modified';
        this.#writeDraft(wf);
        await this.activate(wf);
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /** A frontend path for a never-saved workflow, clear of open tabs and files. */
    async #temporaryPath(name) {
        const files = await this.listWorkflows().catch(() => []);
        const taken = new Set([...files.map(f => WORKFLOW_PREFIX + f.path), ...this.workflows.map(wf => wf.key)]);
        return unconflictedPath(`${WORKFLOW_PREFIX}${name}.json`, taken);
    }

    /** Make an open workflow the active one. */
    async activate(wf) {
        if (wf === this.active) return;
        this.active = wf;
        this.#announceActive();
    }

    /** Close an open workflow, discarding unsaved changes (callers confirm first). */
    async closeWorkflow(wf) {
        const i = this.workflows.indexOf(wf);
        if (i === -1) return;
        clearTimeout(wf.draftTimer);
        this.#dropDraft(wf);
        this.workflows.splice(i, 1);
        if (wf === this.active) {
            this.active = this.workflows[Math.min(i, this.workflows.length - 1)] ?? null;
            this.#announceActive();
        }
        this.#rememberOpen();
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /**
     * Reopen the tabs the frontend or this page had open last (shared
     * storage). Like the frontend: a saved workflow takes its draft unless
     * the file is newer (the draft is then dropped), a never-saved one comes
     * back from its draft, and files that are gone are skipped.
     */
    async restoreOpenWorkflows() {
        this.#moveLegacyStorage();
        const tabs = readOpenTabs();
        if (!tabs) return;
        const files = new Map((await this.listWorkflows().catch(() => [])).map(f => [WORKFLOW_PREFIX + f.path, f]));
        for (const key of tabs.paths) {
            const draft = readDraft(key);
            try {
                if (files.has(key)) {
                    const { graph, file } = await this.#load(key.slice(WORKFLOW_PREFIX.length));
                    this.#add(this.#fromFile(graph, file));
                } else if (draft?.isTemporary) {
                    const file = { path: null, name: draft.name.split('/').pop().replace(/\.json$/, ''), modified: null };
                    const wf = new OpenWorkflow(new HeadlessGraph(draft.workflow, this.objectInfo), file, key);
                    this.#add(wf);
                    wf.saveState = 'modified';
                }
            } catch { /* unreadable: skipped */ }
        }
        const active = this.workflows.find(wf => wf.key === tabs.paths[tabs.activeIndex]) ?? this.workflows[0];
        if (active) await this.activate(active);
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /**
     * Tabs and drafts this page saved under its own keys before it used the
     * frontend's: drafts move over, tabs not already open are appended.
     */
    #moveLegacyStorage() {
        const legacy = readJSON(LEGACY_OPEN_KEY);
        if (!legacy) return;
        const tabs = readOpenTabs() ?? { paths: [], activeIndex: 0 };
        for (const entry of Array.isArray(legacy.open) ? legacy.open : []) {
            const draft = readJSON(LEGACY_DRAFT_PREFIX + entry.key);
            const key = entry.path
                ? WORKFLOW_PREFIX + entry.path
                : unconflictedPath(`${WORKFLOW_PREFIX}${draft?.file?.name || 'Untitled'}.json`, new Set(tabs.paths));
            if (draft?.workflow) writeDraft(key, draft.workflow, { name: key.slice(WORKFLOW_PREFIX.length), isTemporary: !entry.path });
            if ((entry.path || draft?.workflow) && !tabs.paths.includes(key)) tabs.paths.push(key);
            if (entry.key === legacy.active) tabs.activeIndex = tabs.paths.indexOf(key);
            try { localStorage.removeItem(LEGACY_DRAFT_PREFIX + entry.key); } catch { /* unavailable */ }
        }
        if (tabs.paths.length) writeOpenTabs(tabs.paths, Math.max(0, Math.min(tabs.activeIndex, tabs.paths.length - 1)));
        try { localStorage.removeItem(LEGACY_OPEN_KEY); } catch { /* unavailable */ }
    }

    /**
     * A saved workflow opened from its draft (left by this page or the
     * frontend) when there is one, as the frontend's ComfyWorkflow.load does:
     * a draft older than the file is stale and dropped. The draft is taken
     * whole — the frontend's may move or rewire nodes — and the frontend
     * keeps a draft only while there are unsaved changes.
     */
    #fromFile(graph, file) {
        const key = WORKFLOW_PREFIX + file.path;
        const draft = readDraft(key);
        if (draft && draft.updatedAt < file.modified) removeDraft(key);
        if (!draft || draft.updatedAt < file.modified) return new OpenWorkflow(graph, file);
        const wf = new OpenWorkflow(new HeadlessGraph(draft.workflow, this.objectInfo), file);
        wf.fromDraft = true;
        wf.saveState = 'modified';
        return wf;
    }

    #rememberOpen() {
        writeOpenTabs(this.workflows.map(wf => wf.key), Math.max(0, this.workflows.indexOf(this.active)));
    }

    #writeDraft(wf) {
        clearTimeout(wf.draftTimer);
        wf.draftTimer = null;
        if (!wf.modified) {
            this.#dropDraft(wf);
            return;
        }
        // Storage full or unavailable: the in-memory edits remain.
        writeDraft(wf.key, wf.graph.serialize(), { name: wf.key.slice(WORKFLOW_PREFIX.length), isTemporary: !wf.file.path });
        this.#rememberOpen();
    }

    #dropDraft(wf) {
        removeDraft(wf.key);
    }

    #announceActive() {
        const { file } = this.#current;
        this.runningNodeId = null;
        this.extensionManager.workflow.activeWorkflow = !this.active ? null : file.path
            ? { path: file.path, key: file.path, filename: file.name }
            : { filename: file.name };
        this.#rememberOpen();
        this.dispatchEvent(new CustomEvent('workflow-changed', { detail: { path: file.path, name: file.name } }));
        // DrawerShell refreshes gadgets on this event (same as a ComfyUI tab switch).
        document.dispatchEvent(new CustomEvent('drawer:graph-configured'));
    }

    #emitSaveState(wf, state, error) {
        if (state === wf.saveState && !error) return;
        wf.saveState = state;
        this.dispatchEvent(new CustomEvent('save-state', { detail: { workflow: wf, state, error } }));
    }

    /**
     * Write a workflow back to its file. Refuses (SaveConflictError) when the
     * file changed since it was opened or last saved, unless `force`.
     * @param {{workflow?: OpenWorkflow, force?: boolean, path?: string}} [opts]
     *   `path` saves as a new file (Save as)
     */
    async save({ workflow: wf = this.active, force = false, path = wf?.file.path } = {}) {
        if (!wf || !path) throw new Error('No file to save to');
        await wf.saving;
        wf.saving = (async () => {
            this.#emitSaveState(wf, 'saving');
            try {
                const sameFile = path === wf.file.path;
                const onDisk = (await this.listWorkflows()).find(f => f.path === path);
                if (!force && sameFile && onDisk && wf.file.modified != null && onDisk.modified !== wf.file.modified) {
                    throw new SaveConflictError(path);
                }
                if (!force && !sameFile && onDisk) throw new SaveConflictError(path);
                const resp = await this.api.fetchApi(`${userdataPath(path)}?overwrite=true&full_info=true`, {
                    method: 'POST',
                    body: JSON.stringify(sanitizeComfyDrawerWorkflowExtra(wf.graph.serialize())),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const info = await resp.json().catch(() => null);
                clearTimeout(wf.draftTimer);
                this.#dropDraft(wf);
                wf.graph.markSaved();
                wf.fromDraft = false;
                wf.file = { path, name: workflowName(path), modified: info?.modified ?? null };
                wf.key = WORKFLOW_PREFIX + path;
                this.#emitSaveState(wf, 'saved');
                this.#rememberOpen();
                if (!sameFile) {
                    if (wf === this.active) this.#announceActive();
                    this.dispatchEvent(new CustomEvent('tabs-changed'));
                }
            } catch (e) {
                this.#emitSaveState(wf, e instanceof SaveConflictError ? 'conflict' : 'error', e);
                throw e;
            }
        })();
        try {
            await wf.saving;
        } finally {
            wf.saving = null;
        }
    }

    /** Workflow JSON as ComfyUI would save it (Drawer extra sanitized). */
    exportWorkflow() {
        return sanitizeComfyDrawerWorkflowExtra(this.graph.serialize());
    }

    #presetText() {
        if (!this.#presetTextInstalled) return null;
        let presets = null;
        try { presets = JSON.parse(localStorage.getItem(PRESET_TEXT_KEY)); } catch { /* none saved */ }
        if (!Array.isArray(presets) || !presets.length) presets = [{ name: 'default negative', value: 'worst quality' }];
        const source = this.ui.settings.getSettingValue('pysssss.PresetText.ReplacementRegex', PRESET_TEXT_REGEX);
        if (!source) return null;
        try {
            return { regex: new RegExp(source, 'g'), presets };
        } catch {
            return null;
        }
    }

    /** ComfyUI app.graphToPrompt. */
    async graphToPrompt() {
        return {
            output: buildPrompt(this.graph, { presetText: this.#presetText() }),
            workflow: this.exportWorkflow(),
        };
    }

    /** DrawerSeed nodes in "randomize" get a fresh seed per queued prompt. */
    #randomizeDrawerSeeds() {
        if (window.__xyzSweepActive) return;
        for (const node of this.graph._nodes) {
            if (node.type !== 'DrawerSeed') continue;
            const mode = node.widgets.find(w => w.name === 'mode');
            const seed = node.widgets.find(w => w.name === 'seed_value');
            if (mode?.value !== 'randomize' || !seed) continue;
            seed.callback(crypto.getRandomValues(new Uint32Array(1))[0]);
        }
    }

    /**
     * rgthree Seed: -1 / -2 / -3 mean random / last+1 / last-1, resolved when
     * the prompt is sent (rgthree rewrites the outgoing request).
     */
    #resolveRgthreeSeeds(output, workflow) {
        for (const node of this.graph._nodes) {
            if (node.type !== 'Seed (rgthree)') continue;
            const entry = output[String(node.id)];
            const widget = node.widgets.find(w => w.name === 'seed');
            if (!entry || !widget || !RGTHREE_SEED_SPECIAL.has(entry.inputs.seed)) continue;
            const last = this.#lastRgthreeSeeds.get(node.id);
            let seed;
            if (entry.inputs.seed === -2 && last != null) seed = last + 1;
            else if (entry.inputs.seed === -3 && last != null) seed = last - 1;
            else {
                const step = (widget.options.step || 10) / 10;
                const min = Number(node.properties.randomMin || 0);
                const max = Number(node.properties.randomMax || 1125899906842624);
                seed = Math.floor(Math.random() * ((max - min) / step)) * step + min;
                if (RGTHREE_SEED_SPECIAL.has(seed)) seed = 0;
            }
            entry.inputs.seed = seed;
            const saved = workflow.nodes.find(n => n.id === node.id);
            if (Array.isArray(saved?.widgets_values)) saved.widgets_values[widget.index] = seed;
            this.#lastRgthreeSeeds.set(node.id, seed);
        }
    }

    #applyControls(phase) {
        const before = this.ui.settings.getSettingValue('Comfy.WidgetControlMode', 'after') === 'before';
        if (phase === 'after') {
            if (!before) applyValueControls(this.graph.allNodesDeep());
            return;
        }
        if (!before) return;
        // "before" mode skips each widget's first queue, like the frontend.
        const nodes = [...this.graph.allNodesDeep()];
        const ready = nodes.filter(n => this.#controlRuns.has(n));
        nodes.forEach(n => this.#controlRuns.add(n));
        applyValueControls(ready);
    }

    /**
     * ComfyUI app.queuePrompt(number, batchCount, queueNodeIds).
     * @returns {Promise<boolean>} false when a prompt was refused or rejected
     */
    async queuePrompt(number = 0, batchCount = 1, queueNodeIds) {
        if (this.#queueing) return false;
        this.#queueing = true;
        const targets = Array.isArray(queueNodeIds) ? queueNodeIds : queueNodeIds?.queueNodeIds;
        try {
            for (let i = 0; i < batchCount; i++) {
                this.#applyControls('before');
                this.#randomizeDrawerSeeds();
                let prompt;
                try {
                    prompt = await this.graphToPrompt();
                } catch (e) {
                    this.dispatchEvent(new CustomEvent('queue-error', { detail: { message: e.message } }));
                    return false;
                }
                this.#resolveRgthreeSeeds(prompt.output, prompt.workflow);
                const body = {
                    client_id: this.api.clientId ?? '',
                    prompt: prompt.output,
                    ...(targets?.length && { partial_execution_targets: targets.map(String) }),
                    extra_data: { extra_pnginfo: { workflow: prompt.workflow } },
                };
                if (number === -1) body.front = true;
                else if (number) body.number = number;
                const resp = await this.api.fetchApi('/prompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (resp.status === 200) {
                    const queued = await resp.json().catch(() => null);
                    if (queued?.prompt_id && this.active) this.#promptOwners.set(queued.prompt_id, this.active);
                }
                if (resp.status !== 200) {
                    const data = await resp.json().catch(() => null);
                    const message = data?.error?.message || data?.error || `HTTP ${resp.status}`;
                    const details = Object.values(data?.node_errors ?? {})
                        .flatMap(n => (n.errors ?? []).map(err => `${n.class_type}: ${err.message}${err.details ? ` (${err.details})` : ''}`));
                    this.dispatchEvent(new CustomEvent('queue-error', {
                        detail: { message: [message, ...details].join('\n') },
                    }));
                    return false;
                }
                this.#applyControls('after');
            }
            return true;
        } finally {
            this.#queueing = false;
        }
    }
}
