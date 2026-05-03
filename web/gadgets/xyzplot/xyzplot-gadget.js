// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  XYZ Plot Gadget — External parameter sweep for any ComfyUI workflow
//  v5: GadgetBase integration for ComfyDrawer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NOTE: app/api no longer imported directly — use this.bridge instead.
// See ARCHITECTURE.md §3 (Dependency Rules) and §4.5 (ComfyUI Integration).
import { GadgetBase } from '../../js/core/gadget-base.js';
import { openLightbox } from '../../js/services/lightbox.js';
import { ContextMenuService } from '../../js/services/context-menu.js';
import { createMediaCard } from '../../js/components/media-card.js';
import { escapeHTML, getLinkedInputNames, CollapseStore, truncate } from '../../js/utils.js';
import { enumerateDrawerControls, isDrawerControlsNode } from '../../js/utils/drawer-controls.js';
import { showAlert, showConfirm, showDialog } from '../../js/services/dialog.js';

const STORAGE_KEY = "comfy-drawer-xyz-plot";

// One-time migration from old comfypilot- localStorage keys
(function migrateOldKeys() {
  const migrations = [
    ["comfypilot-xyz-plot", "comfy-drawer-xyz-plot"],
    ["comfypilot-collapsed", "comfy-drawer-collapsed"],
    ["comfypilot-xyz-hidden-types", "comfy-drawer-xyz-hidden-types"],
  ];
  for (const [oldKey, newKey] of migrations) {
    const val = localStorage.getItem(oldKey);
    if (val !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, val);
      localStorage.removeItem(oldKey);
    }
  }
})();



const XYZ_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 10.5 15 9"/><path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M4.293 19.707 6 18"/><path d="m9 15 1.5-1.5"/></svg>`;
const HIDDEN_NODES_ICON = `<svg class="xyzg-blacklist-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 2 20 20"/><path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58"/><path d="M9.88 4.24A10.8 10.8 0 0 1 12 4c5 0 8.5 4 10 8a13.2 13.2 0 0 1-2.08 3.34"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12c1.5 4 5 8 10 8a10.8 10.8 0 0 0 5.39-1.39"/></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const X_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

export class XYZPlotGadget extends GadgetBase {
  /* ── Private fields ── */
  #startBtn = null;
  #statusEl = null;
  #queueBusy = false;
  #queuePollTimer = null;
  #swapping = false;

  #origQueuePrompt = null;
  #contextMenu = null;
  #collapse = new CollapseStore('comfy-drawer-collapsed');
  #valuesInputHandlers = new Map();

  constructor() {
    super('xyzplot', {
      label: 'XYZ Plot',
      icon: XYZ_ICON,
      order: 1,
      cssUrl: new URL('./xyzplot.css', import.meta.url).href,
    });
    this.running = false;
    this.cancelled = false;
    this.results = [];
    this.enabled = false;  // Disabled on page load; user must explicitly enable
  }

  /** Container-scoped getElementById — prevents ID collisions */
  #q(id) { return this.container?.querySelector(`#${id}`); }

  /* ═══ Lifecycle ═══ */
  onMount(container, bus, bridge) {
    // Register XYZ Plot settings (migrates old ComfyPilot keys)
    this.#registerSettings();

    const ui = this.#buildFullUI();
    container.appendChild(ui);

    // Start / Cancel button
    this.#startBtn = container.querySelector('#xyzg-start');
    this.#statusEl = null;
    this.#queueBusy = false;
    this.#startBtn.addEventListener('click', async () => {
      if (this.running) { this.cancel(); return; }
      // Final check right before starting
      await this.#checkQueueAndUpdateButton();
      if (this.#queueBusy) return;
      this.#showSweepCaution(() => {
        this.enabled = true;
        this.start();
      });
    });

    // Queue poll is started/stopped in onActivate/onDeactivate
    this.addDisposable(() => this.#stopQueuePoll());

    // Cache contextMenu instance (see Gallery pattern)
    this.#contextMenu = window.ComfyDrawer?.contextMenu ?? null;
  }

  onActivate() {
    // Refresh node dropdowns and restore saved selections
    const root = this.container?.querySelector('#xyzg-root');
    if (root) {
      this.#populateNodeDropdowns(root);
      this.#restoreState();
    }
    this.#startQueuePoll();
  }

  onDeactivate() {
    this.#stopQueuePoll();
  }

  #startQueuePoll() {
    this.#stopQueuePoll();
    this.#checkQueueAndUpdateButton();
    this.#queuePollTimer = setInterval(() => this.#checkQueueAndUpdateButton(), 5000);
  }

  #stopQueuePoll() {
    if (this.#queuePollTimer) { clearInterval(this.#queuePollTimer); this.#queuePollTimer = null; }
  }

  onGraphChanged() {
    // Workflow tab switched — refresh everything for the new graph
    const root = this.container?.querySelector('#xyzg-root');
    if (root) {
      this.#populateNodeDropdowns(root);
      this.#restoreState();
      this.#renderBlacklistPanel();
    }
  }

  #updateStartButton() {
    if (!this.#startBtn) return;
    if (this.running) {
      this.#startBtn.innerHTML = `${X_ICON}<span>Cancel</span>`;
      this.#startBtn.classList.add('running');
      this.#startBtn.classList.remove('disabled');
    } else if (this.#queueBusy) {
      this.#startBtn.innerHTML = `${PLAY_ICON}<span>Sweep</span>`;
      this.#startBtn.classList.remove('running');
      this.#startBtn.classList.add('disabled');
    } else {
      this.#startBtn.innerHTML = `${PLAY_ICON}<span>Sweep</span>`;
      this.#startBtn.classList.remove('running', 'disabled');
    }
  }

  /**
   * Check if the ComfyUI queue is empty (no running or pending jobs).
   * Updates the button state and status message accordingly.
   */
  async #checkQueueAndUpdateButton() {
    if (this.running) return; // Don't interfere during a sweep
    try {
      const resp = await fetch('/queue');
      if (!resp.ok) return;
      const data = await resp.json();
      const running = data.queue_running?.length || 0;
      const pending = data.queue_pending?.length || 0;
      this.#queueBusy = running + pending > 0;
      if (this.#queueBusy && this.#statusEl) {
        this.#statusEl.textContent = `Queue busy (${running} running, ${pending} pending) — clear queue to sweep`;
      } else if (!this.running && this.#statusEl) {
        this.#statusEl.textContent = 'Configure axes below';
      }
    } catch (e) {
      // Network error — don't block, just allow
      this.#queueBusy = false;
    }
    this.#updateStartButton();
  }



  // ── localStorage persistence ──────────────────────────────────────────
  #saveState() {
    try {
      const state = {};
      for (const axis of ["x", "y", "z"]) {
        state[axis] = {
          nodeId: this.#q(`xyz-${axis}-node`)?.value || "",
          widgetName: this.#q(`xyz-${axis}-widget`)?.value || "",
          values: this.#q(`xyz-${axis}-values`)?.value || "",
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore */ }
  }

  #loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ── Custom node type blacklist ──────────────────────────────────────
  static BLACKLIST_KEY = "comfy-drawer-xyz-hidden-types";

  #getBlacklist() {
    try {
      return new Set(JSON.parse(localStorage.getItem(XYZPlotGadget.BLACKLIST_KEY) || "[]"));
    } catch { return new Set(); }
  }

  #saveBlacklist(set) {
    localStorage.setItem(XYZPlotGadget.BLACKLIST_KEY, JSON.stringify([...set]));
  }

  #hideNodeType(nodeType) {
    const bl = this.#getBlacklist();
    bl.add(nodeType);
    this.#saveBlacklist(bl);
    this.#refreshAfterBlacklistChange();
  }

  #unhideNodeType(nodeType) {
    const bl = this.#getBlacklist();
    bl.delete(nodeType);
    this.#saveBlacklist(bl);
    this.#refreshAfterBlacklistChange();
  }

  #refreshAfterBlacklistChange() {
    const root = this.container?.querySelector('#xyzg-root');
    if (root) {
      this.#populateNodeDropdowns(root);
      this.#restoreState();
      this.#renderBlacklistPanel();
      this.#populateBlacklistAddDropdown();
    }
  }

  /** Look up a human-readable label for a node type by scanning the workflow */
  #resolveTypeLabel(type) {
    const node = this.bridge.allNodes.find(n => n.type === type);
    if (node && node.title && node.title !== type) {
      return node.title;
    }
    // If the type looks like a UUID, try to find any node that has a
    // more readable comfy_class or constructor name
    if (node && /^[0-9a-f-]{20,}$/i.test(type)) {
      return node.comfyClass || node.constructor?.type || type;
    }
    return type;
  }

  #renderBlacklistPanel() {
    const panel = this.#q('xyzg-blacklist-list');
    if (!panel) return;
    const bl = this.#getBlacklist();
    const countEl = this.#q('xyzg-blacklist-count');

    if (bl.size === 0) {
      if (countEl) countEl.textContent = 'Tap to hide nodes';
      panel.innerHTML = '<span style="opacity:0.5">No hidden node types</span>';
      return;
    }

    if (countEl) {
      countEl.textContent = `${bl.size} hidden node${bl.size === 1 ? '' : 's'}`;
    }

    // Render chips
    panel.innerHTML = '';
    for (const type of [...bl].sort()) {
      const label = this.#resolveTypeLabel(type);
      const item = document.createElement('span');
      item.className = 'xyzg-chip selected';
      item.textContent = label;
      item.style.cursor = 'pointer';
      item.title = `${type}\nClick to restore`;
      item.addEventListener('click', () => this.#unhideNodeType(type));
      panel.appendChild(item);
    }
  }

  #populateBlacklistAddDropdown() {
    const sel = this.#q('xyzg-blacklist-add');
    if (!sel) return;
    const bl = this.#getBlacklist();
    // Collect unique node types — apply the same filters as getAllNodes()
    // so the blacklist candidates always match the XYZ axis node list
    const typeMap = new Map(); // type → display label
    for (const node of this.bridge.allNodes) {
      if (node.mode === 2 || node.mode === 4) continue;
      if (XYZPlotGadget.SKIP_NODE_TYPES.has(node.type)) continue;
      if (bl.has(node.type)) continue;
      if (!typeMap.has(node.type)) {
        typeMap.set(node.type, this.#resolveTypeLabel(node.type));
      }
    }
    sel.innerHTML = '<option value="">— Select node type to hide —</option>';
    // Sort by display label for readability
    const sorted = [...typeMap.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], undefined, { sensitivity: 'base' })
    );
    for (const [type, label] of sorted) {
      const o = document.createElement('option');
      o.value = type;
      o.textContent = label !== type ? `${label}  (${type})` : type;
      sel.appendChild(o);
    }
  }

  #restoreState() {
    const state = this.#loadState();
    if (!state) return;

    for (const axis of ["x", "y", "z"]) {
      const s = state[axis];
      if (!s) continue;
      const nodeSel = this.#q(`xyz-${axis}-node`);
      if (s.nodeId && nodeSel.querySelector(`option[value="${s.nodeId}"]`)) {
        nodeSel.value = s.nodeId;
        this.#onNodeChange(axis);
        const widgetSel = this.#q(`xyz-${axis}-widget`);
        if (s.widgetName && widgetSel.querySelector(`option[value="${s.widgetName}"]`)) {
          widgetSel.value = s.widgetName;
          this.#onWidgetChange(axis);
        }
        this.#q(`xyz-${axis}-values`).value = s.values || "";
        // Re-sync chip states after value restoration
        this.#q(`xyz-${axis}-values`).dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  // Node types that only carry routing metadata — no sweepable parameters
  static SKIP_NODE_TYPES = new Set([
    "SetNode", "GetNode",
    "Set", "Get",
    "Reroute", "ReroutePrimitive",
    "Note", "MarkdownNote", "PrimitiveNode",
    // Display-only nodes — no effect on generation
    "PreviewAny", "PreviewImage", "PreviewVideo",
    "ShowText", "ShowAnything",
  ]);

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Return all sweepable nodes in Deck-like display order:
   *   1. Groups sorted by X position (left → right), tiebreak by Y
   *   2. Nodes within each group sorted by Y (top → bottom)
   *   3. Ungrouped nodes at the end, sorted by Y
   */
  getAllNodes() {
    return this.#getGroupedNodes().flatMap(g => g.nodes);
  }

  /**
   * Return nodes grouped for display: [{title, nodes}, ...]
   * Mirrors DeckGadget's #scanNodes group logic.
   */
  #getGroupedNodes() {
    const userBlacklist = this.#getBlacklist();
    const eligible = [];
    for (const node of this.bridge.allNodes) {
      if (node.mode === 2 || node.mode === 4) continue;
      if (XYZPlotGadget.SKIP_NODE_TYPES.has(node.type)) continue;
      if (userBlacklist.has(node.type)) continue;
      eligible.push(node);
    }

    const posCmpY = (a, b) => {
      const ay = a.pos?.[1] ?? 0, by = b.pos?.[1] ?? 0;
      return (ay - by) || ((a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0));
    };

    const groups = this.bridge.getGroups();
    if (groups.length === 0) {
      // No groups → flat list, sort by Y
      eligible.sort(posCmpY);
      return [{ title: null, nodes: eligible }];
    }

    // Sort groups by X (left → right), tiebreak by Y
    const sortedGroups = [...groups].sort((a, b) => {
      const ap = a._pos ?? a.pos ?? [0, 0];
      const bp = b._pos ?? b.pos ?? [0, 0];
      return (ap[0] - bp[0]) || (ap[1] - bp[1]);
    });

    // Assign eligible nodes to groups (first match wins)
    const eligibleSet = new Set(eligible.map(n => n.id));
    const assigned = new Set();
    const result = [];
    const cleanTitle = (t) => String(t || '')
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1FA00}-\u{1FAFF}]/gu, '')
      .replace(/^\[[^\]]*\]\s*/, '')  // remove [switch] markers
      .replace(/\u26A1\uFE0F?/g, '')  // remove ⚡ toggle markers
      .trim();

    for (const group of sortedGroups) {
      const nodesInGroup = this.bridge.getNodesInGroup(group)
        .filter(n => eligibleSet.has(n.id) && !assigned.has(n.id));
      if (nodesInGroup.length === 0) continue;
      nodesInGroup.sort(posCmpY);
      for (const n of nodesInGroup) assigned.add(n.id);
      result.push({ title: cleanTitle(group.title || 'Group'), nodes: nodesInGroup });
    }

    // Ungrouped nodes at the end
    const ungrouped = eligible.filter(n => !assigned.has(n.id));
    if (ungrouped.length > 0) {
      ungrouped.sort(posCmpY);
      result.push({ title: null, nodes: ungrouped });
    }

    return result;
  }

  getEditableWidgets(node) {
    if (!node || !node.widgets) return [];
    if (isDrawerControlsNode(node)) {
      return enumerateDrawerControls(this.bridge, node).map(control =>
        this.#createDrawerControlWidget(control)
      );
    }
    const linkedInputs = getLinkedInputNames(node);
    return node.widgets.filter(
      w => w.type !== "converted-widget" && !w.hidden
        && !linkedInputs.has(w.name) && !w.name?.startsWith("$$")
    );
  }

  #getWidgetByAxis(axis) {
    const nodeId = this.#q(`xyz-${axis}-node`)?.value;
    const wName = this.#q(`xyz-${axis}-widget`)?.value;
    if (!nodeId || !wName) return null;
    const node = this.bridge.getNodeById(parseInt(nodeId));
    if (isDrawerControlsNode(node)) {
      const control = enumerateDrawerControls(this.bridge, node, { connectedOnly: false })
        .find(c => c.name === wName);
      return control ? this.#createDrawerControlWidget(control) : null;
    }
    return node?.widgets?.find(w => w.name === wName) || null;
  }

  #createDrawerControlWidget(control) {
    const { valueWidget, def, comboOptions } = control;
    const widget = {
      ...valueWidget,
      __drawerControl: true,
      __sourceWidget: valueWidget,
      label: def.label,
      name: valueWidget.name,
      type: def.type === 'combo' ? 'combo' : def.type,
      value: valueWidget.value,
      options: valueWidget.options || {},
    };
    if (def.type === 'int' || def.type === 'float') {
      const n = Number(valueWidget.value || 0);
      widget.value = Number.isFinite(n) ? n : 0;
      widget.options = {
        ...widget.options,
        min: def.min,
        max: def.max,
        step: def.step,
      };
    } else if (def.type === 'bool') {
      widget.value = ['true', '1', 'yes', 'on', 'enabled']
        .includes(String(valueWidget.value ?? '').toLowerCase());
    } else if (def.type === 'combo') {
      const vals = comboOptions.length ? comboOptions : def.fallbackOptions;
      widget.value = String(valueWidget.value ?? '');
      widget.options = { ...widget.options, values: vals };
    } else if (def.type === 'string') {
      widget.value = String(valueWidget.value ?? '');
      widget.type = def.multiline ? 'customtext' : 'text';
      widget.options = { ...widget.options, multiline: def.multiline };
    }
    return widget;
  }

  // Detect if a widget is a "text" type (not combo, not number, not boolean, not button)
  #isTextWidget(widget) {
    if (!widget) return false;
    if (widget.type === "combo" || widget.type === "toggle" || widget.type === "button") return false;
    if (typeof widget.value === "number" || typeof widget.value === "boolean") return false;
    if (typeof widget.value !== "string") return false;
    if (widget.options?.values && Array.isArray(widget.options.values)) return false;
    if (typeof widget.options?.values === "function") return false;
    return true;
  }

  parseValues(str, widget) {
    if (!str.trim()) return [];
    const parts = this.#parseQuotedCSV(str);
    if (typeof widget?.value === "number") {
      return parts.map(v => Number(v)).filter(v => !isNaN(v));
    }
    if (typeof widget?.value === "boolean") {
      return parts.filter(v => v !== '').map(v => v.toLowerCase() === "true" || v === "1");
    }
    // For text (Prompt S/R) and combo: keep all entries including empty strings
    return parts;
  }

  /**
   * A1111-compatible CSV parser for Prompt S/R.
   *
   * Rules (following A1111 X/Y/Z Plot behaviour):
   *  - Commas separate entries.
   *  - A field is "quoted" ONLY when the opening " appears immediately after
   *    a comma (or at the start of the string), with NO leading space.
   *      darkness,"light, green",heat  → 3 items: darkness | light, green | heat  ✓
   *      darkness, "light, green", heat → 4 items (quotes are literal)           ✓
   *  - Inside a quoted field, "" is an escaped double-quote.
   *  - Unquoted values keep all characters (including spaces) as-is.
   */
  #parseQuotedCSV(str) {
    const values = [];
    let i = 0;
    const len = str.length;

    while (i <= len) {
      if (i === len) {
        // End of string — only reached after a trailing comma
        break;
      } else if (str[i] === '"') {
        // ── Quoted field ──
        i++; // skip opening "
        let field = '';
        while (i < len) {
          if (str[i] === '"') {
            if (i + 1 < len && str[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing "
              break;
            }
          } else {
            field += str[i];
            i++;
          }
        }
        values.push(field);
      } else {
        // ── Unquoted field (trim whitespace like A1111) ──
        let field = '';
        while (i < len && str[i] !== ',') {
          field += str[i];
          i++;
        }
        values.push(field.trim());
      }

      // Advance past delimiter
      if (i < len && str[i] === ',') {
        i++;
        // Trailing comma → push empty field
        if (i >= len) values.push('');
      }
    }
    return values;
  }

  // Format value for CSV: quote if contains comma or space
  #quoteIfNeeded(val) {
    const s = String(val);
    return (s.includes(',') || s.includes(' ')) ? `"${s}"` : s;
  }

  // ── Full graph snapshot/restore ────────────────────────────────────────
  static SPECIAL_SEEDS = new Set([-1, -2, -3]);

  #cloneWidgetValue(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === "object") {
      try { return structuredClone(val); } catch { return JSON.parse(JSON.stringify(val)); }
    }
    return val;
  }

  #snapshotAllWidgets() {
    const snapshot = new Map();
    for (const node of this.bridge.allNodes) {
      if (!node.widgets) continue;
      const nodeSnap = new Map();
      nodeSnap.set("__mode__", node.mode);
      for (const w of node.widgets) {
        let val = this.#cloneWidgetValue(w.value);
        if ((w.name === "seed" || w.name === "noise_seed") && typeof val === "number") {
          if (XYZPlotGadget.SPECIAL_SEEDS.has(val)) {
            val = Math.floor(Math.random() * 1125899906842624);
          }
        }
        nodeSnap.set(w.name, val);
      }
      snapshot.set(node.id, nodeSnap);
    }
    return snapshot;
  }

  #snapshotRawWidgets() {
    const snapshot = new Map();
    for (const node of this.bridge.allNodes) {
      if (!node.widgets) continue;
      const nodeSnap = new Map();
      nodeSnap.set("__mode__", node.mode);
      for (const w of node.widgets) {
        nodeSnap.set(w.name, this.#cloneWidgetValue(w.value));
      }
      snapshot.set(node.id, nodeSnap);
    }
    return snapshot;
  }

  #restoreAllWidgets(snapshot) {
    const SEED_NAMES = new Set(["seed", "noise_seed"]);

    // Pass 1: Temporarily force all control_after_generate to "fixed"
    const controlWidgets = [];
    for (const node of this.bridge.allNodes) {
      if (!node?.widgets) continue;
      for (const w of node.widgets) {
        if (w.name === "control_after_generate" && w.value !== "fixed") {
          controlWidgets.push({ widget: w, original: w.value });
          w.value = "fixed";
        }
      }
    }

    // Pass 2: Restore all widget values
    for (const [nodeId, nodeSnap] of snapshot) {
      const node = this.bridge.getNodeById(nodeId);
      if (!node || !node.widgets) continue;
      if (nodeSnap.has("__mode__")) {
        node.mode = nodeSnap.get("__mode__");
      }

      for (const w of node.widgets) {
        if (!nodeSnap.has(w.name)) continue;
        const orig = nodeSnap.get(w.name);

        if (SEED_NAMES.has(w.name)) {
          // Seed: set without callback (callback triggers randomization)
          w.value = orig;
        } else if (w.type === "button") {
          // Skip button widgets entirely; their callbacks are click handlers.
        } else {
          this.bridge.invokeWidgetCallback(node, w, orig);
        }
      }
    }

    // Pass 3: Restore control_after_generate to their original values
    for (const { widget, original } of controlWidgets) {
      widget.value = original;
    }

    this.bridge.setDirtyCanvas(true, true);
  }

  #applyAxisValue(widget, node, value, searchStr, snapshot) {
    if (widget?.__bypass__) {
      // "disabled" = bypass the node (mode 4), "enabled" = run the node (mode 0)
      const newMode = (value === "disabled") ? 4 : 0;
      node.mode = newMode;
      // Notify graph that structure changed so graphToPrompt picks it up
      this.bridge.notifyGraphChanged(true, true);
      return;
    }
    if (this.#isTextWidget(widget) && searchStr) {
      const nodeSnap = snapshot.get(node.id);
      const origText = nodeSnap?.get(widget.name) ?? widget.value;
      const newText = origText.replaceAll(searchStr, value);
      this.#setWidgetValue(widget, node, newText);
    } else {
      this.#setWidgetValue(widget, node, value);
    }
  }

  // ── Build XYZ Plot UI (Gallery-inspired design) ───────────────────────
  #buildFullUI() {
    const root = document.createElement("div");
    root.className = "xyzg-root";
    root.id = "xyzg-root";  // Avoid collision with old MobileUI #xyz-plot-section styles

    // ── Toolbar ──
    const toolbar = document.createElement("div");
    toolbar.className = "xyzg-toolbar";
    toolbar.innerHTML = `
      <div style="flex:1"></div>
      <button class="xyzg-start-btn" id="xyzg-start">${PLAY_ICON}<span>Sweep</span></button>
    `;

    // ── Progress bar ──
    const progress = document.createElement("div");
    progress.className = "xyzg-progress";
    progress.id = "xyz-progress";
    progress.innerHTML = `
      <div class="xyzg-progress-header">
        <span class="xyzg-progress-text" id="xyz-progress-text"></span>
        <span class="xyzg-progress-pct" id="xyz-progress-pct"></span>
      </div>
      <div class="xyzg-progress-track">
        <div class="xyzg-progress-fill" id="xyz-progress-fill"></div>
      </div>
    `;
    root.appendChild(progress);
    root.appendChild(toolbar);

    // ── Content (scrollable area: config + results) ──
    const content = document.createElement("div");
    content.className = "xyzg-content";

    // Axis sections
    content.appendChild(this.#buildAxisSection("x", "X Axis"));
    content.appendChild(this.#buildSwapRow("xy", "X ↔ Y"));
    content.appendChild(this.#buildAxisSection("y", "Y Axis"));
    content.appendChild(this.#buildSwapRow("yz", "Y ↔ Z"));
    content.appendChild(this.#buildAxisSection("z", "Z Axis"));

    // ── Blacklist panel ──
    const blPanel = document.createElement("div");
    blPanel.className = "xyzg-blacklist-panel";
    blPanel.innerHTML = `
      <div class="xyzg-blacklist-toggle" id="xyzg-blacklist-toggle">
        ${HIDDEN_NODES_ICON}<span id="xyzg-blacklist-count">Tap to hide nodes</span>
      </div>
      <div class="xyzg-blacklist-body" id="xyzg-blacklist-body" style="display:none">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
          <select class="xyzg-select" id="xyzg-blacklist-add" style="flex:1;font-size:11px">
            <option value="">— Select node type to hide —</option>
          </select>
          <button class="xyzg-clear-btn" id="xyzg-blacklist-add-btn" style="font-size:11px;padding:4px 10px">+ Hide</button>
        </div>
        <div id="xyzg-blacklist-list" class="xyzg-chips"></div>
      </div>
    `;
    content.appendChild(blPanel);

    blPanel.querySelector('#xyzg-blacklist-toggle').addEventListener('click', () => {
      const body = blPanel.querySelector('#xyzg-blacklist-body');
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : '';
      if (!isOpen) this.#populateBlacklistAddDropdown();
    });

    blPanel.querySelector('#xyzg-blacklist-add-btn').addEventListener('click', () => {
      const sel = blPanel.querySelector('#xyzg-blacklist-add');
      if (sel.value) this.#hideNodeType(sel.value);
    });

    // ── Results section (inline, below config) ──
    const outputSection = document.createElement("div");
    outputSection.className = "xyzg-output-section";
    const grid = document.createElement("div");
    grid.className = "xyzg-grid";
    grid.id = "xyz-grid";
    outputSection.appendChild(grid);
    content.appendChild(outputSection);

    root.appendChild(content);

    // ── Bind events ──
    this.#bindAxisEvents(root);
    // Defer until root is in the DOM (appendChild happens in onMount)
    setTimeout(() => {
      this.#restoreState();
      this.#renderBlacklistPanel();
    }, 0);

    return root;
  }

  #buildAxisSection(axis, label) {
    const sec = document.createElement("div");
    sec.className = `xyzg-axis xyzg-axis-${axis}`;
    sec.id = `xyz-${axis}-section`;
    sec.innerHTML = `
      <div class="xyzg-axis-header" id="xyz-${axis}-toggle">
        <span class="xyzg-axis-title">${label}</span>
        <div class="xyzg-axis-actions">
          <button class="xyzg-clear-btn" id="xyz-${axis}-clear">${X_ICON}<span>Clear</span></button>
          <span class="xyzg-collapse-arrow">▼</span>
        </div>
      </div>
      <div class="xyzg-axis-body" id="xyz-${axis}-body">
        <div class="xyzg-field">
          <label class="xyzg-label">Node</label>
          <select class="xyzg-select" id="xyz-${axis}-node"></select>
        </div>
        <div class="xyzg-field">
          <label class="xyzg-label">Widget</label>
          <select class="xyzg-select" id="xyz-${axis}-widget"></select>
        </div>
        <div class="xyzg-field">
          <label class="xyzg-label">Values <span id="xyz-${axis}-hint" class="xyzg-hint"></span></label>
          <input type="text" class="xyzg-input" id="xyz-${axis}-values">
            <div id="xyz-${axis}-chips" class="xyzg-chips"></div>
        </div>
      </div>
    `;
    return sec;
  }

  #buildSwapRow(id, label) {
    const row = document.createElement("div");
    row.className = "xyzg-swap-row";
    row.innerHTML = `<button class="xyzg-swap-btn" id="xyz-swap-${id}" title="${label}">${label}</button>`;
    return row;
  }

  #bindAxisEvents(root) {
    this.#populateNodeDropdowns(root);

    const autoSave = () => this.#saveState();
    for (const axis of ["x", "y", "z"]) {
      root.querySelector(`#xyz-${axis}-node`).addEventListener("change", () => { this.#onNodeChange(axis); autoSave(); });
      root.querySelector(`#xyz-${axis}-widget`).addEventListener("change", () => { this.#onWidgetChange(axis); autoSave(); });
      root.querySelector(`#xyz-${axis}-values`).addEventListener("input", autoSave);
      root.querySelector(`#xyz-${axis}-clear`).addEventListener("click", (e) => {
        e.stopPropagation();
        this.#q(`xyz-${axis}-node`).value = "";
        this.#q(`xyz-${axis}-widget`).innerHTML = "";
        this.#q(`xyz-${axis}-values`).value = "";
        this.#q(`xyz-${axis}-chips`).innerHTML = "";
        this.#q(`xyz-${axis}-hint`).textContent = "";
        autoSave();
      });
    }

    root.querySelector("#xyz-swap-xy").addEventListener("click", () => { this.#swapAxes("x", "y"); autoSave(); });
    root.querySelector("#xyz-swap-yz").addEventListener("click", () => { this.#swapAxes("y", "z"); autoSave(); });
  }

  // ── Swap two axes ─────────────────────────────────────────────────────
  #swapAxes(a, b) {
    // 1. Save all current values before any DOM manipulation
    const getAxisState = (axis) => ({
      node: this.#q(`xyz-${axis}-node`).value,
      widget: this.#q(`xyz-${axis}-widget`).value,
      values: this.#q(`xyz-${axis}-values`).value,
    });
    const stateA = getAxisState(a);
    const stateB = getAxisState(b);

    // Flag to prevent _onNodeChange/_onWidgetChange from resetting values
    this.#swapping = true;

    // 2. Swap node selections
    this.#q(`xyz-${a}-node`).value = stateB.node;
    this.#q(`xyz-${b}-node`).value = stateA.node;

    // 3. Rebuild widget dropdowns
    this.#onNodeChange(a);
    this.#onNodeChange(b);

    // 4. Restore widget selections
    this.#q(`xyz-${a}-widget`).value = stateB.widget;
    this.#q(`xyz-${b}-widget`).value = stateA.widget;

    // 5. Restore swapped values
    this.#q(`xyz-${a}-values`).value = stateB.values;
    this.#q(`xyz-${b}-values`).value = stateA.values;

    // 6. Refresh chips/hints (without resetting values)
    this.#onWidgetChange(a);
    this.#onWidgetChange(b);

    this.#swapping = false;
  }

  #populateNodeDropdowns(root) {
    const grouped = this.#getGroupedNodes();
    for (const axis of ["x", "y", "z"]) {
      const sel = root.querySelector(`#xyz-${axis}-node`);
      sel.innerHTML = '<option value="">(None)</option>';

      for (const group of grouped) {
        if (group.title) {
          // Grouped nodes → use <optgroup> for visual separation
          const og = document.createElement('optgroup');
          og.label = group.title;
          for (const node of group.nodes) {
            const displayTitle = node.title || node.type;
            const o = document.createElement('option');
            o.value = String(node.id);
            o.textContent = `${displayTitle} [#${node.id}]`;
            og.appendChild(o);
          }
          sel.appendChild(og);
        } else {
          // Ungrouped nodes → flat options
          for (const node of group.nodes) {
            const displayTitle = node.title || node.type;
            const o = document.createElement('option');
            o.value = String(node.id);
            o.textContent = `${displayTitle} [#${node.id}]`;
            sel.appendChild(o);
          }
        }
      }
    }
  }

  #onNodeChange(axis) {
    const nodeId = this.#q(`xyz-${axis}-node`).value;
    const widgetSel = this.#q(`xyz-${axis}-widget`);
    widgetSel.innerHTML = "";
    this.#q(`xyz-${axis}-chips`).innerHTML = "";
    this.#q(`xyz-${axis}-hint`).textContent = "";
    if (!this.#swapping) this.#q(`xyz-${axis}-values`).value = "";

    if (!nodeId) return;
    const node = this.bridge.getNodeById(parseInt(nodeId));
    if (!node) return;

    const widgets = this.getEditableWidgets(node);
    for (const w of widgets) {
      const o = document.createElement("option");
      o.value = w.name;
      const displayName = w.label || w.name;
      let preview = (typeof w.value === "object" && w.value !== null)
        ? JSON.stringify(w.value)
        : String(w.value);
      if (preview.length > 30) preview = preview.substring(0, 30) + "…";
      o.textContent = `${displayName} (= ${preview})`;
      widgetSel.appendChild(o);
    }

    // Add virtual "Bypass" option at the bottom (works for any node)
    const bypassOpt = document.createElement("option");
    bypassOpt.value = "__bypass__";
    bypassOpt.textContent = `Bypass(=${node.mode === 4 ? "bypassed" : "enabled"})`;
    widgetSel.appendChild(bypassOpt);

    // Auto-select first and trigger change
    widgetSel.value = widgetSel.options[0]?.value || "";
    this.#onWidgetChange(axis);
  }

  #onWidgetChange(axis) {
    const widgetName = this.#q(`xyz-${axis}-widget`)?.value;
    const chipsEl = this.#q(`xyz-${axis}-chips`);
    const hintEl = this.#q(`xyz-${axis}-hint`);
    const valuesInput = this.#q(`xyz-${axis}-values`);
    const prevHandler = this.#valuesInputHandlers.get(axis);
    if (prevHandler) {
      valuesInput.removeEventListener("input", prevHandler);
      this.#valuesInputHandlers.delete(axis);
    }
    chipsEl.innerHTML = "";
    hintEl.textContent = "";
    if (!this.#swapping) valuesInput.value = "";  // Reset values on widget change

    // ── Virtual bypass widget → auto-fill ──
    if (widgetName === "__bypass__") {
      hintEl.textContent = "(disabled = skip node, enabled = active)";
      if (!this.#swapping) valuesInput.value = "disabled,enabled";
      return;
    }

    const widget = this.#getWidgetByAxis(axis);
    if (!widget) return;

    // ── Text widget → S/R hint only (no chips) ──
    if (this.#isTextWidget(widget)) {
      hintEl.textContent = `(Prompt S/R: 1st = search, rest = replace)`;
    }
    // ── Combo widget → show clickable option chips ──
    else if (widget.type === "combo") {
      const vals = typeof widget.options?.values === "function"
        ? widget.options.values()
        : widget.options?.values || [];
      if (vals.length > 0) {
        hintEl.textContent = `(${vals.length} options — click to toggle)`;
        for (const v of vals) {
          const chip = document.createElement("span");
          chip.className = "xyzg-chip";
          chip.textContent = v;
          chip.dataset.value = v;
          this.#syncChipState(chip, valuesInput);
          chip.addEventListener("click", () => {
            this.#toggleChipValue(chip, valuesInput, axis);
          });
          chipsEl.appendChild(chip);
        }
        const onValuesInput = () => {
          // Sync selected state for all chips
          for (const c of chipsEl.querySelectorAll(".xyzg-chip")) {
            this.#syncChipState(c, valuesInput);
          }

          // Filter chips by current typing segment (after last comma)
          const raw = valuesInput.value;
          const lastSep = raw.lastIndexOf(",");
          const currentSegment = (lastSep >= 0 ? raw.substring(lastSep + 1) : raw).trim().toLowerCase();
          // If last segment exactly matches a chip value, it's a completed entry → show all
          const isExactMatch = currentSegment && vals.some(v => v.toLowerCase() === currentSegment);

          for (const c of chipsEl.querySelectorAll(".xyzg-chip")) {
            const isSelected = c.classList.contains("selected");
            if (!currentSegment || isExactMatch || isSelected) {
              c.style.display = "";  // Show selected chips and all when no search or exact match
            } else {
              const match = c.dataset.value.toLowerCase().includes(currentSegment);
              c.style.display = match ? "" : "none";
            }
          }

          // Update hint with filter count
          const visibleCount = chipsEl.querySelectorAll('.xyzg-chip:not([style*="display: none"])').length;
          if (currentSegment && !isExactMatch && visibleCount < vals.length) {
            hintEl.textContent = `(${visibleCount} / ${vals.length} matching "${currentSegment}")`;
          } else {
            hintEl.textContent = `(${vals.length} options — click to toggle)`;
          }
        };
        valuesInput.addEventListener("input", onValuesInput);
        this.#valuesInputHandlers.set(axis, onValuesInput);
      }
    }
    // ── Number widget → hint only (no chips) ──
    else if (typeof widget.value === "number") {
      const opts = widget.options || {};
      const parts = [];
      if (opts.min !== undefined) parts.push(`min: ${opts.min} `);
      if (opts.max !== undefined) parts.push(`max: ${opts.max} `);
      if (opts.step !== undefined) parts.push(`step: ${opts.step} `);
      parts.push(`current: ${widget.value} `);
      hintEl.textContent = `(${parts.join(", ")})`;
    }
    // ── Boolean widget → auto-fill false,true ──
    else if (typeof widget.value === "boolean") {
      hintEl.textContent = `(current: ${widget.value})`;
      if (!this.#swapping) valuesInput.value = "false,true";
    }
  }

  #syncChipState(chip, valuesInput) {
    const current = this.#parseQuotedCSV(valuesInput.value).filter(v => v !== '');
    chip.classList.toggle("selected", current.includes(chip.dataset.value));
  }

  #toggleChipValue(chip, valuesInput, axis) {
    const val = chip.dataset.value;
    let current = this.#parseQuotedCSV(valuesInput.value).filter(v => v !== '');
    if (current.includes(val)) {
      current = current.filter(v => v !== val);
      chip.classList.remove("selected");
    } else {
      current.push(val);
      chip.classList.add("selected");
    }
    const joined = current.map(v => this.#quoteIfNeeded(v)).join(",");
    // Trailing comma only for first value (to prompt searching for the next one);
    // 2+ values are ready as-is — no trailing comma to manually delete.
    valuesInput.value = joined ? (current.length === 1 ? joined + "," : joined) : "";
    // Trigger input event to update chip filter/visibility
    valuesInput.dispatchEvent(new Event("input", { bubbles: true }));
    this.#saveState();
  }

  #generateNumberSuggestions(widget) {
    const opts = widget.options || {};
    const min = opts.min ?? 0;
    const max = opts.max ?? 100;
    const step = opts.step ?? 1;
    const current = widget.value;
    const range = max - min;
    if (range <= 0) return [current];

    const suggestions = new Set();
    suggestions.add(current);

    if (step >= 1 && range <= 100) {
      suggestions.add(min);
      suggestions.add(max);
      const numSteps = Math.min(6, Math.floor(range / step));
      for (let i = 1; i < numSteps; i++) {
        suggestions.add(min + Math.round((range * i / numSteps) / step) * step);
      }
    } else if (step < 1) {
      suggestions.add(min);
      suggestions.add(max);
      const prec = Math.max(1, -Math.floor(Math.log10(step)));
      for (let i = 1; i <= 4; i++) {
        suggestions.add(parseFloat((min + (range * i / 5)).toFixed(prec)));
      }
    }
    return [...suggestions].sort((a, b) => a - b);
  }
  // ── Pre-sweep validation ────────────────────────────────────────────
  #validateAxisValues(axisLabel, widget, values, searchStr) {
    const warnings = [];
    if (!widget) return warnings;

    // Number widget: check min/max
    if (typeof widget.value === "number") {
      const opts = widget.options || {};
      for (const v of values) {
        if (typeof v !== "number" || isNaN(v)) {
          warnings.push(`${axisLabel}: "${v}" is not a valid number`);
          continue;
        }
        if (opts.min !== undefined && v < opts.min) {
          warnings.push(`${axisLabel}: ${v} is below minimum(${opts.min})`);
        }
        if (opts.max !== undefined && v > opts.max) {
          warnings.push(`${axisLabel}: ${v} exceeds maximum(${opts.max})`);
        }
      }
    }

    // Combo widget: check if value exists in options
    if (widget.type === "combo") {
      const opts = typeof widget.options?.values === "function"
        ? widget.options.values()
        : widget.options?.values || [];
      if (opts.length > 0) {
        for (const v of values) {
          if (!opts.includes(v)) {
            warnings.push(`${axisLabel}: "${v}" is not a valid option`);
          }
        }
      }
    }

    // Text widget (S/R): check anchor exists in current text
    if (this.#isTextWidget(widget) && searchStr) {
      if (!String(widget.value).includes(searchStr)) {
        warnings.push(`${axisLabel}: S / R anchor "${searchStr.substring(0, 30)}" not found in current text`);
      }
    }

    // Boolean: check valid values
    if (typeof widget.value === "boolean") {
      for (const v of values) {
        if (typeof v !== "boolean") {
          warnings.push(`${axisLabel}: "${v}" is not a valid boolean`);
        }
      }
    }

    return warnings;
  }

  // ── Start execution ──────────────────────────────────────────────────
  async start() {
    // ── Parse all 3 axes ──
    const axes = {};
    for (const axis of ["x", "y", "z"]) {
      const nodeId = this.#q(`xyz-${axis}-node`).value;
      const widgetName = this.#q(`xyz-${axis}-widget`).value;
      const valuesStr = this.#q(`xyz-${axis}-values`).value;
      axes[axis] = { nodeId, widgetName, valuesStr };
    }

    // At least one axis must be configured
    const hasAnyAxis = ["x", "y", "z"].some(
      a => axes[a].nodeId && axes[a].widgetName && axes[a].valuesStr.trim()
    );
    if (!hasAnyAxis) {
      await showAlert("At least one axis must be configured with values.", { variant: 'warning' });
      return;
    }

    // Helper to resolve axis (supports __bypass__ virtual widget)
    const resolveAxis = async (axis, label, required) => {
      const a = axes[axis];
      if (!a.nodeId || !a.widgetName || !a.valuesStr.trim()) {
        if (required) return null; // error
        return { node: null, widget: null, values: [null], search: "" };
      }
      const node = this.bridge.getNodeById(parseInt(a.nodeId));
      if (!node) { await showAlert(`${label} node not found!`, { variant: 'warning' }); return null; }

      if (a.widgetName === "__bypass__") {
        // Virtual bypass widget
        const values = a.valuesStr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        if (values.length === 0) { await showAlert(`No valid ${label} values.`, { variant: 'warning' }); return null; }
        return { node, widget: { __bypass__: true, name: "__bypass__" }, values, search: "" };
      }

      const widget = isDrawerControlsNode(node)
        ? enumerateDrawerControls(this.bridge, node, { connectedOnly: false })
            .map(control => this.#createDrawerControlWidget(control))
            .find(w => w.name === a.widgetName)
        : node.widgets?.find(w => w.name === a.widgetName);
      if (!widget) { await showAlert(`${label} widget not found!`, { variant: 'warning' }); return null; }
      const values = this.parseValues(a.valuesStr, widget);
      if (values.length === 0) { await showAlert(`No valid ${label} values.`, { variant: 'warning' }); return null; }

      // S/R validation for text widgets
      if (this.#isTextWidget(widget)) {
        if (values[0] === '') {
          await showAlert(`${label}: Prompt S/R search term (1st value) cannot be empty.`, { variant: 'warning' });
          return null;
        }
        if (values.length < 2) {
          await showAlert(`${label}: Prompt S/R requires at least 2 values (search, replace).`, { variant: 'warning' });
          return null;
        }
      }

      const search = this.#isTextWidget(widget) ? String(values[0]) : "";
      return { node, widget, values, search };
    };

    // Resolve X (optional — same as Y/Z)
    const xRes = await resolveAxis("x", "X Axis", false);
    if (xRes === null) return;
    const { node: xNode, widget: xWidget, values: xValues, search: xSearch } = xRes;

    // Resolve Y (optional)
    const yRes = await resolveAxis("y", "Y Axis", false);
    if (yRes === null) return;
    const { node: yNode, widget: yWidget, values: yValues, search: ySearch } = yRes;

    // Resolve Z (optional)
    const zRes = await resolveAxis("z", "Z Axis", false);
    if (zRes === null) return;
    const { node: zNode, widget: zWidget, values: zValues, search: zSearch } = zRes;

    const fmtName = (n) => n === "__bypass__" ? "Bypass" : n;
    const fmtLabel = (axis, widget) => {
      if (widget?.__bypass__) return 'Bypass';
      // Prefer widget.label (display name) over widget.name (internal name)
      return widget?.label || widget?.name || fmtName(axes[axis].widgetName);
    };
    const xLabel = fmtLabel('x', xWidget);
    const yLabel = fmtLabel('y', yWidget);
    const zLabel = fmtLabel('z', zWidget);
    const xWidgetName = fmtName(axes.x.widgetName);
    const yWidgetName = fmtName(axes.y.widgetName);
    const zWidgetName = fmtName(axes.z.widgetName);

    // ── Pre-sweep validation (skip bypass virtual widgets) ──
    const warnings = [
      ...(xWidget && !xWidget.__bypass__ ? this.#validateAxisValues("X", xWidget, xValues, xSearch) : []),
      ...(yWidget && !yWidget.__bypass__ ? this.#validateAxisValues("Y", yWidget, yValues, ySearch) : []),
      ...(zWidget && !zWidget.__bypass__ ? this.#validateAxisValues("Z", zWidget, zValues, zSearch) : []),
    ];

    const total = xValues.length * yValues.length * zValues.length;

    if (warnings.length > 0) {
      const msg = `Validation warnings:\n\n${warnings.join("\n")}\n\nTotal jobs: ${total}\nProceed anyway?`;
      if (!await showConfirm(msg, { variant: 'warning' })) return;
    } else if (total > 10) {
      // Confirm large jobs even without warnings
      if (!await showConfirm(`This will run ${total} generations. Proceed?`, { variant: 'warning' })) return;
    }

    // ★ Snapshot ALL widget values
    const originalSnapshot = this.#snapshotRawWidgets();

    // Pre-randomize DrawerSeed nodes in "randomize" mode before pinning.
    // Normally DrawerSeed randomizes inside the queuePrompt hook, but the
    // pinnedSnapshot is taken before any queue call. Without this step,
    // repeated sweeps would always reuse the same seed_value.
    const sweepWidgets = [xWidget, yWidget, zWidget].filter(Boolean);
    for (const node of this.bridge.allNodes) {
      if (node.type !== 'DrawerSeed') continue;
      const modeW = node.widgets?.find(w => w.name === 'mode');
      const seedW = node.widgets?.find(w => w.name === 'seed_value');
      if (modeW?.value === 'randomize' && seedW && !sweepWidgets.includes(seedW)) {
        seedW.value = Math.floor(Math.random() * 0xFFFFFFFF);
      }
    }

    const pinnedSnapshot = this.#snapshotAllWidgets();

    this.running = true;
    this.#updateStartButton();
    this.cancelled = false;
    this.results = [];
    let completed = 0;

    // Prevent DrawerSeed's queuePrompt hook from re-randomizing seeds
    window.__xyzSweepActive = true;

    // ── Block ComfyUI interactions during sweep ──
    // Covers the entire viewport below the Drawer (z-index 9990 < Drawer's 9995)
    // to prevent workflow tab switching, node editing, etc.
    const sweepOverlay = document.createElement('div');
    sweepOverlay.className = 'xyz-sweep-overlay';
    sweepOverlay.innerHTML = `<div class="xyz-sweep-overlay-msg">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
      <span>XYZ Sweep in progress…</span>
    </div>`;
    document.body.appendChild(sweepOverlay);

    // ── Lock the queue: prevent external prompts during sweep ──
    // NOTE: This is a justified escape hatch — monkey-patching queuePrompt
    // requires direct app access. See ARCHITECTURE.md "Bridge Boundary".
    const appRef = this.bridge.app;
    const origQueuePrompt = appRef.queuePrompt.bind(appRef);
    this.#origQueuePrompt = origQueuePrompt;
    appRef.queuePrompt = (...args) => {
      console.warn("[XYZ Plot] Queue blocked — sweep in progress");
      return Promise.resolve();
    };

    // ── Guard: cancel sweep if a workflow is loaded/opened ──
    // Listen for drawer:graph-configured (fired by LGraph.configure hook)
    // instead of monkey-patching loadGraphData which can interfere with serialization.
    const onGraphConfigured = () => {
      console.warn("[XYZ Plot] Workflow changed during sweep — cancelling");
      this.cancelled = true;
      this.bridge.interrupt();
    };
    document.addEventListener('drawer:graph-configured', onGraphConfigured);

    // -- Block D&D workflow loading during sweep --
    // OS-level file drops (dragging .json from file explorer) fire on document,
    // so we intercept at capture phase before ComfyUI's listeners can handle them.
    const blockDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; };
    const blockFileDrop = (e) => { e.preventDefault(); e.stopPropagation(); };
    document.addEventListener('dragover', blockDragOver, true);
    document.addEventListener('drop',     blockFileDrop,  true);

    // Use gadget-local progress bar
    const progressEl = this.#q("xyz-progress");
    const progressFill = this.#q("xyz-progress-fill");
    const progressPct = this.#q("xyz-progress-pct");
    const progressText = this.#q("xyz-progress-text");
    const statusEl = this.#statusEl;
    if (progressEl) progressEl.classList.add('active');
    progressFill.style.width = "0%";
    progressPct.textContent = `0 / ${total} `;
    progressText.textContent = "XYZ Plot starting...";
    if (statusEl) statusEl.textContent = `Running ${total} jobs...`;
    this.#q("xyz-grid").innerHTML = "";

    // ── Render initial grid with all cells as ⏳ ──
    this.#renderGrid(xValues, yValues, zValues, xLabel, yLabel, zLabel);

    try {
      for (const zVal of zValues) {
        for (const yVal of yValues) {
          for (const xVal of xValues) {
            if (this.cancelled) break;

            // ★ Restore ALL widgets to pinned snapshot (fixed seeds)
            this.#restoreAllWidgets(pinnedSnapshot);

            // ★ Apply axis values
            if (xWidget && xVal !== null) {
              this.#applyAxisValue(xWidget, xNode, xVal, xSearch, pinnedSnapshot);
            }
            if (yWidget && yVal !== null) {
              this.#applyAxisValue(yWidget, yNode, yVal, ySearch, pinnedSnapshot);
            }
            if (zWidget && zVal !== null) {
              this.#applyAxisValue(zWidget, zNode, zVal, zSearch, pinnedSnapshot);
            }

            // Safety: force batch_size=1 and control_after_generate="fixed"
            // to keep standard KSampler seeds stable across sweep iterations.
            // DrawerSeed mode is NOT forced — its queuePrompt hook is disabled
            // via the __xyzSweepActive flag, so mode can stay as-is for
            // correct metadata recording.
            for (const node of this.bridge.allNodes) {
              if (!node.widgets) continue;
              for (const w of node.widgets) {
                if (w.name === "batch_size" && !sweepWidgets.includes(w) && w.value !== 1) {
                  w.value = 1;
                }
                if (w.name === "control_after_generate" && !sweepWidgets.includes(w)) {
                  w.value = "fixed";
                }
              }
            }

            const parts = [];
            if (xVal !== null) parts.push(`X=${xVal}`);
            if (yVal !== null) parts.push(`Y=${yVal}`);
            if (zVal !== null) parts.push(`Z=${zVal}`);
            progressText.textContent =
              `XYZ ${completed + 1}/${total}: ${parts.join(' | ')}`;
            progressFill.style.width =
              Math.round((completed / total) * 100) + "%";
            progressPct.textContent =
              `${completed}/${total}`;

            const images = await this.#queueAndWaitForImages();
            this.results.push({ x: xVal, y: yVal, z: zVal, images });
            completed++;

            this.#renderGrid(xValues, yValues, zValues, xLabel, yLabel, zLabel);
          }
          if (this.cancelled) break;
        }
        if (this.cancelled) break;
      }
    } finally {
      // ── Unlock the queue & remove graph change guard ──
      appRef.queuePrompt = origQueuePrompt;
      this.#origQueuePrompt = null;
      document.removeEventListener('drawer:graph-configured', onGraphConfigured);
      document.removeEventListener('dragover', blockDragOver, true);
      document.removeEventListener('drop',     blockFileDrop,  true);
      window.__xyzSweepActive = false;
      sweepOverlay.remove();

      // ★ Capture workflow JSON BEFORE restoring original snapshot.
      // The pinned seed values are still active at this point, so the
      // exported workflow will contain the actual seeds used for generation
      // (not the pre-sweep originals that would be recorded after restore).
      let capturedWorkflowJson = null;
      if (completed > 0 && !this.cancelled) {
        const saveMeta = this.bridge.getSetting("ComfyDrawer.XYZ.SaveMetadata", true);
        if (saveMeta) {
          try { capturedWorkflowJson = JSON.stringify(this.bridge.exportWorkflow()); } catch (e) { /* ignore */ }
        }
      }

      // Restore to ORIGINAL state (including seed=-1 randomize mode)
      this.#restoreAllWidgets(originalSnapshot);

      this.running = false;
      this.#updateStartButton();
      progressFill.style.width = "100%";
      progressPct.textContent = `${completed}/${total}`;
      progressText.textContent =
        this.cancelled ? "XYZ Cancelled" : `XYZ Done! ${total} images`;
      if (statusEl) statusEl.textContent = this.cancelled ? 'Cancelled' : `Done — ${total} images`;

      // Build composite image(s) when done
      if (completed > 0 && !this.cancelled) {
        this.#buildCompositeImage(xValues, yValues, zValues, xLabel, yLabel, zLabel, capturedWorkflowJson);
      }
    }
  }

  cancel() {
    this.cancelled = true;
    this.bridge.interrupt();
  }

  // ── Pre-sweep caution dialog (dismissable) ──
  async #showSweepCaution(onProceed) {
    const LS_KEY = 'xyz-sweep-caution-dismissed';
    if (localStorage.getItem(LS_KEY) === '1') {
      onProceed();
      return;
    }

    const result = await showDialog({
      title: 'XYZ Sweep \u306b\u3064\u3044\u3066',
      variant: 'warning',
      showCancel: true,
      cancelLabel: 'Cancel',
      confirmLabel: 'Start Sweep',
      content: (bodyEl) => {
        bodyEl.innerHTML = `
          <p style="margin:0 0 10px">
            XYZ Plot \u306f\u73fe\u5728\u958b\u3044\u3066\u3044\u308b\u30ef\u30fc\u30af\u30d5\u30ed\u30fc\u306e\u30d1\u30e9\u30e1\u30fc\u30bf\u3092\u64cd\u4f5c\u3057\u3001\u9023\u7d9a\u7684\u306b\u30ad\u30e5\u30fc\u3059\u308b\u30ac\u30b8\u30a7\u30c3\u30c8\u3067\u3059\u3002
          </p>
          <p style="margin:0 0 8px">
            &bull; \u30b9\u30a4\u30fc\u30d7\u4e2d\u306f<b>\u30d1\u30e9\u30e1\u30fc\u30bf\u3092\u64cd\u4f5c\u3057\u306a\u3044\u3067\u304f\u3060\u3055\u3044</b>\u3002\u4e88\u671f\u305b\u306c\u52d5\u4f5c\u3092\u5f15\u304d\u8d77\u3053\u3059\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002
          </p>
          <p style="margin:0 0 8px">
            &bull; \u30b9\u30a4\u30fc\u30d7\u4e2d\u306b<b>\u30ef\u30fc\u30af\u30d5\u30ed\u30fc\u304c\u958b\u304b\u308c\u305f\u5834\u5408</b>\u3001\u5b89\u5168\u306e\u305f\u3081\u30b9\u30a4\u30fc\u30d7\u3092\u505c\u6b62\u3057\u307e\u3059\u3002
          </p>
          <p style="margin:0 0 16px; font-size:12px">
            &bull; ComfyUI\u306e\u30ad\u30e3\u30f3\u30d0\u30b9\u306f\u30b9\u30a4\u30fc\u30d7\u4e2d\u30ed\u30c3\u30af\u3055\u308c\u307e\u3059\u3002
          </p>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
            <input type="checkbox" id="xyzg-caution-skip" style="accent-color:var(--cd-accent)">
            \u6b21\u56de\u4ee5\u964d\u8868\u793a\u3057\u306a\u3044
          </label>
        `;
        return () => ({ skip: bodyEl.querySelector('#xyzg-caution-skip')?.checked ?? false });
      },
    });

    if (result !== null) {
      if (result.skip) localStorage.setItem(LS_KEY, '1');
      onProceed();
    }
  }

  // Notify Workflow Operator of state change via bus
  #updateHeaderButton() {
    this.bus?.emit('xyz:stateChanged', { enabled: this.enabled });
  }

  #setWidgetValue(widget, node, value) {
    const targetWidget = widget.__sourceWidget || widget;
    this.bridge.invokeWidgetCallback(node, targetWidget, value);
  }

  #queueAndWaitForImages() {
    return new Promise((resolve) => {
      const collectedImages = [];
      let settled = false;

      const finish = () => {
        if (settled) return; // Guard: resolve only once
        settled = true;
        cleanup();
        clearTimeout(safetyTimer);
        const lastImage = collectedImages.length > 0
          ? collectedImages[collectedImages.length - 1] : null;
        resolve(lastImage ? [lastImage] : []);
      };

      const onExecuted = ({ detail }) => {
        if (detail?.output?.images) {
          for (const img of detail.output.images) collectedImages.push(img);
        }
        if (detail?.output?.gifs) {
          for (const gif of detail.output.gifs) collectedImages.push(gif);
        }
      };

      const onExecuting = ({ detail }) => {
        if (detail === null) finish();
      };

      // Detect server disconnect to fail fast instead of waiting 10min
      const onStatus = ({ detail }) => {
        if (detail === null) {
          console.warn("[XYZ Plot] Server disconnected — aborting iteration");
          this.cancelled = true;
          finish();
        }
      };
      const onReconnecting = () => {
        console.warn("[XYZ Plot] WebSocket reconnecting — aborting iteration");
        this.cancelled = true;
        finish();
      };

      const cleanup = () => {
        this.bridge.offApiEvent("executed", onExecuted);
        this.bridge.offApiEvent("executing", onExecuting);
        this.bridge.offApiEvent("status", onStatus);
        this.bridge.offApiEvent("reconnecting", onReconnecting);
      };

      this.bridge.onApiEvent("executed", onExecuted);
      this.bridge.onApiEvent("executing", onExecuting);
      this.bridge.onApiEvent("status", onStatus);
      this.bridge.onApiEvent("reconnecting", onReconnecting);

      // Safety timeout: resolve after 10 minutes to prevent hanging
      const safetyTimer = setTimeout(finish, 600000);

      // Use the saved original queuePrompt to bypass our own lock
      const queueFn = this.#origQueuePrompt || this.bridge.app.queuePrompt.bind(this.bridge.app);
      queueFn(0, 1).catch(() => finish());
    });
  }

  // ── Render result grid (per-Z page) ───────────────────────────────────
  #renderGrid(xValues, yValues, zValues, xLabel, yLabel, zLabel) {
    const container = this.#q("xyz-grid");
    const hasX = xValues.length > 1 || xValues[0] !== null;
    const hasY = yValues.length > 1 || yValues[0] !== null;
    const hasZ = zValues.length > 1 || zValues[0] !== null;
    const dataCols = xValues.length;
    const totalCols = hasY ? dataCols + 1 : dataCols;

    const makeImgURL = (f) =>
      this.bridge.getImageUrl(f.filename, f.subfolder || '', f.type || 'output', { bustCache: true });


    let html = "";

    for (const zv of zValues) {
      // Z page header
      if (hasZ) {
        html += `<div style="text-align:center;color:#ff8c42;font-size:13px;font-weight:600;margin:16px 0 8px;padding:8px;background:var(--cd-s2);border-radius:8px">
          ${escapeHTML(zLabel)} = ${escapeHTML(truncate(zv, 40))}
        </div>`;
      }

      html += `<div class="xyz-grid-container" style="overflow-x:auto">`;
      html += `<table style="border-collapse:collapse;width:100%;table-layout:fixed">`;

      // Header rows — only show when X axis is configured
      if (hasX) {
        // Axis name row — corner cell shows both axis directions
        html += `<tr>`;
        if (hasY) {
          html += `<th style="color:var(--cd-text-dim);font-size:10px;padding:6px 8px;text-align:center;width:${Math.round(100 / totalCols)}%;vertical-align:middle">
            <span style="color:var(--cd-accent)">${escapeHTML(yLabel)}</span>
            <span style="color:var(--cd-text-dim)"> ↓</span>
          </th>`;
        }
        html += `<th colspan="${dataCols}" style="color:var(--cd-accent, #00d4ff);font-size:10px;padding:6px 8px;text-align:center;opacity:0.8">${escapeHTML(xLabel)} →</th>`;
        html += `</tr>`;

        // Value header row (X values)
        html += `<tr>`;
        if (hasY) html += `<th style="width:${Math.round(100 / totalCols)}%"></th>`;
        for (const xv of xValues) {
          html += `<th style="color:var(--cd-accent, #00d4ff);font-size:11px;padding:4px 8px;text-align:center;width:${Math.round(100 / totalCols)}%" title="${escapeHTML(xv)}">${escapeHTML(truncate(xv))}</th>`;
        }
        html += `</tr>`;
      } else if (hasY) {
        // Y-only: show Y axis label header
        html += `<tr><th style="color:var(--cd-accent);font-size:10px;padding:6px 8px;text-align:center;opacity:0.8">${escapeHTML(yLabel)} ↓</th><th></th></tr>`;
      }

      for (const yv of yValues) {
        html += `<tr>`;
        if (hasY) html += `<td style="color:var(--cd-accent);font-size:11px;padding:4px 8px;vertical-align:middle;font-weight:600" title="${escapeHTML(yv ?? '')}">${escapeHTML(truncate(yv ?? ''))}</td>`;
        for (const xv of xValues) {
          const result = this.results.find(r => r.x === xv && r.y === yv && r.z === zv);
          html += `<td style="padding:4px;text-align:center;vertical-align:middle">`;
          if (result && result.images.length > 0) {
            const img = result.images[0];
            const url = makeImgURL(img);
            const isVideo = /\.(mp4|webm|mkv)$/i.test(img.filename);
            // Placeholder cell — will be filled with createMediaCard after innerHTML
            const cellId = `xyz-cell-${zValues.indexOf(zv)}-${yValues.indexOf(yv)}-${xValues.indexOf(xv)}`;
            html += `<div id="${cellId}" data-url="${escapeHTML(url)}" data-filename="${escapeHTML(img.filename)}" data-subfolder="${escapeHTML(img.subfolder || '')}" data-source="${escapeHTML(img.type || 'output')}" data-media="${isVideo ? 'video' : 'image'}" class="xyz-cell-placeholder"></div>`;
          } else if (result) {
            html += `<div style="color:var(--cd-danger);font-size:11px">No output</div>`;
          } else {
            html += `<div style="color:var(--cd-text-dim);display:flex;align-items:center;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg></div>`;
          }
          html += `</td>`;
        }
        html += `</tr>`;
      }

      html += `</table>`;
      html += `</div>`;
    }

    container.innerHTML = html;

    // Populate placeholder cells with createMediaCard
    const placeholders = [...container.querySelectorAll('.xyz-cell-placeholder')];
    const ctxMenu = this.#contextMenu;

    // Build lightbox items from all placeholders
    const lbItems = placeholders.map((ph, i) => ({
      src: ph.dataset.url,
      type: ph.dataset.media || 'image',
      label: `Cell ${i + 1} / ${placeholders.length}`,
      name: ph.dataset.filename,
      subfolder: ph.dataset.subfolder || '',
      source: ph.dataset.source || 'temp',
    }));

    placeholders.forEach((ph, idx) => {
      const mc = createMediaCard({
        src: ph.dataset.url,
        filename: ph.dataset.filename,
        subfolder: ph.dataset.subfolder || '',
        type: ph.dataset.source || 'output',
        mediaType: ph.dataset.media || 'image',
        thumbHeight: null,
        lightboxItems: lbItems,
        lightboxIndex: idx,
        onContextMenu: ctxMenu ? (e) => {
          ctxMenu.show('media-file', {
            src: ph.dataset.url,
            type: ph.dataset.media || 'image',
            name: ph.dataset.filename,
            subfolder: ph.dataset.subfolder || '',
            source: ph.dataset.source || 'temp',
          }, e.clientX, e.clientY);
        } : null,
      });
      // Style for table cell: full-width, no fixed height
      mc.element.style.width = '100%';
      mc.info.style.display = 'none'; // No info row for grid cells
      ph.replaceWith(mc.element);
    });
  }

  // ── Word-wrap text for canvas rendering ──────────────────────────────
  #wrapText(ctx, text, font, maxWidth) {
    ctx.font = font;
    if (ctx.measureText(text).width <= maxWidth) return [text];

    // Split on natural boundaries: spaces, commas, underscores, dots
    const tokens = text.split(/(?<=[\s,_.])/);
    const lines = [];
    let current = "";

    for (const token of tokens) {
      const test = current + token;
      if (ctx.measureText(test).width > maxWidth && current.length > 0) {
        lines.push(current.trimEnd());
        current = token;
      } else {
        current = test;
      }
    }
    if (current.length > 0) lines.push(current.trimEnd());

    // Cap at 4 lines max to prevent excessively tall headers
    if (lines.length > 4) {
      lines.length = 4;
      lines[3] = lines[3].substring(0, lines[3].length - 1) + "…";
    }
    return lines.length > 0 ? lines : [text];
  }

  // ── Build composite image from results (per-Z page) ────────────────────
  async #buildCompositeImage(xValues, yValues, zValues, xLabel, yLabel, zLabel, capturedWorkflowJson = null) {
    const hasX = xValues.length > 1 || xValues[0] !== null;
    const hasY = yValues.length > 1 || yValues[0] !== null;
    const hasZ = zValues.length > 1 || zValues[0] !== null;

    // Read theme colors from CSS variables (canvas can't use CSS vars directly)
    const _cs = getComputedStyle(document.documentElement);
    const _get = (v, fb) => { const r = _cs.getPropertyValue(v).trim(); return r || fb; };
    const COLOR_BG     = _get('--cd-panel',  '#0e0e1a');
    const COLOR_EMPTY  = _get('--cd-s2',     '#1a1a3a');
    const COLOR_ACCENT = _get('--cd-accent', '#7c5cfc');
    const COLOR_XAXIS  = _get('--cd-accent', '#00d4ff');
    const COLOR_YAXIS  = _get('--cd-accent', '#7c5cfc');

    const makeImgURL = (f) =>
      this.bridge.getImageUrl(f.filename, f.subfolder || '', f.type || 'output');

    // Load all images
    const imageMap = new Map();
    const loadPromises = [];
    for (const r of this.results) {
      if (!r.images || r.images.length === 0) continue;
      const img = r.images[0];
      if (/\.(mp4|webm|mkv)$/i.test(img.filename)) continue;
      const key = `${r.x},${r.y},${r.z}`;
      const promise = new Promise((resolve) => {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => { imageMap.set(key, el); resolve(); };
        el.onerror = () => resolve();
        el.src = makeImgURL(img);
      });
      loadPromises.push(promise);
    }
    await Promise.all(loadPromises);

    if (imageMap.size === 0) return;

    // Determine cell size from largest image dimensions
    let cellW = 0, cellH = 0;
    for (const img of imageMap.values()) {
      cellW = Math.max(cellW, img.naturalWidth);
      cellH = Math.max(cellH, img.naturalHeight);
    }

    // Read settings
    const savePrefix = this.bridge.getSetting("ComfyDrawer.XYZ.SavePrefix", "ComfyDrawer/%date:yyyy-MM-dd%/xyz_plot");
    const fmt = this.bridge.getSetting("ComfyDrawer.XYZ.Format", "png");
    const saveMeta = this.bridge.getSetting("ComfyDrawer.XYZ.SaveMetadata", true);
    const mimeType = fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";

    // Use pre-captured workflow JSON (taken before original seed restore)
    // to ensure the grid metadata contains the actual seeds used for generation.
    const workflowJson = capturedWorkflowJson;

    const container = this.#q("xyz-grid");

    // Build one composite per Z value
    for (let zi = 0; zi < zValues.length; zi++) {
      const zv = zValues[zi];

      // Layout constants
      const FONT_HEADER = Math.max(24, Math.round(cellW * 0.05));
      const FONT_LABEL = Math.max(20, Math.round(cellW * 0.04));
      const LINE_HEIGHT = 1.3;
      const Z_HEADER_H = hasZ ? FONT_HEADER + 20 : 0;
      const FONT_AXIS_NAME = Math.max(14, Math.round(FONT_HEADER * 0.55));
      const AXIS_NAME_H = (hasX || hasY) ? (FONT_AXIS_NAME + 12) : 0;
      const LABEL_W = hasY ? Math.max(200, Math.round(cellW * 0.35)) : 0;
      const PAD = 4;

      // Create canvas + ctx early (needed for _wrapText text measurement)
      const measureCanvas = document.createElement("canvas");
      let ctx = measureCanvas.getContext("2d");

      // Pre-calculate wrapped text to determine dynamic heights
      const xWrapped = [];
      let maxHeaderLines = 1;
      if (hasX) {
        for (const xv of xValues) {
          const lines = this.#wrapText(ctx, String(xv), `bold ${FONT_HEADER}px sans-serif`, cellW - 16);
          xWrapped.push(lines);
          maxHeaderLines = Math.max(maxHeaderLines, lines.length);
        }
      }
      const HEADER_H = hasX ? Math.round(maxHeaderLines * FONT_HEADER * LINE_HEIGHT + 20) : 0;

      const yWrapped = [];
      let maxLabelLines = 1;
      if (hasY) {
        for (const yv of yValues) {
          const lines = this.#wrapText(ctx, String(yv ?? ""), `bold ${FONT_LABEL}px sans-serif`, LABEL_W - 24);
          yWrapped.push(lines);
          maxLabelLines = Math.max(maxLabelLines, lines.length);
        }
      }

      const cols = xValues.length;
      const rows = yValues.length;
      const canvasW = LABEL_W + cols * (cellW + PAD) + PAD;
      const canvasH = Z_HEADER_H + AXIS_NAME_H + HEADER_H + rows * (cellH + PAD) + PAD;

      // Create the actual canvas for drawing (measurement canvas no longer needed)
      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      ctx = canvas.getContext("2d");

      // Background
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, canvasW, canvasH);

      // Z header
      if (hasZ) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cd-danger').trim() || '#ff8c42';
        ctx.font = `bold ${FONT_HEADER}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${zLabel} = ${zv}`, canvasW / 2, Z_HEADER_H / 2, canvasW - 40);
      }

      // Axis name labels — dedicated row between Z header and value headers
      if (AXIS_NAME_H > 0) {
        const axisNameY = Z_HEADER_H + AXIS_NAME_H / 2;
        if (hasY) {
          ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cd-accent').trim() || '#7c5cfc';
          ctx.font = `${FONT_AXIS_NAME}px sans-serif`;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(`${yLabel} ↓`, LABEL_W - 12, axisNameY, LABEL_W - 24);
        }
        if (hasX) {
          ctx.fillStyle = COLOR_XAXIS;
          ctx.font = `${FONT_AXIS_NAME}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`${xLabel} →`, LABEL_W + (cols * (cellW + PAD)) / 2, axisNameY, cols * (cellW + PAD));
        }
      }

      // Header labels (X axis values) — word-wrapped, below the axis name row
      if (hasX) {
        const valueHeaderTop = Z_HEADER_H + AXIS_NAME_H;
        ctx.fillStyle = COLOR_XAXIS;
        ctx.font = `bold ${FONT_HEADER}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (let i = 0; i < cols; i++) {
          const x = LABEL_W + PAD + i * (cellW + PAD) + cellW / 2;
          const lines = xWrapped[i];
          const blockH = lines.length * FONT_HEADER * LINE_HEIGHT;
          const startY = valueHeaderTop + (HEADER_H - blockH) / 2;
          for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], x, startY + li * FONT_HEADER * LINE_HEIGHT, cellW - 8);
          }
        }
      }

      // Y axis labels — word-wrapped
      if (hasY) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cd-accent').trim() || '#7c5cfc';
        ctx.font = `bold ${FONT_LABEL}px sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        for (let j = 0; j < rows; j++) {
          const lines = yWrapped[j];
          const cellMidY = Z_HEADER_H + AXIS_NAME_H + HEADER_H + PAD + j * (cellH + PAD) + cellH / 2;
          const blockH = lines.length * FONT_LABEL * LINE_HEIGHT;
          const startY = cellMidY - blockH / 2;
          for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], LABEL_W - 12, startY + li * FONT_LABEL * LINE_HEIGHT, LABEL_W - 24);
          }
        }
      }

      // Draw images
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const key = `${xValues[i]},${yValues[j]},${zv}`;
          const img = imageMap.get(key);
          const x = LABEL_W + PAD + i * (cellW + PAD);
          const y = Z_HEADER_H + AXIS_NAME_H + HEADER_H + PAD + j * (cellH + PAD);
          if (img) {
            // Contain fit: maintain aspect ratio, center within cell
            const scale = Math.min(cellW / img.naturalWidth, cellH / img.naturalHeight);
            const drawW = img.naturalWidth * scale;
            const drawH = img.naturalHeight * scale;
            const offsetX = (cellW - drawW) / 2;
            const offsetY = (cellH - drawH) / 2;
            ctx.drawImage(img, x + offsetX, y + offsetY, drawW, drawH);
          } else {
            ctx.fillStyle = COLOR_EMPTY;
            ctx.fillRect(x, y, cellW, cellH);
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cd-text-dim').trim() || '#555577';
            ctx.textAlign = "center";
            ctx.font = `${FONT_LABEL}px sans-serif`;
            ctx.fillText("No output", x + cellW / 2, y + cellH / 2);
          }
        }
      }


      // Get canvas as data URL
      const dataURL = canvas.toDataURL(mimeType, 0.95);

      // Save to server
      let saveResult = null;
      const suffix = hasZ ? `_z${zi + 1}` : "";
      try {
        const resp = await this.bridge.fetchApi("/comfy-drawer/save_grid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_data: dataURL,
            filename_prefix: savePrefix + suffix,
            format: fmt,
            quality: 95,
            save_metadata: saveMeta,
            workflow_json: workflowJson,
          }),
        });
        if (resp.ok) saveResult = await resp.json();
      } catch (e) {
        console.warn("[ComfyDrawer] Failed to save grid to server:", e);
      }

      // Show preview in UI as a proper MediaCard
      const prev = container.querySelector(`.xyz-composite-z${zi}`);
      if (prev) prev.remove();
      const wrapper = document.createElement("div");
      wrapper.className = `xyz-composite-wrapper xyz-composite-z${zi}`;
      wrapper.style.cssText = "margin-top:12px;";

      // Use server URL if saved successfully, otherwise fall back to dataURL
      let imgSrc = dataURL;
      if (saveResult) {
        imgSrc = this.bridge.getImageUrl(saveResult.filename, saveResult.subfolder || '', 'output', { bustCache: true });
      }

      // Build lightbox items getter — deferred so all Z pages are included
      const getLightboxItems = () => {
        const allCards = container.querySelectorAll('.xyz-composite-wrapper .mc-card');
        return [...allCards].map((c, i) => ({
          src: c.querySelector('.mc-thumb')?.src || '',
          type: 'image',
          label: `XYZ Plot Composite ${i + 1}`,
          name: c.dataset.mcFilename || '',
          subfolder: c.dataset.mcSubfolder || '',
          source: 'output',
        }));
      };

      const ctxMenu = this.#contextMenu;
      const mc = createMediaCard({
        src: imgSrc,
        filename: saveResult?.filename || `xyz_plot${suffix}.${fmt}`,
        subfolder: saveResult?.subfolder || '',
        type: 'output',
        mediaType: 'image',
        lazy: false,
        thumbHeight: null,
        lightbox: false,   // Custom click for deferred lightbox items
        draggable: true,
        onClick: () => {
          const items = getLightboxItems();
          const idx = [...container.querySelectorAll('.xyz-composite-wrapper .mc-card')]
            .indexOf(mc.element);
          openLightbox(items, Math.max(0, idx));
        },
        onContextMenu: (ctxMenu && saveResult) ? (e) => {
          ctxMenu.show('media-file', {
            src: imgSrc,
            type: 'image',
            name: saveResult.filename,
            subfolder: saveResult.subfolder || '',
            source: 'output',
          }, e.clientX, e.clientY);
        } : null,
      });

      // Store file info on card element for deferred lightbox items builder
      if (saveResult) {
        mc.element.dataset.mcFilename = saveResult.filename;
        mc.element.dataset.mcSubfolder = saveResult.subfolder || '';
      }

      // Info row: saved status
      const savedColor = saveResult ? 'var(--cd-accent)' : 'var(--cd-danger)';
      const savedText = saveResult
        ? `Saved: ${escapeHTML(saveResult.subfolder ? saveResult.subfolder + "/" : "")}${escapeHTML(saveResult.filename)}`
        : `Server save failed`;
      mc.info.innerHTML = `
        <div style="color:${savedColor};font-size:12px">${savedText}</div>`;
      mc.info.style.textAlign = 'center';
      mc.info.style.padding = '8px 0';

      wrapper.appendChild(mc.element);
      container.appendChild(wrapper);
    }

  }

  /* ═══ Settings Registration ═══ */

  #registerSettings() {
    // Migrate old ComfyPilot settings → ComfyDrawer (run immediately)
    const migrations = [
      ['ComfyPilot.XYZ.SavePrefix', 'ComfyDrawer.XYZ.SavePrefix'],
      ['ComfyPilot.XYZ.Format', 'ComfyDrawer.XYZ.Format'],
      ['ComfyPilot.XYZ.SaveMetadata', 'ComfyDrawer.XYZ.SaveMetadata'],
    ];
    for (const [oldKey, newKey] of migrations) {
      const oldVal = this.bridge.getSetting(oldKey);
      if (oldVal !== undefined && this.bridge.getSetting(newKey) === undefined) {
        const migratedVal = (oldKey.endsWith('SavePrefix') && typeof oldVal === 'string')
          ? oldVal.replace(/ComfyPilot/g, 'ComfyDrawer')
          : oldVal;
        this.bridge.setSetting(newKey, migratedVal);
      }
    }

    // Fix already-migrated value that still contains old path prefix
    const currentPrefix = this.bridge.getSetting('ComfyDrawer.XYZ.SavePrefix');
    if (typeof currentPrefix === 'string' && currentPrefix.includes('ComfyPilot')) {
      this.bridge.setSetting('ComfyDrawer.XYZ.SavePrefix', currentPrefix.replace(/ComfyPilot/g, 'ComfyDrawer'));
    }

    this.bridge.addSetting({
      id: "ComfyDrawer.XYZ.SavePrefix",
      name: "XYZ: Grid Image Filename",
      defaultValue: "ComfyDrawer/%date:yyyy-MM-dd%/xyz_plot",
      tooltip: "Supports %date:yyyy-MM-dd%, %year%, %month% etc. Use / for subfolders.",
      type: (name, setter, value) => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = value ?? "ComfyDrawer/%date:yyyy-MM-dd%/xyz_plot";
        input.style.cssText = "width:100%;padding:4px 8px;border-radius:4px;border:1px solid var(--cd-divider);background:var(--cd-s1);color:var(--cd-text);font-size:13px;";
        input.addEventListener("change", () => setter(input.value));
        return input;
      },
    });

    this.bridge.addSetting({
      id: "ComfyDrawer.XYZ.Format",
      name: "XYZ: Grid Image Format",
      defaultValue: "png",
      type: (name, setter, value) => {
        const sel = document.createElement("select");
        sel.style.cssText = "padding:4px 8px;border-radius:4px;border:1px solid var(--cd-divider);background:var(--cd-s1);color:var(--cd-text);font-size:13px;";
        for (const opt of ["png", "webp"]) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt.toUpperCase();
          if (opt === (value ?? "png")) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener("change", () => setter(sel.value));
        return sel;
      },
    });

    this.bridge.addSetting({
      id: "ComfyDrawer.XYZ.SaveMetadata",
      name: "XYZ: Embed Workflow in Grid Image",
      type: "boolean",
      defaultValue: true,
      tooltip: "PNG: embedded as PngInfo. JPEG/WebP: embedded as EXIF metadata.",
    });
  }
}
