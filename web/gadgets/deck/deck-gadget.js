// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Deck Gadget — Operator Dashboard for ComfyUI
//  Migrated from ComfyPilot/MobileUI into ComfyDrawer gadget architecture.
//
//  Provides: node scanning (📝), widget factory, output display,
//  progress bar, generate/cancel, and tag autocomplete integration.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { GadgetBase } from '../../js/core/gadget-base.js';
import { attachDictAutocomplete } from '../../js/services/dict-service.js';
import { openLightbox } from '../../js/services/lightbox.js';
import { createMediaCard } from '../../js/components/media-card.js';
import { ContextMenuService } from '../../js/services/context-menu.js';
import { escapeHTML, getLinkedInputNames, cleanDrawerTitle, parseDrawerGroupMarkers, parseDrawerNodeMarkers } from '../../js/utils.js';
import { enumerateDrawerControls, isDrawerControlsNode } from '../../js/utils/drawer-controls.js';

const EMOJI_EDIT = "\u{1F4DD}"; // 📝



const DECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"/><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/></svg>`;
const ICON_LOCK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const ICON_DICE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="3"/><path d="M8 8h.01"/><path d="M16 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>`;
const ICON_SWAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>`;
const ICON_MUSIC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
const ICON_VIDEO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.43V8.33a.5.5 0 0 0-.8-.43L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`;
const ICON_PLAY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_X = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

// Widget types to skip
const SKIP_WIDGET_TYPES = new Set(["converted-widget", "video", "audioUI"]);

/**
 * Copy text to clipboard using the legacy execCommand approach.
 * Works in non-secure contexts (plain http) where navigator.clipboard is unavailable.
 */
function copyViaExecCommand(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch { /* silent */ }
  ta.remove();
}


/* ═══ Attention Weight Edit (mobile-friendly Ctrl+↑/↓ equivalent) ═══ */

const ATTN_DELTA = 0.05;

/** Add delta to a weight string, avoiding float precision issues. */
function _incrementWeight(val, delta) {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return String(Number((n + delta).toFixed(10)));
}

/** Find nearest (parenthesized) enclosure around cursor, handling nesting. */
function _findEnclosure(text, pos) {
  let start = pos, end = pos, o = 0, c = 0;
  while (start >= 0) {
    start--;
    if (text[start] === '(' && o === c) break;
    if (text[start] === '(') o++;
    if (text[start] === ')') c++;
  }
  if (start < 0) return null;
  o = 0; c = 0;
  while (end < text.length) {
    if (text[end] === ')' && o === c) break;
    if (text[end] === '(') o++;
    if (text[end] === ')') c++;
    end++;
  }
  return end === text.length ? null : { start: start + 1, end };
}

/** Ensure parenthesized text has a :weight suffix. */
function _ensureWeight(s) {
  const m = s.match(/^\((.+)\)$/);
  const w = s.match(/:([+-]?(\d*\.)?\d+)/);
  return m && !w ? `(${m[1]}:1.0)` : s;
}

/** Parse current weight from selected text like "(word:1.1)". */
function _parseCurrentWeight(s) {
  const m = s.match(/:([+-]?\d+(?:\.\d+)?)\)$/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Apply attention weight change to textarea.
 * @param {HTMLTextAreaElement} ta
 * @param {number} delta  +ATTN_DELTA or -ATTN_DELTA
 * @returns {{ newWeight: number|null }} for UI feedback
 */
function applyAttentionEdit(ta, delta) {
  let start = ta.selectionStart;
  let end = ta.selectionEnd;
  let sel = ta.value.substring(start, end);

  // If nothing selected, try to auto-detect
  if (!sel) {
    const enc = _findEnclosure(ta.value, start);
    if (enc) {
      start = enc.start; end = enc.end;
      sel = ta.value.substring(start, end);
    } else {
      const delims = ` .,\\/!?%^*;:{}=-_\`~()\r\n\t`;
      while (!delims.includes(ta.value[start - 1]) && start > 0) start--;
      while (!delims.includes(ta.value[end]) && end < ta.value.length) end++;
      sel = ta.value.substring(start, end);
      if (!sel) return { newWeight: null };
    }
  }

  // Trim trailing space
  if (sel[sel.length - 1] === ' ') { sel = sel.slice(0, -1); --end; }

  // Expand to include surrounding parens
  if (ta.value[start - 1] === '(' && ta.value[end] === ')') {
    --start; end += 1;
    sel = ta.value.substring(start, end);
  }

  // Wrap in parens if needed
  if (sel[0] !== '(' || sel[sel.length - 1] !== ')') sel = `(${sel})`;

  // Ensure :weight
  sel = _ensureWeight(sel);

  // Apply delta
  const result = sel.replace(
    /\((.*):([+-]?\d+(?:\.\d+)?)\)/,
    (_m, txt, w) => {
      w = _incrementWeight(w, delta);
      return w == 1 ? txt : `(${txt}:${w})`;
    }
  );

  // Insert via execCommand for undo support
  ta.focus();
  ta.setSelectionRange(start, end);
  document.execCommand('insertText', false, result);
  ta.setSelectionRange(start, start + result.length);

  // Trigger input event for sync
  ta.dispatchEvent(new Event('input', { bubbles: true }));

  // Return new weight for display
  const newWeight = _parseCurrentWeight(result);
  return { newWeight };
}

/**
 * Attach attention toolbar to a textarea wrap element.
 * @param {HTMLDivElement} wrap  .dk-textarea-wrap
 * @param {HTMLTextAreaElement} ta
 * @returns {Function} dispose
 */
function attachAttnToolbar(wrap, ta) {
  // Build toolbar
  const bar = document.createElement('div');
  bar.className = 'dk-attn-bar';

  const btnMinus = document.createElement('button');
  btnMinus.textContent = '−';
  btnMinus.title = 'Weight −0.05';

  const weightLabel = document.createElement('span');
  weightLabel.className = 'dk-attn-weight';

  const btnPlus = document.createElement('button');
  btnPlus.textContent = '+';
  btnPlus.title = 'Weight +0.05';

  bar.appendChild(btnMinus);
  bar.appendChild(weightLabel);
  bar.appendChild(btnPlus);
  wrap.appendChild(bar);

  const updateWeightLabel = () => {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    let sel = ta.value.substring(s, e);
    // Also check surrounding parens
    if (!sel) {
      const enc = _findEnclosure(ta.value, s);
      if (enc) sel = ta.value.substring(enc.start, enc.end);
    }
    if (ta.value[s - 1] === '(' && ta.value[e] === ')') {
      sel = ta.value.substring(s - 1, e + 1);
    }
    const w = _parseCurrentWeight(sel);
    weightLabel.textContent = w !== null ? w.toFixed(2) : '';
  };

  const showBar = () => {
    bar.classList.add('dk-attn-visible');
    updateWeightLabel();
  };
  const hideBar = () => { bar.classList.remove('dk-attn-visible'); };

  // Show/hide based on selection
  const onSelChange = () => {
    if (document.activeElement !== ta) { hideBar(); return; }
    const has = ta.selectionStart !== ta.selectionEnd;
    if (has) showBar(); else hideBar();
  };
  document.addEventListener('selectionchange', onSelChange);

  // Button handlers (prevent losing selection)
  const handleBtn = (delta) => (e) => {
    e.preventDefault(); // keep focus on textarea
    const { newWeight } = applyAttentionEdit(ta, delta);
    if (newWeight !== null) {
      weightLabel.textContent = newWeight.toFixed(2);
      // Keep bar visible
      bar.classList.add('dk-attn-visible');
    }
  };
  btnMinus.addEventListener('mousedown', handleBtn(-ATTN_DELTA));
  btnMinus.addEventListener('touchstart', handleBtn(-ATTN_DELTA), { passive: false });
  btnPlus.addEventListener('mousedown', handleBtn(ATTN_DELTA));
  btnPlus.addEventListener('touchstart', handleBtn(ATTN_DELTA), { passive: false });

  return () => {
    document.removeEventListener('selectionchange', onSelChange);
    bar.remove();
  };
}

/* ═══ Prompt Syntax Highlighter ═══ */

/**
 * Highlight prompt syntax, returning HTML for the overlay layer.
 *
 * Coloring rules:
 *   - Comments  /* * /, //, # (line-start)  →  green  (only if commentsEnabled)
 *   - Wildcards __name__                    →  teal   (only if name is in validWildcards)
 *   - Emphasis  (...)  →  entire content uniformly colored per depth
 *     (nesting-span: open paren opens a <span>, close paren closes it)
 *   - Escaped \( \)  →  no depth change, no special color
 *   - Everything else  →  default text color
 *
 * @param {string} text
 * @param {{ commentsEnabled?: boolean, validWildcards?: Set<string>|null }} [opts]
 */
function highlightPromptSyntax(text, opts = {}) {
  const { commentsEnabled = true, validWildcards = null } = opts;
  let html = '';
  let i = 0;
  let depth = 0;
  const len = text.length;

  while (i < len) {
    // ── Block comment /* ... */  (must be closed) ──
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end !== -1) {
        const slice = escapeHTML(text.slice(i, end + 2));
        if (commentsEnabled) {
          html += `<span class="dk-hl-comment">${slice}</span>`;
        } else {
          html += slice;
        }
        i = end + 2; continue;
      }
    }
    // ── Line comment //  (must follow whitespace, comma, or start of text) ──
    if (text[i] === '/' && text[i + 1] === '/' &&
        (i === 0 || ' \t\n,'.includes(text[i - 1]))) {
      const nl = text.indexOf('\n', i);
      const ce = nl === -1 ? len : nl;
      const slice = escapeHTML(text.slice(i, ce));
      if (commentsEnabled) {
        html += `<span class="dk-hl-comment">${slice}</span>`;
      } else {
        html += slice;
      }
      i = ce; continue;
    }
    // ── Line comment # (start of line only) ──
    if (text[i] === '#') {
      let ls = i;
      while (ls > 0 && text[ls - 1] !== '\n') ls--;
      if (/^[ \t]*$/.test(text.slice(ls, i))) {
        const nl = text.indexOf('\n', i);
        const ce = nl === -1 ? len : nl;
        const slice = escapeHTML(text.slice(i, ce));
        if (commentsEnabled) {
          html += `<span class="dk-hl-comment">${slice}</span>`;
        } else {
          html += slice;
        }
        i = ce; continue;
      }
    }
    // ── Wildcard __name__ ──
    if (text[i] === '_' && text[i + 1] === '_') {
      const m = text.slice(i).match(/^__([^_]+(?:_[^_]+)*)__/);
      if (m) {
        const wcName = m[1];
        const escaped = escapeHTML(m[0]);
        if (validWildcards === null || validWildcards.has(wcName)) {
          html += `<span class="dk-hl-wc">${escaped}</span>`;
        } else {
          html += escaped;
        }
        i += m[0].length; continue;
      }
    }
    // ── Escaped chars \( \) \# \/  — skip, no special meaning ──
    if (text[i] === '\\' && '()#/'.includes(text[i + 1])) {
      html += escapeHTML(text.slice(i, i + 2));
      i += 2; continue;
    }
    // ── Open paren → open depth-colored span ──
    if (text[i] === '(') {
      depth++;
      html += `<span class="dk-hl-d${((depth - 1) % 5) + 1}">(`;
      i++; continue;
    }
    // ── Close paren → close depth-colored span ──
    if (text[i] === ')') {
      if (depth > 0) {
        html += ')</span>';
        depth--;
      } else {
        html += escapeHTML(')');
      }
      i++; continue;
    }
    // ── Plain text run ──
    let j = i + 1;
    while (j < len && !'/_\\()#'.includes(text[j])) j++;
    html += escapeHTML(text.slice(i, j));
    i = j;
  }

  // Close any unclosed spans (unmatched open parens)
  while (depth > 0) { html += '</span>'; depth--; }

  return html;
}

export class DeckGadget extends GadgetBase {
  /* ── Private fields ── */
  #executedHandler = null;
  #syncCompleteHandler = null;
  #seedModeHandler = null;
  #stale = true;
  #syncTimer = null;
  #showAllNodes = false;
  #contextMenu = null;
  #outputFingerprint = '';
  #lightboxItems = [];
  #groupMembershipFingerprint = '';
  #nodeGroupKeys = new Map();
  /** @type {Map<string, number>} Manually set textarea heights (nodeId:widgetName → px) */
  #textareaHeights = new Map();
  // Collapse state is stored in workflow.extra.comfyDrawer.deckCollapse
  /** @type {{ commentsEnabled: boolean, validWildcards: Set<string>|null }} */
  #hlOpts = { commentsEnabled: true, validWildcards: null };

  constructor() {
    super('deck', {
      label: 'Deck',
      icon: DECK_ICON,
      order: 2,
      cssUrl: new URL('./deck.css', import.meta.url).href,
    });
    this.editNodes = [];
    this.editGroups = [];  // [{title, key, color, nodes}, ...]
    this.bindings = [];
    this.#executedHandler = null;
    this.#stale = true;  // Dirty flag: graph changed since last render
    this.#syncTimer = null;  // Polling timer for graph → Deck sync
    this.#showAllNodes = false;
  }

  /* ═══ Lifecycle ═══ */

  onMount(container, bus, bridge) {
    this.#buildUI();

    // Cache contextMenu instance (see Gallery pattern)
    this.#contextMenu = window.ComfyDrawer?.contextMenu ?? null;

    // Register context menu for text output (PreviewAny etc.)
    this.#contextMenu?.register('deck-text', {
      id: 'deck:copy-text',
      label: 'Copy',
      icon: 'copy',
      order: 10,
      action: (ctx) => {
        // navigator.clipboard requires a secure context (https or localhost).
        // When accessed over plain http from LAN/mobile it will throw or be undefined.
        // Fall back to the legacy execCommand approach as a universal alternative.
        const text = ctx.text ?? '';
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).catch(() => copyViaExecCommand(text));
        } else {
          copyViaExecCommand(text);
        }
      },
    });

    // Register context menu for node sections (partial execution)
    this.#contextMenu?.register('deck-node', {
      id: 'deck:execute-node',
      label: 'Execute',
      icon: 'play',
      order: 10,
      // Hide Execute when the node is bypassed (mode 4)
      visible: (ctx) => {
        const n = bridge.getNodeById(parseInt(ctx.nodeId));
        return n ? n.mode !== 4 : true;
      },
      action: async (ctx) => {
        try {
          await bridge.queuePartial([String(ctx.nodeId)]);
        } catch (e) {
          console.error('[Deck] Partial execution failed:', e);
        }
      },
    });

    // API listeners live for the gadget's entire lifetime so that
    // executed events are never missed even when the tab is hidden.
    this.#attachAPIListeners();

    // Fetch highlight settings (non-blocking)
    this.#fetchHighlightOpts();

    // Re-fetch & refresh highlights when settings change
    this.addDisposable(bus.on('settings:highlight-changed', (payload) => {
      if (payload?.commentsEnabled !== undefined) {
        this.#hlOpts.commentsEnabled = payload.commentsEnabled;
      }
      this.#refreshAllHighlights();
    }));
  }

  onActivate() {
    // Always rescan: group membership may have changed on the canvas
    this.#scanNodes();
    this.#renderSections();
    this.#stale = false;
    // Start polling for external changes (canvas edits to widget values)
    this.#startSyncPolling();
    // Refresh highlight opts (comment toggle or wildcard list may have changed)
    this.#fetchHighlightOpts();
  }

  /** Fetch comment-enabled flag and valid wildcard names from backend. */
  async #fetchHighlightOpts() {
    try {
      const [cResp, wResp] = await Promise.all([
        fetch('/drawer/settings/comments-enabled'),
        fetch('/drawer/settings/wildcard-names'),
      ]);
      if (cResp.ok) {
        const { enabled } = await cResp.json();
        this.#hlOpts.commentsEnabled = enabled;
      }
      if (wResp.ok) {
        const { names } = await wResp.json();
        this.#hlOpts.validWildcards = new Set(names);
      }
    } catch { /* non-critical: keep defaults */ }

    // Re-render all existing highlight overlays with updated options
    this.#refreshAllHighlights();
  }

  /** Re-render every highlight overlay currently in the DOM. */
  #refreshAllHighlights() {
    const layers = this.container?.querySelectorAll('.dk-hl-layer');
    if (!layers) return;
    for (const hl of layers) {
      const ta = hl.parentElement?.querySelector('.dk-textarea');
      if (ta) hl.innerHTML = highlightPromptSyntax(ta.value, this.#hlOpts) + '\n';
    }
  }

  onDeactivate() {
    this.#stopSyncPolling();
  }

  onGraphChanged() {

    // If currently visible, re-render immediately.
    // Otherwise, mark stale for the next onActivate.
    if (this.container?.style.display !== 'none') {
      this.#scanNodes();
      this.#renderSections();
      this.#stale = false;
    } else {
      this.#stale = true;
    }
  }

  onDestroy() {
    this.#stopSyncPolling();
    this.#detachAPIListeners();
    this.#contextMenu?.unregisterByPrefix('deck:');
  }

  /* ═══ DOM Construction ═══ */

  #buildUI() {
    const c = this.container;
    c.innerHTML = `
      <div class="dk-toolbar">
        <button class="dk-toolbar-toggle" id="dk-toggle-nodes" title="Toggle: ✏️ marked / other nodes"></button>
        <div style="flex:1"></div>
        <button class="dk-btn-generate" id="dk-generate">${ICON_PLAY}<span>Run</span></button>
        <button class="dk-btn-cancel" id="dk-cancel" title="Interrupt">${ICON_X}</button>
      </div>
      <div class="dk-content" id="dk-content">
        <div id="dk-sections"></div>
        <div id="dk-output-body"></div>
      </div>
    `;

    // Generate / Cancel
    c.querySelector('#dk-generate').addEventListener('click', () => this.#generate());
    c.querySelector('#dk-cancel').addEventListener('click', () => {
      this.bus.emit('deck:cancel-requested');
      this.bridge.interrupt();
    });

    // Toggle: ✏️ marked nodes / other nodes
    const nodesBtn = c.querySelector('#dk-toggle-nodes');
    this.#updateNodesToggle(nodesBtn);
    nodesBtn.addEventListener('click', () => {
      this.#showAllNodes = !this.#showAllNodes;
      this.#updateNodesToggle(nodesBtn);
      this.#scanNodes();
      this.#renderSections();
    });
  }

  #updateNodesToggle(btn) {
    btn.innerHTML = this.#showAllNodes
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M22 2 2 22"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>`;
    btn.classList.toggle('active', this.#showAllNodes);
  }


  /* ═══ Node Scanning ═══ */

  #scanNodes() {
    this.editNodes = [];
    for (const node of this.bridge.allNodes) {
      const t = String(node.title || "");
      // Match bare 📝 only — escaped \📝 is a literal emoji, not a marker
      const hasMark = /(?<!\\)\u{1F4DD}/u.test(t);
      if (this.#showAllNodes) {
        if (!hasMark) this.editNodes.push(node);
      } else {
        if (hasMark) this.editNodes.push(node);
      }
    }

    // Build grouped structure
    const groups = this.bridge.getGroups();
    if (groups.length === 0) {
      // No groups → flat list, sort by Y position
      this.editNodes.sort(this.#posCmpY);
      this.editGroups = [{ title: null, key: '__flat__', color: null, nodes: this.editNodes }];
      this.#groupMembershipFingerprint = this.#computeGroupMembershipFingerprint();
      return;
    }

    // Sort groups by X coordinate (left → right), tiebreak by Y
    const sortedGroups = [...groups].sort((a, b) => {
      const ap = a._pos ?? a.pos ?? [0, 0];
      const bp = b._pos ?? b.pos ?? [0, 0];
      return (ap[0] - bp[0]) || (ap[1] - bp[1]);
    });

    // Assign edit nodes to groups (first match wins)
    const editSet = new Set(this.editNodes.map(n => n.id));
    const assigned = new Set();
    const result = [];

    for (const group of sortedGroups) {
      const nodesInGroup = this.bridge.getNodesInGroup(group)
        .filter(n => editSet.has(n.id) && !assigned.has(n.id));
      if (nodesInGroup.length === 0) continue;
      // Sort nodes within group by Y (top → bottom)
      nodesInGroup.sort(this.#posCmpY);
      for (const n of nodesInGroup) assigned.add(n.id);

      // Parse group title for ⚡ (toggle) or [name] (switch)
      const parsed = this.#parseGroupMarkers(group.title || 'Group');
      result.push({
        title: parsed.displayTitle,
        key: `group-${group.title}`,
        color: group.color || null,
        nodes: nodesInGroup,
        isToggle: parsed.isToggle,
        switchName: parsed.switchName,
        allNodeIds: this.bridge.getNodesInGroup(group).map(n => n.id),
      });
    }

    // Ungrouped nodes at the end, sorted by Y
    const ungrouped = this.editNodes.filter(n => !assigned.has(n.id));
    if (ungrouped.length > 0) {
      ungrouped.sort(this.#posCmpY);
      result.push({ title: null, key: '__ungrouped__', color: null, nodes: ungrouped });
    }

    this.editGroups = result;
    // Keep flat list for compatibility (refresh checks, output, etc.)
    this.editNodes = result.flatMap(g => g.nodes);
    this.#groupMembershipFingerprint = this.#computeGroupMembershipFingerprint();
  }

  #getEligibleEditNodeIds() {
    const ids = new Set();
    for (const node of this.bridge.allNodes) {
      const hasMark = /(?<!\\)\u{1F4DD}/u.test(String(node.title || ''));
      if (this.#showAllNodes) {
        if (!hasMark) ids.add(node.id);
      } else {
        if (hasMark) ids.add(node.id);
      }
    }
    return ids;
  }

  #computeGroupMembershipFingerprint() {
    const groups = this.bridge.getGroups();
    const editSet = this.#getEligibleEditNodeIds();
    if (groups.length === 0) {
      return `flat:${[...editSet].sort((a, b) => Number(a) - Number(b)).join(',')}`;
    }

    const sortedGroups = [...groups].sort((a, b) => {
      const ap = a._pos ?? a.pos ?? [0, 0];
      const bp = b._pos ?? b.pos ?? [0, 0];
      return (ap[0] - bp[0]) || (ap[1] - bp[1]);
    });

    const assigned = new Set();
    const parts = [];
    for (const group of sortedGroups) {
      const ids = this.bridge.getNodesInGroup(group)
        .filter(n => editSet.has(n.id) && !assigned.has(n.id))
        .map(n => Number(n.id))
        .sort((a, b) => a - b);
      for (const id of ids) assigned.add(id);
      const b = group._bounding ?? group.bounding ?? [];
      parts.push(`${group.title || ''}@${b[0] ?? ''},${b[1] ?? ''}:${ids.join(',')}`);
    }

    const ungrouped = [...editSet]
      .map(id => Number(id))
      .filter(id => !assigned.has(id))
      .sort((a, b) => a - b);
    parts.push(`__ungrouped__:${ungrouped.join(',')}`);
    return parts.join('|');
  }

  /** Sort by Y position (top → bottom), tiebreak by X */
  #posCmpY = (a, b) => {
    const ay = a.pos?.[1] ?? 0, by = b.pos?.[1] ?? 0;
    return (ay - by) || ((a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0));
  };

  /**
   * Clean a node title for display in Deck:
   *   - Remove the 📝 edit-mode marker and ⚡ toggle marker (Deck internals)
   *   - Unescape \<emoji> sequences → display the emoji literally
   *   - All other emoji are preserved as-is
   */
  #cleanTitle(title) {
    return cleanDrawerTitle(title);
  }

  /**
   * Parse group title for toggle/switch markers.
   *   ⚡ Detailer       → { displayTitle: 'Detailer', isToggle: true, switchName: null }
   *   [upscale] ESRGAN  → { displayTitle: 'ESRGAN',   isToggle: false, switchName: 'upscale' }
   *   Prompts           → { displayTitle: 'Prompts',  isToggle: false, switchName: null }
   */
  #parseGroupMarkers(rawTitle) {
    return parseDrawerGroupMarkers(rawTitle);
  }

  #parseNodeMarkers(rawTitle) {
    return parseDrawerNodeMarkers(rawTitle);
  }

  #createBypassToggle({ labelText, checked, onChange, exclusive = false }) {
    const toggleEl = document.createElement('label');
    toggleEl.className = `dk-bypass-toggle ${exclusive ? 'dk-exclusive-toggle' : 'dk-group-toggle'}`;
    toggleEl.addEventListener('click', (e) => e.stopPropagation());

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;

    const label = document.createElement('span');
    label.className = 'dk-bypass-label';

    const knob = document.createElement('span');
    knob.className = 'dk-bypass-knob';

    const syncLabel = () => {
      label.textContent = exclusive
        ? labelText
        : (input.checked ? 'Active' : 'Bypass');
    };

    input.addEventListener('change', () => {
      onChange(input.checked, input);
      syncLabel();
    });
    syncLabel();
    toggleEl.append(input, label, knob);
    return { toggleEl, input };
  }

  #createExclusiveToggle(labelText, checked, onChange) {
    return this.#createBypassToggle({ labelText, checked, onChange, exclusive: true });
  }

  #createStateToggle(checked, onChange) {
    return this.#createBypassToggle({ labelText: '', checked, onChange, exclusive: false });
  }

  #syncBypassToggleLabel(input) {
    const toggleEl = input?.closest('.dk-bypass-toggle');
    if (!toggleEl || toggleEl.classList.contains('dk-exclusive-toggle')) return;
    const label = toggleEl.querySelector('.dk-bypass-label');
    if (label) label.textContent = input.checked ? 'Active' : 'Bypass';
  }

  /* ═══ Collapse State (persisted in workflow.extra) ═══ */

  /**
   * Boost a hex color's lightness so it's visible on the dark Deck background.
   * Ensures minimum lightness of 55% in HSL space.
   */
  #boostColor(hex) {
    try {
      let h = hex.replace('#', '');
      // Expand shorthand (#88A → #8888AA)
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      const r = parseInt(h.slice(0,2),16)/255;
      const g = parseInt(h.slice(2,4),16)/255;
      const b = parseInt(h.slice(4,6),16)/255;
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      let hue = 0, sat = 0, lit = (max+min)/2;
      if (max !== min) {
        const d = max - min;
        sat = lit > 0.5 ? d/(2-max-min) : d/(max+min);
        if (max === r) hue = ((g-b)/d + (g<b?6:0))/6;
        else if (max === g) hue = ((b-r)/d+2)/6;
        else hue = ((r-g)/d+4)/6;
      }
      // Enforce minimum lightness and saturation
      lit = Math.max(lit, 0.55);
      sat = Math.max(sat, 0.5);
      // HSL → RGB
      const hue2rgb = (p,q,t) => { if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p; };
      const q2 = lit < 0.5 ? lit*(1+sat) : lit+sat-lit*sat;
      const p2 = 2*lit-q2;
      const ro = Math.round(hue2rgb(p2,q2,hue+1/3)*255);
      const go = Math.round(hue2rgb(p2,q2,hue)*255);
      const bo = Math.round(hue2rgb(p2,q2,hue-1/3)*255);
      return `#${ro.toString(16).padStart(2,'0')}${go.toString(16).padStart(2,'0')}${bo.toString(16).padStart(2,'0')}`;
    } catch { return hex; }
  }

  /** Read collapse state — default is collapsed (true). */
  #collapseGet(key) {
    const map = this.bridge.getWorkflowExtra('deckExpand', {});
    // Key present → expanded (not collapsed)
    return !map[key];
  }

  /** Save collapse state — stores expanded items in deckExpand. */
  #collapseSave(key, collapsed) {
    const map = this.bridge.getWorkflowExtra('deckExpand', {});
    if (!collapsed) map[key] = true; else delete map[key];
    this.bridge.setWorkflowExtra('deckExpand', map);
  }

  /* ═══ Bypass State — "OFF wins" model (persisted in workflow.extra) ═══ */
  /*
   * Two independent layers of bypass:
   *   1. Group-level:  deckGroupOff = { groupKey: true }
   *   2. Node-level:   deckNodeOff  = { nodeId: true }
   *
   * Effective mode = (groupOff || nodeOff) ? 4 (bypass) : 0 (active)
   *
   * OFF always wins — a node is active only when BOTH its group
   * AND its individual toggle are ON.
   */

  #isGroupOff(groupKey) {
    return !!this.bridge.getWorkflowExtra('deckGroupOff', {})[groupKey];
  }

  #setGroupOff(groupKey, off) {
    const map = this.bridge.getWorkflowExtra('deckGroupOff', {});
    if (off) map[groupKey] = true; else delete map[groupKey];
    this.bridge.setWorkflowExtra('deckGroupOff', map);
  }

  #getGroupExclusive() {
    return this.bridge.getWorkflowExtra('deckGroupExclusive', {});
  }

  #setGroupExclusive(label, groupKey) {
    const map = this.#getGroupExclusive();
    map[label] = groupKey;
    this.bridge.setWorkflowExtra('deckGroupExclusive', map);
  }

  #clearGroupExclusive(label) {
    const map = this.#getGroupExclusive();
    map[label] = null;
    this.bridge.setWorkflowExtra('deckGroupExclusive', map);
  }

  #getNodeExclusive() {
    return this.bridge.getWorkflowExtra('deckNodeExclusive', {});
  }

  #setNodeExclusive(label, nodeId) {
    const map = this.#getNodeExclusive();
    map[label] = nodeId;
    this.bridge.setWorkflowExtra('deckNodeExclusive', map);
  }

  #clearNodeExclusive(label) {
    const map = this.#getNodeExclusive();
    map[label] = null;
    this.bridge.setWorkflowExtra('deckNodeExclusive', map);
  }

  #isGroupExclusiveSelected(group) {
    return !!group?.switchName && this.#getGroupExclusive()[group.switchName] === group.key;
  }

  #isNodeExclusiveSelected(node, parsedTitle = null) {
    const parsed = parsedTitle || this.#parseNodeMarkers(node?.title || node?.type);
    const key = this.#getNodeExclusiveKey(node, parsed);
    return !!key && Number(this.#getNodeExclusive()[key]) === Number(node?.id);
  }

  #isGroupActive(group) {
    if (!group) return false;
    if (group.switchName) return this.#isGroupExclusiveSelected(group);
    return !this.#isGroupOff(group.key);
  }

  #getGroupNodeIds(group) {
    return [...new Set([
      ...(group?.allNodeIds || []),
      ...(group?.nodes || []).map(n => n.id),
    ])];
  }

  #isNodeOff(nodeId) {
    return !!this.bridge.getWorkflowExtra('deckNodeOff', {})[nodeId];
  }

  #setNodeOff(nodeId, off) {
    const map = this.bridge.getWorkflowExtra('deckNodeOff', {});
    if (off) map[nodeId] = true; else delete map[nodeId];
    this.bridge.setWorkflowExtra('deckNodeOff', map);
  }

  /**
   * Apply effective modes for all nodes in a group.
   * effective = (groupOff || nodeOff) ? 4 : 0
   * Uses the proven setNodesModes batch approach.
   */
  #applyGroupModes(group) {
    const groupOff = group.switchName
      ? !this.#isGroupExclusiveSelected(group)
      : this.#isGroupOff(group.key);
    const nodeIds = this.#getGroupNodeIds(group);
    if (groupOff) {
      // Group is OFF → everything bypassed, simple batch
      this.bridge.setNodesModes(nodeIds, 4);
    } else {
      // Group is ON → activate all first, then re-bypass individually-off nodes
      this.bridge.setNodesModes(nodeIds, 0);
      for (const id of nodeIds) {
        if (this.#isNodeOff(id)) {
          this.bridge.setNodeMode(id, 4);
        }
      }
    }
  }

  /**
   * Sync individual node ⚡ toggle checkboxes within a group to match
   * the effective mode (not just actual mode, but respecting OFF-wins).
   */
  #syncNodeTogglesInGroup(groupKey) {
    const groupEl = this.#getGroupElement(groupKey);
    if (!groupEl) return;
    const sections = groupEl.querySelectorAll('.dk-section[data-node-id]');
    for (const sec of sections) {
      const nodeId = parseInt(sec.dataset.nodeId);
      const node = this.bridge.getNodeById(nodeId);
      const parsed = this.#parseNodeMarkers(node?.title || node?.type);
      const mode = this.bridge.getNodeMode(nodeId);
      const nodeToggle = sec.querySelector('.dk-section-header .dk-group-toggle input, .dk-section-header .dk-exclusive-toggle input');
      if (nodeToggle) {
        const toggleWrap = nodeToggle.closest('.dk-exclusive-toggle, .dk-group-toggle');
        const blockedByGroup = this.#isNodeBlockedByGroup(node.id);
        if (toggleWrap?.classList.contains('dk-bypass-toggle')) {
          toggleWrap.classList.toggle('blocked', blockedByGroup);
          nodeToggle.disabled = !!blockedByGroup;
        }
        nodeToggle.checked = parsed.switchName
          ? this.#isNodeExclusiveSelected(node, parsed) && !blockedByGroup
          : (mode === 0) && !blockedByGroup;
        this.#syncBypassToggleLabel(nodeToggle);
      }
    }
  }

  #getGroupElement(groupKey) {
    const groups = this.container?.querySelectorAll('.dk-group[data-group-key]') || [];
    return [...groups].find(el => el.dataset.groupKey === groupKey) || null;
  }

  #setExclusiveGroupActive(targetGroup, active) {
    if (!targetGroup?.switchName) return;
    if (!active) {
      this.#clearGroupExclusive(targetGroup.switchName);
      for (const group of this.editGroups) {
        if (group.switchName !== targetGroup.switchName) continue;
        this.#applyGroupModes(group);
        const groupInput = this.#getGroupElement(group.key)
          ?.querySelector(':scope > .dk-group-header .dk-exclusive-toggle input');
        if (groupInput) groupInput.checked = false;
        this.#syncNodeTogglesInGroup(group.key);
      }
      this.#syncDeckToggleControls();
      return;
    }

    this.#setGroupExclusive(targetGroup.switchName, targetGroup.key);

    for (const group of this.editGroups) {
      if (group.switchName !== targetGroup.switchName) continue;
      const shouldBeActive = group.key === targetGroup.key;
      this.#applyGroupModes(group);

      const groupInput = this.#getGroupElement(group.key)
        ?.querySelector(':scope > .dk-group-header .dk-exclusive-toggle input');
      if (groupInput) groupInput.checked = shouldBeActive;
      this.#syncNodeTogglesInGroup(group.key);
    }
    this.#normalizeExclusiveSelections();
    this.#syncDeckToggleControls();
  }

  #syncDeckToggleControls() {
    const groupEls = this.container?.querySelectorAll('.dk-group[data-group-key]');
    for (const groupEl of groupEls || []) {
      const key = groupEl.dataset.groupKey;
      const group = this.editGroups.find(g => g.key === key);
      if (!group) continue;
      const groupToggle = groupEl.querySelector(':scope > .dk-group-header .dk-group-toggle input, :scope > .dk-group-header .dk-exclusive-toggle input');
      if (groupToggle) {
        groupToggle.checked = this.#isGroupActive(group);
        this.#syncBypassToggleLabel(groupToggle);
      }
    }

    const sections = this.container?.querySelectorAll('.dk-section[data-node-id]');
    for (const sec of sections || []) {
      const nodeId = parseInt(sec.dataset.nodeId);
      const node = this.bridge.getNodeById(nodeId);
      if (!node) continue;
      const parsed = this.#parseNodeMarkers(node.title || node.type);
      const mode = this.bridge.getNodeMode(nodeId);
      const nodeToggle = sec.querySelector('.dk-section-header .dk-group-toggle input, .dk-section-header .dk-exclusive-toggle input');
      if (!nodeToggle) continue;
      const toggleWrap = nodeToggle.closest('.dk-exclusive-toggle, .dk-group-toggle');
      const blockedByGroup = this.#isNodeBlockedByGroup(node.id);
      if (toggleWrap?.classList.contains('dk-bypass-toggle')) {
        toggleWrap.classList.toggle('blocked', blockedByGroup);
        nodeToggle.disabled = !!blockedByGroup;
      }
      nodeToggle.checked = parsed.switchName
        ? this.#isNodeExclusiveSelected(node, parsed) && !blockedByGroup
        : (mode === 0) && !blockedByGroup;
      this.#syncBypassToggleLabel(nodeToggle);
    }
  }

  #getParentGroup(nodeId) {
    const key = this.#nodeGroupKeys.get(Number(nodeId));
    if (key) return this.editGroups.find(g => g.key === key) || null;
    return this.editGroups.find(g => g.nodes?.some(n => n.id === nodeId)) || null;
  }

  #getNodeExclusiveKey(node, parsedTitle = null) {
    const parsed = parsedTitle || this.#parseNodeMarkers(node?.title || node?.type);
    if (!parsed.switchName || !node) return null;
    const group = this.#getParentGroup(node.id);
    return `${group?.key || '__ungrouped__'}::${parsed.switchName}`;
  }

  #isNodeBlockedByGroup(nodeId) {
    const group = this.#getParentGroup(nodeId);
    if (!group) return false;
    if (group.switchName) return !this.#isGroupExclusiveSelected(group);
    return this.#isGroupOff(group.key);
  }

  #normalizeExclusiveSelections({ applyModes = true } = {}) {
    const groupExclusive = this.#getGroupExclusive();
    const groupsByLabel = new Map();
    for (const group of this.editGroups) {
      if (!group.switchName) continue;
      if (!groupsByLabel.has(group.switchName)) groupsByLabel.set(group.switchName, []);
      groupsByLabel.get(group.switchName).push(group);
    }

    for (const [label, groups] of groupsByLabel) {
      const saved = groupExclusive[label];
      if (saved === null) continue;
      const savedGroup = groups.find(g => g.key === saved);
      const activeGroups = groups.filter(g =>
        this.#getGroupNodeIds(g).some(id => this.bridge.getNodeMode(id) === 0)
      );
      const savedActive = savedGroup && activeGroups.some(g => g.key === savedGroup.key);
      const selected = savedActive ? savedGroup : (activeGroups[0] || savedGroup || groups[0]);
      if (selected) groupExclusive[label] = selected.key;
    }
    this.bridge.setWorkflowExtra('deckGroupExclusive', groupExclusive);

    const nodeExclusive = this.#getNodeExclusive();
    const nodesByLabel = new Map();
    for (const node of this.editNodes) {
      const parsed = this.#parseNodeMarkers(node.title || node.type);
      if (!parsed.switchName) continue;
      const key = this.#getNodeExclusiveKey(node, parsed);
      if (!key) continue;
      if (!nodesByLabel.has(key)) nodesByLabel.set(key, []);
      nodesByLabel.get(key).push(node);
    }

    for (const [key, nodes] of nodesByLabel) {
      const savedId = Number(nodeExclusive[key]);
      if (nodeExclusive[key] === null) continue;
      const savedNode = nodes.find(n => Number(n.id) === savedId);
      const activeNode = nodes.find(n => this.bridge.getNodeMode(n.id) === 0);
      const savedActive = savedNode && this.bridge.getNodeMode(savedNode.id) === 0;
      const selected = savedActive ? savedNode : (activeNode || savedNode || nodes[0]);
      if (selected) nodeExclusive[key] = selected.id;
    }
    this.bridge.setWorkflowExtra('deckNodeExclusive', nodeExclusive);

    if (!applyModes) return;

    for (const groups of groupsByLabel.values()) {
      for (const group of groups) this.#applyGroupModes(group);
    }

    for (const nodes of nodesByLabel.values()) {
      for (const node of nodes) {
        const parsed = this.#parseNodeMarkers(node.title || node.type);
        const selected = this.#isNodeExclusiveSelected(node, parsed);
        const blockedByGroup = this.#isNodeBlockedByGroup(node.id);
        this.bridge.setNodeMode(node.id, selected && !blockedByGroup ? 0 : 4);
      }
    }
  }

  /* ═══ Section Rendering ═══ */

  #renderSections() {
    const container = this.container.querySelector('#dk-sections');
    if (!container) return;

    const scrollParent = container.closest('.dk-content');
    const savedScroll = scrollParent?.scrollTop ?? 0;

    // Build new content entirely off-screen in a DocumentFragment.
    // The old content stays visible until the atomic swap at the end,
    // preventing any visual flicker or scroll jump.
    const frag = document.createDocumentFragment();
    this.bindings = [];
    this.#nodeGroupKeys = new Map();
    for (const group of this.editGroups) {
      for (const node of group.nodes || []) {
        if (group.key !== '__ungrouped__' && group.key !== '__flat__') {
          this.#nodeGroupKeys.set(Number(node.id), group.key);
        }
      }
    }
    this.#normalizeExclusiveSelections();

    let rendered = 0;
    const hasGroups = this.editGroups.some(g => g.title !== null);
    this.#lightboxItems = [];  // Shared lightbox items for cross-node browsing
    const sharedLbItems = this.#lightboxItems;

    for (const group of this.editGroups) {
      if (group.nodes.length === 0) continue;

      if (hasGroups && group.title) {
        // ── Grouped section with collapsible container ──
        const groupEl = document.createElement('div');
        groupEl.className = 'dk-group';
        groupEl.dataset.groupKey = group.key;

        const gHeader = document.createElement('div');
        gHeader.className = 'dk-group-header';
        const boosted = group.color ? this.#boostColor(group.color) : null;
        if (boosted) {
          gHeader.style.background = `${boosted}40`;  // ~25% opacity tint
          gHeader.style.setProperty('--dk-group-title-color', boosted);
        }
        const collapseKey = group.key;

        // Build header content
        const titleSpan = document.createElement('span');
        titleSpan.className = 'dk-group-title';
        titleSpan.textContent = group.title;

        const rightSide = document.createElement('span');
        rightSide.className = 'dk-group-right';

        // Toggle / Switch UI
        if (group.isToggle || group.switchName) {
          // Check if any group node is active (not bypassed)
          const isActive = this.#isGroupActive(group);

          if (group.switchName) {
            const { toggleEl } = this.#createExclusiveToggle(group.switchName, isActive, (checked, checkbox) => {
              this.#setExclusiveGroupActive(group, checked);
              checkbox.checked = checked;
            });
            rightSide.appendChild(toggleEl);
          } else {
          const { toggleEl, input: checkbox } = this.#createStateToggle(isActive, () => {
            // Update group state
            this.#setGroupOff(group.key, !checkbox.checked);
            // Apply effective modes for all nodes in this group
            this.#applyGroupModes(group);
            this.#normalizeExclusiveSelections();
            // Sync individual toggles to match
            this.#syncNodeTogglesInGroup(group.key);
          });
          checkbox.addEventListener('change', () => {
            this.#syncBypassToggleLabel(checkbox);
          });

          rightSide.appendChild(toggleEl);
          }
        }

        const arrow = document.createElement('span');
        arrow.className = 'dk-collapse-arrow';
        rightSide.appendChild(arrow);

        gHeader.append(titleSpan, rightSide);
        gHeader.addEventListener('click', () => {
          groupEl.classList.toggle('collapsed');
          this.#collapseSave(collapseKey, groupEl.classList.contains('collapsed'));
        });
        if (this.#collapseGet(collapseKey)) groupEl.classList.add('collapsed');
        groupEl.appendChild(gHeader);

        const gBody = document.createElement('div');
        gBody.className = 'dk-group-body';
        for (const node of group.nodes) {
          const sec = this.#buildNodeSection(node, sharedLbItems);
          if (sec) { gBody.appendChild(sec); rendered++; }
        }
        groupEl.appendChild(gBody);
        if (gBody.childElementCount > 0) frag.appendChild(groupEl);
      } else {
        // ── Flat / ungrouped nodes ──
        if (hasGroups && group.nodes.length > 0) {
          // Show divider label for ungrouped when groups exist
          const divider = document.createElement('div');
          divider.className = 'dk-group-divider';
          divider.textContent = 'Others';
          frag.appendChild(divider);
        }
        for (const node of group.nodes) {
          const sec = this.#buildNodeSection(node, sharedLbItems);
          if (sec) { frag.appendChild(sec); rendered++; }
        }
      }
    }

    if (rendered === 0) {
      const msg = document.createElement('div');
      msg.className = 'dk-empty-msg';
      msg.textContent = this.#showAllNodes
        ? 'No visible nodes'
        : '📝 Add an emoji to a node title to show it here';
      frag.appendChild(msg);
    }

    // Atomic swap: old content is replaced in a single DOM operation.
    // The browser does one reflow — no intermediate "empty" state.
    container.replaceChildren(frag);

    // Restore scroll position and auto-size textareas
    if (scrollParent) scrollParent.scrollTop = savedScroll;
    this.#rebuildLightboxRefsFromDom();
    this.#autoSizeAllTextareas();
    this.#syncDeckToggleControls();
  }

  #rebuildLightboxRefsFromDom() {
    const root = this.container?.querySelector('#dk-sections');
    if (!root) return;

    const items = [];
    const cards = root.querySelectorAll('.mc-card');
    for (const card of cards) {
      const ref = card._lbRef;
      if (!ref?.items || !Number.isInteger(ref.index)) continue;
      const sourceItem = ref.items[ref.index];
      if (!sourceItem?.src) continue;

      const index = items.length;
      items.push({ ...sourceItem });
      card._lbRef = { items, index };

      const loadImageSlot = card.closest('.dk-loadimage-preview-slot');
      if (loadImageSlot) loadImageSlot._lbRef = card._lbRef;
    }

    this.#lightboxItems = items;
  }

  /** Auto-size all textareas to fit content (unless manually resized).
   *  Uses batched read/write passes to avoid layout thrashing. */
  #autoSizeAllTextareas() {
    // Pass 1: collect targets and reset heights (write-only)
    const targets = [];
    for (const b of this.bindings) {
      if (b.type !== 'text' || b.el.tagName !== 'TEXTAREA') continue;
      const key = `${b.nodeId ?? b.widget?.nodeId ?? ''}:${b.widget.name}`;
      if (this.#textareaHeights.has(key)) continue;  // manually resized
      b.el.style.height = 'auto';
      targets.push(b.el);
    }
    // Pass 2: read all scrollHeights (single forced reflow)
    const heights = targets.map(ta => Math.max(70, ta.scrollHeight));
    // Pass 3: apply heights (write-only, no reflow)
    for (let i = 0; i < targets.length; i++) {
      targets[i].style.height = heights[i] + 'px';
      const hl = targets[i].closest('.dk-textarea-wrap')?.querySelector('.dk-hl-layer');
      if (hl) hl.style.height = heights[i] + 'px';
    }
  }

  /* ═══ Node Section Builder ═══ */

  #buildNodeSection(node, sharedLbItems) {
    const sec = document.createElement('div');
    sec.className = 'dk-section';
    sec.dataset.nodeId = String(node.id);
    sec.dataset.rawTitle = String(node.title || node.type || '');

    const header = document.createElement('div');
    header.className = 'dk-section-header';
    const collapseKey = `node-${node.id}`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'dk-section-title';
    const parsedTitle = this.#parseNodeMarkers(node.title || node.type);
    titleSpan.textContent = parsedTitle.displayTitle;

    const rightSide = document.createElement('span');
    rightSide.className = 'dk-group-right';

    // Individual node toggle:
    //   [label] = exclusive node toggle
    //   ⚡      = standalone bypass toggle
    const nodeTitle = String(node.title || '');
    if (parsedTitle.switchName) {
      const isSelected = this.#isNodeExclusiveSelected(node, parsedTitle)
        && !this.#isNodeBlockedByGroup(node.id);
      const { toggleEl } = this.#createExclusiveToggle(parsedTitle.switchName, isSelected, (checked, checkbox) => {
        if (this.#isNodeBlockedByGroup(node.id)) {
          checkbox.checked = false;
          return;
        }
        const exclusiveKey = this.#getNodeExclusiveKey(node, parsedTitle);
        if (!exclusiveKey) return;
        if (!checked) {
          this.#clearNodeExclusive(exclusiveKey);
          for (const other of this.editNodes) {
            const otherParsed = this.#parseNodeMarkers(other.title || other.type);
            if (this.#getNodeExclusiveKey(other, otherParsed) !== exclusiveKey) continue;
            this.bridge.setNodeMode(other.id, 4);
            const otherEl = this.container?.querySelector(`.dk-section[data-node-id="${other.id}"] .dk-exclusive-toggle input`);
            if (otherEl) otherEl.checked = false;
          }
          this.#syncDeckToggleControls();
          return;
        }
        this.#setNodeExclusive(exclusiveKey, node.id);

        for (const other of this.editNodes) {
          const otherParsed = this.#parseNodeMarkers(other.title || other.type);
          if (this.#getNodeExclusiveKey(other, otherParsed) !== exclusiveKey) continue;
          const selected = other.id === node.id;
          const blockedByGroup = this.#isNodeBlockedByGroup(other.id);
          this.bridge.setNodeMode(other.id, selected && !blockedByGroup ? 0 : 4);
          const otherEl = this.container?.querySelector(`.dk-section[data-node-id="${other.id}"] .dk-exclusive-toggle input`);
          if (otherEl) otherEl.checked = selected && !blockedByGroup;
        }
        this.#syncDeckToggleControls();
      });
      rightSide.appendChild(toggleEl);
    } else if (/(?<!\\)\u26A1/u.test(nodeTitle)) {
      const { toggleEl, input: checkbox } = this.#createStateToggle(node.mode === 0, () => {
        // Update individual node bypass state
        this.#setNodeOff(node.id, !checkbox.checked);

        // Effective mode: OFF wins
        if (this.#isNodeBlockedByGroup(node.id) || !checkbox.checked) {
          this.bridge.setNodeMode(node.id, 4);
          checkbox.checked = false;  // Visual: must be OFF if group is OFF
          this.#syncBypassToggleLabel(checkbox);
        } else {
          this.bridge.setNodeMode(node.id, 0);
        }
      });
      checkbox.addEventListener('change', () => {
        this.#syncBypassToggleLabel(checkbox);
      });
      rightSide.appendChild(toggleEl);
    }

    const arrow = document.createElement('span');
    arrow.className = 'dk-collapse-arrow';
    rightSide.appendChild(arrow);

    header.append(titleSpan, rightSide);
    header.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      this.#collapseSave(collapseKey, sec.classList.contains('collapsed'));
    });
    // Default to collapsed; only expand if user explicitly expanded it
    if (this.#collapseGet(collapseKey)) {
      sec.classList.add('collapsed');
    }
    sec.appendChild(header);

    // Output node: visual pip indicator + context menu
    const ctxMenu = this.#contextMenu;
    if (this.bridge.isOutputNode(node)) {
      sec.classList.add('dk-section--output');
      // Small triangle indicator before the title — marks this as an output node
      const pip = document.createElement('span');
      pip.className = 'dk-output-pip';
      pip.title = 'Output node — right-click to execute';
      titleSpan.prepend(pip);
      // Attach context menu trigger
      if (ctxMenu) {
        ContextMenuService.attachTrigger(header, (e) => {
          ctxMenu.show('deck-node', { nodeId: node.id }, e.clientX, e.clientY);
        });
      }
    }

    const body = document.createElement('div');
    body.className = 'dk-section-body';
    let hasContent = false;

    // Special: Drawer Seed
    const nodeType = String(node.type || '');
    if (nodeType === 'DrawerSeed') {
      hasContent = this.#buildSeedWidget(node, body);
    }
    // Special: compact multi-control node (DrawerControls)
    else if (isDrawerControlsNode(node)) {
      hasContent = this.#buildControlsWidget(node, body);
    }
    // Special: Size node (DrawerSize)
    else if (nodeType === 'DrawerSize') {
      hasContent = this.#buildSizeWidget(node, body);
    }
    // Special: PreviewAny — skip widgets (display-only duplicates of output)
    // The output text from #buildNodeOutput below handles display.
    else if (nodeType === 'PreviewAny') {
      // no widgets — output-only node
    }
    // Special: Note / Markdown — read-only display, no widget labels
    else if (nodeType === 'Note' || nodeType === 'MarkdownNote') {
      const text = node.widgets?.[0]?.value ?? '';
      if (text.trim()) {
        hasContent = true;
        const el = document.createElement('div');
        el.className = 'dk-note-display';
        if (nodeType === 'MarkdownNote') {
          el.innerHTML = this.#renderMarkdown(text);
          // Open links in new tab
          el.querySelectorAll('a').forEach(a => {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
          });
        } else {
          el.textContent = text;
          el.style.whiteSpace = 'pre-wrap';
        }
        body.appendChild(el);
      }
    }
    // Normal widgets
    else {
      const linkedInputs = getLinkedInputNames(node);
      const widgets = (node.widgets || []).filter(
        w => !SKIP_WIDGET_TYPES.has(w.type) && !w.hidden
          && !linkedInputs.has(w.name) && !w.name?.startsWith('$$')
      );
      for (const w of widgets) {
        body.appendChild(this.#buildWidget(w, node));
        hasContent = true;
      }
    }

    // LoadVideo (ComfyCore): generate initial MediaCard from selected input file
    const nodeOutput = this.bridge.nodeOutputs?.[String(node.id)];
    if (node.type === 'LoadVideo') {
      const fileW = (node.widgets || []).find(w => w.name === 'file');
      if (fileW && fileW.value) {
        const parts = String(fileW.value).split('/');
        const vFilename = parts.pop();
        const vSubfolder = parts.join('/');
        const vUrl = this.bridge.getImageUrl(vFilename, vSubfolder, 'input', { bustCache: true });
        const vTitle = this.#cleanTitle(node.title || node.type);
        const ctxMenu = this.#contextMenu;
        const lbItems = sharedLbItems || [];
        const lbIdx = lbItems.length;
        lbItems.push({
          src: vUrl, type: 'video', label: `${vTitle} — ${vFilename}`,
          name: vFilename, subfolder: vSubfolder, source: 'input',
        });
        const card = createMediaCard({
          src: vUrl, filename: vFilename, subfolder: vSubfolder,
          type: 'input', mediaType: 'video', thumbHeight: null,
          lazy: false,
          lightboxItems: lbItems, lightboxIndex: lbIdx,
          onContextMenu: ctxMenu ? (e) => {
            const el = e.currentTarget;
            ctxMenu.show('media-file', {
              src: vUrl, type: 'video', name: vFilename,
              subfolder: vSubfolder, source: 'input',
              hasWorkflow: el._hasWorkflow,
            }, e.clientX, e.clientY);
          } : null,
        });
        card.element.classList.add('dk-output-item');
        body.appendChild(card.element);
        hasContent = true;
      }
    }
    // LoadAudio (ComfyCore): generate initial audio player from selected input file
    if (node.type === 'LoadAudio') {
      const audioW = (node.widgets || []).find(w => w.name === 'audio');
      if (audioW && audioW.value) {
        const parts = String(audioW.value).split('/');
        const aFilename = parts.pop();
        const aSubfolder = parts.join('/');
        const aUrl = this.bridge.getImageUrl(aFilename, aSubfolder, 'input', { bustCache: true });
        const item = document.createElement('div');
        item.className = 'dk-output-item';
        const audio = document.createElement('audio');
        audio.src = aUrl;
        audio.controls = true;
        audio.preload = 'metadata';
        audio.style.width = '100%';
        item.appendChild(audio);
        body.appendChild(item);
        hasContent = true;
      }
    }
    // LoadImage / LoadImageMask: show the selected input file as a widget-bound
    // preview. Do not also render nodeOutputs for these nodes; their output is
    // the same selected image and would duplicate the card.
    if (this.#isLoadImageNode(node)) {
      const slot = this.#ensureLoadImagePreviewSlot(body);
      this.#renderLoadImagePreview(node, slot, sharedLbItems, true);
      this.#removeLegacyLoadImagePreviewItems(body, slot);
      hasContent = true;
    }

    // Inline output display for this node (skip loader nodes handled above)
    if (nodeOutput && node.type !== 'LoadVideo' && node.type !== 'LoadAudio'
      && !this.#isLoadImageNode(node)) {
      const outputContent = this.#buildNodeOutput(node, nodeOutput, sharedLbItems);
      if (outputContent) {
        body.appendChild(outputContent);
        hasContent = true;
      }
    }

    // Always show the section — even empty nodes serve as output placeholders
    sec.appendChild(body);
    return sec;
  }

  #isLoadImageNode(node) {
    return node?.type === 'LoadImage' || node?.type === 'LoadImageMask';
  }

  #getLoadImageWidget(node) {
    return (node?.widgets || []).find(w => w.name === 'image' || w.name === 'Image');
  }

  #parseFileValue(value) {
    const parts = String(value || '').split('/');
    const filename = parts.pop() || '';
    const subfolder = parts.join('/');
    return { filename, subfolder };
  }

  #ensureLoadImagePreviewSlot(body) {
    let slot = body.querySelector(':scope > .dk-loadimage-preview-slot');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'dk-loadimage-preview-slot';
      body.appendChild(slot);
    }
    return slot;
  }

  #removeLegacyLoadImagePreviewItems(body, slot) {
    const staleItems = body.querySelectorAll(
      ':scope > .dk-loadimage-preview, :scope > .dk-output-item, :scope > .mc-card'
    );
    for (const el of staleItems) {
      if (el !== slot && !slot.contains(el)) el.remove();
    }
  }

  #getLoadImageLightboxRef(slot, sharedLbItems = null) {
    if (slot._lbRef?.items && Number.isInteger(slot._lbRef.index)) {
      return slot._lbRef;
    }

    const items = sharedLbItems || [];
    const index = items.length;
    items.push({
      src: '',
      type: 'image',
      label: '',
      name: '',
      subfolder: '',
      source: 'input',
    });
    slot._lbRef = { items, index };
    return slot._lbRef;
  }

  #renderLoadImagePreview(node, slot, sharedLbItems = null, force = false) {
    const imageW = this.#getLoadImageWidget(node);
    const value = imageW?.value ? String(imageW.value) : '';
    if (!force && slot.dataset.dkSourceValue === value) return;

    const { filename, subfolder } = this.#parseFileValue(value);
    slot.dataset.dkSourceValue = value;
    slot.dataset.dkViewKey = filename ? `input\n${subfolder}\n${filename}` : '';

    if (!filename) {
      const ref = this.#getLoadImageLightboxRef(slot, sharedLbItems);
      ref.items[ref.index] = {
        src: '',
        type: 'image',
        label: '',
        name: '',
        subfolder: '',
        source: 'input',
      };
      slot.replaceChildren();
      return;
    }

    const title = this.#cleanTitle(node.title || node.type);
    const url = this.bridge.getImageUrl(filename, subfolder, 'input', { bustCache: true });
    const ref = this.#getLoadImageLightboxRef(slot, sharedLbItems);
    ref.items[ref.index] = {
      src: url, type: 'image', label: `${title} — ${filename}`,
      name: filename, subfolder, source: 'input',
    };

    const ctxMenu = this.#contextMenu;
    const card = createMediaCard({
      src: url, filename, subfolder,
      type: 'input', mediaType: 'image', thumbHeight: null, lazy: false,
      lightboxItems: ref.items, lightboxIndex: ref.index,
      onContextMenu: ctxMenu ? (e) => {
        const el = e.currentTarget;
        const ref = el?._lbRef;
        const item = ref ? ref.items[ref.index] : null;
        ctxMenu.show('media-file', {
          src: item?.src || url,
          type: 'image',
          name: item?.name || filename,
          subfolder: item?.subfolder ?? subfolder,
          source: item?.source || 'input',
          hasWorkflow: el._hasWorkflow,
        }, e.clientX, e.clientY);
      } : null,
    });
    card.element.classList.add('dk-output-item', 'dk-loadimage-preview');
    card.element.dataset.dkSourceValue = value;
    card.element.dataset.dkViewKey = slot.dataset.dkViewKey;
    slot.replaceChildren(card.element);
  }

  /**
   * Build inline output display (images, videos, text, audio) for a node.
   * @returns {HTMLElement|null}
   */
  #buildNodeOutput(node, output, sharedLbItems) {
    const frag = document.createDocumentFragment();
    let hasAny = false;
    const title = this.#cleanTitle(node.title || node.type);
    const makeURL = (f) =>
      this.bridge.getImageUrl(f.filename, f.subfolder || '', f.type || 'output', { bustCache: true });
    const ctxMenu = this.#contextMenu;
    const lbItems = sharedLbItems || [];

    // Images
    if (output.images) {
      for (const img of output.images) {
        hasAny = true;
        const url = makeURL(img);
        const imgSource = img.type || 'output';
        const lbIdx = lbItems.length;
        lbItems.push({ src: url, type: 'image', label: `${title} — ${img.filename}`,
          name: img.filename, subfolder: img.subfolder || '', source: imgSource });
        const card = createMediaCard({
          src: url, filename: img.filename, subfolder: img.subfolder || '',
          type: imgSource, mediaType: 'image', thumbHeight: null,
          lazy: false,
          lightboxItems: lbItems, lightboxIndex: lbIdx,
          onContextMenu: ctxMenu ? (e) => {
            // Read from _lbRef for up-to-date data (e.g. after LoadImage combo change)
            const el = e.currentTarget;
            const ref = el?._lbRef;
            const item = ref ? ref.items[ref.index] : null;
            ctxMenu.show('media-file', {
              src: item?.src || url,
              type: 'image',
              name: item?.name || img.filename,
              subfolder: item?.subfolder ?? (img.subfolder || ''),
              source: item?.source || imgSource,
              hasWorkflow: el._hasWorkflow,
            }, e.clientX, e.clientY);
          } : null,
        });
        card.element.classList.add('dk-output-item');
        frag.appendChild(card.element);
      }
    }

    // Videos / GIFs
    if (output.gifs) {
      for (const gif of output.gifs) {
        hasAny = true;
        const url = makeURL(gif);
        const isVideo = /\.(mp4|webm|mkv)$/i.test(gif.filename);
        const lbIdx = lbItems.length;
        lbItems.push({ src: url, type: isVideo ? 'video' : 'image', label: `${title} — ${gif.filename}`,
          name: gif.filename, subfolder: gif.subfolder || '', source: gif.type || 'output' });
        const card = createMediaCard({
          src: url, filename: gif.filename, subfolder: gif.subfolder || '',
          type: gif.type || 'output', mediaType: isVideo ? 'video' : 'image', thumbHeight: null,
          lazy: false,
          lightboxItems: lbItems, lightboxIndex: lbIdx,
          onContextMenu: ctxMenu ? (e) => {
            ctxMenu.show('media-file', {
              src: url, type: isVideo ? 'video' : 'image', name: gif.filename,
              subfolder: gif.subfolder || '', source: gif.type || 'output',
            }, e.clientX, e.clientY);
          } : null,
        });
        card.element.classList.add('dk-output-item');
        frag.appendChild(card.element);
      }
    }

    // Text
    if (output.text) {
      const texts = Array.isArray(output.text) ? output.text : [output.text];
      const joined = texts.join('\n');
      if (joined.trim()) {
        hasAny = true;
        const item = document.createElement('div');
        item.className = 'dk-output-item dk-output-text';
        item.textContent = joined;
        // Context menu: right-click / long-press → Copy
        if (ctxMenu) {
          ContextMenuService.attachTrigger(item, (e) => {
            ctxMenu.show('deck-text', { text: joined }, e.clientX, e.clientY);
          });
        }
        frag.appendChild(item);
      }
    }

    // Audio
    if (output.audio) {
      for (const aud of output.audio) {
        hasAny = true;
        const item = document.createElement('div');
        item.className = 'dk-output-item';
        const audio = document.createElement('audio');
        audio.src = makeURL(aud);
        audio.controls = true;
        audio.preload = 'metadata';
        item.appendChild(audio);
        frag.appendChild(item);
      }
    }

    return hasAny ? frag : null;
  }


  /* ═══ Widget Factory ═══ */

  #buildWidget(widget, node) {
    const container = document.createElement('div');
    container.className = 'dk-widget';

    // Button
    if (widget.type === 'button') {
      const btn = document.createElement('button');
      btn.className = 'dk-btn' + (widget.name?.toLowerCase().includes('upload') ? ' dk-btn-upload' : '');
      btn.textContent = widget.label || widget.name;
      btn.addEventListener('click', () => {
        this.bridge.invokeWidgetCallback(node, widget, widget.value);
        if (widget.name?.toLowerCase().includes('upload')) {
          this.#watchUpload(node);
        }
      });
      container.appendChild(btn);
      return container;
    }

    // Skip object-value widgets
    if (typeof widget.value === 'object' && widget.value !== null
      && typeof widget.value !== 'string') {
      return container;
    }

    const label = document.createElement('label');
    label.className = 'dk-label';
    label.textContent = widget.label || widget.name;

    const setVal = (v) => {
      this.bridge.invokeWidgetCallback(node, widget, v);
    };

    // Combo
    if (widget.type === 'combo') {
      container.appendChild(label);
      const sel = document.createElement('select');
      sel.className = 'dk-select';
      const vals = typeof widget.options?.values === 'function'
        ? widget.options.values()
        : widget.options?.values || [];
      for (const v of vals) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        if (v === widget.value) o.selected = true;
        sel.appendChild(o);
      }
      const setSelectValue = (value) => {
        const str = String(value ?? '');
        if (str && ![...sel.options].some(o => o.value === str)) {
          const o = document.createElement('option');
          o.value = str;
          o.textContent = str;
          sel.appendChild(o);
        }
        sel.value = str;
      };
      setSelectValue(widget.value);
      sel._setDeckValue = setSelectValue;
      sel.addEventListener('change', () => {
        setVal(sel.value);
        setTimeout(() => this.#refreshBindings(), 100);
      });
      container.appendChild(sel);

      // LoadImage / LoadVideo / LoadAudio (ComfyCore): replace visible <select> with picker button
      const isLoadImage = (node.type === 'LoadImage' || node.type === 'LoadImageMask')
        && (widget.name === 'image' || widget.name === 'Image');
      const isLoadVideo = node.type === 'LoadVideo' && widget.name === 'file';
      const isLoadAudio = node.type === 'LoadAudio' && widget.name === 'audio';
      const pickerAccept = isLoadImage ? 'image' : isLoadVideo ? 'video' : isLoadAudio ? 'audio' : null;
      if (pickerAccept) {
        sel.style.display = 'none'; // hide select, keep for value mgmt

        const pickerBtn = document.createElement('button');
        pickerBtn.className = 'dk-image-picker-btn';

        const updatePickerBtn = (val, force = false) => {
          const str = String(val ?? '');
          if (!force && pickerBtn.dataset.dkSourceValue === str) return;
          pickerBtn.dataset.dkSourceValue = str;
          const parts = str.split('/');
          const fname = parts.pop();
          const sub = parts.join('/');
          pickerBtn.innerHTML = '';
          if (pickerAccept === 'image' && fname) {
            const thumbUrl = this.bridge.getImageUrl(fname, sub, 'input', { bustCache: true });
            const thumb = document.createElement('img');
            thumb.className = 'dk-image-picker-thumb';
            thumb.src = thumbUrl;
            thumb.alt = fname;
            pickerBtn.appendChild(thumb);
          } else {
            // Video / Audio: show icon instead of thumbnail
            const icon = document.createElement('span');
            icon.className = 'dk-image-picker-icon';
            icon.innerHTML = pickerAccept === 'audio' ? ICON_MUSIC : ICON_VIDEO;
            pickerBtn.appendChild(icon);
          }
          const nameSpan = document.createElement('span');
          nameSpan.className = 'dk-image-picker-name';
          nameSpan.textContent = fname;
          pickerBtn.appendChild(nameSpan);
        };
        updatePickerBtn(widget.value, true);

        pickerBtn.addEventListener('click', () => {
          const openPicker = window.ComfyDrawer?.openImagePicker;
          if (!openPicker) return;
          openPicker({
            root: 'input',
            accept: pickerAccept,
            currentValue: String(widget.value),
            onSelect: (value) => {
              setSelectValue(value);
              setVal(value);
              updatePickerBtn(value, true);
              sel._syncOutputThumbs?.(value, true);
              setTimeout(() => this.#refreshBindings(), 100);
            },
          });
        });

        container.insertBefore(pickerBtn, sel);
        // Store ref for syncExtra to update button text
        sel._pickerBtn = pickerBtn;
        sel._updatePickerBtn = updatePickerBtn;
      }

      // LoadImage / LoadVideo / LoadAudio sync: keep output in sync with selected file
      if (isLoadImage || isLoadVideo || isLoadAudio) {
        const mediaType = isLoadVideo ? 'video' : isLoadAudio ? 'audio' : 'image';
        const parseFileValue = (val) => {
          const parts = String(val).split('/');
          const filename = parts.pop();
          const subfolder = parts.join('/');
          return { filename, subfolder };
        };
        const makeInputUrl = (val) => {
          const { filename, subfolder } = parseFileValue(val);
          return this.bridge.getImageUrl(filename, subfolder, 'input', { bustCache: true });
        };

        let lastImgVal = String(widget.value);

        // Update output thumbnails + lightbox items in this node's section.
        // Recreates the entire MediaCard so all closures (D&D, context menu,
        // lightbox, WF check) reference the correct file data.
        const syncOutputThumbs = (nextValue = null, force = false) => {
          const val = String(nextValue ?? widget.value);
          const sec = container.closest('.dk-section');
          if (!sec) return;
          // Update picker button if present
          sel._updatePickerBtn?.(val);
          const newUrl = makeInputUrl(val);
          const { filename, subfolder } = parseFileValue(val);
          const title = this.#cleanTitle(node.title || node.type);
          const ctxMenu = this.#contextMenu;

          if (isLoadImage) {
            const sBody = sec.querySelector('.dk-section-body');
            if (!sBody) return;
            const slot = this.#ensureLoadImagePreviewSlot(sBody);
            if (!force && val === lastImgVal && slot.dataset.dkSourceValue === val) {
              return;
            }
            lastImgVal = val;
            this.#renderLoadImagePreview(node, slot, null, force);
            this.#removeLegacyLoadImagePreviewItems(sBody, slot);
            this.#rebuildLightboxRefsFromDom();
            return;
          }

          if (!force && val === lastImgVal) {
            return;
          }
          lastImgVal = val;

          let existingItems = [...sec.querySelectorAll('.dk-output-item')];

          // ── No existing card: create fresh ───────────────────────────────
          if (existingItems.length === 0 && mediaType === 'image') {
            const lbItems = sharedLbItems || [];
            const lbIdx = lbItems.length;
            lbItems.push({
              src: newUrl, type: 'image', label: `${title} — ${filename}`,
              name: filename, subfolder, source: 'input',
            });
            const card = createMediaCard({
              src: newUrl, filename, subfolder,
              type: 'input', mediaType: 'image', thumbHeight: null, lazy: false,
              lightboxItems: lbItems, lightboxIndex: lbIdx,
              onContextMenu: ctxMenu ? (e) => {
                ctxMenu.show('media-file', {
                  src: newUrl, type: 'image', name: filename,
                  subfolder, source: 'input',
                  hasWorkflow: e.currentTarget._hasWorkflow,
                }, e.clientX, e.clientY);
              } : null,
            });
            card.element.classList.add('dk-output-item');
            const sBody = sec.querySelector('.dk-section-body');
            if (sBody) sBody.appendChild(card.element);
            return;
          }

          // ── Replace existing cards ────────────────────────────────────────
          for (const oldItem of existingItems) {
            if (mediaType === 'audio') {
              // Audio: simply replace audio player
              oldItem.remove();
              const item = document.createElement('div');
              item.className = 'dk-output-item';
              const audio = document.createElement('audio');
              audio.src = newUrl;
              audio.controls = true;
              audio.preload = 'metadata';
              audio.style.width = '100%';
              item.appendChild(audio);
              const sBody = sec.querySelector('.dk-section-body');
              if (sBody) sBody.appendChild(item);
              continue;
            }

            // Get the shared lightbox items array & index from old card
            const ref = oldItem._lbRef;
            if (!ref) { oldItem.remove(); continue; }
            const lbItems = ref.items;
            const lbIdx = ref.index;

            // Update existing lightbox item in-place
            const lbItem = lbItems[lbIdx];
            if (lbItem) {
              lbItem.src = newUrl;
              lbItem.name = filename;
              lbItem.subfolder = subfolder;
              lbItem.source = 'input';
              lbItem.type = mediaType;
              lbItem.label = `${title} — ${filename}`;
              lbItem.hasWorkflow = undefined; // will be re-set by new card
            }

            // Remove old card
            oldItem.remove();

            // Create new card with fresh closures
            const card = createMediaCard({
              src: newUrl, filename, subfolder,
              type: 'input', mediaType, thumbHeight: null,
              lazy: false,
              lightboxItems: lbItems, lightboxIndex: lbIdx,
              onContextMenu: ctxMenu ? (e) => {
                const el = e.currentTarget;
                ctxMenu.show('media-file', {
                  src: newUrl,
                  type: mediaType,
                  name: filename,
                  subfolder,
                  source: 'input',
                  hasWorkflow: el._hasWorkflow,
                }, e.clientX, e.clientY);
              } : null,
            });
            card.element.classList.add('dk-output-item');

            // Insert into the section body
            const body = sec.querySelector('.dk-section-body');
            if (body) body.appendChild(card.element);
          }
        };

        sel.addEventListener('change', syncOutputThumbs);
        sel._syncOutputThumbs = syncOutputThumbs;

        this.bindings.push({ widget, el: sel, type: 'combo', syncExtra: syncOutputThumbs });
      } else {
        this.bindings.push({ widget, el: sel, type: 'combo' });
      }
      return container;
    }

    // Toggle
    if (widget.type === 'toggle' || typeof widget.value === 'boolean') {
      const wrap = document.createElement('div');
      wrap.className = 'dk-toggle-wrap';
      wrap.appendChild(label);
      const tog = document.createElement('div');
      tog.className = 'dk-toggle' + (widget.value ? ' active' : '');
      tog.addEventListener('click', () => {
        const nv = !widget.value;
        tog.classList.toggle('active', nv);
        setVal(nv);
      });
      wrap.appendChild(tog);
      container.appendChild(wrap);
      this.bindings.push({ widget, el: tog, type: 'toggle' });
      return container;
    }

    // Number
    if (widget.type === 'number' || widget.type === 'slider' ||
      (typeof widget.value === 'number' && widget.type !== 'combo')) {
      container.appendChild(label);
      const opts = widget.options || {};
      // Determine if this is a float widget: check step or whether current value has decimals
      const isFloat = (opts.step != null && opts.step < 1) ||
                      (opts.step == null && typeof widget.value === 'number' && !Number.isInteger(widget.value));
      const step = isFloat ? 0.01 : (opts.step ?? 1);
      const prec = opts.precision ?? (step < 1 ? Math.max(2, -Math.floor(Math.log10(step))) : 0);
      const wrap = document.createElement('div');
      wrap.className = 'dk-number-wrap';

      const minus = document.createElement('button');
      minus.className = 'dk-stepper'; minus.textContent = '−';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'dk-number';
      inp.value = prec > 0 ? Number(widget.value).toFixed(prec) : widget.value;
      inp.step = step;
      if (opts.min !== undefined) inp.min = opts.min;
      if (opts.max !== undefined) inp.max = opts.max;
      const plus = document.createElement('button');
      plus.className = 'dk-stepper'; plus.textContent = '+';

      const commit = (v) => {
        let n = parseFloat(v);
        if (isNaN(n)) return;
        if (opts.min !== undefined) n = Math.max(opts.min, n);
        if (opts.max !== undefined) n = Math.min(opts.max, n);
        n = parseFloat(n.toFixed(prec));
        inp.value = prec > 0 ? n.toFixed(prec) : n;
        setVal(n);
      };

      minus.addEventListener('click', () => commit(widget.value - step));
      plus.addEventListener('click', () => commit(widget.value + step));
      inp.addEventListener('change', () => commit(inp.value));
      wrap.append(minus, inp, plus);
      container.appendChild(wrap);
      this.bindings.push({ widget, el: inp, type: 'number', prec });
      return container;
    }

    // String / Text / customWidget
    container.appendChild(label);
    const isMultiline =
      widget.options?.multiline ||
      widget.inputEl?.tagName === 'TEXTAREA' ||
      widget.type === 'customtext';

    if (isMultiline) {
      const wrap = document.createElement('div');
      wrap.className = 'dk-textarea-wrap';

      // Highlight overlay (behind textarea)
      const hlLayer = document.createElement('div');
      hlLayer.className = 'dk-hl-layer';
      wrap.appendChild(hlLayer);

      const ta = document.createElement('textarea');
      ta.className = 'dk-textarea dk-hl-active';
      ta.value = widget.value ?? widget.inputEl?.value ?? '';

      const updateHL = () => {
        hlLayer.innerHTML = highlightPromptSyntax(ta.value, this.#hlOpts) + '\n';
      };
      updateHL();

      // Auto-resize helper
      const heightKey = `${node.id}:${widget.name}`;
      const autoSize = () => {
        // Skip auto-size if user has manually resized
        if (this.#textareaHeights.has(heightKey)) return;
        ta.style.height = 'auto';
        ta.style.height = Math.max(70, ta.scrollHeight) + 'px';
        // Sync highlight layer height
        hlLayer.style.height = ta.style.height;
      };

      ta.addEventListener('input', () => {
        setVal(ta.value);
        if (widget.inputEl) widget.inputEl.value = ta.value;
        updateHL();
        // Re-auto-size on content change (unless manually resized)
        autoSize();
      });
      ta.addEventListener('scroll', () => {
        hlLayer.scrollTop = ta.scrollTop;
        hlLayer.scrollLeft = ta.scrollLeft;
      });
      wrap.appendChild(ta);

      // Restore manually set height (survives re-render)
      const savedH = this.#textareaHeights.get(heightKey);
      if (savedH) {
        ta.style.height = savedH + 'px';
        hlLayer.style.height = savedH + 'px';
      }

      // Tag autocomplete via shared service
      if (widget.options?.multiline || widget.type === 'customtext') {
        this.addDisposable(attachDictAutocomplete(window.ComfyDrawer.dict, ta));
      }

      // Attention weight toolbar (+/- buttons for mobile)
      this.addDisposable(attachAttnToolbar(wrap, ta));

      // Resize handle (manual override)
      const handle = document.createElement('div');
      handle.className = 'dk-resize-handle';
      handle.textContent = '≡';
      let rStartY = 0, rStartH = 0;
      const rOnMove = (e) => {
        const y = e.touches ? e.touches[0].clientY : e.clientY;
        const h = Math.max(60, rStartH + (y - rStartY));
        ta.style.height = h + 'px';
        hlLayer.style.height = h + 'px';
      };
      const rOnEnd = () => {
        document.removeEventListener('mousemove', rOnMove);
        document.removeEventListener('mouseup', rOnEnd);
        document.removeEventListener('touchmove', rOnMove);
        document.removeEventListener('touchend', rOnEnd);
        // Save manual height
        this.#textareaHeights.set(heightKey, ta.offsetHeight);
      };
      const rOnStart = (e) => {
        e.preventDefault();
        rStartY = e.touches ? e.touches[0].clientY : e.clientY;
        rStartH = ta.offsetHeight;
        document.addEventListener('mousemove', rOnMove);
        document.addEventListener('mouseup', rOnEnd);
        document.addEventListener('touchmove', rOnMove, { passive: false });
        document.addEventListener('touchend', rOnEnd);
      };
      handle.addEventListener('mousedown', rOnStart);
      handle.addEventListener('touchstart', rOnStart, { passive: false });
      wrap.appendChild(handle);

      container.appendChild(wrap);
      this.bindings.push({ widget, el: ta, type: 'text', nodeId: node.id });
    } else {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'dk-input';
      inp.value = String(widget.value ?? '');
      inp.addEventListener('input', () => {
        setVal(inp.value);
        if (widget.inputEl) widget.inputEl.value = inp.value;
      });
      container.appendChild(inp);
      this.bindings.push({ widget, el: inp, type: 'text' });
    }
    return container;
  }

  /* ═══ Special Widgets ═══ */

  #buildSeedWidget(node, body) {
    const widgets = node.widgets || [];
    const seedWidget = widgets.find(w => w.name === 'seed_value' && w.type === 'number');
    if (!seedWidget) return false;

    const container = document.createElement('div');
    container.className = 'dk-widget';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';

    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'dk-number';
    inp.style.cssText = 'flex:1;min-width:0;width:auto';
    inp.value = seedWidget.value;
    inp.addEventListener('change', () => {
      this.bridge.invokeWidgetCallback(node, seedWidget, parseInt(inp.value) || 0);
    });
    row.appendChild(inp);

    let updateLockUI = null;

    const modeWidget = widgets.find(w => w.name === 'mode');
    const btnLock = document.createElement('button');
    btnLock.className = 'dk-seed-mode-btn';

    updateLockUI = () => {
      const locked = modeWidget?.value === 'fixed';
      btnLock.innerHTML = locked ? ICON_LOCK : ICON_DICE;
      btnLock.title = locked ? 'Seed locked (fixed)' : 'Seed unlocked (randomize each run)';
      btnLock.classList.toggle('active', locked);
    };
    updateLockUI();

    btnLock.addEventListener('click', () => {
      if (modeWidget) {
        const newMode = modeWidget.value === 'fixed' ? 'randomize' : 'fixed';
        this.bridge.invokeWidgetCallback(node, modeWidget, newMode);
      }
      updateLockUI();
    });
    row.appendChild(btnLock);

    container.appendChild(row);
    body.appendChild(container);
    this.bindings.push({
      widget: seedWidget, el: inp, type: 'number', nodeId: node.id,
      syncExtra: updateLockUI,
    });
    return true;
  }


  /* ═══ Controls Widget (DrawerControls) ═══ */

  #buildControlsWidget(node, body) {
    let rendered = false;

    for (const control of enumerateDrawerControls(this.bridge, node)) {
      const { valueWidget: valueW, def } = control;
      const container = document.createElement('div');
      container.className = 'dk-widget dk-control-widget';

      const label = document.createElement('label');
      label.className = 'dk-label';
      label.textContent = def.label;
      container.appendChild(label);

      const setValue = (value) => this.bridge.invokeWidgetCallback(node, valueW, String(value));

      if (def.type === 'combo') {
        const select = document.createElement('select');
        select.className = 'dk-select';
        const options = control.comboOptions;
        const values = options.length ? options : def.fallbackOptions;
        const current = String(valueW.value ?? '');
        const finalValues = values.includes(current) || !current ? values : [current, ...values];
        for (const opt of finalValues) {
          const option = document.createElement('option');
          option.value = opt;
          option.textContent = opt;
          select.appendChild(option);
        }
        select.value = current || finalValues[0] || '';
        select.addEventListener('change', () => setValue(select.value));
        container.appendChild(select);
      } else if (def.type === 'bool') {
        const wrap = document.createElement('div');
        wrap.className = 'dk-control-toggle-row';
        const tog = document.createElement('div');
        let checked = ['true', '1', 'yes', 'on', 'enabled']
          .includes(String(valueW.value ?? '').toLowerCase());
        tog.className = 'dk-toggle' + (checked ? ' active' : '');
        tog.addEventListener('click', () => {
          checked = !checked;
          tog.classList.toggle('active', checked);
          setValue(checked ? 'true' : 'false');
        });
        wrap.appendChild(tog);
        container.appendChild(wrap);
      } else if (def.type === 'string') {
        if (def.multiline) {
          const wrap = document.createElement('div');
          wrap.className = 'dk-textarea-wrap';

          const hlLayer = document.createElement('div');
          hlLayer.className = 'dk-hl-layer';
          wrap.appendChild(hlLayer);

          const ta = document.createElement('textarea');
          ta.className = 'dk-textarea dk-hl-active';
          ta.value = String(valueW.value ?? '');
          ta.rows = 3;

          const heightKey = `${node.id}:${valueW.name}`;
          const updateHL = () => {
            hlLayer.innerHTML = highlightPromptSyntax(ta.value, this.#hlOpts) + '\n';
          };
          const autoSize = () => {
            if (this.#textareaHeights.has(heightKey)) return;
            ta.style.height = 'auto';
            ta.style.height = Math.max(70, ta.scrollHeight) + 'px';
            hlLayer.style.height = ta.style.height;
          };

          updateHL();
          ta.addEventListener('input', () => {
            setValue(ta.value);
            updateHL();
            autoSize();
          });
          ta.addEventListener('scroll', () => {
            hlLayer.scrollTop = ta.scrollTop;
            hlLayer.scrollLeft = ta.scrollLeft;
          });
          wrap.appendChild(ta);

          const savedH = this.#textareaHeights.get(heightKey);
          if (savedH) {
            ta.style.height = savedH + 'px';
            hlLayer.style.height = savedH + 'px';
          } else {
            queueMicrotask(autoSize);
          }

          this.addDisposable(attachDictAutocomplete(window.ComfyDrawer.dict, ta));
          this.addDisposable(attachAttnToolbar(wrap, ta));

          const handle = document.createElement('div');
          handle.className = 'dk-resize-handle';
          handle.textContent = '≡';
          let rStartY = 0, rStartH = 0;
          const rOnMove = (e) => {
            const y = e.touches ? e.touches[0].clientY : e.clientY;
            const h = Math.max(60, rStartH + (y - rStartY));
            ta.style.height = h + 'px';
            hlLayer.style.height = h + 'px';
          };
          const rOnEnd = () => {
            document.removeEventListener('mousemove', rOnMove);
            document.removeEventListener('mouseup', rOnEnd);
            document.removeEventListener('touchmove', rOnMove);
            document.removeEventListener('touchend', rOnEnd);
            this.#textareaHeights.set(heightKey, ta.offsetHeight);
          };
          const rOnStart = (e) => {
            e.preventDefault();
            rStartY = e.touches ? e.touches[0].clientY : e.clientY;
            rStartH = ta.offsetHeight;
            document.addEventListener('mousemove', rOnMove);
            document.addEventListener('mouseup', rOnEnd);
            document.addEventListener('touchmove', rOnMove, { passive: false });
            document.addEventListener('touchend', rOnEnd);
          };
          handle.addEventListener('mousedown', rOnStart);
          handle.addEventListener('touchstart', rOnStart, { passive: false });
          wrap.appendChild(handle);

          container.appendChild(wrap);
          this.bindings.push({ widget: valueW, el: ta, type: 'text', nodeId: node.id });
        } else {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'dk-input';
          inp.value = String(valueW.value ?? '');
          inp.addEventListener('input', () => setValue(inp.value));
          container.appendChild(inp);
        }
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'dk-number-wrap';
        const minus = document.createElement('button');
        minus.className = 'dk-stepper'; minus.textContent = '−';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.className = 'dk-number';
        inp.min = def.min; inp.max = def.max; inp.step = def.step;
        const format = (v) => def.type === 'int'
          ? String(Math.round(Number(v)))
          : Number(v).toFixed(Math.max(0, def.round));
        inp.value = format(valueW.value || 0);
        const plus = document.createElement('button');
        plus.className = 'dk-stepper'; plus.textContent = '+';
        const commit = (value) => {
          let n = Number(value);
          if (!Number.isFinite(n)) return;
          n = Math.max(def.min, Math.min(def.max, n));
          n = def.type === 'int' ? Math.round(n) : Number(n.toFixed(Math.max(0, def.round)));
          inp.value = format(n);
          setValue(n);
        };
        minus.addEventListener('click', () => commit(Number(inp.value || 0) - def.step));
        plus.addEventListener('click', () => commit(Number(inp.value || 0) + def.step));
        inp.addEventListener('change', () => commit(inp.value));
        wrap.append(minus, inp, plus);
        container.appendChild(wrap);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'dk-slider';
        slider.min = def.min; slider.max = def.max; slider.step = def.step;
        slider.value = inp.value;
        slider.addEventListener('input', () => {
          commit(slider.value);
          slider.value = inp.value;
        });
        inp.addEventListener('change', () => { slider.value = inp.value; });
        container.appendChild(slider);
      }

      body.appendChild(container);
      rendered = true;
    }

    return rendered;
  }


  /* ═══ Size Widget (DrawerSize) ═══ */

  /**
   * Build a rich resolution selector for DrawerSize nodes.
   * Aspect ratio presets + megapixel input → auto width/height.
   * Uses ComfyUI's official formula: 1 MP = 1024×1024, rounded to 16.
   *
   * Binds to backend widgets: ratio_ (COMBO), megapixels_ (FLOAT),
   * width_ (INT), height_ (INT).
   */
  #buildSizeWidget(node, body) {
    const widgets = node.widgets || [];
    const widthW  = widgets.find(w => w.name === 'width_');
    const heightW = widgets.find(w => w.name === 'height_');
    const ratioW  = widgets.find(w => w.name === 'ratio_');
    const mpW     = widgets.find(w => w.name === 'megapixels_');
    if (!widthW || !heightW) return false;

    // ComfyUI convention: 1 megapixel = 1024 * 1024 = 1,048,576 pixels
    const MP = 1024 * 1024;
    const round16 = (v) => Math.max(64, Math.round(v / 16) * 16);

    // Compute size from aspect ratio + megapixels (matches ResolutionSelector)
    const calcSize = (wRatio, hRatio, mp) => {
      const total = mp * MP;
      const scale = Math.sqrt(total / (wRatio * hRatio));
      return [round16(wRatio * scale), round16(hRatio * scale)];
    };

    // ── State ──
    let currentW = widthW.value;
    let currentH = heightW.value;
    let megapixels = mpW ? mpW.value : Math.round((currentW * currentH) / MP * 10) / 10;

    const RATIOS = [
      { label: '1:1',   w: 1,   h: 1  },
      { label: '4:3',   w: 4,   h: 3  },
      { label: '3:2',   w: 3,   h: 2  },
      { label: '16:9',  w: 16,  h: 9  },
      { label: '21:9',  w: 21,  h: 9  },
      { label: '9:16',  w: 9,   h: 16 },
      { label: '2:3',   w: 2,   h: 3  },
      { label: '3:4',   w: 3,   h: 4  },
    ];

    const container = document.createElement('div');
    container.className = 'dk-widget dk-size-widget';

    // ── Aspect ratio chips ──
    const chipRow = document.createElement('div');
    chipRow.className = 'dk-size-chips';

    const findActiveRatio = () => {
      // If the backend COMBO is set and not 'custom', use that
      if (ratioW && ratioW.value && ratioW.value !== 'custom') {
        return RATIOS.find(r => r.label === ratioW.value) || null;
      }
      // Fallback: detect from dimensions
      const r = currentW / currentH;
      return RATIOS.find(p => Math.abs((p.w / p.h) - r) < 0.02) || null;
    };

    const updateChipActive = () => {
      const active = findActiveRatio();
      for (const chip of chipRow.children) {
        chip.classList.toggle('active', active?.label === chip.dataset.ratio);
      }
    };

    for (const ratio of RATIOS) {
      const chip = document.createElement('button');
      chip.className = 'dk-size-chip';
      chip.dataset.ratio = ratio.label;

      // Visual shape indicator
      const shape = document.createElement('span');
      shape.className = 'dk-size-shape';
      const maxDim = 14;
      const scale = maxDim / Math.max(ratio.w, ratio.h);
      shape.style.width = Math.round(ratio.w * scale) + 'px';
      shape.style.height = Math.round(ratio.h * scale) + 'px';

      const txt = document.createElement('span');
      txt.textContent = ratio.label;

      chip.append(shape, txt);
      chip.addEventListener('click', () => {
        [currentW, currentH] = calcSize(ratio.w, ratio.h, megapixels);
        // Sync backend COMBO widget
        if (ratioW) this.bridge.invokeWidgetCallback(node, ratioW, ratio.label);
        commitSize();
      });
      chipRow.appendChild(chip);
    }
    container.appendChild(chipRow);

    // ── Megapixel row ──
    const mpRow = document.createElement('div');
    mpRow.className = 'dk-size-mp-row';


    const mpSlider = document.createElement('input');
    mpSlider.type = 'range';
    mpSlider.className = 'dk-slider';
    mpSlider.min = 0.25; mpSlider.max = 4.0; mpSlider.step = 0.05;
    mpSlider.value = megapixels;

    const mpDisplay = document.createElement('span');
    mpDisplay.className = 'dk-size-mp-val';
    mpDisplay.textContent = megapixels.toFixed(1) + ' MP';

    mpSlider.addEventListener('input', () => {
      megapixels = Math.round(parseFloat(mpSlider.value) * 10) / 10;
      mpDisplay.textContent = megapixels.toFixed(1) + ' MP';
      // Sync backend megapixels_ widget
      if (mpW) this.bridge.invokeWidgetCallback(node, mpW, megapixels);
      // Recalculate from current aspect ratio
      const active = findActiveRatio() || { w: currentW, h: currentH };
      [currentW, currentH] = calcSize(active.w, active.h, megapixels);
      commitSize();
    });

    mpRow.append(mpSlider, mpDisplay);
    container.appendChild(mpRow);

    // ── Direct input row ──
    const sizeRow = document.createElement('div');
    sizeRow.className = 'dk-size-direct';

    const wLabel = document.createElement('span');
    wLabel.className = 'dk-size-dim-label'; wLabel.textContent = 'W';
    const wInp = document.createElement('input');
    wInp.type = 'number'; wInp.className = 'dk-number dk-size-num';
    wInp.min = 64; wInp.max = 8192; wInp.step = 16;
    wInp.value = currentW;

    const swapBtn = document.createElement('button');
    swapBtn.className = 'dk-size-swap';
    swapBtn.innerHTML = ICON_SWAP;
    swapBtn.title = 'Swap W ↔ H';
    swapBtn.addEventListener('click', () => {
      [currentW, currentH] = [currentH, currentW];
      // On swap, set ratio to 'custom' since it may no longer match a preset
      if (ratioW) this.bridge.invokeWidgetCallback(node, ratioW, 'custom');
      commitSize();
    });

    const hLabel = document.createElement('span');
    hLabel.className = 'dk-size-dim-label'; hLabel.textContent = 'H';
    const hInp = document.createElement('input');
    hInp.type = 'number'; hInp.className = 'dk-number dk-size-num';
    hInp.min = 64; hInp.max = 8192; hInp.step = 16;
    hInp.value = currentH;

    wInp.addEventListener('change', () => {
      currentW = round16(parseInt(wInp.value) || 64);
      megapixels = Math.round((currentW * currentH) / MP * 10) / 10;
      // Manual W/H edit → set ratio to 'custom'
      if (ratioW) this.bridge.invokeWidgetCallback(node, ratioW, 'custom');
      if (mpW) this.bridge.invokeWidgetCallback(node, mpW, megapixels);
      commitSize();
    });
    hInp.addEventListener('change', () => {
      currentH = round16(parseInt(hInp.value) || 64);
      megapixels = Math.round((currentW * currentH) / MP * 10) / 10;
      if (ratioW) this.bridge.invokeWidgetCallback(node, ratioW, 'custom');
      if (mpW) this.bridge.invokeWidgetCallback(node, mpW, megapixels);
      commitSize();
    });

    sizeRow.append(wLabel, wInp, swapBtn, hLabel, hInp);
    container.appendChild(sizeRow);

    // ── Commit helper ──
    const commitSize = () => {
      wInp.value = currentW;
      hInp.value = currentH;
      mpSlider.value = megapixels;
      mpDisplay.textContent = megapixels.toFixed(1) + ' MP';
      updateChipActive();
      this.bridge.invokeWidgetCallback(node, widthW, currentW);
      this.bridge.invokeWidgetCallback(node, heightW, currentH);
    };
    updateChipActive();

    body.appendChild(container);

    // Bindings for canvas → Deck sync
    this.bindings.push({
      widget: widthW, el: wInp, type: 'number',
      syncExtra: () => {
        if (parseInt(wInp.value) !== widthW.value) {
          currentW = widthW.value;
          wInp.value = currentW;
          megapixels = Math.round((currentW * currentH) / MP * 10) / 10;
          mpSlider.value = megapixels;
          mpDisplay.textContent = megapixels.toFixed(1) + ' MP';
          updateChipActive();
        }
      },
    });
    this.bindings.push({
      widget: heightW, el: hInp, type: 'number',
      syncExtra: () => {
        if (parseInt(hInp.value) !== heightW.value) {
          currentH = heightW.value;
          hInp.value = currentH;
          megapixels = Math.round((currentW * currentH) / MP * 10) / 10;
          mpSlider.value = megapixels;
          mpDisplay.textContent = megapixels.toFixed(1) + ' MP';
          updateChipActive();
        }
      },
    });
    // Sync ratio COMBO from canvas
    if (ratioW) {
      this.bindings.push({
        widget: ratioW, el: chipRow, type: 'combo',
        syncExtra: () => updateChipActive(),
      });
    }
    // Sync megapixels from canvas
    if (mpW) {
      this.bindings.push({
        widget: mpW, el: mpSlider, type: 'slider',
        syncExtra: () => {
          const v = Math.round(mpW.value * 10) / 10;
          if (parseFloat(mpSlider.value) !== v) {
            megapixels = v;
            mpSlider.value = v;
            mpDisplay.textContent = v.toFixed(1) + ' MP';
          }
        },
      });
    }

    return true;
  }


  /* ═══ Upload Watcher ═══ */

  #watchUpload(node) {
    const imageWidget = (node.widgets || []).find(w => w.name === 'image' || w.name === 'Image');
    if (!imageWidget) return;
    const oldVal = imageWidget.value;
    const tid = setInterval(() => {
      if (imageWidget.value !== oldVal) {
        clearInterval(tid);
        clearTimeout(bail);
        this.#scanNodes();
        this.#renderSections();
      }
    }, 500);
    const bail = setTimeout(() => clearInterval(tid), 15000);
    this.addDisposable(() => { clearInterval(tid); clearTimeout(bail); });
  }

  /* ═══ Graph → Deck Sync Polling ═══ */

  #startSyncPolling() {
    this.#stopSyncPolling();
    this.#syncTimer = setInterval(() => {
      // Skip sync while user is actively typing in a Deck input
      const active = document.activeElement;
      if (active && this.container?.contains(active) &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        return;
      }
      this.#refreshBindings();
    }, 500);
  }

  #stopSyncPolling() {
    if (this.#syncTimer) {
      clearInterval(this.#syncTimer);
      this.#syncTimer = null;
    }
  }

  /* ═══ Binding Refresh ═══ */

  #refreshBindings() {
    // Sync widget values
    for (const b of this.bindings) {
      const v = b.widget.value;
      let forceExtra = false;
      if (b.type === 'combo' || b.type === 'text' || b.type === 'number' || b.type === 'slider') {
        if (b.el.value !== String(v)) {
          const nextValue = (b.type === 'number' && b.prec > 0) ? Number(v).toFixed(b.prec) : v;
          if (b.el._setDeckValue) b.el._setDeckValue(nextValue);
          else b.el.value = nextValue;
          forceExtra = true;
          // Update highlight overlay if present
          const hl = b.el.closest('.dk-textarea-wrap')?.querySelector('.dk-hl-layer');
          if (hl) hl.innerHTML = highlightPromptSyntax(String(v), this.#hlOpts) + '\n';
          // Auto-resize textarea after external value change
          if (b.el.tagName === 'TEXTAREA') {
            const key = `${b.nodeId ?? ''}:${b.widget.name}`;
            if (!this.#textareaHeights.has(key)) {
              b.el.style.height = 'auto';
              const h = Math.max(70, b.el.scrollHeight);
              b.el.style.height = h + 'px';
              if (hl) hl.style.height = h + 'px';
            }
          }
        }
      } else if (b.type === 'toggle') {
        b.el.classList.toggle('active', !!v);
      }
      b.syncExtra?.(v, forceExtra);
    }

    this.#syncLoadImagePreviewSections();
    this.#syncDeckToggleControls();

    // Sync node titles — update headers if title changed on canvas
    const sections = this.container?.querySelectorAll('.dk-section[data-node-id]');
    if (!sections) return;

    let needsFullRebuild = false;
    for (const sec of sections) {
      const nodeId = parseInt(sec.dataset.nodeId);
      const node = this.bridge.getNodeById(nodeId);
      if (!node) {
        // Node was deleted — need full rebuild
        needsFullRebuild = true;
        break;
      }
      const rawTitle = String(node.title || node.type || '');
      if (rawTitle !== sec.dataset.rawTitle) {
        needsFullRebuild = true;
        break;
      }
      const mode = this.bridge.getNodeMode(nodeId);
      const parsed = this.#parseNodeMarkers(node.title || node.type);
      const nodeToggle = sec.querySelector('.dk-section-header .dk-group-toggle input, .dk-section-header .dk-exclusive-toggle input');
      if (nodeToggle) {
        const toggleWrap = nodeToggle.closest('.dk-exclusive-toggle, .dk-group-toggle');
        const blockedByGroup = this.#isNodeBlockedByGroup(node.id);
        if (toggleWrap?.classList.contains('dk-bypass-toggle')) {
          toggleWrap.classList.toggle('blocked', blockedByGroup);
          nodeToggle.disabled = !!blockedByGroup;
        }
        nodeToggle.checked = parsed.switchName
          ? this.#isNodeExclusiveSelected(node, parsed) && !blockedByGroup
          : (mode === 0) && !blockedByGroup;
        this.#syncBypassToggleLabel(nodeToggle);
      }
      const titleEl = sec.querySelector('.dk-section-title');
      if (titleEl) {
        const current = parsed.displayTitle;
        const displayed = titleEl.textContent;
        if (current !== displayed) {
          titleEl.textContent = current;
        }
      }
    }

    // Check if edit node set changed (compare against this.editNodes, not DOM)
    // Note: renderedIds may be smaller than editNodes because
    // #buildNodeSection returns null for nodes with no editable widgets.
    // We only need to rebuild if editNodes itself would change.
    if (!needsFullRebuild) {
      const freshEditIds = this.#getEligibleEditNodeIds();
      const currentEditIds = new Set(this.editNodes.map(n => n.id));
      if (freshEditIds.size !== currentEditIds.size ||
          [...freshEditIds].some(id => !currentEditIds.has(id))) {
        needsFullRebuild = true;
      }
    }

    if (!needsFullRebuild) {
      const nextGroupFingerprint = this.#computeGroupMembershipFingerprint();
      if (nextGroupFingerprint !== this.#groupMembershipFingerprint) {
        needsFullRebuild = true;
      }
    }

    if (needsFullRebuild) {
      this.#scanNodes();
      this.#renderSections();
    }
  }

  #syncLoadImagePreviewSections(force = false) {
    const root = this.container?.querySelector('#dk-sections');
    if (!root) return;
    for (const node of this.editNodes) {
      if (!this.#isLoadImageNode(node)) continue;
      const sec = root.querySelector(`.dk-section[data-node-id="${node.id}"]`);
      const body = sec?.querySelector('.dk-section-body');
      if (!body) continue;
      const slot = this.#ensureLoadImagePreviewSlot(body);
      this.#renderLoadImagePreview(node, slot, null, force);
      this.#removeLegacyLoadImagePreviewItems(body, slot);
    }
    this.#rebuildLightboxRefsFromDom();
  }



  /* ═══ Generate ═══ */

  async #generate() {
    // Notify XYZ Plot gadget — if enabled, it will handle the sweep
    this.bus.emit('deck:generate-requested');

    // Seed randomization handled by beforeQueuePrompt in comfy-drawer.js
    try {
      await this.bridge.queuePromptSimple(0, 1);
    } catch (e) {
      console.error('[Deck] Queue error:', e);
    }

    // Sync Deck inputs with widget values (seed may have been randomized)
    for (const b of this.bindings) {
      if (b.type === 'number') {
        b.el.value = b.widget.value;
      }
      b.syncExtra?.();
    }
  }

  /* ═══ In-Place Output Update ═══ */

  /**
   * Update only the output display (images/video/text/audio) for each
   * node section that is currently in the DOM. Widgets are untouched.
   * This avoids the full DOM rebuild that causes scroll/flicker issues.
   */
  #updateOutputsInPlace() {
    const container = this.container.querySelector('#dk-sections');
    if (!container) return;

    const sharedLbItems = this.#lightboxItems;

    for (const node of this.editNodes) {
      if (node.type === 'LoadImage' || node.type === 'LoadImageMask') {
        continue;
      }

      const sec = container.querySelector(`.dk-section[data-node-id="${node.id}"]`);
      if (!sec) continue;

      const body = sec.querySelector('.dk-section-body');
      if (!body) continue;

      // Measure old output items before removing them
      const oldItems = [...body.querySelectorAll('.dk-output-item')];
      const oldHeights = oldItems.map(el => el.offsetHeight);

      // Remove old outputs
      for (const old of oldItems) old.remove();

      // Build new output content
      const nodeOutput = this.bridge.nodeOutputs?.[String(node.id)];
      if (!nodeOutput) continue;

      const outputContent = this.#buildNodeOutput(node, nodeOutput, sharedLbItems);
      if (!outputContent) continue;

      body.appendChild(outputContent);

      // Apply old heights as minHeight to new items to prevent layout shrink.
      // Release once each item's media (img/video) has loaded.
      const newItems = [...body.querySelectorAll('.dk-output-item')];
      for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i];
        const oldH = oldHeights[i] || 0;
        if (oldH > 0) {
          item.style.minHeight = oldH + 'px';

          // Find the media element (mc-thumb inside mc-thumb-wrap)
          const media = item.querySelector('.mc-thumb, img, video');
          if (media) {
            const releaseHeight = () => { item.style.minHeight = ''; };
            if (media.complete || media.readyState >= 2) {
              releaseHeight();
            } else {
              const evt = media.tagName === 'VIDEO' ? 'loadeddata' : 'load';
              media.addEventListener(evt, releaseHeight, { once: true });
              media.addEventListener('error', releaseHeight, { once: true });
            }
            // Safety fallback
            setTimeout(releaseHeight, 3000);
          }
        }
      }
    }
    this.#rebuildLightboxRefsFromDom();
  }

  /* ═══ API Event Listeners ═══ */

  #attachAPIListeners() {
    this.#detachAPIListeners();

    // On 'executed' (fires per-node): update inline outputs only.
    // Widget sync is NOT done here because control_after_generate hooks
    // run AFTER this event fires.
    this.#executedHandler = () => {
      this.#updateOutputsInPlace();
    };
    this.bridge.onApiEvent('executed', this.#executedHandler);

    // On 'execution_success' (fires once when the whole queue item completes):
    // all control_after_generate hooks have run, so widget values are final.
    // Use requestAnimationFrame to yield after all synchronous post-execution
    // callbacks have settled before reading widget values.
    this.#syncCompleteHandler = () => {
      requestAnimationFrame(() => {
        for (const b of this.bindings) {
          if (b.type === 'number' && b.widget) {
            const cur = b.widget.value;
            if (b.el.value !== String(cur)) b.el.value = cur;
          }
          b.syncExtra?.();
        }
      });
    };
    this.bridge.onApiEvent('execution_success', this.#syncCompleteHandler);

    // Instant sync when DrawerSeed mode changes on canvas
    this.#seedModeHandler = () => {
      for (const b of this.bindings) b.syncExtra?.();
    };
    document.addEventListener('drawer:seed-mode-changed', this.#seedModeHandler);
  }

  /**
   * Lightweight Markdown → HTML renderer.
   * Supports: headers, bold, italic, links, inline code, code blocks, lists, line breaks.
   */
  #renderMarkdown(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Process code blocks first (```...```)
    const codeBlocks = [];
    md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre class="dk-md-code"><code>${esc(code.trimEnd())}</code></pre>`);
      return `\x00CB${idx}\x00`;
    });

    const lines = md.split('\n');
    const out = [];
    let inList = false;
    let listType = '';

    const closePendingList = () => {
      if (inList) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
    };

    const inline = (line) => {
      let s = esc(line);
      // Code blocks placeholder restore
      s = s.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[+i] || '');
      // Inline code
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Bold + Italic
      s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      // Bold
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Italic
      s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
      // Links [text](url)
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      // Auto-link bare URLs
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2">$2</a>');
      return s;
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      // Code block placeholder
      if (/^\x00CB\d+\x00$/.test(line.trim())) {
        closePendingList();
        out.push(codeBlocks[+line.trim().match(/\x00CB(\d+)\x00/)[1]]);
        continue;
      }

      // Headers
      const hm = line.match(/^(#{1,4})\s+(.+)/);
      if (hm) {
        closePendingList();
        const level = hm[1].length;
        out.push(`<h${level + 1}>${inline(hm[2])}</h${level + 1}>`);
        continue;
      }

      // Bullet list
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inList || listType !== 'ul') { closePendingList(); out.push('<ul>'); inList = true; listType = 'ul'; }
        out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
        continue;
      }

      // Numbered list
      if (/^\s*\d+\.\s+/.test(line)) {
        if (!inList || listType !== 'ol') { closePendingList(); out.push('<ol>'); inList = true; listType = 'ol'; }
        out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
        continue;
      }

      closePendingList();

      // Empty line → spacing
      if (!line.trim()) { out.push('<br>'); continue; }

      // Normal paragraph
      out.push(`<p>${inline(line)}</p>`);
    }
    closePendingList();
    return out.join('\n');
  }

  #detachAPIListeners() {
    if (this.#executedHandler) {
      this.bridge.offApiEvent('executed', this.#executedHandler);
      this.#executedHandler = null;
    }
    if (this.#syncCompleteHandler) {
      this.bridge.offApiEvent('execution_success', this.#syncCompleteHandler);
      this.#syncCompleteHandler = null;
    }
    if (this.#seedModeHandler) {
      document.removeEventListener('drawer:seed-mode-changed', this.#seedModeHandler);
      this.#seedModeHandler = null;
    }
  }
}
