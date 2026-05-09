"""Search query parsing and metadata text extraction for ComfyUI-Drawer."""

import json
import re

from .metadata_ext import apply_index_contributors


def parse_search_terms(query):
    include = []
    exclude = []
    buf = []
    in_quote = False
    quote_char = ""
    negating = False
    token_started = False

    def commit_term():
        nonlocal buf, negating, token_started
        term = "".join(buf).strip()
        if term:
            (exclude if negating else include).append(term)
        buf = []
        negating = False
        token_started = False

    for ch in (query or "").strip():
        if ch in ("'", '"'):
            if in_quote and ch == quote_char:
                commit_term()
                in_quote = False
                quote_char = ""
            elif not in_quote and not token_started:
                in_quote = True
                quote_char = ch
                token_started = True
            else:
                buf.append(ch)
        elif ch.isspace() and not in_quote:
            commit_term()
        elif ch == "-" and not in_quote and not token_started:
            negating = True
            token_started = True
        else:
            buf.append(ch)
            token_started = True
    commit_term()
    return {"include": include, "exclude": exclude}


def search_text_matches(haystack, terms):
    text = (haystack or "").lower()
    return (
        all(search_term_matches(text, term) for term in terms.get("include", []))
        and all(not search_term_matches(text, term) for term in terms.get("exclude", []))
    )


def search_term_matches(text, term):
    """Match search terms on alphanumeric token boundaries by default."""
    term = (term or "").lower()
    if not term:
        return True
    if term.isdigit():
        return term in text
    if term.isalnum():
        return re.search(rf"(?<![0-9a-z]){re.escape(term)}(?![0-9a-z])", text) is not None
    return term in text


def search_terms_empty(terms):
    return not terms.get("include") and not terms.get("exclude")


def parse_search_scopes(scope):
    allowed = {
        "name",
        "prompt_title", "prompt_value",
        "workflow_title", "workflow_value",
        "custom",
    }
    aliases = {
        "prompt": "prompt_title",
        "value": "prompt_value",
        "values": "prompt_value",
        "workflow": "workflow_title",
        "metadata": "custom",
    }
    parts = str(scope or "").split(",")
    scopes = []
    for part in parts:
        value = aliases.get(part.strip().lower(), part.strip().lower())
        if value in allowed and value not in scopes:
            scopes.append(value)
    return scopes or ["name", "prompt_value", "workflow_value"]


def quote_fts_term(term):
    text = str(term or "").strip()
    if not text:
        return ""
    return '"' + text.replace('"', '""') + '"'


def build_fts_query(terms, scopes, fts_cols):
    include_terms = [quote_fts_term(term) for term in terms.get("include", [])]
    include_terms = [term for term in include_terms if term]
    if not include_terms:
        return ""
    cols = [fts_cols[scope] for scope in scopes if scope in fts_cols]
    if not cols:
        return ""
    col_filter = "{" + " ".join(cols) + "}"
    return " AND ".join(f"{col_filter}: {term}" for term in include_terms)


def search_scope_group_matches(text_by_scope, terms, scopes):
    scopes = scopes or ["name", "prompt_value", "workflow_value"]
    scoped_texts = [str(text_by_scope.get(scope, "") or "").lower() for scope in scopes]
    return (
        all(
            any(search_term_matches(text, term) for text in scoped_texts)
            for term in terms.get("include", [])
        )
        and all(
            not any(search_term_matches(text, term) for text in scoped_texts)
            for term in terms.get("exclude", [])
        )
    )


def parse_node_search_clauses(query):
    clauses = []
    out = []
    i = 0
    text = query or ""
    while i < len(text):
        lower = text[i:].lower()
        if lower.startswith("type:"):
            kind = "type"
            prefix_len = 5
        elif lower.startswith("title:"):
            kind = "title"
            prefix_len = 6
        else:
            out.append(text[i])
            i += 1
            continue
        start = i
        i += prefix_len
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            out.append(text[start:])
            break
        if text[i] in ("'", '"'):
            quote = text[i]
            i += 1
            type_start = i
            while i < len(text) and text[i] != quote:
                i += 1
            node_type = text[type_start:i].strip()
            if i < len(text) and text[i] == quote:
                i += 1
        else:
            type_start = i
            if kind == "title":
                while i < len(text) and text[i] != "[":
                    i += 1
            else:
                while i < len(text) and text[i] != "[" and not text[i].isspace():
                    i += 1
            node_type = text[type_start:i].strip()
        while i < len(text) and text[i].isspace():
            i += 1
        if not node_type or i >= len(text) or text[i] != "[":
            out.append(text[start:i])
            continue
        i += 1
        depth = 1
        inner = []
        in_quote = False
        quote = ""
        while i < len(text) and depth > 0:
            ch = text[i]
            if ch in ("'", '"'):
                if in_quote and ch == quote:
                    in_quote = False
                    quote = ""
                elif not in_quote:
                    in_quote = True
                    quote = ch
                inner.append(ch)
            elif ch == "[" and not in_quote:
                depth += 1
                inner.append(ch)
            elif ch == "]" and not in_quote:
                depth -= 1
                if depth > 0:
                    inner.append(ch)
            else:
                inner.append(ch)
            i += 1
        if depth == 0:
            clauses.append({
                "kind": kind,
                "selector": node_type,
                "terms": parse_search_terms("".join(inner)),
            })
            out.append(" ")
        else:
            out.append(text[start:])
            break
    return " ".join("".join(out).split()), clauses


def parse_custom_search_clauses(query):
    clauses = []
    out = []
    i = 0
    text = query or ""
    while i < len(text):
        if not (text[i].isalpha() or text[i] == "_"):
            out.append(text[i])
            i += 1
            continue
        start = i
        while i < len(text) and (text[i].isalnum() or text[i] in ("_", "-", ".")):
            i += 1
        namespace = text[start:i].strip()
        if namespace.lower() in ("type", "title"):
            out.append(text[start:i])
            continue
        key = ""
        if i < len(text) and text[i] == ":":
            i += 1
            key_start = i
            while i < len(text) and text[i] != "[" and not text[i].isspace():
                i += 1
            key = text[key_start:i].strip()
        while i < len(text) and text[i].isspace():
            i += 1
        if not namespace or i >= len(text) or text[i] != "[":
            out.append(text[start:i])
            continue
        i += 1
        depth = 1
        inner = []
        in_quote = False
        quote = ""
        while i < len(text) and depth > 0:
            ch = text[i]
            if ch in ("'", '"'):
                if in_quote and ch == quote:
                    in_quote = False
                    quote = ""
                elif not in_quote:
                    in_quote = True
                    quote = ch
                inner.append(ch)
            elif ch == "[" and not in_quote:
                depth += 1
                inner.append(ch)
            elif ch == "]" and not in_quote:
                depth -= 1
                if depth > 0:
                    inner.append(ch)
            else:
                inner.append(ch)
            i += 1
        if depth == 0:
            clauses.append({
                "namespace": namespace,
                "key": key,
                "terms": parse_search_terms("".join(inner)),
            })
            out.append(" ")
        else:
            out.append(text[start:])
            break
    return " ".join("".join(out).split()), clauses


def node_filters_match(nodes_json, node_filters):
    if not node_filters:
        return True
    try:
        nodes = json.loads(nodes_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(nodes, list):
        return False
    for clause in node_filters:
        kind = clause.get("kind", "type")
        selector = str(clause.get("selector", "")).lower()
        terms = clause["terms"]
        matched = False
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if kind == "title":
                if selector not in str(node.get("title", "")).lower():
                    continue
            else:
                if str(node.get("type", "")).lower() != selector:
                    continue
            if search_terms_empty(terms) or search_text_matches(node.get("text", ""), terms):
                matched = True
                break
        if not matched:
            return False
    return True


def custom_filters_match(custom_json, custom_filters):
    if not custom_filters:
        return True
    try:
        entries = json.loads(custom_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(entries, list):
        return False
    for clause in custom_filters:
        namespace = str(clause.get("namespace", "")).lower()
        key = str(clause.get("key", "")).lower()
        terms = clause["terms"]
        matched = False
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("namespace", "")).lower() != namespace:
                continue
            if key and str(entry.get("key", "")).lower() != key:
                continue
            if search_terms_empty(terms) or search_text_matches(entry.get("text", ""), terms):
                matched = True
                break
        if not matched:
            return False
    return True


def _append_search_field(result, key, value):
    if key not in result:
        return
    if isinstance(value, (list, tuple, set)):
        value = " ".join(str(v) for v in value if v is not None)
    elif value is not None:
        value = str(value)
    if value:
        result[key] = " ".join(part for part in (result[key], value) if part)


def _merge_search_contribution(result, contribution):
    if not isinstance(contribution, dict):
        return
    search = contribution.get("search")
    if isinstance(search, dict):
        _merge_search_contribution(result, search)
    for key in ("prompt_title", "prompt_value", "workflow_title", "workflow_value"):
        value = contribution.get(key)
        _append_search_field(result, key, value)
    nodes_value = contribution.get("nodes")
    if isinstance(nodes_value, list):
        result["nodes"].extend(node for node in nodes_value if isinstance(node, dict))


def _as_search_text(value):
    if isinstance(value, dict):
        return " ".join(
            part
            for key, child in value.items()
            for part in (str(key), _as_search_text(child))
            if part
        )
    if isinstance(value, (list, tuple, set)):
        return " ".join(_as_search_text(v) for v in value if v is not None)
    if value is None:
        return ""
    return str(value)


def _add_custom_search_entry(result, namespace, key, value):
    text = _as_search_text(value).strip()
    if not text:
        return
    namespace = str(namespace or "").strip()
    key = str(key or "").strip()
    result["custom"] = " ".join(part for part in (result.get("custom", ""), namespace, key, text) if part)
    result["custom_index"].append({
        "namespace": namespace,
        "key": key,
        "text": text,
    })


def _extract_builtin_generation_metadata(result, meta):
    for namespace in ("a1111", "nai"):
        value = meta.get(namespace) if isinstance(meta, dict) else None
        if not isinstance(value, dict):
            continue
        for key, child in value.items():
            _add_custom_search_entry(result, namespace, key, child)
        prompt = value.get("prompt")
        negative = value.get("negative_prompt", value.get("uc"))
        if prompt:
            _append_search_field(result, "prompt_value", prompt)
        if negative:
            _append_search_field(result, "prompt_value", negative)


def extract_searchable_parts(meta, ctx=None):
    """Extract structured searchable parts from ComfyUI metadata."""
    prompt_title_parts = []
    prompt_value_parts = []
    workflow_title_parts = []
    workflow_value_parts = []
    nodes = []
    prompt = meta.get("prompt", {})
    if isinstance(prompt, dict):
        for _nid, node in prompt.items():
            if not isinstance(node, dict):
                continue
            node_parts = []
            ct = node.get("class_type", "")
            title = ""
            if ct:
                node_parts.append(ct)
            nm = node.get("_meta", {})
            if isinstance(nm, dict):
                t = nm.get("title", "")
                if t:
                    title = str(t)
                    prompt_title_parts.append(t)
                    node_parts.append(t)
            node_inputs = node.get("inputs", {})
            if isinstance(node_inputs, dict):
                for k, v in node_inputs.items():
                    node_parts.append(str(k))
                    if isinstance(v, str) and v:
                        prompt_value_parts.append(v)
                        node_parts.append(v)
                    elif isinstance(v, (int, float)):
                        prompt_value_parts.append(str(v))
                        node_parts.append(str(v))
            if ct:
                nodes.append({"type": str(ct), "title": title, "text": " ".join(node_parts)})
    workflow = meta.get("workflow", {})
    if isinstance(workflow, dict):
        for wn in workflow.get("nodes", []):
            if isinstance(wn, dict):
                node_parts = []
                title = ""
                t = wn.get("title", "")
                if t:
                    title = str(t)
                    workflow_title_parts.append(t)
                    node_parts.append(t)
                typ = wn.get("type", "")
                if typ:
                    node_parts.append(typ)
                for key in ("widgets_values", "inputs", "outputs"):
                    value = wn.get(key)
                    node_parts.append(key)
                    if isinstance(value, (list, tuple)):
                        values = [str(v) for v in value if isinstance(v, (str, int, float))]
                        workflow_value_parts.extend(values)
                        node_parts.extend(values)
                    elif isinstance(value, dict):
                        values = [str(v) for v in value.values() if isinstance(v, (str, int, float))]
                        node_parts.extend(str(k) for k in value.keys())
                        workflow_value_parts.extend(values)
                        node_parts.extend(values)
                if typ:
                    nodes.append({"type": str(typ), "title": title, "text": " ".join(node_parts)})
    result = {
        "prompt_title": " ".join(prompt_title_parts),
        "prompt_value": " ".join(prompt_value_parts),
        "workflow_title": " ".join(workflow_title_parts),
        "workflow_value": " ".join(workflow_value_parts),
        "custom": "",
        "custom_index": [],
        "nodes": nodes,
    }
    search = meta.get("search") if isinstance(meta, dict) else None
    if isinstance(search, dict):
        _merge_search_contribution(result, search)
    _extract_builtin_generation_metadata(result, meta)
    apply_index_contributors(result, meta, ctx)
    return result
