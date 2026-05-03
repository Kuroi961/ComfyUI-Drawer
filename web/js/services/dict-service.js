/**
 * DictService — Multi-dictionary autocomplete service.
 *
 * Manages multiple dictionaries (Danbooru tags, user-defined words, etc.)
 * with lazy loading, ON/OFF settings integration, and a shared
 * autocomplete UI for textareas.
 *
 * == Public API (via window.ComfyDrawer) ==
 *
 *   dict                        — DictService instance
 *   dict.register(id, def)      — Register a new dictionary
 *   dict.search(query, opts?)   — Search across enabled dictionaries
 *   dict.isEnabled(id)          — Check ON/OFF state
 *   dict.setEnabled(id, bool)   — Toggle a dictionary
 *   dict.getDictionaries()      — List all registered dictionaries
 *   dict.registerOnBus(bus)     — Register as MessageBus service
 *
 *   attachDictAutocomplete(dict, textarea, opts?)
 *       — Attach autocomplete UI to a textarea
 *       — Public wrapper: window.ComfyDrawer.attachDictAutocomplete(textarea, opts?)
 */

// ── Dict entry shape: { t: string, c: number, n: number, orig?: string } ──

/**
 * Parse Danbooru-format CSV text into sorted tag entries.
 * Each entry: { t: tag_name, c: category, n: post_count, orig?: original_tag }
 * Alias entries have `orig` pointing to the canonical tag name.
 * @param {string} csv
 * @returns {Array<{t: string, c: number, n: number, orig?: string}>}
 */
function parseDanbooruCSV(csv) {
    const lines = csv.split('\n');
    const tags = [];
    const start = (lines[0] && lines[0].startsWith('tag,')) ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const c1 = line.indexOf(',');
        if (c1 < 0) continue;
        const c2 = line.indexOf(',', c1 + 1);
        if (c2 < 0) continue;
        let c3 = line.indexOf(',', c2 + 1);
        const tagName = line.substring(0, c1);
        const cat = parseInt(line.substring(c1 + 1, c2)) || 0;
        const count = parseInt(line.substring(c2 + 1, c3 > 0 ? c3 : undefined)) || 0;
        tags.push({ t: tagName, c: cat, n: count });
        // Parse aliases from 4th column
        if (c3 > 0) {
            let aliasStr = line.substring(c3 + 1).trim();
            if (aliasStr.startsWith('"') && aliasStr.endsWith('"')) {
                aliasStr = aliasStr.slice(1, -1);
            }
            if (aliasStr) {
                const aliases = aliasStr.split(',');
                for (let a = 0; a < aliases.length; a++) {
                    const alias = aliases[a].trim();
                    if (alias && alias !== tagName) {
                        tags.push({ t: alias, c: cat, n: count, orig: tagName });
                    }
                }
            }
        }
    }
    tags.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
    return tags;
}

// ═══════════════════════════════════════════════════════
//  DictService Class
// ═══════════════════════════════════════════════════════

export class DictService {
    /** @type {Map<string, DictEntry>} */
    #dictionaries = new Map();

    /** @type {import('./settings.js').SettingsService} */
    #settings;

    /**
     * @param {import('./settings.js').SettingsService} settings
     */
    constructor(settings) {
        this.#settings = settings;
    }

    /* ═══ Registration ═══ */

    /**
     * Register a dictionary source.
     * Automatically creates a toggle in the settings panel.
     *
     * @param {string} id - Unique identifier (e.g. 'danbooru')
     * @param {object} def
     * @param {string} def.label - Display name (e.g. 'Danbooru タグ')
     * @param {function(): Promise<Array>} def.load - Async loader; must return
     *   a **sorted** array of { t, c, n, orig? } entries.
     * @param {string} [def.context='all'] - 'prompt' | 'search' | 'all'
     * @param {number} [def.priority=50] - Sort order for settings (lower = higher)
     * @param {boolean} [def.defaultEnabled=true] - Default ON/OFF state
     * @param {boolean} [def.settingsToggle=true] - Show toggle in settings panel
     */
    register(id, { label, load, context = 'all', priority = 50, defaultEnabled = true, settingsToggle = true }) {
        this.#dictionaries.set(id, {
            id, label, context, priority, load,
            data: null,
            loading: null,
        });

        // Auto-register a settings toggle for this dictionary
        if (settingsToggle) {
            this.#settings.define(`dict.${id}.enabled`, {
                type: 'toggle',
                label,
                section: (window.ComfyDrawer?.t?.('dict.section')) || 'Dictionaries',
                defaultValue: defaultEnabled,
                order: priority,
            });
        }

    }

    /* ═══ ON/OFF State ═══ */

    /**
     * Check if a dictionary is enabled.
     * @param {string} id
     * @returns {boolean}
     */
    isEnabled(id) {
        if (!this.#dictionaries.has(id)) return false;
        return this.#settings.get(`dict.${id}.enabled`, true);
    }

    /**
     * Enable or disable a dictionary.
     * @param {string} id
     * @param {boolean} enabled
     */
    setEnabled(id, enabled) {
        this.#settings.set(`dict.${id}.enabled`, enabled);
    }

    /* ═══ Info ═══ */

    /**
     * Get info about all registered dictionaries.
     * @returns {Array<{id, label, context, enabled, loaded, count}>}
     */
    getDictionaries() {
        return [...this.#dictionaries.values()].map(d => ({
            id: d.id,
            label: d.label,
            context: d.context,
            enabled: this.isEnabled(d.id),
            loaded: !!d.data,
            count: d.data?.length ?? 0,
        }));
    }

    /**
     * Force a dictionary to reload its data on next search.
     * Used after modifying user dictionaries.
     * @param {string} id - Dictionary ID to reload
     */
    _forceReload(id) {
        const dict = this.#dictionaries.get(id);
        if (dict) {
            dict.data = null;
            dict.loading = null;
        }
    }

    /* ═══ Search ═══ */

    /**
     * Search across all enabled dictionaries matching the given context.
     * Uses hybrid strategy: prefix matches first (binary search, fast),
     * then partial/contains matches (linear scan) to fill remaining slots.
     *
     * @param {string} query - Raw query string (will be normalised)
     * @param {object} [opts]
     * @param {string} [opts.context='all'] - Filter to dictionaries with this context
     * @param {number} [opts.limit=12] - Max results
     * @returns {Promise<Array<{t, c, n, orig?, dictId, partial?}>>}
     */
    async search(query, { context = 'all', limit = 12 } = {}) {
        if (!query) return [];
        const normalised = query.toLowerCase().replace(/ /g, '_');
        // CJK characters carry more info per char — treat 1 CJK char as 2 ASCII
        const effectiveLen = [...normalised].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
        if (effectiveLen < 2) return [];

        const prefixResults = [];
        const partialResults = [];

        for (const [id, dict] of this.#dictionaries) {
            if (!this.isEnabled(id)) continue;
            if (context !== 'all' && dict.context !== 'all' && dict.context !== context) continue;

            await this.#ensureLoaded(id);
            if (!dict.data || dict.data.length === 0) continue;

            // Phase 1: Prefix matches (binary search — fast)
            const prefixMatches = this.#findByPrefix(dict.data, normalised, limit * 2);
            for (const m of prefixMatches) {
                prefixResults.push({ ...m, dictId: id });
            }

            // Phase 2: Partial/contains matches (linear scan — always run)
            const partialMatches = this.#findByContains(dict.data, normalised, limit * 2, prefixMatches);
            for (const m of partialMatches) {
                partialResults.push({ ...m, dictId: id, partial: true });
            }

        }

        // Sort each group by count descending
        prefixResults.sort((a, b) => b.n - a.n);
        partialResults.sort((a, b) => b.n - a.n);

        // Merge: prefix first, then partial — deduplicated by canonical tag
        // Reserve slots for partial matches (at least 1/3 of limit, min 4)
        const partialSlots = Math.max(4, Math.ceil(limit / 3));
        const prefixCap = partialResults.length > 0 ? limit - partialSlots : limit;
        const seen = new Set();
        const unique = [];

        for (const r of prefixResults) {
            const key = r.orig || r.t;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(r);
                if (unique.length >= prefixCap) break;
            }
        }
        if (unique.length < limit) {
            for (const r of partialResults) {
                const key = r.orig || r.t;
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push(r);
                    if (unique.length >= limit) break;
                }
            }
        }

        return unique;
    }

    /* ═══ MessageBus Integration ═══ */

    /**
     * Register DictService as a MessageBus responder.
     * Exposes `dict:suggest` and `tags:suggest` (backward compat).
     * @param {import('./message-bus.js').MessageBus} bus
     */
    registerOnBus(bus) {
        bus.respond('dict:suggest', async ({ partial, limit = 12, context = 'all' }) => {
            return this.search(partial, { limit, context });
        });
        // Backward compatibility alias
        bus.respond('tags:suggest', async ({ partial, limit = 12 }) => {
            return this.search(partial, { limit });
        });
    }

    /* ═══ Internal: Data Loading ═══ */

    /**
     * Ensure a dictionary's data is loaded (lazy, with dedup).
     * @param {string} id
     */
    async #ensureLoaded(id) {
        const dict = this.#dictionaries.get(id);
        if (!dict) return null;
        if (dict.data) return dict.data;
        if (dict.loading) return dict.loading;

        dict.loading = (async () => {
            try {
                dict.data = await dict.load();
            } catch (e) {
                console.warn(`[DictService] Failed to load "${id}":`, e);
                dict.data = [];
            }
            dict.loading = null;
            return dict.data;
        })();

        return dict.loading;
    }

    /* ═══ Internal: Search Algorithms ═══ */

    /** Binary search: find the first index where data[i].t >= prefix */
    #lowerBound(data, prefix) {
        let lo = 0, hi = data.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (data[mid].t < prefix) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    /**
     * Find entries whose tag name starts with `prefix` (binary search).
     * Collects up to `limit` unique results (by canonical tag name).
     */
    #findByPrefix(data, prefix, limit = 36) {
        if (data.length === 0) return [];
        const start = this.#lowerBound(data, prefix);
        const results = [];
        const seen = new Set();
        for (let i = start; i < data.length; i++) {
            if (!data[i].t.startsWith(prefix)) break;
            const key = data[i].orig || data[i].t;
            if (!seen.has(key)) {
                seen.add(key);
                results.push(data[i]);
                if (results.length >= limit) break;
            }
        }
        return results;
    }

    /**
     * Find entries whose tag name contains `query` but does NOT start with it
     * (linear scan). Skips entries already found by prefix search.
     * @param {Array} data - Sorted tag array
     * @param {string} query - Normalised query string
     * @param {number} limit - Max results
     * @param {Array} prefixMatches - Already-found prefix matches (to skip)
     */
    #findByContains(data, query, limit = 24, prefixMatches = []) {
        if (data.length === 0) return [];
        const prefixKeys = new Set(prefixMatches.map(m => m.orig || m.t));
        const results = [];
        const seen = new Set();
        for (let i = 0; i < data.length; i++) {
            const tag = data[i].t;
            // Skip prefix matches (already collected)
            if (tag.startsWith(query)) continue;
            // Check for contains match
            if (tag.includes(query)) {
                const key = data[i].orig || tag;
                if (!prefixKeys.has(key) && !seen.has(key)) {
                    seen.add(key);
                    results.push(data[i]);
                    if (results.length >= limit) break;
                }
            }
        }
        return results;
    }
}



// ═══════════════════════════════════════════════════════
//  Built-in Dictionary Loaders
// ═══════════════════════════════════════════════════════

/**
 * Create a loader for the Danbooru tag dictionary.
 * Fetches CSV from `/drawer/tags` and parses it.
 * @returns {function(): Promise<Array>}
 */
export function createDanbooruLoader() {
    return async () => {
        const resp = await fetch('/drawer/tags');
        if (!resp.ok) {
            console.warn(`[DictService] /drawer/tags returned ${resp.status}`);
            return [];
        }
        const csv = await resp.text();
        return parseDanbooruCSV(csv);
    };
}
/**
 * Create a loader for all user dictionaries (type="dict" only).
 * Fetches the manifest from `/drawer/user-dicts`, then loads entries
 * from each enabled dictionary's `/drawer/user-dict/{id}`.
 * @returns {function(): Promise<Array>}
 */
export function createUserDictLoader() {
    return async () => {
        const listResp = await fetch('/drawer/user-dicts');
        if (!listResp.ok) {
            console.warn(`[DictService] /drawer/user-dicts returned ${listResp.status}`);
            return [];
        }
        const dicts = await listResp.json();
        const allTags = [];

        for (const d of dicts) {
            if (!d.enabled) continue;
            if ((d.type || 'dict') !== 'dict') continue;
            try {
                const resp = await fetch(`/drawer/user-dict/${d.id}`);
                if (!resp.ok) continue;
                const entries = await resp.json();
                for (const e of entries) {
                    if (!e.tag) continue;
                    allTags.push({
                        t: e.tag,
                        c: -1,
                        n: 999999,
                        insertText: e.insert_text || undefined,
                    });
                }
            } catch (err) {
                console.warn(`[DictService] Failed to load user dict ${d.id}:`, err);
            }
        }

        allTags.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
        return allTags;
    };
}

/**
 * Create a loader for all wildcard dictionaries.
 * Each enabled wildcard file becomes a tag: __title__
 * The wildcard entries are embedded so prompt expansion can use them.
 * @returns {function(): Promise<Array>}
 */
export function createWildcardLoader() {
    return async () => {
        const listResp = await fetch('/drawer/user-dicts');
        if (!listResp.ok) return [];
        const dicts = await listResp.json();
        const allTags = [];

        for (const d of dicts) {
            if (!d.enabled) continue;
            if ((d.type || 'dict') !== 'wildcard') continue;
            // Register the wildcard file name as an autocomplete tag
            allTags.push({
                t: d.title,
                c: -2,  // special category for wildcards
                n: 999999,
                insertText: `__${d.title}__`,
            });
        }

        allTags.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
        return allTags;
    };
}


// ═══════════════════════════════════════════════════════
//  Autocomplete UI
// ═══════════════════════════════════════════════════════

let _cssInjected = false;
function _injectCSS() {
    if (_cssInjected) return;
    const link = document.createElement('link');
    link.id = 'dict-service-css';
    link.rel = 'stylesheet';
    link.href = new URL('../../css/dict.css', import.meta.url).href;
    document.head.appendChild(link);
    _cssInjected = true;
}


/**
 * Attach dictionary autocomplete to a <textarea> or <input>.
 *
 * @param {DictService} dict - DictService instance
 * @param {HTMLTextAreaElement|HTMLInputElement} textarea - target element
 * @param {Object} [opts]
 * @param {string} [opts.separator=','] - Token separator (',' for prompts, ' ' for search)
 * @param {string} [opts.context='all'] - Dictionary context filter
 * @returns {Function} cleanup — call to remove listeners
 */
export function attachDictAutocomplete(dict, textarea, opts = {}) {
    const { separator = ',', context = 'all' } = opts;
    const isSpace = separator === ' ';
    _injectCSS();

    let dropdown = null;
    let activeIdx = -1;
    let matches = [];
    let lastValue = textarea.value;   // Track value to detect actual changes

    const getQuery = () => {
        const pos = textarea.selectionStart;
        const text = textarea.value.substring(0, pos);
        const lastSep = text.lastIndexOf(separator);
        return text.substring(lastSep + 1).trim().toLowerCase().replace(/ /g, '_');
    };

    const close = () => {
        if (dropdown) { dropdown.remove(); dropdown = null; }
        matches = []; activeIdx = -1;
        stopTracking();
    };

    // ── Close on click outside dropdown ──
    const onDocMouseDown = (e) => {
        if (!dropdown) return;
        if (dropdown.contains(e.target) || e.target === textarea) return;
        close();
    };

    // ── Position tracking (rAF loop while dropdown is open) ──
    let trackingRaf = null;
    const startTracking = () => {
        stopTracking();
        const tick = () => {
            if (!dropdown) return;
            // Close if textarea was removed from DOM
            if (!textarea.isConnected) { close(); return; }
            positionDropdown();
            trackingRaf = requestAnimationFrame(tick);
        };
        trackingRaf = requestAnimationFrame(tick);
    };
    const stopTracking = () => {
        if (trackingRaf) {
            cancelAnimationFrame(trackingRaf);
            trackingRaf = null;
        }
    };

    const insertTag = (tag, category = 0) => {
        // Escape parentheses for Danbooru tags (where parens are literal, not emphasis)
        // but NOT for user dictionaries (c=-1) or wildcards (c=-2) — users may
        // intentionally register entries with emphasis syntax like (masterpiece:1.2)
        if (category >= 0) {
            tag = tag.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        }
        const pos = textarea.selectionStart;
        const text = textarea.value;
        const before = text.substring(0, pos);
        const after = text.substring(pos).trimStart();
        const lastSep = before.lastIndexOf(separator);

        // Build prefix: everything before the current token
        let prefix;
        if (lastSep >= 0) {
            prefix = before.substring(0, lastSep + 1) + (isSpace ? '' : ' ');
        } else {
            prefix = '';
        }

        // Build suffix: add separator after tag unless one already follows
        const sepSuffix = isSpace ? ' ' : ', ';
        const hasSep = isSpace ? after.startsWith(' ') : after.startsWith(',');
        const suffix = hasSep ? after : sepSuffix + after;
        textarea.value = prefix + tag + suffix;
        lastValue = textarea.value;   // Update tracked value
        const cursorPos = prefix.length + tag.length + (hasSep ? 0 : sepSuffix.length);
        textarea.selectionStart = textarea.selectionEnd = Math.min(cursorPos, textarea.value.length);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        close();
    };

    const positionDropdown = () => {
        if (!dropdown) return;
        const taRect = textarea.getBoundingClientRect();

        // Close if textarea is off-screen or invisible (e.g. clipped by scroll container)
        if (taRect.width === 0 && taRect.height === 0) { close(); return; }
        if (taRect.bottom < 0 || taRect.top > window.innerHeight ||
            taRect.right < 0 || taRect.left > window.innerWidth) {
            close();
            return;
        }

        const dropBottom = taRect.bottom + 280;
        if (dropBottom > window.innerHeight) {
            dropdown.style.bottom = (window.innerHeight - taRect.top + 4) + 'px';
            dropdown.style.top = 'auto';
        } else {
            dropdown.style.top = (taRect.bottom + 2) + 'px';
            dropdown.style.bottom = 'auto';
        }
        dropdown.style.left = taRect.left + 'px';
        dropdown.style.width = taRect.width + 'px';
    };



    const showDropdown = (results) => {
        matches = results;
        if (matches.length === 0) { close(); return; }

        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.className = 'dc-dropdown';
            document.body.appendChild(dropdown);
        }
        positionDropdown();
        startTracking();
        activeIdx = -1;
        dropdown.innerHTML = '';
        let partialSepAdded = false;
        matches.forEach((m) => {
            // Insert separator before the first partial match
            if (m.partial && !partialSepAdded) {
                partialSepAdded = true;
                const sep = document.createElement('div');
                sep.className = 'dc-separator';
                sep.textContent = (window.ComfyDrawer?.t?.('dict.partialMatch')) || '⋯ Partial Match';
                dropdown.appendChild(sep);
            }
            const item = document.createElement('div');
            // Determine what gets inserted on selection
            const insertText = m.insertText || (m.orig || m.t).replace(/_/g, ' ');
            item.className = `dc-item dc-cat-${m.c}${m.partial ? ' dc-partial' : ''}`;
            if (m.c === -2) {
                // Wildcard entry
                const display = m.t;
                item.innerHTML = `<span class="dc-name">🎲 __${display}__</span><span class="dc-count">wildcard</span>`;
            } else if (m.c === -1) {
                // User dictionary entry
                const display = m.t.replace(/_/g, ' ');
                const insertDisplay = m.insertText ? ` → ${m.insertText}` : '';
                item.innerHTML = `<span class="dc-name">★ ${display}${insertDisplay}</span><span class="dc-count">user</span>`;
            } else if (m.orig) {
                item.innerHTML = `<span class="dc-name"><span style="opacity:0.5">${m.t.replace(/_/g, ' ')}</span> → ${m.orig.replace(/_/g, ' ')}</span><span class="dc-count">${m.n.toLocaleString()}</span>`;
            } else {
                item.innerHTML = `<span class="dc-name">${m.t.replace(/_/g, ' ')}</span><span class="dc-count">${m.n.toLocaleString()}</span>`;
            }
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                insertTag(insertText, m.c);
            });
            dropdown.appendChild(item);
        });
    };


    const setActive = (idx) => {
        const items = dropdown?.querySelectorAll('.dc-item') || [];
        items.forEach((el, i) => el.classList.toggle('active', i === idx));
        activeIdx = idx;
        if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    };

    const doSearch = async () => {
        const q = getQuery();
        // CJK-aware minimum length (same logic as DictService.search)
        const effectiveLen = [...q].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
        if (effectiveLen < 2) { close(); return; }
        const results = await dict.search(q, { context, limit: 12 });
        showDropdown(results);
    };

    const onInput = async () => {
        // Only search when the text actually changes (not cursor movement / focus)
        if (textarea.value === lastValue) return;
        lastValue = textarea.value;
        await doSearch();
    };

    const onBlur = () => setTimeout(() => {
        // Only close if textarea is not the active element (avoid race with refocus)
        if (document.activeElement !== textarea) close();
    }, 150);

    const onKeyDown = (e) => {
        if (!dropdown) return;
        if (e.isComposing) return;   // ignore IME keystrokes (Enter during conversion etc.)
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(Math.min(activeIdx + 1, matches.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(Math.max(activeIdx - 1, 0));
        } else if (e.key === 'Enter' && activeIdx >= 0) {
            e.preventDefault();
            const m = matches[activeIdx];
            insertTag(m.insertText || (m.orig || m.t).replace(/_/g, ' '), m.c);
        } else if (e.key === 'Escape') {
            close();
        } else if (e.key === 'Tab' && matches.length > 0) {
            e.preventDefault();
            const m = matches[activeIdx >= 0 ? activeIdx : 0];
            insertTag(m.insertText || (m.orig || m.t).replace(/_/g, ' '), m.c);
        }
    };

    textarea.addEventListener('input', onInput);
    textarea.addEventListener('blur', onBlur);
    textarea.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onDocMouseDown, true);

    // Return cleanup function
    return () => {
        textarea.removeEventListener('input', onInput);
        textarea.removeEventListener('blur', onBlur);
        textarea.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('mousedown', onDocMouseDown, true);
        close();
    };
}
