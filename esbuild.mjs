// Bundles the extension twice from the same sources:
//   out/extension.js      desktop VS Code (Node.js extension host)   → package.json "main"
//   out/web/extension.js  vscode.dev / github.dev (web worker)      → package.json "browser"
// Usage: node esbuild.mjs [--watch] [--test]
//   --test also bundles the browser smoke test (test/web/index.ts → out/test/web/index.js).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

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
];
if (test) {
  builds.push({ ...common, entryPoints: ['test/web/index.ts'], outfile: 'out/test/web/index.js', platform: 'browser', target: 'es2022' });
}

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
