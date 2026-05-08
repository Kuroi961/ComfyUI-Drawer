"""SQLite search index for ComfyUI-Drawer Gallery."""

import asyncio
import json
import logging
import os
import random
import sqlite3
import threading
import time

import folder_paths

from .media_metadata import read_media_meta as _read_media_meta
from .media_metadata import read_media_meta_with_source as _read_media_meta_with_source
from .metadata_ext import metadata_pipeline_signature as _metadata_pipeline_signature
from .metadata_ext import has_index_contributors as _has_index_contributors
from .search_query import (
    build_fts_query as _build_fts_query,
    custom_filters_match as _custom_filters_match,
    extract_searchable_parts as _extract_searchable_parts,
    node_filters_match as _node_filters_match,
    parse_custom_search_clauses as _parse_custom_search_clauses,
    parse_node_search_clauses as _parse_node_search_clauses,
    parse_search_scopes as _parse_search_scopes,
    parse_search_terms as _parse_search_terms,
    search_scope_group_matches as _search_scope_group_matches,
    search_terms_empty as _search_terms_empty,
)
from .settings import (
    get_drawer_setting as _get_drawer_setting,
    set_drawer_setting as _set_drawer_setting,
)

logger = logging.getLogger("ComfyUI-Drawer")


def _as_str(value, default=""):
    if value is None:
        return default
    return str(value)


class SearchIndex:
    """SQLite FTS5-backed search index for media files.

    - Stores filename + extracted metadata text in a FTS5 table.
    - Builds only when the user explicitly starts or resumes indexing.
    - Preserves existing metadata unless a fresh rebuild or explicit replace
      request rewrites it.
    """

    _SCHEMA_VERSION = 13  # v13: third-party custom namespace/key search fields
    _MIN_COMPATIBLE_SCHEMA_VERSION = 13
    _EXPECTED_FILE_COLUMNS = {
        "root", "subfolder", "name", "mtime", "size", "ftype",
        "s_prompt_title", "s_prompt_value",
        "s_workflow_title", "s_workflow_value",
        "s_custom", "s_custom_index",
        "s_nodes", "s_meta_source",
    }
    _EXPECTED_FTS_COLUMNS = [
        "name", "s_prompt_title", "s_prompt_value",
        "s_workflow_title", "s_workflow_value",
        "s_custom", "s_nodes",
    ]
    _FALLBACK_ESTIMATE_RATE = 25.0  # files/sec; intentionally conservative
    _ESTIMATE_SAMPLE_LIMIT = 100
    _ETA_WARMUP_SECONDS = 15
    _ETA_WARMUP_FILES = 200
    _AUTO_SYNC_DELAY_SECONDS = 45
    _AUTO_SYNC_INTERVAL_SECONDS = 300
    _AUTO_SYNC_SETTING_KEY = "searchIndex.autoSyncEnabled"
    _ESTIMATE_CACHE_SECONDS = 300

    def __init__(self, *, allowed_roots, media_exts, ftype, format_storage_rel, safe_path):
        self._allowed_roots = allowed_roots
        self._media_exts = media_exts
        self._ftype = ftype
        self._format_storage_rel = format_storage_rel
        self._safe_path = safe_path
        self._db_path = os.path.join(folder_paths.get_user_directory(), "drawer_index.db")
        self._lock = threading.Lock()
        self._ready = self._probe_ready_state()
        self._building = False
        self._syncing = False
        self._progress = ""
        self._indexed_count = 0
        self._total_count = 0
        self._total_expected = 0
        self._cleared = False
        self._conn = None
        self._generation = 0
        self._paused = False
        self._started_at = 0.0
        self._last_rate_sample_at = 0.0
        self._last_rate_sample_count = 0
        self._ema_rate = 0.0
        self._sync_timer = None
        self._last_sync_at = 0.0
        self._sync_progress = ""
        self._sync_generation = 0
        self._auto_sync_enabled = bool(_get_drawer_setting(self._AUTO_SYNC_SETTING_KEY, False))
        self._estimate_cache_total = None
        self._estimate_cache_signature = None
        self._estimate_cache_at = 0.0
        if self._ready and self._auto_sync_enabled:
            self.schedule_auto_sync()

    def _probe_ready_state(self):
        """Read existing DB metadata without creating or migrating the index."""
        if not os.path.isfile(self._db_path):
            return False
        try:
            conn = sqlite3.connect(self._db_path, timeout=2.0)
            try:
                row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                complete = conn.execute("SELECT value FROM meta WHERE key='index_complete'").fetchone()
                indexed = conn.execute("SELECT COUNT(*) FROM files").fetchone()
                try:
                    schema_version = int(row[0]) if row else 0
                except (TypeError, ValueError):
                    schema_version = 0
                schema_ok = (
                    schema_version >= self._SCHEMA_VERSION
                    or (
                        schema_version >= self._MIN_COMPATIBLE_SCHEMA_VERSION
                        and self._has_search_schema_shape(conn)
                    )
                )
            finally:
                conn.close()
            has_rows = bool(indexed and indexed[0] > 0)
            return bool(
                schema_ok
                and ((complete and complete[0] == "1") or (complete is None and has_rows))
            )
        except Exception:
            return False

    def _has_search_schema_shape(self, conn):
        """Return True when an older DB already has the current search columns."""
        try:
            file_cols = {row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()}
            fts_cols = [row[1] for row in conn.execute("PRAGMA table_info(files_fts)").fetchall()]
        except sqlite3.OperationalError:
            return False
        return (
            self._EXPECTED_FILE_COLUMNS.issubset(file_cols)
            and fts_cols[:len(self._EXPECTED_FTS_COLUMNS)] == self._EXPECTED_FTS_COLUMNS
        )

    def _get_meta_value(self, conn, key, default=None):
        try:
            row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return row[0] if row else default
        except sqlite3.OperationalError:
            return default

    def _set_meta_value(self, conn, key, value):
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))

    def _metadata_signature_changed(self, conn):
        current = _metadata_pipeline_signature()
        stored = self._get_meta_value(conn, "metadata_pipeline_signature", "")
        return stored != current

    def _store_metadata_signature(self, conn):
        self._set_meta_value(conn, "metadata_pipeline_signature", _metadata_pipeline_signature())

    def _get_conn(self, *, reset_outdated=False):
        """Get or create a thread-safe connection."""
        if self._conn is None:
            had_db = os.path.isfile(self._db_path)
            os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
            self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=30.0)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._init_schema(reset_outdated=reset_outdated or not had_db)
        return self._conn

    def _init_schema(self, *, reset_outdated=False):
        c = self._conn
        c.execute("""
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        row = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        try:
            current_schema = int(row[0]) if row else 0
        except (TypeError, ValueError):
            current_schema = 0
        schema_reset = False
        if current_schema < self._SCHEMA_VERSION:
            if (
                current_schema >= self._MIN_COMPATIBLE_SCHEMA_VERSION
                and self._has_search_schema_shape(c)
            ):
                c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)",
                          (str(self._SCHEMA_VERSION),))
                c.commit()
                current_schema = self._SCHEMA_VERSION
            else:
                if not reset_outdated:
                    self._ready = False
                    self._cleared = False
                    self._progress = "Index schema is outdated"
                    return False
                schema_reset = True
                c.executescript("""
                    DROP TRIGGER IF EXISTS files_ai;
                    DROP TRIGGER IF EXISTS files_ad;
                    DROP TRIGGER IF EXISTS files_au;
                    DROP TABLE IF EXISTS files_fts;
                    DROP TABLE IF EXISTS files;
                """)
                c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)",
                          (str(self._SCHEMA_VERSION),))
                c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','0')")
                c.commit()
        if schema_reset:
            current_schema = self._SCHEMA_VERSION
        if current_schema < self._SCHEMA_VERSION:
            if not reset_outdated:
                self._ready = False
                self._cleared = False
                self._progress = "Index schema is outdated"
                return False

        c.execute("""
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                root TEXT NOT NULL,
                subfolder TEXT NOT NULL,
                name TEXT NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                ftype TEXT NOT NULL,
                s_prompt_title TEXT NOT NULL DEFAULT '',
                s_prompt_value TEXT NOT NULL DEFAULT '',
                s_workflow_title TEXT NOT NULL DEFAULT '',
                s_workflow_value TEXT NOT NULL DEFAULT '',
                s_custom TEXT NOT NULL DEFAULT '',
                s_custom_index TEXT NOT NULL DEFAULT '[]',
                s_nodes TEXT NOT NULL DEFAULT '[]',
                s_meta_source TEXT NOT NULL DEFAULT ''
            )
        """)
        file_cols = {row[1] for row in c.execute("PRAGMA table_info(files)").fetchall()}
        if "s_meta_source" not in file_cols:
            c.execute("ALTER TABLE files ADD COLUMN s_meta_source TEXT NOT NULL DEFAULT ''")
            c.commit()
        c.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path
            ON files(root, subfolder, name)
        """)
        # FTS5 virtual table — filename + metadata scopes
        fts_cols = []
        try:
            fts_cols = [row[1] for row in c.execute("PRAGMA table_info(files_fts)").fetchall()]
        except sqlite3.OperationalError:
            fts_cols = []
        fts_needs_rebuild = not fts_cols
        expected_fts_cols = [
            "name", "s_prompt_title", "s_prompt_value",
            "s_workflow_title", "s_workflow_value",
            "s_custom", "s_nodes",
        ]
        if fts_cols and fts_cols[:len(expected_fts_cols)] != expected_fts_cols:
            fts_needs_rebuild = True
            c.executescript("""
                DROP TRIGGER IF EXISTS files_ai;
                DROP TRIGGER IF EXISTS files_ad;
                DROP TRIGGER IF EXISTS files_au;
                DROP TABLE IF EXISTS files_fts;
            """)
            c.commit()
        c.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                name, s_prompt_title, s_prompt_value,
                s_workflow_title, s_workflow_value,
                s_custom, s_nodes,
                content='files', content_rowid='id'
            )
        """)
        # Triggers to keep FTS in sync
        c.executescript("""
            DROP TRIGGER IF EXISTS files_ai;
            DROP TRIGGER IF EXISTS files_ad;
            DROP TRIGGER IF EXISTS files_au;
            CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
                INSERT INTO files_fts(rowid, name, s_prompt_title, s_prompt_value,
                                      s_workflow_title, s_workflow_value,
                                      s_custom, s_nodes)
                VALUES (new.id, new.name, new.s_prompt_title, new.s_prompt_value,
                        new.s_workflow_title, new.s_workflow_value,
                        new.s_custom, new.s_nodes);
            END;
            CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, s_prompt_title, s_prompt_value,
                                      s_workflow_title, s_workflow_value,
                                      s_custom, s_nodes)
                VALUES ('delete', old.id, old.name, old.s_prompt_title, old.s_prompt_value,
                        old.s_workflow_title, old.s_workflow_value,
                        old.s_custom, old.s_nodes);
            END;
            CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, s_prompt_title, s_prompt_value,
                                      s_workflow_title, s_workflow_value,
                                      s_custom, s_nodes)
                VALUES ('delete', old.id, old.name, old.s_prompt_title, old.s_prompt_value,
                        old.s_workflow_title, old.s_workflow_value,
                        old.s_custom, old.s_nodes);
                INSERT INTO files_fts(rowid, name, s_prompt_title, s_prompt_value,
                                      s_workflow_title, s_workflow_value,
                                      s_custom, s_nodes)
                VALUES (new.id, new.name, new.s_prompt_title, new.s_prompt_value,
                        new.s_workflow_title, new.s_workflow_value,
                        new.s_custom, new.s_nodes);
            END;
        """)
        if fts_needs_rebuild:
            c.execute("INSERT INTO files_fts(files_fts) VALUES('rebuild')")
            c.commit()
        if schema_reset:
            self._ready = False
            self._cleared = False
        else:
            ready_row = c.execute("SELECT value FROM meta WHERE key='index_complete'").fetchone()
            if ready_row is None:
                count_row = c.execute("SELECT COUNT(*) FROM files").fetchone()
                self._ready = bool(count_row and count_row[0] > 0)
                if self._ready:
                    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','1')")
                    c.commit()
            else:
                self._ready = ready_row[0] == "1"
        return True

    def start_background_build(self, *, reset=True):
        """Start indexing in a background thread."""
        with self._lock:
            if self._building:
                return
            self._generation += 1
            generation = self._generation
            self._ready = False
            self._building = True
            self._progress = "Starting index build..."
            self._indexed_count = 0
            self._total_count = 0
            self._total_expected = 0
            self._cleared = False
            self._paused = False
            self._started_at = time.time()
            self._last_rate_sample_at = self._started_at
            self._last_rate_sample_count = 0
            self._ema_rate = 0.0
            if reset:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:
                        pass
                    self._conn = None
                for suffix in ("", "-wal", "-shm"):
                    p = self._db_path + suffix
                    if os.path.isfile(p):
                        try:
                            os.unlink(p)
                        except OSError:
                            pass
            self._cancel_auto_sync_locked()
            self._sync_generation += 1
            self._syncing = False
        t = threading.Thread(target=self._build_all, args=(generation, reset), daemon=True)
        t.start()

    def _is_generation_current(self, generation):
        return generation == self._generation

    def _cancel_auto_sync_locked(self):
        if self._sync_timer is not None:
            try:
                self._sync_timer.cancel()
            except Exception:
                pass
            self._sync_timer = None

    def schedule_auto_sync(self, delay=None):
        """Schedule a low-priority file reconciliation pass."""
        with self._lock:
            if not self._auto_sync_enabled:
                return False
            if not self._ready or self._building or self._syncing or self._paused:
                return False
            if self._sync_timer is not None:
                return True
            wait = self._AUTO_SYNC_DELAY_SECONDS if delay is None else max(0, float(delay))
            self._sync_timer = threading.Timer(wait, self.start_background_sync)
            self._sync_timer.daemon = True
            self._sync_timer.start()
            return True

    def start_background_sync(self):
        """Start a background reconciliation pass without rebuilding metadata."""
        with self._lock:
            self._sync_timer = None
            if not self._ready or self._building or self._syncing or self._paused:
                return False
            conn = self._get_conn(reset_outdated=False)
            if self._metadata_signature_changed(conn):
                refresh_needed = True
            else:
                refresh_needed = False
            self._syncing = True
            self._sync_generation += 1
            generation = self._sync_generation
            self._sync_progress = (
                "Metadata providers changed; refreshing indexed metadata..."
                if refresh_needed else
                "Checking file changes..."
            )
        target = self._refresh_metadata_all if refresh_needed else self._sync_all
        t = threading.Thread(target=target, args=(generation,), daemon=True)
        t.start()
        return True

    def start_background_metadata_refresh(self):
        """Re-read metadata for existing files and re-apply contributors."""
        with self._lock:
            self._sync_timer = None
            if not self._ready or self._building or self._syncing or self._paused:
                return False
            self._syncing = True
            self._sync_generation += 1
            generation = self._sync_generation
            self._sync_progress = "Refreshing indexed metadata..."
        t = threading.Thread(target=self._refresh_metadata_all, args=(generation,), daemon=True)
        t.start()
        return True

    def set_auto_sync_enabled(self, enabled):
        enabled = bool(enabled)
        with self._lock:
            self._auto_sync_enabled = enabled
            _set_drawer_setting(self._AUTO_SYNC_SETTING_KEY, enabled)
            if not enabled:
                self._cancel_auto_sync_locked()
            should_schedule = enabled and self._ready and not self._building and not self._syncing and not self._paused
        if should_schedule:
            self.schedule_auto_sync()
        return enabled

    def _is_sync_current(self, generation):
        return generation == self._sync_generation

    def _roots_signature(self, roots):
        return tuple((root_name, os.path.realpath(root_path)) for root_name, root_path in roots)

    def _remember_estimate_total(self, total, roots_signature):
        with self._lock:
            self._estimate_cache_total = int(total)
            self._estimate_cache_signature = roots_signature
            self._estimate_cache_at = time.time()

    def _recent_estimate_total(self, roots_signature):
        with self._lock:
            if self._estimate_cache_signature != roots_signature:
                return None
            if not self._estimate_cache_at:
                return None
            if time.time() - self._estimate_cache_at > self._ESTIMATE_CACHE_SECONDS:
                return None
            return self._estimate_cache_total

    def _build_all(self, generation, reset=True):
        """Scan all allowed roots and index media files."""
        with self._lock:
            if not self._is_generation_current(generation):
                return
        try:
            with self._lock:
                if not self._is_generation_current(generation):
                    return
                conn = self._get_conn(reset_outdated=reset)
                if reset:
                    conn.executescript("""
                        DROP TRIGGER IF EXISTS files_ai;
                        DROP TRIGGER IF EXISTS files_ad;
                        DROP TRIGGER IF EXISTS files_au;
                        DROP TABLE IF EXISTS files_fts;
                        DROP TABLE IF EXISTS files;
                    """)
                    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)",
                                 (str(self._SCHEMA_VERSION),))
                    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','0')")
                    conn.commit()
                    self._init_schema()
                conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','0')")
                conn.commit()

            roots = []
            for root_name, getter in self._allowed_roots.items():
                try:
                    root_path = getter()
                except Exception:
                    continue
                if not os.path.isdir(root_path):
                    continue
                roots.append((root_name, root_path))

            roots_signature = self._roots_signature(roots)
            cached_total = self._recent_estimate_total(roots_signature)
            if cached_total is None:
                self._progress = "Counting index targets..."
                self._total_expected = sum(self._count_media_files(root_path) for _root_name, root_path in roots)
            else:
                self._progress = "Starting index build..."
                self._total_expected = cached_total

            for root_name, root_path in roots:
                if not self._is_generation_current(generation):
                    return
                self._index_root(conn, root_name, root_path, generation)

            if self._is_generation_current(generation):
                self._purge_stale(conn)

            with self._lock:
                if self._is_generation_current(generation):
                    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','1')")
                    self._store_metadata_signature(conn)
                    conn.commit()
                    self._progress = "Index ready"
                    self._ready = True
        except Exception as e:
            with self._lock:
                if self._is_generation_current(generation):
                    self._progress = f"Index error: {e}"
            logger.error(f"Search index build failed: {e}")
        finally:
            with self._lock:
                if self._is_generation_current(generation):
                    self._building = False

        # After a user-built snapshot is ready, keep only file identity/location
        # in sync. This is not a metadata rebuild; existing search fields are
        # preserved unless a row is new or empty.
        if self._ready and self._auto_sync_enabled:
            self.schedule_auto_sync(delay=self._AUTO_SYNC_INTERVAL_SECONDS)

    def _sync_all(self, generation):
        """Reconcile the ready index with the filesystem.

        This is intentionally not a rebuild: existing metadata is preserved,
        moves/renames update location fields, and only new/empty rows read
        provider or embedded metadata.
        """
        try:
            with self._lock:
                if not self._is_sync_current(generation) or not self._ready:
                    return
                conn = self._get_conn(reset_outdated=False)

            roots = []
            for root_name, getter in self._allowed_roots.items():
                try:
                    root_path = getter()
                except Exception:
                    continue
                if os.path.isdir(root_path):
                    roots.append((root_name, root_path))

            for root_name, root_path in roots:
                if not self._is_sync_current(generation):
                    return
                self._sync_progress = f"Checking {root_name}..."
                self._index_root(conn, root_name, root_path, generation, sync=True)

            if self._is_sync_current(generation):
                self._purge_stale(conn)
                with self._lock:
                    self._last_sync_at = time.time()
                    self._sync_progress = "File changes checked"
        except Exception as e:
            with self._lock:
                if self._is_sync_current(generation):
                    self._sync_progress = f"Sync error: {e}"
            logger.error(f"Search index sync failed: {e}")
        finally:
            with self._lock:
                if self._is_sync_current(generation):
                    self._syncing = False
            if self._auto_sync_enabled:
                self.schedule_auto_sync(delay=self._AUTO_SYNC_INTERVAL_SECONDS)

    def _refresh_metadata_all(self, generation):
        """Refresh searchable metadata for existing index rows.

        This is for maintenance after provider/contributor changes. It keeps
        the DB schema and row identities, but rereads raw metadata and replaces
        searchable fields for files that still exist.
        """
        try:
            with self._lock:
                if not self._is_sync_current(generation) or not self._ready:
                    return
                conn = self._get_conn(reset_outdated=False)

            roots = []
            for root_name, getter in self._allowed_roots.items():
                try:
                    root_path = getter()
                except Exception:
                    continue
                if os.path.isdir(root_path):
                    roots.append((root_name, root_path))

            for root_name, root_path in roots:
                if not self._is_sync_current(generation):
                    return
                self._sync_progress = f"Refreshing metadata: {root_name}..."
                self._index_root(conn, root_name, root_path, generation, sync=True, refresh_metadata=True)

            if self._is_sync_current(generation):
                self._purge_stale(conn)
                with self._lock:
                    self._store_metadata_signature(conn)
                    conn.commit()
                    self._last_sync_at = time.time()
                    self._sync_progress = "Indexed metadata refreshed"
        except Exception as e:
            with self._lock:
                if self._is_sync_current(generation):
                    self._sync_progress = f"Metadata refresh error: {e}"
            logger.error(f"Search index metadata refresh failed: {e}")
        finally:
            with self._lock:
                if self._is_sync_current(generation):
                    self._syncing = False
            if self._auto_sync_enabled:
                self.schedule_auto_sync(delay=self._AUTO_SYNC_INTERVAL_SECONDS)

    def _count_media_files(self, root_path):
        """Count searchable media files for index progress reporting."""
        count = 0
        for _dirpath, dirnames, filenames in os.walk(root_path):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            count += sum(
                1 for fname in filenames
                if os.path.splitext(fname)[1].lower() in self._media_exts
        )
        return count

    def _search_values_have_metadata(self, values):
        return any((value or "") and value != "[]" for value in values)

    def _file_fingerprint(self, mtime, size, ftype):
        """Small move/rename fingerprint; avoids rereading stable metadata."""
        return (int(size), round(float(mtime), 2), ftype)

    def _update_file_location(self, conn, row_id, subfolder, name, st, ftype):
        """Update only location/stat fields, preserving searchable metadata."""
        with self._lock:
            conn.execute("""
                UPDATE files
                SET subfolder=?, name=?, mtime=?, size=?, ftype=?
                WHERE id=?
            """, (subfolder, name, st.st_mtime, st.st_size, ftype, row_id))

    def note_path_moved(self, src_root, src_subfolder, src_name, dest_root, dest_subfolder, dest_name, *, is_dir=False, dest_path=None):
        """Reflect a Drawer-managed move/rename in the index without reading metadata.

        External filesystem changes are reconciled by manual/automatic sync. When
        Drawer itself moves a path, the old and new locations are already known,
        so updating the snapshot directly keeps search results fresh and preserves
        third-party metadata.
        """
        if not self._ready:
            return 0
        src_root = str(src_root or "").strip().lower()
        dest_root = str(dest_root or src_root).strip().lower()
        src_subfolder = self._format_storage_rel(src_subfolder or "")
        dest_subfolder = self._format_storage_rel(dest_subfolder or "")
        src_name = str(src_name or "").strip()
        dest_name = str(dest_name or src_name).strip()
        if not src_root or not dest_root or not src_name or not dest_name:
            return 0
        with self._lock:
            conn = self._get_conn(reset_outdated=False)
            if is_dir:
                src_prefix = self._format_storage_rel("/".join(p for p in (src_subfolder, src_name) if p))
                dest_prefix = self._format_storage_rel("/".join(p for p in (dest_subfolder, dest_name) if p))
                rows = conn.execute(
                    """SELECT id, subfolder, name FROM files
                       WHERE root=? AND (subfolder=? OR subfolder LIKE ?)""",
                    (src_root, src_prefix, f"{src_prefix}/%"),
                ).fetchall()
                updated = 0
                for row_id, old_subfolder, row_name in rows:
                    suffix = old_subfolder[len(src_prefix):].lstrip("/")
                    new_subfolder = self._format_storage_rel("/".join(p for p in (dest_prefix, suffix) if p))
                    conn.execute(
                        "DELETE FROM files WHERE root=? AND subfolder=? AND name=? AND id<>?",
                        (dest_root, new_subfolder, row_name, row_id),
                    )
                    conn.execute(
                        "UPDATE files SET root=?, subfolder=? WHERE id=?",
                        (dest_root, new_subfolder, row_id),
                    )
                    updated += 1
                conn.commit()
                return updated

            row = conn.execute(
                "SELECT id FROM files WHERE root=? AND subfolder=? AND name=?",
                (src_root, src_subfolder, src_name),
            ).fetchone()
            if not row:
                return 0
            row_id = row[0]
            conn.execute(
                "DELETE FROM files WHERE root=? AND subfolder=? AND name=? AND id<>?",
                (dest_root, dest_subfolder, dest_name, row_id),
            )
            if dest_path:
                try:
                    st = os.stat(dest_path)
                    ftype = self._ftype(os.path.splitext(dest_name)[1].lower())
                    conn.execute(
                        """UPDATE files
                           SET root=?, subfolder=?, name=?, mtime=?, size=?, ftype=?
                           WHERE id=?""",
                        (dest_root, dest_subfolder, dest_name, st.st_mtime, st.st_size, ftype, row_id),
                    )
                except OSError:
                    conn.execute(
                        "UPDATE files SET root=?, subfolder=?, name=? WHERE id=?",
                        (dest_root, dest_subfolder, dest_name, row_id),
                    )
            else:
                conn.execute(
                    "UPDATE files SET root=?, subfolder=?, name=? WHERE id=?",
                    (dest_root, dest_subfolder, dest_name, row_id),
                )
            conn.commit()
            return 1

    def note_path_deleted(self, root_name, subfolder, name, *, is_dir=False):
        """Remove Drawer-deleted files/folders from the index immediately."""
        if not self._ready:
            return 0
        root_name = str(root_name or "").strip().lower()
        subfolder = self._format_storage_rel(subfolder or "")
        name = str(name or "").strip()
        if not root_name or not name:
            return 0
        with self._lock:
            conn = self._get_conn(reset_outdated=False)
            if is_dir:
                prefix = self._format_storage_rel("/".join(p for p in (subfolder, name) if p))
                cur = conn.execute(
                    """DELETE FROM files
                       WHERE root=? AND (subfolder=? OR subfolder LIKE ?)""",
                    (root_name, prefix, f"{prefix}/%"),
                )
            else:
                cur = conn.execute(
                    "DELETE FROM files WHERE root=? AND subfolder=? AND name=?",
                    (root_name, subfolder, name),
                )
            conn.commit()
            return int(cur.rowcount or 0)

    def _take_relocated_row(self, existing, by_fingerprint, claimed_ids, fingerprint):
        """Find a stale row that likely represents this moved/renamed file."""
        candidates = by_fingerprint.get(fingerprint) or []
        while candidates:
            candidate = candidates.pop(0)
            row_id = candidate["id"]
            key = (candidate["subfolder"], candidate["name"])
            if row_id in claimed_ids or key not in existing:
                continue
            if not self._search_values_have_metadata(candidate["search"]):
                continue
            existing.pop(key, None)
            claimed_ids.add(row_id)
            return candidate
        return None

    def _index_root(self, conn, root_name, root_path, generation, *, sync=False, refresh_metadata=False):
        """Walk a root directory and index/update media files."""
        is_current = self._is_sync_current if sync else self._is_generation_current
        existing = {}
        by_fingerprint = {}
        for row in conn.execute(
            """SELECT id, subfolder, name, mtime, size, ftype,
                      s_prompt_title, s_prompt_value,
                      s_workflow_title, s_workflow_value,
                      s_custom, s_custom_index, s_nodes, s_meta_source
               FROM files WHERE root=?""", (root_name,)
        ):
            item = {
                "id": row[0],
                "subfolder": row[1],
                "name": row[2],
                "mtime": row[3],
                "size": row[4],
                "ftype": row[5],
                "search": row[6:13],
                "meta_source": row[13],
            }
            existing[(item["subfolder"], item["name"])] = item
            by_fingerprint.setdefault(
                self._file_fingerprint(item["mtime"], item["size"], item["ftype"]), []
            ).append(item)

        count = 0
        claimed_ids = set()
        for dirpath, dirnames, filenames in os.walk(root_path):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            rel = os.path.relpath(dirpath, root_path).replace("\\", "/")
            if rel == ".":
                rel = ""
            media_files = [
                f for f in filenames
                if os.path.splitext(f)[1].lower() in self._media_exts
            ]
            for fname in media_files:
                if not is_current(generation):
                    conn.commit()
                    return
                full = os.path.join(dirpath, fname)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                key = (rel, fname)
                old_row = existing.pop(key, None)
                ext = os.path.splitext(fname)[1].lower()
                ftype = self._ftype(ext)
                if old_row:
                    claimed_ids.add(old_row["id"])
                    if self._search_values_have_metadata(old_row["search"]) and not refresh_metadata:
                        if (
                            abs(st.st_mtime - old_row["mtime"]) >= 0.01
                            or st.st_size != old_row["size"]
                            or ftype != old_row["ftype"]
                        ):
                            self._update_file_location(conn, old_row["id"], rel, fname, st, ftype)
                        count += 1
                        if not sync:
                            self._record_indexed()
                        continue

                moved_row = self._take_relocated_row(
                    existing,
                    by_fingerprint,
                    claimed_ids,
                    self._file_fingerprint(st.st_mtime, st.st_size, ftype),
                )
                if moved_row:
                    self._update_file_location(conn, moved_row["id"], rel, fname, st, ftype)
                    count += 1
                    if not sync:
                        self._record_indexed()
                    if count % 500 == 0:
                        conn.commit()
                        if sync:
                            self._sync_progress = f"Checking {root_name}: {count} files..."
                        else:
                            self._progress = f"Indexing {root_name}: {count} files..."
                    continue

                # Extract searchable parts from providers first, then embedded metadata.
                s_prompt_title = s_prompt_value = s_workflow_title = s_workflow_value = ""
                s_custom = ""
                s_custom_index = "[]"
                s_nodes = "[]"
                meta, meta_source = _read_media_meta_with_source(
                    full,
                    root_name=root_name,
                    root_path=root_path,
                    subfolder=rel,
                    name=fname,
                )
                if meta:
                    parts = _extract_searchable_parts(meta, {
                        "path": full,
                        "root_name": root_name,
                        "root_path": root_path,
                        "subfolder": rel,
                        "name": fname,
                        "filename": fname,
                    })
                    s_prompt_title = parts["prompt_title"]
                    s_prompt_value = parts["prompt_value"]
                    s_workflow_title = parts["workflow_title"]
                    s_workflow_value = parts["workflow_value"]
                    s_custom = parts["custom"]
                    s_custom_index = json.dumps(parts["custom_index"], ensure_ascii=False)
                    s_nodes = json.dumps(parts["nodes"], ensure_ascii=False)
                with self._lock:
                    conn.execute("""
                        INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                                         s_prompt_title, s_prompt_value,
                                         s_workflow_title, s_workflow_value,
                                         s_custom, s_custom_index, s_nodes, s_meta_source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(root, subfolder, name) DO UPDATE SET
                            mtime=excluded.mtime, size=excluded.size,
                            ftype=excluded.ftype,
                            s_prompt_title=excluded.s_prompt_title,
                            s_prompt_value=excluded.s_prompt_value,
                            s_workflow_title=excluded.s_workflow_title,
                            s_workflow_value=excluded.s_workflow_value,
                            s_custom=excluded.s_custom,
                            s_custom_index=excluded.s_custom_index,
                            s_nodes=excluded.s_nodes,
                            s_meta_source=excluded.s_meta_source
                    """, (root_name, rel, fname, st.st_mtime, st.st_size, ftype,
                          s_prompt_title, s_prompt_value, s_workflow_title,
                          s_workflow_value, s_custom, s_custom_index,
                          s_nodes, meta_source))
                count += 1
                if not sync:
                    self._record_indexed()
                if count % 500 == 0:
                    conn.commit()
                    if sync:
                        self._sync_progress = f"Checking {root_name}: {count} files..."
                    else:
                        self._progress = f"Indexing {root_name}: {count} files..."
        conn.commit()
        if sync:
            self._sync_progress = f"Checked {root_name}: {count} files"
        else:
            self._progress = f"Indexed {root_name}: {count} files"
            self._total_count += count

    def _record_indexed(self, delta=1):
        """Track progress and a smoothed indexing rate for ETA reporting."""
        now = time.time()
        with self._lock:
            self._indexed_count += delta
            elapsed = now - self._last_rate_sample_at
            if elapsed < 1.0:
                return
            processed = self._indexed_count - self._last_rate_sample_count
            instant_rate = processed / elapsed if elapsed > 0 else 0.0
            if instant_rate > 0:
                self._ema_rate = instant_rate if self._ema_rate <= 0 else (self._ema_rate * 0.75 + instant_rate * 0.25)
            self._last_rate_sample_at = now
            self._last_rate_sample_count = self._indexed_count

    def _purge_stale(self, conn):
        """Remove index entries for files that no longer exist on disk."""
        stale_ids = []
        for row in conn.execute("SELECT id, root, subfolder, name FROM files"):
            fid, root_name, subfolder, name = row
            getter = self._allowed_roots.get(root_name)
            if getter is None:
                stale_ids.append(fid)
                continue
            try:
                root_path = getter()
            except Exception:
                continue
            full = self._safe_path(root_path, subfolder, name) if subfolder else self._safe_path(root_path, name)
            if full is None or not os.path.isfile(full):
                stale_ids.append(fid)
        if stale_ids:
            with self._lock:
                for fid in stale_ids:
                    conn.execute("DELETE FROM files WHERE id=?", (fid,))
                conn.commit()
            logger.info(f"Purged {len(stale_ids)} stale index entries")

    def search(self, query, root_name, subpath="", limit=200, offset=0, scope="", sort="date-desc"):
        """Search the index. Returns {"files": [...], "total": n}, or None if index not ready.
        scope: comma-separated list of name/prompt/workflow title/value scopes.
        """
        if not self._ready:
            return None  # signal caller to fall back

        scopes = _parse_search_scopes(scope)

        # Map scope to column names
        _SCOPE_MAP = {
            "name": ("name", "f.name"),
            "prompt_title": ("s_prompt_title", "f.s_prompt_title"),
            "prompt_value": ("s_prompt_value", "f.s_prompt_value"),
            "workflow_title": ("s_workflow_title", "f.s_workflow_title"),
            "workflow_value": ("s_workflow_value", "f.s_workflow_value"),
            "custom": ("s_custom", "f.s_custom"),
        }
        _FTS_SCOPE_MAP = {
            "name": "name",
            "prompt_title": "s_prompt_title",
            "prompt_value": "s_prompt_value",
            "workflow_title": "s_workflow_title",
            "workflow_value": "s_workflow_value",
            "custom": "s_custom",
        }

        with self._lock:
            conn = self._get_conn()
            if not self._ready:
                return None

            base_query, node_filters = _parse_node_search_clauses(query)
            base_query, custom_filters = _parse_custom_search_clauses(base_query)
            terms = _parse_search_terms(base_query)
            if _search_terms_empty(terms) and not node_filters and not custom_filters:
                return {"files": [], "total": 0}
            exclude_patterns = [f"%{term}%" for term in terms["exclude"]]
            filename_digit_terms = [
                term for term in terms.get("include", [])
                if "name" in scopes and str(term).isdigit()
            ]
            fts_terms = dict(terms)
            if filename_digit_terms:
                fts_terms["include"] = [
                    term for term in terms.get("include", [])
                    if term not in filename_digit_terms
                ]
            sql_cols = [_SCOPE_MAP[scope][1] for scope in scopes if scope in _SCOPE_MAP]
            fts_query = _build_fts_query(fts_terms, scopes, _FTS_SCOPE_MAP)
            include_conditions = ["files_fts MATCH ?"] if fts_query else []
            include_conditions.extend("LOWER(f.name) LIKE ?" for _term in filename_digit_terms)
            exclude_conditions = [
                "(" + " AND ".join(f"LOWER({col}) NOT LIKE ?" for col in sql_cols) + ")"
                for _term in exclude_patterns
            ]
            conditions = " AND ".join(include_conditions + exclude_conditions) or "1=1"
            sql = """
                SELECT f.name, f.subfolder, f.size, f.mtime, f.ftype,
                       f.s_prompt_title, f.s_prompt_value,
                       f.s_workflow_title, f.s_workflow_value,
                       f.s_custom, f.s_custom_index, f.s_nodes
                FROM files AS f
                JOIN files_fts ON files_fts.rowid = f.id
                WHERE f.root = ?
                  AND {conditions}
            """
            sql = sql.format(conditions=conditions)
            params = [root_name]
            if fts_query:
                params.append(fts_query)
            params.extend(f"%{str(term).lower()}%" for term in filename_digit_terms)
            for pattern in exclude_patterns:
                params.extend([pattern] * len(sql_cols))
            if subpath:
                sql += " AND (f.subfolder = ? OR f.subfolder LIKE ?)"
                params.extend([subpath, subpath + "/%"])
            count_sql = f"SELECT COUNT(*) FROM ({sql}) AS matched"
            count_params = list(params)
            sort_key, _sep, sort_dir = str(sort or "date-desc").partition("-")
            order_col = {
                "name": "f.name COLLATE NOCASE",
                "size": "f.size",
                "date": "f.mtime",
            }.get(sort_key, "f.mtime")
            order_dir = "ASC" if sort_dir == "asc" else "DESC"
            sql += f" ORDER BY {order_col} {order_dir}"
            post_filtering = bool(node_filters or custom_filters)
            sql_limit = limit if not post_filtering else 0
            if sql_limit > 0:
                sql += " LIMIT ? OFFSET ?"
                params.extend([sql_limit, max(0, int(offset or 0))])
            try:
                total_count = int(conn.execute(count_sql, count_params).fetchone()[0] or 0)
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError:
                return {"files": [], "total": 0}
        results = []
        matched_total = 0
        for (name, subfolder, size, mtime, ftype, s_prompt_title,
             s_prompt_value, s_workflow_title, s_workflow_value,
             s_custom, s_custom_index, s_nodes) in rows:
            if terms.get("include") or terms.get("exclude"):
                if not _search_scope_group_matches({
                    "name": name,
                    "prompt_title": s_prompt_title,
                    "prompt_value": s_prompt_value,
                    "workflow_title": s_workflow_title,
                    "workflow_value": s_workflow_value,
                    "custom": s_custom,
                }, terms, scopes):
                    continue
            if not _node_filters_match(s_nodes, node_filters):
                continue
            if not _custom_filters_match(s_custom_index, custom_filters):
                continue
            matched_total += 1
            if post_filtering and matched_total <= max(0, int(offset or 0)):
                continue
            if post_filtering and limit > 0 and len(results) >= limit:
                continue
            subfolder = subfolder.replace("\\", "/")
            results.append({
                "name": name,
                "path": (subfolder + "/" + name) if subfolder else name,
                "subfolder": subfolder,
                "size": size,
                "created": mtime,
                "type": ftype,
            })
        return {"files": results, "total": matched_total if post_filtering else total_count}

    def update_searchable(self, root_name, subfolder, name,
                          searchable_text="",
                          s_prompt="", s_value="", s_workflow="", s_nodes="[]",
                          s_prompt_title="", s_prompt_value="",
                          s_workflow_title="", s_workflow_value="",
                          s_custom="", s_custom_index="[]",
                          replace=False, **legacy):
        """Update searchable fields for an indexed file.
        Accepts prompt/value/workflow fields, legacy structured fields, or a
        single searchable_text (stored as value for backward compat).
        Existing searchable metadata is preserved unless replace=True.
        """
        getter = self._allowed_roots.get(root_name)
        if getter is None:
            return False
        try:
            root_path = getter()
        except Exception:
            return False
        full = os.path.join(root_path, subfolder, name) if subfolder else \
               os.path.join(root_path, name)
        if not os.path.isfile(full):
            return False
        try:
            st = os.stat(full)
        except OSError:
            return False
        if not s_prompt:
            s_prompt = " ".join(
                legacy.get(key, "")
                for key in ("s_titles",)
                if legacy.get(key, "")
            )
        s_prompt_title = s_prompt_title or s_prompt
        s_prompt_value = s_prompt_value or s_value
        s_workflow_title = s_workflow_title or s_workflow
        s_custom = s_custom or legacy.get("s_custom", "") or legacy.get("custom", "")
        s_nodes = _as_str(s_nodes, "[]") or "[]"
        s_custom_index = _as_str(s_custom_index, "[]") or "[]"
        if searchable_text and not (s_prompt or s_value or s_workflow):
            s_prompt_value = searchable_text
        ext = os.path.splitext(name)[1].lower()
        ftype = self._ftype(ext)
        normalized_subfolder = subfolder.replace("\\", "/")
        with self._lock:
            if not self._ready:
                return False
            conn = self._get_conn()
            existing = conn.execute("""
                SELECT id, s_prompt_title, s_prompt_value,
                       s_workflow_title, s_workflow_value,
                       s_custom, s_custom_index, s_nodes
                FROM files
                WHERE root=? AND subfolder=? AND name=?
            """, (root_name, normalized_subfolder, name)).fetchone()
            if existing and not replace:
                if self._search_values_have_metadata(existing[1:]):
                    conn.execute("""
                        UPDATE files
                        SET mtime=?, size=?, ftype=?
                        WHERE id=?
                    """, (st.st_mtime, st.st_size, ftype, existing[0]))
                    conn.commit()
                    return True
            conn.execute("""
                INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                                 s_prompt_title, s_prompt_value,
                                 s_workflow_title, s_workflow_value,
                                 s_custom, s_custom_index, s_nodes, s_meta_source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(root, subfolder, name) DO UPDATE SET
                    mtime=excluded.mtime, size=excluded.size,
                    ftype=excluded.ftype,
                    s_prompt_title=excluded.s_prompt_title,
                    s_prompt_value=excluded.s_prompt_value,
                    s_workflow_title=excluded.s_workflow_title,
                    s_workflow_value=excluded.s_workflow_value,
                    s_custom=excluded.s_custom,
                    s_custom_index=excluded.s_custom_index,
                    s_nodes=excluded.s_nodes,
                    s_meta_source=excluded.s_meta_source
            """, (root_name, normalized_subfolder, name, st.st_mtime, st.st_size, ftype,
                  s_prompt_title, s_prompt_value, s_workflow_title,
                  s_workflow_value, s_custom, s_custom_index, s_nodes, "external"))
            conn.commit()
        return True

    def index_files_from_disk(self, entries):
        """Index a small list of files by reading providers/embedded metadata.

        Intended for generation-complete updates. This only runs when the
        snapshot index is already ready, and it preserves existing metadata.
        """
        if not entries:
            return {"updated": 0, "skipped": 0, "notReady": not self._ready}
        with self._lock:
            if not self._ready or self._building:
                return {"updated": 0, "skipped": len(entries), "notReady": True}
            conn = self._get_conn()

        updated = 0
        skipped = 0
        seen = set()
        for entry in entries:
            root_name = str(entry.get("root", "output")).strip().lower()
            subfolder = str(entry.get("subfolder", "")).strip().replace("\\", "/").strip("/")
            name = str(entry.get("name", entry.get("filename", ""))).strip()
            key = (root_name, subfolder, name)
            if not name or key in seen:
                skipped += 1
                continue
            seen.add(key)

            getter = self._allowed_roots.get(root_name)
            if getter is None:
                skipped += 1
                continue
            try:
                root_path = getter()
            except Exception:
                skipped += 1
                continue
            full = self._safe_path(root_path, subfolder, name) if subfolder else self._safe_path(root_path, name)
            ext = os.path.splitext(name)[1].lower()
            if full is None or ext not in self._media_exts or not os.path.isfile(full):
                skipped += 1
                continue
            try:
                st = os.stat(full)
            except OSError:
                skipped += 1
                continue
            ftype = self._ftype(ext)

            with self._lock:
                existing = conn.execute("""
                    SELECT id, s_prompt_title, s_prompt_value,
                           s_workflow_title, s_workflow_value,
                           s_custom, s_custom_index, s_nodes
                    FROM files
                    WHERE root=? AND subfolder=? AND name=?
                """, (root_name, subfolder, name)).fetchone()
                if existing and self._search_values_have_metadata(existing[1:]):
                    conn.execute("""
                        UPDATE files
                        SET mtime=?, size=?, ftype=?
                        WHERE id=?
                    """, (st.st_mtime, st.st_size, ftype, existing[0]))
                    conn.commit()
                    updated += 1
                    continue

            s_prompt_title = s_prompt_value = s_workflow_title = s_workflow_value = ""
            s_custom = ""
            s_custom_index = "[]"
            s_nodes = "[]"
            meta, meta_source = _read_media_meta_with_source(
                full,
                root_name=root_name,
                root_path=root_path,
                subfolder=subfolder,
                name=name,
            )
            if meta:
                parts = _extract_searchable_parts(meta, {
                    "path": full,
                    "root_name": root_name,
                    "root_path": root_path,
                    "subfolder": subfolder,
                    "name": name,
                    "filename": name,
                })
                s_prompt_title = parts["prompt_title"]
                s_prompt_value = parts["prompt_value"]
                s_workflow_title = parts["workflow_title"]
                s_workflow_value = parts["workflow_value"]
                s_custom = parts["custom"]
                s_custom_index = json.dumps(parts["custom_index"], ensure_ascii=False)
                s_nodes = json.dumps(parts["nodes"], ensure_ascii=False)

            with self._lock:
                conn.execute("""
                    INSERT INTO files(root, subfolder, name, mtime, size, ftype,
                                     s_prompt_title, s_prompt_value,
                                     s_workflow_title, s_workflow_value,
                                     s_custom, s_custom_index, s_nodes, s_meta_source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(root, subfolder, name) DO UPDATE SET
                        mtime=excluded.mtime,
                        size=excluded.size,
                        ftype=excluded.ftype,
                        s_prompt_title=excluded.s_prompt_title,
                        s_prompt_value=excluded.s_prompt_value,
                        s_workflow_title=excluded.s_workflow_title,
                        s_workflow_value=excluded.s_workflow_value,
                        s_custom=excluded.s_custom,
                        s_custom_index=excluded.s_custom_index,
                        s_nodes=excluded.s_nodes,
                        s_meta_source=excluded.s_meta_source
                """, (root_name, subfolder, name, st.st_mtime, st.st_size, ftype,
                      s_prompt_title, s_prompt_value, s_workflow_title,
                      s_workflow_value, s_custom, s_custom_index, s_nodes, meta_source))
                conn.commit()
                self._total_count += 1 if not existing else 0
            updated += 1
        return {"updated": updated, "skipped": skipped, "notReady": False}

    @property
    def status(self):
        percent = 100 if self._ready else 0
        if self._total_expected > 0:
            percent = min(100, round((self._indexed_count / self._total_expected) * 100, 1))
        db_exists = any(os.path.isfile(self._db_path + suffix) for suffix in ("", "-wal", "-shm"))
        state = "ready" if self._ready else "building" if self._building else "paused" if self._paused else "cleared" if self._cleared else "idle" if db_exists else "missing"
        elapsed = max(0.0, time.time() - self._started_at) if self._started_at and self._building else 0.0
        remaining = max(0, self._total_expected - self._indexed_count)
        fallback_rate = (self._indexed_count / elapsed) if elapsed > 0 and self._indexed_count > 0 else 0.0
        eta_rate = self._ema_rate if self._ema_rate > 0 else fallback_rate
        eta_ready = (
            self._building
            and eta_rate > 0
            and self._total_expected > 0
            and elapsed >= self._ETA_WARMUP_SECONDS
            and self._indexed_count >= self._ETA_WARMUP_FILES
        )
        eta = round(remaining / eta_rate) if eta_ready else None
        return {
            "state": state,
            "ready": self._ready,
            "building": self._building,
            "progress": self._progress,
            "syncing": self._syncing,
            "syncProgress": self._sync_progress,
            "lastSyncAt": self._last_sync_at,
            "autoSyncEnabled": self._auto_sync_enabled,
            "indexed": self._indexed_count if (self._building or self._paused) else self._total_count,
            "total": self._total_expected,
            "percent": percent,
            "cleared": self._cleared,
            "paused": self._paused,
            "rate": round(eta_rate, 2),
            "elapsed": round(elapsed),
            "eta": eta,
            "etaReady": eta_ready,
            "hasCustomMetadata": _has_index_contributors(),
        }

    def diagnostics(self):
        """Return read-only search index diagnostics for troubleshooting."""
        db_files = {}
        for suffix in ("", "-wal", "-shm"):
            path = self._db_path + suffix
            db_files[suffix or "db"] = {
                "exists": os.path.isfile(path),
                "bytes": os.path.getsize(path) if os.path.isfile(path) else 0,
            }
        info = {
            "dbPath": self._db_path,
            "files": db_files,
            "memory": {
                "ready": self._ready,
                "building": self._building,
                "syncing": self._syncing,
                "paused": self._paused,
                "progress": self._progress,
                "syncProgress": self._sync_progress,
                "lastSyncAt": self._last_sync_at,
            },
        }
        if not os.path.isfile(self._db_path):
            return info

        def scalar(conn, sql, default=None):
            try:
                row = conn.execute(sql).fetchone()
                return row[0] if row else default
            except Exception as e:
                return {"error": str(e)}

        try:
            conn = sqlite3.connect(self._db_path, timeout=2.0)
            try:
                meta_rows = {}
                try:
                    meta_rows = dict(conn.execute("SELECT key,value FROM meta").fetchall())
                except Exception as e:
                    meta_rows = {"error": str(e)}
                info.update({
                    "meta": meta_rows,
                    "shapeCompatible": self._has_search_schema_shape(conn),
                    "fileRows": scalar(conn, "SELECT COUNT(*) FROM files", 0),
                    "ftsRows": scalar(conn, "SELECT COUNT(*) FROM files_fts", 0),
                    "sources": [],
                    "triggers": [],
                })
                try:
                    info["sources"] = [
                        {"source": source or "", "count": count}
                        for source, count in conn.execute(
                            "SELECT s_meta_source, COUNT(*) FROM files GROUP BY s_meta_source"
                        ).fetchall()
                    ]
                except Exception as e:
                    info["sources"] = {"error": str(e)}
                try:
                    info["triggers"] = [
                        name for (name,) in conn.execute(
                            "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
                        ).fetchall()
                    ]
                except Exception as e:
                    info["triggers"] = {"error": str(e)}
            finally:
                conn.close()
        except Exception as e:
            info["error"] = str(e)
        return info

    def clear_index(self):
        """Close the DB and reset in-memory state before cache deletion."""
        with self._lock:
            self._generation += 1
            self._sync_generation += 1
            self._cancel_auto_sync_locked()
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None
            self._ready = False
            self._building = False
            self._syncing = False
            self._progress = "Index cleared"
            self._sync_progress = ""
            self._indexed_count = 0
            self._total_count = 0
            self._total_expected = 0
            self._cleared = True
            self._paused = False
            self._started_at = 0.0
            self._last_rate_sample_at = 0.0
            self._last_rate_sample_count = 0
            self._ema_rate = 0.0
            self._last_sync_at = 0.0

    def pause(self):
        """Stop the current build generation and keep the partial DB."""
        with self._lock:
            self._generation += 1
            self._sync_generation += 1
            self._cancel_auto_sync_locked()
            if self._conn is not None:
                try:
                    self._conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('index_complete','0')")
                    self._conn.commit()
                except Exception:
                    pass
            self._building = False
            self._syncing = False
            self._ready = False
            self._paused = True
            self._cleared = False
            self._progress = "Index paused"

    def estimate(self):
        """Estimate index build size and duration before starting."""
        by_ext = {}
        roots = []
        for root_name, getter in self._allowed_roots.items():
            try:
                root_path = getter()
            except Exception:
                continue
            if not os.path.isdir(root_path):
                continue
            roots.append((root_name, root_path))
            for dirpath, dirnames, filenames in os.walk(root_path):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for fname in filenames:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext in self._media_exts:
                        by_ext.setdefault(ext, []).append(os.path.join(dirpath, fname))
        total = sum(len(paths) for paths in by_ext.values())
        self._remember_estimate_total(total, self._roots_signature(roots))
        sampled = 0
        sample_seconds = 0.0
        sample_rate = 0.0
        method = "empty" if total == 0 else "small" if total < self._ESTIMATE_SAMPLE_LIMIT else "sample"
        if total >= self._ESTIMATE_SAMPLE_LIMIT:
            sample = self._sample_by_extension(by_ext, self._ESTIMATE_SAMPLE_LIMIT)
            started = time.time()
            for full in sample:
                if not os.path.isfile(full):
                    continue
                sampled += 1
                try:
                    meta = _read_media_meta(full)
                    if meta:
                        _extract_searchable_parts(meta, {"path": full})
                except Exception:
                    pass
            sample_seconds = max(0.001, time.time() - started)
            sample_rate = sampled / sample_seconds if sampled else 0.0
        rate = sample_rate or self._ema_rate or self._FALLBACK_ESTIMATE_RATE
        if sample_rate:
            rate = max(2.0, min(80.0, sample_rate))
        seconds = round(total / rate) if total > 0 and rate > 0 else 0
        return {
            "total": total,
            "sampled": sampled,
            "sampleSeconds": round(sample_seconds, 2),
            "estimatedSeconds": seconds,
            "rate": round(rate, 2),
            "method": method,
            "requiresConfirm": total >= self._ESTIMATE_SAMPLE_LIMIT,
            "estimated": not sample_rate and self._ema_rate <= 0,
        }

    async def estimate_async(self):
        """Estimate index build size/duration, yielding so client abort can cancel."""
        by_ext = {}
        roots = []
        walked = 0
        for root_name, getter in self._allowed_roots.items():
            try:
                root_path = getter()
            except Exception:
                continue
            if not os.path.isdir(root_path):
                continue
            roots.append((root_name, root_path))
            for dirpath, dirnames, filenames in os.walk(root_path):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                walked += 1
                if walked % 50 == 0:
                    await asyncio.sleep(0)
                for fname in filenames:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext in self._media_exts:
                        by_ext.setdefault(ext, []).append(os.path.join(dirpath, fname))
        total = sum(len(paths) for paths in by_ext.values())
        self._remember_estimate_total(total, self._roots_signature(roots))
        sampled = 0
        sample_seconds = 0.0
        sample_rate = 0.0
        method = "empty" if total == 0 else "small" if total < self._ESTIMATE_SAMPLE_LIMIT else "sample"
        if total >= self._ESTIMATE_SAMPLE_LIMIT:
            sample = self._sample_by_extension(by_ext, self._ESTIMATE_SAMPLE_LIMIT)
            started = time.time()
            for idx, full in enumerate(sample):
                if idx % 5 == 0:
                    await asyncio.sleep(0)
                if not os.path.isfile(full):
                    continue
                sampled += 1
                try:
                    meta = _read_media_meta(full)
                    if meta:
                        _extract_searchable_parts(meta, {"path": full})
                except Exception:
                    pass
            sample_seconds = max(0.001, time.time() - started)
            sample_rate = sampled / sample_seconds if sampled else 0.0
        rate = sample_rate or self._ema_rate or self._FALLBACK_ESTIMATE_RATE
        if sample_rate:
            rate = max(2.0, min(80.0, sample_rate))
        seconds = round(total / rate) if total > 0 and rate > 0 else 0
        return {
            "total": total,
            "sampled": sampled,
            "sampleSeconds": round(sample_seconds, 2),
            "estimatedSeconds": seconds,
            "rate": round(rate, 2),
            "method": method,
            "requiresConfirm": total >= self._ESTIMATE_SAMPLE_LIMIT,
            "estimated": not sample_rate and self._ema_rate <= 0,
        }

    def _sample_by_extension(self, by_ext, limit):
        """Choose a stratified random sample that roughly preserves extension mix."""
        total = sum(len(paths) for paths in by_ext.values())
        if total <= limit:
            return [path for paths in by_ext.values() for path in paths]
        samples = []
        remainders = []
        for ext, paths in by_ext.items():
            exact = (len(paths) / total) * limit
            take = int(exact)
            if take == 0 and paths:
                take = 1
            take = min(take, len(paths))
            samples.extend(random.sample(paths, take))
            remainders.append((exact - int(exact), ext))
        if len(samples) > limit:
            return random.sample(samples, limit)
        used = set(samples)
        for _fraction, ext in sorted(remainders, reverse=True):
            if len(samples) >= limit:
                break
            candidates = [path for path in by_ext[ext] if path not in used]
            if not candidates:
                continue
            picked = random.choice(candidates)
            samples.append(picked)
            used.add(picked)
        return samples
