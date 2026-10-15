# Headless prompt-builder fixtures

Each file pairs a saved workflow with the API prompts the real ComfyUI
frontend produced for it, for four node-mode variants (as saved, everything
active, two seeded bypass/mute mixes), plus the `/object_info` subset the
workflow uses. `tests/js/headless_golden.mjs` replays every variant through
`web/js/headless` and requires the identical prompt, and requires an untouched
workflow to serialize back byte-identical.

Current fixtures were captured with ComfyUI 0.40.0 / frontend 1.55.17 from
`example_workflows/`.

## Regenerating

1. Copy the workflows into `user/default/workflows/_golden_src/`.
2. Open ComfyUI, paste `tests/tools/capture_headless_golden.js` into the
   devtools console. Captures land in `user/default/drawer-golden/`.
3. Save `/api/object_info` to a file and build each fixture:

```
python tests/tools/build_headless_fixture.py CAPTURE WORKFLOW OBJECT_INFO tests/fixtures/headless/NAME.json
```

`filename_prefix` values are compared with digits masked, since `%date:…%`
expands to the capture time.
