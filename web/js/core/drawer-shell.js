/**
 * ComfyDrawer — DrawerShell
 * The visual container: tab bar + sliding panel + resize handle.
 * Manages gadget panels and their lifecycle.
 */
import { placeAboveTabBar } from '../services/popover.js';

export class DrawerShell {
    /** @type {import('./message-bus.js').MessageBus} */
    #bus;
    /** @type {import('./comfy-bridge.js').ComfyBridge} */
    #bridge;
    /** @type {Map<string, import('./gadget-base.js').GadgetBase>} */
    #gadgets = new Map();
    /** @type {Map<string, HTMLElement>} Shell-owned container references */
    #containers = new Map();
    /** @type {Set<string>} Gadget IDs whose DOM has been mounted */
    #mounted = new Set();
    /** @type {string|null} Currently active gadget ID */
    #activeId = null;
    /** @type {HTMLElement} */
    #root = null;
    /** @type {HTMLElement} */
    #tabBar = null;
    /** @type {HTMLElement} */
    #panel = null;
    /** @type {HTMLElement} */
    #panelBody = null;
    /** @type {HTMLElement} */
    #resizeHandle = null;
    /** @type {number} Panel height in px (derived from topOffset at open time) */
    #panelHeight;
    /** @type {number} Saved top-offset from viewport top edge (px) */
    #topOffset;
    /** @type {boolean} */
    #isOpen = false;
    /** @type {boolean} Whether the drawer panel currently has keyboard focus */
    #hasFocus = false;
    /** @type {AbortController|null} */
    #escController = null;
    /** @type {boolean} Whether a history entry has been pushed for the drawer */
    #historyPushed = false;
    /** @type {boolean} Flag to prevent popstate re-entry when closing programmatically */
    #popstateClosing = false;
    /** @type {(() => void)|null} Handler for 'drawer:graph-configured' DOM event */
    #graphConfiguredHandler = null;
    /** @type {(() => void)|null} Dispose function for litegraph:set-graph listener */
    #graphWatchDispose = null;
    /** @type {number|null} Panel width in px (null = full width, desktop only) */
    #panelWidth = null;
    /** @type {string} 'left'|'right' */
    #panelAlign = 'left';
    #sideHandleL = null;
    #sideHandleR = null;
    #edgeHandleL = null;
    #edgeHandleR = null;
    #alignBtn = null;
    #desktopMQ = null;
    /** @type {HTMLElement[]} Persistent elements appended after tabs (e.g. settings button) */
    /** Tab bar rows: header (run progress strip) and the tabs themselves */
    #tabHeader = null;
    #tabRow = null;
    /** Ids of menu actions shown in the tab bar */
    #pinnedActions = new Set();
    /** @type {Set<string>} Gadget IDs hidden from the tab bar */
    #hiddenGadgets = new Set();
    /** @type {boolean} True until the platform marks itself ready (built-in gadget registration pass has run). External gadgets registering before then must not cause the tab bar to surface alone. */
    #loading = true;
    /** @type {boolean} Standalone page: panel fills the viewport and never closes. */
    #standalone = false;

    static PANEL_MIN = 50;
    static PANEL_DEFAULT = 460;
    static PANEL_TOP_MARGIN = 8;
    static STORAGE_KEY = 'comfy-drawer-top';
    static WIDTH_KEY = 'comfy-drawer-width';
    static ALIGN_KEY = 'comfy-drawer-align';
    static PANEL_MIN_WIDTH = 320;
    static HIDDEN_KEY = 'comfy-drawer-hidden-gadgets';
    static PINNED_KEY = 'comfy-drawer-pinned-actions';
    /** Gadgets whose default visibility was applied once (defaultHidden). */
    static SEEN_KEY = 'comfy-drawer-seen-gadgets';

    /** ComfyUI DOM selectors for panel snap points.
     *  Centralised here so a single edit fixes breakage from ComfyUI UI updates. */
    static SNAP_SELECTORS = ['.workflow-tabs', '#comfyui-body-top'];

    static #isEditableTarget(target) {
        if (!target || target.nodeType !== 1) return false;
        return !!target.closest('input, textarea, select, [contenteditable="true"]');
    }

    static #isDrawerOwnedLayer(target) {
        if (!target || target.nodeType !== 1) return false;
        return !!target.closest('.comfy-drawer, .cd-dialog-backdrop, .cd-dialog, .cd-lightbox-root, .cd-ctxmenu, .cd-ctxmenu-backdrop');
    }

    /**
     * @param {import('./message-bus.js').MessageBus} bus
     * @param {import('./comfy-bridge.js').ComfyBridge} bridge
     * @param {object} [options]
     * @param {boolean} [options.standalone=false] - Fill the viewport, never close,
     *   and leave the in-ComfyUI panel geometry in localStorage untouched.
     */
    constructor(bus, bridge, { standalone = false } = {}) {
        this.#bus = bus;
        this.#bridge = bridge;
        this.#standalone = !!standalone;
        if (this.#standalone) {
            this.#topOffset = null;
            this.#panelHeight = DrawerShell.PANEL_DEFAULT;
        } else {
            // Restore saved top offset; fall back to a default that gives PANEL_DEFAULT height
            const savedTop = parseInt(localStorage.getItem(DrawerShell.STORAGE_KEY), 10);
            this.#topOffset = isNaN(savedTop) ? null : savedTop;
            this.#panelHeight = this.#topOffsetToHeight(this.#topOffset) || DrawerShell.PANEL_DEFAULT;
            this.#panelWidth = parseInt(localStorage.getItem(DrawerShell.WIDTH_KEY), 10) || null;
            this.#panelAlign = localStorage.getItem(DrawerShell.ALIGN_KEY) || 'left';
        }
        this.#desktopMQ = window.matchMedia('(min-width: 601px)');
        this.#desktopMQ.addEventListener('change', () => this.#applyLayout());
        this.#clampHeight();  // Ensure stored height fits current viewport
        if (!this.#standalone) this.#saveTopOffset(); // Persist corrected value in case it was out-of-bounds
        this.#loadHiddenGadgets();
        this.#loadPinnedActions();
        this.#buildDOM();
        this.#watchGraphChanges();
        this.#watchWindowResize();
        this.#renderTabs();

        // Inner layers (lightbox, etc.) emit 'drawer:back-handled' to prevent
        // the drawer from closing when they consume the mobile back button.
        this.#bus.on('drawer:back-handled', () => this.#suppressBackClose());
    }

    /* ═══════════════════════════════════════════════════════
       DOM Construction
       ═══════════════════════════════════════════════════════ */

    #buildDOM() {
        // Root container (fixed, bottom) — no backdrop so ComfyUI stays interactive
        this.#root = document.createElement('div');
        this.#root.id = 'comfy-drawer';
        this.#root.className = 'comfy-drawer';
        if (this.#standalone) this.#root.classList.add('standalone');

        // Suppress native context menu (except in input/textarea)
        // Use capture phase to ensure this runs before any child stopPropagation
        this.#root.addEventListener('contextmenu', (e) => {
            if (!DrawerShell.#isEditableTarget(e.target)) e.preventDefault();
        }, true);

        // Resize handle
        this.#resizeHandle = document.createElement('div');
        this.#resizeHandle.className = 'comfy-drawer-resize';
        this.#resizeHandle.innerHTML = '<div class="comfy-drawer-resize-bar"></div>';
        this.#initResize();

        // Panel body (gadget content goes here)
        this.#panelBody = document.createElement('div');
        this.#panelBody.className = 'comfy-drawer-body';

        // Panel wrapper
        this.#panel = document.createElement('div');
        this.#panel.className = 'comfy-drawer-panel';
        // Height starts at 0 (closed). Set explicitly when opened.
        this.#panel.appendChild(this.#resizeHandle);
        this.#panel.appendChild(this.#panelBody);

        // Corner resize handles (desktop diagonal resize: width + height)
        this.#sideHandleL = document.createElement('div');
        this.#sideHandleL.className = 'comfy-drawer-corner-handle left';
        this.#sideHandleR = document.createElement('div');
        this.#sideHandleR.className = 'comfy-drawer-corner-handle right';
        this.#panel.appendChild(this.#sideHandleL);
        this.#panel.appendChild(this.#sideHandleR);

        // Side edge handles (desktop horizontal-only resize)
        this.#edgeHandleL = document.createElement('div');
        this.#edgeHandleL.className = 'comfy-drawer-edge-handle left';
        this.#edgeHandleR = document.createElement('div');
        this.#edgeHandleR.className = 'comfy-drawer-edge-handle right';
        this.#panel.appendChild(this.#edgeHandleL);
        this.#panel.appendChild(this.#edgeHandleR);

        this.#initSideResize();

        // Tab bar (floating pill when closed, docked when open)
        this.#tabBar = document.createElement('div');
        this.#tabBar.className = 'comfy-drawer-tabs';
        this.#tabHeader = document.createElement('div');
        this.#tabHeader.className = 'comfy-drawer-tabs-header';
        this.#tabRow = document.createElement('div');
        this.#tabRow.className = 'comfy-drawer-tabs-row';
        this.#tabBar.append(this.#tabHeader, this.#tabRow);

        // Align toggle button (desktop, shown when custom width is active)
        this.#alignBtn = document.createElement('button');
        this.#alignBtn.className = 'comfy-drawer-align-btn';
        this.#alignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#cycleAlign();
        });

        // Root layout: panel + tabs (flex-column, panel slides up from bottom)
        this.#root.appendChild(this.#panel);
        this.#root.appendChild(this.#tabBar);

        // Block browser's native right-click menu on the entire drawer,
        // but allow native cut/copy/paste on text inputs (critical for mobile)
        this.#root.addEventListener('contextmenu', (e) => {
            if (DrawerShell.#isEditableTarget(e.target)) return;
            // Allow native context menu on read-only note/markdown displays
            if (e.target?.closest('.dk-note-display')) return;
            e.preventDefault();
        });

        document.body.appendChild(this.#root);

    }

    /* ═══════════════════════════════════════════════════════
       Gadget Registration
       ═══════════════════════════════════════════════════════ */

    /**
     * Register a gadget and add its tab.
     * @param {import('./gadget-base.js').GadgetBase} gadget
     */
    registerGadget(gadget, options = {}) {
        if (this.#gadgets.has(gadget.id)) {
            console.warn(`[ComfyDrawer] Gadget "${gadget.id}" already registered`);
            return;
        }

        // Create panel container for this gadget (Shell-owned)
        const container = document.createElement('div');
        container.className = `comfy-drawer-gadget gadget-${gadget.id}`;
        container.style.display = 'none';
        if (options.lazyMount) {
            container.classList.add('comfy-drawer-gadget-mounting');
            container.innerHTML = `<div class="comfy-drawer-gadget-placeholder">${window.ComfyDrawer?.t?.('common.loading') ?? 'Loading...'}</div>`;
        }
        this.#panelBody.appendChild(container);
        this.#containers.set(gadget.id, container);

        this.#gadgets.set(gadget.id, gadget);
        this.#applyDefaultVisibility(gadget.id, !!options.defaultHidden);
        if (!options.lazyMount) {
            this.#mountGadget(gadget.id);
        }

        // Rebuild tabs (sorted by order)
        this.#renderTabs();

        this.#bus.emit('drawer:gadget-registered', { id: gadget.id });
    }

    /**
     * Called by the platform entry point after the built-in gadget registration
     * pass has run. Clears the loading overlay and re-renders tabs so any
     * external gadgets that arrived before built-ins become visible together.
     * Idempotent.
     */
    markReady() {
        if (!this.#loading) return;
        this.#loading = false;
        this.#renderTabs();
    }

    #mountGadget(id) {
        if (this.#mounted.has(id)) return true;
        const gadget = this.#gadgets.get(id);
        const container = this.#containers.get(id);
        if (!gadget || !container) return false;
        container.classList.add('comfy-drawer-gadget-mounting');
        try {
            gadget.mount(container, this.#bus, this.#bridge);
            this.#mounted.add(id);
            return true;
        } finally {
            requestAnimationFrame(() => {
                container.classList.remove('comfy-drawer-gadget-mounting');
            });
        }
    }

    /**
     * Unregister a gadget and perform full cleanup.
     * Shell controls the destroy sequence — gadget.destroy() is the
     * final method that calls onDestroy() then drains disposables.
     * @param {string} id - Gadget ID to remove
     */
    unregisterGadget(id) {
        const gadget = this.#gadgets.get(id);
        if (!gadget) return;

        // If this gadget is active, close the drawer first
        if (this.#activeId === id) this.close();

        // Destroy: onDestroy() → disposables → null refs
        // Use destroy() (GadgetBase) if available, else fall back to onDestroy() (plain objects)
        if (typeof gadget.destroy === 'function') {
            gadget.destroy();
        } else if (typeof gadget.onDestroy === 'function') {
            gadget.onDestroy();
        }

        // Remove DOM
        this.#containers.get(id)?.remove();
        this.#containers.delete(id);
        this.#gadgets.delete(id);
        this.#mounted.delete(id);

        // Rebuild tabs
        this.#renderTabs();

        this.#bus.emit('drawer:gadget-unregistered', { id });
    }

    /**
     * A gadget registered with `defaultHidden` starts in the menu the first
     * time this browser sees it; after that the user's choice stands.
     */
    #applyDefaultVisibility(id, defaultHidden) {
        let seen = [];
        try { seen = JSON.parse(localStorage.getItem(DrawerShell.SEEN_KEY) || '[]'); } catch { /* ignore */ }
        if (!Array.isArray(seen)) seen = [];
        if (seen.includes(id)) return;
        seen.push(id);
        try { localStorage.setItem(DrawerShell.SEEN_KEY, JSON.stringify(seen)); } catch { /* ignore */ }
        if (defaultHidden && id !== 'home' && !this.#hiddenGadgets.has(id)) {
            this.#hiddenGadgets.add(id);
            this.#saveHiddenGadgets();
        }
    }

    static TAB_ORDER_KEY = 'comfy-drawer-tab-order';

    /* ═══════════════════════════════════════════════════════
       Tab Bar
       ═══════════════════════════════════════════════════════ */

    /** Get tab display order: custom localStorage order > gadget.order */
    #getTabOrder() {
        try {
            const saved = localStorage.getItem(DrawerShell.TAB_ORDER_KEY);
            if (saved) return JSON.parse(saved);  // array of gadget IDs
        } catch { /* ignore */ }
        return null;
    }

    #saveTabOrder(ids) {
        localStorage.setItem(DrawerShell.TAB_ORDER_KEY, JSON.stringify(ids));
    }

    #renderTabs() {
        this.#tabRow.replaceChildren();
        const gadgetGroup = document.createElement('div');
        gadgetGroup.className = 'comfy-drawer-tabs-gadgets';
        const gadgets = [...this.#gadgets.values()];
        const customOrder = this.#getTabOrder();

        this.#root.classList.toggle('loading', this.#loading);
        if (this.#loading) return;

        if (customOrder) {
            // Sort by saved order; unknown gadgets go to the end by their default order
            gadgets.sort((a, b) => {
                const ai = customOrder.indexOf(a.id);
                const bi = customOrder.indexOf(b.id);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                return a.order - b.order;
            });
        } else {
            gadgets.sort((a, b) => a.order - b.order);
        }

        const visible = gadgets.filter(g => !this.#hiddenGadgets.has(g.id));

        for (const gadget of visible) {
            const tab = document.createElement('button');
            tab.className = 'comfy-drawer-tab';
            tab.dataset.gadgetId = gadget.id;
            tab.draggable = true;
            if (gadget.id === this.#activeId) tab.classList.add('active');

            // gadget.label is treated as plain text via textContent: any
            // third-party gadget registered through registerGadget() owns
            // this string, so we can't trust it as HTML. gadget.icon is
            // still innerHTML because the convention is "raw SVG markup".
            const iconSpan = document.createElement('span');
            iconSpan.className = 'comfy-drawer-tab-icon';
            iconSpan.innerHTML = gadget.icon ?? '';
            const labelSpan = document.createElement('span');
            labelSpan.className = 'comfy-drawer-tab-label';
            labelSpan.textContent = gadget.label ?? '';
            tab.append(iconSpan, labelSpan);
            tab.title = gadget.label ?? '';
            tab.addEventListener('click', () => this.#onTabClick(gadget.id));

            // ── Drag & Drop ──
            tab.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', gadget.id);
                tab.classList.add('dragging');
            });
            tab.addEventListener('dragend', () => {
                tab.classList.remove('dragging');
                this.#tabBar.querySelectorAll('.comfy-drawer-tab').forEach(t => t.classList.remove('drag-over'));
            });
            tab.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Highlight drop target
                this.#tabBar.querySelectorAll('.comfy-drawer-tab').forEach(t => t.classList.remove('drag-over'));
                tab.classList.add('drag-over');
            });
            tab.addEventListener('dragleave', () => {
                tab.classList.remove('drag-over');
            });
            tab.addEventListener('drop', (e) => {
                e.preventDefault();
                tab.classList.remove('drag-over');
                const dragId = e.dataTransfer.getData('text/plain');
                const dropId = gadget.id;
                if (dragId === dropId) return;
                // Compute new order from current DOM
                const currentIds = [...this.#tabBar.querySelectorAll('.comfy-drawer-tab[data-gadget-id]')]
                    .map(t => t.dataset.gadgetId);
                const dragIdx = currentIds.indexOf(dragId);
                const dropIdx = currentIds.indexOf(dropId);
                if (dragIdx === -1 || dropIdx === -1) return;
                currentIds.splice(dragIdx, 1);
                currentIds.splice(dropIdx, 0, dragId);
                this.#saveTabOrder(currentIds);
                this.#renderTabs();
            });

            gadgetGroup.appendChild(tab);
        }

        // Gadgets | pinned menu actions + menu button (always last).
        const actionGroup = document.createElement('div');
        actionGroup.className = 'comfy-drawer-tabs-actions';
        for (const a of this.#burgerActions) {
            if (this.#pinnedActions.has(a.id)) actionGroup.appendChild(this.#actionTab(a));
        }
        const burger = document.createElement('button');
        burger.className = 'comfy-drawer-tab comfy-drawer-burger';
        burger.title = 'Menu';
        burger.innerHTML = `<span class="comfy-drawer-tab-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg></span>`;
        burger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#bus.emit('drawer:close-popovers', { source: 'burger' });
            this.#toggleBurgerMenu(burger);
        });
        actionGroup.appendChild(burger);
        const sep = document.createElement('span');
        sep.className = 'comfy-drawer-tabs-sep';
        this.#tabRow.append(gadgetGroup, sep, actionGroup);
    }

    /** The tab-bar element of a pinned action: its own element, or an icon button. */
    #actionTab(a) {
        if (a.tabElement) {
            a.tabElement.dataset.actionId = a.id;
            return a.tabElement;
        }
        a.builtTab ??= (() => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'comfy-drawer-tab comfy-drawer-action-tab';
            tab.dataset.actionId = a.id;
            const icon = document.createElement('span');
            icon.className = 'comfy-drawer-tab-icon';
            icon.innerHTML = a.icon ?? '';
            tab.appendChild(icon);
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#bus.emit('drawer:close-popovers', { source: 'action' });
                a.action(tab);
            });
            return tab;
        })();
        a.builtTab.title = DrawerShell.#actionLabel(a);
        return a.builtTab;
    }

    static #actionLabel(a) {
        return String((typeof a.label === 'function' ? a.label() : a.label) ?? a.id);
    }

    /** Update active class without rebuilding DOM */
    #updateTabActive() {
        const tabs = this.#tabBar.querySelectorAll('.comfy-drawer-tab[data-gadget-id]');
        for (const tab of tabs) {
            tab.classList.toggle('active', tab.dataset.gadgetId === this.#activeId);
        }
    }

    #onTabClick(id) {
        if (this.#isOpen && this.#activeId === id) {
            if (this.#standalone) return;
            // Same tab clicked while open → close
            this.close();
        } else {
            // Open or switch tab
            this.open(id);
        }
    }

    /* ═══════════════════════════════════════════════════════
       Open / Close
       ═══════════════════════════════════════════════════════ */

    open(gadgetId) {
        // Deactivate previous
        if (this.#activeId && this.#activeId !== gadgetId) {
            const prevContainer = this.#containers.get(this.#activeId);
            if (prevContainer) prevContainer.style.display = 'none';
            const prev = this.#gadgets.get(this.#activeId);
            if (prev) prev.onDeactivate();
        }

        // Activate new
        const gadget = this.#gadgets.get(gadgetId);
        const container = this.#containers.get(gadgetId);
        if (!gadget || !container) return;

        this.#activeId = gadgetId;
        container.style.display = '';
        const wasMounted = this.#mounted.has(gadgetId);
        if (!wasMounted) {
            container.classList.add('comfy-drawer-gadget-mounting');
        }

        // Show panel (clamp height to viewport, then set for CSS transition)
        this.#isOpen = true;
        this.#clampHeight();
        this.#panel.style.height = `${this.#panelHeight}px`;
        this.#root.classList.add('open');
        // Standalone fills the viewport: re-measure with the tab bar docked.
        if (this.#standalone && this.#clampHeight()) {
            this.#panel.style.height = `${this.#panelHeight}px`;
        }
        this.#updateTabActive();
        this.#attachFocusGuard();
        this.#pushHistory();

        this.#bus.emit('drawer:opened', { gadgetId });
        this.#bus.emit('drawer:tab-changed', { tab: gadgetId });
        this.#applyLayout();

        const activate = () => {
            if (this.#activeId !== gadgetId) return;
            this.#mountGadget(gadgetId);
            gadget.onActivate();
        };
        if (wasMounted) {
            activate();
        } else {
            requestAnimationFrame(() => setTimeout(activate, 0));
        }
    }

    close() {
        // Standalone page: the panel is the whole app; there is nothing to reveal.
        if (!this.#isOpen || this.#standalone) return;

        // Deactivate current
        if (this.#activeId) {
            const container = this.#containers.get(this.#activeId);
            if (container) container.style.display = 'none';
            const gadget = this.#gadgets.get(this.#activeId);
            if (gadget) gadget.onDeactivate();
        }

        this.#isOpen = false;
        this.#activeId = null;
        this.#panel.style.height = '0';
        this.#root.classList.remove('open');
        this.#updateTabActive();
        this.#detachFocusGuard();
        this.#popHistory();

        this.#bus.emit('drawer:closed', {});
        this.#tabBar.style.maxWidth = '';
        this.#tabBar.style.alignSelf = '';
        // Floating pill always shows labels — compact only applies when panel is open
        this.#root.classList.remove('compact');
    }

    get isOpen() { return this.#isOpen; }
    get activeGadgetId() { return this.#activeId; }
    get hasFocus() { return this.#hasFocus; }

    /**
     * Return an array of all registered gadget instances (read-only snapshot).
     * @returns {import('./gadget-base.js').GadgetBase[]}
     */
    getGadgets() {
        return [...this.#gadgets.values()];
    }

    /* ── Hidden Gadgets Management ── */

    /**
     * Hide a gadget from the tab bar (moves it to the hamburger menu).
     * @param {string} id
     */
    hideGadget(id) {
        if (id === 'home') return;  // Home cannot be hidden
        this.#hiddenGadgets.add(id);
        this.#saveHiddenGadgets();
        this.#renderTabs();
        this.#bus.emit('drawer:gadget-visibility-changed', { id, hidden: true });
    }

    /**
     * Show a gadget in the tab bar (removes it from the hamburger menu).
     * @param {string} id
     */
    showGadget(id) {
        this.#hiddenGadgets.delete(id);
        this.#saveHiddenGadgets();
        this.#renderTabs();
        this.#bus.emit('drawer:gadget-visibility-changed', { id, hidden: false });
    }

    /**
     * Check if a gadget is hidden from the tab bar.
     * @param {string} id
     * @returns {boolean}
     */
    isGadgetHidden(id) {
        return this.#hiddenGadgets.has(id);
    }

    #loadHiddenGadgets() {
        try {
            const saved = localStorage.getItem(DrawerShell.HIDDEN_KEY);
            if (saved) {
                const arr = JSON.parse(saved);
                if (Array.isArray(arr)) arr.forEach(id => this.#hiddenGadgets.add(id));
            }
        } catch { /* ignore */ }
    }

    #saveHiddenGadgets() {
        localStorage.setItem(DrawerShell.HIDDEN_KEY, JSON.stringify([...this.#hiddenGadgets]));
    }

    /* ── Hamburger Menu ── */

    /** @type {{ id: string, icon: string, label: string|Function, action: Function, tabElement?: HTMLElement }[]} */
    #burgerActions = [];

    /**
     * Register an action in the menu. The user can pin it to the tab bar
     * (pin toggle on its menu row); `pinned` sets the initial placement.
     * @param {object} def
     * @param {string} [def.id] - stable id for the pinned state (defaults to the label)
     * @param {string} def.icon - SVG markup
     * @param {string|(() => string)} def.label
     * @param {(anchor: HTMLElement) => void} def.action - `anchor` is the element
     *        it was invoked from (the pinned tab, or the menu button) for popovers
     * @param {HTMLElement} [def.tabElement] - owner-managed element shown when
     *        pinned instead of a plain icon button; it handles its own clicks
     * @param {boolean} [def.pinned=false] - pinned until the user changes it
     * @param {number} [def.order=0] - position in the menu and tab bar (lower first)
     */
    addBurgerAction(def) {
        const id = String(def.id ?? (typeof def.label === 'function' ? def.label() : def.label));
        if (this.#burgerActions.some(a => a.id === id)) return;
        const action = { ...def, id };
        this.#burgerActions.push(action);
        this.#burgerActions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (def.pinned && !this.#pinState().has(id)) this.#pinnedActions.add(id);
        this.#renderTabs();
    }

    /** Whether a menu action is shown in the tab bar. */
    isActionPinned(id) {
        return this.#pinnedActions.has(id);
    }

    setActionPinned(id, pinned) {
        if (pinned) this.#pinnedActions.add(id);
        else this.#pinnedActions.delete(id);
        const state = this.#pinState();
        state.set(id, !!pinned);
        try { localStorage.setItem(DrawerShell.PINNED_KEY, JSON.stringify(Object.fromEntries(state))); } catch { /* ignore */ }
        this.#renderTabs();
        this.#bus.emit('drawer:action-pin-changed', { id, pinned: !!pinned });
    }

    /** Saved pin choices: id → pinned (only actions the user toggled). */
    #pinState() {
        try {
            const saved = JSON.parse(localStorage.getItem(DrawerShell.PINNED_KEY) || '{}');
            if (saved && typeof saved === 'object' && !Array.isArray(saved)) return new Map(Object.entries(saved));
        } catch { /* ignore */ }
        return new Map();
    }

    #loadPinnedActions() {
        for (const [id, pinned] of this.#pinState()) if (pinned) this.#pinnedActions.add(id);
    }

    static PIN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

    #toggleBurgerMenu(anchor) {
        // Close existing menu
        const existing = this.#root.querySelector('.comfy-drawer-burger-menu');
        if (existing) { existing.remove(); return; }

        const menu = document.createElement('div');
        menu.className = 'comfy-drawer-burger-menu';
        const close = () => {
            menu.remove();
            document.removeEventListener('pointerdown', closeHandler, true);
        };

        // Labels come from gadget definitions / action defs (some authored
        // by third parties) so they are set as text. Icons stay innerHTML
        // because the convention is raw SVG.
        const _buildBurgerItem = (iconHTML, labelText, iconClass = 'comfy-drawer-tab-icon') => {
            const item = document.createElement('div');
            item.className = 'comfy-drawer-burger-item';
            item.setAttribute('role', 'button');
            item.tabIndex = 0;
            const iconSpan = document.createElement('span');
            iconSpan.className = iconClass;
            iconSpan.innerHTML = iconHTML ?? '';
            const labelSpan = document.createElement('span');
            labelSpan.className = 'comfy-drawer-burger-label';
            labelSpan.textContent = labelText ?? '';
            item.append(iconSpan, labelSpan);
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
            });
            return item;
        };
        const t = (key, fallback) => window.ComfyDrawer?.t?.(key) ?? fallback;
        /** Pin toggle at the end of a row: shown in the tab bar or kept here. */
        const addPin = (item, pinned, onToggle) => {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = `comfy-drawer-burger-pin${pinned ? ' on' : ''}`;
            pin.innerHTML = DrawerShell.PIN_ICON;
            pin.title = pinned ? t('menu.unpin', 'Move to menu') : t('menu.pin', 'Show in tab bar');
            pin.setAttribute('aria-pressed', String(pinned));
            pin.addEventListener('click', (e) => {
                e.stopPropagation();
                onToggle(!pinned);
                close();
                this.#toggleBurgerMenu(this.#tabRow.querySelector('.comfy-drawer-burger') ?? anchor);
            });
            item.appendChild(pin);
        };
        const addSep = () => {
            const sep = document.createElement('div');
            sep.className = 'comfy-drawer-burger-sep';
            menu.appendChild(sep);
        };

        // Section 1: gadgets (Home always stays in the tab bar)
        const gadgets = [...this.#gadgets.values()].filter(g => g.id !== 'home')
            .sort((a, b) => a.order - b.order);
        for (const g of gadgets) {
            const item = _buildBurgerItem(g.icon, g.label);
            item.addEventListener('click', () => {
                close();
                this.open(g.id);
            });
            addPin(item, !this.#hiddenGadgets.has(g.id), (pin) => (pin ? this.showGadget(g.id) : this.hideGadget(g.id)));
            menu.appendChild(item);
        }

        // Section 2: actions (workflow, queue, settings, …)
        if (gadgets.length && this.#burgerActions.length) addSep();
        for (const a of this.#burgerActions) {
            const item = _buildBurgerItem(a.icon, DrawerShell.#actionLabel(a), 'comfy-drawer-burger-icon');
            item.addEventListener('click', () => {
                close();
                a.action(anchor);
            });
            addPin(item, this.#pinnedActions.has(a.id), (pin) => this.setActionPinned(a.id, pin));
            menu.appendChild(item);
        }

        // Align action (desktop only, when custom width is active)
        if (this.#desktopMQ?.matches && this.#panelWidth) {
            addSep();
            const alignLabel = this.#panelAlign === 'left' ? '→ Right' : '← Left';
            const alignItem = _buildBurgerItem(this.#alignIcon(), `Panel: ${alignLabel}`, 'comfy-drawer-burger-icon');
            alignItem.addEventListener('click', () => {
                close();
                this.#cycleAlign();
            });
            menu.appendChild(alignItem);
        }

        placeAboveTabBar(menu, anchor, this.#root);

        // Close on outside click
        const closeHandler = (e) => {
            if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
        };
        setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
    }

    /**
     * Add a persistent element above the tabs (the run progress strip).
     * It survives every tab rebuild.
     */
    addTabBarHeader(element) {
        this.#tabHeader.appendChild(element);
    }

    /* ═══════════════════════════════════════════════════════
       Focus Guard — click-to-focus between Drawer ↔ ComfyUI
       ═══════════════════════════════════════════════════════ */

    /**
     * Set up click-to-focus listeners.
     * - Click inside the drawer → focus drawer (block keys to ComfyUI)
     * - Click outside the drawer → focus ComfyUI (keys pass through)
     * - Visual indicator: panel border glows when drawer has focus
     */
    #attachFocusGuard() {
        this.#detachFocusGuard();
        this.#escController = new AbortController();
        const signal = this.#escController.signal;

        // Default: drawer gets focus when opened
        this.#setFocus(true);

        // Standalone page: no ComfyUI canvas to shield from keystrokes, and
        // Escape must not try to close the panel.
        if (this.#standalone) return;

        // --- Click tracking: which zone was last clicked? ---
        // Use capture phase so we fire BEFORE ComfyUI's canvas consumes the event.

        // Click inside drawer panel or tab bar → focus drawer
        this.#root.addEventListener('pointerdown', () => {
            this.#setFocus(true);
        }, { signal, capture: true });

        // Click outside drawer → focus ComfyUI
        document.addEventListener('pointerdown', (e) => {
            if (!this.#isOpen) return;
            if (DrawerShell.#isDrawerOwnedLayer(e.target)) {
                this.#setFocus(true);
                return;
            }
            this.#setFocus(false);
        }, { signal, capture: true });

        // --- Key blocking (only when drawer has focus) ---
        // Only block app-level keys that ComfyUI would use as shortcuts.
        // Browser-level shortcuts (F-keys, Ctrl+key, Alt+key, etc.) always pass through.

        document.addEventListener('keydown', (e) => {
            if (!this.#isOpen || !this.#hasFocus) return;

            // Always allow events targeting Drawer-owned UI layers. Some shared
            // overlays are appended to document.body rather than inside the
            // drawer root, but they still own their own keyboard behavior.
            if (DrawerShell.#isDrawerOwnedLayer(e.target)) return;

            // Allow browser-level shortcuts through
            if (this.#isBrowserShortcut(e)) return;

            // Escape: defer to let inner layers (lightbox, context menu) claim it first.
            // Each inner layer sets e._escapeClaimed = true if it handles Escape.
            if (e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                queueMicrotask(() => {
                    if (!e._escapeClaimed && this.#isOpen) this.close();
                });
                return;
            }

            // Block app-level key from reaching ComfyUI
            e.stopPropagation();
            e.preventDefault();
        }, { signal, capture: true });

        document.addEventListener('keyup', (e) => {
            if (!this.#isOpen || !this.#hasFocus) return;
            if (DrawerShell.#isDrawerOwnedLayer(e.target)) return;
            if (this.#isBrowserShortcut(e)) return;
            e.stopPropagation();
            e.preventDefault();
        }, { signal, capture: true });
    }

    /** Update focus state and visual indicator */
    #setFocus(focused) {
        if (this.#hasFocus === focused) return;
        this.#hasFocus = focused;
        this.#root.classList.toggle('focused', focused);
        this.#bus.emit('drawer:focus-changed', { focused });
    }

    /**
     * Returns true for keys that should ALWAYS pass through to the browser,
     * even when the drawer has focus. These are browser-level shortcuts
     * that have nothing to do with ComfyUI's app shortcuts.
     */
    #isBrowserShortcut(e) {
        // F1-F12 function keys (F5 = refresh, F12 = devtools, etc.)
        if (e.key.startsWith('F') && e.key.length <= 3 && !isNaN(e.key.slice(1))) return true;

        // Any combo with Ctrl, Alt, or Meta (Cmd) — browser/OS shortcuts
        if (e.ctrlKey || e.altKey || e.metaKey) return true;

        // Tab (browser focus navigation)
        if (e.key === 'Tab') return true;

        return false;
    }

    #detachFocusGuard() {
        if (this.#escController) {
            this.#escController.abort();
            this.#escController = null;
        }
        this.#hasFocus = false;
        this.#root?.classList.remove('focused');
    }

    /* ═══════════════════════════════════════════════════════
       History API — mobile back button (◁) support

       Strategy:
       - When a layer opens, push a history entry.
       - When the user presses the back button, popstate fires → close the topmost layer.
       - When a layer is closed programmatically (Escape, UI), we do NOT call
         history.back() (to avoid cascading navigation). Instead we leave the
         extra history entry — it's harmless and prevents page navigation.
       ═══════════════════════════════════════════════════════ */

    #pushHistory() {
        history.pushState({ comfyDrawer: 'panel' }, '');
        this.#historyPushed = true;
        if (!this.#popstateClosing) {
            window.addEventListener('popstate', this.#onPopState);
        }
    }

    #popHistory() {
        // Don't call history.back() — just mark as not pushed.
        // The stale history entry is harmless and avoids cascade issues.
        this.#historyPushed = false;
        window.removeEventListener('popstate', this.#onPopState);
    }

    /** Handler for browser back button */
    #onPopState = () => {
        window.removeEventListener('popstate', this.#onPopState);
        this.#historyPushed = false;
        // Emit bus event so inner layers (lightbox) can close first.
        // If an inner layer responds with 'drawer:back-handled', we suppress drawer close.
        this.#popstateClosing = false;
        this.#bus.emit('drawer:back-button');
        if (!this.#popstateClosing && this.#isOpen) {
            this.close();
        }
        this.#popstateClosing = false;
    };

    /**
     * Suppress drawer close when an inner layer (lightbox) handles the back button.
     * Called internally via bus event — not intended for external use.
     */
    #suppressBackClose() {
        this.#popstateClosing = true;
        // Re-push our own history entry since the inner layer consumed the pop
        history.pushState({ comfyDrawer: 'panel' }, '');
        this.#historyPushed = true;
        // Must register listener explicitly (pushHistory guard skips it during suppression)
        window.addEventListener('popstate', this.#onPopState);
    }

    /* ═══════════════════════════════════════════════════════
       Resize Handle
       ═══════════════════════════════════════════════════════ */

    #initResize() {
        let startY = 0, startH = 0;
        const SNAP_THRESHOLD = 20; // px proximity to trigger snap

        const onMove = (e) => {
            // Prevent page scroll while resizing on touch devices
            if (e.cancelable) e.preventDefault();
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const delta = startY - clientY;
            const tabBarH = this.#tabBar?.offsetHeight || 0;
            const maxH = window.innerHeight - DrawerShell.PANEL_TOP_MARGIN - tabBarH;
            let newH = Math.max(DrawerShell.PANEL_MIN, Math.min(maxH, startH + delta));

            // Snap to computed snap points
            const snaps = this.#computeSnapPoints();
            for (const snap of snaps) {
                if (Math.abs(newH - snap) < SNAP_THRESHOLD) {
                    newH = snap;
                    break;
                }
            }

            this.#panelHeight = newH;
            this.#topOffset = this.#heightToTopOffset(newH);
            if (this.#isOpen) this.#panel.style.height = `${newH}px`;
            // Notify gadgets
            const active = this.#gadgets.get(this.#activeId);
            if (active) active.onResize(newH);
            this.#bus.emit('drawer:panel-resized', { height: newH });
        };

        const onEnd = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.body.style.userSelect = '';
            this.#saveTopOffset();
        };

        const onStart = (e) => {
            startY = e.touches ? e.touches[0].clientY : e.clientY;
            startH = this.#panelHeight;
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        };

        this.#resizeHandle.addEventListener('mousedown', onStart);
        this.#resizeHandle.addEventListener('touchstart', onStart, { passive: false });
    }

    /* ═══════════════════════════════════════════════════════
       Desktop Width + Alignment
       ═══════════════════════════════════════════════════════ */

    #initSideResize() {
        // Shared width drag logic — returns new width delta handler
        const applyWidthDelta = (side, startX, startW, ev) => {
            const dx = ev.clientX - startX;
            const wDelta = side === 'right' ? dx : -dx;
            const maxW = window.innerWidth;
            const newW = Math.max(DrawerShell.PANEL_MIN_WIDTH, Math.min(maxW, startW + wDelta));
            if (newW >= maxW - 10) {
                this.#panelWidth = null;
                localStorage.removeItem(DrawerShell.WIDTH_KEY);
            } else {
                this.#panelWidth = newW;
            }
        };

        // Shared drag cleanup
        const finishDrag = (onMove, onEnd) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.body.style.userSelect = '';
            if (this.#panelWidth) localStorage.setItem(DrawerShell.WIDTH_KEY, Math.round(this.#panelWidth).toString());
            this.#saveTopOffset();
            this.#updateAlignBtn();
        };

        // Corner handles: diagonal (width + height)
        const CORNER_SNAP = 20;
        const startCornerDrag = (side, e) => {
            if (!this.#desktopMQ.matches || !this.#isOpen) return;
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            if (!this.#panelWidth) this.#panelWidth = this.#panel.getBoundingClientRect().width;
            const startW = this.#panelWidth;
            const startH = this.#panelHeight;
            document.body.style.userSelect = 'none';

            // Auto-set alignment: dragging left corner → right-align,
            // dragging right corner → left-align (panel grows toward the
            // opposite side from the grabbed corner).
            const newAlign = side === 'left' ? 'right' : 'left';
            if (this.#panelAlign !== newAlign) {
                this.#panelAlign = newAlign;
                localStorage.setItem(DrawerShell.ALIGN_KEY, newAlign);
                this.#updateAlignBtn();
            }

            const onMove = (ev) => {
                applyWidthDelta(side, startX, startW, ev);
                // Height with snap
                const dy = startY - ev.clientY;
                const tabBarH = this.#tabBar?.offsetHeight || 0;
                const maxH = window.innerHeight - DrawerShell.PANEL_TOP_MARGIN - tabBarH;
                let newH = Math.max(DrawerShell.PANEL_MIN, Math.min(maxH, startH + dy));
                // Snap to computed snap points
                const snaps = this.#computeSnapPoints();
                for (const snap of snaps) {
                    if (Math.abs(newH - snap) < CORNER_SNAP) {
                        newH = snap;
                        break;
                    }
                }
                this.#panelHeight = newH;
                this.#topOffset = this.#heightToTopOffset(newH);
                if (this.#isOpen) this.#panel.style.height = `${newH}px`;
                this.#applyLayout();
            };

            const onEnd = () => finishDrag(onMove, onEnd);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        };

        // Edge handles: horizontal only
        const startEdgeDrag = (side, e) => {
            if (!this.#desktopMQ.matches || !this.#isOpen) return;
            e.preventDefault();
            const startX = e.clientX;
            if (!this.#panelWidth) this.#panelWidth = this.#panel.getBoundingClientRect().width;
            const startW = this.#panelWidth;
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                applyWidthDelta(side, startX, startW, ev);
                this.#applyLayout();
            };

            const onEnd = () => finishDrag(onMove, onEnd);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        };

        this.#sideHandleL.addEventListener('mousedown', (e) => startCornerDrag('left', e));
        this.#sideHandleR.addEventListener('mousedown', (e) => startCornerDrag('right', e));
        this.#edgeHandleL.addEventListener('mousedown', (e) => startEdgeDrag('left', e));
        this.#edgeHandleR.addEventListener('mousedown', (e) => startEdgeDrag('right', e));
    }

    /** Apply desktop width + alignment to panel and tab bar */
    #applyLayout() {
        const isDesktop = this.#desktopMQ?.matches;
        const hasWidth = isDesktop && this.#panelWidth;

        // Handles: show/hide based on alignment and width state
        // (standalone page: fixed full-viewport panel, no resize handles)
        if (isDesktop && this.#isOpen && !this.#standalone) {
            if (this.#panelWidth) {
                // Custom width: show resize handles on the opposite side of alignment
                const showL = this.#panelAlign === 'right' ? 'block' : 'none';
                const showR = this.#panelAlign === 'left'  ? 'block' : 'none';
                this.#sideHandleL.style.display = showL;
                this.#sideHandleR.style.display = showR;
                this.#edgeHandleL.style.display = showL;
                this.#edgeHandleR.style.display = showR;
            } else {
                // Full width: show BOTH corner handles (for resize initiation)
                // but hide edge handles (horizontal-only resize makes no sense at full width)
                this.#sideHandleL.style.display = 'block';
                this.#sideHandleR.style.display = 'block';
                this.#edgeHandleL.style.display = 'none';
                this.#edgeHandleR.style.display = 'none';
            }
        } else {
            this.#sideHandleL.style.display = 'none';
            this.#sideHandleR.style.display = 'none';
            this.#edgeHandleL.style.display = 'none';
            this.#edgeHandleR.style.display = 'none';
        }

        if (hasWidth) {
            const w = `${this.#panelWidth}px`;
            const selfAlign = this.#panelAlign === 'left' ? 'flex-start' : 'flex-end';
            this.#panel.style.maxWidth = w;
            this.#panel.style.alignSelf = selfAlign;
            if (this.#isOpen) {
                this.#tabBar.style.maxWidth = w;
                this.#tabBar.style.alignSelf = selfAlign;
            }
        } else {
            this.#panel.style.maxWidth = '';
            this.#panel.style.alignSelf = '';
            this.#tabBar.style.maxWidth = '';
            this.#tabBar.style.alignSelf = '';
        }

        // Compact mode: mobile-like layout when panel is narrow
        this.#root.classList.toggle('compact', !!hasWidth && this.#panelWidth < 600);
    }

    #cycleAlign() {
        this.#panelAlign = this.#panelAlign === 'left' ? 'right' : 'left';
        localStorage.setItem(DrawerShell.ALIGN_KEY, this.#panelAlign);
        this.#applyLayout();
        this.#updateAlignBtn();
    }

    #alignIcon() {
        if (this.#panelAlign === 'left') {
            return `<svg viewBox="0 0 16 12" width="14" height="10"><rect x="0" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.7"/><rect x="12" y="1" width="4" height="10" rx="1" fill="currentColor" opacity="0.2"/></svg>`;
        }
        return `<svg viewBox="0 0 16 12" width="14" height="10"><rect x="0" y="1" width="4" height="10" rx="1" fill="currentColor" opacity="0.2"/><rect x="6" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.7"/></svg>`;
    }

    #updateAlignBtn() {
        // Align action is now in the burger menu — no tab bar button needed.
        // Keep the method as a no-op for any remaining callers.
    }

    /**
     * Compute dynamic snap points from ComfyUI's native header layout.
     * Returns sorted array of panel heights (px) where the drawer should snap.
     *
     * The drawer's visible top = window.innerHeight - tabBarH - panelHeight
     * To snap below a ComfyUI element at Y: panelHeight = window.innerHeight - tabBarH - Y
     *
     * Snap 1: Top edge just below ComfyUI's workflow tab bar
     * Snap 2: Top edge just below ComfyUI's status/progress bar
     */
    #computeSnapPoints() {
        const snaps = [];
        const tabBarH = this.#tabBar?.offsetHeight || 0;
        const winH = window.innerHeight;

        for (const sel of DrawerShell.SNAP_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) {
                const bottom = el.getBoundingClientRect().bottom;
                snaps.push(winH - tabBarH - bottom);
            }
        }

        return snaps.sort((a, b) => a - b);
    }

    /* ═══════════════════════════════════════════════════════
       Graph Change Detection
       ═══════════════════════════════════════════════════════ */

    /**
     * Notify the active gadget that the graph has changed.
     */
    #notifyGraphChanged() {
        this.#bus.emit('drawer:graph-changed', {});
        if (this.#isOpen && this.#activeId) {
            const gadget = this.#gadgets.get(this.#activeId);
            if (gadget && typeof gadget.onGraphChanged === 'function') {
                gadget.onGraphChanged();
            }
        }
    }

    /**
     * Public API: Trigger a full gadget refresh.
     * Same as a workflow tab switch — emits bus event + calls onGraphChanged().
     */
    refresh() {
        this.#notifyGraphChanged();
    }

    /**
     * Watch for workflow tab switches using two event sources:
     *
     * PRIMARY — drawer:graph-configured (DOM event).
     * ComfyUI V2 reuses the same LGraph object and calls configure()
     * to swap node content when switching tabs. comfy-drawer.js
     * monkey-patches LGraph.prototype.configure to emit this event.
     *
     * SUPPLEMENTARY — litegraph:set-graph (canvas event).
     * Fires on full graph object replacement (e.g. subgraph entry).
     * ComfyUI uses this internally (useNodeBadge). Covers edge cases
     * that configure() doesn't (e.g. same node IDs in a subgraph).
     */
    #watchGraphChanges() {
        // --- Primary: LGraph.configure hook (tab switch, workflow load) ---
        // LiteGraph calls configure() multiple times per tab switch
        // (once per component during deserialization), so we debounce
        // to coalesce into a single notification.
        let debounceTimer = null;
        this.#graphConfiguredHandler = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                this.#notifyGraphChanged();
            }, 50);
        };
        document.addEventListener('drawer:graph-configured', this.#graphConfiguredHandler);

        // --- Supplementary: full graph object swap (subgraph entry) ---
        this.#graphWatchDispose = this.#bridge.onGraphSwitch(() => {
            this.#notifyGraphChanged();
        });
    }

    /* ═══════════════════════════════════════════════════════
       Top-Offset ↔ Height Conversion

       The drawer stores the panel's TOP OFFSET (distance from the
       viewport top in px) rather than the panel height.  This way
       resizing the browser window keeps the panel's visual top
       position stable — height is recalculated as:
         height = viewportH - tabBarH - topOffset
       ═══════════════════════════════════════════════════════ */

    /** Convert a top-offset to a panel height for the current viewport */
    #topOffsetToHeight(top) {
        if (top == null) return null;
        const tabBarH = this.#tabBar?.offsetHeight || 0;
        const h = window.innerHeight - tabBarH - top;
        return h > 0 ? h : null;
    }

    /** Convert the current panel height to a top-offset */
    #heightToTopOffset(h) {
        const tabBarH = this.#tabBar?.offsetHeight || 0;
        return window.innerHeight - tabBarH - h;
    }

    /** Persist topOffset to localStorage */
    #saveTopOffset() {
        if (this.#topOffset != null) {
            localStorage.setItem(DrawerShell.STORAGE_KEY, Math.round(this.#topOffset).toString());
        }
    }

    /* ═══════════════════════════════════════════════════════
       Window Resize — recalculate height from saved top offset
       ═══════════════════════════════════════════════════════ */

    /**
     * Clamp #panelHeight to [PANEL_MIN .. viewport - PANEL_TOP_MARGIN].
     * If a topOffset is stored, recalculate height from it first so the
     * panel's visual top position is preserved across viewport changes.
     * @returns {boolean} true if the height was changed
     */
    #clampHeight() {
        if (this.#standalone) {
            const tabBarH = this.#tabBar?.offsetHeight || 0;
            const fullH = Math.max(DrawerShell.PANEL_MIN, window.innerHeight - tabBarH);
            const changed = fullH !== this.#panelHeight;
            this.#panelHeight = fullH;
            return changed;
        }
        // Recalculate height from stored top offset
        if (this.#topOffset != null) {
            const fromTop = this.#topOffsetToHeight(this.#topOffset);
            if (fromTop != null) this.#panelHeight = fromTop;
        }
        const tabBarH = this.#tabBar?.offsetHeight || 0;
        const maxH = window.innerHeight - DrawerShell.PANEL_TOP_MARGIN - tabBarH;
        const clamped = Math.max(DrawerShell.PANEL_MIN, Math.min(this.#panelHeight, maxH));
        if (clamped !== this.#panelHeight) {
            this.#panelHeight = clamped;
            this.#topOffset = this.#heightToTopOffset(clamped);
            return true;
        }
        return false;
    }

    #watchWindowResize() {
        window.addEventListener('resize', () => {
            if (!this.#isOpen) return;

            // Ignore resize events caused by the virtual keyboard.
            const ae = document.activeElement;
            if (ae) {
                const tag = ae.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return;
            }

            // Recalculate height from stored top offset
            this.#clampHeight();
            const newH = this.#panelHeight;

            this.#panel.style.height = `${newH}px`;

            // Notify active gadget
            const active = this.#gadgets.get(this.#activeId);
            if (active) active.onResize(newH);
            this.#bus.emit('drawer:panel-resized', { height: newH });
        });
    }
}
