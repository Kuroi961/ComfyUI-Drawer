"""Built-in metadata contributors for XYZ Plot composite images.

XYZ Plot embeds a ``xyz_plot`` JSON blob into composite images (PNG tEXt /
iTXt, JPEG/WebP EXIF 0x010E). This module surfaces that blob to two places:

* Gallery search (``xyzPlot`` namespace): widget names, node titles, and
  values become searchable as ``xyzPlot:axis[steps cfg]``,
  ``xyzPlot:node[KSampler]``, ``xyzPlot:value[10]``.
* Metadata panel (lightbox info section): a human-readable summary of axes,
  zip flags, and step counts.
"""

import logging

logger = logging.getLogger("ComfyUI-Drawer")

_AXIS_KEYS = ("x", "y", "z")


def _get_xyz_meta(meta):
    if not isinstance(meta, dict):
        return None
    raw = meta.get("xyz_plot")
    if not isinstance(raw, dict):
        return None
    if raw.get("plugin") and raw.get("plugin") != "ComfyUI-Drawer":
        return None
    return raw


def _value_to_text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def contribute_xyz_search_fields(meta, ctx):
    xyz = _get_xyz_meta(meta)
    if not xyz:
        return None

    axes = xyz.get("axes") or {}
    axis_labels = []
    node_titles = []
    widget_names = []
    values_flat = []
    per_axis_values = {}

    for axis_key in _AXIS_KEYS:
        axis = axes.get(axis_key)
        if not isinstance(axis, dict):
            continue
        label = axis.get("widgetLabel") or axis.get("widgetName")
        name = axis.get("widgetName")
        node = axis.get("nodeTitle")
        if label:
            axis_labels.append(str(label))
        if name and name != label:
            widget_names.append(str(name))
        if node:
            node_titles.append(str(node))
        axis_values_text = []
        for v in axis.get("values") or []:
            text = _value_to_text(v).strip()
            if text:
                values_flat.append(text)
                axis_values_text.append(text)
        if axis_values_text:
            per_axis_values[f"values_{axis_key}"] = axis_values_text

    fields = {}
    if axis_labels:
        fields["axis"] = axis_labels
    if widget_names:
        fields["widget"] = widget_names
    if node_titles:
        fields["node"] = node_titles
    if values_flat:
        fields["value"] = values_flat
    fields.update(per_axis_values)

    zip_flags = xyz.get("zip") or {}
    if zip_flags.get("xy"):
        fields.setdefault("mode", []).append("zip_xy")
    if zip_flags.get("yz"):
        fields.setdefault("mode", []).append("zip_yz")

    if not fields:
        return None
    return {"namespace": "xyzPlot", "fields": fields}


def _format_axis_row(axis):
    if not isinstance(axis, dict):
        return None
    label = axis.get("widgetLabel") or axis.get("widgetName") or "?"
    node = axis.get("nodeTitle")
    values = axis.get("values") or []
    rendered = ", ".join(_value_to_text(v) for v in values)
    parts = [str(label)]
    if node:
        parts.append(f"@ {node}")
    summary = " ".join(parts)
    if rendered:
        summary = f"{summary} = [{rendered}]"
    return summary


def contribute_xyz_metadata_panel(meta, ctx):
    xyz = _get_xyz_meta(meta)
    if not xyz:
        return None

    rows = []
    axes = xyz.get("axes") or {}
    for axis_key in _AXIS_KEYS:
        formatted = _format_axis_row(axes.get(axis_key))
        if formatted:
            rows.append({"label": axis_key.upper(), "value": formatted})

    zip_flags = xyz.get("zip") or {}
    zip_parts = []
    if zip_flags.get("xy"):
        zip_parts.append("X+Y")
    if zip_flags.get("yz"):
        zip_parts.append("Y+Z")
    if zip_parts:
        rows.append({"label": "Zip", "value": ", ".join(zip_parts)})

    sweep = xyz.get("sweep") or {}
    total = sweep.get("totalSteps")
    completed = sweep.get("completedSteps")
    if isinstance(total, int) or isinstance(completed, int):
        rows.append({
            "label": "Steps",
            "value": f"{completed if completed is not None else '?'} / {total if total is not None else '?'}",
        })

    version = xyz.get("version")
    if version:
        rows.append({"label": "Drawer", "value": str(version)})

    if not rows:
        return None
    return {"title": "XYZ Plot", "fields": {row["label"]: row["value"] for row in rows}}


def register_builtin_xyz_contributors():
    """Register the XYZ Plot index + panel contributors.

    Safe to call multiple times — the contributors deduplicate by name.
    Returns a callable that unregisters both, useful for tests.
    """
    from . import metadata_ext
    unreg_index = metadata_ext.register_index_contributor(
        contribute_xyz_search_fields,
        name="drawer-xyz-plot-index",
        priority=20,
    )
    unreg_panel = metadata_ext.register_metadata_panel_contributor(
        contribute_xyz_metadata_panel,
        name="drawer-xyz-plot-panel",
        priority=20,
    )

    def _unregister():
        try:
            unreg_index()
        except Exception:
            pass
        try:
            unreg_panel()
        except Exception:
            pass
    return _unregister
