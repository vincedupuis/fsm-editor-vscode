/**
 * Reads and writes state machine files: XMI 2.5.1 holding a UML 2.5.1 model,
 * plus a UML DI diagram (umldi:UMLStateMachineDiagram) with the layout.
 *
 * Layout mapping:
 * - every vertex, region and comment has a UMLShape with dc:Bounds;
 * - every drawn transition has a UMLEdge whose waypoints are the centers of
 *   its source and target with the bend points in between, plus an optional
 *   UMLLabel whose center is the middle of those waypoints moved by the
 *   label offset;
 * - the region layout of an orthogonal state follows from its region shapes.
 */
import { FsmModel, PointKind, Region, Transition, Vertex, VertexType, normalizeModel } from './model';
import { Node, XmlElement, parseXml, writeXml } from './xml';

export const NS = {
  xmi: 'http://www.omg.org/spec/XMI/20131001',
  uml: 'http://www.omg.org/spec/UML/20161101',
  umldi: 'http://www.omg.org/spec/UML/20161101/UMLDI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
};
const PROFILE_NAME = 'FsmStereotypes';
const PROFILE_NS = 'https://github.com/vincedupuis/fsm-editor/profiles/FsmStereotypes';
const UML_STATE = `${NS.uml}/UML.xmi#State`;
/** Language of the opaque behaviors and expressions (argument-less calls, see media/expressions.js). */
const LANGUAGE = 'FSM';

const PSEUDO_KINDS = new Set<VertexType>([
  'initial', 'deepHistory', 'shallowHistory', 'join', 'fork', 'junction', 'choice', 'entryPoint', 'exitPoint', 'terminate',
]);

const n1 = (n: number) => Math.round(n * 10) / 10;
const LABEL_W = 100;
const LABEL_H = 16;

// ------------------------------------------------------------------ geometry shared by writer and reader

const center = (v: { x: number; y: number; w: number; h: number }) => ({ x: v.x + v.w / 2, y: v.y + v.h / 2 });

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

/** Same header height as the diagram editor (name, stereotype, internal activities). */
function headerHeight(v: Vertex, model: FsmModel) {
  let h = 24 + (v.stereotype ? 12 : 0);
  const internal = model.transitions.filter((t) => t.kind === 'internal' && t.source === v.id && t.target === v.id).length;
  const n = (v.entry ? 1 : 0) + (v.exit ? 1 : 0) + (v.doActivity ? 1 : 0) + (v.deferrable?.length ?? 0) + internal;
  if (n) h += n * 14 + 6;
  return h;
}

function regionBounds(v: Vertex, model: FsmModel) {
  const regs = v.regions ?? [];
  const top = v.y + Math.min(headerHeight(v, model), v.h - 20);
  const bh = v.y + v.h - top;
  const horizontal = v.regionLayout === 'horizontal';
  return regs.map((r, i) =>
    horizontal
      ? { id: r.id, x: v.x + (i * v.w) / regs.length, y: top, w: v.w / regs.length, h: bh }
      : { id: r.id, x: v.x, y: top + (i * bh) / regs.length, w: v.w, h: bh / regs.length },
  );
}

// ------------------------------------------------------------------ writing

export function toXmi(model: FsmModel): string {
  const m = normalizeModel(JSON.parse(JSON.stringify(model)) as FsmModel);
  const V = new Map(m.vertices.map((v) => [v.id, v]));
  const regionOwner = new Map<string, Vertex | null>();
  for (const r of m.regions) regionOwner.set(r.id, null);
  for (const v of m.vertices) for (const r of v.regions ?? []) regionOwner.set(r.id, v);
  const topRegions = new Set(m.regions.map((r) => r.id));
  const protocol = m.kind === 'protocol';
  const smId = m.id!;

  const isOnBorder = (v: Vertex) =>
    v.type === 'connectionPointRef' || ((v.type === 'entryPoint' || v.type === 'exitPoint') && V.has(v.parent));
  const isMachinePoint = (v: Vertex) => (v.type === 'entryPoint' || v.type === 'exitPoint') && topRegions.has(v.parent);

  // Events: one signal event (and signal) per event name, one time event per time trigger.
  const events = new Map<string, string>();
  const eventElements: Node[] = [];
  const eventFor = (trigger: string) => {
    let id = events.get(trigger);
    if (id) return id;
    const time = /^after\((.+)\)$/.exec(trigger);
    const safe = trigger.replace(/[^A-Za-z0-9_]/g, '_');
    if (time) {
      id = `ev_${safe}`;
      eventElements.push([
        'packagedElement',
        { 'xmi:type': 'uml:TimeEvent', 'xmi:id': id, name: trigger, isRelative: 'true' },
        ['when', { 'xmi:type': 'uml:TimeExpression', 'xmi:id': `${id}_when` },
          ['expr', { 'xmi:type': 'uml:LiteralString', 'xmi:id': `${id}_expr`, value: time[1] }]],
      ]);
    } else {
      id = `ev_${safe}`;
      eventElements.push(
        ['packagedElement', { 'xmi:type': 'uml:SignalEvent', 'xmi:id': id, name: trigger, signal: `sig_${safe}` }],
        ['packagedElement', { 'xmi:type': 'uml:Signal', 'xmi:id': `sig_${safe}`, name: trigger }],
      );
    }
    events.set(trigger, id);
    return id;
  };

  const behavior = (tag: string, id: string, body?: string): Node[] =>
    body ? [[tag, { 'xmi:type': 'uml:OpaqueBehavior', 'xmi:id': id }, ['language', {}, LANGUAGE], ['body', {}, body]]] : [];
  const constraint = (tag: string, id: string, body?: string): Node[] =>
    body
      ? [[tag, { 'xmi:type': 'uml:Constraint', 'xmi:id': id },
          ['specification', { 'xmi:type': 'uml:OpaqueExpression', 'xmi:id': `${id}_spec` }, ['language', {}, LANGUAGE], ['body', {}, body]]]]
      : [];
  const triggers = (tag: string, ownerId: string, list: string[] = []): Node[] =>
    list.map((t, i) => [tag, { 'xmi:type': 'uml:Trigger', 'xmi:id': `${ownerId}_${tag}${i + 1}`, name: t, event: eventFor(t) }]);

  /** Regions enclosing a vertex, innermost first. */
  const regionChain = (v: Vertex): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: Vertex | undefined = v;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (isOnBorder(cur)) {
        cur = V.get(cur.parent);
        if (cur) continue;
        break;
      }
      out.push(cur.parent);
      cur = regionOwner.get(cur.parent) ?? undefined;
    }
    return out;
  };
  /** A transition is owned by the innermost region that contains both of its ends. */
  const transitionsByRegion = new Map<string, Transition[]>();
  for (const t of m.transitions) {
    const s = V.get(t.source);
    const g = V.get(t.target);
    const sc = s ? regionChain(s) : [];
    const gc = new Set(g ? regionChain(g) : []);
    const container = sc.find((r) => gc.has(r)) ?? m.regions[0].id;
    const list = transitionsByRegion.get(container) ?? [];
    list.push(t);
    transitionsByRegion.set(container, list);
  }

  const transitionNode = (t: Transition): Node => [
    'transition',
    {
      'xmi:type': protocol ? 'uml:ProtocolTransition' : 'uml:Transition',
      'xmi:id': t.id,
      kind: t.kind,
      source: t.source,
      target: t.target,
    },
    ...triggers('trigger', t.id, t.triggers),
    ...(protocol
      ? [...constraint('preCondition', `${t.id}_pre`, t.precondition), ...constraint('postCondition', `${t.id}_post`, t.postcondition)]
      : constraint('guard', `${t.id}_guard`, t.guard)),
    ...behavior('effect', `${t.id}_effect`, t.effect),
  ];

  const commentNode = (c: Vertex): Node => [
    'ownedComment',
    { 'xmi:type': 'uml:Comment', 'xmi:id': c.id, annotatedElement: (c.anchors ?? []).join(' ') },
    ['body', {}, c.text ?? ''],
  ];

  const pointNode = (tag: string, v: Vertex): Node => [
    tag,
    { 'xmi:type': 'uml:Pseudostate', 'xmi:id': v.id, name: v.name, kind: v.type },
  ];

  const vertexNode = (v: Vertex): Node => {
    if (v.type === 'final') return ['subvertex', { 'xmi:type': 'uml:FinalState', 'xmi:id': v.id, name: v.name }];
    if (PSEUDO_KINDS.has(v.type)) return pointNode('subvertex', v);
    const children: Node[] = [
      ...behavior('entry', `${v.id}_entry`, v.entry),
      ...behavior('exit', `${v.id}_exit`, v.exit),
      ...behavior('doActivity', `${v.id}_do`, v.doActivity),
      ...constraint('stateInvariant', `${v.id}_inv`, v.invariant),
      ...triggers('deferrableTrigger', v.id, v.deferrable),
    ];
    for (const cp of m.vertices) {
      if (cp.parent !== v.id) continue;
      if (cp.type === 'entryPoint' || cp.type === 'exitPoint') children.push(pointNode('connectionPoint', cp));
      if (cp.type === 'connectionPointRef') {
        const file = (v.submachine ?? '').split('#')[0];
        children.push([
          'connection',
          { 'xmi:type': 'uml:ConnectionPointReference', 'xmi:id': cp.id },
          [cp.pointKind === 'exit' ? 'exit' : 'entry', { href: `${file}#${cp.ref ?? ''}` }],
        ]);
      }
    }
    for (const r of v.regions ?? []) children.push(regionNode(r));
    if (v.submachine) children.push(['submachine', { href: v.submachine }]);
    return ['subvertex', { 'xmi:type': 'uml:State', 'xmi:id': v.id, name: v.name }, ...children];
  };

  function regionNode(r: Region): Node {
    const kids = m.vertices.filter((v) => v.parent === r.id && !isMachinePoint(v));
    return [
      'region',
      { 'xmi:type': 'uml:Region', 'xmi:id': r.id, name: r.name },
      ...kids.filter((v) => v.type === 'comment').map(commentNode),
      ...kids.filter((v) => v.type !== 'comment').map(vertexNode),
      ...(transitionsByRegion.get(r.id) ?? []).map(transitionNode),
    ];
  }

  const machine: Node = [
    protocol ? 'packagedElement' : 'packagedElement',
    { 'xmi:type': protocol ? 'uml:ProtocolStateMachine' : 'uml:StateMachine', 'xmi:id': smId, name: m.name },
    ...(m.documentation
      ? [['ownedComment', { 'xmi:type': 'uml:Comment', 'xmi:id': `${smId}_doc`, annotatedElement: smId }, ['body', {}, m.documentation]] as Node]
      : []),
    ...m.vertices.filter(isMachinePoint).map((v) => pointNode('connectionPoint', v)),
    ...m.regions.map(regionNode),
  ];

  const packaged: Node[] = [];
  if (m.context) {
    // The context classifier owns the state machine as its classifier behavior.
    machine[0] = 'ownedBehavior';
    packaged.push(['packagedElement', { 'xmi:type': 'uml:Class', 'xmi:id': `${smId}_context`, name: m.context, classifierBehavior: smId }, machine]);
  } else {
    packaged.push(machine);
  }
  // Events are collected while building the machine, so they come after it.
  packaged.push(...eventElements);

  // Stereotypes: an embedded profile with one stereotype per name, extending UML::State.
  const stereotyped = m.vertices.filter((v) => v.type === 'state' && v.stereotype);
  const stereoNames = [...new Set(stereotyped.map((v) => v.stereotype!))];
  let profileApplication: Node[] = [];
  const applications: Node[] = [];
  if (stereoNames.length) {
    const profile: Node = [
      'packagedElement',
      { 'xmi:type': 'uml:Profile', 'xmi:id': 'fsm_profile', name: PROFILE_NAME, URI: PROFILE_NS },
      ['metaclassReference', { 'xmi:type': 'uml:ElementImport', 'xmi:id': 'fsm_profile_state' },
        ['importedElement', { 'xmi:type': 'uml:Class', href: UML_STATE }]],
    ];
    for (const s of stereoNames) {
      profile.push(
        ['packagedElement', { 'xmi:type': 'uml:Stereotype', 'xmi:id': `st_${s}`, name: s },
          ['ownedAttribute', { 'xmi:type': 'uml:Property', 'xmi:id': `st_${s}_base`, name: 'base_State', association: `ext_${s}` },
            ['type', { href: UML_STATE }]]],
        ['packagedElement', { 'xmi:type': 'uml:Extension', 'xmi:id': `ext_${s}`, name: `E_${s}_State`, memberEnd: `st_${s}_base ext_${s}_end` },
          ['ownedEnd', { 'xmi:type': 'uml:ExtensionEnd', 'xmi:id': `ext_${s}_end`, name: `extension_${s}`, type: `st_${s}`, association: `ext_${s}`, aggregation: 'composite' }]],
      );
    }
    packaged.push(profile);
    profileApplication = [['profileApplication', { 'xmi:type': 'uml:ProfileApplication', 'xmi:id': 'fsm_profile_app', appliedProfile: 'fsm_profile' }]];
    for (const v of stereotyped) {
      applications.push([`${PROFILE_NAME}:${v.stereotype}`, { 'xmi:id': `${v.id}_st`, base_State: v.id }]);
    }
  }

  // Diagram
  const bounds = (b: { x: number; y: number; w: number; h: number }): Node => [
    'bounds', { 'xmi:type': 'dc:Bounds', x: n1(b.x), y: n1(b.y), width: n1(b.w), height: n1(b.h) },
  ];
  const shapes: Node[] = [];
  for (const v of m.vertices) {
    shapes.push(['ownedElement', { 'xmi:type': 'umldi:UMLShape', 'xmi:id': `di_${v.id}`, modelElement: v.id }, bounds(v)]);
    if (v.type === 'state') {
      for (const rb of regionBounds(v, m)) {
        shapes.push(['ownedElement', { 'xmi:type': 'umldi:UMLShape', 'xmi:id': `di_${rb.id}`, modelElement: rb.id }, bounds(rb)]);
      }
    }
  }
  const edges: Node[] = [];
  for (const t of m.transitions) {
    const s = V.get(t.source);
    const g = V.get(t.target);
    if (!s || !g) continue;
    if (t.kind === 'internal' && s === g && s.type === 'state') continue; // drawn in the state's compartment
    const pts = [center(s), ...(t.points ?? []), center(g)];
    const edge: Node = [
      'ownedElement',
      { 'xmi:type': 'umldi:UMLEdge', 'xmi:id': `di_${t.id}`, modelElement: t.id, source: `di_${s.id}`, target: `di_${g.id}` },
      ...pts.map((p): Node => ['waypoint', { 'xmi:type': 'dc:Point', x: n1(p.x), y: n1(p.y) }]),
    ];
    if (t.labelOffset) {
      const mid = polylineMid(pts);
      const c = { x: mid.x + t.labelOffset.x, y: mid.y + t.labelOffset.y };
      edge.push(['ownedElement', { 'xmi:type': 'umldi:UMLLabel', 'xmi:id': `di_${t.id}_label`, modelElement: t.id },
        bounds({ x: c.x - LABEL_W / 2, y: c.y - LABEL_H / 2, w: LABEL_W, h: LABEL_H })]);
    }
    edges.push(edge);
  }
  for (const c of m.vertices) {
    if (c.type !== 'comment') continue;
    (c.anchors ?? []).forEach((a, i) => {
      if (!V.has(a) && !m.transitions.some((t) => t.id === a)) return;
      edges.push(['ownedElement', { 'xmi:type': 'umldi:UMLEdge', 'xmi:id': `di_${c.id}_anchor${i + 1}`, modelElement: c.id, source: `di_${c.id}`, target: `di_${a}` }]);
    });
  }
  const diagram: Node = [
    'umldi:UMLStateMachineDiagram',
    { 'xmi:id': `${smId}_diagram`, name: m.name, modelElement: smId, isFrame: 'false' },
    ...shapes,
    ...edges,
  ];

  return writeXml([
    'xmi:XMI',
    {
      'xmi:version': '20131001',
      'xmlns:xmi': NS.xmi,
      'xmlns:uml': NS.uml,
      'xmlns:umldi': NS.umldi,
      'xmlns:dc': NS.dc,
      'xmlns:di': NS.di,
      ...(stereoNames.length ? { [`xmlns:${PROFILE_NAME}`]: PROFILE_NS } : {}),
    },
    ['uml:Model', { 'xmi:id': `${smId}_model`, name: m.name }, ...profileApplication, ...packaged],
    diagram,
    ...applications,
  ]);
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
function bodyOf(el: XmlElement | undefined): string {
  if (!el) return '';
  const spec = kid(el, 'specification') ?? el;
  const b = kid(spec, 'body');
  if (b) return b.text.trim();
  return (spec.attrs.body ?? spec.attrs.value ?? '').trim();
}

function* walk(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const c of el.children) yield* walk(c);
}

/** Parses a state machine file. Throws XmlError or XmiError when it cannot be read. */
export function fromXmi(text: string): FsmModel {
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

  const model: FsmModel = {
    version: 1,
    id: idOf(sm) || 'sm',
    name: sm.attrs.name ?? '',
    kind: typeOf(sm) === 'uml:ProtocolStateMachine' ? 'protocol' : 'behavioral',
    context: contextEl?.attrs.name ?? '',
    documentation: '',
    regions: [],
    vertices: [],
    transitions: [],
  };
  for (const c of kids(sm, 'ownedComment')) {
    if (refs(c, 'annotatedElement').includes(model.id!)) model.documentation = bodyOf(c);
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
      effect: bodyOf(kid(el, 'effect')),
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
        model.vertices.push({ ...vertexBase(c, 'comment', id), text: bodyOf(c), anchors: refs(c, 'annotatedElement') });
      }
    }
  }

  for (const r of kids(sm, 'region')) {
    model.regions.push({ id: idOf(r), name: r.attrs.name ?? '' });
    readRegion(r);
  }
  if (!model.regions.length) model.regions.push({ id: `${model.id}_region`, name: '' });
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
  const regionShapes = new Map<string, { x: number; y: number }>();
  for (const d of root.children) {
    if (d.ns !== NS.umldi) continue;
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
          t.labelOffset = {
            x: n1(+lb.attrs.x + +lb.attrs.width / 2 - mid.x),
            y: n1(+lb.attrs.y + +lb.attrs.height / 2 - mid.y),
          };
        }
      }
    }
  }
  for (const v of model.vertices) {
    const regs = v.regions ?? [];
    if (regs.length < 2) continue;
    const a = regionShapes.get(regs[0].id);
    const b = regionShapes.get(regs[1].id);
    if (a && b) v.regionLayout = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? 'horizontal' : 'vertical';
  }

  // Elements without a shape get a default place and size.
  const DEFAULT: Partial<Record<VertexType, [number, number]>> = {
    state: [140, 60], final: [26, 26], initial: [20, 20], shallowHistory: [26, 26], deepHistory: [26, 26],
    choice: [28, 28], junction: [14, 14], fork: [90, 8], join: [90, 8], entryPoint: [16, 16], exitPoint: [16, 16],
    terminate: [20, 20], connectionPointRef: [16, 16], comment: [160, 64],
  };
  let slot = 0;
  for (const v of model.vertices) {
    if (!v.w || !v.h) [v.w, v.h] = DEFAULT[v.type] ?? [40, 40];
    if (Number.isNaN(v.x) || Number.isNaN(v.y)) {
      v.x = 40 + (slot % 5) * 180;
      v.y = 40 + Math.floor(slot / 5) * 120;
      slot++;
    }
  }
  return normalizeModel(model);
}
