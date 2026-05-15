/**
 * ComfyDrawer — ModelViewer Gadget
 * Browse, search, and apply models from ComfyUI's model directories.
 *
 * Layout follows Gallery conventions:
 *   - Bottom-pinned toolbar (order:99) with category select, search trigger, settings
 *   - Search-open mode replaces toolbar content with back + search input
 *   - Breadcrumb (order:98) above toolbar
 *   - Content area fills remaining space
 *
 * Platform services used:
 *   - bridge for graph ops (getNodesByType, invokeWidgetCallback)
 *   - contextMenu for right-click actions
 *   - ContextMenuService.attachTrigger for long-press
 *   - showDialog / showAlert for confirmations and forms
 */
import { GadgetBase } from '../../js/core/gadget-base.js';
import { ContextMenuService } from '../../js/services/context-menu.js';
import { attachSwipeNav } from '../../js/services/swipe-nav.js';
import { escapeHTML, normalizePath } from '../../js/utils.js';
import { createMediaCard } from '../../js/components/media-card.js';
import { isLightboxOpen } from '../../js/services/lightbox.js';
import { enumerateModelValueTargets } from '../../js/utils/widget-targets.js';

/** @private Locale helper */
const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;
const isXyzSweepActive = () => !!window.__xyzSweepActive;

const MV_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;

/** Primary categories shown first in the dropdown */
const PRIMARY_CATEGORIES = [
    'checkpoints', 'loras', 'vae', 'embeddings',
    'diffusion_models', 'text_encoders', 'controlnet', 'upscale_models',
];

/** Category display labels */
const CATEGORY_LABELS = {
    checkpoints: 'Checkpoints',
    loras: 'LoRA',
    vae: 'VAE',
    embeddings: 'Embeddings',
    diffusion_models: 'UNet',
    text_encoders: 'CLIP',
    controlnet: 'ControlNet',
    upscale_models: 'Upscale',
};

/** Placeholder SVG — same icon for all categories */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;

/** Rotate-arrows SVG for CivitAI sync buttons */
const SYNC_BTN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
/** Lucide check-circle SVG for completed states */
const CHECK_BTN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;
/** Lucide circle-x SVG for failed states */
const ERROR_BTN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;
const IMAGE_BTN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>`;
const TRASH_BTN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
const FOLDER_BTN_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
const X_BTN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const CHEVRON_LEFT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
const CHEVRON_RIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

function isEditableTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

function setStatusButtonContent(button, icon, label) {
    button.innerHTML = `${icon}<span></span>`;
    const span = button.querySelector('span');
    span.textContent = String(label).replace(/^[✅❌]\s*/u, '');
    return span;
}

function setIconButtonContent(button, icon, label) {
    button.innerHTML = `${icon}<span></span>`;
    button.querySelector('span').textContent = label;
}

async function readErrorMessage(resp, fallback) {
    try {
        const data = await resp.clone().json();
        if (data?.error) return String(data.error);
        if (data?.message) return String(data.message);
    } catch (_) {
        // Fall through to text/fallback.
    }
    try {
        const text = await resp.text();
        if (text) return text;
    } catch (_) {
        // Fall through to fallback.
    }
    return fallback;
}

const ITEMS_PER_PAGE = 40;

export class ModelViewerGadget extends GadgetBase {
    /* ── State ── */
    #categories = [];
    #activeCategory = '';
    #models = [];
    #filtered = [];
    #page = 0;
    #searchQuery = '';
    #subfolder = '';
    #searchOpen = false;
    #swipeDetach = null;
    #othersExpanded = false;
    #thumbEpoch = Date.now(); // cache-bust epoch for grid thumbnails
    /** @type {Function[]} Cleanup functions scoped to the current grid render */
    #gridCleanups = [];
    /** @type {Set<number>} Deferred-cleanup timer IDs (sync strip, toasts) */
    #deferredTimers = new Set();

    /* ── DOM refs ── */
    #el = {};

    /** @type {ContextMenuService|null} */
    #ctxMenu = null;

    constructor() {
        super('modelviewer', {
            label: 'Models',
            icon: MV_ICON,
            order: 5,
            cssUrl: new URL('./modelviewer.css', import.meta.url).href,
        });
    }

    /* ══════ Lifecycle ══════ */

    onMount(container, bus, bridge) {
        this.#buildDOM();
        this.#bindEvents();
        this.#ctxMenu = window.ComfyDrawer?.contextMenu ?? null;
        this.#registerContextActions();
        this.#attachSwipe();
        this.#loadCategories();

        // Auto-refresh model list when a generation completes
        // (new models may have been downloaded during the session)
        let mvExecTimer = null;
        this.addDisposable(bus.on('comfy:executed', () => {
            clearTimeout(mvExecTimer);
            mvExecTimer = setTimeout(() => {
                if (this.container?.style.display !== 'none' && this.#activeCategory) {
                    this.#loadModels(this.#activeCategory);
                }
            }, 2000);
        }));
        this.addDisposable(() => clearTimeout(mvExecTimer));
    }

    onActivate() {
        if (this.#activeCategory) {
            const savedSub = localStorage.getItem('drawer:mv:lastSubfolder') || '';
            this.#subfolder = savedSub;
            this.#loadModels(this.#activeCategory);
        }
    }

    onDestroy() {
        for (const fn of this.#gridCleanups) fn();
        this.#gridCleanups = [];
        this.#ctxMenu?.unregisterByPrefix('mv:');
        this.#swipeDetach?.();
        // Close any in-flight Server-Sent-Events stream so it doesn't keep
        // running after the gadget is gone. The handlers reference `this.#el`
        // and would NPE without this.
        if (this.#syncEventSource) {
            try { this.#syncEventSource.close(); } catch { /* ignore */ }
            this.#syncEventSource = null;
        }
        // Clear any pending UI-cleanup timers (sync strip hide, toasts)
        for (const id of this.#deferredTimers) clearTimeout(id);
        this.#deferredTimers.clear();
    }

    /** Schedule a timer whose only job is UI cleanup, tracked for onDestroy. */
    #scheduleCleanupTimer(fn, delayMs) {
        const id = setTimeout(() => {
            this.#deferredTimers.delete(id);
            try { fn(); } catch (e) { console.warn('[ComfyDrawer:modelviewer] cleanup timer failed:', e); }
        }, delayMs);
        this.#deferredTimers.add(id);
        return id;
    }

    /* ══════ DOM ══════ */

    #buildDOM() {
        this.container.innerHTML = `
            <div class="mv-toolbar">
                <!-- ── Browse toolbar (bottom-pinned) ── -->
                <div class="mv-toolbar-browse">
                    <button class="mv-search-back" title="${_t('modelviewer.searchClose')}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
                        </svg>
                    </button>
                    <div class="mv-search-box">
                        <input type="search" class="mv-search-input" placeholder="${_t('modelviewer.searchPlaceholder')}"
                               enterkeyhint="search" autocomplete="off" spellcheck="false"/>
                        <span class="mv-result-count"></span>
                        <button class="mv-clear-btn" hidden>${X_BTN_SVG}</button>
                    </div>

                    <span class="mv-item-count" hidden></span>
                    <span class="mv-page-info" hidden>
                        <button class="mv-page-btn mv-prev" disabled>${CHEVRON_LEFT_SVG}</button>
                        <span class="mv-page-text"></span>
                        <button class="mv-page-btn mv-next" disabled>${CHEVRON_RIGHT_SVG}</button>
                    </span>
                    <button class="mv-sync-btn" title="CivitAI Batch Sync">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                        <span>CivitAI Sync</span>
                    </button>
                    <button class="mv-search-trigger" title="${_t('modelviewer.searchTrigger')}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                        </svg>
                    </button>
                </div>
            </div>

            <nav class="mv-breadcrumb hidden"></nav>

            <div class="mv-sync-strip">
                <span class="mv-sync-label"></span>
                <div class="mv-sync-bar-outer"><div class="mv-sync-bar-inner"></div></div>
                <span class="mv-sync-count"></span>
            </div>

            <div class="mv-content">
                <div class="mv-grid"></div>
                <div class="mv-status"></div>
            </div>
        `;

        const q = (s) => this.container.querySelector(s);
        this.#el = {
            toolbarBrowse: q('.mv-toolbar-browse'),
            // Search
            searchBack: q('.mv-search-back'),
            searchBox: q('.mv-search-box'),
            searchInput: q('.mv-search-input'),
            resultCount: q('.mv-result-count'),
            clearBtn: q('.mv-clear-btn'),
            searchTrigger: q('.mv-search-trigger'),
            // Pagination
            pageInfo: q('.mv-page-info'),
            pageText: q('.mv-page-text'),
            itemCount: q('.mv-item-count'),
            prev: q('.mv-prev'),
            next: q('.mv-next'),
            // Sync
            syncBtn: q('.mv-sync-btn'),
            syncStrip: q('.mv-sync-strip'),
            syncLabel: q('.mv-sync-label'),
            syncBarInner: q('.mv-sync-bar-inner'),
            syncCount: q('.mv-sync-count'),
            // Shared
            breadcrumb: q('.mv-breadcrumb'),
            content: q('.mv-content'),
            grid: q('.mv-grid'),
            status: q('.mv-status'),
        };
    }

    #bindEvents() {
        const el = this.#el;

        // ── Search trigger (opens search mode) ──
        el.searchTrigger.addEventListener('click', () => this.#openSearch());

        // ── Search back (closes search mode) ──
        el.searchBack.addEventListener('click', () => this.#closeSearch());

        // ── Search input ──
        el.searchInput.addEventListener('input', () => {
            this.#searchQuery = el.searchInput.value.trim().toLowerCase();
            el.clearBtn.hidden = !this.#searchQuery;
            if (!this.#searchQuery) {
                el.resultCount.textContent = '';
            }
            this.#page = 0;
            this.#applyFilter();
            this.#renderGrid();
            // Show hit count
            if (this.#searchQuery) {
                el.resultCount.textContent = _t('common.itemsShort', { count: this.#filtered.length });
            }
        });

        el.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this.#closeSearch();
            }
        });

        // ── Clear button ──
        el.clearBtn.addEventListener('click', () => {
            el.searchInput.value = '';
            el.searchInput.dispatchEvent(new Event('input'));
            el.searchInput.focus();
        });


        // ── Pagination ──
        el.prev.addEventListener('click', () => { this.#page--; this.#renderGrid(); });
        el.next.addEventListener('click', () => { this.#page++; this.#renderGrid(); });

        el.syncBtn.addEventListener('click', () => this.#batchCivitaiSync());

        // ── Background context menu (right-click on empty grid area) ──
        el.grid.addEventListener('contextmenu', (e) => {
            // Only trigger if the click target is the grid itself (empty area)
            if (e.target === el.grid) {
                e.preventDefault();
                this.#ctxMenu?.show('mv-bg', {}, e.clientX, e.clientY);
            }
        });

        const onNavKey = (e) => this.#handleHierarchyKey(e);
        document.addEventListener('keydown', onNavKey, { capture: true });
        this.addDisposable(() => document.removeEventListener('keydown', onNavKey, { capture: true }));
    }

    /* ══════ Search Mode ══════ */

    #openSearch() {
        this.#searchOpen = true;
        this.#el.toolbarBrowse.classList.add('search-open');
        if (this.#el.itemCount) this.#el.itemCount.hidden = true;
        this.#el.searchInput.focus();
    }

    #closeSearch() {
        this.#searchOpen = false;
        this.#el.toolbarBrowse.classList.remove('search-open');
        if (this.#searchQuery) {
            this.#el.searchInput.value = '';
            this.#searchQuery = '';
            this.#el.resultCount.textContent = '';
            this.#el.clearBtn.hidden = true;
            this.#page = 0;
            this.#applyFilter();
            this.#renderGrid();
        } else {
            this.#renderGrid();
        }
    }

    /* ══════ Data Loading ══════ */

    /** Categories that are internal / not user-facing model types */
    static #HIDDEN_CATEGORIES = new Set([
        'custom_nodes', 'configs',
    ]);

    async #loadCategories() {
        this.#setStatus(_t('modelviewer.loadingCategories'));
        try {
            const resp = await this.bridge.fetchApi('/models');
            if (!resp.ok) throw new Error(resp.statusText);
            const allCategories = await resp.json();

            // Filter out internal categories
            const candidates = allCategories.filter(
                c => !ModelViewerGadget.#HIDDEN_CATEGORIES.has(c)
            );

            // Parallel-fetch model counts to filter out empty categories
            const counts = await Promise.all(
                candidates.map(async (cat) => {
                    try {
                        const r = await this.bridge.fetchApi(`/models/${encodeURIComponent(cat)}`);
                        if (!r.ok) return { cat, count: 0 };
                        const list = await r.json();
                        return { cat, count: Array.isArray(list) ? list.length : 0 };
                    } catch {
                        return { cat, count: 0 };
                    }
                })
            );

            this.#categories = counts
                .filter(({ count }) => count > 0)
                .map(({ cat }) => cat);

            // Restore last category + subfolder from localStorage
            const savedCat = localStorage.getItem('drawer:mv:lastCategory');
            const savedSub = localStorage.getItem('drawer:mv:lastSubfolder') || '';
            const first = (savedCat && this.#categories.includes(savedCat))
                ? savedCat
                : (PRIMARY_CATEGORIES.find(c => this.#categories.includes(c))
                    || this.#categories[0]);
            if (first) {
                // Pre-set subfolder before loading so it's applied after model fetch
                this.#subfolder = (savedCat === first) ? savedSub : '';
                this.#selectCategory(first, true);
            } else {
                this.#setStatus(_t('modelviewer.noCategoriesFound'));
            }
        } catch (e) {
            this.#setStatus(_t('common.error') + ': ' + e.message);
        }
    }

    /** Persist subfolder to localStorage and update state */
    #setSubfolder(val) {
        this.#subfolder = val;
        localStorage.setItem('drawer:mv:lastSubfolder', val);
    }

    async #loadModels(category) {
        this.#setStatus(_t('modelviewer.loadingModels'));
        this.#el.grid.innerHTML = '';
        this.#thumbEpoch = Date.now();
        try {
            let allModels = [];
            try {
                const pathResp = await this.bridge.fetchApi(`/drawer/models/paths/${encodeURIComponent(category)}`);
                if (pathResp.ok) {
                    const groups = await pathResp.json();
                    allModels = groups.flatMap(g => (g.models || []).map(m => normalizePath(m)));
                }
            } catch { /* ignore, fall through */ }

            // Fallback to standard API if Drawer API unavailable
            if (allModels.length === 0) {
                const resp = await this.bridge.fetchApi(`/models/${encodeURIComponent(category)}`);
                if (!resp.ok) throw new Error(resp.statusText);
                const models = await resp.json();
                allModels = models.map(m => normalizePath(m));
            }

            this.#models = allModels
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            // Only reset subfolder if not pre-set (e.g. by restore)
            if (!this.#subfolder) this.#setSubfolder('');
            this.#page = 0;
            this.#applyFilter();
            this.#renderGrid();
        } catch (e) {
            this.#setStatus(_t('common.error') + ': ' + e.message);
        }
    }

    /* ══════ Category / Breadcrumb Navigation ══════ */

    /**
     * @param {string} cat
     * @param {boolean} [preserveSubfolder=false] - true when restoring saved position
     */
    #selectCategory(cat, preserveSubfolder = false) {
        this.#activeCategory = cat;
        localStorage.setItem('drawer:mv:lastCategory', cat);
        if (!preserveSubfolder) this.#setSubfolder('');

        // Close search when switching category
        if (this.#searchOpen) {
            this.#searchOpen = false;
            this.#el.toolbarBrowse.classList.remove('search-open');
            this.#el.searchInput.value = '';
            this.#searchQuery = '';
            this.#el.resultCount.textContent = '';
            this.#el.clearBtn.hidden = true;
        }

        this.#loadModels(cat);
    }

    /* ══════ Filtering & Subfolders ══════ */

    #applyFilter() {
        let list = this.#models;

        if (this.#subfolder) {
            const prefix = this.#subfolder + (this.#subfolder.endsWith('/') ? '' : '/');
            list = list.filter(m => m.startsWith(prefix));
        }

        if (this.#searchQuery) {
            const q = this.#searchQuery;
            // In search mode: search all models, ignore subfolder
            list = this.#models.filter(m => m.toLowerCase().includes(q));
        }

        this.#filtered = list;
    }

    #buildView() {
        const prefix = this.#subfolder ? this.#subfolder + '/' : '';
        const folders = new Map();
        const files = [];

        for (const model of this.#filtered) {
            if (this.#searchQuery) {
                files.push(model);
                continue;
            }

            if (prefix && !model.startsWith(prefix)) continue;
            const rel = prefix ? model.slice(prefix.length) : model;

            const slashIdx = rel.indexOf('/');
            if (slashIdx === -1) {
                files.push(model);
            } else {
                const folderName = rel.slice(0, slashIdx);
                folders.set(folderName, (folders.get(folderName) || 0) + 1);
            }
        }

        const folderList = Array.from(folders.entries())
            .map(([name, count]) => ({ name, path: prefix + name, count }))
            .sort((a, b) => a.name.localeCompare(b.name));

        return { folders: folderList, files };
    }

    /* ══════ Rendering ══════ */

    #renderBreadcrumb() {
        const el = this.#el.breadcrumb;
        el.innerHTML = '';

        // Always show breadcrumb (search mode hides via CSS)
        if (this.#searchQuery) {
            el.classList.add('hidden');
            return;
        }
        el.classList.remove('hidden');

        const catLabel = CATEGORY_LABELS[this.#activeCategory] || this.#activeCategory;

        // Root crumb (category name) — click/right-click → category dropdown
        const rootBtn = document.createElement('button');
        rootBtn.className = 'mv-crumb' + (!this.#subfolder ? ' current' : '');
        rootBtn.textContent = catLabel;

        if (!this.#subfolder) {
            // At root: click → category dropdown
            rootBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.#showCategoryDropdown(rootBtn);
            });
        } else {
            // In subfolder: click → navigate to root
            rootBtn.addEventListener('click', () => {
                this.#setSubfolder('');
                this.#page = 0;
                this.#applyFilter();
                this.#renderGrid();
            });
        }
        // Right-click always shows category dropdown
        rootBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.#showCategoryDropdown(rootBtn);
        });
        el.appendChild(rootBtn);

        if (this.#subfolder) {
            const parts = this.#subfolder.split('/');
            let accumulated = '';
            for (let i = 0; i < parts.length; i++) {
                const sep = document.createElement('span');
                sep.className = 'mv-crumb-sep';
                sep.textContent = '›';
                el.appendChild(sep);

                accumulated += (accumulated ? '/' : '') + parts[i];
                const crumb = document.createElement('button');
                crumb.className = 'mv-crumb' + (i === parts.length - 1 ? ' current' : '');
                crumb.textContent = parts[i];
                const targetPath = accumulated;

                if (i === parts.length - 1) {
                    // Current level: click → sibling dropdown
                    crumb.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.#showSiblingDropdown(crumb, targetPath);
                    });
                } else {
                    // Upper levels: click → navigate
                    crumb.addEventListener('click', () => {
                        this.#setSubfolder(targetPath);
                        this.#page = 0;
                        this.#applyFilter();
                        this.#renderGrid();
                    });
                }
                // All levels: right-click → sibling dropdown
                crumb.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.#showSiblingDropdown(crumb, targetPath);
                });
                el.appendChild(crumb);
            }
        }
    }

    /** Show category dropdown anchored to a breadcrumb button */
    #showCategoryDropdown(anchorEl) {
        const primaries = PRIMARY_CATEGORIES.filter(c => this.#categories.includes(c));
        const others = this.#categories.filter(c => !PRIMARY_CATEGORIES.includes(c)).sort();

        const items = primaries.map(c => ({
            name: CATEGORY_LABELS[c] || c, _key: c,
        }));

        if (others.length > 0) {
            if (this.#othersExpanded) {
                items.push({ name: '──────────', _separator: true });
                for (const c of others) {
                    items.push({ name: CATEGORY_LABELS[c] || c, _key: c });
                }
                items.push({ name: _t('modelviewer.fold'), _fold: true });
            } else {
                items.push({ name: `Other (${others.length})`, _expand: true });
            }
        }

        const currentLabel = CATEGORY_LABELS[this.#activeCategory] || this.#activeCategory;
        this.#buildDropdown(anchorEl, items, currentLabel, (item) => {
            if (item._expand) {
                this.#othersExpanded = true;
                this.#showCategoryDropdown(anchorEl);
            } else if (item._fold) {
                this.#othersExpanded = false;
                this.#showCategoryDropdown(anchorEl);
            } else if (item._key) {
                this.#selectCategory(item._key);
            }
        });
    }

    /** Show sibling folder dropdown at a specific subfolder path */
    #showSiblingDropdown(anchorEl, path) {
        // Get parent prefix
        const lastSlash = path.lastIndexOf('/');
        const parentPrefix = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
        const currentName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

        // Find sibling folders from model list
        const siblingSet = new Set();
        for (const model of this.#models) {
            if (parentPrefix && !model.startsWith(parentPrefix)) continue;
            const rel = parentPrefix ? model.slice(parentPrefix.length) : model;
            const slashIdx = rel.indexOf('/');
            if (slashIdx >= 0) siblingSet.add(rel.slice(0, slashIdx));
        }

        const siblings = Array.from(siblingSet).sort();
        if (siblings.length === 0) return;

        const items = siblings.map(name => ({ name, path: parentPrefix + name }));
        this.#buildDropdown(anchorEl, items, currentName, (item) => {
            this.#setSubfolder(item.path);
            this.#page = 0;
            this.#applyFilter();
            this.#renderGrid();
        });
    }

    /** Build and display a positioned dropdown list (Gallery pattern) */
    #buildDropdown(anchorEl, items, currentName, onSelect) {
        // Remove existing
        document.querySelector('.mv-crumb-dropdown')?.remove();

        const dropdown = document.createElement('div');
        dropdown.className = 'mv-crumb-dropdown';
        Object.assign(dropdown.style, {
            position: 'fixed', zIndex: '10000',
        });

        for (const entry of items) {
            if (entry._separator) {
                const sep = document.createElement('div');
                sep.className = 'mv-crumb-dropdown-sep';
                dropdown.appendChild(sep);
                continue;
            }

            const isCurrent = entry.name === currentName;
            const btn = document.createElement('button');
            btn.className = 'mv-crumb-dropdown-item'
                + (isCurrent ? ' current' : '')
                + (entry._expand || entry._fold ? ' muted' : '');
            btn.textContent = entry.name;
            btn.addEventListener('click', () => {
                if (!entry._expand && !entry._fold) {
                    dropdown.remove();
                    removeClose();
                }
                onSelect(entry);
            });
            if (isCurrent) btn.dataset.current = '1';
            dropdown.appendChild(btn);
        }

        // Position
        dropdown.style.visibility = 'hidden';
        document.body.appendChild(dropdown);

        const rect = anchorEl.getBoundingClientRect();
        const containerH = this.container?.offsetHeight || window.innerHeight;
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const maxH = Math.min(containerH * 0.5, Math.max(spaceAbove, spaceBelow) - 8);
        dropdown.style.maxHeight = maxH + 'px';

        const ddH = Math.min(dropdown.scrollHeight, maxH);
        let top = spaceAbove >= ddH || spaceAbove > spaceBelow
            ? rect.top - ddH - 4
            : rect.bottom + 4;
        dropdown.style.top = Math.max(4, top) + 'px';

        const ddW = dropdown.offsetWidth;
        let left = rect.left;
        if (left + ddW > window.innerWidth - 8) left = window.innerWidth - ddW - 8;
        dropdown.style.left = Math.max(4, left) + 'px';
        dropdown.style.visibility = 'visible';

        const cur = dropdown.querySelector('[data-current]');
        if (cur) cur.scrollIntoView({ block: 'center' });

        // Close on click outside
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== anchorEl) {
                dropdown.remove();
                removeClose();
            }
        };
        const removeClose = () => {
            document.removeEventListener('pointerdown', closeHandler, true);
        };
        setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
    }

    #renderGrid() {
        for (const fn of this.#gridCleanups) fn();
        this.#gridCleanups = [];

        const { folders, files } = this.#buildView();
        const grid = this.#el.grid;
        grid.innerHTML = '';

        this.#renderBreadcrumb();

        if (folders.length === 0 && files.length === 0) {
            if (this.#searchQuery) {
                this.#setStatus(_t('modelviewer.noSearchResults', { query: escapeHTML(this.#searchQuery) }));
            } else {
                this.#setStatus(_t('modelviewer.noModelsFound'));
            }
            this.#updatePagination(0, 0);
            return;
        }

        this.#el.status.textContent = '';

        const frag = document.createDocumentFragment();

        // Folder cards
        for (const folder of folders) {
            const card = document.createElement('div');
            card.className = 'mv-folder-card';
            card.innerHTML = `
                <div class="mv-folder-icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg></div>
                <div class="mv-folder-name">${escapeHTML(folder.name)}</div>
                <div class="mv-folder-count">${_t('common.itemsShort', { count: folder.count })}</div>
            `;
            card.addEventListener('click', () => {
                this.#setSubfolder(folder.path);
                this.#page = 0;
                this.#applyFilter();
                this.#renderGrid();
            });
            // Folder context menu
            const folderCtx = ContextMenuService.attachTrigger(card, (e) => {
                this.#ctxMenu?.show('mv-folder', {
                    folderPath: folder.path,
                    folderName: folder.name,
                    category: this.#activeCategory,
                }, e.clientX, e.clientY);
            });
            this.#gridCleanups.push(folderCtx);
            frag.appendChild(card);
        }

        // Paginate files
        const totalFiles = files.length;
        const totalPages = Math.ceil(totalFiles / ITEMS_PER_PAGE);
        const pageFiles = files.slice(
            this.#page * ITEMS_PER_PAGE,
            (this.#page + 1) * ITEMS_PER_PAGE,
        );

        for (const model of pageFiles) {
            frag.appendChild(this.#createModelCard(model));
        }

        grid.appendChild(frag);
        this.#updatePagination(totalFiles, totalPages, folders.length);
        this.#el.content.scrollTop = 0;
    }

    #updatePagination(total, totalPages, folderCount = 0) {
        const info = this.#el.pageInfo;
        const itemCount = this.#el.itemCount;
        const totalItems = Number(folderCount || 0) + Number(total || 0);
        if (itemCount) {
            itemCount.textContent = _t('gallery.folderItemCount', { count: totalItems.toLocaleString() });
            itemCount.hidden = totalItems <= 0 || this.#searchOpen;
        }
        if (totalPages > 1) {
            info.hidden = false;
            this.#el.prev.disabled = this.#page <= 0;
            this.#el.next.disabled = this.#page >= totalPages - 1;
            this.#el.pageText.textContent = `${this.#page + 1}/${totalPages}`;
        } else {
            info.hidden = true;
        }
    }

    #createModelCard(modelPath) {
        const filename = modelPath.includes('/') ? modelPath.split('/').pop()
            : modelPath.includes('\\') ? modelPath.split('\\').pop()
                : modelPath;
        const displayName = filename.replace(/\.(safetensors|ckpt|pt|bin|pth|sft|gguf)$/i, '');

        const thumbSrc = this.bridge.apiURL(`/drawer/model-thumb/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}&t=${this.#thumbEpoch}`);

        // Use shared MediaCard component
        const mc = createMediaCard({
            src: thumbSrc,
            filename,
            lightbox: false,
            draggable: false,
            lazy: true,
            thumbHeight: null,   // use CSS aspect-ratio instead
            onClick: () => this.#showModelInfo(modelPath),
        });

        const card = mc.element;
        card.classList.add('mv-card');

        // Thumbnail: aspect-ratio + placeholder icon (shown until image loads)
        const thumbWrap = mc.thumb.parentElement;
        thumbWrap.classList.add('mv-card-thumb');

        const placeholder = document.createElement('span');
        placeholder.className = 'mv-placeholder';
        placeholder.innerHTML = PLACEHOLDER_SVG;
        thumbWrap.prepend(placeholder);

        mc.thumb.addEventListener('load', () => placeholder.remove(), { once: true });
        mc.thumb.addEventListener('error', () => {
            // Image failed — may be a video preview (.mp4 / .webm).
            // Try loading as <video> instead.
            const video = document.createElement('video');
            video.className = 'mc-thumb mv-thumb-video';
            video.src = thumbSrc;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.addEventListener('loadeddata', () => {
                placeholder.remove();
                video.style.display = '';
            }, { once: true });
            video.addEventListener('error', () => {
                // Neither image nor video — keep placeholder
                video.style.display = 'none';
            }, { once: true });
            video.style.display = 'none';
            mc.thumb.style.display = 'none';
            thumbWrap.appendChild(video);
            // Hover-to-play
            card.addEventListener('mouseenter', () => video.play?.());
            card.addEventListener('mouseleave', () => { video.pause?.(); video.currentTime = 0; });
        }, { once: true });

        // Extension badge on thumbnail
        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        const EXT_SHORT = { safetensors: 'ST', ckpt: 'CKPT', pt: 'PT', bin: 'BIN', pth: 'PTH', sft: 'SFT', gguf: 'GGUF' };
        const extShort = EXT_SHORT[ext] || ext.toUpperCase();
        if (extShort) {
            const extBadge = document.createElement('span');
            extBadge.className = 'mv-ext-badge';
            extBadge.textContent = extShort;
            thumbWrap.appendChild(extBadge);
        }

        // Info slot — ModelViewer-specific content
        let infoHtml = `<div class="mv-card-name" title="${escapeHTML(modelPath)}">`;
        if (this.#searchQuery) {
            infoHtml += this.#highlightMatch(displayName, this.#searchQuery);
        } else {
            infoHtml += escapeHTML(displayName);
        }
        infoHtml += '</div>';
        mc.info.innerHTML = infoHtml;

        // Context menu
        const ctxCleanup = ContextMenuService.attachTrigger(card, (e) => {
            this.#ctxMenu?.show('model-item', {
                filename: modelPath,
                displayName,
                category: this.#activeCategory,
            }, e.clientX, e.clientY);
        });
        this.#gridCleanups.push(ctxCleanup);

        return card;
    }

    /* ══════ Context Menu ══════ */

    #registerContextActions() {
        this.#ctxMenu?.register('model-item', [
            {
                id: 'mv:info',
                label: _t('modelviewer.modelInfo'),
                icon: 'info',
                order: 10,
                action: (ctx) => this.#showModelInfo(ctx.filename),
            },
            {
                id: 'mv:copy-name',
                label: _t('modelviewer.copyName'),
                icon: 'copy',
                order: 20,
                action: (ctx) => {
                    navigator.clipboard?.writeText(ctx.filename).catch(() => { });
                },
            },
            {
                id: 'mv:delete',
                label: _t('common.delete'),
                icon: 'trash',
                order: 100,
                danger: true,
                action: (ctx) => this.#deleteModel(ctx.filename, ctx.displayName),
            },
        ]);

        // Folder context menu
        this.#ctxMenu?.register('mv-folder', [
            {
                id: 'mv:folder-mkdir',
                label: _t('modelviewer.newFolder'),
                icon: 'folder-plus',
                order: 10,
                action: (ctx) => this.#createModelFolder(ctx.folderPath),
            },
        ]);

        // Background context menu (empty area)
        this.#ctxMenu?.register('mv-bg', [
            {
                id: 'mv:bg-mkdir',
                label: _t('modelviewer.newFolder'),
                icon: 'folder-plus',
                order: 10,
                action: () => this.#createModelFolder(this.#subfolder),
            },
        ]);
    }

    /* ══════ CivitAI Batch Sync ══════ */

    /** @type {EventSource|null} */
    #syncEventSource = null;

    #showSyncCompleteStrip(synced, failed) {
        const el = this.#el;
        el.syncStrip.classList.add('active');
        el.syncBarInner.style.width = '100%';
        el.syncBarInner.classList.add('done');
        el.syncLabel.textContent = _t('modelviewer.civitaiBatchComplete', { synced, failed });
        el.syncCount.textContent = '';
        this.#scheduleCleanupTimer(() => {
            // Guard against destroy mid-timer
            if (this.#el && this.#el.syncStrip) {
                this.#el.syncStrip.classList.remove('active');
            }
        }, 5000);
    }

    async #batchCivitaiSync() {
        // Prevent double-run
        if (this.#syncEventSource) return;

        // Warn when syncing many models (slow + many API requests)
        if (this.#models.length > 2) {
            const msg = _t('modelviewer.civitaiBatchWarn', { count: this.#models.length });
            const showConfirm = window.ComfyDrawer?.showConfirm;
            const ok = showConfirm ? await showConfirm(msg) : false;
            if (!ok) return;
        }

        const el = this.#el;
        el.syncBtn.classList.add('syncing');
        el.syncBtn.disabled = true;
        el.syncStrip.classList.add('active');
        el.syncLabel.textContent = _t('modelviewer.connecting');
        el.syncBarInner.style.width = '0%';
        el.syncBarInner.classList.remove('done');
        el.syncCount.textContent = '';

        const url = this.bridge.apiURL(`/drawer/civitai-batch-sync/${encodeURIComponent(this.#activeCategory)}`);
        const es = new EventSource(url);
        this.#syncEventSource = es;

        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);

                if (data.type === 'start') {
                    if (data.total === 0) {
                        el.syncLabel.textContent = _t('modelviewer.allSynced', { count: data.skipped });
                        el.syncBarInner.style.width = '100%';
                        el.syncBarInner.classList.add('done');
                        el.syncCount.textContent = '';
                    } else {
                        el.syncLabel.textContent = `0 / ${data.total}`;
                        el.syncCount.textContent = data.skipped ? _t('modelviewer.skippedCount', { count: data.skipped }) : '';
                    }
                }

                if (data.type === 'progress') {
                    const pct = ((data.index + 1) / data.total * 100).toFixed(0);
                    el.syncBarInner.style.width = pct + '%';
                    el.syncLabel.textContent = data.filename;
                    el.syncCount.textContent = `${data.index + 1}/${data.total}`;
                }

                if (data.type === 'complete') {
                    es.close();
                    this.#syncEventSource = null;
                    el.syncBtn.classList.remove('syncing');
                    el.syncBtn.disabled = false;

                    // Refresh grid
                    this.#thumbEpoch = Date.now();
                    this.#loadModels(this.#activeCategory);

                    this.#showSyncCompleteStrip(data.synced, data.failed);
                }
            } catch { /* ignore parse errors */ }
        };

        es.onerror = () => {
            el.syncLabel.textContent = _t('modelviewer.connectionLost');
            el.syncBarInner.classList.add('done');
            es.close();
            this.#syncEventSource = null;
            el.syncBtn.classList.remove('syncing');
            el.syncBtn.disabled = false;
            this.#scheduleCleanupTimer(() => {
                if (this.#el && this.#el.syncStrip) {
                    this.#el.syncStrip.classList.remove('active');
                }
            }, 3000);
        };
    }

    /* ══════ Model Info Card ══════ */

    async #showModelInfo(modelPath) {
        const showDialog = window.ComfyDrawer?.showDialog;
        if (!showDialog) return;

        const filename = modelPath.includes('/') ? modelPath.split('/').pop()
            : modelPath.includes('\\') ? modelPath.split('\\').pop()
                : modelPath;
        const displayName = filename.replace(/\.(safetensors|ckpt|pt|bin|pth|sft|gguf)$/i, '');

        const thumbSrc = this.bridge.apiURL(`/drawer/model-thumb/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}&t=${Date.now()}`);

        // Build info card DOM
        const card = document.createElement('div');
        card.className = 'mv-info-card';
        // Suppress browser context menu on the card chrome, but keep text inputs native.
        card.addEventListener('contextmenu', (e) => {
            if (!isEditableTarget(e.target)) e.preventDefault();
        });

        // Preview image with management overlay
        const previewWrap = document.createElement('div');
        previewWrap.className = 'mv-info-preview-wrap';

        // Preview media — reference kept for overlay actions
        let previewMedia = null;

        const img = document.createElement('img');
        img.className = 'mv-info-preview';
        img.src = thumbSrc;
        img.alt = displayName;
        previewMedia = img;

        const placeholder = document.createElement('div');
        placeholder.className = 'mv-info-placeholder';
        placeholder.innerHTML = PLACEHOLDER_SVG;
        placeholder.style.display = 'none';

        img.addEventListener('error', () => {
            // Image failed — try as video
            const video = document.createElement('video');
            video.className = 'mv-info-preview';
            video.src = thumbSrc;
            video.autoplay = true;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.controls = true;
            video.addEventListener('loadeddata', () => {
                video.style.display = '';
                previewMedia = video;
            }, { once: true });
            video.addEventListener('error', () => {
                video.style.display = 'none';
                placeholder.style.display = '';
            }, { once: true });
            video.style.display = 'none';
            img.style.display = 'none';
            previewWrap.insertBefore(video, img.nextSibling);
        }, { once: true });

        // Action overlay
        const overlay = document.createElement('div');
        overlay.className = 'mv-info-preview-overlay';

        const changeBtn = document.createElement('button');
        changeBtn.className = 'mv-info-preview-action';
        setIconButtonContent(changeBtn, IMAGE_BTN_SVG, _t('modelviewer.changeThumbnail'));
        changeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const openPicker = window.ComfyDrawer?.openImagePicker;
            if (!openPicker) return;
            const selected = await openPicker({
                root: 'output',
                accept: 'image',
            });
            if (!selected) return;
            try {
                const resp = await this.bridge.fetchApi(`/drawer/model-preview-from-output/${encodeURIComponent(this.#activeCategory)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: modelPath, image: selected }),
                });
                const result = await resp.clone().json().catch(() => ({}));
                if (!resp.ok || !result.ok) {
                    const message = result?.error || result?.message || await readErrorMessage(resp, resp.statusText || _t('modelviewer.thumbnailUpdateFailed'));
                    await window.ComfyDrawer?.showAlert?.(message, {
                        title: _t('modelviewer.thumbnailUpdateFailed'),
                        variant: 'danger',
                    });
                    return;
                }
                // Remove any existing video fallback
                previewWrap.querySelectorAll('video.mv-info-preview').forEach(v => v.remove());
                // Reset to image with fresh handlers
                img.style.display = '';
                img.addEventListener('load', () => {
                    placeholder.style.display = 'none';
                    overlay.style.display = '';
                }, { once: true });
                img.addEventListener('error', () => {
                    img.style.display = 'none';
                    placeholder.style.display = '';
                }, { once: true });
                const bustSrc = thumbSrc + '&t=' + Date.now();
                img.src = bustSrc;
                previewMedia = img;
                this.#refreshGridThumb(modelPath);
            } catch (err) {
                console.warn('[ModelViewer] Thumbnail update failed:', err);
                await window.ComfyDrawer?.showAlert?.(err?.message || String(err), {
                    title: _t('modelviewer.thumbnailUpdateFailed'),
                    variant: 'danger',
                });
            }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'mv-info-preview-action delete';
        setIconButtonContent(deleteBtn, TRASH_BTN_SVG, _t('modelviewer.deleteThumbnail'));
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const resp = await this.bridge.fetchApi(
                    `/drawer/model-preview/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}`,
                    { method: 'DELETE' },
                );
                const result = await resp.clone().json().catch(() => ({}));
                if (!resp.ok || !result.ok) {
                    const message = result?.error || result?.message || await readErrorMessage(resp, resp.statusText || _t('modelviewer.thumbnailDeleteFailed'));
                    await window.ComfyDrawer?.showAlert?.(message, {
                        title: _t('modelviewer.thumbnailDeleteFailed'),
                        variant: 'danger',
                    });
                    return;
                }
                img.style.display = 'none';
                previewWrap.querySelectorAll('video.mv-info-preview').forEach(v => v.remove());
                previewMedia = img;
                placeholder.style.display = '';
                overlay.style.display = 'none';
                this.#refreshGridThumb(modelPath);
            } catch (err) {
                console.warn('[ModelViewer] Thumbnail delete failed:', err);
                await window.ComfyDrawer?.showAlert?.(err?.message || String(err), {
                    title: _t('modelviewer.thumbnailDeleteFailed'),
                    variant: 'danger',
                });
            }
        });

        overlay.appendChild(changeBtn);
        overlay.appendChild(deleteBtn);
        previewWrap.appendChild(img);
        previewWrap.appendChild(placeholder);
        previewWrap.appendChild(overlay);
        card.appendChild(previewWrap);

        // Model name
        const nameEl = document.createElement('div');
        nameEl.className = 'mv-info-name';
        nameEl.textContent = displayName;
        card.appendChild(nameEl);

        // Trigger words section (LoRA only)
        const isLora = this.#activeCategory === 'loras';
        let triggersWrap = null;
        let addTriggerBtn = null;
        if (isLora) {
            const triggersTitle = document.createElement('div');
            triggersTitle.className = 'mv-info-section-title';
            triggersTitle.style.display = 'flex';
            triggersTitle.style.alignItems = 'center';
            triggersTitle.style.justifyContent = 'space-between';

            const triggersTitleText = document.createElement('span');
            triggersTitleText.textContent = _t('modelviewer.triggerWords');
            triggersTitle.appendChild(triggersTitleText);

            addTriggerBtn = document.createElement('button');
            addTriggerBtn.className = 'mv-info-trigger-add';
            addTriggerBtn.textContent = '+';
            addTriggerBtn.title = _t('modelviewer.addTriggerWord');
            triggersTitle.appendChild(addTriggerBtn);
            card.appendChild(triggersTitle);

            triggersWrap = document.createElement('div');
            triggersWrap.className = 'mv-info-triggers';
            card.appendChild(triggersWrap);
        }

        // Node targets section (not applicable for embeddings)
        const isEmbedding = this.#activeCategory === 'embeddings';
        let targetsWrap = null;
        let applyBtn = null;

        if (isEmbedding) {
            // Embeddings: show activation string as a copyable chip (no section title)
            const embChipsWrap = document.createElement('div');
            embChipsWrap.className = 'mv-info-triggers';

            const embeddingStr = `embedding:${displayName}`;
            const chip = document.createElement('span');
            chip.className = 'mv-info-trigger';
            chip.title = _t('common.clickToCopy');
            const text = document.createElement('span');
            text.textContent = embeddingStr;
            chip.appendChild(text);
            chip.addEventListener('click', () => {
                navigator.clipboard.writeText(embeddingStr).then(() => {
                    text.textContent = '✓ ' + embeddingStr;
                    chip.classList.add('copied');
                    setTimeout(() => {
                        chip.classList.remove('copied');
                        text.textContent = embeddingStr;
                    }, 1200);
                });
            });
            embChipsWrap.appendChild(chip);
            card.appendChild(embChipsWrap);
        } else {
            const sectionTitle = document.createElement('div');
            sectionTitle.className = 'mv-info-section-title';
            sectionTitle.textContent = _t('modelviewer.targetNodes');
            card.appendChild(sectionTitle);

            targetsWrap = document.createElement('div');
            targetsWrap.className = 'mv-info-targets';
            card.appendChild(targetsWrap);

            applyBtn = document.createElement('button');
            applyBtn.className = 'mv-info-apply-btn';
            applyBtn.textContent = _t('modelviewer.applyToNodes');
            applyBtn.disabled = true;
            card.appendChild(applyBtn);
        }

        // User comment section
        const commentTitle = document.createElement('div');
        commentTitle.className = 'mv-info-section-title';
        commentTitle.textContent = _t('modelviewer.memo');
        card.appendChild(commentTitle);

        const commentArea = document.createElement('textarea');
        commentArea.className = 'mv-info-comment';
        commentArea.placeholder = _t('modelviewer.memoPlaceholder');
        commentArea.rows = 3;
        card.appendChild(commentArea);

        // Metadata rows (populated async, below the action area)
        const rows = document.createElement('div');
        rows.className = 'mv-info-rows';
        card.appendChild(rows);

        // Populate node targets (skip for embeddings — they use text activation)
        if (!isEmbedding) {
            const targets = await this.#findEligibleNodes(modelPath);
            if (targets.length === 0) {
                targetsWrap.innerHTML = '<div class="mv-info-no-targets">' + _t('modelviewer.noTargetNodes') + '</div>';
            } else {
                // Group targets by node ID
                const nodeGroups = new Map();
                for (const t of targets) {
                    const key = t.nodeId;
                    if (!nodeGroups.has(key)) {
                        nodeGroups.set(key, {
                            nodeTitle: t.nodeTitle,
                            nodeType: t.nodeType,
                            nodeId: t.nodeId,
                            widgets: [],
                        });
                    }
                    nodeGroups.get(key).widgets.push(t);
                }

                const checkboxes = [];
                for (const [, group] of nodeGroups) {
                    // Node header
                    const header = document.createElement('div');
                    header.className = 'mv-info-target-header';
                    header.textContent = group.nodeTitle || group.nodeType;
                    targetsWrap.appendChild(header);

                    // Widget rows under this node
                    for (const t of group.widgets) {
                        const label = document.createElement('label');
                        label.className = 'mv-info-target';

                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = false;
                        cb.addEventListener('change', () => {
                            applyBtn.disabled = isXyzSweepActive() || !checkboxes.some(c => c.cb.checked);
                        });

                        const textWrap = document.createElement('div');
                        textWrap.className = 'mv-info-target-text';

                        const widgetLabel = document.createElement('span');
                        widgetLabel.className = 'mv-info-target-name';
                        widgetLabel.textContent = t.displayName || t.widgetName;
                        textWrap.appendChild(widgetLabel);

                        // Show current widget value
                        const currentVal = t.widget?.value;
                        if (currentVal) {
                            const valStr = String(currentVal);
                            // Show just the filename, not the full path
                            const displayVal = valStr.includes('/') ? valStr.split('/').pop()
                                : valStr.includes('\\') ? valStr.split('\\').pop()
                                    : valStr;
                            const valEl = document.createElement('span');
                            valEl.className = 'mv-info-target-value';
                            valEl.textContent = displayVal;
                            textWrap.appendChild(valEl);
                        }

                        label.appendChild(cb);
                        label.appendChild(textWrap);
                        targetsWrap.appendChild(label);
                        checkboxes.push({ cb, target: t, textWrap });
                    }
                }
                // Start disabled since nothing is checked

                applyBtn.addEventListener('click', () => {
                    if (isXyzSweepActive()) return;
                    const selected = checkboxes.filter(c => c.cb.checked);
                    this.#applyToNodes(selected.map(c => c.target));

                    // Update displayed values immediately
                    const newModelPath = modelPath;
                    const newDisplayName = newModelPath.includes('/')
                        ? newModelPath.split('/').pop()
                        : newModelPath.includes('\\')
                            ? newModelPath.split('\\').pop()
                            : newModelPath;

                    for (const entry of selected) {
                        // Update or create the value element
                        let valEl = entry.textWrap.querySelector('.mv-info-target-value');
                        if (!valEl) {
                            valEl = document.createElement('span');
                            valEl.className = 'mv-info-target-value';
                            entry.textWrap.appendChild(valEl);
                        }
                        valEl.textContent = newDisplayName;
                        valEl.style.color = 'var(--cd-accent)'; // green tint to show change

                        // Uncheck
                        entry.cb.checked = false;
                    }

                    applyBtn.textContent = _t('modelviewer.applyToNodesCount', { count: selected.length });
                    applyBtn.disabled = true;

                    // Reset button text after a moment
                    setTimeout(() => {
                        applyBtn.textContent = _t('modelviewer.applyToNodes');
                    }, 1500);
                });
                const syncXyzApplyLock = () => {
                    applyBtn.disabled = isXyzSweepActive() || !checkboxes.some(c => c.cb.checked);
                };
                document.addEventListener('drawer:xyz-sweep-state', syncXyzApplyLock);
                card._cleanupXyzApplyLock = () => document.removeEventListener('drawer:xyz-sweep-state', syncXyzApplyLock);
                syncXyzApplyLock();
            }
        } // end !isEmbedding

        // Fetch model-info async (file size, civitai)
        this.#populateModelInfo(card, rows, triggersWrap, addTriggerBtn, commentArea, modelPath);

        showDialog({
            title: _t('modelviewer.modelInfo'),
            icon: PLACEHOLDER_SVG,
            content: card,
            confirmLabel: null,
            cancelLabel: _t('common.close'),
            showCancel: true,
            onDismiss: () => card._cleanupXyzApplyLock?.(),
        });
    }

    async #populateModelInfo(card, rows, triggersWrap, addTriggerBtn, commentArea, modelPath) {
        try {
            const r = await this.bridge.fetchApi(`/drawer/model-info/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}`);
            if (!r.ok) return;
            const info = await r.json();

            const addRow = (label, value) => {
                const l = document.createElement('span');
                l.className = 'mv-info-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'mv-info-value';
                if (typeof value === 'string') v.textContent = value;
                else v.appendChild(value);
                rows.appendChild(l);
                rows.appendChild(v);
            };

            // File info
            if (info.sizeBytes) {
                const mb = (info.sizeBytes / (1024 * 1024)).toFixed(1);
                const gb = (info.sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
                addRow(_t('modelviewer.size'), info.sizeBytes > 1024 * 1024 * 1024 ? `${gb} GB` : `${mb} MB`);
            }
            if (info.modifiedAt) {
                addRow(_t('modelviewer.modified'), info.modifiedAt.replace('T', ' ').slice(0, 16));
            }

            // Populate comment from .drawer.json
            if (commentArea) {
                const savedComment = info.drawer?.comment || '';
                commentArea.value = savedComment;
                let lastSaved = savedComment;
                commentArea.addEventListener('blur', async () => {
                    const val = commentArea.value.trim();
                    if (val === lastSaved) return;  // no change
                    lastSaved = val;
                    try {
                        await this.bridge.fetchApi(`/drawer/model-comment/${encodeURIComponent(this.#activeCategory)}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: modelPath, comment: val }),
                        });
                    } catch { /* non-critical */ }
                });
            }

            // Helper: create a chip element
            const createChip = (word, removable) => {
                const chip = document.createElement('span');
                chip.className = 'mv-info-trigger';
                if (!removable) chip.classList.add('civitai');
                chip.title = _t('common.clickToCopy');

                const text = document.createElement('span');
                text.textContent = word;
                chip.appendChild(text);

                if (removable) {
                    const removeBtn = document.createElement('span');
                    removeBtn.className = 'mv-info-trigger-remove';
                    removeBtn.textContent = '×';
                    removeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        chip.remove();
                        this.#saveTriggerWords(triggersWrap, modelPath);
                    });
                    chip.appendChild(removeBtn);
                }

                chip.addEventListener('click', (e) => {
                    if (e.target.classList.contains('mv-info-trigger-remove')) return;
                    navigator.clipboard.writeText(word).then(() => {
                        text.textContent = '✓ ' + word;
                        chip.classList.add('copied');
                        setTimeout(() => {
                            chip.classList.remove('copied');
                            text.textContent = word;
                        }, 1200);
                    });
                });
                return chip;
            };

            // CivitAI info
            const ci = info.civitai;

            // Helper: populate CivitAI metadata rows
            const populateCivitaiRows = (civitaiData) => {
                if (civitaiData.model?.name) addRow(_t('modelviewer.modelName'), civitaiData.model.name);
                if (civitaiData.baseModel) addRow(_t('modelviewer.baseModel'), civitaiData.baseModel);
                if (civitaiData.model?.type) addRow(_t('modelviewer.type'), civitaiData.model.type);
                if (civitaiData.files?.[0]?.metadata) {
                    const fm = civitaiData.files[0].metadata;
                    addRow(_t('modelviewer.format'), `${fm.format || ''} ${fm.fp || ''} ${fm.size || ''}`.trim());
                }
                if (civitaiData.modelId) {
                    const a = document.createElement('a');
                    const host = civitaiData._drawer_civitai_host || 'civitai.red';
                    a.href = `https://${host}/models/${civitaiData.modelId}${civitaiData.id ? '?modelVersionId=' + civitaiData.id : ''}`;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    a.textContent = _t('modelviewer.openInCivitai');
                    a.style.cssText = 'color: var(--cd-accent); text-decoration: none;';
                    addRow(_t('modelviewer.link'), a);
                }
            };

            if (ci) {
                populateCivitaiRows(ci);
            }

            // ── CivitAI Sync Button ──
            const syncBtn = document.createElement('button');
            syncBtn.className = 'mv-sync-btn mv-info-sync-btn';
            setStatusButtonContent(syncBtn, SYNC_BTN_SVG, 'CivitAI Sync');
            rows.appendChild(syncBtn);

            syncBtn.addEventListener('click', async () => {
                syncBtn.disabled = true;
                syncBtn.classList.remove('error');
                setStatusButtonContent(syncBtn, SYNC_BTN_SVG, _t('modelviewer.civitaiSyncing'));

                try {
                    const resp = await this.bridge.fetchApi(`/drawer/civitai-sync/${encodeURIComponent(this.#activeCategory)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename: modelPath }),
                    });
                    const result = await resp.json();

                    if (result.ok && result.civitai) {
                        // Remove old CivitAI rows (everything after basic 3 rows)
                        const existingLabels = rows.querySelectorAll('.mv-info-label');
                        const existingValues = rows.querySelectorAll('.mv-info-value');
                        const basicRowCount = info.sizeBytes ? 3 : 2;
                        for (let i = existingLabels.length - 1; i >= basicRowCount; i--) {
                            existingLabels[i]?.remove();
                            existingValues[i]?.remove();
                        }

                        syncBtn.remove();
                        populateCivitaiRows(result.civitai);

                        // Show completed state
                        const resyncBtn = document.createElement('button');
                        resyncBtn.className = 'mv-sync-btn mv-info-sync-btn synced';
                        setStatusButtonContent(resyncBtn, CHECK_BTN_SVG, _t('modelviewer.civitaiSynced'));
                        resyncBtn.disabled = true;
                        rows.appendChild(resyncBtn);

                        // Add CivitAI trigger words
                        if (triggersWrap) {
                            const words = result.civitai.trainedWords || [];
                            for (const word of words) {
                                triggersWrap.appendChild(createChip(word, false));
                            }
                        }

                        this.#showSyncCompleteStrip(1, 0);

                        // Refresh preview image (CivitAI may have downloaded a new one)
                        {
                            const previewImg = card.querySelector('img.mv-info-preview');
                            const previewPlaceholder = card.querySelector('.mv-info-placeholder');
                            const previewOverlay = card.querySelector('.mv-info-preview-overlay');
                            if (previewImg) {
                                // Remove stale video fallbacks
                                card.querySelectorAll('video.mv-info-preview').forEach(v => v.remove());
                                // Make img visible and attach fresh handlers
                                previewImg.style.display = '';
                                previewImg.addEventListener('load', () => {
                                    if (previewPlaceholder) previewPlaceholder.style.display = 'none';
                                    if (previewOverlay) previewOverlay.style.display = '';
                                }, { once: true });
                                previewImg.addEventListener('error', () => {
                                    previewImg.style.display = 'none';
                                    if (previewPlaceholder) previewPlaceholder.style.display = '';
                                    if (previewOverlay) previewOverlay.style.display = 'none';
                                }, { once: true });
                                const refreshSrc = this.bridge.apiURL(`/drawer/model-thumb/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}&t=${Date.now()}`);
                                previewImg.src = refreshSrc;
                            }
                            this.#refreshGridThumb(modelPath);
                        }
                    } else {
                        syncBtn.classList.add('error');
                        setStatusButtonContent(syncBtn, ERROR_BTN_SVG, _t('modelviewer.civitaiSyncFailed', { message: result.message || 'Failed' }));
                        syncBtn.disabled = false;
                        setTimeout(() => {
                            syncBtn.classList.remove('error');
                            setStatusButtonContent(syncBtn, SYNC_BTN_SVG, 'CivitAI Sync');
                        }, 3000);
                    }
                } catch (err) {
                    syncBtn.classList.add('error');
                    setStatusButtonContent(syncBtn, ERROR_BTN_SVG, _t('modelviewer.civitaiSyncFailed', { message: 'Network error' }));
                    syncBtn.disabled = false;
                    setTimeout(() => {
                        syncBtn.classList.remove('error');
                        setStatusButtonContent(syncBtn, SYNC_BTN_SVG, 'CivitAI Sync');
                    }, 3000);
                }
            });

            // ── Trigger Words (CivitAI + custom) ──
            if (triggersWrap) {
                const civitaiWords = ci?.trainedWords || [];
                const customWords = info.drawer?.triggerWords || [];

                // Add CivitAI trigger words (read-only)
                for (const word of civitaiWords) {
                    triggersWrap.appendChild(createChip(word, false));
                }

                // Add custom trigger words (editable)
                for (const word of customWords) {
                    triggersWrap.appendChild(createChip(word, true));
                }

                // "+" button handler
                addTriggerBtn.addEventListener('click', () => {
                    // Check if input already exists
                    if (triggersWrap.querySelector('.mv-info-trigger-input')) return;

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'mv-info-trigger-input';
                    input.placeholder = _t('modelviewer.addTriggerWord');
                    triggersWrap.appendChild(input);
                    input.focus();

                    const commit = () => {
                        const val = input.value.trim();
                        if (val) {
                            const chip = createChip(val, true);
                            triggersWrap.insertBefore(chip, input);
                            this.#saveTriggerWords(triggersWrap, modelPath);
                        }
                        input.remove();
                    };

                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(); }
                        if (e.key === 'Escape') input.remove();
                    });
                    input.addEventListener('blur', commit);
                });
            }

        } catch { /* non-critical */ }
    }

    async #saveTriggerWords(triggersWrap, modelPath) {
        // Collect only custom (non-civitai) trigger words
        const words = [];
        for (const chip of triggersWrap.querySelectorAll('.mv-info-trigger:not(.civitai)')) {
            const text = chip.querySelector('span')?.textContent;
            if (text && !text.startsWith('✓ ')) words.push(text);
        }
        try {
            await this.bridge.fetchApi(`/drawer/model-trigger-words/${encodeURIComponent(this.#activeCategory)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: modelPath, triggerWords: words }),
            });
        } catch { /* non-critical */ }
    }

    /* ══════ Model Delete ══════ */

    async #deleteModel(modelPath, displayName) {
        const showConfirm = window.ComfyDrawer?.showConfirm;
        if (!showConfirm) return;

        const confirmed = await showConfirm(
            _t('modelviewer.confirmDelete', { name: displayName }),
            { title: _t('common.delete'), danger: true }
        );
        if (!confirmed) return;

        try {
            const resp = await this.bridge.fetchApi(
                `/drawer/model/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}`,
                { method: 'DELETE' },
            );
            const result = await resp.json();
            if (result.ok) {
                this.#showToast(_t('modelviewer.deleted'));
                // Refresh the model list
                this.#loadModels(this.#activeCategory);
            } else {
                this.#showToast(result.error || _t('common.error'));
            }
        } catch (err) {
            this.#showToast(err.message);
        }
    }

    /* ══════ Model Folder Create ══════ */

    async #createModelFolder(parentSubfolder) {
        const showPrompt = window.ComfyDrawer?.showPrompt;
        if (!showPrompt) return;

        let errorHint = '';
        while (true) {
            const name = await showPrompt(errorHint || _t('modelviewer.newFolder') + ':', {
                title: _t('modelviewer.newFolder'),
                placeholder: _t('modelviewer.newFolder'),
            });
            if (!name) return;  // cancelled

            try {
                const r = await this.bridge.fetchApi(`/drawer/model-folder/${encodeURIComponent(this.#activeCategory)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subfolder: parentSubfolder || '', name }),
                });
                const data = await r.json();

                if (r.status === 409) {
                    errorHint = _t('gallery.folderExistsPrompt', { name });
                    continue;
                }
                if (data.error) {
                    this.#showToast(_t('common.error') + ': ' + data.error);
                    return;
                }
                this.#showToast(_t('common.done'));
                this.#loadModels(this.#activeCategory);
                return;
            } catch (e) {
                this.#showToast(_t('common.error') + ': ' + e.message);
                return;
            }
        }
    }

    /* ══════ Node Matching & Apply ══════ */

    async #findEligibleNodes(modelPath) {
        return enumerateModelValueTargets(this.bridge, modelPath);
    }

    #applyToNodes(targets) {
        if (isXyzSweepActive()) return;
        for (const t of targets) {
            t.addOption?.(t.origValue);
            t.setValue(t.origValue);
        }
        this.#showToast(_t('modelviewer.applyToNodesCount', { count: targets.length }));
    }

    /* ══════ Swipe Navigation ══════ */

    /**
     * Attach horizontal swipe to content area.
     * - At root: swipes between categories
     * - Inside subfolder: swipes between sibling folders
     */
    #attachSwipe() {
        this.#swipeDetach = attachSwipeNav(this.#el.content, {
            onSwipeLeft: () => this.#navigateSibling(+1),
            onSwipeRight: () => this.#navigateSibling(-1),
        });
    }

    #isKeyboardNavigationAvailable(e) {
        if (this.container?.style.display === 'none') return false;
        if (isLightboxOpen()) return false;
        if (e.ctrlKey || e.altKey || e.metaKey || e.key.startsWith('F')) return false;
        if (isEditableTarget(e.target)) return false;
        return !!this.#activeCategory && !this.#searchQuery && !this.#searchOpen;
    }

    #handleHierarchyKey(e) {
        if (!this.#isKeyboardNavigationAvailable(e)) return;

        let handled = false;
        switch (e.key) {
            case 'ArrowLeft':
            case 'a':
            case 'A':
                handled = this.#navigateParent();
                break;
            case 'ArrowRight':
            case 'd':
            case 'D':
                handled = this.#navigateChild();
                break;
            case 'ArrowUp':
            case 'w':
            case 'W':
                handled = this.#navigateSibling(-1);
                break;
            case 'ArrowDown':
            case 's':
            case 'S':
                handled = this.#navigateSibling(+1);
                break;
        }
        if (!handled) return;
        e.preventDefault();
        e.stopPropagation();
    }

    #navigateParent() {
        if (!this.#subfolder) return false;
        const idx = this.#subfolder.lastIndexOf('/');
        this.#setSubfolder(idx >= 0 ? this.#subfolder.slice(0, idx) : '');
        this.#page = 0;
        this.#applyFilter();
        this.#renderGrid();
        return true;
    }

    #navigateChild() {
        const { folders } = this.#buildView();
        const folder = folders[0];
        if (!folder?.path) return false;
        this.#setSubfolder(folder.path);
        this.#page = 0;
        this.#applyFilter();
        this.#renderGrid();
        return true;
    }

    /**
     * Get sibling folders at the same level as the current subfolder.
     * Returns { siblings: string[], currentIndex: number }
     */
    #getSiblings() {
        if (!this.#subfolder) {
            // At root → siblings are categories
            return { siblings: this.#categories, currentIndex: this.#categories.indexOf(this.#activeCategory) };
        }

        // Get parent folder path
        const lastSlash = this.#subfolder.lastIndexOf('/');
        const parentPrefix = lastSlash >= 0 ? this.#subfolder.slice(0, lastSlash + 1) : '';
        const currentName = lastSlash >= 0 ? this.#subfolder.slice(lastSlash + 1) : this.#subfolder;

        // Build sibling folder list from all models
        const siblingSet = new Set();
        for (const model of this.#models) {
            if (parentPrefix && !model.startsWith(parentPrefix)) continue;
            const rel = parentPrefix ? model.slice(parentPrefix.length) : model;
            const slashIdx = rel.indexOf('/');
            if (slashIdx >= 0) {
                siblingSet.add(rel.slice(0, slashIdx));
            }
        }

        const siblings = Array.from(siblingSet).sort();
        const currentIndex = siblings.indexOf(currentName);

        return {
            siblings: siblings.map(s => parentPrefix + s),
            currentIndex: currentIndex >= 0 ? currentIndex : -1,
        };
    }

    /**
     * Navigate to a sibling folder (or category at root).
     * @param {number} delta - +1 for next, -1 for previous
     */
    #navigateSibling(delta) {
        if (this.#searchQuery) return; // no swipe in search mode

        const { siblings, currentIndex } = this.#getSiblings();
        if (siblings.length === 0 || currentIndex < 0) return false;

        const nextIdx = currentIndex + delta;
        if (nextIdx < 0 || nextIdx >= siblings.length) return false;

        if (!this.#subfolder) {
            // Root → switch category
            this.#selectCategory(siblings[nextIdx]);
        } else {
            // Subfolder → switch to sibling folder
            this.#setSubfolder(siblings[nextIdx]);
            this.#page = 0;
            this.#applyFilter();
            this.#renderGrid();
        }
        return true;
    }

    /* ══════ Helpers ══════ */

    #setStatus(msg) {
        this.#el.status.innerHTML = msg;
    }

    #showToast(msg) {
        // Delegate to the platform toast. The previous inline-styled fixed
        // <div> was duplicated across gadgets, ignored the theme tokens,
        // and stacked overlapping toasts on rapid actions.
        const showToast = window.ComfyDrawer?.showToast;
        if (typeof showToast === 'function') {
            showToast(msg, { duration: 2000 });
        }
    }

    /**
     * Bust the grid card thumbnail for a specific model after preview changes.
     * Also refreshes the overlay image if visible.
     * @param {string} modelPath
     */
    #refreshGridThumb(modelPath) {
        const thumbBase = this.bridge.apiURL(`/drawer/model-thumb/${encodeURIComponent(this.#activeCategory)}?filename=${encodeURIComponent(modelPath)}`);
        const bust = `${thumbBase}&t=${Date.now()}`;
        const grid = this.container?.querySelector('.mv-grid');
        if (!grid) return;

        for (const img of grid.querySelectorAll('img.mc-thumb')) {
            if (!img.src.includes(encodeURIComponent(modelPath))) continue;

            const thumbWrap = img.parentElement;

            // Remove stale video fallbacks from previous error handler
            thumbWrap?.querySelectorAll('video.mv-thumb-video').forEach(v => v.remove());

            // Re-show the img (may have been hidden by initial error handler)
            img.style.display = '';

            // Attach fresh load/error handlers
            img.addEventListener('load', () => {
                // Image loaded — remove placeholder if still present
                thumbWrap?.querySelector('.mv-placeholder')?.remove();
            }, { once: true });

            img.addEventListener('error', () => {
                // Still no preview — hide img, restore placeholder
                img.style.display = 'none';
                const existing = thumbWrap?.querySelector('.mv-placeholder');
                if (!existing && thumbWrap) {
                    const ph = document.createElement('span');
                    ph.className = 'mv-placeholder';
                    ph.innerHTML = PLACEHOLDER_SVG;
                    thumbWrap.prepend(ph);
                }
            }, { once: true });

            // Trigger reload
            img.src = bust;
        }
    }

    #highlightMatch(text, query) {
        if (!query) return escapeHTML(text);
        const escaped = escapeHTML(text);
        const qEsc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return escaped.replace(new RegExp(`(${qEsc})`, 'gi'), '<mark>$1</mark>');
    }
}
