import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { generatorTemplates, locateGenerator, runGenerator } from '../../src/fsmGenerator';

// fsm-generator bundled in generator/<platform> (fetched by the release workflow), or FSM_GENERATOR.
const root = resolve(__dirname, '../../..');
const generator = locateGenerator(root, process.env.FSM_GENERATOR ?? '');
const examples = join(root, 'examples');

describe('fsm-generator (Jinja templates)', { skip: generator ? false : 'no fsm-generator in generator/<platform> or FSM_GENERATOR' }, () => {
  it('finds its bundled templates', () => {
    const names = generatorTemplates(generator!).map((f) => f.slice(f.lastIndexOf('/') + 1).replace(/^.*\\/, ''));
    assert.deepEqual(names, ['sml.jinja', 'ts.jinja']);
  });

  it('generates a machine and prints the files written', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fsm-generator-'));
    try {
      const ts = generatorTemplates(generator!).find((f) => f.endsWith('ts.jinja'))!;
      const r = await runGenerator(generator!, [join(examples, 'Order.fsm'), '--template', ts, '--out', out], examples);
      assert.equal(r.exitCode, 0, r.stderr);
      const written = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('wrote '));
      assert.ok(written.some((l) => l.endsWith('Order.ts')), r.stdout);
      assert.match(readFileSync(join(out, 'Order.ts'), 'utf8'), /export class Order/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('reports problems as file:line: severity: message, with exit code 1', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fsm-generator-'));
    try {
      const broken = join(out, 'Broken.fsm');
      writeFileSync(broken, readFileSync(join(examples, 'Order.fsm'), 'utf8').replace(/Payment\.fsm#/g, 'Missing.fsm#'));
      const ts = generatorTemplates(generator!).find((f) => f.endsWith('ts.jinja'))!;
      const r = await runGenerator(generator!, [broken, '--template', ts, '--out', out], out);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Broken\.fsm:\d+: error: /);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
