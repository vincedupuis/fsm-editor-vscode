/**
 * Comparing two versions of a machine, for the diagram diff (two panes) and merge (three panes). No VS Code or
 * webview API: it is written again in C# and Kotlin later.
 *
 * Elements are matched by what identifies them in the file: an element by its name, a region of `regions` by its
 * state and name, a point by its state and name, an initial or history pseudostate by its region, a transition by its
 * source, trigger and target (then by order among identical ones; a transition left over is then paired with one of
 * the same source and trigger, else of the same source, in order, its target or trigger having changed). A renamed
 * element is one removed and one added.
 *
 * Each match lists the properties that differ, model and layout apart: positions are compared relative to the owner
 * (moving a state doesn't change what it contains), bend points relative to the innermost state containing both ends.
 */
import { FsmModel, ITEM_COLOR_KEYS, Region, Transition, Vertex, VertexType, isBorderVertex } from './model';

export type ChangeKind = 'added' | 'removed' | 'changed';

/** A property that differs, with its two values as text ('' when absent). */
export interface PropertyChange {
  name: string;
  old: string;
  new: string;
  /** A property of the drawing, not of the model. */
  layout: boolean;
}

export interface Change {
  /** What identifies the element in the newer version (see `itemsOf`). */
  key: string;
  /** Its key in the older version, when it differs (a transition whose target or trigger changed). */
  oldKey?: string;
  kind: ChangeKind;
  /** `machine`, `state`, `choice`…, `region`, `transition`. */
  what: string;
  /** How a person names it: `state 'Off'`, `transition Off -> On (powerOn)`. */
  label: string;
  /** The element's id in each version. */
  oldId?: string;
  newId?: string;
  /** For `changed`: what differs. */
  properties: PropertyChange[];
}

/** What can be compared in a model: its elements by key, with their properties. */
interface Item {
  key: string;
  id: string;
  what: string;
  label: string;
  model: Record<string, string>;
  layout: Record<string, string>;
}

const n1 = (n: number) => Math.round(n * 10) / 10;
const num = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? String(n1(n)) : '');
const WHAT: Partial<Record<VertexType, string>> = {
  shallowHistory: 'history', deepHistory: 'deep history', entryPoint: 'entry point', exitPoint: 'exit point',
  connectionPointRef: 'point', final: 'final state', terminate: 'terminate',
};
const shown = (name: string) => (name.endsWith('*') ? '' : name);

/** The items of a model, keyed so that the same element has the same key in another version. */
export function itemsOf(model: FsmModel): Map<string, Item> {
  const V = new Map<string, Vertex>();
  for (const v of model.vertices) if (!V.has(v.id)) V.set(v.id, v);
  const regionOwner = new Map<string, Vertex | null>();
  const regions = new Map<string, Region>();
  for (const r of model.regions) {
    regionOwner.set(r.id, null);
    regions.set(r.id, r);
  }
  for (const v of model.vertices) for (const r of v.regions ?? []) {
    regionOwner.set(r.id, v);
    regions.set(r.id, r);
  }
  const top = new Set(model.regions.map((r) => r.id));
  const isBorder = (v: Vertex) => isBorderVertex(v, V);
  const isMachinePoint = (v: Vertex) => (v.type === 'entryPoint' || v.type === 'exitPoint') && top.has(v.parent);
  const owner = (v: Vertex): Vertex | null => (isBorder(v) ? V.get(v.parent) ?? null : regionOwner.get(v.parent) ?? null);
  /** A region's key: its owner and name, or index for a state's only region. */
  const regionKey = (rid: string): string => {
    const o = regionOwner.get(rid);
    const list = o ? o.regions ?? [] : model.regions;
    const r = regions.get(rid);
    const at = list.length > 1 ? `:${r?.name ?? ''}` : '';
    return o ? `${o.name}${at}` : `${at}`;
  };
  const vertexKey = (v: Vertex): string => {
    if (v.type === 'initial' || v.type === 'shallowHistory' || v.type === 'deepHistory') return `${v.type}@${regionKey(v.parent)}`;
    if (isBorder(v)) return `point@${V.get(v.parent)?.name ?? ''}.${v.type === 'connectionPointRef' ? v.ref ?? '' : v.name}`;
    if (isMachinePoint(v)) return `point@.${v.name}`;
    return `element@${v.name}`;
  };
  const keys = new Map<string, string>();
  for (const v of model.vertices) keys.set(v.id, vertexKey(v));
  const refOf = (id: string) => {
    const v = V.get(id);
    if (!v) return id.replace(/^/, '');
    const k = keys.get(id)!;
    return k.replace(/^element@/, '').replace(/^point@\./, `${model.name}.`).replace(/^point@/, '');
  };
  const nameOf = (v: Vertex) => shown(v.type === 'connectionPointRef' ? v.ref ?? '' : v.name);
  /** Where a vertex is: its state, and the region of a state (or machine) with several. */
  const placeOf = (v: Vertex): string => {
    const o = owner(v);
    if (isBorder(v)) return o ? `'${shown(o.name)}'` : '';
    const list = o ? o.regions ?? [] : model.regions;
    const i = list.findIndex((r) => r.id === v.parent);
    const region = list.length > 1 ? `region '${shown(list[i]?.name ?? '') || i + 1}'` : '';
    return o ? `'${shown(o.name)}'${region ? `, ${region}` : ''}` : region;
  };
  const T = new Map(model.transitions.map((t) => [t.id, t]));
  /** A comment's anchor: a reference, or a transition as `source -> target (trigger)`. */
  const anchorOf = (a: string): string => {
    if (V.has(a)) return refOf(a);
    const t = T.get(a);
    if (!t) return a.replace(/^[\ue001\ue002]/, '');
    const trigger = t.triggers.join(', ');
    return `${refOf(t.source)} -> ${t.kind === 'internal' ? '(internal)' : refOf(t.target)}${trigger ? ` (${trigger})` : ''}`;
  };
  const labelOf = (v: Vertex) => {
    const what = WHAT[v.type] ?? v.type;
    const n = nameOf(v);
    const o = owner(v);
    return n ? `${what} '${n}'` : o && shown(o.name) ? `${what} in '${shown(o.name)}'` : what;
  };
  const frame = (t: Transition): Vertex | null => {
    const chain = (id: string) => {
      const out: Vertex[] = [];
      let v = V.get(id);
      if (v && v.type !== 'state') v = owner(v) ?? undefined;
      const seen = new Set<Vertex>();
      while (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
        v = owner(v) ?? undefined;
      }
      return out;
    };
    const g = new Set(chain(t.target));
    return chain(t.source).find((v) => g.has(v)) ?? null;
  };
  const colors = (e: { color?: string; itemColors?: Record<string, string | undefined> }, into: Record<string, string>) => {
    into.color = e.color ?? '';
    for (const k of ITEM_COLOR_KEYS) if (e.itemColors?.[k]) into[`color of ${k}`] = e.itemColors[k]!;
  };

  const items = new Map<string, Item>();
  items.set('machine', {
    key: 'machine', id: '', what: 'machine', label: 'the state machine',
    model: { name: model.name, type: model.kind, documentation: model.documentation ?? '' }, layout: {},
  });
  for (const v of model.vertices) {
    const key = keys.get(v.id)!;
    if (items.has(key)) continue; // a name used twice: the first
    const o = owner(v);
    const m: Record<string, string> = { type: v.type, in: placeOf(v) };
    if (v.type === 'state') {
      Object.assign(m, {
        entry: v.entry ?? '', exit: v.exit ?? '', do: v.doActivity ?? '', defer: (v.deferrable ?? []).join(', '), invariant: v.invariant ?? '',
        stereotype: v.stereotype ?? '', submachine: v.submachine ?? '',
        regions: (v.regions ?? []).length > 1 ? (v.regions ?? []).map((r) => shown(r.name) || '(unnamed)').join(', ') : String((v.regions ?? []).length),
      });
    }
    if (v.type === 'comment') Object.assign(m, { text: v.text ?? '', anchors: (v.anchors ?? []).map(anchorOf).join(', ') });
    if (v.type === 'connectionPointRef') m.direction = v.pointKind ?? 'entry';
    // Where it is, relative to its owner.
    const ox = o ? o.x : 0;
    const oy = o ? o.y : 0;
    const l: Record<string, string> = { x: num(v.x - ox), y: num(v.y - oy), width: num(v.w), height: num(v.h), group: v.group ? 'grouped' : '' };
    if ((v.regions ?? []).length > 1) {
      l['region layout'] = v.regionLayout ?? 'vertical';
      (v.regions ?? []).forEach((r, i) => (l[`size of region ${shown(r.name) || i + 1}`] = num(r.size)));
    }
    colors(v as never, l);
    items.set(key, { key, id: v.id, what: v.type === 'connectionPointRef' ? 'point' : WHAT[v.type] ?? v.type, label: labelOf(v), model: m, layout: l });
  }
  // Transitions: by source, trigger and target, then order.
  const seen = new Map<string, number>();
  for (const t of model.transitions) {
    const s = V.get(t.source);
    const source = s ? keys.get(s.id)! : `?${t.source}`;
    const trigger = t.triggers.join(', ');
    const target = t.kind === 'internal' ? '' : refOf(t.target);
    const base = `transition@${source}|${trigger}|${target}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}|${n}`;
    const sv = s ? (shown(s.name) || labelOf(s)) : t.source;
    const label = `transition ${sv} -> ${t.kind === 'internal' ? '(internal)' : target.replace(/\*$/, '')}${trigger ? ` (${trigger})` : ''}`;
    const f = frame(t);
    const fx = f ? f.x : 0;
    const fy = f ? f.y : 0;
    const l: Record<string, string> = {
      'bend points': (t.points ?? []).map((p) => `${num(p.x - fx)},${num(p.y - fy)}`).join(' '),
      label: t.labelOffset ? `${num(t.labelOffset.x)},${num(t.labelOffset.y)}` : '',
    };
    colors(t as never, l);
    items.set(key, {
      key, id: t.id, what: 'transition', label,
      model: { kind: t.kind, trigger, guard: t.guard, action: t.action, precondition: t.precondition ?? '', postcondition: t.postcondition ?? '', target, source },
      layout: l,
    });
  }
  return items;
}

/** The properties of two items that differ. */
function differences(a: Item, b: Item): PropertyChange[] {
  const out: PropertyChange[] = [];
  for (const [layout, x, y] of [[false, a.model, b.model], [true, a.layout, b.layout]] as const) {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === 'source') continue;
      if ((x[k] ?? '') !== (y[k] ?? '')) out.push({ name: k, old: x[k] ?? '', new: y[k] ?? '', layout });
    }
  }
  return out;
}

/**
 * What changed from `older` to `newer`, in the order of the newer version (removed elements after the element before
 * them in the older one is not tracked: removed ones come last).
 */
export function compareModels(older: FsmModel, newer: FsmModel): Change[] {
  const a = itemsOf(older);
  const b = itemsOf(newer);
  const pairs = new Map<string, string>(); // new key -> old key
  for (const k of b.keys()) if (a.has(k)) pairs.set(k, k);
  // Transitions left over: the same source and trigger, else the same source, in order.
  const leftA = [...a.values()].filter((i) => i.what === 'transition' && !pairs.has(i.key));
  const leftB = [...b.values()].filter((i) => i.what === 'transition' && !pairs.has(i.key));
  const used = new Set<string>();
  for (const level of [2, 1]) {
    for (const t of leftB) {
      if (pairs.has(t.key)) continue;
      const [src, trig] = t.key.split('|');
      const o = leftA.find((x) => !used.has(x.key) && x.key.split('|')[0] === src && (level === 1 || x.key.split('|')[1] === trig));
      if (o) {
        pairs.set(t.key, o.key);
        used.add(o.key);
      }
    }
  }
  const matchedOld = new Set(pairs.values());
  const changes: Change[] = [];
  for (const [key, item] of b) {
    const old = pairs.get(key);
    if (old === undefined) {
      changes.push({ key, kind: 'added', what: item.what, label: item.label, newId: item.id, properties: [] });
      continue;
    }
    const props = differences(a.get(old)!, item);
    if (props.length) changes.push({ key, ...(old !== key ? { oldKey: old } : {}), kind: 'changed', what: item.what, label: item.label, oldId: a.get(old)!.id, newId: item.id, properties: props });
  }
  for (const [key, item] of a) {
    if (!matchedOld.has(key)) changes.push({ key, kind: 'removed', what: item.what, label: item.label, oldId: item.id, properties: [] });
  }
  return changes;
}

/** Whether a change shows when layout changes are hidden. */
export const isModelChange = (c: Change) => c.kind !== 'changed' || c.properties.some((p) => !p.layout);

/** A change's properties as lines: `guard: a() → b()`. */
export function describeChange(c: Change, layout: boolean): string[] {
  const value = (s: string) => (s === '' ? '(none)' : s.length > 60 ? `${s.slice(0, 57)}…` : s);
  return c.properties.filter((p) => layout || !p.layout).map((p) => `${p.name}: ${value(p.old)} → ${value(p.new)}`);
}
