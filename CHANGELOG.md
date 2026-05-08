# Changelog

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
