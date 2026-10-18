/**
 * ComfyDrawer — workflow tabs and drafts in the frontend's own storage
 *
 * The standalone page keeps its open workflows and unsaved edits where the
 * ComfyUI frontend (1.55) keeps them, in the same format, so switching
 * between the two in one browser shows the same tabs and the same unsaved
 * changes. Ported from the frontend's workflowDraftStoreV2 /
 * workflowPersistence:
 *
 *   localStorage
 *     Comfy.Workflow.DraftIndex.v2:<ws>     {v: 2, updatedAt, order: [hash], entries: {hash: {path, name, isTemporary, updatedAt}}}
 *     Comfy.Workflow.Draft.v2:<ws>:<hash>   {data: <workflow JSON string>, updatedAt}
 *     Comfy.Workflow.LastOpenPaths:<ws>     {workspaceId, paths: ["workflows/…"], activeIndex}
 *     Comfy.Workflow.LastActivePath:<ws>    {workspaceId, path}
 *   sessionStorage (per browser tab)
 *     Comfy.Workflow.OpenPaths:<clientId> / Comfy.Workflow.ActivePath:<clientId>
 *
 * `hash` is FNV-1a of the path; at most 32 drafts are kept (oldest evicted).
 * A frontend tab reads all of this once, when it loads: changes made here
 * show up there after a reload, and the other way round. The frontend
 * prefers its own sessionStorage pointer over LastOpenPaths, so writing the
 * tabs here drops this browser tab's pointers (left there when the page was
 * switched from ComfyUI in the same tab).
 */

/** The frontend's workspace id for a local ComfyUI (getWorkspaceId). */
const WORKSPACE = 'personal';
export const WORKFLOW_PREFIX = 'workflows/';
const MAX_DRAFTS = 32;

const KEYS = {
    draftIndex: `Comfy.Workflow.DraftIndex.v2:${WORKSPACE}`,
    draftPayload: (hash) => `Comfy.Workflow.Draft.v2:${WORKSPACE}:${hash}`,
    lastOpenPaths: `Comfy.Workflow.LastOpenPaths:${WORKSPACE}`,
    lastActivePath: `Comfy.Workflow.LastActivePath:${WORKSPACE}`,
    sessionPrefixes: ['Comfy.Workflow.OpenPaths:', 'Comfy.Workflow.ActivePath:'],
};

export function hashPath(path) {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
        h ^= path.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function read(storage, key) {
    try { return JSON.parse(storage.getItem(key)); } catch { return null; }
}

function write(storage, key, value) {
    try {
        storage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false; // full or unavailable: the in-memory state remains
    }
}

function remove(storage, key) {
    try { storage.removeItem(key); } catch { /* unavailable */ }
}

function readIndex() {
    const index = read(localStorage, KEYS.draftIndex);
    const valid = index?.v === 2 && typeof index.updatedAt === 'number'
        && Array.isArray(index.order) && index.entries && typeof index.entries === 'object';
    return valid ? index : { v: 2, updatedAt: Date.now(), order: [], entries: {} };
}

/** The open tabs: {paths: ["workflows/…"], activeIndex}, or null. */
export function readOpenTabs() {
    const tabs = read(localStorage, KEYS.lastOpenPaths);
    if (!Array.isArray(tabs?.paths) || typeof tabs.activeIndex !== 'number') return null;
    const paths = tabs.paths.filter(p => typeof p === 'string' && p.startsWith(WORKFLOW_PREFIX));
    return paths.length ? { paths, activeIndex: tabs.activeIndex } : null;
}

export function writeOpenTabs(paths, activeIndex) {
    write(localStorage, KEYS.lastOpenPaths, { workspaceId: WORKSPACE, paths, activeIndex });
    // With every tab closed the frontend would otherwise reopen the last
    // active workflow; without the pointer it starts like a fresh install.
    if (paths[activeIndex]) write(localStorage, KEYS.lastActivePath, { workspaceId: WORKSPACE, path: paths[activeIndex] });
    else remove(localStorage, KEYS.lastActivePath);
    try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
            const key = sessionStorage.key(i);
            if (KEYS.sessionPrefixes.some(p => key?.startsWith(p))) sessionStorage.removeItem(key);
        }
    } catch { /* unavailable */ }
}

/** The draft of `path`: {workflow, name, isTemporary, updatedAt}, or null. */
export function readDraft(path) {
    const entry = readIndex().entries[hashPath(path)];
    if (!entry) return null;
    const payload = read(localStorage, KEYS.draftPayload(hashPath(path)));
    try {
        return { workflow: JSON.parse(payload.data), name: entry.name, isTemporary: !!entry.isTemporary, updatedAt: payload.updatedAt };
    } catch {
        removeDraft(path);
        return null;
    }
}

/**
 * Store `workflow` as the draft of `path`. `name` is the path below
 * workflows/ (the frontend's workflow key); `isTemporary` marks a workflow
 * that was never saved.
 */
export function writeDraft(path, workflow, { name, isTemporary }) {
    const hash = hashPath(path);
    const updatedAt = Date.now();
    if (!write(localStorage, KEYS.draftPayload(hash), { data: JSON.stringify(workflow), updatedAt })) return false;
    const index = readIndex();
    const entries = { ...index.entries, [hash]: { name, isTemporary, updatedAt, path } };
    const order = [...index.order.filter(k => k !== hash), hash];
    while (order.length > MAX_DRAFTS) {
        const evicted = order.shift();
        delete entries[evicted];
        remove(localStorage, KEYS.draftPayload(evicted));
    }
    return write(localStorage, KEYS.draftIndex, { v: 2, updatedAt, order, entries });
}

export function removeDraft(path) {
    const hash = hashPath(path);
    const index = readIndex();
    remove(localStorage, KEYS.draftPayload(hash));
    if (!(hash in index.entries)) return;
    const entries = { ...index.entries };
    delete entries[hash];
    write(localStorage, KEYS.draftIndex, { v: 2, updatedAt: Date.now(), order: index.order.filter(k => k !== hash), entries });
}
