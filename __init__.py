"""
ComfyUI-Drawer - Gadget Platform for ComfyUI.

This package entrypoint intentionally stays small:
- node classes are registered in drawer_nodes.py
- HTTP routes and prompt hooks are registered by importing drawer_routes.py
- frontend assets are served from ./web
"""

from pathlib import Path
import re
import sys


def _sync_frontend_version():
    """Keep the frontend runtime version in sync with pyproject.toml."""
    root = Path(__file__).resolve().parent
    pyproject = root / "pyproject.toml"
    version_js = root / "web" / "js" / "version.js"
    try:
        text = pyproject.read_text(encoding="utf-8")
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
        if not match:
            return
        version = match.group(1)
        version_js.write_text(f"export const DRAWER_VERSION = '{version}';\n", encoding="utf-8")
    except OSError:
        pass


_sync_frontend_version()

from .drawer_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import drawer_routes as _drawer_routes  # noqa: F401 - route registration side effects

WEB_DIRECTORY = "./web"
register_metadata_provider = _drawer_routes.register_metadata_provider
unregister_metadata_provider = _drawer_routes.unregister_metadata_provider
register_index_contributor = _drawer_routes.register_index_contributor
unregister_index_contributor = _drawer_routes.unregister_index_contributor
register_metadata_panel_contributor = _drawer_routes.register_metadata_panel_contributor
unregister_metadata_panel_contributor = _drawer_routes.unregister_metadata_panel_contributor
register_dictionary_provider = _drawer_routes.register_dictionary_provider
unregister_dictionary_provider = _drawer_routes.unregister_dictionary_provider

sys.modules.setdefault("comfyui_drawer", sys.modules[__name__])

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "register_metadata_provider",
    "unregister_metadata_provider",
    "register_index_contributor",
    "unregister_index_contributor",
    "register_metadata_panel_contributor",
    "unregister_metadata_panel_contributor",
    "register_dictionary_provider",
    "unregister_dictionary_provider",
]
