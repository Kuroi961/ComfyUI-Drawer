/**
 * ComfyDrawer — ComfyUI extension entry point
 * Registers with ComfyUI, installs the graph hooks that need `app`, and
 * boots the host-agnostic platform (drawer-platform.js) over a ComfyBridge.
 * The public window.ComfyDrawer API is documented in drawer-platform.js.
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { ComfyBridge } from "./core/comfy-bridge.js";
import { setApiProvider } from "./core/api-utils.js";
import { sanitizeComfyDrawerWorkflowExtra } from "./utils.js";
import { DRAWER_VERSION } from "./version.js";
import { startDrawerPlatform, loadDrawerVersion, createDrawerBootPlaceholder } from "./drawer-platform.js";

setApiProvider(api);
// Drawer's server broadcasts run progress as `drawer.progress`; registering a
// type up front keeps the frontend from logging it as an unknown message
// before the platform (and its progress indicator) has started.
api.addEventListener('drawer.progress', () => {});

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
        const drawerVersion = await loadDrawerVersion(api, DRAWER_VERSION);

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

        const bootPlaceholder = createDrawerBootPlaceholder();
        const bridge = new ComfyBridge(app, api);

        const scheduleDrawerPlatform = () => {
            const start = () => {
                startDrawerPlatform({ bridge, drawerVersion, bootPlaceholder }).catch((e) => {
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
