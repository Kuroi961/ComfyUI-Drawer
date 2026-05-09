"""Persistent settings helpers for ComfyUI-Drawer."""

import json
import os
import tempfile
import threading

import folder_paths

_DRAWER_SETTINGS_PATH = os.path.join(folder_paths.get_user_directory(), "drawer_settings.json")
_DRAWER_SETTINGS_LOCK = threading.Lock()


def read_drawer_settings():
    try:
        with _DRAWER_SETTINGS_LOCK:
            if not os.path.isfile(_DRAWER_SETTINGS_PATH):
                return {}
            with open(_DRAWER_SETTINGS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_drawer_settings(data):
    with _DRAWER_SETTINGS_LOCK:
        os.makedirs(os.path.dirname(_DRAWER_SETTINGS_PATH), exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix="drawer_settings.",
            suffix=".tmp",
            dir=os.path.dirname(_DRAWER_SETTINGS_PATH),
            text=True,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            os.replace(tmp_path, _DRAWER_SETTINGS_PATH)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise


def get_drawer_setting(key, default=None):
    return read_drawer_settings().get(key, default)


def set_drawer_setting(key, value):
    data = read_drawer_settings()
    data[key] = value
    write_drawer_settings(data)
    return value
