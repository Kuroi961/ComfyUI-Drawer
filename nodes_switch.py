"""
DrawerSwitch — A/B type-matched switch node.

This file is a standalone V3 extension (no NODE_CLASS_MAPPINGS) so that
ComfyUI's loader picks up `comfy_entrypoint` for MatchType.Template support.
The main __init__.py has NODE_CLASS_MAPPINGS, which would cause the elif
branch for comfy_entrypoint to be skipped.
"""

from comfy_api.latest import ComfyExtension
from comfy_api.latest import io as _io
from typing_extensions import override

_MISSING = object()


class DrawerSwitchNode(_io.ComfyNode):
    """A/B switch: if B is connected and non-empty, output B; otherwise output A.

    Uses MatchType.Template so all ports (A, B, output) share the same type.
    Connecting one input locks the type; disconnecting all reverts to 'any'.
    """

    @classmethod
    def define_schema(cls):
        template = _io.MatchType.Template("drawer_switch")
        return _io.Schema(
            node_id="DrawerSwitch",
            display_name="📝 Switch (Drawer)",
            category="Drawer",
            description="A/B switch: output B if connected and non-empty, otherwise A",
            inputs=[
                _io.MatchType.Input("A", template=template, lazy=True, optional=True),
                _io.MatchType.Input("B", template=template, lazy=True, optional=True),
            ],
            outputs=[
                _io.MatchType.Output(template=template, display_name="output"),
            ],
        )

    @classmethod
    def validate_inputs(cls, A=_MISSING, B=_MISSING):
        if A is _MISSING and B is _MISSING:
            return "A と B の少なくとも1つを接続してください"
        return True

    @classmethod
    def check_lazy_status(cls, A=_MISSING, B=_MISSING):
        # Evaluate B first: if B is connected but not yet evaluated, request it
        if B is None:
            return ["B"]
        # If B is missing (not connected) or empty string, we need A
        if B is _MISSING or (isinstance(B, str) and not B.strip()):
            if A is None:
                return ["A"]
        # Otherwise B has a value, no need to evaluate A

    @classmethod
    def execute(cls, A=_MISSING, B=_MISSING) -> _io.NodeOutput:
        # B connected and has content → use B
        if B is not _MISSING:
            if isinstance(B, str):
                if B.strip():
                    return _io.NodeOutput(B)
            else:
                return _io.NodeOutput(B)
        # Fall back to A
        if A is not _MISSING:
            return _io.NodeOutput(A)
        # Both missing (shouldn't happen due to validate_inputs)
        return _io.NodeOutput(None)


class DrawerSwitchExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[_io.ComfyNode]]:
        return [DrawerSwitchNode]


async def comfy_entrypoint() -> DrawerSwitchExtension:
    return DrawerSwitchExtension()
