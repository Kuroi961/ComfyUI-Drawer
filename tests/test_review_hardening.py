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

    def test_thumbnail_cache_moves_with_file_rename(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            thumb_dir = os.path.join(root, ".thumbs", "nested")
            os.makedirs(thumb_dir)
            old_thumb = os.path.join(thumb_dir, "old.png.webp")
            with open(old_thumb, "wb") as f:
                f.write(b"thumb")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "nested", "old.png",
                root, "nested", "new.png",
            )

            self.assertTrue(moved)
            self.assertFalse(os.path.exists(old_thumb))
            with open(os.path.join(thumb_dir, "new.png.webp"), "rb") as f:
                self.assertEqual(f.read(), b"thumb")

    def test_thumbnail_cache_moves_between_subfolders(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            os.makedirs(os.path.join(root, ".thumbs", "src"))
            old_thumb = os.path.join(root, ".thumbs", "src", "image.jpg.webp")
            with open(old_thumb, "wb") as f:
                f.write(b"thumb")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "src", "image.jpg",
                root, "dst", "image.jpg",
            )

            self.assertTrue(moved)
            self.assertFalse(os.path.exists(old_thumb))
            self.assertTrue(os.path.isfile(os.path.join(root, ".thumbs", "dst", "image.jpg.webp")))

    def test_thumbnail_cache_is_removed_with_file_delete(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            thumb_dir = os.path.join(root, ".thumbs", "nested")
            os.makedirs(thumb_dir)
            thumb = os.path.join(thumb_dir, "old.png.webp")
            with open(thumb, "wb") as f:
                f.write(b"thumb")

            removed = thumbnails.remove_gallery_thumbnail_cache(root, "nested", "old.png")

            self.assertTrue(removed)
            self.assertFalse(os.path.exists(thumb))

    def test_thumbnail_cache_rejects_thumbs_symlink_escape(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            outside = os.path.join(tmp, "outside")
            os.makedirs(root)
            os.makedirs(outside)
            try:
                os.symlink(outside, os.path.join(root, ".thumbs"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")
            outside_thumb = os.path.join(outside, "image.png.webp")
            with open(outside_thumb, "wb") as f:
                f.write(b"outside")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "", "image.png",
                root, "nested", "image.png",
            )
            removed = thumbnails.remove_gallery_thumbnail_cache(root, "", "image.png")

            self.assertFalse(moved)
            self.assertFalse(removed)
            self.assertTrue(os.path.isfile(outside_thumb))


class ThirdPartyMetadataTests(unittest.TestCase):
    def test_a1111_parameters_are_raw_metadata_and_searchable(self):
        media_metadata = _load_repo_module("media_metadata")
        search_query = _load_repo_module("search_query")

        meta = media_metadata._extract_third_party_generation_meta({
            "parameters": (
                "masterpiece, blue sky\n"
                "Negative prompt: blurry, low quality\n"
                "Steps: 28, Sampler: Euler a, CFG scale: 7, Seed: 12345"
            )
        })

        self.assertIn("a1111", meta)
        self.assertEqual(meta["a1111"]["settings"]["Seed"], "12345")
        parts = search_query.extract_searchable_parts(meta)
        self.assertIn("blue sky", parts["prompt_value"])
        self.assertIn("blurry", parts["custom"])
        self.assertTrue(any(
            item.get("namespace") == "a1111"
            and item.get("key") == "settings"
            and "Seed 12345" in item.get("text", "")
            for item in parts["custom_index"]
        ))

    def test_nai_comment_json_is_raw_metadata_and_searchable(self):
        media_metadata = _load_repo_module("media_metadata")
        search_query = _load_repo_module("search_query")

        meta = media_metadata._extract_third_party_generation_meta({
            "Comment": '{"prompt":"castle at night","uc":"bad anatomy","seed":987,"sampler":"k_euler"}'
        })

        self.assertIn("nai", meta)
        self.assertEqual(meta["nai"]["negative_prompt"], "bad anatomy")
        parts = search_query.extract_searchable_parts(meta)
        self.assertIn("castle at night", parts["prompt_value"])
        self.assertIn("k_euler", parts["custom"])

    def test_nai_official_inspect_fields_are_merged(self):
        media_metadata = _load_repo_module("media_metadata")

        meta = media_metadata._extract_third_party_generation_meta({
            "Title": "NovelAI generated image",
            "Description": "Artist:hanada ten, simple background, masterpiece",
            "Software": "NovelAI",
            "Source": "NovelAI Diffusion V4.5 4BDE2A90",
            "Comment": (
                '{"uc":"nsfw, lowres, bad quality",'
                '"width":832,"height":1216,"seed":2407665985,'
                '"steps":27,"sampler":"k_euler_ancestral","scale":5,'
                '"cfg_rescale":0,"request_type":"Text to Image"}'
            ),
        })

        nai = meta["nai"]
        self.assertEqual(nai["prompt"], "Artist:hanada ten, simple background, masterpiece")
        self.assertEqual(nai["negative_prompt"], "nsfw, lowres, bad quality")
        self.assertEqual(nai["software"], "NovelAI")
        self.assertEqual(nai["model"], "NovelAI Diffusion V4.5 4BDE2A90")
        self.assertEqual(nai["size"], "832x1216")

    def test_exif_unicode_user_comment_accepts_utf16be(self):
        media_metadata = _load_repo_module("media_metadata")

        raw = b"UNICODE\x00" + "masterpiece, 湖\nSteps: 20, Seed: 42".encode("utf-16be")
        text = media_metadata._decode_exif_user_comment(raw)

        self.assertIn("masterpiece", text)
        self.assertIn("湖", text)
        self.assertIn("Seed: 42", text)


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

    def test_comfy_bridge_upload_indexes_input_file_best_effort(self):
        source = (REPO_ROOT / "web" / "js" / "core" / "comfy-bridge.js").read_text(encoding="utf-8")

        self.assertIn("this.fetchApi('/drawer/fs/index-generated'", source)
        self.assertIn("root: 'input'", source)
        self.assertIn("name: result.name", source)

    def test_metadata_display_accepts_raw_metadata_without_workflow(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")

        self.assertIn("Object.keys(meta).length", source)
        self.assertNotIn("return (meta && (meta.prompt || meta.workflow)) ? meta : null", source)

    def test_a1111_metadata_delegates_workflow_open_to_native_handle_file(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")

        self.assertIn("function canOpenWorkflowFromMeta(meta, item = {})", source)
        self.assertIn("return isPng && !!meta?.a1111", source)
        self.assertIn("async function openMediaViaNativeHandler", source)
        self.assertIn("await bridge.handleFile(file)", source)
        self.assertIn("if (canOpenWorkflowFromMeta(meta, { ...item, name }))", source)

    def test_generation_metadata_has_formatted_overview(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        css = (REPO_ROOT / "web" / "css" / "dialog.css").read_text(encoding="utf-8")

        self.assertIn("const addGenerationOverview = (parent, meta)", source)
        self.assertIn("A1111 Overview", source)
        self.assertIn("NovelAI Overview", source)
        self.assertIn("cd-meta-prompt-box", source)
        self.assertIn("cd-meta-setting-grid", css)

    def test_context_menu_can_resync_file_metadata_from_disk(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        routes = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        index = (REPO_ROOT / "search_index.py").read_text(encoding="utf-8")

        self.assertIn("async function syncMediaMetadataIndex(ctx)", source)
        self.assertIn("id: 'media:sync-metadata'", source)
        self.assertIn("replace: true", source)
        self.assertIn("showToast(t('menu.syncMetadataDone'", source)
        self.assertIn("ctx.hasMetadata !== false && (ctx.root || ctx.source) !== 'temp'", source)
        self.assertIn("checkMetadataAvailable", source)
        self.assertIn("cd-toast", source)
        self.assertIn("index_files_from_disk(files[:200], replace=replace)", routes)
        self.assertIn("def index_files_from_disk(self, entries, *, replace=False):", index)
        self.assertIn("and not replace", index)

    def test_context_menu_has_refresh_icon(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "context-menu.js").read_text(encoding="utf-8")

        self.assertIn("'refresh-cw': iconSvg", source)

    def test_context_menu_supports_compact_footer_actions(self):
        service = (REPO_ROOT / "web" / "js" / "services" / "context-menu.js").read_text(encoding="utf-8")
        drawer = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        gallery = (REPO_ROOT / "web" / "gadgets" / "gallery" / "gallery-gadget.js").read_text(encoding="utf-8")
        css = (REPO_ROOT / "web" / "css" / "context-menu.css").read_text(encoding="utf-8")

        self.assertIn("const compact = visible", service)
        self.assertIn("cd-ctxmenu-footer", service)
        self.assertIn("#createCompactItem", service)
        self.assertIn(".cd-ctxmenu-compact-item", css)
        self.assertIn("id: 'media:download'", drawer)
        self.assertIn("compact: true", drawer)
        self.assertIn("const targetRank = (target) =>", drawer)
        self.assertIn("if (type === 'LoadImage') return 0", drawer)
        self.assertIn("if (type === 'LoadImageMask') return 1", drawer)
        self.assertIn("order: 60 + targetRank(target)", drawer)
        self.assertIn("enumerateLoadImageTargets(bridge, { maskOnly: true }).length > 0", drawer)
        self.assertIn("id: 'gallery:delete'", gallery)
        self.assertIn("danger: true,\n                compact: true", gallery)

    def test_search_paginates_after_python_term_filtering(self):
        source = (REPO_ROOT / "search_index.py").read_text(encoding="utf-8")

        self.assertIn(
            'post_filtering = bool(node_filters or custom_filters or terms.get("include") or terms.get("exclude"))',
            source,
        )


if __name__ == "__main__":
    unittest.main()
