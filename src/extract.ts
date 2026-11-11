/**
 * Extract to Submachine: moves selected elements of a state machine into a new state machine, and puts
 * a submachine state referencing it in their place.
 *
 * - Several elements of one region: they move with their contents, the transitions between them, and the
 *   comments and groups among them. A submachine state covering their bounding box replaces them.
 * - One composite state with one region: its contents move, and the state becomes the submachine state,
 *   keeping its name, behaviors, transitions and place. A composite state with several regions moves whole,
 *   as above, since the new machine has one region. Its own entry/exit points become the new machine's,
 *   and connection point references with the same ids take their place on its border.
 *
 * A transition crossing the boundary is split at a connection point, keeping its trigger, guard and effect
 * on its source's side: an incoming one goes to an entry point reference on the submachine state, then from
 * the new machine's entry point to its target; an outgoing one goes to an exit point of the new machine,
 * then from the exit point reference to its target. There is one entry point per inner target and one exit
 * point per outer target. An incoming transition to the target of the new machine's initial transition
 * (without guard or effect) targets the submachine state itself (default entry) instead.
 */
import { FsmModel, ModelIndex, Transition, Vertex, isBorderVertex, normalizeModel } from './model';

/** The selection cannot be extracted; the message says why. */
export class ExtractError extends Error {}

export interface ExtractResult {
  /** The edited machine, with the submachine state in place of the extracted elements. */
  parent: FsmModel;
  /** The new state machine. */
  machine: FsmModel;
  /** Id of the submachine state in `parent`. */
  stateId: string;
}

const POINT = 16;
const MACHINE_ID = 'sm';

/** The name proposed for the new machine: the extracted state's name when there is one, else `Submachine`. */
export function proposedName(model: FsmModel, selected: string[]): string {
  const roots = extractedRoots(model, selected);
  const states = roots.filter((v) => v.type === 'state');
  const name = states.length === 1 ? states[0].name.trim() : '';
  return name || 'Submachine';
}

/**
 * Returns the selected vertices without a selected ancestor, with the other members of their groups,
 * in file order.
 */
function extractedRoots(model: FsmModel, selected: string[]): Vertex[] {
  const ix = new ModelIndex(model);
  const ids = new Set(selected.filter((id) => ix.vertices.has(id)));
  const roots = new Set(
    [...ids].filter((id) => !ix.ancestors(ix.vertices.get(id)!).some((a) => ids.has(a.id))),
  );
  const groups = new Set(model.vertices.filter((v) => roots.has(v.id) && v.group).map((v) => v.group));
  return model.vertices.filter((v) => roots.has(v.id) || (v.group && groups.has(v.group)));
}

/**
 * Extracts the `selected` vertices of `model` into a new state machine named `name`, referenced as `href`.
 * `model` is left unchanged. Throws an ExtractError when the selection can't be extracted.
 */
export function extractSubmachine(model: FsmModel, selected: string[], name: string, href: string): ExtractResult {
  const m: FsmModel = normalizeModel(JSON.parse(JSON.stringify(model)));
  const ix = new ModelIndex(m);
  const roots = extractedRoots(m, selected);
  const label = (v: Vertex | undefined) => (v?.name ? `'${v.name}'` : `the ${v?.type ?? 'element'}`);

  if (!roots.some((v) => v.type !== 'comment')) throw new ExtractError('Select the states and pseudostates to extract.');
  const border = roots.find((v) => isBorderVertex(v, ix.vertices));
  if (border) {
    throw new ExtractError(`Points on a state's border can't be extracted without their state (${label(border)}).`);
  }
  if (roots.some((v) => v.parent !== roots[0].parent)) throw new ExtractError('Select elements of one region to extract them.');

  // A composite state with several regions moves whole instead: the new machine has one region.
  const single = roots.length === 1 && roots[0].type === 'state' && roots[0].regions?.length === 1 && !roots[0].submachine ? roots[0] : null;

  // Vertices moving to the new machine.
  const moved = new Set<string>();
  /** Entry/exit points of the extracted composite state, which become the new machine's. */
  const ownPoints = new Set<string>();
  if (single) {
    for (const v of m.vertices) {
      if (v.parent === single.id && isBorderVertex(v, ix.vertices)) ownPoints.add(v.id);
      else if (ix.isInside(v, single.id)) moved.add(v.id);
    }
    for (const id of ownPoints) moved.add(id);
  } else {
    for (const r of roots) moved.add(r.id);
    for (const v of m.vertices) if (roots.some((r) => ix.isInside(v, r.id))) moved.add(v.id);
  }

  const isIn = (id: string) => moved.has(id);
  const crossing = m.transitions.filter((t) => isIn(t.source) !== isIn(t.target) && !ownPoints.has(t.source) && !ownPoints.has(t.target));
  const history = (v: Vertex | undefined) => v?.type === 'shallowHistory' || v?.type === 'deepHistory';
  for (const t of crossing) {
    const s = ix.vertices.get(t.source);
    const g = ix.vertices.get(t.target);
    const what = `the transition from ${label(s)} to ${label(g)}`;
    if (t.kind !== 'external') throw new ExtractError(`Make ${what} external first: a ${t.kind} transition can't cross the submachine's boundary.`);
    if (history(s) || history(g)) throw new ExtractError(`${capitalize(what)} goes to or from a history pseudostate across the boundary, which a submachine can't express.`);
  }

  // Ids, new ones unique in the model they go to.
  const parentIds = new Set<string>([...m.vertices.map((v) => v.id), ...m.transitions.map((t) => t.id), ...allRegionIds(m)]);
  const machineIds = new Set<string>();
  for (const v of m.vertices) {
    if (!isIn(v.id)) continue;
    machineIds.add(v.id);
    for (const r of v.regions ?? []) machineIds.add(r.id);
  }
  for (const t of m.transitions) if (isIn(t.source) && isIn(t.target)) machineIds.add(t.id);
  const fresh = (taken: Set<string>, prefix: string) => {
    let id: string;
    for (let n = 1; taken.has((id = `${prefix}_x${n}`)); n++);
    taken.add(id);
    return id;
  };

  // The region of the new machine.
  const region = single ? { ...single.regions![0] } : { id: fresh(machineIds, 'r'), name: '' };
  delete region.size;
  const outerRegion = roots[0].parent;

  // The submachine state.
  let state: Vertex;
  if (single) {
    state = single;
    delete state.regions;
    delete state.regionLayout;
    state.regions = [];
    state.submachine = href;
  } else {
    const box = unionBox(roots);
    const names = new Set(m.vertices.filter((v) => !isIn(v.id)).map((v) => v.name));
    let stateName = name;
    for (let n = 2; names.has(stateName); n++) stateName = `${name}${n}`;
    state = {
      id: fresh(parentIds, 'v'),
      type: 'state',
      name: stateName,
      parent: outerRegion,
      x: box.x,
      y: box.y,
      w: Math.max(box.w, 140),
      h: Math.max(box.h, 60),
      regions: [],
      submachine: href,
    };
  }

  // Layout of the new machine: its contents from (120, 60), entry points on the left, exit points on the right.
  const content = m.vertices.filter((v) => isIn(v.id) && !ownPoints.has(v.id));
  const box = content.length ? unionBox(content) : { x: 0, y: 0, w: 0, h: 0 };
  const dx = 120 - box.x;
  const dy = 60 - box.y;

  const machineVertices: Vertex[] = [];
  const machineTransitions: Transition[] = [];
  const parentVertices: Vertex[] = [];
  const parentTransitions: Transition[] = [];
  for (const v of m.vertices) {
    if (!isIn(v.id)) {
      parentVertices.push(v);
      continue;
    }
    if (ownPoints.has(v.id)) continue; // placed below
    v.x += dx;
    v.y += dy;
    if (!single && v.parent === outerRegion) v.parent = region.id;
    machineVertices.push(v);
  }
  if (!single) parentVertices.splice(firstIndex(m.vertices, roots, isIn), 0, state);
  // Transitions inside move; those outside stay, and so do those of the composite state's own points.
  for (const t of m.transitions) {
    if (isIn(t.source) && isIn(t.target)) {
      if (t.points) t.points = t.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      machineTransitions.push(t);
    } else if (!crossing.includes(t)) {
      parentTransitions.push(t);
    }
  }

  const entries: Vertex[] = [];
  const exits: Vertex[] = [];
  const entryRefs: Vertex[] = [];
  const exitRefs: Vertex[] = [];
  const pointNames = new Set<string>();
  const pointName = (base: string) => {
    let n = base;
    for (let i = 2; pointNames.has(n); i++) n = `${base}${i}`;
    pointNames.add(n);
    return n;
  };

  // The composite state's own points: same ids in both machines (a reference in the parent).
  for (const id of ownPoints) {
    const p = ix.vertices.get(id)!;
    const kind = p.type === 'entryPoint' ? 'entry' : 'exit';
    const ref: Vertex = { ...reference(p.id, state.id, p.id, kind), x: p.x, y: p.y, w: p.w, h: p.h };
    if (p.color) ref.color = p.color;
    parentVertices.push(ref);
    const point: Vertex = { ...p, parent: region.id, name: pointName(p.name || (kind === 'entry' ? 'in' : 'out')) };
    delete point.group;
    (kind === 'entry' ? entries : exits).push(point);
  }

  // Default entry: the target of the new machine's initial transition, when it has no guard or effect.
  const initial = machineVertices.find((v) => v.type === 'initial' && v.parent === region.id);
  const initialOut = initial ? machineTransitions.filter((t) => t.source === initial.id) : [];
  const defaultTarget = initialOut.length === 1 && !initialOut[0].guard.trim() && !initialOut[0].effect.trim() ? initialOut[0].target : null;

  /** By inner target: the reference on the submachine state that incoming transitions go to. */
  const entryRefFor = new Map<string, string>();
  /** By outer target: the new machine's exit point that outgoing transitions go to. */
  const exitFor = new Map<string, string>();
  const targetName = (v: Vertex | undefined): string => {
    if (!v) return '';
    if (v.type === 'connectionPointRef') return targetName(ix.vertices.get(v.parent)) || 'Point';
    return identifier(v.name) || capitalize(TYPE_NAMES[v.type] ?? v.type);
  };
  for (const t of crossing) {
    delete t.points;
    delete t.labelOffset;
    if (isIn(t.target)) {
      if (t.target === defaultTarget) {
        t.target = state.id;
        parentTransitions.push(t);
        continue;
      }
      let refId = entryRefFor.get(t.target);
      if (!refId) {
        const entry = point(fresh(machineIds, 'v'), 'entryPoint', pointName(`to${targetName(ix.vertices.get(t.target))}`), region.id);
        entries.push(entry);
        machineTransitions.push(plain(fresh(machineIds, 't'), entry.id, t.target));
        const ref = reference(fresh(parentIds, 'v'), state.id, entry.id, 'entry');
        entryRefs.push(ref);
        entryRefFor.set(t.target, (refId = ref.id));
      }
      t.target = refId;
      parentTransitions.push(t);
    } else {
      let exitId = exitFor.get(t.target);
      if (!exitId) {
        const exit = point(fresh(machineIds, 'v'), 'exitPoint', pointName(`to${targetName(ix.vertices.get(t.target))}`), region.id);
        exits.push(exit);
        const ref = reference(fresh(parentIds, 'v'), state.id, exit.id, 'exit');
        exitRefs.push(ref);
        parentTransitions.push(plain(fresh(parentIds, 't'), ref.id, t.target));
        exitFor.set(t.target, (exitId = exit.id));
      }
      t.target = exitId;
      machineTransitions.push(t);
    }
  }

  // Connection points of the new machine, beside the vertex they lead to or come from.
  const contentRight = content.length ? 120 + box.w : 120;
  const besideOf = (p: Vertex) => {
    const linked = p.type === 'entryPoint'
      ? machineTransitions.find((t) => t.source === p.id)?.target
      : machineTransitions.find((t) => t.target === p.id)?.source;
    const v = machineVertices.find((x) => x.id === linked);
    return v ? v.y + v.h / 2 : 60;
  };
  placeColumn(entries, 40, besideOf);
  placeColumn(exits, contentRight + 60, besideOf);
  machineVertices.push(...entries, ...exits);

  // References on the submachine state's border, in the order of their points: entries on the left, exits on the right.
  const pointY = new Map([...entries, ...exits].map((p) => [p.id, p.y]));
  const byPoint = (a: Vertex, b: Vertex) => pointY.get(a.ref!)! - pointY.get(b.ref!)!;
  entryRefs.sort(byPoint);
  exitRefs.sort(byPoint);
  spreadOnBorder(entryRefs, state, state.x);
  spreadOnBorder(exitRefs, state, state.x + state.w);
  parentVertices.push(...entryRefs, ...exitRefs);

  // The initial pseudostate moved out of the region: the region gets a new one, to the submachine state.
  if (!single && initial && initial.parent === region.id && roots.some((r) => r.id === initial.id)) {
    const init: Vertex = {
      id: fresh(parentIds, 'v'),
      type: 'initial',
      name: '',
      parent: outerRegion,
      x: state.x - 60,
      y: state.y + state.h / 2 - 10,
      w: 20,
      h: 20,
    };
    parentVertices.push(init);
    parentTransitions.push(plain(fresh(parentIds, 't'), init.id, state.id));
  }

  // Comment anchors: an outside comment anchored to an extracted element anchors the submachine state instead.
  const machineElements = new Set([...machineVertices.map((v) => v.id), ...machineTransitions.map((t) => t.id)]);
  const parentElements = new Set([...parentVertices.map((v) => v.id), ...parentTransitions.map((t) => t.id)]);
  for (const v of machineVertices) if (v.anchors) v.anchors = v.anchors.filter((a) => machineElements.has(a));
  for (const v of parentVertices) {
    if (!v.anchors) continue;
    const anchors = v.anchors.map((a) => (parentElements.has(a) ? a : machineElements.has(a) ? state.id : null)).filter((a): a is string => !!a);
    v.anchors = [...new Set(anchors)];
  }

  const parent: FsmModel = { ...m, vertices: parentVertices, transitions: parentTransitions };
  const machine: FsmModel = {
    version: 1,
    id: MACHINE_ID,
    name,
    kind: m.kind,
    context: '',
    documentation: '',
    regions: [region],
    vertices: machineVertices,
    transitions: machineTransitions,
  };
  return { parent: normalizeModel(parent), machine: normalizeModel(machine), stateId: state.id };
}

const TYPE_NAMES: Partial<Record<Vertex['type'], string>> = {
  state: 'state',
  final: 'final',
  initial: 'initial',
  choice: 'choice',
  junction: 'junction',
  fork: 'fork',
  join: 'join',
  entryPoint: 'entry',
  exitPoint: 'exit',
  terminate: 'terminate',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `name` as one word: letters, digits and underscores, each word capitalized (`Wait for payment` → `WaitForPayment`). */
function identifier(name: string): string {
  return name.split(/[^A-Za-z0-9_]+/).filter(Boolean).map(capitalize).join('');
}

const point = (id: string, type: 'entryPoint' | 'exitPoint', name: string, parent: string): Vertex =>
  ({ id, type, name, parent, x: 0, y: 0, w: POINT, h: POINT });

const reference = (id: string, parent: string, ref: string, pointKind: 'entry' | 'exit'): Vertex =>
  ({ id, type: 'connectionPointRef', name: '', parent, x: 0, y: 0, w: POINT, h: POINT, ref, pointKind });

const plain = (id: string, source: string, target: string): Transition => ({ id, source, target, kind: 'external', triggers: [], guard: '', effect: '' });

function allRegionIds(m: FsmModel): string[] {
  return [...m.regions.map((r) => r.id), ...m.vertices.flatMap((v) => (v.regions ?? []).map((r) => r.id))];
}

function unionBox(vs: Vertex[]) {
  const x = Math.min(...vs.map((v) => v.x));
  const y = Math.min(...vs.map((v) => v.y));
  return { x, y, w: Math.max(...vs.map((v) => v.x + v.w)) - x, h: Math.max(...vs.map((v) => v.y + v.h)) - y };
}

/** Where the submachine state goes in the vertex list: where the first extracted vertex was. */
function firstIndex(all: Vertex[], roots: Vertex[], isIn: (id: string) => boolean): number {
  let kept = 0;
  for (const v of all) {
    if (v.id === roots[0].id) return kept;
    if (!isIn(v.id)) kept++;
  }
  return kept;
}

/** Stacks points in a column at `x`, each near the height `yOf` gives, without overlapping. */
function placeColumn(points: Vertex[], x: number, yOf: (p: Vertex) => number) {
  const wanted = points.map((p) => ({ p, y: yOf(p) - POINT / 2 })).sort((a, b) => a.y - b.y);
  let next = -Infinity;
  for (const w of wanted) {
    w.p.x = x;
    w.p.y = Math.max(w.y, next);
    next = w.p.y + POINT + 24;
  }
}

/** Spreads references evenly along the vertical border of `state` at `x`. */
function spreadOnBorder(refs: Vertex[], state: Vertex, x: number) {
  refs.forEach((r, i) => {
    r.x = x - r.w / 2;
    r.y = state.y + (state.h * (i + 1)) / (refs.length + 1) - r.h / 2;
  });
}
