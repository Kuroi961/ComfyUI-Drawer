/**
 * ComfyDrawer — ImagePicker Service
 * A thumbnail-based popup file picker for selecting images.
 *
 * Design principles (matching DialogService):
 * - Self-contained: injects its own CSS, builds its own DOM
 * - Service-locator friendly: no import needed
 * - Promise-based: returns selected value or null (cancel)
 * - Escape / backdrop-click dismisses as cancel
 *
 * Usage:
 *   const value = await window.ComfyDrawer.openImagePicker({
 *     root: 'input',
 *     currentValue: 'subfolder/photo.png',
 *     onSelect: (value) => { widget.value = value; }
 *   });
 */
import { apiFetch, apiURL } from '../core/api-utils.js';
import { escapeHTML } from '../utils.js';

/* ═══════════════════════════════════════════════════════
   CSS Injection
   ═══════════════════════════════════════════════════════ */

let cssInjected = false;
function ensureCSS() {
    if (cssInjected) return;
    if (document.querySelector('link[href*="ComfyUI-Drawer"][href*="image-picker.css"]')) {
        cssInjected = true;
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../css/image-picker.css', import.meta.url).href;
    document.head.appendChild(link);
    cssInjected = true;
}

/* ═══════════════════════════════════════════════════════
   Image URL helper
   ═══════════════════════════════════════════════════════ */

function makeThumbUrl(root, subfolder, filename) {
    return apiURL(`/drawer/fs/thumb?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(subfolder)}&filename=${encodeURIComponent(filename)}&size=200`);
}

/* ═══════════════════════════════════════════════════════
   openImagePicker
   ═══════════════════════════════════════════════════════ */

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const AUDIO_EXTS = ['flac', 'mp3', 'opus', 'wav', 'ogg'];
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_MUSIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/**
 * Open a thumbnail picker popup.
 *
 * @param {object} opts
 * @param {string} [opts.root='input']    - FS root ('input', 'output', 'temp')
 * @param {string} [opts.subfolder='']    - Initial subfolder
 * @param {string} [opts.currentValue=''] - Current selection (subfolder/filename)
 * @param {string} [opts.accept='image'] - File type filter: 'image', 'video', 'audio', 'all'
 * @param {function} [opts.onSelect]      - Callback: (value: string) => void
 * @returns {Promise<string|null>}        - Selected value or null if cancelled
 */
export function openImagePicker(opts = {}) {
    ensureCSS();

    const root = opts.root || 'input';
    const currentValue = opts.currentValue || '';
    const onSelect = opts.onSelect || null;
    const accept = opts.accept || 'image';

    // Parse currentValue to determine initial subfolder
    let initSubfolder = opts.subfolder || '';
    if (!initSubfolder && currentValue.includes('/')) {
        const parts = currentValue.split('/');
        parts.pop(); // remove filename
        initSubfolder = parts.join('/');
    }

    return new Promise((resolve) => {
        let currentPath = initSubfolder;
        let closed = false;

        // ── Build DOM ──

        // Capture focus owner for restore on close.
        const prevActiveElement = document.activeElement;

        const backdrop = document.createElement('div');
        backdrop.className = 'cd-picker-backdrop';

        const panel = document.createElement('div');
        panel.className = 'cd-picker';
        // ARIA: announce as modal dialog labelled by the title element.
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('tabindex', '-1');
        const titleElId = `cd-picker-title-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
        panel.setAttribute('aria-labelledby', titleElId);

        // Header
        const header = document.createElement('div');
        header.className = 'cd-picker-header';
        const titleEl = document.createElement('span');
        titleEl.className = 'cd-picker-title';
        titleEl.id = titleElId;
        const _t = (k, p) => (window.ComfyDrawer?.t?.(k, p)) ?? k;
        titleEl.textContent = accept === 'video' ? _t('picker.selectVideo')
                            : accept === 'audio' ? _t('picker.selectAudio')
                            : accept === 'all' ? _t('picker.selectFile')
                            : _t('picker.selectImage');
        const closeBtn = document.createElement('button');
        closeBtn.className = 'cd-picker-close';
        closeBtn.setAttribute('aria-label', _t('common.close') || 'Close');
        closeBtn.innerHTML = ICON_X;
        closeBtn.addEventListener('click', () => close(null));
        header.append(titleEl, closeBtn);

        // Breadcrumb
        const crumbBar = document.createElement('div');
        crumbBar.className = 'cd-picker-crumbs';

        // Body
        const body = document.createElement('div');
        body.className = 'cd-picker-body';

        panel.append(header, crumbBar, body);
        backdrop.appendChild(panel);

        // ── Close handler ──

        function close(value) {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.classList.remove('visible');
            setTimeout(() => backdrop.remove(), 200);
            // Restore focus to the element that opened the picker.
            if (
                prevActiveElement
                && typeof prevActiveElement.focus === 'function'
                && prevActiveElement.isConnected
            ) {
                try { prevActiveElement.focus({ preventScroll: true }); } catch { /* ignore */ }
            }
            if (value !== null && onSelect) {
                onSelect(value);
            }
            resolve(value);
        }

        // Backdrop click
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) close(null);
        });

        // Suppress browser context menu inside picker, but per CONVENTIONS
        // never block it on editable controls — users still need Paste etc.
        backdrop.addEventListener('contextmenu', (e) => {
            if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
            e.preventDefault();
        });

        // Escape closes; Tab is trapped inside the picker so focus cannot
        // leak into the canvas/drawer behind the modal.
        function onKey(e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(null);
                return;
            }
            if (e.key !== 'Tab') return;
            const focusable = Array.from(panel.querySelectorAll(
                'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )).filter(node => node.offsetParent !== null);
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (e.shiftKey) {
                if (active === first || !panel.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else if (active === last || !panel.contains(active)) {
                e.preventDefault();
                first.focus();
            }
        }
        document.addEventListener('keydown', onKey, true);

        // ── Breadcrumb rendering ──

        function renderCrumbs(crumbs) {
            crumbBar.innerHTML = '';
            crumbs.forEach((c, i) => {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'cd-picker-crumb-sep';
                    sep.textContent = '›';
                    crumbBar.appendChild(sep);
                }
                const el = document.createElement('span');
                el.className = 'cd-picker-crumb';
                el.textContent = c.name;
                if (i < crumbs.length - 1) {
                    el.addEventListener('click', () => navigate(c.path));
                }
                crumbBar.appendChild(el);
            });
        }

        // ── Navigate to a subfolder ──

        async function navigate(path) {
            currentPath = path;
            body.innerHTML = '';
            const status = document.createElement('div');
            status.className = 'cd-picker-status';
            status.textContent = _t('common.loading');
            body.appendChild(status);

            try {
                const r = await apiFetch(
                    `/drawer/fs/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
                );
                if (!r.ok) throw new Error('Failed to browse');
                const data = await r.json();

                renderCrumbs(data.breadcrumb || []);

                body.innerHTML = '';

                if (data.folders.length === 0 && data.files.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'cd-picker-status';
                    empty.textContent = _t('common.noFiles');
                    body.appendChild(empty);
                    return;
                }

                const grid = document.createElement('div');
                grid.className = 'cd-picker-grid';

                // Folders
                for (const folder of data.folders) {
                    const el = document.createElement('div');
                    el.className = 'cd-picker-folder';
                    el.innerHTML = `
                        <span class="cd-picker-folder-icon">${ICON_FOLDER}</span>
                        <span class="cd-picker-folder-name">${escapeHTML(folder.name)}</span>
                    `;
                    el.addEventListener('click', () => navigate(folder.path));
                    grid.appendChild(el);
                }

                // Filter files by accept type
                const filteredFiles = data.files.filter(f => {
                    const ext = f.name.split('.').pop().toLowerCase();
                    if (accept === 'video') return VIDEO_EXTS.includes(ext);
                    if (accept === 'audio') return AUDIO_EXTS.includes(ext);
                    if (accept === 'image') return IMAGE_EXTS.includes(ext);
                    return IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext);
                });

                for (const file of filteredFiles) {
                    const value = file.subfolder ? `${file.subfolder}/${file.name}` : file.name;
                    const ext = file.name.split('.').pop().toLowerCase();
                    const isVideo = VIDEO_EXTS.includes(ext);
                    const isAudio = AUDIO_EXTS.includes(ext);

                    const el = document.createElement('div');
                    el.className = 'cd-picker-file';
                    if (value === currentValue) {
                        el.classList.add('selected');
                    }

                    if (isAudio) {
                        // Audio: waveform icon + mini player
                        const viewUrl = apiURL(`/drawer/fs/view?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(file.subfolder || '')}&filename=${encodeURIComponent(file.name)}`);
                        const wrapper = document.createElement('div');
                        wrapper.className = 'cd-picker-audio-icon';
                        wrapper.innerHTML = ICON_MUSIC;
                        const audio = document.createElement('audio');
                        audio.src = viewUrl;
                        audio.preload = 'metadata';
                        audio.controls = true;
                        audio.addEventListener('click', (e) => e.stopPropagation());
                        wrapper.appendChild(audio);
                        el.appendChild(wrapper);
                    } else if (isVideo) {
                        // Video: use <video> element for poster frame
                        const viewUrl = apiURL(`/drawer/fs/view?root=${encodeURIComponent(root)}&subfolder=${encodeURIComponent(file.subfolder || '')}&filename=${encodeURIComponent(file.name)}`);
                        const vid = document.createElement('video');
                        vid.src = viewUrl;
                        vid.muted = true;
                        vid.preload = 'metadata';
                        vid.addEventListener('loadeddata', () => { vid.currentTime = 0.1; });
                        el.appendChild(vid);
                    } else {
                        // Image: use thumbnail
                        const thumbUrl = makeThumbUrl(root, file.subfolder || '', file.name);
                        const img = document.createElement('img');
                        img.loading = 'lazy';
                        img.src = thumbUrl;
                        img.alt = file.name;
                        el.appendChild(img);
                    }

                    const nameEl = document.createElement('div');
                    nameEl.className = 'cd-picker-file-name';
                    nameEl.textContent = file.name;
                    el.appendChild(nameEl);

                    el.addEventListener('click', () => close(value));

                    grid.appendChild(el);
                }

                body.appendChild(grid);

                // Scroll selected into view
                const selectedEl = grid.querySelector('.cd-picker-file.selected');
                if (selectedEl) {
                    requestAnimationFrame(() => {
                        selectedEl.scrollIntoView({ block: 'center', behavior: 'instant' });
                    });
                }

            } catch (err) {
                body.innerHTML = '';
                const errEl = document.createElement('div');
                errEl.className = 'cd-picker-status';
                errEl.textContent = _t('picker.errorPrefix', { message: err.message });
                body.appendChild(errEl);
            }
        }

        // ── Mount & animate ──

        document.body.appendChild(backdrop);
        requestAnimationFrame(() => {
            backdrop.classList.add('visible');
        });

        // Start navigation
        navigate(initSubfolder);
    });
}

// escapeHTML is imported from ../utils.js — the previous local copy
// produced different output (no quote escaping) and risked drifting
// from the shared implementation.
