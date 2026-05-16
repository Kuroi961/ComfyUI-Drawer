"""HTTP routes and prompt hooks for ComfyUI-Drawer."""

import os
import sys
import asyncio
import csv
import io
import datetime
import html
import json
import logging
import random
import re
import threading
import time
import tempfile
import uuid as _uuid
from pathlib import Path

try:
    from send2trash import send2trash as _send2trash
except ImportError:
    _send2trash = None

from aiohttp import web
import server
import folder_paths

from .dict_store import (
    count_entries as _count_entries,
    dict_file_path as _dict_file_path,
    read_dict_entries as _read_dict_entries,
    read_manifest as _read_manifest,
    read_wildcard_entries as _read_wildcard_entries,
    write_dict_entries as _write_dict_entries,
    write_manifest as _write_manifest,
    write_wildcard_entries as _write_wildcard_entries,
)
from .fs_utils import (
    ALLOWED_ROOTS as _ALLOWED_ROOTS,
    DELETABLE_ROOTS as _DELETABLE_ROOTS,
    MEDIA_EXTS as _MEDIA_EXTS,
    ROOT_LABELS as _ROOT_LABELS,
    THUMB_WARM_EXTS as _THUMB_WARM_EXTS,
    as_str as _as_str,
    body_int as _body_int,
    body_str as _body_str,
    format_storage_rel as _format_storage_rel,
    ftype as _ftype,
    is_plain_name as _is_plain_name,
    is_supported_media_name as _is_supported_media_name,
    resolve_root as _resolve_root,
    safe_path as _safe_path,
    summarize_tree as _summarize_tree,
    truthy as _truthy,
)
from .metadata_ext import (
    apply_metadata_panel_contributors as _apply_metadata_panel_contributors,
    has_dictionary_providers as _has_dictionary_providers,
    read_dictionary_provider_entries as _read_dictionary_provider_entries,
    register_dictionary_provider,
    register_index_contributor,
    register_metadata_panel_contributor,
    register_metadata_provider,
    setup_metadata_extensions,
    unregister_dictionary_provider,
    unregister_index_contributor,
    unregister_metadata_panel_contributor,
    unregister_metadata_provider,
)
from .media_metadata import (
    provider_context as _provider_context,
    read_media_meta as _read_media_meta,
    read_media_meta_with_source as _read_media_meta_with_source,
)
from .prompt_processor import setup_prompt_processing
from .request_guards import require_same_origin as _require_same_origin
from .search_query import (
    extract_searchable_parts as _extract_searchable_parts,
    parse_search_scopes as _parse_search_scopes,
    parse_search_terms as _parse_search_terms,
    search_scope_group_matches as _search_scope_group_matches,
    search_terms_empty as _search_terms_empty,
    search_text_matches as _search_text_matches,
)
from .search_index import SearchIndex
from .thumbnails import (
    ensure_gallery_thumbnail as _ensure_gallery_thumbnail,
    move_gallery_thumbnail_cache as _move_gallery_thumbnail_cache,
    remove_gallery_thumbnail_cache as _remove_gallery_thumbnail_cache,
)

logger = logging.getLogger("ComfyUI-Drawer")

_routes = server.PromptServer.instance.routes

sys.modules.setdefault("comfyui_drawer.drawer_routes", sys.modules[__name__])
setup_metadata_extensions(server.PromptServer.instance)


def _drawer_version(default="0.0.0"):
    pyproject = Path(__file__).resolve().parent / "pyproject.toml"
    try:
        text = pyproject.read_text(encoding="utf-8")
    except OSError:
        return default
    match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
    return match.group(1) if match else default


@_routes.get("/drawer/version")
async def get_drawer_version(request):
    """Return the Python package version used by the current Drawer backend."""
    return web.json_response({"version": _drawer_version()})


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


@_routes.get("/drawer/dict/third-party")
async def get_third_party_dicts(request):
    """Return dictionary entries provided by third-party Python providers."""
    return web.json_response({"providers": _sanitize_json_floats(_read_dictionary_provider_entries())})


@_routes.get("/drawer/dict/third-party/status")
async def get_third_party_dict_status(request):
    """Return whether third-party dictionary providers are registered."""
    return web.json_response({"hasProviders": _has_dictionary_providers()})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Model Paths — per-category models grouped by source directory
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@_routes.get("/drawer/models/paths/{category}")
async def get_model_paths(request):
    """Return models grouped by their source base path for a given category.

    Response: [
        { "id": "source-1", "models": ["model1.safetensors", ...] },
        { "id": "source-2", "models": ["SDXL/model2.safetensors", ...] },
    ]
    """
    def scan(category):
        category = folder_paths.map_legacy(category)

        if category not in folder_paths.folder_names_and_paths:
            return []

        paths_and_exts = folder_paths.folder_names_and_paths[category]
        base_paths = paths_and_exts[0]
        extensions = paths_and_exts[1]

        result = []
        for idx, base_path in enumerate(base_paths, start=1):
            if not os.path.isdir(base_path):
                continue
            files, _dirs = folder_paths.recursive_search(base_path, excluded_dir_names=[".git"])
            filtered = folder_paths.filter_files_extensions(files, extensions)
            result.append({
                "id": f"source-{idx}",
                "models": [f.replace("\\", "/") for f in filtered],
            })
        return result

    return web.json_response(await asyncio.to_thread(scan, request.match_info["category"]))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  User Dictionaries — Multi-dictionary system (dict + wildcard)
#  Storage: ComfyUI/user/drawer_dicts/
#    manifest.json   — [{id, title, enabled, type}, ...]
#    {id}.csv        — tag,insert_text rows  (type="dict")
#    {id}.txt        — one entry per line     (type="wildcard")
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_USER_DICT_ID_RE = re.compile(r"^[a-f0-9]{8}$", re.IGNORECASE)
_MAX_DICT_IMPORT_BYTES = 5 * 1024 * 1024


def _find_user_dict(dict_id):
    """Return manifest entry for a known user dictionary id."""
    if not _USER_DICT_ID_RE.match(str(dict_id or "")):
        return None
    for d in _read_manifest():
        if d.get("id") == dict_id:
            return d
    return None


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
    _require_same_origin(request)
    try:
        data = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    title = _body_str(data, "title", "新しい辞書") or "新しい辞書"
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
    _require_same_origin(request)
    dict_id = request.match_info["dict_id"]
    if not _USER_DICT_ID_RE.match(dict_id):
        return web.json_response({"error": "invalid dictionary id"}, status=400)
    try:
        data = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    manifest = _read_manifest()
    for d in manifest:
        if d["id"] == dict_id:
            if "title" in data:
                # Use _body_str so non-string titles (null/int/bool) become
                # an empty string instead of raising AttributeError on .strip().
                new_title = _body_str(data, "title", d.get("title", ""))
                if new_title:
                    d["title"] = new_title
            if "enabled" in data:
                d["enabled"] = bool(data["enabled"])
            _write_manifest(manifest)
            return web.json_response({"ok": True, **d})

    return web.json_response({"error": "not found"}, status=404)


@_routes.delete("/drawer/user-dicts/{dict_id}")
async def delete_user_dict_full(request):
    """Delete an entire user dictionary (manifest entry + file)."""
    _require_same_origin(request)
    dict_id = request.match_info["dict_id"]
    if not _USER_DICT_ID_RE.match(dict_id):
        return web.json_response({"error": "invalid dictionary id"}, status=400)

    manifest = _read_manifest()
    target = None
    for d in manifest:
        if d["id"] == dict_id:
            target = d
            break
    if not target:
        return web.json_response({"error": "not found"}, status=404)

    dtype = target.get("type", "dict")
    try:
        fpath = _dict_file_path(dict_id, dtype)
    except ValueError:
        return web.json_response({"error": "invalid dictionary id"}, status=400)

    # Delete the data file first; only update the manifest if that succeeds,
    # so a Windows file-lock cannot leave a manifest entry pointing at an
    # orphan file.
    if os.path.exists(fpath):
        try:
            os.remove(fpath)
        except OSError as e:
            return web.json_response({"error": f"delete failed: {e.strerror or e}"}, status=500)

    new_manifest = [d for d in manifest if d["id"] != dict_id]
    _write_manifest(new_manifest)

    return web.json_response({"ok": True})


# ── Entry CRUD Endpoints (per-dictionary, type-aware) ──

@_routes.get("/drawer/user-dict/{dict_id}")
async def get_user_dict_entries(request):
    """Return entries for a specific user dictionary."""
    dict_id = request.match_info["dict_id"]
    dict_meta = _find_user_dict(dict_id)
    if dict_meta is None:
        return web.json_response({"error": "not found"}, status=404)
    dtype = dict_meta.get("type", "dict")
    if dtype == "wildcard":
        entries = _read_wildcard_entries(dict_id)
        return web.json_response([{"text": e} for e in entries])
    else:
        entries = _read_dict_entries(dict_id)
        return web.json_response(entries)


@_routes.post("/drawer/user-dict/{dict_id}")
async def post_user_dict_entries(request):
    """Add/update entries in a specific user dictionary."""
    _require_same_origin(request)
    dict_id = request.match_info["dict_id"]
    try:
        data = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    dict_meta = _find_user_dict(dict_id)
    if dict_meta is None:
        return web.json_response({"error": "not found"}, status=404)
    dtype = dict_meta.get("type", "dict")

    if dtype == "wildcard":
        if "entries" in data:
            new_texts = [_body_str(e, "text") for e in data["entries"] if isinstance(e, dict)]
        else:
            new_texts = [_body_str(data, "text")]
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
            if not isinstance(entry, dict):
                continue
            tag = _body_str(entry, "tag")
            if not tag:
                continue
            existing_map[tag] = {
                "tag": tag,
                "insert_text": _body_str(entry, "insert_text"),
            }
        _write_dict_entries(dict_id, list(existing_map.values()))
        return web.json_response({"ok": True, "count": len(existing_map)})


@_routes.delete("/drawer/user-dict/{dict_id}")
async def delete_user_dict_entries(request):
    """Delete entries from a specific user dictionary."""
    _require_same_origin(request)
    dict_id = request.match_info["dict_id"]
    try:
        data = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    dict_meta = _find_user_dict(dict_id)
    if dict_meta is None:
        return web.json_response({"error": "not found"}, status=404)
    dtype = dict_meta.get("type", "dict")

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
    _require_same_origin(request)
    try:
        reader = await _multipart_reader(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    title = None
    dtype = None
    file_data = None
    filename = None

    try:
        async for part in reader:
            if part.name == "title":
                title = _as_str(await part.text()).strip()
            elif part.name == "type":
                dtype = _as_str(await part.text()).strip()
            elif part.name == "file":
                filename = part.filename or "import"
                try:
                    file_data = await _read_limited_stream(part, _MAX_DICT_IMPORT_BYTES)
                except ValueError:
                    return web.json_response({"error": "file too large"}, status=413)
                # NOTE: do NOT call `part.decode(file_data)` here.
                # aiohttp's BodyPartReader auto-decodes Content-Transfer-
                # Encoding while reading the stream, so the bytes we just
                # got are already final. A second `decode()` either no-ops
                # (no encoding) or, if the part carries an encoding header,
                # changes the type so the later text decode raises.
    except ValueError:
        return web.json_response({"error": "file too large"}, status=413)
    except Exception:
        return web.json_response({"error": "Invalid multipart form"}, status=400)

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
            tag = _body_str(row, "tag")
            if tag:
                entries.append({
                    "tag": tag,
                    "insert_text": _body_str(row, "insert_text"),
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

setup_prompt_processing(_routes, _read_manifest, _read_wildcard_entries)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Filesystem API — Browse, search, meta, delete
#  Generic filesystem layer for Drawer gadgets (Gallery, future ModelViewer, etc.)
#  All endpoints are under /drawer/fs/ and accept a `root` parameter to select
#  among whitelisted directories (output, input, temp).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_STORAGE_SUMMARY_CACHE = {"ts": 0.0, "data": None}
_STORAGE_SUMMARY_TTL = 300.0


def _query_int(request, name, default, *, minimum=None, maximum=None):
    raw = request.query.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=f"Invalid integer: {name}")
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


async def _read_json_body(request, default=None):
    try:
        data = await request.json()
    except Exception:
        if default is not None:
            return default
        raise web.HTTPBadRequest(text="Invalid JSON")
    if not isinstance(data, dict):
        if default is not None:
            return default
        raise web.HTTPBadRequest(text="JSON object required")
    return data


def _json_error(message, status):
    return web.json_response({"error": message}, status=status)


def _internal_error(exc, *, where=None, status=500, error="internal error"):
    """Log an exception server-side and return a generic JSON error.

    `str(e)` for OSError/PermissionError typically contains the absolute
    server path that triggered the failure, which leaks filesystem layout
    to the browser. Use this helper instead of interpolating ``e`` into
    the response body. Operators still get the full traceback in the log.
    """
    label = where or "drawer"
    try:
        logger.warning("[Drawer] %s failed", label, exc_info=exc)
    except Exception:
        # Never let logging failure block the response.
        pass
    return web.json_response({"error": error}, status=status)


async def _multipart_reader(request):
    try:
        return await request.multipart()
    except Exception:
        raise web.HTTPBadRequest(text="Invalid multipart form")


def _normalize_search_query(query):
    raw_query = (query or "").strip()
    if raw_query.startswith('"') and raw_query.endswith('"') and len(raw_query) > 2:
        raw_query = raw_query[1:-1]
    return raw_query.lower()



def _search_filesystem_raw(root_name, root, query, subpath="", limit=0, offset=0, scope="", sort="date-desc", include_metadata=False):
    """Search files directly when the SQLite index is unavailable or stale."""
    terms = _parse_search_terms(query)
    if _search_terms_empty(terms):
        return []
    scopes = _parse_search_scopes(scope)
    search_root = _safe_path(root, subpath) if subpath else root
    if search_root is None or not os.path.isdir(search_root):
        return []

    results = []
    # os.walk defaults to followlinks=False (so symlinked dirs are not
    # descended into), but symlinked files still show up in `filenames`
    # and would be opened by _read_media_meta below. Also drop any
    # symlinked subdirectories from `dirnames` so they don't appear in
    # the dirpath of a subsequent iteration via parent listing.
    for dirpath, dirnames, filenames in os.walk(search_root):
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".")
            and not os.path.islink(os.path.join(dirpath, d))
        ]
        rel = os.path.relpath(dirpath, root).replace("\\", "/")
        if rel == ".":
            rel = ""
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in _MEDIA_EXTS:
                continue
            full = os.path.join(dirpath, fname)
            if os.path.islink(full):
                continue
            name_match = _search_text_matches(fname, terms)
            scope_text = {}
            if include_metadata and (not name_match or any(s != "name" for s in scopes)):
                meta = _read_media_meta(
                    full,
                    root_name=root_name,
                    root_path=root,
                    subfolder=rel,
                    name=fname,
                )
                if meta:
                    parts = _extract_searchable_parts(meta, {
                        "path": full,
                        "root_name": root_name,
                        "root_path": root,
                        "subfolder": rel,
                        "name": fname,
                        "filename": fname,
                    })
                    scope_text = {
                        "prompt_title": parts["prompt_title"],
                        "prompt_value": parts["prompt_value"],
                        "workflow_title": parts["workflow_title"],
                        "workflow_value": parts["workflow_value"],
                        "custom": parts["custom"],
                    }
            matched = _search_scope_group_matches({
                "name": fname,
                **scope_text,
            }, terms, scopes)
            if not matched:
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            results.append({
                "name": fname,
                "path": (rel + "/" + fname) if rel else fname,
                "subfolder": rel,
                "size": st.st_size,
                "created": st.st_mtime,
                "type": _ftype(ext),
            })
    key, _, direction = str(sort or "date-desc").partition("-")
    reverse = direction != "asc"
    if key == "name":
        results.sort(key=lambda r: (r["name"] or "").lower(), reverse=reverse)
    elif key == "size":
        results.sort(key=lambda r: r["size"] or 0, reverse=reverse)
    else:
        results.sort(key=lambda r: r["created"] or 0, reverse=reverse)
    end = offset + limit if limit > 0 else None
    return results[offset:end]



# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Search Index — SQLite FTS5 for fast metadata search
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Global search index instance. Builds are user-started because large
# galleries can take minutes to index.
_search_index = SearchIndex(
    allowed_roots=_ALLOWED_ROOTS,
    media_exts=_MEDIA_EXTS,
    ftype=_ftype,
    format_storage_rel=_format_storage_rel,
    safe_path=_safe_path,
)




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



# -- Browse --

@_routes.get("/drawer/fs/browse")
async def fs_browse(request):
    """GET /drawer/fs/browse?root=output&path=<relative>"""
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subpath = request.query.get("path", "").strip().replace("\\", "/")
    try:
        limit = _query_int(request, "limit", 0, minimum=0)
        offset = _query_int(request, "offset", 0, minimum=0)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    fetch_limit = limit + 1 if limit > 0 else 0
    sort = request.query.get("sort", "name-asc").strip()
    target = _safe_path(root, subpath) if subpath else root
    if target is None:
        return web.json_response({"error": "Invalid path"}, status=400)
    if not os.path.isdir(target):
        return web.json_response({"error": "Not found"}, status=404)

    def scan():
        folders, files = [], []
        # scandir + follow_symlinks=False keeps the listing inside the
        # allowed root. os.listdir + isdir would happily descend into a
        # symlink that points outside output/input/temp.
        try:
            iterator = os.scandir(target)
        except OSError:
            return folders, [], 0, False
        with iterator as it:
            entries = sorted(it, key=lambda e: e.name)
            for entry in entries:
                name = entry.name
                if name.startswith("."):
                    continue
                # Refuse symlinks entirely — they could re-enter elsewhere.
                try:
                    if entry.is_symlink():
                        continue
                except OSError:
                    continue
                rel = (subpath + "/" + name) if subpath else name
                rel = rel.replace("\\", "/")
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_file = entry.is_file(follow_symlinks=False)
                except OSError:
                    continue
                if is_dir:
                    folders.append({"name": name, "path": rel})
                elif is_file:
                    ext = os.path.splitext(name)[1].lower()
                    if ext in _MEDIA_EXTS:
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        files.append({
                            "name": name, "path": rel, "subfolder": subpath,
                            "size": st.st_size, "created": st.st_ctime,
                            "type": _ftype(ext),
                        })
        sort_key, _sep, sort_dir = str(sort or "name-asc").partition("-")
        reverse = sort_dir == "desc"
        if sort_key == "date":
            files.sort(key=lambda item: item.get("created", 0), reverse=reverse)
        elif sort_key == "size":
            files.sort(key=lambda item: item.get("size", 0), reverse=reverse)
        else:
            files.sort(key=lambda item: str(item.get("name", "")).lower(), reverse=reverse)
        has_more = False
        page = files
        if fetch_limit > 0:
            page = files[offset:offset + fetch_limit]
            has_more = len(page) > limit
            if has_more:
                page = page[:limit]
        return folders, page, len(files), has_more

    try:
        folders, files, total_files, has_more = await asyncio.to_thread(scan)
    except OSError:
        return web.json_response({"error": "Cannot read"}, status=500)
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
        "totalFiles": total_files, "hasMore": has_more,
    })


@_routes.get("/drawer/storage/summary")
async def storage_summary(request):
    """GET /drawer/storage/summary
    Returns lightweight size and file composition summaries for Gallery roots
    and ComfyUI model directories.
    """
    now = time.time()
    force = request.query.get("refresh", "").lower() in ("1", "true", "yes")
    cached = _STORAGE_SUMMARY_CACHE.get("data")
    if not force and cached is not None and now - _STORAGE_SUMMARY_CACHE.get("ts", 0.0) < _STORAGE_SUMMARY_TTL:
        return web.json_response(cached)

    def scan():
        roots = []
        for root_name in ("output", "input"):
            getter = _ALLOWED_ROOTS.get(root_name)
            base = getter() if getter else None
            summary = _summarize_tree(base, set(_MEDIA_EXTS))
            roots.append({
                "id": root_name,
                "label": _ROOT_LABELS.get(root_name, root_name.title()),
                "path": base,
                **summary,
            })

        model_categories = []
        model_total = {"bytes": 0, "files": 0, "folders": 0, "byExt": {}}
        for category in sorted(folder_paths.folder_names_and_paths.keys()):
            try:
                paths, exts = folder_paths.folder_names_and_paths[category]
            except Exception:
                continue
            category_summary = {"bytes": 0, "files": 0, "folders": 0, "byExt": {}, "topDirs": {}}
            for base in paths:
                summary = _summarize_tree(base, set(exts or []))
                category_summary["bytes"] += summary["bytes"]
                category_summary["files"] += summary["files"]
                category_summary["folders"] += summary["folders"]
                for entry in summary["byExt"]:
                    ext = entry["ext"]
                    category_summary["byExt"].setdefault(ext, {"ext": ext, "bytes": 0, "files": 0})
                    category_summary["byExt"][ext]["bytes"] += entry["bytes"]
                    category_summary["byExt"][ext]["files"] += entry["files"]
                for entry in summary["topDirs"]:
                    name = entry["name"]
                    category_summary["topDirs"].setdefault(name, {"name": name, "bytes": 0, "files": 0})
                    category_summary["topDirs"][name]["bytes"] += entry["bytes"]
                    category_summary["topDirs"][name]["files"] += entry["files"]
            if category_summary["files"] <= 0:
                continue
            by_ext = sorted(category_summary["byExt"].values(), key=lambda x: x["bytes"], reverse=True)[:8]
            item = {
                "id": category,
                "label": category,
                "bytes": category_summary["bytes"],
                "files": category_summary["files"],
                "folders": category_summary["folders"],
                "byExt": by_ext,
                "topDirs": sorted(category_summary["topDirs"].values(), key=lambda x: x["bytes"], reverse=True)[:8],
            }
            model_categories.append(item)
            model_total["bytes"] += item["bytes"]
            model_total["files"] += item["files"]
            model_total["folders"] += item["folders"]
            for entry in item["byExt"]:
                ext = entry["ext"]
                model_total["byExt"].setdefault(ext, {"ext": ext, "bytes": 0, "files": 0})
                model_total["byExt"][ext]["bytes"] += entry["bytes"]
                model_total["byExt"][ext]["files"] += entry["files"]

        model_categories.sort(key=lambda x: x["bytes"], reverse=True)
        return {
            "roots": roots,
            "models": {
                "bytes": model_total["bytes"],
                "files": model_total["files"],
                "folders": model_total["folders"],
                "byExt": sorted(model_total["byExt"].values(), key=lambda x: x["bytes"], reverse=True)[:12],
                "categories": model_categories[:12],
            },
        }

    data = await asyncio.to_thread(scan)
    _STORAGE_SUMMARY_CACHE["ts"] = now
    _STORAGE_SUMMARY_CACHE["data"] = data
    return web.json_response(data)


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
    if not _is_supported_media_name(filename):
        return web.json_response({"error": "unsupported file type"}, status=415)
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

_THUMB_PLACEHOLDER_STATUSES = {
    "ffmpeg-missing": "FFmpeg not found",
    "video-thumb-timeout": "Video thumbnail timed out",
    "video-thumb-error": "Video thumbnail unavailable",
}


def _thumb_placeholder_response(kind):
    label = _THUMB_PLACEHOLDER_STATUSES.get(kind, "Thumbnail unavailable")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384">
<rect width="512" height="384" fill="#111"/>
<rect x="32" y="32" width="448" height="320" rx="22" fill="#1b1b1b" stroke="#333" stroke-width="2"/>
<path d="M218 148v88l78-44-78-44z" fill="#777"/>
<text x="256" y="278" text-anchor="middle" fill="#aaa" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="24">{html.escape(label)}</text>
</svg>"""
    return web.Response(
        body=svg.encode("utf-8"),
        content_type="image/svg+xml",
        headers={
            "Cache-Control": "no-store",
            "X-Comfy-Drawer-Thumb-Status": kind,
        },
    )


@_routes.get("/drawer/fs/thumb")
async def fs_thumb(request):
    """GET /drawer/fs/thumb?root=input&subfolder=&filename=img.png&size=200
    Returns a cached WebP thumbnail. Generates on first request.
    Cache is stored under <root>/.thumbs/<subfolder>/<filename>.webp
    Regenerates if original mtime > cached mtime.
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subfolder = request.query.get("subfolder", "").strip()
    filename = request.query.get("filename", "").strip()
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)
    if not _is_supported_media_name(filename, _THUMB_WARM_EXTS):
        return web.json_response({"error": "unsupported file type"}, status=415)

    try:
        max_size = _query_int(request, "size", 200, minimum=32, maximum=512)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    try:
        thumb_path, kind = await asyncio.to_thread(_ensure_gallery_thumbnail, root, subfolder, filename, max_size)
    except Exception as e:
        logger.warning(f"Thumbnail generation failed for {filename}: {e}")
        return web.Response(status=500, text="Thumbnail generation failed")
    if kind in _THUMB_PLACEHOLDER_STATUSES:
        return _thumb_placeholder_response(kind)
    if kind == "unsupported":
        return web.json_response({"error": "unsupported file type"}, status=415)
    if thumb_path is None:
        return web.Response(status=404 if kind == "not-found" else 400, text="Not found" if kind == "not-found" else "Invalid path")

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


@_routes.post("/drawer/fs/thumb-warm")
async def fs_thumb_warm(request):
    """POST /drawer/fs/thumb-warm — best-effort thumbnail cache warming."""
    _require_same_origin(request)
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    files = body.get("files", [])
    if not isinstance(files, list):
        return web.json_response({"error": "files must be a list"}, status=400)
    size = _body_int(body, "size", 512, minimum=32, maximum=512)

    def warm():
        warmed = skipped = 0
        for entry in files[:20]:
            if not isinstance(entry, dict):
                skipped += 1
                continue
            root_name = _body_str(entry, "root", "output").lower()
            getter = _ALLOWED_ROOTS.get(root_name)
            if getter is None:
                skipped += 1
                continue
            try:
                root = getter()
                subfolder = _body_str(entry, "subfolder").replace("\\", "/").strip("/")
                name = _body_str(entry, "name", _body_str(entry, "filename"))
                if not _is_plain_name(name) or os.path.splitext(name)[1].lower() not in _THUMB_WARM_EXTS:
                    skipped += 1
                    continue
                path, kind = _ensure_gallery_thumbnail(root, subfolder, name, size)
                if path and kind == "thumbnail":
                    warmed += 1
                else:
                    skipped += 1
            except Exception as e:
                logger.debug(f"Thumbnail warm skipped: {e}")
                skipped += 1
        return warmed, skipped

    warmed, skipped = await asyncio.to_thread(warm)
    return web.json_response({"ok": True, "warmed": warmed, "skipped": skipped})


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
    try:
        limit = _query_int(request, "limit", 0, minimum=0)
        offset = _query_int(request, "offset", 0, minimum=0)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    fetch_limit = limit + 1 if limit > 0 else 0
    scope = request.query.get("scope", "").strip()
    sort = request.query.get("sort", "date-desc").strip()

    # Try indexed search first
    indexed = await asyncio.to_thread(
        _search_index.search, query, root_name, subpath, limit=fetch_limit, offset=offset, scope=scope, sort=sort
    )
    if indexed is not None:
        results = indexed.get("files", []) if isinstance(indexed, dict) else indexed
        total_count = int(indexed.get("total", len(results))) if isinstance(indexed, dict) else len(results)
        files = results[:limit] if limit > 0 else results
        has_more = bool(limit > 0 and (offset + len(files)) < total_count)
        return web.json_response({"files": files, "total": total_count, "query": query, "hasMore": has_more, "totalExact": True})

    # Fallback while the index is still rebuilding: filename-only raw substring
    # search. Metadata scopes need the index to avoid blocking the server.
    if any(s != "name" for s in _parse_search_scopes(scope)):
        return web.json_response({"files": [], "total": 0, "query": query})
    results = await asyncio.to_thread(
        _search_filesystem_raw,
        root_name, root, query, subpath,
        limit=fetch_limit, offset=offset, scope=scope, sort=sort, include_metadata=False,
    )
    has_more = bool(limit > 0 and len(results) > limit)
    files = results[:limit] if has_more else results
    return web.json_response({"files": files, "total": offset + len(files), "query": query, "hasMore": has_more, "totalExact": False})


@_routes.get("/drawer/fs/index-status")
async def fs_index_status(request):
    """GET /drawer/fs/index-status — report indexing progress."""
    return web.json_response(_search_index.status)


@_routes.get("/drawer/fs/index-diagnostics")
async def fs_index_diagnostics(request):
    """GET /drawer/fs/index-diagnostics — read-only index troubleshooting."""
    return web.json_response(_search_index.diagnostics())


@_routes.get("/drawer/fs/index-estimate")
async def fs_index_estimate(request):
    """GET /drawer/fs/index-estimate — estimate index build size/duration."""
    return web.json_response(await _search_index.estimate_async())


@_routes.post("/drawer/fs/index-start")
async def fs_index_start(request):
    """POST /drawer/fs/index-start — start a fresh search index build."""
    _require_same_origin(request)
    _search_index.start_background_build(reset=True)
    return web.json_response(_search_index.status)


@_routes.post("/drawer/fs/index-resume")
async def fs_index_resume(request):
    """POST /drawer/fs/index-resume — resume the search index build."""
    _require_same_origin(request)
    _search_index.start_background_build(reset=False)
    return web.json_response(_search_index.status)


@_routes.post("/drawer/fs/index-pause")
async def fs_index_pause(request):
    """POST /drawer/fs/index-pause — pause the current search index build."""
    _require_same_origin(request)
    _search_index.pause()
    return web.json_response(_search_index.status)


@_routes.post("/drawer/fs/index-sync")
async def fs_index_sync(request):
    """POST /drawer/fs/index-sync — reconcile file changes without rebuilding metadata."""
    _require_same_origin(request)
    started = _search_index.start_background_sync(user_initiated=True)
    return web.json_response({"ok": True, "started": started, **_search_index.status})


@_routes.post("/drawer/fs/index-refresh-metadata")
async def fs_index_refresh_metadata(request):
    """POST /drawer/fs/index-refresh-metadata — reread metadata and reapply contributors.

    Use after installing or changing metadata providers/index contributors when
    the existing DB rows should be reinterpreted without dropping the index DB.
    """
    _require_same_origin(request)
    started = _search_index.start_background_metadata_refresh(user_initiated=True)
    return web.json_response({"ok": True, "started": started, **_search_index.status})


@_routes.put("/drawer/fs/index-auto-sync")
async def fs_index_auto_sync(request):
    """PUT /drawer/fs/index-auto-sync — enable/disable periodic file reconciliation."""
    _require_same_origin(request)
    body = await _read_json_body(request, default={})
    enabled = _search_index.set_auto_sync_enabled(bool(body.get("enabled", False)))
    return web.json_response({"ok": True, "enabled": enabled, **_search_index.status})


@_routes.post("/drawer/fs/index-update")
async def fs_index_update(request):
    """POST /drawer/fs/index-update
    Single: {"root": "output", "subfolder": "...", "name": "...", "searchable": "..."}
    Batch:  {"entries": [{"root":..., "subfolder":..., "name":..., "searchable":...}, ...]}
    Allows external metadata providers to enrich empty search index rows.
    Existing metadata is preserved unless replace=true is supplied.
    """
    _require_same_origin(request)
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    entries = body.get("entries")
    if entries and isinstance(entries, list):
        # Batch mode
        ok_count = 0
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            root_name = _body_str(entry, "root", "output").lower()
            subfolder = _body_str(entry, "subfolder")
            name = _body_str(entry, "name")
            searchable = _body_str(entry, "searchable")
            s_prompt = _body_str(entry, "s_prompt", _body_str(entry, "prompt"))
            s_value = _body_str(entry, "s_value", _body_str(entry, "value"))
            s_workflow = _body_str(entry, "s_workflow", _body_str(entry, "workflow"))
            s_prompt_title = _body_str(entry, "s_prompt_title", _body_str(entry, "prompt_title"))
            s_prompt_value = _body_str(entry, "s_prompt_value", _body_str(entry, "prompt_value"))
            s_workflow_title = _body_str(entry, "s_workflow_title", _body_str(entry, "workflow_title"))
            s_workflow_value = _body_str(entry, "s_workflow_value", _body_str(entry, "workflow_value"))
            s_custom = _body_str(entry, "s_custom", _body_str(entry, "custom"))
            s_nodes = entry.get("s_nodes", "[]")
            replace = _truthy(entry.get("replace", entry.get("overwrite", False)))
            legacy = {
                "s_classes": _body_str(entry, "s_classes"),
                "s_titles": _body_str(entry, "s_titles"),
                "s_inputs": _body_str(entry, "s_inputs"),
            }
            if name and (searchable or s_prompt or s_value or s_workflow
                         or s_prompt_title or s_prompt_value
                         or s_workflow_title or s_workflow_value
                         or s_custom
                         or any(legacy.values())):
                if _search_index.update_searchable(
                    root_name, subfolder, name,
                    searchable_text=searchable,
                    s_prompt=s_prompt, s_value=s_value,
                    s_prompt_title=s_prompt_title, s_prompt_value=s_prompt_value,
                    s_workflow_title=s_workflow_title, s_workflow_value=s_workflow_value,
                    s_custom=s_custom,
                    s_workflow=s_workflow, s_nodes=s_nodes, replace=replace, **legacy,
                ):
                    ok_count += 1
        return web.json_response({"ok": True, "updated": ok_count})

    # Single mode
    root_name = _body_str(body, "root", "output").lower()
    subfolder = _body_str(body, "subfolder")
    name = _body_str(body, "name")
    searchable = _body_str(body, "searchable")
    s_prompt = _body_str(body, "s_prompt", _body_str(body, "prompt"))
    s_value = _body_str(body, "s_value", _body_str(body, "value"))
    s_workflow = _body_str(body, "s_workflow", _body_str(body, "workflow"))
    s_prompt_title = _body_str(body, "s_prompt_title", _body_str(body, "prompt_title"))
    s_prompt_value = _body_str(body, "s_prompt_value", _body_str(body, "prompt_value"))
    s_workflow_title = _body_str(body, "s_workflow_title", _body_str(body, "workflow_title"))
    s_workflow_value = _body_str(body, "s_workflow_value", _body_str(body, "workflow_value"))
    s_custom = _body_str(body, "s_custom", _body_str(body, "custom"))
    s_nodes = body.get("s_nodes", "[]")
    replace = _truthy(body.get("replace", body.get("overwrite", False)))
    legacy = {
        "s_classes": _body_str(body, "s_classes"),
        "s_titles": _body_str(body, "s_titles"),
        "s_inputs": _body_str(body, "s_inputs"),
    }
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    ok = _search_index.update_searchable(
        root_name, subfolder, name,
        searchable_text=searchable,
        s_prompt=s_prompt, s_value=s_value,
        s_prompt_title=s_prompt_title, s_prompt_value=s_prompt_value,
        s_workflow_title=s_workflow_title, s_workflow_value=s_workflow_value,
        s_custom=s_custom,
        s_workflow=s_workflow, s_nodes=s_nodes, replace=replace, **legacy,
    )
    if not ok:
        return web.json_response({"error": "File not found or invalid root"}, status=404)
    return web.json_response({"ok": True})


@_routes.post("/drawer/fs/index-generated")
async def fs_index_generated(request):
    """POST /drawer/fs/index-generated
    Add newly generated files to an already-ready search snapshot.
    Body: {"files": [{"root": "output", "subfolder": "...", "name": "..."}]}
    """
    _require_same_origin(request)
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    files = body.get("files", [])
    if not isinstance(files, list):
        return web.json_response({"error": "files must be a list"}, status=400)
    replace = _truthy(body.get("replace", body.get("overwrite", False)))
    result = _search_index.index_files_from_disk(files[:200], replace=replace)
    return web.json_response({"ok": True, **result})

# -- Meta --

@_routes.get("/drawer/fs/meta")
async def fs_meta(request):
    """GET /drawer/fs/meta?root=output&subfolder=<rel>&name=<filename>
    Returns provider metadata when available, otherwise embedded media metadata.
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subfolder = request.query.get("subfolder", "").strip()
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "Invalid"}, status=400)
    if not _is_supported_media_name(name):
        return web.json_response({"error": "unsupported file type"}, status=415)

    media_path = _safe_path(root, subfolder, name) if subfolder else _safe_path(root, name)
    if media_path and os.path.isfile(media_path):
        meta = _read_media_meta(
            media_path,
            root_name=root_name,
            root_path=root,
            subfolder=subfolder,
            name=name,
        )
        if meta:
            # Sanitize NaN/Infinity: Python's JSON encoder emits non-standard
            # NaN/Infinity literals that browsers refuse to parse.
            meta = _sanitize_json_floats(meta)
            return web.json_response(meta)

    return web.json_response({"error": "Meta not found"}, status=404)


@_routes.get("/drawer/fs/meta-panels")
async def fs_meta_panels(request):
    """GET /drawer/fs/meta-panels?root=output&subfolder=<rel>&name=<filename>
    Returns third-party metadata display sections for the media file.
    """
    root_name, root = _resolve_root(request)
    if root is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    subfolder = request.query.get("subfolder", "").strip()
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "Invalid"}, status=400)
    if not _is_supported_media_name(name):
        return web.json_response({"error": "unsupported file type"}, status=415)

    media_path = _safe_path(root, subfolder, name) if subfolder else _safe_path(root, name)
    if not media_path or not os.path.isfile(media_path):
        return web.json_response({"error": "File not found"}, status=404)
    ctx = _provider_context(media_path, root_name, root, subfolder, name)
    meta = _read_media_meta(
        media_path,
        root_name=root_name,
        root_path=root,
        subfolder=subfolder,
        name=name,
    )
    if not meta:
        return web.json_response({"sections": []})
    sections = _apply_metadata_panel_contributors(meta, ctx)
    return web.json_response({"sections": _sanitize_json_floats(sections)})



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


# -- Delete (output/input/temp; items are sent to trash) --

@_routes.post("/drawer/fs/delete")
async def fs_delete(request):
    """POST /drawer/fs/delete
    Body: {"root": "output", "files": [{"subfolder":"...","name":"..."}, ...]}
    Restricted to output, input, and temp roots for safety.
    Files are sent to the OS trash/recycle bin (requires send2trash).
    """
    _require_same_origin(request)
    if _send2trash is None:
        return web.json_response(
            {"error": "Delete unavailable: send2trash is not installed (pip install send2trash)"},
            status=503,
        )
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    root_name = _body_str(body, "root", "output").lower()
    if root_name not in _DELETABLE_ROOTS:
        return web.json_response({"error": f"Delete not allowed for root '{root_name}'"}, status=403)
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    root = getter()
    files = body.get("files", [])
    if not isinstance(files, list):
        return web.json_response({"error": "files must be a list"}, status=400)
    if not files:
        return web.json_response({"error": "No files"}, status=400)

    # The trash/index-update loop is blocking I/O. Push it onto a worker
    # thread so a long delete (many files, slow disk, recycle-bin churn)
    # does not stall the event loop and starve other Drawer requests.
    def _do_delete():
        deleted = 0
        deleted_folders = 0
        deleted_files = []
        deleted_folder_items = []
        index_updated = 0
        for item in files:
            if not isinstance(item, dict):
                continue
            subfolder = _body_str(item, "subfolder")
            name = _body_str(item, "name")
            if not _is_plain_name(name):
                continue
            media_path = _safe_path(root, subfolder, name) if subfolder else _safe_path(root, name)
            if media_path is None:
                continue
            if os.path.isfile(media_path):
                if _trash_file(media_path):
                    deleted += 1
                    deleted_files.append({"subfolder": subfolder, "name": name})
                    _remove_gallery_thumbnail_cache(root, subfolder, name)
                    index_updated += _search_index.note_path_deleted(root_name, subfolder, name)
            elif os.path.isdir(media_path):
                # Folder deletion — send entire folder (with contents) to trash
                if _trash_file(media_path):
                    deleted_folders += 1
                    deleted_folder_items.append({"subfolder": subfolder, "name": name})
                    _remove_gallery_thumbnail_cache(root, subfolder, name, is_dir=True)
                    index_updated += _search_index.note_path_deleted(root_name, subfolder, name, is_dir=True)
        return deleted, deleted_folders, deleted_files, deleted_folder_items, index_updated

    deleted, deleted_folders, deleted_files, deleted_folder_items, index_updated = (
        await asyncio.to_thread(_do_delete)
    )
    return web.json_response({
        "deleted": deleted,
        "deleted_folders": deleted_folders,
        "deleted_files": deleted_files,
        "deleted_folder_items": deleted_folder_items,
        "indexUpdated": index_updated,
    })


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

_MERGE_DIRS_MAX_DEPTH = 16


def _merge_dirs(src_dir, dst_dir, rel_dir="", _depth=0):
    """Recursively merge src_dir into dst_dir.
    - Files: if conflict, auto-rename the incoming file.
    - Folders: recurse into matching subfolders.
    - Symlinks/junctions are refused — they could re-enter outside the root
      or create cycles. Depth is capped to avoid pathological loops.
    Returns (moved_count, renamed_list, error_list).
    """
    import shutil
    moved = 0
    renamed = []
    errors = []
    if _depth > _MERGE_DIRS_MAX_DEPTH:
        errors.append(f"Merge depth limit exceeded at {rel_dir or '.'}")
        return moved, renamed, errors
    if os.path.islink(src_dir) or os.path.islink(dst_dir):
        errors.append(f"Refused to merge symlinked directory: {rel_dir or '.'}")
        return moved, renamed, errors
    for item_name in os.listdir(src_dir):
        item_src = os.path.join(src_dir, item_name)
        item_dst = os.path.join(dst_dir, item_name)
        # Never follow symlinks into either side — they could escape the root.
        if os.path.islink(item_src):
            errors.append(f"Skipped symlink at source: {item_name}")
            continue
        if os.path.lexists(item_dst) and os.path.islink(item_dst):
            errors.append(f"Skipped symlink at destination: {item_name}")
            continue
        if os.path.exists(item_dst):
            # Both are directories → recurse
            if os.path.isdir(item_src) and os.path.isdir(item_dst):
                child_rel = _format_storage_rel("/".join(p for p in (rel_dir, item_name) if p))
                m, r, e = _merge_dirs(item_src, item_dst, child_rel, _depth=_depth + 1)
                moved += m
                renamed.extend(r)
                errors.extend(e)
                continue
            # Conflict (file↔file, file↔dir, dir↔file) → rename
            new_name = _auto_rename(dst_dir, item_name)
            item_dst = os.path.join(dst_dir, new_name)
            renamed.append({
                "original": item_name,
                "renamed": new_name,
                "originalPath": _format_storage_rel("/".join(p for p in (rel_dir, item_name) if p)),
                "renamedPath": _format_storage_rel("/".join(p for p in (rel_dir, new_name) if p)),
                "subfolder": _format_storage_rel(rel_dir),
                "isFolder": os.path.isdir(item_src),
            })
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
    _require_same_origin(request)
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    # 'root' = destination root, 'srcRoot' = source root (defaults to root)
    root_name = _body_str(body, "root", "output").lower()
    if root_name == "temp":
        return web.json_response({"error": "Move to Temp is not allowed"}, status=403)
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    dest_root = getter()

    src_root_name = _body_str(body, "srcRoot", root_name).lower()
    src_getter = _ALLOWED_ROOTS.get(src_root_name)
    if src_getter is None:
        return web.json_response({"error": "Unknown srcRoot"}, status=400)
    src_root = src_getter()

    files = body.get("files", [])
    if not isinstance(files, list):
        return web.json_response({"error": "files must be a list"}, status=400)
    dest_subfolder = _body_str(body, "destSubfolder")
    conflict = _body_str(body, "conflict", "skip").lower()
    if conflict not in ("skip", "rename", "overwrite"):
        conflict = "skip"
    if not files:
        return web.json_response({"error": "No files"}, status=400)

    # Validate destination
    dest_dir = _safe_path(dest_root, dest_subfolder) if dest_subfolder else dest_root
    if dest_dir is None:
        return web.json_response({"error": "Invalid destination"}, status=400)

    # The move loop touches the filesystem heavily (makedirs, shutil.move,
    # recursive merge, thumbnail cache moves, search-index updates). Run
    # the whole thing on a worker thread so the event loop is free during
    # large folder moves.
    def _do_move():
        import shutil
        os.makedirs(dest_dir, exist_ok=True)

        moved = 0
        skipped = 0
        renamed = []
        errors = []
        index_updated = 0
        for item in files:
            if not isinstance(item, dict):
                continue
            subfolder = _body_str(item, "subfolder")
            name = _body_str(item, "name")
            if not _is_plain_name(name):
                continue
            src_path = _safe_path(src_root, subfolder, name) if subfolder else _safe_path(src_root, name)
            if src_path is None or not os.path.exists(src_path):
                errors.append(f"Not found: {name}")
                continue
            is_dir = os.path.isdir(src_path)
            dst_path = _safe_path(dest_root, dest_subfolder, name) if dest_subfolder else _safe_path(dest_root, name)
            if dst_path is None:
                errors.append(f"Invalid destination: {name}")
                continue
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
                    dst_path = _safe_path(dest_root, dest_subfolder, new_name) if dest_subfolder else _safe_path(dest_root, new_name)
                    if dst_path is None:
                        errors.append(f"Invalid destination: {new_name}")
                        continue
                    renamed.append({"original": name, "renamed": new_name})
                elif conflict == "overwrite":
                    # Folder + Folder → recursive merge (non-destructive)
                    if os.path.isdir(src_path) and os.path.isdir(dst_path):
                        m, r, e = _merge_dirs(src_path, dst_path)
                        if m > 0:
                            moved += 1
                            dest_name = os.path.basename(dst_path)
                            src_prefix = _format_storage_rel("/".join(p for p in (subfolder, name) if p))
                            dest_prefix = _format_storage_rel("/".join(p for p in (dest_subfolder, dest_name) if p))
                            for renamed_item in r:
                                original_path = _format_storage_rel(renamed_item.get("originalPath", ""))
                                renamed_path = _format_storage_rel(renamed_item.get("renamedPath", ""))
                                original_dir, original_name = os.path.split(original_path)
                                renamed_dir, renamed_name = os.path.split(renamed_path)
                                if not original_name or not renamed_name:
                                    continue
                                _move_gallery_thumbnail_cache(
                                    src_root,
                                    _format_storage_rel("/".join(p for p in (src_prefix, original_dir) if p)),
                                    original_name,
                                    dest_root,
                                    _format_storage_rel("/".join(p for p in (dest_prefix, renamed_dir) if p)),
                                    renamed_name,
                                    is_dir=bool(renamed_item.get("isFolder")),
                                )
                            _move_gallery_thumbnail_cache(
                                src_root,
                                subfolder,
                                name,
                                dest_root,
                                dest_subfolder,
                                dest_name,
                                is_dir=True,
                            )
                            index_updated += _search_index.note_path_moved(
                                src_root_name,
                                subfolder,
                                name,
                                root_name,
                                dest_subfolder,
                                dest_name,
                                is_dir=True,
                            )
                            for renamed_item in r:
                                rename_rel_dir = _format_storage_rel(renamed_item.get("subfolder", ""))
                                rename_subfolder = _format_storage_rel("/".join(
                                    p for p in (dest_prefix, rename_rel_dir) if p
                                ))
                                renamed_path = _safe_path(
                                    dest_root,
                                    rename_subfolder,
                                    renamed_item.get("renamed", ""),
                                )
                                index_updated += _search_index.note_path_moved(
                                    root_name,
                                    rename_subfolder,
                                    renamed_item.get("original", ""),
                                    root_name,
                                    rename_subfolder,
                                    renamed_item.get("renamed", ""),
                                    is_dir=bool(renamed_item.get("isFolder")),
                                    dest_path=None if renamed_item.get("isFolder") else renamed_path,
                                )
                        renamed.extend(r)
                        errors.extend(e)
                        continue
                    # File → overwrite. CONVENTIONS: gallery-browsed media must
                    # go through the recycle bin, never `os.remove`.
                    if _send2trash is None:
                        errors.append(f"Cannot overwrite {name}: send2trash not installed")
                        continue
                    if not _trash_file(dst_path):
                        errors.append(f"Cannot overwrite {name}: trash failed")
                        continue
            try:
                shutil.move(src_path, dst_path)
                moved += 1
                _move_gallery_thumbnail_cache(
                    src_root,
                    subfolder,
                    name,
                    dest_root,
                    dest_subfolder,
                    os.path.basename(dst_path),
                    is_dir=is_dir,
                )
                index_updated += _search_index.note_path_moved(
                    src_root_name,
                    subfolder,
                    name,
                    root_name,
                    dest_subfolder,
                    os.path.basename(dst_path),
                    is_dir=is_dir,
                    dest_path=None if is_dir else dst_path,
                )
            except Exception as e:
                errors.append(f"Error moving {name}: {e}")
        return moved, skipped, renamed, errors, index_updated

    moved, skipped, renamed, errors, index_updated = await asyncio.to_thread(_do_move)
    return web.json_response({
        "moved": moved, "skipped": skipped,
        "renamed": renamed, "errors": errors, "indexUpdated": index_updated,
    })


# -- Mkdir --

@_routes.post("/drawer/fs/mkdir")
async def fs_mkdir(request):
    """POST /drawer/fs/mkdir
    Body: { root: "output", subfolder: "path/to/parent", name: "NewFolder" }
    Creates a new directory inside root/subfolder.
    """
    _require_same_origin(request)
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    root_name = _body_str(body, "root", "output").lower()
    if root_name == "temp":
        return web.json_response({"error": "Folder creation in Temp is not allowed"}, status=403)
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    root = getter()
    subfolder = _body_str(body, "subfolder")
    name = _body_str(body, "name")
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
        await asyncio.to_thread(os.makedirs, target)
        return web.json_response({"ok": True, "path": (subfolder + "/" + name).strip("/")})
    except Exception as e:
        return _internal_error(e, where="fs_mkdir")


# -- Rename --

@_routes.post("/drawer/fs/rename")
async def fs_rename(request):
    """POST /drawer/fs/rename
    Body: { root: "output", subfolder: "2026-03", oldName: "old.png", newName: "new.png" }
    Renames a file or folder. Rejects if newName already exists.
    """
    _require_same_origin(request)
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    root_name = _body_str(body, "root", "output").lower()
    getter = _ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return web.json_response({"error": "Unknown root"}, status=400)
    root = getter()
    subfolder = _body_str(body, "subfolder")
    old_name = _body_str(body, "oldName")
    new_name = _body_str(body, "newName")
    if not old_name or not new_name:
        return web.json_response({"error": "Both oldName and newName required"}, status=400)
    if not _is_plain_name(old_name) or not _is_plain_name(new_name):
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
    def _do_rename():
        is_dir = os.path.isdir(src)
        os.rename(src, dst)
        _move_gallery_thumbnail_cache(
            root,
            subfolder,
            old_name,
            root,
            subfolder,
            new_name,
            is_dir=is_dir,
        )
        index_updated = _search_index.note_path_moved(
            root_name,
            subfolder,
            old_name,
            root_name,
            subfolder,
            new_name,
            is_dir=is_dir,
            dest_path=None if is_dir else dst,
        )
        return index_updated

    try:
        index_updated = await asyncio.to_thread(_do_rename)
        return web.json_response({"ok": True, "renamed": True, "indexUpdated": index_updated})
    except Exception as e:
        return _internal_error(e, where="fs_rename")


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
    from .image_safety import DrawerImageTooLarge, open_image_checked
    _HAS_PIL = True
except ImportError:
    class DrawerImageTooLarge(ValueError):
        pass

    def open_image_checked(*_args, **_kwargs):
        raise ImportError("PIL/Pillow not installed")

    _HAS_PIL = False

_MAX_GRID_UPLOAD_BYTES = 64 * 1024 * 1024
_MAX_XYZ_CONFIG_BYTES = 256 * 1024
_MAX_MODEL_PREVIEW_BYTES = 32 * 1024 * 1024
_MODEL_SIDECAR_LOCK = threading.Lock()


async def _read_limited_stream(stream, limit):
    chunks = []
    total = 0
    while True:
        if hasattr(stream, "readany"):
            chunk = await stream.readany()
        elif hasattr(stream, "read_chunk"):
            chunk = await stream.read_chunk()
        else:
            chunk = await stream.read()
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValueError("request too large")
        chunks.append(chunk)
    return b"".join(chunks)


# Allowed CivitAI preview Content-Types. Restricts what we accept from the
# upstream API so a hostile mirror cannot dump arbitrary binaries next to
# user models. mp4/webm are kept because CivitAI legitimately stores
# animated previews; bytes are still size-capped and not image-verified.
_ALLOWED_PREVIEW_CONTENT_TYPES = (
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "video/mp4", "video/webm",
)
_MAX_PREVIEW_DOWNLOAD_BYTES = 32 * 1024 * 1024


async def _download_preview_to_file(url, dest_path, *,
                                    max_bytes=_MAX_PREVIEW_DOWNLOAD_BYTES,
                                    timeout_seconds=30):
    """Download an image/video preview to dest_path with safety guards.

    - Hard size cap on the response stream (no unbounded read()).
    - Content-Type allowlist (rejects HTML/JS/etc. masquerading as a preview).
    - Image bytes are verified through open_image_checked(verify=True) so
      attackers cannot plant non-image binaries that the UI will later trust.
    - Writes to a temp file beside dest_path and atomic-replaces, so a
      half-finished download never wins as a corrupt preview.

    Returns (ok: bool, error: str|None).
    """
    import aiohttp
    is_video = dest_path.lower().endswith((".mp4", ".webm"))
    buf = io.BytesIO()
    received = 0
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout_seconds)) as resp:
                if resp.status != 200:
                    return False, f"http_{resp.status}"
                content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                if content_type and content_type not in _ALLOWED_PREVIEW_CONTENT_TYPES:
                    return False, "bad_content_type"
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    received += len(chunk)
                    if received > max_bytes:
                        return False, "too_large"
                    buf.write(chunk)
    except asyncio.TimeoutError:
        return False, "timeout"
    except Exception as e:
        return False, f"network:{e}"

    data = buf.getvalue()
    if not data:
        return False, "empty"
    if not is_video:
        try:
            open_image_checked(BytesIO(data), verify=True)
        except DrawerImageTooLarge:
            return False, "image_too_large"
        except Exception:
            return False, "not_image"

    dest_dir = os.path.dirname(dest_path)
    try:
        os.makedirs(dest_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=os.path.basename(dest_path) + ".",
            suffix=".tmp",
            dir=dest_dir,
        )
    except OSError as e:
        return False, f"prepare_failed:{e}"
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp_path, dest_path)
        return True, None
    except Exception as e:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return False, f"write_failed:{e}"


def _atomic_write_text(path, writer, *, newline=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".",
        suffix=".tmp",
        dir=os.path.dirname(path),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline=newline) as f:
            writer(f)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _read_json_file(path, default=None):
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else (default if default is not None else {})
    except Exception:
        pass
    return default if default is not None else {}


def _write_json_file_atomic(path, data):
    _atomic_write_text(
        path,
        lambda f: json.dump(data, f, ensure_ascii=False, indent=2),
    )


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
    _require_same_origin(request)
    if not _HAS_PIL:
        return web.json_response({"error": "PIL/Pillow not installed"}, status=500)
    if request.content_length and request.content_length > _MAX_GRID_UPLOAD_BYTES:
        return web.json_response({"error": "request too large"}, status=413)

    try:
        # Read body manually to avoid aiohttp's default client_max_size (1MB)
        raw = await _read_limited_stream(request.content, _MAX_GRID_UPLOAD_BYTES)
        data = json.loads(raw)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=413)
    except Exception as e:
        logger.warning(f"save_grid: JSON parse error: {e}")
        return web.json_response({"error": f"Invalid JSON: {e}"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"error": "JSON object required"}, status=400)

    image_b64 = _body_str(data, "image_data")
    filename_prefix = _body_str(data, "filename_prefix", "ComfyDrawer/xyz_plot")
    fmt = _body_str(data, "format", "png").lower()
    quality = _body_int(data, "quality", 95, minimum=1, maximum=100)
    save_metadata = data.get("save_metadata", True)
    workflow_json = data.get("workflow_json", None)
    xyz_config_raw = data.get("xyz_config", None)
    # Validate xyz_config: must round-trip as JSON object and fit a hard cap.
    # The cap mirrors the frontend's; if the client sent more we drop it
    # rather than letting an attacker bloat the PNG.
    xyz_config_json = None
    if isinstance(xyz_config_raw, str):
        if len(xyz_config_raw.encode("utf-8")) <= _MAX_XYZ_CONFIG_BYTES:
            try:
                parsed = json.loads(xyz_config_raw)
                if isinstance(parsed, dict):
                    xyz_config_json = xyz_config_raw
            except (ValueError, TypeError):
                pass
    elif isinstance(xyz_config_raw, dict):
        try:
            encoded = json.dumps(xyz_config_raw, ensure_ascii=False)
        except (TypeError, ValueError):
            encoded = None
        if encoded and len(encoded.encode("utf-8")) <= _MAX_XYZ_CONFIG_BYTES:
            xyz_config_json = encoded

    # Strip data URL header if present
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(image_b64)
        img = open_image_checked(BytesIO(image_bytes), copy=True)
    except DrawerImageTooLarge as e:
        return web.json_response({"error": str(e)}, status=413)
    except Exception as e:
        return web.json_response({"error": f"Invalid image data: {e}"}, status=400)

    # Expand variables in prefix
    filename_prefix = _expand_vars(filename_prefix)

    # Resolve output path. Normalise to forward-slash form first so the
    # split is consistent across Windows/POSIX, then go through _safe_path
    # which resolves symlinks and refuses anything outside the realpath
    # of the output directory.
    output_dir = os.path.realpath(folder_paths.get_output_directory())
    normalized = os.path.normpath(filename_prefix).replace("\\", "/").strip("/")
    subfolder = os.path.dirname(normalized)
    basename = os.path.basename(normalized)
    if not basename or not _is_plain_name(basename):
        return web.json_response({"error": "Invalid filename prefix"}, status=400)
    full_folder = _safe_path(output_dir, subfolder) if subfolder else output_dir
    if full_folder is None:
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
        if xyz_config_json:
            # Validated as a dict-shaped JSON string above; embed as iTXt
            # (zTXt-compressed) so axis lists with many values stay compact.
            metadata.add_itxt("xyz_plot", xyz_config_json, zip=True)
        metadata.add_text("comfy-drawer", "xyz_plot_grid")
        save_kwargs["pnginfo"] = metadata
    elif save_metadata and ext in (".jpg", ".webp") and (workflow_json or xyz_config_json):
        # Embed workflow using ComfyUI's native WebP metadata format:
        #   EXIF 0x010F (Make) = "workflow:JSON"
        #   EXIF 0x0110 (Model) = "prompt:JSON"  (if available)
        # Drawer-owned sweep config goes into 0x010E (ImageDescription) as
        #   "xyz_plot:JSON" — same "key:JSON" envelope the reader already
        #   accepts for tags 0x010D..0x0110.
        try:
            exif_data = img.getexif()
            if workflow_json:
                wf_obj = json.loads(workflow_json) if isinstance(workflow_json, str) else workflow_json
                exif_data[0x010F] = "workflow:{}".format(json.dumps(wf_obj))
            if xyz_config_json:
                exif_data[0x010E] = "xyz_plot:{}".format(xyz_config_json)
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
#  ModelViewer API — Model thumbnails and sidecar metadata
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


def _iter_preview_sidecars(model_path):
    """Yield existing custom preview sidecars for a model file."""
    base_no_ext = os.path.splitext(model_path)[0]
    for ext in _THUMB_PREVIEW_EXTS:
        candidate = base_no_ext + ext
        if os.path.isfile(candidate):
            yield candidate


def _remove_stale_preview_sidecars(model_path, keep_path=None):
    """Remove old .preview.* sidecars so a new preview wins deterministically."""
    keep_real = os.path.realpath(keep_path) if keep_path else None
    removed = []
    for preview in list(_iter_preview_sidecars(model_path)):
        if keep_real and os.path.realpath(preview) == keep_real:
            continue
        try:
            os.remove(preview)
            removed.append(preview)
        except OSError as e:
            logger.warning(f"[ModelViewer] Failed to remove stale preview {preview}: {e}")
    return removed


def _make_preview_temp_path(preview_path):
    """Create a temporary file next to the preview so os.replace stays atomic."""
    fd, temp_path = tempfile.mkstemp(
        prefix=os.path.basename(preview_path) + ".",
        suffix=".tmp",
        dir=os.path.dirname(preview_path),
    )
    return fd, temp_path


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

    # Resolve model to absolute path via folder_paths (covers custom paths)
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
        "path": "SDXL/foo.safetensors",
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
        "path": filename.replace("\\", "/"),
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
    _require_same_origin(request)
    category = request.match_info["category"]
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    filename = _body_str(body, "filename")
    trigger_words = body.get("triggerWords", [])
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    drawer_path = model_path + ".drawer.json"

    # Read existing .drawer.json or start fresh
    try:
        with _MODEL_SIDECAR_LOCK:
            drawer_data = _read_json_file(drawer_path, {})
            drawer_data["triggerWords"] = [w for w in trigger_words if isinstance(w, str) and w.strip()]
            _write_json_file_atomic(drawer_path, drawer_data)
    except Exception as e:
        return _internal_error(e, where="save_trigger_words")

    return web.json_response({"ok": True, "triggerWords": drawer_data["triggerWords"]})


@_routes.post("/drawer/model-comment/{category}")
async def save_model_comment(request):
    """Save a user comment for a model.

    Expects JSON body: { "filename": "...", "comment": "..." }
    Saves to {model_path}.drawer.json alongside the model file.
    """
    _require_same_origin(request)
    category = request.match_info["category"]
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    filename = _body_str(body, "filename")
    comment = _body_str(body, "comment")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    drawer_path = model_path + ".drawer.json"

    # Read existing .drawer.json or start fresh
    try:
        with _MODEL_SIDECAR_LOCK:
            drawer_data = _read_json_file(drawer_path, {})
            comment = str(comment or "").strip()
            if comment:
                drawer_data["comment"] = comment
            else:
                drawer_data.pop("comment", None)
            _write_json_file_atomic(drawer_path, drawer_data)
    except Exception as e:
        return _internal_error(e, where="save_model_comment")

    return web.json_response({"ok": True})


@_routes.delete("/drawer/model-preview/{category}")
async def delete_model_preview(request):
    """Delete the preview image for a model file.

    Query param: ?filename=SDXL/foo.safetensors
    """
    _require_same_origin(request)
    category = request.match_info["category"]
    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    previews = list(_iter_preview_sidecars(model_path))
    if not previews:
        return web.json_response({"error": "no preview"}, status=404)

    failed = []
    for preview in previews:
        if not _trash_file(preview):
            failed.append(os.path.basename(preview))
    if failed:
        return web.json_response({"error": "failed to move preview to trash", "failed": failed}, status=500)

    return web.json_response({"ok": True, "deleted": len(previews)})


@_routes.post("/drawer/model-preview/{category}")
async def upload_model_preview(request):
    """Upload a custom preview image for a model file.

    Expects multipart form: filename (text) + image (file)
    Saves as {model_base}.preview.{ext}
    """
    _require_same_origin(request)
    category = request.match_info["category"]
    if not _HAS_PIL:
        return web.json_response({"error": "PIL/Pillow not installed"}, status=500)
    if request.content_length and request.content_length > _MAX_MODEL_PREVIEW_BYTES:
        return web.json_response({"error": "request too large"}, status=413)

    try:
        reader = await _multipart_reader(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)
    filename = None
    image_data = None
    image_ext = '.png'

    try:
        async for part in reader:
            if part.name == 'filename':
                filename = _as_str(await part.text()).strip()
            elif part.name == 'image':
                try:
                    image_data = await _read_limited_stream(part, _MAX_MODEL_PREVIEW_BYTES)
                except ValueError as e:
                    return web.json_response({"error": str(e)}, status=413)
                ct = part.headers.get('Content-Type', '')
                if 'jpeg' in ct or 'jpg' in ct:
                    image_ext = '.jpeg'
                elif 'webp' in ct:
                    image_ext = '.webp'
                elif 'png' in ct:
                    image_ext = '.png'
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=413)
    except Exception:
        return web.json_response({"error": "Invalid multipart form"}, status=400)

    if not filename or not image_data:
        return web.json_response({"error": "filename and image required"}, status=400)

    try:
        fmt = str(open_image_checked(BytesIO(image_data), verify=True) or "").lower()
    except DrawerImageTooLarge as e:
        return web.json_response({"error": str(e)}, status=413)
    except Exception as e:
        return web.json_response({"error": f"invalid image: {e}"}, status=400)
    if fmt == "jpeg":
        image_ext = ".jpeg"
    elif fmt == "webp":
        image_ext = ".webp"
    elif fmt == "png":
        image_ext = ".png"
    else:
        return web.json_response({"error": "unsupported image format"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "not found"}, status=404)

    base_no_ext = os.path.splitext(model_path)[0]
    preview_path = base_no_ext + '.preview' + image_ext

    temp_path = None
    try:
        fd, temp_path = _make_preview_temp_path(preview_path)
        with os.fdopen(fd, 'wb') as f:
            f.write(image_data)
        with _MODEL_SIDECAR_LOCK:
            _remove_stale_preview_sidecars(model_path, keep_path=preview_path)
            os.replace(temp_path, preview_path)
            temp_path = None
    except Exception as e:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass
        return _internal_error(e, where="upload_model_preview")

    return web.json_response({"ok": True, "path": preview_path.replace("\\", "/")})


@_routes.delete("/drawer/model/{category}")
async def delete_model(request):
    """Delete a model file and all its sidecar files.

    Query: ?filename=SDXL/foo.safetensors
    Removes: foo.safetensors, foo.safetensors.civitai.info, foo.safetensors.drawer.json,
             foo.preview.*, foo.png, foo.jpg, etc.
    """
    _require_same_origin(request)
    category = request.match_info["category"]
    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)
    if _send2trash is None:
        return web.json_response(
            {"error": "Delete unavailable: send2trash is not installed (pip install send2trash)"},
            status=503,
        )

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path or not os.path.isfile(model_path):
        return web.json_response({"error": "not found"}, status=404)

    # The listdir + multiple send2trash calls are blocking I/O. Push the
    # whole sequence to a worker thread so a model directory with many
    # files (LoRA hubs, etc.) doesn't stall the event loop.
    def _do_delete_model():
        deleted = []
        errors = []

        # Delete the model file itself
        if _trash_file(model_path):
            deleted.append(os.path.basename(model_path))
        else:
            return None, "Failed to move model to trash"

        # Sidecars specific to this exact model filename (suffixes append
        # to the full basename, not the stem, so they cannot collide with
        # siblings).
        sidecar_patterns = [
            model_path + ".civitai.info",
            model_path + ".drawer.json",
        ]

        # Shared-stem previews (foo.preview.*, foo.png, foo.jpg, ...)
        # belong to ALL models that share the stem (e.g. foo.safetensors +
        # foo.ckpt). Only sweep them up when this is the last model with
        # that stem in the directory — otherwise we would orphan the
        # sibling's preview.
        model_dir = os.path.dirname(model_path)
        model_basename = os.path.basename(model_path)
        model_stem = os.path.splitext(model_basename)[0]
        _SHARED_PREVIEW_EXTS = (
            '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm',
            '.info', '.json', '.yaml', '.yml', '.txt',
        )
        has_sibling = False
        try:
            for f in os.listdir(model_dir):
                if f == model_basename:
                    continue
                f_stem, f_ext = os.path.splitext(f)
                if f_stem != model_stem:
                    continue
                if f_ext.lower() in _SHARED_PREVIEW_EXTS:
                    continue
                has_sibling = True
                break
        except OSError:
            has_sibling = True

        if not has_sibling:
            base_no_ext = os.path.splitext(model_path)[0]
            for ext in _THUMB_PREVIEW_EXTS:
                candidate = base_no_ext + ext
                if os.path.isfile(candidate):
                    sidecar_patterns.append(candidate)
            for ext in ('.png', '.jpg', '.jpeg', '.webp'):
                candidate = base_no_ext + ext
                if os.path.isfile(candidate):
                    sidecar_patterns.append(candidate)

        seen = set()
        for path in sidecar_patterns:
            if path in seen:
                continue
            seen.add(path)
            # Skip non-files and symlinks: send2trash on a symlink can
            # affect the target rather than the link on some platforms.
            if not os.path.isfile(path) or os.path.islink(path):
                continue
            if _trash_file(path):
                deleted.append(os.path.basename(path))
            else:
                errors.append(f"{os.path.basename(path)}: failed to move to trash")

        # Invalidate folder_paths cache so ComfyUI picks up the change
        try:
            folder_paths.invalidate_cache(category)
        except Exception:
            pass  # Some ComfyUI versions may not have this method
        return (deleted, errors), None

    result, err = await asyncio.to_thread(_do_delete_model)
    if err is not None:
        return web.json_response({"error": err}, status=500)
    deleted, errors = result
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
    _require_same_origin(request)
    category = request.match_info["category"]
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    filename = _body_str(body, "filename")
    image_value = _body_str(body, "image")
    if not filename or not image_value:
        return web.json_response({"error": "filename and image required"}, status=400)

    model_path = folder_paths.get_full_path(category, filename)
    if not model_path:
        return web.json_response({"error": "model not found"}, status=404)

    # Resolve image path in output directory
    output_dir = os.path.realpath(folder_paths.get_output_directory())
    image_value = str(image_value).replace("\\", "/").strip("/")
    image_path = _safe_path(output_dir, image_value)
    if image_path is None or not os.path.isfile(image_path):
        return web.json_response({"error": "image not found"}, status=404)

    # Determine extension
    image_ext = os.path.splitext(image_path)[1].lower()
    if image_ext not in ('.png', '.jpg', '.jpeg', '.webp'):
        return web.json_response({"error": "unsupported image format"}, status=400)

    # Defence in depth: the extension check above is necessary but not
    # sufficient — the bytes must also pass Pillow's header verification
    # before we copy them into the model sidecar location (where the UI
    # will treat them as a trusted preview).
    if not _HAS_PIL:
        return web.json_response({"error": "PIL/Pillow not installed"}, status=500)
    try:
        open_image_checked(image_path, verify=True)
    except DrawerImageTooLarge as e:
        return web.json_response({"error": str(e)}, status=413)
    except Exception:
        return web.json_response({"error": "not a valid image"}, status=400)

    base_no_ext = os.path.splitext(model_path)[0]
    preview_path = base_no_ext + ".preview" + image_ext

    temp_path = None
    try:
        fd, temp_path = _make_preview_temp_path(preview_path)
        os.close(fd)
        _shutil.copy2(image_path, temp_path)
        with _MODEL_SIDECAR_LOCK:
            _remove_stale_preview_sidecars(model_path, keep_path=preview_path)
            os.replace(temp_path, preview_path)
            temp_path = None
    except Exception as e:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass
        return _internal_error(e, where="set_preview_from_output")

    return web.json_response({"ok": True, "path": preview_path.replace("\\", "/")})


@_routes.post("/drawer/model-folder/{category}")
async def create_model_folder(request):
    """Create a subfolder within a model category directory.

    JSON body: { "subfolder": "SDXL", "name": "NewFolder" }
    Creates the folder relative to the first folder path for that category.
    """
    _require_same_origin(request)
    category = request.match_info["category"]
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    subfolder = _body_str(body, "subfolder")
    name = _body_str(body, "name")
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
        return _internal_error(e, where="create_model_folder")

    return web.json_response({"ok": True, "path": target_dir.replace("\\", "/")})

@_routes.post("/drawer/civitai-sync/{category}")
async def civitai_sync(request):
    """Fetch metadata from CivitAI by SHA256 hash.

    Uses cached hash from .drawer.json when available to skip re-computation.
    Tries AutoV2 (first 10 chars of SHA256) first, then full SHA256 as fallback.

    Expects JSON body: { "filename": "SDXL/foo.safetensors", "force": false }
    Saves the CivitAI response as {model_path}.civitai.info.
    """
    _require_same_origin(request)
    import hashlib
    import aiohttp as _aiohttp
    import asyncio

    category = request.match_info["category"]
    try:
        body = await _read_json_body(request)
    except web.HTTPBadRequest as e:
        return _json_error(e.text, 400)

    filename = _body_str(body, "filename")
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
                        ok_dl, dl_err = await _download_preview_to_file(img_url, preview_path)
                        if not ok_dl:
                            logger.warning(
                                "[Drawer] Failed to download preview (cached path): %s",
                                dl_err,
                            )

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
                return _internal_error(e, where="civitai_sync.sha256", error="hash error")

        # Cache the hash in .drawer.json for future use
        try:
            with _MODEL_SIDECAR_LOCK:
                drawer_data = _read_json_file(drawer_path, drawer_data)
                drawer_data["sha256"] = sha256_hash
                _write_json_file_atomic(drawer_path, drawer_data)
        except Exception:
            pass

    # --- Step 2: Query CivitAI API ---
    async def _query_civitai(hash_value, host):
        url = f"https://{host}/api/v1/model-versions/by-hash/{hash_value}"
        async with _aiohttp.ClientSession() as session:
            async with session.get(url, timeout=_aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    return await resp.json()
                return None

    async def _query_civitai_hosts(hash_value):
        last_error = None
        for host in ("civitai.red", "civitai.com"):
            try:
                data = await _query_civitai(hash_value, host)
                if data:
                    data.setdefault("_drawer_civitai_host", host)
                    return data
            except Exception as e:
                last_error = e
        if last_error:
            raise last_error
        return None

    # Try AutoV2 first (first 10 chars — faster API lookup)
    civitai_data = None
    autov2 = sha256_hash[:10]

    try:
        civitai_data = await _query_civitai_hosts(autov2)
    except Exception:
        pass

    # Fallback to full SHA256
    if not civitai_data:
        try:
            civitai_data = await _query_civitai_hosts(sha256_hash)
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

    # --- Step 3: Save .civitai.info (atomic) ---
    try:
        _write_json_file_atomic(civitai_path, civitai_data)
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
                ok_dl, dl_err = await _download_preview_to_file(img_url, preview_path)
                if not ok_dl:
                    logger.warning("[Drawer] Failed to download preview: %s", dl_err)

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
    _require_same_origin(request)
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

    async def _query_civitai(session, hash_value, host):
        url = f"https://{host}/api/v1/model-versions/by-hash/{hash_value}"
        async with session.get(url, timeout=_aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status == 200:
                return await resp.json()
            return None

    async def _query_civitai_hosts(session, hash_value):
        for host in ("civitai.red", "civitai.com"):
            try:
                data = await _query_civitai(session, hash_value, host)
                if data:
                    data.setdefault("_drawer_civitai_host", host)
                    return data
            except Exception:
                continue
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
                    try:
                        with _MODEL_SIDECAR_LOCK:
                            drawer_data = _read_json_file(drawer_path, drawer_data)
                            if "sha256" not in drawer_data:
                                drawer_data["sha256"] = sha256_hash
                                _write_json_file_atomic(drawer_path, drawer_data)
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
                    civitai_data = await _query_civitai_hosts(session, autov2)
                except Exception:
                    pass

                if not civitai_data:
                    try:
                        civitai_data = await _query_civitai_hosts(session, sha256_hash)
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

                # Save .civitai.info (atomic)
                try:
                    _write_json_file_atomic(civitai_path, civitai_data)
                except Exception:
                    pass

                # Download preview if missing — size-capped, image-verified,
                # atomic-replaced (see _download_preview_to_file).
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
                            await _download_preview_to_file(img_url, preview_path)

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


@_routes.post("/drawer/clear-cache")
async def clear_drawer_cache(request):
    """Clear Drawer's own cache files:
    - .thumbs/ directories inside each allowed root (output, input)
    - Search index SQLite DB (drawer_index.db)

    Returns: { "ok": true, "deleted": <count>, "freedBytes": <bytes> }
    """
    _require_same_origin(request)
    body = await _read_json_body(request, default={})
    clear_thumbnails = bool(body.get("thumbnails", True))
    clear_index = bool(body.get("index", True))
    if not clear_thumbnails and not clear_index:
        return web.json_response({"error": "No cache targets selected"}, status=400)

    if clear_index:
        # Close SQLite before deleting files. On Windows, deleting an open DB can
        # silently fail or leave WAL/SHM files out of the accounting path.
        _search_index.clear_index()

    # The filesystem walk + rmtree + os.unlink calls below are heavy
    # blocking I/O; run the whole sweep on a worker thread.
    def _do_clear():
        deleted = 0
        freed_bytes = 0
        errors = []

        # 1. Remove .thumbs/ cache directories from each FS root. Walk with
        # followlinks=False (default) but explicitly skip symlinked
        # subdirectories so we never trash anything outside .thumbs/.
        if clear_thumbnails:
            for root_name, root_fn in _ALLOWED_ROOTS.items():
                try:
                    root_dir = root_fn()
                    thumb_dir = os.path.join(root_dir, ".thumbs")
                    if not os.path.isdir(thumb_dir) or os.path.islink(thumb_dir):
                        continue
                    for dirpath, dirnames, filenames in os.walk(thumb_dir):
                        dirnames[:] = [
                            d for d in dirnames
                            if not os.path.islink(os.path.join(dirpath, d))
                        ]
                        for f in filenames:
                            fp = os.path.join(dirpath, f)
                            if os.path.islink(fp):
                                continue
                            try:
                                freed_bytes += os.path.getsize(fp)
                                deleted += 1
                            except OSError:
                                pass
                    _shutil.rmtree(thumb_dir, ignore_errors=True)
                except Exception as e:
                    errors.append(f"{root_name}/.thumbs: {e}")

        # 2. Remove search index DB
        if clear_index:
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
        return deleted, freed_bytes, errors

    deleted, freed_bytes, errors = await asyncio.to_thread(_do_clear)

    if errors:
        logger.warning(f"[Drawer] clear-cache partial errors: {errors[:3]}")

    return web.json_response({
        "ok": True,
        "deleted": deleted,
        "freedBytes": freed_bytes,
        "thumbnailsCleared": clear_thumbnails,
        "indexCleared": clear_index,
        "errors": errors,
    })


@_routes.post("/drawer/reboot")
async def drawer_reboot(request):
    """Restart the ComfyUI server process in-place.

    The reboot is scheduled on a background task so the response can flush
    to the client before exec replaces the process. A synchronous handler
    that calls os.execv() never sends the response.
    """
    _require_same_origin(request)
    if request.headers.get("X-Comfy-Drawer-Action") != "reboot":
        return web.json_response({"error": "Forbidden"}, status=403)

    def build_restart_argv():
        argv = list(sys.argv)
        if not argv:
            return [sys.executable]
        if "--windows-standalone-build" in argv:
            argv.remove("--windows-standalone-build")
        entry = argv[0]
        if entry.endswith("__main__.py"):
            module = os.path.basename(os.path.dirname(entry))
            return [sys.executable, "-m", module, *argv[1:]]
        return [sys.executable, *argv]

    cmds = build_restart_argv()
    cli_session = os.environ.get("__COMFY_CLI_SESSION__")

    async def _exec_after_response():
        # Give the response a chance to reach the client before we exec.
        await asyncio.sleep(0.4)
        if cli_session:
            try:
                with open(cli_session + ".reboot", "w"):
                    pass
            except OSError as e:
                logger.warning("[Drawer] failed to mark CLI reboot: %s", e)
            os._exit(0)
        # Log BEFORE closing the log stream — some launch wrappers (notably
        # ComfyUI-Manager's prestartup_script) wrap the logging handler
        # around a file that close_log() detaches. Any logger call AFTER
        # close_log() would raise "I/O operation on closed file" and abort
        # the task before os.execv runs, leaving the user stuck.
        logger.info("[Drawer] Restarting...")
        logger.info("[Drawer] Command: %s", cmds)
        # Some launch wrappers replace stdout with an object that must be
        # detached before exec, otherwise the replacement process can
        # inherit a broken stream. Do this only after the last logger call.
        try:
            sys.stdout.close_log()
        except Exception:
            pass
        try:
            os.execv(sys.executable, cmds)
        except Exception as e:
            # logger may be unusable here (close_log() above) — write
            # directly to the original stderr so the error is still visible.
            try:
                sys.__stderr__.write(f"[Drawer] os.execv failed: {e}\n")
            except Exception:
                pass

    asyncio.create_task(_exec_after_response())
    return web.json_response({"ok": True, "restarting": True})
