/**
 * Shared Lightbox — unified fullscreen media viewer for ComfyDrawer.
 *
 * Supports: image, video, audio
 * Features: swipe, keyboard, context menu, back button, autoplay
 *
 * Usage (third-party gadgets — via public API, no import needed):
 *   const { openLightbox, closeLightbox } = window.ComfyDrawer;
 *   openLightbox(items, startIndex, options);
 *
 * Usage (built-in gadgets — via ES import):
 *   import { openLightbox, closeLightbox } from '../../js/lightbox.js';
 *
 * Options:
 *   autoplay:        boolean           // auto-play videos (default false)
 *   contextMenuType: string            // custom ctx type (default 'lightbox-media')
 *   contextMenuData: (item) => object  // transform item → ctx data
 *   onKey:           (key, item, index) => void  // unhandled key callback
 *   onClose:         () => void        // called when lightbox closes
 *
 * Items: Array<{ src, type: 'image'|'video'|'audio', label?, info?, infoHTML?, data? }>
 *
 *   info       — Plain-text secondary info; rendered safely via escapeHTML.
 *                Use this for anything that may have come from a file, the
 *                graph, or a third-party metadata provider.
 *   infoHTML   — Trusted HTML escape hatch. Use ONLY when the caller has
 *                already escaped every untrusted value (e.g. assembled the
 *                string from escapeHTML() outputs). Untrusted strings here
 *                are XSS — prefer `info`.
 */

import { ContextMenuService } from './context-menu.js';
import { initCustomDrag } from '../components/media-card.js';
import { escapeHTML } from '../utils.js';

const DEFAULT_CTX_TYPE = 'media-file';
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

let root = null;
let el = {};
let items = [];
let index = 0;
let opts = {};
let cssReady = null;
let openToken = 0;
let itemToken = 0;

/* ═══ DOM ═══ */

function ensureDOM() {
  if (root) return;

  // Load lightbox CSS (standalone — no dependency on gallery.css)
  // Use specific selector to avoid collision with other extensions' lightbox.css
  if (!cssReady) {
    const existing = document.querySelector('link[href*="ComfyUI-Drawer"][href*="lightbox.css"]');
    if (existing) {
      cssReady = Promise.resolve();
    } else {
      cssReady = new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../../css/lightbox.css', import.meta.url).href;
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
        document.head.appendChild(link);
      });
    }
  }

  root = document.createElement('div');
  root.className = 'cd-lightbox-root';
  root.style.cssText = 'position:fixed;inset:0;z-index:100000;pointer-events:none;';
  root.innerHTML = `
    <div class="cd-lightbox" hidden>
      <div class="cd-lightbox-backdrop"></div>
      <button class="cd-lightbox-nav cd-lightbox-prev">‹</button>
      <button class="cd-lightbox-nav cd-lightbox-next">›</button>
      <div class="cd-lightbox-body">
        <div class="cd-lightbox-topbar">
          <span class="cd-lightbox-counter"></span>
          <button class="cd-lightbox-close">${X_ICON}</button>
        </div>
        <div class="cd-lightbox-media">
          <img class="cd-lightbox-img" alt="">
          <video class="cd-lightbox-video" controls loop style="display:none"></video>
          <audio class="cd-lightbox-audio" controls loop style="display:none"></audio>
        </div>
        <div class="cd-lightbox-info"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const q = (s) => root.querySelector(s);
  el = {
    lightbox:  q('.cd-lightbox'),
    backdrop:  q('.cd-lightbox-backdrop'),
    img:       q('.cd-lightbox-img'),
    video:     q('.cd-lightbox-video'),
    audio:     q('.cd-lightbox-audio'),
    info:      q('.cd-lightbox-info'),
    counter:   q('.cd-lightbox-counter'),
    prev:      q('.cd-lightbox-prev'),
    next:      q('.cd-lightbox-next'),
    close:     q('.cd-lightbox-close'),
    media:     q('.cd-lightbox-media'),
  };

  // Events
  el.backdrop.addEventListener('click', closeLightbox);
  el.close.addEventListener('click', closeLightbox);
  el.prev.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
  el.next.addEventListener('click', (e) => { e.stopPropagation(); go(1); });
  el.img.addEventListener('click', (e) => { e.stopPropagation(); openInNewTab(); });
  el.video.addEventListener('dblclick', (e) => { e.stopPropagation(); openInNewTab(); });

  // Drag from lightbox → close lightbox, start ghost drag to canvas
  initCustomDrag(el.media, el.img, {
    get src() { return items[index]?.src || ''; },
    get filename() {
      const item = items[index];
      if (!item) return 'image';
      // Try to extract filename from URL query param first
      if (item.src) {
        try {
          const u = new URL(item.src, location.origin);
          const f = u.searchParams.get('filename');
          if (f) return f;
        } catch { /* ignore */ }
      }
      return item.name || item.label || 'image';
    },
    mediaType: 'image',
    dragThreshold: 20,
    onDragStart: () => {
      closeLightbox();
    },
  });

  // Keyboard (capture phase — blocks ComfyUI when open)
  document.addEventListener('keydown', (e) => {
    if (el.lightbox.hidden) return;

    // Let browser shortcuts pass through (F-keys, Ctrl/Alt/Meta combos)
    if (e.ctrlKey || e.altKey || e.metaKey || e.key.startsWith('F')) return;

    switch (e.key) {
      case 'Escape':
        e.stopPropagation(); e.preventDefault();
        e._escapeClaimed = true; closeLightbox(); break;
      case 'ArrowLeft': case 'a': case 'A':
        e.stopPropagation(); e.preventDefault();
        go(-1); break;
      case 'ArrowRight': case 'd': case 'D':
        e.stopPropagation(); e.preventDefault();
        go(1); break;
      case 'w': case 'W':
        e.stopPropagation(); e.preventDefault();
        openInNewTab(); break;
      default:
        // Block ComfyUI shortcuts but forward to caller
        e.stopPropagation(); e.preventDefault();
        if (opts.onKey) opts.onKey(e.key, items[index], index);
        break;
    }
  }, { capture: true });

  // Touch swipe
  let touchStartX = 0, touchStartY = 0;
  el.lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
  }, { passive: true });
  el.lightbox.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx > 0) go(-1);
      else go(1);
    }
  }, { passive: true });

  // Back button (mobile) — via bus, no direct shell coupling
  window.ComfyDrawer?.bus?.on('drawer:back-button', () => {
    if (el.lightbox.hidden) return;
    closeLightbox();
    // Notify Shell that lightbox consumed the back press
    window.ComfyDrawer?.bus?.emit('drawer:back-handled');
  });

  // Context menu trigger on media
  const ctxMenu = window.ComfyDrawer?.contextMenu;
  if (ctxMenu) {
    ContextMenuService.attachTrigger(el.media, async (e) => {
      const item = items[index];
      if (!item) return;
      const type = opts.contextMenuType || DEFAULT_CTX_TYPE;
      let data = opts.contextMenuData ? await opts.contextMenuData(item) : { ...item };
      // URL-parse fallback: extract name/subfolder/source from src URL
      // when the caller didn't provide them.
      if (data && !data.name && data.src) {
        try {
          const u = new URL(data.src, location.origin);
          data.name = u.searchParams.get('filename') || '';
          data.subfolder = u.searchParams.get('subfolder') || '';
          data.source = u.searchParams.get('type') || 'output';
        } catch { /* non-parseable src — leave as is */ }
      }
      if (data && !data.source) data.source = 'output';
      // Propagate hasWorkflow from item (set by MediaCard async check)
      if (data && data.hasWorkflow === undefined && item.hasWorkflow !== undefined) {
        data.hasWorkflow = item.hasWorkflow;
      }
      ctxMenu.show(type, data, e.clientX, e.clientY);
    });
  }
}

/* ═══ Display ═══ */

function showItem(i) {
  index = i;
  const item = items[i];
  if (!item) return;
  const token = ++itemToken;

  // Hide all media
  el.img.style.display = 'none';
  el.video.style.display = 'none';
  el.video.pause();
  el.video.src = '';
  el.audio.style.display = 'none';
  el.audio.pause();
  el.audio.src = '';

  const autoplay = opts.autoplay || false;

  if (item.type === 'video') {
    el.video.style.display = 'block';
    el.video.preload = 'metadata';
    el.video.playsInline = true;
    el.video.onloadedmetadata = () => updateMediaMeta(token, item, el.video);
    el.video.onerror = () => renderInfo(item, '');
    el.video.src = item.src;
    el.video.load?.();
    if (autoplay) el.video.play().catch(() => {});
  } else if (item.type === 'audio') {
    el.audio.style.display = 'block';
    el.audio.src = item.src;
    if (autoplay) el.audio.play().catch(() => {});
  } else {
    el.img.style.display = 'block';
    el.img.onload = () => updateMediaMeta(token, item, el.img);
    el.img.src = item.src;
    if (el.img.complete && el.img.naturalWidth) {
      updateMediaMeta(token, item, el.img);
    }
  }

  el.counter.textContent = items.length > 1
    ? `${i + 1} / ${items.length}` : '';

  renderInfo(item, '');

  el.prev.disabled = i <= 0;
  el.next.disabled = i >= items.length - 1;
}

function formatMediaDimensions(width, height) {
  width = Math.round(Number(width) || 0);
  height = Math.round(Number(height) || 0);
  if (!width || !height) return '';
  const mp = width * height / (1024 * 1024);
  const scale = mp >= 1 ? 10 : 100;
  const rounded = Math.round(mp * scale) / scale;
  const mpText = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${width}x${height} (${mpText} MP)`;
}

function renderInfo(item, mediaMeta = '') {
  const parts = [];
  if (item.label) {
    parts.push(`<div class="cd-lightbox-info-row cd-lightbox-info-primary">${escapeHTML(item.label)}</div>`);
  }
  if (item.details) {
    parts.push(`<div class="cd-lightbox-info-row cd-lightbox-info-secondary">${escapeHTML(item.details)}</div>`);
  } else if (item.info) {
    // Plain-text path — always escaped. Untrusted strings should land here.
    parts.push(`<div class="cd-lightbox-info-row cd-lightbox-info-secondary">${escapeHTML(item.info)}</div>`);
  } else if (item.infoHTML) {
    // Trusted HTML escape hatch. Callers are responsible for escaping every
    // untrusted value baked into this string.
    parts.push(`<div class="cd-lightbox-custom-info">${item.infoHTML}</div>`);
  }
  parts.push(`<div class="cd-lightbox-info-row cd-lightbox-info-secondary cd-lightbox-media-meta">${escapeHTML(mediaMeta || '')}</div>`);
  el.info.innerHTML = parts.join('');
}

function updateMediaMeta(token, item, mediaEl) {
  if (token !== itemToken || item !== items[index]) return;
  const width = mediaEl.naturalWidth || mediaEl.videoWidth || 0;
  const height = mediaEl.naturalHeight || mediaEl.videoHeight || 0;
  renderInfo(item, formatMediaDimensions(width, height));
}

function go(delta) {
  const next = index + delta;
  if (next < 0 || next >= items.length) return;
  showItem(next);
}

function openInNewTab() {
  const item = items[index];
  if (!item || typeof item.src !== 'string') return;
  // Reject anything that is not a same-origin http(s) URL — `javascript:`
  // and `data:` schemes can execute in the parent context.
  try {
    const u = new URL(item.src, location.origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.origin !== location.origin) return;
  } catch {
    return;
  }
  window.open(item.src, '_blank', 'noopener,noreferrer');
}



/* ═══ Public API ═══ */

/**
 * Open the shared lightbox.
 * @param {Array<{src: string, type: 'image'|'video'|'audio', label?: string, info?: string, infoHTML?: string, data?: *}>} mediaItems
 *   `info` is rendered as plain text (escaped). `infoHTML` is a trusted-HTML
 *   escape hatch — caller is responsible for escaping untrusted values.
 * @param {number} startIndex
 * @param {object} [options]
 * @param {boolean} [options.autoplay] - Auto-play video/audio
 * @param {string} [options.contextMenuType] - Custom context menu type
 * @param {function} [options.contextMenuData] - Transform item → context menu data
 * @param {function} [options.onKey] - Callback for unhandled keys: (key, item, index)
 * @param {function} [options.onClose] - Called when lightbox closes
 */
export function openLightbox(mediaItems, startIndex = 0, options = {}) {
  ensureDOM();
  const token = ++openToken;
  items = mediaItems;
  opts = options;
  root.style.pointerEvents = 'auto';
  showItem(startIndex);
  const reveal = () => {
    if (token !== openToken) return;
    requestAnimationFrame(() => {
      if (token !== openToken) return;
      el.lightbox.hidden = false;
    });
  };
  if (cssReady) cssReady.then(reveal);
  else reveal();
}

/**
 * Close the lightbox.
 */
export function closeLightbox() {
  if (!root || el.lightbox.hidden) return;
  openToken++;
  el.lightbox.hidden = true;
  root.style.pointerEvents = 'none';
  el.video.pause();
  el.video.onloadedmetadata = null;
  el.video.onerror = null;
  el.video.src = '';
  el.audio.pause();
  el.audio.src = '';
  el.img.onload = null;
  el.img.src = '';
  // Evacuate callback before resetting state — onClose may
  // call openLightbox(), so opts/items must already be clean.
  const onClose = opts.onClose;
  items = [];
  index = 0;
  opts = {};
  if (onClose) onClose();
}

/**
 * Get current item index.
 */
export function getLightboxIndex() {
  return index;
}

/**
 * Check if the lightbox is currently open.
 */
export function isLightboxOpen() {
  return root != null && el.lightbox != null && !el.lightbox.hidden;
}

/**
 * Remove an item from the lightbox (e.g. after deletion).
 * Navigates to next/prev or closes if empty.
 * @param {number} idx - Index to remove
 */
export function removeLightboxItem(idx) {
  if (idx < 0 || idx >= items.length) return;
  items.splice(idx, 1);
  if (items.length === 0) {
    closeLightbox();
  } else {
    index = Math.min(idx, items.length - 1);
    showItem(index);
  }
}
