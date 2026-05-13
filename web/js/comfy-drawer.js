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
 *   registerHomeWidget(w) — Register a Home dashboard widget
 *   unregisterHomeWidget(id) / getHomeWidgets()
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
import { DictService, createDanbooruLoader, createUserDictLoader, createWildcardLoader, createNodeTypeLoader, createThirdPartyDictLoader, attachDictAutocomplete } from "./services/dict-service.js";
import { escapeHTML, truncate, getLinkedInputNames, CollapseStore, sanitizeComfyDrawerWorkflowExtra } from "./utils.js";
import { showDialog, showAlert, showConfirm, showPrompt } from "./services/dialog.js";
import { openImagePicker } from "./services/image-picker.js";
import { MaskService }     from "./services/mask-service.js";
import { SettingsService } from "./services/settings.js";
import { openSettingsPanel } from "./services/settings-panel.js";
import { t, setLocale, getLocale, addMessages, initLocale } from "./services/locale.js";
import { DRAWER_VERSION } from "./version.js";
import { enumerateLoadImageTargets } from "./utils/widget-targets.js";

const BUILT_IN_ICONS = {
    home: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
    xyzplot: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 10.5 15 9"/><path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M4.293 19.707 6 18"/><path d="m9 15 1.5-1.5"/></svg>`,
    deck: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"/><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/></svg>`,
    modelviewer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
    gallery: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"/><path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"/><circle cx="13" cy="7" r="1" fill="currentColor"/><rect x="8" y="2" width="14" height="14" rx="2"/></svg>`,
};

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

async function loadDrawerVersion(fallback) {
    try {
        const resp = await fetch(api.apiURL('/drawer/version'), { cache: 'no-store' });
        if (!resp.ok) return fallback;
        const data = await resp.json();
        return typeof data?.version === 'string' && data.version ? data.version : fallback;
    } catch {
        return fallback;
    }
}

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
        const drawerVersion = await loadDrawerVersion(DRAWER_VERSION);

        // DrawerSeed: monkeypatch queuePrompt to randomize unlocked seeds
        if (!app.__comfyDrawerQueuePromptWrapped) {
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
                            const buf = new Uint32Array(1);
                            if (globalThis.crypto?.getRandomValues) {
                                globalThis.crypto.getRandomValues(buf);
                                seedW.value = buf[0];
                            } else {
                                seedW.value = Math.floor(Math.random() * 0xFFFFFFFF);
                            }
                        }
                    }
                }
                return origQueuePrompt(...args);
            };
            app.__comfyDrawerQueuePromptWrapped = true;
        }

        // ── Hook LGraph for graph-change detection and clean metadata export ──
        // ComfyUI V2 reuses the same LGraph object and calls configure()
        // to swap content when switching workflow tabs. LiteGraph fires no
        // external event for this, so we monkey-patch configure() to emit
        // a DOM event that DrawerShell can listen for instead of polling.
        try {
            const LGraph = app.graph?.constructor;
            if (LGraph?.prototype?.configure && !LGraph.prototype.__comfyDrawerConfigureWrapped) {
                const origConfigure = LGraph.prototype.configure;
                LGraph.prototype.configure = function(...args) {
                    const result = origConfigure.apply(this, args);
                    document.dispatchEvent(new CustomEvent('drawer:graph-configured'));
                    return result;
                };
                LGraph.prototype.__comfyDrawerConfigureWrapped = true;
            }
            if (LGraph?.prototype?.serialize && !LGraph.prototype.__comfyDrawerSerializeWrapped) {
                const origSerialize = LGraph.prototype.serialize;
                LGraph.prototype.serialize = function(...args) {
                    return sanitizeComfyDrawerWorkflowExtra(origSerialize.apply(this, args));
                };
                LGraph.prototype.__comfyDrawerSerializeWrapped = true;
            }
        } catch (e) {
            console.warn('[ComfyDrawer] Failed to hook LGraph:', e);
        }

        const loadStylesheetOnce = (id, href) => new Promise((resolve) => {
            const existing = document.getElementById(id);
            if (existing) {
                resolve();
                return;
            }
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href = href;
            const done = () => resolve();
            link.addEventListener('load', done, { once: true });
            link.addEventListener('error', done, { once: true });
            document.head.appendChild(link);
            setTimeout(done, 1200);
        });

        const createDrawerBootPlaceholder = () => {
            const root = document.createElement('div');
            root.id = 'comfy-drawer-boot';
            root.style.cssText = [
                'position:fixed',
                'left:50%',
                'bottom:14px',
                'transform:translateX(-50%)',
                'z-index:9999',
                'display:flex',
                'align-items:center',
                'gap:10px',
                'height:46px',
                'padding:0 16px',
                'border-radius:14px',
                'border:1px solid rgba(255,255,255,0.10)',
                'background:rgba(10,10,10,0.88)',
                'color:rgba(255,255,255,0.72)',
                'font:600 13px system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif',
                'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
                'pointer-events:none',
            ].join(';');
            const dot = document.createElement('span');
            dot.style.cssText = [
                'width:12px',
                'height:12px',
                'border:2px solid currentColor',
                'border-right-color:transparent',
                'border-radius:50%',
                'display:inline-block',
                'animation:comfy-drawer-boot-spin 0.8s linear infinite',
            ].join(';');
            if (!document.getElementById('comfy-drawer-boot-style')) {
                const style = document.createElement('style');
                style.id = 'comfy-drawer-boot-style';
                style.textContent = '@keyframes comfy-drawer-boot-spin{to{transform:rotate(360deg)}}';
                document.head.appendChild(style);
            }
            const label = document.createElement('span');
            label.textContent = 'Loading';
            root.append(dot, label);
            document.body.appendChild(root);
            return root;
        };

        const bootPlaceholder = createDrawerBootPlaceholder();

        const initializeDrawerPlatform = async () => {
        // ── Inject CSS ──
        await loadStylesheetOnce('comfy-drawer-css', new URL('../css/drawer.css', import.meta.url).href);
        await loadStylesheetOnce('comfy-drawer-media-card-css', new URL('../css/media-card.css', import.meta.url).href);
        await loadStylesheetOnce('comfy-drawer-dialog-css', new URL('../css/dialog.css', import.meta.url).href);
        await loadStylesheetOnce('comfy-drawer-settings-css', new URL('../css/settings.css', import.meta.url).href);

        // ── Initialize platform components ──
        const bus = new MessageBus();
        const bridge = new ComfyBridge(app, api);
        const shell = new DrawerShell(bus, bridge);

        const homeWidgets = new Map();
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
        dict.register('nodeTypes', {
            label: t('dict.nodeTypes'),
            load: createNodeTypeLoader(),
            context: 'search',
            priority: 6,
            defaultEnabled: true,
        });
        let hasThirdPartyDictProviders = false;
        try {
            const resp = await bridge.fetchApi('/drawer/dict/third-party/status');
            if (resp.ok) {
                const payload = await resp.json();
                hasThirdPartyDictProviders = Boolean(payload?.hasProviders);
            }
        } catch { /* optional third-party dictionary providers */ }
        if (hasThirdPartyDictProviders) {
            dict.register('thirdParty', {
                label: t('dict.customMetadataKeys') || 'Custom metadata keys',
                load: createThirdPartyDictLoader(),
                context: 'search',
                priority: 7,
                defaultEnabled: true,
            });
        }
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
                    const r = await bridge.fetchApi(
                        `/drawer/fs/meta?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&name=${encodeURIComponent(name)}`
                    );
                    if (r.ok) meta = await r.json();
                } catch { /* fetch failed — fall through */ }
            }

            return (meta && typeof meta === 'object' && Object.keys(meta).length) ? meta : null;
        }

        function canOpenWorkflowFromMeta(meta, item = {}) {
            if (meta?.workflow) return true;
            const name = String(item?.name || '').toLowerCase();
            const src = String(item?.src || '').toLowerCase();
            const isPng = name.endsWith('.png') || src.includes('.png');
            return isPng && !!meta?.a1111;
        }

        function showToast(message, { duration = 2500 } = {}) {
            const el = document.createElement('div');
            el.className = 'cd-toast';
            el.textContent = message;
            document.body.appendChild(el);
            requestAnimationFrame(() => el.classList.add('visible'));
            setTimeout(() => {
                el.classList.remove('visible');
                setTimeout(() => el.remove(), 250);
            }, duration);
        }

        async function openMediaViaNativeHandler(item, name) {
            if (!item?.src || !bridge?.handleFile) return false;
            try {
                const response = await fetch(item.src);
                if (!response.ok) return false;
                const blob = await response.blob();
                const file = new File([blob], name || item.name || 'media.png', {
                    type: blob.type || 'image/png',
                });
                await bridge.handleFile(file);
                closeLightbox();
                return true;
            } catch (e) {
                console.warn('[ComfyDrawer] native media import failed:', e);
                return false;
            }
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
                return canOpenWorkflowFromMeta(meta, item);
            } catch {
                return false;
            }
        }

        async function checkMetadataAvailable(item) {
            try {
                return !!(await fetchMediaMeta(item));
            } catch {
                return false;
            }
        }

        /**
         * Load a workflow from media metadata.
         * Tries ComfyUI workflow JSON directly. For A1111/NAI-style image
         * metadata, delegates to ComfyUI's native handleFile importer.
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
            if (canOpenWorkflowFromMeta(meta, { ...item, name })) {
                return await openMediaViaNativeHandler(item, name);
            }

            return false;
        }

        async function showMediaMetadata(ctx) {
            const { name, subfolder, source } = resolveMediaInfo(ctx);
            const meta = await fetchMediaMeta(ctx);
            if (!meta) {
                await showAlert(t('menu.noMetadataData', { name: name || ctx.name || 'media' }), { variant: 'info' });
                return;
            }

            const json = JSON.stringify(meta, null, 2);
            const workflow = meta.workflow && typeof meta.workflow === 'object' ? meta.workflow : null;
            const prompt = meta.prompt && typeof meta.prompt === 'object' ? meta.prompt : null;
            const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
            const groups = Array.isArray(workflow?.groups) ? workflow.groups : [];
            const promptNodes = prompt
                ? Object.entries(prompt)
                    .map(([id, node]) => ({
                        id,
                        type: node?.class_type || node?.type || 'Unknown',
                        title: node?._meta?.title || node?.title || '',
                        mode: node?.mode,
                        widgets_values: Array.isArray(node?.widgets_values) ? node.widgets_values : [],
                    }))
                    .filter(node => node.type)
                : [];
            const overviewNodes = nodes.length ? nodes : promptNodes;
            let thirdPartySections = [];
            try {
                const validRoots = ['output', 'temp', 'input'];
                const root = validRoots.includes(source) ? source : 'output';
                const r = await bridge.fetchApi(
                    `/drawer/fs/meta-panels?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&name=${encodeURIComponent(name)}`
                );
                if (r.ok) {
                    const payload = await r.json();
                    thirdPartySections = Array.isArray(payload?.sections) ? payload.sections : [];
                }
            } catch { /* optional third-party display sections */ }
            const visibleTypesKey = 'comfy-drawer-meta-visible-types';
            const showLabelsKey = 'comfy-drawer-meta-show-labels';
            const getAllowedTypes = () => {
                try { return new Set(JSON.parse(localStorage.getItem(visibleTypesKey) || '[]')); }
                catch { return new Set(); }
            };
            const saveAllowedTypes = (set) => {
                localStorage.setItem(visibleTypesKey, JSON.stringify([...set]));
            };
            const allNodeTypes = new Map();
            for (const node of overviewNodes) {
                const type = node?.type || node?.class_type || 'Unknown';
                if (!allNodeTypes.has(type)) allNodeTypes.set(type, []);
                allNodeTypes.get(type).push(node);
            }
            const getVisibleNodeTypes = () => {
                const allowed = getAllowedTypes();
                return [...allNodeTypes.entries()]
                    .filter(([type]) => allowed.has(type))
                    .sort((a, b) => a[0].localeCompare(b[0]));
            };

            const addRow = (parent, label, value) => {
                const row = document.createElement('div');
                row.className = 'cd-meta-row';
                const key = document.createElement('div');
                key.className = 'cd-meta-key';
                key.textContent = label;
                const val = document.createElement('div');
                val.className = 'cd-meta-value';
                val.textContent = value || '—';
                row.append(key, val);
                parent.appendChild(row);
            };

            const addTextarea = (parent, value, className = '') => {
                const textarea = document.createElement('textarea');
                textarea.className = `cd-dialog-input cd-dialog-json-viewer ${className}`.trim();
                textarea.readOnly = true;
                textarea.spellcheck = false;
                textarea.wrap = 'soft';
                textarea.value = value;
                parent.appendChild(textarea);
            };

            const addTextBlock = (parent, label, value) => {
                if (value == null || value === '') return;
                const group = document.createElement('div');
                group.className = 'cd-meta-text-group';
                const title = document.createElement('div');
                title.className = 'cd-meta-key';
                title.textContent = label;
                const block = document.createElement('textarea');
                block.className = 'cd-dialog-input cd-dialog-json-viewer cd-meta-prompt-box';
                block.readOnly = true;
                block.spellcheck = false;
                block.wrap = 'soft';
                block.value = String(value);
                group.append(title, block);
                parent.appendChild(group);
            };

            const addSettingGrid = (parent, settings) => {
                if (!settings || typeof settings !== 'object') return;
                const entries = Object.entries(settings)
                    .filter(([, value]) => value != null && value !== '');
                if (!entries.length) return;
                const grid = document.createElement('div');
                grid.className = 'cd-meta-setting-grid';
                for (const [key, value] of entries) {
                    const item = document.createElement('div');
                    item.className = 'cd-meta-setting';
                    const k = document.createElement('div');
                    k.className = 'cd-meta-setting-key';
                    k.textContent = key;
                    const v = document.createElement('div');
                    v.className = 'cd-meta-setting-value';
                    v.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    item.append(k, v);
                    grid.appendChild(item);
                }
                parent.appendChild(grid);
            };

            const addGenerationOverview = (parent, meta) => {
                const sources = [];
                if (meta?.a1111 && typeof meta.a1111 === 'object') {
                    sources.push({
                        title: 'A1111 Overview',
                        data: meta.a1111,
                        negativeKey: 'negative_prompt',
                    });
                }
                if (meta?.nai && typeof meta.nai === 'object') {
                    sources.push({
                        title: 'NovelAI Overview',
                        data: meta.nai,
                        negativeKey: 'negative_prompt',
                    });
                }
                for (const sourceMeta of sources) {
                    const section = document.createElement('section');
                    section.className = 'cd-meta-section cd-meta-generation';
                    const title = document.createElement('h3');
                    title.textContent = sourceMeta.title;
                    section.appendChild(title);

                    const data = sourceMeta.data;
                    addTextBlock(section, 'Prompt', data.prompt);
                    addTextBlock(section, 'Negative Prompt', data[sourceMeta.negativeKey] ?? data.uc);

                    if (data.settings && typeof data.settings === 'object') {
                        addSettingGrid(section, data.settings);
                    } else {
                        const hidden = new Set(['parameters', 'prompt', 'negative_prompt', 'uc']);
                        const settings = {};
                        for (const [key, value] of Object.entries(data)) {
                            if (!hidden.has(key) && value != null && value !== '') settings[key] = value;
                        }
                        addSettingGrid(section, settings);
                    }
                    parent.appendChild(section);
                }
            };

            const formatControlValues = (values) => {
                const pairs = [];
                for (let i = 0; i < values.length; i += 2) {
                    const value = values[i];
                    const def = String(values[i + 1] ?? '');
                    const parts = def.split('|').map(part => part.trim());
                    const label = parts[1] || parts[0] || `value_${(i / 2) + 1}`;
                    if (value == null || value === '') continue;
                    pairs.push(`${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
                }
                return pairs;
            };

            const formatWidgetValues = (node, values) => {
                const widgetInputs = Array.isArray(node?.inputs)
                    ? node.inputs.filter(input => input?.widget)
                    : [];
                if (!widgetInputs.length) {
                    try {
                        const nodeDef = LiteGraph?.registered_node_types?.[node?.type]?.nodeData;
                        const objectInfoInputs = [
                            ...Object.entries(nodeDef?.input?.required || {}),
                            ...Object.entries(nodeDef?.input?.optional || {}),
                        ];
                        for (const [name, spec] of objectInfoInputs) {
                            const options = Array.isArray(spec) ? spec[1] : null;
                            const type = Array.isArray(spec) ? spec[0] : null;
                            const isWidgetLike = Array.isArray(type)
                                || options?.default !== undefined
                                || ['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'].includes(String(type));
                            if (isWidgetLike) widgetInputs.push({ name });
                        }
                    } catch { /* keep value_N fallback */ }
                }
                return values.map((value, index) => {
                    if (value == null || value === '') return '';
                    const input = widgetInputs[index];
                    const label = input?.label || input?.localized_name || input?.widget?.name || input?.name || `value_${index + 1}`;
                    return `${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
                }).filter(Boolean);
            };

            const formatPromptInputValues = (node) => {
                const inputs = prompt?.[String(node?.id)]?.inputs;
                if (!inputs || typeof inputs !== 'object') return [];
                const pairs = [];
                for (const [name, rawValue] of Object.entries(inputs)) {
                    if (name === 'model' || name === 'clip' || name === 'vae') continue;
                    if (Array.isArray(rawValue)) continue;
                    if (rawValue == null || rawValue === '') continue;
                    pairs.push(`${name}: ${typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue)}`);
                }
                return pairs;
            };

            const stripValueLabel = (line) => {
                const sep = line.indexOf(': ');
                return sep >= 0 ? line.slice(sep + 2) : line;
            };

            const formatNodeValue = (node, showLabels = true) => {
                const title = node?.title && node.title !== node.type ? node.title : '';
                const mode = node?.mode === 4 ? 'bypass' : (node?.mode === 2 ? 'mute' : 'active');
                const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
                const isDrawerControls = /^DrawerControls\d*$/.test(String(node?.type || ''));
                const promptValues = formatPromptInputValues(node);
                const displayValues = promptValues.length
                    ? (isDrawerControls ? formatControlValues(values) : promptValues)
                    : (isDrawerControls ? formatControlValues(values) : formatWidgetValues(node, values));
                const valueLines = showLabels ? displayValues : displayValues.map(stripValueLabel);
                return [
                    `#${node?.id ?? '?'}${title ? `  ${title}` : ''}`,
                    `mode: ${mode}`,
                    ...valueLines,
                ].filter(Boolean).join('\n');
            };

            await showDialog({
                title: t('menu.viewMetadataTitle', { name: name || ctx.name || 'media' }),
                variant: 'info',
                confirmLabel: t('common.close'),
                showCancel: false,
                autoFocus: false,
                content: (body) => {
                    const wrap = document.createElement('div');
                    wrap.className = 'cd-meta-view';

                    const summary = document.createElement('section');
                    summary.className = 'cd-meta-section';
                    const summaryTitle = document.createElement('h3');
                    summaryTitle.textContent = 'Summary';
                    summary.appendChild(summaryTitle);
                    addRow(summary, 'File', name || ctx.name || 'media');
                    addRow(summary, 'Location', [source, subfolder].filter(Boolean).join('/') || source);
                    addRow(
                        summary,
                        'Workflow',
                        workflow
                            ? `${nodes.length} nodes, ${groups.length} groups`
                            : (promptNodes.length
                                ? `${promptNodes.length} prompt nodes`
                                : (canOpenWorkflowFromMeta(meta, { name, src: ctx.src }) ? 'Importable metadata' : 'Metadata only'))
                    );
                    wrap.appendChild(summary);

                    addGenerationOverview(wrap, meta);

                    if (workflow || promptNodes.length) {
                        const section = document.createElement('section');
                        section.className = 'cd-meta-section';
                        const title = document.createElement('h3');
                        title.textContent = 'Workflow Overview';
                        section.appendChild(title);

                        const visibleControls = document.createElement('details');
                        visibleControls.className = 'cd-meta-type-controls';
                        const visibleSummary = document.createElement('summary');
                        visibleSummary.className = 'cd-meta-type-summary';
                        visibleControls.appendChild(visibleSummary);
                        const visibleBody = document.createElement('div');
                        visibleBody.className = 'cd-meta-type-body';
                        const addSelect = document.createElement('select');
                        addSelect.className = 'cd-dialog-select cd-meta-type-select';
                        const allowedList = document.createElement('div');
                        allowedList.className = 'cd-meta-allowed-list';
                        visibleBody.append(addSelect, allowedList);
                        visibleControls.appendChild(visibleBody);
                        section.appendChild(visibleControls);

                        const chips = document.createElement('div');
                        chips.className = 'cd-meta-chips';
                        const nodeList = document.createElement('textarea');
                        nodeList.className = 'cd-dialog-input cd-dialog-json-viewer cd-meta-node-list';
                        nodeList.readOnly = true;
                        nodeList.spellcheck = false;
                        nodeList.wrap = 'soft';
                        const showLabelsRow = document.createElement('label');
                        showLabelsRow.className = 'cd-meta-option';
                        const showLabelsInput = document.createElement('input');
                        showLabelsInput.type = 'checkbox';
                        showLabelsInput.checked = localStorage.getItem(showLabelsKey) !== 'false';
                        const showLabelsText = document.createElement('span');
                        showLabelsText.textContent = 'Show labels';
                        showLabelsRow.append(showLabelsInput, showLabelsText);

                        let selectedType = '';
                        const selectType = (type, button = null) => {
                            selectedType = type;
                            chips.querySelectorAll('.cd-meta-chip').forEach(el => el.classList.remove('active'));
                            const target = button || [...chips.querySelectorAll('.cd-meta-chip')]
                                .find(el => el.dataset.nodeType === type);
                            target?.classList.add('active');
                            const selectedNodes = allNodeTypes.get(type) || [];
                            nodeList.value = selectedNodes
                                .map(node => formatNodeValue(node, showLabelsInput.checked))
                                .join('\n\n');
                        };

                        const refreshTypeControls = () => {
                            const allowed = getAllowedTypes();
                            const allowedPresent = [...allowed].filter(type => allNodeTypes.has(type)).sort();
                            visibleSummary.textContent = allowedPresent.length === 0
                                ? 'Shown node types'
                                : `${allowedPresent.length} shown node type${allowedPresent.length === 1 ? '' : 's'}`;
                            addSelect.replaceChildren();
                            const placeholder = document.createElement('option');
                            placeholder.value = '';
                            placeholder.textContent = 'Add node type…';
                            addSelect.appendChild(placeholder);
                            for (const [type, typeNodes] of [...allNodeTypes.entries()]
                                .filter(([type]) => !allowed.has(type))
                                .sort((a, b) => a[0].localeCompare(b[0]))) {
                                const option = document.createElement('option');
                                option.value = type;
                                option.textContent = `${type} × ${typeNodes.length}`;
                                addSelect.appendChild(option);
                            }

                            allowedList.replaceChildren();
                            for (const type of allowedPresent) {
                                const remove = document.createElement('button');
                                remove.type = 'button';
                                remove.className = 'cd-meta-allowed-chip';
                                remove.textContent = `${type} × ${allNodeTypes.get(type).length}`;
                                remove.title = 'Click to hide from metadata view';
                                remove.addEventListener('click', () => {
                                    const next = getAllowedTypes();
                                    next.delete(type);
                                    saveAllowedTypes(next);
                                    renderTypeButtons();
                                });
                                allowedList.appendChild(remove);
                            }
                        };

                        const renderTypeButtons = () => {
                            const visibleTypes = getVisibleNodeTypes();
                            chips.replaceChildren();
                            for (const [type, typeNodes] of visibleTypes) {
                                const chip = document.createElement('button');
                                chip.type = 'button';
                                chip.className = 'cd-meta-chip';
                                chip.dataset.nodeType = type;
                                chip.textContent = `${type} × ${typeNodes.length}`;
                                chip.addEventListener('click', () => selectType(type, chip));
                                chips.appendChild(chip);
                            }
                            refreshTypeControls();
                            if (selectedType && visibleTypes.some(([type]) => type === selectedType)) {
                                selectType(selectedType);
                            } else if (visibleTypes[0]) {
                                selectType(visibleTypes[0][0]);
                            } else {
                                selectedType = '';
                                nodeList.value = 'Add node types above to show their metadata values.';
                            }
                        };

                        addSelect.addEventListener('change', () => {
                            if (!addSelect.value) return;
                            const allowed = getAllowedTypes();
                            allowed.add(addSelect.value);
                            saveAllowedTypes(allowed);
                            selectedType = addSelect.value;
                            addSelect.value = '';
                            renderTypeButtons();
                        });
                        showLabelsInput.addEventListener('change', () => {
                            localStorage.setItem(showLabelsKey, showLabelsInput.checked ? 'true' : 'false');
                            if (selectedType) selectType(selectedType);
                        });

                        section.appendChild(showLabelsRow);
                        section.appendChild(chips);
                        section.appendChild(nodeList);
                        wrap.appendChild(section);
                        renderTypeButtons();
                    }

                    for (const contributed of thirdPartySections) {
                        const section = document.createElement('section');
                        section.className = 'cd-meta-section';
                        const title = document.createElement('h3');
                        title.textContent = contributed.title || 'Third-party Metadata';
                        section.appendChild(title);
                        const rows = Array.isArray(contributed.rows) ? contributed.rows : [];
                        for (const row of rows) {
                            addRow(section, row.label || '', row.value || '');
                        }
                        if (contributed.text) {
                            addTextarea(section, contributed.text);
                        }
                        wrap.appendChild(section);
                    }

                    const raw = document.createElement('details');
                    raw.className = 'cd-meta-section cd-meta-raw';
                    const rawSummary = document.createElement('summary');
                    rawSummary.textContent = 'Raw JSON';
                    raw.appendChild(rawSummary);
                    addTextarea(raw, json);
                    wrap.appendChild(raw);

                    body.appendChild(wrap);
                    return () => true;
                },
            });
        }

        async function syncMediaMetadataIndex(ctx) {
            const { name, subfolder, source } = resolveMediaInfo(ctx);
            const validRoots = ['output', 'temp', 'input'];
            const root = validRoots.includes(ctx.root) ? ctx.root : (validRoots.includes(source) ? source : 'output');
            if (!name || root === 'temp') {
                await showAlert(t('menu.syncMetadataFailed'), { variant: 'danger' });
                return;
            }
            try {
                const response = await bridge.fetchApi('/drawer/fs/index-generated', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        replace: true,
                        files: [{ root, subfolder: subfolder || '', name }],
                    }),
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok || payload?.ok === false) {
                    throw new Error(payload?.error || response.statusText || 'sync failed');
                }
                const updated = Number(payload?.updated || 0);
                if (updated > 0) {
                    showToast(t('menu.syncMetadataDone', { name }));
                } else if (payload?.notReady) {
                    showToast(t('menu.syncMetadataNotReady'));
                } else {
                    showToast(t('menu.syncMetadataSkipped', { name }));
                }
            } catch (e) {
                console.warn('[ComfyDrawer] metadata index sync failed:', e);
                await showAlert(t('menu.syncMetadataFailed'), { variant: 'danger' });
            }
        }

        /**
         * Return true when `raw` is a same-origin http(s) URL that is safe
         * to hand to `window.open` or `<a href>`. Rejects `javascript:`,
         * `data:`, cross-origin URLs, and anything that fails URL parsing.
         *
         * Media URLs surface from server metadata (filenames embedded in
         * workflows, third-party providers, etc.) so the context-menu
         * actions cannot trust them blindly.
         */
        function isSafeMediaUrl(raw) {
            if (typeof raw !== 'string' || !raw) return false;
            try {
                const u = new URL(raw, location.origin);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
                return u.origin === location.origin;
            } catch {
                return false;
            }
        }

        /**
         * Platform-level media action: upload a media URL into ComfyUI input
         * and apply it to a LoadImage/LoadImageMask node.
         * Kept here because the action is registered by the platform and may
         * originate from any gadget's MediaCard or Lightbox.
         */
        async function sendMediaToLoadImageNode(ctx) {
            if (window.__xyzSweepActive) return false;
            if (ctx?.type !== 'image' || !ctx.targetKey) return false;
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

                const target = enumerateLoadImageTargets(bridge)
                    .find(t => `${t.kind}:${t.nodeId}:${t.widgetName}` === ctx.targetKey);
                target?.addOption?.(uploadedName);
                const applied = target?.setValue(uploadedName) || false;
                if (!applied) {
                    console.warn('[ComfyDrawer] Failed to apply image to target:', ctx.targetKey);
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
                compact: true,
                visible: (ctx) => isSafeMediaUrl(ctx?.src),
                action: (ctx) => {
                    if (!isSafeMediaUrl(ctx?.src)) return;
                    window.open(ctx.src, '_blank', 'noopener,noreferrer');
                },
            },
            // 'Send to LoadImage' entries are dynamically registered below
            {
                id: 'media:workflow',
                label: t('menu.openAsWorkflow'),
                icon: 'workflow',
                order: 10,
                // Hide during XYZ sweep — loading a workflow mid-sweep would corrupt results
                visible: (ctx) => ctx.hasWorkflow !== false && !window.__xyzSweepActive,
                action: async (ctx) => {
                    const ok = await openWorkflowFromMedia(ctx);
                    if (!ok) showAlert(t('menu.noWorkflowData', { name: ctx.name || 'media' }));
                },
            },
            {
                id: 'media:metadata',
                label: t('menu.viewMetadata'),
                icon: 'info',
                order: 30,
                visible: (ctx) => ctx.hasMetadata !== false,
                action: showMediaMetadata,
            },
            {
                id: 'media:sync-metadata',
                label: t('menu.syncMetadata'),
                icon: 'refresh-cw',
                order: 40,
                visible: (ctx) => ctx.hasMetadata !== false && (ctx.root || ctx.source) !== 'temp',
                action: syncMediaMetadataIndex,
            },
            {
                id: 'media:download',
                label: t('menu.download'),
                icon: 'download',
                order: 30,
                compact: true,
                visible: (ctx) => isSafeMediaUrl(ctx?.src),
                action: (ctx) => {
                    if (!isSafeMediaUrl(ctx?.src)) return;
                    const a = document.createElement('a');
                    a.href = ctx.src;
                    a.download = ctx.name || ctx.label || 'image';
                    a.rel = 'noopener';
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
            const targetRank = (target) => {
                const type = String(target?.nodeType || '');
                if (type === 'LoadImage') return 0;
                if (type === 'LoadImageMask') return 1;
                return 2;
            };
            const loadImageTargets = enumerateLoadImageTargets(bridge)
                .sort((a, b) => (
                    targetRank(a) - targetRank(b)
                    || String(a.nodeTitle || a.nodeType || '').localeCompare(String(b.nodeTitle || b.nodeType || ''))
                    || Number(a.nodeId || 0) - Number(b.nodeId || 0)
                ));
            if (loadImageTargets.length === 0) return;

            // Single target → simple label; multiple → show node title/id
            const multi = loadImageTargets.length > 1;
            for (const target of loadImageTargets) {
                const targetKey = `${target.kind}:${target.nodeId}:${target.widgetName}`;
                const cleanTitle = String(target.nodeTitle || target.nodeType || '')
                    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1FA00}-\u{1FAFF}]/gu, '')
                    .trim();
                const label = multi
                    ? t('menu.sendToNodeType', { type: target.nodeType, title: cleanTitle || target.nodeType })
                    : t('menu.sendToLoadImage');
                contextMenu.register('media-file', {
                    id: `${SEND_PREFIX}${targetKey}`,
                    label,
                    icon: 'send',
                    order: 60 + targetRank(target),
                    visible: (ctx) => ctx.type === 'image' && !window.__xyzSweepActive,
                    action: (ctx) => sendMediaToLoadImageNode({ ...ctx, targetKey }),
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
            /** Register a widget to be shown on the Home dashboard */
            registerHomeWidget: (widget) => {
                if (!widget?.id) return () => {};
                const item = { ...widget };
                homeWidgets.get(item.id)?.onDestroy?.();
                homeWidgets.set(item.id, item);
                bus.emit('home-widget:changed', { id: item.id, action: 'registered' });
                return () => {
                    const current = homeWidgets.get(item.id);
                    if (current === item) {
                        current.onDestroy?.();
                        homeWidgets.delete(item.id);
                        bus.emit('home-widget:changed', { id: item.id, action: 'unregistered' });
                    }
                };
            },
            /** Remove a Home dashboard widget by ID */
            unregisterHomeWidget: (id) => {
                const current = homeWidgets.get(id);
                if (!current) return false;
                current.onDestroy?.();
                homeWidgets.delete(id);
                bus.emit('home-widget:changed', { id, action: 'unregistered' });
                return true;
            },
            /** Snapshot registered Home dashboard widgets */
            getHomeWidgets: () => [...homeWidgets.values()].sort((a, b) =>
                (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id))
            ),

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
            /** Show a non-blocking toast */
            showToast,

            // ── Workflow ──
            /** Check if media item has workflow data → Promise<boolean> */
            checkWorkflowAvailable,
            /** Check if media item has displayable metadata → Promise<boolean> */
            checkMetadataAvailable,
            /** Load workflow from media item (provider-first metadata) */
            openWorkflowFromMedia,

            // ── Image Picker ──
            /** Open a thumbnail-based image picker popup → Promise<string|null> */
            openImagePicker,

            // ── Mask Editor ──
            /** Open the mask editor overlay → Promise<{applied,filename}|null> */
            maskService: MaskService,

            /** Version for compatibility checks */
            version: drawerVersion,
        };

        window.ComfyDrawer = drawerAPI;

        // ── MaskService: context menu registration ──────────────────────────────
        contextMenu.register('media-file', [{
            id: 'media:create-mask',
            label: 'Create Mask',
            icon: 'brush',
            order: 20,
            visible: (c) => (
                c.type === 'image'
                && !window.__xyzSweepActive
                && enumerateLoadImageTargets(bridge, { maskOnly: true }).length > 0
            ),
            action:  (c) => MaskService.open({ url: c.src, filename: c.name, bridge }),
        }]);

        // ── Register built-in gadgets ─────────────────────────────────────────
        // Tabs are cheap metadata. The actual gadget modules are imported only
        // when opened, so ComfyUI panels are not competing with Drawer startup.
        class LazyBuiltInGadget extends GadgetBase {
            #spec;
            #real = null;
            #loading = null;

            constructor(spec) {
                super(spec.id, {
                    label: spec.label,
                    icon: spec.icon,
                    order: spec.order,
                    cssUrl: null,
                });
                this.#spec = spec;
            }

            onMount(container) {
                container.innerHTML = `<div class="comfy-drawer-gadget-placeholder">${t('common.loading')}</div>`;
            }

            async #ensureLoaded() {
                if (this.#real) return this.#real;
                if (this.#loading) return this.#loading;
                this.container?.classList.add('comfy-drawer-gadget-mounting');
                this.#loading = (async () => {
                    const mod = await import(this.#spec.path);
                    const Gadget = mod[this.#spec.exportName];
                    if (!Gadget) throw new Error(`Missing export ${this.#spec.exportName}`);
                    const real = new Gadget();
                    if (real.cssUrl) {
                        await loadStylesheetOnce(`${real.id}-gadget-css`, real.cssUrl);
                    }
                    real.mount(this.container, this.bus, this.bridge);
                    this.#real = real;
                    this.container?.classList.remove('comfy-drawer-gadget-mounting');
                    return real;
                })().catch((e) => {
                    this.container?.classList.remove('comfy-drawer-gadget-mounting');
                    this.container.innerHTML = `<div class="comfy-drawer-gadget-placeholder">Failed to load</div>`;
                    throw e;
                });
                return this.#loading;
            }

            onActivate() {
                this.#ensureLoaded()
                    .then(real => real.onActivate?.())
                    .catch(e => console.error(`[ComfyDrawer] Failed to load ${this.#spec.exportName}:`, e));
            }

            onDeactivate() {
                this.#real?.onDeactivate?.();
            }

            onGraphChanged() {
                this.#real?.onGraphChanged?.();
            }

            onResize(height) {
                this.#real?.onResize?.(height);
            }

            onDestroy() {
                this.#real?.destroy?.();
            }
        }

        const registerBuiltInGadgets = () => {
            const specs = [
                { id: 'home', label: 'Home', icon: BUILT_IN_ICONS.home, order: -10, path: '../gadgets/home/home-gadget.js', exportName: 'HomeGadget' },
                { id: 'xyzplot', label: 'XYZ Plot', icon: BUILT_IN_ICONS.xyzplot, order: 1, path: '../gadgets/xyzplot/xyzplot-gadget.js', exportName: 'XYZPlotGadget' },
                { id: 'deck', label: 'Deck', icon: BUILT_IN_ICONS.deck, order: 2, path: '../gadgets/deck/deck-gadget.js', exportName: 'DeckGadget' },
                { id: 'gallery', label: 'Gallery', icon: BUILT_IN_ICONS.gallery, order: 3, path: '../gadgets/gallery/gallery-gadget.js', exportName: 'GalleryGadget' },
                { id: 'modelviewer', label: 'Models', icon: BUILT_IN_ICONS.modelviewer, order: 4, path: '../gadgets/modelviewer/modelviewer-gadget.js', exportName: 'ModelViewerGadget' },
            ];
            for (const spec of specs) {
                try {
                    shell.registerGadget(new LazyBuiltInGadget(spec), { lazyMount: true });
                } catch (e) {
                    console.error(`[ComfyDrawer] Failed to load ${spec.exportName}:`, e);
                }
            }
            bootPlaceholder?.remove();
        };
        const scheduleBuiltInGadgets = () => {
            if ('requestIdleCallback' in window) {
                window.requestIdleCallback(() => registerBuiltInGadgets(), { timeout: 3000 });
            } else {
                setTimeout(registerBuiltInGadgets, 2000);
            }
        };
        setTimeout(scheduleBuiltInGadgets, 1000);

        const formatBytes = (bytes) => {
            const n = Number(bytes) || 0;
            if (n < 1024) return `${n} B`;
            const units = ['KB', 'MB', 'GB', 'TB'];
            let value = n / 1024;
            let unit = units[0];
            for (let i = 1; i < units.length && value >= 1024; i++) {
                value /= 1024;
                unit = units[i];
            }
            return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
        };
        const paletteFor = (index) => ['#3b82f6', '#f97316', '#22c55e', '#e879f9', '#facc15', '#14b8a6'][index % 6];
        const STORAGE_WIDGET_CACHE_MS = 120000;
        let storageWidgetCache = null;
        let storageWidgetCacheAt = 0;
        const renderPie = (parts) => {
            const total = parts.reduce((sum, part) => sum + (Number(part.bytes) || 0), 0);
            if (total <= 0) return 'var(--cd-s1)';
            const visible = parts.slice(0, 6).filter(part => (Number(part.bytes) || 0) > 0);
            if (visible.length === 1) return paletteFor(0);
            let cursor = 0;
            return visible.map((part, index) => {
                const start = cursor;
                cursor += ((Number(part.bytes) || 0) / total) * 100;
                return `${paletteFor(index)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
            }).join(', ');
        };
        const renderStorageOverview = (container, rows) => {
            container.innerHTML = `<div class="hm-storage-overview"></div>`;
            const grid = container.querySelector('.hm-storage-overview');
            for (const row of rows) {
                const parts = row.parts || row.byExt || [];
                const total = parts.reduce((sum, part) => sum + (Number(part.bytes) || 0), 0) || 1;
                const card = document.createElement('div');
                card.className = 'hm-storage-pie-card';
                const legend = parts.slice(0, 4).map((part, index) => `
                    <span class="hm-storage-legend-item">
                        <span class="hm-storage-dot" style="background:${paletteFor(index)}"></span>
                        ${escapeHTML(part.label || part.name || part.ext)} ${formatBytes(part.bytes)} (${(((Number(part.bytes) || 0) / total) * 100).toFixed(1)}%)
                    </span>
                `).join('');
                card.innerHTML = `
                    <div class="hm-storage-pie" style="background:conic-gradient(${renderPie(parts)})"></div>
                    <div class="hm-storage-pie-main">
                        <div class="hm-storage-pie-title">${escapeHTML(row.label || row.id)}</div>
                        <div class="hm-storage-pie-meta">${formatBytes(row.bytes)} · ${t('home.storageFiles', { count: Number(row.files || 0).toLocaleString() })}</div>
                        ${legend ? `<div class="hm-storage-legend">${legend}</div>` : ''}
                    </div>
                `;
                grid.appendChild(card);
            }
        };
        const renderStorageBars = (container, rows) => {
            const maxBytes = Math.max(1, ...rows.map(row => Number(row.bytes) || 0));
            const list = document.createElement('div');
            list.className = 'hm-storage-list';
            for (const row of rows) {
                const chips = (row.parts || row.topDirs || row.byExt || []).slice(0, 4).map(part =>
                    `<span class="hm-storage-chip">${escapeHTML(part.label || part.name || part.ext)} ${formatBytes(part.bytes)}</span>`
                ).join('');
                const el = document.createElement('div');
                el.className = 'hm-storage-row';
                el.innerHTML = `
                    <div class="hm-storage-name" title="${escapeHTML(row.label || row.id)}">${escapeHTML(row.label || row.id)}</div>
                    <div class="hm-storage-main">
                        <div class="hm-storage-meta">
                            <span>${formatBytes(row.bytes)}</span>
                            <span>${t('home.storageFiles', { count: Number(row.files || 0).toLocaleString() })}</span>
                        </div>
                        <div class="hm-storage-bar"><div class="hm-storage-fill" style="width:${Math.max(2, Math.round(((Number(row.bytes) || 0) / maxBytes) * 100))}%"></div></div>
                        ${chips ? `<div class="hm-storage-breakdown">${chips}</div>` : ''}
                    </div>
                `;
                list.appendChild(el);
            }
            container.appendChild(list);
        };
        const renderStorageWidget = (container, data) => {
            const modelCategories = data.models?.categories || [];
            const overviewRows = [
                ...(data.roots || []).map(row => ({ ...row, parts: row.byExt || [] })),
                {
                    id: 'models',
                    label: t('modelviewer.label'),
                    bytes: data.models?.bytes || 0,
                    files: data.models?.files || 0,
                    parts: modelCategories.slice(0, 6).map(cat => ({
                        label: cat.label || cat.id,
                        bytes: cat.bytes,
                        files: cat.files,
                    })),
                },
            ];
            container.replaceChildren();
            renderStorageOverview(container, overviewRows);
            const details = document.createElement('details');
            details.className = 'hm-storage-details';
            details.innerHTML = `<summary>${t('home.storageModelDetails')}</summary>`;
            renderStorageBars(details, modelCategories.slice(0, 8).map(cat => ({
                ...cat,
                label: cat.label,
                parts: cat.topDirs?.length ? cat.topDirs : cat.byExt,
            })));
            container.appendChild(details);
        };

        drawerAPI.registerHomeWidget({
            id: 'drawer-storage',
            title: t('home.storage'),
            order: 10,
            render: async (container, ctx = {}) => {
                const now = Date.now();
                const hasFreshCache = storageWidgetCache && now - storageWidgetCacheAt < STORAGE_WIDGET_CACHE_MS;
                if (storageWidgetCache) {
                    renderStorageWidget(container, storageWidgetCache);
                    if (hasFreshCache) return;
                } else {
                    container.innerHTML = `<div class="hm-empty">${t('common.loading')}</div>`;
                }
                const url = ctx.force ? '/drawer/storage/summary?refresh=1' : '/drawer/storage/summary';
                const res = await bridge.fetchApi(url, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                storageWidgetCache = data;
                storageWidgetCacheAt = Date.now();
                renderStorageWidget(container, data);
            },
        });

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
                    await bridge.fetchApi('/drawer/reboot', {
                        method: 'POST',
                        headers: { 'X-Comfy-Drawer-Action': 'reboot' },
                    });
                } catch {
                    // os.execv closes the HTTP connection; treat that as restart in progress.
                }
                try {
                    showAlert(t('home.serverRestarting'));
                    const poll = setInterval(async () => {
                        try {
                            const r = await bridge.fetchApi('/system_stats', { signal: AbortSignal.timeout(2000) });
                            if (r.ok) { clearInterval(poll); location.reload(); }
                        } catch { /* still down */ }
                    }, 3000);
                } catch (e) {
                    showAlert(`Error: ${e.message}`);
                }
            },
        });

        // ── Relay ComfyUI generation events to bus ──
        // 'executed' fires per node; 'execution_success' fires once per successful queue item.
        bridge.onApiEvent('executed', (event) => {
            bus.emit('comfy:executed', event?.detail ?? event);
        });
        bridge.onApiEvent('execution_success', (event) => {
            bus.emit('comfy:execution-success', event?.detail ?? event);
        });
        bridge.onApiEvent('execution_error', (event) => {
            bus.emit('comfy:execution-error', event?.detail ?? event);
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
        bridge.fetchApi('/drawer/settings/comments-enabled', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: commentInitial }),
        }).catch(() => { /* backend unavailable */ });

        // Sync backend when setting changes
        settings.onChange(COMMENT_KEY, (_key, enabled) => {
            bridge.fetchApi('/drawer/settings/comments-enabled', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            // Notify Deck gadget to refresh highlights immediately
            bus.emit('settings:highlight-changed', { commentsEnabled: enabled });
        });

        const formatDuration = (seconds) => {
            const value = Math.max(0, Math.round(Number(seconds) || 0));
            const mins = Math.floor(value / 60);
            const secs = value % 60;
            if (mins <= 0) return `${secs}s`;
            const hours = Math.floor(mins / 60);
            const remMins = mins % 60;
            if (hours <= 0) return `${mins}m ${secs}s`;
            return `${hours}h ${remMins}m`;
        };
        const formatIndexProgress = (status) => {
            const indexed = Number(status?.indexed || 0);
            const total = Number(status?.total || 0);
            if (!total) return status?.progress || status?.syncProgress || '';
            const percent = Number.isFinite(Number(status?.percent))
                ? ` (${Number(status.percent).toFixed(Number(status.percent) % 1 ? 1 : 0)}%)`
                : '';
            return `${indexed.toLocaleString()} / ${total.toLocaleString()}${percent}`;
        };
        const describeSearchIndexStatus = (status) => {
            const state = status?.state || (status?.building ? 'building' : status?.paused ? 'paused' : status?.ready ? 'ready' : 'missing');
            if (status?.building) {
                const progress = formatIndexProgress(status);
                return progress
                    ? t('settings.searchIndexStatusBuilding', { progress })
                    : t('settings.searchIndexStatusPreparing');
            }
            if (status?.paused) {
                const progress = formatIndexProgress(status);
                return progress
                    ? t('settings.searchIndexStatusPaused', { progress })
                    : t('settings.searchIndexStatusPausedSimple');
            }
            if (status?.ready) {
                if (status?.syncing) {
                    const progress = status.syncProgress || '';
                    return progress
                        ? t('settings.searchIndexStatusChecking', { progress })
                        : t('settings.searchIndexStatusCheckingSimple');
                }
                return status?.autoSyncEnabled
                    ? t('settings.searchIndexStatusIdle')
                    : t('settings.searchIndexStatusReady');
            }
            if (state === 'cleared') return t('settings.searchIndexStatusCleared');
            return t('settings.searchIndexStatusMissing');
        };
        const SEARCH_INDEX_CREATE_CANCELLED = Symbol('searchIndexCreateCancelled');
        const showSearchIndexEstimatingDialog = (onCancel) => {
            let closeDialog = null;
            const promise = showDialog({
                title: t('settings.searchIndex'),
                message: t('settings.searchIndexEstimating'),
                variant: 'info',
                showCancel: true,
                confirmLabel: '',
                cancelLabel: t('common.cancel'),
                showClose: true,
                dismissOnBackdrop: false,
                autoFocus: false,
                content: (body) => {
                    const wrap = document.createElement('div');
                    wrap.className = 'cd-index-estimating';
                    const spinner = document.createElement('span');
                    spinner.className = 'cd-index-estimating-spinner';
                    spinner.setAttribute('aria-hidden', 'true');
                    wrap.appendChild(spinner);
                    body.appendChild(wrap);
                },
                onOpen: ({ close }) => {
                    closeDialog = close;
                },
                onDismiss: (value) => {
                    if (value === null) onCancel?.();
                },
            });
            return {
                close: () => {
                    closeDialog?.('done');
                },
                promise,
            };
        };
        const getSearchIndexCreateConfirmMessage = async () => {
            const ctrl = new AbortController();
            let cancelled = false;
            const measuring = showSearchIndexEstimatingDialog(() => {
                cancelled = true;
                ctrl.abort();
            });
            try {
                const resp = await bridge.fetchApi('/drawer/fs/index-estimate', { signal: ctrl.signal });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const estimate = await resp.json();
                measuring.close();
                await measuring.promise;
                if (cancelled) return SEARCH_INDEX_CREATE_CANCELLED;
                if (!estimate.requiresConfirm) return null;
                return t('settings.createSearchIndexConfirmWithEstimate', {
                    count: Number(estimate.total || 0).toLocaleString(),
                    time: formatDuration(estimate.estimatedSeconds || 0),
                });
            } catch (e) {
                measuring.close();
                await measuring.promise;
                if (cancelled || e?.name === 'AbortError') return SEARCH_INDEX_CREATE_CANCELLED;
                return t('settings.createSearchIndexConfirm');
            }
        };
        const createSearchIndex = async () => {
            const message = await getSearchIndexCreateConfirmMessage();
            if (message === SEARCH_INDEX_CREATE_CANCELLED) return null;
            if (message) {
                const ok = await showConfirm(message, { variant: 'warning' });
                if (!ok) return null;
            }
            const resp = await bridge.fetchApi('/drawer/fs/index-start', { method: 'POST' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            bus.emit('drawer:index-build-started', data);
            return data;
        };
        drawerAPI.createSearchIndex = createSearchIndex;

        const showDrawerToast = (message) => {
            const el = document.createElement('div');
            Object.assign(el.style, {
                position: 'fixed',
                bottom: '24px',
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '10px 20px',
                background: 'rgba(0,0,0,.85)',
                color: '#fff',
                borderRadius: '8px',
                fontSize: '13px',
                fontFamily: 'system-ui, sans-serif',
                zIndex: '230000',
                pointerEvents: 'none',
                transition: 'opacity .3s',
                boxShadow: '0 4px 16px rgba(0,0,0,.4)',
            });
            el.textContent = message;
            document.body.appendChild(el);
            setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
        };

        let manualIndexMonitor = null;
        const stopManualIndexMonitor = () => {
            if (manualIndexMonitor) {
                clearInterval(manualIndexMonitor.timer);
                manualIndexMonitor = null;
            }
        };
        const getIndexMonitorError = (status, kind) => {
            const value = String(kind === 'sync' ? status?.syncProgress || '' : status?.progress || '').trim();
            if (!value) return '';
            if (kind === 'sync') {
                return /^(Sync error|Metadata refresh error):/i.test(value) ? value : '';
            }
            return /^Index error:/i.test(value) ? value : '';
        };
        const showIndexMonitorError = (kind, message) => {
            showAlert(message || t('common.errorOccurred'), {
                title: t(kind === 'sync' ? 'settings.searchIndexSyncFailed' : 'settings.searchIndexFailed'),
                variant: 'danger',
            });
        };
        const startManualIndexMonitor = (kind) => {
            stopManualIndexMonitor();
            const token = Symbol(kind);
            manualIndexMonitor = { kind, timer: null, token };
            const poll = async () => {
                try {
                    const resp = await bridge.fetchApi('/drawer/fs/index-status');
                    if (!resp.ok || !manualIndexMonitor || manualIndexMonitor.token !== token) return;
                    const status = await resp.json();
                    if (!manualIndexMonitor || manualIndexMonitor.token !== token) return;
                    const error = getIndexMonitorError(status, kind);
                    if (error) {
                        stopManualIndexMonitor();
                        showIndexMonitorError(kind, error);
                        return;
                    }
                    if (kind === 'build') {
                        if (status.ready && !status.building && !status.paused) {
                            showDrawerToast(t('settings.searchIndexReady'));
                            stopManualIndexMonitor();
                        }
                        return;
                    }
                    if (kind === 'sync' && !status.syncing) {
                        showDrawerToast(t('settings.searchIndexSyncComplete'));
                        stopManualIndexMonitor();
                    }
                } catch (e) {
                    console.warn('[ComfyDrawer] Search index completion monitor failed:', e);
                }
            };
            manualIndexMonitor.timer = setInterval(poll, 3000);
            setTimeout(poll, 1000);
        };
        bus.on('drawer:index-build-started', () => startManualIndexMonitor('build'));
        bus.on('drawer:index-sync-started', (data) => {
            if (data?.started === false) return;
            startManualIndexMonitor('sync');
        });
        // 2. Clear Drawer cache action
        const getClearCacheTargets = async () => showDialog({
            title: t('settings.clearCache'),
            message: t('settings.clearCacheConfirm'),
            variant: 'danger',
            danger: true,
            confirmLabel: t('settings.clear'),
            content: (body) => {
                const wrap = document.createElement('div');
                wrap.className = 'cd-cache-clear-options';
                const options = [
                    ['thumbnails', t('settings.clearCacheThumbnails')],
                    ['index', t('settings.clearCacheIndex')],
                ];
                const inputs = {};
                for (const [key, labelText] of options) {
                    const label = document.createElement('label');
                    label.className = 'cd-cache-clear-option';
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = true;
                    inputs[key] = input;
                    const span = document.createElement('span');
                    span.textContent = labelText;
                    label.append(input, span);
                    wrap.appendChild(label);
                }
                body.appendChild(wrap);
                return () => ({
                    thumbnails: inputs.thumbnails.checked,
                    index: inputs.index.checked,
                });
            },
            onValidate: (data) => (
                data?.thumbnails || data?.index
                    ? null
                    : t('settings.clearCacheSelectOne')
            ),
        });
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
                const targets = await getClearCacheTargets();
                if (!targets) return;
                const resp = await bridge.fetchApi('/drawer/clear-cache', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(targets),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                const mb = (data.freedBytes / 1024 / 1024).toFixed(1);
                bus.emit('drawer:cache-cleared', data);
                showAlert(t('settings.cacheCleared', { count: data.deleted, mb }));
            },
        });

        settings.define('util.createSearchIndex', {
            type: 'action',
            label: t('settings.searchIndex'),
            description: t('settings.searchIndexDesc'),
            section: t('settings.utility'),
            sectionOrder: 0,
            buttonLabel: t('settings.create'),
            order: 80,
            refreshEvents: ['drawer:cache-cleared', 'drawer:index-build-started', 'drawer:index-sync-started', 'drawer:index-auto-sync-changed'],
            refreshInterval: 3000,
            getButtonState: async () => {
                const resp = await bridge.fetchApi('/drawer/fs/index-status');
                if (!resp.ok) return { label: t('settings.create'), disabled: true, description: t('settings.searchIndexStatusUnavailable') };
                const status = await resp.json();
                const description = describeSearchIndexStatus(status);
                if (status.ready && status.syncing) return { label: t('settings.checking'), disabled: true, description };
                if (status.ready && status.state !== 'missing' && status.state !== 'cleared') return { label: t('settings.syncNow'), disabled: false, description };
                if (status.building) return { label: t('settings.creating'), disabled: true, description };
                if (status.paused) return { label: t('settings.creating'), disabled: true, description };
                return { label: t('settings.create'), disabled: false, description };
            },
            action: async () => {
                const statusResp = await bridge.fetchApi('/drawer/fs/index-status');
                if (!statusResp.ok) throw new Error(`HTTP ${statusResp.status}`);
                const status = await statusResp.json();
                if (status.ready && !status.building && !status.paused && !status.syncing) {
                    const resp = await bridge.fetchApi('/drawer/fs/index-sync', { method: 'POST' });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = await resp.json();
                    bus.emit('drawer:index-sync-started', data);
                    showAlert(data.started ? t('settings.searchIndexSyncStarted') : t('settings.searchIndexSyncSkipped'));
                    return;
                }
                await createSearchIndex();
            },
        });

        const AUTO_SYNC_KEY = 'util.searchIndex.autoSync';
        let syncingAutoSyncSetting = false;
        settings.define(AUTO_SYNC_KEY, {
            type: 'toggle',
            label: t('settings.searchIndexAutoSync'),
            description: t('settings.searchIndexAutoSyncDesc'),
            section: t('settings.utility'),
            sectionOrder: 0,
            defaultValue: false,
            order: 81,
        });
        bridge.fetchApi('/drawer/fs/index-status')
            .then(r => r.ok ? r.json() : null)
            .then(status => {
                if (status && typeof status.autoSyncEnabled === 'boolean') {
                    syncingAutoSyncSetting = true;
                    settings.set(AUTO_SYNC_KEY, status.autoSyncEnabled);
                    syncingAutoSyncSetting = false;
                }
            })
            .catch(() => { syncingAutoSyncSetting = false; });
        settings.onChange(AUTO_SYNC_KEY, (_key, enabled) => {
            if (syncingAutoSyncSetting) return;
            bridge.fetchApi('/drawer/fs/index-auto-sync', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !!enabled }),
            })
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (data) bus.emit('drawer:index-auto-sync-changed', data);
                })
                .catch(() => {});
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
        };

        const scheduleDrawerPlatform = () => {
            const start = () => {
                initializeDrawerPlatform().catch((e) => {
                    console.error('[ComfyDrawer] Failed to initialize platform:', e);
                });
            };
            if ('requestIdleCallback' in window) {
                window.requestIdleCallback(start, { timeout: 5000 });
            } else {
                setTimeout(start, 2500);
            }
        };
        setTimeout(scheduleDrawerPlatform, 2500);

    },
});
