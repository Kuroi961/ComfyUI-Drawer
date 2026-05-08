<!-- SPDX-License-Identifier: CC0-1.0 -->

# ComfyUI-Drawer Gadget API Reference

> Complete API for building gadgets. All APIs available via `window.ComfyDrawer` — no ES imports needed.

---

## Quick Start

```js
// ext-hello.js — place in any custom_nodes/*/web/js/
import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "Comfy.Drawer.Hello",
    async setup() {
        const drawer = window.ComfyDrawer ?? await new Promise(resolve =>
            window.addEventListener('comfy-drawer:ready', e => resolve(e.detail), { once: true })
        );
        const { GadgetBase } = drawer;

        class HelloGadget extends GadgetBase {
            constructor() {
                super('hello', { label: 'Hello', icon: '👋', order: 50 });
            }
            onMount(container, bus, bridge) {
                container.innerHTML = '<div style="padding:20px"><h2>Hello!</h2></div>';
            }
        }

        drawer.registerGadget(new HelloGadget());
    },
});
```

> **Template**: Copy [`docs/gadget-template.js`](docs/gadget-template.js) to get started.

---

## GadgetBase

### Constructor

```js
super(id, options)
```

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Unique gadget identifier |
| `options.label` | string | - | Tab display name (default: id) |
| `options.icon` | string | - | Tab icon (SVG string or emoji) |
| `options.order` | number | - | Tab sort order, lower = left (default: 0) |
| `options.cssUrl` | string | - | CSS URL for auto-injection. For single-file gadgets, use inline `<style>` instead |

### Lifecycle

```
mount(container, bus, bridge)     ← Shell calls (DO NOT override)
  → onMount(container, bus, bridge)   ← ★ Build UI here

┌── User interaction loop ──┐
│ onActivate()               │ ← Tab selected
│ onDeactivate()             │ ← Tab deselected
│ onGraphChanged()           │ ← Workflow switched
│ onResize(height)           │ ← Panel resized
└────────────────────────────┘

destroy()                         ← Shell calls (DO NOT override)
  → onDestroy()                   ← ★ Cleanup here
  → addDisposable() functions auto-executed
  → container/bus/bridge nulled
```

All hooks are optional. No need to call `super`.

### Properties

| Property | Type | Description |
|---|---|---|
| `this.container` | HTMLElement | Shell-managed panel container |
| `this.bus` | MessageBus | Inter-gadget communication |
| `this.bridge` | ComfyBridge | ComfyUI API access |
| `this.id` | string | Gadget ID |

### addDisposable(fn)

Register cleanup functions, auto-called on `destroy()`:

```js
this.addDisposable(bus.on('some:event', handler));
this.addDisposable(() => bridge.offApiEvent('progress', handler));
```

---

## Home Widgets

```js
const unregister = window.ComfyDrawer.registerHomeWidget({
    id: 'my-gadget-summary',
    gadgetId: 'my-gadget',
    title: 'Summary',
    order: 20,
    render: async (container, ctx) => {
        container.textContent = 'Ready';
        return () => {
            // optional cleanup before the widget is re-rendered or Home is destroyed
        };
    },
});

window.ComfyDrawer.unregisterHomeWidget('my-gadget-summary');
const widgets = window.ComfyDrawer.getHomeWidgets();
```

Home widgets are small dashboard panels rendered by the Home gadget. `render(container, ctx)` may return a cleanup function. `registerHomeWidget()` also returns an unregister function.

---

## MessageBus

```js
// Pub/Sub
const unsub = bus.on('my-gadget:refresh', (data) => { ... });
bus.emit('my-gadget:refresh', { reason: 'manual' });
bus.off('my-gadget:refresh', handler);

// Request/Respond (Promise-based)
const ok = bus.respond('dict:suggest', async ({ partial }) => results);
bus.removeResponder('dict:suggest');
const results = await bus.request('dict:suggest', { partial: 'cat' });
const has = bus.hasResponder('dict:suggest');
```

`respond()` allows only one responder per event and returns `false` if another responder already owns that event.

Filesystem mutation events are emitted after successful Gallery operations. `fs:moved` stays the compatibility event for sidecar sync; rename operations also emit `fs:moved` as a same-folder move with `newName`/`to_name`.

---

## Python Metadata Providers

Gallery indexing can use third-party raw metadata providers and index contributors. Providers are Python callables registered by another custom node; Drawer passes file context and expects raw metadata back. If no provider returns metadata for a file, Drawer falls back to embedded PNG/WebP metadata.

```python
from comfyui_drawer import (
    register_dictionary_provider,
    register_index_contributor,
    register_metadata_panel_contributor,
    register_metadata_provider,
)

def provide_raw_metadata(ctx):
    # ctx: path, root_name, root_path, subfolder, name, filename
    return lookup_metadata_somewhere(ctx) or None

def contribute_search_fields(raw, ctx):
    mine = raw.get("workflow", {}).get("extra", {}).get("myPlugin")
    if not isinstance(mine, dict):
        return None
    return {
        "namespace": "myPlugin",
        "fields": {
            "project": mine.get("project"),
            "caption": mine.get("caption"),
            "tags": mine.get("tags") or [],
        },
    }

def contribute_metadata_panel(raw, ctx):
    mine = raw.get("workflow", {}).get("extra", {}).get("myPlugin")
    if not isinstance(mine, dict):
        return None
    return {
        "title": "myPlugin",
        "fields": {
            "Project": mine.get("project"),
            "Tags": mine.get("tags") or [],
            "Caption": mine.get("caption"),
        },
    }

def provide_dictionary_entries(ctx):
    return [
        {
            "tag": "myPlugin:tags[black hair]",
            "insert_text": "myPlugin:tags[black hair]",
            "display_text": "myPlugin tags search",
        },
    ]

unregister_provider = register_metadata_provider(provide_raw_metadata, name="my-metadata", priority=40)
unregister_contributor = register_index_contributor(contribute_search_fields, name="my-plugin-index", priority=40)
unregister_panel = register_metadata_panel_contributor(contribute_metadata_panel, name="my-plugin-panel", priority=40)
unregister_dict = register_dictionary_provider(
    provide_dictionary_entries,
    name="my-plugin-dict",
    label="myPlugin",
    context="search",
    priority=40,
)
```

Providers should return raw metadata only when they own metadata for the file. Drawer does not require any specific provider storage format. Provider raw metadata may be the normal ComfyUI `prompt`/`workflow` shape, a third-party shape, or data loaded from a sidecar/database.

Index contributors receive the raw metadata selected for the file and the same context object. They should return `None` when they do not recognize any metadata they own. Contributions may contain `namespace` plus `fields`, where `fields` maps contributor-owned keys to strings, numbers, booleans, lists, or nested dicts. Standard `prompt_*` and `workflow_*` fields are extracted by Drawer itself.

Metadata panel contributors receive the same raw metadata and context. They may return `title` plus `fields`, or `sections` containing `{title, rows, text}`. Dictionary providers return autocomplete entries for Drawer search/prompt inputs; entries may use `{tag, insert_text, display_text}` or the internal `{t, insertText, displayText}` shape.

Index contributors and dictionary providers are intentionally separate. An index contributor makes existing metadata searchable after the Gallery index is built or refreshed. A dictionary provider only supplies autocomplete candidates, such as useful `namespace:key[...]` snippets, and does not make anything searchable by itself.

Custom metadata search syntax mirrors Drawer's existing bracket searches:

```text
myPlugin[black hair]          # search all custom fields from myPlugin
myPlugin:tags[black hair]     # search only the myPlugin tags field
myPlugin:project[archive A]
```

Drawer extracts standard ComfyUI `prompt` and `workflow` metadata itself. A third-party custom node that embeds custom data in `workflow.extra` can register only an index contributor. A third-party system that stores metadata outside the image can register a raw provider, and can also register an index contributor when that raw format needs custom interpretation. After adding or changing a provider or contributor, rebuild the Gallery search index.

If the index already exists and only provider/contributor interpretation changed, `POST /drawer/fs/index-refresh-metadata` rereads metadata for existing files and reapplies current contributors without dropping the index database. Normal `POST /drawer/fs/index-sync` automatically switches to this refresh path when Drawer detects that the registered raw providers or index contributors changed since the last build/refresh.

Gallery treats indexed metadata as stable snapshot data. Move/rename-style updates should preserve existing search fields. External `/drawer/fs/index-update` calls also preserve existing metadata by default; pass `replace: true` only for an explicit maintenance action that should overwrite already-indexed search fields.

Ready indexes reconcile file changes in the background. Reconcile adds new files, updates file location/stat fields, matches likely moves/renames by fingerprint, and removes stale rows, but it does not reinterpret existing metadata. A manual low-priority reconcile can also be requested with `POST /drawer/fs/index-sync`; provider/contributor changes still require an explicit rebuild or replace.

Direct one-file interactions, such as opening a media context menu, may check provider/embedded metadata before rendering UI and fill a missing or empty index row. Search result lists should not bulk-sync every hit.

---

## ComfyBridge

### Node Operations

```js
bridge.getNodesByType('KSampler');           // → LGraphNode[]
bridge.getNodeById(42);                       // → LGraphNode | null
bridge.setWidgetValue(42, 'seed', 12345);    // → boolean
bridge.getWidgetValue(42, 'seed');            // → any
bridge.getWidgetOptions(42, 'ckpt_name');    // → string[]
bridge.addWidgetOption(42, 'ckpt', 'model.safetensors');
bridge.invokeWidgetCallback(node, widget, value); // Set + callback + redraw
bridge.allNodes;                              // LGraphNode[]
bridge.canvas;                                // LiteGraph canvas or null
bridge.nodeOutputs;                           // app.nodeOutputs map
bridge.runningNodeId;                         // currently executing node ID or null
bridge.setDirtyCanvas(true, true);
bridge.notifyGraphChanged(true, true);        // graph.change() + redraw
bridge.getOutputLinks(node, 0);               // normalized output links
bridge.getWidgetForLinkedInput(42, 0);        // widget bound to target input
```

### Group Operations

```js
bridge.getGroups();                // → [{ title, bounding, color, ... }]
bridge.getNodesInGroup(group);    // → LGraphNode[]
```

### Node Mode

```js
bridge.getNodeMode(42);                    // → 0(Always) | 2(Mute) | 4(Bypass) | null
bridge.setNodeMode(42, 4);                // → boolean
bridge.setNodesModes([42,43,44], 4);      // Batch mode set
bridge.setNodesModesMap({ 42: 0, 43: 4 }); // Batch restore from { nodeId: mode }
bridge.isOutputNode(node);                 // → boolean
```

### Queue

```js
await bridge.queuePromptSimple(0, 1);    // Recommended (auto seed randomize)
await bridge.queuePrompt(1);              // Manual control
await bridge.queuePartial(['42', '43']);  // Queue selected output nodes only
await bridge.interrupt();
```

### Workflow

```js
await bridge.loadWorkflow(json, 'name');
await bridge.handleFile(file);
bridge.setWorkflowName('name');
bridge.exportWorkflow();                  // → JSON
bridge.workflowId;                        // Stable workflow identifier
const dispose = bridge.onGraphSwitch(({ newGraph, oldGraph }) => { ... });
```

### Workflow Extra Data

Persists data in `workflow.extra.comfyDrawer`:

```js
bridge.getWorkflowExtra('key', defaultValue);
bridge.setWorkflowExtra('key', value);    // Dot-path supported: 'deck.someKey'
```

### Files & Images

```js
await bridge.uploadImage(file, 'subfolder', true);
bridge.getImageUrl('img.png', '', 'output');          // → URL string
bridge.getImageUrl('img.png', '', 'output', { bustCache: true });
```

### HTTP

```js
await bridge.fetchApi('/drawer/endpoint', { method: 'POST', ... });
bridge.apiURL('/view?filename=x.png');     // base-path aware URL
```

### ComfyUI Settings

```js
bridge.getSetting('ComfyDrawer.XYZ.Prefix', 'default');
bridge.setSetting('ComfyDrawer.XYZ.Prefix', 'value');
bridge.addSetting({ id: 'MyGadget.Opt', name: 'Option', type: 'boolean', defaultValue: true });
```

### API Events

```js
bridge.onApiEvent('progress', handler);   // progress, executing, executed, execution_error
bridge.offApiEvent('progress', handler);
```

### Escape Hatch

```js
bridge.app    // Raw ComfyUI app object (last resort)
bridge.api    // Raw ComfyUI api object (last resort)
```

Use escape hatches only when ComfyUI has no stable callable surface for the behavior.
Current intentional uses are platform startup hooks (`queuePrompt`, `LGraph.configure`) and XYZ Plot's temporary queue lock.

---

## ContextMenuService

```js
const { contextMenu, attachContextTrigger } = window.ComfyDrawer;

// Register actions
contextMenu.register('my-type', [
    { id: 'my:action', label: 'Do Something', icon: '⚡', order: 10,
      action: (ctx) => { ... } },
    { id: 'my:delete', label: 'Delete', icon: '🗑️', order: 90,
      danger: true, visible: (ctx) => !!ctx.canDelete,
      action: (ctx) => { ... } },
]);

// Register fallback actions without overwriting existing action IDs
contextMenu.registerDefaults('my-type', {
    id: 'my:open', label: 'Open', action: (ctx) => { ... },
});

// Show menu
contextMenu.show('my-type', data, e.clientX, e.clientY);
contextMenu.hide();
contextMenu.isVisible; // boolean

// Right-click + long-tap helper (returns cleanup fn)
this.addDisposable(attachContextTrigger(el, (e) => {
    contextMenu.show('my-type', data, e.clientX, e.clientY);
}));

// Cleanup
contextMenu.unregisterByPrefix('my:');
```

### Built-in Ownership

| Type / Event | Owner | Rule |
|---|---|---|
| `media-file` type, `media:*` actions | Platform | Cross-gadget media actions only: open, workflow, download, send-to-node, mask |
| `media-file` type, `gallery:*` actions | Gallery | Gallery-owned file mutations: rename, select, delete |
| `gallery-folder`, `gallery-bg` | Gallery | Gallery-only folder/background actions |
| `drawer:*` bus events | Shell/platform services | Lifecycle, focus, graph, panel, back-button events |
| `fs:moved` | File-mutating gadget/service | Files or folders moved; payload includes `root`, optional `srcRoot`, and `files` |
| `fs:renamed` | File-mutating gadget/service | File or folder renamed; payload includes `root`, `subfolder`, `oldName`, `newName`, `isFolder` |
| `fs:deleted` | File-mutating gadget/service | Files or folders deleted; payload includes `root`, `files`, `deleted`, `deletedFolders` |
| `fs:created` | File-mutating gadget/service | File or folder created; payload includes `root`, `subfolder`, `name`, `path`, `isFolder` |
| `settings:*` bus events | Platform setting owner | Emit only when a setting changes behavior outside the settings UI |

When a gadget adds actions to a shared type such as `media-file`, the action ID prefix must name the gadget or owning scope. Platform actions must not call gadget-private methods; gadgets may show shared menus with context data.

---

## Lightbox

```js
const { openLightbox, closeLightbox, isLightboxOpen, removeLightboxItem } = window.ComfyDrawer;

const items = [
    { src: '/view?filename=img.png&type=output', type: 'image', label: 'Image 1' },
    { src: '/view?filename=vid.mp4&type=output', type: 'video' },
];

openLightbox(items, 0, {
    autoplay: true,
    contextMenuType: 'my-media',
    contextMenuData: (item) => ({ src: item.src, name: item.label }),
    onKey: (key, item, index) => { ... },
    onClose: () => { ... },
});
```

MediaItem: `{ src, type: 'image'|'video'|'audio', label?, details?, info?, name?, subfolder?, source?, data? }`

> `name`/`subfolder`/`source` auto-parsed from `src` URL if missing.

---

## MediaCard / MediaGrid

```js
const { createMediaCard, createMediaGrid } = window.ComfyDrawer;

const grid = createMediaGrid({ minColumnWidth: 160, gap: 10 });
container.appendChild(grid.element);

const card = createMediaCard({
    src: bridge.getImageUrl('img.png', '', 'output'),
    filename: 'img.png', subfolder: '', type: 'output',
    mediaType: 'image',
    lightbox: true, draggable: true, lazy: true,
    thumbHeight: 160,
    onContextMenu: (e) => { ... },
    lightboxItems: items,
    lightboxIndex: 0,
    lightboxOptions: { contextMenuType: 'media-file' },
    onFolderDrop: (folderPath) => { ... },
});
grid.add(card);

card.info.innerHTML = '<div>Custom info</div>';
card.element;              // root element
card.hasWorkflow;          // boolean | undefined while checking
card.thumb;                // thumbnail element
card.setSrc(newUrl);
card.destroy();
grid.clear();
```

---

## ImagePicker

```js
const value = await window.ComfyDrawer.openImagePicker({
    root: 'input',           // 'input' | 'output' | 'temp'
    subfolder: '',
    currentValue: 'sub/img.png',
    accept: 'image',         // 'image' | 'video' | 'audio' | 'all'
    onSelect: (value) => { ... },
});
// Returns 'subfolder/filename' or null
```

---

## Dialogs

```js
const { showAlert, showConfirm, showPrompt, showDialog } = window.ComfyDrawer;

await showAlert('Done!', { variant: 'info' });
const ok = await showConfirm('Delete?', { danger: true });
const name = await showPrompt('Enter name:', { defaultValue: 'untitled' });
const result = await showDialog({
    title: 'Form',
    variant: 'warning',
    content: (body) => {
        body.innerHTML = '<p>Custom content</p>';
        return () => ({ ok: true });
    },
});
```

Options:

| Option | Type | Description |
|---|---|---|
| `title` | string | Dialog header title |
| `icon` | string | Optional SVG string or emoji. If omitted, `variant` supplies the standard SVG |
| `variant` | `'info'|'warning'|'danger'|'prompt'` | Visual tone and default icon |
| `message` | string | Plain text body for simple dialogs |
| `content` | HTMLElement or function | Custom body. Function may return a `getData()` callback |
| `confirmLabel` | string or `null` | Confirm button text. `null` hides confirm |
| `cancelLabel` | string | Cancel/close button text |
| `showCancel` | boolean | Whether to show cancel/close button |
| `danger` | boolean | Uses danger styling for confirm and defaults variant to danger |
| `onValidate` | function | `(data) => errorMessage|null`, blocks confirm when it returns a message |
| `dismissOnBackdrop` | boolean | Whether clicking the backdrop cancels the dialog |
| `autoFocus` | boolean | Focus first input/confirm button on open |

Dialog chrome blocks text selection and native context menus. Editable controls (`input`, `textarea`, `select`, `contenteditable`) keep normal selection and right-click behavior.

---

## DictService

```js
const { dict, attachDictAutocomplete } = window.ComfyDrawer;

dict.register('my-dict', {
    label: 'My Dictionary',
    context: 'prompt',       // 'prompt' | 'search' | 'all'
    priority: 40,
    defaultEnabled: true,
    settingsToggle: true,
    load: async () => [{ t: 'masterpiece', c: -1, n: 999999 }],
});

await dict.search('mast', { context: 'prompt', limit: 12 });
dict.isEnabled('my-dict');
dict.setEnabled('my-dict', false);
dict.getDictionaries();

const cleanup = attachDictAutocomplete(textarea, {
    separator: ',',
    context: 'prompt',
});
this.addDisposable(cleanup);
```

`dict:suggest` is registered on the MessageBus. `tags:suggest` is also available as a backward-compatible alias.

---

## Workflow Utilities

```js
const { checkWorkflowAvailable, openWorkflowFromMedia } = window.ComfyDrawer;

const hasWF = await checkWorkflowAvailable({ src: imageUrl });
const ok = await openWorkflowFromMedia({ src: imageUrl, name: 'test.png' });
```

Item: `{ src?, name?, subfolder?, source? }` — provide either a parseable `src` or explicit `name`/`subfolder`/`source`.

---

## SettingsService

```js
const { settings, openSettingsPanel } = window.ComfyDrawer;

settings.get('key', defaultValue);
settings.set('key', value);
settings.delete('key');                               // Revert to default
settings.has('key');                                  // Explicitly set?
settings.keys('dict.*');                              // Glob search
settings.onChange('key', (key, value, oldValue) => { ... }); // Returns cleanup fn
settings.define('key', { type: 'toggle', label: 'Option', section: 'General', defaultValue: true });
settings.getDefinitions();                            // Map<section, definitions[]>
openSettingsPanel();
```

Supported types: `toggle`, `select`, `slider`, `text`, `color`, `color-palette`, `preset-theme`, `action`

---

## Shell

```js
const { shell } = window.ComfyDrawer;

shell.open('gallery');
shell.close();
shell.refresh();              // Emit graph refresh + call active onGraphChanged()
shell.isOpen;                 // boolean
shell.activeGadgetId;         // string | null
shell.hasFocus;               // boolean
shell.getGadgets();           // GadgetBase[] snapshot
shell.unregisterGadget('my-gadget');
shell.hideGadget('xyzplot');
shell.showGadget('xyzplot');
shell.isGadgetHidden('xyzplot');
shell.addBurgerAction({ icon: '⚙️', label: 'Settings', action: () => { ... } });
```

---

## MaskService

```js
const { maskService, bridge } = window.ComfyDrawer;

const result = await maskService.open({
    url: bridge.getImageUrl('img.png', '', 'output'),
    filename: 'img.png',
    bridge,
});

// result: { applied: boolean, filename: 'drawer_masks/...' } or null
maskService.close();
```

`open()` closes the lightbox if needed, opens the mask editor, uploads the generated mask to `input/drawer_masks`, and applies it to the selected `LoadImageMask` target or all compatible targets in auto mode. Compatible targets include direct `LoadImageMask` image widgets and connected DrawerControls.

---

## i18n

```js
const { t, addMessages, getLocale, setLocale } = window.ComfyDrawer;

// In gadgets (with fallback)
const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;

// Add 3rd-party translations
addMessages('en', { 'myGadget.title': 'My Gadget' });
addMessages('ja', { 'myGadget.title': '僕のガジェット' });
```

Fallback chain: **locale → en → key itself**

---

## Utilities

```js
const { escapeHTML, truncate, getLinkedInputNames, CollapseStore } = window.ComfyDrawer;

escapeHTML('<b>hi</b>');              // '&lt;b&gt;hi&lt;/b&gt;'
truncate('Hello World', 8);          // 'Hello Wo…'
getLinkedInputNames(node);           // Set<string>

const collapse = new CollapseStore('my-gadget-collapsed');
collapse.setScope(bridge.workflowId);      // Optional per-workflow isolation
collapse.save('section-1', true);
collapse.get('section-1');            // true
collapse.has('section-1');            // true if explicitly stored
```
