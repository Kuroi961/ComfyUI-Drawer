/**
 * Shared toast notifier — single bottom-center stack used by every gadget.
 *
 * Each gadget used to define its own private #showToast that built a
 * <div> with inline styles, appended to document.body, and self-removed
 * via setTimeout. That had three problems: (1) the styles drifted across
 * gadgets, (2) toasts could outlive the gadget that spawned them and
 * leak DOM, and (3) rapid-fire toasts stacked at the same fixed position
 * and overlapped illegibly.
 *
 * The platform `showToast` resolves all three. It uses theme tokens
 * (so dark/light theme follow automatically), stacks new toasts above
 * older ones, and tracks every timer so a future "close all" is trivial.
 *
 * Usage (third-party gadgets — via public API):
 *   window.ComfyDrawer.showToast(message);
 *   window.ComfyDrawer.showToast('Saved', { duration: 2000, variant: 'info' });
 *
 * Usage (built-in gadgets — via ES import):
 *   import { showToast } from '../../js/services/toast.js';
 */

const CONTAINER_ID = 'cd-toast-container';
const STYLE_ID = 'cd-toast-style';
const DEFAULT_DURATION_MS = 2500;
const FADE_OUT_MS = 300;
const VARIANTS = new Set(['info', 'success', 'warning', 'danger']);

let _container = null;
const _liveTimers = new Set();

function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // The existing .cd-toast rule in dialog.css is `position: fixed` so a
    // single toast can sit at bottom-center on its own. When we stack
    // toasts inside the platform container we need to override that to
    // static so flex layout works. Everything else (theme tokens, font,
    // border) inherits from dialog.css.
    style.textContent = `
#${CONTAINER_ID} {
    position: fixed;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    z-index: 230000;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    pointer-events: none;
    max-width: min(90vw, 480px);
}
#${CONTAINER_ID} > .cd-toast {
    position: static;
    transform: translateY(8px);
    text-align: center;
    word-break: break-word;
    margin: 0;
    pointer-events: auto;
}
#${CONTAINER_ID} > .cd-toast.cd-toast-visible {
    opacity: 1;
    transform: translateY(0);
}
#${CONTAINER_ID} > .cd-toast-success { border-color: var(--cd-accent); }
#${CONTAINER_ID} > .cd-toast-warning { border-color: var(--cd-accent); }
#${CONTAINER_ID} > .cd-toast-danger  { border-color: var(--cd-danger); }
`;
    document.head.appendChild(style);
}

function _ensureContainer() {
    if (_container && _container.isConnected) return _container;
    _ensureStyle();
    _container = document.getElementById(CONTAINER_ID);
    if (!_container) {
        _container = document.createElement('div');
        _container.id = CONTAINER_ID;
        // role=region + aria-live=polite lets screen readers announce
        // toasts without yanking focus away from the user's current task.
        _container.setAttribute('role', 'region');
        _container.setAttribute('aria-live', 'polite');
        _container.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(_container);
    }
    return _container;
}

/**
 * Show a transient toast at the bottom of the viewport.
 * @param {string} message - Plain text to display (will be escaped).
 * @param {object} [options]
 * @param {number} [options.duration=2500] - Visible duration in ms.
 * @param {'info'|'success'|'warning'|'danger'} [options.variant='info']
 */
export function showToast(message, options = {}) {
    if (!message && message !== 0) return;
    const text = String(message);
    const duration = Number(options.duration) > 0
        ? Math.min(Number(options.duration), 30000)
        : DEFAULT_DURATION_MS;
    const variant = VARIANTS.has(options.variant) ? options.variant : 'info';

    const container = _ensureContainer();
    const el = document.createElement('div');
    el.className = `cd-toast cd-toast-${variant}`;
    el.textContent = text;
    container.appendChild(el);

    // Defer the visible class so the CSS transition runs.
    requestAnimationFrame(() => {
        el.classList.add('cd-toast-visible');
    });

    const fadeTimer = setTimeout(() => {
        _liveTimers.delete(fadeTimer);
        el.classList.remove('cd-toast-visible');
        const removeTimer = setTimeout(() => {
            _liveTimers.delete(removeTimer);
            el.remove();
            // Tidy up the container if it's been empty for a while.
            if (container.childElementCount === 0 && container.parentNode) {
                container.remove();
                if (_container === container) _container = null;
            }
        }, FADE_OUT_MS);
        _liveTimers.add(removeTimer);
    }, duration);
    _liveTimers.add(fadeTimer);
}

/** For tests and emergency teardown. */
export function _resetToastStateForTests() {
    for (const id of _liveTimers) clearTimeout(id);
    _liveTimers.clear();
    if (_container) {
        _container.remove();
        _container = null;
    }
}
