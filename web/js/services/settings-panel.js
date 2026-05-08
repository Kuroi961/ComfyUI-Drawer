/**
 * ComfyDrawer — Settings Panel
 * Renders a settings dialog using the Dialog Service.
 * Settings are self-describing: each registered setting has metadata
 * (type, label, section) that drives the UI automatically.
 *
 * This module provides:
 *   1. openSettingsPanel()  — Show the settings dialog
 *   2. injectSettingsButton(tabBar) — Add ⚙️ button to the drawer tab bar
 *
 * Supported setting types:
 *   - toggle: on/off switch
 *   - select: dropdown menu
 *   - slider: range slider with value display
 *   - text: text input
 *   - color: color picker (live preview via CSS variables)
 *   - preset-theme: visual swatch grid for named theme presets
 *   - action: one-shot button
 */

import { apiFetch } from '../core/api-utils.js';
import { showConfirm, showDialog } from './dialog.js';

/** @private Locale helper — falls back to key if ComfyDrawer not ready */
const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;
const MAX_DICT_IMPORT_BYTES = 5 * 1024 * 1024;

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

async function readErrorMessage(resp, fallbackKey = 'common.errorOccurred') {
    try {
        const data = await resp.clone().json();
        if (data?.error) return String(data.error);
        if (data?.message) return String(data.message);
    } catch (_) {
        // Fall through to text/fallback.
    }
    try {
        const text = await resp.text();
        if (text) return text;
    } catch (_) {
        // Fall through to fallback.
    }
    return _t(fallbackKey);
}

/**
 * Open the settings panel as a dialog.
 * Reads setting definitions from the SettingsService and renders them.
 */
export function openSettingsPanel() {
    const settings = window.ComfyDrawer?.settings;
    if (!settings) {
        console.warn('[SettingsPanel] SettingsService not available');
        return;
    }

    const sections = settings.getDefinitions();

    // If no settings are defined yet, show an info message
    if (sections.size === 0) {
        showDialog({
            title: _t('settings.title'),
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
            message: _t('settings.noSettings'),
            showCancel: false,
            confirmLabel: _t('common.close'),
        });
        return;
    }

    showDialog({
        title: _t('settings.title'),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        showCancel: false,
        confirmLabel: _t('common.close'),
        autoFocus: false,
        content: (bodyEl) => {
            bodyEl.style.minWidth = '300px';

            // Collect dict toggle items to merge into the dict editor section.
            // Detect by item key pattern (locale-independent: 'dict.*.enabled').
            let dictToggles = [];

            for (const [sectionName, items] of sections) {
                // Detect the dict-toggle section by key pattern regardless of locale
                if (items.every(item => /^dict\..+\.enabled$/.test(item.key))) {
                    dictToggles = items;
                    continue;
                }
                // Skip 'General' — empty fallback section for unscoped settings
                if (sectionName === 'General') continue;

                // Section header
                const sectionHeader = document.createElement('div');
                sectionHeader.className = 'cd-settings-section';
                sectionHeader.textContent = sectionName;
                bodyEl.appendChild(sectionHeader);

                // Settings in this section
                for (const def of items) {
                    if (def.hidden) continue;
                    const row = createSettingRow(def, settings);
                    bodyEl.appendChild(row);
                }
            }

            // ── Dictionary section (Danbooru toggle + user dict list) ──
            renderDictSection(bodyEl, {
                type: 'dict',
                sectionTitle: _t('dict.dictionaries'),
                extraItems: { items: dictToggles, settings },
                createLabel: _t('dict.createDict'),
                createTitle: _t('dict.newDict'),
                importAccept: '.csv',
                importLabel: _t('dict.importCsv'),
                importIcon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
            });

            // ── Wildcard Editor ──
            renderDictSection(bodyEl, {
                type: 'wildcard',
                sectionTitle: _t('dict.wildcard'),
                createLabel: _t('dict.createWildcard'),
                createTitle: _t('dict.newWildcard'),
                importAccept: '.txt',
                importLabel: _t('dict.importTxt'),
                importIcon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
            });

            // No form data to return (settings apply immediately)
            return () => true;
        },
    });
}

/**
 * Create a single setting row based on the definition type.
 * @param {object} def - Setting definition
 * @param {import('./settings.js').SettingsService} settings
 * @returns {HTMLElement}
 */
function createSettingRow(def, settings) {
    const row = document.createElement('div');
    row.className = 'cd-settings-row';

    switch (def.type) {
        case 'toggle':
            return createToggle(row, def, settings);
        case 'select':
            return createSelect(row, def, settings);
        case 'slider':
            return createSlider(row, def, settings);
        case 'text':
            return createText(row, def, settings);
        case 'color':
            return createColorPicker(row, def, settings);
        case 'color-palette':
            return createColorPalette(row, def, settings);
        case 'preset-theme':
            return createPresetTheme(row, def, settings);
        case 'action':
            return createAction(row, def, settings);
        default:
            row.textContent = `Unknown type: ${def.type}`;
            return row;
    }
}

/* ═══════════════════════════════════════════════════════
   Toggle (on/off switch)
   ═══════════════════════════════════════════════════════ */

function createToggle(row, def, settings) {
    const currentValue = settings.get(def.key, def.defaultValue ?? false);

    row.innerHTML = `
        <div class="cd-settings-label-group">
            <span class="cd-settings-label">${escapeText(def.label)}</span>
            ${def.description ? `<span class="cd-settings-desc">${escapeText(def.description)}</span>` : ''}
        </div>
    `;

    const toggle = document.createElement('button');
    toggle.className = 'cd-settings-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(currentValue));

    const track = document.createElement('span');
    track.className = 'cd-settings-toggle-track';
    const thumb = document.createElement('span');
    thumb.className = 'cd-settings-toggle-thumb';
    track.appendChild(thumb);
    toggle.appendChild(track);

    if (currentValue) toggle.classList.add('on');

    toggle.addEventListener('click', () => {
        const newVal = !settings.get(def.key, def.defaultValue ?? false);
        settings.set(def.key, newVal);
        toggle.classList.toggle('on', newVal);
        toggle.setAttribute('aria-checked', String(newVal));
    });

    row.appendChild(toggle);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Select (dropdown)
   ═══════════════════════════════════════════════════════ */

function createSelect(row, def, settings) {
    const currentValue = settings.get(def.key, def.defaultValue ?? '');

    row.innerHTML = `
        <div class="cd-settings-label-group">
            <span class="cd-settings-label">${escapeText(def.label)}</span>
            ${def.description ? `<span class="cd-settings-desc">${escapeText(def.description)}</span>` : ''}
        </div>
    `;

    const select = document.createElement('select');
    select.className = 'cd-dialog-select cd-settings-control';

    for (const opt of (def.options || [])) {
        const option = document.createElement('option');
        option.value = typeof opt === 'object' ? opt.value : opt;
        option.textContent = typeof opt === 'object' ? opt.label : opt;
        if (option.value === String(currentValue)) option.selected = true;
        select.appendChild(option);
    }

    select.addEventListener('change', () => {
        settings.set(def.key, select.value);
    });

    row.appendChild(select);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Slider (range)
   ═══════════════════════════════════════════════════════ */

function createSlider(row, def, settings) {
    const currentValue = settings.get(def.key, def.defaultValue ?? def.min ?? 0);

    row.classList.add('cd-settings-row-vertical');
    row.innerHTML = `
        <div class="cd-settings-label-group">
            <span class="cd-settings-label">${escapeText(def.label)}</span>
            ${def.description ? `<span class="cd-settings-desc">${escapeText(def.description)}</span>` : ''}
            <span class="cd-settings-value">${currentValue}</span>
        </div>
    `;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'cd-settings-slider';
    slider.min = String(def.min ?? 0);
    slider.max = String(def.max ?? 100);
    slider.step = String(def.step ?? 1);
    slider.value = String(currentValue);

    const valueDisplay = row.querySelector('.cd-settings-value');

    slider.addEventListener('input', () => {
        const val = Number(slider.value);
        valueDisplay.textContent = val;
        settings.set(def.key, val);
    });

    row.appendChild(slider);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Text input
   ═══════════════════════════════════════════════════════ */

function createText(row, def, settings) {
    const currentValue = settings.get(def.key, def.defaultValue ?? '');

    row.classList.add('cd-settings-row-vertical');
    row.innerHTML = `
        <div class="cd-settings-label-group">
            <span class="cd-settings-label">${escapeText(def.label)}</span>
            ${def.description ? `<span class="cd-settings-desc">${escapeText(def.description)}</span>` : ''}
        </div>
    `;

    const input = document.createElement('input');
    input.className = 'cd-dialog-input cd-settings-control';
    input.type = 'text';
    input.value = currentValue;
    if (def.placeholder) input.placeholder = def.placeholder;

    let debounceTimer = null;
    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            settings.set(def.key, input.value);
        }, 300);
    });

    row.appendChild(input);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Action (button — one-shot operation)
   ═══════════════════════════════════════════════════════ */

function createAction(row, def, settings) {
    row.innerHTML = `
        <div class="cd-settings-label-group">
            <span class="cd-settings-label">${escapeText(def.label)}</span>
            ${def.description ? `<span class="cd-settings-desc">${escapeText(def.description)}</span>` : ''}
        </div>
    `;

    const desc = row.querySelector('.cd-settings-desc');
    const btn = document.createElement('button');
    btn.className = 'cd-settings-action-btn';
    if (def.dangerous) btn.classList.add('cd-settings-action-danger');
    const applyButtonState = async () => {
        const state = typeof def.getButtonState === 'function'
            ? await def.getButtonState()
            : {};
        btn.textContent = state.label || def.buttonLabel || _t('common.execute');
        btn.disabled = !!state.disabled;
        if (desc && typeof state.description === 'string') {
            desc.textContent = state.description;
        }
    };
    applyButtonState().catch(e => console.error('[Settings] Button state error:', e));
    const refreshEvents = Array.isArray(def.refreshEvents) ? def.refreshEvents : [];
    const cleanups = refreshEvents
        .map(event => window.ComfyDrawer?.bus?.on?.(event, () => {
            applyButtonState().catch(e => console.error('[Settings] Button state error:', e));
        }))
        .filter(Boolean);
    let refreshTimer = null;
    if (Number(def.refreshInterval) > 0) {
        refreshTimer = setInterval(() => {
            applyButtonState().catch(e => console.error('[Settings] Button state error:', e));
        }, Number(def.refreshInterval));
    }
    if (cleanups.length) {
        const observer = new MutationObserver(() => {
            if (document.body.contains(row)) return;
            for (const cleanup of cleanups) cleanup();
            if (refreshTimer) clearInterval(refreshTimer);
            observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    } else if (refreshTimer) {
        const observer = new MutationObserver(() => {
            if (document.body.contains(row)) return;
            clearInterval(refreshTimer);
            observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    btn.addEventListener('click', async () => {
        if (typeof def.action !== 'function') return;
        if (btn.disabled) return;
        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = _t('common.processing');
        try {
            await def.action();
            await applyButtonState();
        } catch (e) {
            btn.textContent = _t('common.errorOccurred');
            console.error('[Settings] Action error:', e);
            setTimeout(() => {
                btn.textContent = origText;
                applyButtonState().catch(err => console.error('[Settings] Button state error:', err));
            }, 2000);
        }
    });

    row.appendChild(btn);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Color Picker (live preview — writes CSS variable immediately)
   ═══════════════════════════════════════════════════════ */

function createColorPicker(row, def, settings) {
    const currentValue = settings.get(def.key, def.defaultValue ?? '#7c5cfc');

    row.innerHTML = `
        <div class="cd-settings-label-group">
            <span class="cd-settings-label">${escapeText(def.label)}</span>
            ${def.description ? `<span class="cd-settings-desc">${escapeText(def.description)}</span>` : ''}
        </div>
    `;

    const wrap = document.createElement('div');
    wrap.className = 'cd-settings-color-wrap';

    // Swatch — visible colored square that also acts as click target
    const swatch = document.createElement('span');
    swatch.className = 'cd-settings-color-swatch';
    swatch.style.background = currentValue;
    swatch.title = def.label;
    swatch.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    // Native color input sits inside the swatch (opacity:0, fills whole area)
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'cd-settings-color-input';
    input.value = currentValue;
    swatch.appendChild(input);

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cd-settings-color-reset';
    resetBtn.title = _t('common.reset');
    resetBtn.textContent = '↩';

    wrap.appendChild(swatch);
    wrap.appendChild(resetBtn);

    input.addEventListener('input', () => {
        swatch.style.background = input.value;
        settings.set(def.key, input.value);
    });

    resetBtn.addEventListener('click', () => {
        const defVal = def.defaultValue ?? '#7c5cfc';
        input.value = defVal;
        swatch.style.background = defVal;
        settings.set(def.key, defVal);
    });

    row.appendChild(wrap);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Color Palette Row  (ベース / メイン / ディナイ in one row)
   ═══════════════════════════════════════════════════════ */

function createColorPalette(row, def, settings) {
    const palette = document.createElement('div');
    palette.className = 'cd-color-palette';

    for (const colorDef of (def.colors || [])) {
        const item = document.createElement('div');
        item.className = 'cd-color-palette-item';

        const curVal = settings.get(colorDef.key, colorDef.defaultValue ?? '#888888');

        // Swatch (transparent input layered inside)
        const swatch = document.createElement('span');
        swatch.className = 'cd-settings-color-swatch cd-color-palette-swatch';
        swatch.style.background = curVal;
        swatch.title = colorDef.label;
        swatch.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'cd-settings-color-input';
        input.value = curVal.length === 7 ? curVal : '#888888';
        swatch.appendChild(input);

        // Label below swatch
        const label = document.createElement('span');
        label.className = 'cd-color-palette-label';
        label.textContent = colorDef.label;

        // User picks a color manually
        input.addEventListener('input', () => {
            swatch.style.background = input.value;
            settings.set(colorDef.key, input.value);
        });

        // React when preset selection changes the setting
        settings.onChange(colorDef.key, (_key, value) => {
            if (!value) return;
            swatch.style.background = value;
            try { input.value = value.length === 7 ? value : input.value; } catch {}
        });

        item.appendChild(swatch);
        item.appendChild(label);
        palette.appendChild(item);
    }

    row.appendChild(palette);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Preset Theme Picker (visual swatch grid)
   ═══════════════════════════════════════════════════════ */

function createPresetTheme(row, def, settings) {
    row.classList.add('cd-settings-row-vertical');

    const ACCENT_KEY        = 'ComfyDrawer.Theme.AccentColor';
    const DANGER_KEY        = 'ComfyDrawer.Theme.DangerColor';
    const SHELL_KEY         = 'ComfyDrawer.Theme.ShellColor';
    const PRESET_KEY        = 'ComfyDrawer.Theme.ActivePreset';
    const CUSTOM_ACCENT_KEY = 'ComfyDrawer.Theme.CustomAccent';
    const CUSTOM_DANGER_KEY = 'ComfyDrawer.Theme.CustomDanger';
    const CUSTOM_SHELL_KEY  = 'ComfyDrawer.Theme.CustomShell';

    // ── State ─────────────────────────────────────────────────────────────
    // activePresetId has 3 distinct values:
    //   preset ID  – that preset is explicitly selected; colors match it.
    //   null       – "カスタム" mode; CUSTOM_* updated on picker change.
    //   '_dirty'   – no selection; was on preset, user changed a color.
    //                CUSTOM_* NOT updated here; committed on next dialog open.
    let customColors = {
        accent: settings.get(CUSTOM_ACCENT_KEY, '#3a9de0'),
        danger: settings.get(CUSTOM_DANGER_KEY, '#e05252'),
        shell:  settings.get(CUSTOM_SHELL_KEY,  '#1a1a1a'),
    };

    const _commitDirtyAsCustom = (lA, lD, lS) => {
        customColors = {
            accent: lA || customColors.accent,
            danger: lD || customColors.danger,
            shell:  lS || customColors.shell,
        };
        settings.set(PRESET_KEY,        'custom');
        settings.set(CUSTOM_ACCENT_KEY, customColors.accent);
        settings.set(CUSTOM_DANGER_KEY, customColors.danger);
        settings.set(CUSTOM_SHELL_KEY,  customColors.shell);
    };

    const _mode = settings.get(PRESET_KEY, 'custom');
    let activePresetId;

    if (_mode === '_dirty') {
        // Previous session: closed while in dirty state → commit live colors as custom.
        _commitDirtyAsCustom(
            settings.get(ACCENT_KEY, ''),
            settings.get(DANGER_KEY, ''),
            settings.get(SHELL_KEY,  '')
        );
        activePresetId = null;
    } else if (_mode === 'custom') {
        activePresetId = null;
    } else {
        activePresetId = _mode;
        // Backward-compat: if live colors differ from preset (Phi state from old code),
        // treat it the same as '_dirty' and commit as custom.
        const _p = (def.presets || []).find(p => p.id === activePresetId);
        if (_p) {
            const lA = settings.get(ACCENT_KEY, '');
            const lD = settings.get(DANGER_KEY, '');
            const lS = settings.get(SHELL_KEY,  '');
            if (lA !== _p.accent || lD !== _p.danger || lS !== _p.shell) {
                _commitDirtyAsCustom(lA, lD, lS);
                activePresetId = null;
            }
        }
    }

    // ── DOM ───────────────────────────────────────────────────────────────
    const grid = document.createElement('div');
    grid.className = 'cd-theme-presets';
    let customBtn = null;

    // Guard against false dirty transitions while a preset is being applied
    // (def.onSelect calls settings.set sequentially; each triggers onChange).
    let _applyingPreset = false;

    // ── refreshUI ─────────────────────────────────────────────────────────
    const refreshUI = () => {
        if (!grid.isConnected) return; // stale listener from a closed dialog

        // Dirty detection: if we're on a preset and a color deviates (and we're
        // NOT in the middle of applying a preset), switch to '_dirty'.
        if (activePresetId !== null && activePresetId !== '_dirty' && !_applyingPreset) {
            const _p = (def.presets || []).find(p => p.id === activePresetId);
            if (_p) {
                const lA = settings.get(ACCENT_KEY, '');
                const lD = settings.get(DANGER_KEY, '');
                const lS = settings.get(SHELL_KEY,  '');
                if (lA !== _p.accent || lD !== _p.danger || lS !== _p.shell) {
                    activePresetId = '_dirty';
                    settings.set(PRESET_KEY, '_dirty');
                }
            }
        }

        // Preset button highlights
        grid.querySelectorAll('.cd-theme-preset-btn[data-preset-id]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.presetId === activePresetId);
        });

        if (customBtn) {
            customBtn.classList.toggle('active', activePresetId === null);

            // CUSTOM_* updated ONLY in カスタム mode AND when not mid-apply.
            // _applyingPreset=true during def.onSelect: each settings.set fires onChange
            // synchronously. At that moment only one key is updated; the other two still
            // hold stale (preset) values. If we ran the update block here, we would read
            // the stale values and overwrite customColors/CUSTOM_* with preset colors.
            if (activePresetId === null && !_applyingPreset) {
                const a = settings.get(ACCENT_KEY, customColors.accent);
                const d = settings.get(DANGER_KEY, customColors.danger);
                const s = settings.get(SHELL_KEY,  customColors.shell);
                if (a && a !== customColors.accent) { customColors.accent = a; settings.set(CUSTOM_ACCENT_KEY, a); }
                if (d && d !== customColors.danger) { customColors.danger = d; settings.set(CUSTOM_DANGER_KEY, d); }
                if (s && s !== customColors.shell)  { customColors.shell  = s; settings.set(CUSTOM_SHELL_KEY,  s); }
            }

            // Dots always show customColors (the カスタム restore point)
            const dots = customBtn.querySelectorAll('.cd-theme-preset-dot');
            if (dots[0]) dots[0].style.background = customColors.accent;
            if (dots[1]) dots[1].style.background = customColors.danger;
            customBtn.style.setProperty('--preset-shell', customColors.shell);
        }
    };

    // ── Preset buttons ────────────────────────────────────────────────────
    for (const preset of (def.presets || [])) {
        const btn = document.createElement('button');
        btn.className = 'cd-theme-preset-btn';
        btn.dataset.presetId = preset.id;
        btn.title = preset.name;
        if (activePresetId === preset.id) btn.classList.add('active');
        if (preset.shell) btn.style.setProperty('--preset-shell', preset.shell);

        btn.innerHTML = `
            <div class="cd-theme-preset-swatch">
                <span class="cd-theme-preset-dot" style="background:${preset.accent}"></span>
                <span class="cd-theme-preset-dot" style="background:${preset.danger}"></span>
            </div>
            <span class="cd-theme-preset-name">${escapeText(preset.name)}</span>
        `;

        btn.addEventListener('click', () => {
            activePresetId = preset.id;
            settings.set(PRESET_KEY, preset.id);
            _applyingPreset = true;
            if (typeof def.onSelect === 'function') def.onSelect(preset);
            _applyingPreset = false;
            refreshUI();
        });

        grid.appendChild(btn);
    }

    // ── カスタム button ───────────────────────────────────────────────────
    customBtn = document.createElement('button');
    customBtn.className = 'cd-theme-preset-btn' + (activePresetId === null ? ' active' : '');
    customBtn.title = _t('settings.themeCustom');
    customBtn.style.setProperty('--preset-shell', customColors.shell);
    customBtn.innerHTML = `
        <div class="cd-theme-preset-swatch">
            <span class="cd-theme-preset-dot" style="background:${customColors.accent}"></span>
            <span class="cd-theme-preset-dot" style="background:${customColors.danger}"></span>
        </div>
        <span class="cd-theme-preset-name">${escapeText(_t('settings.themeCustom'))}</span>
    `;

    customBtn.addEventListener('click', () => {
        activePresetId = null;
        settings.set(PRESET_KEY, 'custom');
        _applyingPreset = true;
        if (typeof def.onSelect === 'function') def.onSelect(customColors);
        _applyingPreset = false;
        refreshUI();
    });
    grid.appendChild(customBtn);

    settings.onChange(ACCENT_KEY, refreshUI);
    settings.onChange(DANGER_KEY, refreshUI);
    settings.onChange(SHELL_KEY,  refreshUI);

    row.appendChild(grid);
    return row;
}

/* ═══════════════════════════════════════════════════════
   Gear Button Injection
   ═══════════════════════════════════════════════════════ */

/**
 * Create the ⚙️ settings button for the drawer tab bar.
 * Does NOT append to DOM — the caller is responsible for placement.
 * @returns {HTMLElement} The gear button element
 */
export function injectSettingsButton() {
    const btn = document.createElement('button');
    btn.className = 'comfy-drawer-settings-btn';
    btn.title = _t('settings.title');
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettingsPanel();
    });

    return btn;
}

/* ═══════════════════════════════════════════════════════
   User Dictionary Editor — Two-level navigation
   Level 1: Dictionary list (create, rename, delete)
   Level 2: Entry editor (add, edit, delete entries)
   ═══════════════════════════════════════════════════════ */

/**
 * Render a dictionary section (user dict or wildcard) with two-level navigation.
 * @param {HTMLElement} bodyEl - Settings panel body container
 * @param {object} opts - Section options (type, sectionTitle, createLabel, etc.)
 */
function renderDictSection(bodyEl, opts) {
    const { type, sectionTitle, sectionIcon, createLabel, createTitle, importAccept, importLabel, importIcon, extraItems } = opts;

    // Section header (skip if sectionTitle is falsy)
    if (sectionTitle) {
        const header = document.createElement('div');
        header.className = 'cd-settings-section';
        if (sectionIcon) header.innerHTML = sectionIcon + ' ' + sectionTitle;
        else header.textContent = sectionTitle;
        bodyEl.appendChild(header);
    }

    // Extra items (e.g., Danbooru toggle) rendered before the list
    if (extraItems?.items?.length) {
        for (const def of extraItems.items) {
            if (def.hidden) continue;
            const row = createSettingRow(def, extraItems.settings);
            bodyEl.appendChild(row);
        }
        // Divider between extra toggles and the dict list
        const divider = document.createElement('div');
        divider.className = 'cd-settings-divider';
        bodyEl.appendChild(divider);
    }

    // Container swaps between list view and detail view
    const container = document.createElement('div');
    container.className = 'cd-ud-editor';
    bodyEl.appendChild(container);

    // ── Level 1: Dictionary List ──
    const showDictList = async () => {
        container.innerHTML = '<div class="cd-ud-loading">' + _t('common.loading') + '</div>';
        try {
            const resp = await apiFetch('/drawer/user-dicts');
            if (!resp.ok) { container.innerHTML = '<div class="cd-ud-empty">' + _t('common.loadError') + '</div>'; return; }
            const allDicts = await resp.json();
            const dicts = allDicts.filter(d => (d.type || 'dict') === type);
            renderDictList(dicts);
        } catch (e) {
            container.innerHTML = '<div class="cd-ud-empty">' + _t('common.connectionError') + '</div>';
        }
    };

    const renderDictList = (dicts) => {
        container.innerHTML = '';

        if (dicts.length === 0) {
            const emptyKey = type === 'wildcard' ? 'dict.noWildcard' : 'dict.noDict';
            container.innerHTML = '<div class="cd-ud-empty">' + _t(emptyKey) + '</div>';
        } else {
            for (const d of dicts) {
                const row = document.createElement('div');
                row.className = 'cd-settings-row cd-ud-dict-row';

                // Label group (title + count)
                const labelGroup = document.createElement('div');
                labelGroup.className = 'cd-settings-label-group';
                labelGroup.style.cursor = 'pointer';

                const label = document.createElement('span');
                label.className = 'cd-settings-label';
                label.textContent = d.title;
                labelGroup.appendChild(label);

                const desc = document.createElement('span');
                desc.className = 'cd-settings-desc';
                desc.textContent = _t('common.items', { count: d.count });
                labelGroup.appendChild(desc);

                row.appendChild(labelGroup);

                // Click label group → open entry editor
                labelGroup.addEventListener('click', () => {
                    showEntryEditor(d);
                });

                // ON/OFF toggle (right side)
                const toggle = document.createElement('button');
                toggle.className = 'cd-settings-toggle';
                toggle.setAttribute('role', 'switch');
                toggle.setAttribute('aria-checked', String(d.enabled));
                const track = document.createElement('span');
                track.className = 'cd-settings-toggle-track';
                const thumb = document.createElement('span');
                thumb.className = 'cd-settings-toggle-thumb';
                track.appendChild(thumb);
                toggle.appendChild(track);
                if (d.enabled) toggle.classList.add('on');
                toggle.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const newVal = !d.enabled;
                    d.enabled = newVal;
                    toggle.classList.toggle('on', newVal);
                    toggle.setAttribute('aria-checked', String(newVal));
                    await apiFetch(`/drawer/user-dicts/${d.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: newVal }),
                    });
                    reloadUserDict();
                });
                row.appendChild(toggle);



                container.appendChild(row);
            }
        }

        // Create button → inline title input
        const createBtn = document.createElement('button');
        createBtn.className = 'cd-ud-btn-create';
        createBtn.textContent = createLabel;

        const createForm = document.createElement('div');
        createForm.className = 'cd-ud-create-form';
        createForm.style.display = 'none';
        const createInput = document.createElement('input');
        createInput.className = 'cd-dialog-input';
        createInput.type = 'text';
        createInput.placeholder = createTitle;
        createInput.style.flex = '1';
        createInput.style.fontSize = '14px';
        const confirmCreateBtn = document.createElement('button');
        confirmCreateBtn.className = 'cd-ud-btn-save';
        confirmCreateBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmCreateBtn.title = _t('common.create');
        const cancelCreateBtn = document.createElement('button');
        cancelCreateBtn.className = 'cd-ud-btn-cancel';
        cancelCreateBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
        cancelCreateBtn.title = _t('common.cancel');
        createForm.append(createInput, confirmCreateBtn, cancelCreateBtn);

        const cancelCreate = () => {
            createForm.style.display = 'none';
            createBtn.style.display = '';
            createInput.value = '';
        };

        const doCreate = async () => {
            const title = createInput.value.trim();
            if (!title) { cancelCreate(); return; }
            confirmCreateBtn.disabled = cancelCreateBtn.disabled = true;
            await apiFetch('/drawer/user-dicts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, type }),
            });
            reloadUserDict();
            showDictList();
        };

        createBtn.addEventListener('click', () => {
            createBtn.style.display = 'none';
            createForm.style.display = 'flex';
            createInput.value = '';
            createInput.focus();
        });

        confirmCreateBtn.addEventListener('click', doCreate);
        cancelCreateBtn.addEventListener('click', cancelCreate);
        createInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); doCreate(); }
            if (ev.key === 'Escape') { ev.preventDefault(); cancelCreate(); }
        });
        createInput.addEventListener('blur', () => {
            setTimeout(() => {
                if (createForm.contains(document.activeElement)) return;
                const title = createInput.value.trim();
                if (!title) cancelCreate();
            }, 100);
        });

        container.appendChild(createBtn);
        container.appendChild(createForm);

        // Import button
        const importBtn = document.createElement('button');
        importBtn.className = 'cd-ud-btn-create cd-ud-btn-import';
        const importLimitText = _t('dict.importLimitShort', { limit: formatBytes(MAX_DICT_IMPORT_BYTES) });
        if (importIcon) importBtn.innerHTML = importIcon + ' ' + importLabel + ' ' + importLimitText;
        else importBtn.textContent = importLabel + ' ' + importLimitText;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = importAccept;
        fileInput.style.display = 'none';
        importBtn.appendChild(fileInput);
        importBtn.addEventListener('click', (ev) => {
            if (ev.target === fileInput) return;
            fileInput.click();
        });
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;
            if (file.size > MAX_DICT_IMPORT_BYTES) {
                showDialog({
                    title: _t('common.error'),
                    message: _t('dict.importTooLarge', {
                        size: formatBytes(file.size),
                        limit: formatBytes(MAX_DICT_IMPORT_BYTES),
                    }),
                    showCancel: false,
                    confirmLabel: _t('common.close'),
                });
                fileInput.value = '';
                return;
            }
            importBtn.disabled = true;
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('type', type);
                const resp = await apiFetch('/drawer/user-dicts/import', { method: 'POST', body: formData });
                if (!resp.ok) {
                    const message = resp.status === 413
                        ? _t('dict.importTooLarge', {
                            size: formatBytes(file.size),
                            limit: formatBytes(MAX_DICT_IMPORT_BYTES),
                        })
                        : await readErrorMessage(resp);
                    showDialog({
                        title: _t('dict.importFailed'),
                        message,
                        showCancel: false,
                        confirmLabel: _t('common.close'),
                    });
                    return;
                }
                reloadUserDict();
                showDictList();
            } catch (e) {
                showDialog({
                    title: _t('dict.importFailed'),
                    message: e?.message || _t('common.connectionError'),
                    showCancel: false,
                    confirmLabel: _t('common.close'),
                });
            } finally {
                fileInput.value = '';
                importBtn.disabled = false;
            }
        });
        container.appendChild(importBtn);
    };

    // ── Level 2: Entry Editor ──
    const showEntryEditor = (dictMeta) => {
        container.innerHTML = '';
        const dictId = dictMeta.id;
        const isWildcard = type === 'wildcard';

        // Header: back + title + rename + delete-dict button
        const hdrRow = document.createElement('div');
        hdrRow.className = 'cd-ud-header-row';
        const backBtn = document.createElement('button');
        backBtn.className = 'cd-ud-btn-back';
        backBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
        backBtn.title = _t('common.backToList');
        backBtn.addEventListener('click', () => showDictList());
        hdrRow.appendChild(backBtn);
        const titleSpan = document.createElement('span');
        titleSpan.className = 'cd-ud-detail-title';
        titleSpan.textContent = dictMeta.title;
        hdrRow.appendChild(titleSpan);

        // Rename button (moved from list view)
        const renameBtn = document.createElement('button');
        renameBtn.className = 'cd-ud-btn-rename';
        renameBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
        renameBtn.title = _t('common.rename');
        renameBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.className = 'cd-dialog-input';
            input.type = 'text';
            input.value = dictMeta.title;
            input.style.fontSize = '14px';
            titleSpan.replaceWith(input);
            renameBtn.style.display = 'none';
            input.focus();
            input.select();
            const doSave = async () => {
                const t = input.value.trim();
                if (!t) { input.focus(); return; }
                await apiFetch(`/drawer/user-dicts/${dictId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: t }),
                });
                dictMeta.title = t;
                input.replaceWith(titleSpan);
                titleSpan.textContent = t;
                renameBtn.style.display = '';
            };
            input.addEventListener('blur', doSave);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                if (ev.key === 'Escape') { ev.preventDefault(); input.replaceWith(titleSpan); renameBtn.style.display = ''; }
            });
        });
        hdrRow.appendChild(renameBtn);

        const hdrDelBtn = document.createElement('button');
        hdrDelBtn.className = 'cd-ud-btn-del';
        hdrDelBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        hdrDelBtn.title = _t('common.delete');
        hdrDelBtn.addEventListener('click', async () => {
            if (!await showConfirm(_t('dict.confirmDelete', { title: dictMeta.title }), { danger: true })) return;
            hdrDelBtn.disabled = true;
            await apiFetch(`/drawer/user-dicts/${dictId}`, { method: 'DELETE' });
            reloadUserDict();
            showDictList();
        });
        hdrRow.appendChild(hdrDelBtn);
        container.appendChild(hdrRow);

        // Entry list
        const listEl = document.createElement('div');
        listEl.className = 'cd-ud-list';
        container.appendChild(listEl);

        // Add button
        const addBtn = document.createElement('button');
        addBtn.className = 'cd-ud-btn-create';
        addBtn.textContent = _t('dict.addEntry');
        container.appendChild(addBtn);

        // Hidden add form
        const addForm = document.createElement('div');
        addForm.className = 'cd-ud-add-form';
        addForm.style.display = 'none';
        if (isWildcard) {
            addForm.innerHTML = `<input class="cd-dialog-input cd-ud-input-tag" type="text" placeholder="${_t('dict.textPlaceholder')}" />`;
        } else {
            addForm.innerHTML = `
                <input class="cd-dialog-input cd-ud-input-tag" type="text" placeholder="${_t('dict.tagPlaceholder')}" />
                <input class="cd-dialog-input cd-ud-input-insert" type="text" placeholder="${_t('dict.insertTextPlaceholder')}" />
            `;
        }
        container.appendChild(addForm);
        const tagInput = addForm.querySelector('.cd-ud-input-tag');
        const insertInput = addForm.querySelector('.cd-ud-input-insert');

        addBtn.addEventListener('click', () => {
            addBtn.style.display = 'none';
            addForm.style.display = 'flex';
            tagInput.value = '';
            if (insertInput) insertInput.value = '';
            tagInput.focus();
        });

        const commitNewEntry = async () => {
            await new Promise(r => setTimeout(r, 100));
            if (addForm.contains(document.activeElement)) return;
            const val = tagInput.value.trim();
            if (!val) {
                addForm.style.display = 'none';
                addBtn.style.display = '';
                return;
            }
            const body = isWildcard
                ? { text: val }
                : { tag: val, insert_text: (insertInput?.value || '').trim() };
            await apiFetch(`/drawer/user-dict/${dictId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            tagInput.value = '';
            if (insertInput) insertInput.value = '';
            addForm.style.display = 'none';
            addBtn.style.display = '';
            reloadUserDict();
            loadEntries();
        };
        tagInput.addEventListener('blur', commitNewEntry);
        if (insertInput) insertInput.addEventListener('blur', commitNewEntry);
        const onAddKey = (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); document.activeElement?.blur(); }
            if (ev.key === 'Escape') {
                ev.preventDefault();
                tagInput.value = '';
                if (insertInput) insertInput.value = '';
                addForm.style.display = 'none';
                addBtn.style.display = '';
            }
        };
        tagInput.addEventListener('keydown', onAddKey);
        if (insertInput) insertInput.addEventListener('keydown', onAddKey);

        const loadEntries = async () => {
            listEl.innerHTML = '<div class="cd-ud-loading">' + _t('common.loading') + '</div>';
            try {
                const resp = await apiFetch(`/drawer/user-dict/${dictId}`);
                if (!resp.ok) { listEl.innerHTML = '<div class="cd-ud-empty">' + _t('common.loadError') + '</div>'; return; }
                renderEntries(await resp.json());
            } catch (e) {
                listEl.innerHTML = '<div class="cd-ud-empty">' + _t('common.connectionError') + '</div>';
            }
        };

        const renderEntries = (entries) => {
            listEl.innerHTML = '';
            if (entries.length === 0) {
                listEl.innerHTML = '<div class="cd-ud-empty">' + _t('dict.noEntries') + '</div>';
                return;
            }
            for (const e of entries) {
                const row = document.createElement('div');
                row.className = 'cd-ud-entry';
                const label = document.createElement('span');
                label.className = 'cd-ud-entry-label';
                label.textContent = isWildcard ? e.text : (e.insert_text ? `${e.tag} → ${e.insert_text}` : e.tag);
                label.title = _t('common.clickToEdit');
                row.appendChild(label);

                label.addEventListener('click', () => {
                    if (row.classList.contains('cd-ud-editing')) return;
                    row.classList.add('cd-ud-editing');
                    row.innerHTML = '';

                    if (isWildcard) {
                        const et = document.createElement('input');
                        et.className = 'cd-dialog-input cd-ud-edit-tag';
                        et.type = 'text'; et.value = e.text; et.placeholder = _t('dict.textPlaceholder');
                        const db = document.createElement('button');
                        db.className = 'cd-ud-btn-del'; db.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'; db.title = _t('common.delete');
                        row.append(et, db);
                        et.focus(); et.select();

                        let saving = false;
                        const doSave = async () => {
                            if (saving) return;
                            await new Promise(r => setTimeout(r, 100));
                            if (row.contains(document.activeElement)) return;
                            saving = true;
                            const nt = et.value.trim();
                            if (!nt) { loadEntries(); return; }
                            if (nt !== e.text) {
                                await apiFetch(`/drawer/user-dict/${dictId}`, {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ texts: [e.text] }),
                                });
                                await apiFetch(`/drawer/user-dict/${dictId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ text: nt }),
                                });
                            }
                            reloadUserDict();
                            loadEntries();
                        };
                        et.addEventListener('blur', doSave);
                        et.addEventListener('keydown', (ev) => {
                            if (ev.key === 'Enter') { ev.preventDefault(); document.activeElement?.blur(); }
                            if (ev.key === 'Escape') { ev.preventDefault(); loadEntries(); }
                        });
                        db.addEventListener('click', async (ev) => {
                            ev.stopPropagation(); saving = true; db.disabled = true;
                            await apiFetch(`/drawer/user-dict/${dictId}`, {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ texts: [e.text] }),
                            });
                            reloadUserDict();
                            loadEntries();
                        });
                    } else {
                        const et = document.createElement('input');
                        et.className = 'cd-dialog-input cd-ud-edit-tag';
                        et.type = 'text'; et.value = e.tag; et.placeholder = _t('dict.tagLabel');
                        const ei = document.createElement('textarea');
                        ei.className = 'cd-dialog-input cd-ud-edit-insert';
                        ei.value = e.insert_text || ''; ei.placeholder = _t('dict.insertText');
                        ei.rows = 1;
                        const autoResize = () => { ei.style.height = 'auto'; ei.style.height = ei.scrollHeight + 'px'; };
                        setTimeout(autoResize, 0);
                        const db = document.createElement('button');
                        db.className = 'cd-ud-btn-del'; db.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'; db.title = _t('common.delete');
                        row.append(et, ei, db);
                        et.focus(); et.select();

                        let saving = false;
                        const doSave = async () => {
                            if (saving) return;
                            await new Promise(r => setTimeout(r, 100));
                            if (row.contains(document.activeElement)) return;
                            saving = true;
                            const nt = et.value.trim();
                            if (!nt) { loadEntries(); return; }
                            if (nt !== e.tag) {
                                await apiFetch(`/drawer/user-dict/${dictId}`, {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ tags: [e.tag] }),
                                });
                            }
                            await apiFetch(`/drawer/user-dict/${dictId}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ tag: nt, insert_text: ei.value.trim() }),
                            });
                            reloadUserDict();
                            loadEntries();
                        };
                        et.addEventListener('blur', doSave);
                        ei.addEventListener('blur', doSave);
                        ei.addEventListener('input', autoResize);
                        et.addEventListener('keydown', (ev) => {
                            if (ev.key === 'Enter') { ev.preventDefault(); ei.focus(); }
                            if (ev.key === 'Escape') { ev.preventDefault(); loadEntries(); }
                        });
                        ei.addEventListener('keydown', (ev) => {
                            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); document.activeElement?.blur(); }
                            if (ev.key === 'Escape') { ev.preventDefault(); loadEntries(); }
                        });
                        db.addEventListener('click', async (ev) => {
                            ev.stopPropagation(); saving = true; db.disabled = true;
                            await apiFetch(`/drawer/user-dict/${dictId}`, {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ tags: [e.tag] }),
                            });
                            reloadUserDict();
                            loadEntries();
                        });
                    }
                });

                listEl.appendChild(row);
            }
        };

        loadEntries();
    };

    // Initial load
    showDictList();
}

/**
 * Reload user dictionary and wildcard data in DictService (force re-fetch).
 */
function reloadUserDict() {
    const dict = window.ComfyDrawer?.dict;
    if (dict) {
        dict._forceReload?.('user');
        dict._forceReload?.('wildcard');
    }
}


/* ═══════════════════════════════════════════════════════
   Utility
   ═══════════════════════════════════════════════════════ */

function escapeText(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
