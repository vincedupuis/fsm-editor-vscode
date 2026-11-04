/**
 * What the AI layout loop (aiLayout.ts) says to the language model and how it
 * reads its answers: the instructions and the description of the machine, the
 * propose_layout tool, applying a proposal to the model, and the report on each
 * proposal. The diagram (media/editor.js) fits, measures and renders proposals.
 * No VS Code API here.
 */
import { FsmModel, ModelIndex, Transition, Vertex } from './model';

export type LayoutMode = 'redesign' | 'improve';

/** Problems of a layout as the diagram measured them; lower scores are better. */
export interface LayoutMetrics {
  score: number;
  problems: string[];
  counts: Record<string, number>;
}

/** Text sizes of the states and label boxes of the transitions, measured by the diagram. */
export interface LayoutInfo {
  vertices: Record<string, { minW: number; textW: number; headerH: number }>;
  transitions: Record<string, { label: string[]; box: { x: number; y: number; w: number; h: number } }>;
}

/** A layout after the diagram fitted, measured and (optionally) rendered it. */
export interface LayoutEvaluation {
  model: FsmModel;
  /** What fitting changed. */
  notes: string[];
  metrics: LayoutMetrics;
  info: LayoutInfo;
  /** The rendered diagram, base64-encoded PNG. */
  png?: string;
}

/** Vertices the model sizes; the others keep their size. */
const RESIZABLE = new Set(['state', 'comment', 'fork', 'join']);

const MAX_PROBLEMS = 40;

const point = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
};

export const LAYOUT_TOOL = {
  name: 'propose_layout',
  description:
    'Proposes a layout of the state machine diagram, or changes to the last one: centers and sizes of vertices, ' +
    'region layouts, bend points and label offsets of transitions. Anything left out keeps its geometry from the last ' +
    'result. Returns the problems the editor measured, the layout after fitting, and its score (lower is better).',
  inputSchema: {
    type: 'object',
    properties: {
      vertices: {
        type: 'array',
        description: 'Vertices to place: center (cx, cy) and, for states, comments, forks and joins, size (w, h).',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            cx: { type: 'number' },
            cy: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['id', 'cx', 'cy'],
        },
      },
      regionLayouts: {
        type: 'array',
        description: 'States with several regions whose regions should be stacked (vertical) or side by side (horizontal).',
        items: {
          type: 'object',
          properties: { state: { type: 'string' }, layout: { type: 'string', enum: ['vertical', 'horizontal'] } },
          required: ['state', 'layout'],
        },
      },
      transitions: {
        type: 'array',
        description: 'Transitions to route: bend points in order from source to target (an empty list makes a straight line), and the label offset.',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, points: { type: 'array', items: point }, labelOffset: point },
          required: ['id'],
        },
      },
    },
  },
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const list = (a: unknown): Record<string, unknown>[] =>
  Array.isArray(a) ? a.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

/** Transitions drawn as lines (internal transitions of a state are text in it). */
export function drawnTransitions(model: FsmModel): Transition[] {
  const states = new Set(model.vertices.filter((v) => v.type === 'state').map((v) => v.id));
  return model.transitions.filter((t) => !(t.kind === 'internal' && t.source === t.target && states.has(t.source)));
}

/** The model with straight transitions and default label positions. */
export function withoutRouting(model: FsmModel): FsmModel {
  const m: FsmModel = JSON.parse(JSON.stringify(model));
  for (const t of m.transitions) {
    delete t.points;
    delete t.labelOffset;
  }
  return m;
}

function internalText(t: Transition): string {
  let s = t.triggers.join(', ');
  if (t.guard) s += ` [${t.guard}]`;
  if (t.effect) s += ` / ${t.effect}`;
  return s.trim() || '(internal)';
}

function describeVertex(v: Vertex, model: FsmModel, info: LayoutInfo, mode: LayoutMode): Record<string, unknown> {
  const d: Record<string, unknown> = { id: v.id, type: v.type };
  if (v.name) d.name = v.name;
  d.parent = v.parent;
  if (v.type === 'state') {
    if (v.stereotype) d.stereotype = v.stereotype;
    if (v.submachine) d.submachine = true;
    const text: string[] = [];
    if (v.entry) text.push(`entry / ${v.entry}`);
    if (v.exit) text.push(`exit / ${v.exit}`);
    if (v.doActivity) text.push(`do / ${v.doActivity}`);
    for (const e of v.deferrable ?? []) text.push(`${e} / defer`);
    for (const t of model.transitions) if (t.kind === 'internal' && t.source === v.id && t.target === v.id) text.push(internalText(t));
    if (text.length) d.text = text;
    if (v.invariant) d.invariant = v.invariant;
    const regions = v.regions ?? [];
    if (regions.length) {
      d.regions = regions.map((r) => (r.name ? { id: r.id, name: r.name } : { id: r.id }));
      if (regions.length > 1) d.regionLayout = v.regionLayout ?? 'vertical';
    }
    Object.assign(d, info.vertices[v.id] ?? {});
  } else if (v.type === 'comment') {
    d.text = v.text ?? '';
    if (v.anchors?.length) d.anchors = v.anchors;
  }
  if (mode === 'improve') Object.assign(d, { cx: r1(v.x + v.w / 2), cy: r1(v.y + v.h / 2), w: r1(v.w), h: r1(v.h) });
  else if (!RESIZABLE.has(v.type) || v.type === 'comment') Object.assign(d, { w: r1(v.w), h: r1(v.h) });
  return d;
}

function describeTransition(t: Transition, info: LayoutInfo, mode: LayoutMode): Record<string, unknown> {
  const d: Record<string, unknown> = { id: t.id, source: t.source, target: t.target };
  if (t.kind !== 'external') d.kind = t.kind;
  const label = info.transitions[t.id];
  if (label) Object.assign(d, { label: label.label.join(' '), labelW: label.box.w, labelH: label.box.h });
  if (mode === 'improve') {
    if (t.points?.length) d.points = t.points.map((p) => ({ x: r1(p.x), y: r1(p.y) }));
    if (t.labelOffset) d.labelOffset = t.labelOffset;
  }
  return d;
}

const INSTRUCTIONS = (max: number) => `You are laying out a UML state machine diagram for FSM Editor, a visual editor. You decide the geometry only: where shapes go, how big states are, where transitions bend and where their labels sit. You can't change the state machine itself: its vertices, their parents, its transitions and their texts stay as they are.

The goal is a diagram a careful human designer would draw:
- The main flow reads from left to right or from top to bottom, starting at the initial pseudostate. Exceptional and returning transitions go around the main flow.
- Shapes that follow each other share a row or a column (the same cy or cx), with even spacing: about 60–100 px between shapes, more where a label has to fit between them.
- Transitions are straight horizontal or vertical lines where possible. A transition that must bend uses right-angle bends (each segment horizontal or vertical) and goes around shapes, not through them.
- No overlapping shapes, no transition through a shape, as few crossings as possible, and every label clear of shapes, of other labels and of other transitions.
- Composite states are just large enough for their content, with a margin of about 30 px. The whole diagram is compact and balanced, not stretched in one direction.
- Pseudostates sit close to what they connect: an initial pseudostate just before the state it points to, a choice between its branches, a history pseudostate near the top left of its region.

Coordinates are pixels, x to the right and y downward, all absolute (not relative to the parent). Give each vertex as its center (cx, cy) and, for states, comments, forks and joins, its size (w, h); other vertices have a fixed size.
- A state is a rounded box with a header at its top: name, stereotype and internal activities (its "text" lines). textW is the width that shows every text line unwrapped and headerH the header height at that width; minW is the narrowest width that shows the name (text lines then wrap and the header gets taller). A simple state is about headerH + 20 high.
- The regions of a composite state share the area below its header equally: stacked from top to bottom (regionLayout "vertical") or side by side ("horizontal"). Every vertex must lie inside its parent region. You may change the regionLayout of a state with several regions.
- Entry/exit points and connection point references whose parent is a state sit on that state's border: give a center near the spot of the border you want.
- A transition is drawn as straight segments from its source through its bend points, in order, to its target, cut at the shapes' outlines. Without bend points, it's a straight line between the two centers. With bend points, the first segment heads from the source's center towards the first bend point and the last one from the last bend point towards the target's center, so a transition leaves or enters a shape straight only when that bend point is level with the shape's center or right above or below it. Bend points must lie outside the source and the target, except for a transition between a composite state and a vertex inside it, which starts or ends on the composite's border at the point nearest to its bend point. A self-transition without bend points is a small loop over the top-right corner of its state.
- The label of a transition sits beside the middle of its line (above a horizontal line, left of a vertical one), and labelOffset moves it from there. labelW × labelH is its approximate size.

Call propose_layout with your layout. The editor fits it (snaps it to a 10 px grid, enlarges states too small for their text, grows composite states around their content, puts border points on the border), measures its problems, renders it and gives you the result: the problems, the layout as it now is, and an image when it can. Then call propose_layout again with targeted fixes, listing only the vertices and transitions you change: everything else keeps its geometry from the last result. Moving a composite state also moves the vertices inside it that you don't list, as dragging it in the editor would. You have ${max} proposals, and the editor keeps the one with the best score, so don't start over when a layout is mostly good. Reply without calling the tool once the diagram looks right.`;

function problemList(m: LayoutMetrics): string {
  if (!m.problems.length) return 'No problems found.';
  const shown = m.problems.slice(0, MAX_PROBLEMS).map((p) => `- ${p}`);
  if (m.problems.length > MAX_PROBLEMS) shown.push(`- and ${m.problems.length - MAX_PROBLEMS} more`);
  return `${m.problems.length} problem${m.problems.length === 1 ? '' : 's'}:\n${shown.join('\n')}`;
}

function summary(m: LayoutMetrics): string {
  const c = m.counts;
  return `The diagram is ${c.width}×${c.height} px, with ${c.bends} bend points, ${c.diagonals} diagonal segments and ${c.crossings} crossings.`;
}

/** The first message: instructions, mode, and the machine (with its current layout and problems when improving). */
export function buildPrompt(model: FsmModel, start: LayoutEvaluation, mode: LayoutMode, max: number): string {
  const parts = [INSTRUCTIONS(max)];
  parts.push(
    mode === 'redesign'
      ? 'Mode: redesign. Ignore the current layout and design the best one from scratch. Your first proposal must place every vertex and give bend points to the transitions that need them; transitions are straight lines until you do.'
      : 'Mode: improve. The user arranged this diagram by hand. Keep its overall arrangement (which shapes are left of, right of, above or below each other, and the reading direction), and improve spacing, alignment, sizes, routing and labels, starting with the problems listed below.',
  );
  const vertices = model.vertices.map((v) => JSON.stringify(describeVertex(v, model, start.info, mode)));
  const transitions = drawnTransitions(model).map((t) => JSON.stringify(describeTransition(t, start.info, mode)));
  parts.push(
    `The ${model.kind === 'protocol' ? 'protocol ' : ''}state machine "${model.name}". Its top-level region${model.regions.length > 1 ? 's are' : ' is'} ${model.regions.map((r) => r.id).join(', ')}.\n` +
      `Vertices (parent is a region id, or a state id for points on a state's border):\n${vertices.join('\n')}\n` +
      `Transitions:\n${transitions.join('\n') || '(none)'}`,
  );
  if (mode === 'improve') {
    parts.push(`The current layout has a score of ${start.metrics.score}. ${summary(start.metrics)}\n${problemList(start.metrics)}${start.png ? '\nThe image shows the diagram as it is now.' : ''}`);
  }
  return parts.join('\n\n');
}

/**
 * Applies a propose_layout input to `base`. Vertices left out move with their
 * nearest moved ancestor, and the bend points of transitions left out move with
 * both their ends when those moved together.
 */
export function applyProposal(base: FsmModel, input: unknown): { model: FsmModel; errors: string[] } {
  const model: FsmModel = JSON.parse(JSON.stringify(base));
  const index = new ModelIndex(model);
  const transitions = new Map(drawnTransitions(model).map((t) => [t.id, t]));
  const errors: string[] = [];
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const delta = new Map<string, { dx: number; dy: number }>();
  for (const item of list(p.vertices)) {
    const v = index.vertices.get(String(item.id));
    if (!v) {
      errors.push(`there is no vertex ${String(item.id)}`);
      continue;
    }
    if (!isNum(item.cx) || !isNum(item.cy)) {
      errors.push(`vertex ${v.id} needs numbers cx and cy`);
      continue;
    }
    const cx0 = v.x + v.w / 2;
    const cy0 = v.y + v.h / 2;
    if (RESIZABLE.has(v.type)) {
      if (isNum(item.w) && item.w >= 1) v.w = item.w;
      if (isNum(item.h) && item.h >= 1) v.h = item.h;
    }
    v.x = item.cx - v.w / 2;
    v.y = item.cy - v.h / 2;
    delta.set(v.id, { dx: item.cx - cx0, dy: item.cy - cy0 });
  }
  const moveOf = (v: Vertex) => delta.get(v.id) ?? index.ancestors(v).map((a) => delta.get(a.id)).find(Boolean);
  for (const v of model.vertices) {
    if (delta.has(v.id)) continue;
    const d = moveOf(v);
    if (d) {
      v.x += d.dx;
      v.y += d.dy;
    }
  }

  for (const item of list(p.regionLayouts)) {
    const v = index.vertices.get(String(item.state));
    if (!v || (v.regions ?? []).length < 2) errors.push(`${String(item.state)} is not a state with several regions`);
    else if (item.layout === 'vertical' || item.layout === 'horizontal') v.regionLayout = item.layout;
  }

  const routed = new Set<string>();
  for (const item of list(p.transitions)) {
    const t = transitions.get(String(item.id));
    if (!t) {
      errors.push(`there is no transition ${String(item.id)} drawn as a line`);
      continue;
    }
    routed.add(t.id);
    if (Array.isArray(item.points)) {
      const pts = list(item.points).filter((q) => isNum(q.x) && isNum(q.y)).map((q) => ({ x: q.x as number, y: q.y as number }));
      if (pts.length) t.points = pts;
      else delete t.points;
    }
    const off = item.labelOffset as Record<string, unknown> | undefined;
    if (off && isNum(off.x) && isNum(off.y)) {
      if (off.x || off.y) t.labelOffset = { x: off.x, y: off.y };
      else delete t.labelOffset;
    }
  }
  for (const t of transitions.values()) {
    if (routed.has(t.id) || !t.points?.length) continue;
    const s = index.vertices.get(t.source);
    const g = index.vertices.get(t.target);
    const ds = s && moveOf(s);
    const dg = g && moveOf(g);
    if (ds && dg && ds.dx === dg.dx && ds.dy === dg.dy) t.points = t.points.map((q) => ({ x: q.x + ds.dx, y: q.y + ds.dy }));
  }
  return { model, errors };
}

/** Geometry of a fitted layout, one line per element, for the model to work from. */
function geometry(ev: LayoutEvaluation): string {
  const lines = ev.model.vertices.map((v) => {
    const d: Record<string, unknown> = { id: v.id, cx: r1(v.x + v.w / 2), cy: r1(v.y + v.h / 2), w: r1(v.w), h: r1(v.h) };
    if ((v.regions ?? []).length > 1) d.regionLayout = v.regionLayout ?? 'vertical';
    return JSON.stringify(d);
  });
  for (const t of drawnTransitions(ev.model)) {
    const d: Record<string, unknown> = { id: t.id };
    if (t.points?.length) d.points = t.points;
    if (t.labelOffset) d.labelOffset = t.labelOffset;
    const label = ev.info.transitions[t.id];
    if (label) d.labelBox = label.box;
    lines.push(JSON.stringify(d));
  }
  return lines.join('\n');
}

/** The tool result for proposal `n`. */
export function proposalReport(n: number, max: number, ev: LayoutEvaluation, best: { n: number; score: number }, errors: string[]): string {
  const parts = [
    `Proposal ${n} of ${max}: score ${ev.metrics.score} (lower is better; the best so far is proposal ${best.n}, with ${best.score}). ${summary(ev.metrics)}`,
  ];
  if (errors.length) parts.push(`Ignored: ${errors.join('; ')}.`);
  if (ev.notes.length) parts.push(`The editor ${ev.notes.join('; ')}.`);
  parts.push(problemList(ev.metrics));
  parts.push(`The layout now (vertex centers and sizes; transition bend points, label offsets and label boxes):\n${geometry(ev)}`);
  parts.push(
    n < max
      ? `${max - n} proposal${max - n === 1 ? '' : 's'} left. Fix the worst problems with another propose_layout call that lists only what changes, or reply without calling the tool if the diagram looks right.`
      : 'That was the last proposal.',
  );
  return parts.join('\n\n');
}
