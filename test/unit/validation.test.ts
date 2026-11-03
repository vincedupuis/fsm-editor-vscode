import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GenerateError } from '../../src/codegen/generate';
import { validate } from '../../src/validation';
import { ModelBuilder, load } from './harness';

/** The issues about cycles of pseudostates, as [id, severity, message]. */
const cycles = (b: ModelBuilder) =>
  validate(b.model)
    .filter((i) => i.message.includes('form a cycle'))
    .map((i) => [i.id, i.severity, i.message]);

/** A machine with states A and B, A entered first: `A -e-> <first>` and `<last> -[else]-> B` are up to the test. */
function machine(): ModelBuilder {
  const b = new ModelBuilder('M');
  b.state('A');
  b.state('B');
  b.init('A');
  return b;
}

describe('validation: cycles of pseudostates', () => {
  it('reports two choices leading to each other once, on the first, with the shortest cycle', () => {
    const b = machine();
    const c1 = b.vertex('choice', 'r_root', { id: 'c1', name: 'c1' });
    const c2 = b.vertex('choice', 'r_root', { id: 'c2', name: 'c2' });
    b.t('A', c1, { triggers: ['e'] });
    b.t(c1, c2, { guard: 'g()' });
    b.t(c1, 'B', { guard: 'else' });
    b.t(c2, c1, { guard: 'h()' });
    b.t(c2, 'B', { guard: 'else' });
    assert.deepEqual(cycles(b), [['c1', 'error', "Choices form a cycle without a state: 'c1' -> 'c2' -> 'c1'."]]);
  });

  it('reports a choice targeting itself', () => {
    const b = machine();
    const c = b.vertex('choice', 'r_root', { id: 'c', name: 'c' });
    b.t('A', c, { triggers: ['e'] });
    b.t(c, c, { guard: 'g()' });
    b.t(c, 'B', { guard: 'else' });
    assert.deepEqual(cycles(b), [['c', 'error', "Choices form a cycle without a state: 'c' -> 'c'."]]);
  });

  it('names the kinds of pseudostates in the cycle, and unnamed ones by their kind', () => {
    const b = machine();
    const c = b.vertex('choice', 'r_root', { id: 'c' });
    const j = b.vertex('junction', 'r_root', { id: 'j' });
    b.t('A', j, { triggers: ['e'] });
    b.t(j, c);
    b.t(c, j, { guard: 'g()' });
    b.t(c, 'B', { guard: 'else' });
    assert.deepEqual(cycles(b), [['c', 'error', 'Junctions and choices form a cycle without a state: choice -> junction -> choice.']]);
  });

  it('reports one issue for cycles sharing pseudostates, through the first transitions', () => {
    const b = machine();
    const j1 = b.vertex('junction', 'r_root', { id: 'j1', name: 'j1' });
    const j2 = b.vertex('junction', 'r_root', { id: 'j2', name: 'j2' });
    const j3 = b.vertex('junction', 'r_root', { id: 'j3', name: 'j3' });
    const j4 = b.vertex('junction', 'r_root', { id: 'j4', name: 'j4' });
    b.t('A', j1, { triggers: ['e'] });
    b.t(j1, j2, { guard: 'a()' });
    b.t(j1, j3, { guard: 'b()' });
    b.t(j1, 'B', { guard: 'else' });
    b.t(j2, j4);
    b.t(j4, j1);
    b.t(j3, j1);
    assert.deepEqual(cycles(b), [['j1', 'error', "Junctions form a cycle without a state: 'j1' -> 'j3' -> 'j1'."]]);
  });

  it('reports separate cycles separately, even when one leads to the other', () => {
    const b = machine();
    const j1 = b.vertex('junction', 'r_root', { id: 'j1', name: 'j1' });
    const j2 = b.vertex('junction', 'r_root', { id: 'j2', name: 'j2' });
    b.t('A', j1, { triggers: ['e'] });
    b.t(j1, j1, { guard: 'a()' });
    b.t(j1, j2, { guard: 'else' });
    b.t(j2, j2, { guard: 'a()' });
    b.t(j2, 'B', { guard: 'else' });
    assert.deepEqual(cycles(b), [
      ['j1', 'error', "Junctions form a cycle without a state: 'j1' -> 'j1'."],
      ['j2', 'error', "Junctions form a cycle without a state: 'j2' -> 'j2'."],
    ]);
  });

  it('reports cycles through history defaults, forks and the entry and exit points of states', () => {
    // A history default leading back to the history through a choice.
    let b = machine();
    b.state('S', 'r_root', {}, 1);
    b.state('S1', 'S_r0');
    const h = b.vertex('shallowHistory', 'S_r0', { id: 'h' });
    const c = b.vertex('choice', 'S_r0', { id: 'c', name: 'c' });
    b.t('A', h, { triggers: ['e'] });
    b.t(h, c);
    b.t(c, h, { guard: 'g()' });
    b.t(c, 'S1', { guard: 'else' });
    assert.deepEqual(cycles(b), [['h', 'error', "Choices and history pseudostates form a cycle without a state: shallow history -> 'c' -> shallow history."]]);

    // An entry point of a state and a choice inside it.
    b = machine();
    b.state('S', 'r_root', {}, 1);
    b.state('S1', 'S_r0');
    const ep = b.vertex('entryPoint', 'S', { id: 'ep', name: 'ep' });
    const c2 = b.vertex('choice', 'S_r0', { id: 'c', name: 'c' });
    b.t('A', ep, { triggers: ['e'] });
    b.t(ep, c2);
    b.t(c2, ep, { guard: 'g()' });
    b.t(c2, 'S1', { guard: 'else' });
    assert.deepEqual(cycles(b), [['ep', 'error', "Choices and entry points form a cycle without a state: 'ep' -> 'c' -> 'ep'."]]);

    // An exit point of a state and a junction outside it.
    b = machine();
    b.state('S', 'r_root', {}, 1);
    b.state('S1', 'S_r0');
    const xp = b.vertex('exitPoint', 'S', { id: 'xp', name: 'xp' });
    const j = b.vertex('junction', 'r_root', { id: 'j', name: 'j' });
    b.t('S1', xp, { triggers: ['e'] });
    b.t(xp, j);
    b.t(j, xp, { guard: 'g()' });
    b.t(j, 'B', { guard: 'else' });
    assert.deepEqual(cycles(b), [['xp', 'error', "Junctions and exit points form a cycle without a state: 'xp' -> 'j' -> 'xp'."]]);

    // A fork and a choice.
    b = machine();
    b.state('S', 'r_root', {}, 2);
    b.state('S1', 'S_r0');
    b.state('S2', 'S_r1');
    const f = b.vertex('fork', 'r_root', { id: 'f', name: 'f' });
    const c3 = b.vertex('choice', 'r_root', { id: 'c', name: 'c' });
    b.t('A', c3, { triggers: ['e'] });
    b.t(c3, f, { guard: 'g()' });
    b.t(c3, 'B', { guard: 'else' });
    b.t(f, 'S1');
    b.t(f, c3);
    assert.deepEqual(cycles(b), [['f', 'error', "Choices and forks form a cycle without a state: 'f' -> 'c' -> 'f'."]]);
  });

  it('accepts loops through states, the machine\'s own entry points, joins and internal transitions', () => {
    const b = machine();
    // Through a state.
    const c = b.vertex('choice', 'r_root', { id: 'c', name: 'c' });
    b.t('A', c, { triggers: ['e'] });
    b.t(c, 'A', { guard: 'g()' });
    b.t(c, 'B', { guard: 'else' });
    // An internal transition (an error on a pseudostate) does not go anywhere.
    b.t(c, c, { kind: 'internal' });
    // Through an entry point of the machine, which ends the transition.
    const ep = b.vertex('entryPoint', 'r_root', { id: 'ep', name: 'ep' });
    const j = b.vertex('junction', 'r_root', { id: 'j', name: 'j' });
    b.t(ep, j);
    b.t(j, ep, { guard: 'g()' });
    b.t(j, 'B', { guard: 'else' });
    // Through a join.
    b.state('P', 'r_root', {}, 2);
    b.state('P1', 'P_r0');
    b.state('P2', 'P_r1');
    const jn = b.vertex('join', 'r_root', { id: 'jn', name: 'jn' });
    const c2 = b.vertex('choice', 'r_root', { id: 'c2', name: 'c2' });
    b.t('P1', jn);
    b.t('P2', jn);
    b.t(jn, c2);
    b.t(c2, jn, { guard: 'g()' });
    b.t(c2, 'B', { guard: 'else' });
    assert.deepEqual(cycles(b), []);
  });

  it('stops code generation with the validation error', async () => {
    const b = machine();
    const j1 = b.vertex('junction', 'r_root', { id: 'j1', name: 'j1' });
    const j2 = b.vertex('junction', 'r_root', { id: 'j2', name: 'j2' });
    b.t('A', j1, { triggers: ['e'] });
    b.t(j1, j2);
    b.t(j2, j1);
    await assert.rejects(load({ 'M.fsm': b.model }), (e: unknown) => {
      assert.ok(e instanceof GenerateError);
      assert.deepEqual(
        e.issues.filter((i) => i.severity === 'error').map((i) => i.message),
        ["Junctions form a cycle without a state: 'j1' -> 'j2' -> 'j1'."],
      );
      return true;
    });
  });
});
