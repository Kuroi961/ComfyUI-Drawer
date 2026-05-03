"""HTTP routes and prompt hooks for ComfyUI-Drawer."""

import os
import sys
import csv
import io
import datetime
import json
import logging
import sqlite3
import struct
import threading
import zlib

try:
    from send2trash import send2trash as _send2trash
except ImportError:
    _send2trash = None

from aiohttp import web
import server
import folder_paths

logger = logging.getLogger("ComfyUI-Drawer")

_routes = server.PromptServer.instance.routes


@_routes.get("/drawer/changelog")
async def get_changelog(request):
    """Serve the project changelog used by the Home gadget."""
    changelog_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "CHANGELOG.md")
    try:
        with open(changelog_path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return web.Response(text="", status=404)
    return web.Response(
        text=text,
        content_type="text/markdown",
        charset="utf-8",
        headers={"Cache-Control": "no-cache"},
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Tag Autocomplete — Merged CSV endpoint
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_merged_csv_cache = None
_merged_csv_mtime = 0  # track source file mtimes for cache invalidation


def _get_csv_source_paths():
    """Return (primary, secondary) resolved paths for tag CSV sources."""
    this_dir = os.path.dirname(os.path.abspath(__file__))
    custom_nodes_dir = os.path.dirname(this_dir)

    primary_paths = [
        os.path.join(this_dir, "data", "danbooru_tags.csv"),
        os.path.join(custom_nodes_dir, "comfyui-autocomplete-plus-custom", "data", "danbooru_tags.csv"),
        os.path.join(custom_nodes_dir, "comfyui-autocomplete-plus", "data", "danbooru_tags.csv"),
    ]
    secondary_paths = [
        os.path.join(custom_nodes_dir, "comfyui-lora-manager", "refs", "danbooru_e621_merged.csv"),
    ]

    primary = next((p for p in primary_paths if os.path.exists(p)), None)
    secondary = next((p for p in secondary_paths if os.path.exists(p)), None)
    return primary, secondary


def _get_csv_max_mtime():
    """Return the newest mtime among CSV source files (0 if none exist)."""
    primary, secondary = _get_csv_source_paths()
    mtimes = []
    for p in (primary, secondary):
        if p:
            try:
                mtimes.append(os.path.getmtime(p))
            except OSError:
                pass
    return max(mtimes) if mtimes else 0


def _merge_tag_csvs() -> str | None:
    """Merge multiple Danbooru tag CSV sources into a single sorted CSV.

    Priority order (first found is used as primary, rest are merged in):
      1. Drawer bundled CSV  — data/danbooru_tags.csv (danbooru2025 metadata, JP aliases)
      2. comfyui-autocomplete-plus-custom  — rich JP aliases, ~32K tags
      3. comfyui-autocomplete-plus         — fallback
    Secondary source (appended if present):
      - comfyui-lora-manager               — ~220K tags, few aliases

    Primary is used as base (for alias data), then unique tags from
    secondary are appended.  Result is sorted by count descending.
    """
    primary, secondary = _get_csv_source_paths()

    if not primary and not secondary:
        return None

    # If only one source exists, serve it directly
    if not primary:
        with open(secondary, "r", encoding="utf-8") as f:
            return f.read()
    if not secondary:
        with open(primary, "r", encoding="utf-8") as f:
            return f.read()

    # Merge: primary tags (with JP aliases) → append unique tags from secondary
    tags = {}  # tag_name -> (category, count, aliases_str)

    with open(primary, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        for row in reader:
            if len(row) >= 3:
                tag = row[0].strip()
                cat = row[1].strip()
                count = row[2].strip()
                alias = row[3].strip() if len(row) >= 4 else ""
                if tag:
                    tags[tag] = (cat, count, alias)

    with open(secondary, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        first_line = next(reader, None)
        if first_line and first_line[0].lower() != "tag":
            # First line is data, not header
            if len(first_line) >= 3:
                tag = first_line[0].strip()
                if tag and tag not in tags:
                    cat = first_line[1].strip()
                    count = first_line[2].strip()
                    alias = first_line[3].strip() if len(first_line) >= 4 else ""
                    tags[tag] = (cat, count, alias)
        for row in reader:
            if len(row) >= 3:
                tag = row[0].strip()
                if tag and tag not in tags:
                    cat = row[1].strip()
                    count = row[2].strip()
                    alias = row[3].strip() if len(row) >= 4 else ""
                    tags[tag] = (cat, count, alias)

    # Build CSV sorted by count descending
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["tag", "category", "count", "alias"])
    sorted_tags = sorted(
        tags.items(),
        key=lambda x: int(x[1][1]) if x[1][1].isdigit() else 0,
        reverse=True,
    )
    for tag, (cat, count, alias) in sorted_tags:
        writer.writerow([tag, cat, count, alias])
    return buf.getvalue()


@_routes.get("/drawer/tags")
async def get_tags(request):
    """Serve merged Danbooru tag CSV for TagComplete service.

    Cache invalidation: tracks source CSV file mtimes so the in-memory
    cache is automatically refreshed when any CSV file changes on disk
    (e.g. after running build_tag_dictionary.py).
    """
    global _merged_csv_cache, _merged_csv_mtime

    current_mtime = _get_csv_max_mtime()
    if _merged_csv_cache is None or current_mtime > _merged_csv_mtime:
        _merged_csv_cache = _merge_tag_csvs()
        _merged_csv_mtime = current_mtime
        logger.info("[Tags] CSV cache refreshed (mtime changed)")

    if not _merged_csv_cache:
        return web.Response(text="", status=404)
    return web.Response(
        text=_merged_csv_cache,
        content_type="text/csv",
        charset="utf-8",
        headers={"Cache-Control": "no-cache"},
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Model Paths — per-category models grouped by source directory
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@_routes.get("/drawer/models/paths/{category}")
async def get_model_paths(request):
    """Return models grouped by their source base path for a given category.

    Response: [
        { "path": "C:/ComfyUI/models/loras", "models": ["model1.safetensors", ...] },
        { "path": "G:/ComfyHub2/models/loras", "models": ["SDXL/model2.safetensors", ...] },
    ]
    """
    category = request.match_info["category"]
    category = folder_paths.map_legacy(category)

    if category not in folder_paths.folder_names_and_paths:
        return web.json_response([], status=200)

    paths_and_exts = folder_paths.folder_names_and_paths[category]
    base_paths = paths_and_exts[0]
    extensions = paths_and_exts[1]

    result = []
    for base_path in base_paths:
        norm_path = base_path.replace("\\", "/")
        if not os.path.isdir(base_path):
            continue
        files, _dirs = folder_paths.recursive_search(base_path, excluded_dir_names=[".git"])
        filtered = folder_paths.filter_files_extensions(files, extensions)
        result.append({
            "path": norm_path,
            "models": [f.replace("\\", "/") for f in filtered],
        })

    return web.json_response(result)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  User Dictionaries — Multi-dictionary system (dict + wildcard)
#  Storage: ComfyUI/user/drawer_dicts/
#    manifest.json   — [{id, title, enabled, type}, ...]
#    {id}.csv        — tag,insert_text rows  (type="dict")
#    {id}.txt        — one entry per line     (type="wildcard")
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import uuid as _uuid

def _dicts_dir() -> str:
    return os.path.join(folder_paths.get_user_directory(), "drawer_dicts")

def _manifest_path() -> str:
    return os.path.join(_dicts_dir(), "manifest.json")

def _dict_file_path(dict_id: str, dtype: str = "dict") -> str:
    """Return file path for a dictionary. CSV for dict, TXT for wildcard."""
    safe_id = dict_id.replace("/", "").replace("\\", "").replace("..", "")
    ext = ".txt" if dtype == "wildcard" else ".csv"
    return os.path.join(_dicts_dir(), f"{safe_id}{ext}")

def _get_dict_type(dict_id: str) -> str:
    """Look up the type of a dictionary from the manifest."""
    manifest = _read_manifest()
    for d in manifest:
        if d["id"] == dict_id:
            return d.get("type", "dict")
    return "dict"


def _read_manifest() -> list[dict]:
    """Read manifest.json. Auto-migrates old user_dict.csv if present."""
    ddir = _dicts_dir()
    mpath = _manifest_path()
    os.makedirs(ddir, exist_ok=True)

    if os.path.exists(mpath):
        with open(mpath, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        # Ensure backward compat: add type if missing
        for d in manifest:
            if "type" not in d:
                d["type"] = "dict"
        return manifest

    # ── Auto-migrate legacy user_dict.csv ──
    legacy = os.path.join(folder_paths.get_user_directory(), "user_dict.csv")
    manifest = []
    if os.path.exists(legacy):
        new_id = str(_uuid.uuid4())[:8]
        import shutil
        shutil.copy2(legacy, _dict_file_path(new_id, "dict"))
        manifest.append({"id": new_id, "title": "ユーザー辞書", "enabled": True, "type": "dict"})
        _write_manifest(manifest)
        logger.info(f"[UserDict] Migrated legacy user_dict.csv → {new_id}.csv")
    else:
        _write_manifest(manifest)

    return manifest


def _write_manifest(manifest: list[dict]) -> None:
    os.makedirs(_dicts_dir(), exist_ok=True)
    with open(_manifest_path(), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def _read_dict_entries(dict_id: str) -> list[dict]:
    path = _dict_file_path(dict_id, "dict")
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            entries.append({
                "tag": row.get("tag", "").strip(),
                "insert_text": row.get("insert_text", "").strip(),
            })
    return [e for e in entries if e["tag"]]


def _write_dict_entries(dict_id: str, entries: list[dict]) -> None:
    path = _dict_file_path(dict_id, "dict")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["tag", "insert_text"])
        writer.writeheader()
        for e in entries:
            if e.get("tag", "").strip():
                writer.writerow({
                    "tag": e["tag"].strip(),
                    "insert_text": e.get("insert_text", "").strip(),
                })


# ── Wildcard (TXT) read/write ──

def _read_wildcard_entries(dict_id: str) -> list[str]:
    path = _dict_file_path(dict_id, "wildcard")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def _write_wildcard_entries(dict_id: str, entries: list[str]) -> None:
    path = _dict_file_path(dict_id, "wildcard")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            stripped = entry.strip()
            if stripped:
                f.write(stripped + "\n")


# ── Unified entry count ──

def _count_entries(d: dict) -> int:
    dtype = d.get("type", "dict")
    if dtype == "wildcard":
        return len(_read_wildcard_entries(d["id"]))
    return len(_read_dict_entries(d["id"]))


# ── Dictionary Management Endpoints ──

@_routes.get("/drawer/user-dicts")
async def list_user_dicts(request):
    """List all user dictionaries with entry counts."""
    manifest = _read_manifest()
    result = []
    for d in manifest:
        result.append({**d, "count": _count_entries(d)})
    return web.json_response(result)


@_routes.post("/drawer/user-dicts")
async def create_user_dict(request):
    """Create a new user dictionary.
    Body: { "title": "辞書名", "type": "dict"|"wildcard" }
    """
    data = await request.json()
    title = data.get("title", "新しい辞書").strip() or "新しい辞書"
    dtype = data.get("type", "dict")
    if dtype not in ("dict", "wildcard"):
        dtype = "dict"
    new_id = str(_uuid.uuid4())[:8]

    manifest = _read_manifest()
    manifest.append({"id": new_id, "title": title, "enabled": True, "type": dtype})
    _write_manifest(manifest)

    if dtype == "wildcard":
        _write_wildcard_entries(new_id, [])
    else:
        _write_dict_entries(new_id, [])

    return web.json_response({"ok": True, "id": new_id, "title": title, "type": dtype})


@_routes.patch("/drawer/user-dicts/{dict_id}")
async def update_user_dict_meta(request):
    """Update dictionary metadata (title, enabled).
    Body: { "title": "...", "enabled": true/false }
    """
    dict_id = request.match_info["dict_id"]
    data = await request.json()

    manifest = _read_manifest()
    for d in manifest:
        if d["id"] == dict_id:
            if "title" in data:
                d["title"] = data["title"].strip()
            if "enabled" in data:
                d["enabled"] = bool(data["enabled"])
            _write_manifest(manifest)
            return web.json_response({"ok": True, **d})

    return web.json_response({"error": "not found"}, status=404)


@_routes.delete("/drawer/user-dicts/{dict_id}")
async def delete_user_dict_full(request):
    """Delete an entire user dictionary (manifest entry + file)."""
    dict_id = request.match_info["dict_id"]

    manifest = _read_manifest()
    target = None
    for d in manifest:
        if d["id"] == dict_id:
            target = d
            break
    if not target:
        return web.json_response({"error": "not found"}, status=404)

    dtype = target.get("type", "dict")
    new_manifest = [d for d in manifest if d["id"] != dict_id]
    _write_manifest(new_manifest)

    fpath = _dict_file_path(dict_id, dtype)
    if os.path.exists(fpath):
        os.remove(fpath)

    return web.json_response({"ok": True})


# ── Entry CRUD Endpoints (per-dictionary, type-aware) ──

@_routes.get("/drawer/user-dict/{dict_id}")
async def get_user_dict_entries(request):
    """Return entries for a specific user dictionary."""
    dict_id = request.match_info["dict_id"]
    dtype = _get_dict_type(dict_id)
    if dtype == "wildcard":
        entries = _read_wildcard_entries(dict_id)
        return web.json_response([{"text": e} for e in entries])
    else:
        entries = _read_dict_entries(dict_id)
        return web.json_response(entries)


@_routes.post("/drawer/user-dict/{dict_id}")
async def post_user_dict_entries(request):
    """Add/update entries in a specific user dictionary."""
    dict_id = request.match_info["dict_id"]
    data = await request.json()
    dtype = _get_dict_type(dict_id)

    if dtype == "wildcard":
        if "entries" in data:
            new_texts = [e.get("text", "").strip() for e in data["entries"]]
        else:
            new_texts = [data.get("text", "").strip()]
        new_texts = [t for t in new_texts if t]
        existing = _read_wildcard_entries(dict_id)
        existing_set = set(existing)
        for t in new_texts:
            if t not in existing_set:
                existing.append(t)
                existing_set.add(t)
        _write_wildcard_entries(dict_id, existing)
        return web.json_response({"ok": True, "count": len(existing)})
    else:
        if "entries" in data:
            new_entries = data["entries"]
        else:
            new_entries = [data]
        existing = _read_dict_entries(dict_id)
        existing_map = {e["tag"]: e for e in existing}
        for entry in new_entries:
            tag = entry.get("tag", "").strip()
            if not tag:
                continue
            existing_map[tag] = {
                "tag": tag,
                "insert_text": entry.get("insert_text", "").strip(),
            }
        _write_dict_entries(dict_id, list(existing_map.values()))
        return web.json_response({"ok": True, "count": len(existing_map)})


@_routes.delete("/drawer/user-dict/{dict_id}")
async def delete_user_dict_entries(request):
    """Delete entries from a specific user dictionary."""
    dict_id = request.match_info["dict_id"]
    data = await request.json()
    dtype = _get_dict_type(dict_id)

    if dtype == "wildcard":
        texts_to_remove = set(data.get("texts", []))
        existing = _read_wildcard_entries(dict_id)
        remaining = [e for e in existing if e not in texts_to_remove]
        _write_wildcard_entries(dict_id, remaining)
        removed = len(existing) - len(remaining)
        return web.json_response({"ok": True, "removed": removed, "remaining": len(remaining)})
    else:
        tags_to_remove = set(data.get("tags", []))
        existing = _read_dict_entries(dict_id)
        remaining = [e for e in existing if e["tag"] not in tags_to_remove]
        _write_dict_entries(dict_id, remaining)
        removed = len(existing) - len(remaining)
        return web.json_response({"ok": True, "removed": removed, "remaining": len(remaining)})


# ── Import Endpoint ──

@_routes.post("/drawer/user-dicts/import")
async def import_user_dict(request):
    """Import a dictionary from file upload.
    multipart/form-data with fields:
      - file: the uploaded file (.csv or .txt)
      - title: optional display name (defaults to filename)
      - type: optional "dict"|"wildcard" (auto-detected from extension)
    """
    reader = await request.multipart()
    title = None
    dtype = None
    file_data = None
    filename = None

    async for part in reader:
        if part.name == "title":
            title = (await part.text()).strip()
        elif part.name == "type":
            dtype = (await part.text()).strip()
        elif part.name == "file":
            filename = part.filename or "import"
            file_data = await part.read(decode=True)

    if file_data is None:
        return web.json_response({"error": "no file uploaded"}, status=400)

    ext = os.path.splitext(filename)[1].lower() if filename else ""
    if dtype not in ("dict", "wildcard"):
        dtype = "wildcard" if ext == ".txt" else "dict"

    if not title:
        title = os.path.splitext(filename)[0] if filename else "インポート"

    new_id = str(_uuid.uuid4())[:8]
    text = file_data.decode("utf-8", errors="replace")

    if dtype == "wildcard":
        entries = [line.strip() for line in text.splitlines() if line.strip()]
        _write_wildcard_entries(new_id, entries)
        count = len(entries)
    else:
        import io
        rd = csv.DictReader(io.StringIO(text))
        entries = []
        for row in rd:
            tag = row.get("tag", "").strip()
            if tag:
                entries.append({
                    "tag": tag,
                    "insert_text": row.get("insert_text", "").strip(),
                })
        _write_dict_entries(new_id, entries)
        count = len(entries)

    manifest = _read_manifest()
    manifest.append({"id": new_id, "title": title, "enabled": True, "type": dtype})
    _write_manifest(manifest)

    return web.json_response({"ok": True, "id": new_id, "title": title, "type": dtype, "count": count})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Prompt Text Processing — on_prompt hook
#  Two features, transparently applied to any node's text inputs:
#
#  1. Comment stripping:  /* block */  // line  # line (at start of line)
#     Stripped from the executed prompt, but PRESERVED in workflow metadata
#     so output images record what was commented out.
#     Can be enabled/disabled via settings API.
#
#  2. Wildcard expansion:  __name__ → random entry from wildcard dictionary
#     Deterministic via workflow seed.  Expanded in BOTH prompt and metadata.
#
#  Both are handled in a single regex pass — wildcards inside comments are
#  automatically skipped because the comment alternation consumes them first.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import random as _random
import re as _re

# -- Comment processing toggle (runtime setting) --
_comments_enabled = True

@_routes.get("/drawer/settings/comments-enabled")
async def get_comments_enabled(request):
    return web.json_response({"enabled": _comments_enabled})

@_routes.put("/drawer/settings/comments-enabled")
async def set_comments_enabled(request):
    global _comments_enabled
    data = await request.json()
    _comments_enabled = bool(data.get("enabled", True))
    return web.json_response({"enabled": _comments_enabled})

@_routes.get("/drawer/settings/wildcard-names")
async def get_wildcard_names(request):
    """Return list of valid wildcard names (enabled wildcards from manifest)."""
    manifest = _read_manifest()
    names = [d["title"] for d in manifest
             if d.get("type") == "wildcard" and d.get("enabled", True)]
    return web.json_response({"names": names})

# Combined regex: comments OR wildcards.
# Alternation order is critical: comments match first, consuming any wildcards
# they contain, so __name__ inside /* */ or // never reaches the wildcard branch.
_PROMPT_PROC = _re.compile(
    r'/\*.*?\*/'                 # /* block comment */
    r'|(?:(?<=\s)|(?<=,)|(?:^))//[^\n]*'  # // line comment (after whitespace/comma/BOL)
    r'|^[ \t]*#[^\n]*'          # # line comment (start of line only)
    r'|__([^_]+(?:_[^_]+)*)__'  # __wildcard__
    , _re.DOTALL | _re.MULTILINE
)

# Wildcard-only regex — used when comments are disabled.
_WILDCARD_ONLY = _re.compile(
    r'__([^_]+(?:_[^_]+)*)__'
    , _re.DOTALL | _re.MULTILINE
)

# Comment-only regex (no wildcard matching) for second-pass stripping.
# Used to strip comments that were introduced by wildcard expansion.
_COMMENT_ONLY = _re.compile(
    r'/\*.*?\*/'                 # /* block comment */
    r'|(?:(?<=\s)|(?<=,)|(?:^))//[^\n]*'  # // line comment
    r'|^[ \t]*#[^\n]*'          # # line comment
    , _re.DOTALL | _re.MULTILINE
)

def _needs_processing(text, comments_on=True):
    """Quick pre-filter: might this text contain comments or wildcards?"""
    if comments_on:
        return '/*' in text or '//' in text or '#' in text or '__' in text
    return '__' in text


def _find_prompt_seed(prompt):
    """Find a seed value from prompt nodes for deterministic wildcard expansion.

    Searches all nodes sorted by node_id for 'seed' or 'noise_seed' inputs.
    Returns the first integer seed found, or None.
    """
    for node_id in sorted(prompt.keys(),
                          key=lambda x: int(x) if x.isdigit() else float('inf')):
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
                if ival == val:            # reject NaN, fractional
                    return ival
    return None


def _process_prompt_text(text, rng, wc_map, keep_comments):
    """Process a single text value: handle comments and expand wildcards.

    Two-pass processing:
      Pass 1: Comments + wildcards in one regex.  Wildcards inside comments
              are automatically skipped (comment alternation consumes them first).
      Pass 2: Strip any comments introduced by wildcard expansion.

    Escaped comment markers (\\# \\/) are preserved as literal characters.

    Args:
        text:          Input text
        rng:           Random instance (deterministic via seed)
        wc_map:        {title: [entries...]} for wildcard expansion
        keep_comments: True → preserve comments.  False → strip them.
    """
    # ── Protect escaped comment markers ──
    # Use Unicode PUA placeholders that won't appear in normal text.
    _ESC_HASH  = '\uf8e0'   # placeholder for \#
    _ESC_SLASH = '\uf8e1'   # placeholder for \/
    text = text.replace('\\#', _ESC_HASH).replace('\\/', _ESC_SLASH)

    has_wildcards = False

    if keep_comments:
        # Comments disabled — only expand wildcards, no comment processing
        def wc_replacer(m):
            nonlocal has_wildcards
            name = m.group(1)
            if name not in wc_map:
                return m.group(0)
            has_wildcards = True
            return rng.choice(wc_map[name])
        result = _WILDCARD_ONLY.sub(wc_replacer, text)
    else:
        # Comments enabled — full processing (comments + wildcards in one pass)
        def replacer(m):
            nonlocal has_wildcards
            if m.group(1) is None:
                # Comment match — strip
                return ''
            # Wildcard match
            name = m.group(1)
            if name not in wc_map:
                return m.group(0)  # unresolved — leave as-is
            has_wildcards = True
            return rng.choice(wc_map[name])

        result = _PROMPT_PROC.sub(replacer, text)

        # Pass 2: strip comments introduced by wildcard expansion
        if has_wildcards:
            result = _COMMENT_ONLY.sub('', result)

    # ── Restore escaped markers ──
    # Execution path (keep_comments=False): restore to bare literal chars (# /)
    # Metadata path  (keep_comments=True):  restore to original escaped form (\# \/)
    #   so that round-tripping through metadata preserves the user's intent.
    if keep_comments:
        result = result.replace(_ESC_HASH, '\\#').replace(_ESC_SLASH, '\\/')
    else:
        result = result.replace(_ESC_HASH, '#').replace(_ESC_SLASH, '/')

    return result


def _expand_wildcards(json_data):
    """on_prompt handler: process comments and wildcards in prompt text.

    Comments: stripped from execution prompt, preserved in workflow metadata.
    Wildcards: expanded deterministically (seeded from workflow's seed/noise_seed)
               in both prompt and metadata.
    """
    prompt = json_data.get("prompt")
    if not prompt or not isinstance(prompt, dict):
        return json_data

    # ── Strip DrawerSeed 'mode' from prompt so it doesn't affect cache ──
    # The 'mode' widget is a frontend-only concern (randomize vs fixed);
    # only seed_value matters for execution and caching.
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "DrawerSeed":
            inputs = node.get("inputs")
            if isinstance(inputs, dict):
                inputs.pop("mode", None)

    # Build wildcard map (may be empty — comments still need processing)
    manifest = _read_manifest()
    wc_map = {}
    for d in manifest:
        if d.get("type") == "wildcard" and d.get("enabled", True):
            raw = _read_wildcard_entries(d["id"])
            # Filter out comment lines (# or // at start of line)
            entries = [e for e in raw
                       if not e.startswith('#') and not e.startswith('//')]
            if entries:
                wc_map[d["title"]] = entries

    # Deterministic RNG — two instances with the same seed so prompt and
    # metadata produce identical wildcard expansions while differing only
    # in comment handling.
    wf_seed = _find_prompt_seed(prompt)
    rng_prompt = _random.Random(wf_seed)   # for execution (strip comments)
    rng_meta   = _random.Random(wf_seed)   # for metadata  (keep comments)

    # Process prompt inputs (deterministic order: sorted node_id → sorted key)
    # meta_log: {node_id: {original: meta_text}}  — for workflow metadata sync
    meta_log = {}
    prompt_changed = False

    for node_id in sorted(prompt.keys(),
                          key=lambda x: int(x) if x.isdigit() else float('inf')):
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

            # For execution: strip comments (if enabled) + expand wildcards
            exec_text = _process_prompt_text(value, rng_prompt, wc_map,
                                             keep_comments=not _comments_enabled)
            # For metadata: always keep comments + expand wildcards
            meta_text = _process_prompt_text(value, rng_meta, wc_map,
                                             keep_comments=True)


            if exec_text != value:
                inputs[key] = exec_text
                prompt_changed = True
            if meta_text != value:
                meta_log.setdefault(node_id, {})[value] = meta_text


    if not prompt_changed and not meta_log:
        return json_data

    # Apply wildcard expansions (but not comment removal) to workflow metadata
    if meta_log:
        _apply_expansion_to_workflow(json_data, meta_log)

    logger.info("[Prompt] Processed comments/wildcards (seed=%s)", wf_seed)
    return json_data


def _apply_expansion_to_workflow(json_data, expansion_log):
    """Copy processed text into extra_data.workflow so output images record
    the resolved prompt (wildcards expanded, comments preserved).

    Uses expansion_log {node_id → {original: processed}} built during prompt
    processing to ensure prompt and metadata stay perfectly in sync.
    """
    extra = json_data.get("extra_data")
    if not extra or not isinstance(extra, dict):
        return

    # ComfyUI V2: workflow lives under extra_data.extra_pnginfo.workflow
    # (fallback to extra_data.workflow for older versions)
    pnginfo = extra.get("extra_pnginfo")
    if isinstance(pnginfo, dict):
        workflow = pnginfo.get("workflow")
    else:
        workflow = extra.get("workflow")

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
        widgets = wf_node.get("widgets_values")
        if isinstance(widgets, list):
            for i, val in enumerate(widgets):
                if isinstance(val, str) and val in log:
                    widgets[i] = log[val]
        elif isinstance(widgets, dict):
            for key, val in widgets.items():
                if isinstance(val, str) and val in log:
                    widgets[key] = log[val]


server.PromptServer.instance.add_on_prompt_handler(_expand_wildcards)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Filesystem API — Browse, search, meta, delete
#  Generic filesystem layer for Drawer gadgets (Gallery, future ModelViewer, etc.)
#  All endpoints are under /drawer/fs/ and accept a `root` parameter to select
#  among whitelisted directories (output, input, temp).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp')
_VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.avi', '.mkv')
_AUDIO_EXTS = ('.flac', '.mp3', '.opus', '.wav', '.ogg')
_MEDIA_EXTS = _IMAGE_EXTS + _VIDEO_EXTS + _AUDIO_EXTS

def _ftype(ext):
    if ext in _IMAGE_EXTS: return 'image'
    if ext in _VIDEO_EXTS: return 'video'
    if ext in _AUDIO_EXTS: return 'audio'
    return 'unknown'

# Whitelist of allowed root directories.
# Maps root name -> callable that returns the absolute path.
_ALLOWED_ROOTS = {
    "output": lambda: os.path.realpath(folder_paths.get_output_directory()),
    "input":  lambda: os.path.realpath(folder_paths.get_input_directory()),
    "temp":   lambda: os.path.realpath(folder_paths.get_temp_directory()),
}

# Only these roots allow file deletion (safety measure).
_DELETABLE_ROOTS = {"output", "input", "temp"}

# Root display names for breadcrumbs.
_ROOT_LABELS = {
    "output": "Outputs",
    "input":  "Input",
    "temp":   "Temp",
}


def _resolve_root(request):
    """Resolve the root parameter from request query to an absolute path.
    Returns (root_name, root_path) or (None, None) if invalid.
    Defaults to 'output' if not specified.
    """
    root_name = request.query.get("root", "output").strip().lower()
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return None, None
    return root_name, getter()


def _safe_path(root, *parts):
    """Join paths and verify the result is strictly inside root (prevent traversal)."""
    joined = os.path.join(root, *parts)
    real = os.path.realpath(joined)
    if real != root and not real.startswith(root + os.sep):
        return None
    return real


def _extract_searchable_parts(meta):
    """Extract structured searchable parts from ComfyUI metadata.
    Returns dict with keys: classes, titles, inputs.
    """
    classes = []
    titles = []
    inputs = []
    prompt = meta.get("prompt", {})
    if isinstance(prompt, dict):
        for _nid, node in prompt.items():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type", "")
            if ct:
                classes.append(ct)
            nm = node.get("_meta", {})
            if isinstance(nm, dict):
                t = nm.get("title", "")
                if t:
                    titles.append(t)
            node_inputs = node.get("inputs", {})
            if isinstance(node_inputs, dict):
                for _k, v in node_inputs.items():
                    if isinstance(v, str) and v:
                        inputs.append(v)
                    elif isinstance(v, (int, float)):
                        inputs.append(str(v))
    workflow = meta.get("workflow", {})
    if isinstance(workflow, dict):
        for wn in workflow.get("nodes", []):
            if isinstance(wn, dict):
                t = wn.get("title", "")
                if t:
                    titles.append(t)
    return {
        "classes": " ".join(classes),
        "titles": " ".join(titles),
        "inputs": " ".join(inputs),
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Search Index — SQLite FTS5 for fast metadata search
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class _SearchIndex:
    """SQLite FTS5-backed search index for media files.

    - Stores filename + extracted PNG metadata text in a FTS5 table.
    - Background thread builds/updates on startup.
    - Incremental updates via mtime comparison.
    """

    _SCHEMA_VERSION = 4  # v4: normalize path separators (always forward slash)

    def __init__(self):
        self._db_path = os.path.join(folder_paths.get_user_directory(), "drawer_index.db")
        self._lock = threading.Lock()
        self._ready = False
        self._building = False
        self._progress = ""
        self._indexed_count = 0
        self._total_count = 0
        self._conn = None

    def _get_conn(self):
        """Get or create a thread-safe connection."""
        if self._conn is None:
            os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
            self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=30.0)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._init_schema()
        return self._conn

    def _init_schema(self):
        c = self._conn
        c.execute("""
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        # Check schema version — drop old tables if outdated
        row = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if row is None or int(row[0]) < self._SCHEMA_VERSION:
            # Full reset: drop everything and recreate
            c.executescript("""
                DROP TRIGGER IF EXISTS files_ai;
                DROP TRIGGER IF EXISTS files_ad;
                DROP TRIGGER IF EXISTS files_au;
                DROP TABLE IF EXISTS files_fts;
                DROP TABLE IF EXISTS files;
            """)
            c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)",
                      (str(self._SCHEMA_VERSION),))
            c.commit()

        c.execute("""
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                root TEXT NOT NULL,
                subfolder TEXT NOT NULL,
                name TEXT NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                ftype TEXT NOT NULL,
                s_classes TEXT NOT NULL DEFAULT '',
                s_titles TEXT NOT NULL DEFAULT '',
                s_inputs TEXT NOT NULL DEFAULT ''
            )
        """)
        c.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path
            ON files(root, subfolder, name)
        """)
        # FTS5 virtual table — 4 searchable columns
        c.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                name, s_classes, s_titles, s_inputs,
                content='files', content_rowid='id'
            )
        """)
        # Triggers to keep FTS in sync
        c.executescript("""
            CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
                INSERT INTO files_fts(rowid, name, s_classes, s_titles, s_inputs)
                VALUES (new.id, new.name, new.s_classes, new.s_titles, new.s_inputs);
            END;
            CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, s_classes, s_titles, s_inputs)
                VALUES ('delete', old.id, old.name, old.s_classes, old.s_titles, old.s_inputs);
            END;
            CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, s_classes, s_titles, s_inputs)
                VALUES ('delete', old.id, old.name, old.s_classes, old.s_titles, old.s_inputs);
                INSERT INTO files_fts(rowid, name, s_classes, s_titles, s_inputs)
                VALUES (new.id, new.name, new.s_classes, new.s_titles, new.s_inputs);
            END;
        """)

    def start_background_build(self):
        """Start indexing in a background thread."""
        t = threading.Thread(target=self._build_all, daemon=True)
        t.start()

    # Roots to watch for incremental indexing after initial build.
    _WATCH_ROOTS = {"output", "input"}
    _WATCH_INTERVAL = 10  # seconds between incremental scans
    _PURGE_EVERY = 6      # run _purge_stale every N watcher cycles

    def _build_all(self):
        """Scan all allowed roots and index media files."""
        self._building = True
        self._progress = "Starting index build..."
        try:
            with self._lock:
                conn = self._get_conn()

            for root_name, getter in _ALLOWED_ROOTS.items():
                try:
                    root_path = getter()
                except Exception:
                    continue
                if not os.path.isdir(root_path):
                    continue
                self._index_root(conn, root_name, root_path)

            self._purge_stale(conn)

            self._progress = "Index ready"
            self._ready = True
        except Exception as e:
            self._progress = f"Index error: {e}"
            logger.error(f"Search index build failed: {e}")
        finally:
            self._building = False

        # Start incremental watcher for output/input roots
        self._start_watcher()

    def _start_watcher(self):
        """Launch a daemon thread that periodically indexes new files."""
        t = threading.Thread(target=self._watch_loop, daemon=True)
        t.start()

    def _watch_loop(self):
        """Periodically re-scan watched roots for new/changed files.
        Uses directory mtime to skip unchanged directories.
        Prevents overlapping cycles.
        """
        import time
        cycle = 0
        # Track last-seen mtime per (root_name, rel_dir)
        dir_mtimes = {}
        while True:
            time.sleep(self._WATCH_INTERVAL)
            cycle += 1
            try:
                with self._lock:
                    conn = self._get_conn()
                for root_name in self._WATCH_ROOTS:
                    getter = _ALLOWED_ROOTS.get(root_name)
                    if not getter:
                        continue
                    try:
                        root_path = getter()
                    except Exception:
                        continue
                    if not os.path.isdir(root_path):
                        continue
                    self._index_changed_dirs(conn, root_name, root_path, dir_mtimes)
                # Periodic purge of deleted files
                if cycle % self._PURGE_EVERY == 0:
                    self._purge_stale(conn)
            except Exception as e:
                logger.debug(f"[Drawer] Watcher cycle error: {e}")

    def _index_changed_dirs(self, conn, root_name, root_path, dir_mtimes):
        """Walk root but only process directories whose mtime has changed."""
        for dirpath, dirnames, filenames in os.walk(root_path):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            try:
                dir_mtime = os.path.getmtime(dirpath)
            except OSError:
                continue
            cache_key = (root_name, dirpath)
            prev_mtime = dir_mtimes.get(cache_key)
            if prev_mtime is not None and abs(dir_mtime - prev_mtime) < 0.01:
                continue  # directory unchanged — skip
            dir_mtimes[cache_key] = dir_mtime
            # Index files in this changed directory
            rel = os.path.relpath(dirpath, root_path).replace("\\", "/")
            if rel == ".":
                rel = ""
            for fname in filenames:
                ext = os.path.splitext(fname)[1].lower()
                if ext not in _MEDIA_EXTS:
                    continue
                full = os.path.join(dirpath, fname)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                # Check if already indexed with same mtime
                row = conn.execute(
                    "SELECT mtime FROM files WHERE root=? AND subfolder=? AND name=?",
                    (root_name, rel, fname)
                ).fetchone()
                if row and abs(st.st_mtime - row[0]) < 0.01:
                    continue  # unchanged file
                # Index or update
                s_classes = s_titles = s_inputs = ""
                meta = _read_embedded_meta(full)
                if meta:
                    parts = _extract_searchable_parts(meta)
                    s_classes = parts["classes"]
                    s_titles = parts["titles"]
                    s_inputs = parts["inputs"]
                ftype = _ftype(ext)
                with self._lock:
                    conn.execute("""
                        INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                                         s_classes, s_titles, s_inputs)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(root, subfolder, name) DO UPDATE SET
                            mtime=excluded.mtime, size=excluded.size,
                            ftype=excluded.ftype,
                            s_classes=excluded.s_classes,
                            s_titles=excluded.s_titles,
                            s_inputs=excluded.s_inputs
                    """, (root_name, rel, fname, st.st_mtime, st.st_size, ftype,
                          s_classes, s_titles, s_inputs))
            conn.commit()

    def _index_root(self, conn, root_name, root_path):
        """Walk a root directory and index/update media files."""
        existing = {}
        for row in conn.execute(
            "SELECT subfolder, name, mtime FROM files WHERE root=?", (root_name,)
        ):
            existing[(row[0], row[1])] = row[2]

        count = 0
        for dirpath, dirnames, filenames in os.walk(root_path):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            rel = os.path.relpath(dirpath, root_path).replace("\\", "/")
            if rel == ".":
                rel = ""
            media_files = [
                f for f in filenames
                if os.path.splitext(f)[1].lower() in _MEDIA_EXTS
            ]
            for fname in media_files:
                full = os.path.join(dirpath, fname)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                key = (rel, fname)
                old_mtime = existing.pop(key, None)
                if old_mtime is not None and abs(st.st_mtime - old_mtime) < 0.01:
                    count += 1
                    continue  # unchanged
                # Extract searchable parts from embedded metadata (images & video)
                s_classes = s_titles = s_inputs = ""
                meta = _read_embedded_meta(full)
                if meta:
                    parts = _extract_searchable_parts(meta)
                    s_classes = parts["classes"]
                    s_titles = parts["titles"]
                    s_inputs = parts["inputs"]
                ext = os.path.splitext(fname)[1].lower()
                ftype = _ftype(ext)
                with self._lock:
                    conn.execute("""
                        INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                                         s_classes, s_titles, s_inputs)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(root, subfolder, name) DO UPDATE SET
                            mtime=excluded.mtime, size=excluded.size,
                            ftype=excluded.ftype,
                            s_classes=excluded.s_classes,
                            s_titles=excluded.s_titles,
                            s_inputs=excluded.s_inputs
                    """, (root_name, rel, fname, st.st_mtime, st.st_size, ftype,
                          s_classes, s_titles, s_inputs))
                count += 1
                self._indexed_count = count
                if count % 500 == 0:
                    conn.commit()
                    self._progress = f"Indexing {root_name}: {count} files..."
        conn.commit()
        self._progress = f"Indexed {root_name}: {count} files"
        self._total_count += count

    def _purge_stale(self, conn):
        """Remove index entries for files that no longer exist on disk."""
        stale_ids = []
        for row in conn.execute("SELECT id, root, subfolder, name FROM files"):
            fid, root_name, subfolder, name = row
            getter = _ALLOWED_ROOTS.get(root_name)
            if getter is None:
                stale_ids.append(fid)
                continue
            try:
                root_path = getter()
            except Exception:
                continue
            full = os.path.join(root_path, subfolder, name) if subfolder else \
                   os.path.join(root_path, name)
            if not os.path.isfile(full):
                stale_ids.append(fid)
        if stale_ids:
            with self._lock:
                for fid in stale_ids:
                    conn.execute("DELETE FROM files WHERE id=?", (fid,))
                conn.commit()
            logger.info(f"Purged {len(stale_ids)} stale index entries")

    def search(self, query, root_name, subpath="", limit=200, scope=""):
        """Search the index. Returns list of file dicts, or None if index not ready.
        scope: '' (all), 'name', 'class', 'title', 'input'
        """
        if not self._ready:
            return None  # signal caller to fall back

        # Map scope to column names
        _SCOPE_MAP = {
            "name": ("name", "f.name"),
            "class": ("s_classes", "f.s_classes"),
            "title": ("s_titles", "f.s_titles"),
            "input": ("s_inputs", "f.s_inputs"),
        }

        with self._lock:
            conn = self._get_conn()

            # Exact match mode: "query" (double-quoted) → SQL LIKE on raw columns
            if query.startswith('"') and query.endswith('"') and len(query) > 2:
                exact = query[1:-1].lower()
                pattern = f"%{exact}%"
                if scope in _SCOPE_MAP:
                    _, sql_col = _SCOPE_MAP[scope]
                    sql = f"""
                        SELECT f.name, f.subfolder, f.size, f.mtime, f.ftype
                        FROM files AS f
                        WHERE f.root = ? AND LOWER({sql_col}) LIKE ?
                    """
                    params = [root_name, pattern]
                else:
                    sql = """
                        SELECT f.name, f.subfolder, f.size, f.mtime, f.ftype
                        FROM files AS f
                        WHERE f.root = ?
                          AND (LOWER(f.name) LIKE ?
                            OR LOWER(f.s_classes) LIKE ?
                            OR LOWER(f.s_titles) LIKE ?
                            OR LOWER(f.s_inputs) LIKE ?)
                    """
                    params = [root_name, pattern, pattern, pattern, pattern]
                if subpath:
                    sql += " AND (f.subfolder = ? OR f.subfolder LIKE ?)"
                    params.extend([subpath, subpath + "/%"])
                if limit > 0:
                    sql += " ORDER BY f.mtime DESC LIMIT ?"
                    params.append(limit)
                else:
                    sql += " ORDER BY f.mtime DESC"
                try:
                    rows = conn.execute(sql, params).fetchall()
                except sqlite3.OperationalError:
                    return []
            else:
                # FTS5 token search (fuzzy — ignores hyphens/underscores)
                tokens = [t for t in query.lower().split() if t]
                if not tokens:
                    return []
                # Build FTS5 query with optional column scope
                if scope in _SCOPE_MAP:
                    fts_col, _ = _SCOPE_MAP[scope]
                    fts_query = " AND ".join(f'{fts_col}:"{t}"*' for t in tokens)
                else:
                    fts_query = " AND ".join(f'"{t}"*' for t in tokens)
                sql = """
                    SELECT f.name, f.subfolder, f.size, f.mtime, f.ftype
                    FROM files_fts AS idx
                    JOIN files AS f ON f.id = idx.rowid
                    WHERE files_fts MATCH ?
                      AND f.root = ?
                """
                params = [fts_query, root_name]
                if subpath:
                    sql += " AND (f.subfolder = ? OR f.subfolder LIKE ?)"
                    params.extend([subpath, subpath + "/%"])
                if limit > 0:
                    sql += " ORDER BY f.mtime DESC LIMIT ?"
                    params.append(limit)
                else:
                    sql += " ORDER BY f.mtime DESC"
                try:
                    rows = conn.execute(sql, params).fetchall()
                except sqlite3.OperationalError:
                    return []
        results = []
        for name, subfolder, size, mtime, ftype in rows:
            subfolder = subfolder.replace("\\", "/")
            results.append({
                "name": name,
                "path": (subfolder + "/" + name) if subfolder else name,
                "subfolder": subfolder,
                "size": size,
                "created": mtime,
                "type": ftype,
            })
        return results

    def update_searchable(self, root_name, subfolder, name,
                          searchable_text="",
                          s_classes="", s_titles="", s_inputs=""):
        """Update searchable fields for an indexed file.
        Accepts either structured fields (s_classes, s_titles, s_inputs)
        or a single searchable_text (stored as s_inputs for backward compat).
        """
        getter = _ALLOWED_ROOTS.get(root_name)
        if getter is None:
            return False
        try:
            root_path = getter()
        except Exception:
            return False
        full = os.path.join(root_path, subfolder, name) if subfolder else \
               os.path.join(root_path, name)
        if not os.path.isfile(full):
            return False
        try:
            st = os.stat(full)
        except OSError:
            return False
        # Backward compat: if only searchable_text given, put it in s_inputs
        if searchable_text and not (s_classes or s_titles or s_inputs):
            s_inputs = searchable_text
        ext = os.path.splitext(name)[1].lower()
        ftype = _ftype(ext)
        with self._lock:
            conn = self._get_conn()
            conn.execute("""
                INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                                 s_classes, s_titles, s_inputs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(root, subfolder, name) DO UPDATE SET
                    mtime=excluded.mtime, size=excluded.size,
                    ftype=excluded.ftype,
                    s_classes=excluded.s_classes,
                    s_titles=excluded.s_titles,
                    s_inputs=excluded.s_inputs
            """, (root_name, subfolder.replace("\\", "/"), name, st.st_mtime, st.st_size, ftype,
                  s_classes, s_titles, s_inputs))
            conn.commit()
        return True

    @property
    def status(self):
        return {
            "ready": self._ready,
            "building": self._building,
            "progress": self._progress,
            "indexed": self._total_count,
        }


# Global search index instance — starts building on module load
_search_index = _SearchIndex()
_search_index.start_background_build()


def _read_png_text_chunks(filepath):
    """Read tEXt/iTXt chunks from a PNG file without PIL.
    Returns dict of {keyword: text_value}.
    ComfyUI stores 'prompt' and 'workflow' as JSON strings in tEXt chunks.
    """
    result = {}
    try:
        with open(filepath, "rb") as f:
            sig = f.read(8)
            if sig != b'\x89PNG\r\n\x1a\n':
                return result
            while True:
                header = f.read(8)
                if len(header) < 8:
                    break
                length, chunk_type = struct.unpack(">I4s", header)
                chunk_type = chunk_type.decode("ascii", errors="ignore")
                if chunk_type == "IEND":
                    break
                data = f.read(length)
                f.read(4)  # CRC
                if chunk_type == "tEXt" and len(data) > 0:
                    sep = data.find(b'\x00')
                    if sep >= 0:
                        keyword = data[:sep].decode("latin-1", errors="ignore")
                        text = data[sep + 1:].decode("latin-1", errors="ignore")
                        result[keyword] = text
                elif chunk_type == "iTXt" and len(data) > 0:
                    sep = data.find(b'\x00')
                    if sep >= 0:
                        keyword = data[:sep].decode("utf-8", errors="ignore")
                        rest = data[sep + 1:]
                        if len(rest) >= 2:
                            comp_flag = rest[0]
                            rest = rest[2:]
                            sep2 = rest.find(b'\x00')
                            if sep2 >= 0:
                                rest = rest[sep2 + 1:]
                                sep3 = rest.find(b'\x00')
                                if sep3 >= 0:
                                    text_data = rest[sep3 + 1:]
                                    if comp_flag:
                                        try:
                                            text_data = zlib.decompress(text_data)
                                        except zlib.error:
                                            continue
                                    result[keyword] = text_data.decode("utf-8", errors="ignore")
    except (OSError, struct.error):
        pass
    return result



def _sanitize_json_floats(obj):
    """Recursively replace float NaN/Infinity with None (JSON null).

    Python's json module allows NaN and Infinity by default, but browsers
    reject them as invalid JSON.  ComfyUI stores is_changed=float('nan') in
    workflow data to force re-execution; we replace these with null so the
    response is valid for JSON.parse() on the client side.
    """
    if isinstance(obj, float):
        import math
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize_json_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_json_floats(v) for v in obj]
    return obj


def _read_webp_riff_meta(filepath):
    """Read ComfyUI metadata from a WEBP file by parsing raw RIFF chunks.

    Handles both static and animated WEBP files. PIL's getexif() can fail for
    animated WEBP (VP8X format) because the EXIF chunk appears after animation
    frames.  This function walks the RIFF chunk list directly.

    Looks for:
      - EXIF chunk  -> reads EXIF tags 0x010F/0x0110 used by ComfyUI SaveImage
      - XMP  chunk  -> scans for JSON workflow embedded by third-party tools
    """
    try:
        with open(filepath, "rb") as f:
            header = f.read(12)
            if len(header) < 12:
                return None
            if header[:4] != b"RIFF" or header[8:12] != b"WEBP":
                return None  # not a WEBP file

            exif_bytes = None
            xmp_bytes  = None
            while True:
                ch = f.read(8)
                if len(ch) < 8:
                    break
                chunk_id   = ch[:4]
                chunk_size = struct.unpack_from("<I", ch, 4)[0]
                chunk_data = f.read(chunk_size)
                if chunk_size % 2:          # RIFF chunks are padded to even size
                    f.read(1)
                if chunk_id == b"EXIF":
                    exif_bytes = chunk_data
                elif chunk_id in (b"XMP ", b"XMP\x00"):
                    xmp_bytes = chunk_data

        # Try EXIF chunk first
        if exif_bytes:
            meta = _parse_exif_bytes_for_workflow(exif_bytes)
            if meta:
                return meta

        # Try XMP chunk as fallback
        if xmp_bytes:
            meta = _parse_xmp_bytes_for_workflow(xmp_bytes)
            if meta:
                return meta

    except Exception:
        pass
    return None


def _parse_exif_bytes_for_workflow(exif_bytes):
    """Parse raw EXIF bytes and extract ComfyUI workflow/prompt tags."""
    try:
        from PIL import Image
        exif = Image.Exif()
        exif.load(exif_bytes)
        meta = {}
        for tag_id in (0x010F, 0x0110, 0x010E, 0x010D):
            val = exif.get(tag_id)
            if isinstance(val, str) and ":" in val:
                key, _, json_str = val.partition(":")
                if key in ("prompt", "workflow"):
                    try:
                        meta[key] = json.loads(json_str)
                    except (json.JSONDecodeError, ValueError):
                        pass
        return meta if meta else None
    except Exception:
        return None


def _parse_xmp_bytes_for_workflow(xmp_bytes):
    """Scan XMP bytes for embedded ComfyUI workflow JSON."""
    try:
        import re
        text = xmp_bytes.decode("utf-8", errors="ignore")
        # Look for JSON blocks that look like ComfyUI prompt/workflow
        for m in re.finditer(r'(\{[^<]{20,}\})', text, re.DOTALL):
            candidate = m.group(1).strip()
            try:
                obj = json.loads(candidate)
                if isinstance(obj, dict):
                    result = {}
                    for key in ("prompt", "workflow"):
                        if key in obj:
                            result[key] = obj[key]
                    if result:
                        return result
                    # The whole JSON might be the workflow itself
                    if "nodes" in obj and "links" in obj:
                        return {"workflow": obj}
            except (json.JSONDecodeError, ValueError):
                pass
    except Exception:
        pass
    return None


def _read_embedded_meta(filepath):

    """Read ComfyUI metadata embedded in an image, video, or audio file.

    Supports:
      - PNG: tEXt/iTXt chunks (ComfyUI standard SaveImage format)
      - JPEG/WebP: EXIF UserComment or PIL info dict (custom nodes)
      - MP4/MOV/MKV/WebM: FFmpeg metadata atoms (VideoHelperSuite)
      - FLAC/MP3/Opus/WAV/OGG: FFmpeg metadata tags (ComfyUI SaveAudio)
    Returns a dict with 'prompt' and/or 'workflow' keys, or None.
    """
    ext = os.path.splitext(filepath)[1].lower()

    # PNG — use our fast custom parser (no PIL needed)
    if ext == ".png":
        chunks = _read_png_text_chunks(filepath)
        if not chunks:
            return None
        meta = {}
        for key in ("prompt", "workflow"):
            if key in chunks:
                try:
                    meta[key] = json.loads(chunks[key])
                except (json.JSONDecodeError, ValueError):
                    pass
        return meta if meta else None

    # JPEG / WebP — use PIL EXIF
    if ext in (".jpg", ".jpeg", ".webp"):
        return _read_exif_meta(filepath)

    # Video / Audio — use ffprobe
    if ext in _VIDEO_EXTS or ext in _AUDIO_EXTS:
        return _read_video_meta(filepath)

    return None


def _read_video_meta(filepath):
    """Read ComfyUI metadata from video files using ffprobe.

    VideoHelperSuite and similar nodes embed prompt/workflow JSON via
    FFmpeg's -metadata flag, stored in the container's metadata atoms
    (e.g. moov/udta for MP4).
    """
    import subprocess
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                filepath,
            ],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        tags = data.get("format", {}).get("tags", {})
        if not tags:
            return None
        meta = {}
        for key in ("prompt", "workflow"):
            raw = tags.get(key)
            if raw:
                try:
                    meta[key] = json.loads(raw)
                except (json.JSONDecodeError, ValueError):
                    pass
        return meta if meta else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def _read_exif_meta(filepath):
    """Read ComfyUI metadata from JPEG/WebP EXIF tags.

    ComfyUI stores metadata in EXIF tags:
      - 0x010F (Make) = "workflow:JSON"  or other "key:JSON"
      - 0x0110 (Model) = "prompt:JSON"
    Also checks PIL info dict and EXIF UserComment as fallbacks.
    """
    try:
        from PIL import Image

        with Image.open(filepath) as img:
            # 1. Check PIL info dict (some nodes store metadata here)
            info = img.info or {}
            meta = {}
            for key in ("prompt", "workflow"):
                if key in info:
                    try:
                        val = info[key]
                        if isinstance(val, bytes):
                            val = val.decode("utf-8", errors="ignore")
                        if isinstance(val, str):
                            meta[key] = json.loads(val)
                    except (json.JSONDecodeError, ValueError):
                        pass
            if meta:
                return meta

            # 2. Read EXIF tags (ComfyUI native format for WebP)
            exif = img.getexif()
            if exif:
                meta = {}
                # Check Make (0x010F), Model (0x0110), and nearby tags
                for tag_id in (0x010F, 0x0110, 0x010E, 0x010D):
                    val = exif.get(tag_id)
                    if isinstance(val, str) and ":" in val:
                        key, _, json_str = val.partition(":")
                        if key in ("prompt", "workflow"):
                            try:
                                meta[key] = json.loads(json_str)
                            except (json.JSONDecodeError, ValueError):
                                pass
                if meta:
                    return meta

                # 3. Fallback: EXIF UserComment (legacy/third-party nodes)
                exif_ifd = exif.get_ifd(0x8769)
                if exif_ifd:
                    user_comment = exif_ifd.get(0x9286)
                    if user_comment:
                        text = user_comment
                        if isinstance(text, bytes):
                            if text.startswith(b"UNICODE\x00"):
                                text = text[8:].decode("utf-16le", errors="ignore")
                            elif text.startswith(b"ASCII\x00\x00\x00"):
                                text = text[8:].decode("ascii", errors="ignore")
                            else:
                                text = text.decode("utf-8", errors="ignore")
                        if isinstance(text, str) and text.strip():
                            try:
                                data = json.loads(text)
                                if isinstance(data, dict):
                                    result = {}
                                    for key in ("prompt", "workflow"):
                                        if key in data:
                                            result[key] = data[key]
                                    if result:
                                        return result
                            except (json.JSONDecodeError, ValueError):
                                pass

    except Exception:
        pass

    # Final fallback: for WEBP files, try raw RIFF chunk parser.
    # This handles animated WEBP where PIL's getexif() may miss the EXIF
    # chunk because it appears after the animation frame chunks.
    if filepath.lower().endswith(".webp"):
        return _read_webp_riff_meta(filepath)

    return None



# -- Browse --

@_routes.get("/drawer/fs/browse")
async def fs_browse(request):
    """GET /drawer/fs/browse?root=output&path=<relative>"""
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subpath = request.query.get("path", "").strip().replace("\\", "/")
    target = _safe_path(root, subpath) if subpath else root
    if target is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    if not os.path.isdir(target):
        return web.json_response({"error": "Not found"}, status=404)
    folders, files = [], []
    try:
        entries = os.listdir(target)
    except OSError:
        return web.json_response({"error": "Cannot read"}, status=500)
    for entry in sorted(entries):
        if entry.startswith("."):
            continue
        full = os.path.join(target, entry)
        rel = (subpath + "/" + entry) if subpath else entry
        rel = rel.replace("\\", "/")
        if os.path.isdir(full):
            folders.append({"name": entry, "path": rel})
        elif os.path.isfile(full):
            ext = os.path.splitext(entry)[1].lower()
            if ext in _MEDIA_EXTS:
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                files.append({
                    "name": entry, "path": rel, "subfolder": subpath,
                    "size": st.st_size, "created": st.st_ctime,
                    "type": _ftype(ext),
                })
    parts = [p for p in subpath.replace("\\", "/").split("/") if p]
    label = _ROOT_LABELS.get(root_name, root_name.title())
    crumbs = [{"name": label, "path": ""}]
    acc = ""
    for p in parts:
        acc = (acc + "/" + p) if acc else p
        crumbs.append({"name": p, "path": acc})
    return web.json_response({
        "root": root_name, "path": subpath, "breadcrumb": crumbs,
        "folders": folders, "files": files,
    })


# -- Siblings (for breadcrumb dropdown) --

@_routes.get("/drawer/fs/siblings")
async def fs_siblings(request):
    """GET /drawer/fs/siblings?root=output&path=<relative>
    Returns sibling folders of the given path (i.e. folders in the parent directory).
    If path is empty, returns root-level folders.
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subpath = request.query.get("path", "").strip()
    # Parent of subpath
    if subpath:
        last_slash = subpath.replace("\\", "/").rfind("/")
        parent_sub = subpath[:last_slash] if last_slash >= 0 else ""
    else:
        parent_sub = ""
    parent_dir = _safe_path(root, parent_sub) if parent_sub else root
    if parent_dir is None or not os.path.isdir(parent_dir):
        return web.json_response({"folders": []})
    folders = []
    try:
        for entry in sorted(os.listdir(parent_dir)):
            if entry.startswith("."):
                continue
            full = os.path.join(parent_dir, entry)
            if os.path.isdir(full):
                rel = (parent_sub + "/" + entry) if parent_sub else entry
                folders.append({"name": entry, "path": rel})
    except OSError:
        pass
    return web.json_response({"folders": folders, "parentPath": parent_sub})


# -- View (file serving) --

@_routes.get("/drawer/fs/view")
async def fs_view(request):
    """GET /drawer/fs/view?root=output&subfolder=2026-03&filename=img.png
    Serve a file from any allowed root.  Unlike ComfyUI's /view which uses
    'type' as an alias for root, this endpoint takes explicit root + subfolder
    so there is no ambiguity when a subfolder happens to share a root's name.
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subfolder = request.query.get("subfolder", "").strip()
    filename = request.query.get("filename", "").strip()
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)
    if subfolder:
        target = _safe_path(root, subfolder, filename)
    else:
        target = _safe_path(root, filename)
    if target is None or not os.path.isfile(target):
        return web.Response(status=404, text="Not found")
    resp = web.FileResponse(target)
    # Use mtime-based ETag for efficient caching without stale data
    try:
        st = os.stat(target)
        etag = f'"{int(st.st_mtime)}-{st.st_size}"'
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'no-cache'  # always revalidate
        # Check If-None-Match
        if_none_match = request.headers.get('If-None-Match')
        if if_none_match == etag:
            return web.Response(status=304)
    except OSError:
        resp.headers['Cache-Control'] = 'no-store'
    return resp


# -- Thumbnail (cached, WebP) --

@_routes.get("/drawer/fs/thumb")
async def fs_thumb(request):
    """GET /drawer/fs/thumb?root=input&subfolder=&filename=img.png&size=200
    Returns a cached WebP thumbnail. Generates on first request.
    Cache is stored under <root>/.thumbs/<subfolder>/<filename>.webp
    Regenerates if original mtime > cached mtime.
    """
    from PIL import Image as _PILImage

    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subfolder = request.query.get("subfolder", "").strip()
    filename = request.query.get("filename", "").strip()
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    max_size = int(request.query.get("size", "200"))
    max_size = max(32, min(max_size, 512))  # clamp

    # Resolve original file
    if subfolder:
        orig = _safe_path(root, subfolder, filename)
    else:
        orig = _safe_path(root, filename)
    if orig is None or not os.path.isfile(orig):
        return web.Response(status=404, text="Not found")

    # Only generate thumbnails for images
    ext = os.path.splitext(filename)[1].lower()
    if ext not in _IMAGE_EXTS:
        # Fall through to full-size view for non-image types
        return web.FileResponse(orig)

    # Determine cache path
    thumb_base = os.path.join(root, ".thumbs")
    thumb_name = os.path.splitext(filename)[0] + ".webp"
    if subfolder:
        thumb_path = _safe_path(thumb_base, subfolder, thumb_name)
    else:
        thumb_path = _safe_path(thumb_base, thumb_name)
    if thumb_path is None:
        return web.Response(status=400, text="Invalid path")

    # Check if cache is fresh
    need_generate = True
    if os.path.isfile(thumb_path):
        try:
            orig_mtime = os.path.getmtime(orig)
            thumb_mtime = os.path.getmtime(thumb_path)
            if thumb_mtime >= orig_mtime:
                need_generate = False
        except OSError:
            pass

    if need_generate:
        try:
            os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
            with _PILImage.open(orig) as img:
                img.thumbnail((max_size, max_size), _PILImage.LANCZOS)
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGBA")
                else:
                    img = img.convert("RGB")
                img.save(thumb_path, "WEBP", quality=75)
        except Exception as e:
            logger.warning(f"Thumbnail generation failed for {orig}: {e}")
            # Fallback to original file
            return web.FileResponse(orig)

    # Serve the thumbnail with aggressive caching
    resp = web.FileResponse(thumb_path)
    try:
        st = os.stat(thumb_path)
        etag = f'"{int(st.st_mtime)}-{st.st_size}"'
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'public, max-age=86400'
        if_none_match = request.headers.get('If-None-Match')
        if if_none_match == etag:
            return web.Response(status=304)
    except OSError:
        pass
    return resp


# -- Search --

@_routes.get("/drawer/fs/search")
async def fs_search(request):
    """GET /drawer/fs/search?root=output&q=<query>&path=<relative>
    Full-text search via SQLite FTS5 index.
    Falls back to filename search if index is not yet ready.
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    # Temp root is not searchable
    if root_name == "temp":
        return web.json_response({"files": [], "total": 0, "query": "",
                                  "error": "Search is not available for Temp"})
    query = request.query.get("q", "").strip()
    if not query:
        return web.json_response({"files": [], "total": 0, "query": ""})
    subpath = request.query.get("path", "").strip().replace("\\", "/")
    limit = int(request.query.get("limit", "0"))
    scope = request.query.get("scope", "").strip()

    # Try indexed search first
    results = _search_index.search(query, root_name, subpath, limit=limit, scope=scope)
    if results is not None and len(results) > 0:
        return web.json_response({"files": results, "total": len(results), "query": query})
    # For scoped searches (class/title/input), index is authoritative — no fallback
    if results is not None and scope in ("class", "title", "input"):
        return web.json_response({"files": [], "total": 0, "query": query})
    # Fallback: filename-only walk (only if index is NOT ready yet)
    if results is not None:
        # Index is ready but returned 0 — trust it, don't fall back
        return web.json_response({"files": [], "total": 0, "query": query})

    # Fallback: filename-only search (index not ready yet)
    tokens = [t for t in query.lower().split() if t]
    if not tokens:
        return web.json_response({"files": [], "total": 0, "query": query})
    search_root = _safe_path(root, subpath) if subpath else root
    if search_root is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    if not os.path.isdir(search_root):
        return web.json_response({"files": [], "total": 0, "query": query})
    results = []
    for dirpath, dirnames, filenames in os.walk(search_root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in _MEDIA_EXTS:
                continue
            if not all(tok in fname.lower() for tok in tokens):
                continue
            full = os.path.join(dirpath, fname)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(dirpath, root).replace("\\", "/")
            if rel == ".":
                rel = ""
            results.append({
                "name": fname,
                "path": (rel + "/" + fname) if rel else fname,
                "subfolder": rel, "size": st.st_size, "created": st.st_ctime,
                "type": _ftype(ext),
            })
    results.sort(key=lambda r: r["created"], reverse=True)
    return web.json_response({"files": results, "total": len(results), "query": query})


@_routes.get("/drawer/fs/index-status")
async def fs_index_status(request):
    """GET /drawer/fs/index-status — report indexing progress."""
    return web.json_response(_search_index.status)


@_routes.post("/drawer/fs/index-update")
async def fs_index_update(request):
    """POST /drawer/fs/index-update
    Single: {"root": "output", "subfolder": "...", "name": "...", "searchable": "..."}
    Batch:  {"entries": [{"root":..., "subfolder":..., "name":..., "searchable":...}, ...]}
    Allows external metadata providers to enrich the search index.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    entries = body.get("entries")
    if entries and isinstance(entries, list):
        # Batch mode
        ok_count = 0
        for entry in entries:
            root_name = entry.get("root", "output").strip().lower()
            subfolder = entry.get("subfolder", "").strip()
            name = entry.get("name", "").strip()
            searchable = entry.get("searchable", "").strip()
            s_classes = entry.get("s_classes", "").strip()
            s_titles = entry.get("s_titles", "").strip()
            s_inputs = entry.get("s_inputs", "").strip()
            if name and (searchable or s_classes or s_titles or s_inputs):
                if _search_index.update_searchable(
                    root_name, subfolder, name,
                    searchable_text=searchable,
                    s_classes=s_classes, s_titles=s_titles, s_inputs=s_inputs,
                ):
                    ok_count += 1
        return web.json_response({"ok": True, "updated": ok_count})

    # Single mode
    root_name = body.get("root", "output").strip().lower()
    subfolder = body.get("subfolder", "").strip()
    name = body.get("name", "").strip()
    searchable = body.get("searchable", "").strip()
    s_classes = body.get("s_classes", "").strip()
    s_titles = body.get("s_titles", "").strip()
    s_inputs = body.get("s_inputs", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    ok = _search_index.update_searchable(
        root_name, subfolder, name,
        searchable_text=searchable,
        s_classes=s_classes, s_titles=s_titles, s_inputs=s_inputs,
    )
    if not ok:
        return web.json_response({"error": "File not found or invalid root"}, status=404)
    return web.json_response({"ok": True})

# -- Meta --

@_routes.get("/drawer/fs/meta")
async def fs_meta(request):
    """GET /drawer/fs/meta?root=output&subfolder=<rel>&name=<filename>
    Returns metadata embedded in the image file (PNG tEXt chunks).
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subfolder = request.query.get("subfolder", "").strip()
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "Invalid"}, status=400)

    media_path = _safe_path(root, subfolder, name) if subfolder else _safe_path(root, name)
    if media_path and os.path.isfile(media_path):
        meta = _read_embedded_meta(media_path)
        if meta:
            # Sanitize NaN/Infinity: Python's JSON encoder emits non-standard
            # NaN/Infinity literals that browsers refuse to parse.
            meta = _sanitize_json_floats(meta)
            return web.json_response(meta)

    return web.json_response({"error": "Meta not found"}, status=404)



# -- Trash helper (cross-platform via send2trash) --

def _trash_file(filepath):
    """Send a file to the OS trash/recycle bin.
    Uses send2trash for cross-platform support (Windows/macOS/Linux).
    Returns True on success, False on failure.
    Refuses to delete if send2trash is not available (no permanent deletion).
    """
    if _send2trash is None:
        return False
    try:
        _send2trash(filepath)
        return True
    except Exception:
        return False


# -- Delete (output & temp only) --

@_routes.post("/drawer/fs/delete")
async def fs_delete(request):
    """POST /drawer/fs/delete
    Body: {"root": "output", "files": [{"subfolder":"...","name":"..."}, ...]}
    Restricted to output & temp roots for safety.
    Files are sent to the OS trash/recycle bin (requires send2trash).
    """
    if _send2trash is None:
        return web.json_response(
            {"error": "Delete unavailable: send2trash is not installed (pip install send2trash)"},
            status=503,
        )
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    root_name = body.get("root", "output").strip().lower()
    if root_name not in _DELETABLE_ROOTS:
        return web.json_response({"error": f"Delete not allowed for root '{root_name}'"}, status=403)
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    root = getter()
    files = body.get("files", [])
    if not files:
        return web.json_response({"error": "No files"}, status=400)
    deleted = 0
    deleted_folders = 0
    for item in files:
        subfolder = item.get("subfolder", "")
        name = item.get("name", "")
        if not name:
            continue
        media_path = _safe_path(root, subfolder, name) if subfolder else _safe_path(root, name)
        if media_path is None:
            continue
        if os.path.isfile(media_path):
            if _trash_file(media_path):
                deleted += 1
        elif os.path.isdir(media_path):
            # Folder deletion — send entire folder (with contents) to trash
            if _trash_file(media_path):
                deleted_folders += 1
    return web.json_response({"deleted": deleted, "deleted_folders": deleted_folders})


# -- Move --

def _auto_rename(dest_dir, name):
    """Generate a unique filename by appending _1, _2, ... before the extension."""
    base, ext = os.path.splitext(name)
    counter = 1
    while True:
        new_name = f"{base}_{counter}{ext}"
        if not os.path.exists(os.path.join(dest_dir, new_name)):
            return new_name
        counter += 1

def _merge_dirs(src_dir, dst_dir):
    """Recursively merge src_dir into dst_dir.
    - Files: if conflict, auto-rename the incoming file.
    - Folders: recurse into matching subfolders.
    Returns (moved_count, renamed_list, error_list).
    """
    import shutil
    moved = 0
    renamed = []
    errors = []
    for item_name in os.listdir(src_dir):
        item_src = os.path.join(src_dir, item_name)
        item_dst = os.path.join(dst_dir, item_name)
        if os.path.exists(item_dst):
            # Both are directories → recurse
            if os.path.isdir(item_src) and os.path.isdir(item_dst):
                m, r, e = _merge_dirs(item_src, item_dst)
                moved += m
                renamed.extend(r)
                errors.extend(e)
                continue
            # Conflict (file↔file, file↔dir, dir↔file) → rename
            new_name = _auto_rename(dst_dir, item_name)
            item_dst = os.path.join(dst_dir, new_name)
            renamed.append({"original": item_name, "renamed": new_name})
        try:
            shutil.move(item_src, item_dst)
            moved += 1
        except Exception as e:
            errors.append(f"Merge error: {item_name}: {e}")
    # Remove source dir if now empty
    try:
        if not os.listdir(src_dir):
            os.rmdir(src_dir)
    except OSError:
        pass
    return moved, renamed, errors

@_routes.post("/drawer/fs/move")
async def fs_move(request):
    """POST /drawer/fs/move
    Body: { root, files: [{subfolder, name}], destSubfolder,
            conflict: "skip"|"rename"|"overwrite" }
    Moves files to destSubfolder within the same root.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    # 'root' = destination root, 'srcRoot' = source root (defaults to root)
    root_name = body.get("root", "output").strip().lower()
    if root_name == "temp":
        return web.json_response({"error": "Move to Temp is not allowed"}, status=403)
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    dest_root = getter()

    src_root_name = body.get("srcRoot", root_name).strip().lower()
    src_getter = _ALLOWED_ROOTS.get(src_root_name)
    if src_getter is None:
        return web.json_response({"error": "Unknown srcRoot"}, status=400)
    src_root = src_getter()

    files = body.get("files", [])
    dest_subfolder = body.get("destSubfolder", "").strip()
    conflict = body.get("conflict", "skip").strip().lower()
    if conflict not in ("skip", "rename", "overwrite"):
        conflict = "skip"
    if not files:
        return web.json_response({"error": "No files"}, status=400)

    # Validate destination
    dest_dir = _safe_path(dest_root, dest_subfolder) if dest_subfolder else dest_root
    if dest_dir is None:
        return web.json_response({"error": "Invalid destination"}, status=400)
    os.makedirs(dest_dir, exist_ok=True)

    import shutil
    moved = 0
    skipped = 0
    renamed = []
    errors = []
    for item in files:
        subfolder = item.get("subfolder", "")
        name = item.get("name", "")
        if not name:
            continue
        src_path = _safe_path(src_root, subfolder, name) if subfolder else _safe_path(src_root, name)
        if src_path is None or not os.path.exists(src_path):
            errors.append(f"Not found: {name}")
            continue
        dst_path = os.path.join(dest_dir, name)
        try:
            if os.path.normcase(os.path.abspath(src_path)) == os.path.normcase(os.path.abspath(dst_path)):
                skipped += 1
                continue
        except Exception:
            pass
        if os.path.exists(dst_path):
            if conflict == "skip":
                skipped += 1
                continue
            elif conflict == "rename":
                new_name = _auto_rename(dest_dir, name)
                dst_path = os.path.join(dest_dir, new_name)
                renamed.append({"original": name, "renamed": new_name})
            elif conflict == "overwrite":
                # Folder + Folder → recursive merge (non-destructive)
                if os.path.isdir(src_path) and os.path.isdir(dst_path):
                    m, r, e = _merge_dirs(src_path, dst_path)
                    if m > 0:
                        moved += 1
                    renamed.extend(r)
                    errors.extend(e)
                    continue
                # File → overwrite
                try:
                    os.remove(dst_path)
                except Exception as e:
                    errors.append(f"Cannot overwrite {name}: {e}")
                    continue
        try:
            shutil.move(src_path, dst_path)
            moved += 1
        except Exception as e:
            errors.append(f"Error moving {name}: {e}")
    return web.json_response({
        "moved": moved, "skipped": skipped,
        "renamed": renamed, "errors": errors,
    })


# -- Mkdir --

@_routes.post("/drawer/fs/mkdir")
async def fs_mkdir(request):
    """POST /drawer/fs/mkdir
    Body: { root: "output", subfolder: "path/to/parent", name: "NewFolder" }
    Creates a new directory inside root/subfolder.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    root_name = body.get("root", "output").strip().lower()
    if root_name == "temp":
        return web.json_response({"error": "Folder creation in Temp is not allowed"}, status=403)
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    root = getter()
    subfolder = body.get("subfolder", "").strip()
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "Folder name required"}, status=400)
    # Reject names with path separators
    if "/" in name or "\\" in name or name in (".", ".."):
        return web.json_response({"error": "Invalid folder name"}, status=400)

    parent = _safe_path(root, subfolder) if subfolder else root
    if parent is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    target = os.path.join(parent, name)
    safe = _safe_path(root, subfolder, name) if subfolder else _safe_path(root, name)
    if safe is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    if os.path.exists(target):
        return web.json_response({"error": "Already exists"}, status=409)
    try:
        os.makedirs(target)
        return web.json_response({"ok": True, "path": (subfolder + "/" + name).strip("/")})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# -- Rename --

@_routes.post("/drawer/fs/rename")
async def fs_rename(request):
    """POST /drawer/fs/rename
    Body: { root: "output", subfolder: "2026-03", oldName: "old.png", newName: "new.png" }
    Renames a file or folder. Rejects if newName already exists.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    root_name = body.get("root", "output").strip().lower()
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    root = getter()
    subfolder = body.get("subfolder", "").strip()
    old_name = body.get("oldName", "").strip()
    new_name = body.get("newName", "").strip()
    if not old_name or not new_name:
        return web.json_response({"error": "Both oldName and newName required"}, status=400)
    if "/" in new_name or "\\" in new_name or new_name in (".", ".."):
        return web.json_response({"error": "Invalid name"}, status=400)
    if old_name == new_name:
        return web.json_response({"ok": True, "renamed": False})

    parent = _safe_path(root, subfolder) if subfolder else root
    if parent is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    src = os.path.join(parent, old_name)
    dst = os.path.join(parent, new_name)
    # Safety check
    safe_src = _safe_path(root, subfolder, old_name) if subfolder else _safe_path(root, old_name)
    safe_dst = _safe_path(root, subfolder, new_name) if subfolder else _safe_path(root, new_name)
    if safe_src is None or safe_dst is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    if not os.path.exists(src):
        return web.json_response({"error": "Source not found"}, status=404)
    if os.path.exists(dst):
        return web.json_response({"error": "Name already exists"}, status=409)
    try:
        os.rename(src, dst)
        return web.json_response({"ok": True, "renamed": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  XYZ Plot — Grid Image Save
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import time
import re
import base64
from io import BytesIO

try:
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False


def _expand_date_format(text: str) -> str:
    """Expand %date:FORMAT% patterns like %date:yyyy-MM-dd%."""
    def _replace(m):
        fmt = m.group(1)
        now = time.localtime()
        fmt = fmt.replace("yyyy", str(now.tm_year))
        fmt = fmt.replace("MM", str(now.tm_mon).zfill(2))
        fmt = fmt.replace("dd", str(now.tm_mday).zfill(2))
        fmt = fmt.replace("HH", str(now.tm_hour).zfill(2))
        fmt = fmt.replace("hh", str(now.tm_hour).zfill(2))  # accept lowercase too
        fmt = fmt.replace("mm", str(now.tm_min).zfill(2))
        fmt = fmt.replace("ss", str(now.tm_sec).zfill(2))
        return fmt
    return re.sub(r"%date:([^%]+)%", _replace, text)


def _expand_vars(text: str) -> str:
    """Expand ComfyUI-style %var% patterns."""
    now = time.localtime()
    text = text.replace("%year%", str(now.tm_year))
    text = text.replace("%month%", str(now.tm_mon).zfill(2))
    text = text.replace("%day%", str(now.tm_mday).zfill(2))
    text = text.replace("%hour%", str(now.tm_hour).zfill(2))
    text = text.replace("%minute%", str(now.tm_min).zfill(2))
    text = text.replace("%second%", str(now.tm_sec).zfill(2))
    return _expand_date_format(text)


@_routes.post("/comfy-drawer/save_grid")
async def _save_grid(request):
    """Save XYZ Plot composite grid image to the output directory.

    Expects JSON body:
      - image_data: base64-encoded image data (data URL or raw base64)
      - filename_prefix: filename pattern with optional %date:...% vars and slashes
      - format: "png" | "jpg" | "webp"
      - quality: int (for jpg/webp, default 95)
      - save_metadata: bool
      - workflow_json: optional workflow JSON string (for metadata embedding)
    """
    if not _HAS_PIL:
        return web.json_response({"error": "PIL/Pillow not installed"}, status=500)

    try:
        # Read body manually to avoid aiohttp's default client_max_size (1MB)
        raw = await request.content.read()
        data = json.loads(raw)
    except Exception as e:
        logger.warning(f"save_grid: JSON parse error: {e}")
        return web.json_response({"error": f"Invalid JSON: {e}"}, status=400)

    image_b64 = data.get("image_data", "")
    filename_prefix = data.get("filename_prefix", "ComfyDrawer/xyz_plot")
    fmt = data.get("format", "png").lower()
    quality = data.get("quality", 95)
    save_metadata = data.get("save_metadata", True)
    workflow_json = data.get("workflow_json", None)

    # Strip data URL header if present
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(image_b64)
        img = Image.open(BytesIO(image_bytes))
    except Exception as e:
        return web.json_response({"error": f"Invalid image data: {e}"}, status=400)

    # Expand variables in prefix
    filename_prefix = _expand_vars(filename_prefix)

    # Resolve output path
    output_dir = folder_paths.get_output_directory()
    subfolder = os.path.dirname(os.path.normpath(filename_prefix))
    basename = os.path.basename(os.path.normpath(filename_prefix))
    full_folder = os.path.join(output_dir, subfolder)

    # Security: prevent path traversal
    if os.path.commonpath((output_dir, os.path.abspath(full_folder))) != output_dir:
        return web.json_response({"error": "Path traversal not allowed"}, status=403)

    os.makedirs(full_folder, exist_ok=True)

    # Auto-increment counter
    existing = os.listdir(full_folder) if os.path.isdir(full_folder) else []
    counter = 1
    counter_re = re.compile(rf"^{re.escape(basename)}_(\d+)\.")
    for f in existing:
        m = counter_re.match(f)
        if m:
            counter = max(counter, int(m.group(1)) + 1)

    # Determine extension and save options
    if fmt in ("jpg", "jpeg"):
        ext = ".jpg"
        if img.mode == "RGBA":
            img = img.convert("RGB")
        save_kwargs = {"quality": quality}
    elif fmt == "webp":
        ext = ".webp"
        save_kwargs = {"quality": quality}
    else:
        ext = ".png"
        save_kwargs = {"compress_level": 4}

    filename = f"{basename}_{counter:05d}{ext}"
    filepath = os.path.join(full_folder, filename)

    # Handle metadata
    if save_metadata and ext == ".png":
        metadata = PngInfo()
        if workflow_json:
            try:
                wf = json.loads(workflow_json) if isinstance(workflow_json, str) else workflow_json
                metadata.add_text("workflow", json.dumps(wf))
            except Exception:
                pass
        metadata.add_text("comfy-drawer", "xyz_plot_grid")
        save_kwargs["pnginfo"] = metadata
    elif save_metadata and ext in (".jpg", ".webp") and workflow_json:
        # Embed workflow using ComfyUI's native WebP metadata format:
        #   EXIF 0x010F (Make) = "workflow:JSON"
        #   EXIF 0x0110 (Model) = "prompt:JSON"  (if available)
        try:
            wf_obj = json.loads(workflow_json) if isinstance(workflow_json, str) else workflow_json
            exif_data = img.getexif()
            exif_data[0x010F] = "workflow:{}".format(json.dumps(wf_obj))
            save_kwargs["exif"] = exif_data.tobytes()
        except Exception as e:
            logger.warning(f"EXIF embedding failed: {e}")

    img.save(filepath, **save_kwargs)

    logger.info(f"Saved XYZ grid: {filepath}")

    return web.json_response({
        "filename": filename,
        "subfolder": subfolder,
        "type": "output",
    })


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  ModelViewer API — Model thumbnails + extra_model_paths.yaml management
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import yaml as _yaml
import shutil as _shutil

# Sidecar preview extensions searched for a model thumbnail, in priority order.
_THUMB_PREVIEW_EXTS = [
    '.preview.png', '.preview.jpeg', '.preview.jpg', '.preview.webp',
    '.preview.mp4', '.preview.webm',
]
_THUMB_PLAIN_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm']
_THUMB_ALL_EXTS = _THUMB_PREVIEW_EXTS + _THUMB_PLAIN_EXTS
_THUMB_VIDEO_EXTS = {'.mp4', '.webm'}

# MIME types for thumb responses
_THUMB_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

def _find_preview_path(model_path):
    """Find the first existing preview sidecar for a model file."""
    base_no_ext = os.path.splitext(model_path)[0]
    for ext in _THUMB_PREVIEW_EXTS:
        candidate = base_no_ext + ext
        if os.path.isfile(candidate):
            return candidate
    for ext in _THUMB_PLAIN_EXTS:
        candidate = base_no_ext + ext
        if os.path.isfile(candidate):
            return candidate
    return None


@_routes.get("/drawer/model-thumb/{category}")
async def model_thumbnail(request):
    """Serve sidecar preview image for a model file.

    Search order:
      1. {model_path}.preview.png
      2. {model_path_without_ext}.png
      3. {model_path_without_ext}.jpg
      4. {model_path_without_ext}.jpeg
      5. {model_path_without_ext}.webp
    Falls through to 404 if none found.
    """
    category = request.match_info["category"]
    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    # Resolve model to absolute path via folder_paths (covers extra paths)
    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.Response(status=404)

    base_no_ext = os.path.splitext(model_path)[0]

    preview = _find_preview_path(model_path)
    if preview:
        real_ext = os.path.splitext(preview)[1].lower()
        content_type = _THUMB_MIME.get(real_ext, 'application/octet-stream')
        # Use mtime as ETag for conditional requests (304 Not Modified)
        mtime = os.path.getmtime(preview)
        etag = f'"{int(mtime)}-{os.path.getsize(preview)}"'
        return web.FileResponse(preview, headers={
            'Content-Type': content_type,
            'Cache-Control': 'no-cache',
            'ETag': etag,
        })

    return web.Response(status=404)


@_routes.get("/drawer/model-info/{category}")
async def model_info(request):
    """Return metadata for a model file.

    Response JSON:
      {
        "filename": "SDXL/foo.safetensors",
        "fullPath": "G:/ComfyHub2/models/loras/SDXL/foo.safetensors",
        "sizeBytes": 123456789,
        "modifiedAt": "2024-01-15T10:30:00",
        "civitai": { ... } | null     // contents of .civitai.info if present
      }
    """
    category = request.match_info["category"]
    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    # Basic file stats
    try:
        stat = os.stat(model_path)
        size_bytes = stat.st_size
        modified_at = datetime.datetime.fromtimestamp(stat.st_mtime).isoformat()
    except OSError:
        size_bytes = None
        modified_at = None

    # CivitAI sidecar: {model_path}.civitai.info
    civitai_data = None
    civitai_path = model_path + ".civitai.info"
    if os.path.isfile(civitai_path):
        try:
            with open(civitai_path, "r", encoding="utf-8") as f:
                civitai_data = json.load(f)
        except Exception:
            pass  # malformed JSON, skip

    # Custom Drawer sidecar: {model_path}.drawer.json
    drawer_data = None
    drawer_path = model_path + ".drawer.json"
    if os.path.isfile(drawer_path):
        try:
            with open(drawer_path, "r", encoding="utf-8") as f:
                drawer_data = json.load(f)
        except Exception:
            pass

    preview_file = _find_preview_path(model_path)
    return web.json_response({
        "filename": filename,
        "fullPath": model_path.replace("\\", "/"),
        "sizeBytes": size_bytes,
        "modifiedAt": modified_at,
        "civitai": civitai_data,
        "drawer": drawer_data,
        "hasPreview": preview_file is not None,
        "previewType": (
            "video" if (preview_file and
                       os.path.splitext(preview_file)[1].lower() in _THUMB_VIDEO_EXTS)
            else "image"
        ),
    })


@_routes.post("/drawer/model-trigger-words/{category}")
async def save_trigger_words(request):
    """Save custom trigger words for a model.

    Expects JSON body: { "filename": "...", "triggerWords": ["word1", "word2"] }
    Saves to {model_path}.drawer.json alongside the model file.
    """
    category = request.match_info["category"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    filename = body.get("filename", "")
    trigger_words = body.get("triggerWords", [])
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    drawer_path = model_path + ".drawer.json"

    # Read existing .drawer.json or start fresh
    drawer_data = {}
    if os.path.isfile(drawer_path):
        try:
            with open(drawer_path, "r", encoding="utf-8") as f:
                drawer_data = json.load(f)
        except Exception:
            pass

    # Update trigger words
    drawer_data["triggerWords"] = [w for w in trigger_words if isinstance(w, str) and w.strip()]

    # Write back
    try:
        with open(drawer_path, "w", encoding="utf-8") as f:
            json.dump(drawer_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True, "triggerWords": drawer_data["triggerWords"]})


@_routes.post("/drawer/model-comment/{category}")
async def save_model_comment(request):
    """Save a user comment for a model.

    Expects JSON body: { "filename": "...", "comment": "..." }
    Saves to {model_path}.drawer.json alongside the model file.
    """
    category = request.match_info["category"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    filename = body.get("filename", "")
    comment = body.get("comment", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    drawer_path = model_path + ".drawer.json"

    # Read existing .drawer.json or start fresh
    drawer_data = {}
    if os.path.isfile(drawer_path):
        try:
            with open(drawer_path, "r", encoding="utf-8") as f:
                drawer_data = json.load(f)
        except Exception:
            pass

    # Update comment (empty string = remove)
    if comment.strip():
        drawer_data["comment"] = comment.strip()
    else:
        drawer_data.pop("comment", None)

    # Write back
    try:
        with open(drawer_path, "w", encoding="utf-8") as f:
            json.dump(drawer_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True})


@_routes.delete("/drawer/model-preview/{category}")
async def delete_model_preview(request):
    """Delete the preview image for a model file.

    Query param: ?filename=SDXL/foo.safetensors
    """
    category = request.match_info["category"]
    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    preview = _find_preview_path(model_path)
    if not preview:
        return web.json_response({"error": "no preview"}, status=404)

    try:
        os.remove(preview)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True})


@_routes.post("/drawer/model-preview/{category}")
async def upload_model_preview(request):
    """Upload a custom preview image for a model file.

    Expects multipart form: filename (text) + image (file)
    Saves as {model_base}.preview.{ext}
    """
    category = request.match_info["category"]

    reader = await request.multipart()
    filename = None
    image_data = None
    image_ext = '.png'

    async for part in reader:
        if part.name == 'filename':
            filename = (await part.text()).strip()
        elif part.name == 'image':
            image_data = await part.read()
            ct = part.headers.get('Content-Type', '')
            if 'jpeg' in ct or 'jpg' in ct:
                image_ext = '.jpeg'
            elif 'webp' in ct:
                image_ext = '.webp'
            elif 'png' in ct:
                image_ext = '.png'

    if not filename or not image_data:
        return web.json_response({"error": "filename and image required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    base_no_ext = os.path.splitext(model_path)[0]
    preview_path = base_no_ext + '.preview' + image_ext

    try:
        with open(preview_path, 'wb') as f:
            f.write(image_data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True, "path": preview_path.replace("\\", "/")})


@_routes.delete("/drawer/model/{category}")
async def delete_model(request):
    """Delete a model file and all its sidecar files.

    Query: ?filename=SDXL/foo.safetensors
    Removes: foo.safetensors, foo.safetensors.civitai.info, foo.safetensors.drawer.json,
             foo.preview.*, foo.png, foo.jpg, etc.
    """
    category = request.match_info["category"]
    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path or not os.path.isfile(model_path):
        return web.json_response({"error": "not found"}, status=404)

    deleted = []
    errors = []

    # Delete the model file itself
    try:
        os.remove(model_path)
        deleted.append(os.path.basename(model_path))
    except Exception as e:
        return web.json_response({"error": f"Failed to delete model: {e}"}, status=500)

    # Delete sidecar files
    base_no_ext = os.path.splitext(model_path)[0]
    sidecar_patterns = [
        model_path + ".civitai.info",
        model_path + ".drawer.json",
    ]
    # Preview files: foo.preview.*, foo.png, foo.jpg, foo.jpeg, foo.webp
    model_dir = os.path.dirname(model_path)
    model_stem = os.path.splitext(os.path.basename(model_path))[0]
    for f in os.listdir(model_dir):
        f_lower = f.lower()
        f_stem = os.path.splitext(f)[0]
        # Match foo.preview.* or foo.png/jpg/jpeg/webp
        if f_stem.lower() == model_stem.lower() and f_lower.endswith(('.png', '.jpg', '.jpeg', '.webp')):
            sidecar_patterns.append(os.path.join(model_dir, f))
        elif f_lower.startswith(model_stem.lower() + '.preview.'):
            sidecar_patterns.append(os.path.join(model_dir, f))
        elif f == os.path.basename(model_path) + '.civitai.info':
            sidecar_patterns.append(os.path.join(model_dir, f))
        elif f == os.path.basename(model_path) + '.drawer.json':
            sidecar_patterns.append(os.path.join(model_dir, f))

    seen = set()
    for path in sidecar_patterns:
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        try:
            os.remove(path)
            deleted.append(os.path.basename(path))
        except Exception as e:
            errors.append(f"{os.path.basename(path)}: {e}")

    # Invalidate folder_paths cache so ComfyUI picks up the change
    try:
        folder_paths.invalidate_cache(category)
    except Exception:
        pass  # Some ComfyUI versions may not have this method

    return web.json_response({
        "ok": True,
        "deleted": deleted,
        "errors": errors,
    })


@_routes.post("/drawer/model-preview-from-output/{category}")
async def set_preview_from_output(request):
    """Copy an image from the output folder as the model's custom preview.

    JSON body: { "filename": "SDXL/foo.safetensors", "image": "subfolder/image.png" }
    """
    import shutil

    category = request.match_info["category"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    filename = body.get("filename", "")
    image_value = body.get("image", "")
    if not filename or not image_value:
        return web.json_response({"error": "filename and image required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "model not found"}, status=404)

    # Resolve image path in output directory
    output_dir = folder_paths.get_output_directory()
    image_path = os.path.join(output_dir, image_value.replace("/", os.sep))
    if not os.path.isfile(image_path):
        return web.json_response({"error": "image not found"}, status=404)

    # Determine extension
    image_ext = os.path.splitext(image_path)[1].lower()
    if image_ext not in ('.png', '.jpg', '.jpeg', '.webp'):
        return web.json_response({"error": "unsupported image format"}, status=400)

    base_no_ext = os.path.splitext(model_path)[0]
    preview_path = base_no_ext + ".preview" + image_ext

    try:
        shutil.copy2(image_path, preview_path)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True, "path": preview_path.replace("\\", "/")})


@_routes.post("/drawer/model-folder/{category}")
async def create_model_folder(request):
    """Create a subfolder within a model category directory.

    JSON body: { "subfolder": "SDXL", "name": "NewFolder" }
    Creates the folder relative to the first folder path for that category.
    """
    category = request.match_info["category"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    subfolder = body.get("subfolder", "")
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    # Validate name
    if '/' in name or '\\' in name or '..' in name:
        return web.json_response({"error": "invalid folder name"}, status=400)

    # Get the first base folder for this category
    paths = folder_paths.get_folder_paths(category)
    if not paths:
        return web.json_response({"error": "category not found"}, status=404)

    base_dir = os.path.realpath(paths[0])
    target_dir = os.path.realpath(
        os.path.join(base_dir, subfolder, name) if subfolder else os.path.join(base_dir, name)
    )

    # Security: prevent path traversal via subfolder
    if not target_dir.startswith(base_dir + os.sep) and target_dir != base_dir:
        return web.json_response({"error": "invalid path"}, status=400)

    if os.path.exists(target_dir):
        return web.json_response({"error": "already exists"}, status=409)

    try:
        os.makedirs(target_dir, exist_ok=True)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True, "path": target_dir.replace("\\", "/")})

@_routes.post("/drawer/civitai-sync/{category}")
async def civitai_sync(request):
    """Fetch metadata from CivitAI by SHA256 hash.

    Uses cached hash from .drawer.json when available to skip re-computation.
    Tries AutoV2 (first 10 chars of SHA256) first, then full SHA256 as fallback.

    Expects JSON body: { "filename": "SDXL/foo.safetensors", "force": false }
    Saves the CivitAI response as {model_path}.civitai.info.
    """
    import hashlib
    import aiohttp as _aiohttp
    import asyncio

    category = request.match_info["category"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    filename = body.get("filename", "")
    force = body.get("force", False)
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    civitai_path = model_path + ".civitai.info"
    drawer_path = model_path + ".drawer.json"

    # If .civitai.info already exists and not forced, return cached
    # But still attempt to download preview if it's missing
    if not force and os.path.isfile(civitai_path):
        try:
            with open(civitai_path, "r", encoding="utf-8") as f:
                existing = json.load(f)

            # Check if preview is missing — download if so
            has_preview = _find_preview_path(model_path) is not None
            if not has_preview:
                import aiohttp as _aiohttp
                images = existing.get("images", [])
                if images:
                    first_img = images[0]
                    img_url = first_img.get("url", "")
                    img_type = first_img.get("type", "image")
                    if img_url:
                        if img_type == "video" or img_url.endswith(".mp4"):
                            ext = ".mp4"
                        elif ".png" in img_url:
                            ext = ".png"
                        elif ".webp" in img_url:
                            ext = ".webp"
                        else:
                            ext = ".jpeg"
                        base_no_ext = os.path.splitext(model_path)[0]
                        preview_path = base_no_ext + ".preview" + ext
                        try:
                            async with _aiohttp.ClientSession() as session:
                                async with session.get(img_url, timeout=_aiohttp.ClientTimeout(total=30)) as img_resp:
                                    if img_resp.status == 200:
                                        img_data = await img_resp.read()
                                        with open(preview_path, "wb") as pf:
                                            pf.write(img_data)
                        except Exception as e:
                            logger.warning(f"[Drawer] Failed to download preview (cached path): {e}")

            return web.json_response({"ok": True, "civitai": existing, "cached": True})
        except Exception:
            pass  # Re-fetch if malformed

    # --- Step 1: Get or compute SHA256 ---
    # Priority: .drawer.json cache → safetensors header metadata → full SHA256

    # 1a. Check .drawer.json for cached hash
    drawer_data = {}
    cached_hash = None
    if os.path.isfile(drawer_path):
        try:
            with open(drawer_path, "r", encoding="utf-8") as f:
                drawer_data = json.load(f)
            cached_hash = drawer_data.get("sha256")
        except Exception:
            pass

    if cached_hash:
        sha256_hash = cached_hash
    else:
        sha256_hash = None

        # 1b. Try to extract hash from safetensors header metadata (near-zero cost)
        # Note: sd-scripts' sshs_model_hash is BLAKE2b of tensor data, NOT file SHA256.
        # Only modelspec.hash_sha256 stores the actual file SHA256.
        if model_path.endswith(".safetensors"):
            try:
                import struct as _struct
                with open(model_path, "rb") as hf:
                    length_of_header = _struct.unpack('<Q', hf.read(8))[0]
                    if length_of_header <= 8 * 1024 * 1024:  # sanity cap: 8MB
                        header_bytes = hf.read(length_of_header)
                        header_json = json.loads(header_bytes)
                        meta = header_json.get("__metadata__", {})
                        # ModelSpec standard: file-level SHA256
                        for key in ("modelspec.hash_sha256",):
                            val = meta.get(key, "")
                            if val:
                                # Some tools prefix with "sha256:" or "0x"
                                clean = val.replace("sha256:", "").replace("0x", "").strip()
                                if len(clean) >= 64:
                                    sha256_hash = clean[:64].upper()
                                    logger.info(f"[Drawer] Hash from safetensors header ({key}): {sha256_hash[:10]}...")
                                    break
            except Exception as e:
                logger.debug(f"[Drawer] safetensors header read failed: {e}")

        # 1c. Fallback: full SHA256 computation (expensive for large files)
        if not sha256_hash:
            def _compute_sha256(path):
                h = hashlib.sha256()
                with open(path, "rb") as f:
                    while True:
                        chunk = f.read(1 << 20)  # 1MB
                        if not chunk:
                            break
                        h.update(chunk)
                return h.hexdigest().upper()

            loop = asyncio.get_event_loop()
            try:
                sha256_hash = await loop.run_in_executor(None, _compute_sha256, model_path)
            except Exception as e:
                return web.json_response({"error": f"hash error: {e}"}, status=500)

        # Cache the hash in .drawer.json for future use
        drawer_data["sha256"] = sha256_hash
        try:
            with open(drawer_path, "w", encoding="utf-8") as f:
                json.dump(drawer_data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # --- Step 2: Query CivitAI API ---
    async def _query_civitai(hash_value):
        url = f"https://civitai.red/api/v1/model-versions/by-hash/{hash_value}"
        async with _aiohttp.ClientSession() as session:
            async with session.get(url, timeout=_aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    return await resp.json()
                return None

    # Try AutoV2 first (first 10 chars — faster API lookup)
    civitai_data = None
    autov2 = sha256_hash[:10]

    try:
        civitai_data = await _query_civitai(autov2)
    except Exception:
        pass

    # Fallback to full SHA256
    if not civitai_data:
        try:
            civitai_data = await _query_civitai(sha256_hash)
        except asyncio.TimeoutError:
            return web.json_response({
                "ok": False,
                "error": "timeout",
                "message": "CivitAI APIへの接続がタイムアウトしました",
            })
        except Exception as e:
            return web.json_response({
                "ok": False,
                "error": "network_error",
                "message": f"ネットワークエラー: {e}",
            })

    if not civitai_data:
        return web.json_response({
            "ok": False,
            "error": "not_found",
            "message": "CivitAIにこのモデルの情報が見つかりませんでした",
        })

    # --- Step 3: Save .civitai.info ---
    try:
        with open(civitai_path, "w", encoding="utf-8") as f:
            json.dump(civitai_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning(f"[Drawer] Failed to save .civitai.info: {e}")

    # --- Step 4: Download preview image if available ---
    images = civitai_data.get("images", [])
    if images:
        first_img = images[0]
        img_url = first_img.get("url", "")
        img_type = first_img.get("type", "image")  # CivitAI: "image" or "video"
        if img_url:
            if img_type == "video" or img_url.endswith(".mp4"):
                ext = ".mp4"
            elif ".png" in img_url:
                ext = ".png"
            elif ".webp" in img_url:
                ext = ".webp"
            else:
                ext = ".jpeg"
            base_no_ext = os.path.splitext(model_path)[0]
            preview_path = base_no_ext + ".preview" + ext
            if not os.path.isfile(preview_path):
                try:
                    async with _aiohttp.ClientSession() as session:
                        async with session.get(img_url, timeout=_aiohttp.ClientTimeout(total=30)) as img_resp:
                            if img_resp.status == 200:
                                img_data = await img_resp.read()
                                with open(preview_path, "wb") as pf:
                                    pf.write(img_data)
                except Exception as e:
                    logger.warning(f"[Drawer] Failed to download preview: {e}")

    return web.json_response({
        "ok": True,
        "civitai": civitai_data,
        "cached": False,
        "hashCached": cached_hash is not None,
    })


@_routes.get("/drawer/civitai-batch-sync/{category}")
async def civitai_batch_sync(request):
    """Batch-sync CivitAI metadata for all models in a category.

    Uses Server-Sent Events (SSE) to stream progress.
    Query params: ?force=false  (if true, re-fetch even if .civitai.info exists)

    SSE event types:
      start     { total, skipped }
      progress  { index, total, filename, status, message }
      complete  { total, synced, skipped, failed }
    """
    import hashlib
    import aiohttp as _aiohttp
    import asyncio

    category = request.match_info["category"]
    force = request.query.get("force", "false").lower() == "true"

    # SSE response setup
    response = web.StreamResponse()
    response.content_type = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    await response.prepare(request)

    async def send_event(data):
        line = f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
        await response.write(line.encode("utf-8"))

    # Get all model files in this category
    try:
        all_models = folder_paths.get_filename_list(category)
    except Exception:
        await send_event({"type": "complete", "total": 0, "synced": 0, "skipped": 0, "failed": 0, "error": "Invalid category"})
        return response

    # Pre-scan: count how many already have .civitai.info
    to_process = []
    pre_skipped = 0
    for filename in all_models:
        model_path = folder_paths.get_full_path(category, filename)
        if not model_path:
            continue
        civitai_path = model_path + ".civitai.info"
        if not force and os.path.isfile(civitai_path):
            pre_skipped += 1
        else:
            to_process.append((filename, model_path))

    total = len(to_process)
    await send_event({"type": "start", "total": total, "skipped": pre_skipped, "totalModels": len(all_models)})

    if total == 0:
        await send_event({"type": "complete", "total": 0, "synced": 0, "skipped": pre_skipped, "failed": 0})
        return response

    synced = 0
    failed = 0

    async def _query_civitai(session, hash_value):
        url = f"https://civitai.red/api/v1/model-versions/by-hash/{hash_value}"
        async with session.get(url, timeout=_aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status == 200:
                return await resp.json()
            return None

    async with _aiohttp.ClientSession() as session:
        for idx, (filename, model_path) in enumerate(to_process):
            civitai_path = model_path + ".civitai.info"
            drawer_path = model_path + ".drawer.json"
            short_name = os.path.basename(filename)

            try:
                # --- Hash resolution chain ---
                drawer_data = {}
                sha256_hash = None

                # 1. Cached in .drawer.json
                if os.path.isfile(drawer_path):
                    try:
                        with open(drawer_path, "r", encoding="utf-8") as f:
                            drawer_data = json.load(f)
                        sha256_hash = drawer_data.get("sha256")
                    except Exception:
                        pass

                # 2. Safetensors header (modelspec.hash_sha256)
                if not sha256_hash and model_path.endswith(".safetensors"):
                    try:
                        import struct as _struct
                        with open(model_path, "rb") as hf:
                            length_of_header = _struct.unpack('<Q', hf.read(8))[0]
                            if length_of_header <= 8 * 1024 * 1024:
                                header_bytes = hf.read(length_of_header)
                                header_json = json.loads(header_bytes)
                                meta = header_json.get("__metadata__", {})
                                val = meta.get("modelspec.hash_sha256", "")
                                if val:
                                    clean = val.replace("sha256:", "").replace("0x", "").strip()
                                    if len(clean) >= 64:
                                        sha256_hash = clean[:64].upper()
                    except Exception:
                        pass

                # 3. Full SHA256 (expensive)
                hash_source = "cache" if sha256_hash else "compute"
                if not sha256_hash:
                    await send_event({
                        "type": "progress", "index": idx, "total": total,
                        "filename": short_name, "status": "hashing",
                        "message": f"Computing SHA256..."
                    })

                    def _compute_sha256(path):
                        h = hashlib.sha256()
                        with open(path, "rb") as f:
                            while True:
                                chunk = f.read(1 << 20)
                                if not chunk:
                                    break
                                h.update(chunk)
                        return h.hexdigest().upper()

                    loop = asyncio.get_event_loop()
                    sha256_hash = await loop.run_in_executor(None, _compute_sha256, model_path)

                # Cache hash
                if "sha256" not in drawer_data:
                    drawer_data["sha256"] = sha256_hash
                    try:
                        with open(drawer_path, "w", encoding="utf-8") as f:
                            json.dump(drawer_data, f, ensure_ascii=False, indent=2)
                    except Exception:
                        pass

                # --- Query CivitAI ---
                await send_event({
                    "type": "progress", "index": idx, "total": total,
                    "filename": short_name, "status": "querying",
                    "message": f"Querying CivitAI..."
                })

                civitai_data = None
                autov2 = sha256_hash[:10]
                try:
                    civitai_data = await _query_civitai(session, autov2)
                except Exception:
                    pass

                if not civitai_data:
                    try:
                        civitai_data = await _query_civitai(session, sha256_hash)
                    except Exception:
                        pass

                if not civitai_data:
                    failed += 1
                    await send_event({
                        "type": "progress", "index": idx, "total": total,
                        "filename": short_name, "status": "not_found",
                        "message": "Not found on CivitAI"
                    })
                    continue

                # Save .civitai.info
                try:
                    with open(civitai_path, "w", encoding="utf-8") as f:
                        json.dump(civitai_data, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass

                # Download preview if missing
                if not _find_preview_path(model_path):
                    images = civitai_data.get("images", [])
                    if images:
                        first_img = images[0]
                        img_url = first_img.get("url", "")
                        img_type = first_img.get("type", "image")
                        if img_url:
                            ext = ".mp4" if (img_type == "video" or img_url.endswith(".mp4")) \
                                else ".png" if ".png" in img_url \
                                else ".webp" if ".webp" in img_url \
                                else ".jpeg"
                            base_no_ext = os.path.splitext(model_path)[0]
                            preview_path = base_no_ext + ".preview" + ext
                            try:
                                async with session.get(img_url, timeout=_aiohttp.ClientTimeout(total=30)) as img_resp:
                                    if img_resp.status == 200:
                                        img_data = await img_resp.read()
                                        with open(preview_path, "wb") as pf:
                                            pf.write(img_data)
                            except Exception:
                                pass

                synced += 1
                model_name = civitai_data.get("model", {}).get("name", short_name)
                await send_event({
                    "type": "progress", "index": idx, "total": total,
                    "filename": short_name, "status": "synced",
                    "message": f"✓ {model_name}"
                })

                # Rate limiting: small delay between API calls
                await asyncio.sleep(0.3)

            except Exception as e:
                failed += 1
                await send_event({
                    "type": "progress", "index": idx, "total": total,
                    "filename": short_name, "status": "error",
                    "message": str(e)[:100]
                })

    await send_event({
        "type": "complete",
        "total": total,
        "synced": synced,
        "skipped": pre_skipped,
        "failed": failed,
    })

    return response


def _extra_model_paths_yaml():
    """Locate extra_model_paths.yaml (same logic as main.py)."""
    comfy_root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))  # up from custom_nodes/ComfyUI-Drawer/
    return os.path.join(comfy_root, "extra_model_paths.yaml")


@_routes.get("/drawer/extra-paths")
async def get_extra_paths(request):
    """Read extra_model_paths.yaml and return as JSON."""
    yaml_path = _extra_model_paths_yaml()
    if not os.path.isfile(yaml_path):
        return web.json_response({
            "yamlPath": yaml_path,
            "profiles": [],
        })

    try:
        with open(yaml_path, "r", encoding="utf-8") as f:
            config = _yaml.safe_load(f) or {}
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    profiles = []
    for name, conf in config.items():
        if not isinstance(conf, dict):
            continue
        base_path = conf.get("base_path", "")
        is_default = conf.get("is_default", False)
        entries = []
        for k, v in conf.items():
            if k in ("base_path", "is_default"):
                continue
            # Values can be multiline (pipe-separated in YAML)
            if isinstance(v, str):
                for line in v.split("\n"):
                    line = line.strip()
                    if line:
                        entries.append({"category": k, "path": line})
            else:
                entries.append({"category": k, "path": str(v)})
        profiles.append({
            "name": name,
            "basePath": base_path,
            "isDefault": bool(is_default),
            "entries": entries,
        })

    return web.json_response({
        "yamlPath": yaml_path,
        "profiles": profiles,
    })


@_routes.post("/drawer/extra-paths")
async def save_extra_paths(request):
    """Save extra_model_paths.yaml from JSON.
    Creates a .yaml.bak backup before overwriting.
    Body: { "profiles": [...] }
    """
    data = await request.json()
    profiles = data.get("profiles", [])

    yaml_path = _extra_model_paths_yaml()

    # Build YAML-compatible dict
    config = {}
    for prof in profiles:
        name = prof.get("name", "").strip()
        if not name:
            continue
        section = {}
        base = prof.get("basePath", "").strip()
        if base:
            section["base_path"] = base
        if prof.get("isDefault"):
            section["is_default"] = True
        # Group entries by category — if multiple paths per category, use newline
        cat_paths = {}
        for entry in prof.get("entries", []):
            cat = entry.get("category", "").strip()
            path = entry.get("path", "").strip()
            if cat and path:
                cat_paths.setdefault(cat, []).append(path)
        for cat, paths in cat_paths.items():
            section[cat] = "\n".join(paths) if len(paths) > 1 else paths[0]
        config[name] = section

    # Backup existing file
    if os.path.isfile(yaml_path):
        bak = yaml_path + ".bak"
        try:
            _shutil.copy2(yaml_path, bak)
        except Exception as e:
            logger.warning(f"[ModelViewer] Backup failed: {e}")

    # Write YAML
    try:
        with open(yaml_path, "w", encoding="utf-8") as f:
            _yaml.safe_dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    logger.info(f"[ModelViewer] Saved extra_model_paths.yaml ({len(profiles)} profiles)")
    return web.json_response({"ok": True})


@_routes.post("/drawer/clear-cache")
async def clear_drawer_cache(request):
    """Clear Drawer's own cache files:
    - .thumbs/ directories inside each allowed root (output, input)
    - Search index SQLite DB (drawer_index.db)

    Returns: { "ok": true, "deleted": <count>, "freedBytes": <bytes> }
    """
    deleted = 0
    freed_bytes = 0
    errors = []

    # 1. Remove .thumbs/ cache directories from each FS root
    for root_name, root_fn in _ALLOWED_ROOTS.items():
        try:
            root_dir = root_fn()
            thumb_dir = os.path.join(root_dir, ".thumbs")
            if os.path.isdir(thumb_dir):
                for dirpath, _dirnames, filenames in os.walk(thumb_dir):
                    for f in filenames:
                        fp = os.path.join(dirpath, f)
                        try:
                            freed_bytes += os.path.getsize(fp)
                            deleted += 1
                        except OSError:
                            pass
                _shutil.rmtree(thumb_dir, ignore_errors=True)
        except Exception as e:
            errors.append(f"{root_name}/.thumbs: {e}")

    # 2. Remove search index DB
    db_path = os.path.join(folder_paths.get_user_directory(), "drawer_index.db")
    for suffix in ("", "-wal", "-shm"):
        p = db_path + suffix
        if os.path.isfile(p):
            try:
                sz = os.path.getsize(p)
                os.unlink(p)
                freed_bytes += sz
                deleted += 1
            except Exception as e:
                errors.append(f"index{suffix}: {e}")

    # Reset in-memory search index state so it rebuilds on next use
    if _search_index._conn is not None:
        try:
            _search_index._conn.close()
        except Exception:
            pass
        _search_index._conn = None
        _search_index._ready = False

    if errors:
        logger.warning(f"[Drawer] clear-cache partial errors: {errors[:3]}")

    return web.json_response({
        "ok": True,
        "deleted": deleted,
        "freedBytes": freed_bytes,
    })


@_routes.get("/drawer/reboot")
def drawer_reboot(request):
    """Restart the ComfyUI server process.

    Strategy:
    1. Launch a fully independent child process (DETACHED_PROCESS on Windows)
    2. Immediately os._exit(0) — no Python cleanup, no atexit, no flush.
       The OS closes all handles atomically, avoiding the race where
       concurrent threads (KSampler/tqdm) write to half-closed handles.

    IMPORTANT: Do NOT call sys.stdout.close_log() or print() before
    os._exit — Manager's stderr wrappers are shared with KSampler threads,
    and closing them while sampling is active causes OSError [Errno 22].
    """
    import subprocess

    if '__COMFY_CLI_SESSION__' in os.environ:
        # comfy-cli managed session: signal restart via .reboot file
        with open(os.environ['__COMFY_CLI_SESSION__'] + '.reboot', 'w'):
            pass
        os._exit(0)

    sys_argv = sys.argv.copy()
    if '--windows-standalone-build' in sys_argv:
        sys_argv.remove('--windows-standalone-build')

    if sys_argv[0].endswith('__main__.py'):
        module_name = os.path.basename(os.path.dirname(sys_argv[0]))
        cmds = [sys.executable, '-m', module_name] + sys_argv[1:]
    else:
        cmds = [sys.executable] + sys_argv

    # Launch the new process
    if sys.platform.startswith('win32'):
        # Windows: os.execv doesn't truly replace the process — it spawns
        # a child and lets the parent run cleanup, which crashes when
        # tqdm/colorama/Manager try to write to invalidated console handles.
        # Use subprocess.Popen (fully detached) + os._exit(0) instead.
        import subprocess
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        subprocess.Popen(cmds, creationflags=flags, close_fds=True)
        os._exit(0)
    else:
        # Unix: os.execv genuinely replaces the process image in-place.
        # Same PID, same terminal, same session — no handle issues.
        os.execv(sys.executable, cmds)
