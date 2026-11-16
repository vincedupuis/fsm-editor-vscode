import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { convertGroup } from '../../src/convert';
import { isOldFormat, readMachine } from '../../src/format';
import { decodeHref } from '../../src/util';
import { fromXmi } from '../../src/xmi';
import { root } from './harness';

const old = (n: string) => readFileSync(join(root, 'test/unit/fixtures/old', `${n}.fsm`), 'utf8');

/** A small old file: `body` inside the machine's region, `extra` after the machine. */
const xmi = (body: string, name = 'M', id = 'sm') => `<?xml version="1.0" encoding="UTF-8"?>
<xmi:XMI xmi:version="20131001" xmlns:xmi="http://www.omg.org/spec/XMI/20131001" xmlns:uml="http://www.omg.org/spec/UML/20161101">
  <uml:Model xmi:id="m" name="${name}">
    <packagedElement xmi:type="uml:StateMachine" xmi:id="${id}" name="${name}">
      <region xmi:type="uml:Region" xmi:id="r">
${body}
      </region>
    </packagedElement>
  </uml:Model>
</xmi:XMI>
`;

describe('old files (XMI)', () => {
  it('are recognized, and read as they are', () => {
    assert.ok(isOldFormat(old('MediaPlayer')));
    assert.ok(!isOldFormat(readFileSync(join(root, 'examples/MediaPlayer.fsm'), 'utf8')));
    const m = fromXmi(old('MediaPlayer'));
    assert.equal(m.context, 'MediaPlayer');
    assert.equal(m.transitions.find((t) => t.id === 't22')!.action, 'updateVolume()');
  });

  it('convert: generated names, names used twice numbered, spaces, * and . replaced, every rename and loss reported', () => {
    const [r] = convertGroup([{ path: '/w/M.fsm', text: xmi(`        <subvertex xmi:type="uml:Pseudostate" xmi:id="i" kind="initial" name="start"/>
        <subvertex xmi:type="uml:State" xmi:id="a" name="Idle"/>
        <subvertex xmi:type="uml:State" xmi:id="b" name="Idle"/>
        <subvertex xmi:type="uml:State" xmi:id="c" name="a.b*"/>
        <subvertex xmi:type="uml:State" xmi:id="w" name=" Waiting  for payment"/>
        <subvertex xmi:type="uml:State" xmi:id="d"/>
        <subvertex xmi:type="uml:Pseudostate" xmi:id="j" kind="junction"/>
        <transition xmi:type="uml:Transition" xmi:id="t0" source="i" target="a"/>
        <transition xmi:type="uml:Transition" xmi:id="t1" source="a" target="i"/>
        <transition xmi:type="uml:Transition" xmi:id="t2" source="a" target="b"><effect xmi:type="uml:OpaqueBehavior" xmi:id="e"><body>go()</body></effect></transition>`) }]);
    assert.deepEqual(r.renames, ["the state 'a.b*' is now 'a_b_'", "the state ' Waiting  for payment' is now 'Waiting_for_payment'", "the state 'Idle' is now 'Idle2' (its name was used twice)"]);
    assert.equal(r.generated, 2);
    assert.deepEqual(r.losses, ['the name of the initial pseudostate \'start\'', "the transition from state 'Idle' to an initial pseudostate"]);
    const read = readMachine(r.modelText, r.layoutText);
    if ('problems' in read) throw new Error('unreadable');
    assert.deepEqual(read.model.vertices.map((v) => v.name), ['', 'Idle', 'Idle2', 'a_b_', 'Waiting_for_payment', 'state1*', 'junction1*']);
    assert.match(r.modelText, /\{ "type": "external", "action": "go\(\)", "target": "Idle2" \}/);
  });

  it('convert linked files together: point references become the points\' names', () => {
    const results = convertGroup(['Order', 'Payment'].map((n) => ({ path: `/x/${n}.fsm`, text: old(n) })));
    const order = readMachine(results[0].modelText, results[0].layoutText);
    if ('problems' in order) throw new Error('unreadable');
    assert.deepEqual(order.model.vertices.filter((v) => v.type === 'connectionPointRef').map((v) => [v.ref, v.pointKind]), [['retry', 'entry'], ['failed', 'exit'], ['cancelled', 'exit']]);
    // Alone, Order can't know Payment's points: the ids stay, and the loss is said.
    const [alone] = convertGroup([{ path: '/x/Order.fsm', text: old('Order') }]);
    assert.equal(alone.losses.length, 3);
    assert.match(alone.losses[0], /point 'p_retry' of Payment\.fsm, which was not found/);
  });

  it('a file that is not XMI can not be converted', () => {
    const [r] = convertGroup([{ path: '/x/A.fsm', text: '<a/>' }]);
    assert.match(r.error!, /Not an XMI document/);
  });
});

describe('hrefs of old files', () => {
  it('decode as decodeURI does, keeping malformed escapes', () => {
    assert.equal(decodeHref('My%20Machine.fsm'), 'My Machine.fsm');
    assert.equal(decodeHref('caf%C3%A9.fsm'), 'café.fsm');
    assert.equal(decodeHref('a%23b%2Fc%3F'), 'a#b%2Fc?');
    assert.equal(decodeHref('caf%C3%A9%zz'), 'café%zz');
    assert.equal(decodeHref('a%E0.fsm'), 'a%E0.fsm');
    assert.equal(decodeHref('a%E0%41.fsm'), 'a%E0A.fsm');
    assert.equal(decodeHref('a%C0%80%'), 'a%C0%80%');
  });
});
