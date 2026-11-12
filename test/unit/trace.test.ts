import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelIndex } from '../../src/model';
import { builtInFormat, compileFormat, detectFormat, parseTime, TraceFormat, TraceFormatError, traceFormats } from '../../src/trace/format';
import { findState, findTransitions, Instance, replay, TimelineEntry } from '../../src/trace/replay';
import { fromXmi } from '../../src/xmi';
import { ModelBuilder, load, recorder, root } from './harness';

const example = (name: string) => readFileSync(join(root, 'examples', name), 'utf8');

const instance = (key: string, model: Instance['model'], uri = `file:///${key}.fsm`): Instance => ({ key, uri, model, ix: new ModelIndex(model) });

/** The timeline of `lines` read with `format`, every record about the instance of its machine (or `fallback`). */
function timeline(lines: string[], format: TraceFormat, instances: Record<string, Instance>, fallback?: Instance): TimelineEntry[] {
  return lines
    .map((text, line) => format.parse(text, line))
    .filter((r) => r !== null)
    .map((record) => ({ record, trace: 0, instance: instances[record.machine] ?? fallback ?? null }));
}

function kindsOf(entries: TimelineEntry[]): Map<string, Set<string>> {
  const kinds = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!e.instance) continue;
    if (!kinds.has(e.instance.key)) kinds.set(e.instance.key, new Set());
    kinds.get(e.instance.key)!.add(e.record.kind);
  }
  return kinds;
}

/** The model of the tracing tests: S, a junction leading to a choice, X and Y. */
function traced() {
  const b = new ModelBuilder('Traced');
  const s = b.state('S');
  const x = b.state('X');
  const y = b.state('Y');
  const j = b.vertex('junction', 'r_root', { id: 'j', name: 'j' });
  const c = b.vertex('choice', 'r_root', { id: 'c', name: 'c' });
  b.t(b.vertex('initial', 'r_root', { id: 'i' }), s, { id: 'tInit' });
  b.t(s, j, { triggers: ['e'], id: 'tSJ' });
  b.t(j, c, { guard: 'g()', id: 'tJC' });
  b.t(j, y, { guard: 'else', id: 'tJY' });
  b.t(c, x, { guard: 'h()', id: 'tCX' });
  b.t(c, y, { guard: 'else', id: 'tCY' });
  b.t(x, s, { triggers: ['back'], id: 'tXS' });
  b.t(y, s, { triggers: ['back'], id: 'tYS' });
  return b.model;
}

describe('trace formats', () => {
  it('reads the built-in format after any prefix, with its time', () => {
    const r = builtInFormat.parse('2026-11-11T10:02:03.120Z INFO [main] fsm Order.Payment enter p_auth Authorizing', 4)!;
    assert.equal(r.kind, 'enter');
    assert.equal(r.machine, 'Order.Payment');
    assert.equal(r.id, 'p_auth');
    assert.equal(r.name, 'Authorizing');
    assert.equal(r.line, 4);
    assert.equal(r.time, Date.parse('2026-11-11T10:02:03.120Z'));
    assert.equal(builtInFormat.parse('fsm Order transition t1 Cart -> Payment (checkout)', 0)!.name, 'Cart -> Payment (checkout)');
    assert.equal(builtInFormat.parse('fsm Order enter', 0), null);
    assert.equal(builtInFormat.parse('the fsm Order is ready', 0), null);
  });

  it('parses times: date and time, time of day, Unix seconds and milliseconds', () => {
    assert.equal(parseTime('2026-11-11 10:02:03,5'), Date.parse('2026-11-11T10:02:03.5'));
    assert.equal(parseTime('10:02:03.250'), (10 * 3600 + 2 * 60 + 3) * 1000 + 250);
    assert.equal(parseTime('1762855323.5'), 1762855323500);
    assert.equal(parseTime('1762855323500'), 1762855323500);
    assert.equal(parseTime('soon'), undefined);
  });

  it('reads other logs with the rules of a format', () => {
    const f = compileFormat({
      name: 'App',
      time: '^\\[(?<time>[^\\]]+)\\]',
      rules: [
        { kind: 'event', match: 'got (?<name>\\w+)' },
        { match: '(?<kind>enter|exit)ing (?<machine>\\w+)/(?<name>\\w+)' },
        { kind: 'transition', match: '(?<source>\\w+) => (?<target>\\w+)' },
      ],
      machine: 'Door',
    });
    assert.deepEqual(
      ['[10:00:00.000] got open', '[10:00:00.001] entering Car/Opened', '[10:00:00.002] Closed => Opened', 'noise'].map((l, i) => {
        const r = f.parse(l, i);
        return r && [r.kind, r.machine, r.name, r.source ?? '', r.target ?? '', r.time];
      }),
      [
        ['event', 'Door', 'open', '', '', 36000000],
        ['enter', 'Car', 'Opened', '', '', 36000001],
        ['transition', 'Door', 'Closed -> Opened', 'Closed', 'Opened', 36000002],
        null,
      ],
    );
  });

  it('reports bad formats and picks the format recognizing the most lines', () => {
    assert.throws(() => compileFormat({ name: 'X', rules: [{ kind: 'jump', match: 'a' }] }), TraceFormatError);
    assert.throws(() => compileFormat({ name: 'X', rules: [{ match: 'a(' }] }), /not a valid regular expression/);
    assert.throws(() => compileFormat({ name: 'X', rules: [{ match: 'a' }] }), /needs a kind/);
    const errors: string[] = [];
    const formats = traceFormats([{ name: 'Bad', rules: [] }, { name: 'Mine', rules: [{ kind: 'enter', match: '-> (?<name>\\w+)' }] }], errors);
    assert.deepEqual(formats.map((f) => f.name), ['FSM Editor (built-in)', 'Mine']);
    assert.deepEqual(errors, ["Trace format 'Bad' has no rules."]);
    assert.equal(detectFormat(formats, ['-> A', '-> B', 'fsm M enter s1 A']).name, 'Mine');
    assert.equal(detectFormat(formats, ['nothing here']).name, 'FSM Editor (built-in)');
  });
});

describe('trace replay', () => {
  it('replays a log written by the onTrace hook of the generated code', async () => {
    const model = traced();
    const { Traced } = await load({ 'Traced.fsm': model });
    const lines: string[] = [];
    const rec = recorder();
    const m = new Traced(rec.actions, { onTrace: (machine: string, kind: string, id: string, name: string) => lines.push(`fsm ${machine} ${kind} ${id} ${name}`) });
    m.start();
    m.dispatch('e'); // g() false: the junction's else branch, to Y
    m.dispatch('back');
    rec.conditions.g = true;
    rec.conditions.h = true;
    m.dispatch('e'); // through the junction and the choice to X
    const inst = instance('Traced', model);
    const entries = timeline(lines, builtInFormat, { Traced: inst });
    const kinds = kindsOf(entries);
    const at = (i: number) => replay(entries, i, kinds).get('Traced')?.highlight;

    assert.deepEqual(at(-1), undefined);
    const started = at(1)!;
    assert.deepEqual(started.active, ['S']);
    assert.deepEqual(started.taken, ['tInit']);
    assert.deepEqual(started.current, ['S']);

    const firstE = entries.findIndex((e) => e.record.kind === 'event');
    const toY = at(firstE + 4)!; // event, exit S, tSJ, tJY, enter Y
    assert.deepEqual(toY.active, ['Y']);
    assert.deepEqual(toY.taken, ['tSJ', 'tJY']);
    assert.deepEqual(toY.via, ['j']);
    assert.equal(toY.event, 'e');

    const end = at(entries.length - 1)!;
    assert.deepEqual(end.active, ['X']);
    assert.deepEqual(end.taken, ['tSJ', 'tJC', 'tCX']);
    assert.deepEqual(end.via.sort(), ['c', 'j']);
    assert.deepEqual(end.current, ['X']);

    // Going back in time: the middle of the second step.
    const mid = at(entries.length - 3)!; // after tJC
    assert.deepEqual(mid.active, []);
    assert.deepEqual(mid.taken, ['tSJ', 'tJC']);
  });

  it('shows a submachine as an active state in its parent, and its states in its own instance', async () => {
    const order = fromXmi(example('Order.fsm'));
    const payment = fromXmi(example('Payment.fsm'));
    const { Order } = await load({ 'Order.fsm': example('Order.fsm'), 'Payment.fsm': example('Payment.fsm') });
    const lines: string[] = [];
    const o = new Order(recorder().actions, { onTrace: (machine: string, kind: string, id: string, name: string) => lines.push(`fsm ${machine} ${kind} ${id} ${name}`) });
    o.start();
    o.dispatch('checkout');
    const instances = { Order: instance('Order', order), 'Order.Payment': instance('Order.Payment', payment, 'file:///Payment.fsm') };
    const entries = timeline(lines, builtInFormat, instances);
    const out = replay(entries, entries.length - 1, kindsOf(entries));
    assert.deepEqual(out.get('Order')!.highlight.active, ['o_pay']);
    assert.deepEqual(out.get('Order.Payment')!.highlight.active, ['p_auth']);
    assert.equal(out.get('Order.Payment')!.inst.uri, 'file:///Payment.fsm');
    // Order's event is the submachine's step too.
    assert.equal(out.get('Order.Payment')!.highlight.event, 'checkout');
    assert.deepEqual(out.get('Order.Payment')!.highlight.taken, ['pt1']);
  });

  it('finds states and transitions by name, and follows transitions when the log has no entries', () => {
    const model = traced();
    const ix = new ModelIndex(model);
    assert.equal(findState(ix, 'S')?.id, 'S');
    assert.equal(findState(ix, 'nope'), undefined);
    assert.deepEqual(findTransitions(ix, { id: '', name: 'S -> X (e)' }).map((t) => t.id), ['tSJ', 'tJC', 'tCX']);
    assert.deepEqual(findTransitions(ix, { id: '', name: '', source: 'S', target: 'Y' }).map((t) => t.id), ['tSJ', 'tJY']);

    const f = compileFormat({ name: 'Moves', rules: [{ kind: 'transition', match: '(?<source>\\w+) -> (?<target>\\w+)' }] });
    const inst = instance('Traced', model);
    const entries = timeline(['S -> X', 'X -> S', 'S -> Y'], f, {}, inst);
    const kinds = kindsOf(entries);
    const h = replay(entries, 2, kinds).get('Traced')!.highlight;
    assert.deepEqual(h.active, ['Y']);
    assert.deepEqual(h.taken, ['tSJ', 'tJY']);
    assert.deepEqual(replay(entries, 0, kinds).get('Traced')!.highlight.active, ['X']);
  });

  it('enters the enclosing states, and leaves what else was active in the region', () => {
    const b = new ModelBuilder('Nest');
    b.state('A');
    b.state('C', 'r_root', {}, 2);
    b.state('C1', 'C_r0');
    b.state('C2', 'C_r0');
    b.state('D1', 'C_r1');
    const inst = instance('Nest', b.model);
    const entries = timeline(['fsm Nest enter A', 'fsm Nest enter C1', 'fsm Nest enter D1', 'fsm Nest enter C2', 'fsm Nest exit C', 'fsm Nest enter C::C1'], builtInFormat, { Nest: inst });
    const kinds = kindsOf(entries);
    const active = (i: number) => replay(entries, i, kinds).get('Nest')!.highlight.active.sort();
    assert.deepEqual(active(1), ['C', 'C1']);
    assert.deepEqual(active(3), ['C', 'C2', 'D1']);
    assert.deepEqual(active(4), []);
    assert.deepEqual(active(5), ['C', 'C1']);
  });
});
