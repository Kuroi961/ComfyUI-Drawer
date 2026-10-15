/**
 * ComfyDrawer — tab bar popover placement
 *
 * Menus opened from the tab bar (☰, workflow, queue) sit above the whole
 * tab bar — so the progress strip stays visible — right-aligned to the
 * element they were opened from, and shifted left or right as needed to
 * stay inside the viewport.
 */
const MARGIN = 4;

/**
 * Append `menu` to `root` and place it above `anchor`.
 * @param {HTMLElement} menu - absolutely positioned popover
 * @param {HTMLElement} anchor - element it was opened from
 * @param {HTMLElement} root - the drawer root the menu is appended to
 */
export function placeAboveTabBar(menu, anchor, root) {
    const rect = anchor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const top = anchor.closest('.comfy-drawer-tabs')?.getBoundingClientRect().top ?? rect.top;
    menu.style.position = 'absolute';
    menu.style.bottom = `${rootRect.bottom - Math.min(top, rect.top) + MARGIN}px`;
    menu.style.maxWidth = `${Math.max(0, window.innerWidth - MARGIN * 2)}px`;
    root.appendChild(menu);
    const width = menu.offsetWidth;
    const viewportRight = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
    // Right edge under the anchor's right edge, clamped to the viewport.
    let right = Math.min(rect.right, viewportRight - MARGIN);
    right = Math.max(right, MARGIN + width);
    menu.style.right = `${Math.max(MARGIN, rootRect.right - right)}px`;
}
