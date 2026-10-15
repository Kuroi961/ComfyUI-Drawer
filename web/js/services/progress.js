/**
 * ComfyDrawer — run progress indicator
 *
 * A strip above the tab bar showing the running prompt's progress (the
 * current node's steps, the whole run as a thin line beneath) and how many
 * are waiting, visible from every gadget (and above the closed drawer's pill
 * inside ComfyUI). Tapping it — or the "Queue" menu action, which can be
 * pinned to the tab bar — opens a popover with the running run (stop), the
 * pending queue (remove) and recent results (open / error).
 *
 * Runs queued from any client are followed: Drawer's server relays the
 * per-prompt events ComfyUI sends only to the queuing client as
 * `drawer.progress` (progress_relay.py); queue and history come from
 * ComfyUI's /jobs API.
 */
import { t } from './locale.js';
import { showAlert } from './dialog.js';
import { showToast } from './toast.js';
import { openLightbox } from './lightbox.js';
import { placeAboveTabBar } from './popover.js';

const RECENT_LIMIT = 8;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
    queue: svg('<path d="M3 12h4l3 8 4-16 3 8h4"/>'),
    stop: svg('<rect width="14" height="14" x="5" y="5" rx="2"/>'),
    remove: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    failed: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
    file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
};

const formatDuration = (ms) => {
    if (!(ms >= 0)) return '';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

/** Follows the current run from relayed events; `onChange` fires on every update. */
class RunTracker {
    constructor(bridge, onChange) {
        this.bridge = bridge;
        this.onChange = onChange;
        /** @type {null|{promptId, workflowId, node, value, max, done: Set<string>, total: number|null, titles: object, startedAt: number}} */
        this.running = null;
        this.queueRemaining = 0;
        this.names = {};
    }

    get pending() {
        return Math.max(0, this.queueRemaining - (this.running ? 1 : 0));
    }

    /** Overall progress 0..1 (finished nodes plus the current node's steps), or null. */
    get fraction() {
        const r = this.running;
        if (!r?.total) return null;
        const current = r.node && !r.done.has(r.node) && r.max ? r.value / r.max : 0;
        return Math.min(1, (r.done.size + current) / r.total);
    }

    /** Step progress 0..1 of the node that reports steps (a sampler), or null. */
    get stepFraction() {
        const r = this.running;
        return r?.max ? Math.min(1, r.value / r.max) : null;
    }

    async workflowName(workflowId) {
        if (!workflowId) return '';
        if (!(workflowId in this.names)) {
            try {
                const resp = await this.bridge.fetchApi('/drawer/workflows/names');
                if (resp.ok) this.names = await resp.json();
            } catch { /* names are cosmetic */ }
            if (!(workflowId in this.names)) this.names[workflowId] = '';
        }
        return (this.names[workflowId] || '').replace(/\.json$/, '');
    }

    /** Node count and titles come from /queue: a running job's /jobs record has no prompt. */
    async #describe(run) {
        try {
            const resp = await this.bridge.fetchApi('/queue');
            if (!resp.ok) return;
            const { queue_running: running = [] } = await resp.json();
            const entry = running.find(item => item[1] === run.promptId);
            const prompt = entry?.[2] ?? {};
            run.total = Object.keys(prompt).length || null;
            run.titles = Object.fromEntries(Object.entries(prompt)
                .map(([id, node]) => [id, node?._meta?.title || node?.class_type || id]));
            run.workflowId ??= entry?.[3]?.extra_pnginfo?.workflow?.id;
            run.workflowName = await this.workflowName(run.workflowId);
        } catch { /* keep the bare progress */ }
        if (this.running === run) this.onChange();
    }

    #start(promptId, workflowId) {
        const run = { promptId, workflowId, node: null, value: 0, max: 0, done: new Set(), total: null, titles: {}, workflowName: '', startedAt: Date.now() };
        this.running = run;
        this.#describe(run);
        return run;
    }

    handle({ event, prompt_id: promptId, workflow_id: workflowId, ...data }) {
        let run = this.running?.promptId === promptId ? this.running : null;
        if (event === 'execution_start' || (!run && event !== 'execution_success' && event !== 'execution_error' && event !== 'execution_interrupted')) {
            run = this.#start(promptId, workflowId);
        }
        switch (event) {
            case 'execution_cached':
                for (const id of data.nodes ?? []) run.done.add(String(id));
                break;
            case 'executing':
                if (run.node) run.done.add(run.node);
                run.node = data.node == null ? null : String(data.node);
                run.value = 0;
                run.max = 0;
                if (data.node == null) this.running = null;
                break;
            case 'progress':
                run.node = String(data.node ?? run.node);
                run.value = data.value;
                run.max = data.max;
                break;
            case 'execution_success':
            case 'execution_interrupted':
                if (run) this.running = null;
                break;
            case 'execution_error':
                if (run) this.running = null;
                showToast(t('progress.failed', { node: data.node_type || data.node_id || '', message: data.exception_message || '' }), {
                    variant: 'danger',
                    duration: this.showLogs ? 10000 : 6000,
                    action: this.showLogs ? { label: t('logs.show'), onClick: this.showLogs } : undefined,
                });
                break;
        }
        this.onChange();
    }

    setQueueRemaining(n) {
        this.queueRemaining = Number(n) || 0;
        if (!this.queueRemaining) this.running = null;
        this.onChange();
    }
}

function row(className, label, detail) {
    const item = document.createElement('div');
    item.className = `comfy-drawer-burger-item cd-run-row ${className}`;
    const text = document.createElement('span');
    text.className = 'cd-wf-label';
    text.textContent = label;
    item.appendChild(text);
    if (detail) {
        const meta = document.createElement('span');
        meta.className = 'cd-run-meta';
        meta.textContent = detail;
        item.appendChild(meta);
    }
    return item;
}

function action(iconHTML, title, onClick) {
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

function sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'cd-wf-section';
    el.textContent = text;
    return el;
}

async function fetchJobs(bridge, status, limit) {
    const resp = await bridge.fetchApi(`/jobs?status=${status}${limit ? `&limit=${limit}` : ''}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()).jobs ?? [];
}

async function showFailure(bridge, job) {
    let message = '';
    try {
        const detail = await (await bridge.fetchApi(`/jobs/${encodeURIComponent(job.id)}`)).json();
        const error = detail.execution_status?.messages?.find(m => m[0] === 'execution_error')?.[1];
        if (error) message = `${error.node_type ?? ''}: ${error.exception_message ?? ''}`.trim();
    } catch { /* fall back to the generic text */ }
    showAlert(message || t('progress.failedNoDetail'), { title: t('progress.failedTitle'), variant: 'danger' });
}

function previewItem(bridge, output) {
    const kind = output.metadata?.kind
        ?? (/\.(mp4|webm|mov|mkv)$/i.test(output.filename) ? 'video' : /\.(mp3|wav|flac|ogg|opus)$/i.test(output.filename) ? 'audio' : 'image');
    const subfolder = String(output.subfolder ?? '').replace(/\\/g, '/');
    return {
        src: bridge.getImageUrl(output.filename, subfolder, output.type || 'output'),
        name: output.filename,
        subfolder,
        source: output.type || 'output',
        type: kind,
    };
}

/**
 * @param {import('../core/drawer-shell.js').DrawerShell} shell
 * @param {import('../core/comfy-bridge.js').ComfyBridge} bridge
 * @param {{enabled: () => boolean}} opts - whether the indicator may show
 */
export function attachProgressIndicator(shell, bridge, { enabled }) {
    // Strip: fill = the current node's steps (a sampler), or the whole run
    // when that node reports no steps; bottom line = the whole run.
    const strip = document.createElement('div');
    strip.className = 'cd-run-strip';
    strip.setAttribute('role', 'button');
    strip.tabIndex = 0;
    const fill = document.createElement('span');
    fill.className = 'cd-run-fill';
    const overall = document.createElement('span');
    overall.className = 'cd-run-overall';
    const label = document.createElement('span');
    label.className = 'cd-run-label';
    const meta = document.createElement('span');
    meta.className = 'cd-run-stripmeta';
    strip.append(fill, overall, label, meta);
    shell.addTabBarHeader(strip);

    // Queue action: in the menu, or pinned to the tab bar with a count badge.
    const queueTab = document.createElement('button');
    queueTab.type = 'button';
    queueTab.className = 'comfy-drawer-tab cd-queue-tab';
    const queueIcon = document.createElement('span');
    queueIcon.className = 'comfy-drawer-tab-icon';
    queueIcon.innerHTML = ICONS.queue;
    const queueCount = document.createElement('span');
    queueCount.className = 'cd-queue-count';
    queueTab.append(queueIcon, queueCount);

    const baseTitle = document.title;
    let menu = null;
    let menuAnchor = null;
    let renderMenu = () => {};

    const tracker = new RunTracker(bridge, () => {
        render();
        renderMenu();
    });
    // The failure toast links to the Logs gadget while it is registered.
    Object.defineProperty(tracker, 'showLogs', {
        get: () => (shell.getGadgets().some(g => g.id === 'logs') ? () => shell.open('logs') : null),
    });

    function render() {
        strip.hidden = !enabled();
        if (strip.hidden && menu && menuAnchor === strip) closeMenu();
        const run = tracker.running;
        const fraction = tracker.fraction;
        const pct = fraction == null ? null : Math.floor(fraction * 100);
        const current = tracker.stepFraction ?? fraction;
        const shown = current == null ? null : Math.floor(current * 100);
        fill.style.width = `${run ? shown ?? 0 : 0}%`;
        overall.style.width = `${run ? pct ?? 0 : 0}%`;
        strip.classList.toggle('running', !!run);
        strip.classList.toggle('indeterminate', !!run && shown == null);
        const node = run?.node ? (run.titles[run.node] ?? '') : '';
        label.textContent = run
            ? [run.workflowName, node].filter(Boolean).join(' › ') || t('progress.untitled')
            : t('progress.idleStrip');
        const parts = [];
        if (run?.max) parts.push(`${run.value}/${run.max}`);
        if (run) parts.push(shown == null ? '…' : `${shown}%`);
        if (tracker.pending) parts.push(`+${tracker.pending}`);
        meta.textContent = parts.join('  ');
        const title = run
            ? t('progress.running', { name: run.workflowName || '' }).trim()
            : tracker.pending ? t('progress.pending', { count: tracker.pending }) : t('progress.idle');
        strip.title = title;
        queueTab.title = `${t('progress.queue')} — ${title}`;
        const total = tracker.queueRemaining;
        queueCount.textContent = total ? String(total) : '';
        queueTab.classList.toggle('running', !!run);
        if (bridge.isStandalone) {
            document.title = run && shown != null ? `[${shown}%] ${baseTitle}` : baseTitle;
        }
    }

    function closeMenu() {
        menu?.remove();
        menu = null;
        menuAnchor = null;
        renderMenu = () => {};
        document.removeEventListener('pointerdown', onOutside, true);
    }
    function onOutside(e) {
        const toggle = menuAnchor === strip || menuAnchor === queueTab ? menuAnchor : null;
        if (menu && !menu.contains(e.target) && !toggle?.contains(e.target)) closeMenu();
    }
    function openMenu(anchor) {
        const root = anchor.closest('.comfy-drawer');
        menuAnchor = anchor;
        menu = document.createElement('div');
        menu.className = 'cd-workflow-menu cd-run-menu';
        const state = { pending: null, recent: null };
        const refreshLists = () => Promise.all([
            fetchJobs(bridge, 'pending'),
            fetchJobs(bridge, 'completed,failed', RECENT_LIMIT),
        ]).then(async ([pending, recent]) => {
            await Promise.all([...pending, ...recent].map(async (job) => {
                job.name = await tracker.workflowName(job.workflow_id);
            }));
            state.pending = pending.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
            state.recent = recent;
            renderMenu();
        }).catch(() => {});

        renderMenu = () => {
            if (!menu) return;
            const body = document.createElement('div');
            body.className = 'cd-wf-body';
            const run = tracker.running;
            if (run) {
                body.appendChild(sectionTitle(t('progress.runningTitle')));
                const pct = tracker.fraction == null ? null : Math.floor(tracker.fraction * 100);
                const node = run.node ? (run.titles[run.node] ?? run.node) : '';
                const step = tracker.stepFraction;
                const steps = run.max ? ` ${run.value}/${run.max} (${Math.floor(step * 100)}%)` : '';
                const item = row('cd-run-current', run.workflowName || t('progress.untitled'),
                    pct == null ? '' : t('progress.overall', { percent: pct }));
                item.appendChild(action(ICONS.stop, t('progress.stop'), () => {
                    bridge.fetchApi('/interrupt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt_id: run.promptId }),
                    }).catch(() => {});
                }));
                body.appendChild(item);
                const nodeLine = document.createElement('div');
                nodeLine.className = 'cd-run-node';
                nodeLine.textContent = `${node}${steps}`;
                const bar = document.createElement('div');
                bar.className = 'cd-run-bar';
                const barFill = document.createElement('span');
                barFill.style.width = `${Math.floor((step ?? tracker.fraction ?? 0) * 100)}%`;
                bar.appendChild(barFill);
                body.append(nodeLine, bar);
            }

            body.appendChild(sectionTitle(t('progress.pendingTitle', { count: tracker.pending })));
            if (state.pending?.length) {
                for (const job of state.pending) {
                    const item = row('cd-run-pending', job.name || t('progress.untitled'), new Date(job.create_time).toLocaleTimeString());
                    item.appendChild(action(ICONS.remove, t('progress.remove'), async () => {
                        await bridge.fetchApi('/queue', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ delete: [job.id] }),
                        }).catch(() => {});
                        refreshLists();
                    }));
                    body.appendChild(item);
                }
            } else {
                const empty = document.createElement('div');
                empty.className = 'cd-wf-empty';
                empty.textContent = state.pending ? t('progress.noPending') : t('common.loading');
                body.appendChild(empty);
            }

            if (state.recent?.length) {
                body.appendChild(sectionTitle(t('progress.recentTitle')));
                for (const job of state.recent) {
                    const failed = job.status === 'failed';
                    const duration = formatDuration(job.execution_end_time - job.execution_start_time);
                    const item = row(`cd-run-recent${failed ? ' failed' : ''}`, job.name || t('progress.untitled'), duration);
                    const thumb = document.createElement('span');
                    thumb.className = 'cd-run-thumb';
                    const preview = job.preview_output;
                    if (failed) thumb.innerHTML = ICONS.failed;
                    else if (preview && (preview.metadata?.kind ?? 'image') === 'image') {
                        const img = document.createElement('img');
                        img.loading = 'lazy';
                        img.alt = '';
                        img.src = previewItem(bridge, preview).src;
                        thumb.appendChild(img);
                    } else thumb.innerHTML = ICONS.file;
                    item.prepend(thumb);
                    item.addEventListener('click', () => {
                        if (failed) {
                            showFailure(bridge, job);
                        } else if (preview) {
                            closeMenu();
                            openLightbox([previewItem(bridge, preview)], 0);
                        }
                    });
                    body.appendChild(item);
                }
            }
            const scroll = menu.querySelector('.cd-wf-body')?.scrollTop ?? 0;
            menu.replaceChildren(body);
            body.scrollTop = scroll;
        };

        renderMenu();
        placeAboveTabBar(menu, anchor, root);
        setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
        refreshLists();
    }

    const onAnchorClick = (anchor) => () => {
        if (menu && menuAnchor === anchor) closeMenu();
        else {
            closeMenu();
            openMenu(anchor);
        }
    };
    strip.addEventListener('click', onAnchorClick(strip));
    strip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); strip.click(); }
    });
    queueTab.addEventListener('click', (e) => {
        e.stopPropagation();
        onAnchorClick(queueTab)();
    });
    shell.addBurgerAction({
        id: 'queue',
        order: -10,
        icon: ICONS.queue,
        label: () => t('progress.queue'),
        tabElement: queueTab,
        action: (anchor) => {
            closeMenu();
            openMenu(anchor);
        },
    });

    bridge.onApiEvent('drawer.progress', (e) => tracker.handle(e.detail ?? {}));
    bridge.onApiEvent('status', (e) => tracker.setQueueRemaining(e.detail?.exec_info?.queue_remaining));
    // Seed from the server: a run may already be going when the page opens.
    Promise.all([fetchJobs(bridge, 'in_progress'), fetchJobs(bridge, 'pending')])
        .then(([running, pending]) => {
            if (running[0] && !tracker.running) tracker.handle({ event: 'execution_start', prompt_id: running[0].id, workflow_id: running[0].workflow_id });
            tracker.setQueueRemaining(running.length + pending.length);
        })
        .catch(() => {});

    return { refresh: render };
}
