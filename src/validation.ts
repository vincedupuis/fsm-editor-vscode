import * as expr from '../media/expressions';
import { FsmModel, ModelIndex, PSEUDOSTATES, SubmachineInfo, Vertex } from './model';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  /** Id of the offending vertex or transition ('' for the machine itself). */
  id: string;
  severity: Severity;
  message: string;
}

/**
 * Checks the UML 2.5.1 well-formedness rules that apply to state machines.
 * `submachines` describes the machines referenced by submachine states, when known.
 */
export function validate(model: FsmModel, submachines: SubmachineInfo = {}): Issue[] {
  const ix = new ModelIndex(model);
  const issues: Issue[] = [];
  const add = (id: string, severity: Severity, message: string) => issues.push({ id, severity, message });
  const protocol = model.kind === 'protocol';

  const machineName = (href: string) => {
    const n = submachines[href]?.name;
    return n ? `'${n}'` : `'${href}'`;
  };

  const name = (v: Vertex | undefined) => {
    if (!v) return '?';
    if (v.name) return `'${v.name}'`;
    return TYPE_LABEL[v.type] ?? v.type;
  };

  // Identity
  const seen = new Set<string>();
  for (const el of [...model.vertices, ...model.transitions]) {
    if (seen.has(el.id)) add(el.id, 'error', `Duplicate id '${el.id}'.`);
    seen.add(el.id);
  }

  // Containment
  for (const v of model.vertices) {
    if (v.type === 'entryPoint' || v.type === 'exitPoint') {
      // Either on the border of a state, or a connection point of the machine itself (top-level region).
      const owner = ix.vertices.get(v.parent);
      const machineLevel = model.regions.some((r) => r.id === v.parent);
      if (machineLevel) {
        if (!v.name) add(v.id, 'warning', `Connection points of the state machine need a name so submachine states can reference them.`);
      } else if (!owner || owner.type !== 'state') {
        add(v.id, 'error', `${name(v)}: entry and exit points belong on the border of a state or at the top level of the state machine.`);
      } else if (owner.submachine) {
        add(v.id, 'error', `A submachine state cannot own entry/exit points; use a connection point reference to a point of ${machineName(owner.submachine)} instead.`);
      } else if (!owner.regions?.length) {
        add(v.id, 'warning', `Only composite states can have entry/exit points; add a region to ${name(owner)}.`);
      }
    } else if (v.type === 'connectionPointRef') {
      const owner = ix.vertices.get(v.parent);
      if (!owner || owner.type !== 'state' || !owner.submachine) {
        add(v.id, 'error', 'A connection point reference must be placed on the border of a submachine state.');
      }
    } else if (!ix.regionOwner.has(v.parent)) {
      add(v.id, 'error', `${name(v)} is not contained in a known region.`);
    }
  }

  // Regions
  const allRegions = [...model.regions, ...model.vertices.flatMap((v) => v.regions ?? [])];
  for (const r of allRegions) {
    const kids = ix.childrenOf(r.id);
    const count = (t: string) => kids.filter((k) => k.type === t);
    const owner = ix.regionOwner.get(r.id);
    const where = owner ? `region of ${name(owner)}` : 'top-level region';
    for (const [type, label] of [
      ['initial', 'initial pseudostate'],
      ['shallowHistory', 'shallow history'],
      ['deepHistory', 'deep history'],
    ] as const) {
      const found = count(type);
      if (found.length > 1) {
        for (const k of found.slice(1)) add(k.id, 'error', `A ${where} can contain at most one ${label}.`);
      }
    }
    if ((count('shallowHistory').length || count('deepHistory').length) && !owner) {
      for (const k of kids.filter((x) => x.type === 'shallowHistory' || x.type === 'deepHistory')) {
        add(k.id, 'warning', 'History pseudostates are only meaningful inside a composite state.');
      }
    }
    // Default entry of a composite state targeted directly needs an initial pseudostate.
    if (owner && !count('initial').length) {
      const entered = model.transitions.some(
        (t) => t.target === owner.id && t.kind !== 'internal' && !ix.isInside(ix.vertices.get(t.source) ?? owner, owner.id),
      );
      if (entered && kids.some((k) => k.type === 'state')) {
        add(owner.id, 'warning', `${name(owner)} is entered by default but its ${r.name ? `region '${r.name}'` : 'region'} has no initial pseudostate.`);
      }
    }
  }

  // Names unique within a region
  const byRegion = new Map<string, Map<string, Vertex>>();
  for (const v of model.vertices) {
    if (v.type !== 'state' || !v.name) continue;
    const m = byRegion.get(v.parent) ?? new Map<string, Vertex>();
    byRegion.set(v.parent, m);
    if (m.has(v.name)) add(v.id, 'warning', `Another state named '${v.name}' exists in the same region.`);
    else m.set(v.name, v);
  }

  // Vertices
  for (const v of model.vertices) {
    const out = ix.outgoing(v.id).filter((t) => t.kind !== 'internal');
    const inc = ix.incoming(v.id).filter((t) => t.kind !== 'internal');
    switch (v.type) {
      case 'initial':
        if (out.length !== 1) add(v.id, 'error', 'An initial pseudostate must have exactly one outgoing transition.');
        if (inc.length) add(v.id, 'error', 'An initial pseudostate cannot have incoming transitions.');
        for (const t of out) {
          if (t.guard) add(t.id, 'error', 'The transition leaving an initial pseudostate cannot have a guard.');
        }
        break;
      case 'final':
        if (out.length) add(v.id, 'error', 'A final state cannot have outgoing transitions.');
        if (v.regions?.length || v.entry || v.exit || v.doActivity) {
          add(v.id, 'error', 'A final state cannot have regions or entry/exit/do behaviors.');
        }
        break;
      case 'terminate':
        if (out.length) add(v.id, 'error', 'A terminate pseudostate cannot have outgoing transitions.');
        break;
      case 'shallowHistory':
      case 'deepHistory':
        if (out.length > 1) add(v.id, 'error', 'A history pseudostate can have at most one outgoing (default) transition.');
        break;
      case 'fork': {
        if (inc.length !== 1) add(v.id, 'error', 'A fork must have exactly one incoming transition.');
        if (out.length < 2) add(v.id, 'error', 'A fork must have at least two outgoing transitions.');
        for (const t of out) {
          if (t.guard || t.triggers.length) add(t.id, 'error', 'Transitions leaving a fork cannot have guards or triggers.');
        }
        const regions = out.map((t) => ix.vertices.get(t.target)?.parent);
        if (new Set(regions).size !== regions.length) {
          add(v.id, 'warning', 'The targets of a fork should be in different orthogonal regions.');
        }
        break;
      }
      case 'join': {
        if (out.length !== 1) add(v.id, 'error', 'A join must have exactly one outgoing transition.');
        if (inc.length < 2) add(v.id, 'error', 'A join must have at least two incoming transitions.');
        for (const t of inc) {
          if (t.guard || t.triggers.length) add(t.id, 'error', 'Transitions entering a join cannot have guards or triggers.');
        }
        const regions = inc.map((t) => ix.vertices.get(t.source)?.parent);
        if (new Set(regions).size !== regions.length) {
          add(v.id, 'warning', 'The sources of a join should be in different orthogonal regions.');
        }
        break;
      }
      case 'choice':
      case 'junction': {
        if (!inc.length) add(v.id, 'error', `A ${v.type} must have at least one incoming transition.`);
        if (!out.length) add(v.id, 'error', `A ${v.type} must have at least one outgoing transition.`);
        if (out.length > 1) {
          const unguarded = out.filter((t) => !t.guard.trim());
          if (unguarded.length) add(v.id, 'warning', `Every branch of a ${v.type} with several outgoing transitions should have a guard.`);
          if (!out.some((t) => t.guard.trim() === 'else')) {
            add(v.id, 'info', `Consider an [else] branch so the ${v.type} can always be left.`);
          }
        }
        break;
      }
      case 'entryPoint': {
        const owner = ix.vertices.get(v.parent);
        if (!owner && !out.length) {
          add(v.id, 'warning', `Entry point ${name(v)} of the state machine has no outgoing transition.`);
        }
        if (owner) {
          for (const t of out) {
            const target = ix.vertices.get(t.target);
            if (target && !ix.isInside(target, owner.id)) {
              add(t.id, 'error', `Transitions leaving entry point ${name(v)} must target a vertex inside ${name(owner)}.`);
            }
          }
        }
        break;
      }
      case 'exitPoint': {
        const owner = ix.vertices.get(v.parent);
        if (!owner && out.length) {
          for (const t of out) {
            add(t.id, 'error', `Exit point ${name(v)} of the state machine cannot have outgoing transitions; the referencing submachine state continues from its connection point reference.`);
          }
        }
        if (owner) {
          for (const t of out) {
            const target = ix.vertices.get(t.target);
            if (target && (target.id === owner.id || ix.isInside(target, owner.id))) {
              add(t.id, 'error', `Transitions leaving exit point ${name(v)} must target a vertex outside ${name(owner)}.`);
            }
          }
        }
        break;
      }
      case 'connectionPointRef': {
        const owner = ix.vertices.get(v.parent);
        const kind = v.pointKind ?? 'entry';
        const info = owner?.submachine ? submachines[owner.submachine] : undefined;
        const target = info?.found ? info.points.find((p) => p.id === v.ref) : undefined;
        const label = target?.name ? `'${target.name}'` : 'connection point reference';
        if (!v.ref) {
          add(v.id, 'error', 'The connection point reference does not refer to an entry or exit point of the submachine.');
        } else if (owner?.submachine && info?.found) {
          if (!target) {
            add(v.id, 'error', `${machineName(owner.submachine)} has no entry or exit point with id '${v.ref}'.`);
          } else if (target.kind !== kind) {
            add(v.id, 'error', `${label} is an ${target.kind} point of ${machineName(owner.submachine)}, but it is referenced as an ${kind} point.`);
          }
        }
        if (kind === 'entry') {
          if (out.length) add(v.id, 'error', `Entry reference ${label} cannot have outgoing transitions; execution continues at the entry point inside the submachine.`);
          if (!inc.length) add(v.id, 'warning', `Entry reference ${label} has no incoming transition.`);
          for (const t of inc) {
            const src = ix.vertices.get(t.source);
            if (src && owner && (src.id === owner.id || ix.isInside(src, owner.id))) {
              add(t.id, 'error', `Transitions into entry reference ${label} must come from outside ${name(owner)}.`);
            }
          }
        } else {
          if (inc.length) add(v.id, 'error', `Exit reference ${label} cannot have incoming transitions; it is reached when the submachine leaves through its exit point.`);
          if (!out.length) add(v.id, 'warning', `Exit reference ${label} has no outgoing transition.`);
        }
        if (owner) {
          const dup = model.vertices.find(
            (o) => o !== v && o.type === 'connectionPointRef' && o.parent === owner.id && o.ref && o.ref === v.ref,
          );
          if (dup && model.vertices.indexOf(dup) < model.vertices.indexOf(v)) {
            add(v.id, 'warning', `${name(owner)} already references ${label}.`);
          }
        }
        break;
      }
      case 'state':
        if (v.submachine) {
          const info = submachines[v.submachine];
          if (info && !info.found) {
            add(v.id, 'error', `The referenced state machine '${v.submachine}' was not found.`);
          }
        }
        if (v.submachine && v.regions?.length) {
          add(v.id, 'error', `Submachine state ${name(v)} cannot also own regions.`);
        }
        if (protocol && (v.entry || v.exit || v.doActivity)) {
          add(v.id, 'error', `States of a protocol state machine cannot have entry/exit/do behaviors (${name(v)}).`);
        }
        break;
    }
  }

  // Transitions
  for (const t of model.transitions) {
    const s = ix.vertices.get(t.source);
    const g = ix.vertices.get(t.target);
    if (!s) add(t.id, 'error', `Transition source '${t.source}' does not exist.`);
    if (!g) add(t.id, 'error', `Transition target '${t.target}' does not exist.`);
    if (!s || !g) continue;
    if (s.type === 'comment' || g.type === 'comment') {
      add(t.id, 'error', 'Comments cannot be connected by transitions.');
      continue;
    }
    if ((PSEUDOSTATES.has(s.type) || s.type === 'connectionPointRef') && t.triggers.length) {
      add(t.id, 'error', `Transitions leaving a pseudostate cannot have triggers (from ${name(s)}).`);
    }
    if (t.kind === 'internal') {
      if (s !== g || s.type !== 'state') add(t.id, 'error', 'An internal transition must start and end on the same state.');
    }
    if (t.kind === 'local') {
      const composite = s.type === 'state' && (s.regions?.length ?? 0) > 0;
      if (!(composite || s.type === 'entryPoint') || !(g === s || ix.isInside(g, s.type === 'entryPoint' ? s.parent : s.id))) {
        add(t.id, 'error', 'A local transition must go from a composite state to a vertex it contains.');
      }
    }
    if (protocol) {
      if (t.effect) add(t.id, 'error', 'Protocol transitions cannot have effects.');
      if (t.guard) add(t.id, 'warning', 'Use a precondition instead of a guard in a protocol state machine.');
    } else if (t.precondition || t.postcondition) {
      add(t.id, 'warning', 'Pre/postconditions only apply to protocol state machines and are ignored.');
    }
    if (s.type === 'state' && g.type === 'state' && !t.triggers.length && !t.guard && s !== g && !(s.regions?.length)) {
      if (ix.outgoing(s.id).filter((o) => o.kind !== 'internal' && !o.triggers.length).length > 1) {
        add(t.id, 'warning', `${name(s)} has several completion transitions without triggers or guards.`);
      }
    }
  }

  checkText(model, ix, add, name);
  checkReachability(model, ix, add, name);
  return issues;
}

/** Behaviors and conditions are argument-less function calls; triggers are event names or after(...). */
function checkText(
  model: FsmModel,
  ix: ModelIndex,
  add: (id: string, severity: Severity, message: string) => void,
  name: (v: Vertex | undefined) => string,
) {
  const report = (id: string, what: string, r: expr.Check<unknown>) => {
    if (!r.ok) add(id, 'error', `${what}: ${r.error}`);
  };
  for (const v of model.vertices) {
    if (v.type !== 'state') continue;
    const n = name(v);
    report(v.id, `entry of ${n}`, expr.checkActions(v.entry));
    report(v.id, `exit of ${n}`, expr.checkActions(v.exit));
    report(v.id, `do of ${n}`, expr.checkActions(v.doActivity));
    report(v.id, `Invariant of ${n}`, expr.checkCondition(v.invariant));
    if (v.stereotype) report(v.id, `Stereotype of ${n}`, expr.checkName(v.stereotype));
    for (const d of v.deferrable ?? []) report(v.id, `Deferrable event of ${n}`, expr.checkEvent(d));
  }
  for (const t of model.transitions) {
    const s = ix.vertices.get(t.source);
    for (const trig of t.triggers) report(t.id, 'Trigger', expr.checkTrigger(trig));
    report(t.id, 'Guard', expr.checkGuard(t.guard, s?.type === 'choice' || s?.type === 'junction'));
    report(t.id, 'Effect', expr.checkActions(t.effect));
    report(t.id, 'Precondition', expr.checkCondition(t.precondition));
    report(t.id, 'Postcondition', expr.checkCondition(t.postcondition));
    const times = t.triggers.filter((x) => expr.timeTriggerMs(x) !== null);
    if (times.length && s && s.type !== 'state') {
      add(t.id, 'error', 'Time triggers (after) can only be used on transitions leaving a state.');
    }
  }
}

function checkReachability(
  model: FsmModel,
  ix: ModelIndex,
  add: (id: string, severity: Severity, message: string) => void,
  name: (v: Vertex | undefined) => string,
) {
  const rootInitial = ix.initialOf(model.regions[0]?.id ?? '');
  // The machine can also be entered through its own entry points (from a referencing submachine state).
  const machineEntries = model.vertices.filter(
    (v) => v.type === 'entryPoint' && model.regions.some((r) => r.id === v.parent),
  );
  if (!rootInitial && !machineEntries.length) {
    if (model.vertices.some((v) => v.type === 'state')) {
      add('', 'warning', 'The top-level region has no initial pseudostate.');
    }
    return;
  }
  const reached = new Set<string>();
  const queue: Vertex[] = [];
  const visit = (v: Vertex | undefined) => {
    if (!v || reached.has(v.id)) return;
    reached.add(v.id);
    queue.push(v);
  };
  visit(rootInitial);
  machineEntries.forEach(visit);
  while (queue.length) {
    const v = queue.shift()!;
    // Entering a vertex enters its enclosing states and their other orthogonal regions.
    for (const a of ix.ancestors(v)) {
      visit(a);
    }
    if (v.type === 'state') {
      for (const r of v.regions ?? []) visit(ix.initialOf(r.id));
      for (const cp of ix.connectionPoints(v)) {
        if (cp.type === 'exitPoint' || (cp.type === 'connectionPointRef' && cp.pointKind === 'exit')) visit(cp);
      }
    }
    for (const t of ix.outgoing(v.id)) visit(ix.vertices.get(t.target));
  }
  for (const v of model.vertices) {
    if (v.type === 'state' && !reached.has(v.id)) {
      add(v.id, 'warning', `State ${name(v)} can never be entered.`);
    }
  }
}

const TYPE_LABEL: Record<string, string> = {
  state: 'state',
  final: 'final state',
  initial: 'initial pseudostate',
  shallowHistory: 'shallow history',
  deepHistory: 'deep history',
  choice: 'choice',
  junction: 'junction',
  fork: 'fork',
  join: 'join',
  entryPoint: 'entry point',
  exitPoint: 'exit point',
  connectionPointRef: 'connection point reference',
  terminate: 'terminate',
  comment: 'comment',
};
