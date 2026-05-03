"""
ComfyUI-Drawer - Gadget Platform for ComfyUI.

This package entrypoint intentionally stays small:
- node classes are registered in drawer_nodes.py
- HTTP routes and prompt hooks are registered by importing drawer_routes.py
- frontend assets are served from ./web
"""

from .drawer_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import drawer_routes as _drawer_routes  # noqa: F401 - route registration side effects

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
