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
    trash: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
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
  let issues = [];
  let issuesById = new Map();
  let selection = new Set();
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
    decodeURI(String(href).split('#')[0]).replace(/^.*\//, '').replace(/\.fsm$/, '');
  /** Name of the point `id` in the machine referenced by `state`. */
  const pointName = (state, id) => ((state && submachinePoints(state).find((q) => q.id === id)) || {}).name || '';

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ ($('canvas')));
  const world = $('world');
  const wrap = $('canvas-wrap');
  const toolboxEl = $('toolbox');
  const propsEl = $('props');
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

  function activityLines(v) {
    const out = [];
    if (v.entry) out.push(`entry / ${v.entry}`);
    if (v.exit) out.push(`exit / ${v.exit}`);
    if (v.doActivity) out.push(`do / ${v.doActivity}`);
    for (const d of v.deferrable || []) out.push(`${d} / defer`);
    for (const t of model.transitions) {
      if (t.kind === 'internal' && t.source === v.id && t.target === v.id) out.push(transitionLabel(t) || '(internal)');
    }
    return out;
  }

  // ---------------------------------------------------------------- geometry
  const center = (v) => ({ x: v.x + v.w / 2, y: v.y + v.h / 2 });
  const snap = (n) => Math.round(n / GRID) * GRID;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const inRect = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

  function headerHeight(v) {
    let h = NAME_H + (v.stereotype ? 12 : 0);
    const n = activityLines(v).length;
    if (n) h += n * LINE_H + 6;
    return h;
  }

  function regionRects(v) {
    const regs = v.regions || [];
    if (!regs.length) return [];
    const top = v.y + Math.min(headerHeight(v), v.h - 20);
    const bh = v.y + v.h - top;
    const n = regs.length;
    const horizontal = v.regionLayout === 'horizontal';
    return regs.map((r, i) =>
      horizontal
        ? { id: r.id, name: r.name, x: v.x + (i * v.w) / n, y: top, w: v.w / n, h: bh }
        : { id: r.id, name: r.name, x: v.x, y: top + (i * bh) / n, w: v.w, h: bh / n },
    );
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

  function route(t) {
    const s = V.get(t.source);
    const g = V.get(t.target);
    if (!s || !g) return null;
    const pts = (t.points || []).map((p) => ({ x: p.x, y: p.y }));
    if (s === g && !pts.length) {
      // Self transition: a loop over the top-right corner.
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
    return { x: m.x + nx * 6 + off.x, y: m.y + ny * 6 + off.y + (ny < -0.5 ? -2 : 4), anchor };
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

  function textLine(x, y, cls, text, anchor = 'middle') {
    return `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" text-anchor="${anchor}">${esc(text)}</text>`;
  }

  function renderVertex(v, exporting) {
    const cls = ['vertex', `v-${v.type}`];
    if (!exporting) {
      if (selection.has(v.id)) cls.push('selected');
      const ic = issueClass(v.id);
      if (ic) cls.push(ic);
      if (drag && drag.dropState === v.id) cls.push('drop-target');
    }
    let s = `<g class="${cls.join(' ')}" data-id="${esc(v.id)}">`;
    const { x, y, w, h } = v;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    switch (v.type) {
      case 'state': {
        s += `<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>`;
        const lines = activityLines(v);
        const regions = regionRects(v);
        const title = v.name + (v.submachine ? ` : ${machineLabel(v.submachine)}` : '');
        const centered = !regions.length && !lines.length;
        let ty = y + 16;
        if (v.stereotype) {
          s += textLine(cx, y + (centered ? h / 2 - 4 : 13), 'stereo', `«${v.stereotype}»`);
          ty += 12;
        }
        if (centered) {
          s += textLine(cx, y + h / 2 + (v.stereotype ? 10 : 4), 'name', title);
        } else {
          s += textLine(cx, ty, 'name', title);
          let ly = y + NAME_H + (v.stereotype ? 12 : 0);
          if (lines.length) {
            s += `<line class="sep" x1="${x}" y1="${ly}" x2="${x + w}" y2="${ly}"/>`;
            for (const l of lines) {
              ly += LINE_H;
              s += textLine(x + 8, ly, 'activity', l, 'start');
            }
          }
        }
        if (regions.length) {
          const top = regions[0].y;
          s += `<line class="sep" x1="${x}" y1="${n1(top)}" x2="${x + w}" y2="${n1(top)}"/>`;
          regions.forEach((rr, i) => {
            if (i > 0) {
              s += v.regionLayout === 'horizontal'
                ? `<line class="sep dashed" x1="${n1(rr.x)}" y1="${n1(rr.y)}" x2="${n1(rr.x)}" y2="${n1(rr.y + rr.h)}"/>`
                : `<line class="sep dashed" x1="${n1(rr.x)}" y1="${n1(rr.y)}" x2="${n1(rr.x + rr.w)}" y2="${n1(rr.y)}"/>`;
            }
            if (rr.name) s += textLine(rr.x + 6, rr.y + 12, 'region-name', rr.name, 'start');
            if (!exporting && drag && drag.dropRegion === rr.id) {
              s += `<rect class="drop-region" x="${n1(rr.x)}" y="${n1(rr.y)}" width="${n1(rr.w)}" height="${n1(rr.h)}"/>`;
            }
          });
        }
        if (v.submachine) {
          const gx = x + w - 26;
          const gy = y + h - 14;
          s += `<rect class="stroke" x="${gx}" y="${gy}" width="8" height="6" rx="2" style="stroke-width:1.2"/>`;
          s += `<rect class="stroke" x="${gx + 13}" y="${gy}" width="8" height="6" rx="2" style="stroke-width:1.2"/>`;
          s += `<line class="stroke" x1="${gx + 8}" y1="${gy + 3}" x2="${gx + 13}" y2="${gy + 3}" style="stroke-width:1.2"/>`;
        }
        if (v.invariant) s += textLine(x + 4, y + h + 14, 'invariant', `{${v.invariant}}`, 'start');
        break;
      }
      case 'final':
        s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"/><circle class="fill" cx="${cx}" cy="${cy}" r="${Math.max(2, r - 5)}"/>`;
        break;
      case 'initial':
      case 'junction':
        s += `<circle class="fill" cx="${cx}" cy="${cy}" r="${r}"/>`;
        break;
      case 'shallowHistory':
      case 'deepHistory':
        s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"/>`;
        s += textLine(cx, cy + 4, 'glyph', v.type === 'deepHistory' ? 'H*' : 'H');
        break;
      case 'choice':
        s += `<path class="shape" d="M${cx},${y} L${x + w},${cy} L${cx},${y + h} L${x},${cy} Z"/>`;
        break;
      case 'fork':
      case 'join':
        s += `<rect class="fill" x="${x}" y="${y}" width="${w}" height="${h}" rx="1"/>`;
        break;
      case 'connectionPointRef':
      case 'entryPoint':
        if (v.type === 'connectionPointRef' && refKind(v) === 'exit') {
          const k = r * 0.62;
          s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"/>`;
          s += `<path class="stroke" d="M${cx - k},${cy - k} L${cx + k},${cy + k} M${cx + k},${cy - k} L${cx - k},${cy + k}" style="stroke-width:1.3"/>`;
        } else {
          s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"/>`;
        }
        break;
      case 'exitPoint': {
        const k = r * 0.62;
        s += `<circle class="shape" cx="${cx}" cy="${cy}" r="${r}"/>`;
        s += `<path class="stroke" d="M${cx - k},${cy - k} L${cx + k},${cy + k} M${cx + k},${cy - k} L${cx - k},${cy + k}" style="stroke-width:1.3"/>`;
        break;
      }
      case 'terminate':
        s += `<rect class="hit" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
        s += `<path class="stroke" d="M${x},${y} L${x + w},${y + h} M${x + w},${y} L${x},${y + h}" style="stroke-width:2"/>`;
        break;
      case 'comment': {
        const f = 12;
        s += `<path class="shape" d="M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + h} H${x} Z"/>`;
        s += `<path class="stroke" d="M${x + w - f},${y} V${y + f} H${x + w}" style="stroke-width:1"/>`;
        const lines = String(v.text ?? '').split('\n');
        lines.forEach((l, i) => {
          if (16 + i * 14 < h) s += textLine(x + 8, y + 17 + i * 14, '', l, 'start');
        });
        break;
      }
    }
    const caption = v.type === 'connectionPointRef' ? pointName(V.get(v.parent), v.ref) || '?' : v.name;
    if (caption && v.type !== 'state' && v.type !== 'comment') {
      const below = v.type === 'fork' || v.type === 'join' ? y + h + 13 : y + h + 12;
      s += textLine(cx, below, 'activity', caption);
    }
    if (!exporting && Math.min(w, h) < 20 && v.type !== 'fork' && v.type !== 'join') {
      s += `<rect class="hit" x="${cx - 11}" y="${cy - 11}" width="22" height="22"/>`;
    } else if (!exporting && (v.type === 'fork' || v.type === 'join') && Math.min(w, h) < 14) {
      s += `<rect class="hit" x="${x - 4}" y="${y - 5}" width="${w + 8}" height="${h + 10}"/>`;
    }
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
    }
    let s = `<g class="${cls.join(' ')}" data-id="${esc(t.id)}">`;
    if (!exporting) s += `<path class="hit" d="${d}"/>`;
    s += `<path class="line" d="${d}"/>`;
    s += `<path class="arrow" d="${arrowHead(pts[pts.length - 2], pts[pts.length - 1])}"/>`;
    const label = transitionLabel(t);
    if (label) {
      const lp = labelPos(t, pts);
      s += `<text class="tlabel" data-label="${esc(t.id)}" x="${n1(lp.x)}" y="${n1(lp.y)}" text-anchor="${lp.anchor}">${esc(label)}</text>`;
    }
    if (!exporting && selection.has(t.id) && selection.size === 1) {
      (t.points || []).forEach((p, i) => {
        s += `<circle class="wp" data-wp="${esc(t.id)}:${i}" cx="${p.x}" cy="${p.y}" r="4.5"/>`;
      });
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
    const sel = [...selection].map((id) => V.get(id)).filter(Boolean);
    for (const v of sel) {
      s += `<rect class="sel-box" x="${v.x - 4}" y="${v.y - 4}" width="${v.w + 8}" height="${v.h + 8}" rx="3"/>`;
    }
    if (sel.length === 1 && selection.size === 1) {
      const v = sel[0];
      if (RESIZABLE.has(v.type)) {
        s += `<rect class="handle" data-handle="resize" x="${v.x + v.w - 1}" y="${v.y + v.h - 1}" width="9" height="9" rx="1.5"/>`;
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

  function scene(exporting) {
    const parts = [];
    const sorted = sortedVertices();
    for (const v of sorted) if (v.type === 'comment') parts.push(renderAnchors(v));
    for (const v of sorted) parts.push(renderVertex(v, exporting));
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
    world.setAttribute('transform', `translate(${n1(view.x)},${n1(view.y)}) scale(${view.zoom})`);
    world.innerHTML = scene(false) + renderOverlay();
    const g = GRID * 2 * view.zoom;
    wrap.style.backgroundSize = `${g}px ${g}px`;
    wrap.style.backgroundPosition = `${view.x % g}px ${view.y % g}px`;
    svg.classList.toggle('tool-armed', !!tool);
    renderToolbarState();
    renderStatus();
  }
  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  // ---------------------------------------------------------------- persistence
  function commit(opts = {}) {
    const text = JSON.stringify(model, null, 2) + '\n';
    lastText = text;
    vscode.postMessage({ type: 'edit', text });
    render();
    if (opts.props) renderProps();
  }

  function saveView() {
    vscode.setState({ ...(vscode.getState() || {}), view });
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
    }
    for (const t of m.transitions) {
      t.triggers = t.triggers ?? [];
      t.guard = t.guard ?? '';
      t.effect = t.effect ?? '';
      t.kind = t.kind ?? 'external';
    }
    return m;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'update') {
      issues = msg.issues || [];
      submachines = msg.submachines || {};
      machines = msg.machines || [];
      issuesById = new Map();
      for (const i of issues) {
        const l = issuesById.get(i.id) || [];
        l.push(i);
        issuesById.set(i.id, l);
      }
      if (msg.error) {
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
        selection = new Set([...selection].filter((id) => V.has(id) || T.has(id)));
        if (firstLoad) {
          firstLoad = false;
          requestAnimationFrame(() => fit());
        }
        renderProps();
      } else if (!propsEl.contains(document.activeElement)) {
        renderProps();
      }
      render();
      if (!problemsEl.hidden) renderProblems();
    } else if (msg.type === 'requestSvg') {
      vscode.postMessage({ type: 'svg', requestId: msg.requestId, svg: exportSvg() });
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
      const label = transitionLabel(t);
      if (label) {
        const lp = labelPos(t, pts);
        const w = label.length * 6.6;
        const x0 = lp.anchor === 'end' ? lp.x - w : lp.anchor === 'start' ? lp.x : lp.x - w / 2;
        addP(x0, lp.y - 12);
        addP(x0 + w, lp.y + 4);
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
    state.h = Math.max(state.h, 40 + 24 * Math.max(free.filter((q) => q.kind === 'entry').length, free.filter((q) => q.kind === 'exit').length));
    commit({ props: true });
  }

  function addRegion(state) {
    state.regions = state.regions || [];
    if (!state.regions.length) {
      // Make room for the region below the name compartment.
      state.w = Math.max(state.w, 220);
      state.h = Math.max(state.h, headerHeight(state) + 120);
    } else {
      if (state.regionLayout === 'horizontal') state.w += 160;
      else state.h += 100;
    }
    state.regions.push({ id: uid('r'), name: '' });
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
    state.regions = state.regions.filter((r) => r.id !== regionId);
    removeVertices(doomed);
    commit({ props: true });
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
    if (source.type === 'connectionPointRef' && refKind(source) === 'entry') {
      toast('An entry reference only receives transitions; execution continues inside the submachine.');
      return;
    }
    if (target.type === 'connectionPointRef' && refKind(target) === 'exit') {
      toast('An exit reference only has outgoing transitions; it is reached when the submachine exits.');
      return;
    }
    if (source.type === 'final' || source.type === 'terminate') {
      toast(`A ${TYPE_LABEL[source.type].toLowerCase()} cannot have outgoing transitions.`);
      return;
    }
    if (target.type === 'initial') {
      toast('An initial pseudostate cannot be the target of a transition.');
      return;
    }
    const t = { id: uid('t'), source: source.id, target: target.id, kind: 'external', triggers: [], guard: '', effect: '' };
    model.transitions.push(t);
    selection = new Set([t.id]);
    commit({ props: true });
    if (source.type === 'state') setTimeout(() => startInlineEdit(t.id), 0);
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

  function pasteData(data) {
    if (!data || !Array.isArray(data.vertices)) return;
    reindex();
    pasteCount++;
    const off = 20 * pasteCount;
    const map = new Map();
    for (const v of data.vertices) {
      map.set(v.id, uid('v'));
      for (const r of v.regions || []) map.set(r.id, uid('r'));
    }
    const added = [];
    for (const src of data.vertices) {
      const v = JSON.parse(JSON.stringify(src));
      v.id = map.get(src.id);
      v.x += off;
      v.y += off;
      v.regions = (v.regions || []).map((r) => ({ ...r, id: map.get(r.id) }));
      if (map.has(v.parent)) v.parent = map.get(v.parent);
      else if (isCP(v) ? !V.has(v.parent) : !regionOwner.has(v.parent)) {
        if (isCP(v)) continue;
        v.parent = rootRegion();
      }
      if (v.anchors) v.anchors = v.anchors.map((a) => map.get(a)).filter(Boolean);
      model.vertices.push(v);
      added.push(v);
    }
    for (const src of data.transitions || []) {
      if (!map.has(src.source) || !map.has(src.target)) continue;
      const t = JSON.parse(JSON.stringify(src));
      t.id = uid('t');
      t.source = map.get(src.source);
      t.target = map.get(src.target);
      if (t.points) t.points = t.points.map((p) => ({ x: p.x + off, y: p.y + off }));
      model.transitions.push(t);
    }
    reindex();
    const addedIds = new Set(added.map((v) => v.id));
    selection = new Set(added.filter((v) => !ancestors(v).some((a) => addedIds.has(a.id))).map((v) => v.id));
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

  svg.addEventListener('pointerdown', (e) => {
    if (!model) return;
    svg.focus();
    commitInlineEdit();
    hideProblems();
    const p = toWorld(e);
    const hit = hitTarget(e.target);

    if (e.button === 1 || e.button === 2 || spaceDown) {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
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

    switch (hit.kind) {
      case 'handle': {
        const v = V.get([...selection][0]);
        if (!v) break;
        if (hit.handle === 'resize') drag = { kind: 'resize', v, start: p, w0: v.w, h0: v.h };
        else startConnect(v, p);
        break;
      }
      case 'wp':
        drag = { kind: 'wp', t: T.get(hit.id), index: hit.index };
        break;
      case 'label': {
        const t = T.get(hit.id);
        selection = new Set([t.id]);
        drag = { kind: 'label', t, start: p, off0: { ...(t.labelOffset || { x: 0, y: 0 }) }, moved: false };
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

  function startMove(p, noSnap, clickedId) {
    const moving = new Map();
    const roots = [];
    for (const id of selection) {
      const v = V.get(id);
      if (!v) continue;
      if (ancestors(v).some((a) => selection.has(a.id))) continue;
      roots.push(v);
      moving.set(v.id, v);
      for (const d of descendants(v)) moving.set(d.id, d);
    }
    const items = [...moving.values()].map((v) => ({ v, x0: v.x, y0: v.y }));
    const trans = model.transitions
      .filter((t) => t.points && t.points.length && moving.has(t.source) && moving.has(t.target))
      .map((t) => ({ t, pts0: t.points.map((q) => ({ ...q })) }));
    drag = { kind: 'move', start: p, items, trans, roots, moving, moved: false, noSnap, clickedId };
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toWorld(e);
    switch (drag.kind) {
      case 'pan':
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
        for (const it of drag.items) {
          it.v.x = it.x0 + dx;
          it.v.y = it.y0 + dy;
        }
        for (const tr of drag.trans) tr.t.points = tr.pts0.map((q) => ({ x: q.x + dx, y: q.y + dy }));
        // Connection points dragged on their own stay glued to their state's border.
        if (drag.roots.length === 1 && isCP(lead)) {
          const s = V.get(lead.parent);
          if (s) snapToBorder(lead, s, p);
        }
        const probe = lead ? center(lead) : p;
        const exclude = new Set(drag.moving.keys());
        const rr = drag.roots.every((r) => !isCP(r)) ? regionAt(probe, exclude) : null;
        drag.dropRegion = rr ? rr.id : null;
        drag.dropState = rr ? regionOwner.get(rr.id)?.id : null;
        break;
      }
      case 'resize': {
        const v = drag.v;
        const minW = v.type === 'fork' || v.type === 'join' ? 6 : 40;
        const minH = v.type === 'fork' || v.type === 'join' ? 6 : v.type === 'state' ? headerHeight(v) + ((v.regions || []).length ? 30 : 6) : 30;
        v.w = Math.max(minW, e.altKey ? drag.w0 + p.x - drag.start.x : snap(v.x + drag.w0 + p.x - drag.start.x) - v.x);
        v.h = Math.max(minH, e.altKey ? drag.h0 + p.y - drag.start.y : snap(v.y + drag.h0 + p.y - drag.start.y) - v.y);
        for (const cp of model.vertices) {
          if (cp.parent === v.id && isCP(cp)) snapToBorder(cp, v, center(cp));
        }
        break;
      }
      case 'connect':
        drag.cur = p;
        drag.hover = vertexUnder(e);
        if (drag.hover && !V.has(drag.hover) && drag.source.type !== 'comment') drag.hover = null;
        break;
      case 'wp':
        drag.t.points[drag.index] = e.altKey ? { x: p.x, y: p.y } : { x: snap(p.x), y: snap(p.y) };
        break;
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

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    switch (d.kind) {
      case 'pan':
        saveView();
        render();
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
          if (v.type === 'entryPoint' || v.type === 'exitPoint') {
            // A machine-level point dropped on a state becomes that state's point; elsewhere it stays top-level.
            const s = stateAt(center(v), exclude);
            if (s && !s.submachine) {
              v.parent = s.id;
              snapToBorder(v, s, center(v));
            } else v.parent = rootRegion();
            continue;
          }
          const rr = regionAt(center(v), exclude);
          v.parent = rr ? rr.id : rootRegion();
        }
        commit({ props: true });
        break;
      case 'resize':
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
      case 'band':
        renderProps();
        render();
        break;
    }
  });

  svg.addEventListener('dblclick', (e) => {
    if (!model || tool) return;
    const hit = hitTarget(e.target);
    const p = toWorld(e);
    if (hit.kind === 'wp') {
      const t = T.get(hit.id);
      t.points.splice(hit.index, 1);
      if (!t.points.length) delete t.points;
      commit();
    } else if (hit.kind === 'label') {
      startInlineEdit(hit.id);
    } else if (hit.kind === 'transition') {
      addWaypoint(T.get(hit.id), p);
    } else if (hit.kind === 'vertex') {
      const v = V.get(hit.id);
      if (v.type === 'state' && v.submachine && e.altKey) vscode.postMessage({ type: 'openSubmachine', href: v.submachine });
      else startInlineEdit(v.id);
    } else if (hit.kind === 'empty') {
      createVertex('state', p);
    }
  });

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

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    // The wheel zooms around the pointer; a horizontal scroll (trackpad, tilt wheel) still pans.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (Math.abs(dx) > Math.abs(dy)) {
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
    if (isEditable(/** @type {Element} */ (e.target)) || !model) return;
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
          drag = null;
          render();
        } else if (tool) setTool(null);
        else {
          selection.clear();
          renderProps();
          render();
        }
        hideProblems();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = e.shiftKey ? GRID : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const moved = new Set();
        for (const id of selection) {
          const v = V.get(id);
          if (!v || ancestors(v).some((a) => selection.has(a.id))) continue;
          for (const x of [v, ...descendants(v)]) {
            if (moved.has(x.id)) continue;
            moved.add(x.id);
            x.x += dx;
            x.y += dy;
          }
        }
        if (moved.size) {
          e.preventDefault();
          commit();
        }
        return;
      }
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
    return h('div', { className: 'field' }, h('label', {}, label), input, error);
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

  function renderProps() {
    propsEl.innerHTML = '';
    if (!model) return;
    reindex();
    const ids = [...selection];
    if (ids.length > 1) {
      propsEl.append(
        h('h3', {}, `${ids.length} elements selected`),
        h('button', { className: 'pbtn', onclick: deleteSelection }, 'Delete'),
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
        ['Drop', 'an element into a region to nest it.'],
        ['Right-drag', 'Space+drag or middle-drag pans; the wheel zooms; F fits.'],
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
        v.type = t;
        const def = TOOL_BY_ID.get(t)?.create?.();
        if (def) {
          v.w = def.w;
          v.h = def.h;
          v.x = c.x - v.w / 2;
          v.y = c.y - v.h / 2;
        }
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

    if (v.type === 'state') {
      propsEl.append(
        textField('Stereotype', v.stereotype, set('stereotype'), { check: X.checkName, placeholder: 'e.g. Critical' }),
        h('h4', {}, 'Behaviors'),
        textField('entry /', v.entry, set('entry'), { check: CHECK.actions, placeholder: 'e.g. start(); log()' }),
        textField('exit /', v.exit, set('exit'), { check: CHECK.actions, placeholder: 'e.g. stop()' }),
        textField('do /', v.doActivity, set('doActivity'), { check: CHECK.actions, placeholder: 'e.g. poll()' }),
        textField('Deferrable events', (v.deferrable || []).join(', '), set('deferrable'), { check: CHECK.events, placeholder: 'evA, evB' }),
        textField('State invariant', v.invariant, set('invariant'), { check: CHECK.condition, placeholder: 'e.g. isRunning() && !isFaulty()' }),
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
            v.regionLayout = val;
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
        propsEl.append(h('div', { className: 'row field' }, input,
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

    const own = owner(v);
    propsEl.append(h('h4', {}, 'Location'), h('div', { className: 'muted' },
      own ? `${isCP(v) ? 'On the border of' : 'Inside'} ${own.name || TYPE_LABEL[own.type]}` : isPointType(v.type) ? 'Connection point of the state machine' : 'Top level',
      ` · ${Math.round(v.x)}, ${Math.round(v.y)} · ${Math.round(v.w)}×${Math.round(v.h)}`));
    const vi = issuesFor(v.id);
    if (vi) propsEl.append(vi);
    propsEl.append(h('div', { style: 'margin-top:12px' }, h('button', { className: 'pbtn', onclick: deleteSelection }, 'Delete')));
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
      textField('Triggers', t.triggers.join(', '), set('triggers'), { check: CHECK.triggers, placeholder: 'event, after(500ms), after(2s)' }),
    );
    if (model.kind === 'protocol') {
      propsEl.append(
        textField('Precondition', t.precondition, set('precondition'), { check: CHECK.condition, placeholder: 'e.g. isOpen()' }),
        textField('Postcondition', t.postcondition, set('postcondition'), { check: CHECK.condition, placeholder: 'e.g. isClosed()' }),
      );
    } else {
      propsEl.append(
        textField('Guard', t.guard, set('guard'), {
          check: (val) => X.checkGuard(val, allowsElse(s)),
          placeholder: allowsElse(s) ? 'e.g. hasDisc() && !isJammed(), or else' : 'e.g. hasDisc() && !isJammed()',
        }),
        textField('Effect', t.effect, set('effect'), { check: CHECK.actions, placeholder: 'e.g. notify(); log()' }),
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
        if (!g || g.type === 'initial' || (s && (s.type === 'final' || s.type === 'terminate'))) {
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
    propsEl.append(h('div', { style: 'margin-top:12px' }, h('button', { className: 'pbtn', onclick: deleteSelection }, 'Delete')));
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
      btn('code', 'Generate code from a template', cmd('fsmEditor.generateCode'), 'Code'),
      btn('export', 'Export as SVG', cmd('fsmEditor.exportSvg'), 'SVG'),
      h('span', { className: 'sep' }),
      btn('json', 'Open as XMI text', cmd('fsmEditor.openAsText'), 'XMI'),
    );
  }

  function renderToolbarState() {
    if (zoomLabel) zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    if (titleLabel && model) titleLabel.textContent = `${model.kind === 'protocol' ? '{protocol} ' : ''}${model.name || 'State machine'}`;
  }

  function renderStatus() {
    const e = issues.filter((i) => i.severity === 'error').length;
    const w = issues.filter((i) => i.severity === 'warning').length;
    const inf = issues.length - e - w;
    statusEl.innerHTML = '';
    const prob = h('span', { className: 'problems', title: 'Show problems', onclick: toggleProblems },
      h('span', { className: e ? 'e' : '' }, `✕ ${e}`), '  ',
      h('span', { className: w ? 'w' : '' }, `⚠ ${w}`), inf ? `  ℹ ${inf}` : '');
    statusEl.append(
      prob,
      h('span', {}, `${model ? model.vertices.filter((v) => v.type === 'state').length : 0} states · ${model ? model.transitions.length : 0} transitions`),
      h('span', { className: 'spacer' }),
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
    if (!issues.length) {
      problemsEl.append(h('div', { className: 'empty' }, 'No problems. The state machine is well-formed.'));
      return;
    }
    const order = { error: 0, warning: 1, info: 2 };
    for (const i of [...issues].sort((a, b) => order[a.severity] - order[b.severity])) {
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
  vscode.postMessage({ type: 'ready' });
})();
