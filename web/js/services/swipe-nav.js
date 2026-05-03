/**
 * ComfyDrawer — Swipe Navigation Service
 * Horizontal swipe gesture handler for navigating between sibling items.
 *
 * Usage:
 *   import { attachSwipeNav } from '../../js/services/swipe-nav.js';
 *
 *   const detach = attachSwipeNav(contentElement, {
 *       onSwipeLeft:  () => navigateToNext(),    // → next sibling
 *       onSwipeRight: () => navigateToPrev(),    // ← prev sibling
 *       threshold: 60,      // px minimum swipe distance (default: 60)
 *       velocityMin: 0.3,   // px/ms minimum velocity (default: 0.3)
 *   });
 *
 *   // Later:
 *   detach();  // remove all listeners
 */

/**
 * Attach horizontal swipe navigation to an element.
 * Calls onSwipeLeft when swiping left (→ next), onSwipeRight when swiping right (← prev).
 *
 * @param {HTMLElement} el - The element to listen for swipe gestures on
 * @param {object} opts
 * @param {function} [opts.onSwipeLeft]  - Called when user swipes left (finger moves left)
 * @param {function} [opts.onSwipeRight] - Called when user swipes right (finger moves right)
 * @param {number}   [opts.threshold]    - Minimum distance in px (default: 60)
 * @param {number}   [opts.velocityMin]  - Minimum velocity in px/ms (default: 0.3)
 * @param {number}   [opts.verticalMax]  - Max vertical movement allowed in px (default: 80)
 * @returns {function} detach — call to remove all listeners
 */
export function attachSwipeNav(el, opts = {}) {
    const {
        onSwipeLeft = null,
        onSwipeRight = null,
        threshold = 60,
        velocityMin = 0.3,
        verticalMax = 80,
    } = opts;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;

    function onTouchStart(e) {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        startTime = Date.now();
        tracking = true;
    }

    function onTouchEnd(e) {
        if (!tracking) return;
        tracking = false;

        if (e.changedTouches.length !== 1) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        const dt = Date.now() - startTime;

        // Must be predominantly horizontal
        if (Math.abs(dy) > verticalMax) return;
        if (Math.abs(dy) > Math.abs(dx) * 0.7) return;

        const dist = Math.abs(dx);
        const velocity = dt > 0 ? dist / dt : 0;

        if (dist < threshold && velocity < velocityMin) return;

        if (dx < 0 && onSwipeLeft) {
            onSwipeLeft();
        } else if (dx > 0 && onSwipeRight) {
            onSwipeRight();
        }
    }

    function onTouchMove(e) {
        if (!tracking) return;
        // Allow cancellation if it becomes vertical
        const t = e.touches[0];
        const dy = Math.abs(t.clientY - startY);
        const dx = Math.abs(t.clientX - startX);
        if (dy > verticalMax || (dy > 20 && dy > dx)) {
            tracking = false;
        }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    // Return detach function
    return () => {
        el.removeEventListener('touchstart', onTouchStart);
        el.removeEventListener('touchmove', onTouchMove);
        el.removeEventListener('touchend', onTouchEnd);
    };
}
