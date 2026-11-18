/**
 * fsm-editor-common through this extension's client (src/common.ts): its interface's cases (common/api-cases, the
 * requests and the answers its own tests check) give the same answers here, and the examples are written back as
 * they are. The format, validation, the grammar, comparing and merging are tested in fsm-editor-common itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { call, compareModels, keysOf, readMachine, writeMachine } from '../../src/common';
import { root } from './harness';

/** Numbers as written by either side (2000 and 2000.0 alike), objects without order. */
const norm = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)])) : v;

describe('fsm-editor-common', () => {
  it('answers its interface cases as its own tests do', () => {
    const lines = readFileSync(join(root, 'common/api-cases/cases.jsonl'), 'utf8').trim().split('\n');
    assert.ok(lines.length > 30);
    for (const line of lines) {
      const { request, answer } = JSON.parse(line);
      let got: { result?: unknown; error?: string };
      try {
        got = { result: call(request.fn, request.args ?? {}) };
      } catch (e) {
        got = { error: (e as Error).message };
      }
      if ('error' in answer) assert.equal(got.error, answer.error, request.fn);
      else assert.deepEqual(norm(got.result), norm(answer.result), request.fn);
    }
  });

  it('writes the examples back as they are', () => {
    for (const name of ['MediaPlayer', 'Order', 'Payment']) {
      const text = readFileSync(join(root, 'examples', `${name}.fsm`), 'utf8');
      const layout = readFileSync(join(root, 'examples', `${name}.fsm.layout`), 'utf8');
      const read = readMachine(text, layout);
      if ('problems' in read) throw new Error(JSON.stringify(read.problems));
      const w = writeMachine(read.model);
      assert.equal(w.modelText, text, name);
      assert.equal(w.layoutText, layout, name);
      assert.equal(w.model, read.model, `${name}: unchanged, not sent back`);
      assert.ok(read.lines.size > 0, name);
    }
  });

  it('compares through keys that the merge finds again', () => {
    const read = readMachine(readFileSync(join(root, 'examples/MediaPlayer.fsm'), 'utf8'), undefined);
    if ('problems' in read) throw new Error('unreadable');
    const b = structuredClone(read.model);
    b.vertices.find((v) => v.name === 'Off')!.entry = 'sleep()';
    const [c] = compareModels(read.model, b);
    assert.equal(c.label, "state 'Off'");
    assert.deepEqual(c.described, ['entry: powerDown() → sleep()']);
    assert.equal(keysOf(b).get(c.key), c.newId);
  });
});
