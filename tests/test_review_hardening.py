import json
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

    def test_dict_file_path_rejects_unsafe_ids(self):
        """dict_file_path must refuse anything outside [A-Za-z0-9_-].

        The old behavior silently replaced `/`, `\\`, `..` and returned a
        sanitized path. That left Windows drive letters (`c:foo`) and
        alternate streams (`name:foo`) intact, both of which can escape the
        dict directory on Windows. The hardened contract is to reject the
        id outright.
        """
        original_get_user_directory = folder_paths.get_user_directory
        with tempfile.TemporaryDirectory() as tmp:
            folder_paths.get_user_directory = lambda: tmp
            try:
                for bad in (
                    "../bad\\id",
                    "..",
                    "name:foo",
                    "c:bad",
                    "with/slash",
                    "with\\backslash",
                    "",
                    "name with space",
                ):
                    with self.assertRaises((ValueError, dict_store.InvalidDictId)):
                        dict_store.dict_file_path(bad, "dict")

                # Valid ids still produce a path under drawer_dicts/
                good = dict_store.dict_file_path("abc12345", "dict")
                self.assertTrue(good.startswith(os.path.join(tmp, "drawer_dicts")))
                self.assertEqual(os.path.basename(good), "abc12345.csv")
            finally:
                folder_paths.get_user_directory = original_get_user_directory

    def test_broken_manifest_is_backed_up_and_recreated(self):
        original_get_user_directory = folder_paths.get_user_directory
        with tempfile.TemporaryDirectory() as tmp:
            folder_paths.get_user_directory = lambda: tmp
            try:
                os.makedirs(dict_store.dicts_dir(), exist_ok=True)
                with open(dict_store.manifest_path(), "w", encoding="utf-8") as f:
                    f.write("{ broken")

                self.assertEqual(dict_store.read_manifest(), [])
                self.assertTrue(os.path.isfile(dict_store.manifest_path()))
                backups = [
                    name for name in os.listdir(dict_store.dicts_dir())
                    if name.startswith("manifest.json.broken.")
                ]
                self.assertTrue(backups)
            finally:
                folder_paths.get_user_directory = original_get_user_directory


class MediaMetadataHardeningTests(unittest.TestCase):
    def test_iTXt_zlib_decompress_is_size_capped(self):
        """C10: iTXt 'parameters' bomb (high-ratio zlib) must be skipped.

        Regression for the case where the decompressed payload would exceed
        _MAX_META_CHUNK_BYTES. The chunk must be silently dropped, not used
        to inflate gigabytes into memory during routine indexing.
        """
        import struct
        import zlib

        media_metadata = _load_repo_module("media_metadata")

        # Build a payload that decompresses to ~64 MiB of 'A' — far above the
        # 16 MiB cap. Compressed size stays tiny.
        big_payload = b"A" * (64 * 1024 * 1024)
        compressed = zlib.compress(big_payload, level=9)
        # iTXt body: keyword \x00 compFlag(1) compMethod(1) langTag \x00 transKey \x00 textData
        keyword = b"parameters"
        body = keyword + b"\x00" + b"\x01" + b"\x00" + b"" + b"\x00" + b"" + b"\x00" + compressed
        chunk = b"iTXt" + body
        # Build a minimal PNG: signature + IHDR + iTXt + IEND
        png_sig = b"\x89PNG\r\n\x1a\n"
        ihdr_data = struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0)
        ihdr_chunk = struct.pack(">I", len(ihdr_data)) + b"IHDR" + ihdr_data + struct.pack(">I", 0)
        itxt_chunk = struct.pack(">I", len(body)) + chunk + struct.pack(">I", 0)
        iend_chunk = struct.pack(">I", 0) + b"IEND" + struct.pack(">I", 0)
        png_bytes = png_sig + ihdr_chunk + itxt_chunk + iend_chunk

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fp:
            fp.write(png_bytes)
            path = fp.name
        try:
            chunks = media_metadata._read_png_text_chunks(path)
            # The high-ratio chunk should be refused — the keyword must not
            # appear in the result. If decompression were uncapped this
            # would either OOM or succeed.
            self.assertNotIn("parameters", chunks)
        finally:
            os.unlink(path)


class RouteHardeningSiblingDeleteTests(unittest.TestCase):
    """C1: delete_model must keep sibling-stem previews when another model
    file with the same stem still exists in the directory.
    """

    def test_delete_model_keeps_shared_stem_previews_for_siblings(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # The hardened branch keeps shared-stem previews when has_sibling
        # remains True. We assert the source contains the guard rather than
        # exercising the route (which requires aiohttp).
        self.assertIn("has_sibling = False", source)
        self.assertIn("if not has_sibling:", source)
        self.assertIn("_SHARED_PREVIEW_EXTS", source)

    def test_delete_model_refuses_symlinked_sidecars(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("os.path.islink(path)", source)


class MergeDirsHardeningTests(unittest.TestCase):
    """C5: _merge_dirs must refuse symlinks and cap recursion depth."""

    def test_merge_dirs_has_depth_limit_and_symlink_guard(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("_MERGE_DIRS_MAX_DEPTH", source)
        self.assertIn("os.path.islink(src_dir)", source)
        self.assertIn("os.path.islink(item_src)", source)
        self.assertIn("Refused to merge symlinked directory", source)


class CivitaiDownloadHardeningTests(unittest.TestCase):
    """C2: external CivitAI downloads must use the size-capped helper."""

    def test_civitai_paths_use_download_helper(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("_download_preview_to_file", source)
        # Allowed content types are restricted, not arbitrary
        self.assertIn("_ALLOWED_PREVIEW_CONTENT_TYPES", source)
        # The dangerous unbounded read pattern is gone
        self.assertNotIn('await img_resp.read()\n', source)


class FsMoveOverwriteTests(unittest.TestCase):
    """C7: fs_move overwrite must use the recycle bin, not os.remove."""

    def test_fs_move_overwrite_uses_trash_file(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # In the overwrite branch, look for the _trash_file call and no
        # raw os.remove on dst_path.
        # Find the conflict=="overwrite" block heuristically.
        marker = 'CONVENTIONS: gallery-browsed media must'
        self.assertIn(marker, source)
        # Ensure os.remove(dst_path) is no longer present in the move route.
        self.assertNotIn("os.remove(dst_path)", source)


class SearchIndexInputValidationTests(unittest.TestCase):
    """C8: search_index.update_searchable must validate paths via _safe_path."""

    def test_update_searchable_uses_safe_path(self):
        source = (REPO_ROOT / "search_index.py").read_text(encoding="utf-8")
        # The relevant snippet uses self._safe_path now, not raw os.path.join.
        self.assertIn("self._safe_path(root_path, subfolder, name)", source)


class ImportUserDictDoubleDecodeTests(unittest.TestCase):
    """F4: import_user_dict must NOT double-decode the multipart body.

    aiohttp's BodyPartReader auto-decodes the transfer-encoding while
    streaming, so calling `part.decode(bytes)` a second time can either
    no-op or, when the part carries a Content-Transfer-Encoding header,
    change the bytes/str type so the later `.decode("utf-8")` raises.
    """

    def test_import_user_dict_does_not_double_decode(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # The dangerous `part.decode(file_data)` line is gone.
        self.assertNotIn("file_data = part.decode(file_data)", source)
        # The explanatory comment is still there as a guard for future edits.
        self.assertIn("do NOT call `part.decode(file_data)`", source)


class FsHandlersUseAsyncIOToThreadTests(unittest.TestCase):
    """F5: state-changing fs handlers must run blocking I/O on a worker
    thread so a long delete/move/rename does not stall the event loop.
    """

    def test_fs_delete_loop_runs_in_to_thread(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # The trash + thumbnail + index loop is wrapped in to_thread.
        self.assertIn("await asyncio.to_thread(_do_delete)", source)

    def test_fs_move_loop_runs_in_to_thread(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("await asyncio.to_thread(_do_move)", source)

    def test_fs_rename_runs_in_to_thread(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("await asyncio.to_thread(_do_rename)", source)

    def test_fs_mkdir_runs_in_to_thread(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("await asyncio.to_thread(os.makedirs", source)

    def test_delete_model_runs_in_to_thread(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("await asyncio.to_thread(_do_delete_model)", source)

    def test_clear_drawer_cache_runs_in_to_thread(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("await asyncio.to_thread(_do_clear)", source)


class SymlinkSafeIterationTests(unittest.TestCase):
    """F6: directory iteration must skip symlinks so a link inside an
    allowed root cannot expose paths outside it.
    """

    def test_fs_browse_uses_scandir_with_follow_symlinks_false(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # The fs_browse scanner switched from os.listdir + isdir to
        # os.scandir + follow_symlinks=False and explicitly skips
        # symlinked entries.
        self.assertIn("os.scandir(target)", source)
        self.assertIn("entry.is_dir(follow_symlinks=False)", source)
        self.assertIn("entry.is_file(follow_symlinks=False)", source)
        self.assertIn("entry.stat(follow_symlinks=False)", source)
        self.assertIn("if entry.is_symlink()", source)

    def test_search_filesystem_raw_skips_symlinks(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # _search_filesystem_raw drops symlinked subdirs from os.walk and
        # skips symlinked files.
        self.assertIn(
            "not os.path.islink(os.path.join(dirpath, d))",
            source,
        )

    def test_summarize_tree_skips_symlinks(self):
        source = (REPO_ROOT / "fs_utils.py").read_text(encoding="utf-8")
        self.assertIn("os.path.islink(full)", source)
        self.assertIn(
            "not os.path.islink(os.path.join(dirpath, d))",
            source,
        )

    def test_clear_drawer_cache_skips_symlinks_in_thumbs(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # The thumbnail-cache walk under clear_drawer_cache also drops
        # symlinks before computing freed_bytes / deleted counts.
        self.assertIn("os.path.islink(thumb_dir)", source)


class MaskServiceReentryTests(unittest.TestCase):
    """F3: MaskService.open() must not leak a pending promise on re-entry,
    and Escape should be a cancel handler.
    """

    def test_mask_service_resolves_previous_promise_on_reentry(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "mask-service.js").read_text(encoding="utf-8")
        self.assertIn("Reentrant open", source)
        self.assertIn("try { prev(null); }", source)

    def test_mask_service_installs_escape_handler(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "mask-service.js").read_text(encoding="utf-8")
        self.assertIn("_onDocumentKeyDown", source)
        # Escape now lives inside the combined keydown handler that also
        # implements the focus trap (a11y pass).
        self.assertIn("if (e.key === 'Escape') {", source)


class SettingsPanelCleanupTests(unittest.TestCase):
    """F1/F2: the settings dialog must unsubscribe its onChange listeners
    and avoid attaching a MutationObserver per action setting.
    """

    def test_open_settings_panel_runs_cleanups_on_dismiss(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "settings-panel.js").read_text(encoding="utf-8")
        self.assertIn("onDismiss: runCleanups", source)
        self.assertIn("const cleanups = [];", source)

    def test_action_setting_no_longer_attaches_subtree_observer(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "settings-panel.js").read_text(encoding="utf-8")
        # The MutationObserver-on-document.body workaround is gone from
        # createAction. The shared `cleanups` array carries the work.
        self.assertNotIn(
            "observer.observe(document.body, { childList: true, subtree: true })",
            source,
        )


class DrawerRebootIsAsyncTests(unittest.TestCase):
    """C6: /drawer/reboot must be an async handler with deferred exec."""

    def test_drawer_reboot_is_async(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("async def drawer_reboot(request):", source)
        self.assertIn("_exec_after_response", source)
        self.assertIn("asyncio.create_task(_exec_after_response", source)


class DialogAccessibilityTests(unittest.TestCase):
    """A1-A3: showDialog must expose ARIA modal semantics, trap Tab, and
    restore focus on dismiss. Without these, a screen-reader user is not
    told a modal opened, Tab leaks into the canvas behind the dialog,
    and focus stays on the no-longer-existent close button after close.
    """

    def test_dialog_sets_role_modal_and_labelledby(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "dialog.js").read_text(encoding="utf-8")
        self.assertIn("dialog.setAttribute('role', 'dialog')", source)
        self.assertIn("dialog.setAttribute('aria-modal', 'true')", source)
        self.assertIn("dialog.setAttribute('aria-labelledby', titleId)", source)

    def test_dialog_traps_tab_within_focusable_descendants(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "dialog.js").read_text(encoding="utf-8")
        # The focus trap branch lives inside the keydown handler.
        self.assertIn("e.key === 'Tab'", source)
        self.assertIn("_getFocusable(dialog)", source)
        self.assertIn("Focus trap", source)

    def test_dialog_restores_focus_on_dismiss(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "dialog.js").read_text(encoding="utf-8")
        self.assertIn("prevActiveElement", source)
        self.assertIn("prevActiveElement.focus({ preventScroll: true })", source)


class LightboxAccessibilityTests(unittest.TestCase):
    """A4: openLightbox must expose ARIA modal semantics, trap Tab to the
    nav buttons, restore focus on close, and set <img> alt per item.
    """

    def test_lightbox_root_carries_dialog_aria(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "lightbox.js").read_text(encoding="utf-8")
        self.assertIn('role="dialog"', source)
        self.assertIn('aria-modal="true"', source)
        self.assertIn('aria-labelledby="cd-lightbox-label"', source)
        self.assertIn('aria-label="Previous"', source)
        self.assertIn('aria-label="Next"', source)
        self.assertIn('aria-label="Close"', source)

    def test_lightbox_focus_trap_branch_present(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "lightbox.js").read_text(encoding="utf-8")
        self.assertIn("case 'Tab':", source)
        self.assertIn("[el.close, el.prev, el.next]", source)

    def test_lightbox_restores_focus_on_close(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "lightbox.js").read_text(encoding="utf-8")
        self.assertIn("_prevActiveElement", source)
        self.assertIn("_prevActiveElement.focus({ preventScroll: true })", source)

    def test_lightbox_img_alt_reflects_item(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "lightbox.js").read_text(encoding="utf-8")
        self.assertIn("el.img.alt = item.label || item.name || ''", source)


class MaskServiceAccessibilityTests(unittest.TestCase):
    """A5: MaskService overlay must expose role=dialog, restore focus on
    close, and trap Tab/Escape inside the overlay.
    """

    def test_mask_overlay_has_dialog_aria(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "mask-service.js").read_text(encoding="utf-8")
        self.assertIn("el.setAttribute('role', 'dialog')", source)
        self.assertIn("el.setAttribute('aria-modal', 'true')", source)

    def test_mask_service_restores_focus(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "mask-service.js").read_text(encoding="utf-8")
        self.assertIn("_prevActiveElement", source)
        self.assertIn("_prevActiveElement.focus({ preventScroll: true })", source)

    def test_mask_service_has_tab_focus_trap(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "mask-service.js").read_text(encoding="utf-8")
        self.assertIn("if (e.key !== 'Tab') return;", source)
        # The trap uses the same focusable-button collection pattern
        self.assertIn("_overlay.querySelectorAll(", source)


class InternalErrorHelperTests(unittest.TestCase):
    """E1: 500 responses must not leak `str(e)` (which often contains the
    server's absolute filesystem path via OSError/PermissionError).
    """

    def test_internal_error_helper_exists(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        self.assertIn("def _internal_error(exc", source)
        self.assertIn('"error": error', source)
        # The default error message must NOT include the exception text.
        self.assertIn('error="internal error"', source)

    def test_500_routes_route_through_internal_error(self):
        """Every `status=500` response inside drawer_routes.py must route
        through _internal_error rather than echoing str(e)/`{e}` to the
        client. Helper definitions themselves are excluded.
        """
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        # No surviving `status=500` site that interpolates the exception.
        self.assertNotRegex(source, r'"error":\s*str\(e\)[^,]*,\s*status=500')
        self.assertNotRegex(source, r'"error":\s*f"[^"]*\{e\}[^"]*",\s*status=500')


class GadgetLabelSafetyTests(unittest.TestCase):
    """L1: drawer-shell must build tab/burger labels via textContent so a
    third-party gadget cannot inject HTML through its registered label.
    """

    def test_drawer_shell_uses_textcontent_for_gadget_labels(self):
        source = (REPO_ROOT / "web" / "js" / "core" / "drawer-shell.js").read_text(encoding="utf-8")
        # The unsafe `${gadget.label}` interpolation into innerHTML is gone.
        self.assertNotIn("<span class=\"comfy-drawer-tab-label\">${gadget.label}</span>", source)
        # The DOM-build path uses textContent for the label.
        self.assertIn("labelSpan.textContent = gadget.label", source)
        # Burger items go through the shared _buildBurgerItem helper that
        # also uses textContent.
        self.assertIn("const _buildBurgerItem", source)
        self.assertIn("labelSpan.textContent = labelText", source)


class DialogHistoryHygieneTests(unittest.TestCase):
    """Dialog history pollution was previously "fixed" by calling
    history.back() on dismiss, but that triggered DrawerShell's own
    popstate handler and cascade-closed the drawer. The accepted design
    (documented in both dialog.js and drawer-shell.js) is to leave the
    synthetic entry stale. This test pins that contract so a future
    refactor doesn't re-introduce the cascade regression.
    """

    def test_dialog_does_not_call_history_back_on_dismiss(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "dialog.js").read_text(encoding="utf-8")
        # Mentions of `history.back()` in COMMENTS are fine (documenting
        # the deliberate avoidance). What we're guarding against is an
        # *active call*. A statement-form call would be followed by `;`.
        import re
        # Strip line comments first so the regex doesn't match doc text.
        stripped = re.sub(r'//[^\n]*', '', source)
        self.assertNotRegex(stripped, r'history\.back\(\)\s*;')


class EscapeHTMLConsolidationTests(unittest.TestCase):
    """L3: per-file escapeHTML/escapeText duplicates were lossy (they did
    not escape quotes). Everything now routes through the shared
    escapeHTML in utils.js.
    """

    def test_image_picker_imports_shared_escapeHTML(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "image-picker.js").read_text(encoding="utf-8")
        self.assertIn("from '../utils.js'", source)
        # The local copy is gone — no `function escapeHTML(s)` body.
        self.assertNotIn("el.textContent = s;\n    return el.innerHTML;", source)

    def test_settings_panel_imports_shared_escapeHTML(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "settings-panel.js").read_text(encoding="utf-8")
        self.assertIn("import { escapeHTML } from '../utils.js'", source)
        self.assertIn("return s == null ? '' : escapeHTML(s);", source)


class ParseIntRadixTests(unittest.TestCase):
    """L4: every parseInt() in the frontend must carry an explicit radix
    so a numeric input starting with '0x' (manual tampering or future
    code) cannot be silently parsed as hex.
    """

    @staticmethod
    def _parseInt_call_has_radix(text, start):
        """Walk `parseInt(...)` from `start` with proper paren balance and
        return True iff a comma-separated second argument is present at
        the top level (i.e. a radix, not a comma inside a nested call).
        """
        depth = 0
        top_level_comma = False
        i = start
        while i < len(text):
            c = text[i]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return top_level_comma
            elif c == "," and depth == 1:
                top_level_comma = True
            i += 1
        return False  # unbalanced; treat as offender

    def test_no_parseInt_without_radix_in_frontend(self):
        frontend_dir = REPO_ROOT / "web"
        offenders = []
        for path in frontend_dir.rglob("*.js"):
            text = path.read_text(encoding="utf-8")
            idx = 0
            while True:
                hit = text.find("parseInt(", idx)
                if hit < 0:
                    break
                # Skip identifier-prefixed matches like `myParseInt(` /
                # `Number.parseInt(` (the latter is fine but rare).
                before = text[hit - 1] if hit > 0 else ""
                if before.isalnum() or before == "_" or before == ".":
                    idx = hit + 1
                    continue
                paren_start = hit + len("parseInt")  # at the '('
                if not self._parseInt_call_has_radix(text, paren_start):
                    # Capture a short snippet for the error message
                    snippet_end = min(len(text), paren_start + 60)
                    snippet = text[hit:snippet_end].split("\n", 1)[0]
                    offenders.append(f"{path.name}: {snippet}")
                idx = paren_start + 1
        self.assertEqual(offenders, [], "parseInt without radix:\n" + "\n".join(offenders))


class LocaleParityTests(unittest.TestCase):
    """L5: en/ja/zh locale files must have identical key sets so a
    string added in one is never silently missing in another.
    """

    @staticmethod
    def _flatten(obj, prefix=""):
        out = {}
        for k, v in obj.items():
            full = prefix + k
            if isinstance(v, dict):
                out.update(LocaleParityTests._flatten(v, full + "."))
            else:
                out[full] = v
        return out

    def test_en_ja_zh_share_the_same_key_set(self):
        en = self._flatten(json.loads((REPO_ROOT / "web" / "locales" / "en.json").read_text(encoding="utf-8")))
        ja = self._flatten(json.loads((REPO_ROOT / "web" / "locales" / "ja.json").read_text(encoding="utf-8")))
        zh = self._flatten(json.loads((REPO_ROOT / "web" / "locales" / "zh.json").read_text(encoding="utf-8")))
        self.assertEqual(set(en), set(ja), f"en/ja diff: {sorted(set(en) ^ set(ja))[:5]}")
        self.assertEqual(set(en), set(zh), f"en/zh diff: {sorted(set(en) ^ set(zh))[:5]}")

    def test_metadata_viewer_section_titles_are_localised(self):
        en = json.loads((REPO_ROOT / "web" / "locales" / "en.json").read_text(encoding="utf-8"))
        # Every label inside the metadata viewer dialog must have a key.
        for k in (
            "metaSummary", "metaFile", "metaLocation", "metaWorkflow",
            "metaWorkflowNodes", "metaPromptNodes", "metaImportable",
            "metaOnly", "metaWorkflowOverview", "metaPrompt",
            "metaNegativePrompt", "metaA1111Overview", "metaNAIOverview",
            "metaShowLabels", "metaShownNodeTypesNone", "metaShownNodeTypes",
            "metaShownNodeTypesPlural", "metaAddNodeType",
            "metaHideFromView", "metaEmptyHint", "metaThirdParty",
            "metaRawJson",
        ):
            self.assertIn(k, en["menu"], f"missing: menu.{k}")
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        # The previous hardcoded strings are gone; the new keys are used.
        self.assertNotIn("textContent = 'Summary'", source)
        self.assertNotIn("textContent = 'Raw JSON'", source)
        self.assertNotIn("'Show labels'", source)

    def test_deck_active_bypass_labels_are_localised(self):
        source = (REPO_ROOT / "web" / "gadgets" / "deck" / "deck-gadget.js").read_text(encoding="utf-8")
        # The toggle label flips between deck.active and deck.bypass keys.
        self.assertIn("_t('deck.active')", source)
        self.assertIn("_t('deck.bypass')", source)
        self.assertNotIn("? 'Active' : 'Bypass'", source)

    def test_common_errorWith_key_replaces_string_concat(self):
        en = json.loads((REPO_ROOT / "web" / "locales" / "en.json").read_text(encoding="utf-8"))
        self.assertIn("errorWith", en["common"])
        self.assertIn("{message}", en["common"]["errorWith"])
        # All three locales use the {message} placeholder.
        ja = json.loads((REPO_ROOT / "web" / "locales" / "ja.json").read_text(encoding="utf-8"))
        zh = json.loads((REPO_ROOT / "web" / "locales" / "zh.json").read_text(encoding="utf-8"))
        self.assertIn("{message}", ja["common"]["errorWith"])
        self.assertIn("{message}", zh["common"]["errorWith"])
        # Gallery + ModelViewer no longer string-concatenate the message.
        for fname in ("gallery/gallery-gadget.js", "modelviewer/modelviewer-gadget.js"):
            path = REPO_ROOT / "web" / "gadgets" / fname
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("_t('common.error') + ': ' + e.message", text, fname)
            self.assertNotIn("_t('common.error') + ': ' + data.error", text, fname)

    def test_xyzplot_sweep_caution_strings_are_localised(self):
        en = json.loads((REPO_ROOT / "web" / "locales" / "en.json").read_text(encoding="utf-8"))
        # The hardcoded Japanese warning text in xyzplot-gadget.js is gone;
        # all eight keys live in en/ja/zh now.
        for k in (
            "sweepCautionTitle", "sweepCautionIntro",
            "sweepCautionDontTouch", "sweepCautionWorkflowChange",
            "sweepCautionAxisGuess", "sweepCautionCanvasLock",
            "sweepCautionDontShowAgain", "sweepStart",
        ):
            self.assertIn(k, en["xyzplot"], f"missing: xyzplot.{k}")
        source = (REPO_ROOT / "web" / "gadgets" / "xyzplot" / "xyzplot-gadget.js").read_text(encoding="utf-8")
        # No more hardcoded Japanese sentences in the source.
        self.assertNotIn("次回以降表示しない", source)
        self.assertNotIn("XYZ Sweep について", source)

    def test_gallery_temp_warning_strings_are_localised(self):
        en = json.loads((REPO_ROOT / "web" / "locales" / "en.json").read_text(encoding="utf-8"))
        # The hardcoded Japanese warning text in gallery-gadget.js was
        # replaced with these keys, and Gallery now uses _t() to look
        # them up. Sanity-check that all four keys exist in en.json.
        for k in ("tempWarningTitle", "tempWarningCleared",
                  "tempWarningNotIndexed", "tempWarningDontShowAgain",
                  "tempNotSearchable"):
            self.assertIn(k, en["gallery"], f"missing: gallery.{k}")
        # The fixed JP text is gone from the source so adding a new
        # language doesn't require a second edit.
        source = (REPO_ROOT / "web" / "gadgets" / "gallery" / "gallery-gadget.js").read_text(encoding="utf-8")
        self.assertNotIn("Temp フォルダーについて", source)
        self.assertNotIn("Cannot search in Temp folder", source)


class ToastServiceTests(unittest.TestCase):
    """T1-T3: the shared toast service replaces per-gadget DOM toasts."""

    def test_toast_service_module_exists(self):
        path = REPO_ROOT / "web" / "js" / "services" / "toast.js"
        self.assertTrue(path.is_file(), "toast.js missing")
        source = path.read_text(encoding="utf-8")
        self.assertIn("export function showToast", source)
        # role+aria-live region for screen-reader announcements
        self.assertIn("aria-live", source)
        self.assertIn("'region'", source)

    def test_comfy_drawer_imports_and_exports_show_toast(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        self.assertIn('from "./services/toast.js"', source)
        # The local function-scoped showToast definition is gone — the
        # imported one takes over.
        self.assertNotIn("function showToast(message, { duration", source)

    def test_gallery_delegates_to_platform_show_toast(self):
        source = (REPO_ROOT / "web" / "gadgets" / "gallery" / "gallery-gadget.js").read_text(encoding="utf-8")
        self.assertIn("window.ComfyDrawer?.showToast", source)

    def test_modelviewer_delegates_to_platform_show_toast(self):
        source = (REPO_ROOT / "web" / "gadgets" / "modelviewer" / "modelviewer-gadget.js").read_text(encoding="utf-8")
        self.assertIn("window.ComfyDrawer?.showToast", source)


class ImagePickerAccessibilityTests(unittest.TestCase):
    """A6: image-picker popup must expose role=dialog, trap Tab, and
    restore focus on close.
    """

    def test_image_picker_has_dialog_aria(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "image-picker.js").read_text(encoding="utf-8")
        self.assertIn("panel.setAttribute('role', 'dialog')", source)
        self.assertIn("panel.setAttribute('aria-modal', 'true')", source)
        self.assertIn("panel.setAttribute('aria-labelledby'", source)

    def test_image_picker_restores_focus(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "image-picker.js").read_text(encoding="utf-8")
        self.assertIn("prevActiveElement", source)
        self.assertIn("prevActiveElement.focus({ preventScroll: true })", source)

    def test_image_picker_has_tab_focus_trap(self):
        source = (REPO_ROOT / "web" / "js" / "services" / "image-picker.js").read_text(encoding="utf-8")
        # New Tab branch in onKey
        self.assertIn("if (e.key !== 'Tab') return;", source)
        self.assertIn("panel.querySelectorAll(", source)


class RequestGuardTests(unittest.TestCase):
    class _Request:
        def __init__(self, headers):
            self.headers = headers

    def test_same_origin_allows_matching_origin(self):
        try:
            request_guards = _load_repo_module("request_guards")
        except ModuleNotFoundError as e:
            if e.name == "aiohttp":
                self.skipTest("aiohttp is unavailable")
            raise

        request_guards.require_same_origin(self._Request({
            "Host": "127.0.0.1:8188",
            "Origin": "http://127.0.0.1:8188",
            "Sec-Fetch-Site": "same-origin",
        }))

    def test_same_origin_rejects_cross_site(self):
        try:
            from aiohttp import web
            request_guards = _load_repo_module("request_guards")
        except ModuleNotFoundError as e:
            if e.name == "aiohttp":
                self.skipTest("aiohttp is unavailable")
            raise

        with self.assertRaises(web.HTTPForbidden):
            request_guards.require_same_origin(self._Request({
                "Host": "127.0.0.1:8188",
                "Origin": "https://example.com",
                "Sec-Fetch-Site": "cross-site",
            }))


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

    def test_thumbnail_cache_merges_folder_cache_with_replace(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            src_dir = os.path.join(root, ".thumbs", "src-folder")
            dst_dir = os.path.join(root, ".thumbs", "dst-folder")
            os.makedirs(os.path.join(src_dir, "nested"))
            os.makedirs(dst_dir)
            with open(os.path.join(src_dir, "same.png.webp"), "wb") as f:
                f.write(b"new")
            with open(os.path.join(src_dir, "nested", "child.png.webp"), "wb") as f:
                f.write(b"child")
            with open(os.path.join(dst_dir, "same.png.webp"), "wb") as f:
                f.write(b"old")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "", "src-folder",
                root, "", "dst-folder",
                is_dir=True,
            )

            self.assertTrue(moved)
            self.assertFalse(os.path.exists(src_dir))
            with open(os.path.join(dst_dir, "same.png.webp"), "rb") as f:
                self.assertEqual(f.read(), b"new")
            with open(os.path.join(dst_dir, "nested", "child.png.webp"), "rb") as f:
                self.assertEqual(f.read(), b"child")

    def test_thumbnail_cache_merge_does_not_follow_destination_child_symlink(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            outside = os.path.join(tmp, "outside")
            src_dir = os.path.join(root, ".thumbs", "src-folder")
            dst_dir = os.path.join(root, ".thumbs", "dst-folder")
            os.makedirs(os.path.join(src_dir, "nested"))
            os.makedirs(dst_dir)
            os.makedirs(outside)
            try:
                os.symlink(outside, os.path.join(dst_dir, "nested"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")
            with open(os.path.join(src_dir, "nested", "child.png.webp"), "wb") as f:
                f.write(b"child")
            outside_marker = os.path.join(outside, "marker.txt")
            with open(outside_marker, "w", encoding="utf-8") as f:
                f.write("outside")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "", "src-folder",
                root, "", "dst-folder",
                is_dir=True,
            )

            self.assertTrue(moved)
            self.assertTrue(os.path.isfile(outside_marker))
            self.assertFalse(os.path.islink(os.path.join(dst_dir, "nested")))
            with open(os.path.join(dst_dir, "nested", "child.png.webp"), "rb") as f:
                self.assertEqual(f.read(), b"child")

    def test_thumbnail_cache_merge_drops_source_child_symlink(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            outside = os.path.join(tmp, "outside")
            src_dir = os.path.join(root, ".thumbs", "src-folder")
            dst_dir = os.path.join(root, ".thumbs", "dst-folder")
            os.makedirs(src_dir)
            os.makedirs(dst_dir)
            os.makedirs(outside)
            outside_target = os.path.join(outside, "target.webp")
            with open(outside_target, "wb") as f:
                f.write(b"outside")
            try:
                os.symlink(outside_target, os.path.join(src_dir, "linked.png.webp"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")
            with open(os.path.join(src_dir, "normal.png.webp"), "wb") as f:
                f.write(b"normal")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "", "src-folder",
                root, "", "dst-folder",
                is_dir=True,
            )

            self.assertTrue(moved)
            self.assertFalse(os.path.exists(os.path.join(dst_dir, "linked.png.webp")))
            self.assertTrue(os.path.isfile(outside_target))
            with open(os.path.join(dst_dir, "normal.png.webp"), "rb") as f:
                self.assertEqual(f.read(), b"normal")

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

    def test_thumbnail_cache_rejects_thumbs_symlink_to_root_internal_dir(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            real_dir = os.path.join(root, "real-thumbs")
            os.makedirs(root)
            os.makedirs(real_dir)
            try:
                os.symlink(real_dir, os.path.join(root, ".thumbs"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")
            real_thumb = os.path.join(real_dir, "image.png.webp")
            with open(real_thumb, "wb") as f:
                f.write(b"not drawer cache")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "", "image.png",
                root, "nested", "image.png",
            )
            removed = thumbnails.remove_gallery_thumbnail_cache(root, "", "image.png")

            self.assertFalse(moved)
            self.assertFalse(removed)
            self.assertTrue(os.path.isfile(real_thumb))

    def test_thumbnail_cache_rejects_thumbs_symlink_to_root_internal_path(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            real_dir = os.path.join(root, "real-cache-looking-dir")
            thumbs_dir = os.path.join(root, ".thumbs")
            os.makedirs(real_dir)
            os.makedirs(thumbs_dir)
            try:
                os.symlink(real_dir, os.path.join(thumbs_dir, "nested"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")
            real_thumb = os.path.join(real_dir, "image.png.webp")
            with open(real_thumb, "wb") as f:
                f.write(b"not drawer cache")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "nested", "image.png",
                root, "other", "image.png",
            )
            removed = thumbnails.remove_gallery_thumbnail_cache(root, "nested", "image.png")

            self.assertFalse(moved)
            self.assertFalse(removed)
            self.assertTrue(os.path.isfile(real_thumb))

    def test_thumbnail_cache_rejects_symlink_components_inside_thumbs(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            real_dir = os.path.join(root, ".thumbs", "real")
            os.makedirs(real_dir)
            try:
                os.symlink(real_dir, os.path.join(root, ".thumbs", "nested"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")
            real_thumb = os.path.join(real_dir, "image.png.webp")
            with open(real_thumb, "wb") as f:
                f.write(b"inside thumbs")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "nested", "image.png",
                root, "other", "image.png",
            )
            removed = thumbnails.remove_gallery_thumbnail_cache(root, "nested", "image.png")

            self.assertFalse(moved)
            self.assertFalse(removed)
            self.assertTrue(os.path.isfile(real_thumb))

    def test_thumbnail_cache_rejects_final_thumbnail_symlink(self):
        thumbnails = _load_repo_module("thumbnails")
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            real_dir = os.path.join(root, ".thumbs", "real")
            os.makedirs(os.path.join(root, ".thumbs"))
            os.makedirs(real_dir)
            real_thumb = os.path.join(real_dir, "target.webp")
            with open(real_thumb, "wb") as f:
                f.write(b"linked target")
            try:
                os.symlink(real_thumb, os.path.join(root, ".thumbs", "image.png.webp"))
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable in this environment")

            moved = thumbnails.move_gallery_thumbnail_cache(
                root, "", "image.png",
                root, "nested", "image.png",
            )
            removed = thumbnails.remove_gallery_thumbnail_cache(root, "", "image.png")

            self.assertFalse(moved)
            self.assertFalse(removed)
            with open(real_thumb, "rb") as f:
                self.assertEqual(f.read(), b"linked target")


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


class SearchIndexBehaviorTests(unittest.TestCase):
    def _make_index(self, search_index, tmp):
        index = search_index.SearchIndex(
            allowed_roots={"output": lambda: tmp},
            media_exts={".png"},
            ftype=lambda _path: "image",
            format_storage_rel=lambda _root, subfolder, name: (
                f"{subfolder}/{name}" if subfolder else name
            ),
            safe_path=fs_utils.safe_path,
        )
        conn = index._get_conn(reset_outdated=True)
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','1')")
        index._ready = True
        return index, conn

    def _insert_index_file(self, conn, name, *, prompt="", nodes=None, custom=None, mtime=0.0):
        conn.execute(
            """
            INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                              s_prompt_value, s_nodes, s_custom, s_custom_index)
            VALUES(?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "output",
                "",
                name,
                float(mtime),
                10,
                "image",
                prompt,
                json.dumps(nodes or []),
                " ".join(
                    " ".join(str(part) for part in (entry.get("namespace"), entry.get("key"), entry.get("text")) if part)
                    for entry in (custom or [])
                ),
                json.dumps(custom or []),
            ),
        )

    def test_search_paginates_after_python_term_filtering_with_real_rows(self):
        search_index = _load_repo_module("search_index")
        original_get_user_directory = folder_paths.get_user_directory
        with tempfile.TemporaryDirectory() as tmp:
            index = None
            folder_paths.get_user_directory = lambda: tmp
            try:
                index, conn = self._make_index(search_index, tmp)
                for i in range(10):
                    self._insert_index_file(
                        conn,
                        f"image-{i}.png",
                        prompt="keep alpha" if i % 2 == 0 else "skip alpha",
                        mtime=i,
                    )
                conn.commit()

                page1 = index.search("alpha -skip", "output", limit=2, offset=0, scope="prompt_value", sort="name-asc")
                page2 = index.search("alpha -skip", "output", limit=2, offset=2, scope="prompt_value", sort="name-asc")
                page3 = index.search("alpha -skip", "output", limit=2, offset=4, scope="prompt_value", sort="name-asc")

                self.assertEqual([item["name"] for item in page1["files"]], ["image-0.png", "image-2.png"])
                self.assertEqual([item["name"] for item in page2["files"]], ["image-4.png", "image-6.png"])
                self.assertEqual([item["name"] for item in page3["files"]], ["image-8.png"])
                self.assertEqual(page1["total"], 5)
                self.assertEqual(page2["total"], 5)
                self.assertEqual(page3["total"], 5)
            finally:
                if index is not None and index._conn is not None:
                    index._conn.close()
                folder_paths.get_user_directory = original_get_user_directory

    def test_search_post_filtering_handles_exclude_only_phrase_node_and_custom_filters(self):
        search_index = _load_repo_module("search_index")
        original_get_user_directory = folder_paths.get_user_directory
        with tempfile.TemporaryDirectory() as tmp:
            index = None
            folder_paths.get_user_directory = lambda: tmp
            try:
                index, conn = self._make_index(search_index, tmp)
                self._insert_index_file(
                    conn,
                    "alpha.png",
                    prompt="quiet red fox",
                    nodes=[{"type": "KSampler", "title": "Main", "text": "KSampler detailed sampler"}],
                    custom=[{"namespace": "myPlugin", "key": "tags", "text": "black hair portrait"}],
                )
                self._insert_index_file(
                    conn,
                    "beta.png",
                    prompt="quiet blue fox",
                    nodes=[{"type": "CLIPTextEncode", "title": "Prompt", "text": "prompt words"}],
                    custom=[{"namespace": "myPlugin", "key": "tags", "text": "blue hair portrait"}],
                )
                self._insert_index_file(
                    conn,
                    "gamma.png",
                    prompt="quiet red fox banned",
                    nodes=[{"type": "KSampler", "title": "Other", "text": "KSampler plain"}],
                    custom=[{"namespace": "otherPlugin", "key": "tags", "text": "black hair"}],
                )
                conn.commit()

                exclude_only = index.search("-banned", "output", limit=10, scope="prompt_value", sort="name-asc")
                phrase = index.search('"quiet red"', "output", limit=10, scope="prompt_value", sort="name-asc")
                node_filter = index.search('type:KSampler[detailed]', "output", limit=10, scope="prompt_value", sort="name-asc")
                custom_filter = index.search('myPlugin:tags["black hair"]', "output", limit=10, scope="custom", sort="name-asc")

                self.assertEqual([item["name"] for item in exclude_only["files"]], ["alpha.png", "beta.png"])
                self.assertEqual([item["name"] for item in phrase["files"]], ["alpha.png", "gamma.png"])
                self.assertEqual([item["name"] for item in node_filter["files"]], ["alpha.png"])
                self.assertEqual([item["name"] for item in custom_filter["files"]], ["alpha.png"])
            finally:
                if index is not None and index._conn is not None:
                    index._conn.close()
                folder_paths.get_user_directory = original_get_user_directory


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

    def test_unused_custom_paths_api_is_removed(self):
        source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        css = (REPO_ROOT / "web" / "gadgets" / "modelviewer" / "modelviewer.css").read_text(encoding="utf-8")

        self.assertNotIn("/drawer/custom-paths", source)
        self.assertNotIn("custom_model_paths.yaml", source)
        self.assertNotIn("yamlPath", source)
        self.assertNotIn("mv-settings-btn", css)

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

    def test_metadata_display_builds_workflow_overview_from_prompt_only_metadata(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")

        self.assertIn("const promptNodes = prompt", source)
        self.assertIn("const overviewNodes = nodes.length ? nodes : promptNodes", source)
        self.assertIn("for (const node of overviewNodes)", source)
        self.assertIn("promptNodes.length", source)
        self.assertIn("if (workflow || promptNodes.length)", source)

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
        en = json.loads((REPO_ROOT / "web" / "locales" / "en.json").read_text(encoding="utf-8"))

        self.assertIn("const addGenerationOverview = (parent, meta)", source)
        # The A1111 / NovelAI section titles moved from hardcoded strings
        # to locale keys (menu.metaA1111Overview / metaNAIOverview).
        self.assertIn("menu.metaA1111Overview", source)
        self.assertIn("menu.metaNAIOverview", source)
        self.assertEqual(en["menu"]["metaA1111Overview"], "A1111 Overview")
        self.assertEqual(en["menu"]["metaNAIOverview"], "NovelAI Overview")
        self.assertIn("cd-meta-prompt-box", source)
        self.assertIn("cd-meta-setting-grid", css)

    def test_home_storage_widget_uses_cache_and_model_category_breakdown(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        routes = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")

        self.assertIn("STORAGE_WIDGET_CACHE_MS", source)
        self.assertIn("storageWidgetCache", source)
        self.assertIn("renderStorageWidget(container, storageWidgetCache)", source)
        self.assertIn("parts: modelCategories.slice(0, 6).map", source)
        self.assertIn("parts: cat.topDirs?.length ? cat.topDirs : cat.byExt", source)
        self.assertIn("_STORAGE_SUMMARY_TTL = 300.0", routes)
        self.assertIn('"topDirs": sorted(category_summary["topDirs"].values()', routes)

    def test_frontend_version_is_served_without_import_time_file_write(self):
        init_source = (REPO_ROOT / "__init__.py").read_text(encoding="utf-8")
        routes_source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        frontend_source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        version_js = (REPO_ROOT / "web" / "js" / "version.js").read_text(encoding="utf-8")

        self.assertIn("def get_drawer_version(", init_source)
        self.assertNotIn("write_text", init_source)
        self.assertIn('@_routes.get("/drawer/version")', routes_source)
        self.assertIn("async function loadDrawerVersion", frontend_source)
        self.assertIn("await loadDrawerVersion(DRAWER_VERSION)", frontend_source)
        self.assertIn(r'^version\s*=\s*"', init_source)
        version = pyproject.split('version = "', 1)[1].split('"', 1)[0]
        self.assertIn(f"DRAWER_VERSION = '{version}'", version_js)

    def test_model_info_does_not_return_absolute_full_path(self):
        routes_source = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        frontend_source = (REPO_ROOT / "web" / "gadgets" / "modelviewer" / "modelviewer-gadget.js").read_text(encoding="utf-8")

        self.assertNotIn('"fullPath"', routes_source)
        self.assertIn('"path": filename.replace', routes_source)
        self.assertNotIn('"label": f"Source', routes_source)
        self.assertNotIn("#pathGroups", frontend_source)
        self.assertNotIn("#openPathFilter", frontend_source)
        self.assertNotIn("normalizePath(info.path || modelPath)", frontend_source)

    def test_context_menu_can_resync_file_metadata_from_disk(self):
        source = (REPO_ROOT / "web" / "js" / "comfy-drawer.js").read_text(encoding="utf-8")
        routes = (REPO_ROOT / "drawer_routes.py").read_text(encoding="utf-8")
        index = (REPO_ROOT / "search_index.py").read_text(encoding="utf-8")
        toast_module = (REPO_ROOT / "web" / "js" / "services" / "toast.js").read_text(encoding="utf-8")

        self.assertIn("async function syncMediaMetadataIndex(ctx)", source)
        self.assertIn("id: 'media:sync-metadata'", source)
        self.assertIn("replace: true", source)
        self.assertIn("showToast(t('menu.syncMetadataDone'", source)
        self.assertIn("ctx.hasMetadata !== false && (ctx.root || ctx.source) !== 'temp'", source)
        self.assertIn("checkMetadataAvailable", source)
        # showToast moved to its own module — the cd-toast class lives there
        # now instead of being injected inline by comfy-drawer.js.
        self.assertIn("cd-toast", toast_module)
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
