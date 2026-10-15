/**
 * ComfyDrawer — standalone workflow menu
 *
 * Tab-bar button on the standalone page showing the active workflow and its
 * save state. It opens a menu like the ComfyUI workflow sidebar plus its
 * tabs: open workflows on top, then bookmarks (the sidebar's own, shared via
 * workflows/.index.json) and the saved-workflow tree. Routes HeadlessApp save
 * conflicts and queue errors to dialogs. Standalone only.
 */
import { t } from './locale.js';
import { showDialog, showAlert, showConfirm, showPrompt } from './dialog.js';
import { showToast } from './toast.js';
import { placeAboveTabBar } from './popover.js';
import { SaveConflictError, workflowName } from '../headless/headless-app.js';

const EXPANDED_KEY = 'comfy-drawer-standalone-expanded-folders';
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
    save: svg('<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>'),
    workflow: svg('<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>'),
    file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
    folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
    chevron: svg('<path d="m9 18 6-6-6-6"/>'),
    bookmark: svg('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

/** The frontend sidebar's order: locale-aware by full file name. */
const byName = (a, b) => a.localeCompare(b);

const loadExpanded = () => {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY)) ?? []); } catch { return new Set(); }
};
const saveExpanded = (set) => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set])); } catch { /* storage unavailable */ }
};

/** Nest flat paths into {folders: Map<name, node>, files: path[], count}. */
function buildTree(paths) {
    const root = { folders: new Map(), files: [], count: 0 };
    for (const path of paths) {
        const parts = path.split('/');
        let node = root;
        node.count++;
        for (const dir of parts.slice(0, -1)) {
            if (!node.folders.has(dir)) node.folders.set(dir, { folders: new Map(), files: [], count: 0 });
            node = node.folders.get(dir);
            node.count++;
        }
        node.files.push(path);
    }
    return root;
}

function row(className, iconHTML, label) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `comfy-drawer-burger-item cd-wf-row ${className}`;
    const icon = document.createElement('span');
    icon.className = 'comfy-drawer-tab-icon';
    icon.innerHTML = iconHTML;
    const text = document.createElement('span');
    text.className = 'cd-wf-label';
    text.textContent = label;
    item.append(icon, text);
    return item;
}

function sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'cd-wf-section';
    el.textContent = text;
    return el;
}

function rowAction(iconHTML, title, onClick) {
    const btn = document.createElement('span');
    btn.className = 'cd-wf-action';
    btn.setAttribute('role', 'button');
    btn.title = title;
    btn.innerHTML = iconHTML;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

async function openWorkflow(app, path) {
    try {
        await app.openWorkflow(path);
    } catch (e) {
        showToast(t('standalone.openFailed', { message: e.message }), { variant: 'danger' });
    }
}

async function saveAs(app) {
    const name = await showPrompt(t('standalone.saveAsPrompt'), { defaultValue: app.file.name || '' });
    if (!name?.trim()) return;
    const path = `${name.trim().replace(/\.json$/i, '')}.json`;
    try {
        await app.save({ path });
    } catch (e) {
        if (!(e instanceof SaveConflictError)) return;
        if (await showConfirm(t('standalone.exists', { name: path }), { confirmLabel: t('standalone.overwrite') })) {
            await app.save({ path, force: true }).catch(() => {});
        }
    }
}

/** Save the active workflow (Save as for one that has no file yet). */
async function saveActive(app) {
    if (!app.active) return;
    if (!app.file.path) {
        await saveAs(app);
        return;
    }
    try {
        await app.save();
        showToast(t('standalone.saved', { name: app.file.name }), { variant: 'success' });
    } catch { /* conflicts and errors are reported through save-state */ }
}

async function closeWorkflow(app, wf) {
    if (wf.modified && !(await showConfirm(t('standalone.discardChanges', { name: wf.file.name }),
        { confirmLabel: t('standalone.discard'), danger: true }))) return;
    await app.closeWorkflow(wf);
}

async function resolveConflict(app, wf) {
    const overwrite = await showDialog({
        title: t('standalone.conflictTitle'),
        variant: 'warning',
        message: t('standalone.conflictMessage', { name: wf.file.name }),
        confirmLabel: t('standalone.overwrite'),
        cancelLabel: t('standalone.reload'),
        dismissOnBackdrop: false,
    });
    if (overwrite) await app.save({ workflow: wf, force: true }).catch(() => {});
    else await app.reloadWorkflow(wf).catch(e => showToast(t('standalone.openFailed', { message: e.message }), { variant: 'danger' }));
}

/**
 * Build the menu body. `files`/`bookmarks` are null until loaded.
 * @returns {HTMLElement}
 */
function renderMenu(app, state, close, rerender) {
    const body = document.createElement('div');
    body.className = 'cd-wf-body';

    if (app.workflows.length) {
        body.appendChild(sectionTitle(t('standalone.openWorkflows')));
        for (const wf of app.workflows) {
            const item = row('cd-wf-open', ICONS.workflow, wf.file.name);
            item.classList.toggle('active', wf === app.active);
            item.dataset.unsaved = wf.file.path ? 'false' : 'true';
            item.dataset.saveState = wf.modified && wf.saveState !== 'saving' && wf.saveState !== 'conflict' && wf.saveState !== 'error'
                ? 'modified' : wf.saveState;
            item.title = wf.file.path ?? `${wf.file.name} (${t('standalone.unsaved')})`;
            const dot = document.createElement('span');
            dot.className = 'cd-workflow-state';
            item.append(dot, rowAction(ICONS.close, t('common.close'), () => closeWorkflow(app, wf).then(rerender)));
            item.addEventListener('click', () => { close(); app.activate(wf); });
            body.appendChild(item);
        }
        if (app.active) {
            const saveItem = row('cd-wf-save', ICONS.save, app.file.path ? t('standalone.save') : t('standalone.saveAs'));
            saveItem.disabled = !!app.file.path && !app.active.modified;
            const hint = document.createElement('span');
            hint.className = 'cd-wf-hint';
            hint.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
            saveItem.appendChild(hint);
            saveItem.addEventListener('click', () => { close(); saveActive(app); });
            body.appendChild(saveItem);
            if (app.file.path) {
                const saveAsItem = row('cd-wf-saveas', ICONS.file, t('standalone.saveAs'));
                saveAsItem.addEventListener('click', () => { close(); saveAs(app); });
                body.appendChild(saveAsItem);
            }
        }
        const sep = document.createElement('div');
        sep.className = 'comfy-drawer-burger-sep';
        body.appendChild(sep);
    }

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'cd-dialog-input cd-wf-search';
    search.placeholder = t('standalone.search');
    search.value = state.query;
    search.addEventListener('input', () => {
        state.query = search.value;
        rerender({ focusSearch: true });
    });
    body.appendChild(search);

    if (!state.files) {
        const loading = document.createElement('div');
        loading.className = 'cd-wf-empty';
        loading.textContent = t('common.loading');
        body.appendChild(loading);
        return body;
    }

    const bookmarked = new Set(state.bookmarks ?? []);
    const toggleBookmark = async (path) => {
        try {
            await app.setBookmarked(path, !bookmarked.has(path));
            state.bookmarks = await app.listBookmarks();
            rerender();
        } catch (e) {
            showToast(t('standalone.bookmarkFailed', { message: e.message }), { variant: 'danger' });
        }
    };
    const fileRow = (path, label = workflowName(path), depth = 0) => {
        const item = row('cd-wf-file', ICONS.file, label);
        item.style.paddingLeft = `${14 + depth * 16}px`;
        item.classList.toggle('active', path === app.file.path);
        item.title = path;
        const mark = rowAction(ICONS.bookmark,
            bookmarked.has(path) ? t('standalone.removeBookmark') : t('standalone.addBookmark'),
            () => toggleBookmark(path));
        mark.classList.add('cd-wf-bookmark');
        mark.classList.toggle('on', bookmarked.has(path));
        item.appendChild(mark);
        item.addEventListener('click', () => { close(); openWorkflow(app, path); });
        return item;
    };

    const q = state.query.trim().toLowerCase();
    const known = new Set(state.files.map(f => f.path));
    const marks = [...bookmarked].filter(p => known.has(p) && (!q || p.toLowerCase().includes(q))).sort(byName);
    if (marks.length) {
        body.appendChild(sectionTitle(t('standalone.bookmarks')));
        for (const path of marks) body.appendChild(fileRow(path));
    }

    body.appendChild(sectionTitle(t('standalone.browse')));
    if (q) {
        const hits = state.files.map(f => f.path).filter(p => p.toLowerCase().includes(q)).sort(byName);
        for (const path of hits) body.appendChild(fileRow(path, path.replace(/\.json$/, '')));
        if (!hits.length) {
            const empty = document.createElement('div');
            empty.className = 'cd-wf-empty';
            empty.textContent = t('standalone.noWorkflows');
            body.appendChild(empty);
        }
        return body;
    }

    const renderFolder = (node, prefix, depth) => {
        for (const name of [...node.folders.keys()].sort(byName)) {
            const key = prefix + name;
            const child = node.folders.get(name);
            const open = state.expanded.has(key);
            const item = row('cd-wf-folder', ICONS.folder, name);
            item.style.paddingLeft = `${14 + depth * 16}px`;
            const chevron = document.createElement('span');
            chevron.className = 'cd-wf-chevron';
            chevron.classList.toggle('open', open);
            chevron.innerHTML = ICONS.chevron;
            item.prepend(chevron);
            const count = document.createElement('span');
            count.className = 'cd-wf-count';
            count.textContent = String(child.count);
            item.appendChild(count);
            item.addEventListener('click', () => {
                if (open) state.expanded.delete(key);
                else state.expanded.add(key);
                saveExpanded(state.expanded);
                rerender();
            });
            body.appendChild(item);
            if (open) renderFolder(child, `${key}/`, depth + 1);
        }
        for (const path of [...node.files].sort(byName)) body.appendChild(fileRow(path, undefined, depth));
    };
    renderFolder(buildTree(state.files.map(f => f.path)), '', 0);
    if (!state.files.length) {
        const empty = document.createElement('div');
        empty.className = 'cd-wf-empty';
        empty.textContent = t('standalone.noWorkflows');
        body.appendChild(empty);
    }
    return body;
}

/**
 * @param {import('../core/drawer-shell.js').DrawerShell} shell
 * @param {import('../headless/headless-app.js').HeadlessApp} app
 */
export function attachStandaloneWorkflowBar(shell, app) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'comfy-drawer-tab cd-standalone-workflow';
    const icon = document.createElement('span');
    icon.className = 'comfy-drawer-tab-icon';
    icon.innerHTML = ICONS.workflow;
    const label = document.createElement('span');
    label.className = 'comfy-drawer-tab-label';
    const dot = document.createElement('span');
    dot.className = 'cd-workflow-state';
    button.append(icon, label, dot);

    let menu = null;
    let menuAnchor = button;
    let rerender = () => {};
    const closeMenu = () => {
        menu?.remove();
        menu = null;
        rerender = () => {};
        document.removeEventListener('pointerdown', onOutside, true);
    };
    function onOutside(e) {
        // Only the workflow button toggles the menu; opened from ☰, pressing ☰ again closes it.
        if (menu && !menu.contains(e.target) && !(menuAnchor === button && button.contains(e.target))) closeMenu();
    }

    const openMenu = (anchor = button) => {
        menuAnchor = anchor;
        const root = anchor.closest('.comfy-drawer');
        menu = document.createElement('div');
        menu.className = 'cd-workflow-menu';
        const state = { query: '', files: null, bookmarks: null, expanded: loadExpanded() };
        rerender = ({ focusSearch = false } = {}) => {
            if (!menu) return;
            const scroll = menu.querySelector('.cd-wf-body')?.scrollTop ?? 0;
            menu.replaceChildren(renderMenu(app, state, closeMenu, rerender));
            menu.querySelector('.cd-wf-body').scrollTop = scroll;
            if (focusSearch) {
                const input = menu.querySelector('.cd-wf-search');
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
        };
        rerender();
        placeAboveTabBar(menu, anchor, root);
        setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
        Promise.all([app.listWorkflows(), app.listBookmarks().catch(() => [])])
            .then(([files, bookmarks]) => {
                state.files = files;
                state.bookmarks = bookmarks;
                rerender();
            })
            .catch((e) => {
                closeMenu();
                showToast(t('standalone.openFailed', { message: e.message }), { variant: 'danger' });
            });
    };

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu && menuAnchor === button) closeMenu();
        else {
            closeMenu();
            openMenu(button);
        }
    });
    // A menu action; pinned, the button shows the open workflow's name.
    shell.addBurgerAction({
        id: 'workflow',
        order: -20,
        icon: ICONS.workflow,
        label: () => app.file.name || t('standalone.openWorkflow'),
        tabElement: button,
        action: (anchor) => {
            closeMenu();
            openMenu(anchor);
        },
    });

    const render = () => {
        label.textContent = app.file.name || t('standalone.openWorkflow');
        button.title = app.file.path
            ? app.file.path
            : (app.file.name ? `${app.file.name} (${t('standalone.unsaved')})` : t('standalone.openWorkflow'));
        button.dataset.unsaved = app.file.name && !app.file.path ? 'true' : 'false';
        button.dataset.saveState = app.active?.modified && !['saving', 'conflict', 'error'].includes(app.saveState)
            ? 'modified' : app.saveState;
    };
    render();

    app.addEventListener('workflow-changed', render);
    app.addEventListener('tabs-changed', () => rerender());
    app.addEventListener('save-state', (e) => {
        const { workflow, state, error } = e.detail;
        render();
        rerender();
        if (state === 'conflict') resolveConflict(app, workflow);
        else if (state === 'error') showToast(t('standalone.saveFailed', { message: error?.message || '' }), { variant: 'danger' });
    });
    app.addEventListener('queue-error', (e) => {
        showAlert(e.detail.message, { title: t('standalone.queueFailed'), variant: 'danger' });
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveActive(app);
        }
    });

    app.restoreOpenWorkflows();
}
