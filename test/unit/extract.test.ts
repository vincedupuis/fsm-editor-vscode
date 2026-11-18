import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ExtractError, ExtractResult, extractSubmachine, proposedName } from '../../src/extract';
import { FsmModel, Transition, Vertex, machineConnectionPoints } from '../../src/model';
import { readMachine, validate, writeMachine } from '../../src/common';
import { FakeClock, ModelBuilder, load, recorder, root } from './harness';

/** An example machine, as the editor reads it (its ids are derived from the names). */
function example(name: string): FsmModel {
  const read = readMachine(readFileSync(join(root, 'examples', name), 'utf8'), readFileSync(join(root, 'examples', `${name}.layout`), 'utf8'));
  if ('problems' in read) throw new Error(JSON.stringify(read.problems));
  return read.model;
}
/** A model written and read back, as saving and opening the files do. */
function roundTrip(model: FsmModel): FsmModel {
  const w = writeMachine(JSON.parse(JSON.stringify(model)) as FsmModel);
  const read = readMachine(w.modelText, w.layoutText);
  if ('problems' in read) throw new Error(JSON.stringify(read.problems));
  return read.model;
}
const HREF = 'Sub.fsm';

/** Extracts `ids` of `model` into machine `Sub`, checking that both machines are valid and survive saving and reading. */
function extract(model: FsmModel, ids: string[], name = 'Sub'): ExtractResult {
  const before = JSON.stringify(model);
  const r = extractSubmachine(model, ids, name, `${name}.fsm`);
  assert.equal(JSON.stringify(model), before, 'the model is left unchanged');
  const info = { [`${name}.fsm`]: { found: true, name, points: machineConnectionPoints(r.machine) } };
  assert.deepEqual(validate(r.parent, info), [], 'the edited machine is valid');
  assert.deepEqual(validate(r.machine), [], 'the new machine is valid');
  for (const m of [r.parent, r.machine]) assert.deepEqual(essentials(roundTrip(m)), essentials(roundTrip(roundTrip(m))), 'saved and read');
  return r;
}

/** What a model says, without layout or element order. */
function essentials(m: FsmModel) {
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return {
    name: m.name,
    regions: m.regions.map((r) => r.id),
    vertices: [...m.vertices].sort(byId).map((v) => [v.id, v.type, v.name, v.parent, v.submachine, v.ref, v.pointKind, v.group, v.anchors, v.regions?.map((r) => r.id)]),
    transitions: [...m.transitions].sort(byId).map((t) => [t.id, t.source, t.target, t.kind, t.triggers, t.guard, t.action]),
  };
}

const vertex = (m: FsmModel, id: string) => m.vertices.find((v) => v.id === id);
const transition = (m: FsmModel, id: string) => m.transitions.find((t) => t.id === id)!;
const named = (m: FsmModel, type: Vertex['type'], name: string) => m.vertices.find((v) => v.type === type && v.name === name)!;
const points = (m: FsmModel, type: 'entryPoint' | 'exitPoint') => m.vertices.filter((v) => v.type === type).map((v) => v.name).sort();
const label = (t: Transition) => [t.triggers.join(','), t.guard, t.action].join('|');
const from = (m: FsmModel, source: string) => m.transitions.filter((t) => t.source === source);
const to = (m: FsmModel, target: string) => m.transitions.filter((t) => t.target === target);
/** The reference on the submachine state for the new machine's point `pointId` (references name their points). */
const refOf = (r: ExtractResult, pointId: string) => {
  const name = r.machine.vertices.find((p) => p.id === pointId)!.name;
  return r.parent.vertices.find((v) => v.type === 'connectionPointRef' && v.ref === name)!;
};

/** MediaPlayer without its deep history, so that On can be extracted. */
function mediaPlayerWithoutHistory(): FsmModel {
  const m = example('MediaPlayer.fsm');
  m.vertices = m.vertices.filter((v) => v.id !== 'On.deepHistory');
  m.transitions = m.transitions.filter((t) => t.source !== 'On.deepHistory' && t.target !== 'On.deepHistory');
  for (const v of m.vertices) if (v.anchors) v.anchors = v.anchors.filter((a) => a !== 'On.deepHistory');
  return m;
}

describe('extract to submachine: models', () => {
  it('splits crossing transitions, keeping trigger, guard and effect on the source side', () => {
    const r = extract(example('MediaPlayer.fsm'), ['Paused', 'choice1*']);
    const state = vertex(r.parent, r.stateId)!;
    assert.equal(state.submachine, HREF);
    assert.equal(state.parent, 'On.');
    assert.equal(vertex(r.parent, 'Paused'), undefined);
    assert.ok(vertex(r.machine, 'Paused') && vertex(r.machine, 'choice1*'));
    assert.deepEqual(points(r.machine, 'entryPoint'), ['toChoice', 'toPaused']);
    assert.deepEqual(points(r.machine, 'exitPoint'), ['toFault', 'toPlaying', 'toStopped']);

    // Incoming: the outer part keeps the label and goes to the entry reference; the inner part is plain.
    const toPaused = named(r.machine, 'entryPoint', 'toPaused');
    assert.equal(transition(r.parent, 'Playing#1').target, refOf(r, toPaused.id).id);
    assert.equal(label(transition(r.parent, 'Playing#1')), 'pause||');
    assert.deepEqual(from(r.machine, toPaused.id).map((t) => [t.target, label(t)]), [['Paused', '||']]);

    // Outgoing: the inner part keeps the label and goes to the exit point; the outer part is plain.
    const toStopped = named(r.machine, 'exitPoint', 'toStopped');
    // In the file's order: the transitions of each source, the sources in document order.
    assert.deepEqual(to(r.machine, toStopped.id).map((t) => [t.id, label(t)]), [
      ['Paused#2', 'stop||'],
      ['Paused#4', 'after(5m)||saveBookmark()'],
      ['choice1*#1', '|else|openTray()'],
    ]);
    assert.deepEqual(from(r.parent, refOf(r, toStopped.id).id).map((t) => [t.target, label(t)]), [['Stopped', '||']]);
    const toFault = named(r.machine, 'exitPoint', 'toFault');
    assert.equal(label(transition(r.machine, 'choice1*#2')), '|isTrayJammed()|');
    assert.deepEqual(from(r.parent, refOf(r, toFault.id).id).map((t) => t.target), ['On.fault']);

    // Inside transitions move as they are.
    assert.equal(label(transition(r.machine, 'Paused#3')), 'volumeChanged||updateVolume()');
    assert.equal(transition(r.machine, 'Paused#3').kind, 'internal');
  });

  it('moves the region initial along and gives the region a new one, and uses default entry', () => {
    const r = extract(example('MediaPlayer.fsm'), ['MediaPlayer.initial', 'Off']);
    const initials = r.parent.vertices.filter((v) => v.type === 'initial' && v.parent === 'MediaPlayer.');
    assert.equal(initials.length, 1);
    assert.deepEqual(from(r.parent, initials[0].id).map((t) => t.target), [r.stateId]);
    assert.equal(transition(r.parent, 'On#1').target, r.stateId, 'powerOff goes to the submachine state itself');
    assert.deepEqual(points(r.machine, 'entryPoint'), []);
    assert.deepEqual(points(r.machine, 'exitPoint'), ['toFinal', 'toOn']);
    assert.deepEqual(from(r.machine, 'MediaPlayer.initial').map((t) => t.target), ['Off']);
  });

  it('turns a composite state with one region into the submachine state', () => {
    const r = extract(mediaPlayerWithoutHistory(), ['On']);
    assert.equal(r.stateId, 'On');
    const on = vertex(r.parent, 'On')!;
    assert.deepEqual([on.name, on.submachine, on.regions], ['On', HREF, []]);
    assert.deepEqual([transition(r.parent, 'Off#1').target, transition(r.parent, 'On#1').source], ['On', 'On']);
    // Its own exit point becomes the new machine's, with a reference to it by name in its place.
    const ref = vertex(r.parent, 'On.fault')!;
    assert.deepEqual([ref.type, ref.parent, ref.ref, ref.pointKind], ['connectionPointRef', 'On', 'fault', 'exit']);
    assert.equal(transition(r.parent, 'On.fault#1').source, 'On.fault');
    const point = vertex(r.machine, 'On.fault')!;
    assert.deepEqual([point.type, point.parent, point.name], ['exitPoint', 'On.', 'fault']);
    assert.deepEqual(r.machine.regions.map((g) => g.id), ['On.']);
    assert.ok(vertex(r.machine, 'Playing')?.regions?.length === 2);
  });

  it('moves a composite state with several regions whole', () => {
    // Its name stays in the new machine, which can't have it too.
    assert.equal(proposedName(example('MediaPlayer.fsm'), ['Playing']), 'PlayingMachine');
    const r = extract(example('MediaPlayer.fsm'), ['Playing'], 'PlayingMachine');
    assert.notEqual(r.stateId, 'Playing');
    assert.equal(vertex(r.parent, r.stateId)!.name, 'PlayingMachine');
    assert.deepEqual(vertex(r.machine, 'Playing')!.regions!.map((g) => g.id), ['audio', 'video']);
    assert.deepEqual(points(r.machine, 'entryPoint'), ['toPlaying']);
    assert.deepEqual(points(r.machine, 'exitPoint'), ['toPaused']);
  });

  it('keeps submachine states and their references inside the extracted part', () => {
    const r = extract(example('Order.fsm'), ['Cart', 'Payment']);
    const pay = vertex(r.machine, 'Payment')!;
    assert.equal(pay.submachine, 'Payment.fsm');
    assert.deepEqual(r.machine.vertices.filter((v) => v.parent === 'Payment').map((v) => v.id).sort(), ['Payment.cancelled', 'Payment.failed', 'Payment.retry']);
    // retryPayment came from outside to the entry reference 'retry': it now goes through an entry point.
    const entry = named(r.machine, 'entryPoint', 'toPayment');
    assert.deepEqual(from(r.machine, entry.id).map((t) => t.target), ['Payment.retry']);
    assert.equal(transition(r.parent, 'PaymentFailed#1').target, refOf(r, entry.id).id);
  });

  it('re-anchors outside comments to the submachine state and keeps groups among the extracted elements', () => {
    const m = example('MediaPlayer.fsm');
    vertex(m, 'comment1*')!.anchors = ['On.deepHistory', 'Paused', 'Paused#3'];
    vertex(m, 'Paused')!.group = 'g1';
    vertex(m, 'choice1*')!.group = 'g1';
    const r = extract(m, ['Paused']); // the group brings the choice along
    assert.ok(vertex(r.machine, 'choice1*'));
    assert.deepEqual(vertex(r.parent, 'comment1*')!.anchors, ['On.deepHistory', r.stateId]);
    assert.deepEqual([vertex(r.machine, 'Paused')!.group, vertex(r.machine, 'choice1*')!.group], ['g1', 'g1']);
  });

  it('uses default entry only when the initial transition has no guard or effect', () => {
    for (const effect of ['', 'log()']) {
      const b = new ModelBuilder('M');
      b.state('O');
      b.state('S', 'r_root', {}, 1);
      b.state('X', 'S_r0');
      b.init('O');
      b.t(b.vertex('initial', 'S_r0'), 'X', { action: effect });
      b.t('O', 'X', { triggers: ['e'] });
      const r = extract(b.model, ['S']);
      const e = r.parent.transitions.find((t) => t.triggers[0] === 'e')!;
      if (effect) assert.equal(vertex(r.parent, e.target)!.type, 'connectionPointRef');
      else assert.equal(e.target, 'S');
    }
  });

  it('proposes the name of the extracted state', () => {
    const m = example('MediaPlayer.fsm');
    assert.equal(proposedName(m, ['Playing']), 'PlayingMachine');
    assert.equal(proposedName(m, ['Paused', 'choice1*']), 'PausedMachine');
    assert.equal(proposedName(m, ['Paused', 'Stopped']), 'Submachine');
  });

  it('refuses what a submachine cannot express', () => {
    const refused = (m: FsmModel, ids: string[], message: RegExp) =>
      assert.throws(() => extractSubmachine(m, ids, 'Sub', HREF), (e: unknown) => e instanceof ExtractError && message.test(e.message));
    const m = example('MediaPlayer.fsm');
    refused(m, ['On'], /history pseudostate across the boundary/);
    refused(m, ['On.fault'], /Points on a state's border can't be extracted without their state \('fault'\)/);
    refused(m, ['comment1*'], /Select the states and pseudostates to extract/);
    refused(m, ['Off', 'Paused'], /Select elements of one region/);
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
  it('MediaPlayer: Paused and the choice', () => sameBehavior('MediaPlayer.fsm', mediaPlayerWithoutHistory(), ['Paused', 'choice1*'], MEDIA_PLAYER_WITHOUT_HISTORY));
  it('MediaPlayer: the initial and Off', () => sameBehavior('MediaPlayer.fsm', example('MediaPlayer.fsm'), ['MediaPlayer.initial', 'Off'], MEDIA_PLAYER));
  it('MediaPlayer: On', () => sameBehavior('MediaPlayer.fsm', mediaPlayerWithoutHistory(), ['On'], MEDIA_PLAYER_WITHOUT_HISTORY));
  it('MediaPlayer: Playing, with two regions', () => sameBehavior('MediaPlayer.fsm', example('MediaPlayer.fsm'), ['Playing'], MEDIA_PLAYER));
  it('Order: Cart and the Payment submachine state', () =>
    sameBehavior('Order.fsm', example('Order.fsm'), ['Cart', 'Payment'], ORDER, { 'Payment.fsm': example('Payment.fsm') }));

  it('default entry, with and without an effect on the initial transition', async () => {
    for (const effect of ['', 'log()']) {
      const b = new ModelBuilder('M');
      b.state('O', 'r_root', { entry: 'enterO()' });
      b.state('S', 'r_root', { entry: 'enterS()', exit: 'exitS()' }, 1);
      b.state('X', 'S_r0', { entry: 'enterX()' });
      b.state('Y', 'S_r0', { entry: 'enterY()' });
      b.init('O');
      b.t(b.vertex('initial', 'S_r0'), 'X', { action: effect });
      b.t('O', 'X', { triggers: ['toX'] });
      b.t('O', 'Y', { triggers: ['toY'], action: 'go()' });
      b.t('O', 'S', { triggers: ['toS'] });
      b.t('X', 'Y', { triggers: ['next'] });
      b.t('Y', 'O', { triggers: ['back'], guard: 'ok()' });
      await sameBehavior('M.fsm', b.model, ['S'], ['toX', 'next', 'back', { ok: true }, 'back', 'toY', 'back', 'toS', 'next', 'back']);
    }
  });
});

describe('Extract to Submachine: ids used twice', () => {
  it('names the exit point of a transition to a reference whose parent id is its own without recursing forever', () => {
    const b = new ModelBuilder('M');
    b.state('A');
    b.init('A');
    b.vertex('connectionPointRef', 'p', { id: 'p', pointKind: 'entry', ref: 'x' });
    b.t('A', 'p', { triggers: ['e'] });
    const r = extractSubmachine(b.model, ['A'], 'Sub', HREF);
    assert.deepEqual(r.machine.vertices.filter((v) => v.type === 'exitPoint').map((v) => v.name), ['toPoint']);
  });
});
