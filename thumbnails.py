"""Gallery thumbnail generation helpers."""

import os
import shutil
import subprocess

from .fs_utils import IMAGE_EXTS, VIDEO_EXTS, safe_path


def _gallery_thumbnail_path(root, subfolder, filename):
    thumb_name = filename + ".webp"
    return safe_path(root, ".thumbs", subfolder, thumb_name) if subfolder else safe_path(root, ".thumbs", thumb_name)


def _gallery_thumbnail_dir_path(root, subfolder, name):
    return safe_path(root, ".thumbs", subfolder, name) if subfolder else safe_path(root, ".thumbs", name)


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
            for item in os.listdir(src_thumb):
                shutil.move(os.path.join(src_thumb, item), os.path.join(dest_thumb, item))
            try:
                os.rmdir(src_thumb)
            except OSError:
                pass
        else:
            os.replace(src_thumb, dest_thumb)
        return True
    except Exception:
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
        if os.path.isdir(thumb_path):
            shutil.rmtree(thumb_path)
        else:
            os.remove(thumb_path)
        return True
    except Exception:
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

        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        with _PILImage.open(orig) as img:
            img.thumbnail((max_size, max_size), _PILImage.LANCZOS)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")
            img.save(thumb_path, "WEBP", quality=75)
    return thumb_path, "thumbnail"
