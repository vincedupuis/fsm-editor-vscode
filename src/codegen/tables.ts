/**
 * The code model as nested transition tables, for state machine frameworks
 * whose transitions stay inside one table (Boost.SML, Boost.MSM, ...): a
 * table per composite state holding the transitions between its substates,
 * and a table for the machine.
 *
 * Such frameworks can't express what UML transitions often do: leave a
 * composite state from one of its substates, enter a nested state directly,
 * go through entry/exit points, forks, joins or history. The tables do it
 * with two mechanisms that keep UML's order of exits, effects and entries:
 *
 * - Continuations (leaving from inside): the substate takes the event without
 *   changing state and posts a continuation event, which the table of the
 *   composite state being left takes right away (`continue` action). One
 *   continuation per state left, when effects come between the exits.
 * - Routing (entering inside): every region starts in an initial pseudostate
 *   (`init`) whose anonymous transitions enter the region by default, through
 *   a route set by the transition entering the composite state (`route`
 *   action), or restore its history. Routes may run effects (entry points).
 *
 * Completion events, deferral, timers and submachines are left to the
 * runtime of the template: the tables only say where they are taken.
 *
 * Everything here is language-neutral data; templates print it. `notes` lists
 * where the tables work around a missing feature, `problems` what they can't
 * express, so that templates can warn or refuse with their own wording.
 */
import type { CodeModel, CodeState, CodeTransition, CodeVia, Condition, Ref, Step } from './codeModel';

export interface CodeTables {
  /** One table per composite state, innermost first, then the machine's table (last). */
  list: CodeTable[];
  /** Events used by the tables besides the machine's events, numbered from 0. */
  events: TableEvent[];
  /** For each timer (code model `timers` index): its event. */
  timerEvents: Ref[];
  /** For each state: its completion event, or null when nothing waits for it. */
  completionEvents: (Ref | null)[];
  /** Postconditions of protocol machines, checked after their transition (`postcondition` action). */
  postconditions: { index: number; element: string; condition: Condition }[];
  /** Number of region entry routes, the first two being reserved (0 default entry, 1 deep resume). */
  routes: number;
  /** The machine's own entry points: the routes of its regions (`route` actions) to start through each. */
  entryPoints: { name: string; routes: TableAction[] }[];
  /** Where the tables work around something the frameworks lack. */
  notes: TableNote[];
  /** What they can't express. */
  problems: TableNote[];
}

export interface CodeTable {
  /** The composite state owning the table, or null for the machine's. */
  state: Ref | null;
  /** The state's name, or the machine's. */
  name: string;
  top: boolean;
  regions: TableRegion[];
  /** States directly in its regions. */
  states: CodeState[];
  /** Pseudostates of the table (initial, off, choice and exiting pseudostates). */
  pseudostates: TableState[];
  rows: TableRow[];
}

export interface TableRegion {
  index: number;
  name: string;
  /** Pseudostate the region starts in when its owner is entered. */
  init: TableState;
  /** Machine's table only: pseudostate the region waits in until the machine starts. */
  off: TableState | null;
}

/** A state of the table, or one of its pseudostates. */
export interface TableState {
  kind: 'state' | 'pseudo';
  name: string;
  /** State index, -1 for pseudostates. */
  index: number;
  /** A composite state, which has a table of its own. */
  composite: boolean;
  role: 'state' | 'init' | 'off' | 'choice' | 'exiting';
}

export interface TableEvent {
  index: number;
  /** Unique identifier among the table events. */
  name: string;
  kind: 'start' | 'stop' | 'timer' | 'completion' | 'continuation' | 'exitPoint';
  /** Completion and exit point events: the state; timers: the timer. */
  ref: Ref | null;
  /** Exit point events: the submachine's exit point. */
  point: string;
}

export interface TableRow {
  source: TableState;
  /** The source is its region's initial state. */
  initial: boolean;
  /**
   * `event`: a machine event (code model `events`); `table`: a table event; `entry`/`exit`: the source's entry or exit
   * (a `stateEntry` or `stateExit` action); null: anonymous, taken as soon as the source is entered.
   */
  trigger: { kind: 'event' | 'table' | 'entry' | 'exit'; name: string; index: number } | null;
  /** All must hold, evaluated in order. */
  guard: GuardTerm[];
  actions: TableAction[];
  /** null: an internal transition, without exit or entry. */
  target: TableState | null;
  /** What the row implements. */
  comment: string;
}

export type GuardTerm =
  | { kind: 'condition'; condition: Condition }
  /** Protocol machines: when false, remember `label` for a protocol violation. */
  | { kind: 'precondition'; condition: Condition; label: string }
  /** Joins: these states are active and completed. */
  | { kind: 'requires'; states: Ref[] }
  /** Offers the event to the submachine of `state`: true when it used it. */
  | { kind: 'offer'; state: Ref; submachine: string; event: string }
  /** The region is entered through `route`. */
  | { kind: 'routed'; region: number; route: number }
  /** The region is entered through `route`, which restores its history, and `state` was its last active state. */
  | { kind: 'restores'; region: number; route: number; state: Ref }
  /** The region is entered by default (route 0, or route 1 without history). */
  | { kind: 'defaults'; region: number };

export type TableAction =
  /** Entering `state`: mark it active, run its `entry` steps, start its submachine, then see whether it completes. */
  | { kind: 'stateEntry'; state: CodeState }
  /** Leaving `state` (its regions have been left): run its `exit` steps, then record it as its region's history. */
  | { kind: 'stateExit'; state: CodeState }
  | { kind: 'call'; action: string }
  | { kind: 'postcondition'; index: number }
  | { kind: 'terminate' }
  | { kind: 'exitMachine'; point: string }
  /** Post a continuation, taken before anything else. */
  | { kind: 'continue'; event: Ref }
  /** Enter `region` through `route` the next time it is entered; `history` 0 none, 1 shallow, 2 deep. */
  | { kind: 'route'; region: number; route: number; history: number }
  /** Start the submachine of `state` through its entry point `point` (index `pointIndex`) when entered. */
  | { kind: 'submachineAt'; state: Ref; submachine: string; point: string; pointIndex: number }
  /** The region is being entered: forget its route. */
  | { kind: 'entering'; region: number }
  /** The region is being entered through its history, `state`: forget its route, and pass deep history on. */
  | { kind: 'restore'; region: number; state: Ref }
  /** Keep the event until the configuration changes. */
  | { kind: 'defer' }
  /** A choice without an enabled branch. */
  | { kind: 'noBranch'; label: string };

export interface TableNote {
  kind:
    | 'leave' // a transition leaves a composite state from inside
    | 'enter' // a transition enters a state nested in a composite state
    | 'entryPoint'
    | 'exitPoint'
    | 'fork'
    | 'join'
    | 'history'
    | 'local'
    | 'orthogonal' // regions react to the same signal, one after the other
    | 'topRegions' // problem: a transition between top-level regions
    | 'localRegions' // problem: a local transition of a state with several regions
    | 'unexpected'; // problem: steps the tables can't place
  /** xmi:id of the element, for locations ('' when unknown). */
  id: string;
  /** The element: a transition label, a pseudostate or state name. */
  element: string;
  /** Kind-specific: the state taking the event (`leave`), the composite state left or entered, the region, the signal. */
  state: string;
  detail: string;
}

export function toTables(cm: Omit<CodeModel, 'tables'>): CodeTables {
  return new Lowering(cm).run();
}

// ------------------------------------------------------------------ lowering

const DEFAULT_ROUTE = 0;
const DEEP_ROUTE = 1;

interface Draft {
  table: CodeTable;
  rows: { row: TableRow; order: number; rank: number; seq: number }[];
}

/** What is being lowered, to name its continuations and report notes. */
interface Origin {
  key: string;
  label: string;
  id: string;
  via: CodeVia[];
  /** Set while lowering, shared with the branches of its choices: it left a composite state from inside, it routed into one. */
  found: { left?: { from: string; through: string }; entered?: { state: string; target: string } };
}

class Lowering {
  private drafts = new Map<number, Draft>();
  private events: TableEvent[] = [];
  private eventNames = new Set<string>();
  private continuations = new Map<string, Ref>();
  private hopsDone = new Set<string>();
  private routeKeys = new Map<string, number>();
  private routeCount = 2;
  private choiceCount = 0;
  private seq = 0;
  private postconditions: CodeTables['postconditions'] = [];
  private notes: TableNote[] = [];
  private problems: TableNote[] = [];
  private completionEvents: (Ref | null)[];
  private timerEvents: Ref[] = [];

  constructor(private cm: Omit<CodeModel, 'tables'>) {
    this.completionEvents = cm.states.map(() => null);
  }

  run(): CodeTables {
    const cm = this.cm;
    // Tables: composite states, innermost first, then the machine's.
    const order: number[] = [];
    const visit = (s: CodeState) => {
      for (const r of s.regions) for (const c of cm.regions[r.index].states) visit(cm.states[c.index]);
      if (s.regions.length) order.push(s.index);
    };
    for (const r of cm.topRegions) for (const c of r.states) visit(cm.states[c.index]);
    order.push(-1);
    for (const key of order) this.draft(key);

    // Events: timers first (their names are fixed), then start and stop.
    for (const t of cm.timers) this.timerEvents.push(this.event(t.name, 'timer', { name: t.name, index: t.index }));
    const start = this.event('start', 'start', null);
    const stop = this.event('stop', 'stop', null);

    // The machine's regions wait in `off` until started, and go back there when stopped.
    const top = this.drafts.get(-1)!;
    for (const r of top.table.regions) {
      this.add(-1, { source: r.off!, initial: true, trigger: this.tableTrigger(start), guard: [], actions: [], target: r.init, comment: `start ${r.name}` }, 0);
      for (const s of cm.regions[r.index].states) {
        this.add(-1, { source: this.stateOf(s.index), initial: false, trigger: this.tableTrigger(stop), guard: [], actions: [], target: r.off, comment: 'stop' }, 9);
      }
      this.add(-1, { source: r.init, initial: false, trigger: this.tableTrigger(stop), guard: [], actions: [], target: r.off, comment: 'stop' }, 9);
    }

    // Entry and exit of every state.
    for (const s of cm.states) {
      const key = this.tableOfState(s.index);
      const src = this.stateOf(s.index);
      this.add(key, { source: src, initial: false, trigger: { kind: 'entry', name: 'entry', index: -1 }, guard: [], actions: [{ kind: 'stateEntry', state: s }], target: null, comment: '' }, -1);
      this.add(key, { source: src, initial: false, trigger: { kind: 'exit', name: 'exit', index: -1 }, guard: [], actions: [{ kind: 'stateExit', state: s }], target: null, comment: '' }, -1);
    }

    // Region entries: default, deep resume.
    for (const r of cm.regions) this.regionEntries(r.index);

    // The machine's entry points.
    const entryPoints = cm.entryPoints.map((p) => {
      const origin: Origin = { key: `entry point ${p.name}`, label: `entry point ${p.name}`, id: p.id, via: [], found: {} };
      const top = cm.topRegions.map((r) => r.index);
      const { actions, end } = this.routeRegions(top, p.steps, 0, origin);
      if (end < p.steps.length) this.problems.push({ kind: 'unexpected', id: p.id, element: origin.label, state: '', detail: p.steps[end].kind });
      this.noteOrigin(origin);
      return { name: p.name, routes: actions };
    });

    // Transitions of each state.
    for (const s of cm.states) this.stateRows(s);

    this.orthogonalNotes();

    const list = order.map((key) => {
      const d = this.drafts.get(key)!;
      const pos = new Map<string, number>();
      d.table.states.forEach((s, i) => pos.set(`state:${s.name}`, i));
      d.table.pseudostates.forEach((p, i) => pos.set(`pseudo:${p.name}`, d.table.states.length + i));
      d.rows.sort((a, b) => a.order - b.order || a.rank - b.rank || a.seq - b.seq);
      d.table.rows = d.rows.map((x) => x.row);
      // The initial mark goes on the first row of each initial pseudostate.
      const marked = new Set<string>();
      for (const row of d.table.rows) {
        const initial = row.source.role === (d.table.top ? 'off' : 'init');
        row.initial = initial && !marked.has(row.source.name);
        if (initial) marked.add(row.source.name);
      }
      return d.table;
    });
    return {
      list,
      events: this.events,
      timerEvents: this.timerEvents,
      completionEvents: this.completionEvents,
      postconditions: this.postconditions,
      routes: this.routeCount,
      entryPoints,
      notes: dedupe(this.notes),
      problems: dedupe(this.problems),
    };
  }

  // -------------------------------------------------------------- tables, states, events

  private draft(key: number): Draft {
    const known = this.drafts.get(key);
    if (known) return known;
    const cm = this.cm;
    const state = key < 0 ? null : cm.states[key];
    const regions = state ? state.regions.map((r) => cm.regions[r.index]) : cm.topRegions;
    const pseudostates: TableState[] = [];
    const table: CodeTable = {
      state: state ? { name: state.name, index: state.index } : null,
      name: state ? state.name : cm.machine.name,
      top: !state,
      regions: regions.map((r) => {
        const init = pseudo(`${r.name}_init`, 'init');
        const off = state ? null : pseudo(`${r.name}_off`, 'off');
        pseudostates.push(init);
        if (off) pseudostates.push(off);
        return { index: r.index, name: r.name, init, off };
      }),
      states: regions.flatMap((r) => r.states.map((s) => cm.states[s.index])),
      pseudostates,
      rows: [],
    };
    const d: Draft = { table, rows: [] };
    this.drafts.set(key, d);
    return d;
  }

  /** Key of the table holding state `s` (its parent state, -1 for the machine). */
  private tableOfState(s: number): number {
    return this.cm.states[s].parentIndex;
  }

  private tableOfRegion(r: number): number {
    return this.cm.regions[r].ownerIndex;
  }

  private stateOf(s: number): TableState {
    const st = this.cm.states[s];
    return { kind: 'state', name: st.name, index: s, composite: st.regions.length > 0, role: 'state' };
  }

  private init(r: number): TableState {
    return this.draft(this.tableOfRegion(r)).table.regions.find((x) => x.index === r)!.init;
  }

  private exiting(key: number): TableState {
    const d = this.draft(key);
    let p = d.table.pseudostates.find((x) => x.role === 'exiting');
    if (!p) {
      p = pseudo(`${d.table.name}_exiting`, 'exiting');
      d.table.pseudostates.push(p);
    }
    return p;
  }

  private event(base: string, kind: TableEvent['kind'], ref: Ref | null, point = ''): Ref {
    let name = base;
    for (let i = 2; this.eventNames.has(name); i++) name = `${base}_${i}`;
    this.eventNames.add(name);
    const e: TableEvent = { index: this.events.length, name, kind, ref, point };
    this.events.push(e);
    return { name, index: e.index };
  }

  private tableTrigger(e: Ref): TableRow['trigger'] {
    return { kind: 'table', name: e.name, index: e.index };
  }

  private completionEvent(s: number): Ref {
    let e = this.completionEvents[s];
    if (!e) {
      e = this.event(`${this.cm.states[s].name}_done`, 'completion', { name: this.cm.states[s].name, index: s });
      this.completionEvents[s] = e;
    }
    return e;
  }

  /** Adds a row; rows are sorted by source, then `rank` (offers, own transitions, a parent's local ones, deferral, stop), then order of addition. */
  private add(key: number, row: TableRow, rank: number): void {
    const d = this.draft(key);
    const ix = row.source.kind === 'state' ? d.table.states.findIndex((s) => s.index === row.source.index) : d.table.states.length + d.table.pseudostates.indexOf(d.table.pseudostates.find((p) => p.name === row.source.name)!);
    d.rows.push({ row, order: ix < 0 ? Number.MAX_SAFE_INTEGER : ix, rank, seq: this.seq++ });
  }

  private isAncestor(a: number, s: number): boolean {
    for (let p = this.cm.states[s].parentIndex; p >= 0; p = this.cm.states[p].parentIndex) if (p === a) return true;
    return false;
  }

  // -------------------------------------------------------------- regions

  private regionEntries(r: number): void {
    const cm = this.cm;
    const region = cm.regions[r];
    const key = this.tableOfRegion(r);
    const init = this.init(r);
    const origin: Origin = { key: `initial of ${region.name}`, label: `initial transition of ${region.displayName}`, id: '', via: [], found: {} };
    if (region.defaultSteps.length) this.lowerInit(r, [{ kind: 'defaults', region: r }], region.defaultSteps, origin);
    // Deep resume (resume(), deep history above): the region's last active state, or its default entry.
    for (const s of region.states) {
      if (cm.states[s.index].isFinal) continue;
      this.add(key, { source: init, initial: false, trigger: null, guard: [{ kind: 'restores', region: r, route: DEEP_ROUTE, state: s }], actions: [{ kind: 'restore', region: r, state: s }], target: this.stateOf(s.index), comment: `resume ${s.name}` }, 1);
    }
    this.noteOrigin(origin);
  }

  /** The route entering region `r` through `steps` (prefix calls, then the region's entry); created once per distinct steps. */
  private route(r: number, steps: Step[], origin: Origin): number {
    const key = `${r}|${JSON.stringify(steps)}`;
    const known = this.routeKeys.get(key);
    if (known !== undefined) return known;
    const route = this.routeCount++;
    this.routeKeys.set(key, route);
    const last = steps[steps.length - 1];
    if (last?.kind === 'restoreHistory') {
      const prefix = steps.slice(0, -1);
      const tableKey = this.tableOfRegion(r);
      for (const s of this.cm.regions[r].states) {
        if (this.cm.states[s.index].isFinal) continue;
        this.add(tableKey, {
          source: this.init(r),
          initial: false,
          trigger: null,
          guard: [{ kind: 'restores', region: r, route, state: s }],
          actions: [...this.callActions(prefix), { kind: 'restore', region: r, state: s }],
          target: this.stateOf(s.index),
          comment: `${last.deep ? 'deep' : 'shallow'} history of ${last.region}: ${s.name}`,
        }, 1);
      }
      // Without history: the history's default transition, or the region's default entry.
      const def = last.defaultSteps;
      const own = def.length === 1 && def[0].kind === 'enterRegion' && def[0].regionIndex === r;
      this.lowerInit(r, [{ kind: 'routed', region: r, route }], [...prefix, ...(own ? this.cm.regions[r].defaultSteps : def)], origin);
    } else {
      this.lowerInit(r, [{ kind: 'routed', region: r, route }], steps, origin);
    }
    return route;
  }

  /** An anonymous row of the region's initial pseudostate doing `steps`. */
  private lowerInit(r: number, guard: GuardTerm[], steps: Step[], origin: Origin): void {
    const init = this.init(r);
    const key = this.tableOfRegion(r);
    this.lowerFire(init, key, null, guard, steps, origin, 2, [{ kind: 'entering', region: r }]);
  }

  // -------------------------------------------------------------- states

  private stateRows(s: CodeState): void {
    const cm = this.cm;
    const key = this.tableOfState(s.index);
    const src = this.stateOf(s.index);
    // A submachine gets the events it knows first.
    if (s.submachine) {
      const sub = cm.submachines.find((x) => x.href === s.submachine!.href)!;
      for (const name of sub.events) {
        const e = cm.events.find((x) => x.name === name);
        if (!e) continue;
        this.add(key, { source: src, initial: false, trigger: { kind: 'event', name: e.name, index: e.index }, guard: [{ kind: 'offer', state: { name: s.name, index: s.index }, submachine: sub.name, event: e.name }], actions: [], target: null, comment: `${sub.name} submachine` }, 0);
      }
    }
    for (const h of s.handlers) {
      const trigger: TableRow['trigger'] = h.kind === 'event' ? { kind: 'event', name: h.signal, index: cm.events.find((e) => e.name === h.signal)!.index } : this.tableTrigger(this.timerEvents[h.signalIndex - cm.events.length]);
      this.candidates(s, trigger, h.candidates);
    }
    for (const d of s.deferred) {
      const e = cm.events.find((x) => x.name === d.name)!;
      this.add(key, { source: src, initial: false, trigger: { kind: 'event', name: e.name, index: e.index }, guard: [], actions: [{ kind: 'defer' }], target: null, comment: `defer ${e.name}` }, 8);
    }
    if (s.completion.length) this.candidates(s, this.tableTrigger(this.completionEvent(s.index)), s.completion);
    for (const x of s.exits) {
      const e = this.event(`${s.name}_${x.point}`, 'exitPoint', { name: s.name, index: s.index }, x.point);
      this.candidates(s, this.tableTrigger(e), x.candidates);
    }
  }

  private candidates(s: CodeState, trigger: TableRow['trigger'], cands: CodeState['completion']): void {
    const cm = this.cm;
    const local = cands.some((c) => cm.transitions[c.transitionIndex].kind === 'local');
    if (local && s.regions.length > 1) {
      for (const c of cands) {
        const tr = cm.transitions[c.transitionIndex];
        if (tr.kind === 'local') this.problems.push({ kind: 'localRegions', id: tr.id, element: tr.label, state: s.name, detail: '' });
      }
      return;
    }
    for (const c of cands) {
      const tr = cm.transitions[c.transitionIndex];
      const guard: GuardTerm[] = [];
      if (c.requires.length) guard.push({ kind: 'requires', states: c.requires });
      if (c.guard) guard.push({ kind: 'condition', condition: c.guard });
      if (c.precondition) guard.push({ kind: 'precondition', condition: c.precondition, label: c.label });
      const origin: Origin = { key: `t${tr.index}`, label: tr.label, id: tr.id, via: tr.via, found: {} };
      if (!local) {
        this.lowerFire(this.stateOf(s.index), this.tableOfState(s.index), trigger, guard, tr.steps, origin, 1);
      } else {
        // A local transition doesn't leave `s`: its substates take the event, after their own transitions. The other
        // transitions of `s` for this trigger go along, to keep their order.
        const region = s.regions[0].index;
        let steps = tr.steps;
        if (tr.kind === 'local') {
          this.notes.push({ kind: 'local', id: tr.id, element: tr.label, state: s.name, detail: '' });
          const head = steps[0];
          if (head?.kind !== 'exitRegion' || head.regionIndex !== region) {
            this.problems.push({ kind: 'unexpected', id: tr.id, element: tr.label, state: s.name, detail: 'local transition' });
            continue;
          }
          steps = steps.slice(1);
        }
        for (const y of cm.regions[region].states) {
          const own: Step[] = tr.kind === 'local' ? [{ kind: 'exit', state: y.name, stateIndex: y.index }, ...steps] : steps;
          this.lowerFire(this.stateOf(y.index), this.tableOfState(y.index), trigger, guard, own, origin, 2);
        }
      }
      this.noteOrigin(origin);
    }
  }

  // -------------------------------------------------------------- transitions

  /**
   * Rows doing `steps` from `src` (in table `key`): exits and effects, possibly
   * through continuations to the tables of the composite states left, then the
   * entries in the table of the last state left.
   */
  private lowerFire(src: TableState, key: number, trigger: TableRow['trigger'], guard: GuardTerm[], steps: Step[], origin: Origin, rank: number, first: TableAction[] = []): void {
    // Exits and the effects after each: the hops.
    const hops: { exit: number; calls: Step[] }[] = [];
    let i = 0;
    const lead: Step[] = [];
    if (steps[0]?.kind === 'exitRegion') {
      this.problems.push({ kind: 'topRegions', id: origin.id, element: origin.label, state: '', detail: '' });
      return;
    }
    while (i < steps.length && (steps[i].kind === 'exit' || steps[i].kind === 'call')) {
      const st = steps[i++];
      if (st.kind === 'exit') {
        const prev = hops[hops.length - 1];
        if (prev && !this.isAncestor(st.stateIndex, prev.exit)) {
          this.problems.push({ kind: 'unexpected', id: origin.id, element: origin.label, state: st.state, detail: 'exit' });
          return;
        }
        hops.push({ exit: st.stateIndex, calls: [] });
      } else if (hops.length) hops[hops.length - 1].calls.push(st);
      else lead.push(st);
    }
    const entries = steps.slice(i);
    const comment = origin.label;

    if (!hops.length) {
      const e = this.lowerEntries(entries, key, origin);
      if (!e) return;
      this.add(key, { source: src, initial: false, trigger, guard, actions: [...first, ...this.callActions(lead), ...e.actions], target: e.target, comment }, rank);
      return;
    }
    if (lead.length) {
      this.problems.push({ kind: 'unexpected', id: origin.id, element: origin.label, state: '', detail: 'effect before exit' });
      return;
    }
    let from = 0;
    if (src.kind === 'state' && hops[0].exit === src.index) {
      // The source leaves itself in its own table.
      if (hops.length === 1) {
        const e = this.lowerEntries(entries, key, origin, this.cm.states[src.index].regionIndex);
        if (!e) return;
        this.add(key, { source: src, initial: false, trigger, guard, actions: [...first, ...this.callActions(hops[0].calls), ...e.actions], target: e.target, comment }, rank);
        return;
      }
      const next = this.continuation(origin, 1);
      this.add(key, { source: src, initial: false, trigger, guard, actions: [...first, ...this.callActions(hops[0].calls), { kind: 'continue', event: next }], target: this.exiting(key), comment }, rank);
      from = 1;
    } else {
      // Leaving from inside: the source takes the event, the table of the state left continues.
      const owner = key;
      const inside = src.kind === 'state' ? this.isAncestor(hops[0].exit, src.index) : owner === hops[0].exit || (owner >= 0 && this.isAncestor(hops[0].exit, owner));
      if (!inside) {
        this.problems.push({ kind: 'unexpected', id: origin.id, element: origin.label, state: this.cm.states[hops[0].exit].name, detail: 'exit' });
        return;
      }
      const next = this.continuation(origin, 0);
      // A pseudostate (choice) has to be left, or it would be taken again.
      this.add(key, { source: src, initial: false, trigger, guard, actions: [...first, { kind: 'continue', event: next }], target: src.kind === 'state' ? null : this.exiting(key), comment }, rank);
      origin.found.left = { from: src.kind === 'state' ? src.name : 'a choice', through: this.cm.states[hops[hops.length - 1].exit].name };
    }
    for (let k = from; k < hops.length; k++) this.hop(origin, hops, k, entries);
  }

  /** The row of the table of `hops[k].exit` taking its continuation (once per transition and hop). */
  private hop(origin: Origin, hops: { exit: number; calls: Step[] }[], k: number, entries: Step[]): void {
    const event = this.continuation(origin, k);
    if (this.hopsDone.has(`${origin.key}|${k}`)) return;
    this.hopsDone.add(`${origin.key}|${k}`);
    const x = hops[k].exit;
    const key = this.tableOfState(x);
    const last = k === hops.length - 1;
    let actions = this.callActions(hops[k].calls);
    let target: TableState | null;
    if (last) {
      const e = this.lowerEntries(entries, key, origin, this.cm.states[x].regionIndex);
      if (!e) return;
      actions = [...actions, ...e.actions];
      target = e.target;
    } else {
      actions = [...actions, { kind: 'continue', event: this.continuation(origin, k + 1) }];
      target = this.exiting(key);
    }
    this.add(key, { source: this.stateOf(x), initial: false, trigger: this.tableTrigger(event), guard: [], actions, target, comment: `${origin.label}: leave ${this.cm.states[x].name}` }, 1);
  }

  private continuation(origin: Origin, k: number): Ref {
    const key = `${origin.key}|${k}`;
    let e = this.continuations.get(key);
    if (!e) {
      e = this.event(`${ident(origin.label)}_${k + 1}`, 'continuation', null);
      this.continuations.set(key, e);
    }
    return e;
  }

  /** Actions and target of the entries `steps`, all in table `key`. `exitedRegion`: region of the last state left. */
  private lowerEntries(steps: Step[], key: number, origin: Origin, exitedRegion = -1): { actions: TableAction[]; target: TableState | null } | null {
    const cm = this.cm;
    const actions: TableAction[] = [];
    let target: TableState | null = null;
    const fail = (detail: string) => {
      this.problems.push({ kind: detail === 'regions' ? 'topRegions' : 'unexpected', id: origin.id, element: origin.label, state: '', detail });
      return null;
    };
    for (let i = 0; i < steps.length; ) {
      const st = steps[i];
      switch (st.kind) {
        case 'call':
          actions.push({ kind: 'call', action: st.action });
          i++;
          break;
        case 'enter': {
          if (target) return fail('regions');
          if (this.tableOfState(st.stateIndex) !== key) return fail('enter');
          target = this.stateOf(st.stateIndex);
          const inner = this.inside(st.stateIndex, steps, i + 1, origin);
          actions.push(...inner.actions);
          i = inner.end;
          break;
        }
        case 'choice':
          if (target) return fail('regions');
          target = this.choice(st, key, origin);
          i++;
          break;
        case 'restoreHistory':
        case 'enterRegion':
          if (target) return fail('regions');
          if (this.tableOfRegion(st.regionIndex) !== key) return fail('region');
          if (st.kind === 'restoreHistory') {
            actions.push({ kind: 'route', region: st.regionIndex, route: this.route(st.regionIndex, [st], origin), history: st.deep ? 2 : 1 });
          }
          target = this.init(st.regionIndex);
          i++;
          break;
        case 'terminate':
          actions.push({ kind: 'terminate' });
          i++;
          break;
        case 'exitMachine': {
          actions.push({ kind: 'exitMachine', point: st.point });
          const region = cm.regions[exitedRegion];
          if (!region || !region.top) return fail('exitMachine');
          target = this.draft(-1).table.regions.find((r) => r.index === exitedRegion)!.off;
          i++;
          break;
        }
        case 'check':
          actions.push({ kind: 'postcondition', index: this.postcondition(st.element, st.condition) });
          i++;
          break;
        default:
          return fail(st.kind);
      }
    }
    return { actions, target };
  }

  private postcondition(element: string, condition: Condition): number {
    const json = JSON.stringify(condition);
    let p = this.postconditions.find((x) => x.element === element && JSON.stringify(x.condition) === json);
    if (!p) {
      p = { index: this.postconditions.length, element, condition };
      this.postconditions.push(p);
    }
    return p.index;
  }

  /** Steps from `i` entering the inside of state `s` (just entered): routes for its regions, its submachine's entry point. */
  private inside(s: number, steps: Step[], i: number, origin: Origin): { actions: TableAction[]; end: number } {
    return this.routeRegions(this.cm.states[s].regions.map((r) => r.index), steps, i, origin, s);
  }

  /** Steps from `i` entering `regionList` (of state `s`, or the machine's): the routes to enter them that way. */
  private routeRegions(regionList: number[], steps: Step[], i: number, origin: Origin, s = -1): { actions: TableAction[]; end: number } {
    const cm = this.cm;
    const state = s >= 0 ? cm.states[s] : null;
    const regions = new Set(regionList);
    const actions: TableAction[] = [];
    const prefix: Step[] = [];
    let first = true;
    while (i < steps.length) {
      const st = steps[i];
      if (st.kind === 'call' && first && regions.size) {
        prefix.push(st);
        i++;
        continue;
      }
      if (state && st.kind === 'startSubmachine' && st.stateIndex === s) {
        if (st.point) {
          const sub = cm.submachines.find((x) => x.href === state.submachine?.href);
          actions.push({ kind: 'submachineAt', state: { name: state.name, index: s }, submachine: sub?.name ?? '', point: st.point, pointIndex: sub ? sub.entryPoints.indexOf(st.point) : -1 });
        }
        i++;
        continue;
      }
      const r = regionOfStep(cm, st);
      if (r < 0 || !regions.has(r)) break;
      const start = i;
      i = st.kind === 'enter' ? this.skipInside(st.stateIndex, steps, i + 1) : i + 1;
      const regionSteps = steps.slice(start, i);
      const pre = first ? prefix : [];
      first = false;
      if (st.kind === 'enterRegion') {
        if (pre.length) actions.push({ kind: 'route', region: r, route: this.route(r, [...pre, ...cm.regions[r].defaultSteps], origin), history: 0 });
        continue;
      }
      // The region's own default entry needs no route.
      if (!pre.length && JSON.stringify(regionSteps) === JSON.stringify(cm.regions[r].defaultSteps)) continue;
      if (state && !origin.found.entered) origin.found.entered = { state: state.name, target: st.kind === 'enter' ? st.state : st.kind === 'choice' ? 'a choice' : 'its history' };
      const history = st.kind === 'restoreHistory' ? (st.deep ? 2 : 1) : 0;
      actions.push({ kind: 'route', region: r, route: this.route(r, [...pre, ...regionSteps], origin), history });
    }
    return { actions, end: i };
  }

  /** End of the steps entering the inside of state `s`, from `i`. */
  private skipInside(s: number, steps: Step[], i: number): number {
    const cm = this.cm;
    const regions = new Set(cm.states[s].regions.map((r) => r.index));
    let first = true;
    while (i < steps.length) {
      const st = steps[i];
      if (st.kind === 'call' && first && regions.size) {
        i++;
        continue;
      }
      if (st.kind === 'startSubmachine' && st.stateIndex === s) {
        i++;
        continue;
      }
      const r = regionOfStep(cm, st);
      if (r < 0 || !regions.has(r)) break;
      first = false;
      i = st.kind === 'enter' ? this.skipInside(st.stateIndex, steps, i + 1) : i + 1;
    }
    return i;
  }

  /** A choice pseudostate in table `key`, with an anonymous row per branch. */
  private choice(st: Extract<Step, { kind: 'choice' }>, key: number, origin: Origin): TableState {
    const p = pseudo(`choice_${++this.choiceCount}`, 'choice');
    this.draft(key).table.pseudostates.push(p);
    st.branches.forEach((b, n) => {
      const guard: GuardTerm[] = b.guard ? [{ kind: 'condition', condition: b.guard }] : [];
      this.lowerFire(p, key, null, guard, b.steps, { ...origin, key: `${origin.key}|${p.name}.${n}` }, 1);
    });
    if (!st.hasElse) this.add(key, { source: p, initial: false, trigger: null, guard: [], actions: [{ kind: 'noBranch', label: st.label }], target: null, comment: 'no branch can be taken' }, 1);
    return p;
  }

  private callActions(steps: Step[]): TableAction[] {
    return steps.filter((s): s is Extract<Step, { kind: 'call' }> => s.kind === 'call').map((s) => ({ kind: 'call', action: s.action }));
  }

  // -------------------------------------------------------------- notes

  /** What lowering `origin` worked around, named after the pseudostates it went through when there are some. */
  private noteOrigin(origin: Origin): void {
    const viaOf = (...kinds: CodeVia['kind'][]) => origin.via.filter((v) => kinds.includes(v.kind));
    const note = (kind: TableNote['kind'], id: string, element: string, state: string, detail = '') => this.notes.push({ kind, id, element, state, detail });
    const via = viaOf('exitPoint', 'join', 'entryPoint', 'fork', 'shallowHistory', 'deepHistory');
    for (const v of via) {
      const kind = v.kind === 'shallowHistory' || v.kind === 'deepHistory' ? 'history' : v.kind;
      note(kind as TableNote['kind'], v.id, v.name, '', v.kind === 'deepHistory' ? 'deep' : v.kind === 'shallowHistory' ? 'shallow' : '');
    }
    const { left, entered } = origin.found;
    if (left && !viaOf('exitPoint', 'join').length) note('leave', origin.id, origin.label, left.from, left.through);
    if (entered && !viaOf('entryPoint', 'fork', 'shallowHistory', 'deepHistory').length) note('enter', origin.id, origin.label, entered.state, entered.target);
  }

  /** Orthogonal regions that react to the same signal run one after the other: a later region's guards see the earlier ones' effects. */
  private orthogonalNotes(): void {
    const cm = this.cm;
    const owners: (CodeState | null)[] = [null, ...cm.states.filter((s) => s.regions.length > 1)];
    for (const owner of owners) {
      const regions = owner ? owner.regions.map((r) => r.index) : cm.topRegions.map((r) => r.index);
      if (regions.length < 2) continue;
      const signals = new Map<string, { region: number; guarded: boolean }[]>();
      for (const r of regions) {
        const inside: CodeState[] = [];
        const walk = (rr: number) => {
          for (const s of cm.regions[rr].states) {
            inside.push(cm.states[s.index]);
            for (const sub of cm.states[s.index].regions) walk(sub.index);
          }
        };
        walk(r);
        for (const s of inside) {
          for (const h of s.handlers) {
            const list = signals.get(h.signal) ?? [];
            const guarded = h.candidates.some((c) => c.guard || c.precondition);
            const known = list.find((x) => x.region === r);
            if (known) known.guarded ||= guarded;
            else list.push({ region: r, guarded });
            signals.set(h.signal, list);
          }
        }
      }
      for (const [signal, list] of signals) {
        if (list.length < 2 || !list.slice(1).some((x) => x.guarded)) continue;
        this.notes.push({ kind: 'orthogonal', id: owner?.id ?? '', element: owner?.name ?? cm.machine.name, state: owner?.name ?? cm.machine.name, detail: signal });
      }
    }
  }
}

function pseudo(name: string, role: TableState['role']): TableState {
  return { kind: 'pseudo', name, index: -1, composite: false, role };
}

function regionOfStep(cm: Omit<CodeModel, 'tables'>, st: Step): number {
  switch (st.kind) {
    case 'enter':
      return cm.states[st.stateIndex].regionIndex;
    case 'enterRegion':
    case 'restoreHistory':
    case 'choice':
      return st.regionIndex;
    default:
      return -1;
  }
}

function ident(text: string): string {
  const s = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'transition';
  return /^\d/.test(s) ? `_${s}` : s;
}

function dedupe(notes: TableNote[]): TableNote[] {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const key = `${n.kind}|${n.id}|${n.element}|${n.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
