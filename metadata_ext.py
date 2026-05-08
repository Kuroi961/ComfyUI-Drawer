"""Third-party metadata extension points for ComfyUI-Drawer."""

import json
import logging
import threading

logger = logging.getLogger("ComfyUI-Drawer")

_metadata_provider_lock = threading.Lock()
_metadata_providers = []
_index_contributor_lock = threading.Lock()
_index_contributors = []
_metadata_panel_contributor_lock = threading.Lock()
_metadata_panel_contributors = []
_dictionary_provider_lock = threading.Lock()
_dictionary_providers = []


def register_metadata_provider(provider, *, name=None, priority=50):
    """Register a Python raw metadata provider for Gallery indexing and metadata."""
    if not callable(provider):
        raise TypeError("metadata provider must be callable")
    provider_name = name or getattr(provider, "__name__", "metadata-provider")
    item = {
        "name": str(provider_name),
        "priority": int(priority),
        "provider": provider,
    }
    with _metadata_provider_lock:
        _metadata_providers[:] = [
            p for p in _metadata_providers
            if p["provider"] is not provider and p["name"] != item["name"]
        ]
        _metadata_providers.append(item)
        _metadata_providers.sort(key=lambda p: p["priority"])
    return lambda: unregister_metadata_provider(provider_name)


def unregister_metadata_provider(provider_or_name):
    """Unregister a metadata provider by callable or registered name."""
    with _metadata_provider_lock:
        before = len(_metadata_providers)
        _metadata_providers[:] = [
            p for p in _metadata_providers
            if p["provider"] is not provider_or_name and p["name"] != provider_or_name
        ]
        return len(_metadata_providers) != before


def register_index_contributor(contributor, *, name=None, priority=50):
    """Register a contributor that maps raw metadata to custom search fields."""
    if not callable(contributor):
        raise TypeError("index contributor must be callable")
    contributor_name = name or getattr(contributor, "__name__", "index-contributor")
    item = {
        "name": str(contributor_name),
        "priority": int(priority),
        "contributor": contributor,
    }
    with _index_contributor_lock:
        _index_contributors[:] = [
            c for c in _index_contributors
            if c["contributor"] is not contributor and c["name"] != item["name"]
        ]
        _index_contributors.append(item)
        _index_contributors.sort(key=lambda c: c["priority"])
    return lambda: unregister_index_contributor(contributor_name)


def unregister_index_contributor(contributor_or_name):
    """Unregister an index contributor by callable or registered name."""
    with _index_contributor_lock:
        before = len(_index_contributors)
        _index_contributors[:] = [
            c for c in _index_contributors
            if c["contributor"] is not contributor_or_name and c["name"] != contributor_or_name
        ]
        return len(_index_contributors) != before


def has_index_contributors():
    with _index_contributor_lock:
        return bool(_index_contributors)


def register_metadata_panel_contributor(contributor, *, name=None, priority=50):
    """Register a contributor that maps raw metadata to display sections."""
    if not callable(contributor):
        raise TypeError("metadata panel contributor must be callable")
    contributor_name = name or getattr(contributor, "__name__", "metadata-panel-contributor")
    item = {
        "name": str(contributor_name),
        "priority": int(priority),
        "contributor": contributor,
    }
    with _metadata_panel_contributor_lock:
        _metadata_panel_contributors[:] = [
            c for c in _metadata_panel_contributors
            if c["contributor"] is not contributor and c["name"] != item["name"]
        ]
        _metadata_panel_contributors.append(item)
        _metadata_panel_contributors.sort(key=lambda c: c["priority"])
    return lambda: unregister_metadata_panel_contributor(contributor_name)


def unregister_metadata_panel_contributor(contributor_or_name):
    """Unregister a metadata panel contributor by callable or registered name."""
    with _metadata_panel_contributor_lock:
        before = len(_metadata_panel_contributors)
        _metadata_panel_contributors[:] = [
            c for c in _metadata_panel_contributors
            if c["contributor"] is not contributor_or_name and c["name"] != contributor_or_name
        ]
        return len(_metadata_panel_contributors) != before


def register_dictionary_provider(provider, *, name=None, label=None, priority=50, context="all", default_enabled=True):
    """Register a provider that returns autocomplete dictionary entries."""
    if not callable(provider):
        raise TypeError("dictionary provider must be callable")
    provider_name = name or getattr(provider, "__name__", "dictionary-provider")
    item = {
        "name": str(provider_name),
        "label": str(label or provider_name),
        "priority": int(priority),
        "context": str(context or "all"),
        "default_enabled": bool(default_enabled),
        "provider": provider,
    }
    with _dictionary_provider_lock:
        _dictionary_providers[:] = [
            p for p in _dictionary_providers
            if p["provider"] is not provider and p["name"] != item["name"]
        ]
        _dictionary_providers.append(item)
        _dictionary_providers.sort(key=lambda p: p["priority"])
    return lambda: unregister_dictionary_provider(provider_name)


def unregister_dictionary_provider(provider_or_name):
    """Unregister a dictionary provider by callable or registered name."""
    with _dictionary_provider_lock:
        before = len(_dictionary_providers)
        _dictionary_providers[:] = [
            p for p in _dictionary_providers
            if p["provider"] is not provider_or_name and p["name"] != provider_or_name
        ]
        return len(_dictionary_providers) != before


def has_dictionary_providers():
    with _dictionary_provider_lock:
        return bool(_dictionary_providers)


def _callable_signature(func):
    module = getattr(func, "__module__", "")
    qualname = getattr(func, "__qualname__", getattr(func, "__name__", "callable"))
    code = getattr(func, "__code__", None)
    code_sig = ""
    if code is not None:
        code_sig = f"{code.co_filename}:{code.co_firstlineno}"
    return f"{module}.{qualname}@{code_sig}"


def metadata_pipeline_signature():
    with _metadata_provider_lock:
        providers = [
            {
                "name": item["name"],
                "priority": item["priority"],
                "callable": _callable_signature(item["provider"]),
            }
            for item in _metadata_providers
        ]
    with _index_contributor_lock:
        contributors = [
            {
                "name": item["name"],
                "priority": item["priority"],
                "callable": _callable_signature(item["contributor"]),
            }
            for item in _index_contributors
        ]
    payload = {
        "schema": 1,
        "providers": providers,
        "index_contributors": contributors,
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_provider_meta(ctx):
    with _metadata_provider_lock:
        providers = list(_metadata_providers)
    for item in providers:
        try:
            meta = item["provider"](dict(ctx))
        except Exception as e:
            logger.warning(f"Metadata provider {item['name']} failed: {e}")
            continue
        if isinstance(meta, dict):
            return meta, item["name"]
    return None, "none"


def _as_search_text(value):
    if isinstance(value, dict):
        parts = []
        for key, child in value.items():
            child_text = _as_search_text(child)
            if child_text:
                parts.append(str(key))
                parts.append(child_text)
        return " ".join(parts)
    if isinstance(value, (list, tuple, set)):
        return " ".join(_as_search_text(v) for v in value if v is not None)
    if value is None:
        return ""
    return str(value)


def _add_custom_entry(result, namespace, key, value):
    text = _as_search_text(value).strip()
    namespace = str(namespace or "").strip()
    key = str(key or "").strip()
    if not text:
        return
    result["custom"] = " ".join(part for part in (result.get("custom", ""), namespace, key, text) if part)
    result["custom_index"].append({
        "namespace": namespace,
        "key": key,
        "text": text,
    })


def _merge_custom_contribution(result, contribution, default_namespace=""):
    if not isinstance(contribution, dict):
        return
    namespace = str(contribution.get("namespace") or contribution.get("name") or default_namespace or "").strip()
    fields = contribution.get("fields")
    if isinstance(fields, dict):
        for key, value in fields.items():
            _add_custom_entry(result, namespace, key, value)
    values = contribution.get("values")
    if isinstance(values, dict):
        for key, value in values.items():
            _add_custom_entry(result, namespace, key, value)
    for key in ("custom", "text", "value"):
        if key in contribution:
            _add_custom_entry(result, namespace, "", contribution.get(key))
    search = contribution.get("search")
    if isinstance(search, dict):
        _merge_custom_contribution(result, search, namespace)


def apply_index_contributors(result, meta, ctx=None):
    with _index_contributor_lock:
        contributors = list(_index_contributors)
    if not contributors:
        return
    safe_ctx = dict(ctx or {})
    for item in contributors:
        try:
            contribution = item["contributor"](meta, safe_ctx)
        except Exception as e:
            logger.warning(f"Index contributor {item['name']} failed: {e}")
            continue
        _merge_custom_contribution(result, contribution, item["name"])


def _panel_text(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple, set)):
        try:
            return json.dumps(value, ensure_ascii=False, indent=2)
        except Exception:
            return str(value)
    return str(value)


def _normalize_panel_row(row):
    if isinstance(row, dict):
        label = str(row.get("label") or row.get("key") or row.get("name") or "").strip()
        value = _panel_text(row.get("value", row.get("text", ""))).strip()
    elif isinstance(row, (list, tuple)) and len(row) >= 2:
        label = str(row[0]).strip()
        value = _panel_text(row[1]).strip()
    else:
        return None
    if not label and not value:
        return None
    return {"label": label, "value": value}


def _normalize_panel_section(section, default_title=""):
    if not isinstance(section, dict):
        return None
    title = str(section.get("title") or section.get("namespace") or default_title or "").strip()
    rows = []
    section_rows = section.get("rows")
    if isinstance(section_rows, list):
        for row in section_rows:
            normalized = _normalize_panel_row(row)
            if normalized:
                rows.append(normalized)
    fields = section.get("fields")
    if isinstance(fields, dict):
        for key, value in fields.items():
            row = _normalize_panel_row({"label": key, "value": value})
            if row:
                rows.append(row)
    text = _panel_text(section.get("text", "")).strip()
    if not title and not rows and not text:
        return None
    return {"title": title, "rows": rows, "text": text}


def _normalize_panel_contribution(contribution, default_title=""):
    sections = []
    if not isinstance(contribution, dict):
        return sections
    contribution_sections = contribution.get("sections")
    if isinstance(contribution_sections, list):
        for section in contribution_sections:
            normalized = _normalize_panel_section(section, default_title)
            if normalized:
                sections.append(normalized)
    own_section = _normalize_panel_section(contribution, default_title)
    if own_section:
        sections.append(own_section)
    return sections


def apply_metadata_panel_contributors(meta, ctx=None):
    with _metadata_panel_contributor_lock:
        contributors = list(_metadata_panel_contributors)
    sections = []
    safe_ctx = dict(ctx or {})
    for item in contributors:
        try:
            contribution = item["contributor"](meta, safe_ctx)
        except Exception as e:
            logger.warning(f"Metadata panel contributor {item['name']} failed: {e}")
            continue
        sections.extend(_normalize_panel_contribution(contribution, item["name"]))
    return sections


def _normalize_dictionary_entry(entry):
    if not isinstance(entry, dict):
        return None
    tag = str(entry.get("t") or entry.get("tag") or entry.get("text") or "").strip()
    if not tag:
        return None
    result = {
        "t": tag,
        "c": int(entry.get("c", entry.get("category", -4)) or -4),
        "n": int(entry.get("n", entry.get("count", 999999)) or 999999),
    }
    insert_text = entry.get("insertText", entry.get("insert_text"))
    if insert_text:
        result["insertText"] = str(insert_text)
    display_text = entry.get("displayText", entry.get("display_text"))
    if display_text:
        result["displayText"] = str(display_text)
    orig = entry.get("orig")
    if orig:
        result["orig"] = str(orig)
    cursor_offset = entry.get("cursorOffset", entry.get("cursor_offset"))
    if isinstance(cursor_offset, (int, float)):
        result["cursorOffset"] = int(cursor_offset)
    return result


def read_dictionary_provider_entries():
    with _dictionary_provider_lock:
        providers = list(_dictionary_providers)
    provider_items = []
    for item in providers:
        try:
            provided = item["provider"]({"source": "drawer-dictionary"})
        except Exception as e:
            logger.warning(f"Dictionary provider {item['name']} failed: {e}")
            continue
        entries = []
        if isinstance(provided, dict):
            raw_entries = provided.get("entries", [])
        else:
            raw_entries = provided
        if isinstance(raw_entries, list):
            for raw_entry in raw_entries:
                entry = _normalize_dictionary_entry(raw_entry)
                if entry:
                    entries.append(entry)
        provider_items.append({
            "id": item["name"],
            "label": item["label"],
            "context": item["context"],
            "priority": item["priority"],
            "defaultEnabled": item["default_enabled"],
            "entries": entries,
        })
    return provider_items


def setup_metadata_extensions(prompt_server):
    setattr(prompt_server, "comfy_drawer_register_metadata_provider", register_metadata_provider)
    setattr(prompt_server, "comfy_drawer_unregister_metadata_provider", unregister_metadata_provider)
    setattr(prompt_server, "comfy_drawer_register_index_contributor", register_index_contributor)
    setattr(prompt_server, "comfy_drawer_unregister_index_contributor", unregister_index_contributor)
    setattr(prompt_server, "comfy_drawer_register_metadata_panel_contributor", register_metadata_panel_contributor)
    setattr(prompt_server, "comfy_drawer_unregister_metadata_panel_contributor", unregister_metadata_panel_contributor)
    setattr(prompt_server, "comfy_drawer_register_dictionary_provider", register_dictionary_provider)
    setattr(prompt_server, "comfy_drawer_unregister_dictionary_provider", unregister_dictionary_provider)
