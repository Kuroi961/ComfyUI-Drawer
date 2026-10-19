// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MOSS Layout editor — Deck UI for DrawerMossLayout nodes
//
//  The node's `text` widget holds a MOSS-Image layout prompt:
//    {"summary":{"caption",...},"items":[{label,caption,text?,tags?,palette?,
//     bbox:[y0,x0,y1,x1]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}
//  bbox values are pixels on the width x height canvas with the origin at its
//  centre (same as ComfyUI's MOSS-Image Layout Prompt node). Without items the
//  prompt is just the caption text, so a plain caption stays plain text.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { isDrawerControlsNode, parseDrawerControlDef } from '../../js/utils/drawer-controls.js';

const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;

const LABELS = ['object', 'character', 'text'];
const CANVASES = ['single', 'multi_panel', 'collage'];
const SUMMARY_LISTS = ['meta', 'palette'];
const ITEM_LISTS = ['tags', 'palette'];
const MIN_BOX = 8;

const SIZE_ICONS = {
  linked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  lastRun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
  unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

const splitList = (s) => String(s).split(',').map(v => v.trim()).filter(Boolean);
const joinList = (v) => Array.isArray(v) ? v.join(', ') : (typeof v === 'string' ? v : '');

/**
 * Parse the widget text into an editable layout.
 * Boxes become `rect` = [left, top, right, bottom] in top-left pixels.
 * Returns { layout } or { error } when the text is JSON the editor can't own.
 */
function parseLayout(text, width, height) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return { layout: { summary: { caption: raw }, items: [] } };
  }
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { error: 'invalidJson' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'invalidJson' };
  const space = data.bbox_coord_space ?? 'abs_centralized';
  const format = data.bbox_format ?? 'yxyx';
  if (space === 'abs' && format === 'xyxy') return { error: 'draft', draft: data };
  if (space !== 'abs_centralized' || format !== 'yxyx') {
    return { error: 'unsupported', detail: `${space} / ${format}` };
  }
  const summary = data.summary && typeof data.summary === 'object' ? { ...data.summary } : {};
  if (typeof summary.caption !== 'string') summary.caption = '';
  const hw = Math.floor(width / 2), hh = Math.floor(height / 2);
  const items = [];
  for (const it of Array.isArray(data.items) ? data.items : []) {
    if (!it || typeof it !== 'object') continue;
    const b = Array.isArray(it.bbox) && it.bbox.length === 4 && it.bbox.every(Number.isFinite)
      ? it.bbox : [-hh / 2, -hw / 2, hh / 2, hw / 2];
    const { bbox, ...rest } = it;
    items.push({ ...rest, rect: [b[1] + hw, b[0] + hh, b[3] + hw, b[2] + hh] });
  }
  return { layout: { summary, items } };
}

/**
 * Convert a MOSS-Image layout draft (top-left pixel xyxy boxes plus
 * width/height, as written by the official prompt enhancer or an LLM) into an
 * editable layout. Keeps the fields the official compiler keeps; fractional
 * edges are enclosed (floor left/top, ceil right/bottom) like it does.
 */
function layoutFromDraft(draft, fallbackW, fallbackH) {
  const size = (v, fb) => (Number.isInteger(v) && v > 0 ? v : fb);
  const w = size(draft.width, fallbackW), h = size(draft.height, fallbackH);
  const src = draft.summary && typeof draft.summary === 'object' ? draft.summary : {};
  // Key order follows the draft, as the compiled JSON does.
  const summary = {};
  for (const k of Object.keys(src)) {
    if (k === 'caption') summary.caption = typeof src.caption === 'string' ? src.caption : '';
    else if (k === 'canvas') summary.canvas = src.canvas;
    else if (SUMMARY_LISTS.includes(k)) summary[k] = typeof src[k] === 'string' ? [src[k]] : src[k];
  }
  if (summary.caption === undefined) summary.caption = '';
  const items = [];
  for (const it of Array.isArray(draft.items) ? draft.items : []) {
    if (!it || typeof it !== 'object') continue;
    const out = { label: LABELS.includes(it.label) ? it.label : 'object', caption: typeof it.caption === 'string' ? it.caption : '' };
    if (typeof it.text === 'string') out.text = it.text;
    for (const k of ITEM_LISTS) if (Array.isArray(it[k])) out[k] = it[k];
    const b = Array.isArray(it.bbox) && it.bbox.length === 4 && it.bbox.every(Number.isFinite)
      ? it.bbox : [w / 4, h / 4, w * 3 / 4, h * 3 / 4];
    const clampX = (v) => Math.min(w, Math.max(0, v)), clampY = (v) => Math.min(h, Math.max(0, v));
    out.rect = [
      clampX(Math.floor(Math.min(b[0], b[2]))), clampY(Math.floor(Math.min(b[1], b[3]))),
      clampX(Math.ceil(Math.max(b[0], b[2]))), clampY(Math.ceil(Math.max(b[1], b[3]))),
    ];
    items.push(out);
  }
  return { layout: { summary, items }, width: w, height: h };
}

function serializeLayout(layout, width, height) {
  const { summary, items } = layout;
  const hasSummaryExtras = Object.keys(summary).some(k => k !== 'caption');
  if (!items.length && !hasSummaryExtras) return summary.caption;
  const hw = Math.floor(width / 2), hh = Math.floor(height / 2);
  const outItems = items.map(({ rect, ...it }) => {
    const out = { label: it.label, caption: it.caption ?? '' };
    if (it.label === 'text') out.text = it.text ?? '';
    for (const [k, v] of Object.entries(it)) {
      if (!(k in out) && k !== 'text') out[k] = v;
    }
    const [l, t, r, b] = rect.map(Math.round);
    out.bbox = [t - hh, l - hw, b - hh, r - hw];
    return out;
  });
  return JSON.stringify({
    summary,
    items: outItems,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  });
}

/* ── Linked width/height ──
 * When width/height come from another node, compute that node's output the
 * same way its Python does, for the nodes where that is possible from widget
 * values alone. Anything else resolves to undefined. */

const MAX_LINK_DEPTH = 8;

// Python's round(): halves go to the even neighbour.
const pyRound = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

function inputValue(node, name, depth = 0) {
  const slot = node.inputs?.findIndex(i => i.name === name) ?? -1;
  const link = slot >= 0 ? node.getInputLink?.(slot) : null;
  if (!link) return node.widgets?.find(w => w.name === name)?.value;
  if (depth >= MAX_LINK_DEPTH) return undefined;
  const src = node.graph?.getNodeById?.(link.origin_id);
  return src ? outputValue(src, link.origin_slot, depth + 1) : undefined;
}

function outputValue(node, slot, depth) {
  if (node.mode !== 0) return undefined;
  const type = String(node.type || '');
  const name = node.outputs?.[slot]?.name;
  const num = (key) => Number(inputValue(node, key, depth));

  if (type === 'Reroute') return inputValue(node, node.inputs?.[0]?.name, depth);
  if (type === 'PrimitiveNode') return node.widgets?.[0]?.value;
  if (type === 'ResolutionSelector') {
    const m = /^(\d+):(\d+)/.exec(String(inputValue(node, 'aspect_ratio', depth) ?? ''));
    const mp = num('megapixels'), multiple = num('multiple');
    if (!m || !Number.isFinite(mp) || !(multiple > 0)) return undefined;
    const [rw, rh] = [Number(m[1]), Number(m[2])];
    const scale = Math.sqrt(mp * 1024 * 1024 / (rw * rh));
    return pyRound((slot === 0 ? rw : rh) * scale / multiple) * multiple;
  }
  if (type === 'DrawerSize') {
    const round16 = (v) => Math.max(64, pyRound(v / 16) * 16);
    const ratio = String(inputValue(node, 'ratio_', depth) ?? 'custom');
    if (ratio === 'custom') return round16(num(slot === 0 ? 'width_' : 'height_'));
    const [rw, rh] = ratio.split(':').map(Number);
    const scale = Math.sqrt(num('megapixels_') * 1024 * 1024 / (rw * rh));
    return round16((slot === 0 ? rw : rh) * scale);
  }
  if (isDrawerControlsNode(node)) {
    const raw = inputValue(node, `value_${slot + 1}`, depth);
    const def = parseDrawerControlDef(inputValue(node, `def_${slot + 1}`, depth));
    if (def?.type === 'int') return Math.trunc(parseFloat(raw || 0));
    if (def?.type === 'float') return parseFloat(raw || 0);
    return raw;
  }
  // Primitive Int/Float, constant nodes, DrawerMossLayout: an input named like the output.
  if (name === 'INT' || name === 'FLOAT') return inputValue(node, 'value', depth);
  if (name && (node.inputs?.some(i => i.name === name) || node.widgets?.some(w => w.name === name))) {
    return inputValue(node, name, depth);
  }
  return undefined;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function field(labelText, control) {
  const wrap = el('div', 'dk-moss-field');
  wrap.append(el('label', 'dk-label', labelText), control);
  return wrap;
}

/**
 * Build the editor for a DrawerMossLayout node.
 * Returns null when the node lacks its widgets, else { element, sync }.
 * `sync()` re-reads the widgets after an outside change (canvas, workflow load).
 */
export function buildMossLayoutEditor(node, bridge) {
  const widgets = node.widgets || [];
  const textW = widgets.find(w => w.name === 'text');
  const widthW = widgets.find(w => w.name === 'width');
  const heightW = widgets.find(w => w.name === 'height');
  if (!textW || !widthW || !heightW) return null;

  let width = 1024, height = 1024;
  let layout = null;
  let parseError = null;
  let selected = -1;
  let lastText = null;
  let drag = null;
  let sizeSource = 'widget';

  const root = el('div', 'dk-widget dk-moss');

  // ── Summary ──
  const captionTa = el('textarea', 'dk-textarea dk-moss-caption');
  captionTa.rows = 3;
  captionTa.placeholder = _t('deck.moss.captionHint');
  const metaInp = el('input', 'dk-input');
  metaInp.placeholder = _t('deck.moss.metaHint');
  const paletteInp = el('input', 'dk-input');
  paletteInp.placeholder = _t('deck.moss.paletteHint');
  const paletteSw = el('div', 'dk-moss-swatches');
  const canvasSel = el('select', 'dk-select');
  for (const v of ['', ...CANVASES]) {
    const o = el('option', '', _t(`deck.moss.canvas_${v || 'none'}`));
    o.value = v;
    canvasSel.appendChild(o);
  }
  const summaryBox = el('div', 'dk-moss-summary');
  const metaRow = el('div', 'dk-moss-row');
  metaRow.append(field(_t('deck.moss.meta'), metaInp), field(_t('deck.moss.canvas'), canvasSel));
  const paletteField = field(_t('deck.moss.palette'), paletteInp);
  paletteField.appendChild(paletteSw);
  summaryBox.append(field(_t('deck.moss.caption'), captionTa), metaRow, paletteField);

  // ── Toolbar: size + add ──
  const toolbar = el('div', 'dk-moss-toolbar');
  const wInp = el('input', 'dk-number dk-moss-num');
  const hInp = el('input', 'dk-number dk-moss-num');
  for (const inp of [wInp, hInp]) {
    inp.type = 'number'; inp.min = 16; inp.max = 16384; inp.step = 16;
  }
  const addBtn = el('button', 'dk-moss-btn', _t('deck.moss.addBox'));
  addBtn.type = 'button';
  const sizeNote = el('span', 'dk-moss-size-note');
  sizeNote.setAttribute('role', 'img');
  toolbar.append(el('span', 'dk-size-dim-label', 'W'), wInp, el('span', 'dk-size-dim-label', 'H'), hInp, sizeNote, addBtn);

  // ── Stage ──
  const stageWrap = el('div', 'dk-moss-stage-wrap');
  const stage = el('div', 'dk-moss-stage');
  stageWrap.appendChild(stage);

  // ── Item list + detail ──
  const list = el('div', 'dk-moss-list');
  const detail = el('div', 'dk-moss-detail');

  // ── Raw JSON / error ──
  const notice = el('div', 'dk-moss-notice');
  const jsonDetails = el('details', 'dk-moss-json');
  jsonDetails.appendChild(el('summary', '', _t('deck.moss.json')));
  const jsonTa = el('textarea', 'dk-textarea dk-moss-json-ta');
  jsonTa.spellcheck = false;
  jsonDetails.appendChild(jsonTa);

  const editorBody = el('div', 'dk-moss-body');
  editorBody.append(summaryBox, toolbar, stageWrap, list, detail);
  root.append(notice, editorBody, jsonDetails);

  // ── Model helpers ──
  const toCanvas = (e) => {
    const r = stage.getBoundingClientRect();
    return [
      Math.min(width, Math.max(0, (e.clientX - r.left) / r.width * width)),
      Math.min(height, Math.max(0, (e.clientY - r.top) / r.height * height)),
    ];
  };

  const commit = () => {
    const text = serializeLayout(layout, width, height);
    lastText = text;
    if (textW.value !== text) bridge.invokeWidgetCallback(node, textW, text);
    if (document.activeElement !== jsonTa) jsonTa.value = text;
  };

  const setSummaryField = (key, value) => {
    if (value === '' || (Array.isArray(value) && !value.length)) delete layout.summary[key];
    else layout.summary[key] = value;
    commit();
  };

  const itemTitle = (it) => (it.label === 'text' ? (it.text || it.caption) : it.caption) || '';

  // ── Rendering ──
  const renderSwatches = (target, values) => {
    target.replaceChildren();
    for (const v of Array.isArray(values) ? values : []) {
      if (!CSS.supports('color', v)) continue;
      const s = el('span', 'dk-moss-swatch');
      s.style.background = v;
      s.title = v;
      target.appendChild(s);
    }
  };

  const renderBoxes = () => {
    stage.replaceChildren();
    layout.items.forEach((it, i) => {
      const [l, t, r, b] = it.rect;
      const box = el('div', `dk-moss-box dk-moss-${LABELS.includes(it.label) ? it.label : 'object'}`);
      if (i === selected) box.classList.add('selected');
      box.dataset.mossIndex = i;
      box.style.left = `${l / width * 100}%`;
      box.style.top = `${t / height * 100}%`;
      box.style.width = `${(r - l) / width * 100}%`;
      box.style.height = `${(b - t) / height * 100}%`;
      const tag = el('span', 'dk-moss-tag', `${i + 1}`);
      const title = itemTitle(it);
      if (title) tag.appendChild(el('span', 'dk-moss-tag-text', title));
      box.appendChild(tag);
      if (i === selected) {
        for (const c of ['nw', 'ne', 'sw', 'se']) {
          const h = el('span', `dk-moss-handle dk-moss-handle-${c}`);
          h.dataset.corner = c;
          box.appendChild(h);
        }
      }
      stage.appendChild(box);
    });
  };

  const renderList = () => {
    list.replaceChildren();
    if (!layout.items.length) {
      list.appendChild(el('div', 'dk-moss-empty', _t('deck.moss.empty')));
      return;
    }
    layout.items.forEach((it, i) => {
      const row = el('button', `dk-moss-list-row dk-moss-${LABELS.includes(it.label) ? it.label : 'object'}`);
      row.type = 'button';
      if (i === selected) row.classList.add('selected');
      row.append(
        el('span', 'dk-moss-list-num', `${i + 1}`),
        el('span', 'dk-moss-list-label', _t(`deck.moss.label_${LABELS.includes(it.label) ? it.label : 'object'}`)),
        el('span', 'dk-moss-list-title', itemTitle(it) || '—'),
      );
      row.addEventListener('click', () => select(i === selected ? -1 : i));
      list.appendChild(row);
    });
  };

  // Numeric x/y/w/h inputs of the open detail panel, refreshed while dragging.
  let rectInputs = null;
  // X/Y/W/H are shown as % of the canvas (the pixels follow the canvas size);
  // the exact pixels are in each field's tooltip.
  const rectPixels = (rect) => {
    const [l, t, r, b] = rect.map(Math.round);
    return [l, t, r - l, b - t];
  };
  const syncRectInputs = () => {
    if (!rectInputs || selected < 0) return;
    const px = rectPixels(layout.items[selected].rect);
    rectInputs.forEach((inp, k) => {
      const dim = k % 2 ? height : width;
      inp.title = `${px[k]} px`;
      if (document.activeElement !== inp) inp.value = String(Math.round(px[k] / dim * 1000) / 10);
    });
  };

  const renderDetail = () => {
    detail.replaceChildren();
    rectInputs = null;
    if (selected < 0 || !layout.items[selected]) return;
    const it = layout.items[selected];
    const refreshItem = () => { renderBoxes(); renderList(); };

    const labelSel = el('select', 'dk-select');
    for (const v of LABELS) {
      const o = el('option', '', _t(`deck.moss.label_${v}`));
      o.value = v;
      labelSel.appendChild(o);
    }
    labelSel.value = LABELS.includes(it.label) ? it.label : 'object';

    const capTa = el('textarea', 'dk-textarea dk-moss-item-caption');
    capTa.rows = 2;
    capTa.placeholder = _t('deck.moss.itemCaptionHint');
    capTa.value = it.caption ?? '';
    capTa.addEventListener('input', () => { it.caption = capTa.value; refreshItem(); commit(); });

    // Line breaks in the rendered text are kept, so this is a textarea.
    const textInp = el('textarea', 'dk-textarea');
    textInp.rows = 2;
    textInp.placeholder = _t('deck.moss.textHint');
    textInp.value = it.text ?? '';
    textInp.addEventListener('input', () => { it.text = textInp.value; refreshItem(); commit(); });
    const textField = field(_t('deck.moss.text'), textInp);
    textField.hidden = it.label !== 'text';

    labelSel.addEventListener('change', () => {
      it.label = labelSel.value;
      if (it.label === 'text' && typeof it.text !== 'string') it.text = '';
      textField.hidden = it.label !== 'text';
      refreshItem();
      commit();
    });

    const listInput = (key, placeholder) => {
      const inp = el('input', 'dk-input');
      inp.value = joinList(it[key]);
      inp.placeholder = placeholder;
      return inp;
    };
    const tagsInp = listInput('tags', _t('deck.moss.tagsHint'));
    const palInp = listInput('palette', _t('deck.moss.itemPaletteHint'));
    const palSw = el('div', 'dk-moss-swatches');
    renderSwatches(palSw, it.palette);
    for (const [key, inp] of [['tags', tagsInp], ['palette', palInp]]) {
      inp.addEventListener('input', () => {
        const v = splitList(inp.value);
        if (v.length) it[key] = v; else delete it[key];
        if (key === 'palette') renderSwatches(palSw, it.palette);
        commit();
      });
    }

    const rectRow = el('div', 'dk-moss-rect');
    rectInputs = ['X', 'Y', 'W', 'H'].map((name, k) => {
      const inp = el('input', 'dk-number dk-moss-num');
      inp.type = 'number'; inp.step = 0.1; inp.min = 0; inp.max = 100;
      inp.addEventListener('change', () => {
        const pct = Number(inp.value);
        if (!Number.isFinite(pct)) { syncRectInputs(); return; }
        // Only the edited field changes; the others keep their exact pixels.
        const vals = rectPixels(it.rect);
        vals[k] = Math.round(pct / 100 * (k % 2 ? height : width));
        const [x, y, w, h] = vals;
        const l = Math.min(Math.max(0, x), width - MIN_BOX);
        const t = Math.min(Math.max(0, y), height - MIN_BOX);
        it.rect = [l, t, Math.min(width, l + Math.max(MIN_BOX, w)), Math.min(height, t + Math.max(MIN_BOX, h))];
        syncRectInputs();
        renderBoxes();
        commit();
      });
      const cell = el('label', 'dk-moss-rect-cell');
      cell.append(el('span', 'dk-size-dim-label', name), inp);
      rectRow.appendChild(cell);
      return inp;
    });
    syncRectInputs();

    const actions = el('div', 'dk-moss-actions');
    const mkBtn = (key, onClick, extra = '') => {
      const b = el('button', `dk-moss-btn ${extra}`, _t(key));
      b.type = 'button';
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    };
    const move = (delta) => {
      const j = selected + delta;
      if (j < 0 || j >= layout.items.length) return;
      [layout.items[selected], layout.items[j]] = [layout.items[j], layout.items[selected]];
      commit();
      select(j);
    };
    mkBtn('deck.moss.moveUp', () => move(-1)).disabled = selected === 0;
    mkBtn('deck.moss.moveDown', () => move(1)).disabled = selected === layout.items.length - 1;
    mkBtn('deck.moss.duplicate', () => {
      const copy = structuredClone(it);
      const [l, t, r, b] = copy.rect;
      const dx = Math.min(32, width - r), dy = Math.min(32, height - b);
      copy.rect = [l + dx, t + dy, r + dx, b + dy];
      layout.items.splice(selected + 1, 0, copy);
      commit();
      select(selected + 1);
    });
    mkBtn('deck.moss.delete', () => {
      layout.items.splice(selected, 1);
      commit();
      select(Math.min(selected, layout.items.length - 1));
    }, 'danger');

    const head = el('div', 'dk-moss-row');
    head.append(field(_t('deck.moss.label'), labelSel), field(_t('deck.moss.position'), rectRow));
    const palField = field(_t('deck.moss.palette'), palInp);
    palField.appendChild(palSw);
    detail.append(
      el('div', 'dk-moss-detail-title', _t('deck.moss.boxN', { n: selected + 1 })),
      head,
      field(_t('deck.moss.caption'), capTa),
      textField,
      field(_t('deck.moss.tags'), tagsInp),
      palField,
      actions,
    );
  };

  const select = (i) => {
    selected = i;
    renderBoxes();
    renderList();
    renderDetail();
  };

  const renderAll = () => {
    wInp.value = width;
    hInp.value = height;
    wInp.readOnly = hInp.readOnly = sizeSource !== 'widget';
    sizeNote.hidden = sizeSource === 'widget';
    sizeNote.dataset.source = sizeSource;
    sizeNote.innerHTML = SIZE_ICONS[sizeSource] ?? '';
    sizeNote.title = sizeSource === 'widget' ? '' : _t(`deck.moss.size_${sizeSource}`);
    sizeNote.setAttribute('aria-label', sizeNote.title);
    stageWrap.style.setProperty('--moss-ratio', `${width} / ${height}`);
    stageWrap.style.setProperty('--moss-aspect', String(width / height));
    if (document.activeElement !== jsonTa) jsonTa.value = String(textW.value ?? '');
    if (parseError) {
      notice.hidden = false;
      notice.replaceChildren(el('span', '', parseError.error === 'draft' ? _t('deck.moss.draft')
        : parseError.error === 'unsupported' ? _t('deck.moss.unsupported', { format: parseError.detail })
          : _t('deck.moss.invalidJson')));
      if (parseError.error === 'draft') {
        const btn = el('button', 'dk-moss-btn', _t('deck.moss.convertDraft'));
        btn.type = 'button';
        btn.addEventListener('click', () => convertDraft(parseError.draft));
        notice.appendChild(btn);
      }
      notice.classList.toggle('dk-moss-notice--info', parseError.error === 'draft');
      editorBody.hidden = true;
      jsonDetails.open = parseError.error !== 'draft';
      return;
    }
    notice.hidden = true;
    editorBody.hidden = false;
    const s = layout.summary;
    if (document.activeElement !== captionTa) captionTa.value = s.caption;
    if (document.activeElement !== metaInp) metaInp.value = joinList(s.meta);
    if (document.activeElement !== paletteInp) paletteInp.value = joinList(s.palette);
    renderSwatches(paletteSw, s.palette);
    canvasSel.value = CANVASES.includes(s.canvas) ? s.canvas : '';
    if (selected >= layout.items.length) selected = layout.items.length - 1;
    renderBoxes();
    renderList();
    renderDetail();
  };

  /**
   * The canvas the prompt is meant for. Linked width/height are computed from
   * the source node when possible, else taken from this node's last run.
   * The node's own width/height widgets keep the size the boxes were placed
   * on, so a changed source size can rescale them.
   */
  const resolveSize = () => {
    const own = [Number(widthW.value) || 1024, Number(heightW.value) || 1024];
    const linked = ['width', 'height'].map(name => {
      const slot = node.inputs?.findIndex(i => i.name === name) ?? -1;
      return slot >= 0 && node.getInputLink?.(slot) != null;
    });
    if (!linked[0] && !linked[1]) return { w: own[0], h: own[1], source: 'widget' };
    const live = ['width', 'height'].map((name, k) => (linked[k] ? Number(inputValue(node, name)) : own[k]));
    if (live.every(v => Number.isInteger(v) && v > 0)) return { w: live[0], h: live[1], source: 'linked' };
    const ran = bridge.nodeOutputs?.[String(node.id)]?.moss_size;
    if (Array.isArray(ran) && ran.length === 2) {
      const [w, h] = live.map((v, k) => (Number.isInteger(v) && v > 0 ? v : Number(ran[k])));
      if (w > 0 && h > 0) return { w, h, source: 'lastRun' };
    }
    return { w: own[0], h: own[1], source: 'unknown' };
  };

  // Boxes keep their relative place when the canvas size changes.
  const applySize = (nw, nh) => {
    if (layout) {
      for (const it of layout.items) {
        const [l, t, r, b] = it.rect;
        it.rect = [l * nw / width, t * nh / height, r * nw / width, b * nh / height].map(Math.round);
      }
    }
    width = nw; height = nh;
    bridge.invokeWidgetCallback(node, widthW, nw);
    bridge.invokeWidgetCallback(node, heightW, nh);
    if (layout?.items.length) commit();
  };

  // Linked sizes win over the draft's; otherwise the draft sets width/height.
  const convertDraft = (draft) => {
    const converted = layoutFromDraft(draft, width, height);
    layout = converted.layout;
    parseError = null;
    selected = -1;
    width = converted.width; height = converted.height;
    bridge.invokeWidgetCallback(node, widthW, width);
    bridge.invokeWidgetCallback(node, heightW, height);
    const size = resolveSize();
    sizeSource = size.source;
    if ((size.source === 'linked' || size.source === 'lastRun') && (size.w !== width || size.h !== height)) {
      applySize(size.w, size.h);
    }
    commit();
    renderAll();
  };

  const load = () => {
    width = Math.max(16, Number(widthW.value) || 1024);
    height = Math.max(16, Number(heightW.value) || 1024);
    lastText = String(textW.value ?? '');
    const parsed = parseLayout(lastText, width, height);
    parseError = parsed.error ? parsed : null;
    layout = parsed.layout ?? null;
    const size = resolveSize();
    sizeSource = size.source;
    if (size.w !== width || size.h !== height) applySize(size.w, size.h);
    renderAll();
  };

  // ── Events: summary ──
  captionTa.addEventListener('input', () => { layout.summary.caption = captionTa.value; commit(); });
  metaInp.addEventListener('input', () => setSummaryField('meta', splitList(metaInp.value)));
  paletteInp.addEventListener('input', () => {
    setSummaryField('palette', splitList(paletteInp.value));
    renderSwatches(paletteSw, layout.summary.palette);
  });
  canvasSel.addEventListener('change', () => setSummaryField('canvas', canvasSel.value));

  // ── Events: size ──
  const resize = () => {
    if (sizeSource !== 'widget') return;
    const nw = Math.max(16, Math.round((Number(wInp.value) || width) / 16) * 16);
    const nh = Math.max(16, Math.round((Number(hInp.value) || height) / 16) * 16);
    if (nw !== width || nh !== height) applySize(nw, nh);
    renderAll();
  };
  wInp.addEventListener('change', resize);
  hInp.addEventListener('change', resize);

  addBtn.addEventListener('click', () => {
    const w = Math.round(width / 3), h = Math.round(height / 3);
    const l = Math.round((width - w) / 2), t = Math.round((height - h) / 2);
    layout.items.push({ label: 'object', caption: '', rect: [l, t, l + w, t + h] });
    commit();
    select(layout.items.length - 1);
  });

  // ── Events: raw JSON ──
  jsonTa.addEventListener('input', () => {
    lastText = jsonTa.value;
    bridge.invokeWidgetCallback(node, textW, jsonTa.value);
    const parsed = parseLayout(jsonTa.value, width, height);
    parseError = parsed.error ? parsed : null;
    layout = parsed.layout ?? null;
    renderAll();
  });

  // ── Events: stage drag ──
  // Move/resize a box by its body/corners; draw a new box by dragging empty
  // space with a mouse. Touch on empty space keeps scrolling the panel.
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !layout) return;
    const p = toCanvas(e);
    const boxEl = e.target.closest('[data-moss-index]');
    if (boxEl) {
      const i = Number(boxEl.dataset.mossIndex);
      const corner = e.target.closest('[data-corner]')?.dataset.corner ?? null;
      if (i !== selected) select(i);
      drag = { mode: corner ? 'resize' : 'move', corner, start: p, orig: [...layout.items[i].rect] };
    } else if (e.pointerType === 'mouse') {
      drag = { mode: 'draw', start: p, index: -1 };
    } else {
      if (selected >= 0) select(-1);
      return;
    }
    drag.moved = false;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [px, py] = toCanvas(e);
    const dx = px - drag.start[0], dy = py - drag.start[1];
    if (!drag.moved && Math.hypot(dx / width, dy / height) < 0.005) return;
    drag.moved = true;
    if (drag.mode === 'draw') {
      if (drag.index < 0) {
        layout.items.push({ label: 'object', caption: '', rect: [px, py, px, py] });
        drag.index = layout.items.length - 1;
        selected = drag.index;
      }
      const [sx, sy] = drag.start;
      layout.items[drag.index].rect = [Math.min(sx, px), Math.min(sy, py), Math.max(sx, px), Math.max(sy, py)];
    } else if (drag.mode === 'move') {
      const [l, t, r, b] = drag.orig;
      const ox = Math.min(Math.max(dx, -l), width - r);
      const oy = Math.min(Math.max(dy, -t), height - b);
      layout.items[selected].rect = [l + ox, t + oy, r + ox, b + oy];
    } else {
      let [l, t, r, b] = drag.orig;
      if (drag.corner.includes('w')) l = Math.min(l + dx, r - MIN_BOX);
      if (drag.corner.includes('e')) r = Math.max(r + dx, l + MIN_BOX);
      if (drag.corner.includes('n')) t = Math.min(t + dy, b - MIN_BOX);
      if (drag.corner.includes('s')) b = Math.max(b + dy, t + MIN_BOX);
      layout.items[selected].rect = [Math.max(0, l), Math.max(0, t), Math.min(width, r), Math.min(height, b)];
    }
    renderBoxes();
    syncRectInputs();
  });

  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'draw') {
      if (d.index < 0) { if (selected >= 0) select(-1); return; }
      const [l, t, r, b] = layout.items[d.index].rect;
      if (r - l < MIN_BOX || b - t < MIN_BOX) {
        layout.items.splice(d.index, 1);
        select(-1);
        return;
      }
    }
    if (!d.moved) return;
    for (const it of layout.items) it.rect = it.rect.map(Math.round);
    commit();
    select(selected);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Keyboard: Delete removes the selected box while the stage has focus.
  stage.tabIndex = 0;
  stage.addEventListener('keydown', (e) => {
    if (selected < 0 || !layout) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      layout.items.splice(selected, 1);
      commit();
      select(Math.min(selected, layout.items.length - 1));
      e.preventDefault();
    }
  });

  load();

  return {
    element: root,
    sync() {
      if (drag) return;
      const size = resolveSize();
      const changed = String(textW.value ?? '') !== lastText || size.source !== sizeSource
        || size.w !== width || size.h !== height
        || Number(widthW.value) !== width || Number(heightW.value) !== height;
      if (changed) load();
    },
  };
}
