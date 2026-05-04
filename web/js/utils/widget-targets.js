import { enumerateDrawerControls, isDrawerControlsNode } from './drawer-controls.js';
import { normalizePath } from '../utils.js';

function getWidgetOptions(widget) {
  const values = typeof widget?.options?.values === 'function'
    ? widget.options.values()
    : widget?.options?.values;
  return Array.isArray(values) ? values : [];
}

function getNodeTitle(node) {
  return node?.title || node?.type || `Node ${node?.id ?? '?'}`;
}

function createWidgetTarget(bridge, node, widget, { label = widget?.name, valueType = widget?.type || 'widget' } = {}) {
  return {
    kind: 'widget',
    valueType,
    node,
    nodeId: node.id,
    nodeType: node.comfyClass ?? node.type,
    nodeTitle: getNodeTitle(node),
    widget,
    widgetName: widget?.name || label,
    label,
    displayName: label,
    getValue: () => widget?.value,
    getOptions: () => getWidgetOptions(widget),
    addOption: (value) => {
      const values = getWidgetOptions(widget);
      if (Array.isArray(widget?.options?.values) && !values.includes(value)) {
        widget.options.values.push(value);
      }
    },
    setValue: (value) => {
      if (!widget) return false;
      bridge.invokeWidgetCallback(node, widget, value);
      return true;
    },
  };
}

function createDrawerControlTarget(bridge, node, control) {
  const valueWidget = control.valueWidget;
  return {
    kind: 'drawer-control',
    valueType: control.def.type,
    node,
    nodeId: node.id,
    nodeType: node.comfyClass ?? node.type,
    nodeTitle: getNodeTitle(node),
    widget: valueWidget,
    widgetName: control.label || control.name,
    label: control.label || control.name,
    displayName: control.label || control.name,
    control,
    getValue: () => valueWidget?.value,
    getOptions: () => control.def.type === 'combo' ? control.comboOptions : [],
    addOption: () => {},
    setValue: (value) => {
      if (!valueWidget) return false;
      bridge.invokeWidgetCallback(node, valueWidget, value);
      return true;
    },
  };
}

export function enumerateModelValueTargets(bridge, modelPath) {
  const normalizedModelPath = normalizePath(modelPath);
  const results = [];
  const proxiedWidgets = new Set();

  for (const node of bridge?.allNodes || []) {
    if (!isDrawerControlsNode(node)) continue;
    for (const control of enumerateDrawerControls(bridge, node, { connectedOnly: true })) {
      for (const link of control.links || []) {
        const widget = bridge?.getWidgetForLinkedInput?.(link.targetId, link.targetSlot);
        if (widget?.name) proxiedWidgets.add(`${Number(link.targetId)}:${widget.name}`);
      }
    }
  }

  for (const node of bridge?.allNodes || []) {
    if (isDrawerControlsNode(node)) {
      for (const control of enumerateDrawerControls(bridge, node, { connectedOnly: true })) {
        if (control.def.type !== 'combo') continue;
        const target = createDrawerControlTarget(bridge, node, control);
        const origValue = target.getOptions().find(v => normalizePath(v) === normalizedModelPath);
        if (origValue !== undefined) results.push({ ...target, origValue });
      }
    }

    for (const widget of node.widgets || []) {
      if (proxiedWidgets.has(`${node.id}:${widget.name}`)) continue;
      const origValue = getWidgetOptions(widget).find(v =>
        typeof v === 'string' && normalizePath(v) === normalizedModelPath
      );
      if (origValue !== undefined) {
        results.push({ ...createWidgetTarget(bridge, node, widget), origValue });
      }
    }
  }
  return results;
}

export function enumerateLoadImageTargets(bridge, { maskOnly = false } = {}) {
  const targets = [];
  for (const node of bridge?.allNodes || []) {
    const nodeType = node.comfyClass ?? node.type;
    const isLoadImage = nodeType === 'LoadImage';
    const isLoadImageMask = nodeType === 'LoadImageMask';

    if ((!maskOnly && (isLoadImage || isLoadImageMask)) || (maskOnly && isLoadImageMask)) {
      const widget = (node.widgets || []).find(w =>
        (w.name === 'image' || w.name === 'Image') &&
        (w.type === 'combo' || typeof w.value === 'string')
      );
      if (widget) {
        targets.push(createWidgetTarget(bridge, node, widget, { label: widget.name, valueType: 'image' }));
      }
    }

    if (isDrawerControlsNode(node)) {
      for (const control of enumerateDrawerControls(bridge, node, { connectedOnly: true })) {
        if (control.def.type !== 'combo' && control.def.type !== 'string') continue;
        const linkedToWantedNode = control.links.some(link => {
          const target = bridge.getNodeById?.(Number(link.targetId));
          const targetType = target?.comfyClass ?? target?.type;
          return maskOnly
            ? targetType === 'LoadImageMask'
            : targetType === 'LoadImage' || targetType === 'LoadImageMask';
        });
        if (linkedToWantedNode) targets.push(createDrawerControlTarget(bridge, node, control));
      }
    }
  }
  return targets;
}
