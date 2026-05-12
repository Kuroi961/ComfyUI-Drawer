"""Safe image loading helpers for Drawer-managed image operations."""

import warnings

from PIL import Image


MAX_IMAGE_PIXELS = 64_000_000


class DrawerImageTooLarge(ValueError):
    pass


def open_image_checked(fp, *, copy=False, verify=False, max_pixels=MAX_IMAGE_PIXELS):
    """Open a Pillow image with an explicit pixel limit.

    `verify=True` validates headers and returns the detected format string.
    `copy=True` returns a detached image object so callers can use it after the
    source file/stream is closed.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        img = Image.open(fp)
        width, height = img.size
        if width * height > max_pixels:
            try:
                img.close()
            finally:
                raise DrawerImageTooLarge("image too large")
        if verify:
            fmt = img.format
            img.verify()
            return fmt
        if copy:
            try:
                return img.copy()
            finally:
                img.close()
        return img
