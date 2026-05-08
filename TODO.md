# Development Notes

Internal notes for future maintenance. Do not copy this file to the public clean
repository unless the contents are intentionally turned into user-facing roadmap
items.

## Pending

- v1.0.4 target
  - Verify XYZ Plot Deck bypass axes on real workflows:
    group toggles, group switches, and node switches.
  - Update runtime/package version and GitHub/Registry release notes after visual
    confirmation.

- Keep version metadata in sync
  - Runtime version now lives in `web/js/version.js`.
  - Public releases must also update clean repo `pyproject.toml`, `CHANGELOG.md`,
    GitHub releases, and Registry publishes.
  - Consider adding a release script later so these cannot drift.

- Improve Registry and GitHub icon
  - Prefer the compact drawer/A mark for square icons.
  - Use the horizontal `DRAWER` logo only for README or banner-style surfaces.

- Widget target abstraction follow-up
  - `web/js/utils/widget-targets.js` now normalizes regular widgets and
    connected DrawerControls for ModelViewer, MaskEditor, and media Send-to.
  - Next broad widget-target work should reuse that utility instead of scanning
    `node.widgets` directly.

- Add a release checklist for internal use
  - Confirm runtime version display in Home.
  - Confirm `CHANGELOG.md` is visible in Home.
  - Confirm Registry publish result and Manager search display.
