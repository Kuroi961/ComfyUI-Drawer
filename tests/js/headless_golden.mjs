// Replays headless prompt-builder fixtures and diffs against the prompts the
// real ComfyUI frontend produced. Usage:
//   node tests/js/headless_golden.mjs <fixture-dir> [--verbose]
//
// Every variant must either produce the identical prompt or be refused with a
// HeadlessPromptError — never a silently different prompt. Refusals are fine
// when the frontend's own prompt is invalid (missing node types); others are
// reported as "safe" so coverage stays visible.
// Exit code 1 on any mismatch.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '..', '..');
const { HeadlessGraph } = await import(pathToFileURL(join(repo, 'web/js/headless/headless-graph.js')));
const { buildPrompt } = await import(pathToFileURL(join(repo, 'web/js/headless/prompt-builder.js')));

const dir = process.argv[2];
const verbose = process.argv.includes('--verbose');
if (!dir) {
    console.error('usage: node headless_golden.mjs <fixture-dir>');
    process.exit(2);
}

/** Compare one node. Titles only when set to something other than the
 *  display name (the frontend localizes default titles). Extension buttons
 *  serialize their label or null; the backend never reads them. */
function diffNode(id, actual, expected, explicitTitle) {
    const problems = [];
    if (!actual) return [`${id}: missing (expected ${expected.class_type})`];
    if (actual.class_type !== expected.class_type) {
        problems.push(`${id}: class_type ${actual.class_type} != ${expected.class_type}`);
    }
    if (explicitTitle && actual._meta?.title !== expected._meta?.title) {
        problems.push(`${id}: title ${JSON.stringify(actual._meta?.title)} != ${JSON.stringify(expected._meta?.title)}`);
    }
    const keys = new Set([...Object.keys(actual.inputs), ...Object.keys(expected.inputs)]);
    // %date:…% expands to the capture time; compare its shape, not its digits.
    const norm = (k, v) => (k === 'filename_prefix' && typeof v === 'string' ? v.replace(/\d/g, '#') : v);
    for (const k of keys) {
        const av = actual.inputs[k];
        const ev = expected.inputs[k];
        if (av == null && (ev === null || ev === k)) continue;
        const a = JSON.stringify(norm(k, av));
        const e = JSON.stringify(norm(k, ev));
        if (a !== e) problems.push(`${id}.${k}: ${a?.slice(0, 120)} != ${e?.slice(0, 120)}`);
    }
    return problems;
}

function run(workflow, objectInfo, variant) {
    const graph = new HeadlessGraph(workflow, objectInfo);
    for (const [id, mode] of Object.entries(variant.modes)) {
        const node = graph.getNodeById(id);
        if (node) node.mode = mode;
    }
    let actual;
    try {
        actual = buildPrompt(graph, { random: () => 0 });
    } catch (e) {
        if (e.name !== 'HeadlessPromptError') throw e;
        return { refused: e.message };
    }
    const titled = new Set();
    for (const n of graph.allNodesDeep()) {
        if (n.hasExplicitTitle && n.title !== n.def?.display_name) titled.add(String(n.id));
    }
    const problems = [];
    for (const id of new Set([...Object.keys(actual), ...Object.keys(variant.expected)])) {
        if (!(id in variant.expected)) {
            problems.push(`${id}: unexpected ${actual[id].class_type}`);
            continue;
        }
        problems.push(...diffNode(id, actual[id], variant.expected[id], titled.has(id.split(':').pop())));
    }
    return { problems, size: Object.keys(actual).length };
}

const tally = { ok: 0, refused: 0, fail: 0 };
const report = (status, label, detail = '') => {
    tally[status]++;
    console.log(`${{ ok: 'ok  ', refused: 'safe', fail: 'FAIL' }[status]} ${label}${detail}`);
};

for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const fixture = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    const graph = new HeadlessGraph(fixture.workflow, fixture.objectInfo);
    if (graph.renumberedLastNodeId !== null) {
        console.log(`note ${file} [round-trip]: subgraph node ids renumbered, saved as the frontend would`);
    } else if (JSON.stringify(graph.serialize()) !== JSON.stringify(fixture.workflow)) {
        report('fail', `${file} [round-trip]`, ': untouched graph does not serialize to the saved workflow');
    } else {
        report('ok', `${file} [round-trip]`);
    }

    for (const variant of fixture.variants) {
        const label = `${file} [${variant.name}]`;
        if (variant.error) {
            console.log(`skip ${label}: frontend errored (${variant.error})`);
            continue;
        }
        const r = run(fixture.workflow, fixture.objectInfo, variant);
        if (r.refused) {
            report('refused', label, `: refused (${r.refused.replaceAll('\n', '; ')})`);
        } else if (r.problems.length) {
            report('fail', label, `: ${r.problems.length} difference(s)`);
            for (const p of r.problems.slice(0, verbose ? 200 : 8)) console.log('    ', p);
        } else {
            report('ok', label, ` (${r.size} nodes)`);
        }
    }
}
console.log(`\n${tally.ok} match, ${tally.refused} refused safely, ${tally.fail} failed`);
process.exit(tally.fail ? 1 : 0);
