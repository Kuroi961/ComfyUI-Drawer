"""Run progress for every client.

ComfyUI sends per-prompt execution events (executing, progress, ...) only to
the client that queued the prompt. Drawer's progress indicator also follows
runs queued elsewhere (another browser tab, a phone watching a PC run, API
scripts), so a compact copy of those events is broadcast as `drawer.progress`.
Only ids, step counts and an error summary are relayed — no previews, inputs
or tracebacks.
"""

import json
import os

RELAYED_FIELDS = {
    "execution_start": ("prompt_id",),
    "execution_cached": ("prompt_id", "nodes"),
    "executing": ("prompt_id", "node", "display_node"),
    "progress": ("prompt_id", "node", "value", "max"),
    "execution_success": ("prompt_id",),
    "execution_interrupted": ("prompt_id", "node_id"),
    "execution_error": ("prompt_id", "node_id", "node_type", "exception_type", "exception_message"),
}


def install(prompt_server):
    """Wrap PromptServer.send_sync to broadcast a relay copy (idempotent)."""
    original = prompt_server.send_sync
    if getattr(original, "_drawer_progress_relay", False):
        return

    def send_sync(event, data, sid=None):
        original(event, data, sid)
        fields = RELAYED_FIELDS.get(event)
        # sid None is already a broadcast.
        if sid is None or fields is None or not isinstance(data, dict):
            return
        relay = {key: data[key] for key in fields if key in data}
        workflow_id = (getattr(prompt_server, "workflow_metadata", None) or {}).get("workflow_id")
        if workflow_id:
            relay["workflow_id"] = workflow_id
        original("drawer.progress", {"event": event, **relay}, None)

    send_sync._drawer_progress_relay = True
    prompt_server.send_sync = send_sync


_names_cache = {}


def workflow_names(workflows_dir):
    """Map the `id` stored in each saved workflow to its path under workflows/.

    Run records only carry the workflow id; this lets the indicator show the
    file name. Files are re-read only when their mtime changes.
    """
    names = {}
    if not workflows_dir or not os.path.isdir(workflows_dir):
        return names
    for root, dirs, files in os.walk(workflows_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(root, d))]
        for file in files:
            if not file.endswith(".json") or file.startswith("."):
                continue
            full = os.path.join(root, file)
            try:
                mtime = os.path.getmtime(full)
                cached = _names_cache.get(full)
                if cached is None or cached[0] != mtime:
                    with open(full, "r", encoding="utf-8") as f:
                        workflow_id = json.load(f).get("id")
                    cached = (mtime, workflow_id if isinstance(workflow_id, str) else None)
                    _names_cache[full] = cached
            except (OSError, ValueError, AttributeError):
                continue
            if cached[1]:
                names[cached[1]] = os.path.relpath(full, workflows_dir).replace(os.sep, "/")
    return names
