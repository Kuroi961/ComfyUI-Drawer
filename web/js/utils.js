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
 * Clean a Deck/XYZ display title.
 * Removes unescaped Drawer markers while preserving escaped literals.
 * @param {string} title
 * @returns {string}
 */
export function cleanDrawerTitle(title) {
  return String(title || '')
    .replace(/^\[([^\]]+)\]\s*/, '')
    .replace(/(?<!\\)\u{1F4DD}/gu, '')
    .replace(/(?<!\\)\u26A1\uFE0F?/g, '')
    .replace(/\\(.)/gsu, '$1')
    .trim();
}

/**
 * Parse group markers used by Deck and XYZ.
 *   ⚡ Detailer       -> standalone group toggle
 *   [upscale] ESRGAN  -> exclusive group switch
 * @param {string} rawTitle
 * @returns {{displayTitle:string,isToggle:boolean,switchName:string|null}}
 */
export function parseDrawerGroupMarkers(rawTitle) {
  let t = String(rawTitle || '');
  let isToggle = false;
  let switchName = null;

  if (/(?<!\\)\u26A1/u.test(t)) {
    isToggle = true;
    t = t.replace(/(?<!\\)\u26A1\uFE0F?/g, '');
  }

  const switchMatch = t.match(/^\[([^\]]+)\]\s*/);
  if (switchMatch) {
    switchName = switchMatch[1].trim();
    t = t.slice(switchMatch[0].length);
  }

  return {
    displayTitle: cleanDrawerTitle(t),
    isToggle,
    switchName,
  };
}

/**
 * Parse node markers used by Deck and XYZ.
 * @param {string} rawTitle
 * @returns {{displayTitle:string,isToggle:boolean,switchName:string|null}}
 */
export function parseDrawerNodeMarkers(rawTitle) {
  let t = String(rawTitle || '');
  let switchName = null;
  const switchMatch = t.match(/^\[([^\]]+)\]\s*/);
  if (switchMatch) {
    switchName = switchMatch[1].trim();
    t = t.slice(switchMatch[0].length);
  }
  return {
    displayTitle: cleanDrawerTitle(t),
    isToggle: /(?<!\\)\u26A1/u.test(t),
    switchName,
  };
}

/**
 * Remove stale Drawer UI state from a serialized workflow.
 * This is intentionally applied to serialized JSON, not the live graph, so
 * temporary UI preferences do not leak into image metadata after nodes/groups
 * have been deleted or renamed.
 * @param {object|null} workflow
 * @returns {object|null}
 */
export function sanitizeComfyDrawerWorkflowExtra(workflow) {
  if (!workflow || typeof workflow !== 'object') return workflow;
  const drawer = workflow.extra?.comfyDrawer;
  if (!drawer || typeof drawer !== 'object') return workflow;

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const groups = Array.isArray(workflow.groups) ? workflow.groups : [];
  const nodeIds = new Set(nodes.map(n => String(n?.id)));
  const groupInfos = groups.map(group => {
    const title = String(group?.title || 'Group');
    return {
      key: `group-${title}`,
      title,
      parsed: parseDrawerGroupMarkers(title),
      bounds: group?._bounding || group?.bounding || group?.bounds || null,
    };
  });
  const groupKeys = new Set(groupInfos.map(g => g.key));
  const groupSwitchLabels = new Set(groupInfos
    .map(g => g.parsed.switchName)
    .filter(Boolean));

  const nodeGroupKey = (node) => {
    const pos = node?.pos || node?._pos;
    if (!Array.isArray(pos)) return '__ungrouped__';
    const x = Number(pos[0]);
    const y = Number(pos[1]);
    for (const group of groupInfos) {
      const b = group.bounds;
      if (!Array.isArray(b) || b.length < 4) continue;
      const [gx, gy, gw, gh] = b.map(Number);
      if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh) return group.key;
    }
    return '__ungrouped__';
  };

  const validNodeExclusiveKeys = new Set();
  for (const node of nodes) {
    const parsed = parseDrawerNodeMarkers(node?.title || node?.type);
    if (parsed.switchName) {
      validNodeExclusiveKeys.add(`${nodeGroupKey(node)}::${parsed.switchName}`);
    }
  }

  const pruneObjectMap = (key, keepEntry) => {
    const map = drawer[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    for (const [entryKey, value] of Object.entries(map)) {
      if (!keepEntry(entryKey, value)) delete map[entryKey];
    }
    if (Object.keys(map).length === 0) delete drawer[key];
  };

  pruneObjectMap('deckGroupOff', (key) => groupKeys.has(key));
  pruneObjectMap('deckGroupExclusive', (label, key) =>
    key === null || (groupSwitchLabels.has(label) && groupKeys.has(String(key))));
  pruneObjectMap('deckNodeOff', (id) => nodeIds.has(String(id)));
  pruneObjectMap('deckNodeExclusive', (key, id) =>
    id === null || (validNodeExclusiveKeys.has(key) && nodeIds.has(String(id))));
  pruneObjectMap('deckExpand', (key) =>
    groupKeys.has(key)
    || key === '__ungrouped__'
    || key === '__flat__'
    || (key.startsWith('node-') && nodeIds.has(key.slice(5))));

  if (Object.keys(drawer).length === 0) delete workflow.extra.comfyDrawer;
  if (workflow.extra && Object.keys(workflow.extra).length === 0) delete workflow.extra;
  return workflow;
}

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
