# Changelog

## Unreleased

### XYZ Plot

- Add Zip mode to XYZ Plot: a "Zip" checkbox between each axis pair locks the two axes into lock-step iteration instead of a cartesian product, enabling sweeps like `(model, lora)` pairs that generate N images rather than N×M
- Fix XYZ Plot composite image and completion toast not appearing after a sweep: progress-bar DOM references were scoped inside the `try` block and were inaccessible in the `finally` block, causing a `ReferenceError` that silently aborted post-sweep cleanup
- Fix XYZ Plot progress fill and count not reflecting completion immediately after each generation
- Add axis name labels (e.g. `Checkpoint + LoRA →`) to Zip mode grid composite images
- Install the XYZ Plot `app.queuePrompt` wrapper inside the same `try { … } finally { … }` that restores it, so an early throw during sweep setup cannot leave the queue permanently locked
- Localise the XYZ Plot pre-sweep caution dialog so the title, body, buttons, and checkbox label follow the user's selected language

### Security

- Stop `delete_model` from sweeping a sibling's `foo.preview.*` / `foo.png` previews when another model file with the same stem still lives in the directory; symlinked sidecars are also skipped before send2trash
- Replace three unbounded CivitAI preview downloads with a shared `_download_preview_to_file` helper that enforces a hard byte cap, a Content-Type allowlist, image verification via `open_image_checked`, and an atomic `os.replace`
- Verify the source bytes via `open_image_checked(verify=True)` before copying an output image into a model's preview sidecar
- Make `_save_grid` resolve `output_dir` through `realpath` and validate the filename prefix via `safe_path` + `is_plain_name`, replacing a brittle `commonpath` check that could raise on Windows drive boundaries
- Refuse symlinks and cap recursion in `_merge_dirs`; skip symlinked entries during `fs_browse`, `summarize_tree`, `_search_filesystem_raw`, and `clear_drawer_cache` so a planted link inside `output`/`input`/`temp` cannot expose paths outside the allowed root
- Route `fs_move` overwrite through `send2trash` instead of `os.remove` so gallery-browsed media never disappears permanently
- Make `/drawer/reboot` async so the JSON response reaches the client before `os.execv` replaces the process
- Validate `subfolder` / `name` through `safe_path` in `search_index.update_searchable` so the indexer cannot be tricked into addressing a file outside the allowed root
- Reject unsafe dictionary IDs in `dict_store.dict_file_path` via `^[A-Za-z0-9_-]{1,64}$` allowlist (drops Windows drive letters, alternate streams, control chars); add format checks to `update_user_dict_meta` and `delete_user_dict_full`
- Cap iTXt zlib decompression in `media_metadata` so a decompression-bomb PNG cannot inflate hundreds of MiB during indexing
- Filter link schemes in Deck's Markdown renderer after HTML-entity escaping so `[click](javascript:…)` renders as plain text; only `http(s):`, `mailto:`, `#anchor`, and relative paths are accepted
- Escape every user/third-party value (`m.t`, `m.orig`, `m.displayText`, `m.insertText`, `m.providerLabel`) before insertion into the dictionary autocomplete dropdown
- Render `item.info` in the lightbox via `escapeHTML`; add `item.infoHTML` as the explicit trusted-HTML escape hatch and document the split in `GADGET_API.md`
- Validate `ctx.src` / `item.src` against `new URL()` + same-origin `http(s)` allowlist in media context-menu actions and `openInNewTab` before reaching `window.open` / `<a href>`; pass `noopener,noreferrer`
- Close ModelViewer's CivitAI sync `EventSource` and clear every tracked toast / sync-strip timer in `onDestroy` so stale handlers cannot fire against a destroyed gadget
- Sanitize gadget tab and burger-menu labels via `textContent` (icon stays `innerHTML` for raw SVG) so a malicious third-party `gadget.label` cannot inject HTML

### Correctness and performance

- Run `fs_delete` / `fs_move` / `fs_rename` / `fs_mkdir` / `delete_model` / `clear_drawer_cache` blocking I/O on a worker thread via `asyncio.to_thread` so large filesystem operations don't stall the event loop
- Resolve the previous `MaskService.open()` promise with `null` on re-entrant open and install a document-level Escape handler while the overlay is visible; remove the listener on close
- Add a request-sequence check to Gallery `#loadMoreSearch` so a stale load-more response cannot append to a fresh query; drop the `gg-initial-loading` overlay on `AbortError` too
- Handle ComfyUI's function-form `widget.options.values` in Bridge `getWidgetOptions` / `addWidgetOption`; encode the `type` parameter in `getImageUrl`; stop `loadWorkflow` from mutating the caller's `workflowData`
- Stop `import_user_dict` from double-decoding the multipart body (aiohttp's `BodyPartReader` already decoded the transfer-encoding while streaming)
- Make `update_user_dict_meta` accept non-string titles instead of crashing on `AttributeError`; make `delete_user_dict_full` validate the dict ID and delete the data file before clearing the manifest entry
- Use `_write_json_file_atomic` for `.civitai.info` / `.drawer.json` sidecar writes
- Scope the `comfy-drawer.js` modal-dialog `MutationObserver` to direct children of `document.body` (PrimeVue and `.comfy-modal` are always appended there), avoiding a fire on every DOM change anywhere

### Accessibility

- Add `role="dialog"` + `aria-modal="true"` + `aria-labelledby` to Dialog, Lightbox, MaskService, and ImagePicker
- Trap Tab focus inside modal dialogs so it cannot leak into the canvas behind
- Restore the previously-focused element on dialog dismiss
- Update the lightbox `<img alt>` per item so screen readers announce the current item; label the prev/next/close buttons via `aria-label`
- Exempt editable form controls (`input`, `textarea`, `select`, `[contenteditable]`) from `contextmenu` suppression so the browser Paste menu survives

### Maintainability

- Add `_internal_error(exc, where=…)` helper and route every `status=500` response through it; the client now receives a generic `"internal error"` message instead of the absolute server filesystem path from `OSError`/`PermissionError`
- Replace per-gadget toast helpers with a shared platform `showToast` (`window.ComfyDrawer.showToast`) that stacks toasts inside a single `role="region"` `aria-live="polite"` container, follows theme tokens, and tracks fade-out timers; Gallery and ModelViewer delegate to it
- Settings panel now passes a `cleanups` array through to action / color-palette / preset-theme builders and unsubscribes every `settings.onChange` listener on dialog dismiss; the per-setting `MutationObserver` workaround is gone
- Consolidate per-file `escapeHTML` / `escapeText` duplicates onto the shared `utils.js` export (previous local copies skipped `"` and `'`)
- Add explicit radix to every frontend `parseInt()` call (19 sites) and pin the rule with a regression test that walks parens to catch new offenders
- Restore the original "leave history entry stale" dialog-dismiss pattern after a brief attempt at `history.back()` cascade-closed the drawer; the rationale is documented in `dialog.js` and `drawer-shell.js`

### Internationalisation

- Localise the metadata viewer dialog: 22 new `menu.meta*` keys cover the section titles, prompt / negative-prompt labels, A1111 / NovelAI overview headers, "Show labels" checkbox, node-type controls, third-party section header, and Raw JSON disclosure
- Localise the Gallery Temp folder warning dialog and the "Cannot search in Temp folder" status message
- Add `common.errorWith` placeholder so each language picks its own error separator (Gallery and ModelViewer now use `_t('common.errorWith', { message })`); zh uses a fullwidth colon
- Wire Deck's Active / Bypass toggle label to the existing `deck.active` / `deck.bypass` keys
- Fill in two missing `settings.searchIndexAutoSync*` strings in `zh.json`; en / ja / zh are now in full parity at 400 keys

### Testing and tooling

- Expand the regression suite from 52 to 105 unittest cases covering security hardening, async-I/O adoption, symlink-safe directory iteration, a11y attributes, focus trap, the toast service, escapeHTML consolidation, parseInt radix coverage, locale parity, and i18n key adoption
- Stop tracking `.claude/` and add it to `.gitignore`; the directory is personal Claude Code tooling (slash commands, worktrees) and not part of the public node surface
- Update `ARCHITECTURE.md`, `CONVENTIONS.md`, and `GADGET_API.md` to document the new boundary rules (image-bytes verification, external-download size cap, URL-scheme allowlist, Markdown link filtering, the `item.info` vs `item.infoHTML` split, async-reboot rule)

## v2.1.6 - 2026-05-12

- Add same-origin guards to all state-changing Drawer HTTP routes to block cross-origin browser requests
- Add explicit pixel-limit check when opening images for thumbnails and metadata to prevent decompression bomb attacks
- Replace full model root paths in `/drawer/models/paths` responses with anonymous source IDs to avoid leaking local directory structure
- Remove unused `/drawer/custom-paths` endpoints and related yaml helpers; remove orphaned Model Viewer settings button
- Expose package version via `/drawer/version` endpoint and `DRAWER_VERSION` module attribute instead of writing `version.js` at startup
- Recover gracefully from a corrupt dict manifest by backing it up and resetting to an empty list
- Pin `Send2Trash>=1.8,<2`; drop `PyYAML` dependency

## v2.1.5 - 2026-05-11

- Harden Gallery thumbnail cache path handling so cache move/remove operations stay within the physical `.thumbs` directory and ignore symlinked cache paths
- Make Gallery thumbnail cache folder merges deterministic by replacing colliding files, recursively merging directories, and avoiding symlink traversal
- Preserve loaded Gallery browse/search pages when returning to a stale Gallery view after queue activity or graph refreshes, without recreating unchanged browse cards
- Show Workflow Overview for API-generated metadata that contains `prompt` node data but no embedded `workflow` graph
- Make the Home storage widget reuse recent summaries and show model storage by model category/top folder instead of mostly-uniform file extensions
- Sync the frontend runtime version from `pyproject.toml` at startup so Home version display follows release bumps
- Reduce Gallery search memory spikes during post-filtered searches by scanning SQLite rows in chunks instead of fetching all candidate rows at once
- Add regression coverage for thumbnail cache symlink hardening, folder cache merge behavior, and post-filtered Gallery search paging/filter cases

## v2.1.4 - 2026-05-10

- Make Gallery thumbnail cache entries follow Drawer file move, rename, and delete operations instead of regenerating or orphaning thumbnails during normal Drawer workflows
- Add visible progress for user-started Gallery index syncs while keeping background auto-sync quiet unless it runs long
- Fix Gallery search paging and load-more behavior so desktop/mobile page sizes remain consistent and all results can be reached
- Make Gallery select-all target all search or folder results while keeping the visible cards paged, with loading feedback for long mobile selections
- Reduce disruptive Gallery redraws by diffing generated files, page loads, and deletions instead of rebuilding the whole grid whenever possible
- Stabilize lightbox metadata layout and keep lightbox/card references aligned after Gallery deletions and incremental loads
- Align Gallery and Model Viewer mobile toolbar sizing and item-count display
- Improve XYZ Plot group/switch ordering and labels, support explicit `__bypass__` switch values, and add inline Prompt S/R selection/editing from the current widget value
- Add regression coverage for thumbnail cache movement/removal, search paging, and hardened path handling

## v2.1.3 - 2026-05-09

- Index successful ComfyUI image uploads into the Gallery search index so LoadImage/LoadImageMask upload paths become searchable without waiting for a later sync
- Read A1111 `parameters` and NovelAI-style `Comment` metadata as raw Gallery metadata, index their prompt/settings fields, show formatted metadata overviews, and delegate opening them to ComfyUI's native image importer
- Add a media context-menu action to resync one file's Gallery search metadata from the actual file contents
- Compact common media context-menu actions into an icon-only footer and align primary action ordering

## v2.1.2 - 2026-05-09

- Restrict Drawer media file-serving and metadata endpoints to supported media filenames instead of serving arbitrary files from allowed roots
- Reject unsupported Gallery thumbnail requests instead of falling back to the original file
- Return 400/413/415 responses for malformed query parameters, JSON bodies, multipart uploads, unsupported file types, and oversized uploads across Drawer routes
- Move heavy model path and storage summary scans off the async request path
- Make Drawer settings writes atomic to avoid corrupting `drawer_settings.json` on interrupted writes
- Add ComfyBridge `fetchApi()` fallback coverage to internal prompt, upload, interrupt, and partial queue calls
- Avoid unnecessary Gallery thumbnail requests for audio cards
- Add regression coverage for media filename allowlists, typed body helpers, multipart hardening, settings atomic writes, thumbnail rejection, and Bridge fetch handling

## v2.1.1 - 2026-05-09

- Fix direct Drawer API calls to respect ComfyUI base paths and API fetch handling
- Fix manual `ComfyBridge.queuePrompt()` payloads and make Drawer startup hooks idempotent
- Fix Model Viewer preview replacement so stale `.preview.*` sidecars do not keep winning over the newly selected image
- Show Model Viewer preview update/delete failures in an error dialog with the returned reason
- Keep Drawer toast messages above dialogs and pickers instead of behind blurred backdrops
- Show an XYZ Plot completion toast and block Deck/model-apply/media-to-node/mask actions while an XYZ sweep is active
- Show completion toasts for user-started Gallery search index builds/syncs, and surface index failures in dialogs
- Show dictionary import size limits inline and report oversized imports instead of failing silently
- Show a graceful video thumbnail placeholder when external `ffmpeg` thumbnail generation is unavailable
- Clarify direct, ComfyUI-provided, and optional system dependencies in the README files
- Document dictionary import limits, XYZ sweep action locks, Model Viewer preview replacement, and Gallery index notifications in the user guides
- Limit the Home changelog preview to the latest three releases
- Add regression tests for path safety, dictionary storage, and thumbnail cache naming
- Reuse recent Gallery search index estimates when starting an index build to avoid an immediate duplicate pre-scan
- Harden user dictionary entry routes, dictionary imports, media metadata parsing, and Gallery thumbnail cache names

## v2.1.0 - 2026-05-08

- Add third-party metadata provider and contributor hooks for Gallery search indexing
- Add custom metadata search syntax with `namespace[value]` and `namespace:key[value]`
- Add third-party metadata panel and dictionary provider hooks for custom metadata display and autocomplete
- Refresh existing Gallery search indexes when provider/contributor registrations change
- Improve Gallery search target popover layout on desktop, portrait mobile, and landscape mobile
- Improve search index creation flow with visible estimation progress and cancellable estimation dialogs
- Harden filesystem and model-preview operations against unsafe paths and oversized uploads
- Split Drawer route internals into focused modules for settings, prompt processing, dictionaries, search, filesystem helpers, and thumbnails

## v2.0.0 - 2026-05-07

- Change the project implementation license to GPL-3.0-or-later, with CC0 public API/specification docs and an MIT gadget template
- Add the full GPLv3 license text in `COPYING` and document split licensing in the README files
- Make Gallery metadata indexing an explicit user-started operation instead of an automatic startup task
- Keep filename search available without a search index, while prompt/workflow/node metadata searches use the SQLite index
- Add Gallery and Settings controls for creating, pausing, resuming, and clearing the search index
- Add index progress UI with live counts, progress bar, elapsed time, coarse ETA, dismissible unindexed notice, and cache-clear reset behavior
- Add search index estimates using extension-aware sampling before large index builds
- Fix Drawer server restart by using an in-place process replacement flow and update restart confirmation text
- Add Settings action state refresh for long-running or state-dependent actions

## v1.0.8 - 2026-05-06

- Rework Gallery search with filename, prompt, workflow, node type-scoped, and node title-scoped queries
- Add quoted phrase, AND, and NOT search handling for Gallery metadata searches
- Add node type autocomplete and enable user/Danbooru dictionary suggestions in Gallery search
- Add Gallery search filters for date range, file size, and search target with one-click clear
- Move Gallery search controls into a two-row mobile-friendly toolbar layout
- Show Gallery search index preparation status while metadata search is becoming available

## v1.0.7 - 2026-05-06

- Add Home dashboard widgets and a Storage overview for Output, Input, and Models
- Add a Home widget public API for gadget-provided dashboard panels
- Extend Gallery filesystem events for move, rename, delete, and create operations
- Make Gallery file rename preserve the original media extension
- Move updated Deck lightbox items to the end of the navigation order
- Prevent native context menus on Settings color swatches

## v1.0.6 - 2026-05-06

- Improve metadata workflow values with label/value formatting and node definition fallbacks
- Add a metadata view toggle for hiding value labels

## v1.0.5 - 2026-05-05

- Keep Deck lightbox navigation unified after partial output updates
- Add a metadata viewer with workflow node summaries and selectable raw JSON
- Prune stale Drawer workflow state from exported workflow metadata
- Preserve intentional example workflow Drawer state while pruning stale exported metadata

## v1.0.4 - 2026-05-05

- Extend XYZ Plot bypass axes to Deck group toggles, group switches, and node switches
- Share Deck marker parsing with XYZ Plot for consistent group and switch handling

## v1.0.3 - 2026-05-04

- Updated release screenshots and Registry icon asset
- Hardened Home rendering and localized the System section
- Added shared widget target handling for DrawerControls, Model Viewer, Mask Editor, and image send-to actions
- Added CivitAI `.com` fallback when `.red` does not return model metadata

## v1.0.2 - 2026-05-04

- Sync Drawer runtime version and Home changelog display

## v1.0.1 - 2026-05-04

- Home hint polish

## v1.0.0 - 2026-05-04

- Initial release
