/**
 * ComfyDrawer — SettingsService
 * A localStorage-backed settings store with wildcard change listeners.
 *
 * Usage (via public API — no import needed):
 *   const settings = window.ComfyDrawer.settings;
 *
 *   // Get with default
 *   settings.get('dict.danbooru.enabled', true);
 *
 *   // Set (auto-persists to localStorage)
 *   settings.set('dict.danbooru.enabled', false);
 *
 *   // Watch for changes (supports wildcard *)
 *   const off = settings.onChange('dict.*', (key, value) => {
 *       console.log(`${key} changed to ${value}`);
 *   });
 *   // Later: off() to unsubscribe
 *
 *   // Get all keys matching a pattern
 *   settings.keys('dict.*');  // → ['dict.danbooru.enabled', 'dict.e621.enabled', ...]
 *
 *   // Define setting metadata (for settings panel rendering)
 *   settings.define('dict.danbooru.enabled', {
 *       type: 'toggle',
 *       label: 'Danbooru タグ',
 *       section: '📖 辞書',
 *       defaultValue: true,
 *       order: 10,
 *   });
 */

const STORAGE_PREFIX = 'comfy-drawer-settings:';

export class SettingsService {
    /** @type {Map<string, *>} In-memory cache of all settings */
    #cache = new Map();

    /** @type {Array<{ pattern: string, regex: RegExp, callback: function }>} */
    #listeners = [];

    /** @type {Map<string, SettingDef>} Setting definitions for UI rendering */
    #definitions = new Map();

    constructor() {
        this.#loadAll();
    }

    /* ═══════════════════════════════════════════════════════
       Core API
       ═══════════════════════════════════════════════════════ */

    /**
     * Get a setting value.
     * @param {string} key - Dot-separated key (e.g. 'dict.danbooru.enabled')
     * @param {*} [defaultValue] - Returned if key is not set
     * @returns {*}
     */
    get(key, defaultValue = undefined) {
        if (this.#cache.has(key)) return this.#cache.get(key);

        // Check if there's a defined default
        const def = this.#definitions.get(key);
        if (def && def.defaultValue !== undefined) return def.defaultValue;

        return defaultValue;
    }

    /**
     * Set a setting value. Persists to localStorage and notifies listeners.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        const old = this.#cache.get(key);
        if (old === value) return;

        this.#cache.set(key, value);
        this.#persist(key, value);
        this.#notify(key, value, old);
    }

    /**
     * Delete a setting (revert to default).
     * @param {string} key
     */
    delete(key) {
        const old = this.#cache.get(key);
        this.#cache.delete(key);
        localStorage.removeItem(STORAGE_PREFIX + key);

        // Notify with new value = default
        const def = this.#definitions.get(key);
        const newVal = def?.defaultValue;
        this.#notify(key, newVal, old);
    }

    /**
     * Check if a setting has been explicitly set.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.#cache.has(key);
    }

    /**
     * Get all keys matching a glob pattern.
     * @param {string} [pattern] - Glob pattern with * wildcard. If omitted, returns all keys.
     * @returns {string[]}
     */
    keys(pattern) {
        if (!pattern) return [...this.#cache.keys()];
        const regex = this.#globToRegex(pattern);
        return [...this.#cache.keys()].filter(k => regex.test(k));
    }

    /* ═══════════════════════════════════════════════════════
       Change Listeners
       ═══════════════════════════════════════════════════════ */

    /**
     * Subscribe to setting changes.
     * @param {string} pattern - Key or glob pattern (e.g. 'dict.*', '*')
     * @param {function(string, *, *)} callback - (key, newValue, oldValue)
     * @returns {function} Unsubscribe function
     */
    onChange(pattern, callback) {
        const entry = {
            pattern,
            regex: this.#globToRegex(pattern),
            callback,
        };
        this.#listeners.push(entry);
        return () => {
            const idx = this.#listeners.indexOf(entry);
            if (idx >= 0) this.#listeners.splice(idx, 1);
        };
    }

    /* ═══════════════════════════════════════════════════════
       Setting Definitions (for UI)
       ═══════════════════════════════════════════════════════ */

    /**
     * Define metadata for a setting. Used by the settings panel to render UI.
     * @param {string} key
     * @param {object} def
     * @param {string} def.type - 'toggle' | 'select' | 'slider' | 'text' | 'action'
     * @param {string} def.label - Display label
     * @param {string} [def.section] - Section heading (for grouping)
     * @param {*} [def.defaultValue] - Default value
     * @param {number} [def.order] - Sort order within section (default 50)
     * @param {Array<{label: string, value: *}>} [def.options] - For 'select' type
     * @param {number} [def.min] - For 'slider' type
     * @param {number} [def.max] - For 'slider' type
     * @param {number} [def.step] - For 'slider' type
     * @param {string} [def.description] - Help text
     * @param {function} [def.action] - For 'action' type: async callback to execute
     * @param {string} [def.buttonLabel] - For 'action' type: button text (default '実行')
     * @param {boolean} [def.dangerous] - For 'action' type: use red/warning style
     */
    define(key, def) {
        this.#definitions.set(key, { ...def, key });

        // If no value is cached, and there's a defaultValue, pre-populate
        // (but don't persist — defaults are only in-memory)
    }

    /**
     * Get all defined settings, grouped by section.
     * Sections are sorted by the lowest `sectionOrder` among their items
     * (default 50). Within each section, items are sorted by `order`.
     * @returns {Map<string, Array<{key: string, ...def}>>}
     */
    getDefinitions() {
        const sections = new Map();
        for (const [key, def] of this.#definitions) {
            const section = def.section || 'General';
            if (!sections.has(section)) sections.set(section, []);
            sections.get(section).push({ ...def, key });
        }
        // Sort items within each section by order
        for (const items of sections.values()) {
            items.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
        }
        // Sort sections by the lowest sectionOrder among their items
        const sorted = [...sections.entries()].sort(([, aItems], [, bItems]) => {
            const aOrder = Math.min(...aItems.map(i => i.sectionOrder ?? 50));
            const bOrder = Math.min(...bItems.map(i => i.sectionOrder ?? 50));
            return aOrder - bOrder;
        });
        return new Map(sorted);
    }

    /* ═══════════════════════════════════════════════════════
       Internal
       ═══════════════════════════════════════════════════════ */

    /** Load all settings from localStorage into the cache */
    #loadAll() {
        for (let i = 0; i < localStorage.length; i++) {
            const fullKey = localStorage.key(i);
            if (!fullKey.startsWith(STORAGE_PREFIX)) continue;
            const key = fullKey.slice(STORAGE_PREFIX.length);
            try {
                this.#cache.set(key, JSON.parse(localStorage.getItem(fullKey)));
            } catch {
                // Non-JSON value — store as raw string
                this.#cache.set(key, localStorage.getItem(fullKey));
            }
        }
    }

    /** Persist a single key to localStorage */
    #persist(key, value) {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }

    /** Notify matching listeners */
    #notify(key, value, oldValue) {
        for (const entry of this.#listeners) {
            if (entry.regex.test(key)) {
                try {
                    entry.callback(key, value, oldValue);
                } catch (err) {
                    console.error(`[SettingsService] Error in onChange callback for "${entry.pattern}":`, err);
                }
            }
        }
    }

    /**
     * Convert a glob pattern to a RegExp.
     * Supports * as wildcard for any characters.
     * @param {string} pattern
     * @returns {RegExp}
     */
    #globToRegex(pattern) {
        // Exact match (no wildcards)
        if (!pattern.includes('*')) {
            return new RegExp(`^${this.#escapeRegex(pattern)}$`);
        }
        // Convert glob * to regex .*
        const parts = pattern.split('*').map(p => this.#escapeRegex(p));
        return new RegExp(`^${parts.join('.*')}$`);
    }

    /** Escape special regex characters */
    #escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
