import os
import sys
import tempfile
import importlib.util
import types
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = REPO_ROOT.parents[1]
sys.path.insert(0, str(COMFY_ROOT))
sys.path.insert(0, str(REPO_ROOT))

import dict_store  # noqa: E402
import fs_utils  # noqa: E402
import folder_paths  # noqa: E402
import settings  # noqa: E402


def _load_repo_module(module_name):
    package_name = "_comfy_drawer_testpkg"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(REPO_ROOT)]
        sys.modules[package_name] = package
    full_name = f"{package_name}.{module_name}"
    if full_name in sys.modules:
        return sys.modules[full_name]
    spec = importlib.util.spec_from_file_location(full_name, REPO_ROOT / f"{module_name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[full_name] = module
    spec.loader.exec_module(module)
    return module


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


class MediaNameTests(unittest.TestCase):
    def test_supported_media_name_rejects_non_media_and_path_parts(self):
        self.assertTrue(fs_utils.is_supported_media_name("image.png"))
        self.assertTrue(fs_utils.is_supported_media_name("sound.mp3"))
        self.assertFalse(fs_utils.is_supported_media_name("notes.txt"))
        self.assertFalse(fs_utils.is_supported_media_name("../image.png"))
        self.assertFalse(fs_utils.is_supported_media_name("nested/image.png"))

    def test_supported_media_name_can_be_limited_to_thumbnail_exts(self):
        self.assertTrue(fs_utils.is_supported_media_name("image.webp", fs_utils.THUMB_WARM_EXTS))
        self.assertTrue(fs_utils.is_supported_media_name("clip.mp4", fs_utils.THUMB_WARM_EXTS))
        self.assertFalse(fs_utils.is_supported_media_name("sound.mp3", fs_utils.THUMB_WARM_EXTS))


class BodyHelperTests(unittest.TestCase):
    def test_body_str_coerces_values_without_attribute_errors(self):
        self.assertEqual(fs_utils.body_str({"name": "  abc  "}, "name"), "abc")
        self.assertEqual(fs_utils.body_str({"name": 42}, "name"), "42")
        self.assertEqual(fs_utils.body_str({"name": None}, "name", "fallback"), "fallback")
        self.assertEqual(fs_utils.body_str([], "name", "fallback"), "fallback")

    def test_body_int_coerces_and_clamps_values(self):
        self.assertEqual(fs_utils.body_int({"size": "64"}, "size", 512, minimum=32, maximum=512), 64)
        self.assertEqual(fs_utils.body_int({"size": "bad"}, "size", 512, minimum=32, maximum=512), 512)
        self.assertEqual(fs_utils.body_int({"size": 4}, "size", 512, minimum=32, maximum=512), 32)
        self.assertEqual(fs_utils.body_int({"size": 2048}, "size", 512, minimum=32, maximum=512), 512)


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

    def test_thumbnail_rejects_non_media_files(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            os.makedirs(root)
            with open(os.path.join(root, "notes.txt"), "w", encoding="utf-8") as f:
                f.write("not media")

            path, kind = thumbnails.ensure_gallery_thumbnail(root, "", "notes.txt")

            self.assertIsNone(path)
            self.assertEqual(kind, "unsupported")


class SettingsStoreTests(unittest.TestCase):
    def test_settings_write_is_atomic(self):
        original_path = settings._DRAWER_SETTINGS_PATH
        with tempfile.TemporaryDirectory() as tmp:
            settings._DRAWER_SETTINGS_PATH = os.path.join(tmp, "drawer_settings.json")
            try:
                settings.write_drawer_settings({"theme": "dark"})

                with open(settings._DRAWER_SETTINGS_PATH, "r", encoding="utf-8") as f:
                    self.assertIn('"theme": "dark"', f.read())
                self.assertFalse(any(name.endswith(".tmp") for name in os.listdir(tmp)))
            finally:
                settings._DRAWER_SETTINGS_PATH = original_path


class RouteHardeningSourceTests(unittest.TestCase):
    def test_media_file_routes_reject_unsupported_extensions(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn("is_supported_media_name as _is_supported_media_name", source)
        self.assertIn('return web.json_response({"error": "unsupported file type"}, status=415)', source)
        self.assertGreaterEqual(source.count('if not _is_supported_media_name(name):'), 2)
        self.assertNotIn('if kind == "original":', source)

    def test_query_int_helper_is_used_for_gallery_pagination_and_thumbnail_size(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn('limit = _query_int(request, "limit", 0, minimum=0)', source)
        self.assertIn('offset = _query_int(request, "offset", 0, minimum=0)', source)
        self.assertIn('max_size = _query_int(request, "size", 200, minimum=32, maximum=512)', source)

    def test_json_body_helper_rejects_non_object_json(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn('raise web.HTTPBadRequest(text="JSON object required")', source)
        self.assertIn("if default is not None:\n            return default", source)
        self.assertNotIn("except json.JSONDecodeError", source)

    def test_mutating_routes_use_body_str_for_string_fields(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn('title = _body_str(data, "title", "新しい辞書")', source)
        self.assertIn('root_name = _body_str(body, "root", "output").lower()', source)
        self.assertIn('filename = _body_str(body, "filename")', source)
        self.assertIn('name = _body_str(prof, "name")', source)

    def test_save_grid_validates_manual_json_body_and_quality(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn('return web.json_response({"error": "JSON object required"}, status=400)', source)
        self.assertIn('quality = _body_int(data, "quality", 95, minimum=1, maximum=100)', source)

    def test_multipart_routes_map_malformed_forms_to_400(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn("async def _multipart_reader", source)
        self.assertIn('raise web.HTTPBadRequest(text="Invalid multipart form")', source)
        self.assertGreaterEqual(source.count('{"error": "Invalid multipart form"}'), 2)

    def test_comfy_bridge_internal_http_uses_fetch_api_wrapper(self):
        source = (REPO_ROOT / "web" / "js" / "core" / "comfy-bridge.js").read_text(encoding="utf-8")

        self.assertEqual(source.count("this.#api.fetchApi"), 1)
        self.assertIn("return this.fetchApi('/prompt'", source)
        self.assertIn("return this.fetchApi('/interrupt'", source)


if __name__ == "__main__":
    unittest.main()
