/**
 * ComfyDrawer — GadgetBase
 * Base class for all gadgets. Extend this to create a gadget.
 *
 * Gadgets are independent ComfyUI custom_nodes that register themselves
 * with ComfyDrawer at runtime. Think of Drawer as an OS and gadgets as apps.
 *
 * Third-party / AI-generated gadgets (no import needed):
 *   const { GadgetBase, registerGadget } = window.ComfyDrawer;
 *   class MyGadget extends GadgetBase {
 *     constructor() { super('my-gadget', { label: 'My Gadget', icon: '🎨' }); }
 *     onMount(container, bus, bridge) { container.innerHTML = '<h1>Hi</h1>'; }
 *   }
 *   registerGadget(new MyGadget());
 *
 * Lifecycle hooks (override as needed — no super calls required):
 *   onMount(container, bus, bridge)  — Build your UI here
 *   onActivate()                     — Tab selected (visible)
 *   onDeactivate()                   — Tab deselected (hidden)
 *   onGraphChanged()                 — Workflow switched
 *   onResize(height)                 — Panel resized
 *   onDestroy()                      — Cleanup (use addDisposable for auto-cleanup)
 *
 * CSS loading:
 *   Pass cssUrl in constructor options to auto-inject a stylesheet.
 *   The URL is resolved relative to the gadget's module via import.meta.url.
 *   class MyGadget extends GadgetBase {
 *     constructor() {
 *       super('my-gadget', {
 *         label: 'My Gadget',
 *         icon: '🎨',
 *         cssUrl: new URL('./my-gadget.css', import.meta.url).href,
 *       });
 *     }
 *   }
 */
export class GadgetBase {
    /** @type {string} Unique gadget identifier */
    id;
    /** @type {string} Display label */
    label;
    /** @type {string} SVG icon markup */
    icon;
    /** @type {number} Tab order (lower = left) */
    order;
    /** @type {string|null} CSS stylesheet URL to auto-inject on mount */
    cssUrl = null;
    /** @type {HTMLElement|null} DOM container provided by DrawerShell */
    container = null;
    /** @type {import('./message-bus.js').MessageBus|null} */
    bus = null;
    /** @type {import('./comfy-bridge.js').ComfyBridge|null} */
    bridge = null;
    /** @type {Array<Function>} Disposable cleanup functions */
    #disposables = [];

    /**
     * @param {string} id - Unique gadget ID (e.g. 'gallery', 'pilot')
     * @param {object} options
     * @param {string} options.label - Display name
     * @param {string} options.icon - SVG string for tab icon
     * @param {number} [options.order=0] - Tab ordering
     * @param {string} [options.cssUrl] - CSS URL to auto-inject (use new URL('./file.css', import.meta.url).href)
     */
    constructor(id, options = {}) {
        if (!id || typeof id !== 'string') {
            throw new Error('GadgetBase: id is required and must be a non-empty string');
        }
        this.id = id;
        this.label = options.label || id;
        this.icon = options.icon || '';
        this.order = options.order ?? 0;
        this.cssUrl = options.cssUrl || null;
    }

    /**
     * Shell-only mount method (treat as final — do not override).
     * Sets framework references, then calls onMount() for subclass UI setup.
     * This mirrors the destroy()/onDestroy() two-tier pattern: the Shell
     * calls mount(), not onMount(), ensuring container/bus/bridge are always
     * set even if a subclass forgets to call super.
     * @param {HTMLElement} container - DOM element to render into
     * @param {import('./message-bus.js').MessageBus} bus
     * @param {import('./comfy-bridge.js').ComfyBridge} bridge
     */
    mount(container, bus, bridge) {
        this.container = container;
        this.bus = bus;
        this.bridge = bridge;
        // Auto-inject CSS if cssUrl was provided
        if (this.cssUrl) {
            const cssId = `${this.id}-gadget-css`;
            if (!document.getElementById(cssId)) {
                const link = document.createElement('link');
                link.id = cssId;
                link.rel = 'stylesheet';
                link.href = this.cssUrl;
                document.head.appendChild(link);
            }
        }
        this.onMount(container, bus, bridge);
    }

    /**
     * Called when the gadget is mounted into the DrawerShell.
     * The container, bus, and bridge are already set before this is called.
     * Override to build your UI — no need to call super.
     * @param {HTMLElement} container - DOM element to render into
     * @param {import('./message-bus.js').MessageBus} bus
     * @param {import('./comfy-bridge.js').ComfyBridge} bridge
     */
    onMount(container, bus, bridge) { }

    /**
     * Called when this gadget's tab is selected (becomes visible).
     */
    onActivate() { }

    /**
     * Called when another gadget's tab is selected (becomes hidden).
     */
    onDeactivate() { }

    /**
     * Called when the ComfyUI workflow graph changes (e.g. user switches workflow tabs).
     * Override to refresh data that depends on the current graph.
     */
    onGraphChanged() { }

    /**
     * Called when the drawer panel is resized.
     * @param {number} height - New panel height in pixels
     */
    onResize(height) { }

    /**
     * Register a cleanup function to be called on destroy.
     * Use this to track bus subscriptions, event listeners, etc.
     * @param {Function} fn - Cleanup function (e.g. unsubscribe from bus)
     */
    addDisposable(fn) {
        if (typeof fn === 'function') this.#disposables.push(fn);
    }

    /**
     * Called when the gadget is being destroyed.
     * Override freely for custom cleanup — no need to call super.
     * Resource cleanup registered via addDisposable() is handled
     * automatically by destroy() after this method returns.
     */
    onDestroy() { }

    /**
     * Shell-only teardown method (treat as final — do not override).
     * Calls onDestroy() for subclass cleanup, then drains all disposables
     * and nulls framework references. This ensures disposables are always
     * cleaned up even if a subclass forgets to call super.
     */
    destroy() {
        this.onDestroy();
        for (const fn of this.#disposables) {
            try { fn(); } catch (e) { console.error(`[ComfyDrawer:${this.id}] Disposable error:`, e); }
        }
        this.#disposables.length = 0;
        this.container = null;
        this.bus = null;
        this.bridge = null;
    }
}
