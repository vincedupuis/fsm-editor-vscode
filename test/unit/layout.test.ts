/**
 * The layout file's JSON Schema (schemas/fsm-layout.schema.json) and the editor's layout reader agree: both take the
 * files of fixtures/layout/valid and the examples' layout files, and both refuse those of fixtures/layout/invalid.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Ajv from 'ajv';
import { layoutShapeProblem } from '../../src/format';
import { JsonSyntaxError, parseJson } from '../../src/json';
import { root } from './harness';

const SETS = [
  ['test/unit/fixtures/layout/valid', true],
  ['test/unit/fixtures/layout/invalid', false],
  ['examples', true],
] as const;

function* layoutFiles(): Generator<[string, string, boolean]> {
  for (const [dir, valid] of SETS) {
    const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.fsm.layout'));
    assert.ok(files.length > 0, dir);
    for (const f of files) yield [`${dir}/${f}`, readFileSync(join(root, dir, f), 'utf8'), valid];
  }
}

describe('layout files', () => {
  it('the schema accepts the valid ones and refuses the others', () => {
    const schema = JSON.parse(readFileSync(join(root, 'schemas/fsm-layout.schema.json'), 'utf8'));
    const check = new Ajv({ allErrors: true }).compile(schema);
    for (const [name, text, valid] of layoutFiles()) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        assert.equal(valid, false, `${name}: not JSON`);
        continue;
      }
      assert.equal(check(value), valid, `${name}: ${JSON.stringify(check.errors)}`);
    }
  });

  it('the editor takes those the schema accepts, and refuses the others', () => {
    for (const [name, text, valid] of layoutFiles()) {
      let problem: string | undefined;
      try {
        problem = layoutShapeProblem(parseJson(text));
      } catch (e) {
        if (!(e instanceof JsonSyntaxError)) throw e;
        problem = e.message;
      }
      assert.equal(problem === undefined, valid, `${name}: ${problem}`);
    }
  });
});
