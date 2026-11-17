/**
 * The file format: a machine is two JSON files, `<Name>.fsm` (the model, without ids: elements are identified by
 * their names) and `<Name>.fsm.layout` beside it (the drawing). Described in fsm-cli's README ("The .fsm file
 * format") and by its JSON Schemas, which `npm run build:fsm` copies into `fsm/schemas/`.
 *
 * Reading the model is fsm-cli's reader (`src/format.rs`), problem for problem: the same messages at the same lines,
 * and the same ids, derived from the names (an element: its name; a point: `<owner>.<point>`; `<owner>.initial`,
 * `.history`, `.deepHistory`; the only region of a state or of the machine: `<owner>.`; a transition:
 * `<source>#<n>`; an id already taken gets `~2`, `~3`...). The editor works on the flat `FsmModel` of model.ts, with
 * absolute coordinates; the layout file holds them relative to their owner (`applyLayout`, `writeMachine`).
 *
 * A reference that names nothing is kept as it is: a transition's target is then UNRESOLVED followed by the
 * reference, a comment's anchor UNRESOLVED (a reference) or UNRESOLVED_ANCHOR (a transition, as JSON) followed by it.
 */
import { JsonField, JsonNode, Out, OutObject, fieldsOf, getField, itemsOf, numOf, parseJson, JsonSyntaxError, plain, strOf, writeJson } from './json';
import { FsmModel, ITEM_COLOR_KEYS, ItemColorKey, ItemColors, Region, Transition, Vertex, VertexType, isBorderVertex, isColor, normalizeGroups } from './model';

export const UNRESOLVED = '';
export const UNRESOLVED_ANCHOR = '';

/** The reference of a target that names nothing ('' for an `initial` without `target`), or undefined. */
export const unresolved = (target: string): string | undefined => (target.startsWith(UNRESOLVED) ? target.slice(1) : undefined);

/** A problem of a file's text or shape, with its line. */
export interface Problem {
  line: number;
  message: string;
}

/** Whether a text is a file in the old format (XMI). */
export const isOldFormat = (text: string) => /^[﻿ \t\r\n]*</.test(text);

const n1 = (n: number) => Math.round(n * 10) / 10;

/** The size of each kind of vertex when the layout has none (the editor's defaults). */
export const DEFAULT_SIZE: Record<VertexType, [number, number]> = {
  state: [140, 60], final: [26, 26], initial: [20, 20], shallowHistory: [26, 26], deepHistory: [26, 26],
  choice: [28, 28], junction: [14, 14], fork: [90, 8], join: [90, 8], entryPoint: [16, 16], exitPoint: [16, 16],
  terminate: [20, 20], connectionPointRef: [16, 16], comment: [160, 64],
};
/** Kinds the editor lets the user resize: the layout holds their width and height. */
export const RESIZABLE = new Set<VertexType>(['state', 'comment', 'fork', 'join']);

/** Item colors: their keys in the layout file. */
const ITEM_COLOR_FILE_KEY: Record<ItemColorKey, string> = {
  background: 'background', entry: 'entry', exit: 'exit', doActivity: 'do', deferrable: 'defer', invariant: 'invariant',
  triggers: 'trigger', guard: 'guard', action: 'action', precondition: 'precondition', postcondition: 'postcondition',
};
const ITEM_COLOR_FROM_FILE = Object.fromEntries(Object.entries(ITEM_COLOR_FILE_KEY).map(([k, v]) => [v, k])) as Record<string, ItemColorKey>;

/** Element types of the file, and the vertex types they are. */
const ELEMENT_TYPES = ['state', 'choice', 'junction', 'fork', 'join', 'final', 'terminate', 'comment'] as const;
const REGION_FIELDS = ['initial', 'history', 'deepHistory', 'elements'];
const ELEMENT_KINDS = new Set<VertexType>(ELEMENT_TYPES);

// ------------------------------------------------------------------ shape of the model file (format.rs's Shape)

const oneOf = (values: readonly string[]) => {
  const q = values.map((v) => `"${v}"`);
  return q.length === 1 ? q[0] : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`;
};
const formatNumber = (n: number) => String(n);

class Shape {
  readonly problems: Problem[] = [];

  add(line: number, message: string) {
    this.problems.push({ line, message });
  }

  kind(f: JsonField, kind: 'text' | 'object' | 'list'): boolean {
    const ok = kind === 'text' ? f.value.kind === 'string' : kind === 'object' ? f.value.kind === 'object' : f.value.kind === 'array';
    if (!ok) this.add(f.value.line, `Field '${f.key}' must be ${kind === 'text' ? 'a text' : kind === 'object' ? 'an object' : 'a list'}.`);
    return ok;
  }

  object(node: JsonNode, what: string, allowed: readonly string[], required: readonly string[], check: (f: JsonField) => void) {
    const fields = fieldsOf(node) ?? [];
    for (const f of fields) {
      if (allowed.includes(f.key)) check(f);
      else this.add(f.line, `Unknown field '${f.key}' in ${what}.`);
    }
    for (const r of required) if (!fields.some((f) => f.key === r)) this.add(node.line, `Missing field '${r}' in ${what}.`);
  }

  list(f: JsonField, item: (x: JsonNode) => void) {
    if (!this.kind(f, 'list')) return;
    for (const x of itemsOf(f.value) ?? []) {
      if (x.kind !== 'object') this.add(x.line, `Items of '${f.key}' must be objects.`);
      else item(x);
    }
  }

  enumeration(f: JsonField, values: readonly string[]): boolean {
    if (!this.kind(f, 'text')) return false;
    if (values.includes(strOf(f.value)!)) return true;
    this.add(f.value.line, `Field '${f.key}' must be ${oneOf(values)}.`);
    return false;
  }

  machine(node: JsonNode) {
    const fields = fieldsOf(node);
    if (!fields) {
      this.add(node.line, 'The file must hold a JSON object.');
      return;
    }
    const allowed = ['$schema', 'format', 'name', 'type', 'documentation', 'points', 'regions', ...REGION_FIELDS];
    this.object(node, 'the machine', allowed, ['format', 'name', 'type'], (f) => {
      switch (f.key) {
        case 'format': {
          const n = numOf(f.value);
          if (n === 1) break;
          if (n !== undefined && n > 1 && Number.isInteger(n)) this.add(f.value.line, `This file is in format ${formatNumber(n)}: this version reads format 1 only.`);
          else this.add(f.value.line, "Field 'format' must be 1.");
          break;
        }
        case 'type':
          this.enumeration(f, ['behavioral', 'protocol']);
          break;
        case 'points':
          this.list(f, (x) => this.point(x));
          break;
        case '$schema':
        case 'name':
        case 'documentation':
          this.kind(f, 'text');
          break;
        default:
          this.regionField(f);
      }
    });
    this.regionsAlone(fields);
  }

  regionsAlone(fields: JsonField[]) {
    if (!fields.some((f) => f.key === 'regions')) return;
    for (const f of fields) {
      if (REGION_FIELDS.includes(f.key)) this.add(f.line, `Field '${f.key}' cannot be used with 'regions': each region has its own.`);
    }
  }

  regionField(f: JsonField) {
    if (f.key === 'initial' || f.key === 'history' || f.key === 'deepHistory') {
      if (this.kind(f, 'object')) this.object(f.value, `'${f.key}'`, ['target', 'action'], [], (g) => this.kind(g, 'text'));
      return;
    }
    if (f.key === 'elements') {
      this.list(f, (x) => this.element(x));
      return;
    }
    if (!this.kind(f, 'list')) return;
    const items = itemsOf(f.value)!;
    if (items.length < 2) {
      this.add(f.value.line, "Field 'regions' needs two regions or more: the fields of a single region go directly in its owner.");
    }
    for (const x of items) {
      if (x.kind !== 'object') {
        this.add(x.line, "Items of 'regions' must be objects.");
        continue;
      }
      this.object(x, 'a region', ['name', ...REGION_FIELDS], ['name'], (g) => {
        if (g.key === 'name') this.kind(g, 'text');
        else this.regionField(g);
      });
    }
  }

  element(node: JsonNode) {
    const t = getField(node, 'type');
    const ty = strOf(t?.value);
    if (!ty || !(ELEMENT_TYPES as readonly string[]).includes(ty)) {
      for (const f of fieldsOf(node) ?? []) {
        if (f.key === 'name') this.kind(f, 'text');
        else if (f.key === 'type') this.enumeration(f, ELEMENT_TYPES);
      }
      for (const r of ['name', 'type']) if (!getField(node, r)) this.add(node.line, `Missing field '${r}' in an element.`);
      return;
    }
    const [what, extra]: [string, string[]] =
      ty === 'state'
        ? ['a state', ['stereotype', 'submachine', 'entry', 'do', 'exit', 'defer', 'invariant', 'transitions', 'points', 'initial', 'history', 'deepHistory', 'elements', 'regions']]
        : ty === 'choice' || ty === 'junction' || ty === 'fork' || ty === 'join'
          ? [`a ${ty}`, ['transitions']]
          : ty === 'final'
            ? ['a final state', []]
            : ty === 'terminate'
              ? ['a terminate pseudostate', []]
              : ['a comment', ['text', 'anchors']];
    this.object(node, what, ['name', 'type', ...extra], ['name', 'type'], (f) => {
      switch (f.key) {
        case 'type':
          break;
        case 'transitions':
          this.list(f, (x) => this.transition(x));
          break;
        case 'points':
          this.list(f, (x) => this.point(x));
          break;
        case 'anchors':
          if (this.kind(f, 'list')) {
            for (const x of itemsOf(f.value)!) {
              if (x.kind === 'string') continue;
              if (x.kind === 'object') this.object(x, 'a comment anchor', ['source', 'trigger', 'target'], ['source'], (g) => this.kind(g, 'text'));
              else this.add(x.line, "Items of 'anchors' must be texts or objects.");
            }
          }
          break;
        case 'initial':
        case 'history':
        case 'deepHistory':
        case 'elements':
        case 'regions':
          this.regionField(f);
          break;
        default:
          this.kind(f, 'text');
      }
    });
    if (ty === 'state') this.regionsAlone(fieldsOf(node)!);
  }

  point(node: JsonNode) {
    this.object(node, 'a point', ['name', 'type', 'transitions'], ['name', 'type'], (f) => {
      if (f.key === 'type') this.enumeration(f, ['entryPoint', 'exitPoint']);
      else if (f.key === 'transitions') this.list(f, (x) => this.transition(x));
      else this.kind(f, 'text');
    });
  }

  transition(node: JsonNode) {
    this.object(node, 'a transition', ['type', 'trigger', 'guard', 'action', 'precondition', 'postcondition', 'target'], ['type'], (f) => {
      if (f.key === 'type') this.enumeration(f, ['external', 'internal', 'local']);
      else this.kind(f, 'text');
    });
    const ty = strOf(getField(node, 'type')?.value);
    const target = getField(node, 'target');
    if (ty === 'internal' && target) this.add(target.line, "An internal transition has no 'target'.");
    else if ((ty === 'external' || ty === 'local') && !target) this.add(node.line, "Missing field 'target' in a transition.");
  }
}

/** The problems of a model document's shape (none when it is a machine file). */
export function shapeProblems(node: JsonNode): Problem[] {
  const s = new Shape();
  s.machine(node);
  return s.problems;
}

// ------------------------------------------------------------------ reading the model (format.rs's Builder)

const text = (node: JsonNode, key: string) => strOf(getField(node, key)?.value) ?? '';
const list = (node: JsonNode, key: string) => itemsOf(getField(node, key)?.value) ?? [];
/** Triggers or deferred events written `a, b, c`. */
export const splitEvents = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** A machine read from its model file. */
export interface ReadMachine {
  model: FsmModel;
  /** Line of each element, region, point and transition, by id. */
  lines: Map<string, number>;
}

class Builder {
  readonly model: FsmModel;
  readonly lines = new Map<string, number>();
  readonly taken = new Set<string>();
  readonly byName = new Map<string, string>();
  readonly pseudo = new Map<string, string>();
  readonly points = new Map<string, string>();
  readonly pending: [string, JsonNode, boolean][] = [];
  /** Comments and their anchors' nodes, resolved once every transition is known. */
  readonly anchors: [Vertex, JsonNode[]][] = [];

  constructor(model: FsmModel) {
    this.model = model;
  }

  alloc(base: string): string {
    let id = base;
    for (let n = 2; this.taken.has(id); n++) id = `${base}~${n}`;
    this.taken.add(id);
    return id;
  }

  named(name: string): string {
    const id = this.alloc(name || '~');
    if (!this.byName.has(name)) this.byName.set(name, id);
    return id;
  }

  region(node: JsonNode, id: string, owner: string) {
    for (const [key, type] of [['initial', 'initial'], ['history', 'shallowHistory'], ['deepHistory', 'deepHistory']] as const) {
      const f = getField(node, key);
      if (!f) continue;
      const vid = this.alloc(`${owner}.${key}`);
      if (key !== 'initial' && !this.pseudo.has(`${owner}.${key}`)) this.pseudo.set(`${owner}.${key}`, vid);
      this.lines.set(vid, f.line);
      this.model.vertices.push(vertex(vid, type, '', id));
      const x = f.value;
      // The default transition, when there is one: a target or an action (an action without a target is reported).
      if (getField(x, 'target') || getField(x, 'action')) this.pending.push([vid, x, true]);
    }
    for (const e of list(node, 'elements')) this.element(e, id);
  }

  element(e: JsonNode, parent: string) {
    const name = text(e, 'name');
    const id = this.named(name);
    this.lines.set(id, e.line);
    const type = text(e, 'type') as VertexType;
    const v = vertex(id, ELEMENT_KINDS.has(type) ? type : 'comment', name, parent);
    if (v.type === 'comment') {
      v.text = text(e, 'text');
      v.anchors = [];
      this.anchors.push([v, list(e, 'anchors')]);
    }
    if (v.type !== 'state') {
      this.model.vertices.push(v);
      for (const t of list(e, 'transitions')) this.pending.push([id, t, false]);
      return;
    }
    const opt = (k: string) => text(e, k) || undefined;
    if (opt('stereotype')) v.stereotype = opt('stereotype');
    if (opt('entry')) v.entry = opt('entry');
    if (opt('exit')) v.exit = opt('exit');
    if (opt('do')) v.doActivity = opt('do');
    if (opt('invariant')) v.invariant = opt('invariant');
    const defer = splitEvents(text(e, 'defer'));
    if (defer.length) v.deferrable = defer;
    const sub = strOf(getField(e, 'submachine')?.value);
    if (sub !== undefined) v.submachine = sub;
    this.model.vertices.push(v);
    for (const t of list(e, 'transitions')) this.pending.push([id, t, false]);
    this.pointsOf(e, id, name, id, true);
    const sources: [Region, JsonNode, string][] = [];
    const regs = getField(e, 'regions');
    if (regs) {
      for (const r of itemsOf(regs.value) ?? []) {
        const rname = text(r, 'name');
        const rid = this.named(rname);
        this.lines.set(rid, r.line);
        sources.push([{ id: rid, name: rname }, r, rname]);
      }
    } else if (REGION_FIELDS.some((k) => getField(e, k))) {
      const rid = this.alloc(`${name}.`);
      this.lines.set(rid, e.line);
      sources.push([{ id: rid, name: '' }, e, name]);
    }
    for (const [r, node, owner] of sources) {
      v.regions!.push(r);
      this.region(node, r.id, owner);
    }
  }

  pointsOf(node: JsonNode, ownerId: string, ownerName: string, parent: string, state: boolean) {
    const refs = state && !!getField(node, 'submachine');
    for (const p of list(node, 'points')) {
      const name = text(p, 'name');
      const entry = text(p, 'type') === 'entryPoint';
      const key = `${ownerName}.${name}`;
      const id = this.alloc(key);
      if (!this.points.has(key)) this.points.set(key, id);
      this.lines.set(id, p.line);
      const v = refs
        ? { ...vertex(id, 'connectionPointRef', '', ownerId), ref: name, pointKind: entry ? ('entry' as const) : ('exit' as const) }
        : vertex(id, entry ? 'entryPoint' : 'exitPoint', name, parent);
      this.model.vertices.push(v);
      for (const t of list(p, 'transitions')) this.pending.push([id, t, false]);
    }
  }

  resolve(reference: string): string {
    const dot = reference.indexOf('.');
    let found: string | undefined;
    if (dot < 0) found = this.byName.get(reference);
    else {
      const rest = reference.slice(dot + 1);
      found = rest === 'history' || rest === 'deepHistory' ? this.pseudo.get(reference) : this.points.get(reference);
    }
    return found ?? UNRESOLVED + reference;
  }

  /**
   * A comment's anchors, as ids: a reference names an element, an object a transition (under its source, by its
   * trigger and target, then by order among identical ones). One that names nothing is kept: UNRESOLVED followed by
   * the reference, UNRESOLVED_ANCHOR followed by the object as JSON.
   */
  resolveAnchors(vertexIds: Set<string>) {
    for (const [v, nodes] of this.anchors) {
      const used = new Set<Transition>();
      v.anchors = nodes.map((a) => {
        if (a.kind === 'string') {
          const id = this.resolve(a.value as string);
          return vertexIds.has(id) ? id : UNRESOLVED + (a.value as string);
        }
        const source = this.resolve(text(a, 'source'));
        const trigger = splitEvents(text(a, 'trigger')).join(', ');
        const ref = strOf(getField(a, 'target')?.value);
        const target = ref === undefined ? undefined : this.resolve(ref);
        const t = this.model.transitions.find(
          (x) => !used.has(x) && x.source === source && x.triggers.join(', ') === trigger && (target === undefined ? x.kind === 'internal' : x.kind !== 'internal' && x.target === target),
        );
        if (!t) return UNRESOLVED_ANCHOR + JSON.stringify(plain(a));
        used.add(t);
        return t.id;
      });
    }
  }
}

function vertex(id: string, type: VertexType, name: string, parent: string): Vertex {
  return { id, type, name, parent, x: NaN, y: NaN, w: 0, h: 0, regions: [] };
}

/** Reads a model file. Returns its problems when it can't be read (not JSON, or a wrong shape). */
export function readModel(source: string): ReadMachine | { problems: Problem[] } {
  let root: JsonNode;
  try {
    root = parseJson(source);
  } catch (e) {
    if (e instanceof JsonSyntaxError) return { problems: [{ line: e.line, message: e.message }] };
    throw e;
  }
  const problems = shapeProblems(root);
  if (problems.length) return { problems };
  const name = text(root, 'name');
  const model: FsmModel = {
    version: 1,
    name,
    kind: text(root, 'type') === 'protocol' ? 'protocol' : 'behavioral',
    documentation: text(root, 'documentation'),
    regions: [],
    vertices: [],
    transitions: [],
  };
  const b = new Builder(model);
  const sources: [JsonNode, string, string][] = [];
  const regs = getField(root, 'regions');
  if (regs) {
    for (const r of itemsOf(regs.value)!) {
      const rname = text(r, 'name');
      const rid = b.named(rname);
      b.lines.set(rid, r.line);
      model.regions.push({ id: rid, name: rname });
      sources.push([r, rid, rname]);
    }
  } else {
    const rid = b.alloc(`${name}.`);
    model.regions.push({ id: rid, name: '' });
    sources.push([root, rid, name]);
  }
  for (const [node, id, owner] of sources) b.region(node, id, owner);
  b.pointsOf(root, '', name, model.regions[0].id, false);

  const count = new Map<string, number>();
  for (const [source, node, isDefault] of b.pending) {
    const n = (count.get(source) ?? 0) + 1;
    count.set(source, n);
    const id = b.alloc(`${source}#${n}`);
    b.lines.set(id, node.line);
    const ty = text(node, 'type');
    const kind = ty === 'internal' ? 'internal' : ty === 'local' ? 'local' : 'external';
    const ref = strOf(getField(node, 'target')?.value);
    const target = ref !== undefined ? b.resolve(ref) : kind === 'internal' && !isDefault ? source : UNRESOLVED;
    const t: Transition = { id, source, target, kind, triggers: splitEvents(text(node, 'trigger')), guard: text(node, 'guard'), action: text(node, 'action') };
    if (text(node, 'precondition')) t.precondition = text(node, 'precondition');
    if (text(node, 'postcondition')) t.postcondition = text(node, 'postcondition');
    model.transitions.push(t);
  }
  b.resolveAnchors(new Set(model.vertices.map((v) => v.id)));
  return { model, lines: b.lines };
}

// ------------------------------------------------------------------ references

/** What the writer needs to know about the model: owners, names and references. */
class Index {
  readonly V = new Map<string, Vertex>();
  readonly T = new Map<string, Transition>();
  readonly regionOwner = new Map<string, Vertex | null>();
  readonly regions = new Map<string, Region>();
  readonly top: Set<string>;

  constructor(readonly model: FsmModel) {
    for (const r of model.regions) {
      this.regionOwner.set(r.id, null);
      this.regions.set(r.id, r);
    }
    for (const v of model.vertices) {
      if (!this.V.has(v.id)) this.V.set(v.id, v);
      for (const r of v.regions ?? []) {
        this.regionOwner.set(r.id, v);
        this.regions.set(r.id, r);
      }
    }
    for (const t of model.transitions) if (!this.T.has(t.id)) this.T.set(t.id, t);
    this.top = new Set(model.regions.map((r) => r.id));
  }

  isBorder(v: Vertex): boolean {
    return isBorderVertex(v, this.V);
  }

  isMachinePoint(v: Vertex): boolean {
    return (v.type === 'entryPoint' || v.type === 'exitPoint') && this.top.has(v.parent);
  }

  /** The owner of a region's history pseudostates in references: its state, the region when there are several, the machine. */
  regionRefOwner(regionId: string): string {
    const owner = this.regionOwner.get(regionId);
    const r = this.regions.get(regionId);
    if (owner) return (owner.regions ?? []).length > 1 ? r?.name ?? '' : owner.name;
    return this.model.regions.length > 1 ? r?.name ?? '' : this.model.name;
  }

  /** The point name of a border vertex or machine point. */
  pointName(v: Vertex): string {
    return v.type === 'connectionPointRef' ? v.ref ?? '' : v.name;
  }

  /** The reference to a vertex, or undefined when it can't be referenced (an initial pseudostate). */
  ref(id: string): string | undefined {
    const u = unresolved(id);
    if (u !== undefined) return u;
    const v = this.V.get(id);
    if (!v) return id;
    if (v.type === 'initial') return undefined;
    if (v.type === 'shallowHistory' || v.type === 'deepHistory') {
      return `${this.regionRefOwner(v.parent)}.${v.type === 'shallowHistory' ? 'history' : 'deepHistory'}`;
    }
    if (this.isBorder(v)) return `${this.V.get(v.parent)?.name ?? ''}.${this.pointName(v)}`;
    if (this.isMachinePoint(v)) return `${this.model.name}.${v.name}`;
    return v.name;
  }

  /** The innermost state that contains both ends of `t` (or is one of them), or null: its bend points are relative to it. */
  frame(t: Transition): Vertex | null {
    const chain = (id: string) => {
      const out: Vertex[] = [];
      let v = this.V.get(id);
      const seen = new Set<Vertex>();
      if (v && v.type !== 'state') v = this.owner(v) ?? undefined;
      while (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
        v = this.owner(v) ?? undefined;
      }
      return out;
    };
    const s = chain(t.source);
    const g = new Set(chain(t.target));
    return s.find((v) => g.has(v)) ?? null;
  }

  owner(v: Vertex): Vertex | null {
    return (this.isBorder(v) ? this.V.get(v.parent) : this.regionOwner.get(v.parent)) ?? null;
  }

  /**
   * A comment's anchor as the file writes it: a reference, or for a transition `{ source, trigger, target }`; one that
   * named nothing as it was read. Undefined when the file can't hold it (an initial pseudostate, a transition from
   * one), null when it names nothing in the model.
   */
  anchor(a: string): Out | undefined | null {
    if (a.startsWith(UNRESOLVED)) return a.slice(1);
    if (a.startsWith(UNRESOLVED_ANCHOR)) return JSON.parse(a.slice(1)) as OutObject;
    if (this.V.has(a)) return this.ref(a);
    const t = this.T.get(a);
    if (!t) return null;
    const source = this.ref(t.source);
    if (source === undefined || !this.V.has(t.source)) return undefined;
    const ao: OutObject = { source };
    if (t.triggers.length) ao.trigger = t.triggers.join(', ');
    if (t.kind !== 'internal') {
      const target = this.ref(t.target);
      if (target !== undefined) ao.target = target;
    }
    return ao;
  }
}

/**
 * How `model` refers to its element or transition `id` in a comment's anchor, kept as a reference that names nothing
 * (UNRESOLVED or UNRESOLVED_ANCHOR followed by it): for a model where it doesn't exist (yet). Undefined when it can't be
 * referred to.
 */
export function unresolvedAnchor(model: FsmModel, id: string): string | undefined {
  const a = new Index(model).anchor(id);
  if (a === undefined || a === null) return undefined;
  return typeof a === 'string' ? UNRESOLVED + a : UNRESOLVED_ANCHOR + JSON.stringify(a);
}

/** How `model` refers to its vertex `id` (a transition's target), or undefined when it can't be referred to. */
export function referenceOf(model: FsmModel, id: string): string | undefined {
  return new Index(model).ref(id);
}

// ------------------------------------------------------------------ writing

/** What writing a machine gives. */
export interface Written {
  /** The model file. */
  model: string;
  /** The layout file. */
  layout: string;
  /** Line of each vertex and transition in the model file, by id. */
  lines: Map<string, number>;
  /** What the format can't hold, which was left out (an editor's model holds none of it). */
  lost: string[];
}

const LABEL: Partial<Record<VertexType, string>> = {
  state: 'state', final: 'final state', initial: 'initial pseudostate', shallowHistory: 'shallow history', deepHistory: 'deep history',
  choice: 'choice', junction: 'junction', fork: 'fork', join: 'join', entryPoint: 'entry point', exitPoint: 'exit point',
  terminate: 'terminate pseudostate', connectionPointRef: 'connection point reference', comment: 'comment',
};

/** Writes a machine: its model and layout files. Names must have been given (`assignNames`). */
export function writeMachine(model: FsmModel): Written {
  const ix = new Index(model);
  const lost: string[] = [];
  const done = new Set<Vertex>();
  const doneT = new Set<Transition>();
  const ids = new Map<OutObject, string>();
  const tids = new Map<OutObject, string>();
  const describe = (v: Vertex) => (v.name ? `${LABEL[v.type]} '${v.name}'` : `an unnamed ${LABEL[v.type]}`);
  const outgoing = new Map<string, Transition[]>();
  for (const t of model.transitions) {
    const l = outgoing.get(t.source);
    if (l) l.push(t);
    else outgoing.set(t.source, [t]);
  }
  const describeT = (t: Transition) => {
    const s = ix.V.get(t.source);
    return `the transition from ${s ? describe(s) : `'${t.source}'`}${t.triggers.length ? ` on ${t.triggers.join(', ')}` : ''}`;
  };

  /** Layout values: numbers rounded to 0.1 px. */
  const xy = (x: number, y: number): OutObject => ({ x: n1(x), y: n1(y) });
  /** Whether a layout value is a number once rounded (a huge one isn't). */
  const finite = (n: number) => Number.isFinite(n1(n));
  /** A vertex's place relative to `at` (a place that isn't a number, from an old file, is the origin's). */
  const position = (v: Vertex, at: { x: number; y: number }): OutObject => {
    const dx = v.x - at.x;
    const dy = v.y - at.y;
    if (finite(dx) && finite(dy)) return xy(dx, dy);
    lost.push(`the place of ${describe(v)}, which is not a number`);
    return xy(finite(dx) ? dx : 0, finite(dy) ? dy : 0);
  };
  const colors = (e: { color?: string; itemColors?: ItemColors }, into: OutObject) => {
    if (isColor(e.color)) into.color = e.color;
    const items: OutObject = {};
    for (const k of ITEM_COLOR_KEYS) if (isColor(e.itemColors?.[k])) items[ITEM_COLOR_FILE_KEY[k]] = e.itemColors![k]!;
    if (Object.keys(items).length) into.itemColors = items;
  };
  /** Where the places inside `v` are measured from (its own place, when it is a number: else written as the origin's). */
  const origin = (v: Vertex | null | undefined) => ({ x: v && finite(v.x) ? v.x : 0, y: v && finite(v.y) ? v.y : 0 });

  /**
   * A transition's fields in the model file, its layout entry (null when it has nothing to store) and that entry
   * without what it stores (its trigger and target, which find it); null when the file can't hold it (a transition to
   * an initial pseudostate).
   */
  const transition = (t: Transition): [OutObject, OutObject | null, OutObject] | null => {
    doneT.add(t);
    const o: OutObject = { type: t.kind };
    if (t.triggers.length) o.trigger = t.triggers.join(', ');
    if (t.guard) o.guard = t.guard;
    if (t.action) o.action = t.action;
    if (t.precondition) o.precondition = t.precondition;
    if (t.postcondition) o.postcondition = t.postcondition;
    let target: string | undefined;
    if (t.kind === 'internal') {
      if (t.target !== t.source) lost.push(`the target of the internal ${describeT(t).slice(4)}`);
    } else {
      target = ix.ref(t.target);
      if (target === undefined) {
        lost.push(`${describeT(t)} to an initial pseudostate`);
        return null;
      }
      o.target = target;
    }
    tids.set(o, t.id);
    const key: OutObject = {};
    if (o.trigger) key.trigger = o.trigger;
    if (target !== undefined) key.target = target;
    return [o, transitionLayout(t, o.trigger as string | undefined, target), key];
  };
  const transitionLayout = (t: Transition, trigger: string | undefined, target: string | undefined): OutObject | null => {
    const l: OutObject = {};
    if (trigger) l.trigger = trigger;
    if (target !== undefined) l.target = target;
    const keys = Object.keys(l).length;
    if (t.points?.length && t.kind !== 'internal') {
      const f = origin(ix.frame(t));
      const bends = t.points.filter((p) => finite(p.x - f.x) && finite(p.y - f.y));
      if (bends.length < t.points.length) lost.push(`bend points of ${describeT(t)} that are not numbers`);
      if (bends.length) l.bends = bends.map((p) => xy(p.x - f.x, p.y - f.y));
    }
    if (t.labelOffset && t.kind !== 'internal') {
      if (finite(t.labelOffset.x) && finite(t.labelOffset.y)) l.label = xy(t.labelOffset.x, t.labelOffset.y);
      else lost.push(`the label position of ${describeT(t)}, which is not a number`);
    }
    colors(t, l);
    return Object.keys(l).length > keys ? l : null;
  };
  /**
   * The transitions leaving `v`, into the model object and layout entry. Layout entries are found by trigger and
   * target, then by order among identical ones: a transition with nothing to store gets an entry anyway (its trigger
   * and target) when a later one with the same trigger and target has one, so that each keeps its own.
   */
  const transitionsOf = (v: Vertex, o: OutObject, l: OutObject) => {
    const list = outgoing.get(v.id) ?? [];
    if (!list.length) return;
    const mo: Out[] = [];
    const written: [OutObject | null, OutObject, string][] = [];
    for (const t of list) {
      const w = transition(t);
      if (!w) continue;
      mo.push(w[0]);
      written.push([w[1], w[2], JSON.stringify(w[2])]);
    }
    const lo: Out[] = [];
    written.forEach(([entry, key, k], i) => {
      if (entry) lo.push(entry);
      else if (written.some(([e, , k2], j) => j > i && e && k2 === k)) lo.push(key);
    });
    if (mo.length) o.transitions = mo;
    if (lo.length) l.transitions = lo;
  };

  const pointsOf = (owner: Vertex | null, points: Vertex[], o: OutObject, l: OutObject) => {
    if (!points.length) return;
    const mo: Out[] = [];
    const lo: Out[] = [];
    const at = origin(owner);
    for (const p of points) {
      done.add(p);
      // On a submachine state, the points are references to the submachine's; on another state, its own.
      if (owner && (p.type === 'connectionPointRef') !== !!owner.submachine) {
        lost.push(`${describe(p)} on ${describe(owner)}, which ${owner.submachine ? 'is' : 'is not'} a submachine state`);
        for (const t of outgoing.get(p.id) ?? []) doneT.add(t);
        continue;
      }
      const kind = p.type === 'connectionPointRef' ? (p.pointKind === 'exit' ? 'exitPoint' : 'entryPoint') : p.type;
      const po: OutObject = { name: ix.pointName(p), type: kind };
      const pl: OutObject = { name: ix.pointName(p), ...position(p, at) };
      colors(p, pl);
      if (p.group && !owner) pl.group = p.group;
      transitionsOf(p, po, pl);
      ids.set(po, p.id);
      mo.push(po);
      lo.push(pl);
    }
    if (mo.length) o.points = mo;
    if (lo.length) l.points = lo;
  };

  /** The fields of region `r` (owned by `owner`, null at the top level) into `o` and `l`. */
  const regionFields = (r: Region, owner: Vertex | null, o: OutObject, l: OutObject) => {
    // Each element is written once (a region id used twice in a file edited by hand could hold a state's own owner).
    const all = model.vertices.filter((v) => v.parent === r.id && !ix.isMachinePoint(v) && !ix.isBorder(v));
    const kids = all.filter((v) => !done.has(v));
    if (kids.length < all.length) lost.push(`the region of ${owner ? describe(owner) : 'the state machine'} as it was: its id is used twice, and its elements are written once`);
    const at = origin(owner);
    for (const [key, type] of [['initial', 'initial'], ['history', 'shallowHistory'], ['deepHistory', 'deepHistory']] as const) {
      const found = kids.filter((v) => v.type === type);
      if (!found.length) continue;
      const v = found[0];
      for (const x of found.slice(1)) {
        done.add(x);
        lost.push(`${describe(x)}: a region has at most one`);
      }
      done.add(v);
      const po: OutObject = {};
      const pl: OutObject = position(v, at);
      if (v.group) pl.group = v.group;
      const outs = outgoing.get(v.id) ?? [];
      const t = outs[0];
      if (t) {
        doneT.add(t);
        const target = ix.ref(t.target);
        if (target === undefined) lost.push(`the ${key} transition to an initial pseudostate`);
        else if (target !== '' || unresolved(t.target) === undefined) po.target = target;
        if (t.action) po.action = t.action;
        if (t.guard || t.triggers.length || t.kind !== 'external' || t.precondition || t.postcondition) lost.push(`the guard, triggers, kind or conditions of the ${key} transition`);
        // Its route, when the file holds the transition (a target or an action).
        const tl = transitionLayout(t, undefined, undefined);
        if (tl && (po.target !== undefined || po.action !== undefined)) Object.assign(pl, tl);
        tids.set(po, t.id);
      }
      for (const x of outs.slice(1)) {
        doneT.add(x);
        lost.push(`a second transition leaving the ${key} pseudostate`);
      }
      ids.set(po, v.id);
      o[key] = po;
      l[key] = pl;
    }
    const mo: Out[] = [];
    const lo: Out[] = [];
    for (const v of kids) {
      if (v.type === 'initial' || v.type === 'shallowHistory' || v.type === 'deepHistory' || done.has(v)) continue;
      if (!ELEMENT_KINDS.has(v.type)) {
        lost.push(`${describe(v)}, which only goes on the border of a state or at the top level`);
        continue;
      }
      const [eo, el] = element(v, at);
      mo.push(eo);
      lo.push(el);
    }
    // A composite state's only region, empty: written so that the state stays composite.
    if (mo.length || (owner && (owner.regions ?? []).length === 1 && !o.initial && !o.history && !o.deepHistory)) o.elements = mo;
    if (lo.length) l.elements = lo;
  };

  const regionsOf = (owner: Vertex | null, regions: Region[], o: OutObject, l: OutObject) => {
    if (regions.length === 1) {
      regionFields(regions[0], owner, o, l);
      return;
    }
    const mo: Out[] = [];
    const lo: Out[] = [];
    for (const r of regions) {
      const ro: OutObject = { name: r.name };
      const rl: OutObject = { name: r.name };
      if (owner && typeof r.size === 'number' && finite(r.size) && n1(r.size) > 0) rl.size = n1(r.size);
      regionFields(r, owner, ro, rl);
      ids.set(ro, r.id);
      mo.push(ro);
      lo.push(rl);
    }
    o.regions = mo;
    l.regions = lo;
  };

  const element = (v: Vertex, at: { x: number; y: number }): [OutObject, OutObject] => {
    done.add(v);
    const o: OutObject = { name: v.name, type: v.type };
    const l: OutObject = { name: v.name, ...position(v, at) };
    if (RESIZABLE.has(v.type)) {
      const [dw, dh] = DEFAULT_SIZE[v.type];
      l.width = n1(finite(v.w) && v.w > 0 ? v.w : dw);
      l.height = n1(finite(v.h) && v.h > 0 ? v.h : dh);
    }
    colors(v, l);
    if (v.group) l.group = v.group;
    ids.set(o, v.id);
    switch (v.type) {
      case 'state': {
        if (v.stereotype) o.stereotype = v.stereotype;
        if (v.submachine) o.submachine = v.submachine;
        if (v.entry) o.entry = v.entry;
        if (v.doActivity) o.do = v.doActivity;
        if (v.exit) o.exit = v.exit;
        if (v.deferrable?.length) o.defer = v.deferrable.join(', ');
        if (v.invariant) o.invariant = v.invariant;
        const regions = v.regions ?? [];
        if (regions.length > 1 && v.regionLayout) l.regionLayout = v.regionLayout;
        transitionsOf(v, o, l);
        const points = model.vertices.filter((p) => p.parent === v.id && (p.type === 'entryPoint' || p.type === 'exitPoint' || p.type === 'connectionPointRef'));
        pointsOf(v, points, o, l);
        if (regions.length) regionsOf(v, regions, o, l);
        break;
      }
      case 'comment': {
        if (v.text) o.text = v.text;
        const anchors: Out[] = [];
        for (const a of v.anchors ?? []) {
          const written = ix.anchor(a);
          if (written === null) lost.push(`the anchor of ${describe(v)} to '${a}', which is not an element or a transition`);
          else if (written !== undefined) anchors.push(written);
          else if (ix.V.has(a)) lost.push(`the anchor of ${describe(v)} to an initial pseudostate`);
          else lost.push(`the anchor of ${describe(v)} to ${describeT(ix.T.get(a)!)}`);
        }
        if (anchors.length) o.anchors = anchors;
        break;
      }
      case 'final':
      case 'terminate':
        if ((v.regions ?? []).length || v.entry || v.exit || v.doActivity) lost.push(`the regions and behaviors of ${describe(v)}`);
        if (outgoing.get(v.id)?.length) {
          for (const t of outgoing.get(v.id)!) doneT.add(t);
          lost.push(`the transitions leaving ${describe(v)}`);
        }
        break;
      default:
        transitionsOf(v, o, l);
    }
    return [o, l];
  };

  const mo: OutObject = { format: 1, name: model.name, type: model.kind };
  const lo: OutObject = { format: 1 };
  if (model.documentation) mo.documentation = model.documentation;
  const machinePoints = model.vertices.filter((v) => ix.isMachinePoint(v));
  pointsOf(null, machinePoints, mo, lo);
  regionsOf(null, model.regions, mo, lo);
  for (const v of model.vertices) if (!done.has(v)) lost.push(`${describe(v)}, which is not inside a known region`);
  for (const t of model.transitions) {
    if (doneT.has(t)) continue;
    const s = ix.V.get(t.source);
    lost.push(s && s.type === 'comment' ? `a transition leaving ${describe(s)}` : `${describeT(t)}, whose source does not exist`);
  }

  const lines = new Map<string, number>();
  const modelText = writeJson(
    mo,
    (o) => Object.values(o).every((x) => x === undefined || typeof x !== 'object'),
    (o, line) => {
      const id = ids.get(o);
      if (id !== undefined && !lines.has(id)) lines.set(id, line);
      const tid = tids.get(o);
      if (tid !== undefined && !lines.has(tid)) lines.set(tid, line);
    },
  );
  const layoutText = writeJson(lo, (o) => {
    const keys = Object.keys(o).filter((k) => o[k] !== undefined);
    return keys.length === 2 && keys[0] === 'x' && keys[1] === 'y';
  });
  return { model: modelText, layout: layoutText, lines, lost };
}

// ------------------------------------------------------------------ names

/** Prefix of the names generated for each kind of element. */
const GENERATED: Partial<Record<VertexType, string>> = {
  state: 'state', choice: 'choice', junction: 'junction', fork: 'fork', join: 'join', final: 'final', terminate: 'terminate',
  comment: 'comment', entryPoint: 'entry', exitPoint: 'exit',
};

/** Whether a name is a generated one, not shown on the diagram. */
export const isGenerated = (name: string) => name.endsWith('*');

/** A name changed by `assignNames`. */
export interface Rename {
  what: string;
  from: string;
  to: string;
  /** Why, when it isn't the characters replaced. */
  why?: string;
}

/**
 * Gives every element, point and region that needs a name one: a generated name (`choice1*`, smallest free number)
 * for those without. With `fix` (converting an old file), it also replaces spaces, `*` and `.` in names with `_`, numbers
 * the names used twice (`Idle2`), and renames points named `history` or `deepHistory`; it returns the renames.
 * Without it, a name used twice stays as it is (the validator reports it, and the file is saved back as it was).
 * Changes `model` in place.
 */
export function assignNames(model: FsmModel, fix = false): Rename[] {
  const renames: Rename[] = [];
  const ix = new Index(model);
  const clean = (s: string) => (fix ? s.trim().replace(/\s+/g, '_').replace(/[*.]/g, '_') : s);
  const taken = new Set<string>();
  const machine = clean(model.name);
  if (machine !== model.name) renames.push({ what: 'the state machine', from: model.name, to: machine });
  model.name = machine;
  taken.add(machine);
  // The named things in document order: regions of an owner with several, elements.
  const named: { get: () => string; set: (n: string) => void; what: string; prefix: string }[] = [];
  const regionsNamed = (regions: Region[], owner: string) => {
    if (regions.length < 2) return;
    regions.forEach((r, i) => named.push({ get: () => r.name, set: (n) => (r.name = n), what: `region ${i + 1} of ${owner}`, prefix: 'region' }));
  };
  regionsNamed(model.regions, 'the state machine');
  for (const v of model.vertices) {
    if (!ELEMENT_KINDS.has(v.type)) continue;
    named.push({ get: () => v.name, set: (n) => (v.name = n), what: `${LABEL[v.type]}`, prefix: GENERATED[v.type]! });
    if (v.type === 'state') regionsNamed(v.regions ?? [], v.name ? `'${v.name}'` : 'a state');
  }
  // Names kept first (the first of each), then the others.
  const later: typeof named = [];
  for (const n of named) {
    const name = clean(n.get());
    if (name && !taken.has(name)) {
      if (name !== n.get()) renames.push({ what: `the ${n.what}`, from: n.get(), to: name });
      n.set(name);
      taken.add(name);
    } else later.push(n);
  }
  const generate = (prefix: string, used: Set<string>) => {
    for (let i = 1; ; i++) if (!used.has(`${prefix}${i}*`)) return `${prefix}${i}*`;
  };
  for (const n of later) {
    const old = n.get();
    const base = clean(old);
    let name: string;
    if (!base) name = generate(n.prefix, taken);
    else if (!fix) continue;
    else {
      let i = 2;
      while (taken.has(`${base}${i}`)) i++;
      name = `${base}${i}`;
      renames.push({ what: `the ${n.what}`, from: old, to: name, why: 'its name was used twice' });
    }
    n.set(name);
    taken.add(name);
  }
  // Points: unique on their owner.
  const byOwner = new Map<string, Vertex[]>();
  for (const v of model.vertices) {
    if (!(ix.isBorder(v) || ix.isMachinePoint(v)) || v.type === 'connectionPointRef') continue;
    const key = ix.isMachinePoint(v) ? '' : v.parent;
    byOwner.set(key, [...(byOwner.get(key) ?? []), v]);
  }
  for (const points of byOwner.values()) {
    const used = new Set(points.map((p) => p.name).filter(Boolean));
    const seen = new Set<string>();
    for (const p of points) {
      let name = clean(p.name);
      if (fix && (name === 'history' || name === 'deepHistory')) name += '2';
      if (name && !seen.has(name)) {
        if (name !== p.name) renames.push({ what: `the ${LABEL[p.type]}`, from: p.name, to: name });
      } else if (!name) name = generate(GENERATED[p.type]!, used);
      else if (fix) {
        let i = 2;
        while (seen.has(`${name}${i}`) || used.has(`${name}${i}`)) i++;
        renames.push({ what: `the ${LABEL[p.type]}`, from: p.name, to: `${name}${i}`, why: 'its name was used twice on its state' });
        name = `${name}${i}`;
      }
      p.name = name;
      seen.add(name);
      used.add(name);
    }
  }
  return renames;
}

// ------------------------------------------------------------------ layout

/** What reading the layout gives. */
export interface LayoutResult {
  /** Why the layout file couldn't be used (it is then left out entirely), or undefined. */
  problem?: string;
  /** How many elements had no layout entry and were placed automatically. */
  placed: number;
}

const isNum = (n: JsonNode | undefined) => n?.kind === 'number';

/** Problems of the layout file's shape (the first one, enough for the warning), or undefined. */
export function layoutShapeProblem(root: JsonNode): string | undefined {
  const problems: Problem[] = [];
  const add = (line: number, message: string) => problems.push({ line, message });
  const ITEM_KEYS = Object.values(ITEM_COLOR_FILE_KEY);
  const check = (node: JsonNode, what: string, allowed: string[], required: string[], each: (f: JsonField) => void) => {
    const fields = fieldsOf(node);
    if (!fields) return add(node.line, `${what} must be an object.`);
    for (const f of fields) {
      if (allowed.includes(f.key)) each(f);
      else add(f.line, `Unknown field '${f.key}' in ${what}.`);
    }
    for (const r of required) if (!fields.some((f) => f.key === r)) add(node.line, `Missing field '${r}' in ${what}.`);
    if (fields.some((f) => f.key === 'regions')) {
      for (const f of fields) if (REGION_FIELDS.includes(f.key)) add(f.line, `Field '${f.key}' cannot be used with 'regions'.`);
    }
  };
  const point = (n: JsonNode, what: string) => check(n, what, ['x', 'y'], ['x', 'y'], (f) => !isNum(f.value) && add(f.value.line, `Field '${f.key}' must be a number.`));
  const listOf = (f: JsonField, item: (n: JsonNode) => void) => {
    const items = itemsOf(f.value);
    if (!items) return add(f.value.line, `Field '${f.key}' must be a list.`);
    items.forEach(item);
  };
  const common = (f: JsonField): boolean => {
    switch (f.key) {
      case 'x':
      case 'y':
      case 'width':
      case 'height':
      case 'size':
        if (!isNum(f.value)) add(f.value.line, `Field '${f.key}' must be a number.`);
        return true;
      case 'name':
      case 'trigger':
      case 'target':
      case 'group':
        if (f.value.kind !== 'string') add(f.value.line, `Field '${f.key}' must be a text.`);
        return true;
      case 'color':
        if (!isColor(strOf(f.value))) add(f.value.line, "Field 'color' must be a color (#rrggbb).");
        return true;
      case 'itemColors':
        check(f.value, "'itemColors'", ITEM_KEYS, [], (g) => !isColor(strOf(g.value)) && add(g.value.line, `Field '${g.key}' must be a color (#rrggbb).`));
        return true;
      case 'label':
        point(f.value, "'label'");
        return true;
      case 'bends':
        listOf(f, (n) => point(n, 'a bend point'));
        return true;
      case 'regionLayout':
        if (strOf(f.value) !== 'horizontal' && strOf(f.value) !== 'vertical') add(f.value.line, 'Field \'regionLayout\' must be "horizontal" or "vertical".');
        return true;
      case 'transitions':
        listOf(f, (n) => check(n, 'a transition', ['trigger', 'target', 'bends', 'label', 'color', 'itemColors'], [], common));
        return true;
      case 'points':
        listOf(f, (n) => check(n, 'a point', ['name', 'x', 'y', 'color', 'itemColors', 'group', 'transitions'], ['name'], common));
        return true;
      case 'initial':
      case 'history':
      case 'deepHistory':
        check(f.value, `'${f.key}'`, ['x', 'y', 'group', 'bends', 'label', 'color', 'itemColors'], [], common);
        return true;
      case 'elements':
        listOf(f, (n) => check(n, 'an element', ['name', 'x', 'y', 'width', 'height', 'color', 'itemColors', 'group', 'regionLayout', 'transitions', 'points', 'regions', ...REGION_FIELDS], ['name'], common));
        return true;
      case 'regions':
        listOf(f, (n) => check(n, 'a region', ['name', 'size', ...REGION_FIELDS], ['name'], common));
        return true;
    }
    return false;
  };
  const fields = fieldsOf(root);
  if (!fields) return 'The layout file must hold a JSON object.';
  check(root, 'the layout', ['$schema', 'format', 'points', 'regions', ...REGION_FIELDS], ['format'], (f) => {
    if (f.key === 'format') {
      if (numOf(f.value) !== 1) add(f.value.line, "Field 'format' must be 1.");
    } else if (f.key === '$schema') {
      if (f.value.kind !== 'string') add(f.value.line, "Field '$schema' must be a text.");
    } else common(f);
  });
  return problems.length ? `line ${problems[0].line}: ${problems[0].message}` : undefined;
}

/**
 * Gives the vertices of a model just read (`readModel`) their places and the transitions their routes, from the layout
 * file's text (undefined when there is none). Elements without an entry are placed automatically: default size, the
 * first free spot beside the elements already in their region, their state growing to fit. Entries that match nothing
 * are left out. The model's absolute coordinates are rounded to 0.1 px.
 */
export function applyLayout(read: ReadMachine, layoutText: string | undefined): LayoutResult {
  const { model } = read;
  const ix = new Index(model);
  const result: LayoutResult = { placed: 0 };
  let root: JsonNode | undefined;
  if (layoutText !== undefined) {
    try {
      root = parseJson(layoutText);
      const problem = layoutShapeProblem(root);
      if (problem) {
        result.problem = problem;
        root = undefined;
      }
    } catch (e) {
      if (!(e instanceof JsonSyntaxError)) throw e;
      result.problem = `line ${e.line}: ${e.message}`;
    }
  }
  /** Positions relative to the owner, before they are made absolute. */
  const rel = new Map<Vertex, { x: number; y: number }>();
  const placedV = new Set<Vertex>();
  /** Bends (relative to the frame) and labels of transitions, by transition. */
  const routes = new Map<Transition, JsonNode>();
  const num = (n: JsonNode, k: string) => numOf(getField(n, k)?.value);
  /** The place, size, colors and group of an entry; `colors` false for an initial or history entry, whose are its arrow's. */
  const setBox = (v: Vertex, entry: JsonNode, colors = true) => {
    const x = num(entry, 'x');
    const y = num(entry, 'y');
    if (x !== undefined && y !== undefined) {
      rel.set(v, { x, y });
      placedV.add(v);
    }
    const [dw, dh] = DEFAULT_SIZE[v.type];
    const w = num(entry, 'width');
    const h = num(entry, 'height');
    v.w = RESIZABLE.has(v.type) && w !== undefined && w > 0 ? w : dw;
    v.h = RESIZABLE.has(v.type) && h !== undefined && h > 0 ? h : dh;
    const color = strOf(getField(entry, 'color')?.value);
    if (colors && isColor(color)) v.color = color;
    const items = colors ? fieldsOf(getField(entry, 'itemColors')?.value) : undefined;
    if (items) {
      const ic: ItemColors = {};
      for (const f of items) {
        const k = ITEM_COLOR_FROM_FILE[f.key];
        if (k && isColor(strOf(f.value))) ic[k] = strOf(f.value);
      }
      if (Object.keys(ic).length) v.itemColors = ic;
    }
    const group = strOf(getField(entry, 'group')?.value);
    if (group) v.group = group;
  };
  /** Matches transition entries to the transitions leaving `v`: by trigger and target, then by order. */
  const matchTransitions = (sourceIds: string[], entries: JsonNode[]) => {
    const list = model.transitions.filter((t) => sourceIds.includes(t.source));
    const used = new Set<Transition>();
    for (const e of entries) {
      // The trigger as the model file may write it (`a,b`): the events it names.
      const trigger = splitEvents(strOf(getField(e, 'trigger')?.value) ?? '').join(', ');
      const target = strOf(getField(e, 'target')?.value);
      const t = list.find((x) => !used.has(x) && x.triggers.join(', ') === trigger && (x.kind === 'internal' ? target === undefined : ix.ref(x.target) === target));
      if (!t) continue;
      used.add(t);
      routes.set(t, e);
    }
  };
  const applyPoints = (owner: Vertex | null, node: JsonNode) => {
    const points = model.vertices.filter((p) => (owner ? p.parent === owner.id && ix.isBorder(p) : ix.isMachinePoint(p)));
    const used = new Set<Vertex>();
    for (const e of list(node, 'points')) {
      const name = strOf(getField(e, 'name')?.value);
      const p = points.find((x) => !used.has(x) && ix.pointName(x) === name);
      if (!p) continue;
      used.add(p);
      setBox(p, e);
      matchTransitions([p.id], list(e, 'transitions'));
    }
  };
  const applyRegion = (regionId: string, node: JsonNode) => {
    const kids = model.vertices.filter((v) => v.parent === regionId && !ix.isMachinePoint(v) && !ix.isBorder(v));
    for (const [key, type] of [['initial', 'initial'], ['history', 'shallowHistory'], ['deepHistory', 'deepHistory']] as const) {
      const e = getField(node, key)?.value;
      const v = kids.find((x) => x.type === type);
      if (!e || !v) continue;
      setBox(v, e, false);
      const t = model.transitions.find((x) => x.source === v.id);
      if (t) routes.set(t, e);
    }
    const used = new Set<Vertex>();
    for (const e of list(node, 'elements')) {
      const name = strOf(getField(e, 'name')?.value);
      const v = kids.find((x) => !used.has(x) && ELEMENT_KINDS.has(x.type) && x.name === name);
      if (!v) continue;
      used.add(v);
      setBox(v, e);
      if (v.type !== 'state') {
        matchTransitions([v.id], list(e, 'transitions'));
        continue;
      }
      const layout = strOf(getField(e, 'regionLayout')?.value);
      if (layout === 'horizontal' || layout === 'vertical') v.regionLayout = layout;
      matchTransitions([v.id], list(e, 'transitions'));
      applyPoints(v, e);
      const regs = v.regions ?? [];
      const items = itemsOf(getField(e, 'regions')?.value);
      if (regs.length === 1 && !items) applyRegion(regs[0].id, e);
      else if (regs.length > 1 && items) {
        for (const item of items) {
          const r = regs.find((x) => x.name === strOf(getField(item, 'name')?.value));
          if (!r) continue;
          const size = num(item, 'size');
          if (size !== undefined && size > 0) r.size = size;
          applyRegion(r.id, item);
        }
      }
    }
  };
  if (root) {
    applyPoints(null, root);
    const items = itemsOf(getField(root, 'regions')?.value);
    if (model.regions.length === 1 && !items) applyRegion(model.regions[0].id, root);
    else if (model.regions.length > 1 && items) {
      for (const item of items) {
        const r = model.regions.find((x) => x.name === strOf(getField(item, 'name')?.value));
        if (r) applyRegion(r.id, item);
      }
    }
  }

  // Automatic places, region by region, innermost first: a state grows to hold what was placed in it automatically
  // (a state that grew is in turn new to its own region) before the elements beside it are placed.
  const auto = new Set<Vertex>();
  for (const v of model.vertices) {
    if (!v.w || !v.h) [v.w, v.h] = DEFAULT_SIZE[v.type];
  }
  const grow = (v: Vertex) => {
    const ids = new Set((v.regions ?? []).map((r) => r.id));
    const kids = model.vertices.filter((k) => ids.has(k.parent) && !ix.isBorder(k));
    if (!kids.some((k) => auto.has(k))) return;
    const before = [v.w, v.h];
    for (const k of kids) {
      const p = rel.get(k)!;
      v.w = Math.max(v.w, n1(p.x + k.w + 20));
      v.h = Math.max(v.h, n1(p.y + k.h + 20));
    }
    if (v.w !== before[0] || v.h !== before[1]) auto.add(v);
  };
  // The model lists a state before what it contains, and a state's regions together: reversed, a state's regions
  // come after everything inside them, its first region last.
  const regionIds = [...model.regions.map((r) => r.id)];
  for (const v of model.vertices) for (const r of v.regions ?? []) regionIds.push(r.id);
  for (const rid of regionIds.reverse()) {
    const owner = ix.regionOwner.get(rid) ?? null;
    const kids = model.vertices.filter((v) => v.parent === rid && !ix.isBorder(v));
    const index = owner ? (owner.regions ?? []).findIndex((r) => r.id === rid) : 0;
    for (const v of kids) {
      if (placedV.has(v)) continue;
      const placed = kids.filter((k) => placedV.has(k)).map((k) => ({ ...rel.get(k)!, w: k.w, h: k.h }));
      const p = placed.length
        ? { x: Math.max(...placed.map((b) => b.x + b.w)) + 40, y: Math.min(...placed.map((b) => b.y)) }
        : owner
          ? { x: 30, y: 50 + Math.max(0, index) * 80 }
          : { x: 40, y: 40 };
      rel.set(v, { x: n1(p.x), y: n1(p.y) });
      placedV.add(v);
      auto.add(v);
      result.placed++;
    }
    if (owner && index === 0 && owner.type === 'state') grow(owner);
  }
  // Points without a place: on their state's border, entries on the left, exits on the right.
  for (const v of model.vertices) {
    if (!ix.isBorder(v) || placedV.has(v)) continue;
    const owner = ix.V.get(v.parent)!;
    const same = model.vertices.filter((p) => p.parent === owner.id && ix.isBorder(p) && placedV.has(p) === false && p.type === v.type);
    const i = same.indexOf(v);
    const exit = v.type === 'exitPoint' || (v.type === 'connectionPointRef' && v.pointKind === 'exit');
    rel.set(v, { x: n1(exit ? owner.w - v.w / 2 : -v.w / 2), y: n1(Math.min(owner.h - v.h, 10 + i * 24)) });
    result.placed++;
  }
  // Absolute coordinates, owners first (the model lists a state before what it contains).
  const abs = (v: Vertex): { x: number; y: number } => {
    if (!Number.isNaN(v.x)) return v;
    const owner = ix.owner(v);
    const o = owner ? abs(owner) : { x: 0, y: 0 };
    const p = rel.get(v) ?? { x: 0, y: 0 };
    v.x = n1(o.x + p.x);
    v.y = n1(o.y + p.y);
    return v;
  };
  for (const v of model.vertices) abs(v);
  // Routes
  for (const [t, e] of routes) {
    const f = ix.frame(t);
    const o = f ? { x: f.x, y: f.y } : { x: 0, y: 0 };
    const bends = itemsOf(getField(e, 'bends')?.value);
    if (bends?.length && t.kind !== 'internal') t.points = bends.map((b) => ({ x: n1(o.x + numOf(getField(b, 'x')?.value)!), y: n1(o.y + numOf(getField(b, 'y')?.value)!) }));
    const label = getField(e, 'label')?.value;
    if (label && t.kind !== 'internal') t.labelOffset = { x: numOf(getField(label, 'x')?.value)!, y: numOf(getField(label, 'y')?.value)! };
    const color = strOf(getField(e, 'color')?.value);
    if (isColor(color)) t.color = color;
    const items = fieldsOf(getField(e, 'itemColors')?.value);
    if (items) {
      const ic: ItemColors = {};
      for (const f of items) {
        const k = ITEM_COLOR_FROM_FILE[f.key];
        if (k && isColor(strOf(f.value))) ic[k] = strOf(f.value);
      }
      if (Object.keys(ic).length) t.itemColors = ic;
    }
  }
  normalizeGroups(model);
  return result;
}

/** Reads a machine's two files. */
export function readMachine(modelText: string, layoutText: string | undefined): (ReadMachine & LayoutResult) | { problems: Problem[] } {
  const read = readModel(modelText);
  if ('problems' in read) return read;
  return { ...read, ...applyLayout(read, layoutText) };
}

/**
 * Resolves the references of `model` that named nothing when they were read (a transition's target, a comment's
 * anchors: UNRESOLVED…) and name something now, as reading its file again would (`written`: `writeMachine(model)`,
 * which holds every anchor). Changes `model` in place; returns whether it changed.
 */
export function resolveReferences(model: FsmModel, written: Written): boolean {
  const open = (a: string) => a.startsWith(UNRESOLVED) || a.startsWith(UNRESOLVED_ANCHOR);
  const pending = model.transitions.some((t) => !!unresolved(t.target)) || model.vertices.some((v) => v.anchors?.some(open));
  if (!pending) return false;
  const read = readModel(written.model);
  if ('problems' in read) return false;
  const ids = derivedIds(model, written);
  const own = new Map([...ids].map(([id, d]) => [d, id]));
  const RT = new Map(read.model.transitions.map((t) => [t.id, t]));
  const RV = new Map(read.model.vertices.map((v) => [v.id, v]));
  let changed = false;
  for (const t of model.transitions) {
    if (!unresolved(t.target)) continue;
    const target = RT.get(ids.get(t.id) ?? '')?.target;
    const id = target === undefined ? undefined : own.get(target);
    if (id !== undefined) {
      t.target = id;
      changed = true;
    }
  }
  for (const v of model.vertices) {
    if (!v.anchors?.some(open)) continue;
    const anchors = RV.get(ids.get(v.id) ?? '')?.anchors ?? [];
    v.anchors = v.anchors.map((a, i) => {
      const id = open(a) && anchors[i] !== undefined ? own.get(anchors[i]) : undefined;
      if (id === undefined) return a;
      changed = true;
      return id;
    });
  }
  return changed;
}

/**
 * The ids reading `model` back from its file would give (what fsm-cli calls the elements, in generated code's traces
 * and in its problems), by the model's own ids: vertices and transitions.
 */
export function derivedIds(model: FsmModel, written = writeMachine(model)): Map<string, string> {
  const read = readModel(written.model);
  const out = new Map<string, string>();
  if ('problems' in read) return out;
  const byLine = new Map<number, string>();
  const byLineT = new Map<number, string>();
  for (const v of read.model.vertices) byLine.set(read.lines.get(v.id)!, v.id);
  for (const t of read.model.transitions) byLineT.set(read.lines.get(t.id)!, t.id);
  for (const v of model.vertices) {
    const id = byLine.get(written.lines.get(v.id) ?? -1);
    if (id) out.set(v.id, id);
  }
  for (const t of model.transitions) {
    const id = byLineT.get(written.lines.get(t.id) ?? -1);
    if (id) out.set(t.id, id);
  }
  return out;
}
