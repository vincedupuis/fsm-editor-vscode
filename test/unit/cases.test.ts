/**
 * The editor's reader and validator against fsm-cli's test cases (fsm/cases, copied by `npm run build:fsm` from
 * ../fsm-cli/tests/cases): the same problems, at the same lines, with the same ids. fsm-cli's own messages about
 * files it can't read (a missing submachine file, one that isn't valid) are its loader's, which the editor doesn't
 * have: it reports such a submachine as not found, as fsm-cli does too.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { layoutShapeProblem, readModel } from '../../src/format';
import { JsonSyntaxError, parseJson } from '../../src/json';
import { SubmachineInfo, machineConnectionPoints } from '../../src/model';
import { validate } from '../../src/validation';
import { root } from './harness';

const cases = join(root, 'fsm/cases');
const LOADER = [/ does not exist or cannot be read\.$/, / is not a valid state machine file\.$/];

describe('fsm-cli test cases', () => {
  if (!existsSync(cases)) {
    it('need fsm/cases: npm run build:fsm', () => assert.fail('fsm/cases is missing: run npm run build:fsm'));
    return;
  }
  const folders = readdirSync(cases).filter((d) => d !== 'layout' && statSync(join(cases, d)).isDirectory());
  for (const folder of folders) {
    it(`${folder}: the same problems as fsm`, () => {
      const dir = join(cases, folder);
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Record<string, { line: number; id: string; severity: string; message: string }[]>;
      const texts = Object.fromEntries(Object.keys(expected).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
      const read = Object.fromEntries(Object.entries(texts).map(([f, t]) => [f, readModel(t)]));
      let compared = 0;
      for (const [f, list] of Object.entries(expected)) {
        const r = read[f];
        let found: { line: number; id: string; severity: string; message: string }[];
        if ('problems' in r) {
          found = r.problems.map((p) => ({ line: p.line, id: '', severity: 'error', message: p.message }));
        } else {
          // Submachines as the editor resolves them: the machine of a readable file in the folder, else not found.
          const info: SubmachineInfo = {};
          for (const v of r.model.vertices) {
            if (v.type !== 'state' || !v.submachine) continue;
            const sub = read[v.submachine];
            info[v.submachine] = sub && !('problems' in sub) ? { found: true, name: sub.model.name, points: machineConnectionPoints(sub.model) } : { found: false, points: [] };
          }
          found = validate(r.model, info).map((i) => ({ line: r.lines.get(i.id) ?? 1, id: i.id, severity: i.severity, message: i.message }));
        }
        const wanted = list.filter((i) => !LOADER.some((re) => re.test(i.message)));
        assert.deepEqual(found, wanted, `${folder}/${f}`);
        compared += wanted.length;
      }
      assert.ok(compared > 0 || folder === 'examples');
    });
  }

  it('layout files: the editor takes those the layout schema accepts, and refuses the others', () => {
    for (const [sub, valid] of [['layout/valid', true], ['layout/invalid', false], ['examples', true]] as const) {
      for (const f of readdirSync(join(cases, sub)).filter((x) => x.endsWith('.fsm.layout'))) {
        let problem: string | undefined;
        try {
          problem = layoutShapeProblem(parseJson(readFileSync(join(cases, sub, f), 'utf8')));
        } catch (e) {
          if (!(e instanceof JsonSyntaxError)) throw e;
          problem = e.message;
        }
        assert.equal(problem === undefined, valid, `${sub}/${f}: ${problem}`);
      }
    }
  });
});
