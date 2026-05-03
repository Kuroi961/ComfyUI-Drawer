"""ComfyUI node definitions for ComfyUI-Drawer."""

from .nodes_switch import DrawerSwitchNode

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Drawer Seed — A1111-style seed node
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MAX_SEED = 2**32 - 1  # numpy.random.seed() limit


class DrawerSeed:
    """Seed node with frontend-driven randomization.

    The `mode` widget controls behavior:
      - 'randomize': frontend generates a new seed before each queue
      - 'fixed': frontend leaves the current seed as-is

    The backend always receives a concrete seed value, preserving cache.
    Randomization happens in the frontend extension (beforeQueuePrompt).

    NOTE: `mode` is stripped from the prompt by the on_prompt handler so
    it does NOT affect the cache signature — only seed_value matters.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Named 'seed_value' (not 'seed') to prevent ComfyUI's frontend
                # from auto-adding control_after_generate which overrides values.
                "seed_value": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_SEED,
                }),
            },
            "optional": {
                # mode is optional so it can be stripped by on_prompt without
                # breaking validation. It's a frontend-only concern.
                "mode": (["randomize", "fixed"], {"default": "randomize"}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "execute"
    CATEGORY = "Drawer"

    def execute(self, seed_value, mode="fixed"):
        return {"ui": {"last_seed": [seed_value]}, "result": (seed_value,)}


NODE_CLASS_MAPPINGS["DrawerSeed"] = DrawerSeed
NODE_DISPLAY_NAME_MAPPINGS["DrawerSeed"] = "📝 Seed (Drawer)"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Drawer Controls — multi-control primitive for Deck
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class _DrawerControlsBase:
    """Compact multi-control node for Deck.

    Each slot has a value widget and a small definition string:

      int | Steps | 1 | 80 | 1 | 0
      float | CFG Scale | 1 | 20 | 0.5 | 1
      combo | Scheduler
      bool | Enable Debug
      string | Prefix
      string | Prompt | multiline

    The output type is '*' so each slot can feed the target widget directly.
    Deck only renders slots whose output is connected.
    """

    SLOT_COUNT = 1

    @classmethod
    def INPUT_TYPES(cls):
        required = {}
        for i in range(1, cls.SLOT_COUNT + 1):
            required[f"value_{i}"] = ("STRING", {"default": ""})
            required[f"def_{i}"] = ("STRING", {"default": ""})
        return {"required": required}

    FUNCTION = "execute"
    CATEGORY = "Drawer"

    @staticmethod
    def _parse_def(def_text):
        parts = [p.strip() for p in str(def_text or "").split("|")]
        kind = (parts[0] if parts else "").lower()
        if kind in ("integer", "number:int"):
            kind = "int"
        if kind in ("number", "num", "number:float"):
            kind = "float"
        if kind in ("boolean", "toggle"):
            kind = "bool"
        return kind

    @staticmethod
    def _to_bool(value):
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on", "enabled")

    def execute(self, **kwargs):
        out = []
        for i in range(1, self.SLOT_COUNT + 1):
            raw = kwargs.get(f"value_{i}", "")
            kind = self._parse_def(kwargs.get(f"def_{i}", ""))
            try:
                if kind == "int":
                    out.append(int(float(raw or 0)))
                elif kind == "float":
                    out.append(float(raw or 0))
                elif kind == "bool":
                    out.append(self._to_bool(raw))
                else:
                    out.append(str(raw))
            except Exception:
                out.append(raw)
        return tuple(out)


def _make_drawer_controls_class(slot_count):
    class DrawerControlsN(_DrawerControlsBase):
        SLOT_COUNT = slot_count
        RETURN_TYPES = tuple("*" for _ in range(slot_count))
        RETURN_NAMES = tuple(f"value_{i}" for i in range(1, slot_count + 1))

    DrawerControlsN.__name__ = f"DrawerControls{slot_count}"
    return DrawerControlsN


for _slot_count in (1, 4, 8, 12):
    _cls = _make_drawer_controls_class(_slot_count)
    _node_id = f"DrawerControls{_slot_count}"
    NODE_CLASS_MAPPINGS[_node_id] = _cls
    NODE_DISPLAY_NAME_MAPPINGS[_node_id] = f"📝 Controls {_slot_count} (Drawer)"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Drawer Concat — Multi-input string concatenation with skip-empty option
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class DrawerConcat:
    """Multi-input string concatenation with smart empty handling.

    Accepts dynamically displayed string inputs.  When `skip_empty` is enabled (default),
    inputs whose .strip() is empty are silently dropped before joining,
    avoiding the `"a, , b"` problem that the core 2-input Concatenate
    node produces.
    """

    MAX_INPUTS = 64

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"string_{i}": ("STRING", {"multiline": True, "forceInput": True})
            for i in range(1, cls.MAX_INPUTS + 1)
        }
        return {
            "required": {
                "delimiter": ("STRING", {"default": ", "}),
                "skip_empty": ("BOOLEAN", {"default": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "execute"
    CATEGORY = "Drawer"

    def execute(self, delimiter, skip_empty, **kwargs):
        parts = []
        for i in range(1, self.MAX_INPUTS + 1):
            val = kwargs.get(f"string_{i}")
            if val is None:
                continue
            if skip_empty and not val.strip():
                continue
            parts.append(val)
        return (delimiter.join(parts),)


NODE_CLASS_MAPPINGS["DrawerConcat"] = DrawerConcat
NODE_DISPLAY_NAME_MAPPINGS["DrawerConcat"] = "📝 Concat (Drawer)"


class DrawerSwitchChain:
    """Fallback chain switch.

    Returns the last connected non-empty value. This preserves the current
    A/B Switch meaning when only value_1 and value_2 are used: value_2 wins
    when present, otherwise value_1 is returned.
    """

    MAX_INPUTS = 64

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                f"value_{i}": ("*", {"forceInput": True})
                for i in range(1, cls.MAX_INPUTS + 1)
            }
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("output",)
    FUNCTION = "execute"
    CATEGORY = "Drawer"

    def execute(self, **kwargs):
        for i in range(self.MAX_INPUTS, 0, -1):
            val = kwargs.get(f"value_{i}")
            if val is None:
                continue
            if isinstance(val, str) and not val.strip():
                continue
            return (val,)
        return (None,)


NODE_CLASS_MAPPINGS["DrawerSwitchChain"] = DrawerSwitchChain
NODE_DISPLAY_NAME_MAPPINGS["DrawerSwitchChain"] = "📝 Switch Chain (Drawer)"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Drawer Switch — V3 node manual registration
#  ComfyUI's loader uses `elif` between NODE_CLASS_MAPPINGS and
#  comfy_entrypoint, so V3 nodes in a V1 package must be registered manually.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


_switch_schema = DrawerSwitchNode.GET_SCHEMA()
NODE_CLASS_MAPPINGS[_switch_schema.node_id] = DrawerSwitchNode
if _switch_schema.display_name:
    NODE_DISPLAY_NAME_MAPPINGS[_switch_schema.node_id] = _switch_schema.display_name

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Drawer Size — Resolution selector with Deck-side aspect ratio UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class DrawerSize:
    """Resolution selector primitive node.

    On canvas: width/height numbers, megapixel slider, and aspect ratio
    combo box.  In Deck: rich UI with aspect ratio chip presets,
    megapixel slider, and auto-calculation rounded to nearest 16.

    When ratio_ is anything other than "custom", execute() recalculates
    width/height from the ratio and megapixels, ignoring the manual W/H
    values.  "custom" passes width_/height_ through as-is.
    """

    RATIOS = [
        "custom",
        "1:1", "4:3", "3:2", "16:9", "21:9",
        "9:16", "2:3", "3:4",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ratio_": (cls.RATIOS, {"default": "custom"}),
                "megapixels_": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.25,
                    "max": 4.0,
                    "step": 0.05,
                }),
                "width_": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 16,
                }),
                "height_": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 16,
                }),
            }
        }

    RETURN_TYPES = ("INT", "INT", "FLOAT", RATIOS)
    RETURN_NAMES = ("width", "height", "megapixels", "ratio")
    FUNCTION = "execute"
    CATEGORY = "Drawer"

    @staticmethod
    def _round16(v):
        return max(64, round(v / 16) * 16)

    def execute(self, ratio_, megapixels_, width_, height_):
        MP = 1024 * 1024
        if ratio_ != "custom":
            parts = ratio_.split(":")
            rw, rh = int(parts[0]), int(parts[1])
            total = megapixels_ * MP
            scale = (total / (rw * rh)) ** 0.5
            w = self._round16(rw * scale)
            h = self._round16(rh * scale)
        else:
            w = self._round16(width_)
            h = self._round16(height_)
        actual_mp = round((w * h) / MP, 3)
        return (w, h, actual_mp, ratio_)


NODE_CLASS_MAPPINGS["DrawerSize"] = DrawerSize
NODE_DISPLAY_NAME_MAPPINGS["DrawerSize"] = "📝 Size (Drawer)"
