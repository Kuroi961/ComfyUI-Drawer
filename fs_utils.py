"""Filesystem constants and helpers for ComfyUI-Drawer routes."""

import os

import folder_paths

IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp')
VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.avi', '.mkv')
AUDIO_EXTS = ('.flac', '.mp3', '.opus', '.wav', '.ogg')
MEDIA_EXTS = IMAGE_EXTS + VIDEO_EXTS + AUDIO_EXTS
THUMB_WARM_EXTS = set(IMAGE_EXTS) | set(VIDEO_EXTS)

ALLOWED_ROOTS = {
    "output": lambda: os.path.realpath(folder_paths.get_output_directory()),
    "input": lambda: os.path.realpath(folder_paths.get_input_directory()),
    "temp": lambda: os.path.realpath(folder_paths.get_temp_directory()),
}

DELETABLE_ROOTS = {"output", "input", "temp"}

ROOT_LABELS = {
    "output": "Output",
    "input": "Input",
    "temp": "Temp",
}

STORAGE_SKIP_DIRS = {".git", ".thumbs", "__pycache__"}


def ftype(ext):
    if ext in IMAGE_EXTS:
        return 'image'
    if ext in VIDEO_EXTS:
        return 'video'
    if ext in AUDIO_EXTS:
        return 'audio'
    return 'unknown'


def format_storage_rel(path):
    return path.replace("\\", "/").strip("/")


def summarize_tree(base_dir, allowed_exts=None):
    total_bytes = 0
    file_count = 0
    folder_count = 0
    by_ext = {}
    top_dirs = {}
    if not base_dir or not os.path.isdir(base_dir):
        return {
            "bytes": 0,
            "files": 0,
            "folders": 0,
            "byExt": [],
            "topDirs": [],
        }

    for dirpath, dirnames, filenames in os.walk(base_dir):
        dirnames[:] = [d for d in dirnames if d not in STORAGE_SKIP_DIRS and not d.startswith(".")]
        rel_dir = os.path.relpath(dirpath, base_dir)
        if rel_dir != ".":
            folder_count += 1
        top = "" if rel_dir == "." else format_storage_rel(rel_dir).split("/", 1)[0]
        for filename in filenames:
            if filename.startswith("."):
                continue
            ext = os.path.splitext(filename)[1].lower() or "(none)"
            if allowed_exts and ext not in allowed_exts:
                continue
            full = os.path.join(dirpath, filename)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            total_bytes += size
            file_count += 1
            by_ext.setdefault(ext, {"ext": ext, "bytes": 0, "files": 0})
            by_ext[ext]["bytes"] += size
            by_ext[ext]["files"] += 1
            if top:
                top_dirs.setdefault(top, {"name": top, "bytes": 0, "files": 0})
                top_dirs[top]["bytes"] += size
                top_dirs[top]["files"] += 1

    return {
        "bytes": total_bytes,
        "files": file_count,
        "folders": folder_count,
        "byExt": sorted(by_ext.values(), key=lambda x: x["bytes"], reverse=True)[:12],
        "topDirs": sorted(top_dirs.values(), key=lambda x: x["bytes"], reverse=True)[:8],
    }


def resolve_root(request):
    root_name = request.query.get("root", "output").strip().lower()
    getter = ALLOWED_ROOTS.get(root_name)
    if getter is None:
        return None, None
    return root_name, getter()


def safe_path(root, *parts):
    root = os.path.realpath(root)
    joined = os.path.join(root, *parts)
    real = os.path.realpath(joined)
    try:
        if os.path.commonpath((root, real)) != root:
            return None
    except ValueError:
        return None
    return real


def is_plain_name(name):
    return (
        isinstance(name, str)
        and bool(name)
        and name not in (".", "..")
        and "/" not in name
        and "\\" not in name
    )


def is_supported_media_name(filename, media_exts=MEDIA_EXTS):
    return is_plain_name(filename) and os.path.splitext(filename)[1].lower() in media_exts


def truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return False


def as_str(value, default=""):
    if value is None:
        return default
    return str(value)


def body_str(data, key, default=""):
    if not isinstance(data, dict):
        return default
    return as_str(data.get(key, default), default).strip()


def body_int(data, key, default=0, minimum=None, maximum=None):
    if not isinstance(data, dict):
        value = default
    else:
        value = data.get(key, default)
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value
