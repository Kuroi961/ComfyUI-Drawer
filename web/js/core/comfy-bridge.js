/**
 * ComfyDrawer — ComfyBridge
 * Unified abstraction over ComfyUI's internal APIs.
 * Gadgets should use this instead of accessing app/api directly.
 */
export class ComfyBridge {
    #app = null;
    #api = null;

    /** Frontend versions this code has been tested against */
    static TESTED_VERSIONS = ['1.41', '1.42'];

    constructor(app, api) {
        this.#app = app;
        this.#api = api;
        this.#checkFrontendVersion();
    }

    /**
     * Log a warning if the frontend version is untested.
     * Non-blocking — just an early-warning mechanism.
     */
    #checkFrontendVersion() {
        try {
            const ver =
                this.#app?.versionString ??
                document.querySelector('meta[name="comfyui-version"]')?.content;
            if (!ver) return;

            const major = ver.split('.').slice(0, 2).join('.');
            if (!ComfyBridge.TESTED_VERSIONS.includes(major)) {
                console.warn(
                    `[ComfyDrawer] Frontend v${ver} is untested. ` +
                    `Tested: ${ComfyBridge.TESTED_VERSIONS.join(', ')}. ` +
                    `Some features may not work correctly.`
                );
            }
        } catch { /* non-critical */ }
    }

    /* ── Graph Operations ── */

    /** Get all nodes of a given type */
    getNodesByType(type) {
        if (!this.#app?.graph) return [];
        return this.#app.graph._nodes.filter(n => n.type === type);
    }

    /** Get a specific node by ID */
    getNodeById(id) {
        return this.#app?.graph?.getNodeById(id) ?? null;
    }

    /** Set a widget value on a node */
    setWidgetValue(nodeId, widgetName, value) {
        const node = this.getNodeById(nodeId);
        if (!node?.widgets) return false;
        const widget = node.widgets.find(w => w.name === widgetName);
        if (!widget) return false;
        widget.value = value;
        widget.callback?.(value, this.#app?.canvas, node, null, null);
        this.setDirtyCanvas();
        return true;
    }

    /**
     * Invoke a widget's callback with proper LiteGraph arguments.
     * Use this when you already have a direct reference to the widget object.
     * Sets widget.value, fires the callback, and marks the canvas dirty.
     * @param {LGraphNode} node - The node owning the widget
     * @param {object} widget - The widget object
     * @param {*} value - The new value to set
     */
    invokeWidgetCallback(node, widget, value) {
        widget.value = value;
        widget.callback?.(value, this.#app?.canvas, node, null, null);
        this.setDirtyCanvas();
    }

    /** Get a widget value from a node */
    getWidgetValue(nodeId, widgetName) {
        const node = this.getNodeById(nodeId);
        if (!node?.widgets) return undefined;
        const widget = node.widgets.find(w => w.name === widgetName);
        return widget?.value;
    }

    /** Get widget options for a node widget (e.g. list of available images) */
    getWidgetOptions(nodeId, widgetName) {
        const node = this.getNodeById(nodeId);
        if (!node?.widgets) return [];
        const widget = node.widgets.find(w => w.name === widgetName);
        return widget?.options?.values ?? [];
    }

    /** Add value to widget options if not present */
    addWidgetOption(nodeId, widgetName, value) {
        const node = this.getNodeById(nodeId);
        if (!node?.widgets) return false;
        const widget = node.widgets.find(w => w.name === widgetName);
        if (!widget?.options?.values) return false;
        if (!widget.options.values.includes(value)) {
            widget.options.values.push(value);
        }
        return true;
    }

    /**
     * Load a workflow from JSON data.
     * @param {object} workflowData - Serialized workflow (nodes/links/etc.)
     * @param {string} [name] - Optional workflow display name (shown in tab title)
     */
    async loadWorkflow(workflowData, name) {
        if (!this.#app || typeof this.#app.loadGraphData !== 'function') {
            throw new Error('ComfyUI app.loadGraphData not available');
        }
        // Ensure required arrays exist (use-everywhere hook expects nodes/links)
        if (!workflowData.nodes) workflowData.nodes = [];
        if (!workflowData.links) workflowData.links = [];

        // Pass name as 4th arg so ComfyUI's afterLoadNewGraph() sets the tab
        // title natively. ComfyUI V2 handles this correctly on its own.
        // Signature: loadGraphData(data, clean, restoreView, workflowName, options)
        const baseName = name ? name.replace(/\.[^.]+$/, '') : null;
        await this.#app.loadGraphData(workflowData, true, true, baseName);
    }

    /**
     * Open a File as workflow via ComfyUI's native handleFile.
     * ComfyUI V2 automatically sets the tab name from the File.name.
     * @param {File} file - The File/Blob to hand to ComfyUI
     */
    async handleFile(file) {
        if (!this.#app?.handleFile) {
            console.warn('[ComfyBridge] app.handleFile not available');
            return;
        }
        await this.#app.handleFile(file);
    }

    /**
     * Set the active workflow tab name in ComfyUI V2 UI.
     * FALLBACK ONLY — prefer passing `name` to loadWorkflow() which delegates
     * to ComfyUI's native afterLoadNewGraph(). This method directly writes to
     * Pinia store internals and may break on frontend updates.
     * @param {string} name - Display name (extension will be stripped)
     */
    setWorkflowName(name) {
        try {
            const wfStore = this.#app.extensionManager?.workflow
                ?? this.#app.workflowManager;
            if (!wfStore?.activeWorkflow) return;

            let baseName = name.replace(/\.[^.]+$/, '');

            // Deduplicate: append (2), (3), ... if name already exists
            const existing = (wfStore.openWorkflows || [])
                .map(w => w.filename || w.name || '')
                .filter(n => n !== (wfStore.activeWorkflow.filename ?? wfStore.activeWorkflow.name));
            if (existing.includes(baseName)) {
                let i = 2;
                while (existing.includes(`${baseName} (${i})`)) i++;
                baseName = `${baseName} (${i})`;
            }

            // Try known property names (defensive against renames)
            if ('filename' in wfStore.activeWorkflow) {
                wfStore.activeWorkflow.filename = baseName;
            } else if ('name' in wfStore.activeWorkflow) {
                wfStore.activeWorkflow.name = baseName;
            }
        } catch {
            console.warn('[ComfyBridge] setWorkflowName failed — API may have changed');
        }
    }

    /** Export current workflow as JSON */
    exportWorkflow() {
        if (!this.#app?.graph) return null;
        return this.#app.graph.serialize();
    }

    /* ── Queue Operations ── */

    /**
     * Queue a prompt with full payload control (manual graphToPrompt).
     * Use this only when you need to customise the prompt payload.
     * For normal generation (Deck "Run" button etc.), prefer queuePromptSimple().
     */
    async queuePrompt(batchCount = 1) {
        try {
            const prompt = await this.#app.graphToPrompt();
            return this.#api.fetchApi('/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: this.#api.clientId,
                    prompt,
                    extra_data: { extra_pnginfo: { workflow: this.exportWorkflow() } },
                    front: false,
                    number: batchCount,
                }),
            });
        } catch (e) {
            throw new Error(`Queue failed: ${e.message}`);
        }
    }

    /** Interrupt current generation */
    async interrupt() {
        return this.#api.fetchApi('/interrupt', { method: 'POST' });
    }

    /* ── File Operations ── */

    /** Upload a file to ComfyUI */
    async uploadImage(file, subfolder = '', overwrite = true) {
        const formData = new FormData();
        formData.append('image', file);
        formData.append('subfolder', subfolder);
        formData.append('overwrite', overwrite.toString());
        const resp = await this.#api.fetchApi('/upload/image', {
            method: 'POST',
            body: formData,
        });
        if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
        return resp.json();
    }

    /** Get the URL for viewing an image
     * @param {string} filename
     * @param {string} [subfolder='']
     * @param {string} [type='output']
     * @param {object} [options]
     * @param {boolean} [options.bustCache=false] - Append &t=timestamp to bypass browser cache
     * @returns {string} Full URL (resolved via apiURL)
     */
    getImageUrl(filename, subfolder = '', type = 'output', options = {}) {
        let url = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
        if (options.bustCache) url += `&t=${Date.now()}`;
        return this.apiURL(url);
    }

    /* ── Utilities ── */

    /** Get the ComfyUI api object for direct access (escape hatch) */
    get api() { return this.#api; }

    /** Get the ComfyUI app object for direct access (escape hatch) */
    get app() { return this.#app; }

    /* ── Graph Access (Deck/Gadget-friendly) ── */

    /**
     * Get a stable identifier for the currently active workflow.
     * Used for per-workflow scoped storage (e.g. collapse states).
     * Falls back to 'default' if no workflow info is available.
     */
    get workflowId() {
        try {
            const wfStore = this.#app?.extensionManager?.workflow
                ?? this.#app?.workflowManager;
            const wf = wfStore?.activeWorkflow;
            return wf?.path || wf?.key || wf?.filename || wf?.name || 'default';
        } catch { return 'default'; }
    }

    /** Get all graph nodes (raw LGraphNode array) */
    get allNodes() {
        return this.#app?.graph?._nodes || [];
    }

    /** Get the canvas reference (needed for widget callbacks) */
    get canvas() {
        return this.#app?.canvas ?? null;
    }

    /** Get mapped node outputs { nodeId: { images?, gifs?, text?, audio? } } */
    get nodeOutputs() {
        return this.#app?.nodeOutputs || {};
    }

    /** Get currently executing node ID (null if idle) */
    get runningNodeId() {
        return this.#app?.runningNodeId ?? null;
    }

    /** Mark the canvas as dirty (triggers redraw) */
    setDirtyCanvas(fg = true, bg = true) {
        this.#app?.graph?.setDirtyCanvas(fg, bg);
    }

    /**
     * Notify LiteGraph that the graph changed, then redraw.
     * Use this after node mode/link-affecting changes that graphToPrompt must see.
     */
    notifyGraphChanged(fg = true, bg = true) {
        this.#app?.graph?.change?.();
        this.setDirtyCanvas(fg, bg);
    }

    /**
     * Return normalized outgoing links for a node output.
     * @param {LGraphNode} node
     * @param {number} outputIndex
     * @returns {{targetId:number|string,targetSlot:number}[]}
     */
    getOutputLinks(node, outputIndex) {
        const ids = node?.outputs?.[outputIndex]?.links || [];
        const graphLinks = this.#app?.graph?.links;
        return ids
            .map(id => graphLinks?.[id])
            .filter(Boolean)
            .map(link => Array.isArray(link)
                ? { targetId: link[3], targetSlot: link[4] }
                : { targetId: link.target_id, targetSlot: link.target_slot });
    }

    /**
     * Resolve a widget from a linked input slot.
     * Useful for virtual/control nodes that proxy values to connected widgets.
     */
    getWidgetForLinkedInput(targetId, targetSlot) {
        const target = this.getNodeById(Number(targetId));
        const inputName = target?.inputs?.[targetSlot]?.name;
        if (!target || !inputName) return null;
        return target.widgets?.find(w => w.name === inputName || w.options?.name === inputName) ?? null;
    }

    /* ── Groups & Node Mode (for Deck group reflection / switch-toggle) ── */

    /**
     * Get all groups from the workflow.
     * @returns {Array<{title: string, bounding: number[], color: string, font_size: number}>}
     *   Each group has: title, bounding [x, y, w, h], color, font_size.
     *   Returns an empty array if no groups exist.
     */
    getGroups() {
        return this.#app?.graph?._groups || [];
    }

    /**
     * Get all nodes that ComfyUI considers to be inside a group.
     * @param {object} group - A group object from getGroups() (must have ._bounding or .bounding)
     * @returns {LGraphNode[]} Nodes inside the group
     */
    getNodesInGroup(group) {
        if (!group || !this.#app?.graph?._nodes) return [];

        group.recomputeInsideNodes?.();

        const graphNodes = this.#app.graph._nodes;
        const nodeIds = new Set();
        const addNode = (node) => {
            if (!node) return;
            if (typeof node === 'number' || typeof node === 'string') {
                nodeIds.add(Number(node));
            } else if (node.id != null) {
                nodeIds.add(Number(node.id));
            }
        };

        // ComfyUI/LiteGraph maintains live group membership here. Prefer it
        // over Drawer-side geometry so collapsed nodes and visual bounds match.
        if (group._children?.size) {
            for (const child of group._children) addNode(child);
        } else if (Array.isArray(group.nodes) && group.nodes.length > 0) {
            for (const node of group.nodes) addNode(node);
        } else if (Array.isArray(group._nodes) && group._nodes.length > 0) {
            for (const node of group._nodes) addNode(node);
        }

        if (nodeIds.size > 0) {
            return graphNodes.filter(node => nodeIds.has(Number(node.id)));
        }

        // Fallback for serialized/stale groups: use rendered node bounds when
        // available, then fall back to the older pos/size center check.
        const b = group._bounding ?? group.bounding;
        if (!b) return [];
        const [gx, gy, gw, gh] = b;
        return graphNodes.filter(node => {
            const bounds = node.getBounding?.() ?? node.boundingRect;
            const nx = bounds?.[0] ?? node.pos?.[0];
            const ny = bounds?.[1] ?? node.pos?.[1];
            const nw = bounds?.[2] ?? node.size?.[0] ?? 0;
            const nh = bounds?.[3] ?? node.size?.[1] ?? 0;
            if (nx == null || ny == null) return false;
            const cx = nx + nw / 2;
            const cy = ny + nh / 2;
            return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
        });
    }

    /**
     * Set a node's execution mode.
     * @param {number} nodeId
     * @param {number} mode  0 = Always (normal), 2 = Mute, 4 = Bypass
     * @returns {boolean} true if mode was set successfully
     */
    setNodeMode(nodeId, mode) {
        const node = this.getNodeById(nodeId);
        if (!node) return false;
        node.mode = mode;
        node.graph?.change?.();
        this.setDirtyCanvas(true, true);
        return true;
    }

    /**
     * Get a node's current execution mode.
     * @param {number} nodeId
     * @returns {number|null} 0 = Always, 2 = Mute, 4 = Bypass, null if not found
     */
    getNodeMode(nodeId) {
        const node = this.getNodeById(nodeId);
        return node ? (node.mode ?? 0) : null;
    }

    /**
     * Toggle a group of nodes between two modes.
     * Useful for implementing [switch:name] groups where only one should be active.
     * @param {number[]} nodeIds - Array of node IDs to set
     * @param {number} mode - Mode to apply (0, 2, or 4)
     */
    setNodesModes(nodeIds, mode) {
        if (!Array.isArray(nodeIds)) return;
        for (const id of nodeIds) {
            const node = this.getNodeById(id);
            if (node) node.mode = mode;
        }
        this.#app?.graph?.change?.();
        this.setDirtyCanvas(true, true);
    }

    /**
     * Restore per-node modes from a { nodeId: mode } map in a single batch.
     * All modes are applied before graph.change() fires, preventing
     * intermediate state issues caused by per-node change notifications.
     * @param {Object<number|string, number>} modeMap - { nodeId: mode }
     */
    setNodesModesMap(modeMap) {
        for (const [id, mode] of Object.entries(modeMap)) {
            const node = this.getNodeById(parseInt(id));
            if (node) node.mode = mode;
        }
        this.#app?.graph?.change?.();
        this.setDirtyCanvas(true, true);
    }

    /* ── Workflow Extra Data (persisted in workflow JSON) ── */

    /**
     * Read a value from workflow.extra.comfyDrawer[path].
     * @param {string} path - Dot-separated path (e.g. 'deckCollapse')
     * @param {*} [fallback] - Value to return if path doesn't exist
     * @returns {*}
     */
    getWorkflowExtra(path, fallback) {
        try {
            const extra = this.#app?.graph?.extra;
            if (!extra?.comfyDrawer) return fallback;
            const parts = path.split('.');
            let cur = extra.comfyDrawer;
            for (const p of parts) {
                if (cur == null || typeof cur !== 'object') return fallback;
                cur = cur[p];
            }
            return cur ?? fallback;
        } catch { return fallback; }
    }

    /**
     * Write a value to workflow.extra.comfyDrawer[path].
     * Creates intermediate objects as needed.
     * @param {string} path - Dot-separated path (e.g. 'deckCollapse')
     * @param {*} value - Value to store (must be JSON-serializable)
     */
    setWorkflowExtra(path, value) {
        try {
            const graph = this.#app?.graph;
            if (!graph) return;
            if (!graph.extra) graph.extra = {};
            if (!graph.extra.comfyDrawer) graph.extra.comfyDrawer = {};
            const parts = path.split('.');
            let cur = graph.extra.comfyDrawer;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = value;
        } catch { /* non-critical */ }
    }

    /**
     * Queue a prompt via ComfyUI's built-in app.queuePrompt.
     * Recommended for most gadgets — handles graphToPrompt, metadata,
     * and seed randomisation automatically.
     */
    async queuePromptSimple(num = 0, batchCount = 1) {
        return this.#app?.queuePrompt(num, batchCount);
    }

    /**
     * Queue a partial execution targeting specific output nodes.
     *
     * Strategy: prefer app.queuePrompt(0, 1, targetNodeIds) — the same 3-arg
     * call used by ComfyUI's native "Queue Selected Output Nodes" — so that
     * all hooks fire (DrawerSeed monkey-patch, beforeQueuePrompt, metadata
     * embedding, control_after_generate, etc.).
     *
     * If the 3rd argument is not supported by the current frontend version
     * (non-public API, may change), falls back to a direct POST to /prompt
     * with partial_execution_targets (stable backend REST API).
     *
     * @param {string[]} targetNodeIds - Node IDs of the output nodes to target
     */
    async queuePartial(targetNodeIds) {
        try {
            // Prefer native path for full hook parity.
            // app.queuePrompt accepts a 3rd arg (targetNodeIds) since
            // ComfyUI frontend v1.19.6 (Comfy.QueueSelectedOutputNodes).
            if (typeof this.#app?.queuePrompt === 'function') {
                return await this.#app.queuePrompt(0, 1, targetNodeIds);
            }
        } catch (e) {
            console.warn('[ComfyBridge] queuePrompt with targets failed, falling back to direct API:', e);
        }
        // Fallback: direct POST — bypasses JS hooks but always works.
        try {
            const prompt = await this.#app.graphToPrompt();
            return this.#api.fetchApi('/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: this.#api.clientId,
                    prompt: prompt.output,
                    extra_data: { extra_pnginfo: { workflow: this.exportWorkflow() } },
                    partial_execution_targets: targetNodeIds,
                }),
            });
        } catch (e) {
            throw new Error(`Partial execution failed: ${e.message}`);
        }
    }

    /**
     * Check if a node is an output node (OUTPUT_NODE == true).
     * Uses ComfyUI's cached objectInfo from /object_info.
     * @param {LGraphNode} node
     * @returns {boolean}
     */
    isOutputNode(node) {
        if (!node) return false;
        const classType = node.comfyClass ?? node.type;
        // LiteGraph stores the registered node definitions; ComfyUI's app
        // caches /object_info as nodeData on each registered nodeType.
        try {
            const nodeDef = LiteGraph.registered_node_types?.[classType];
            if (nodeDef?.nodeData?.output_node) return true;
        } catch { /* fallback below */ }
        return false;
    }

    /* ── API Event Subscription ── */

    /** Subscribe to a ComfyUI API event (progress, executing, executed, etc.) */
    onApiEvent(event, handler) {
        this.#api?.addEventListener(event, handler);
    }

    /** Unsubscribe from a ComfyUI API event */
    offApiEvent(event, handler) {
        this.#api?.removeEventListener(event, handler);
    }

    /* ── Graph Switch Event ── */

    /**
     * Listen for workflow tab switches via ComfyUI's litegraph:set-graph event.
     * This fires whenever the canvas graph is swapped (tab switch, load, etc.).
     * ComfyUI uses this internally (e.g. in useNodeBadge), so it's stable.
     * @param {(detail: {newGraph:object, oldGraph:object}) => void} callback
     * @returns {() => void} Dispose function to remove the listener
     */
    onGraphSwitch(callback) {
        // Find the canvas element: LiteGraph fires custom events on the canvas DOM
        const canvasEl = this.#app?.canvas?.canvas
            ?? document.querySelector('#graph-canvas-container canvas');
        if (!canvasEl) {
            console.warn('[ComfyBridge] Canvas element not found for graph-switch listener');
            return () => {};
        }

        const handler = (e) => {
            try { callback(e.detail); } catch (err) {
                console.error('[ComfyBridge] onGraphSwitch callback error:', err);
            }
        };
        canvasEl.addEventListener('litegraph:set-graph', handler);
        return () => canvasEl.removeEventListener('litegraph:set-graph', handler);
    }

    /** Build a full API URL (respects ComfyUI's base path) */
    apiURL(path) {
        return this.#api?.apiURL?.(path) ?? path;
    }

    /**
     * Fetch from ComfyUI's API (handles auth + base path).
     * @param {string} path - API path (e.g. '/comfy-drawer/save_grid')
     * @param {RequestInit} [options] - Fetch options
     * @returns {Promise<Response>}
     */
    fetchApi(path, options) {
        return this.#api.fetchApi(path, options);
    }

    /* ── ComfyUI Settings ── */

    /** Read a ComfyUI setting value */
    getSetting(key, defaultValue) {
        return this.#app?.ui?.settings?.getSettingValue(key, defaultValue) ?? defaultValue;
    }

    /** Write a ComfyUI setting value */
    setSetting(key, value) {
        this.#app?.ui?.settings?.setSettingValue(key, value);
    }

    /** Register a new ComfyUI setting (shows in Settings panel) */
    addSetting(config) {
        this.#app?.ui?.settings?.addSetting(config);
    }
}
