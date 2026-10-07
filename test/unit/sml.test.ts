// The Boost.SML template (templates/sml.hbs): the C++ it generates for the
// examples and for a model of every feature is compiled and run against the same
// scenarios as the TypeScript template in codegen.test.ts.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FsmModel } from '../../src/model';
import { Case, build, generateSml, play, toolchain } from './cpp';
import { ModelBuilder, root } from './harness';

const example = (name: string) => readFileSync(join(root, 'examples', name), 'utf8');

// ------------------------------------------------------------------ models

function forks(): FsmModel {
  const b = new ModelBuilder('Forks');
  const idle = b.state('Idle');
  b.state('P', 'r_root', { entry: 'enterP()', exit: 'exitP()' }, 2);
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
  return b.model;
}

function priority(): FsmModel {
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
  return b.model;
}

function defer(): FsmModel {
  const b = new ModelBuilder('Defer');
  const busy = b.state('Busy', 'r_root', { deferrable: ['req'] });
  const idle = b.state('Idle');
  const handling = b.state('Handling', 'r_root', { entry: 'handle()' });
  b.init(busy);
  b.t(busy, idle, { triggers: ['done'] });
  b.t(idle, handling, { triggers: ['req'] });
  return b.model;
}

/** Deferred events wait for completion events: UML processes these first. */
function deferCompletion(): FsmModel {
  const b = new ModelBuilder('DeferCompletion');
  const s = b.state('S', 'r_root', { deferrable: ['e'] });
  const u = b.state('U');
  const v = b.state('V');
  b.init(s);
  b.t(s, u, { triggers: ['f'] });
  b.t(u, v);
  b.t(u, u, { triggers: ['e'], kind: 'internal', effect: 'tooEarly()' });
  b.t(v, v, { triggers: ['e'], kind: 'internal', effect: 'handled()' });
  return b.model;
}

function junctions(): FsmModel {
  const b = new ModelBuilder('Junctions');
  const s = b.state('S', 'r_root', { exit: 'leaveS()' });
  const x = b.state('X');
  const y = b.state('Y');
  const j = b.vertex('junction');
  b.init(s);
  b.t(s, j, { triggers: ['e'], guard: 'g()' });
  b.t(j, x, { guard: 'c()' });
  b.t(j, y, { guard: 'else', effect: 'toY()' });
  return b.model;
}

function local(): FsmModel {
  const b = new ModelBuilder('Local');
  const c = b.state('C', 'r_root', { entry: 'enterC()', exit: 'exitC()' }, 1);
  const c1 = b.state('C1', 'C_r0', { exit: 'exitC1()' });
  b.state('C2', 'C_r0', { entry: 'enterC2()' });
  b.init(c);
  b.init(c1, 'C_r0');
  b.t(c, 'C2', { triggers: ['local'], kind: 'local' });
  b.t(c, c1, { triggers: ['external'] });
  b.t(c, c, { triggers: ['reset'], kind: 'local', effect: 'resetC()' });
  return b.model;
}

function history(kind: 'shallowHistory' | 'deepHistory'): FsmModel {
  const b = new ModelBuilder(kind === 'deepHistory' ? 'DeepHistory' : 'ShallowHistory');
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
  return b.model;
}

function points(): FsmModel {
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
  return b.model;
}

/** Transitions straight into and out of nested states, across two levels. */
function nested(): FsmModel {
  const b = new ModelBuilder('Nested');
  const a = b.state('A', 'r_root', { exit: 'exitA()' });
  const c = b.state('C', 'r_root', { entry: 'enterC()', exit: 'exitC()' }, 1);
  const d = b.state('D', 'C_r0', { entry: 'enterD()', exit: 'exitD()' }, 1);
  const c0 = b.state('C0', 'C_r0');
  b.state('D0', 'D_r0');
  const deep = b.state('Deep', 'D_r0', { entry: 'enterDeep()', exit: 'exitDeep()' });
  b.init(a);
  b.init(c0, 'C_r0');
  b.init('D0', 'D_r0');
  void d;
  b.t(a, deep, { triggers: ['dive'], effect: 'diving()' });
  b.t(deep, a, { triggers: ['surface'], effect: 'surfacing()' });
  b.t(deep, c0, { triggers: ['up'], effect: 'up()' });
  return b.model;
}

function self(): FsmModel {
  const b = new ModelBuilder('Self');
  const s = b.state('S', 'r_root', { entry: 'in()', exit: 'out()' });
  b.init(s);
  b.t(s, s, { triggers: ['self'], effect: 'fx()' });
  b.t(s, s, { triggers: ['internal'], kind: 'internal', effect: 'fx()' });
  return b.model;
}

function term(): FsmModel {
  const b = new ModelBuilder('Term');
  const s = b.state('S', 'r_root', { exit: 'leaveS()' });
  const t = b.vertex('terminate');
  b.init(s);
  b.t(s, t, { triggers: ['kill'] });
  b.t(s, s, { triggers: ['ping'], kind: 'internal', effect: 'pong()' });
  return b.model;
}

function choice(): FsmModel {
  const b = new ModelBuilder('Choice');
  const s = b.state('S');
  const x = b.state('X');
  const c = b.vertex('choice');
  b.init(s);
  b.t(s, c, { triggers: ['e'] });
  b.t(c, x, { guard: 'ok()' });
  return b.model;
}

function work(): FsmModel {
  const b = new ModelBuilder('Work');
  const w = b.state('Working', 'r_root', { doActivity: 'crunch()' });
  const d = b.state('Done');
  b.init(w);
  b.t(w, d);
  return b.model;
}

function door(): FsmModel {
  const b = new ModelBuilder('Door', 'protocol');
  const closed = b.state('Closed', 'r_root', { invariant: 'isClosed()' });
  const open = b.state('Open');
  b.init(closed);
  b.t(closed, open, { triggers: ['open'], precondition: 'isUnlocked()', postcondition: 'isOpen()' });
  b.t(open, closed, { triggers: ['close'] });
  return b.model;
}

/** C++ keywords as names, a guarded completion transition, timers, final states. */
function keywords(): FsmModel {
  const b = new ModelBuilder('Keywords');
  const s = b.state('default', 'r_root', { entry: 'delete()', exit: 'new()' });
  const t = b.state('Wait');
  const f = b.vertex('final');
  b.init(s);
  b.t(s, t, { guard: 'ready()' }); // completion: lost when not ready
  b.t(s, t, { triggers: ['union'] });
  b.t(t, f, { triggers: ['after(1.5s)'], effect: 'class()' });
  return b.model;
}

/** Exits across two levels with effects in between: S in C2 in C1, through C2's exit point to C1's exit point. */
function hops(): FsmModel {
  const b = new ModelBuilder('Hops');
  const c1 = b.state('C1', 'r_root', { entry: 'enterC1()', exit: 'exitC1()' }, 1);
  const c2 = b.state('C2', 'C1_r0', { entry: 'enterC2()', exit: 'exitC2()' }, 1);
  const s = b.state('S', 'C2_r0', { exit: 'exitS()' });
  const t = b.state('T', 'r_root', { entry: 'enterT()' });
  const x2 = b.vertex('exitPoint', c2, { name: 'x2' });
  const x1 = b.vertex('exitPoint', c1, { name: 'x1' });
  b.init(c1);
  b.init(c2, 'C1_r0');
  b.init(s, 'C2_r0');
  b.t(s, x2, { triggers: ['go'], effect: 'e1()' });
  b.t(x2, x1, { effect: 'e2()' });
  b.t(x1, t, { effect: 'e3()' });
  return b.model;
}

/** Composite completion through final states, initial effects, multiple triggers, two-level entry point routing, invariant. */
function composite(): FsmModel {
  const b = new ModelBuilder('Composite');
  const idle = b.state('Idle');
  const p = b.state('P', 'r_root', { entry: 'enterP()', exit: 'exitP()', invariant: 'okP()' }, 2);
  const a = b.state('A', 'P_r0');
  const fa = b.vertex('final', 'P_r0');
  const q = b.state('Q', 'P_r1', { entry: 'enterQ()' }, 1);
  const q1 = b.state('Q1', 'Q_r0');
  const q2 = b.state('Q2', 'Q_r0', { entry: 'enterQ2()' });
  const fq = b.vertex('final', 'P_r1');
  const done = b.state('Done', 'r_root', { entry: 'done()' });
  const ep = b.vertex('entryPoint', p, { name: 'deep' });
  b.t(b.vertex('initial'), idle, { effect: 'boot()' });
  b.t(b.vertex('initial', 'P_r0'), a, { effect: 'initA()' });
  b.t(b.vertex('initial', 'P_r1'), q);
  b.t(b.vertex('initial', 'Q_r0'), q1);
  b.t(idle, p, { triggers: ['go', 'start'] });
  b.t(idle, ep, { triggers: ['jump'] });
  b.t(ep, q2, { effect: 'viaDeep()' });
  b.t(a, fa, { triggers: ['finishA'] });
  b.t(q1, q2, { triggers: ['next'] });
  b.t(q2, fq, { triggers: ['finishQ'] });
  b.t(p, done, { guard: 'canLeave()' });
  b.t(p, idle, { triggers: ['abort'] });
  return b.model;
}

function sub(): FsmModel {
  const b = new ModelBuilder('Sub');
  const s1 = b.state('S1', 'r_root', { entry: 'enterS1()' });
  const s2 = b.state('S2', 'r_root', { entry: 'enterS2()' });
  b.init(s1);
  b.t(s1, s2, { triggers: ['step'] });
  return b.model;
}

/** A submachine with a time event: its parent passes it the timers. */
function timedSub(): FsmModel {
  const b = new ModelBuilder('Sub');
  const s1 = b.state('S1', 'r_root', { entry: 'enterS1()' });
  const s2 = b.state('S2', 'r_root', { entry: 'enterS2()' });
  b.init(s1);
  b.t(s1, s2, { triggers: ['step', 'after(2s)'] });
  return b.model;
}

/** A parent without time events of its own, running a submachine that has some. */
function clocked(): FsmModel {
  const b = new ModelBuilder('Clocked');
  const s1 = b.state('Waiting', 'r_root', { entry: 'waiting()' });
  const s2 = b.state('Rung', 'r_root', { entry: 'rung()' });
  b.init(s1);
  b.t(s1, s2, { triggers: ['after(250ms)'] });
  return b.model;
}

function clockHost(): FsmModel {
  const b = new ModelBuilder('ClockHost');
  const idle = b.state('Idle');
  const run = b.state('Run', 'r_root', { submachine: 'Clocked.fsm#sm' });
  b.init(idle);
  b.t(idle, run, { triggers: ['go'] });
  b.t(run, idle, { triggers: ['halt'] });
  return b.model;
}

/** Deep history over a submachine state resumes the submachine. */
function host(): FsmModel {
  const b = new ModelBuilder('Host');
  const c = b.state('C', 'r_root', {}, 1);
  const p = b.state('P', 'C_r0', { submachine: 'Sub.fsm#sm' });
  const out = b.state('Out');
  const h = b.vertex('deepHistory', 'C_r0');
  b.init(c);
  b.init(p, 'C_r0');
  b.t(c, out, { triggers: ['leave'] });
  b.t(out, h, { triggers: ['back'] });
  b.t(out, c, { triggers: ['restart'] });
  return b.model;
}

/** Terminate in one region: the other region's transition for the same event doesn't run. */
function orthoTerm(): FsmModel {
  const b = new ModelBuilder('OrthoTerm');
  const p = b.state('P', 'r_root', {}, 2);
  const a = b.state('A', 'P_r0');
  const bb = b.state('B', 'P_r1', { exit: 'exitB()' });
  const b2 = b.state('B2', 'P_r1');
  const t = b.vertex('terminate', 'P_r0');
  b.init(p);
  b.init(a, 'P_r0');
  b.init(bb, 'P_r1');
  b.t(a, t, { triggers: ['kill'] });
  b.t(bb, b2, { triggers: ['kill'], effect: 'tooLate()' });
  return b.model;
}

/** The machine's own entry point leading into a nested state, and exit point. */
function entryMachine(): FsmModel {
  const b = new ModelBuilder('EntryMachine');
  const a = b.state('A');
  const c = b.state('C', 'r_root', { entry: 'enterC()' }, 1);
  const c0 = b.state('C0', 'C_r0');
  const c1 = b.state('C1', 'C_r0', { entry: 'enterC1()', exit: 'exitC1()' });
  const ep = b.vertex('entryPoint', 'r_root', { name: 'inside' });
  const xp = b.vertex('exitPoint', 'r_root', { name: 'away' });
  b.init(a);
  b.init(c0, 'C_r0');
  b.t(ep, c1, { effect: 'viaInside()' });
  b.t(c1, xp, { triggers: ['quit'], effect: 'bye()' });
  return b.model;
}

const cases: Record<string, Case> = {
  examples: { machines: { 'MediaPlayer.fsm': example('MediaPlayer.fsm'), 'Order.fsm': example('Order.fsm'), 'Payment.fsm': example('Payment.fsm') } },
  features: {
    machines: Object.fromEntries(
      [forks(), priority(), defer(), deferCompletion(), junctions(), local(), history('shallowHistory'), history('deepHistory'), points(), nested(), self(), term(), choice(), work(), door(), keywords(), hops(), composite(), sub(), host(), orthoTerm(), entryMachine(), clocked(), clockHost()].map((m) => [`${m.name}.fsm`, m]),
    ),
  },
};

// ------------------------------------------------------------------ tests

let exe = '';
let skip = '';

before(async () => {
  const tools = await toolchain();
  if (typeof tools === 'string') {
    // Skipped on a machine without the toolchain, but a CI build must test the C++.
    if (process.env.CI) throw new Error(`The Boost.SML tests cannot run in CI: ${tools}`);
    skip = tools;
  }
  else exe = await build(Object.values(cases), tools);
}, { timeout: 600_000 });

after(() => {
  if (exe) rmSync(dirname(exe), { recursive: true, force: true });
});

function check(name: string, script: string[]) {
  return (t: { skip(message: string): void }) => {
    if (skip) return t.skip(skip);
    const { actual, expected } = play(exe, name, script);
    assert.deepEqual(actual, expected);
  };
}

describe('Boost.SML: examples', () => {
  it(
    'MediaPlayer: hierarchy, orthogonal regions, choice, exit point, deep history, timer, do activity',
    check('MediaPlayer', [
      'start',
      'take => powerDown',
      'active => Off',
      'e powerOn',
      'take => ampOn,rewind',
      'e play',
      'active => On,Playing,Stereo,HD',
      'e toggleAudio',
      'e lowBandwidth',
      'active => On,Playing,Mono,SD',
      'e pause',
      'take => startBlinkLed',
      'pending => 300000',
      'e volumeChanged',
      'take => updateVolume',
      'fire',
      'take => stopBlinkLed,saveBookmark,rewind',
      'active => On,Stopped',
      'e eject',
      'take => isTrayJammed,openTray,rewind',
      'set isTrayJammed 1',
      'e eject',
      'take => isTrayJammed,ampOff,showError',
      'active => Fault',
      'e reset',
      'take => ampOn,rewind',
      'active => On,Stopped',
      'e powerOff',
      'take => ampOff,powerDown',
      'e unplug',
      'finished => 1',
    ]),
  );

  it(
    'Order and Payment: submachine with entry and exit point references',
    check('Order', [
      'start',
      'e checkout',
      'take => Payment.requestAuthorization',
      'active => Payment',
      'e declined',
      'take => notifyCustomer',
      'active => PaymentFailed',
      'e retryPayment',
      'take => Payment.resetAttempt,Payment.requestAuthorization',
      'e approved',
      'take => Payment.capture,ship',
      'finished => 1',
      'start',
      'e checkout',
      'e cancel',
      'active => Cart',
    ]),
  );

  it(
    'Payment on its own: entry points, exit points and the listener',
    check('Payment', ['listen', 'startAt retry', 'take => resetAttempt,requestAuthorization', 'e declined', 'take => @exit failed', 'active => ']),
  );
});

describe('Boost.SML: semantics', () => {
  it('fork, orthogonal regions and join', check('Forks', ['start', 'e go', 'take => toA,toB,enterP', 'active => P,A1,B1', 'e a', 'active => P,A2,B1', 'e b', 'take => a2,b2,exitP,done', 'active => Done']));

  it('inner transitions take priority, and orthogonal regions both react', check('Priority', ['start', 'e e', 'take => fx,fy', 'active => P,X2,Y2', 'e e', 'active => Out']));

  it('deferred events are replayed after a state change', check('Defer', ['start', 'e req', 'active => Busy', 'e done', 'take => handle', 'active => Handling']));

  it('completion events go before deferred events', check('DeferCompletion', ['start', 'e e', 'e f', 'take => handled', 'active => V']));

  it('junctions are static: the transition only fires when a whole path is enabled', check('Junctions', ['start', 'e e', 'take => g,g', 'active => S', 'set g 1', 'e e', 'take => g,c,g,c,leaveS,toY', 'active => Y']));

  it(
    'local transitions do not leave their composite state; external ones do',
    check('Local', ['start', 'clear', 'e local', 'take => exitC1,enterC2', 'e external', 'take => exitC,enterC', 'active => C,C1', 'e reset', 'take => exitC1,resetC', 'active => C,C1']),
  );

  it('shallow history restores one level', check('ShallowHistory', ['start', 'e next', 'e leave', 'e back', 'active => C,D,D1']));

  it('deep history restores every level', check('DeepHistory', ['start', 'e next', 'e leave', 'e back', 'active => C,D,D2']));

  it('entry and exit points of a composite state', check('Points', ['start', 'e go', 'take => enterC,viaIn,inner', 'active => C,Inner', 'e quit', 'take => exitC,viaOut', 'active => After']));

  it(
    'transitions into and out of nested states',
    check('Nested', [
      'start',
      'e dive',
      'take => exitA,diving,enterC,enterD,enterDeep',
      'active => C,D,Deep',
      'e surface',
      'take => exitDeep,exitD,exitC,surfacing',
      'active => A',
      'e dive',
      'clear',
      'e up',
      'take => exitDeep,exitD,up',
      'active => C,C0',
    ]),
  );

  it('self transitions leave and re-enter; internal transitions do not', check('Self', ['start', 'clear', 'e self', 'take => out,fx,in', 'e internal', 'take => fx']));

  it('terminate stops the machine at once, without exit behaviors', check('Term', ['start', 'e kill', 'e ping', 'take => onTerminate', 'terminated => 1']));

  it('a choice without an enabled branch throws', check('Choice', ['start', 'e e => throw: Choice: no branch of the choice in Root can be taken.']));

  it('do activities: the state completes when they end', check('Work', ['start', 'active => Working', 'done crunch', 'take => startCrunch,stopCrunch', 'active => Done']));

  it(
    'protocol machines check preconditions, postconditions and invariants',
    check('Door', [
      'set isClosed 1',
      'start',
      'clear',
      'e open',
      'take => isUnlocked,!precondition: Closed -> Open (open),isClosed',
      'set isUnlocked 1',
      'e open',
      'take => isUnlocked,isOpen,!postcondition: Closed -> Open (open)',
      'set isClosed 0',
      'e close',
      'take => isClosed,!invariant: Closed',
    ]),
  );

  it(
    'C++ keywords as names, lost completion events, timers and final states',
    check('Keywords', ['start', 'take => delete_,ready', 'active => default_', 'e union_', 'take => new_', 'pending => 1500', 'fire', 'take => class_', 'finished => 1']),
  );

  it('effects between the exits of several levels', check('Hops', ['start', 'take => enterC1,enterC2', 'e go', 'take => exitS,exitC2,e1,exitC1,e2,e3,enterT', 'active => T']));

  it(
    'completion of a composite state, initial effects, several triggers, invariant',
    check('Composite', [
      'set okP 1',
      'start',
      'take => boot',
      'e start',
      'take => enterP,initA,enterQ,okP',
      'active => P,A,Q,Q1',
      'e next',
      'e finishQ',
      'e finishA',
      'take => enterQ2,okP,okP,okP,canLeave',
      'active => P,P_Final,P_Final_2',
      'set canLeave 1',
      'e abort',
      'take => exitP',
      'e go',
      'e finishA',
      'e next',
      'e finishQ',
      'take => enterP,initA,enterQ,okP,okP,enterQ2,okP,okP,canLeave,exitP,done',
      'active => Done',
    ]),
  );

  it('an entry point leading two levels down', check('Composite', ['set okP 1', 'start', 'clear', 'e jump', 'take => enterP,viaDeep,initA,enterQ,enterQ2,okP', 'active => P,A,Q,Q2']));

  it(
    'deep history resumes a submachine',
    check('Host', ['start', 'take => P.enterS1', 'e step', 'take => P.enterS2', 'e leave', 'e back', 'take => P.enterS2', 'active => C,P', 'e leave', 'e restart', 'take => P.enterS1']),
  );

  it('terminate in a region: the other regions do not fire', check('OrthoTerm', ['start', 'e kill', 'take => onTerminate', 'terminated => 1']));

  it(
    "the machine's own entry and exit points",
    check('EntryMachine', ['listen', 'startAt inside', 'take => viaInside,enterC,enterC1', 'active => C,C1', 'e quit', 'take => exitC1,bye,@exit away', 'active => ']),
  );

  it(
    'stop leaves every state; resume re-enters them',
    check('Nested', ['start', 'e dive', 'clear', 'stop', 'take => exitDeep,exitD,exitC', 'active => ', 'resume', 'take => enterC,enterD,enterDeep', 'active => C,D,Deep']),
  );
});

describe('Boost.SML: timers', () => {
  it(
    'a submachine runs its timers through the FsmTimers of its parent, and cancels them when left',
    check('ClockHost', ['start', 'e go', 'take => Run.waiting', 'pending => 250', 'fire', 'take => Run.rung', 'e halt', 'e go', 'clear', 'e halt', 'pending => ']),
  );

  it('FsmTimers.h is shared by the machines, and passed on to submachines with time events', async () => {
    const { files } = await generateSml({ 'Keywords.fsm': keywords(), 'Composite.fsm': composite(), 'Sub.fsm': timedSub(), 'Host.fsm': host() });
    assert.deepEqual([...files.keys()].filter((f) => f === 'FsmTimers.h'), ['FsmTimers.h']);
    assert.match(files.get('Keywords.h')!, /Keywords\(KeywordsActions& actions, FsmTimers& timers\);/);
    assert.match(files.get('Composite.h')!, /explicit Composite\(CompositeActions& actions\);/);
    assert.match(files.get('Host.h')!, /Host\(HostActions& actions, FsmTimers& timers\);/);
    assert.doesNotMatch(files.get('KeywordsActions.h')!, /Timer/);
  });
});

describe('Boost.SML: warnings and errors', () => {
  it('warns where the generated code works around Boost.SML', async () => {
    const { warnings } = await generateSml({ 'Points.fsm': points(), 'Forks.fsm': forks(), 'Local.fsm': local(), 'Nested.fsm': nested() });
    assert.deepEqual(warnings, [
      "Entry point 'C.in': Boost.SML has no entry points; transitions to it enter the state, whose initial pseudostates follow the entry point",
      "Exit point 'C.out': Boost.SML has no exit points; the state taking the event leaves the composite state through an internal event",
      "Fork 'fork': Boost.SML has no forks; transitions to it enter the composite state, whose initial pseudostates lead to the fork's targets",
      "Join 'join': Boost.SML has no joins; the completion of each source checks that the others have completed, then the composite state is left through an internal event",
      "Transition 'C -> C2 (local)': Boost.SML has no local transitions; it is written as a transition of each state of C's region, which leaves the active substate but not C",
      "Transition 'C -> C (reset)': Boost.SML has no local transitions; it is written as a transition of each state of C's region, which leaves the active substate but not C",
      "Transition 'A -> Deep (dive)': Boost.SML has no transitions into a composite state's inside; it enters C, whose initial pseudostate leads on to D",
      "Transition 'Deep -> C0 (up)': Boost.SML has no transitions out of a composite state's inside; Deep takes the event and D is left through an internal event",
      "Transition 'Deep -> A (surface)': Boost.SML has no transitions out of a composite state's inside; Deep takes the event and C is left through an internal event",
    ]);
  });

  it('warns when orthogonal regions react to the same event with guards', async () => {
    const b = new ModelBuilder('Ortho');
    const p = b.state('P', 'r_root', {}, 2);
    b.init(p);
    b.init(b.state('X', 'P_r0'), 'P_r0');
    b.init(b.state('Y', 'P_r1'), 'P_r1');
    b.t('X', 'X', { triggers: ['e'], kind: 'internal', effect: 'fx()' });
    b.t('Y', 'Y', { triggers: ['e'], kind: 'internal', guard: 'g()' });
    const { warnings } = await generateSml({ 'Ortho.fsm': b.model });
    assert.deepEqual(warnings, [
      "In P, several regions react to 'e': Boost.SML fires their transitions one region after the other, so the guards of a later region are evaluated after the transitions of the earlier ones fired",
    ]);
  });

  it('refuses what Boost.SML cannot run, and names that would not compile', async () => {
    const b = new ModelBuilder('Bad');
    const p = b.state('P', 'r_root', {}, 2);
    const x = b.state('X', 'P_r0');
    b.state('Y', 'P_r1');
    b.init(p);
    b.init(x, 'P_r0');
    b.init('Y', 'P_r1');
    b.t(p, p, { triggers: ['offer'], kind: 'local', effect: 'go()' });
    b.t(x, x, { triggers: ['e'], guard: 'go()' });
    await assert.rejects(generateSml({ 'Bad.fsm': b.model }), (e: Error & { issues?: { message: string }[] }) => {
      assert.deepEqual(
        e.issues?.filter((i) => (i as { severity?: string }).severity === "error").map((i) => i.message),
        [
          "Event 'offer': its method offer() clashes with a method of the generated class Bad; rename the event",
          "'go' is called both as a behavior and as a condition: in C++ it would be two methods go() returning void and bool; rename one of them",
          "Transition 'P -> P (offer)': Boost.SML has no local transitions, and P has several regions, which a transition of one region cannot leave together",
        ],
      );
      return true;
    });
  });
});
