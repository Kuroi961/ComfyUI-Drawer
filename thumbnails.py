"""Gallery thumbnail generation helpers."""

import os
import subprocess

from .fs_utils import IMAGE_EXTS, VIDEO_EXTS, safe_path


def ensure_gallery_thumbnail(root, subfolder, filename, max_size=200):
    from PIL import Image as _PILImage

    max_size = max(32, min(int(max_size), 512))
    orig = safe_path(root, subfolder, filename) if subfolder else safe_path(root, filename)
    if orig is None or not os.path.isfile(orig):
        return None, "not-found"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
        return orig, "original"

    thumb_base = os.path.join(root, ".thumbs")
    thumb_name = filename + ".webp"
    thumb_path = safe_path(thumb_base, subfolder, thumb_name) if subfolder else safe_path(thumb_base, thumb_name)
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
        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        with _PILImage.open(orig) as img:
            img.thumbnail((max_size, max_size), _PILImage.LANCZOS)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")
            img.save(thumb_path, "WEBP", quality=75)
    return thumb_path, "thumbnail"
