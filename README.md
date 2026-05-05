<p align="center">
  <img src="docs/top.webp" alt="ComfyUI-Drawer" width="100%">
</p>

<h3 align="center">A mobile-friendly modular UI platform for ComfyUI</h3>

<p align="center">
  <a href="#what-is-comfyui-drawer">Overview</a> •
  <a href="#why-drawer">Why Drawer?</a> •
  <a href="#installation">Installation</a> •
  <a href="#sample-workflows">Samples</a> •
  <a href="#built-in-gadgets">Gadgets</a> •
  <a href="#workflow-utilities">Utilities</a> •
  <a href="#shared-ui-system">UI System</a> •
  <a href="#drawer-nodes">Nodes</a> •
  <a href="#developer--agent-notes">Development</a> •
  <a href="CHANGELOG.md">Changelog</a> •
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <a href="README_ja.md">日本語</a> •
  <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/ComfyUI-Custom_Node-purple.svg" alt="ComfyUI Custom Node">
  <img src="https://img.shields.io/badge/lang-en%20%7C%20ja%20%7C%20zh-green.svg" alt="Languages: en, ja, zh">
</p>

---

## Feature Demo

https://github.com/user-attachments/assets/a9ba848f-11eb-42f7-9fc8-31616ed82df5

Note: This demo includes third-party custom nodes that are not included with ComfyUI-Drawer.

---

## What is ComfyUI-Drawer?

ComfyUI-Drawer turns complex ComfyUI workflows into compact, touch-friendly control panels.

Keep your node graph intact, expose only the parameters you actually want to touch, and manage outputs, model assets, masks, and parameter sweeps from one bottom drawer.

The drawer is modular, so it can host workflow controls, media management, model browsing, plotting tools, and custom extensions in one place.

---

## Why Drawer?

On desktop, ComfyUI-Drawer adds a remote-control layer to the ComfyUI canvas: keep the graph open, but operate the controls, assets, and inspection tools you actually touch from one bottom drawer.

On mobile and small displays, that same drawer becomes the main working surface. It makes active creation practical by keeping parameter control, output review, model browsing, mask editing, prompt dictionaries, and XYZ sweeps within reach.

Unlike APP mode, Drawer is designed for editing, testing, and iterating on workflows without turning them into separate apps.

---

## Installation

### Via ComfyUI-Manager (Recommended)

Search for **ComfyUI-Drawer** in the [ComfyUI-Manager](https://github.com/ltdrdata/ComfyUI-Manager) install menu.

### Manual Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Kuroi961/ComfyUI-Drawer.git
pip install -r ComfyUI-Drawer/requirements.txt
```

---

## Sample Workflows

<p align="left">
  <img src="docs/sample.webp" width="50%">
</p>

You can open ComfyUI-Drawer sample workflows from ComfyUI's template browser.

- `drawer-sample-anima` — A sample workflow that demonstrates the basic Drawer workflow
- `drawer-sample-anima-advanced` — A more practical workflow using external custom nodes. Additional models and nodes are required (`rgthree-comfy`, `comfyui-impact-pack`, `comfyui-ppm`, `comfyui-kjnodes`, `comfyui-easy-use`, `seedvr2_videoupscaler`)
- `drawer-tutorial-deck-ja` / `drawer-tutorial-deck-en` / `drawer-tutorial-deck-zh` — Tutorials for displaying workflow nodes in Deck

---

## Built-in Gadgets

In ComfyUI-Drawer, each tool that lives inside the drawer is called a **gadget**.

### Deck

<p align="left">
  <img src="docs/deck.webp" width="50%">
</p>

A gadget for quick parameter control of your workflow.

**Display Control:**

Add **markers** to node or group titles to control what appears in Deck.

| Marker | Target | Effect |
|--------|--------|--------|
| `📝` | Node title | Shows that node's widgets on the Deck main screen |
| `⚡` | Node or group title | Adds a bypass ON/OFF switch |
| `[label]` | Node or group title | Creates an exclusive bypass switch among items with the same label |

Nodes are sorted by Y position from top to bottom. Groups are sorted by X position from left to right.

**Other behavior:**

- Groups are always shown as sections if they contain at least one visible node
- Ungrouped nodes are collected at the end under Other
- A bottom-left button can show nodes that do not contain `📝`

---

### XYZ Plot

<p align="left">
  <img src="docs/xyzplot.webp" width="50%">
</p>

https://github.com/user-attachments/assets/64fbe663-8f16-4f4c-b9b1-0ae5173eb9a1

A parameter sweep gadget familiar from Stable Diffusion web UI (A1111). Behavior is largely consistent with A1111.

No dedicated XYZ nodes or extra wiring are required; sweep the widgets and bypass states already present in the current workflow.

**Basic features:**

- Assign any widget from any node to the X/Y/Z axes for sequential generation
- Text widgets automatically use Prompt S/R (Search & Replace) mode
- Bypass axes — use node ON/OFF, Deck group toggles, group switches, and node switches as sweep dimensions
- Automatically generates a labeled grid composite image and saves it to output

**Technical details:**

| Feature | Details |
|---------|---------|
| **Queue lock** | During a sweep, `app.queuePrompt` is monkey-patched to block external queue submissions. It is restored after the sweep finishes |
| **Seed pinning** | A snapshot of all widget values is taken at sweep start. Before each iteration, the snapshot is restored, then axis values are applied on top |
| **DrawerSeed integration** | DrawerSeed randomization is executed once just before the sweep. During the sweep, `window.__xyzSweepActive` suppresses DrawerSeed's queue hook randomization |
| **batch_size enforcement** | Non-sweep `batch_size` widgets are forced to `1`. `control_after_generate` is forced to `fixed` |
| **Preflight validation** | Widget type and value ranges are validated before the sweep starts; mismatches trigger a warning |
| **Server disconnect detection** | WebSocket `status` / `reconnecting` events are monitored, and the sweep is aborted immediately if the server disconnects |
| **Workflow embedding** | Embeds workflow JSON into composite images as PNG PngInfo or JPEG/WebP EXIF |

---

### Gallery

<p align="left">
  <img src="docs/gallery.webp" width="25%">
</p>

A gadget for browsing media and folders under the output, input, and temp directories.

- Folder navigation with breadcrumbs, sorting by name/date/size
- File rename, move (D&D / batch selection), and delete
- Automatically builds a SQLite search index on first launch, enabling full-text search by workflow metadata such as node type, node title, and input values
- New folder creation, folder move, and folder delete

---

### Model Viewer

<p align="left">
  <img src="docs/modelviewer.webp" width="25%">
</p>

A gadget for browsing models and folders under ComfyUI's models directory and model paths added through `extra_model_paths.yaml`.

- Supports all model types, such as checkpoints, loras, vae, embeddings, controlnet, upscale_models, and more
- **CivitAI sync** — Fetch metadata and preview images by SHA256 hash matching, with `.red` / `.com` fallback
- **Node matching** — From the info card, apply a model to compatible loader nodes in the current workflow. This scans all nodes, including subgraphs, Combo Clone widgets, and connected DrawerControls
- **Trigger words** — CivitAI `trainedWords` are shown automatically. Custom words can also be added for LoRA models
- Sidecar thumbnail support, with output-image picker and delete actions
- Video previews (`.mp4` / `.webm`) in the grid and info card
- Per-model user memos persisted in `.drawer.json`

---

## Workflow Utilities

<p align="left">
  <img src="docs/others.webp" width="50%">
</p>

### User Dictionaries & Wildcards

A built-in dictionary service for prompt autocomplete.

https://github.com/user-attachments/assets/34237d5e-cd92-4a8e-a638-cb6d98256536

- **Danbooru tag dictionary** — Tag database with usage counts (CSV)
- **User dictionaries** — Create custom tag → insert text mappings
- **Wildcards** — Use `__name__` syntax to randomly select one line from a list
- **CSV / TXT import** — Import existing tag files
- **Comment syntax** — Use `//`, `#`, and `/* */` to comment out parts of prompts
- **No nodes required** — Wildcards and comment stripping are applied automatically when the prompt is queued

Dictionaries can be created, edited, and toggled from the Settings panel. You do not need to add wildcard, dictionary, or preprocessing nodes to the workflow. Normal prompt nodes, text passed through DrawerControls, and other string widgets can use comment stripping and wildcard expansion automatically when ComfyUI queues the prompt.

**Prompt processing behavior:**

- `__name__` expands to one line from an enabled wildcard dictionary with the same name
- Expansion is based on `seed`, `noise_seed`, or `seed_value` in the workflow. If a seed is found, the same seed produces the same expansion. If no seed is found, normal random selection is used
- Comments are removed from the execution prompt, but preserved in the workflow metadata embedded in output images
- `/* ... */` is a block comment, `// ...` is a line comment, and `# ...` at the beginning of a line is also treated as a line comment
- Escaped markers such as `\#` and `\/` are treated as literal characters, not comment starts

**CSV / TXT import format:**

User dictionaries are imported as CSV. Wildcards are imported as TXT. CSV files require a header row.

```csv
tag,insert_text
sky,"blue sky, clouds"
masterpiece,"masterpiece, best quality"
```

- `tag` is the name shown in autocomplete
- `insert_text` is the text inserted when selected. If empty, the `tag` itself is used
- Values containing commas should be quoted like normal CSV

Wildcard TXT files use one candidate per line. The imported filename, or the dictionary name set in Settings, becomes the name used in `__name__`.

```txt
blue sky, sunlight
night city, neon lights
soft backlight, floating particles
```

- Empty lines are ignored
- Lines beginning with `#` or `//` are not used as wildcard candidates
- Recursive wildcard expansion is not performed. If a candidate contains `__other__`, that text remains as-is
- Wildcards inside comments are not expanded

### Mask Editor

A fullscreen mask editor available from image context menus. It saves generated masks under `input/drawer_masks` and can apply them directly to `LoadImageMask` nodes.

---

## Shared UI System

### Context Menu

A right-click / long-press menu. It supports opening media in a new tab, sending images to LoadImage / LoadImageMask, opening media as a workflow, downloading, and gadget-specific custom menu actions.

### Lightbox

A fullscreen media viewer for images, videos, and audio. It opens from Gallery, Deck, XYZ Plot, and shared media cards.

- Keyboard navigation (←→ / A/D), swipe, and previous/next buttons
- Click the current image, or use the context menu, to open media in a new tab
- Images can be dragged from the lightbox onto the ComfyUI canvas
- Context menu support inside the lightbox

### Popups & Dialogs

Provides `showAlert`, `showConfirm`, `showPrompt`, and `showDialog`.

### File Picker

A modal picker for media selection. It supports image, video, and audio selection with thumbnail folder navigation.

### Multi-language Support

Supports English, Japanese, and Chinese (Simplified). The language automatically follows ComfyUI's Settings > Locale preference.

---

## Drawer Nodes

9 utility nodes with dedicated Deck-side UI support.

| Node | Description |
|------|-------------|
| **DrawerSeed** | Seed node with randomize / fixed modes |
| **DrawerControls1 / 4 / 8 / 12** | Compact parameter hubs. Only connected outputs appear as Deck controls: `int`, `float`, `combo`, `bool`, or `string`. Use `string \| Label` for single-line text and `string \| Label \| multiline` for multiline text. Combo options are read from the connected target widget |
| **DrawerConcat** | Joins variable-length text inputs with a configurable delimiter |
| **DrawerSize** | Resolution presets for landscape, portrait, and square outputs |
| **DrawerSwitch** | Universal A/B switch for any data type. If B is connected and non-empty, B is returned; otherwise A is returned. Uses ComfyUI V3 API lazy evaluation so the unnecessary branch is not executed |
| **DrawerSwitchChain** | Variable-length fallback chain. The last connected non-empty value wins |

---

## Developer / Agent Notes

ComfyUI-Drawer is designed as an extensible platform. You can create **self-contained gadgets in a single file**:

1. Copy [docs/gadget-template.js](docs/gadget-template.js)
2. Place it in any `custom_nodes/*/web/js/` folder. It does not have to be inside ComfyUI-Drawer itself
3. Modify the class and restart ComfyUI

```js
import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "Comfy.Drawer.MyGadget",
    async setup() {
        const drawer = window.ComfyDrawer ?? await new Promise(resolve =>
            window.addEventListener('comfy-drawer:ready', e => resolve(e.detail), { once: true })
        );
        const { GadgetBase } = drawer;

        class MyGadget extends GadgetBase {
            constructor() {
                super('my-gadget', { label: 'My Gadget', icon: '🔧', order: 10 });
            }
            onMount(container, bus, bridge) {
                container.innerHTML = '<p>Hello World</p>';
            }
        }

        drawer.registerGadget(new MyGadget());
    },
});
```

- `window.ComfyDrawer` exposes services such as `GadgetBase`, `bus`, `bridge`, `settings`, and `dict`
- CSS can be injected with a `<style>` tag. Scoping with `@layer gadget-<id>` is recommended
- The only external import needed is `app.js`; gadgets do not need to depend on Drawer internals

See [GADGET_API.md](GADGET_API.md) for the complete API reference.

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Platform architecture, module responsibilities, and design decisions |
| [CONVENTIONS.md](CONVENTIONS.md) | Code style, CSS scoping, and naming conventions |
| [GADGET_API.md](GADGET_API.md) | Gadget development API reference |

---

## About This Project

ComfyUI-Drawer is 100% coded by AI under human direction, review, and testing.

---

## License

[MIT License](LICENSE) © 2026 Kuroi
