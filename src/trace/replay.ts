/**
 * Replays trace records on the state machines they are about: which states
 * are active at a point of the timeline, which transitions the current step
 * took (with the branches chosen at choices and junctions), and what the
 * current record designates.
 *
 * A record is about a machine instance: a machine, or a submachine reached
 * through submachine states (`Order.Payment`), resolved by the caller to the
 * model of its file. Its element is found by xmi:id, else by name.
 *
 * No VS Code API here: the unit tests run it in Node.js.
 */
import { FsmModel, ModelIndex, PSEUDOSTATES, Transition, Vertex } from '../model';
import { TraceRecord } from './format';

/** A machine instance the records are about. */
export interface Instance {
  /** Its path, e.g. `Order` or `Order.Payment`, or another key unique in the timeline. */
  key: string;
  /** Its name for display, when not its key. */
  label?: string;
  /** URI of its .fsm file. */
  uri: string;
  model: FsmModel;
  ix: ModelIndex;
}

export interface TimelineEntry {
  record: TraceRecord;
  /** Index of the trace (file) it comes from. */
  trace: number;
  /** null when the record's machine could not be resolved. */
  instance: Instance | null;
}

/** What a diagram highlights for one instance. */
export interface Highlight {
  /** Active states (and final states). */
  active: string[];
  /** Transitions taken by the current step: since the instance's last event, or the last one when it has no events. */
  taken: string[];
  /** Pseudostates on the way of the taken transitions (choices, junctions, forks, ...). */
  via: string[];
  /** Elements of the current record, when it is about this instance. */
  current: string[];
  /** The event of the current step, when there is one. */
  event?: string;
}

const isState = (v: Vertex | undefined): v is Vertex => !!v && (v.type === 'state' || v.type === 'final');
/** Vertices a compound transition goes through: pseudostates and connection point references. */
const isWaypoint = (v: Vertex) => PSEUDOSTATES.has(v.type) || v.type === 'connectionPointRef';

/** Identifier form of a name, as the code generator makes it (letters, digits, `_`). */
function ident(text: string): string {
  let s = text.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (/^\d/.test(s)) s = `_${s}`;
  return s;
}

const sameName = (v: Vertex, name: string) => v.name === name || (!!v.name && ident(v.name) === name);

/** The state designated by `ref`: an xmi:id, a name, or a path of names (`On::Playing`, `On.Playing`, `On/Playing`). */
export function findState(ix: ModelIndex, ref: string): Vertex | undefined {
  if (!ref) return undefined;
  const byId = ix.vertices.get(ref);
  if (isState(byId)) return byId;
  const states = ix.model.vertices.filter(isState);
  const exact = states.find((v) => sameName(v, ref));
  if (exact) return exact;
  const path = ref.split(/::|\.|\//).filter(Boolean);
  if (path.length < 2) return undefined;
  const last = path[path.length - 1];
  return states.find((v) => {
    if (!sameName(v, last)) return false;
    // The other names, innermost first, are enclosing states in that order (not necessarily direct parents).
    const ancestors = ix.ancestors(v);
    let k = 0;
    for (const name of path.slice(0, -1).reverse()) {
      while (k < ancestors.length && !sameName(ancestors[k], name)) k++;
      if (k++ >= ancestors.length) return false;
    }
    return true;
  });
}

/**
 * The transitions designated by a transition record: the one with its xmi:id, else the way from its source to its
 * target (given by `source`/`target`, or a name like `A -> B (e)`) through pseudostates, shortest first.
 */
export function findTransitions(ix: ModelIndex, rec: Pick<TraceRecord, 'id' | 'name' | 'source' | 'target'>): Transition[] {
  const byId = ix.model.transitions.find((t) => t.id === rec.id);
  if (byId) return [byId];
  let source = rec.source;
  let target = rec.target;
  if (!source || !target) {
    const m = /^\s*(.+?)\s*->\s*(.+?)(?:\s+\(.*\))?\s*$/.exec(rec.name || rec.id);
    if (!m) return [];
    [source, target] = [m[1], m[2]];
  }
  const from = findVertex(ix, source);
  const to = findVertex(ix, target);
  if (!from || !to) return [];
  // Breadth-first through pseudostates, so the shortest way wins.
  const queue: { at: Vertex; way: Transition[] }[] = [{ at: from, way: [] }];
  const seen = new Set<string>([from.id]);
  while (queue.length) {
    const { at, way } = queue.shift()!;
    for (const t of ix.outgoing(at.id)) {
      const next = ix.vertices.get(t.target);
      if (!next) continue;
      if (next.id === to.id) return [...way, t];
      if (isWaypoint(next) && !seen.has(next.id)) {
        seen.add(next.id);
        queue.push({ at: next, way: [...way, t] });
      }
    }
  }
  return [];
}

/** A state by findState(), or any vertex by xmi:id or name (transitions may start or end at pseudostates). */
function findVertex(ix: ModelIndex, ref: string): Vertex | undefined {
  return findState(ix, ref) ?? ix.vertices.get(ref) ?? ix.model.vertices.find((v) => sameName(v, ref));
}

/** What each record designates in its instance's model, computed once per record and instance. */
interface Resolved {
  state?: Vertex;
  transitions: Transition[];
}
const resolvedCache = new WeakMap<Instance, WeakMap<TraceRecord, Resolved>>();

function resolve(entry: TimelineEntry): Resolved {
  const inst = entry.instance!;
  let cache = resolvedCache.get(inst);
  if (!cache) resolvedCache.set(inst, (cache = new WeakMap()));
  let r = cache.get(entry.record);
  if (!r) cache.set(entry.record, (r = resolveIn(inst.ix, entry.record)));
  return r;
}

function resolveIn(ix: ModelIndex, rec: TraceRecord): Resolved {
  if (rec.kind === 'enter' || rec.kind === 'exit') return { state: findState(ix, rec.id) ?? findState(ix, rec.name), transitions: [] };
  if (rec.kind === 'transition') return { transitions: findTransitions(ix, rec) };
  return { transitions: [] };
}

/** Whether the record designates something in its instance's model (events always do). */
export function isResolved(entry: TimelineEntry): boolean {
  if (!entry.instance) return false;
  const r = resolve(entry);
  return entry.record.kind === 'event' || !!r.state || r.transitions.length > 0;
}

interface InstanceRun {
  inst: Instance;
  active: Set<string>;
  taken: string[];
  event?: string;
}

/**
 * The highlights of every instance after the entries up to `cursor` (included; -1 for none). `kinds` tells, for each
 * instance key, which kinds of records the whole timeline has for it: without events, a step is a single transition;
 * without `enter` records, the active states follow the transitions' targets.
 */
export function replay(entries: TimelineEntry[], cursor: number, kinds: Map<string, Set<string>>): Map<string, { inst: Instance; highlight: Highlight }> {
  const runs = new Map<string, InstanceRun>();
  const runOf = (inst: Instance) => {
    let run = runs.get(inst.key);
    if (!run) {
      // A submachine's first records belong to the step of the machine containing it.
      const parent = [...runs.values()].filter((r) => inst.key.startsWith(`${r.inst.key}.`)).sort((a, b) => b.inst.key.length - a.inst.key.length)[0];
      runs.set(inst.key, (run = { inst, active: new Set(), taken: [], event: parent?.event }));
    }
    return run;
  };
  const last = Math.min(cursor, entries.length - 1);
  for (let i = 0; i <= last; i++) {
    const e = entries[i];
    if (!e.instance) continue;
    const run = runOf(e.instance);
    const has = kinds.get(e.instance.key);
    const r = resolve(e);
    switch (e.record.kind) {
      case 'event':
        // A step starts, in the submachines of the instance too (`Order.Payment` for `Order`).
        for (const r of runs.values()) {
          if (r === run || r.inst.key.startsWith(`${run.inst.key}.`)) {
            r.taken = [];
            r.event = e.record.name;
          }
        }
        break;
      case 'enter':
        if (r.state) enter(run, r.state);
        break;
      case 'exit':
        if (r.state) leave(run, r.state);
        break;
      case 'transition': {
        const ids = r.transitions.map((t) => t.id);
        if (has?.has('event')) run.taken.push(...ids);
        else run.taken = ids;
        if (!has?.has('enter') && r.transitions.length) {
          const target = run.inst.ix.vertices.get(r.transitions[r.transitions.length - 1].target);
          if (isState(target)) enter(run, target);
        }
        break;
      }
    }
  }
  const out = new Map<string, { inst: Instance; highlight: Highlight }>();
  const cur = last >= 0 ? entries[last] : undefined;
  for (const [key, run] of runs) {
    const ix = run.inst.ix;
    const taken = [...new Set(run.taken)];
    const via = new Set<string>();
    for (const id of taken) {
      const t = ix.model.transitions.find((x) => x.id === id);
      for (const end of t ? [t.source, t.target] : []) {
        const v = ix.vertices.get(end);
        if (v && isWaypoint(v)) via.add(v.id);
      }
    }
    const current: string[] = [];
    if (cur?.instance?.key === key) {
      const r = resolve(cur);
      if (r.state) current.push(r.state.id);
      current.push(...r.transitions.map((t) => t.id));
    }
    out.set(key, { inst: run.inst, highlight: { active: [...run.active], taken, via: [...via], current, event: run.event } });
  }
  return out;
}

/** Enters `v`: its enclosing states become active, and whatever else was active in its region is left. */
function enter(run: InstanceRun, v: Vertex): void {
  const ix = run.inst.ix;
  for (const s of [...ix.ancestors(v).reverse(), v]) {
    if (run.active.has(s.id)) continue;
    for (const id of [...run.active]) {
      const other = ix.vertices.get(id);
      if (other && other.parent === s.parent && other.id !== s.id) leave(run, other);
    }
    run.active.add(s.id);
  }
}

/** Leaves `v` and everything active inside it. */
function leave(run: InstanceRun, v: Vertex): void {
  const ix = run.inst.ix;
  run.active.delete(v.id);
  for (const id of [...run.active]) {
    const inner = ix.vertices.get(id);
    if (inner && ix.isInside(inner, v.id)) run.active.delete(id);
  }
}

/**
 * What a diagram shows: the highlight of every instance of its machine at the cursor, each with its label and color
 * (an index in a palette, or -1 when the timeline has only one instance of that machine).
 */
export interface TraceView {
  instances: (Highlight & { label: string; color: number })[];
}
