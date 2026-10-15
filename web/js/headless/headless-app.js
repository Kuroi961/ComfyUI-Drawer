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
 * a reload (or a phone dropping the page) restores it still unsaved.
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

const WORKFLOW_DIR = 'workflows';
/** The frontend's workflow sidebar index; `favorites` are its bookmarks. */
const INDEX_PATH = '.index.json';
const OPEN_WORKFLOWS_KEY = 'comfy-drawer-standalone-open-workflows';
const DRAFT_KEY_PREFIX = 'comfy-drawer-standalone-draft:';
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
    // Not randomUUID: it exists only in secure contexts, and the page is often
    // opened over plain http (a LAN or Tailscale address).
    constructor(graph, file, key = file.path ?? `unsaved:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`) {
        this.graph = graph;
        /** @type {{path: string|null, name: string, modified: number|null}} */
        this.file = file;
        /** Identity for the open-workflow list and its draft (the path, once saved). */
        this.key = key;
        this.nodeOutputs = {};
        /** '' | modified | saving | saved | conflict | error */
        this.saveState = '';
        this.saving = null;
        this.draftTimer = null;
    }

    /** Unsaved changes: edited since the last save, or never saved at all. */
    get modified() {
        return !this.file.path || this.graph.isModified();
    }
}

const readJSON = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};

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
        this.#add(new OpenWorkflow(graph, file));
        await this.activate(this.workflows.at(-1));
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /** Re-read a workflow from disk, dropping its unsaved changes. */
    async reloadWorkflow(wf) {
        const { graph, file } = await this.#load(wf.file.path);
        wf.graph = graph;
        wf.file = file;
        wf.nodeOutputs = {};
        this.#track(wf);
        this.#dropDraft(wf);
        this.#emitSaveState(wf, '');
        if (wf === this.active) this.#announceActive();
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /** ComfyUI app.loadGraphData: open workflow JSON as a new unsaved workflow. */
    async loadGraphData(workflow, _clean, _restoreView, name) {
        const wf = new OpenWorkflow(new HeadlessGraph(workflow, this.objectInfo), {
            path: null,
            name: String(name || '').replace(/\.[^.]+$/, '') || 'Untitled',
            modified: null,
        });
        this.#add(wf);
        wf.saveState = 'modified';
        this.#writeDraft(wf);
        await this.activate(wf);
        this.dispatchEvent(new CustomEvent('tabs-changed'));
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
     * Reopen the workflows that were open last time. A workflow with a draft
     * comes back from the draft, still unsaved; files that are gone are skipped.
     */
    async restoreOpenWorkflows() {
        const saved = readJSON(OPEN_WORKFLOWS_KEY);
        if (!Array.isArray(saved?.open)) return;
        for (const entry of saved.open) {
            const draft = readJSON(DRAFT_KEY_PREFIX + entry.key);
            try {
                if (draft?.workflow) {
                    const wf = new OpenWorkflow(new HeadlessGraph(draft.workflow, this.objectInfo), draft.file, entry.key);
                    // The draft is the edited state; diff against the file to know what changed.
                    if (wf.file.path) {
                        const onDisk = await this.#load(wf.file.path).catch(() => null);
                        if (onDisk) wf.graph = this.#graphWithBaseline(draft.workflow, onDisk.graph);
                    }
                    this.#add(wf);
                    wf.saveState = wf.modified ? 'modified' : '';
                } else if (entry.path) {
                    const { graph, file } = await this.#load(entry.path);
                    this.#add(new OpenWorkflow(graph, file));
                }
            } catch { /* renamed or deleted since */ }
        }
        const active = this.workflows.find(wf => wf.key === saved.active) ?? this.workflows[0];
        if (active) await this.activate(active);
        this.dispatchEvent(new CustomEvent('tabs-changed'));
    }

    /**
     * The file's graph with the draft's widget values and modes applied, so
     * isModified() compares the draft against what is on disk.
     */
    #graphWithBaseline(draftWorkflow, fileGraph) {
        const draft = new HeadlessGraph(draftWorkflow, this.objectInfo);
        const byKey = (graph) => new Map([...graph.allNodesDeep()].map(n => [`${n.graph.id ?? ''}/${n.id}`, n]));
        const drafted = byKey(draft);
        for (const [key, node] of byKey(fileGraph)) {
            const edited = drafted.get(key);
            if (!edited) continue;
            node.mode = edited.mode;
            node.widgets.forEach((w, i) => {
                if (!w.promoted && edited.widgets[i] && !edited.widgets[i].promoted) w.value = edited.widgets[i].value;
            });
        }
        fileGraph.extra = draft.extra;
        return fileGraph;
    }

    #rememberOpen() {
        try {
            localStorage.setItem(OPEN_WORKFLOWS_KEY, JSON.stringify({
                open: this.workflows.map(wf => ({ key: wf.key, path: wf.file.path })),
                active: this.active?.key ?? null,
            }));
        } catch { /* storage unavailable */ }
    }

    #writeDraft(wf) {
        clearTimeout(wf.draftTimer);
        wf.draftTimer = null;
        if (!wf.modified) {
            this.#dropDraft(wf);
            return;
        }
        try {
            localStorage.setItem(DRAFT_KEY_PREFIX + wf.key, JSON.stringify({ file: wf.file, workflow: wf.graph.serialize() }));
        } catch { /* storage full or unavailable: the in-memory edits remain */ }
        this.#rememberOpen();
    }

    #dropDraft(wf) {
        try { localStorage.removeItem(DRAFT_KEY_PREFIX + wf.key); } catch { /* storage unavailable */ }
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
                wf.file = { path, name: workflowName(path), modified: info?.modified ?? null };
                wf.key = path;
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
