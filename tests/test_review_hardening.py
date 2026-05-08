import os
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = REPO_ROOT.parents[1]
sys.path.insert(0, str(COMFY_ROOT))
sys.path.insert(0, str(REPO_ROOT))

import dict_store  # noqa: E402
import fs_utils  # noqa: E402
import folder_paths  # noqa: E402


class SafePathTests(unittest.TestCase):
    def test_safe_path_allows_paths_inside_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            os.makedirs(os.path.join(root, "nested"))

            result = fs_utils.safe_path(root, "nested", "file.png")

            self.assertEqual(
                result,
                os.path.realpath(os.path.join(root, "nested", "file.png")),
            )

    def test_safe_path_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            sibling = os.path.join(tmp, "sibling")
            os.makedirs(root)
            os.makedirs(sibling)

            self.assertIsNone(fs_utils.safe_path(root, "..", "sibling", "file.png"))

    def test_safe_path_rejects_symlink_escape_when_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            outside = os.path.join(tmp, "outside")
            os.makedirs(root)
            os.makedirs(outside)
            link = os.path.join(root, "outside-link")
            try:
                os.symlink(outside, link)
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")

            self.assertIsNone(fs_utils.safe_path(root, "outside-link", "file.png"))


class UserDictionaryStoreTests(unittest.TestCase):
    def test_dictionary_round_trip_uses_user_directory(self):
        original_get_user_directory = folder_paths.get_user_directory
        with tempfile.TemporaryDirectory() as tmp:
            folder_paths.get_user_directory = lambda: tmp
            try:
                dict_store.write_manifest([
                    {"id": "abc12345", "title": "Test", "enabled": True, "type": "dict"},
                ])
                dict_store.write_dict_entries("abc12345", [
                    {"tag": "sky", "insert_text": "blue sky"},
                    {"tag": "", "insert_text": "ignored"},
                ])

                self.assertEqual(dict_store.get_dict_type("abc12345"), "dict")
                self.assertEqual(
                    dict_store.read_dict_entries("abc12345"),
                    [{"tag": "sky", "insert_text": "blue sky"}],
                )
            finally:
                folder_paths.get_user_directory = original_get_user_directory

    def test_dict_file_path_strips_path_separators(self):
        original_get_user_directory = folder_paths.get_user_directory
        with tempfile.TemporaryDirectory() as tmp:
            folder_paths.get_user_directory = lambda: tmp
            try:
                path = dict_store.dict_file_path("../bad\\id", "dict")
                self.assertTrue(path.startswith(os.path.join(tmp, "drawer_dicts")))
                self.assertEqual(os.path.basename(path), "badid.csv")
            finally:
                folder_paths.get_user_directory = original_get_user_directory


class ThumbnailRegressionTests(unittest.TestCase):
    def test_thumbnail_cache_name_keeps_original_extension(self):
        source = (REPO_ROOT / "thumbnails.py").read_text(encoding="utf-8")
        self.assertIn('thumb_name = filename + ".webp"', source)
        self.assertNotIn('os.path.splitext(filename)[0] + ".webp"', source)


if __name__ == "__main__":
    unittest.main()
