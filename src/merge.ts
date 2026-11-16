/**
 * The diagram merge (three panes), without VS Code or webview APIs: splitting a file with conflict markers into its
 * two sides, and taking one side's version of an element into the result. Written again in C# and Kotlin later.
 */
import { itemsOf } from './compare';
import { UNRESOLVED, referenceOf, unresolvedAnchor } from './format';
import { FsmModel, Region, Transition, Vertex, isBorderVertex, normalizeModel } from './model';

/** Whether a text holds Git's conflict markers. */
export const hasConflictMarkers = (text: string) => /^<{7}(?: |\r?$)/m.test(text) && /^>{7}(?: |\r?$)/m.test(text);

export interface Split {
  /** The text with the current side of every conflict ("ours"). */
  current: string;
  /** The text with the incoming side of every conflict ("theirs"). */
  incoming: string;
  /** How many conflicts. */
  conflicts: number;
}

/**
 * Splits a text with conflict markers into its two sides: `<<<<<<<` current `=======` incoming `>>>>>>>`, and the
 * three-part style, whose base section (`|||||||`) is left out. Throws when the markers don't nest.
 */
export function splitConflicts(text: string): Split {
  const lines = text.split(/(?<=\n)/);
  let current = '';
  let incoming = '';
  let state: 'both' | 'current' | 'base' | 'incoming' = 'both';
  let conflicts = 0;
  let at = 0;
  for (const line of lines) {
    at++;
    const marker = /^(<{7}|\|{7}|={7}|>{7})(?: |\r?\n|\r?$)/.exec(line)?.[1];
    if (marker === '<<<<<<<') {
      if (state !== 'both') throw new Error(`Line ${at}: a conflict starts inside another one.`);
      state = 'current';
      conflicts++;
    } else if (marker === '|||||||' && state === 'current') {
      state = 'base';
    } else if (marker === '=======' && (state === 'current' || state === 'base')) {
      state = 'incoming';
    } else if (marker === '>>>>>>>') {
      if (state !== 'incoming') throw new Error(`Line ${at}: a conflict ends where none is open.`);
      state = 'both';
    } else if (state === 'both') {
      current += line;
      incoming += line;
    } else if (state === 'current') current += line;
    else if (state === 'incoming') incoming += line;
  }
  if (state !== 'both') throw new Error('The last conflict has no end marker (>>>>>>>).');
  return { current, incoming, conflicts };
}

/**
 * The result with the element of `keys` (see compare.ts: its key in either version, for a transition whose target or
 * trigger changed) as `source` has it: updated, added (with what it contains), or removed (with what it contains and
 * the transitions to and from it). Positions are taken relative to the owner. The result's own ids stay; added
 * elements get new ones.
 */
export function adopt(result: FsmModel, source: FsmModel, ...keys: string[]): FsmModel {
  const key = keys[0];
  const r = JSON.parse(JSON.stringify(result)) as FsmModel;
  const ri = itemsOf(r);
  const si = itemsOf(source);
  const SV = new Map(source.vertices.map((v) => [v.id, v]));
  const ST = new Map(source.transitions.map((t) => [t.id, t]));
  const taken = new Set<string>([...r.vertices.map((v) => v.id), ...r.transitions.map((t) => t.id), ...r.regions.map((x) => x.id), ...r.vertices.flatMap((v) => (v.regions ?? []).map((x) => x.id))]);
  const fresh = (base: string) => {
    let id = `${base}~m`;
    for (let n = 2; taken.has(id); n++) id = `${base}~m${n}`;
    taken.add(id);
    return id;
  };
  // Keys of the source's elements, by id, and the result's ids, by key.
  const keyOfS = new Map<string, string>();
  for (const it of si.values()) if (it.id) keyOfS.set(it.id, it.key);
  const idOfR = new Map<string, string>();
  for (const it of ri.values()) if (it.id) idOfR.set(it.key, it.id);

  const owners = (m: FsmModel) => {
    const V = new Map(m.vertices.map((v) => [v.id, v]));
    const regionOwner = new Map<string, Vertex | null>();
    for (const x of m.regions) regionOwner.set(x.id, null);
    for (const v of m.vertices) for (const x of v.regions ?? []) regionOwner.set(x.id, v);
    const border = (v: Vertex) => isBorderVertex(v, V);
    const owner = (v: Vertex): Vertex | null => (border(v) ? V.get(v.parent) ?? null : regionOwner.get(v.parent) ?? null);
    const inside = (v: Vertex, s: Vertex) => {
      const seen = new Set<Vertex>();
      for (let o = owner(v); o && !seen.has(o); o = owner(o)) {
        seen.add(o);
        if (o === s) return true;
      }
      return false;
    };
    return { V, regionOwner, border, owner, inside };
  };
  const so = owners(source);

  /** The result's parent for a source vertex: the same region of the same owner, else the top-level region. */
  const parentIn = (v: Vertex): string => {
    const ro = owners(r);
    if (so.border(v)) return idOfR.get(keyOfS.get(v.parent)!) ?? '';
    const owner = so.owner(v);
    if (!owner) {
      const index = source.regions.findIndex((x) => x.id === v.parent);
      return (r.regions[index] ?? r.regions[0]).id;
    }
    const o = ro.V.get(idOfR.get(keyOfS.get(owner.id)!) ?? '');
    if (!o || !(o.regions ?? []).length) return r.regions[0].id;
    const index = (owner.regions ?? []).findIndex((x) => x.id === v.parent);
    const named = (o.regions ?? []).find((x) => x.name && x.name === (owner.regions ?? [])[index]?.name);
    return (named ?? (o.regions ?? [])[index] ?? o.regions![0]).id;
  };
  const originIn = (m: FsmModel, v: Vertex | null) => (v ? { x: v.x, y: v.y } : { x: 0, y: 0 });

  /** Copies a source vertex's properties onto a result vertex (or a new one). */
  const place = (target: Vertex, v: Vertex) => {
    const ro = owners(r);
    const sOwner = so.owner(v);
    const rOwner = ro.V.get(target.parent) ?? ro.regionOwner.get(target.parent) ?? null;
    const a = originIn(source, sOwner);
    const b = originIn(r, rOwner && rOwner !== target ? rOwner : null);
    target.x = Math.round((b.x + v.x - a.x) * 10) / 10;
    target.y = Math.round((b.y + v.y - a.y) * 10) / 10;
  };
  const copyVertex = (target: Vertex, v: Vertex) => {
    for (const k of ['type', 'name', 'w', 'h', 'regionLayout', 'entry', 'exit', 'doActivity', 'deferrable', 'invariant', 'submachine', 'stereotype', 'ref', 'pointKind', 'text', 'color', 'itemColors', 'group'] as const) {
      if (v[k] === undefined) delete (target as unknown as Record<string, unknown>)[k];
      else (target as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(v[k]));
    }
    // Regions: the same count and names, keeping the result's ids where they line up.
    const regs: Region[] = (v.regions ?? []).map((x, i) => ({ ...x, id: target.regions?.[i]?.id ?? fresh(x.id) }));
    target.regions = regs;
    // An anchor to what the result doesn't have (yet) is kept as the reference the file writes, which names it once
    // it is taken too.
    if (v.anchors) target.anchors = v.anchors.map((a) => idOfR.get(keyOfS.get(a) ?? '') ?? (keyOfS.has(a) ? unresolvedAnchor(source, a) : undefined) ?? a);
    else delete target.anchors;
  };
  const removeVertex = (id: string) => {
    const ro = owners(r);
    const v = ro.V.get(id);
    if (!v) return;
    const gone = new Set([v, ...r.vertices.filter((x) => ro.inside(x, v))].map((x) => x.id));
    r.vertices = r.vertices.filter((x) => !gone.has(x.id));
    r.transitions = r.transitions.filter((t) => !gone.has(t.source) && !gone.has(t.target));
    for (const x of r.vertices) if (x.anchors) x.anchors = x.anchors.filter((a) => !gone.has(a));
  };
  const addVertex = (v: Vertex) => {
    const n: Vertex = { id: fresh(v.id), type: v.type, name: v.name, parent: parentIn(v), x: 0, y: 0, w: v.w, h: v.h, regions: [] };
    copyVertex(n, v);
    r.vertices.push(n);
    idOfR.set(keyOfS.get(v.id)!, n.id);
    place(n, v);
    // What it contains comes along.
    for (const x of source.vertices) {
      if (x === v || !so.inside(x, v)) continue;
      const k = keyOfS.get(x.id)!;
      if (!idOfR.has(k)) addVertex(x);
    }
  };
  /** The target in the result; one the result doesn't have (yet) is the reference the file writes, naming nothing. */
  const targetIn = (t: Transition) => {
    const k = keyOfS.get(t.target);
    const ref = SV.has(t.target) ? referenceOf(source, t.target) : undefined;
    return (k && idOfR.get(k)) ?? (ref !== undefined ? UNRESOLVED + ref : t.target);
  };
  const copyTransition = (target: Transition, t: Transition) => {
    target.kind = t.kind;
    target.triggers = [...t.triggers];
    target.guard = t.guard;
    target.action = t.action;
    for (const k of ['precondition', 'postcondition', 'color', 'itemColors', 'labelOffset'] as const) {
      if (t[k] === undefined) delete (target as unknown as Record<string, unknown>)[k];
      else (target as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(t[k]));
    }
    target.target = t.kind === 'internal' ? target.source : targetIn(t);
    // Bend points, moved with the difference between the two sources' places.
    const s1 = SV.get(t.source);
    const s2 = r.vertices.find((x) => x.id === target.source);
    if (t.points && s1 && s2) target.points = t.points.map((p) => ({ x: Math.round((p.x - s1.x + s2.x) * 10) / 10, y: Math.round((p.y - s1.y + s2.y) * 10) / 10 }));
    else delete target.points;
  };

  if (key === 'machine') {
    r.name = source.name;
    r.kind = source.kind;
    r.documentation = source.documentation;
    return normalizeModel(r);
  }
  const s = keys.map((k) => si.get(k)).find(Boolean);
  const mine = keys.map((k) => ri.get(k)).find(Boolean);
  if (s?.what === 'transition' || mine?.what === 'transition') {
    if (!s) r.transitions = r.transitions.filter((t) => t.id !== mine!.id);
    else {
      const t = ST.get(s.id)!;
      const existing = mine && r.transitions.find((x) => x.id === mine.id);
      if (existing) copyTransition(existing, t);
      else {
        const source2 = idOfR.get(keyOfS.get(t.source) ?? '');
        if (source2) {
          const n: Transition = { id: fresh(t.id), source: source2, target: '', kind: t.kind, triggers: [], guard: '', action: '' };
          copyTransition(n, t);
          r.transitions.push(n);
        }
      }
    }
    return normalizeModel(r);
  }
  if (!s) {
    if (mine) removeVertex(mine.id);
    return normalizeModel(r);
  }
  const v = SV.get(s.id)!;
  const existing = mine && r.vertices.find((x) => x.id === mine.id);
  if (existing) {
    const parent = parentIn(v);
    if (parent) existing.parent = parent;
    const [x0, y0] = [existing.x, existing.y];
    copyVertex(existing, v);
    place(existing, v);
    // What it contains moves with it, bend points between them included.
    const dx = existing.x - x0;
    const dy = existing.y - y0;
    if (dx || dy) {
      const ro = owners(r);
      const inner = new Set(r.vertices.filter((x) => ro.inside(x, existing)).map((x) => x.id));
      for (const x of r.vertices) if (inner.has(x.id)) [x.x, x.y] = [x.x + dx, x.y + dy];
      inner.add(existing.id);
      for (const t of r.transitions) if (t.points && inner.has(t.source) && inner.has(t.target)) t.points = t.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  } else addVertex(v);
  return normalizeModel(r);
}
