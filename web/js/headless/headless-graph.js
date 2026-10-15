/**
 * ComfyDrawer — HeadlessGraph
 *
 * An in-memory stand-in for the LiteGraph graph, built from a saved
 * (UI-format) workflow plus /object_info. It exposes the narrow surface
 * Drawer gadgets read through ComfyBridge — nodes with id/type/title/mode/
 * inputs/outputs/widgets, groups, links, workflow extra — and serializes edits
 * (widget values, modes, extra) back to the same JSON shape so the workflow
 * can be saved and reopened in ComfyUI.
 *
 * Prompt generation lives in prompt-builder.js. Pure module: no DOM.
 */
import { VIRTUAL_NODE_TYPES, valueFitsWidget, widgetLayout } from './node-defs.js';

export const NODE_MODE = Object.freeze({ ALWAYS: 0, ON_EVENT: 1, NEVER: 2, ON_TRIGGER: 3, BYPASS: 4 });

/** LiteGraph's title bar height; group membership uses the title-inclusive bounds. */
const NODE_TITLE_HEIGHT = 30;
/** Subgraph IO pseudo-node ids used in subgraph link tables. */
export const SUBGRAPH_INPUT_ID = -10;
export const SUBGRAPH_OUTPUT_ID = -20;

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function normalizeLink(raw) {
    if (Array.isArray(raw)) {
        const [id, origin_id, origin_slot, target_id, target_slot, type] = raw;
        return { id, origin_id, origin_slot, target_id, target_slot, type };
    }
    return {
        id: raw.id,
        origin_id: raw.origin_id,
        origin_slot: raw.origin_slot,
        target_id: raw.target_id,
        target_slot: raw.target_slot,
        type: raw.type,
    };
}

/** A widget object shaped like the frontend's (name/type/value/options/callback). */
export class HeadlessWidget {
    constructor(node, entry, value, index) {
        this.node = node;
        this.name = entry.name;
        this.type = entry.type;
        this.inputType = entry.inputType;
        this.options = { ...entry.options, serialize: entry.serialize };
        this.dynamicPrompts = !!entry.dynamicPrompts;
        this.control = !!entry.control;
        this.controlFilter = !!entry.controlFilter;
        this.controls = entry.controls ?? null;
        /** Position in widgets_values (array form) — used when saving. */
        this.index = index;
        this.value = value === undefined ? entry.defaultValue : value;
        this.initialValue = this.value;
        this.linkedWidgets = [];
    }

    /** Frontend widgets call back with (value, canvas, node, pos, event). */
    callback(value) {
        this.value = value;
        this.node?.graph?.rootGraph?.markDirty?.();
    }
}

/**
 * Widget on a subgraph instance that proxies an inner node's widget
 * (properties.proxyWidgets). Reads and writes go to the inner widget, which
 * lives in the shared subgraph definition — same as the frontend.
 */
class PromotedWidget {
    #name;
    constructor(node, target, name = null) {
        this.node = node;
        this.target = target;
        this.promoted = true;
        this.#name = name;
    }
    get name() { return this.#name ?? this.target.name; }
    get type() { return this.target.type; }
    get options() { return this.target.options; }
    get value() { return this.target.value; }
    set value(v) { this.target.value = v; }
    callback(value) { this.target.callback(value); }
}

/**
 * Widget on a subgraph instance for a subgraph input that feeds an inner
 * widget. Its value is per instance (stored in the instance's
 * widgets_values, in subgraph-input order); type/options mirror the inner
 * widget it was promoted from.
 */
class SubgraphInputWidget extends HeadlessWidget {
    constructor(node, name, target, value, index) {
        super(node, {
            name,
            type: target.type,
            inputType: target.inputType,
            options: { ...target.options },
            serialize: true,
            dynamicPrompts: target.dynamicPrompts,
        }, value, index);
        this.subgraphInput = true;
    }
}

export class HeadlessNode {
    /**
     * @param {HeadlessGraphBase} graph - owning graph (root or subgraph definition)
     * @param {object} json - serialized node
     * @param {object} objectInfo - full /object_info map
     */
    constructor(graph, json, objectInfo) {
        this.graph = graph;
        this.json = json;
        this.id = json.id;
        this.type = json.type;
        this.mode = json.mode ?? NODE_MODE.ALWAYS;
        this.pos = Array.isArray(json.pos) ? [...json.pos] : [json.pos?.[0] ?? 0, json.pos?.[1] ?? 0];
        this.size = Array.isArray(json.size) ? [...json.size] : [json.size?.[0] ?? 0, json.size?.[1] ?? 0];
        this.flags = { ...(json.flags ?? {}) };
        this.properties = { ...(json.properties ?? {}) };
        this.color = json.color;
        this.bgcolor = json.bgcolor;
        this.inputs = (json.inputs ?? []).map(i => ({
            name: i.name, type: i.type, link: i.link ?? null, widget: i.widget, label: i.label,
        }));
        this.outputs = (json.outputs ?? []).map(o => ({
            name: o.name, type: o.type, links: [...(o.links ?? [])], label: o.label,
        }));

        this.subgraph = graph.rootGraph.subgraphs.get(this.type) ?? null;
        this.def = this.subgraph ? null : (objectInfo?.[this.type] ?? null);
        if (this.subgraph) this.#syncSubgraphSlots(json);
        this.isVirtualNode = !!this.subgraph || VIRTUAL_NODE_TYPES.has(this.type);
        this.comfyClass = this.def ? this.type : undefined;
        this.hasExplicitTitle = typeof json.title === 'string';
        this.title = this.hasExplicitTitle
            ? json.title
            : (this.def?.display_name ?? this.subgraph?.name ?? this.type);
        /** Set when the node cannot be represented faithfully (unknown class). */
        this.unsupported = (!this.def && !this.isVirtualNode) ? `Unknown node type "${this.type}"` : null;

        this.widgets = this.#buildWidgets(json);
    }

    /**
     * The frontend rebuilds a subgraph instance's slots from its definition
     * on load (saved instance slots may be partial); links are kept by name.
     */
    #syncSubgraphSlots(json) {
        const savedIn = json.inputs ?? [];
        this.inputs = this.subgraph.inputs.map(def => {
            const saved = savedIn.find(i => i.name === def.name);
            return { name: def.name, type: def.type, link: saved?.link ?? null, widget: undefined, label: saved?.label ?? def.label };
        });
        const savedOut = json.outputs ?? [];
        this.outputs = this.subgraph.outputs.map((def, i) => {
            const saved = savedOut.find(o => o.name === def.name) ?? savedOut[i];
            return { name: def.name, type: def.type, links: [...(saved?.links ?? [])], label: saved?.label ?? def.label };
        });
    }

    #buildWidgets(json) {
        const values = json.widgets_values;
        if (this.def) {
            // Frontend 1.43+ also saves widgets_values_named; its keys are the
            // widget names in positional order (restore stays positional
            // unless Comfy.Workflow.NamedValuesRestore is on).
            const named = json.widgets_values_named;
            const recorded = named && typeof named === 'object' ? Object.keys(named) : undefined;
            const { layout, unknownWidgets } = widgetLayout(this.def, json, recorded);
            if (unknownWidgets) {
                this.unsupported = `"${this.type}" has widgets added by a frontend extension; `
                    + 'open and save this workflow once in ComfyUI';
            }
            const byName = values && !Array.isArray(values) && typeof values === 'object';
            const widgets = layout.map((entry, i) => new HeadlessWidget(
                this, entry, byName ? values[entry.name] : values?.[i], i));
            const misplaced = widgets.find(w => !valueFitsWidget(w.inputType, w.value));
            if (misplaced && !this.unsupported) {
                this.unsupported = `Saved values of "${this.type}" no longer line up with its inputs `
                    + `("${misplaced.name}"); open and save this workflow once in ComfyUI`;
            }
            for (const w of widgets) {
                if (!w.control && !w.controlFilter) continue;
                const target = widgets.find(t => t.name === w.controls && !t.control && !t.controlFilter);
                if (target) target.linkedWidgets.push(w);
            }
            return widgets;
        }
        if (this.type === 'SetNode' || this.type === 'GetNode') {
            return [new HeadlessWidget(this, {
                name: 'Constant', type: 'text', options: {}, serialize: false,
            }, values?.[0], 0)];
        }
        if (this.type === 'Note' || this.type === 'MarkdownNote') {
            return [new HeadlessWidget(this, {
                name: 'text', type: 'customtext', options: { multiline: true }, serialize: false,
            }, values?.[0], 0)];
        }
        return [];
    }

    /** Called after all subgraph definitions exist: promote inner widgets. */
    bindPromotedWidgets() {
        if (!this.subgraph) return;
        const values = Array.isArray(this.json.widgets_values) ? this.json.widgets_values : [];
        let k = 0;
        this.subgraph.inputs.forEach((def, slot) => {
            const target = this.#innerWidgetFor(def);
            if (!target) return;
            this.inputs[slot].widget = { name: def.name };
            this.widgets.push(values.length > k
                ? new SubgraphInputWidget(this, def.name, target, values[k], k)
                : new PromotedWidget(this, target, def.name));
            k++;
        });
        const proxies = this.properties.proxyWidgets;
        if (!Array.isArray(proxies)) return;
        for (const entry of proxies) {
            if (!Array.isArray(entry)) continue;
            const [innerId, widgetName] = entry;
            const inner = this.subgraph.getNodeById(innerId);
            const target = inner?.widgets.find(w => w.name === widgetName);
            if (!target || this.widgets.some(w => w.promoted && w.target === target)) continue;
            this.widgets.push(new PromotedWidget(this, target));
        }
    }

    /** The inner widget a subgraph input is promoted from (first widget target). */
    #innerWidgetFor(defInput) {
        for (const linkId of defInput.linkIds ?? []) {
            const link = this.subgraph.getLink(linkId);
            const inner = link && this.subgraph.getNodeById(link.target_id);
            const widgetName = inner?.inputs[link.target_slot]?.widget?.name;
            const widget = widgetName && inner.widgets.find(w => w.name === widgetName);
            if (widget) return widget;
        }
        return null;
    }

    isSubgraphNode() { return !!this.subgraph; }

    /** The object_info entry, where ComfyUI keeps it on the node class. */
    get nodeData() { return this.def; }

    /** LiteGraph getBounding(): title-inclusive [x, y, w, h]. */
    getBounding() {
        const collapsed = !!this.flags.collapsed;
        const w = collapsed ? (this.json._collapsed_width ?? 80) : this.size[0];
        const h = collapsed ? 0 : this.size[1];
        return [this.pos[0], this.pos[1] - NODE_TITLE_HEIGHT, w, h + NODE_TITLE_HEIGHT];
    }

    /** LGraphNode.getInputLink: the link feeding input `slot`. */
    getInputLink(slot) {
        const link = this.inputs[slot]?.link;
        return link == null ? null : this.graph.getLink(link);
    }

    /**
     * Copy of the node's JSON with its current mode and widget values.
     * Only values that changed are written, so an untouched node saves
     * byte-identical and positions the frontend would derive stay intact.
     */
    serialize() {
        const out = clone(this.json);
        if (this.mode !== (this.json.mode ?? NODE_MODE.ALWAYS)) out.mode = this.mode;
        const changed = this.widgets.filter(w => !w.promoted && w.value !== w.initialValue);
        if (!changed.length) return out;
        const values = this.json.widgets_values;
        if (values && !Array.isArray(values) && typeof values === 'object') {
            out.widgets_values = { ...values };
            for (const w of changed) out.widgets_values[w.name] = w.value;
        } else {
            out.widgets_values = Array.isArray(values) ? [...values] : [];
            for (const w of changed) out.widgets_values[w.index] = w.value;
        }
        return out;
    }
}

class HeadlessGraphBase {
    constructor(rootGraph) {
        this.rootGraph = rootGraph ?? this;
        this._nodes = [];
        this._nodesById = new Map();
        this.linksById = new Map();
        this._groups = [];
    }

    /** LiteGraph exposes links by id; ComfyBridge.getOutputLinks reads graph.links[id]. */
    get links() {
        return Object.fromEntries(this.linksById);
    }

    getNodeById(id) {
        if (id == null) return null;
        return this._nodesById.get(String(id)) ?? null;
    }

    getLink(id) {
        return this.linksById.get(Number(id)) ?? this.linksById.get(id) ?? null;
    }

    /** LGraph.change(): something edited the graph. */
    change() { this.rootGraph.markDirty(); }

    /** LGraph.setDirtyCanvas(): nothing to redraw headless. */
    setDirtyCanvas() {}

    _addNodes(nodeJsons, objectInfo) {
        for (const json of nodeJsons ?? []) {
            const node = new HeadlessNode(this, json, objectInfo);
            this._nodes.push(node);
            this._nodesById.set(String(node.id), node);
        }
    }

    _addLinks(rawLinks) {
        for (const raw of rawLinks ?? []) {
            if (!raw) continue;
            const link = normalizeLink(raw);
            this.linksById.set(link.id, link);
        }
    }

    _addGroups(groups) {
        this._groups = (groups ?? []).map(g => ({
            id: g.id,
            title: g.title ?? '',
            color: g.color,
            font_size: g.font_size,
            bounding: [...(g.bounding ?? [0, 0, 0, 0])],
            flags: { ...(g.flags ?? {}) },
            // LGraphGroup exposes position/size as views of its bounding;
            // Deck orders groups by pos.
            get pos() { return this.bounding.slice(0, 2); },
            get size() { return this.bounding.slice(2, 4); },
        }));
    }
}

/** A subgraph definition (shared by every instance node of that type). */
export class HeadlessSubgraph extends HeadlessGraphBase {
    constructor(rootGraph, def, objectInfo) {
        super(rootGraph);
        this.def = def;
        this.id = def.id;
        this.name = def.name;
        this.inputs = def.inputs ?? [];
        this.outputs = def.outputs ?? [];
        this._addLinks(def.links);
        this._objectInfo = objectInfo;
    }

    _populate() {
        this._addNodes(this.def.nodes, this._objectInfo);
        this._addGroups(this.def.groups);
    }

    serialize() {
        const out = clone(this.def);
        out.nodes = this._nodes.map(n => n.serialize());
        return out;
    }
}

/**
 * Frontend deduplicateClonedSubgraphNodeIds: subgraph inner node ids must be
 * unique across the root graph and every definition. Root ids are reserved;
 * definitions are walked in order and a colliding inner node gets the next
 * free id after state.lastNodeId. Links and the proxyWidgets of instance
 * nodes are patched to match. Mutates `defs`.
 * @returns {number|null} the new lastNodeId when any id changed, else null
 */
function deduplicateSubgraphNodeIds(defs, workflow) {
    const used = new Set((workflow.nodes ?? []).map(n => String(n.id)));
    const numeric = new Set([...used].map(Number).filter(Number.isInteger));
    let last = Number(workflow.state?.lastNodeId ?? workflow.last_node_id ?? 0);
    const remaps = new Map();
    for (const def of defs) {
        const map = new Map();
        for (const node of def.nodes ?? []) {
            const id = String(node.id);
            if (used.has(id)) {
                let next = last + 1;
                while (numeric.has(next)) next++;
                last = next;
                map.set(id, next);
                node.id = next;
                numeric.add(next);
                used.add(String(next));
            } else {
                used.add(id);
                const n = Number(id);
                if (Number.isInteger(n)) {
                    numeric.add(n);
                    if (n > last) last = n;
                }
            }
        }
        if (!map.size) continue;
        remaps.set(def.id, map);
        for (const link of [...(def.links ?? []), ...(def.floatingLinks ?? [])]) {
            if (map.has(String(link.origin_id))) link.origin_id = map.get(String(link.origin_id));
            if (map.has(String(link.target_id))) link.target_id = map.get(String(link.target_id));
        }
    }
    if (!remaps.size) return null;
    const patchProxies = (nodes) => {
        for (const node of nodes ?? []) {
            const map = remaps.get(node.type);
            const proxies = node.properties?.proxyWidgets;
            if (!map || !Array.isArray(proxies)) continue;
            for (const entry of proxies) {
                if (Array.isArray(entry) && map.has(String(entry[0]))) entry[0] = String(map.get(String(entry[0])));
            }
        }
    };
    for (const def of defs) patchProxies(def.nodes);
    patchProxies(workflow.nodes);
    return last;
}

export class HeadlessGraph extends HeadlessGraphBase {
    /**
     * @param {object} workflow - saved UI-format workflow JSON
     * @param {object} objectInfo - full /object_info map
     */
    constructor(workflow, objectInfo) {
        super(null);
        this.workflow = clone(workflow) ?? {};
        this.objectInfo = objectInfo ?? {};
        this.extra = clone(this.workflow.extra) ?? {};
        this.dirty = false;
        this.subgraphs = new Map();
        const defs = clone(this.workflow.definitions?.subgraphs ?? []);
        /** Set when inner node ids were deduplicated (the saved file still has the old ones). */
        this.renumberedLastNodeId = deduplicateSubgraphNodeIds(defs, this.workflow);
        for (const def of defs) {
            this.subgraphs.set(def.id, new HeadlessSubgraph(this, def, this.objectInfo));
        }
        // Subgraph nodes may reference other subgraphs, so create them all first.
        for (const sg of this.subgraphs.values()) sg._populate();
        this._addLinks(this.workflow.links);
        this._addNodes(this.workflow.nodes, this.objectInfo);
        this._addGroups(this.workflow.groups);
        for (const node of this.allNodesDeep()) node.bindPromotedWidgets();
    }

    markDirty() {
        this.dirty = true;
        this.onChange?.();
    }

    /**
     * Whether any widget value or node mode differs from the last saved
     * state. Unlike `dirty`, an edit that was undone (or an XYZ sweep that
     * restored its values) does not count.
     */
    isModified() {
        for (const node of this.allNodesDeep()) {
            if (node.mode !== (node.json.mode ?? NODE_MODE.ALWAYS)) return true;
            if (node.widgets.some(w => !w.promoted && w.value !== w.initialValue)) return true;
        }
        return false;
    }

    /** Make the current state the saved baseline (after writing it to disk). */
    markSaved() {
        for (const node of this.allNodesDeep()) {
            node.json = node.serialize();
            for (const w of node.widgets) if (!w.promoted) w.initialValue = w.value;
        }
        this.dirty = false;
    }

    /** Every node in the root graph and in every subgraph definition. */
    *allNodesDeep() {
        yield* this._nodes;
        for (const sg of this.subgraphs.values()) yield* sg._nodes;
    }

    /** Node types that cannot be represented (unknown class, not virtual/subgraph). */
    unsupportedNodes() {
        return [...this.allNodesDeep()].filter(n => n.unsupported);
    }

    /** Saved-workflow JSON with current widget values, modes and extra. */
    serialize() {
        const out = clone(this.workflow);
        out.nodes = this._nodes.map(n => n.serialize());
        out.extra = clone(this.extra);
        if (this.subgraphs.size) {
            out.definitions = { ...(out.definitions ?? {}) };
            out.definitions.subgraphs = [...this.subgraphs.values()].map(sg => sg.serialize());
        }
        if (this.renumberedLastNodeId !== null) {
            // Saved with the deduplicated ids, as the frontend would save it.
            out.state = { ...(out.state ?? {}), lastNodeId: this.renumberedLastNodeId };
        }
        return out;
    }
}
