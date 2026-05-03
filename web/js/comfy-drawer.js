/**
 * ComfyDrawer — Main Entry Point
 * Registers with ComfyUI, initializes the platform components,
 * and exposes window.ComfyDrawer for gadgets to discover.
 *
 * == Public API (window.ComfyDrawer) ==
 *
 * Gadget lifecycle:
 *   GadgetBase            — Base class; extend to create a gadget
 *   registerGadget(g)     — Register a gadget instance with the drawer
 *
 * Platform services:
 *   bus                   — MessageBus for inter-gadget communication
 *   bridge                — ComfyBridge for ComfyUI API access
 *   contextMenu           — ContextMenuService for right-click / long-tap menus
 *   shell                 — DrawerShell for panel control
 *   settings              — localStorage-backed settings service
 *   dict                  — multi-dictionary autocomplete service
 *   maskService           — fullscreen mask editor service
 *
 * i18n:
 *   t / setLocale / getLocale / addMessages
 *   openSettingsPanel()
 *
 * Workflow:
 *   checkWorkflowAvailable(item) — Check if media has workflow metadata
 *   openWorkflowFromMedia(item)  — Load workflow from media metadata
 *
 * Utilities:
 *   openLightbox(items, startIndex?, options?)  — Open the media viewer
 *   closeLightbox()                              — Close the media viewer
 *   isLightboxOpen()                             — Check if lightbox is open
 *   removeLightboxItem(index)                    — Remove an item by index
 *   attachContextTrigger(el, handler)            — Right-click + long-tap helper
 *   attachDictAutocomplete(textarea, options?)   — Dictionary autocomplete for textareas
 *   createMediaCard(opts) / createMediaGrid(opts)
 *   showDialog / showAlert / showConfirm / showPrompt
 *   openImagePicker(opts)
 *   escapeHTML(s)                                — HTML escape for innerHTML safety
 *   truncate(s, max?)                            — Truncate string with '…'
 *   getLinkedInputNames(node)                    — Set of linked input names
 *   CollapseStore                                — localStorage-backed collapse state
 *   version                                      — Semver string
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { MessageBus } from "./core/message-bus.js";
import { ComfyBridge } from "./core/comfy-bridge.js";
import { DrawerShell } from "./core/drawer-shell.js";
import { ContextMenuService } from "./services/context-menu.js";
import { GadgetBase } from "./core/gadget-base.js";
import { openLightbox, closeLightbox, isLightboxOpen, removeLightboxItem } from "./services/lightbox.js";
import { createMediaCard, createMediaGrid } from "./components/media-card.js";
import { DictService, createDanbooruLoader, createUserDictLoader, createWildcardLoader, attachDictAutocomplete } from "./services/dict-service.js";
import { escapeHTML, truncate, getLinkedInputNames, CollapseStore } from "./utils.js";
import { showDialog, showAlert, showConfirm, showPrompt } from "./services/dialog.js";
import { openImagePicker } from "./services/image-picker.js";
import { MaskService }     from "./services/mask-service.js";
import { SettingsService } from "./services/settings.js";
import { openSettingsPanel } from "./services/settings-panel.js";
import { t, setLocale, getLocale, addMessages, initLocale } from "./services/locale.js";

// ── Built-in Gadgets ──
import { HomeGadget } from "../gadgets/home/home-gadget.js";
import { DeckGadget } from "../gadgets/deck/deck-gadget.js";
import { GalleryGadget } from "../gadgets/gallery/gallery-gadget.js";
import { XYZPlotGadget } from "../gadgets/xyzplot/xyzplot-gadget.js";
import { ModelViewerGadget } from "../gadgets/modelviewer/modelviewer-gadget.js";

const DYNAMIC_INPUT_NODES = {
    DrawerConcat: {
        prefix: 'string_',
        type: 'STRING',
        minVisible: 2,
        maxInputs: 64,
    },
    DrawerSwitchChain: {
        prefix: 'value_',
        type: '*',
        minVisible: 2,
        maxInputs: 64,
    },
};

function setupDynamicInputs(node) {
    const nodeType = node.comfyClass ?? node.type;
    const cfg = DYNAMIC_INPUT_NODES[nodeType];
    if (!cfg || node.__drawerDynamicInputs) return;

    node.__drawerDynamicInputs = true;
    const refresh = () => refreshDynamicInputs(node, cfg);
    const origConnectionsChange = node.onConnectionsChange;

    node.onConnectionsChange = function(...args) {
        const result = origConnectionsChange?.apply(this, args);
        refresh();
        return result;
    };

    requestAnimationFrame(refresh);
}

function refreshDynamicInputs(node, cfg) {
    if (!node.inputs) node.inputs = [];
    const inputs = node.inputs;
    const inputIndex = (input) => {
        const match = String(input?.name || '').match(new RegExp(`^${cfg.prefix}(\\d+)$`));
        return match ? Number(match[1]) : null;
    };
    const dynamicInputs = inputs
        .map((input, slot) => ({ input, slot, index: inputIndex(input) }))
        .filter(item => item.index !== null);

    let highestLinked = 0;
    for (const item of dynamicInputs) {
        if (item.input.link != null) highestLinked = Math.max(highestLinked, item.index);
    }

    const visibleCount = Math.min(
        cfg.maxInputs,
        Math.max(cfg.minVisible, highestLinked + 1)
    );

    for (let i = 1; i <= visibleCount; i++) {
        const name = `${cfg.prefix}${i}`;
        if (!node.inputs.some(input => input.name === name)) {
            addDynamicInput(node, cfg, name);
        }
    }

    for (let slot = node.inputs.length - 1; slot >= 0; slot--) {
        const input = node.inputs[slot];
        const index = inputIndex(input);
        if (index !== null && index > visibleCount && input.link == null) {
            node.removeInput(slot);
        }
    }

    node.setSize?.(node.computeSize?.() || node.size);
    app.graph?.setDirtyCanvas?.(true, true);
}

function addDynamicInput(node, cfg, name) {
    node.addInput(name, cfg.type, { shape: 7 });
    const newSlot = node.inputs.length - 1;
    const firstStaticSlot = node.inputs.findIndex((input, slot) =>
        slot !== newSlot && !String(input?.name || '').startsWith(cfg.prefix)
    );
    if (firstStaticSlot >= 0 && firstStaticSlot < newSlot) {
        const [input] = node.inputs.splice(newSlot, 1);
        node.inputs.splice(firstStaticSlot, 0, input);
    }
}

app.registerExtension({
    name: "Comfy.Drawer",

    nodeCreated(node) {
        const nodeType = node.comfyClass ?? node.type;

        // Wrap DrawerSeed mode widget callback to emit events on canvas changes
        if (nodeType === 'DrawerSeed') {
            const modeW = node.widgets?.find(w => w.name === 'mode');
            if (modeW && !modeW.__drawerWrapped) {
                const origCb = modeW.callback;
                modeW.callback = function(value, ...rest) {
                    if (origCb) origCb.call(this, value, ...rest);
                    document.dispatchEvent(new CustomEvent('drawer:seed-mode-changed', {
                        detail: { nodeId: node.id, value }
                    }));
                };
                modeW.__drawerWrapped = true;
            }
        }

        setupDynamicInputs(node);
    },

    async setup() {
        // DrawerSeed: monkeypatch queuePrompt to randomize unlocked seeds
        const origQueuePrompt = app.queuePrompt.bind(app);
        app.queuePrompt = async function(...args) {
            // Skip DrawerSeed randomization during XYZ sweep — the sweep
            // manages seeds via pinnedSnapshot for within-sweep consistency
            if (!window.__xyzSweepActive) {
                for (const node of app.graph._nodes) {
                    if (node.type !== 'DrawerSeed') continue;
                    const modeW = node.widgets?.find(w => w.name === 'mode');
                    const seedW = node.widgets?.find(w => w.name === 'seed_value');
                    if (modeW?.value === 'randomize' && seedW) {
                        seedW.value = Math.floor(Math.random() * 0xFFFFFFFF);
                    }
                }
            }
            return origQueuePrompt(...args);
        };

        // ── Hook LGraph.configure for graph-change detection ──
        // ComfyUI V2 reuses the same LGraph object and calls configure()
        // to swap content when switching workflow tabs. LiteGraph fires no
        // external event for this, so we monkey-patch configure() to emit
        // a DOM event that DrawerShell can listen for instead of polling.
        try {
            const LGraph = app.graph?.constructor;
            if (LGraph?.prototype?.configure) {
                const origConfigure = LGraph.prototype.configure;
                LGraph.prototype.configure = function(...args) {
                    const result = origConfigure.apply(this, args);
                    document.dispatchEvent(new CustomEvent('drawer:graph-configured'));
                    return result;
                };
            }
        } catch (e) {
            console.warn('[ComfyDrawer] Failed to hook LGraph.configure:', e);
        }

        // ── Inject CSS ──
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/drawer.css', import.meta.url).href;
        document.head.appendChild(link);

        const mcLink = document.createElement('link');
        mcLink.rel = 'stylesheet';
        mcLink.href = new URL('../css/media-card.css', import.meta.url).href;
        document.head.appendChild(mcLink);

        // ── Initialize platform components ──
        const bus = new MessageBus();
        const bridge = new ComfyBridge(app, api);
        const shell = new DrawerShell(bus, bridge);
        const contextMenu = new ContextMenuService();
        const settings = new SettingsService();

        // ── Accent color helper ──────────────────────────────────────────────────
        // Converts a hex color to all --cd-accent-* CSS variables on :root.
        // Called once on startup and whenever the accent setting changes.
        function _applyAccent(hex) {
            try {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                const d = (f) => `rgb(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)})`;
                const root = document.documentElement;
                root.style.setProperty('--cd-accent',        hex);
                root.style.setProperty('--cd-accent-hover',  d(0.86));
                root.style.setProperty('--cd-accent-dark',   d(0.74));
                root.style.setProperty('--cd-accent-glow',   `rgba(${r},${g},${b},0.33)`);
                root.style.setProperty('--cd-accent-dim',    `rgba(${r},${g},${b},0.20)`);
                root.style.setProperty('--cd-accent-subtle', `rgba(${r},${g},${b},0.13)`);
                root.style.setProperty('--cd-accent-mid',    `rgba(${r},${g},${b},0.60)`);
                root.style.setProperty('--cd-accent-low',    `rgba(${r},${g},${b},0.40)`);
            } catch (e) {
                console.warn('[ComfyDrawer] _applyAccent failed:', e);
            }
        }

        // ── Danger color helper ─────────────────────────────────────────────
        // Same pattern as _applyAccent but for --cd-danger-* variables.
        function _applyDanger(hex) {
            try {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                const root = document.documentElement;
                root.style.setProperty('--cd-danger',        hex);
                root.style.setProperty('--cd-danger-dark',   `rgb(${Math.round(r*0.42)},${Math.round(g*0.42)},${Math.round(b*0.42)})`);
                root.style.setProperty('--cd-danger-glow',   `rgba(${r},${g},${b},0.50)`);
                root.style.setProperty('--cd-danger-low',    `rgba(${r},${g},${b},0.40)`);
                root.style.setProperty('--cd-danger-subtle', `rgba(${r},${g},${b},0.13)`);
            } catch (e) {
                console.warn('[ComfyDrawer] _applyDanger failed:', e);
            }
        }

        // ── Shell color helper ───────────────────────────────────────────────
        // Derives the surface palette from a single base hex color.
        // Supports BOTH dark themes (L<0.5) and light themes (L≥0.5).
        // The base color itself is the overall Drawer window/panel color.
        // The main content surface is recessed, then controls rise back out.
        // Text color automatically inverts for light themes.
        function _applyShell(hex) {
            try {
                // ── hex → HSL ────────────────────────────────────────────────
                const ri = parseInt(hex.slice(1,3),16) / 255;
                const gi = parseInt(hex.slice(3,5),16) / 255;
                const bi = parseInt(hex.slice(5,7),16) / 255;
                const mx = Math.max(ri,gi,bi), mn = Math.min(ri,gi,bi);
                const d  = mx - mn;
                let H = 0;
                if (d > 0.001) {
                    if (mx === ri)      H = ((gi-bi)/d % 6 + 6) % 6;
                    else if (mx === gi) H = (bi-ri)/d + 2;
                    else                H = (ri-gi)/d + 4;
                    H *= 60;
                }
                const rawL = (mx + mn) / 2;
                const S    = (d < 0.001) ? 0 : d / (1 - Math.abs(2*rawL - 1));

                // ── Light / Dark decision ────────────────────────────────────
                const isLight = rawL > 0.50;
                // Use the user's exact lightness — no clamping
                const L = rawL;

                // Step direction for raised controls.
                const step = isLight ? -0.04 : 0.04;

                // ── HSL → hex helper ─────────────────────────────────────────
                const hsl2hex = (h, s, l) => {
                    l = Math.max(0, Math.min(1, l));
                    const hue2rgb = (p,q,t) => {
                        t = ((t % 1) + 1) % 1;
                        if (t < 1/6) return p + (q-p)*6*t;
                        if (t < 1/2) return q;
                        if (t < 2/3) return p + (q-p)*(2/3-t)*6;
                        return p;
                    };
                    const q = l < 0.5 ? l*(1+s) : l+s-l*s;
                    const p = 2*l - q;
                    const r = hue2rgb(p,q,h/360+1/3);
                    const g = hue2rgb(p,q,h/360);
                    const b = hue2rgb(p,q,h/360-1/3);
                    const x = v => Math.round(Math.min(255,v*255)).toString(16).padStart(2,'0');
                    return `#${x(r)}${x(g)}${x(b)}`;
                };

                // ── Surface palette ───────────────────────────────────────────
                // --cd-panel is the user's exact base color: the overall window.
                // Recess the main content surface, then let controls rise out:
                //   dark:  base -> darker -> lighter -> lighter
                //   light: base -> darker -> less-dark -> darker-control
                const shellL = isLight ? L - 0.070 : L - 0.035;
                const s1L    = isLight ? L : L + step;
                const s2L    = isLight ? L - 0.055 : L + step * 2;

                // Surface saturation: preserve color character, reduce only minimally
                const tintS = S * (isLight ? 0.40 : 0.65);

                const panel = hex;
                const shell = hsl2hex(H, tintS, shellL);
                const s1    = isLight ? hex : hsl2hex(H, tintS, s1L);
                const s2    = hsl2hex(H, tintS, s2L);

                // ── Text ─────────────────────────────────────────────────────
                // Dark theme: light text; Light theme: dark text
                const textTs = Math.min(tintS, 0.12);
                const textMain = isLight
                    ? hsl2hex(H, textTs, 0.10)   // near-black for light bg
                    : hsl2hex(H, textTs, 0.88);  // near-white for dark bg
                const textDim = isLight
                    ? hsl2hex(H, textTs, 0.38)
                    : hsl2hex(H, textTs, 0.52);

                // ── Divider ───────────────────────────────────────────────────
                const divider = isLight
                    ? 'rgba(0,0,0,0.10)'
                    : 'rgba(255,255,255,0.09)';

                // oklch proxies for any CSS that still uses oklch() syntax
                const oc  = (tintS * 0.07).toFixed(4);
                const oH  = Math.round(H);
                const oLs = L.toFixed(3);
                const oLl = shellL.toFixed(3);

                const root = document.documentElement;
                // ── Primary tokens ────────────────────────────────────────────
                root.style.setProperty('--cd-panel',    panel);
                root.style.setProperty('--cd-shell',    shell);
                root.style.setProperty('--cd-s1',       s1);
                root.style.setProperty('--cd-s2',       s2);
                root.style.setProperty('--cd-divider',  divider);
                root.style.setProperty('--cd-text',     textMain);
                root.style.setProperty('--cd-text-dim', textDim);

                // ── Legacy aliases ────────────────────────────────────────────
                root.style.setProperty('--cd-shell-deep', panel);
                root.style.setProperty('--cd-shell-1',    s1);
                root.style.setProperty('--cd-shell-2',    s2);
                root.style.setProperty('--cd-shell-3',    divider);
                root.style.setProperty('--cd-shell-4',    divider);
                root.style.setProperty('--cd-shell-5',    s2);

                // ── Panel oklch aliases ───────────────────────────────────────
                root.style.setProperty('--cd-panel-d', panel);
                root.style.setProperty('--cd-panel-l', s1);

                // ── Gadget surface tokens ─────────────────────────────────────
                root.style.setProperty('--gg-bg-elevated', shell);
                root.style.setProperty('--gg-bg-hover',    s2);
                root.style.setProperty('--gg-bg-surface',  s1);
                root.style.setProperty('--gg-bg-base',     panel);
                root.style.setProperty('--gg-border',      divider);
                root.style.setProperty('--gg-text',        textMain);

                // ── Theme class on <html> for CSS selectors ───────────────────
                root.classList.toggle('cd-theme-light', isLight);
                root.classList.toggle('cd-theme-dark',  !isLight);
            } catch(e) {
                console.warn('[ComfyDrawer] _applyShell failed:', e);
            }
        }



        // ── Initialize i18n (must come before any t() call) ──
        await initLocale(bridge);

        // ── Inject settings CSS ──
        const settingsLink = document.createElement('link');
        settingsLink.rel = 'stylesheet';
        settingsLink.href = new URL('../css/settings.css', import.meta.url).href;
        document.head.appendChild(settingsLink);

        // ── Initialize shared services ──
        const dict = new DictService(settings);
        dict.register('danbooru', {
            label: t('dict.danbooru'),
            load: createDanbooruLoader(),
            context: 'prompt',
            priority: 10,
            defaultEnabled: true,
        });
        dict.register('user', {
            label: t('dict.userDict'),
            load: createUserDictLoader(),
            context: 'all',
            priority: 5,
            defaultEnabled: true,
            settingsToggle: false,
        });
        dict.register('wildcard', {
            label: t('dict.wildcard'),
            load: createWildcardLoader(),
            context: 'prompt',
            priority: 4,
            defaultEnabled: true,
            settingsToggle: false,
        });
        dict.registerOnBus(bus);

        // ── Core metadata & workflow API ──

        /**
         * Resolve file info from an item object or its src URL.
         * Returns { src, name, subfolder, source } with defaults.
         */
        function resolveMediaInfo(item = {}) {
            const VALID_ROOTS = ['output', 'temp', 'input'];
            const src = item.src || '';
            let name = item.name || '';
            let subfolder = item.subfolder ?? '';
            // Only accept valid FS roots; context identifiers like 'gallery' are ignored
            let source = (item.source && VALID_ROOTS.includes(item.source)) ? item.source : '';
            // Always parse URL to supplement missing fields
            if (item.src) {
                try {
                    const u = new URL(item.src, location.origin);
                    if (!name) name = u.searchParams.get('filename') || '';
                    if (!subfolder) subfolder = u.searchParams.get('subfolder') || '';
                    // ComfyUI /view uses 'type', Drawer /drawer/fs/view uses 'root'
                    if (!source) source = u.searchParams.get('type') || u.searchParams.get('root') || 'output';
                } catch { /* non-parseable src */ }
            }
            if (!source) source = 'output';
            return { src, name, subfolder, source };
        }

        /**
         * Fetch metadata for a media item using the provider-first strategy:
         *   1. meta:read via Bus (third-party providers: SavePlus, etc.)
         *   2. /drawer/fs/meta (embedded: PNG tEXt, EXIF, video atoms)
         * Returns metadata object or null.
         */
        async function fetchMediaMeta(item) {
            const { name, subfolder, source } = resolveMediaInfo(item);
            if (!name) return null;

            let meta = null;

            // Step 1: Third-party metadata providers (SavePlus, etc.)
            if (bus.hasResponder('meta:read')) {
                try {
                    meta = await bus.request('meta:read', { subfolder, name });
                } catch { /* provider failed — fall through */ }
            }

            // Step 2: Embedded metadata (PNG tEXt, EXIF, video atoms)
            if (!meta || (!meta.prompt && !meta.workflow)) {
                const validRoots = ['output', 'temp', 'input'];
                const root = validRoots.includes(source) ? source : 'output';
                try {
                    const r = await fetch(
                        `/drawer/fs/meta?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&name=${encodeURIComponent(name)}`
                    );
                    if (r.ok) meta = await r.json();
                } catch { /* fetch failed — fall through */ }
            }

            return (meta && (meta.prompt || meta.workflow)) ? meta : null;
        }

        /**
         * Check if a media item has embedded workflow data.
         * Uses the same provider-first strategy as openWorkflowFromMedia.
         * @param {object} item - { src?, name?, subfolder?, source? }
         * @returns {Promise<boolean>}
         */
        async function checkWorkflowAvailable(item) {
            try {
                const meta = await fetchMediaMeta(item);
                return !!(meta?.workflow);
            } catch {
                return false;
            }
        }

        /**
         * Load a workflow from media metadata.
         * Tries metadata providers, then embedded metadata.
         * Does NOT fall back to handleFile(blob) to avoid side effects.
         * @returns {Promise<boolean>} true if workflow was loaded.
         */
        async function openWorkflowFromMedia(item) {
            const { name } = resolveMediaInfo(item);
            if (!name && !item.src) return false;

            const meta = await fetchMediaMeta(item);

            if (meta?.workflow) {
                try {
                    await bridge.loadWorkflow(meta.workflow, name);
                    closeLightbox();
                    return true;
                } catch (e) {
                    console.warn('[ComfyDrawer] loadWorkflow from meta failed:', e);
                }
            }

            return false;
        }

        /**
         * Platform-level media action: upload a media URL into ComfyUI input
         * and apply it to a LoadImage/LoadImageMask node.
         * Kept here because the action is registered by the platform and may
         * originate from any gadget's MediaCard or Lightbox.
         */
        async function sendMediaToLoadImageNode(ctx) {
            if (ctx?.type !== 'image' || ctx.targetNodeId == null) return false;
            const { src, name } = resolveMediaInfo(ctx);
            if (!src) return false;

            try {
                const imgResp = await fetch(src);
                if (!imgResp.ok) throw new Error('Failed to fetch image');
                const blob = await imgResp.blob();
                const filename = name || 'image.png';
                const fileObj = new File([blob], filename, { type: blob.type || 'image/png' });
                const uploadResult = await bridge.uploadImage(fileObj);
                const uploadedName = uploadResult.subfolder
                    ? `${uploadResult.subfolder}/${uploadResult.name}`
                    : uploadResult.name;

                bridge.addWidgetOption(ctx.targetNodeId, 'image', uploadedName);
                const applied = bridge.setWidgetValue(ctx.targetNodeId, 'image', uploadedName);
                if (!applied) {
                    console.warn('[ComfyDrawer] Failed to apply image to node:', ctx.targetNodeId);
                }
                return applied;
            } catch (e) {
                console.error('[ComfyDrawer] Send to LoadImage failed:', e);
                showAlert(e.message || String(e), { variant: 'danger' });
                return false;
            }
        }

        // ── Register shared context menu actions (media-file) ──
        // These are platform-level actions available to ALL gadgets.
        // Individual gadgets may add domain-specific actions (e.g. Gallery
        // adds delete/rename/select) via contextMenu.register().
        contextMenu.register('media-file', [
            {
                id: 'media:open-tab',
                label: t('menu.openNewTab'),
                icon: 'external-link',
                order: 10,
                action: (ctx) => window.open(ctx.src, '_blank'),
            },
            // 'Send to LoadImage' entries are dynamically registered below
            {
                id: 'media:workflow',
                label: t('menu.openAsWorkflow'),
                icon: 'workflow',
                order: 30,
                // Hide during XYZ sweep — loading a workflow mid-sweep would corrupt results
                visible: (ctx) => ctx.hasWorkflow !== false && !window.__xyzSweepActive,
                action: async (ctx) => {
                    const ok = await openWorkflowFromMedia(ctx);
                    if (!ok) showAlert(t('menu.noWorkflowData', { name: ctx.name || 'media' }));
                },
            },
            {
                id: 'media:download',
                label: t('menu.download'),
                icon: 'download',
                order: 40,
                action: (ctx) => {
                    const a = document.createElement('a');
                    a.href = ctx.src;
                    a.download = ctx.name || ctx.label || 'image';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                },
            },
        ]);

        // ── Dynamic "Send to LoadImage" per-node menu items ──
        // Refreshes whenever the graph changes so the list always
        // reflects the current set of LoadImage / LoadImageMask nodes.
        const SEND_PREFIX = 'media:send-to-';
        const refreshLoadImageMenu = () => {
            contextMenu.unregisterByPrefix(SEND_PREFIX);
            const loadImageNodes = [
                ...bridge.getNodesByType('LoadImage'),
                ...bridge.getNodesByType('LoadImageMask'),
            ];
            if (loadImageNodes.length === 0) return;

            // Single node → simple label; multiple → show node title/id
            const multi = loadImageNodes.length > 1;
            for (const node of loadImageNodes) {
                const cleanTitle = String(node.title || node.type || '')
                    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1FA00}-\u{1FAFF}]/gu, '')
                    .trim();
                const label = multi
                    ? t('menu.sendToNodeType', { type: node.type, title: cleanTitle || node.type })
                    : t('menu.sendToLoadImage');
                contextMenu.register('media-file', {
                    id: `${SEND_PREFIX}${node.id}`,
                    label,
                    icon: 'send',
                    order: 20,
                    visible: (ctx) => ctx.type === 'image',
                    action: (ctx) => sendMediaToLoadImageNode({ ...ctx, targetNodeId: node.id }),
                });
            }
        };
        // Initial registration
        refreshLoadImageMenu();
        // Re-register on graph changes
        bus.on('drawer:graph-changed', refreshLoadImageMenu);

        // ── Expose global API for gadgets ──
        // Third-party gadgets (or AI-generated gadgets) discover Drawer
        // via window.ComfyDrawer. No import paths required.
        const drawerAPI = {
            // ── Gadget lifecycle ──
            /** Base class for gadgets — extend this, no import needed */
            GadgetBase,
            /** Register a gadget with the drawer */
            registerGadget: (gadget) => shell.registerGadget(gadget),

            // ── Platform services ──
            /** MessageBus for inter-gadget communication */
            bus,
            /** ComfyBridge for ComfyUI API access */
            bridge,
            /** Shell for panel control */
            shell,
            /** Context menu service for right-click / long-tap actions */
            contextMenu,
            /** Settings service — get/set/onChange with localStorage persistence */
            settings,
            /** DictService — multi-dictionary autocomplete */
            dict,

            // ── i18n ──
            /** Translate a key with optional template params */
            t,
            /** Set the active locale (e.g. 'en', 'ja', 'zh') */
            setLocale,
            /** Get the current locale code */
            getLocale,
            /** Register additional messages for third-party gadgets */
            addMessages,
            /** Open the settings panel dialog */
            openSettingsPanel,

            // ── Utilities ──
            /** Open the shared media viewer (image/video/audio) */
            openLightbox,
            /** Close the media viewer */
            closeLightbox,
            /** Check if the media viewer is open */
            isLightboxOpen,
            /** Remove an item from the lightbox by index */
            removeLightboxItem,
            /** Right-click + long-tap handler; returns cleanup function */
            attachContextTrigger: ContextMenuService.attachTrigger,
            /** Attach dictionary autocomplete to any textarea */
            attachDictAutocomplete: (textarea, opts) => attachDictAutocomplete(dict, textarea, opts),
            /** Create a shared media card (thumbnail + lightbox + D&D) */
            createMediaCard,
            /** Create a responsive media grid container */
            createMediaGrid,

            // ── Shared Utilities (from utils.js) ──
            /** HTML-escape a string for safe innerHTML */
            escapeHTML,
            /** Truncate a string to max length with '…' */
            truncate,
            /** Get Set<string> of linked input names on a node */
            getLinkedInputNames,
            /** localStorage-backed collapse state manager */
            CollapseStore,

            // ── Dialogs ──
            /** Show a custom form dialog — returns Promise */
            showDialog,
            /** Show an alert dialog (OK only) */
            showAlert,
            /** Show a confirm dialog (OK/Cancel) → Promise<boolean> */
            showConfirm,
            /** Show a prompt dialog (text input) → Promise<string|null> */
            showPrompt,

            // ── Workflow ──
            /** Check if media item has workflow data → Promise<boolean> */
            checkWorkflowAvailable,
            /** Load workflow from media item (provider-first metadata) */
            openWorkflowFromMedia,

            // ── Image Picker ──
            /** Open a thumbnail-based image picker popup → Promise<string|null> */
            openImagePicker,

            // ── Mask Editor ──
            /** Open the mask editor overlay → Promise<{applied,filename}|null> */
            maskService: MaskService,

            /** Version for compatibility checks */
            version: '1.0.0',
        };

        window.ComfyDrawer = drawerAPI;

        // ── MaskService: context menu registration ──────────────────────────────
        contextMenu.register('media-file', [{
            id: 'media:create-mask',
            label: 'Create Mask',
            icon: 'brush',
            order: 31,
            visible: (c) => c.type === 'image',
            action:  (c) => MaskService.open({ url: c.src, filename: c.name, bridge }),
        }]);

        // ── Register built-in gadgets ──
        shell.registerGadget(new HomeGadget());
        shell.registerGadget(new XYZPlotGadget());
        shell.registerGadget(new DeckGadget());
        shell.registerGadget(new ModelViewerGadget());
        shell.registerGadget(new GalleryGadget());

        // ── Register utility actions in burger menu ──
        shell.addBurgerAction({
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
            label: t('settings.title'),
            action: () => openSettingsPanel(),
        });
        shell.addBurgerAction({
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
            label: t('home.drawerRefresh'),
            action: () => shell.refresh(),
        });
        shell.addBurgerAction({
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>',
            label: t('home.hardReload'),
            action: () => location.reload(),
        });
        shell.addBurgerAction({
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
            label: t('home.serverRestart'),
            action: async () => {
                const ok = await showConfirm(t('home.serverRestartConfirm'));
                if (!ok) return;
                try {
                    await fetch('/drawer/reboot');
                    showAlert(t('home.serverRestarting'));
                    const poll = setInterval(async () => {
                        try {
                            const r = await fetch('/system_stats', { signal: AbortSignal.timeout(2000) });
                            if (r.ok) { clearInterval(poll); location.reload(); }
                        } catch { /* still down */ }
                    }, 3000);
                } catch (e) {
                    showAlert(`Error: ${e.message}`);
                }
            },
        });

        // ── Relay ComfyUI 'executed' event to bus ──
        // Allows any gadget to react to generation completions via bus.
        bridge.onApiEvent('executed', () => {
            bus.emit('comfy:executed');
        });

        // ── Register utility settings ──

        // 1. Comment processing toggle (controls backend prompt comment stripping)
        const COMMENT_KEY = 'util.comments.enabled';
        settings.define(COMMENT_KEY, {
            type: 'toggle',
            label: t('settings.comments'),
            description: t('settings.commentsDesc'),
            section: t('settings.utility'),
            sectionOrder: 0,
            defaultValue: true,
            order: 10,
        });

        // Push saved preference to backend on startup
        const commentInitial = settings.get(COMMENT_KEY, true);
        fetch('/drawer/settings/comments-enabled', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: commentInitial }),
        }).catch(() => { /* backend unavailable */ });

        // Sync backend when setting changes
        settings.onChange(COMMENT_KEY, (_key, enabled) => {
            fetch('/drawer/settings/comments-enabled', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            // Notify Deck gadget to refresh highlights immediately
            bus.emit('settings:highlight-changed', { commentsEnabled: enabled });
        });

        // 2. Clear Drawer cache action
        settings.define('util.clearCache', {
            type: 'action',
            label: t('settings.clearCache'),
            description: t('settings.clearCacheDesc'),
            section: t('settings.utility'),
            sectionOrder: 0,
            buttonLabel: t('settings.clear'),
            dangerous: true,
            order: 90,
            action: async () => {
                const resp = await fetch('/drawer/clear-cache', { method: 'POST' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                const mb = (data.freedBytes / 1024 / 1024).toFixed(1);
                showAlert(t('settings.cacheCleared', { count: data.deleted, mb }));
            },
        });

        // 3. Theme color constants (declared early — referenced by preset onSelect)
        const ACCENT_KEY     = 'ComfyDrawer.Theme.AccentColor';
        const ACCENT_DEFAULT = '#3a9de0';
        const DANGER_KEY     = 'ComfyDrawer.Theme.DangerColor';
        const DANGER_DEFAULT = '#e05252';
        const SHELL_KEY      = 'ComfyDrawer.Theme.ShellColor';
        const SHELL_DEFAULT  = '#0d0d0d';

        // 4. Theme presets — curated accent+danger combinations
        //    Accent = primary UI highlight; Danger = cancel/destructive actions
        const THEMES = [
            { id: 'default',  name: t('theme.default'),  accent: '#3a9de0', danger: '#e05252', shell: '#0d0d0d' },
            { id: 'drawer',   name: t('theme.drawer'),   accent: '#7c5cfc', danger: '#cc3355', shell: '#0d0d1a' },
            { id: 'sakura',   name: t('theme.sakura'),   accent: '#ec4899', danger: '#6366f1', shell: '#160a0f' },
            { id: 'forest',   name: t('theme.forest'),   accent: '#10b981', danger: '#f59e0b', shell: '#071410' },
            { id: 'porcelain', name: t('theme.porcelain'), accent: '#2563eb', danger: '#dc2626', shell: '#f4f1ea' },
            { id: 'daylight',  name: t('theme.daylight'),  accent: '#0ea5e9', danger: '#e11d48', shell: '#eef6ff' },
            { id: 'mint',      name: t('theme.mint'),      accent: '#059669', danger: '#d97706', shell: '#eef8f1' },
        ];
        settings.define('ComfyDrawer.Theme.Preset', {
            type: 'preset-theme',
            label: t('settings.themePreset'),
            description: t('settings.themePresetDesc'),
            section: t('settings.theme'),
            sectionOrder: -1,
            order: 5,
            presets: THEMES,
            onSelect: (preset) => {
                settings.set(ACCENT_KEY, preset.accent);
                _applyAccent(preset.accent);
                settings.set(DANGER_KEY, preset.danger);
                _applyDanger(preset.danger);
                settings.set(SHELL_KEY, preset.shell);
                _applyShell(preset.shell);
            },
        });

        // 5. Color Palette — ベース / メイン / ディナイ in one row
        settings.define('ComfyDrawer.Theme.ColorPalette', {
            type: 'color-palette',
            section: t('settings.theme'),
            sectionOrder: -1,
            order: 10,
            colors: [
                { key: SHELL_KEY,  label: 'ベース',   defaultValue: SHELL_DEFAULT  },
                { key: ACCENT_KEY, label: 'メイン',   defaultValue: ACCENT_DEFAULT },
                { key: DANGER_KEY, label: 'ディナイ', defaultValue: DANGER_DEFAULT },
            ],
        });

        // Hidden backing defs (keep settings.get/onChange reactive without rendering own rows)
        settings.define(ACCENT_KEY, { hidden: true, defaultValue: ACCENT_DEFAULT });
        settings.define(DANGER_KEY, { hidden: true, defaultValue: DANGER_DEFAULT });
        settings.define(SHELL_KEY,  { hidden: true, defaultValue: SHELL_DEFAULT  });

        // Hidden: persistent theme mode ('custom' or a preset id) and saved custom colors.
        settings.define('ComfyDrawer.Theme.ActivePreset', { hidden: true, defaultValue: 'custom' });
        settings.define('ComfyDrawer.Theme.CustomAccent', { hidden: true, defaultValue: ACCENT_DEFAULT });
        settings.define('ComfyDrawer.Theme.CustomDanger', { hidden: true, defaultValue: DANGER_DEFAULT });
        settings.define('ComfyDrawer.Theme.CustomShell',  { hidden: true, defaultValue: SHELL_DEFAULT  });

        // Deprecated presets are no longer shown. Preserve the live colors as
        // a custom theme so old saved selections never become invisible states.
        const activePreset = settings.get('ComfyDrawer.Theme.ActivePreset', 'custom');
        if (activePreset !== 'custom' && activePreset !== '_dirty' && !THEMES.some(theme => theme.id === activePreset)) {
            settings.set('ComfyDrawer.Theme.ActivePreset', 'custom');
            settings.set('ComfyDrawer.Theme.CustomAccent', settings.get(ACCENT_KEY, ACCENT_DEFAULT));
            settings.set('ComfyDrawer.Theme.CustomDanger', settings.get(DANGER_KEY, DANGER_DEFAULT));
            settings.set('ComfyDrawer.Theme.CustomShell',  settings.get(SHELL_KEY,  SHELL_DEFAULT));
        }

        // ── One-time migration / initial setup ──────────────────────────────
        // If PRESET_KEY has never been explicitly saved (first run with this
        // persistence system, or upgrade from older builds), determine the
        // correct initial mode from current live colors — the ONLY place where
        // color-based detection is acceptable.  After this block, PRESET_KEY
        // is always set explicitly and color comparison is never needed again.
        if (!localStorage.getItem('ComfyDrawer.Theme.ActivePreset')) {
            const _liveA = settings.get(ACCENT_KEY, '');
            const _liveD = settings.get(DANGER_KEY, '');
            const _liveS = settings.get(SHELL_KEY,  '');
            const _match = THEMES.find(t =>
                t.accent === _liveA && t.danger === _liveD && t.shell === _liveS
            );
            settings.set('ComfyDrawer.Theme.ActivePreset', _match ? _match.id : 'custom');
            if (!_match) {
                // Custom mode: persist current live colors as the custom baseline
                settings.set('ComfyDrawer.Theme.CustomAccent', _liveA || ACCENT_DEFAULT);
                settings.set('ComfyDrawer.Theme.CustomDanger', _liveD || DANGER_DEFAULT);
                settings.set('ComfyDrawer.Theme.CustomShell',  _liveS || SHELL_DEFAULT);
            }
        }
        // ────────────────────────────────────────────────────────────────────

        _applyAccent(settings.get(ACCENT_KEY, ACCENT_DEFAULT));
        settings.onChange(ACCENT_KEY, (_key, value) => _applyAccent(value));

        _applyDanger(settings.get(DANGER_KEY, DANGER_DEFAULT));
        settings.onChange(DANGER_KEY, (_key, value) => _applyDanger(value));

        _applyShell(settings.get(SHELL_KEY, SHELL_DEFAULT));
        settings.onChange(SHELL_KEY, (_key, value) => _applyShell(value));


        // ── Notify any gadgets that were waiting for Drawer ──
        window.dispatchEvent(new CustomEvent('comfy-drawer:ready', { detail: drawerAPI }));

        // ── Auto-close drawer when ComfyUI shows a modal dialog ──
        // ComfyUI uses PrimeVue dialogs (.p-dialog-mask) and legacy .comfy-modal
        const isDialogNode = (node) => {
            if (node.nodeType !== 1) return false;
            if (node.classList?.contains('p-dialog-mask')) return true;
            if (node.classList?.contains('comfy-modal')) return true;
            if (node.tagName === 'DIALOG' && node.open) return true;
            // Check if the node contains a PrimeVue dialog
            if (node.querySelector?.('.p-dialog-mask, .comfy-modal, dialog[open]')) return true;
            return false;
        };
        const dialogObserver = new MutationObserver((mutations) => {
            if (!shell.isOpen) return;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (isDialogNode(node)) { shell.close(); return; }
                }
            }
        });
        dialogObserver.observe(document.body, { childList: true, subtree: true });

    },
});
