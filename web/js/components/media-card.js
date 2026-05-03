/**
 * ComfyDrawer — MediaCard Component
 * Shared thumbnail/media card for all gadgets.
 *
 * Usage:
 *   import { createMediaCard, createMediaGrid } from './media-card.js';
 *   const card = createMediaCard({ src, filename, ... });
 *   container.appendChild(card.element);
 *   card.info.innerHTML = '<div>my custom info</div>';
 */

/** @type {IntersectionObserver|null} Shared lazy-load observer */
let _lazyObserver = null;

function getLazyObserver() {
    if (!_lazyObserver) {
        _lazyObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const el = entry.target;
                const src = el.dataset.lazySrc;
                if (src) {
                    el.src = src;
                    delete el.dataset.lazySrc;
                }
                _lazyObserver.unobserve(el);
            }
        }, { rootMargin: '200px' });
    }
    return _lazyObserver;
}

/* ───────────────────────────────────────────────────────
   Custom Drag → ComfyUI Canvas
   Uses mousedown/move/up instead of native D&D so we can
   async-fetch the blob during the drag and dispatch a
   synthetic 'drop' event on mouseup.
   ─────────────────────────────────────────────────────── */
const DRAG_THRESHOLD = 6; // px before drag starts

export function initCustomDrag(card, thumbEl, opts = {}) {

    // Prevent native image/video drag entirely
    thumbEl.draggable = false;
    card.draggable = false;

    let isDragging = false;
    let ghost = null;
    let blobPromise = null;
    /** Values captured at drag-start time — survives lightbox close */
    let dragSrc = '';
    let dragFilename = '';

    // Block text/image selection during drag
    const blockSelect = (e) => e.preventDefault();

    // Cancel drag when browser loses focus (screen capture, Alt+Tab, etc.)
    const onFocusLost = () => {
        if (isDragging) { cleanupDrag(); card.dataset.mcDrag = ''; }
    };

    const cleanupDrag = () => {
        isDragging = false;
        dragSrc = '';
        dragFilename = '';
        if (ghost) { ghost.remove(); ghost = null; }
        setFolderHighlight(null);
        blobPromise = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('keydown', onEsc);
        document.removeEventListener('selectstart', blockSelect);
        window.removeEventListener('blur', onFocusLost);
        document.removeEventListener('visibilitychange', onFocusLost);
    };

    let highlightedFolder = null;

    const setFolderHighlight = (folderEl) => {
        if (highlightedFolder === folderEl) return;
        if (highlightedFolder) highlightedFolder.classList.remove('gg-drop-target');
        highlightedFolder = folderEl;
        if (highlightedFolder) highlightedFolder.classList.add('gg-drop-target');
    };

    const onMove = (ev) => {
        if (!isDragging) return;
        if (ghost) {
            ghost.style.left = `${ev.clientX}px`;
            ghost.style.top = `${ev.clientY}px`;
        }

        const elUnder = document.elementFromPoint(ev.clientX, ev.clientY);

        // Check for folder drop target in drawer
        const folderCard = elUnder?.closest('.gg-folder-card[data-folder-path]');
        if (folderCard) {
            setFolderHighlight(folderCard);
            return;
        }
        setFolderHighlight(null);
    };

    const onUp = async (ev) => {
        if (!isDragging) { cleanupDrag(); return; }

        const savedBlobPromise = blobPromise;
        const savedHighlightedFolder = highlightedFolder;
        const savedDragSrc = dragSrc;
        const savedDragFilename = dragFilename;
        setFolderHighlight(null);
        cleanupDrag();

        // Suppress the click event that follows mouseup
        setTimeout(() => { card.dataset.mcDrag = ''; }, 0);

        // If dropped on a folder card → notify via callback
        if (savedHighlightedFolder) {
            const folderPath = savedHighlightedFolder.dataset.folderPath;
            if (folderPath && opts.onFolderDrop) {
                opts.onFolderDrop(folderPath);
            }
            return;
        }

        // If dropped inside the drawer or lightbox → do nothing
        const dropTarget = document.elementFromPoint(ev.clientX, ev.clientY);
        if (dropTarget) {
            const inDrawer = dropTarget.closest('.comfy-drawer');
            const inLightbox = dropTarget.closest('.cd-lightbox');
            if (inDrawer || inLightbox) return;
        }

        const file = savedBlobPromise ? await savedBlobPromise : null;
        if (!file) return;

        // Otherwise, try to open as workflow via platform API.
        // If no workflow found, fall back to handleFile (adds LoadImage node,
        // which is the expected D&D behavior for plain images).
        const openWF = window.ComfyDrawer?.openWorkflowFromMedia;
        if (openWF) {
            const loaded = await openWF({ src: savedDragSrc, name: savedDragFilename });
            if (!loaded) {
                // No workflow → D&D fallback: pass blob to ComfyUI
                await window.ComfyDrawer?.bridge?.handleFile?.(file);
            }
        }
    };

    const onEsc = (ev) => {
        if (ev.key === 'Escape') { cleanupDrag(); card.dataset.mcDrag = ''; }
    };

    const threshold = opts.dragThreshold || DRAG_THRESHOLD;

    card.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return; // left-click only
        const startX = ev.clientX;
        const startY = ev.clientY;

        const onFirstMove = (mv) => {
            const dx = mv.clientX - startX;
            const dy = mv.clientY - startY;
            if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

            // Passed threshold → start custom drag
            document.removeEventListener('mousemove', onFirstMove);
            document.removeEventListener('mouseup', onFirstUp);
            isDragging = true;

            // Prevent text/image selection
            document.addEventListener('selectstart', blockSelect);
            window.getSelection()?.removeAllRanges();

            // Auto-cancel drag on focus loss
            window.addEventListener('blur', onFocusLost);
            document.addEventListener('visibilitychange', onFocusLost);

            // Mark card so click handler is suppressed
            card.dataset.mcDrag = 'active';

            // Read src/filename lazily from opts (supports getters for dynamic values)
            // IMPORTANT: capture now, before onDragStart may close lightbox and
            // invalidate getter return values (items=[]).
            const curSrc = opts.src;
            const curFilename = opts.filename;
            const curMediaType = opts.mediaType || 'image';

            // Persist for onUp — getters may return stale values after lightbox close
            dragSrc = curSrc;
            dragFilename = curFilename;

            // Start fetching blob immediately (before onDragStart which may clear src)
            const imgSrc = thumbEl.src || curSrc;
            if (imgSrc) {
                blobPromise = fetch(imgSrc)
                    .then(r => r.blob())
                    .then(b => {
                        const ext = (curFilename || '').split('.').pop() || 'png';
                        return new File([b], curFilename || `image.${ext}`, { type: b.type || `image/${ext}` });
                    })
                    .catch(() => null);
            }

            // Notify caller (e.g. lightbox close) — after blob fetch is started
            if (opts.onDragStart) opts.onDragStart();

            // Create ghost
            ghost = document.createElement('div');
            ghost.className = 'mc-drag-ghost';
            ghost.style.pointerEvents = 'none'; // Ensure elementFromPoint sees through
            const img = document.createElement('img');
            img.src = imgSrc;
            img.draggable = false;
            ghost.appendChild(img);
            if (curFilename) {
                const label = document.createElement('div');
                label.className = 'mc-drag-ghost-label';
                label.textContent = curFilename;
                ghost.appendChild(label);
            }
            ghost.style.left = `${mv.clientX}px`;
            ghost.style.top = `${mv.clientY}px`;
            document.body.appendChild(ghost);

            // Switch to drag listeners
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('keydown', onEsc);
        };

        const onFirstUp = () => {
            document.removeEventListener('mousemove', onFirstMove);
            document.removeEventListener('mouseup', onFirstUp);
        };

        document.addEventListener('mousemove', onFirstMove);
        document.addEventListener('mouseup', onFirstUp);
    });

    // Suppress click when dragging
    card.addEventListener('click', (e) => {
        if (card.dataset.mcDrag === 'active') {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true); // capture phase so it fires before lightbox handler
}

/* ───────────────────────────────────────────────────────
   Touch-based drag for mobile (future extension point)
   ─────────────────────────────────────────────────────── */

/**
 * Create a MediaCard element.
 * @param {object} opts
 * @param {string} opts.src - Image/video URL
 * @param {string} [opts.filename] - Filename (used for Lightbox / D&D)
 * @param {string} [opts.subfolder] - Subfolder path
 * @param {string} [opts.type='output'] - 'output' | 'input' | 'temp'
 * @param {string} [opts.mediaType='image'] - 'image' | 'video' | 'audio'
 * @param {boolean} [opts.lightbox=true] - Open Lightbox on click
 * @param {boolean} [opts.draggable=true] - Custom drag to ComfyUI canvas
 * @param {boolean} [opts.lazy=true] - Lazy-load the thumbnail
 * @param {number|null} [opts.thumbHeight=160] - Thumbnail height in px (null = auto)
 * @param {Function|null} [opts.onClick] - Custom click handler (overrides lightbox)
 * @param {Function|null} [opts.onContextMenu] - Right-click / long-tap handler
 * @param {Array|null} [opts.lightboxItems] - Full item list for multi-item Lightbox navigation
 * @param {number} [opts.lightboxIndex=0] - Starting index in lightboxItems
 * @returns {MediaCard}
 */
export function createMediaCard(opts = {}) {
    const {
        src,
        filename = '',
        subfolder = '',
        type = 'output',
        mediaType = 'image',
        lightbox = true,
        draggable = true,
        lazy = true,
        thumbHeight = 160,
        onClick = null,
        onContextMenu = null,
        lightboxItems = null,
        lightboxIndex = 0,
        lightboxOptions = null,
    } = opts;

    // ── Build DOM ──
    const card = document.createElement('div');
    card.className = 'mc-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'mc-thumb-wrap';
    if (thumbHeight != null) thumbWrap.style.height = `${thumbHeight}px`;

    let thumbEl;
    if (mediaType === 'video') {
        thumbEl = document.createElement('video');
        thumbEl.muted = true;
        thumbEl.loop = true;
        thumbEl.playsInline = true;
        thumbEl.preload = 'auto';
        // Capture first frame as poster once video data is loaded
        thumbEl.addEventListener('loadeddata', () => {
            thumbEl.dataset.loaded = 'true';
            try {
                const c = document.createElement('canvas');
                c.width = thumbEl.videoWidth;
                c.height = thumbEl.videoHeight;
                c.getContext('2d').drawImage(thumbEl, 0, 0);
                thumbEl.poster = c.toDataURL('image/jpeg', 0.8);
            } catch { /* CORS or other error — frame still visible via video element */ }
        }, { once: true });
        // Hover to preview
        card.addEventListener('mouseenter', () => thumbEl.play?.());
        card.addEventListener('mouseleave', () => { thumbEl.pause?.(); thumbEl.currentTime = 0; });
    } else {
        thumbEl = document.createElement('img');
        thumbEl.loading = lazy ? 'lazy' : 'eager';
        thumbEl.decoding = 'async';
    }
    thumbEl.className = 'mc-thumb';
    thumbEl.dataset.loaded = 'false';
    thumbEl.alt = filename;
    thumbEl.draggable = false; // Always disable native image drag

    // Lazy loading via IntersectionObserver
    if (lazy && src) {
        thumbEl.dataset.lazySrc = src;
        getLazyObserver().observe(thumbEl);
    } else if (src) {
        thumbEl.src = src;
    }

    // Loaded state (images only — video uses loadeddata handler above)
    if (mediaType !== 'video') {
        thumbEl.addEventListener('load', () => { thumbEl.dataset.loaded = 'true'; }, { once: true });
    }
    thumbEl.addEventListener('error', () => { thumbEl.dataset.loaded = 'true'; }); // show broken state

    thumbWrap.appendChild(thumbEl);
    card.appendChild(thumbWrap);

    // Info container (gadgets append their own content here)
    const info = document.createElement('div');
    info.className = 'mc-info';
    card.appendChild(info);

    // ── Lightbox ──
    // Auto-link card to lightbox items for hasWorkflow sync
    if (lightboxItems && lightboxIndex !== undefined) {
        card._lbRef = { items: lightboxItems, index: lightboxIndex };
    }
    if (onClick) {
        card.addEventListener('click', onClick);
    } else if (lightbox) {
        card.addEventListener('click', () => {
            const lbItems = lightboxItems || [{
                src: thumbEl.src || src,
                type: mediaType,
                filename,
            }];
            const idx = lightboxItems ? lightboxIndex : 0;
            if (window.ComfyDrawer?.openLightbox) {
                window.ComfyDrawer.openLightbox(lbItems, idx, lightboxOptions || {});
            }
        });
    }

    // ── Context menu ──
    if (onContextMenu) {
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            onContextMenu(e);
        });
    }

    // ── Custom Drag to ComfyUI Canvas ──
    if (draggable) {
        initCustomDrag(card, thumbEl, { src, filename, mediaType, onFolderDrop: opts.onFolderDrop });
    }

    // ── Async workflow metadata detection ──
    // Delegates to the platform's checkWorkflowAvailable API which uses
    // the provider-first strategy (meta:read Bus → /drawer/fs/meta).
    // Non-blocking: result stored on card._hasWorkflow for context menu.
    // Also syncs to lightbox items via card._lbRef if present.
    card._hasWorkflow = undefined; // unknown until check completes

    function updateHasWorkflow(val) {
        card._hasWorkflow = val;
        // Sync to linked lightbox item so lightbox context menu is consistent
        const ref = card._lbRef;
        if (ref && ref.items && ref.items[ref.index]) {
            ref.items[ref.index].hasWorkflow = val;
        }
    }

    function runWorkflowCheck(checkSrc) {
        const checkFn = window.ComfyDrawer?.checkWorkflowAvailable;
        if (!checkFn) return;
        card._hasWorkflow = undefined;
        checkFn({ src: checkSrc || thumbEl.src })
            .then(has => updateHasWorkflow(has))
            .catch(() => updateHasWorkflow(false));
    }

    if (src && filename) {
        runWorkflowCheck(src);
    }

    // ── Public API ──
    const mc = {
        element: card,
        thumb: thumbEl,
        info,
        /** Whether this media has embedded workflow data (async, may be undefined initially) */
        get hasWorkflow() { return card._hasWorkflow; },
        setSrc(newSrc) {
            if (lazy && _lazyObserver) _lazyObserver.unobserve(thumbEl);
            thumbEl.dataset.loaded = 'false';
            thumbEl.src = newSrc;
            // Re-check workflow availability for the new source
            runWorkflowCheck(newSrc);
        },
        destroy() {
            if (_lazyObserver) _lazyObserver.unobserve(thumbEl);
            card.remove();
        },
    };

    return mc;
}

/**
 * Create a MediaGrid container.
 * @param {object} [opts]
 * @param {number} [opts.minColumnWidth=140]
 * @param {number} [opts.gap=10]
 * @returns {MediaGrid}
 */
export function createMediaGrid(opts = {}) {
    const { minColumnWidth = 140, gap = 10 } = opts;
    const el = document.createElement('div');
    el.className = 'mc-grid';
    el.style.setProperty('--mc-col-min', `${minColumnWidth}px`);
    el.style.setProperty('--mc-gap', `${gap}px`);

    /** @type {Array<{destroy: Function}>} */
    const cards = [];

    return {
        element: el,
        add(card) {
            cards.push(card);
            el.appendChild(card.element);
        },
        clear() {
            for (const c of cards) c.destroy();
            cards.length = 0;
            el.innerHTML = '';
        },
    };
}
