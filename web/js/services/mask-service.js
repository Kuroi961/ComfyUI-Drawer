/**
 * MaskService — Singleton mask editor overlay panel.
 *
 * Usage:
 *   await MaskService.open({ url, filename, bridge });
 *   // Applies to the selected LoadImageMask node, or all LoadImageMask nodes in auto mode.
 *
 * Exposed as window.ComfyDrawer.maskService via comfy-drawer.js.
 */
import { enumerateLoadImageTargets } from '../utils/widget-targets.js';

const MaskService = (() => {

  // ── Private state ──────────────────────────────────────────────────────────
  let _overlay = null;
  let _resolveOpen = null;

  let _bgCanvas = null, _maskCanvas = null, _displayCanvas = null;
  let _ctxBg = null, _ctxMask = null, _ctxDisplay = null;
  let _currentFilename = 'mask_base.png';
  let _naturalW = 0, _naturalH = 0; // full image resolution
  let _redrawRafId = 0;

  let _brushSize = 40, _isEraser = false;
  let _isDrawing = false, _lastX = 0, _lastY = 0;

  let _scale = 1, _panX = 0, _panY = 0;
  let _isPanning = false, _panStartX = 0, _panStartY = 0;

  let _workspace = null, _viewport = null;
  let _brushCursor = null, _zoomBadge = null;

  // Rect cache — refreshed at gesture start
  let _cachedWsRect = null;
  let _cachedCvRect = null;
  // RAF cursor scheduler
  let _cursorRafId = 0, _pendingCx = 0, _pendingCy = 0;

  let _bridge = null;

  const ICON_BRUSH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.07"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3 0 1.01-.56 1.94-1.46 2.41 1.13.47 2.39.72 3.73.72 2.33 0 4.22-1.89 4.22-4.22 0-1.06-.39-2.03-1.04-2.77"/></svg>`;
  const ICON_ERASER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4L13.3 2.7a2.4 2.4 0 0 1 3.4 0l4.6 4.6a2.4 2.4 0 0 1 0 3.4L11 21"/><path d="M22 21H7"/><path d="m5 11 8 8"/></svg>`;
  const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
  const ICON_FIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="M9 21H3v-6"/><path d="m3 21 7-7"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
  const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  const ICON_LOADER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9"/><path d="M3 12a9 9 0 0 1 9-9"/></svg>`;

  function _t(key, params) {
    return window.ComfyDrawer?.t?.(key, params) ?? key;
  }

  function _iconLabel(icon, label) {
    return `${icon}<span>${label}</span>`;
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function _injectCSS() {
    if (document.getElementById('ms-service-style')) return;
    const s = document.createElement('style');
    s.id = 'ms-service-style';
    s.textContent = `
      .ms-overlay {
        position: fixed; inset: 0; z-index: 10000;
        display: none; flex-direction: column;
        background: var(--cd-panel, #131323);
      }
      .ms-overlay.ms-visible { display: flex; }
      /* Toolbar — now at the BOTTOM */
      .ms-toolbar {
        display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
        background: var(--cd-panel, #131323);
        border-top: 1px solid rgba(255,255,255,0.1);
        flex-shrink: 0;
      }
      .ms-toolbar-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .ms-toolbar-row .ms-tb-btn { flex-shrink: 0; }
      .ms-spacer { flex: 1; min-width: 0; }
      .ms-tb-btn {
        background: rgba(255,255,255,0.08); color: var(--cd-text); border: none;
        border-radius: 8px; padding: 8px 16px; cursor: pointer;
        font-size: 15px; white-space: nowrap; min-width: 40px;
        display: flex; align-items: center; gap: 6px;
        transition: background 0.15s;
      }
      .ms-tb-btn svg { width: 18px; height: 18px; flex: 0 0 auto; }
      .ms-tb-btn:hover { background: rgba(255,255,255,0.16); }
      .ms-tb-btn.active { background: rgba(255,255,255,0.22); }
      .ms-tb-btn.ms-send { background: var(--cd-accent); color: #fff; font-size: 16px; padding: 8px 20px; }
      .ms-tb-btn.ms-send:hover { background: var(--cd-accent-hover); }
      .ms-tb-btn.ms-send:disabled { opacity: 0.5; cursor: wait; }
      .ms-tb-btn.ms-close-btn { color: #f88; }
      .ms-tb-btn.ms-close-btn:hover { background: rgba(180,60,60,0.4); }
      .ms-size-group { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--cd-text-dim); flex: 1; min-width: 0; }
      .ms-size-group input[type=range] { flex: 1; min-width: 60px; height: 6px; cursor: pointer; }
      .ms-size-val { display: inline-block; width: 28px; text-align: right; color: var(--cd-text); font-size: 14px; }
      .ms-divider { width: 1px; height: 22px; background: rgba(255,255,255,0.15); }
      /* Workspace */
      .ms-workspace {
        position: relative; width: 100%; flex: 1; min-height: 0;
        background: var(--cd-panel, #0e0e1a); overflow: hidden; cursor: grab;
      }
      .ms-workspace.ms-drawing { cursor: none; }
      .ms-viewport { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
      .ms-canvas-container { position: relative; display: inline-block; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
      /* Single display canvas — bg+mask composited in JS, no CSS opacity overlay */
      .ms-display-canvas { display: block; touch-action: none; }
      .ms-brush-cursor {
        position: absolute; pointer-events: none; left: 0; top: 0;
        border: 2px solid rgba(255,80,80,0.9);
        box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.3);
        border-radius: 50%; will-change: transform;
        z-index: 10; display: none;
      }
      .ms-zoom-badge {
        position: absolute; bottom: 8px; right: 8px;
        background: rgba(0,0,0,0.6); color: var(--cd-text-dim);
        padding: 2px 8px; border-radius: 4px; font-size: 11px;
        pointer-events: none; z-index: 5;
      }
      /* Node selector bar — above toolbar */
      .ms-node-bar {
        display: flex; align-items: center; gap: 10px;
        padding: 7px 12px; flex-shrink: 0;
        background: rgba(0,0,0,0.3);
        border-top: 1px solid rgba(255,255,255,0.08);
        font-size: 13px; color: var(--cd-text-dim);
      }
      .ms-node-bar label { white-space: nowrap; font-size: 13px; }
      .ms-node-select {
        flex: 1; min-width: 0; background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
        color: var(--cd-text); font-size: 13px; padding: 5px 8px;
      }
      @media (max-width: 700px) {
        .ms-toolbar { padding: 8px; gap: 8px; }
        .ms-toolbar-row { width: 100%; gap: 8px; }
        .ms-toolbar-primary { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; }
        .ms-toolbar-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .ms-toolbar-actions .ms-spacer { display: none; }
        .ms-tb-btn {
          min-width: 0; max-width: 100%; min-height: 44px; padding: 8px;
          justify-content: center; gap: 4px; overflow: hidden;
          font-size: clamp(12px, 3.4vw, 15px);
        }
        .ms-tb-btn.ms-send { padding: 8px; }
        .ms-tb-btn span {
          min-width: 0; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ms-tb-btn span { display: none; }
        .ms-divider { display: none; }
        .ms-size-group { min-width: 0; }
        .ms-size-group input[type=range] { min-width: 0; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── DOM build ─────────────────────────────────────────────────────────────
  function _buildOverlay() {
    _injectCSS();
    const el = document.createElement('div');
    el.className = 'ms-overlay';
    el.innerHTML = `
      <div class="ms-workspace">
        <div class="ms-viewport">
          <div class="ms-canvas-container">
            <canvas class="ms-display-canvas"></canvas>
          </div>
        </div>
        <div class="ms-zoom-badge">100%</div>
        <div class="ms-brush-cursor"></div>
      </div>
      <div class="ms-node-bar">
        <label>${_t('maskeditor.loadInto')}</label>
        <select class="ms-node-select">
          <option value="__auto">${_t('maskeditor.autoNodes')}</option>
        </select>
      </div>
      <div class="ms-toolbar">
        <div class="ms-toolbar-row ms-toolbar-primary">
          <div class="ms-size-group">
            <span class="ms-size-val">40</span>
            <input type="range" class="ms-size-slider" min="1" max="200" value="40">
          </div>
          <button class="ms-tb-btn ms-btn-brush active" aria-pressed="true" title="${_t('maskeditor.pen')}">${_iconLabel(ICON_BRUSH, _t('maskeditor.pen'))}</button>
          <button class="ms-tb-btn ms-btn-eraser" aria-pressed="false" title="${_t('maskeditor.eraser')}">${_iconLabel(ICON_ERASER, _t('maskeditor.eraser'))}</button>
        </div>
        <div class="ms-toolbar-row ms-toolbar-actions">
          <button class="ms-tb-btn ms-btn-clear" title="${_t('maskeditor.clearMask')}">${ICON_TRASH}<span>${_t('maskeditor.clear')}</span></button>
          <button class="ms-tb-btn ms-btn-fit" title="${_t('maskeditor.fitView')}">${_iconLabel(ICON_FIT, _t('maskeditor.fitView'))}</button>
          <div class="ms-spacer"></div>
          <button class="ms-tb-btn ms-send ms-btn-send">${_iconLabel(ICON_CHECK, _t('common.ok'))}</button>
          <button class="ms-tb-btn ms-close-btn ms-btn-close">${_iconLabel(ICON_X, _t('common.cancel'))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    _overlay = el;

    // Off-screen backing canvases (not in DOM) — avoids GPU compositing of two overlay canvases
    _bgCanvas   = document.createElement('canvas');
    _maskCanvas = document.createElement('canvas');
    _ctxBg      = _bgCanvas.getContext('2d');
    _ctxMask    = _maskCanvas.getContext('2d', { willReadFrequently: true });
    // Single DOM display canvas
    _displayCanvas = el.querySelector('.ms-display-canvas');
    _ctxDisplay    = _displayCanvas.getContext('2d');
    _workspace   = el.querySelector('.ms-workspace');
    _viewport    = el.querySelector('.ms-viewport');
    _zoomBadge   = el.querySelector('.ms-zoom-badge');
    _brushCursor = el.querySelector('.ms-brush-cursor');

    _bindToolbar(el);
    _bindWorkspace();
  }

  // ── JS compositing — single display canvas ────────────────────────────────
  // Replaces CSS opacity overlay: no GPU layer merge needed, no mobile flicker.
  function _redraw() {
    if (!_ctxDisplay || !_displayCanvas.width) return;
    _ctxDisplay.clearRect(0, 0, _displayCanvas.width, _displayCanvas.height);
    _ctxDisplay.drawImage(_bgCanvas, 0, 0);
    _ctxDisplay.save();
    _ctxDisplay.globalAlpha = 0.6;
    _ctxDisplay.drawImage(_maskCanvas, 0, 0);
    _ctxDisplay.restore();
  }
  function _scheduleRedraw() {
    if (_redrawRafId) return;
    _redrawRafId = requestAnimationFrame(() => { _redrawRafId = 0; _redraw(); });
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  function _bindToolbar(el) {
    const slider    = el.querySelector('.ms-size-slider');
    const sizeVal   = el.querySelector('.ms-size-val');
    const btnBrush  = el.querySelector('.ms-btn-brush');
    const btnEraser = el.querySelector('.ms-btn-eraser');
    const btnClear  = el.querySelector('.ms-btn-clear');
    const btnFit    = el.querySelector('.ms-btn-fit');
    const btnSend   = el.querySelector('.ms-btn-send');
    const btnClose  = el.querySelector('.ms-btn-close');

    slider.addEventListener('input', () => {
      _brushSize = parseInt(slider.value, 10);
      sizeVal.textContent = _brushSize;
      _updateBrushCursor();
    });
    const setTool = (eraser) => {
      _isEraser = !!eraser;
      btnEraser.classList.toggle('active', _isEraser);
      btnBrush.classList.toggle('active', !_isEraser);
      btnEraser.setAttribute('aria-pressed', String(_isEraser));
      btnBrush.setAttribute('aria-pressed', String(!_isEraser));
    };
    btnBrush.addEventListener('click', () => setTool(false));
    btnEraser.addEventListener('click', () => setTool(true));
    btnClear.addEventListener('click', () => {
      _ctxMask.clearRect(0, 0, _maskCanvas.width, _maskCanvas.height);
      _redraw();
    });
    btnFit.addEventListener('click', () => _fitView());
    btnSend.addEventListener('click', () => _sendToNode(btnSend));
    btnClose.addEventListener('click', () => close(null));
  }

  // ── Brush cursor ──────────────────────────────────────────────────────────
  function _updateBrushCursor() {
    if (!_brushCursor) return;
    const px = _brushSize * _scale;
    if (px < 6) { _brushCursor.style.display = 'none'; return; } // avoid rectangle artifact
    _brushCursor.style.width  = `${px}px`;
    _brushCursor.style.height = `${px}px`;
  }
  function _moveBrushCursor(cx, cy) {
    if (!_brushCursor || !_workspace) return;
    // Use cached rect to avoid forced layout during tight touch loops
    const r  = _cachedWsRect || (_cachedWsRect = _workspace.getBoundingClientRect());
    const rx = _workspace.clientWidth  / r.width;
    const ry = _workspace.clientHeight / r.height;
    const lx = (cx - r.left) * rx;
    const ly = (cy - r.top)  * ry;
    const half = (_brushSize * _scale) / 2;
    // GPU-composited transform — no layout reflow
    _brushCursor.style.transform = `translate(${lx - half}px, ${ly - half}px)`;
  }
  // RAF-throttled cursor scheduler to limit repaints
  function _scheduleCursor(cx, cy) {
    _pendingCx = cx; _pendingCy = cy;
    if (_cursorRafId) return;
    _cursorRafId = requestAnimationFrame(() => {
      _cursorRafId = 0;
      _moveBrushCursor(_pendingCx, _pendingCy);
      _updateBrushCursor();
    });
  }

  // ── Zoom / Pan ────────────────────────────────────────────────────────────
  function _applyTransform() {
    _viewport.style.transform = `translate(${_panX}px,${_panY}px) scale(${_scale})`;
    _zoomBadge.textContent = `${Math.round(_scale * 100)}%`;
    _updateBrushCursor();
  }
  function _fitView() {
    if (!_bgCanvas.width || !_workspace) return;
    const ww = _workspace.clientWidth, wh = _workspace.clientHeight;
    if (ww < 10 || wh < 10) { setTimeout(_fitView, 100); return; }
    const cw = _bgCanvas.width, ch = _bgCanvas.height;
    _scale = Math.min(ww / cw, wh / ch, 1);
    _panX  = (ww - cw * _scale) / 2;
    _panY  = (wh - ch * _scale) / 2;
    _applyTransform();
  }
  function _zoom(delta, cx, cy) {
    const old = _scale;
    const f = delta > 0 ? 0.9 : 1.1;
    _scale = Math.max(0.1, Math.min(10, _scale * f));
    const r = _workspace.getBoundingClientRect();
    const rx = _workspace.clientWidth / r.width;
    const ry = _workspace.clientHeight / r.height;
    const mx = (cx - r.left) * rx, my = (cy - r.top) * ry;
    _panX = mx - (mx - _panX) * (_scale / old);
    _panY = my - (my - _panY) * (_scale / old);
    _applyTransform();
  }
  function _pinchZoom(ratio, cx, cy) {
    const old = _scale;
    _scale = Math.max(0.1, Math.min(10, _scale * ratio));
    const r = _workspace.getBoundingClientRect();
    const rx = _workspace.clientWidth / r.width;
    const ry = _workspace.clientHeight / r.height;
    const mx = (cx - r.left) * rx, my = (cy - r.top) * ry;
    _panX = mx - (mx - _panX) * (_scale / old);
    _panY = my - (my - _panY) * (_scale / old);
    _applyTransform();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function _draw(x, y, isMoving) {
    _ctxMask.lineJoin = 'round'; _ctxMask.lineCap = 'round';
    _ctxMask.lineWidth = _brushSize;
    if (_isEraser) {
      _ctxMask.globalCompositeOperation = 'destination-out';
      _ctxMask.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      _ctxMask.globalCompositeOperation = 'source-over';
      _ctxMask.strokeStyle = '#FF0000';
    }
    _ctxMask.beginPath();
    if (isMoving) { _ctxMask.moveTo(_lastX, _lastY); _ctxMask.lineTo(x, y); }
    else          { _ctxMask.moveTo(x, y);            _ctxMask.lineTo(x, y); }
    _ctxMask.stroke(); _ctxMask.closePath();
    _lastX = x; _lastY = y;
    _scheduleRedraw();
  }

  // ── Workspace events ──────────────────────────────────────────────────────
  function _bindWorkspace() {
    const ws = _workspace;

    // Use cached display-canvas rect (display canvas is the only DOM canvas now)
    const getCanvasPos = (cx, cy) => {
      const r = _cachedCvRect;
      return {
        x: (cx - r.left) * (_displayCanvas.width  / r.width),
        y: (cy - r.top)  * (_displayCanvas.height / r.height),
      };
    };
    const isOverCanvas = (cx, cy) => {
      const r = _cachedCvRect || _displayCanvas.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    const refreshRects = () => {
      _cachedWsRect = ws.getBoundingClientRect();
      _cachedCvRect = _displayCanvas.getBoundingClientRect();
    };

    ws.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      refreshRects();
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        e.preventDefault(); _isPanning = true;
        _panStartX = e.clientX - _panX; _panStartY = e.clientY - _panY;
        ws.setPointerCapture(e.pointerId); ws.style.cursor = 'grabbing'; return;
      }
      if (e.button === 0 && isOverCanvas(e.clientX, e.clientY)) {
        e.preventDefault(); _isDrawing = true; ws.classList.add('ms-drawing');
        const p = getCanvasPos(e.clientX, e.clientY);
        _lastX = p.x; _lastY = p.y; _draw(p.x, p.y, false);
        ws.setPointerCapture(e.pointerId);
      }
    });
    ws.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      if (_brushCursor) { _brushCursor.style.display = 'block'; _scheduleCursor(e.clientX, e.clientY); }
      if (_isPanning) { _panX = e.clientX - _panStartX; _panY = e.clientY - _panStartY; _applyTransform(); return; }
      if (_isDrawing) { e.preventDefault(); const p = getCanvasPos(e.clientX, e.clientY); _draw(p.x, p.y, true); }
    });
    ws.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (_isPanning) { _isPanning = false; ws.style.cursor = ''; }
      if (_isDrawing) { _isDrawing = false; ws.classList.remove('ms-drawing'); }
      _cachedWsRect = null; _cachedCvRect = null;
    });
    ws.addEventListener('pointercancel', () => {
      _isPanning = false; _isDrawing = false;
      ws.classList.remove('ms-drawing'); ws.style.cursor = '';
      _cachedWsRect = null; _cachedCvRect = null;
    });
    ws.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch' && _brushCursor) _brushCursor.style.display = 'block'; });
    ws.addEventListener('pointerleave', () => {
      if (_brushCursor) _brushCursor.style.display = 'none';
      if (_isDrawing) { _isDrawing = false; ws.classList.remove('ms-drawing'); }
      if (_isPanning) { _isPanning = false; ws.style.cursor = ''; }
      _cachedWsRect = null; _cachedCvRect = null;
    });
    ws.addEventListener('wheel', e => { e.preventDefault(); _zoom(e.deltaY, e.clientX, e.clientY); }, { passive: false });

    // Touch state machine
    const T = { IDLE: 0, WAIT: 1, DRAW: 2, PINCH: 3 };
    let tState = T.IDLE, tStart = null, tPinchDist = 0, tPinchCenter = null;
    const THRESH = 8;
    // Cache workspace rect for pinch — reuse across pinch events (no getBCR per frame)
    let tWsRect = null;

    ws.addEventListener('touchstart', e => {
      e.preventDefault();
      const n = e.touches.length;
      if (n >= 3) return;
      if (n === 1 && tState === T.IDLE) {
        refreshRects(); tWsRect = _cachedWsRect;
        tState = T.WAIT; tStart = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
        if (_brushCursor) { _brushCursor.style.display = 'block'; _scheduleCursor(tStart.clientX, tStart.clientY); }
      } else if (n === 2) {
        if (tState === T.DRAW) { _isDrawing = false; ws.classList.remove('ms-drawing'); }
        if (_brushCursor) _brushCursor.style.display = 'none';
        tState = T.PINCH; tWsRect = ws.getBoundingClientRect();
        tPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        tPinchCenter = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      }
    }, { passive: false });

    ws.addEventListener('touchmove', e => {
      e.preventDefault(); const n = e.touches.length;
      if (tState === T.WAIT && n === 1) {
        const t = e.touches[0];
        if (_brushCursor) { _brushCursor.style.display = 'block'; _scheduleCursor(t.clientX, t.clientY); }
        if (Math.hypot(t.clientX - tStart.clientX, t.clientY - tStart.clientY) > THRESH && isOverCanvas(tStart.clientX, tStart.clientY)) {
          tState = T.DRAW; _isDrawing = true; ws.classList.add('ms-drawing');
          const p0 = getCanvasPos(tStart.clientX, tStart.clientY); _lastX = p0.x; _lastY = p0.y; _draw(p0.x, p0.y, false);
          const pc = getCanvasPos(t.clientX, t.clientY); _draw(pc.x, pc.y, true);
        }
      } else if (tState === T.DRAW && n === 1) {
        const t = e.touches[0];
        if (_brushCursor) _scheduleCursor(t.clientX, t.clientY);
        const p = getCanvasPos(t.clientX, t.clientY); _draw(p.x, p.y, true);
      } else if (tState === T.PINCH && n === 2) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        if (tPinchDist > 0) _pinchZoom(dist / tPinchDist, cx, cy);
        tPinchDist = dist;
        if (tPinchCenter && tWsRect) {
          // Use cached rect — no getBoundingClientRect during pinch frames
          const rw = tWsRect.width, rh = tWsRect.height;
          _panX += (cx - tPinchCenter.x) * (ws.clientWidth  / rw);
          _panY += (cy - tPinchCenter.y) * (ws.clientHeight / rh);
          _applyTransform();
        }
        tPinchCenter = { x: cx, y: cy };
      }
    }, { passive: false });

    ws.addEventListener('touchend', e => {
      e.preventDefault(); const rem = e.touches.length;
      if (tState === T.WAIT && rem === 0) {
        if (tStart && isOverCanvas(tStart.clientX, tStart.clientY)) { const p = getCanvasPos(tStart.clientX, tStart.clientY); _draw(p.x, p.y, false); }
        if (_brushCursor) _brushCursor.style.display = 'none';
        tState = T.IDLE; tStart = null; _cachedCvRect = null; _cachedWsRect = null;
      } else if (tState === T.DRAW && rem === 0) {
        _isDrawing = false; ws.classList.remove('ms-drawing');
        if (_brushCursor) _brushCursor.style.display = 'none';
        tState = T.IDLE; tStart = null; _cachedCvRect = null; _cachedWsRect = null;
      } else if (tState === T.PINCH && rem <= 1) { tState = T.IDLE; tStart = null; tPinchCenter = null; tWsRect = null; }
    }, { passive: false });

    ws.addEventListener('touchcancel', () => {
      if (tState === T.DRAW) { _isDrawing = false; ws.classList.remove('ms-drawing'); }
      if (_brushCursor) _brushCursor.style.display = 'none';
      tState = T.IDLE; tStart = null; tPinchCenter = null; tWsRect = null;
      _cachedCvRect = null; _cachedWsRect = null;
    });
  }

  // ── Image loading ─────────────────────────────────────────────────────────
  function _loadImage(url, filename) {
    _currentFilename = filename || 'mask_base.png';
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      _naturalW = img.naturalWidth; _naturalH = img.naturalHeight;
      // Detect GPU texture limit via WebGL; cap canvas to that limit.
      // On mobile this is commonly 4096 or 8192 — we cap lower for safety.
      const gl = document.createElement('canvas').getContext('webgl') ||
                 document.createElement('canvas').getContext('experimental-webgl');
      const glMax = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096;
      const isMobile = navigator.maxTouchPoints > 1 || /Mobi|Android/i.test(navigator.userAgent);
      const limit = Math.min(glMax, isMobile ? 2048 : 4096);
      const ratio = Math.min(1, limit / Math.max(_naturalW, _naturalH));
      const dw = Math.round(_naturalW * ratio), dh = Math.round(_naturalH * ratio);

      // All three canvases at the same capped resolution
      _bgCanvas.width   = dw; _bgCanvas.height   = dh;
      _maskCanvas.width = dw; _maskCanvas.height = dh;
      _displayCanvas.width  = dw; _displayCanvas.height  = dh;
      // CSS size = canvas size (viewport transform handles zoom — no extra CSS scaling)
      _displayCanvas.style.width  = `${dw}px`;
      _displayCanvas.style.height = `${dh}px`;

      _ctxBg.clearRect(0, 0, dw, dh);
      _ctxBg.drawImage(img, 0, 0, dw, dh);  // scale bg to capped size
      _ctxMask.clearRect(0, 0, dw, dh);
      _cachedCvRect = null; _cachedWsRect = null;
      _redraw();
      requestAnimationFrame(() => requestAnimationFrame(() => _fitView()));
    };
    img.src = url;
  }

  // ── Send to node ──────────────────────────────────────────────────────────
  function _populateNodeSelect() {
    const sel = _overlay?.querySelector('.ms-node-select');
    if (!sel) return;
    // Remove all except the first "auto" option
    while (sel.options.length > 1) sel.remove(1);
    const targets = enumerateLoadImageTargets(_bridge, { maskOnly: true });
    for (const target of targets) {
      const opt = document.createElement('option');
      opt.value = `${target.kind}:${target.nodeId}:${target.widgetName}`;
      opt.textContent = `[${target.nodeId}] ${target.nodeTitle} / ${target.displayName || target.widgetName}`;
      sel.appendChild(opt);
    }
  }

  async function _sendToNode(btnSend) {
    if (!_bgCanvas.width) {
      await (window.ComfyDrawer?.showAlert?.(_t('maskeditor.noImage'), { variant: 'warning' })
        ?? Promise.resolve());
      return;
    }
    btnSend.disabled = true; btnSend.innerHTML = _iconLabel(ICON_LOADER, _t('common.processing'));
    try {
      // Export: scale mask back to full natural resolution for best quality
      const ew = _naturalW || _displayCanvas.width;
      const eh = _naturalH || _displayCanvas.height;
      const exp = document.createElement('canvas'); exp.width = ew; exp.height = eh;
      const eCtx = exp.getContext('2d');
      eCtx.drawImage(_bgCanvas,   0, 0, ew, eh);
      eCtx.globalCompositeOperation = 'destination-out';
      eCtx.drawImage(_maskCanvas, 0, 0, ew, eh);

      const blob = await new Promise(r => exp.toBlob(r, 'image/png'));
      const base = (_currentFilename || 'mask_base').replace(/\.[^/.]+$/, '');
      const fname = `${base}_mask_${Date.now()}.png`;
      const uploadResult = await _bridge.uploadImage(new File([blob], fname, { type: 'image/png' }), 'drawer_masks', true);
      const widgetValue = uploadResult.subfolder
        ? `${uploadResult.subfolder}/${uploadResult.name}`
        : uploadResult.name;

      // Read selected node from the node-bar selector
      const sel = _overlay?.querySelector('.ms-node-select');
      const selectedId = sel?.value;

      let applied = false;
      const targets = enumerateLoadImageTargets(_bridge, { maskOnly: true });
      if (selectedId && selectedId !== '__auto') {
        const target = targets.find(t => `${t.kind}:${t.nodeId}:${t.widgetName}` === selectedId);
        target?.addOption?.(widgetValue);
        applied = target?.setValue(widgetValue) || false;
      } else {
        // Auto: apply to all LoadImageMask-compatible targets
        for (const target of targets) {
          target.addOption?.(widgetValue);
          if (target.setValue(widgetValue)) applied = true;
        }
      }
      _showToast(applied
        ? _t('maskeditor.applied', { name: widgetValue })
        : _t('maskeditor.saved', { name: widgetValue }));
      close({ applied, filename: widgetValue });
    } catch (e) {
      console.error(e);
      await (window.ComfyDrawer?.showAlert?.(`${_t('maskeditor.sendFailed')}: ${e.message}`, { variant: 'danger' })
        ?? Promise.resolve());
    } finally {
      btnSend.disabled = false; btnSend.innerHTML = _iconLabel(ICON_CHECK, _t('common.ok'));
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function _showToast(msg) {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      padding: '8px 18px', background: 'rgba(0,0,0,.85)', color: 'var(--cd-text)',
      borderRadius: '8px', fontSize: '13px', zIndex: '230000', transition: 'opacity .3s',
    });
    el.textContent = msg; document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  }

  // Document-level Escape handler registered while the overlay is visible.
  // Captured outside `open()` so it is the same reference at install &
  // remove time (closures created on every open would leak).
  let _onDocumentKeyDown = null;

  // ── Public API ────────────────────────────────────────────────────────────
  function open({ url, filename, bridge } = {}) {
    if (window.__xyzSweepActive) return Promise.resolve(null);
    _bridge = bridge;

    // Reentrant open: resolve the pending promise with null so the
    // previous awaiter sees a cancellation rather than hanging forever,
    // then start a fresh session. Without this, a double-tap on a
    // LoadImageMask widget left the first caller permanently pending.
    if (_resolveOpen) {
      const prev = _resolveOpen;
      _resolveOpen = null;
      try { prev(null); } catch { /* ignore */ }
    }

    if (!_overlay) _buildOverlay();

    // Reset state
    _isEraser = false; _isDrawing = false; _isPanning = false;
    _scale = 1; _panX = 0; _panY = 0;
    const btnBrush = _overlay.querySelector('.ms-btn-brush');
    const btnEraser = _overlay.querySelector('.ms-btn-eraser');
    if (btnBrush && btnEraser) {
      btnBrush.classList.add('active');
      btnBrush.setAttribute('aria-pressed', 'true');
      btnEraser.classList.remove('active');
      btnEraser.setAttribute('aria-pressed', 'false');
    }

    // Close lightbox if open
    window.ComfyDrawer?.closeLightbox?.();

    _overlay.classList.add('ms-visible');
    _populateNodeSelect();

    if (url) _loadImage(url, filename);

    // Escape cancels the overlay. Use capture phase so the listener wins
    // against other handlers that might `stopPropagation` first.
    if (!_onDocumentKeyDown) {
      _onDocumentKeyDown = (e) => {
        if (e.key !== 'Escape') return;
        if (!_overlay?.classList.contains('ms-visible')) return;
        e.preventDefault();
        e.stopPropagation();
        close(null);
      };
      document.addEventListener('keydown', _onDocumentKeyDown, true);
    }

    return new Promise(resolve => { _resolveOpen = resolve; });
  }

  function close(result = null) {
    if (_overlay) _overlay.classList.remove('ms-visible');
    if (_brushCursor) _brushCursor.style.display = 'none';
    if (_onDocumentKeyDown) {
      document.removeEventListener('keydown', _onDocumentKeyDown, true);
      _onDocumentKeyDown = null;
    }
    if (_resolveOpen) {
      const resolve = _resolveOpen;
      _resolveOpen = null;
      try { resolve(result); } catch { /* ignore */ }
    }
  }

  return { open, close };
})();

export { MaskService };
