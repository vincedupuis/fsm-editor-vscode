import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as expr from '../../media/expressions';
import { printCondition } from '../../src/codegen/helpers';
import { LANGUAGES } from '../../src/codegen/languages';
import { parseFrontMatter, parseTemplate, render } from '../../src/codegen/render';
import { toCodeModel } from '../../src/codegen/codeModel';
import { fromXmi } from '../../src/xmi';
import { FakeClock, ModelBuilder, load, recorder, root } from './harness';

const example = (name: string) => readFileSync(join(root, 'examples', name), 'utf8');

describe('examples', () => {
  it('MediaPlayer: hierarchy, orthogonal regions, choice, exit point, deep history, timer, do activity', async () => {
    const { MediaPlayer } = await load({ 'MediaPlayer.fsm': example('MediaPlayer.fsm') });
    const rec = recorder();
    const clock = new FakeClock();
    const m = new MediaPlayer(rec.actions, { clock });
    m.start();
    assert.deepEqual(rec.take(), ['powerDown']);
    assert.deepEqual(m.activeStates, ['Off']);

    m.dispatch('powerOn');
    assert.deepEqual(rec.take(), ['ampOn', 'rewind']);
    m.dispatch('play');
    assert.deepEqual(m.activeStates, ['On', 'Playing', 'Stereo', 'HD']);
    m.dispatch('toggleAudio');
    m.dispatch('lowBandwidth');
    assert.deepEqual(m.activeStates, ['On', 'Playing', 'Mono', 'SD']);

    m.dispatch('pause');
    assert.deepEqual(rec.take(), ['startBlinkLed']);
    assert.deepEqual(clock.pending, [300000]);
    m.dispatch('volumeChanged'); // internal: no exit/entry
    assert.deepEqual(rec.take(), ['updateVolume']);
    clock.fire(); // after(5m)
    assert.deepEqual(rec.take(), ['stopBlinkLed', 'saveBookmark', 'rewind']);
    assert.deepEqual(m.activeStates, ['On', 'Stopped']);

    m.dispatch('eject'); // choice, else branch
    assert.deepEqual(rec.take(), ['isTrayJammed', 'openTray', 'rewind']);
    rec.conditions.isTrayJammed = true;
    m.dispatch('eject'); // choice to the exit point 'fault'
    assert.deepEqual(rec.take(), ['isTrayJammed', 'ampOff', 'showError']);
    assert.deepEqual(m.activeStates, ['Fault']);
    m.dispatch('reset'); // deep history
    assert.deepEqual(rec.take(), ['ampOn', 'rewind']);
    assert.deepEqual(m.activeStates, ['On', 'Stopped']);

    m.dispatch('powerOff');
    assert.deepEqual(rec.take(), ['ampOff', 'powerDown']);
    m.dispatch('unplug');
    assert.equal(m.isFinished, true);
  });

  it('Order and Payment: submachine with entry and exit point references', async () => {
    const { Order } = await load({ 'Order.fsm': example('Order.fsm'), 'Payment.fsm': example('Payment.fsm') });
    const rec = recorder();
    const order = new Order(rec.actions);
    order.start();
    order.dispatch('checkout');
    assert.deepEqual(rec.take(), ['Payment.requestAuthorization']);
    assert.ok(order.isIn('Payment'));

    order.dispatch('declined'); // Declined completes, leaves through 'failed'
    assert.deepEqual(rec.take(), ['notifyCustomer']);
    assert.deepEqual(order.activeStates, ['PaymentFailed']);

    order.dispatch('retryPayment'); // enters through 'retry'
    assert.deepEqual(rec.take(), ['Payment.resetAttempt', 'Payment.requestAuthorization']);
    order.dispatch('approved'); // Payment finishes, Order completes Payment then Shipped
    assert.deepEqual(rec.take(), ['Payment.capture', 'ship']);
    assert.equal(order.isFinished, true);

    const again = new Order(rec.actions);
    again.start();
    again.dispatch('checkout');
    again.dispatch('cancel');
    assert.deepEqual(again.activeStates, ['Cart']);
  });

  it('code model of MediaPlayer', () => {
    const cm = toCodeModel(fromXmi(example('MediaPlayer.fsm')));
    assert.equal(cm.machine.name, 'MediaPlayer');
    assert.deepEqual(cm.timers.map((t) => [t.name, t.ms]), [['Paused_after_5m', 300000]]);
    assert.deepEqual(cm.activities, ['blinkLed']);
    assert.ok(cm.features.history && cm.features.choices && cm.features.timers);
    const eject = cm.transitions.find((t) => t.label === 'Stopped -> choice (eject)')!;
    assert.deepEqual(
      eject.steps.map((s) => s.kind),
      ['exit', 'choice'],
    );
  });
});

describe('semantics', () => {
  it('fork, orthogonal regions and join', async () => {
    const b = new ModelBuilder('Forks');
    const idle = b.state('Idle');
    const p = b.state('P', 'r_root', { entry: 'enterP()', exit: 'exitP()' }, 2);
    const a1 = b.state('A1', 'P_r0');
    const a2 = b.state('A2', 'P_r0', { entry: 'a2()' });
    const b1 = b.state('B1', 'P_r1');
    const b2 = b.state('B2', 'P_r1', { entry: 'b2()' });
    const done = b.state('Done', 'r_root', { entry: 'done()' });
    const fork = b.vertex('fork');
    const join = b.vertex('join');
    b.init(idle);
    b.t(idle, fork, { triggers: ['go'] });
    b.t(fork, a1, { effect: 'toA()' });
    b.t(fork, b1, { effect: 'toB()' });
    b.t(a1, a2, { triggers: ['a'] });
    b.t(b1, b2, { triggers: ['b'] });
    b.t(a2, join);
    b.t(b2, join);
    b.t(join, done);
    void p;
    const { Forks } = await load({ 'Forks.fsm': b.model });
    const rec = recorder();
    const m = new Forks(rec.actions);
    m.start();
    m.dispatch('go');
    assert.deepEqual(rec.take(), ['toA', 'toB', 'enterP']);
    assert.deepEqual(m.activeStates, ['P', 'A1', 'B1']);
    m.dispatch('a');
    assert.deepEqual(m.activeStates, ['P', 'A2', 'B1']);
    m.dispatch('b');
    assert.deepEqual(rec.take(), ['a2', 'b2', 'exitP', 'done']);
    assert.deepEqual(m.activeStates, ['Done']);
  });

  it('inner transitions take priority, and orthogonal regions both react', async () => {
    const b = new ModelBuilder('Priority');
    const p = b.state('P', 'r_root', {}, 2);
    const x = b.state('X', 'P_r0');
    const x2 = b.state('X2', 'P_r0');
    const y = b.state('Y', 'P_r1');
    const y2 = b.state('Y2', 'P_r1');
    const out = b.state('Out');
    b.init(p);
    b.init(x, 'P_r0');
    b.init(y, 'P_r1');
    b.t(p, out, { triggers: ['e'] });
    b.t(x, x2, { triggers: ['e'], effect: 'fx()' });
    b.t(y, y2, { triggers: ['e'], effect: 'fy()' });
    b.t(x2, out, { triggers: ['f'] });
    const { Priority } = await load({ 'Priority.fsm': b.model });
    const rec = recorder();
    const m = new Priority(rec.actions);
    m.start();
    m.dispatch('e');
    assert.deepEqual(rec.take(), ['fx', 'fy']);
    assert.deepEqual(m.activeStates, ['P', 'X2', 'Y2']);
    m.dispatch('e'); // no substate reacts: P's own transition fires
    assert.deepEqual(m.activeStates, ['Out']);
  });

  it('deferred events are replayed after a state change', async () => {
    const b = new ModelBuilder('Defer');
    const busy = b.state('Busy', 'r_root', { deferrable: ['req'] });
    const idle = b.state('Idle');
    const handling = b.state('Handling', 'r_root', { entry: 'handle()' });
    b.init(busy);
    b.t(busy, idle, { triggers: ['done'] });
    b.t(idle, handling, { triggers: ['req'] });
    const { Defer } = await load({ 'Defer.fsm': b.model });
    const rec = recorder();
    const m = new Defer(rec.actions);
    m.start();
    m.dispatch('req');
    assert.deepEqual(m.activeStates, ['Busy']);
    m.dispatch('done');
    assert.deepEqual(rec.take(), ['handle']);
    assert.deepEqual(m.activeStates, ['Handling']);
  });

  it('junctions are static: the transition only fires when a whole path is enabled', async () => {
    const b = new ModelBuilder('Junctions');
    const s = b.state('S', 'r_root', { exit: 'leaveS()' });
    const x = b.state('X');
    const y = b.state('Y');
    const j = b.vertex('junction');
    b.init(s);
    b.t(s, j, { triggers: ['e'], guard: 'g()' });
    b.t(j, x, { guard: 'c()' });
    b.t(j, y, { guard: 'else', effect: 'toY()' });
    const { Junctions } = await load({ 'Junctions.fsm': b.model });
    const rec = recorder();
    const m = new Junctions(rec.actions);
    m.start();
    m.dispatch('e'); // g() is false: nothing happens, S is not left
    assert.deepEqual(rec.take(), ['g', 'g']);
    assert.deepEqual(m.activeStates, ['S']);
    rec.conditions.g = true;
    m.dispatch('e');
    assert.deepEqual(rec.take(), ['g', 'c', 'g', 'c', 'leaveS', 'toY']);
    assert.deepEqual(m.activeStates, ['Y']);
  });

  it('local transitions do not leave their composite state; external ones do', async () => {
    const b = new ModelBuilder('Local');
    const c = b.state('C', 'r_root', { entry: 'enterC()', exit: 'exitC()' }, 1);
    const c1 = b.state('C1', 'C_r0', { exit: 'exitC1()' });
    const c2 = b.state('C2', 'C_r0', { entry: 'enterC2()' });
    b.init(c);
    b.init(c1, 'C_r0');
    b.t(c, c2, { triggers: ['local'], kind: 'local' });
    b.t(c, c1, { triggers: ['external'] });
    const { Local } = await load({ 'Local.fsm': b.model });
    const rec = recorder();
    const m = new Local(rec.actions);
    m.start();
    rec.take();
    m.dispatch('local');
    assert.deepEqual(rec.take(), ['exitC1', 'enterC2']);
    m.dispatch('external');
    assert.deepEqual(rec.take(), ['exitC', 'enterC']);
    assert.deepEqual(m.activeStates, ['C', 'C1']);
  });

  it('shallow history restores one level, deep history every level', async () => {
    for (const kind of ['shallowHistory', 'deepHistory'] as const) {
      const b = new ModelBuilder('History');
      const c = b.state('C', 'r_root', {}, 1);
      const d = b.state('D', 'C_r0', {}, 1);
      const d1 = b.state('D1', 'D_r0');
      const d2 = b.state('D2', 'D_r0');
      const out = b.state('Out');
      const h = b.vertex(kind, 'C_r0');
      b.init(c);
      b.init(d, 'C_r0');
      b.init(d1, 'D_r0');
      b.t(d1, d2, { triggers: ['next'] });
      b.t(c, out, { triggers: ['leave'] });
      b.t(out, h, { triggers: ['back'] });
      const { History } = await load({ 'History.fsm': b.model });
      const m = new History(recorder().actions);
      m.start();
      m.dispatch('next');
      m.dispatch('leave');
      m.dispatch('back');
      assert.deepEqual(m.activeStates, kind === 'deepHistory' ? ['C', 'D', 'D2'] : ['C', 'D', 'D1'], kind);
    }
  });

  it('entry and exit points of a composite state', async () => {
    const b = new ModelBuilder('Points');
    const a = b.state('A');
    const c = b.state('C', 'r_root', { entry: 'enterC()', exit: 'exitC()' }, 1);
    const inner = b.state('Inner', 'C_r0', { entry: 'inner()' });
    const other = b.state('Other', 'C_r0');
    const after = b.state('After');
    const ep = b.vertex('entryPoint', c, { name: 'in' });
    const xp = b.vertex('exitPoint', c, { name: 'out' });
    b.init(a);
    b.init(other, 'C_r0');
    b.t(a, ep, { triggers: ['go'] });
    b.t(ep, inner, { effect: 'viaIn()' });
    b.t(inner, xp, { triggers: ['quit'] });
    b.t(xp, after, { effect: 'viaOut()' });
    const { Points } = await load({ 'Points.fsm': b.model });
    const rec = recorder();
    const m = new Points(rec.actions);
    m.start();
    m.dispatch('go');
    assert.deepEqual(rec.take(), ['enterC', 'viaIn', 'inner']);
    assert.deepEqual(m.activeStates, ['C', 'Inner']);
    m.dispatch('quit');
    assert.deepEqual(rec.take(), ['exitC', 'viaOut']);
    assert.deepEqual(m.activeStates, ['After']);
  });

  it('self transitions leave and re-enter; internal transitions do not', async () => {
    const b = new ModelBuilder('Self');
    const s = b.state('S', 'r_root', { entry: 'in()', exit: 'out()' });
    b.init(s);
    b.t(s, s, { triggers: ['self'], effect: 'fx()' });
    b.t(s, s, { triggers: ['internal'], kind: 'internal', effect: 'fx()' });
    const { Self } = await load({ 'Self.fsm': b.model });
    const rec = recorder();
    const m = new Self(rec.actions);
    m.start();
    rec.take();
    m.dispatch('self');
    assert.deepEqual(rec.take(), ['out', 'fx', 'in_']); // `in` is a TypeScript keyword: the id helper escapes it
    m.dispatch('internal');
    assert.deepEqual(rec.take(), ['fx']);
  });

  it('terminate stops the machine', async () => {
    const b = new ModelBuilder('Term');
    const s = b.state('S');
    const t = b.vertex('terminate');
    b.init(s);
    b.t(s, t, { triggers: ['kill'] });
    b.t(s, s, { triggers: ['ping'], kind: 'internal', effect: 'pong()' });
    const { Term } = await load({ 'Term.fsm': b.model });
    const rec = recorder();
    const m = new Term(rec.actions);
    m.start();
    m.dispatch('kill');
    m.dispatch('ping');
    assert.deepEqual(rec.take(), ['onTerminate']);
    assert.equal(m.isTerminated, true);
  });

  it('a choice without an enabled branch throws', async () => {
    const b = new ModelBuilder('Choice');
    const s = b.state('S');
    const x = b.state('X');
    const c = b.vertex('choice');
    b.init(s);
    b.t(s, c, { triggers: ['e'] });
    b.t(c, x, { guard: 'ok()' });
    const { Choice } = await load({ 'Choice.fsm': b.model });
    const m = new Choice(recorder().actions);
    m.start();
    assert.throws(() => m.dispatch('e'), /no branch/);
  });

  it('do activities: the state completes when they end', async () => {
    const b = new ModelBuilder('Work');
    const w = b.state('Working', 'r_root', { doActivity: 'crunch()' });
    const d = b.state('Done');
    b.init(w);
    b.t(w, d);
    const { Work } = await load({ 'Work.fsm': b.model });
    const rec = recorder();
    const m = new Work(rec.actions);
    m.start();
    assert.deepEqual(m.activeStates, ['Working']);
    m.activityDone('crunch');
    assert.deepEqual(rec.take(), ['startCrunch', 'stopCrunch']);
    assert.deepEqual(m.activeStates, ['Done']);
  });

  it('protocol machines check preconditions, postconditions and invariants', async () => {
    const b = new ModelBuilder('Door', 'protocol');
    const closed = b.state('Closed', 'r_root', { invariant: 'isClosed()' });
    const open = b.state('Open');
    b.init(closed);
    b.t(closed, open, { triggers: ['open'], precondition: 'isUnlocked()', postcondition: 'isOpen()' });
    b.t(open, closed, { triggers: ['close'] });
    const { Door } = await load({ 'Door.fsm': b.model });
    const rec = recorder({ isClosed: true });
    const m = new Door(rec.actions);
    m.start();
    rec.take();
    m.dispatch('open'); // precondition false: protocol violation, no transition
    assert.deepEqual(rec.take(), ['isUnlocked', '!precondition: Closed -> Open (open)', 'isClosed']);
    rec.conditions.isUnlocked = true;
    m.dispatch('open'); // postcondition isOpen() is false
    assert.deepEqual(rec.take(), ['isUnlocked', 'isOpen', '!postcondition: Closed -> Open (open)']);
    rec.conditions.isClosed = false;
    m.dispatch('close');
    assert.deepEqual(rec.take(), ['isClosed', '!invariant: Closed']);
  });
});

describe('templates', () => {
  it('front matter', () => {
    assert.deepEqual(parseFrontMatter('lang: cpp # comment\nguard:\n  prefix: "a_."\nkeywords: [signals, "slots"]\nlist:\n  - 1\n  - two\n'), {
      lang: 'cpp',
      guard: { prefix: 'a_.' },
      keywords: ['signals', 'slots'],
      list: [1, 'two'],
    });
  });

  it('guards follow the language and keep precedence', () => {
    const parsed = expr.parseCondition('a() && !(b() || del())');
    assert.ok(parsed.ok);
    const c = parsed.value;
    assert.equal(printCondition(c, LANGUAGES.cpp, { prefix: 'a_.' }), 'a_.a() && !(a_.b() || a_.del())');
    assert.equal(printCondition(c, LANGUAGES.python), 'self.a() and not (self.b() or self.del_())');
    assert.equal(printCondition(null, LANGUAGES.python), 'True');
  });

  it('one template writes many files', () => {
    const t = parseTemplate('---\nlang: c\n---\n{{#file (concat machine.name ".h")}}\n// {{upper machine.name}}\n{{/file}}\n{{#file "impl.c"}}\n{{#each states}}{{name}};{{/each}}\n{{/file}}\n');
    const b = new ModelBuilder('Traffic Light');
    b.init(b.state('Red'));
    const files = render(t, toCodeModel(b.model));
    assert.deepEqual(files, [
      { path: 'Traffic_Light.h', content: '// TRAFFIC_LIGHT\n' },
      { path: 'impl.c', content: 'Red;\n' },
    ]);
  });

  it('rejects file names outside the output folder', () => {
    const b = new ModelBuilder('M');
    assert.throws(() => render(parseTemplate('{{#file "../x"}}{{/file}}'), toCodeModel(b.model)), /inside the output folder/);
    assert.throws(() => render(parseTemplate('nothing'), toCodeModel(b.model)), /declares no files/);
  });
});
