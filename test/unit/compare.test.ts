import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareModels, describeChange, isModelChange } from '../../src/compare';
import { convertGroup } from '../../src/convert';
import { readMachine } from '../../src/format';
import { FsmModel } from '../../src/model';
import { root } from './harness';

function example(name: string): FsmModel {
  const r = readMachine(readFileSync(join(root, 'examples', `${name}.fsm`), 'utf8'), readFileSync(join(root, 'examples', `${name}.fsm.layout`), 'utf8'));
  if ('problems' in r) throw new Error('unreadable');
  return r.model;
}
const copy = (m: FsmModel) => JSON.parse(JSON.stringify(m)) as FsmModel;
const v = (m: FsmModel, name: string) => m.vertices.find((x) => x.name === name)!;
const summary = (older: FsmModel, newer: FsmModel) => compareModels(older, newer).map((c) => [c.kind, c.label, describeChange(c, true)]);

describe('compare', () => {
  it('finds nothing between equal machines', () => {
    assert.deepEqual(compareModels(example('MediaPlayer'), example('MediaPlayer')), []);
  });

  it('a layout-only change: hidden by default, and moving a state changes nothing inside it', () => {
    const a = example('MediaPlayer');
    const b = copy(a);
    for (const x of b.vertices) {
      if (x.name === 'On' || a.vertices.find((y) => y.id === x.parent)?.name === 'On' || ['On.', 'audio', 'video'].includes(x.parent) || ['Stopped', 'Paused', 'Playing', 'Stereo', 'Mono', 'HD', 'SD', 'choice1*'].includes(x.name)) {
        x.x += 25;
      }
    }
    for (const t of b.transitions) if (t.points && b.vertices.find((x) => x.id === t.source)!.x !== a.vertices.find((x) => x.id === t.source)!.x && b.vertices.find((x) => x.id === t.target)?.x !== a.vertices.find((x) => x.id === t.target)?.x) t.points = t.points.map((p) => ({ x: p.x + 25, y: p.y }));
    const changes = compareModels(a, b);
    const on = changes.find((c) => c.label === "state 'On'")!;
    assert.deepEqual(describeChange(on, true), ['x: 340 → 365']);
    assert.ok(!isModelChange(on));
    assert.deepEqual(changes.filter(isModelChange), []);
    assert.ok(!changes.some((c) => c.label === "state 'Stopped'"), 'what On contains did not move relative to it');
  });

  it('a rename is one element removed and one added; transitions to it are changed', () => {
    const a = example('Order');
    const b = copy(a);
    v(b, 'Shipped').name = 'Delivered';
    const kinds = compareModels(a, b).map((c) => [c.kind, c.label]);
    // Its own transition is found under it, so it is renamed too.
    assert.deepEqual(kinds.filter(([k]) => k !== 'changed'), [['added', "state 'Delivered'"], ['added', 'transition Delivered -> final1'], ['removed', "state 'Shipped'"], ['removed', 'transition Shipped -> final1']]);
    const t = compareModels(a, b).find((c) => c.kind === 'changed' && c.what === 'transition')!;
    assert.deepEqual(describeChange(t, false), ['target: Shipped → Delivered']);
  });

  it('a change in each kind of property is listed', () => {
    const a = example('MediaPlayer');
    const b = copy(a);
    v(b, 'Off').entry = 'sleep()';
    v(b, 'Paused').deferrable = ['eject'];
    const t = b.transitions.find((x) => x.triggers[0] === 'eject')!;
    t.guard = 'hasDisc()';
    t.action = 'beep()';
    const c = b.transitions.find((x) => x.triggers[0] === 'powerOff')!;
    c.kind = 'local';
    v(b, 'comment1*').text = 'Other text';
    b.documentation = 'Changed';
    const out = summary(a, b);
    // In the newer version's order: the machine, then its elements and transitions as the model lists them.
    assert.deepEqual(out, [
      ['changed', 'the state machine', ['documentation: Example UML state machine: composite and orthogonal state… → Changed']],
      ['changed', 'comment', ['text: Deep history restores the\nlast active playback substates\n… → Other text']],
      ['changed', "state 'Off'", ['entry: powerDown() → sleep()']],
      ['changed', "state 'Paused'", ['defer: (none) → eject']],
      ['changed', 'transition On -> Off (powerOff)', ['kind: external → local']],
      ['changed', 'transition Stopped -> choice1 (eject)', ['guard: (none) → hasDisc()', 'action: (none) → beep()']],
    ]);
  });

  it('a retargeted transition is changed, not removed and added', () => {
    const a = example('Payment');
    const b = copy(a);
    b.transitions.find((x) => x.triggers[0] === 'declined')!.target = v(b, 'Captured').id;
    assert.deepEqual(summary(a, b), [['changed', 'transition Authorizing -> Captured (declined)', ['target: Declined → Captured']]]);
  });

  it('the diff of a conversion: an old file against its new version shows nothing', () => {
    const old = readFileSync(join(root, 'test/unit/fixtures/old/MediaPlayer.fsm'), 'utf8');
    const [converted] = convertGroup([{ path: '/x/MediaPlayer.fsm', text: old }]);
    assert.deepEqual(compareModels(converted.model, example('MediaPlayer')), []);
  });

  it('moving an element to another region of its state is a change of the model', () => {
    const mk = (inFirst: boolean) => {
      const r = readMachine(JSON.stringify({ format: 1, name: 'M', type: 'behavioral', elements: [{ name: 'S', type: 'state', regions: [
        { name: 'R1', elements: inFirst ? [{ name: 'X', type: 'state' }, { name: 'Y', type: 'state' }] : [{ name: 'Y', type: 'state' }] },
        { name: 'R2', elements: inFirst ? [{ name: 'Z', type: 'state' }] : [{ name: 'Z', type: 'state' }, { name: 'X', type: 'state' }] },
      ] }] }), undefined);
      if ('problems' in r) throw new Error('unreadable');
      return r.model;
    };
    const x = compareModels(mk(true), mk(false)).filter(isModelChange);
    assert.deepEqual(x.map((c) => [c.label, c.properties.filter((p) => !p.layout).map((p) => `${p.name}: ${p.old} → ${p.new}`)]), [["state 'X'", ["in: 'S', region 'R1' → 'S', region 'R2'"]]]);
  });
});

