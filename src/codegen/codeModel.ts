/**
 * Turns an FsmModel into a language-neutral code model: everything a code
 * template needs, with the UML semantics already worked out.
 *
 * - The state hierarchy becomes tables (states, regions, their indices).
 * - Every transition becomes a list of steps (exit, call, enter, ...) in UML
 *   order: exits from the innermost active state up to the transition's
 *   domain, then effects, then entries down to the targets, with default
 *   entry of the other regions. Choices become `choice` steps evaluated at run
 *   time. Junctions are static: they are expanded into one transition per
 *   path, with the guards combined.
 * - Joins become a transition that needs all its source states completed.
 * - Guards are trees (`Condition`), never text in some target language.
 *
 * Templates only print this model. The steps that depend on the run-time
 * configuration (`exit` of a composite state, `enterRegion`, `restoreHistory`)
 * are implemented by a small runtime in the template; see docs/CODEGEN.md.
 */
import * as expr from '../../media/expressions';
import { FsmModel, ModelIndex, Transition, Vertex, isBorderVertex } from '../model';

export type Condition = expr.Condition;

export class CodeGenError extends Error {}

// ------------------------------------------------------------------ code model

export interface CodeModel {
  machine: CodeMachine;
  /** All regions, outermost first. The first ones are the machine's top-level regions. */
  regions: CodeRegion[];
  topRegions: CodeRegion[];
  /** All states and final states, in depth-first order. */
  states: CodeState[];
  /** Named events this machine accepts, including those of its submachines. */
  events: CodeEvent[];
  /** Time events: one per `after(...)` trigger text and source state. */
  timers: CodeTimer[];
  /** Events, then timers, numbered from 0. */
  signals: CodeSignal[];
  /** Functions called by entry/exit behaviors and effects. */
  actions: string[];
  /** Functions called by guards, invariants and pre/postconditions. */
  conditions: string[];
  /** Functions called by do activities. */
  activities: string[];
  /** Everything that can fire, with its steps. Referenced by the candidates of the states. */
  transitions: CodeTransition[];
  /** Distinct machines referenced by submachine states. */
  submachines: CodeSubmachine[];
  /** The machine's own entry points (used when it is a submachine). */
  entryPoints: CodeEntryPoint[];
  /** The machine's own exit points. */
  exitPoints: CodeExitPoint[];
  /** Steps of the default entry into the machine. */
  start: Step[];
  /** States with an invariant. */
  invariants: CodeState[];
  features: CodeFeatures;
}

export interface CodeMachine {
  /** Identifier (letters, digits, `_`). */
  name: string;
  displayName: string;
  /** xmi:id, as used in hrefs. */
  id: string;
  kind: 'behavioral' | 'protocol';
  protocol: boolean;
  context: string;
  documentation: string;
  /** Path of the `.fsm` file, as given to the generator. */
  sourceFile: string;
}

export interface Ref {
  name: string;
  index: number;
}

export interface CodeRegion {
  index: number;
  /** Unique identifier, e.g. `Root`, `On_region`, `Playing_audio`. */
  name: string;
  displayName: string;
  top: boolean;
  /** Owning state, or null for a top-level region. */
  owner: Ref | null;
  ownerIndex: number;
  states: Ref[];
  /** Default entry: the transition of the initial pseudostate. Empty when the region has none. */
  defaultSteps: Step[];
}

export type Completion = 'immediate' | 'activities' | 'regions' | 'submachine' | 'never';

export interface CodeState {
  index: number;
  /** Unique identifier among the states. */
  name: string;
  displayName: string;
  kind: 'simple' | 'composite' | 'submachine' | 'final';
  isFinal: boolean;
  /** The region containing the state. */
  region: Ref;
  regionIndex: number;
  /** The enclosing state, or null at the top level. */
  parent: Ref | null;
  parentIndex: number;
  depth: number;
  regions: Ref[];
  /** Own entry: entry behavior, starting do activities and timers. */
  entry: Step[];
  /** Own exit: stopping the submachine, timers and do activities, then the exit behavior. */
  exit: Step[];
  activities: string[];
  timers: Ref[];
  /** Deferred events (signal refs). */
  deferred: Ref[];
  invariant: Condition | null;
  stereotype: string;
  submachine: { machine: string; href: string } | null;
  /** When the state completes: right after entry, after its do activities, when all regions are final, when its submachine finishes, or never (final states). */
  completes: Completion;
  /** Transitions triggered by events and timers, grouped by signal, in priority order. */
  handlers: CodeHandler[];
  /** Completion transitions (no trigger). */
  completion: CodeCandidate[];
  /** Submachine states: what to do when the submachine leaves through one of its exit points. */
  exits: { point: string; candidates: CodeCandidate[] }[];
}

export interface CodeHandler {
  signal: string;
  signalIndex: number;
  kind: 'event' | 'timer';
  candidates: CodeCandidate[];
  /** The last candidate has no condition at all, so the handler always takes a transition. */
  exhaustive: boolean;
}

export interface CodeCandidate {
  transition: string;
  transitionIndex: number;
  guard: Condition | null;
  /** Protocol state machines: the transition is taken only when it holds; otherwise it is a protocol violation. */
  precondition: Condition | null;
  /** Joins: every one of these states must be active and completed. */
  requires: Ref[];
  label: string;
}

export interface CodeTransition {
  index: number;
  name: string;
  /** Readable description, e.g. `Paused -> Stopped (after(5m))`. */
  label: string;
  kind: 'external' | 'internal' | 'local' | 'join' | 'exitPoint';
  /** Main source state; the transition is skipped when it is no longer active. */
  source: Ref;
  sourceIndex: number;
  steps: Step[];
}

export interface CodeEvent {
  name: string;
  index: number;
  signalIndex: number;
  /** False for events only handled by submachines. */
  own: boolean;
}

export interface CodeTimer {
  name: string;
  index: number;
  signalIndex: number;
  ms: number;
  trigger: string;
  state: string;
  stateIndex: number;
}

export interface CodeSignal {
  name: string;
  index: number;
  kind: 'event' | 'timer';
}

export interface CodeSubmachine {
  /** Machine name, used as the class name of the generated submachine. */
  name: string;
  href: string;
  events: string[];
  /** Submachine states using it. */
  states: Ref[];
}

export interface CodeEntryPoint {
  name: string;
  id: string;
  steps: Step[];
}

export interface CodeExitPoint {
  name: string;
  id: string;
}

export interface CodeFeatures {
  timers: boolean;
  activities: boolean;
  history: boolean;
  deferral: boolean;
  choices: boolean;
  joins: boolean;
  terminate: boolean;
  submachines: boolean;
  entryPoints: boolean;
  exitPoints: boolean;
  invariants: boolean;
  preconditions: boolean;
  postconditions: boolean;
  /** Any constraint checked at run time (invariants, pre/postconditions). */
  constraints: boolean;
}

/** What a template prints. See docs/CODEGEN.md for the meaning of each kind. */
export type Step =
  | { kind: 'call'; action: string }
  | { kind: 'startActivity'; activity: string }
  | { kind: 'stopActivity'; activity: string }
  | { kind: 'startTimer'; timer: string; timerIndex: number; ms: number }
  | { kind: 'cancelTimer'; timer: string; timerIndex: number }
  | { kind: 'exit'; state: string; stateIndex: number }
  | { kind: 'exitRegion'; region: string; regionIndex: number }
  | { kind: 'enter'; state: string; stateIndex: number }
  | { kind: 'enterRegion'; region: string; regionIndex: number }
  | { kind: 'restoreHistory'; region: string; regionIndex: number; deep: boolean; defaultSteps: Step[] }
  | { kind: 'choice'; label: string; branches: ChoiceBranch[]; hasElse: boolean }
  | { kind: 'startSubmachine'; state: string; stateIndex: number; point: string | null }
  | { kind: 'stopSubmachine'; state: string; stateIndex: number }
  | { kind: 'exitMachine'; point: string }
  | { kind: 'terminate' }
  | { kind: 'check'; constraint: 'postcondition'; element: string; condition: Condition };

export interface ChoiceBranch {
  /** Null for `else` (always last) or an unguarded branch. */
  guard: Condition | null;
  isElse: boolean;
  steps: Step[];
}

/** A choice step; `hasElse` tells whether the last branch is always taken. */
function choice(label: string, branches: ChoiceBranch[]): Step {
  const last = branches[branches.length - 1];
  return { kind: 'choice', label, branches, hasElse: !!last && (last.isElse || !last.guard) };
}

export interface ToCodeModelOptions {
  /** Code models of the machines referenced by submachine states, keyed by href as written in the model. */
  submachines?: Record<string, CodeModel>;
  /** Path of the `.fsm` file, shown in generated comments. */
  sourceFile?: string;
}

export function toCodeModel(model: FsmModel, options: ToCodeModelOptions = {}): CodeModel {
  return new Builder(model, options).build();
}

// ------------------------------------------------------------------ helpers

/** A way through a compound transition: taken when `guard` holds, doing `steps`. */
interface Alt {
  guard: Condition | null;
  steps: Step[];
}

const one = (steps: Step[] = []): Alt[] => [{ guard: null, steps }];

function and(a: Condition | null, b: Condition | null): Condition | null {
  if (!a) return b;
  if (!b) return a;
  const args = [...(a.op === 'and' ? a.args : [a]), ...(b.op === 'and' ? b.args : [b])];
  return { op: 'and', args };
}

function or(list: Condition[]): Condition | null {
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return { op: 'or', args: list.flatMap((c) => (c.op === 'or' ? c.args : [c])) };
}

const not = (c: Condition): Condition => (c.op === 'not' ? c.arg : { op: 'not', arg: c });

/** A compiled transition, taken when `guard` holds. */
interface Fireable {
  tr: CodeTransition;
  guard: Condition | null;
}

/** Every combination of a way through `a` followed by a way through `b`. */
function seq(a: Alt[], b: Alt[]): Alt[] {
  const out: Alt[] = [];
  for (const x of a) for (const y of b) out.push({ guard: and(x.guard, y.guard), steps: [...x.steps, ...y.steps] });
  return out;
}

/** Identifier made of letters, digits and `_`, not starting with a digit. */
export function ident(text: string, fallback = 'x'): string {
  let s = String(text ?? '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = fallback;
  if (/^\d/.test(s)) s = `_${s}`;
  return s;
}

/** Makes names unique by appending _2, _3, ... */
class Names {
  private used = new Set<string>();
  take(base: string): string {
    let name = base;
    for (let i = 2; this.used.has(name); i++) name = `${base}_${i}`;
    this.used.add(name);
    return name;
  }
}

const TYPE_NAME: Record<string, string> = {
  final: 'final',
  choice: 'choice',
  junction: 'junction',
  fork: 'fork',
  join: 'join',
  terminate: 'terminate',
  shallowHistory: 'history',
  deepHistory: 'deepHistory',
  entryPoint: 'entry',
  exitPoint: 'exit',
  connectionPointRef: 'point',
  initial: 'initial',
};

// ------------------------------------------------------------------ builder

class Builder {
  private ix: ModelIndex;
  private topRegionIds: string[];
  private stateList: Vertex[] = [];
  private regionList: { id: string; name: string; owner: Vertex | null; pos: number }[] = [];
  private stateIndex = new Map<string, number>();
  private regionIndex = new Map<string, number>();
  private stateNames: string[] = [];
  private regionNames: string[] = [];

  private signals: CodeSignal[] = [];
  private events: CodeEvent[] = [];
  private timers: CodeTimer[] = [];
  private timerByKey = new Map<string, CodeTimer>();
  private actions = new Set<string>();
  private conditions = new Set<string>();
  private activities = new Set<string>();
  private transitions: CodeTransition[] = [];
  private transitionNames = new Names();
  private fireCache = new Map<string, Fireable[]>();
  private features: CodeFeatures = {
    timers: false,
    activities: false,
    history: false,
    deferral: false,
    choices: false,
    joins: false,
    terminate: false,
    submachines: false,
    entryPoints: false,
    exitPoints: false,
    invariants: false,
    preconditions: false,
    postconditions: false,
    constraints: false,
  };
  /** Junctions on the way being compiled, to report cycles. */
  private junctionPath: string[] = [];

  constructor(
    private model: FsmModel,
    private options: ToCodeModelOptions,
  ) {
    this.ix = new ModelIndex(model);
    this.topRegionIds = model.regions.map((r) => r.id);
  }

  build(): CodeModel {
    const m = this.model;
    // Structure, depth first.
    const walk = (regionId: string, name: string, owner: Vertex | null, pos: number) => {
      this.regionIndex.set(regionId, this.regionList.length);
      this.regionList.push({ id: regionId, name, owner, pos });
      for (const v of this.ix.childrenOf(regionId)) {
        if (v.type !== 'state' && v.type !== 'final') continue;
        if (isBorderVertex(v, this.ix.vertices)) continue;
        this.stateIndex.set(v.id, this.stateList.length);
        this.stateList.push(v);
        (v.regions ?? []).forEach((r, i) => walk(r.id, r.name, v, i));
      }
    };
    m.regions.forEach((r, i) => walk(r.id, r.name, null, i));
    this.nameStates();
    this.nameRegions();

    // Signals: named events first (own, then submachines'), then timers.
    for (const t of m.transitions) {
      for (const trig of t.triggers) if (expr.timeTriggerMs(trig) === null) this.event(trig.trim(), true);
    }
    for (const v of m.vertices) for (const d of v.deferrable ?? []) this.event(d.trim(), true);
    const subs = this.submachineModels();
    for (const sub of subs.values()) for (const e of sub.events) this.event(e.name, false);
    for (const t of m.transitions) {
      const s = this.ix.vertices.get(t.source);
      if (!s || !this.stateIndex.has(s.id)) continue;
      for (const trig of t.triggers) if (expr.timeTriggerMs(trig) !== null) this.timer(s, trig);
    }
    this.signals = [
      ...this.events.map((e): CodeSignal => ({ name: e.name, index: 0, kind: 'event' })),
      ...this.timers.map((t): CodeSignal => ({ name: t.name, index: 0, kind: 'timer' })),
    ];
    this.signals.forEach((s, i) => (s.index = i));
    this.events.forEach((e, i) => (e.signalIndex = i));
    this.timers.forEach((t, i) => (t.signalIndex = this.events.length + i));

    const states = this.stateList.map((v, i) => this.state(v, i));
    const regions = this.regionList.map((r, i) => this.region(r, i));
    const entryPoints = this.machinePoints('entryPoint').map((v) => this.entryPoint(v));
    const exitPoints = this.machinePoints('exitPoint').map((v) => ({ name: ident(v.name, 'exit'), id: v.id }));
    this.features.entryPoints = entryPoints.length > 0;
    this.features.exitPoints = exitPoints.length > 0;
    this.features.submachines = subs.size > 0;
    this.features.timers = this.timers.length > 0;
    this.features.activities = this.activities.size > 0;
    this.features.constraints = this.features.invariants || this.features.preconditions || this.features.postconditions;

    const submachines: CodeSubmachine[] = [...subs.entries()].map(([href, sub]) => ({
      name: sub.machine.name,
      href,
      events: sub.events.map((e) => e.name),
      states: states.filter((s) => s.submachine?.href === href).map((s) => ({ name: s.name, index: s.index })),
    }));

    return {
      machine: {
        name: ident(m.name, 'StateMachine'),
        displayName: m.name,
        id: m.id ?? 'sm',
        kind: m.kind,
        protocol: m.kind === 'protocol',
        context: m.context ?? '',
        documentation: m.documentation ?? '',
        sourceFile: this.options.sourceFile ?? '',
      },
      regions,
      topRegions: regions.filter((r) => r.top),
      states,
      events: this.events,
      timers: this.timers,
      signals: this.signals,
      actions: [...this.actions],
      conditions: [...this.conditions],
      activities: [...this.activities],
      transitions: this.transitions,
      submachines,
      entryPoints,
      exitPoints,
      start: this.topRegionIds.map((r) => this.enterRegionStep(r)),
      invariants: states.filter((s) => s.invariant),
      features: this.features,
    };
  }

  // -------------------------------------------------------------- names

  private nameStates() {
    const base = (v: Vertex) => ident(v.name, v.type === 'final' ? 'Final' : 'State');
    const count = new Map<string, number>();
    for (const v of this.stateList) count.set(base(v), (count.get(base(v)) ?? 0) + 1);
    const names = new Names();
    for (const v of this.stateList) {
      let name = base(v);
      if ((count.get(name) ?? 0) > 1) {
        // Qualify duplicates with their enclosing states: On_Final, Playing_Idle.
        const path = this.ix.ancestors(v).reverse().map((a) => ident(a.name, 'State'));
        if (path.length) name = [...path, name].join('_');
      }
      this.stateNames.push(names.take(name));
    }
  }

  private nameRegions() {
    const names = new Names();
    for (const r of this.regionList) {
      let name: string;
      const siblings = r.owner ? r.owner.regions ?? [] : this.model.regions;
      if (!r.owner) name = siblings.length === 1 ? 'Root' : `Root_${ident(r.name, `region${r.pos + 1}`)}`;
      else {
        const owner = this.stateNames[this.stateIndex.get(r.owner.id)!];
        name = `${owner}_${r.name ? ident(r.name) : siblings.length === 1 ? 'region' : `region${r.pos + 1}`}`;
      }
      this.regionNames.push(names.take(name));
    }
  }

  private stateRef(v: Vertex): { name: string; index: number } {
    const index = this.stateIndex.get(v.id);
    if (index === undefined) throw new CodeGenError(`${this.label(v)} is not in a region of the state machine.`);
    return { name: this.stateNames[index], index };
  }

  private regionRef(id: string): { name: string; index: number } {
    const index = this.regionIndex.get(id);
    if (index === undefined) throw new CodeGenError(`Unknown region '${id}'.`);
    return { name: this.regionNames[index], index };
  }

  private label(v: Vertex | undefined): string {
    if (!v) return '?';
    if (this.stateIndex.has(v.id)) return this.stateNames[this.stateIndex.get(v.id)!];
    if (v.type === 'connectionPointRef') {
      const owner = this.ix.vertices.get(v.parent);
      const sub = this.options.submachines?.[owner?.submachine ?? ''];
      const point = [...(sub?.entryPoints ?? []), ...(sub?.exitPoints ?? [])].find((p) => p.id === v.ref);
      if (owner && point) return `${this.label(owner)}.${point.name}`;
    }
    return v.name || TYPE_NAME[v.type] || v.type;
  }

  // -------------------------------------------------------------- signals

  /** Registers a named event; all of them are known before the states are built. */
  private event(name: string, own: boolean): CodeEvent {
    const known = this.events.find((e) => e.name === name);
    if (known) {
      known.own ||= own;
      return known;
    }
    const e: CodeEvent = { name, index: this.events.length, signalIndex: -1, own };
    this.events.push(e);
    return e;
  }

  private timer(state: Vertex, trigger: string): CodeTimer {
    const text = trigger.replace(/\s+/g, '');
    const key = `${state.id}|${text}`;
    const known = this.timerByKey.get(key);
    if (known) return known;
    const ref = this.stateRef(state);
    const m = /^after\((.*)\)$/.exec(text);
    let name = ident(`${ref.name}_after_${m ? m[1] : text}`);
    while (this.events.some((e) => e.name === name) || this.timers.some((t) => t.name === name)) name = `${name}_`;
    const timer: CodeTimer = {
      name,
      index: this.timers.length,
      signalIndex: -1,
      ms: expr.timeTriggerMs(text)!,
      trigger: text,
      state: ref.name,
      stateIndex: ref.index,
    };
    this.timerByKey.set(key, timer);
    this.timers.push(timer);
    return timer;
  }

  private signalOf(state: Vertex, trigger: string): CodeSignal {
    const index = expr.timeTriggerMs(trigger) !== null ? this.timer(state, trigger).signalIndex : this.event(trigger.trim(), true).signalIndex;
    return this.signals[index];
  }

  // -------------------------------------------------------------- text

  private calls(text: string | undefined, what: string, into: Set<string>): string[] {
    const r = expr.parseActions(text);
    if (!r.ok) throw new CodeGenError(`${what}: ${r.error}`);
    for (const c of r.value) into.add(c);
    return r.value;
  }

  private condition(text: string | undefined, what: string): Condition | null {
    const r = expr.parseCondition(text);
    if (!r.ok) throw new CodeGenError(`${what}: ${r.error}`);
    const visit = (c: Condition) => {
      if (c.op === 'call') this.conditions.add(c.name);
      else if (c.op === 'not') visit(c.arg);
      else c.args.forEach(visit);
    };
    if (r.value) visit(r.value);
    return r.value;
  }

  private guardOf(t: Transition): Condition | null {
    if (t.guard.trim() === 'else') return null;
    return this.condition(t.guard, `Guard of ${this.transitionLabel(t)}`);
  }

  private effect(t: Transition): Step[] {
    return this.calls(t.effect, `Effect of ${this.transitionLabel(t)}`, this.actions).map((action) => ({ kind: 'call', action }));
  }

  private transitionLabel(t: Transition): string {
    const s = this.label(this.ix.vertices.get(t.source));
    const g = this.label(this.ix.vertices.get(t.target));
    return `${s} -> ${g}${t.triggers.length ? ` (${t.triggers.join(', ')})` : ''}`;
  }

  // -------------------------------------------------------------- geometry of the hierarchy

  private vertex(id: string): Vertex {
    const v = this.ix.vertices.get(id);
    if (!v) throw new CodeGenError(`Unknown vertex '${id}'.`);
    return v;
  }

  /** The region a vertex sits in; the owner's region for entry/exit points and connection point references. */
  private regionOf(v: Vertex): string {
    if (isBorderVertex(v, this.ix.vertices)) return this.vertex(v.parent).parent;
    return v.parent;
  }

  /** Regions containing `v`, outermost first. */
  private chain(v: Vertex): string[] {
    const out: string[] = [];
    let r: string | undefined = this.regionOf(v);
    const seen = new Set<string>();
    while (r && !seen.has(r)) {
      seen.add(r);
      out.unshift(r);
      const owner = this.ix.regionOwner.get(r);
      r = owner ? owner.parent : undefined;
    }
    return out;
  }

  /** Innermost region containing all of `vs`; null when they are in different top-level regions. */
  private commonRegion(vs: Vertex[]): string | null {
    const chains = vs.map((v) => this.chain(v));
    let common: string | null = null;
    for (let i = 0; chains.every((c) => i < c.length && c[i] === chains[0][i]); i++) common = chains[0][i];
    return common;
  }

  /** The vertex directly in `region` (or at the top level when null) on the way to `v`. */
  private childOnPath(v: Vertex, region: string | null): Vertex {
    const inRegion = (x: Vertex) => (region === null ? this.topRegionIds.includes(this.regionOf(x)) : this.regionOf(x) === region);
    if (inRegion(v)) return v;
    for (const a of this.ix.ancestors(v)) if (inRegion(a)) return a;
    throw new CodeGenError(`${this.label(v)} is not inside the expected region.`);
  }

  private isState(v: Vertex) {
    return this.stateIndex.has(v.id);
  }

  // -------------------------------------------------------------- steps

  private enterStep(v: Vertex): Step {
    const r = this.stateRef(v);
    return { kind: 'enter', state: r.name, stateIndex: r.index };
  }

  private exitStep(v: Vertex): Step {
    const r = this.stateRef(v);
    return { kind: 'exit', state: r.name, stateIndex: r.index };
  }

  private enterRegionStep(id: string): Step {
    const r = this.regionRef(id);
    return { kind: 'enterRegion', region: r.name, regionIndex: r.index };
  }

  private exitRegionStep(id: string): Step {
    const r = this.regionRef(id);
    return { kind: 'exitRegion', region: r.name, regionIndex: r.index };
  }

  private altsToSteps(alts: Alt[], label: string): Step[] {
    if (alts.length === 1 && !alts[0].guard) return alts[0].steps;
    this.features.choices = true;
    return [choice(label, alts.map((a) => ({ guard: a.guard, isElse: false, steps: a.steps })))];
  }

  /** Exits for a transition from `pos` whose domain is `domain`. */
  private exitsFrom(pos: Vertex, domain: string | null): Step[] {
    if (domain === null) return this.topRegionIds.map((r) => this.exitRegionStep(r));
    const root = this.childOnPath(pos, domain);
    return this.isState(root) ? [this.exitStep(root)] : [];
  }

  /** One segment of a compound transition, from `pos` (a state or a pseudostate already reached). */
  private segment(pos: Vertex, t: Transition): Alt[] {
    const target = this.vertex(t.target);
    if (t.kind === 'internal') return one(this.effect(t));
    if (t.kind === 'local' && this.isState(pos) && pos.regions?.length && (target === pos || this.ix.isInside(target, pos.id))) {
      if (target === pos) {
        const regions = pos.regions.map((r) => r.id);
        return one([...regions.map((r) => this.exitRegionStep(r)), ...this.effect(t), ...regions.map((r) => this.enterRegionStep(r))]);
      }
      const chain = this.chain(target);
      const region = pos.regions.find((r) => chain.includes(r.id))!;
      return seq(one([this.exitRegionStep(region.id), ...this.effect(t)]), this.enterRegion(region.id, [target]));
    }
    const domain = this.commonRegion([pos, target]);
    return seq(one([...this.exitsFrom(pos, domain), ...this.effect(t)]), this.enterDomain(domain, [target]));
  }

  private enterDomain(domain: string | null, targets: Vertex[]): Alt[] {
    if (domain !== null) return this.enterRegion(domain, targets);
    let alts = one();
    for (const r of this.topRegionIds) alts = seq(alts, this.enterRegion(r, targets.filter((t) => this.chain(t)[0] === r)));
    return alts;
  }

  /** Enters `region` (currently inactive) so that every target gets entered; default entry when there is none. */
  private enterRegion(region: string, targets: Vertex[]): Alt[] {
    if (!targets.length) return one([this.enterRegionStep(region)]);
    const direct = targets.find((t) => this.regionOf(t) === region);
    if (direct) return this.reach(direct, region);
    const state = this.childOnPath(targets[0], region);
    const inside = targets.filter((t) => this.childOnPath(t, region) === state);
    let alts = one([this.enterStep(state)]);
    for (const r of state.regions ?? []) {
      alts = seq(alts, this.enterRegion(r.id, inside.filter((t) => this.chain(t).includes(r.id))));
    }
    return alts;
  }

  /** Arriving at `v`, which sits directly in `region`. */
  private reach(v: Vertex, region: string): Alt[] {
    const outs = this.ix.outgoing(v.id);
    switch (v.type) {
      case 'state': {
        let alts = one([this.enterStep(v)]);
        for (const r of v.regions ?? []) alts = seq(alts, one([this.enterRegionStep(r.id)]));
        if (v.submachine) alts = seq(alts, one([this.startSubmachine(v, null)]));
        return alts;
      }
      case 'final':
        return one([this.enterStep(v)]);
      case 'entryPoint': {
        const owner = this.ix.vertices.get(v.parent);
        if (!owner) return one(); // the machine's own entry point: see entryPoint()
        let alts = one([this.enterStep(owner), ...outs.flatMap((t) => this.effect(t))]);
        const targets = outs.map((t) => this.vertex(t.target));
        for (const r of owner.regions ?? []) {
          alts = seq(alts, this.enterRegion(r.id, targets.filter((t) => this.chain(t).includes(r.id))));
        }
        return alts;
      }
      case 'connectionPointRef': {
        if (v.pointKind === 'exit') return one();
        const owner = this.vertex(v.parent);
        return one([this.enterStep(owner), this.startSubmachine(owner, this.pointName(owner, v, 'entry'))]);
      }
      case 'exitPoint': {
        if (!this.ix.vertices.has(v.parent)) {
          return one([{ kind: 'exitMachine', point: ident(v.name, 'exit') }]);
        }
        // The owner was exited on the way here; continue with the transitions leaving the point.
        return this.branches(v, outs);
      }
      case 'choice': {
        this.features.choices = true;
        const ordered = [...outs.filter((t) => t.guard.trim() !== 'else'), ...outs.filter((t) => t.guard.trim() === 'else')];
        const label = `choice in ${this.regionRef(region).name}`;
        const branches: ChoiceBranch[] = ordered.map((t) => ({
          guard: this.guardOf(t),
          isElse: t.guard.trim() === 'else',
          steps: this.altsToSteps(this.segment(v, t), label),
        }));
        return one([choice(label, branches)]);
      }
      case 'junction': {
        if (this.junctionPath.includes(v.id)) throw new CodeGenError('Junctions form a cycle.');
        this.junctionPath.push(v.id);
        try {
          return this.branches(v, outs);
        } finally {
          this.junctionPath.pop();
        }
      }
      case 'shallowHistory':
      case 'deepHistory': {
        this.features.history = true;
        const r = this.regionRef(region);
        const def = outs.length ? this.altsToSteps(this.segment(v, outs[0]), 'history default') : [this.enterRegionStep(region)];
        return one([{ kind: 'restoreHistory', region: r.name, regionIndex: r.index, deep: v.type === 'deepHistory', defaultSteps: def }]);
      }
      case 'fork': {
        const effects = outs.flatMap((t) => this.effect(t));
        return seq(one(effects), this.enterRegion(region, outs.map((t) => this.vertex(t.target)).filter((t) => t !== v)));
      }
      case 'terminate':
        this.features.terminate = true;
        return one([{ kind: 'terminate' }]);
      default:
        // Joins are compiled as a whole (see join()); initial pseudostates only start regions.
        return one();
    }
  }

  /** The transitions leaving a static pseudostate (junction, state exit point) as alternative ways. */
  private branches(v: Vertex, outs: Transition[]): Alt[] {
    if (!outs.length) return one();
    const guarded = outs.filter((t) => t.guard.trim() !== 'else');
    const guards = guarded.map((t) => this.guardOf(t));
    const out: Alt[] = [];
    guarded.forEach((t, i) => out.push(...seq([{ guard: guards[i], steps: [] }], this.segment(v, t))));
    const elseT = outs.find((t) => t.guard.trim() === 'else');
    if (elseT) {
      const others = or(guards.filter((g): g is Condition => !!g));
      out.push(...seq([{ guard: others ? not(others) : null, steps: [] }], this.segment(v, elseT)));
    }
    return out;
  }

  private startSubmachine(state: Vertex, point: string | null): Step {
    const r = this.stateRef(state);
    return { kind: 'startSubmachine', state: r.name, stateIndex: r.index, point };
  }

  // -------------------------------------------------------------- submachines

  private submachineModels(): Map<string, CodeModel> {
    const out = new Map<string, CodeModel>();
    for (const v of this.stateList) {
      if (!v.submachine || out.has(v.submachine)) continue;
      const sub = this.options.submachines?.[v.submachine];
      if (!sub) throw new CodeGenError(`The state machine '${v.submachine}' used by ${this.label(v)} was not provided.`);
      out.set(v.submachine, sub);
    }
    return out;
  }

  private pointName(owner: Vertex, ref: Vertex, kind: 'entry' | 'exit'): string {
    const sub = this.options.submachines?.[owner.submachine ?? ''];
    const points = kind === 'entry' ? sub?.entryPoints : sub?.exitPoints;
    const p = points?.find((x) => x.id === ref.ref);
    if (!p) throw new CodeGenError(`${this.label(owner)} references ${kind} point '${ref.ref}', which '${owner.submachine}' does not have.`);
    return p.name;
  }

  // -------------------------------------------------------------- transitions

  /** The fireable transitions for `t` from `pos`: one per way through its junctions. */
  private fireables(key: string, t: Transition, pos: Vertex, prefix: Step[], kind: CodeTransition['kind'], label: string): Fireable[] {
    const cached = this.fireCache.get(key);
    if (cached) return cached;
    let alts = seq(one(prefix), this.segment(pos, t));
    const post = this.model.kind === 'protocol' ? this.condition(t.postcondition, `Postcondition of ${label}`) : null;
    if (post) {
      this.features.postconditions = true;
      alts = seq(alts, one([{ kind: 'check', constraint: 'postcondition', element: label, condition: post }]));
    }
    const source = this.ownerStateOf(pos);
    const target = this.label(this.ix.vertices.get(t.target));
    const trig = t.triggers.length ? t.triggers[0] : kind === 'exitPoint' ? this.label(pos).split('.').pop()! : 'done';
    const base = ident(`${source.name}_${trig}_${target}`).replace(/__+/g, '_');
    const list = alts.map((a, i): Fireable => {
      const tr: CodeTransition = {
        index: this.transitions.length,
        name: this.transitionNames.take(alts.length > 1 ? `${base}_${i + 1}` : base),
        label,
        kind,
        source,
        sourceIndex: source.index,
        steps: a.steps,
      };
      this.transitions.push(tr);
      return { tr, guard: a.guard };
    });
    this.fireCache.set(key, list);
    return list;
  }

  private ownerStateOf(pos: Vertex): Ref {
    if (this.isState(pos)) return this.stateRef(pos);
    const owner = this.ix.ownerState(pos);
    if (!owner) throw new CodeGenError(`${this.label(pos)} has no owning state.`);
    return this.stateRef(owner);
  }

  private candidates(t: Transition, pos: Vertex, prefix: Step[] = [], kind?: CodeTransition['kind']): CodeCandidate[] {
    const label = this.transitionLabel(t);
    const guard = this.guardOf(t);
    const protocol = this.model.kind === 'protocol';
    const pre = protocol ? this.condition(t.precondition, `Precondition of ${label}`) : null;
    if (pre) this.features.preconditions = true;
    const k = kind ?? (t.kind === 'internal' ? 'internal' : t.kind === 'local' ? 'local' : 'external');
    return this.fireables(`${t.id}|${pos.id}`, t, pos, prefix, k, label).map(({ tr, guard: g }) => ({
      transition: tr.name,
      transitionIndex: tr.index,
      guard: and(guard, g),
      precondition: pre,
      requires: [],
      label,
    }));
  }

  /** A join: fires from the completion of any source once all sources have completed. */
  private join(j: Vertex): CodeCandidate[] {
    this.features.joins = true;
    const incoming = this.ix.incoming(j.id);
    const sources = incoming.map((t) => this.vertex(t.source)).filter((s) => this.isState(s));
    const out = this.ix.outgoing(j.id)[0];
    const requires = sources.map((s) => this.stateRef(s));
    const label = `join ${requires.map((r) => r.name).join(' + ')}${out ? ` -> ${this.label(this.ix.vertices.get(out.target))}` : ''}`;
    const key = `join|${j.id}`;
    let cached = this.fireCache.get(key);
    const guard = out ? this.guardOf(out) : null;
    if (!cached) {
      const target = out ? this.vertex(out.target) : null;
      const domain = this.commonRegion(target ? [...sources, target] : sources);
      const exits: Step[] = [];
      if (domain === null) exits.push(...this.topRegionIds.map((r) => this.exitRegionStep(r)));
      else {
        for (const s of sources) {
          const root = this.childOnPath(s, domain);
          if (this.isState(root) && !exits.some((e) => e.kind === 'exit' && e.stateIndex === this.stateRef(root).index)) {
            exits.push(this.exitStep(root));
          }
        }
      }
      const effects = [...incoming.flatMap((t) => this.effect(t)), ...(out ? this.effect(out) : [])];
      const alts = seq(one([...exits, ...effects]), target ? this.enterDomain(domain, [target]) : one());
      const source = requires[0];
      const tr: CodeTransition = {
        index: this.transitions.length,
        name: this.transitionNames.take(ident(`join_${requires.map((r) => r.name).join('_')}`)),
        label,
        kind: 'join',
        source,
        sourceIndex: source.index,
        steps: this.altsToSteps(alts, label),
      };
      this.transitions.push(tr);
      cached = [{ tr, guard: null }];
      this.fireCache.set(key, cached);
    }
    const tr = cached[0].tr;
    return [{ transition: tr.name, transitionIndex: tr.index, guard, precondition: null, requires, label }];
  }

  // -------------------------------------------------------------- states and regions

  private state(v: Vertex, index: number): CodeState {
    const name = this.stateNames[index];
    const what = `${name}`;
    const isFinal = v.type === 'final';
    const owner = this.ix.regionOwner.get(v.parent) ?? null;
    const regions = (v.regions ?? []).map((r) => this.regionRef(r.id));
    const activities = isFinal ? [] : this.calls(v.doActivity, `do of ${what}`, this.activities);
    const timers = this.timers.filter((t) => t.stateIndex === index).map((t) => ({ name: t.name, index: t.index }));
    const timerSteps = this.timers.filter((t) => t.stateIndex === index);

    const entry: Step[] = [
      ...this.calls(v.entry, `entry of ${what}`, this.actions).map((action): Step => ({ kind: 'call', action })),
      ...activities.map((activity): Step => ({ kind: 'startActivity', activity })),
      ...timerSteps.map((t): Step => ({ kind: 'startTimer', timer: t.name, timerIndex: t.index, ms: t.ms })),
    ];
    const exit: Step[] = [
      ...(v.submachine ? [{ kind: 'stopSubmachine', state: name, stateIndex: index } as Step] : []),
      ...timerSteps.map((t): Step => ({ kind: 'cancelTimer', timer: t.name, timerIndex: t.index })),
      ...[...activities].reverse().map((activity): Step => ({ kind: 'stopActivity', activity })),
      ...this.calls(v.exit, `exit of ${what}`, this.actions).map((action): Step => ({ kind: 'call', action })),
    ];

    const deferred = (v.deferrable ?? []).map((d) => {
      const e = this.event(d.trim(), true);
      return { name: e.name, index: e.signalIndex };
    });
    if (deferred.length) this.features.deferral = true;
    const invariant = isFinal ? null : this.condition(v.invariant, `Invariant of ${what}`);
    if (invariant) this.features.invariants = true;

    // Transitions leaving the state.
    const handlers: CodeHandler[] = [];
    const completion: CodeCandidate[] = [];
    for (const t of this.ix.outgoing(v.id)) {
      const target = this.ix.vertices.get(t.target);
      if (!target) continue;
      if (!t.triggers.length) {
        if (target.type === 'join') completion.push(...this.join(target));
        else completion.push(...this.candidates(t, v));
        continue;
      }
      const cands = this.candidates(t, v);
      for (const trig of t.triggers) {
        const sig = this.signalOf(v, trig);
        let h = handlers.find((x) => x.signal === sig.name);
        if (!h) {
          h = { signal: sig.name, signalIndex: sig.index, kind: sig.kind, candidates: [], exhaustive: false };
          handlers.push(h);
        }
        h.candidates.push(...cands);
      }
    }
    for (const h of handlers) {
      const last = h.candidates[h.candidates.length - 1];
      h.exhaustive = !!last && !last.guard && !last.precondition && !last.requires.length;
    }

    // Submachine states: transitions leaving its exit point references.
    const exits: CodeState['exits'] = [];
    if (v.submachine) {
      for (const ref of this.ix.connectionPoints(v)) {
        if (ref.type !== 'connectionPointRef' || ref.pointKind !== 'exit') continue;
        const point = this.pointName(v, ref, 'exit');
        const candidates = this.ix.outgoing(ref.id).flatMap((t) => this.candidates(t, ref, [this.exitStep(v)], 'exitPoint'));
        exits.push({ point, candidates });
      }
    }

    const kind: CodeState['kind'] = isFinal ? 'final' : v.submachine ? 'submachine' : regions.length ? 'composite' : 'simple';
    const completes: Completion = isFinal
      ? 'never'
      : kind === 'submachine'
        ? 'submachine'
        : kind === 'composite'
          ? 'regions'
          : activities.length
            ? 'activities'
            : 'immediate';
    const parent = owner ? this.stateRef(owner) : null;
    return {
      index,
      name,
      displayName: v.name || (isFinal ? 'final' : name),
      kind,
      isFinal,
      region: this.regionRef(v.parent),
      regionIndex: this.regionRef(v.parent).index,
      parent,
      parentIndex: parent ? parent.index : -1,
      depth: this.ix.ancestors(v).length,
      regions,
      entry,
      exit,
      activities,
      timers,
      deferred,
      invariant,
      stereotype: v.stereotype ?? '',
      submachine: v.submachine ? { machine: this.options.submachines![v.submachine].machine.name, href: v.submachine } : null,
      completes,
      handlers,
      completion,
      exits,
    };
  }

  private region(r: { id: string; name: string; owner: Vertex | null }, index: number): CodeRegion {
    const initial = this.ix.initialOf(r.id);
    const out = initial ? this.ix.outgoing(initial.id)[0] : undefined;
    const owner = r.owner ? this.stateRef(r.owner) : null;
    const name = this.regionNames[index];
    return {
      index,
      name,
      displayName: r.name || name,
      top: !r.owner,
      owner,
      ownerIndex: owner ? owner.index : -1,
      states: this.stateList
        .map((v, i) => ({ v, i }))
        .filter(({ v }) => v.parent === r.id)
        .map(({ i }) => ({ name: this.stateNames[i], index: i })),
      defaultSteps: initial && out ? this.altsToSteps(this.segment(initial, out), `initial of ${name}`) : [],
    };
  }

  private machinePoints(type: 'entryPoint' | 'exitPoint'): Vertex[] {
    return this.model.vertices.filter((v) => v.type === type && this.topRegionIds.includes(v.parent));
  }

  private entryPoint(v: Vertex): CodeEntryPoint {
    const outs = this.ix.outgoing(v.id);
    let alts = one();
    for (const t of outs) alts = seq(alts, this.segment(v, t));
    const entered = new Set(outs.map((t) => this.chain(this.vertex(t.target))[0]));
    const others = this.topRegionIds.filter((r) => !entered.has(r)).map((r) => this.enterRegionStep(r));
    const name = ident(v.name, 'entry');
    return { name, id: v.id, steps: [...this.altsToSteps(alts, `entry point ${name}`), ...others] };
  }
}
