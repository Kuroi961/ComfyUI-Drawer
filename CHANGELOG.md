# Changelog

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
