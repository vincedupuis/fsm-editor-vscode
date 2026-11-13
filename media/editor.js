// @ts-check
/* global acquireVsCodeApi */
(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  /** Grammar of behaviors, conditions and triggers (media/expressions.js). */
  // @ts-ignore
  const X = window.FsmExpressions;

  const GRID = 10;
  const NAME_H = 24;
  const LINE_H = 14;
  const PSEUDO = new Set([
    'initial', 'shallowHistory', 'deepHistory', 'choice', 'junction',
    'fork', 'join', 'entryPoint', 'exitPoint', 'terminate',
  ]);
  const TYPE_LABEL = {
    state: 'State', final: 'Final State', initial: 'Initial', shallowHistory: 'Shallow History',
    deepHistory: 'Deep History', choice: 'Choice', junction: 'Junction', fork: 'Fork', join: 'Join',
    entryPoint: 'Entry Point', exitPoint: 'Exit Point', terminate: 'Terminate', comment: 'Comment',
    connectionPointRef: 'Connection Point Reference',
  };
  /** Pseudostate kinds that can be swapped for one another from the properties panel. */
  const SWAPPABLE = [
    ['initial', 'shallowHistory', 'deepHistory', 'choice', 'junction', 'terminate'],
    ['fork', 'join'],
    ['entryPoint', 'exitPoint'],
  ];

  // ---------------------------------------------------------------- icons
  const I = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    state: I('<rect x="3" y="6" width="18" height="12" rx="4"/>'),
    composite: I('<rect x="2" y="3" width="20" height="18" rx="4"/><line x1="2" y1="8" x2="22" y2="8"/><rect x="6" y="11" width="7" height="6" rx="2"/>'),
    orthogonal: I('<rect x="2" y="3" width="20" height="18" rx="4"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="2" y1="14.5" x2="22" y2="14.5" stroke-dasharray="2.5 2"/>'),
    submachine: I('<rect x="2" y="5" width="20" height="14" rx="4"/><rect x="11" y="12" width="4" height="3" rx="1"/><rect x="17" y="12" width="3" height="3" rx="1"/><line x1="15" y1="13.5" x2="17" y2="13.5"/>'),
    final: I('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>'),
    initial: I('<circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none"/>'),
    shallowHistory: I('<circle cx="12" cy="12" r="8.5"/><path d="M9 8v8M15 8v8M9 12h6"/>'),
    deepHistory: I('<circle cx="12" cy="12" r="8.5"/><path d="M7.5 8v8M12.5 8v8M7.5 12h5M16.5 8.5v4M14.7 9.5l3.6 2M18.3 9.5l-3.6 2"/>'),
    choice: I('<path d="M12 4l8 8-8 8-8-8z"/>'),
    junction: I('<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>'),
    fork: I('<line x1="12" y1="2" x2="12" y2="9"/><rect x="3" y="9" width="18" height="3.5" fill="currentColor" stroke="none"/><line x1="7" y1="12.5" x2="7" y2="21"/><line x1="17" y1="12.5" x2="17" y2="21"/>'),
    join: I('<line x1="7" y1="2" x2="7" y2="11"/><line x1="17" y1="2" x2="17" y2="11"/><rect x="3" y="11" width="18" height="3.5" fill="currentColor" stroke="none"/><line x1="12" y1="14.5" x2="12" y2="22"/>'),
    entryPoint: I('<path d="M2 12h5M17 12h5" opacity=".5"/><circle cx="12" cy="12" r="5"/>'),
    exitPoint: I('<path d="M2 12h5M17 12h5" opacity=".5"/><circle cx="12" cy="12" r="5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>'),
    terminate: I('<path d="M6 6l12 12M18 6L6 18" stroke-width="2"/>'),
    connectionPointRef: I('<rect x="2" y="5" width="14" height="14" rx="3.5"/><circle cx="16" cy="9" r="3" fill="var(--vscode-sideBar-background, #fff)"/><circle cx="16" cy="16" r="3" fill="var(--vscode-sideBar-background, #fff)"/><path d="M14.2 14.2l3.6 3.6M17.8 14.2l-3.6 3.6"/>'),
    transition: I('<path d="M3 18L20 5"/><path d="M13 5h7v7"/>'),
    region: I('<rect x="2" y="3" width="20" height="18" rx="4"/><line x1="2" y1="12" x2="22" y2="12" stroke-dasharray="2.5 2"/><path d="M12 15v4M10 17h4"/>'),
    comment: I('<path d="M4 3h11l5 5v13H4z"/><path d="M15 3v5h5"/><path d="M7 12h9M7 16h7"/>'),
    select: I('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
    undo: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>'),
    redo: I('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>'),
    zoomIn: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/>'),
    zoomOut: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>'),
    fit: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    export: I('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v6h14v-6"/>'),
    json: I('<path d="M8 4c-2 0-2 2-2 4s-2 4-2 4 2 0 2 4 0 4 2 4M16 4c2 0 2 2 2 4s2 4 2 4-2 0-2 4 0 4-2 4"/>'),
    code: I('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'),
    trace: I('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
    trash: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    close: I('<path d="M7 7l10 10M17 7L7 17"/>'),
    sideLeft: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
    sideLeftOn: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M4 5h5v14H4z" fill="currentColor" stroke="none"/>'),
    sideRight: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
    sideRightOn: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 5h5v14h-5z" fill="currentColor" stroke="none"/>'),
  };

  // ---------------------------------------------------------------- toolbox
  const uidRegion = () => ({ id: uid('r'), name: '' });
  const TOOLS = [
    {
      group: 'States',
      items: [
        { id: 'state', label: 'State', key: 's', create: () => ({ type: 'state', name: uniqueName('State'), w: 140, h: 60, regions: [] }) },
        { id: 'composite', label: 'Composite State', create: () => ({ type: 'state', name: uniqueName('Composite'), w: 280, h: 190, regions: [uidRegion()] }) },
        { id: 'orthogonal', label: 'Orthogonal State', create: () => ({ type: 'state', name: uniqueName('Orthogonal'), w: 340, h: 250, regions: [uidRegion(), uidRegion()], regionLayout: 'vertical' }) },
        { id: 'submachine', label: 'Submachine State', create: () => ({ type: 'state', name: uniqueName('Sub'), submachine: machines[0] ? machines[0].href : '', w: 170, h: 60, regions: [] }) },
        { id: 'connectionPointRef', label: 'Connection Point Ref', create: () => ({ type: 'connectionPointRef', name: '', ref: '', pointKind: 'entry', w: 16, h: 16 }) },
        { id: 'final', label: 'Final State', key: 'x', create: () => ({ type: 'final', name: '', w: 26, h: 26 }) },
      ],
    },
    {
      group: 'Pseudostates',
      items: [
        { id: 'initial', label: 'Initial', key: 'i', create: () => ({ type: 'initial', name: '', w: 20, h: 20 }) },
        { id: 'shallowHistory', label: 'Shallow History', key: 'h', create: () => ({ type: 'shallowHistory', name: '', w: 26, h: 26 }) },
        { id: 'deepHistory', label: 'Deep History', create: () => ({ type: 'deepHistory', name: '', w: 26, h: 26 }) },
        { id: 'choice', label: 'Choice', key: 'c', create: () => ({ type: 'choice', name: '', w: 28, h: 28 }) },
        { id: 'junction', label: 'Junction', key: 'j', create: () => ({ type: 'junction', name: '', w: 14, h: 14 }) },
        { id: 'fork', label: 'Fork', create: () => ({ type: 'fork', name: '', w: 90, h: 8 }) },
        { id: 'join', label: 'Join', create: () => ({ type: 'join', name: '', w: 90, h: 8 }) },
        { id: 'entryPoint', label: 'Entry Point', create: () => ({ type: 'entryPoint', name: '', w: 16, h: 16 }) },
        { id: 'exitPoint', label: 'Exit Point', create: () => ({ type: 'exitPoint', name: '', w: 16, h: 16 }) },
        { id: 'terminate', label: 'Terminate', create: () => ({ type: 'terminate', name: '', w: 20, h: 20 }) },
      ],
    },
    {
      group: 'Connections',
      items: [
        { id: 'transition', label: 'Transition', key: 't', mode: true },
        { id: 'region', label: 'Add Region', key: 'r', mode: true },
      ],
    },
    {
      group: 'Annotations',
      items: [{ id: 'comment', label: 'Comment', key: 'n', create: () => ({ type: 'comment', name: '', text: 'Note', w: 160, h: 64, anchors: [] }) }],
    },
  ];
  const TOOL_BY_ID = new Map(TOOLS.flatMap((g) => g.items).map((t) => [t.id, t]));

  // ---------------------------------------------------------------- state
  /** @type {any} */ let model = null;
  let lastText = null;
  /** Problems found by the extension's validation. */
  let issues = [];
  /** Those plus the editor's own layout warnings (overlapping elements), refreshed by each render. */
  let allIssues = [];
  let issuesById = new Map();
  let selection = new Set();
  /**
   * The Trace Player's highlights, or null without a trace: by element id, the colors of the instances where it is
   * active, taken (transitions and the pseudostates on their way) or current (-1: the only instance of this machine).
   */
  let trace = null;
  /** Instance colors of the Trace Player (classes trace-c0… in editor.css). */
  const TRACE_COLORS = 6;
  const saved = vscode.getState() || {};
  let view = saved.view || { x: 40, y: 40, zoom: 1 };
  let tool = null;
  let toolSticky = false;
  let drag = null;
  let spaceDown = false;
  let pasteCount = 0;
  let firstLoad = !saved.view;
  /** Machines referenced by submachine states (keyed by href), supplied by the extension. */
  let submachines = {};
  /** State machines in the workspace that can be used as submachines: [{ href, name, file, points }]. */
  let machines = [];
  /** Display name of the machine a submachine href points to. */
  const machineLabel = (href) =>
    (submachines[href] && submachines[href].name) ||
    (machines.find((m) => m.href === href) || {}).name ||
    decodeHref(String(href).split('#')[0]).replace(/^.*\//, '').replace(/\.fsm$/, '');
  /** decodeURI keeping malformed escapes as they are instead of throwing, and decoding `%23` and `%3F` (decodeHref of src/util.ts). */
  function decodeHref(s) {
    const at = (i) => (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3)) ? parseInt(s.slice(i + 1, i + 3), 16) : -1);
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    let out = '';
    let i = 0;
    while (i < s.length) {
      const b = at(i);
      if (b >= 0) {
        const len = b < 0x80 ? 1 : b >= 0xc0 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf7 ? 4 : 0;
        const run = [b];
        let j = i + 3;
        while (run.length < len && at(j) >= 0) {
          run.push(at(j));
          j += 3;
        }
        let text = null;
        try {
          if (run.length === len) text = utf8.decode(new Uint8Array(run));
        } catch {
          text = null;
        }
        if (text !== null) {
          out += len === 1 && ';/:@&=+$,'.includes(text) ? s.slice(i, j) : text;
          i = j;
          continue;
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }
  /** Name of the point `id` in the machine referenced by `state`. */
  const pointName = (state, id) => ((state && submachinePoints(state).find((q) => q.id === id)) || {}).name || '';

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ ($('canvas')));
  const world = $('world');
  const wrap = $('canvas-wrap');
  const toolboxEl = $('toolbox');
  const propsPane = $('props');
  /** Where the properties are being built: the side panel, or the body of the properties window. */
  let propsEl = propsPane;
  const PANES = { toolbox: $('toolbox-pane'), props: $('props-pane') };
  /** Shown side panels, the same in every diagram editor (kept by the extension). */
  let panels = { toolbox: true, props: true };
  try {
    panels = { ...panels, ...JSON.parse($('app').dataset.panels || '{}') };
  } catch {
    // keep both panels
  }
  const statusEl = $('statusbar');
  const toolbarEl = $('toolbar');
  const problemsEl = $('problems');
  const toastEl = $('toast');
  const parseErrorEl = $('parse-error');

  // ---------------------------------------------------------------- model index
  let V = new Map();
  let T = new Map();
  let regionOwner = new Map();

  function reindex() {
    V = new Map();
    T = new Map();
    regionOwner = new Map();
    for (const r of model.regions) regionOwner.set(r.id, null);
    for (const v of model.vertices) {
      V.set(v.id, v);
      for (const r of v.regions || []) regionOwner.set(r.id, v);
    }
    for (const t of model.transitions) T.set(t.id, t);
  }

  /** Vertices glued to the border of a state: entry/exit points of a state and connection point references. */
  const isCP = (v) => v.type === 'connectionPointRef' || ((v.type === 'entryPoint' || v.type === 'exitPoint') && V.has(v.parent));
  const isPointType = (t) => t === 'entryPoint' || t === 'exitPoint' || t === 'connectionPointRef';
  const refKind = (v) => (v.pointKind === 'exit' ? 'exit' : 'entry');
  const rootRegion = () => model.regions[0].id;

  function owner(v) {
    return (isCP(v) ? V.get(v.parent) : regionOwner.get(v.parent)) || null;
  }
  function ancestors(v) {
    const out = [];
    const seen = new Set([v.id]);
    let o = owner(v);
    while (o && !seen.has(o.id)) {
      seen.add(o.id);
      out.push(o);
      o = owner(o);
    }
    return out;
  }
  const depth = (v) => ancestors(v).length;
  const isInside = (v, id) => ancestors(v).some((a) => a.id === id);
  const descendants = (v) => model.vertices.filter((x) => x !== v && isInside(x, v.id));

  function uid(prefix) {
    let id;
    do id = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    while (V.has(id) || T.has(id) || regionOwner.has(id));
    return id;
  }
  function uniqueName(base) {
    const names = new Set(model.vertices.map((v) => v.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(base + i)) return base + i;
  }

  // ---------------------------------------------------------------- labels
  function transitionLabel(t) {
    const trig = (t.triggers || []).join(', ');
    if (model.kind === 'protocol') {
      let s = '';
      if (t.precondition) s += `[${t.precondition}] `;
      s += trig;
      if (t.postcondition) s += ` / [${t.postcondition}]`;
      return s.trim();
    }
    let s = trig;
    if (t.guard) s += ` [${t.guard}]`;
    if (t.effect) s += ` / ${t.effect}`;
    return s.trim();
  }

  /** The label as stacked lines: events, then [guard], then / effect (protocol machines: [pre], event, / [post]), each with the item it shows. */
  function transitionLabelItems(t) {
    const trig = (t.triggers || []).join(', ');
    const items = model.kind === 'protocol'
      ? [['precondition', t.precondition ? `[${t.precondition}]` : ''], ['triggers', trig], ['postcondition', t.postcondition ? `/ [${t.postcondition}]` : '']]
      : [['triggers', trig], ['guard', t.guard ? `[${t.guard}]` : ''], ['effect', t.effect ? `/ ${t.effect}` : '']];
    return items.filter(([, text]) => text).map(([key, text]) => ({ key, text }));
  }
  const transitionLabelLines = (t) => transitionLabelItems(t).map((l) => l.text);

  const LABEL_LINE_HEIGHT = 13;

  /** Parses "t1, t2 [guard] / effect" (or "[pre] t / [post]" for protocol machines). */
  /** May transitions leaving `source` use the [else] guard? */
  const allowsElse = (source) => !!source && (source.type === 'choice' || source.type === 'junction');

  /**
   * Parses "t1, after(2s) [guard] / effect" (or "[pre] t / [post]" for protocol
   * machines) into `t`. Returns an error message and leaves `t` untouched when
   * any part breaks the grammar.
   */
  function applyLabel(t, text) {
    if (model.kind === 'protocol') {
      const m = /^\s*(?:\[([^\]]*)\])?([^/]*?)\s*(?:\/\s*\[([^\]]*)\])?\s*$/.exec(text);
      if (!m) return 'Write the label as [precondition] event / [postcondition].';
      const pre = X.checkCondition(m[1]);
      if (!pre.ok) return `Precondition: ${pre.error}`;
      const trig = X.checkList(m[2], X.checkTrigger);
      if (!trig.ok) return `Trigger: ${trig.error}`;
      const post = X.checkCondition(m[3]);
      if (!post.ok) return `Postcondition: ${post.error}`;
      t.precondition = pre.value;
      t.triggers = trig.value;
      t.postcondition = post.value;
      return null;
    }
    const slash = indexOutsideBrackets(text, '/');
    const head = slash >= 0 ? text.slice(0, slash) : text;
    const g = /\[([^\]]*)\]\s*$/.exec(head);
    const trig = X.checkList(g ? head.slice(0, g.index) : head, X.checkTrigger);
    if (!trig.ok) return `Trigger: ${trig.error}`;
    const guard = X.checkGuard(g ? g[1] : '', allowsElse(V.get(t.source)));
    if (!guard.ok) return `Guard: ${guard.error}`;
    const effect = X.checkActions(slash >= 0 ? text.slice(slash + 1) : '');
    if (!effect.ok) return `Effect: ${effect.error}`;
    t.triggers = trig.value;
    t.guard = guard.value;
    t.effect = effect.value;
    return null;
  }
  function indexOutsideBrackets(s, ch) {
    let d = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '[') d++;
      else if (s[i] === ']') d = Math.max(0, d - 1);
      else if (s[i] === ch && d === 0) return i;
    }
    return -1;
  }

  /** The lines of a state's internal activities compartment, with the color each is drawn in. */
  function activityItems(v) {
    const out = [];
    const add = (text, key) => out.push({ text, color: itemColor(v, key) });
    if (v.entry) add(`entry / ${v.entry}`, 'entry');
    if (v.exit) add(`exit / ${v.exit}`, 'exit');
    if (v.doActivity) add(`do / ${v.doActivity}`, 'doActivity');
    for (const d of v.deferrable || []) add(`${d} / defer`, 'deferrable');
    for (const t of model.transitions) {
      if (t.kind === 'internal' && t.source === v.id && t.target === v.id) {
        out.push({ text: transitionLabel(t) || '(internal)', color: colorOf(t.color) || colorOf(v.color) });
      }
    }
    return out;
  }
  const activityLines = (v) => activityItems(v).map((l) => l.text);

  // ---------------------------------------------------------------- colors
  /** Colors offered by the properties panel, readable on light and dark backgrounds. */
  const PALETTE = [
    '#e5484d', '#f76b15', '#d4a20b', '#30a46c', '#12a594', '#0090ff',
    '#3e63dd', '#8e4ec6', '#d6409f', '#a18072', '#8b8d98', '#5b5bd6',
  ];
  const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c);
  const colorOf = (c) => (isColor(c) ? c : null);
  /** Color of one item of a state or transition: its own, else the element's. */
  const itemColor = (e, key) => colorOf(e.itemColors && e.itemColors[key]) || colorOf(e.color);
  /** Background color of a composite state's regions (not inherited from the state's own color). */
  const backgroundOf = (v) => colorOf(v.itemColors && v.itemColors.background);
  /** Fill of a state in the SVG export (`.shape` in EXPORT_CSS). */
  const EXPORT_FILL = '#fdfdfd';
  /** Fill of a colored shape: a light tint of its color over the shape background. */
  function tint(c, exporting) {
    if (!exporting) return `color-mix(in srgb, ${c} 16%, var(--fsm-state))`;
    const mix = (i) => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.16 + 0xfd * 0.84).toString(16).padStart(2, '0');
    return `#${mix(1)}${mix(3)}${mix(5)}`;
  }
  const styleAttr = (...decls) => {
    const d = decls.filter(Boolean).join(';');
    return d ? ` style="${d}"` : '';
  };

  // ---------------------------------------------------------------- geometry
  const center = (v) => ({ x: v.x + v.w / 2, y: v.y + v.h / 2 });
  const snap = (n) => Math.round(n / GRID) * GRID;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const inRect = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

  /** The internal activities as drawn: each line wrapped to the width of the state. */
  function activityRows(v) {
    return activityItems(v).flatMap((l) => commentLines(l.text, v.w - 16).map((text) => ({ text, color: l.color })));
  }

  function headerHeight(v) {
    let h = NAME_H + (v.stereotype ? 12 : 0);
    const n = activityRows(v).length;
    if (n) h += n * LINE_H + 6;
    return h;
  }

  /**
   * Extents of a state's regions along its region layout, out of `total`: their own sizes, the last one
   * taking the rest, or equal parts when some size is missing or they leave nothing for the last one.
   */
  function regionSizes(regs, total) {
    const own = regs.slice(0, -1).map((r) => r.size);
    const sum = own.reduce((a, b) => a + (b || 0), 0);
    if (own.every((n) => typeof n === 'number' && n > 0) && sum < total) return [...own, total - sum];
    return regs.map(() => total / regs.length);
  }

  function regionRects(v) {
    const regs = v.regions || [];
    if (!regs.length) return [];
    const top = v.y + Math.min(headerHeight(v), v.h - 20);
    const bh = v.y + v.h - top;
    const horizontal = v.regionLayout === 'horizontal';
    const sizes = regionSizes(regs, horizontal ? v.w : bh);
    let at = horizontal ? v.x : top;
    return regs.map((r, i) => {
      const rect = horizontal
        ? { id: r.id, name: r.name, x: at, y: top, w: sizes[i], h: bh }
        : { id: r.id, name: r.name, x: v.x, y: at, w: v.w, h: sizes[i] };
      at += sizes[i];
      return rect;
    });
  }

  /** Deepest region under `p`, ignoring the states in `exclude`. */
  function regionAt(p, exclude) {
    const states = model.vertices
      .filter((v) => v.type === 'state' && (v.regions || []).length && !exclude.has(v.id))
      .sort((a, b) => depth(b) - depth(a));
    for (const s of states) {
      for (const r of regionRects(s)) if (inRect(r, p)) return r;
    }
    return null;
  }

  /** Deepest region that holds the whole box `b`, ignoring the states in `exclude`. */
  function regionHolding(b, exclude) {
    const states = model.vertices
      .filter((v) => v.type === 'state' && (v.regions || []).length && !exclude.has(v.id))
      .sort((a, b2) => depth(b2) - depth(a));
    for (const s of states) {
      for (const r of regionRects(s)) {
        if (b.x >= r.x - 1e-6 && b.y >= r.y - 1e-6 && b.x + b.w <= r.x + r.w + 1e-6 && b.y + b.h <= r.y + r.h + 1e-6) return r;
      }
    }
    return null;
  }

  /** Whether region `id` is region `outer` or lies inside it, at any depth. */
  function regionWithin(id, outer) {
    if (id === outer) return true;
    // Each state once: a region id used twice (a file edited by hand) can make a state its own ancestor.
    const seen = new Set();
    for (let o = regionOwner.get(id); o && !seen.has(o); o = regionOwner.get(o.parent)) {
      seen.add(o);
      if (o.parent === outer) return true;
    }
    return false;
  }

  function stateAt(p, exclude) {
    const states = model.vertices
      .filter((v) => v.type === 'state' && !exclude.has(v.id) && inRect({ x: v.x - 6, y: v.y - 6, w: v.w + 12, h: v.h + 12 }, p))
      .sort((a, b) => depth(b) - depth(a));
    return states[0] || null;
  }

  function borderPoint(s, p) {
    const x = clamp(p.x, s.x, s.x + s.w);
    const y = clamp(p.y, s.y, s.y + s.h);
    const d = [Math.abs(x - s.x), Math.abs(s.x + s.w - x), Math.abs(y - s.y), Math.abs(s.y + s.h - y)];
    const m = Math.min(...d);
    if (m === d[0]) return { x: s.x, y };
    if (m === d[1]) return { x: s.x + s.w, y };
    if (m === d[2]) return { x, y: s.y };
    return { x, y: s.y + s.h };
  }

  function snapToBorder(cp, s, p) {
    const b = borderPoint(s, p);
    cp.x = b.x - cp.w / 2;
    cp.y = b.y - cp.h / 2;
  }

  function shapeKind(v) {
    switch (v.type) {
      case 'state':
      case 'comment':
      case 'fork':
      case 'join':
        return 'rect';
      case 'choice':
        return 'diamond';
      default:
        return 'circle';
    }
  }

  /** Point where the ray from the center of `v` towards `p` leaves its outline. */
  function clip(v, p) {
    const c = center(v);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (!dx && !dy) return c;
    const k = shapeKind(v);
    if (k === 'circle') {
      const d = Math.hypot(dx, dy);
      const r = Math.min(v.w, v.h) / 2;
      return { x: c.x + (dx / d) * r, y: c.y + (dy / d) * r };
    }
    if (k === 'diamond') {
      const t = 1 / (Math.abs(dx) / (v.w / 2) + Math.abs(dy) / (v.h / 2));
      return { x: c.x + dx * t, y: c.y + dy * t };
    }
    const tx = dx ? v.w / 2 / Math.abs(dx) : Infinity;
    const ty = dy ? v.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  /** An external or local self-transition of a state: a loop with three right angles over one of its corners. */
  function isLoop(t) {
    if (t.source !== t.target || t.kind === 'internal') return false;
    const s = V.get(t.source);
    return !!s && s.type === 'state';
  }

  /** Smallest distance between a state and the far corner of its self-transition loop, and between its ends and that corner of the state. */
  const LOOP_MIN_GAP = 10;

  /** Whether a loop starts on the state's top or bottom edge: clockwise over its top-right or bottom-left corner. */
  const startsOnTopOrBottom = (f) => f.right !== f.below;

  /**
   * A state's self-transition loop: the state's corner it goes over (`right`, `below`), its far
   * corner (`cx`, `cy`), and where it meets the state's top or bottom edge (`hx`) and its side (`vy`).
   * Its bend points are its three corners, or only its far corner, or none for the default loop
   * over the top-right corner. The far corner's quadrant around the state's center picks the
   * state's corner.
   */
  function loopFrame(t, s) {
    const pts = t.points || [];
    const gap = Math.max(18, Math.min(30, s.w / 3));
    const far = pts.length === 1 || pts.length === 3 ? pts[(pts.length - 1) / 2] : { x: s.x + s.w + gap, y: s.y - gap };
    const right = far.x >= s.x + s.w / 2;
    const below = far.y > s.y + s.h / 2;
    const f = {
      right,
      below,
      cx: far.x,
      cy: far.y,
      hx: right ? s.x + s.w * 0.72 : s.x + s.w * 0.28,
      vy: below ? s.y + s.h - Math.min(s.h * 0.3, 22) : s.y + Math.min(s.h * 0.3, 22),
    };
    if (pts.length === 3) {
      const [h, v] = startsOnTopOrBottom(f) ? [pts[0], pts[2]] : [pts[2], pts[0]];
      f.hx = h.x;
      f.vy = v.y;
    }
    return clampLoop(f, s);
  }

  /** Keeps a loop's far corner outside the state, and its ends on the state's edges away from the corner it goes over. */
  function clampLoop(f, s) {
    return {
      right: f.right,
      below: f.below,
      cx: f.right ? Math.max(f.cx, s.x + s.w + LOOP_MIN_GAP) : Math.min(f.cx, s.x - LOOP_MIN_GAP),
      cy: f.below ? Math.max(f.cy, s.y + s.h + LOOP_MIN_GAP) : Math.min(f.cy, s.y - LOOP_MIN_GAP),
      hx: f.right ? clamp(f.hx, s.x, s.x + s.w - LOOP_MIN_GAP) : clamp(f.hx, s.x + LOOP_MIN_GAP, s.x + s.w),
      vy: f.below ? clamp(f.vy, s.y, s.y + s.h - LOOP_MIN_GAP) : clamp(f.vy, s.y + LOOP_MIN_GAP, s.y + s.h),
    };
  }

  /** A loop's three corners, in the order it is drawn. */
  function loopCorners(f) {
    const h = { x: f.hx, y: f.cy };
    const far = { x: f.cx, y: f.cy };
    const v = { x: f.cx, y: f.vy };
    return startsOnTopOrBottom(f) ? [h, far, v] : [v, far, h];
  }

  /** Points of a state's self-transition loop, clockwise around the state's corner. */
  function loopRoute(t, s) {
    const f = loopFrame(t, s);
    const onTopOrBottom = { x: f.hx, y: f.below ? s.y + s.h : s.y };
    const onSide = { x: f.right ? s.x + s.w : s.x, y: f.vy };
    return startsOnTopOrBottom(f) ? [onTopOrBottom, ...loopCorners(f), onSide] : [onSide, ...loopCorners(f), onTopOrBottom];
  }

  /**
   * Drags corner `index` (in drawing order) of a state's self-transition loop to `q`. The far
   * corner resizes the loop and moves it to the state's corner in its quadrant; each other corner
   * moves its leg and slides the leg's end along the state's edge. The loop then keeps its three
   * corners as bend points.
   */
  function moveLoopCorner(t, s, index, q) {
    const f = loopFrame(t, s);
    if (index === 1) {
      const right = q.x >= s.x + s.w / 2;
      const below = q.y > s.y + s.h / 2;
      // Moved to another corner of the state, the loop is mirrored.
      if (right !== f.right) f.hx = 2 * s.x + s.w - f.hx;
      if (below !== f.below) f.vy = 2 * s.y + s.h - f.vy;
      Object.assign(f, { right, below, cx: q.x, cy: q.y });
    } else if ((index === 0) === startsOnTopOrBottom(f)) {
      f.hx = q.x;
      f.cy = q.y;
    } else {
      f.cx = q.x;
      f.vy = q.y;
    }
    t.points = loopCorners(clampLoop(f, s));
  }

  function route(t) {
    const s = V.get(t.source);
    const g = V.get(t.target);
    if (!s || !g) return null;
    if (isLoop(t)) return loopRoute(t, s);
    const pts = (t.points || []).map((p) => ({ x: p.x, y: p.y }));
    if (s === g && !pts.length) {
      // Other self transitions: a loop over the top-right corner.
      const gap = Math.max(18, Math.min(30, s.w / 3));
      const a = { x: s.x + s.w * 0.72, y: s.y - gap };
      const b = { x: s.x + s.w + gap, y: s.y - gap };
      const c = { x: s.x + s.w + gap, y: s.y + Math.min(s.h * 0.3, 22) };
      const start = s.type === 'state' ? { x: a.x, y: s.y } : clip(s, a);
      const end = s.type === 'state' ? { x: s.x + s.w, y: c.y } : clip(s, c);
      return [start, a, b, c, end];
    }
    let start;
    let end;
    if (isInside(g, s.id)) {
      start = borderPoint(s, pts[0] || center(g));
      end = clip(g, pts.length ? pts[pts.length - 1] : start);
    } else if (isInside(s, g.id)) {
      end = borderPoint(g, pts.length ? pts[pts.length - 1] : center(s));
      start = clip(s, pts[0] || end);
    } else {
      start = clip(s, pts[0] || center(g));
      end = clip(g, pts.length ? pts[pts.length - 1] : center(s));
    }
    return [start, ...pts, end];
  }

  function polylineMid(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let half = total / 2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len >= half && len > 0) {
        const k = half / len;
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dx: b.x - a.x, dy: b.y - a.y };
      }
      half -= len;
    }
    return { x: pts[0].x, y: pts[0].y, dx: 1, dy: 0 };
  }

  /** Label position and alignment: beside the middle of the line, above it or to its left. */
  function labelPos(t, pts) {
    const m = polylineMid(pts);
    const off = t.labelOffset || { x: 0, y: 0 };
    const len = Math.hypot(m.dx, m.dy) || 1;
    let nx = -m.dy / len;
    let ny = m.dx / len;
    if (ny > 0.2 || (Math.abs(ny) <= 0.2 && nx > 0)) {
      nx = -nx;
      ny = -ny;
    }
    const anchor = nx < -0.5 ? 'end' : nx > 0.5 ? 'start' : 'middle';
    return { x: m.x + nx * 6 + off.x, y: m.y + ny * 6 + off.y + (ny < -0.5 ? -2 : 4), anchor, up: ny < -0.5 };
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // ---------------------------------------------------------------- rendering
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const n1 = (n) => Math.round(n * 10) / 10;

  function issueClass(id) {
    const list = issuesById.get(id);
    if (!list) return '';
    if (list.some((i) => i.severity === 'error')) return 'has-error';
    if (list.some((i) => i.severity === 'warning')) return 'has-warning';
    return '';
  }

  /**
   * Classes of the Trace Player's highlight: active state, taken transition or pseudostate on their way, current
   * element, and the color of the (first) instance it is highlighted for when the machine has several.
   */
  function traceClasses(id) {
    if (!trace) return [];
    const out = [];
    const active = trace.active.get(id);
    const taken = trace.taken.get(id);
    if (active) out.push('trace-active');
    if (taken) out.push('trace-taken');
    if (trace.current.has(id)) out.push('trace-current');
    const color = (active || taken || [-1])[0];
    if (color >= 0) out.push(`trace-c${color % TRACE_COLORS}`);
    return out;
  }

  /** A dot per instance in the color of each, above the top right corner of a state active in several instances. */
  function traceDots(v) {
    const colors = trace && trace.active.get(v.id);
    if (!colors || colors.length < 2) return '';
    return colors.map((c, i) => `<circle class="trace-dot trace-c${c % TRACE_COLORS}" cx="${n1(v.x + v.w - 6 - (colors.length - 1 - i) * 11)}" cy="${n1(v.y - 7)}" r="4"/>`).join('');
  }

  function textLine(x, y, cls, text, anchor = 'middle', color = null) {
    return `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" text-anchor="${anchor}"${styleAttr(color && `fill:${color}`)}>${esc(text)}</text>`;
  }

  let measureCtx;
  /** Width of comment text, in the font of `.v-comment text`. */
  function commentTextWidth(text) {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = '11px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif';
    }
    return measureCtx.measureText(text).width;
  }

  /** Splits a comment's text into the lines drawn in its box, wrapping at spaces (or inside words too long for a line). */
  function commentLines(text, width) {
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.replace(/\r$/, '').split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (!line || commentTextWidth(candidate) <= width) {
          line = candidate;
        } else {
          lines.push(line);
          line = word;
        }
        while (line.length > 1 && commentTextWidth(line) > width) {
          let k = line.length - 1;
          while (k > 1 && commentTextWidth(line.slice(0, k)) > width) k--;
          lines.push(line.slice(0, k));
          line = line.slice(k);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function renderVertex(v, exporting) {
    const cls = ['vertex', `v-${v.type}`];
    if (!exporting) {
      if (selection.has(v.id)) cls.push('selected');
      const ic = issueClass(v.id);
      if (ic) cls.push(ic);
      if (drag && drag.dropState === v.id) cls.push('drop-target');
      cls.push(...traceClasses(v.id));
    }
    let s = `<g class="${cls.join(' ')}" data-id="${esc(v.id)}">`;
    const { x, y, w, h } = v;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    // The element's color; selection and problem highlights keep their own outline.
    const c = colorOf(v.color);
    const oc = c && cls.length === 2 ? c : null;
    const shapeSt = styleAttr(c && `fill:${tint(c, exporting)}`, oc && `stroke:${oc}`);
    const fillSt = styleAttr(oc && `fill:${oc}`);
    const strokeSt = (width) => styleAttr(oc && `stroke:${oc}`, width && `stroke-width:${width}`);
    const sepSt = styleAttr(c && `stroke:${c}`);
    switch (v.type) {
      case 'state': {
        const lines = activityRows(v);
        const regions = regionRects(v);
        let st = shapeSt;
        if (regions.length) {
          // Composite state: its color tints the header, its background color the regions.
          const base = exporting ? EXPORT_FILL : 'var(--fsm-state)';
          const bg = backgroundOf(v);
          const head = c ? tint(c, exporting) : base;
          const body = bg ? tint(bg, exporting) : base;
          if (head !== body) {
            const id = `fsm-fill-${++fillSeq}`;
            const at = Math.round(((regions[0].y - y) / h) * 10000) / 10000;
            s += `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
              + `<stop offset="${at}" style="stop-color:${head}"/><stop offset="${at}" style="stop-color:${body}"/></linearGradient></defs>`;
            st = styleAttr(`fill:url(#${id})`, oc && `stroke:${oc}`);
          }
        }
        s += `<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"${st}/>`;
        const title = v.name + (v.submachine ? ` : ${machineLabel(v.submachine)}` : '');
        const centered = !regions.length && !lines.length;
        let ty = y + 16;
        if (v.stereotype) {
          s += textLine(cx, y + (centered ? h / 2 - 4 : 13), 'stereo', `«${v.stereotype}»`, 'middle', c);
          ty += 12;
        }
        if (centered) {
          s += textLine(cx, y + h / 2 + (v.stereotype ? 10 : 4), 'name', title, 'middle', c);
        } else {
          s += textLine(cx, ty, 'name', title, 'middle', c);
          let ly = y + NAME_H + (v.stereotype ? 12 : 0);
          if (lines.length) {
            s += `<line class="sep" x1="${x}" y1="${ly}" x2="${x + w}" y2="${ly}"${sepSt}/>`;
            for (const l of lines) {
              ly += LINE_H;
              s += textLine(x + 8, ly, 'activity', l.text, 'start', l.color);
            }
          }
        }
        if (regions.length) {
          const top = regions[0].y;
          s += `<line class="sep" x1="${x}" y1="${n1(top)}" x2="${x + w}" y2="${n1(top)}"${sepSt}/>`;
          regions.forEach((rr, i) => {
            if (i > 0) {
              s += v.regionLayout === 'horizontal'
                ? `<line class="sep dashed" x1="${n1(rr.x)}" y1="${n1(rr.y)}" x2="${n1(rr.x)}" y2="${n1(rr.y + rr.h)}"${sepSt}/>`
                : `<line class="sep dashed" x1="${n1(rr.x)}" y1="${n1(rr.y)}" x2="${n1(rr.x + rr.w)}" y2="${n1(rr.y)}"${sepSt}/>`;
            }
            if (rr.name) s += textLine(rr.x + 6, rr.y + 12, 'region-name', rr.name, 'start', c);
            if (!exporting && drag && drag.dropRegion === rr.id) {
              s += `<rect class="drop-region" x="${n1(rr.x)}" y="${n1(rr.y)}" width="${n1(rr.w)}" height="${n1(rr.h)}"/>`;
            }
          });
        }
        if (v.submachine) {
          const gx = x + w - 26;
          const gy = y + h - 14;
          const glyphSt = styleAttr(c && `stroke:${c}`, 'stroke-width:1.2');
          s += `<rect class="stroke" x="${gx}" y="${gy}" width="8" height="6" rx="2"${glyphSt}/>`;
          s += `<rect class="stroke" x="${gx + 13}" y="${gy}" width="8" height="6" rx="2"${glyphSt}/>`;
          s += `<line class="stroke" x1="${gx + 8}" y1="${gy + 3}" x2="${gx + 13}" y2="${gy + 3}"${glyphSt}/>`;
        }
        if (v.invariant) s += textLine(x + 4, y + h + 14, 'invariant', `{${v.invariant}}`, 'start', itemColor(v, 'invariant'));
        break;
      }
      case 'final':
        s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"${shapeSt}/><circle class="fill" cx="${cx}" cy="${cy}" r="${Math.max(2, r - 5)}"${fillSt}/>`;
        break;
      case 'initial':
      case 'junction':
        s += `<circle class="fill" cx="${cx}" cy="${cy}" r="${r}"${fillSt}/>`;
        break;
      case 'shallowHistory':
      case 'deepHistory':
        s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"${shapeSt}/>`;
        s += textLine(cx, cy + 4, 'glyph', v.type === 'deepHistory' ? 'H*' : 'H', 'middle', c);
        break;
      case 'choice':
        s += `<path class="shape" d="M${cx},${y} L${x + w},${cy} L${cx},${y + h} L${x},${cy} Z"${shapeSt}/>`;
        break;
      case 'fork':
      case 'join':
        s += `<rect class="fill" x="${x}" y="${y}" width="${w}" height="${h}" rx="1"${fillSt}/>`;
        break;
      case 'connectionPointRef':
      case 'entryPoint':
        if (v.type === 'connectionPointRef' && refKind(v) === 'exit') {
          const k = r * 0.62;
          s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"${shapeSt}/>`;
          s += `<path class="stroke" d="M${cx - k},${cy - k} L${cx + k},${cy + k} M${cx + k},${cy - k} L${cx - k},${cy + k}"${strokeSt(1.3)}/>`;
        } else {
          s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"${shapeSt}/>`;
        }
        break;
      case 'exitPoint': {
        const k = r * 0.62;
        s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"${shapeSt}/>`;
        s += `<path class="stroke" d="M${cx - k},${cy - k} L${cx + k},${cy + k} M${cx + k},${cy - k} L${cx - k},${cy + k}"${strokeSt(1.3)}/>`;
        break;
      }
      case 'terminate':
        s += `<rect class="hit" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
        s += `<path class="stroke" d="M${x},${y} L${x + w},${y + h} M${x + w},${y} L${x},${y + h}"${strokeSt(2)}/>`;
        break;
      case 'comment': {
        const f = 12;
        s += `<path class="shape" d="M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + h} H${x} Z"${shapeSt}/>`;
        s += `<path class="stroke" d="M${x + w - f},${y} V${y + f} H${x + w}"${strokeSt(1)}/>`;
        const lines = commentLines(String(v.text ?? ''), w - 16);
        lines.forEach((l, i) => {
          if (16 + i * 14 < h) s += textLine(x + 8, y + 17 + i * 14, '', l, 'start', c);
        });
        break;
      }
    }
    const caption = v.type === 'connectionPointRef' ? pointName(V.get(v.parent), v.ref) || '?' : v.name;
    if (caption && v.type !== 'state' && v.type !== 'comment') {
      const below = v.type === 'fork' || v.type === 'join' ? y + h + 13 : y + h + 12;
      s += textLine(cx, below, 'activity', caption, 'middle', c);
    }
    if (!exporting && Math.min(w, h) < 20 && v.type !== 'fork' && v.type !== 'join') {
      s += `<rect class="hit" x="${cx - 11}" y="${cy - 11}" width="22" height="22"/>`;
    } else if (!exporting && (v.type === 'fork' || v.type === 'join') && Math.min(w, h) < 14) {
      s += `<rect class="hit" x="${x - 4}" y="${y - 5}" width="${w + 8}" height="${h + 10}"/>`;
    }
    if (!exporting) s += traceDots(v);
    return s + '</g>';
  }

  function arrowHead(a, b) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const L = 10;
    const W = 0.42;
    const p1 = { x: b.x - L * Math.cos(ang - W), y: b.y - L * Math.sin(ang - W) };
    const p2 = { x: b.x - L * Math.cos(ang + W), y: b.y - L * Math.sin(ang + W) };
    return `M${n1(p1.x)},${n1(p1.y)} L${n1(b.x)},${n1(b.y)} L${n1(p2.x)},${n1(p2.y)}`;
  }

  function renderTransition(t, exporting) {
    if (t.kind === 'internal' && t.source === t.target && V.get(t.source)?.type === 'state') return '';
    const pts = route(t);
    if (!pts) return '';
    const d = 'M' + pts.map((p) => `${n1(p.x)},${n1(p.y)}`).join(' L');
    const cls = ['transition'];
    if (!exporting) {
      if (selection.has(t.id)) cls.push('selected');
      const ic = issueClass(t.id);
      if (ic) cls.push(ic);
      cls.push(...traceClasses(t.id));
    }
    let s = `<g class="${cls.join(' ')}" data-id="${esc(t.id)}">`;
    // Selection and problem highlights keep their own line color.
    const oc = cls.length === 1 ? colorOf(t.color) : null;
    const lineSt = styleAttr(oc && `stroke:${oc}`);
    if (!exporting) s += `<path class="hit" d="${d}"/>`;
    s += `<path class="line" d="${d}"${lineSt}/>`;
    s += `<path class="arrow" d="${arrowHead(pts[pts.length - 2], pts[pts.length - 1])}"${lineSt}/>`;
    const lines = transitionLabelItems(t);
    if (lines.length) {
      const lp = labelPos(t, pts);
      const y0 = lp.y - (lp.up ? (lines.length - 1) * LABEL_LINE_HEIGHT : 0);
      const spans = lines.map((l, i) => {
        const lc = itemColor(t, l.key);
        return `<tspan x="${n1(lp.x)}" dy="${i ? LABEL_LINE_HEIGHT : 0}"${styleAttr(lc && `fill:${lc}`)}>${esc(l.text)}</tspan>`;
      }).join('');
      s += `<text class="tlabel" data-label="${esc(t.id)}" x="${n1(lp.x)}" y="${n1(y0)}" text-anchor="${lp.anchor}">${spans}</text>`;
    }
    if (!exporting && selection.has(t.id) && selection.size === 1) {
      const loop = isLoop(t);
      (loop ? loopCorners(loopFrame(t, V.get(t.source))) : t.points || []).forEach((p, i) => {
        s += `<circle class="wp" data-wp="${esc(t.id)}:${i}" cx="${p.x}" cy="${p.y}" r="4.5"/>`;
      });
      // Its ends: dragged onto another element, they reconnect it.
      if (!(drag && drag.kind === 'reconnect' && drag.t === t)) {
        for (const [end, p] of [['source', pts[0]], ['target', pts[pts.length - 1]]]) {
          s += `<circle class="tend" data-end="${esc(t.id)}:${end}" cx="${n1(p.x)}" cy="${n1(p.y)}" r="4.5"/>`;
        }
      }
    }
    return s + '</g>';
  }

  function renderAnchors(v) {
    let s = '';
    for (const a of v.anchors || []) {
      const target = V.get(a);
      let p = null;
      if (target) p = center(target);
      else if (T.has(a)) {
        const pts = route(T.get(a));
        if (pts) p = polylineMid(pts);
      }
      if (!p) continue;
      const from = clip(v, p);
      const to = target ? clip(target, from) : p;
      s += `<line class="anchor" x1="${n1(from.x)}" y1="${n1(from.y)}" x2="${n1(to.x)}" y2="${n1(to.y)}"/>`;
    }
    return s;
  }

  const RESIZABLE = new Set(['state', 'comment', 'fork', 'join']);

  function renderOverlay() {
    let s = '';
    // The lines between regions: dragged, they resize the region before them.
    for (const v of model.vertices) {
      const rects = regionRects(v);
      for (let i = 0; i < rects.length - 1; i++) {
        const r = rects[i];
        const handle = `sep:${esc(v.id)}:${i}`;
        s += v.regionLayout === 'horizontal'
          ? `<rect class="region-sep sep-x" data-handle="${handle}" x="${n1(r.x + r.w - 3)}" y="${n1(r.y)}" width="6" height="${n1(r.h)}"/>`
          : `<rect class="region-sep sep-y" data-handle="${handle}" x="${n1(r.x)}" y="${n1(r.y + r.h - 3)}" width="${n1(r.w)}" height="6"/>`;
      }
    }
    const sel = [...selection].map((id) => V.get(id)).filter(Boolean);
    for (const v of sel) {
      s += `<rect class="sel-box" x="${v.x - 4}" y="${v.y - 4}" width="${v.w + 8}" height="${v.h + 8}" rx="3"/>`;
    }
    // The groups of the selected elements: a dotted rectangle around their members.
    for (const g of new Set(sel.map((v) => v.group).filter(Boolean))) {
      const b = unionBox(groupMembers(g));
      if (b) s += `<rect class="group-box" x="${n1(b.x - 10)}" y="${n1(b.y - 10)}" width="${n1(b.w + 20)}" height="${n1(b.h + 20)}" rx="4"/>`;
    }
    if (sel.length === 1 && selection.size === 1) {
      const v = sel[0];
      if (RESIZABLE.has(v.type)) {
        for (const c of ['nw', 'ne', 'sw', 'se']) {
          const hx = c.includes('w') ? v.x - 8 : v.x + v.w - 1;
          const hy = c.includes('n') ? v.y - 8 : v.y + v.h - 1;
          s += `<rect class="handle handle-${c}" data-handle="resize-${c}" x="${hx}" y="${hy}" width="9" height="9" rx="1.5"/>`;
        }
      }
      if (v.type !== 'final' && v.type !== 'terminate') {
        const hx = v.x + v.w + 18;
        const hy = v.y + v.h / 2;
        s += `<circle class="connect-handle" data-handle="connect" cx="${hx}" cy="${hy}" r="7"><title>Drag to connect</title></circle>`;
        s += `<path class="connect-handle-arrow" d="M${hx - 3},${hy} H${hx + 3} M${hx + 0.5},${hy - 2.5} L${hx + 3},${hy} L${hx + 0.5},${hy + 2.5}"/>`;
      }
    }
    if (drag && drag.kind === 'connect' && drag.cur) {
      const target = drag.hover && V.get(drag.hover);
      const from = clip(drag.source, target ? center(target) : drag.cur);
      const to = target ? clip(target, from) : drag.cur;
      s += `<line class="rubber" x1="${n1(from.x)}" y1="${n1(from.y)}" x2="${n1(to.x)}" y2="${n1(to.y)}"/>`;
    }
    if (drag && drag.kind === 'reconnect') {
      // From the bend point next to the dragged end, or from the element at the other end.
      const t = drag.t;
      const pts = t.points && t.points.length && !isLoop(t) ? t.points : [];
      const target = drag.hover && V.get(drag.hover);
      const toward = target ? center(target) : drag.cur;
      const near = drag.end === 'source' ? pts[0] : pts[pts.length - 1];
      const fixed = V.get(drag.end === 'source' ? t.target : t.source);
      const from = near || (fixed ? clip(fixed, toward) : toward);
      const to = target ? clip(target, from) : drag.cur;
      s += `<line class="rubber" x1="${n1(from.x)}" y1="${n1(from.y)}" x2="${n1(to.x)}" y2="${n1(to.y)}"/>`;
    }
    if (drag && drag.kind === 'band' && drag.cur) {
      const r = normRect(drag.start, drag.cur);
      s += `<rect class="band" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;
    }
    return s;
  }

  function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function sortedVertices() {
    return model.vertices
      .map((v, i) => ({ v, i, d: depth(v) + (isCP(v) ? 0.5 : 0) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((o) => o.v);
  }

  /** Numbers the fill gradients of composite states within one scene. */
  let fillSeq = 0;
  function scene(exporting) {
    fillSeq = 0;
    const parts = [];
    const sorted = sortedVertices();
    for (const v of sorted) parts.push(renderVertex(v, exporting));
    for (const v of sorted) if (v.type === 'comment') parts.push(renderAnchors(v));
    for (const t of model.transitions) parts.push(renderTransition(t, exporting));
    return parts.join('');
  }

  let frame = 0;
  function render() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!model) {
      world.innerHTML = '';
      return;
    }
    reindex();
    indexIssues();
    world.setAttribute('transform', `translate(${n1(view.x)},${n1(view.y)}) scale(${view.zoom})`);
    world.innerHTML = scene(false) + renderOverlay();
    const g = GRID * 2 * view.zoom;
    wrap.style.backgroundSize = `${g}px ${g}px`;
    wrap.style.backgroundPosition = `${view.x % g}px ${view.y % g}px`;
    svg.classList.toggle('tool-armed', !!tool);
    renderToolbarState();
    renderStatus();
  }
  function indexIssues() {
    allIssues = [...issues, ...overlapIssues()];
    issuesById = new Map();
    for (const i of allIssues) {
      const l = issuesById.get(i.id) || [];
      l.push(i);
      issuesById.set(i.id, l);
    }
  }
  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  // ---------------------------------------------------------------- persistence
  function commit(opts = {}) {
    // The document can't be read: writing the model shown before would replace the text being fixed.
    if (!parseErrorEl.hidden) return;
    reindex();
    cleanGroups();
    keepHeaders();
    const text = JSON.stringify(model, null, 2) + '\n';
    lastText = text;
    vscode.postMessage({ type: 'edit', text });
    render();
    if (opts.props) renderProps();
  }

  function saveView() {
    vscode.setState({ ...(vscode.getState() || {}), view });
  }

  function normalizeColors(e) {
    if (!isColor(e.color)) delete e.color;
    if (e.itemColors && typeof e.itemColors === 'object') {
      for (const k of Object.keys(e.itemColors)) if (!isColor(e.itemColors[k])) delete e.itemColors[k];
      if (!Object.keys(e.itemColors).length) delete e.itemColors;
    } else delete e.itemColors;
  }

  function normalize(m) {
    m.regions = Array.isArray(m.regions) && m.regions.length ? m.regions : [{ id: 'r_root', name: '' }];
    m.vertices = Array.isArray(m.vertices) ? m.vertices : [];
    m.transitions = Array.isArray(m.transitions) ? m.transitions : [];
    m.kind = m.kind === 'protocol' ? 'protocol' : 'behavioral';
    delete m.extends; // state machine extension (inheritance) is not supported
    for (const v of m.vertices) {
      v.name = v.name ?? '';
      v.regions = v.regions ?? [];
      v.w = Number(v.w) || 40;
      v.h = Number(v.h) || 40;
      v.x = Number(v.x) || 0;
      v.y = Number(v.y) || 0;
      normalizeColors(v);
    }
    for (const t of m.transitions) {
      t.triggers = t.triggers ?? [];
      t.guard = t.guard ?? '';
      t.effect = t.effect ?? '';
      t.kind = t.kind ?? 'external';
      normalizeColors(t);
    }
    return m;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'panels') {
      panels = msg.panels;
      renderPanels();
    } else if (msg.type === 'update') {
      issues = msg.issues || [];
      submachines = msg.submachines || {};
      machines = msg.machines || [];
      if (msg.error) {
        // Reloaded once readable again, even as the same text: what was changed meanwhile wasn't written.
        lastText = null;
        showParseError(msg.error);
        return;
      }
      parseErrorEl.hidden = true;
      if (msg.text !== lastText) {
        lastText = msg.text;
        try {
          model = normalize(JSON.parse(msg.text));
        } catch (err) {
          showParseError(String(err));
          return;
        }
        reindex();
        resetHeaders();
        indexIssues();
        selection = new Set([...selection].filter((id) => V.has(id) || T.has(id)));
        if (firstLoad) {
          firstLoad = false;
          requestAnimationFrame(() => fit());
        }
        renderProps();
      } else if (!propsPane.contains(document.activeElement) && !propsPop?.el.contains(document.activeElement) && !colorPop) {
        if (model) {
          reindex();
          indexIssues();
        }
        renderProps();
      }
      render();
      if (!problemsEl.hidden) renderProblems();
    } else if (msg.type === 'clipboard') {
      if (msg.requestId !== clipboard.request) return;
      try {
        const data = JSON.parse(msg.text);
        if (data && data.fsmClipboard && Array.isArray(data.vertices) && data.vertices.length) {
          clipboard.data = data;
          if (clipboard.button) clipboard.button.disabled = false;
        }
      } catch {
        // not state machine elements
      }
    } else if (msg.type === 'extractCheck') {
      if (msg.requestId !== extractCheck.request || !extractCheck.button) return;
      extractCheck.button.disabled = !!msg.problem;
      extractCheck.button.title = msg.problem || '';
    } else if (msg.type === 'trace') {
      const view = msg.highlight;
      if (view && view.instances.length) {
        trace = { instances: view.instances, active: new Map(), taken: new Map(), current: new Set(), event: '' };
        const add = (map, id, color) => (map.get(id) || map.set(id, []).get(id)).push(color);
        for (const inst of view.instances) {
          for (const id of inst.active) add(trace.active, id, inst.color);
          for (const id of [...inst.taken, ...inst.via]) add(trace.taken, id, inst.color);
          for (const id of inst.current) trace.current.add(id);
        }
        // The event of the instance of the current record, else of the first instance that has one.
        const at = view.instances.find((i) => i.current.length) || view.instances.find((i) => i.event);
        trace.event = (at && at.event) || '';
      } else trace = null;
      render();
    } else if (msg.type === 'toast') {
      toast(String(msg.message));
    } else if (msg.type === 'requestSvg') {
      vscode.postMessage({ type: 'svg', requestId: msg.requestId, svg: exportSvg() });
    } else if (msg.type === 'requestPng') {
      exportPng().then(
        (png) => vscode.postMessage({ type: 'png', requestId: msg.requestId, png }),
        (err) => vscode.postMessage({ type: 'png', requestId: msg.requestId, error: String((err && err.message) || err) }),
      );
    }
  });

  function showParseError(error) {
    parseErrorEl.hidden = false;
    parseErrorEl.innerHTML = '';
    const h = document.createElement('div');
    h.textContent = 'This file cannot be displayed because it is not a readable UML state machine (XMI):';
    const c = document.createElement('code');
    c.textContent = error;
    const b = document.createElement('button');
    b.className = 'pbtn primary';
    b.textContent = 'Open as Text';
    b.onclick = () => vscode.postMessage({ type: 'command', command: 'fsmEditor.openAsText' });
    parseErrorEl.append(h, c, b);
  }

  // ---------------------------------------------------------------- export
  const EXPORT_CSS = `
text{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;fill:#1f1f1f;font-size:12px}
.shape{fill:#fdfdfd;stroke:#333;stroke-width:1.4}
.fill{fill:#333}
.stroke{fill:none;stroke:#333;stroke-width:1.6}
.sep{stroke:#333;stroke-width:1;opacity:.8}
.sep.dashed{stroke-dasharray:7 4}
.name{font-weight:600}
.activity,.tlabel{font-size:11px}
.stereo,.region-name{font-size:10px;font-style:italic;opacity:.8}
.invariant{font-size:11px;font-style:italic}
.glyph{font-size:11px;font-weight:700}
.v-comment .shape{fill:#fbf3cf}
.v-comment text{font-size:11px}
.hit{fill:transparent}
.anchor{fill:none;stroke:#333;stroke-width:1;stroke-dasharray:4 3;opacity:.7}
.line,.arrow{fill:none;stroke:#333;stroke-width:1.3;stroke-linejoin:round}
.tlabel{paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round}`;

  function contentBounds() {
    if (!model.vertices.length) return { x: 0, y: 0, w: 400, h: 300 };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const addP = (x, y) => {
      x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
    };
    for (const v of model.vertices) {
      addP(v.x, v.y);
      addP(v.x + v.w, v.y + v.h + (v.invariant || (v.name && v.type !== 'state') ? 16 : 0));
    }
    for (const t of model.transitions) {
      const pts = route(t);
      if (!pts) continue;
      for (const p of pts) addP(p.x, p.y);
      const lines = transitionLabelLines(t);
      if (lines.length) {
        const lp = labelPos(t, pts);
        const w = Math.max(...lines.map((l) => l.length)) * 6.6;
        const x0 = lp.anchor === 'end' ? lp.x - w : lp.anchor === 'start' ? lp.x : lp.x - w / 2;
        const y0 = lp.y - (lp.up ? (lines.length - 1) * LABEL_LINE_HEIGHT : 0);
        addP(x0, y0 - 12);
        addP(x0 + w, y0 + (lines.length - 1) * LABEL_LINE_HEIGHT + 4);
      }
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function exportSvg() {
    reindex();
    const b = contentBounds();
    const pad = 20;
    const vb = `${n1(b.x - pad)} ${n1(b.y - pad)} ${n1(b.w + pad * 2)} ${n1(b.h + pad * 2)}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.ceil(b.w + pad * 2)}" height="${Math.ceil(b.h + pad * 2)}">
<title>${esc(model.name || 'State machine')}</title>
<style>${EXPORT_CSS}</style>
<rect x="${n1(b.x - pad)}" y="${n1(b.y - pad)}" width="${n1(b.w + pad * 2)}" height="${n1(b.h + pad * 2)}" fill="#fff"/>
${scene(true)}
</svg>
`;
  }

  /** Largest side of a canvas the browser draws reliably. */
  const PNG_MAX_SIDE = 16384;

  /** The SVG export drawn at twice its size (less for a very large diagram), as a base64-encoded PNG. */
  function exportPng() {
    const svgText = exportSvg();
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 400;
        const h = img.naturalHeight || 300;
        const scale = Math.min(2, PNG_MAX_SIDE / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('No canvas to draw the diagram on.'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));
      };
      img.onerror = () => reject(new Error('The diagram could not be drawn as an image.'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    });
  }

  // ---------------------------------------------------------------- view
  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.zoom, y: (e.clientY - r.top - view.y) / view.zoom };
  }

  function zoomAt(factor, sx, sy) {
    const z = clamp(view.zoom * factor, 0.15, 4);
    const k = z / view.zoom;
    view.x = sx - (sx - view.x) * k;
    view.y = sy - (sy - view.y) * k;
    view.zoom = z;
    saveView();
    render();
  }
  function zoomCenter(factor) {
    const r = svg.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  }

  function fit() {
    if (!model) return;
    reindex();
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const b = contentBounds();
    const pad = 40;
    const z = clamp(Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1)), 0.2, 1.5);
    view.zoom = z;
    view.x = (r.width - b.w * z) / 2 - b.x * z;
    view.y = (r.height - b.h * z) / 2 - b.y * z;
    saveView();
    render();
  }

  function reveal(id) {
    const v = V.get(id);
    let p = v ? center(v) : null;
    if (!p && T.has(id)) {
      const pts = route(T.get(id));
      if (pts) p = polylineMid(pts);
    }
    if (!p) return;
    const r = svg.getBoundingClientRect();
    view.x = r.width / 2 - p.x * view.zoom;
    view.y = r.height / 2 - p.y * view.zoom;
    saveView();
  }

  // ---------------------------------------------------------------- tools
  function setTool(id, sticky = false) {
    tool = id && tool === id && !sticky ? null : id;
    toolSticky = !!tool && sticky;
    for (const el of toolboxEl.querySelectorAll('.tb-item')) {
      el.classList.toggle('active', el.getAttribute('data-tool') === tool);
    }
    render();
    if (tool) {
      const t = TOOL_BY_ID.get(tool);
      if (tool === 'transition') toast('Drag from a source to a target. Esc to cancel.');
      else if (tool === 'region') toast('Click a state to add a region to it.');
      else if (t && (tool === 'entryPoint' || tool === 'exitPoint')) toast(`Click a state's border, or empty canvas for a connection point of the state machine itself.`);
      else if (tool === 'connectionPointRef') toast('Click the border of a submachine state.');
    }
  }
  function toolDone() {
    if (!toolSticky) setTool(null);
  }

  function createVertex(toolId, p) {
    const def = TOOL_BY_ID.get(toolId);
    if (!def || !def.create) return;
    reindex();
    const v = Object.assign({ id: uid('v'), name: '', parent: '', x: 0, y: 0 }, def.create());
    if (isPointType(v.type)) {
      const s = stateAt(p, new Set());
      if (s && s.submachine && v.type !== 'connectionPointRef') {
        // On a submachine state, UML uses a reference to the submachine's own entry/exit point.
        const kind = v.type === 'exitPoint' ? 'exit' : 'entry';
        v.type = 'connectionPointRef';
        v.pointKind = kind;
        v.ref = '';
        toast(`Added a connection point reference: pick the ${kind} point of '${machineLabel(s.submachine)}' it refers to.`);
      }
      if (v.type === 'connectionPointRef') {
        if (!s || !s.submachine) {
          toast('Connection point references go on the border of a submachine state.');
          return;
        }
        const free = freePoints(s);
        const pick = free.find((q) => !v.ref && q.kind === v.pointKind) || free[0];
        if (pick) {
          v.ref = pick.id;
          v.pointKind = pick.kind;
        }
      }
      if (s) {
        v.parent = s.id;
        snapToBorder(v, s, p);
      } else {
        // Not on a state: a connection point of the state machine itself.
        v.parent = rootRegion();
        v.name = uniqueName(v.type === 'entryPoint' ? 'in' : 'out');
        v.x = snap(p.x) - v.w / 2;
        v.y = snap(p.y) - v.h / 2;
      }
    } else {
      v.x = snap(p.x - v.w / 2);
      v.y = snap(p.y - v.h / 2);
      const r = regionAt(p, new Set());
      v.parent = r ? r.id : rootRegion();
    }
    model.vertices.push(v);
    reindex();
    fitInRegion(v, null, false);
    selection = new Set([v.id]);
    commit({ props: true });
    toolDone();
    if (v.type === 'state' || v.type === 'comment') setTimeout(() => startInlineEdit(v.id), 0);
  }

  /** Entry/exit points of a submachine state's referenced machine, as far as the extension could resolve them. */
  function submachinePoints(state) {
    const info = state.submachine ? submachines[state.submachine] : null;
    return info && info.found ? info.points : [];
  }
  function refsOf(state) {
    return model.vertices.filter((v) => v.type === 'connectionPointRef' && v.parent === state.id);
  }
  /** Points of the submachine not yet referenced on `state`. */
  function freePoints(state) {
    const used = new Set(refsOf(state).map((r) => r.ref));
    return submachinePoints(state).filter((q) => !used.has(q.id));
  }

  /** Adds a reference for every unreferenced point: entries on the left border, exits on the right. */
  function addAllReferences(state, only) {
    const free = only ? [only] : freePoints(state);
    if (!free.length) return;
    for (const kind of ['entry', 'exit']) {
      const list = free.filter((q) => q.kind === kind);
      const existing = refsOf(state).filter((r) => refKind(r) === kind).length;
      const total = list.length + existing;
      list.forEach((q, i) => {
        const v = { id: uid('v'), type: 'connectionPointRef', name: '', ref: q.id, pointKind: kind, parent: state.id, x: 0, y: 0, w: 16, h: 16, regions: [] };
        const y = state.y + (state.h * (existing + i + 1)) / (total + 1);
        snapToBorder(v, state, { x: kind === 'entry' ? state.x : state.x + state.w, y });
        model.vertices.push(v);
        V.set(v.id, v);
      });
    }
    // Leave room for the captions under the points.
    const old = boxOf(state);
    state.h = Math.max(state.h, 40 + 24 * Math.max(free.filter((q) => q.kind === 'entry').length, free.filter((q) => q.kind === 'exit').length));
    fitInRegion(state, old, false);
    commit({ props: true });
  }

  function addRegion(state) {
    state.regions = state.regions || [];
    const old = boxOf(state);
    if (!state.regions.length) {
      // Make room for the region below the name compartment.
      state.w = Math.max(state.w, 220);
      state.h = Math.max(state.h, headerHeight(state) + 120);
      state.regions.push({ id: uid('r'), name: '' });
      layoutHeader.set(state.id, headerHeight(state));
    } else {
      // The new region comes after the others, which keep their sizes.
      keepRegionSizes(state);
      const size = state.regionLayout === 'horizontal' ? 160 : 100;
      if (state.regionLayout === 'horizontal') state.w += size;
      else state.h += size;
      state.regions.push({ id: uid('r'), name: '', size });
    }
    reindex();
    followBorder(state, old);
    fitInRegion(state, old, false);
    selection = new Set([state.id]);
    commit({ props: true });
  }

  function removeRegion(state, regionId) {
    const doomed = new Set();
    for (const v of model.vertices) {
      if (v.parent === regionId) {
        doomed.add(v.id);
        for (const d of descendants(v)) doomed.add(d.id);
      }
    }
    const i = state.regions.findIndex((r) => r.id === regionId);
    if (i >= 0 && state.regions.length > 1) {
      // The state shrinks by the region's size, and the later regions move back with their contents.
      const old = boxOf(state);
      keepRegionSizes(state);
      const size = state.regions[i].size;
      const horizontal = state.regionLayout === 'horizontal';
      shiftRegions(state, i + 1, state.regions.length - 1, horizontal ? -size : 0, horizontal ? 0 : -size);
      if (horizontal) state.w -= size;
      else state.h -= size;
      followBorder(state, old);
    }
    state.regions = state.regions.filter((r) => r.id !== regionId);
    removeVertices(doomed);
    commit({ props: true });
  }

  // ---------------------------------------------------------------- layout
  // Elements inside a composite state's region stay inside it: what would leave it grows the region,
  // its state and the states around it in turn, and moving back during the same drag undoes that.

  /** Space kept between a region's border and the elements in it. */
  const FIT_MARGIN = 10;
  /** Smallest extent of a region along its state's region layout. */
  const MIN_REGION = 40;
  /**
   * Header height each composite state's regions were laid out for (by state id): when its internal
   * activities change it, the state grows or shrinks by the difference and its regions' contents move
   * with them. Reset whenever the model comes from the document.
   */
  let layoutHeader = new Map();

  const boxOf = (v) => ({ x: v.x, y: v.y, w: v.w, h: v.h });

  /** Records the current header height of every composite state. */
  function resetHeaders() {
    layoutHeader = new Map();
    for (const v of model.vertices) if ((v.regions || []).length) layoutHeader.set(v.id, headerHeight(v));
  }

  /** Geometry of every element (with region sizes and bend points), for `restoreLayout`. */
  function layoutSnapshot() {
    return {
      vertices: model.vertices.map((v) => ({ v, box: boxOf(v), sizes: (v.regions || []).map((r) => r.size) })),
      points: model.transitions.map((t) => ({ t, points: t.points && t.points.map((q) => ({ ...q })) })),
      headers: new Map(layoutHeader),
    };
  }
  function restoreLayout(snap) {
    for (const { v, box, sizes } of snap.vertices) {
      Object.assign(v, box);
      (v.regions || []).forEach((r, i) => {
        if (sizes[i] === undefined) delete r.size;
        else r.size = sizes[i];
      });
    }
    for (const { t, points } of snap.points) {
      if (points) t.points = points.map((q) => ({ ...q }));
      else delete t.points;
    }
    layoutHeader = new Map(snap.headers);
  }

  /** The vertices in region `id`, at any depth. */
  function regionContents(id) {
    const ids = new Set();
    for (const v of model.vertices) {
      if (v.parent !== id) continue;
      ids.add(v.id);
      for (const d of descendants(v)) ids.add(d.id);
    }
    return ids;
  }

  /** Bounding box of the vertices directly in region `id`, or null when it is empty. */
  function contentsBox(id) {
    const kids = model.vertices.filter((v) => v.parent === id);
    if (!kids.length) return null;
    const x = Math.min(...kids.map((v) => v.x));
    const y = Math.min(...kids.map((v) => v.y));
    return { x, y, right: Math.max(...kids.map((v) => v.x + v.w)), bottom: Math.max(...kids.map((v) => v.y + v.h)) };
  }

  /** Moves the vertices `ids` by `dx`, `dy`, with the bend points of the transitions between them. */
  function shiftVertices(ids, dx, dy) {
    if ((!dx && !dy) || !ids.size) return;
    for (const v of model.vertices) {
      if (!ids.has(v.id)) continue;
      v.x += dx;
      v.y += dy;
    }
    for (const t of model.transitions) {
      if (t.points && t.points.length && ids.has(t.source) && ids.has(t.target)) t.points = t.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    }
  }

  /** Moves the contents of `s`'s regions `from`..`to` (inclusive) by `dx`, `dy`. */
  function shiftRegions(s, from, to, dx, dy) {
    const ids = new Set();
    s.regions.forEach((r, i) => {
      if (i >= from && i <= to) for (const id of regionContents(r.id)) ids.add(id);
    });
    shiftVertices(ids, dx, dy);
  }

  /** Keeps the points on the border of `s` on the edge they were on when its box was `old`. */
  function followBorder(s, old) {
    for (const cp of model.vertices) {
      if (cp.parent !== s.id || !isCP(cp)) continue;
      const c = center(cp);
      const d = [Math.abs(c.x - old.x), Math.abs(old.x + old.w - c.x), Math.abs(c.y - old.y), Math.abs(old.y + old.h - c.y)];
      const m = Math.min(...d);
      const p = m === d[0] ? { x: s.x, y: c.y } : m === d[1] ? { x: s.x + s.w, y: c.y } : m === d[2] ? { x: c.x, y: s.y } : { x: c.x, y: s.y + s.h };
      snapToBorder(cp, s, p);
    }
  }

  /** Stores the drawn size of each of `s`'s regions, so that they can change one by one. */
  function keepRegionSizes(s) {
    const horizontal = s.regionLayout === 'horizontal';
    regionRects(s).forEach((r, i) => {
      s.regions[i].size = horizontal ? r.w : r.h;
    });
  }

  /**
   * Changes the size of region `i` of `s` by `d` at its far end (bottom, or right side by side): the
   * state changes with it and the later regions move with their contents.
   */
  function resizeRegionEnd(s, i, d) {
    if (!d) return;
    keepRegionSizes(s);
    s.regions[i].size += d;
    if (s.regionLayout === 'horizontal') {
      s.w += d;
      shiftRegions(s, i + 1, s.regions.length - 1, d, 0);
    } else {
      s.h += d;
      shiftRegions(s, i + 1, s.regions.length - 1, 0, d);
    }
  }

  /**
   * Grows region `i` of `s` by `d` = { l, r, t, b } (each >= 0) on its sides: the state grows on the
   * same sides, and what lies beyond the region in its state moves with that side.
   */
  function growRegion(s, i, d) {
    const old = boxOf(s);
    keepRegionSizes(s);
    if (s.regionLayout === 'horizontal') {
      s.y -= d.t;
      s.h += d.t + d.b;
      if (d.l) {
        s.x -= d.l;
        s.w += d.l;
        s.regions[i].size += d.l;
        shiftRegions(s, 0, i - 1, -d.l, 0);
      }
      resizeRegionEnd(s, i, d.r);
    } else {
      s.x -= d.l;
      s.w += d.l + d.r;
      if (d.t) {
        s.y -= d.t;
        s.h += d.t;
        s.regions[i].size += d.t;
        shiftRegions(s, 0, i - 1, 0, -d.t);
      }
      resizeRegionEnd(s, i, d.b);
    }
    followBorder(s, old);
    keepHeader(s);
  }

  /**
   * After a change of `s`'s header height (its internal activities, or its width rewrapping them),
   * moves its bottom edge by the difference: its regions keep their sizes and their contents move
   * with them. Returns whether it changed.
   */
  function keepHeader(s) {
    if (!(s.regions || []).length) return false;
    const h = headerHeight(s);
    const before = layoutHeader.get(s.id);
    layoutHeader.set(s.id, h);
    if (before === undefined || before === h) return false;
    const old = boxOf(s);
    s.h += h - before;
    shiftRegions(s, 0, s.regions.length - 1, 0, h - before);
    followBorder(s, old);
    return true;
  }

  /** `keepHeader` for every composite state, growing the states around those that grew. */
  function keepHeaders() {
    for (const s of model.vertices.filter((v) => (v.regions || []).length).sort((a, b) => depth(b) - depth(a))) {
      const old = boxOf(s);
      if (keepHeader(s)) fitInRegion(s, old, false);
    }
  }

  /**
   * Grows the region holding `v` (with its state, and the states around it in turn) so that `v` lies
   * inside it with the margin. `old` is `v`'s box before the change, or null for a new element: where it
   * already came closer to the region's border, that smaller gap is kept. The growth is a multiple of
   * the grid unless `exact`.
   */
  function fitInRegion(v, old, exact) {
    if (isCP(v)) return;
    const s = regionOwner.get(v.parent);
    // A state in its own regions (a region id used twice in a file edited by hand) would grow forever.
    if (!s || s === v || isInside(s, v.id)) return;
    const i = s.regions.findIndex((r) => r.id === v.parent);
    const R = regionRects(s)[i];
    const gap = (g) => (old ? Math.min(FIT_MARGIN, g) : FIT_MARGIN);
    const gl = gap(old ? old.x - R.x : 0);
    const gr = gap(old ? R.x + R.w - old.x - old.w : 0);
    const gt = gap(old ? old.y - R.y : 0);
    const gb = gap(old ? R.y + R.h - old.y - old.h : 0);
    const up = (n) => (n <= 1e-6 ? 0 : exact ? n : Math.ceil(n / GRID - 1e-6) * GRID);
    const d = {
      l: up(R.x + gl - v.x),
      r: up(v.x + v.w + gr - R.x - R.w),
      t: up(R.y + gt - v.y),
      b: up(v.y + v.h + gb - R.y - R.h),
    };
    if (!d.l && !d.r && !d.t && !d.b) return;
    const before = boxOf(s);
    growRegion(s, i, d);
    fitInRegion(s, before, exact);
  }

  /**
   * How far each edge of composite state `s` can move inward without leaving any of its contents
   * outside their region: the largest left and top, the smallest right and bottom. A gap already
   * smaller than the margin is kept, and each region keeps at least MIN_REGION.
   */
  function resizeLimits(s) {
    const rects = regionRects(s);
    const n = rects.length;
    const boxes = rects.map((r) => contentsBox(r.id));
    const all = boxes.filter(Boolean);
    const union = all.length
      ? { x: Math.min(...all.map((b) => b.x)), y: Math.min(...all.map((b) => b.y)), right: Math.max(...all.map((b) => b.right)), bottom: Math.max(...all.map((b) => b.bottom)) }
      : null;
    // The edge at `edge` may come up to `content` minus the margin, or stay where it is when already closer.
    const lo = (content, edge) => Math.max(content - FIT_MARGIN, Math.min(edge, content));
    const hi = (content, edge) => Math.min(content + FIT_MARGIN, Math.max(edge, content));
    const first = rects[0];
    const last = rects[n - 1];
    const header = first.y - s.y;
    const lim = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    if (s.regionLayout === 'horizontal') {
      lim.left = first.x + first.w - MIN_REGION;
      if (boxes[0]) lim.left = Math.min(lim.left, lo(boxes[0].x, first.x));
      lim.right = last.x + MIN_REGION;
      if (boxes[n - 1]) lim.right = Math.max(lim.right, hi(boxes[n - 1].right, last.x + last.w));
      lim.top = s.y + s.h - MIN_REGION - header;
      lim.bottom = first.y + MIN_REGION;
      if (union) {
        lim.top = Math.min(lim.top, lo(union.y, first.y) - header);
        lim.bottom = Math.max(lim.bottom, hi(union.bottom, s.y + s.h));
      }
    } else {
      if (union) {
        lim.left = lo(union.x, s.x);
        lim.right = hi(union.right, s.x + s.w);
      }
      lim.top = first.y + first.h - MIN_REGION - header;
      if (boxes[0]) lim.top = Math.min(lim.top, lo(boxes[0].y, first.y) - header);
      lim.bottom = last.y + MIN_REGION;
      if (boxes[n - 1]) lim.bottom = Math.max(lim.bottom, hi(boxes[n - 1].bottom, last.y + last.h));
    }
    return lim;
  }

  /**
   * Switches `s` between stacked and side-by-side regions: they share it equally again, any region too
   * small for its contents grows (with the state), and each region's contents move with it.
   */
  function setRegionLayout(s, layout) {
    const old = boxOf(s);
    const before = regionRects(s);
    // Each region's contents, relative to the region's top-left corner.
    const rel = before.map((r) => {
      const b = contentsBox(r.id);
      return b ? { right: b.right - r.x, bottom: b.bottom - r.y } : { right: 0, bottom: 0 };
    });
    const n = before.length;
    s.regionLayout = layout;
    for (const r of s.regions) delete r.size;
    const body = s.h - (before[0].y - s.y);
    if (layout === 'horizontal') {
      const sizes = rel.map((c) => Math.max(s.w / n, c.right + FIT_MARGIN, MIN_REGION));
      s.w = sizes.reduce((a, b) => a + b, 0);
      s.regions.forEach((r, i) => (r.size = sizes[i]));
      s.h = headerHeight(s) + Math.max(body, ...rel.map((c) => c.bottom + FIT_MARGIN));
    } else {
      s.w = Math.max(s.w, ...rel.map((c) => c.right + FIT_MARGIN));
      const sizes = rel.map((c) => Math.max(body / n, c.bottom + FIT_MARGIN, MIN_REGION));
      s.regions.forEach((r, i) => (r.size = sizes[i]));
      s.h = headerHeight(s) + sizes.reduce((a, b) => a + b, 0);
    }
    layoutHeader.set(s.id, headerHeight(s));
    const after = regionRects(s);
    before.forEach((r, i) => shiftVertices(regionContents(r.id), after[i].x - r.x, after[i].y - r.y));
    followBorder(s, old);
    fitInRegion(s, old, false);
  }

  /** Warnings for elements whose boxes overlap, other than a state and what it contains; comments don't count. */
  function overlapIssues() {
    const out = [];
    const vs = model.vertices.filter((v) => v.type !== 'comment');
    const describe = (v) => (v.name ? `'${v.name}'` : `an unnamed ${TYPE_LABEL[v.type]}`);
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j];
        if (!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)) continue;
        if (isInside(a, b.id) || isInside(b, a.id)) continue;
        out.push({ id: a.id, severity: 'warning', message: `Overlaps ${describe(b)}.` });
        out.push({ id: b.id, severity: 'warning', message: `Overlaps ${describe(a)}.` });
      }
    }
    return out;
  }

  /**
   * Aligns the selected elements (without a selected ancestor) with `anchorId`: on its horizontal center
   * line when `horizontally`, else on its vertical one. Elements on a state's border don't align. Each
   * element moves with its contents and stays in its region; the enclosing composite states grow so that
   * their regions still hold their elements. Returns false, changing nothing, when fewer than two elements
   * are selected or when elements of different regions of one state would overlap along its region layout.
   */
  function align(anchorId, horizontally) {
    const items = alignable();
    const clicked = V.get(anchorId);
    if (!clicked) return false;
    const anchor = ancestors(clicked).filter((a) => selection.has(a.id)).pop() || clicked;
    if (items.length < 2 || !items.includes(anchor)) return false;

    const snap0 = layoutSnapshot();
    const moved = [];
    const roots = selectionRoots();
    for (const v of items) {
      const dx = horizontally ? 0 : center(anchor).x - center(v).x;
      const dy = horizontally ? center(anchor).y - center(v).y : 0;
      if (dx === 0 && dy === 0) continue;
      // A group follows its only selected member, unless the anchor is in it: aligning several members of a
      // group, or members with the anchor's group, moves just them.
      const mates = v.group && v.group !== anchor.group && roots.filter((x) => x.group === v.group).length === 1
        ? groupMembers(v.group).filter((m) => m !== v)
        : [];
      const ids = new Set();
      for (const x of [v, ...mates]) {
        moved.push({ v: x, old: boxOf(x) });
        ids.add(x.id);
        for (const d of descendants(x)) ids.add(d.id);
      }
      shiftVertices(ids, dx, dy);
    }
    if (!moved.length) return false;

    // Innermost first: a state that grows may no longer fit in its own region.
    moved.sort((a, b) => depth(b.v) - depth(a.v));
    for (const { v, old } of moved) fitInRegion(v, old, true);
    const along = (v) => (horizontally ? center(v).y : center(v).x);
    const off = items.find((v) => Math.abs(along(v) - along(anchor)) > 0.5);
    if (off) {
      // Growing one region moved the others: elements in different regions of one state can't line up.
      restoreLayout(snap0);
      const shared = ancestors(off).find((a) => isInside(anchor, a.id));
      toast(`The elements cannot be aligned: they would leave their regions of '${shared ? shared.name : ''}'.`);
      return false;
    }
    commit({ props: true });
    return true;
  }

  /** The selected elements (without a selected ancestor) that Align moves: all but those on a state's border. */
  const alignable = () => selectionRoots().filter((v) => !isCP(v));

  /** Selected elements without a selected ancestor, which lead a move. */
  function selectionRoots() {
    return [...selection].map((id) => V.get(id)).filter((v) => v && !ancestors(v).some((a) => selection.has(a.id)));
  }

  function removeVertices(ids, transitionIds = new Set()) {
    model.vertices = model.vertices.filter((v) => !ids.has(v.id));
    model.transitions = model.transitions.filter((t) => !transitionIds.has(t.id) && !ids.has(t.source) && !ids.has(t.target));
    const alive = new Set([...model.vertices.map((v) => v.id), ...model.transitions.map((t) => t.id)]);
    for (const v of model.vertices) {
      if (v.anchors) v.anchors = v.anchors.filter((a) => alive.has(a));
    }
    selection = new Set([...selection].filter((id) => alive.has(id)));
  }

  function deleteSelection() {
    if (!selection.size) return;
    const vs = new Set();
    const ts = new Set();
    for (const id of selection) {
      const v = V.get(id);
      if (v) {
        vs.add(id);
        for (const d of descendants(v)) vs.add(d.id);
      } else if (T.has(id)) ts.add(id);
    }
    removeVertices(vs, ts);
    selection.clear();
    commit({ props: true });
  }

  function connect(source, targetId) {
    if (source.type === 'comment') {
      if (targetId === source.id) return;
      source.anchors = source.anchors || [];
      if (!source.anchors.includes(targetId)) source.anchors.push(targetId);
      selection = new Set([source.id]);
      commit({ props: true });
      return;
    }
    const target = V.get(targetId);
    if (!target) return;
    if (target.type === 'comment') {
      target.anchors = target.anchors || [];
      if (!target.anchors.includes(source.id)) target.anchors.push(source.id);
      commit({ props: true });
      return;
    }
    const problem = connectProblem(source, target);
    if (problem) {
      toast(problem);
      return;
    }
    const t = { id: uid('t'), source: source.id, target: target.id, kind: 'external', triggers: [], guard: '', effect: '' };
    model.transitions.push(t);
    selection = new Set([t.id]);
    commit({ props: true });
    if (source.type === 'state') setTimeout(() => startInlineEdit(t.id), 0);
  }

  /** Why a transition can't go from `source` to `target`, or null when it can. */
  function connectProblem(source, target) {
    if (source.type === 'connectionPointRef' && refKind(source) === 'entry') {
      return 'An entry reference only receives transitions; execution continues inside the submachine.';
    }
    if (target.type === 'connectionPointRef' && refKind(target) === 'exit') {
      return 'An exit reference only has outgoing transitions; it is reached when the submachine exits.';
    }
    if (source.type === 'final' || source.type === 'terminate') {
      return `A ${TYPE_LABEL[source.type].toLowerCase()} cannot have outgoing transitions.`;
    }
    if (target.type === 'initial') return 'An initial pseudostate cannot be the target of a transition.';
    return null;
  }

  /**
   * Moves the `end` ('source' or 'target') of `t` to vertex `v`. Its bend points stay, unless it
   * becomes or stops being a state's self-transition loop, whose bend points are its corners.
   */
  function reconnect(t, end, v) {
    if (t[end] === v.id) return;
    const source = end === 'source' ? v : V.get(t.source);
    const target = end === 'target' ? v : V.get(t.target);
    if (!source || !target) return;
    const problem = connectProblem(source, target);
    if (problem) {
      toast(problem);
      render();
      return;
    }
    const wasLoop = isLoop(t);
    t[end] = v.id;
    if (isLoop(t) !== wasLoop) delete t.points;
    commit({ props: true });
  }

  // ---------------------------------------------------------------- clipboard
  function collectSelection() {
    const ids = new Set();
    for (const id of selection) {
      const v = V.get(id);
      if (!v) continue;
      ids.add(id);
      for (const d of descendants(v)) ids.add(d.id);
    }
    if (!ids.size) return null;
    const vertices = model.vertices.filter((v) => ids.has(v.id));
    const transitions = model.transitions.filter((t) => ids.has(t.source) && ids.has(t.target));
    return JSON.parse(JSON.stringify({ fsmClipboard: 1, vertices, transitions }));
  }

  /**
   * Adds a copy of clipboard `data`. Without `at` (keyboard paste, duplicate), each element goes into its
   * original's region when there is one, offset further at each repeat; with `at` (context menu), the
   * copy's top-left corner goes there, into the region under it. Regions grow to hold the copy.
   */
  function pasteData(data, at) {
    if (!data || !Array.isArray(data.vertices)) return;
    reindex();
    // A connection point reference whose state is neither copied nor in this diagram is left out, with its transitions.
    const copied = new Set(data.vertices.map((v) => v.id));
    const vertices = data.vertices.filter((v) => v.type !== 'connectionPointRef' || copied.has(v.parent) || V.has(v.parent));
    if (!vertices.length) return;
    const map = new Map();
    for (const v of vertices) {
      map.set(v.id, uid('v'));
      for (const r of v.regions || []) map.set(r.id, uid('r'));
    }
    // Parents copied in a cycle (crafted clipboard text): nothing would be a root.
    if (!vertices.some((v) => !map.has(v.parent))) return;
    // Before the comments, whose anchors may be copied transitions.
    for (const t of data.transitions || []) if (map.has(t.source) && map.has(t.target)) map.set(t.id, uid('t'));
    let offX;
    let offY;
    let target = null;
    if (at) {
      const roots = vertices.filter((v) => !map.has(v.parent));
      offX = snap(at.x) - Math.min(...roots.map((v) => v.x));
      offY = snap(at.y) - Math.min(...roots.map((v) => v.y));
      target = regionAt(at, new Set());
    } else {
      pasteCount++;
      offX = offY = 20 * pasteCount;
    }
    const off = { x: offX, y: offY };
    const added = [];
    const groups = new Map();
    for (const src of vertices) {
      const v = JSON.parse(JSON.stringify(src));
      v.id = map.get(src.id);
      // A copied group is a new group; a lone copied member belongs to none (see cleanGroups).
      if (v.group) {
        if (!groups.has(v.group)) groups.set(v.group, uid('g'));
        v.group = groups.get(v.group);
      }
      v.x += off.x;
      v.y += off.y;
      v.regions = (v.regions || []).map((r) => ({ ...r, id: map.get(r.id) }));
      if (map.has(v.parent)) v.parent = map.get(v.parent);
      else if (isCP(v)) {
        if (!V.has(v.parent)) continue;
        // On the border of a state that isn't copied: back onto its border, from where the offset put it.
        snapToBorder(v, V.get(v.parent), center(v));
      } else if (at && v.type !== 'entryPoint' && v.type !== 'exitPoint') {
        v.parent = target ? target.id : rootRegion();
      } else if (at || !regionOwner.has(v.parent)) {
        v.parent = rootRegion();
      }
      if (v.anchors) v.anchors = v.anchors.map((a) => map.get(a)).filter(Boolean);
      model.vertices.push(v);
      added.push(v);
    }
    for (const src of data.transitions || []) {
      if (!map.has(src.source) || !map.has(src.target)) continue;
      const t = JSON.parse(JSON.stringify(src));
      t.id = map.get(src.id);
      t.source = map.get(src.source);
      t.target = map.get(src.target);
      if (t.points) t.points = t.points.map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
      model.transitions.push(t);
    }
    reindex();
    const addedIds = new Set(added.map((v) => v.id));
    const roots = added.filter((v) => !ancestors(v).some((a) => addedIds.has(a.id)));
    for (const v of roots) fitInRegion(v, null, false);
    selection = new Set(roots.map((v) => v.id));
    commit({ props: true });
  }

  const isEditable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  document.addEventListener('copy', (e) => {
    if (isEditable(document.activeElement) || !model) return;
    const data = collectSelection();
    if (!data) return;
    e.clipboardData?.setData('text/plain', JSON.stringify(data));
    e.preventDefault();
    pasteCount = 0;
  });
  document.addEventListener('cut', (e) => {
    if (isEditable(document.activeElement) || !model) return;
    const data = collectSelection();
    if (!data) return;
    e.clipboardData?.setData('text/plain', JSON.stringify(data));
    e.preventDefault();
    pasteCount = 0;
    deleteSelection();
  });
  document.addEventListener('paste', (e) => {
    if (isEditable(document.activeElement) || !model) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    try {
      const data = JSON.parse(text);
      if (data && data.fsmClipboard) {
        e.preventDefault();
        pasteData(data);
      }
    } catch {
      // not ours
    }
  });

  // ---------------------------------------------------------------- pointer
  function hitTarget(el) {
    const e = /** @type {Element} */ (el);
    const handle = e.closest('[data-handle]');
    if (handle) return { kind: 'handle', handle: handle.getAttribute('data-handle') };
    const wp = e.closest('[data-wp]');
    if (wp) {
      const [id, i] = String(wp.getAttribute('data-wp')).split(':');
      return { kind: 'wp', id, index: Number(i) };
    }
    const end = e.closest('[data-end]');
    if (end) {
      const [id, which] = String(end.getAttribute('data-end')).split(':');
      return { kind: 'end', id, end: which };
    }
    const label = e.closest('[data-label]');
    if (label) return { kind: 'label', id: label.getAttribute('data-label') };
    const item = e.closest('[data-id]');
    if (item) {
      const id = item.getAttribute('data-id');
      return { kind: V.has(id) ? 'vertex' : 'transition', id };
    }
    return { kind: 'empty' };
  }

  function vertexUnder(e) {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const item = el.closest && el.closest('[data-id]');
      if (!item) continue;
      const id = item.getAttribute('data-id');
      if (V.has(id) || T.has(id)) return id;
    }
    return null;
  }

  /** The topmost state or pseudostate under the pointer, through transitions and comments. */
  function connectableUnder(e) {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const item = el.closest && el.closest('[data-id]');
      const v = item && V.get(item.getAttribute('data-id'));
      if (v && v.type !== 'comment') return v.id;
    }
    return null;
  }

  /** Time and position of the last plain pointerdown, for double-click detection. */
  let lastDown = null;

  svg.addEventListener('pointerdown', (e) => {
    if (!model) return;
    svg.focus();
    commitInlineEdit();
    hideProblems();
    const p = toWorld(e);
    let hit = hitTarget(e.target);

    if (e.button === 1 || e.button === 2 || spaceDown || tool) lastDown = null;
    if (e.button === 1 || e.button === 2 || spaceDown) {
      // A right-button press that doesn't move opens the context menu.
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, right: e.button === 2 && !spaceDown, moved: false, start: p, target: e.target };
      svg.classList.add('panning');
      capture(e);
      e.preventDefault();
      return;
    }

    if (tool) {
      const def = TOOL_BY_ID.get(tool);
      if (tool === 'transition') {
        if (hit.kind === 'vertex') startConnect(V.get(hit.id), p);
        else toast('Start the transition on a state or pseudostate.');
      } else if (tool === 'region') {
        const s = hit.kind === 'vertex' ? V.get(hit.id) : stateAt(p, new Set());
        if (s && s.type === 'state') {
          if (s.submachine) toast('A submachine state cannot own regions.');
          else addRegion(s);
          toolDone();
        } else toast('Click a state to add a region to it.');
      } else if (def && def.create) {
        createVertex(tool, p);
      }
      e.preventDefault();
      return;
    }

    // A composite state moves by its title bar: its regions are empty canvas, for a selection band
    // and for a double-click adding a state.
    if (hit.kind === 'vertex' && regionRects(V.get(hit.id)).some((r) => inRect(r, p))) hit = { kind: 'empty' };

    // Double-clicks are detected here: the render below replaces the element under the pointer,
    // so the browser never fires dblclick on a diagram item.
    const dbl = e.button === 0 && lastDown && e.timeStamp - lastDown.time < 500 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 5;
    lastDown = dbl ? null : { time: e.timeStamp, x: e.clientX, y: e.clientY };
    if (dbl && doubleClick(e, hit, p)) {
      e.preventDefault();
      return;
    }

    switch (hit.kind) {
      case 'handle': {
        if (hit.handle.startsWith('sep:')) {
          const k = hit.handle.lastIndexOf(':');
          const s = V.get(hit.handle.slice(4, k));
          const i = Number(hit.handle.slice(k + 1));
          if (s && i < s.regions.length - 1) {
            const undo = layoutSnapshot();
            keepRegionSizes(s);
            drag = { kind: 'region', v: s, i, start: p, size0: s.regions[i].size, snap: layoutSnapshot(), undo };
          }
          break;
        }
        const v = V.get([...selection][0]);
        if (!v) break;
        if (hit.handle.startsWith('resize-')) {
          const undo = layoutSnapshot();
          if ((v.regions || []).length) keepRegionSizes(v);
          drag = { kind: 'resize', corner: hit.handle.slice(7), v, start: p, x0: v.x, y0: v.y, w0: v.w, h0: v.h, snap: layoutSnapshot(), undo };
        }
        else startConnect(v, p);
        break;
      }
      case 'wp':
        drag = { kind: 'wp', t: T.get(hit.id), index: hit.index, undo: layoutSnapshot() };
        break;
      case 'end':
        drag = { kind: 'reconnect', t: T.get(hit.id), end: hit.end, cur: p, hover: null };
        break;
      case 'label': {
        const t = T.get(hit.id);
        selection = new Set([t.id]);
        drag = { kind: 'label', t, start: p, off0: { ...(t.labelOffset || { x: 0, y: 0 }) }, had: !!t.labelOffset, moved: false };
        renderProps();
        break;
      }
      case 'vertex':
      case 'transition': {
        const id = /** @type {string} */ (hit.id);
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        let clickedSelected = false;
        if (additive) {
          if (selection.has(id)) selection.delete(id);
          else selection.add(id);
        } else if (!selection.has(id)) {
          selection = new Set([id]);
        } else clickedSelected = true;
        renderProps();
        if (hit.kind === 'vertex' && selection.has(id)) startMove(p, e.altKey, clickedSelected ? id : null);
        break;
      }
      default:
        if (!(e.shiftKey || e.metaKey || e.ctrlKey)) selection.clear();
        drag = { kind: 'band', start: p, cur: null, additive: e.shiftKey || e.metaKey || e.ctrlKey, base: new Set(selection) };
        renderProps();
    }
    if (drag) capture(e);
    render();
  });

  function capture(e) {
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already released pointer
    }
  }

  function startConnect(source, p) {
    drag = { kind: 'connect', source, cur: p, hover: null };
  }

  /**
   * Region a moved element is dropped into: the deepest one holding its whole box, when that is its own
   * region or lies inside it (an element never leaves its region by a drag); null to keep its region.
   */
  function dropRegionOf(v, exclude) {
    const r = regionHolding(v, exclude);
    return r && r.id !== v.parent && regionWithin(r.id, v.parent) ? r : null;
  }

  function startMove(p, noSnap, clickedId) {
    const moving = new Map();
    const roots = [];
    // The selected elements and the other members of their groups, which move with them.
    const picked = withGroupMates([...selection].map((id) => V.get(id)).filter(Boolean));
    const pickedIds = new Set(picked.map((v) => v.id));
    for (const v of picked) {
      if (ancestors(v).some((a) => pickedIds.has(a.id))) continue;
      roots.push(v);
      moving.set(v.id, v);
      for (const d of descendants(v)) moving.set(d.id, d);
    }
    const items = [...moving.values()].map((v) => ({ v, x0: v.x, y0: v.y }));
    const trans = model.transitions
      .filter((t) => t.points && t.points.length && moving.has(t.source) && moving.has(t.target))
      .map((t) => ({ t, pts0: t.points.map((q) => ({ ...q })) }));
    const boxes = new Map(roots.map((v) => [v.id, boxOf(v)]));
    drag = { kind: 'move', start: p, items, trans, roots, moving, moved: false, noSnap, clickedId, snap: layoutSnapshot(), boxes };
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toWorld(e);
    switch (drag.kind) {
      case 'pan':
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
        drag.moved = true;
        view.x = drag.vx + e.clientX - drag.sx;
        view.y = drag.vy + e.clientY - drag.sy;
        break;
      case 'move': {
        let dx = p.x - drag.start.x;
        let dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
        drag.moved = true;
        const lead = drag.roots[0];
        if (lead && !e.altKey && !isCP(lead)) {
          const it = drag.items.find((i) => i.v === lead);
          dx = snap(it.x0 + dx) - it.x0;
          dy = snap(it.y0 + dy) - it.y0;
        }
        // From the layout at the start: the regions grown for the previous position shrink back.
        restoreLayout(drag.snap);
        for (const it of drag.items) {
          it.v.x = it.x0 + dx;
          it.v.y = it.y0 + dy;
        }
        for (const tr of drag.trans) tr.t.points = tr.pts0.map((q) => ({ x: q.x + dx, y: q.y + dy }));
        // Connection points dragged on their own stay glued to their state's border.
        if (drag.roots.length === 1 && isCP(lead)) {
          const s = V.get(lead.parent);
          if (s) snapToBorder(lead, s, p);
        } else {
          for (const r of drag.roots) fitInRegion(r, drag.boxes.get(r.id), e.altKey);
        }
        const exclude = new Set(drag.moving.keys());
        const rr = lead && drag.roots.every((r) => !isCP(r)) ? dropRegionOf(dropBox(lead), exclude) || regionRects(regionOwner.get(lead.parent) || {}).find((r) => r.id === lead.parent) : null;
        drag.dropRegion = rr ? rr.id : null;
        drag.dropState = rr ? regionOwner.get(rr.id)?.id : null;
        break;
      }
      case 'resize': {
        restoreLayout(drag.snap);
        const v = drag.v;
        const start = boxOf(v);
        const west = drag.corner.includes('w');
        const north = drag.corner.includes('n');
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        const n = (v.regions || []).length;
        const horizontal = v.regionLayout === 'horizontal';
        const minW = v.type === 'fork' || v.type === 'join' ? 6 : 40;
        let lim = n ? resizeLimits(v) : null;
        if (west) {
          // The right edge stays put.
          const right = drag.x0 + drag.w0;
          v.x = Math.min(right - minW, e.altKey ? drag.x0 + dx : snap(drag.x0 + dx));
          if (lim) v.x = Math.min(v.x, lim.left);
          v.w = right - v.x;
          // Side by side, the left edge resizes the first region.
          if (n > 1 && horizontal) v.regions[0].size -= v.x - drag.x0;
        } else {
          v.w = Math.max(minW, e.altKey ? drag.w0 + dx : snap(v.x + drag.w0 + dx) - v.x);
          if (lim) v.w = Math.max(v.w, lim.right - v.x);
        }
        // After the width: the wrapped text depends on it.
        if (n) {
          keepHeader(v);
          lim = resizeLimits(v);
        }
        const y1 = v.y;
        const h1 = v.h;
        const minH = v.type === 'fork' || v.type === 'join' ? 6 : v.type === 'state' ? headerHeight(v) + (n ? 20 : 6) : 30;
        if (north) {
          // The bottom edge stays put.
          const bottom = y1 + h1;
          v.y = Math.min(bottom - minH, e.altKey ? drag.y0 + dy : snap(drag.y0 + dy));
          if (lim) v.y = Math.min(v.y, lim.top);
          v.h = bottom - v.y;
          // Stacked, the top edge resizes the first region.
          if (n > 1 && !horizontal) v.regions[0].size -= v.y - y1;
        } else {
          v.h = Math.max(minH, e.altKey ? h1 + dy : snap(v.y + h1 + dy) - v.y);
          if (lim) v.h = Math.max(v.h, lim.bottom - v.y);
        }
        followBorder(v, start);
        fitInRegion(v, start, e.altKey);
        break;
      }
      case 'region': {
        // The line after region i: the region resizes, its state with it, and the later regions move.
        restoreLayout(drag.snap);
        const v = drag.v;
        const start = boxOf(v);
        const horizontal = v.regionLayout === 'horizontal';
        const r = regionRects(v)[drag.i];
        const from = horizontal ? r.x : r.y;
        const end0 = from + drag.size0;
        const delta = horizontal ? p.x - drag.start.x : p.y - drag.start.y;
        let end = end0 + (e.altKey ? delta : snap(delta));
        let min = from + MIN_REGION;
        const c = contentsBox(r.id);
        if (c) {
          const far = horizontal ? c.right : c.bottom;
          min = Math.max(min, Math.min(far + FIT_MARGIN, Math.max(end0, far)));
        }
        end = Math.max(end, min);
        resizeRegionEnd(v, drag.i, end - end0);
        followBorder(v, start);
        keepHeader(v);
        fitInRegion(v, start, e.altKey);
        break;
      }
      case 'connect':
        drag.cur = p;
        drag.hover = vertexUnder(e);
        if (drag.hover && !V.has(drag.hover) && drag.source.type !== 'comment') drag.hover = null;
        break;
      case 'reconnect':
        drag.cur = p;
        drag.hover = connectableUnder(e);
        break;
      case 'wp': {
        const q = e.altKey ? { x: p.x, y: p.y } : { x: snap(p.x), y: snap(p.y) };
        if (isLoop(drag.t)) moveLoopCorner(drag.t, V.get(drag.t.source), drag.index, q);
        else drag.t.points[drag.index] = q;
        break;
      }
      case 'label':
        drag.moved = true;
        drag.t.labelOffset = { x: Math.round(drag.off0.x + p.x - drag.start.x), y: Math.round(drag.off0.y + p.y - drag.start.y) };
        break;
      case 'band': {
        drag.cur = p;
        const r = normRect(drag.start, p);
        const next = new Set(drag.additive ? drag.base : []);
        for (const v of model.vertices) {
          if (v.x >= r.x && v.y >= r.y && v.x + v.w <= r.x + r.w && v.y + v.h <= r.y + r.h) next.add(v.id);
        }
        for (const t of model.transitions) if (next.has(t.source) && next.has(t.target)) next.add(t.id);
        selection = next;
        break;
      }
    }
    scheduleRender();
  });

  /** Ends the drag without committing it: what it changed goes back to how it was when it started. */
  function cancelDrag() {
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (d.undo || d.snap) restoreLayout(d.undo || d.snap);
    if (d.kind === 'label') {
      if (d.had) d.t.labelOffset = { ...d.off0 };
      else delete d.t.labelOffset;
    } else if (d.kind === 'pan') {
      view.x = d.vx;
      view.y = d.vy;
    } else if (d.kind === 'band') {
      selection = new Set(d.base);
      renderProps();
    }
  }

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    switch (d.kind) {
      case 'pan':
        saveView();
        render();
        if (d.right && !d.moved) showContextMenu(d.target, e.clientX, e.clientY);
        break;
      case 'move':
        if (!d.moved) {
          if (d.clickedId) {
            selection = new Set([d.clickedId]);
            renderProps();
          }
          render();
          break;
        }
        reindex();
        for (const v of d.roots) {
          if (isCP(v)) continue;
          const exclude = new Set(d.moving.keys());
          if (v.group) {
            // A group drops as a whole: into the region that holds all its members, or nowhere.
            if (v !== d.roots.find((r) => r.group === v.group)) continue;
            const rr = dropRegionOf(dropBox(v), exclude);
            if (rr) for (const m of groupMembers(v.group)) m.parent = rr.id;
            continue;
          }
          if (v.type === 'entryPoint' || v.type === 'exitPoint') {
            // A machine-level point dropped on a state becomes that state's point; elsewhere it stays top-level.
            const s = stateAt(center(v), exclude);
            if (s && !s.submachine) {
              v.parent = s.id;
              snapToBorder(v, s, center(v));
            } else v.parent = rootRegion();
            continue;
          }
          const rr = dropRegionOf(v, exclude);
          if (rr) v.parent = rr.id;
        }
        commit({ props: true });
        break;
      case 'resize':
      case 'region':
      case 'wp':
        commit();
        break;
      case 'label':
        if (d.moved) commit();
        else render();
        break;
      case 'connect': {
        const target = vertexUnder(e);
        if (target) connect(d.source, target);
        else render();
        toolDone();
        break;
      }
      case 'reconnect': {
        const v = V.get(connectableUnder(e) || '');
        if (v) reconnect(d.t, d.end, v);
        else render();
        break;
      }
      case 'band':
        renderProps();
        render();
        break;
    }
  });

  /** Double-click actions; returns false when the target has none. */
  function doubleClick(e, hit, p) {
    if (hit.kind === 'wp') {
      const t = T.get(hit.id);
      if (isLoop(t)) delete t.points; // back to the default loop
      else t.points.splice(hit.index, 1);
      if (t.points && !t.points.length) delete t.points;
      commit();
    } else if (hit.kind === 'label') {
      startInlineEdit(hit.id);
    } else if (hit.kind === 'transition') {
      const t = T.get(hit.id);
      if (isLoop(t)) return false; // a self-transition loop has no bend points but its corners
      addWaypoint(t, p);
    } else if (hit.kind === 'vertex') {
      const v = V.get(hit.id);
      if (v.type === 'state' && v.submachine && e.altKey) vscode.postMessage({ type: 'openSubmachine', href: v.submachine });
      else startInlineEdit(v.id);
    } else if (hit.kind === 'empty') {
      createVertex('state', p);
    } else return false;
    return true;
  }

  function addWaypoint(t, p) {
    const pts = route(t);
    if (!pts) return;
    if (!t.points || !t.points.length) t.points = pts.slice(1, -1).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
    const full = route(t);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < full.length - 1; i++) {
      const dd = distToSegment(p, full[i], full[i + 1]);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    t.points.splice(best, 0, { x: snap(p.x), y: snap(p.y) });
    selection = new Set([t.id]);
    commit({ props: true });
  }

  // A mouse wheel zooms around the pointer and a horizontal scroll (tilt wheel) pans; a trackpad
  // pans in both directions and pinches (Ctrl+wheel) to zoom. Browsers don't say which device sent
  // a wheel event, so one event that looks like a trackpad's makes its burst of events (no gap over
  // 250 ms) a trackpad scroll. Firefox reports a mouse wheel in lines. Chromium and WebKit also
  // give the legacy wheelDelta (wheel notches × 120): on macOS a trackpad's is exactly -3 times its
  // pixel delta, and elsewhere a mouse wheel moves whole notches while a touchpad doesn't.
  const macWheel = /Mac/.test(navigator.platform || navigator.userAgent);
  let wheelBurstEnd = 0;
  let wheelTrackpad = false;
  function isTrackpadWheel(/** @type {WheelEvent} */ e) {
    if (e.deltaMode !== 0) return false;
    if (e.deltaX && e.deltaY) return true;
    const w = /** @type {any} */ (e);
    const wx = w.wheelDeltaX || 0;
    const wy = w.wheelDeltaY || 0;
    if (!wx && !wy) return true;
    return macWheel ? wx === -3 * e.deltaX && wy === -3 * e.deltaY : wx % 120 !== 0 || wy % 120 !== 0;
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.timeStamp > wheelBurstEnd) wheelTrackpad = false;
    wheelBurstEnd = e.timeStamp + 250;
    if (isTrackpadWheel(e)) wheelTrackpad = true;
    if (e.ctrlKey || (macWheel && e.metaKey)) {
      // Pinch (Chromium sends it as Ctrl+wheel), Ctrl+wheel, or Cmd+wheel on macOS, where the
      // system keeps Ctrl+scroll for its own zoom: clamped so that a mouse notch doesn't jump.
      if (dy) zoomAt(Math.exp(-clamp(dy, -25, 25) * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else if (wheelTrackpad) {
      view.x -= dx;
      view.y -= dy;
      saveView();
      scheduleRender();
    } else if (Math.abs(dx) > Math.abs(dy)) {
      view.x -= dx;
      saveView();
      scheduleRender();
    } else if (dy) {
      zoomAt(Math.exp(-dy * 0.0022), e.clientX - r.left, e.clientY - r.top);
    }
  }, { passive: false });

  svg.addEventListener('contextmenu', (e) => e.preventDefault());

  // Drag & drop from the toolbox
  wrap.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('application/x-fsm-tool')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  wrap.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData('application/x-fsm-tool');
    if (!id || !model) return;
    e.preventDefault();
    createVertex(id, toWorld(e));
  });

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if (isEditable(/** @type {Element} */ (e.target)) || propsPop?.el.contains(/** @type {Node} */ (e.target)) || !model) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === ' ' && !spaceDown) {
      spaceDown = true;
      svg.classList.add('space');
      e.preventDefault();
      return;
    }
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'a') {
        selection = new Set(model.vertices.map((v) => v.id));
        renderProps();
        render();
        e.preventDefault();
      } else if (k === 'd') {
        const data = collectSelection();
        if (data) {
          pasteCount = 0;
          pasteData(data);
        }
        e.preventDefault();
      } else if (k === '=' || k === '+') {
        zoomCenter(1.2);
        e.preventDefault();
      } else if (k === '-') {
        zoomCenter(1 / 1.2);
        e.preventDefault();
      } else if (k === '0') {
        fit();
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        deleteSelection();
        e.preventDefault();
        return;
      case 'Escape':
        if (drag) {
          cancelDrag();
          render();
        } else if (tool) setTool(null);
        else {
          selection.clear();
          renderProps();
          render();
        }
        hideProblems();
        return;
      case 'Enter':
      case 'F2':
        if (selection.size === 1) {
          startInlineEdit([...selection][0]);
          e.preventDefault();
        }
        return;
      case 'f':
        fit();
        return;
      case 'g':
        toggleGroup();
        return;
      case 'v':
        setTool(null);
        return;
    }
    const byKey = [...TOOL_BY_ID.values()].find((t) => t.key === e.key.toLowerCase());
    if (byKey && !e.altKey) setTool(byKey.id, e.shiftKey);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      svg.classList.remove('space');
    }
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    svg.classList.remove('space');
  });

  // ---------------------------------------------------------------- inline editing
  let inline = null;

  function startInlineEdit(id) {
    commitInlineEdit();
    reindex();
    const v = V.get(id);
    const t = T.get(id);
    if (!v && !t) return;
    if (v && v.type === 'connectionPointRef') {
      propsEl.querySelector('select')?.focus();
      return;
    }
    if (v && PSEUDO.has(v.type) && v.type !== 'entryPoint' && v.type !== 'exitPoint' && v.type !== 'choice' && v.type !== 'junction' && v.type !== 'fork' && v.type !== 'join') {
      // Unnamed markers: open the properties panel instead.
      propsEl.querySelector('input')?.focus();
      return;
    }
    let box;
    let value;
    let multiline = false;
    if (v) {
      if (v.type === 'comment') {
        box = { x: v.x, y: v.y, w: v.w, h: v.h };
        value = v.text ?? '';
        multiline = true;
      } else if (v.type === 'state') {
        const atTop = (v.regions || []).length || activityLines(v).length;
        const y = atTop ? v.y + (v.stereotype ? 14 : 2) : v.y + v.h / 2 - 12 + (v.stereotype ? 6 : 0);
        box = { x: v.x + 4, y, w: v.w - 8, h: 24 };
        value = v.name;
      } else {
        box = { x: v.x + v.w / 2 - 60, y: v.y + v.h + 2, w: 120, h: 22 };
        value = v.name;
      }
    } else {
      const pts = route(t);
      if (!pts) return;
      const lp = labelPos(t, pts);
      box = { x: lp.anchor === 'end' ? lp.x - 220 : lp.anchor === 'start' ? lp.x : lp.x - 110, y: lp.y - 16, w: 220, h: 22 };
      value = transitionLabel(t);
    }
    const el = document.createElement(multiline ? 'textarea' : 'input');
    el.className = 'inline-edit';
    el.value = value;
    el.style.left = `${box.x * view.zoom + view.x}px`;
    el.style.top = `${box.y * view.zoom + view.y}px`;
    el.style.width = `${Math.max(80, box.w * view.zoom)}px`;
    el.style.height = `${Math.max(22, box.h * view.zoom)}px`;
    if (t) el.placeholder = model.kind === 'protocol' ? '[isReady()] event / [isDone()]' : 'event, after(2s) [isReady()] / doIt()';
    wrap.appendChild(el);
    inline = { el, id, cancelled: false };
    el.focus();
    el.select();
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        inline.cancelled = true;
        commitInlineEdit();
        svg.focus();
      } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Keep editing when the label breaks the grammar.
        if (commitInlineEdit(true)) svg.focus();
      }
      e.stopPropagation();
    });
    el.addEventListener('blur', () => commitInlineEdit());
  }

  /** Applies the inline editor. Returns false when it stays open because of an invalid label. */
  function commitInlineEdit(fromKey = false) {
    if (!inline) return true;
    const { el, id, cancelled } = inline;
    const v = V.get(id);
    const t = T.get(id);
    if (t && !cancelled && model && transitionLabel(t) !== el.value.trim()) {
      const err = applyLabel(t, el.value);
      if (err && fromKey) {
        el.classList.add('invalid');
        el.title = err;
        toast(err);
        return false;
      }
      inline = null;
      el.remove();
      if (err) toast(`Label not changed. ${err}`);
      else commit({ props: true });
      return true;
    }
    inline = null;
    el.remove();
    if (cancelled || !model) return true;
    if (v) {
      if (v.type === 'comment') {
        if (v.text === el.value) return true;
        v.text = el.value;
      } else {
        if (v.name === el.value.trim()) return true;
        v.name = el.value.trim();
      }
    } else {
      return true;
    }
    commit({ props: true });
    return true;
  }

  // ---------------------------------------------------------------- properties panel
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'className') el.className = v;
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }

  function textField(label, value, onChange, opts = {}) {
    const input = opts.multiline
      ? h('textarea', { rows: opts.rows || 3, placeholder: opts.placeholder || '' })
      : h('input', { type: 'text', placeholder: opts.placeholder || '' });
    input.value = value ?? '';
    const error = h('div', { className: 'field-error' });
    input.addEventListener('change', () => {
      if (!opts.check) {
        onChange(input.value);
        return;
      }
      // Refuse text that breaks the grammar; keep it in the field so it can be fixed.
      const r = opts.check(input.value);
      if (!r.ok) {
        input.classList.add('invalid');
        error.textContent = r.error;
        return;
      }
      input.classList.remove('invalid');
      error.textContent = '';
      input.value = Array.isArray(r.value) ? r.value.join(', ') : r.value;
      onChange(r.value);
    });
    if (!opts.multiline) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    }
    const head = opts.color
      ? h('div', { className: 'field-head' }, h('label', {}, label), colorButton(opts.color.value, opts.color.onChange, `Color of ${opts.color.what}`))
      : h('label', {}, label);
    return h('div', { className: 'field' }, head, input, error);
  }

  // ---------------------------------------------------------------- properties window
  /** The floating properties window opened from the context menu: `id` is the element it shows, null for the machine. */
  let propsPop = null;
  document.addEventListener('pointerdown', (e) => {
    const target = /** @type {Node} */ (e.target);
    if (propsPop && !propsPop.el.contains(target) && !colorPop?.contains(target) && !contextMenu?.contains(target)) closePropsPop();
  }, true);
  document.addEventListener('keydown', (e) => {
    // Registered before the context menu and color picker handlers, which close themselves first.
    const target = /** @type {Element} */ (e.target);
    if (propsPop && e.key === 'Escape' && !contextMenu && !colorPop && (propsPop.el.contains(target) || !isEditable(target))) {
      e.stopPropagation();
      closePropsPop();
      svg.focus();
    }
  }, true);

  /** Opens the properties of element `id` (null: the machine) in a window at (cx, cy), selecting the element. */
  function openPropsPop(id, cx, cy) {
    closePropsPop();
    selection = id ? new Set([id]) : new Set();
    const close = h('button', { className: 'tbtn', title: 'Close (Esc)', onclick: () => closePropsPop() });
    close.innerHTML = ICONS.close;
    const body = h('div', { className: 'props' });
    const el = h('div', { className: 'props-pop', role: 'dialog', 'aria-label': 'Properties', tabindex: '-1' },
      h('div', { className: 'side-head' }, h('span', {}, 'Properties'), close), body);
    propsPop = { el, body, id };
    document.body.append(el);
    renderProps();
    render();
    const w = el.offsetWidth;
    const top = clamp(cy, 4, Math.max(4, window.innerHeight - el.offsetHeight - 4));
    el.style.left = `${clamp(cx, 4, Math.max(4, window.innerWidth - w - 4))}px`;
    el.style.top = `${top}px`;
    el.style.maxHeight = `${window.innerHeight - top - 4}px`;
    el.focus();
  }

  function closePropsPop() {
    if (!propsPop) return;
    const { el } = propsPop;
    propsPop = null;
    // Apply the field being edited (its change event) before the window goes away.
    const active = /** @type {HTMLElement} */ (document.activeElement);
    if (active && el.contains(active)) active.blur();
    el.remove();
  }

  // ---------------------------------------------------------------- context menu
  let contextMenu = null;
  /** Clipboard of the context menu: its last read (by request number), and the menu's Paste item. */
  const clipboard = { request: 0, data: null, button: null };

  function clipboardCopy(cut) {
    const data = collectSelection();
    if (!data) return;
    vscode.postMessage({ type: 'clipboardWrite', text: JSON.stringify(data) });
    pasteCount = 0;
    if (cut) deleteSelection();
  }

  /** The selected elements (without a selected ancestor) and their groups, when they all lie in a composite state's region. */
  function leavingElements() {
    const roots = withGroupMates(selectionRoots());
    return roots.length && roots.every((v) => !isCP(v) && regionOwner.get(v.parent)) ? roots : [];
  }
  const canLeaveParent = () => leavingElements().length > 0;

  /** Moves the selected elements up one level, out of their composite state, without moving them on the diagram. */
  function leaveParent() {
    const roots = leavingElements();
    if (!roots.length) return;
    for (const v of roots) v.parent = regionOwner.get(v.parent).parent;
    commit({ props: true });
  }

  /**
   * Extract to Submachine: the extension checks the selection (src/extract.ts) when the context menu opens,
   * which enables the menu item or puts the reason it can't in its tooltip. On a click, it asks for the new
   * machine's name and makes the change.
   */
  const extractCheck = { request: 0, button: null };

  function extractSelection() {
    vscode.postMessage({ type: 'extract', ids: [...selection], text: JSON.stringify(model) });
  }

  // ---------------------------------------------------------------- groups
  /** Members of group `id`, in file order. */
  const groupMembers = (id) => (id ? model.vertices.filter((v) => v.group === id) : []);

  /** Box around vertices `vs`, or null when there are none. */
  function unionBox(vs) {
    if (!vs.length) return null;
    const x = Math.min(...vs.map((v) => v.x));
    const y = Math.min(...vs.map((v) => v.y));
    return { x, y, w: Math.max(...vs.map((v) => v.x + v.w)) - x, h: Math.max(...vs.map((v) => v.y + v.h)) - y };
  }

  /** `vs` with the other members of their groups, each once. */
  function withGroupMates(vs) {
    const out = new Map(vs.map((v) => [v.id, v]));
    for (const v of vs) for (const m of groupMembers(v.group)) if (!out.has(m.id)) out.set(m.id, m);
    return [...out.values()];
  }

  /** The box a moved element drops by: with a group, the box around all its members. */
  function dropBox(v) {
    return { ...(v.group ? unionBox(groupMembers(v.group)) : boxOf(v)), parent: v.parent };
  }

  /**
   * The elements a Group makes one group of: the selected ones and their groups' other members, when there
   * are at least two, in one region, none on a state's border, and they aren't already one group.
   */
  function groupable() {
    const vs = withGroupMates(selectionRoots());
    if (vs.length < 2 || vs.some((v) => isCP(v) || v.parent !== vs[0].parent)) return [];
    return vs[0].group && vs.every((v) => v.group === vs[0].group) ? [] : vs;
  }
  const canGroup = () => groupable().length > 0;
  const canUngroup = () => [...selection].some((id) => V.get(id)?.group);

  function groupSelection() {
    const vs = groupable();
    if (!vs.length) return;
    const id = uid('g');
    for (const v of vs) v.group = id;
    commit({ props: true });
  }

  /** Dissolves the groups of the selected elements. */
  function ungroupSelection() {
    const ids = new Set([...selection].map((id) => V.get(id)?.group).filter(Boolean));
    if (!ids.size) return;
    for (const v of model.vertices) if (ids.has(v.group)) delete v.group;
    commit({ props: true });
  }

  /** G: ungroups the selection when an element of it is in a group, groups it otherwise. */
  function toggleGroup() {
    if (canUngroup()) ungroupSelection();
    else if (canGroup()) groupSelection();
    else toast('Select two or more elements in the same region to group them.');
  }

  /**
   * Drops the group memberships the diagram can't show, as normalizeGroups (src/model.ts) does: on a state's
   * border, outside the region of the group's first member, or in a group of one.
   */
  function cleanGroups() {
    const parents = new Map();
    const counts = new Map();
    for (const v of model.vertices) {
      if (typeof v.group !== 'string' || !v.group || isCP(v)) {
        delete v.group;
        continue;
      }
      const parent = parents.get(v.group);
      if (parent === undefined) parents.set(v.group, v.parent);
      else if (parent !== v.parent) {
        delete v.group;
        continue;
      }
      counts.set(v.group, (counts.get(v.group) || 0) + 1);
    }
    for (const v of model.vertices) if (v.group && counts.get(v.group) < 2) delete v.group;
  }

  function closeContextMenu() {
    if (contextMenu) contextMenu.remove();
    contextMenu = null;
  }
  document.addEventListener('pointerdown', (e) => {
    if (contextMenu && !contextMenu.contains(/** @type {Node} */ (e.target))) closeContextMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (contextMenu && e.key === 'Escape') {
      e.stopPropagation();
      closeContextMenu();
    }
  }, true);
  window.addEventListener('blur', closeContextMenu);

  /**
   * The menu of a right-click on an element or on empty canvas (`target`, the element pressed).
   * A right-click on an element selects it unless it is already selected.
   */
  function showContextMenu(target, cx, cy) {
    closeContextMenu();
    if (tool) return;
    const hit = hitTarget(target);
    const id = hit.kind === 'vertex' || hit.kind === 'transition' || hit.kind === 'label' || hit.kind === 'wp' ? hit.id
      : hit.kind === 'handle' && selection.size === 1 ? [...selection][0]
      : null;
    if (id && !selection.has(id)) {
      selection = new Set([id]);
      renderProps();
      render();
    }
    const item = (label, onclick, disabled = false) =>
      h('button', {
        className: 'ctx-item',
        role: 'menuitem',
        disabled,
        onclick: () => {
          closeContextMenu();
          onclick();
        },
      }, label);
    const items = [];
    const sep = () => h('div', { className: 'ctx-sep', role: 'separator' });
    const v = id ? V.get(id) : null;
    if (v && !isCP(v)) {
      const canAlign = alignable().length >= 2;
      items.push(
        item('Align Horizontally', () => align(v.id, true), !canAlign),
        item('Align Vertically', () => align(v.id, false), !canAlign),
        sep(),
      );
    }
    if (v && !isCP(v)) items.push(item('Group', groupSelection, !canGroup()), item('Ungroup', ungroupSelection, !canUngroup()), sep());
    if (canLeaveParent()) items.push(item('Leave Parent', leaveParent), sep());
    if (v && !isCP(v)) {
      // Enabled once the extension has checked the selection.
      const extract = item('Extract to Submachine…', extractSelection, true);
      const requestId = ++extractCheck.request;
      extractCheck.button = extract;
      vscode.postMessage({ type: 'extractCheck', requestId, ids: [...selection], text: JSON.stringify(model) });
      items.push(extract, sep());
    }
    const at = toWorld({ clientX: cx, clientY: cy });
    const copyable = !!collectSelection();
    const paste = item('Paste', () => pasteData(clipboard.data, at), true);
    items.push(
      item('Cut', () => clipboardCopy(true), !copyable),
      item('Copy', () => clipboardCopy(false), !copyable),
      paste,
      sep(),
    );
    // Paste is offered once the extension has read the clipboard.
    const requestId = ++clipboard.request;
    clipboard.data = null;
    clipboard.button = paste;
    vscode.postMessage({ type: 'clipboardRead', requestId });
    if (id) items.push(item('Delete', deleteSelection), sep());
    items.push(item('Properties…', () => openPropsPop(id, cx, cy)));
    contextMenu = h('div', { className: 'ctx-menu', role: 'menu' }, ...items);
    contextMenu.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(contextMenu);
    const mw = contextMenu.offsetWidth;
    const mh = contextMenu.offsetHeight;
    contextMenu.style.left = `${clamp(cx, 4, window.innerWidth - mw - 4)}px`;
    contextMenu.style.top = `${cy + mh + 4 > window.innerHeight ? Math.max(4, cy - mh) : cy}px`;
  }

  // ---------------------------------------------------------------- color picker
  let colorPop = null;
  let colorAnchor = null;
  function closeColorPopover() {
    if (colorPop) colorPop.remove();
    colorPop = null;
    colorAnchor = null;
  }
  document.addEventListener('mousedown', (e) => {
    const target = /** @type {Node} */ (e.target);
    if (colorPop && !colorPop.contains(target) && !colorAnchor?.contains(target)) closeColorPopover();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (colorPop && e.key === 'Escape') {
      e.stopPropagation();
      closeColorPopover();
    }
  }, true);

  /** A swatch showing `value` (null: the default color) that opens a palette; `onChange` gets a color or null. */
  function colorButton(value, onChange, title) {
    const btn = h('button', { className: `swatch-btn${value ? '' : ' none'}`, title, style: value ? `background:${value}` : null });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (colorPop && colorAnchor === btn) return closeColorPopover();
      openColorPopover(btn, value, title, onChange);
    });
    return btn;
  }

  function openColorPopover(anchor, value, title, onChange) {
    closeColorPopover();
    const pick = (c) => {
      closeColorPopover();
      if (c !== value) onChange(c);
    };
    const custom = h('input', { type: 'color', title: 'Custom color' });
    custom.value = value || '#0090ff';
    custom.addEventListener('change', () => pick(custom.value.toLowerCase()));
    colorPop = h('div', { className: 'color-pop', role: 'dialog', 'aria-label': title },
      h('div', { className: 'color-pop-title' }, title),
      h('div', { className: 'color-pop-grid' }, ...PALETTE.map((c) =>
        h('button', { className: `swatch${c === value ? ' current' : ''}`, title: c, style: `background:${c}`, onclick: () => pick(c) }))),
      h('div', { className: 'color-pop-row' },
        h('label', { className: 'color-custom', title: 'Custom color' }, custom, 'Custom…'),
        h('button', { className: 'pbtn', onclick: () => pick(null), disabled: !value }, 'Default')),
    );
    colorAnchor = anchor;
    colorPop.addEventListener('keydown', (e) => e.stopPropagation()); // keep diagram shortcuts out of the palette
    document.body.append(colorPop);
    const r = anchor.getBoundingClientRect();
    const pw = colorPop.offsetWidth;
    const ph = colorPop.offsetHeight;
    colorPop.style.left = `${clamp(r.right - pw, 4, window.innerWidth - pw - 4)}px`;
    colorPop.style.top = `${r.bottom + 4 + ph > window.innerHeight ? Math.max(4, r.top - ph - 4) : r.bottom + 4}px`;
  }

  /** Sets (or with null, clears) the color of `e`, or of its item `key`. */
  function setColor(e, key, c) {
    if (!key) {
      if (c) e.color = c;
      else delete e.color;
    } else {
      const items = { ...(e.itemColors || {}) };
      if (c) items[key] = c;
      else delete items[key];
      if (Object.keys(items).length) e.itemColors = items;
      else delete e.itemColors;
    }
    commit({ props: true });
  }
  const colorOpt = (e, key, what) => ({ value: colorOf(key ? e.itemColors && e.itemColors[key] : e.color), what, onChange: (c) => setColor(e, key, c) });

  /** The row of the element's own color (`key` null), or of its item `key`, named `label`. */
  function colorField(e, what, key = null, label = 'Color') {
    const o = colorOpt(e, key, what);
    return h('div', { className: `field row color-field${label === 'Color' ? '' : ' wide'}` },
      h('label', {}, label),
      colorButton(o.value, o.onChange, `${label} of ${what}`),
      h('span', { className: 'muted' }, o.value || 'Default'));
  }

  const CHECK = {
    actions: X.checkActions,
    condition: X.checkCondition,
    triggers: (s) => X.checkList(s, X.checkTrigger),
    events: (s) => X.checkList(s, X.checkEvent),
  };

  function selectField(label, value, options, onChange) {
    const sel = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return h('div', { className: 'field' }, h('label', {}, label), sel);
  }


  function issuesFor(id) {
    const list = issuesById.get(id) || [];
    if (!list.length) return null;
    return h('div', {}, h('h4', {}, 'Problems'), ...list.map((i) => h('div', { className: `issue ${i.severity}` }, i.message)));
  }

  /** Rebuilds the side panel, and the properties window if it still shows the selection. */
  function renderProps() {
    closeColorPopover();
    if (model) reindex();
    if (propsPop) {
      const id = propsPop.id;
      const shown = id ? selection.size === 1 && selection.has(id) && (V.has(id) || T.has(id)) : selection.size === 0;
      if (!model || !shown) closePropsPop();
    }
    try {
      for (const el of propsPop ? [propsPane, propsPop.body] : [propsPane]) {
        propsEl = el;
        el.innerHTML = '';
        if (model) buildProps();
      }
    } finally {
      propsEl = propsPane;
    }
  }

  function buildProps() {
    const ids = [...selection];
    if (ids.length > 1) {
      propsEl.append(
        h('h3', {}, `${ids.length} elements selected`),
        h('p', { className: 'muted' }, 'Drag to move them together. Ctrl/Cmd+D duplicates, Ctrl/Cmd+C and V copy between diagrams.'),
      );
      return;
    }
    if (ids.length === 1 && V.has(ids[0])) return vertexProps(V.get(ids[0]));
    if (ids.length === 1 && T.has(ids[0])) return transitionProps(T.get(ids[0]));
    machineProps();
  }

  function machineProps() {
    const set = (k) => (val) => {
      model[k] = val;
      commit();
      if (k === 'name') renderToolbarState();
    };
    propsEl.append(
      h('h3', {}, 'State Machine'),
      textField('Name', model.name, set('name')),
      selectField('Kind', model.kind, [['behavioral', 'Behavioral state machine'], ['protocol', 'Protocol state machine']], (v) => {
        model.kind = v;
        commit({ props: true });
      }),
      textField('Context (owning classifier)', model.context, set('context'), { placeholder: 'e.g. MediaPlayer' }),
      textField('Documentation', model.documentation, set('documentation'), { multiline: true, rows: 4 }),
    );
    const mi = issuesFor('');
    if (mi) propsEl.append(mi);
    propsEl.append(
      h('h4', {}, 'Tips'),
      h('div', { className: 'muted', }, ...[
        ['Double-click', 'empty canvas to add a state; a name or label to edit it.'],
        ['Drag', 'the ⊕ handle of a selected element to draw a transition.'],
        ['Double-click', 'a transition to add a bend point, a bend point to remove it.'],
        ['Drag', 'an end of a selected transition onto another element to reconnect it.'],
        ['Drag', 'a corner of a selected self-transition to reshape its loop; the far corner moves it to another corner of the state.'],
        ['Drop', 'an element entirely inside a region to nest it. It then stays in its region, which grows to hold it; right-click › Leave Parent takes it out.'],
        ['Drag', 'the line between two regions to resize the region before it.'],
        ['Drag', 'a composite state by its title bar; dragging inside its regions selects what it encloses.'],
        ['Right-drag', 'Space+drag, middle-drag or two fingers pan; the wheel or a pinch zooms; F fits.'],
        ['Shift+click', 'a tool keeps it active.'],
        ['Label syntax', model.kind === 'protocol' ? '[isReady()] event / [isDone()]' : 'event, after(2s) [isReady() && !isBusy()] / doIt(); log()'],
        ['Behaviors', 'are calls without arguments, e.g. start(); there are no variables.'],
        ['Time', 'after(500ms), after(2s), after(5m) or after(1h).'],
      ].map(([k, v]) => h('div', {}, h('kbd', {}, k), ' ', v))),
    );
  }

  function vertexProps(v) {
    const set = (k, parse) => (val) => {
      const next = parse ? parse(val) : val;
      if (next === '' || (Array.isArray(next) && !next.length)) delete v[k];
      else v[k] = next;
      commit();
    };
    propsEl.append(h('h3', {}, TYPE_LABEL[v.type] || v.type));
    const group = SWAPPABLE.find((g) => g.includes(v.type));
    if (group) {
      propsEl.append(selectField('Kind', v.type, group.map((t) => [t, TYPE_LABEL[t]]), (t) => {
        const c = center(v);
        const old = boxOf(v);
        v.type = t;
        const def = TOOL_BY_ID.get(t)?.create?.();
        if (def) {
          v.w = def.w;
          v.h = def.h;
          v.x = c.x - v.w / 2;
          v.y = c.y - v.h / 2;
        }
        fitInRegion(v, old, false);
        commit({ props: true });
      }));
    }
    if (v.type === 'connectionPointRef') {
      refProps(v);
    } else if (v.type === 'comment') {
      propsEl.append(textField('Text', v.text, (val) => {
        v.text = val;
        commit();
      }, { multiline: true, rows: 5 }));
      const anchors = (v.anchors || []).map((a) => V.get(a) || T.get(a)).filter(Boolean);
      propsEl.append(h('h4', {}, 'Annotated elements'));
      if (!anchors.length) propsEl.append(h('div', { className: 'muted' }, 'Drag the ⊕ handle onto an element to attach this comment.'));
      for (const a of anchors) {
        propsEl.append(h('div', { className: 'row' },
          h('span', { style: 'flex:1' }, a.source ? `Transition ${transitionLabel(a) || a.id}` : a.name || TYPE_LABEL[a.type]),
          h('button', { className: 'pbtn icon', title: 'Detach', onclick: () => {
            v.anchors = v.anchors.filter((x) => x !== a.id);
            commit({ props: true });
          } }, '✕'),
        ));
      }
    } else {
      propsEl.append(textField('Name', v.name, (val) => {
        v.name = val.trim();
        commit();
      }));
    }
    const what = v.type === 'comment' ? 'the comment' : v.name || 'the element';
    // A composite state has a color for its header and one for its regions.
    if (v.type === 'state' && (v.regions || []).length) {
      propsEl.append(colorField(v, what, null, 'Title color'), colorField(v, what, 'background', 'Background color'));
    } else {
      propsEl.append(colorField(v, what));
    }

    if (v.type === 'state') {
      propsEl.append(
        textField('Stereotype', v.stereotype, set('stereotype'), { check: X.checkName, placeholder: 'e.g. Critical' }),
        h('h4', {}, 'Behaviors'),
        textField('entry /', v.entry, set('entry'), { check: CHECK.actions, placeholder: 'e.g. start(); log()', color: colorOpt(v, 'entry', 'entry') }),
        textField('exit /', v.exit, set('exit'), { check: CHECK.actions, placeholder: 'e.g. stop()', color: colorOpt(v, 'exit', 'exit') }),
        textField('do /', v.doActivity, set('doActivity'), { check: CHECK.actions, placeholder: 'e.g. poll()', color: colorOpt(v, 'doActivity', 'do') }),
        textField('Deferrable events', (v.deferrable || []).join(', '), set('deferrable'), { check: CHECK.events, placeholder: 'evA, evB', color: colorOpt(v, 'deferrable', 'the deferrable events') }),
        textField('State invariant', v.invariant, set('invariant'), { check: CHECK.condition, placeholder: 'e.g. isRunning() && !isFaulty()', color: colorOpt(v, 'invariant', 'the state invariant') }),
      );

      propsEl.append(h('h4', {}, 'Submachine'));
      const current = v.submachine || '';
      const options = [['', '(none: not a submachine state)'], ...machines.map((m) => [m.href, `${m.name} (${m.file})`])];
      if (current && !machines.some((m) => m.href === current)) options.push([current, `${machineLabel(current)} (not found)`]);
      propsEl.append(selectField('Referenced state machine', current, options, (val) => {
        if (val && (v.regions || []).length) {
          toast('Remove the regions first: a submachine state cannot own regions.');
          renderProps();
          return;
        }
        if (val) v.submachine = val;
        else delete v.submachine;
        commit({ props: true });
      }));
      if (!machines.length && !current) {
        propsEl.append(h('div', { className: 'muted field' }, 'No other state machine (.fsm) was found in the workspace.'));
      }
      if (v.submachine) {
        propsEl.append(h('button', { className: 'pbtn', onclick: () => vscode.postMessage({ type: 'openSubmachine', href: v.submachine }) }, `Open ${machineLabel(v.submachine)}`));
        submachineRefsSection(v);
      }

      if (!v.submachine) {
        propsEl.append(h('h4', {}, (v.regions || []).length > 1 ? 'Orthogonal regions' : 'Regions'));
        (v.regions || []).forEach((r, i) => {
          const input = h('input', { type: 'text', placeholder: `Region ${i + 1}` });
          input.value = r.name || '';
          input.addEventListener('change', () => {
            r.name = input.value.trim();
            commit();
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
          });
          propsEl.append(h('div', { className: 'row field' }, input,
            h('button', { className: 'pbtn icon', title: 'Remove region and its contents', onclick: () => removeRegion(v, r.id) }, '✕')));
        });
        propsEl.append(h('button', { className: 'pbtn', onclick: () => addRegion(v) }, '+ Add region'));
        if ((v.regions || []).length > 1) {
          propsEl.append(selectField('Region layout', v.regionLayout || 'vertical', [['vertical', 'Stacked (top to bottom)'], ['horizontal', 'Side by side']], (val) => {
            if (val === (v.regionLayout || 'vertical')) return;
            setRegionLayout(v, val);
            commit();
          }));
        }
      }

      const internal = model.transitions.filter((t) => t.kind === 'internal' && t.source === v.id && t.target === v.id);
      propsEl.append(h('h4', {}, 'Internal transitions'));
      for (const t of internal) {
        const input = h('input', { type: 'text' });
        input.value = transitionLabel(t);
        input.addEventListener('change', () => {
          const err = applyLabel(t, input.value);
          input.classList.toggle('invalid', !!err);
          input.title = err || '';
          if (err) toast(err);
          else {
            input.value = transitionLabel(t);
            commit();
          }
        });
        const ic = colorOpt(t, null, 'the internal transition');
        propsEl.append(h('div', { className: 'row field' }, input,
          colorButton(ic.value, ic.onChange, `Color of ${transitionLabel(t) || 'the internal transition'}`),
          h('button', { className: 'pbtn icon', title: 'Remove', onclick: () => {
            model.transitions = model.transitions.filter((x) => x !== t);
            commit({ props: true });
          } }, '✕')));
      }
      propsEl.append(h('button', { className: 'pbtn', onclick: () => {
        model.transitions.push({ id: uid('t'), source: v.id, target: v.id, kind: 'internal', triggers: ['event'], guard: '', effect: 'action()' });
        commit({ props: true });
      } }, '+ Add internal transition'));
    }

    const vi = issuesFor(v.id);
    if (vi) propsEl.append(vi);
  }

  function refProps(v) {
    const st = V.get(v.parent);
    const href = (st && st.submachine) || '';
    const info = href ? submachines[href] : null;
    const machine = href ? machineLabel(href) : '';
    propsEl.append(h('div', { className: 'muted field' },
      st ? `On ${st.name || 'state'}; refers to a point of ${machine || '(no submachine set)'}.` : 'Not attached to a state.'));
    const pts = st ? submachinePoints(st) : [];
    if (pts.length) {
      const cur = `${refKind(v)}:${v.ref || ''}`;
      const opts = pts.map((q) => [`${q.kind}:${q.id}`, `${q.name || q.id} (${q.kind} point)`]);
      if (!pts.some((q) => `${q.kind}:${q.id}` === cur)) opts.unshift([cur, v.ref ? `${v.ref} (missing)` : '— choose a point —']);
      propsEl.append(selectField('Referenced point', cur, opts, (val) => {
        const i = val.indexOf(':');
        v.pointKind = val.slice(0, i);
        v.ref = val.slice(i + 1);
        commit({ props: true });
      }));
    } else {
      const why = !href
        ? ''
        : !info
          ? 'Looking up the submachine…'
          : !info.found
            ? `${machine} was not found, so its points cannot be listed.`
            : `${machine} has no entry or exit points at its top level.`;
      if (why) propsEl.append(h('div', { className: 'muted field' }, why));
      propsEl.append(
        textField('Referenced point id', v.ref, (val) => {
          v.ref = val.trim();
          commit();
        }),
        selectField('Direction', refKind(v), [['entry', 'Entry point'], ['exit', 'Exit point']], (val) => {
          v.pointKind = val;
          commit({ props: true });
        }),
      );
    }
    if (href) {
      propsEl.append(h('button', { className: 'pbtn', onclick: () => vscode.postMessage({ type: 'openSubmachine', href }) }, `Open ${machine}`));
    }
  }

  function submachineRefsSection(v) {
    const info = submachines[v.submachine];
    propsEl.append(h('h4', {}, 'Connection point references'));
    if (!info) {
      propsEl.append(h('div', { className: 'muted' }, 'Looking up the submachine…'));
      return;
    }
    if (!info.found) {
      propsEl.append(h('div', { className: 'muted' }, `${machineLabel(v.submachine)} was not found. Pick another state machine above.`));
      return;
    }
    propsEl.append(h('div', { className: 'muted field' }, `From ${info.file}`));
    if (!info.points.length) {
      propsEl.append(h('div', { className: 'muted' }, `${machineLabel(v.submachine)} has no entry or exit points. Add them in that machine by placing entry/exit points on empty canvas.`));
      return;
    }
    const refs = refsOf(v);
    for (const q of info.points) {
      const ref = refs.find((r) => r.ref === q.id);
      propsEl.append(h('div', { className: 'row field' },
        h('span', { style: 'flex:1' }, `${q.kind === 'entry' ? '○' : '⊗'} ${q.name || q.id}`, h('span', { className: 'muted' }, ` · ${q.kind}`)),
        ref
          ? h('button', { className: 'pbtn icon', title: 'Select the reference', onclick: () => {
            selection = new Set([ref.id]);
            renderProps();
            render();
          } }, 'Select')
          : h('button', { className: 'pbtn icon', title: 'Add a reference on the border', onclick: () => addAllReferences(v, q) }, 'Add'),
      ));
    }
    if (freePoints(v).length > 1) {
      propsEl.append(h('button', { className: 'pbtn', onclick: () => addAllReferences(v) }, 'Add all references'));
    }
  }

  function transitionProps(t) {
    const s = V.get(t.source);
    const g = V.get(t.target);
    const nm = (v) => (v ? v.name || TYPE_LABEL[v.type] : '?');
    const set = (k) => (val) => {
      t[k] = val;
      commit();
    };
    propsEl.append(
      h('h3', {}, 'Transition'),
      h('div', { className: 'muted field' }, `${nm(s)} → ${nm(g)}`),
      selectField('Kind', t.kind, [['external', 'External'], ['local', 'Local'], ['internal', 'Internal']], (val) => {
        t.kind = val;
        if (val === 'internal') {
          t.target = t.source;
          delete t.points;
        }
        commit({ props: true });
      }),
      colorField(t, 'the transition'),
    );
    // Internal transitions drawn in their state's compartment take a single color.
    const inCompartment = t.kind === 'internal' && t.source === t.target && s && s.type === 'state';
    const item = (key, what) => (inCompartment ? undefined : colorOpt(t, key, what));
    propsEl.append(
      textField('Triggers', t.triggers.join(', '), set('triggers'), { check: CHECK.triggers, placeholder: 'event, after(500ms), after(2s)', color: item('triggers', 'the triggers') }),
    );
    if (model.kind === 'protocol') {
      propsEl.append(
        textField('Precondition', t.precondition, set('precondition'), { check: CHECK.condition, placeholder: 'e.g. isOpen()', color: item('precondition', 'the precondition') }),
        textField('Postcondition', t.postcondition, set('postcondition'), { check: CHECK.condition, placeholder: 'e.g. isClosed()', color: item('postcondition', 'the postcondition') }),
      );
    } else {
      propsEl.append(
        textField('Guard', t.guard, set('guard'), {
          check: (val) => X.checkGuard(val, allowsElse(s)),
          placeholder: allowsElse(s) ? 'e.g. hasDisc() && !isJammed(), or else' : 'e.g. hasDisc() && !isJammed()',
          color: item('guard', 'the guard'),
        }),
        textField('Effect', t.effect, set('effect'), { check: CHECK.actions, placeholder: 'e.g. notify(); log()', color: item('effect', 'the effect') }),
      );
    }
    propsEl.append(h('h4', {}, 'Routing'));
    propsEl.append(
      h('button', { className: 'pbtn', onclick: () => {
        delete t.points;
        delete t.labelOffset;
        commit({ props: true });
      } }, 'Straighten'),
      h('button', { className: 'pbtn', onclick: () => {
        // Reversed, the target becomes the source: refused as drawing it that way would be.
        if (!g || !s || connectProblem(g, s)) {
          toast('This transition cannot be reversed.');
          return;
        }
        [t.source, t.target] = [t.target, t.source];
        if (t.points) t.points.reverse();
        commit({ props: true });
      } }, 'Reverse'),
    );
    const ti = issuesFor(t.id);
    if (ti) propsEl.append(ti);
  }

  // ---------------------------------------------------------------- chrome
  function buildToolbox() {
    for (const group of TOOLS) {
      toolboxEl.append(h('div', { className: 'tb-title' }, group.group));
      for (const t of group.items) {
        const btn = h('button', {
          className: 'tb-item',
          'data-tool': t.id,
          draggable: t.mode ? null : 'true',
          title: `${t.label}${t.key ? ` (${t.key.toUpperCase()})` : ''}${t.mode ? '' : ' — click then click the canvas, or drag onto it'}`,
        });
        btn.innerHTML = ICONS[t.id] || '';
        btn.append(h('span', {}, t.label));
        if (t.key) btn.append(h('span', { className: 'key' }, t.key.toUpperCase()));
        btn.addEventListener('click', (e) => setTool(t.id, e.shiftKey));
        if (!t.mode) {
          btn.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('application/x-fsm-tool', t.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
          });
        }
        toolboxEl.append(btn);
      }
    }
    toolboxEl.append(h('div', { className: 'tb-hint' }, 'Shift+click a tool to keep it active. Esc returns to selection.'));
  }

  let zoomLabel;
  let titleLabel;
  const panelToggles = {};
  function buildToolbar() {
    const btn = (icon, title, onclick, text) => {
      const b = h('button', { className: 'tbtn', title, onclick });
      b.innerHTML = ICONS[icon] || '';
      if (text) b.append(text);
      return b;
    };
    const cmd = (command) => () => vscode.postMessage({ type: 'command', command });
    titleLabel = h('span', { className: 'title' });
    zoomLabel = h('span', { className: 'zoom' });
    toolbarEl.append(
      titleLabel,
      btn('undo', 'Undo (Ctrl/Cmd+Z)', cmd('undo')),
      btn('redo', 'Redo (Ctrl/Cmd+Shift+Z)', cmd('redo')),
      h('span', { className: 'sep' }),
      btn('zoomOut', 'Zoom out (Ctrl/Cmd+-)', () => zoomCenter(1 / 1.2)),
      zoomLabel,
      btn('zoomIn', 'Zoom in (Ctrl/Cmd+=)', () => zoomCenter(1.2)),
      btn('fit', 'Fit diagram (F)', () => fit()),
      h('span', { className: 'sep' }),
      btn('trash', 'Delete selection (Del)', () => deleteSelection()),
      h('span', { className: 'spacer' }),
      btn('trace', 'Show the Trace Player: replay a log on the diagrams', cmd('fsmEditor.tracePlayer.focus'), 'Trace'),
      btn('code', 'Generate code from a template', cmd('fsmEditor.generateCode'), 'Code'),
      btn('export', 'Export as SVG', cmd('fsmEditor.exportSvg'), 'SVG'),
      btn('export', 'Export as PNG', cmd('fsmEditor.exportPng'), 'PNG'),
      h('span', { className: 'sep' }),
      btn('json', 'Open as XMI text', cmd('fsmEditor.openAsText'), 'XMI'),
      h('span', { className: 'sep' }),
      (panelToggles.toolbox = btn('sideLeft', 'Toggle Toolbox', () => setPanel('toolbox', !panels.toolbox))),
      (panelToggles.props = btn('sideRight', 'Toggle Properties', () => setPanel('props', !panels.props))),
    );
    for (const [p, title] of [['toolbox', 'Close Toolbox'], ['props', 'Close Properties']]) {
      const b = btn('close', title, () => setPanel(p, false));
      PANES[p].querySelector('.side-head').append(b);
    }
  }

  // ---------------------------------------------------------------- side panels
  function setPanel(p, shown) {
    panels = { ...panels, [p]: shown };
    renderPanels();
    vscode.postMessage({ type: 'panels', panels });
  }
  function renderPanels() {
    PANES.toolbox.hidden = !panels.toolbox;
    PANES.props.hidden = !panels.props;
    panelToggles.toolbox.innerHTML = ICONS[panels.toolbox ? 'sideLeftOn' : 'sideLeft'];
    panelToggles.props.innerHTML = ICONS[panels.props ? 'sideRightOn' : 'sideRight'];
  }

  function renderToolbarState() {
    if (zoomLabel) zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    if (titleLabel && model) titleLabel.textContent = `${model.kind === 'protocol' ? '{protocol} ' : ''}${model.name || 'State machine'}`;
  }

  function renderStatus() {
    const e = allIssues.filter((i) => i.severity === 'error').length;
    const w = allIssues.filter((i) => i.severity === 'warning').length;
    const inf = allIssues.length - e - w;
    statusEl.innerHTML = '';
    const prob = h('span', { className: 'problems', title: 'Show problems', onclick: toggleProblems },
      h('span', { className: e ? 'e' : '' }, `✕ ${e}`), '  ',
      h('span', { className: w ? 'w' : '' }, `⚠ ${w}`), inf ? `  ℹ ${inf}` : '');
    statusEl.append(
      prob,
      h('span', {}, `${model ? model.vertices.filter((v) => v.type === 'state').length : 0} states · ${model ? model.transitions.length : 0} transitions`),
      h('span', { className: 'spacer' }),
      trace ? h('span', { className: 'trace-status', title: 'Trace Player' }, `▶ Trace${trace.event ? ` · event ${trace.event}` : ''}`,
        ...trace.instances.filter((i) => i.color >= 0).map((i) => h('span', { className: `trace-key trace-c${i.color % TRACE_COLORS}` }, `● ${i.label}`))) : '',
      h('span', {}, tool ? `Tool: ${TOOL_BY_ID.get(tool)?.label}${toolSticky ? ' (sticky)' : ''}` : selection.size ? `${selection.size} selected` : ''),
    );
  }

  function toggleProblems() {
    if (problemsEl.hidden) {
      renderProblems();
      problemsEl.hidden = false;
    } else hideProblems();
  }
  function hideProblems() {
    problemsEl.hidden = true;
  }
  function renderProblems() {
    problemsEl.innerHTML = '';
    if (!allIssues.length) {
      problemsEl.append(h('div', { className: 'empty' }, 'No problems. The state machine is well-formed.'));
      return;
    }
    const order = { error: 0, warning: 1, info: 2 };
    for (const i of [...allIssues].sort((a, b) => order[a.severity] - order[b.severity])) {
      problemsEl.append(h('div', { className: `item ${i.severity}`, onclick: () => {
        if (i.id) {
          selection = new Set([i.id]);
          reveal(i.id);
        } else selection.clear();
        renderProps();
        render();
      } }, i.message));
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }

  new ResizeObserver(() => scheduleRender()).observe(wrap);

  buildToolbox();
  buildToolbar();
  renderPanels();
  vscode.postMessage({ type: 'ready' });
})();
