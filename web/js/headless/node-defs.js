/**
 * ComfyDrawer — headless node definitions
 *
 * Rebuilds the widget layout the ComfyUI frontend would create for a node
 * from /object_info, so a saved workflow's widgets_values can be mapped back
 * to widget names without loading the frontend. Mirrors the widget
 * constructors of ComfyUI frontend 1.55 (useIntWidget, useComboWidget, …).
 *
 * Pure module: no DOM, no network. Testable under Node.
 */

/** Graph-only node types the frontend never sends to the backend. */
export const VIRTUAL_NODE_TYPES = new Set([
    'Reroute',
    'SetNode',      // KJNodes
    'GetNode',      // KJNodes
    'Note',
    'MarkdownNote',
]);

/** Input types that get a widget from the frontend core (ComfyWidgets keys). */
export const CORE_WIDGET_TYPES = new Set([
    'INT', 'FLOAT', 'BOOLEAN', 'STRING', 'MARKDOWN', 'COMBO', 'IMAGEUPLOAD',
    'COLOR', 'IMAGECOMPARE', 'BOUNDING_BOX', 'CHART', 'GALLERIA', 'PAINTER',
    'COMPOSITOR', 'TEXTAREA', 'CURVE', 'RANGE', 'VIDEO_EDIT',
    'RESOLUTION_PREVIEW', 'BOUNDING_BOXES', 'COLORS', 'COMFY_DYNAMICCOMBO_V3',
]);

/** Widget-producing input types whose value never reaches the prompt. */
const NON_PROMPT_WIDGET_TYPES = new Set(['IMAGEUPLOAD']);

/** Name of the seed/combo "control after generate" companion widget. */
export const CONTROL_WIDGET_NAME = 'control_after_generate';
/** Combo controls also get a filter-list text widget (frontend addValueControlWidgets). */
export const CONTROL_FILTER_WIDGET_NAME = 'control_filter_list';
export const CONTROL_MODES = ['fixed', 'increment', 'decrement', 'randomize'];

export function specType(spec) {
    const t = spec?.[0];
    return Array.isArray(t) ? 'COMBO' : t;
}

export function specOptions(spec) {
    const o = spec?.[1];
    return o && typeof o === 'object' ? o : {};
}

/** Combo choices for a COMBO spec in either the legacy or the options form. */
export function comboValues(spec) {
    if (Array.isArray(spec?.[0])) return spec[0];
    const opts = specOptions(spec).options;
    return Array.isArray(opts) ? opts : [];
}

/**
 * Inputs in the order the frontend creates them: required then optional,
 * honouring object_info's input_order when present. Hidden inputs are
 * never widgets or sockets and are skipped.
 * @returns {{name: string, spec: any[], optional: boolean}[]}
 */
export function orderedInputs(def) {
    const req = def?.input?.required ?? {};
    const opt = def?.input?.optional ?? {};
    const order = def?.input_order ?? {};
    const names = (src, ord) => {
        const keys = Object.keys(src);
        if (!Array.isArray(ord) || !ord.length) return keys;
        return [...ord.filter(n => n in src), ...keys.filter(n => !ord.includes(n))];
    };
    return [
        ...names(req, order.required).map(name => ({ name, spec: req[name], optional: false })),
        ...names(opt, order.optional).map(name => ({ name, spec: opt[name], optional: true })),
    ];
}

/** Frontend widget.type string for an input type (what Deck/XYZ branch on). */
function widgetTypeFor(type, opts) {
    switch (type) {
        case 'INT':
        case 'FLOAT':
            if (opts.display === 'slider') return 'slider';
            if (opts.display === 'knob') return 'knob';
            if (opts.display === 'color') return 'color';
            return 'number';
        case 'BOOLEAN': return 'toggle';
        case 'STRING': return opts.multiline ? 'customtext' : 'text';
        case 'COMBO': return 'combo';
        case 'IMAGEUPLOAD': return 'button';
        default: return String(type).toLowerCase();
    }
}

function widgetOptionsFor(type, spec, opts) {
    if (type === 'COMBO') return { values: comboValues(spec) };
    if (type === 'INT') {
        const step = opts.step ?? 1;
        return { min: opts.min ?? 0, max: opts.max ?? 2048, step: step * 10, step2: step, precision: 0 };
    }
    if (type === 'FLOAT') {
        const step = opts.step ?? 0.5;
        const precision = opts.precision ?? (opts.round != null && opts.round !== false
            ? Math.max(0, -Math.floor(Math.log10(opts.round)))
            : 2);
        return { min: opts.min ?? 0, max: opts.max ?? 2048, step: step * 10, step2: step, round: opts.round, precision };
    }
    if (type === 'STRING') return { multiline: !!opts.multiline, dynamicPrompts: opts.dynamicPrompts };
    if (type === 'BOOLEAN') return { on: opts.label_on, off: opts.label_off };
    return {};
}

function controlEntryFor(type, name, opts) {
    const cag = opts.control_after_generate;
    if (type === 'INT' && (cag ?? ['seed', 'noise_seed'].includes(name))) {
        return typeof cag === 'string' ? cag : 'randomize';
    }
    if (type === 'COMBO' && cag) {
        return typeof cag === 'string' ? cag : 'randomize';
    }
    return null;
}

const DYNAMIC_COMBO = 'COMFY_DYNAMICCOMBO_V3';
const AUTOGROW = 'COMFY_AUTOGROW_V3';

function inputsMap(inputs) {
    return { ...(inputs?.required ?? {}), ...(inputs?.optional ?? {}) };
}

/**
 * Spec for an input name, including V3 dynamic sub-inputs: "model.size" is
 * the `size` input of the option chosen in the `model` DynamicCombo, and
 * "model.images.image_1" a slot of the `images` Autogrow inside it.
 * @param {object} def
 * @param {string} name
 * @param {Record<string, string>} [selected] - current DynamicCombo values by name
 */
export function resolveInputSpec(def, name, selected = {}) {
    const parts = String(name).split('.');
    let spec = inputsMap(def?.input)[parts[0]];
    for (let i = 1; i < parts.length && spec; i++) {
        const type = specType(spec);
        const opts = specOptions(spec);
        if (type === DYNAMIC_COMBO) {
            const choices = Array.isArray(opts.options) ? opts.options : [];
            const key = selected[parts.slice(0, i).join('.')];
            const option = choices.find(c => c.key === key && parts[i] in inputsMap(c.inputs))
                ?? choices.find(c => parts[i] in inputsMap(c.inputs));
            spec = option ? inputsMap(option.inputs)[parts[i]] : undefined;
        } else if (type === AUTOGROW) {
            const template = inputsMap(opts.template?.input);
            spec = Object.values(template)[0];
        } else {
            spec = undefined;
        }
    }
    return spec;
}

/**
 * Whether a saved value contradicts its widget's type — the sign of a
 * positional shift (node definition changed since the workflow was saved).
 */
export function valueFitsWidget(inputType, value) {
    if (value === null || value === undefined) return true;
    if (inputType === 'BOOLEAN') return typeof value === 'boolean';
    if (inputType === 'INT' || inputType === 'FLOAT') return typeof value === 'number';
    return true;
}

/** The frontend's default for a widget without a saved value. */
function defaultValueFor(type, spec, opts) {
    if (opts.default !== undefined) return opts.default;
    switch (type) {
        case 'COMBO': return comboValues(spec)[0];
        case DYNAMIC_COMBO: return opts.options?.[0]?.key;
        case 'INT':
        case 'FLOAT': return 0;
        case 'STRING': return '';
        case 'BOOLEAN': return false;
        default: return undefined;
    }
}

function valueEntry(name, spec) {
    const type = specType(spec);
    const opts = specOptions(spec);
    const entry = {
        name,
        inputType: type ?? 'UNKNOWN',
        type: type ? widgetTypeFor(type, opts) : 'text',
        options: type ? widgetOptionsFor(type, spec, opts) : {},
        serialize: !NON_PROMPT_WIDGET_TYPES.has(type),
        dynamicPrompts: type === 'STRING' && opts.dynamicPrompts === true,
        defaultValue: defaultValueFor(type, spec, opts),
    };
    if (type === DYNAMIC_COMBO) {
        entry.type = 'combo';
        entry.options = { values: (opts.options ?? []).map(o => o.key) };
    }
    return entry;
}

function controlEntry(target, spec) {
    const type = specType(spec);
    const mode = type ? controlEntryFor(type, String(target).split('.').pop(), specOptions(spec)) : null;
    return {
        name: CONTROL_WIDGET_NAME,
        inputType: 'CONTROL',
        type: 'combo',
        options: { values: type === 'COMBO' ? [...CONTROL_MODES, 'increment-wrap'] : [...CONTROL_MODES] },
        serialize: false,
        control: true,
        controls: target,
        defaultValue: mode ?? 'fixed',
    };
}

function controlFilterEntry(target) {
    return {
        name: CONTROL_FILTER_WIDGET_NAME,
        inputType: 'CONTROL_FILTER',
        type: 'string',
        options: {},
        serialize: false,
        controlFilter: true,
        controls: target,
        defaultValue: '',
    };
}

/** A widget the frontend has but object_info does not describe (extension-made). */
function extensionEntry(name) {
    return {
        name,
        inputType: 'EXTENSION',
        type: 'button',
        options: {},
        serialize: true,
        dynamicPrompts: false,
        defaultValue: null,
    };
}

const UPLOAD_OPTIONS = ['image_upload', 'animated_image_upload', 'video_upload', 'audio_upload', 'mesh_upload'];

/** The upload button the frontend adds after a combo with an *_upload option. */
function uploadEntry() {
    return {
        name: 'upload',
        inputType: 'IMAGEUPLOAD',
        type: 'button',
        options: {},
        serialize: false,
        dynamicPrompts: false,
        defaultValue: 'image',
    };
}

/** Top-level widget names in object_info order (with upload buttons). */
function definitionWidgetNames(def) {
    const names = [];
    for (const { name, spec } of orderedInputs(def)) {
        const type = specType(spec);
        const opts = specOptions(spec);
        if (!CORE_WIDGET_TYPES.has(type) || opts.forceInput) continue;
        names.push(name);
        if (type === 'COMBO' && UPLOAD_OPTIONS.some(k => opts[k])) names.push('upload');
    }
    return names;
}

/**
 * Widget names in the order the frontend creates them: object_info widgets
 * merged into the saved order, plus extension widgets (names object_info
 * cannot resolve) at their saved relative position.
 */
function derivedWidgetNames(def, nodeJson, savedNames) {
    const declared = (nodeJson?.inputs ?? [])
        .filter(i => i?.widget?.name)
        .map(i => i.widget.name);
    const fromDef = definitionWidgetNames(def);
    const names = [...declared];
    fromDef.forEach((name, i) => {
        if (names.includes(name)) return;
        const prev = fromDef.slice(0, i).reverse().find(n => names.includes(n));
        names.splice(prev === undefined ? 0 : names.indexOf(prev) + 1, 0, name);
    });
    (savedNames ?? []).forEach((name, i) => {
        if (names.includes(name) || name === 'upload' || name === CONTROL_WIDGET_NAME
            || name === CONTROL_FILTER_WIDGET_NAME) return;
        if (resolveInputSpec(def, name)) return;
        const prev = savedNames.slice(0, i).reverse().find(n => names.includes(n));
        names.splice(prev === undefined ? 0 : names.indexOf(prev) + 1, 0, name);
    });
    return names;
}

/**
 * Widget layout for one node, in widgets_values order.
 *
 * The frontend creates widgets from the *current* object_info (plus V3
 * dynamic sub-widgets, upload buttons, seed control widgets and widgets added
 * by extensions) and assigns widgets_values positionally. Saved workflows list
 * every widget input in `inputs[]` with a `widget` marker in that order, so the
 * saved order is used; object_info widgets missing from it — inputs added to
 * the node after the workflow was saved — are merged in at their definition
 * position and take their defaults.
 *
 * Extension widgets (buttons, dynamic rows) are invisible to object_info.
 * `savedNames` — the keys of the node's widgets_values_named, written by
 * frontend 1.43+ — places them. Without it, saved data past the layout is
 * reported as `unknownWidgets`.
 *
 * @param {object|null} def - object_info entry for the node's class
 * @param {object} nodeJson - serialized node
 * @param {string[]} [savedNames] - widget names at save time, in order
 * @returns {{layout: object[], unknownWidgets: boolean}}
 */
export function widgetLayout(def, nodeJson, savedNames) {
    const values = nodeJson?.widgets_values;
    const names = derivedWidgetNames(def, nodeJson, savedNames);
    const selected = {};
    const layout = [];
    for (let n = 0; n < names.length; n++) {
        const name = names[n];
        const spec = resolveInputSpec(def, name, selected);
        if (!spec) {
            layout.push(name === 'upload' ? uploadEntry() : extensionEntry(name));
            continue;
        }
        const at = layout.length;
        layout.push(valueEntry(name, spec));
        if (controlEntryFor(specType(spec), String(name).split('.').pop(), specOptions(spec))) {
            layout.push(controlEntry(name, spec));
            if (specType(spec) === 'COMBO') layout.push(controlFilterEntry(name));
        }
        if (specType(spec) !== DYNAMIC_COMBO) continue;
        // The selected option's widgets follow the combo; ones the save
        // predates are inserted with their defaults.
        const choices = specOptions(spec).options ?? [];
        const saved = Array.isArray(values) ? values[at] : values?.[name];
        const key = saved ?? layout[at].defaultValue;
        selected[name] = key;
        const option = choices.find(c => c.key === key) ?? choices[0];
        let insertAt = n + 1;
        for (const sub of definitionWidgetNames({ input: option?.inputs })) {
            const full = `${name}.${sub}`;
            const existing = names.indexOf(full);
            if (existing === -1) names.splice(insertAt++, 0, full);
            else insertAt = Math.max(insertAt, existing + 1);
        }
    }
    // Trailing nulls are display widgets/buttons (PreviewAny, KJ "Update
    // inputs"); data past the layout means widgets object_info cannot place.
    const unknownWidgets = Array.isArray(values)
        && values.slice(layout.length).some(v => v !== null);
    return { layout, unknownWidgets };
}

/**
 * Node types whose filename_prefix widget serializes through
 * applyTextReplacements: the core list (Comfy.SaveImageExtraOutput) plus
 * extensions known to install the same serializeValue hook.
 */
export const SAVE_NODE_TYPES = new Set([
    // ComfyUI frontend core
    'SaveImage', 'SaveImageAdvanced', 'SaveSVGNode', 'SaveVideo', 'SaveAnimatedWEBP',
    'SaveWEBM', 'SaveAudio', 'SaveAudioMP3', 'SaveAudioOpus', 'SaveAudioAdvanced',
    'SaveGLB', 'Save3DAdvanced', 'SaveGaussianSplat', 'SavePointCloud',
    'SaveAnimatedPNG', 'CLIPSave', 'VAESave', 'ModelSave', 'LoraSave', 'SaveLatent',
    // ComfyUI-Save-Separate-Metadata
    'SaveJPGSeparateMeta', 'SaveWebPSeparateMeta', 'SavePNGSeparateMeta',
    // KJNodes
    'SaveImageKJ',
    // VideoHelperSuite
    'VHS_VideoCombine',
]);

const DATE_PARTS = {
    d: d => d.getDate(),
    M: d => d.getMonth() + 1,
    h: d => d.getHours(),
    m: d => d.getMinutes(),
    s: d => d.getSeconds(),
};
const DATE_PATTERN = new RegExp(Object.keys(DATE_PARTS).map(k => k + k + '?').join('|') + '|yyy?y?', 'g');

/** Frontend formatDate: yyyy / yy / MM / dd / hh / mm / ss (and single-letter forms). */
export function formatDate(text, date) {
    return text.replace(DATE_PATTERN, (tok) => {
        if (tok === 'yy') return String(date.getFullYear()).substring(2);
        if (tok === 'yyyy') return String(date.getFullYear());
        if (tok[0] in DATE_PARTS) return String(DATE_PARTS[tok[0]](date)).padStart(tok.length, '0');
        return tok;
    });
}

/**
 * Frontend applyTextReplacements: %date:FMT% and %Node.widget% (node matched
 * by "Node name for S&R", then by title, across the root graph and subgraphs).
 * @param {Iterable<object>} nodes - every node (root + subgraph definitions)
 * @param {string} text
 * @param {Date} [now]
 */
export function applyTextReplacements(nodes, text, now = new Date()) {
    const all = [...nodes];
    return String(text).replace(/%([^%]+)%/g, (match, body) => {
        const parts = body.split('.');
        if (parts.length !== 2) {
            return parts[0].startsWith('date:') ? formatDate(parts[0].substring(5), now) : match;
        }
        let hits = all.filter(n => (n.properties?.['Node name for S&R'] ?? n.type) === parts[0]);
        if (!hits.length) hits = all.filter(n => n.title === parts[0]);
        if (!hits.length) return match;
        const widget = hits[0].widgets?.find(w => w.name === parts[1]);
        if (!widget) return match;
        return String(widget.value ?? '').replaceAll(/[/?<>\\:*|"\x00-\x1F\x7F]/g, '_');
    });
}

/**
 * ComfyUI frontend's processDynamicPrompt: strips // and /* *\/ comments and
 * resolves {a|b|c} choices (nested, with backslash escapes).
 * @param {string} text
 * @param {() => number} [random]
 */
export function processDynamicPrompt(text, random = Math.random) {
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const src = stripComments(text);
    let i = 0;
    const escape = () => '\\' + src[i++];
    const parseChoice = () => {
        const options = [];
        let cur = '';
        let depth = 0;
        while (i < src.length) {
            const ch = src[i++];
            if (ch === '\\') { cur += escape(); continue; }
            if (ch === '{') depth++;
            else if (ch === '}') {
                if (!depth) break;
                depth--;
            } else if (ch === '|' && !depth) {
                options.push(cur);
                cur = '';
                continue;
            }
            cur += ch;
        }
        options.push(cur);
        return processDynamicPrompt(options[Math.floor(random() * options.length)], random);
    };
    let out = '';
    while (i < src.length) {
        const ch = src[i++];
        out += ch === '\\' ? escape() : ch === '{' ? parseChoice() : ch;
    }
    return out.replace(/\\([{}|])/g, '$1');
}
