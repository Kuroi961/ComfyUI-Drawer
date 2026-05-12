"""Gallery thumbnail generation helpers."""

import logging
import os
import shutil
import subprocess

try:
    from .image_safety import open_image_checked
except ImportError:
    try:
        from image_safety import open_image_checked
    except ImportError:
        open_image_checked = None

from .fs_utils import IMAGE_EXTS, VIDEO_EXTS, safe_path

logger = logging.getLogger("ComfyUI-Drawer")


def _safe_thumbnail_path(root, *parts):
    """Resolve a path that must remain inside the physical .thumbs directory."""
    root_real = os.path.realpath(root)
    thumb_base = os.path.abspath(os.path.join(root_real, ".thumbs"))
    target_path = os.path.abspath(os.path.join(thumb_base, *parts))
    check_path = thumb_base
    if os.path.islink(check_path):
        return None
    for part in parts:
        check_path = os.path.join(check_path, part)
        if os.path.lexists(check_path) and os.path.islink(check_path):
            return None
    target = os.path.realpath(target_path)
    try:
        if os.path.commonpath((thumb_base, target)) != thumb_base:
            return None
    except ValueError:
        return None
    return target


def _gallery_thumbnail_path(root, subfolder, filename):
    thumb_name = filename + ".webp"
    return _safe_thumbnail_path(root, subfolder, thumb_name) if subfolder else _safe_thumbnail_path(root, thumb_name)


def _gallery_thumbnail_dir_path(root, subfolder, name):
    return _safe_thumbnail_path(root, subfolder, name) if subfolder else _safe_thumbnail_path(root, name)


def _remove_path_entry(path):
    if os.path.islink(path):
        try:
            os.remove(path)
        except OSError:
            os.rmdir(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def _merge_thumbnail_dir(src_dir, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    for item in os.listdir(src_dir):
        src_item = os.path.join(src_dir, item)
        dest_item = os.path.join(dest_dir, item)
        if os.path.islink(src_item):
            _remove_path_entry(src_item)
            continue
        src_is_dir = os.path.isdir(src_item) and not os.path.islink(src_item)
        dest_is_dir = os.path.isdir(dest_item) and not os.path.islink(dest_item)
        if src_is_dir and dest_is_dir:
            _merge_thumbnail_dir(src_item, dest_item)
        else:
            if os.path.lexists(dest_item):
                _remove_path_entry(dest_item)
            os.replace(src_item, dest_item)
    try:
        os.rmdir(src_dir)
    except OSError:
        pass


def move_gallery_thumbnail_cache(src_root, src_subfolder, src_name, dest_root, dest_subfolder, dest_name, *, is_dir=False):
    """Move Drawer thumbnail cache alongside a Drawer-managed file/folder move."""
    if is_dir:
        src_thumb = _gallery_thumbnail_dir_path(src_root, src_subfolder, src_name)
        dest_thumb = _gallery_thumbnail_dir_path(dest_root, dest_subfolder, dest_name)
    else:
        src_thumb = _gallery_thumbnail_path(src_root, src_subfolder, src_name)
        dest_thumb = _gallery_thumbnail_path(dest_root, dest_subfolder, dest_name)
    if not src_thumb or not dest_thumb or not os.path.exists(src_thumb):
        return False

    try:
        os.makedirs(os.path.dirname(dest_thumb), exist_ok=True)
        if is_dir and os.path.isdir(src_thumb) and os.path.isdir(dest_thumb):
            _merge_thumbnail_dir(src_thumb, dest_thumb)
        else:
            os.replace(src_thumb, dest_thumb)
        return True
    except Exception as e:
        logger.warning("Failed to move Gallery thumbnail cache: %s", e)
        return False


def remove_gallery_thumbnail_cache(root, subfolder, name, *, is_dir=False):
    """Remove Drawer thumbnail cache after a Drawer-managed file/folder delete."""
    thumb_path = (
        _gallery_thumbnail_dir_path(root, subfolder, name)
        if is_dir
        else _gallery_thumbnail_path(root, subfolder, name)
    )
    if not thumb_path or not os.path.exists(thumb_path):
        return False

    try:
        _remove_path_entry(thumb_path)
        return True
    except Exception as e:
        logger.warning("Failed to remove Gallery thumbnail cache: %s", e)
        return False


def ensure_gallery_thumbnail(root, subfolder, filename, max_size=200):
    max_size = max(32, min(int(max_size), 512))
    orig = safe_path(root, subfolder, filename) if subfolder else safe_path(root, filename)
    if orig is None or not os.path.isfile(orig):
        return None, "not-found"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
        return None, "unsupported"

    thumb_path = _gallery_thumbnail_path(root, subfolder, filename)
    if thumb_path is None:
        return None, "invalid"

    need_generate = True
    if os.path.isfile(thumb_path):
        try:
            if os.path.getmtime(thumb_path) >= os.path.getmtime(orig):
                need_generate = False
        except OSError:
            pass

    if need_generate and ext in VIDEO_EXTS:
        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        try:
            subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-y",
                    "-ss", "0.25",
                    "-i", orig,
                    "-frames:v", "1",
                    "-vf", f"thumbnail,scale={max_size}:-1",
                    thumb_path,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=12,
                check=True,
            )
        except FileNotFoundError:
            return None, "ffmpeg-missing"
        except subprocess.TimeoutExpired:
            return None, "video-thumb-timeout"
        except (subprocess.CalledProcessError, OSError):
            return None, "video-thumb-error"
    elif need_generate:
        from PIL import Image as _PILImage

        if open_image_checked is None:
            return None, "pillow-missing"
        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        with open_image_checked(orig) as img:
            img.thumbnail((max_size, max_size), _PILImage.LANCZOS)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")
            img.save(thumb_path, "WEBP", quality=75)
    return thumb_path, "thumbnail"
