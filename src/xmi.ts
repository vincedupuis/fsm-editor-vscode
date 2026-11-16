/**
 * Reads state machine files of earlier versions: XMI 2.5.1 holding a UML 2.5.1
 * model, plus a UML DI diagram (umldi:UMLStateMachineDiagram) with the layout.
 * Nothing writes this format any more: saving such a file writes the JSON
 * format (format.ts), converting it (convert.ts).
 *
 * Layout mapping:
 * - every vertex, region and comment has a UMLShape with dc:Bounds;
 * - every drawn transition has a UMLEdge whose waypoints are the centers of
 *   its source and target with the bend points in between, plus an optional
 *   UMLLabel whose center is the middle of those waypoints moved by the
 *   label offset;
 * - the region layout of an orthogonal state, and each region's size along it,
 *   follow from its region shapes;
 * - colors and groups are kept in one xmi:Extension at the end of the diagram,
 *   with a <style element="id" color="#rrggbb" background="#rrggbb" entry="#rrggbb" …/>
 *   per colored vertex or transition (UML DI has no color), then a
 *   <group id="g" members="id id …"/> per group of vertices.
 *
 * Files written by earlier versions may end with the model hash, in its own
 * xmi:Extension (<modelHash value="…"/>): the reader ignores it.
 */
import { FsmModel, ITEM_COLOR_KEYS, ItemColors, PointKind, Transition, Vertex, VertexType, isColor, normalizeModel } from './model';
import { XmlElement, parseXml } from './xml';

export const NS = {
  xmi: 'http://www.omg.org/spec/XMI/20131001',
  uml: 'http://www.omg.org/spec/UML/20161101',
  umldi: 'http://www.omg.org/spec/UML/20161101/UMLDI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
};
const PROFILE_NS = 'https://github.com/vincedupuis/fsm-editor/profiles/FsmStereotypes';

const PSEUDO_KINDS = new Set<VertexType>([
  'initial', 'deepHistory', 'shallowHistory', 'join', 'fork', 'junction', 'choice', 'entryPoint', 'exitPoint', 'terminate',
]);

/** The size of a vertex without one (no shape, or a width or height of 0). */
const DEFAULT_SIZE: Partial<Record<VertexType, [number, number]>> = {
  state: [140, 60], final: [26, 26], initial: [20, 20], shallowHistory: [26, 26], deepHistory: [26, 26],
  choice: [28, 28], junction: [14, 14], fork: [90, 8], join: [90, 8], entryPoint: [16, 16], exitPoint: [16, 16],
  terminate: [20, 20], connectionPointRef: [16, 16], comment: [160, 64],
};
const defaultSize = (type: VertexType): [number, number] => DEFAULT_SIZE[type] ?? [40, 40];
const EXTENDER = 'FSM Editor';

function polylineMid(pts: { x: number; y: number }[]) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= half && len > 0) return { x: a.x + ((b.x - a.x) * half) / len, y: a.y + ((b.y - a.y) * half) / len };
    half -= len;
  }
  return { ...pts[0] };
}

/** A model read from an old file: the model, with what the JSON format has no place for. */
export interface XmiModel extends FsmModel {
  /** xmi:id of the state machine, which hrefs to it name (`Payment.fsm#sm`). */
  xmiId: string;
  /** Name of the context classifier, which the JSON format doesn't hold. */
  context: string;
}

// ------------------------------------------------------------------ reading

export class XmiError extends Error {}

const CANONICAL: Record<string, string> = {
  [NS.xmi]: 'xmi',
  [NS.uml]: 'uml',
  [NS.umldi]: 'umldi',
  [NS.dc]: 'dc',
  [NS.di]: 'di',
};

const typeOf = (el: XmlElement) => el.attrs['xmi:type'] ?? (el.ns === NS.uml ? `uml:${el.local}` : '');
const idOf = (el: XmlElement) => el.attrs['xmi:id'] ?? '';
const kids = (el: XmlElement, name: string) => el.children.filter((c) => c.name === name);
const kid = (el: XmlElement, name: string) => el.children.find((c) => c.name === name);

/** A reference property, written as an attribute (`a="id1 id2"`) or as child elements (`<a xmi:idref|href>`). */
function refs(el: XmlElement, name: string): string[] {
  const out = (el.attrs[name] ?? '').split(/\s+/).filter(Boolean);
  for (const c of kids(el, name)) {
    const r = c.attrs['xmi:idref'] ?? c.attrs.href;
    if (r) out.push(r);
  }
  return out;
}

const localId = (ref: string) => (ref.includes('#') ? ref.slice(ref.indexOf('#') + 1) : ref);

/** Text of an opaque behavior or constraint (its first body). */
function bodyOf(el: XmlElement | undefined, trim = true): string {
  if (!el) return '';
  const spec = kid(el, 'specification') ?? el;
  const b = kid(spec, 'body');
  const text = b ? b.text : spec.attrs.body ?? spec.attrs.value ?? '';
  return trim ? text.trim() : text;
}

function* walk(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const c of el.children) yield* walk(c);
}

/** Parses a state machine file. Throws XmlError or XmiError when it cannot be read. */
export function fromXmi(text: string): XmiModel {
  const root = parseXml(text, CANONICAL);
  if (root.name !== 'xmi:XMI' && root.name !== 'uml:Model') {
    throw new XmiError(`Not an XMI document: the root element is <${root.name}>, expected <xmi:XMI>.`);
  }
  let machineEl: XmlElement | undefined;
  let contextEl: XmlElement | undefined;
  const elementsById = new Map<string, XmlElement>();
  const visit = (el: XmlElement, parent?: XmlElement) => {
    const id = idOf(el);
    if (id) elementsById.set(id, el);
    const t = typeOf(el);
    if (!machineEl && (t === 'uml:StateMachine' || t === 'uml:ProtocolStateMachine')) {
      machineEl = el;
      if (parent && typeOf(parent) === 'uml:Class') contextEl = parent;
    }
    for (const c of el.children) visit(c, el);
  };
  visit(root);
  if (!machineEl) throw new XmiError('The document does not contain a UML state machine.');
  const sm = machineEl;

  const eventText = (trig: XmlElement): string => {
    const ev = elementsById.get(localId(trig.attrs.event ?? refs(trig, 'event')[0] ?? ''));
    if (ev && typeOf(ev) === 'uml:TimeEvent') {
      const expr = kid(kid(ev, 'when') ?? ev, 'expr');
      const value = expr ? expr.attrs.value ?? bodyOf(expr) : '';
      if (value) return `after(${value})`;
    }
    if (ev && typeOf(ev) === 'uml:SignalEvent') {
      const sig = elementsById.get(localId(ev.attrs.signal ?? ''));
      return sig?.attrs.name || ev.attrs.name || trig.attrs.name || '';
    }
    return ev?.attrs.name || trig.attrs.name || '';
  };

  const model: XmiModel = {
    version: 1,
    xmiId: idOf(sm) || 'sm',
    name: sm.attrs.name ?? '',
    kind: typeOf(sm) === 'uml:ProtocolStateMachine' ? 'protocol' : 'behavioral',
    context: contextEl?.attrs.name ?? '',
    documentation: '',
    regions: [],
    vertices: [],
    transitions: [],
  };
  for (const c of kids(sm, 'ownedComment')) {
    if (refs(c, 'annotatedElement').includes(model.xmiId)) model.documentation = bodyOf(c);
  }

  const vertexBase = (el: XmlElement, type: VertexType, parent: string): Vertex => ({
    id: idOf(el),
    type,
    name: el.attrs.name ?? '',
    parent,
    x: NaN,
    y: NaN,
    w: 0,
    h: 0,
    regions: [],
  });

  const readTransition = (el: XmlElement) => {
    const t: Transition = {
      id: idOf(el),
      source: localId(el.attrs.source ?? refs(el, 'source')[0] ?? ''),
      target: localId(el.attrs.target ?? refs(el, 'target')[0] ?? ''),
      kind: (['external', 'internal', 'local'].includes(el.attrs.kind) ? el.attrs.kind : 'external') as Transition['kind'],
      triggers: kids(el, 'trigger').map(eventText).filter(Boolean),
      guard: bodyOf(kid(el, 'guard')),
      action: bodyOf(kid(el, 'effect')),
    };
    const pre = bodyOf(kid(el, 'preCondition'));
    const post = bodyOf(kid(el, 'postCondition'));
    if (pre) t.precondition = pre;
    if (post) t.postcondition = post;
    model.transitions.push(t);
  };

  const readPoint = (el: XmlElement, parent: string) => {
    const kind = el.attrs.kind === 'exitPoint' ? 'exitPoint' : 'entryPoint';
    model.vertices.push(vertexBase(el, kind, parent));
  };

  const readVertex = (el: XmlElement, parent: string) => {
    const t = typeOf(el);
    if (t === 'uml:FinalState') {
      model.vertices.push(vertexBase(el, 'final', parent));
      return;
    }
    if (t === 'uml:Pseudostate') {
      const kind = (el.attrs.kind ?? 'initial') as VertexType;
      model.vertices.push(vertexBase(el, PSEUDO_KINDS.has(kind) ? kind : 'initial', parent));
      return;
    }
    const v = vertexBase(el, 'state', parent);
    const entry = bodyOf(kid(el, 'entry'));
    const exit = bodyOf(kid(el, 'exit'));
    const doActivity = bodyOf(kid(el, 'doActivity'));
    const invariant = bodyOf(kid(el, 'stateInvariant'));
    const deferrable = kids(el, 'deferrableTrigger').map(eventText).filter(Boolean);
    if (entry) v.entry = entry;
    if (exit) v.exit = exit;
    if (doActivity) v.doActivity = doActivity;
    if (invariant) v.invariant = invariant;
    if (deferrable.length) v.deferrable = deferrable;
    const sub = refs(el, 'submachine')[0];
    if (sub) v.submachine = sub;
    model.vertices.push(v);
    for (const cp of kids(el, 'connectionPoint')) readPoint(cp, v.id);
    for (const c of kids(el, 'connection')) {
      const entryRef = refs(c, 'entry')[0];
      const exitRef = refs(c, 'exit')[0];
      const ref: Vertex = { ...vertexBase(c, 'connectionPointRef', v.id), name: '' };
      ref.pointKind = (exitRef && !entryRef ? 'exit' : 'entry') as PointKind;
      ref.ref = localId(entryRef ?? exitRef ?? '');
      model.vertices.push(ref);
    }
    for (const r of kids(el, 'region')) {
      v.regions!.push({ id: idOf(r), name: r.attrs.name ?? '' });
      readRegion(r);
    }
  };

  function readRegion(el: XmlElement) {
    const id = idOf(el);
    for (const c of el.children) {
      if (c.name === 'subvertex') readVertex(c, id);
      else if (c.name === 'transition') readTransition(c);
      else if (c.name === 'ownedComment') {
        model.vertices.push({ ...vertexBase(c, 'comment', id), text: bodyOf(c, false), anchors: refs(c, 'annotatedElement') });
      }
    }
  }

  for (const r of kids(sm, 'region')) {
    model.regions.push({ id: idOf(r), name: r.attrs.name ?? '' });
    readRegion(r);
  }
  if (!model.regions.length) model.regions.push({ id: `${model.xmiId}_region`, name: '' });
  for (const cp of kids(sm, 'connectionPoint')) readPoint(cp, model.regions[0].id);

  // Stereotype applications: elements of the embedded profile's namespace.
  const V = new Map(model.vertices.map((v) => [v.id, v]));
  for (const c of root.children) {
    if (c.ns !== PROFILE_NS) continue;
    const v = V.get(localId(c.attrs.base_State ?? ''));
    if (v) v.stereotype = c.local;
  }

  // Layout
  const T = new Map(model.transitions.map((t) => [t.id, t]));
  const regionShapes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const d of root.children) {
    if (d.ns !== NS.umldi) continue;
    for (const ext of kids(d, 'xmi:Extension')) {
      if (ext.attrs.extender !== EXTENDER) continue;
      for (const st of kids(ext, 'style')) {
        const e = V.get(st.attrs.element ?? '') ?? T.get(st.attrs.element ?? '');
        if (!e) continue;
        const color = (st.attrs.color ?? '').toLowerCase();
        if (isColor(color)) e.color = color;
        const items: ItemColors = {};
        for (const k of ITEM_COLOR_KEYS) {
          const c = (st.attrs[k === 'action' ? 'effect' : k] ?? '').toLowerCase();
          if (isColor(c)) items[k] = c;
        }
        if (Object.keys(items).length) e.itemColors = items;
      }
      // A vertex listed in several groups stays in the first.
      for (const g of kids(ext, 'group')) {
        const id = g.attrs.id ?? '';
        if (!id) continue;
        for (const member of (g.attrs.members ?? '').split(/\s+/)) {
          const v = V.get(member);
          if (v && !v.group) v.group = id;
        }
      }
    }
    for (const el of walk(d)) {
      const type = typeOf(el);
      const target = el.attrs.modelElement ?? refs(el, 'modelElement')[0];
      if (!target) continue;
      const b = kid(el, 'bounds');
      if (type === 'umldi:UMLShape' && b) {
        const box = { x: +b.attrs.x || 0, y: +b.attrs.y || 0, w: +b.attrs.width || 0, h: +b.attrs.height || 0 };
        const v = V.get(target);
        if (v) Object.assign(v, box);
        else regionShapes.set(target, box);
      } else if (type === 'umldi:UMLEdge' && T.has(target)) {
        const t = T.get(target)!;
        const pts = kids(el, 'waypoint').map((w) => ({ x: +w.attrs.x || 0, y: +w.attrs.y || 0 }));
        if (pts.length > 2) t.points = pts.slice(1, -1);
        const label = el.children.find((c) => typeOf(c) === 'umldi:UMLLabel');
        const lb = label && kid(label, 'bounds');
        if (lb && pts.length >= 2) {
          const mid = polylineMid(pts);
          // Not rounded: the middle is off the 0.1 px grid, and an offset rounded to 0.1 px could move the
          // label by 0.1 px on each save. Written again from the same waypoints, it gives the same label box.
          t.labelOffset = {
            x: +lb.attrs.x + +lb.attrs.width / 2 - mid.x,
            y: +lb.attrs.y + +lb.attrs.height / 2 - mid.y,
          };
        }
      }
    }
  }
  for (const v of model.vertices) {
    const regs = v.regions ?? [];
    if (regs.length >= 2) {
      const a = regionShapes.get(regs[0].id);
      const b = regionShapes.get(regs[1].id);
      if (a && b) v.regionLayout = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? 'horizontal' : 'vertical';
    }
    // Each region's own size, along the layout.
    for (const r of regs) {
      const box = regionShapes.get(r.id);
      if (box) r.size = v.regionLayout === 'horizontal' ? box.w : box.h;
    }
  }

  // Elements without a shape get a default place and size.
  let slot = 0;
  for (const v of model.vertices) {
    if (!v.w || !v.h) [v.w, v.h] = defaultSize(v.type);
    if (Number.isNaN(v.x) || Number.isNaN(v.y)) {
      v.x = 40 + (slot % 5) * 180;
      v.y = 40 + Math.floor(slot / 5) * 120;
      slot++;
    }
  }
  normalizeModel(model);
  return model;
}
