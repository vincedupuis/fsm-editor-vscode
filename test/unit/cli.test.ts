import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import { modelHash } from '../../src/xmi';
import { root } from './harness';

describe('fsm --check', () => {
  let dir = '';
  let cli = '';
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fsm-check-'));
    cli = join(dir, 'cli.js');
    await esbuild.build({ entryPoints: [join(root, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node18', format: 'cjs', outfile: cli, logLevel: 'warning' });
    for (const f of ['Order.fsm', 'Payment.fsm']) copyFileSync(join(root, 'examples', f), join(dir, f));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const fsm = (...args: string[]) => spawnSync(process.execPath, [cli, '*.fsm', '-t', join(root, 'templates/ts.hbs'), '-o', 'gen', ...args], { cwd: dir, encoding: 'utf8' });
  const generated = () => Object.fromEntries(readdirSync(join(dir, 'gen')).map((f) => [f, readFileSync(join(dir, 'gen', f), 'utf8')]));
  const edit = (file: string, change: (text: string) => string) => {
    const text = change(readFileSync(join(dir, file), 'utf8'));
    writeFileSync(join(dir, file), text);
    return text;
  };

  it('reports the files missing or out of date, and writes nothing', () => {
    assert.equal(fsm().status, 0);
    const ok = fsm('--check');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stderr, '');
    assert.deepEqual(ok.stdout.trim().split('\n'), ['up to date gen/OrderActions.ts', 'up to date gen/Order.ts', 'up to date gen/PaymentActions.ts', 'up to date gen/Payment.ts']);

    // A layout change keeps the files up to date.
    edit('Order.fsm', (t) => t.replace(/(<bounds [^>]*\bx=")([\d.]+)/, (_, a: string, x: string) => `${a}${Number(x) + 10}`));
    assert.equal(fsm('--check').status, 0);

    // A model change doesn't, and neither does a missing file.
    const payment = edit('Payment.fsm', (t) => t.replace(/(xmi:type="uml:State" xmi:id="[^"]+" name=")([^"]+)/, '$1$2Again'));
    unlinkSync(join(dir, 'gen', 'Order.ts'));
    const before = generated();
    const stale = fsm('--check');
    assert.equal(stale.status, 1);
    const hash = modelHash(payment);
    assert.deepEqual(stale.stderr.trim().split('\n'), [
      'gen/Order.ts:1: error: Missing: not generated from Order.fsm yet.',
      `gen/PaymentActions.ts:1: error: Out of date: Payment.fsm has changed since it was generated (its model hash is now ${hash}).`,
      `gen/Payment.ts:1: error: Out of date: Payment.fsm has changed since it was generated (its model hash is now ${hash}).`,
      'fsm: 3 generated files are missing or out of date.',
    ]);
    assert.deepEqual(stale.stdout.trim().split('\n'), ['up to date gen/OrderActions.ts']);
    assert.deepEqual(generated(), before, 'nothing written');

    assert.equal(fsm().status, 0);
    assert.equal(fsm('--check').status, 0);
  });
});
