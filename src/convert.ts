/**
 * Converting files of earlier versions (XMI, xmi.ts) to the JSON format (format.ts). Machines linked by submachine
 * references are converted together: a connection point reference names its point by xmi:id in the other file, and
 * becomes that point's name, which the conversion of the other file may give or change.
 *
 * Names: unnamed elements get generated names (`choice1*`, hidden on the diagram), `*` and `.` in names become `_`,
 * a name used twice gets a number (`Idle2`). What the JSON format can't hold is left out and reported.
 */
import { FsmModel, Vertex, VertexType, isColor } from './model';
import { DEFAULT_SIZE, RESIZABLE, assignNames, writeMachine } from './format';
import { decodeHref, dirname, joinPath } from './util';
import { XmiModel, fromXmi } from './xmi';

/** An old file to convert: its path (`/`-separated, absolute) and text. */
export interface ConvertInput {
  path: string;
  text: string;
}

export interface Converted {
  path: string;
  /** The converted model (its ids are the old file's). */
  model: FsmModel;
  /** The texts of the two new files. */
  modelText: string;
  layoutText: string;
  /** Names changed, as sentences. */
  renames: string[];
  /** How many unnamed elements got a generated name. */
  generated: number;
  /** What was left out, as sentences. */
  losses: string[];
  /** Why the file could not be read (nothing else is set then). */
  error?: string;
}

const LABEL: Partial<Record<VertexType, string>> = {
  initial: 'initial pseudostate', shallowHistory: 'shallow history', deepHistory: 'deep history', choice: 'choice', junction: 'junction',
  final: 'final state', terminate: 'terminate pseudostate', entryPoint: 'entry point', exitPoint: 'exit point',
};

/** Converts old files together (a machine and the machines linked to it by submachine references). */
export function convertGroup(inputs: ConvertInput[]): Converted[] {
  const read = new Map<string, XmiModel>();
  const results: Converted[] = [];
  for (const i of inputs) {
    try {
      read.set(i.path, fromXmi(i.text));
    } catch (e) {
      results.push({ path: i.path, model: undefined as unknown as FsmModel, modelText: '', layoutText: '', renames: [], generated: 0, losses: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Names first, in every file: the points' new names are what the references become.
  const named = new Map<string, { renames: string[]; generated: number; losses: string[] }>();
  for (const [path, m] of read) {
    const losses = oldOnly(m);
    const unnamed = countUnnamed(m);
    const renames = assignNames(m, true).map((r) => `${r.what} '${r.from}' is now '${r.to}'${r.why ? ` (${r.why})` : ''}`);
    named.set(path, { renames, generated: unnamed, losses });
  }
  for (const [path, m] of read) {
    const info = named.get(path)!;
    for (const v of m.vertices) {
      if (v.type !== 'state' || !v.submachine) continue;
      const [file, id = ''] = v.submachine.split('#');
      const subPath = joinPath(dirname(path), decodeHref(file));
      const sub = read.get(subPath);
      const found = sub && (!id || sub.xmiId === id) ? sub : undefined;
      v.submachine = decodeHref(file);
      for (const r of m.vertices) {
        if (r.type !== 'connectionPointRef' || r.parent !== v.id) continue;
        const point = found?.vertices.find((p) => p.id === r.ref && (p.type === 'entryPoint' || p.type === 'exitPoint'));
        if (point) r.ref = point.name;
        else if (r.ref) info.losses.push(`the connection point reference of state '${v.name}' to point '${r.ref}' of ${file}, which was not found: it keeps that id as the point's name`);
      }
    }
  }
  for (const [path, m] of read) {
    const info = named.get(path)!;
    const w = writeMachine(m);
    results.push({ path, model: m, modelText: w.model, layoutText: w.layout, renames: info.renames, generated: info.generated, losses: [...info.losses, ...w.lost] });
  }
  return inputs.map((i) => results.find((r) => r.path === i.path)!);
}

/** Elements that need a name and have none. */
function countUnnamed(m: FsmModel): number {
  const named = new Set<VertexType>(['state', 'choice', 'junction', 'fork', 'join', 'final', 'terminate', 'comment', 'entryPoint', 'exitPoint']);
  let n = m.vertices.filter((v) => named.has(v.type) && !v.name).length;
  for (const regions of [m.regions, ...m.vertices.map((v) => v.regions ?? [])]) if (regions.length > 1) n += regions.filter((r) => !r.name).length;
  return n;
}

/** What an old file holds that the JSON format has no place for, besides what the writer reports. */
function oldOnly(m: XmiModel): string[] {
  const out: string[] = [];
  const describe = (v: Vertex) => `the ${LABEL[v.type] ?? v.type}${v.name ? ` '${v.name}'` : ''}`;
  if (m.context) out.push(`the context '${m.context}' of the state machine`);
  if (m.regions.length === 1 && m.regions[0].name) out.push(`the name '${m.regions[0].name}' of the state machine's region`);
  for (const v of m.vertices) {
    if (v.type === 'state' && v.regions?.length === 1 && v.regions[0].name) out.push(`the name '${v.regions[0].name}' of the region of state '${v.name}'`);
    if ((v.type === 'initial' || v.type === 'shallowHistory' || v.type === 'deepHistory') && v.name) out.push(`the name of ${describe(v)}`);
    if ((v.type === 'initial' || v.type === 'shallowHistory' || v.type === 'deepHistory') && (isColor(v.color) || v.itemColors)) out.push(`the color of ${describe(v)}`);
    if (!RESIZABLE.has(v.type) && v.type !== 'comment') {
      const [w, h] = DEFAULT_SIZE[v.type];
      if (Math.abs(v.w - w) > 0.05 || Math.abs(v.h - h) > 0.05) {
        out.push(`the size of ${describe(v)} (${v.w} × ${v.h}): it is drawn at its default size, around the same center`);
        v.x += (v.w - w) / 2;
        v.y += (v.h - h) / 2;
        [v.w, v.h] = [w, h];
      }
    }
  }
  return out;
}
