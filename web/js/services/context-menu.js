/**
 * ComfyDrawer — ContextMenuService
 * A shared context menu that any gadget can register actions into.
 * The menu itself is "dumb" — it accepts, displays, and dispatches.
 * It has no knowledge of what the actions do.
 *
 * Usage:
 *   // Registration (in gadget.onMount)
 *   contextMenu.register('gallery-file', {
 *       id: 'gallery:send', label: 'Load Imageに送る', icon: 'send',
 *       order: 20, action: (file) => { ... }
 *   });
 *
 *   // Showing (in event handler)
 *   contextMenu.show('gallery-file', file, e.clientX, e.clientY);
 */
const iconSvg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
    'external-link': iconSvg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    send: iconSvg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
    workflow: iconSvg('<rect width="8" height="8" x="3" y="3" rx="2"/><rect width="8" height="8" x="13" y="13" rx="2"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/>'),
    download: iconSvg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
    brush: iconSvg('<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.01 0 1.01-.39 1.96-1.1 2.67 1.24.35 2.53.38 3.79.1 1.24-.28 2.38-.91 3.3-1.83a3 3 0 0 0-2.99-3.95Z"/>'),
    edit: iconSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    select: iconSvg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
    trash: iconSvg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
    folder: iconSvg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
    'folder-plus': iconSvg('<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
    info: iconSvg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    copy: iconSvg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    play: iconSvg('<path d="m5 3 14 9-14 9V3Z"/>'),
    refresh: iconSvg('<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    'refresh-cw': iconSvg('<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/>'),
};

const ICON_ALIASES = {
    '🔗': 'external-link',
    '📤': 'send',
    '📋': 'copy',
    '💾': 'download',
    '🖌️': 'brush',
    '✏️': 'edit',
    '☑': 'select',
    '🗑️': 'trash',
    '🗑': 'trash',
    '📁': 'folder-plus',
    '📂': 'folder',
    'ℹ️': 'info',
    '▶': 'play',
};

function resolveIcon(icon) {
    if (!icon) return '';
    const value = String(icon).trim();
    if (value.startsWith('<svg')) return value;
    return ICONS[value] || ICONS[ICON_ALIASES[value]] || '';
}

export class ContextMenuService {
    /** @type {Map<string, Array>} type → registered actions */
    #registry = new Map();

    /** @type {HTMLElement|null} Menu DOM element */
    #menuEl = null;

    /** @type {HTMLElement|null} Backdrop for click-outside */
    #backdropEl = null;

    /** @type {AbortController|null} Keyboard/scroll listeners */
    #abortCtrl = null;

    /** @type {boolean} */
    #visible = false;

    constructor() {
        this.#buildDOM();
    }

    /* ═══════════════════════════════════════════════════════
       DOM Construction
       ═══════════════════════════════════════════════════════ */

    #buildDOM() {
        // Inject CSS (once)
        if (!document.getElementById('cd-ctxmenu-css')) {
            const link = document.createElement('link');
            link.id = 'cd-ctxmenu-css';
            link.rel = 'stylesheet';
            link.href = new URL('../../css/context-menu.css', import.meta.url).href;
            document.head.appendChild(link);
        }

        // Backdrop
        this.#backdropEl = document.createElement('div');
        this.#backdropEl.className = 'cd-ctxmenu-backdrop';
        this.#backdropEl.style.display = 'none';
        this.#backdropEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hide();
        });
        this.#backdropEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.hide();
        });

        // Menu container
        this.#menuEl = document.createElement('div');
        this.#menuEl.className = 'cd-ctxmenu';
        this.#menuEl.addEventListener('contextmenu', (e) => e.preventDefault());

        document.body.appendChild(this.#backdropEl);
        document.body.appendChild(this.#menuEl);
    }

    /* ═══════════════════════════════════════════════════════
       Registration API
       ═══════════════════════════════════════════════════════ */

    /**
     * Register one or more actions for a context type.
     * @param {string} type - Context type (e.g. 'gallery-file')
     * @param {object|object[]} actions - Action(s) to register
     *   Each action: { id, label, icon?, order?, danger?, compact?, visible?, action: (context) => void }
     */
    register(type, actions) {
        if (!this.#registry.has(type)) this.#registry.set(type, []);
        const list = this.#registry.get(type);
        const toRegister = Array.isArray(actions) ? actions : [actions];

        for (const action of toRegister) {
            if (!action.id || !action.label || typeof action.action !== 'function') {
                console.warn('[ContextMenu] Invalid action — must have id, label, action:', action);
                continue;
            }
            // Remove existing action with same id (idempotent re-registration)
            const idx = list.findIndex(a => a.id === action.id);
            if (idx >= 0) list.splice(idx, 1);

            list.push({
                id: action.id,
                label: action.label,
                icon: action.icon || '',
                order: action.order ?? 50,
                danger: action.danger || false,
                compact: action.compact || false,
                visible: action.visible || null, // (context) => boolean
                action: action.action,
            });
        }
    }

    /**
     * Register default/fallback actions. Unlike register(), this will NOT
     * overwrite actions that are already registered with the same id.
     * @param {string} type - Context type
     * @param {object|object[]} actions - Fallback action(s)
     */
    registerDefaults(type, actions) {
        if (!this.#registry.has(type)) this.#registry.set(type, []);
        const list = this.#registry.get(type);
        const toRegister = Array.isArray(actions) ? actions : [actions];

        for (const action of toRegister) {
            if (!action.id || !action.label || typeof action.action !== 'function') {
                console.warn('[ContextMenu] Invalid action — must have id, label, action:', action);
                continue;
            }
            // Skip if already registered (don't overwrite)
            if (list.some(a => a.id === action.id)) continue;

            list.push({
                id: action.id,
                label: action.label,
                icon: action.icon || '',
                order: action.order ?? 50,
                danger: action.danger || false,
                compact: action.compact || false,
                visible: action.visible || null,
                action: action.action,
            });
        }
    }

    /**
     * Unregister all actions whose id starts with the given prefix.
     * Useful for cleanup when a gadget is destroyed.
     * @param {string} idPrefix - e.g. 'gallery:' removes all gallery actions
     */
    unregisterByPrefix(idPrefix) {
        for (const type of Array.from(this.#registry.keys())) {
            const list = this.#registry.get(type);
            const filtered = list.filter(a => !a.id.startsWith(idPrefix));
            if (filtered.length === 0) {
                this.#registry.delete(type);
            } else {
                this.#registry.set(type, filtered);
            }
        }
    }

    /* ═══════════════════════════════════════════════════════
       Show / Hide
       ═══════════════════════════════════════════════════════ */

    /**
     * Show the context menu at (x, y) for a given context type.
     * @param {string} type - Registered context type
     * @param {*} context - Data passed to action callbacks (e.g. a file object)
     * @param {number} x - Client X coordinate
     * @param {number} y - Client Y coordinate
     */
    show(type, context, x, y) {
        // Hide any existing menu first
        this.hide();

        const actions = this.#registry.get(type);
        if (!actions || actions.length === 0) return;

        // Filter by visibility and sort
        const visible = actions.filter(a => !a.visible || a.visible(context));
        if (visible.length === 0) return;

        // Sort: full-width actions first, compact icon actions in the footer.
        const normal = visible
            .filter(a => !a.compact && !a.danger)
            .sort((a, b) => a.order - b.order);
        const compact = visible
            .filter(a => a.compact)
            .sort((a, b) => a.order - b.order);
        const danger = visible
            .filter(a => !a.compact && a.danger)
            .sort((a, b) => a.order - b.order);

        // Build menu HTML
        this.#menuEl.innerHTML = '';

        for (const item of normal) {
            this.#menuEl.appendChild(this.#createItem(item, context));
        }

        if (normal.length > 0 && compact.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'cd-ctxmenu-sep';
            this.#menuEl.appendChild(sep);
        }

        if (compact.length > 0) {
            const footer = document.createElement('div');
            footer.className = 'cd-ctxmenu-footer';
            for (const item of compact) {
                footer.appendChild(this.#createCompactItem(item, context));
            }
            this.#menuEl.appendChild(footer);
        }

        if ((normal.length > 0 || compact.length > 0) && danger.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'cd-ctxmenu-sep';
            this.#menuEl.appendChild(sep);
        }

        for (const item of danger) {
            this.#menuEl.appendChild(this.#createItem(item, context));
        }

        // Position: render offscreen to measure, then place
        this.#menuEl.style.left = '0px';
        this.#menuEl.style.top = '0px';
        this.#menuEl.classList.remove('visible', 'origin-bottom-left', 'origin-top-right', 'origin-bottom-right');
        this.#menuEl.style.display = 'block';
        this.#backdropEl.style.display = 'block';

        // Use rAF to ensure layout is calculated before measuring
        requestAnimationFrame(() => {
            const menuW = this.#menuEl.offsetWidth;
            const menuH = this.#menuEl.offsetHeight;
            const vpW = window.innerWidth;
            const vpH = window.innerHeight;
            const PAD = 8;

            let posX = x;
            let posY = y;
            let flipX = false;
            let flipY = false;

            // Horizontal: flip if overflows right
            if (posX + menuW + PAD > vpW) {
                posX = x - menuW;
                flipX = true;
            }
            // Vertical: flip if overflows bottom
            if (posY + menuH + PAD > vpH) {
                posY = y - menuH;
                flipY = true;
            }

            // Clamp to viewport
            posX = Math.max(PAD, Math.min(posX, vpW - menuW - PAD));
            posY = Math.max(PAD, Math.min(posY, vpH - menuH - PAD));

            this.#menuEl.style.left = `${posX}px`;
            this.#menuEl.style.top = `${posY}px`;

            // Set transform origin for animation
            if (flipY && flipX) this.#menuEl.classList.add('origin-bottom-right');
            else if (flipY) this.#menuEl.classList.add('origin-bottom-left');
            else if (flipX) this.#menuEl.classList.add('origin-top-right');
            // default: origin-top-left (CSS default)

            // Trigger appear animation
            this.#menuEl.classList.add('visible');
            this.#visible = true;

            // Attach dismiss listeners
            this.#attachDismiss();
        });
    }

    /**
     * Hide the context menu.
     */
    hide() {
        if (!this.#visible) return;
        this.#visible = false;
        this.#menuEl.classList.remove('visible');
        this.#backdropEl.style.display = 'none';

        // Clean up after animation
        setTimeout(() => {
            if (!this.#visible) {
                this.#menuEl.style.display = 'none';
                this.#menuEl.innerHTML = '';
            }
        }, 160);

        this.#detachDismiss();
    }

    /** @returns {boolean} Whether the menu is currently visible */
    get isVisible() { return this.#visible; }

    /* ═══════════════════════════════════════════════════════
       Internal Helpers
       ═══════════════════════════════════════════════════════ */

    #createItem(actionDef, context) {
        const btn = document.createElement('button');
        btn.className = 'cd-ctxmenu-item';
        if (actionDef.danger) btn.classList.add('cd-ctxmenu-danger');

        if (actionDef.icon) {
            const icon = document.createElement('span');
            icon.className = 'cd-ctxmenu-icon';
            const svg = resolveIcon(actionDef.icon);
            if (svg) {
                icon.innerHTML = svg;
            } else {
                icon.textContent = actionDef.icon;
            }
            btn.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'cd-ctxmenu-label';
        label.textContent = actionDef.label;
        btn.appendChild(label);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
            try {
                actionDef.action(context);
            } catch (err) {
                console.error(`[ContextMenu] Error in action "${actionDef.id}":`, err);
            }
        });

        return btn;
    }

    #createCompactItem(actionDef, context) {
        const btn = document.createElement('button');
        btn.className = 'cd-ctxmenu-compact-item';
        if (actionDef.danger) btn.classList.add('cd-ctxmenu-danger');
        btn.title = actionDef.label;
        btn.setAttribute('aria-label', actionDef.label);

        const icon = document.createElement('span');
        icon.className = 'cd-ctxmenu-icon';
        const svg = resolveIcon(actionDef.icon);
        if (svg) {
            icon.innerHTML = svg;
        } else {
            icon.textContent = actionDef.icon || actionDef.label;
        }
        btn.appendChild(icon);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
            try {
                actionDef.action(context);
            } catch (err) {
                console.error(`[ContextMenu] Error in action "${actionDef.id}":`, err);
            }
        });

        return btn;
    }

    #attachDismiss() {
        this.#detachDismiss();
        this.#abortCtrl = new AbortController();
        const signal = this.#abortCtrl.signal;

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e._escapeClaimed = true;
                e.stopPropagation();
                this.hide();
            }
        }, { signal, capture: true });

        // Close on scroll (any scrollable ancestor)
        window.addEventListener('scroll', () => this.hide(), { signal, capture: true, passive: true });
    }

    #detachDismiss() {
        if (this.#abortCtrl) {
            this.#abortCtrl.abort();
            this.#abortCtrl = null;
        }
    }

    /* ═══════════════════════════════════════════════════════
       Long-tap helper (for mobile)
       ═══════════════════════════════════════════════════════ */

    /**
     * Attach long-tap (500ms) and right-click handlers to an element.
     * Returns a cleanup function.
     * @param {HTMLElement} el - Element to watch
     * @param {function(Event)} handler - Called with the triggering event
     * @returns {function} Cleanup function
     */
    static attachTrigger(el, handler) {
        // Right-click
        const onContext = (e) => {
            e.preventDefault();
            e.stopPropagation();
            handler(e);
        };
        el.addEventListener('contextmenu', onContext);

        // Long-tap
        let longTapTimer = null;
        let startX = 0, startY = 0;
        let fired = false;

        const onTouchStart = (e) => {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            fired = false;
            longTapTimer = setTimeout(() => {
                fired = true;
                // Create a synthetic event-like object with coordinates
                handler({
                    clientX: startX,
                    clientY: startY,
                    preventDefault: () => {},
                    stopPropagation: () => {},
                });
            }, 500);
        };

        const onTouchMove = (e) => {
            if (longTapTimer === null) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                clearTimeout(longTapTimer);
                longTapTimer = null;
            }
        };

        const onTouchEnd = (e) => {
            if (longTapTimer !== null) {
                clearTimeout(longTapTimer);
                longTapTimer = null;
            }
            // Suppress click if long-tap fired
            if (fired) {
                e.preventDefault();
                e.stopPropagation();
                fired = false;
            }
        };

        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: true });
        el.addEventListener('touchend', onTouchEnd);
        el.addEventListener('touchcancel', onTouchEnd);

        return () => {
            el.removeEventListener('contextmenu', onContext);
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
            if (longTapTimer !== null) clearTimeout(longTapTimer);
        };
    }
}
