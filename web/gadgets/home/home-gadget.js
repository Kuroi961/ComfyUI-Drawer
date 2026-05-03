/**
 * ComfyDrawer — Home Gadget
 * Dashboard for Drawer platform management: gadget overview,
 * quick actions, and system information.
 *
 * Platform services used:
 *   - bus for gadget registration events
 *   - bridge for system info
 *   - DrawerShell API via window.ComfyDrawer.shell
 */
import { GadgetBase } from '../../js/core/gadget-base.js';

/** @private Locale helper — falls back to fallback text when key is not translated */
const _t = (key, fallback, params) => {
    const result = window.ComfyDrawer?.t?.(key, params);
    return (result && result !== key) ? result : (fallback ?? key);
};

const HOME_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

const ARROW_DOWN_UP = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>`;

export class HomeGadget extends GadgetBase {
    #el = {};
    #changelogAbort = null;

    constructor() {
        super('home', {
            label: 'Home',
            icon: HOME_ICON,
            order: -10,   // Always leftmost
            cssUrl: new URL('./home.css', import.meta.url).href,
        });
    }

    /* ══════ Lifecycle ══════ */

    onMount(container, bus, _bridge) {
        this.#buildDOM();
        this.#renderGadgets();
        this.#renderSystemInfo();

        // Re-render gadget cards when gadgets are added/removed/visibility-changed
        const onGadgetChange = () => this.#renderGadgets();
        bus.on('drawer:gadget-registered', onGadgetChange);
        bus.on('drawer:gadget-unregistered', onGadgetChange);
        bus.on('drawer:gadget-visibility-changed', onGadgetChange);
        this.addDisposable(() => {
            bus.off('drawer:gadget-registered', onGadgetChange);
            bus.off('drawer:gadget-unregistered', onGadgetChange);
            bus.off('drawer:gadget-visibility-changed', onGadgetChange);
        });
        this.addDisposable(() => this.#changelogAbort?.abort());
    }

    onActivate() {
        // Refresh system info on tab switch (may have changed)
        this.#renderSystemInfo();
        this.#renderGadgets();
    }

    /* ══════ DOM ══════ */

    #buildDOM() {
        this.container.innerHTML = `
            <div class="hm-content">
                <div class="hm-header">
                    <div class="hm-product-prefix">ComfyUI</div>
                    <div class="hm-logo" role="img" aria-label="ComfyDrawer"></div>
                    <div class="hm-version"></div>
                </div>

                <div class="hm-section-title">${_t('home.gadgetsTabBar', 'Tab Bar')}</div>
                <div class="hm-gadget-zone hm-zone-visible" data-zone="visible"></div>

                <div class="hm-zone-divider">
                    <span class="hm-zone-divider-line"></span>
                    <span class="hm-zone-divider-label">☰ ${_t('home.gadgetsMenu', 'Menu')} ${ARROW_DOWN_UP}</span>
                    <span class="hm-zone-divider-line"></span>
                </div>
                <div class="hm-gadget-zone hm-zone-hidden" data-zone="hidden"></div>

                <div class="hm-section-title">System</div>
                <div class="hm-info-grid"></div>

                <div class="hm-section-title">${_t('home.links', 'Links')}</div>
                <div class="hm-links"></div>

                <div class="hm-section-title">${_t('home.changelog', 'Changelog')}</div>
                <div class="hm-changelog"></div>
            </div>
        `;

        const q = (s) => this.container.querySelector(s);
        this.#el = {
            version: q('.hm-version'),
            zoneVisible: q('.hm-zone-visible'),
            zoneHidden: q('.hm-zone-hidden'),
            infoGrid: q('.hm-info-grid'),
            links: q('.hm-links'),
            changelog: q('.hm-changelog'),
        };

        // Zone drop targets
        this.#setupZoneDrop(this.#el.zoneVisible, 'visible');
        this.#setupZoneDrop(this.#el.zoneHidden, 'hidden');

        this.#renderLinks();
        this.#renderChangelog();
    }

    /* ══════ Gadget Cards (Two-Zone D&D) ══════ */

    #renderGadgets() {
        const shell = window.ComfyDrawer?.shell;
        if (!shell) return;
        const { zoneVisible, zoneHidden } = this.#el;
        if (!zoneVisible || !zoneHidden) return;

        zoneVisible.innerHTML = '';
        zoneHidden.innerHTML = '';

        const gadgets = shell.getGadgets?.() || [];
        for (const g of gadgets) {
            if (g.id === 'home') continue;  // Home is always pinned

            const isHidden = shell.isGadgetHidden(g.id);
            const card = this.#createGadgetCard(g, shell);
            (isHidden ? zoneHidden : zoneVisible).appendChild(card);
        }

        // Show empty-state hint in hidden zone
        if (!zoneHidden.children.length) {
            const hint = document.createElement('div');
            hint.className = 'hm-zone-empty';
            hint.textContent = _t('home.dragHere', 'Drag gadgets here to hide from tab bar');
            zoneHidden.appendChild(hint);
        }
    }

    #createGadgetCard(g, shell) {
        const card = document.createElement('div');
        card.className = 'hm-gadget-card';
        card.draggable = true;
        card.dataset.gadgetId = g.id;
        card.title = g.label;
        card.innerHTML = `
            <div class="hm-gadget-icon">${g.icon || '📦'}</div>
            <div class="hm-gadget-name">${g.label}</div>
        `;

        // Click to open
        card.addEventListener('click', () => shell.open(g.id));

        // D&D start
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', g.id);
            card.classList.add('dragging');
            this.#el.zoneVisible.classList.add('hm-zone-active');
            this.#el.zoneHidden.classList.add('hm-zone-active');
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            this.#el.zoneVisible.classList.remove('hm-zone-active', 'hm-zone-over');
            this.#el.zoneHidden.classList.remove('hm-zone-active', 'hm-zone-over');
        });

        return card;
    }

    #setupZoneDrop(zone, zoneType) {
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            zone.classList.add('hm-zone-over');
        });
        zone.addEventListener('dragleave', (e) => {
            if (!zone.contains(e.relatedTarget)) {
                zone.classList.remove('hm-zone-over');
            }
        });
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('hm-zone-over');
            const gadgetId = e.dataTransfer.getData('text/plain');
            if (!gadgetId) return;
            const shell = window.ComfyDrawer?.shell;
            if (!shell) return;
            if (zoneType === 'hidden') {
                shell.hideGadget(gadgetId);
            } else {
                shell.showGadget(gadgetId);
            }
            this.#renderGadgets();
        });
    }

    /* ══════ System Info ══════ */

    async #renderSystemInfo() {
        const grid = this.#el.infoGrid;
        if (!grid) return;

        // Version
        const version = window.ComfyDrawer?.version || '—';
        this.#el.version.textContent = `v${version}`;

        // System stats
        let sysInfo = {};
        try {
            const resp = await fetch('/system_stats');
            if (resp.ok) sysInfo = await resp.json();
        } catch { /* ignore */ }

        const sys = sysInfo.system || {};
        const devices = sysInfo.devices || [];
        const gpu = devices[0] || {};

        const rows = [
            ['ComfyUI', sys.comfyui_version || '—'],
            ['Python', sys.python_version?.split(' ')[0] || '—'],
            ['PyTorch', sys.torch_version || '—'],
            ['Drawer', `v${version}`],
        ];

        if (gpu.name) {
            rows.push(['GPU', gpu.name]);
            if (gpu.vram_total) {
                const vramGB = (gpu.vram_total / 1024 / 1024 / 1024).toFixed(1);
                rows.push(['VRAM', `${vramGB} GB`]);
            }
        }

        grid.innerHTML = rows.map(([label, value]) => `
            <span class="hm-info-label">${label}</span>
            <span class="hm-info-value">${value}</span>
        `).join('');
    }

    /* ══════ Links ══════ */

    static LINKS = [
        { icon: '🐙', label: 'GitHub', url: 'https://github.com/Kuroi961/ComfyUI-Drawer' },
    ];

    #renderLinks() {
        const container = this.#el.links;
        if (!container) return;

        container.innerHTML = HomeGadget.LINKS.map(l => `
            <a class="hm-link-item" href="${l.url}" target="_blank" rel="noopener noreferrer">
                <span class="hm-link-label">${l.label}</span>
                <span class="hm-link-arrow">↗</span>
            </a>
        `).join('');
    }

    /* ══════ Changelog ══════ */

    async #renderChangelog() {
        const container = this.#el.changelog;
        if (!container) return;

        container.textContent = _t('common.loading', 'Loading...');
        this.#changelogAbort?.abort();
        this.#changelogAbort = new AbortController();

        try {
            const res = await fetch('/drawer/changelog', {
                cache: 'no-store',
                signal: this.#changelogAbort.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const entries = this.#parseChangelog(await res.text());
            if (!entries.length) throw new Error('No changelog entries');
            container.innerHTML = entries.map(entry => `
            <div class="hm-cl-entry">
                <div class="hm-cl-header">
                    <span class="hm-cl-version">${this.#escapeHTML(entry.version)}</span>
                    <span class="hm-cl-date">${this.#escapeHTML(entry.date)}</span>
                </div>
                <ul class="hm-cl-list">
                    ${entry.changes.map(c => `<li>${this.#escapeHTML(c)}</li>`).join('')}
                </ul>
            </div>
            `).join('');
        } catch (err) {
            if (err.name === 'AbortError') return;
            container.innerHTML = `<div class="hm-empty">${_t('home.changelogUnavailable', 'Changelog unavailable')}</div>`;
        }
    }

    #parseChangelog(markdown) {
        const entries = [];
        let current = null;
        for (const rawLine of markdown.split(/\r?\n/)) {
            const line = rawLine.trim();
            const heading = line.match(/^##\s+\[?(v?\d+\.\d+\.\d+[^\]\s]*)\]?\s*(?:[-–—]\s*)?(.+)?$/i);
            if (heading) {
                current = {
                    version: heading[1].startsWith('v') ? heading[1] : `v${heading[1]}`,
                    date: heading[2] || '',
                    changes: [],
                };
                entries.push(current);
                continue;
            }
            const bullet = line.match(/^[-*]\s+(.+)$/);
            if (bullet && current) current.changes.push(bullet[1]);
        }
        return entries.filter(entry => entry.changes.length);
    }

    #escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }
}
