"""Build a headless prompt-builder fixture from a real-frontend capture.

A fixture pairs a saved workflow with the API prompts the ComfyUI frontend
produced for it (one per node-mode variant), plus the subset of /object_info
the workflow needs. tests/js/headless_golden.mjs replays each variant through
web/js/headless and requires an identical prompt.

Capture (in a ComfyUI browser tab; see tests/fixtures/headless/README.md):
    user/default/drawer-golden/<name>.json = {source, frontendVersion, variants}

Usage:
    python tests/tools/build_headless_fixture.py CAPTURE WORKFLOW OBJECT_INFO OUT
"""

import json
import sys
from pathlib import Path


def _types_in(workflow):
    nodes = list(workflow.get("nodes", []))
    for sg in (workflow.get("definitions") or {}).get("subgraphs") or []:
        nodes.extend(sg.get("nodes", []))
    return {n.get("type") for n in nodes}


def build(capture_path, workflow_path, object_info_path, out_path):
    capture = json.loads(Path(capture_path).read_text(encoding="utf-8"))
    workflow = json.loads(Path(workflow_path).read_text(encoding="utf-8"))
    object_info = json.loads(Path(object_info_path).read_text(encoding="utf-8"))
    used = sorted(t for t in _types_in(workflow) if t in object_info)
    fixture = {
        "source": capture.get("source"),
        "frontendVersion": capture.get("frontendVersion"),
        "workflow": workflow,
        "objectInfo": {t: object_info[t] for t in used},
        "variants": capture["variants"],
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
    return fixture


if __name__ == "__main__":
    if len(sys.argv) != 5:
        print(__doc__)
        sys.exit(2)
    build(*sys.argv[1:])
