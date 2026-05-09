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
const DEBUG_INDEX_STATUS_KEY = 'gallery-debug-index-status';
const INDEX_NOTICE_DISMISSED_KEY = 'gallery-index-notice-dismissed';
const SEARCH_SCOPES_KEY = 'gallery-search-scopes';
const SEARCH_SCOPE_VALUES = ['name', 'prompt_title', 'prompt_value', 'workflow_title', 'workflow_value', 'custom'];
const DEFAULT_SEARCH_SCOPES = ['name', 'prompt_value', 'workflow_value', 'custom'];
const INDEX_SEARCH_SCOPES = ['prompt_title', 'prompt_value', 'workflow_title', 'workflow_value', 'custom'];
const SEARCH_PAGE_SIZE = window.matchMedia?.('(max-width: 700px), (pointer: coarse)')?.matches ? 60 : 160;
const BROWSE_PAGE_SIZE = SEARCH_PAGE_SIZE;
const THUMB_WARM_BATCH_SIZE = window.matchMedia?.('(max-width: 700px), (pointer: coarse)')?.matches ? 3 : 5;

function loadSearchScopes() {
    const raw = localStorage.getItem(SEARCH_SCOPES_KEY);
    const scopes = (raw || DEFAULT_SEARCH_SCOPES.join(','))
        .split(',')
        .map(s => s.trim())
        .map(s => {
            if (s === 'prompt') return 'prompt_title';
            if (s === 'value' || s === 'workflow') return 'prompt_value';
            if (s === 'metadata') return 'custom';
            return s;
        })
        .filter(s => SEARCH_SCOPE_VALUES.includes(s));
    if (raw === 'name,prompt_value' || raw === 'name,prompt_value,workflow_value') return [...DEFAULT_SEARCH_SCOPES];
    return scopes.length ? scopes : [...DEFAULT_SEARCH_SCOPES];
}

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
        searchScopes: loadSearchScopes(),
        dateFrom: '',
        dateTo: '',
        minSizeMB: '',
        maxSizeMB: '',
        indexStatus: null,
        hasCustomMetadata: false,
        searchHasMore: false,
        searchOffset: 0,
        searchLoadingMore: false,
        browseHasMore: false,
        browseOffset: 0,
        browseLoadingMore: false,
        browseVisibleCount: BROWSE_PAGE_SIZE,
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
    #indexPollTimer = null;
    #indexUiTimer = null;
    #indexEtaText = '';
    #indexEtaTextUpdatedAt = 0;
    #requestSeq = 0;
    #initialized = false;
    #generatedFiles = new Map();
    #generationRefreshTimer = null;
    #thumbWarmTimer = null;
    #thumbWarmToken = 0;
    #initialBrowseTimer = null;
    #initialLoadComplete = false;

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
        this.#setInitialLoading(true);
        this.#bindEvents();

        // Attach dictionary autocomplete to search input (space-separated for search)
        this.addDisposable(attachDictAutocomplete(window.ComfyDrawer.dict, this.#el.searchInput, { separator: ' ', context: 'search' }));

        // Register context menu actions for gallery files
        this.#contextMenu = window.ComfyDrawer?.contextMenu ?? null;
        this.#registerContextActions();

        this.#attachSwipe();

        // Track generated outputs per node, then update Gallery once the queue item succeeds.
        this.addDisposable(bus.on('comfy:executed', (detail) => {
            for (const file of this.#extractGeneratedFiles(detail)) {
                const key = `${file.root}\n${file.subfolder}\n${file.name}`;
                this.#generatedFiles.set(key, file);
            }
        }));
        this.addDisposable(bus.on('comfy:execution-success', () => {
            this.#scheduleGeneratedFilesUpdate();
        }));
        this.addDisposable(bus.on('comfy:execution-error', () => {
            this.#generatedFiles.clear();
        }));
        this.addDisposable(() => {
            clearTimeout(this.#generationRefreshTimer);
            this.#generationRefreshTimer = null;
            clearTimeout(this.#initialBrowseTimer);
            this.#initialBrowseTimer = null;
            this.#cancelThumbWarm();
        });
        this.addDisposable(bus.on('drawer:cache-cleared', (data) => {
            if (!data?.indexCleared) return;
            localStorage.removeItem(INDEX_NOTICE_DISMISSED_KEY);
            this.#state.indexStatus = { state: 'cleared', ready: false, building: false, cleared: true };
            this.#renderIndexStatus(this.#state.indexStatus);
            this.#refreshIndexStatus();
        }));
        this.addDisposable(bus.on('drawer:index-build-started', (status) => {
            this.#state.indexStatus = status || { ready: false, building: true };
            this.#renderIndexStatus(this.#state.indexStatus);
            this.#refreshIndexStatus();
        }));
    }

    onActivate() {
        if (!this.#initialized) {
            this.#initialized = true;
            this.#setInitialLoading(true);
            this.#browse('');
            return;
        }
        // Refresh on tab switch — but only if data is stale (>5s since last fetch)
        const STALE_MS = 5000;
        if (this.#state.mode === 'browse' && (Date.now() - this.#lastFetchTime > STALE_MS)) {
            this.#browse(this.#state.path);
        }
    }

    onDeactivate() {
        if (this.#el.scopeMenu) this.#el.scopeMenu.hidden = true;
        this.#el.scopeTrigger?.classList.remove('active');
    }

    onGraphChanged() {
        if (!this.#initialized) return;
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
        if (this.#indexPollTimer) {
            clearTimeout(this.#indexPollTimer);
            this.#indexPollTimer = null;
        }
        this.#stopIndexUiTicker();
        clearTimeout(this.#initialBrowseTimer);
        this.#initialBrowseTimer = null;
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
                        <input type="search" class="gg-search-input" placeholder="${_t('gallery.search')}" title="${_t('gallery.searchHelp')}" enterkeyhint="search" autocomplete="off" spellcheck="false"/>
                        <span class="gg-result-count"></span>
                        <button class="gg-clear-btn" hidden>${X_ICON_SVG}</button>
                        <button class="gg-search-submit" title="${_t('gallery.search')}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                            </svg>
                        </button>
                    </div>
                    <div class="gg-index-status gg-index-status-browse" hidden></div>
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
                        <div class="gg-index-status gg-index-status-search" hidden></div>
                        <select class="gg-sort-select gg-search-sort-select" title="${_t('common.sort')}">
                            <option value="name-asc">${_t('gallery.sortName')} ↑</option>
                            <option value="name-desc">${_t('gallery.sortName')} ↓</option>
                            <option value="date-asc">${_t('gallery.sortDate')} ↑</option>
                            <option value="date-desc">${_t('gallery.sortDate')} ↓</option>
                            <option value="size-asc">${_t('gallery.sortSize')} ↑</option>
                            <option value="size-desc">${_t('gallery.sortSize')} ↓</option>
                        </select>
                        <div class="gg-scope-wrap">
                            <button class="gg-scope-trigger" title="${_t('gallery.searchScope')}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
                                </svg>
                            </button>
                            <div class="gg-scope-menu" hidden>
                                <div class="gg-filter-section gg-scope-section">
                                    <div class="gg-filter-headline">
                                        <div class="gg-filter-heading">${_t('gallery.searchScope')}</div>
                                        <button class="gg-filter-clear" type="button">${_t('common.clear')}</button>
                                    </div>
                                    <label class="gg-scope-option" data-value="name">
                                        <input type="checkbox" value="name" />
                                        <span>${_t('gallery.scopeFilename')}</span>
                                    </label>
                                    <div class="gg-scope-group">
                                        <label class="gg-scope-option gg-scope-parent" data-group="prompt">
                                            <input type="checkbox" value="prompt" />
                                            <span>${_t('gallery.scopePrompt')}</span>
                                        </label>
                                        <div class="gg-scope-children">
                                            <label class="gg-scope-option" data-value="prompt_title">
                                                <input type="checkbox" value="prompt_title" />
                                                <span>${_t('gallery.scopeTitle')}</span>
                                            </label>
                                            <label class="gg-scope-option" data-value="prompt_value">
                                                <input type="checkbox" value="prompt_value" />
                                                <span>${_t('gallery.scopeValue')}</span>
                                            </label>
                                        </div>
                                    </div>
                                    <div class="gg-scope-group">
                                        <label class="gg-scope-option gg-scope-parent" data-group="workflow">
                                            <input type="checkbox" value="workflow" />
                                            <span>${_t('gallery.scopeWorkflow')}</span>
                                        </label>
                                        <div class="gg-scope-children">
                                            <label class="gg-scope-option" data-value="workflow_title">
                                                <input type="checkbox" value="workflow_title" />
                                                <span>${_t('gallery.scopeTitle')}</span>
                                            </label>
                                            <label class="gg-scope-option" data-value="workflow_value">
                                                <input type="checkbox" value="workflow_value" />
                                                <span>${_t('gallery.scopeValue')}</span>
                                            </label>
                                        </div>
                                    </div>
                                    <label class="gg-scope-option gg-scope-custom" data-value="custom" hidden>
                                        <input type="checkbox" value="custom" />
                                        <span>${_t('gallery.scopeCustomMetadata')}</span>
                                    </label>
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

            <div class="gg-index-strip" hidden></div>
            <nav class="gg-breadcrumb">
                <ol class="gg-breadcrumb-list"></ol>
            </nav>

            <div class="gg-content">
                <div class="gg-grid"></div>
                <div class="gg-status hidden"></div>
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
            scopeSection: q('.gg-scope-section'),
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
            indexStatusBrowse: q('.gg-index-status-browse'),
            indexStatusSearch: q('.gg-index-status-search'),
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
            indexStrip: q('.gg-index-strip'),
            searchSummary: q('.gg-search-summary'),
            grid: q('.gg-grid'),
            status: q('.gg-status'),
        };

        this.#el.sortSelect.value = this.#state.sort;
        this.#el.searchSortSelect.value = this.#state.sort;
        if (this.#state.autoplay) this.#el.autoplayToggle.classList.add('active');
        this.#syncSearchScopeChecks();
    }

    /* ═══ Event Binding ═══ */

    #bindEvents() {
        const el = this.#el;

        // Sort
        el.sortSelect.addEventListener('change', () => {
            this.#state.sort = el.sortSelect.value;
            el.searchSortSelect.value = this.#state.sort;
            localStorage.setItem('gallery-sort', this.#state.sort);
            if (this.#state.mode === 'search' && this.#state.query) this.#search(this.#state.query);
            else this.#browse(this.#state.path);
        });
        el.searchSortSelect.addEventListener('change', () => {
            this.#state.sort = el.searchSortSelect.value;
            el.sortSelect.value = this.#state.sort;
            localStorage.setItem('gallery-sort', this.#state.sort);
            if (this.#state.mode === 'search' && this.#state.query) this.#search(this.#state.query);
            else this.#browse(this.#state.path);
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
                this.#closeSearch({ cancel: true });
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
            if (el.searchTrigger.disabled) return;
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
            this.#closeSearch({ cancel: true });
            if (this.#state.mode === 'search') this.#browse(this.#state.path);
        });

        // Scope funnel menu
        el.scopeTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !el.scopeMenu.hidden;
            el.scopeMenu.hidden = isOpen;
            el.scopeTrigger.classList.toggle('active', !isOpen);
            if (!isOpen) {
                el.scopeMenu.scrollTop = 0;
                requestAnimationFrame(() => this.#positionScopeMenu());
            }
        });
        el.scopeMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const option = e.target.closest('.gg-scope-option');
            if (!option) return;
            e.preventDefault();
            const set = new Set(this.#state.searchScopes || []);
            const values = this.#scopeOptionValues(option);
            const allSelected = values.every(value => set.has(value));
            if (allSelected) {
                values.forEach(value => set.delete(value));
            } else {
                values.forEach(value => set.add(value));
            }
            this.#state.searchScopes = SEARCH_SCOPE_VALUES.filter(v => set.has(v));
            if (!this.#state.searchScopes.length) this.#state.searchScopes = ['name'];
            localStorage.setItem(SEARCH_SCOPES_KEY, this.#state.searchScopes.join(','));
            this.#syncSearchScopeChecks();
            this.#syncFilterState();
            const q = el.searchInput.value.trim();
            if (this.#state.mode === 'search' && q.length >= 2) {
                this.#search(q);
            }
        });
        el.scopeMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
        const onResize = () => {
            if (!el.scopeMenu.hidden) this.#positionScopeMenu();
        };
        window.addEventListener('resize', onResize);
        this.addDisposable(() => window.removeEventListener('resize', onResize));
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
            el.dateFrom.value = '';
            el.dateTo.value = '';
            el.minSize.value = '';
            el.maxSize.value = '';
            this.#state.searchScopes = [...DEFAULT_SEARCH_SCOPES];
            localStorage.setItem(SEARCH_SCOPES_KEY, this.#state.searchScopes.join(','));
            this.#syncSearchScopeChecks();
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
        this.#setSearchReady(false);
        this.#el.searchInput.focus();
    }

    #closeSearch({ cancel = false } = {}) {
        if (cancel) this.#cancelInFlight();
        this.#el.toolbarBrowse.classList.remove('search-open');
        this.#el.breadcrumb.classList.remove('search-open');
        this.#renderSearchSummary('');
        if (this.#indexPollTimer) {
            clearTimeout(this.#indexPollTimer);
            this.#indexPollTimer = null;
        }
        this.#renderIndexStatus(this.#state.indexStatus);
        this.#el.searchInput.blur();
    }

    #setSearchReady(isReady) {
        const disabled = !isReady;
        this.#el.searchInput.disabled = disabled;
        this.#el.searchSubmit.disabled = disabled;
        this.#el.searchTrigger.disabled = disabled || this.#state.root === 'temp';
        this.#el.searchBox?.classList.toggle('disabled', disabled);
    }

    #renderSearchSummary(text) {
        if (!this.#el.searchSummary) return;
        this.#el.searchSummary.textContent = text || '';
    }

    #renderIndexStatus(status = this.#state.indexStatus) {
        const els = [this.#el.indexStatusBrowse, this.#el.indexStatusSearch].filter(Boolean);
        const strip = this.#el.indexStrip;
        if (!els.length && !strip) return;
        if (localStorage.getItem(DEBUG_INDEX_STATUS_KEY) === '1') {
            status = {
                ready: false,
                building: true,
                progress: 'Debug preview',
                indexed: 4200,
                total: 100000,
                percent: 4.2,
            };
        }
        this.#state.hasCustomMetadata = Boolean(status?.hasCustomMetadata);
        if (this.#state.root === 'temp' || !status || status.ready) {
            this.#syncIndexDependentControls(true);
            for (const el of els) {
                el.hidden = true;
                el.replaceChildren();
                el.classList.remove('building', 'error');
            }
            if (strip) {
                strip.hidden = true;
                strip.replaceChildren();
            }
            if (this.#indexPollTimer) {
                clearTimeout(this.#indexPollTimer);
                this.#indexPollTimer = null;
            }
            this.#stopIndexUiTicker();
            this.#setSearchReady(true);
            return;
        }
        const state = status.state || (status.building ? 'building' : status.paused ? 'paused' : status.cleared ? 'cleared' : 'missing');
        this.#syncIndexDependentControls(false);
        if (['missing', 'cleared', 'idle'].includes(state) && localStorage.getItem(INDEX_NOTICE_DISMISSED_KEY) === '1') {
            if (strip) {
                strip.hidden = true;
                strip.replaceChildren();
            }
            this.#stopIndexUiTicker();
            this.#setSearchReady(true);
            return;
        }
        const needsBuild = ['missing', 'cleared', 'idle'].includes(state);
        const percent = Number.isFinite(Number(status.percent)) ? Math.max(0, Math.min(100, Number(status.percent))) : 0;
        const indexed = Number(status.indexed || 0).toLocaleString();
        const total = Number(status.total || 0).toLocaleString();
        const etaText = this.#getStableEtaText(status, state);
        const elapsedText = status.elapsed ? _t('gallery.searchIndexElapsed', { time: this.#formatDuration(status.elapsed) }) : '';
        const progress = status.total
            ? `${indexed}/${total} (${percent.toFixed(percent % 1 ? 1 : 0)}%)`
            : (status.progress || _t('gallery.searchIndexPreparing'));
        const label = state === 'building'
            ? _t('gallery.searchIndexBuilding', { progress })
            : state === 'paused'
                ? _t('gallery.searchIndexPaused', { progress })
                : _t('gallery.searchIndexMissing');
        for (const el of els) {
            el.hidden = true;
            el.replaceChildren();
            el.classList.remove('building', 'error');
        }
        if (strip) {
            strip.hidden = false;
            strip.classList.toggle('notice', needsBuild);
            const count = document.createElement('span');
            count.className = 'gg-index-strip-count';
            if (state === 'building' || state === 'paused') {
                const main = document.createElement('span');
                main.className = 'gg-index-count-main';
                main.textContent = status.total ? `${indexed}/${total}` : label;
                const meta = document.createElement('span');
                meta.className = 'gg-index-count-meta';
                meta.textContent = [elapsedText, etaText].filter(Boolean).join(' / ');
                count.replaceChildren(main, meta);
            } else {
                count.textContent = label;
            }
            const action = document.createElement('button');
            action.className = 'gg-index-action';
            action.type = 'button';
            action.textContent = state === 'building'
                ? _t('gallery.searchIndexPause')
                : state === 'paused'
                    ? _t('gallery.searchIndexResume')
                    : _t('gallery.searchIndexCreate');
            action.addEventListener('click', () => {
                if (state === 'building') {
                    this.#pauseIndexBuild();
                } else {
                    this.#startIndexBuild(state === 'paused');
                }
            });
            const dismiss = document.createElement('button');
            dismiss.className = 'gg-index-dismiss';
            dismiss.type = 'button';
            dismiss.title = _t('common.close');
            dismiss.innerHTML = X_ICON_SVG;
            dismiss.addEventListener('click', () => {
                localStorage.setItem(INDEX_NOTICE_DISMISSED_KEY, '1');
                this.#renderIndexStatus(this.#state.indexStatus);
            });
            if (needsBuild) {
                const actions = document.createElement('span');
                actions.className = 'gg-index-actions';
                actions.append(action, dismiss);
                strip.replaceChildren(count, actions);
            } else {
                const track = document.createElement('span');
                track.className = 'gg-index-progress';
                const fill = document.createElement('span');
                fill.className = 'gg-index-progress-fill';
                fill.style.width = `${percent}%`;
                track.appendChild(fill);
                strip.replaceChildren(count, track, action);
            }
        }
        this.#setSearchReady(true);
        if (!status.building && this.#indexPollTimer) {
            clearTimeout(this.#indexPollTimer);
            this.#indexPollTimer = null;
        }
        if (status.building) {
            this.#startIndexUiTicker(status, state, label);
        } else {
            this.#stopIndexUiTicker();
        }
        if (!this.#indexPollTimer && status.building) {
            this.#indexPollTimer = setTimeout(async () => {
                this.#indexPollTimer = null;
                await this.#refreshIndexStatus();
            }, 1000);
        }
    }

    #startIndexUiTicker(status, state, label) {
        this.#stopIndexUiTicker();
        status._clientReceivedAt = Date.now();
        this.#indexUiTimer = setInterval(() => {
            this.#updateIndexStripProgress(status, state, label);
        }, 1000);
    }

    #stopIndexUiTicker() {
        if (!this.#indexUiTimer) return;
        clearInterval(this.#indexUiTimer);
        this.#indexUiTimer = null;
    }

    #getStableEtaText(status, state) {
        if (state !== 'building') {
            this.#indexEtaText = '';
            this.#indexEtaTextUpdatedAt = 0;
            return '';
        }
        const now = Date.now();
        if (!this.#indexEtaText || now - this.#indexEtaTextUpdatedAt >= 15000) {
            this.#indexEtaText = status.etaReady && status.eta != null
                ? _t('gallery.searchIndexEta', { time: this.#formatApproxDuration(status.eta) })
                : _t('gallery.searchIndexEtaMeasuring');
            this.#indexEtaTextUpdatedAt = now;
        }
        return this.#indexEtaText;
    }

    #updateIndexStripProgress(status, state, label) {
        const strip = this.#el.indexStrip;
        if (!strip || strip.hidden || state !== 'building') return;
        const count = strip.querySelector('.gg-index-strip-count');
        const fill = strip.querySelector('.gg-index-progress-fill');
        if (!count && !fill) return;
        const elapsedSinceFetch = Math.max(0, (Date.now() - (status._clientReceivedAt || Date.now())) / 1000);
        const totalRaw = Number(status.total || 0);
        const indexedRaw = Number(status.indexed || 0);
        const rate = Number(status.rate || 0);
        const projectedIndexed = totalRaw > 0 && rate > 0
            ? Math.min(Math.max(0, totalRaw - 1), indexedRaw + elapsedSinceFetch * rate)
            : indexedRaw;
        const percent = totalRaw > 0 ? Math.max(0, Math.min(100, (projectedIndexed / totalRaw) * 100)) : 0;
        const elapsed = Number(status.elapsed || 0) + elapsedSinceFetch;
        const etaText = this.#getStableEtaText(status, state);
        const elapsedText = _t('gallery.searchIndexElapsed', { time: this.#formatDuration(elapsed) });
        if (count) {
            const indexed = Math.floor(projectedIndexed).toLocaleString();
            const total = totalRaw.toLocaleString();
            let main = count.querySelector('.gg-index-count-main');
            let meta = count.querySelector('.gg-index-count-meta');
            if (!main) {
                main = document.createElement('span');
                main.className = 'gg-index-count-main';
                meta = document.createElement('span');
                meta.className = 'gg-index-count-meta';
                count.replaceChildren(main, meta);
            }
            main.textContent = totalRaw ? `${indexed}/${total}` : label;
            if (meta) meta.textContent = [elapsedText, etaText].filter(Boolean).join(' / ');
        }
        if (fill) {
            fill.style.width = `${percent}%`;
        }
    }

    #syncIndexDependentControls(indexReady) {
        if (this.#el.scopeSection) {
            this.#el.scopeSection.hidden = !indexReady;
        }
        this.#syncSearchScopeChecks();
        this.#syncFilterState();
    }

    #syncSearchScopeChecks() {
        const customOption = this.#el.scopeMenu?.querySelector('.gg-scope-custom');
        if (customOption) {
            customOption.hidden = !this.#state.hasCustomMetadata;
        }
        if (!this.#state.hasCustomMetadata && this.#state.searchScopes?.includes('custom')) {
            this.#state.searchScopes = this.#state.searchScopes.filter(scope => scope !== 'custom');
        }
        const selected = new Set(this.#state.searchScopes || []);
        this.#el.scopeMenu?.querySelectorAll('.gg-scope-option').forEach(option => {
            const values = this.#scopeOptionValues(option);
            const checked = values.length > 0 && values.every(value => selected.has(value));
            option.classList.toggle('active', checked);
            const input = option.querySelector('input[type="checkbox"]');
            if (input) {
                input.checked = checked;
                input.indeterminate = values.some(value => selected.has(value)) && !checked;
            }
        });
    }

    #positionScopeMenu() {
        const menu = this.#el.scopeMenu;
        const trigger = this.#el.scopeTrigger;
        if (!menu || !trigger || menu.hidden) return;
        const margin = 8;
        const gap = 6;
        const rect = trigger.getBoundingClientRect();
        const viewport = window.visualViewport;
        const vw = viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0;
        const vx = viewport?.offsetLeft || 0;
        const vy = viewport?.offsetTop || 0;
        const isCompact = window.matchMedia?.('(max-width: 700px), (pointer: coarse)')?.matches;
        if (isCompact) {
            const compactMargin = 16;
            const width = Math.min(280, Math.max(220, vw - compactMargin * 2));
            const searchRect = this.#el.searchBox?.getBoundingClientRect?.();
            const anchorTop = searchRect?.top || rect.top;
            const fitsAboveSearch = anchorTop - vy >= 260;
            menu.style.width = `${width}px`;
            menu.style.left = `${vx + Math.max(compactMargin, (vw - width) / 2)}px`;
            menu.style.right = 'auto';
            if (fitsAboveSearch) {
                menu.style.top = 'auto';
                menu.style.bottom = `${Math.max(compactMargin, (window.innerHeight || vh) - anchorTop + gap)}px`;
                menu.style.maxHeight = `${Math.max(180, anchorTop - vy - compactMargin - gap)}px`;
            } else {
                menu.style.top = `${vy + compactMargin}px`;
                menu.style.bottom = 'auto';
                menu.style.maxHeight = `${Math.max(180, vh - compactMargin * 2)}px`;
            }
            return;
        }
        const width = Math.min(300, Math.max(224, vw - margin * 2));
        const left = vx + Math.max(margin, Math.min(rect.right - width - vx, vw - width - margin));
        const availableAbove = rect.top - margin - gap;
        const availableBelow = vh - rect.bottom - margin - gap;
        menu.style.width = `${width}px`;
        menu.style.left = `${left}px`;
        menu.style.right = 'auto';
        if (availableAbove >= 260 || availableAbove >= availableBelow) {
            menu.style.top = 'auto';
            menu.style.bottom = `${Math.max(margin, vh - rect.top + gap)}px`;
            menu.style.maxHeight = `${Math.max(180, availableAbove)}px`;
        } else {
            menu.style.top = `${Math.min(vh - margin - 180, rect.bottom + gap)}px`;
            menu.style.bottom = 'auto';
            menu.style.maxHeight = `${Math.max(180, availableBelow)}px`;
        }
    }

    #scopeOptionValues(option) {
        const value = option.dataset.value;
        if (value) return [value];
        if (option.dataset.group === 'prompt') return ['prompt_title', 'prompt_value'];
        if (option.dataset.group === 'workflow') return ['workflow_title', 'workflow_value'];
        return [];
    }

    #getEffectiveSearchScopes() {
        const scopes = this.#state.searchScopes || DEFAULT_SEARCH_SCOPES;
        if (!this.#state.indexStatus?.ready) return ['name'];
        const filtered = this.#state.hasCustomMetadata ? scopes : scopes.filter(scope => scope !== 'custom');
        return filtered.length ? filtered : DEFAULT_SEARCH_SCOPES.filter(scope => scope !== 'custom');
    }

    #formatDuration(seconds) {
        const value = Math.max(0, Math.round(Number(seconds) || 0));
        const mins = Math.floor(value / 60);
        const secs = value % 60;
        if (mins <= 0) return `${secs}s`;
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;
        if (hours <= 0) return `${mins}m ${secs}s`;
        return `${hours}h ${remMins}m`;
    }

    #formatApproxDuration(seconds) {
        const value = Math.max(0, Math.round(Number(seconds) || 0));
        if (value < 60) return _t('gallery.searchIndexUnderMinute');
        const mins = Math.max(1, Math.round(value / 60));
        if (mins < 10) return _t('gallery.searchIndexApproxMinutes', { count: mins });
        const rounded = Math.max(10, Math.round(mins / 5) * 5);
        return _t('gallery.searchIndexApproxMinutes', { count: rounded });
    }

    async #startIndexBuild(isResume = false) {
        try {
            if (!isResume && window.ComfyDrawer?.createSearchIndex) {
                await window.ComfyDrawer.createSearchIndex();
                await this.#refreshIndexStatus();
                return;
            }
            const endpoint = isResume ? '/drawer/fs/index-resume' : '/drawer/fs/index-start';
            const r = await this.bridge.fetchApi(endpoint, { method: 'POST' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const status = await r.json();
            this.#state.indexStatus = status;
            this.#renderIndexStatus(status);
            this.bus?.emit?.('drawer:index-build-started', status);
        } catch (e) {
            console.error(`[ComfyDrawer:${this.id}] Index start failed:`, e);
        }
    }

    async #pauseIndexBuild() {
        try {
            const r = await this.bridge.fetchApi('/drawer/fs/index-pause', { method: 'POST' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const status = await r.json();
            this.#state.indexStatus = status;
            this.#renderIndexStatus(status);
        } catch (e) {
            console.error(`[ComfyDrawer:${this.id}] Index pause failed:`, e);
        }
    }

    async #refreshIndexStatus() {
        if (this.#state.root === 'temp') return null;
        if (localStorage.getItem(DEBUG_INDEX_STATUS_KEY) === '1') {
            const status = {
                ready: false,
                building: true,
                progress: 'Debug preview',
                indexed: 4200,
                total: 100000,
                percent: 4.2,
            };
            this.#state.indexStatus = status;
            this.#renderIndexStatus(status);
            return status;
        }
        try {
            const r = await this.bridge.fetchApi('/drawer/fs/index-status');
            if (!r.ok) {
                this.#setSearchReady(true);
                return null;
            }
            const status = await r.json();
            this.#state.indexStatus = status;
            this.#renderIndexStatus(status);
            return status;
        } catch {
            this.#setSearchReady(true);
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
        const scopes = s.searchScopes || [];
        const scopeChanged = scopes.length !== DEFAULT_SEARCH_SCOPES.length
            || DEFAULT_SEARCH_SCOPES.some(scope => !scopes.includes(scope));
        return !!(scopeChanged || s.dateFrom || s.dateTo || s.minSizeMB || s.maxSizeMB);
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
        if (this.#state.mode !== 'search') this.#sortFiles();
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
        return this.bridge.apiURL(`/drawer/fs/view?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&filename=${encodeURIComponent(file.name)}`);
    }
    #thumbUrl(file) {
        if (file.type !== 'image' && file.type !== 'video') return this.#imgUrl(file);
        const root = this.#getRoot();
        const subfolder = file.subfolder || '';
        return this.bridge.apiURL(`/drawer/fs/thumb?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&filename=${encodeURIComponent(file.name)}&size=512`);
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
    #hideStatus() {
        this.#el.status.replaceChildren();
        this.#el.status.classList.add('hidden');
    }

    #setInitialLoading(loading) {
        this.container.classList.toggle('gg-initial-loading', !!loading);
        if (loading) {
            this.#setStatus(_t('common.loading'));
        } else if (this.#el.status.textContent === _t('common.loading')) {
            this.#hideStatus();
        }
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

    #abortCurrentFetch() {
        if (this.#fetchController) {
            this.#fetchController.abort();
            this.#fetchController = null;
        }
    }

    #cancelInFlight() {
        this.#requestSeq += 1;
        this.#abortCurrentFetch();
    }

    #isCurrentRequest(seq) {
        return seq === this.#requestSeq;
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

    #extractGeneratedFiles(detail) {
        const output = detail?.output;
        if (!output || typeof output !== 'object') return [];
        const files = [];
        const visit = (value) => {
            if (Array.isArray(value)) {
                for (const item of value) visit(item);
                return;
            }
            if (!value || typeof value !== 'object') return;
            const name = String(value.filename || value.name || '').trim();
            if (name) {
                const root = String(value.type || value.root || 'output').trim().toLowerCase();
                files.push({
                    root: ['output', 'input', 'temp'].includes(root) ? root : 'output',
                    subfolder: String(value.subfolder || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''),
                    name,
                });
                return;
            }
            for (const child of Object.values(value)) visit(child);
        };
        for (const key of ['images', 'gifs', 'videos', 'audio', 'animated']) {
            visit(output[key]);
        }
        return files;
    }

    #scheduleGeneratedFilesUpdate() {
        clearTimeout(this.#generationRefreshTimer);
        this.#generationRefreshTimer = setTimeout(() => {
            this.#generationRefreshTimer = null;
            this.#indexGeneratedFiles();
        }, 1500);
    }

    async #indexGeneratedFiles() {
        const files = [...this.#generatedFiles.values()];
        this.#generatedFiles.clear();
        this.#lastFetchTime = 0;
        if (files.length) {
            try {
                await this.bridge.fetchApi('/drawer/fs/index-generated', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files }),
                });
                this.#refreshIndexStatus();
            } catch (e) {
                console.warn('[Gallery] Generated file indexing failed:', e);
            }
        }
        if (this.container?.style.display !== 'none' && this.#state.mode === 'browse') {
            this.#browse(this.#state.path);
        }
    }

    #cancelThumbWarm() {
        this.#thumbWarmToken += 1;
        clearTimeout(this.#thumbWarmTimer);
        this.#thumbWarmTimer = null;
    }

    #scheduleThumbWarm(files) {
        this.#cancelThumbWarm();
        const queue = (files || [])
            .filter(file => file?.type === 'image' || file?.type === 'video')
            .slice(8, 40)
            .map(file => ({
                root: this.#getRoot(),
                subfolder: file.subfolder ?? this.#state.path ?? '',
                name: file.name,
            }));
        if (!queue.length) return;
        const token = this.#thumbWarmToken;
        const runBatch = async () => {
            if (token !== this.#thumbWarmToken || !queue.length) return;
            const files = queue.splice(0, THUMB_WARM_BATCH_SIZE);
            try {
                await this.bridge.fetchApi('/drawer/fs/thumb-warm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files, size: 512 }),
                });
            } catch { /* best effort */ }
            if (token === this.#thumbWarmToken && queue.length) {
                this.#thumbWarmTimer = setTimeout(runBatch, 1200);
            }
        };
        this.#thumbWarmTimer = setTimeout(runBatch, 800);
    }

    async #prepareMediaContextMenu(file, src, hasWorkflow = undefined) {
        const root = this.#getRoot();
        const base = {
            ...file,
            src,
            source: 'gallery',
            root,
        };
        const indexBody = {
            files: [{
                root,
                subfolder: file.subfolder ?? this.#state.path ?? '',
                name: file.name,
            }],
        };
        const metaItem = {
            ...base,
            source: root,
        };
        const [workflowAvailable, metadataAvailable] = await Promise.all([
            hasWorkflow === undefined
                ? window.ComfyDrawer?.checkWorkflowAvailable?.(metaItem).catch(() => false)
                : Promise.resolve(hasWorkflow),
            window.ComfyDrawer?.checkMetadataAvailable?.(metaItem).catch(() => false),
            this.bridge.fetchApi('/drawer/fs/index-generated', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(indexBody),
            }).catch(() => null),
        ]);
        return {
            ...base,
            hasWorkflow: !!workflowAvailable,
            hasMetadata: !!metadataAvailable,
        };
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
            const r = await this.bridge.fetchApi(`/drawer/fs/siblings?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
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

    async #apiBrowse(path, offset = 0) {
        const signal = this.#newFetchSignal();
        const root = this.#state.root || 'output';
        const sort = this.#state.sort || 'name-asc';
        const r = await this.bridge.fetchApi(`/drawer/fs/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&limit=${BROWSE_PAGE_SIZE}&offset=${encodeURIComponent(offset)}&sort=${encodeURIComponent(sort)}`, { signal });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
        this.#lastFetchTime = Date.now();
        return r.json();
    }

    async #apiSearch(q, path, offset = 0) {
        const signal = this.#newFetchSignal();
        const root = this.#state.root || 'output';
        const scope = this.#getEffectiveSearchScopes().join(',');
        const sort = this.#state.sort || 'date-desc';
        const r = await this.bridge.fetchApi(`/drawer/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&path=${encodeURIComponent(path || '')}&limit=${SEARCH_PAGE_SIZE}&offset=${encodeURIComponent(offset)}&scope=${encodeURIComponent(scope)}&sort=${encodeURIComponent(sort)}`, { signal });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
        this.#lastFetchTime = Date.now();
        return r.json();
    }

    /* ═══ Browse / Search ═══ */

    async #browse(path) {
        const seq = ++this.#requestSeq;
        this.#abortCurrentFetch();
        const s = this.#state;
        if (!this.#initialLoadComplete) this.#setInitialLoading(true);
        // Exit selection mode if navigating to a different folder (e.g. via breadcrumb)
        // but NOT in move mode — move mode needs folder navigation to pick destination
        if (s.selectMode && !s.moveMode) {
            s.selectMode = false;
            s.selected.clear();
            this.#showToolbar('browse');
        }
        s.mode = 'browse'; s.path = path; s.query = '';
        s.searchHasMore = false;
        s.searchOffset = 0;
        s.searchLoadingMore = false;
        s.browseHasMore = false;
        s.browseOffset = 0;
        s.browseLoadingMore = false;
        s.browseVisibleCount = BROWSE_PAGE_SIZE;
        this.#el.searchInput.value = '';
        this.#el.clearBtn.hidden = true;
        this.#el.resultCount.textContent = '';
        this.#renderSearchSummary('');
        this.#renderIndexStatus(this.#state.indexStatus);
        this.#el.breadcrumb.classList.remove('hidden');
        // Disable search on temp root
        const isTemp = s.root === 'temp';
        this.#el.searchTrigger.disabled = isTemp;
        if (isTemp) this.#closeSearch();
        try {
            const data = await this.#apiBrowse(path);
            if (!this.#isCurrentRequest(seq)) return;
            s.folders = data.folders || [];
            s.rawFiles = data.files || [];
            s.files = this.#applyClientFilters(s.rawFiles);
            s.browseOffset = s.rawFiles.length;
            s.browseHasMore = !!data.hasMore;
            s.breadcrumb = data.breadcrumb || [];
            this.#sortFiles();
            this.#renderBreadcrumb();
            this.#renderGrid();
            if (!this.#initialLoadComplete) {
                this.#initialLoadComplete = true;
                this.#setInitialLoading(false);
            }
            this.#refreshIndexStatus();
        } catch (e) {
            if (e.name === 'AbortError') return; // intentional cancellation
            if (!this.#isCurrentRequest(seq)) return;
            if (!this.#initialLoadComplete) {
                this.#initialLoadComplete = true;
                this.container.classList.remove('gg-initial-loading');
            }
            this.#setStatus(_t('common.error') + ': ' + e.message);
        }
    }

    async #search(query) {
        const seq = ++this.#requestSeq;
        this.#abortCurrentFetch();
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
        if (!this.#isCurrentRequest(seq)) return;
        if (indexStatus && !indexStatus.ready && this.#isIndexRequiredForCurrentSearch()) {
            this.#renderSearchSummary(_t('gallery.searchIndexWaiting'));
            this.#setStatus(_t('gallery.searchIndexWaiting'));
            return;
        }
        try {
            const data = await this.#apiSearch(query, s.path);
            if (!this.#isCurrentRequest(seq)) return;
            if (query !== this.#el.searchInput.value.trim()) return; // stale
            s.rawFiles = data.files || [];
            s.files = this.#applyClientFilters(s.rawFiles);
            s.folders = [];
            s.total = Number(data.total || s.files.length);
            s.searchOffset = s.rawFiles.length;
            s.searchHasMore = !!data.hasMore;
            s.searchLoadingMore = false;
            const countText = `${s.total.toLocaleString()}${data.totalExact === false && s.searchHasMore ? '+' : ''}`;
            const summary = _t('gallery.searchResultsShowing', {
                count: countText,
                shown: s.files.length.toLocaleString(),
            });
            this.#el.resultCount.textContent = '';
            this.#renderSearchSummary(summary);
            this.#renderGrid();
        } catch (e) {
            if (e.name === 'AbortError') return; // intentional cancellation
            if (!this.#isCurrentRequest(seq)) return;
            this.#setStatus(_t('common.error') + ': ' + e.message);
        }
    }

    async #loadMoreSearch() {
        const s = this.#state;
        if (s.mode !== 'search' || !s.searchHasMore || s.searchLoadingMore) return;
        s.searchLoadingMore = true;
        this.#renderGrid();
        try {
            const data = await this.#apiSearch(s.query, s.path, s.searchOffset);
            if (s.mode !== 'search' || data.query !== s.query) return;
            const incoming = data.files || [];
            const seen = new Set(s.rawFiles.map(file => `${file.subfolder || ''}/${file.name}`));
            for (const file of incoming) {
                const key = `${file.subfolder || ''}/${file.name}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    s.rawFiles.push(file);
                }
            }
            s.files = this.#applyClientFilters(s.rawFiles);
            s.total = Number(data.total || s.files.length);
            s.searchOffset += incoming.length;
            s.searchHasMore = !!data.hasMore && incoming.length > 0;
            s.searchLoadingMore = false;
            const countText = `${s.total.toLocaleString()}${data.totalExact === false && s.searchHasMore ? '+' : ''}`;
            const summary = _t('gallery.searchResultsShowing', {
                count: countText,
                shown: s.files.length.toLocaleString(),
            });
            this.#renderSearchSummary(summary);
            this.#renderGrid();
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('[Gallery] Load more search failed:', e);
        } finally {
            s.searchLoadingMore = false;
        }
    }

    async #loadMoreBrowse() {
        const s = this.#state;
        if (s.mode !== 'browse' || s.browseLoadingMore) return;
        if (!s.browseHasMore) {
            s.browseVisibleCount = Math.min(
                s.files.length,
                Number(s.browseVisibleCount || BROWSE_PAGE_SIZE) + BROWSE_PAGE_SIZE
            );
            this.#renderGrid();
            return;
        }
        s.browseLoadingMore = true;
        this.#renderGrid();
        try {
            const data = await this.#apiBrowse(s.path, s.browseOffset);
            if (s.mode !== 'browse') return;
            const incoming = data.files || [];
            s.rawFiles.push(...incoming);
            s.files = this.#applyClientFilters(s.rawFiles);
            s.browseOffset += incoming.length;
            s.browseHasMore = !!data.hasMore && incoming.length > 0;
            s.browseVisibleCount = s.files.length;
            this.#sortFiles();
            this.#renderGrid();
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('[Gallery] Load more browse failed:', e);
        } finally {
            s.browseLoadingMore = false;
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
            const r = await this.bridge.fetchApi(`/drawer/fs/siblings?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
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

    #isIndexRequiredForCurrentSearch() {
        return this.#getEffectiveSearchScopes().some(scope => INDEX_SEARCH_SCOPES.includes(scope));
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
        this.#cancelThumbWarm();
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

        const visibleFiles = s.mode === 'browse'
            ? s.files.slice(0, Number(s.browseVisibleCount || BROWSE_PAGE_SIZE))
            : s.files;
        const total = s.folders.length + visibleFiles.length;
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
        const lbItems = visibleFiles.map(f => ({
            src: this.#imgUrl(f),
            type: f.type || 'image',
            label: f.name,
            details: `${this.#fmtDate(f.created)}   ${this.#fmtSize(f.size)}${f.subfolder ? `   ${f.subfolder}` : ''}`,
            data: f,
        }));


        for (let i = 0; i < visibleFiles.length; i++) {
            const file = visibleFiles[i];
            const url = this.#imgUrl(file);
            const thumbUrl = file.type === 'audio'
                ? 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
                : this.#thumbUrl(file);
            const isMedia = file.type === 'video' || file.type === 'audio';

            const mc = createMediaCard({
                src: thumbUrl,
                dragSrc: url,
                filename: file.name,
                mediaType: file.type === 'audio' ? 'audio' : 'image',
                thumbHeight: 140,
                lazy: i >= 8,
                checkWorkflow: false,
                lightbox: !inSelectOrMove,
                draggable: !inSelectOrMove,
                lightboxItems: lbItems,
                lightboxIndex: i,
                lightboxOptions: {
                    get autoplay() { return s.autoplay; },
                    contextMenuType: 'media-file',
                    contextMenuData: (item) => this.#prepareMediaContextMenu(item.data, item.src, item.hasWorkflow),
                    onKey: (key, item) => {
                        if (key === 'Delete') {
                            this.#deleteCurrent(item?.data || null);
                        }
                    },
                    onClose: () => { this.#lbCurrentFile = null; },
                },
                onClick: s.selectMode ? () => this.#toggleSelect(file.path, mc.element) : null,
                onContextMenu: !inSelectOrMove ? async (e) => {
                    const ctx = await this.#prepareMediaContextMenu(file, url, mc.element._hasWorkflow);
                    this.#contextMenu?.show('media-file', ctx, e.clientX, e.clientY);
                } : null,
                onFolderDrop: (!inSelectOrMove && this.#state.root !== 'temp') ? async (destPath) => {
                    try {
                        const root = this.#getRoot();
                        const srcSubfolder = file.subfolder ?? this.#state.path ?? '';
                        const res = await this.bridge.fetchApi('/drawer/fs/move', {
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
                            const movedKey = `${srcSubfolder}/${file.name}`;
                            const keepFile = (f) => `${f.subfolder ?? ''}/${f.name}` !== movedKey;
                            this.#state.files = this.#state.files.filter(keepFile);
                            this.#state.rawFiles = this.#state.rawFiles.filter(keepFile);
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

        if (s.mode === 'search' && s.searchHasMore) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'gg-load-more';
            more.disabled = !!s.searchLoadingMore;
            more.textContent = s.searchLoadingMore ? _t('common.loading') : _t('gallery.loadMore');
            more.addEventListener('click', () => this.#loadMoreSearch());
            grid.appendChild(more);
        }
        if (s.mode === 'browse' && (s.browseHasMore || s.files.length > visibleFiles.length)) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'gg-load-more';
            more.disabled = !!s.browseLoadingMore;
            more.textContent = s.browseLoadingMore ? _t('common.loading') : _t('gallery.loadMore');
            more.addEventListener('click', () => this.#loadMoreBrowse());
            grid.appendChild(more);
        }
        this.#scheduleThumbWarm(visibleFiles);
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
            contextMenuData: (item) => this.#prepareMediaContextMenu(item.data, item.src, item.hasWorkflow),
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
                order: 20,
                compact: true,
                visible: (ctx) => ctx.source === 'gallery',
                action: (ctx) => this.#ctxRenameFile(ctx),
            },
            {
                id: 'gallery:select',
                label: _t('gallery.select'),
                icon: 'select',
                order: 40,
                compact: true,
                visible: (ctx) => ctx.source === 'gallery' && !this.#state.selectMode,
                action: (ctx) => this.#enterSelectMode(ctx.path),
            },
            {
                id: 'gallery:delete',
                label: _t('common.delete'),
                icon: 'trash',
                order: 100,
                danger: true,
                compact: true,
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
                        <input class="cd-dialog-input" type="text" value="${escapeHTML(baseName)}" data-autoselect />
                    </label>
                    <span class="cd-rename-file-ext">${escapeHTML(extName)}</span>
                `;
                body.appendChild(form);
                const nameInput = form.querySelector('.cd-rename-file-name input');
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
        const subfolder = file.subfolder ?? this.#state.path ?? '';
        try {
            const r = await this.bridge.fetchApi('/drawer/fs/rename', {
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
            const r = await this.bridge.fetchApi('/drawer/fs/rename', {
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
                const r = await this.bridge.fetchApi('/drawer/fs/mkdir', {
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
            const r = await this.bridge.fetchApi('/drawer/fs/delete', {
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
            const res = await this.bridge.fetchApi('/drawer/fs/move', {
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
                        const res2 = await this.bridge.fetchApi('/drawer/fs/move', {
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
        const r = await this.bridge.fetchApi('/drawer/fs/delete', {
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
