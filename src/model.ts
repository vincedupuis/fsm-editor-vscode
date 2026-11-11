/**
 * In-memory UML state machine model. Files store it as XMI with UML DI
 * (see xmi.ts); the diagram editor works on this JSON form.
 *
 * The hierarchy is flat: every vertex points to its owner through `parent`,
 * which is either a region id (root region of the machine or a region of a
 * composite state) or, for connection points, the id of the owning state.
 *
 * Entry/exit points whose parent is a top-level region are connection points
 * of the state machine itself; a submachine state that references this machine
 * exposes them through `connectionPointRef` vertices placed on its border.
 */

export type VertexType =
  | 'state'
  | 'final'
  | 'initial'
  | 'shallowHistory'
  | 'deepHistory'
  | 'choice'
  | 'junction'
  | 'fork'
  | 'join'
  | 'entryPoint'
  | 'exitPoint'
  | 'terminate'
  | 'connectionPointRef'
  | 'comment';

export type PointKind = 'entry' | 'exit';

export type TransitionKind = 'external' | 'internal' | 'local';

/** Diagram colors, `#rrggbb`: the element's own, and per item (keys from ITEM_COLOR_KEYS). */
export type ItemColors = Partial<Record<ItemColorKey, string>>;

/**
 * Items of a state or transition that can have their own color, in file order:
 * `background` is the fill of a composite state's regions (its own color tints
 * only the header then), the others are items of the text.
 */
export const ITEM_COLOR_KEYS = [
  'background', 'entry', 'exit', 'doActivity', 'deferrable', 'invariant',
  'triggers', 'guard', 'effect', 'precondition', 'postcondition',
] as const;
export type ItemColorKey = (typeof ITEM_COLOR_KEYS)[number];

/** The color value accepted in files and in the editor. */
export const isColor = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/.test(s);

export interface Region {
  id: string;
  name: string;
  /**
   * Regions of a state: extent along the state's region layout (height when stacked, width side by
   * side). The last region takes whatever the others leave; without sizes, the regions share the
   * state equally.
   */
  size?: number;
}

export interface Vertex {
  id: string;
  type: VertexType;
  name: string;
  parent: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // state
  regions?: Region[];
  regionLayout?: 'horizontal' | 'vertical';
  entry?: string;
  exit?: string;
  doActivity?: string;
  deferrable?: string[];
  invariant?: string;
  /** Submachine state: XMI href of the referenced state machine, e.g. `Payment.fsm#sm`. */
  submachine?: string;
  stereotype?: string;
  // connectionPointRef: xmi:id of the entry/exit point, inside the submachine's file
  ref?: string;
  pointKind?: PointKind;
  // comment
  text?: string;
  anchors?: string[];
  color?: string;
  itemColors?: ItemColors;
  /**
   * Id of the group the vertex belongs to, for the diagram: its members move together. Groups are flat,
   * their members share one region, and vertices on a state's border are never grouped (see normalizeGroups).
   */
  group?: string;
}

export interface Transition {
  id: string;
  source: string;
  target: string;
  kind: TransitionKind;
  triggers: string[];
  guard: string;
  effect: string;
  /** Protocol state machines only. */
  precondition?: string;
  postcondition?: string;
  points?: { x: number; y: number }[];
  labelOffset?: { x: number; y: number };
  color?: string;
  itemColors?: ItemColors;
}

export interface FsmModel {
  version: 1;
  /** xmi:id of the state machine, used by other files to reference it. */
  id?: string;
  name: string;
  kind: 'behavioral' | 'protocol';
  context?: string;
  documentation?: string;
  regions: Region[];
  vertices: Vertex[];
  transitions: Transition[];
}

export const PSEUDOSTATES: ReadonlySet<VertexType> = new Set<VertexType>([
  'initial',
  'shallowHistory',
  'deepHistory',
  'choice',
  'junction',
  'fork',
  'join',
  'entryPoint',
  'exitPoint',
  'terminate',
]);

/** Vertices drawn on the border of a state (entry/exit points and connection point references). */
export function isBorderVertex(v: Vertex, vertices: Map<string, Vertex>): boolean {
  return v.type === 'connectionPointRef' || ((v.type === 'entryPoint' || v.type === 'exitPoint') && vertices.has(v.parent));
}

export interface ConnectionPointInfo {
  id: string;
  name: string;
  kind: PointKind;
}

/** Entry/exit points owned by the state machine itself (placed in a top-level region). */
export function machineConnectionPoints(model: FsmModel): ConnectionPointInfo[] {
  const top = new Set(model.regions.map((r) => r.id));
  return model.vertices
    .filter((v) => (v.type === 'entryPoint' || v.type === 'exitPoint') && top.has(v.parent))
    .map((v) => ({ id: v.id, name: v.name, kind: v.type === 'entryPoint' ? 'entry' : 'exit' }));
}

/** A state machine found in the workspace that submachine states can reference. */
export interface MachineInfo {
  /** href relative to the referencing file, e.g. `Payment.fsm#sm`. */
  href: string;
  name: string;
  file: string;
  points: ConnectionPointInfo[];
}

/** What is known about the machines referenced by submachine states, keyed by href. */
export type SubmachineInfo = Record<string, { found: boolean; name?: string; file?: string; points: ConnectionPointInfo[] }>;

export function defaultModel(name = 'StateMachine'): FsmModel {
  return {
    version: 1,
    id: 'sm',
    name,
    kind: 'behavioral',
    context: '',
    documentation: '',
    regions: [{ id: 'r_root', name: '' }],
    vertices: [
      { id: 'v_init', type: 'initial', name: '', parent: 'r_root', x: 60, y: 80, w: 20, h: 20 },
      { id: 'v_idle', type: 'state', name: 'Idle', parent: 'r_root', x: 160, y: 60, w: 140, h: 60, regions: [] },
    ],
    transitions: [
      { id: 't_init', source: 'v_init', target: 'v_idle', kind: 'external', triggers: [], guard: '', effect: '' },
    ],
  };
}

/** Fills in defaults so partially specified models are safe to use. */
export function normalizeModel(m: FsmModel): FsmModel {
  m.version = 1;
  m.id = m.id || 'sm';
  m.regions = Array.isArray(m.regions) && m.regions.length ? m.regions : [{ id: 'r_root', name: '' }];
  m.vertices = Array.isArray(m.vertices) ? m.vertices : [];
  m.transitions = Array.isArray(m.transitions) ? m.transitions : [];
  m.kind = m.kind === 'protocol' ? 'protocol' : 'behavioral';
  for (const v of m.vertices) {
    v.name = v.name ?? '';
    v.regions = v.regions ?? [];
  }
  normalizeGroups(m);
  const types = new Map(m.vertices.map((v) => [v.id, v.type]));
  for (const t of m.transitions) {
    t.triggers = t.triggers ?? [];
    t.guard = t.guard ?? '';
    t.effect = t.effect ?? '';
    t.kind = t.kind ?? 'external';
    // A state's self-transition is a loop whose bend points are its three corners, or only its
    // far corner: other numbers of free bend points, from older versions, go back to the default loop.
    const n = t.points?.length ?? 0;
    if (t.source === t.target && t.kind !== 'internal' && types.get(t.source) === 'state' && (n === 2 || n > 3)) {
      delete t.points;
      delete t.labelOffset;
    }
  }
  return m;
}

/**
 * Keeps the groups the diagram can show. A group is the vertices sharing a `group` id: those on a state's
 * border leave it, and so do those outside the region of its first member (in file order). A group left
 * with fewer than two members is dissolved.
 */
export function normalizeGroups(m: FsmModel): void {
  const vertices = new Map(m.vertices.map((v) => [v.id, v]));
  const parents = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const v of m.vertices) {
    if (typeof v.group !== 'string' || !v.group || isBorderVertex(v, vertices)) {
      delete v.group;
      continue;
    }
    const parent = parents.get(v.group);
    if (parent === undefined) parents.set(v.group, v.parent);
    else if (parent !== v.parent) {
      delete v.group;
      continue;
    }
    counts.set(v.group, (counts.get(v.group) ?? 0) + 1);
  }
  for (const v of m.vertices) if (v.group && (counts.get(v.group) ?? 0) < 2) delete v.group;
}

/** Helper giving tree navigation over the flat model. */
export class ModelIndex {
  readonly vertices = new Map<string, Vertex>();
  readonly regionOwner = new Map<string, Vertex | null>();

  constructor(readonly model: FsmModel) {
    for (const r of model.regions) {
      this.regionOwner.set(r.id, null);
    }
    for (const v of model.vertices) {
      this.vertices.set(v.id, v);
      for (const r of v.regions ?? []) {
        this.regionOwner.set(r.id, v);
      }
    }
  }

  childrenOf(regionOrStateId: string): Vertex[] {
    return this.model.vertices.filter((v) => v.parent === regionOrStateId);
  }

  connectionPoints(state: Vertex): Vertex[] {
    return this.model.vertices.filter(
      (v) => v.parent === state.id && (v.type === 'entryPoint' || v.type === 'exitPoint' || v.type === 'connectionPointRef'),
    );
  }

  outgoing(id: string): Transition[] {
    return this.model.transitions.filter((t) => t.source === id);
  }

  incoming(id: string): Transition[] {
    return this.model.transitions.filter((t) => t.target === id);
  }

  /** The state that directly contains `v` (through a region, or as a connection point). */
  ownerState(v: Vertex): Vertex | null {
    if (isBorderVertex(v, this.vertices)) {
      return this.vertices.get(v.parent) ?? null;
    }
    return this.regionOwner.get(v.parent) ?? null;
  }

  /** Enclosing states, innermost first. */
  ancestors(v: Vertex): Vertex[] {
    const out: Vertex[] = [];
    const seen = new Set<string>([v.id]);
    let o = this.ownerState(v);
    while (o && !seen.has(o.id)) {
      seen.add(o.id);
      out.push(o);
      o = this.ownerState(o);
    }
    return out;
  }

  isInside(v: Vertex, stateId: string): boolean {
    return this.ancestors(v).some((a) => a.id === stateId);
  }

  initialOf(regionId: string): Vertex | undefined {
    return this.model.vertices.find((v) => v.parent === regionId && v.type === 'initial');
  }
}
