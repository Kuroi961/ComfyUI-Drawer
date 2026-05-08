"""Media metadata readers for ComfyUI-Drawer."""

import json
import os
import re
import struct
import subprocess
import zlib

from .metadata_ext import read_provider_meta

_VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.avi', '.mkv')
_AUDIO_EXTS = ('.flac', '.mp3', '.opus', '.wav', '.ogg')


def _read_png_text_chunks(filepath):
    result = {}
    try:
        with open(filepath, "rb") as f:
            sig = f.read(8)
            if sig != b'\x89PNG\r\n\x1a\n':
                return result
            while True:
                header = f.read(8)
                if len(header) < 8:
                    break
                length, chunk_type = struct.unpack(">I4s", header)
                chunk_type = chunk_type.decode("ascii", errors="ignore")
                if chunk_type == "IEND":
                    break
                data = f.read(length)
                f.read(4)  # CRC
                if chunk_type == "tEXt" and len(data) > 0:
                    sep = data.find(b'\x00')
                    if sep >= 0:
                        keyword = data[:sep].decode("latin-1", errors="ignore")
                        text = data[sep + 1:].decode("latin-1", errors="ignore")
                        result[keyword] = text
                elif chunk_type == "iTXt" and len(data) > 0:
                    sep = data.find(b'\x00')
                    if sep >= 0:
                        keyword = data[:sep].decode("utf-8", errors="ignore")
                        rest = data[sep + 1:]
                        if len(rest) >= 2:
                            comp_flag = rest[0]
                            rest = rest[2:]
                            sep2 = rest.find(b'\x00')
                            if sep2 >= 0:
                                rest = rest[sep2 + 1:]
                                sep3 = rest.find(b'\x00')
                                if sep3 >= 0:
                                    text_data = rest[sep3 + 1:]
                                    if comp_flag:
                                        try:
                                            text_data = zlib.decompress(text_data)
                                        except zlib.error:
                                            continue
                                    result[keyword] = text_data.decode("utf-8", errors="ignore")
    except (OSError, struct.error):
        pass
    return result


def _read_webp_riff_meta(filepath):
    """Read ComfyUI metadata from a WEBP file by parsing raw RIFF chunks."""
    try:
        with open(filepath, "rb") as f:
            header = f.read(12)
            if len(header) < 12:
                return None
            if header[:4] != b"RIFF" or header[8:12] != b"WEBP":
                return None

            exif_bytes = None
            xmp_bytes = None
            while True:
                ch = f.read(8)
                if len(ch) < 8:
                    break
                chunk_id = ch[:4]
                chunk_size = struct.unpack_from("<I", ch, 4)[0]
                chunk_data = f.read(chunk_size)
                if chunk_size % 2:
                    f.read(1)
                if chunk_id == b"EXIF":
                    exif_bytes = chunk_data
                elif chunk_id in (b"XMP ", b"XMP\x00"):
                    xmp_bytes = chunk_data

        if exif_bytes:
            meta = _parse_exif_bytes_for_workflow(exif_bytes)
            if meta:
                return meta
        if xmp_bytes:
            meta = _parse_xmp_bytes_for_workflow(xmp_bytes)
            if meta:
                return meta
    except Exception:
        pass
    return None


def _parse_exif_bytes_for_workflow(exif_bytes):
    try:
        from PIL import Image
        exif = Image.Exif()
        exif.load(exif_bytes)
        meta = {}
        for tag_id in (0x010F, 0x0110, 0x010E, 0x010D):
            val = exif.get(tag_id)
            if isinstance(val, str) and ":" in val:
                key, _, json_str = val.partition(":")
                if key in ("prompt", "workflow"):
                    try:
                        meta[key] = json.loads(json_str)
                    except (json.JSONDecodeError, ValueError):
                        pass
        return meta if meta else None
    except Exception:
        return None


def _parse_xmp_bytes_for_workflow(xmp_bytes):
    try:
        text = xmp_bytes.decode("utf-8", errors="ignore")
        for match in re.finditer(r'(\{[^<]{20,}\})', text, re.DOTALL):
            candidate = match.group(1).strip()
            try:
                obj = json.loads(candidate)
                if isinstance(obj, dict):
                    result = {}
                    for key in ("prompt", "workflow"):
                        if key in obj:
                            result[key] = obj[key]
                    if result:
                        return result
                    if "nodes" in obj and "links" in obj:
                        return {"workflow": obj}
            except (json.JSONDecodeError, ValueError):
                pass
    except Exception:
        pass
    return None


def _read_embedded_meta(filepath):
    """Read ComfyUI metadata embedded in an image, video, or audio file."""
    ext = os.path.splitext(filepath)[1].lower()

    if ext == ".png":
        chunks = _read_png_text_chunks(filepath)
        if not chunks:
            return None
        meta = {}
        for key in ("prompt", "workflow"):
            if key in chunks:
                try:
                    meta[key] = json.loads(chunks[key])
                except (json.JSONDecodeError, ValueError):
                    pass
        return meta if meta else None

    if ext in (".jpg", ".jpeg", ".webp"):
        return _read_exif_meta(filepath)

    if ext in _VIDEO_EXTS or ext in _AUDIO_EXTS:
        return _read_video_meta(filepath)

    return None


def _read_video_meta(filepath):
    """Read ComfyUI metadata from video files using ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                filepath,
            ],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        tags = data.get("format", {}).get("tags", {})
        if not tags:
            return None
        meta = {}
        for key in ("prompt", "workflow"):
            raw = tags.get(key)
            if raw:
                try:
                    meta[key] = json.loads(raw)
                except (json.JSONDecodeError, ValueError):
                    pass
        return meta if meta else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def _read_exif_meta(filepath):
    """Read ComfyUI metadata from JPEG/WebP EXIF tags."""
    try:
        from PIL import Image

        with Image.open(filepath) as img:
            info = img.info or {}
            meta = {}
            for key in ("prompt", "workflow"):
                if key in info:
                    try:
                        val = info[key]
                        if isinstance(val, bytes):
                            val = val.decode("utf-8", errors="ignore")
                        if isinstance(val, str):
                            meta[key] = json.loads(val)
                    except (json.JSONDecodeError, ValueError):
                        pass
            if meta:
                return meta

            exif = img.getexif()
            if exif:
                meta = {}
                for tag_id in (0x010F, 0x0110, 0x010E, 0x010D):
                    val = exif.get(tag_id)
                    if isinstance(val, str) and ":" in val:
                        key, _, json_str = val.partition(":")
                        if key in ("prompt", "workflow"):
                            try:
                                meta[key] = json.loads(json_str)
                            except (json.JSONDecodeError, ValueError):
                                pass
                if meta:
                    return meta

                exif_ifd = exif.get_ifd(0x8769)
                if exif_ifd:
                    user_comment = exif_ifd.get(0x9286)
                    if user_comment:
                        text = user_comment
                        if isinstance(text, bytes):
                            if text.startswith(b"UNICODE\x00"):
                                text = text[8:].decode("utf-16le", errors="ignore")
                            elif text.startswith(b"ASCII\x00\x00\x00"):
                                text = text[8:].decode("ascii", errors="ignore")
                            else:
                                text = text.decode("utf-8", errors="ignore")
                        if isinstance(text, str) and text.strip():
                            try:
                                data = json.loads(text)
                                if isinstance(data, dict):
                                    result = {}
                                    for key in ("prompt", "workflow"):
                                        if key in data:
                                            result[key] = data[key]
                                    if result:
                                        return result
                            except (json.JSONDecodeError, ValueError):
                                pass
    except Exception:
        pass

    if filepath.lower().endswith(".webp"):
        return _read_webp_riff_meta(filepath)
    return None


def provider_context(filepath, root_name="", root_path="", subfolder="", name=""):
    filename = name or os.path.basename(filepath)
    rel_subfolder = subfolder.replace("\\", "/") if subfolder else ""
    return {
        "path": filepath,
        "root": root_name,
        "root_name": root_name,
        "root_path": root_path,
        "subfolder": rel_subfolder,
        "name": filename,
        "filename": filename,
    }


def read_media_meta_with_source(filepath, root_name="", root_path="", subfolder="", name=""):
    """Read raw media metadata from providers, falling back to embedding."""
    ctx = provider_context(filepath, root_name, root_path, subfolder, name)
    provider_meta, provider_name = read_provider_meta(ctx)
    if provider_meta:
        return provider_meta, f"provider:{provider_name}"
    embedded_meta = _read_embedded_meta(filepath)
    if embedded_meta:
        return embedded_meta, "embedded"
    return None, "none"


def read_media_meta(filepath, root_name="", root_path="", subfolder="", name=""):
    """Read searchable media metadata through providers, then embedding."""
    meta, _source = read_media_meta_with_source(filepath, root_name, root_path, subfolder, name)
    return meta
