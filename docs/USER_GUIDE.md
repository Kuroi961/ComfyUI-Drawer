# ComfyUI-Drawer User Guide

This guide explains ComfyUI-Drawer in more detail than the README. It is also written so it can be used as context for AI-assisted introductions, support, and Q&A about ComfyUI-Drawer.

## Core Idea

ComfyUI-Drawer does not replace the ComfyUI node graph with a separate app. The graph remains editable, while the controls you touch often during production are collected into a bottom drawer.

On desktop, Drawer works like a remote-control layer for the workflow on the canvas. On mobile and small screens, the Drawer itself becomes the main working surface. The goal is to keep parameter editing, output review, model selection, search, dictionaries, mask editing, and XYZ testing in one place.

Tools that run inside Drawer are called gadgets. Built-in gadgets include Home, Deck, XYZ Plot, Gallery, and Model Viewer. Custom nodes can also add their own gadgets.

## Where To Start

After installing ComfyUI-Drawer, a Drawer tab bar appears at the bottom of the ComfyUI screen. Press a tab to open Drawer. Press the same tab again to close it.

Main entry points:

- Home: status, storage overview, changelog, and system information
- Deck: main workflow parameter controls
- XYZ Plot: batch generation while sweeping parameters
- Gallery: media management for output/input/temp
- Model Viewer: browse and apply models under models paths
- Settings: themes, dictionaries, search index, cache, and maintenance

## Home

Home is Drawer's dashboard. It shows the current Drawer version, ComfyUI/Python/PyTorch system information, storage usage, and changelog entries.

The storage overview shows capacity usage for locations such as output, input, and models. This is useful before opening Gallery or Model Viewer, especially in environments with many generated images or videos.

Home can also receive widgets from external gadgets. Third-party extensions can place their own status panels or shortcuts there.

## Deck

Deck shows selected workflow nodes and groups as a Drawer-side control panel. You can keep the graph open while exposing only the parameters you use often.

### Display Markers

Deck reads markers in node and group titles.

| Marker | Target | Meaning |
|---|---|---|
| `📝` | Node title | Show that node's widgets on Deck's main screen |
| `⚡` | Node or group title | Show a bypass ON/OFF switch |
| `[label]` | Node or group title | Switch entries with the same label exclusively |

Nodes are ordered by their Y position on the canvas, and groups are ordered by X position. If a group contains any visible node, the group appears as a section on Deck.

### DrawerControls

DrawerControls nodes let you collect multiple workflow parameters into Deck. Only connected outputs are shown. Supported control types include `int`, `float`, `combo`, `bool`, and `string`.

String outputs can specify labels and multiline controls:

```text
string | Label
string | Label | multiline
```

Combo options are read from the connected target widget. If you want a cleaner Deck layout, DrawerControls are often easier to manage than adding markers directly to many normal nodes.

## XYZ Plot

XYZ Plot is a gadget for batch generation by sweeping parameters, similar in spirit to A1111's XYZ Plot. It does not require special XYZ nodes or extra wiring. Existing widgets and bypass states in the current workflow can be used as sweep targets.

### Basic Flow

1. Choose the target node and widget for the X/Y/Z axes.
2. Set value lists or ranges.
3. Run preflight validation.
4. Start generation, and each combination is queued.
5. A labeled grid image is saved to output.

For text widgets, Prompt S/R works as a Search & Replace mode. Seeds are fixed from the state at sweep start. Each iteration restores a snapshot and then applies only the axis value.

### Bypass Axes

XYZ Plot can sweep not only numeric and text values, but also node and group bypass states.

- Single node ON/OFF
- Deck group toggles
- Group-exclusive switches
- Node-exclusive switches

This makes it useful for comparing prompt differences, sampler settings, LoRA choices, ControlNet branches, and other workflow branches.

### Execution Protection

During a sweep, normal queue submission is temporarily blocked so outside actions do not mix with the sweep. Drawer also suppresses actions that would change the current workflow state, including Deck controls, sending media to LoadImage/LoadImageMask, opening Mask Editor from context menus, and applying models from Model Viewer info cards.
If a server disconnect is detected, the sweep is aborted.

## Gallery

Gallery manages media and folders under output, input, and temp. It supports images, videos, audio, and folders.

### Basic Operations

- Switch between output/input/temp
- Folder navigation with breadcrumbs
- Sort by name/date/size
- Filename search
- Rename files and folders
- Move files and folders
- Delete files
- Create folders
- Send images to LoadImage / LoadImageMask
- Open images, videos, and audio in Lightbox
- Open workflows from images

When available, deletion sends files to the OS trash/recycle bin instead of permanently deleting them.

### Search Index

Filename search works without a search index. To search prompt, workflow, node type, node title, or custom metadata, create the SQLite search index.

The index is created only when the user explicitly starts it, so Drawer does not silently begin a heavy scan in large libraries. Before creation, Drawer performs a quick estimate and shows a confirmation dialog depending on the file count and estimated time.

After the index is created, file additions, moves, renames, and deletes are reconciled at low priority. Existing file metadata is treated as a search snapshot and is not reinterpreted during normal sync. If providers or contributors are added or changed, sync switches to a metadata refresh path.

Large output/input folders can take time to index. Drawer shows progress while indexing, reports completion for user-started builds and syncs, and shows an error dialog if indexing or sync fails. The initial estimate is reused when possible so starting an index build does not immediately repeat the same counting pass.

### Search Syntax

Space-separated terms are treated as AND:

```text
white hair blue eyes
```

Quoted text is treated as a phrase:

```text
"white dress"
```

Use `-word` or `-"quoted phrase"` for NOT terms:

```text
white hair -night
"flower field" -"low quality"
```

Use `type:...[]` to search only values inside a specific node type. The `[]` part acts like a virtual search field.

```text
type:CLIPTextEncode[white hair -night]
```

Use `title:...[]` to filter by node title.

```text
title:positive[blue sky]
title:"Prompt A"[school uniform]
```

If a third-party custom metadata contributor is registered, custom metadata can be searched like this:

```text
myPlugin[black hair]
myPlugin:tags[black hair]
myPlugin:project[archive A]
```

`namespace[value]` searches all custom fields inside that namespace. `namespace:key[value]` searches only a specific key.

### Search Target Filter

The Gallery search target menu can toggle these targets:

- Filename
- prompt title
- prompt value
- workflow title
- workflow value
- Custom metadata

The custom metadata option is shown only when an index contributor is registered. If none exists, it is hidden and is not included in search targets.

### Metadata Panel

From Gallery, the metadata panel can show file summary information, workflow node summaries, prompt values, and Raw JSON.

If a third-party metadata panel contributor is registered, custom metadata can also be displayed there. Drawer does not force a third-party storage format; contributors decide how their data should be shown in Drawer.

## Model Viewer

Model Viewer browses ComfyUI's `models` folder and model paths added through `extra_model_paths.yaml`.

### Supported Model Types

It can cover common ComfyUI model folders such as checkpoints, loras, vae, embeddings, controlnet, and upscale_models.

### Thumbnails and Previews

Models can have sidecar preview images. You can set an output image as a model preview or delete an existing preview. Video previews such as `.mp4` and `.webm` are also supported.

Video thumbnails and video/audio metadata use external `ffmpeg` / `ffprobe` binaries when they are available. If `ffmpeg` is unavailable, video thumbnails fall back to a placeholder.

### CivitAI Sync

Model information can be fetched from CivitAI using the SHA256 hash. Drawer supports `.red` and `.com` fallback, and can display model information, preview images, and LoRA trainedWords.

### Node Matching

From the Model Viewer info card, a model can be applied to compatible loader nodes in the current workflow. The scan includes normal nodes, subgraphs, Combo Clone widgets, and connected DrawerControls.

## User Dictionaries, Wildcards, and Comments

Drawer includes a dictionary service for prompt autocomplete. Dictionaries are managed from Settings.

### Dictionary Types

- Danbooru tag dictionary: tag CSV with usage counts
- User dictionary: CSV mapping `tag` to `insert_text`
- Wildcard: TXT used by `__name__` random expansion
- Custom metadata keys: search completion candidates registered by third-party dictionary providers

User dictionaries and the Danbooru dictionary can be used in prompt inputs and Gallery search. Custom metadata keys appear in Settings only when a dictionary provider is registered.

CSV and TXT imports are limited to about 5 MB per file.

### Wildcards

Wildcards use `__name__` syntax. If an enabled wildcard dictionary has the same name, one candidate line is selected. No nodes or wiring are required. String inputs in the prompt payload at queue time are processed.

```text
masterpiece, __style__, 1girl
```

Expansion is based on `seed`, `noise_seed`, or `seed_value` in the workflow. If a seed is found, the same seed produces the same expansion. If no seed is found, normal random selection is used.

Recursive wildcard expansion is not performed. If a candidate contains another `__name__`, that text remains unchanged.

### Comments

Drawer can remove comments from prompt text when the prompt is queued. Like wildcards, this needs no nodes or wiring, and string inputs in the prompt payload are processed.

```text
masterpiece, best quality
// this line is ignored
# this line is also ignored at line start
/* block comment */
```

Comments are removed from the execution prompt, but kept in the workflow metadata embedded in outputs. Wildcards inside comments are not expanded.

## Mask Editor

Mask Editor is a simple mask editing UI opened from an image context menu. Generated masks are saved under `input/drawer_masks` and can be applied directly to LoadImageMask nodes.

It is useful when you want to open an image from Gallery or Lightbox and quickly mask part of it inside ComfyUI. It is not meant to replace a full image editor, but it is convenient for quick in-ComfyUI edits.

## Shared UI

Drawer gadgets use shared UI services for consistent behavior.

### Context Menu

Right-click or long-press opens the context menu. Shared actions include opening images in a new tab, sending images to LoadImage, opening workflows, downloading, and creating masks.

Gadgets and third-party extensions can add their own actions to the same context menu.

### Lightbox

Lightbox is a fullscreen viewer for images, videos, and audio. It is available from Gallery, Deck, XYZ Plot, and shared media cards.

It supports keyboard navigation, swipes, previous/next buttons, and context menus inside Lightbox.

### Dialog

Drawer provides shared `showAlert`, `showConfirm`, `showPrompt`, and `showDialog` APIs. They are used by settings, search index flows, confirmation actions, and third-party gadget forms.

### Image Picker

Image Picker is a modal picker for selecting media files. It is used, for example, when choosing an output image as a model preview.

## Settings

Settings handles Drawer-wide configuration and maintenance actions.

Main items include:

- Theme and accent colors
- Dictionary enable/disable toggles
- User dictionary, wildcard, and Danbooru dictionary management
- Search index creation, sync, and auto sync
- Cache clearing

## Third-Party Extensions

ComfyUI-Drawer is not only a set of built-in UI tools. It is designed as a small platform that external custom nodes can extend.

### JavaScript Gadgets

External custom nodes can register Drawer gadgets by placing JavaScript under `custom_nodes/*/web/js/`. Public APIs are available from `window.ComfyDrawer`, including `GadgetBase`, `bus`, `bridge`, `settings`, `dict`, `showDialog`, and `contextMenu`.

Simple gadgets can be self-contained in one file. See `GADGET_API.md` for details.

### Python Metadata Extensions

Gallery metadata processing can be extended through Python registration APIs.

- metadata provider: returns raw metadata other than embedded metadata
- index contributor: converts custom metadata in raw metadata into Drawer search index fields
- metadata panel contributor: adds custom metadata display content to the metadata panel
- dictionary provider: provides autocomplete candidates for search or prompts

The important point is that Drawer does not prescribe a third-party storage format. Custom metadata may live in `workflow.extra`, sidecar files, or databases. Drawer consumes raw metadata and uses only the normalized Drawer-facing values returned by contributors/providers.

Search contributors and dictionary providers are separate. A search contributor puts values into the index. A dictionary provider supplies autocomplete candidates. In many cases a plugin will register both, but either one can be registered alone.

## Mobile Use

Drawer is designed with mobile and small screens in mind. By collecting operations in the bottom Drawer, the main workflow can be used without constantly manipulating the entire node graph.

Especially useful on mobile:

- Use Deck to operate only the parameters you need
- Use Gallery to review, search, delete, and open generated workflows
- Use Model Viewer to find models and LoRAs
- Use Lightbox to review images and videos fullscreen
- Use long-press to open Context Menu
- Use Settings to manage dictionaries and the search index

Popups are adjusted to fit within the viewport because mobile browser UI and screen dimensions vary widely.

## FAQ

### Is Drawer a replacement for APP mode?

Not exactly. APP mode turns a workflow into something app-like. Drawer keeps the node graph open and provides a control surface for editing, testing, and iteration.

### Do I need special nodes?

Many features do not require special nodes. Gallery, Model Viewer, Lightbox, Context Menu, and search work without adding nodes to the workflow.

For a cleaner Deck, node title markers and DrawerControls are useful. XYZ Plot also does not require a dedicated XYZ node. It targets widgets already present in the current workflow, and exclusive switches can broaden what you can test.

### Is the search index required?

Not for filename search. It is required for searching prompt, workflow, node, and custom metadata.

### Is the search index created automatically?

No. Drawer does not silently start a heavy operation in large libraries. The user explicitly starts indexing, and a quick estimate plus confirmation is shown first.

### Can third-party custom metadata be searched?

Yes, if there is an index contributor that knows how to convert that metadata into search index fields. The metadata does not need to be migrated into a Drawer-specific storage format.

### Can images with embedded workflows be opened?

Yes. Gallery and Context Menu can open images with workflow metadata as workflows. If a metadata provider exists, non-embedded raw metadata can also be used provider-first.

### Do comments and wildcard expansion remain in output metadata?

Comments are removed from the execution prompt but preserved in workflow metadata. Wildcard expansion results are also reflected so they can be inspected from metadata.

## Further Documentation

- `README.md`: overview, installation, and main features
- `GADGET_API.md`: JavaScript/Python extension API
- `ARCHITECTURE.md`: design principles, boundaries, and internal structure
- `CONVENTIONS.md`: code conventions, UI/CSS rules, and development notes
- `CHANGELOG.md`: release notes
