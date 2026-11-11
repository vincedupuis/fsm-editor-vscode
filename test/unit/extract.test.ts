import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ExtractError, ExtractResult, extractSubmachine, proposedName } from '../../src/extract';
import { FsmModel, Transition, Vertex, machineConnectionPoints } from '../../src/model';
import { validate } from '../../src/validation';
import { fromXmi, toXmi } from '../../src/xmi';
import { FakeClock, ModelBuilder, load, recorder, root } from './harness';

const example = (name: string) => fromXmi(readFileSync(join(root, 'examples', name), 'utf8'));
const HREF = 'Sub.fsm#sm';

/** Extracts `ids` of `model` into machine `Sub`, checking that both machines are valid and survive an XMI round trip. */
function extract(model: FsmModel, ids: string[], name = 'Sub'): ExtractResult {
  const before = JSON.stringify(model);
  const r = extractSubmachine(model, ids, name, `${name}.fsm#sm`);
  assert.equal(JSON.stringify(model), before, 'the model is left unchanged');
  const info = { [`${name}.fsm#sm`]: { found: true, name, points: machineConnectionPoints(r.machine) } };
  assert.deepEqual(validate(r.parent, info), [], 'the edited machine is valid');
  assert.deepEqual(validate(r.machine), [], 'the new machine is valid');
  for (const m of [r.parent, r.machine]) assert.deepEqual(essentials(fromXmi(toXmi(m))), essentials(m), 'XMI round trip');
  return r;
}

/** What a model says, without layout or element order. */
function essentials(m: FsmModel) {
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return {
    name: m.name,
    regions: m.regions.map((r) => r.id),
    vertices: [...m.vertices].sort(byId).map((v) => [v.id, v.type, v.name, v.parent, v.submachine, v.ref, v.pointKind, v.group, v.anchors, v.regions?.map((r) => r.id)]),
    transitions: [...m.transitions].sort(byId).map((t) => [t.id, t.source, t.target, t.kind, t.triggers, t.guard, t.effect]),
  };
}

const vertex = (m: FsmModel, id: string) => m.vertices.find((v) => v.id === id);
const transition = (m: FsmModel, id: string) => m.transitions.find((t) => t.id === id)!;
const named = (m: FsmModel, type: Vertex['type'], name: string) => m.vertices.find((v) => v.type === type && v.name === name)!;
const points = (m: FsmModel, type: 'entryPoint' | 'exitPoint') => m.vertices.filter((v) => v.type === type).map((v) => v.name).sort();
const label = (t: Transition) => [t.triggers.join(','), t.guard, t.effect].join('|');
const from = (m: FsmModel, source: string) => m.transitions.filter((t) => t.source === source);
const to = (m: FsmModel, target: string) => m.transitions.filter((t) => t.target === target);
/** The reference on the submachine state for the new machine's point `pointId`. */
const refOf = (r: ExtractResult, pointId: string) => r.parent.vertices.find((v) => v.type === 'connectionPointRef' && v.ref === pointId)!;

/** MediaPlayer without its deep history, so that On can be extracted. */
function mediaPlayerWithoutHistory(): FsmModel {
  const m = example('MediaPlayer.fsm');
  m.vertices = m.vertices.filter((v) => v.id !== 'v_hist');
  m.transitions = m.transitions.filter((t) => t.source !== 'v_hist' && t.target !== 'v_hist');
  for (const v of m.vertices) if (v.anchors) v.anchors = v.anchors.filter((a) => a !== 'v_hist');
  return m;
}

describe('extract to submachine: models', () => {
  it('splits crossing transitions, keeping trigger, guard and effect on the source side', () => {
    const r = extract(example('MediaPlayer.fsm'), ['v_paused', 'v_choice']);
    const state = vertex(r.parent, r.stateId)!;
    assert.equal(state.submachine, HREF);
    assert.equal(state.parent, 'r_on');
    assert.equal(vertex(r.parent, 'v_paused'), undefined);
    assert.ok(vertex(r.machine, 'v_paused') && vertex(r.machine, 'v_choice'));
    assert.deepEqual(points(r.machine, 'entryPoint'), ['toChoice', 'toPaused']);
    assert.deepEqual(points(r.machine, 'exitPoint'), ['toFault', 'toPlaying', 'toStopped']);

    // Incoming: the outer part keeps the label and goes to the entry reference; the inner part is plain.
    const toPaused = named(r.machine, 'entryPoint', 'toPaused');
    assert.equal(transition(r.parent, 't8').target, refOf(r, toPaused.id).id);
    assert.equal(label(transition(r.parent, 't8')), 'pause||');
    assert.deepEqual(from(r.machine, toPaused.id).map((t) => [t.target, label(t)]), [['v_paused', '||']]);

    // Outgoing: the inner part keeps the label and goes to the exit point; the outer part is plain.
    const toStopped = named(r.machine, 'exitPoint', 'toStopped');
    assert.deepEqual(to(r.machine, toStopped.id).map((t) => [t.id, label(t)]), [
      ['t10', 'stop||'],
      ['t12', '|else|openTray()'],
      ['t23', 'after(5m)||saveBookmark()'],
    ]);
    assert.deepEqual(from(r.parent, refOf(r, toStopped.id).id).map((t) => [t.target, label(t)]), [['v_stopped', '||']]);
    const toFault = named(r.machine, 'exitPoint', 'toFault');
    assert.equal(label(transition(r.machine, 't13')), '|isTrayJammed()|');
    assert.deepEqual(from(r.parent, refOf(r, toFault.id).id).map((t) => t.target), ['v_fault_xp']);

    // Inside transitions move as they are.
    assert.equal(label(transition(r.machine, 't22')), 'volumeChanged||updateVolume()');
    assert.equal(transition(r.machine, 't22').kind, 'internal');
  });

  it('moves the region initial along and gives the region a new one, and uses default entry', () => {
    const r = extract(example('MediaPlayer.fsm'), ['v_init', 'v_off']);
    const initials = r.parent.vertices.filter((v) => v.type === 'initial' && v.parent === 'r_root');
    assert.equal(initials.length, 1);
    assert.deepEqual(from(r.parent, initials[0].id).map((t) => t.target), [r.stateId]);
    assert.equal(transition(r.parent, 't3').target, r.stateId, 'powerOff goes to the submachine state itself');
    assert.deepEqual(points(r.machine, 'entryPoint'), []);
    assert.deepEqual(points(r.machine, 'exitPoint'), ['toFinal', 'toOn']);
    assert.deepEqual(from(r.machine, 'v_init').map((t) => t.target), ['v_off']);
  });

  it('turns a composite state with one region into the submachine state', () => {
    const r = extract(mediaPlayerWithoutHistory(), ['v_on']);
    assert.equal(r.stateId, 'v_on');
    const on = vertex(r.parent, 'v_on')!;
    assert.deepEqual([on.name, on.submachine, on.regions], ['On', HREF, []]);
    assert.deepEqual([transition(r.parent, 't2').target, transition(r.parent, 't3').source], ['v_on', 'v_on']);
    // Its own exit point becomes the new machine's, with a reference of the same id in its place.
    const ref = vertex(r.parent, 'v_fault_xp')!;
    assert.deepEqual([ref.type, ref.parent, ref.ref, ref.pointKind], ['connectionPointRef', 'v_on', 'v_fault_xp', 'exit']);
    assert.equal(transition(r.parent, 't14').source, 'v_fault_xp');
    const point = vertex(r.machine, 'v_fault_xp')!;
    assert.deepEqual([point.type, point.parent, point.name], ['exitPoint', 'r_on', 'fault']);
    assert.deepEqual(r.machine.regions.map((g) => g.id), ['r_on']);
    assert.ok(vertex(r.machine, 'v_playing')?.regions?.length === 2);
  });

  it('moves a composite state with several regions whole', () => {
    const r = extract(example('MediaPlayer.fsm'), ['v_playing'], 'Playing');
    assert.notEqual(r.stateId, 'v_playing');
    assert.equal(vertex(r.parent, r.stateId)!.name, 'Playing');
    assert.deepEqual(vertex(r.machine, 'v_playing')!.regions!.map((g) => g.id), ['r_audio', 'r_video']);
    assert.deepEqual(points(r.machine, 'entryPoint'), ['toPlaying']);
    assert.deepEqual(points(r.machine, 'exitPoint'), ['toPaused']);
  });

  it('keeps submachine states and their references inside the extracted part', () => {
    const r = extract(example('Order.fsm'), ['o_cart', 'o_pay']);
    const pay = vertex(r.machine, 'o_pay')!;
    assert.equal(pay.submachine, 'Payment.fsm#sm');
    assert.deepEqual(r.machine.vertices.filter((v) => v.parent === 'o_pay').map((v) => v.id).sort(), ['o_ref_cancel', 'o_ref_failed', 'o_ref_retry']);
    // retryPayment came from outside to the entry reference 'retry': it now goes through an entry point.
    const entry = named(r.machine, 'entryPoint', 'toPayment');
    assert.deepEqual(from(r.machine, entry.id).map((t) => t.target), ['o_ref_retry']);
    assert.equal(transition(r.parent, 'ot5').target, refOf(r, entry.id).id);
  });

  it('re-anchors outside comments to the submachine state and keeps groups among the extracted elements', () => {
    const m = example('MediaPlayer.fsm');
    vertex(m, 'v_note')!.anchors = ['v_hist', 'v_paused', 't22'];
    vertex(m, 'v_paused')!.group = 'g1';
    vertex(m, 'v_choice')!.group = 'g1';
    const r = extract(m, ['v_paused']); // the group brings the choice along
    assert.ok(vertex(r.machine, 'v_choice'));
    assert.deepEqual(vertex(r.parent, 'v_note')!.anchors, ['v_hist', r.stateId]);
    assert.deepEqual([vertex(r.machine, 'v_paused')!.group, vertex(r.machine, 'v_choice')!.group], ['g1', 'g1']);
  });

  it('uses default entry only when the initial transition has no guard or effect', () => {
    for (const effect of ['', 'log()']) {
      const b = new ModelBuilder('M');
      b.state('O');
      b.state('S', 'r_root', {}, 1);
      b.state('X', 'S_r0');
      b.init('O');
      b.t(b.vertex('initial', 'S_r0'), 'X', { effect });
      b.t('O', 'X', { triggers: ['e'] });
      const r = extract(b.model, ['S']);
      const e = r.parent.transitions.find((t) => t.triggers[0] === 'e')!;
      if (effect) assert.equal(vertex(r.parent, e.target)!.type, 'connectionPointRef');
      else assert.equal(e.target, 'S');
    }
  });

  it('proposes the name of the extracted state', () => {
    const m = example('MediaPlayer.fsm');
    assert.equal(proposedName(m, ['v_playing']), 'Playing');
    assert.equal(proposedName(m, ['v_paused', 'v_choice']), 'Paused');
    assert.equal(proposedName(m, ['v_paused', 'v_stopped']), 'Submachine');
  });

  it('refuses what a submachine cannot express', () => {
    const refused = (m: FsmModel, ids: string[], message: RegExp) =>
      assert.throws(() => extractSubmachine(m, ids, 'Sub', HREF), (e: unknown) => e instanceof ExtractError && message.test(e.message));
    const m = example('MediaPlayer.fsm');
    refused(m, ['v_on'], /history pseudostate across the boundary/);
    refused(m, ['v_fault_xp'], /Points on a state's border can't be extracted without their state \('fault'\)/);
    refused(m, ['v_note'], /Select the states and pseudostates to extract/);
    refused(m, ['v_off', 'v_paused'], /Select elements of one region/);
    refused(m, [], /Select the states and pseudostates to extract/);

    const b = new ModelBuilder('M');
    b.state('S', 'r_root', {}, 1);
    b.state('X', 'S_r0');
    b.state('Y', 'S_r0');
    b.init('S');
    b.init('X', 'S_r0');
    b.t('S', 'Y', { kind: 'local', triggers: ['e'] });
    refused(b.model, ['Y'], /Make the transition from 'S' to 'Y' external first/);
  });
});

/** One step of a scenario: an event, condition values, or firing the pending timers. */
type Step = string | Record<string, boolean> | { fire: true };

/**
 * Runs `steps` on machine `main` of `machines` and returns the calls it made, without the `Submachine.`
 * prefixes (which name the machine the action belongs to), and whether it finished.
 */
async function run(machines: Record<string, FsmModel>, main: string, steps: Step[]): Promise<string[]> {
  const classes = await load(machines);
  const rec = recorder();
  const clock = new FakeClock();
  const m = new classes[main](rec.actions, { clock });
  const log: string[] = [];
  const take = (step: string) => log.push(`-- ${step}`, ...rec.take().map((c) => c.replace(/^(\w+\.)+/, '')));
  m.start();
  take('start');
  for (const s of steps) {
    if (typeof s === 'string') m.dispatch(s);
    else if ('fire' in s) clock.fire();
    else Object.assign(rec.conditions, s);
    take(JSON.stringify(s));
  }
  log.push(`finished: ${m.isFinished}`);
  return log;
}

/** Checks that extracting `ids` from machine `file` doesn't change the calls `steps` make. */
async function sameBehavior(file: string, model: FsmModel, ids: string[], steps: Step[], others: Record<string, FsmModel> = {}) {
  const main = model.name;
  const before = await run({ [file]: model, ...others }, main, steps);
  const r = extract(model, ids);
  const after = await run({ [file]: r.parent, 'Sub.fsm': r.machine, ...others }, main, steps);
  assert.deepEqual(after, before);
  assert.ok(before.length > steps.length + 3, 'the scenario calls actions');
}

const MEDIA_PLAYER: Step[] = [
  'powerOn', 'play', 'toggleAudio', 'lowBandwidth', 'pause', 'volumeChanged', 'play', 'pause', { fire: true },
  'eject', { isTrayJammed: true }, 'eject', 'reset', 'play', 'stop', 'powerOff', 'powerOn', 'powerOff', 'unplug',
];
const MEDIA_PLAYER_WITHOUT_HISTORY = MEDIA_PLAYER.filter((s) => s !== 'reset');
const ORDER: Step[] = ['checkout', 'declined', 'declined', 'declined', 'retryPayment', 'approved', 'delivered'];

describe('extract to submachine: generated code behaves the same', () => {
  it('MediaPlayer: Paused and the choice', () => sameBehavior('MediaPlayer.fsm', mediaPlayerWithoutHistory(), ['v_paused', 'v_choice'], MEDIA_PLAYER_WITHOUT_HISTORY));
  it('MediaPlayer: the initial and Off', () => sameBehavior('MediaPlayer.fsm', example('MediaPlayer.fsm'), ['v_init', 'v_off'], MEDIA_PLAYER));
  it('MediaPlayer: On', () => sameBehavior('MediaPlayer.fsm', mediaPlayerWithoutHistory(), ['v_on'], MEDIA_PLAYER_WITHOUT_HISTORY));
  it('MediaPlayer: Playing, with two regions', () => sameBehavior('MediaPlayer.fsm', example('MediaPlayer.fsm'), ['v_playing'], MEDIA_PLAYER));
  it('Order: Cart and the Payment submachine state', () =>
    sameBehavior('Order.fsm', example('Order.fsm'), ['o_cart', 'o_pay'], ORDER, { 'Payment.fsm': example('Payment.fsm') }));

  it('default entry, with and without an effect on the initial transition', async () => {
    for (const effect of ['', 'log()']) {
      const b = new ModelBuilder('M');
      b.state('O', 'r_root', { entry: 'enterO()' });
      b.state('S', 'r_root', { entry: 'enterS()', exit: 'exitS()' }, 1);
      b.state('X', 'S_r0', { entry: 'enterX()' });
      b.state('Y', 'S_r0', { entry: 'enterY()' });
      b.init('O');
      b.t(b.vertex('initial', 'S_r0'), 'X', { effect });
      b.t('O', 'X', { triggers: ['toX'] });
      b.t('O', 'Y', { triggers: ['toY'], effect: 'go()' });
      b.t('O', 'S', { triggers: ['toS'] });
      b.t('X', 'Y', { triggers: ['next'] });
      b.t('Y', 'O', { triggers: ['back'], guard: 'ok()' });
      await sameBehavior('M.fsm', b.model, ['S'], ['toX', 'next', 'back', { ok: true }, 'back', 'toY', 'back', 'toS', 'next', 'back']);
    }
  });
});
