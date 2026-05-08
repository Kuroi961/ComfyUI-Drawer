"""Prompt text processing for ComfyUI-Drawer.

Handles comment stripping and wildcard expansion for ComfyUI prompt payloads,
while preserving resolved prompt text in workflow metadata.
"""

import logging
import random
import re

from aiohttp import web
import server

from .settings import get_drawer_setting, set_drawer_setting

logger = logging.getLogger("ComfyUI-Drawer")

_COMMENTS_SETTING_KEY = "prompt.commentsEnabled"
_comments_enabled = bool(get_drawer_setting(_COMMENTS_SETTING_KEY, True))
_read_manifest = None
_read_wildcard_entries = None

# Combined regex: comments OR wildcards.
# Alternation order is critical: comments match first, consuming any wildcards
# they contain, so __name__ inside /* */ or // never reaches the wildcard branch.
_PROMPT_PROC = re.compile(
    r'/\*.*?\*/'
    r'|(?:(?<=\s)|(?<=,)|(?:^))//[^\n]*'
    r'|^[ \t]*#[^\n]*'
    r'|__([^_]+(?:_[^_]+)*)__',
    re.DOTALL | re.MULTILINE,
)

# Comment-only regex (no wildcard matching) for second-pass stripping.
# Used to strip comments that were introduced by wildcard expansion.
_COMMENT_ONLY = re.compile(
    r'/\*.*?\*/'
    r'|(?:(?<=\s)|(?<=,)|(?:^))//[^\n]*'
    r'|^[ \t]*#[^\n]*',
    re.DOTALL | re.MULTILINE,
)


def setup_prompt_processing(routes, read_manifest, read_wildcard_entries):
    """Register prompt processing routes and the ComfyUI on_prompt hook."""
    global _read_manifest, _read_wildcard_entries
    _read_manifest = read_manifest
    _read_wildcard_entries = read_wildcard_entries

    routes.get("/drawer/settings/comments-enabled")(get_comments_enabled)
    routes.put("/drawer/settings/comments-enabled")(set_comments_enabled)
    routes.get("/drawer/settings/wildcard-names")(get_wildcard_names)
    server.PromptServer.instance.add_on_prompt_handler(expand_wildcards)


async def get_comments_enabled(request):
    return web.json_response({"enabled": _comments_enabled})


async def set_comments_enabled(request):
    global _comments_enabled
    data = await request.json()
    _comments_enabled = bool(data.get("enabled", True))
    set_drawer_setting(_COMMENTS_SETTING_KEY, _comments_enabled)
    return web.json_response({"enabled": _comments_enabled})


async def get_wildcard_names(request):
    """Return list of valid wildcard names (enabled wildcards from manifest)."""
    manifest = _read_manifest()
    names = [
        d["title"] for d in manifest
        if d.get("type") == "wildcard" and d.get("enabled", True)
    ]
    return web.json_response({"names": names})


def _needs_processing(text, comments_on=True):
    """Quick pre-filter: might this text contain comments or wildcards?"""
    if comments_on:
        return '/*' in text or '//' in text or '#' in text or '__' in text
    return '__' in text


def _find_prompt_seed(prompt):
    """Find a deterministic seed value from prompt nodes."""
    for node_id in sorted(prompt.keys(), key=lambda x: int(x) if x.isdigit() else float('inf')):
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in ("seed", "noise_seed", "seed_value"):
            val = inputs.get(key)
            if isinstance(val, (int, float)):
                ival = int(val)
                if ival == val:
                    return ival
    return None


def _process_prompt_text(text, rng, wc_map, keep_comments):
    """Process a single text value: handle comments and expand wildcards."""
    esc_hash = '\uf8e0'
    esc_slash = '\uf8e1'
    text = text.replace('\\#', esc_hash).replace('\\/', esc_slash)

    has_wildcards = False

    if keep_comments:
        def meta_replacer(m):
            nonlocal has_wildcards
            if m.group(1) is None:
                return m.group(0)
            name = m.group(1)
            if name not in wc_map:
                return m.group(0)
            has_wildcards = True
            return rng.choice(wc_map[name])
        result = _PROMPT_PROC.sub(meta_replacer, text)
    else:
        def replacer(m):
            nonlocal has_wildcards
            if m.group(1) is None:
                return ''
            name = m.group(1)
            if name not in wc_map:
                return m.group(0)
            has_wildcards = True
            return rng.choice(wc_map[name])

        result = _PROMPT_PROC.sub(replacer, text)
        if has_wildcards:
            result = _COMMENT_ONLY.sub('', result)

    if keep_comments:
        result = result.replace(esc_hash, '\\#').replace(esc_slash, '\\/')
    else:
        result = result.replace(esc_hash, '#').replace(esc_slash, '/')

    return result


def expand_wildcards(json_data):
    """on_prompt handler: process comments and wildcards in prompt text."""
    prompt = json_data.get("prompt")
    if not prompt or not isinstance(prompt, dict):
        return json_data

    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "DrawerSeed":
            inputs = node.get("inputs")
            if isinstance(inputs, dict):
                inputs.pop("mode", None)

    manifest = _read_manifest()
    wc_map = {}
    for d in manifest:
        if d.get("type") == "wildcard" and d.get("enabled", True):
            raw = _read_wildcard_entries(d["id"])
            entries = [e for e in raw if not e.startswith('#') and not e.startswith('//')]
            if entries:
                wc_map[d["title"]] = entries

    wf_seed = _find_prompt_seed(prompt)
    rng_prompt = random.Random(wf_seed)
    rng_meta = random.Random(wf_seed)

    meta_log = {}
    prompt_changed = False

    for node_id in sorted(prompt.keys(), key=lambda x: int(x) if x.isdigit() else float('inf')):
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in sorted(inputs.keys()):
            value = inputs[key]
            if not isinstance(value, str) or not _needs_processing(value, _comments_enabled):
                continue

            exec_text = _process_prompt_text(
                value,
                rng_prompt,
                wc_map,
                keep_comments=not _comments_enabled,
            )
            meta_text = _process_prompt_text(value, rng_meta, wc_map, keep_comments=True)

            if exec_text != value:
                inputs[key] = exec_text
                prompt_changed = True
            if meta_text != value:
                node_log = meta_log.setdefault(node_id, {"inputs": {}, "values": {}})
                node_log["inputs"][key] = meta_text
                node_log["values"][value] = meta_text

    if not prompt_changed and not meta_log:
        return json_data

    if meta_log:
        _apply_expansion_to_workflow(json_data, meta_log)

    logger.info("[Prompt] Processed comments/wildcards (seed=%s)", wf_seed)
    return json_data


def _apply_expansion_to_workflow(json_data, expansion_log):
    """Copy processed text into custom_data.workflow for output metadata."""
    custom = json_data.get("custom_data")
    if not custom or not isinstance(custom, dict):
        return

    pnginfo = custom.get("custom_pnginfo")
    if isinstance(pnginfo, dict):
        workflow = pnginfo.get("workflow")
    else:
        workflow = custom.get("workflow")

    if not workflow or not isinstance(workflow, dict):
        return
    nodes = workflow.get("nodes")
    if not nodes or not isinstance(nodes, list):
        return

    for wf_node in nodes:
        if not isinstance(wf_node, dict):
            continue
        node_id_str = str(wf_node.get("id", ""))
        log = expansion_log.get(node_id_str)
        if not log:
            continue
        input_log = log.get("inputs", {}) if isinstance(log, dict) else {}
        value_log = log.get("values", log) if isinstance(log, dict) else log
        widgets = wf_node.get("widgets_values")
        if isinstance(widgets, list):
            for i, val in enumerate(widgets):
                if isinstance(val, str) and val in value_log:
                    widgets[i] = value_log[val]
        elif isinstance(widgets, dict):
            for key, val in widgets.items():
                if key in input_log:
                    widgets[key] = input_log[key]
                elif isinstance(val, str) and val in value_log:
                    widgets[key] = value_log[val]
