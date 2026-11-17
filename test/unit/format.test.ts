import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { convertGroup } from '../../src/convert';
import { UNRESOLVED, UNRESOLVED_ANCHOR, applyLayout, assignNames, derivedIds, readMachine, readModel, resolveReferences, writeMachine } from '../../src/format';
import { parseJson } from '../../src/json';
import { FsmModel, normalizeModel } from '../../src/model';
import { validate } from '../../src/validation';
import { ModelBuilder, root } from './harness';

const file = (name: string) => readFileSync(join(root, 'examples', name), 'utf8');
const EXAMPLES = ['MediaPlayer', 'Order', 'Payment'];

/** Reads a machine's two files; fails on problems. */
function read(model: string, layout?: string) {
  const r = readMachine(model, layout);
  if ('problems' in r) throw new Error(JSON.stringify(r.problems));
  return r;
}

/** Writes a model (generated names given), as the editor saves it. */
function write(model: FsmModel) {
  const m = JSON.parse(JSON.stringify(model)) as FsmModel;
  assignNames(m);
  const w = writeMachine(m);
  assert.deepEqual(w.lost, [], 'nothing is left out');
  return w;
}

/** A model of most features: composite and orthogonal states, points, history, layout of every kind. */
function featured(): FsmModel {
  const b = new ModelBuilder('Featured');
  b.state('A', 'r_root', { x: 40.04, y: 60.06, w: 140, h: 60, entry: 'a(); b()', color: '#112233', itemColors: { entry: '#445566' }, group: 'g1' });
  b.state('B', 'r_root', { x: 230, y: 60, w: 120, h: 60, group: 'g1', deferrable: ['x', 'y'] });
  b.state('C', 'r_root', { x: 400.33, y: 40, w: 340, h: 260, regionLayout: 'horizontal', itemColors: { background: '#eeeeee' } }, 2);
  b.model.vertices.find((v) => v.id === 'C')!.regions![0].size = 170.15;
  b.state('C1', 'C_r0', { x: 420, y: 120, w: 100, h: 50 });
  b.state('C2', 'C_r1', { x: 600, y: 120, w: 100, h: 50 });
  b.vertex('initial', 'C_r0', { x: 430, y: 90, w: 20, h: 20 });
  b.t(b.model.vertices[b.model.vertices.length - 1].id, 'C1', { action: 'go()', points: [{ x: 440, y: 140.05 }] });
  b.init('C2', 'C_r1');
  b.vertex('deepHistory', 'C_r1', { id: 'H', x: 660, y: 70, w: 26, h: 26 });
  b.t('H', 'C2');
  b.vertex('exitPoint', 'C', { id: 'Cx', name: 'out', x: 732, y: 150, w: 16, h: 16, color: '#00ff00' });
  b.t('Cx', 'A');
  b.vertex('entryPoint', 'r_root', { id: 'M_in', name: 'start', x: 10, y: 10, w: 16, h: 16 });
  b.t('M_in', 'A');
  b.vertex('choice', 'r_root', { id: 'ch', x: 260, y: 200, w: 28, h: 28 });
  b.init('A');
  b.t('A', 'B', { triggers: ['go', 'after(1s)'], guard: 'ok()', action: 'log()', points: [{ x: 200, y: 50 }], labelOffset: { x: 3.25, y: -8 }, color: '#aa0000', itemColors: { guard: '#00aa00' } });
  b.t('B', 'ch', { triggers: ['pick'] });
  b.t('ch', 'C', { guard: 'p()' });
  b.t('ch', 'H', { guard: 'else' });
  b.t('A', 'A', { kind: 'internal', triggers: ['tick'], action: 't()' });
  b.t('A', 'A', { triggers: ['again'], points: [{ x: 160, y: 50 }, { x: 190, y: 50 }, { x: 190, y: 90 }] });
  b.t('C1', 'C', { kind: 'local', triggers: ['up'], points: [{ x: 470, y: 280 }] });
  b.vertex('comment', 'r_root', { id: 'n', text: 'Note "quoted"\n\twith a tab', anchors: ['A', 'Cx', 'H'], x: 40, y: 300, w: 160, h: 64 });
  const t = b.model.transitions.find((x) => x.source === 'A' && x.target === 'B')!;
  b.model.vertices.find((v) => v.id === 'n')!.anchors!.push(t.id);
  b.model.documentation = 'Doc with "quotes" and é';
  return normalizeModel(b.model);
}

describe('format: examples', () => {
  for (const name of EXAMPLES) {
    it(`${name}: reading and writing again gives the same bytes`, () => {
      const r = read(file(`${name}.fsm`), file(`${name}.fsm.layout`));
      assert.equal(r.placed, 0);
      const w = write(r.model);
      assert.equal(w.model, file(`${name}.fsm`));
      assert.equal(w.layout, file(`${name}.fsm.layout`));
    });
  }

  it('the examples are the old ones converted, MediaPlayer as the plan of the format shows it', () => {
    const old = (n: string) => readFileSync(join(root, 'test/unit/fixtures/old', `${n}.fsm`), 'utf8');
    const results = convertGroup(EXAMPLES.map((n) => ({ path: `/x/${n}.fsm`, text: old(n) })));
    for (const [i, n] of EXAMPLES.entries()) {
      assert.equal(results[i].modelText, file(`${n}.fsm`), n);
      assert.equal(results[i].layoutText, file(`${n}.fsm.layout`), n);
      assert.deepEqual(results[i].renames, []);
    }
    assert.deepEqual(results[0].losses, ["the context 'MediaPlayer' of the state machine"]);
    assert.match(file('MediaPlayer.fsm'), /\{ "type": "internal", "trigger": "volumeChanged", "action": "updateVolume\(\)" \}/);
    assert.match(file('Order.fsm'), /"submachine": "Payment.fsm"/);
  });

  it('the examples are valid', () => {
    for (const name of EXAMPLES) {
      const issues = validate(read(file(`${name}.fsm`)).model, {
        'Payment.fsm': { found: true, name: 'Payment', points: [{ id: 'retry', name: 'retry', kind: 'entry' }, { id: 'failed', name: 'failed', kind: 'exit' }, { id: 'cancelled', name: 'cancelled', kind: 'exit' }] },
      });
      assert.deepEqual(issues, [], name);
    }
  });
});

describe('format: writing', () => {
  it('write, read, write gives the same bytes, and one save settles', () => {
    const w1 = write(featured());
    const r = read(w1.model, w1.layout);
    const w2 = write(r.model);
    assert.equal(w2.model, w1.model);
    assert.equal(w2.layout, w1.layout);
    const w3 = write(read(w2.model, w2.layout).model);
    assert.equal(w3.layout, w2.layout);
  });

  it('keeps the drawing: positions (0.1 px), sizes, routes, labels, colors, groups and regions', () => {
    const m = featured();
    const r = read(write(m).model, write(m).layout).model;
    const byName = (x: FsmModel, n: string) => x.vertices.find((v) => v.name === n)!;
    assert.deepEqual([byName(r, 'A').x, byName(r, 'A').y], [40, 60.1]);
    assert.deepEqual([byName(r, 'C').x, byName(r, 'C').w, byName(r, 'C').regionLayout], [400.3, 340, 'horizontal']);
    assert.equal(byName(r, 'C').regions![0].size, 170.2);
    assert.deepEqual(byName(r, 'A').itemColors, { entry: '#445566' });
    assert.equal(byName(r, 'A').group, byName(r, 'B').group);
    const t = r.transitions.find((x) => x.triggers.includes('go'))!;
    assert.deepEqual([t.points, t.labelOffset, t.color, t.itemColors], [[{ x: 200, y: 50 }], { x: 3.3, y: -8 }, '#aa0000', { guard: '#00aa00' }]);
    const loop = r.transitions.find((x) => x.triggers.includes('again'))!;
    assert.deepEqual(loop.points, [{ x: 160, y: 50 }, { x: 190, y: 50 }, { x: 190, y: 90 }]);
    const point = r.vertices.find((v) => v.type === 'exitPoint')!;
    assert.deepEqual([point.name, point.x, point.y, point.color], ['out', 732, 150, '#00ff00']);
  });

  it('writes the formatting of the format: one-line objects without lists or objects, minimal escapes', () => {
    const w = write(featured());
    assert.match(w.model, /^ {2}"documentation": "Doc with \\"quotes\\" and é",$/m);
    assert.match(w.model, /"text": "Note \\"quoted\\"\\n\\twith a tab"/);
    assert.match(w.model, /^ {8}\{ "type": "external", "trigger": "go, after\(1s\)", "guard": "ok\(\)", "action": "log\(\)", "target": "B" \},$/m);
    assert.match(w.layout, /^ {12}\{ "x": 200, "y": 50 \}$/m);
    assert.match(w.layout, /^ {6}"group": "g1",$/m);
    assert.ok(w.model.endsWith('}\n') && !w.model.includes('\r'));
    // Generated names, for what had none.
    assert.match(w.model, /"name": "choice1\*", "type": "choice"|"name": "choice1\*",\n\s+"type": "choice"/);
    assert.match(w.model, /"name": "region1\*"/);
  });

  it('positions are relative: moving a state changes only its x and y; moving one end changes no transition entry', () => {
    const m = featured();
    const before = write(m).layout;
    const moved = JSON.parse(JSON.stringify(m)) as FsmModel;
    // Moving C moves what it contains and the bend points between them, as the editor does.
    const inside = new Set(['C', 'C1', 'C2', 'H', 'Cx', ...moved.vertices.filter((v) => v.parent === 'C_r0' || v.parent === 'C_r1').map((v) => v.id)]);
    for (const v of moved.vertices) if (inside.has(v.id)) [v.x, v.y] = [v.x + 33, v.y - 7];
    for (const t of moved.transitions) if (inside.has(t.source) && inside.has(t.target) && t.points) t.points = t.points.map((p) => ({ x: p.x + 33, y: p.y - 7 }));
    const after = write(moved).layout;
    const changed = diffLines(before, after);
    assert.deepEqual(changed, [['      "x": 400.3,', '      "x": 433.3,'], ['      "y": 40,', '      "y": 33,']]);
    // Moving B alone (one end of A -> B and of B -> choice): only B's own place.
    const one = JSON.parse(JSON.stringify(m)) as FsmModel;
    const b = one.vertices.find((v) => v.id === 'B')!;
    b.x += 50;
    assert.deepEqual(diffLines(before, write(one).layout), [['      "x": 230,', '      "x": 280,']]);
  });

  it('keeps a reference that names nothing, and draws nothing from it', () => {
    const text = file('Order.fsm').replace('"target": "Shipped"', '"target": "Shiped"');
    const r = read(text);
    const t = r.model.transitions.find((x) => x.target === `${UNRESOLVED}Shiped`);
    assert.ok(t);
    assert.ok(validate(r.model).some((i) => i.id === t.id && i.message === "Transition target 'Shiped' does not exist."));
    assert.equal(write(r.model).model, text);
  });

  it('holds what the old model could and the format can not: it is reported, not written', () => {
    const b = new ModelBuilder('Lost');
    b.state('A');
    b.init('A');
    b.vertex('initial', 'r_root', { id: 'i2' });
    const w = writeMachine(b.model);
    assert.deepEqual(w.lost, ['an unnamed initial pseudostate: a region has at most one']);
  });
});

/** The lines that differ between two texts of the same length in lines. */
function diffLines(a: string, b: string): [string, string][] {
  const x = a.split('\n');
  const y = b.split('\n');
  assert.equal(x.length, y.length);
  return x.flatMap((l, i) => (l === y[i] ? [] : [[l, y[i]] as [string, string]]));
}

describe('format: reading', () => {
  it('reports problems with their lines, and no model', () => {
    const r = readModel('{\n  "format": 1,\n  "name": "X",\n  "type": "behavioral",\n  "elements": [\n    { "name": "A", "type": "state", "gaurd": "x" }\n  ]\n}\n');
    assert.deepEqual(r, { problems: [{ line: 6, message: "Unknown field 'gaurd' in a state." }] });
    assert.deepEqual(readModel('{ "format": 3, "name": "X", "type": "behavioral" }'), { problems: [{ line: 1, message: 'This file is in format 3: this version reads format 1 only.' }] });
  });

  it('reads CRLF line ends and a $schema field, which is not written back', () => {
    const text = file('Payment.fsm').replace('{\n', '{\n  "$schema": "../schemas/fsm.schema.json",\n').replace(/\n/g, '\r\n');
    assert.equal(write(read(text).model).model, file('Payment.fsm'));
  });

  it('places elements without a layout entry beside the others, the same way on every open', () => {
    assert.ok(parseJson(file('MediaPlayer.fsm.layout')));
    const layout = JSON.parse(file('MediaPlayer.fsm.layout'));
    layout.elements = layout.elements.filter((e: { name: string }) => e.name !== 'Fault');
    const without = JSON.stringify(layout, null, 2);
    const r1 = read(file('MediaPlayer.fsm'), without);
    const r2 = read(file('MediaPlayer.fsm'), without);
    assert.equal(r1.placed, 1);
    const fault = r1.model.vertices.find((v) => v.name === 'Fault')!;
    assert.deepEqual([fault.x, fault.y, fault.w, fault.h], [r2.model.vertices.find((v) => v.name === 'Fault')!.x, 20, 140, 60]);
    // No layout file: everything, level by level; the model file is untouched.
    const none = read(file('MediaPlayer.fsm'), undefined);
    assert.equal(none.placed, none.model.vertices.length);
    assert.equal(write(none.model).model, file('MediaPlayer.fsm'));
  });

  it('ignores layout entries that match nothing, and an unreadable layout file', () => {
    const extra = file('Payment.fsm.layout').replace('"elements": [', '"elements": [\n    { "name": "Gone", "x": 1, "y": 2 },');
    assert.equal(write(read(file('Payment.fsm'), extra).model).layout, file('Payment.fsm.layout'));
    const r = read(file('Payment.fsm'), '{ "format": 1, "elements": 3 }');
    assert.equal(r.problem, "line 1: Field 'elements' must be a list.");
    assert.equal(r.placed, r.model.vertices.length);
  });

  it('derives the ids fsm-cli gives, for a model edited since it was read', () => {
    const m = read(file('MediaPlayer.fsm'), file('MediaPlayer.fsm.layout')).model;
    const ids = new Map(m.vertices.map((v) => [v.name || v.id, v.id]));
    m.vertices.find((v) => v.name === 'Fault')!.id = 'v_new';
    const t = m.transitions.find((x) => x.source === 'Paused' && x.triggers.includes('stop'))!;
    t.id = 't_new';
    for (const x of m.transitions) if (x.source === 'Fault') x.source = 'v_new';
    for (const x of m.transitions) if (x.target === 'Fault') x.target = 'v_new';
    const d = derivedIds(m);
    assert.equal(d.get('v_new'), 'Fault');
    assert.equal(d.get('t_new'), 'Paused#2');
    assert.equal(d.get('On.deepHistory'), ids.get('On.deepHistory') ?? 'On.deepHistory');
  });

  it('applies a layout to a model read alone', () => {
    const r = readModel(file('Order.fsm'));
    if ('problems' in r) throw new Error('unreadable');
    const result = applyLayout(r, file('Order.fsm.layout'));
    assert.equal(result.placed, 0);
    assert.equal(write(r.model).layout, file('Order.fsm.layout'));
  });
});

describe('format: review fixes', () => {
  const model = (o: object) => JSON.stringify({ format: 1, name: 'M', type: 'behavioral', ...o }, null, 2) + '\n';

  it('resolves comment anchors: a reference to its element, a transition by source, trigger and target', () => {
    const r = read(model({
      initial: { target: 'A' },
      elements: [
        { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'B' }, { type: 'internal', trigger: 'tick' }] },
        { name: 'B', type: 'state' },
        { name: 'c', type: 'comment', anchors: ['A', { source: 'A', trigger: 'go', target: 'B' }, { source: 'A', trigger: 'tick' }, 'Nope', { source: 'A', trigger: 'x', target: 'B' }] },
      ],
    }));
    const anchors = r.model.vertices.find((v) => v.name === 'c')!.anchors!;
    assert.deepEqual(anchors.slice(0, 3), ['A', 'A#1', 'A#2']);
    assert.equal(anchors[3], UNRESOLVED + 'Nope');
    assert.ok(anchors[4].startsWith(UNRESOLVED_ANCHOR));
    // Nothing is lost: an edit can be saved, and the anchors are written back as they were.
    const w = writeMachine(r.model);
    assert.deepEqual(w.lost, []);
    assert.ok(w.model.includes('"Nope"') && w.model.includes('{ "source": "A", "trigger": "x", "target": "B" }'));
  });

  it('keeps the layout of each of two transitions with the same trigger and target', () => {
    const b = new ModelBuilder('M');
    b.vertex('choice', 'r_root', { id: 'c', name: 'c', x: 10, y: 10, w: 28, h: 28 });
    b.state('Next', 'r_root', { x: 200, y: 10 });
    b.init('Next');
    b.t('c', 'Next', { guard: 'x()', action: 'a()' });
    b.t('c', 'Next', { guard: 'else', action: 'b()', points: [{ x: 100, y: 120 }], color: '#ff0000' });
    const w = write(b.model);
    const back = read(w.model, w.layout).model.transitions.filter((t) => t.source === 'c');
    assert.deepEqual(back.map((t) => [t.guard, t.points?.length ?? 0, t.color ?? '']), [['x()', 0, ''], ['else', 1, '#ff0000']]);
    assert.equal(write(read(w.model, w.layout).model).layout, w.layout);
  });

  it('finds a layout entry by the trigger as the model file writes it', () => {
    const text = model({ initial: { target: 'A' }, elements: [{ name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'a,b', target: 'B' }] }, { name: 'B', type: 'state' }] });
    const layout = JSON.stringify({ format: 1, elements: [{ name: 'A', x: 10, y: 10, transitions: [{ trigger: 'a,b', target: 'B', bends: [{ x: 5, y: 5 }] }] }] });
    const t = read(text, layout).model.transitions.find((x) => x.source === 'A')!;
    assert.deepEqual(t.points, [{ x: 5, y: 5 }]);
  });

  it("an initial pseudostate's color is its transition's, not its own", () => {
    const b = new ModelBuilder('M');
    b.state('A', 'r_root', { x: 100, y: 10 });
    b.init('A');
    b.model.transitions[0].color = '#00ff00';
    const w = write(b.model);
    const r = read(w.model, w.layout).model;
    assert.equal(r.vertices.find((v) => v.type === 'initial')!.color, undefined);
    assert.equal(r.transitions[0].color, '#00ff00');
  });

  it('places a state grown to hold what it contains before the elements beside it', () => {
    const r = read(model({ initial: { target: 'A' }, elements: [
      { name: 'A', type: 'state', initial: { target: 'A1' }, elements: [{ name: 'A1', type: 'state' }, { name: 'A2', type: 'state' }, { name: 'A3', type: 'state' }] },
      { name: 'B', type: 'state' },
    ] }));
    const a = r.model.vertices.find((v) => v.name === 'A')!;
    const bState = r.model.vertices.find((v) => v.name === 'B')!;
    assert.ok(bState.x >= a.x + a.w, `B (x ${bState.x}) is beside A (${a.x}..${a.x + a.w})`);
  });

  it('writes places that are numbers under a state whose place is not one', () => {
    const b = new ModelBuilder('M');
    b.state('A', 'r_root', { x: Infinity, y: 10, w: 300, h: 200 }, 1);
    b.state('B', 'A_r0', { x: 100, y: 50 });
    const m = JSON.parse(JSON.stringify(b.model)) as FsmModel;
    m.vertices[0].x = Infinity;
    assignNames(m);
    const w = writeMachine(m);
    assert.deepEqual(w.lost, ["the place of state 'A', which is not a number"]);
    assert.equal(read(w.model, w.layout).problem, undefined);
  });

  it('keeps a name used twice without fix, numbers it when converting', () => {
    const b = new ModelBuilder('M');
    b.state('Idle', 'r_root');
    b.state('Idle', 'r_root', { id: 'Idle2' });
    const m = JSON.parse(JSON.stringify(b.model)) as FsmModel;
    assert.deepEqual(assignNames(m), []);
    assert.deepEqual(m.vertices.map((v) => v.name), ['Idle', 'Idle']);
    assert.deepEqual(assignNames(m, true).map((x) => x.to), ['Idle2']);
  });

  it('resolves a target or an anchor that named nothing once it names something', () => {
    const r = read(model({ initial: { target: 'A' }, elements: [
      { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'Foo' }] },
      { name: 'c', type: 'comment', anchors: ['Foo', { source: 'A', trigger: 'go', target: 'Foo' }] },
    ] })).model;
    const t = r.transitions.find((x) => x.source === 'A')!;
    assert.equal(t.target, UNRESOLVED + 'Foo');
    assert.equal(resolveReferences(r, writeMachine(r)), false);
    r.vertices.push({ id: 'v_foo', type: 'state', name: 'Foo', parent: r.regions[0].id, x: 300, y: 10, w: 140, h: 60, regions: [] });
    assert.equal(resolveReferences(r, writeMachine(r)), true);
    assert.equal(t.target, 'v_foo');
    assert.deepEqual(r.vertices.find((v) => v.name === 'c')!.anchors, ['v_foo', t.id]);
  });
});
