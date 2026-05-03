# ComfyUI-Drawer Architecture

## Platform Overview

ComfyDrawer is a gadget platform for ComfyUI. **Drawer is the OS; gadgets are apps.**

```
┌──────────────────────────────────────────────────────────┐
│  window.ComfyDrawer (Public API)                         │
├──────────────────────────────────────────────────────────┤
│  ┌───────────┐  ┌────────────┐  ┌───────────────┐       │
│  │ DrawerShell│  │ MessageBus │  │  ComfyBridge  │       │
│  │ Panel/Tabs │  │ Pub/Sub    │  │ ComfyUI API   │       │
│  └─────┬─────┘  └──────┬─────┘  └───────┬───────┘       │
│  ┌─────┴───────────────┴────────────────┴──────────┐    │
│  │  Shared Services                                │    │
│  │  ContextMenu / Lightbox / Dialog / DictService  │    │
│  │  ImagePicker / Settings / Locale / MaskService  │    │
│  └─────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────┤
│  ┌──────┐ ┌─────────┐ ┌───────────┐ ┌──────────┐ ┌────┐│
│  │ Deck │ │ Gallery │ │ModelViewer│ │ XYZ Plot │ │ext ││
│  └──────┘ └─────────┘ └───────────┘ └──────────┘ └────┘│
└──────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Role |
|---|---|
| **DrawerShell** | Tab bar, panel open/close/resize, focus guard, back button |
| **MessageBus** | Pub/sub + request/respond between gadgets |
| **ComfyBridge** | Abstraction over ComfyUI `app`/`api` (nodes, groups, queue, files) |
| **ContextMenuService** | Right-click / long-tap menu |
| **Lightbox** | Fullscreen media viewer (image/video/audio) |
| **DialogService** | Alert, confirm, prompt, custom form dialogs |
| **SettingsService** | localStorage-backed settings with auto-generated UI |
| **DictService** | Multi-dictionary autocomplete (Danbooru, user, wildcard) |
| **ImagePicker** | Media file picker popup (image/video/audio) |
| **LocaleService** | i18n translation (`t()`), locale sync with ComfyUI |
| **MaskService** | Fullscreen mask editor and LoadImageMask integration |
| **GadgetBase** | Gadget lifecycle management (mount/activate/destroy) |

## Folder Structure

```
ComfyUI-Drawer/
├── __init__.py               # Thin ComfyUI entrypoint (exports mappings, loads routes)
├── drawer_nodes.py           # Python node definitions and NODE_* mappings
├── drawer_routes.py          # Backend HTTP routes and prompt hooks
├── nodes_switch.py           # DrawerSwitch node (V3 API)
├── data/                     # Static data (danbooru_tags.csv, etc.)
├── docs/
│   ├── top.webp              # README hero image
│   └── gadget-template.js    # Single-file gadget template
├── example_workflows/        # ComfyUI workflow templates and thumbnails
├── web/
│   ├── css/                  # Global CSS (drawer, lightbox, dialog, etc.)
│   ├── locales/              # i18n: en.json, ja.json, zh.json
│   ├── js/
│   │   ├── comfy-drawer.js   # Entry point (loaded by ComfyUI)
│   │   ├── ext-*.js          # Single-file gadgets (auto-loaded)
│   │   ├── utils.js
│   │   ├── core/             # Platform core (shell, bus, bridge, gadget-base)
│   │   ├── services/         # Platform services
│   │   └── components/       # Shared UI (media-card)
│   └── gadgets/              # Built-in gadgets (home, deck, gallery, modelviewer, xyzplot)
├── ARCHITECTURE.md
├── CONVENTIONS.md
├── GADGET_API.md
├── README.md / README_ja.md / README_zh.md
└── LICENSE
```

## Dependency Rules

```
ComfyUI (host)
    ↑ wrapped by ComfyBridge
Drawer Platform (Shell, Bus, Bridge, Services)
    ↑ injected via onMount
Gadgets (Deck, Gallery, XYZ, 3rd-party)
```

| Rule | Reason |
|---|---|
| Gadgets must NOT import other gadgets | Independent units; communicate via Bus |
| Platform core/services/components must NOT reference `gadgets/` | Dependency inversion; `comfy-drawer.js` is the composition root and may import built-in gadgets |
| Gadgets may use `window.ComfyDrawer` | Recommended public API access |
| No 3rd-party extension imports | Loose coupling via Bus events only |
| ComfyUI DOM selectors must be centralized as constants | Minimize breakage on ComfyUI updates |

## Bridge Boundary

Gadgets should use `ComfyBridge` for ComfyUI graph, queue, file, setting, and event access. `bridge.app` and `bridge.api` are compatibility escape hatches, not regular gadget APIs.

| Case | Boundary Decision |
|---|---|
| Node/widget reads and writes | Bridge API (`getNodeById`, `setWidgetValue`, `invokeWidgetCallback`) |
| Graph link traversal | Bridge API (`getOutputLinks`, `getWidgetForLinkedInput`) |
| Node mode changes | Bridge API (`setNodeMode`, `setNodesModes`, `notifyGraphChanged`) |
| Queueing normal/partial prompts | Bridge API (`queuePromptSimple`, `queuePartial`) |
| ComfyUI settings | Bridge API (`getSetting`, `setSetting`, `addSetting`) |
| Platform startup monkey-patches | Intentional escape hatch in `comfy-drawer.js` |
| XYZ Plot queue lock | Intentional escape hatch; temporarily wraps `app.queuePrompt` to block external queueing during a sweep |

New repeated gadget access to `bridge.app` should usually become a focused Bridge method. One-off compatibility hooks may stay as escape hatches when they are documented near the call site.

## Ownership Boundaries

### Bus Events

| Scope | Owner | Notes |
|---|---|---|
| `drawer:*` | DrawerShell / platform services | Shell lifecycle, focus, back-button, graph, tab, resize, gadget visibility |
| `comfy:*` | Platform bridge relay | ComfyUI API events normalized onto the bus |
| `settings:*` | Platform setting owner | Settings changes that affect another component, e.g. `settings:highlight-changed` |
| `fs:*` | File-mutating gadget/service | Emitted after successful filesystem mutation, e.g. `fs:moved` |
| `dict:*` / `tags:*` | DictService | Request/respond autocomplete API |
| gadget scopes (e.g. `deck:*`) | Owning gadget | Private or semi-private gadget workflow events |

Events should be emitted by the component that owns the state change. Consumers may listen, but should not depend on another gadget's private implementation details.

### Context Menu Types

| Type / Action Prefix | Owner | Responsibility |
|---|---|---|
| `media-file` + `media:*` | Platform | Shared media actions: open, load workflow, download, send to LoadImage/LoadImageMask, create mask |
| `media-file` + `gallery:*` | Gallery | Gallery-only mutations: rename, select, delete |
| `gallery-folder` | Gallery | Folder rename/select/create/delete |
| `gallery-bg` | Gallery | Background actions such as create folder |

Shared menu types are extension points, but action IDs must keep ownership visible via prefix. Platform-registered actions must remain self-contained and must not call gadget-private methods.

## Public API (`window.ComfyDrawer`)

### Gadget Lifecycle

| API | Description |
|---|---|
| `GadgetBase` | Base class to extend |
| `registerGadget(gadget)` | Register a gadget instance |

### Platform Services

| API | Type | Key Methods |
|---|---|---|
| `bus` | MessageBus | `on/off/emit`, `request/respond` |
| `bridge` | ComfyBridge | Node ops, queue, file I/O |
| `contextMenu` | ContextMenuService | `register/registerDefaults/show/hide/unregisterByPrefix` |
| `shell` | DrawerShell | `open/close/isOpen`, gadget visibility, burger actions |
| `settings` | SettingsService | `get/set/delete/onChange/define` |
| `dict` | DictService | `register/search/isEnabled` |
| `maskService` | MaskService | `open/close` |

### i18n

| API | Signature | Description |
|---|---|---|
| `t` | `(key, params?) → string` | Translate key (template `{var}` support) |
| `setLocale` | `(code)` | Change locale (`en`/`ja`/`zh`) |
| `getLocale` | `() → string` | Get current locale |
| `addMessages` | `(code, messages)` | Merge 3rd-party translations |

### UI Utilities

| API | Signature |
|---|---|
| `openLightbox` | `(items, startIndex?, options?)` |
| `closeLightbox` | `()` |
| `isLightboxOpen` | `() → boolean` |
| `removeLightboxItem` | `(index)` |
| `maskService.open` | `({ url, filename, bridge }) → Promise<object|null>` |
| `maskService.close` | `(result?)` |
| `openSettingsPanel` | `() → void` |
| `showDialog` | `(options) → Promise<*>` |
| `showAlert` | `(message, options?) → Promise<void>` |
| `showConfirm` | `(message, options?) → Promise<boolean>` |
| `showPrompt` | `(message, options?) → Promise<string|null>` |
| `openImagePicker` | `(opts?) → Promise<string|null>` |
| `attachContextTrigger` | `(el, handler) → cleanup` |
| `attachDictAutocomplete` | `(textarea, opts?) → cleanup` |

### Components

| API | Signature |
|---|---|
| `createMediaCard` | `(opts) → MediaCard` |
| `createMediaGrid` | `(opts?) → MediaGrid` |
| `escapeHTML` | `(s) → string` |
| `truncate` | `(s, max?) → string` |
| `getLinkedInputNames` | `(node) → Set<string>` |
| `CollapseStore` | `class` |
| `checkWorkflowAvailable` | `(item) → Promise<boolean>` |
| `openWorkflowFromMedia` | `(item) → Promise<boolean>` |
| `version` | `string` |

### Bus Event Conventions

Event names follow `<scope>:<action>` format:

| Scope | Examples |
|---|---|
| `drawer:` | `opened`, `closed`, `graph-changed`, `tab-changed`, `back-button`, `back-handled`, `panel-resized`, `focus-changed`, `gadget-registered`, `gadget-unregistered`, `gadget-visibility-changed` |
| `comfy:` | `executed` |
| `deck:` | `generate-requested`, `cancel-requested` |
| `dict:` | `suggest` request responder |
| `fs:` | `moved` |
| `settings:` | `highlight-changed` |
