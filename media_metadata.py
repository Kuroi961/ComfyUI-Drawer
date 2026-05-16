"""Media metadata readers for ComfyUI-Drawer."""

import json
import os
import re
import struct
import subprocess
import zlib

try:
    from .image_safety import open_image_checked
except ImportError:
    try:
        from image_safety import open_image_checked
    except ImportError:
        open_image_checked = None

from .metadata_ext import read_provider_meta

_VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.avi', '.mkv')
_AUDIO_EXTS = ('.flac', '.mp3', '.opus', '.wav', '.ogg')
_MAX_META_CHUNK_BYTES = 16 * 1024 * 1024
_A1111_PARAMETER_KEYS = ("parameters", "Parameters")
_NAI_COMMENT_KEYS = ("Comment", "comment")


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
                if chunk_type not in ("tEXt", "iTXt") or length <= 0:
                    f.seek(length + 4, os.SEEK_CUR)
                    continue
                if length > _MAX_META_CHUNK_BYTES:
                    f.seek(length + 4, os.SEEK_CUR)
                    continue
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
                                        # Cap the decompressed size so a
                                        # high-ratio zlib bomb in an iTXt
                                        # chunk cannot fill memory during
                                        # routine indexing.
                                        try:
                                            decompressor = zlib.decompressobj()
                                            text_data = decompressor.decompress(
                                                text_data, _MAX_META_CHUNK_BYTES,
                                            )
                                            if decompressor.unconsumed_tail:
                                                continue  # would exceed cap
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
                chunk_data = None
                if chunk_id in (b"EXIF", b"XMP ", b"XMP\x00") and chunk_size <= _MAX_META_CHUNK_BYTES:
                    chunk_data = f.read(chunk_size)
                else:
                    f.seek(chunk_size, os.SEEK_CUR)
                if chunk_size % 2:
                    f.seek(1, os.SEEK_CUR)
                if chunk_id == b"EXIF" and chunk_data is not None:
                    exif_bytes = chunk_data
                elif chunk_id in (b"XMP ", b"XMP\x00") and chunk_data is not None:
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
                if key in ("prompt", "workflow", "xyz_plot"):
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


def _try_json_object(text):
    if not isinstance(text, str):
        return None
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _decoded_text_score(text):
    if not isinstance(text, str) or not text:
        return -1000
    replacement = text.count("\ufffd")
    controls = sum(1 for ch in text if ord(ch) < 32 and ch not in "\r\n\t")
    ascii_printable = sum(1 for ch in text if 32 <= ord(ch) < 127)
    latin = sum(1 for ch in text if 0x00c0 <= ord(ch) <= 0x024f)
    cjk = sum(1 for ch in text if 0x3000 <= ord(ch) <= 0x9fff)
    kana = sum(1 for ch in text if 0x3040 <= ord(ch) <= 0x30ff)
    return ascii_printable + kana + cjk - latin * 2 - replacement * 80 - controls * 40


def _decode_best(data, encodings):
    if isinstance(data, str):
        return data
    if not isinstance(data, (bytes, bytearray)):
        return ""
    candidates = []
    raw = bytes(data)
    for encoding in encodings:
        try:
            text = raw.decode(encoding, errors="strict")
        except UnicodeDecodeError:
            continue
        candidates.append((_decoded_text_score(text), text))
    if not candidates:
        for encoding in encodings:
            try:
                text = raw.decode(encoding, errors="ignore")
            except Exception:
                continue
            candidates.append((_decoded_text_score(text), text))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1].strip("\x00").strip()


def _decode_exif_user_comment(value):
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, (bytes, bytearray)):
        return ""
    data = bytes(value)
    if data.startswith(b"UNICODE\x00"):
        payload = data[8:]
        return _decode_best(payload, ("utf-16", "utf-16le", "utf-16be"))
    if data.startswith(b"ASCII\x00\x00\x00"):
        return _decode_best(data[8:], ("utf-8", "ascii", "cp932", "shift_jis", "latin-1"))
    if data.startswith(b"JIS\x00\x00\x00\x00\x00"):
        return _decode_best(data[8:], ("iso2022_jp", "shift_jis", "cp932", "utf-8"))
    return _decode_best(data, ("utf-8", "utf-16", "utf-16le", "utf-16be", "cp932", "shift_jis", "latin-1"))


def _looks_like_a1111_parameters(text):
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return (
        "steps:" in lowered
        or "negative prompt:" in lowered
        or "sampler:" in lowered
        or "cfg scale:" in lowered
        or "seed:" in lowered
    )


def _parse_a1111_parameters(text):
    if not isinstance(text, str) or not text.strip():
        return None
    result = {"parameters": text.strip()}
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines:
        prompt_lines = []
        negative_lines = []
        in_negative = False
        settings_line = ""
        for line in lines:
            stripped = line.strip()
            if stripped.lower().startswith("negative prompt:"):
                in_negative = True
                negative_lines.append(stripped.split(":", 1)[1].strip())
                continue
            if re.search(r"\bSteps:\s*\d+", stripped):
                settings_line = stripped
                break
            if in_negative:
                negative_lines.append(line)
            else:
                prompt_lines.append(line)
        prompt = "\n".join(part.rstrip() for part in prompt_lines).strip()
        negative = "\n".join(part.rstrip() for part in negative_lines).strip()
        if prompt:
            result["prompt"] = prompt
        if negative:
            result["negative_prompt"] = negative
        if settings_line:
            settings = {}
            for match in re.finditer(r"([^:,]+):\s*([^,]+)(?:,\s*|$)", settings_line):
                key = match.group(1).strip()
                value = match.group(2).strip()
                if key:
                    settings[key] = value
            if settings:
                result["settings"] = settings
    return result if len(result) > 1 or _looks_like_a1111_parameters(text) else None


def _parse_nai_comment(text):
    data = _try_json_object(text)
    if not data:
        return None
    interesting = {
        "prompt", "uc", "negative_prompt", "seed", "steps", "scale",
        "sampler", "model", "model_hash", "strength", "noise",
    }
    if not any(key in data for key in interesting):
        return None
    result = dict(data)
    if "uc" in result and "negative_prompt" not in result:
        result["negative_prompt"] = result.get("uc")
    return result


def _first_text_field(text_fields, keys):
    for key in keys:
        value = text_fields.get(key)
        if isinstance(value, bytes):
            value = _decode_best(value, ("utf-8", "utf-16", "cp932", "shift_jis", "latin-1"))
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _parse_nai_fields(text_fields):
    if not isinstance(text_fields, dict):
        return None
    comment = None
    for key in _NAI_COMMENT_KEYS:
        comment = _parse_nai_comment(text_fields.get(key))
        if comment:
            break

    software = _first_text_field(text_fields, ("Software", "software"))
    source = _first_text_field(text_fields, ("Source", "source"))
    title = _first_text_field(text_fields, ("Title", "title"))
    description = _first_text_field(text_fields, ("Description", "description"))
    looks_like_nai = (
        comment is not None
        or software.lower() == "novelai"
        or source.lower().startswith("novelai")
        or title.lower().startswith("novelai generated image")
    )
    if not looks_like_nai:
        return None

    result = dict(comment or {})
    if description and not result.get("prompt"):
        result["prompt"] = description
    if title:
        result["title"] = title
    if software:
        result["software"] = software
    if source:
        result["source"] = source
        result.setdefault("model", source)
    if "uc" in result and "negative_prompt" not in result:
        result["negative_prompt"] = result.get("uc")
    width = result.get("width")
    height = result.get("height")
    if width and height and "size" not in result:
        result["size"] = f"{width}x{height}"
    return result if result else None


def _extract_third_party_generation_meta(text_fields):
    if not isinstance(text_fields, dict):
        return None
    result = {}
    for key in _A1111_PARAMETER_KEYS:
        parsed = _parse_a1111_parameters(text_fields.get(key))
        if parsed:
            result["a1111"] = parsed
            break
    parsed = _parse_nai_fields(text_fields)
    if parsed:
        result["nai"] = parsed
    return result if result else None


def _read_embedded_meta(filepath):
    """Read ComfyUI metadata embedded in an image, video, or audio file."""
    ext = os.path.splitext(filepath)[1].lower()

    if ext == ".png":
        chunks = _read_png_text_chunks(filepath)
        if not chunks:
            return None
        meta = {}
        for key in ("prompt", "workflow", "xyz_plot"):
            if key in chunks:
                try:
                    meta[key] = json.loads(chunks[key])
                except (json.JSONDecodeError, ValueError):
                    pass
        third_party = _extract_third_party_generation_meta(chunks)
        if third_party:
            meta.update(third_party)
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
        if open_image_checked is None:
            return None
        with open_image_checked(filepath) as img:
            info = img.info or {}
            meta = {}
            for key in ("prompt", "workflow", "xyz_plot"):
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
            third_party = _extract_third_party_generation_meta(info)
            if third_party:
                return third_party

            exif = img.getexif()
            if exif:
                meta = {}
                for tag_id in (0x010F, 0x0110, 0x010E, 0x010D):
                    val = exif.get(tag_id)
                    if isinstance(val, str) and ":" in val:
                        key, _, json_str = val.partition(":")
                        if key in ("prompt", "workflow", "xyz_plot"):
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
                        text = _decode_exif_user_comment(user_comment)
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
                            a1111 = _parse_a1111_parameters(text)
                            if a1111:
                                return {"a1111": a1111}
                            nai = _parse_nai_comment(text)
                            if nai:
                                return {"nai": nai}
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
