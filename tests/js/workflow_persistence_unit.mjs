// web/js/headless/workflow-persistence.js keeps the standalone page's tabs
// and drafts in the ComfyUI frontend's own storage (1.55 workflowDraftStoreV2 /
// workflowPersistence). The expectations below are the frontend's format; if
// a frontend update changes it, these are the facts to re-check.
// Usage: node tests/js/workflow_persistence_unit.mjs
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class MemoryStorage {
    #items = new Map();
    get length() { return this.#items.size; }
    key(i) { return [...this.#items.keys()][i] ?? null; }
    getItem(k) { return this.#items.has(k) ? this.#items.get(k) : null; }
    setItem(k, v) { this.#items.set(k, String(v)); }
    removeItem(k) { this.#items.delete(k); }
    clear() { this.#items.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const repo = resolve(import.meta.dirname, '..', '..');
const persistence = await import(pathToFileURL(join(repo, 'web/js/headless/workflow-persistence.js')));
const { hashPath, readOpenTabs, writeOpenTabs, readDraft, writeDraft, removeDraft } = persistence;

const json = (storage, key) => JSON.parse(storage.getItem(key));
const tests = [];
const test = (name, fn) => tests.push([name, () => {
    localStorage.clear();
    sessionStorage.clear();
    fn();
}]);

test('path hash is the frontend FNV-1a', () => {
    // Computed with the frontend's own hashPath (settingStore bundle).
    assert.equal(hashPath('workflows/a.json'), '98b21bfb');
    assert.equal(hashPath('workflows/Unsaved Workflow (2).json'), 'b65dc868');
    assert.equal(hashPath('workflows/日本語/テスト.json'), '739d3965');
});

test('a draft is written as the frontend writes it', () => {
    const workflow = { nodes: [{ id: 1 }], links: [] };
    assert.equal(writeDraft('workflows/a.json', workflow, { name: 'a.json', isTemporary: false }), true);
    const index = json(localStorage, 'Comfy.Workflow.DraftIndex.v2:personal');
    assert.equal(index.v, 2);
    assert.deepEqual(index.order, ['98b21bfb']);
    const entry = index.entries['98b21bfb'];
    assert.deepEqual({ ...entry, updatedAt: 0 }, { name: 'a.json', isTemporary: false, updatedAt: 0, path: 'workflows/a.json' });
    const payload = json(localStorage, 'Comfy.Workflow.Draft.v2:personal:98b21bfb');
    assert.equal(typeof payload.data, 'string');
    assert.deepEqual(JSON.parse(payload.data), workflow);
    assert.equal(payload.updatedAt, entry.updatedAt);
});

test('a draft the frontend wrote is read back', () => {
    const path = 'workflows/Unsaved Workflow (2).json';
    localStorage.setItem('Comfy.Workflow.DraftIndex.v2:personal', JSON.stringify({
        v: 2, updatedAt: 5, order: ['b65dc868'],
        entries: { b65dc868: { name: 'Unsaved Workflow (2).json', isTemporary: true, updatedAt: 5, path } },
    }));
    localStorage.setItem('Comfy.Workflow.Draft.v2:personal:b65dc868', JSON.stringify({ data: '{"nodes":[]}', updatedAt: 5 }));
    assert.deepEqual(readDraft(path), { workflow: { nodes: [] }, name: 'Unsaved Workflow (2).json', isTemporary: true, updatedAt: 5 });
    removeDraft(path);
    assert.equal(readDraft(path), null);
    assert.equal(localStorage.getItem('Comfy.Workflow.Draft.v2:personal:b65dc868'), null);
    assert.deepEqual(json(localStorage, 'Comfy.Workflow.DraftIndex.v2:personal').order, []);
});

test('at most 32 drafts are kept, oldest evicted', () => {
    for (let i = 0; i < 33; i++) writeDraft(`workflows/${i}.json`, { i }, { name: `${i}.json`, isTemporary: false });
    const index = json(localStorage, 'Comfy.Workflow.DraftIndex.v2:personal');
    assert.equal(index.order.length, 32);
    assert.equal(readDraft('workflows/0.json'), null);
    assert.equal(localStorage.getItem(`Comfy.Workflow.Draft.v2:personal:${hashPath('workflows/0.json')}`), null);
    assert.deepEqual(readDraft('workflows/32.json').workflow, { i: 32 });
});

test('open tabs go where a new frontend tab looks, replacing this tab\'s pointers', () => {
    sessionStorage.setItem('Comfy.Workflow.OpenPaths:client-1', '{"workspaceId":"personal","paths":["workflows/old.json"],"activeIndex":0}');
    sessionStorage.setItem('Comfy.Workflow.ActivePath:client-1', '{"workspaceId":"personal","path":"workflows/old.json"}');
    sessionStorage.setItem('unrelated', 'kept');
    writeOpenTabs(['workflows/a.json', 'workflows/b.json'], 1);
    assert.deepEqual(json(localStorage, 'Comfy.Workflow.LastOpenPaths:personal'),
        { workspaceId: 'personal', paths: ['workflows/a.json', 'workflows/b.json'], activeIndex: 1 });
    assert.deepEqual(json(localStorage, 'Comfy.Workflow.LastActivePath:personal'), { workspaceId: 'personal', path: 'workflows/b.json' });
    assert.equal(sessionStorage.length, 1);
    assert.deepEqual(readOpenTabs(), { paths: ['workflows/a.json', 'workflows/b.json'], activeIndex: 1 });
});

test('closing every tab drops the active pointer too', () => {
    writeOpenTabs(['workflows/a.json'], 0);
    writeOpenTabs([], 0);
    assert.deepEqual(json(localStorage, 'Comfy.Workflow.LastOpenPaths:personal'), { workspaceId: 'personal', paths: [], activeIndex: 0 });
    assert.equal(localStorage.getItem('Comfy.Workflow.LastActivePath:personal'), null);
    assert.equal(readOpenTabs(), null);
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
