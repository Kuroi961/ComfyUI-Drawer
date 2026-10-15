// Unit checks for web/js/headless that the golden replay does not cover:
// edits, save/reload, refusal of unknown nodes, text processing.
// Usage: node tests/js/headless_unit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '..', '..');
const load = (p) => import(pathToFileURL(join(repo, p)));
const { HeadlessGraph, NODE_MODE } = await load('web/js/headless/headless-graph.js');
const { buildPrompt, HeadlessPromptError } = await load('web/js/headless/prompt-builder.js');
const { processDynamicPrompt, formatDate, widgetLayout } = await load('web/js/headless/node-defs.js');
const { applyValueControls, nextControlledValue } = await load('web/js/headless/value-control.js');
const { ComfyBridge } = await load('web/js/core/comfy-bridge.js');

const fixture = JSON.parse(readFileSync(join(repo, 'tests/fixtures/headless/drawer-tutorial-deck-en.json'), 'utf-8'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('widget edit reaches the prompt and survives save/reload', () => {
    const graph = new HeadlessGraph(fixture.workflow, fixture.objectInfo);
    const node = graph._nodes.find(n => n.type === 'CLIPTextEncode' && n.mode === NODE_MODE.ALWAYS);
    const text = node.widgets.find(w => w.name === 'text');
    text.callback('a cat, {red|blue}');
    assert.equal(graph.dirty, true);
    assert.equal(buildPrompt(graph, { random: () => 0 })[String(node.id)].inputs.text, 'a cat, red');
    const reloaded = new HeadlessGraph(graph.serialize(), fixture.objectInfo);
    assert.equal(reloaded.getNodeById(node.id).widgets.find(w => w.name === 'text').value, 'a cat, {red|blue}');
});

test('modified compares against the saved state, not edit history', () => {
    const graph = new HeadlessGraph(fixture.workflow, fixture.objectInfo);
    const node = graph._nodes.find(n => n.type === 'CLIPTextEncode');
    const text = node.widgets.find(w => w.name === 'text');
    const original = text.value;
    assert.equal(graph.isModified(), false);
    text.callback('edited');
    assert.equal(graph.isModified(), true);
    text.callback(original);
    assert.equal(graph.isModified(), false, 'an undone edit is not a change');
    node.mode = NODE_MODE.BYPASS;
    assert.equal(graph.isModified(), true);
    graph.markSaved();
    assert.equal(graph.isModified(), false);
    assert.equal(graph.serialize().nodes.find(n => n.id === node.id).mode, NODE_MODE.BYPASS);
});

test('bypassing a node drops it from the prompt and saves mode 4', () => {
    const graph = new HeadlessGraph(fixture.workflow, fixture.objectInfo);
    const node = graph._nodes.find(n => n.type === 'CLIPTextEncode' && n.mode === NODE_MODE.ALWAYS);
    node.mode = NODE_MODE.BYPASS;
    assert.equal(String(node.id) in buildPrompt(graph), false);
    assert.equal(graph.serialize().nodes.find(n => n.id === node.id).mode, NODE_MODE.BYPASS);
});

test('an active node of unknown type is refused, a bypassed one is not', () => {
    const workflow = structuredClone(fixture.workflow);
    const target = workflow.nodes.find(n => n.type === 'CLIPTextEncode' && (n.mode ?? 0) === 0);
    target.type = 'SomeFrontendOnlyNode';
    assert.throws(() => buildPrompt(new HeadlessGraph(workflow, fixture.objectInfo)), HeadlessPromptError);
    target.mode = NODE_MODE.BYPASS;
    assert.doesNotThrow(() => buildPrompt(new HeadlessGraph(workflow, fixture.objectInfo)));
});

test('control widget follows seed inputs and is not sent', () => {
    const { layout } = widgetLayout(fixture.objectInfo.KSampler, { inputs: [] });
    const seed = layout.findIndex(e => e.name === 'seed');
    assert.equal(layout[seed + 1].name, 'control_after_generate');
    assert.equal(layout[seed + 1].serialize, false);
});

test('dynamic prompts strip comments and resolve nested choices', () => {
    assert.equal(processDynamicPrompt('a // note\nb /* x */c'), 'a \nb c');
    assert.equal(processDynamicPrompt('{x|{y|z}}', () => 0.99), 'z');
    assert.equal(processDynamicPrompt('\\{lit\\}'), '{lit}');
});

test('seed controls step, randomize within range and skip linked inputs', () => {
    const graph = new HeadlessGraph(fixture.workflow, fixture.objectInfo);
    const sampler = graph._nodes.find(n => n.type === 'KSampler');
    const seed = sampler.widgets.find(w => w.name === 'seed');
    const control = seed.linkedWidgets.find(w => w.control);
    sampler.inputs.find(i => i.widget?.name === 'seed').link = null;
    seed.value = 10;
    control.value = 'increment';
    applyValueControls([sampler]);
    assert.equal(seed.value, 11);
    control.value = 'randomize';
    applyValueControls([sampler], () => 0.5);
    assert.equal(seed.value, Math.floor(0.5 * Math.min(0x4000000000000, seed.options.max)));
    control.value = 'fixed';
    assert.equal(applyValueControls([sampler]), 0);
    control.value = 'increment';
    sampler.inputs.find(i => i.widget?.name === 'seed').link = 999;
    assert.equal(applyValueControls([sampler]), 0, 'a linked seed input supplies its own value');
});

test('combo controls wrap and honour the filter list', () => {
    const combo = { type: 'combo', value: 'b', options: { values: ['a', 'b', 'c'] }, callback(v) { this.value = v; } };
    combo.linkedWidgets = [{ control: true, value: 'increment-wrap' }, { controlFilter: true, value: '' }];
    assert.equal(nextControlledValue(combo), 'c');
    combo.value = 'c';
    assert.equal(nextControlledValue(combo), 'a');
    combo.linkedWidgets[1].value = '/^[ab]$/';
    combo.value = 'a';
    assert.equal(nextControlledValue(combo), 'b');
});

test('groups sort like LiteGraph groups and edges follow containsCentre', () => {
    const workflow = {
        nodes: [
            // Bounds include the 30px title bar: centre = (x + 50, y + 5).
            { id: 1, type: 'Note', pos: [50, 95], size: [100, 40], widgets_values: [''] },   // centre (100, 100): inside
            { id: 2, type: 'Note', pos: [150, 95], size: [100, 40], widgets_values: [''] },  // centre (200, 100): on right edge
            { id: 3, type: 'Note', pos: [50, 215], size: [100, 40], widgets_values: [''] },  // centre (100, 220): on bottom edge
        ],
        links: [],
        groups: [
            { title: 'right', bounding: [500, 0, 100, 100] },
            { title: 'left', bounding: [0, 0, 200, 220] },
        ],
    };
    const graph = new HeadlessGraph(workflow, {});
    assert.deepEqual(graph._groups.map(g => g.pos), [[500, 0], [0, 0]]);
    const bridge = new ComfyBridge({ graph }, null, { standalone: true });
    const left = graph._groups.find(g => g.title === 'left');
    assert.deepEqual(bridge.getNodesInGroup(left).map(n => n.id), [1]);
});

test('date tokens match the frontend formatter', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(formatDate('yyyy-MM-dd hh:mm:ss yy M d', d), '2026-01-02 03:04:05 26 1 2');
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${name}\n     ${e.message}`);
    }
}
process.exit(failed ? 1 : 0);
