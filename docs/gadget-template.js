/**
 * SPDX-License-Identifier: MIT
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  ComfyUI-Drawer — Single-File Gadget Template              │
 * │                                                             │
 * │  1. Copy this file into any custom_node's web/js/ folder   │
 * │  2. Rename it (e.g. ext-my-gadget.js)                      │
 * │  3. Modify the class below                                  │
 * │  4. Restart ComfyUI — your gadget appears as a new tab     │
 * └─────────────────────────────────────────────────────────────┘
 */
import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "Comfy.Drawer.MyGadget",  // unique extension name
    async setup() {
        // Wait for ComfyDrawer platform
        const drawer = window.ComfyDrawer ?? await new Promise(resolve =>
            window.addEventListener('comfy-drawer:ready', e => resolve(e.detail), { once: true })
        );
        const { GadgetBase } = drawer;

        // ── Inject CSS (scoped via @layer) ──
        const style = document.createElement('style');
        style.textContent = /* css */`
            @layer gadget-my-gadget {
                .gadget-my-gadget .my-content {
                    padding: 16px;
                    color: #ccc;
                }
            }
        `;
        document.head.appendChild(style);

        // ── Define the gadget ──
        class MyGadget extends GadgetBase {
            constructor() {
                super('my-gadget', {     // unique gadget ID
                    label: 'My Gadget',  // tab label
                    icon: '🔧',          // tab icon (emoji or SVG string)
                    order: 10,           // tab position (lower = left)
                });
            }

            /**
             * Called once when the gadget is mounted into the DOM.
             * Build your UI here. `container` is the Shell-managed panel <div>.
             * `bus` is the MessageBus, `bridge` is the ComfyBridge.
             */
            onMount(container, bus, bridge) {
                container.innerHTML = `
                    <div class="my-content">
                        <h3>Hello from My Gadget!</h3>
                        <p>Edit this file to build your own gadget.</p>
                    </div>
                `;

                // Example: listen for generation events
                // this.addDisposable(bus.on('comfy:executed', () => { ... }));
            }

            /** Called each time the tab becomes active */
            onActivate() {}

            /** Called each time the tab becomes inactive */
            onDeactivate() {}
        }

        // ── Register ──
        drawer.registerGadget(new MyGadget());
    },
});
