/**
 * ComfyDrawer — Shared Utilities
 * Common helpers used across platform core and gadgets.
 * All exports are also exposed on window.ComfyDrawer for third-party use.
 *
 * Usage (built-in):
 *   import { escapeHTML, getLinkedInputNames, truncate, CollapseStore } from '../../js/utils.js';
 *
 * Usage (third-party, no import needed):
 *   const { escapeHTML, truncate, getLinkedInputNames, CollapseStore } = window.ComfyDrawer;
 */

/**
 * Escape HTML special characters to prevent injection in innerHTML.
 * @param {*} s - Value to escape (coerced to string)
 * @returns {string}
 */
export const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Get the names of node inputs that have incoming connections (linked).
 * Shared by Deck and XYZ Plot for filtering editable widgets.
 * @param {object} node - LiteGraph node
 * @returns {Set<string>}
 */
export function getLinkedInputNames(node) {
  const linked = new Set();
  for (const inp of (node.inputs || [])) {
    if (inp.link != null) linked.add(inp.name);
  }
  return linked;
}

/**
 * Truncate a string to a maximum length, appending '…' if truncated.
 * @param {*} s - Value to truncate
 * @param {number} [max=20]
 * @returns {string}
 */
export const truncate = (s, max = 20) => {
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
};

/**
 * Normalize a file path to use forward slashes.
 * ComfyUI APIs return OS-native separators (backslash on Windows),
 * but internal comparison and display should use forward slashes.
 * @param {string} p - Path to normalize
 * @returns {string}
 */
export const normalizePath = (p) => String(p).replaceAll('\\', '/');

/**
 * Persistent collapse state backed by localStorage.
 * Shared by gadgets that have collapsible sections (Deck, XYZ Plot).
 *
 * Usage:
 *   const collapse = new CollapseStore('deck-collapsed');
 *   collapse.save('node-42', true);
 *   collapse.get('node-42'); // true
 *   collapse.has('node-42'); // true
 */
export class CollapseStore {
  #key;
  #scope = '';

  /** @param {string} storageKey - localStorage key */
  constructor(storageKey) {
    this.#key = storageKey;
  }

  /**
   * Set scope prefix for keys (e.g. workflow path).
   * When set, all keys are prefixed with `scope:` to isolate
   * state per-workflow.
   * @param {string} scope
   */
  setScope(scope) {
    this.#scope = scope || '';
  }

  #scoped(key) {
    return this.#scope ? `${this.#scope}::${key}` : key;
  }

  /** Save collapse state for a key */
  save(key, collapsed) {
    try {
      const d = JSON.parse(localStorage.getItem(this.#key) || '{}');
      const sk = this.#scoped(key);
      if (collapsed) d[sk] = true; else delete d[sk];
      localStorage.setItem(this.#key, JSON.stringify(d));
    } catch { /* quota exceeded or parse error */ }
  }

  /** Get collapse state for a key (default: false) */
  get(key) {
    try { return JSON.parse(localStorage.getItem(this.#key) || '{}')[this.#scoped(key)] || false; }
    catch { return false; }
  }

  /** Check if a key has an explicit preference */
  has(key) {
    try { return this.#scoped(key) in JSON.parse(localStorage.getItem(this.#key) || '{}'); }
    catch { return false; }
  }
}
