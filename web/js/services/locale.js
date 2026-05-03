/**
 * ComfyDrawer — LocaleService
 * Lightweight i18n service for the Drawer platform and all gadgets.
 *
 * Design:
 *   - Key-based lookup: t('gallery.empty') → "No files found"
 *   - Template interpolation: t('cache.cleared', { count: 5 }) → "Cleared 5 files"
 *   - Fallback chain: requested locale → 'en' → raw key
 *   - Auto-detection: syncs with ComfyUI's Settings > Locale
 *   - Extensible: addMessages(locale, msgs) for third-party gadgets
 *
 * Usage:
 *   const { t } = window.ComfyDrawer;
 *   element.textContent = t('common.close');   // "閉じる" / "Close" / "关闭"
 *   showAlert(t('cache.cleared', { count: 5, mb: '2.1' }));
 */

// ── Built-in message bundles (loaded from JSON) ──
const _bundles = {};   // { 'en': { flat.key: 'value' }, 'ja': { ... }, ... }
let _locale = 'en';    // current locale
let _fallback = 'en';  // fallback locale

// ── Flatten nested JSON to dot-separated keys ──
function _flatten(obj, prefix = '') {
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            Object.assign(result, _flatten(val, fullKey));
        } else {
            result[fullKey] = val;
        }
    }
    return result;
}

// ── Template interpolation: {key} → value ──
function _interpolate(template, params) {
    if (!params || typeof template !== 'string') return template;
    return template.replace(/\{(\w+)\}/g, (_, key) =>
        params[key] !== undefined ? String(params[key]) : `{${key}}`
    );
}

/**
 * Translate a key with optional parameters.
 * @param {string} key - Dot-separated key (e.g. 'gallery.empty')
 * @param {object} [params] - Template variables (e.g. { count: 5 })
 * @returns {string} Translated string, or the key itself if not found
 */
export function t(key, params) {
    // Try current locale first, then fallback
    const msg = _bundles[_locale]?.[key]
             ?? _bundles[_fallback]?.[key]
             ?? key;
    return _interpolate(msg, params);
}

/**
 * Set the active locale.
 * @param {string} code - ISO language code ('en', 'ja', 'zh', etc.)
 */
export function setLocale(code) {
    if (code && typeof code === 'string') {
        // Normalize: 'zh-CN' → 'zh', 'en-US' → 'en', 'ja-JP' → 'ja'
        _locale = code.split('-')[0].toLowerCase();
    }
}

/**
 * Get the current locale code.
 * @returns {string}
 */
export function getLocale() {
    return _locale;
}

/**
 * Register additional messages for a locale.
 * Used by third-party gadgets to add their own translations.
 * @param {string} code - Locale code
 * @param {object} messages - Nested or flat message object
 */
export function addMessages(code, messages) {
    const norm = code.split('-')[0].toLowerCase();
    if (!_bundles[norm]) _bundles[norm] = {};
    Object.assign(_bundles[norm], _flatten(messages));
}

/**
 * Initialize the locale service.
 * Loads built-in locale JSONs and auto-detects the user's language.
 * @param {object} bridge - ComfyBridge instance (for reading ComfyUI locale setting)
 */
export async function initLocale(bridge) {
    // ── Load bundled locale files ──
    const baseUrl = new URL('../../locales/', import.meta.url).href;
    const codes = ['en', 'ja', 'zh'];

    await Promise.all(codes.map(async (code) => {
        try {
            const resp = await fetch(`${baseUrl}${code}.json`, {
                cache: 'no-cache',
            });
            if (resp.ok) {
                const json = await resp.json();
                _bundles[code] = _flatten(json);
            }
        } catch { /* locale file missing — skip */ }
    }));

    // ── Detect locale ──
    // Priority: ComfyUI setting > browser language > 'en'
    let detected = 'en';

    // 1. ComfyUI Settings > Locale
    try {
        const comfyLocale = bridge?.getSetting?.('Comfy.Locale');
        if (comfyLocale && typeof comfyLocale === 'string') {
            detected = comfyLocale.split('-')[0].toLowerCase();
        }
    } catch { /* setting not available */ }

    // 2. Browser language fallback
    if (!_bundles[detected]) {
        const browserLang = (navigator.language || 'en').split('-')[0].toLowerCase();
        if (_bundles[browserLang]) {
            detected = browserLang;
        }
    }

    // 3. Final fallback
    if (!_bundles[detected]) {
        detected = 'en';
    }

    _locale = detected;
}
