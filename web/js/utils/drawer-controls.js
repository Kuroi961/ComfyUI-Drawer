export const DRAWER_CONTROL_COUNTS = new Map([
  ['DrawerControls1', 1],
  ['DrawerControls4', 4],
  ['DrawerControls8', 8],
  ['DrawerControls12', 12],
]);

export function getDrawerControlCount(node) {
  return DRAWER_CONTROL_COUNTS.get(node?.type) ?? 0;
}

export function isDrawerControlsNode(node) {
  return getDrawerControlCount(node) > 0;
}

export function parseDrawerControlDef(text) {
  const parts = String(text || '').split('|').map(p => p.trim());
  let type = (parts[0] || '').toLowerCase();
  if (type === 'num' || type === 'number' || type === 'number:float') type = 'float';
  if (type === 'integer' || type === 'number:int') type = 'int';
  if (type === 'boolean' || type === 'toggle') type = 'bool';
  if (!['int', 'float', 'combo', 'bool', 'string'].includes(type)) return null;

  const label = parts[1] || type;
  if (type === 'int' || type === 'float') {
    return {
      type, label,
      min: Number(parts[2] ?? 0),
      max: Number(parts[3] ?? 1),
      step: Number(parts[4] ?? (type === 'int' ? 1 : 0.01)),
      round: Number(parts[5] ?? (type === 'int' ? 0 : 2)),
    };
  }
  if (type === 'combo') {
    return {
      type, label,
      fallbackOptions: (parts[2] || '').split(',').map(s => s.trim()).filter(Boolean),
    };
  }
  if (type === 'string') {
    const ui = (parts[2] || 'single').toLowerCase();
    return {
      type, label,
      multiline: ui === 'multiline',
    };
  }
  return { type, label };
}

export function getDrawerControlOutputLinks(bridge, node, outputIndex) {
  if (typeof bridge?.getOutputLinks === 'function') {
    return bridge.getOutputLinks(node, outputIndex);
  }
  return [];
}

export function getDrawerControlLinkedComboOptions(bridge, node, outputIndex) {
  const links = getDrawerControlOutputLinks(bridge, node, outputIndex);
  const optionSets = [];
  for (const link of links) {
    const widget = bridge?.getWidgetForLinkedInput?.(link.targetId, link.targetSlot);
    const opts = typeof widget?.options?.values === 'function'
      ? widget.options.values()
      : widget?.options?.values;
    if (Array.isArray(opts) && opts.length) optionSets.push(opts.map(String));
  }
  if (!optionSets.length) return [];
  const first = optionSets[0];
  const same = optionSets.every(opts =>
    opts.length === first.length && opts.every((v, i) => v === first[i])
  );
  return same ? first : [];
}

export function enumerateDrawerControls(bridge, node, { connectedOnly = true } = {}) {
  const controls = [];
  const count = getDrawerControlCount(node);
  if (!count) return controls;
  const widgets = node?.widgets || [];
  for (let i = 1; i <= count; i++) {
    const outputIndex = i - 1;
    const links = getDrawerControlOutputLinks(bridge, node, outputIndex);
    if (connectedOnly && !links.length) continue;

    const valueWidget = widgets.find(w => w.name === `value_${i}`);
    const defWidget = widgets.find(w => w.name === `def_${i}`);
    const def = parseDrawerControlDef(defWidget?.value);
    if (!valueWidget || !def) continue;

    const comboOptions = def.type === 'combo'
      ? getDrawerControlLinkedComboOptions(bridge, node, outputIndex)
      : [];

    controls.push({
      index: i,
      outputIndex,
      links,
      valueWidget,
      defWidget,
      def,
      name: valueWidget.name,
      label: def.label,
      comboOptions,
    });
  }
  return controls;
}
