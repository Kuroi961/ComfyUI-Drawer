/**
 * ComfyDrawer — Gallery Gadget
 * Migrated from ComfyUI-Gallery iframe → same-DOM GadgetBase component.
 * All ComfyUI interactions go through ComfyBridge.
 */
import { GadgetBase } from '../../js/core/gadget-base.js';
import { ContextMenuService } from '../../js/services/context-menu.js';
import { createMediaCard } from '../../js/components/media-card.js';
import { attachDictAutocomplete } from '../../js/services/dict-service.js';
import { openLightbox, getLightboxIndex, removeLightboxItem, isLightboxOpen } from '../../js/services/lightbox.js';
import { attachSwipeNav } from '../../js/services/swipe-nav.js';
import { escapeHTML } from '../../js/utils.js';

/** @private Locale helper */
const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;

const GALLERY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"/><path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"/><circle cx="13" cy="7" r="1" fill="currentColor"/><rect x="8" y="2" width="14" height="14" rx="2"/></svg>`;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
const AUDIO_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const VIDEO_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const X_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

function isEditableTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

export class GalleryGadget extends GadgetBase {
    /* ── State ── */
    #state = {
        mode: 'browse',       // 'browse' | 'search'
        root: 'output',       // 'output' | 'input' | 'temp'
        path: '',
        query: '',
        files: [],
        folders: [],
        breadcrumb: [],
        total: 0,
        sort: localStorage.getItem('gallery-sort') || 'name-asc',
        rawFiles: [],
        selectMode: false,
        selected: new Set(),   // Set<filePath|folderPath>
        moveMode: false,       // Phase 3: browse-to-move
        moveSrcPath: '',       // Phase 3: original path before move browse
        moveSrcRoot: '',       // Phase 3: original root before move browse
        autoplay: localStorage.getItem('gallery-autoplay') === 'true',
        searchScope: '',
        dateFrom: '',
        dateTo: '',
        minSizeMB: '',
        maxSizeMB: '',
        indexStatus: null,
    };

    /* ── DOM refs (set in onMount) ── */
    #el = {};

    #lbCurrentFile = null;
    #lastFetchTime = 0;
    /** @type {AbortController|null} */
    #fetchController = null;
    /** @type {import('../../js/context-menu.js').ContextMenuService|null} */
    #contextMenu = null;
    /** @type {Function[]} Cleanup functions scoped to the current grid render */
    #gridCleanups = [];
    /** @type {function|null} Swipe navigation detach */
    #swipeDetach = null;

    constructor() {
        super('gallery', {
            label: 'Gallery',
            icon: GALLERY_ICON,
            order: 3,
            cssUrl: new URL('./gallery.css', import.meta.url).href,
        });
    }

    /* ═══ Lifecycle ═══ */

    onMount(container, bus, bridge) {
        this.#buildDOM();
        this.#bindEvents();

        // Attach dictionary autocomplete to search input (space-separated for search)
        this.addDisposable(attachDictAutocomplete(window.ComfyDrawer.dict, this.#el.searchInput, { separator: ' ', context: 'search' }));

        // Register context menu actions for gallery files
        this.#contextMenu = window.ComfyDrawer?.contextMenu ?? null;
        this.#registerContextActions();

        this.#browse('');
        this.#attachSwipe();

        // Auto-refresh when a generation completes (debounced — executed fires per node)
        let execTimer = null;
        this.addDisposable(bus.on('comfy:executed', () => {
            // Force stale so next activation refreshes
            this.#lastFetchTime = 0;
            // Debounce: only refresh after 2s of silence (avoids N refreshes for N nodes)
            clearTimeout(execTimer);
            execTimer = setTimeout(() => {
                if (this.container?.style.display !== 'none' && this.#state.mode === 'browse') {
                    this.#browse(this.#state.path);
                }
            }, 2000);
        }));
        this.addDisposable(() => clearTimeout(execTimer));
    }

    onActivate() {
        // Refresh on tab switch — but only if data is stale (>5s since last fetch)
        const STALE_MS = 5000;
        if (this.#state.mode === 'browse' && (Date.now() - this.#lastFetchTime > STALE_MS)) {
            this.#browse(this.#state.path);
        }
    }

    onGraphChanged() {
        // Always re-fetch on explicit reload / graph switch (no staleness check)
        if (this.#state.mode === 'browse') {
            this.#browse(this.#state.path);
        } else if (this.#state.mode === 'search' && this.#state.query) {
            this.#search(this.#state.query);
        }
    }

    onDestroy() {
        // Abort in-flight fetches
        if (this.#fetchController) {
            this.#fetchController.abort();
            this.#fetchController = null;
        }
        for (const fn of this.#gridCleanups) fn();
        this.#gridCleanups = [];
        this.#swipeDetach?.();
        this.#contextMenu?.unregisterByPrefix('gallery:');
    }

    /* ═══ DOM Construction ═══ */

    #buildDOM() {
        this.container.innerHTML = `
            <div class="gg-toolbar">
                <!-- ── Browse toolbar (default) ── -->
                <div class="gg-toolbar-browse">
                    <button class="gg-search-back" title="${_t('common.close')}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
                        </svg>
                    </button>
                    <div class="gg-search-box">
                        <input type="search" class="gg-search-input" placeholder="${_t('gallery.search')}" enterkeyhint="search" autocomplete="off" spellcheck="false"/>
                        <span class="gg-result-count"></span>
                        <button class="gg-clear-btn" hidden>${X_ICON_SVG}</button>
                        <button class="gg-search-submit" title="${_t('gallery.search')}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                            </svg>
                        </button>
                    </div>
                    <div class="gg-scope-wrap">
                        <button class="gg-scope-trigger" title="${_t('gallery.searchScope')}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
                            </svg>
                        </button>
                        <div class="gg-scope-menu" hidden>
                            <div class="gg-filter-section">
                                <div class="gg-filter-headline">
                                    <div class="gg-filter-heading">${_t('gallery.searchScope')}</div>
                                    <button class="gg-filter-clear" type="button">${_t('common.clear')}</button>
                                </div>
                                <label class="gg-scope-option active" data-value="">${_t('gallery.scopeAll')}</label>
                                <label class="gg-scope-option" data-value="name">${_t('gallery.scopeFilename')}</label>
                                <label class="gg-scope-option" data-value="prompt">${_t('gallery.scopePrompt')}</label>
                                <label class="gg-scope-option" data-value="workflow">${_t('gallery.scopeWorkflow')}</label>
                            </div>
                            <div class="gg-filter-section">
                                <div class="gg-filter-heading">${_t('gallery.filterDate')}</div>
                                <div class="gg-date-range">
                                    <label>
                                        <span>${_t('gallery.filterDateFrom')}</span>
                                        <input class="gg-date-from" type="date" />
                                    </label>
                                    <label>
                                        <span>${_t('gallery.filterDateTo')}</span>
                                        <input class="gg-date-to" type="date" />
                                    </label>
                                </div>
                            </div>
                            <div class="gg-filter-section">
                                <div class="gg-filter-heading">${_t('gallery.filterSizeMB')}</div>
                                <div class="gg-size-filter">
                                    <label>
                                        <span>${_t('gallery.filterMin')}</span>
                                        <input class="gg-min-size" type="number" min="0" step="0.1" inputmode="decimal" />
                                    </label>
                                    <label>
                                        <span>${_t('gallery.filterMax')}</span>
                                        <input class="gg-max-size" type="number" min="0" step="0.1" inputmode="decimal" />
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                    <select class="gg-sort-select" title="${_t('common.sort')}">
                        <option value="name-asc">${_t('gallery.sortName')} ↑</option>
                        <option value="name-desc">${_t('gallery.sortName')} ↓</option>
                        <option value="date-asc">${_t('gallery.sortDate')} ↑</option>
                        <option value="date-desc">${_t('gallery.sortDate')} ↓</option>
                        <option value="size-asc">${_t('gallery.sortSize')} ↑</option>
                        <option value="size-desc">${_t('gallery.sortSize')} ↓</option>
                    </select>
                    <div class="gg-search-bar">
                        <div class="gg-search-summary"></div>
                        <div class="gg-index-status" hidden></div>
                        <select class="gg-sort-select gg-search-sort-select" title="${_t('common.sort')}">
                            <option value="name-asc">${_t('gallery.sortName')} ↑</option>
                            <option value="name-desc">${_t('gallery.sortName')} ↓</option>
                            <option value="date-asc">${_t('gallery.sortDate')} ↑</option>
                            <option value="date-desc">${_t('gallery.sortDate')} ↓</option>
                            <option value="size-asc">${_t('gallery.sortSize')} ↑</option>
                            <option value="size-desc">${_t('gallery.sortSize')} ↓</option>
                        </select>
                    </div>
                    <button class="gg-autoplay-toggle" title="Autoplay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polygon points="6 3 20 12 6 21 6 3"/></svg></button>
                    <button class="gg-search-trigger" title="${_t('gallery.search')}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                        </svg>
                    </button>
                </div>
                <!-- ── Select toolbar ── -->
                <div class="gg-toolbar-select" hidden>
                    <span class="gg-sel-count">0</span>
                    <button class="gg-sel-all" title="${_t('gallery.selectAll')}">${_t('gallery.selectAll')}</button>
                    <div class="gg-sel-spacer"></div>
                    <button class="gg-sel-move" title="${_t('gallery.moveTo')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${_t('gallery.moveTo')}</button>
                    <button class="gg-sel-delete" title="${_t('common.delete')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> ${_t('common.delete')}</button>
                    <button class="gg-sel-cancel" title="${_t('common.cancel')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button>
                </div>
                <!-- ── Move toolbar ── -->
                <div class="gg-toolbar-move" hidden>
                    <span class="gg-move-label">${_t('gallery.selectDest')}</span>
                    <div class="gg-sel-spacer"></div>
                    <button class="gg-move-confirm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${_t('gallery.moveTo')}</button>
                    <button class="gg-move-cancel" title="${_t('common.cancel')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button>
                </div>
            </div>

            <nav class="gg-breadcrumb">
                <ol class="gg-breadcrumb-list"></ol>
            </nav>

            <div class="gg-content">
                <div class="gg-grid"></div>
                <div class="gg-status"></div>
            </div>
        `;

        // Cache refs
        const q = (s) => this.container.querySelector(s);
        this.#el = {
            toolbar: q('.gg-toolbar'),
            // Browse toolbar
            toolbarBrowse: q('.gg-toolbar-browse'),
            searchBox: q('.gg-search-box'),
            searchInput: q('.gg-search-input'),
            searchTrigger: q('.gg-search-trigger'),
            searchSubmit: q('.gg-search-submit'),
            searchBack: q('.gg-search-back'),
            scopeTrigger: q('.gg-scope-trigger'),
            scopeMenu: q('.gg-scope-menu'),
            dateFrom: q('.gg-date-from'),
            dateTo: q('.gg-date-to'),
            minSize: q('.gg-min-size'),
            maxSize: q('.gg-max-size'),
            filterClear: q('.gg-filter-clear'),
            resultCount: q('.gg-result-count'),
            clearBtn: q('.gg-clear-btn'),
            sortSelect: q('.gg-sort-select'),
            searchSortSelect: q('.gg-search-sort-select'),
            autoplayToggle: q('.gg-autoplay-toggle'),
            // Select toolbar
            toolbarSelect: q('.gg-toolbar-select'),
            selCount: q('.gg-sel-count'),
            selAll: q('.gg-sel-all'),
            selMove: q('.gg-sel-move'),
            selDelete: q('.gg-sel-delete'),
            selCancel: q('.gg-sel-cancel'),
            // Move toolbar
            toolbarMove: q('.gg-toolbar-move'),
            moveCancel: q('.gg-move-cancel'),
            moveConfirm: q('.gg-move-confirm'),
            // Shared
            breadcrumb: q('.gg-breadcrumb'),
            breadcrumbList: q('.gg-breadcrumb-list'),
            searchSummary: q('.gg-search-summary'),
            indexStatus: q('.gg-index-status'),
            grid: q('.gg-grid'),
            status: q('.gg-status'),
        };

        this.#el.sortSelect.value = this.#state.sort;
        this.#el.searchSortSelect.value = this.#state.sort;
        if (this.#state.autoplay) this.#el.autoplayToggle.classList.add('active');
    }

    /* ═══ Event Binding ═══ */

    #bindEvents() {
        const el = this.#el;

        // Sort
        el.sortSelect.addEventListener('change', () => {
            this.#state.sort = el.sortSelect.value;
            el.searchSortSelect.value = this.#state.sort;
            localStorage.setItem('gallery-sort', this.#state.sort);
            this.#sortFiles();
            this.#renderGrid();
        });
        el.searchSortSelect.addEventListener('change', () => {
            this.#state.sort = el.searchSortSelect.value;
            el.sortSelect.value = this.#state.sort;
            localStorage.setItem('gallery-sort', this.#state.sort);
            this.#sortFiles();
            this.#renderGrid();
        });

        // Search — explicit Enter key / search button trigger
        const doSearch = () => {
            const q = el.searchInput.value.trim();
            if (q) {
                el.searchInput.blur(); // dismiss autocomplete & mobile keyboard
                this.#search(q);
            }
        };
        el.searchInput.addEventListener('input', () => {
            const q = el.searchInput.value.trim();
            el.clearBtn.hidden = !q;
            if (!q) {
                el.resultCount.textContent = '';
                this.#renderSearchSummary('');
                this.#browse(this.#state.path);
            }
        });
        el.searchInput.addEventListener('keydown', (e) => {
            if (e.defaultPrevented) return;
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                doSearch();
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                el.searchInput.value = '';
                el.clearBtn.hidden = true;
                el.resultCount.textContent = '';
                this.#renderSearchSummary('');
                this.#closeSearch();
                this.#browse(this.#state.path);
            }
        });

        el.clearBtn.addEventListener('click', () => {
            el.searchInput.value = '';
            el.clearBtn.hidden = true;
            el.resultCount.textContent = '';
            this.#renderSearchSummary('');
            this.#browse(this.#state.path);
            el.searchInput.focus();
        });

        // Collapsible search: trigger opens, back closes, submit searches
        el.searchTrigger.addEventListener('click', () => {
            if (this.#state.root === 'temp') return;  // search disabled for temp
            this.#openSearch();
            this.#refreshIndexStatus();
        });
        el.searchSubmit.addEventListener('click', () => doSearch());
        el.searchBack.addEventListener('click', () => {
            el.searchInput.value = '';
            el.clearBtn.hidden = true;
            el.resultCount.textContent = '';
            this.#renderSearchSummary('');
            this.#closeSearch();
            if (this.#state.mode === 'search') this.#browse(this.#state.path);
        });

        // Scope funnel menu
        el.scopeTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !el.scopeMenu.hidden;
            el.scopeMenu.hidden = isOpen;
            el.scopeTrigger.classList.toggle('active', !isOpen);
        });
        el.scopeMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const option = e.target.closest('.gg-scope-option');
            if (!option) return;
            el.scopeMenu.querySelectorAll('.gg-scope-option').forEach(o => o.classList.remove('active'));
            option.classList.add('active');
            this.#state.searchScope = option.dataset.value;
            // Highlight funnel when non-default scope is selected
            this.#syncFilterState();
            const q = el.searchInput.value.trim();
            if (this.#state.mode === 'search' && q.length >= 2) {
                this.#search(q);
            }
        });
        el.scopeMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
        const applyClientFilters = () => {
            this.#state.dateFrom = el.dateFrom.value;
            this.#state.dateTo = el.dateTo.value;
            this.#state.minSizeMB = el.minSize.value;
            this.#state.maxSizeMB = el.maxSize.value;
            this.#syncFilterState();
            this.#applyFiltersSortRender();
        };
        el.dateFrom.addEventListener('change', applyClientFilters);
        el.dateTo.addEventListener('change', applyClientFilters);
        el.minSize.addEventListener('input', this.#debounce(applyClientFilters, 250));
        el.maxSize.addEventListener('input', this.#debounce(applyClientFilters, 250));
        el.filterClear.addEventListener('click', () => {
            el.scopeMenu.querySelectorAll('.gg-scope-option').forEach(o => o.classList.remove('active'));
            el.scopeMenu.querySelector('.gg-scope-option[data-value=""]')?.classList.add('active');
            el.dateFrom.value = '';
            el.dateTo.value = '';
            el.minSize.value = '';
            el.maxSize.value = '';
            this.#state.searchScope = '';
            applyClientFilters();
            const q = el.searchInput.value.trim();
            if (this.#state.mode === 'search' && q.length >= 2) {
                this.#search(q);
            }
        });
        // Close scope menu on outside click
        const closeScopeMenu = () => {
            el.scopeMenu.hidden = true;
            el.scopeTrigger.classList.remove('active');
        };
        document.addEventListener('click', closeScopeMenu);
        this.addDisposable(() => document.removeEventListener('click', closeScopeMenu));
        const offClosePopovers = this.bus?.on?.('drawer:close-popovers', closeScopeMenu);
        if (offClosePopovers) this.addDisposable(offClosePopovers);

        const onNavKey = (e) => this.#handleHierarchyKey(e);
        document.addEventListener('keydown', onNavKey, { capture: true });
        this.addDisposable(() => document.removeEventListener('keydown', onNavKey, { capture: true }));

        // Selection toolbar
        el.selDelete.addEventListener('click', () => this.#deleteSelected());
        el.selCancel.addEventListener('click', () => this.#exitSelectMode());
        el.selMove.addEventListener('click', () => this.#enterMoveMode());
        el.selAll.addEventListener('click', () => this.#selectAll());

        // Move toolbar
        el.moveCancel.addEventListener('click', () => this.#exitMoveMode());
        el.moveConfirm.addEventListener('click', () => this.#executeMove());

        // Autoplay toggle
        el.autoplayToggle.addEventListener('click', () => {
            this.#state.autoplay = !this.#state.autoplay;
            el.autoplayToggle.classList.toggle('active', this.#state.autoplay);
            localStorage.setItem('gallery-autoplay', this.#state.autoplay);
        });
    }

    /* ═══ Collapsible Search ═══ */

    #openSearch() {
        this.#el.toolbarBrowse.classList.add('search-open');
        this.#el.breadcrumb.classList.add('search-open');
        this.#renderSearchSummary('');
        this.#el.searchInput.focus();
    }

    #closeSearch() {
        this.#el.toolbarBrowse.classList.remove('search-open');
        this.#el.breadcrumb.classList.remove('search-open');
        this.#renderSearchSummary('');
        this.#el.searchInput.blur();
    }

    #renderSearchSummary(text) {
        if (!this.#el.searchSummary) return;
        this.#el.searchSummary.textContent = text || '';
    }

    #renderIndexStatus(status = this.#state.indexStatus) {
        const el = this.#el.indexStatus;
        if (!el) return;
        if (this.#state.root === 'temp' || !status || status.ready) {
            el.hidden = true;
            el.textContent = '';
            el.classList.remove('building', 'error');
            return;
        }
        el.hidden = false;
        el.classList.toggle('building', !!status.building);
        el.classList.toggle('error', !status.building);
        const progress = status.progress || _t('gallery.searchIndexPreparing');
        el.textContent = status.building
            ? _t('gallery.searchIndexBuilding', { progress })
            : progress;
    }

    async #refreshIndexStatus() {
        if (this.#state.root === 'temp') return null;
        try {
            const r = await fetch('/drawer/fs/index-status');
            if (!r.ok) return null;
            const status = await r.json();
            this.#state.indexStatus = status;
            this.#renderIndexStatus(status);
            return status;
        } catch {
            return null;
        }
    }

    /* ═══ Helpers ═══ */

    #debounce(fn, ms) {
        let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    }
    #fmtSize(b) {
        if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return Math.round(b / 1024) + ' KB';
        return b + ' B';
    }
    #fmtDate(ts) {
        const d = new Date(ts * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    #hasActiveFilters() {
        const s = this.#state;
        return !!(s.searchScope || s.dateFrom || s.dateTo || s.minSizeMB || s.maxSizeMB);
    }

    #syncFilterState() {
        this.#el.scopeTrigger.classList.toggle('filtered', this.#hasActiveFilters());
    }

    #applyClientFilters(files) {
        const s = this.#state;
        const minSize = Number.parseFloat(s.minSizeMB);
        const maxSize = Number.parseFloat(s.maxSizeMB);
        const fromDate = s.dateFrom ? new Date(`${s.dateFrom}T00:00:00`) : null;
        const toDate = s.dateTo ? new Date(`${s.dateTo}T23:59:59.999`) : null;
        const minCreated = fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate.getTime() / 1000 : 0;
        const maxCreated = toDate && !Number.isNaN(toDate.getTime()) ? toDate.getTime() / 1000 : 0;
        return (files || []).filter(file => {
            if (minCreated && (file.created || 0) < minCreated) return false;
            if (maxCreated && (file.created || 0) > maxCreated) return false;
            if (Number.isFinite(minSize) && minSize > 0 && (file.size || 0) < minSize * 1048576) return false;
            if (Number.isFinite(maxSize) && maxSize > 0 && (file.size || 0) > maxSize * 1048576) return false;
            return true;
        });
    }

    #applyFiltersSortRender() {
        this.#state.files = this.#applyClientFilters(this.#state.rawFiles);
        this.#sortFiles();
        this.#renderGrid();
    }

    #highlight(snippet, query) {
        if (!snippet || !query) return escapeHTML(snippet || '');
        const tokens = query.split(/\s+/).filter(t => t);
        let marked = snippet;
        const PH_OPEN = '\x00MO\x00', PH_CLOSE = '\x00MC\x00';
        for (const tok of tokens) {
            const e = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            marked = marked.replace(new RegExp('(' + e + ')', 'gi'), PH_OPEN + '$1' + PH_CLOSE);
        }
        let html = escapeHTML(marked);
        html = html.replaceAll(escapeHTML(PH_OPEN), '<mark>').replaceAll(escapeHTML(PH_CLOSE), '</mark>');
        return html;
    }
    #imgUrl(file) {
        const root = this.#getRoot();
        const subfolder = file.subfolder || '';
        return `/drawer/fs/view?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&filename=${encodeURIComponent(file.name)}`;
    }

    #sortFiles() {
        const [key, dir] = this.#state.sort.split('-');
        const asc = dir === 'asc' ? 1 : -1;
        const comparator = (a, b) => {
            let va, vb;
            if (key === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
            else if (key === 'date') { va = a.created ?? ''; vb = b.created ?? ''; }
            else if (key === 'size') { va = a.size ?? 0; vb = b.size ?? 0; }
            else { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
            return va < vb ? -asc : va > vb ? asc : 0;
        };
        this.#state.folders.sort(comparator);
        this.#state.files.sort(comparator);
    }

    #setStatus(msg) {
        this.#el.status.textContent = msg;
        this.#el.status.classList.remove('hidden');
    }
    #setStatusIcon(icon, msg) {
        this.#el.status.innerHTML = `${icon}<span></span>`;
        this.#el.status.querySelector('span').textContent = msg;
        this.#el.status.classList.remove('hidden');
    }

    #showToast(msg) {
        const el = document.createElement('div');
        el.className = 'gg-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
    }

    /** Create a new AbortController for fetch, aborting any previous one */
    #newFetchSignal() {
        if (this.#fetchController) this.#fetchController.abort();
        this.#fetchController = new AbortController();
        return this.#fetchController.signal;
    }

    /* ═══ Swipe Navigation ═══ */

    /**
     * Attach horizontal swipe to content area.
     * - At root: swipes between root types (output/input/temp)
     * - In subfolder: swipes between sibling folders via API
     */
    #attachSwipe() {
        const contentEl = this.container.querySelector('.gg-content');
        if (!contentEl) return;
        this.#swipeDetach = attachSwipeNav(contentEl, {
            onSwipeLeft: () => this.#navigateGallerySibling(+1),
            onSwipeRight: () => this.#navigateGallerySibling(-1),
        });
    }

    #isKeyboardNavigationAvailable(e) {
        if (this.container?.style.display === 'none') return false;
        if (isLightboxOpen()) return false;
        if (e.ctrlKey || e.altKey || e.metaKey || e.key.startsWith('F')) return false;
        if (isEditableTarget(e.target)) return false;
        const s = this.#state;
        return s.mode === 'browse' && !s.selectMode && !s.moveMode;
    }

    #handleHierarchyKey(e) {
        if (!this.#isKeyboardNavigationAvailable(e)) return;

        let handled = false;
        switch (e.key) {
            case 'ArrowLeft':
            case 'a':
            case 'A':
                handled = this.#navigateGalleryParent();
                break;
            case 'ArrowRight':
            case 'd':
            case 'D':
                handled = this.#navigateGalleryChild();
                break;
            case 'ArrowUp':
            case 'w':
            case 'W':
                this.#navigateGallerySibling(-1);
                handled = true;
                break;
            case 'ArrowDown':
            case 's':
            case 'S':
                this.#navigateGallerySibling(+1);
                handled = true;
                break;
        }
        if (!handled) return;
        e.preventDefault();
        e.stopPropagation();
    }

    #navigateGalleryParent() {
        const path = this.#state.path || '';
        if (!path) return false;
        const idx = path.lastIndexOf('/');
        this.#browse(idx >= 0 ? path.slice(0, idx) : '');
        return true;
    }

    #navigateGalleryChild() {
        const folder = this.#state.folders?.[0];
        if (!folder?.path) return false;
        this.#browse(folder.path);
        return true;
    }

    /**
     * Navigate to a sibling folder or root.
     * @param {number} delta - +1 for next, -1 for previous
     */
    async #navigateGallerySibling(delta) {
        const s = this.#state;
        if (s.mode === 'search' || s.selectMode || s.moveMode) return;

        const root = this.#getRoot();
        const path = s.path;

        if (!path) {
            // Root level → cycle between root types
            const roots = ['output', 'input', 'temp'];
            const idx = roots.indexOf(root);
            if (idx < 0) return;
            const nextIdx = idx + delta;
            if (nextIdx < 0 || nextIdx >= roots.length) return;
            s.root = roots[nextIdx];
            if (roots[nextIdx] === 'temp') {
                this.#showTempWarning(() => this.#browse(''));
            } else {
                this.#browse('');
            }
            return;
        }

        // Subfolder → fetch siblings from API
        try {
            const r = await fetch(`/drawer/fs/siblings?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
            const data = await r.json();
            if (!data.folders?.length) return;

            const currentName = path.split('/').pop();
            const idx = data.folders.findIndex(f => f.name === currentName);
            if (idx < 0) return;

            const nextIdx = idx + delta;
            if (nextIdx < 0 || nextIdx >= data.folders.length) return;

            this.#browse(data.folders[nextIdx].path);
        } catch (e) {
            console.error('[Gallery] Swipe sibling fetch error:', e);
        }
    }

    /* ═══ API ═══ */

    async #apiBrowse(path) {
        const signal = this.#newFetchSignal();
        const root = this.#state.root || 'output';
        const r = await fetch(`/drawer/fs/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { signal });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
        this.#lastFetchTime = Date.now();
        return r.json();
    }

    async #apiSearch(q, path) {
        const signal = this.#newFetchSignal();
        const root = this.#state.root || 'output';
        const scope = this.#state.searchScope || '';
        const r = await fetch(`/drawer/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&path=${encodeURIComponent(path || '')}&limit=0&scope=${encodeURIComponent(scope)}`, { signal });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
        this.#lastFetchTime = Date.now();
        return r.json();
    }

    /* ═══ Browse / Search ═══ */

    async #browse(path) {
        const s = this.#state;
        // Exit selection mode if navigating to a different folder (e.g. via breadcrumb)
        // but NOT in move mode — move mode needs folder navigation to pick destination
        if (s.selectMode && !s.moveMode) {
            s.selectMode = false;
            s.selected.clear();
            this.#showToolbar('browse');
        }
        s.mode = 'browse'; s.path = path; s.query = '';
        this.#el.searchInput.value = '';
        this.#el.clearBtn.hidden = true;
        this.#el.resultCount.textContent = '';
        this.#renderSearchSummary('');
        this.#renderIndexStatus(null);
        this.#el.breadcrumb.classList.remove('hidden');
        // Disable search on temp root
        const isTemp = s.root === 'temp';
        this.#el.searchTrigger.style.opacity = isTemp ? '0.3' : '';
        this.#el.searchTrigger.style.pointerEvents = isTemp ? 'none' : '';
        if (isTemp) this.#closeSearch();
        this.#setStatus(_t('common.loading'));
        this.#el.grid.innerHTML = '';
        try {
            const data = await this.#apiBrowse(path);
            s.folders = data.folders || [];
            s.rawFiles = data.files || [];
            s.files = this.#applyClientFilters(s.rawFiles);
            s.breadcrumb = data.breadcrumb || [];
            this.#sortFiles();
            this.#renderBreadcrumb();
            this.#renderGrid();
        } catch (e) {
            if (e.name === 'AbortError') return; // intentional cancellation
            this.#setStatus(_t('common.error') + ': ' + e.message);
        }
    }

    async #search(query) {
        // Temp root is not searchable
        if (this.#state.root === 'temp') {
            this.#el.resultCount.textContent = '';
            this.#renderSearchSummary('');
            this.#setStatus('Cannot search in Temp folder');
            return;
        }
        if (query.length < 2) {
            this.#el.resultCount.textContent = '';
            this.#renderSearchSummary('');
            if (this.#state.mode === 'search') this.#browse(this.#state.path);
            return;
        }
        const s = this.#state;
        s.mode = 'search'; s.query = query;
        this.#el.breadcrumb.classList.remove('hidden');
        this.#setStatusIcon(SEARCH_ICON, _t('common.loading'));
        this.#el.grid.innerHTML = '';
        this.#el.resultCount.textContent = '';
        this.#renderSearchSummary('');
        const indexStatus = await this.#refreshIndexStatus();
        if (indexStatus && !indexStatus.ready) {
            this.#renderSearchSummary(_t('gallery.searchIndexWaiting'));
        }
        try {
            const data = await this.#apiSearch(query, s.path);
            if (query !== this.#el.searchInput.value.trim()) return; // stale
            s.rawFiles = data.files || [];
            s.files = this.#applyClientFilters(s.rawFiles);
            s.folders = [];
            s.total = s.files.length;
            this.#sortFiles();
            const summary = _t('gallery.searchResults', { count: s.total.toLocaleString() });
            this.#el.resultCount.textContent = '';
            this.#renderSearchSummary(summary);
            this.#renderGrid();
        } catch (e) {
            if (e.name === 'AbortError') return; // intentional cancellation
            this.#setStatus(_t('common.error') + ': ' + e.message);
        }
    }

    /* ═══ Render ═══ */

    #renderBreadcrumb() {
        const list = this.#el.breadcrumbList;
        list.innerHTML = '';
        const crumbs = this.#state.breadcrumb;
        const rootLabel = (name) => {
            const s = String(name || '');
            if (s.toLowerCase() === 'outputs' || s.toLowerCase() === 'output') return 'Output';
            if (s.toLowerCase() === 'input') return 'Input';
            if (s.toLowerCase() === 'temp') return 'Temp';
            return s;
        };
        crumbs.forEach((c, i) => {
            const li = document.createElement('li');
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'gg-crumb-sep';
                sep.textContent = '›';
                li.appendChild(sep);
            }
            const btn = document.createElement('button');
            const isLast = i === crumbs.length - 1;
            btn.className = 'gg-crumb-link' + (isLast ? ' active' : '');
            btn.textContent = i === 0 ? rootLabel(c.name) : c.name;

            const targetPath = i === 0 ? '' : c.path;

            if (isLast) {
                // Current level: click/right-click/longpress → show sibling dropdown
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.#showSiblingDropdown(btn, targetPath);
                });
            } else {
                // Upper levels: click → navigate
                btn.addEventListener('click', () => this.#browse(c.path));
            }

            // All levels: right-click → dropdown
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.#showSiblingDropdown(btn, targetPath);
            });
            // All levels: long-press → dropdown
            this.#attachCrumbLongPress(btn, targetPath);

            li.appendChild(btn);
            list.appendChild(li);
        });
    }

    /** Attach long-press handler to a breadcrumb button for mobile */
    #attachCrumbLongPress(btn, path) {
        const LONG_PRESS_MS = 500;
        const MOVE_THRESHOLD = 6;
        let timer = null;
        let startX = 0, startY = 0;

        const onDown = (e) => {
            startX = e.touches?.[0]?.clientX ?? e.clientX;
            startY = e.touches?.[0]?.clientY ?? e.clientY;
            timer = setTimeout(() => {
                timer = null;
                e.preventDefault?.();
                this.#showSiblingDropdown(btn, path);
            }, LONG_PRESS_MS);
        };
        const onMove = (e) => {
            if (timer === null) return;
            const x = e.touches?.[0]?.clientX ?? e.clientX;
            const y = e.touches?.[0]?.clientY ?? e.clientY;
            if (Math.abs(x - startX) > MOVE_THRESHOLD || Math.abs(y - startY) > MOVE_THRESHOLD) {
                clearTimeout(timer);
                timer = null;
            }
        };
        const onUp = () => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
        };
        btn.addEventListener('pointerdown', onDown);
        btn.addEventListener('pointermove', onMove);
        btn.addEventListener('pointerup', onUp);
        btn.addEventListener('pointercancel', onUp);
    }

    /** Show a dropdown of sibling folders at the same level as `path` */
    static #ROOT_OPTIONS = [
        { key: 'output', label: 'Output' },
        { key: 'input', label: 'Input' },
        { key: 'temp', label: 'Temp' },
    ];

    async #showSiblingDropdown(anchorEl, path) {
        // Remove existing dropdown
        document.querySelector('.gg-crumb-dropdown')?.remove();

        const root = this.#getRoot();

        // Root level → show root switcher (Output / Input / Temp)
        if (path === '') {
            // In move mode, exclude temp from destinations
            const options = this.#state.moveMode
                ? GalleryGadget.#ROOT_OPTIONS.filter(o => o.key !== 'temp')
                : GalleryGadget.#ROOT_OPTIONS;
            const folders = options.map(o => ({
                name: o.label, path: '', _rootKey: o.key,
            }));
            const currentLabel = root === 'output' ? 'Output' : root === 'input' ? 'Input' : 'Temp';
            this.#buildDropdown(anchorEl, folders, currentLabel, (folder) => {
                this.#state.root = folder._rootKey;
                if (folder._rootKey === 'temp') {
                    this.#showTempWarning(() => this.#browse(''));
                } else {
                    this.#browse('');
                }
            });
            return;
        }

        try {
            const r = await fetch(`/drawer/fs/siblings?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
            const data = await r.json();
            if (!data.folders?.length) return;
            const currentName = path ? path.split('/').pop() : '';
            this.#buildDropdown(anchorEl, data.folders, currentName, (folder) => {
                this.#browse(folder.path);
            });
        } catch (e) {
            console.error('[Gallery] Failed to fetch siblings:', e);
        }
    }

    /** Show a one-time warning when entering the Temp root */
    async #showTempWarning(onProceed) {
        const LS_KEY = 'gallery-temp-warning-dismissed';
        if (localStorage.getItem(LS_KEY) === '1') {
            onProceed();
            return;
        }

        const showDialog = window.ComfyDrawer?.showDialog;
        if (!showDialog) {
            onProceed();
            return;
        }

        const result = await showDialog({
            title: 'Temp フォルダーについて',
            variant: 'warning',
            showCancel: false,
            confirmLabel: 'OK',
            content: (bodyEl) => {
                bodyEl.innerHTML = `
                    <p style="margin:0 0 8px">• Temp フォルダーの内容は <b>ComfyUI の再起動時に消去</b>されます。</p>
                    <p style="margin:0 0 16px">• Temp フォルダーは<b>検索インデックスの対象外</b>です。</p>
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--cd-text-dim)">
                        <input type="checkbox" id="gg-temp-warning-skip" style="accent-color:var(--cd-accent);width:16px;height:16px">
                        次回以降表示しない
                    </label>
                `;
                return () => ({ skip: bodyEl.querySelector('#gg-temp-warning-skip')?.checked ?? false });
            },
        });

        if (result?.skip) localStorage.setItem(LS_KEY, '1');
        onProceed();
    }

    /** Build and display a positioned dropdown list */
    #buildDropdown(anchorEl, items, currentName, onSelect) {
        const dropdown = document.createElement('div');
        dropdown.className = 'gg-crumb-dropdown';
        Object.assign(dropdown.style, {
            position: 'fixed',
            zIndex: '10000',
        });

        for (const folder of items) {
            const isCurrent = folder.name === currentName;
            const item = document.createElement('button');
            item.className = 'gg-crumb-dropdown-item' + (isCurrent ? ' current' : '');
            item.textContent = folder.name;
            item.addEventListener('click', () => {
                dropdown.remove();
                removeCloseHandler();
                onSelect(folder);
            });
            if (isCurrent) item.dataset.current = '1';
            dropdown.appendChild(item);
        }

        // Append to body first (hidden), measure, then position
        dropdown.style.visibility = 'hidden';
        document.body.appendChild(dropdown);

        const rect = anchorEl.getBoundingClientRect();
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const containerH = this.container?.offsetHeight || window.innerHeight;
        const maxH = Math.min(containerH * 0.4, Math.max(spaceAbove, spaceBelow) - 8);
        dropdown.style.maxHeight = maxH + 'px';

        const ddH = Math.min(dropdown.scrollHeight, maxH);
        let top;
        if (spaceAbove >= ddH || spaceAbove > spaceBelow) {
            top = rect.top - ddH - 4;
        } else {
            top = rect.bottom + 4;
        }
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
                removeCloseHandler();
            }
        };
        const removeCloseHandler = () => {
            document.removeEventListener('pointerdown', closeHandler, true);
        };
        setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
    }

    #renderGrid() {
        // Flush grid-scoped cleanups from previous render
        for (const fn of this.#gridCleanups) fn();
        this.#gridCleanups = [];

        const s = this.#state;
        const grid = this.#el.grid;
        grid.innerHTML = '';

        // Right-click on empty grid area → gallery-bg context menu (browse mode only)
        if (s.mode === 'browse' && !s.selectMode && !s.moveMode) {
            const bgHandler = (e) => {
                // Fire when clicking grid gaps or the content area below the grid
                if (e.target === grid || e.target === grid.parentElement) {
                    e.preventDefault();
                    this.#contextMenu?.show('gallery-bg', {}, e.clientX, e.clientY);
                }
            };
            grid.oncontextmenu = bgHandler;
            grid.parentElement.oncontextmenu = (e) => {
                if (e.target === grid.parentElement) bgHandler(e);
            };
        } else {
            grid.oncontextmenu = null;
            grid.parentElement.oncontextmenu = null;
        }

        const total = s.folders.length + s.files.length;
        if (total === 0) {
            if (s.mode === 'search') this.#setStatus(`No results for "${s.query}"`);
            else if (s.moveMode) this.#setStatus(_t('gallery.noImages'));
            else this.#setStatus(_t('gallery.noImages'));
            return;
        }
        this.#el.status.classList.add('hidden');

        const inSelectOrMove = s.selectMode || s.moveMode;

        // Folders
        for (const folder of s.folders) {
            const el = document.createElement('div');
            el.className = 'gg-folder-card';
            el.dataset.folderPath = folder.path;
            el.innerHTML = `<span class="gg-folder-icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg></span><div class="gg-folder-name">${escapeHTML(folder.name)}</div>`;

            if (s.selectMode && !s.moveMode) {
                // Selection mode: click toggles selection (replaces browse)
                el.classList.add('selectable');
                const check = document.createElement('div');
                check.className = 'gg-card-select-check';
                check.textContent = '✓';
                el.appendChild(check);
                if (s.selected.has(folder.path)) el.classList.add('selected');
                el.addEventListener('click', () => this.#toggleSelect(folder.path, el));
            } else if (s.moveMode && s.selected.has(folder.path)) {
                // Move mode: selected folder cannot be a destination — grey out with check
                el.classList.add('gg-move-disabled', 'gg-move-source');
                const check = document.createElement('div');
                check.className = 'gg-card-select-check';
                check.textContent = '✓';
                el.style.position = 'relative';
                el.appendChild(check);
            } else {
                // Normal browse or move-mode destination navigation
                el.addEventListener('click', () => this.#browse(folder.path));
            }

            // Context menu for folders (not in select/move mode)
            if (!inSelectOrMove) {
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.#contextMenu?.show('gallery-folder', { ...folder, source: 'gallery' }, e.clientX, e.clientY);
                });
                // Long-press to enter selection mode
                this.#attachLongPress(el, folder.path);
            }

            grid.appendChild(el);
        }

        // Files — build lightbox items list first for cross-referencing
        const lbItems = s.files.map(f => ({
            src: this.#imgUrl(f),
            type: f.type || 'image',
            label: f.name,
            details: `${this.#fmtDate(f.created)}   ${this.#fmtSize(f.size)}${f.subfolder ? `   ${f.subfolder}` : ''}`,
            data: f,
        }));


        for (let i = 0; i < s.files.length; i++) {
            const file = s.files[i];
            const url = this.#imgUrl(file);
            const isMedia = file.type === 'video' || file.type === 'audio';

            const mc = createMediaCard({
                src: url,
                filename: file.name,
                mediaType: file.type === 'image' ? 'image' : (file.type === 'video' ? 'video' : 'image'),
                thumbHeight: 140,
                lightbox: !inSelectOrMove,
                draggable: !inSelectOrMove,
                lightboxItems: lbItems,
                lightboxIndex: i,
                lightboxOptions: {
                    get autoplay() { return s.autoplay; },
                    contextMenuType: 'media-file',
                    contextMenuData: (item) => ({ ...item.data, src: item.src, source: 'gallery', hasWorkflow: item.hasWorkflow }),
                    onKey: (key, item) => {
                        if (key === 'Delete') {
                            this.#deleteCurrent(item?.data || null);
                        }
                    },
                    onClose: () => { this.#lbCurrentFile = null; },
                },
                onClick: s.selectMode ? () => this.#toggleSelect(file.path, mc.element) : null,
                onContextMenu: !inSelectOrMove ? (e) => {
                    this.#contextMenu?.show('media-file', { ...file, src: url, source: 'gallery', hasWorkflow: mc.element._hasWorkflow }, e.clientX, e.clientY);
                } : null,
                onFolderDrop: (!inSelectOrMove && this.#state.root !== 'temp') ? async (destPath) => {
                    try {
                        const root = this.#getRoot();
                        const srcSubfolder = file.subfolder || this.#state.path;
                        const res = await fetch('/drawer/fs/move', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                root,
                                srcRoot: root,
                                files: [{ subfolder: srcSubfolder, name: file.name }],
                                destSubfolder: destPath,
                                conflict: 'rename',
                            }),
                        });
                        const data = await res.json();
                        if (data.moved > 0) {
                            mc.element.remove();
                            this.#state.files = this.#state.files.filter(f => f.name !== file.name);
                            // Notify extensions (e.g. SavePlus sidecar move)
                            this.#emitFsMoved({
                                root,
                                files: [{
                                    name: file.name,
                                    subfolder: srcSubfolder,
                                    srcSubfolder,
                                    destSubfolder: destPath,
                                    from_subfolder: srcSubfolder,
                                    to_subfolder: destPath,
                                    newName: data.renamed?.[0]?.renamed || file.name,
                                    to_name: data.renamed?.[0]?.renamed || file.name,
                                }],
                            });
                            if (data.renamed?.length) {
                                this.#showToast(_t('gallery.renamedAndMoved', { name: data.renamed[0].renamed }));
                            }
                        }
                        if (data.errors?.length) console.warn('[Gallery] Move errors:', data.errors);
                    } catch (e) {
                        console.error('[Gallery] Move failed:', e);
                    }
                } : null,
            });

            // Audio: show icon placeholder (video uses native thumbnail via MediaCard)
            if (file.type === 'audio') {
                mc.thumb.style.display = 'none';
                const placeholder = document.createElement('div');
                placeholder.className = 'gg-audio-placeholder';
                placeholder.innerHTML = AUDIO_ICON_SVG;
                mc.thumb.parentElement.prepend(placeholder);
            }
            // Video: add small badge to indicate media type
            if (file.type === 'video') {
                const badge = document.createElement('div');
                badge.className = 'gg-video-badge';
                badge.innerHTML = VIDEO_ICON_SVG;
                mc.thumb.parentElement.appendChild(badge);
            }

            // Gallery-specific info
            let infoHtml = `<div class="gg-card-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>`;
            infoHtml += `<div class="gg-card-meta"><span>${this.#fmtDate(file.created)}</span><span>${this.#fmtSize(file.size)}</span></div>`;
            if (file.subfolder && s.mode === 'search') {
                infoHtml += `<span class="gg-card-folder">${escapeHTML(file.subfolder)}</span>`;
            }
            if (file.snippet && s.mode === 'search') {
                infoHtml += `<div class="gg-card-snippet">${this.#highlight(file.snippet, s.query)}</div>`;
            }
            mc.info.innerHTML = infoHtml;

            // Add gg-card class for Gallery-specific styling
            mc.element.classList.add('gg-card');

            // Move mode: grey out files (keep visible for scroll position)
            if (s.moveMode) {
                mc.element.classList.add('gg-move-disabled');
                // Show check mark on selected items so they're identifiable
                if (s.selected.has(file.path)) {
                    mc.element.classList.add('gg-move-source');
                    const check = document.createElement('div');
                    check.className = 'gg-card-select-check';
                    check.textContent = '✓';
                    mc.element.appendChild(check);
                }
            }

            // Selection mode: check marks + click to toggle
            if (s.selectMode && !s.moveMode) {
                mc.element.classList.add('selectable');
                const check = document.createElement('div');
                check.className = 'gg-card-select-check';
                check.textContent = '✓';
                mc.element.appendChild(check);
                if (s.selected.has(file.path)) mc.element.classList.add('selected');
            }

            // PC long-press to enter selection mode (500ms, cancelled by drag threshold)
            if (!inSelectOrMove) {
                this.#attachLongPress(mc.element, file.path);
            }

            grid.appendChild(mc.element);
        }
    }

    /**
     * Attach a PC long-press (500ms mousedown) trigger to enter selection mode.
     * Cancelled if mouse moves > 6px (D&D would start) or mouseup fires first.
     * Registered in #gridCleanups for automatic teardown on re-render.
     */
    #attachLongPress(cardEl, filePath) {
        const LONG_PRESS_MS = 500;
        const MOVE_THRESHOLD = 6;
        let timer = null;
        let startX = 0, startY = 0;

        const onDown = (e) => {
            if (e.button !== 0) return; // left-click only
            startX = e.clientX;
            startY = e.clientY;
            timer = setTimeout(() => {
                timer = null;
                this.#enterSelectMode(filePath);
            }, LONG_PRESS_MS);

            const onMove = (mv) => {
                if (timer === null) return;
                const dx = mv.clientX - startX;
                const dy = mv.clientY - startY;
                if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
                    clearTimeout(timer);
                    timer = null;
                    cleanup();
                }
            };
            const onUp = () => {
                if (timer !== null) { clearTimeout(timer); timer = null; }
                cleanup();
            };
            const cleanup = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        cardEl.addEventListener('mousedown', onDown);
        this.#gridCleanups.push(() => {
            cardEl.removeEventListener('mousedown', onDown);
            if (timer !== null) { clearTimeout(timer); timer = null; }
        });
    }

    /* ═══ Lightbox (delegated to shared lightbox.js) ═══ */

    #openGalleryLightbox(file) {
        const startIdx = this.#state.files.indexOf(file);
        const lbItems = this.#state.files.map(f => ({
            src: this.#imgUrl(f),
            type: f.type || 'image',
            label: f.name,
            details: `${this.#fmtDate(f.created)}   ${this.#fmtSize(f.size)}${f.subfolder ? `   ${f.subfolder}` : ''}`,
            data: f,
        }));

        this.#lbCurrentFile = file;

        openLightbox(lbItems, startIdx, {
            autoplay: this.#state.autoplay,
            contextMenuType: 'media-file',
            contextMenuData: (item) => ({ ...item.data, src: item.src, source: 'gallery' }),
            onKey: (key, item) => {
                if (key === 'Delete') {
                    this.#deleteCurrent(item?.data || null);
                }
            },
            onClose: () => {
                this.#lbCurrentFile = null;
            },
        });
    }

    /** Open any file in a new browser tab */
    #openFileNewTab(file) {
        const url = file.src || this.#imgUrl(file);
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    /* ═══ Helpers ═══ */

    /** Get the current root name ('output'|'input'|'temp') from breadcrumb */
    #getRoot() {
        return this.#state.root || 'output';
    }

    /** Parse a path into { subfolder, name } */
    #parsePath(path) {
        const lastSlash = path.lastIndexOf('/');
        return {
            subfolder: lastSlash >= 0 ? path.substring(0, lastSlash) : '',
            name: lastSlash >= 0 ? path.substring(lastSlash + 1) : path,
        };
    }

    /* ═══ Context Menu ═══ */

    #registerContextActions() {
        if (!this.#contextMenu) return;

        // Gallery-specific actions only.
        // Shared actions (open-tab, send, workflow, download) are registered
        // at the platform level in comfy-drawer.js.
        this.#contextMenu.register('media-file', [
            {
                id: 'gallery:rename',
                label: _t('common.rename'),
                icon: 'edit',
                order: 35,
                visible: (ctx) => ctx.source === 'gallery',
                action: (ctx) => this.#ctxRenameFile(ctx),
            },
            {
                id: 'gallery:select',
                label: _t('gallery.select'),
                icon: 'select',
                order: 40,
                visible: (ctx) => ctx.source === 'gallery' && !this.#state.selectMode,
                action: (ctx) => this.#enterSelectMode(ctx.path),
            },
            {
                id: 'gallery:delete',
                label: _t('common.delete'),
                icon: 'trash',
                order: 100,
                danger: true,
                visible: (ctx) => ctx.source === 'gallery',
                action: (ctx) => this.#ctxDeleteFile(ctx),
            },
        ]);

        // Folder context menu
        this.#contextMenu.register('gallery-folder', [
            {
                id: 'gallery:folder-rename',
                label: _t('common.rename'),
                icon: 'edit',
                order: 5,
                action: (ctx) => this.#ctxRenameFolder(ctx),
            },
            {
                id: 'gallery:folder-select',
                label: _t('gallery.select'),
                icon: 'select',
                order: 10,
                visible: () => !this.#state.selectMode,
                action: (ctx) => this.#enterSelectMode(ctx.path),
            },
            {
                id: 'gallery:folder-mkdir',
                label: _t('modelviewer.newFolder'),
                icon: 'folder-plus',
                order: 50,
                visible: () => this.#state.root !== 'temp',
                action: (ctx) => this.#ctxMkdir(ctx.path),
            },
            {
                id: 'gallery:folder-delete',
                label: _t('common.delete'),
                icon: 'trash',
                order: 100,
                danger: true,
                action: (ctx) => this.#ctxDeleteFolder(ctx),
            },
        ]);

        // Background (empty area) context menu
        this.#contextMenu.register('gallery-bg', [
            {
                id: 'gallery:bg-mkdir',
                label: _t('modelviewer.newFolder'),
                icon: 'folder-plus',
                order: 10,
                visible: () => this.#state.root !== 'temp',
                action: () => this.#ctxMkdir(this.#state.path),
            },
        ]);
    }

    #emitFsMoved({ root, srcRoot = root, files = [] }) {
        if (!files.length) return;
        window.ComfyDrawer?.bus?.emit('fs:moved', { root, srcRoot, files });
    }

    #emitFsRenamed({ root, subfolder = '', oldName, newName, isFolder = false }) {
        if (!oldName || !newName) return;
        const file = {
            name: oldName,
            newName,
            oldName,
            subfolder,
            srcSubfolder: subfolder,
            destSubfolder: subfolder,
            from_subfolder: subfolder,
            to_subfolder: subfolder,
            from_name: oldName,
            to_name: newName,
            isFolder,
        };
        window.ComfyDrawer?.bus?.emit('fs:renamed', {
            root,
            subfolder,
            oldName,
            newName,
            isFolder,
            files: [file],
        });
        this.#emitFsMoved({ root, files: [file] });
    }

    #emitFsDeleted({ root, files = [], deleted = 0, deletedFolders = 0 }) {
        if (!deleted && !deletedFolders) return;
        window.ComfyDrawer?.bus?.emit('fs:deleted', {
            root,
            files,
            deleted,
            deletedFolders,
        });
    }

    #emitFsCreated({ root, subfolder = '', name, path, isFolder = false }) {
        if (!name && !path) return;
        window.ComfyDrawer?.bus?.emit('fs:created', {
            root,
            subfolder,
            name,
            path,
            isFolder,
        });
    }

    async #promptRenameFile(file) {
        const showDialog = window.ComfyDrawer?.showDialog;
        if (!showDialog) return null;
        const dotIdx = file.name.lastIndexOf('.');
        const baseName = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name;
        const extName = dotIdx > 0 ? file.name.slice(dotIdx) : '';

        return showDialog({
            title: _t('common.rename'),
            variant: 'prompt',
            confirmLabel: _t('common.rename'),
            cancelLabel: _t('common.cancel'),
            content: (body) => {
                const form = document.createElement('div');
                form.className = 'cd-rename-file-form';
                form.innerHTML = `
                    <label class="cd-rename-file-field cd-rename-file-name">
                        <span>${escapeHTML(_t('gallery.filenameStem'))}</span>
                        <input class="cd-dialog-input" type="text" value="${escapeHTML(baseName)}" />
                    </label>
                    <span class="cd-rename-file-ext">${escapeHTML(extName)}</span>
                `;
                body.appendChild(form);
                const nameInput = form.querySelector('.cd-rename-file-name input');
                setTimeout(() => {
                    nameInput?.focus();
                    nameInput?.select();
                }, 0);
                return () => {
                    const name = (nameInput?.value || '').trim();
                    return { name, finalName: `${name}${extName}` };
                };
            },
            onValidate: ({ name }) => {
                if (!name) return _t('gallery.filenameRequired');
                if (/[\\/]/.test(name)) return _t('gallery.invalidFilename');
                return null;
            },
        });
    }

    /** Context-menu action: rename a file */
    async #ctxRenameFile(file) {
        const result = await this.#promptRenameFile(file);
        const finalName = result?.finalName;
        if (!finalName || finalName === file.name) return;
        const root = this.#getRoot();
        const subfolder = file.subfolder || this.#state.path;
        try {
            const r = await fetch('/drawer/fs/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root, subfolder, oldName: file.name, newName: finalName }),
            });
            const data = await r.json();
            if (data.error) {
                this.#showToast(_t('common.error') + ': ' + data.error);
            } else if (data.renamed) {
                this.#emitFsRenamed({ root, subfolder, oldName: file.name, newName: finalName, isFolder: false });
                this.#showToast(_t('common.done'));
                this.#browse(this.#state.path);
            }
        } catch (e) {
            this.#showToast(_t('common.error') + ': ' + e.message);
        }
    }

    /** Context-menu action: rename a folder */
    async #ctxRenameFolder(folder) {
        const showPrompt = window.ComfyDrawer?.showPrompt;
        if (!showPrompt) return;
        const { subfolder, name } = this.#parsePath(folder.path);
        const newName = await showPrompt(_t('gallery.newFolderNamePrompt'), {
            defaultValue: folder.name,
            title: _t('common.rename'),
        });
        if (!newName || newName === name) return;
        const root = this.#getRoot();
        try {
            const r = await fetch('/drawer/fs/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root, subfolder, oldName: name, newName }),
            });
            const data = await r.json();
            if (data.error) {
                this.#showToast(_t('common.error') + ': ' + data.error);
            } else if (data.renamed) {
                this.#emitFsRenamed({ root, subfolder, oldName: name, newName, isFolder: true });
                this.#showToast(_t('common.done'));
                this.#browse(this.#state.path);
            }
        } catch (e) {
            this.#showToast(_t('common.error') + ': ' + e.message);
        }
    }

    /** Context-menu action: create a new folder */
    async #ctxMkdir(parentPath) {
        const showPrompt = window.ComfyDrawer?.showPrompt;
        if (!showPrompt) return;
        let errorHint = '';
        while (true) {
            const name = await showPrompt(errorHint || _t('gallery.folderNamePrompt'), {
                title: _t('modelviewer.newFolder'),
                placeholder: _t('gallery.newFolder'),
            });
            if (!name) return;  // cancelled
            const root = this.#getRoot();
            try {
                const r = await fetch('/drawer/fs/mkdir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ root, subfolder: parentPath, name }),
                });
                const data = await r.json();
                if (r.status === 409) {
                    // Folder already exists — re-prompt with hint
                    errorHint = _t('gallery.folderExistsPrompt', { name });
                    continue;
                }
                if (data.error) {
                    this.#showToast(_t('common.error') + ': ' + data.error);
                    return;
                }
                this.#emitFsCreated({
                    root,
                    subfolder: parentPath,
                    name,
                    path: data.path || [parentPath, name].filter(Boolean).join('/'),
                    isFolder: true,
                });
                this.#showToast(_t('common.done'));
                this.#browse(this.#state.path);
                return;
            } catch (e) {
                this.#showToast(_t('common.error') + ': ' + e.message);
                return;
            }
        }
    }

    /** Context-menu action: delete a folder (with contents) */
    async #ctxDeleteFolder(folder) {
        const showConfirmFn = window.ComfyDrawer?.showConfirm;
        let confirmed = false;
        if (showConfirmFn) {
            confirmed = await showConfirmFn(_t('gallery.deleteFolderConfirm', { name: folder.name }), {
                title: _t('common.delete'),
                danger: true,
            });
        }
        if (!confirmed) return;

        const root = this.#getRoot();
        const { subfolder, name } = this.#parsePath(folder.path);

        try {
            const r = await fetch('/drawer/fs/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root, files: [{ subfolder, name }] }),
            });
            const data = await r.json();
            if (data.deleted_folders > 0) {
                this.#emitFsDeleted({
                    root,
                    files: [{ subfolder, name, isFolder: true }],
                    deletedFolders: data.deleted_folders,
                });
                this.#showToast(_t('common.done'));
                this.#browse(this.#state.path);
            } else {
                this.#showToast(_t('common.error'));
            }
        } catch (e) {
            this.#showToast(e.message);
        }
    }

    /** Context-menu action: delete a single file (lightbox-aware) */
    async #ctxDeleteFile(file) {
        // If lightbox is open, keep it in sync by removing the deleted item.
        if (isLightboxOpen() && this.#lbCurrentFile) {
            return this.#deleteCurrent(file);
        }
        const ok = await (window.ComfyDrawer?.showConfirm?.(_t('gallery.deleteConfirmSingle', { name: file.name }), { danger: true })
            ?? Promise.resolve(false));
        if (!ok) return;
        try {
            const result = await this.#deleteFiles([file]);
            if (result.deleted > 0) {
                this.#showToast(_t('gallery.deletedSingle', { name: file.name }));
                if (this.#state.mode === 'search') this.#search(this.#state.query);
                else this.#browse(this.#state.path);
            }
        } catch (e) {
            this.#showToast(e.message);
        }
    }

    /* ═══ Selection Mode ═══ */

    /**
     * Enter selection mode, optionally selecting an initial item.
     * @param {string} [initialKey] - file/folder path to pre-select
     */
    #enterSelectMode(initialKey) {
        if (this.#state.selectMode) return;
        this.#state.selectMode = true;
        this.#state.selected.clear();
        if (initialKey) this.#state.selected.add(initialKey);
        this.#showToolbar('select');
        this.#updateSelCount();
        this.#renderGrid();
    }

    #toggleSelect(fileKey, el) {
        if (this.#state.selected.has(fileKey)) {
            this.#state.selected.delete(fileKey);
            el.classList.remove('selected');
        } else {
            this.#state.selected.add(fileKey);
            el.classList.add('selected');
        }
        this.#updateSelCount();
    }

    #updateSelCount() {
        const count = this.#state.selected.size;
        this.#el.selCount.textContent = _t('common.itemsShort', { count });
        // Disable move/delete when nothing selected
        this.#el.selMove.disabled = count === 0;
        this.#el.selDelete.disabled = count === 0;
        // Update select-all button label
        const totalItems = this.#state.folders.length + this.#state.files.length;
        this.#el.selAll.textContent = (count > 0 && count >= totalItems) ? _t('gallery.deselectAll') : _t('gallery.selectAll');
        // Auto-exit selection mode if all items deselected
        if (count === 0 && this.#state.selectMode) {
            this.#exitSelectMode();
        }
    }

    #exitSelectMode() {
        this.#state.selectMode = false;
        this.#state.moveMode = false;
        this.#state.selected.clear();
        this.#showToolbar('browse');
        this.#renderGrid();
    }

    #selectAll() {
        const s = this.#state;
        const allKeys = [
            ...s.folders.map(f => f.path),
            ...s.files.map(f => f.path),
        ];
        const allSelected = allKeys.length > 0 && allKeys.every(k => s.selected.has(k));

        if (allSelected) {
            // Toggle off — deselect all (will auto-exit via #updateSelCount)
            s.selected.clear();
        } else {
            // Select all
            for (const key of allKeys) s.selected.add(key);
        }
        this.#updateSelCount();
        this.#renderGrid();
    }

    /**
     * Switch visible toolbar section.
     * @param {'browse'|'select'|'move'} mode
     */
    #showToolbar(mode) {
        this.#el.toolbarBrowse.hidden = mode !== 'browse';
        this.#el.toolbarSelect.hidden = mode !== 'select';
        this.#el.toolbarMove.hidden = mode !== 'move';
    }

    /* ═══ Move Mode (Phase 3) ═══ */

    #enterMoveMode() {
        if (this.#state.selected.size === 0) return;
        const wasSearching = this.#state.mode === 'search';
        this.#state.moveMode = true;
        this.#state.moveSrcPath = this.#state.path;
        this.#state.moveSrcRoot = this.#state.root;
        this.#state.mode = 'browse';
        this.#closeSearch();
        // When moving FROM temp, switch to output as default destination
        if (this.#state.root === 'temp') {
            this.#state.root = 'output';
            this.#showToolbar('move');
            this.#browse('');
        } else if (wasSearching) {
            this.#showToolbar('move');
            this.#browse(this.#state.path);
        } else {
            this.#showToolbar('move');
            this.#renderGrid();
        }
    }

    #exitMoveMode() {
        this.#state.moveMode = false;
        // Return to source root and path
        const srcRoot = this.#state.moveSrcRoot || this.#state.root;
        const needsReturn = this.#state.path !== this.#state.moveSrcPath || this.#state.root !== srcRoot;
        this.#state.root = srcRoot;
        this.#showToolbar('select');
        if (needsReturn) {
            this.#browse(this.#state.moveSrcPath);
        } else {
            this.#renderGrid();
        }
    }

    async #executeMove() {
        const s = this.#state;
        if (s.selected.size === 0) return;

        const destRoot = this.#getRoot();
        const srcRoot = s.moveSrcRoot || destRoot;
        const destSubfolder = s.path;

        // Build file list from selected paths
        const filesToMove = [];
        for (const key of s.selected) {
            const { subfolder, name } = this.#parsePath(key);
            filesToMove.push({ subfolder, name });
        }

        // First attempt with conflict=skip
        try {
            const res = await fetch('/drawer/fs/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root: destRoot, srcRoot, files: filesToMove, destSubfolder, conflict: 'skip' }),
            });
            const data = await res.json();

            if (data.moved > 0) {
                const renameByName = new Map((data.renamed || []).map(r => [r.original, r.renamed]));
                this.#emitFsMoved({
                    root: destRoot,
                    srcRoot,
                    files: filesToMove.map(f => ({
                        ...f,
                        srcSubfolder: f.subfolder,
                        destSubfolder,
                        from_subfolder: f.subfolder,
                        to_subfolder: destSubfolder,
                        newName: renameByName.get(f.name) || f.name,
                        to_name: renameByName.get(f.name) || f.name,
                    })),
                });
            }

            // If some files were skipped due to conflicts, ask user
            if (data.skipped > 0) {
                const showDialog = window.ComfyDrawer?.showDialog;
                if (showDialog) {
                    const choice = await showDialog({
                        title: _t('gallery.conflictTitle'),
                        message: _t('gallery.conflictMessage', { count: data.skipped }),
                        confirmLabel: _t('gallery.renameAndMove'),
                        cancelLabel: _t('gallery.skip'),
                        showCancel: true,
                        content: (body) => {
                            const btnRow = document.createElement('div');
                            btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
                            const overwriteBtn = document.createElement('button');
                            overwriteBtn.className = 'cd-dialog-btn cd-dialog-btn-danger';
                            overwriteBtn.textContent = _t('gallery.mergeOverwrite');
                            overwriteBtn.title = _t('gallery.mergeOverwriteHint');
                            overwriteBtn.addEventListener('click', () => {
                                body._choice = 'overwrite';
                                body.closest('.cd-dialog')?.querySelector('.cd-dialog-btn-primary')?.click();
                            });
                            btnRow.appendChild(overwriteBtn);
                            body.appendChild(btnRow);
                            return () => body._choice || 'rename';
                        },
                    });

                    if (choice && choice !== null) {
                        // Re-send only the skipped files with the chosen conflict strategy
                        const res2 = await fetch('/drawer/fs/move', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ root: destRoot, srcRoot, files: filesToMove, destSubfolder, conflict: choice }),
                        });
                        const data2 = await res2.json();
                        if (data2.moved > 0) {
                            const renameByName = new Map((data2.renamed || []).map(r => [r.original, r.renamed]));
                            this.#emitFsMoved({
                                root: destRoot,
                                srcRoot,
                                files: filesToMove.map(f => ({
                                    ...f,
                                    srcSubfolder: f.subfolder,
                                    destSubfolder,
                                    from_subfolder: f.subfolder,
                                    to_subfolder: destSubfolder,
                                    newName: renameByName.get(f.name) || f.name,
                                    to_name: renameByName.get(f.name) || f.name,
                                })),
                            });
                            this.#showToast(_t('gallery.itemsMoved', { count: data.moved + data2.moved }));
                        }
                        if (data2.errors?.length) {
                            console.warn('[Gallery] Move errors:', data2.errors);
                        }
                    } else {
                        if (data.moved > 0) {
                            this.#showToast(_t('gallery.movedSkipped', { moved: data.moved, skipped: data.skipped }));
                        } else {
                            this.#showToast(_t('gallery.itemsSkipped', { count: data.skipped }));
                        }
                    }
                } else {
                    this.#showToast(_t('gallery.movedSkipped', { moved: data.moved, skipped: data.skipped }));
                }
            } else if (data.moved > 0) {
                this.#showToast(_t('gallery.itemsMoved', { count: data.moved }));
            }

            if (data.errors?.length) {
                console.warn('[Gallery] Move errors:', data.errors);
                this.#showToast(_t('gallery.errorsCount', { count: data.errors.length }));
            }
        } catch (e) {
            console.error('[Gallery] Move failed:', e);
            this.#showToast(_t('common.error') + ': ' + e.message);
        }

        // Stay at move destination and exit selection
        this.#state.moveMode = false;
        this.#state.moveSrcRoot = '';
        this.#state.selectMode = false;
        this.#state.selected.clear();
        this.#showToolbar('browse');
        this.#browse(this.#state.path);
    }

    /* ═══ Delete ═══ */

    async #deleteFiles(files) {
        const root = this.#getRoot();
        const payloadFiles = files.map(f => ({
            subfolder: f.subfolder || '',
            name: f.name,
            isFolder: !!f.isFolder,
        }));
        const r = await fetch('/drawer/fs/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root, files: payloadFiles.map(f => ({ subfolder: f.subfolder, name: f.name })) }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
        const result = await r.json();
        const deletedFiles = (result.deleted_files || []).map(f => ({ ...f, isFolder: false }));
        const deletedFolders = (result.deleted_folder_items || []).map(f => ({ ...f, isFolder: true }));
        const eventFiles = deletedFiles.length || deletedFolders.length
            ? [...deletedFiles, ...deletedFolders]
            : payloadFiles;
        this.#emitFsDeleted({
            root,
            files: eventFiles,
            deleted: result.deleted || 0,
            deletedFolders: result.deleted_folders || 0,
        });
        return result;
    }

    async #deleteSelected() {
        const count = this.#state.selected.size;
        if (count === 0) return;

        // Use DialogService confirm if available, fallback to native
        const showConfirmFn = window.ComfyDrawer?.showConfirm;
        let confirmed = false;
        const msg = _t('gallery.deleteSelectedConfirm', { count });
        if (showConfirmFn) {
            confirmed = await showConfirmFn(msg, { title: _t('common.delete'), danger: true });
        }
        if (!confirmed) return;

        // Collect selected files AND folders
        const itemsToDelete = [];
        // Files
        for (const f of this.#state.files) {
            if (this.#state.selected.has(f.path)) {
                itemsToDelete.push({ subfolder: f.subfolder || '', name: f.name });
            }
        }
        // Folders
        for (const folder of this.#state.folders) {
            if (this.#state.selected.has(folder.path)) {
                const lastSlash = folder.path.lastIndexOf('/');
                const subfolder = lastSlash >= 0 ? folder.path.substring(0, lastSlash) : '';
                const name = lastSlash >= 0 ? folder.path.substring(lastSlash + 1) : folder.path;
                itemsToDelete.push({ subfolder, name, isFolder: true });
            }
        }

        try {
            const result = await this.#deleteFiles(itemsToDelete);
            const parts = [];
            if (result.deleted > 0) parts.push(_t('gallery.filesCount', { count: result.deleted }));
            if (result.deleted_folders > 0) parts.push(_t('gallery.foldersCount', { count: result.deleted_folders }));
            this.#showToast(_t('gallery.deletedItems', { items: parts.join(' / ') }));
        } catch (e) {
            this.#showToast(e.message);
        }
        // Exit select mode and refresh (without double-rendering)
        this.#state.selectMode = false;
        this.#state.moveMode = false;
        this.#state.selected.clear();
        this.#showToolbar('browse');
        if (this.#state.mode === 'search') this.#search(this.#state.query);
        else this.#browse(this.#state.path);
    }

    async #deleteCurrent(file = null) {
        const targetFile = file || this.#lbCurrentFile;
        if (!targetFile) return;
        const lightboxIndex = isLightboxOpen() ? getLightboxIndex() : -1;
        const ok = await (window.ComfyDrawer?.showConfirm?.(_t('gallery.deleteConfirmSingle', { name: targetFile.name }), { danger: true })
            ?? Promise.resolve(false));
        if (!ok) return;
        try {
            const result = await this.#deleteFiles([targetFile]);
            if (result.deleted > 0) {
                this.#showToast(_t('gallery.deletedSingle', { name: targetFile.name }));
                if (lightboxIndex >= 0) {
                    removeLightboxItem(lightboxIndex);
                }
                this.#lbCurrentFile = null;
                // Refresh file list from server
                if (this.#state.mode === 'search') this.#search(this.#state.query);
                else this.#browse(this.#state.path);
            }
        } catch (e) {
            this.#showToast(e.message);
        }
    }
}
