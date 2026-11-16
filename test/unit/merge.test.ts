import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareModels } from '../../src/compare';
import { UNRESOLVED, readMachine, readModel, resolveReferences, writeMachine, assignNames } from '../../src/format';
import { adopt, hasConflictMarkers, splitConflicts } from '../../src/merge';
import { FsmModel } from '../../src/model';
import { root } from './harness';

const text = (name: string) => readFileSync(join(root, 'examples', name), 'utf8');
function example(name: string): FsmModel {
  const r = readMachine(text(`${name}.fsm`), text(`${name}.fsm.layout`));
  if ('problems' in r) throw new Error('unreadable');
  return r.model;
}
const copy = (m: FsmModel) => JSON.parse(JSON.stringify(m)) as FsmModel;
const v = (m: FsmModel, name: string) => m.vertices.find((x) => x.name === name)!;

describe('merge: conflict markers', () => {
  it('split into the current and incoming sides, in both styles', () => {
    const two = 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nb\n';
    assert.ok(hasConflictMarkers(two));
    assert.deepEqual(splitConflicts(two), { current: 'a\nmine\nb\n', incoming: 'a\ntheirs\nb\n', conflicts: 1 });
    const three = 'a\r\n<<<<<<< HEAD\r\nmine\r\n||||||| base\r\nold\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\n';
    assert.deepEqual(splitConflicts(three), { current: 'a\r\nmine\r\n', incoming: 'a\r\ntheirs\r\n', conflicts: 1 });
    assert.ok(!hasConflictMarkers('a\n======= not a conflict\n'));
  });

  it('refuses markers that do not nest', () => {
    assert.throws(() => splitConflicts('<<<<<<< a\nx\n'), /no end marker/);
    assert.throws(() => splitConflicts('>>>>>>> a\n'), /ends where none is open/);
  });

  it('a model conflict in the real file: both sides read, and the differences are the conflict', () => {
    const base = text('Payment.fsm');
    const current = base.replace('"entry": "capture()"', '"entry": "capture(); log()"');
    const incoming = base.replace('"entry": "capture()"', '"entry": "settle()"');
    const marked = base.replace('      "entry": "capture()",\n', '<<<<<<< HEAD\n      "entry": "capture(); log()",\n=======\n      "entry": "settle()",\n>>>>>>> feature\n');
    const split = splitConflicts(marked);
    assert.equal(split.current, current);
    assert.equal(split.incoming, incoming);
    const c = readModel(split.current);
    const i = readModel(split.incoming);
    if ('problems' in c || 'problems' in i) throw new Error('unreadable');
    const changes = compareModels(c.model, i.model);
    assert.deepEqual(changes.map((x) => [x.label, x.properties.map((p) => p.name)]), [["state 'Captured'", ['entry']]]);
  });

  it('a side that is not a valid machine file is reported', () => {
    const marked = '{\n<<<<<<< HEAD\n  "format": 1,\n=======\n  "format": 1\n>>>>>>> x\n  "name": "M", "type": "behavioral" }\n';
    const split = splitConflicts(marked);
    assert.ok(!('problems' in readModel(split.current)));
    assert.ok('problems' in readModel(split.incoming));
  });
});

describe('merge: taking a side', () => {
  it('a property of each kind: the result has the incoming value, the rest stays current', () => {
    const current = example('MediaPlayer');
    const incoming = copy(current);
    v(incoming, 'Off').entry = 'sleep()';
    v(incoming, 'Paused').doActivity = 'blink(); beep()';
    const t = incoming.transitions.find((x) => x.triggers[0] === 'eject')!;
    t.guard = 'hasDisc()';
    t.target = v(incoming, 'Paused').id;
    v(incoming, 'Fault').x += 30;
    incoming.documentation = 'Theirs';
    let result = copy(current);
    const conflicts = compareModels(current, incoming);
    assert.equal(conflicts.length, 5);
    for (const c of conflicts) {
      result = adopt(result, incoming, c.key, c.oldKey ?? c.key);
      assert.ok(!compareModels(result, incoming).some((x) => x.key === c.key), c.label);
    }
    assert.deepEqual(compareModels(result, incoming), []);
    // Keeping current again takes it back.
    for (const c of conflicts) result = adopt(result, current, c.oldKey ?? c.key, c.key);
    assert.deepEqual(compareModels(result, current), []);
  });

  it('an element on one side only: added with what it contains, or removed with its transitions', () => {
    const current = example('MediaPlayer');
    const incoming = copy(current);
    // Theirs removed Playing (and its regions' contents) and the transitions to it.
    const gone = new Set(incoming.vertices.filter((x) => ['Playing', 'Stereo', 'Mono', 'HD', 'SD'].includes(x.name) || ['audio', 'video'].includes(x.parent)).map((x) => x.id));
    incoming.vertices = incoming.vertices.filter((x) => !gone.has(x.id));
    incoming.transitions = incoming.transitions.filter((x) => !gone.has(x.source) && !gone.has(x.target));
    const removed = compareModels(current, incoming).find((c) => c.label === "state 'Playing'")!;
    assert.equal(removed.kind, 'removed');
    const result = adopt(current, incoming, removed.key);
    assert.ok(!result.vertices.some((x) => ['Playing', 'Stereo', 'HD'].includes(x.name)));
    assert.ok(!result.transitions.some((x) => x.target === 'Playing' || x.source === 'Playing'));
    // The other way: taking current's Playing back brings its contents along.
    const back = adopt(result, current, removed.key);
    assert.deepEqual(['Playing', 'Stereo', 'Mono', 'HD', 'SD'].map((n) => !!back.vertices.find((x) => x.name === n)), [true, true, true, true, true]);
    const stereo = back.vertices.find((x) => x.name === 'Stereo')!;
    assert.deepEqual([stereo.x, stereo.y], [v(current, 'Stereo').x, v(current, 'Stereo').y]);
    // The result can be written: names given, nothing lost.
    const m = copy(back);
    assignNames(m);
    assert.deepEqual(writeMachine(m).lost, []);
  });
});

describe('merge: taking a transition before its target', () => {
  it('targets the reference the file writes, which names the target once it is taken', () => {
    const m = (o: object) => {
      const r = readMachine(JSON.stringify({ format: 1, name: 'M', type: 'behavioral', initial: { target: 'A' }, ...o }), undefined);
      if ('problems' in r) throw new Error('unreadable');
      return r.model;
    };
    const current = m({ elements: [{ name: 'A', type: 'state' }] });
    const incoming = m({ elements: [{ name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'Foo' }] }, { name: 'Foo', type: 'state' }] });
    const changes = compareModels(current, incoming);
    const tr = changes.find((c) => c.what === 'transition')!;
    let r = adopt(current, incoming, tr.key);
    const t = () => r.transitions.find((x) => x.triggers.includes('go'))!;
    assert.equal(t().target, UNRESOLVED + 'Foo');
    assert.ok(writeMachine(r).model.includes('"target": "Foo"'));
    r = adopt(r, incoming, changes.find((c) => c.key === 'element@Foo')!.key);
    assignNames(r);
    assert.ok(resolveReferences(r, writeMachine(r)));
    assert.equal(t().target, v(r, 'Foo').id);
  });
});

