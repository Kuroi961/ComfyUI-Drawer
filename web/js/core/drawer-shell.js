/**
 * ComfyDrawer — DrawerShell
 * The visual container: tab bar + sliding panel + resize handle.
 * Manages gadget panels and their lifecycle.
 */
export class DrawerShell {
    /** @type {import('./message-bus.js').MessageBus} */
    #bus;
    /** @type {import('./comfy-bridge.js').ComfyBridge} */
    #bridge;
    /** @type {Map<string, import('./gadget-base.js').GadgetBase>} */
    #gadgets = new Map();
    /** @type {Map<string, HTMLElement>} Shell-owned container references */
    #containers = new Map();
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
    #tabBarSuffix = [];
    /** @type {Set<string>} Gadget IDs hidden from the tab bar */
    #hiddenGadgets = new Set();

    static PANEL_MIN = 50;
    static PANEL_DEFAULT = 460;
    static PANEL_TOP_MARGIN = 8;
    static STORAGE_KEY = 'comfy-drawer-top';
    static WIDTH_KEY = 'comfy-drawer-width';
    static ALIGN_KEY = 'comfy-drawer-align';
    static PANEL_MIN_WIDTH = 320;
    static HIDDEN_KEY = 'comfy-drawer-hidden-gadgets';

    /** ComfyUI DOM selectors for panel snap points.
     *  Centralised here so a single edit fixes breakage from ComfyUI UI updates. */
    static SNAP_SELECTORS = ['.workflow-tabs', '#comfyui-body-top'];

    static #isEditableTarget(target) {
        if (!target || target.nodeType !== 1) return false;
        return !!target.closest('input, textarea, select, [contenteditable="true"]');
    }

    constructor(bus, bridge) {
        this.#bus = bus;
        this.#bridge = bridge;
        // Restore saved top offset; fall back to a default that gives PANEL_DEFAULT height
        const savedTop = parseInt(localStorage.getItem(DrawerShell.STORAGE_KEY));
        this.#topOffset = isNaN(savedTop) ? null : savedTop;
        this.#panelHeight = this.#topOffsetToHeight(this.#topOffset) || DrawerShell.PANEL_DEFAULT;
        this.#panelWidth = parseInt(localStorage.getItem(DrawerShell.WIDTH_KEY)) || null;
        this.#panelAlign = localStorage.getItem(DrawerShell.ALIGN_KEY) || 'left';
        this.#desktopMQ = window.matchMedia('(min-width: 601px)');
        this.#desktopMQ.addEventListener('change', () => this.#applyLayout());
        this.#clampHeight();  // Ensure stored height fits current viewport
        this.#saveTopOffset(); // Persist corrected value in case it was out-of-bounds
        this.#loadHiddenGadgets();
        this.#buildDOM();
        this.#watchGraphChanges();
        this.#watchWindowResize();

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
    registerGadget(gadget) {
        if (this.#gadgets.has(gadget.id)) {
            console.warn(`[ComfyDrawer] Gadget "${gadget.id}" already registered`);
            return;
        }

        // Create panel container for this gadget (Shell-owned)
        const container = document.createElement('div');
        container.className = `comfy-drawer-gadget gadget-${gadget.id}`;
        container.style.display = 'none';
        this.#panelBody.appendChild(container);
        this.#containers.set(gadget.id, container);

        // Mount the gadget
        gadget.mount(container, this.#bus, this.#bridge);
        this.#gadgets.set(gadget.id, gadget);

        // Rebuild tabs (sorted by order)
        this.#renderTabs();

        this.#bus.emit('drawer:gadget-registered', { id: gadget.id });
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

        // Rebuild tabs
        this.#renderTabs();

        this.#bus.emit('drawer:gadget-unregistered', { id });
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
        this.#tabBar.innerHTML = '';
        const gadgets = [...this.#gadgets.values()];
        const customOrder = this.#getTabOrder();

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

        // Separate visible vs hidden
        const visible = gadgets.filter(g => !this.#hiddenGadgets.has(g.id));
        const hidden  = gadgets.filter(g => this.#hiddenGadgets.has(g.id));

        for (const gadget of visible) {
            const tab = document.createElement('button');
            tab.className = 'comfy-drawer-tab';
            tab.dataset.gadgetId = gadget.id;
            tab.draggable = true;
            if (gadget.id === this.#activeId) tab.classList.add('active');

            tab.innerHTML = `
                <span class="comfy-drawer-tab-icon">${gadget.icon}</span>
                <span class="comfy-drawer-tab-label">${gadget.label}</span>
            `;
            tab.title = gadget.label;
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

            this.#tabBar.appendChild(tab);
        }

        // ── Hamburger menu (always present) ──
        const burger = document.createElement('button');
        burger.className = 'comfy-drawer-tab comfy-drawer-burger';
        burger.title = 'Menu';
        burger.innerHTML = `<span class="comfy-drawer-tab-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg></span>`;
        burger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#toggleBurgerMenu(burger, hidden);
        });
        this.#tabBar.appendChild(burger);
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
        gadget.onActivate();

        // Show panel (clamp height to viewport, then set for CSS transition)
        this.#isOpen = true;
        this.#clampHeight();
        this.#panel.style.height = `${this.#panelHeight}px`;
        this.#root.classList.add('open');
        this.#updateTabActive();
        this.#attachFocusGuard();
        this.#pushHistory();

        this.#bus.emit('drawer:opened', { gadgetId });
        this.#bus.emit('drawer:tab-changed', { tab: gadgetId });
        this.#applyLayout();
    }

    close() {
        if (!this.#isOpen) return;

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

    /** @type {{ icon: string, label: string, action: Function }[]} */
    #burgerActions = [];

    /**
     * Register a persistent action item in the burger menu.
     * @param {{ icon: string, label: string, action: Function }} actionDef
     */
    addBurgerAction(actionDef) {
        this.#burgerActions.push(actionDef);
    }

    #toggleBurgerMenu(anchor, hiddenGadgets) {
        // Close existing menu
        const existing = this.#root.querySelector('.comfy-drawer-burger-menu');
        if (existing) { existing.remove(); return; }

        const menu = document.createElement('div');
        menu.className = 'comfy-drawer-burger-menu';

        // Section 1: Hidden gadgets
        if (hiddenGadgets.length > 0) {
            for (const g of hiddenGadgets) {
                const item = document.createElement('button');
                item.className = 'comfy-drawer-burger-item';
                item.innerHTML = `<span class="comfy-drawer-tab-icon">${g.icon}</span><span>${g.label}</span>`;
                item.addEventListener('click', () => {
                    menu.remove();
                    this.open(g.id);
                });
                menu.appendChild(item);
            }
            // Divider
            const sep = document.createElement('div');
            sep.className = 'comfy-drawer-burger-sep';
            menu.appendChild(sep);
        }

        // Section 2: Registered actions (settings, reload, align, etc.)
        for (const a of this.#burgerActions) {
            const item = document.createElement('button');
            item.className = 'comfy-drawer-burger-item';
            item.innerHTML = `<span class="comfy-drawer-burger-icon">${a.icon}</span><span>${a.label}</span>`;
            item.addEventListener('click', () => {
                menu.remove();
                a.action();
            });
            menu.appendChild(item);
        }

        // Align action (desktop only, when custom width is active)
        if (this.#desktopMQ?.matches && this.#panelWidth) {
            const alignItem = document.createElement('button');
            alignItem.className = 'comfy-drawer-burger-item';
            const alignLabel = this.#panelAlign === 'left' ? '→ Right' : '← Left';
            alignItem.innerHTML = `<span class="comfy-drawer-burger-icon">${this.#alignIcon()}</span><span>Panel: ${alignLabel}</span>`;
            alignItem.addEventListener('click', () => {
                menu.remove();
                this.#cycleAlign();
            });
            menu.appendChild(alignItem);
        }

        // Position: append to root, placed above the burger button
        const rect = anchor.getBoundingClientRect();
        const rootRect = this.#root.getBoundingClientRect();
        menu.style.position = 'absolute';
        menu.style.bottom = `${rootRect.bottom - rect.top + 4}px`;
        menu.style.right = `${rootRect.right - rect.right}px`;
        this.#root.appendChild(menu);

        // Close on outside click
        const closeHandler = (e) => {
            if (!menu.contains(e.target) && !anchor.contains(e.target)) {
                menu.remove();
                document.removeEventListener('pointerdown', closeHandler, true);
            }
        };
        setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
    }

    /**
     * @deprecated Use addBurgerAction() instead.
     */
    addTabBarAction(element) {
        this.#tabBarSuffix.push(element);
        this.#tabBar.appendChild(element);
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

        // --- Click tracking: which zone was last clicked? ---
        // Use capture phase so we fire BEFORE ComfyUI's canvas consumes the event.

        // Click inside drawer panel or tab bar → focus drawer
        this.#root.addEventListener('pointerdown', () => {
            this.#setFocus(true);
        }, { signal, capture: true });

        // Click outside drawer → focus ComfyUI
        document.addEventListener('pointerdown', (e) => {
            if (!this.#isOpen) return;
            if (e.target.closest?.('.comfy-drawer')) return;
            if (e.target.closest?.('.cd-ctxmenu')) return;
            if (e.target.closest?.('.cd-ctxmenu-backdrop')) return;
            this.#setFocus(false);
        }, { signal, capture: true });

        // --- Key blocking (only when drawer has focus) ---
        // Only block app-level keys that ComfyUI would use as shortcuts.
        // Browser-level shortcuts (F-keys, Ctrl+key, Alt+key, etc.) always pass through.

        document.addEventListener('keydown', (e) => {
            if (!this.#isOpen || !this.#hasFocus) return;

            // Always allow events targeting elements inside the drawer
            if (e.target.closest?.('.comfy-drawer-panel')) return;

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
            if (e.target.closest?.('.comfy-drawer-panel')) return;
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
        if (isDesktop && this.#isOpen) {
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
