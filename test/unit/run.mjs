// Runs the unit tests (test/unit/*.test.ts) with node:test after bundling them
// with esbuild. Usage: npm run test:unit
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'test/unit');
const outdir = join(root, 'out/test/unit');
const tests = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));

await esbuild.build({
  entryPoints: tests.map((f) => join(dir, f)),
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external: ['esbuild'],
  logLevel: 'warning',
});

const files = tests.map((f) => join(outdir, f.replace(/\.ts$/, '.js')));
const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', ...files], { stdio: 'inherit', cwd: root });
process.exitCode = result.status ?? 1;
