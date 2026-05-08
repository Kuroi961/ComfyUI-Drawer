"""User dictionary storage for ComfyUI-Drawer."""

import csv
import json
import os
import shutil
import tempfile
import threading
import uuid

import folder_paths


_USER_DICT_LOCK = threading.Lock()


def _atomic_write_text(path, writer, *, newline=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".",
        suffix=".tmp",
        dir=os.path.dirname(path),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline=newline) as f:
            writer(f)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def dicts_dir() -> str:
    return os.path.join(folder_paths.get_user_directory(), "drawer_dicts")


def manifest_path() -> str:
    return os.path.join(dicts_dir(), "manifest.json")


def dict_file_path(dict_id: str, dtype: str = "dict") -> str:
    """Return file path for a dictionary. CSV for dict, TXT for wildcard."""
    safe_id = dict_id.replace("/", "").replace("\\", "").replace("..", "")
    ext = ".txt" if dtype == "wildcard" else ".csv"
    return os.path.join(dicts_dir(), f"{safe_id}{ext}")


def get_dict_type(dict_id: str) -> str:
    """Look up the type of a dictionary from the manifest."""
    manifest = read_manifest()
    for d in manifest:
        if d["id"] == dict_id:
            return d.get("type", "dict")
    return "dict"


def read_manifest() -> list[dict]:
    """Read manifest.json. Auto-migrates old user_dict.csv if present."""
    with _USER_DICT_LOCK:
        ddir = dicts_dir()
        mpath = manifest_path()
        os.makedirs(ddir, exist_ok=True)

        if os.path.exists(mpath):
            with open(mpath, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            for d in manifest:
                if "type" not in d:
                    d["type"] = "dict"
            return manifest

        legacy = os.path.join(folder_paths.get_user_directory(), "user_dict.csv")
        manifest = []
        if os.path.exists(legacy):
            new_id = str(uuid.uuid4())[:8]
            shutil.copy2(legacy, dict_file_path(new_id, "dict"))
            manifest.append({"id": new_id, "title": "ユーザー辞書", "enabled": True, "type": "dict"})
            _write_manifest_locked(manifest)
        else:
            _write_manifest_locked(manifest)

        return manifest


def write_manifest(manifest: list[dict]) -> None:
    with _USER_DICT_LOCK:
        _write_manifest_locked(manifest)


def _write_manifest_locked(manifest: list[dict]) -> None:
    _atomic_write_text(
        manifest_path(),
        lambda f: json.dump(manifest, f, ensure_ascii=False, indent=2),
    )


def read_dict_entries(dict_id: str) -> list[dict]:
    path = dict_file_path(dict_id, "dict")
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            entries.append({
                "tag": row.get("tag", "").strip(),
                "insert_text": row.get("insert_text", "").strip(),
            })
    return [e for e in entries if e["tag"]]


def write_dict_entries(dict_id: str, entries: list[dict]) -> None:
    path = dict_file_path(dict_id, "dict")

    def write(f):
        writer = csv.DictWriter(f, fieldnames=["tag", "insert_text"])
        writer.writeheader()
        for e in entries:
            if e.get("tag", "").strip():
                writer.writerow({
                    "tag": e["tag"].strip(),
                    "insert_text": e.get("insert_text", "").strip(),
                })

    with _USER_DICT_LOCK:
        _atomic_write_text(path, write, newline="")


def read_wildcard_entries(dict_id: str) -> list[str]:
    path = dict_file_path(dict_id, "wildcard")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def write_wildcard_entries(dict_id: str, entries: list[str]) -> None:
    path = dict_file_path(dict_id, "wildcard")

    def write(f):
        for entry in entries:
            stripped = entry.strip()
            if stripped:
                f.write(stripped + "\n")

    with _USER_DICT_LOCK:
        _atomic_write_text(path, write)


def count_entries(d: dict) -> int:
    dtype = d.get("type", "dict")
    if dtype == "wildcard":
        return len(read_wildcard_entries(d["id"]))
    return len(read_dict_entries(d["id"]))
