/**
 * ComfyDrawer — headless prompt builder
 *
 * Port of ComfyUI frontend 1.55's graphToPrompt() and ExecutableNodeDTO
 * (subgraph flattening, bypass/mute resolution, virtual-node links), running
 * on a HeadlessGraph instead of LiteGraph. Output matches the frontend's
 * API-format prompt; verified against prompts captured from the real frontend
 * (tests/fixtures/headless).
 *
 * Pure module: no DOM.
 */
import { NODE_MODE, SUBGRAPH_INPUT_ID } from './headless-graph.js';
import { applyTextReplacements, processDynamicPrompt, SAVE_NODE_TYPES } from './node-defs.js';

export class HeadlessPromptError extends Error {
    constructor(message, nodes = []) {
        super(message);
        this.name = 'HeadlessPromptError';
        this.nodes = nodes;
    }
}

/** LiteGraph.isValidConnection. */
export function isValidConnection(a, b) {
    if (a === '' || a === '*') a = 0;
    if (b === '' || b === '*') b = 0;
    if (!a || !b || a === b) return true;
    a = String(a).toLowerCase();
    b = String(b).toLowerCase();
    if (!a.includes(',') && !b.includes(',')) return a === b;
    for (const x of a.split(',')) {
        for (const y of b.split(',')) {
            if (isValidConnection(x, y)) return true;
        }
    }
    return false;
}

/**
 * KJNodes GetNode: find the SetNode with the same name. Same graph → normal
 * link path (getInputLink); an ancestor graph → resolveVirtualOutput.
 */
function findSetter(node, name) {
    if (!name) return null;
    const own = node.graph._nodes.find(n => n.type === 'SetNode' && n.widgets[0]?.value === name);
    if (own) return { node: own, graph: node.graph };
    // Ancestors of a subgraph definition: the root graph (Drawer workflows
    // nest one level; deeper chains walk up through the root as KJ does).
    const root = node.graph.rootGraph;
    if (node.graph !== root) {
        const up = root._nodes.find(n => n.type === 'SetNode' && n.widgets[0]?.value === name);
        if (up) return { node: up, graph: root };
    }
    return null;
}

function virtualInputLink(node, slot) {
    if (node.type === 'GetNode') {
        const setter = findSetter(node, node.widgets[0]?.value);
        if (!setter || setter.graph !== node.graph) return null;
        const link = setter.node.inputs[slot]?.link;
        return link == null ? null : node.graph.getLink(link);
    }
    return node.getInputLink(slot);
}

function virtualOutputSource(node, slot) {
    if (node.type !== 'GetNode') return undefined;
    const setter = findSetter(node, node.widgets[0]?.value);
    if (!setter || setter.graph === node.graph) return undefined;
    const linkId = setter.node.inputs[slot]?.link;
    if (linkId == null) return undefined;
    const link = setter.graph.getLink(linkId);
    const source = link && setter.graph.getNodeById(link.origin_id);
    return source ? { node: source, slot: link.origin_slot } : undefined;
}

class ExecutableNode {
    constructor(node, subgraphNodePath, nodesByExecutionId, subgraphNode) {
        this.node = node;
        this.subgraphNodePath = subgraphNodePath;
        this.nodesByExecutionId = nodesByExecutionId;
        this.subgraphNode = subgraphNode;
        this.graph = node.graph;
        this.id = [...subgraphNodePath, node.id].join(':');
        this.inputs = node.inputs.map(i => ({ linkId: i.link ?? null, name: i.name, type: i.type }));
    }

    get mode() { return this.node.mode; }
    get title() { return this.node.title; }
    get comfyClass() { return this.node.comfyClass; }
    get isVirtualNode() { return this.node.isVirtualNode; }
    get widgets() { return this.node.widgets; }

    getInnerNodes() {
        return this.node.isSubgraphNode()
            ? collectInnerNodes(this.node, this.nodesByExecutionId, this.subgraphNodePath)
            : [this];
    }

    resolveInput(slot, visited = new Set(), typeOverride) {
        const key = `${this.subgraphNode?.subgraph.id}:${this.node.id}[I]${slot}`;
        if (visited.has(key)) {
            throw new HeadlessPromptError(`Circular link while resolving input ${slot} of node ${this.id}`);
        }
        visited.add(key);
        const input = this.inputs[slot];
        if (!input) throw new HeadlessPromptError(`No input ${slot} on node ${this.id}`);
        if (input.linkId == null) return undefined;
        const link = this.graph.getLink(input.linkId);
        if (!link) throw new HeadlessPromptError(`Missing link ${input.linkId} into node ${this.id}`);

        const sg = this.subgraphNode;
        if (sg && link.origin_id === SUBGRAPH_INPUT_ID) {
            const outerInput = sg.inputs[link.origin_slot];
            if (!outerInput) throw new HeadlessPromptError(`No subgraph input ${link.origin_slot} on node ${sg.id}`);
            if (outerInput.link == null) {
                // Unconnected promoted input: the instance's widget value.
                const widget = outerInput.widget && sg.widgets.find(w => w.name === outerInput.name);
                return widget
                    ? { node: this, origin_id: this.id, origin_slot: -1, widgetInfo: { value: widget.value } }
                    : undefined;
            }
            if (!sg.graph.getLink(outerInput.link)) {
                throw new HeadlessPromptError(`Missing outer link into subgraph node ${sg.id}`);
            }
            const sgDto = this.nodesByExecutionId.get(this.subgraphNodePath.join(':'));
            if (!sgDto) throw new HeadlessPromptError(`No subgraph node entry for ${this.subgraphNodePath.join(':')}`);
            // Instance slots are rebuilt from the definition, so index by the
            // subgraph input slot rather than the saved link's target_slot.
            return sgDto.resolveInput(link.origin_slot, visited);
        }

        const source = this.graph.getNodeById(link.origin_id);
        if (!source) throw new HeadlessPromptError(`Missing source node ${link.origin_id} for node ${this.id}`);
        const sourceDto = this.nodesByExecutionId.get([...this.subgraphNodePath, source.id].join(':'));
        if (!sourceDto) throw new HeadlessPromptError(`No entry for source node ${source.id}`);
        return sourceDto.resolveOutput(link.origin_slot, typeOverride ?? input.type, visited);
    }

    resolveOutput(slot, type, visited) {
        const key = `${this.subgraphNode?.subgraph.id}:${this.node.id}[O]${slot}`;
        if (visited.has(key)) {
            throw new HeadlessPromptError(`Circular link while resolving output ${slot} of node ${this.id}`);
        }
        visited.add(key);
        if (this.mode === NODE_MODE.NEVER) return undefined;
        if (this.mode === NODE_MODE.BYPASS) {
            const idx = this.#bypassSlotIndex(slot, type);
            if (idx === -1) return undefined;
            return this.resolveInput(idx, visited);
        }
        const { node } = this;
        if (node.isSubgraphNode()) return this.#resolveSubgraphOutput(slot, type, visited);
        if (node.isVirtualNode) {
            const virtual = virtualOutputSource(node, slot);
            if (virtual) {
                const dto = [...this.nodesByExecutionId.values()].find(d => d.node === virtual.node);
                if (!dto) throw new HeadlessPromptError(`No entry for virtual source node ${virtual.node.id}`);
                return dto.resolveOutput(virtual.slot, type, visited);
            }
            const link = virtualInputLink(node, slot);
            if (link) {
                const target = this.graph.getNodeById(link.target_id);
                if (!target) throw new HeadlessPromptError(`Virtual node ${this.id} failed to resolve its parent`);
                const dto = this.nodesByExecutionId.get([...this.subgraphNodePath, target.id].join(':'));
                if (!dto) throw new HeadlessPromptError(`No entry for node ${target.id}`);
                return dto.resolveInput(link.target_slot, visited, type);
            }
            return undefined;
        }
        return { node: this, origin_id: this.id, origin_slot: slot };
    }

    #bypassSlotIndex(slot, type) {
        const { inputs } = this;
        const input = inputs[slot];
        const outType = this.node.outputs[slot]?.type;
        if (type === '*' || type === '') return inputs.length > slot ? slot : 0;
        if (input && isValidConnection(input.type, outType) && isValidConnection(input.type, type)) return slot;
        const exact = inputs.findIndex(i => i.type === type);
        return exact === -1
            ? inputs.findIndex(i => isValidConnection(i.type, outType) && isValidConnection(i.type, type))
            : exact;
    }

    #resolveSubgraphOutput(slot, type, visited) {
        const { node } = this;
        const out = node.subgraph.outputs[slot];
        if (!out) throw new HeadlessPromptError(`No subgraph output ${slot} on node ${this.id}`);
        const linkId = out.linkIds?.[0];
        if (linkId == null) return undefined;
        const link = node.subgraph.getLink(linkId);
        if (!link) return undefined;
        const inner = node.subgraph.getNodeById(link.origin_id);
        if (!inner) throw new HeadlessPromptError(`No inner node ${link.origin_id} for output ${slot} of ${this.id}`);
        const dto = this.nodesByExecutionId.get([...this.subgraphNodePath, node.id, inner.id].join(':'));
        if (!dto) throw new HeadlessPromptError(`No entry for inner node ${inner.id}`);
        return dto.resolveOutput(link.origin_slot, type, visited);
    }
}

/** SubgraphNode.getInnerNodes: register the instance and every inner node. */
function collectInnerNodes(sgNode, map, path, out = [], visiting = new Set()) {
    if (visiting.has(sgNode)) {
        throw new HeadlessPromptError(`Circular subgraph reference at node ${sgNode.id}`);
    }
    visiting.add(sgNode);
    const innerPath = [...path, sgNode.id];
    const parent = path.length ? map.get(path.join(':'))?.node : undefined;
    const self = new ExecutableNode(sgNode, path, map, parent);
    map.set(self.id, self);
    for (const inner of sgNode.subgraph._nodes) {
        if (inner.isSubgraphNode()) {
            collectInnerNodes(inner, map, innerPath, out, new Set(visiting));
        } else {
            const dto = new ExecutableNode(inner, innerPath, map, sgNode);
            map.set(dto.id, dto);
            out.push(dto);
        }
    }
    return out;
}

/**
 * pysssss PresetText: in text widgets, `@name` tokens (setting
 * pysssss.PresetText.ReplacementRegex) become the preset's text. Presets live
 * in the browser's localStorage, so this matches the frontend of the same
 * browser; unknown names are left as typed, as the frontend does.
 */
function applyPresetText(text, { regex, presets }) {
    const pattern = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    return text.replace(pattern, (match, ...args) => {
        const groups = args.at(-1);
        if (!groups?.replace || !groups.id) return match;
        const preset = presets.find(p => p.name.replaceAll(/\s/g, '-') === groups.id);
        if (!preset) return match;
        return match.substring(0, match.indexOf(groups.replace)) + preset.value;
    });
}

function serializeWidgetValue(graph, node, widget, { random, now, presetText }) {
    let v = widget.value;
    if (presetText && typeof v === 'string' && (widget.type === 'text' || widget.type === 'customtext')) {
        v = applyPresetText(v, presetText);
    }
    if (widget.dynamicPrompts && typeof v === 'string') return processDynamicPrompt(v, random);
    if (widget.name === 'filename_prefix' && SAVE_NODE_TYPES.has(node.type)) {
        return applyTextReplacements(graph.allNodesDeep(), v, now);
    }
    // Text widgets hold strings; a saved 0 serializes as "0".
    if (widget.inputType === 'STRING' && v != null && typeof v !== 'string') return String(v);
    return v;
}

/**
 * Build the API-format prompt for the graph's current state.
 * @param {import('./headless-graph.js').HeadlessGraph} graph
 * @param {object} [opts]
 * @param {() => number} [opts.random] - RNG for {a|b} dynamic prompts
 * @param {Date} [opts.now] - clock for %date:…% in save-node filename_prefix
 * @param {{regex: RegExp, presets: {name: string, value: string}[]}|null} [opts.presetText]
 *   pysssss PresetText replacement, when that extension is installed
 * @returns {Record<string, {inputs: object, class_type: string, _meta: {title: string}}>}
 * @throws {HeadlessPromptError} when a node that would execute is unsupported
 */
export function buildPrompt(graph, { random = Math.random, now = new Date(), presetText = null } = {}) {
    const map = new Map();
    for (const node of graph._nodes) {
        const dto = new ExecutableNode(node, [], map, undefined);
        map.set(dto.id, dto);
        if (node.mode !== NODE_MODE.NEVER && node.mode !== NODE_MODE.BYPASS) {
            for (const inner of dto.getInnerNodes()) map.set(inner.id, inner);
        }
    }

    const unsupported = [...map.values()].filter(d =>
        d.node.unsupported && d.mode !== NODE_MODE.NEVER && d.mode !== NODE_MODE.BYPASS);
    if (unsupported.length) {
        const reasons = [...new Set(unsupported.map(d => d.node.unsupported))];
        throw new HeadlessPromptError(reasons.join('\n'), unsupported.map(d => d.id));
    }

    const output = {};
    for (const dto of map.values()) {
        if (dto.isVirtualNode || dto.mode === NODE_MODE.NEVER || dto.mode === NODE_MODE.BYPASS) continue;
        const inputs = {};
        for (const widget of dto.widgets ?? []) {
            if (!widget.name || widget.options?.serialize === false) continue;
            const v = serializeWidgetValue(graph, dto.node, widget, { random, now, presetText });
            inputs[widget.name] = widget.type === 'curve' && v != null
                ? { __type__: 'CURVE', __value__: v }
                : Array.isArray(v) ? { __value__: v } : v;
        }
        dto.inputs.forEach((input, i) => {
            const resolved = dto.resolveInput(i);
            if (!resolved) return;
            if (resolved.widgetInfo) {
                const { value } = resolved.widgetInfo;
                inputs[input.name] = Array.isArray(value) ? { __value__: value } : value;
                return;
            }
            inputs[input.name] = [resolved.origin_id, parseInt(resolved.origin_slot, 10)];
        });
        output[dto.id] = { inputs, class_type: dto.comfyClass, _meta: { title: dto.title } };
    }

    // Drop links to nodes that were not emitted (bypassed/muted/virtual chains).
    for (const { inputs } of Object.values(output)) {
        for (const [name, value] of Object.entries(inputs)) {
            if (Array.isArray(value) && value.length === 2 && !Object.hasOwn(output, value[0])) {
                delete inputs[name];
            }
        }
    }
    return output;
}
