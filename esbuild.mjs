// Bundles the extension twice from the same sources, plus the command-line tool:
//   out/extension.js      desktop VS Code (Node.js extension host)   → package.json "main"
//   out/web/extension.js  vscode.dev / github.dev (web worker)      → package.json "browser"
//   out/cli.js            `fsm` command (Node.js or Bun)            → package.json "bin"
// Usage: node esbuild.mjs [--watch] [--test]
//   --test also bundles the browser smoke test (test/web/index.ts → out/test/web/index.js).
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const common = {
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', platform: 'node', target: 'node18' },
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/web/extension.js', platform: 'browser', target: 'es2022' },
  {
    ...common,
    entryPoints: ['src/cli.ts'],
    outfile: 'out/cli.js',
    platform: 'node',
    target: 'node18',
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    define: { FSM_VERSION: JSON.stringify(version) },
  },
];
if (test) {
  builds.push({ ...common, entryPoints: ['test/web/index.ts'], outfile: 'out/test/web/index.js', platform: 'browser', target: 'es2022' });
}

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
