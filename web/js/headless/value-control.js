/**
 * ComfyDrawer — headless widget value control
 *
 * Port of ComfyUI frontend 1.55's "control after generate" (valueControl):
 * after (or before) each queued prompt, widgets with a control companion
 * move to their next value — fixed / increment / decrement / randomize, and
 * increment-wrap plus the filter list for combos.
 *
 * Pure module: no DOM.
 */
const MAX_NUMBER = 0x4000000000000;
const MIN_NUMBER = -0x4000000000000;

function comboFilter(text) {
    if (!text) return null;
    if (text.startsWith('/') && text.endsWith('/')) {
        try {
            const re = new RegExp(text.substring(1, text.length - 1));
            return (v) => re.test(v);
        } catch { /* invalid regex: fall through to substring match */ }
    }
    const needle = text.toLocaleLowerCase();
    return (v) => v.toLocaleLowerCase().includes(needle);
}

function nextComboValue(widget, mode, filterText, random) {
    const all = (widget.options?.values ?? []).filter(v => typeof v === 'string' || typeof v === 'number');
    const filter = comboFilter(filterText);
    const values = filter ? all.filter(v => filter(String(v))) : all;
    if (!values.length) return undefined;
    let i = values.indexOf(widget.value);
    const n = values.length;
    switch (mode) {
        case 'increment': i += 1; break;
        case 'increment-wrap': i += 1; if (i >= n) i = 0; break;
        case 'decrement': i -= 1; break;
        case 'randomize': i = Math.floor(random() * n); break;
    }
    return values[Math.max(0, Math.min(n - 1, i))];
}

function nextNumberValue(widget, mode, random) {
    if (typeof widget.value !== 'number') return undefined;
    const { min = 0, max = 1, step2 = 1 } = widget.options ?? {};
    const hi = Math.min(MAX_NUMBER, max);
    const lo = Math.max(MIN_NUMBER, min);
    let v = widget.value;
    switch (mode) {
        case 'increment':
        case 'increment-wrap': v += step2; break;
        case 'decrement': v -= step2; break;
        case 'randomize': v = Math.floor(random() * ((hi - lo) / step2)) * step2 + lo; break;
    }
    return Math.min(Math.max(v, lo), hi);
}

/**
 * Next value for a controlled widget, or undefined to leave it.
 * @param {object} widget - target widget (value, options, linkedWidgets)
 * @param {() => number} [random]
 */
export function nextControlledValue(widget, random = Math.random) {
    const control = widget.linkedWidgets?.find(w => w.control);
    if (!control || control.value === 'fixed') return undefined;
    const filter = widget.linkedWidgets.find(w => w.controlFilter)?.value;
    return widget.type === 'combo'
        ? nextComboValue(widget, control.value, typeof filter === 'string' ? filter : undefined, random)
        : nextNumberValue(widget, control.value, random);
}

/**
 * Apply one control pass over every node. The frontend skips widgets whose
 * input is linked (the link supplies the value).
 * @param {Iterable<object>} nodes
 * @param {() => number} [random]
 * @returns {number} how many widgets changed
 */
export function applyValueControls(nodes, random = Math.random) {
    let changed = 0;
    for (const node of nodes) {
        for (const widget of node.widgets ?? []) {
            if (!widget.linkedWidgets?.some(w => w.control)) continue;
            if (node.inputs?.some(i => i.widget?.name === widget.name && i.link != null)) continue;
            const next = nextControlledValue(widget, random);
            if (next === undefined || next === widget.value) continue;
            widget.callback(next);
            changed++;
        }
    }
    return changed;
}
