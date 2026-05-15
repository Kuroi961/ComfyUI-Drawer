/**
 * ComfyDrawer — DialogService
 * A shared dialog/popup service for alerts, confirms, prompts,
 * and custom form dialogs.
 *
 * Design principles:
 * - Self-contained: injects its own CSS, builds its own DOM
 * - Service-locator friendly: exported functions use window.ComfyDrawer internally
 * - Promise-based: all calls return a Promise for await-ability
 * - Stackable: multiple dialogs can be opened (each gets its own backdrop)
 * - Escape/backdrop-click dismisses as cancel
 *
 * Usage (via public API — no import needed):
 *   const { showDialog, showAlert, showConfirm, showPrompt } = window.ComfyDrawer;
 *
 *   // Alert (OK only)
 *   await showAlert('処理が完了しました');
 *   await showAlert('エラー', { icon: '❌', title: 'エラー発生' });
 *
 *   // Confirm (OK / Cancel → boolean)
 *   const ok = await showConfirm('このファイルを削除しますか？');
 *   if (ok) { ... }
 *
 *   // Prompt (text input → string | null)
 *   const name = await showPrompt('新しい名前を入力:', { defaultValue: 'untitled' });
 *   if (name !== null) { ... }
 *
 *   // Custom dialog (full control → any value)
 *   const result = await showDialog({
 *       title: '辞書に登録',
 *       icon: '📖',
 *       content: (bodyEl) => {
 *           // Build custom form UI inside bodyEl
 *           // Return a function that extracts the form data
 *           return () => ({ word: input.value, dict: select.value });
 *       },
 *       confirmLabel: '登録',
 *       cancelLabel: 'キャンセル',
 *       onValidate: (data) => {
 *           if (!data.word) return '単語を入力してください';
 *           return null; // null = valid
 *       },
 *   });
 *   if (result !== null) { // result = { word, dict } }
 */

/* ═══════════════════════════════════════════════════════
   CSS Injection
   ═══════════════════════════════════════════════════════ */

let cssInjected = false;
function ensureCSS() {
    if (cssInjected) return;
    if (document.querySelector('link[href*="ComfyUI-Drawer"][href*="dialog.css"]')) {
        cssInjected = true;
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../css/dialog.css', import.meta.url).href;
    document.head.appendChild(link);
    cssInjected = true;
}

/* ═══════════════════════════════════════════════════════
   Core: showDialog
   ═══════════════════════════════════════════════════════ */

/** @type {Set<HTMLElement>} Active dialog backdrops (for stacking) */
const activeDialogs = new Set();
const DISMISS_DELAY_MS = 0;

/** Monotonic counter for aria-labelledby targets. */
let _dialogIdCounter = 0;

/** Selectors for focusable descendants used by the focus trap. */
const _FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
].join(',');

function _getFocusable(root) {
    if (!root) return [];
    const nodes = root.querySelectorAll(_FOCUSABLE_SELECTOR);
    // Filter out anything hidden via inline display:none or aria-hidden
    return Array.from(nodes).filter(el => {
        if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') return false;
        // offsetParent is null for display:none / visibility:hidden parents
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
        return true;
    });
}

const DIALOG_ICONS = {
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    danger: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    prompt: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
};

/**
 * Show a dialog and return a Promise that resolves with the result.
 *
 * @param {object} options
 * @param {string} [options.title]          - Dialog title
 * @param {string} [options.icon]           - Emoji/icon before title
 * @param {'info'|'warning'|'danger'|'prompt'} [options.variant] - Visual tone
 * @param {string} [options.message]        - Plain text message (for simple dialogs)
 * @param {function|HTMLElement} [options.content] - Custom content builder:
 *     - If function: called with (bodyEl) → should return a getData() function
 *     - If HTMLElement: appended to body directly
 * @param {string}   [options.confirmLabel]   - Confirm button text (default: 'OK')
 * @param {string}   [options.cancelLabel]    - Cancel button text (default: 'キャンセル')
 * @param {boolean}  [options.showCancel]     - Show cancel button (default: true)
 * @param {boolean}  [options.danger]         - Use danger style for confirm button
 * @param {function} [options.onValidate]     - (data) => errorMsg|null; called before confirm
 * @param {boolean}  [options.dismissOnBackdrop] - Close on backdrop click (default: true)
 * @param {boolean}  [options.dismissOnEscape]   - Close on Escape (default: true)
 * @param {boolean}  [options.showClose]         - Show header close button (default: true)
 * @param {function} [options.onOpen]            - Called with ({ close, backdrop, dialog, body })
 * @param {function} [options.onDismiss]         - Called immediately when dismissal starts
 *
 * @returns {Promise<*>} Resolves with:
 *   - Custom dialog: return value of getData(), or null if cancelled
 *   - Simple message: true if confirmed, null if cancelled
 */
export function showDialog(options = {}) {
    ensureCSS();

    return new Promise((resolve) => {
        const {
            title = '',
            icon = '',
            message = '',
            content = null,
            confirmLabel = 'OK',
            cancelLabel = (window.ComfyDrawer?.t?.('common.cancel')) || 'Cancel',
            showCancel = true,
            danger = false,
            variant = null,
            onValidate = null,
            dismissOnBackdrop = true,
            dismissOnEscape = true,
            showClose = true,
            autoFocus = true,
            onOpen = null,
            onDismiss = null,
        } = options;
        const requestedTone = variant || (danger ? 'danger' : 'info');
        const tone = ['info', 'warning', 'danger', 'prompt'].includes(requestedTone) ? requestedTone : 'info';
        const dialogIcon = icon || ((variant || danger) ? DIALOG_ICONS[tone] : '');

        // ── Build DOM ──
        const backdrop = document.createElement('div');
        backdrop.className = 'cd-dialog-backdrop';

        const dialog = document.createElement('div');
        dialog.className = `cd-dialog cd-dialog-${tone}`;
        // ARIA: announce as a modal dialog to assistive tech. The
        // aria-labelledby target points at the title element so screen
        // readers read the title on open. tabindex=-1 lets us programmatic-
        // ally focus the dialog itself as a fallback target.
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('tabindex', '-1');
        const titleId = `cd-dialog-title-${++_dialogIdCounter}`;
        dialog.setAttribute('aria-labelledby', titleId);

        // Header
        const header = document.createElement('div');
        header.className = 'cd-dialog-header';

        if (dialogIcon) {
            const iconEl = document.createElement('span');
            iconEl.className = 'cd-dialog-icon';
            iconEl.setAttribute('aria-hidden', 'true');
            if (dialogIcon.startsWith('<')) iconEl.innerHTML = dialogIcon;
            else iconEl.textContent = dialogIcon;
            header.appendChild(iconEl);
        }

        const titleEl = document.createElement('span');
        titleEl.className = 'cd-dialog-title';
        titleEl.id = titleId;
        titleEl.textContent = title || (dialogIcon ? '' : ' ');
        header.appendChild(titleEl);

        let closeBtn = null;
        if (showClose) {
            closeBtn = document.createElement('button');
            closeBtn.className = 'cd-dialog-close';
            closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', (window.ComfyDrawer?.t?.('common.close')) || 'Close');
            header.appendChild(closeBtn);
        }

        dialog.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'cd-dialog-body';

        // getData — function to extract result from body content
        let getData = () => true;

        if (message) {
            const msgEl = document.createElement('p');
            msgEl.className = 'cd-dialog-message';
            msgEl.textContent = message;
            body.appendChild(msgEl);
        }

        if (typeof content === 'function') {
            const result = content(body);
            if (typeof result === 'function') {
                getData = result;
            }
        } else if (content instanceof HTMLElement) {
            body.appendChild(content);
        }

        dialog.appendChild(body);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'cd-dialog-footer';
        let confirmBtn = null;

        if (showCancel) {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = confirmLabel
                ? 'cd-dialog-btn'
                : `cd-dialog-btn ${danger ? 'cd-dialog-btn-danger' : 'cd-dialog-btn-primary'}`;
            cancelBtn.type = 'button';
            cancelBtn.textContent = cancelLabel;
            cancelBtn.addEventListener('click', () => dismiss(null));
            footer.appendChild(cancelBtn);
        }

        if (confirmLabel) {
            confirmBtn = document.createElement('button');
            confirmBtn.className = `cd-dialog-btn ${danger ? 'cd-dialog-btn-danger' : 'cd-dialog-btn-primary'}`;
            confirmBtn.type = 'button';
            confirmBtn.textContent = confirmLabel;
            confirmBtn.addEventListener('click', () => {
                const data = getData();
                if (onValidate) {
                    const err = onValidate(data);
                    if (err) {
                        showValidationError(body, err);
                        return;
                    }
                }
                dismiss(data);
            });
            footer.appendChild(confirmBtn);
        }

        if (footer.childElementCount) dialog.appendChild(footer);
        backdrop.appendChild(dialog);

        // Remember which element had focus so we can restore it on dismiss.
        // Skip restore if the previous element is no longer in the DOM by
        // the time we close (e.g. the user navigated to a different gadget).
        const prevActiveElement = document.activeElement;

        document.body.appendChild(backdrop);
        activeDialogs.add(backdrop);

        // ── Block right-click except on text inputs ──
        backdrop.addEventListener('contextmenu', (e) => {
            if (!isEditableTarget(e.target)) e.preventDefault();
        });

        // ── Keyboard ──
        const abortCtrl = new AbortController();

        document.addEventListener('keydown', (e) => {
            // Only handle for the topmost dialog
            if (getTopmostDialog() !== backdrop) return;

            if (e.key === 'Escape' && dismissOnEscape) {
                e.stopPropagation();
                e.preventDefault();
                e._escapeClaimed = true;
                dismiss(null);
            } else if (e.key === 'Enter' && !e.shiftKey) {
                // Enter confirms — but NOT if focus is in an input/textarea/select
                // (those elements should handle Enter themselves)
                const active = document.activeElement;
                if (!confirmBtn || isEditableTarget(active)) return;
                e.stopPropagation();
                e.preventDefault();
                confirmBtn.click();
            } else if (e.key === 'Tab') {
                // Focus trap: keep Tab/Shift+Tab inside the dialog so users
                // cannot tab into the underlying drawer or ComfyUI canvas,
                // which would silently bypass the modal contract.
                const focusable = _getFocusable(dialog);
                if (focusable.length === 0) {
                    e.preventDefault();
                    dialog.focus();
                    return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                const active = document.activeElement;
                if (e.shiftKey) {
                    if (active === first || !dialog.contains(active)) {
                        e.preventDefault();
                        last.focus();
                    }
                } else if (active === last || !dialog.contains(active)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }, { signal: abortCtrl.signal, capture: true });

        // ── Backdrop click ──
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop && dismissOnBackdrop) {
                dismiss(null);
            }
        });

        // ── Close button ──
        closeBtn?.addEventListener('click', () => dismiss(null));

        if (typeof onOpen === 'function') {
            onOpen({
                close: (value = null) => dismiss(value),
                backdrop,
                dialog,
                body,
            });
        }

        // ── Animate in ──
        requestAnimationFrame(() => {
            backdrop.classList.add('visible');
            // Auto-focus first input (unless autoFocus is false — e.g. settings panel on mobile)
            const focusTarget = autoFocus
                ? (body.querySelector('input, textarea, select') || confirmBtn || closeBtn || dialog)
                : (confirmBtn || closeBtn || dialog);
            focusTarget?.focus?.({ preventScroll: true });
            if (focusTarget?.matches?.('[data-autoselect]')) {
                focusTarget.select?.();
            }
        });

        // ── History API — back button closes dialog, not drawer ──
        // We push a synthetic history entry so the back gesture closes the
        // dialog instead of navigating away. On programmatic dismiss we
        // intentionally leave the entry stale (we do NOT call
        // history.back()) — DrawerShell uses the same pattern for the
        // same reason: calling history.back() here triggers the drawer's
        // own popstate handler and cascades into closing the drawer
        // itself. The stale entry is harmless and prevents that.
        // See drawer-shell.js `#popHistory` for the matching note.
        history.pushState({ comfyDrawerDialog: true }, '');

        const onPopState = () => {
            window.removeEventListener('popstate', onPopState);
            dismiss(null, /* fromPopState */ true);
        };
        window.addEventListener('popstate', onPopState, { signal: abortCtrl.signal });

        // Also intercept drawer's back-button bus event
        const bus = window.ComfyDrawer?.bus;
        const onBackButton = () => {
            // Dialog is open → suppress drawer close + dismiss dialog
            bus?.emit('drawer:back-handled');
            dismiss(null);
        };
        if (bus) {
            bus.on('drawer:back-button', onBackButton);
        }

        // ── Dismiss ──
        let dismissed = false;
        function dismiss(value, fromPopState = false) {
            if (dismissed) return;
            dismissed = true;
            if (typeof onDismiss === 'function') {
                onDismiss(value);
            }
            abortCtrl.abort();
            backdrop.classList.remove('visible');
            activeDialogs.delete(backdrop);

            // Clean up bus listener
            if (bus) bus.off('drawer:back-button', onBackButton);

            // Clean up history entry (only if not triggered by popstate).
            // We leave the synthetic entry stale on purpose — calling
            // history.back() here triggers DrawerShell's popstate handler
            // which would cascade-close the drawer (regression observed
            // when this was attempted). See the matching comment on
            // pushState above.
            if (!fromPopState) {
                window.removeEventListener('popstate', onPopState);
            }

            // Restore focus to whatever owned it before the dialog opened.
            // This is the standard a11y contract for modal dialogs and also
            // prevents the canvas from silently capturing the next keystroke.
            // Skip if the element was removed in the meantime or belongs to
            // a topmost dialog that is still open (stacked dialog flow).
            if (
                prevActiveElement
                && typeof prevActiveElement.focus === 'function'
                && prevActiveElement.isConnected
            ) {
                try { prevActiveElement.focus({ preventScroll: true }); } catch { /* ignore */ }
            }

            setTimeout(() => {
                backdrop.remove();
                resolve(value);
            }, DISMISS_DELAY_MS);
        }
    });
}

/* ═══════════════════════════════════════════════════════
   Convenience: showAlert
   ═══════════════════════════════════════════════════════ */

/**
 * Show an alert dialog (OK button only).
 * @param {string} message - Message to display
 * @param {object} [options] - Optional overrides (title, icon)
 * @returns {Promise<void>}
 */
export function showAlert(message, options = {}) {
    return showDialog({
        title: options.title || '',
        icon: options.icon || '',
        variant: options.variant || 'info',
        message,
        showCancel: false,
        confirmLabel: options.confirmLabel || 'OK',
    });
}

/* ═══════════════════════════════════════════════════════
   Convenience: showConfirm
   ═══════════════════════════════════════════════════════ */

/**
 * Show a confirmation dialog (OK / Cancel).
 * @param {string} message - Message to display
 * @param {object} [options] - Optional overrides (title, icon, danger, confirmLabel, cancelLabel)
 * @returns {Promise<boolean>} true if confirmed, false if cancelled
 */
export function showConfirm(message, options = {}) {
    return showDialog({
        title: options.title || '',
        icon: options.icon || '',
        variant: options.variant || (options.danger ? 'danger' : 'warning'),
        message,
        showCancel: true,
        danger: options.danger || false,
        confirmLabel: options.confirmLabel || 'OK',
        cancelLabel: options.cancelLabel || (window.ComfyDrawer?.t?.('common.cancel')) || 'Cancel',
    }).then(result => result !== null);
}

/* ═══════════════════════════════════════════════════════
   Convenience: showPrompt
   ═══════════════════════════════════════════════════════ */

/**
 * Show a prompt dialog with a text input.
 * @param {string} message - Message/label above the input
 * @param {object} [options] - Optional overrides
 * @param {string} [options.defaultValue] - Initial value
 * @param {string} [options.placeholder] - Placeholder text
 * @param {boolean} [options.multiline] - Use textarea instead of input
 * @param {string} [options.title] - Dialog title
 * @param {string} [options.icon] - Dialog icon
 * @returns {Promise<string|null>} Input value, or null if cancelled
 */
export function showPrompt(message, options = {}) {
    return showDialog({
        title: options.title || '',
        icon: options.icon || '',
        variant: options.variant || 'prompt',
        message,
        confirmLabel: options.confirmLabel || 'OK',
        cancelLabel: options.cancelLabel || (window.ComfyDrawer?.t?.('common.cancel')) || 'Cancel',
        content: (bodyEl) => {
            const input = document.createElement(options.multiline ? 'textarea' : 'input');
            input.className = 'cd-dialog-input';
            if (!options.multiline) input.type = 'text';
            if (options.defaultValue != null) input.value = options.defaultValue;
            if (options.placeholder) input.placeholder = options.placeholder;
            bodyEl.appendChild(input);

            // Enter in single-line input → submit the dialog
            if (!options.multiline) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        // Find and click the confirm button
                        const confirmBtn = bodyEl.closest('.cd-dialog')?.querySelector('.cd-dialog-btn-primary');
                        if (confirmBtn) confirmBtn.click();
                    }
                });
            }

            return () => input.value;
        },
        onValidate: options.onValidate || null,
    });
}

/* ═══════════════════════════════════════════════════════
   Internal Helpers
   ═══════════════════════════════════════════════════════ */

/**
 * Get the topmost (most recently opened) dialog backdrop.
 * @returns {HTMLElement|null}
 */
function getTopmostDialog() {
    let last = null;
    for (const d of activeDialogs) last = d;
    return last;
}

function isEditableTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    const el = /** @type {HTMLElement} */ (target);
    return !!el.closest('input, textarea, select, [contenteditable="true"]');
}

/**
 * Show a validation error message inside the dialog body.
 * @param {HTMLElement} bodyEl
 * @param {string} message
 */
function showValidationError(bodyEl, message) {
    // Remove existing error
    const existing = bodyEl.querySelector('.cd-dialog-validation-error');
    if (existing) existing.remove();

    const err = document.createElement('div');
    err.className = 'cd-dialog-validation-error';
    err.style.cssText = `
        margin-top: 8px;
        padding: 6px 10px;
        border-radius: 6px;
        background: var(--cd-danger-subtle);
        border: 1px solid var(--cd-danger-low);
        color: var(--cd-danger);
        font-size: 12px;
    `;
    err.textContent = message;
    bodyEl.appendChild(err);

    // Auto-remove after 3s
    setTimeout(() => err.remove(), 3000);
}
