# ComfyUI-Drawer Coding Conventions

## File Structure

| Category | Location | Rules |
|---|---|---|
| Platform core | `web/js/core/` | Must NOT import gadget files |
| Shared CSS | `web/css/` | Global or service-scoped styles; keep selectors prefixed |
| Services | `web/js/services/` | Exposed through `window.ComfyDrawer`; built-in code may import stable shared modules |
| i18n | `web/locales/*.json` | Flat key-value pairs. `en.json` is fallback |
| Built-in gadgets | `web/gadgets/<id>/` | CSS root/prefix scoped; `@layer gadget-<id>` is preferred for new or touched CSS |
| Single-file gadgets | `web/js/ext-<id>.js` | CSS injected via `<style>` tag, scoped with a gadget root and preferably `@layer gadget-<id>` |
| 3rd-party gadgets | Other custom_node's `web/js/` | Access via `window.ComfyDrawer` only |

File naming:
```
gadget-<id>.js    # Built-in gadget entry
<id>.css          # Built-in gadget CSS
ext-<id>.js       # Single-file gadget (CSS embedded)
```

---

## JavaScript

### Strict Mode

- All files use ES Modules (implicit strict mode).
- No `var`. Use `const` by default, `let` when reassignment needed.

### Class Fields

```js
// Private fields for encapsulation
#items = [];
#isLoading = false;

// Public only when needed for external API
get items() { return this.#items; }
```

### Event Listener Cleanup

Always pair listeners with cleanup via `addDisposable`:

```js
onMount(container, bus, bridge) {
    this.addDisposable(bus.on('some:event', (data) => { ... }));

    const handler = (e) => { ... };
    bridge.onApiEvent('progress', handler);
    this.addDisposable(() => bridge.offApiEvent('progress', handler));
}
```

### Error Handling

```js
try {
    await fetch(...);
} catch (e) {
    console.error(`[ComfyDrawer:${this.id}] Error:`, e);
}
```

Log format: `[ComfyDrawer:<component>] message`

### i18n

New or touched user-visible strings should use `t()` unless they are symbolic labels, file/model/category names, dimensions, or intentionally stable identifiers. Legacy literals should be migrated when touched:

```js
const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;
container.innerHTML = `<p>${_t('common.loading')}</p>`;
```

| Rule | Detail |
|---|---|
| Key naming | `<scope>.<action>` (e.g. `gallery.deleteConfirm`, `common.cancel`) |
| Template vars | `{name}` syntax (e.g. `t('xyz.progress', { x: 1, y: 2 })`) |
| Fallback chain | locale → en → key itself |
| 3-file sync | `en.json`, `ja.json`, `zh.json` must stay in sync |
| JSDoc | May remain in Japanese (not user-facing) |

---

## CSS

### Scoping

| Target | Method | Example |
|---|---|---|
| Built-in gadgets | Gadget root + prefixed classes; optional `@layer gadget-<id>` | `.gadget-deck .dk-card { ... }` or `@layer gadget-gallery { ... }` |
| Single-file gadgets | Gadget root + prefixed classes; preferably `@layer gadget-<id>` in `<style>` | Same as above |
| Platform shared | Prefixed global/service selectors; optional service layer | `drawer.css`, `lightbox.css`, `context-menu.css` |

### Class Name Prefixes

| Gadget | Prefix | Example |
|---|---|---|
| Deck | `dk-` | `.dk-card`, `.dk-slider` |
| Gallery | `gg-` | `.gg-grid`, `.gg-breadcrumb` |
| ModelViewer | `mv-` | `.mv-card`, `.mv-info` |
| XYZ Plot | `xyzg-` (`xyz-` for a few shared/legacy sweep elements) | `.xyzg-axis`, `.xyzg-chip` |
| Home | `hm-` | `.hm-gadget-card`, `.hm-info-grid` |
| MediaCard/Grid | `mc-` | `.mc-card`, `.mc-grid` |
| MaskService | `ms-` | `.ms-overlay`, `.ms-toolbar` |
| Platform | `comfy-drawer-` or `cd-` | `.comfy-drawer-panel`, `.cd-lightbox` |

### Variables

Use Drawer platform tokens first. They are generated from the user-selected theme colors and keep built-in gadgets in sync across dark and light presets:

```css
var(--cd-panel)        /* Exact drawer base color */
var(--cd-shell)        /* Primary card / section surface */
var(--cd-s1)           /* Inputs and secondary surfaces */
var(--cd-s2)           /* Raised controls */
var(--cd-divider)      /* Borders and separators */
var(--cd-text)         /* Main text */
var(--cd-text-dim)     /* Secondary text */
var(--cd-accent)       /* Primary action / highlight */
var(--cd-danger)       /* Destructive action */
```

Use ComfyUI host variables only when a UI element intentionally needs to match the surrounding ComfyUI chrome:

```css
var(--comfy-menu-bg)        /* Panel background */
var(--comfy-input-bg)       /* Input backgrounds */
var(--border-color)         /* Borders */
var(--fg-color)             /* Text color */
```

Older gadget-local aliases such as `--gg-*`, `--hm-*`, and `--mv-*` are mapped to `--cd-*` in `drawer.css`; new code should prefer `--cd-*` directly.

### Duplicate Load Check

```js
if (!document.querySelector('link[href*="ComfyUI-Drawer"][href*="lightbox.css"]')) {
    // load CSS
}
```

---

## ComfyUI Integration

### Bridge-First Access

Do NOT access ComfyUI `app`/`api` directly. Use Bridge methods:

```js
// ✅ Correct
const nodes = this.bridge.getNodesByType('KSampler');
const url = this.bridge.getImageUrl(filename, subfolder, type);

// ❌ Wrong
const nodes = app.graph._nodes.filter(n => n.type === 'KSampler');
const url = `/view?filename=${filename}`; // Missing encodeURIComponent, apiURL
```

### Public API Changes

When adding, removing, or renaming anything exposed through `window.ComfyDrawer`, update these in the same change:

| File | What to sync |
|---|---|
| `web/js/comfy-drawer.js` | Public API export object and header comment |
| `GADGET_API.md` | Detailed usage and signatures |
| `ARCHITECTURE.md` | Public API overview tables |
| `README.md` / `README_ja.md` / `README_zh.md` | Only if the change is user-facing |
| `web/locales/*.json` | Any new user-visible string keys |

Prefer adding public APIs as small wrappers over stable services instead of exposing raw internals. Escape hatches such as `bridge.app` and `bridge.api` are for compatibility code only.

Home dashboard widgets should be registered through `registerHomeWidget()` and should return a cleanup function from `render()` when they attach external listeners, timers, or observers.

### DOM Selectors

Centralize ComfyUI DOM selectors as constants:

```js
static SNAP_SELECTORS = ['.workflow-tabs', '#comfyui-body-top'];
```

### Dialogs & Native Menus

Use the shared DialogService for all user-facing alerts, confirmations, prompts, and custom dialogs:

```js
const ok = await window.ComfyDrawer.showConfirm(_t('gallery.deleteConfirm'), { danger: true });
await window.ComfyDrawer.showAlert(_t('common.done'), { variant: 'info' });
```

| Rule | Detail |
|---|---|
| No native dialogs | Do not use browser `alert()`, `confirm()`, or `prompt()` in Drawer UI |
| No ad-hoc dialog DOM | Do not hand-build modal backdrops/panels; use `showDialog()` |
| Variants | Use `variant: 'info' | 'warning' | 'danger' | 'prompt'` instead of emoji prefixes |
| Icons | Prefer DialogService's built-in SVG icons. Pass `icon` only for a domain-specific SVG |
| Selection | Dialogs are non-selectable by default; inputs/selects/textareas/contenteditable remain selectable |
| Right-click | Native context menu is blocked on dialog chrome but allowed on editable controls |

When suppressing right-click elsewhere, use the same editable-target rule:

```js
const isEditableTarget = (target) =>
    !!target?.closest?.('input, textarea, select, [contenteditable="true"]');

el.addEventListener('contextmenu', (e) => {
    if (!isEditableTarget(e.target)) e.preventDefault();
});
```

### 3rd-Party Coupling

No imports. Use Bus for loose coupling:

```js
// ✅ Bus request with graceful degradation
try {
    const meta = await bus.request('meta:read', { filename, subfolder });
} catch { /* provider not installed */ }
```

---

## Security

| Area | Rule |
|---|---|
| Gallery/media deletion | Use `send2trash` (recycle bin); do not permanently delete browsed media from `/drawer/fs/delete` |
| Internal cleanup | Plugin-owned cache, previews, sidecars, and explicit destructive maintenance endpoints may use permanent deletion; keep validation and user confirmation at the caller |
| Path validation | Backend `_safe_path()` + `_ALLOWED_ROOTS` for traversal prevention |
| File moves | Validate both source and destination within allowed roots |
| User input | `encodeURIComponent()` for URL params, `escapeHTML()` for innerHTML |
| Metadata | Sidecar file sync is NOT Drawer's responsibility. Emit `fs:*` mutation events via Bus (`fs:moved`, `fs:renamed`, `fs:deleted`, `fs:created`) |

---

## Performance

- **Scroll/resize**: Debounce high-frequency events (150ms+)
- **Batch DOM**: Use `DocumentFragment` for bulk element insertion
- **Lazy load**: Use `loading="lazy"` or `IntersectionObserver` for images

---

## Shared Utilities (`utils.js`)

Available via ES import. The public subset is also exposed through `window.ComfyDrawer`.

| Function | Purpose |
|---|---|
| `escapeHTML(s)` | HTML special char escape for safe innerHTML |
| `truncate(s, max?)` | Truncate string with `…` (default 20 chars) |
| `getLinkedInputNames(node)` | Returns `Set<string>` of connected input names |
| `normalizePath(p)` | Normalize OS-native path separators to `/` (ES import only) |
| `CollapseStore(key)` | localStorage-backed collapse state manager |

### Naming Conventions

| Category | Convention | Example |
|---|---|---|
| Bus events | `<scope>:<action>` | `deck:generate-requested`, `drawer:opened` |
| Context menu IDs | `<scope>:<action>` | `media:open-tab`, `gallery:rename` |
| Context menu types | Noun-based | `media-file`, `gallery-folder` |
| DOM IDs | Kebab-case, descriptive | `gallery-sort-select` |
